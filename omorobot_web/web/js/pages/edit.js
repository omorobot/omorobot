// Mapping > 맵 수정: erase noise, draw walls (keep out areas) on a saved map
import { api, mapPath } from '../api.js';
import { h, button, toast, formDialog, confirmDialog, select } from '../ui.js';
import { RobotMap, MapSelector } from '../components.js';
import { GRAY_FREE, GRAY_OCCUPIED, GRAY_UNKNOWN } from '../mapview.js';

const MAX_UNDO = 30;
const TOOLS = [
  ['pan', '이동', 'hand'],
  ['brush', '브러시', 'brush'],
  ['line', '직선', 'line'],
  ['rect', '사각형', 'rect'],
];
const PAINTS = [
  [GRAY_OCCUPIED, '벽 / 진입 금지 (검정)'],
  [GRAY_FREE, '빈 공간 (흰색)'],
  [GRAY_UNKNOWN, '미탐색 (회색)'],
];

function mount(root) {
  let name = '';
  let meta = null;
  let tool = 'pan';
  let paint = GRAY_OCCUPIED;
  let size = 3;               // brush diameter in map pixels
  let undo = [];
  let redo = [];
  let dirty = false;
  let stroke = null;          // {before, from: [x, y], to: [x, y], bounds}

  const selector = new MapSelector({ onchange: (value, info) => selectMap(value, info) });
  const toolButtons = TOOLS.map(([id, label, iconName]) => {
    const element = button(label, { iconName, onclick: () => setTool(id) });
    element.dataset.tool = id;
    return element;
  });
  const paintSelect = select(PAINTS, paint, (value) => { paint = Number(value); });
  const sizeLabel = h('span.mono');
  const sizeInput = h('input', {
    type: 'range', min: 1, max: 30, step: 1, value: size, style: 'width:110px',
    oninput: () => { size = Number(sizeInput.value); updateSize(); map.view.draw(); },
  });
  const undoButton = button('', { iconName: 'undo', title: '실행 취소 (Ctrl+Z)', onclick: () => revert(undo, redo) });
  const redoButton = button('', { iconName: 'redo', title: '다시 실행 (Ctrl+Y)', onclick: () => revert(redo, undo) });
  const saveButton = button('저장', { kind: 'primary', iconName: 'save', onclick: () => save() });
  const saveAsButton = button('다른 이름으로 저장', { iconName: 'copy', onclick: saveAs });
  const restoreButton = button('원본 복원', { iconName: 'refresh', onclick: restore });
  const info = h('span.muted.small-text');

  const frame = h('div.map-frame',
    h('div.map-toolbar', h('span.label', '맵'), selector.element, h('span.sep'),
      toolButtons, h('span.sep'),
      paintSelect, h('span.label', '굵기'), sizeInput, sizeLabel, h('span.sep'),
      undoButton, redoButton),
    h('div.map-toolbar', saveButton, saveAsButton, restoreButton, info));
  const map = new RobotMap(frame, { showScan: false });
  map.view.followButton.hidden = true;
  map.view.overlay = drawOverlay;
  root.appendChild(h('div', { style: 'height:100%;min-height:480px;display:flex' }, frame));
  frame.style.flex = '1';
  paintSelect.style.width = 'auto';
  selector.load().catch((error) => toast(error.message, 'error'));
  setTool('pan');
  updateSize();
  updateButtons();

  async function selectMap(value, information) {
    if (dirty && name && value !== name) {
      const yes = await confirmDialog('저장하지 않은 수정', `"${name}" 맵의 수정 내용을 버릴까요?`, { confirm: '버리기', danger: true });
      if (!yes) {
        selector.value = name;
        selector.element.value = name;
        return;
      }
    }
    name = value;
    meta = information;
    undo = [];
    redo = [];
    dirty = false;
    map.source.clear('');
    map.name = '';
    map.setMap(value, information);
    updateButtons();
    if (!value) return;
    try {
      const { points } = await api.get(`${mapPath(value)}/points`);
      map.view.setPoints(points);
    } catch (error) {
      map.view.setPoints([]);
    }
  }

  function setTool(id) {
    tool = id;
    for (const element of toolButtons) element.classList.toggle('active', element.dataset.tool === id);
    if (id === 'pan') map.view.setTool(null);
    else map.view.setTool({ type: 'paint', onStart, onMove, onEnd, onCancel });
  }

  function updateSize() {
    const resolution = meta ? meta.resolution : 0.05;
    sizeLabel.textContent = `${Math.round(size * resolution * 100)} cm`;
  }

  function updateButtons() {
    updateSize();
    undoButton.disabled = !undo.length;
    redoButton.disabled = !redo.length;
    saveButton.disabled = !name || !dirty;
    saveAsButton.disabled = !name;
    restoreButton.disabled = !meta || !meta.edited;
    info.textContent = meta
      ? `${meta.width}×${meta.height} px · ${(meta.width * meta.resolution).toFixed(1)} m × ${(meta.height * meta.resolution).toFixed(1)} m${dirty ? ' · 저장하지 않은 수정 있음' : ''}`
      : '';
  }

  // ---------------------------------------------------------------- painting
  function grow(bounds, x, y, margin) {
    bounds[0] = Math.min(bounds[0], Math.floor(x - margin));
    bounds[1] = Math.min(bounds[1], Math.floor(y - margin));
    bounds[2] = Math.max(bounds[2], Math.ceil(x + margin));
    bounds[3] = Math.max(bounds[3], Math.ceil(y + margin));
  }

  function stamp(gray, cx, cy) {
    const { width, height } = map.view.map;
    const radius = size / 2;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(width - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(height - 1, Math.ceil(cy + radius));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        // pixel centers inside the brush circle, a 1px brush paints the pixel under the cursor
        if (size <= 1 ? (x === Math.floor(cx) && y === Math.floor(cy)) : Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius) {
          gray[y * width + x] = paint;
        }
      }
    }
  }

  function strokeLine(gray, from, to) {
    const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const steps = Math.max(1, Math.ceil(distance / 0.5));
    for (let i = 0; i <= steps; i += 1) {
      stamp(gray, from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
    }
    grow(stroke.bounds, from[0], from[1], size / 2 + 1);
    grow(stroke.bounds, to[0], to[1], size / 2 + 1);
  }

  function fillRect(gray, from, to) {
    const { width, height } = map.view.map;
    const x0 = Math.max(0, Math.floor(Math.min(from[0], to[0])));
    const x1 = Math.min(width - 1, Math.floor(Math.max(from[0], to[0])));
    const y0 = Math.max(0, Math.floor(Math.min(from[1], to[1])));
    const y1 = Math.min(height - 1, Math.floor(Math.max(from[1], to[1])));
    for (let y = y0; y <= y1; y += 1) gray.fill(paint, y * width + x0, y * width + x1 + 1);
    grow(stroke.bounds, x0, y0, 1);
    grow(stroke.bounds, x1, y1, 1);
  }

  function refresh(bounds) {
    map.view.refreshMap(bounds[0], bounds[1], bounds[2] - bounds[0] + 1, bounds[3] - bounds[1] + 1);
  }

  function onStart(x, y) {
    const gray = map.view.map.gray;
    stroke = { before: gray.slice(), from: [x, y], to: [x, y], bounds: [Infinity, Infinity, -Infinity, -Infinity] };
    if (tool === 'brush') {
      strokeLine(gray, stroke.from, stroke.to);
      refresh(stroke.bounds);
    }
  }

  function onMove(x, y) {
    if (!stroke) return;
    const gray = map.view.map.gray;
    if (tool === 'brush') {
      strokeLine(gray, stroke.to, [x, y]);
      refresh(stroke.bounds);
    }
    stroke.to = [x, y];
  }

  function onEnd() {
    if (!stroke) return;
    const view = map.view.map;
    if (tool === 'line') strokeLine(view.gray, stroke.from, stroke.to);
    if (tool === 'rect') fillRect(view.gray, stroke.from, stroke.to);
    const x0 = Math.max(0, stroke.bounds[0]);
    const y0 = Math.max(0, stroke.bounds[1]);
    const x1 = Math.min(view.width - 1, stroke.bounds[2]);
    const y1 = Math.min(view.height - 1, stroke.bounds[3]);
    if (x1 >= x0 && y1 >= y0) {
      // keep only the changed rectangle for undo
      const width = x1 - x0 + 1;
      const before = new Uint8Array(width * (y1 - y0 + 1));
      for (let y = y0; y <= y1; y += 1) {
        before.set(stroke.before.subarray(y * view.width + x0, y * view.width + x0 + width), (y - y0) * width);
      }
      undo.push({ x: x0, y: y0, width, height: y1 - y0 + 1, data: before });
      if (undo.length > MAX_UNDO) undo.shift();
      redo = [];
      dirty = true;
      refresh([x0, y0, x1, y1]);
    }
    stroke = null;
    updateButtons();
  }

  function onCancel() {
    if (!stroke) return;
    map.view.map.gray.set(stroke.before);
    map.view.refreshMap(0, 0, map.view.map.width, map.view.map.height);
    stroke = null;
  }

  // swap the saved rectangle with the current content
  function revert(from, to) {
    const item = from.pop();
    if (!item) return;
    const view = map.view.map;
    const current = new Uint8Array(item.data.length);
    for (let y = 0; y < item.height; y += 1) {
      const offset = (item.y + y) * view.width + item.x;
      current.set(view.gray.subarray(offset, offset + item.width), y * item.width);
      view.gray.set(item.data.subarray(y * item.width, (y + 1) * item.width), offset);
    }
    to.push({ ...item, data: current });
    dirty = true;
    map.view.refreshMap(item.x, item.y, item.width, item.height);
    updateButtons();
  }

  function drawOverlay(context, view) {
    if (tool === 'pan' || !view.map) return;
    const scale = view.map.resolution * view.view.ppm;
    const pixelToScreen = ([x, y]) => view.toScreen(view.map.origin[0] + x * view.map.resolution, view.map.origin[1] + (view.map.height - y) * view.map.resolution);
    context.strokeStyle = '#d9480f';
    context.lineWidth = 1.5;
    if (stroke && tool === 'line') {
      const [ax, ay] = pixelToScreen(stroke.from);
      const [bx, by] = pixelToScreen(stroke.to);
      context.lineWidth = Math.max(1.5, size * scale);
      context.lineCap = 'round';
      context.globalAlpha = 0.55;
      context.beginPath();
      context.moveTo(ax, ay);
      context.lineTo(bx, by);
      context.stroke();
      context.globalAlpha = 1;
      context.lineCap = 'butt';
    } else if (stroke && tool === 'rect') {
      const [ax, ay] = pixelToScreen(stroke.from);
      const [bx, by] = pixelToScreen(stroke.to);
      context.fillStyle = 'rgba(217, 72, 15, 0.25)';
      context.fillRect(ax, ay, bx - ax, by - ay);
      context.strokeRect(ax, ay, bx - ax, by - ay);
    } else if (view.hover && tool !== 'rect') {
      context.beginPath();
      context.arc(view.hover[0], view.hover[1], Math.max(2, (size * scale) / 2), 0, Math.PI * 2);
      context.stroke();
    }
  }

  // ---------------------------------------------------------------- save
  async function upload(target) {
    const view = map.view.map;
    return api.upload(`${mapPath(target)}/image?width=${view.width}&height=${view.height}`, new Blob([view.gray], { type: 'application/octet-stream' }));
  }

  async function save() {
    const result = await upload(name);
    meta = result.map;
    dirty = false;
    await selector.load(name);
    toast(result.reloaded ? '저장했습니다. 실행 중인 내비게이션에도 반영되었습니다.' : '저장했습니다.', 'ok');
    updateButtons();
  }

  async function saveAs() {
    const values = await formDialog('다른 이름으로 저장', [{ name: 'name', label: '새 맵 이름', value: `${name}_edit` }],
      { confirm: '저장', message: '포인트도 함께 복사됩니다.' });
    if (!values) return;
    await api.post(`${mapPath(name)}/duplicate`, { name: values.name });
    await upload(values.name);
    dirty = false;
    await selector.load(values.name);
    toast(`"${values.name}" (으)로 저장했습니다.`, 'ok');
  }

  async function restore() {
    const yes = await confirmDialog('원본 복원', '맵 생성 시 저장된 원본으로 되돌립니다. 모든 수정 내용이 사라집니다.', { confirm: '복원', danger: true });
    if (!yes) return;
    await api.post(`${mapPath(name)}/restore`);
    dirty = false;
    await selector.load(name);
    toast('원본으로 복원했습니다.', 'ok');
  }

  function onKey(event) {
    if (event.target.closest('input, textarea, select')) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'z') {
      event.preventDefault();
      revert(event.shiftKey ? redo : undo, event.shiftKey ? undo : redo);
    } else if ((event.ctrlKey || event.metaKey) && key === 'y') {
      event.preventDefault();
      revert(redo, undo);
    }
  }
  document.addEventListener('keydown', onKey);

  return {
    dirty: () => dirty,
    leave: () => !dirty || window.confirm('저장하지 않은 맵 수정 내용이 있습니다. 페이지를 떠날까요?'),
    unmount: () => {
      document.removeEventListener('keydown', onKey);
      map.destroy();
    },
  };
}

export default { mount };
