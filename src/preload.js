'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch, cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('api', {
  init: () => invoke('app:init'),
  readdir: (loc) => invoke('fs:readdir', loc),
  storages: (id) => invoke('fs:storages', id),
  mkdir: (loc, name) => invoke('fs:mkdir', loc, name),
  rename: (loc, from, name) => invoke('fs:rename', loc, from, name),
  remove: (loc, paths) => invoke('fs:delete', loc, paths),
  open: (loc, entry) => invoke('fs:open', loc, entry),
  preview: (loc, entry) => invoke('fs:preview', loc, entry),
  reveal: (p) => invoke('fs:reveal', p),
  thumb: (loc, entry, gen) => invoke('thumb:get', loc, entry, gen),
  startTransfer: (spec) => invoke('transfer:start', spec),
  cancelTransfer: (id) => invoke('transfer:cancel', id),
  clearTransfers: () => invoke('transfer:clear'),
  replyConflict: (id, decision) => invoke('transfer:conflict-reply', id, decision),
  finderClipboard: () => invoke('clipboard:finder-files'),
  chooseFolder: (title) => invoke('dialog:choose-folder', title),
  chooseFiles: (title) => invoke('dialog:choose-files', title),
  confirm: (opts) => invoke('dialog:confirm', opts),
  popupMenu: (template) => invoke('menu:popup', template),
  finderStatus: () => invoke('finder:status'),
  finderMount: (id) => invoke('finder:mount', id),
  finderUnmount: (id) => invoke('finder:unmount', id),
  finderReveal: (id, p) => invoke('finder:reveal', id, p),
  setSettings: (patch) => invoke('settings:set', patch),
  prepareDrag: (loc, entries) => invoke('drag:prepare', loc, entries),
  startDrag: (files, icon) => ipcRenderer.send('drag:start', files, icon),
  onDragProgress: (cb) => on('drag:progress', cb),
  onFinder: (cb) => on('finder', cb),
  onFinderError: (cb) => on('finder:error', cb),
  /** Real path of a file dropped from Finder. */
  pathForFile: (file) => webUtils.getPathForFile(file),
  onDevices: (cb) => on('devices', cb),
  onAdbError: (cb) => on('adb-error', cb),
  onTransfer: (cb) => on('transfer:update', cb),
  onConflict: (cb) => on('transfer:conflict', cb),
});
