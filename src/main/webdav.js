'use strict';

// A small WebDAV server that exposes one phone to macOS Finder.
//
// macOS can mount WebDAV natively ("Connect to Server"), so the phone shows up as a regular drive in
// Finder without macFUSE or any kernel extension. The server listens on 127.0.0.1 only and rejects
// requests that come from web pages (Host/Origin checks), so nothing outside this Mac can reach it.

const http = require('http');
const crypto = require('crypto');
const path = require('path').posix;

const LISTING_TTL = 3000;
// Finder litters every volume with these. They are kept in memory so the phone stays clean.
const JUNK_FILE = (name) => name.startsWith('._') || name === '.DS_Store' || name === '.localized';
const JUNK_DIR = new Set(['.Trashes', '.Spotlight-V100', '.fseventsd', '.TemporaryItems', '.metadata_never_index', '.ql_disablethumbnails']);
const MAX_JUNK_BYTES = 4 * 1024 * 1024;

const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', '3gp': 'video/3gpp', mkv: 'video/x-matroska', webm: 'video/webm',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', html: 'text/html', json: 'application/json', zip: 'application/zip',
  apk: 'application/vnd.android.package-archive',
};
const mimeOf = (name) => MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

class HttpError extends Error {
  constructor(status, message) {
    super(message || http.STATUS_CODES[status]);
    this.status = status;
  }
}

/**
 * @param {object} opts
 * @param {object} opts.fsys     DeviceFs (or LocalFs) to expose
 * @param {string} opts.name     volume name shown in Finder
 * @param {() => Promise<Array>} opts.storages  phone volumes [{label, path, total, free}]
 */
class DavServer {
  constructor({ fsys, name, storages }) {
    this.fsys = fsys;
    this.name = name;
    this.getStorages = storages;
    this.base = '/' + encodeURIComponent(name) + '/';
    this.listings = new Map(); // device dir -> { time, entries }
    this.junk = new Map(); // device path -> { data, mtime }
    this.locks = new Map(); // href (decoded, no trailing slash) -> { token, scope, depth, owner, expires, timeout }
    this.storages = null;
    this.storagesAt = 0;
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.keepAliveTimeout = 60000;
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        this.url = `http://127.0.0.1:${this.port}${this.base}`;
        resolve(this.url);
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }

  // ---------------------------------------------------------------- mapping

  async volumes() {
    if (!this.storages || Date.now() - this.storagesAt > 30000) {
      try {
        this.storages = await this.getStorages();
        this.storagesAt = Date.now();
      } catch {
        this.storages = this.storages || [{ label: 'אחסון פנימי', path: '/storage/emulated/0' }];
      }
    }
    return this.storages;
  }

  /**
   * Turn a request path into { href, device } where `device` is the phone path, or null for the
   * virtual root that lists several storages (internal + SD card).
   */
  async resolve(urlPath) {
    let p;
    try {
      p = decodeURIComponent(urlPath.split('?')[0]);
    } catch {
      throw new HttpError(400);
    }
    const baseDecoded = '/' + this.name + '/';
    if (p === '/' || p === '/' + this.name) p = baseDecoded;
    if (!p.startsWith(baseDecoded)) throw new HttpError(404);
    const rel = path.normalize('/' + p.slice(baseDecoded.length));
    if (rel.split('/').includes('..')) throw new HttpError(403);
    const parts = rel.split('/').filter(Boolean);
    const vols = await this.volumes();
    const href = baseDecoded + parts.join('/');
    if (vols.length === 1) return { href, rel: parts, device: path.join(vols[0].path, ...parts), vol: vols[0] };
    if (!parts.length) return { href, rel: parts, device: null, vol: null };
    const vol = vols.find((v) => v.label === parts[0]);
    if (!vol) throw new HttpError(404);
    return { href, rel: parts, device: path.join(vol.path, ...parts.slice(1)), vol };
  }

  hrefFor(target) {
    // Collections end with "/", as Finder expects.
    return encodePath(target.href) + (target.isDir && !target.href.endsWith('/') ? '/' : '');
  }

  // ---------------------------------------------------------------- cached metadata

  async list(dir) {
    const hit = this.listings.get(dir);
    if (hit && Date.now() - hit.time < LISTING_TTL) return hit.entries;
    const entries = await this.fsys.readdir(dir);
    this.listings.set(dir, { time: Date.now(), entries });
    return entries;
  }

  invalidate(p) {
    this.listings.delete(p);
    this.listings.delete(path.dirname(p));
  }

