// Self-check for src/ship/*. Headless: no GL, no DOM.
//
//   node tools/check-ship.mjs [seed]
//
// It runs the real Water from src/render/water.js (which works under node — it only builds
// geometry and a ShaderMaterial), the real SailingBody, the real DockController, the real
// CrewAboard and the real ShipSystem, and asserts the things that would make the ship not a ship:
//
//   1. FLOATS   — in every weather state, over 60 simulated seconds, the hull centre tracks the
//                 local wave height inside a sane band and never sinks or flies, and it rolls
//                 and pitches with the sea rather than sliding flat across it.
//   2. SAILS    — the polar diagram: strictly monotone for the rig in a flat calm, correctly
//                 ordered by point of sail in a real seaway, stalled in irons, fastest running.
//   3. REPEATS  — two identical 3000-step runs give bit-identical position and rotation.
//   4. DOCKS    — 200 consecutive docking approaches put the player ashore on solid ground and
//                 boarding puts them back on the deck. Zero failures allowed.
//   5. EXTRAS   — fast travel is a real voyage, the three upgrade tiers visibly differ, and the
//                 crew are aboard, stationed, animated and applying their bonuses.
//
// Exit code 1 on any failure.

import { Water } from '../src/render/water.js';
import { WEATHER } from '../src/render/sky.js';
import { parseSeed, Rng } from '../src/core/rng.js';
import { SailingBody, polarDiagram, sailEfficiency, pointOfSailName } from '../src/ship/sailing.js';
import { DockController, berthPose, DOCK_STATE } from '../src/ship/dock.js';
import { ShipSystem, MOUNT } from '../src/ship/ship.js';
import { CrewAboard, CREW_ARCHETYPE } from '../src/ship/crewaboard.js';
import { deckHalfWidth, deckHeightAt, DECK_Z_RANGE, buildShipModel } from '../src/ship/shipmodel.js';
import { TextureLibrary, registerCommonTiles } from '../src/gen/texture.js';
import { BlockRegistry } from '../src/gen/voxel.js';
import { CREW } from '../src/quest/crew.js';
import { CHARACTER_SPECS } from '../src/gen/charmodel.js';

const SEED = parseSeed(process.argv[2] || 20260814);
const DT = 1 / 60;

const failures = [];
const fail = (msg) => { failures.push(msg); console.log('  FAIL  ' + msg); };
const ok = (msg) => console.log('  ok    ' + msg);
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const f2 = (v) => (v >= 0 ? ' ' : '') + v.toFixed(2);
const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => {
  let x = a % (Math.PI * 2);
  if (x > Math.PI) x -= Math.PI * 2;
  if (x < -Math.PI) x += Math.PI * 2;
  return x;
};

/** A Water positioned in time and weather, without the renderer. */
function makeWater(weather, windAngle = 0.4) {
  const w = new Water();
  w.windAngle = windAngle;
  w.waveScale = weather.waveScale;
  return w;
}

/** Advance a Water the way App.step does. */
function stepWater(w, weather, dt) {
  w.waveScale = weather.waveScale;
  w.step(dt);
}

// ===========================================================================
// 1. FLOATS
// ===========================================================================

console.log('=== 1. BUOYANCY ===  60 s per weather state, seed ' + SEED);
console.log(pad('weather', 10) + padL('waveScale', 10) + padL('meanOff', 9) + padL('maxOff', 8)
  + padL('band', 7) + padL('minY', 8) + padL('maxY', 8) + padL('maxRoll', 9)
  + padL('maxPitch', 10) + padL('heaveHz', 9));

// The band scales with the sea, because it has to: the hull averages the surface over 19 m and
// a 62 m storm swell is simply not flat under it. `1.2 + 1.4 * waveScale` is about half a hull
// length of lag in a calm and about one wave amplitude in a storm.
const floatBand = (waveScale) => 1.2 + 1.4 * waveScale;
const HARD_LOW = -6.0;       // below this the ship has sunk
const HARD_HIGH = 12.0;      // above this the ship has flown

