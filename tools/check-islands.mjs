// Island self-check.
//
// Builds all 8 landmarks and 12 minor islands twice from the same seed and asserts that the
// voxel data is byte-identical between the two runs. Determinism is the whole contract for
// streaming: a chunk unloaded and rebuilt must come back the same, and a capture run must be
// reproducible. Also prints build time, voxel counts, bounds, height range and per-block
// histograms so a regression in silhouette or material mix is visible in the diff.
//
// Usage: node tools/check-islands.mjs [seed]

import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { TextureLibrary, registerCommonTiles } from '../src/gen/texture.js';
import { buildBlocks } from '../src/gen/blocks.js';
import { Rng, parseSeed } from '../src/core/rng.js';
import { LANDMARKS, buildLandmark, generateMinorIsland, MINOR_ARCHETYPES, REQUIRED_SPAWNS, VOXEL_M } from '../src/gen/islands.js';

const SEED = parseSeed(process.argv[2] || 20260814);
const MINOR_COUNT = 12;

const tex = registerCommonTiles(new TextureLibrary(SEED));
const { reg, B } = buildBlocks(tex);
const nameOf = (id) => (reg.defs[id] ? reg.defs[id].name : '?' + id);

const sha = (u16) => createHash('sha256').update(Buffer.from(u16.buffer, u16.byteOffset, u16.byteLength)).digest('hex');

function histogram(canvas) {
  const counts = new Map();
  const d = canvas.data;
  for (let i = 0; i < d.length; i++) {
    const v = d[i];
    if (v === 0) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function measure(rec) {
  const c = rec.canvas;
  const bb = c.bounds();
  const hist = histogram(c);
  let minY = c.sy, maxY = -1;
  for (let z = 0; z < c.sz; z++) {
    for (let x = 0; x < c.sx; x++) {
      const g = c.gh[z * c.sx + x];
      if (g < 0) continue;
      if (g < minY) minY = g;
      if (g > maxY) maxY = g;
    }
  }
  return {
    voxels: c.count(),
    dims: [c.sx, c.sy, c.sz],
    bounds: bb,
    groundMinM: minY <= c.sy ? (minY - c.seaLevel) * VOXEL_M : 0,
    groundMaxM: maxY >= 0 ? (maxY - c.seaLevel) * VOXEL_M : 0,
    hist,
    hash: sha(c.data),
  };
}

/**
 * Every place a player can stand: a solid voxel with two voxels of air over it. Indexed
 * per (column, y) rather than one height per column, because a fortress has a wall-walk
 * over a road, a tower has floors inside a roof, and a drydock has a floor below a quay —
 * a single-height model would call all of those unreachable when they plainly are not.
 */
function walkLevels(c) {
  const { sx, sy, sz, data } = c;
  const yStride = sx * sz;
  const lv = new Uint8Array(sx * sz * sy);
  let n = 0;
  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      const col = (z * sx + x) * sy;
      let i = (1 * sz + z) * sx + x;
      for (let y = 1; y < sy - 2; y++, i += yStride) {
        if (data[i] === 0) continue;
        if (data[i + yStride] !== 0 || data[i + yStride * 2] !== 0) continue;
        lv[col + y] = 1;
        n++;
      }
    }
  }
  return { lv, n };
}

/** Flood fill the stand-graph from one node, stepping at most one voxel up or down. */
function reachable(c, lv, n, sx0, sz0, y0) {
  const { sx, sy, sz } = c;
  const seen = new Uint8Array(lv.length);
  const queue = new Int32Array(n + 1);
  let head = 0, tail = 0;
  const push = (k) => { if (!seen[k] && lv[k]) { seen[k] = 1; queue[tail++] = k; } };
  const col0 = (sz0 * sx + sx0) * sy;
  for (let dy = -2; dy <= 2; dy++) {
    const y = y0 + dy;
    if (y >= 1 && y < sy - 2) push(col0 + y);
  }
  while (head < tail) {
    const k = queue[head++];
    const y = k % sy;
    const c0 = (k - y) / sy;
    const x = c0 % sx, z = (c0 / sx) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
      const nz = z + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (nx < 0 || nz < 0 || nx >= sx || nz >= sz) continue;
      const nc = (nz * sx + nx) * sy;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 1 || ny >= sy - 2) continue;
        push(nc + ny);
      }
    }
  }
  return seen;
}

function buildAll() {
  const out = [];
  for (const def of LANDMARKS) {
    const t0 = performance.now();
    const rec = buildLandmark(def, { B, seed: SEED });
    out.push({ rec, ms: performance.now() - t0, kind: 'landmark' });
  }
  const minorRng = Rng.fromName(SEED, 'minor-islands');
  for (let i = 0; i < MINOR_COUNT; i++) {
    const tier = 1 + (i % 5);
    const worldPos = [-6000 + i * 1100, ((i * 37) % 9) * 220 - 880];
    const t0 = performance.now();
    const rec = generateMinorIsland(minorRng, worldPos, tier, { B });
    out.push({ rec, ms: performance.now() - t0, kind: 'minor' });
  }
  return out;
}

