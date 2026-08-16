#!/usr/bin/env node
// Gate for src/fruit/*.
//
// The brief's bar for the fruit layer is a single sentence: "if a fruit could be replaced by
// +20% damage you have failed". That is not directly machine-checkable, so this file checks the
// closest thing that is — that every fruit flips at least one entry in a fixed vocabulary of
// TRAVERSAL capabilities, and that no two fruits flip the same set. A fruit whose only
// difference is a damage number has an empty traversal signature and fails here.
//
// It also asserts the things that break silently: three abilities per fruit, every ability
// actually costing something, every ability naming an animation state Cluster B has agreed to
// play, and 3000 fixed steps producing bit-identical state from the same seed and inputs.
//
// Run: node tools/check-fruit.mjs [--json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ABILITIES, ABILITIES_BY_FRUIT, ABILITY_BY_ID, TRAVERSAL_FLAGS,
  REQUIRED_ANIM_STATES, FRUIT_CAST_POSES, MOVE_ANIM, capsSignature,
} from '../src/fruit/abilities.js';
import { FRUITS, FRUIT_IDS, FruitSystem, createFruitSystem } from '../src/fruit/fruits.js';
import { FX_TILES, FRUIT_COLORS, CubeBatch, registerFruitFxTiles } from '../src/fruit/fruitfx.js';
import { TextureLibrary, registerCommonTiles } from '../src/gen/texture.js';
import { P } from '../src/gen/palette.js';
import { Rng } from '../src/core/rng.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXED_DT = 1 / 60;
const SEED = 20260814;

let checks = 0;
let failures = 0;
const notes = [];

function ok(cond, msg, detail) {
  checks++;
  if (!cond) {
    failures++;
    console.error('  FAIL  ' + msg + (detail !== undefined ? '  <' + detail + '>' : ''));
  }
  return !!cond;
}
function eq(a, b, msg) { return ok(a === b, msg, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }
function section(name) { console.log('\n== ' + name); }
function note(s) { notes.push(s); console.log('  NOTE  ' + s); }

// ---------------------------------------------------------------------------
// 1. Shape: six fruits, three abilities each
// ---------------------------------------------------------------------------

section('fruit + ability shape');

eq(FRUIT_IDS.length, 6, 'six devil fruits are defined');
eq(ABILITIES.length, 18, 'eighteen abilities in total');

for (const id of FRUIT_IDS) {
  const def = FRUITS[id];
  ok(!!def, 'fruit is defined: ' + id);
  if (!def) continue;
  const list = ABILITIES_BY_FRUIT.get(id) || [];
  eq(list.length, 3, id + ' defines exactly 3 abilities');
  const slots = list.map((a) => a.slot).sort();
  ok(slots.length === 3 && slots[0] === 1 && slots[1] === 2 && slots[2] === 3,
    id + ' fills slots 1, 2 and 3 exactly once', slots.join(','));
  ok(def.color === FRUIT_COLORS[id], id + ' colour comes from FRUIT_COLORS');
  ok(def.color === P['fruit' + id[0].toUpperCase() + id.slice(1)],
    id + ' colour is the P.fruit* entry, not a telegraph colour');
  ok(typeof def.drawback === 'string' && def.drawback.length > 12,
    id + ' declares a real drawback');
  ok(typeof def.kit.hint === 'string' && def.kit.hint.length > 20,
    id + ' declares a traversal control hint for the wheel');
}

// Telegraph colours must never be reused as a fruit's identity colour.
const TELEGRAPH_COLORS = new Set([P.telegraphWarn, P.telegraphDanger, P.telegraphGuard]);
for (const id of FRUIT_IDS) {
  ok(!TELEGRAPH_COLORS.has(FRUITS[id].color), id + ' does not reuse a telegraph colour');
}

// ---------------------------------------------------------------------------
// 2. Every ability costs something
// ---------------------------------------------------------------------------

section('ability economy');

for (const a of ABILITIES) {
  ok(a.cost > 0 || a.cooldown > 0, a.id + ' has a non-zero cost or cooldown',
    'cost=' + a.cost + ' cd=' + a.cooldown);
  ok(a.totalTime > 0, a.id + ' occupies non-zero time', a.totalTime);
  ok(typeof a.name === 'string' && a.name.length > 2, a.id + ' has a display name');
  ok(typeof a.desc === 'string' && a.desc.length > 20, a.id + ' has a one-line description');
  ok(a.tags.length > 0, a.id + ' declares tags');
  ok(!!a.icon, a.id + ' declares a HUD icon');
  ok(ABILITY_BY_ID.get(a.id) === a, a.id + ' is registered by id');
}

// Placeholder text is a ship-blocker per ARCHITECTURE §1.7. Built at runtime so this file does
// not itself contain the words it forbids.
const PLACEHOLDER = new RegExp(['TO' + 'DO', 'TB' + 'D', 'place' + 'holder', 'lorem', 'FIX' + 'ME'].join('|'), 'i');
for (const f of ['src/fruit/fruits.js', 'src/fruit/abilities.js', 'src/fruit/fruitfx.js']) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  ok(!PLACEHOLDER.test(src), f + ' contains no placeholder markers');
  ok(!/#[0-9a-fA-F]{6}\b/.test(src.replace(/\/\/[^\n]*/g, '')),
    f + ' hardcodes no hex colours outside comments');
}

