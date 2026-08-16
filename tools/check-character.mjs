// Self-check for Cluster B — rig, animation and camera feel.
//
// Runs headless (no GL): the texture library paints into plain byte arrays, the mesher only
// builds THREE.BufferGeometry, and the rig is a THREE object graph. None of that needs a
// context, so this is a fast, honest gate that runs in CI and on a laptop.
//
//   node tools/check-character.mjs [seed]
//
// What it asserts, and why each one is a real defect if it fails:
//
//   1. Rig hierarchy. Four different archetypes (different heights, torso widths, identity
//      elements, weapons and extras) build a root -> hips -> torso -> {head -> hat, arms}
//      hierarchy whose node positions come from the spec's pivots. A wrong parent shows up as
//      a hand that does not move with its arm.
//   2. No NaN. Every joint of every state over 2 simulated seconds. One NaN propagates into a
//      matrix and the whole character vanishes.
//   3. Motion. Every one of the 41 states changes the pose over its own duration. A state that
//      does not move is a state that was never written.
//   4. Silhouette. Every state departs from the archetype's bind pose by a real amount, which
//      is what ART_BAR §1 means by "the silhouette must survive being filled with flat black".
//   5. Attack sub-phases. windup + active + recovery === duration, exactly, for every attack,
//      because Cluster C opens hitboxes off those numbers.
//   6. Determinism. The same state played twice from the same seed produces bit-identical
//      poses, including the stateful secondary-motion layer.
//   7. Camera. Springs converge, never snap, and never end up under the terrain.
//
// Exit code 1 on any failure.

import * as THREE from 'three';
import { TextureLibrary, registerCommonTiles } from '../src/gen/texture.js';
import { buildBlocks } from '../src/gen/blocks.js';
import { parseSeed } from '../src/core/rng.js';
import { CHARACTER_SPECS, buildCharacter } from '../src/gen/charmodel.js';
import { P } from '../src/gen/palette.js';
import { makeActorMaterial } from '../src/render/materials.js';
import { Rig } from '../src/entity/rig.js';
import {
  Animator, createStates, STATE_NAMES, STATE_META, ATTACK_TIMINGS, JOINTS,
  makePose, copyPose, poseToArray, poseIsFinite, poseDelta, attackPhase, REF_HEIGHT,
} from '../src/entity/anim.js';
import { GameCamera, CAMERA_MODES } from '../src/render/camera.js';

const SEED = parseSeed(process.argv[2] || 20260814);
const DT = 1 / 60;
const SIM_SECONDS = 2;
const STEPS = Math.round(SIM_SECONDS / DT);

/** Four archetypes chosen to differ in every dimension the rig has to cope with. */
const SPEC_IDS = ['hero_captain', 'crew_navigator', 'marine_captain', 'fishman_raider'];

/** A state must depart from its own first frame by at least this much across its window. */
const MIN_MOTION = 0.02;
/** A state must depart from the bind pose by at least this much to read as a new silhouette. */
const MIN_SILHOUETTE = 0.05;
/** Attack sub-phases must sum to the duration within this. */
const TIMING_EPS = 1e-9;

const failures = [];
const fail = (msg) => { failures.push(msg); };
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : String(v));

// ---------------------------------------------------------------------------
// Build the four rigs
// ---------------------------------------------------------------------------

const tex = new TextureLibrary(SEED);
registerCommonTiles(tex);
const { reg } = buildBlocks(tex);
// A real actor material, not a stand-in: the effect setters below have to prove they write the
// uniforms that src/render/materials.js ACTOR_FRAG actually reads.
const actorMat = makeActorMaterial(null, null, { name: 'check-actor' });

console.log('=== CLUSTER B SELF-CHECK ===  seed ' + SEED
  + ', ' + STATE_NAMES.length + ' states, ' + STEPS + ' steps/state @ ' + DT.toFixed(5) + 's');
console.log('');

console.log('--- RIGS ---');
console.log(pad('archetype', 17) + padL('h(m)', 7) + padL('hipY', 7) + padL('parts', 6)
  + padL('nodes', 6) + padL('depth', 7) + padL('capR', 8) + padL('handR|dy|', 12) + padL('tris', 8));

