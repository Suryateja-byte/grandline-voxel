// Sailing physics. Owner: SHIP.
//
// The bar is Sea of Thieves: the ship must feel HEAVY and DRIVEN BY THE WATER, not slid across
// a flat plane with a wobble bolted on. The only way to get that is to take the wave field
// seriously, so this file does exactly one clever thing and does it properly:
//
//   Eight points along the hull each sample `app.water.sampleHeight(x, z)` — the CPU port of
//   the ocean vertex shader, so it is the *same* water the player can see. Each point produces
//   an upward force proportional to how deep it is. Summed, those forces are heave. Their
//   moments about the hull's own axes are pitch and roll. Nothing is faked: when a swell passes
//   under the bow, the bow lifts because the bow's sample points went deeper.
//
// Everything else is a rig on top of that: square-sail thrust from the true point of sail,
// speed-dependent rudder authority, quadratic hull drag with a wave-making wall at hull speed,
// heavy lateral resistance that still lets you slip to leeward, and a broaching torque that
// makes a beam sea in a storm genuinely dangerous.
//
// Determinism: no wall clock, no Math.random, all integration is semi-implicit Euler at the
// fixed 1/60 step. Same seed + same inputs => same state, verified by tools/check-ship.mjs.

import { clamp, clamp01, lerp, smoothstep, TAU } from '../core/math.js';
import { Rng } from '../core/rng.js';

// --- rigid body constants ---------------------------------------------------
// Tuned against a 19 m, ~40 t caravel. Every number below has a physical meaning; if you change
// one, change it for a reason you can state.

/** Displacement in kg. */
export const SHIP_MASS = 40000;
const G = 9.81;
/** Equilibrium submersion of a keel-level sample point (= the design draft). */
const DRAFT = 1.75;
/** Per-point buoyancy stiffness, chosen so 8 points at DRAFT exactly carry the ship. */
const BUOY_K = (SHIP_MASS * G) / (8 * DRAFT);
/** Heave damping. zeta ~ 0.55 against the 8-point spring: settles in about two swings. */
const HEAVE_C = 104000;
/** Roll inertia including added mass. Gives a ~4.5 s roll period — a heavy, slow ship. */
const ROLL_I = 350000;
const ROLL_C = 273000;
/** Pitch inertia including added mass. ~3.2 s period. */
const PITCH_I = 1550000;
const PITCH_C = 2550000;
/** Yaw inertia. */
const YAW_I = 1600000;
const YAW_C = 1250000;

/** Hull speed for a 19 m waterline: past this, wave-making drag becomes a wall. */
const V_HULL = 5.3;
/** Forward drag coefficient, N per (m/s)^2. */
const DRAG_F = 900;
/** Lateral drag. A hull is roughly 14x harder to push sideways than forward. */
const DRAG_L = 12600;
const DRAG_L_LIN = 5200;
/** Sail thrust scale — see sailPressure(). */
const SAIL_K = 1458;
/** Height of the centre of effort above the waterline, metres. Drives heel. */
const CE_HEIGHT = 6.4;
/** Rudder authority. Torque = RUD_K * sin(angle) * vFwd * |vFwd|. */
const RUD_K = 62000;
const RUDDER_MAX = 0.60;         // radians of blade angle at full helm
const HELM_RATE = 0.85;          // how fast the wheel turns, full-scale per second
/**
 * Weathervane: the rig pushes the bow toward the wind. It has to be *felt* near head-to-wind so
 * that irons is sticky, and it has to stay small once you are close hauled — tuned high, it beats
 * the rudder at low speed and the ship rounds up into an unrecoverable stall, which is what the
 * first docking run of tools/check-ship.mjs found (65 of 200 approaches never reached the dock).
 */
const WV_K = 900;
/** Above this apparent wind angle the weathervane has faded out entirely. */
const WV_FADE = [0.50, 1.40];
/** Broaching: a beam sea shoves the stern around. Scales with wave steepness and speed. */
const BROACH_K = 210000;
/** Anchor holding force. */
const ANCHOR_K = 46000;
const ANCHOR_C = 68000;

const KNOTS = 1.94384;

/** Points of sail, in increasing apparent wind angle. Read by the HUD. */
export const POINTS_OF_SAIL = Object.freeze(['irons', 'close hauled', 'beam reach', 'broad reach', 'running']);

/**
 * Square-rig efficiency against apparent wind angle (radians, 0 = head to wind).
 * Monotonically increasing to a maximum dead downwind — that is genuinely how a square rig
 * behaves, and it is why running is the fastest point of sail on this ship. Below ~21 degrees
 * the sail cannot fill at all: that is irons.
 * @param {number} awa apparent wind angle in radians, 0..PI
 * @returns {number} 0..1
 */
