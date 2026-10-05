import rclpy
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from rclpy.serialization import deserialize_message
from tf2_msgs.msg import TFMessage
from tf2_ros import Buffer


class TfReader:
    """tf2 buffer filled by polling.

    A rclpy callback per /tf message costs too much cpu at the 100Hz+ of the robot.
    The messages are taken unparsed at the rate of poll() and only the latest message
    of every wanted frame is parsed.
    """

    def __init__(self, node, frames=('map', 'base_footprint'), dynamic=True):
        self.buffer = Buffer()
        self._needles = [frame.encode() + b'\x00' for frame in frames]
        static_qos = QoSProfile(depth=100, reliability=ReliabilityPolicy.RELIABLE, durability=DurabilityPolicy.TRANSIENT_LOCAL)
        node.create_subscription(TFMessage, '/tf_static', self._static_callback, static_qos)
        self._node = None
        self._subscription = None
        if dynamic:
            # this node is never added to an executor, so that the messages wait for poll()
            self._node = rclpy.create_node(f'{node.get_name()}_tf', use_global_arguments=False, start_parameter_services=False)
            self._subscription = self._node.create_subscription(TFMessage, '/tf', lambda msg: None, QoSProfile(depth=100), raw=True)

    def _static_callback(self, msg):
        for transform in msg.transforms:
            self.buffer.set_transform_static(transform, 'tf_static')

    def poll(self):
        latest = {}
        while True:
            with self._subscription.handle:
                taken = self._subscription.handle.take_message(self._subscription.msg_type, True)
            if taken is None:
                break
            for needle in self._needles:
                if needle in taken[0]:
                    latest[needle] = taken[0]
        for raw in latest.values():
            for transform in deserialize_message(raw, TFMessage).transforms:
                self.buffer.set_transform(transform, 'tf')

    def destroy(self):
        if self._node is not None:
            self._node.destroy_node()
