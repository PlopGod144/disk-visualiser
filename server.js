const crypto = require('crypto');
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const MAX_DEPTH = 6; // levels sent to the UI; folders below this are summed into one size
const SMALL = 1 << 20; // files under 1 MiB are merged per folder to keep the tree light

async function total(p) {
  let entries;
  try { entries = await fs.readdir(p, { withFileTypes: true }); } catch { return 0; } // EPERM etc: count as empty
  const sizes = await Promise.all(entries.map(async (e) => {
    if (e.isSymbolicLink()) return 0; // avoids loops and double counting
    const full = path.join(p, e.name);
    if (e.isDirectory()) return total(full);
    try { return (await fs.lstat(full)).size; } catch { return 0; }
  }));
  return sizes.reduce((a, b) => a + b, 0);
}

// Yields one event per folder as it is read: { path, files, dirs } or { path, size } for folders past MAX_DEPTH.
async function* walk(p, rel = []) {
  let entries;
  try { entries = await fs.readdir(p, { withFileTypes: true }); } catch { return; }
  const dirs = [];
  const files = (await Promise.all(entries.map(async (e) => {
    if (e.isSymbolicLink()) return null;
    if (e.isDirectory()) { dirs.push(e.name); return null; }
    try { const st = await fs.lstat(path.join(p, e.name)); return { name: e.name, size: st.size, m: st.mtimeMs }; } catch { return null; }
  }))).filter((f) => f && f.size > 0);
  const big = files.filter((f) => f.size >= SMALL);
  const small = files.filter((f) => f.size < SMALL);
  if (small.length) big.push({ name: '(small files)', size: small.reduce((s, f) => s + f.size, 0), m: Math.max(...small.map((f) => f.m)) });
  yield { path: rel, files: big, dirs };
  for (const d of dirs) {
    const sub = [...rel, d];
    if (sub.length >= MAX_DEPTH) yield { path: sub, size: await total(path.join(p, d)) };
    else yield* walk(path.join(p, d), sub);
  }
}

// Resolves p only if it is a real (non-symlink) entry strictly inside one of the scanned bases; else throws.
async function safe(p, bases) {
  const abs = path.resolve(p);
  if ((await fs.lstat(abs)).isSymbolicLink()) throw new Error('refusing symlink');
  const real = await fs.realpath(abs); // also resolves junctions in the middle of the path
  for (const b of bases) {
    let realBase;
    try { realBase = await fs.realpath(b); } catch { continue; } // a scanned folder that was since deleted must not block the others
    const rel = path.relative(realBase, real);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return abs;
  }
  throw new Error('path is outside the scanned folder');
}

module.exports = { walk, safe };

if (require.main === module) {
  const { execFile } = require('child_process');
  const { findDupes } = require('./dupes');
  const scanned = new Set(); // folders the user scanned: the only places actions may touch
  const pub = path.join(__dirname, 'public');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const host = process.env.HOST || '127.0.0.1'; // opt-in: HOST=0.0.0.0 exposes it on your network
  const token = host === '127.0.0.1' ? null : crypto.randomBytes(16).toString('hex');
  const authed = (given) => given && given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
  http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      // DNS-rebinding guard: without the token, only accept our own host names
      if (!token && !/^(localhost|127\.0\.0\.1):3000$/.test(req.headers.host || '')) { res.statusCode = 403; return res.end('bad host'); }
      if (token) {
        const given = url.searchParams.get('key') || (req.headers.cookie || '').match(/(?:^|; )key=([^;]*)/)?.[1];
        if (!authed(given)) { res.statusCode = 401; return res.end('Open the link printed by the server; it includes ?key=...'); }
        if (url.searchParams.has('key')) { // swap the key in the URL for a cookie so it stays out of history
          res.writeHead(302, { 'set-cookie': `key=${token}; HttpOnly; SameSite=Strict; Path=/`, location: '/' });
          return res.end();
        }
      }
      if (url.pathname === '/scan') {
        const p = path.resolve(url.searchParams.get('path') || os.homedir());
        if (!(await fs.stat(p)).isDirectory()) throw new Error('not a directory');
        let closed = false;
        res.on('close', () => (closed = true)); // stop walking when the client cancels or leaves
        res.setHeader('content-type', 'application/x-ndjson');
        scanned.add(p);
        res.write(JSON.stringify({ root: path.basename(p) || p, base: p }) + '\n');
        for await (const ev of walk(p)) {
          if (closed) break;
          res.write(JSON.stringify(ev) + '\n');
        }
        return res.end();
      }
      if (url.pathname === '/dupes') {
        const p = path.resolve(url.searchParams.get('path') || '');
        if (!scanned.has(p)) throw new Error('scan this folder first');
        let closed = false;
        res.on('close', () => (closed = true));
        res.setHeader('content-type', 'application/x-ndjson');
        for await (const g of findDupes(p)) {
          if (closed) break;
          res.write(JSON.stringify(g) + '\n');
        }
        return res.end();
      }
      if (req.method === 'POST' && (url.pathname === '/reveal' || url.pathname === '/trash')) {
        const origin = req.headers.origin;
        if ((origin && new URL(origin).host !== req.headers.host) || !/^application\/json/.test(req.headers['content-type'] || '')) {
          res.statusCode = 403; return res.end('cross-site request refused'); // a plain cross-site form can't send JSON
        }
        let body = '';
        for await (const c of req) { body += c; if (body.length > 8192) throw new Error('body too large'); }
        const target = await safe(JSON.parse(body).path, scanned);
        if (url.pathname === '/reveal') execFile('explorer.exe', [`/select,${target}`], () => {}); // explorer exits 1 even on success
        else await new Promise((ok, no) => execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'trash.ps1'), target], (err, _o, stderr) => (err ? no(new Error(stderr || err.message)) : ok())));
        res.setHeader('content-type', 'application/json');
        return res.end('{"ok":true}');
      }
      const file = path.join(pub, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
      if (!file.startsWith(pub)) throw new Error('bad path');
      res.setHeader('content-type', types[path.extname(file)] || 'text/plain');
      res.end(await fs.readFile(file));
    } catch (err) {
      if (res.headersSent) return res.end();
      res.statusCode = 404;
      res.end(String(err.message));
    }
  }).on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? 'Port 3000 is already in use. The visualiser may already be running at http://localhost:3000; stop that copy first.' : e.message);
    process.exit(1);
  }).listen(3000, host, () => {
    if (!token) return console.log('http://localhost:3000'); // localhost only by default: it can read any folder
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal);
    ips.forEach((i) => console.log(`http://${i.address}:3000/?key=${token}`));
  });
}