export function sailEfficiency(awa) {
  const a = clamp(Math.abs(awa), 0, Math.PI);
  const raw = (1 - Math.cos(a)) * 0.5;              // 0 head-to-wind, 1 dead downwind
  // The cut-off sits at 35-57 degrees on purpose. A square rig genuinely cannot point high, and
  // a WIDE, decisive no-go zone is also what makes the ship recoverable: inside it the sail is
  // unambiguously aback and drives her astern, instead of leaving a band where she neither
  // sails nor backs and therefore cannot steer at all.
  return Math.pow(raw, 0.70) * smoothstep(0.62, 1.00, a);
}

/**
 * How hard the sail is ABACK — pressing on its forward face and driving the ship astern.
 * A square sail inside the no-go zone does exactly this, and it is not a penalty invented for
 * flavour: it is the only way out of irons. Gather sternway, put the helm over (the rudder
 * reverses with the flow), and the bow falls off the wind. Without it a stalled square rigger
 * is stuck head to wind for ever, which the docking run of tools/check-ship.mjs found the hard
 * way — 13 of 100 approaches simply stopped, pinned at 10-20 degrees off the wind.
 *
 * @param {number} awa radians 0..PI
 * @returns {number} 0..1
 */
export function sailAback(awa) {
  return smoothstep(1.05, 0.20, clamp(Math.abs(awa), 0, Math.PI));
}

/**
 * Fraction of full drive a fully-backed sail delivers, astern.
 *
 * The band deliberately OVERLAPS the bottom of the luff, so there is no angle at which the sail
 * neither draws nor backs — a gap like that leaves the ship with no drive, no sternway and
 * therefore no steerage, which is a state you cannot leave. Net drive crosses zero at about
 * 41 degrees: that is the ship's real no-go limit, and it is the number the HUD's "irons"
 * reading is cut at.
 */
const ABACK_DRIVE = 0.13;
/**
 * Yaw torque from a backed sail with the yard braced round. This is box-hauling: with the sail
 * pressing on its wrong side and the yard swung, the rig itself levers the bow off the wind.
 * It is what makes irons a thing you get OUT of by holding the wheel over for a few seconds,
 * instead of a state the ship dies in — and it is the reason the wheel still does something
 * when there is no water flowing past the rudder.
 */
const ABACK_YAW = 17000;
/**
 * Floor on the pressure used for the box-haul torque only. The rig's aerodynamic force scales as
 * wind^1.5, which in a 4 m/s breeze is not enough to swing 40 tonnes of hull — and a ship that
 * cannot leave irons in light air is a soft-lock, not a challenge. The floor stands in for the
 * crew on the braces and the sweeps, which do not care how hard it is blowing.
 */
const ABACK_MIN_PRESS = 16;

/**
 * Name the point of sail. Exposed on the HUD so the player can learn the rig by reading it.
 * @param {number} awa radians 0..PI
 */
export function pointOfSailName(awa) {
  const d = Math.abs(awa) * 180 / Math.PI;
  if (d < 45) return 'irons';          // inside the no-go: the sail is aback, you are going astern
  if (d < 70) return 'close hauled';
  if (d < 110) return 'beam reach';
  if (d < 150) return 'broad reach';
  return 'running';
}

/**
 * Dynamic pressure the rig can convert into thrust. Wind is capped before the exponent because
 * a raw v^2 law turns a 24 m/s storm into a 40-knot ship, which is not a ship any more.
 * @param {number} windSpeed m/s
 */
export function sailPressure(windSpeed) {
  return Math.pow(clamp(windSpeed, 0, 18), 1.5);
}

/** Default buoyancy layout, used when no model is supplied (headless tests). */
const DEFAULT_BUOY = Object.freeze([
  { x: 0.0, y: -DRAFT, z: 8.3 },
  { x: -1.6, y: -DRAFT, z: 4.6 }, { x: 1.6, y: -DRAFT, z: 4.6 },
  { x: -2.4, y: -DRAFT, z: 0.0 }, { x: 2.4, y: -DRAFT, z: 0.0 },
  { x: -2.0, y: -DRAFT, z: -4.6 }, { x: 2.0, y: -DRAFT, z: -4.6 },
  { x: 0.0, y: -DRAFT, z: -8.4 },
]);

/**
 * The ship's rigid body and rig.
 *
 * All public angles are radians. All public speeds are m/s except `speedKnots`.
 */
