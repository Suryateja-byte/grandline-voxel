#!/usr/bin/env node
// World self-check.
//
// Builds the world twice from the same seed and proves the properties the rest of the game
// is allowed to assume:
//
//   1. PLACEMENT IS PURE       — 100 sectors enumerated in opposite orders give byte-identical
//                                island records. This is the property everything else rests on.
//   2. SPACING HOLDS           — no two minor islands closer than MIN_ISLAND_SEP_M, and no
//                                minor inside a landmark's exclusion zone.
//   3. STREAMING IS PURE       — the same route produces the same resident chunk set, step for
//                                step, in two independent worlds.
//   4. QUERIES AGREE           — heightAt / blockAt match at 5000 sampled points across both.
//   5. MEMORY IS BOUNDED       — a 20 km voyage does not grow resident memory.
//
// Timings are reported in WORK UNITS (the streaming budget's currency) alongside measured
// milliseconds, so the unit calibration is evidence and not a claim.
//
// Usage: node tools/check-world.mjs [seed] [--quick] [--json]

import { performance } from 'node:perf_hooks';
import { TextureLibrary, registerCommonTiles } from '../src/gen/texture.js';
import { parseSeed } from '../src/core/rng.js';
import { LANDMARKS } from '../src/gen/islands.js';
import {
  World, registerWorldTiles, acceptedMinors, crowdsLandmark,
  SECTOR_M, MIN_ISLAND_SEP_M, LANDMARK_CLEARANCE_M,
} from '../src/world/world.js';
import { CHUNK } from '../src/world/chunk.js';
import { WeatherSystem, keyForSeverity, fieldSeverity } from '../src/world/weather.js';
import { SpawnSystem } from '../src/world/spawn.js';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const QUICK = argv.includes('--quick');
const SEED = parseSeed(argv.find((a) => !a.startsWith('--')) || 20260814);

const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  if (!ok) failures++;
  if (!JSON_OUT) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
  }
}
function say(s) { if (!JSON_OUT) console.log(s); }

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWorld(seed) {
  const tex = registerWorldTiles(registerCommonTiles(new TextureLibrary(seed)));
  const app = { seed, tex, post: {}, weatherKey: 'clear', setWeather(k) { this.weatherKey = k; } };
  const world = new World(app, { seed, tex, headless: true });
  app.world = world;
  return { app, world };
}

/** Stable signature of one island placement record. */
const recSig = (r) => [r.id, r.kind, r.worldPos[0], r.worldPos[1], r.radius, r.maxHeight,
  r.difficultyTier, r.archetype, r.seed].join('|');

/** Sorted signature of the resident chunk set, so ordering cannot mask a difference. */
function chunkSig(world) {
  const keys = [];
  for (const inst of world.loaded.values()) {
    for (const ch of inst.chunks.values()) {
      if (ch.state === CHUNK.MESHED) keys.push(inst.id + ':' + ch.cx + ',' + ch.cy + ',' + ch.cz);
    }
  }
  keys.sort();
  return keys;
}

// The authored route, west to east, plus a couple of open-sea legs so the check sees the
// empty parts of the map as well as the interesting ones.
const ROUTE = [];
{
  const stops = LANDMARKS.map((L) => [L.worldPos[0] + L.dockPos[0], L.worldPos[1] + L.dockPos[1]]);
  stops.unshift([-10200, 900]);
  stops.push([9400, -1200]);
  for (let i = 0; i + 1 < stops.length; i++) {
    const [x0, z0] = stops[i], [x1, z1] = stops[i + 1];
    const n = QUICK ? 2 : 5;
    for (let k = 0; k < n; k++) ROUTE.push([x0 + (x1 - x0) * (k / n), z0 + (z1 - z0) * (k / n)]);
  }
  ROUTE.push(stops[stops.length - 1]);
}

// ---------------------------------------------------------------------------
// 1. Placement purity
// ---------------------------------------------------------------------------

say(`\n=== check-world  seed=${SEED} ===`);
say('\n[1] placement purity over 100 sectors');

const SECTORS = [];
for (let sz = -5; sz < 5; sz++) for (let sx = -5; sx < 5; sx++) SECTORS.push([sx, sz]);

