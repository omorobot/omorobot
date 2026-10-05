// Mapping > 맵 관리: saved maps
import { api, mapPath, store } from '../api.js';
import { h, clear, button, toast, formDialog, confirmDialog, formatDate } from '../ui.js';
import { fetchMaps, rememberMap } from '../components.js';

function mount(root) {
  const grid = h('div.map-grid');
  root.appendChild(h('div.stack', { style: 'gap:14px' },
    h('div.inline',
      h('p.muted.grow', '저장된 맵 목록입니다. 맵마다 위치 포인트가 함께 저장됩니다.'),
      button('맵 가져오기 (yaml + pgm)', { iconName: 'upload', onclick: importMap })),
    grid));
  load();

  async function load() {
    let maps = [];
    try {
      maps = await fetchMaps();
    } catch (error) {
      toast(error.message, 'error');
    }
    clear(grid);
    if (!maps.length) {
      grid.appendChild(h('div.card.empty', '저장된 맵이 없습니다. "맵 생성" 메뉴에서 맵을 만들거나 기존 맵 파일을 가져오세요.'));
      return;
    }
    const navMap = store.state ? store.state.nav.map : null;
    for (const map of maps) grid.appendChild(card(map, navMap === map.name));
  }

  function card(map, inUse) {
    const go = (route) => () => {
      rememberMap(map.name);
      location.hash = `#/${route}`;
    };
    return h('div.card.map-card',
      h('div.thumb', h('img', { src: `${mapPath(map.name)}/image.png?v=${map.version}`, alt: `${map.name} 맵`, loading: 'lazy' })),
      h('div.inline', h('div.name.grow', map.name),
        inUse ? h('span.badge.ok', '내비게이션 사용 중') : null,
        map.edited ? h('span.badge.plain', '수정됨') : null),
      h('dl.kv.small-text',
        h('dt', '크기'), h('dd', `${(map.width * map.resolution).toFixed(1)} m × ${(map.height * map.resolution).toFixed(1)} m (${map.width}×${map.height})`),
        h('dt', '해상도'), h('dd', `${map.resolution} m/px`),
        h('dt', '포인트'), h('dd', `${map.points}개`),
        h('dt', '수정일'), h('dd', formatDate(map.modified))),
      h('div.inline.wrap',
        button('포인트', { small: true, iconName: 'pin', onclick: go('points') }),
        button('수정', { small: true, iconName: 'edit', onclick: go('edit') }),
        button('', { small: true, iconName: 'copy', title: '복제', onclick: () => duplicate(map) }),
        button('', { small: true, iconName: 'download', title: '다운로드 (zip)', onclick: () => { location.href = `${mapPath(map.name)}/download`; } }),
        button('이름 변경', { small: true, onclick: () => rename(map) }),
        button('', { small: true, iconName: 'trash', kind: 'danger-ghost', title: '삭제', onclick: () => remove(map) })));
  }

  async function rename(map) {
    const values = await formDialog('맵 이름 변경', [{ name: 'name', label: '새 이름', value: map.name }],
      { confirm: '변경', message: '이 맵을 사용하는 Job도 새 이름으로 바뀝니다.' });
    if (!values || values.name === map.name) return;
    await api.post(`${mapPath(map.name)}/rename`, { name: values.name });
    await load();
  }

  async function duplicate(map) {
    const values = await formDialog('맵 복제', [{ name: 'name', label: '새 맵 이름', value: `${map.name}_copy` }], { confirm: '복제' });
    if (!values) return;
    await api.post(`${mapPath(map.name)}/duplicate`, { name: values.name });
    await load();
  }

  async function remove(map) {
    const yes = await confirmDialog('맵 삭제', `"${map.name}" 맵과 포인트 ${map.points}개를 삭제합니다. 되돌릴 수 없습니다.`, { confirm: '삭제', danger: true });
    if (!yes) return;
    await api.del(mapPath(map.name));
    await load();
  }

  async function importMap() {
    const values = await formDialog('맵 가져오기', [
      { name: 'name', label: '맵 이름', placeholder: '예: office_1f' },
      { name: 'yaml', label: 'yaml 파일', type: 'file', accept: '.yaml,.yml' },
      { name: 'image', label: '이미지 파일 (pgm / png)', type: 'file', accept: '.pgm,.png' },
    ], { confirm: '가져오기', message: 'map_saver 로 저장한 기존 맵 파일을 가져옵니다.' });
    if (!values) return;
    const data = new FormData();
    data.append('name', values.name);
    data.append('yaml', values.yaml);
    data.append('image', values.image);
    await api.upload('/api/maps/import', data);
    toast(`맵 "${values.name}" 을(를) 가져왔습니다.`, 'ok');
    await load();
  }

  return {};
}

export default { mount };
