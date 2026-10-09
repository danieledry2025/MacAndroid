'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pipeline } = require('stream/promises');
const { sortEntries } = require('./util');

/** File system operations on this Mac. Same shape as DeviceFs so transfers can treat both alike. */
class LocalFs {
  constructor(root = null) {
    this.kind = 'local';
    // Optional root: used by the mock device, which pretends a Mac folder is a phone.
    this.root = root;
  }

  real(p) {
    if (!this.root) return p;
    const resolved = path.join(this.root, path.posix.normalize('/' + p));
    if (!resolved.startsWith(this.root)) throw new Error('Path escapes root');
    return resolved;
  }

  join(dir, name) {
    return this.root ? path.posix.join(dir, name) : path.join(dir, name);
  }

  async readdir(dir) {
    const names = await fsp.readdir(this.real(dir));
    const out = [];
    await Promise.all(
      names.map(async (name) => {
        const p = this.join(dir, name);
        try {
          const s = await fsp.stat(this.real(p));
          out.push({ name, path: p, isDir: s.isDirectory(), isLink: false, size: s.size, mtime: s.mtimeMs });
        } catch {
          // Broken symlink or no permission: skip silently, like Finder does.
        }
      })
    );
    return sortEntries(out);
  }

  async stat(p) {
    const s = await fsp.stat(this.real(p));
    return { isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs };
  }

  async exists(p) {
    try {
      await fsp.access(this.real(p));
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(p) {
    await fsp.mkdir(this.real(p), { recursive: true });
  }

  async remove(p) {
    await fsp.rm(this.real(p), { recursive: true, force: true });
  }

  async rename(from, to) {
    await fsp.rename(this.real(from), this.real(to));
  }

  async copyWithin(from, to) {
    await fsp.cp(this.real(from), this.real(to), { recursive: true, errorOnExist: true });
  }

  async openRead(p) {
    return fs.createReadStream(this.real(p), { highWaterMark: 1024 * 1024 });
  }

  async openReadRange(p, start, end) {
    return fs.createReadStream(this.real(p), { start, end });
  }

  async writeFrom(readable, p) {
    await pipeline(readable, fs.createWriteStream(this.real(p)));
  }

  /** Real Mac path for a file, so it can be opened or thumbnailed without copying. */
  localPath(p) {
    return this.real(p);
  }
}

module.exports = { LocalFs };
