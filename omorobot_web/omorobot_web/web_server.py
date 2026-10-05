import logging
import os
import signal
import threading
import time

import rclpy
from ament_index_python.packages import get_package_share_directory
from flask import Flask, Response, jsonify, request, send_file, send_from_directory
from rclpy.executors import SingleThreadedExecutor
from werkzeug.serving import make_server

from .job_runner import JobError, JobRunner, validate
from .orchestrator import OperationError, Orchestrator
from .ros_bridge import RosBridge
from .storage import JobStore, MapStore, SettingsStore, StorageError, check_name

LIVE_MAP = '__live__'       # the map in the making (cartographer) in place of a saved map name


def create_app(bridge, orchestrator, runner, maps, jobs, settings, web_dir):
    app = Flask(__name__, static_folder=None)
    app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0
    app.config['MAX_CONTENT_LENGTH'] = 64 * 1024 * 1024

    def body():
        return request.get_json(silent=True) or {}

    def ok(**data):
        return jsonify({'ok': True, **data})

    @app.errorhandler(StorageError)
    @app.errorhandler(OperationError)
    @app.errorhandler(JobError)
    @app.errorhandler(ValueError)
    def handle_error(error):
        return jsonify({'ok': False, 'error': str(error)}), 400

    @app.errorhandler(Exception)
    def handle_unexpected(error):
        code = getattr(error, 'code', 500)
        if not isinstance(code, int):
            code = 500
        if code >= 500:
            bridge.get_logger().error(f'{request.path}: {error!r}')
        return jsonify({'ok': False, 'error': str(error)}), code

    @app.after_request
    def no_cache(response):
        if request.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    # ------------------------------------------------------------------ static
    @app.route('/')
    def index():
        return send_from_directory(web_dir, 'index.html')

    @app.route('/<path:filename>')
    def static_files(filename):
        return send_from_directory(web_dir, filename)

    # ------------------------------------------------------------------ state
    @app.route('/api/state')
    def state():
        data = {
            'time': time.time(),
            'mode': orchestrator.mode(),
            'sim': orchestrator.sim,
            'robot': bridge.robot_state(),
            'processes': orchestrator.status(),
            'map': bridge.map_info(),
            'map_name': bridge.map_name,
            'nav': {**bridge.nav_state(), 'map': orchestrator.nav_map},
            'job': runner.status(),
            'io': bridge.io_state(),
            'teleop': bridge.teleop_state(),
        }
        if request.args.get('scan') == '1':
            data['scan'] = bridge.scan_points()
        if request.args.get('path') == '1':
            data['path'] = bridge.path()
        return jsonify(data)

    @app.route('/api/estop', methods=['POST'])
    def estop():
        orchestrator.emergency_stop()
        return ok()

    @app.route('/api/settings', methods=['GET', 'PUT'])
    def settings_api():
        if request.method == 'PUT':
            return ok(settings=settings.update(body()))
        return ok(settings=settings.get())

    # ------------------------------------------------------------------ teleop
    @app.route('/api/teleop', methods=['POST'])
    def teleop():
        data = body()
        if runner.state == 'running':
            raise OperationError('Job 실행 중에는 수동 조작을 할 수 없습니다. Job을 일시 정지 또는 정지하세요.')
        bridge.set_teleop(float(data.get('lin', 0.0)), float(data.get('ang', 0.0)))
        return ok()

    @app.route('/api/teleop/stop', methods=['POST'])
    def teleop_stop():
        bridge.stop_motion()
        return ok()

    # ------------------------------------------------------------------ processes
    @app.route('/api/process/<name>/<action>', methods=['POST'])
    def process_action(name, action):
        actions = {
            ('bringup', 'start'): orchestrator.start_bringup,
            ('bringup', 'stop'): orchestrator.stop_bringup,
            ('cartographer', 'start'): orchestrator.start_mapping,
            ('cartographer', 'stop'): orchestrator.stop_mapping,
            ('navigation', 'stop'): orchestrator.stop_navigation,
        }
        if (name, action) not in actions:
            raise OperationError(f'지원하지 않는 동작입니다: {name} {action}')
        actions[(name, action)]()
        return ok()

    @app.route('/api/process/<name>/log')
    def process_log(name):
        if name not in orchestrator.processes:
            raise OperationError(f'알 수 없는 프로세스입니다: {name}')
        lines = orchestrator.processes[name].log_since(int(request.args.get('since', 0)))
        return ok(lines=[{'seq': seq, 'time': stamp, 'text': text} for seq, stamp, text in lines])

    # ------------------------------------------------------------------ mapping
    @app.route('/api/mapping/start', methods=['POST'])
    def mapping_start():
        orchestrator.start_mapping()
        return ok()

    @app.route('/api/mapping/stop', methods=['POST'])
    def mapping_stop():
        orchestrator.stop_mapping()
        return ok()

    @app.route('/api/mapping/save', methods=['POST'])
    def mapping_save():
        data = body()
        meta = orchestrator.save_map(check_name(data.get('name', '')), overwrite=bool(data.get('overwrite')))
        return ok(map=meta)

    @app.route('/api/map/live.png')
    def live_map_image():
        png = bridge.map_png()
        if png is None:
            return jsonify({'ok': False, 'error': '수신된 맵이 없습니다.'}), 404
        return Response(png, mimetype='image/png')

    # ------------------------------------------------------------------ maps
    @app.route('/api/maps')
    def maps_list():
        return ok(maps=maps.list())

    @app.route('/api/maps/import', methods=['POST'])
    def maps_import():
        yaml_file, image_file = request.files.get('yaml'), request.files.get('image')
        if yaml_file is None or image_file is None:
            raise StorageError('yaml 파일과 이미지 파일을 모두 선택하세요.')
        meta = maps.import_files(check_name(request.form.get('name', '')), yaml_file.read(), image_file.read())
        return ok(map=meta)

    @app.route('/api/maps/<name>', methods=['GET', 'DELETE'])
    def maps_item(name):
        if request.method == 'DELETE':
            if orchestrator.nav_map == name:
                raise OperationError('내비게이션에서 사용 중인 맵은 삭제할 수 없습니다.')
            maps.delete(name)
            return ok()
        return ok(map=maps.meta(name), points=maps.points(name))

    @app.route('/api/maps/<name>/image.png')
    def maps_image(name):
        return Response(maps.image_png(name), mimetype='image/png')

    @app.route('/api/maps/<name>/image', methods=['POST'])
    def maps_save_image(name):
        width, height = int(request.args.get('width', 0)), int(request.args.get('height', 0))
        meta = maps.save_pixels(name, request.get_data(), width, height)
        return ok(map=meta, reloaded=orchestrator.reload_map(name))

    @app.route('/api/maps/<name>/restore', methods=['POST'])
    def maps_restore(name):
        meta = maps.restore_original(name)
        return ok(map=meta, reloaded=orchestrator.reload_map(name))

    @app.route('/api/maps/<name>/rename', methods=['POST'])
    def maps_rename(name):
        if orchestrator.nav_map == name:
            raise OperationError('내비게이션에서 사용 중인 맵은 이름을 바꿀 수 없습니다.')
        new_name = check_name(body().get('name', ''))
        meta = maps.rename(name, new_name)
        jobs.rename_map(name, new_name)
        if bridge.map_name == name:
            bridge.map_name = new_name
        return ok(map=meta)

    @app.route('/api/maps/<name>/duplicate', methods=['POST'])
    def maps_duplicate(name):
        return ok(map=maps.duplicate(name, check_name(body().get('name', ''))))

    @app.route('/api/maps/<name>/download')
    def maps_download(name):
        return send_file(maps.archive(name), mimetype='application/zip', as_attachment=True, download_name=f'{name}.zip')

    @app.route('/api/maps/<name>/points', methods=['GET', 'PUT'])
    def maps_points(name):
        if name == LIVE_MAP:
            if request.method == 'PUT':
                return ok(points=orchestrator.set_session_points(body().get('points')))
            return ok(points=orchestrator.session_points())
        if request.method == 'PUT':
            return ok(points=maps.set_points(name, body().get('points')))
        maps.require(name)
        return ok(points=maps.points(name))

    # ------------------------------------------------------------------ navigation
    @app.route('/api/nav/start', methods=['POST'])
    def nav_start():
        data = body()
        initial = data.get('initial', 'auto')
        if isinstance(initial, dict):
            initial = (float(initial['x']), float(initial['y']), float(initial.get('yaw', 0.0)))
        orchestrator.start_navigation(check_name(data.get('map', '')), initial=initial)
        return ok()

    @app.route('/api/nav/stop', methods=['POST'])
    def nav_stop():
        orchestrator.stop_navigation()
        return ok()

    @app.route('/api/nav/initial_pose', methods=['POST'])
    def nav_initial_pose():
        data = body()
        orchestrator.set_initial_pose(float(data['x']), float(data['y']), float(data.get('yaw', 0.0)))
        return ok()

    @app.route('/api/nav/goto', methods=['POST'])
    def nav_goto():
        data = body()
        if runner.is_active():
            raise OperationError('Job 실행 중에는 직접 이동 명령을 보낼 수 없습니다.')
        if not bridge.nav_ready():
            raise OperationError('내비게이션이 준비되지 않았습니다.')
        task = bridge.navigate([(float(data['x']), float(data['y']), float(data.get('yaw', 0.0)))])
        return ok(task=task.as_dict())

    @app.route('/api/nav/cancel', methods=['POST'])
    def nav_cancel():
        bridge.cancel_navigation()
        bridge.stop_motion()
        return ok()

    # ------------------------------------------------------------------ io
    @app.route('/api/io/<kind>', methods=['POST'])
    def io_set(kind):
        data = body()
        channel, value = int(data.get('channel', 0)), int(data.get('value', 0))
        if kind == 'dout':
            bridge.set_dout(channel, value)
        elif kind == 'din':
            bridge.set_din(channel, value)
        else:
            raise OperationError(f'알 수 없는 IO 종류입니다: {kind}')
        return ok(io=bridge.io_state())

    # ------------------------------------------------------------------ jobs
    @app.route('/api/jobs')
    def jobs_list():
        return ok(jobs=jobs.list())

    @app.route('/api/jobs/<name>', methods=['GET', 'PUT', 'DELETE'])
    def jobs_item(name):
        if request.method == 'PUT':
            if runner.is_active() and runner.job_name == name:
                raise OperationError('실행 중인 Job은 저장할 수 없습니다.')
            job = jobs.save(name, body())
            return ok(job=job, problems=validate(job, maps, jobs, bridge.io_channels))
        if request.method == 'DELETE':
            if runner.is_active() and runner.job_name == name:
                raise OperationError('실행 중인 Job은 삭제할 수 없습니다.')
            jobs.delete(name)
            return ok()
        job = jobs.get(name)
        return ok(job=job, problems=validate(job, maps, jobs, bridge.io_channels))

    @app.route('/api/jobs/<name>/rename', methods=['POST'])
    def jobs_rename(name):
        if runner.is_active() and runner.job_name == name:
            raise OperationError('실행 중인 Job은 이름을 바꿀 수 없습니다.')
        return ok(job=jobs.rename(name, check_name(body().get('name', ''))))

    @app.route('/api/jobs/<name>/duplicate', methods=['POST'])
    def jobs_duplicate(name):
        return ok(job=jobs.duplicate(name, check_name(body().get('name', ''))))

    @app.route('/api/job/run', methods=['POST'])
    def job_run():
        runner.start(check_name(body().get('name', '')))
        return ok(job=runner.status())

    @app.route('/api/job/<action>', methods=['POST'])
    def job_action(action):
        actions = {'pause': runner.pause, 'resume': runner.resume, 'stop': runner.stop}
        if action not in actions:
            raise OperationError(f'지원하지 않는 동작입니다: {action}')
        actions[action]()
        return ok(job=runner.status())

    @app.route('/api/job/log')
    def job_log():
        lines = runner.log_since(int(request.args.get('since', 0)))
        return ok(lines=[{'seq': seq, 'time': stamp, 'level': level, 'text': text} for seq, stamp, level, text in lines])

    return app


