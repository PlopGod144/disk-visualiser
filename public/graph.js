// Folders that hold duplicates are nodes; an edge is the bytes of identical files two folders share.
let sim;

function drawGraph(chart, groups, dirOf, selected, onPick) {
  sim?.stop();
  const weight = new Map(), pairs = new Map();
  for (const g of groups) {
    const dirs = [...new Set(g.paths.map(dirOf))];
    dirs.forEach((d) => weight.set(d, (weight.get(d) || 0) + g.size));
    for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) {
      const k = [dirs[i], dirs[j]].sort().join('\0');
      pairs.set(k, (pairs.get(k) || 0) + g.size);
    }
  }
  // shortcut: top 40 pairs only so the layout stays readable; raise it if you want more of the long tail
  const links = [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => { const [source, target] = k.split('\0'); return { source, target, v }; });
  if (!links.length) return Object.assign(document.createElement('p'), { id: 'msg', textContent: groups.length ? 'Duplicates here all sit in the same folder, so there are no links to draw.' : 'No duplicates yet. Open Duplicates and press Find duplicates.' });

  const w = chart.clientWidth, h = chart.clientHeight;
  const nodes = [...new Set(links.flatMap((l) => [l.source, l.target]))].map((id) => ({ id, v: weight.get(id) }));
  const r = d3.scaleSqrt().domain([0, d3.max(nodes, (n) => n.v)]).range([8, 32]);
  const dist = Math.max(60, Math.min(200, Math.min(w, h) / (Math.sqrt(nodes.length) + 1.5))); // spread to fill the box, tighter when crowded
  const lw = d3.scaleSqrt().domain([0, links[0].v]).range([1.5, 10]);
  const label = (id) => (id.split('\\').pop() || '(root)').slice(0, 18);
  const picked = (l) => selected && selected.includes(l.source.id ?? l.source) && selected.includes(l.target.id ?? l.target);

  const svg = d3.create('svg').attr('viewBox', `0 0 ${w} ${h}`);
  svg.on('click', () => onPick(null));
  const link = svg.append('g').selectAll('line').data(links).join('line').attr('class', 'node')
    .attr('stroke-width', (l) => lw(l.v)).attr('stroke-linecap', 'round')
    .on('click', (ev, l) => { ev.stopPropagation(); onPick([l.source.id, l.target.id]); });
  link.append('title').text((l) => `${l.source.id || '(root)'} ↔ ${l.target.id || '(root)'}: ${fmt(l.v)} in identical files`);
  const node = svg.append('g').selectAll('g').data(nodes).join('g');
  node.append('circle').attr('r', (n) => r(n.v)).attr('fill', '#22c55e').append('title').text((n) => `${n.id || '(root)'}: ${fmt(n.v)} duplicated`);
  node.append('text').attr('text-anchor', 'middle').attr('fill', 'currentColor').attr('font-size', 11).attr('dy', (n) => r(n.v) + 12).text((n) => label(n.id));
  const paint = () => link.attr('stroke', (l) => (picked(l) ? '#f59e0b' : 'currentColor')).attr('stroke-opacity', (l) => (picked(l) ? 1 : 0.3));
  paint();

  sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id((n) => n.id).distance(dist))
    .force('charge', d3.forceManyBody().strength(-400))
    .force('center', d3.forceCenter(w / 2, h / 2))
    .force('collide', d3.forceCollide((n) => r(n.v) + 14))
    .on('tick', () => {
      nodes.forEach((n) => { n.x = Math.max(30, Math.min(w - 30, n.x)); n.y = Math.max(30, Math.min(h - 30, n.y)); }); // keep inside the box
      link.attr('x1', (l) => l.source.x).attr('y1', (l) => l.source.y).attr('x2', (l) => l.target.x).attr('y2', (l) => l.target.y);
      node.attr('transform', (n) => `translate(${n.x},${n.y})`);
      paint(); // re-run: link endpoints become objects after the first tick
    });
  return svg.node();
}
