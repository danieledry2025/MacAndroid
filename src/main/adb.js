'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const { Adb } = require('@devicefarmer/adbkit');
const { shq, rjoin, sortEntries, parseDf, externalVolumes } = require('./util');

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/** Locate an adb binary: bundled first, then the usual Homebrew / Android Studio spots, then PATH. */
function findAdb() {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates = [
    process.env.MACANDROID_ADB,
    process.resourcesPath && path.join(process.resourcesPath, 'platform-tools', exe),
    path.join(__dirname, '..', '..', 'vendor', 'platform-tools', exe),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', exe),
    path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools', exe),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {}
  }
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['adb'], { encoding: 'utf8' })
      .split('\n')[0]
      .trim();
    if (found) return found;
  } catch {}
  return null;
}

/** File system operations on one connected Android device. */
class DeviceFs {
  constructor(client, serial) {
    this.kind = 'device';
    this.serial = serial;
    this.dev = client.getDevice(serial);
  }

  async shell(cmd) {
    const stream = await this.dev.shell(cmd);
    const buf = await Adb.util.readAll(stream);
    return buf.toString('utf8');
  }

  async readdir(dir) {
    // A trailing slash makes adbd follow symlinked folders such as /sdcard.
    const entries = await this.dev.readdir(dir.endsWith('/') ? dir : dir + '/');
    const out = [];
    for (const e of entries) {
      if (e.name === '.' || e.name === '..') continue;
      const type = e.mode & S_IFMT;
      out.push({
        name: e.name,
        path: rjoin(dir, e.name),
        isDir: type === S_IFDIR,
        isLink: type === S_IFLNK,
        size: Number(e.size),
        mtime: e.mtimeMs,
      });
    }
    // Symlinks (rare inside user storage) are resolved so folders still open like folders.
    await Promise.all(
      out
        .filter((e) => e.isLink)
        .map(async (e) => {
          try {
            await this.dev.readdir(e.path + '/');
            e.isDir = true;
          } catch {}
        })
    );
    return sortEntries(out);
  }

  async stat(p) {
    const s = await this.dev.stat(p);
    return { isDir: (s.mode & S_IFMT) === S_IFDIR, size: Number(s.size), mtime: s.mtimeMs };
  }

  async exists(p) {
    try {
      await this.dev.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(p) {
    const out = await this.shell(`mkdir -p -- ${shq(p)} 2>&1 && echo __OK__`);
    if (!out.includes('__OK__')) throw new Error(out.trim() || 'mkdir failed');
  }

  async remove(p) {
    const out = await this.shell(`rm -rf -- ${shq(p)} 2>&1 && echo __OK__`);
    if (!out.includes('__OK__')) throw new Error(out.trim() || 'delete failed');
    this.mediaScan(p);
  }

  async rename(from, to) {
    const out = await this.shell(`mv -- ${shq(from)} ${shq(to)} 2>&1 && echo __OK__`);
    if (!out.includes('__OK__')) throw new Error(out.trim() || 'rename failed');
  }

  async copyWithin(from, to) {
    const out = await this.shell(`cp -r -- ${shq(from)} ${shq(to)} 2>&1 && echo __OK__`);
    if (!out.includes('__OK__')) throw new Error(out.trim() || 'copy failed');
    this.mediaScan(to);
  }

  /** Readable stream of a device file. */
  async openRead(p) {
    return this.dev.pull(p);
  }

  /** Write a readable stream to the device. Resolves when the file is fully written. */
  async writeFrom(readable, p, mode = 0o644) {
    const transfer = await this.dev.push(readable, p, mode);
    await new Promise((resolve, reject) => {
      transfer.on('end', resolve);
      transfer.on('error', reject);
    });
    this.mediaScan(p);
  }

  /** Ask Android to index a new/removed file so it shows up in Gallery etc. Best effort. */
  mediaScan(p) {
    this.shell(`am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${shq('file://' + p)} >/dev/null 2>&1`).catch(() => {});
  }

  /** Internal storage plus any SD card / USB drive, with free space. */
  async storages() {
    const vols = [{ id: 'internal', label: 'אחסון פנימי', path: '/storage/emulated/0', type: 'internal' }];
    try {
      const names = (await this.dev.readdir('/storage/')).map((e) => e.name);
      for (const n of externalVolumes(names)) {
        vols.push({ id: n, label: 'כרטיס SD', path: `/storage/${n}`, type: 'sd' });
      }
    } catch {}
    try {
      const df = parseDf(await this.shell(`df -k ${vols.map((v) => shq(v.path)).join(' ')} 2>/dev/null`));
      const dfValues = Object.entries(df);
      vols.forEach((v, i) => {
        // `df` reports the mount point, which may differ from the path we asked about (e.g. /data/media).
        const hit = df[v.path] || (dfValues[i] && dfValues[i][1]);
        if (hit) Object.assign(v, hit);
      });
    } catch {}
    return vols;
  }
}

/** Watches for Android devices over USB using the adb server. */
class AdbManager extends EventEmitter {
  constructor() {
    super();
    this.adbPath = null;
    this.client = null;
    this.devices = new Map(); // serial -> { id, state, name, model }
    this.fsCache = new Map();
    this.retryTimer = null;
  }

  async start() {
    this.adbPath = findAdb();
    if (!this.adbPath) {
      this.emit('error-state', { code: 'NO_ADB' });
      return;
    }
    this.client = Adb.createClient({ bin: this.adbPath });
    this.track();
  }

  async track() {
    clearTimeout(this.retryTimer);
    try {
      const tracker = await this.client.trackDevices();
      const initial = await this.client.listDevices();
      this.devices.clear();
      for (const d of initial) await this.upsert(d);
      this.emitDevices();
      tracker.on('add', async (d) => {
        await this.upsert(d);
        this.emitDevices();
      });
      tracker.on('change', async (d) => {
        await this.upsert(d);
        this.emitDevices();
      });
      tracker.on('remove', (d) => {
        this.devices.delete(d.id);
        this.fsCache.delete(d.id);
        this.emitDevices();
      });
      const restart = () => {
        this.retryTimer = setTimeout(() => this.track(), 1500);
      };
      tracker.on('end', restart);
      tracker.on('error', restart);
    } catch (err) {
      this.emit('error-state', { code: 'ADB_FAILED', message: String(err && err.message) });
      this.retryTimer = setTimeout(() => this.track(), 3000);
    }
  }

  async upsert(d) {
    const info = { id: d.id, state: d.type, name: d.id, model: '' };
    if (d.type === 'device') {
      try {
        const props = await this.client.getDevice(d.id).getProperties();
        const brand = props['ro.product.manufacturer'] || props['ro.product.brand'] || '';
        const model = props['ro.product.marketname'] || props['ro.product.model'] || '';
        info.model = model;
        info.name = [brand && brand[0].toUpperCase() + brand.slice(1), model].filter(Boolean).join(' ') || d.id;
        info.android = props['ro.build.version.release'] || '';
      } catch {}
    }
    this.devices.set(d.id, info);
  }

  emitDevices() {
    this.emit('devices', this.list());
  }

  list() {
    return [...this.devices.values()];
  }

  fs(serial) {
    if (!this.client) throw new Error('adb is not running');
    if (!this.fsCache.has(serial)) this.fsCache.set(serial, new DeviceFs(this.client, serial));
    return this.fsCache.get(serial);
  }

  stop() {
    clearTimeout(this.retryTimer);
  }
}

module.exports = { AdbManager, DeviceFs, findAdb };
