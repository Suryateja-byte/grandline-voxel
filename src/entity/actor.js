// Actor: the base for the player, enemies, NPCs and crew.
// Owner: Cluster B (character / rig / animation / camera).
//
// An Actor owns three things and nothing else:
//   * a simulated transform (pos / vel / yaw) integrated at the fixed 1/60 timestep
//   * a Rig, which is a pure view of that transform plus a pose
//   * an Animator, whose state is chosen from the actor's own logical state
//
// It deliberately does NOT own damage. Combat calls `combat.applyHit(target, hit)` and the
// actor exposes the hooks that needs (`takeHit`, `hp`, `bounds`) — ARCHITECTURE §5.
//
// Movement feel, in one paragraph, because it is the whole point of the file:
// acceleration and deceleration are separate curves, ground friction is much stronger than
// air drag, air control is 35% of ground control so a jump commits you, and there is a
// coyote-time window after walking off a ledge plus a jump buffer before landing. Those four
// numbers are the difference between a character that has weight and a capsule that slides.

import * as THREE from 'three';
import {
  clamp, clamp01, lerp, dampAngle, angleDelta, smoothstep,
} from '../core/math.js';
import { Rng, mix32, hashString } from '../core/rng.js';
import { CHARACTER_SPECS, buildCharacter, registerCharacterTiles } from '../gen/charmodel.js';
import { Rig } from './rig.js';
import {
  Animator, createStates, makePose, copyPose, blendPose, ATTACK_TIMINGS, REF_HEIGHT,
} from './anim.js';

/**
 * How fast the rendered hit flash fades, in units of flash strength per second. Matched to the
 * rate `damage.js stepStatus()` fades `hitFlash` at, so the look is identical whether or not
 * COMBAT happens to be stepping this actor's status.
 */
const FLASH_FADE = 7;

/** Logical actor states. The animator state is derived from these plus movement. */
export const ACTOR_STATE = Object.freeze({
  IDLE: 'idle', MOVE: 'move', JUMP: 'jump', FALL: 'fall', LAND: 'land',
  SWIM: 'swim', CLIMB: 'climb',
  ATTACK: 'attack', BLOCK: 'block', PARRY: 'parry', DODGE: 'dodge',
  HIT: 'hit', STAGGER: 'stagger', DOWN: 'down', GETUP: 'getup', DEAD: 'dead',
  CAST: 'cast', CHANNEL: 'channel',
  TALK: 'talk', SIT: 'sit', SHIP: 'ship', CHEER: 'cheer', POINT: 'point',
});

/**
 * Movement constants, authored for a REF_HEIGHT (4.25 m) character and scaled per actor by
 * `height / REF_HEIGHT`. Voxel characters are ~2.4x human scale (ARCHITECTURE §3), so these
 * numbers look large next to a realistic game and feel correct in this one.
 */
export const MOVE = Object.freeze({
  walk: 4.2, run: 8.4, sprint: 12.6,
  accelGround: 52, decelGround: 64,
  /** Air control at 35% of ground control — the brief's number, and it is the right one. */
  airControlFrac: 0.35,
  airDrag: 1.6,
  gravity: -30, jumpV: 13.0, maxFall: -48,
  coyote: 0.12, jumpBuffer: 0.14,
  turnRate: 0.00004,           // damp() rate: fraction of angular error left after one second
  turnRateSlow: 0.004,
  stepUp: 0.65,
  swim: 4.0, swimUp: 3.0, swimDown: 2.4, buoyancy: 22, waterDrag: 3.4,
  /** Fraction of body height that must be underwater before the actor is "submerged". */
  submergeFrac: 0.55,
  /** Vertical speed below which a landing is soft. */
  hardLandVy: -19,
});

/** Ids whose textures every scene needs registered before the atlas is baked. */
export const CORE_ACTOR_IDS = Object.freeze([
  'hero_captain', 'crew_swordsman', 'crew_navigator', 'crew_cook', 'crew_sniper',
  'crew_shipwright', 'crew_doctor', 'crew_musician',
  'marine_recruit', 'marine_officer', 'marine_captain',
  'pirate_thug', 'pirate_brute', 'pirate_knifer', 'fishman_raider', 'bandit_boss',
  'villager_a', 'villager_b', 'merchant', 'elder',
]);

/**
 * Register every character archetype's texture tiles.
 *
 * This MUST run inside App's `opts.registerTiles` hook, because App bakes the texture array
 * (`tex.build()`) before it calls `onSystems`, and a layer added after the bake never reaches
 * the GPU. See the ARCHITECTURE §9 request from Cluster B.
 *
 * @param {import('../gen/texture.js').TextureLibrary} tex
 * @param {string[]} [ids] archetype ids; defaults to every id in CORE_ACTOR_IDS
 * @returns {number} number of archetypes registered
 */
export function registerActorTiles(tex, ids) {
  const list = ids || CORE_ACTOR_IDS;
  for (const id of list) {
    const spec = CHARACTER_SPECS[id];
    if (spec) registerCharacterTiles(tex, spec);
  }
  return list.length;
}