for (const key of Object.keys(WEATHER)) {
  const weather = WEATHER[key];
  const water = makeWater(weather);
  const body = new SailingBody({ seed: SEED });
  body.sailTrim = 0.5; body.sailTarget = 0.5;
  const ctx = { water, weather };
  let sumOff = 0, maxOff = 0, minY = Infinity, maxY = -Infinity;
  let maxRoll = 0, maxPitch = 0, crossings = 0, prevSign = 0;
  const n = 60 * 60;
  for (let i = 0; i < n; i++) {
    stepWater(water, weather, DT);
    body.step(DT, ctx);
    const surf = water.heightAt(body.pos.x, body.pos.z);
    const off = body.pos.y - surf;
    // Skip the first 5 s: the ship starts at y = 0 and has to settle onto the wave, and that
    // transient is not what "does it float" means.
    if (i > 300) {
      sumOff += Math.abs(off);
      if (Math.abs(off) > maxOff) maxOff = Math.abs(off);
      const s = Math.sign(body.vel.y);
      if (s !== 0 && prevSign !== 0 && s !== prevSign) crossings++;
      if (s !== 0) prevSign = s;
    }
    minY = Math.min(minY, body.pos.y);
    maxY = Math.max(maxY, body.pos.y);
    maxRoll = Math.max(maxRoll, Math.abs(body.roll));
    maxPitch = Math.max(maxPitch, Math.abs(body.pitch));
  }
  const meanOff = sumOff / (n - 300);
  const heaveHz = crossings / 2 / 55;
  const band = floatBand(weather.waveScale);
  console.log(pad(key, 10) + padL(weather.waveScale.toFixed(2), 10) + padL(meanOff.toFixed(3), 9)
    + padL(maxOff.toFixed(3), 8) + padL(band.toFixed(2), 7)
    + padL(minY.toFixed(2), 8) + padL(maxY.toFixed(2), 8)
    + padL((maxRoll * 180 / Math.PI).toFixed(1) + 'd', 9) + padL((maxPitch * 180 / Math.PI).toFixed(1) + 'd', 10)
    + padL(heaveHz.toFixed(2), 9));

  if (!Number.isFinite(body.pos.y)) fail(`${key}: hull y is not finite — the integrator blew up`);
  if (minY < HARD_LOW) fail(`${key}: hull sank to y=${minY.toFixed(2)} (limit ${HARD_LOW})`);
  if (maxY > HARD_HIGH) fail(`${key}: hull flew to y=${maxY.toFixed(2)} (limit ${HARD_HIGH})`);
  if (maxOff > band) fail(`${key}: hull left the surface band by ${maxOff.toFixed(2)} m (limit ${band.toFixed(2)})`);
  if (meanOff > band * 0.45) fail(`${key}: mean offset ${meanOff.toFixed(2)} m is too far from the surface`);
  if (maxRoll > 1.0) fail(`${key}: rolled ${(maxRoll * 180 / Math.PI).toFixed(0)} degrees — that is a capsize`);
  // A ship that does not move with the sea is the failure this whole file exists to catch.
  if (weather.waveScale > 0.8 && maxRoll < 0.02) fail(`${key}: the hull is not rolling with the sea at all`);
  if (weather.waveScale > 0.8 && maxPitch < 0.02) fail(`${key}: the hull is not pitching with the sea at all`);
}
if (!failures.length) ok('the ship floats, rolls and pitches in every weather state');

// ===========================================================================
// 2. SAILS — the polar diagram
// ===========================================================================

console.log('');
console.log('=== 2. POLAR DIAGRAM ===  full sail, 15-degree steps');

/** Pretty-print a polar. */
function showPolar(title, rows) {
  console.log(title);
  console.log('  ' + pad('AWA', 6) + padL('knots', 8) + '  point of sail        bar');
  for (const p of rows) {
    const bar = '#'.repeat(Math.max(0, Math.round(p.knots * 4)));
    console.log('  ' + pad(p.deg + 'd', 6) + padL(f2(p.knots), 8) + '  ' + pad(p.point, 20) + ' ' + bar);
  }
}

// (a) The RIG's own polar, in a flat calm. This isolates sail and hull from the sea, and it is
// the one that must be strictly monotone: a dip here is a bug in the efficiency curve or the
// drag model, not weather.
const calm = { ...WEATHER.breezy, waveScale: 0.001 };
const rigPolar = polarDiagram(makeWater(calm), calm, { stepDeg: 15, seconds: 110, repeats: 1, seed: SEED });
showPolar('flat calm (the rig alone, wind 8 m/s):', rigPolar);

const at = (arr, d) => arr.find((p) => p.deg === d).knots;
if (at(rigPolar, 0) > 0.6) fail(`in irons the rig still makes ${at(rigPolar, 0).toFixed(2)} kn — the sail is not stalling`);
let bestRig = rigPolar[0];
for (const p of rigPolar) if (p.knots > bestRig.knots) bestRig = p;
if (bestRig.deg !== 180) fail(`the rig's fastest point of sail is ${bestRig.deg} degrees, not dead downwind`);
let rigMono = true;
for (let i = 1; i < rigPolar.length; i++) {
  if (rigPolar[i].deg < 30) continue;
  if (rigPolar[i].knots < rigPolar[i - 1].knots) {
    rigMono = false;
    fail(`rig polar is not monotone: ${rigPolar[i - 1].deg}d ${rigPolar[i - 1].knots.toFixed(2)} kn -> `
      + `${rigPolar[i].deg}d ${rigPolar[i].knots.toFixed(2)} kn`);
  }
}
if (rigMono) ok('rig polar rises strictly monotonically from the luff limit to dead downwind');

