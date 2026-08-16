// FruitSystem — the devil fruit facade.
//
// Registered by src/game.js as `app.fruit`, stepped in the `fruit` slot of ARCHITECTURE §4
// (after player, before combat) so a power's velocity and terrain writes land before anything
// resolves against them.
//
// This file owns three things the abilities do not:
//
//  1. TRAVERSAL. Each fruit gets a kit that rewrites how the player moves. The kits bind to two
//     verbs only — JUMP (the vertical/committing move) and SPRINT (the horizontal/anchoring
//     move) — because six fruits × five bespoke keys is a control scheme nobody learns. What
//     those two verbs *do* is completely different per fruit, and that difference is published
//     as `caps`, a machine-checkable set that tools/check-fruit.mjs asserts is unique per fruit.
//
//  2. THE SEA. Devil fruit users cannot swim. That is canon and it is a real constraint here:
//     deep water seals the meter, cancels the cast, drains health and takes control away. It is
//     also the single most likely way to soft-lock a new player, so the rescue path is not
//     optional — it is timed shorter before the tutorial completes, and it always ends with the
//     player standing on the nearest shore or deck rather than staring at a death screen.
//
//  3. THE WORLD EDITS. Freezing the sea, burning barriers, cracking shortcuts. Every edit is
//     recorded so temporary ones (ice) revert on a timer and all of them revert on load.
//
// Determinism: one named Rng stream, no wall clock, all timers driven by the fixed dt.

import { Rng } from '../core/rng.js';
import { P } from '../gen/palette.js';
import { clamp, clamp01, lerp, damp, TAU } from '../core/math.js';
import {
  ABILITIES, ABILITY_BY_ID, ABILITIES_BY_FRUIT, abilitiesFor,
  AbilityRunner, FruitContext, Meter, TRAVERSAL_FLAGS, blankCaps, capsSignature, MOVE_ANIM,
} from './abilities.js';
import { FruitFx, FRUIT_COLORS, registerFruitFxTiles } from './fruitfx.js';

export { registerFruitFxTiles, FRUIT_COLORS };

/** Canonical fruit order. Matches QUEST's FRUITS list; the wheel draws them in this order. */
export const FRUIT_IDS = Object.freeze(['gomu', 'mera', 'hie', 'suna', 'gura', 'zushi']);

// ---------------------------------------------------------------------------
// Traversal kits
// ---------------------------------------------------------------------------

/** Metres below the sea surface at which a devil fruit user starts drowning. */
const DROWN_DEPTH = 0.55;
/** Seconds of drowning before the rescue fires, before and after the tutorial. */
const RESCUE_EARLY = 2.0;
const RESCUE_LATE = 5.0;
/** Health per second lost in deep water. Halved before the tutorial completes. */
const DROWN_DPS = 7;

/**
 * A traversal kit. `step` runs every fixed step for the equipped fruit and may write velocity,
 * position and world voxels. It reads intents, never raw key codes.
 *
 * `mods` is refreshed every step and read by the player controller (ARCHITECTURE §9, FRUIT
 * request 2) — the controller applies friction/gravity/air control from it instead of its own
 * constants whenever `overriding` is set.
 */
class TraversalKit {
  /** @param {string} id @param {object} spec */
  constructor(id, spec) {
    this.id = id;
    this.caps = Object.assign(blankCaps(), spec.caps);
    this.signature = capsSignature(this.caps);
    this.blurb = spec.blurb;
    this.hint = spec.hint;
    this._enter = spec.enter || null;
    this._step = spec.step;
    this._exit = spec.exit || null;
  }

  enter(sys) { sys.kitState = Object.create(null); if (this._enter) this._enter(sys, sys.kitState); }
  step(sys, dt) { this._step(sys, sys.kitState, dt); }
  exit(sys) { if (this._exit) this._exit(sys, sys.kitState); sys.kitState = Object.create(null); }
}

// --- gomu: reach and momentum ----------------------------------------------

const KIT_GOMU = new TraversalKit('gomu', {
  caps: { canGrapple: true, canSuperJump: true },
  blurb: 'Rubber. Nothing you fall from can hurt you, and everything you hit gives back.',
  hint: 'Hold JUMP to compress and launch. SPRINT fires a grapple at whatever you are aiming at.',
  enter(sys, s) { s.charge = 0; s.zip = null; },
  step(sys, s, dt) {
    const b = sys.body, i = sys.intent;
    sys.mods.fallDamageMult = 0;               // rubber does not break on landing
    sys.mods.bounciness = 0.62;

    // --- compression super jump ---
    if (s.zip === null && b.grounded && i.jumpDown && sys.meter.can(1)) {
      s.charge = Math.min(1, s.charge + dt / 0.55);
      sys.suppressJump();                      // the compression eats the jump it just made
      sys.mods.speedMult = lerp(1, 0.25, s.charge);
      sys.setAnim('fruitCompress');
      sys.fx.setAura(P.fruitGomu, 0.2 + 0.5 * s.charge);
    } else if (s.charge > 0) {
      if (s.charge > 0.3 && sys.meter.spend(GOMU_JUMP_COST)) {
        const f = sys.forward();
        b.vy = lerp(9, 22, s.charge);
        b.vx += f.x * lerp(2, 9, s.charge);
        b.vz += f.z * lerp(2, 9, s.charge);
        b.grounded = false;
        sys.overriding = true;
        sys.sound('fruit_gomu_launch');
        sys.fx.gomuRecoil(b);
        sys.stats.traversalUses++;
      }
      s.charge = 0;
      sys.mods.overrideJump = false;
    }

    // --- grapple / zip ---
    if (s.zip === null && i.sprintPressed && sys.meter.can(GOMU_ZIP_COST)) {
      const anchor = sys.castAnchor(GOMU_ZIP_RANGE);
      if (anchor) {
        sys.meter.spend(GOMU_ZIP_COST);
        s.zip = anchor;
        s.zipT = 0;
        sys.sound('fruit_gomu_zip');
        sys.stats.traversalUses++;
      }
    }
    if (s.zip) {
      s.zipT += dt;
      const vx = s.zip.x - b.x, vy = s.zip.y - b.y, vz = s.zip.z - b.z;
      const len = Math.hypot(vx, vy, vz) || 1;
      sys.fx.gomuLimb({ ox: b.x, oy: b.y + 1.4, oz: b.z, dx: vx / len, dy: vy / len, dz: vz / len }, len);
      b.vx = vx / len * GOMU_ZIP_SPEED;
      b.vy = vy / len * GOMU_ZIP_SPEED + 2.5;   // arc over the lip instead of into it
      b.vz = vz / len * GOMU_ZIP_SPEED;
      b.grounded = false;
      sys.overriding = true;
      sys.mods.overrideVelocity = true;
      sys.setAnim('fruitGrapple');
      if (len < 2.2 || s.zipT > 2.0 || !i.sprintDown) {
        s.zip = null;
        sys.fx.gomuLimbEnd();
        sys.mods.overrideVelocity = false;
      }
    }

    // --- bounce ---
    // Landing hard converts the fall into height instead of into damage. This is what makes
    // a gomu traversal line feel like a pinball table rather than a series of stops.
    if (b.grounded && sys.prevVy < -GOMU_BOUNCE_MIN) {
      b.vy = -sys.prevVy * 0.62;
      b.grounded = false;
      sys.overriding = true;
      sys.fx.impactAt(b.x, b.y, b.z, 'gomu');
      sys.sound('fruit_gomu_bounce');
    }
  },
  exit(sys) { sys.fx.gomuLimbEnd(); },
});

const GOMU_JUMP_COST = 10;
const GOMU_ZIP_COST = 7;
const GOMU_ZIP_RANGE = 26;
const GOMU_ZIP_SPEED = 27;
const GOMU_BOUNCE_MIN = 12;

// --- mera: air mobility with a weather-shaped ceiling ----------------------

const KIT_MERA = new TraversalKit('mera', {
  caps: { canAirDash: true, canHover: true, canBreakTerrain: true },
  blurb: 'Flame. You travel through the air and through wooden walls — and rain takes it away.',
  hint: 'JUMP again in mid-air to dash. Hold SPRINT in the air to hover. Sprint into wood to burn through.',
  enter(sys, s) { s.dashes = MERA_AIR_DASHES; s.hoverT = 0; },
  step(sys, s, dt) {
    const b = sys.body, i = sys.intent;
    const power = sys.flameStrength;
    if (b.grounded) s.dashes = MERA_AIR_DASHES;
    sys.mods.airControlMult = 1.35;

    // --- limited air dashes ---
    if (!b.grounded && i.jumpPressed && s.dashes > 0 && power > 0.2 && sys.meter.spend(MERA_DASH_COST)) {
      const f = sys.moveOrForward();
      b.vx = f.x * MERA_DASH_SPEED * power;
      b.vz = f.z * MERA_DASH_SPEED * power;
      b.vy = Math.max(b.vy, 1.2);
      s.dashes--;
      sys.overriding = true;
      sys.mods.overrideJump = true;
      sys.setAnim('fruitAirDash');
      sys.fx.meraCone(b, -f.x, -f.z, 3.2, 0.6);
      sys.sound('fruit_mera_dash');
      sys.stats.traversalUses++;
    }

    // --- hover jet ---
    if (!b.grounded && i.sprintDown && power > 0.25 && sys.meter.value > 1) {
      sys.meter.drain(MERA_HOVER_DRAIN * dt);
      s.hoverT += dt;
      b.vy = damp(b.vy, MERA_HOVER_RISE * power, 0.02, dt);
      sys.overriding = true;
      sys.mods.gravityScale = 0;
      sys.setAnim('fruitHover');
      sys.fx.meraKindle(b.x, b.y - 0.5, b.z, (s.hoverT * 0.6) % 1);
      sys.fx.setAura(P.fruitMera, 0.45);
    } else if (s.hoverT > 0) {
      s.hoverT = 0;
      sys.fx.meraKindleEnd();
    }

    // --- burn through barriers while pushing into them ---
    if (i.sprintDown && power > 0.5 && sys.meter.value > MERA_SCORCH_COST) {
      const f = sys.forward();
      const burned = sys.burnBarriers(sys.ctx, b.x + f.x * 1.1, b.z + f.z * 1.1, 1.2, b.y);
      if (burned > 0) {
        sys.meter.drain(MERA_SCORCH_COST * burned);
        sys.sound('fruit_mera_crackle');
        sys.stats.traversalUses++;
      }
    }
    // Being wet is not a status icon: it is why the fruit stops working.
    if (power < 0.35) sys.mods.speedMult = lerp(0.8, 1, power / 0.35);
  },
  exit(sys) { sys.fx.meraKindleEnd(); },
});

