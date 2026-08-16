// Self-check for cluster C — combat, physics, telegraphs, damage, enemies.
//
// Runs headless: no browser, no GL, no three.js. A five-line world stub (flat ground at y = 0)
// and a counting FX stub are enough, because every gameplay module in cluster C is deliberately
// free of rendering imports. src/render/fx.js is the only file that touches three, and combat
// only ever talks to it through the `impact / addShake / addHitstop / setFlash` surface that the
// stub below reimplements.
//
//   node tools/check-combat.mjs [seed]
//
// What it proves, and why each one is a real defect rather than a style preference:
//
//   1. DETERMINISM      two 2000-step runs of the same 1v3 fight from the same seed must end in
//                       the same state. Capture, replay and the perf gate all depend on it.
//   2. READABILITY      every enemy attack declares a telegraph, every telegraph has a wind-up
//                       above the 0.25 s floor, a legal danger class, and the class's own colour.
//                       A sub-quarter-second wind-up is a jump-scare; a mismatched colour is a
//                       lie about which defensive option works.
//   3. ONE HIT PER SWING  a hitbox may hit a target at most once per activation, including
//                       multi-frame sweeps that sample the weapon path several times a frame.
//   4. FEEDBACK         hitstop, shake and flash fire on EVERY landed hit. Missing one turns a
//                       hit into a number changing.
//   5. NO HIT-PATH ALLOCATION  10 000 hits must not grow any pool. Allocation in the hit path is
//                       invisible in a 1v1 test and shows up as a p99 hitch in a crowd fight.
//
// Exit code 1 on any failure.

import { parseSeed } from '../src/core/rng.js';
import { PhysicsSystem, makeBody, SpatialHash, sweepBody, raycastVoxel } from '../src/core/physics.js';
import {
  HitboxPool, SHAPE, makeHit, resolveHitbox, shapeArc, shapeSweep, sweepSamplesFor, TAG,
} from '../src/combat/hitbox.js';
import {
  validateTelegraph, MIN_WINDUP, DANGER, dangerColour, dangerShape, TELEGRAPH_KIND, GROWTH,
} from '../src/combat/telegraph.js';
import { initCombatant, makeOutcome } from '../src/combat/damage.js';
import { ENEMY_ARCHETYPES, ENEMY_KIND_IDS, STATE } from '../src/entity/enemy.js';
import { CombatSystem, TEAM, PLAYER_MOVES } from '../src/combat/combat.js';
import { P } from '../src/gen/palette.js';

const SEED = parseSeed(process.argv[2] || 20260814);
const DT = 1 / 60;

const failures = [];
const fail = (msg) => { failures.push(msg); };
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const f3 = (v) => (Math.round(v * 1000) / 1000).toFixed(3);

console.log(`check-combat  seed=${SEED}\n`);

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/**
 * The FX stub. It reimplements exactly the surface combat uses, and counts. `impact` forwards to
 * the three feedback channels the same way src/render/fx.js does, so asserting on the counters
 * really is asserting on the shipped behaviour.
 */
function makeFxStub() {
  return {
    n: { impact: 0, hitstop: 0, shake: 0, flash: 0, telegraphs: 0, particles: 0, decals: 0 },
    lastHitstop: 0, lastShake: 0, lastFlashTarget: null,
    impact(o) {
      this.n.impact++;
      const stop = o.hitstop !== undefined ? o.hitstop : 0.05 + 0.05 * (o.strength || 1);
      const shake = o.shake !== undefined ? o.shake : 0.10 + 0.22 * (o.strength || 1);
      this.addHitstop(stop);
      this.addShake(shake);
      if (o.target) this.setFlash(o.target, o.crit ? P.critFlash : P.hitFlash, o.crit ? 1 : 0.85);
      this.n.particles += 12;
    },
    addHitstop(s) { if (s > 0) { this.n.hitstop++; this.lastHitstop = s; } },
    addShake(s) { if (s > 0) { this.n.shake++; this.lastShake = s; } },
    setFlash(a, c, amt) { this.n.flash++; this.lastFlashTarget = a; if (a) a.hitFlash = amt; },
    setAura(a, c, amt) { if (a) { a.aura = amt; a.auraColor = c; } },
    dissolve(a, t) { if (a) a.dissolve = t; },
    ring() { this.n.decals++; }, ringAt() { this.n.decals++; },
    quakeCrack() { this.n.decals++; }, gravityWell() { this.n.decals++; },
    dust() {}, splash() {}, speedLines() {}, levelUp() {},
    slashArc() { return null; },
    beginTrail() { return null; }, trailPoint() {}, endTrail() {},
    damageNumber() { return null; },
    telegraphs(cmds) { this.n.telegraphs += cmds.length; },
  };
}

/** A minimal app: flat ground, still water, no renderer, no UI. */
function makeApp(seed) {
  const clock = {
    simTime: 0,
    hitstop: 0,
    addHitstop(s) { this.hitstop = Math.max(this.hitstop, s); },
  };
  return {
    seed,
    clock,
    // Flat ground: everything below sea level is rock, everything above is air.
    world: { heightAt: () => 0, isSolidAt: (x, y) => y < 0 },
    water: { heightAt: () => 0, sampleHeight: (x, z, o) => { const r = o || {}; r.y = 0; return r; } },
    sky: { env: { storm: 0, night: 0 } },
    quests: { notify() {}, activeBonuses() { return null; } },
    settings: { colourblindTelegraphs: false },
    fx: makeFxStub(),
    audio: null,
    ui: null,
    input: null,
    player: null,
  };
}

/** Build a player actor: body + combatant, with the fields combat reads. */
function makePlayer() {
  const p = makeBody({ x: 0, y: 0, z: 0, radius: 0.42, height: 1.85, mass: 76 });
  p.id = 1;
  p.name = 'Player';
  initCombatant(p, { maxHp: 100, maxPoise: 55, maxStamina: 100, team: TEAM.PLAYER });
  p.intents = { attack: false, heavy: false, block: false, dodge: false };
  p.moveX = 0; p.moveZ = 0;
  p.recovery = 0;
  return p;
}

