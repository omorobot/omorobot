// 시스템: processes started by the web server, logs and io
import { api, store } from '../api.js';
import { h, clear, button, toast, formatTime } from '../ui.js';
import { IoPanel, LogView } from '../components.js';

const PROCESSES = [
  ['bringup', '로봇 Bringup', '모터 드라이버, LiDAR, 로봇 모델 (omorobot_bringup)'],
  ['cartographer', 'Cartographer', '맵 생성 SLAM (omorobot_cartographer)'],
  ['navigation', 'Navigation2', '위치 추정과 자율 주행 (omorobot_navigation2)'],
];
const STATE_LABEL = { running: ['실행 중', 'ok'], stopping: ['종료 중', 'warn'], stopped: ['정지', ''] };

function mount(root) {
  const rows = {};
  let logName = 'bringup';
  const log = new LogView('/api/process/bringup/log', { tall: true });
  const logTabs = h('div.tabs', PROCESSES.map(([name, label]) => h(`button.tab${name === logName ? '.active' : ''}`, {
    type: 'button',
    dataset: { name },
    onclick: () => {
      logName = name;
      for (const tab of logTabs.children) tab.classList.toggle('active', tab.dataset.name === name);
      log.setPath(`/api/process/${name}/log`);
      if (store.state) log.update(store.state.processes[name].log_seq);
    },
  }, label)));

  const processCard = h('div.card.stack', h('h3', '프로세스'),
    h('p.muted.small-text', '매핑·내비게이션을 시작하면 필요한 프로세스가 자동으로 실행됩니다. 문제가 있을 때 이곳에서 직접 제어하고 로그를 확인하세요.'),
    PROCESSES.map(([name, label, description]) => {
      const badge = h('span.badge', '정지');
      const detail = h('div.sub');
      const start = name === 'navigation' ? null : button('시작', { small: true, iconName: 'play', onclick: () => act(name, 'start') });
      const stop = button('종료', { small: true, iconName: 'stop', onclick: () => act(name, 'stop') });
      rows[name] = { badge, detail, start, stop };
      return h('div.list-item', { style: 'cursor:default;align-items:flex-start' },
        h('div.grow', h('div.inline', h('span.title', label), badge), h('div.sub', description), detail),
        h('div.inline', start, stop));
    }));

  const io = new IoPanel();
  const labelEditor = h('div.stack');
  const info = h('dl.kv');
  root.appendChild(h('div.stack', { style: 'gap:14px' },
    h('div.system-grid',
      processCard,
      h('div.card.stack', h('h3', '디지털 입출력 (I/O)'), io.element,
        h('p.muted.small-text', '출력은 ROS 토픽 /io/digital_out, 입력은 /io/digital_in (std_msgs/UInt8MultiArray) 으로 연결됩니다.')),
      h('div.card.stack', h('h3', '정보'), info)),
    h('div.card', h('h3', '로그'), logTabs, log.element),
    h('div.card.stack', h('h3', 'I/O 이름'), h('p.muted.small-text', 'Job 편집과 I/O 패널에 표시되는 채널 이름입니다.'), labelEditor)));
  loadLabels();

  async function act(name, action) {
    await api.post(`/api/process/${name}/${action}`);
    await store.refresh();
  }

  async function loadLabels() {
    let settings;
    try {
      ({ settings } = await api.get('/api/settings'));
    } catch (error) {
      toast(error.message, 'error');
      return;
    }
    const inputs = { din_labels: [], dout_labels: [] };
    const column = (key, title, prefix) => h('div.stack', { style: 'gap:6px' }, h('div.label', title),
      settings.io[key].map((value, index) => {
        const input = h('input', { type: 'text', value, maxLength: 16, 'aria-label': `${prefix}${index + 1} 이름` });
        inputs[key].push(input);
        return h('div.inline', h('span.mono.muted', { style: 'width:34px' }, `${prefix}${index + 1}`), input);
      }));
    clear(labelEditor).append(
      h('div.field-row', column('dout_labels', '출력 (DO)', 'DO'), column('din_labels', '입력 (DI)', 'DI')),
      h('div', button('이름 저장', {
        kind: 'primary',
        iconName: 'save',
        onclick: async () => {
          const values = {};
          for (const key of Object.keys(inputs)) {
            values[key] = inputs[key].map((input, index) => input.value.trim() || `${key === 'din_labels' ? 'DI' : 'DO'}${index + 1}`);
          }
          await api.put('/api/settings', { io: values });
          await io.loadLabels();
          toast('I/O 이름을 저장했습니다.', 'ok');
        },
      })));
  }

  function onState(state) {
    for (const [name] of PROCESSES) {
      const process = state.processes[name];
      const row = rows[name];
      let [text, kind] = STATE_LABEL[process.state] || STATE_LABEL.stopped;
      if (process.external) [text, kind] = ['외부 실행 중', 'accent'];
      if (process.alert && process.state === 'running') [text, kind] = ['오류', 'danger'];
      row.badge.textContent = text;
      row.badge.className = `badge ${kind}`;
      let detail = '';
      if (process.external) detail = '터미널 등 외부에서 실행되었습니다. 종료는 실행한 곳에서 하세요.';
      else if (process.alert) detail = process.alert;
      else if (process.state === 'running') detail = `${formatTime(process.started_at)} 시작${process.info.map ? ` · 맵 ${process.info.map}` : ''}`;
      else if (process.exit_code !== null && process.exit_code !== 0) detail = `종료 코드 ${process.exit_code}`;
      row.detail.textContent = detail;
      if (row.start) row.start.disabled = process.state !== 'stopped' || process.external || row.start.classList.contains('busy');
      row.stop.disabled = process.state !== 'running' || row.stop.classList.contains('busy');
    }
    io.update(state.io);
    log.update(state.processes[logName].log_seq);
    const entries = [
      ['로봇 모델', state.robot.model],
      ['동작 모드', state.sim ? '시뮬레이션 (가상 로봇)' : '실제 로봇'],
      ['로봇 연결', state.robot.connected ? '연결됨 (odom 수신 중)' : '연결 안 됨'],
      ['최대 속도', `${state.robot.limits.lin} m/s, ${state.robot.limits.ang} rad/s`],
      ['현재 맵', state.map_name || '-'],
    ];
    const signature = JSON.stringify(entries);
    if (info.dataset.signature !== signature) {
      info.dataset.signature = signature;
      clear(info).append(...entries.flatMap(([key, value]) => [h('dt', key), h('dd', value)]));
    }
  }

  return { onState };
}

export default { mount };
