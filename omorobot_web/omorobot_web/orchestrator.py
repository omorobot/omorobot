import math
import os
import threading
import time

from ament_index_python.packages import PackageNotFoundError, get_package_share_directory

from .nav_tolerance import NavTolerance
from .process_manager import ProcessManager
from .storage import StorageError, clean_points, read_json, write_json

BRINGUP_TIMEOUT = 15.0
NAV_READY_TIMEOUT = 90.0
LOCALIZE_TIMEOUT = 40.0


class OperationError(Exception):
    pass


class Orchestrator:
    """Starts/stops bringup, cartographer and navigation2 and keeps the mapping session."""

    def __init__(self, bridge, maps, data_dir, sim=False, sim_world=''):
        self.bridge = bridge
        self.maps = maps
        self.sim = sim
        self.sim_world = sim_world
        self.processes = ProcessManager(os.path.join(data_dir, 'run'), {
            'bringup': ('Failed to open serial port', 'Error, cannot bind to the specified serial port'),
            'cartographer': (),
            'navigation': ('Failed to bring up all requested nodes',),
        })
        self.tolerance = NavTolerance(self.navigation_params(), os.path.join(data_dir, 'run'))
        if not self.tolerance.available:
            bridge.get_logger().warning(f'tolerance of the stop positions is not used, {self.tolerance.error}')
        self.job_runner = None
        self.nav_map = None
        self.notice = ''
        self._session_file = os.path.join(data_dir, 'session_points.json')
        self._session_points = read_json(self._session_file, default=[]) or []
        self._lock = threading.RLock()      # one start/stop operation at a time

    # ------------------------------------------------------------------ status
    def external(self):
        """Nodes started outside of the web server (e.g. from a ssh terminal)."""
        nodes = self.bridge.node_names()

        def foreign(name, present):
            process = self.processes[name]
            return present and not process.is_running() and not process.just_stopped()
        return {
            'bringup': not self.processes['bringup'].is_running() and self.bridge.odom_alive(),
            'cartographer': foreign('cartographer', 'cartographer_node' in nodes),
            'navigation': foreign('navigation', 'bt_navigator' in nodes),
        }

    def status(self):
        status = self.processes.status()
        external = self.external()
        for name, item in status.items():
            item['external'] = external[name]
        return status

    def mode(self):
        external = self.external()
        if self.processes['cartographer'].is_running() or external['cartographer']:
            return 'mapping'
        if self.processes['navigation'].is_running() or external['navigation']:
            return 'navigation'
        return 'idle'

    # ------------------------------------------------------------------ bringup
    def bringup_command(self):
        if self.sim:
            command = ['ros2', 'launch', 'omorobot_web', 'fake_robot_launch.py']
            if self.sim_world:
                command.append(f'world:={self.sim_world}')
            return command
        return ['ros2', 'launch', 'omorobot_bringup', 'bringup_launch.py']

    def start_bringup(self):
        with self._lock:
            if self.bridge.odom_alive():
                return
            process = self.processes['bringup']
            process.start(self.bringup_command(), {'sim': self.sim})
            deadline = time.monotonic() + BRINGUP_TIMEOUT
            error = '로봇 bringup 후 odom/scan 토픽이 확인되지 않습니다. 연결 상태를 확인하세요.'
            while time.monotonic() < deadline:
                if self.bridge.odom_alive() and self.bridge.is_publishing('/scan'):
                    return
                if process.alert:
                    error = f'로봇 bringup 오류: {self._strip_prefix(process.alert)}'
                    break
                if not process.is_running():
                    error = '로봇 bringup 이 종료되었습니다. ' + self._last_log(process)
                    break
                time.sleep(0.2)
            # a half started bringup would block the next try
            alert = process.alert
            process.stop()
            process.alert = alert
            raise OperationError(error)

    def stop_bringup(self):
        with self._lock:
            self._halt()
            self.stop_mapping()
            self.stop_navigation()
            self.processes['bringup'].stop()

    # ------------------------------------------------------------------ mapping
    def start_mapping(self):
        with self._lock:
            if self.mode() == 'mapping':
                return
            self._halt()
            self.stop_navigation()
            self.start_bringup()
            self.bridge.clear_map()
            self.bridge.map_name = None
            self.set_session_points([])
            self.processes['cartographer'].start(
                ['ros2', 'launch', 'omorobot_cartographer', 'cartographer_launch.py'])

    def stop_mapping(self):
        with self._lock:
            self.bridge.stop_motion()
            self.processes['cartographer'].stop()

    def reset_map(self):
        """Throw away the map in the making. A running mapping starts again at the place of the robot."""
        with self._lock:
            if self.external()['cartographer']:
                raise OperationError('외부에서 실행된 cartographer가 있습니다. 해당 터미널에서 다시 시작하세요.')
            if self.mode() == 'navigation':
                raise OperationError('내비게이션 실행 중에는 맵을 초기화할 수 없습니다.')
            process = self.processes['cartographer']
            restart = process.is_running()
            if restart:
                self.stop_mapping()
            self.bridge.clear_map()
            self.bridge.map_name = None
            self.set_session_points([])
            if restart:
                process.start(process.command)

    def save_map(self, name, overwrite=False):
        grid = self.bridge.map_grid()
        if grid is None:
            raise OperationError('저장할 맵이 없습니다. 매핑을 먼저 시작하세요.')
        if self.maps.exists(name) and not overwrite:
            raise OperationError(f'이미 존재하는 이름입니다: {name}')
        info = grid.info
        meta = self.maps.save_grid(
            name, grid.data, info.width, info.height, info.resolution,
            (info.origin.position.x, info.origin.position.y), points=self._session_points)
        if self.mode() == 'mapping':
            self.bridge.map_name = name
        return meta

    def session_points(self):
        return self._session_points

    def set_session_points(self, points):
        self._session_points = clean_points(points)
        write_json(self._session_file, self._session_points)
        return self._session_points

    # ------------------------------------------------------------------ navigation
    def start_navigation(self, map_name, initial='auto', stop_job=True):
        """initial: 'auto' (last known pose, else start position, else map origin), 'origin' or (x, y, yaw)."""
        with self._lock:
            self.maps.require(map_name)
            if self.external()['navigation']:
                raise OperationError('외부에서 실행된 내비게이션이 있습니다. 먼저 종료하세요.')
            if self.processes['navigation'].is_running() and self.nav_map == map_name:
                return
            self._halt(stop_job)
            self.stop_mapping()
            self.stop_navigation()
            self.start_bringup()
            if initial == 'auto':
                initial = self.bridge.remembered_pose(map_name) or self.maps.start_pose(map_name)
            elif initial == 'origin':
                initial = None
            self.bridge.clear_map()
            self.bridge.reset_nav_ready()
            self.bridge.map_name = map_name
            self.nav_map = map_name
            self.processes['navigation'].start(
                ['ros2', 'launch', 'omorobot_navigation2', 'navigation2_launch.py', f'map:={self.maps.activate(map_name)}'],
                {'map': map_name})
            if initial is not None:
                threading.Thread(target=self._localize, args=(tuple(initial),), daemon=True).start()

    @staticmethod
    def navigation_params():
        """Parameter file that navigation2_launch.py of omorobot_navigation2 takes."""
        model = os.getenv('ROBOT_MODEL') or 'R2MINI'
        try:
            return os.path.join(get_package_share_directory('omorobot_navigation2'), 'param', f'{model}.yaml')
        except PackageNotFoundError:
            return ''

    def navigate(self, poses, xy_tol=None, yaw_tol=None):
        """Send the robot to the last pose, xy_tol / yaw_tol: tolerance of that stop position."""
        tolerance = self.tolerance.resolve(xy_tol, yaw_tol)
        if tolerance is None:
            return self.bridge.navigate(poses)
        behavior_tree = self.tolerance.behavior_tree(tolerance.controller, through_poses=len(poses) > 1)
        if tolerance.controller != self.tolerance.default_controller and not behavior_tree:
            raise OperationError('정지 정밀도에 맞는 behavior tree 를 만들지 못했습니다.')
        if not self.bridge.set_goal_tolerance(self.tolerance.goal_checker, tolerance.xy, tolerance.yaw):
            raise OperationError('정지 정밀도를 내비게이션에 설정하지 못했습니다. (controller_server)')
        task = self.bridge.navigate(poses, behavior_tree, tolerance.as_dict())
        task.adjusted = tolerance.adjusted
        return task

    def stop_navigation(self):
        with self._lock:
            self.bridge.cancel_navigation()
            self.bridge.stop_motion()
            if self.processes['navigation'].stop():
                self.bridge.reset_nav_ready()
            self.nav_map = None

    def end_navigation(self):
        """Stop button of the navigation. The bringup stops too: the pose is not remembered, the robot
        may be carried to the start position before the next navigation starts."""
        with self._lock:
            self._halt()
            self.stop_navigation()
            if self.mode() != 'mapping' and self.processes['bringup'].stop():
                # a start right after this must not take the old odometry for a running bringup
                deadline = time.monotonic() + 3.0
                while self.bridge.odom_alive() and time.monotonic() < deadline:
                    time.sleep(0.1)

    def ensure_navigation(self, map_name, should_abort=lambda: False):
        """Block until navigation with the map accepts goals (used by jobs)."""
        with self._lock:
            # a stop request may have arrived while waiting for the lock
            if should_abort():
                return
            if self.external()['navigation']:
                # started from a terminal, the loaded map is not known here
                if self.bridge.nav_ready():
                    return
            else:
                self.start_navigation(map_name, stop_job=False)
        deadline = time.monotonic() + NAV_READY_TIMEOUT
        while time.monotonic() < deadline:
            if should_abort():
                return
            if self.bridge.nav_ready() and self.bridge.pose_in_map() is not None:
                return
            if self.processes['navigation'].alert:
                raise OperationError('내비게이션을 시작하지 못했습니다. 시스템 메뉴의 로그를 확인하세요.')
            if not self.processes['navigation'].is_running() and not self.external()['navigation']:
                raise OperationError('내비게이션이 종료되었습니다. ' + self._last_log(self.processes['navigation']))
            time.sleep(0.2)
        raise OperationError('내비게이션이 준비되지 않았습니다. (시간 초과)')

    def set_initial_pose(self, x, y, yaw):
        if self.mode() != 'navigation':
            raise OperationError('내비게이션 실행 중에만 초기 위치를 설정할 수 있습니다.')
        self.bridge.set_initial_pose(x, y, yaw)

    def _localize(self, target):
        """Publish the initial pose once amcl is up and check that it was taken."""
        process = self.processes['navigation']
        deadline = time.monotonic() + LOCALIZE_TIMEOUT
        while time.monotonic() < deadline and process.is_running():
            if self.bridge.pose_in_map() is None or not self.bridge.is_subscribed('/initialpose'):
                time.sleep(0.3)
                continue
            self.bridge.set_initial_pose(*target)
            time.sleep(1.5)
            pose = self.bridge.pose_in_map()
            # the robot may be driving, compare loosely
            if pose is not None and math.hypot(pose[0] - target[0], pose[1] - target[1]) < 0.5:
                return

    def reload_map(self, map_name):
        """Apply an edited map to a running navigation."""
        if self.nav_map == map_name and self.processes['navigation'].is_running():
            return self.bridge.load_map(self.maps.activate(map_name))
        return False

    # ------------------------------------------------------------------ safety
    def _halt(self, stop_job=True):
        if stop_job and self.job_runner is not None:
            self.job_runner.stop()
        self.bridge.cancel_navigation()
        self.bridge.stop_motion()

    def emergency_stop(self):
        self._halt()
        self.notice = '비상 정지'

    def shutdown(self):
        try:
            self._halt()
        except Exception:
            pass
        self.processes.stop_all()

    @staticmethod
    def _strip_prefix(line):
        """'[robot_control-1] RuntimeError: ...' to 'RuntimeError: ...'"""
        return line.split('] ', 1)[-1] if line.startswith('[') else line

    @staticmethod
    def _last_log(process, count=3):
        lines = [entry[2] for entry in process.log_since(0) if not entry[2].startswith('[omorobot_web]')]
        return ' / '.join(lines[-count:])


__all__ = ['Orchestrator', 'OperationError', 'StorageError']