const MERA_AIR_DASHES = 3;
const MERA_DASH_COST = 6;
const MERA_DASH_SPEED = 24;
const MERA_HOVER_DRAIN = 17;
const MERA_HOVER_RISE = 2.4;
const MERA_SCORCH_COST = 3.5;

// --- hie: rewrite the floor -------------------------------------------------

const KIT_HIE = new TraversalKit('hie', {
  caps: { canWalkOnWater: true, canBreakTerrain: true },
  blurb: 'Ice. The sea is a floor if you want it to be, and ice is faster than ground.',
  hint: 'SPRINT freezes the sea into a walkable sheet, or raises a ramp on land. Ice is slippery — use it.',
  enter(sys, s) { s.skate = 0; s.cool = 0; },
  step(sys, s, dt) {
    const b = sys.body, i = sys.intent;
    s.cool = Math.max(0, s.cool - dt);

    // --- ice path ---
    if (i.sprintPressed && s.cool <= 0 && sys.meter.can(HIE_PATH_COST)) {
      const f = sys.forward();
      const ax = b.x + f.x * 4.0, az = b.z + f.z * 4.0;
      sys.meter.spend(HIE_PATH_COST);
      s.cool = 0.6;
      sys.stats.traversalUses++;
      if (sys.ctx.isOpenWater(ax, az)) {
        sys.freezeSurface(sys.ctx, ax, az, HIE_SHEET_RADIUS, HIE_SHEET_LIFE);
        sys.fx.hieSheet(ax, sys.ctx.seaHeight(ax, az), az, HIE_SHEET_RADIUS);
        sys.sound('fruit_hie_sheet');
      } else {
        sys.buildIceRamp(sys.ctx, b.x, b.z, f.x, f.z);
        sys.sound('fruit_hie_ramp');
      }
    }

    // --- emergency sheet: hie never drowns while it has meter ---
    // This is the fruit's identity applied to its own biggest threat, and it is also what
    // keeps a new player from dying to the first jetty they miss.
    if (sys.nearDrowning && sys.meter.can(HIE_SAVE_COST)) {
      sys.meter.spend(HIE_SAVE_COST);
      sys.freezeSurface(sys.ctx, b.x, b.z, 5, HIE_SHEET_LIFE);
      sys.fx.hieGrow(b.x, sys.ctx.seaHeight(b.x, b.z), b.z, 5);
      b.y = sys.ctx.seaHeight(b.x, b.z) + 0.5;
      b.vy = Math.max(b.vy, 0);
      sys.overriding = true;
      sys.sound('fruit_hie_sheet');
      sys.toast('The sea freezes under your feet', 'good');
    }

    // --- skating ---
    if (b.grounded && sys.onIce(b.x, b.y, b.z)) {
      s.skate = Math.min(1, s.skate + dt * 2.2);
      sys.mods.friction = lerp(1, HIE_ICE_FRICTION, s.skate);
      sys.mods.speedMult = lerp(1, 1.42, s.skate);
      sys.mods.airControlMult = 0.85;
      if (Math.hypot(b.vx, b.vz) > 3) sys.setAnim('fruitSkate');
      sys.fx.setAura(P.fruitHie, 0.18 * s.skate);
    } else {
      s.skate = Math.max(0, s.skate - dt * 3);
      if (s.skate <= 0) sys.mods.friction = 1;
    }
  },
});

const HIE_PATH_COST = 11;
const HIE_SAVE_COST = 18;
const HIE_SHEET_RADIUS = 6;
const HIE_SHEET_LIFE = 16;
const HIE_ICE_FRICTION = 0.06;

// --- suna: below the map, and through the blade ----------------------------

const KIT_SUNA = new TraversalKit('suna', {
  caps: { canBurrow: true, canGlide: true, canPhase: true },
  blurb: 'Sand. Under the ground nothing can target you — until the ground is wet.',
  hint: 'Hold JUMP on the ground to burrow; press JUMP again to surface. Hold SPRINT in the air to ride a sand stream.',
  enter(sys, s) { s.burrow = 0; s.hold = 0; s.glide = 0; },
  step(sys, s, dt) {
    const b = sys.body, i = sys.intent;
    const integrity = sys.sandIntegrity;

    // --- burrow ---
    if (s.burrow > 0) {
      s.burrow += dt;
      sys.meter.drain(SUNA_BURROW_DRAIN * dt);
      const ground = sys.heightAtSafe(b.x, b.z);
      b.y = ground - SUNA_BURROW_DEPTH;
      b.vy = 0;
      sys.overriding = true;
      sys.mods.overrideVelocity = true;
      sys.mods.untargetable = true;
      sys.mods.phasing = true;
      sys.mods.speedMult = SUNA_BURROW_SPEED;
      sys.mods.gravityScale = 0;
      sys.setAnim('fruitBurrow');
      sys.fx.setAura(P.fruitSuna, 0.3);
      const spent = sys.meter.value <= 0.5;
      const drowned = sys.ctx.isOpenWater(b.x, b.z);
      if (i.jumpPressed || s.burrow > SUNA_BURROW_MAX || spent || drowned || integrity < 0.2) {
        // Resurface: always on solid ground, never inside the sea floor.
        b.y = sys.heightAtSafe(b.x, b.z) + 0.1;
        b.vy = SUNA_SURFACE_POP;
        s.burrow = 0;
        sys.mods.overrideVelocity = false;
        sys.mods.untargetable = false;
        sys.mods.phasing = false;
        sys.fx.sunaBurrow(b.x, b.y, b.z, true);
        sys.sound('fruit_suna_surface');
      }
    } else if (b.grounded && i.jumpDown && integrity > 0.3 && sys.meter.can(SUNA_BURROW_COST)) {
      s.hold += dt;
      sys.suppressJump();
      sys.mods.speedMult = 0.4;
      if (s.hold > 0.28) {
        sys.meter.spend(SUNA_BURROW_COST);
        s.burrow = 0.0001;
        s.hold = 0;
        sys.fx.sunaBurrow(b.x, b.y, b.z, false);
        sys.sound('fruit_suna_burrow');
        sys.stats.traversalUses++;
      }
    } else {
      s.hold = 0;
      sys.mods.overrideJump = false;
    }

    // --- sand stream glide ---
    if (s.burrow <= 0 && !b.grounded && i.sprintDown && integrity > 0.3 && sys.meter.value > 1) {
      sys.meter.drain(SUNA_GLIDE_DRAIN * dt);
      const f = sys.moveOrForward();
      b.vy = damp(b.vy, SUNA_GLIDE_FALL, 0.03, dt);
      b.vx = damp(b.vx, f.x * SUNA_GLIDE_SPEED, 0.12, dt);
      b.vz = damp(b.vz, f.z * SUNA_GLIDE_SPEED, 0.12, dt);
      sys.overriding = true;
      sys.mods.gravityScale = 0;
      s.glide += dt;
      sys.setAnim('fruitGlide');
      sys.fx.sunaStream(b, clamp01(s.glide * 2));
    } else if (s.glide > 0) {
      s.glide = 0;
      sys.fx.sunaStreamEnd();
    }

    if (sys.phasing) sys.mods.phasing = true;
    // Wet sand is heavy sand.
    if (integrity < 0.5) sys.mods.speedMult = Math.min(sys.mods.speedMult, lerp(0.75, 1, integrity / 0.5));
  },
  exit(sys) { sys.fx.sunaStreamEnd(); sys.mods.untargetable = false; sys.mods.phasing = false; },
});

const SUNA_BURROW_COST = 12;
const SUNA_BURROW_DRAIN = 8;
const SUNA_BURROW_DEPTH = 1.7;
const SUNA_BURROW_SPEED = 1.45;
const SUNA_BURROW_MAX = 7.0;
const SUNA_SURFACE_POP = 5.5;
const SUNA_GLIDE_DRAIN = 7;
const SUNA_GLIDE_FALL = -1.7;
const SUNA_GLIDE_SPEED = 11;

// --- gura: make your own road ----------------------------------------------

