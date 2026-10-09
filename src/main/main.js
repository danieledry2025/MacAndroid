'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { app, BrowserWindow, ipcMain, shell, dialog, Menu, clipboard, nativeTheme, nativeImage } = require('electron');
const { AdbManager } = require('./adb');
const { MockManager } = require('./mock');
const { LocalFs } = require('./local');
const { TransferQueue } = require('./transfers');
const { Thumbnailer } = require('./thumbs');
const { FinderMounts } = require('./finder');
const { uniqueName } = require('./util');

const mockEnv = process.env.MACANDROID_MOCK || (process.argv.includes('--mock') ? '1' : '');
const devices = mockEnv
  ? new MockManager(mockEnv === '1' ? path.join(process.cwd(), 'mock-phone') : mockEnv)
  : new AdbManager();
const localFs = new LocalFs();

let win = null;
let thumbs = null;
let lastAdbError = null;
let lastMacFolder = null;
const conflictWaiters = new Map();
const finder = new FinderMounts();
let settings = { autoMountFinder: true };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {}
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch {}
}
let conflictSeq = 0;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Map a location coming from the UI ({kind:'device', id} or {kind:'local'}) to a file system. */
function fsFor(loc) {
  if (loc.kind === 'local') return localFs;
  if (loc.kind === 'device') return devices.fs(loc.id);
  throw new Error('Unknown location kind: ' + loc.kind);
}

const transfers = new TransferQueue({
  askConflict: (info) =>
    new Promise((resolve) => {
      const id = ++conflictSeq;
      conflictWaiters.set(id, resolve);
      send('transfer:conflict', { ...info, requestId: id });
    }),
});
transfers.on('update', (job) => send('transfer:update', job));

function places() {
  const p = (name) => {
    try {
      return app.getPath(name);
    } catch {
      return null;
    }
  };
  return [
    { id: 'desktop', label: 'שולחן עבודה', path: p('desktop'), icon: 'desktop' },
    { id: 'downloads', label: 'הורדות', path: p('downloads'), icon: 'download' },
    { id: 'documents', label: 'מסמכים', path: p('documents'), icon: 'doc' },
    { id: 'pictures', label: 'תמונות', path: p('pictures'), icon: 'image' },
    { id: 'videos', label: 'סרטים', path: p('videos'), icon: 'video' },
    { id: 'home', label: os.userInfo().username, path: os.homedir(), icon: 'home' },
  ].filter((x) => x.path && fs.existsSync(x.path));
}

/** Copy a device file to a temp folder so macOS apps (Preview, QuickTime...) can open it. */
async function materialize(loc, entry, onBytes) {
  const fsys = fsFor(loc);
  const direct = fsys.localPath ? fsys.localPath(entry.path) : null;
  if (direct) return direct;
  const key = crypto.createHash('sha1').update(`${loc.id}|${entry.path}|${entry.size}|${entry.mtime}`).digest('hex').slice(0, 16);
  const dir = path.join(app.getPath('temp'), 'MacAndroid', 'open', key);
  const out = path.join(dir, entry.name);
  if (fs.existsSync(out) && fs.statSync(out).size === entry.size) return out;
  fs.mkdirSync(dir, { recursive: true });
  const src = await fsys.openRead(entry.path);
  if (onBytes) src.on('data', (c) => onBytes(c.length));
  await pipeline(src, fs.createWriteStream(out + '.part'));
  fs.renameSync(out + '.part', out);
  return out;
}

/** Copy a phone folder into a fresh temp folder (for dragging it out to Finder). */
async function materializeDir(loc, entry, onBytes) {
  const fsys = fsFor(loc);
  const root = path.join(app.getPath('temp'), 'MacAndroid', 'drag', crypto.randomBytes(6).toString('hex'), entry.name);
  const walk = async (remote, local) => {
    fs.mkdirSync(local, { recursive: true });
    for (const e of await fsys.readdir(remote)) {
      if (e.isDir) await walk(e.path, path.join(local, e.name));
      else {
        const src = await fsys.openRead(e.path);
        if (onBytes) src.on('data', (c) => onBytes(c.length));
        await pipeline(src, fs.createWriteStream(path.join(local, e.name)));
      }
    }
  };
  await walk(entry.path, root);
  return root;
}

async function treeSize(fsys, p) {
  let total = 0;
  for (const e of await fsys.readdir(p)) total += e.isDir ? await treeSize(fsys, e.path) : e.size;
  return total;
}

