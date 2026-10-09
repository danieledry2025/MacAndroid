'use strict';

const path = require('path').posix;
const { EventEmitter } = require('events');
const { uniqueName } = require('./util');

let nextId = 1;

/**
 * Copy queue. Jobs run one at a time (USB is the bottleneck, parallel copies only slow each other down).
 *
 * A job copies `items` (paths on `src`) into the folder `dstDir` on `dst`. `src`/`dst` are LocalFs or
 * DeviceFs instances, so the same code handles phone -> Mac, Mac -> phone, and within one side.
 */
class TransferQueue extends EventEmitter {
  constructor({ askConflict }) {
    super();
    this.askConflict = askConflict; // async ({ jobId, name, isDir }) => { action: 'replace'|'skip'|'keep', all: bool }
    this.jobs = [];
    this.running = null;
  }

  add({ src, dst, items, dstDir, meta }) {
    const job = {
      id: nextId++,
      src,
      dst,
      items,
      dstDir,
      meta: meta || {},
      state: 'queued',
      totalBytes: 0,
      doneBytes: 0,
      filesTotal: 0,
      filesDone: 0,
      current: '',
      speed: 0,
      error: null,
      cancelled: false,
      activeStreams: new Set(),
    };
    this.jobs.push(job);
    this.emitJob(job, true);
    this.pump();
    return job.id;
  }

  cancel(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || job.state === 'done' || job.state === 'error') return;
    job.cancelled = true;
    for (const s of job.activeStreams) {
      try {
        if (typeof s.cancel === 'function') s.cancel();
        s.destroy(new Error('cancelled'));
      } catch {}
    }
    if (job.state === 'queued') {
      job.state = 'cancelled';
      this.emitJob(job, true);
    }
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => ['queued', 'scanning', 'running'].includes(j.state));
  }

  snapshot(job) {
    const { src, dst, activeStreams, ...rest } = job;
    return rest;
  }

  emitJob(job, force = false) {
    const now = Date.now();
    if (!force && job._lastEmit && now - job._lastEmit < 120) return;
    job._lastEmit = now;
    this.emit('update', this.snapshot(job));
  }

  async pump() {
    if (this.running) return;
    const job = this.jobs.find((j) => j.state === 'queued');
    if (!job) return;
    this.running = job;
    try {
      await this.run(job);
      job.state = job.cancelled ? 'cancelled' : 'done';
    } catch (err) {
      job.state = job.cancelled ? 'cancelled' : 'error';
      job.error = job.cancelled ? null : String((err && err.message) || err);
    }
    job.current = '';
    this.emitJob(job, true);
    this.running = null;
    this.emit('finished', this.snapshot(job));
    this.pump();
  }

  /** Resolve name collisions for one top-level item. Returns the target path, or null to skip. */
  async resolveTarget(job, name, isDir, policy) {
    const target = path.join(job.dstDir, name);
    if (!(await job.dst.exists(target))) return { target, replace: false };
    let decision = policy.all;
    if (!decision) {
      decision = await this.askConflict({ jobId: job.id, name, isDir });
      if (decision.all) policy.all = decision;
    }
    if (decision.action === 'skip') return null;
    if (decision.action === 'keep') {
      const free = await uniqueName(name, (n) => job.dst.exists(path.join(job.dstDir, n)));
      return { target: path.join(job.dstDir, free), replace: false };
    }
    return { target, replace: true };
  }

  async scan(fsys, p, rel, out) {
    const st = await fsys.stat(p);
    if (!st.isDir) {
      out.files.push({ src: p, rel, size: st.size });
      out.bytes += st.size;
      return;
    }
    out.dirs.push(rel);
    for (const e of await fsys.readdir(p)) {
      if (e.isDir) await this.scan(fsys, e.path, path.join(rel, e.name), out);
      else {
        out.files.push({ src: e.path, rel: path.join(rel, e.name), size: e.size });
        out.bytes += e.size;
      }
    }
  }

  async run(job) {
    job.state = 'scanning';
    this.emitJob(job, true);

    const policy = {};
    const plan = [];
    for (const item of job.items) {
      if (job.cancelled) return;
      const name = path.basename(item);
      const out = { files: [], dirs: [], bytes: 0 };
      await this.scan(job.src, item, '', out);
      const isDir = out.dirs.length > 0;
      if (job.src === job.dst && (job.dstDir === item || job.dstDir.startsWith(item + '/'))) {
        throw new Error('לא ניתן להעתיק תיקייה לתוך עצמה');
      }
      const resolved = await this.resolveTarget(job, name, isDir, policy);
      if (!resolved) continue;
      plan.push({ item, isDir, out, ...resolved });
      job.totalBytes += out.bytes;
      job.filesTotal += out.files.length;
    }

    job.state = 'running';
    job.startedAt = Date.now();
    this.emitJob(job, true);

    for (const p of plan) {
      if (job.cancelled) return;
      if (p.replace && !p.isDir) await job.dst.remove(p.target);

      // Fast path: copying within the same phone (or within the Mac) needs no streaming through us.
      if (job.src === job.dst && typeof job.src.copyWithin === 'function') {
        job.current = path.basename(p.item);
        this.emitJob(job, true);
        if (p.replace) await job.dst.remove(p.target);
        await job.src.copyWithin(p.item, p.target);
        job.doneBytes += p.out.bytes;
        job.filesDone += p.out.files.length;
        continue;
      }

      if (p.isDir) {
        for (const d of p.out.dirs) await job.dst.mkdir(d ? path.join(p.target, d) : p.target);
        for (const f of p.out.files) {
          if (job.cancelled) return;
          await this.copyFile(job, f.src, path.join(p.target, f.rel), f.size);
        }
      } else {
        const f = p.out.files[0];
        await this.copyFile(job, f.src, p.target, f.size);
      }
    }
  }

  async copyFile(job, srcPath, dstPath, size) {
    job.current = path.basename(srcPath);
    this.emitJob(job, true);
    const readable = await job.src.openRead(srcPath);
    job.activeStreams.add(readable);
    const startBytes = job.doneBytes;
    readable.on('data', (chunk) => {
      job.doneBytes += chunk.length;
      const secs = (Date.now() - job.startedAt) / 1000;
      job.speed = secs > 0.3 ? job.doneBytes / secs : 0;
      this.emitJob(job);
    });
    try {
      await job.dst.writeFrom(readable, dstPath);
    } catch (err) {
      // Leave no half-written files behind.
      await job.dst.remove(dstPath).catch(() => {});
      throw err;
    } finally {
      job.activeStreams.delete(readable);
    }
    if (job.cancelled) {
      await job.dst.remove(dstPath).catch(() => {});
      return;
    }
    // Keep totals honest even if the file changed size while we copied it.
    job.doneBytes = startBytes + size;
    job.filesDone += 1;
    this.emitJob(job);
  }
}

module.exports = { TransferQueue };