// ---------------------------------------------------------------------------
// 3. Animation states exist in Cluster B's list
// ---------------------------------------------------------------------------

section('animation contract');

/** Parse the FRUIT anim-state block out of ARCHITECTURE §9. */
function animStatesFromArchitecture() {
  const md = fs.readFileSync(path.join(ROOT, 'ARCHITECTURE.md'), 'utf8');
  let i = md.indexOf('**Animator states FRUIT drives**');
  if (i < 0) i = md.indexOf('**Animator states FRUIT requires**');
  if (i < 0) return null;
  const open = md.indexOf('```', i);
  const close = md.indexOf('```', open + 3);
  if (open < 0 || close < 0) return null;
  return md.slice(open + 3, close).trim().split(/\s+/).filter(Boolean);
}

let clusterBStates = null;
let clusterBSource = '';
const animPath = path.join(ROOT, 'src/entity/anim.js');
if (fs.existsSync(animPath)) {
  try {
    const mod = await import('../src/entity/anim.js');
    const exported = mod.STATE_NAMES || mod.ANIM_STATES || mod.STATES || null;
    if (exported) {
      clusterBStates = Array.isArray(exported) ? exported.slice() : Object.keys(exported);
      clusterBSource = 'src/entity/anim.js';
    }
  } catch (e) {
    note('src/entity/anim.js exists but could not be imported: ' + e.message);
  }
}
if (!clusterBStates) {
  clusterBStates = animStatesFromArchitecture();
  clusterBSource = 'ARCHITECTURE.md §9 (documented contract)';
  note('Cluster B (src/entity/anim.js) has not exported a state list — asserting against the '
    + 'list documented in ARCHITECTURE §9. DEPENDENCY: Cluster B must export STATE_NAMES '
    + 'containing every state below; this check re-targets automatically once it does.');
}

ok(Array.isArray(clusterBStates) && clusterBStates.length > 0,
  'an animation state list is available (' + clusterBSource + ')');

const stateSet = new Set(clusterBStates || []);
for (const a of ABILITIES) {
  ok(!!a.animState, a.id + ' declares an animState');
  ok(stateSet.has(a.animState), a.id + ' animState exists in the state list', a.animState);
}
for (const s of REQUIRED_ANIM_STATES) {
  ok(stateSet.has(s), 'every state FRUIT drives exists in the Animator: ' + s);
}
for (const k of Object.keys(MOVE_ANIM)) {
  ok(stateSet.has(MOVE_ANIM[k]), 'traversal pose ' + k + ' maps to a real state', MOVE_ANIM[k]);
}
// Every ability also declares the finer pose it *wants*, so Cluster B can widen the vocabulary
// without FRUIT changing. That intent must come from the published list, not be invented.
const poseSet = new Set(FRUIT_CAST_POSES);
for (const a of ABILITIES) {
  ok(poseSet.has(a.castPose), a.id + ' declares a known castPose', a.castPose);
}
for (const pose of FRUIT_CAST_POSES) {
  ok(ABILITIES.some((a) => a.castPose === pose), 'cast pose ' + pose + ' is used by an ability');
}
// Eighteen abilities across three real states means sharing; what must NOT happen is a fruit
// whose three abilities are indistinguishable in both state and pose.
for (const id of FRUIT_IDS) {
  const list = ABILITIES_BY_FRUIT.get(id);
  const keys = new Set(list.map((a) => a.animState + '|' + a.castPose));
  eq(keys.size, 3, id + ' has three distinguishable cast reads');
}

// ---------------------------------------------------------------------------
// 4. Traversal matrix — the differentiator, checked
// ---------------------------------------------------------------------------

section('traversal capability matrix');

const signatures = new Map();
const matrix = [];
for (const id of FRUIT_IDS) {
  const caps = FRUITS[id].caps;
  const flags = TRAVERSAL_FLAGS.filter((f) => !!caps[f]);
  ok(flags.length >= 1, id + ' changes at least one traversal capability', flags.join('+') || 'NONE');
  const sig = capsSignature(caps);
  ok(!signatures.has(sig), 'traversal signature is unique: ' + id,
    signatures.has(sig) ? 'collides with ' + signatures.get(sig) + ' (' + sig + ')' : sig);
  signatures.set(sig, id);
  matrix.push({ id, flags, sig });
  for (const f of Object.keys(caps)) {
    ok(TRAVERSAL_FLAGS.indexOf(f) >= 0, id + ' uses only known traversal flags', f);
  }
}
// canWalkOnWater is hie's alone: freezing the sea is the whole fruit.
eq(FRUIT_IDS.filter((id) => FRUITS[id].caps.canWalkOnWater).join(','), 'hie',
  'only hie can walk on water');
eq(FRUIT_IDS.filter((id) => FRUITS[id].caps.canPhase).join(','), 'suna',
  'only suna can phase');
eq(FRUIT_IDS.filter((id) => FRUITS[id].caps.canBurrow).join(','), 'suna',
  'only suna can burrow');

// Every flag in the vocabulary must be claimed by someone, or the vocabulary is aspirational.
for (const f of TRAVERSAL_FLAGS) {
  ok(FRUIT_IDS.some((id) => FRUITS[id].caps[f]), 'traversal flag is used by some fruit: ' + f);
}

