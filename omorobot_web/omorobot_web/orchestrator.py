import math
import os
import threading
import time

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
        """initial: 'auto' (last known pose, else map origin), 'origin' or (x, y, yaw)."""
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
                initial = self.bridge.remembered_pose(map_name)
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

    def stop_navigation(self):
        with self._lock:
            self.bridge.cancel_navigation()
            self.bridge.stop_motion()
            if self.processes['navigation'].stop():
                self.bridge.reset_nav_ready()
            self.nav_map = None

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
