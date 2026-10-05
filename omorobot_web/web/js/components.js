// parts shared by the pages
import { api, mapPath, store, LIVE_MAP } from './api.js';
import { h, clear, select, toast, formatTime } from './ui.js';
import { MapView, MapSource } from './mapview.js';

const SELECTED_MAP = 'omorobot.map';

export function rememberMap(name) {
  try {
    localStorage.setItem(SELECTED_MAP, name);
  } catch (error) {
    // private mode
  }
}

export function rememberedMap() {
  try {
    return localStorage.getItem(SELECTED_MAP) || '';
  } catch (error) {
    return '';
  }
}

export async function fetchMaps() {
  const { maps } = await api.get('/api/maps');
  return maps;
}

// <select> of the saved maps, optionally with the map in the making
export class MapSelector {
  constructor({ onchange, allowLive = false }) {
    this.onchange = onchange;
    this.allowLive = allowLive;
    this.maps = [];
    this.value = '';
    this.live = false;
    this.element = h('select', { title: '맵 선택', onchange: () => this.pick(this.element.value) });
  }

  async load(preferred = '') {
    this.maps = await fetchMaps();
    const names = this.maps.map((map) => map.name);
    const wanted = preferred || this.value || rememberedMap();
    let value = names.includes(wanted) ? wanted : (names[0] || '');
    if (this.allowLive && this.live && (wanted === LIVE_MAP || !value)) value = LIVE_MAP;
    this.render(value);
    this.pick(value, true);
  }

  setLive(live) {
    if (!this.allowLive || live === this.live) return;
    this.live = live;
    if (!live && this.value === LIVE_MAP) this.load();
    else this.render(this.value);
  }

  render(value) {
    clear(this.element);
    if (this.allowLive && this.live) this.element.appendChild(h('option', { value: LIVE_MAP }, '매핑 중인 맵 (저장 전)'));
    for (const map of this.maps) this.element.appendChild(h('option', { value: map.name }, map.name));
    if (!this.element.options.length) this.element.appendChild(h('option', { value: '' }, '저장된 맵 없음'));
    this.element.value = value;
  }

  pick(value, force = false) {
    if (value === this.value && !force) return;
    this.value = value;
    if (value && value !== LIVE_MAP) rememberMap(value);
    this.onchange(value, this.meta());
  }

  meta() {
    return this.maps.find((map) => map.name === this.value) || null;
  }
}

// MapView that follows a saved map or the live map and draws the robot when it is localized in that map
export class RobotMap {
  constructor(parent, options = {}) {
    this.view = new MapView(parent, options);
    this.source = new MapSource(this.view);
    this.name = '';
    this.meta = null;
    this.showScan = options.showScan !== false;
  }

  destroy() {
    this.view.destroy();
  }

  // name: saved map name or LIVE_MAP
  setMap(name, meta = null) {
    if (name !== this.name) this.source.clear('');
    this.name = name;
    this.meta = meta;
    if (name && name !== LIVE_MAP && meta) {
      this.source.show(`${name}:${meta.version}`, `${mapPath(name)}/image.png?v=${meta.version}`, meta);
    } else if (!name) {
      this.source.clear('저장된 맵이 없습니다. 먼저 맵을 생성하세요.');
    }
  }

  // true when the pose of the robot is valid in the shown map
  localized(state) {
    const pose = state.robot.pose;
    if (!pose || pose.frame !== 'map') return false;
    // the map in the making belongs to the mapping, the map frame of the navigation is another one
    if (this.name === LIVE_MAP) return state.mode === 'mapping';
    return Boolean(this.name) && state.map_name === this.name;
  }

