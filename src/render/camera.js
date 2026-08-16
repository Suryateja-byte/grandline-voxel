// The game camera. Owner: Cluster B (character / rig / animation / camera).
//
// This file is half of how the game feels. The rig decides what the character does; the camera
// decides whether the player can read it, and how heavy it seems while doing it.
//
// Design rules, all of which are load-bearing:
//
//  1. Two independent springs. The look-at point chases the subject faster than the camera body
//     does. That single asymmetry is what makes a follow camera feel like an operator holding a
//     shot rather than a rigid boom welded to the character's back.
//  2. Everything is framerate-independent. Every approach goes through damp() from core/math —
//     an exponential approach parameterised by "fraction remaining after one second" — never
//     `lerp(a, b, k * dt)`, which silently changes its behaviour with the timestep.
//  3. The camera never snaps except when explicitly told to (spawn, teleport, shot setup).
//     `snap()` is the only way to teleport it, and it is loud in the call site.
//  4. The camera never ends up inside terrain. Occlusion is resolved by a stepped sphere-cast
//     from the pivot outward; the boom shortens fast and lengthens slowly, because a boom that
//     lengthens as fast as it shortens pumps every time you brush a wall.
//  5. Screen shake is decoupled from framing. Cluster C pushes trauma in; the camera decays it
//     and adds it as a *post* offset so it can never feed back into the springs.
//
// Modes:
//   follow     third-person orbit, the default
//   lockon     both the player and the target framed, FOV narrowed, boom lengthened by
//              separation so a big enemy does not shove the player off screen
//   sail       pulled back and raised, pitch biased down, for the ship
//   aim        tight over-the-shoulder, narrow FOV
//   cinematic  a scripted move driven by setCinematic(); used by shots and the tutorial

import * as THREE from 'three';
import {
  clamp, clamp01, lerp, damp, dampAngle, smootherstep, TAU,
} from '../core/math.js';
import { Rng } from '../core/rng.js';

/** Per-mode framing. Distances are metres; the player is ~4.25 m tall (ARCHITECTURE §3). */
export const CAMERA_MODES = Object.freeze({
  follow: Object.freeze({
    dist: 9.5, minDist: 3.2, height: 0.78, shoulder: 0.9, fov: 62,
    pitchMin: -0.50, pitchMax: 1.02, pitchRest: 0.20,
    posRate: 0.0009, lookRate: 0.00002, fovRate: 0.02, speedFov: 9.5,
  }),
  lockon: Object.freeze({
    dist: 10.5, minDist: 3.6, height: 0.86, shoulder: 1.5, fov: 58,
    pitchMin: -0.30, pitchMax: 0.70, pitchRest: 0.14,
    posRate: 0.0004, lookRate: 0.000006, fovRate: 0.02, speedFov: 3.0,
  }),
  sail: Object.freeze({
    dist: 20.0, minDist: 7.0, height: 1.35, shoulder: 0.0, fov: 66,
    pitchMin: -0.32, pitchMax: 0.85, pitchRest: 0.28,
    posRate: 0.0025, lookRate: 0.00008, fovRate: 0.05, speedFov: 8.0,
  }),
  aim: Object.freeze({
    dist: 5.0, minDist: 2.2, height: 0.92, shoulder: 1.9, fov: 50,
    pitchMin: -0.75, pitchMax: 0.95, pitchRest: 0.05,
    posRate: 0.00012, lookRate: 0.000004, fovRate: 0.006, speedFov: 2.0,
  }),
  cinematic: Object.freeze({
    dist: 12.0, minDist: 2.0, height: 0.85, shoulder: 0.0, fov: 46,
    pitchMin: -1.20, pitchMax: 1.20, pitchRest: 0.10,
    posRate: 0.02, lookRate: 0.004, fovRate: 0.05, speedFov: 0,
  }),
});

/** Minimum clearance the camera keeps above terrain, in metres. */
const GROUND_CLEAR = 0.65;
/** Radius of the boom sphere-cast. Matches the near-plane corner at 62 degrees, roughly. */
const BOOM_RADIUS = 0.45;
/** How far apart the occlusion samples are along the boom. */
const CAST_STEP = 0.40;

