const $ = (s) => document.querySelector(s);
const fmt = (n) => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${u[i]}`; };
const groups = {
  Media: 'jpg jpeg png gif webp svg mp4 mkv mov avi mp3 wav flac heic',
  Documents: 'pdf doc docx xls xlsx ppt pptx txt md csv',
  Code: 'js ts py java c cpp cs go rs html css json xml sh ps1',
  Archives: 'zip rar 7z tar gz iso img vhd vhdx',
};
const extGroup = {};
for (const [g, exts] of Object.entries(groups)) exts.split(' ').forEach((e) => (extGroup[e] = g));
const palette = { Media: '#f59e0b', Documents: '#38bdf8', Code: '#a78bfa', Archives: '#f472b6', Other: '#9ca3af' };
const greens = ['#15803d', '#16a34a', '#22c55e', '#4ade80', '#86efac', '#bbf7d0']; // folders: lighter the deeper they sit
const fileKind = (name) => extGroup[name.split('.').pop().toLowerCase()] || 'Other';
const isDir = (d) => d.data.children; // set by the stream, even for folders still being filled
const sumSize = (d) => (d.children && d.children.length ? 0 : d.size || 0);
const DAY = 864e5;
const ageRamp = d3.scaleLinear().domain([0, 1]).range(['#22c55e', '#92400e']).interpolate(d3.interpolateRgb);
const age = new WeakMap(); // newest modified time under each node, filled in draw() when colouring by age
const HOGS = new Map([
  ['node_modules', 'reinstall with npm install'], ['.cache', 'caches rebuild themselves'], ['cache', 'caches rebuild themselves'],
  ['temp', 'temporary files'], ['tmp', 'temporary files'], ['__pycache__', 'Python bytecode'], ['.gradle', 'build cache'], ['.npm', 'npm cache'],
]);

let root, base = '', nodes = new Map(), view = 'sunburst', colorBy = 'type', tab = 'top', focusPath = [], scanning = false, ctl, dupeCtl;
let dupeGroups = [], dupeFilter = null, menuTarget = null;
const filter = { q: '', min: 0, types: new Set() };
const later = (fn, ms) => { let t; return () => { t ||= setTimeout(() => { t = null; fn(); }, ms); }; }; // throttle

const color = (d) => {
  if (colorBy === 'age') { const m = age.get(d.data); return m ? ageRamp(Math.min((Date.now() - m) / (730 * DAY), 1)) : '#9ca3af'; }
  return isDir(d) ? greens[Math.min(d.depth - 1, 5)] : palette[fileKind(d.data.name)];
};
const filterOn = () => filter.q || filter.min || filter.types.size;
const matches = (d) => (!filter.q || d.data.name.toLowerCase().includes(filter.q)) && d.value >= filter.min && (!filter.types.size || (!isDir(d) && filter.types.has(fileKind(d.data.name))));

function legend() {
  $('#legend').innerHTML = colorBy === 'age'
    ? '<span>Recent</span><i style="width:90px;background:linear-gradient(90deg,#22c55e,#92400e)"></i><span>2+ years old</span>'
    : [['Folder', greens[1]], ...Object.entries(palette)].map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join('');
}
legend();
$('#chips').replaceChildren(...Object.keys(palette).map((k) => {
  const b = Object.assign(document.createElement('button'), { textContent: k });
  b.setAttribute('aria-pressed', false);
  b.onclick = () => { filter.types.has(k) ? filter.types.delete(k) : filter.types.add(k); b.setAttribute('aria-pressed', filter.types.has(k)); draw(); };
  return b;
}));

// ---- paths: tree names <-> absolute Windows paths (the server re-checks every path it is given)
const stripBase = () => base.replace(/[\\/]+$/, '');
const absPath = (names) => (names.length ? stripBase() + '\\' + names.join('\\') : base);
const relNames = (abs) => abs.slice(stripBase().length + 1).split('\\').filter(Boolean);
const namesOf = (d, prefix = []) => prefix.concat(d.ancestors().reverse().slice(1).map((n) => n.data.name));
const dirOf = (abs) => { const r = relNames(abs).slice(0, -1).join('\\'); return r; };

// ---- streaming
async function stream(url, onEvent, signal) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(await r.text());
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    lines.forEach((l) => onEvent(JSON.parse(l)));
  }
}

function addEvent(ev) {
  if (ev.root !== undefined) { root = { name: ev.root, children: [] }; base = ev.base; nodes = new Map([['', root]]); return; }
  const key = ev.path.join('\0'), node = nodes.get(key);
  if (!node) return;
  if (ev.size !== undefined) { node.size = ev.size; return; } // folder past the depth cap: size only
  node.children = ev.files.concat(ev.dirs.map((name) => ({ name, children: [] })));
  node.children.forEach((c) => c.children && nodes.set(ev.path.concat(c.name).join('\0'), c));
}

const redrawSoon = later(() => draw(), 300); // redraw in bursts, not per event

async function load(p) {
  ctl?.abort();
  dupeCtl?.abort();
  ctl = new AbortController();
  focusPath = []; root = null; dupeGroups = []; dupeFilter = null; scanning = true;
  $('#chart').innerHTML = '<p id="msg">Scanning…</p>';
  ['#top', '#found', '#clean', '#dupes', '#crumbs'].forEach((s) => $(s).replaceChildren());
  $('#dupeStatus').textContent = 'Compares files of 1 MB or more by content.';
  try {
    await stream('/scan?path=' + encodeURIComponent(p), (ev) => { addEvent(ev); root && redrawSoon(); }, ctl.signal);
    scanning = false;
    draw();
  } catch (e) {
    if (e.name === 'AbortError') return;
    scanning = false;
    $('#chart').innerHTML = `<p id="msg">Couldn't scan that: ${e.message}</p>`;
  }
}