// (b) The polar the player actually sails, in a real seaway. It is NOT strictly monotone and it
// should not be: at these speeds a 62 m quartering swell adds and subtracts about half a knot,
// which IS the ship being driven by the water. So what is asserted here is the ordering of the
// points of sail and the size of the swell's contribution, not the smoothness of the curve.
const polarWeather = WEATHER.breezy;
const polar = polarDiagram(makeWater(polarWeather), polarWeather, { stepDeg: 15, seconds: 110, repeats: 1, seed: SEED });
console.log('');
showPolar('breezy sea (what the player sails):', polar);

const running = at(polar, 180);
const broad = at(polar, 120);
const beam = at(polar, 90);
const close = at(polar, 60);
const irons = at(polar, 0);
let seaSwing = 0;
for (let i = 1; i < polar.length; i++) {
  if (polar[i].deg < 45) continue;
  seaSwing = Math.max(seaSwing, polar[i - 1].knots - polar[i].knots);
}
console.log('  largest swell-induced dip: ' + seaSwing.toFixed(2) + ' kn');

if (irons > 0.6) fail(`in irons the ship still makes ${irons.toFixed(2)} kn — the sail is not stalling`);
if (!(running > broad)) fail(`running (${running.toFixed(2)} kn) is not faster than a broad reach (${broad.toFixed(2)} kn)`);
if (!(broad > beam)) fail(`a broad reach (${broad.toFixed(2)} kn) is not faster than a beam reach (${beam.toFixed(2)} kn)`);
if (!(beam > close)) fail(`a beam reach (${beam.toFixed(2)} kn) is not faster than close hauled (${close.toFixed(2)} kn)`);
if (!(close > irons)) fail(`close hauled (${close.toFixed(2)} kn) is not faster than irons (${irons.toFixed(2)} kn)`);
let bestSea = polar[0];
for (const p of polar) if (p.knots > bestSea.knots) bestSea = p;
if (bestSea.deg < 150) fail(`the fastest point of sail in a sea is ${bestSea.deg} degrees, outside the running band`);
if (seaSwing > 1.2) fail(`the swell moves the polar by ${seaSwing.toFixed(2)} kn — that is not a swell, that is instability`);

// The names must match the numbers. Checked away from the boundaries, where a floating-point
// hair either side is not a defect.
const NAME_CASES = [[5, 'irons'], [30, 'irons'], [55, 'close hauled'], [90, 'beam reach'], [130, 'broad reach'], [170, 'running']];
for (const [deg, want] of NAME_CASES) {
  const got = pointOfSailName((deg * Math.PI) / 180);
  if (got !== want) fail(`point of sail at ${deg}d is "${got}", expected "${want}"`);
}
// Efficiency curve sanity: strictly increasing above the luff limit.
for (let d = 40; d <= 180; d += 5) {
  const a = sailEfficiency(((d - 5) * Math.PI) / 180);
  const b = sailEfficiency((d * Math.PI) / 180);
  if (b < a) { fail(`sailEfficiency is not monotone at ${d} degrees`); break; }
}

// Top speed under each weather, running, so the tuning is visible rather than assumed.
console.log('');
console.log(pad('weather', 10) + padL('wind m/s', 10) + padL('top knots', 11));
for (const key of Object.keys(WEATHER)) {
  const w = WEATHER[key];
  const pol = polarDiagram(makeWater(w), w, { stepDeg: 180, seconds: 110, repeats: 1, seed: SEED });
  const top = pol[pol.length - 1].knots;
  console.log(pad(key, 10) + padL(w.wind.toFixed(1), 10) + padL(top.toFixed(2), 11));
  if (top < 1.0) fail(`${key}: running top speed ${top.toFixed(2)} kn is not a moving ship`);
  if (top > 26) fail(`${key}: running top speed ${top.toFixed(2)} kn is not a sailing ship`);
}

// ===========================================================================
// 3. REPEATS — determinism
// ===========================================================================

console.log('');
console.log('=== 3. DETERMINISM ===  two identical 3000-step runs');

const ISLANDS = [
  { id: 'shellsCove', name: 'Shells Cove', worldPos: [0, 0], dockPos: [-4, 38], radius: 62 },
  { id: 'palmReach', name: 'Palm Reach', worldPos: [1800, 400], dockPos: [3, 60], radius: 70 },
];