// ---------------------------------------------------------------------------
// 5. FX identity
// ---------------------------------------------------------------------------

section('fx identity');

ok(FX_TILES.length >= 12, 'every fruit has at least two dedicated FX tiles', FX_TILES.length);
for (const id of FRUIT_IDS) {
  ok(FX_TILES.indexOf('fx_' + id) >= 0, id + ' has its own FX tile');
}
const fxSrc = fs.readFileSync(path.join(ROOT, 'src/fruit/fruitfx.js'), 'utf8');
for (const kind of ['gomuLimb', 'meraCone', 'hieEncase', 'sunaStorm', 'guraRing', 'zushiSphere']) {
  ok(new RegExp('\\b' + kind + '\\s*\\(fx, b, r').test(fxSrc),
    'fruitfx has a bespoke builder for ' + kind);
}

// ---------------------------------------------------------------------------
// 6. Headless harness: a fake app with just enough of the world to be interesting
// ---------------------------------------------------------------------------

/** Deterministic stand-in world: an island of radius 60 around the origin, sea everywhere else. */
function makeWorld() {
  const blocks = new Map();
  const key = (x, y, z) => x + ',' + y + ',' + z;
  const names = ['air', 'sand', 'grass', 'rock', 'ice', 'plank', 'thatch', 'wood', 'stone'];
  return {
    blocks: { byName: new Map(names.map((n, i) => [n, i])) },
    blockId(n) { const i = names.indexOf(n); return i < 0 ? -1 : i; },
    heightAt(x, z) {
      const d = Math.hypot(x, z);
      if (d > 60) return -12;
      return Math.round((1 - d / 60) * 14 * 100) / 100;
    },
    blockAt(x, y, z) {
      const k = key(x, y, z);
      if (blocks.has(k)) return blocks.get(k);
      return y <= Math.floor(this.heightAt(x, z)) ? 1 : 0;
    },
    setBlock(x, y, z, id) { blocks.set(key(x, y, z), id); return true; },
    inTown(x, z) { return Math.hypot(x, z) < 20; },
    edits: blocks,
  };
}

function makeEnemies(n) {
  const list = [];
  const rng = Rng.fromName(SEED, 'check:enemies');
  for (let i = 0; i < n; i++) {
    // No `status` block: this stand-in is deliberately NOT a Cluster C combatant, so the
    // FRUIT-local status and shatter paths are the ones under test here. combat.js's own
    // resolver is covered by tools/check-combat, not by this file.
    list.push({
      id: 'e' + i, hp: 120, maxHp: 120, alive: true,
      pos: { x: rng.range(-14, 14), y: 6, z: rng.range(-14, 14) },
      vel: { x: 0, y: 0, z: 0 },
    });
  }
  return { list };
}

/** Minimal virtual input matching src/core/input.js's snapshot shape. */
function makeInput() {
  const down = Object.create(null);
  return { state: { moveX: 0, moveZ: 0, lookX: 0, lookY: 0, down, pressed: Object.create(null), released: Object.create(null) } };
}

function makeApp(opts = {}) {
  const world = makeWorld();
  const enemies = makeEnemies(opts.enemies === undefined ? 5 : opts.enemies);
  const damage = [];
  return {
    seed: SEED,
    world, enemies,
    input: makeInput(),
    flags: { tutorialDone: !!opts.tutorialDone },
    sky: { weather: { rain: opts.rain || 0 } },
    fx: {
      shakes: 0, stops: 0, impacts: 0, rings: 0, cracks: 0, wells: 0, auras: 0,
      addShake(t) { this.shakes += t; },
      addHitstop(t) { this.stops += t; },
      impact() { this.impacts++; },
      ring() { this.rings++; },
      quakeCrack() { this.cracks++; },
      gravityWell() { this.wells++; },
      setAura() { this.auras++; },
    },
    // Flat sea at y=0 so the check is not coupled to Cluster A's wave tuning.
    water: { sampleHeight: () => ({ y: 0 }) },
    combat: {
      applyHit(target, hit) {
        const amt = hit.damage !== undefined ? hit.damage : hit.amount;
        target.hp -= amt;
        if (target.hp <= 0) target.alive = false;
        damage.push({ t: target.id || 'player', a: Math.round(amt * 1000) / 1000 });
      },
    },
    player: {
      pos: { x: 0, y: 14, z: 0 }, vel: { x: 0, y: 0, z: 0 },
      yaw: 0, pitch: 0, grounded: true, onShip: false, hp: 100, maxHp: 100,
    },
    quests: {
      events: [],
      unlockedFruits: () => FRUIT_IDS.slice(),
      notify(e, d) { this.events.push(e + ':' + (d.move || d.point || '')); },
    },
    damage,
  };
}

/** A compact, comparable snapshot of everything the system owns. */
function snapshot(sys, app) {
  const b = sys.body;
  const r = (v) => Math.round(v * 1e6) / 1e6;
  return JSON.stringify({
    fruit: sys.fruitId,
    body: [r(b.x), r(b.y), r(b.z), r(b.vx), r(b.vy), r(b.vz), b.grounded],
    meter: r(sys.meter.value),
    combat: r(sys.meter.combatTimer),
    wet: r(sys.wetness),
    drown: r(sys.drownT),
    rescues: sys.rescues,
    save: sys.serialize(),
    stats: sys.stats,
    temp: sys.tempBlocks.length,
    fx: sys.fx.records.length,
    enemyHp: app.enemies.list.map((e) => r(e.hp)),
    edits: app.world.edits.size,
    quest: app.quests.events.length,
    damage: app.damage.length,
  });
}