def main(args=None):
    rclpy.init(args=args)
    bridge = RosBridge()
    bridge.declare_parameter('host', '0.0.0.0')
    bridge.declare_parameter('port', 8080)
    bridge.declare_parameter('data_dir', '~/omorobot_web_data')
    bridge.declare_parameter('sim', False)
    bridge.declare_parameter('sim_world', '')
    host = bridge.get_parameter('host').value
    port = bridge.get_parameter('port').value
    data_dir = os.path.abspath(os.path.expanduser(bridge.get_parameter('data_dir').value))
    sim = bridge.get_parameter('sim').value
    os.makedirs(data_dir, exist_ok=True)

    maps = MapStore(data_dir)
    jobs = JobStore(data_dir)
    settings = SettingsStore(data_dir)
    orchestrator = Orchestrator(bridge, maps, data_dir, sim=sim, sim_world=bridge.get_parameter('sim_world').value)
    runner = JobRunner(bridge, maps, jobs, orchestrator)
    orchestrator.job_runner = runner

    # callbacks never block, one thread keeps the cpu load of rclpy low
    executor = SingleThreadedExecutor()
    executor.add_node(bridge)
    spinning = threading.Event()
    spinning.set()

    def spin():
        while spinning.is_set() and rclpy.ok():
            executor.spin_once(timeout_sec=0.1)
    spin_thread = threading.Thread(target=spin, daemon=True)
    spin_thread.start()

    web_dir = os.path.join(get_package_share_directory('omorobot_web'), 'web')
    app = create_app(bridge, orchestrator, runner, maps, jobs, settings, web_dir)
    logging.getLogger('werkzeug').setLevel(logging.WARNING)
    server = make_server(host, port, app, threaded=True)
    bridge.get_logger().info(f'data directory: {data_dir}')
    bridge.get_logger().info(f'web ui: http://{host}:{port}' + (' (simulation)' if sim else ''))

    def request_shutdown(signum, frame):
        # shutdown() must not run in the thread that serves
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, request_shutdown)
    signal.signal(signal.SIGTERM, request_shutdown)
    try:
        server.serve_forever()
    finally:
        bridge.get_logger().info('shutting down, stopping launched processes')
        orchestrator.shutdown()
        # the spin thread must be gone before the node is destroyed
        spinning.clear()
        spin_thread.join(timeout=2.0)
        executor.shutdown(timeout_sec=1.0)
        bridge.tf.destroy()
        bridge.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