/**
 * Build (and memoise) one archetype's meshes. Character geometry is identical for every
 * instance of an archetype, so it is built once per app and shared by every rig — that is what
 * keeps spawning a crowd cheap.
 * @param {object} app
 * @param {string|object} specOrId
 * @returns {object} buildCharacter() output
 */
export function getBuiltCharacter(app, specOrId) {
  const spec = typeof specOrId === 'string' ? CHARACTER_SPECS[specOrId] : specOrId;
  if (!spec) throw new Error('unknown character spec: ' + specOrId);
  if (!app.__charCache) app.__charCache = new Map();
  const hit = app.__charCache.get(spec.id);
  if (hit) return hit;
  const built = buildCharacter(app.tex, app.blocks, spec, app.seed);
  app.__charCache.set(spec.id, built);
  return built;
}

const _v3 = new THREE.Vector3();

export class Actor {
  /**
   * Flat coordinate view. Enemies, the spatial hash, hitboxes and the camera all speak flat
   * .x/.y/.z while Actors store position in a THREE.Vector3 — reading player.x as undefined
   * has now caused two invisible NaN bugs (drowning damage, enemy perception). These accessors
   * make both vocabularies true at once, for every consumer, including writes.
   */
  get x() { return this.pos.x; }
  set x(v) { this.pos.x = v; }
  get y() { return this.pos.y; }
  set y(v) { this.pos.y = v; }
  get z() { return this.pos.z; }
  set z(v) { this.pos.z = v; }

  /**
   * @param {object} app
   * @param {object|string} spec entry from CHARACTER_SPECS, or its id
   * @param {object} [opts] { pos, yaw, faction, hp, maxHp, id, built, rig, rigOpts, seed, noRig }
   */
  constructor(app, spec, opts = {}) {
    this.app = app;
    this.spec = typeof spec === 'string' ? CHARACTER_SPECS[spec] : spec;
    if (!this.spec) throw new Error('Actor: unknown spec ' + spec);
    this.id = opts.id || this.spec.id;
    this.faction = opts.faction || this.spec.faction || 'neutral';

    this.built = opts.built || (app && app.tex ? getBuiltCharacter(app, this.spec) : null);
    this.height = this.built ? this.built.height : REF_HEIGHT;
    /** Scales every authored movement constant to this archetype's build. */
    this.hs = this.height / REF_HEIGHT;

    this.seed = (opts.seed >>> 0) || (app && app.seed ? app.seed : 1);
    this.rng = Rng.fromName(this.seed, 'actor:' + this.id);

    this.pos = new THREE.Vector3();
    if (opts.pos) this.pos.set(opts.pos[0] ?? opts.pos.x ?? 0, opts.pos[1] ?? opts.pos.y ?? 0, opts.pos[2] ?? opts.pos.z ?? 0);
    this.vel = new THREE.Vector3();
    this.prevPos = this.pos.clone();
    /** Kilograms; combat's knockback impulse scales by 70/mass (core/physics.js). */
    this.mass = opts.mass || 80;
    this.yaw = opts.yaw || 0;
    this.prevYaw = this.yaw;
    this.targetYaw = this.yaw;

    this.maxHp = opts.maxHp || opts.hp || 100;
    this.hp = opts.hp !== undefined ? opts.hp : this.maxHp;
    this.alive = this.hp > 0;

    this.state = ACTOR_STATE.IDLE;
    this.stateT = 0;
    this.grounded = true;
    this.groundY = this.pos.y;
    this.airT = 0;
    this.inWater = false;
    this.submerged = false;
    this.waterY = -1e9;
    this.gaitPhase = 0;
    this.turnRate = 0;
    /** True while the actor keeps facing independently of its movement (lock-on, guarding). */
    this.strafing = false;
    /** Damage immunity window; combat reads it before applying a hit. */
    this.invulnT = 0;
    /** Control lockout; movement input is ignored while > 0 (hitstun, attack commitment). */
    this.lockT = 0;
    /** Rendered hit-flash envelope, and the last `hitFlash` seen — see _syncEffects(). */
    this._flashV = 0;
    this._flashSeen = 0;
    this.blocking = false;
    this.footSfx = 'step_grass';
    /** True when the actor should hold a guard stance while standing still. */
    this.combatReady = false;
    /** True when the actor is at the ship's wheel (drives ship_steer vs ship_idle). */
    this.steering = false;
    /** Deck motion pushed in by the ship system; undefined ashore. */
    this.deckRoll = undefined;
    this.deckPitch = undefined;
    /** Animation state forced by setState({anim}); cleared when the lockout ends. */
    this._forcedAnim = null;

    /** What the actor wants to do this step. Subclasses write these in _control(). */
    this.wishX = 0; this.wishZ = 0; this.wishSpeed = 0; this.wishJump = false; this.wishUp = 0;
    /** moveTo() destination, or null. */
    this.navTarget = null;

    /** Attack bookkeeping — combat reads `attack` to know what hitbox to open. */
    this.attack = null;

    this.animator = new Animator({
      // Decorrelate the animation stream from the actor's own stream: without the mix,
      // two systems seeded from the same actor id march in lockstep.
      seed: mix32(this.seed ^ hashString('anim:' + this.id)),
      height: this.height,
      bind: this.spec.pose,
      states: createStates(),
    });
    this._animName = null;
    this._posePrev = makePose();
    this._poseCur = makePose();
    this._poseRender = makePose();

    this.rig = null;
    if (!opts.noRig && this.built) {
      // `rigOpts` lets a caller opt a crowd out of per-actor materials (`{ ownMaterial: false }`)
      // when it knows those actors will never flash, glow or dissolve.
      this.rig = opts.rig || new Rig(app, this.built, Object.assign({ name: this.id }, opts.rigOpts));
      if (app && app.rootActors) this.rig.addTo(app.rootActors);
      this.rig.setTransform(this.pos.x, this.pos.y, this.pos.z, this.yaw);
    }

    this._bindAnimEvents();
    this.setState(ACTOR_STATE.IDLE, { force: true });
  }