const forward = new Map();
for (const [sx, sz] of SECTORS) forward.set(sx + ',' + sz, acceptedMinors(SEED, sx, sz).map(recSig));

// Same sectors, opposite visit order, and through a second World instance (which caches),
// because "pure" has to survive both a different order and a warm cache.
const { world: worldB } = makeWorld(SEED);
const reverse = new Map();
for (let i = SECTORS.length - 1; i >= 0; i--) {
  const [sx, sz] = SECTORS[i];
  reverse.set(sx + ',' + sz, worldB._sectorMinors(sx, sz).map(recSig));
}

let mismatch = null, totalMinors = 0;
for (const [k, v] of forward) {
  totalMinors += v.length;
  const w = reverse.get(k) || [];
  if (v.length !== w.length || v.some((s, i) => s !== w[i])) { mismatch = k; break; }
}
check('placement identical forwards and backwards', !mismatch,
  mismatch ? 'first differing sector ' + mismatch : `${totalMinors} minor islands over 100 sectors`);

// A different seed must produce a different sea, or the seed is decorative.
const altSig = SECTORS.reduce((n, [sx, sz]) => n + acceptedMinors(SEED ^ 0x5bf03635, sx, sz).length, 0);
check('a different seed gives a different sea', altSig !== totalMinors || totalMinors === 0,
  `seed A: ${totalMinors} islands, seed B: ${altSig}`);

// ---------------------------------------------------------------------------
// 2. Spacing and landmark clearance
// ---------------------------------------------------------------------------

say('\n[2] blue-noise spacing and landmark exclusion');

const allMinors = [];
for (const [sx, sz] of SECTORS) for (const r of acceptedMinors(SEED, sx, sz)) allMinors.push(r);

let worstSep = Infinity, worstPair = null;
const hist = new Map();
for (let i = 0; i < allMinors.length; i++) {
  let nearest = Infinity;
  for (let j = 0; j < allMinors.length; j++) {
    if (i === j) continue;
    const d = Math.hypot(allMinors[i].worldPos[0] - allMinors[j].worldPos[0],
      allMinors[i].worldPos[1] - allMinors[j].worldPos[1]);
    if (d < nearest) nearest = d;
    if (d < worstSep) { worstSep = d; worstPair = [allMinors[i].id, allMinors[j].id]; }
  }
  if (nearest < Infinity) {
    const bucket = Math.min(20, Math.floor(nearest / 250));
    hist.set(bucket, (hist.get(bucket) || 0) + 1);
  }
}
check(`minimum separation >= ${MIN_ISLAND_SEP_M} m`, worstSep >= MIN_ISLAND_SEP_M,
  `worst pair ${worstSep === Infinity ? 'n/a' : worstSep.toFixed(1) + ' m'}${worstPair ? ' (' + worstPair.join(' / ') + ')' : ''}`);

let crowded = 0, worstLandmark = Infinity;
for (const r of allMinors) {
  if (crowdsLandmark(r.worldPos[0], r.worldPos[1])) crowded++;
  for (const L of LANDMARKS) {
    const d = Math.hypot(r.worldPos[0] - L.worldPos[0], r.worldPos[1] - L.worldPos[1]) - L.radius;
    if (d < worstLandmark) worstLandmark = d;
  }
}
check('no landmark is crowded', crowded === 0,
  `closest minor to any landmark: ${worstLandmark === Infinity ? 'n/a' : worstLandmark.toFixed(0) + ' m'} (limit ${LANDMARK_CLEARANCE_M})`);

if (!JSON_OUT) {
  console.log('\n  nearest-neighbour separation histogram (250 m buckets):');
  const keys = [...hist.keys()].sort((a, b) => a - b);
  const max = Math.max(1, ...hist.values());
  for (const k of keys) {
    const n = hist.get(k);
    const lo = k * 250;
    const label = k >= 20 ? '  5000+' : `${String(lo).padStart(5)}-${String(lo + 250).padStart(5)}`;
    console.log(`    ${label} m  ${String(n).padStart(4)}  ${'#'.repeat(Math.round((n / max) * 44))}`);
  }
}

