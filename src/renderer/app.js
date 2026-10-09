'use strict';

/* global ICONS, FOLDER_SVG, fileSvg, DRIVE_SVG */

/* global api */
const $ = (sel) => document.querySelector(sel);
const contentEl = $('#content');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const INTERNAL_ROOT = '/storage/emulated/0';
const DRAG_MIME = 'application/x-macandroid';

const S = {
  platform: 'darwin',
  devices: [],
  places: [],
  adbError: null,
  mock: false,
  loc: { type: 'welcome' },
  history: [],
  hIndex: -1,
  entries: [],
  shown: [],
  loading: false,
  loadError: null,
  selection: new Set(),
  anchor: null,
  view: store('view') || 'grid',
  sort: { key: 'name', dir: 1 },
  search: '',
  gen: 0,
  clipboard: null, // { from: {kind,id}, paths, label }
  storages: {}, // deviceId -> [{label, path, total, free}]
  lastDeviceDir: {}, // deviceId -> folder last visited on that phone
  transfers: new Map(),
  thumbCache: new Map(),
  renaming: null,
  viewer: null,
  autoOpened: new Set(),
};

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem('macandroid.' + key);
    localStorage.setItem('macandroid.' + key, value);
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Sizes are wrapped in Unicode isolates so "29 GB" keeps its order inside Hebrew text.
const ltr = (s) => `\u2066${s}\u2069`;

function fmtSize(n) {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return ltr(`${n} B`);
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return ltr(`${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`);
}

const dateFmt = new Intl.DateTimeFormat('he-IL', { dateStyle: 'short', timeStyle: 'short' });
const fmtDate = (ms) => (ms ? dateFmt.format(new Date(ms)) : '');

function fmtDuration(sec) {
  if (!isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return `${Math.ceil(sec)} שנ׳`;
  if (sec < 3600) return `${Math.ceil(sec / 60)} דק׳`;
  return `${(sec / 3600).toFixed(1)} שע׳`;
}

const basename = (p) => p.replace(/\/+$/, '').split('/').pop() || '/';
const dirname = (p) => p.replace(/\/[^/]+\/?$/, '') || '/';
const joinPath = (a, b) => (a.endsWith('/') ? a + b : a + '/' + b);

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'dng'];
const VIDEO_EXT = ['mp4', 'mov', 'm4v', '3gp', 'mkv', 'webm', 'avi'];
const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac', 'amr'];
const DOC_EXT = ['txt', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'json', 'md', 'rtf', 'pages', 'numbers', 'key'];

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}
function kindOf(name) {
  const e = extOf(name);
  if (IMAGE_EXT.includes(e)) return 'image';
  if (VIDEO_EXT.includes(e)) return 'video';
  if (AUDIO_EXT.includes(e)) return 'audio';
  if (e === 'pdf') return 'pdf';
  if (e === 'apk') return 'apk';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return 'archive';
  if (DOC_EXT.includes(e)) return 'doc';
  return 'file';
}
const KIND_LABEL = {
  image: 'תמונה',
  video: 'סרטון',
  audio: 'שמע',
  pdf: 'PDF',
  apk: 'אפליקציה',
  archive: 'ארכיון',
  doc: 'מסמך',
  file: 'קובץ',
};
const isMedia = (e) => !e.isDir && ['image', 'video'].includes(kindOf(e.name));
const iconFor = (e) => (e.isDir ? FOLDER_SVG : fileSvg(kindOf(e.name), extOf(e.name)));

function fileUrl(p) {
  return 'file://' + p.split('/').map(encodeURIComponent).join('/');
}

let toastTimer = null;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), isError ? 5000 : 2600);
}

function errMsg(err) {
  const m = String((err && err.message) || err);
  // Strip Electron's "Error invoking remote method 'x': Error: " prefix.
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

const device = (id) => S.devices.find((d) => d.id === id);
const readyDevices = () => S.devices.filter((d) => d.state === 'device');
const isDir = (loc = S.loc) => loc.type === 'dir';
const isDeviceDir = (loc = S.loc) => loc.type === 'dir' && loc.kind === 'device';
const isLocalDir = (loc = S.loc) => loc.type === 'dir' && loc.kind === 'local';
const fsLoc = (loc = S.loc) => ({ kind: loc.kind, id: loc.id, path: loc.path });
const sameLoc = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function storageFor(id, p) {
  const list = S.storages[id] || [];
  return list.filter((s) => p === s.path || p.startsWith(s.path + '/')).sort((a, b) => b.path.length - a.path.length)[0];
}

/** Human title for a location (used in transfer titles and tooltips). */
function locTitle(loc) {
  if (loc.kind === 'device') {
    const st = storageFor(loc.id, loc.path);
    if (st && loc.path === st.path) return st.label;
    return basename(loc.path);
  }
  const place = S.places.find((p) => p.path === loc.path);
  return place ? place.label : basename(loc.path);
}

function navigate(loc, { push = true } = {}) {
  if (push) {
    S.history = S.history.slice(0, S.hIndex + 1);
    S.history.push(loc);
    S.hIndex = S.history.length - 1;
  }
  S.loc = loc;
  S.selection.clear();
  S.anchor = null;
  S.search = '';
  $('#search').value = '';
  S.entries = [];
  S.shown = [];
  S.loadError = null;
  S.gen++;
  if (isDeviceDir(loc)) S.lastDeviceDir[loc.id] = loc.path;
  renderAll();
  load();
}

function goBack() {
  if (S.hIndex > 0) {
    S.hIndex--;
    navigate(S.history[S.hIndex], { push: false });
  }
}
function goForward() {
  if (S.hIndex < S.history.length - 1) {
    S.hIndex++;
    navigate(S.history[S.hIndex], { push: false });
  }
}
function parentOf(loc) {
  if (loc.type !== 'dir') return null;
  if (loc.kind === 'device') {
    const st = storageFor(loc.id, loc.path);
    if (!st || loc.path === st.path || loc.path === '/') return { type: 'device-root', id: loc.id };
    return { ...loc, path: dirname(loc.path) };
  }
  if (loc.path === '/') return null;
  return { ...loc, path: dirname(loc.path) };
}
function goUp() {
  const p = parentOf(S.loc);
  if (p) navigate(p);
}

async function load() {
  const loc = S.loc;
  const gen = S.gen;
  if (loc.type === 'device-root') {
    if (device(loc.id)?.state === 'device') await refreshStorages(loc.id);
    if (gen === S.gen) renderContent();
    return;
  }
  if (!isDir(loc)) return;
  if (isDeviceDir(loc) && device(loc.id)?.state !== 'device') return renderAll();
  S.loading = true;
  // Only show the spinner if loading is actually slow.
  const spinTimer = setTimeout(() => gen === S.gen && S.loading && renderContent(), 150);
  try {
    if (isDeviceDir(loc) && !S.storages[loc.id]) refreshStorages(loc.id).then(renderStatus);
    const entries = await api.readdir(fsLoc(loc));
    if (gen !== S.gen) return;
    S.entries = entries;
    S.loadError = null;
  } catch (err) {
    if (gen !== S.gen) return;
    S.entries = [];
    S.loadError = errMsg(err);
  } finally {
    clearTimeout(spinTimer);
    if (gen === S.gen) S.loading = false;
  }
  applyView();
  renderContent();
  renderStatus();
  renderActionbar();
}

/** Re-read the current folder, keeping the selection where possible. */
async function reload() {
  if (!isDir()) return load();
  const keep = new Set(S.selection);
  const gen = S.gen;
  try {
    const entries = await api.readdir(fsLoc());
    if (gen !== S.gen) return;
    S.entries = entries;
    S.loadError = null;
  } catch (err) {
    S.loadError = errMsg(err);
  }
  const paths = new Set(S.entries.map((e) => e.path));
  S.selection = new Set([...keep].filter((p) => paths.has(p)));
  applyView();
  renderContent();
  renderStatus();
  renderActionbar();
  if (isDeviceDir()) refreshStorages(S.loc.id).then(renderStatus);
}

async function refreshStorages(id) {
  try {
    S.storages[id] = await api.storages(id);
  } catch {
    S.storages[id] = S.storages[id] || [{ id: 'internal', label: 'אחסון פנימי', path: INTERNAL_ROOT, type: 'internal' }];
  }
  renderSidebar();
}

function showHidden() {
  return store('hidden') === '1';
}

function applyView() {
  const q = S.search.trim().toLowerCase();
  let list = S.entries.filter((e) => showHidden() || !e.name.startsWith('.'));
  if (q) list = list.filter((e) => e.name.toLowerCase().includes(q));
  const { key, dir } = S.sort;
  const collator = new Intl.Collator('he', { numeric: true, sensitivity: 'base' });
  list = list.slice().sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let r = 0;
    if (key === 'size') r = (a.size || 0) - (b.size || 0);
    else if (key === 'mtime') r = (a.mtime || 0) - (b.mtime || 0);
    else if (key === 'kind') r = collator.compare(a.isDir ? '' : KIND_LABEL[kindOf(a.name)], b.isDir ? '' : KIND_LABEL[kindOf(b.name)]);
    if (r === 0) r = collator.compare(a.name, b.name);
    return r * dir;
  });
  S.shown = list;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll() {
  renderSidebar();
  renderToolbar();
  renderActionbar();
  renderContent();
  renderStatus();
}