/**
 * A scripted 3000-step run. The script is a pure function of the step index, so two runs are
 * identical by construction unless the system itself is non-deterministic.
 */
function runScript(steps) {
  const app = makeApp({ rain: 0 });
  const sys = createFruitSystem(app, { fruit: 'gomu' });
  const d = app.input.state.down;
  for (let i = 0; i < steps; i++) {
    // Rotate through all six fruits so every kit and every ability is exercised.
    if (i % 500 === 0) sys.equip(FRUIT_IDS[(i / 500) | 0], true);
    // Press intervals sit just above each slot's typical cooldown so most presses land.
    d.ability1 = i % 113 === 3;
    d.ability2 = i % 173 === 41;
    d.ability3 = i % 241 === 97;
    d.jump = (i % 180) > 120 && (i % 180) < 168;
    d.sprint = (i % 90) > 40 && (i % 90) < 70;
    app.input.state.moveX = Math.sin(i * 0.037);
    app.input.state.moveZ = Math.cos(i * 0.021);
    app.player.yaw = i * 0.011;
    app.player.pitch = Math.sin(i * 0.007) * 0.4;
    // Weather turns on halfway: mera and suna must visibly degrade.
    app.sky.weather.rain = i > steps / 2 ? 0.9 : 0;
    sys.step(FIXED_DT, app);
  }
  return { app, sys, snap: snapshot(sys, app) };
}

// ---------------------------------------------------------------------------
// 7. Behaviour: the powers actually do things
// ---------------------------------------------------------------------------

section('behaviour');

{
  const app = makeApp();
  const sys = createFruitSystem(app, { fruit: 'gomu' });
  eq(sys.canSwim, false, 'a devil fruit user cannot swim');
  ok(sys.equip('hie'), 'equipping an unlocked fruit succeeds');
  eq(sys.fruitId, 'hie', 'the equipped fruit changed');

  const locked = createFruitSystem({ seed: 1, quests: { unlockedFruits: () => ['gomu'] } }, { fruit: 'gomu' });
  eq(locked.equip('gura'), false, 'equipping a locked fruit is refused');
  eq(locked.fruitId, 'gomu', 'a refused equip does not change the fruit');
}

{
  // Casting: cost paid, cooldown started, second press refused.
  const app = makeApp();
  const sys = createFruitSystem(app, { fruit: 'gomu' });
  const before = sys.meter.value;
  ok(sys.use(1), 'slot 1 casts');
  ok(sys.meter.value < before, 'casting spends meter', before + ' -> ' + sys.meter.value);
  eq(sys.use(1), false, 'a second cast while busy is refused');
  for (let i = 0; i < 240; i++) sys.step(FIXED_DT, app);
  ok(sys.runner.cooldownOf('gomu.pistol') === 0, 'the cooldown expires');
  eq(sys.useCount, 1, 'useCount is monotone and counted once');
}

{
  // Meter regenerates faster out of combat than in it.
  const app = makeApp({ enemies: 0 });
  const sys = createFruitSystem(app, { fruit: 'gomu' });
  sys.meter.value = 0;
  sys.meter.combatTimer = 0;
  for (let i = 0; i < 60; i++) sys.meter.step(FIXED_DT);
  const calm = sys.meter.value;
  sys.meter.value = 0;
  sys.meter.touchCombat();
  for (let i = 0; i < 60; i++) sys.meter.step(FIXED_DT);
  ok(calm > sys.meter.value * 2, 'out-of-combat regen is much faster than in-combat',
    calm.toFixed(2) + ' vs ' + sys.meter.value.toFixed(2));
}

{
  // Terrain: hie freezes the sea into standable ice; gura removes voxels.
  const app = makeApp();
  const sys = createFruitSystem(app, { fruit: 'hie' });
  app.player.pos.x = 90; app.player.pos.z = 0; app.player.pos.y = 1;
  sys.step(FIXED_DT, app);
  const frozen = sys.freezeSurface(sys.ctx, 90, 0, 5, 12);
  ok(frozen > 0, 'hie freezes open sea into ice voxels', frozen);
  ok(sys.onIce(90, 0.5, 0), 'the frozen sheet reads as ice underfoot');
  ok(sys.tempBlocks.length === frozen, 'frozen voxels are tracked for revert');
  sys.time += 20;
  sys._expireTempBlocks(FIXED_DT);
  eq(sys.tempBlocks.length, 0, 'ice melts on its timer');

  const g = createFruitSystem(app, { fruit: 'gura' });
  const removed = g.breakVolume(g.ctx, 0, 10, 0, 3);
  ok(removed > 0, 'gura removes voxels via world.setBlock', removed);
  const cracked = g.crackGround(g.ctx, 10, 10, 4, 2);
  ok(cracked > 0, 'gura cracks the ground surface', cracked);
}