// ---------------------------------------------------------------------------
// 3 + 4 + 5. Streaming, queries and memory along the route
// ---------------------------------------------------------------------------

say('\n[3] streaming the route in two independent worlds');

const A = makeWorld(SEED);
const B = makeWorld(SEED);
const spawnA = new SpawnSystem(A.app, { world: A.world, headless: true });
const weatherA = new WeatherSystem(A.app, { world: A.world, headless: true });

// A stubbed bounty so the marine-patrol scaling is actually exercised: without it the
// Navy correctly ignores a rookie and the check would prove nothing about the scaling.
A.app.quests = {
  bountyState: () => ({ marinePatrolChance: 0.62, spawnTierBonus: 2, tierIndex: 4 }),
  notify: () => {},
};

let chunkMismatch = null;
let peakVolumeBytes = 0, peakChunks = 0, peakTriangles = 0, peakHeap = 0;
let routeMetres = 0;
let streamMs = 0;
let maxPatrols = 0;
const settleSteps = [];

let prev = null;
for (let i = 0; i < ROUTE.length; i++) {
  const [x, z] = ROUTE[i];
  if (prev) routeMetres += Math.hypot(x - prev[0], z - prev[1]);
  prev = [x, z];
  const yaw = Math.atan2(1, 0.2);

  A.world.setFocus(x, 2, z, yaw);
  B.world.setFocus(x, 2, z, yaw);
  const tw = performance.now();
  settleSteps.push(A.world.streamer.settle(9000));
  B.world.streamer.settle(9000);
  streamMs += (performance.now() - tw) / 2;   // two worlds, one world's worth of work

  // Run the real system step too, so weather, spawn and the quest notifications are
  // exercised on the same route rather than only in isolation.
  for (let k = 0; k < 150; k++) {
    A.world.step(1 / 60, A.app);
    weatherA.step(1 / 60, A.app);
    spawnA.step(1 / 60, A.app);
  }
  maxPatrols = Math.max(maxPatrols, spawnA.patrols.length);

  const sa = chunkSig(A.world), sb = chunkSig(B.world);
  if (!chunkMismatch && (sa.length !== sb.length || sa.some((v, k) => v !== sb[k]))) {
    chunkMismatch = `waypoint ${i} (${x.toFixed(0)}, ${z.toFixed(0)}): A=${sa.length} B=${sb.length}`;
  }

  const rep = A.world.report();
  peakVolumeBytes = Math.max(peakVolumeBytes, rep.volumeBytes);
  peakChunks = Math.max(peakChunks, rep.chunksResident);
  peakTriangles = Math.max(peakTriangles, rep.triangles);
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
}
const routeMs = streamMs;

check('resident chunk sets identical across two worlds', !chunkMismatch, chunkMismatch || `${ROUTE.length} waypoints`);

// --- queries -------------------------------------------------------------

say('\n[4] heightAt / blockAt agreement at 5000 points');

let sampled = 0, land = 0, qMismatch = null;
{
  // Sample around the final waypoint plus every island still resident, so the points that
  // matter (actual terrain) dominate instead of empty ocean.
  const centres = [];
  for (const inst of A.world.loaded.values()) centres.push([inst.centerX, inst.centerZ, inst.radius]);
  if (!centres.length) centres.push([ROUTE[ROUTE.length - 1][0], ROUTE[ROUTE.length - 1][1], 200]);
  for (let i = 0; i < 5000; i++) {
    const c = centres[i % centres.length];
    // Deterministic spiral sampling: no rng needed and the coverage is even.
    const a = i * 2.39996323;
    const r = Math.sqrt((i % 400) / 400) * (c[2] * 1.25);
    const x = c[0] + Math.cos(a) * r;
    const z = c[1] + Math.sin(a) * r;
    const ha = A.world.heightAt(x, z), hb = B.world.heightAt(x, z);
    sampled++;
    if (ha !== hb) { qMismatch = `heightAt(${x.toFixed(2)}, ${z.toFixed(2)}): ${ha} vs ${hb}`; break; }
    if (ha === -Infinity) continue;
    land++;
    for (const dy of [-2, 0, 1.5]) {
      const y = ha + dy;
      const ba = A.world.blockAt(x, y, z), bb = B.world.blockAt(x, y, z);
      if (ba !== bb) { qMismatch = `blockAt(${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}): ${ba} vs ${bb}`; break; }
    }
    if (qMismatch) break;
  }
}
check('heightAt / blockAt agree', !qMismatch, qMismatch || `${sampled} points sampled, ${land} on land`);

