// map canvas: occupancy map, robot, scan, path and points with pan / zoom
import { h, button } from './ui.js';

export const GRAY_OCCUPIED = 0;
export const GRAY_UNKNOWN = 205;
export const GRAY_FREE = 254;

const COLOR_OCCUPIED = [27, 36, 52];
const COLOR_FREE = [255, 255, 255];
const COLOR_UNKNOWN = [205, 212, 222];
const POINT_COLORS = { stop: '#0e9f6e', waypoint: '#8b5cf6' };
const ROBOT_RADIUS = 0.12;
const HIT_RADIUS = 14;

// gray value of the map image to display color
const LUT = new Uint8Array(256 * 3);
for (let gray = 0; gray < 256; gray += 1) {
  const ratio = Math.min(gray / GRAY_FREE, 1);
  const color = gray === GRAY_UNKNOWN
    ? COLOR_UNKNOWN
    : COLOR_OCCUPIED.map((value, i) => Math.round(value + (COLOR_FREE[i] - value) * ratio));
  LUT.set(color, gray * 3);
}

export function colorize(gray, rgba, from = 0, to = gray.length) {
  for (let i = from; i < to; i += 1) {
    const g = gray[i] * 3;
    rgba[i * 4] = LUT[g];
    rgba[i * 4 + 1] = LUT[g + 1];
    rgba[i * 4 + 2] = LUT[g + 2];
    rgba[i * 4 + 3] = 255;
  }
}

// png of the server to gray values
export async function loadGray(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('맵 이미지를 불러올 수 없습니다.');
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const gray = new Uint8Array(bitmap.width * bitmap.height);
  for (let i = 0; i < gray.length; i += 1) gray[i] = data[i * 4];
  return { gray, width: bitmap.width, height: bitmap.height };
}

