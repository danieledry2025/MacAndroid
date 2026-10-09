'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LocalFs } = require('../src/main/local');
const { TransferQueue } = require('../src/main/transfers');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'macandroid-test-'));
}

/** A LocalFs rooted at a folder stands in for the phone: different instance, posix paths. */
function setup() {
  const phoneRoot = tmpdir();
  const mac = tmpdir();
  const phone = new LocalFs(phoneRoot);
  const base = path.join(phoneRoot, 'storage/emulated/0');
  fs.mkdirSync(path.join(base, 'DCIM/Camera'), { recursive: true });
  fs.writeFileSync(path.join(base, 'DCIM/Camera/a.jpg'), 'AAAA');
  fs.writeFileSync(path.join(base, 'DCIM/Camera/b.jpg'), 'BBBBBB');
  fs.writeFileSync(path.join(base, 'note.txt'), 'hello');
  return { phone, mac, local: new LocalFs(), base };
}

function waitFor(queue, id) {
  return new Promise((resolve) => {
    const fn = (job) => {
      if (job.id === id) {
        queue.off('finished', fn);
        resolve(job);
      }
    };
    queue.on('finished', fn);
  });
}

test('copies a folder from phone to Mac with byte totals', async () => {
  const { phone, mac, local } = setup();
  const q = new TransferQueue({ askConflict: async () => ({ action: 'skip' }) });
  const id = q.add({ src: phone, dst: local, items: ['/storage/emulated/0/DCIM'], dstDir: mac });
  const job = await waitFor(q, id);
  assert.strictEqual(job.state, 'done');
  assert.strictEqual(job.filesDone, 2);
  assert.strictEqual(job.totalBytes, 10);
  assert.strictEqual(fs.readFileSync(path.join(mac, 'DCIM/Camera/b.jpg'), 'utf8'), 'BBBBBB');
});

test('conflict: keep both, replace and skip', async () => {
  const { phone, mac, local } = setup();
  fs.writeFileSync(path.join(mac, 'note.txt'), 'old');

  let q = new TransferQueue({ askConflict: async () => ({ action: 'keep' }) });
  await waitFor(q, q.add({ src: phone, dst: local, items: ['/storage/emulated/0/note.txt'], dstDir: mac }));
  assert.strictEqual(fs.readFileSync(path.join(mac, 'note (1).txt'), 'utf8'), 'hello');
  assert.strictEqual(fs.readFileSync(path.join(mac, 'note.txt'), 'utf8'), 'old');

  q = new TransferQueue({ askConflict: async () => ({ action: 'skip' }) });
  await waitFor(q, q.add({ src: phone, dst: local, items: ['/storage/emulated/0/note.txt'], dstDir: mac }));
  assert.strictEqual(fs.readFileSync(path.join(mac, 'note.txt'), 'utf8'), 'old');

  q = new TransferQueue({ askConflict: async () => ({ action: 'replace' }) });
  await waitFor(q, q.add({ src: phone, dst: local, items: ['/storage/emulated/0/note.txt'], dstDir: mac }));
  assert.strictEqual(fs.readFileSync(path.join(mac, 'note.txt'), 'utf8'), 'hello');
});

test('copies from Mac to phone', async () => {
  const { phone, mac, local, base } = setup();
  fs.writeFileSync(path.join(mac, 'song.mp3'), 'music');
  const q = new TransferQueue({ askConflict: async () => ({ action: 'skip' }) });
  const job = await waitFor(q, q.add({ src: local, dst: phone, items: [path.join(mac, 'song.mp3')], dstDir: '/storage/emulated/0/Music' }));
  assert.strictEqual(job.state, 'error'); // Music folder does not exist yet
  fs.mkdirSync(path.join(base, 'Music'));
  const job2 = await waitFor(q, q.add({ src: local, dst: phone, items: [path.join(mac, 'song.mp3')], dstDir: '/storage/emulated/0/Music' }));
  assert.strictEqual(job2.state, 'done');
  assert.strictEqual(fs.readFileSync(path.join(base, 'Music/song.mp3'), 'utf8'), 'music');
});

test('refuses to copy a folder into itself', async () => {
  const { phone } = setup();
  const q = new TransferQueue({ askConflict: async () => ({ action: 'keep' }) });
  const job = await waitFor(q, q.add({ src: phone, dst: phone, items: ['/storage/emulated/0/DCIM'], dstDir: '/storage/emulated/0/DCIM/Camera' }));
  assert.strictEqual(job.state, 'error');
});

test('rooted LocalFs cannot escape its root', () => {
  const fsys = new LocalFs('/tmp/phone');
  assert.strictEqual(fsys.real('/../../etc/passwd'), '/tmp/phone/etc/passwd');
});