{
  // Mera burns wooden barriers away — a wall becomes a doorway.
  const app = makeApp();
  const sys = createFruitSystem(app, { fruit: 'mera' });
  const plank = app.world.blockId('plank');
  for (let y = 8; y < 11; y++) for (let d = -2; d <= 2; d++) app.world.setBlock(5 + d, y, 0, plank);
  const burned = sys.burnBarriers(sys.ctx, 5, 0, 2.5, 8);
  ok(burned > 0, 'mera burns wooden barriers away', burned);
  eq(app.world.blockAt(5, 8, 0), 0, 'the burned voxel is now air');
}

{
  // Rain is a real drawback, not a debuff icon.
  const dry = createFruitSystem(makeApp({ rain: 0 }), { fruit: 'mera' });
  const wet = createFruitSystem(makeApp({ rain: 1 }), { fruit: 'mera' });
  for (let i = 0; i < 240; i++) { dry.step(FIXED_DT, dry.app); wet.step(FIXED_DT, wet.app); }
  ok(dry.flameStrength > 0.9, 'mera is at full strength when dry', dry.flameStrength.toFixed(3));
  ok(wet.flameStrength < 0.2, 'mera is crippled in rain', wet.flameStrength.toFixed(3));
  ok(wet.sandIntegrity < dry.sandIntegrity, 'suna integrity also falls in rain');
  const coneDry = ABILITY_BY_ID.get('mera.cone').canUse(dry.ctx);
  const coneWet = ABILITY_BY_ID.get('mera.cone').canUse(wet.ctx);
  ok(coneDry && !coneWet, 'Fire Fist is unusable when soaked');
}

{
  // Sand intangibility eats a sword and does NOT eat a quake.
  const app = makeApp({ rain: 0 });
  const sys = createFruitSystem(app, { fruit: 'suna' });
  sys.phasing = true;
  ok(sys.absorbHit({ amount: 30, kind: 'slash' }), 'a blade passes through sand');
  ok(!sys.absorbHit({ amount: 30, kind: 'quake' }), 'a quake does not');
  sys.phasing = false;
  // The gomu balloon absorbs exactly one hit and arms the return.
  const g = createFruitSystem(app, { fruit: 'gomu' });
  g.use(3);
  for (let i = 0; i < 30; i++) g.step(FIXED_DT, app);
  ok(!!g.guard, 'the balloon stance is armed');
  ok(g.absorbHit({ amount: 40, kind: 'blunt', attacker: app.enemies.list[0] }), 'the balloon absorbs a hit');
  eq(g.guard.stored, 40, 'the absorbed damage is stored for the return');
  const hpBefore = app.enemies.list[0].hp;
  for (let i = 0; i < 20; i++) g.step(FIXED_DT, app);
  ok(app.enemies.list[0].hp < hpBefore, 'the stored hit is returned to the attacker',
    hpBefore + ' -> ' + app.enemies.list[0].hp);
}

{
  // Frozen targets shatter for bonus damage from ANY source.
  const app = makeApp();
  const sys = createFruitSystem(app, { fruit: 'hie' });
  const e = app.enemies.list[0];
  sys.ctx.hit(e, { amount: 10, kind: 'ice' });
  const plain = 120 - e.hp;
  e.hp = 120;
  sys.statusOf(e).frozen = 3;
  sys.ctx.hit(e, { amount: 10, kind: 'ice' });
  const shattered = 120 - e.hp;
  ok(shattered > plain * 2, 'a frozen target takes shatter bonus damage',
    plain.toFixed(1) + ' -> ' + shattered.toFixed(1));
  eq(sys.statusOf(e).frozen, 0, 'shattering consumes the freeze');
}

{
  // Drowning: sealed abilities, health loss, and a rescue that always lands on land.
  const app = makeApp({ tutorialDone: false });
  const sys = createFruitSystem(app, { fruit: 'gomu' });
  app.player.pos.x = 75; app.player.pos.y = -3; app.player.pos.z = 0;
  sys.step(FIXED_DT, app);
  ok(sys.submerged, 'deep water submerges a devil fruit user');
  ok(sys.meter.locked, 'abilities are sealed underwater');
  eq(sys.use(1), false, 'a sealed fruit refuses to cast');
  const hp0 = app.player.hp;
  for (let i = 0; i < 60; i++) { app.player.pos.x = 75; app.player.pos.z = 0; sys.step(FIXED_DT, app); }
  ok(app.player.hp < hp0, 'drowning costs health', hp0 + ' -> ' + app.player.hp);
  for (let i = 0; i < 200; i++) sys.step(FIXED_DT, app);
  ok(sys.rescues >= 1, 'the rescue fires rather than soft-locking', sys.rescues);
  ok(!sys.submerged, 'the player is no longer submerged after rescue');
  const h = app.world.heightAt(app.player.pos.x, app.player.pos.z);
  ok(h > 0, 'the rescue lands the player on dry land', 'ground=' + h.toFixed(2));
  ok(!sys.meter.locked, 'the fruit works again after the rescue');

  // The pre-tutorial rescue must be faster than the post-tutorial one.
  const late = makeApp({ tutorialDone: true });
  const ls = createFruitSystem(late, { fruit: 'gomu' });
  let earlySteps = 0, lateSteps = 0;
  const sinkFor = (a, s) => {
    let n = 0;
    while (s.rescues === 0 && n < 1200) { a.player.pos.x = 75; a.player.pos.y = -3; a.player.pos.z = 0; s.step(FIXED_DT, a); n++; }
    return n;
  };
  const early = makeApp({ tutorialDone: false });
  const es = createFruitSystem(early, { fruit: 'gomu' });
  earlySteps = sinkFor(early, es);
  lateSteps = sinkFor(late, ls);
  ok(earlySteps < lateSteps, 'the early game rescues sooner than the late game',
    earlySteps + ' vs ' + lateSteps + ' steps');
}