/** One scripted run: helm and sail changes on a fixed schedule, no randomness anywhere. */
function scriptedRun(steps, seed) {
  const weather = WEATHER.squall;
  const water = makeWater(weather, 0.4);
  const body = new SailingBody({ seed });
  const dock = new DockController({ seed, islands: ISLANDS });
  const ctx = { water, weather };
  for (let i = 0; i < steps; i++) {
    // A schedule with everything in it: sail set, helm over both ways, anchor down and up.
    if (i === 30) body.sailTarget = 1;
    if (i === 600) body.helm = 0.7;
    if (i === 1200) body.helm = -0.5;
    if (i === 1800) body.sailTarget = 0.35;
    if (i === 2100) body.toggleAnchor();
    if (i === 2400) body.toggleAnchor();
    if (i === 2600) body.helm = 0;
    stepWater(water, weather, DT);
    body.step(DT, ctx);
    dock.step(DT, body, ctx);
  }
  return {
    pos: [body.pos.x, body.pos.y, body.pos.z],
    rot: [body.yaw, body.pitch, body.roll],
    vel: [body.vel.x, body.vel.y, body.vel.z],
    trim: body.sailTrim,
    dockState: dock.state,
  };
}

const runA = scriptedRun(3000, SEED);
const runB = scriptedRun(3000, SEED);
console.log('  run A  pos ' + runA.pos.map((v) => v.toFixed(9)).join(', '));
console.log('  run B  pos ' + runB.pos.map((v) => v.toFixed(9)).join(', '));
console.log('  run A  rot ' + runA.rot.map((v) => v.toFixed(9)).join(', '));
console.log('  run B  rot ' + runB.rot.map((v) => v.toFixed(9)).join(', '));
if (JSON.stringify(runA) !== JSON.stringify(runB)) fail('two identical 3000-step runs diverged');
else ok('3000 steps, bit-identical position and rotation');

// A different seed must NOT change the trajectory: the seed only drives cosmetic cadence. This
// is checked because a seeded Rng leaking into the integrator is exactly the bug that would make
// a replay drift, and it would not show up in the run-A-equals-run-B test above.
const runC = scriptedRun(3000, (SEED ^ 0x9e3779b9) >>> 0);
if (JSON.stringify(runC.pos) !== JSON.stringify(runA.pos)) {
  fail('changing the seed changed the trajectory — randomness has leaked into the integrator');
} else ok('trajectory is independent of the RNG seed (no randomness in the integrator)');

// ===========================================================================
// 4. DOCKS — 200 approach / ashore / aboard cycles
// ===========================================================================

console.log('');
console.log('=== 4. DOCK, DISEMBARK, BOARD ===  200 consecutive cycles');

/**
 * A stub world with a real beach profile: a cone of land inside the island radius, then a SHELF
 * that falls from the shoreline to 14 m of water over the next 30 m, then open sea. A pier disc
 * at the dock point gives somewhere to stand.
 *
 * The shelf matters. An island modelled as a cliff dropping straight from land to deep water
 * means a ship either floats or is instantly six metres up a hill with no swell that could ever
 * float it off — which tests the stub's geometry rather than the ship. The real islands in
 * src/gen/islands.js carry a shelf (SHELF_MARGIN_M); so does this one.
 */
function makeWorld(islands) {
  return {
    heightAt(x, z) {
      let h = -14;
      for (const i of islands) {
        const d = Math.hypot(x - i.x, z - i.z);
        if (d < i.radius) h = Math.max(h, 2.5 + (1 - d / i.radius) * 18);
        else {
          // Continuous with the cone at d = radius, reaching -14 m at radius + 30.
          const t = clampN((i.radius + 30 - d) / 30, 0, 1);
          h = Math.max(h, -14 + t * t * 16.5);
        }
        if (Math.hypot(x - i.dockX, z - i.dockZ) < 3.5) h = Math.max(h, 1.4);
      }
      return h;
    },
  };
}

const DOCK_ISLANDS = [
  { id: 'shellsCove', name: 'Shells Cove', x: 0, z: 0, dockX: -4, dockZ: 62, radius: 62 },
  { id: 'palmReach', name: 'Palm Reach', x: 1800, z: 400, dockX: 1803, dockZ: 470, radius: 70 },
  { id: 'cogHarbour', name: 'Cog Harbour', x: -900, z: -1200, dockX: -900, dockZ: -1132, radius: 68 },
];
const world = makeWorld(DOCK_ISLANDS);

/** A minimal App the ShipSystem is happy to be stepped by. */
function makeApp(weather, water, playerPos) {
  return {
    seed: SEED,
    water,
    world,
    sky: { weather },
    player: { pos: playerPos, onShip: false },
    clock: { simTime: 0 },
    input: null,
    materials: null,
    tex: null,
    blocks: null,
  };
}

/**
 * An autopilot that can actually sail a square rig.
 *
 * It conns the ship the way a person would: first to an OUTER MARK 55 m seaward of the berth,
 * then straight down the seaward axis into the berth. That two-leg approach is what keeps the
 * ship off the island instead of relying on a depth alarm, and it means the final leg is always
 * clear water. Beating, tacking, irons recovery and taking the way off are all real:
 *
 *   * it never steers inside the no-go zone; when the mark is upwind it beats, holding each
 *     tack for at least twelve seconds and going about only with way on
 *   * caught head to wind it backs the sail and holds the helm over, which is the ship's own
 *     recovery from irons (see sailAback / ABACK_YAW in sailing.js)
 *   * every helm order is signed by the flow past the blade, because a rudder reverses when the
 *     ship gathers sternway
 *
 * This is test scaffolding, not game code — but it has to be a competent driver, because "the
 * ship never reached the dock" must mean the dock is broken, not that the pilot was hopeless.
 */