export class SailingBody {
  /**
   * @param {object} [opts]
   *  points  buoyancy sample points in ship-local metres
   *  seed    world seed, used only for the (deterministic) creak/spray cadence
   */
  constructor(opts = {}) {
    this.points = opts.points || DEFAULT_BUOY;
    this.rng = new Rng(((opts.seed >>> 0) || 1) ^ 0x5341494c).fork('sailing');

    // --- pose -------------------------------------------------------------
    this.pos = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.yawRate = 0;
    this.pitchRate = 0;
    this.rollRate = 0;

    // --- rig --------------------------------------------------------------
    /** Sail set, 0 = furled, 1 = full. */
    this.sailTrim = 0;
    this.sailTarget = 0;
    /** Yard rotation relative to the hull, radians. The rig braces itself to the wind. */
    this.yardAngle = 0;
    /** Helm, -1 (hard to port) .. +1 (hard to starboard). Holds where you leave it. */
    this.helm = 0;
    /** Wheel rotation for the visual, radians. Geared 1.5 turns lock to lock. */
    this.wheelAngle = 0;
    this.anchorDown = false;
    this.anchorPos = { x: 0, z: 0 };
    /** 0 stowed .. 1 fully down. Simulated, not render-smoothed, so a captured frame is exact. */
    this.anchorDeploy = 0;
    /** 0..1 — how badly the sail is flogging. Drives the sail sound and the flapping mesh. */
    this.luff = 0;

    // --- readouts ---------------------------------------------------------
    this.speed = 0;
    this.speedKnots = 0;
    this.forwardSpeed = 0;
    this.lateralSpeed = 0;
    this.apparentWind = Math.PI;
    this.apparentWindSigned = Math.PI;
    this.pointOfSail = 'irons';
    this.heelAngle = 0;
    this.windSpeed = 0;
    this.windAngle = 0;
    this.waveHeight = 0;
    this.submersion = DRAFT;
    this.broaching = 0;
    this.beached = false;
    /** 0..1 — how hard the sail is pressing on its wrong side. See sailAback(). */
    this.aback = 0;

    // --- external modifiers ----------------------------------------------
    this.bonus = { sailSpeedMult: 1, turnRateMult: 1, stormDriftMult: 1 };
    this.upgrade = { stormSpeedMult: 1, stormDriftMult: 1 };
    /** Set true by dock.js while a scripted voyage owns the hull. */
    this.scripted = false;

    this._wakeAcc = 0;
    this._sprayAcc = 0;
    this._creakAcc = 0;
    this._sample = { y: 0, nx: 0, ny: 1, nz: 0, dx: 0, dz: 0 };
    this._depths = new Float64Array(this.points.length);
  }

  /** Replace the buoyancy layout (called when the ship model is rebuilt after an upgrade). */
  setPoints(points) {
    this.points = points;
    this._depths = new Float64Array(points.length);
  }

  /** Unit forward vector in world XZ. yaw = atan2(dx, dz) per ARCHITECTURE §3. */
  forward() { return { x: Math.sin(this.yaw), z: Math.cos(this.yaw) }; }

  /** Unit starboard vector in world XZ. */
  starboard() { return { x: Math.cos(this.yaw), z: -Math.sin(this.yaw) }; }

  /** Convert a ship-local offset to world space (full yaw/pitch/roll). */
  toWorld(lx, ly, lz, out) {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cr = Math.cos(this.roll), sr = Math.sin(this.roll);
    // Roll about the local Z (fore-aft) axis, then pitch about the local X axis.
    const x1 = lx * cr - ly * sr;
    const y1 = lx * sr + ly * cr;
    const y2 = y1 * cp - lz * sp;
    const z2 = y1 * sp + lz * cp;
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const o = out || {};
    o.x = this.pos.x + x1 * cy + z2 * sy;
    o.y = this.pos.y + y2;
    o.z = this.pos.z - x1 * sy + z2 * cy;
    return o;
  }

  /** Convert a world position to ship-local metres. Exact inverse of toWorld(). */
  toLocal(wx, wy, wz, out) {
    const dx = wx - this.pos.x, dy = wy - this.pos.y, dz = wz - this.pos.z;
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const x1 = dx * cy - dz * sy;
    const z2 = dx * sy + dz * cy;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const y1 = dy * cp + z2 * sp;
    const lz = -dy * sp + z2 * cp;
    const cr = Math.cos(this.roll), sr = Math.sin(this.roll);
    const o = out || {};
    o.x = x1 * cr + y1 * sr;
    o.y = -x1 * sr + y1 * cr;
    o.z = lz;
    return o;
  }

  /** Raise sail one notch. Bound to `sailUp`. */
  raiseSail(step = 0.25) { this.sailTarget = clamp01(this.sailTarget + step); }
  /** Reef sail one notch. Bound to `sailDown`. */
  lowerSail(step = 0.25) { this.sailTarget = clamp01(this.sailTarget - step); }
  /** Drop or weigh the anchor. Returns the new state. */
  toggleAnchor() {
    this.anchorDown = !this.anchorDown;
    if (this.anchorDown) { this.anchorPos.x = this.pos.x; this.anchorPos.z = this.pos.z; }
    return this.anchorDown;
  }
  /** Bring the helm amidships — the one thing a held wheel needs. */
  centreHelm() { this.helm = 0; }

  /**
   * Merge crew and upgrade modifiers.
   * @param {object} crewBonus from QuestSystem.activeBonuses()
   * @param {object} upgradeEffect from QuestSystem.shipUpgrades().effect
   */
  setModifiers(crewBonus, upgradeEffect) {
    const b = crewBonus || {};
    this.bonus.sailSpeedMult = b.sailSpeedMult || 1;
    this.bonus.turnRateMult = b.turnRateMult || 1;
    this.bonus.stormDriftMult = b.stormDriftMult || 1;
    const u = upgradeEffect || {};
    this.upgrade.stormSpeedMult = u.stormSpeedMult || 1;
    this.upgrade.stormDriftMult = u.stormDriftMult || 1;
  }