// ---- actions
const toast = (msg) => {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 4000);
};
const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
};
const reveal = (abs) => post('/reveal', { path: abs }).catch((e) => toast(e.message));
const confirmTrash = (abs, size) => new Promise((res) => {
  const dlg = $('#dlg');
  $('#dlgText').textContent = `Move to the Recycle Bin?\n\n${abs}\n${fmt(size)}`;
  dlg.returnValue = '';
  dlg.onclose = () => res(dlg.returnValue === 'yes');
  dlg.showModal();
});
function removeNode(names) {
  let n = root;
  for (const x of names.slice(0, -1)) { n = (n.children || []).find((c) => c.name === x); if (!n) return; }
  n.children = (n.children || []).filter((c) => c.name !== names.at(-1));
}
async function trashIt(abs, size) {
  if (!(await confirmTrash(abs, size))) return;
  try {
    await post('/trash', { path: abs });
    removeNode(relNames(abs)); // update in place, no rescan
    dupeGroups = dupeGroups.map((g) => ({ ...g, paths: g.paths.filter((p) => p !== abs && !p.startsWith(abs + '\\')) })).filter((g) => g.paths.length > 1);
    toast(`Moved to Recycle Bin (${fmt(size)})`);
    draw();
  } catch (e) { toast(e.message); }
}

// ---- drawing
function tip(ev, d, focusValue) {
  const t = $('#tip');
  t.hidden = !d;
  if (!d) return;
  t.textContent = `${d.data.name} · ${fmt(d.value)} · ${focusValue ? ((d.value / focusValue) * 100).toFixed(1) : 0}%`;
  t.style.left = Math.min(ev.clientX + 12, innerWidth - t.offsetWidth - 8) + 'px';
  t.style.top = Math.min(ev.clientY + 12, innerHeight - t.offsetHeight - 8) + 'px';
}

function suggestions(n, inDownloads = false, out = []) {
  const name = n.data.name.toLowerCase();
  if (n.data.children && HOGS.has(name)) { if (n.value) out.push({ n, why: HOGS.get(name) }); return out; }
  if (!n.data.children && inDownloads && /\.(exe|msi|iso)$/.test(name) && Date.now() - n.data.m > 90 * DAY) out.push({ n, why: 'old installer' });
  (n.children || []).forEach((c) => suggestions(c, inDownloads || name === 'downloads', out));
  return out;
}

function rowFor(c, nm, path, dim, why) {
  const li = Object.assign(document.createElement('li'), { innerHTML: '<span></span><span></span><span class="acts"><button>Reveal</button><button>Trash</button></span>' });
  const [label, size, acts] = li.children, abs = absPath(nm);
  label.textContent = why ? `${c.data.name} · ${why}` : c.data.name;
  label.title = abs;
  size.textContent = fmt(c.value);
  if (c.data.name === '(small files)') acts.remove(); // virtual bucket, nothing real to act on
  else {
    acts.children[0].onclick = (e) => { e.stopPropagation(); reveal(abs); };
    acts.children[1].onclick = (e) => { e.stopPropagation(); trashIt(abs, c.value); };
  }
  li.onmouseenter = () => path.attr('opacity', (d) => (d.ancestors().some((a) => a.data === c.data) ? 1 : 0.25));
  li.onmouseleave = () => path.attr('opacity', dim);
  li.onclick = () => { focusPath = c.children ? nm : nm.slice(0, -1); draw(); };
  return li;
}

