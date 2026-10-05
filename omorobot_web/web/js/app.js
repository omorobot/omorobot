// shell of the web ui: menu on the left, page on the right
import { api, store } from './api.js';
import { h, clear, icon, toast } from './ui.js';
import { teleop } from './teleop.js';
import jobPage from './pages/job.js';
import mappingPage from './pages/mapping.js';
import pointsPage from './pages/points.js';
import editPage from './pages/edit.js';
import mapsPage from './pages/maps.js';
import systemPage from './pages/system.js';

const MENU = [
  { group: 'Job' },
  { route: 'job', label: 'Job 프로그램', icon: 'job', page: jobPage },
  { group: 'Mapping' },
  { route: 'mapping', label: '맵 생성', icon: 'map', page: mappingPage },
  { route: 'edit', label: '맵 수정', icon: 'edit', page: editPage },
  { route: 'maps', label: '맵 관리', icon: 'layers', page: mapsPage },
  { group: 'Navigation' },
  { route: 'points', label: '위치 포인트', icon: 'pin', page: pointsPage },
  { group: '설정' },
  { route: 'system', label: '시스템', icon: 'system', page: systemPage },
];

const MODE_LABEL = { idle: '대기', mapping: '매핑 중', navigation: '내비게이션' };
const JOB_LABEL = { running: '실행 중', paused: '일시 정지', finished: '완료', stopped: '정지됨', error: '오류' };

const menu = document.getElementById('menu');
const page = document.getElementById('page');
const title = document.getElementById('page-title');
const chips = document.getElementById('status-chips');
let current = null;       // {route, unmount, onState}
let lastChips = '';

function buildMenu() {
  clear(menu);
  for (const item of MENU) {
    if (item.group) menu.appendChild(h('div.menu-group', item.group));
    else menu.appendChild(h('a.menu-item', { href: `#/${item.route}`, dataset: { route: item.route } }, icon(item.icon), h('span', item.label)));
  }
}

function navigate() {
  const route = (location.hash.replace(/^#\/?/, '') || 'job').split('/')[0];
  const item = MENU.find((entry) => entry.route === route) || MENU[1];
  if (current && current.route === item.route) return;
  if (current && current.leave && !current.leave()) {
    // the page has unsaved changes and the user stays
    history.replaceState(null, '', `#/${current.route}`);
    return;
  }
  if (current && current.unmount) current.unmount();
  for (const link of menu.querySelectorAll('.menu-item')) link.classList.toggle('active', link.dataset.route === item.route);
  title.textContent = item.label;
  clear(page);
  store.wantScan = false;
  store.wantPath = false;
  const mounted = item.page.mount(page) || {};
  current = { route: item.route, ...mounted };
  if (store.state && current.onState) current.onState(store.state);
}

function chip(text, kind = '') {
  return h(`span.badge${kind ? `.${kind}` : ''}`, text);
}

function updateChips(state, online) {
  const items = [];
  if (!online || !state) {
    items.push(['서버 연결 끊김', 'danger']);
  } else {
    if (state.sim) items.push(['시뮬레이션', 'warn']);
    items.push(state.robot.connected ? ['로봇 연결됨', 'ok'] : ['로봇 연결 안 됨', '']);
    const mode = MODE_LABEL[state.mode] + (state.mode === 'navigation' && state.nav.map ? ` · ${state.nav.map}` : '');
    items.push([mode, state.mode === 'idle' ? '' : 'accent']);
    if (state.mode === 'navigation' && !state.nav.ready) items.push(['내비게이션 준비 중', 'warn']);
    if (state.job.state !== 'idle') {
      const kind = { running: 'ok', paused: 'warn', error: 'danger' }[state.job.state] || '';
      items.push([`Job ${state.job.name} · ${JOB_LABEL[state.job.state]}`, kind]);
    }
    const pose = state.robot.pose;
    if (pose) items.push([`x ${pose.x.toFixed(2)}  y ${pose.y.toFixed(2)}  θ ${Math.round((pose.yaw * 180) / Math.PI)}°${pose.frame === 'odom' ? ' (odom)' : ''}`, 'plain']);
  }
  const signature = JSON.stringify(items);
  if (signature === lastChips) return;
  lastChips = signature;
  clear(chips).append(...items.map(([text, kind]) => chip(text, kind)));
}

document.getElementById('estop').addEventListener('click', async () => {
  teleop.halt();
  try {
    await api.post('/api/estop');
    toast('비상 정지: Job과 이동 명령을 모두 중단했습니다.', 'error');
  } catch (error) {
    toast(error.message, 'error');
  }
});

store.subscribe((state, online) => {
  updateChips(state, online);
  if (state) {
    document.getElementById('brand-model').textContent = state.robot.model;
    if (current && current.onState) current.onState(state);
  }
});

window.addEventListener('hashchange', navigate);
window.addEventListener('beforeunload', (event) => {
  if (current && current.dirty && current.dirty()) event.preventDefault();
});

buildMenu();
navigate();
store.start();
