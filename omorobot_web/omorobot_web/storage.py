import io
import json
import os
import re
import shutil
import threading
import time
import uuid
import zipfile

import numpy as np
import yaml
from PIL import Image

NAME_PATTERN = re.compile(r'^[0-9A-Za-z가-힣_\-]{1,40}$')
POINT_TYPES = ('stop', 'waypoint')
# tolerance of a stop position: (key, lowest, highest, name), not set = default of the navigation
POINT_TOLERANCES = (
    ('xy_tol', 0.01, 1.0, '위치 허용 오차는 1~100 cm'),
    ('yaw_tol', 0.0174, 3.1416, '각도 허용 오차는 1~180°'),
)

# pgm gray levels used by nav2 map_server (trinary mode)
GRAY_OCCUPIED = 0
GRAY_UNKNOWN = 205
GRAY_FREE = 254

DEFAULT_SETTINGS = {
    'teleop': {'lin_vel': 0.05, 'ang_vel': 0.1, 'mode': 'step'},
    'io': {
        'din_labels': [f'DI{i + 1}' for i in range(8)],
        'dout_labels': [f'DO{i + 1}' for i in range(8)],
    },
}


class StorageError(Exception):
    pass


def check_name(name):
    if not isinstance(name, str) or not NAME_PATTERN.match(name):
        raise StorageError('이름은 한글/영문/숫자/_/- 만 사용하여 40자 이내로 입력하세요.')
    return name


def write_json(path, data):
    tmp = f'{path}.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except (OSError, ValueError) as e:
        raise StorageError(f'파일을 읽을 수 없습니다: {path} ({e})')


def new_id(prefix):
    return f'{prefix}_{uuid.uuid4().hex[:8]}'


def clean_points(points):
    if not isinstance(points, list):
        raise StorageError('포인트 목록 형식이 올바르지 않습니다.')
    cleaned, names, ids = [], set(), set()
    has_start = False
    for point in points:
        try:
            name = str(point['name']).strip()
            item = {
                'id': str(point.get('id') or new_id('p')),
                'name': name,
                'type': point.get('type', 'stop'),
                'x': round(float(point['x']), 3),
                'y': round(float(point['y']), 3),
                'yaw': round(float(point.get('yaw', 0.0)), 4),
            }
            tolerances = {
                key: float(point[key]) for key, _, _, _ in POINT_TOLERANCES if point.get(key) not in (None, '')}
        except (KeyError, TypeError, ValueError):
            raise StorageError('포인트 데이터 형식이 올바르지 않습니다.')
        for key, low, high, message in POINT_TOLERANCES:
            if key in tolerances:
                if not low <= tolerances[key] <= high:
                    raise StorageError(f'{message} 범위로 입력하세요. ({name})')
                item[key] = round(tolerances[key], 4)
        if not name or len(name) > 40:
            raise StorageError('포인트 이름은 1~40자로 입력하세요.')
        if item['type'] not in POINT_TYPES:
            raise StorageError(f'알 수 없는 포인트 종류입니다: {item["type"]}')
        if name in names:
            raise StorageError(f'포인트 이름이 중복됩니다: {name}')
        # start position: where the robot stands when it is switched on, one stop position of a map
        if point.get('start') is True and item['type'] == 'stop' and not has_start:
            item['start'] = True
            has_start = True
        if item['id'] in ids:
            item['id'] = new_id('p')
        names.add(name)
        ids.add(item['id'])
        cleaned.append(item)
    return cleaned


def grid_to_gray(data, width, height, trinary=True, free_thresh=0.25, occupied_thresh=0.65):
    """OccupancyGrid data (row 0 = bottom) to an image array (row 0 = top)."""
    grid = np.asarray(data, dtype=np.int8).reshape(height, width)
    gray = np.full(grid.shape, GRAY_UNKNOWN, dtype=np.uint8)
    known = grid >= 0
    if trinary:
        gray[known & (grid <= free_thresh * 100.0)] = GRAY_FREE
        gray[known & (grid >= occupied_thresh * 100.0)] = GRAY_OCCUPIED
    else:
        # probabilities of a map in the making, brightened to tell free from occupied
        shade = np.rint((1.0 - (grid.astype(np.float32) / 100.0) ** 2.2) * GRAY_FREE).astype(np.uint8)
        shade[shade == GRAY_UNKNOWN] = GRAY_UNKNOWN + 1
        gray[known] = shade[known]
    return np.flipud(gray)