  /**
   * One fixed step of the rigid body.
   *
   * @param {number} dt fixed 1/60
   * @param {object} ctx { water, weather, input, fx, audio, world }
   */
  step(dt, ctx) {
    const water = ctx.water;
    const weather = ctx.weather || { wind: 4, waveScale: 0.55, storm: 0 };

    // --- 1. sail and helm controls --------------------------------------------------------
    // The sail takes real time to set: about 3.3 s from furled to full, which is what makes
    // "I should have reefed" a decision rather than a keypress.
    const trimRate = this.sailTarget > this.sailTrim ? 0.30 : 0.45;
    if (Math.abs(this.sailTarget - this.sailTrim) < trimRate * dt) this.sailTrim = this.sailTarget;
    else this.sailTrim += Math.sign(this.sailTarget - this.sailTrim) * trimRate * dt;

    this.wheelAngle = this.helm * Math.PI * 3.0;    // 1.5 turns each way
    // The anchor takes about four seconds to run out or come home. Kept in the simulation rather
    // than smoothed in preRender, because preRender must not own state a capture depends on.
    this.anchorDeploy += ((this.anchorDown ? 1 : 0) - this.anchorDeploy) * clamp01(dt * 1.1);

    // --- 2. wind and point of sail --------------------------------------------------------
    // The wind blows TOWARD water.windAngle: waves and wind share a direction, which is what
    // makes "the sea is coming from over there" legible without a HUD arrow.
    const wa = water ? water.windAngle : 0;
    this.windAngle = wa;
    this.windSpeed = weather.wind;
    const fromX = -Math.cos(wa), fromZ = -Math.sin(wa);
    const fwd = this.forward();
    const stb = this.starboard();
    // Positive = the wind is on the starboard bow.
    const awaSigned = Math.atan2(fromX * stb.x + fromZ * stb.z, fromX * fwd.x + fromZ * fwd.z);
    this.apparentWindSigned = awaSigned;
    this.apparentWind = Math.abs(awaSigned);
    this.pointOfSail = pointOfSailName(this.apparentWind);

    const eff = sailEfficiency(this.apparentWind);
    this.aback = sailAback(this.apparentWind);
    // Brace the yard: square to the wind when running, hauled round when close hauled. When the
    // sail is aback the crew brace it to ASSIST the rudder — which means following the way the
    // rudder is actually working, and a rudder reverses when the ship gathers sternway. Brace to
    // the helm alone and the rig fights the rudder in exactly the situation where you need every
    // newton of it. Both cases are visible on the model.
    const rudderSign = this.forwardSpeed < -0.15 ? -1 : 1;
    // The gate is low on purpose. Braced only when the sail is hard aback, the rig stops helping
    // just above the no-go — and that leaves a band around 45 degrees with almost no drive and no
    // assist, where the ship sits at a fifth of a knot and cannot turn. Helping from the moment
    // the sail starts to back removes the band entirely.
    const braceTarget = this.aback > 0.12
      ? clamp(this.helm * rudderSign * 1.05, -1.1, 1.1)
      : clamp(-awaSigned * 0.55, -1.1, 1.1);
    this.yardAngle += (braceTarget - this.yardAngle) * clamp01(dt * 1.4);

    this.luff = clamp01((1 - eff * 3.2) * this.sailTrim);

    // --- 3. buoyancy: heave, pitch and roll from the actual wave field ---------------------
    let fUp = 0, tauPitch = 0, tauRoll = 0, wetPoints = 0, sumDepth = 0;
    const p = this.points;
    const wp = { x: 0, y: 0, z: 0 };
    let waveAtCentre = 0;
    if (water) {
      water.sampleHeight(this.pos.x, this.pos.z, this._sample);
      waveAtCentre = this._sample.y;
    }
    this.waveHeight = waveAtCentre;

    for (let i = 0; i < p.length; i++) {
      this.toWorld(p[i].x, p[i].y, p[i].z, wp);
      const surface = water ? water.heightAt(wp.x, wp.z) : 0;
      // Submersion is one-sided: a point in the air produces no force at all. That asymmetry is
      // what stops the ship being a spring bolted to sea level and lets the bow leave the water.
      const d = clamp(surface - wp.y, 0, 3.6);
      this._depths[i] = d;
      sumDepth += d;
      if (d > 0.01) wetPoints++;
      const f = BUOY_K * d;
      fUp += f;
      // Torques of a vertical force at a lever arm, in the hull's own frame:
      //   about local X:  tau_x = -z * f   (a lift under the bow drives pitch negative = bow up)
      //   about local Z:  tau_z = +x * f   (a lift to starboard drives roll positive = starboard up)
      // Getting either sign backwards turns the restoring spring into positive feedback and the
      // ship lies on its beam ends in flat water — which is exactly what the first run of
      // tools/check-ship.mjs caught.
      tauPitch -= f * p[i].z;
      tauRoll += f * p[i].x;
    }
    this.submersion = sumDepth / p.length;
    const wetFrac = wetPoints / p.length;

    // Heave.
    const damp = HEAVE_C * Math.max(0.18, wetFrac);
    const ay = (fUp - SHIP_MASS * G - damp * this.vel.y) / SHIP_MASS;
    this.vel.y += ay * dt;
    this.pos.y += this.vel.y * dt;

    // --- 4. rig forces --------------------------------------------------------------------
    const stormMult = lerp(1, this.upgrade.stormSpeedMult, clamp01(weather.storm));
    const press = sailPressure(this.windSpeed);
    // Net drive: forward from a filled sail, astern from a backed one. Between them lies the
    // luff, where the cloth shakes and nothing happens at all.
    const drive = eff - this.aback * ABACK_DRIVE;
    const thrust = SAIL_K * press * drive * this.sailTrim * this.bonus.sailSpeedMult * stormMult
      * clamp01(wetFrac * 1.6);   // a hull half out of the water is not being driven
    // Lateral force: maximal on a beam wind, zero dead downwind. This is leeway, and it is why
    // close hauled costs you ground even when the speed number looks fine.
    const driftMult = this.bonus.stormDriftMult * this.upgrade.stormDriftMult;
    const lateral = Math.max(0, thrust) * 0.55 * Math.sin(awaSigned)
      * lerp(1, driftMult, clamp01(weather.storm));

    // --- 5. hull drag ---------------------------------------------------------------------
    const vF = this.vel.x * fwd.x + this.vel.z * fwd.z;
    const vL = this.vel.x * stb.x + this.vel.z * stb.z;
    this.forwardSpeed = vF;
    this.lateralSpeed = vL;
    const over = Math.max(0, Math.abs(vF) / V_HULL - 1);
    const wall = 1 + 6 * over * over;          // wave-making drag past hull speed
    const dragF = -DRAG_F * vF * Math.abs(vF) * wall;
    const dragL = -DRAG_L * vL * Math.abs(vL) - DRAG_L_LIN * vL;

    let fx = fwd.x * (thrust + dragF) + stb.x * (lateral + dragL);
    let fz = fwd.z * (thrust + dragF) + stb.z * (lateral + dragL);

    // Waves push the hull along their own slope: this is what makes running before a sea feel
    // like being carried rather than driven.
    if (water) {
      // Downhill direction of the surface. For this normal convention dh/dx = -nx/ny, so the
      // downhill (accelerating) direction is +nx/ny. Sign it the other way and the ship crawls
      // uphill out of every trough.
      const n = this._sample;
      const slopeX = n.nx / Math.max(n.ny, 0.2);
      const slopeZ = n.nz / Math.max(n.ny, 0.2);
      const surge = SHIP_MASS * G * 0.26 * clamp01(this.submersion / DRAFT);
      fx += slopeX * surge;
      fz += slopeZ * surge;
    }

    // Anchor: a spring back to where the flukes bit, plus heavy damping.
    if (this.anchorDown) {
      const ax = this.anchorPos.x - this.pos.x, az = this.anchorPos.z - this.pos.z;
      const r = Math.hypot(ax, az);
      const scope = 9;
      if (r > scope) {
        const k = ANCHOR_K * (r - scope);
        fx += (ax / r) * k;
        fz += (az / r) * k;
      }
      fx -= this.vel.x * ANCHOR_C;
      fz -= this.vel.z * ANCHOR_C;
    }

    // `scripted` is set while dock.js drives a fast-travel voyage. Horizontal motion belongs to
    // the course in that case, but everything else — buoyancy, heel, wake, spray — keeps running,
    // which is what makes the voyage a real sail rather than a fade to black.
    if (!this.scripted) {
      this.vel.x += (fx / SHIP_MASS) * dt;
      this.vel.z += (fz / SHIP_MASS) * dt;
      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
    }
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    this.speedKnots = this.speed * KNOTS;

    // --- 6. angular: roll, pitch, yaw ------------------------------------------------------
    // Heel: the sail's lateral force acting at the centre of effort. Heeling INTO a turn is the
    // single clearest signal that the ship has weight, so the rudder contributes too.
    const heelTorque = -lateral * CE_HEIGHT - this.yawRate * vF * SHIP_MASS * 0.055;
    const rollAcc = (tauRoll + heelTorque - ROLL_C * this.rollRate) / ROLL_I;
    this.rollRate += rollAcc * dt;
    this.roll = clamp(this.roll + this.rollRate * dt, -1.05, 1.05);
    if (Math.abs(this.roll) >= 1.049) this.rollRate *= 0.3;
    this.heelAngle = this.roll;

    const pitchAcc = (tauPitch - PITCH_C * this.pitchRate) / PITCH_I;
    this.pitchRate += pitchAcc * dt;
    this.pitch = clamp(this.pitch + this.pitchRate * dt, -0.62, 0.62);
    if (Math.abs(this.pitch) >= 0.619) this.pitchRate *= 0.3;

    // Rudder: authority scales with the square of the water flowing past the blade, so a
    // stopped ship cannot steer and a fast one turns hard. That is the whole feel of a helm.
    const bladeAngle = this.helm * RUDDER_MAX;
    // Blade force is quadratic in flow, plus a small linear term: a real rudder still bites a
    // little at walking pace, and without it the ship becomes unsteerable exactly when you most
    // need to steer, which is on the last twenty metres of a docking approach.
    let tauYaw = RUD_K * Math.sin(bladeAngle) * vF * (Math.abs(vF) + 0.9) * this.bonus.turnRateMult;
    // Weather helm, faded out above close hauled — see WV_K.
    const wvFade = 1 - smoothstep(WV_FADE[0], WV_FADE[1], this.apparentWind);
    tauYaw += WV_K * press * Math.sin(awaSigned) * (0.35 + this.sailTrim * 0.9) * wvFade;
    // Box-hauling out of irons: see ABACK_YAW.
    tauYaw += ABACK_YAW * Math.max(press, ABACK_MIN_PRESS) * this.aback * this.sailTrim
      * Math.sin(this.yardAngle);
    // Broaching. A steep sea taken on the beam throws the stern downwind; enough of it and the
    // ship rounds up out of control. Recoverable, but only if you see it coming.
    let broach = 0;
    if (water) {
      const n = this._sample;
      const slopeLat = (n.nx * stb.x + n.nz * stb.z) / Math.max(n.ny, 0.2);
      broach = slopeLat * (weather.waveScale || 0.55) * clamp01(Math.abs(vF) / 3.5);
      tauYaw += BROACH_K * broach * driftMult;
      tauRoll += 0;   // roll already gets the sea through the point forces
    }
    this.broaching = clamp01(Math.abs(broach) * 1.4);
    tauYaw -= YAW_C * this.yawRate * (1 + 0.55 * Math.abs(vF));
    if (!this.scripted) {
      this.yawRate += (tauYaw / YAW_I) * dt;
      this.yaw += this.yawRate * dt;
    }
    if (this.yaw > Math.PI) this.yaw -= TAU;
    if (this.yaw < -Math.PI) this.yaw += TAU;

    // --- 7. grounding ---------------------------------------------------------------------
    // Never let the hull sink into terrain. The world owner gives us heightAt; if the seabed is
    // above our keel we ride on it and lose way, which is exactly what running aground is.
    this.beached = false;
    if (ctx.world && typeof ctx.world.heightAt === 'function') {
      const g = ctx.world.heightAt(this.pos.x, this.pos.z);
      // Water under the keel, measured against the LOCAL SURFACE rather than the hull's own
      // height. That distinction is the whole behaviour: when a crest rolls through, the
      // clearance goes positive and she floats free for a second — which is how a ship gets off
      // a bank in a seaway, and why running aground is a scare in a storm and a disaster in a
      // calm. Measured against a pinned hull height instead, the clearance never recovers and
      // one bad landfall is a soft-lock; tools/check-ship.mjs found the ship stuck on a beach
      // at zero knots for the remaining five minutes of a run.
      const clearance = Number.isFinite(g) ? (waveAtCentre - g) - DRAFT : 1;
      if (clearance < 0) {
        this.beached = true;
        // She rests on the bottom, but never climbs the beach: cap the lift just under the level
        // she would float at, so a grounded hull sits proud of the water, not on top of it.
        const rest = Math.min(g + DRAFT, waveAtCentre + DRAFT * 0.9);
        if (this.pos.y < rest) {
          this.pos.y = rest;
          if (this.vel.y < 0) this.vel.y = 0;
        }
        // Scrubbing drag, proportional to how hard she is on. Deliberately not a hard stop: a
        // grounded ship has to be able to sail herself off.
        const bite = clamp01(-clearance / 1.2);
        const k = clamp01(2.6 * bite * dt);
        this.vel.x -= this.vel.x * k;
        this.vel.z -= this.vel.z * k;
        this.yawRate -= this.yawRate * clamp01(1.6 * bite * dt);
        // And she does not bulldoze up the beach: remove any velocity heading into shallower
        // water. Without this a ship under sail keeps climbing the slope until it is metres
        // above any swell that could ever float it off again.
        const e = 2.0;
        const gx = (ctx.world.heightAt(this.pos.x + e, this.pos.z) - ctx.world.heightAt(this.pos.x - e, this.pos.z)) / (2 * e);
        const gz = (ctx.world.heightAt(this.pos.x, this.pos.z + e) - ctx.world.heightAt(this.pos.x, this.pos.z - e)) / (2 * e);
        const uphill = this.vel.x * gx + this.vel.z * gz;
        const gg = gx * gx + gz * gz;
        if (uphill > 0 && gg > 1e-9) {
          this.vel.x -= (gx * uphill) / gg;
          this.vel.z -= (gz * uphill) / gg;
        }
      }
    }

    // --- 8. wake and spray ----------------------------------------------------------------
    this._emitWake(dt, ctx);
    this._emitSpray(dt, ctx);
    return this;
  }