const KIT_GURA = new TraversalKit('gura', {
  caps: { canBreakTerrain: true, canSuperJump: true },
  blurb: 'Quake. You do not climb the wall. You remove it.',
  hint: 'Hold JUMP to charge a shockwave leap. SPRINT on the ground punches a hole through what is in front of you.',
  enter(sys, s) { s.charge = 0; s.cool = 0; },
  step(sys, s, dt) {
    const b = sys.body, i = sys.intent;
    s.cool = Math.max(0, s.cool - dt);
    sys.mods.fallDamageMult = 0.35;   // the ground takes most of it

    // --- shockwave leap ---
    if (b.grounded && i.jumpDown && sys.meter.can(1)) {
      s.charge = Math.min(1, s.charge + dt / 0.6);
      sys.suppressJump();
      sys.mods.speedMult = lerp(1, 0.2, s.charge);
      sys.setAnim('fruitCompress');
      sys.fx.setAura(P.fruitGura, 0.25 + 0.55 * s.charge);
    } else if (s.charge > 0) {
      if (s.charge > 0.35 && sys.meter.spend(GURA_LEAP_COST)) {
        const f = sys.forward();
        b.vy = lerp(10, 19, s.charge);
        b.vx += f.x * lerp(3, 8, s.charge);
        b.vz += f.z * lerp(3, 8, s.charge);
        b.grounded = false;
        sys.overriding = true;
        sys.crackGround(sys.ctx, b.x, b.z, 2.6, 1);
        sys.fx.guraLeap(b.x, sys.heightAtSafe(b.x, b.z), b.z);
        sys.shake(1.0, 0.25);
        sys.sound('fruit_gura_leap');
        sys.stats.traversalUses++;
      }
      s.charge = 0;
      sys.mods.overrideJump = false;
    }

    // --- punch a shortcut ---
    if (i.sprintPressed && s.cool <= 0 && b.grounded && sys.meter.can(GURA_BREAK_COST)) {
      const f = sys.forward();
      const removed = sys.breakVolume(sys.ctx, b.x + f.x * 2.2, b.y + 1.0, b.z + f.z * 2.2, GURA_BREAK_RADIUS);
      if (removed > 0) {
        sys.meter.spend(GURA_BREAK_COST);
        s.cool = 0.8;
        sys.fx.guraRing(b.x + f.x * 2.2, b.y + 1.0, b.z + f.z * 2.2, 3.0, 0);
        sys.fx.guraDecal(b.x + f.x * 2.2, sys.heightAtSafe(b.x + f.x * 2.2, b.z + f.z * 2.2), b.z + f.z * 2.2, 3.0);
        sys.shake(0.8, 0.2);
        sys.sound('fruit_gura_break');
        sys.stats.traversalUses++;
      }
    }
  },
});

const GURA_LEAP_COST = 15;
const GURA_BREAK_COST = 18;
const GURA_BREAK_RADIUS = 2.6;

// --- zushi: move the world, not yourself ------------------------------------

const KIT_ZUSHI = new TraversalKit('zushi', {
  caps: { canGrapple: true, canHover: true, canGlide: true },
  blurb: 'Gravity. Fall slowly, or place a well and ride it straight up.',
  hint: 'Hold JUMP in the air to glide. SPRINT plants a gravity well you can ride upward.',
  enter(sys, s) { s.well = null; s.glide = 0; },
  step(sys, s, dt) {
    const b = sys.body, i = sys.intent;

    // --- slow-fall glide ---
    if (!b.grounded && i.jumpDown && b.vy < 1 && sys.meter.value > 1) {
      sys.meter.drain(ZUSHI_GLIDE_DRAIN * dt);
      b.vy = damp(b.vy, ZUSHI_GLIDE_FALL, 0.04, dt);
      sys.overriding = true;
      sys.mods.gravityScale = 0.12;
      sys.mods.airControlMult = 1.5;
      s.glide += dt;
      sys.setAnim('fruitGlide');
      sys.fx.setAura(P.fruitZushi, 0.3);
    } else {
      s.glide = 0;
    }

    // --- gravity well ---
    if (i.sprintPressed && !s.well && sys.meter.can(ZUSHI_WELL_COST)) {
      const anchor = sys.castAnchor(ZUSHI_WELL_RANGE, true);
      if (anchor) {
        sys.meter.spend(ZUSHI_WELL_COST);
        s.well = { x: anchor.x, y: anchor.y + ZUSHI_WELL_LIFT, z: anchor.z, t: 0 };
        sys.sound('fruit_zushi_well');
        sys.stats.traversalUses++;
      }
    }
    if (s.well) {
      s.well.t += dt;
      sys.fx.zushiLift(s.well.x, s.well.y, s.well.z, clamp01(s.well.t * 2));
      const dx = s.well.x - b.x, dy = s.well.y - b.y, dz = s.well.z - b.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      if (i.sprintDown && len < ZUSHI_WELL_RANGE && sys.meter.value > 1) {
        sys.meter.drain(ZUSHI_WELL_DRAIN * dt);
        // The well lifts, it does not teleport — you ride it, and you can be shot off it.
        b.vx = damp(b.vx, dx / len * ZUSHI_RIDE_SPEED, 0.05, dt);
        b.vy = damp(b.vy, Math.max(dy, 0.6) / len * ZUSHI_RIDE_SPEED + 3, 0.05, dt);
        b.vz = damp(b.vz, dz / len * ZUSHI_RIDE_SPEED, 0.05, dt);
        b.grounded = false;
        sys.overriding = true;
        sys.mods.gravityScale = 0;
        sys.setAnim('fruitHover');
      }
      if (s.well.t > ZUSHI_WELL_LIFE || (!i.sprintDown && s.well.t > 0.4)) {
        s.well = null;
        sys.fx.zushiLiftEnd();
      }
    }
  },
  exit(sys) { sys.fx.zushiLiftEnd(); },
});

const ZUSHI_GLIDE_DRAIN = 5;
const ZUSHI_GLIDE_FALL = -2.1;
const ZUSHI_WELL_COST = 12;
const ZUSHI_WELL_DRAIN = 11;
const ZUSHI_WELL_RANGE = 16;
const ZUSHI_WELL_LIFT = 6.5;
const ZUSHI_WELL_LIFE = 6.0;
const ZUSHI_RIDE_SPEED = 13;

// ---------------------------------------------------------------------------
// Fruit definitions
// ---------------------------------------------------------------------------

/**
 * One devil fruit: identity, colour, traversal kit, and the drawback that makes it a choice
 * rather than an upgrade.
 */
export class FruitDef {
  constructor(spec) {
    this.id = spec.id;
    this.name = spec.name;
    this.title = spec.title;
    this.color = FRUIT_COLORS[spec.id];
    this.icon = spec.icon;
    this.kit = spec.kit;
    this.caps = this.kit.caps;
    this.signature = this.kit.signature;
    this.drawback = spec.drawback;
    this.desc = spec.desc;
    Object.freeze(this);
  }

  /** @returns {import('./abilities.js').Ability[]} the three abilities, slot 1..3 */
  get abilities() { return abilitiesFor(this.id); }
}

/** @type {Record<string, FruitDef>} */
export const FRUITS = Object.freeze({
  gomu: new FruitDef({
    id: 'gomu', name: 'Gomu Gomu', title: 'Rubber-Rubber Fruit', icon: 'boot', kit: KIT_GOMU,
    desc: 'Your body is rubber. Reach further than anyone, fall from anywhere, and give a hit back harder than it arrived.',
    drawback: 'Blunt force only. Blades cut you exactly as well as they cut anyone.',
  }),
  mera: new FruitDef({
    id: 'mera', name: 'Mera Mera', title: 'Flame-Flame Fruit', icon: 'flame', kit: KIT_MERA,
    desc: 'Fire is transport as much as it is damage. Dash through the air, hover, and burn a door where there was a wall.',
    drawback: 'Rain and seawater smother it. Wet, the fire is a candle.',
  }),
  hie: new FruitDef({
    id: 'hie', name: 'Hie Hie', title: 'Ice-Ice Fruit', icon: 'snowflake', kit: KIT_HIE,
    desc: 'Freeze the sea and walk on it. Freeze an enemy and shatter them. The floor is whatever you decide it is.',
    drawback: 'Ice you make is ice they can break, and it melts on its own.',
  }),
  suna: new FruitDef({
    id: 'suna', name: 'Suna Suna', title: 'Sand-Sand Fruit', icon: 'sandglass', kit: KIT_SUNA,
    desc: 'Travel under the ground where nothing can target you, and let blades pass through a body made of grains.',
    drawback: 'Water is the counter. Rain, spray or the sea and you are mud — no phasing, no burrow.',
  }),
  gura: new FruitDef({
    id: 'gura', name: 'Gura Gura', title: 'Quake-Quake Fruit', icon: 'shockwave', kit: KIT_GURA,
    desc: 'The strongest of them. The terrain is your weapon and your road — crack it open and walk through.',
    drawback: 'Every move commits. The wind-ups are long and everyone can see them coming.',
  }),
  zushi: new FruitDef({
    id: 'zushi', name: 'Zushi Zushi', title: 'Gravity-Gravity Fruit', icon: 'gravity', kit: KIT_ZUSHI,
    desc: 'Move the world instead of yourself. Glide, ride a well upward, and pull a crowd into one place to hit it once.',
    drawback: 'It works on mass, not on will. Anchored and braced enemies barely shift.',
  }),
});

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