def gray_to_png(gray):
    buffer = io.BytesIO()
    Image.fromarray(gray, mode='L').save(buffer, format='PNG', compress_level=3)
    return buffer.getvalue()


def quantize(gray):
    """Snap every pixel to occupied / unknown / free."""
    out = np.full(gray.shape, GRAY_UNKNOWN, dtype=np.uint8)
    out[gray < 100] = GRAY_OCCUPIED
    out[gray > 230] = GRAY_FREE
    return out


class MapStore:
    IMAGE = 'map.pgm'
    YAML = 'map.yaml'
    ORIGINAL = 'map.orig.pgm'
    POINTS = 'points.json'

    def __init__(self, root):
        self.root = os.path.join(root, 'maps')
        self.active = os.path.join(root, 'active_map')
        os.makedirs(self.root, exist_ok=True)
        self._lock = threading.RLock()

    def activate(self, name):
        """Copy the map to a fixed ascii path, nav2 can not take a path with korean letters."""
        self.require(name)
        with self._lock:
            os.makedirs(self.active, exist_ok=True)
            for filename in (self.IMAGE, self.YAML):
                shutil.copyfile(self.path(name, filename), os.path.join(self.active, filename))
        return os.path.join(self.active, self.YAML)

    def path(self, name, filename=''):
        return os.path.join(self.root, check_name(name), filename)

    def yaml_path(self, name):
        return self.path(name, self.YAML)

    def exists(self, name):
        return os.path.isfile(self.yaml_path(name))

    def require(self, name):
        if not self.exists(name):
            raise StorageError(f'맵을 찾을 수 없습니다: {name}')

    def names(self):
        found = []
        for entry in sorted(os.listdir(self.root)):
            if NAME_PATTERN.match(entry) and os.path.isfile(os.path.join(self.root, entry, self.YAML)):
                found.append(entry)
        return found

    def list(self):
        maps = []
        for name in self.names():
            try:
                maps.append(self.meta(name))
            except StorageError:
                continue
        return maps

    def meta(self, name):
        self.require(name)
        with open(self.yaml_path(name), 'r', encoding='utf-8') as f:
            info = yaml.safe_load(f) or {}
        image_path = self.path(name, self.IMAGE)
        try:
            with Image.open(image_path) as image:
                width, height = image.size
            modified = os.path.getmtime(image_path)
        except OSError as e:
            raise StorageError(f'맵 이미지를 읽을 수 없습니다: {name} ({e})')
        origin = info.get('origin', [0.0, 0.0, 0.0])
        return {
            'name': name,
            'width': width,
            'height': height,
            'resolution': float(info.get('resolution', 0.05)),
            'origin': [float(origin[0]), float(origin[1])],
            'modified': modified,
            'version': int(modified * 1000),
            'edited': os.path.isfile(self.path(name, self.ORIGINAL)),
            'points': len(self.points(name)),
            'yaml': self.yaml_path(name),
        }

    def gray(self, name):
        self.require(name)
        with Image.open(self.path(name, self.IMAGE)) as image:
            return np.array(image.convert('L'), dtype=np.uint8)

    def image_png(self, name):
        return gray_to_png(self.gray(name))

    def _write(self, name, gray, resolution, origin):
        directory = self.path(name)
        os.makedirs(directory, exist_ok=True)
        self._write_image(name, gray)
        info = {
            'image': self.IMAGE,
            'mode': 'trinary',
            'resolution': round(float(resolution), 6),
            'origin': [round(float(origin[0]), 4), round(float(origin[1]), 4), 0.0],
            'negate': 0,
            'occupied_thresh': 0.65,
            'free_thresh': 0.25,
        }
        tmp = self.yaml_path(name) + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            yaml.safe_dump(info, f, default_flow_style=None, sort_keys=False)
        os.replace(tmp, self.yaml_path(name))

    def _write_image(self, name, gray):
        height, width = gray.shape
        tmp = self.path(name, self.IMAGE) + '.tmp'
        with open(tmp, 'wb') as f:
            f.write(f'P5\n{width} {height}\n255\n'.encode('ascii'))
            f.write(np.ascontiguousarray(gray, dtype=np.uint8).tobytes())
        os.replace(tmp, self.path(name, self.IMAGE))

    def save_grid(self, name, data, width, height, resolution, origin, points=None):
        """Save a live OccupancyGrid as a new map (replaces an existing map of the same name)."""
        check_name(name)
        with self._lock:
            gray = grid_to_gray(data, width, height, trinary=True)
            original = self.path(name, self.ORIGINAL)
            if os.path.isfile(original):
                os.remove(original)
            self._write(name, gray, resolution, origin)
            if points is not None:
                self.set_points(name, points)
        return self.meta(name)

    def save_pixels(self, name, pixels, width, height):
        """Save an edited image. The first edit keeps the original for restore."""
        self.require(name)
        meta = self.meta(name)
        if width != meta['width'] or height != meta['height'] or len(pixels) != width * height:
            raise StorageError('이미지 크기가 맵과 일치하지 않습니다.')
        gray = quantize(np.frombuffer(pixels, dtype=np.uint8).reshape(height, width))
        with self._lock:
            original = self.path(name, self.ORIGINAL)
            if not os.path.isfile(original):
                shutil.copyfile(self.path(name, self.IMAGE), original)
            self._write_image(name, gray)
        return self.meta(name)

    def restore_original(self, name):
        self.require(name)
        original = self.path(name, self.ORIGINAL)
        if not os.path.isfile(original):
            raise StorageError('수정 이력이 없습니다.')
        with self._lock:
            os.replace(original, self.path(name, self.IMAGE))
        return self.meta(name)

    def points(self, name):
        return read_json(self.path(name, self.POINTS), default=[]) or []

    def start_pose(self, name):
        """(x, y, yaw) of the start position of the map, None: not set."""
        for point in self.points(name):
            if point.get('start'):
                return (point['x'], point['y'], point['yaw'])
        return None

    def set_points(self, name, points):
        self.require(name)
        cleaned = clean_points(points)
        with self._lock:
            write_json(self.path(name, self.POINTS), cleaned)
        return cleaned

    def rename(self, name, new_name):
        self.require(name)
        check_name(new_name)
        if os.path.exists(self.path(new_name)):
            raise StorageError(f'이미 존재하는 이름입니다: {new_name}')
        with self._lock:
            os.rename(self.path(name), self.path(new_name))
        return self.meta(new_name)

    def duplicate(self, name, new_name):
        self.require(name)
        check_name(new_name)
        if os.path.exists(self.path(new_name)):
            raise StorageError(f'이미 존재하는 이름입니다: {new_name}')
        with self._lock:
            shutil.copytree(self.path(name), self.path(new_name))
        return self.meta(new_name)

    def delete(self, name):
        self.require(name)
        with self._lock:
            shutil.rmtree(self.path(name))

    def import_files(self, name, yaml_bytes, image_bytes):
        check_name(name)
        if os.path.exists(self.path(name)):
            raise StorageError(f'이미 존재하는 이름입니다: {name}')
        try:
            info = yaml.safe_load(yaml_bytes.decode('utf-8')) or {}
            resolution = float(info['resolution'])
            origin = [float(v) for v in info['origin'][:2]]
        except (KeyError, TypeError, ValueError, UnicodeDecodeError, yaml.YAMLError):
            raise StorageError('yaml 파일에서 resolution/origin 을 읽을 수 없습니다.')
        try:
            with Image.open(io.BytesIO(image_bytes)) as image:
                gray = np.array(image.convert('L'), dtype=np.uint8)
        except (OSError, ValueError):
            raise StorageError('맵 이미지(pgm/png)를 읽을 수 없습니다.')
        if int(info.get('negate', 0)):
            gray = 255 - gray
        with self._lock:
            self._write(name, quantize(gray), resolution, origin)
        return self.meta(name)

    def archive(self, name):
        self.require(name)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
            for filename in (self.IMAGE, self.YAML, self.POINTS):
                path = self.path(name, filename)
                if os.path.isfile(path):
                    archive.write(path, arcname=f'{name}/{filename}')
        buffer.seek(0)
        return buffer