function renderDupes() {
  const rel = (p) => relNames(p).join('\\');
  const shown = dupeFilter ? dupeGroups.filter((g) => dupeFilter.every((f) => g.paths.some((p) => dirOf(p) === f))) : dupeGroups;
  const wasted = dupeGroups.reduce((s, g) => s + g.size * (g.paths.length - 1), 0);
  $('#dupeStatus').textContent = dupeGroups.length ? `${dupeGroups.length} groups · ${fmt(wasted)} wasted${dupeFilter ? ' · filtered by link' : ''}` : $('#dupeStatus').textContent;
  $('#dupes').replaceChildren(...shown.slice(0, 100).map((g) => {
    const li = Object.assign(document.createElement('li'), { className: 'grp' });
    li.append(Object.assign(document.createElement('strong'), { textContent: `${fmt(g.size)} × ${g.paths.length} · wastes ${fmt(g.size * (g.paths.length - 1))}` }));
    g.paths.forEach((p) => {
      const d = Object.assign(document.createElement('div'), { className: 'p', innerHTML: '<span></span><span class="acts"><button>Reveal</button><button>Trash</button></span>' });
      d.children[0].textContent = rel(p);
      d.children[0].title = p;
      d.querySelectorAll('button')[0].onclick = () => reveal(p);
      d.querySelectorAll('button')[1].onclick = () => trashIt(p, g.size);
      li.append(d);
    });
    return li;
  }));
}
const dupesSoon = later(() => { renderDupes(); if (view === 'graph') draw(); }, 500);

function draw() {
  if (!root) return;
  const full = d3.hierarchy(root).sum(sumSize).sort((a, b) => b.value - a.value);
  if (colorBy === 'age') full.eachAfter((n) => age.set(n.data, n.children ? d3.max(n.children, (c) => age.get(c.data)) : n.data.m));
  let focus = full;
  for (const n of focusPath) focus = (focus.children || []).find((c) => c.data.name === n) || focus;
  const sub = focus.copy().sum(sumSize).sort((a, b) => b.value - a.value);
  const chart = $('#chart'), w = chart.clientWidth, h = chart.clientHeight;
  const dim = (d) => (filterOn() ? (matches(d) ? 1 : 0.2) : null);
  const zoom = (d) => { if (d.data.children && d.data.children.length) { focusPath = namesOf(d, focusPath); draw(); } };
  let path = d3.selectAll([]);

  if (view === 'graph') {
    chart.replaceChildren(drawGraph(chart, dupeGroups, dirOf, dupeFilter, (sel) => { dupeFilter = sel && dupeFilter && sel.join() === dupeFilter.join() ? null : sel; renderDupes(); draw(); }));
  } else {
    const svg = d3.create('svg').attr('viewBox', `0 0 ${w} ${h}`);
    if (view === 'sunburst') {
      const R = Math.min(w, h) / 2 - 6, levels = Math.min(sub.height, 5);
      d3.partition().size([2 * Math.PI, sub.height + 1])(sub);
      const r = R / (levels + 1);
      const arc = d3.arc().startAngle((d) => d.x0).endAngle((d) => d.x1).padAngle(0.01).innerRadius((d) => d.y0 * r).outerRadius((d) => Math.max(d.y0 * r, d.y1 * r - 2));
      const g = svg.append('g').attr('transform', `translate(${w / 2},${h / 2})`);
      path = g.selectAll('path').data(sub.descendants().filter((d) => d.depth > 0 && d.depth <= 5 && d.x1 - d.x0 > 0.004)).join('path').attr('d', arc);
      g.append('circle').attr('r', r - 4).attr('fill', 'transparent').attr('class', 'node').on('click', up);
      g.append('text').attr('text-anchor', 'middle').attr('fill', 'currentColor').attr('dy', '-0.2em').attr('font-size', Math.min(20, r / 3)).text(fmt(sub.value));
      g.append('text').attr('text-anchor', 'middle').attr('fill', 'currentColor').attr('opacity', 0.6).attr('dy', '1.2em').attr('font-size', Math.min(13, r / 4)).text(sub.data.name.slice(0, Math.max(12, Math.floor(r / 6))));
    } else {
      d3.treemap().size([w, h]).paddingInner(2).paddingTop((d) => (d.depth === 1 ? 18 : 0)).round(true)(sub);
      const ns = sub.descendants().filter((d) => d.depth > 0 && d.depth <= 2);
      const g = svg.append('g');
      path = g.selectAll('rect').data(ns).join('rect').attr('x', (d) => d.x0).attr('y', (d) => d.y0).attr('width', (d) => d.x1 - d.x0).attr('height', (d) => d.y1 - d.y0);
      g.selectAll('text').data(ns.filter((d) => d.x1 - d.x0 > 60 && d.y1 - d.y0 > 18)).join('text').attr('x', (d) => d.x0 + 4).attr('y', (d) => d.y0 + 13).attr('font-size', 11).attr('fill', '#fff')
        .attr('stroke', '#0007').attr('stroke-width', 2).attr('paint-order', 'stroke').attr('pointer-events', 'none').text((d) => d.data.name.slice(0, (d.x1 - d.x0) / 7)); // outline keeps labels readable on any fill
    }
    path.attr('class', 'node').attr('fill', color).attr('fill-opacity', (d) => (view === 'treemap' && d.depth === 2 ? 0.8 : 1)).attr('opacity', dim)
      .on('click', (_, d) => zoom(d))
      .on('contextmenu', (ev, d) => { // shortcut: right-click only, no long-press for touch
        if (d.data.name === '(small files)') return;
        ev.preventDefault();
        menuTarget = { abs: absPath(namesOf(d, focusPath)), size: d.value };
        Object.assign($('#menu').style, { left: Math.min(ev.clientX, innerWidth - 220) + 'px', top: Math.min(ev.clientY, innerHeight - 90) + 'px' });
        $('#menu').hidden = false;
      })
      .on('mousemove', (ev, d) => tip(ev, d, sub.value)).on('mouseleave', () => tip(null, null))
      .append('title').text((d) => `${d.data.name} — ${fmt(d.value)}`); // title also serves as a screen-reader fallback
    chart.replaceChildren(svg.node());
  }

  $('#status').textContent = (scanning ? 'Scanning… ' : '') + fmt(full.value);
  $('#crumbs').replaceChildren(...[[], ...focusPath.map((_, i) => focusPath.slice(0, i + 1))].flatMap((p, i) => {
    const b = Object.assign(document.createElement('button'), { textContent: i ? p[p.length - 1] : root.name });
    b.onclick = () => { focusPath = p; draw(); };
    return i ? [' / ', b] : [b];
  }));

  if (tab === 'top') $('#top').replaceChildren(...(sub.children || []).slice(0, 10).map((c) => rowFor(c, namesOf(c, focusPath), path, dim)));
  if (tab === 'search') $('#found').replaceChildren(...(filterOn() ? full.descendants().filter((n) => n.parent && matches(n)).sort((a, b) => b.value - a.value).slice(0, 50) : []).map((n) => rowFor(n, namesOf(n), path, dim)));
  if (tab === 'clean') {
    const sug = suggestions(full).sort((a, b) => b.n.value - a.n.value);
    $('#cleanTotal').textContent = sug.length ? `${fmt(sug.reduce((s, x) => s + x.n.value, 0))} could be reclaimed. These are hints; review each one.` : 'Nothing obvious to clean in this scan.';
    $('#clean').replaceChildren(...sug.slice(0, 50).map((s) => rowFor(s.n, namesOf(s.n), path, dim, s.why)));
  }
  if (tab === 'dupes') renderDupes();
}

