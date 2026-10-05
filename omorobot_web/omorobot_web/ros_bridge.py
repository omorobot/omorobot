import math
import os
import threading
import time

import numpy as np
from action_msgs.msg import GoalStatus
from geometry_msgs.msg import PoseStamped, PoseWithCovarianceStamped, Twist
from nav2_msgs.action import NavigateThroughPoses, NavigateToPose
from nav2_msgs.srv import LoadMap
from nav_msgs.msg import OccupancyGrid, Path
from rclpy.action import ActionClient
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy, qos_profile_sensor_data
from rclpy.time import Time
from sensor_msgs.msg import LaserScan
from std_msgs.msg import UInt8MultiArray
from std_srvs.srv import Trigger
from tf2_ros import TransformException

from .storage import grid_to_gray, gray_to_png
from .tf_reader import TfReader

ROBOT_MODEL = os.getenv('ROBOT_MODEL', 'R2MINI')

if ROBOT_MODEL == 'R2MINI':
    MAX_LIN_VEL = 0.3   # 0.3m/s
    MAX_ANG_VEL = 1.0   # 1.0rad/s
else: # R2 etc
    MAX_LIN_VEL = 0.6   # 0.6m/s
    MAX_ANG_VEL = 1.0   # 1.0rad/s

BASE_FRAME = 'base_footprint'
TELEOP_RATE = 20.0          # Hz
TELEOP_TIMEOUT = 0.5        # s, stop when the browser stops sending commands
TELEOP_LIN_ACCEL = 0.6      # m/s^2
TELEOP_ANG_ACCEL = 2.4      # rad/s^2
TF_STALE_SEC = 1.0
MAP_TF_STALE_SEC = 3.0
NAV_CHECK_TIMEOUT = 4.0
MAX_SCAN_POINTS = 360
MAX_PATH_POINTS = 200

NAV_STATUS = {
    GoalStatus.STATUS_SUCCEEDED: 'succeeded',
    GoalStatus.STATUS_ABORTED: 'aborted',
    GoalStatus.STATUS_CANCELED: 'canceled',
}


def yaw_to_quaternion(yaw):
    return math.sin(yaw / 2.0), math.cos(yaw / 2.0)


def quaternion_to_yaw(q):
    return math.atan2(2.0 * (q.w * q.z + q.x * q.y), 1.0 - 2.0 * (q.y * q.y + q.z * q.z))


def rotation_matrix(q):
    x, y, z, w = q.x, q.y, q.z, q.w
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def compose(a, b):
    """Pose a followed by pose b expressed in a. Poses are (x, y, yaw)."""
    c, s = math.cos(a[2]), math.sin(a[2])
    return (a[0] + c * b[0] - s * b[1], a[1] + s * b[0] + c * b[1], normalize(a[2] + b[2]))


def inverse(a):
    c, s = math.cos(a[2]), math.sin(a[2])
    return (-c * a[0] - s * a[1], s * a[0] - c * a[1], normalize(-a[2]))


def normalize(angle):
    return (angle + math.pi) % (2.0 * math.pi) - math.pi


class NavTask:
    """One navigation goal sent to Nav2."""

    def __init__(self, poses):
        self.poses = poses
        self.status = 'pending'     # pending, active, succeeded, aborted, canceled, rejected, failed
        self.message = ''
        self.distance_remaining = None
        self.goal_handle = None
        self.cancel_requested = False
        self.finished = threading.Event()

    @property
    def done(self):
        return self.finished.is_set()

    def finish(self, status, message=''):
        self.status = status
        self.message = message
        self.finished.set()

    def as_dict(self):
        x, y, yaw = self.poses[-1]
        return {
            'status': self.status,
            'message': self.message,
            'goal': {'x': x, 'y': y, 'yaw': yaw},
            'via': [{'x': p[0], 'y': p[1], 'yaw': p[2]} for p in self.poses[:-1]],
            'distance_remaining': self.distance_remaining,
        }