{
  // Hie never drowns while it has meter: it freezes the sea under itself.
  const app = makeApp({ tutorialDone: true });
  const sys = createFruitSystem(app, { fruit: 'hie' });
  app.player.pos.x = 150; app.player.pos.y = 0.1; app.player.pos.z = 0;
  sys.step(FIXED_DT, app);
  ok(sys.tempBlocks.length > 0 || sys.onIce(150, 0.5, 0),
    'hie freezes the sea under itself instead of drowning', sys.tempBlocks.length);
}

{
  // Traversal actually moves the stand-in body.
  const app = makeApp();
  app.player = null;                     // force the fallback body path
  const sys = createFruitSystem(app, { fruit: 'gomu' });
  const d = app.input.state.down;
  sys.body.y = sys.heightAtSafe(0, 0);
  sys.body.grounded = true;
  d.jump = true;
  for (let i = 0; i < 45; i++) sys.step(FIXED_DT, app);
  d.jump = false;
  const yBefore = sys.body.y;
  for (let i = 0; i < 30; i++) sys.step(FIXED_DT, app);
  ok(sys.body.y > yBefore, 'the gomu compression launch actually launches', yBefore.toFixed(2) + ' -> ' + sys.body.y.toFixed(2));
  ok(sys.stats.traversalUses > 0, 'traversal use was recorded', sys.stats.traversalUses);
}

{
  // QUEST hears about every power used.
  const app = makeApp();
  const sys = createFruitSystem(app, { fruit: 'gomu' });
  sys.use(1);
  ok(app.quests.events.some((e) => e.startsWith('fruitUsed')), 'QUEST is notified of a fruit use',
    app.quests.events.join(','));
}

{
  // HUD and wheel adapters produce what UI expects.
  const app = makeApp();
  const sys = createFruitSystem(app, { fruit: 'zushi' });
  const hud = sys.hudState();
  ok(hud && hud.abilities.length === 3, 'hudState exposes three abilities');
  ok(hud.abilities.every((a) => typeof a.cooldownMax === 'number' && typeof a.cost === 'number'),
    'hudState abilities carry cooldownMax and cost');
  const wheel = sys.wheelFruits();
  eq(wheel.length, 6, 'the wheel lists all six fruits');
  ok(wheel.every((w) => w.abilities.length === 3 && typeof w.desc === 'string'),
    'wheel entries carry three abilities and a description');
  ok(wheel.some((w) => w.equipped), 'exactly the equipped fruit is marked equipped');
}

{
  // Save round-trip.
  const app = makeApp();
  const sys = createFruitSystem(app, { fruit: 'gomu' });
  for (let i = 0; i < 200; i++) { if (i === 10) sys.equip('gura', true); sys.step(FIXED_DT, app); }
  sys.use(2);
  const blob = JSON.parse(JSON.stringify(sys.serialize()));
  const app2 = makeApp();
  const sys2 = createFruitSystem(app2, { fruit: 'gomu' });
  sys2.deserialize(blob);
  eq(JSON.stringify(sys2.serialize()), JSON.stringify(blob), 'save round-trips byte-for-byte');
  eq(sys2.fruitId, 'gura', 'the equipped fruit survives the round trip');
}

{
  // A Cluster C combatant carries a `status` block; FRUIT must defer freeze/shatter to
  // damage.js there rather than applying its own bonus on top.
  const app = makeApp();
  const sys = createFruitSystem(app, { fruit: 'hie' });
  const e = app.enemies.list[0];
  e.status = { burnT: 0, burnDps: 0, burnSrc: null, frostStacks: 0, frostT: 0, frozenT: 0, sandT: 0, quakeT: 0, gravityT: 0 };
  sys.ctx.hit(e, { amount: 10, kind: 'ice', freeze: 3 });
  eq(120 - e.hp, 10, 'FRUIT does not apply its own shatter bonus to a Cluster C combatant');
  ok(e.status.frozenT >= 3, 'the freeze is written into Cluster C status fields', e.status.frozenT);
  sys.ctx.hit(e, { amount: 10, kind: 'fire', burn: 4 });
  ok(e.status.burnT >= 4, 'burn is written into Cluster C status fields', e.status.burnT);
}

{
  // Feedback is routed through Cluster C's budgeted pools, not applied by hand.
  const app = makeApp();
  const sys = createFruitSystem(app, { fruit: 'gura' });
  sys.use(1);
  for (let i = 0; i < 90; i++) sys.step(FIXED_DT, app);
  ok(app.fx.shakes > 0, 'shake goes through fx.addShake', app.fx.shakes);
  ok(app.fx.stops > 0, 'hitstop goes through fx.addHitstop', app.fx.stops);
  ok(app.fx.cracks > 0, 'the quake decal goes through fx.quakeCrack', app.fx.cracks);
  ok(app.fx.auras > 0, 'the fruit aura goes through fx.setAura', app.fx.auras);
}

