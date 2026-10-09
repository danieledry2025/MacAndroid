#!/usr/bin/env node
'use strict';

// Downloads Google's official Android platform-tools (adb) into vendor/platform-tools,
// so the packaged app works without the user installing anything.
// Usage: node scripts/fetch-adb.js [darwin|linux|windows] [--force]

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const platformArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const platform = platformArg || { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform];
const force = process.argv.includes('--force');
const vendor = path.join(__dirname, '..', 'vendor');
const target = path.join(vendor, 'platform-tools');
const exe = platform === 'windows' ? 'adb.exe' : 'adb';
const url = `https://dl.google.com/android/repository/platform-tools-latest-${platform}.zip`;

if (!force && fs.existsSync(path.join(target, exe))) {
  console.log(`adb already present at ${target} (use --force to re-download)`);
  process.exit(0);
}

function download(from, to, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(from, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(download(res.headers.location, to, redirects - 1));
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${from}`));
        const out = fs.createWriteStream(to);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      })
      .on('error', reject);
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'macandroid-adb-'));
  const zip = path.join(tmp, 'platform-tools.zip');
  console.log(`Downloading ${url}`);
  await download(url, zip);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(vendor, { recursive: true });
  execFileSync('unzip', ['-q', '-o', zip, '-d', vendor], { stdio: 'inherit' });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (platform !== 'windows') fs.chmodSync(path.join(target, exe), 0o755);
  console.log(`adb ready at ${path.join(target, exe)}`);
})().catch((err) => {
  console.error('Failed to fetch adb:', err.message);
  process.exit(1);
});
