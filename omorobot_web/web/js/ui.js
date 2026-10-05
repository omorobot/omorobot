// dom helpers, icons, toast and dialogs

const ICONS = {
  job: 'M9 5h11M9 12h11M9 19h11M4 5h.01M4 12h.01M4 19h.01',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14',
  pin: 'M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  layers: 'M12 3 2 8.5 12 14l10-5.5L12 3zM2 13.5 12 19l10-5.5',
  system: 'M4 5h16v10H4zM8 19h8M12 15v4',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  play: 'M7 4v16l13-8L7 4z',
  pause: 'M7 4v16M17 4v16',
  stop: 'M6 6h12v12H6z',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  download: 'M12 4v11M7 11l5 5 5-5M4 20h16',
  upload: 'M12 16V5M7 9l5-5 5 5M4 20h16',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  locate: 'M12 3v3M12 18v3M3 12h3M18 12h3M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  undo: 'M9 7 4 12l5 5M4 12h10a6 6 0 0 1 0 12h-1',
  redo: 'M15 7l5 5-5 5M20 12H10a6 6 0 0 0 0 12h1',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  check: 'M5 12.5 10 17l9-10',
  close: 'M6 6l12 12M18 6 6 18',
  zoomIn: 'M12 5v14M5 12h14',
  zoomOut: 'M5 12h14',
  flag: 'M5 21V4M5 4h12l-2 4 2 4H5',
  hand: 'M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v8c0 4-2.5 7-6.5 7S5 18.5 4.5 16L3 12.5a1.4 1.4 0 0 1 2.5-1.2L8 14',
  brush: 'M4 20c3 0 5-1 5-4a3 3 0 0 0-3-3c-2 0-3 2-3 4 0 1.500 0 2 1 3zM9.500 13.500 19 4l1.500 1.500-9.500 9.500',
  line: 'M5 19 19 5',
  rect: 'M4 6h16v12H4z',
  refresh: 'M20 11a8 8 0 1 0-2.300 5.700M20 5v6h-6',
  scissors: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.500 8 20 19M8.500 16 20 5',
  paste: 'M9 4h6v3H9zM15 5h4v16H5V5h4',
};

export function icon(name, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] || '');
  svg.appendChild(path);
  return svg;
}

// h('div.card', {onclick: fn}, child, 'text', [children])
export function h(spec, ...rest) {
  const [tag, ...classes] = spec.split('.');
  const element = document.createElement(tag || 'div');
  if (classes.length) element.className = classes.join(' ');
  let children = rest;
  const first = rest[0];
  if (first && typeof first === 'object' && !(first instanceof Node) && !Array.isArray(first)) {
    children = rest.slice(1);
    for (const [key, value] of Object.entries(first)) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
      else if (key === 'class') element.className += ` ${value}`;
      else if (key === 'dataset') Object.assign(element.dataset, value);
      else if (key in element && key !== 'list') element[key] = value;
      else element.setAttribute(key, value === true ? '' : value);
    }
  }
  append(element, children);
  return element;
}

function append(element, children) {
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    if (Array.isArray(child)) append(element, child);
    else element.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
  return element;
}

export function button(label, options = {}) {
  const { kind = '', iconName, onclick, title, small, disabled } = options;
  const classes = ['btn', kind, small ? 'small' : '', !label && iconName ? 'icon' : ''].filter(Boolean).join('.');
  const element = h(`button.${classes}`, { type: 'button', title: title || (label ? undefined : ''), disabled }, iconName ? icon(iconName, small ? 15 : 17) : null, label || null);
  if (onclick) {
    element.addEventListener('click', async (event) => {
      if (element.classList.contains('busy')) return;
      const result = onclick(event);
      if (result instanceof Promise) await busy(element, result);
    });
  }
  return element;
}

// spinner on the button while the request runs, errors go to a toast
export async function busy(element, promise) {
  // "disabled" stays with the page, it may change it while the request runs
  element.classList.add('busy');
  element.setAttribute('aria-busy', 'true');
  try {
    return await promise;
  } catch (error) {
    toast(error.message || String(error), 'error');
    return undefined;
  } finally {
    element.classList.remove('busy');
    element.removeAttribute('aria-busy');
  }
}

