import operator
import threading
import time
from collections import deque

from .orchestrator import OperationError
from .storage import StorageError

MAX_CALL_DEPTH = 8
OPERATORS = {
    '==': operator.eq, '!=': operator.ne,
    '<': operator.lt, '<=': operator.le,
    '>': operator.gt, '>=': operator.ge,
}
STEP_TYPES = (
    'move', 'wait', 'set_output', 'wait_input', 'if', 'loop',
    'break', 'set_var', 'log', 'call', 'end',
)


class JobError(Exception):
    pass


class _Stop(Exception):
    """Stop requested by the user."""


class _End(Exception):
    """'end' step, finish the job normally."""


class _Break(Exception):
    """'break' step, leave the innermost loop."""


def number(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def has_move(steps):
    for step in steps:
        if step.get('type') == 'move':
            return True
        if any(has_move(step.get(key) or []) for key in ('then', 'else', 'steps')):
            return True
    return False


def validate(job, maps, jobs, channels=8, visited=()):
    """List of problems that would stop the job, [] when the job can run."""
    problems = []
    map_name = job.get('map', '')
    points = {}
    if map_name and maps.exists(map_name):
        points = {point['id']: point for point in maps.points(map_name)}

    def check_channel(step, label):
        channel = int(number(step.get('channel'), 0))
        if not 1 <= channel <= channels:
            problems.append(f'{label}: IO 채널은 1~{channels} 범위여야 합니다.')

    def check_condition(cond, label):
        cond = cond or {}
        if cond.get('kind') in ('input', 'output'):
            check_channel(cond, label)
        elif cond.get('kind') == 'var':
            if not str(cond.get('name', '')).strip():
                problems.append(f'{label}: 조건의 변수 이름이 비어 있습니다.')
        else:
            problems.append(f'{label}: 조건이 설정되지 않았습니다.')
        if cond.get('op', '==') not in OPERATORS:
            problems.append(f'{label}: 알 수 없는 비교 연산자입니다.')

    def walk(steps, prefix):
        for index, step in enumerate(steps, start=1):
            label = f'{prefix}{index}'
            kind = step.get('type')
            if kind not in STEP_TYPES:
                problems.append(f'{label}: 알 수 없는 명령입니다 ({kind}).')
            elif kind == 'move':
                if not map_name:
                    problems.append(f'{label}: Job에 맵이 지정되지 않았습니다.')
                elif not maps.exists(map_name):
                    problems.append(f'{label}: 맵을 찾을 수 없습니다 ({map_name}).')
                for point_id in list(step.get('via') or []) + [step.get('point')]:
                    if point_id not in points:
                        problems.append(f'{label}: 이동할 포인트가 없거나 삭제되었습니다.')
                        break
            elif kind in ('set_output', 'wait_input'):
                check_channel(step, label)
            elif kind == 'if':
                check_condition(step.get('cond'), label)
                walk(step.get('then') or [], f'{label}.')
                walk(step.get('else') or [], f'{label}.else.')
            elif kind == 'loop':
                if step.get('mode') == 'while':
                    check_condition(step.get('cond'), label)
                walk(step.get('steps') or [], f'{label}.')
            elif kind == 'set_var':
                if not str(step.get('name', '')).strip():
                    problems.append(f'{label}: 변수 이름이 비어 있습니다.')
            elif kind == 'call':
                target = step.get('job', '')
                if not target or not jobs.exists(target):
                    problems.append(f'{label}: 호출할 Job을 찾을 수 없습니다 ({target}).')
                elif target == job.get('name') or target in visited:
                    problems.append(f'{label}: Job이 자기 자신을 다시 호출합니다 ({target}).')
                else:
                    callee = jobs.get(target)
                    if has_move(callee.get('steps') or []) and callee.get('map', '') != map_name:
                        problems.append(f'{label}: 호출할 Job({target})이 다른 맵을 사용합니다.')
                    inner = validate(callee, maps, jobs, channels, visited + (job.get('name'),))
                    problems.extend(f'{label} → {target} {problem}' for problem in inner)
    walk(job.get('steps') or [], '')
    return problems


class JobRunner:
    def __init__(self, bridge, maps, jobs, orchestrator):
        self.bridge = bridge
        self.maps = maps
        self.jobs = jobs
        self.orchestrator = orchestrator
        self.state = 'idle'         # idle, running, paused, finished, stopped, error
        self.job_name = ''
        self.map_name = ''
        self.message = ''
        self.current = None         # id of the step in execution
        self.stack = []             # ids of the 'call' steps that lead to the current step
        self.activity = ''
        self.variables = {}
        self.started_at = None
        self.finished_at = None
        self._thread = None
        self._stop = threading.Event()
        self._pause = threading.Event()
        self._lock = threading.RLock()
        self._log = deque(maxlen=500)
        self._seq = 0

    # ------------------------------------------------------------------ control
    def is_active(self):
        return self._thread is not None and self._thread.is_alive()

    def start(self, name):
        with self._lock:
            if self.is_active():
                raise JobError('이미 실행 중인 Job이 있습니다.')
            job = self.jobs.get(name)
            problems = validate(job, self.maps, self.jobs, self.bridge.io_channels)
            if problems:
                raise JobError('Job을 실행할 수 없습니다: ' + ' / '.join(problems[:5]))
            self._stop.clear()
            self._pause.clear()
            self.state = 'running'
            self.job_name = name
            self.map_name = job.get('map', '')
            self.message = ''
            self.activity = ''
            self.current = None
            self.stack = []
            self.variables = {}
            self.started_at = time.time()
            self.finished_at = None
            self._thread = threading.Thread(target=self._run, args=(job,), daemon=True)
            self._thread.start()

    def pause(self):
        if self.is_active() and not self._stop.is_set():
            self._pause.set()
            self.state = 'paused'
            self.bridge.cancel_navigation()
            self.bridge.stop_motion()
            self.log('일시 정지')

    def resume(self):
        if self.is_active() and self._pause.is_set():
            self._pause.clear()
            self.state = 'running'
            self.log('다시 시작')

    def stop(self, wait=3.0):
        if not self.is_active():
            return
        self._stop.set()
        self._pause.clear()
        self.bridge.cancel_navigation()
        if threading.current_thread() is not self._thread:
            self._thread.join(wait)

    def status(self):
        return {
            'state': self.state,
            'name': self.job_name,
            'map': self.map_name,
            'message': self.message,
            'current': self.current,
            'stack': list(self.stack),
            'activity': self.activity,
            'variables': dict(self.variables),
            'started_at': self.started_at,
            'finished_at': self.finished_at,
            'log_seq': self._seq,
        }

    def log(self, text, level='info'):
        with self._lock:
            self._seq += 1
            self._log.append((self._seq, time.time(), level, text))

    def log_since(self, seq=0):
        with self._lock:
            return [entry for entry in self._log if entry[0] > seq]

    # ------------------------------------------------------------------ execution
    def _run(self, job):
        self.log(f'Job 시작: {job["name"]}')
        try:
            self._block(job.get('steps') or [], job, depth=0)
            self._finish('finished', 'Job 완료')
        except _End:
            self._finish('finished', 'Job 완료 (END)')
        except _Break:
            self._finish('finished', 'Job 완료')
        except _Stop:
            self._finish('stopped', '사용자에 의해 정지됨')
        except (JobError, OperationError, StorageError, ValueError) as e:
            self._finish('error', str(e), level='error')
        except Exception as e:
            self._finish('error', f'내부 오류: {e!r}', level='error')

    def _finish(self, state, message, level='info'):
        self.bridge.cancel_navigation()
        if state != 'finished':
            self.bridge.stop_motion()
        self.state = state
        self.message = message
        self.activity = ''
        self.finished_at = time.time()
        self.log(message, level)

    def _checkpoint(self):
        """Honour stop and pause requests, called between and inside steps."""
        while self._pause.is_set() and not self._stop.is_set():
            time.sleep(0.05)
        if self._stop.is_set():
            raise _Stop()

    def _sleep(self, seconds):
        remaining = float(seconds)
        last = time.monotonic()
        while remaining > 0.0:
            self._checkpoint()
            now = time.monotonic()
            # time spent in pause is not counted
            remaining -= min(now - last, 0.2)
            last = now
            time.sleep(min(0.05, max(remaining, 0.0)))

    def _block(self, steps, job, depth):
        for step in steps:
            self._checkpoint()
            self.current = step.get('id')
            self._step(step, job, depth)

    def _step(self, step, job, depth):
        kind = step.get('type')
        if kind == 'move':
            self._move(step, job)
        elif kind == 'wait':
            seconds = max(0.0, number(step.get('seconds')))
            self._activity(f'대기 {seconds:g}초')
            self._sleep(seconds)
        elif kind == 'set_output':
            channel, value = int(number(step.get('channel'))), int(number(step.get('value')))
            self.bridge.set_dout(channel, value)
            self._activity(f'출력 DO{channel} = {"ON" if value else "OFF"}')
        elif kind == 'wait_input':
            self._wait_input(step)
        elif kind == 'if':
            result = self._condition(step.get('cond'))
            self._activity(f'IF {self._describe(step.get("cond"))} → {"참" if result else "거짓"}')
            self._block(step.get('then' if result else 'else') or [], job, depth)
        elif kind == 'loop':
            self._loop(step, job, depth)
        elif kind == 'break':
            raise _Break()
        elif kind == 'set_var':
            self._set_var(step)
        elif kind == 'log':
            self.log(str(step.get('message', '')), 'user')
        elif kind == 'call':
            self._call(step, depth)
        elif kind == 'end':
            raise _End()
        else:
            raise JobError(f'알 수 없는 명령입니다: {kind}')

    def _activity(self, text):
        self.activity = text
        self.log(text)

    # ------------------------------------------------------------------ steps
    def _move(self, step, job):
        map_name = job.get('map', '')
        points = {point['id']: point for point in self.maps.points(map_name)}
        route = []
        for point_id in list(step.get('via') or []) + [step.get('point')]:
            if point_id not in points:
                raise JobError('이동할 포인트가 없거나 삭제되었습니다.')
            route.append(points[point_id])
        target = route[-1]
        poses = [(p['x'], p['y'], p['yaw']) for p in route]
        on_fail = step.get('on_fail', 'stop')
        attempts = 1 + (max(0, int(number(step.get('retries'), 1))) if on_fail == 'retry' else 0)

        attempt = 0
        while attempt < attempts:
            attempt += 1
            self.activity = f'내비게이션 준비 중 ({map_name})'
            self.orchestrator.ensure_navigation(map_name, should_abort=self._stop.is_set)
            self._checkpoint()
            self._activity(f'이동 → {target["name"]}' + (f' (재시도 {attempt - 1})' if attempt > 1 else ''))
            task = self.bridge.navigate(poses)
            paused = False
            while not task.done:
                if self._stop.is_set():
                    self.bridge.cancel_navigation()
                    raise _Stop()
                if self._pause.is_set() and not paused:
                    paused = True
                    self.bridge.cancel_navigation()
                time.sleep(0.05)
            if task.status == 'succeeded':
                self.log(f'도착: {target["name"]}')
                return
            if paused or self._pause.is_set():
                # the goal was cancelled by the pause, send it again after resume
                self._checkpoint()
                attempt -= 1
                continue
            self._checkpoint()
            self.log(f'이동 실패: {target["name"]} ({task.status} {task.message})'.strip(), 'warn')
        if on_fail == 'continue':
            self.log('이동 실패를 무시하고 다음 명령으로 진행합니다.', 'warn')
            return
        raise JobError(f'포인트 "{target["name"]}" 로 이동하지 못했습니다.')

    def _wait_input(self, step):
        channel, value = int(number(step.get('channel'))), int(number(step.get('value'), 1))
        timeout = max(0.0, number(step.get('timeout')))
        self._activity(f'입력 대기 DI{channel} = {"ON" if value else "OFF"}' + (f' (최대 {timeout:g}초)' if timeout else ''))
        waited = 0.0
        last = time.monotonic()
        while self.bridge.get_din(channel) != (1 if value else 0):
            self._checkpoint()
            now = time.monotonic()
            waited += min(now - last, 0.2)
            last = now
            if timeout and waited >= timeout:
                if step.get('on_timeout', 'stop') == 'continue':
                    self.log(f'DI{channel} 입력 대기 시간 초과, 다음 명령으로 진행합니다.', 'warn')
                    return
                raise JobError(f'DI{channel} 입력 대기 시간 초과')
            time.sleep(0.02)

    def _loop(self, step, job, depth):
        mode = step.get('mode', 'count')
        count = max(0, int(number(step.get('count'), 1)))
        body = step.get('steps') or []
        iteration = 0
        try:
            while True:
                self._checkpoint()
                if mode == 'count' and iteration >= count:
                    break
                if mode == 'while' and not self._condition(step.get('cond')):
                    break
                iteration += 1
                self.current = step.get('id')
                total = f'/{count}' if mode == 'count' else ''
                self._activity(f'반복 {iteration}{total}')
                self._block(body, job, depth)
                if not body:
                    time.sleep(0.05)    # empty loop must not spin
        except _Break:
            self.log('반복 종료 (BREAK)')

    def _call(self, step, depth):
        if depth + 1 >= MAX_CALL_DEPTH:
            raise JobError('Job 호출이 너무 깊습니다. (재귀 호출 확인)')
        name = step.get('job', '')
        job = self.jobs.get(name)
        self._activity(f'Job 호출: {name}')
        self.stack.append(step.get('id'))
        try:
            self._block(job.get('steps') or [], job, depth + 1)
        except _Break:
            pass
        finally:
            self.stack.pop()
        self.current = step.get('id')

    def _set_var(self, step):
        name = str(step.get('name', '')).strip()
        if not name:
            raise JobError('변수 이름이 비어 있습니다.')
        value = number(step.get('value'))
        current = self.variables.get(name, 0.0)
        op = step.get('op', '=')
        if op == '+=':
            value = current + value
        elif op == '-=':
            value = current - value
        self.variables[name] = int(value) if float(value).is_integer() else value
        self._activity(f'변수 {name} = {self.variables[name]}')

    def _condition(self, cond):
        cond = cond or {}
        kind = cond.get('kind')
        if kind == 'input':
            left = self.bridge.get_din(int(number(cond.get('channel'))))
        elif kind == 'output':
            left = self.bridge.get_dout(int(number(cond.get('channel'))))
        elif kind == 'var':
            left = self.variables.get(str(cond.get('name', '')).strip(), 0)
        else:
            raise JobError('조건이 설정되지 않았습니다.')
        compare = OPERATORS.get(cond.get('op', '=='))
        if compare is None:
            raise JobError(f'알 수 없는 비교 연산자입니다: {cond.get("op")}')
        return bool(compare(float(left), number(cond.get('value'))))

    @staticmethod
    def _describe(cond):
        cond = cond or {}
        kind = cond.get('kind')
        op, value = cond.get('op', '=='), cond.get('value')
        if kind in ('input', 'output'):
            name = f'{"DI" if kind == "input" else "DO"}{cond.get("channel")}'
            return f'{name} {op} {"ON" if number(value) else "OFF"}'
        return f'{cond.get("name")} {op} {value}'