/**
 * A scripted player. Every decision is a function of the step index, so two runs make identical
 * choices — which is the only way a determinism test means anything.
 */
function drivePlayer(p, combat, step) {
  const it = p.intents;
  it.attack = (step % 23) === 0;
  it.heavy = (step % 149) === 0;
  it.block = (step % 91) < 26;
  it.dodge = (step % 113) === 0;

  // Walk toward the nearest live enemy, stopping at melee range.
  const list = combat.activeEnemies();
  let best = null, bestD = 1e9;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.dead) continue;
    const d = Math.hypot(e.x - p.x, e.z - p.z);
    if (d < bestD) { bestD = d; best = e; }
  }
  let mx = 0, mz = 0;
  if (best) {
    const dx = best.x - p.x, dz = best.z - p.z;
    const d = Math.hypot(dx, dz) || 1;
    p.yaw = Math.atan2(dx, dz);
    if (d > 2.1) { mx = dx / d; mz = dz / d; }
    else if (d < 1.4) { mx = -dx / d; mz = -dz / d; }
  }
  p.moveX = mx; p.moveZ = mz;
  const speed = 4.6 * (p.blocking ? 0.55 : 1) * (p.attacking ? 0.3 : 1);
  p.vx += (mx * speed - p.vx) * 0.35;
  p.vz += (mz * speed - p.vz) * 0.35;

  if (p.dodgeImpulse && p.dodgeImpulse.t > 0) {
    p.dodgeImpulse.t -= DT;
    p.vx = p.dodgeImpulse.x * 11;
    p.vz = p.dodgeImpulse.z * 11;
  }
  p.vy -= 26 * DT;
  sweepBody(combat.physics.solid, p, p.vx * DT, p.vy * DT, p.vz * DT);
  if (p.grounded) { const fr = Math.exp(-9 * DT); p.vx *= fr; p.vz *= fr; }
}

/** Fold the whole simulation into one string. Any divergence at all changes it. */
function stateHash(combat, p) {
  const parts = [];
  const q = (v) => Math.round(v * 4096) / 4096;
  parts.push(`P ${q(p.x)} ${q(p.y)} ${q(p.z)} ${q(p.hp)} ${q(p.stamina)} ${q(p.poise)} ${q(p.iframes)}`);
  const es = combat.activeEnemies().slice().sort((a, b) => a.id - b.id);
  for (const e of es) {
    parts.push(`E${e.id} ${e.kind} ${e.state} ${q(e.x)} ${q(e.y)} ${q(e.z)} ${q(e.yaw)} ` +
      `${q(e.hp)} ${q(e.poise)} ${e.phase} ${q(e.recoverT)} ${e.dead ? 1 : 0}`);
  }
  parts.push(`K ${combat.kills} ${combat.victories} ${combat.stats.hits} ${combat.stats.attacksStarted} ` +
    `${combat.stats.telegraphsShown} ${combat.telegraphs.live.length} ${combat.hitboxes.live.length}`);
  return parts.join('|');
}

/** Run one full 1v3 fight and return its final hash plus some observed numbers. */
function runFight(seed, steps) {
  const app = makeApp(seed);
  const physics = new PhysicsSystem(app);
  app.physics = physics;
  const combat = new CombatSystem(app, { seed, maxAttackers: 2 });
  app.combat = combat;
  const p = makePlayer();
  app.player = p;
  combat.register(p);

  combat.spawnEnemy('thug', 6, 0, 2, 1);
  combat.spawnEnemy('knifer', -5, 0, 4, 1);
  combat.spawnEnemy('marine_rifle', 1, 0, -9, 1);

  let maxConcurrentAttackers = 0;
  let telegraphedAttacks = 0;
  let untelegraphedAttacks = 0;

  for (let s = 0; s < steps; s++) {
    drivePlayer(p, combat, s);
    combat.step(DT);
    physics.step(DT);
    app.clock.simTime += DT;
    app.clock.hitstop = 0;                 // the real clock burns it down against real time

    // Nobody may be mid-strike without a telegraph having produced it.
    let attacking = 0;
    for (const e of combat.activeEnemies()) {
      if (e.state === STATE.ATTACK) {
        attacking++;
        if (combat.telegraphs.forActor(e)) telegraphedAttacks++;
        else untelegraphedAttacks++;
      }
    }
    if (attacking > maxConcurrentAttackers) maxConcurrentAttackers = attacking;

    // Keep the arena populated for the whole window. A determinism run that spends half its
    // steps on an empty field proves almost nothing, so top the field back up to three whenever
    // it thins out. The trigger is a deterministic function of state, so both runs top up on
    // exactly the same steps.
    let liveCount = 0;
    for (const e of combat.activeEnemies()) if (!e.dead) liveCount++;
    if (liveCount < 3 && s < steps - 240 && (s % 20) === 0) {
      const roster = ['thug', 'fishman', 'bomber', 'knifer', 'brute', 'captain'];
      const kind = roster[(combat.kills + liveCount) % roster.length];
      const a = (s % 360) * (Math.PI / 180);
      combat.spawnEnemy(kind, p.x + Math.sin(a) * 8, 0, p.z + Math.cos(a) * 8, 1);
    }
    if (p.dead) { p.hp = p.maxHp; p.dead = false; }   // the script is a rig, not a playthrough
  }
  return {
    hash: stateHash(combat, p),
    kills: combat.kills,
    hits: combat.stats.hits,
    attacks: combat.stats.attacksStarted,
    telegraphs: combat.stats.telegraphsShown,
    maxConcurrentAttackers,
    telegraphedAttacks,
    untelegraphedAttacks,
    fxImpacts: app.fx.n.impact,
    fxHitstops: app.fx.n.hitstop,
    fxShakes: app.fx.n.shake,
    fxFlashes: app.fx.n.flash,
  };
}

// ===========================================================================
// 1. DETERMINISM
// ===========================================================================

