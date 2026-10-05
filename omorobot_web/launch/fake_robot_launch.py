import os
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue
from launch import LaunchDescription
from ament_index_python.packages import get_package_share_directory
from launch.substitutions import LaunchConfiguration
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription

def generate_launch_description():
    description_dir = get_package_share_directory('omorobot_description')
    navigation_dir = get_package_share_directory('omorobot_navigation2')

    world = LaunchConfiguration('world', default=os.path.join(navigation_dir, 'map', 'turtlebot3_world.yaml'))
    start_x = LaunchConfiguration('start_x', default='-2.0')
    start_y = LaunchConfiguration('start_y', default='-0.5')
    start_yaw = LaunchConfiguration('start_yaw', default='0.0')

    world_arg = DeclareLaunchArgument('world', default_value=world)
    start_x_arg = DeclareLaunchArgument('start_x', default_value=start_x)
    start_y_arg = DeclareLaunchArgument('start_y', default_value=start_y)
    start_yaw_arg = DeclareLaunchArgument('start_yaw', default_value=start_yaw)

    fake_robot_node = Node(
        package='omorobot_web',
        executable='fake_robot',
        name='fake_robot',
        output='screen',
        emulate_tty=True,
        parameters=[{
            'world': ParameterValue(world, value_type=str),
            'start_x': ParameterValue(start_x, value_type=float),
            'start_y': ParameterValue(start_y, value_type=float),
            'start_yaw': ParameterValue(start_yaw, value_type=float),
        }]
    )

    robot_state_publisher_node = IncludeLaunchDescription(
        PythonLaunchDescriptionSource([description_dir, '/launch/robot_state_publisher_launch.py'])
    )

    ld = LaunchDescription()
    ld.add_action(world_arg)
    ld.add_action(start_x_arg)
    ld.add_action(start_y_arg)
    ld.add_action(start_yaw_arg)
    ld.add_action(fake_robot_node)
    ld.add_action(robot_state_publisher_node)

    return ld
