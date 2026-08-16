// Procedural animation. Owner: Cluster B (character / rig / animation / camera).
//
// There are no keyframe files in this game and there never will be. Every pose is a pure
// function of (state, time-in-state, context) evaluated at the fixed 1/60 timestep, which is
// what makes animation deterministic in the same sense the rest of the simulation is: the
// same seed and the same inputs replay the same silhouette, frame for frame.
//
// Structure:
//   pose        a plain object of joint rotations + offsets (see makePose)
//   AnimState   one named generator: update(t, ctx, out) -> pose
//   Animator    a two-slot crossfade over AnimState plus stateful secondary motion
//
// Why two slots and not a general blend tree: a blend tree that can hold five states at once
// is a tree you have to debug when the character T-poses. Two slots with a crossfade covers
// every transition this game makes, and the *secondary* motion layer — hat lag, coat sway,
// arm follow-through, squash — is where the animation actually gets its life. Secondary motion
// is stateful, integrated at the fixed timestep (never a raw lerp on dt), and it survives the
// crossfade because it is applied after the blend, not inside it.
//
// Pose rules enforced here, from reference/ART_BAR.md §1:
//   * poses are diagonal and asymmetric — the archetype's authored bind pose is folded in as
//     the resting offset, and every generated cycle uses different amplitudes left vs right
//   * anticipation before every attack (the windup travels opposite the strike)
//   * overshoot and settle after every strike (outBack / damped sine, never a hard stop)
//   * the head leads turns (ctx.turnRate drives head yaw ahead of the body)
//   * 1–2 voxels of squash and stretch on jump/land, done by scaling parts

import { clamp, clamp01, lerp, ease, TAU, angleDelta } from '../core/math.js';
import { Rng } from '../core/rng.js';

/** Joints the rig understands. Order is fixed: pose blending walks this list. */
export const JOINTS = Object.freeze([
  'hips', 'torso', 'head', 'armL', 'armR', 'legL', 'legR', 'hat', 'extra', 'weapon',
]);

/**
 * Reference character height in metres (the hero, 17 voxels at 0.25 m). Every offset written
 * below is authored against this height and scaled by ctx.height / REF_HEIGHT, so a 15-voxel
 * navigator and an 18-voxel shipwright move with the same *proportions* rather than the same
 * absolute centimetres.
 */
export const REF_HEIGHT = 4.25;

// ---------------------------------------------------------------------------
// Pose containers
// ---------------------------------------------------------------------------

/**
 * Allocate an empty pose. Rotations are radians in ZXY order (roll outermost), matching the
 * convention charmodel's silhouette test uses for the authored bind poses.
 * @returns {object} pose
 */
export function makePose() {
  const p = {
    rootPos: [0, 0, 0],
    rootRot: [0, 0, 0],
    rootScale: [1, 1, 1],
    j: Object.create(null),
  };
  for (let i = 0; i < JOINTS.length; i++) p.j[JOINTS[i]] = { r: [0, 0, 0], p: [0, 0, 0] };
  return p;
}

/** Zero a pose in place (rotations and offsets to 0, scale to 1). @param {object} p */
export function resetPose(p) {
  p.rootPos[0] = 0; p.rootPos[1] = 0; p.rootPos[2] = 0;
  p.rootRot[0] = 0; p.rootRot[1] = 0; p.rootRot[2] = 0;
  p.rootScale[0] = 1; p.rootScale[1] = 1; p.rootScale[2] = 1;
  for (let i = 0; i < JOINTS.length; i++) {
    const j = p.j[JOINTS[i]];
    j.r[0] = 0; j.r[1] = 0; j.r[2] = 0;
    j.p[0] = 0; j.p[1] = 0; j.p[2] = 0;
  }
}

/** Copy src into dst. @param {object} dst @param {object} src @returns {object} dst */
export function copyPose(dst, src) {
  for (let i = 0; i < 3; i++) {
    dst.rootPos[i] = src.rootPos[i];
    dst.rootRot[i] = src.rootRot[i];
    dst.rootScale[i] = src.rootScale[i];
  }
  for (let i = 0; i < JOINTS.length; i++) {
    const a = dst.j[JOINTS[i]], b = src.j[JOINTS[i]];
    a.r[0] = b.r[0]; a.r[1] = b.r[1]; a.r[2] = b.r[2];
    a.p[0] = b.p[0]; a.p[1] = b.p[1]; a.p[2] = b.p[2];
  }
  return dst;
}

/**
 * Linear blend of two poses. Euler-linear rather than quaternion-slerp on purpose: every
 * rotation in this game is well under 180 degrees away from its blend partner, so slerp buys
 * nothing and costs a normalise per joint per actor per step.
 * @param {object} dst @param {object} a @param {object} b @param {number} t 0..1
 * @returns {object} dst
 */
export function blendPose(dst, a, b, t) {
  const s = clamp01(t);
  for (let i = 0; i < 3; i++) {
    dst.rootPos[i] = lerp(a.rootPos[i], b.rootPos[i], s);
    dst.rootRot[i] = lerp(a.rootRot[i], b.rootRot[i], s);
    dst.rootScale[i] = lerp(a.rootScale[i], b.rootScale[i], s);
  }
  for (let i = 0; i < JOINTS.length; i++) {
    const o = dst.j[JOINTS[i]], x = a.j[JOINTS[i]], y = b.j[JOINTS[i]];
    for (let k = 0; k < 3; k++) {
      o.r[k] = lerp(x.r[k], y.r[k], s);
      o.p[k] = lerp(x.p[k], y.p[k], s);
    }
  }
  return dst;
}

/** Largest absolute difference between two poses. Used by the self-check to prove motion. */
export function poseDelta(a, b) {
  let m = 0;
  for (let i = 0; i < 3; i++) {
    m = Math.max(m, Math.abs(a.rootPos[i] - b.rootPos[i]));
    m = Math.max(m, Math.abs(a.rootRot[i] - b.rootRot[i]));
    m = Math.max(m, Math.abs(a.rootScale[i] - b.rootScale[i]));
  }
  for (let i = 0; i < JOINTS.length; i++) {
    const x = a.j[JOINTS[i]], y = b.j[JOINTS[i]];
    for (let k = 0; k < 3; k++) {
      m = Math.max(m, Math.abs(x.r[k] - y.r[k]));
      m = Math.max(m, Math.abs(x.p[k] - y.p[k]));
    }
  }
  return m;
}

/** Flatten a pose to a number array. Determinism comparisons and the self-check use this. */
export function poseToArray(p, out) {
  const a = out || [];
  let i = 0;
  for (let k = 0; k < 3; k++) { a[i++] = p.rootPos[k]; a[i++] = p.rootRot[k]; a[i++] = p.rootScale[k]; }
  for (let n = 0; n < JOINTS.length; n++) {
    const j = p.j[JOINTS[n]];
    for (let k = 0; k < 3; k++) { a[i++] = j.r[k]; a[i++] = j.p[k]; }
  }
  a.length = i;
  return a;
}