  // --- flat body-shape accessors ------------------------------------------
  // COMBAT and PHYSICS treat every combatant as the flat {x, y, z, vx, vy, vz, mass} body
  // shape enemies use (perception `p.x`, hitbox anchoring `owner.x`, knockback `b.vx`, crowd
  // separation). Actors store a Vector3 pos/vel; these accessors are the bridge, so the player
  // can be perceived, hit and knocked back without either owner rewriting its storage.
  get x() { return this.pos.x; }
  set x(v) { this.pos.x = v; }
  get y() { return this.pos.y; }
  set y(v) { this.pos.y = v; }
  get z() { return this.pos.z; }
  set z(v) { this.pos.z = v; }
  get vx() { return this.vel.x; }
  set vx(v) { this.vel.x = v; }
  get vy() { return this.vel.y; }
  set vy(v) { this.vel.y = v; }
  get vz() { return this.vel.z; }
  set vz(v) { this.vel.z = v; }

  /** Capsule bounds for physics and hit tests. @returns {{radius:number,height:number,centerY:number}} */
  bounds() {
    if (this.rig) return this.rig.bounds();
    if (!this._fallbackBounds) {
      this._fallbackBounds = { radius: this.height * 0.12, height: this.height, centerY: this.height * 0.5 };
    }
    return this._fallbackBounds;
  }

  /** World-space attachment point. Falls back to the actor origin when there is no rig. */
  pointOf(name, out) {
    if (this.rig) return this.rig.worldPointOf(name, out);
    const o = out || _v3;
    o.copy(this.pos);
    if (name === 'head') o.y += this.height * 0.86;
    else if (name === 'chest') o.y += this.height * 0.62;
    else if (name === 'handL' || name === 'handR') o.y += this.height * 0.55;
    return o;
  }

  // -- public control API ----------------------------------------------------

  /**
   * Walk toward a world position. The actor steers itself and stops inside `arrive`.
   * @param {number} x @param {number} z @param {number} [speed] m/s; defaults to walk
   * @param {number} [arrive] stop radius in metres
   */
  moveTo(x, z, speed, arrive) {
    this.navTarget = {
      x, z,
      speed: speed !== undefined ? speed : MOVE.walk * this.hs,
      arrive: arrive !== undefined ? arrive : this.bounds().radius * 1.6,
    };
    return this;
  }

  /** Stop any moveTo() navigation. */
  stopMoving() { this.navTarget = null; return this; }

  /** Turn to face a yaw. The body damps toward it; the head leads via the animator context. */
  faceTo(yaw) { this.targetYaw = yaw; return this; }

  /** Face a world point. */
  facePoint(x, z) { return this.faceTo(Math.atan2(x - this.pos.x, z - this.pos.z)); }

  /** Add velocity directly. Knockback, explosions and fruit powers all arrive through here. */
  applyImpulse(v) {
    this.vel.x += v.x || 0;
    this.vel.y += v.y || 0;
    this.vel.z += v.z || 0;
    if ((v.y || 0) > 0.01) { this.grounded = false; this.airT = 0; }
    return this;
  }

  /**
   * Enter a logical state.
   * @param {string} name one of ACTOR_STATE
   * @param {object} [opts] { force, lock: seconds of control lockout, anim: explicit anim state }
   */
  setState(name, opts = {}) {
    if (this.state === name && !opts.force) return this;
    this.state = name;
    this.stateT = 0;
    if (opts.lock !== undefined) this.lockT = opts.lock;
    this._forcedAnim = opts.anim || null;
    return this;
  }

  /** Start an attack. Combat reads `actor.attack` for the timings; this only drives animation. */
  startAttack(kind) {
    const t = ATTACK_TIMINGS[kind];
    if (!t) return false;
    this.attack = { kind, t: 0, timing: t, hasHit: false };
    this.setState(ACTOR_STATE.ATTACK, { force: true, lock: t.duration, anim: kind });
    return true;
  }