const rigs = [];
for (const id of SPEC_IDS) {
  const spec = CHARACTER_SPECS[id];
  if (!spec) { fail(`spec ${id} missing from CHARACTER_SPECS`); continue; }
  const built = buildCharacter(tex, reg, spec, SEED);
  const rig = new Rig(null, built, { material: actorMat, name: id });
  rigs.push({ id, spec, built, rig });

  // --- hierarchy assertions ---
  const expectParent = {
    torso: 'hips', head: 'torso', armL: 'torso', armR: 'torso',
    legL: 'hips', legR: 'hips', hat: 'head', weapon: 'armR',
  };
  for (const key of Object.keys(expectParent)) {
    const node = rig.nodes[key];
    if (!node) {
      if (key === 'hat' || key === 'weapon') continue;    // optional parts
      fail(`${id}: rig has no node "${key}"`);
      continue;
    }
    const want = expectParent[key];
    const parentName = want === 'hips' ? 'hips' : want;
    if (node.parent !== rig.nodes[parentName]) {
      fail(`${id}: node "${key}" parented to "${node.parent && node.parent.name}", expected "${parentName}"`);
    }
    // The node's local position must equal (its pivot - its parent's pivot) from the spec.
    const parts = built.parts;
    const pp = parentName === 'hips' ? [0, built.hipY, 0] : parts[parentName].pivot;
    const want3 = [
      parts[key].pivot[0] - pp[0], parts[key].pivot[1] - pp[1], parts[key].pivot[2] - pp[2],
    ];
    const b = node.userData.bindPos;
    const err = Math.max(Math.abs(b.x - want3[0]), Math.abs(b.y - want3[1]), Math.abs(b.z - want3[2]));
    if (err > 1e-9) fail(`${id}: node "${key}" bind position off by ${err}`);
  }

  // --- depth of the hierarchy: root -> hips -> torso -> head -> hat is 5 levels ---
  let depth = 0;
  let n = rig.nodes.hat || rig.nodes.head;
  while (n) { depth++; n = n.parent; }

  // --- attachment points and bounds ---
  rig.root.updateWorldMatrix(true, true);
  const hr = rig.worldPointOf('handR', new THREE.Vector3());
  const chest = rig.worldPointOf('chest', new THREE.Vector3());
  const head = rig.worldPointOf('head', new THREE.Vector3());
  const feet = rig.worldPointOf('feet', new THREE.Vector3());
  for (const [nm, v] of [['handR', hr], ['chest', chest], ['head', head], ['feet', feet]]) {
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
      fail(`${id}: worldPointOf('${nm}') is not finite`);
    }
  }
  if (!(head.y > chest.y && chest.y > feet.y)) {
    fail(`${id}: attachment points out of order (feet ${f3(feet.y)}, chest ${f3(chest.y)}, head ${f3(head.y)})`);
  }
  const bounds = rig.bounds();
  if (!(bounds.radius > 0.1 && bounds.radius < built.height * 0.5)) {
    fail(`${id}: capsule radius ${f3(bounds.radius)} is not sane for height ${f3(built.height)}`);
  }
  if (Math.abs(bounds.height - built.height) > 1e-9) fail(`${id}: capsule height != character height`);

  // --- shader effect setters actually write uniforms ---
  // setFlash takes (colour, strength), matching setAura/setTint. The reversed order here
  // was the stale half of the black-silhouette bug: it kept reporting FAIL after the fix.
  rig.setFlash(P.hitFlash, 0.5);
  rig.setAura(P.fruitHie, 0.7);
  rig.setDissolve(0.25);
  rig.setTint(P.fruitMera, 0.4);
  const u = actorMat.uniforms;
  if (u.uFlash.value !== 0.5) fail(`${id}: setFlash did not write uFlash`);
  if (Math.abs(u.uAura.value - 0.7) > 1e-9) fail(`${id}: setAura did not write uAura`);
  if (Math.abs(u.uDissolve.value - 0.25) > 1e-9) fail(`${id}: setDissolve did not write uDissolve`);
  if (Math.abs(u.uTint.value - 0.4) > 1e-9) fail(`${id}: setTint did not write uTint`);
  rig.clearEffects();
  if (u.uFlash.value !== 0 || u.uAura.value !== 0 || u.uDissolve.value !== 0 || u.uTint.value !== 0) {
    fail(`${id}: clearEffects left an effect on`);
  }

  let tris = 0;
  for (const k of Object.keys(built.parts)) {
    const g = built.parts[k].geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  }

  console.log(pad(id, 17) + padL(f3(built.height), 7) + padL(f3(built.hipY), 7)
    + padL(Object.keys(built.parts).length, 6) + padL(Object.keys(rig.nodes).length, 6)
    + padL(depth, 7) + padL(f3(bounds.radius), 8)
    + padL(f3(Math.abs(hr.y - feet.y)), 12) + padL(tris, 8));
}
console.log('');