  /**
   * Lay wake points along the hull. `water.addWake` keeps 16 points that age out over 4.2 s,
   * so a 0.28 s cadence keeps a continuous trail without ever starving the ring.
   */
  _emitWake(dt, ctx) {
    const water = ctx.water;
    if (!water || typeof water.addWake !== 'function') return;
    this._wakeAcc += dt;
    if (this._wakeAcc < 0.28) return;
    this._wakeAcc -= 0.28;
    const sp = this.speed;
    if (sp < 0.45) return;
    const strength = clamp01(sp / 4.2) * (0.55 + this.sailTrim * 0.45);
    const fwd = this.forward(), stb = this.starboard();
    // Stern boil, then the two bow quarter waves that make the V.
    water.addWake(this.pos.x - fwd.x * 9.0, this.pos.z - fwd.z * 9.0, strength);
    if (sp > 1.6) {
      const q = 8.0;
      water.addWake(this.pos.x + fwd.x * q + stb.x * 2.2, this.pos.z + fwd.z * q + stb.z * 2.2, strength * 0.7);
      water.addWake(this.pos.x + fwd.x * q - stb.x * 2.2, this.pos.z + fwd.z * q - stb.z * 2.2, strength * 0.7);
    }
  }

  /** Bow spray when the forefoot buries itself. Needs speed AND a sea — one alone is not spray. */
  _emitSpray(dt, ctx) {
    this._sprayAcc += dt;
    if (this._sprayAcc < 0.1) return;
    this._sprayAcc -= 0.1;
    const bowDepth = this._depths[0];
    const power = clamp01((bowDepth - 0.9) * 1.4) * clamp01((this.forwardSpeed - 2.0) / 3.5);
    if (power <= 0.02) return;
    const fwd = this.forward();
    const wp = this.toWorld(0, -0.2, 8.6);
    emitSpray(ctx, wp.x, wp.y + 0.6, wp.z, fwd.x, fwd.z, power);
    if (ctx.audio && power > 0.55 && this.rng.chance(0.35)) {
      playAt(ctx.audio, 'wave_crash', wp.x, wp.y, wp.z, { volume: 0.35 + power * 0.4 });
    }
  }