  /** Cancel the current attack (dodge cancel, hit interrupt). */
  cancelAttack() { this.attack = null; return this; }

  /**
   * Damage entry point used by Cluster C's `combat.applyHit`. Actors never reduce their own hp.
   * @param {object} hit { damage, dir:{x,z}, impulse, heavy, unblockable }
   * @returns {'blocked'|'parried'|'hit'|'killed'|'immune'}
   */
  takeHit(hit) {
    if (!this.alive) return 'immune';
    if (this.invulnT > 0) return 'immune';
    if (this.blocking && !hit.unblockable) {
      this.setState(ACTOR_STATE.BLOCK, { force: true, lock: 0.28, anim: 'block_impact' });
      if (hit.dir) this.applyImpulse({ x: -hit.dir.x * 1.2, y: 0, z: -hit.dir.z * 1.2 });
      return 'blocked';
    }
    this.hp = Math.max(0, this.hp - (hit.damage || 0));
    this.cancelAttack();
    if (hit.impulse && hit.dir) {
      this.applyImpulse({
        x: hit.dir.x * hit.impulse,
        y: hit.heavy ? hit.impulse * 0.42 : 0,
        z: hit.dir.z * hit.impulse,
      });
    }
    if (this.hp <= 0) { this.die(); return 'killed'; }
    if (hit.knockdown) this.setState(ACTOR_STATE.DOWN, { force: true, lock: 0.85, anim: 'knockdown' });
    else if (hit.heavy) this.setState(ACTOR_STATE.HIT, { force: true, lock: 0.36, anim: 'hit_heavy' });
    else this.setState(ACTOR_STATE.HIT, { force: true, lock: 0.18, anim: 'hit_light' });
    return 'hit';
  }

  /** Kill this actor. Plays the death animation and stops all control. */
  die() {
    if (!this.alive) return this;
    this.alive = false;
    this.hp = 0;
    this.attack = null;
    this.blocking = false;
    this.setState(ACTOR_STATE.DEAD, { force: true, lock: 1e9, anim: 'death' });
    return this;
  }

  /** Bring a dead actor back (respawn, revive). */
  revive(hp) {
    this.alive = true;
    this.hp = hp !== undefined ? hp : this.maxHp;
    this.lockT = 0;
    this.setState(ACTOR_STATE.IDLE, { force: true });
    if (this.rig) this.rig.clearEffects();
    return this;
  }

  /** Teleport without a spring. Used by save/load and by the capture harness. */
  teleport(x, y, z, yaw) {
    this.pos.set(x, y, z);
    this.prevPos.copy(this.pos);
    this.vel.set(0, 0, 0);
    if (yaw !== undefined) { this.yaw = yaw; this.prevYaw = yaw; this.targetYaw = yaw; }
    if (this.rig) this.rig.setTransform(x, y, z, this.yaw);
    return this;
  }

  // -- simulation ------------------------------------------------------------

  /** One fixed step. Deterministic: same seed + same inputs => same state, always. */
  step(dt, app) {
    this.prevPos.copy(this.pos);
    this.prevYaw = this.yaw;
    this.stateT += dt;
    if (this.lockT > 0) this.lockT = Math.max(0, this.lockT - dt);
    if (this.invulnT > 0) this.invulnT = Math.max(0, this.invulnT - dt);
    this._flashEdge();
    // Same rate damage.js fades `hitFlash` at, so a character whose flash COMBAT *is* decaying
    // looks identical either way.
    if (this._flashV > 0) this._flashV = Math.max(0, this._flashV - dt * FLASH_FADE);

    this._sampleEnvironment(app);
    this.wishX = 0; this.wishZ = 0; this.wishSpeed = 0; this.wishJump = false; this.wishUp = 0;
    // _control() runs every step even while committed, because input buffering only works if
    // the presses that arrive DURING a swing are recorded. Each implementation decides for
    // itself which of its parts the lockout suppresses.
    if (this.alive) this._control(dt, app);
    this._integrate(dt, app);
    this._advanceStates(dt, app);
    this._face(dt);
    this._animate(dt, app);
    return this;
  }

  /** Terrain height and water height under the actor. Both services are feature-detected. */
  _sampleEnvironment(app) {
    const world = app && app.world;
    this.groundY = world && typeof world.heightAt === 'function'
      ? world.heightAt(this.pos.x, this.pos.z)
      : 0;
    this.waterY = app && app.water ? app.water.heightAt(this.pos.x, this.pos.z) : -1e9;
    const depth = this.waterY - this.pos.y;
    this.inWater = depth > 0.02 && this.groundY < this.waterY;
    this.submerged = this.inWater && depth > this.height * MOVE.submergeFrac;
  }