// A surface query has to be consistent with the block query, or physics stands in a wall.
let selfMismatch = null;
for (const inst of A.world.loaded.values()) {
  if (!inst.vol) continue;
  for (let k = 0; k < 400 && !selfMismatch; k++) {
    const a = k * 2.39996323;
    const r = Math.sqrt(k / 400) * inst.radius;
    const x = inst.centerX + Math.cos(a) * r, z = inst.centerZ + Math.sin(a) * r;
    const h = inst.heightAt(x, z);
    if (h === -Infinity) continue;
    if (!A.world.isSolid(x, h - 0.25, z)) selfMismatch = `no solid just below heightAt at ${x.toFixed(1)},${z.toFixed(1)}`;
    else if (A.world.isSolid(x, h + 0.25, z)) selfMismatch = `solid just above heightAt at ${x.toFixed(1)},${z.toFixed(1)}`;
  }
  if (selfMismatch) break;
}
check('heightAt is the top of the solid column', !selfMismatch, selfMismatch || 'surface and block queries consistent');

// --- raycast -------------------------------------------------------------

let rayOk = 0, rayTried = 0;
for (const inst of A.world.loaded.values()) {
  if (!inst.vol) continue;
  for (let k = 0; k < 60; k++) {
    const a = k * 2.39996323;
    const r = Math.sqrt(k / 60) * inst.radius * 0.8;
    const x = inst.centerX + Math.cos(a) * r, z = inst.centerZ + Math.sin(a) * r;
    const h = inst.heightAt(x, z);
    if (h === -Infinity) continue;
    rayTried++;
    const hit = A.world.raycast({ x, y: h + 20, z }, { x: 0, y: -1, z: 0 }, 40);
    if (hit && Math.abs(hit.y - (h - 0.25)) < 0.6) rayOk++;
  }
}
check('raycast lands on the surface it should', rayTried === 0 || rayOk / rayTried > 0.95,
  `${rayOk}/${rayTried} downward rays hit the top voxel`);

// --- terrain edits round-trip -------------------------------------------

let editOk = false;
for (const inst of A.world.loaded.values()) {
  if (!inst.vol) continue;
  const x = inst.centerX, z = inst.centerZ;
  const h = inst.heightAt(x, z);
  if (h === -Infinity) continue;
  const before = A.world.blockAt(x, h - 0.25, z);
  A.world.setBlock(x, h - 0.25, z, 0);
  const after = A.world.blockAt(x, h - 0.25, z);
  const saved = A.world.serialize();
  editOk = before !== 0 && after === 0 && !!saved.edits[inst.id] && saved.edits[inst.id].length === 4;
  break;
}
check('setBlock writes, re-dirties and serialises', editOk, editOk ? 'edit captured in the save payload' : 'no editable island resident');

// --- memory --------------------------------------------------------------

say('\n[5] memory over the route');

if (global.gc) global.gc();
const endHeap = process.memoryUsage().heapUsed;
const MEM_LIMIT = 220 * 1048576;
check('resident island volumes stay bounded', peakVolumeBytes < MEM_LIMIT,
  `peak ${(peakVolumeBytes / 1048576).toFixed(1)} MB of voxel volumes (limit ${(MEM_LIMIT / 1048576) | 0} MB)`);
check('resident chunk meshes stay under the cap', peakChunks <= A.world.streamer.maxChunkMeshes,
  `peak ${peakChunks} chunks (cap ${A.world.streamer.maxChunkMeshes})`);

// --- weather -------------------------------------------------------------

say('\n[6] weather field');

