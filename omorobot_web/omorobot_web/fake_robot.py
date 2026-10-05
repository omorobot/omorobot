import math
import os

import numpy as np
import rclpy
import yaml
from ament_index_python.packages import get_package_share_directory
from geometry_msgs.msg import TransformStamped, Twist
from nav_msgs.msg import Odometry
from PIL import Image
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, qos_profile_sensor_data
from rclpy.time import Time
from sensor_msgs.msg import JointState, LaserScan
from tf2_ros import TransformBroadcaster, TransformException

from .ros_bridge import rotation_matrix
from .tf_reader import TfReader


class FakeRobot(Node):
    """Robot and lidar simulated in a map image, to try the web ui without hardware."""

    def __init__(self):
        super().__init__('fake_robot')
        self.declare_parameter('world', '')
        self.declare_parameter('start_x', -2.0)
        self.declare_parameter('start_y', -0.5)
        self.declare_parameter('start_yaw', 0.0)
        self.declare_parameter('wheel.separation', 0.18)
        self.declare_parameter('wheel.radius', 0.034)
        self.declare_parameter('motor.max_lin_vel', 0.3)
        self.declare_parameter('motor.max_ang_vel', 0.5)
        self.declare_parameter('robot_radius', 0.12)
        self.declare_parameter('scan.range_max', 12.0)
        self.declare_parameter('scan.range_min', 0.03)
        self.declare_parameter('scan.angle_max', 165.0)
        self.declare_parameter('scan.samples', 440)
        self.declare_parameter('scan.noise', 0.005)
        self.declare_parameter('cmd_vel_timeout', 1.0)

        self.wheel_separation = self.get_parameter('wheel.separation').value
        self.wheel_radius = self.get_parameter('wheel.radius').value
        self.max_lin_vel = self.get_parameter('motor.max_lin_vel').value
        self.max_ang_vel = self.get_parameter('motor.max_ang_vel').value
        self.robot_radius = self.get_parameter('robot_radius').value
        self.range_max = self.get_parameter('scan.range_max').value
        self.range_min = self.get_parameter('scan.range_min').value
        self.angle_max = math.radians(self.get_parameter('scan.angle_max').value)
        self.samples = self.get_parameter('scan.samples').value
        self.noise = self.get_parameter('scan.noise').value
        self.cmd_vel_timeout = self.get_parameter('cmd_vel_timeout').value

        self.load_world(self.get_parameter('world').value)
        # pose in the world and pose by odometry (starts at zero like the real robot)
        self.world_x = self.get_parameter('start_x').value
        self.world_y = self.get_parameter('start_y').value
        self.world_yaw = self.get_parameter('start_yaw').value
        self.x, self.y, self.theta = 0.0, 0.0, 0.0
        self.lin_vel, self.ang_vel = 0.0, 0.0
        self.cmd_lin, self.cmd_ang = 0.0, 0.0
        self.cmd_time = self.get_clock().now()
        self.time_pre = self.get_clock().now()
        self.wheel_lh_pos, self.wheel_rh_pos = 0.0, 0.0
        self.scan_mount = None

        qos_profile = QoSProfile(depth=5)
        qos_profile.reliability = ReliabilityPolicy.BEST_EFFORT
        self.sub_cmd_vel = self.create_subscription(Twist, 'cmd_vel', self.cmd_vel_callback, 10)
        self.pub_joint_state = self.create_publisher(JointState, 'joint_states', qos_profile)
        self.pub_odom = self.create_publisher(Odometry, 'odom', 10)
        self.pub_scan = self.create_publisher(LaserScan, 'scan', qos_profile_sensor_data)
        self.tf_bc = TransformBroadcaster(self)
        self.tf_buffer = TfReader(self, dynamic=False).buffer                                               # lidar mount from tf_static
        self.timer_20ms = self.create_timer(0.02, self.update_robot)
        self.timer_100ms = self.create_timer(0.1, self.update_scan)

    def print(self, str_info):
        self.get_logger().info(str_info)

    def load_world(self, world_yaml):
        if not world_yaml:
            world_yaml = os.path.join(get_package_share_directory('omorobot_navigation2'), 'map', 'turtlebot3_world.yaml')
        with open(world_yaml, 'r') as f:
            info = yaml.safe_load(f)
        image_path = os.path.join(os.path.dirname(world_yaml), info['image'])
        with Image.open(image_path) as image:
            gray = np.array(image.convert('L'), dtype=np.uint8)
        self.occupied = np.flipud(gray < 100)                                                               # row 0 = bottom
        self.resolution = float(info['resolution'])
        self.origin_x, self.origin_y = float(info['origin'][0]), float(info['origin'][1])
        self.print(f'world: {world_yaml} ({self.occupied.shape[1]}x{self.occupied.shape[0]}, {self.resolution}m)')

    def is_occupied(self, xs, ys):
        cols = np.floor((xs - self.origin_x) / self.resolution).astype(np.int32)
        rows = np.floor((ys - self.origin_y) / self.resolution).astype(np.int32)
        height, width = self.occupied.shape
        inside = (cols >= 0) & (cols < width) & (rows >= 0) & (rows < height)
        hit = np.zeros(cols.shape, dtype=bool)
        hit[inside] = self.occupied[rows[inside], cols[inside]]
        return hit

    def collides(self, x, y):
        angles = np.linspace(0.0, 2.0 * math.pi, 16, endpoint=False)
        return bool(np.any(self.is_occupied(x + self.robot_radius * np.cos(angles), y + self.robot_radius * np.sin(angles))))

    def cmd_vel_callback(self, msg):
        self.cmd_lin = max(-self.max_lin_vel, min(self.max_lin_vel, msg.linear.x))
        self.cmd_ang = max(-self.max_ang_vel, min(self.max_ang_vel, msg.angular.z))
        self.cmd_time = self.get_clock().now()

    def update_robot(self):
        time_now = self.get_clock().now()
        dt = (time_now - self.time_pre).nanoseconds * 1e-9
        self.time_pre = time_now
        if (time_now - self.cmd_time).nanoseconds * 1e-9 > self.cmd_vel_timeout:
            self.cmd_lin, self.cmd_ang = 0.0, 0.0
        delta_s = self.cmd_lin * dt
        delta_theta = self.cmd_ang * dt
        world_x = self.world_x + delta_s * math.cos(self.world_yaw + (delta_theta / 2.0))
        world_y = self.world_y + delta_s * math.sin(self.world_yaw + (delta_theta / 2.0))
        if delta_s != 0.0 and self.collides(world_x, world_y):                                              # blocked by a wall
            delta_s = 0.0
        else:
            self.world_x, self.world_y = world_x, world_y
        self.world_yaw += delta_theta
        self.x += delta_s * math.cos(self.theta + (delta_theta / 2.0))
        self.y += delta_s * math.sin(self.theta + (delta_theta / 2.0))
        self.theta += delta_theta
        self.theta = (self.theta + math.pi) % (2 * math.pi) - math.pi
        self.lin_vel = delta_s / dt if dt > 0.0 else 0.0
        self.ang_vel = delta_theta / dt if dt > 0.0 else 0.0
        self.update_odometry(time_now)
        self.update_jointstate(time_now, delta_s, delta_theta)

    def update_odometry(self, time_now):
        odometry = Odometry()
        odometry.header.frame_id = "odom"
        odometry.header.stamp = time_now.to_msg()
        odometry.pose.pose.position.x = self.x
        odometry.pose.pose.position.y = self.y
        odometry.pose.pose.position.z = 0.0
        odometry.pose.pose.orientation.z = math.sin(self.theta/2.0)
        odometry.pose.pose.orientation.w = math.cos(self.theta/2.0)
        odometry.child_frame_id = "base_footprint"
        odometry.twist.twist.linear.x = self.lin_vel
        odometry.twist.twist.angular.z = self.ang_vel
        self.pub_odom.publish(odometry)
        odom_tf = TransformStamped()
        odom_tf.header.stamp = odometry.header.stamp
        odom_tf.header.frame_id = odometry.header.frame_id
        odom_tf.child_frame_id = odometry.child_frame_id
        odom_tf.transform.translation.x = odometry.pose.pose.position.x
        odom_tf.transform.translation.y = odometry.pose.pose.position.y
        odom_tf.transform.translation.z = odometry.pose.pose.position.z
        odom_tf.transform.rotation = odometry.pose.pose.orientation
        self.tf_bc.sendTransform(odom_tf)

    def update_jointstate(self, time_now, delta_s, delta_theta):
        self.wheel_lh_pos += (delta_s - (self.wheel_separation / 2.0) * delta_theta) / self.wheel_radius    # wheel angle (rad)
        self.wheel_rh_pos += (delta_s + (self.wheel_separation / 2.0) * delta_theta) / self.wheel_radius
        wheel_lh_vel = (self.lin_vel - (self.wheel_separation / 2.0) * self.ang_vel) / self.wheel_radius    # wheel angular velocity (rad/s)
        wheel_rh_vel = (self.lin_vel + (self.wheel_separation / 2.0) * self.ang_vel) / self.wheel_radius
        jointstate = JointState()
        jointstate.header.frame_id = "base_link"
        jointstate.header.stamp = time_now.to_msg()
        jointstate.name = ['wheel_left_joint', 'wheel_right_joint']
        jointstate.position = [self.wheel_lh_pos, self.wheel_rh_pos]
        jointstate.velocity = [wheel_lh_vel, wheel_rh_vel]
        jointstate.effort = []
        self.pub_joint_state.publish(jointstate)

    def update_scan(self):
        if self.scan_mount is None:
            try:
                mount = self.tf_buffer.lookup_transform('base_footprint', 'base_scan', Time()).transform     # from robot_state_publisher
            except TransformException:
                return
            self.scan_mount = (rotation_matrix(mount.rotation), mount.translation.x, mount.translation.y)
        rotation, mount_x, mount_y = self.scan_mount
        angles = np.linspace(-self.angle_max, self.angle_max, self.samples)
        # ray directions of the (possibly upside down) lidar in the world
        rays = rotation @ np.stack([np.cos(angles), np.sin(angles), np.zeros_like(angles)])
        c, s = math.cos(self.world_yaw), math.sin(self.world_yaw)
        dir_x = c * rays[0] - s * rays[1]
        dir_y = s * rays[0] + c * rays[1]
        start_x = self.world_x + c * mount_x - s * mount_y
        start_y = self.world_y + s * mount_x + c * mount_y
        distances = np.arange(self.range_min, self.range_max, self.resolution)
        hit = self.is_occupied(start_x + np.outer(dir_x, distances), start_y + np.outer(dir_y, distances))
        ranges = distances[np.argmax(hit, axis=1)]
        for back in np.arange(self.resolution * 0.8, 0.0, -self.resolution * 0.2):                          # refine the coarse hit
            closer = np.maximum(ranges - back, self.range_min)
            ranges = np.where(self.is_occupied(start_x + dir_x * closer, start_y + dir_y * closer), np.minimum(ranges, closer), ranges)
        ranges = ranges + np.random.normal(0.0, self.noise, self.samples)
        ranges[~hit.any(axis=1)] = 0.0                                                                     # nothing in range
        scan = LaserScan()
        scan.header.frame_id = 'base_scan'
        scan.header.stamp = self.get_clock().now().to_msg()
        scan.angle_min = -self.angle_max
        scan.angle_max = self.angle_max
        scan.angle_increment = 2.0 * self.angle_max / (self.samples - 1)
        scan.time_increment = 0.0
        scan.scan_time = 0.1
        scan.range_min = self.range_min
        scan.range_max = self.range_max
        scan.ranges = ranges.astype(np.float32).tolist()
        scan.intensities = [1000.0 if r > 0.0 else 0.0 for r in scan.ranges]
        self.pub_scan.publish(scan)

def main(args=None):
    rclpy.init(args=args)
    node = FakeRobot()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    except Exception as e:
        node.get_logger().error(f'Exception occurred: {e}')
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