console.log('--- 1. determinism -------------------------------------------------');
const runA = runFight(SEED, 2000);
const runB = runFight(SEED, 2000);
const identical = runA.hash === runB.hash;
if (!identical) {
  fail('two 2000-step runs from the same seed diverged');
  // Show the first differing field, which is almost always enough to name the culprit.
  const a = runA.hash.split('|'), b = runB.hash.split('|');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) { console.log(`    first divergence at record ${i}:\n      A ${a[i]}\n      B ${b[i]}`); break; }
  }
}
// A run that produced no combat at all would pass a determinism test vacuously.
// Floors, not targets. They exist to catch a simulation that quietly stopped simulating — a
// determinism test over an empty arena passes trivially and tells you nothing.
if (runA.hits < 40) fail(`the 1v3 fight only landed ${runA.hits} hits in 2000 steps — the determinism run is vacuous`);
if (runA.attacks < 50) fail(`only ${runA.attacks} attacks were started in 2000 steps`);
if (runA.telegraphs < 25) fail(`only ${runA.telegraphs} enemy telegraphs ran in 2000 steps — the enemies are too passive to prove anything`);
if (runA.kills < 2) fail(`only ${runA.kills} enemies were defeated in 2000 steps`);

console.log(`  steps per run           2000 (x2)`);
console.log(`  final state identical   ${identical}`);
console.log(`  hits landed             ${runA.hits} / ${runB.hits}`);
console.log(`  attacks started         ${runA.attacks} / ${runB.attacks}`);
console.log(`  telegraphs shown        ${runA.telegraphs} / ${runB.telegraphs}`);
console.log(`  enemies defeated        ${runA.kills} / ${runB.kills}`);
console.log(`  max simultaneous attackers  ${runA.maxConcurrentAttackers} (budget = 2)`);
if (runA.maxConcurrentAttackers > 2) {
  fail(`the aggression budget was exceeded: ${runA.maxConcurrentAttackers} enemies attacked at once with a budget of 2`);
}
if (runA.untelegraphedAttacks > 0) {
  fail(`${runA.untelegraphedAttacks} enemy attack-state frames had no live telegraph`);
}
console.log(`  attack frames telegraphed   ${runA.telegraphedAttacks} (untelegraphed: ${runA.untelegraphedAttacks})`);

// ===========================================================================
// 2. TELEGRAPH READABILITY
// ===========================================================================

console.log('\n--- 2. telegraph readability ---------------------------------------');
const LEGAL_COLOURS = new Set([P.telegraphGuard, P.telegraphWarn, P.telegraphDanger]);
let moveCount = 0;
let minWindup = Infinity, minWindupName = '';
let maxWindup = 0;
const dangerCounts = {};
console.log(`  ${pad('archetype', 14)}${pad('move', 12)}${padL('windup', 7)}  ${pad('kind', 8)}${pad('danger', 13)}${pad('growth', 7)}colour`);
for (const kind of ENEMY_KIND_IDS) {
  const arch = ENEMY_ARCHETYPES[kind];
  if (!arch.moves || arch.moves.length === 0) fail(`${kind} declares no moves`);
  for (const m of arch.moves) {
    moveCount++;
    const t = m.telegraph;
    if (!t) { fail(`${kind}.${m.id} has no telegraph`); continue; }
    const bad = validateTelegraph(t);
    for (const b of bad) fail(`${kind}.${m.id}: ${b}`);
    if (!(t.windup > 0.25)) fail(`${kind}.${m.id}: windup ${t.windup}s is at or below the 0.25s floor`);
    if (!LEGAL_COLOURS.has(t.colour)) fail(`${kind}.${m.id}: colour is outside the telegraph triad`);
    if (t.colour !== dangerColour(t.danger)) fail(`${kind}.${m.id}: colour does not match its danger class`);
    if (t.cbShape !== dangerShape(t.danger)) fail(`${kind}.${m.id}: colourblind shape does not match its danger class`);
    if (t.windup < minWindup) { minWindup = t.windup; minWindupName = `${kind}.${m.id}`; }
    if (t.windup > maxWindup) maxWindup = t.windup;
    dangerCounts[t.danger] = (dangerCounts[t.danger] || 0) + 1;
    const cname = t.colour === P.telegraphGuard ? 'guard/cyan'
      : t.colour === P.telegraphDanger ? 'danger/red' : 'warn/orange';
    console.log(`  ${pad(kind, 14)}${pad(m.id, 12)}${padL(f3(t.windup), 7)}  ${pad(t.kind, 8)}${pad(t.danger, 13)}${pad(t.growth, 7)}${cname}`);
  }
}
console.log(`\n  archetypes              ${ENEMY_KIND_IDS.length}`);
console.log(`  attacks declared        ${moveCount}`);
console.log(`  wind-up range           ${f3(minWindup)}s .. ${f3(maxWindup)}s   (floor ${MIN_WINDUP}s, tightest: ${minWindupName})`);
console.log(`  danger classes used     ${Object.keys(dangerCounts).map((k) => `${k}=${dangerCounts[k]}`).join('  ')}`);

// Every archetype must be distinguishable by what it DOES, not only by its numbers: two
// archetypes sharing an identical telegraph vocabulary would be stat variants.
const vocab = new Map();
for (const kind of ENEMY_KIND_IDS) {
  const arch = ENEMY_ARCHETYPES[kind];
  const sig = arch.moves.map((m) => `${m.telegraph.kind}:${m.telegraph.danger}:${m.telegraph.growth}`)
    .sort().join(',');
  if (vocab.has(sig)) fail(`${kind} and ${vocab.get(sig)} share an identical telegraph vocabulary — they are stat variants, not archetypes`);
  else vocab.set(sig, kind);
}
console.log(`  distinct vocabularies   ${vocab.size} / ${ENEMY_KIND_IDS.length}`);