export class MapView {
  constructor(parent, options = {}) {
    this.options = options;          // onPointClick(id), onPointMove(id, x, y), movablePoints
    this.root = h('div.map-canvas');
    this.canvas = h('canvas');
    this.hint = h('div.map-hint', { hidden: true });
    this.empty = h('div.map-empty', { hidden: true });
    this.status = h('div.map-status', { hidden: true });
    this.followButton = button('', { iconName: 'locate', title: '로봇 따라가기', onclick: () => this.setFollow(!this.follow) });
    this.root.append(
      this.canvas, this.empty, this.hint, this.status,
      h('div.map-controls',
        button('', { iconName: 'zoomIn', title: '확대', onclick: () => this.zoom(1.4) }),
        button('', { iconName: 'zoomOut', title: '축소', onclick: () => this.zoom(1 / 1.4) }),
        button('', { iconName: 'fit', title: '화면에 맞춤', onclick: () => this.fit() }),
        this.followButton),
    );
    parent.appendChild(this.root);

    this.context = this.canvas.getContext('2d');
    this.view = { x: 0, y: 0, ppm: 60 };
    this.map = null;
    this.robot = null;
    this.scan = [];
    this.path = [];
    this.goal = null;
    this.points = [];
    this.selected = null;
    this.follow = false;
    this.tool = null;
    this.overlay = null;             // extra drawing of the page: overlay(context, view)
    this.hover = null;
    this.pointers = new Map();
    this.gesture = null;
    this.fitted = false;
    this.frame = 0;

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.root);
    this.canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.canvas.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.canvas.addEventListener('pointercancel', (event) => this.onPointerUp(event, true));
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
    this.canvas.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    this.resize();
  }

  destroy() {
    this.observer.disconnect();
    cancelAnimationFrame(this.frame);
    this.root.remove();
  }

  // ---------------------------------------------------------------- content
  setMap(info, gray) {
    const sizeChanged = !this.map || this.map.width !== info.width || this.map.height !== info.height;
    if (sizeChanged) {
      const canvas = document.createElement('canvas');
      canvas.width = info.width;
      canvas.height = info.height;
      this.map = { canvas, context: canvas.getContext('2d'), image: new ImageData(info.width, info.height) };
    }
    Object.assign(this.map, { width: info.width, height: info.height, resolution: info.resolution, origin: info.origin, gray });
    colorize(gray, this.map.image.data);
    this.map.context.putImageData(this.map.image, 0, 0);
    this.empty.hidden = true;
    if (!this.fitted) this.fit();
    this.draw();
  }

  // repaint a part of the map after the gray values were edited
  refreshMap(x, y, width, height) {
    const map = this.map;
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(map.width, x + width);
    const y1 = Math.min(map.height, y + height);
    if (x1 <= x0 || y1 <= y0) return;
    for (let row = y0; row < y1; row += 1) colorize(map.gray, map.image.data, row * map.width + x0, row * map.width + x1);
    map.context.putImageData(map.image, 0, 0, x0, y0, x1 - x0, y1 - y0);
    this.draw();
  }

  clearMap(message = '') {
    this.map = null;
    this.empty.textContent = message;
    this.empty.hidden = !message;
    this.draw();
  }

  setLayers({ robot = null, scan = [], path = [], goal = null }) {
    this.robot = robot;
    this.scan = scan;
    this.path = path;
    this.goal = goal;
    if (this.follow && robot) {
      this.view.x = robot.x;
      this.view.y = robot.y;
    }
    this.draw();
  }

  setPoints(points, selected = null) {
    this.points = points || [];
    this.selected = selected;
    this.draw();
  }

  setTool(tool, hint = '') {
    this.tool = tool;
    this.gesture = null;
    this.hint.textContent = hint;
    this.hint.hidden = !hint;
    this.canvas.style.cursor = tool ? 'crosshair' : 'grab';
    this.draw();
  }

  setStatus(text) {
    this.status.textContent = text;
    this.status.hidden = !text;
  }

  setFollow(follow) {
    this.follow = follow;
    this.followButton.classList.toggle('active', follow);
    if (follow && this.robot) {
      this.view.x = this.robot.x;
      this.view.y = this.robot.y;
      this.draw();
    }
  }

  // ---------------------------------------------------------------- view
  resize() {
    const ratio = window.devicePixelRatio || 1;
    this.width = this.root.clientWidth;
    this.height = this.root.clientHeight;
    this.canvas.width = Math.max(1, Math.round(this.width * ratio));
    this.canvas.height = Math.max(1, Math.round(this.height * ratio));
    if (this.map && !this.fitted) this.fit();
    this.draw();
  }

  fit() {
    if (!this.map || this.width < 10 || this.height < 10) return;
    const { width, height, resolution, origin } = this.map;
    // fit to the explored part of the map
    let minCol = width, maxCol = -1, minRow = height, maxRow = -1;
    const gray = this.map.gray;
    for (let row = 0; row < height; row += 2) {
      for (let col = 0; col < width; col += 2) {
        if (gray[row * width + col] !== GRAY_UNKNOWN) {
          if (col < minCol) minCol = col;
          if (col > maxCol) maxCol = col;
          if (row < minRow) minRow = row;
          if (row > maxRow) maxRow = row;
        }
      }
    }
    if (maxCol < 0) { minCol = 0; maxCol = width; minRow = 0; maxRow = height; }
    const spanX = Math.max((maxCol - minCol + 2) * resolution, 2);
    const spanY = Math.max((maxRow - minRow + 2) * resolution, 2);
    this.view.ppm = Math.min(this.width / spanX, this.height / spanY) * 0.9;
    this.view.x = origin[0] + ((minCol + maxCol + 1) / 2) * resolution;
    this.view.y = origin[1] + (height - (minRow + maxRow + 1) / 2) * resolution;
    this.fitted = true;
    this.setFollow(false);
    this.draw();
  }

  zoom(factor, sx = this.width / 2, sy = this.height / 2) {
    const [wx, wy] = this.toWorld(sx, sy);
    this.view.ppm = Math.min(1200, Math.max(4, this.view.ppm * factor));
    // keep the world point under the cursor
    this.view.x = wx - (sx - this.width / 2) / this.view.ppm;
    this.view.y = wy + (sy - this.height / 2) / this.view.ppm;
    this.draw();
  }

  toScreen(x, y) {
    return [this.width / 2 + (x - this.view.x) * this.view.ppm, this.height / 2 - (y - this.view.y) * this.view.ppm];
  }

  toWorld(sx, sy) {
    return [this.view.x + (sx - this.width / 2) / this.view.ppm, this.view.y - (sy - this.height / 2) / this.view.ppm];
  }

  // world to map image pixel (column, row from the top)
  toPixel(x, y) {
    const { height, resolution, origin } = this.map;
    return [(x - origin[0]) / resolution, height - (y - origin[1]) / resolution];
  }

  // ---------------------------------------------------------------- pointer
  position(event) {
    const rect = this.canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  pointAt(sx, sy) {
    let best = null;
    let bestDistance = HIT_RADIUS;
    for (const point of this.points) {
      const [px, py] = this.toScreen(point.x, point.y);
      const distance = Math.hypot(px - sx, py - sy);
      if (distance < bestDistance) {
        best = point;
        bestDistance = distance;
      }
    }
    return best;
  }

  onPointerDown(event) {
    const [sx, sy] = this.position(event);
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch (error) {
      // pointer without capture
    }
    this.pointers.set(event.pointerId, [sx, sy]);
    if (this.pointers.size === 2) {
      // second finger: pinch zoom, give up what the first finger began
      if (this.gesture && this.gesture.type === 'paint' && this.tool.onCancel) this.tool.onCancel();
      const [a, b] = [...this.pointers.values()];
      this.gesture = { type: 'pinch', distance: Math.hypot(a[0] - b[0], a[1] - b[1]), center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
      return;
    }
    const [x, y] = this.toWorld(sx, sy);
    const primary = event.button === 0;
    if (primary && this.tool && this.tool.type === 'pose') {
      this.gesture = { type: 'pose', x, y, sx, sy, yaw: this.tool.yaw || 0, dragged: false };
    } else if (primary && this.tool && this.tool.type === 'paint' && this.map) {
      this.gesture = { type: 'paint' };
      this.tool.onStart(...this.toPixel(x, y));
    } else {
      const point = primary && !this.tool ? this.pointAt(sx, sy) : null;
      if (point) this.gesture = { type: 'point', point, sx, sy, moved: false };
      else this.gesture = { type: 'pan', sx, sy, moved: false };
      this.canvas.style.cursor = 'grabbing';
    }
    this.draw();
  }

  onPointerMove(event) {
    const [sx, sy] = this.position(event);
    this.hover = [sx, sy];
    if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, [sx, sy]);
    const gesture = this.gesture;
    if (!gesture) {
      if (this.tool) this.draw();
      else this.canvas.style.cursor = this.pointAt(sx, sy) ? 'pointer' : 'grab';
      return;
    }
    if (gesture.type === 'pinch' && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const center = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      this.view.x -= (center[0] - gesture.center[0]) / this.view.ppm;
      this.view.y += (center[1] - gesture.center[1]) / this.view.ppm;
      if (gesture.distance > 0) this.zoom(distance / gesture.distance, center[0], center[1]);
      gesture.distance = distance;
      gesture.center = center;
    } else if (gesture.type === 'pan') {
      if (Math.hypot(sx - gesture.sx, sy - gesture.sy) > 3) gesture.moved = true;
      this.view.x -= (sx - gesture.sx) / this.view.ppm;
      this.view.y += (sy - gesture.sy) / this.view.ppm;
      gesture.sx = sx;
      gesture.sy = sy;
      if (gesture.moved) this.setFollow(false);
    } else if (gesture.type === 'pose') {
      if (Math.hypot(sx - gesture.sx, sy - gesture.sy) > 8) {
        gesture.dragged = true;
        gesture.yaw = Math.atan2(-(sy - gesture.sy), sx - gesture.sx);
      }
    } else if (gesture.type === 'paint') {
      this.tool.onMove(...this.toPixel(...this.toWorld(sx, sy)));
    } else if (gesture.type === 'point') {
      if (Math.hypot(sx - gesture.sx, sy - gesture.sy) > 4) gesture.moved = true;
      if (gesture.moved && this.options.movablePoints) {
        const [x, y] = this.toWorld(sx, sy);
        gesture.point.x = x;
        gesture.point.y = y;
      }
    }
    this.draw();
  }

  onPointerUp(event, cancelled = false) {
    this.pointers.delete(event.pointerId);
    const gesture = this.gesture;
    this.gesture = null;
    this.canvas.style.cursor = this.tool ? 'crosshair' : 'grab';
    if (!gesture) return;
    if (gesture.type === 'pinch') {
      this.pointers.clear();
    } else if (gesture.type === 'pose') {
      if (!cancelled) this.tool.onPick({ x: gesture.x, y: gesture.y, yaw: gesture.yaw, dragged: gesture.dragged });
    } else if (gesture.type === 'paint') {
      if (cancelled && this.tool.onCancel) this.tool.onCancel();
      else this.tool.onEnd();
    } else if (gesture.type === 'point') {
      if (gesture.moved && this.options.movablePoints) {
        if (this.options.onPointMove) this.options.onPointMove(gesture.point.id, gesture.point.x, gesture.point.y);
      } else if (this.options.onPointClick) {
        this.options.onPointClick(gesture.point.id);
      }
    } else if (gesture.type === 'pan' && !gesture.moved && !cancelled) {
      if (this.options.onPointClick) this.options.onPointClick(null);
    }
    this.draw();
  }

  onWheel(event) {
    event.preventDefault();
    const [sx, sy] = this.position(event);
    this.zoom(Math.exp(-event.deltaY * 0.0015), sx, sy);
  }

  // ---------------------------------------------------------------- drawing
  draw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  render() {
    const context = this.context;
    const ratio = window.devicePixelRatio || 1;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = `rgb(${COLOR_UNKNOWN.join(',')})`;
    context.fillRect(0, 0, this.width, this.height);
    if (this.map) this.drawMap(context);
    this.drawGrid(context);
    if (this.map) this.drawOrigin(context);
    this.drawPath(context);
    this.drawScan(context);
    for (const point of this.points) this.drawPoint(context, point, point.id === this.selected);
    if (this.goal) this.drawGoal(context);
    if (this.robot) this.drawRobot(context);
    if (this.gesture && this.gesture.type === 'pose') this.drawPosePick(context);
    if (this.overlay) this.overlay(context, this);
    this.drawScale(context);
  }

  drawMap(context) {
    const { canvas, width, height, resolution, origin } = this.map;
    const [sx, sy] = this.toScreen(origin[0], origin[1] + height * resolution);
    const scale = resolution * this.view.ppm;
    context.imageSmoothingEnabled = scale < 1;
    context.drawImage(canvas, sx, sy, width * scale, height * scale);
  }

  drawGrid(context) {
    const ppm = this.view.ppm;
    if (ppm < 12) return;
    const [x0, y1] = this.toWorld(0, 0);
    const [x1, y0] = this.toWorld(this.width, this.height);
    context.strokeStyle = 'rgba(60, 80, 110, 0.10)';
    context.lineWidth = 1;
    context.beginPath();
    for (let x = Math.ceil(x0); x <= x1; x += 1) {
      const sx = Math.round(this.toScreen(x, 0)[0]) + 0.5;
      context.moveTo(sx, 0);
      context.lineTo(sx, this.height);
    }
    for (let y = Math.ceil(y0); y <= y1; y += 1) {
      const sy = Math.round(this.toScreen(0, y)[1]) + 0.5;
      context.moveTo(0, sy);
      context.lineTo(this.width, sy);
    }
    context.stroke();
  }

  drawOrigin(context) {
    const [sx, sy] = this.toScreen(0, 0);
    const length = Math.max(14, 0.3 * this.view.ppm);
    context.lineWidth = 2;
    context.strokeStyle = '#e5484d';
    context.beginPath();
    context.moveTo(sx, sy);
    context.lineTo(sx + length, sy);
    context.stroke();
    context.strokeStyle = '#2f9e44';
    context.beginPath();
    context.moveTo(sx, sy);
    context.lineTo(sx, sy - length);
    context.stroke();
  }

  drawPath(context) {
    if (this.path.length < 4) return;
    context.strokeStyle = 'rgba(29, 95, 214, 0.85)';
    context.lineWidth = 2.5;
    context.lineJoin = 'round';
    context.beginPath();
    for (let i = 0; i < this.path.length; i += 2) {
      const [sx, sy] = this.toScreen(this.path[i], this.path[i + 1]);
      if (i === 0) context.moveTo(sx, sy);
      else context.lineTo(sx, sy);
    }
    context.stroke();
  }

  drawScan(context) {
    context.fillStyle = '#e5484d';
    const size = this.view.ppm > 80 ? 3 : 2;
    for (let i = 0; i < this.scan.length; i += 2) {
      const [sx, sy] = this.toScreen(this.scan[i], this.scan[i + 1]);
      context.fillRect(sx - size / 2, sy - size / 2, size, size);
    }
  }

  drawArrow(context, sx, sy, yaw, length, color, width = 2.5) {
    const ex = sx + Math.cos(yaw) * length;
    const ey = sy - Math.sin(yaw) * length;
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = width;
    context.beginPath();
    context.moveTo(sx, sy);
    context.lineTo(ex, ey);
    context.stroke();
    const head = 6 + width;
    context.beginPath();
    context.moveTo(ex + Math.cos(yaw) * head * 0.6, ey - Math.sin(yaw) * head * 0.6);
    context.lineTo(ex + Math.cos(yaw + 2.5) * head, ey - Math.sin(yaw + 2.5) * head);
    context.lineTo(ex + Math.cos(yaw - 2.5) * head, ey - Math.sin(yaw - 2.5) * head);
    context.closePath();
    context.fill();
  }

  drawLabel(context, text, sx, sy) {
    context.font = '600 12px system-ui, "Noto Sans KR", sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'top';
    context.lineWidth = 3.5;
    context.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    context.strokeText(text, sx, sy);
    context.fillStyle = '#182230';
    context.fillText(text, sx, sy);
  }

  drawPoint(context, point, selected) {
    const [sx, sy] = this.toScreen(point.x, point.y);
    if (sx < -60 || sy < -60 || sx > this.width + 60 || sy > this.height + 60) return;
    const color = POINT_COLORS[point.type] || POINT_COLORS.stop;
    this.drawArrow(context, sx, sy, point.yaw, 20, color);
    if (selected) {
      context.strokeStyle = color;
      context.lineWidth = 2;
      context.setLineDash([4, 3]);
      context.beginPath();
      context.arc(sx, sy, 15, 0, Math.PI * 2);
      context.stroke();
      context.setLineDash([]);
    }
    context.fillStyle = color;
    context.strokeStyle = '#fff';
    context.lineWidth = 2;
    context.beginPath();
    if (point.type === 'waypoint') {
      context.moveTo(sx, sy - 8);
      context.lineTo(sx + 8, sy);
      context.lineTo(sx, sy + 8);
      context.lineTo(sx - 8, sy);
      context.closePath();
    } else {
      context.arc(sx, sy, 7.5, 0, Math.PI * 2);
    }
    context.fill();
    context.stroke();
    this.drawLabel(context, point.name, sx, sy + 12);
  }

  drawGoal(context) {
    for (const via of this.goal.via || []) {
      const [vx, vy] = this.toScreen(via.x, via.y);
      context.strokeStyle = '#1d5fd6';
      context.lineWidth = 2;
      context.beginPath();
      context.arc(vx, vy, 6, 0, Math.PI * 2);
      context.stroke();
    }
    const [sx, sy] = this.toScreen(this.goal.x, this.goal.y);
    context.strokeStyle = '#1d5fd6';
    context.lineWidth = 2.5;
    context.beginPath();
    context.arc(sx, sy, 11, 0, Math.PI * 2);
    context.moveTo(sx - 16, sy);
    context.lineTo(sx + 16, sy);
    context.moveTo(sx, sy - 16);
    context.lineTo(sx, sy + 16);
    context.stroke();
  }

  drawRobot(context) {
    const [sx, sy] = this.toScreen(this.robot.x, this.robot.y);
    const radius = Math.max(ROBOT_RADIUS * this.view.ppm, 8);
    const yaw = this.robot.yaw;
    context.fillStyle = 'rgba(29, 95, 214, 0.92)';
    context.strokeStyle = '#fff';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(sx, sy, radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    // heading
    context.fillStyle = '#fff';
    context.beginPath();
    context.moveTo(sx + Math.cos(yaw) * radius * 0.85, sy - Math.sin(yaw) * radius * 0.85);
    context.lineTo(sx + Math.cos(yaw + 2.4) * radius * 0.6, sy - Math.sin(yaw + 2.4) * radius * 0.6);
    context.lineTo(sx + Math.cos(yaw - 2.4) * radius * 0.6, sy - Math.sin(yaw - 2.4) * radius * 0.6);
    context.closePath();
    context.fill();
  }

  drawPosePick(context) {
    const gesture = this.gesture;
    const color = '#d9480f';
    this.drawArrow(context, gesture.sx, gesture.sy, gesture.yaw, 34, color, 3);
    context.fillStyle = color;
    context.strokeStyle = '#fff';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(gesture.sx, gesture.sy, 7, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }

  drawScale(context) {
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];
    const meters = steps.find((step) => step * this.view.ppm >= 60) || 50;
    const length = meters * this.view.ppm;
    const x = 14;
    const y = 18;
    context.strokeStyle = '#182230';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(x, y - 4);
    context.lineTo(x, y);
    context.lineTo(x + length, y);
    context.lineTo(x + length, y - 4);
    context.stroke();
    context.font = '600 11px system-ui, sans-serif';
    context.textAlign = 'left';
    context.textBaseline = 'top';
    context.lineWidth = 3;
    context.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    const text = meters >= 1 ? `${meters} m` : `${meters * 100} cm`;
    context.strokeText(text, x, y + 4);
    context.fillStyle = '#182230';
    context.fillText(text, x, y + 4);
  }
}

// keeps a MapView in sync with the live map of the robot or a saved map
export class MapSource {
  constructor(view) {
    this.view = view;
    this.key = null;
    this.loading = false;
  }

  // info: {width, height, resolution, origin}, key changes when the image changes
  async show(key, url, info) {
    if (key === this.key || this.loading) return false;
    this.loading = true;
    try {
      const { gray, width, height } = await loadGray(url);
      this.view.setMap({ ...info, width, height }, gray);
      this.key = key;
      return true;
    } catch (error) {
      return false;
    } finally {
      this.loading = false;
    }
  }

  clear(message) {
    if (this.key === null && !this.view.map) {
      this.view.empty.textContent = message;
      this.view.empty.hidden = !message;
      return;
    }
    this.key = null;
    this.view.fitted = false;
    this.view.clearMap(message);
  }
}