const bands = { clear: 0, breezy: 0, overcast: 0, squall: 0, storm: 0 };
let n = 0;
for (let i = 0; i < 120; i++) {
  for (let j = 0; j < 40; j++) {
    bands[keyForSeverity(fieldSeverity(SEED, i * 200 - 12000, j * 300 - 6000, 0))]++;
    n++;
  }
}
let wMismatch = null;
for (let k = 0; k < 500; k++) {
  const x = k * 37 - 9000, z = (k * 91) % 4000 - 2000, t = k * 3.7;
  if (fieldSeverity(SEED, x, z, t) !== fieldSeverity(SEED, x, z, t)) wMismatch = 'unstable';
}
check('weather is a pure function of (seed, position, time)', !wMismatch, 'field re-sampled 500x, identical');
check('weather is mostly sailable', bands.clear + bands.breezy > n * 0.45,
  Object.keys(bands).map((k) => `${k} ${(bands[k] * 100 / n).toFixed(0)}%`).join('  '));

// --- spawn ---------------------------------------------------------------

say('\n[7] spawn determinism and the cleared set');

const spawnRep = spawnA.report();
let spawnStable = true, spawnDetail = '';
{
  const island = [...A.world.loaded.values()].find((i) => i.record.spawnPoints);
  if (island) {
    const first = JSON.stringify(spawnA.spawnsFor(island.id));
    // A camp defeated stays defeated when the island is rebuilt from scratch.
    const set = spawnA.spawnsFor(island.id);
    if (set.camps.length) spawnA.markCleared(set.camps[0].id);
    const savedSpawn = spawnA.serialize();
    spawnA.byIsland.delete(island.id);
    spawnA.populate(island);
    const second = JSON.stringify(spawnA.spawnsFor(island.id));
    spawnStable = first === second;
    spawnA.deserialize(savedSpawn);
    const stillCleared = set.camps.length === 0 || spawnA.cleared.has(set.camps[0].id);
    spawnStable = spawnStable && stillCleared;
    spawnDetail = `${island.id}: ${set.camps.length} camps, ${set.npcs.length} npcs, ${set.chests.length} chests; cleared survives save/load: ${stillCleared}`;
  } else {
    spawnDetail = 'no island resident to test';
  }
}
check('spawn sets are identical on rebuild and honour the cleared set', spawnStable, spawnDetail);
check('marine patrols scale with the bounty tier', maxPatrols >= 3,
  `peak ${maxPatrols} marine hulls at sea for marinePatrolChance 0.62 (cap 4)`);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const stats = A.world.report();
const units = A.world.streamer.budget.lifetime;
const summary = {
  seed: SEED,
  sectors: SECTORS.length,
  minorIslands: totalMinors,
  landmarks: LANDMARKS.length,
  minSeparationM: worstSep === Infinity ? null : Number(worstSep.toFixed(1)),
  routeWaypoints: ROUTE.length,
  routeMetres: Math.round(routeMetres),
  islandsBuilt: stats.islandsBuilt,
  islandsCompacted: stats.islandsCompacted,
  chunksMeshed: stats.chunksMeshed,
  chunksEvicted: stats.chunksEvicted,
  peakResidentChunks: peakChunks,
  peakTriangles: peakTriangles,
  peakVolumeMB: Number((peakVolumeBytes / 1048576).toFixed(1)),
  peakHeapMB: Number((peakHeap / 1048576).toFixed(1)),
  endHeapMB: Number((endHeap / 1048576).toFixed(1)),
  workUnitsTotal: Math.round(units),
  streamerMs: Number(routeMs.toFixed(0)),
  peakMarineShips: maxPatrols,
  microsecondsPerWorkUnit: Number((routeMs * 1000 / Math.max(1, units)).toFixed(3)),
  budgetUnitsPerStep: A.world.streamer.budget.unitsPerStep,
  maxSettleSteps: Math.max(...settleSteps),
  spawn: spawnRep,
  weather: weatherA.report(),
};

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failures === 0, checks: results, summary }, null, 2));
} else {
  console.log('\n=== counts and timings ===');
  for (const k of Object.keys(summary)) {
    const v = summary[k];
    console.log(`  ${k.padEnd(26)} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${results.length - failures}/${results.length} checks`);
}

process.exit(failures === 0 ? 0 : 1);
