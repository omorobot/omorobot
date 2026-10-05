// Job: program the robot with points, io and flow control, then run it
import { api, jobPath, mapPath, store } from '../api.js';
import { h, clear, button, toast, formDialog, confirmDialog, field, select, newId, degrees } from '../ui.js';
import { RobotMap, IoPanel, LogView, fetchMaps, rememberedMap, pointTypeLabel } from '../components.js';

const STEP_TYPES = [
  ['move', '이동', 'MOVE', 'k-move', '포인트로 이동'],
  ['wait', '대기', 'WAIT', 'k-time', '지정한 시간 동안 대기'],
  ['set_output', '출력', 'OUT', 'k-io', '디지털 출력 ON/OFF'],
  ['wait_input', '입력 대기', 'WAIT IN', 'k-io', '디지털 입력이 될 때까지 대기'],
  ['if', '조건 (IF)', 'IF', 'k-flow', '조건에 따라 분기'],
  ['loop', '반복', 'LOOP', 'k-flow', '횟수·조건만큼 반복'],
  ['break', '반복 탈출', 'BREAK', 'k-flow', '가장 안쪽 반복을 빠져나감'],
  ['set_var', '변수', 'SET', 'k-misc', '변수 값 설정·증감'],
  ['log', '메시지', 'LOG', 'k-misc', '실행 로그에 메시지 기록'],
  ['call', 'Job 호출', 'CALL', 'k-misc', '다른 Job을 실행하고 돌아옴'],
  ['end', '종료', 'END', 'k-flow', 'Job을 종료'],
];
const TYPE = Object.fromEntries(STEP_TYPES.map(([type, label, keyword, color, hint]) => [type, { label, keyword, color, hint }]));
const JOB_STATE = {
  idle: ['대기', ''], running: ['실행 중', 'ok'], paused: ['일시 정지', 'warn'],
  finished: ['완료', 'accent'], stopped: ['정지됨', ''], error: ['오류', 'danger'],
};
const COMPARE = ['==', '!=', '<', '<=', '>', '>='];

function defaultCondition() {
  return { kind: 'input', channel: 1, op: '==', value: 1 };
}

function createStep(type, points) {
  const step = { id: newId('s'), type };
  if (type === 'move') {
    const first = points.find((point) => point.type === 'stop') || points[0];
    Object.assign(step, { point: first ? first.id : '', via: [], on_fail: 'stop', retries: 1 });
  } else if (type === 'wait') step.seconds = 1;
  else if (type === 'set_output') Object.assign(step, { channel: 1, value: 1 });
  else if (type === 'wait_input') Object.assign(step, { channel: 1, value: 1, timeout: 0, on_timeout: 'stop' });
  else if (type === 'if') Object.assign(step, { cond: defaultCondition(), then: [], else: [] });
  else if (type === 'loop') Object.assign(step, { mode: 'count', count: 2, cond: defaultCondition(), steps: [] });
  else if (type === 'set_var') Object.assign(step, { name: 'count', op: '=', value: 0 });
  else if (type === 'log') step.message = '';
  else if (type === 'call') step.job = '';
  return step;
}

function cloneStep(step) {
  const copy = JSON.parse(JSON.stringify(step));
  const renew = (item) => {
    item.id = newId('s');
    for (const key of ['then', 'else', 'steps']) (item[key] || []).forEach(renew);
  };
  renew(copy);
  return copy;
}

// program as the lines shown in the editor
function flatten(steps, depth = 0, lines = []) {
  steps.forEach((step, index) => {
    lines.push({ kind: 'step', key: step.id, step, container: steps, index, depth });
    const body = (name, list) => {
      flatten(list, depth + 1, lines);
      if (!list.length) lines.push({ kind: 'empty', key: `${step.id}:${name}:empty`, step, target: list, depth: depth + 1 });
    };
    if (step.type === 'if') {
      step.then = step.then || [];
      step.else = step.else || [];
      body('then', step.then);
      lines.push({ kind: 'else', key: `${step.id}:else`, step, depth });
      body('else', step.else);
      lines.push({ kind: 'end', key: `${step.id}:end`, step, container: steps, index, depth, text: 'END IF' });
    } else if (step.type === 'loop') {
      step.steps = step.steps || [];
      body('steps', step.steps);
      lines.push({ kind: 'end', key: `${step.id}:end`, step, container: steps, index, depth, text: 'END LOOP' });
    }
  });
  return lines;
}

