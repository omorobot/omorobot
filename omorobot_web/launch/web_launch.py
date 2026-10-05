from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue
from launch import LaunchDescription
from launch.substitutions import LaunchConfiguration
from launch.actions import DeclareLaunchArgument

def generate_launch_description():
    host = LaunchConfiguration('host', default='0.0.0.0')
    port = LaunchConfiguration('port', default='8080')
    data_dir = LaunchConfiguration('data_dir', default='~/omorobot_web_data')
    sim = LaunchConfiguration('sim', default='false')
    sim_world = LaunchConfiguration('sim_world', default='')

    host_arg = DeclareLaunchArgument('host', default_value=host)
    port_arg = DeclareLaunchArgument('port', default_value=port)
    data_dir_arg = DeclareLaunchArgument('data_dir', default_value=data_dir)
    sim_arg = DeclareLaunchArgument('sim', default_value=sim)
    sim_world_arg = DeclareLaunchArgument('sim_world', default_value=sim_world)

    web_server_node = Node(
        package='omorobot_web',
        executable='web_server',
        name='omorobot_web',
        output='screen',
        emulate_tty=True,
        parameters=[{
            'host': ParameterValue(host, value_type=str),
            'port': ParameterValue(port, value_type=int),
            'data_dir': ParameterValue(data_dir, value_type=str),
            'sim': ParameterValue(sim, value_type=bool),
            'sim_world': ParameterValue(sim_world, value_type=str),
        }]
    )

    ld = LaunchDescription()
    ld.add_action(host_arg)
    ld.add_action(port_arg)
    ld.add_action(data_dir_arg)
    ld.add_action(sim_arg)
    ld.add_action(sim_world_arg)
    ld.add_action(web_server_node)

    return ld
