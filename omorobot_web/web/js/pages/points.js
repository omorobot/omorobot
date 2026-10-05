// Navigation > 위치 포인트: stop positions and waypoints on a map
import { api, mapPath, store, LIVE_MAP } from '../api.js';
import { h, clear, button, toast, formDialog, confirmDialog, field, degrees, radians } from '../ui.js';
import { RobotMap, MapSelector, pointTypeLabel, pointTypeSelect } from '../components.js';

function mount(root) {
  let name = '';
  let points = [];
  let selected = null;
  let localized = false;
  let lastState = null;

  const selector = new MapSelector({ allowLive: true, onchange: (value, meta) => selectMap(value, meta) });
  const pickButton = button('지도에서 추가', { kind: 'primary', iconName: 'plus', onclick: () => pickNew() });
  const hereButton = button('현재 로봇 위치 추가', { iconName: 'locate', onclick: addHere });
  const frame = h('div.map-frame', h('div.map-toolbar', h('span.label', '맵'), selector.element, h('span.sep'), pickButton, hereButton));
  const map = new RobotMap(frame, {
    movablePoints: true,
    onPointClick: (id) => select(id),
    onPointMove: (id, x, y) => change(id, { x, y }),
  });

  const navBadge = h('span.badge', '정지');
  const navText = h('p.muted.small-text');
  const navStart = button('이 맵으로 내비게이션 시작', { kind: 'primary', iconName: 'play', onclick: startNavigation });
  const navStop = button('내비게이션 종료', { iconName: 'stop', onclick: () => api.post('/api/nav/stop').then(() => store.refresh()) });
  const initialButton = button('초기 위치 설정', { iconName: 'flag', onclick: pickInitialPose });
  const startPoseButton = button('시작 위치로 맞춤', { iconName: 'locate', onclick: resetToStart });
  const cancelButton = button('이동 취소', { iconName: 'close', onclick: () => api.post('/api/nav/cancel') });
  const list = h('div.list');
  const editor = h('div.card.stack', { hidden: true });

  root.appendChild(h('div.workspace', frame, h('div.side',
    h('div.card.stack',
      h('div.inline', h('h3.grow', { style: 'margin:0' }, '내비게이션'), navBadge),
      navText,
      h('div.inline.wrap', navStart, navStop),
      h('div.inline.wrap', initialButton, startPoseButton, cancelButton),
    ),
    h('div.card.stack', h('h3', '포인트 목록'), list),
    editor,
  )));
  store.wantScan = true;
  store.wantPath = true;
  selector.setLive(Boolean(store.state && store.state.mode === 'mapping'));
  selector.load().catch((error) => toast(error.message, 'error'));

  async function selectMap(value, meta) {
    name = value;
    selected = null;
    points = [];
    map.view.setTool(null);
    map.setMap(value, meta);
    render();
    if (!value) return;
    try {
      ({ points } = await api.get(`${mapPath(value)}/points`));
    } catch (error) {
      toast(error.message, 'error');
    }
    render();
    if (lastState) onState(lastState);
  }

  async function savePoints(next) {
    try {
      ({ points } = await api.put(`${mapPath(name)}/points`, { points: next }));
    } catch (error) {
      toast(error.message, 'error');
      ({ points } = await api.get(`${mapPath(name)}/points`));
    }
    render();
  }

  function select(id) {
    selected = id;
    render();
  }

  // a map has one start position
  function change(id, values) {
    return savePoints(points.map((point) => (
      point.id === id ? { ...point, ...values } : { ...point, start: values.start ? false : point.start })));
  }

  function startPoint() {
    return points.find((point) => point.start);
  }

  function nextName() {
    let index = points.length + 1;
    while (points.some((point) => point.name === `P${index}`)) index += 1;
    return `P${index}`;
  }

  // click = position, drag = heading
  function pickNew() {
    if (!name) return;
    map.view.setTool({
      type: 'pose',
      onPick: async (pose) => {
        map.view.setTool(null);
        const values = await formDialog('포인트 추가', [
          { name: 'name', label: '포인트 이름', value: nextName() },
          { name: 'type', label: '종류', type: 'select', value: 'stop', options: [['stop', '정지 위치'], ['waypoint', '경유점 (waypoint)']] },
        ], { confirm: '추가' });
        if (!values) return;
        await savePoints([...points, { ...values, x: pose.x, y: pose.y, yaw: pose.yaw }]);
        const added = points.find((point) => point.name === values.name);
        if (added) select(added.id);
      },
    }, '위치를 클릭하고, 누른 채로 끌어서 방향을 지정하세요 (Esc: 취소)');
  }

  async function addHere() {
    const pose = lastState && lastState.robot.pose;
    if (!localized || !pose) throw new Error('이 맵에서 로봇 위치를 알 수 없습니다. 내비게이션을 시작하세요.');
    const values = await formDialog('현재 로봇 위치 추가', [
      { name: 'name', label: '포인트 이름', value: nextName() },
      { name: 'type', label: '종류', type: 'select', value: 'stop', options: [['stop', '정지 위치'], ['waypoint', '경유점 (waypoint)']] },
    ], { confirm: '추가' });
    if (!values) return;
    const now = store.state.robot.pose;
    await savePoints([...points, { ...values, x: now.x, y: now.y, yaw: now.yaw }]);
  }

  function repick(point) {
    map.view.setTool({
      type: 'pose',
      yaw: point.yaw,
      onPick: (pose) => {
        map.view.setTool(null);
        change(point.id, { x: pose.x, y: pose.y, yaw: pose.dragged ? pose.yaw : point.yaw });
      },
    }, `"${point.name}" 의 새 위치를 클릭하고, 끌어서 방향을 지정하세요 (Esc: 취소)`);
  }

  async function startNavigation() {
    const state = store.state;
    if (state.job.state === 'running' || state.mode === 'mapping') {
      const what = state.mode === 'mapping' ? '매핑이 종료됩니다.' : '실행 중인 Job이 정지됩니다.';
      const yes = await confirmDialog('내비게이션 시작', `${what} 계속할까요?`, { confirm: '시작' });
      if (!yes) return;
    }
    await api.post('/api/nav/start', { map: name });
    toast('내비게이션을 시작합니다. 준비까지 수 초가 걸립니다.', 'ok');
    await store.refresh();
  }

  function pickInitialPose() {
    map.view.setTool({
      type: 'pose',
      onPick: async (pose) => {
        map.view.setTool(null);
        try {
          await api.post('/api/nav/initial_pose', pose);
          toast('초기 위치를 설정했습니다.', 'ok');
        } catch (error) {
          toast(error.message, 'error');
        }
      },
    }, '로봇의 실제 위치를 클릭하고, 끌어서 로봇이 향한 방향을 지정하세요 (Esc: 취소)');
  }

  // the robot was put back on the start position by hand
  async function resetToStart() {
    const point = startPoint();
    if (!point) return;
    const yes = await confirmDialog('시작 위치로 맞춤', `로봇이 시작 위치 "${point.name}" 에 놓여 있다고 보고 로봇 위치를 다시 설정합니다. 계속할까요?`, { confirm: '설정' });
    if (!yes) return;
    await api.post('/api/nav/initial_pose', { x: point.x, y: point.y, yaw: point.yaw });
    toast('로봇 위치를 시작 위치로 설정했습니다.', 'ok');
  }

  async function goTo(point) {
    const { task } = await api.post('/api/nav/goto', { x: point.x, y: point.y, yaw: point.yaw, xy_tol: point.xy_tol, yaw_tol: point.yaw_tol });
    const tolerance = task.tolerance ? ` (허용 오차 ${toleranceText(task.tolerance.xy, task.tolerance.yaw)})` : '';
    toast(`"${point.name}" (으)로 이동합니다.${tolerance}`);
  }

  // tolerance of a stop position, not set: default of the navigation
  function toleranceText(xy, yaw) {
    const parts = [];
    if (xy) parts.push(`±${Math.round(xy * 1000) / 10} cm`);
    if (yaw) parts.push(`±${degrees(yaw)}°`);
    return parts.join(' / ');
  }

  async function remove(point) {
    const yes = await confirmDialog('포인트 삭제', `"${point.name}" 포인트를 삭제할까요? 이 포인트를 사용하는 Job은 수정이 필요합니다.`, { confirm: '삭제', danger: true });
    if (!yes) return;
    selected = null;
    await savePoints(points.filter((item) => item.id !== point.id));
  }

  function render() {
    map.view.setPoints(points.map((point) => ({ ...point })), selected);
    clear(list);
    if (!points.length) list.appendChild(h('div.empty', name ? '포인트가 없습니다. "지도에서 추가"로 등록하세요.' : '맵을 선택하세요.'));
    for (const point of points) {
      list.appendChild(h(`div.list-item${point.id === selected ? '.selected' : ''}`, { onclick: () => select(point.id) },
        h(`span.dot.${point.type}`),
        h('div.grow', h('div.title', point.name),
          point.start ? h('div.sub', '시작 위치 (전원을 켤 때 로봇을 두는 곳)') : null,
          h('div.sub', `${pointTypeLabel(point.type)} · x ${point.x.toFixed(2)}  y ${point.y.toFixed(2)}  θ ${degrees(point.yaw)}°`),
          point.xy_tol || point.yaw_tol ? h('div.sub', `허용 오차 ${toleranceText(point.xy_tol, point.yaw_tol)}`) : null)));
    }
    renderEditor();
  }

  function renderEditor() {
    const point = points.find((item) => item.id === selected);
    editor.hidden = !point;
    if (!point) return;
    const nameInput = h('input', { type: 'text', value: point.name, maxLength: 40 });
    const typeSelect = pointTypeSelect(point.type);
    const xInput = h('input', { type: 'number', step: 0.01, value: point.x });
    const yInput = h('input', { type: 'number', step: 0.01, value: point.y });
    const yawInput = h('input', { type: 'number', step: 1, value: degrees(point.yaw) });
    // stop precision of this point, empty: default of the navigation
    const limits = (lastState && lastState.nav.tolerance) || { xy: 0.1, yaw: 0.1, min_xy: 0.05 };
    const minXy = Math.round(limits.min_xy * 1000) / 10;
    const xyTolInput = h('input', {
      type: 'number', step: 1, min: minXy, max: 100,
      value: point.xy_tol ? Math.round(point.xy_tol * 1000) / 10 : '',
      placeholder: `기본 ${Math.round(limits.xy * 1000) / 10}`,
    });
    const yawTolInput = h('input', {
      type: 'number', step: 1, min: 1, max: 180,
      value: point.yaw_tol ? degrees(point.yaw_tol) : '',
      placeholder: `기본 ${degrees(limits.yaw)}`,
    });
    const startInput = h('input', { type: 'checkbox', checked: Boolean(point.start), disabled: point.type !== 'stop' });
    typeSelect.addEventListener('change', () => {
      startInput.disabled = typeSelect.value !== 'stop';
      if (startInput.disabled) startInput.checked = false;
    });
    const tolerance = (input, toValue) => (input.value.trim() === '' ? null : toValue(Number(input.value)));
    const apply = () => change(point.id, {
      name: nameInput.value.trim(),
      type: typeSelect.value,
      x: Number(xInput.value),
      y: Number(yInput.value),
      yaw: radians(Number(yawInput.value)),
      xy_tol: tolerance(xyTolInput, (value) => value / 100),
      yaw_tol: tolerance(yawTolInput, radians),
      start: startInput.checked,
    });
    const goButton = button('여기로 이동', { iconName: 'play', onclick: () => goTo(point) });
    goButton.disabled = !(localized && lastState && lastState.nav.ready && lastState.job.state !== 'running');
    goButton.dataset.role = 'go';
    clear(editor).append(
      h('h3', '포인트 편집'),
      field('이름', nameInput),
      field('종류', typeSelect),
      h('div.field-row', field('x (m)', xInput), field('y (m)', yInput), field('방향 (°)', yawInput)),
      h('div.field-row', field('위치 허용 오차 (cm)', xyTolInput), field('각도 허용 오차 (°)', yawTolInput)),
      h('p.muted.small-text', `정지 위치에 도착한 것으로 보는 범위입니다. 비워 두면 기본값을 사용합니다. 위치는 ${minXy} cm 이상으로 입력하세요.`),
      h('label.inline', startInput, h('span', '시작 위치로 지정')),
      h('p.muted.small-text', '전원을 켠 뒤 내비게이션을 시작하면 로봇이 이 위치에 이 방향으로 놓여 있다고 봅니다. 맵마다 정지 위치 하나만 지정할 수 있습니다.'),
      h('div.inline.wrap',
        button('적용', { kind: 'primary', iconName: 'check', onclick: apply }),
        button('지도에서 다시 지정', { iconName: 'pin', onclick: () => repick(point) }),
      ),
      h('div.inline.wrap', goButton,
        button('삭제', { kind: 'danger-ghost', iconName: 'trash', onclick: () => remove(point) })),
      h('p.muted.small-text', '지도에서 포인트를 끌어서 옮길 수도 있습니다.'),
    );
  }

  function onKey(event) {
    if (event.key === 'Escape' && map.view.tool) map.view.setTool(null);
  }
  document.addEventListener('keydown', onKey);

  function onState(state) {
    lastState = state;
    selector.setLive(state.mode === 'mapping');
    localized = map.update(state, '매핑 중인 맵이 없습니다.');
    const live = name === LIVE_MAP;
    const mine = state.mode === 'navigation' && state.nav.map === name;
    const external = state.processes.navigation.external;
    let badge = ['정지', ''];
    const start = startPoint();
    let text = `포인트로 이동하거나 Job을 실행하려면 내비게이션을 시작하세요. 로봇은 마지막으로 알려진 위치, 모르면 ${start ? `시작 위치 "${start.name}"` : '맵의 원점(매핑 시작 위치)'} 에 있다고 가정합니다.`;
    if (live) {
      text = '매핑 중에는 포인트 등록만 가능합니다. 맵을 저장한 뒤 내비게이션을 시작하세요.';
    } else if (state.processes.navigation.alert && mine) {
      badge = ['오류', 'danger'];
      text = '내비게이션을 시작하지 못했습니다. 시스템 메뉴의 로그를 확인하세요.';
    } else if (mine && state.nav.ready) {
      badge = ['실행 중', 'ok'];
      text = localized ? '로봇 위치가 실제와 다르면 "초기 위치 설정"으로 맞춰 주세요.' : '위치 추정 대기 중… "초기 위치 설정"으로 로봇 위치를 지정하세요.';
    } else if (mine) {
      badge = ['준비 중', 'warn'];
      text = '내비게이션을 시작하는 중입니다…';
    } else if (state.mode === 'navigation') {
      badge = [external ? '외부 실행' : `다른 맵 (${state.nav.map})`, 'warn'];
      text = external ? '터미널에서 실행된 내비게이션이 감지되었습니다.' : '다른 맵으로 내비게이션이 실행 중입니다.';
    }
    navBadge.textContent = badge[0];
    navBadge.className = `badge ${badge[1]}`;
    navText.textContent = text;
    navStart.disabled = live || !name || mine || external;
    navStop.disabled = state.mode !== 'navigation' || external;
    initialButton.disabled = !(mine && state.nav.ready);
    startPoseButton.disabled = !(mine && state.nav.ready && start) || state.job.state === 'running';
    const task = state.nav.task;
    cancelButton.disabled = !(task && (task.status === 'active' || task.status === 'pending')) || state.job.state === 'running';
    pickButton.disabled = !name || (live && !state.map.available);
    hereButton.disabled = !localized;
    const goButton = editor.querySelector('[data-role="go"]');
    if (goButton) goButton.disabled = !(localized && state.nav.ready && state.job.state !== 'running');
    const pose = state.robot.pose;
    map.view.setStatus(localized && pose ? `로봇 x ${pose.x.toFixed(2)}  y ${pose.y.toFixed(2)}  θ ${degrees(pose.yaw)}°` : '');
  }

  return {
    onState,
    unmount: () => {
      document.removeEventListener('keydown', onKey);
      map.destroy();
    },
  };
}

export default { mount };