/** Blank movement modifier block. Refreshed every step before the kit runs. */
function blankMods() {
  return {
    gravityScale: 1, friction: 1, airControlMult: 1, speedMult: 1, jumpMult: 1,
    fallDamageMult: 1, bounciness: 0,
    waterWalk: false, untargetable: false, phasing: false,
    overrideJump: false, overrideVelocity: false,
  };
}

/** A stand-in player body used when PLAYER has not landed. Keeps headless checks honest. */
function makeFallbackBody() {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0,
    grounded: true, onShip: false, hp: 100, maxHp: 100, fallback: true,
  };
}

export class FruitSystem {
  /**
   * @param {object} app
   * @param {object} [opts]
   * @param {string} [opts.fruit='gomu'] fruit equipped at start
   * @param {boolean} [opts.integrateFallback=true] integrate the stand-in body when PLAYER is absent
   */
  constructor(app, opts = {}) {
    this.app = app;
    this.opts = opts;
    this.rng = Rng.fromName(app && app.seed !== undefined ? app.seed : 0, 'fruit');
    this.meter = new Meter(100);
    this.runner = new AbilityRunner();
    this.fx = new FruitFx(this);
    this.ctx = new FruitContext(this, app);

    /** @type {FruitDef|null} */ this.def = null;
    this.fruitId = null;
    this.kitState = Object.create(null);
    this.caps = blankCaps();
    this.mods = blankMods();
    this.body = makeFallbackBody();
    this.playerRef = null;

    // --- state a devil fruit user carries around ---
    /** Devil fruit users cannot swim. Never true while a fruit is equipped. */
    this.canSwim = true;
    this.wetness = 0;
    this.drownT = 0;
    this.submerged = false;
    this.nearDrowning = false;
    this.rescues = 0;
    /** Set by gomu's balloon; COMBAT calls absorbHit() before applying damage to the player. */
    this.guard = null;
    /** Set by suna's ghost stance; COMBAT reads it to make physical attacks miss. */
    this.phasing = false;
    this.overriding = false;
    /** True when the running cast began from a held ability key (stances answer to release). */
    this._stanceHeld = false;
    this.prevVy = 0;
    this.time = 0;
    this.animRequest = null;

    /** @type {Set<string>} fruits granted directly (harness / debug) on top of QUEST's set. */
    this.granted = new Set();
    /** @type {Array<object>} temporary world edits awaiting revert */
    this.tempBlocks = [];
    /** @type {Map<object, object>} FRUIT-local status for targets when COMBAT has no service */
    this.statuses = new Map();
    this._blockIds = new Map();
    this._intent = {
      jumpDown: false, jumpPressed: false, sprintDown: false, sprintPressed: false,
      slot: [false, false, false], slotDown: [false, false, false],
    };
    this._prevInput = { jump: false, sprint: false, s1: false, s2: false, s3: false };

    this.stats = {
      casts: 0, hits: 0, damage: 0, blocksChanged: 0, teleports: 0,
      traversalUses: 0, drownings: 0, shake: 0,
      /** Casts per fruit. Cheap telemetry, and the only way a check can prove coverage. */
      castsPerFruit: FRUIT_IDS.reduce((o, id) => { o[id] = 0; return o; }, Object.create(null)),
    };

    this.fx.attach(app);
    this.equip(opts.fruit || 'gomu', true);
  }

  // -------------------------------------------------------------------------
  // Public facade
  // -------------------------------------------------------------------------

  /** @returns {string[]} fruits the player may equip right now */
  unlocked() {
    const q = this.app && (this.app.quests || this.app.quest);
    const fromQuest = q && q.unlockedFruits ? q.unlockedFruits() : [];
    const set = new Set(fromQuest);
    for (const id of this.granted) set.add(id);
    if (set.size === 0) set.add('gomu');   // the starting fruit is never gated
    return FRUIT_IDS.filter((id) => set.has(id));
  }

  /** @param {string} fruitId @returns {boolean} */
  isUnlocked(fruitId) { return this.unlocked().indexOf(fruitId) >= 0; }

  /**
   * Equip a fruit. Swapping is free and instant — the wheel is a build choice, not a shop.
   * @param {string} fruitId
   * @param {boolean} [force=false] skip the unlock gate (boot and load use this)
   * @returns {boolean} true if the fruit is now equipped
   */
  equip(fruitId, force = false) {
    const def = FRUITS[fruitId];
    if (!def) return false;
    if (!force && !this.isUnlocked(fruitId)) return false;
    if (this.def && this.def.id === fruitId) return true;
    if (this.def) {
      this.runner.cancel('equip', this.ctx);
      this.def.kit.exit(this);
    }
    this.def = def;
    this.fruitId = fruitId;
    this.ctx.fruit = def;
    this.caps = def.caps;
    this.canSwim = false;          // this is the price of every fruit in this game
    this.phasing = false;
    this.guard = null;
    def.kit.enter(this);
    this.fx.setAura(def.color, 0);
    return true;
  }

  /** Grant a fruit outside the quest chain. Harness hook (ARCHITECTURE §9). */
  grant(fruitId) {
    if (!FRUITS[fruitId]) return false;
    this.granted.add(fruitId);
    return true;
  }

  /** @param {string} [fruitId] defaults to the equipped fruit */
  abilitiesFor(fruitId) { return abilitiesFor(fruitId || this.fruitId); }

  /**
   * Fire the ability in a slot.
   * @param {1|2|3} slot
   * @returns {boolean} true if the cast started
   */
  use(slot) {
    if (!this.def) return false;
    const list = this.def.abilities;
    const a = list[slot - 1];
    if (!a) return false;
    const ok = this.runner.start(a, this.ctx);
    if (ok) {
      this._stanceHeld = !!this._intent.slotDown[slot - 1];
      this.stats.casts++;
      this.stats.castsPerFruit[this.fruitId]++;
      this.setAnim(a.animState);
      this.fx.setAura(this.def.color, 0.6);
    } else if (this.runner.lastFailure === 'meter') {
      this.sound('ui_denied');
    } else if (this.runner.lastFailure === 'sealed') {
      this.toast('The sea has taken your strength', 'bad');
    }
    return ok;
  }

  /**
   * PLAYER calls this before it commits to a cast pose (src/entity/player.js `_castAbility`).
   * Zero-based to match that call site.
   * @param {0|1|2} index
   * @returns {boolean}
   */
  canUse(index) {
    if (!this.def || this.meter.locked) return false;
    const a = this.def.abilities[index];
    if (!a) return false;
    // Mirror AbilityRunner.start's busy rule exactly, or PLAYER poses for a cast that is
    // then refused and the character mimes a power it never used.
    if (this.runner.active
      && (this.runner.run.phase !== 'recover' || this.runner.run.ability.has('uncancellable'))) return false;
    if (this.runner.cooldownOf(a.id) > 0) return false;
    if (!this.meter.can(a.cost)) return false;
    return a.canUse(this.ctx);
  }

  /**
   * Extra mid-air jumps this fruit grants. PLAYER reads it every step and refills on landing.
   * Only mera has any, and only while its flame is not smothered — which is how the rain
   * drawback reaches the movement layer rather than only the damage layer.
   */
  get airJumps() {
    if (!this.def) return 0;
    if (this.def.id !== 'mera') return 0;
    return this.flameStrength > 0.25 ? MERA_AIR_DASHES : 0;
  }

  /** Harness hook: scale every cooldown (0 = no cooldowns, for fruit-spam profiling). */
  setCooldownScale(s) { this.runner.cooldownScale = Math.max(0, s); }

  get useCount() { return this.runner.useCount; }
  get activeAbility() { return this.runner.activeAbility; }
  get color() { return this.def ? this.def.color : P.fruitGomu; }

  /** 0..1 how well mera works right now. Rain and being wet both suppress it. */
  get flameStrength() {
    const rain = this.ctx.rain;
    return clamp01(1 - rain * 0.8 - this.wetness * 0.95);
  }

  /** 0..1 how well suna works right now. Same enemy, different curve. */
  get sandIntegrity() {
    const rain = this.ctx.rain;
    return clamp01(1 - rain * 0.55 - this.wetness * 1.15);
  }

  /** The character rig, when Cluster B has provided one. */
  get rig() {
    const p = this.playerRef;
    return (p && p.rig) || (this.app && this.app.actor && this.app.actor.rig) || null;
  }

  /** Movement modifiers for the player controller. Read every step; never cached. */
  movement() { return this.mods; }

  /**
   * COMBAT calls this before applying damage to the player.
   * @param {object} hit the incoming hit, with `.amount` and optionally `.source`
   * @returns {boolean} true when the hit was absorbed and must not be applied
   */
  absorbHit(hit) {
    if (this.mods.untargetable) return true;
    if (this.phasing && !(hit && hit.tags && hit.tags.indexOf('unphaseable') >= 0)) {
      // Sand does not stop being sand for a normal blade. Elemental and haki-like hits do land.
      if (!hit || hit.kind === undefined || PHYSICAL_KINDS.has(hit.kind)) {
        this.fx.sunaGhost(this.body, 1);
        return true;
      }
    }
    if (this.guard && this.guard.absorb) {
      this.guard.absorb = false;
      this.guard.stored = (hit && hit.amount) || 0;
      this.guard.attacker = (hit && hit.attacker) || null;
      this.fx.gomuBalloon(this.body, 1);
      return true;
    }
    this.meter.touchCombat();
    this.runner.cancel('hit', this.ctx);
    return false;
  }