// ---------------------------------------------------------------------------
// Attack timing data
// ---------------------------------------------------------------------------

console.log('--- ATTACK SUB-PHASES (combat reads these) ---');
console.log(pad('state', 15) + padL('windup', 8) + padL('active', 8) + padL('recover', 9)
  + padL('sum', 11) + padL('duration', 10) + padL('err', 11) + padL('cancel', 9) + padL('reach', 8));
for (const name of Object.keys(ATTACK_TIMINGS)) {
  const a = ATTACK_TIMINGS[name];
  const sum = a.windup + a.active + a.recovery;
  const err = Math.abs(sum - a.duration);
  if (err > TIMING_EPS) fail(`${name}: windup+active+recovery (${sum}) != duration (${a.duration}), err ${err}`);
  if (!(a.windup > 0 && a.active > 0 && a.recovery > 0)) fail(`${name}: a sub-phase is not positive`);
  if (!(a.cancel > a.windup + a.active && a.cancel < a.duration)) {
    fail(`${name}: cancel window ${a.cancel} must open after the active frames and before the end`);
  }
  // The phase lookup must agree with the table at every sample.
  for (let i = 0; i <= 40; i++) {
    const t = (a.duration * i) / 40;
    const p = attackPhase(name, t);
    const want = t < a.windup ? 'windup'
      : t < a.windup + a.active ? 'active'
        : t < a.duration ? 'recovery' : 'done';
    if (p.phase !== want) fail(`${name}: attackPhase(${f3(t)}) = ${p.phase}, expected ${want}`);
    if (!(p.k >= 0 && p.k <= 1.0000001)) fail(`${name}: attackPhase k out of range at t=${f3(t)}`);
  }
  console.log(pad(name, 15) + padL(a.windup.toFixed(3), 8) + padL(a.active.toFixed(3), 8)
    + padL(a.recovery.toFixed(3), 9) + padL(sum.toFixed(6), 11) + padL(a.duration.toFixed(3), 10)
    + padL(err.toExponential(1), 11) + padL(a.cancel.toFixed(3), 9) + padL(a.reach.toFixed(2), 8));
}
console.log('');

// ---------------------------------------------------------------------------
// Every state, on every rig
// ---------------------------------------------------------------------------

/**
 * Drive one animator through one state for SIM_SECONDS, recording pose statistics.
 * The gait phase is advanced by the caller because in the real game the *actor* owns it —
 * that is what keeps footfalls coherent across a walk-to-run crossfade.
 */