function up() { if (focusPath.length) { focusPath = focusPath.slice(0, -1); draw(); } }

// ---- wiring
const pressed = (sel, el) => document.querySelectorAll(sel).forEach((x) => x.setAttribute('aria-pressed', x === el));
$('#f').onsubmit = (e) => { e.preventDefault(); load($('#path').value.trim()); };
document.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => { view = b.dataset.v; pressed('[data-v]', b); draw(); }));
document.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => { colorBy = b.dataset.c; pressed('[data-c]', b); legend(); draw(); }));
document.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => {
  tab = b.dataset.t; pressed('[data-t]', b);
  ['top', 'search', 'clean', 'dupes'].forEach((t) => ($(`#p-${t}`).hidden = t !== tab));
  draw();
}));
const searchSoon = later(() => draw(), 150);
$('#q').oninput = (e) => { filter.q = e.target.value.trim().toLowerCase(); searchSoon(); };
$('#minsize').onchange = (e) => { filter.min = +e.target.value; draw(); };
$('#findDupes').onclick = async () => {
  if (!base) return toast('Scan a folder first');
  dupeCtl?.abort();
  dupeCtl = new AbortController();
  dupeGroups = []; dupeFilter = null;
  $('#dupeStatus').textContent = 'Comparing files…';
  try {
    await stream('/dupes?path=' + encodeURIComponent(base), (g) => { dupeGroups.push(g); dupesSoon(); }, dupeCtl.signal);
    $('#dupeStatus').textContent = dupeGroups.length ? '' : 'No duplicates found.';
    renderDupes();
    if (view === 'graph') draw();
  } catch (e) { if (e.name !== 'AbortError') toast(e.message); }
};
$('#menu').onclick = (e) => { const a = e.target.dataset.a; if (a === 'reveal') reveal(menuTarget.abs); if (a === 'trash') trashIt(menuTarget.abs, menuTarget.size); };
addEventListener('click', () => ($('#menu').hidden = true));
addEventListener('keydown', (e) => e.key === 'Escape' && ($('#menu').hidden = true));
addEventListener('resize', () => draw());

// /?path=C:\some\folder scans on open, so a scan can be bookmarked
const start = new URLSearchParams(location.search).get('path');
if (start !== null) { $('#path').value = start; load(start); }