console.log(`seed ${SEED}  |  tiles ${tex.count}  |  blocks ${reg.defs.length - 1}\n`);

const passA = buildAll();
const passB = buildAll();

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL ' + msg); };

// --- determinism -----------------------------------------------------------
console.log('== determinism ==');
for (let i = 0; i < passA.length; i++) {
  const a = passA[i].rec, b = passB[i].rec;
  const ha = sha(a.canvas.data), hb = sha(b.canvas.data);
  if (a.id !== b.id) fail(`island ${i}: id drift ${a.id} != ${b.id}`);
  if (ha !== hb) fail(`${a.id}: voxel data differs between builds`);
  const sa = JSON.stringify(a.spawnPoints), sb = JSON.stringify(b.spawnPoints);
  if (sa !== sb) fail(`${a.id}: spawn points differ between builds`);
  if (JSON.stringify(a.markers) !== JSON.stringify(b.markers)) fail(`${a.id}: markers differ between builds`);
}
console.log(`  ${passA.length} islands x2 builds, ${failures === 0 ? 'byte-identical' : failures + ' mismatches'}`);

// --- required spawn points -------------------------------------------------
console.log('\n== spawn points ==');
for (const { rec, kind } of passA) {
  if (kind !== 'landmark') continue;
  const missing = REQUIRED_SPAWNS.filter((k) => !rec.spawnPoints[k]);
  if (missing.length) fail(`${rec.id}: missing spawns ${missing.join(', ')}`);
  for (const [k, p] of Object.entries(rec.spawnPoints)) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) fail(`${rec.id}.${k}: non-finite position`);
    if (Math.abs(p.x) > rec.radius + 24 || Math.abs(p.z) > rec.radius + 24) fail(`${rec.id}.${k}: outside island (${p.x}, ${p.z})`);
    if (p.y < -12 || p.y > rec.maxHeight + 30) fail(`${rec.id}.${k}: y out of range (${p.y})`);
  }
}
console.log(`  ${REQUIRED_SPAWNS.length} required spawns present on all 8 landmarks`);

// --- walkable network ------------------------------------------------------
// The brief asks for a path network from the dock to every point of interest, so walk it:
// flood fill the surface from the dock spawn allowing one voxel of step, and see what is
// reachable. Plaza, boss arena, vista and the NPC posts must be on foot. A secret or a
// chest is allowed to be gated behind something else.
console.log('\n== walkable network (flood from dock, 1 voxel step) ==');
const MUST_REACH = ['plaza', 'boss_arena', 'vista', 'npc_1', 'npc_2', 'npc_3', 'npc_4'];
for (const { rec, kind } of passA) {
  if (kind !== 'landmark') continue;
  const c = rec.canvas;
  const { lv, n } = walkLevels(c);
  const dock = rec.spawnPoints.dock;
  const seen = reachable(c, lv, n, c.vx(dock.x), c.vz(dock.z), c.vy(dock.y));
  let area = 0;
  for (let i = 0; i < seen.length; i++) area += seen[i];
  const missed = [], gated = [];
  for (const [k, p] of Object.entries(rec.spawnPoints)) {
    if (k === 'dock') continue;
    const px = c.vx(p.x), pz = c.vz(p.z), py = c.vy(p.y);
    let ok = false;
    for (let dz = -2; dz <= 2 && !ok; dz++) {
      for (let dx = -2; dx <= 2 && !ok; dx++) {
        const qx = px + dx, qz = pz + dz;
        if (qx < 0 || qz < 0 || qx >= c.sx || qz >= c.sz) continue;
        const col = (qz * c.sx + qx) * c.sy;
        // The stand must be near the spawn's own height, or a roof overhead would count.
        for (let dy = -3; dy <= 3; dy++) {
          const qy = py + dy;
          if (qy < 1 || qy >= c.sy - 2) continue;
          if (seen[col + qy]) { ok = true; break; }
        }
      }
    }
    if (ok) continue;
    (MUST_REACH.indexOf(k) >= 0 ? missed : gated).push(k);
  }
  console.log(`  ${pad(rec.id, 18)} ${num(area, 8)} reachable stands of ${num(n, 8)}  |  gated: ${gated.length ? gated.join(',') : 'none'}`);
  if (missed.length) fail(`${rec.id}: unreachable on foot from the dock: ${missed.join(', ')}`);
}

// --- per-island report -----------------------------------------------------