  /** Everything the HUD needs, in one object. */
  readout() {
    return {
      speedKnots: this.speedKnots,
      pointOfSail: this.pointOfSail,
      heelAngle: this.heelAngle,
      apparentWind: this.apparentWind,
      sailTrim: this.sailTrim,
      helm: this.helm,
      anchorDown: this.anchorDown,
      luff: this.luff,
      broaching: this.broaching,
      beached: this.beached,
      windSpeed: this.windSpeed,
    };
  }

  serialize() {
    return {
      pos: [this.pos.x, this.pos.y, this.pos.z],
      vel: [this.vel.x, this.vel.y, this.vel.z],
      rot: [this.yaw, this.pitch, this.roll],
      rot2: [this.yawRate, this.pitchRate, this.rollRate],
      sail: this.sailTrim, sailTarget: this.sailTarget,
      helm: this.helm, anchor: this.anchorDown,
      anchorPos: [this.anchorPos.x, this.anchorPos.z],
    };
  }

  deserialize(o) {
    if (!o) return this;
    if (o.pos) { this.pos.x = o.pos[0]; this.pos.y = o.pos[1]; this.pos.z = o.pos[2]; }
    if (o.vel) { this.vel.x = o.vel[0]; this.vel.y = o.vel[1]; this.vel.z = o.vel[2]; }
    if (o.rot) { this.yaw = o.rot[0]; this.pitch = o.rot[1]; this.roll = o.rot[2]; }
    if (o.rot2) { this.yawRate = o.rot2[0]; this.pitchRate = o.rot2[1]; this.rollRate = o.rot2[2]; }
    if (o.sail !== undefined) this.sailTrim = o.sail;
    this.sailTarget = o.sailTarget !== undefined ? o.sailTarget : this.sailTrim;
    if (o.helm !== undefined) this.helm = o.helm;
    this.anchorDown = !!o.anchor;
    if (o.anchorPos) { this.anchorPos.x = o.anchorPos[0]; this.anchorPos.z = o.anchorPos[1]; }
    return this;
  }
}