export function toast(message, kind = '') {
  const root = document.getElementById('toasts');
  const element = h(`div.toast${kind ? `.${kind}` : ''}`, { role: 'status' }, message);
  root.appendChild(element);
  while (root.children.length > 4) root.removeChild(root.firstChild);
  setTimeout(() => element.remove(), kind === 'error' ? 6000 : 3000);
}

export function field(label, control) {
  return h('label.field', h('span', label), control);
}

export function select(options, value, onchange) {
  const element = h('select', { onchange: () => onchange && onchange(element.value) });
  for (const option of options) {
    const [optionValue, text] = Array.isArray(option) ? option : [option, option];
    element.appendChild(h('option', { value: optionValue, selected: String(optionValue) === String(value) }, text));
  }
  return element;
}

function openModal(title, body, actions) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(null);
    };
    const form = h('form.modal', {
      onsubmit: (event) => {
        event.preventDefault();
        const primary = actions.find((action) => action.primary);
        const value = primary.value();
        if (value !== undefined) close(value);
      },
    },
    h('h2', title), body,
    h('div.actions', actions.map((action) => h(`button.btn${action.kind ? `.${action.kind}` : ''}`, {
      type: action.primary ? 'submit' : 'button',
      onclick: action.primary ? undefined : () => close(null),
    }, action.label))));
    const backdrop = h('div.modal-backdrop', { onmousedown: (event) => event.target === backdrop && close(null) }, form);
    root.appendChild(backdrop);
    document.addEventListener('keydown', onKey);
    const focus = form.querySelector('input, select, textarea') || form.querySelector('button[type="submit"]');
    if (focus) {
      focus.focus();
      if (focus.select) focus.select();
    }
  });
}

export function confirmDialog(title, message, { confirm = '확인', danger = false } = {}) {
  return openModal(title, h('p.muted', message), [
    { label: '취소' },
    { label: confirm, primary: true, kind: danger ? 'danger' : 'primary', value: () => true },
  ]);
}

// fields: [{name, label, value, type, options, placeholder, hint}], resolves to {name: value} or null
export function formDialog(title, fields, { confirm = '확인', message = '' } = {}) {
  const controls = {};
  const body = h('div.stack', message ? h('p.muted', message) : null, fields.map((item) => {
    let control;
    if (item.type === 'select') control = select(item.options, item.value);
    else if (item.type === 'file') control = h('input', { type: 'file', accept: item.accept || '' });
    else {
      control = h('input', {
        type: item.type === 'number' ? 'number' : 'text',
        value: item.value ?? '',
        placeholder: item.placeholder || '',
        step: item.step || 'any',
      });
    }
    controls[item.name] = control;
    return h('div.stack', { style: 'gap:4px' }, field(item.label, control), item.hint ? h('span.muted.small-text', item.hint) : null);
  }));
  return openModal(title, body, [
    { label: '취소' },
    {
      label: confirm,
      primary: true,
      kind: 'primary',
      value: () => {
        const values = {};
        for (const item of fields) {
          const control = controls[item.name];
          if (item.type === 'file') values[item.name] = control.files[0] || null;
          else if (item.type === 'number') values[item.name] = Number(control.value);
          else values[item.name] = control.value.trim();
          if (item.required !== false && (values[item.name] === '' || values[item.name] === null || Number.isNaN(values[item.name]))) {
            control.focus();
            toast(`${item.label} 항목을 입력하세요.`, 'error');
            return undefined;
          }
        }
        return values;
      },
    },
  ]);
}

export function degrees(radians) {
  return Math.round((radians * 180) / Math.PI * 10) / 10;
}

export function radians(value) {
  return (value * Math.PI) / 180;
}

export function formatTime(seconds) {
  const date = new Date(seconds * 1000);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((value) => String(value).padStart(2, '0')).join(':');
}

export function formatDate(seconds) {
  const date = new Date(seconds * 1000);
  return `${date.toLocaleDateString('ko-KR')} ${formatTime(seconds).slice(0, 5)}`;
}

export function newId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