  /** Cancel the running cast — the player controller calls this on a dodge. */
  cancelCast(reason) { return this.runner.cancel(reason || 'dodge', this.ctx); }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  /**
   * One fixed step.
   * @param {number} dt always 1/60
   * @param {object} app
   */
  step(dt, app) {
    this.app = app || this.app;
    this.ctx.app = this.app;
    this.time += dt;
    this.overriding = false;
    this.animRequest = null;
    this.mods = blankMods();
    this.mods.waterWalk = this.caps.canWalkOnWater;
    this._syncBodyIn();
    this._readIntent();
    this._expireTempBlocks(dt);
    this._stepStatuses(dt);
    this._stepWetness(dt);

    // Drowning is resolved before anything else can spend meter: a sealed fruit is sealed.
    this._stepWater(dt);

    if (this.def && !this.meter.locked) {
      // Slot input is read here rather than by the player controller so that a fruit power is
      // never available in a state the fruit system considers invalid.
      for (let i = 0; i < 3; i++) if (this._intent.slot[i]) this.use(i + 1);
      this.def.kit.step(this, dt);
    }

    this.runner.step(dt, this.ctx);
    this.meter.step(dt);
    this.fx.step(dt);

    // Nothing is casting and nothing is moving under fruit power: let the aura fall away.
    // The FX layer eases it down, so this is a target, not a cut.
    if (!this.runner.active && !this.overriding) this.fx.setAura(this.color, 0);

    if (this.opts.integrateFallback !== false) this._integrateFallback(dt);
    this.prevVy = this.body.vy;
    this._syncBodyOut();
  }

  /** Render-only. Rebuilds FX geometry; mutates no simulation state. */
  preRender(alpha) { this.fx.preRender(alpha); }

  // -------------------------------------------------------------------------
  // Body plumbing
  // -------------------------------------------------------------------------

  _syncBodyIn() {
    const p = this.app && this.app.player;
    if (!p) return;
    this.playerRef = p;
    const b = this.body;
    b.fallback = false;
    const pos = p.pos;
    if (Array.isArray(pos)) { b.x = pos[0]; b.y = pos[1]; b.z = pos[2]; }
    else if (pos) { b.x = pos.x; b.y = pos.y; b.z = pos.z; }
    const vel = p.vel || p.velocity;
    if (Array.isArray(vel)) { b.vx = vel[0]; b.vy = vel[1]; b.vz = vel[2]; }
    else if (vel) { b.vx = vel.x; b.vy = vel.y; b.vz = vel.z; }
    if (typeof p.yaw === 'number') b.yaw = p.yaw;
    // Aim pitch lives on the camera, not the body — an Actor has yaw only. Every ability that
    // travels through the air (gomu's fist, the grapple, zushi's well) reads it.
    const cam = this.app && this.app.gameCamera;
    if (typeof p.pitch === 'number') b.pitch = p.pitch;
    else if (cam && typeof cam.pitch === 'number') b.pitch = -cam.pitch;
    if (typeof p.grounded === 'boolean') b.grounded = p.grounded;
    if (typeof p.onShip === 'boolean') b.onShip = p.onShip;
    if (typeof p.hp === 'number') b.hp = p.hp;
    if (typeof p.maxHp === 'number') b.maxHp = p.maxHp;
  }

  _syncBodyOut() {
    const p = this.playerRef;
    if (!p || !this.overriding) return;
    const b = this.body;
    const pos = p.pos;
    if (Array.isArray(pos)) { pos[0] = b.x; pos[1] = b.y; pos[2] = b.z; }
    else if (pos) { pos.x = b.x; pos.y = b.y; pos.z = b.z; }
    const vel = p.vel || p.velocity;
    if (Array.isArray(vel)) { vel[0] = b.vx; vel[1] = b.vy; vel[2] = b.vz; }
    else if (vel) { vel.x = b.vx; vel.y = b.vy; vel.z = b.vz; }
    if (typeof p.grounded === 'boolean') p.grounded = b.grounded;
  }

  /**
   * Integrate the stand-in body when PLAYER is absent. WHY: without this, every traversal code
   * path is dead code in headless checks and half the system would ship unexercised.
   */
  _integrateFallback(dt) {
    const b = this.body;
    if (!b.fallback) return;
    if (!this.mods.overrideVelocity) b.vy -= 22 * dt * this.mods.gravityScale;
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
    const ground = this.heightAtSafe(b.x, b.z);
    if (b.y <= ground) {
      b.y = ground;
      if (b.vy < 0) b.vy = 0;
      b.grounded = true;
      const f = Math.pow(0.02 * this.mods.friction + 0.0001, dt);
      b.vx *= f; b.vz *= f;
    } else {
      b.grounded = false;
    }
  }

  _readIntent() {
    const i = this._intent;
    const st = this.app && this.app.input && this.app.input.state;
    const down = st ? st.down : null;
    const jump = !!(down && down.jump);
    const sprint = !!(down && down.sprint);
    const s1 = !!(down && down.ability1), s2 = !!(down && down.ability2), s3 = !!(down && down.ability3);
    const pv = this._prevInput;
    i.jumpDown = jump; i.jumpPressed = jump && !pv.jump;
    i.sprintDown = sprint; i.sprintPressed = sprint && !pv.sprint;
    i.slot[0] = s1 && !pv.s1; i.slot[1] = s2 && !pv.s2; i.slot[2] = s3 && !pv.s3;
    i.slotDown[0] = s1; i.slotDown[1] = s2; i.slotDown[2] = s3;
    pv.jump = jump; pv.sprint = sprint; pv.s1 = s1; pv.s2 = s2; pv.s3 = s3;
    // A stance ends when its key is released, which is what makes holding it a decision.
    // Only casts that *began* from a held key answer to the key: a cast started through the
    // facade (harness, scripted playtest, a crew ability) runs to its own natural end.
    const a = this.runner.activeAbility;
    if (a && a.has('stance') && this._stanceHeld && !i.slotDown[a.slot - 1] && this.runner.run.total > 0.2) {
      this.runner.cancel('release', this.ctx);
    }
  }

  get intent() { return this._intent; }

  // -------------------------------------------------------------------------
  // Water: the price of every devil fruit
  // -------------------------------------------------------------------------

  _stepWetness(dt) {
    const b = this.body;
    const rain = this.ctx.rain;
    const sea = this.ctx.seaHeight(b.x, b.z);
    const inShallows = b.y < sea + 0.9 && this.ctx.heightAt(b.x, b.z) < sea + 0.4;
    let target = 0;
    if (this.submerged) target = 1;
    else if (inShallows) target = 0.75;
    else if (rain > 0.05) target = clamp01(rain * 0.85);
    else if (b.onShip && rain > 0) target = clamp01(rain * 0.6);
    // Wetting is fast; drying is slow. That asymmetry is what makes rain a real weather event
    // for mera and suna instead of a toggle.
    const rate = target > this.wetness ? 1.8 : 0.22;
    this.wetness = clamp(this.wetness + clamp(target - this.wetness, -rate * dt, rate * dt), 0, 1);
  }

  /** Sand's one recovery valve: draining a body dries you out. */
  dryOff(amount) { this.wetness = clamp01(this.wetness - amount); }

  _stepWater(dt) {
    const b = this.body;
    const sea = this.ctx.seaHeight(b.x, b.z);
    const ground = this.ctx.heightAt(b.x, b.z);
    const overDeep = ground < sea - 0.5;
    const onSheet = this.onIce(b.x, b.y, b.z);
    const inWater = overDeep && !onSheet && !b.onShip && b.y < sea - DROWN_DEPTH;
    this.nearDrowning = overDeep && !onSheet && !b.onShip && b.y < sea + 0.4 && !this.submerged;

    if (this.canSwim || !this.def) { this.submerged = false; this.drownT = 0; this.meter.locked = false; return; }

    if (!inWater) {
      this.submerged = false;
      this.drownT = Math.max(0, this.drownT - dt * 2);
      this.meter.locked = false;
      return;
    }

    if (!this.submerged) {
      this.submerged = true;
      this.stats.drownings++;
      this.runner.cancel('water', this.ctx);
      this.toast('You cannot swim — the sea is pulling you down', 'bad');
      this.sound('player_drown_start');
    }
    this.drownT += dt;
    this.meter.locked = true;
    this.meter.value = Math.max(0, this.meter.value - 60 * dt);
    this.phasing = false;
    this.guard = null;

    // Sinking, with almost no control. The point is that it is genuinely bad.
    b.vy = damp(b.vy, -2.4, 0.2, dt);
    b.vx = damp(b.vx, 0, 0.15, dt);
    b.vz = damp(b.vz, 0, 0.15, dt);
    this.overriding = true;
    this.mods.overrideVelocity = true;
    this.mods.speedMult = 0.12;
    this.mods.gravityScale = 0;
    this.setAnim('fruitDrown');
    this.fx.setAura(this.color, 0);

    const tutorialDone = !!(this.app && this.app.flags && this.app.flags.tutorialDone);
    const dps = tutorialDone ? DROWN_DPS : DROWN_DPS * 0.45;
    this._drownDamage(dps * dt);

    const limit = tutorialDone ? RESCUE_LATE : RESCUE_EARLY;
    const nearlyDead = b.maxHp > 0 && b.hp / b.maxHp < 0.28;
    if (this.drownT >= limit || nearlyDead) this._rescue();
  }