// Budget is judged on the warm pass. The first island built in a fresh process also pays
// for JIT-compiling the whole toolkit, which the game never does at streaming time — by the
// time a player reaches any island, the builder has already run for the one they started on.
// The cold number is still printed, and still bounded, because a 3x regression there is real.
console.log('\n== landmarks ==');
console.log(pad('id', 18) + num('cold', 7) + num('warm', 7) + num('voxels', 10) + num('lo m', 7) + num('hi m', 7) + '  volume        bbox(vx)');
let totalMs = 0, totalVox = 0, worstMs = 0;
for (let i = 0; i < passA.length; i++) {
  const { rec, ms, kind } = passA[i];
  if (kind !== 'landmark') continue;
  const warm = passB[i].ms;
  const m = measure(rec);
  totalMs += ms; totalVox += m.voxels; worstMs = Math.max(worstMs, ms);
  const bb = m.bounds;
  console.log(
    pad(rec.id, 18) + num(ms.toFixed(1), 7) + num(warm.toFixed(1), 7) + num(m.voxels, 10)
    + num(m.groundMinM.toFixed(1), 7) + num(m.groundMaxM.toFixed(1), 7)
    + '  ' + pad(m.dims.join('x'), 14)
    + `${bb.x1 - bb.x0 + 1}x${bb.y1 - bb.y0 + 1}x${bb.z1 - bb.z0 + 1}`,
  );
  const top = m.hist.slice(0, 8).map(([id, n]) => `${nameOf(id)}:${n}`).join(' ');
  console.log('    blocks(' + m.hist.length + ' kinds) ' + top);
  if (warm > 100) fail(`${rec.id}: warm build took ${warm.toFixed(1)} ms (budget 100)`);
  if (ms > 200) fail(`${rec.id}: cold build took ${ms.toFixed(1)} ms (cold ceiling 200)`);
  if (m.dims[0] > 384 || m.dims[1] > 160 || m.dims[2] > 384) fail(`${rec.id}: volume exceeds 384x160x384`);
  // A structure touching the volume ceiling has been silently sliced off at the top.
  if (bb.y1 >= m.dims[1] - 2) fail(`${rec.id}: geometry is clipped by the volume ceiling (y1 ${bb.y1} of ${m.dims[1]})`);
}

console.log('\n== minor islands ==');
console.log(pad('archetype', 18) + num('cold', 7) + num('warm', 7) + num('voxels', 10) + num('lo m', 7) + num('hi m', 7) + '  volume');
const archSeen = new Set();
for (let i = 0; i < passA.length; i++) {
  const { rec, ms, kind } = passA[i];
  if (kind !== 'minor') continue;
  const warm = passB[i].ms;
  const m = measure(rec);
  totalMs += ms; totalVox += m.voxels; worstMs = Math.max(worstMs, ms);
  archSeen.add(rec.archetype);
  console.log(
    pad(rec.archetype, 18) + num(ms.toFixed(1), 7) + num(warm.toFixed(1), 7) + num(m.voxels, 10)
    + num(m.groundMinM.toFixed(1), 7) + num(m.groundMaxM.toFixed(1), 7)
    + '  ' + pad(m.dims.join('x'), 14)
    + m.hist.slice(0, 4).map(([id, n]) => `${nameOf(id)}:${n}`).join(' '),
  );
  if (m.voxels === 0) fail(`${rec.id}: built nothing`);
  if (warm > 100) fail(`${rec.id}: warm build took ${warm.toFixed(1)} ms (budget 100)`);
}
console.log(`  archetypes drawn at random: ${archSeen.size} of ${MINOR_ARCHETYPES.length} (${[...archSeen].join(', ')})`);

console.log('\n== archetype coverage (one forced build of each) ==');
for (const a of MINOR_ARCHETYPES) {
  const r1 = generateMinorIsland(new Rng(0x51105 + a.id.length), [0, 0], a.tiers[0], { B, archetype: a.id });
  const r2 = generateMinorIsland(new Rng(0x51105 + a.id.length), [0, 0], a.tiers[0], { B, archetype: a.id });
  const m = measure(r1);
  if (sha(r1.canvas.data) !== sha(r2.canvas.data)) fail(`${a.id}: forced build is not deterministic`);
  if (m.voxels < 1000) fail(`${a.id}: built almost nothing (${m.voxels} voxels)`);
  console.log(`  ${pad(a.id, 16)} ${num(m.voxels, 8)} voxels  ${num(m.hist.length, 3)} kinds  hi ${m.groundMaxM.toFixed(1)} m  ${m.dims.join('x')}`);
}

let warmTotal = 0, warmWorst = 0, warmWorstId = '';
for (const { rec, ms } of passB) {
  warmTotal += ms;
  if (ms > warmWorst) { warmWorst = ms; warmWorstId = rec.id; }
}
console.log('\n== totals ==');
console.log(`  cold: ${passA.length} islands  |  ${totalMs.toFixed(1)} ms total  |  ${(totalMs / passA.length).toFixed(1)} ms mean  |  ${worstMs.toFixed(1)} ms worst`);
console.log(`  warm: ${passB.length} islands  |  ${warmTotal.toFixed(1)} ms total  |  ${(warmTotal / passB.length).toFixed(1)} ms mean  |  ${warmWorst.toFixed(1)} ms worst (${warmWorstId})`);
console.log(`  ${totalVox.toLocaleString('en-US')} solid voxels`);

if (failures) {
  console.log(`\nFAILED: ${failures} problem(s)`);
  process.exit(1);
}
console.log('\nOK');
