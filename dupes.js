const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const MIN = 1 << 20; // same cut-off as the scanner: smaller files are noise

async function* files(p) {
  let entries;
  try { entries = await fsp.readdir(p, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(p, e.name);
    if (e.isDirectory()) yield* files(full);
    else try { const size = (await fsp.lstat(full)).size; if (size >= MIN) yield { path: full, size }; } catch {}
  }
}

const hash = (p, len) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(p, len ? { start: 0, end: len - 1 } : undefined)
    .on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

async function group(paths, key) {
  const m = new Map();
  for (const p of paths) {
    try { const k = await key(p); (m.get(k) || m.set(k, []).get(k)).push(p); } catch {} // unreadable file: leave it out
  }
  return [...m.values()].filter((g) => g.length > 1);
}

// Yields { size, paths } for each set of byte-identical files, biggest first. Same size -> same first 64 KB -> same full hash.
async function* findDupes(base) {
  const bySize = new Map();
  for await (const f of files(base)) (bySize.get(f.size) || bySize.set(f.size, []).get(f.size)).push(f.path);
  const sizes = [...bySize].filter(([, ps]) => ps.length > 1).sort((a, b) => b[0] - a[0]);
  for (const [size, ps] of sizes) {
    for (const sameHead of await group(ps, (p) => hash(p, 65536))) {
      for (const paths of await group(sameHead, (p) => hash(p))) yield { size, paths };
    }
  }
}

module.exports = { findDupes };