function runState(anim, name, opts = {}) {
  anim.reset();
  anim.play(name, { restart: true });
  const meta = STATE_META[name];
  const window = Math.min(SIM_SECONDS, meta.loop ? SIM_SECONDS : meta.duration);
  const samples = [];
  const scratch = makePose();
  let prev = null;
  let maxStep = 0;         // largest change between consecutive frames, inside the window
  let range = 0;           // largest departure from the first frame
  let finite = true;
  let events = 0;
  const onAny = () => { events++; };
  for (const e of ['footstep', 'swing', 'land', 'cast', 'dodge', 'hurt', 'stroke', 'grab',
    'telegraph', 'parry', 'blocked', 'cheer', 'point', 'death', 'end']) anim.on(e, onAny);

  let phase = opts.phase0 !== undefined ? opts.phase0 : 0;
  let first = null;
  for (let i = 0; i < STEPS; i++) {
    const t = i * DT;
    phase = (phase + (opts.phaseRate !== undefined ? opts.phaseRate : 1.35) * DT) % 1;
    const pose = anim.update(DT, {
      speed: opts.speed !== undefined ? opts.speed : 6,
      speedN: 0.5,
      phase,
      turnRate: Math.sin(t * 2.1) * 1.6,
      grounded: opts.grounded !== undefined ? opts.grounded : true,
      inWater: !!opts.inWater,
      vy: opts.vy !== undefined ? opts.vy : 0,
    });
    if (!poseIsFinite(pose)) { finite = false; break; }
    const arr = poseToArray(pose).slice();
    samples.push(arr);
    if (t <= window + 1e-9) {
      if (!first) { first = copyPose(makePose(), pose); }
      if (prev) maxStep = Math.max(maxStep, poseDelta(prev, pose));
      range = Math.max(range, poseDelta(first, pose));
      prev = copyPose(prev || makePose(), pose);
    }
  }
  anim.off();
  return { samples, maxStep, range, finite, events, window };
}

/** Per-state context overrides so each state is exercised in the situation it exists for. */
const CTX_FOR = {
  jump_air: { grounded: false, vy: 8 },
  fall: { grounded: false, vy: -12 },
  land_hard: { vy: -22 },
  land_soft: { vy: -6 },
  swim_idle: { inWater: true, speed: 0.3 },
  swim_stroke: { inWater: true, speed: 5 },
  climb: { speed: 2, grounded: false },
  idle: { speed: 0 },
  idle_combat: { speed: 0 },
  sit: { speed: 0 },
  talk: { speed: 0 },
  point: { speed: 0 },
  cheer: { speed: 0 },
  ship_idle: { speed: 0 },
  ship_steer: { speed: 0 },
  block_idle: { speed: 0 },
  death: { speed: 0 },
  knockdown: { speed: 0 },
  getup: { speed: 0 },
};

console.log('--- STATES (2.000 s each, ' + STEPS + ' steps) ---');
console.log(pad('state', 15) + padL('dur', 7) + padL('loop', 5) + padL('cyc', 4)
  + padL('window', 8) + padL('max/frame', 11) + padL('range', 9) + padL('sil-vs-bind', 13)
  + padL('events', 8) + padL('determ', 8));

let worstMotion = Infinity, worstMotionState = '';
let worstSil = Infinity, worstSilState = '';
let totalSamples = 0;
let nanCount = 0;
let detOk = 0;

// The bind pose of the hero, used as the "rest" reference for the silhouette departure test.
const heroRig = rigs[0];
const bindAnim = new Animator({
  seed: SEED, height: heroRig.built.height, bind: heroRig.spec.pose, states: createStates(),
});
bindAnim.play('idle', { restart: true });
const bindPose = copyPose(makePose(), bindAnim.states.idle.update(0, bindAnim.ctx, makePose()));