function deviceInfo(id) {
  return (devices.list ? devices.list() : []).find((d) => d.id === id);
}

function mountDevice(id) {
  const d = deviceInfo(id);
  if (!d || d.state !== 'device') return Promise.reject(new Error('המכשיר לא מחובר'));
  const fsys = devices.fs(id);
  return finder.mount(id, { fsys, name: d.name, storages: () => fsys.storages() });
}

/** Keep Finder in sync with what is plugged in. */
function syncMounts(list) {
  const ready = new Set(list.filter((d) => d.state === 'device').map((d) => d.id));
  for (const id of Object.keys(finder.all())) if (!ready.has(id)) finder.unmount(id).catch(() => {});
  if (!settings.autoMountFinder || !finder.supported) return;
  for (const id of ready) {
    if (!finder.status(id).mounted && !finder.status(id).busy && !finder.autoTried?.has(id)) {
      finder.autoTried = finder.autoTried || new Set();
      finder.autoTried.add(id);
      mountDevice(id).catch((err) => send('finder:error', { id, message: err.message }));
    }
  }
  // Forget devices that left, so plugging them in again mounts again.
  if (finder.autoTried) for (const id of finder.autoTried) if (!ready.has(id)) finder.autoTried.delete(id);
}

function registerIpc() {
  ipcMain.handle('app:init', () => ({
    platform: process.platform,
    places: places(),
    mock: Boolean(mockEnv),
    adbPath: devices.adbPath,
    adbError: lastAdbError,
    devices: devices.list ? devices.list() : [],
  }));

  ipcMain.handle('fs:readdir', (_e, loc) => fsFor(loc).readdir(loc.path));
  ipcMain.handle('fs:storages', (_e, id) => devices.fs(id).storages());

  ipcMain.handle('fs:mkdir', async (_e, loc, baseName) => {
    const fsys = fsFor(loc);
    const name = await uniqueName(baseName, (n) => fsys.exists(path.posix.join(loc.path, n)));
    const p = path.posix.join(loc.path, name);
    await fsys.mkdir(p);
    return p;
  });

  ipcMain.handle('fs:rename', async (_e, loc, from, newName) => {
    if (!newName || newName.includes('/')) throw new Error('שם לא חוקי');
    const fsys = fsFor(loc);
    const to = path.posix.join(path.posix.dirname(from), newName);
    if (to === from) return to;
    if (await fsys.exists(to)) throw new Error('כבר קיים פריט בשם הזה');
    await fsys.rename(from, to);
    return to;
  });

  ipcMain.handle('fs:delete', async (_e, loc, paths) => {
    for (const p of paths) {
      // On the Mac, deleting moves to the Trash so mistakes can be undone.
      if (loc.kind === 'local') await shell.trashItem(p);
      else await fsFor(loc).remove(p);
    }
  });

  ipcMain.handle('fs:open', async (_e, loc, entry) => {
    const p = await materialize(loc, entry);
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  });

  ipcMain.handle('fs:preview', (_e, loc, entry) => materialize(loc, entry));

  ipcMain.handle('finder:status', () => ({ supported: finder.supported, mounts: finder.all(), settings }));
  ipcMain.handle('finder:mount', (_e, id) => mountDevice(id));
  ipcMain.handle('finder:unmount', (_e, id) => finder.unmount(id));
  ipcMain.handle('finder:reveal', async (_e, id, devicePath) => {
    if (!finder.status(id).mounted) await mountDevice(id);
    await finder.reveal(id, devicePath, await devices.fs(id).storages());
  });
  ipcMain.handle('settings:set', (_e, patch) => {
    settings = { ...settings, ...patch };
    saveSettings();
    if (patch.autoMountFinder) syncMounts(devices.list ? devices.list() : []);
    return settings;
  });

  /** Copy phone items to temp files so they can be dragged out to Finder. */
  ipcMain.handle('drag:prepare', async (e, loc, entries) => {
    const fsys = fsFor(loc);
    let total = 0;
    for (const en of entries) total += en.isDir ? await treeSize(fsys, en.path) : en.size;
    let done = 0;
    let last = 0;
    const onBytes = (n) => {
      done += n;
      if (Date.now() - last > 150) {
        last = Date.now();
        e.sender.send('drag:progress', { done, total });
      }
    };
    const files = [];
    for (const en of entries) files.push(en.isDir ? await materializeDir(loc, en, onBytes) : await materialize(loc, en, onBytes));
    return files;
  });

  ipcMain.on('drag:start', (e, files, iconPath) => {
    let icon = iconPath ? nativeImage.createFromPath(iconPath) : null;
    if (!icon || icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'));
    icon = icon.resize({ width: 64 });
    try {
      e.sender.startDrag(files.length === 1 ? { file: files[0], icon } : { file: files[0], files, icon });
    } catch {}
  });
  ipcMain.handle('fs:reveal', (_e, p) => shell.showItemInFolder(p));

  ipcMain.handle('thumb:get', async (_e, loc, entry, gen) => {
    const scope = loc.kind === 'local' ? 'local' : loc.id;
    try {
      return await thumbs.get({ fsys: fsFor(loc), scope, entry, gen });
    } catch {
      return null;
    }
  });

  ipcMain.handle('transfer:start', (_e, { from, items, to, meta }) => {
    const src = fsFor(from);
    const dst = fsFor(to);
    if (to.kind === 'local') lastMacFolder = to.path;
    return transfers.add({ src, dst, items, dstDir: to.path, meta });
  });
  ipcMain.handle('transfer:cancel', (_e, id) => transfers.cancel(id));
  ipcMain.handle('transfer:clear', () => transfers.clearFinished());
  ipcMain.handle('transfer:conflict-reply', (_e, requestId, decision) => {
    const resolve = conflictWaiters.get(requestId);
    conflictWaiters.delete(requestId);
    if (resolve) resolve(decision);
  });

  /** Files copied in Finder (Cmd+C), so they can be pasted onto the phone. */
  ipcMain.handle('clipboard:finder-files', () => {
    if (process.platform !== 'darwin') return [];
    try {
      const plist = clipboard.read('NSFilenamesPboardType');
      const files = [...plist.matchAll(/<string>([^<]+)<\/string>/g)].map((m) =>
        m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      );
      if (files.length) return files;
      const url = clipboard.read('public.file-url');
      return url ? [decodeURI(url.replace(/^file:\/\//, ''))] : [];
    } catch {
      return [];
    }
  });

  ipcMain.handle('dialog:choose-folder', async (_e, title) => {
    const r = await dialog.showOpenDialog(win, {
      title,
      message: title,
      buttonLabel: 'העתק לכאן',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: lastMacFolder || app.getPath('downloads'),
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('dialog:choose-files', async (_e, title) => {
    const r = await dialog.showOpenDialog(win, {
      title,
      message: title,
      buttonLabel: 'העתק לטלפון',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      defaultPath: lastMacFolder || app.getPath('home'),
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('dialog:confirm', async (_e, { message, detail, ok }) => {
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      message,
      detail,
      buttons: [ok || 'אישור', 'ביטול'],
      defaultId: 1,
      cancelId: 1,
    });
    return r.response === 0;
  });

  /** Native right-click menu. The renderer sends a template, we return the clicked id. */
  ipcMain.handle('menu:popup', (_e, template) =>
    new Promise((resolve) => {
      let chosen = null;
      const build = (items) =>
        items.map((it) =>
          it.type === 'separator'
            ? { type: 'separator' }
            : {
                label: it.label,
                enabled: it.enabled !== false,
                accelerator: it.accelerator,
                registerAccelerator: false,
                click: () => {
                  chosen = it.id;
                },
              }
        );
      Menu.buildFromTemplate(build(template)).popup({ window: win, callback: () => setImmediate(() => resolve(chosen)) });
    })
  );
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 480,
    title: 'MacAndroid',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e20' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Links never navigate the app window.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function appMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: 'תצוגה',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  loadSettings();
  thumbs = new Thumbnailer(path.join(app.getPath('userData'), 'thumbs'), path.join(app.getPath('temp'), 'MacAndroid', 'thumb-src'));
  registerIpc();
  appMenu();
  createWindow();

  devices.on('devices', (list) => {
    send('devices', list);
    syncMounts(list);
  });
  finder.on('change', () => send('finder', finder.all()));
  devices.on('error-state', (err) => {
    lastAdbError = err;
    send('adb-error', err);
  });
  await devices.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  devices.stop();
  app.quit();
});

// Take the phone out of Finder before quitting, so no dead drive is left behind.
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !Object.keys(finder.all()).length) return;
  e.preventDefault();
  quitting = true;
  const timeout = new Promise((r) => setTimeout(r, 5000));
  Promise.race([finder.unmountAll(), timeout]).finally(() => app.quit());
});