  /** Stat a phone path; null if it does not exist. */
  async stat(p) {
    const name = path.basename(p);
    if (this.junk.has(p)) {
      const j = this.junk.get(p);
      return { name, path: p, isDir: false, size: j.data.length, mtime: j.mtime };
    }
    if (JUNK_FILE(name) || JUNK_DIR.has(name)) return null;
    const parent = this.listings.get(path.dirname(p));
    if (parent && Date.now() - parent.time < LISTING_TTL) {
      return parent.entries.find((e) => e.name === name) || null;
    }
    try {
      const s = await this.fsys.stat(p);
      return { name, path: p, ...s };
    } catch {
      return null;
    }
  }

  async target(urlPath) {
    const t = await this.resolve(urlPath);
    if (t.device === null) return { ...t, exists: true, isDir: true, entry: { name: this.name, isDir: true, size: 0, mtime: Date.now() } };
    const isVolRoot = t.vol && t.device === t.vol.path;
    const entry = isVolRoot ? { name: t.vol.label, isDir: true, size: 0, mtime: Date.now() } : await this.stat(t.device);
    return { ...t, exists: Boolean(entry), isDir: Boolean(entry && entry.isDir), entry };
  }

  // ---------------------------------------------------------------- request handling

  guard(req) {
    // Only this Mac, and never a web page (blocks DNS rebinding and cross site requests).
    const host = (req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) throw new HttpError(403);
    if (req.headers.origin) throw new HttpError(403);
  }