  /** Route drowning damage through COMBAT so death, HUD and audio all see it. */
  _drownDamage(amount) {
    const c = this.app && this.app.combat;
    const target = this.playerRef || this.body;
    // The hit contract is `damage`, not `amount` (see makeHit in src/combat/hitbox.js).
    // Passing `amount` left hit.damage undefined, so resolveDamage did `hp -= undefined` and
    // the player's hp and poise went NaN on the FIRST step of every session — the character
    // spawns in open water, so this fired before anything else could happen.
    if (c && c.applyHit) {
      // Environmental damage, billed in whole points about once a second. A bare {damage}
      // object was normalised into a full melee hit — 10 poise, hitstop, slash FX and hit
      // sfx at 60 Hz for the whole time the player was under.
      this._drownAcc = (this._drownAcc || 0) + amount;
      if (this._drownAcc < 1) return;
      const n = Math.floor(this._drownAcc);
      this._drownAcc -= n;
      c.applyHit(target, {
        damage: n, poise: 0, knockback: 0, launch: 0, hitstop: 0,
        critChance: 0, critMult: 1, blockable: 0, guardCost: 0, tags: [],
        fxKind: 'water', source: 'sea',
        px: this.body.x, py: this.body.y + 0.6, pz: this.body.z,
      });
    } else {
      this.body.hp = Math.max(1, this.body.hp - amount);
    }
  }