function makePilot(water, berth, noGoDeg = 60) {
  const fromAngle = water.windAngle + Math.PI;
  const windFromYaw = Math.atan2(Math.cos(fromAngle), Math.sin(fromAngle));
  const noGo = (noGoDeg * Math.PI) / 180;
  const OUTER = 55;
  const outerX = berth.x + berth.ox * OUTER;
  const outerZ = berth.z + berth.oz * OUTER;
  let tack = 0;
  let tackTimer = 0;
  let onFinal = false;

  return function drive(ship, dt) {
    const body = ship.body;
    const distB = Math.hypot(berth.x - body.pos.x, berth.z - body.pos.z);
    const distO = Math.hypot(outerX - body.pos.x, outerZ - body.pos.z);
    if (distO < 22 || distB < 40) onFinal = true;
    const tx = onFinal ? berth.x : outerX;
    const tz = onFinal ? berth.z : outerZ;

    const dx = tx - body.pos.x, dz = tz - body.pos.z;
    const dist = Math.hypot(dx, dz);
    const bearing = Math.atan2(dx, dz);
    const bearingAwa = wrapPi(bearing - windFromYaw);   // how close to the wind the mark is
    const canLay = Math.abs(bearingAwa) >= noGo;

    // Sail plan: full while beating (you cannot claw upwind under a scrap of canvas), full
    // offshore, shortened on the run in, and a rag of steerage way for the last few lengths.
    if (!canLay) body.sailTarget = 1;
    else if (!onFinal) body.sailTarget = dist > 45 ? 1 : 0.45;
    else body.sailTarget = distB > 70 ? 1 : distB > 42 ? 0.4 : distB > 15 ? 0.15 : 0;
    // Anchor to take the last of the way off, but only when the berth can be laid: dropping the
    // hook halfway up a beat just parks you.
    if (onFinal && canLay && distB < 28 && body.speed > 2.6 && !body.anchorDown) body.toggleAnchor();
    if ((!onFinal || !canLay || distB > 46) && body.anchorDown) body.toggleAnchor();

    // A rudder reverses when the ship gathers sternway, so every helm order below is signed by
    // which way the water is actually flowing past the blade.
    const rudderSign = body.forwardSpeed < -0.15 ? -1 : 1;

    // Caught head to wind: back the sail, hold the helm over, and let her come round.
    if (body.apparentWind < 0.85 && Math.abs(body.forwardSpeed) < 1.2 && dist > 16) {
      if (tack === 0) tack = bearingAwa >= 0 ? 1 : -1;
      body.sailTarget = 0.8;
      const want = wrapPi(windFromYaw + tack * noGo - body.yaw);
      body.helm = (Math.sign(want) || tack) * rudderSign;
      return distB;
    }

    let heading = bearing;
    if (!canLay && dist > 16) {
      if (tack === 0) tack = bearingAwa >= 0 ? 1 : -1;
      tackTimer += dt;
      const overstood = Math.sign(bearingAwa) === -tack && Math.abs(bearingAwa) > 0.45;
      if (tackTimer > 12 && body.forwardSpeed > 1.2 && (overstood || tackTimer > 50)) {
        tack = -tack;
        tackTimer = 0;
      }
      heading = windFromYaw + tack * noGo;
    } else {
      tack = 0;
      tackTimer = 0;
    }
    body.helm = clampN(wrapPi(heading - body.yaw) * 2.2 * rudderSign, -1, 1);
    return distB;
  };
}

const cycleRng = new Rng(SEED).fork('dockcheck');
let cycles = 0, dockFails = 0, ashoreFails = 0, boardFails = 0;
let worstAshoreDrop = 0, worstDeckErr = 0, maxSteps = 0, sumSteps = 0, worstClearance = Infinity;
const WEATHER_KEYS = Object.keys(WEATHER);