function renderSidebar() {
  const devList = $('#device-list');
  if (!S.devices.length) {
    devList.innerHTML = `<li class="nav-empty">${S.adbError ? 'ADB לא זמין' : 'אין מכשיר מחובר'}</li>`;
  } else {
    devList.innerHTML = S.devices
      .map((d) => {
        const active = S.loc.id === d.id && (S.loc.type === 'device-root');
        let html = `<li class="nav-item ${active ? 'active' : ''} ${d.state !== 'device' ? 'pending' : ''}" data-nav="device-root" data-id="${esc(d.id)}">
          ${ICONS.phone}<span class="label">${esc(d.name)}</span>
          ${d.state === 'device' ? '<span class="dot"></span>' : '<span class="dot warn"></span>'}
        </li>`;
        if (d.state === 'device') {
          const sts = S.storages[d.id] || [{ id: 'internal', label: 'אחסון פנימי', path: INTERNAL_ROOT, type: 'internal' }];
          for (const st of sts) {
            const on = isDeviceDir() && S.loc.id === d.id && storageFor(d.id, S.loc.path)?.path === st.path;
            html += `<li class="nav-item sub ${on ? 'active' : ''}" data-nav="device-dir" data-id="${esc(d.id)}" data-path="${esc(st.path)}" data-drop="device">
              ${st.type === 'sd' ? ICONS.sd : ICONS.folderSmall}<span class="label">${esc(st.label)}</span>
            </li>`;
          }
        }
        return html;
      })
      .join('');
  }

  $('#places').innerHTML = S.places
    .map((p) => {
      const on = isLocalDir() && S.loc.path === p.path;
      return `<li class="nav-item ${on ? 'active' : ''}" data-nav="local-dir" data-path="${esc(p.path)}" data-drop="local">
        ${ICONS[p.icon] || ICONS.folderSmall}<span class="label">${esc(p.label)}</span>
      </li>`;
    })
    .join('');
}

function crumbsFor(loc) {
  const out = [];
  if (loc.type === 'welcome') return [{ label: 'MacAndroid' }];
  if (loc.kind === 'device' || loc.type === 'device-root') {
    const d = device(loc.id);
    out.push({ label: d ? d.name : loc.id, loc: { type: 'device-root', id: loc.id } });
    if (loc.type === 'dir') {
      const st = storageFor(loc.id, loc.path) || { path: '/', label: '/' };
      out.push({ label: st.label, loc: { type: 'dir', kind: 'device', id: loc.id, path: st.path } });
      const rest = loc.path.slice(st.path.length).split('/').filter(Boolean);
      let acc = st.path;
      for (const part of rest) {
        acc = joinPath(acc, part);
        out.push({ label: part, loc: { type: 'dir', kind: 'device', id: loc.id, path: acc } });
      }
    }
    return out;
  }
  // Mac path: start from the home folder when inside it.
  const home = S.places.find((p) => p.id === 'home');
  let base = '/';
  if (home && (loc.path === home.path || loc.path.startsWith(home.path + '/'))) {
    base = home.path;
    out.push({ label: home.label, loc: { type: 'dir', kind: 'local', path: home.path } });
  } else {
    out.push({ label: 'Macintosh HD', loc: { type: 'dir', kind: 'local', path: '/' } });
  }
  let acc = base;
  for (const part of loc.path.slice(base.length).split('/').filter(Boolean)) {
    acc = joinPath(acc, part);
    out.push({ label: part, loc: { type: 'dir', kind: 'local', path: acc } });
  }
  return out;
}

function renderToolbar() {
  $('#btn-back').disabled = S.hIndex <= 0;
  $('#btn-forward').disabled = S.hIndex >= S.history.length - 1;
  $('#btn-up').disabled = !parentOf(S.loc);
  $('#view-grid').classList.toggle('on', S.view === 'grid');
  $('#view-list').classList.toggle('on', S.view === 'list');
  $('#search').disabled = !isDir();
  const crumbs = crumbsFor(S.loc);
  $('#breadcrumbs').innerHTML = crumbs
    .map(
      (c, i) =>
        `${i ? '<span class="crumb-sep">›</span>' : ''}<span class="crumb" data-crumb="${i}" ${
          c.loc && c.loc.type === 'dir' ? 'data-drop="crumb"' : ''
        } title="${esc(c.label)}">${esc(c.label)}</span>`
    )
    .join('');
  $('#breadcrumbs').querySelectorAll('.crumb').forEach((el) => {
    el._loc = crumbs[Number(el.dataset.crumb)].loc;
  });
  // Keep the deepest folder visible when the path is long (RTL: scroll to the left end).
  $('#breadcrumbs').scrollLeft = -$('#breadcrumbs').scrollWidth;
}

function selectedEntries() {
  return S.shown.filter((e) => S.selection.has(e.path));
}