/**
 * Apply the ship's movement bindings to the body. Kept out of the class so the same body can be
 * driven by a scripted voyage (dock.js fast travel) with no input at all.
 *
 * @param {SailingBody} body
 * @param {object} state the input snapshot from src/core/input.js
 * @param {number} dt
 */
export function applyHelmInput(body, state, dt) {
  if (!state) return;
  // A/D hold the wheel over; the wheel stays where you left it, like a real helm.
  const steer = state.moveX || 0;
  if (steer !== 0) body.helm = clamp(body.helm + steer * HELM_RATE * dt, -1, 1);
  // W/S also trim the sail when aboard, matching src/scenarios.js BINDINGS.
  const trim = -(state.moveZ || 0);
  if (trim !== 0) body.sailTarget = clamp01(body.sailTarget + trim * 0.55 * dt);
  if (state.pressed && state.pressed.sailUp) body.raiseSail();
  if (state.pressed && state.pressed.sailDown) body.lowerSail();
  if (state.pressed && state.pressed.anchor) body.toggleAnchor();
}

/**
 * FX bridge. Cluster C owns src/render/fx.js and its exact method names are not settled, so
 * this probes for the plausible ones and no-ops otherwise. Feature detection, not a stub: when
 * fx lands the spray goes live with no edit here.
 */