for (const name of STATE_NAMES) {
  const meta = STATE_META[name];
  const opts = CTX_FOR[name] || {};

  // Run on every rig; the numbers reported are from the hero, but a NaN on any archetype fails.
  let hero = null;
  for (const r of rigs) {
    const anim = new Animator({
      seed: SEED, height: r.built.height, bind: r.spec.pose, states: createStates(),
    });
    const res = runState(anim, name, opts);
    totalSamples += res.samples.length;
    if (!res.finite) { nanCount++; fail(`${r.id}/${name}: produced a non-finite pose`); }
    if (res.range < MIN_MOTION) {
      fail(`${r.id}/${name}: no motion (max departure from frame 0 is ${res.range.toExponential(2)} < ${MIN_MOTION})`);
    }
    if (res.maxStep <= 0) fail(`${r.id}/${name}: the pose never changed between two frames`);
    // The pose must also survive being pushed through the rig without producing a bad matrix.
    r.rig.setTransform(3, 1.5, -2, 0.7);
    const last = makePose();
    copyPose(last, anim.pose);
    r.rig.setPose(last);
    r.rig.root.updateWorldMatrix(true, true);
    for (const jn of JOINTS) {
      const node = r.rig.nodes[jn];
      if (!node) continue;
      const e = node.matrixWorld.elements;
      for (let i = 0; i < 16; i++) {
        if (!Number.isFinite(e[i])) { fail(`${r.id}/${name}: node ${jn} world matrix has NaN`); break; }
      }
    }
    if (r === rigs[0]) hero = res;
  }

  // --- silhouette departure from the archetype's bind pose ---
  const sil = Math.max(...hero.samples.slice(0, Math.max(2, Math.round(hero.window / DT))).map((arr) => {
    const p = makePose();
    // rebuild a pose object from the flat array to reuse poseDelta
    let i = 0;
    for (let k = 0; k < 3; k++) { p.rootPos[k] = arr[i++]; p.rootRot[k] = arr[i++]; p.rootScale[k] = arr[i++]; }
    for (const jn of JOINTS) {
      const j = p.j[jn];
      for (let k = 0; k < 3; k++) { j.r[k] = arr[i++]; j.p[k] = arr[i++]; }
    }
    return poseDelta(bindPose, p);
  }));
  if (sil < MIN_SILHOUETTE) {
    fail(`${name}: does not change the silhouette (max departure from bind pose ${f3(sil)} < ${MIN_SILHOUETTE})`);
  }

  // --- determinism: same seed, same state, twice ---
  const a1 = new Animator({ seed: SEED, height: heroRig.built.height, bind: heroRig.spec.pose, states: createStates() });
  const a2 = new Animator({ seed: SEED, height: heroRig.built.height, bind: heroRig.spec.pose, states: createStates() });
  const r1 = runState(a1, name, opts);
  const r2 = runState(a2, name, opts);
  let identical = r1.samples.length === r2.samples.length;
  if (identical) {
    outer: for (let i = 0; i < r1.samples.length; i++) {
      const x = r1.samples[i], y = r2.samples[i];
      for (let k = 0; k < x.length; k++) {
        if (x[k] !== y[k]) { identical = false; break outer; }
      }
    }
  }
  if (!identical) fail(`${name}: two runs from the same seed diverged`);
  else detOk++;

  if (hero.range < worstMotion) { worstMotion = hero.range; worstMotionState = name; }
  if (sil < worstSil) { worstSil = sil; worstSilState = name; }

  console.log(pad(name, 15) + padL(meta.duration.toFixed(2), 7) + padL(meta.loop ? 'y' : 'n', 5)
    + padL(meta.cyclic ? 'y' : 'n', 4) + padL(hero.window.toFixed(2), 8)
    + padL(hero.maxStep.toExponential(2), 11) + padL(f3(hero.range), 9)
    + padL(f3(sil), 13) + padL(hero.events, 8) + padL(identical ? 'ok' : 'DIVERGED', 8));
}
console.log('');

// ---------------------------------------------------------------------------
// Crossfade: no pop, no NaN, weights land exactly on 1
// ---------------------------------------------------------------------------

