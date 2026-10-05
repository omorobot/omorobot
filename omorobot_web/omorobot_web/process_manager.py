import os
import re
import signal
import subprocess
import threading
import time
from collections import deque

ANSI_ESCAPE = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]')


# a server started in the background of a script hands down an ignored SIGINT,
# the launch must get the default back to be stoppable
DEFAULT_SIGNALS = ['env', '--default-signal=INT,TERM']


def kill_group(pgid, timeouts=((signal.SIGINT, 5.0), (signal.SIGTERM, 3.0), (signal.SIGKILL, 1.0))):
    """Stop every process of the group, escalate when it does not exit."""
    for sig, timeout in timeouts:
        try:
            os.killpg(pgid, sig)
        except (ProcessLookupError, PermissionError):
            return
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                os.killpg(pgid, 0)
            except (ProcessLookupError, PermissionError):
                return
            time.sleep(0.1)


class ManagedProcess:
    """A ros2 launch (or any command) started and stopped by the web server."""

    def __init__(self, name, run_dir, max_log_lines=1500, alert_patterns=()):
        self.name = name
        self.pid_file = os.path.join(run_dir, f'{name}.pid')
        self.alert_patterns = alert_patterns
        self.alert = ''             # last log line that matched an alert pattern
        self.command = None
        self.info = {}
        self.started_at = None
        self.stopped_at = 0.0       # monotonic time of the last stop
        self.exit_code = None
        self._proc = None
        self._stopping = False
        self._lock = threading.RLock()
        self._log = deque(maxlen=max_log_lines)
        self._seq = 0

    def is_running(self):
        proc = self._proc
        return proc is not None and proc.poll() is None

    def just_stopped(self, seconds=30.0):
        """The nodes of a killed process stay in the ros graph for a while."""
        return self.stopped_at > 0.0 and time.monotonic() - self.stopped_at < seconds

    def state(self):
        if self.is_running():
            return 'stopping' if self._stopping else 'running'
        return 'stopped'

    def status(self):
        proc = self._proc
        if proc is not None and proc.poll() is not None:
            self.exit_code = proc.returncode
        return {
            'name': self.name,
            'state': self.state(),
            'command': ' '.join(self.command) if self.command else '',
            'info': self.info,
            'started_at': self.started_at,
            'exit_code': self.exit_code,
            'alert': self.alert,
            'log_seq': self._seq,
        }

    def start(self, command, info=None):
        with self._lock:
            if self.is_running():
                return False
            env = dict(os.environ)
            env['PYTHONUNBUFFERED'] = '1'
            self.command = list(command)
            self.info = info or {}
            self.exit_code = None
            self.alert = ''
            self._stopping = False
            self._append(f'$ {" ".join(self.command)}')
            # own session: the whole launch tree can be signalled through the process group
            self._proc = subprocess.Popen(
                DEFAULT_SIGNALS + self.command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL, env=env, start_new_session=True)
            self.started_at = time.time()
            with open(self.pid_file, 'w') as f:
                f.write(str(self._proc.pid))
            threading.Thread(target=self._read_output, args=(self._proc,), daemon=True).start()
            return True

    def stop(self, timeout=5.0):
        with self._lock:
            proc = self._proc
            if proc is None or proc.poll() is not None:
                return False
            self._stopping = True
        try:
            # navigation2 rarely exits on SIGINT, "ros2 launch" escalates the same way
            for sig, wait in ((signal.SIGINT, timeout), (signal.SIGTERM, 2.0), (signal.SIGKILL, 2.0)):
                self._signal(proc, sig)
                if self._wait(proc, wait):
                    break
                self._append(f'[omorobot_web] {self.name}: no exit after {signal.Signals(sig).name}, escalating')
            # nodes that outlived the launch process stay in the same process group
            self._signal(proc, signal.SIGKILL)
        finally:
            self.exit_code = None       # stopped on request, the code tells nothing
            self.stopped_at = time.monotonic()
            self._stopping = False
            self._remove_pid_file()
            self._append(f'[omorobot_web] {self.name} stopped (exit code {proc.returncode})')
        return True

    def stop_orphan(self):
        """Stop the process group left behind by a web server that was killed."""
        try:
            with open(self.pid_file, 'r') as f:
                pgid = int(f.read().strip())
            with open(f'/proc/{pgid}/cmdline', 'rb') as f:
                command = f.read().replace(b'\0', b' ').decode('utf-8', errors='replace')
        except (OSError, ValueError):
            self._remove_pid_file()
            return False
        if 'launch' in command:        # the pid may have been reused by something else
            self._append(f'[omorobot_web] stopping {self.name} left from the previous run (pid {pgid})')
            kill_group(pgid)
        self._remove_pid_file()
        return True

    def _remove_pid_file(self):
        try:
            os.remove(self.pid_file)
        except OSError:
            pass

    def log_since(self, seq=0, limit=500):
        with self._lock:
            lines = [entry for entry in self._log if entry[0] > seq]
        return lines[-limit:]

    def _signal(self, proc, sig):
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass

    def _wait(self, proc, timeout):
        try:
            proc.wait(timeout=timeout)
            return True
        except subprocess.TimeoutExpired:
            return False

    def _append(self, text):
        with self._lock:
            self._seq += 1
            self._log.append((self._seq, time.time(), text))

    def _read_output(self, proc):
        for raw in iter(proc.stdout.readline, b''):
            line = ANSI_ESCAPE.sub('', raw.decode('utf-8', errors='replace')).rstrip()
            if line:
                self._append(line)
                if any(pattern in line for pattern in self.alert_patterns):
                    self.alert = line
        proc.stdout.close()
        proc.wait()
        if not self._stopping:
            self.stopped_at = time.monotonic()
            self._remove_pid_file()
            self._append(f'[omorobot_web] {self.name} exited (exit code {proc.returncode})')


class ProcessManager:
    def __init__(self, run_dir, alert_patterns):
        """alert_patterns: {process name: log texts that mean a failed start}"""
        os.makedirs(run_dir, exist_ok=True)
        self.processes = {
            name: ManagedProcess(name, run_dir, alert_patterns=patterns) for name, patterns in alert_patterns.items()}
        for process in self.processes.values():
            process.stop_orphan()

    def __getitem__(self, name):
        return self.processes[name]

    def __contains__(self, name):
        return name in self.processes

    def status(self):
        return {name: proc.status() for name, proc in self.processes.items()}

    def stop_all(self, timeout=4.0):
        # "ros2 launch" gives a node 10 seconds between SIGINT and SIGKILL, be done before
        threads = [
            threading.Thread(target=proc.stop, args=(timeout,)) for proc in self.processes.values() if proc.is_running()]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