class JobStore:
    def __init__(self, root):
        self.root = os.path.join(root, 'jobs')
        os.makedirs(self.root, exist_ok=True)
        self._lock = threading.RLock()

    def path(self, name):
        return os.path.join(self.root, check_name(name) + '.json')

    def exists(self, name):
        return os.path.isfile(self.path(name))

    def list(self):
        jobs = []
        for entry in sorted(os.listdir(self.root)):
            name, ext = os.path.splitext(entry)
            if ext != '.json' or not NAME_PATTERN.match(name):
                continue
            try:
                job = self.get(name)
            except StorageError:
                continue
            jobs.append({
                'name': name,
                'map': job.get('map', ''),
                'description': job.get('description', ''),
                'steps': count_steps(job.get('steps', [])),
                'modified': os.path.getmtime(self.path(name)),
            })
        return jobs

    def get(self, name):
        job = read_json(self.path(name))
        if job is None:
            raise StorageError(f'Job을 찾을 수 없습니다: {name}')
        job['name'] = name
        return job

    def save(self, name, job):
        check_name(name)
        if not isinstance(job, dict) or not isinstance(job.get('steps', []), list):
            raise StorageError('Job 형식이 올바르지 않습니다.')
        data = {
            'name': name,
            'map': str(job.get('map', '')),
            'description': str(job.get('description', ''))[:200],
            'steps': job.get('steps', []),
            'saved_at': time.time(),
        }
        with self._lock:
            write_json(self.path(name), data)
        return data

    def rename(self, name, new_name):
        job = self.get(name)
        if self.exists(new_name):
            raise StorageError(f'이미 존재하는 이름입니다: {new_name}')
        with self._lock:
            self.save(new_name, job)
            os.remove(self.path(name))
        return self.get(new_name)

    def duplicate(self, name, new_name):
        job = self.get(name)
        if self.exists(new_name):
            raise StorageError(f'이미 존재하는 이름입니다: {new_name}')
        return self.save(new_name, job)

    def delete(self, name):
        if not self.exists(name):
            raise StorageError(f'Job을 찾을 수 없습니다: {name}')
        with self._lock:
            os.remove(self.path(name))

    def rename_map(self, old_map, new_map):
        for entry in self.list():
            if entry['map'] == old_map:
                job = self.get(entry['name'])
                job['map'] = new_map
                self.save(entry['name'], job)


def count_steps(steps):
    total = 0
    for step in steps:
        total += 1
        for key in ('then', 'else', 'steps'):
            total += count_steps(step.get(key) or [])
    return total


class SettingsStore:
    def __init__(self, root, teleop=None):
        """teleop: defaults of the robot model in place of DEFAULT_SETTINGS"""
        self.file = os.path.join(root, 'settings.json')
        self.defaults = json.loads(json.dumps(DEFAULT_SETTINGS))
        self.defaults['teleop'].update(teleop or {})
        self._lock = threading.RLock()

    def get(self):
        stored = read_json(self.file, default={}) or {}
        settings = json.loads(json.dumps(self.defaults))
        for section, values in stored.items():
            if section in settings and isinstance(values, dict):
                settings[section].update(values)
        return settings

    def update(self, changes):
        settings = self.get()
        for section, values in (changes or {}).items():
            if section in settings and isinstance(values, dict):
                settings[section].update(values)
        with self._lock:
            write_json(self.file, settings)
        return settings