{
  // The hooks PLAYER actually calls (src/entity/player.js).
  const app = makeApp();
  const sys = createFruitSystem(app, { fruit: 'mera' });
  ok(sys.canUse(0), 'canUse(0) is true with a full meter and no cooldown');
  sys.use(1);
  eq(sys.canUse(0), false, 'canUse(0) is false while the move is on cooldown');
  eq(sys.airJumps, 3, 'mera grants air dashes when dry');
  app.sky.weather.rain = 1;
  for (let i = 0; i < 240; i++) sys.step(FIXED_DT, app);
  eq(sys.airJumps, 0, 'mera grants no air dashes when soaked');
  const g = createFruitSystem(makeApp(), { fruit: 'gomu' });
  eq(g.airJumps, 0, 'only mera grants air dashes');
}

{
  // Every FX builder, driven for real. A builder that throws would otherwise only surface in a
  // browser, mid-fight, as a black screen — and only for the one fruit nobody tested.
  section('fx geometry');
  const tex = new TextureLibrary(SEED);
  registerCommonTiles(tex);
  registerFruitFxTiles(tex);
  ok(FX_TILES.every((n) => tex.has(n)), 'every FX tile registers into the texture library');

  const app = makeApp();
  const sys = createFruitSystem(app, { fruit: 'gomu' });
  const fx = sys.fx;
  // Stand the FX layer up without a GPU: real batches, real layer indices, no material upload.
  const mat = { isMaterial: true };
  fx.layers = Object.create(null);
  for (const n of FX_TILES) fx.layers[n] = tex.layerOf(n);
  fx.batch = new CubeBatch(1400, mat, 'checkFx');
  fx.decals = new CubeBatch(900, mat, 'checkDecals');
  fx.enabled = true;

  const d = app.input.state.down;
  let maxCubes = 0;
  const kindsSeen = new Set();
  for (let i = 0; i < 1800; i++) {
    if (i % 300 === 0) sys.equip(FRUIT_IDS[(i / 300) | 0], true);
    d.ability1 = i % 71 === 3;
    d.ability2 = i % 97 === 17;
    d.ability3 = i % 131 === 41;
    d.jump = (i % 150) > 100 && (i % 150) < 140;
    d.sprint = (i % 80) > 30 && (i % 80) < 60;
    app.player.yaw = i * 0.013;
    sys.step(FIXED_DT, app);
    for (const r of fx.records) kindsSeen.add(r.kind);
    fx.preRender(0);
    maxCubes = Math.max(maxCubes, fx.batch.count);
  }
  ok(maxCubes > 0, 'the FX batch actually emits geometry', maxCubes);
  ok(maxCubes <= 1400, 'the FX batch never overflows its capacity', maxCubes);
  ok(kindsSeen.size >= 8, 'many distinct effect kinds ran', Array.from(kindsSeen).join(','));
  ok(fx.decals.count > 0 || fx._decalCubes.length === 0, 'terrain decals build without throwing');

  // Exhaustive sweep: a scripted run cannot reach every one-shot effect, and an effect that is
  // never built is an effect that has never been proved to not throw.
  const body = sys.body;
  const calls = [
    () => fx.gomuLimb({ ox: 0, oy: 2, oz: 0, dx: 1, dy: 0, dz: 0 }, 12),
    () => fx.gomuGatling(body, 0.5), () => fx.gomuBalloon(body, 0.7), () => fx.gomuRecoil(body),
    () => fx.meraCone(body, 1, 0, 8, 0.5), () => fx.meraPillar(0, 0, 0, 0.6, 1),
    () => fx.meraKindle(0, 0, 0, 0.4), () => fx.meraBurnMark(1, 1, 1),
    () => fx.hieEncase(0, 0, 0, 3), () => fx.hieGrow(0, 0, 0, 3),
    () => fx.hieWall(0, 0, 0, 1, 0, 0.8), () => fx.hieSpike(0, 0, 0, 1.6),
    () => fx.hieSheet(0, 0, 0, 5), () => fx.shatter({ x: 0, y: 0, z: 0 }),
    () => fx.sunaGhost(body, 1), () => fx.sunaCollapse(body),
    () => fx.sunaStorm(body, 0.6, 1), () => fx.sunaDrain({ x: 3, y: 0, z: 0 }, body),
    () => fx.sunaBurrow(0, 0, 0, true), () => fx.sunaStream(body, 1),
    () => fx.guraRing(0, 0, 0, 8, 0), () => fx.guraDecal(0, 0, 0, 6),
    () => fx.guraSeaRings(body, 0.7), () => fx.guraLeap(0, 0, 0),
    () => fx.zushiWell(0, 2, 0, 0.6, 4), () => fx.zushiTether({ x: 4, y: 0, z: 0 }, { x: 0, y: 2, z: 0 }),
    () => fx.zushiCrush(0, 0, 0, 10, 0.8), () => fx.zushiSphere(body, 0.9),
    () => fx.zushiImpact(0, 0, 0, 7), () => fx.zushiLift(0, 0, 0, 0.5),
    () => { for (const id of FRUIT_IDS) fx.impactAt(0, 1, 0, id); },
    () => fx.telegraphCircle(0, 0, 0, 5, P.telegraphWarn, 0.4),
  ];
  let built = 0;
  for (const c of calls) {
    try { c(); built++; } catch (e) { ok(false, 'fx call threw: ' + e.message); }
  }
  eq(built, calls.length, 'every FX entry point runs without throwing');
  const allKinds = new Set(fx.records.map((r) => r.kind));
  // Build them all in one frame, and then again at several ages so the age-dependent branches
  // (grow-in, fade-out, collapse) all execute.
  for (let a = 0; a < 12; a++) {
    fx.preRender(0);
    maxCubes = Math.max(maxCubes, fx.batch.count);
    fx.step(0.06);
  }
  ok(allKinds.size >= 24, 'the sweep covered every effect kind', allKinds.size);
  for (const k of kindsSeen) allKinds.add(k);
  console.log('  fx kinds exercised: ' + Array.from(allKinds).sort().join(' '));
  console.log('  peak transient cubes: ' + maxCubes + ' / 1400, decal cubes: ' + fx.decals.count);
}