function renderActionbar() {
  const bar = $('#actionbar');
  const sel = selectedEntries();
  const n = sel.length;
  const canPaste = Boolean(S.clipboard);
  if (isDeviceDir()) {
    bar.innerHTML = `
      <button class="btn primary" data-act="copy-to-mac" ${n ? '' : 'disabled'}>${ICONS.download}העתק למחשב${n ? ` <span class="sub">(${n})</span>` : ''}</button>
      <button class="btn" data-act="add-from-mac">${ICONS.upload}הוסף קבצים מהמחשב</button>
      <button class="btn" data-act="new-folder">${ICONS.folderPlus}תיקייה חדשה</button>
      <button class="btn" data-act="copy" ${n ? '' : 'disabled'} title="⌘C">${ICONS.copy}העתק</button>
      <button class="btn" data-act="paste" ${canPaste ? '' : 'disabled'} title="⌘V">${ICONS.paste}הדבק</button>
      <button class="btn danger" data-act="delete" ${n ? '' : 'disabled'}>${ICONS.trash}מחק</button>
      <span class="spacer"></span>
      <button class="icon-btn" data-act="refresh" title="רענן (⌘R)">${ICONS.refresh}</button>`;
  } else if (isLocalDir()) {
    const d = readyDevices()[0];
    const target = d ? S.lastDeviceDir[d.id] || joinPath(INTERNAL_ROOT, 'Download') : null;
    const targetLabel = d ? (storageFor(d.id, target)?.path === target ? 'אחסון פנימי' : basename(target)) : '';
    bar.innerHTML = `
      <button class="btn primary" data-act="copy-to-phone" ${n && d ? '' : 'disabled'} title="${d ? esc('יעד: ' + target) : 'חבר טלפון'}">${ICONS.upload}העתק לטלפון${
        d ? ` <span class="sub">← ${esc(targetLabel)}</span>` : ''
      }</button>
      <button class="btn" data-act="new-folder">${ICONS.folderPlus}תיקייה חדשה</button>
      <button class="btn" data-act="copy" ${n ? '' : 'disabled'} title="⌘C">${ICONS.copy}העתק</button>
      <button class="btn" data-act="paste" ${canPaste ? '' : 'disabled'} title="⌘V">${ICONS.paste}הדבק</button>
      <button class="btn danger" data-act="delete" ${n ? '' : 'disabled'}>${ICONS.trash}העבר לפח</button>
      <span class="spacer"></span>
      <button class="icon-btn" data-act="refresh" title="רענן (⌘R)">${ICONS.refresh}</button>`;
  } else {
    bar.innerHTML = '';
  }
}

function renderStatus() {
  const left = $('#status-left');
  const right = $('#status-right');
  left.textContent = '';
  right.textContent = '';
  if (isDir()) {
    const sel = selectedEntries();
    let txt = `${S.shown.length} פריטים`;
    if (sel.length) {
      const bytes = sel.filter((e) => !e.isDir).reduce((a, e) => a + (e.size || 0), 0);
      txt += `  ·  נבחרו ${sel.length}${bytes ? ` (${fmtSize(bytes)})` : ''}`;
    }
    left.textContent = txt;
    if (isDeviceDir()) {
      const st = storageFor(S.loc.id, S.loc.path);
      if (st && st.free != null) right.textContent = `${fmtSize(st.free)} פנויים מתוך ${fmtSize(st.total)}`;
    }
  } else if (S.loc.type === 'device-root') {
    const d = device(S.loc.id);
    if (d && d.android) right.textContent = `Android ${d.android}`;
  }
}

function renderContent() {
  const loc = S.loc;
  thumbObserver.disconnect();
  contentEl.classList.remove('drop-active');

  if (loc.type === 'welcome') return renderWelcome();

  const d = loc.kind === 'device' || loc.type === 'device-root' ? device(loc.id) : null;
  if ((loc.kind === 'device' || loc.type === 'device-root') && (!d || d.state !== 'device')) return renderDeviceState(d);
  if (loc.type === 'device-root') return renderDrives(d);

  if (S.loading && !S.entries.length) {
    contentEl.innerHTML = `<div class="empty"><div class="spinner"></div></div>`;
    return;
  }
  if (S.loadError) {
    contentEl.innerHTML = `<div class="empty"><h2>לא ניתן לפתוח את התיקייה</h2><p>${esc(S.loadError)}</p>
      <p><button class="btn" data-act="refresh">נסה שוב</button></p></div>`;
    return;
  }
  if (!S.shown.length) {
    contentEl.innerHTML = `<div class="empty"><p>${S.search ? 'לא נמצאו פריטים' : 'התיקייה ריקה'}</p>
      ${isDeviceDir() && !S.search ? '<p class="muted">גרור לכאן קבצים מה-Finder כדי להעתיק אותם לטלפון</p>' : ''}</div>`;
    return;
  }
  if (S.view === 'list') renderList();
  else renderGrid();
  observeThumbs();
}

function thumbKey(e) {
  return `${S.loc.kind}|${S.loc.id || ''}|${e.path}|${e.size}|${e.mtime}`;
}

function thumbHtml(e, mini = false) {
  const cached = S.thumbCache.get(thumbKey(e));
  const play = !mini && kindOf(e.name) === 'video' ? `<span class="play">${ICONS.play}</span>` : '';
  if (cached) return `<img src="${esc(fileUrl(cached))}" alt="" draggable="false">${play}`;
  return iconFor(e) + play;
}

function renderGrid() {
  const html = S.shown
    .map((e, i) => {
      const sel = S.selection.has(e.path) ? 'selected' : '';
      return `<div class="tile ${sel}" data-i="${i}" draggable="true" ${e.isDir ? 'data-drop="folder"' : ''} title="${esc(e.name)}${
        e.isDir ? '' : '\n' + fmtSize(e.size)
      }">
        <div class="thumb" ${isMedia(e) ? 'data-thumb="1"' : ''}>${thumbHtml(e)}</div>
        <div class="name">${esc(e.name)}</div>
      </div>`;
    })
    .join('');
  contentEl.innerHTML = `<div class="grid">${html}</div>`;
}

function renderList() {
  const col = (key, label, width) => {
    const sorted = S.sort.key === key;
    return `<th data-sort="${key}" class="${sorted ? 'sorted' : ''} ${sorted && S.sort.dir === 1 ? 'asc' : ''}" style="${width ? `width:${width}` : ''}">${label}</th>`;
  };
  const rows = S.shown
    .map((e, i) => {
      const sel = S.selection.has(e.path) ? 'selected' : '';
      return `<tr class="row ${sel}" data-i="${i}" draggable="true" ${e.isDir ? 'data-drop="folder"' : ''}>
        <td><div class="cell-name"><span class="mini" ${isMedia(e) ? 'data-thumb="1"' : ''}>${thumbHtml(e, true)}</span><span class="name">${esc(e.name)}</span></div></td>
        <td class="date">${fmtDate(e.mtime)}</td>
        <td>${e.isDir ? 'תיקייה' : KIND_LABEL[kindOf(e.name)]}</td>
        <td class="num">${e.isDir ? '' : fmtSize(e.size)}</td>
      </tr>`;
    })
    .join('');
  contentEl.innerHTML = `<table class="list"><thead><tr>${col('name', 'שם')}${col('mtime', 'תאריך שינוי', '150px')}${col(
    'kind',
    'סוג',
    '100px'
  )}${col('size', 'גודל', '90px')}</tr></thead><tbody>${rows}</tbody></table>`;
}