/** True if any channel is NaN or Infinity. @param {object} p */
export function poseIsFinite(p) {
  const a = poseToArray(p);
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Attack timing data — CONSUMED BY COMBAT, which must not import animation code.
// ---------------------------------------------------------------------------

/**
 * Normalised sub-phases of every attack, in seconds. `windup + active + recovery === duration`
 * for every entry (tools/check-character.mjs asserts it to 1e-9).
 *
 * Combat reads this table to know when a hitbox opens. It is deliberately plain data — no
 * functions, no closures, frozen — so `import { ATTACK_TIMINGS } from '../entity/anim.js'`
 * costs combat nothing but the numbers.
 *
 *   windup    anticipation; the body travels *away* from the strike. Telegraph lives here.
 *   active    the hitbox is open. Short — Hades-grade reads come from the windup, not this.
 *   recovery  commit cost. Cancellable into the next combo link from `cancel` onward.
 *   cancel    seconds from state start at which the next attack may be buffered in
 *   reach     metres from the actor's chest, at REF_HEIGHT scale
 *   arc       full horizontal sweep in radians the hitbox covers
 *   damage    multiplier on the actor's base damage
 *   impulse   knockback impulse multiplier
 *   hitstop   seconds of hitstop this attack asks for on a confirmed hit
 *   lunge     forward metres the attack drives the attacker (root motion), at REF_HEIGHT
 * @type {Readonly<Record<string, Readonly<object>>>}
 */
export const ATTACK_TIMINGS = Object.freeze({
  attack_1: Object.freeze({
    windup: 0.11, active: 0.09, recovery: 0.20, duration: 0.40,
    cancel: 0.26, reach: 2.6, arc: 1.90, damage: 1.00, impulse: 2.2, hitstop: 0.055, lunge: 0.55,
  }),
  attack_2: Object.freeze({
    windup: 0.09, active: 0.10, recovery: 0.23, duration: 0.42,
    cancel: 0.28, reach: 2.8, arc: 2.20, damage: 1.15, impulse: 2.6, hitstop: 0.065, lunge: 0.70,
  }),
  attack_3: Object.freeze({
    windup: 0.17, active: 0.13, recovery: 0.36, duration: 0.66,
    cancel: 0.52, reach: 3.2, arc: 2.60, damage: 1.70, impulse: 6.0, hitstop: 0.100, lunge: 1.10,
  }),
  attack_heavy: Object.freeze({
    windup: 0.38, active: 0.14, recovery: 0.44, duration: 0.96,
    cancel: 0.80, reach: 3.6, arc: 1.50, damage: 2.60, impulse: 9.0, hitstop: 0.130, lunge: 1.40,
  }),
  attack_air: Object.freeze({
    windup: 0.13, active: 0.16, recovery: 0.26, duration: 0.55,
    cancel: 0.42, reach: 2.9, arc: 2.40, damage: 1.35, impulse: 4.0, hitstop: 0.080, lunge: 0.40,
  }),
});

/** Combo order the player's light-attack chain walks. Combat reads this to size its buffers. */
export const COMBO_CHAIN = Object.freeze(['attack_1', 'attack_2', 'attack_3']);

/**
 * Which sub-phase an attack is in, and how far through it.
 * @param {string} name attack state name
 * @param {number} t seconds since the attack started
 * @returns {{phase:'windup'|'active'|'recovery'|'done', t:number, k:number}} k = 0..1 within phase
 */
export function attackPhase(name, t) {
  const a = ATTACK_TIMINGS[name];
  if (!a) return { phase: 'done', t, k: 1 };
  if (t < a.windup) return { phase: 'windup', t, k: a.windup > 0 ? t / a.windup : 1 };
  if (t < a.windup + a.active) return { phase: 'active', t, k: (t - a.windup) / a.active };
  if (t < a.duration) return { phase: 'recovery', t, k: (t - a.windup - a.active) / a.recovery };
  return { phase: 'done', t, k: 1 };
}

// ---------------------------------------------------------------------------
// Pose-writing helpers
// ---------------------------------------------------------------------------

/** Fold the archetype's authored bind pose in at weight w. This is where asymmetry comes from. */
function applyBind(o, ctx, w) {
  const b = ctx.bind;
  if (!b || w <= 0) return;
  if (b.armL) { o.j.armL.r[0] += b.armL[0] * w; o.j.armL.r[2] += b.armL[1] * w; }
  if (b.armR) { o.j.armR.r[0] += b.armR[0] * w; o.j.armR.r[2] += b.armR[1] * w; }
  if (b.legL) { o.j.legL.r[0] += b.legL[0] * w; o.j.legL.r[2] += b.legL[1] * w; }
  if (b.legR) { o.j.legR.r[0] += b.legR[0] * w; o.j.legR.r[2] += b.legR[1] * w; }
  // Lean is authored as a hip-pivot shear in charmodel's silhouette test; the equivalent
  // rigid transform is a roll about Z at the hips, negated because +roll shears -X there.
  if (b.lean) o.j.hips.r[2] += -b.lean * w;
  if (b.headTilt) o.j.head.r[2] += b.headTilt * w;
}

/** Head leads the turn: yaw ahead of the body, pitch into the lean. ART_BAR animation rule. */
function headLead(o, ctx, amount) {
  const tr = clamp(ctx.turnRate || 0, -6, 6);
  o.j.head.r[1] += clamp(tr * 0.13, -0.5, 0.5) * amount;
  o.j.torso.r[1] += clamp(tr * 0.05, -0.22, 0.22) * amount;
  // Counter-roll: a head that only yaws reads like a turret. A little tilt into the turn sells it.
  o.j.head.r[2] += clamp(-tr * 0.035, -0.14, 0.14) * amount;
}

/** Locomotion arm/leg swing shared by walk/run/sprint. Amplitudes differ L vs R by design. */
function gaitSwing(o, ph, cfg, hs) {
  const s = Math.sin(ph * TAU), c = Math.cos(ph * TAU);
  // Legs: the classic contra-phase swing, with the trailing leg reaching slightly further.
  o.j.legL.r[0] += s * cfg.leg;
  o.j.legR.r[0] += -s * cfg.leg * 0.93;
  // Knee-less voxel legs cannot bend, so the lift comes from the hip and a vertical offset.
  o.j.legL.p[1] += Math.max(0, s) * cfg.lift * hs;
  o.j.legR.p[1] += Math.max(0, -s) * cfg.lift * hs;
  // Arms oppose the legs. The lead arm drives harder — symmetric arm swing reads as a robot.
  o.j.armL.r[0] += -s * cfg.arm * 1.07;
  o.j.armR.r[0] += s * cfg.arm * 0.88;
  o.j.armL.r[2] += cfg.armOut * 0.9 + c * cfg.armFlare;
  o.j.armR.r[2] += -cfg.armOut - c * cfg.armFlare * 0.8;
  // Body bob is twice gait frequency (one rise per footfall) — this is what makes it read as
  // weight rather than as a slider animating.
  o.rootPos[1] += (Math.abs(Math.sin(ph * Math.PI)) - 0.5) * cfg.bob * hs;
  o.j.hips.r[1] += -s * cfg.hipTwist;
  o.j.torso.r[1] += s * cfg.shoulderTwist;
  o.j.torso.r[0] += cfg.lean;
  o.j.head.r[0] += -cfg.lean * 0.55;
  o.j.hips.r[2] += c * cfg.hipRoll;
}

/** Both feet planted, weight on one side. Used by idle-family and talk/point states. */
function stancePlant(o, side, amount, hs) {
  o.j.hips.p[0] += side * 0.05 * amount * hs;
  o.j.hips.r[2] += -side * 0.05 * amount;
  o.j.legL.r[2] += side * 0.04 * amount;
  o.j.legR.r[2] += side * 0.03 * amount;
  o.j.torso.r[2] += side * 0.03 * amount;
  o.j.head.r[2] += -side * 0.05 * amount;
}

/** Symmetric guard, deliberately broken: lead hand higher and further forward than the off hand. */
function guardUp(o, amount, hs) {
  o.j.armL.r[0] += -1.02 * amount;
  o.j.armL.r[2] += 0.46 * amount;
  o.j.armL.p[2] += 0.16 * amount * hs;
  o.j.armR.r[0] += -0.72 * amount;
  o.j.armR.r[2] += -0.30 * amount;
  o.j.armR.p[2] += 0.05 * amount * hs;
  o.j.torso.r[1] += 0.24 * amount;
  o.j.head.r[1] += -0.12 * amount;
  o.j.hips.r[1] += 0.16 * amount;
}

/** Damped oscillation used for every settle. 1 at t=0, decaying to 0. */
function settle(t, freq, decay) {
  return Math.cos(t * TAU * freq) * Math.exp(-t * decay);
}

/**
 * Semi-implicit Euler damped spring, integrated in place on a {x, v} pair.
 *
 * Why not damp(): damp() is a first-order exponential approach and cannot overshoot, and
 * overshoot is exactly the thing secondary motion is for. This is stable and exactly
 * reproducible at the fixed 1/60 timestep for omega up to ~2/dt; every caller here stays
 * well under 45 rad/s.
 *
 * @param {{x:number, v:number}} s state, mutated
 * @param {number} target rest value
 * @param {number} omega natural frequency, rad/s
 * @param {number} zeta damping ratio (1 = critical, <1 overshoots)
 * @param {number} dt fixed timestep
 */
function springStep(s, target, omega, zeta, dt) {
  const a = (target - s.x) * omega * omega - s.v * (2 * zeta * omega);
  s.v += a * dt;
  s.x += s.v * dt;
}

// ---------------------------------------------------------------------------
// AnimState
// ---------------------------------------------------------------------------

/**
 * One named animation state. `weight` is the live blend weight the Animator maintains; it is
 * part of the public shape because debug overlays and the self-check read it.
 */
export class AnimState {
  /**
   * @param {string} name
   * @param {object} def { duration, loop, bindWeight, cyclic, events, cycleEvents, build }
   */
  constructor(name, def) {
    this.name = name;
    this.weight = 0;
    this.duration = def.duration !== undefined ? def.duration : 1;
    this.loop = def.loop !== false;
    this.bindWeight = def.bindWeight !== undefined ? def.bindWeight : 1;
    /** Cyclic states read ctx.phase (the actor's gait phase) instead of their own clock. */
    this.cyclic = !!def.cyclic;
    /** Events fired on the state's own clock: [{ t, name, sfx }] */
    this.events = def.events || null;
    /** Events fired when the gait phase crosses a value: [{ at, name, sfx }] */
    this.cycleEvents = def.cycleEvents || null;
    this._build = def.build;
    this._pose = makePose();
  }

  /**
   * Evaluate this state.
   * @param {number} t seconds since the state started
   * @param {object} ctx animation context (see module header)
   * @param {object} [out] pose to write into; allocated if omitted
   * @returns {object} pose
   */
  update(t, ctx, out) {
    const o = out || this._pose;
    resetPose(o);
    applyBind(o, ctx, this.bindWeight);
    this._build(o, t, ctx);
    return o;
  }
}

// ---------------------------------------------------------------------------
// The states. Every one is real, distinct, and changes the black-cutout silhouette.
// ---------------------------------------------------------------------------

const DEF = Object.create(null);
const define = (name, def) => { DEF[name] = def; };

// --- idle family -----------------------------------------------------------

define('idle', {
  duration: 4.6, loop: true, bindWeight: 1,
  build(o, t, ctx) {
    const hs = ctx.hs;
    // Breathing: chest rises, shoulders follow a beat later, head last. The lag is the point.
    const br = Math.sin(t * TAU / 3.4);
    o.j.torso.p[1] += br * 0.030 * hs;
    o.j.torso.r[0] += br * 0.026;
    o.j.armL.r[2] += br * 0.045;
    o.j.armR.r[2] += -br * 0.038;
    o.j.head.p[1] += Math.sin((t - 0.22) * TAU / 3.4) * 0.018 * hs;

    // Weight shift: a slow triangle between the two feet, never centred for long.
    const shift = Math.sin(t * TAU / 4.6);
    stancePlant(o, shift >= 0 ? 1 : -1, Math.abs(shift), hs);
    o.rootPos[0] += shift * 0.035 * hs;

    // Occasional head glance. Deterministic: it is a function of the cycle index, so replaying
    // the state from t=0 always glances at the same moments.
    const cyc = Math.floor(t / 4.6);
    const gt = t - cyc * 4.6;
    const gk = ctx.glance;
    if (gt > 1.6 && gt < 3.0) {
      const u = (gt - 1.6) / 1.4;
      const env = Math.sin(u * Math.PI);
      o.j.head.r[1] += env * (gk > 0.5 ? 0.55 : -0.42);
      o.j.head.r[0] += env * -0.08;
      o.j.torso.r[1] += env * 0.10 * (gk > 0.5 ? 1 : -1);
    }
    headLead(o, ctx, 1);
  },
});

define('idle_combat', {
  duration: 1.05, loop: true, bindWeight: 0.22,
  build(o, t, ctx) {
    const hs = ctx.hs;
    guardUp(o, 1, hs);
    // Bounce on the balls of the feet — 1.6 Hz, weight never settled.
    const b = Math.sin(t * TAU / 0.62);
    o.rootPos[1] += (Math.abs(b) - 0.42) * 0.055 * hs;
    o.j.legL.r[0] += 0.16 + b * 0.10;
    o.j.legR.r[0] += -0.22 - b * 0.08;
    o.j.legL.r[2] += 0.07;
    o.j.legR.r[2] += -0.11;
    o.j.armL.r[0] += b * 0.09;
    o.j.armR.r[0] += -b * 0.07;
    o.j.head.r[0] += -0.06 + b * 0.03;
    o.j.hips.p[0] += -0.03 * hs;
    headLead(o, ctx, 1.2);
  },
});

// --- ground locomotion -----------------------------------------------------

define('walk', {
  duration: 1, loop: true, cyclic: true, bindWeight: 0.30,
  cycleEvents: [{ at: 0.04, name: 'footstep', foot: 'L' }, { at: 0.54, name: 'footstep', foot: 'R' }],
  build(o, t, ctx) {
    gaitSwing(o, ctx.phase, {
      leg: 0.52, lift: 0.09, arm: 0.36, armOut: 0.10, armFlare: 0.05,
      bob: 0.10, hipTwist: 0.09, shoulderTwist: 0.13, lean: 0.05, hipRoll: 0.045,
    }, ctx.hs);
    headLead(o, ctx, 1);
  },
});

define('run', {
  duration: 1, loop: true, cyclic: true, bindWeight: 0.16,
  cycleEvents: [{ at: 0.03, name: 'footstep', foot: 'L' }, { at: 0.53, name: 'footstep', foot: 'R' }],
  build(o, t, ctx) {
    gaitSwing(o, ctx.phase, {
      leg: 0.86, lift: 0.20, arm: 0.78, armOut: 0.16, armFlare: 0.09,
      bob: 0.20, hipTwist: 0.16, shoulderTwist: 0.24, lean: 0.17, hipRoll: 0.07,
    }, ctx.hs);
    o.rootPos[2] += 0.03 * ctx.hs;
    headLead(o, ctx, 1.1);
  },
});

define('sprint', {
  duration: 1, loop: true, cyclic: true, bindWeight: 0.06,
  cycleEvents: [{ at: 0.02, name: 'footstep', foot: 'L' }, { at: 0.52, name: 'footstep', foot: 'R' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    gaitSwing(o, ctx.phase, {
      leg: 1.12, lift: 0.30, arm: 1.24, armOut: 0.26, armFlare: 0.13,
      bob: 0.26, hipTwist: 0.22, shoulderTwist: 0.34, lean: 0.34, hipRoll: 0.09,
    }, hs);
    // The sprint read is the whole-body forward commit, not faster legs.
    o.rootRot[0] += 0.20;
    o.j.head.r[0] += -0.24;
    o.j.head.p[2] += 0.06 * hs;
    o.rootPos[1] += -0.06 * hs;
    headLead(o, ctx, 1.25);
  },
});

define('strafe_l', {
  duration: 1, loop: true, cyclic: true, bindWeight: 0.34,
  cycleEvents: [{ at: 0.05, name: 'footstep', foot: 'L' }, { at: 0.55, name: 'footstep', foot: 'R' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const s = Math.sin(ctx.phase * TAU);
    // Side-step: legs open and close instead of swinging fore/aft. Crossed-over silhouette.
    o.j.legL.r[2] += 0.34 + s * 0.24;
    o.j.legR.r[2] += 0.10 + s * 0.30;
    o.j.legL.p[1] += Math.max(0, s) * 0.10 * hs;
    o.j.legR.p[1] += Math.max(0, -s) * 0.13 * hs;
    o.j.hips.r[2] += 0.13;
    o.j.torso.r[2] += 0.07;
    o.j.torso.r[1] += 0.20;
    o.j.armL.r[2] += 0.42 + s * 0.10;
    o.j.armR.r[2] += -0.14 + s * 0.06;
    o.j.armR.r[0] += -0.34;
    o.j.head.r[1] += -0.24;
    o.rootPos[1] += (Math.abs(Math.sin(ctx.phase * Math.PI)) - 0.5) * 0.08 * hs;
    headLead(o, ctx, 0.8);
  },
});

define('strafe_r', {
  duration: 1, loop: true, cyclic: true, bindWeight: 0.34,
  cycleEvents: [{ at: 0.05, name: 'footstep', foot: 'R' }, { at: 0.55, name: 'footstep', foot: 'L' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const s = Math.sin(ctx.phase * TAU);
    o.j.legR.r[2] += -0.34 - s * 0.24;
    o.j.legL.r[2] += -0.10 - s * 0.30;
    o.j.legR.p[1] += Math.max(0, s) * 0.10 * hs;
    o.j.legL.p[1] += Math.max(0, -s) * 0.13 * hs;
    o.j.hips.r[2] += -0.13;
    o.j.torso.r[2] += -0.07;
    o.j.torso.r[1] += -0.20;
    o.j.armR.r[2] += -0.42 - s * 0.10;
    o.j.armL.r[2] += 0.14 - s * 0.06;
    o.j.armL.r[0] += -0.34;
    o.j.head.r[1] += 0.24;
    o.rootPos[1] += (Math.abs(Math.sin(ctx.phase * Math.PI)) - 0.5) * 0.08 * hs;
    headLead(o, ctx, 0.8);
  },
});

define('backpedal', {
  duration: 1, loop: true, cyclic: true, bindWeight: 0.34,
  cycleEvents: [{ at: 0.06, name: 'footstep', foot: 'R' }, { at: 0.56, name: 'footstep', foot: 'L' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const s = Math.sin(ctx.phase * TAU);
    // Short, choppy, weight *behind* the feet — reads as retreat even from the back.
    o.j.legL.r[0] += -s * 0.36;
    o.j.legR.r[0] += s * 0.32;
    o.j.legL.p[1] += Math.max(0, -s) * 0.07 * hs;
    o.j.legR.p[1] += Math.max(0, s) * 0.07 * hs;
    o.rootRot[0] += -0.16;
    o.j.torso.r[0] += -0.10;
    o.j.head.r[0] += 0.16;
    o.j.armL.r[0] += -0.30 + s * 0.16;
    o.j.armR.r[0] += -0.44 - s * 0.14;
    o.j.armL.r[2] += 0.22;
    o.j.armR.r[2] += -0.30;
    o.rootPos[1] += (Math.abs(Math.sin(ctx.phase * Math.PI)) - 0.5) * 0.06 * hs;
    headLead(o, ctx, 0.9);
  },
});

// --- air -------------------------------------------------------------------

define('jump_launch', {
  duration: 0.18, loop: false, bindWeight: 0.10,
  events: [{ t: 0.0, name: 'crouch' }, { t: 0.10, name: 'liftoff', sfx: 'jump' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const k = clamp01(t / 0.18);
    // Anticipation: compress, then extend. Squash is 1–2 voxels, done by scaling the root.
    const crouch = Math.sin(clamp01(k / 0.55) * Math.PI * 0.5);
    const extend = k > 0.55 ? ease.outQuad((k - 0.55) / 0.45) : 0;
    o.rootScale[1] = 1 - crouch * 0.10 + extend * 0.16;
    o.rootScale[0] = 1 + crouch * 0.07 - extend * 0.08;
    o.rootScale[2] = o.rootScale[0];
    o.rootPos[1] += (-crouch * 0.26 + extend * 0.14) * hs;
    o.j.legL.r[0] += crouch * 0.46 - extend * 0.30;
    o.j.legR.r[0] += crouch * 0.40 - extend * 0.36;
    o.j.torso.r[0] += crouch * 0.30 - extend * 0.20;
    o.j.armL.r[0] += crouch * 0.60 - extend * 1.55;
    o.j.armR.r[0] += crouch * 0.48 - extend * 1.20;
    o.j.armL.r[2] += 0.16;
    o.j.armR.r[2] += -0.24;
    o.j.head.r[0] += -extend * 0.22;
  },
});

define('jump_air', {
  duration: 1.2, loop: true, bindWeight: 0.10,
  build(o, t, ctx) {
    const hs = ctx.hs;
    // Rising: stretched, one knee tucked, one arm thrown up. Never a symmetric star.
    const s = Math.sin(t * TAU / 1.2);
    o.rootScale[1] = 1.07;
    o.rootScale[0] = 0.965; o.rootScale[2] = 0.965;
    o.j.legL.r[0] += 0.62 + s * 0.07;
    o.j.legR.r[0] += -0.26 - s * 0.05;
    o.j.legL.p[1] += 0.10 * hs;
    o.j.armL.r[0] += -1.85 + s * 0.10;
    o.j.armR.r[0] += 0.52 - s * 0.08;
    o.j.armL.r[2] += 0.30;
    o.j.armR.r[2] += -0.42;
    o.j.torso.r[0] += -0.14;
    o.j.torso.r[1] += 0.16;
    o.j.head.r[0] += -0.12;
    headLead(o, ctx, 0.7);
  },
});

define('fall', {
  duration: 1.0, loop: true, bindWeight: 0.10,
  build(o, t, ctx) {
    const hs = ctx.hs;
    // Falling reads as *reaching* — arms up and back, legs trailing, torso pitched forward.
    const flail = Math.sin(t * TAU / 0.7);
    o.rootScale[1] = 1.04; o.rootScale[0] = 0.98; o.rootScale[2] = 0.98;
    o.j.armL.r[0] += -2.25 + flail * 0.22;
    o.j.armR.r[0] += -1.95 - flail * 0.28;
    o.j.armL.r[2] += 0.46 + flail * 0.10;
    o.j.armR.r[2] += -0.58 + flail * 0.12;
    o.j.legL.r[0] += -0.34 + flail * 0.12;
    o.j.legR.r[0] += 0.20 - flail * 0.10;
    o.j.legL.r[2] += 0.14;
    o.j.legR.r[2] += -0.20;
    o.j.torso.r[0] += 0.22;
    o.j.head.r[0] += -0.34;
    o.rootPos[1] += flail * 0.02 * hs;
    headLead(o, ctx, 0.5);
  },
});

define('land_soft', {
  duration: 0.30, loop: false, bindWeight: 0.55,
  events: [{ t: 0.0, name: 'land', sfx: 'land_soft' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const k = clamp01(t / 0.30);
    const dip = Math.sin(Math.PI * Math.pow(k, 0.55)) * (1 - k * 0.35);
    o.rootScale[1] = 1 - dip * 0.09;
    o.rootScale[0] = 1 + dip * 0.06; o.rootScale[2] = o.rootScale[0];
    o.rootPos[1] += -dip * 0.24 * hs;
    o.j.legL.r[0] += dip * 0.44;
    o.j.legR.r[0] += dip * 0.36;
    o.j.torso.r[0] += dip * 0.26;
    o.j.armL.r[0] += dip * 0.34;
    o.j.armR.r[0] += dip * 0.52;
    o.j.armL.r[2] += 0.20 + dip * 0.16;
    o.j.armR.r[2] += -0.16 - dip * 0.22;
    o.j.head.r[0] += dip * 0.18;
  },
});

define('land_hard', {
  duration: 0.62, loop: false, bindWeight: 0.35,
  events: [{ t: 0.0, name: 'land', sfx: 'land_hard' }, { t: 0.0, name: 'impact' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const k = clamp01(t / 0.62);
    // Big squash, one knee down, one hand planted. Asymmetric on purpose: a two-point landing
    // reads as a superhero pose and a two-knee landing reads as a bug.
    const dip = Math.sin(Math.PI * Math.pow(k, 0.42)) * (1 - k * 0.5);
    const rise = ease.outBack(clamp01((k - 0.35) / 0.65)) * (k > 0.35 ? 1 : 0);
    o.rootScale[1] = 1 - dip * 0.20 + rise * 0.03;
    o.rootScale[0] = 1 + dip * 0.13; o.rootScale[2] = o.rootScale[0];
    o.rootPos[1] += -dip * 0.62 * hs;
    o.j.legL.r[0] += dip * 1.00;
    o.j.legR.r[0] += dip * 0.42;
    o.j.legL.p[1] += -dip * 0.05 * hs;
    o.j.hips.r[2] += dip * 0.16;
    o.j.torso.r[0] += dip * 0.58 - rise * 0.10;
    o.j.torso.r[1] += dip * 0.22;
    o.j.armR.r[0] += dip * 1.30;    // planted hand
    o.j.armR.r[2] += -dip * 0.34;
    o.j.armL.r[0] += -dip * 0.55;   // trailing arm swung back
    o.j.armL.r[2] += dip * 0.62;
    o.j.head.r[0] += dip * 0.42;
  },
});

// --- water / climbing ------------------------------------------------------

define('swim_idle', {
  duration: 2.6, loop: true, bindWeight: 0.14,
  build(o, t, ctx) {
    const hs = ctx.hs;
    const s = Math.sin(t * TAU / 2.6), c = Math.cos(t * TAU / 2.6);
    // Treading water: arms sculling out of phase with each other, legs cycling slowly.
    o.rootRot[0] += 0.30;
    o.rootPos[1] += s * 0.07 * hs;
    o.j.armL.r[0] += -1.15 + s * 0.30;
    o.j.armR.r[0] += -1.05 - c * 0.34;
    o.j.armL.r[2] += 0.72 + c * 0.14;
    o.j.armR.r[2] += -0.80 + s * 0.16;
    o.j.legL.r[0] += 0.34 + s * 0.26;
    o.j.legR.r[0] += 0.28 - s * 0.30;
    o.j.legL.r[2] += 0.16;
    o.j.legR.r[2] += -0.12;
    o.j.head.r[0] += -0.34;
    o.j.torso.r[1] += s * 0.10;
    headLead(o, ctx, 0.6);
  },
});

define('swim_stroke', {
  duration: 1, loop: true, cyclic: true, bindWeight: 0.08,
  cycleEvents: [{ at: 0.02, name: 'stroke', sfx: 'swim_stroke', foot: 'L' },
    { at: 0.52, name: 'stroke', sfx: 'swim_stroke', foot: 'R' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const ph = ctx.phase;
    const s = Math.sin(ph * TAU), c = Math.cos(ph * TAU);
    // Front crawl: the body is nearly prone, one arm recovers over the top while the other pulls.
    o.rootRot[0] += 0.92;
    o.rootPos[1] += -0.10 * hs + s * 0.05 * hs;
    o.j.armL.r[0] += -1.6 - s * 1.55;
    o.j.armR.r[0] += -1.6 + s * 1.55;
    o.j.armL.r[2] += 0.24 + c * 0.20;
    o.j.armR.r[2] += -0.24 + c * 0.18;
    o.j.legL.r[0] += s * 0.30;
    o.j.legR.r[0] += -s * 0.34;
    o.j.hips.r[1] += -s * 0.16;
    o.j.torso.r[1] += s * 0.30;
    o.j.head.r[0] += -0.55 + Math.max(0, s) * 0.30;
    o.j.head.r[1] += s * 0.34;   // breathing to the side
  },
});

define('climb', {
  duration: 1, loop: true, cyclic: true, bindWeight: 0.06,
  cycleEvents: [{ at: 0.01, name: 'grab', sfx: 'climb', foot: 'L' },
    { at: 0.51, name: 'grab', sfx: 'climb', foot: 'R' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const s = Math.sin(ctx.phase * TAU);
    // Facing the wall: both arms high, alternating reach, hips pressed in.
    o.j.armL.r[0] += -2.35 - s * 0.55;
    o.j.armR.r[0] += -2.35 + s * 0.55;
    o.j.armL.r[2] += 0.20;
    o.j.armR.r[2] += -0.20;
    o.j.legL.r[0] += 0.30 - s * 0.42;
    o.j.legR.r[0] += 0.30 + s * 0.42;
    o.j.legL.r[2] += 0.18;
    o.j.legR.r[2] += -0.18;
    o.rootRot[0] += -0.16;
    o.j.torso.r[1] += s * 0.22;
    o.j.hips.r[1] += -s * 0.18;
    o.j.head.r[0] += -0.30;
    o.rootPos[1] += Math.abs(s) * 0.05 * hs;
    o.rootPos[2] += 0.10 * hs;
  },
});

// --- attacks ---------------------------------------------------------------

/**
 * Shared attack shape. Anticipation travels opposite the strike, the strike itself is one
 * fast beat, and recovery overshoots then settles. `cfg` says which way the blow travels.
 */
function attackBody(o, t, ctx, key, cfg) {
  const a = ATTACK_TIMINGS[key];
  const hs = ctx.hs;
  const wEnd = a.windup, aEnd = a.windup + a.active;
  let k;           // -1 = fully wound up, +1 = fully followed through
  let phase;
  if (t < wEnd) {
    phase = 0;
    k = -ease.outCubic(clamp01(t / a.windup));
  } else if (t < aEnd) {
    phase = 1;
    const u = clamp01((t - wEnd) / a.active);
    k = lerp(-1, 1.18, ease.inCubic(u) * 0.35 + ease.outExpo(u) * 0.65);
  } else {
    phase = 2;
    const u = clamp01((t - aEnd) / a.recovery);
    k = 1.18 * (1 - ease.outCubic(u)) + settle(u * a.recovery, 2.4, 7.5) * 0.16 * (1 - u);
  }
  const sw = cfg.swing;      // + = right-to-left sweep
  // Hips lead, torso follows, arms arrive last. That ordering is the whole read.
  o.j.hips.r[1] += k * sw * 0.42;
  o.j.torso.r[1] += k * sw * 0.78;
  o.j.torso.r[0] += cfg.pitch * k * 0.5 + (phase === 0 ? -0.10 : 0.16);
  o.j.head.r[1] += k * sw * 0.34 + (phase === 0 ? -sw * 0.16 : 0);
  o.j.head.r[0] += phase === 0 ? -0.14 : 0.16;

  o.j.armR.r[0] += cfg.armRBase + k * cfg.armRSwing;
  o.j.armR.r[2] += cfg.armRRoll - k * sw * 0.55;
  o.j.armR.r[1] += k * sw * 0.30;
  o.j.armL.r[0] += cfg.armLBase - k * cfg.armRSwing * 0.34;
  o.j.armL.r[2] += cfg.armLRoll + k * sw * 0.42;

  // Stance: the back foot drives, the front foot plants. Legs never mirror.
  o.j.legR.r[0] += -k * 0.24 * cfg.step;
  o.j.legL.r[0] += k * 0.34 * cfg.step;
  o.j.legL.r[2] += 0.06 * sw;
  o.j.legR.r[2] += -0.10 * sw;
  o.j.hips.r[2] += -k * sw * 0.10;

  // Root motion. Model space faces +Z (charmodel paints the face on the +Z head plane and the
  // rig's yaw maps forward to +Z), so a positive Z offset is a step into the blow.
  o.rootPos[2] += (k * 0.5 + 0.5) * a.lunge * hs * 0.35 - (phase === 0 ? 0.10 * hs : 0);
  o.rootPos[1] += cfg.rise * (k * 0.5 + 0.5) * hs;
  o.rootScale[1] = 1 + (phase === 1 ? 0.05 : 0) - (phase === 0 ? 0.03 : 0);
  o.rootScale[0] = 1 - (phase === 1 ? 0.03 : 0) + (phase === 0 ? 0.02 : 0);
  o.rootScale[2] = o.rootScale[0];
}

define('attack_1', {
  duration: ATTACK_TIMINGS.attack_1.duration, loop: false, bindWeight: 0.10,
  events: [{ t: ATTACK_TIMINGS.attack_1.windup, name: 'swing', sfx: 'swing_light' },
    { t: ATTACK_TIMINGS.attack_1.windup + ATTACK_TIMINGS.attack_1.active, name: 'recover' }],
  build(o, t, ctx) {
    attackBody(o, t, ctx, 'attack_1', {
      swing: 1, pitch: 0.10, step: 1, rise: 0.0,
      armRBase: -0.55, armRSwing: -1.35, armRRoll: -0.28,
      armLBase: -0.20, armLRoll: 0.34,
    });
  },
});

define('attack_2', {
  duration: ATTACK_TIMINGS.attack_2.duration, loop: false, bindWeight: 0.10,
  events: [{ t: ATTACK_TIMINGS.attack_2.windup, name: 'swing', sfx: 'swing_light' },
    { t: ATTACK_TIMINGS.attack_2.windup + ATTACK_TIMINGS.attack_2.active, name: 'recover' }],
  build(o, t, ctx) {
    // The backhand: mirrored sweep, so hit two of a combo never looks like hit one.
    attackBody(o, t, ctx, 'attack_2', {
      swing: -1, pitch: -0.06, step: -1, rise: 0.02,
      armRBase: -0.85, armRSwing: -1.05, armRRoll: 0.30,
      armLBase: -0.55, armLRoll: 0.10,
    });
    o.j.armL.r[0] += -0.30;
    o.j.torso.r[2] += 0.10;
  },
});

define('attack_3', {
  duration: ATTACK_TIMINGS.attack_3.duration, loop: false, bindWeight: 0.06,
  events: [{ t: ATTACK_TIMINGS.attack_3.windup, name: 'swing', sfx: 'swing_heavy' },
    { t: ATTACK_TIMINGS.attack_3.windup + ATTACK_TIMINGS.attack_3.active, name: 'recover' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    attackBody(o, t, ctx, 'attack_3', {
      swing: 1, pitch: 0.34, step: 1.4, rise: 0.10,
      armRBase: -1.55, armRSwing: -2.10, armRRoll: -0.14,
      armLBase: -1.10, armLRoll: 0.50,
    });
    // The finisher is a spin: a full extra body yaw that no other attack has.
    const a = ATTACK_TIMINGS.attack_3;
    const u = clamp01((t - a.windup) / (a.active + a.recovery * 0.55));
    o.rootRot[1] += ease.outCubic(u) * TAU * 0.42 * (t > a.windup ? 1 : 0);
    o.rootRot[0] += -0.10 + ease.outQuad(u) * 0.20;
    o.rootPos[1] += Math.sin(u * Math.PI) * 0.16 * hs;
  },
});

define('attack_heavy', {
  duration: ATTACK_TIMINGS.attack_heavy.duration, loop: false, bindWeight: 0.05,
  events: [{ t: 0.02, name: 'telegraph', sfx: 'enemy_windup' },
    { t: ATTACK_TIMINGS.attack_heavy.windup, name: 'swing', sfx: 'swing_heavy' },
    { t: ATTACK_TIMINGS.attack_heavy.windup + ATTACK_TIMINGS.attack_heavy.active, name: 'recover' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const a = ATTACK_TIMINGS.attack_heavy;
    // Long windup: the weapon goes all the way overhead and *stays* there, shaking. That hold
    // is the telegraph — ART_BAR's Hades benchmark is "readable with the sound off".
    if (t < a.windup) {
      const u = clamp01(t / a.windup);
      const rise = ease.outCubic(clamp01(u / 0.55));
      const hold = clamp01((u - 0.55) / 0.45);
      const shake = Math.sin(t * TAU * 11) * 0.035 * hold;
      o.j.armR.r[0] += -2.55 * rise + shake;
      o.j.armL.r[0] += -2.05 * rise - shake;
      o.j.armR.r[2] += -0.30 * rise;
      o.j.armL.r[2] += 0.44 * rise;
      o.j.torso.r[0] += -0.40 * rise;
      o.j.torso.r[1] += -0.42 * rise;
      o.j.hips.r[1] += -0.26 * rise;
      o.j.head.r[0] += -0.30 * rise;
      o.rootRot[0] += -0.22 * rise;
      o.rootPos[1] += 0.20 * rise * hs;
      o.rootScale[1] = 1 + 0.09 * rise;
      o.rootScale[0] = 1 - 0.05 * rise; o.rootScale[2] = o.rootScale[0];
      o.j.legR.r[0] += -0.34 * rise;
      o.j.legL.r[0] += 0.20 * rise;
    } else {
      const u = clamp01((t - a.windup) / (a.active + a.recovery));
      const k = ease.outExpo(clamp01(u / 0.24));
      const set = settle(u * (a.active + a.recovery), 1.9, 5.0) * 0.24 * (1 - u);
      o.j.armR.r[0] += lerp(-2.55, 0.95, k) + set;
      o.j.armL.r[0] += lerp(-2.05, 0.30, k) - set * 0.6;
      o.j.armR.r[2] += lerp(-0.30, -0.10, k);
      o.j.armL.r[2] += lerp(0.44, 0.28, k);
      o.j.torso.r[0] += lerp(-0.40, 0.72, k) + set * 0.5;
      o.j.torso.r[1] += lerp(-0.42, 0.36, k);
      o.j.hips.r[1] += lerp(-0.26, 0.24, k);
      o.j.head.r[0] += lerp(-0.30, 0.46, k);
      o.rootRot[0] += lerp(-0.22, 0.26, k);
      o.rootPos[1] += lerp(0.20, -0.12, k) * hs;
      o.rootPos[2] += k * 0.34 * hs * (1 - u * 0.4);
      o.rootScale[1] = lerp(1.09, 0.90, k) + (1 - k) * 0;
      o.rootScale[0] = lerp(0.95, 1.07, k); o.rootScale[2] = o.rootScale[0];
      o.j.legR.r[0] += lerp(-0.34, 0.50, k);
      o.j.legL.r[0] += lerp(0.20, -0.36, k);
      o.j.legL.r[2] += 0.12;
      o.j.legR.r[2] += -0.16;
    }
  },
});

define('attack_air', {
  duration: ATTACK_TIMINGS.attack_air.duration, loop: false, bindWeight: 0.05,
  events: [{ t: ATTACK_TIMINGS.attack_air.windup, name: 'swing', sfx: 'swing_whoosh' },
    { t: ATTACK_TIMINGS.attack_air.windup + ATTACK_TIMINGS.attack_air.active, name: 'recover' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const a = ATTACK_TIMINGS.attack_air;
    // Dive strike: tuck, then a downward chop with the legs trailing behind.
    const u = clamp01(t / a.duration);
    const wind = ease.outCubic(clamp01(t / a.windup));
    const strike = t > a.windup ? ease.outExpo(clamp01((t - a.windup) / (a.active + a.recovery * 0.5))) : 0;
    o.j.armR.r[0] += -2.60 * wind + 3.30 * strike;
    o.j.armL.r[0] += -1.40 * wind + 1.10 * strike;
    o.j.armR.r[2] += -0.22 - strike * 0.16;
    o.j.armL.r[2] += 0.52 - strike * 0.18;
    o.j.legL.r[0] += 0.90 * wind - 1.05 * strike;
    o.j.legR.r[0] += 0.55 * wind - 0.60 * strike;
    o.j.legL.r[2] += 0.16;
    o.j.legR.r[2] += -0.22;
    o.rootRot[0] += -0.35 * wind + 0.80 * strike;
    o.j.torso.r[1] += 0.30 * wind - 0.40 * strike;
    o.j.head.r[0] += -0.26 * wind + 0.40 * strike;
    o.rootPos[1] += (0.16 * wind - 0.30 * strike) * hs;
    o.rootScale[1] = 1 + 0.10 * wind - 0.12 * strike;
    o.rootScale[0] = 1 - 0.05 * wind + 0.07 * strike;
    o.rootScale[2] = o.rootScale[0];
    o.rootRot[1] += Math.sin(u * Math.PI) * 0.24;
  },
});

// --- defence ---------------------------------------------------------------

define('block_idle', {
  duration: 1.4, loop: true, bindWeight: 0.10,
  build(o, t, ctx) {
    const hs = ctx.hs;
    const b = Math.sin(t * TAU / 1.4);
    // Both arms in, shoulder turned to the threat, weight back. The turned shoulder is what
    // separates "blocking" from "idling with arms up" in a black cutout.
    o.j.armL.r[0] += -1.42 + b * 0.03;
    o.j.armR.r[0] += -1.06 - b * 0.03;
    o.j.armL.r[2] += 0.66;
    o.j.armR.r[2] += -0.40;
    o.j.armL.p[2] += 0.20 * hs;
    o.j.armR.p[2] += 0.10 * hs;
    o.j.torso.r[1] += 0.46;
    o.j.hips.r[1] += 0.30;
    o.j.head.r[1] += -0.22;
    o.j.head.r[0] += 0.10;
    o.rootRot[0] += -0.12;
    o.j.legL.r[0] += -0.18;
    o.j.legR.r[0] += 0.26;
    o.j.legR.r[2] += -0.14;
    o.rootPos[1] += -0.05 * hs + b * 0.012 * hs;
  },
});

define('block_impact', {
  duration: 0.28, loop: false, bindWeight: 0.08,
  events: [{ t: 0, name: 'blocked', sfx: 'block' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const u = clamp01(t / 0.28);
    const shock = Math.exp(-u * 6.5) * Math.cos(u * TAU * 3.1);
    // Same guard as block_idle, driven backwards and rattled.
    o.j.armL.r[0] += -1.42 + shock * 0.42;
    o.j.armR.r[0] += -1.06 + shock * 0.30;
    o.j.armL.r[2] += 0.66 + shock * 0.20;
    o.j.armR.r[2] += -0.40 - shock * 0.14;
    o.j.torso.r[1] += 0.46 - shock * 0.24;
    o.j.torso.r[0] += -shock * 0.26;
    o.j.hips.r[1] += 0.30;
    o.j.head.r[0] += shock * 0.30;
    o.rootPos[2] += -Math.exp(-u * 5.0) * 0.34 * hs;
    o.rootPos[1] += -0.05 * hs;
    o.rootRot[0] += -0.12 - shock * 0.10;
    o.j.legL.r[0] += -0.30;
    o.j.legR.r[0] += 0.40;
    o.rootScale[0] = 1 + Math.exp(-u * 8) * 0.05;
    o.rootScale[1] = 1 - Math.exp(-u * 8) * 0.04;
    o.rootScale[2] = o.rootScale[0];
  },
});

define('parry', {
  duration: 0.34, loop: false, bindWeight: 0.06,
  events: [{ t: 0.04, name: 'parry', sfx: 'parry' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const u = clamp01(t / 0.34);
    // A deflection, not a brace: one arm snaps across the body and the whole torso opens.
    const snap = ease.outExpo(clamp01(u / 0.22));
    const back = ease.outCubic(clamp01((u - 0.30) / 0.70));
    const s = snap - back * 0.85;
    o.j.armR.r[0] += -1.30 * s;
    o.j.armR.r[2] += 1.05 * s;
    o.j.armR.r[1] += -0.55 * s;
    o.j.armL.r[0] += -0.34 * s;
    o.j.armL.r[2] += 0.72 * s;
    o.j.torso.r[1] += -0.62 * s;
    o.j.hips.r[1] += -0.30 * s;
    o.j.head.r[1] += 0.28 * s;
    o.j.head.r[0] += -0.16 * s;
    o.rootRot[1] += -0.26 * s;
    o.rootPos[1] += 0.10 * s * hs;
    o.j.legL.r[0] += -0.30 * s;
    o.j.legR.r[0] += 0.22 * s;
    o.rootScale[1] = 1 + s * 0.06;
    o.rootScale[0] = 1 - s * 0.035; o.rootScale[2] = o.rootScale[0];
  },
});

define('dodge_roll', {
  duration: 0.62, loop: false, bindWeight: 0.02,
  events: [{ t: 0.0, name: 'dodge', sfx: 'dodge_woosh' }, { t: 0.46, name: 'dodge_end' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const u = clamp01(t / 0.62);
    // A real forward roll: the root pitches through a full turn and the body tucks at the apex.
    const spin = ease.inOutCubic(clamp01(u / 0.78));
    const tuck = Math.sin(clamp01(u / 0.78) * Math.PI);
    o.rootRot[0] += spin * TAU;
    o.rootPos[1] += -tuck * 0.42 * hs;
    o.rootScale[1] = 1 - tuck * 0.14;
    o.rootScale[0] = 1 + tuck * 0.10; o.rootScale[2] = o.rootScale[0];
    o.j.legL.r[0] += tuck * 1.55;
    o.j.legR.r[0] += tuck * 1.25;
    o.j.torso.r[0] += tuck * 0.75;
    o.j.armL.r[0] += tuck * 1.30;
    o.j.armR.r[0] += tuck * 1.02;
    o.j.armL.r[2] += 0.30 + tuck * 0.20;
    o.j.armR.r[2] += -0.24 - tuck * 0.26;
    o.j.head.r[0] += tuck * 0.60;
    // Recovery beat once the roll ends: come up on one knee, then stand.
    if (u > 0.78) {
      const r = clamp01((u - 0.78) / 0.22);
      const up = ease.outBack(r);
      o.j.legL.r[0] += (1 - up) * 0.75;
      o.j.torso.r[0] += (1 - up) * 0.38;
      o.rootPos[1] += -(1 - up) * 0.20 * hs;
      o.j.armR.r[0] += (1 - up) * 0.60;
    }
  },
});

define('dodge_dash', {
  duration: 0.34, loop: false, bindWeight: 0.05,
  events: [{ t: 0.0, name: 'dodge', sfx: 'dodge_woosh' }, { t: 0.24, name: 'dodge_end' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const u = clamp01(t / 0.34);
    // A hard sidestep: the body leans out of the line and trails behind the hips.
    const burst = ease.outExpo(clamp01(u / 0.30));
    const back = ease.outCubic(clamp01((u - 0.42) / 0.58));
    const s = burst - back;
    o.rootRot[2] += -0.46 * s;
    o.rootRot[1] += 0.30 * s;
    o.rootPos[1] += -0.14 * s * hs;
    o.j.hips.r[1] += 0.26 * s;
    o.j.torso.r[1] += -0.34 * s;
    o.j.torso.r[2] += -0.22 * s;
    o.j.armL.r[0] += -1.05 * s;
    o.j.armL.r[2] += 0.92 * s;
    o.j.armR.r[0] += 0.62 * s;
    o.j.armR.r[2] += -0.50 * s;
    o.j.legL.r[0] += -0.72 * s;
    o.j.legR.r[0] += 0.58 * s;
    o.j.legR.r[2] += -0.34 * s;
    o.j.head.r[1] += -0.34 * s;
    o.rootScale[1] = 1 + s * 0.07;
    o.rootScale[0] = 1 - s * 0.04; o.rootScale[2] = o.rootScale[0];
  },
});

// --- damage ----------------------------------------------------------------

define('hit_light', {
  duration: 0.26, loop: false, bindWeight: 0.55,
  events: [{ t: 0, name: 'hurt', sfx: 'hit_flesh' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const u = clamp01(t / 0.26);
    const s = Math.exp(-u * 7.0) * Math.cos(u * TAU * 2.6);
    o.j.torso.r[0] += -s * 0.40;
    o.j.torso.r[1] += s * 0.26;
    o.j.head.r[0] += -s * 0.55;
    o.j.head.r[1] += s * 0.30;
    o.j.armL.r[0] += s * 0.62;
    o.j.armR.r[0] += s * 0.34;
    o.j.armL.r[2] += s * 0.30;
    o.j.armR.r[2] += -s * 0.18;
    o.rootPos[2] += -Math.exp(-u * 6) * 0.18 * hs;
    o.rootRot[0] += -s * 0.14;
    o.rootScale[0] = 1 + Math.exp(-u * 9) * 0.06;
    o.rootScale[1] = 1 - Math.exp(-u * 9) * 0.05;
    o.rootScale[2] = o.rootScale[0];
  },
});

define('hit_heavy', {
  duration: 0.52, loop: false, bindWeight: 0.28,
  events: [{ t: 0, name: 'hurt', sfx: 'hit_flesh' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const u = clamp01(t / 0.52);
    const s = Math.exp(-u * 4.2) * Math.cos(u * TAU * 1.7);
    o.rootRot[0] += -s * 0.55;
    o.rootRot[2] += s * 0.24;
    o.j.torso.r[0] += -s * 0.62;
    o.j.torso.r[1] += s * 0.48;
    o.j.head.r[0] += -s * 0.85;
    o.j.head.r[1] += s * 0.44;
    o.j.armL.r[0] += s * 1.25;
    o.j.armR.r[0] += s * 0.80;
    o.j.armL.r[2] += s * 0.55;
    o.j.armR.r[2] += -s * 0.36;
    o.j.legL.r[0] += -s * 0.42;
    o.j.legR.r[0] += s * 0.30;
    o.rootPos[2] += -Math.exp(-u * 3.6) * 0.52 * hs;
    o.rootPos[1] += Math.exp(-u * 5) * 0.10 * hs;
    o.rootScale[0] = 1 + Math.exp(-u * 6) * 0.10;
    o.rootScale[1] = 1 - Math.exp(-u * 6) * 0.08;
    o.rootScale[2] = o.rootScale[0];
  },
});

define('stagger', {
  duration: 0.90, loop: false, bindWeight: 0.20,
  events: [{ t: 0, name: 'stagger', sfx: 'guard_break' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const u = clamp01(t / 0.90);
    // Two failing steps backwards, arms windmilling out of phase. Reads as "off balance".
    const wob = Math.sin(u * TAU * 2.2) * (1 - u * 0.6);
    const drop = Math.sin(u * Math.PI) * 0.5 + (1 - u) * 0.5;
    o.rootRot[0] += -0.34 * drop;
    o.rootRot[2] += wob * 0.20;
    o.rootPos[1] += -0.18 * drop * hs;
    o.j.hips.r[2] += wob * 0.18;
    o.j.torso.r[0] += -0.30 * drop;
    o.j.torso.r[1] += wob * 0.38;
    o.j.head.r[0] += -0.42 * drop;
    o.j.head.r[1] += wob * 0.30;
    o.j.armL.r[0] += -1.15 * drop + wob * 0.55;
    o.j.armR.r[0] += -0.70 * drop - wob * 0.70;
    o.j.armL.r[2] += 0.62 * drop;
    o.j.armR.r[2] += -0.78 * drop;
    o.j.legL.r[0] += -0.55 * drop + wob * 0.34;
    o.j.legR.r[0] += 0.42 * drop - wob * 0.30;
  },
});

define('knockdown', {
  duration: 0.85, loop: false, bindWeight: 0.02,
  events: [{ t: 0.0, name: 'hurt', sfx: 'hit_flesh' }, { t: 0.34, name: 'floor', sfx: 'land_hard' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const u = clamp01(t / 0.85);
    // Thrown onto the back: the root pitches past 90 degrees and slides.
    const fall = ease.inQuad(clamp01(u / 0.40));
    const bounce = u > 0.40 ? Math.exp(-(u - 0.40) * 12) * Math.abs(Math.sin((u - 0.40) * 22)) : 0;
    o.rootRot[0] += -fall * 1.52;
    o.rootRot[2] += fall * 0.22;
    o.rootPos[1] += (-fall * 1.05 + bounce * 0.18) * hs;
    o.rootPos[2] += -fall * 0.85 * hs;
    o.j.legL.r[0] += fall * 1.05;
    o.j.legR.r[0] += fall * 0.62;
    o.j.legL.r[2] += fall * 0.26;
    o.j.armL.r[0] += -fall * 1.55;
    o.j.armR.r[0] += -fall * 1.05;
    o.j.armL.r[2] += fall * 0.70;
    o.j.armR.r[2] += -fall * 0.42;
    o.j.head.r[0] += -fall * 0.30 + bounce * 0.30;
    o.j.torso.r[0] += fall * 0.34;
  },
});

define('getup', {
  duration: 0.95, loop: false, bindWeight: 0.35,
  events: [{ t: 0.55, name: 'getup_stand' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const u = clamp01(t / 0.95);
    // Roll onto one hip, push with the near hand, rise. The pushing hand is the read.
    const lie = 1 - ease.inOutCubic(clamp01(u / 0.82));
    const push = Math.sin(clamp01(u / 0.70) * Math.PI);
    o.rootRot[0] += -lie * 1.52;
    o.rootRot[2] += lie * 0.20 - push * 0.10;
    o.rootPos[1] += -lie * 1.05 * hs;
    o.j.armR.r[0] += lie * 1.30 + push * 0.55;
    o.j.armR.r[2] += -lie * 0.36 - push * 0.30;
    o.j.armL.r[0] += -lie * 1.35 + push * 0.30;
    o.j.armL.r[2] += lie * 0.62;
    o.j.legL.r[0] += lie * 1.30 - push * 0.20;
    o.j.legR.r[0] += lie * 0.55;
    o.j.torso.r[0] += lie * 0.42 + push * 0.20;
    o.j.head.r[0] += -lie * 0.20 - push * 0.24;
    if (u > 0.82) {
      const w = ease.outBack(clamp01((u - 0.82) / 0.18));
      o.rootPos[1] += (1 - w) * 0.08 * hs;
      o.j.torso.r[0] += (1 - w) * 0.16;
    }
  },
});

define('death', {
  duration: 1.5, loop: false, bindWeight: 0.02,
  events: [{ t: 0.0, name: 'death', sfx: 'death_enemy' }, { t: 0.7, name: 'death_settled' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const u = clamp01(t / 1.5);
    // Stagger, buckle at the knees, fall sideways. Sideways, not backwards — a back-fall reads
    // as a knockdown and this must not be confused with one.
    const buckle = ease.inQuad(clamp01(u / 0.30));
    const topple = ease.inQuad(clamp01((u - 0.22) / 0.42));
    const rest = clamp01((u - 0.60) / 0.40);
    o.rootRot[2] += topple * 1.52;
    o.rootRot[0] += -buckle * 0.32 + topple * 0.16;
    o.rootPos[1] += (-buckle * 0.30 - topple * 0.72) * hs;
    o.rootPos[0] += topple * 0.55 * hs;
    o.j.legL.r[0] += buckle * 0.95 - topple * 0.30;
    o.j.legR.r[0] += buckle * 0.62 - topple * 0.10;
    o.j.torso.r[0] += buckle * 0.55 - topple * 0.25;
    o.j.torso.r[2] += -topple * 0.22;
    o.j.armL.r[0] += buckle * 0.40 - topple * 1.10;
    o.j.armR.r[0] += buckle * 0.70 - topple * 0.55;
    o.j.armL.r[2] += topple * 0.55;
    o.j.armR.r[2] += -topple * 0.34;
    o.j.head.r[0] += buckle * 0.55 - topple * 0.20;
    o.j.head.r[2] += topple * 0.30;
    // Final settle so the body is not perfectly still the instant it lands.
    o.rootRot[2] += settle(rest * 1.5, 1.3, 3.2) * 0.05 * (1 - rest);
    o.rootScale[1] = 1 - topple * 0.05;
    o.rootScale[0] = 1 + topple * 0.04; o.rootScale[2] = o.rootScale[0];
  },
});

// --- fruit powers ----------------------------------------------------------

define('fruit_cast_a', {
  duration: 0.55, loop: false, bindWeight: 0.06,
  events: [{ t: 0.20, name: 'cast', sfx: 'gomu_stretch' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const u = clamp01(t / 0.55);
    // Wind the whole body back over the right hip, then throw the arm out straight ahead.
    const wind = ease.outCubic(clamp01(u / 0.36));
    const thrust = u > 0.36 ? ease.outExpo(clamp01((u - 0.36) / 0.30)) : 0;
    const back = u > 0.66 ? ease.outCubic(clamp01((u - 0.66) / 0.34)) : 0;
    const s = wind - back;
    const p = thrust - back;
    o.j.armR.r[0] += 0.85 * s - 2.40 * p;
    o.j.armR.r[2] += -0.55 * s + 0.20 * p;
    o.j.armR.p[2] += p * 0.24 * hs;
    o.j.armL.r[0] += -0.55 * s + 0.30 * p;
    o.j.armL.r[2] += 0.52 * s;
    o.j.torso.r[1] += -0.60 * s + 0.85 * p;
    o.j.hips.r[1] += -0.34 * s + 0.42 * p;
    o.j.head.r[1] += -0.24 * s + 0.34 * p;
    o.j.head.r[0] += -0.10 * s - 0.12 * p;
    o.rootRot[0] += -0.14 * s + 0.20 * p;
    o.rootPos[2] += p * 0.16 * hs;
    o.j.legR.r[0] += -0.34 * s + 0.20 * p;
    o.j.legL.r[0] += 0.24 * s - 0.30 * p;
    o.rootScale[1] = 1 + s * 0.05 - p * 0.06;
    o.rootScale[0] = 1 - s * 0.03 + p * 0.04; o.rootScale[2] = o.rootScale[0];
  },
});

define('fruit_cast_b', {
  duration: 0.72, loop: false, bindWeight: 0.05,
  events: [{ t: 0.34, name: 'cast', sfx: 'mera_whoosh' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const u = clamp01(t / 0.72);
    // Overhead two-hand slam. Distinct from cast_a in axis: vertical, not horizontal.
    const rise = ease.outCubic(clamp01(u / 0.46));
    const slam = u > 0.46 ? ease.outExpo(clamp01((u - 0.46) / 0.26)) : 0;
    const back = u > 0.78 ? ease.outCubic(clamp01((u - 0.78) / 0.22)) : 0;
    const s = rise - back, p = slam - back;
    o.j.armL.r[0] += -2.75 * s + 2.10 * p;
    o.j.armR.r[0] += -2.45 * s + 1.75 * p;
    o.j.armL.r[2] += 0.34 * s - 0.20 * p;
    o.j.armR.r[2] += -0.46 * s + 0.24 * p;
    o.j.torso.r[0] += -0.42 * s + 0.75 * p;
    o.j.torso.r[1] += 0.18 * s - 0.24 * p;
    o.j.head.r[0] += -0.46 * s + 0.55 * p;
    o.rootRot[0] += -0.20 * s + 0.30 * p;
    o.rootPos[1] += (0.26 * s - 0.34 * p) * hs;
    o.j.legL.r[0] += -0.24 * s + 0.44 * p;
    o.j.legR.r[0] += 0.16 * s - 0.26 * p;
    o.j.legR.r[2] += -0.14;
    o.rootScale[1] = 1 + s * 0.11 - p * 0.14;
    o.rootScale[0] = 1 - s * 0.06 + p * 0.09; o.rootScale[2] = o.rootScale[0];
  },
});

define('fruit_channel', {
  duration: 1.6, loop: true, bindWeight: 0.04,
  build(o, t, ctx) {
    const hs = ctx.hs;
    // Held power: arms out and low, body arched back, everything trembling at 7 Hz.
    const pulse = Math.sin(t * TAU / 1.6);
    const tremor = Math.sin(t * TAU * 7.0) * 0.028;
    o.j.armL.r[0] += -0.95 + pulse * 0.14 + tremor;
    o.j.armR.r[0] += -0.72 - pulse * 0.12 - tremor;
    o.j.armL.r[2] += 1.05 + pulse * 0.10;
    o.j.armR.r[2] += -0.90 - pulse * 0.12;
    o.j.torso.r[0] += -0.26 - pulse * 0.06;
    o.j.head.r[0] += -0.40 - pulse * 0.08 + tremor * 0.5;
    o.rootRot[0] += -0.18;
    o.rootPos[1] += (0.10 + pulse * 0.05) * hs;
    o.j.legL.r[0] += -0.20;
    o.j.legR.r[0] += 0.26;
    o.j.legL.r[2] += 0.18;
    o.j.legR.r[2] += -0.22;
    o.rootScale[1] = 1.03 + pulse * 0.02;
    o.rootScale[0] = 0.985 - pulse * 0.012; o.rootScale[2] = o.rootScale[0];
  },
});

// --- ship, social ----------------------------------------------------------

define('ship_steer', {
  duration: 3.0, loop: true, bindWeight: 0.14,
  build(o, t, ctx) {
    const hs = ctx.hs;
    // Hands fixed on the wheel; the deck moves the body, not the other way round. `ctx.deckRoll`
    // is written by the ship system; falling back to a slow swell keeps it alive when moored.
    const roll = ctx.deckRoll !== undefined ? ctx.deckRoll : Math.sin(t * TAU / 3.0) * 0.18;
    const pitch = ctx.deckPitch !== undefined ? ctx.deckPitch : Math.sin(t * TAU / 4.3 + 1.1) * 0.10;
    o.j.armL.r[0] += -1.62;
    o.j.armR.r[0] += -1.48;
    o.j.armL.r[2] += 0.50 - roll * 0.8;
    o.j.armR.r[2] += -0.62 - roll * 0.8;
    o.j.armL.p[2] += 0.30 * hs;
    o.j.armR.p[2] += 0.30 * hs;
    o.j.hips.r[2] += roll * 0.55;
    o.j.torso.r[2] += -roll * 0.30;
    o.j.head.r[2] += -roll * 0.22;
    o.j.torso.r[0] += pitch * 0.4;
    o.j.head.r[0] += -pitch * 0.7 - 0.10;
    o.j.legL.r[2] += roll * 0.20 + 0.10;
    o.j.legR.r[2] += roll * 0.14 - 0.16;
    o.rootPos[1] += -pitch * 0.10 * hs;
    headLead(o, ctx, 0.8);
  },
});

define('ship_idle', {
  duration: 4.2, loop: true, bindWeight: 0.72,
  build(o, t, ctx) {
    const hs = ctx.hs;
    const roll = ctx.deckRoll !== undefined ? ctx.deckRoll : Math.sin(t * TAU / 4.2) * 0.14;
    // Sea legs: knees absorb the roll, arms hang loose and lag it.
    const lag = ctx.deckRoll !== undefined ? roll : Math.sin((t - 0.35) * TAU / 4.2) * 0.14;
    o.j.hips.r[2] += roll * 0.70;
    o.j.torso.r[2] += -roll * 0.34;
    o.j.head.r[2] += -roll * 0.30;
    o.j.armL.r[2] += 0.20 - lag * 1.10;
    o.j.armR.r[2] += -0.28 - lag * 0.95;
    o.j.armL.r[0] += -0.14;
    o.j.armR.r[0] += -0.06;
    o.j.legL.r[2] += roll * 0.26 + 0.08;
    o.j.legR.r[2] += roll * 0.18 - 0.12;
    o.rootPos[0] += roll * 0.10 * hs;
    o.rootPos[1] += -Math.abs(roll) * 0.10 * hs;
    o.j.torso.p[1] += Math.sin(t * TAU / 3.4) * 0.024 * hs;
    headLead(o, ctx, 0.9);
  },
});

define('sit', {
  duration: 5.0, loop: true, bindWeight: 0.10,
  build(o, t, ctx) {
    const hs = ctx.hs;
    const br = Math.sin(t * TAU / 4.1);
    // Seated: hips drop, thighs forward. One arm rests on a knee, the other props behind.
    o.rootPos[1] += -0.70 * hs;
    o.j.legL.r[0] += 1.42;
    o.j.legR.r[0] += 1.30;
    o.j.legL.r[2] += 0.16;
    o.j.legR.r[2] += -0.24;
    o.j.torso.r[0] += 0.18 + br * 0.03;
    o.j.torso.r[1] += 0.12;
    o.j.armL.r[0] += 0.62 + br * 0.05;
    o.j.armL.r[2] += 0.42;
    o.j.armR.r[0] += -0.34 - br * 0.04;
    o.j.armR.r[2] += -0.62;
    o.j.head.r[0] += 0.10 + br * 0.04;
    o.j.head.r[1] += Math.sin(t * TAU / 6.7) * 0.30;
    headLead(o, ctx, 0.5);
  },
});

define('talk', {
  duration: 2.7, loop: true, bindWeight: 0.55,
  build(o, t, ctx) {
    const hs = ctx.hs;
    // Speech gestures: the hands beat, and the beats are not evenly spaced.
    const a = Math.sin(t * TAU / 0.9);
    const b = Math.sin(t * TAU / 1.37 + 0.8);
    o.j.armR.r[0] += -0.62 - Math.max(0, a) * 0.42;
    o.j.armR.r[2] += -0.34 - b * 0.16;
    o.j.armL.r[0] += -0.24 - Math.max(0, b) * 0.26;
    o.j.armL.r[2] += 0.30;
    o.j.torso.r[1] += b * 0.10;
    o.j.head.r[0] += a * 0.08 - 0.04;
    o.j.head.r[1] += b * 0.16;
    o.j.head.r[2] += a * 0.06;
    o.j.torso.p[1] += Math.sin(t * TAU / 3.3) * 0.020 * hs;
    stancePlant(o, 1, 0.4, hs);
    headLead(o, ctx, 1);
  },
});

define('cheer', {
  duration: 1.15, loop: true, bindWeight: 0.04,
  events: [{ t: 0.10, name: 'cheer' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const u = (t % 1.15) / 1.15;
    // Both fists up and a hop — but the arms punch at different heights and times.
    const hop = Math.max(0, Math.sin(u * TAU));
    const punchA = Math.max(0, Math.sin(u * TAU * 2));
    const punchB = Math.max(0, Math.sin(u * TAU * 2 - 0.9));
    o.rootPos[1] += hop * 0.34 * hs;
    o.rootScale[1] = 1 + hop * 0.08 - (1 - hop) * 0.03;
    o.rootScale[0] = 1 - hop * 0.05 + (1 - hop) * 0.02;
    o.rootScale[2] = o.rootScale[0];
    o.j.armL.r[0] += -2.55 - punchA * 0.40;
    o.j.armR.r[0] += -2.20 - punchB * 0.55;
    o.j.armL.r[2] += 0.34;
    o.j.armR.r[2] += -0.52;
    o.j.legL.r[0] += -hop * 0.55;
    o.j.legR.r[0] += -hop * 0.34;
    o.j.legL.r[2] += 0.14;
    o.j.legR.r[2] += -0.20;
    o.j.torso.r[0] += -0.20 - punchA * 0.10;
    o.j.head.r[0] += -0.34 - punchA * 0.12;
    o.j.head.r[1] += Math.sin(u * TAU) * 0.14;
  },
});

define('point', {
  duration: 2.2, loop: true, bindWeight: 0.30,
  events: [{ t: 0.16, name: 'point' }],
  build(o, t, ctx) {
    const hs = ctx.hs;
    const u = clamp01(t / 0.34);
    const hold = ease.outBack(u);
    const drift = Math.sin(t * TAU / 2.2) * 0.05;
    // Arm locked out along the sight line, the other hand tucked at the waist, head aligned.
    o.j.armR.r[0] += -1.62 * hold + drift;
    o.j.armR.r[2] += -0.22 * hold;
    o.j.armR.r[1] += -0.30 * hold;
    o.j.armR.p[2] += 0.22 * hold * hs;
    o.j.armL.r[0] += 0.34;
    o.j.armL.r[2] += 0.66;
    o.j.torso.r[1] += 0.30 * hold;
    o.j.hips.r[1] += 0.18 * hold;
    o.j.head.r[1] += 0.16 * hold + drift * 0.5;
    o.j.head.r[0] += -0.12 * hold;
    o.rootPos[2] += 0.06 * hold * hs;
    stancePlant(o, -1, 0.5, hs);
    headLead(o, ctx, 0.7);
  },
});

/** Every state name the Animator can play. */
export const STATE_NAMES = Object.freeze(Object.keys(DEF));

/** Static metadata per state: duration, loop, cyclic. Read by actors and the self-check. */
export const STATE_META = Object.freeze(Object.fromEntries(
  STATE_NAMES.map((n) => [n, Object.freeze({
    duration: DEF[n].duration !== undefined ? DEF[n].duration : 1,
    loop: DEF[n].loop !== false,
    cyclic: !!DEF[n].cyclic,
    isAttack: !!ATTACK_TIMINGS[n],
  })]),
));

/** Build the full state set. One set per animator: AnimState holds a scratch pose. */
export function createStates() {
  const out = Object.create(null);
  for (const n of STATE_NAMES) out[n] = new AnimState(n, DEF[n]);
  return out;
}

// ---------------------------------------------------------------------------
// Animator
// ---------------------------------------------------------------------------

/** Default context. Actors overwrite the fields they own each step. */
function makeCtx() {
  return {
    bind: null, hs: 1, height: REF_HEIGHT,
    speed: 0, speedN: 0, phase: 0, turnRate: 0,
    grounded: true, inWater: false, submerged: false, vy: 0,
    deckRoll: undefined, deckPitch: undefined,
    glance: 0.5, hpFrac: 1,
  };
}

/**
 * Two-slot crossfading animator with a procedural secondary-motion layer.
 *
 * The secondary layer is what separates this from a pose sampler: hat lag, coat sway, arm
 * follow-through and squash all carry state across steps and are integrated at the fixed
 * simulation timestep, so they are identical on every machine regardless of frame rate.
 */
export class Animator {
  /**
   * @param {object} opts { seed, height, bind, states }
   */
  constructor(opts = {}) {
    this.seed = (opts.seed >>> 0) || 1;
    this.states = opts.states || createStates();
    this.ctx = makeCtx();
    this.ctx.height = opts.height || REF_HEIGHT;
    this.ctx.hs = this.ctx.height / REF_HEIGHT;
    this.ctx.bind = opts.bind || null;

    this.current = null;
    this.previous = null;
    this.time = 0;          // seconds in `current`
    this.prevTime = 0;      // seconds in `previous`, frozen at the moment of the blend
    this.blend = 1;         // 0 = fully previous, 1 = fully current
    this.blendRate = 0;     // 1/seconds
    this.finished = false;  // current is a one-shot that has run past its duration

    this._a = makePose();
    this._b = makePose();
    this._mix = makePose();
    this.pose = makePose();

    this._hooks = Object.create(null);
    this._firedEvents = 0;      // index into current state's events list
    this._prevPhase = 0;
    this._sec = null;
    this.rng = null;
    this.reset();
  }

  /** Reset every scrap of internal state. Two animators reset from the same seed match exactly. */
  reset() {
    this.rng = Rng.fromName(this.seed, 'anim');
    this.ctx.glance = this.rng.f();
    this.current = null;
    this.previous = null;
    this.time = 0;
    this.prevTime = 0;
    this.blend = 1;
    this.blendRate = 0;
    this.finished = false;
    this._firedEvents = 0;
    this._prevPhase = 0;
    this._sec = {
      hatX: { x: 0, v: 0 }, hatZ: { x: 0, v: 0 },
      coatX: { x: 0, v: 0 }, coatZ: { x: 0, v: 0 },
      armL: { x: 0, v: 0 }, armR: { x: 0, v: 0 },
      squash: { x: 1, v: 0 },
      lastHeadYaw: 0, lastRootRoll: 0, lastVy: 0,
    };
    resetPose(this.pose);
    return this;
  }

  /** Register an event hook. Events: footstep, swing, land, cast, dodge, hurt, end, ... */
  on(event, fn) {
    (this._hooks[event] || (this._hooks[event] = [])).push(fn);
    return this;
  }

  /** Remove all hooks for one event, or all hooks if no event is given. */
  off(event) {
    if (event === undefined) this._hooks = Object.create(null);
    else delete this._hooks[event];
    return this;
  }

  /** Fire an event to every hook. Hooks must not mutate simulation state that others read. */
  emit(event, data) {
    const list = this._hooks[event];
    if (!list) return;
    for (let i = 0; i < list.length; i++) list[i](data, this);
  }

  /**
   * Play a state, optionally crossfading into it.
   * @param {string} name state name from STATE_NAMES
   * @param {object} [opts] { blend: seconds, restart: boolean, offset: seconds }
   * @returns {Animator} this
   */
  play(name, opts = {}) {
    const st = this.states[name];
    if (!st) return this;
    if (this.current === st && !opts.restart) return this;
    const blendS = opts.blend !== undefined ? opts.blend : 0;
    if (this.current && blendS > 0) {
      this.previous = this.current;
      this.prevTime = this.time;
      this.blend = 0;
      this.blendRate = 1 / blendS;
    } else {
      this.previous = null;
      this.blend = 1;
      this.blendRate = 0;
    }
    this.current = st;
    this.time = opts.offset || 0;
    this.finished = false;
    this._firedEvents = 0;
    return this;
  }

  /** Crossfade into a state over `seconds`. Convenience wrapper on play(). */
  blendTo(name, seconds = 0.14) {
    return this.play(name, { blend: seconds });
  }

  /** Name of the state currently playing, or null. */
  get stateName() { return this.current ? this.current.name : null; }

  /** Normalised progress through a one-shot state (0..1). Loops report their cycle position. */
  get progress() {
    if (!this.current) return 0;
    const d = this.current.duration || 1;
    return this.current.loop ? (this.time % d) / d : clamp01(this.time / d);
  }

  /** Sub-phase of the current attack, or null when the current state is not an attack. */
  get attackPhase() {
    if (!this.current || !ATTACK_TIMINGS[this.current.name]) return null;
    return attackPhase(this.current.name, this.time);
  }

  /** Fire any state events crossed between t0 and t1. One-shot states fire each event once. */
  _fireEvents(t0, t1) {
    const st = this.current;
    if (st.events) {
      for (let i = this._firedEvents; i < st.events.length; i++) {
        const e = st.events[i];
        if (e.t <= t1 && (e.t > t0 || (t0 === 0 && e.t === 0))) {
          this._firedEvents = i + 1;
          this.emit(e.name, { state: st.name, sfx: e.sfx, foot: e.foot, t: e.t });
        } else if (e.t > t1) break;
      }
    }
    if (st.cycleEvents) {
      const p0 = this._prevPhase, p1 = this.ctx.phase;
      const wrapped = p1 < p0;
      for (const e of st.cycleEvents) {
        const crossed = wrapped ? (e.at > p0 || e.at <= p1) : (e.at > p0 && e.at <= p1);
        if (crossed) this.emit(e.name, { state: st.name, sfx: e.sfx, foot: e.foot, t: e.at });
      }
    }
  }

  /**
   * Advance one step and produce this step's pose.
   * @param {number} dt fixed timestep in seconds
   * @param {object} [ctx] fields to merge into the animation context before evaluating
   * @returns {object} the blended, secondary-motion-applied pose
   */
  update(dt, ctx) {
    if (ctx) {
      const c = this.ctx;
      for (const k in ctx) if (ctx[k] !== undefined) c[k] = ctx[k];
      c.hs = c.height / REF_HEIGHT;
    }
    if (!this.current) return this.pose;

    const t0 = this.time;
    this.time += dt;
    const st = this.current;
    if (!st.loop && this.time >= st.duration && !this.finished) {
      this.finished = true;
      this.emit('end', { state: st.name });
    }
    this._fireEvents(t0, this.time);
    this._prevPhase = this.ctx.phase;

    // Non-looping states hold their final frame rather than running off the end of their curve.
    const tCur = st.loop ? this.time : Math.min(this.time, st.duration);
    st.update(tCur, this.ctx, this._a);

    let src = this._a;
    if (this.previous && this.blend < 1) {
      this.blend = clamp01(this.blend + this.blendRate * dt);
      const pst = this.previous;
      const tPrev = pst.loop ? this.prevTime + (this.time - t0) : Math.min(this.prevTime, pst.duration);
      this.prevTime = pst.loop ? tPrev : this.prevTime;
      pst.update(tPrev, this.ctx, this._b);
      // smoothstep the crossfade: linear blends pop at both ends.
      const w = this.blend * this.blend * (3 - 2 * this.blend);
      blendPose(this._mix, this._b, this._a, w);
      src = this._mix;
      if (this.blend >= 1) this.previous = null;
    }

    copyPose(this.pose, src);
    this._secondary(dt, this.pose);
    return this.pose;
  }

  /**
   * Procedural secondary motion, applied on top of the blended pose.
   * Everything here is a damped follower: the driven value chases the driver, overshoots a
   * little, and settles. That overshoot is the difference between "posed" and "alive".
   */
  _secondary(dt, p) {
    const s = this._sec;
    const c = this.ctx;
    const hs = c.hs;

    // --- hat / hair lag ----------------------------------------------------
    // The hat is a mass on a stiff spring pinned to the head. Drive it with the head's angular
    // change plus the body's vertical acceleration; a straw brim that never moves reads as glued.
    const headYaw = p.j.head.r[1] + p.j.torso.r[1] + p.rootRot[1];
    const dYaw = angleDelta(s.lastHeadYaw, headYaw) / Math.max(dt, 1e-5);
    s.lastHeadYaw = headYaw;
    const rootRoll = p.j.hips.r[2] + p.rootRot[2];
    const dRoll = (rootRoll - s.lastRootRoll) / Math.max(dt, 1e-5);
    s.lastRootRoll = rootRoll;

    const hatTargetZ = clamp(-dRoll * 0.030 - c.speed * 0.010, -0.30, 0.30);
    const hatTargetX = clamp(-p.rootRot[0] * 0.22 - c.speed * 0.016 + (c.vy || 0) * 0.010, -0.35, 0.35);
    springStep(s.hatZ, hatTargetZ, 26, 0.42, dt);
    springStep(s.hatX, hatTargetX, 26, 0.42, dt);
    p.j.hat.r[2] += clamp(s.hatZ.x, -0.5, 0.5);
    p.j.hat.r[0] += clamp(s.hatX.x, -0.5, 0.5);
    p.j.hat.r[1] += clamp(-dYaw * 0.022, -0.24, 0.24);
    p.j.hat.p[1] += clamp(-(c.vy || 0) * 0.004, -0.05, 0.05) * hs;

    // --- coat / cape / fin sway -------------------------------------------
    // The coat trails the body: it lags yaw and it lifts with speed. Looser and slower than the
    // hat because it is cloth hanging off the shoulders, not a rigid brim clamped to a skull.
    const coatTX = clamp(-c.speed * 0.055 - (c.vy || 0) * 0.012, -0.75, 0.35);
    const coatTZ = clamp(-dRoll * 0.045 - dYaw * 0.030, -0.40, 0.40);
    springStep(s.coatX, coatTX, 13, 0.34, dt);
    springStep(s.coatZ, coatTZ, 13, 0.34, dt);
    p.j.extra.r[0] += clamp(s.coatX.x, -1.0, 0.6);
    p.j.extra.r[2] += clamp(s.coatZ.x, -0.6, 0.6);
    p.j.extra.r[1] += clamp(-dYaw * 0.040, -0.45, 0.45);

    // --- arm follow-through ------------------------------------------------
    // A second-order follower on each arm's pitch. Because it overshoots, the hand keeps
    // travelling for a beat after the shoulder stops — the single clearest "animated" cue.
    const tgtL = p.j.armL.r[0], tgtR = p.j.armR.r[0];
    springStep(s.armL, tgtL, 34, 0.55, dt);
    springStep(s.armR, tgtR, 34, 0.55, dt);
    const lagL = clamp(s.armL.x - tgtL, -1.2, 1.2);
    const lagR = clamp(s.armR.x - tgtR, -1.2, 1.2);
    p.j.armL.r[0] += lagL * -0.30;
    p.j.armR.r[0] += lagR * -0.30;
    // The weapon inherits the hand, plus a touch more, so the blade tip leads the wrist.
    p.j.weapon.r[0] += lagR * -0.22;
    p.j.weapon.r[2] += clamp(-dYaw * 0.020, -0.20, 0.20);

    // --- squash and stretch -------------------------------------------------
    // ~1–2 character voxels (0.25–0.5 m on a 4.25 m body) driven by vertical velocity, then
    // released with a spring. Scaling parts, never deforming the voxel volumes.
    const vy = c.vy || 0;
    let target = 1;
    if (!c.grounded) target = 1 + clamp(vy * 0.010, -0.06, 0.09);
    const dvy = (vy - s.lastVy) / Math.max(dt, 1e-5);
    s.lastVy = vy;
    if (c.grounded && dvy > 40) target = 1 - clamp(dvy * 0.0016, 0, 0.13);   // landing compression
    springStep(s.squash, target, 30, 0.62, dt);
    const sq = clamp(s.squash.x, 0.84, 1.16);
    p.rootScale[1] *= sq;
    const inv = 1 / Math.sqrt(sq);          // rough volume preservation; a pure y-scale reads as a bug
    p.rootScale[0] *= inv;
    p.rootScale[2] *= inv;
  }

  /**
   * Alias for update(). SHIP's CrewAboard duck-types an injected animator on `step` + `play`
   * (src/ship/crewaboard.js), and "step" is the name every other simulated thing in this codebase
   * uses for one fixed tick, so the Animator answers to both.
   * @param {number} dt @param {object} [ctx] @returns {object} pose
   */
  step(dt, ctx) { return this.update(dt, ctx); }

  /** Snapshot for save/replay. The secondary-motion state is derived, so it is not stored. */
  serialize() {
    return {
      state: this.current ? this.current.name : null,
      t: this.time,
      prev: this.previous ? this.previous.name : null,
      pt: this.prevTime,
      blend: this.blend,
      rate: this.blendRate,
      seed: this.seed,
    };
  }

  /** Restore from serialize(). Secondary motion restarts settled, which is invisible. */
  deserialize(o) {
    if (!o) return this;
    this.reset();
    if (o.seed !== undefined) this.seed = o.seed >>> 0;
    this.rng = Rng.fromName(this.seed, 'anim');
    this.ctx.glance = this.rng.f();
    if (o.state && this.states[o.state]) {
      this.current = this.states[o.state];
      this.time = o.t || 0;
      this.finished = !this.current.loop && this.time >= this.current.duration;
    }
    if (o.prev && this.states[o.prev]) {
      this.previous = this.states[o.prev];
      this.prevTime = o.pt || 0;
      this.blend = o.blend !== undefined ? o.blend : 1;
      this.blendRate = o.rate || 0;
    }
    return this;
  }
}

/**
 * Animator factory in the shape SHIP's CrewAboard wants: `(model, seed) => Animator`, where
 * `model` is a buildCharacter() result. The orchestrator wires it with
 * `crew.setAnimator(animatorForModel)`.
 * @param {object} model buildCharacter() output (or anything with `height` and `spec.pose`)
 * @param {number} seed
 * @returns {Animator}
 */
export function animatorForModel(model, seed) {
  const spec = model && model.spec ? model.spec : null;
  return new Animator({
    seed: (seed >>> 0) || 1,
    height: model && model.height ? model.height : REF_HEIGHT,
    bind: (spec && spec.pose) || (model && model.bindPose) || null,
  });
}

/**
 * Factory. Every actor gets its own Animator (and therefore its own state instances, because
 * AnimState carries a scratch pose that cannot be shared across actors in one step).
 * @param {object} opts { seed, height, bind }
 * @returns {Animator}
 */
export function createAnimator(opts = {}) {
  return new Animator(opts);
}