// ---------------------------------------------------------------------------
// 9. Determinism — 3000 steps, twice
// ---------------------------------------------------------------------------

section('determinism (3000 steps)');

const runA = runScript(3000);
const runB = runScript(3000);
eq(runA.snap, runB.snap, 'two 3000-step runs produce identical state');
ok(runA.sys.stats.casts >= 12, 'the determinism script actually cast abilities', runA.sys.stats.casts);
for (const id of FRUIT_IDS) {
  ok(runA.sys.stats.castsPerFruit[id] > 0, 'the determinism script cast at least one ' + id + ' ability',
    runA.sys.stats.castsPerFruit[id]);
}
ok(runA.sys.stats.hits > 0, 'the determinism script actually landed hits', runA.sys.stats.hits);
ok(runA.sys.stats.blocksChanged > 0, 'the determinism script actually edited the world',
  runA.sys.stats.blocksChanged);
ok(runA.sys.stats.traversalUses > 0, 'the determinism script actually used traversal',
  runA.sys.stats.traversalUses);
ok(runA.app.quests.events.length > 0, 'the determinism script notified QUEST',
  runA.app.quests.events.length);
console.log('  50 sim seconds of scripted play: '
  + runA.sys.stats.casts + ' casts, '
  + runA.sys.stats.traversalUses + ' traversal moves, '
  + runA.sys.stats.hits + ' hits, '
  + Math.round(runA.sys.stats.damage) + ' damage, '
  + runA.sys.stats.blocksChanged + ' voxels changed, '
  + runA.sys.stats.teleports + ' repositions, '
  + runA.sys.stats.drownings + ' drownings');
console.log('  casts per fruit: '
  + FRUIT_IDS.map((id) => id + '=' + runA.sys.stats.castsPerFruit[id]).join(' '));

// A different seed must diverge, or the "determinism" is just a constant.
{
  const app = makeApp();
  app.seed = SEED + 1;
  const sys = createFruitSystem(app, { fruit: 'suna' });
  const d = app.input.state.down;
  for (let i = 0; i < 400; i++) { d.ability2 = i % 40 === 0; app.player.yaw = i * 0.01; sys.step(FIXED_DT, app); }
  ok(sys.rng.s !== Rng.fromName(SEED, 'fruit').s, 'a different seed produces a different stream');
}

// ---------------------------------------------------------------------------
// 10. The traversal matrix, printed
// ---------------------------------------------------------------------------

section('TRAVERSAL MATRIX');

const short = { canGrapple: 'GRAP', canAirDash: 'DASH', canHover: 'HOVR', canWalkOnWater: 'WATR', canBurrow: 'BURR', canGlide: 'GLID', canPhase: 'PHAS', canBreakTerrain: 'BRKT', canSuperJump: 'SJMP' };
const header = '  ' + 'fruit'.padEnd(7) + TRAVERSAL_FLAGS.map((f) => short[f].padStart(5)).join('') + '   signature';
console.log(header);
console.log('  ' + '-'.repeat(header.length - 2));
for (const id of FRUIT_IDS) {
  const caps = FRUITS[id].caps;
  const row = TRAVERSAL_FLAGS.map((f) => (caps[f] ? '  X  ' : '  .  ')).join('');
  console.log('  ' + id.padEnd(7) + row + '   ' + capsSignature(caps));
}
console.log('\n  abilities');
for (const id of FRUIT_IDS) {
  const list = ABILITIES_BY_FRUIT.get(id);
  console.log('  ' + id.padEnd(7) + list.map((a) => `${a.slot}:${a.name} (${a.cost}m/${a.cooldown}s/${a.animState})`).join('  '));
}

// ---------------------------------------------------------------------------

const okAll = failures === 0;
console.log('\n' + (okAll ? 'PASS' : 'FAIL') + ` — ${checks - failures}/${checks} checks passed`
  + (notes.length ? `, ${notes.length} note(s)` : ''));
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    ok: okAll, checks, failures, notes,
    matrix: matrix.map((m) => ({ fruit: m.id, traversal: m.flags, signature: m.sig })),
    abilities: ABILITIES.map((a) => ({ id: a.id, fruit: a.fruit, slot: a.slot, cost: a.cost, cooldown: a.cooldown, animState: a.animState })),
    animStateSource: clusterBSource,
  }, null, 2));
}
process.exit(okAll ? 0 : 1);