/** Read a position out of anything that has one: Vector3, {x,y,z}, or [x,y,z]. */
function readPos(t, out) {
  if (!t) return out.set(0, 0, 0);
  const p = t.pos !== undefined ? t.pos : t;
  if (Array.isArray(p)) return out.set(p[0] || 0, p[1] || 0, p[2] || 0);
  return out.set(p.x || 0, p.y || 0, p.z || 0);
}

/**
 * One decaying shake impulse. Deterministic: the phases come from a seeded Rng at the moment
 * the shake is requested, so a replay with the same inputs shakes identically.
 */
class ShakeImpulse {
  constructor(amount, seconds, rng, freq) {
    this.amp = amount;
    this.dur = Math.max(0.02, seconds);
    this.t = 0;
    this.freq = freq || 17;
    this.px = rng.f() * TAU;
    this.py = rng.f() * TAU;
    this.pz = rng.f() * TAU;
    // Slightly different rates per axis so the motion never reads as a single sine.
    this.rx = 1.00 + rng.f() * 0.35;
    this.ry = 0.78 + rng.f() * 0.35;
    this.rz = 0.55 + rng.f() * 0.30;
  }

  /** @returns {boolean} still alive */
  step(dt) {
    this.t += dt;
    return this.t < this.dur;
  }

  /** Current offset, written into `out`. Amplitude falls off quadratically — a linear decay
   *  reads as the shake being switched off. */
  sample(out) {
    const k = clamp01(1 - this.t / this.dur);
    const a = this.amp * k * k;
    const w = this.t * this.freq;
    out.set(
      Math.sin(w * this.rx + this.px) * a,
      Math.sin(w * this.ry + this.py) * a * 0.85,
      Math.sin(w * this.rz + this.pz) * a * 0.55,
    );
    return out;
  }
}

export class GameCamera {
  /**
   * @param {object} app
   * @param {object} [opts] { seed, fov, sensitivity, invertY }
   */
  constructor(app, opts = {}) {
    this.app = app;
    this.mode = 'follow';
    this.cfg = CAMERA_MODES.follow;
    this.target = null;
    this.lockTarget = null;

    this.yaw = 0;
    this.pitch = CAMERA_MODES.follow.pitchRest;
    this.dist = CAMERA_MODES.follow.dist;
    this.boom = CAMERA_MODES.follow.dist;      // collision-shortened boom length
    this.fov = opts.fov || CAMERA_MODES.follow.fov;

    this.pos = new THREE.Vector3(0, 6, 12);
    this.look = new THREE.Vector3(0, 2, 0);
    this.prevPos = this.pos.clone();
    this.prevLook = this.look.clone();
    this.prevFov = this.fov;
    this.shakeOffset = new THREE.Vector3();
    this.prevShake = new THREE.Vector3();

    this.sensitivity = opts.sensitivity !== undefined ? opts.sensitivity : 1;
    this.invertY = !!opts.invertY;
    /** Player-facing zoom multiplier, driven by the wheel. */
    this.zoom = 1;

    this._shakes = [];
    this._rng = Rng.fromName((opts.seed >>> 0) || 1, 'camera');
    this._cin = null;

    // Scratch vectors. update() runs every step for every camera; it must not allocate.
    this._tp = new THREE.Vector3();
    this._lp = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._pivot = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._shakeTmp = new THREE.Vector3();

    this._targetSpeed = 0;
    this._lastTargetYaw = 0;
    this._firstUpdate = true;
  }

  /**
   * Choose what the camera follows. Anything with a `pos` (Vector3, {x,y,z} or [x,y,z]) and
   * optionally `yaw`, `height` and `vel` works — the ship and the player both qualify.
   * @param {object} target
   */
  follow(target) {
    if (this.target === target) return this;
    this.target = target;
    if (this._firstUpdate) this.snap();
    return this;
  }