// The three colours must actually all be in use, or the coding scheme is decorative.
const usedColours = new Set();
for (const kind of ENEMY_KIND_IDS) {
  for (const m of ENEMY_ARCHETYPES[kind].moves) usedColours.add(m.telegraph.colour);
}
if (usedColours.size < 3) fail(`only ${usedColours.size} of the 3 telegraph colours are used by any enemy`);
console.log(`  telegraph colours in use  ${usedColours.size} / 3`);

// ===========================================================================
// 3. ONE HIT PER SWING
// ===========================================================================

console.log('\n--- 3. one hit per swing -------------------------------------------');
{
  const hash = new SpatialHash(4);
  const dummy = makeBody({ x: 2, y: 0, z: 0, radius: 0.45, height: 1.8 });
  dummy.id = 42; dummy.team = TEAM.ENEMY;
  hash.rebuild([dummy]);
  const pool = new HitboxPool(8);
  const out = [];

  // (a) a plain arc, resolved 30 times without being retired.
  //     The wedge faces +X, which is where the dummy is; an arc pointing anywhere else would
  //     legitimately miss and the test would pass for the wrong reason.
  const arc = pool.acquire(SHAPE.ARC);
  shapeArc(arc, 0, 0.9, 0, 1, 0, 3.0, 1.0, -0.3, 2.2);
  arc.duration = 0.5;
  let arcHits = 0;
  for (let i = 0; i < 30; i++) arcHits += resolveHitbox(arc, hash, null, out).length;
  if (arcHits !== 1) fail(`arc hitbox connected ${arcHits} times across 30 resolves; must be exactly 1`);
  console.log(`  arc, 30 resolves           ${arcHits} hit(s)  (expected 1)`);

  // (b) a multi-frame sweep: 8 samples per resolve, 30 resolves. Every sample overlaps the
  //     target, so a missing dedupe would report 240.
  const swp = pool.acquire(SHAPE.SWEEP);
  shapeSweep(swp, -2, 0.9, 0, -2, 0.9, 0, 0.4, 8);
  swp.duration = 0.5;
  let sweepHits = 0;
  for (let i = 0; i < 30; i++) {
    const f = i / 29;
    const x = -3 + 6 * f;
    swp.advanceTo(x, 0.9, 0, x + 0.6, 0.9, 0);
    sweepHits += resolveHitbox(swp, hash, null, out).length;
  }
  if (sweepHits !== 1) fail(`sweep hitbox connected ${sweepHits} times across 30 resolves x 8 samples; must be exactly 1`);
  console.log(`  sweep, 30 resolves x 8 samples  ${sweepHits} hit(s)  (expected 1)`);

  // (c) anti-tunnelling: a target the swing passes THROUGH between two frames must still be hit.
  const fast = pool.acquire(SHAPE.SWEEP);
  shapeSweep(fast, -6, 0.9, 0, -6, 0.9, 0.01, 0.3, sweepSamplesFor(12, 0.3));
  fast.duration = 0.5;
  fast.advanceTo(6, 0.9, 0, 6, 0.9, 0.01);       // 12 m of travel in one step, straight over it
  const tunnelHits = resolveHitbox(fast, hash, null, out).length;
  if (tunnelHits !== 1) fail(`a 12 m single-frame sweep over the target hit ${tunnelHits} time(s); it must tunnel-proof to exactly 1`);
  console.log(`  12 m single-frame sweep         ${tunnelHits} hit(s)  (expected 1, proves no tunnelling)`);

  // (d) two separate activations DO each get their hit — dedupe must be per activation.
  const a1 = pool.acquire(SHAPE.ARC);
  shapeArc(a1, 0, 0.9, 0, 1, 0, 3.0, 1.0, -0.3, 2.2);
  const n1 = resolveHitbox(a1, hash, null, out).length;
  pool.release(a1);
  const a2 = pool.acquire(SHAPE.ARC);
  shapeArc(a2, 0, 0.9, 0, 1, 0, 3.0, 1.0, -0.3, 2.2);
  const n2 = resolveHitbox(a2, hash, null, out).length;
  if (n1 !== 1 || n2 !== 1) fail(`two separate swings hit ${n1} and ${n2} times; each activation must land once`);
  console.log(`  two separate activations        ${n1} + ${n2} hit(s)  (expected 1 + 1)`);
}

// ===========================================================================
// 4. FEEDBACK ON EVERY LANDED HIT
// ===========================================================================