function mount(root) {
  let jobs = [];
  let maps = [];
  let points = [];
  let labels = { din_labels: [], dout_labels: [] };
  let job = null;
  let original = '';
  let selected = null;        // key of the selected line
  let clipboard = null;
  let undo = [];
  let redo = [];
  let problems = [];
  let tab = 'props';
  let lines = [];
  let lineElements = new Map();
  let highlighted = [];
  let lastState = null;
  let runSignature = '';

  // ---------------------------------------------------------------- layout
  const jobList = h('div.list');
  const listColumn = h('div.card.job-column',
    h('div.head.inline', h('strong.grow', 'Job 목록'), button('새 Job', { small: true, kind: 'primary', iconName: 'plus', onclick: createJob })),
    h('div.body', jobList));

  const titleText = h('strong', { style: 'font-size:15px' });
  const dirtyBadge = h('span.badge.warn', { hidden: true }, '저장 안 됨');
  const stateBadge = h('span.badge', { hidden: true });
  const mapSelect = h('select', { onchange: () => edit(() => { job.map = mapSelect.value; }, { reload: true }) });
  const descriptionInput = h('input', { type: 'text', placeholder: '설명 (선택)', maxLength: 200, oninput: () => edit(() => { job.description = descriptionInput.value; }, { quiet: true }) });
  const saveButton = button('저장', { iconName: 'save', onclick: () => save() });
  const runButton = button('실행', { kind: 'primary', iconName: 'play', onclick: run });
  const pauseButton = button('일시 정지', { iconName: 'pause', onclick: () => control('pause') });
  const resumeButton = button('계속', { kind: 'primary', iconName: 'play', onclick: () => control('resume') });
  const stopButton = button('정지', { kind: 'danger-ghost', iconName: 'stop', onclick: () => control('stop') });
  const problemBox = h('div.notice.danger', { hidden: true });
  const program = h('div.program');
  const palette = h('div.palette', STEP_TYPES.map(([type, label, , , hint]) => button(label, { iconName: 'plus', small: true, title: hint, onclick: () => addStep(type) })));
  const editButtons = {
    up: button('', { small: true, iconName: 'up', title: '위로', onclick: () => moveStep(-1) }),
    down: button('', { small: true, iconName: 'down', title: '아래로', onclick: () => moveStep(1) }),
    copy: button('', { small: true, iconName: 'copy', title: '복사', onclick: () => copyStep(false) }),
    cut: button('', { small: true, iconName: 'scissors', title: '잘라내기', onclick: () => copyStep(true) }),
    paste: button('', { small: true, iconName: 'paste', title: '붙여넣기', onclick: pasteStep }),
    remove: button('', { small: true, iconName: 'trash', title: '삭제', onclick: removeStep }),
    undo: button('', { small: true, iconName: 'undo', title: '실행 취소', onclick: () => restore(undo, redo) }),
    redo: button('', { small: true, iconName: 'redo', title: '다시 실행', onclick: () => restore(redo, undo) }),
  };
  const editor = h('div.job-column', { style: 'flex:1' });
  const emptyEditor = h('div.empty', { style: 'margin:auto' }, '왼쪽에서 Job을 선택하거나 "새 Job"을 만드세요.');
  const editorColumn = h('div.card.job-column', emptyEditor, editor);
  editor.append(
    h('div.head.stack',
      h('div.inline.wrap', titleText, dirtyBadge, stateBadge,
        h('span.right.inline', runButton, pauseButton, resumeButton, stopButton, saveButton,
          button('', { iconName: 'edit', title: '이름 변경', onclick: renameJob }),
          button('', { iconName: 'copy', title: 'Job 복제', onclick: duplicateJob }),
          button('', { iconName: 'trash', kind: 'danger-ghost', title: 'Job 삭제', onclick: deleteJob }))),
      h('div.field-row', { style: 'grid-template-columns: minmax(140px, 1fr) 2fr' }, field('사용할 맵', mapSelect), field('설명', descriptionInput)),
      problemBox),
    h('div.body', program),
    h('div.foot.stack',
      h('div.inline', h('span.label.grow', '명령 추가 (선택한 줄 다음에 삽입)'), Object.values(editButtons)),
      palette));

  const tabButtons = {
    props: h('button.tab', { type: 'button', onclick: () => setTab('props') }, '명령 속성'),
    monitor: h('button.tab', { type: 'button', onclick: () => setTab('monitor') }, '실행 모니터'),
  };
  const props = h('div.stack');
  const monitorStatus = h('dl.kv');
  const monitorMapFrame = h('div.map-frame', { style: 'height:260px;flex:none' });
  const monitorMap = new RobotMap(monitorMapFrame);
  const io = new IoPanel();
  const log = new LogView('/api/job/log');
  const monitor = h('div.stack', h('div.card.stack', monitorStatus), monitorMapFrame,
    h('div.card.stack', h('h3', 'I/O'), io.element), h('div', h('div.label', { style: 'margin-bottom:4px' }, '실행 로그'), log.element));
  const sideColumn = h('div.card.job-column.job-side',
    h('div.head', { style: 'padding-bottom:0;border-bottom:0' }, h('div.tabs', { style: 'margin:0' }, tabButtons.props, tabButtons.monitor)),
    h('div.body', { style: 'padding:12px' }, props, monitor));

  root.appendChild(h('div.job-layout', listColumn, editorColumn, sideColumn));
  store.wantScan = true;
  store.wantPath = true;
  setTab('props');
  showJob(null);
  init();

  async function init() {
    try {
      const [settings] = await Promise.all([api.get('/api/settings'), reloadLists()]);
      labels = settings.settings.io;
    } catch (error) {
      toast(error.message, 'error');
    }
    const running = store.state && ['running', 'paused'].includes(store.state.job.state) ? store.state.job.name : '';
    const initial = running || (jobs[0] && jobs[0].name);
    if (initial) await openJob(initial);
  }

  async function reloadLists() {
    [{ jobs }, maps] = await Promise.all([api.get('/api/jobs'), fetchMaps()]);
    renderJobList();
  }

  // ---------------------------------------------------------------- job list
  function renderJobList() {
    clear(jobList);
    if (!jobs.length) jobList.appendChild(h('div.empty', 'Job이 없습니다.'));
    for (const item of jobs) {
      jobList.appendChild(h(`div.list-item${job && item.name === job.name ? '.selected' : ''}`, { onclick: () => openJob(item.name) },
        h('div.grow', h('div.title', item.name), h('div.sub', `${item.map || '맵 없음'} · 명령 ${item.steps}개`))));
    }
  }

  function isDirty() {
    return Boolean(job) && JSON.stringify(job) !== original;
  }

  async function discard() {
    if (!isDirty()) return true;
    return Boolean(await confirmDialog('저장하지 않은 변경', `"${job.name}" 의 변경 내용을 버릴까요?`, { confirm: '버리기', danger: true }));
  }

  async function openJob(name) {
    if (job && job.name === name) return;
    if (!(await discard())) return;
    try {
      const result = await api.get(jobPath(name));
      showJob(result.job, result.problems);
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function createJob() {
    if (!(await discard())) return;
    const values = await formDialog('새 Job', [
      { name: 'name', label: 'Job 이름', placeholder: '예: delivery_1' },
      { name: 'map', label: '사용할 맵', type: 'select', value: rememberedMap(), options: [['', '(맵 없음)'], ...maps.map((map) => map.name)], required: false },
    ], { confirm: '만들기' });
    if (!values) return;
    if (jobs.some((item) => item.name === values.name)) throw new Error(`이미 존재하는 이름입니다: ${values.name}`);
    const result = await api.put(jobPath(values.name), { map: values.map, description: '', steps: [] });
    await reloadLists();
    showJob(result.job, result.problems);
  }

  async function renameJob() {
    const values = await formDialog('Job 이름 변경', [{ name: 'name', label: '새 이름', value: job.name }], { confirm: '변경' });
    if (!values || values.name === job.name) return;
    if (isDirty()) await save(true);
    const result = await api.post(`${jobPath(job.name)}/rename`, { name: values.name });
    await reloadLists();
    showJob(result.job, problems);
  }

  async function duplicateJob() {
    const values = await formDialog('Job 복제', [{ name: 'name', label: '새 Job 이름', value: `${job.name}_copy` }], { confirm: '복제' });
    if (!values) return;
    if (isDirty()) await save(true);
    const result = await api.post(`${jobPath(job.name)}/duplicate`, { name: values.name });
    await reloadLists();
    showJob(result.job, problems);
  }

  async function deleteJob() {
    const yes = await confirmDialog('Job 삭제', `"${job.name}" Job을 삭제합니다. 되돌릴 수 없습니다.`, { confirm: '삭제', danger: true });
    if (!yes) return;
    await api.del(jobPath(job.name));
    showJob(null);
    await reloadLists();
  }

  // ---------------------------------------------------------------- editor
  function showJob(next, nextProblems = []) {
    job = next ? { name: next.name, map: next.map || '', description: next.description || '', steps: next.steps || [] } : null;
    original = job ? JSON.stringify(job) : '';
    problems = nextProblems;
    selected = null;
    undo = [];
    redo = [];
    runSignature = '';
    editor.hidden = !job;
    emptyEditor.hidden = Boolean(job);
    renderJobList();
    if (!job) {
      renderProps();
      return;
    }
    titleText.textContent = job.name;
    descriptionInput.value = job.description;
    clear(mapSelect).append(h('option', { value: '' }, '(맵 없음)'), ...maps.map((map) => h('option', { value: map.name }, map.name)));
    if (job.map && !maps.some((map) => map.name === job.map)) mapSelect.appendChild(h('option', { value: job.map }, `${job.map} (없음)`));
    mapSelect.value = job.map;
    loadPoints().then(() => {
      render();
      if (lastState) onState(lastState);
    });
  }

  async function loadPoints() {
    points = [];
    const meta = maps.find((map) => map.name === job.map) || null;
    monitorMap.setMap(meta ? job.map : '', meta);
    if (!meta) monitorMap.source.clear(job.map ? '맵을 찾을 수 없습니다.' : 'Job에 맵이 지정되지 않았습니다.');
    if (!meta) return;
    try {
      ({ points } = await api.get(`${mapPath(job.map)}/points`));
    } catch (error) {
      toast(error.message, 'error');
    }
    monitorMap.view.setPoints(points);
  }

  // every change of the job goes through here (undo, dirty mark, redraw)
  function edit(change, { quiet = false, reload = false, form = false } = {}) {
    if (!job || locked()) return;
    const before = JSON.stringify(job);
    change();
    if (JSON.stringify(job) === before) return;
    undo.push(before);
    if (undo.length > 50) undo.shift();
    redo = [];
    if (reload) loadPoints().then(render);
    else if (quiet) updateHead();
    else {
      renderProgram();
      updateHead();
      if (form) renderProps();
    }
  }

  function restore(from, to) {
    const snapshot = from.pop();
    if (!snapshot || locked()) return;
    to.push(JSON.stringify(job));
    const mapChanged = JSON.parse(snapshot).map !== job.map;
    job = JSON.parse(snapshot);
    descriptionInput.value = job.description;
    mapSelect.value = job.map;
    if (mapChanged) loadPoints().then(render);
    else render();
  }

  function locked() {
    const state = lastState && lastState.job;
    return Boolean(state && job && state.name === job.name && (state.state === 'running' || state.state === 'paused'));
  }

  function render() {
    renderProgram();
    renderProps();
    updateHead();
  }

  function updateHead() {
    const dirty = isDirty();
    dirtyBadge.hidden = !dirty;
    saveButton.disabled = !dirty || locked();
    const line = lines.find((item) => item.key === selected);
    const isStep = Boolean(line && line.kind === 'step');
    const lock = locked();
    editButtons.up.disabled = lock || !isStep || line.index === 0;
    editButtons.down.disabled = lock || !isStep || line.index === line.container.length - 1;
    editButtons.copy.disabled = !isStep;
    editButtons.cut.disabled = lock || !isStep;
    editButtons.remove.disabled = lock || !isStep;
    editButtons.paste.disabled = lock || !clipboard;
    editButtons.undo.disabled = lock || !undo.length;
    editButtons.redo.disabled = lock || !redo.length;
    for (const element of palette.children) element.disabled = lock;
    mapSelect.disabled = lock;
    descriptionInput.disabled = lock;
    problemBox.hidden = !problems.length || dirty;
    if (problems.length) problemBox.textContent = `실행 전 수정이 필요합니다: ${problems.slice(0, 4).join(' / ')}${problems.length > 4 ? ` 외 ${problems.length - 4}건` : ''}`;
  }

  // ---------------------------------------------------------------- program lines
  function pointName(id) {
    const point = points.find((item) => item.id === id);
    return point ? point.name : null;
  }

  function channelName(kind, channel) {
    const prefix = kind === 'input' ? 'DI' : 'DO';
    const names = kind === 'input' ? labels.din_labels : labels.dout_labels;
    const name = names[channel - 1];
    return name && name !== `${prefix}${channel}` ? `${prefix}${channel}(${name})` : `${prefix}${channel}`;
  }

  function describeCondition(cond = {}) {
    if (cond.kind === 'var') return `${cond.name || '?'} ${cond.op} ${cond.value}`;
    return `${channelName(cond.kind, cond.channel)} ${cond.op} ${Number(cond.value) ? 'ON' : 'OFF'}`;
  }

  function describe(step) {
    switch (step.type) {
      case 'move': {
        const via = (step.via || []).map((id) => pointName(id) || '?');
        const fail = { stop: '', retry: ` · 실패 시 ${step.retries}회 재시도`, continue: ' · 실패해도 계속' }[step.on_fail] || '';
        return `→ ${pointName(step.point) || '(포인트 선택 필요)'}${via.length ? `  (경유: ${via.join(' → ')})` : ''}${fail}`;
      }
      case 'wait': return `${step.seconds} 초`;
      case 'set_output': return `${channelName('output', step.channel)} = ${Number(step.value) ? 'ON' : 'OFF'}`;
      case 'wait_input':
        return `${channelName('input', step.channel)} = ${Number(step.value) ? 'ON' : 'OFF'}${Number(step.timeout) ? `  (최대 ${step.timeout}초${step.on_timeout === 'continue' ? ', 초과 시 계속' : ''})` : ''}`;
      case 'if': return describeCondition(step.cond);
      case 'loop':
        if (step.mode === 'forever') return '무한 반복';
        if (step.mode === 'while') return `WHILE ${describeCondition(step.cond)}`;
        return `${step.count} 회`;
      case 'set_var': return `${step.name || '?'} ${step.op} ${step.value}`;
      case 'log': return `"${step.message || ''}"`;
      case 'call': return step.job || '(Job 선택 필요)';
      default: return '';
    }
  }

  function hasProblem(step) {
    if (step.type === 'move') return !pointName(step.point) || (step.via || []).some((id) => !pointName(id));
    if (step.type === 'call') return !jobs.some((item) => item.name === step.job);
    return false;
  }

  function renderProgram() {
    lines = flatten(job.steps);
    lineElements = new Map();
    highlighted = [];
    runSignature = '';
    clear(program);
    if (!lines.length) {
      program.appendChild(h('div.empty', { style: 'font-family:var(--sans)' }, '아래 "명령 추가"에서 명령을 눌러 프로그램을 작성하세요.'));
    }
    lines.forEach((line, index) => {
      const indents = Array.from({ length: line.depth }, () => h('span.indent'));
      let content;
      if (line.kind === 'step') {
        const type = TYPE[line.step.type] || { keyword: line.step.type, color: 'k-misc' };
        content = [h(`span.kw.${type.color}`, type.keyword), h('span.text', describe(line.step))];
      } else if (line.kind === 'else') content = [h('span.kw.k-flow', 'ELSE')];
      else if (line.kind === 'end') content = [h('span.kw.k-flow', line.text)];
      else content = [h('span.placeholder', '(비어 있음) 이 줄을 선택하고 명령을 추가하세요')];
      const classes = ['line', line.key === selected ? 'selected' : '', line.kind === 'step' && hasProblem(line.step) ? 'problem' : ''].filter(Boolean).join('.');
      const element = h(`div.${classes}`, { onclick: () => selectLine(line.key) }, h('span.num', index + 1), indents, content);
      lineElements.set(line.key, element);
      program.appendChild(element);
    });
  }

  function selectLine(key) {
    selected = key;
    for (const [lineKey, element] of lineElements) element.classList.toggle('selected', lineKey === key);
    renderProps();
    updateHead();
    if (tab !== 'props' && !locked()) setTab('props');
  }

  // where a new step goes: after the selected line
  function insertion() {
    const line = lines.find((item) => item.key === selected);
    if (!line) return [job.steps, job.steps.length];
    if (line.kind === 'empty') return [line.target, 0];
    if (line.kind === 'else') return [line.step.else, 0];
    if (line.kind === 'end') return [line.container, line.index + 1];
    if (line.step.type === 'if') return [line.step.then, 0];
    if (line.step.type === 'loop') return [line.step.steps, 0];
    return [line.container, line.index + 1];
  }

  function insert(step) {
    const [container, index] = insertion();
    edit(() => container.splice(index, 0, step));
    selectLine(step.id);
    const element = lineElements.get(step.id);
    if (element) element.scrollIntoView({ block: 'nearest' });
  }

  function addStep(type) {
    if (type === 'move' && !job.map) {
      toast('먼저 "사용할 맵"을 선택하세요.', 'error');
      return;
    }
    insert(createStep(type, points));
  }

  function selectedStepLine() {
    const line = lines.find((item) => item.key === selected);
    return line && line.kind === 'step' ? line : null;
  }

  function moveStep(offset) {
    const line = selectedStepLine();
    if (!line) return;
    const target = line.index + offset;
    if (target < 0 || target >= line.container.length) return;
    edit(() => {
      const [step] = line.container.splice(line.index, 1);
      line.container.splice(target, 0, step);
    });
    selectLine(line.step.id);
  }

  function copyStep(cut) {
    const line = selectedStepLine();
    if (!line) return;
    clipboard = JSON.stringify(line.step);
    if (cut) removeStep();
    else {
      toast('복사했습니다. 붙여넣을 줄을 선택하고 붙여넣기를 누르세요.');
      updateHead();
    }
  }

  function pasteStep() {
    if (clipboard) insert(cloneStep(JSON.parse(clipboard)));
  }

  function removeStep() {
    const line = selectedStepLine();
    if (!line) return;
    const next = line.container[line.index + 1] || line.container[line.index - 1];
    edit(() => line.container.splice(line.index, 1));
    selectLine(next ? next.id : null);
  }

  // ---------------------------------------------------------------- properties
  function numberInput(value, onchange, attributes = {}) {
    const input = h('input', { type: 'number', value, step: 'any', ...attributes, oninput: () => input.value !== '' && onchange(Number(input.value)) });
    return input;
  }

  function channelSelect(kind, value, onchange) {
    const names = kind === 'input' ? labels.din_labels : labels.dout_labels;
    const count = Math.max(names.length, 8);
    return select(Array.from({ length: count }, (_, i) => [i + 1, channelName(kind, i + 1)]), value, (next) => onchange(Number(next)));
  }

  function onOffSelect(value, onchange) {
    return select([[1, 'ON'], [0, 'OFF']], Number(value) ? 1 : 0, (next) => onchange(Number(next)));
  }

  function conditionEditor(step) {
    const cond = step.cond || (step.cond = defaultCondition());
    const set = (values, form = false) => edit(() => Object.assign(step.cond, values), { form });
    const kind = select([['input', '입력 (DI)'], ['output', '출력 (DO)'], ['var', '변수']], cond.kind, (next) => {
      if (next === 'var') set({ kind: next, name: cond.name || 'count', op: '==', value: 0 }, true);
      else set({ kind: next, channel: cond.channel || 1, op: '==', value: 1 }, true);
    });
    if (cond.kind === 'var') {
      const name = h('input', { type: 'text', value: cond.name || '', maxLength: 24, oninput: () => set({ name: name.value.trim() }) });
      return h('div.stack', field('조건 대상', kind),
        h('div.field-row', field('변수 이름', name), field('비교', select(COMPARE, cond.op, (next) => set({ op: next }))), field('값', numberInput(cond.value, (next) => set({ value: next })))));
    }
    return h('div.stack', field('조건 대상', kind),
      h('div.field-row',
        field('채널', channelSelect(cond.kind, cond.channel, (next) => set({ channel: next }))),
        field('비교', select([['==', '== (같으면)'], ['!=', '!= (다르면)']], cond.op, (next) => set({ op: next }))),
        field('상태', onOffSelect(cond.value, (next) => set({ value: next })))));
  }

  function moveEditor(step) {
    const options = points.map((point) => [point.id, `${point.name} · ${pointTypeLabel(point.type)}`]);
    if (!options.length) {
      return h('div.notice', job.map
        ? `맵 "${job.map}" 에 등록된 포인트가 없습니다. Mapping > 위치 포인트 메뉴에서 포인트를 먼저 만드세요.`
        : '먼저 "사용할 맵"을 선택하세요.');
    }
    const target = select(pointName(step.point) ? options : [['', '(선택)'], ...options], step.point, (next) => edit(() => { step.point = next; }, { form: true }));
    const point = points.find((item) => item.id === step.point);
    const viaList = h('div.list', (step.via || []).map((id, index) => h('div.list-item', { style: 'cursor:default' },
      h('span.dot.waypoint'), h('span.grow', `${index + 1}. ${pointName(id) || '(삭제된 포인트)'}`),
      button('', { small: true, iconName: 'close', title: '경유점 제거', onclick: () => edit(() => step.via.splice(index, 1), { form: true }) }))));
    const viaAdd = select([['', '경유점 추가…'], ...options], '', (next) => next && edit(() => { step.via = [...(step.via || []), next]; }, { form: true }));
    return h('div.stack',
      field('목표 포인트', target),
      point ? h('p.muted.small-text', `x ${point.x.toFixed(2)}  y ${point.y.toFixed(2)}  방향 ${degrees(point.yaw)}°`) : null,
      h('div.stack', { style: 'gap:4px' }, h('span.label', '경유점 (순서대로 통과한 뒤 목표로 이동)'), viaList, viaAdd),
      h('div.field-row',
        field('이동 실패 시', select([['stop', 'Job 정지 (오류)'], ['retry', '재시도'], ['continue', '무시하고 계속']], step.on_fail, (next) => edit(() => { step.on_fail = next; }, { form: true }))),
        step.on_fail === 'retry' ? field('재시도 횟수', numberInput(step.retries, (next) => edit(() => { step.retries = Math.max(1, Math.round(next)); }), { min: 1, step: 1 })) : null));
  }

  function stepEditor(step) {
    switch (step.type) {
      case 'move': return moveEditor(step);
      case 'wait': return field('대기 시간 (초)', numberInput(step.seconds, (next) => edit(() => { step.seconds = Math.max(0, next); }), { min: 0, step: 0.5 }));
      case 'set_output':
        return h('div.field-row',
          field('출력 채널', channelSelect('output', step.channel, (next) => edit(() => { step.channel = next; }))),
          field('상태', onOffSelect(step.value, (next) => edit(() => { step.value = next; }))));
      case 'wait_input':
        return h('div.stack',
          h('div.field-row',
            field('입력 채널', channelSelect('input', step.channel, (next) => edit(() => { step.channel = next; }))),
            field('기다릴 상태', onOffSelect(step.value, (next) => edit(() => { step.value = next; })))),
          h('div.field-row',
            field('최대 대기 (초, 0 = 무제한)', numberInput(step.timeout, (next) => edit(() => { step.timeout = Math.max(0, next); }), { min: 0, step: 1 })),
            field('시간 초과 시', select([['stop', 'Job 정지 (오류)'], ['continue', '다음 명령 진행']], step.on_timeout, (next) => edit(() => { step.on_timeout = next; })))));
      case 'if':
        return h('div.stack', conditionEditor(step), h('p.muted.small-text', '조건이 참이면 IF 아래, 거짓이면 ELSE 아래의 명령을 실행합니다.'));
      case 'loop':
        return h('div.stack',
          field('반복 방식', select([['count', '횟수 지정'], ['forever', '무한 반복'], ['while', '조건이 참인 동안 (WHILE)']], step.mode, (next) => edit(() => { step.mode = next; }, { form: true }))),
          step.mode === 'count' ? field('반복 횟수', numberInput(step.count, (next) => edit(() => { step.count = Math.max(0, Math.round(next)); }), { min: 0, step: 1 })) : null,
          step.mode === 'while' ? conditionEditor(step) : null,
          step.mode === 'forever' ? h('p.muted.small-text', '"반복 탈출(BREAK)" 또는 정지 버튼으로 끝냅니다.') : null);
      case 'set_var': {
        const name = h('input', { type: 'text', value: step.name || '', maxLength: 24, oninput: () => edit(() => { step.name = name.value.trim(); }) });
        return h('div.stack',
          h('div.field-row', field('변수 이름', name),
            field('연산', select([['=', '= (대입)'], ['+=', '+= (더하기)'], ['-=', '-= (빼기)']], step.op, (next) => edit(() => { step.op = next; }))),
            field('값', numberInput(step.value, (next) => edit(() => { step.value = next; })))),
          h('p.muted.small-text', '변수는 Job 시작 시 0이며 조건(IF, WHILE)에서 사용할 수 있습니다.'));
      }
      case 'log': {
        const message = h('input', { type: 'text', value: step.message || '', maxLength: 120, oninput: () => edit(() => { step.message = message.value; }) });
        return field('메시지', message);
      }
      case 'call': {
        const others = jobs.filter((item) => item.name !== job.name).map((item) => item.name);
        return h('div.stack',
          field('호출할 Job', select([['', '(선택)'], ...others], step.job, (next) => edit(() => { step.job = next; }))),
          h('p.muted.small-text', '호출한 Job이 끝나면 다음 명령으로 돌아옵니다.'));
      }
      case 'break': return h('p.muted', '가장 안쪽 반복(LOOP)을 빠져나갑니다. 보통 IF 안에서 사용합니다.');
      case 'end': return h('p.muted', 'Job을 정상 종료합니다.');
      default: return h('p.muted', '설정할 항목이 없습니다.');
    }
  }

  function renderProps() {
    clear(props);
    const line = lines.find((item) => item.key === selected);
    if (!job || !line || line.kind === 'empty') {
      props.appendChild(h('div.empty', job ? '프로그램에서 명령을 선택하면 이곳에서 설정할 수 있습니다.' : ''));
      return;
    }
    const type = TYPE[line.step.type] || { label: line.step.type, keyword: '', color: 'k-misc', hint: '' };
    props.append(
      h('div.inline', h(`span.kw.${type.color}`, type.keyword), h('strong', type.label)),
      h('p.muted.small-text', type.hint));
    if (line.kind === 'step') props.appendChild(stepEditor(line.step));
    else props.appendChild(h('p.muted.small-text', line.kind === 'else' ? '이 줄을 선택하고 명령을 추가하면 ELSE 블록에 들어갑니다.' : '이 줄을 선택하고 명령을 추가하면 블록 다음에 들어갑니다.'));
    if (locked()) {
      for (const control of props.querySelectorAll('input, select, button')) control.disabled = true;
    }
  }

  function setTab(next) {
    tab = next;
    for (const [name, element] of Object.entries(tabButtons)) element.classList.toggle('active', name === next);
    props.hidden = next !== 'props';
    monitor.hidden = next !== 'monitor';
    if (next === 'monitor') {
      monitorMap.view.resize();
      if (lastState) onState(lastState);
    }
  }

  // ---------------------------------------------------------------- save / run
  async function save(silent = false) {
    const result = await api.put(jobPath(job.name), job);
    original = JSON.stringify(job);
    problems = result.problems;
    await reloadLists();
    updateHead();
    if (!silent) toast(problems.length ? '저장했습니다. 실행 전 수정이 필요한 항목이 있습니다.' : '저장했습니다.', problems.length ? '' : 'ok');
  }

  async function run() {
    if (isDirty()) await save(true);
    if (problems.length) throw new Error(`실행할 수 없습니다: ${problems[0]}`);
    const state = store.state;
    if (state.mode === 'mapping' && JSON.stringify(job.steps).includes('"move"')) {
      const yes = await confirmDialog('Job 실행', '매핑이 종료되고 내비게이션이 시작됩니다. 저장하지 않은 맵은 사라집니다. 계속할까요?', { confirm: '실행' });
      if (!yes) return;
    }
    await api.post('/api/job/run', { name: job.name });
    setTab('monitor');
    await store.refresh();
  }

  async function control(action) {
    await api.post(`/api/job/${action}`);
    await store.refresh();
  }

  // ---------------------------------------------------------------- state
  function onState(state) {
    const wasLocked = locked();
    lastState = state;
    const run = state.job;
    const mine = Boolean(job) && run.name === job.name;
    const active = run.state === 'running' || run.state === 'paused';
    if (locked() !== wasLocked) {
      renderProps();
      updateHead();
    }
    const [text, kind] = JOB_STATE[run.state] || JOB_STATE.idle;
    stateBadge.hidden = !mine || run.state === 'idle';
    stateBadge.textContent = text;
    stateBadge.className = `badge ${kind}`;
    runButton.hidden = active;
    runButton.disabled = !job;
    pauseButton.hidden = !(active && run.state === 'running');
    resumeButton.hidden = !(active && run.state === 'paused');
    stopButton.hidden = !active;
    if (active && !mine && job) {
      runButton.hidden = false;
      runButton.disabled = true;
      runButton.title = `다른 Job(${run.name})이 실행 중입니다.`;
      pauseButton.hidden = true;
      resumeButton.hidden = true;
      stopButton.hidden = true;
    } else {
      runButton.title = '';
    }

    // line in execution
    const ids = mine && active ? [run.current, ...(run.stack || [])] : [];
    const signature = ids.join(',');
    if (signature !== runSignature) {
      runSignature = signature;
      for (const element of highlighted) element.classList.remove('running');
      const element = ids.map((id) => lineElements.get(id)).find(Boolean);
      highlighted = element ? [element] : [];
      if (element) {
        element.classList.add('running');
        element.scrollIntoView({ block: 'nearest' });
      }
    }

    if (tab !== 'monitor') return;
    const status = [
      ['Job', run.name || '-'],
      ['상태', text + (run.message && run.state !== 'running' ? ` · ${run.message}` : '')],
      ['현재 동작', run.activity || '-'],
      ['변수', Object.keys(run.variables).length ? Object.entries(run.variables).map(([key, value]) => `${key} = ${value}`).join(', ') : '-'],
      ['내비게이션', state.mode === 'navigation' ? `${state.nav.map || '외부 실행'} · ${state.nav.ready ? '준비됨' : '준비 중'}` : '정지'],
    ];
    const task = state.nav.task;
    if (task && task.status === 'active' && task.distance_remaining !== null) status.push(['남은 거리', `${task.distance_remaining} m`]);
    const statusSignature = JSON.stringify(status);
    if (monitorStatus.dataset.signature !== statusSignature) {
      monitorStatus.dataset.signature = statusSignature;
      clear(monitorStatus).append(...status.flatMap(([key, value]) => [h('dt', key), h('dd', value)]));
    }
    monitorMap.update(state);
    io.update(state.io);
    log.update(run.log_seq);
  }

  return {
    onState,
    dirty: isDirty,
    leave: () => !isDirty() || window.confirm('저장하지 않은 Job 변경 내용이 있습니다. 페이지를 떠날까요?'),
    unmount: () => monitorMap.destroy(),
  };
}

export default { mount };