  /**
   * @param {'follow'|'sail'|'lockon'|'aim'|'cinematic'} mode
   * @param {object} [opts] { target } for lockon
   */
  setMode(mode, opts = {}) {
    if (!CAMERA_MODES[mode]) return this;
    this.mode = mode;
    this.cfg = CAMERA_MODES[mode];
    if (mode === 'lockon' && opts.target) this.lockTarget = opts.target;
    if (mode !== 'lockon') this.lockTarget = null;
    if (mode !== 'cinematic') this._cin = null;
    // Deliberately no snapping here: the mode change reads as a camera move, which is exactly
    // what the player should see when they lock on or board the ship.
    return this;
  }

  /** Current lock-on target, or null. */
  getLockTarget() { return this.lockTarget; }

  /** Set the lock-on subject without changing modes (used while cycling targets). */
  setLockTarget(t) {
    this.lockTarget = t || null;
    if (t) this.setMode('lockon', { target: t });
    else if (this.mode === 'lockon') this.setMode('follow');
    return this;
  }

  /**
   * Add screen shake. Cluster C calls this from fx.impact().
   * @param {number} amount metres of peak displacement (0.05 taps, 0.6 is a boss slam)
   * @param {number} seconds
   * @param {number} [freq] oscillations per second; higher reads sharper
   */
  shake(amount, seconds, freq) {
    if (!(amount > 0)) return this;
    // Cap concurrent impulses: past four, more shake is indistinguishable from noise and it
    // stops being a signal about what just hit you.
    if (this._shakes.length >= 4) this._shakes.shift();
    this._shakes.push(new ShakeImpulse(amount, seconds || 0.25, this._rng, freq));
    return this;
  }

  /** Cancel all shake immediately (menus, cutscene starts). */
  clearShake() {
    this._shakes.length = 0;
    this.shakeOffset.set(0, 0, 0);
    return this;
  }

  /**
   * Run a scripted camera move. Used by capture shots and the tutorial.
   * @param {object} shot { from:[x,y,z], to:[x,y,z], lookFrom:[x,y,z], lookTo:[x,y,z],
   *                        seconds:number, fov:number, hold:boolean }
   */
  setCinematic(shot) {
    this._cin = {
      from: new THREE.Vector3().fromArray(shot.from),
      to: new THREE.Vector3().fromArray(shot.to || shot.from),
      lookFrom: new THREE.Vector3().fromArray(shot.lookFrom || [0, 0, 0]),
      lookTo: new THREE.Vector3().fromArray(shot.lookTo || shot.lookFrom || [0, 0, 0]),
      seconds: shot.seconds !== undefined ? shot.seconds : 4,
      fov: shot.fov || 46,
      hold: !!shot.hold,
      t: 0,
    };
    this.setMode('cinematic');
    return this;
  }

  /** True once a cinematic has run past its duration. */
  get cinematicDone() { return !this._cin || this._cin.t >= this._cin.seconds; }

  /**
   * Teleport the camera to its ideal framing for the current target. The ONLY way the camera
   * moves without a spring — call it on spawn, on load, and when a shot seeks the world.
   */
  snap() {
    if (!this.target) return this;
    this._computePivot(this._pivot);
    this._computeDesired(this._pivot, this.cfg.dist, this._desired);
    this.pos.copy(this._desired);
    this.look.copy(this._pivot);
    this.boom = this.cfg.dist;
    this.dist = this.cfg.dist;
    this.fov = this.cfg.fov;
    this.prevPos.copy(this.pos);
    this.prevLook.copy(this.look);
    this.prevFov = this.fov;
    this._firstUpdate = false;
    return this;
  }