  update(state, emptyMessage = '수신된 맵이 없습니다.') {
    if (this.name === LIVE_MAP) {
      if (state.map.available) this.source.show(`live:${state.map.version}`, `/api/map/live.png?v=${state.map.version}`, state.map);
      else this.source.clear(emptyMessage);
    }
    const localized = this.localized(state);
    const task = state.nav.task;
    const active = task && (task.status === 'active' || task.status === 'pending');
    this.view.setLayers({
      robot: localized ? state.robot.pose : null,
      scan: localized && this.showScan ? (state.scan || []) : [],
      path: localized && active && state.path ? state.path.points : [],
      goal: localized && active ? { ...task.goal, via: task.via } : null,
    });
    return localized;
  }
}

// digital inputs / outputs
export class IoPanel {
  constructor() {
    this.labels = null;
    this.signature = '';
    this.inputs = h('div.io-grid');
    this.outputs = h('div.io-grid');
    this.element = h('div.stack',
      h('div', h('div.label', { style: 'margin-bottom:4px' }, '출력 (DO) · 클릭하여 ON/OFF'), this.outputs),
      h('div', h('div.label', { style: 'margin-bottom:4px' }, '입력 (DI) · 클릭하면 테스트용 강제 입력'), this.inputs));
    this.loadLabels();
  }

  async loadLabels() {
    try {
      const { settings } = await api.get('/api/settings');
      this.labels = settings.io;
      this.signature = '';
      if (store.state) this.update(store.state.io);
    } catch (error) {
      // channel numbers are shown
    }
  }

  update(io) {
    const signature = JSON.stringify(io);
    if (signature === this.signature) return;
    this.signature = signature;
    const cell = (kind, index, value) => {
      const names = this.labels ? this.labels[`${kind}_labels`] : [];
      const name = names[index] || `${kind === 'din' ? 'DI' : 'DO'}${index + 1}`;
      return h(`div.io${value ? '.on' : ''}`, {
        role: 'button',
        title: `${kind === 'din' ? 'DI' : 'DO'}${index + 1} ${name}`,
        onclick: () => api.post(`/api/io/${kind}`, { channel: index + 1, value: value ? 0 : 1 })
          .then(() => store.refresh())
          .catch((error) => toast(error.message, 'error')),
      }, h('span.lamp'), h('span.name', name));
    };
    clear(this.outputs).append(...io.dout.map((value, index) => cell('dout', index, value)));
    clear(this.inputs).append(...io.din.map((value, index) => cell('din', index, value)));
  }
}

// log window fed by an api with ?since=
export class LogView {
  constructor(path, { tall = false } = {}) {
    this.path = path;
    this.seq = 0;
    this.loading = false;
    this.element = h(`div.log${tall ? '.tall' : ''}`);
  }

  setPath(path) {
    this.path = path;
    this.seq = 0;
    clear(this.element);
  }

  // latest: sequence number of the newest line known from the state
  async update(latest) {
    if (latest < this.seq) {
      this.seq = 0;
      clear(this.element);
    }
    if (latest === this.seq || this.loading) return;
    this.loading = true;
    const path = this.path;
    try {
      const { lines } = await api.get(`${path}?since=${this.seq}`);
      if (path !== this.path) return;
      const bottom = this.element.scrollHeight - this.element.scrollTop - this.element.clientHeight < 30;
      for (const line of lines) {
        this.element.appendChild(h(`div${line.level ? `.${line.level}` : ''}`, h('span.time', `${formatTime(line.time)}  `), line.text));
        this.seq = line.seq;
      }
      if (!lines.length) this.seq = latest;
      while (this.element.children.length > 600) this.element.removeChild(this.element.firstChild);
      if (bottom) this.element.scrollTop = this.element.scrollHeight;
    } catch (error) {
      // next state update tries again
    } finally {
      this.loading = false;
    }
  }
}

export function pointTypeLabel(type) {
  return type === 'waypoint' ? '경유점' : '정지 위치';
}

export function pointTypeSelect(value, onchange) {
  return select([['stop', '정지 위치 (정지 + 방향 맞춤)'], ['waypoint', '경유점 (waypoint, 통과)']], value, onchange);
}