console.log('\n--- 4. feedback on every landed hit --------------------------------');
{
  const app = makeApp(SEED);
  const physics = new PhysicsSystem(app);
  app.physics = physics;
  const combat = new CombatSystem(app, { seed: SEED });
  const p = makePlayer();
  app.player = p;
  combat.register(p);
  const fx = app.fx;

  const cases = [
    { name: 'plain hit', setup: (t) => {} },
    { name: 'blocked', setup: (t) => { t.blocking = true; t.blockTime = 0.5; } },
    { name: 'parried', setup: (t) => { t.blocking = true; t.blockTime = 0.05; } },
    { name: 'guard broken', setup: (t) => { t.blocking = true; t.blockTime = 0.5; t.stamina = 1; } },
    { name: 'crit (backstab)', setup: (t) => { t.yaw = 0; }, dir: [0, 1] },
    { name: 'frozen shatter', setup: (t) => { t.status.frozenT = 1.5; } },
    { name: 'lethal', setup: (t) => { t.hp = 3; } },
  ];

  let checked = 0;
  for (const c of cases) {
    const e = combat.spawnEnemy('thug', 3, 0, 0, 1);
    e.hp = e.maxHp = 400;
    c.setup(e);
    const hit = makeHit({ damage: 25, poise: 5, source: p, tags: [TAG.MELEE] });
    hit.dirX = c.dir ? c.dir[0] : 1; hit.dirZ = c.dir ? c.dir[1] : 0;
    hit.px = e.x - hit.dirX * 0.4; hit.py = e.y + 1.1; hit.pz = e.z - hit.dirZ * 0.4;

    const before = { hitstop: fx.n.hitstop, shake: fx.n.shake, flash: fx.n.flash, impact: fx.n.impact };
    const o = combat.applyHit(e, hit);
    if (!o.connected) { fail(`case "${c.name}" did not connect at all`); continue; }
    checked++;
    const dHitstop = fx.n.hitstop - before.hitstop;
    const dShake = fx.n.shake - before.shake;
    const dFlash = fx.n.flash - before.flash;
    const dImpact = fx.n.impact - before.impact;
    if (dImpact < 1) fail(`case "${c.name}": no fx.impact fired`);
    if (dHitstop < 1) fail(`case "${c.name}": no hitstop fired`);
    if (dShake < 1) fail(`case "${c.name}": no screen shake fired`);
    if (dFlash < 1) fail(`case "${c.name}": no flash fired`);
    console.log(`  ${pad(c.name, 18)} dmg=${padL(f3(o.damage), 7)}  hitstop=${padL(f3(o.hitstop), 6)}s  shake=${padL(f3(o.shake), 5)}  ` +
      `impacts=${dImpact} stop=${dHitstop} shake=${dShake} flash=${dFlash}` +
      `${o.parried ? '  [parry]' : ''}${o.blocked ? '  [block]' : ''}${o.guardBroken ? '  [guard break]' : ''}` +
      `${o.crit ? '  [crit]' : ''}${o.shatter ? '  [shatter]' : ''}${o.killed ? '  [kill]' : ''}`);
    e.hp = 0; e.dead = true;
  }
  if (checked !== cases.length) fail(`only ${checked} of ${cases.length} feedback cases connected`);

  // And the whole-fight version: every landed hit in the 2000-step run produced all three.
  if (runA.fxImpacts < runA.hits) fail(`the 1v3 run landed ${runA.hits} hits but fired only ${runA.fxImpacts} impacts`);
  console.log(`  1v3 run: ${runA.hits} hits -> ${runA.fxImpacts} impacts, ${runA.fxHitstops} hitstops, ` +
    `${runA.fxShakes} shakes, ${runA.fxFlashes} flashes`);
  if (runA.fxHitstops < runA.hits) fail(`hitstop fired ${runA.fxHitstops} times for ${runA.hits} hits`);
  if (runA.fxShakes < runA.hits) fail(`shake fired ${runA.fxShakes} times for ${runA.hits} hits`);
  if (runA.fxFlashes < runA.hits) fail(`flash fired ${runA.fxFlashes} times for ${runA.hits} hits`);
}

// ===========================================================================
// 5. NO ALLOCATION IN THE HIT PATH
// ===========================================================================

console.log('\n--- 5. hit-path allocation -----------------------------------------');
{
  const app = makeApp(SEED);
  const physics = new PhysicsSystem(app);
  app.physics = physics;
  const combat = new CombatSystem(app, { seed: SEED });
  const p = makePlayer();
  app.player = p;
  combat.register(p);
  const e = combat.spawnEnemy('brute', 2.2, 0, 0, 1);
  e.hp = e.maxHp = 1e9;
  physics.step(DT);

  /** Everything that could silently grow. Snapshot, hammer, snapshot again. */
  const probe = () => ({
    hitPool: combat._hitPool.length,
    hitboxPool: combat.hitboxes.pool.length,
    hitboxLive: combat.hitboxes.live.length,
    telegraphPool: combat.telegraphs.pool.length,
    telegraphLive: combat.telegraphs.live.length,
    telegraphCmds: combat.telegraphs.commands.length,
    projectilePool: physics.projectiles.pool.length,
    projectileEnded: physics.projectiles.ended.length,
    targets: combat._targets.length,
    combatants: combat.combatants.length,
    hashCells: physics.hash.cells.size,
    outcomeKeys: Object.keys(combat._outcome).length,
    hitTags: combat._hitPool.reduce((a, h) => a + h.tags.length, 0),
    projHits: combat._projHits.length,
    // Tag arrays are rewritten in place on every spawn; if one were being appended to instead
    // of cleared, this total would climb by one per swing.
    ownHitTags: combat.hitboxes.pool.reduce((a, h) => a + h.ownHit.tags.length, 0),
    fxArgKeys: Object.keys(combat._fxArgs).length,
  });

  const before = probe();

  const hit = makeHit({ damage: 4, poise: 1, source: p, tags: [TAG.MELEE] });
  hit.dirX = 1; hit.dirZ = 0;
  const N_HITS = 10000;
  for (let i = 0; i < N_HITS; i++) {
    hit.px = e.x - 0.4; hit.py = e.y + 1.1; hit.pz = e.z;
    combat.applyHit(e, hit);
    e.hp = 1e9;                     // keep it alive; we are measuring the path, not the fight
    e.poise = e.maxPoise;
    e.stagger = 0; e.hitstun = 0; e.iframes = 0;
  }
  const afterHits = probe();

  // Now the full swing path: acquire, configure, resolve, apply, retire — 10 000 times.
  const N_SWINGS = 10000;
  const out = [];
  for (let i = 0; i < N_SWINGS; i++) {
    const hb = combat.hitboxes.acquire(SHAPE.SWEEP);
    shapeSweep(hb, p.x, 0.9, p.z, p.x + 3, 0.9, p.z, 0.4, 6);
    hb.duration = 0.1;
    hb.team = TEAM.PLAYER;
    hb.source = p;
    hb.hit = hit;
    combat._filterTeam = TEAM.PLAYER;
    const list = resolveHitbox(hb, physics.hash, combat._targetFilter, out);
    for (let k = 0; k < list.length; k++) {
      combat.applyHit(list[k], hb.hit);
      e.hp = 1e9; e.poise = e.maxPoise; e.stagger = 0; e.hitstun = 0; e.iframes = 0;
    }
    combat.hitboxes.release(hb);
  }
  const after = probe();

  let grew = 0;
  const keys = Object.keys(before);
  console.log(`  ${pad('pool', 20)}${padL('before', 8)}${padL('after 10k hits', 16)}${padL('after 10k swings', 18)}`);
  for (const k of keys) {
    const a = before[k], b = afterHits[k], c = after[k];
    const bad = c > a;
    // combatants and hash cells legitimately reflect the two live actors; everything else must
    // be flat. `hitboxLive` returning to its starting value is the real dedupe/pool proof.
    if (bad) { grew++; fail(`pool "${k}" grew from ${a} to ${c} over ${N_HITS} hits + ${N_SWINGS} swings`); }
    console.log(`  ${pad(k, 20)}${padL(a, 8)}${padL(b, 16)}${padL(c, 18)}${bad ? '   <-- GREW' : ''}`);
  }
  console.log(`  pools that grew         ${grew} / ${keys.length}`);
  console.log(`  hits applied            ${N_HITS} + ${N_SWINGS} swings (${combat.stats.hits} resolved)`);

  // The dedupe array must be reset by the pool, not merely appended to.
  let maxSeen = 0;
  for (const hb of combat.hitboxes.pool) maxSeen = Math.max(maxSeen, hb.seen.length);
  if (maxSeen > 8) fail(`a pooled hitbox retained ${maxSeen} dedupe entries; reset() must clear them`);
  console.log(`  max retained dedupe ids ${maxSeen}`);
}