for (let c = 0; c < 200; c++) {
  const isl = DOCK_ISLANDS[c % DOCK_ISLANDS.length];
  const weather = WEATHER[WEATHER_KEYS[c % WEATHER_KEYS.length]];
  const water = makeWater(weather, cycleRng.range(0, Math.PI * 2));
  const playerPos = [0, 0, 0];
  const app = makeApp(weather, water, playerPos);
  const berth = berthPose(isl);
  // Start seaward of the berth: within 70 degrees of the outward bearing, 50-130 m off. That is
  // where a ship arrives from. Starting inshore would only test whether the autopilot can sail
  // through an island.
  const outAng = Math.atan2(berth.oz, berth.ox);
  const ang = outAng + cycleRng.range(-1.22, 1.22);
  const dist = cycleRng.range(50, 130);
  const sx = berth.x + Math.cos(ang) * dist;
  const sz = berth.z + Math.sin(ang) * dist;
  const ship = new ShipSystem(app, {
    seed: SEED + c,
    islands: DOCK_ISLANDS,
    start: [sx, sz, Math.atan2(berth.x - sx, berth.z - sz)],
  });
  app.ship = ship;
  ship.boardPlayer(null);           // start the cycle on deck
  const drive = makePilot(water, berth);

  let steps = 0;
  let docked = false;
  while (steps < 60 * 360) {
    steps++;
    stepWater(water, weather, DT);
    drive(ship, DT);
    ship.step(DT, app);
    if (ship.dock.state === DOCK_STATE.APPROACH && ship.dock.canDock(ship.body)) ship.tryDock();
    if (ship.dock.state === DOCK_STATE.DOCKED) { docked = true; break; }
  }
  maxSteps = Math.max(maxSteps, steps);
  sumSteps += steps;
  if (!docked) { dockFails++; continue; }

  // Settle alongside for three seconds before anybody steps off. The mooring lines take up and
  // the gangplank runs out in that time, and it is the state the player actually walks off in —
  // measuring the handoff on the single frame the state flipped would test a transient.
  for (let i = 0; i < 180; i++) {
    stepWater(water, weather, DT);
    ship.step(DT, app);
  }

  // --- ashore -------------------------------------------------------------------------
  if (!ship.disembarkPlayer()) { ashoreFails++; continue; }
  const ax = playerPos[0], ay = playerPos[1], az = playerPos[2];
  const ground = world.heightAt(ax, az);
  if (!(ground > 0.35)) { ashoreFails++; continue; }
  // Never below the terrain, never floating far above it, never in the sea.
  const dropErr = ay - ground;
  worstAshoreDrop = Math.max(worstAshoreDrop, Math.abs(dropErr));
  if (dropErr < -0.01 || dropErr > 0.6) { ashoreFails++; continue; }
  if (ship.mount !== MOUNT.ASHORE) { ashoreFails++; continue; }

  // --- back aboard --------------------------------------------------------------------
  // Walk to the head of the gangplank first, the way a player has to.
  const bp = ship.boardingPoint();
  playerPos[0] = bp.x; playerPos[1] = bp.y; playerPos[2] = bp.z;
  if (!ship.canBoard({ x: bp.x, y: bp.y, z: bp.z })) { boardFails++; continue; }
  if (!ship.boardPlayer({ x: bp.x, y: bp.y, z: bp.z })) { boardFails++; continue; }
  const l = ship.dock.playerLocal;
  const half = deckHalfWidth(l.z);
  const deckY = deckHeightAt(l.z);
  const inside = Math.abs(l.x) <= half + 1e-6
    && l.z >= DECK_Z_RANGE.aft - 1e-6 && l.z <= DECK_Z_RANGE.fore + 1e-6
    && Math.abs(l.y - deckY) < 1e-6;
  worstDeckErr = Math.max(worstDeckErr, Math.abs(l.y - deckY));
  if (!inside) { boardFails++; continue; }
  // And the world position that lands on must be clear of the sea, not in it. A quarter of a
  // metre, not zero: standing with your boots awash is not "aboard".
  const w = ship.dock.worldPlayerPos(ship.body);
  const clearance = w.y - water.heightAt(w.x, w.z);
  worstClearance = Math.min(worstClearance, clearance);
  if (clearance < 0.25) { boardFails++; continue; }
  if (ship.mount !== MOUNT.ABOARD) { boardFails++; continue; }
  cycles++;
}

console.log('  cycles completed        ' + cycles + ' / 200');
console.log('  dock failures           ' + dockFails);
console.log('  go-ashore failures      ' + ashoreFails);
console.log('  board failures          ' + boardFails);
console.log('  worst ashore drop       ' + worstAshoreDrop.toFixed(4) + ' m above ground');
console.log('  worst deck height error ' + worstDeckErr.toFixed(6) + ' m');
console.log('  worst deck clearance    ' + (Number.isFinite(worstClearance) ? worstClearance.toFixed(2) : '-') + ' m above the sea');
console.log('  mean approach           ' + (sumSteps / 200 / 60).toFixed(1) + ' s');
console.log('  longest approach        ' + (maxSteps / 60).toFixed(1) + ' s');
if (cycles !== 200) fail(`only ${cycles} of 200 dock/ashore/board cycles succeeded`);
else ok('200 of 200 dock -> ashore -> aboard cycles, no ejections');

// ===========================================================================
// 5. EXTRAS — fast travel, upgrade tiers, crew aboard
// ===========================================================================

console.log('');
console.log('=== 5. TRAVEL, UPGRADES, CREW ===');

