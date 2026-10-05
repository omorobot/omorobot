// virtual keyboard to drive the robot (same keys as teleop_keyboard: w a s d x)
import { api, store } from './api.js';
import { h, clear, icon, toast, select } from './ui.js';

const SEND_PERIOD = 100;      // ms, the server stops the robot 0.5s after the last command
const STEP_LIN = 0.05;
const STEP_ANG = 0.1;
const KEYS = {
  w: 'forward', arrowup: 'forward',
  x: 'backward', arrowdown: 'backward',
  a: 'left', arrowleft: 'left',
  d: 'right', arrowright: 'right',
  s: 'stop', ' ': 'stop',
};

// keep receiving the pointer when it leaves the element, not possible for every pointer
function capture(element, event) {
  try {
    element.setPointerCapture(event.pointerId);
  } catch (error) {
    // released on pointerup of the element instead
  }
}

class Teleop {
  constructor() {
    this.root = document.getElementById('teleop');
    this.toggle = document.getElementById('teleop-toggle');
    this.open = false;
    this.mode = 'hold';                     // hold: move while pressed, step: like teleop_keyboard
    this.speed = { lin: 0.15, ang: 0.5 };
    this.limits = { lin: 0.3, ang: 1.0 };
    this.pressed = new Set();
    this.target = { lin: 0, ang: 0 };
    this.sending = false;
    this.timer = null;
    this.keys = {};
    this.lastError = 0;

    this.toggle.append(icon('keyboard'), h('span', '가상 키보드'));
    this.toggle.addEventListener('click', () => this.setOpen(!this.open));
    document.addEventListener('keydown', (event) => this.onKey(event, true));
    document.addEventListener('keyup', (event) => this.onKey(event, false));
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => document.hidden && this.releaseAll());
    store.subscribe((state) => this.onState(state));
    this.loadSettings();
  }

  async loadSettings() {
    try {
      const { settings } = await api.get('/api/settings');
      this.speed.lin = settings.teleop.lin_vel;
      this.speed.ang = settings.teleop.ang_vel;
      this.mode = settings.teleop.mode;
    } catch (error) {
      // defaults
    }
    this.render();
  }

  saveSettings() {
    api.put('/api/settings', { teleop: { lin_vel: this.speed.lin, ang_vel: this.speed.ang, mode: this.mode } }).catch(() => {});
  }

  setOpen(open) {
    this.open = open;
    this.root.hidden = !open;
    this.toggle.classList.toggle('active', open);
    if (!open) this.stop();
  }

  render() {
    const key = (name, label, sub, extra = '') => {
      const element = h(`div.key${extra}`, { role: 'button', tabindex: 0, 'aria-label': sub }, label, h('small', sub));
      element.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        capture(element, event);
        this.press(name, true);
      });
      const release = () => this.press(name, false);
      element.addEventListener('pointerup', release);
      element.addEventListener('pointercancel', release);
      element.addEventListener('lostpointercapture', release);
      this.keys[name] = element;
      return element;
    };
    const slider = (axis, label, unit, min) => {
      const value = h('span.mono', `${this.speed[axis].toFixed(2)} ${unit}`);
      const input = h('input', {
        type: 'range', min, max: this.limits[axis], step: 0.05, value: this.speed[axis],
        oninput: () => {
          this.speed[axis] = Number(input.value);
          value.textContent = `${this.speed[axis].toFixed(2)} ${unit}`;
        },
        onchange: () => this.saveSettings(),
      });
      return h('div.stack', { style: 'gap:2px' }, h('div.inline', h('span.label.grow', label), value), input);
    };
    this.readout = h('div.teleop-readout');
    this.head = h('div.teleop-head', icon('keyboard', 16), h('strong', '가상 키보드'),
      h('button.btn.small.icon', { type: 'button', title: '닫기', onclick: () => this.setOpen(false) }, icon('close', 15)));
    clear(this.root).append(
      this.head,
      h('div.teleop-body',
        h('div.keys',
          h('div.key.blank'), key('forward', 'W', '전진'), h('div.key.blank'),
          key('left', 'A', '좌회전'), key('stop', 'S', '정지', '.stop'), key('right', 'D', '우회전'),
          h('div.key.blank'), key('backward', 'X', '후진'), h('div.key.blank')),
        this.readout,
        slider('lin', '선속도', 'm/s', 0.05),
        slider('ang', '각속도', 'rad/s', 0.1),
        h('label.field', h('span', '조작 방식'), select([
          ['hold', '누르는 동안 이동'],
          ['step', '누를 때마다 속도 증감 (teleop_keyboard 방식)'],
        ], this.mode, (value) => {
          this.stop();
          this.mode = value;
          this.saveSettings();
        })),
        h('p.muted.small-text', '키보드 W A S D X / 방향키, 정지는 S 또는 Space'),
      ),
    );
    this.enableDrag();
    this.updateReadout(null);
  }

  enableDrag() {
    let origin = null;
    this.head.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return;
      const rect = this.root.getBoundingClientRect();
      origin = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      capture(this.head, event);
    });
    this.head.addEventListener('pointermove', (event) => {
      if (!origin) return;
      const left = Math.min(Math.max(0, event.clientX - origin.dx), window.innerWidth - this.root.offsetWidth);
      const top = Math.min(Math.max(0, event.clientY - origin.dy), window.innerHeight - 40);
      Object.assign(this.root.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
    });
    const end = () => { origin = null; };
    this.head.addEventListener('pointerup', end);
    this.head.addEventListener('pointercancel', end);
  }

  onKey(event, down) {
    if (!this.open || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target && target.closest && target.closest('input:not([type="range"]), textarea, select, [contenteditable]')) return;
    const name = KEYS[event.key.toLowerCase()];
    if (!name) return;
    event.preventDefault();
    if (down && event.repeat && this.mode === 'hold') return;
    this.press(name, down);
  }

  press(name, down) {
    const element = this.keys[name];
    if (element) element.classList.toggle('pressed', down);
    if (name === 'stop') {
      if (down) this.stop();
      return;
    }
    if (this.mode === 'step') {
      if (down) this.step(name);
      return;
    }
    if (down) this.pressed.add(name);
    else this.pressed.delete(name);
    const lin = (this.pressed.has('forward') ? 1 : 0) - (this.pressed.has('backward') ? 1 : 0);
    const ang = (this.pressed.has('left') ? 1 : 0) - (this.pressed.has('right') ? 1 : 0);
    this.setTarget(lin * this.speed.lin, ang * this.speed.ang);
  }

  step(name) {
    const clamp = (value, limit) => Math.round(Math.min(limit, Math.max(-limit, value)) * 100) / 100;
    let { lin, ang } = this.target;
    if (name === 'forward') lin = clamp(lin + STEP_LIN, this.limits.lin);
    if (name === 'backward') lin = clamp(lin - STEP_LIN, this.limits.lin);
    if (name === 'left') ang = clamp(ang + STEP_ANG, this.limits.ang);
    if (name === 'right') ang = clamp(ang - STEP_ANG, this.limits.ang);
    this.setTarget(lin, ang);
  }

  setTarget(lin, ang) {
    this.target = { lin, ang };
    this.updateReadout();
    this.send();
    const moving = lin !== 0 || ang !== 0;
    if (moving && !this.timer) this.timer = setInterval(() => this.send(), SEND_PERIOD);
    if (!moving && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async send() {
    if (this.sending) return;
    this.sending = true;
    try {
      await api.post('/api/teleop', this.target);
    } catch (error) {
      this.releaseAll();
      if (Date.now() - this.lastError > 3000) {
        this.lastError = Date.now();
        toast(error.message, 'error');
      }
    } finally {
      this.sending = false;
    }
  }

  releaseAll() {
    if (this.mode === 'hold' || document.hidden) this.halt();
  }

  halt() {
    this.pressed.clear();
    for (const element of Object.values(this.keys)) element.classList.remove('pressed');
    const moving = this.target.lin !== 0 || this.target.ang !== 0;
    this.target = { lin: 0, ang: 0 };
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.updateReadout();
    return moving;
  }

  // immediate stop without the deceleration ramp
  stop() {
    this.halt();
    api.post('/api/teleop/stop').catch(() => {});
  }

  onState(state) {
    if (!state) return;
    this.limits = state.robot.limits;
    this.velocity = state.robot.velocity;
    if (this.open) this.updateReadout();
  }

  updateReadout() {
    if (!this.readout) return;
    const velocity = this.velocity || { lin: 0, ang: 0 };
    const format = (value) => `${value >= 0 ? ' ' : ''}${value.toFixed(2)}`;
    clear(this.readout).append(
      h('span', ''), h('span', 'm/s'), h('span', 'rad/s'),
      h('span', '명령'), h('span', format(this.target.lin)), h('span', format(this.target.ang)),
      h('span', '실제'), h('span', format(velocity.lin)), h('span', format(velocity.ang)),
    );
  }
}

export const teleop = new Teleop();