  async handle(req, res) {
    res.setHeader('DAV', '1, 2');
    res.setHeader('MS-Author-Via', 'DAV');
    try {
      this.guard(req);
      const method = req.method.toUpperCase();
      const fn = {
        OPTIONS: this.options,
        PROPFIND: this.propfind,
        PROPPATCH: this.proppatch,
        GET: this.get,
        HEAD: this.get,
        PUT: this.put,
        DELETE: this.delete,
        MKCOL: this.mkcol,
        MOVE: this.move,
        COPY: this.move,
        LOCK: this.lock,
        UNLOCK: this.unlock,
      }[method];
      if (!fn) throw new HttpError(405);
      await fn.call(this, req, res);
    } catch (err) {
      const status = err.status || 500;
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(status === 500 ? String(err.message || err) : http.STATUS_CODES[status]);
      } else {
        res.destroy();
      }
      req.resume();
    }
  }

  options(req, res) {
    res.writeHead(200, {
      Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK',
      'Content-Length': 0,
    });
    res.end();
  }

  async readBody(req, limit = 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new HttpError(413);
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  lockDiscovery(encodedHref) {
    let href;
    try {
      href = decodeURIComponent(encodedHref);
    } catch {
      return '<D:lockdiscovery/>';
    }
    const locks = this.locksCovering(href);
    if (!locks.length) return '<D:lockdiscovery/>';
    return `<D:lockdiscovery>${locks.map((l) => this.lockXml(l, l.key.split('\u0000')[0])).join('')}</D:lockdiscovery>`;
  }

  propXml(href, e, isDir, quota) {
    const mtime = new Date(e.mtime || Date.now());
    const props = [
      `<D:displayname>${xmlEsc(e.name)}</D:displayname>`,
      `<D:getlastmodified>${mtime.toUTCString()}</D:getlastmodified>`,
      `<D:creationdate>${mtime.toISOString()}</D:creationdate>`,
      `<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>`,
      this.lockDiscovery(href),
    ];
    if (isDir) {
      props.push('<D:resourcetype><D:collection/></D:resourcetype>');
      if (quota && quota.total) {
        props.push(`<D:quota-available-bytes>${quota.free}</D:quota-available-bytes>`);
        props.push(`<D:quota-used-bytes>${quota.total - quota.free}</D:quota-used-bytes>`);
      }
    } else {
      props.push('<D:resourcetype/>');
      props.push(`<D:getcontentlength>${e.size || 0}</D:getcontentlength>`);
      props.push(`<D:getcontenttype>${xmlEsc(mimeOf(e.name))}</D:getcontenttype>`);
      props.push(`<D:getetag>"${(e.size || 0).toString(16)}-${Math.floor(e.mtime || 0).toString(16)}"</D:getetag>`);
    }
    return `<D:response><D:href>${xmlEsc(href)}</D:href><D:propstat><D:prop>${props.join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  }

  async propfind(req, res) {
    await this.readBody(req);
    const t = await this.target(req.url);
    if (!t.exists) throw new HttpError(404);
    const depth = req.headers.depth === '0' ? 0 : 1;
    const vols = await this.volumes();
    const quotaOf = (vol) => vol || (vols.length === 1 ? vols[0] : vols.reduce((a, v) => ({ total: (a.total || 0) + (v.total || 0), free: (a.free || 0) + (v.free || 0) }), {}));
    const parts = [this.propXml(this.hrefFor(t), t.entry, t.isDir, quotaOf(t.vol))];

    if (depth === 1 && t.isDir) {
      if (t.device === null) {
        for (const v of vols) {
          parts.push(this.propXml(encodePath(path.join(t.href, v.label)) + '/', { name: v.label, mtime: Date.now() }, true, v));
        }
      } else {
        const entries = await this.list(t.device);
        for (const e of entries) {
          if (JUNK_DIR.has(e.name) || JUNK_FILE(e.name)) continue;
          parts.push(this.propXml(encodePath(path.join(t.href, e.name)) + (e.isDir ? '/' : ''), e, e.isDir, null));
        }
        for (const [p, j] of this.junk) {
          if (path.dirname(p) === t.device) {
            parts.push(this.propXml(encodePath(path.join(t.href, path.basename(p))), { name: path.basename(p), size: j.data.length, mtime: j.mtime }, false));
          }
        }
      }
    }
    const body = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${parts.join('')}</D:multistatus>`;
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  async proppatch(req, res) {
    const body = (await this.readBody(req)).toString();
    const t = await this.target(req.url);
    if (!t.exists) throw new HttpError(404);
    this.checkWrite(req, t.href);
    // Accept and ignore: phones have no place to store Finder metadata.
    const names = [...body.matchAll(/<([A-Za-z0-9_-]+:)?([A-Za-z0-9_-]+)\s*(\/>|>)/g)]
      .map((m) => m[2])
      .filter((n) => !['propertyupdate', 'set', 'remove', 'prop'].includes(n));
    const props = names.map((n) => `<X:${n} xmlns:X="urn:ignored"/>`).join('');
    const xml = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${xmlEsc(
      this.hrefFor(t)
    )}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(xml) });
    res.end(xml);
  }

  async get(req, res) {
    const t = await this.target(req.url);
    if (!t.exists) throw new HttpError(404);
    const head = req.method.toUpperCase() === 'HEAD';
    if (t.isDir) {
      const items = t.device === null ? (await this.volumes()).map((v) => ({ name: v.label, isDir: true })) : await this.list(t.device);
      const html = `<!doctype html><meta charset="utf-8"><title>${xmlEsc(t.entry.name)}</title><ul>${items
        .map((e) => `<li><a href="${xmlEsc(encodePath(path.join(t.href, e.name)) + (e.isDir ? '/' : ''))}">${xmlEsc(e.name)}${e.isDir ? '/' : ''}</a></li>`)
        .join('')}</ul>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      return res.end(head ? undefined : html);
    }
    const e = t.entry;
    const headers = {
      'Content-Type': mimeOf(e.name),
      'Last-Modified': new Date(e.mtime).toUTCString(),
      ETag: `"${e.size.toString(16)}-${Math.floor(e.mtime).toString(16)}"`,
      'Accept-Ranges': 'bytes',
    };
    if (this.junk.has(t.device)) {
      const data = this.junk.get(t.device).data;
      res.writeHead(200, { ...headers, 'Content-Length': data.length });
      return res.end(head ? undefined : data);
    }
    let start = 0;
    let end = e.size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && e.size > 0) {
      if (range[1] === '') {
        start = Math.max(0, e.size - Number(range[2]));
      } else {
        start = Number(range[1]);
        if (range[2] !== '') end = Math.min(end, Number(range[2]));
      }
      if (start > end || start >= e.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${e.size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${e.size}`;
    }
    headers['Content-Length'] = e.size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (head || e.size === 0) return res.end();
    const stream = status === 206 && this.fsys.openReadRange ? await this.fsys.openReadRange(t.device, start, end) : await this.fsys.openRead(t.device);
    res.on('close', () => {
      if (!res.writableFinished) {
        if (typeof stream.cancel === 'function') stream.cancel();
        stream.destroy();
      }
    });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  /** WebDAV never creates missing parent folders implicitly. */
  async requireParent(t) {
    const dir = path.dirname(t.device);
    if (t.vol && dir === t.vol.path) return;
    const parent = await this.stat(dir);
    if (!parent || !parent.isDir) throw new HttpError(409);
  }

  async put(req, res) {
    const t = await this.resolve(req.url);
    if (t.device === null || (t.vol && t.device === t.vol.path)) throw new HttpError(405);
    this.checkWrite(req, t.href);
    const name = path.basename(t.device);
    if (JUNK_FILE(name)) {
      const data = await this.readBody(req, MAX_JUNK_BYTES);
      const existed = this.junk.has(t.device);
      this.junk.set(t.device, { data, mtime: Date.now() });
      res.writeHead(existed ? 204 : 201, { 'Content-Length': 0 });
      return res.end();
    }
    await this.requireParent(t);
    const existing = await this.stat(t.device);
    if (existing && existing.isDir) throw new HttpError(405);
    await this.fsys.writeFrom(req, t.device);
    this.invalidate(t.device);
    res.writeHead(existing ? 204 : 201, { 'Content-Length': 0 });
    res.end();
  }

  async delete(req, res) {
    const t = await this.target(req.url);
    if (t.device === null || (t.vol && t.device === t.vol.path)) throw new HttpError(403);
    this.checkWriteTree(req, t.href);
    if (this.junk.delete(t.device)) {
      res.writeHead(204);
      return res.end();
    }
    if (!t.exists) throw new HttpError(404);
    await this.fsys.remove(t.device);
    this.invalidate(t.device);
    this.dropLocks(t.href);
    res.writeHead(204);
    res.end();
  }

  async mkcol(req, res) {
    if ((await this.readBody(req)).length) throw new HttpError(415);
    const t = await this.target(req.url);
    if (t.device === null || t.exists) throw new HttpError(405);
    if (JUNK_DIR.has(path.basename(t.device))) throw new HttpError(403);
    await this.requireParent(t);
    this.checkWrite(req, t.href);
    await this.fsys.mkdir(t.device);
    this.invalidate(t.device);
    res.writeHead(201, { 'Content-Length': 0 });
    res.end();
  }

  async move(req, res) {
    const isCopy = req.method.toUpperCase() === 'COPY';
    const src = await this.target(req.url);
    if (!src.exists) throw new HttpError(404);
    if (src.device === null || (src.vol && src.device === src.vol.path)) throw new HttpError(403);
    let destUrl;
    try {
      destUrl = new URL(req.headers.destination || '', `http://${req.headers.host}`).pathname;
    } catch {
      throw new HttpError(400);
    }
    const dst = await this.target(destUrl);
    if (dst.device === null || (dst.vol && dst.device === dst.vol.path)) throw new HttpError(403);
    if (dst.device === src.device) throw new HttpError(403);
    if (src.isDir && dst.device.startsWith(src.device + '/')) throw new HttpError(409);
    const overwrite = (req.headers.overwrite || 'T').toUpperCase() !== 'F';
    if (!isCopy) this.checkWriteTree(req, src.href);
    this.checkWriteTree(req, dst.href);

    if (this.junk.has(src.device)) {
      const j = this.junk.get(src.device);
      if (!isCopy) this.junk.delete(src.device);
      if (JUNK_FILE(path.basename(dst.device))) this.junk.set(dst.device, { ...j });
      res.writeHead(201, { 'Content-Length': 0 });
      return res.end();
    }
    if (dst.exists && !overwrite) throw new HttpError(412);
    await this.requireParent(dst);
    if (dst.exists) await this.fsys.remove(dst.device);
    if (isCopy) await this.fsys.copyWithin(src.device, dst.device);
    else {
      await this.fsys.rename(src.device, dst.device);
      this.dropLocks(src.href);
    }
    this.invalidate(src.device);
    this.invalidate(dst.device);
    res.writeHead(dst.exists ? 204 : 201, { 'Content-Length': 0 });
    res.end();
  }

  // ---------------------------------------------------------------- locks
  // Finder locks files while it writes them and refreshes those locks; honour that properly.

  lockKey(href) {
    return href.replace(/\/+$/, '') || '/';
  }

  activeLocks() {
    const now = Date.now();
    for (const [k, l] of this.locks) if (l.expires < now) this.locks.delete(k);
    return this.locks;
  }

  /** Locks that cover `href`: on it, or on a parent folder with depth infinity. */
  locksCovering(href) {
    const key = this.lockKey(href);
    const out = [];
    for (const [k, l] of this.activeLocks()) {
      const base = k.split('\u0000')[0];
      if (base === key || (l.depth === 'infinity' && key.startsWith(base + '/'))) out.push({ key: k, ...l });
    }
    return out;
  }

  /** Lock tokens mentioned in the If header. */
  ifTokens(req) {
    return [...String(req.headers.if || '').matchAll(/<(opaquelocktoken:[^>]+)>/g)].map((m) => m[1]);
  }

  /**
   * Check write access to `href`: every lock covering it must be named in the If header, and an If
   * header naming only unknown tokens fails (precondition).
   */
  checkWrite(req, href) {
    const tokens = this.ifTokens(req);
    const covering = this.locksCovering(href);
    if (covering.some((l) => !tokens.includes(l.token))) throw new HttpError(423);
    if (req.headers.if && !/Not\s*</i.test(req.headers.if)) {
      const known = new Set([...this.activeLocks().values()].map((l) => l.token));
      const etagOnly = !tokens.length;
      if (!etagOnly && !tokens.some((t) => known.has(t))) throw new HttpError(412);
    }
  }

  /** Writing inside a folder also needs the folder's depth-infinity lock (if any). */
  checkWriteTree(req, href) {
    this.checkWrite(req, href);
    const key = this.lockKey(href);
    const tokens = this.ifTokens(req);
    for (const [k, l] of this.activeLocks()) {
      if (k.startsWith(key + '/') && !tokens.includes(l.token)) throw new HttpError(423);
    }
  }

  dropLocks(href) {
    const key = this.lockKey(href);
    for (const k of [...this.locks.keys()]) {
      const base = k.split('\u0000')[0];
      if (base === key || base.startsWith(key + '/')) this.locks.delete(k);
    }
  }

  lockXml(l, href) {
    const secs = Math.max(0, Math.round((l.expires - Date.now()) / 1000));
    return `<D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:${l.scope}/></D:lockscope><D:depth>${l.depth}</D:depth>${
      l.owner ? `<D:owner>${l.owner}</D:owner>` : '<D:owner/>'
    }<D:timeout>Second-${secs}</D:timeout><D:locktoken><D:href>${l.token}</D:href></D:locktoken><D:lockroot><D:href>${xmlEsc(encodePath(href))}</D:href></D:lockroot></D:activelock>`;
  }

  async lock(req, res) {
    const body = (await this.readBody(req)).toString();
    const t = await this.target(req.url);
    const key = this.lockKey(t.href);
    const m = /Second-(\d+)/i.exec(req.headers.timeout || '');
    const seconds = Math.min(m ? Number(m[1]) : 3600, 86400);

    let lock;
    let status = 200;
    if (!body.trim()) {
      // Refresh: the If header names the lock to extend.
      const tokens = this.ifTokens(req);
      const found = this.locksCovering(t.href).find((l) => tokens.includes(l.token));
      if (!found) throw new HttpError(412);
      lock = this.locks.get(found.key);
      lock.expires = Date.now() + seconds * 1000;
    } else {
      const scope = /<(\w+:)?shared\b/.test(body) ? 'shared' : 'exclusive';
      const depth = req.headers.depth === '0' ? '0' : 'infinity';
      const ownerMatch = /<(?:\w+:)?owner[^>]*>([\s\S]*?)<\/(?:\w+:)?owner>/.exec(body);
      const conflicts = this.locksCovering(t.href);
      if (depth === 'infinity') {
        for (const [k, l] of this.activeLocks()) if (k.startsWith(key + '/')) conflicts.push(l);
      }
      if (conflicts.some((l) => l.scope === 'exclusive' || scope === 'exclusive')) throw new HttpError(423);
      if (!t.exists) {
        // RFC 4918: locking an unmapped URL creates an empty file.
        if (t.device === null || JUNK_DIR.has(path.basename(t.device))) throw new HttpError(409);
        await this.requireParent(t);
        if (JUNK_FILE(path.basename(t.device))) this.junk.set(t.device, { data: Buffer.alloc(0), mtime: Date.now() });
        else await this.fsys.writeFrom(require('stream').Readable.from([]), t.device);
        this.invalidate(t.device);
        status = 201;
      }
      lock = {
        token: `opaquelocktoken:${crypto.randomUUID()}`,
        scope,
        depth,
        owner: ownerMatch ? ownerMatch[1] : '',
        expires: Date.now() + seconds * 1000,
      };
      // Shared locks on one URL are kept under distinct keys.
      this.locks.set(this.locks.has(key) ? `${key}\u0000${lock.token}` : key, lock);
    }
    const xml = `<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery>${this.lockXml(lock, t.href)}</D:lockdiscovery></D:prop>`;
    res.writeHead(status, { 'Content-Type': 'application/xml; charset=utf-8', 'Lock-Token': `<${lock.token}>`, 'Content-Length': Buffer.byteLength(xml) });
    res.end(xml);
  }

  async unlock(req, res) {
    const t = await this.resolve(req.url);
    const token = /<([^>]+)>/.exec(req.headers['lock-token'] || '');
    if (!token) throw new HttpError(400);
    const hit = this.locksCovering(t.href).find((l) => l.token === token[1]);
    if (!hit) throw new HttpError(409);
    this.locks.delete(hit.key);
    res.writeHead(204);
    res.end();
  }
}

module.exports = { DavServer, JUNK_FILE };