  /**
   * Wash the player to the nearest shore or deck.
   *
   * WHY this exists at all: "devil fruit users cannot swim" is a great constraint and a
   * terrible failure state. A player who walks off a jetty in the first five minutes must end
   * up coughing on the sand, not staring at a load screen. The search is a deterministic
   * outward spiral, so the same fall always lands the same place.
   */
  _rescue() {
    const b = this.body;
    let best = null, bestD = Infinity;
    // Nearest SHORE first, ship deck only when it is genuinely closer: being washed onto the
    // sand you sank beside reads as the sea spitting you out; warping to a ship 50 m away
    // reads as teleportation — and in play it ping-ponged anyone who fell in near a tideline
    // back to the harbour, over and over, however far inland their business was.
    for (let ring = 1; ring <= 24 && !best; ring++) {
      const r = ring * 5;
      const n = 8 + ring * 2;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + ring * 0.31;
        const x = b.x + Math.cos(a) * r, z = b.z + Math.sin(a) * r;
        const h = this.ctx.heightAt(x, z);
        if (h > this.ctx.seaHeight(x, z) + 0.35) {
          const d = Math.hypot(x - b.x, z - b.z);
          if (d < bestD) { bestD = d; best = { x, y: h + 0.2, z, kind: 'shore' }; }
        }
      }
    }
    const ship = this.app && this.app.ship;
    if (ship) {
      const sp = this.posOf(ship, { x: 0, y: 0, z: 0 });
      const d = Math.hypot(sp.x - b.x, sp.z - b.z);
      if (d < 60 && d < bestD) { best = { x: sp.x, y: sp.y + 1.2, z: sp.z, kind: 'deck' }; bestD = d; }
    }
    if (!best) {
      // Nowhere within 120 m. Surface in place rather than trap the player in the deep.
      best = { x: b.x, y: this.ctx.seaHeight(b.x, b.z) + 0.6, z: b.z, kind: 'surface' };
    }
    b.x = best.x; b.y = best.y; b.z = best.z;
    b.vx = 0; b.vy = 0; b.vz = 0;
    b.grounded = best.kind !== 'surface';
    this.submerged = false;
    this.drownT = 0;
    this.meter.locked = false;
    this.meter.value = Math.max(this.meter.value, this.meter.max * 0.3);
    this.wetness = 1;
    this.overriding = true;
    this.rescues++;
    this.stats.teleports++;
    this.toast(best.kind === 'deck' ? 'Hauled back aboard' : 'Washed ashore, soaked and alive', 'info');
    this.sound('player_rescued');
    const q = this.app && (this.app.quests || this.app.quest);
    if (q && q.notify) q.notify('areaEntered', { point: 'rescue', dist: 0 });
  }

  // -------------------------------------------------------------------------
  // World services used by abilities and kits
  // -------------------------------------------------------------------------

  /** Ground height, defaulting to sea level when WORLD is absent. */
  heightAtSafe(x, z) { return this.ctx.heightAt(x, z); }

  /**
   * Resolve a block name to an id once. Returns -1 when the vocabulary is not available, and
   * every caller treats -1 as "skip the edit" rather than throwing.
   * @param {string} name
   */
  blockId(name) {
    if (this._blockIds.has(name)) return this._blockIds.get(name);
    let id = -1;
    const w = this.app && this.app.world;
    const reg = (w && w.blocks) || (this.app && this.app.blocks) || null;
    if (w && typeof w.blockId === 'function') {
      const v = w.blockId(name);
      if (typeof v === 'number') id = v;
    } else if (reg && reg.byName && reg.byName.has(name)) {
      id = reg.byName.get(name);
    }
    this._blockIds.set(name, id);
    return id;
  }

  /** Record a voxel edit that must revert later (ice). */
  _writeTemp(ctx, x, y, z, id, seconds) {
    const prev = ctx.blockAt(x, y, z);
    if (!ctx.setBlock(x, y, z, id)) return false;
    if (this.tempBlocks.length > 4000) {
      const old = this.tempBlocks.shift();
      ctx.setBlock(old.x, old.y, old.z, old.prev);
    }
    this.tempBlocks.push({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), prev, at: this.time + seconds });
    return true;
  }

  _expireTempBlocks(dt) {
    if (!this.tempBlocks.length) return;
    for (let i = this.tempBlocks.length - 1; i >= 0; i--) {
      const t = this.tempBlocks[i];
      if (this.time < t.at) continue;
      this.ctx.setBlock(t.x, t.y, t.z, t.prev);
      this.tempBlocks.splice(i, 1);
    }
  }

  /** Revert every outstanding temporary edit. Used on load and on dispose. */
  revertTempBlocks() {
    for (const t of this.tempBlocks) this.ctx.setBlock(t.x, t.y, t.z, t.prev);
    this.tempBlocks.length = 0;
  }

  /** True when the voxel under a position is ice — the skating and no-drown test. */
  onIce(x, y, z) {
    const ice = this.blockId('ice');
    if (ice < 0) return false;
    return this.ctx.blockAt(Math.floor(x), Math.floor(y - 0.2), Math.floor(z)) === ice;
  }

  /**
   * Freeze a disc of sea (or ground) into walkable ice.
   * @returns {number} voxels written
   */
  freezeSurface(ctx, cx, cz, radius, seconds) {
    const ice = this.blockId('ice');
    if (ice < 0) return 0;
    let n = 0;
    const y = Math.floor(ctx.seaHeight(cx, cz));
    for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx++) {
      for (let dz = -Math.ceil(radius); dz <= Math.ceil(radius); dz++) {
        if (dx * dx + dz * dz > radius * radius) continue;
        const x = Math.floor(cx) + dx, z = Math.floor(cz) + dz;
        if (ctx.blockAt(x, y, z) !== 0) continue;
        if (this._writeTemp(ctx, x, y, z, ice, seconds)) n++;
      }
    }
    if (n) this.fx.hieSheet(cx, y + 0.5, cz, radius);
    return n;
  }

  /** Raise a stepped ramp of ice ahead of the player. */
  buildIceRamp(ctx, x0, z0, dx, dz) {
    const ice = this.blockId('ice');
    if (ice < 0) return 0;
    let n = 0;
    const base = Math.floor(ctx.heightAt(x0, z0));
    for (let s = 1; s <= 8; s++) {
      const x = Math.floor(x0 + dx * s * 0.9);
      const z = Math.floor(z0 + dz * s * 0.9);
      const top = base + Math.ceil(s * 0.6);
      for (let y = base; y <= top; y++) {
        if (ctx.blockAt(x, y, z) !== 0) continue;
        if (this._writeTemp(ctx, x, y, z, ice, HIE_SHEET_LIFE)) n++;
      }
      this.fx.hieSpike(x + 0.5, top, z + 0.5, 0.8);
    }
    return n;
  }

  /** A wall of ice across the player's facing. Blocks projectiles; breakable; melts. */
  buildIceWall(ctx, cx, cz, dx, dz, halfLen, height) {
    const ice = this.blockId('ice');
    if (ice < 0) return 0;
    let n = 0;
    const base = Math.floor(ctx.heightAt(cx, cz));
    for (let s = -halfLen; s <= halfLen; s++) {
      const x = Math.floor(cx + dx * s);
      const z = Math.floor(cz + dz * s);
      const h = height - Math.abs(s) * 0.6;
      for (let y = base; y < base + h; y++) {
        if (ctx.blockAt(x, y, z) !== 0) continue;
        if (this._writeTemp(ctx, x, y, z, ice, HIE_WALL_LIFE)) n++;
      }
    }
    return n;
  }

  /** Set of block names fire consumes. Anything else is simply not flammable. */
  static get FLAMMABLE() { return FLAMMABLE_BLOCKS; }

  /**
   * Burn away wooden barriers around a point.
   * @returns {number} voxels removed
   */
  burnBarriers(ctx, cx, cz, radius, yCentre) {
    let n = 0;
    const y0 = Math.floor((yCentre === undefined ? ctx.heightAt(cx, cz) : yCentre));
    for (const name of FLAMMABLE_BLOCKS) {
      const id = this.blockId(name);
      if (id < 0) continue;
      for (let dy = 0; dy <= 3; dy++) {
        for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx++) {
          for (let dz = -Math.ceil(radius); dz <= Math.ceil(radius); dz++) {
            if (dx * dx + dz * dz > radius * radius) continue;
            const x = Math.floor(cx) + dx, y = y0 + dy, z = Math.floor(cz) + dz;
            if (ctx.blockAt(x, y, z) !== id) continue;
            if (!ctx.setBlock(x, y, z, 0)) continue;
            this.fx.meraBurnMark(x + 0.5, y + 0.5, z + 0.5);
            n++;
            if (n >= 24) return n;   // one press opens a doorway, not a district
          }
        }
      }
    }
    return n;
  }

  /** Fire spread along the cone's axis. */
  igniteAlong(ctx, x, z, dx, dz, reach, radius) {
    const steps = Math.max(1, Math.floor(reach / 2.5));
    for (let i = 1; i <= steps; i++) {
      this.burnBarriers(ctx, x + dx * i * 2.5, z + dz * i * 2.5, radius);
    }
  }

  ignitePoint(ctx, x, z, r) { return this.burnBarriers(ctx, x, z, r); }

  /**
   * Break voxels out of a sphere. Gura's shortcut verb: the wall is not climbed, it is deleted.
   * @returns {number} voxels removed
   */
  breakVolume(ctx, cx, cy, cz, radius) {
    let n = 0;
    const R = Math.ceil(radius);
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        for (let dz = -R; dz <= R; dz++) {
          if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
          const x = Math.floor(cx) + dx, y = Math.floor(cy) + dy, z = Math.floor(cz) + dz;
          if (ctx.blockAt(x, y, z) === 0) continue;
          if (ctx.setBlock(x, y, z, 0)) n++;
        }
      }
    }
    return n;
  }

  /** Chew the top layer off the ground in a disc, leaving a genuine scar. */
  crackGround(ctx, cx, cz, radius, depth) {
    let n = 0;
    const R = Math.ceil(radius);
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > radius * radius) continue;
        const x = Math.floor(cx) + dx, z = Math.floor(cz) + dz;
        // Only the fissure lines break, not the whole disc — a crater reads as a bug.
        if (((dx * 7 + dz * 13) & 3) !== 0) continue;
        const top = Math.floor(ctx.heightAt(x, z));
        for (let k = 0; k < depth; k++) {
          if (ctx.blockAt(x, top - k, z) === 0) continue;
          if (ctx.setBlock(x, top - k, z, 0)) n++;
        }
      }
    }
    return n;
  }

  /** Turn the surface to loose sand — suna's drain leaves the ground dead too. */
  desiccate(ctx, cx, cz, radius) {
    const sand = this.blockId('sand');
    if (sand < 0) return 0;
    let n = 0;
    const R = Math.ceil(radius);
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        if (dx * dx + dz * dz > radius * radius) continue;
        const x = Math.floor(cx) + dx, z = Math.floor(cz) + dz;
        const top = Math.floor(ctx.heightAt(x, z));
        if (ctx.blockAt(x, top, z) === 0 || ctx.blockAt(x, top, z) === sand) continue;
        if (ctx.setBlock(x, top, z, sand)) n++;
      }
    }
    return n;
  }

  /**
   * Raise the sea in rings around the player and pitch every hull inside.
   * WATER is Cluster A's; we ask it politely and shove the ship ourselves if it declines.
   */
  raiseSea(ctx, radius, lift) {
    const w = this.app && this.app.water;
    if (w && w.addSwell) w.addSwell(this.body.x, this.body.z, radius, lift);
    const ship = this.app && this.app.ship;
    if (ship) {
      const sp = this.posOf(ship, { x: 0, y: 0, z: 0 });
      const d = Math.hypot(sp.x - this.body.x, sp.z - this.body.z);
      if (d < radius) {
        const f = 1 - d / radius;
        if (ship.applyImpulse) ship.applyImpulse(0, lift * f, 0);
        else if (typeof ship.heave === 'number') ship.heave += lift * f;
      }
    }
    return true;
  }

  /**
   * Cast forward from the player's eye and return the first surface (or target) hit.
   * @param {number} range metres
   * @param {boolean} [allowAir=false] return the far end of the ray when nothing is hit
   * @returns {{x:number,y:number,z:number,target:object|null}|null}
   */
  castAnchor(range, allowAir = false) {
    const e = this.ctx.eye();
    const a = this.ctx.aim();
    const t = this.ctx.nearest(range, (x) => this.aliveOf(x));
    if (t) {
      const p = this.posOf(t, { x: 0, y: 0, z: 0 });
      const vx = p.x - e.x, vy = p.y + 1 - e.y, vz = p.z - e.z;
      const l = Math.hypot(vx, vy, vz) || 1;
      if ((vx / l) * a.x + (vy / l) * a.y + (vz / l) * a.z > 0.9) {
        return { x: p.x, y: p.y + 1, z: p.z, target: t };
      }
    }
    const step = 0.7;
    const n = Math.floor(range / step);
    for (let i = 2; i <= n; i++) {
      const x = e.x + a.x * i * step, y = e.y + a.y * i * step, z = e.z + a.z * i * step;
      if (this.ctx.blockAt(Math.floor(x), Math.floor(y), Math.floor(z)) !== 0 || y <= this.ctx.heightAt(x, z)) {
        // Anchor just before the surface so the player does not arrive inside it.
        return { x: x - a.x * step, y: Math.max(y, this.ctx.heightAt(x, z)) + 0.4, z: z - a.z * step, target: null };
      }
    }
    if (allowAir) {
      return { x: e.x + a.x * range * 0.7, y: e.y + a.y * range * 0.7, z: e.z + a.z * range * 0.7, target: null };
    }
    return null;
  }

  /** A ledge the zushi pull can reel the player toward. Same ray, land only. */
  findLedge(ctx, dir, range) {
    const e = ctx.eye();
    const step = 0.9;
    const n = Math.floor(range / step);
    for (let i = 2; i <= n; i++) {
      const x = e.x + dir.x * i * step, y = e.y + dir.y * i * step, z = e.z + dir.z * i * step;
      const h = ctx.heightAt(x, z);
      if (y <= h + 0.4 && h > ctx.seaHeight(x, z)) return { x, y: h, z };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Target plumbing (COMBAT and ENEMIES are optional collaborators)
  // -------------------------------------------------------------------------

  /** @returns {Array<object>} */
  enemyList() {
    // COMBAT owns the live roster (src/combat/combat.js `enemies`); `app.enemies` is the
    // harness-facing alias. Both are checked so FRUIT works under either wiring.
    const c = this.app && this.app.combat;
    if (c) {
      if (Array.isArray(c.enemies)) return c.enemies;
      if (typeof c.activeEnemies === 'function') return c.activeEnemies();
    }
    const e = this.app && this.app.enemies;
    if (!e) return EMPTY;
    if (Array.isArray(e.list)) return e.list;
    if (typeof e.all === 'function') return e.all();
    if (Array.isArray(e)) return e;
    return EMPTY;
  }

  /** Normalise any target's position into `out`. */
  posOf(e, out) {
    if (!e) { out.x = 0; out.y = 0; out.z = 0; return out; }
    const p = e.pos;
    if (Array.isArray(p)) { out.x = p[0]; out.y = p[1]; out.z = p[2]; return out; }
    if (p && typeof p.x === 'number') { out.x = p.x; out.y = p.y; out.z = p.z; return out; }
    out.x = e.x || 0; out.y = e.y || 0; out.z = e.z || 0;
    return out;
  }

  aliveOf(e) {
    if (!e) return false;
    if (typeof e.alive === 'boolean') return e.alive;
    if (typeof e.hp === 'number') return e.hp > 0;
    if (typeof e.dead === 'boolean') return !e.dead;
    return true;
  }

  /** Add velocity to a target through whatever channel it exposes. */
  pushTarget(e, dx, dy, dz) {
    if (!e) return;
    const c = this.app && this.app.combat;
    if (c && c.applyImpulse) { c.applyImpulse(e, dx, dy, dz); return; }
    if (typeof e.addImpulse === 'function') { e.addImpulse({ x: dx, y: dy, z: dz }); return; }
    const v = e.vel || e.velocity;
    if (Array.isArray(v)) { v[0] += dx; v[1] += dy; v[2] += dz; return; }
    if (v && typeof v.x === 'number') { v.x += dx; v.y += dy; v.z += dz; return; }
    if (typeof e.vx === 'number') { e.vx += dx; e.vy += dy; e.vz += dz; return; }
    const p = e.pos;
    if (Array.isArray(p)) { p[0] += dx * 0.05; p[1] += dy * 0.05; p[2] += dz * 0.05; }
    else if (p && typeof p.x === 'number') { p.x += dx * 0.05; p.y += dy * 0.05; p.z += dz * 0.05; }
  }

  /** FRUIT-local status bag for a target. Only used when COMBAT has no status service. */
  statusOf(target) {
    let s = this.statuses.get(target);
    if (!s) { s = { burn: 0, frozen: 0, slow: 0, blind: 0, drain: 0, shattered: 0, seaquake: 0 }; this.statuses.set(target, s); }
    return s;
  }

  _stepStatuses(dt) {
    if (this.statuses.size === 0) return;
    for (const [target, s] of this.statuses) {
      let any = false;
      for (const k in s) {
        if (s[k] > 0) { s[k] = Math.max(0, s[k] - dt); any = any || s[k] > 0; }
      }
      // Burn and drain keep hurting after the caster has moved on — that is what makes
      // them worth applying instead of just doing damage now.
      if (s.burn > 0 && this.aliveOf(target)) this._tickDot(target, 5 * dt, 'fire');
      if (s.drain > 0 && this.aliveOf(target)) this._tickDot(target, 4 * dt, 'drain');
      if (!any && !this.aliveOf(target)) {
        this.statuses.delete(target);
        if (this._dotAcc) this._dotAcc.delete(target);
      }
    }
  }

  /**
   * Damage-over-time tick. Billed in WHOLE points a few times a second (mirroring combat's own
   * DoT path in damage.js) and passed with poise/hitstop/knockback/crit all zeroed. Passing a
   * bare {damage} let applyHit normalise each 60 Hz sliver into a full melee hit — 10 poise,
   * hitstop, slash particles and hit sfx every step, which stagger-locked targets and sprayed
   * feedback the whole time a burn was running.
   */
  _tickDot(target, amount, kind) {
    this.stats.damage += amount;
    const c = this.app && this.app.combat;
    if (!c || !c.applyHit) return;
    const acc = this._dotAcc || (this._dotAcc = new Map());
    let rec = acc.get(target);
    if (!rec) { rec = { fire: 0, drain: 0 }; acc.set(target, rec); }
    rec[kind] = (rec[kind] || 0) + amount;
    if (rec[kind] < 1) return;
    const n = Math.floor(rec[kind]);
    rec[kind] -= n;
    const p = this.posOf(target, { x: 0, y: 0, z: 0 });
    c.applyHit(target, {
      damage: n, poise: 0, knockback: 0, launch: 0, hitstop: 0,
      critChance: 0, critMult: 1, blockable: 0, guardCost: 0, tags: [],
      fxKind: kind === 'fire' ? 'flame' : 'sand', source: 'fruit',
      px: p.x, py: p.y + 1.1, pz: p.z,
    });
  }

  // -------------------------------------------------------------------------
  // Small helpers shared by the kits
  // -------------------------------------------------------------------------

  forward(out) { return this.ctx.forward(out || { x: 0, y: 0, z: 0 }); }

  /** The stick direction if there is one, otherwise where the camera is looking. */
  moveOrForward() {
    const st = this.app && this.app.input && this.app.input.state;
    const f = this.forward();
    if (!st || (Math.abs(st.moveX) < 0.05 && Math.abs(st.moveZ) < 0.05)) return f;
    const r = { x: -f.z, y: 0, z: f.x };
    const x = f.x * -st.moveZ + r.x * st.moveX;
    const z = f.z * -st.moveZ + r.z * st.moveX;
    const l = Math.hypot(x, z) || 1;
    return { x: x / l, y: 0, z: z / l };
  }

  /**
   * Ask for an animation state. `intent` may be one of FRUIT's own pose names (mapped onto
   * states Cluster B actually ships) or a real state name. The result is published as
   * `app.fruit.animState` for PLAYER to honour, and pushed at the rig if it takes one directly.
   * @param {string} intent
   */
  setAnim(intent) {
    const state = MOVE_ANIM[intent] || intent;
    this.animRequest = state;
    const rig = this.rig;
    if (rig && rig.play) rig.play(state);
    else if (this.app && this.app.anim && this.app.anim.request) this.app.anim.request(state);
  }

  /** The Animator state FRUIT wants this step, or null. Read by PLAYER (ARCHITECTURE §9). */
  get animState() { return this.animRequest; }

  /**
   * Pin the player to the ground while a compression charges.
   *
   * WHY here rather than a flag PLAYER must read: FRUIT steps *after* PLAYER (ARCHITECTURE §4),
   * so the jump the controller applied is already in the velocity. Cancelling it turns
   * "hold JUMP" into a wind-up with no change to the player controller at all.
   */
  suppressJump() {
    const b = this.body;
    if (b.vy > 0) b.vy = 0;
    b.grounded = true;
    this.overriding = true;
    this.mods.overrideJump = true;
  }

  shake(a, d) { this.ctx.shake(a, d); }
  sound(n, o) { this.ctx.sound(n, o); }
  toast(t, k) { this.ctx.toast(t, k); }

  /** QUEST wants to know, and bounty depends on who saw it. */
  notifyFruitUse(move) {
    const q = this.app && (this.app.quests || this.app.quest);
    if (!q || !q.notify) return;
    const w = this.app.world;
    const town = !!(w && w.inTown && w.inTown(this.body.x, this.body.z));
    let seen = false;
    const list = this.enemyList();
    for (let i = 0; i < list.length && !seen; i++) {
      const p = this.posOf(list[i], { x: 0, y: 0, z: 0 });
      if (Math.hypot(p.x - this.body.x, p.z - this.body.z) < 30) seen = true;
    }
    if (!seen && this.app.npc && this.app.npc.anyNear) {
      seen = !!this.app.npc.anyNear(this.body.x, this.body.z, 30);
    }
    q.notify('fruitUsed', { fruitId: this.fruitId, move, seen: seen || town, town });
  }

  // -------------------------------------------------------------------------
  // Presentation adapters (UI owns drawing; we only supply state)
  // -------------------------------------------------------------------------

  /**
   * The `st.fruit` block src/ui/hud.js draws.
   * @returns {object|null}
   */
  hudState() {
    if (!this.def) return null;
    const list = this.def.abilities;
    const abilities = new Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const cd = this.runner.cooldownOf(a.id);
      abilities[i] = {
        id: a.id, name: a.name, icon: a.icon, key: String(a.slot),
        cooldown: cd, cooldownMax: a.cooldown * this.runner.cooldownScale,
        cost: a.cost, color: this.def.color,
        ready: cd <= 0 && this.meter.can(a.cost) && !this.meter.locked,
        locked: this.meter.locked,
      };
    }
    return {
      id: this.def.id, name: this.def.name, color: this.def.color, icon: this.def.icon,
      abilities, meter: this.meter.value, meterMax: this.meter.max,
      sealed: this.meter.locked, wet: this.wetness,
    };
  }

  /**
   * The array src/ui/menus.js `getFruits()` expects for the wheel.
   * @returns {Array<object>}
   */
  wheelFruits() {
    const un = new Set(this.unlocked());
    return FRUIT_IDS.map((id) => {
      const f = FRUITS[id];
      return {
        id, name: f.name, color: f.color, icon: f.icon,
        unlocked: un.has(id), equipped: this.fruitId === id,
        desc: f.desc + ' ' + f.drawback,
        hint: f.kit.hint,
        traversal: TRAVERSAL_FLAGS.filter((t) => f.caps[t]),
        abilities: f.abilities.map((a) => ({ name: a.name, icon: a.icon, desc: a.desc })),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Save
  // -------------------------------------------------------------------------

  serialize() {
    return {
      fruit: this.fruitId,
      granted: Array.from(this.granted),
      meter: this.meter.serialize(),
      runner: this.runner.serialize(),
      wetness: Math.round(this.wetness * 1000) / 1000,
      rescues: this.rescues,
    };
  }

  deserialize(o) {
    if (!o) return;
    // Temporary ice never survives a load: the world it was written into is being rebuilt.
    this.revertTempBlocks();
    this.fx.clearDecals();
    this.statuses.clear();
    if (Array.isArray(o.granted)) { this.granted.clear(); for (const g of o.granted) this.granted.add(g); }
    if (o.fruit && FRUITS[o.fruit]) this.equip(o.fruit, true);
    this.meter.deserialize(o.meter);
    this.runner.deserialize(o.runner);
    if (typeof o.wetness === 'number') this.wetness = clamp01(o.wetness);
    if (typeof o.rescues === 'number') this.rescues = o.rescues;
  }

  dispose() {
    this.revertTempBlocks();
    this.fx.dispose();
    this.statuses.clear();
  }
}

/** Damage kinds sand phases through. Elemental and quake damage still lands. */
const PHYSICAL_KINDS = new Set(['blunt', 'slash', 'pierce', 'melee', 'bullet', 'cannon', undefined]);

/** Blocks fire consumes. Names come from gen/blocks.js. */
const FLAMMABLE_BLOCKS = Object.freeze([
  'plank', 'plankV', 'wood', 'woodDark', 'thatch', 'barrel', 'rope', 'sail', 'sailShade',
  'paper', 'flagRed', 'leaves', 'leavesPalm', 'leavesCherry', 'leavesAutumn', 'leavesPine',
]);

const HIE_WALL_LIFE = 12;

const EMPTY = Object.freeze([]);

/**
 * Factory. Registered by src/game.js as `app.addSystem('fruit', createFruitSystem(app))`.
 * @param {object} app
 * @param {object} [opts]
 * @returns {FruitSystem}
 */
export function createFruitSystem(app, opts) {
  return new FruitSystem(app, opts || {});
}

export { TRAVERSAL_FLAGS, capsSignature, abilitiesFor, ABILITIES, ABILITY_BY_ID, ABILITIES_BY_FRUIT };
export default FruitSystem;