console.log('--- CROSSFADES ---');
const fadePairs = [
  ['idle', 'walk', 0.16], ['walk', 'run', 0.16], ['run', 'sprint', 0.16],
  ['sprint', 'jump_launch', 0.06], ['jump_air', 'land_hard', 0.06],
  ['idle_combat', 'attack_1', 0.04], ['attack_1', 'attack_2', 0.04],
  ['attack_3', 'dodge_roll', 0.05], ['block_idle', 'parry', 0.05],
  ['idle', 'death', 0.10],
];
console.log(pad('from -> to', 30) + padL('blendS', 8) + padL('max/frame', 12) + padL('finite', 8));
for (const [from, to, blend] of fadePairs) {
  const anim = new Animator({
    seed: SEED, height: heroRig.built.height, bind: heroRig.spec.pose, states: createStates(),
  });
  anim.play(from, { restart: true });
  let phase = 0;
  for (let i = 0; i < 30; i++) {
    phase = (phase + 1.35 * DT) % 1;
    anim.update(DT, { phase, speed: 6, grounded: true, turnRate: 0 });
  }
  const before = copyPose(makePose(), anim.pose);
  anim.blendTo(to, blend);
  let worst = 0, ok = true;
  let prev = before;
  const cur = makePose();
  for (let i = 0; i < Math.round(0.5 / DT); i++) {
    phase = (phase + 1.35 * DT) % 1;
    const p = anim.update(DT, { phase, speed: 6, grounded: true, turnRate: 0 });
    if (!poseIsFinite(p)) { ok = false; break; }
    copyPose(cur, p);
    worst = Math.max(worst, poseDelta(prev, cur));
    copyPose(prev, cur);
  }
  if (!ok) fail(`crossfade ${from} -> ${to}: non-finite pose`);
  if (anim.blend < 1) fail(`crossfade ${from} -> ${to}: blend never reached 1 (${anim.blend})`);
  console.log(pad(from + ' -> ' + to, 30) + padL(blend.toFixed(2), 8)
    + padL(worst.toExponential(2), 12) + padL(ok ? 'ok' : 'NaN', 8));
}
console.log('');

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

