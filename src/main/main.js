'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { app, BrowserWindow, ipcMain, shell, dialog, Menu, clipboard, nativeTheme, } = require('electron');
const { AdbManager } = require('./adb');
const { MockManager } = require('./mock');
const { LocalFs } = require('./local');
const { TransferQueue } = require('./transfers');
const { Thumbnailer } = require('./thumbs');
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
async function materialize(loc, entry) {
  const fsys = fsFor(loc);
  const direct = fsys.localPath ? fsys.localPath(entry.path) : null;
  if (direct) return direct;
  const key = crypto.createHash('sha1').update(`${loc.id}|${entry.path}|${entry.size}|${entry.mtime}`).digest('hex').slice(0, 16);
  const dir = path.join(app.getPath('temp'), 'MacAndroid', 'open', key);
  const out = path.join(dir, entry.name);
  if (fs.existsSync(out) && fs.statSync(out).size === entry.size) return out;
  fs.mkdirSync(dir, { recursive: true });
  await pipeline(await fsys.openRead(entry.path), fs.createWriteStream(out + '.part'));
  fs.renameSync(out + '.part', out);
  return out;
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


  /** Copy phone items to temp files so they can be dragged out to Finder. */
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
    minWidth: 900,
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
  thumbs = new Thumbnailer(path.join(app.getPath('userData'), 'thumbs'), path.join(app.getPath('temp'), 'MacAndroid', 'thumb-src'));
  registerIpc();
  appMenu();
  createWindow();

  devices.on('devices', (list) => send('devices', list));
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
