'use strict';

// A pretend phone backed by a folder on disk. Lets you try the whole app without a device:
//   MACANDROID_MOCK=1 npm start            (uses ./mock-phone, created on first run)
//   MACANDROID_MOCK=/some/folder npm start

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Transform } = require('stream');
const { LocalFs } = require('./local');

/** Slow a stream down to roughly `bytesPerSec`, so progress bars are visible in demos. */
function throttle(bytesPerSec) {
  const started = Date.now();
  let sent = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      sent += chunk.length;
      const wait = Math.max(0, (sent / bytesPerSec) * 1000 - (Date.now() - started));
      setTimeout(() => cb(null, chunk), wait);
    },
  });
}

class MockDeviceFs extends LocalFs {
  constructor(root) {
    super(root);
    this.kind = 'device';
  }

  async openRead(p) {
    return (await super.openRead(p)).pipe(throttle(40 * 1024 * 1024));
  }

  async storages() {
    const s = fs.statfsSync ? fs.statfsSync(this.root) : null;
    const total = s ? s.blocks * s.bsize : 128e9;
    const free = s ? s.bavail * s.bsize : 64e9;
    return [{ id: 'internal', label: 'אחסון פנימי', path: '/storage/emulated/0', type: 'internal', total, free, used: total - free }];
  }

  localPath() {
    // Pretend we are remote: thumbnails and opening go through the normal pull path.
    return null;
  }
}

function seed(root) {
  const base = path.join(root, 'storage', 'emulated', '0');
  if (fs.existsSync(base)) return;
  for (const d of ['DCIM/Camera', 'Download', 'Pictures/Screenshots', 'Music', 'Documents', 'WhatsApp/Media/WhatsApp Images', 'Movies']) {
    fs.mkdirSync(path.join(base, d), { recursive: true });
  }
  fs.writeFileSync(path.join(base, 'Documents', 'notes.txt'), 'שלום מהטלפון!\n');
  fs.writeFileSync(path.join(base, 'Download', 'big-file.bin'), Buffer.alloc(80 * 1024 * 1024));
  // Tiny coloured PNGs so the thumbnail grid has something to show.
  const { pngSolid } = require('./mockpng');
  const colors = [[230, 80, 70], [70, 160, 230], [90, 200, 120], [240, 190, 60], [160, 100, 220], [40, 40, 60]];
  colors.forEach((c, i) => {
    fs.writeFileSync(path.join(base, 'DCIM', 'Camera', `IMG_2026100${i + 1}_1200${i}.png`), pngSolid(320, 240, c));
  });
  fs.writeFileSync(path.join(base, 'Pictures', 'Screenshots', 'Screenshot_1.png'), pngSolid(240, 480, [30, 30, 30]));
}

class MockManager extends EventEmitter {
  constructor(root) {
    super();
    this.root = path.resolve(root);
    this.adbPath = '(mock)';
  }

  async start() {
    fs.mkdirSync(this.root, { recursive: true });
    seed(this.root);
    this.device = { id: 'MOCK-0001', state: 'device', name: 'Samsung Galaxy (דמו)', model: 'Galaxy', android: '15' };
    this.mockFs = new MockDeviceFs(this.root);
    setTimeout(() => this.emit('devices', this.list()), 300);
  }

  list() {
    return [this.device];
  }

  fs() {
    return this.mockFs;
  }

  stop() {}
}

module.exports = { MockManager };