// ===========================================================================
// 6. PHYSICS SANITY (step-up, DDA, arc query)
// ===========================================================================

console.log('\n--- 6. physics ------------------------------------------------------');
{
  // A single 0.5 m block in the way: an actor walking into it must step over it, not stop.
  const solidStep = (x, y, z) => (y < 0) || (x > 1 && x < 1.5 && y < 0.5);
  const b = makeBody({ x: 0, y: 0, z: 0, radius: 0.4, height: 1.8 });
  for (let i = 0; i < 60; i++) sweepBody(solidStep, b, 4 * DT, -26 * DT * DT, 0);
  const steppedOver = b.x > 1.6;
  if (!steppedOver) fail(`step-up failed: an actor walking into a 0.5 m block stopped at x=${f3(b.x)}`);
  console.log(`  walked over a 0.5 m block   x=${f3(b.x)} y=${f3(b.y)}  ${steppedOver ? 'yes' : 'NO'}`);

  // A 1.0 m wall must NOT be walked over (step-up is 0.6 m).
  const solidWall = (x, y, z) => (y < 0) || (x > 1 && x < 1.5 && y < 1.0);
  const b2 = makeBody({ x: 0, y: 0, z: 0, radius: 0.4, height: 1.8 });
  for (let i = 0; i < 60; i++) sweepBody(solidWall, b2, 4 * DT, -26 * DT * DT, 0);
  const blocked = b2.x < 1.05;
  if (!blocked) fail(`step-up over-reached: an actor climbed a 1.0 m wall to x=${f3(b2.x)}`);
  console.log(`  blocked by a 1.0 m wall     x=${f3(b2.x)}  ${blocked ? 'yes' : 'NO'}`);

  // DDA: a downward ray from 5 m must hit the ground plane at exactly 5 m.
  const r = raycastVoxel((x, y) => y < 0, 0, 5, 0, 0, -1, 0, 20, {});
  if (!r.hit || Math.abs(r.t - 5) > 1e-6) fail(`voxel DDA hit at t=${r.t}; expected exactly 5`);
  console.log(`  DDA down from y=5           hit=${r.hit} t=${f3(r.t)} normal.y=${r.ny}`);

  // Arc query: only what is inside the wedge.
  const hash = new SpatialHash(4);
  const mk = (id, x, z) => { const a = makeBody({ x, y: 0, z, radius: 0.4 }); a.id = id; return a; };
  hash.rebuild([mk(1, 0, 3), mk(2, 3, 0), mk(3, 0, -3), mk(4, 0, 1)]);
  const out = [];
  hash.queryArc(0, 0, 0, 1, 4, 0.6, out);
  const ids = out.map((a) => a.id).sort().join(',');
  if (ids !== '1,4') fail(`queryArc returned [${ids}]; expected [1,4]`);
  console.log(`  arc query (r=4, half=0.6)   returned ids [${ids}]  (expected 1,4)`);

  // The same query twice must return the same order — determinism, not just the same set.
  const out2 = [];
  hash.queryArc(0, 0, 0, 1, 4, 0.6, out2);
  if (out.map((a) => a.id).join() !== out2.map((a) => a.id).join()) {
    fail('queryArc is not order-stable across identical calls');
  }
  console.log(`  arc query order stable      yes`);
}

// ===========================================================================
// 7. ARCHETYPE BEHAVIOUR SPREAD
// ===========================================================================

console.log('\n--- 7. archetype behaviour -----------------------------------------');
console.log(`  ${pad('archetype', 14)}${padL('hp', 6)}${padL('poise', 7)}${padL('speed', 7)}${padL('moves', 7)}` +
  `${padL('tokens', 8)}${padL('aggro', 7)}${padL('minRecov', 10)}${padL('maxRecov', 10)}`);
for (const kind of ENEMY_KIND_IDS) {
  const a = ENEMY_ARCHETYPES[kind];
  let minR = Infinity, maxR = 0;
  for (const m of a.moves) { minR = Math.min(minR, m.recovery); maxR = Math.max(maxR, m.recovery); }
  console.log(`  ${pad(kind, 14)}${padL(a.stats.maxHp, 6)}${padL(a.stats.maxPoise, 7)}${padL(f3(a.speed), 7)}` +
    `${padL(a.moves.length, 7)}${padL(a.ai.tokens, 8)}${padL(a.ai.aggro, 7)}${padL(f3(minR), 10)}${padL(f3(maxR), 10)}`);
  // Every archetype must leave a punish window somewhere, or there is no counterplay.
  // A self-destructing archetype is the one exception: the bomber's punish window is its fuse,
  // which is a wind-up rather than a recovery, so it is held to a long-fuse rule instead.
  const suicide = a.moves.every((m) => m.effect === 'detonate');
  if (suicide) {
    const fuse = Math.max(...a.moves.map((m) => m.telegraph.windup));
    if (fuse < 1.0) fail(`${kind} self-destructs with only a ${fuse}s fuse — no time to react`);
  } else if (maxR < 0.3) {
    fail(`${kind}'s longest recovery is ${maxR}s — there is no punish window`);
  }
  if (a.ai.preferredMin > a.ai.preferredMax) fail(`${kind} has an inverted preferred range band`);
}

