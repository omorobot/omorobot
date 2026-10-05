// Mapping > 맵 생성: drive the robot and build the map
import { api, store, LIVE_MAP } from '../api.js';
import { h, clear, button, toast, formDialog, confirmDialog, field } from '../ui.js';
import { RobotMap, fetchMaps, rememberMap, pointTypeLabel } from '../components.js';
import { teleop } from '../teleop.js';

function mount(root) {
  const frame = h('div.map-frame');
  const modeBadge = h('span.badge', '대기');
  const sizeText = h('span.muted.small-text');
  const resetButton = button('맵 초기화', { iconName: 'refresh', small: true, title: '화면의 맵을 지우고 처음부터 다시 시작', onclick: reset });
  frame.appendChild(h('div.map-toolbar', modeBadge, sizeText,
    h('span.right.muted.small-text', '드래그: 이동 · 휠: 확대/축소'), resetButton));
  const map = new RobotMap(frame);
  map.setMap(LIVE_MAP);

  const notice = h('div.notice', { hidden: true });
  const startButton = button('매핑 시작', { kind: 'primary', iconName: 'play', onclick: start });
  const stopButton = button('매핑 종료', { iconName: 'stop', onclick: stop });
  const nameInput = h('input', { type: 'text', placeholder: '예: office_1f', maxLength: 40 });
  const saveButton = button('맵 저장', { kind: 'primary', iconName: 'save', onclick: save });
  const saved = h('p.muted.small-text');
  const pointList = h('div.list');
  const addPointButton = button('현재 위치를 포인트로 추가', { iconName: 'pin', onclick: addPoint });
  let points = [];
  let mode = '';
  let canSave = false;

  const side = h('div.side',
    h('div.card.stack',
      h('h3', '1. 매핑'),
      h('p.muted.small-text', '매핑을 시작한 뒤 가상 키보드로 로봇을 천천히 움직여 맵을 만듭니다. 로봇의 시작 위치가 맵의 원점이 됩니다.'),
      notice,
      h('div.inline', startButton, stopButton),
    ),
    h('div.card.stack',
      h('h3', '2. 위치 포인트 (선택)'),
      h('p.muted.small-text', '매핑 중 로봇이 서 있는 위치를 포인트로 등록합니다. 맵 저장 시 함께 저장되며, 저장 후에는 "위치 포인트" 메뉴에서 수정할 수 있습니다.'),
      addPointButton,
      pointList,
    ),
    h('div.card.stack',
      h('h3', '3. 맵 저장'),
      field('맵 이름', nameInput),
      saveButton,
      saved,
    ),
  );
  root.appendChild(h('div.workspace', frame, side));
  store.wantScan = true;
  loadPoints();

  async function loadPoints() {
    try {
      ({ points } = await api.get(`/api/maps/${LIVE_MAP}/points`));
    } catch (error) {
      points = [];
    }
    renderPoints();
  }

  function renderPoints() {
    map.view.setPoints(points);
    clear(pointList);
    if (!points.length) {
      pointList.appendChild(h('div.muted.small-text', '등록된 포인트가 없습니다.'));
      return;
    }
    for (const point of points) {
      pointList.appendChild(h('div.list-item', { style: 'cursor:default' },
        h(`span.dot.${point.type}`),
        h('div.grow', h('div.title', point.name), h('div.sub', `${pointTypeLabel(point.type)} · x ${point.x.toFixed(2)}, y ${point.y.toFixed(2)}`)),
        button('', { iconName: 'trash', small: true, title: '삭제', onclick: () => savePoints(points.filter((item) => item.id !== point.id)) })));
    }
  }

  async function savePoints(next) {
    ({ points } = await api.put(`/api/maps/${LIVE_MAP}/points`, { points: next }));
    renderPoints();
  }

  async function start() {
    const state = store.state;
    if (state && state.job.state === 'running') {
      const yes = await confirmDialog('매핑 시작', '실행 중인 Job이 정지됩니다. 계속할까요?', { confirm: '매핑 시작' });
      if (!yes) return;
    } else if (state && state.mode === 'navigation') {
      const yes = await confirmDialog('매핑 시작', '내비게이션이 종료되고 새 맵 작성을 시작합니다. 계속할까요?', { confirm: '매핑 시작' });
      if (!yes) return;
    }
    await api.post('/api/mapping/start');
    saved.textContent = '';
    map.view.fitted = false;
    teleop.setOpen(true);
    map.view.setFollow(false);
    toast('매핑을 시작했습니다. 가상 키보드로 로봇을 움직이세요.', 'ok');
    await loadPoints();
    await store.refresh();
  }

  async function stop() {
    if (canSave && !saved.textContent) {
      const yes = await confirmDialog('매핑 종료', '아직 맵을 저장하지 않았습니다. 종료 후에도 새 매핑을 시작하기 전까지는 저장할 수 있습니다.', { confirm: '매핑 종료' });
      if (!yes) return;
    }
    await api.post('/api/mapping/stop');
    await store.refresh();
  }

  async function reset() {
    const mapping = mode === 'mapping';
    let message = mapping
      ? '지금까지 만든 맵을 버리고 로봇의 현재 위치에서 매핑을 처음부터 다시 시작합니다.'
      : '화면의 맵과 등록한 포인트를 지웁니다.';
    if (canSave && !saved.textContent) message += ' 저장하지 않은 맵은 되돌릴 수 없습니다.';
    else message += ' 저장한 맵은 그대로 남습니다.';
    const yes = await confirmDialog('맵 초기화', message, { confirm: '초기화', danger: true });
    if (!yes) return;
    if (mapping) teleop.stop();
    await api.post('/api/mapping/reset');
    saved.textContent = '';
    map.view.fitted = false;
    toast(mapping ? '맵을 초기화하고 매핑을 다시 시작했습니다.' : '맵을 초기화했습니다.', 'ok');
    await loadPoints();
    await store.refresh();
  }

  async function save() {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      throw new Error('맵 이름을 입력하세요.');
    }
    const exists = (await fetchMaps()).some((item) => item.name === name);
    if (exists) {
      const yes = await confirmDialog('맵 덮어쓰기', `"${name}" 맵이 이미 있습니다. 맵과 포인트를 덮어쓸까요?`, { confirm: '덮어쓰기', danger: true });
      if (!yes) return;
    }
    const result = await api.post('/api/mapping/save', { name, overwrite: exists });
    rememberMap(name);
    saved.textContent = `저장됨: ${name} (${result.map.width}×${result.map.height}, 포인트 ${result.map.points}개)`;
    toast(`맵 "${name}" 을(를) 저장했습니다.`, 'ok');
  }

  async function addPoint() {
    const pose = store.state && store.state.robot.pose;
    if (!pose || pose.frame !== 'map') throw new Error('로봇 위치를 알 수 없습니다. 매핑 중에만 추가할 수 있습니다.');
    const values = await formDialog('현재 위치를 포인트로 추가', [
      { name: 'name', label: '포인트 이름', value: `P${points.length + 1}` },
      { name: 'type', label: '종류', type: 'select', value: 'stop', options: [['stop', '정지 위치'], ['waypoint', '경유점 (waypoint)']] },
    ], { confirm: '추가' });
    if (!values) return;
    const now = store.state.robot.pose;
    await savePoints([...points, { name: values.name, type: values.type, x: now.x, y: now.y, yaw: now.yaw }]);
  }

  function onState(state) {
    const empty = {
      mapping: '맵 수신 대기 중…',
      navigation: '내비게이션 실행 중입니다. 이 화면에는 매핑으로 만든 맵만 표시됩니다.',
    }[state.mode] || '"매핑 시작"을 누르면 이곳에 맵이 그려집니다.';
    const localized = map.update(state, empty);
    if (state.mode !== mode) {
      mode = state.mode;
      modeBadge.textContent = { idle: '대기', mapping: '매핑 중', navigation: '내비게이션 실행 중' }[mode];
      modeBadge.className = `badge ${mode === 'mapping' ? 'ok' : ''}`;
    }
    const external = state.processes.cartographer.external;
    startButton.disabled = mode === 'mapping';
    stopButton.disabled = mode !== 'mapping' || external;
    canSave = state.map.available && mode !== 'navigation';
    saveButton.disabled = !canSave;
    resetButton.disabled = mode === 'navigation' || external || !(state.map.available || mode === 'mapping');
    addPointButton.disabled = !(mode === 'mapping' && localized);
    sizeText.textContent = state.map.available
      ? `${(state.map.width * state.map.resolution).toFixed(1)} m × ${(state.map.height * state.map.resolution).toFixed(1)} m · 해상도 ${state.map.resolution} m`
      : '';
    let message = '';
    if (mode === 'navigation') message = '내비게이션 실행 중입니다. 매핑을 시작하면 내비게이션이 종료됩니다.';
    else if (external) message = '터미널에서 실행된 cartographer가 감지되었습니다. 종료는 해당 터미널에서 하세요.';
    else if (state.processes.bringup.alert) message = `로봇 bringup 오류: ${state.processes.bringup.alert}`;
    notice.textContent = message;
    notice.hidden = !message;
  }

  return {
    onState,
    unmount: () => map.destroy(),
  };
}

export default { mount };
