import math
import os
import re

import yaml
from ament_index_python.packages import PackageNotFoundError, get_package_share_directory

DEFAULT_CONTROLLER = 'FollowPath'
BT_FILES = {
    # bt_navigator parameter: behavior tree of nav2 used without the parameter
    'default_nav_to_pose_bt_xml': 'navigate_to_pose_w_replanning_and_recovery.xml',
    'default_nav_through_poses_bt_xml': 'navigate_through_poses_w_replanning_and_recovery.xml',
}
CONTROLLER_ID = re.compile(r'controller_id="[^"]*"')


class GoalTolerance:
    """Tolerance of one goal, made by NavTolerance.resolve()."""

    def __init__(self, controller, xy, yaw, adjusted=False):
        self.controller = controller
        self.xy = xy
        self.yaw = yaw
        self.adjusted = adjusted        # the wanted position tolerance is below the lowest of the controllers

    def as_dict(self):
        return {'xy': self.xy, 'yaw': self.yaw, 'controller': self.controller}

    def text(self):
        return f'{self.xy * 100.0:g} cm / {math.degrees(self.yaw):.1f}°'


class NavTolerance:
    """Position / angle tolerance of a stop position.

    The goal checker of the controller_server takes a new tolerance before every goal.
    The controller (DWB) reads its xy_goal_tolerance once at the start: inside of that
    distance the robot only turns to the direction of the goal and does not come closer.
    So the navigation parameters hold controllers with different tolerances, the one that
    fits to the point is picked with a copy of the behavior tree that names the controller.
    """

    def __init__(self, params_file, run_dir):
        self.params_file = params_file
        self.bt_dir = os.path.join(run_dir, 'bt')
        self.available = False
        self.goal_checker = ''
        self.default_xy = 0.25
        self.default_yaw = 0.25
        self.default_controller = DEFAULT_CONTROLLER
        self.controllers = {}           # controller id: xy_goal_tolerance
        self.bt_files = {}
        self.error = ''
        self.load()

    def load(self):
        try:
            with open(self.params_file, 'r', encoding='utf-8') as f:
                params = yaml.safe_load(f)
            controller = params['controller_server']['ros__parameters']
            checker = controller['goal_checker_plugins'][0]
            self.default_xy = float(controller[checker]['xy_goal_tolerance'])
            self.default_yaw = float(controller[checker]['yaw_goal_tolerance'])
            controllers = {
                name: float(controller[name]['xy_goal_tolerance'])
                for name in controller['controller_plugins'] if 'xy_goal_tolerance' in controller.get(name, {})}
            plugins = list(controller['controller_plugins'])
            navigator = (params.get('bt_navigator') or {}).get('ros__parameters') or {}
        except (OSError, KeyError, IndexError, TypeError, ValueError, yaml.YAMLError) as e:
            self.error = f'{self.params_file}: {e!r}'
            return
        if not controllers:
            self.error = f'{self.params_file}: no controller with xy_goal_tolerance'
            return
        self.goal_checker = checker
        self.controllers = controllers
        self.default_controller = DEFAULT_CONTROLLER if DEFAULT_CONTROLLER in plugins else plugins[0]
        for parameter, filename in BT_FILES.items():
            path = navigator.get(parameter) or ''
            if not path:
                try:
                    path = os.path.join(get_package_share_directory('nav2_bt_navigator'), 'behavior_trees', filename)
                except PackageNotFoundError:
                    path = ''
            self.bt_files[parameter] = path
        self.available = True

    def min_xy(self):
        return min(self.controllers.values()) if self.controllers else self.default_xy

    def as_dict(self):
        return {
            'available': self.available,
            'xy': self.default_xy,
            'yaw': self.default_yaw,
            'min_xy': self.min_xy(),
        }

    def resolve(self, xy=None, yaw=None):
        """Tolerance and controller of a goal, None: default of the navigation parameters."""
        if not self.available:
            return None
        xy = self.default_xy if xy is None else float(xy)
        yaw = self.default_yaw if yaw is None else float(yaw)
        # the controller has to bring the robot inside of the tolerance of the goal checker
        fitting = {name: value for name, value in self.controllers.items() if value <= xy + 1e-6}
        if fitting:
            best = max(fitting.values())
            names = [name for name, value in fitting.items() if value == best]
            adjusted = False
        else:
            best = self.min_xy()
            names = [name for name, value in self.controllers.items() if value == best]
            xy = best
            adjusted = True
        controller = self.default_controller if self.default_controller in names else names[0]
        return GoalTolerance(controller, round(xy, 4), round(yaw, 4), adjusted)

    def behavior_tree(self, controller, through_poses=False):
        """File of the behavior tree that drives with the controller, '' for the default tree."""
        if not self.available or controller == self.default_controller:
            return ''
        source = self.bt_files['default_nav_through_poses_bt_xml' if through_poses else 'default_nav_to_pose_bt_xml']
        try:
            with open(source, 'r', encoding='utf-8') as f:
                text, count = CONTROLLER_ID.subn(f'controller_id="{controller}"', f.read())
            if not count:
                return ''
            os.makedirs(self.bt_dir, exist_ok=True)
            name, ext = os.path.splitext(os.path.basename(source))
            path = os.path.join(self.bt_dir, f'{name}_{controller}{ext}')
            previous = None
            if os.path.isfile(path):
                with open(path, 'r', encoding='utf-8') as f:
                    previous = f.read()
            if previous != text:
                tmp = f'{path}.tmp'
                with open(tmp, 'w', encoding='utf-8') as f:
                    f.write(text)
                os.replace(tmp, path)
            return path
        except OSError:
            return ''