// The eight archetypes named in the brief must all exist.
const REQUIRED = ['thug', 'knifer', 'brute', 'marine_rifle', 'fishman', 'bomber', 'captain', 'admiral'];
for (const k of REQUIRED) if (!ENEMY_ARCHETYPES[k]) fail(`required archetype "${k}" is missing`);
// The admiral must have a parry-only move: parryable, guard-breaking, and arena-wide so there is
// nowhere to dodge to. That combination is the definition of "the only answer is the parry".
const sanction = ENEMY_ARCHETYPES.admiral.moves.find((m) => m.id === 'sanction');
if (!sanction) fail('the admiral has no parry-only move');
else {
  const ok = sanction.telegraph.danger === DANGER.PARRYABLE
    && sanction.tags.indexOf(TAG.GUARD_BREAK) >= 0
    && sanction.reach >= 16;
  if (!ok) fail('the admiral\'s "sanction" is not actually parry-only (needs parryable + guard-break + arena-wide)');
  console.log(`  admiral parry-only move     "${sanction.id}" windup=${f3(sanction.telegraph.windup)}s ` +
    `radius=${sanction.reach}m danger=${sanction.telegraph.danger} guardBreak=${sanction.tags.indexOf(TAG.GUARD_BREAK) >= 0}`);
}
// The captain must summon at its phase change.
const capPhase = ENEMY_ARCHETYPES.captain.phases.find((p) => p.summon);
if (!capPhase) fail('the captain does not summon at any phase');
else console.log(`  captain phase change        at ${capPhase.at * 100}% hp, summons ${capPhase.summonCount}x ${capPhase.summon}`);
console.log(`  admiral phases              ${ENEMY_ARCHETYPES.admiral.phases.length}`);

// ===========================================================================
// 8. THE FX LAYER
// ===========================================================================
//
// three.js builds BufferGeometry without a GL context, so the whole batching path — pool
// recycling, quad emission, buffer packing, draw ranges — is testable headlessly. What this
// cannot check is the shaders; what it CAN check is that the CPU side never emits NaN, never
// overruns a batch, and never grows a pool, which is where the real bugs live.