  /** Flat (XZ) forward vector of the camera. Player movement is expressed against this. */
  getForwardFlat(out) {
    const o = out || this._fwd;
    return o.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  /**
   * Flat (XZ) right vector of the camera — the direction `D` strafes toward.
   * With yaw = atan2(dx, dz) and forward (sin y, 0, cos y) in this right-handed Y-up world,
   * right is forward x up = (-cos y, 0, sin y). The sign matters: (cos y, 0, -sin y) is LEFT,
   * and shipping that exact expression here is what inverted A/D for every player.
   */
  getRightFlat(out) {
    const o = out || this._right;
    return o.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
  }

  // -- internals -------------------------------------------------------------

  /** The point the camera orbits: the subject's upper chest, plus lock-on framing bias. */
  _computePivot(out) {
    readPos(this.target, out);
    const h = (this.target && this.target.height) || 4.25;
    out.y += h * this.cfg.height;
    if (this.lockTarget) {
      readPos(this.lockTarget, this._tmp);
      const th = (this.lockTarget.height || h);
      this._tmp.y += th * 0.55;
      // Bias toward the player: dead-centre framing between two actors loses the player when
      // the enemy is huge. 0.32 keeps both on screen with the player still the subject.
      out.lerp(this._tmp, 0.32);
    }
    return out;
  }

  /** Ideal (uncollided) camera position for a given boom length. */
  _computeDesired(pivot, dist, out) {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    out.set(
      pivot.x - sy * dist * cp + cy * this.cfg.shoulder,
      pivot.y + dist * sp,
      pivot.z - cy * dist * cp - sy * this.cfg.shoulder,
    );
    return out;
  }

  /**
   * Stepped sphere-cast from the pivot toward the ideal camera position.
   * Returns the largest boom length that keeps BOOM_RADIUS of air around the camera.
   */
  _castBoom(pivot, wanted, app) {
    const world = app && app.world;
    if (!world) return wanted;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const dx = -sy * cp, dy = sp, dz = -cy * cp;
    const steps = Math.max(2, Math.ceil(wanted / CAST_STEP));
    const hasBlock = typeof world.blockAt === 'function';
    const hasHeight = typeof world.heightAt === 'function';
    if (!hasBlock && !hasHeight) return wanted;
    for (let i = 1; i <= steps; i++) {
      const d = (wanted * i) / steps;
      const x = pivot.x + dx * d, y = pivot.y + dy * d, z = pivot.z + dz * d;
      let blocked = false;
      if (hasBlock) {
        // Sample the sphere as its centre plus four cardinal offsets — cheap, and it stops the
        // camera slipping a corner between two samples.
        blocked = !!world.blockAt(x, y, z)
          || !!world.blockAt(x + BOOM_RADIUS, y, z) || !!world.blockAt(x - BOOM_RADIUS, y, z)
          || !!world.blockAt(x, y, z + BOOM_RADIUS) || !!world.blockAt(x, y, z - BOOM_RADIUS)
          || !!world.blockAt(x, y + BOOM_RADIUS, z);
      }
      if (!blocked && hasHeight) blocked = y - BOOM_RADIUS < world.heightAt(x, z);
      if (blocked) return Math.max(this.cfg.minDist, d - CAST_STEP);
    }
    return wanted;
  }

  /**
   * One fixed simulation step of camera motion.
   * @param {number} dt fixed timestep
   * @param {object} input the per-step input snapshot (app.input.state), or null
   * @param {object} app
   */
  update(dt, input, app) {
    this.prevPos.copy(this.pos);
    this.prevLook.copy(this.look);
    this.prevFov = this.fov;
    this.prevShake.copy(this.shakeOffset);

    this._stepShake(dt);

    if (this.mode === 'cinematic' && this._cin) {
      this._updateCinematic(dt);
      return this;
    }
    if (!this.target) return this;

    const cfg = this.cfg;

    // --- look input -------------------------------------------------------
    if (input) {
      const lx = (input.lookX || 0) * this.sensitivity;
      const ly = (input.lookY || 0) * this.sensitivity * (this.invertY ? -1 : 1);
      this.yaw -= lx;
      this.pitch = clamp(this.pitch + ly, cfg.pitchMin, cfg.pitchMax);
      if (this.yaw > Math.PI) this.yaw -= TAU;
      if (this.yaw < -Math.PI) this.yaw += TAU;
    }

    // --- lock-on: the camera owns yaw, the player only nudges it ----------
    if (this.lockTarget) {
      readPos(this.target, this._tp);
      readPos(this.lockTarget, this._lp);
      const wantYaw = Math.atan2(this._lp.x - this._tp.x, this._lp.z - this._tp.z);
      this.yaw = dampAngle(this.yaw, wantYaw, 0.00015, dt);
      const flat = Math.hypot(this._lp.x - this._tp.x, this._lp.z - this._tp.z);
      // The further apart they are, the further back the camera must sit to hold both.
      this.dist = damp(this.dist, clamp(cfg.dist + flat * 0.30, cfg.dist, cfg.dist * 1.9), 0.02, dt);
      const rise = clamp((this._lp.y - this._tp.y) * 0.06, -0.25, 0.35);
      this.pitch = clamp(damp(this.pitch, cfg.pitchRest + rise, 0.10, dt), cfg.pitchMin, cfg.pitchMax);
    } else {
      this.dist = damp(this.dist, cfg.dist * this.zoom, 0.02, dt);
      // Auto-yaw: while sprinting or sailing, the camera drifts behind the subject. Slow enough
      // that it never fights the player's own look input.
      const tgtYaw = this.target.yaw;
      if (tgtYaw !== undefined && (this.mode === 'sail' || this._targetSpeed > 6.5)) {
        const rate = this.mode === 'sail' ? 0.55 : 0.86;
        this.yaw = dampAngle(this.yaw, tgtYaw, rate, dt);
      }
    }

    // --- track subject speed for the FOV and the boom ----------------------
    readPos(this.target, this._tp);
    const vel = this.target.vel;
    const spd = vel ? Math.hypot(vel.x || 0, vel.z || 0) : 0;
    this._targetSpeed = damp(this._targetSpeed, spd, 0.02, dt);

    // --- framing ----------------------------------------------------------
    this._computePivot(this._pivot);
    const wantBoom = this.dist;
    const clearBoom = this._castBoom(this._pivot, wantBoom, app);
    // Asymmetric: shorten immediately (or the camera ends up inside a cliff for a few frames),
    // lengthen slowly (or every doorway pumps the shot).
    this.boom = clearBoom < this.boom
      ? clearBoom
      : damp(this.boom, clearBoom, 0.06, dt);
    this._computeDesired(this._pivot, this.boom, this._desired);

    // Never below the ground. This is the last line of defence after the boom cast, and it is
    // what makes "the camera never clips through terrain" true rather than usually true.
    const world = app && app.world;
    if (world && typeof world.heightAt === 'function') {
      const gh = world.heightAt(this._desired.x, this._desired.z) + GROUND_CLEAR;
      if (this._desired.y < gh) this._desired.y = gh;
    }

    // --- the two springs --------------------------------------------------
    this.pos.x = damp(this.pos.x, this._desired.x, cfg.posRate, dt);
    this.pos.y = damp(this.pos.y, this._desired.y, cfg.posRate, dt);
    this.pos.z = damp(this.pos.z, this._desired.z, cfg.posRate, dt);
    this.look.x = damp(this.look.x, this._pivot.x, cfg.lookRate, dt);
    this.look.y = damp(this.look.y, this._pivot.y, cfg.lookRate, dt);
    this.look.z = damp(this.look.z, this._pivot.z, cfg.lookRate, dt);

    // Post-spring ground clamp: the spring can lag the desired position into a hill on the way.
    if (world && typeof world.heightAt === 'function') {
      const gh = world.heightAt(this.pos.x, this.pos.z) + GROUND_CLEAR;
      if (this.pos.y < gh) this.pos.y = gh;
    }

    // --- dynamic FOV ------------------------------------------------------
    // Widening with speed is the cheapest speed cue there is, and it costs no pixels.
    const speedN = clamp01(this._targetSpeed / 12);
    let wantFov = cfg.fov + speedN * cfg.speedFov;
    if (this.lockTarget) wantFov -= 3.5;
    this.fov = damp(this.fov, wantFov, cfg.fovRate, dt);

    this._firstUpdate = false;
    return this;
  }

  /** Systems interface: registered on the App, stepped in ARCHITECTURE §4 order. */
  step(dt, app) {
    return this.update(dt, app && app.input ? app.input.state : null, app);
  }

  /** Systems interface: push the interpolated transform into the render camera. */
  preRender(alpha, app) {
    if (app && app.camera) this.applyTo(app.camera, alpha);
  }

  _stepShake(dt) {
    this.shakeOffset.set(0, 0, 0);
    for (let i = this._shakes.length - 1; i >= 0; i--) {
      const s = this._shakes[i];
      if (!s.step(dt)) { this._shakes.splice(i, 1); continue; }
      s.sample(this._shakeTmp);
      this.shakeOffset.add(this._shakeTmp);
    }
  }

  _updateCinematic(dt) {
    const c = this._cin;
    c.t += dt;
    const k = c.seconds > 0 ? clamp01(c.t / c.seconds) : 1;
    // smootherstep, not smoothstep: a cinematic that starts with visible acceleration reads as
    // a jump cut on the first frame.
    const e = smootherstep(0, 1, k);
    this.pos.lerpVectors(c.from, c.to, e);
    this.look.lerpVectors(c.lookFrom, c.lookTo, e);
    this.fov = damp(this.fov, c.fov, 0.02, dt);
    // Keep yaw consistent so getForwardFlat() stays meaningful during a cinematic.
    this.yaw = Math.atan2(this.look.x - this.pos.x, this.look.z - this.pos.z);
  }

  /**
   * Push this frame's camera into a THREE.PerspectiveCamera, interpolating between the last two
   * simulation steps. Render-only: it must not mutate simulation state.
   * @param {THREE.PerspectiveCamera} cam
   * @param {number} alpha 0..1 interpolation factor from Clock
   */
  applyTo(cam, alpha) {
    const a = clamp01(alpha);
    const px = lerp(this.prevPos.x, this.pos.x, a);
    const py = lerp(this.prevPos.y, this.pos.y, a);
    const pz = lerp(this.prevPos.z, this.pos.z, a);
    const sx = lerp(this.prevShake.x, this.shakeOffset.x, a);
    const sy = lerp(this.prevShake.y, this.shakeOffset.y, a);
    const sz = lerp(this.prevShake.z, this.shakeOffset.z, a);
    cam.position.set(px + sx, py + sy, pz + sz);
    this._tmp.set(
      lerp(this.prevLook.x, this.look.x, a) + sx * 0.35,
      lerp(this.prevLook.y, this.look.y, a) + sy * 0.35,
      lerp(this.prevLook.z, this.look.z, a) + sz * 0.35,
    );
    cam.up.set(0, 1, 0);
    cam.lookAt(this._tmp);
    const f = lerp(this.prevFov, this.fov, a);
    if (Math.abs(cam.fov - f) > 1e-4) {
      cam.fov = f;
      cam.updateProjectionMatrix();
    }
    return cam;
  }

  /** Wheel zoom, clamped. Called by the player with input.mouse.wheel. */
  addZoom(steps) {
    if (!steps) return this;
    this.zoom = clamp(this.zoom + steps * 0.12, 0.55, 1.85);
    return this;
  }

  serialize() {
    return {
      mode: this.mode, yaw: this.yaw, pitch: this.pitch, zoom: this.zoom,
      sensitivity: this.sensitivity, invertY: this.invertY,
    };
  }

  deserialize(o) {
    if (!o) return this;
    if (o.mode && CAMERA_MODES[o.mode]) this.setMode(o.mode);
    if (typeof o.yaw === 'number') this.yaw = o.yaw;
    if (typeof o.pitch === 'number') this.pitch = o.pitch;
    if (typeof o.zoom === 'number') this.zoom = o.zoom;
    if (typeof o.sensitivity === 'number') this.sensitivity = o.sensitivity;
    if (typeof o.invertY === 'boolean') this.invertY = o.invertY;
    return this;
  }

  dispose() {
    this._shakes.length = 0;
    this.target = null;
    this.lockTarget = null;
  }
}

/**
 * Factory. The orchestrator registers the result with `app.addSystem('gameCamera', cam)`.
 * @param {object} app
 * @param {object} [opts]
 * @returns {GameCamera}
 */
export function createGameCamera(app, opts = {}) {
  return new GameCamera(app, Object.assign({ seed: app ? app.seed : 1 }, opts));
}

export default GameCamera;
