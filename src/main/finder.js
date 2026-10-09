'use strict';

// Shows connected phones as drives in Finder by mounting each phone's local WebDAV server
// with macOS's built in WebDAV client (no macFUSE, no kernel extension, no security changes).

const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { DavServer } = require('./webdav');

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

/** Finder shows the last URL path component as the volume name; keep it short and legal. */
function volumeName(name) {
  const clean = String(name).replace(/[/:\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.slice(0, 60) || 'Android';
}

/** Find the mount point for a WebDAV URL in `mount` output. */
function findMountPoint(mountOutput, port) {
  for (const line of mountOutput.split('\n')) {
    const m = /^(\S+) on (.+?) \(webdav/.exec(line);
    if (m && m[1].includes(`127.0.0.1:${port}`)) return m[2];
  }
  return null;
}

class FinderMounts extends EventEmitter {
  constructor() {
    super();
    this.mounts = new Map(); // deviceId -> { server, url, mountPoint, name }
    this.pending = new Map();
  }

  get supported() {
    return process.platform === 'darwin';
  }

  status(id) {
    const m = this.mounts.get(id);
    if (!m) return { mounted: false, busy: this.pending.has(id) };
    return { mounted: Boolean(m.mountPoint), url: m.url, mountPoint: m.mountPoint, busy: this.pending.has(id) };
  }

  all() {
    const out = {};
    for (const id of new Set([...this.mounts.keys(), ...this.pending.keys()])) out[id] = this.status(id);
    return out;
  }

  /** Start the server for a phone and mount it in Finder. Resolves with the mount status. */
  mount(id, { fsys, name, storages }) {
    if (this.mounts.get(id)?.mountPoint) return Promise.resolve(this.status(id));
    if (this.pending.has(id)) return this.pending.get(id);
    const job = (async () => {
      let m = this.mounts.get(id);
      if (!m) {
        const server = new DavServer({ fsys, name: volumeName(name), storages });
        const url = await server.listen();
        m = { server, url, mountPoint: null, name: volumeName(name) };
        this.mounts.set(id, m);
      }
      if (this.supported) {
        // `mount volume` is the scripted "Go > Connect to Server"; no password prompt since the server asks for none.
        await run('osascript', ['-e', `mount volume "${m.url}"`], 60000);
        m.mountPoint = findMountPoint(await run('/sbin/mount', []), m.server.port);
        if (!m.mountPoint) throw new Error('Finder did not mount the phone');
      }
      return this.status(id);
    })();
    this.pending.set(id, job);
    this.emit('change');
    return job.finally(() => {
      this.pending.delete(id);
      this.emit('change');
    });
  }

  async unmount(id) {
    const m = this.mounts.get(id);
    if (!m) return;
    this.mounts.delete(id);
    if (m.mountPoint) {
      try {
        await run('/usr/sbin/diskutil', ['unmount', 'force', m.mountPoint]);
      } catch {
        await run('/sbin/umount', ['-f', m.mountPoint]).catch(() => {});
      }
    }
    await m.server.close();
    this.emit('change');
  }

  async unmountAll() {
    await Promise.all([...this.mounts.keys()].map((id) => this.unmount(id).catch(() => {})));
  }

  /** Open a phone folder in Finder (the mount point plus the folder's place inside the phone). */
  async reveal(id, devicePath, vols) {
    const m = this.mounts.get(id);
    if (!m || !m.mountPoint) throw new Error('not mounted');
    let rel = '';
    if (devicePath) {
      const vol = vols.filter((v) => devicePath === v.path || devicePath.startsWith(v.path + '/')).sort((a, b) => b.path.length - a.path.length)[0];
      if (vol) rel = (vols.length > 1 ? '/' + vol.label : '') + devicePath.slice(vol.path.length);
    }
    await run('/usr/bin/open', [m.mountPoint + rel]);
  }
}

module.exports = { FinderMounts, volumeName, findMountPoint };
