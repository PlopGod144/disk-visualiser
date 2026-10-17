const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { walk, safe } = require('./server');
const { findDupes } = require('./dupes');

const sum = async (p) => {
  let s = 0, events = 0, m = true;
  for await (const ev of walk(p)) { events++; s += ev.size || 0; for (const f of ev.files || []) { s += f.size; m = m && f.m > 0; } }
  return { s, events, m };
};
const MB2 = 2 << 20;

(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'viz-'));
  fs.mkdirSync(path.join(d, 'sub'));
  fs.mkdirSync(path.join(d, 'other'));
  fs.writeFileSync(path.join(d, 'a.txt'), 'x'.repeat(100));
  fs.writeFileSync(path.join(d, 'sub', 'b.txt'), 'x'.repeat(50));
  fs.writeFileSync(path.join(d, 'sub', 'big.bin'), Buffer.alloc(MB2));
  const r = await sum(d);
  assert.strictEqual(r.s, 150 + MB2);
  assert.strictEqual(r.events, 3); // one event per folder: streamed, not one blob
  assert.ok(r.m, 'files carry an mtime');
  assert.strictEqual((await sum(path.join(d, 'missing'))).events, 0); // unreadable path must not throw

  // duplicates: identical pair is found; same size with a different head, and same head with a different tail, are not
  fs.copyFileSync(path.join(d, 'sub', 'big.bin'), path.join(d, 'other', 'copy.bin'));
  fs.writeFileSync(path.join(d, 'other', 'head.bin'), Buffer.alloc(MB2, 1));
  const tail = Buffer.alloc(MB2); tail[MB2 - 1] = 1;
  fs.writeFileSync(path.join(d, 'other', 'tail.bin'), tail);
  const groups = [];
  for await (const g of findDupes(d)) groups.push(g);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].paths.length, 2);
  assert.ok(groups[0].paths.every((p) => /big\.bin|copy\.bin/.test(p)));

  // action guard: only real entries strictly inside a scanned folder
  const ok = (p) => safe(p, new Set([d]));
  await ok(path.join(d, 'sub', 'b.txt'));
  for (const bad of [d, path.join(d, '..'), path.join(d, 'sub', '..', '..', 'x'), path.join(os.tmpdir(), 'nope')]) {
    await assert.rejects(ok(bad), `should reject ${bad}`);
  }
  const evil = d + '-evil'; // sibling that shares the prefix
  fs.mkdirSync(evil);
  await assert.rejects(ok(evil));
  await assert.rejects(safe(path.join(d, 'a.txt'), new Set())); // nothing scanned yet
  await safe(path.join(d, 'a.txt'), new Set([path.join(d, 'gone'), d])); // a deleted base alongside a live one
  fs.rmSync(evil, { recursive: true });
  fs.rmSync(d, { recursive: true });
  console.log('ok');
})();