  /**
   * Decide what this actor wants to do. The base implementation walks a moveTo() target;
   * Player reads the input snapshot and Npc runs its behaviour tree over this.
   */
  _control(dt, app) {
    if (this.lockT > 0) return;
    const nav = this.navTarget;
    if (!nav) return;
    const dx = nav.x - this.pos.x, dz = nav.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d <= nav.arrive) { this.navTarget = null; return; }
    const inv = 1 / d;
    this.wishX = dx * inv;
    this.wishZ = dz * inv;
    // Ease off over the last two metres so arrivals do not overshoot and jitter.
    this.wishSpeed = nav.speed * smoothstep(nav.arrive, nav.arrive + 2, d);
    if (!this.strafing) this.targetYaw = Math.atan2(dx, dz);
  }

  /** Integrate velocity and position. Everything that makes movement feel weighted lives here. */
  _integrate(dt, app) {
    const hs = this.hs;
    const g = MOVE.gravity * hs;

    if (this.inWater) {
      this._integrateWater(dt, hs);
    } else {
      // --- horizontal: separate accel and decel curves ---------------------
      const control = this.grounded ? 1 : MOVE.airControlFrac;
      const wishLen = Math.hypot(this.wishX, this.wishZ);
      if (wishLen > 1e-4 && this.wishSpeed > 0) {
        const tx = (this.wishX / wishLen) * this.wishSpeed;
        const tz = (this.wishZ / wishLen) * this.wishSpeed;
        const a = MOVE.accelGround * hs * control * dt;
        this.vel.x += clamp(tx - this.vel.x, -a, a);
        this.vel.z += clamp(tz - this.vel.z, -a, a);
      } else if (this.grounded) {
        // Ground friction. Strong, and applied as a fixed decel rather than a multiplier, so
        // stopping takes the same time from any speed and the character plants rather than glides.
        const sp = Math.hypot(this.vel.x, this.vel.z);
        if (sp > 1e-4) {
          const drop = Math.min(sp, MOVE.decelGround * hs * dt);
          const k = (sp - drop) / sp;
          this.vel.x *= k; this.vel.z *= k;
        }
      } else {
        // Air drag is tiny — momentum carries, which is what makes a jump feel committed.
        const k = Math.max(0, 1 - MOVE.airDrag * dt * 0.1);
        this.vel.x *= k; this.vel.z *= k;
      }

      // --- vertical --------------------------------------------------------
      if (this.wishJump && (this.grounded || this.airT < MOVE.coyote)) {
        this.vel.y = MOVE.jumpV * hs;
        this.grounded = false;
        this.airT = MOVE.coyote;      // consume the coyote window so it cannot double-fire
        this._onJump();
      }
      this.vel.y = Math.max(MOVE.maxFall * hs, this.vel.y + g * dt);
    }

    // --- move and collide --------------------------------------------------
    this._moveHorizontal(this.vel.x * dt, this.vel.z * dt, app);
    this.pos.y += this.vel.y * dt;
    this._resolveGround(dt);
  }

  /** Buoyancy, drag and swimming. Actors float on app.water and swim when submerged. */
  _integrateWater(dt, hs) {
    const drag = Math.max(0, 1 - MOVE.waterDrag * dt);
    this.vel.x *= drag; this.vel.z *= drag;
    const wishLen = Math.hypot(this.wishX, this.wishZ);
    if (wishLen > 1e-4) {
      const sp = MOVE.swim * hs;
      const a = MOVE.accelGround * hs * 0.5 * dt;
      this.vel.x += clamp((this.wishX / wishLen) * sp - this.vel.x, -a, a);
      this.vel.z += clamp((this.wishZ / wishLen) * sp - this.vel.z, -a, a);
    }
    // Float toward a waterline just below the shoulders. The spring is soft enough that a wave
    // visibly lifts the actor — ARCHITECTURE §5 says the CPU wave height matches the GPU's.
    const rest = this.waterY - this.height * 0.42;
    const err = rest - this.pos.y;
    this.vel.y += clamp(err * MOVE.buoyancy, -14 * hs, 16 * hs) * dt;
    this.vel.y *= Math.max(0, 1 - MOVE.waterDrag * 1.4 * dt);
    if (this.wishUp > 0) this.vel.y += MOVE.swimUp * hs * dt * 6;
    if (this.wishUp < 0) this.vel.y -= MOVE.swimDown * hs * dt * 6;
    if (this.wishJump && !this.submerged) {
      // Breaching out of the water: a real jump, but damped by the drag we just applied.
      this.vel.y = MOVE.jumpV * hs * 0.68;
      this._onJump();
    }
    this.grounded = false;
  }

  /**
   * Horizontal movement with a step-up allowance. Axis-separated so the actor slides along
   * walls instead of sticking to them.
   */
  _moveHorizontal(dx, dz, app) {
    const world = app && app.world;
    if (!world || typeof world.heightAt !== 'function') {
      this.pos.x += dx; this.pos.z += dz;
      return;
    }
    const r = this.bounds().radius;
    const maxStep = MOVE.stepUp * this.hs;
    const base = Math.max(this.pos.y, this.groundY);
    if (dx !== 0) {
      const nx = this.pos.x + dx + Math.sign(dx) * r;
      const h = world.heightAt(nx, this.pos.z);
      if (h - base <= maxStep) this.pos.x += dx;
      else this.vel.x = 0;
    }
    if (dz !== 0) {
      const nz = this.pos.z + dz + Math.sign(dz) * r;
      const h = world.heightAt(this.pos.x, nz);
      if (h - base <= maxStep) this.pos.z += dz;
      else this.vel.z = 0;
    }
  }

  /** Land on, or stay above, the terrain height field. */
  _resolveGround(dt) {
    const wasGrounded = this.grounded;
    if (this.inWater && this.pos.y > this.groundY + 0.02) {
      this.grounded = false;
      this.airT = 0;
      return;
    }
    if (this.pos.y <= this.groundY + 1e-3) {
      const impactVy = this.vel.y;
      this.pos.y = this.groundY;
      if (this.vel.y < 0) this.vel.y = 0;
      this.grounded = true;
      this.airT = 0;
      if (!wasGrounded) this._onLand(impactVy);
    } else {
      this.grounded = false;
      this.airT += dt;
    }
  }

  /** Called the frame the actor leaves the ground under its own power. */
  _onJump() {
    if (this.alive) this.setState(ACTOR_STATE.JUMP, { force: true, anim: 'jump_launch' });
    this._playSfx('jump');
  }

  /** Called the frame the actor touches down. `vy` is the impact velocity (negative). */
  _onLand(vy) {
    if (!this.alive) return;
    const hard = vy < MOVE.hardLandVy * this.hs;
    this.setState(ACTOR_STATE.LAND, { force: true, lock: hard ? 0.22 : 0, anim: hard ? 'land_hard' : 'land_soft' });
    // Cluster C owns screen shake, but a hard landing on the *player* is a camera event too;
    // the player subclass forwards it. Here we only make the noise.
    this._playSfx(hard ? 'land_hard' : 'land_soft');
  }

  /** Advance timed states and let them expire back to locomotion. */
  _advanceStates(dt, app) {
    if (this.attack) {
      this.attack.t += dt;
      if (this.attack.t >= this.attack.timing.duration) this.attack = null;
    }
    const s = this.state;
    if (!this.alive) return;
    if (s === ACTOR_STATE.DOWN && this.stateT > 0.85) {
      this.setState(ACTOR_STATE.GETUP, { force: true, lock: 0.95, anim: 'getup' });
    } else if (s === ACTOR_STATE.GETUP && this.stateT > 0.95) {
      this.setState(ACTOR_STATE.IDLE, { force: true });
    } else if ((s === ACTOR_STATE.HIT || s === ACTOR_STATE.STAGGER || s === ACTOR_STATE.LAND
      || s === ACTOR_STATE.JUMP || s === ACTOR_STATE.CAST || s === ACTOR_STATE.PARRY
      || s === ACTOR_STATE.DODGE || s === ACTOR_STATE.ATTACK) && this.lockT <= 0 && !this.attack) {
      this.setState(ACTOR_STATE.IDLE);
    }
  }

  /** Turn toward the target yaw. Slower while committed, which reads as weight. */
  _face(dt) {
    const before = this.yaw;
    if (!this.strafing && !this.attack && this.wishSpeed > 0 && (this.wishX || this.wishZ)) {
      this.targetYaw = Math.atan2(this.wishX, this.wishZ);
    }
    const rate = (this.lockT > 0 || this.attack) ? MOVE.turnRateSlow : MOVE.turnRate;
    this.yaw = dampAngle(this.yaw, this.targetYaw, rate, dt);
    this.turnRate = angleDelta(before, this.yaw) / Math.max(dt, 1e-6);
  }

  /** Choose the animation state, advance the gait phase, and evaluate the pose. */
  _animate(dt, app) {
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const hs = this.hs;

    // The gait phase is the actor's, not the animator's, so it survives crossfades between
    // walk / run / sprint and the feet never teleport mid-stride.
    if (this.grounded && speed > 0.15) {
      // Stride frequency scales with the square root of speed (Froude scaling), which is why a
      // run does not read as a walk played faster.
      const freq = clamp(0.62 * Math.sqrt(speed / hs), 0.35, 3.4);
      this.gaitPhase = (this.gaitPhase + freq * dt) % 1;
    } else if (this.inWater && speed > 0.3) {
      this.gaitPhase = (this.gaitPhase + 0.55 * dt) % 1;
    } else if (this.state === ACTOR_STATE.CLIMB) {
      this.gaitPhase = (this.gaitPhase + 0.7 * dt) % 1;
    }

    const want = this._chooseAnim(speed);
    if (want !== this._animName) {
      this.animator.play(want, { blend: this._blendFor(this._animName, want) });
      this._animName = want;
    }

    copyPose(this._posePrev, this._poseCur);
    const pose = this.animator.update(dt, {
      speed, speedN: clamp01(speed / (MOVE.sprint * hs)),
      phase: this.gaitPhase, turnRate: this.turnRate,
      grounded: this.grounded, inWater: this.inWater, submerged: this.submerged,
      vy: this.vel.y, hpFrac: this.maxHp > 0 ? this.hp / this.maxHp : 0,
      deckRoll: this.deckRoll, deckPitch: this.deckPitch,
    });
    copyPose(this._poseCur, pose);
  }

  /** Crossfade length between two animation states. Attacks snap; locomotion eases. */
  _blendFor(from, to) {
    if (!from) return 0;
    if (ATTACK_TIMINGS[to]) return 0.04;
    if (to === 'hit_light' || to === 'hit_heavy' || to === 'knockdown' || to === 'block_impact') return 0.035;
    if (to === 'dodge_roll' || to === 'dodge_dash' || to === 'parry') return 0.05;
    if (to === 'jump_launch' || to === 'land_hard') return 0.06;
    if (to === 'death') return 0.10;
    return 0.16;
  }

  /**
   * Map (logical state, movement) onto one of the 41 animation states.
   * @param {number} speed horizontal speed in m/s
   * @returns {string} animation state name
   */
  _chooseAnim(speed) {
    if (this._forcedAnim && (this.lockT > 0 || this.state === ACTOR_STATE.DEAD
      || this.state === ACTOR_STATE.DOWN || this.state === ACTOR_STATE.GETUP
      || this.state === ACTOR_STATE.JUMP)) {
      return this._forcedAnim;
    }
    const s = this.state;
    if (!this.alive) return 'death';
    if (s === ACTOR_STATE.SIT) return 'sit';
    if (s === ACTOR_STATE.TALK) return 'talk';
    if (s === ACTOR_STATE.CHEER) return 'cheer';
    if (s === ACTOR_STATE.POINT) return 'point';
    if (s === ACTOR_STATE.SHIP) return this.steering ? 'ship_steer' : 'ship_idle';
    if (s === ACTOR_STATE.CLIMB) return 'climb';
    if (s === ACTOR_STATE.CHANNEL) return 'fruit_channel';
    if (this.attack) return this.attack.kind;

    if (this.inWater) {
      return speed > 0.9 * this.hs ? 'swim_stroke' : 'swim_idle';
    }
    if (!this.grounded) {
      if (this.vel.y > 1.2) return 'jump_air';
      return this.airT > 0.16 || this.vel.y < -2 ? 'fall' : 'jump_air';
    }
    if (this.blocking) return 'block_idle';

    const hs = this.hs;
    if (speed < 0.35 * hs) return this.combatReady ? 'idle_combat' : 'idle';

    if (this.strafing) {
      // Movement relative to facing decides which of the four directional cycles plays.
      const f = Math.sin(this.yaw) * this.vel.x + Math.cos(this.yaw) * this.vel.z;
      const r = Math.cos(this.yaw) * this.vel.x - Math.sin(this.yaw) * this.vel.z;
      if (f < -Math.abs(r) * 0.7) return 'backpedal';
      if (Math.abs(r) > Math.abs(f)) return r > 0 ? 'strafe_r' : 'strafe_l';
    }
    if (speed > MOVE.run * hs * 1.05) return 'sprint';
    if (speed > MOVE.walk * hs * 1.25) return 'run';
    return 'walk';
  }

  /** Wire animator events to sound. Combat wires its own hooks on top. */
  _bindAnimEvents() {
    this.animator.on('footstep', () => this._playSfx(this.footSfx, 0.8));
    this.animator.on('stroke', () => this._playSfx('swim_stroke', 0.7));
    this.animator.on('grab', () => this._playSfx('climb', 0.7));
    this.animator.on('swing', (e) => { if (e.sfx) this._playSfx(e.sfx); });
    this.animator.on('telegraph', (e) => { if (e.sfx) this._playSfx(e.sfx); });
    this.animator.on('dodge', (e) => { if (e.sfx) this._playSfx(e.sfx); });
    this.animator.on('parry', (e) => { if (e.sfx) this._playSfx(e.sfx); });
  }

  /** Fire-and-forget positional sound. Never awaited (ARCHITECTURE §5). */
  _playSfx(name, gain) {
    const audio = this.app && this.app.audio;
    if (!audio || !name) return;
    if (audio.playAt) audio.playAt(name, this.pos.x, this.pos.y, this.pos.z, gain ? { gain } : undefined);
    else if (audio.play) audio.play(name, gain ? { gain } : undefined);
  }

  // -- render ----------------------------------------------------------------

  /**
   * Interpolate the visual transform between the previous and current simulation states.
   * Render-only: it must not mutate anything the simulation reads.
   * @param {number} alpha 0..1
   */
  preRender(alpha) {
    if (!this.rig) return;
    const a = clamp01(alpha);
    this.rig.setTransform(
      lerp(this.prevPos.x, this.pos.x, a),
      lerp(this.prevPos.y, this.pos.y, a),
      lerp(this.prevPos.z, this.pos.z, a),
      this.prevYaw + angleDelta(this.prevYaw, this.yaw) * a,
    );
    blendPose(this._poseRender, this._posePrev, this._poseCur, a);
    this.rig.setPose(this._poseRender);
    this._syncEffects();
  }

  /**
   * Retrigger the flash envelope when COMBAT's `hitFlash` *rises* — a rise is a fresh hit.
   *
   * This has to run on every fixed step, not only when a frame is drawn. Capture mode simulates
   * hundreds of steps and then renders once (ARCHITECTURE §8); an edge detector that only looked
   * at render time would see one enormous "rise" from 0 to a hit that landed seconds earlier and
   * flash the character at full strength in a frame where nothing was happening. That is
   * precisely how the fixed player still came out washed white in the first re-capture.
   */
  _flashEdge() {
    const hf = this.hitFlash || 0;
    if (hf > this._flashSeen + 1e-6) this._flashV = hf;
    this._flashSeen = hf;
  }

  /**
   * Push the per-frame shader-effect channels onto the rig.
   *
   * COMBAT writes `hitFlash` / `hitFlashColor` and `aura` / `auraColor` on the actor; Cluster B
   * is the side that turns those numbers into uniforms (`fx.setFlash` documents exactly that
   * split). `fx` also pokes `rig.setFlash` directly on the frame a hit lands, and nothing else
   * ever brings the uniform back down again — so without a write here, one hit leaves the
   * character washed out at full flash for the rest of the session. That is half of why the
   * player shipped as a solid silhouette.
   *
   * The flash is driven by our OWN envelope rather than by mirroring `hitFlash`, and `hitFlash`
   * is read as an *edge*: a rise means a fresh hit and retriggers the envelope, which then fades
   * on our own clock. Mirroring the value directly would be simpler and wrong — `hitFlash` is
   * only faded by `damage.js stepStatus()`, which does not run for every actor that `fx` can
   * flash (the player in the assembled game is one), and a channel that renders a stuck upstream
   * value is a channel that latches at full white forever.
   *
   * Aura is a *level*, not an impulse: FX raises and lowers it across a telegraph, so it is
   * mirrored straight through. Both channels are only touched once the actor actually has the
   * field, because FRUIT drives `rig.setAura()` directly when no fx system is present and never
   * writes `actor.aura` — mirroring an absent field would zero its glow every frame.
   *
   * Render-side by design: these are presentation-only fields, and nothing in the simulation
   * reads them (ARCHITECTURE §4).
   */
  _syncEffects() {
    const rig = this.rig;
    if (!rig || !rig.ownsMaterial) return;
    if (this.hitFlash !== undefined) {
      // Catch a hit that landed AFTER this actor stepped — FX runs later in the step order than
      // PLAYER does, so the alternative is every flash arriving one frame late.
      this._flashEdge();
      // enemy.js seeds `hitFlashColor = 0` to mean "none"; 0 is also legal black, and a black
      // flash is never wanted, so treat it as "keep the colour already on the material".
      rig.setFlash(this.hitFlashColor ? this.hitFlashColor : null, this._flashV);
    }
    if (this.aura !== undefined) {
      rig.setAura(this.auraColor ? this.auraColor : null, this.aura || 0);
    }
  }

  // -- persistence -----------------------------------------------------------

  serialize() {
    return {
      id: this.id,
      spec: this.spec.id,
      pos: [this.pos.x, this.pos.y, this.pos.z],
      vel: [this.vel.x, this.vel.y, this.vel.z],
      yaw: this.yaw,
      hp: this.hp,
      maxHp: this.maxHp,
      state: this.state,
      alive: this.alive,
      gait: this.gaitPhase,
      anim: this.animator.serialize(),
    };
  }

  deserialize(o) {
    if (!o) return this;
    if (o.pos) this.pos.set(o.pos[0], o.pos[1], o.pos[2]);
    if (o.vel) this.vel.set(o.vel[0], o.vel[1], o.vel[2]);
    if (typeof o.yaw === 'number') { this.yaw = o.yaw; this.targetYaw = o.yaw; }
    if (typeof o.hp === 'number') this.hp = o.hp;
    if (typeof o.maxHp === 'number') this.maxHp = o.maxHp;
    if (typeof o.gait === 'number') this.gaitPhase = o.gait;
    this.alive = o.alive !== undefined ? !!o.alive : this.hp > 0;
    this.prevPos.copy(this.pos);
    this.prevYaw = this.yaw;
    if (o.state) this.setState(o.state, { force: true });
    if (o.anim) { this.animator.deserialize(o.anim); this._animName = this.animator.stateName; }
    if (this.rig) this.rig.setTransform(this.pos.x, this.pos.y, this.pos.z, this.yaw);
    return this;
  }

  dispose() {
    if (this.rig) this.rig.dispose();
    this.rig = null;
    this.animator.off();
  }
}

/**
 * Factory.
 * @param {object} app @param {object|string} spec @param {object} [opts]
 * @returns {Actor}
 */
export function createActor(app, spec, opts) {
  return new Actor(app, spec, opts);
}

export default Actor;
