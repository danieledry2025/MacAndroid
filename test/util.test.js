'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { shq, uniqueName, sortEntries, parseDf, externalVolumes, kindOf } = require('../src/main/util');

test('shq quotes for the Android shell', () => {
  assert.strictEqual(shq('a b'), "'a b'");
  assert.strictEqual(shq("it's"), "'it'\\''s'");
  assert.strictEqual(shq('$(rm -rf /)'), "'$(rm -rf /)'");
});

test('uniqueName adds Finder style suffixes', async () => {
  const taken = new Set(['photo.jpg', 'photo (1).jpg', 'Folder']);
  const exists = async (n) => taken.has(n);
  assert.strictEqual(await uniqueName('photo.jpg', exists), 'photo (2).jpg');
  assert.strictEqual(await uniqueName('Folder', exists), 'Folder (1)');
  assert.strictEqual(await uniqueName('new.txt', exists), 'new.txt');
});

test('sortEntries puts folders first and sorts numbers naturally', () => {
  const out = sortEntries([
    { name: 'img10.jpg', isDir: false },
    { name: 'img2.jpg', isDir: false },
    { name: 'Zeta', isDir: true },
    { name: 'alpha', isDir: true },
  ]).map((e) => e.name);
  assert.deepStrictEqual(out, ['alpha', 'Zeta', 'img2.jpg', 'img10.jpg']);
});

test('parseDf reads toybox df -k output', () => {
  const text = `Filesystem      1K-blocks     Used Available Use% Mounted on
/dev/fuse       115249236 60123456  55125780  53% /storage/emulated
/dev/block/vold/public:179,1 62504960 1024 62503936   1% /storage/1234-ABCD
`;
  const df = parseDf(text);
  assert.strictEqual(df['/storage/emulated'].free, 55125780 * 1024);
  assert.strictEqual(df['/storage/1234-ABCD'].total, 62504960 * 1024);
});

test('externalVolumes skips emulated and self', () => {
  assert.deepStrictEqual(externalVolumes(['emulated', 'self', '1234-ABCD', '.hidden']), ['1234-ABCD']);
});

test('kindOf classifies common phone files', () => {
  assert.strictEqual(kindOf('IMG_1.HEIC'), 'image');
  assert.strictEqual(kindOf('VID_1.mp4'), 'video');
  assert.strictEqual(kindOf('voice.opus'), 'audio');
  assert.strictEqual(kindOf('README'), 'file');
});
