// http api of the web server

async function request(method, path, body, raw) {
  const options = { method, headers: {} };
  if (raw) {
    options.body = raw;
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, options);
  } catch (error) {
    throw new Error('서버에 연결할 수 없습니다.');
  }
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }
  if (!response.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || `요청 실패 (${response.status})`);
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
  upload: (path, data) => request('POST', path, undefined, data),
};

export const mapPath = (name) => `/api/maps/${encodeURIComponent(name)}`;
export const jobPath = (name) => `/api/jobs/${encodeURIComponent(name)}`;

export const LIVE_MAP = '__live__';

// latest state of the robot, polled from the server
class Store {
  constructor() {
    this.state = null;
    this.online = false;
    this.listeners = new Set();
    this.wantScan = false;
    this.wantPath = false;
    this.period = 200;
    this.timer = null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    if (this.state) listener(this.state);
    return () => this.listeners.delete(listener);
  }

  start() {
    const tick = async () => {
      if (!document.hidden) await this.refresh();
      this.timer = setTimeout(tick, this.online ? this.period : 1500);
    };
    tick();
  }

  async refresh() {
    const query = `?scan=${this.wantScan ? 1 : 0}&path=${this.wantPath ? 1 : 0}`;
    try {
      const response = await fetch(`/api/state${query}`);
      this.state = await response.json();
      this.online = true;
    } catch (error) {
      this.online = false;
    }
    for (const listener of this.listeners) {
      try {
        listener(this.state, this.online);
      } catch (error) {
        console.error(error);
      }
    }
  }
}

export const store = new Store();