async function renderDrives(d) {
  const sts = S.storages[d.id];
  if (!sts) {
    contentEl.innerHTML = `<div class="empty"><div class="spinner"></div></div>`;
    return;
  }
  const drives = sts
    .map((st, i) => {
      const pct = st.total ? Math.round(((st.total - st.free) / st.total) * 100) : 0;
      return `<div class="drive" data-drive="${i}" data-drop="drive">
        ${DRIVE_SVG(st.type)}
        <div class="info">
          <div class="title">${esc(st.label)}</div>
          ${
            st.total
              ? `<div class="bar ${pct > 90 ? 'full' : ''}"><div style="width:${pct}%"></div></div>
                 <div class="muted">${fmtSize(st.free)} פנויים מתוך ${fmtSize(st.total)}</div>`
              : '<div class="muted">לחץ פעמיים לפתיחה</div>'
          }
        </div>
      </div>`;
    })
    .join('');
  contentEl.innerHTML = `<div class="drives"><h2>${esc(d.name)}</h2>${drives}
    <div class="shortcuts" id="shortcuts"></div></div>`;
  contentEl.querySelectorAll('.drive').forEach((el) => (el._loc = { type: 'dir', kind: 'device', id: d.id, path: sts[Number(el.dataset.drive)].path }));

  // Quick links to the folders people usually want.
  const candidates = [
    { label: 'מצלמה', path: `${INTERNAL_ROOT}/DCIM/Camera` },
    { label: 'צילומי מסך', path: `${INTERNAL_ROOT}/Pictures/Screenshots` },
    { label: 'צילומי מסך', path: `${INTERNAL_ROOT}/DCIM/Screenshots` },
    { label: 'הורדות', path: `${INTERNAL_ROOT}/Download` },
    { label: 'WhatsApp', path: `${INTERNAL_ROOT}/Android/media/com.whatsapp/WhatsApp/Media` },
    { label: 'WhatsApp', path: `${INTERNAL_ROOT}/WhatsApp/Media` },
    { label: 'מסמכים', path: `${INTERNAL_ROOT}/Documents` },
  ];
  const gen = S.gen;
  const exists = new Set();
  const parents = [...new Set(candidates.map((c) => dirname(c.path)))];
  await Promise.all(
    parents.map(async (p) => {
      try {
        for (const e of await api.readdir({ kind: 'device', id: d.id, path: p })) if (e.isDir) exists.add(e.path);
      } catch {}
    })
  );
  if (gen !== S.gen) return;
  const seen = new Set();
  const found = candidates.filter((c) => exists.has(c.path) && !seen.has(c.label) && seen.add(c.label));
  const box = $('#shortcuts');
  if (!box || !found.length) return;
  box.innerHTML = `<h2>תיקיות נפוצות</h2><div class="grid">${found
    .map((c, i) => `<div class="tile" data-shortcut="${i}" data-drop="shortcut"><div class="thumb">${FOLDER_SVG}</div><div class="name">${esc(c.label)}</div></div>`)
    .join('')}</div>`;
  box.querySelectorAll('[data-shortcut]').forEach((el) => (el._loc = { type: 'dir', kind: 'device', id: d.id, path: found[Number(el.dataset.shortcut)].path }));
}

function renderWelcome() {
  if (S.adbError && S.adbError.code === 'NO_ADB') {
    contentEl.innerHTML = `<div class="empty">
      <div class="big-icon">${ICONS.usb}</div>
      <h2>לא נמצא רכיב ADB</h2>
      <p>האפליקציה צריכה את הכלי adb של Google כדי לדבר עם הטלפון.</p>
      <ol class="steps"><li>בגרסה הארוזה של האפליקציה הוא כלול מראש.</li>
      <li>בהרצה מקוד המקור: הרץ <b dir="ltr" style="white-space:nowrap">npm run fetch-adb</b>, או התקן עם <b dir="ltr" style="white-space:nowrap">brew install android-platform-tools</b>.</li></ol>
    </div>`;
    return;
  }
  contentEl.innerHTML = `<div class="empty">
    <div class="big-icon">${ICONS.usb}</div>
    <h2>חבר טלפון אנדרואיד בכבל USB</h2>
    <p>ברגע שהטלפון יתחבר הוא יופיע כאן, ותוכל להיכנס אליו כמו לכל תיקייה.</p>
    <ol class="steps">
      <li>בטלפון: <b>הגדרות ← אודות הטלפון</b> ← לחץ 7 פעמים על <b>מספר Build</b> (בסמסונג: מידע על התוכנה).</li>
      <li>חזור להגדרות ← <b>אפשרויות מפתח</b> ← הפעל <b>ניפוי באגים ב-USB</b>.</li>
      <li>חבר את הכבל, ובחלון שקופץ בטלפון לחץ <b>אפשר</b> (מומלץ לסמן "אפשר תמיד ממחשב זה").</li>
    </ol>
    <p class="muted" style="margin-top:14px">טיפ: כבל USB-C איכותי ויציאה ישירה במחשב (לא דרך מפצל) נותנים את המהירות הגבוהה ביותר.</p>
  </div>`;
}

function renderDeviceState(d) {
  if (!d) {
    contentEl.innerHTML = `<div class="empty"><div class="big-icon">${ICONS.phone}</div><h2>המכשיר נותק</h2><p>חבר אותו שוב כדי להמשיך.</p></div>`;
  } else if (d.state === 'unauthorized') {
    contentEl.innerHTML = `<div class="empty"><div class="big-icon">${ICONS.phone}</div>
      <h2>אשר את החיבור בטלפון</h2>
      <p>בטלפון הופיעה הודעה <b>"לאפשר ניפוי באגים ב-USB?"</b>. סמן "אפשר תמיד ממחשב זה" ולחץ <b>אפשר</b>.</p>
      <p class="muted">לא רואה הודעה? נתק וחבר את הכבל, או בטל ואשר מחדש את "ניפוי באגים ב-USB".</p></div>`;
  } else {
    contentEl.innerHTML = `<div class="empty"><div class="spinner"></div><p style="margin-top:12px">מתחבר ל-${esc(d.name)}…</p></div>`;
  }
}

// ---------------------------------------------------------------------------
// Thumbnails (loaded lazily as tiles scroll into view)
// ---------------------------------------------------------------------------

const thumbObserver = new IntersectionObserver(
  (items) => {
    for (const it of items) {
      if (!it.isIntersecting) continue;
      thumbObserver.unobserve(it.target);
      requestThumb(it.target);
    }
  },
  { root: contentEl, rootMargin: '300px' }
);

function observeThumbs() {
  contentEl.querySelectorAll('[data-thumb]').forEach((el) => {
    const row = el.closest('[data-i]');
    const e = S.shown[Number(row.dataset.i)];
    if (e && !S.thumbCache.has(thumbKey(e))) thumbObserver.observe(el);
  });
}

