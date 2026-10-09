'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { LocalFs } = require('../src/main/local');
const { DavServer } = require('../src/main/webdav');
const { findMountPoint, volumeName } = require('../src/main/finder');

function request(server, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.port, method, path: urlPath, headers: { host: `127.0.0.1:${server.port}`, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function setup(vols) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'macandroid-dav-'));
  const base = path.join(root, 'storage/emulated/0');
  fs.mkdirSync(path.join(base, 'DCIM/Camera'), { recursive: true });
  fs.writeFileSync(path.join(base, 'DCIM/Camera/a.jpg'), '0123456789');
  fs.mkdirSync(path.join(root, 'storage/AB12-CD34'), { recursive: true });
  const storages = vols || [{ label: 'אחסון פנימי', path: '/storage/emulated/0', total: 1000, free: 400 }];
  const server = new DavServer({ fsys: new LocalFs(root), name: 'Galaxy S23', storages: async () => storages });
  await server.listen();
  const B = '/' + encodeURIComponent('Galaxy S23');
  return { server, base, root, B };
}

test('PROPFIND lists the phone with sizes and quota', async (t) => {
  const { server, B } = await setup();
  t.after(() => server.close());
  const r = await request(server, 'PROPFIND', B + '/', { headers: { depth: '1' } });
  assert.strictEqual(r.status, 207);
  assert.match(r.body, /<D:href>\/Galaxy%20S23\/DCIM\/<\/D:href>/);
  assert.match(r.body, /quota-available-bytes>400</);
  const r2 = await request(server, 'PROPFIND', B + '/DCIM/Camera/a.jpg', { headers: { depth: '0' } });
  assert.match(r2.body, /getcontentlength>10</);
  const r3 = await request(server, 'PROPFIND', B + '/nope', { headers: { depth: '0' } });
  assert.strictEqual(r3.status, 404);
});

test('GET supports byte ranges', async (t) => {
  const { server, B } = await setup();
  t.after(() => server.close());
  const full = await request(server, 'GET', B + '/DCIM/Camera/a.jpg');
  assert.strictEqual(full.body, '0123456789');
  const part = await request(server, 'GET', B + '/DCIM/Camera/a.jpg', { headers: { range: 'bytes=2-4' } });
  assert.strictEqual(part.status, 206);
  assert.strictEqual(part.body, '234');
  assert.strictEqual(part.headers['content-range'], 'bytes 2-4/10');
  const tail = await request(server, 'GET', B + '/DCIM/Camera/a.jpg', { headers: { range: 'bytes=-3' } });
  assert.strictEqual(tail.body, '789');
});

test('PUT, MKCOL, MOVE, COPY and DELETE change the phone', async (t) => {
  const { server, base, B } = await setup();
  t.after(() => server.close());
  assert.strictEqual((await request(server, 'MKCOL', B + '/' + encodeURIComponent('חופשה'))).status, 201);
  assert.strictEqual((await request(server, 'PUT', B + '/' + encodeURIComponent('חופשה') + '/x.txt', { body: 'hello' })).status, 201);
  assert.strictEqual(fs.readFileSync(path.join(base, 'חופשה/x.txt'), 'utf8'), 'hello');
  const dest = `http://127.0.0.1:${server.port}${B}/${encodeURIComponent('חופשה')}/y.txt`;
  assert.strictEqual((await request(server, 'MOVE', B + '/' + encodeURIComponent('חופשה') + '/x.txt', { headers: { destination: dest } })).status, 201);
  assert.ok(fs.existsSync(path.join(base, 'חופשה/y.txt')));
  assert.ok(!fs.existsSync(path.join(base, 'חופשה/x.txt')));
  const copyDest = `http://127.0.0.1:${server.port}${B}/z.txt`;
  assert.strictEqual((await request(server, 'COPY', B + '/' + encodeURIComponent('חופשה') + '/y.txt', { headers: { destination: copyDest } })).status, 201);
  assert.strictEqual(fs.readFileSync(path.join(base, 'z.txt'), 'utf8'), 'hello');
  assert.strictEqual((await request(server, 'MOVE', B + '/z.txt', { headers: { destination: dest, overwrite: 'F' } })).status, 412);
  assert.strictEqual((await request(server, 'DELETE', B + '/' + encodeURIComponent('חופשה'))).status, 204);
  assert.ok(!fs.existsSync(path.join(base, 'חופשה')));
  assert.strictEqual((await request(server, 'PUT', B + '/missing/dir/f.txt', { body: 'x' })).status, 409);
});

test('Finder junk files never reach the phone', async (t) => {
  const { server, base, B } = await setup();
  t.after(() => server.close());
  assert.strictEqual((await request(server, 'PUT', B + '/._a.jpg', { body: 'meta' })).status, 201);
  assert.strictEqual((await request(server, 'PUT', B + '/.DS_Store', { body: 'ds' })).status, 201);
  assert.ok(!fs.existsSync(path.join(base, '._a.jpg')));
  assert.ok(!fs.existsSync(path.join(base, '.DS_Store')));
  assert.strictEqual((await request(server, 'GET', B + '/._a.jpg')).body, 'meta');
  assert.strictEqual((await request(server, 'MKCOL', B + '/.Trashes')).status, 403);
});

test('LOCK returns a token so Finder mounts read-write', async (t) => {
  const { server, B } = await setup();
  t.after(() => server.close());
  const opt = await request(server, 'OPTIONS', B + '/');
  assert.strictEqual(opt.headers.dav, '1, 2');
  const r = await request(server, 'LOCK', B + '/DCIM/Camera/a.jpg', { body: '<lockinfo/>' });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers['lock-token'], /^<opaquelocktoken:/);
});

test('rejects web pages and other hosts', async (t) => {
  const { server, B } = await setup();
  t.after(() => server.close());
  assert.strictEqual((await request(server, 'GET', B + '/', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.strictEqual((await request(server, 'GET', B + '/', { headers: { host: 'evil.example' } })).status, 403);
  assert.strictEqual((await request(server, 'GET', B + '/../../etc/passwd')).status, 404);
});

test('several storages appear as folders at the top', async (t) => {
  const { server, B } = await setup([
    { label: 'אחסון פנימי', path: '/storage/emulated/0', total: 1000, free: 400 },
    { label: 'כרטיס SD', path: '/storage/AB12-CD34', total: 500, free: 100 },
  ]);
  t.after(() => server.close());
  const r = await request(server, 'PROPFIND', B + '/', { headers: { depth: '1' } });
  assert.match(r.body, new RegExp(encodeURIComponent('כרטיס SD')));
  const r2 = await request(server, 'GET', B + '/' + encodeURIComponent('אחסון פנימי') + '/DCIM/Camera/a.jpg');
  assert.strictEqual(r2.body, '0123456789');
  assert.strictEqual((await request(server, 'DELETE', B + '/' + encodeURIComponent('כרטיס SD'))).status, 403);
});

test('finds the mount point in mount output', () => {
  const out = `/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
http://127.0.0.1:52811/Galaxy%20S23/ on /Volumes/Galaxy S23 (webdav, nodev, noexec, nosuid, mounted by dan)`;
  assert.strictEqual(findMountPoint(out, 52811), '/Volumes/Galaxy S23');
  assert.strictEqual(findMountPoint(out, 1), null);
  assert.strictEqual(volumeName('Samsung: Galaxy/S23'), 'Samsung Galaxy S23');
});
