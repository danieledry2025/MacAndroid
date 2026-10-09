'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { nativeImage } = require('electron');
const { kindOf, extOf } = require('./util');

const THUMB_SIZE = 320;
// Pulling a whole file just to draw a preview is only worth it up to a point.
const MAX_REMOTE_BYTES = { image: 60 * 1024 * 1024, video: 250 * 1024 * 1024 };

/** Generates and caches thumbnails for photos and videos, on the phone or on the Mac. */
class Thumbnailer {
  constructor(cacheDir, tmpDir) {
    this.cacheDir = cacheDir;
    this.tmpDir = tmpDir;
    this.queue = [];
    this.active = 0;
    this.concurrency = 2;
    this.gen = 0;
    this.inflight = new Map();
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  key(scope, p, size, mtime) {
    return crypto.createHash('sha1').update(`${scope}|${p}|${size}|${mtime}`).digest('hex');
  }

  /**
   * @returns {Promise<string|null>} path of a cached PNG, or null if no preview is possible.
   * `gen` lets the UI drop stale requests after it navigates to another folder.
   */
  get({ fsys, scope, entry, gen }) {
    const kind = kindOf(entry.name);
    if (kind !== 'image' && kind !== 'video') return Promise.resolve(null);
    const local = fsys.localPath ? fsys.localPath(entry.path) : null;
    if (!local && entry.size > MAX_REMOTE_BYTES[kind]) return Promise.resolve(null);

    const k = this.key(scope, entry.path, entry.size, entry.mtime);
    const out = path.join(this.cacheDir, k + '.png');
    if (fs.existsSync(out)) return Promise.resolve(out);
    if (this.inflight.has(k)) return this.inflight.get(k);

    if (gen > this.gen) this.gen = gen;
    const p = new Promise((resolve) => {
      // Newest requests first: what is on screen right now matters most.
      this.queue.unshift({ resolve, fsys, entry, local, out, k, gen });
      this.pump();
    }).finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const task = this.queue.shift();
      if (task.gen < this.gen) {
        task.resolve(null);
        continue;
      }
      this.active++;
      this.make(task)
        .then(task.resolve, () => task.resolve(null))
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  async make({ fsys, entry, local, out, k }) {
    let src = local;
    let tmp = null;
    if (!src) {
      tmp = path.join(this.tmpDir, `${k}.${extOf(entry.name) || 'bin'}`);
      await pipeline(await fsys.openRead(entry.path), fs.createWriteStream(tmp));
      src = tmp;
    }
    try {
      let img = null;
      try {
        // macOS: uses Quick Look, so HEIC photos and videos work too.
        img = await nativeImage.createThumbnailFromPath(src, { width: THUMB_SIZE, height: THUMB_SIZE });
      } catch {
        if (kindOf(entry.name) === 'image') {
          const full = nativeImage.createFromPath(src);
          if (!full.isEmpty()) {
            const { width, height } = full.getSize();
            const scale = Math.min(1, THUMB_SIZE / Math.max(width, height));
            img = full.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' });
          }
        }
      }
      if (!img || img.isEmpty()) return null;
      await fsp.writeFile(out, img.toPNG());
      return out;
    } finally {
      if (tmp) fsp.unlink(tmp).catch(() => {});
    }
  }
}

module.exports = { Thumbnailer };