export function emitSpray(ctx, x, y, z, dirX, dirZ, power) {
  const fx = ctx && ctx.fx;
  if (!fx) return false;
  const opts = { count: Math.round(6 + power * 18), speed: 3.5 + power * 6, spread: 0.55, life: 0.8, kind: 'spray' };
  if (typeof fx.spray === 'function') { fx.spray(x, y, z, dirX, dirZ, power); return true; }
  if (typeof fx.burst === 'function') { fx.burst('spray', x, y, z, opts); return true; }
  if (typeof fx.particles === 'function') { fx.particles(x, y, z, opts); return true; }
  if (typeof fx.emit === 'function') { fx.emit('spray', x, y, z, opts); return true; }
  return false;
}

/** Audio bridge. `play`/`playAt` already ignore unknown names, so this only guards absence. */
export function playAt(audio, name, x, y, z, opts) {
  if (!audio) return null;
  if (typeof audio.playAt === 'function') return audio.playAt(name, x, y, z, opts || {});
  if (typeof audio.play === 'function') return audio.play(name, opts || {});
  return null;
}

/**
 * Sample the polar diagram: steady-state speed against apparent wind angle.
 * Used by tools/check-ship.mjs to prove the rig behaves, and it is cheap enough that the HUD
 * could draw it too.
 *
 * @param {object} water a Water instance
 * @param {object} weather a WEATHER preset
 * @param {{stepDeg?:number, seconds?:number, seed?:number}} [opts]
 * @returns {Array<{deg:number, knots:number, point:string}>}
 */
export function polarDiagram(water, weather, opts = {}) {
  const stepDeg = opts.stepDeg || 15;
  const seconds = opts.seconds || 90;
  // Repeats start the ship at decorrelated positions in the wave field. A single run measures
  // the rig PLUS whatever the swell happened to be doing under that particular heading, and
  // that bias is worth half a knot — enough to invert two neighbouring points of sail.
  const repeats = Math.max(1, opts.repeats || 3);
  const out = [];
  for (let deg = 0; deg <= 180; deg += stepDeg) {
    let total = 0;
    for (let rep = 0; rep < repeats; rep++) {
    const body = new SailingBody({ seed: opts.seed || 1 });
    body.pos.x = rep * 137.7; body.pos.z = rep * 211.3;
    body.sailTrim = 1; body.sailTarget = 1;
    // Place the bow so the apparent wind angle is exactly `deg`. Wind blows toward windAngle,
    // so it comes FROM windAngle + PI; a bow at that bearing minus `deg` puts it on the bow.
    const wa = water.windAngle;
    const fromAngle = wa + Math.PI;
    // Heading in yaw terms: forward = (sin yaw, cos yaw); the "from" vector is
    // (-cos wa, -sin wa) = (cos(wa+PI), sin(wa+PI)) in (x,z).
    const fromYaw = Math.atan2(Math.cos(fromAngle), Math.sin(fromAngle));
    body.yaw = fromYaw - (deg * Math.PI) / 180;
    const ctx = { water, weather };
    const n = Math.round(seconds * 60);
    const settle = Math.round(n * 0.6);
    let sum = 0, samples = 0;
    const t0 = water.time;
    for (let i = 0; i < n; i++) {
      // The sea has to keep moving: a frozen wave field is a static hill the ship either sits
      // on or slides down, and that bias would be measured as sail performance.
      water.step(1 / 60);
      // Hold the heading: a free ship rounds up, and a polar is a steady-state measurement.
      body.step(1 / 60, ctx);
      body.yaw = fromYaw - (deg * Math.PI) / 180;
      body.yawRate = 0;
      // Average the tail of the run: a swell makes the instantaneous speed oscillate by a knot
      // either way, and a single final sample would turn that noise into a fake polar.
      if (i >= settle) { sum += body.forwardSpeed; samples++; }
    }
    water.time = t0;   // leave the caller's water where we found it
    total += sum / Math.max(1, samples);
    }
    out.push({
      deg,
      knots: (total / repeats) * KNOTS,
      point: pointOfSailName((deg * Math.PI) / 180),
    });
  }
  return out;
}

export default SailingBody;