{
  const weather = WEATHER.breezy;
  const water = makeWater(weather);
  const playerPos = [0, 0, 0];
  const app = makeApp(weather, water, playerPos);
  const ship = new ShipSystem(app, { seed: SEED, islands: DOCK_ISLANDS, start: [0, 90] });
  app.ship = ship;
  ship.boardPlayer(null);
  ship.dock.discover('palmReach');
  if (!ship.fastTravel('palmReach')) fail('fast travel refused a discovered island');
  let voyageSteps = 0;
  let heaveRange = 0;
  const startY = ship.body.pos.y;
  let minUnder = Infinity;
  while (ship.dock.state === DOCK_STATE.VOYAGE && voyageSteps < 60 * 60) {
    voyageSteps++;
    stepWater(water, weather, DT);
    ship.step(DT, app);
    heaveRange = Math.max(heaveRange, Math.abs(ship.body.pos.y - startY));
    const w = ship.dock.worldPlayerPos(ship.body);
    minUnder = Math.min(minUnder, w.y - water.heightAt(w.x, w.z));
  }
  const b = berthPose(DOCK_ISLANDS.find((i) => i.id === 'palmReach'));
  const arriveDist = Math.hypot(ship.body.pos.x - b.x, ship.body.pos.z - b.z);
  console.log('  voyage length           ' + (voyageSteps / 60).toFixed(1) + ' s');
  console.log('  arrival distance        ' + arriveDist.toFixed(1) + ' m from the berth');
  console.log('  heave during voyage     ' + heaveRange.toFixed(2) + ' m');
  console.log('  player clearance        ' + minUnder.toFixed(2) + ' m above the sea');
  if (voyageSteps >= 60 * 60) fail('fast travel never finished');
  if (arriveDist > 70) fail('fast travel arrived ' + arriveDist.toFixed(0) + ' m from the berth');
  if (heaveRange < 0.2) fail('fast travel was a slide, not a voyage — the hull never rode the swell');
  if (minUnder < 0.5) fail('the player went under during fast travel');
  else ok('fast travel is a real voyage and keeps the player on deck');
}

{
  // Upgrade tiers must visibly change the ship: more triangles for plating and guns, a bigger
  // rig for storm sails. Built with a real TextureLibrary — still no GL.
  const tex = new TextureLibrary(SEED);
  registerCommonTiles(tex);
  const reg = new BlockRegistry();
  const tiers = [
    { name: 'tier 0 (stock)', up: [] },
    { name: 'tier 1 (hull)', up: ['reinforced_hull'] },
    { name: 'tier 2 (+sails)', up: ['reinforced_hull', 'storm_sails'] },
    { name: 'tier 3 (+guns)', up: ['reinforced_hull', 'storm_sails', 'cannon_battery'] },
  ];
  console.log('');
  console.log(pad('ship', 18) + padL('hull tris', 11) + padL('sail tris', 11) + padL('cannons', 9)
    + padL('sail m2', 9) + padL('voxels', 9));
  let baseSail = 0, baseCannons = 0, baseHull = 0;
  for (const t of tiers) {
    const m = buildShipModel(tex, reg, { seed: SEED, upgrades: t.up });
    const sailTris = m.parts.sail.full.triangles + (m.parts.topsail ? m.parts.topsail.full.triangles : 0);
    console.log(pad(t.name, 18) + padL(m.hull.triangles, 11) + padL(sailTris, 11)
      + padL(m.cannons.length, 9) + padL(m.metrics.sailAreaM2.toFixed(1), 9) + padL(m.hull.voxels, 9));
    if (m.tier !== t.up.length) fail(`${t.name}: tier reported ${m.tier}`);
    if (t.up.length === 0) { baseSail = sailTris; baseCannons = m.cannons.length; baseHull = m.hull.triangles; }
    if (t.up.includes('reinforced_hull') && m.hull.triangles <= baseHull) fail(`${t.name}: plating did not change the hull`);
    if (t.up.includes('storm_sails') && sailTris <= baseSail) fail(`${t.name}: storm sails did not enlarge the rig`);
    if (t.up.includes('cannon_battery') && m.cannons.length <= baseCannons) fail(`${t.name}: the battery added no guns`);
    if (m.hull.triangles < 8000) fail(`${t.name}: hull is only ${m.hull.triangles} triangles — that is not a ship`);
    for (const key of ['sail', 'wheel', 'flag', 'anchor', 'rudder', 'gangplank']) {
      if (!m.parts[key]) fail(`${t.name}: animated part "${key}" is missing`);
    }
    if (m.buoyancy.length < 6) fail(`${t.name}: only ${m.buoyancy.length} buoyancy points`);
  }
  // Determinism of the geometry itself.
  const g1 = buildShipModel(tex, reg, { seed: SEED });
  const g2 = buildShipModel(tex, reg, { seed: SEED });
  const pa = g1.hull.geometry.getAttribute('position').array;
  const pb = g2.hull.geometry.getAttribute('position').array;
  let same = pa.length === pb.length;
  for (let i = 0; same && i < pa.length; i++) if (pa[i] !== pb[i]) same = false;
  if (!same) fail('two builds of the same ship produced different geometry');
  else ok('ship geometry is deterministic and every tier is visibly different');
}

