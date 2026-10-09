'use strict';

const path = require('path');

/** Quote a string for safe use inside an Android (toybox/mksh) shell command. */
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** Join POSIX paths for the device side (always forward slashes). */
function rjoin(...parts) {
  return path.posix.join(...parts);
}

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'dng']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', '3gp', 'mkv', 'webm', 'avi']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac', 'amr']);

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function kindOf(name) {
  const e = extOf(name);
  if (IMAGE_EXT.has(e)) return 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  if (AUDIO_EXT.has(e)) return 'audio';
  if (e === 'pdf') return 'pdf';
  if (e === 'apk') return 'apk';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return 'archive';
  if (['txt', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'json', 'md', 'rtf', 'pages', 'numbers', 'key'].includes(e)) return 'doc';
  return 'file';
}

/**
 * Return a name that does not collide with `exists(name)`, Finder style:
 * "photo.jpg" -> "photo (1).jpg" -> "photo (2).jpg".
 */
async function uniqueName(name, exists) {
  if (!(await exists(name))) return name;
  const e = extOf(name);
  const base = e ? name.slice(0, -(e.length + 1)) : name;
  for (let i = 1; i < 10000; i++) {
    const candidate = e ? `${base} (${i}).${e}` : `${base} (${i})`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error('Could not find a free file name');
}

/** Sort: folders first, then natural (numeric aware) name order. */
function sortEntries(entries) {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
}

/** Parse `df -k` output into { [mountpoint]: { total, used, free } } in bytes. */
function parseDf(text) {
  const out = {};
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(1)) {
    const cols = line.split(/\s+/);
    if (cols.length < 6) continue;
    const [, total, used, free] = cols;
    const mount = cols.slice(5).join(' ');
    if (!/^\d+$/.test(total)) continue;
    out[mount] = { total: Number(total) * 1024, used: Number(used) * 1024, free: Number(free) * 1024 };
  }
  return out;
}

/** Pick SD card / USB OTG volumes out of a listing of /storage. */
function externalVolumes(names) {
  return names.filter((n) => !['emulated', 'self', 'sdcard0', 'sdcard1', 'enc_emulated'].includes(n) && !n.startsWith('.'));
}

module.exports = { shq, rjoin, extOf, kindOf, uniqueName, sortEntries, parseDf, externalVolumes };