console.log('--- CAMERA ---');
{
  // A flat island 4 m above sea level, so the ground clamp and the boom cast have something
  // to hit. This is the minimum surface app.world will expose (ARCHITECTURE §5).
  const world = {
    heightAt: (x, z) => (Math.hypot(x, z) < 40 ? 4 : -6),
    blockAt: (x, y, z) => (Math.hypot(x, z) < 40 && y < 4 ? 1 : 0),
  };
  // Start the subject where the first simulated step will put it. Snapping the camera to one
  // place and then teleporting the subject somewhere else would measure the test's bug, not
  // the camera's.
  const target = { pos: new THREE.Vector3(14, 4, 0), vel: { x: 0, y: 0, z: 12.6 }, yaw: 0, height: 4.25 };
  const app = { world, input: null, seed: SEED };
  const cam = new GameCamera(app, { seed: SEED });
  cam.follow(target);
  cam.snap();

  const three = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 7000);
  let maxJump = 0, minClear = Infinity, worstFrame = 0;
  let prev = cam.pos.clone();
  for (let i = 0; i < 600; i++) {
    // Walk the subject in a circle at run speed, so the camera has to keep up and turn.
    const t = i * DT;
    target.pos.set(Math.cos(t * 0.9) * 14, 4, Math.sin(t * 0.9) * 14);
    target.vel.x = -Math.sin(t * 0.9) * 12.6;
    target.vel.z = Math.cos(t * 0.9) * 12.6;
    target.yaw = Math.atan2(target.vel.x, target.vel.z);
    cam.update(DT, { lookX: 0.004, lookY: 0, down: {}, pressed: {} }, app);
    cam.applyTo(three, 1);
    const jump = cam.pos.distanceTo(prev);
    maxJump = Math.max(maxJump, jump);
    prev.copy(cam.pos);
    minClear = Math.min(minClear, cam.pos.y - world.heightAt(cam.pos.x, cam.pos.z));
    worstFrame = Math.max(worstFrame, Math.abs(cam.fov - 62));
    if (!Number.isFinite(cam.pos.x + cam.pos.y + cam.pos.z + cam.fov)) {
      fail('camera: produced a non-finite transform');
      break;
    }
  }
  // 12.6 m/s subject => at most ~0.21 m of camera travel per 1/60 s step if it is not snapping.
  if (maxJump > 0.6) fail(`camera: snapped (max per-step travel ${f3(maxJump)} m)`);
  if (minClear < 0) fail(`camera: went below the terrain (min clearance ${f3(minClear)} m)`);

  // Shake decays to nothing and is deterministic from the seed.
  const c1 = new GameCamera(app, { seed: SEED });
  const c2 = new GameCamera(app, { seed: SEED });
  c1.follow(target); c2.follow(target); c1.snap(); c2.snap();
  c1.shake(0.5, 0.3); c2.shake(0.5, 0.3);
  let shakeDiff = 0, peak = 0;
  for (let i = 0; i < 40; i++) {
    c1.update(DT, null, app); c2.update(DT, null, app);
    shakeDiff = Math.max(shakeDiff, c1.shakeOffset.distanceTo(c2.shakeOffset));
    peak = Math.max(peak, c1.shakeOffset.length());
  }
  if (shakeDiff !== 0) fail(`camera: shake is not deterministic (max divergence ${shakeDiff})`);
  if (c1.shakeOffset.length() > 1e-9) fail('camera: shake did not decay to zero');
  if (peak < 0.05) fail(`camera: shake never reached a visible amplitude (peak ${f3(peak)})`);

  // Mode switches must not teleport the camera.
  const before = cam.pos.clone();
  cam.setMode('sail');
  cam.update(DT, null, app);
  const modeJump = cam.pos.distanceTo(before);
  if (modeJump > 0.6) fail(`camera: setMode('sail') teleported the camera (${f3(modeJump)} m)`);

  // Lock-on frames both actors.
  const foe = { pos: new THREE.Vector3(target.pos.x + 12, 4, target.pos.z + 4), height: 5 };
  cam.setMode('follow');
  cam.setLockTarget(foe);
  for (let i = 0; i < 180; i++) cam.update(DT, null, app);
  const wantYaw = Math.atan2(foe.pos.x - target.pos.x, foe.pos.z - target.pos.z);
  const yawErr = Math.abs(Math.atan2(Math.sin(cam.yaw - wantYaw), Math.cos(cam.yaw - wantYaw)));
  if (yawErr > 0.12) fail(`camera: lock-on did not converge on the target (yaw error ${f3(yawErr)} rad)`);
  if (cam.dist <= CAMERA_MODES.lockon.dist) {
    fail(`camera: lock-on did not lengthen the boom (${f3(cam.dist)} m, base ${CAMERA_MODES.lockon.dist} m)`);
  }

  console.log(pad('max per-step travel', 26) + padL(f3(maxJump) + ' m', 12));
  console.log(pad('min terrain clearance', 26) + padL(f3(minClear) + ' m', 12));
  console.log(pad('shake peak / residual', 26) + padL(f3(peak) + ' / ' + c1.shakeOffset.length().toExponential(1), 12));
  console.log(pad('mode switch travel', 26) + padL(f3(modeJump) + ' m', 12));
  console.log(pad('lock-on yaw error', 26) + padL(f3(yawErr) + ' rad', 12));
  console.log(pad('lock-on boom length', 26) + padL(f3(cam.dist) + ' m', 12));
  console.log(pad('dynamic fov swing', 26) + padL(f3(worstFrame) + ' deg', 12));
}
console.log('');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('--- SUMMARY ---');
console.log('  archetypes rigged        ' + rigs.length + ' (' + SPEC_IDS.join(', ') + ')');
console.log('  states                   ' + STATE_NAMES.length
  + '  (' + Object.keys(ATTACK_TIMINGS).length + ' attacks with sub-phase data)');
console.log('  poses evaluated          ' + totalSamples
  + '  (' + STATE_NAMES.length + ' states x ' + rigs.length + ' rigs x ' + STEPS + ' steps, plus determinism reruns)');
console.log('  channels per pose        ' + (9 + JOINTS.length * 6)
  + '  (root 9 + ' + JOINTS.length + ' joints x 6)');
console.log('  non-finite poses         ' + nanCount);
console.log('  deterministic states     ' + detOk + '/' + STATE_NAMES.length);
console.log('  least-moving state       ' + worstMotionState + '  (' + worstMotion.toExponential(2) + ' of pose range over its window)');
console.log('  weakest silhouette       ' + worstSilState + '  (' + f3(worstSil) + ' from bind pose)');
console.log('  reference height         ' + REF_HEIGHT + ' m');
console.log('');

if (failures.length) {
  console.log('FAIL — ' + failures.length + ' problem(s):');
  for (const f of failures) console.log('  * ' + f);
  process.exit(1);
}
console.log('PASS — rig hierarchy, ' + STATE_NAMES.length + ' animation states, attack sub-phase data,'
  + ' determinism and camera all clean.');