async function requestThumb(el) {
  const row = el.closest('[data-i]');
  if (!row) return;
  const e = S.shown[Number(row.dataset.i)];
  const gen = S.gen;
  const loc = fsLoc();
  const p = await api.thumb(loc, e, gen);
  if (!p) return;
  S.thumbCache.set(`${loc.kind}|${loc.id || ''}|${e.path}|${e.size}|${e.mtime}`, p);
  if (gen !== S.gen || !el.isConnected) return;
  el.innerHTML = thumbHtml(e, el.classList.contains('mini'));
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function updateSelectionUI() {
  contentEl.querySelectorAll('[data-i]').forEach((el) => {
    const e = S.shown[Number(el.dataset.i)];
    el.classList.toggle('selected', Boolean(e && S.selection.has(e.path)));
  });
  renderActionbar();
  renderStatus();
}

function selectIndex(i, { toggle = false, range = false } = {}) {
  const e = S.shown[i];
  if (!e) return;
  if (range && S.anchor != null) {
    const a = Math.min(S.anchor, i);
    const b = Math.max(S.anchor, i);
    if (!toggle) S.selection.clear();
    for (let k = a; k <= b; k++) S.selection.add(S.shown[k].path);
  } else if (toggle) {
    if (S.selection.has(e.path)) S.selection.delete(e.path);
    else S.selection.add(e.path);
    S.anchor = i;
  } else {
    S.selection = new Set([e.path]);
    S.anchor = i;
  }
  updateSelectionUI();
}

function focusIndex() {
  if (S.anchor != null && S.selection.has(S.shown[S.anchor]?.path)) return S.anchor;
  const i = S.shown.findIndex((e) => S.selection.has(e.path));
  return i;
}

function scrollIntoView(i) {
  const el = contentEl.querySelector(`[data-i="${i}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function openEntry(e) {
  if (e.isDir) {
    navigate({ ...S.loc, path: e.path });
  } else if (isMedia(e)) {
    openViewer(e);
  } else {
    openExternal(e);
  }
}

async function openExternal(e) {
  if (!isLocalDir()) toast(`פותח את ${e.name}…`);
  try {
    await api.open(fsLoc(), e);
  } catch (err) {
    toast(errMsg(err), true);
  }
}

function transferTitle(from, to, count) {
  const what = count === 1 ? 'פריט אחד' : `${count} פריטים`;
  if (from.kind === 'device' && to.kind === 'local') return `${what} מהטלפון ← ${locTitle(to)}`;
  if (from.kind === 'local' && to.kind === 'device') return `${what} מהמחשב ← ${locTitle(to)}`;
  return `${what} ← ${locTitle(to)}`;
}

async function startTransfer(from, paths, to) {
  if (!paths.length) return;
  if (from.kind === to.kind && from.id === to.id && paths.some((p) => to.path === p || to.path.startsWith(p + '/'))) {
    toast('לא ניתן להעתיק תיקייה לתוך עצמה', true);
    return;
  }
  const meta = { title: transferTitle(from, to, paths.length), dstKey: JSON.stringify({ kind: to.kind, id: to.id, path: to.path }) };
  try {
    await api.startTransfer({ from: { kind: from.kind, id: from.id }, items: paths, to: { kind: to.kind, id: to.id, path: to.path }, meta });
    $('#transfers').classList.remove('hidden');
  } catch (err) {
    toast(errMsg(err), true);
  }
}

async function copyToMac(entries = selectedEntries()) {
  if (!entries.length) return;
  const dir = await api.chooseFolder(`לאן להעתיק ${entries.length === 1 ? `את "${entries[0].name}"` : `${entries.length} פריטים`}?`);
  if (!dir) return;
  startTransfer(fsLoc(), entries.map((e) => e.path), { kind: 'local', path: dir });
}

function phoneTarget() {
  const d = readyDevices()[0];
  if (!d) return null;
  return { kind: 'device', id: d.id, path: S.lastDeviceDir[d.id] || joinPath(INTERNAL_ROOT, 'Download') };
}

function copyToPhone(entries = selectedEntries()) {
  const to = phoneTarget();
  if (!to) return toast('לא מחובר טלפון', true);
  startTransfer(fsLoc(), entries.map((e) => e.path), to);
}

async function addFromMac() {
  const files = await api.chooseFiles('בחר קבצים או תיקיות להעתקה לטלפון');
  if (files.length) startTransfer({ kind: 'local' }, files, fsLoc());
}

function copySelection() {
  const sel = selectedEntries();
  if (!sel.length) return;
  S.clipboard = { from: { kind: S.loc.kind, id: S.loc.id }, paths: sel.map((e) => e.path), at: Date.now() };
  toast(sel.length === 1 ? `"${sel[0].name}" הועתק. עבור לתיקייה אחרת ולחץ ⌘V` : `${sel.length} פריטים הועתקו. עבור לתיקייה אחרת ולחץ ⌘V`);
  renderActionbar();
}

async function paste() {
  if (!isDir()) return;
  // Files copied in Finder take part too, so ⌘C in Finder + ⌘V here sends them to the phone.
  const finder = await api.finderClipboard();
  if (finder.length && (!S.clipboard || S.clipboard.from.kind === 'local')) {
    const sameAsInternal = S.clipboard && finder.every((p) => S.clipboard.paths.includes(p));
    if (!sameAsInternal) return startTransfer({ kind: 'local' }, finder, fsLoc());
  }
  if (!S.clipboard) return;
  startTransfer(S.clipboard.from, S.clipboard.paths, fsLoc());
}

async function newFolder() {
  try {
    const p = await api.mkdir(fsLoc(), 'תיקייה חדשה');
    await reload();
    const i = S.shown.findIndex((e) => e.path === p);
    if (i >= 0) {
      selectIndex(i);
      scrollIntoView(i);
      startRename(i);
    }
  } catch (err) {
    toast(errMsg(err), true);
  }
}

async function deleteSelection() {
  const sel = selectedEntries();
  if (!sel.length) return;
  const onPhone = isDeviceDir();
  const what = sel.length === 1 ? `"${sel[0].name}"` : `${sel.length} פריטים`;
  const ok = await api.confirm(
    onPhone
      ? { message: `למחוק את ${what} מהטלפון?`, detail: 'המחיקה מהטלפון היא סופית ולא ניתן לבטל אותה.', ok: 'מחק' }
      : { message: `להעביר את ${what} לפח?`, ok: 'העבר לפח' }
  );
  if (!ok) return;
  try {
    await api.remove(fsLoc(), sel.map((e) => e.path));
    toast(onPhone ? 'נמחק' : 'הועבר לפח');
  } catch (err) {
    toast(errMsg(err), true);
  }
  reload();
}

function startRename(i) {
  const e = S.shown[i];
  const el = contentEl.querySelector(`[data-i="${i}"] .name`);
  if (!e || !el) return;
  S.renaming = e.path;
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = e.name;
  el.replaceWith(input);
  input.focus();
  const dot = e.isDir ? -1 : e.name.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : e.name.length);
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    S.renaming = null;
    const name = input.value.trim();
    if (commit && name && name !== e.name) {
      try {
        const to = await api.rename(fsLoc(), e.path, name);
        S.selection = new Set([to]);
      } catch (err) {
        toast(errMsg(err), true);
      }
    }
    await reload();
    contentEl.focus();
  };
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') finish(true);
    if (ev.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('mousedown', (ev) => ev.stopPropagation());
  input.addEventListener('dblclick', (ev) => ev.stopPropagation());
}

function runAction(act) {
  switch (act) {
    case 'copy-to-mac':
      return copyToMac();
    case 'copy-to-phone':
      return copyToPhone();
    case 'add-from-mac':
      return addFromMac();
    case 'new-folder':
      return newFolder();
    case 'copy':
      return copySelection();
    case 'paste':
      return paste();
    case 'delete':
      return deleteSelection();
    case 'refresh':
      return reload();
  }
}

async function showContextMenu(ev) {
  if (!isDir()) return;
  const row = ev.target.closest('[data-i]');
  if (row) {
    const i = Number(row.dataset.i);
    if (!S.selection.has(S.shown[i].path)) selectIndex(i);
  } else {
    S.selection.clear();
    updateSelectionUI();
  }
  const sel = selectedEntries();
  const one = sel.length === 1 ? sel[0] : null;
  const onPhone = isDeviceDir();
  const hasPhone = readyDevices().length > 0;
  const tpl = [];
  if (sel.length) {
    if (one) tpl.push({ id: 'open', label: one.isDir ? 'פתח' : isMedia(one) ? 'הצג' : 'פתח' });
    if (one && !one.isDir) tpl.push({ id: 'open-external', label: 'פתח באפליקציה ברירת מחדל' });
    tpl.push({ type: 'separator' });
    if (onPhone) tpl.push({ id: 'copy-to-mac', label: 'העתק למחשב…' });
    else tpl.push({ id: 'copy-to-phone', label: 'העתק לטלפון', enabled: hasPhone });
    tpl.push({ id: 'copy', label: 'העתק', accelerator: 'CmdOrCtrl+C' });
    tpl.push({ type: 'separator' });
    if (one) tpl.push({ id: 'rename', label: 'שנה שם', accelerator: 'F2' });
    tpl.push({ id: 'delete', label: onPhone ? 'מחק' : 'העבר לפח' });
    if (!onPhone && one) tpl.push({ type: 'separator' }, { id: 'reveal', label: 'הצג ב-Finder' });
  } else {
    tpl.push({ id: 'paste', label: 'הדבק', accelerator: 'CmdOrCtrl+V' });
    tpl.push({ id: 'new-folder', label: 'תיקייה חדשה' });
    if (onPhone) tpl.push({ id: 'add-from-mac', label: 'הוסף קבצים מהמחשב…' });
    tpl.push({ type: 'separator' });
    tpl.push({ id: 'toggle-hidden', label: showHidden() ? 'הסתר קבצים מוסתרים' : 'הצג קבצים מוסתרים' });
    tpl.push({ id: 'refresh', label: 'רענן' });
  }
  const id = await api.popupMenu(tpl);
  if (!id) return;
  if (id === 'open') openEntry(one);
  else if (id === 'open-external') openExternal(one);
  else if (id === 'rename') startRename(S.shown.indexOf(one));
  else if (id === 'reveal') api.reveal(one.path);
  else if (id === 'toggle-hidden') {
    store('hidden', showHidden() ? '0' : '1');
    applyView();
    renderContent();
    renderStatus();
  } else runAction(id);
}

// ---------------------------------------------------------------------------
// Viewer (in-app photo / video preview with next / previous)
// ---------------------------------------------------------------------------

function openViewer(entry) {
  const list = S.shown.filter(isMedia);
  S.viewer = { list, index: list.indexOf(entry), loc: fsLoc(), token: 0 };
  $('#viewer').classList.remove('hidden');
  showViewerItem();
}

function closeViewer() {
  if (!S.viewer) return;
  const cur = S.viewer.list[S.viewer.index];
  S.viewer = null;
  $('#viewer-stage').innerHTML = '';
  $('#viewer').classList.add('hidden');
  const i = S.shown.indexOf(cur);
  if (i >= 0) {
    selectIndex(i);
    scrollIntoView(i);
  }
  contentEl.focus();
}

async function showViewerItem() {
  const v = S.viewer;
  if (!v) return;
  const e = v.list[v.index];
  const token = ++v.token;
  $('#viewer-title').textContent = `${e.name}  ·  ${v.index + 1}/${v.list.length}  ·  ${fmtSize(e.size)}`;
  $('#viewer-prev').disabled = v.index <= 0;
  $('#viewer-next').disabled = v.index >= v.list.length - 1;
  $('#viewer-copy').classList.toggle('hidden', v.loc.kind !== 'device');
  const stage = $('#viewer-stage');
  const cached = S.thumbCache.get(`${v.loc.kind}|${v.loc.id || ''}|${e.path}|${e.size}|${e.mtime}`);
  // Show the thumbnail immediately while the full file loads.
  stage.innerHTML = cached ? `<img src="${esc(fileUrl(cached))}" style="filter:blur(2px)">` : `<div class="spinner"></div>`;
  try {
    const p = await api.preview(v.loc, e);
    if (!S.viewer || token !== v.token) return;
    const url = fileUrl(p);
    if (kindOf(e.name) === 'video') {
      stage.innerHTML = `<video src="${esc(url)}" controls autoplay></video>`;
      stage.querySelector('video').addEventListener('error', () => {
        stage.innerHTML = `<div class="viewer-msg">לא ניתן לנגן את הסרטון כאן.<br><br><button class="btn" id="viewer-fallback">פתח ב-QuickTime</button></div>`;
        $('#viewer-fallback').onclick = () => api.open(v.loc, e);
      });
    } else {
      const img = new Image();
      img.onload = () => token === v.token && stage.replaceChildren(img);
      img.onerror = async () => {
        // Formats Chromium cannot draw (HEIC, DNG): fall back to a large Quick Look thumbnail if we have one.
        if (token !== v.token) return;
        stage.innerHTML = cached
          ? `<img src="${esc(fileUrl(cached))}">`
          : `<div class="viewer-msg">אין תצוגה מקדימה לקובץ הזה.<br><br><button class="btn" id="viewer-fallback">פתח ב-Preview</button></div>`;
        const fb = $('#viewer-fallback');
        if (fb) fb.onclick = () => api.open(v.loc, e);
      };
      img.src = url;
    }
  } catch (err) {
    if (token === v.token) stage.innerHTML = `<div class="viewer-msg">${esc(errMsg(err))}</div>`;
  }
}

function viewerStep(d) {
  const v = S.viewer;
  if (!v) return;
  const n = v.index + d;
  if (n < 0 || n >= v.list.length) return;
  v.index = n;
  showViewerItem();
}

// ---------------------------------------------------------------------------
// Transfers panel and conflict prompt
// ---------------------------------------------------------------------------

function renderTransfers() {
  const jobs = [...S.transfers.values()].reverse();
  $('#transfer-list').innerHTML = jobs
    .map((j) => {
      const pct = j.totalBytes ? Math.min(100, (j.doneBytes / j.totalBytes) * 100) : j.state === 'done' ? 100 : 0;
      let line = '';
      if (j.state === 'queued') line = 'ממתין…';
      else if (j.state === 'scanning') line = 'מכין רשימת קבצים…';
      else if (j.state === 'running') {
        const eta = j.speed ? (j.totalBytes - j.doneBytes) / j.speed : 0;
        line = `${fmtSize(j.doneBytes)} מתוך ${fmtSize(j.totalBytes)}${j.speed ? ` · ${fmtSize(j.speed)}/שנ׳` : ''}${eta ? ` · נותרו ${fmtDuration(eta)}` : ''}`;
      } else if (j.state === 'done') line = `הושלם · ${j.filesDone} קבצים · ${fmtSize(j.totalBytes)}`;
      else if (j.state === 'cancelled') line = 'בוטל';
      const active = ['queued', 'scanning', 'running'].includes(j.state);
      return `<div class="transfer ${j.state}">
        <div class="row1"><span class="title">${esc(j.meta.title || 'העברה')}</span>
          ${active ? `<button class="link-btn" data-cancel="${j.id}">ביטול</button>` : ''}</div>
        <div class="bar"><div style="width:${pct}%"></div></div>
        <div class="muted">${esc(line)}</div>
        ${j.state === 'running' && j.current ? `<div class="muted current">${esc(j.current)} (${j.filesDone + 1}/${j.filesTotal})</div>` : ''}
        ${j.error ? `<div class="err">${esc(j.error)}</div>` : ''}
      </div>`;
    })
    .join('');
  if (!jobs.length) $('#transfers').classList.add('hidden');
}

function onTransferUpdate(job) {
  const prev = S.transfers.get(job.id);
  S.transfers.set(job.id, job);
  renderTransfers();
  const finished = prev && prev.state !== job.state && ['done', 'error', 'cancelled'].includes(job.state);
  if (!finished) return;
  if (job.state === 'done') toast(`ההעתקה הושלמה: ${job.meta.title}`);
  if (job.state === 'error') toast(`ההעתקה נכשלה: ${job.error}`, true);
  // Refresh the folder if it received files.
  if (isDir() && job.meta.dstKey === JSON.stringify({ kind: S.loc.kind, id: S.loc.id, path: S.loc.path })) reload();
}

function modal({ title, text, buttons, checkbox }) {
  return new Promise((resolve) => {
    $('#modal-body').innerHTML = `<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${
      checkbox ? `<label><input type="checkbox" id="modal-check"> ${esc(checkbox)}</label>` : ''
    }`;
    $('#modal-buttons').innerHTML = buttons.map((b, i) => `<button class="btn ${b.primary ? 'primary' : ''}" data-b="${i}">${esc(b.label)}</button>`).join('');
    $('#modal').classList.remove('hidden');
    $('#modal-buttons').onclick = (ev) => {
      const b = ev.target.closest('[data-b]');
      if (!b) return;
      const checked = Boolean($('#modal-check') && $('#modal-check').checked);
      $('#modal').classList.add('hidden');
      resolve({ value: buttons[Number(b.dataset.b)].value, checked });
    };
    const first = $('#modal-buttons .primary');
    if (first) first.focus();
  });
}

async function onConflict(c) {
  const r = await modal({
    title: c.isDir ? `התיקייה "${c.name}" כבר קיימת ביעד` : `הקובץ "${c.name}" כבר קיים ביעד`,
    text: c.isDir ? 'החלפה תמזג את התוכן ותחליף קבצים בעלי אותו שם.' : 'מה לעשות?',
    buttons: [
      { label: 'החלף', value: 'replace', primary: true },
      { label: 'שמור את שניהם', value: 'keep' },
      { label: 'דלג', value: 'skip' },
    ],
    checkbox: 'עשה זאת לכל ההתנגשויות בהעברה הזו',
  });
  api.replyConflict(c.requestId, { action: r.value, all: r.checked });
}

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

/** Where would a drop on `el` copy to? */
function dropTargetFor(el) {
  const t = el && el.closest('[data-drop]');
  if (t) {
    const kind = t.dataset.drop;
    if (kind === 'folder') {
      const e = S.shown[Number(t.dataset.i)];
      return { el: t, loc: { kind: S.loc.kind, id: S.loc.id, path: e.path } };
    }
    if (kind === 'device') return { el: t, loc: { kind: 'device', id: t.dataset.id, path: t.dataset.path } };
    if (kind === 'local') return { el: t, loc: { kind: 'local', path: t.dataset.path } };
    if (t._loc && t._loc.type === 'dir') return { el: t, loc: fsLoc(t._loc) };
  }
  if (contentEl.contains(el) && isDir()) return { el: contentEl, loc: fsLoc(), whole: true };
  return null;
}

let dragSource = null;
let dropHighlight = null;

function clearDropHighlight() {
  if (dropHighlight) dropHighlight.classList.remove('drop-target', 'drop-active');
  dropHighlight = null;
}

function setupDnD() {
  document.addEventListener('dragstart', (ev) => {
    const row = ev.target.closest && ev.target.closest('[data-i]');
    if (!row || !isDir()) return;
    const i = Number(row.dataset.i);
    if (!S.selection.has(S.shown[i].path)) selectIndex(i);
    dragSource = { from: { kind: S.loc.kind, id: S.loc.id }, paths: selectedEntries().map((e) => e.path) };
    ev.dataTransfer.setData(DRAG_MIME, JSON.stringify(dragSource));
    ev.dataTransfer.effectAllowed = 'copy';
  });
  document.addEventListener('dragend', () => {
    dragSource = null;
    clearDropHighlight();
  });

  document.addEventListener('dragover', (ev) => {
    const types = [...ev.dataTransfer.types];
    const external = types.includes('Files');
    if (!external && !types.includes(DRAG_MIME)) return;
    const target = dropTargetFor(ev.target);
    let ok = Boolean(target);
    if (ok && dragSource) {
      // Do not drop a folder into itself, or items back into the folder they came from.
      const src = dragSource;
      const same = src.from.kind === target.loc.kind && src.from.id === target.loc.id;
      if (same && src.paths.some((p) => target.loc.path === p || target.loc.path.startsWith(p + '/') || dirname(p) === target.loc.path)) ok = false;
    }
    const el = ok ? target.el : null;
    if (el !== dropHighlight) {
      clearDropHighlight();
      if (el) {
        dropHighlight = el;
        if (target.whole) {
          el.dataset.dropLabel = target.loc.kind === 'device' ? 'שחרר כדי להעתיק לטלפון' : 'שחרר כדי להעתיק לכאן';
          el.classList.add('drop-active');
        } else el.classList.add('drop-target');
      }
    }
    if (ok) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
    }
  });

  document.addEventListener('dragleave', (ev) => {
    if (!ev.relatedTarget) clearDropHighlight();
  });

  document.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const target = dropTargetFor(ev.target);
    clearDropHighlight();
    if (!target) return;
    const internal = ev.dataTransfer.getData(DRAG_MIME);
    if (internal) {
      const src = JSON.parse(internal);
      startTransfer(src.from, src.paths, target.loc);
      return;
    }
    const files = [...ev.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (files.length) startTransfer({ kind: 'local' }, files, target.loc);
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function setupEvents() {
  $('#btn-back').innerHTML = ICONS.back;
  $('#btn-forward').innerHTML = ICONS.forward;
  $('#btn-up').innerHTML = ICONS.up;
  $('#view-grid').innerHTML = ICONS.grid;
  $('#view-list').innerHTML = ICONS.list;
  $('#transfers-close').innerHTML = ICONS.close;
  $('#viewer-close').innerHTML = ICONS.close;
  $('#viewer-prev').innerHTML = ICONS.chevronPrev;
  $('#viewer-next').innerHTML = ICONS.chevronNext;

  $('#btn-back').onclick = goBack;
  $('#btn-forward').onclick = goForward;
  $('#btn-up').onclick = goUp;
  const setView = (v) => {
    S.view = v;
    store('view', v);
    renderToolbar();
    renderContent();
  };
  $('#view-grid').onclick = () => setView('grid');
  $('#view-list').onclick = () => setView('list');

  $('#search').addEventListener('input', (ev) => {
    S.search = ev.target.value;
    applyView();
    renderContent();
    renderStatus();
  });
  $('#search').addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.target.value = '';
      S.search = '';
      applyView();
      renderContent();
      contentEl.focus();
    }
  });

  $('#breadcrumbs').addEventListener('click', (ev) => {
    const c = ev.target.closest('.crumb');
    if (c && c._loc && !sameLoc(c._loc, S.loc)) navigate(c._loc);
  });

  document.querySelector('.sidebar').addEventListener('click', (ev) => {
    const it = ev.target.closest('[data-nav]');
    if (!it) return;
    const nav = it.dataset.nav;
    if (nav === 'device-root') navigate({ type: 'device-root', id: it.dataset.id });
    else if (nav === 'device-dir') navigate({ type: 'dir', kind: 'device', id: it.dataset.id, path: it.dataset.path });
    else if (nav === 'local-dir') navigate({ type: 'dir', kind: 'local', path: it.dataset.path });
  });

  $('#actionbar').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (b && !b.disabled) runAction(b.dataset.act);
  });

  contentEl.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    const row = ev.target.closest('[data-i]');
    if (!row) {
      if (ev.target.closest('th, .drive, [data-shortcut], button')) return;
      if (S.selection.size) {
        S.selection.clear();
        updateSelectionUI();
      }
      return;
    }
    const i = Number(row.dataset.i);
    const toggle = ev.metaKey || ev.ctrlKey;
    // Keep a multi-selection when starting to drag one of its items.
    if (!toggle && !ev.shiftKey && S.selection.has(S.shown[i].path) && S.selection.size > 1) {
      row._pendingSingle = true;
      return;
    }
    selectIndex(i, { toggle, range: ev.shiftKey });
  });
  contentEl.addEventListener('click', (ev) => {
    const row = ev.target.closest('[data-i]');
    if (row && row._pendingSingle) {
      row._pendingSingle = false;
      selectIndex(Number(row.dataset.i));
    }
    const act = ev.target.closest('[data-act]');
    if (act) runAction(act.dataset.act);
    const th = ev.target.closest('th[data-sort]');
    if (th) {
      const key = th.dataset.sort;
      S.sort = S.sort.key === key ? { key, dir: -S.sort.dir } : { key, dir: key === 'name' || key === 'kind' ? 1 : -1 };
      applyView();
      renderContent();
    }
    const drive = ev.target.closest('.drive, [data-shortcut]');
    if (drive) {
      contentEl.querySelectorAll('.drive.selected').forEach((d) => d.classList.remove('selected'));
      drive.classList.add('selected');
    }
  });
  contentEl.addEventListener('dblclick', (ev) => {
    const row = ev.target.closest('[data-i]');
    if (row) return openEntry(S.shown[Number(row.dataset.i)]);
    const drive = ev.target.closest('.drive, [data-shortcut]');
    if (drive && drive._loc) navigate(drive._loc);
  });
  contentEl.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    showContextMenu(ev);
  });

  $('#transfer-list').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-cancel]');
    if (b) api.cancelTransfer(Number(b.dataset.cancel));
  });
  $('#transfers-clear').onclick = async () => {
    await api.clearTransfers();
    for (const [id, j] of S.transfers) if (!['queued', 'scanning', 'running'].includes(j.state)) S.transfers.delete(id);
    renderTransfers();
  };
  $('#transfers-close').onclick = () => $('#transfers').classList.add('hidden');

  $('#viewer-close').onclick = closeViewer;
  $('#viewer-prev').onclick = () => viewerStep(-1);
  $('#viewer-next').onclick = () => viewerStep(1);
  $('#viewer-open').onclick = () => S.viewer && api.open(S.viewer.loc, S.viewer.list[S.viewer.index]).catch((e) => toast(errMsg(e), true));
  $('#viewer-copy').onclick = () => S.viewer && copyToMac([S.viewer.list[S.viewer.index]]);

  document.addEventListener('keydown', onKey);
}

function onKey(ev) {
  const cmd = ev.metaKey || ev.ctrlKey;
  if (!$('#modal').classList.contains('hidden')) return;
  if (S.viewer) {
    if (ev.key === 'Escape' || ev.key === ' ') closeViewer();
    else if (ev.key === 'ArrowLeft') viewerStep(1); // RTL: left = next
    else if (ev.key === 'ArrowRight') viewerStep(-1);
    else return;
    ev.preventDefault();
    return;
  }
  if (ev.target.tagName === 'INPUT') {
    if (cmd && ev.key.toLowerCase() === 'f') ev.preventDefault();
    return;
  }

  if (cmd && ev.key === '[') return goBack();
  if (cmd && ev.key === ']') return goForward();
  if (cmd && ev.key === 'ArrowUp') return goUp();
  if (cmd && ev.key.toLowerCase() === 'f') {
    ev.preventDefault();
    return $('#search').focus();
  }
  if (cmd && ev.key.toLowerCase() === 'r') {
    ev.preventDefault();
    return reload();
  }
  if (!isDir()) return;

  if (cmd && ev.key.toLowerCase() === 'a') {
    ev.preventDefault();
    S.selection = new Set(S.shown.map((e) => e.path));
    return updateSelectionUI();
  }
  if (cmd && ev.key.toLowerCase() === 'c') return copySelection();
  if (cmd && ev.key.toLowerCase() === 'v') return paste();
  if (cmd && ev.shiftKey && ev.key.toLowerCase() === 'n') return newFolder();
  if (ev.key === 'Delete' || (cmd && ev.key === 'Backspace')) return deleteSelection();
  if (ev.key === 'Backspace') return goBack();
  if (ev.key === 'F2') {
    const i = focusIndex();
    if (i >= 0) startRename(i);
    return;
  }
  if (ev.key === 'Enter' || (cmd && ev.key === 'ArrowDown')) {
    const sel = selectedEntries();
    if (sel.length === 1) openEntry(sel[0]);
    return;
  }
  if (ev.key === ' ') {
    ev.preventDefault();
    const e = S.shown[focusIndex()];
    if (e && isMedia(e)) openViewer(e);
    return;
  }
  if (ev.key === 'Escape') {
    S.selection.clear();
    return updateSelectionUI();
  }
  const arrows = { ArrowLeft: 1, ArrowRight: -1, ArrowUp: 'up', ArrowDown: 'down' };
  if (ev.key in arrows) {
    ev.preventDefault();
    if (!S.shown.length) return;
    let i = focusIndex();
    if (i < 0) return selectIndex(0);
    let cols = 1;
    if (S.view === 'grid') {
      const tiles = contentEl.querySelectorAll('.grid > .tile');
      const top = tiles[0]?.offsetTop;
      cols = [...tiles].findIndex((t) => t.offsetTop !== top);
      if (cols <= 0) cols = tiles.length;
    }
    const a = arrows[ev.key];
    let n = i;
    if (a === 'up') n = i - cols;
    else if (a === 'down') n = i + cols;
    else if (S.view === 'grid') n = i + a;
    else return;
    n = Math.max(0, Math.min(S.shown.length - 1, n));
    selectIndex(n, { range: ev.shiftKey });
    if (ev.shiftKey) S.anchor = S.anchor ?? i;
    scrollIntoView(n);
  }
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

function onDevices(list) {
  const before = new Map(S.devices.map((d) => [d.id, d.state]));
  S.devices = list;
  S.adbError = null;
  for (const id of Object.keys(S.storages)) if (!list.some((d) => d.id === id)) delete S.storages[id];

  // A phone just became ready: go into it, like opening a drive in Explorer.
  const ready = list.find((d) => d.state === 'device' && before.get(d.id) !== 'device');
  const viewingNothing = S.loc.type === 'welcome' || ((S.loc.kind === 'device' || S.loc.type === 'device-root') && !list.some((d) => d.id === S.loc.id));
  if (ready && (viewingNothing || (S.loc.id === ready.id && before.get(ready.id) !== 'device'))) {
    if (S.loc.id === ready.id && S.loc.type === 'dir') {
      // Same phone reconnected while we were in one of its folders: just reload.
      renderAll();
      load();
    } else navigate({ type: 'device-root', id: ready.id });
    return;
  }
  if (!list.length && S.loc.type === 'device-root') {
    navigate({ type: 'welcome' });
    return;
  }
  // Waiting for authorization etc.: show the right screen.
  if (S.loc.type === 'welcome' && list.length) {
    navigate({ type: 'device-root', id: list[0].id });
    return;
  }
  renderAll();
}

async function main() {
  const info = await api.init();
  S.platform = info.platform;
  S.places = info.places;
  S.mock = info.mock;
  S.adbError = info.adbError;
  document.body.classList.toggle('mac', info.platform === 'darwin');
  setupEvents();
  setupDnD();
  api.onDevices(onDevices);
  api.onAdbError((err) => {
    S.adbError = err;
    renderAll();
  });
  api.onTransfer(onTransferUpdate);
  api.onConflict(onConflict);
  navigate({ type: 'welcome' });
  if (info.devices && info.devices.length) onDevices(info.devices);
  contentEl.focus();
}

main();