{
  // Every recruitable crew member maps to a distinct existing archetype, and the aboard list
  // gives each one a station, a walk and an idle.
  const specIds = new Set();
  for (const c of CREW) {
    const id = CREW_ARCHETYPE[c.id];
    if (!id) { fail('crew member ' + c.id + ' has no archetype'); continue; }
    if (!CHARACTER_SPECS[id]) { fail('archetype ' + id + ' does not exist'); continue; }
    if (specIds.has(id)) fail('archetype ' + id + ' is used twice — two crew would look identical');
    specIds.add(id);
  }
  const aboard = new CrewAboard({
    seed: SEED,
    stations: {
      helm: [0, 4.75, -2.75], rigging: [1.5, 2.75, 0.5], lookout: [0, 13, 2],
      galley: [-1.5, 2.75, -1.5], repair: [1.25, 2.75, 5.5], waist: [0, 2.75, -0.5],
    },
  });
  aboard.sync(CREW.map((c) => ({ id: c.id, name: c.name, role: c.role, barks: c.barks, bonus: c.bonus })));
  const body = new SailingBody({ seed: SEED });
  const clips = new Set();
  const stationsSeen = new Set();
  const startPos = aboard.members.map((m) => [m.pos.x, m.pos.z]);
  let walked = 0;
  // 200 s of breezy, 20 s of storm (so `brace` fires), 10 s of being boarded.
  const script = [[60 * 200, WEATHER.breezy, false], [60 * 20, WEATHER.storm, false], [60 * 10, WEATHER.storm, true]];
  for (const [n, weather, combat] of script) {
    const water = makeWater(weather);
    for (let i = 0; i < n; i++) {
      stepWater(water, weather, DT);
      body.step(DT, { water, weather });
      aboard.step(DT, { body, weather, combat });
      for (const m of aboard.members) { clips.add(m.clip); stationsSeen.add(m.station); }
    }
  }
  for (let i = 0; i < aboard.members.length; i++) {
    const m = aboard.members[i];
    if (Math.hypot(m.pos.x - startPos[i][0], m.pos.z - startPos[i][1]) > 0.5) walked++;
    const half = deckHalfWidth(m.pos.z);
    if (m.station !== 'lookout' && Math.abs(m.pos.x) > half + 0.01) {
      fail(m.id + ' walked outside the bulwark at x=' + m.pos.x.toFixed(2));
    }
    if (m.pos.z < DECK_Z_RANGE.aft - 0.01 || m.pos.z > DECK_Z_RANGE.fore + 0.01) {
      fail(m.id + ' walked off the deck at z=' + m.pos.z.toFixed(2));
    }
    if (!m.anim || !m.anim.pose) fail(m.id + ' has no pose');
  }
  // Hull repair from the shipwright is a real number, applied here.
  const hull = { hp: 50, maxHp: 140 };
  aboard.applyBonuses({ sailSpeedMult: 1.12, turnRateMult: 1.18, hullRepairPerSec: 0.9 }, hull, 10);
  console.log('  crew aboard             ' + aboard.members.length);
  console.log('  distinct archetypes     ' + specIds.size);
  console.log('  stations occupied       ' + Array.from(stationsSeen).sort().join(', '));
  console.log('  clips exercised         ' + Array.from(clips).sort().join(', '));
  console.log('  members that walked     ' + walked + ' / ' + aboard.members.length);
  console.log('  sail speed bonus read   x' + aboard.bonus.sailSpeedMult.toFixed(2));
  console.log('  shipwright repaired     ' + (hull.hp - 50).toFixed(1) + ' hp in 10 s');
  if (specIds.size !== CREW.length) fail('crew archetypes are not a bijection');
  if (!clips.has('walk')) fail('no crew member ever walked between stations');
  if (!clips.has('combat')) fail('crew never reacted to being boarded');
  if (!clips.has('brace')) fail('crew never braced in a storm');
  if (stationsSeen.size < 4) fail('crew only ever used ' + stationsSeen.size + ' stations');
  if (Math.abs(hull.hp - 59) > 0.01) fail('shipwright repair applied ' + (hull.hp - 50) + ' hp, expected 9');
  if (Math.abs(aboard.bonus.sailSpeedMult - 1.12) > 1e-9) fail('sail speed bonus was not read');
}

// ===========================================================================

console.log('');
if (failures.length) {
  console.log('FAIL — ' + failures.length + ' problem(s)');
  for (const f of failures) console.log('  * ' + f);
  process.exit(1);
}
console.log('PASS — ship floats, sails, repeats, docks, and carries a crew');