class RosBridge(Node):
    def __init__(self, io_channels=8):
        super().__init__('omorobot_web')
        self.group = ReentrantCallbackGroup()
        self._lock = threading.RLock()

        # live map
        self._map_msg = None
        self._map_version = 0
        self._map_png = (None, None)      # (version, bytes)
        # scan / path / odometry
        self._scan_msg = None
        self._path_msg = None
        self._path_version = 0
        self._velocity = (0.0, 0.0)
        # robot pose
        self._pose = None                 # {'x','y','yaw','frame'}
        self._odom_pose = None
        self._odom_stamp = None
        self._odom_token = 0
        self._odom_alive = False
        self._pose_memory = None          # last pose in a named map, for the initial pose
        self.map_name = None              # name of the saved map matching the current map frame
        self._scan_points = []
        self._tick_count = 0
        # teleop
        self._teleop_lock = threading.Lock()
        self._teleop_target = (0.0, 0.0)
        self._teleop_current = (0.0, 0.0)
        self._teleop_stamp = 0.0
        self._teleop_active = False
        self._teleop_zero_count = 0
        # navigation
        self._nav_task = None
        self._nav_ready = False
        self._nav_check = None            # (future, start time) of the running is_active request
        # digital io
        self.io_channels = io_channels
        self._din = [0] * io_channels
        self._dout = [0] * io_channels

        latched = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE, durability=DurabilityPolicy.TRANSIENT_LOCAL)

        self.tf = TfReader(self, frames=('map', BASE_FRAME))
        self.tf_buffer = self.tf.buffer

        self.pub_cmd_vel = self.create_publisher(Twist, 'cmd_vel', 10)
        self.pub_initial_pose = self.create_publisher(PoseWithCovarianceStamped, 'initialpose', 10)
        self.pub_dout = self.create_publisher(UInt8MultiArray, 'io/digital_out', latched)

        self.create_subscription(OccupancyGrid, 'map', self._map_callback, latched, callback_group=self.group)
        self.create_subscription(LaserScan, 'scan', self._scan_callback, qos_profile_sensor_data, callback_group=self.group)
        self.create_subscription(Path, 'plan', self._path_callback, 10, callback_group=self.group)
        self.create_subscription(UInt8MultiArray, 'io/digital_in', self._din_callback, 10, callback_group=self.group)

        self.nav_to_pose = ActionClient(self, NavigateToPose, 'navigate_to_pose', callback_group=self.group)
        self.nav_through_poses = ActionClient(self, NavigateThroughPoses, 'navigate_through_poses', callback_group=self.group)
        self.cli_nav_active = self.create_client(Trigger, 'lifecycle_manager_navigation/is_active', callback_group=self.group)
        self.cli_load_map = self.create_client(LoadMap, 'map_server/load_map', callback_group=self.group)

        self.create_timer(1.0 / TELEOP_RATE, self._teleop_tick, callback_group=self.group)
        self.create_timer(0.1, self._state_tick, callback_group=self.group)
        self.create_timer(2.0, self._nav_ready_tick, callback_group=self.group)
        self._publish_dout()

    # ------------------------------------------------------------------ callbacks
    def _map_callback(self, msg):
        with self._lock:
            self._map_msg = msg
            self._map_version += 1

    def _scan_callback(self, msg):
        self._scan_msg = msg

    def _path_callback(self, msg):
        with self._lock:
            self._path_msg = msg
            self._path_version += 1

    def _din_callback(self, msg):
        with self._lock:
            for i, value in enumerate(msg.data[:self.io_channels]):
                self._din[i] = 1 if value else 0

    # ------------------------------------------------------------------ robot state
    def _lookup(self, target, source):
        try:
            return self.tf_buffer.lookup_transform(target, source, Time())
        except TransformException:
            return None

    def _is_fresh(self, transform, limit=TF_STALE_SEC):
        stamp = Time.from_msg(transform.header.stamp)
        age = (self.get_clock().now() - stamp).nanoseconds * 1e-9
        return age < limit

    def _state_tick(self):
        self._tick_count += 1
        self.tf.poll()
        odom_tf = self._lookup('odom', BASE_FRAME)
        alive = odom_tf is not None and self._is_fresh(odom_tf)
        if alive and not self._odom_alive:
            self._odom_token += 1         # odometry restarted, poses before this are not comparable
        self._odom_alive = alive
        if not alive:
            self._pose = None
            self._odom_pose = None
            self._odom_stamp = None
            self._velocity = (0.0, 0.0)
            self._scan_points = []
            return
        t = odom_tf.transform
        self._update_velocity((t.translation.x, t.translation.y, quaternion_to_yaw(t.rotation)), Time.from_msg(odom_tf.header.stamp))

        frame = 'odom'
        pose = self._odom_pose
        map_tf = self._lookup('map', 'odom')
        # the last map->odom stays in the buffer after slam/localization stopped
        if map_tf is not None and self._is_fresh(map_tf, MAP_TF_STALE_SEC):
            m = map_tf.transform
            pose = compose((m.translation.x, m.translation.y, quaternion_to_yaw(m.rotation)), self._odom_pose)
            frame = 'map'
            if self.map_name:
                self._pose_memory = {
                    'map': self.map_name, 'pose': pose, 'odom': self._odom_pose, 'token': self._odom_token}
        self._pose = {'x': pose[0], 'y': pose[1], 'yaw': pose[2], 'frame': frame}
        if self._tick_count % 2 == 0:
            self._update_scan_points(frame)

    def _update_velocity(self, odom_pose, stamp):
        previous, previous_stamp = self._odom_pose, self._odom_stamp
        self._odom_pose, self._odom_stamp = odom_pose, stamp
        if previous is None:
            return
        dt = (stamp - previous_stamp).nanoseconds * 1e-9
        if dt <= 0.0:
            return
        dx, dy = odom_pose[0] - previous[0], odom_pose[1] - previous[1]
        # forward is positive, backward is negative
        direction = 1.0 if dx * math.cos(odom_pose[2]) + dy * math.sin(odom_pose[2]) >= 0.0 else -1.0
        self._velocity = (direction * math.hypot(dx, dy) / dt, normalize(odom_pose[2] - previous[2]) / dt)

    def _update_scan_points(self, frame):
        scan = self._scan_msg
        if scan is None or not scan.ranges:
            self._scan_points = []
            return
        age = (self.get_clock().now() - Time.from_msg(scan.header.stamp)).nanoseconds * 1e-9
        transform = self._lookup(frame, scan.header.frame_id)
        if transform is None or age > TF_STALE_SEC:
            self._scan_points = []
            return
        ranges = np.asarray(scan.ranges, dtype=np.float32)
        angles = scan.angle_min + np.arange(ranges.size, dtype=np.float32) * scan.angle_increment
        step = max(1, int(math.ceil(ranges.size / MAX_SCAN_POINTS)))
        ranges, angles = ranges[::step], angles[::step]
        valid = np.isfinite(ranges) & (ranges > max(scan.range_min, 0.01)) & (ranges < scan.range_max)
        ranges, angles = ranges[valid], angles[valid]
        points = np.stack([ranges * np.cos(angles), ranges * np.sin(angles), np.zeros_like(ranges)])
        t = transform.transform
        points = rotation_matrix(t.rotation) @ points
        xs = np.round(points[0] + t.translation.x, 3)
        ys = np.round(points[1] + t.translation.y, 3)
        self._scan_points = np.stack([xs, ys], axis=1).flatten().tolist()

    def robot_state(self):
        pose = self._pose
        if pose is not None:
            pose = {'x': round(pose['x'], 3), 'y': round(pose['y'], 3), 'yaw': round(pose['yaw'], 4), 'frame': pose['frame']}
        return {
            'connected': self._odom_alive,
            'pose': pose,
            'velocity': {'lin': round(self._velocity[0], 3), 'ang': round(self._velocity[1], 3)},
            'model': ROBOT_MODEL,
            'limits': {'lin': MAX_LIN_VEL, 'ang': MAX_ANG_VEL},
        }

    def scan_points(self):
        return self._scan_points

    def pose_in_map(self):
        pose = self._pose
        if pose is None or pose['frame'] != 'map':
            return None
        return (pose['x'], pose['y'], pose['yaw'])

    def remembered_pose(self, map_name):
        """Where the robot should be in the named map, if odometry ran without a gap since."""
        memory = self._pose_memory
        if memory is None or memory['map'] != map_name or memory['token'] != self._odom_token:
            return None
        if self._odom_pose is None:
            return None
        return compose(memory['pose'], compose(inverse(memory['odom']), self._odom_pose))

    def is_publishing(self, topic):
        return self.count_publishers(topic) > 0

    def odom_alive(self):
        """True while the odometry transform of the robot arrives."""
        return self._odom_alive

    def is_subscribed(self, topic):
        return self.count_subscribers(topic) > 0

    def node_names(self):
        return set(self.get_node_names())

    # ------------------------------------------------------------------ live map
    def clear_map(self):
        with self._lock:
            self._map_msg = None
            self._map_version += 1
            self._path_msg = None
            self._path_version += 1

    def map_info(self):
        with self._lock:
            msg = self._map_msg
            version = self._map_version
        if msg is None:
            return {'version': version, 'available': False}
        info = msg.info
        return {
            'version': version,
            'available': True,
            'width': info.width,
            'height': info.height,
            'resolution': round(info.resolution, 6),
            'origin': [round(info.origin.position.x, 4), round(info.origin.position.y, 4)],
        }

    def map_grid(self):
        with self._lock:
            return self._map_msg

    def map_png(self):
        with self._lock:
            msg = self._map_msg
            version = self._map_version
            cached_version, cached = self._map_png
        if msg is None:
            return None
        if cached_version == version:
            return cached
        png = gray_to_png(grid_to_gray(msg.data, msg.info.width, msg.info.height, trinary=False))
        with self._lock:
            self._map_png = (version, png)
        return png

    def path(self):
        with self._lock:
            msg = self._path_msg
            version = self._path_version
        if msg is None:
            return {'version': version, 'points': []}
        poses = msg.poses
        step = max(1, int(math.ceil(len(poses) / MAX_PATH_POINTS)))
        points = []
        for pose in poses[::step]:
            points.extend((round(pose.pose.position.x, 3), round(pose.pose.position.y, 3)))
        return {'version': version, 'points': points}

    def load_map(self, yaml_path, timeout=5.0):
        """Ask a running map_server to reload the map file."""
        if not self.cli_load_map.service_is_ready():
            return False
        request = LoadMap.Request()
        request.map_url = yaml_path
        done = threading.Event()
        future = self.cli_load_map.call_async(request)
        future.add_done_callback(lambda _: done.set())
        if not done.wait(timeout) or future.result() is None:
            return False
        return future.result().result == LoadMap.Response.RESULT_SUCCESS

    # ------------------------------------------------------------------ teleop
    def set_teleop(self, lin, ang):
        lin = max(-MAX_LIN_VEL, min(MAX_LIN_VEL, float(lin)))
        ang = max(-MAX_ANG_VEL, min(MAX_ANG_VEL, float(ang)))
        with self._teleop_lock:
            self._teleop_target = (lin, ang)
            self._teleop_stamp = time.monotonic()
            if lin != 0.0 or ang != 0.0:
                self._teleop_active = True
                self._teleop_zero_count = 0

    def stop_motion(self):
        """Immediate stop, no ramp."""
        with self._teleop_lock:
            self._teleop_target = (0.0, 0.0)
            self._teleop_current = (0.0, 0.0)
            self._teleop_active = True
            self._teleop_zero_count = 0
        self.pub_cmd_vel.publish(Twist())

    def teleop_state(self):
        return {'active': self._teleop_active, 'lin': round(self._teleop_current[0], 3), 'ang': round(self._teleop_current[1], 3)}

    def _teleop_tick(self):
        with self._teleop_lock:
            if not self._teleop_active:
                return
            if time.monotonic() - self._teleop_stamp > TELEOP_TIMEOUT:
                self._teleop_target = (0.0, 0.0)
            target = self._teleop_target
            lin = self._ramp(self._teleop_current[0], target[0], TELEOP_LIN_ACCEL / TELEOP_RATE)
            ang = self._ramp(self._teleop_current[1], target[1], TELEOP_ANG_ACCEL / TELEOP_RATE)
            self._teleop_current = (lin, ang)
            if lin == 0.0 and ang == 0.0 and target == (0.0, 0.0):
                self._teleop_zero_count += 1
                if self._teleop_zero_count >= 5:
                    self._teleop_active = False     # go silent so that nav2 owns cmd_vel
        twist = Twist()
        twist.linear.x = lin
        twist.angular.z = ang
        self.pub_cmd_vel.publish(twist)

    @staticmethod
    def _ramp(current, target, step):
        # decelerate twice as fast as accelerate
        if abs(target) < abs(current) or target * current < 0.0:
            step *= 2.0
        if target > current:
            return min(target, current + step)
        return max(target, current - step)

    # ------------------------------------------------------------------ navigation
    def _nav_ready_tick(self):
        if not self.cli_nav_active.service_is_ready():
            self._nav_ready = False
            self._nav_check = None
            return
        if self._nav_check is not None:
            future, started = self._nav_check
            if time.monotonic() - started < NAV_CHECK_TIMEOUT:
                return
            # no answer, navigation was stopped with the request on the way
            self.cli_nav_active.remove_pending_request(future)
            self._nav_ready = False
        future = self.cli_nav_active.call_async(Trigger.Request())
        self._nav_check = (future, time.monotonic())
        future.add_done_callback(self._nav_ready_done)

    def _nav_ready_done(self, future):
        if self._nav_check is None or self._nav_check[0] is not future:
            return
        self._nav_check = None
        try:
            self._nav_ready = bool(future.result().success)
        except Exception:
            self._nav_ready = False

    def nav_ready(self):
        return self._nav_ready and self.nav_to_pose.server_is_ready()

    def reset_nav_ready(self):
        self._nav_ready = False
        self._nav_check = None

    def nav_state(self):
        task = self._nav_task
        return {'ready': self.nav_ready(), 'task': task.as_dict() if task else None}

    def set_initial_pose(self, x, y, yaw):
        msg = PoseWithCovarianceStamped()
        msg.header.frame_id = 'map'
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.pose.pose.position.x = float(x)
        msg.pose.pose.position.y = float(y)
        msg.pose.pose.orientation.z, msg.pose.pose.orientation.w = yaw_to_quaternion(float(yaw))
        msg.pose.covariance[0] = 0.25
        msg.pose.covariance[7] = 0.25
        msg.pose.covariance[35] = 0.0685
        self.pub_initial_pose.publish(msg)

    def _pose_stamped(self, pose):
        msg = PoseStamped()
        msg.header.frame_id = 'map'
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.pose.position.x = float(pose[0])
        msg.pose.position.y = float(pose[1])
        msg.pose.orientation.z, msg.pose.orientation.w = yaw_to_quaternion(float(pose[2]))
        return msg

    def navigate(self, poses):
        """Send the robot through poses [(x, y, yaw), ...], the last one is the goal."""
        self.cancel_navigation(wait=3.0)
        task = NavTask([tuple(float(v) for v in pose) for pose in poses])
        self._nav_task = task
        if len(task.poses) == 1:
            client = self.nav_to_pose
            goal = NavigateToPose.Goal()
            goal.pose = self._pose_stamped(task.poses[0])
        else:
            client = self.nav_through_poses
            goal = NavigateThroughPoses.Goal()
            goal.poses = [self._pose_stamped(pose) for pose in task.poses]
        if not client.server_is_ready():
            task.finish('failed', '내비게이션이 실행 중이 아닙니다.')
            return task
        future = client.send_goal_async(goal, feedback_callback=lambda fb: self._nav_feedback(task, fb))
        future.add_done_callback(lambda f: self._nav_accepted(task, f))
        return task

    def _nav_feedback(self, task, feedback):
        task.distance_remaining = round(float(feedback.feedback.distance_remaining), 2)

    def _nav_accepted(self, task, future):
        try:
            goal_handle = future.result()
        except Exception as e:
            task.finish('failed', str(e))
            return
        if goal_handle is None or not goal_handle.accepted:
            task.finish('rejected', '목표가 거부되었습니다.')
            return
        task.goal_handle = goal_handle
        task.status = 'active'
        goal_handle.get_result_async().add_done_callback(lambda f: self._nav_result(task, f))
        if task.cancel_requested:
            goal_handle.cancel_goal_async()

    def _nav_result(self, task, future):
        try:
            status = future.result().status
        except Exception as e:
            task.finish('failed', str(e))
            return
        task.finish(NAV_STATUS.get(status, 'failed'))

    def cancel_navigation(self, wait=0.0):
        task = self._nav_task
        if task is None or task.done:
            return False
        task.cancel_requested = True
        if task.goal_handle is not None:
            task.goal_handle.cancel_goal_async()
        if wait > 0.0:
            task.finished.wait(wait)
        return True

    # ------------------------------------------------------------------ digital io
    def io_state(self):
        with self._lock:
            return {'din': list(self._din), 'dout': list(self._dout)}

    def get_din(self, channel):
        return self._din[self._index(channel)]

    def get_dout(self, channel):
        return self._dout[self._index(channel)]

    def set_din(self, channel, value):
        """Force an input from the web ui (test without hardware)."""
        with self._lock:
            self._din[self._index(channel)] = 1 if value else 0

    def set_dout(self, channel, value):
        with self._lock:
            self._dout[self._index(channel)] = 1 if value else 0
        self._publish_dout()

    def _index(self, channel):
        index = int(channel) - 1
        if not 0 <= index < self.io_channels:
            raise ValueError(f'IO 채널 범위를 벗어났습니다: {channel}')
        return index

    def _publish_dout(self):
        msg = UInt8MultiArray()
        with self._lock:
            msg.data = list(self._dout)
        self.pub_dout.publish(msg)