console.log('\n--- 8. fx layer -----------------------------------------------------');
{
  const THREE = await import('three');
  const { FxSystem } = await import('../src/render/fx.js');

  const app = makeApp(SEED);
  app.scene = new THREE.Scene();
  app.rootFx = new THREE.Group();
  app.scene.add(app.rootFx);
  app.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 7000);
  app.extraMaterials = [];
  delete app.fx;

  const fx = new FxSystem(app, { seed: SEED, particles: 900, decals: 120, trails: 12 });

  // Boot contract: the three FX materials must be registered for App.prewarmAll(), or they
  // compile on the first presented frame and the zero-shader-compiles gate fails.
  if (app.extraMaterials.length !== 3) {
    fail(`fx registered ${app.extraMaterials.length} materials for prewarm; expected 3`);
  }
  console.log(`  materials registered for prewarm  ${app.extraMaterials.length} ` +
    `(${app.extraMaterials.map((m) => m.name).join(', ')})`);

  // The batch geometries must carry position/normal/uv, because three's program cache key
  // includes whether `normal` exists — a batch without it silently relinks on its first draw,
  // which is exactly the failure App.prewarmAll() was written to prevent.
  for (const pair of [['particle', fx.particleBatch], ['decal', fx.decalBatch], ['ribbon', fx.ribbonBatch]]) {
    const a = pair[1].geo.attributes;
    if (!a.position || !a.normal || !a.uv) fail(`the ${pair[0]} batch is missing position/normal/uv`);
  }
  console.log('  batch attribute parity            position+normal+uv on all 3 batches');

  const before = {
    particles: fx.particles.length, decals: fx.decals.length, trails: fx.trails.length,
    pQuads: fx.particleBatch.capacity, dQuads: fx.decalBatch.capacity, rQuads: fx.ribbonBatch.capacity,
  };

  // Every impact flavour, once each.
  const KINDS = ['slash', 'stab', 'blunt', 'slam', 'explode', 'bullet', 'block', 'parry',
    'flame', 'frost', 'sand', 'quake', 'gravity', 'water', 'sanction'];
  for (const kind of KINDS) {
    fx.impact({
      pos: [0, 1.1, 0], dir: [1, 0, 0], kind, strength: 1.3,
      crit: kind === 'slash', damage: 17,
      target: { x: 0, y: 0, z: 0, height: 1.8, hitFlash: 0 },
    });
  }
  fx.levelUp(0, 0, 0);
  fx.dust(1, 0, 1, 1.5);
  fx.splash(2, 0, 2, 1.5);
  fx.speedLines(0, 0, 0, 1, 0, 1);
  fx.slashArc(0, 1, 0, 0, 1, 3, 1.1, P.hitFlash, 1);

  // A telegraph command per footprint kind, half of them in a colourblind mode.
  const cmds = [];
  const kinds = [TELEGRAPH_KIND.ARC, TELEGRAPH_KIND.LINE, TELEGRAPH_KIND.CIRCLE,
    TELEGRAPH_KIND.CONE, TELEGRAPH_KIND.POINT];
  const dangers = [DANGER.BLOCKABLE, DANGER.PARRYABLE, DANGER.DODGEABLE, DANGER.UNBLOCKABLE];
  for (let i = 0; i < kinds.length; i++) {
    const d = dangers[i % dangers.length];
    cmds.push({
      kind: kinds[i], growth: [GROWTH.FILL, GROWTH.SWEEP, GROWTH.PULSE][i % 3],
      anchor: 'self', cbShape: dangerShape(d), danger: d, colour: dangerColour(d),
      cb: i % 2 ? 'deuter' : 'off',
      x: i * 3, y: 0, z: 0, dirX: 0, dirZ: 1,
      radius: 3 + i, halfAngle: 0.9, width: 1.4,
      t: 0.5, alpha: 0.8, sustain: 0, fired: false,
      actor: { x: i * 3, y: 0, z: 0, radius: 0.45, hitFlash: 0 }, tell: 0.9,
    });
  }

  // Publish-then-step-then-build, which is the real frame order (combat publishes telegraph
  // decals during its step; fx steps after it; the buffers are packed at render time). A
  // regression that clears managed decals during step() shows up here as zero telegraph quads.
  fx.telegraphs(cmds);
  fx.step(DT);
  fx.preRender();
  if (fx.decalBatch.count < cmds.length) {
    fail(`only ${fx.decalBatch.count} decal quads were packed for ${cmds.length} live telegraphs — ` +
      'telegraph decals are being cleared before they render');
  }
  console.log(`  telegraph decals -> quads         ${cmds.length} telegraphs produced ${fx.decalBatch.count} quads`);

  let maxParticles = 0, maxDecals = 0, maxRibbons = 0;
  for (let i = 0; i < 240; i++) {
    for (let k = 0; k < cmds.length; k++) cmds[k].t = (i % 60) / 60;
    fx.telegraphs(cmds);
    fx.step(DT);
    fx.preRender();
    maxParticles = Math.max(maxParticles, fx.particleBatch.count);
    maxDecals = Math.max(maxDecals, fx.decalBatch.count);
    maxRibbons = Math.max(maxRibbons, fx.ribbonBatch.count);
    if (i === 60) fx.impact({ pos: [0, 1, 0], dir: [0, 0, 1], kind: 'explode', strength: 2, damage: 40 });
  }

  const after = {
    particles: fx.particles.length, decals: fx.decals.length, trails: fx.trails.length,
    pQuads: fx.particleBatch.capacity, dQuads: fx.decalBatch.capacity, rQuads: fx.ribbonBatch.capacity,
  };
  for (const k of Object.keys(before)) {
    if (after[k] !== before[k]) fail(`fx pool "${k}" changed size from ${before[k]} to ${after[k]}`);
  }

  // No NaN anywhere in the packed buffers. One NaN position destroys an entire draw call.
  let nan = 0;
  for (const batch of [fx.particleBatch, fx.decalBatch, fx.ribbonBatch]) {
    const n = batch.count * 12;
    for (let i = 0; i < n; i++) if (!Number.isFinite(batch.pos[i])) nan++;
    for (const key of Object.keys(batch.extra)) {
      const arr = batch.extra[key];
      const at = batch.geo.attributes[key];
      const m = batch.count * 4 * at.itemSize;
      for (let i = 0; i < m; i++) if (!Number.isFinite(arr[i])) nan++;
    }
  }
  if (nan > 0) fail(`${nan} non-finite values were packed into the fx vertex buffers`);

  // Overflow: ask for five times the pool and confirm it recycles rather than growing or
  // writing past the end of the batch.
  for (let i = 0; i < 5000; i++) {
    fx.emit(0, i * 0.01, 1, 0, 1, 1, 1, P.hitFlash, 0.1, 0.02, 0.5, 2, 1, 0, 1);
  }
  fx.step(DT);
  fx.preRender();
  if (fx.particleBatch.count > fx.particleBatch.capacity) {
    fail(`the particle batch emitted ${fx.particleBatch.count} quads into a ${fx.particleBatch.capacity}-quad buffer`);
  }
  if (fx.particles.length !== before.particles) fail('the particle pool grew under overflow');

  console.log(`  pools (particles/decals/trails)   ${after.particles} / ${after.decals} / ${after.trails}  (unchanged)`);
  console.log(`  peak quads per frame              particles=${maxParticles}/${before.pQuads}  ` +
    `decals=${maxDecals}/${before.dQuads}  ribbon=${maxRibbons}/${before.rQuads}`);
  console.log(`  non-finite values in buffers      ${nan}`);
  console.log(`  after 5000-particle overflow      batch=${fx.particleBatch.count}/${fx.particleBatch.capacity}, pool ${fx.particles.length}`);
  console.log('  draw calls for ALL fx             3 (particles, decals, ribbons)');

  // Shake must be budgeted: 200 maximal requests in one step cannot exceed full trauma, and it
  // must decay back to nothing.
  fx.shake.trauma = 0;
  for (let i = 0; i < 200; i++) fx.addShake(1);
  const peak = fx.shake.trauma;
  if (peak > 1.0001) fail(`the shake budget let trauma reach ${peak}`);
  for (let i = 0; i < 120; i++) fx.step(DT);
  if (fx.shake.trauma > 0.001) fail(`shake did not decay: trauma is still ${fx.shake.trauma}`);
  console.log(`  200 max shakes in one step        trauma peaked at ${f3(peak)} (cap 1.0), decayed to ${f3(fx.shake.trauma)}`);

  // Hitstop must be budgeted the same way, or a crowd fight becomes a slideshow.
  let stopTotal = 0;
  const clock = app.clock;
  for (let i = 0; i < 60; i++) { clock.hitstop = 0; fx.addHitstop(0.12); stopTotal += clock.hitstop; }
  if (stopTotal > 60 * 0.12 * 0.5) fail(`the hitstop budget granted ${f3(stopTotal)}s across 60 back-to-back requests`);
  console.log(`  60 back-to-back hitstops          granted ${f3(stopTotal)}s total (unbudgeted: ${f3(60 * 0.12)}s)`);

  fx.dispose();
}


// ===========================================================================

console.log('\n=== RESULT ===');
if (failures.length === 0) {
  console.log('PASS — determinism, readability, dedupe, feedback and allocation all clean.');
} else {
  console.log(`FAIL — ${failures.length} problem(s):`);
  for (const f of failures) console.log('  * ' + f);
  process.exit(1);
}
