// Devil fruit ability framework + the eighteen authored abilities.
//
// WHY this file is shaped the way it is:
//   A "power" in this game is not a damage number. It is a *verb*. Every ability below either
//   moves the player somewhere they could not otherwise go, or changes what the fight is made
//   of (reach, timing, the ground itself, whether you can be hit at all). If an ability could
//   be replaced by "+20% damage" it does not belong here.
//
// The framework is three small pieces:
//   Meter        — fruit energy. Regenerates fast out of combat, crawls in combat. Costs are
//                  what stops a power being spammed; cooldowns are what stops it being the
//                  only thing you press.
//   AbilityRunner— one cast at a time, phased windup -> active -> recover, with cancel rules.
//                  Casts drive Cluster B's Animator through `animState`.
//   FruitContext — the *only* surface an ability may touch. Every service is feature-detected
//                  because FRUIT is built in parallel with WORLD, COMBAT and CHARACTER; an
//                  ability degrades to "no visible effect" rather than throwing when a
//                  collaborator has not landed yet.
//
// Determinism: no wall clock, no Math.random. All randomness comes from a named Rng stream
// owned by FruitSystem and advanced only from inside ability callbacks.

import { P } from '../gen/palette.js';
import { clamp, clamp01, lerp, ease } from '../core/math.js';
// hitbox.js is Cluster C's *vocabulary* module — the hit payload, the element list and the tag
// list. Importing it is not reaching into COMBAT's implementation; a hit built any other way is
// not the currency ARCHITECTURE §5 names, and damage.js would ignore half of it.
import { makeHit, ELEMENT, TAG } from '../combat/hitbox.js';

// ---------------------------------------------------------------------------
// Traversal capability vocabulary
// ---------------------------------------------------------------------------

/**
 * The machine-checkable traversal surface. A fruit that flips none of these is a damage
 * modifier wearing a costume, and tools/check-fruit.mjs fails the build for it.
 * @type {readonly string[]}
 */
export const TRAVERSAL_FLAGS = Object.freeze([
  'canGrapple',      // fire an anchor at geometry or an enemy and be pulled to it
  'canAirDash',      // change horizontal velocity mid-air, a limited number of times
  'canHover',        // sustain or gain altitude while a resource drains
  'canWalkOnWater',  // stand on the sea surface (hie freezes it; nothing else may claim this)
  'canBurrow',       // travel below the surface, untargetable, resurface elsewhere
  'canGlide',        // sustained low-gravity horizontal travel while falling
  'canPhase',        // physical attacks and some collisions pass through
  'canBreakTerrain', // remove or place world voxels as a movement/combat verb
  'canSuperJump',    // a wind-up that produces a jump far beyond the base jump
]);

/** @returns {Record<string, boolean>} every traversal flag, all false. */
export function blankCaps() {
  const c = Object.create(null);
  for (const f of TRAVERSAL_FLAGS) c[f] = false;
  return c;
}

/**
 * Compact, stable signature string for a capability set — used to prove no two fruits
 * traverse the world the same way.
 * @param {Record<string, boolean>} caps
 * @returns {string} e.g. "canGrapple+canSuperJump"
 */
export function capsSignature(caps) {
  return TRAVERSAL_FLAGS.filter((f) => !!caps[f]).join('+') || 'none';
}

// ---------------------------------------------------------------------------
// Animation contract with Cluster B
// ---------------------------------------------------------------------------

/**
 * The pose each ability *wants*. Cluster B's Animator (src/entity/anim.js) currently ships three
 * fruit poses — `fruit_cast_a` (horizontal throw), `fruit_cast_b` (overhead slam) and
 * `fruit_channel` (held) — so every ability also declares `animState`, which is the real state
 * it plays today. `castPose` is the finer intent, recorded so Cluster B can widen the vocabulary
 * later without FRUIT changing (ARCHITECTURE §9, FRUIT animation request).
 * @type {readonly string[]}
 */
export const FRUIT_CAST_POSES = Object.freeze([
  'castStretch',   // one limb thrown forward and held long — gomu pistol
  'castSpin',      // whole-body spin, arms out — gomu gatling
  'castGuard',     // braced, torso swollen/hunched — gomu balloon, suna ghost
  'castCone',      // both palms forward at chest height — mera cone
  'castUppercut',  // rising fist, weight on the back foot — mera pillar
  'castPoint',     // single arm extended, index lead — hie freeze, suna drain, zushi pull
  'castSweep',     // low horizontal arm sweep across the body — hie spikes, gura shockwave
  'castRaise',     // both arms lifted overhead — hie wall, gura seaquake, zushi crush
  'castSlam',      // overhead-to-ground double slam — gura slam, zushi meteor
  'castAura',      // arms wide, body still, held — suna storm, mera kindle
]);

/** The three fruit cast states Cluster B actually plays. */
export const CAST_A = 'fruit_cast_a';
export const CAST_B = 'fruit_cast_b';
export const CHANNEL = 'fruit_channel';

/**
 * Traversal pose intents mapped onto states Cluster B already ships. WHY map rather than ask for
 * eight new states: a fruit kit that cannot pose at all reads as a bug, and every one of these
 * has an existing state whose body axis is right even if its name is not.
 * @type {Readonly<Record<string, string>>}
 */
export const MOVE_ANIM = Object.freeze({
  fruitCompress: 'fruit_channel',  // held wind-up, whole body loaded
  fruitGrapple: 'fruit_cast_a',    // arm thrown out and anchored
  fruitAirDash: 'dodge_dash',      // a committed horizontal burst
  fruitHover: 'jump_air',          // airborne, no ground contact
  fruitSkate: 'sprint',            // fast, low, feet planted
  fruitBurrow: 'swim_stroke',      // submerged travel
  fruitGlide: 'fall',              // falling, controlled
  fruitDrown: 'swim_idle',         // the one state a devil fruit user never wants
});

/** Every Animator state FRUIT drives. Asserted against Cluster B's STATE_NAMES by the gate. */
export const REQUIRED_ANIM_STATES = Object.freeze(
  [CAST_A, CAST_B, CHANNEL].concat(Object.values(MOVE_ANIM))
    .filter((v, i, a) => a.indexOf(v) === i),
);

// ---------------------------------------------------------------------------
// Meter
// ---------------------------------------------------------------------------

/** Seconds after the last hostile event before out-of-combat regen kicks in. */
const COMBAT_MEMORY = 3.0;

export class Meter {
  /**
   * WHY the two rates are so far apart: out of combat the meter is not a resource at all, it is
   * a short cooldown on traversal, so exploring never means waiting. In a fight it is the real
   * budget, and every point spent on getting somewhere is a point not spent on a power.
   *
   * @param {number} [max=100] capacity
   * @param {number} [regenCalm=20] units/second once out of combat
   * @param {number} [regenFight=7] units/second while in combat
   */
  constructor(max = 100, regenCalm = 20, regenFight = 7) {
    this.max = max;
    this.value = max;
    this.regenCalm = regenCalm;
    this.regenFight = regenFight;
    /** Counts down; while > 0 the player is considered "in combat". */
    this.combatTimer = 0;
    /** Set while drowning or otherwise cut off from the fruit. */
    this.locked = false;
  }

  get t() { return this.max > 0 ? clamp01(this.value / this.max) : 0; }
  get inCombat() { return this.combatTimer > 0; }

  /** Mark a hostile event; suppresses fast regen for COMBAT_MEMORY seconds. */
  touchCombat() { this.combatTimer = COMBAT_MEMORY; }

  /** @param {number} n @returns {boolean} true if `n` is affordable right now */
  can(n) { return !this.locked && this.value >= n - 1e-6; }

  /** @param {number} n @returns {boolean} true if the spend happened */
  spend(n) {
    if (!this.can(n)) return false;
    this.value = Math.max(0, this.value - n);
    return true;
  }

  /** Drain without the affordability gate (channels pay per-second and may bottom out). */
  drain(n) {
    this.value = Math.max(0, this.value - n);
    return this.value > 0;
  }

  refund(n) { this.value = Math.min(this.max, this.value + n); }

  step(dt) {
    if (this.combatTimer > 0) this.combatTimer = Math.max(0, this.combatTimer - dt);
    if (this.locked) return;
    const rate = this.combatTimer > 0 ? this.regenFight : this.regenCalm;
    this.value = Math.min(this.max, this.value + rate * dt);
  }

  serialize() { return { v: Math.round(this.value * 1000) / 1000, c: Math.round(this.combatTimer * 1000) / 1000 }; }
  deserialize(o) {
    if (!o) return;
    if (typeof o.v === 'number') this.value = clamp(o.v, 0, this.max);
    if (typeof o.c === 'number') this.combatTimer = Math.max(0, o.c);
  }
}

// ---------------------------------------------------------------------------
// Ability definition
// ---------------------------------------------------------------------------

/**
 * One devil fruit move.
 *
 * Lifecycle: canUse -> (pay cost) -> onStart -> onUpdate(dt) each step -> onEnd.
 * `phase` moves windup -> active -> recover; `onUpdate` reads `run.phase` when it cares.
 */
export class Ability {
  /** @param {object} def see the ABILITIES table below for every field */
  constructor(def) {
    /** @type {string} */ this.id = def.id;
    /** @type {string} */ this.name = def.name;
    /** @type {string} */ this.fruit = def.fruit;
    /** @type {string} */ this.icon = def.icon;
    /** @type {1|2|3} */ this.slot = def.slot;
    /** @type {number} */ this.cost = def.cost || 0;
    /** @type {number} */ this.cooldown = def.cooldown || 0;
    /** @type {number} seconds of wind-up before the move commits */
    this.castTime = def.castTime || 0;
    /** @type {number} seconds the move is doing its thing */
    this.activeTime = def.activeTime || 0;
    /** @type {number} seconds of recovery the player is committed to afterwards */
    this.recoverTime = def.recoverTime || 0;
    /** @type {number} meter per second while channelling (tags include 'channel') */
    this.drain = def.drain || 0;
    /** @type {string} Cluster B Animator state played for the whole cast */
    this.animState = def.animState;
    /** @type {string} the finer pose this move wants; see FRUIT_CAST_POSES */
    this.castPose = def.castPose;
    /** @type {object} what the player (and an enemy) sees during wind-up */
    this.telegraph = def.telegraph || null;
    /** @type {string[]} */ this.tags = Object.freeze(def.tags || []);
    /** @type {string} one line, shown on the fruit wheel */
    this.desc = def.desc || '';
    this.onStart = def.onStart || null;
    this.onUpdate = def.onUpdate || null;
    this.onEnd = def.onEnd || null;
    this._canUse = def.canUse || null;
    Object.freeze(this);
  }

  get totalTime() { return this.castTime + this.activeTime + this.recoverTime; }
  has(tag) { return this.tags.indexOf(tag) >= 0; }

  /**
   * Gate that runs before the cost is paid.
   * @param {FruitContext} ctx
   * @returns {boolean}
   */
  canUse(ctx) {
    if (this.has('grounded') && !ctx.self.grounded) return false;
    if (this.has('aerial') && ctx.self.grounded) return false;
    if (this._canUse) return !!this._canUse(ctx);
    return true;
  }
}

/** Runtime record for one in-flight cast. Recycled — never allocated per step. */
class Run {
  constructor() { this.reset(null); }
  reset(ability) {
    this.ability = ability;
    this.phase = 'windup';
    this.t = 0;          // seconds inside the current phase
    this.total = 0;      // seconds since the cast began
    this.data = Object.create(null);
    this.done = ability === null;
    this.cancelled = false;
  }
}

/**
 * Runs at most one ability at a time and owns cooldowns.
 *
 * Cancel rules, in order of strength:
 *   'uncancellable' — nothing stops it once it starts (the price of a big move)
 *   'commit'        — the wind-up may be cancelled, the active phase may not
 *   'stance'        — ends the moment the player releases the slot key, or meter hits zero
 *   default         — a dodge, a hit taken, or entering deep water cancels it
 */
export class AbilityRunner {
  constructor() {
    /** @type {Map<string, number>} ability id -> seconds of cooldown remaining */
    this.cooldowns = new Map();
    this.run = new Run();
    this.run.reset(null);
    /** Scales every cooldown. The harness sets this to 0 for fruit-spam profiling. */
    this.cooldownScale = 1;
    /** Monotone count of successful casts. Harness reads it as app.fruit.useCount. */
    this.useCount = 0;
    this.lastFailure = '';
  }

  get active() { return !this.run.done; }
  get activeAbility() { return this.run.done ? null : this.run.ability; }

  cooldownOf(id) { return this.cooldowns.get(id) || 0; }

  /**
   * Attempt to start an ability.
   * @param {Ability} ability
   * @param {FruitContext} ctx
   * @returns {boolean} true if the cast began (cost paid, onStart called)
   */
  start(ability, ctx) {
    if (!ability) { this.lastFailure = 'no ability'; return false; }
    if (this.active) {
      // A cast in its recovery tail may be cut into by the next move — that is what makes
      // ability chaining feel responsive instead of gluey.
      if (this.run.phase !== 'recover' || this.run.ability.has('uncancellable')) {
        this.lastFailure = 'busy';
        return false;
      }
      this.cancel('chained', ctx);
    }
    if (this.cooldownOf(ability.id) > 0) { this.lastFailure = 'cooldown'; return false; }
    if (ctx.meter.locked) { this.lastFailure = 'sealed'; return false; }
    if (!ctx.meter.can(ability.cost)) { this.lastFailure = 'meter'; return false; }
    if (!ability.canUse(ctx)) { this.lastFailure = 'context'; return false; }

    ctx.meter.spend(ability.cost);
    ctx.meter.touchCombat();
    this.run.reset(ability);
    ctx.run = this.run;
    ctx.ability = ability;
    this.useCount++;
    if (ability.onStart) ability.onStart(ctx);
    // A zero-windup move is already committed on the frame it starts.
    if (ability.castTime <= 0) this._enter('active', ctx);
    return true;
  }

  _enter(phase, ctx) {
    this.run.phase = phase;
    this.run.t = 0;
    if (phase === 'active' && this.run.ability.onUpdate) this.run.ability.onUpdate(ctx, 0);
  }

  /**
   * Advance the current cast.
   * @param {number} dt fixed timestep
   * @param {FruitContext} ctx
   */
  step(dt, ctx) {
    for (const [id, cd] of this.cooldowns) {
      const n = cd - dt;
      if (n <= 0) this.cooldowns.delete(id); else this.cooldowns.set(id, n);
    }
    if (this.run.done) return;
    const a = this.run.ability;
    ctx.run = this.run;
    ctx.ability = a;
    this.run.t += dt;
    this.run.total += dt;

    if (a.has('channel') && a.drain > 0 && this.run.phase === 'active') {
      if (!ctx.meter.drain(a.drain * dt)) { this.cancel('meter', ctx); return; }
    }
    if (a.onUpdate) a.onUpdate(ctx, dt);
    if (this.run.done) return; // an ability may end itself from onUpdate via ctx.finish()

    if (this.run.phase === 'windup' && this.run.t >= a.castTime) this._enter('active', ctx);
    else if (this.run.phase === 'active' && this.run.t >= a.activeTime) this._enter('recover', ctx);
    else if (this.run.phase === 'recover' && this.run.t >= a.recoverTime) this.finish(ctx);
  }

  /** End the cast normally and start its cooldown. */
  finish(ctx) {
    if (this.run.done) return;
    const a = this.run.ability;
    this.run.done = true;
    if (a.onEnd) a.onEnd(ctx, false);
    if (a.cooldown > 0) this.cooldowns.set(a.id, a.cooldown * this.cooldownScale);
  }

  /**
   * Cut a cast short.
   * @param {string} reason 'dodge' | 'hit' | 'water' | 'meter' | 'release' | 'chained' | 'equip'
   * @param {FruitContext} ctx
   * @returns {boolean} true if something was actually cancelled
   */
  cancel(reason, ctx) {
    if (this.run.done) return false;
    const a = this.run.ability;
    if (a.has('uncancellable') && reason !== 'equip' && reason !== 'water') return false;
    if (a.has('commit') && this.run.phase !== 'windup' && reason !== 'equip' && reason !== 'water') return false;
    if (a.has('stance') && reason === 'hit') return false; // a stance is *for* eating hits
    this.run.done = true;
    this.run.cancelled = true;
    if (a.onEnd) a.onEnd(ctx, true);
    // A cancelled wind-up refunds most of its cost; cancelling later does not.
    if (this.run.phase === 'windup') ctx.meter.refund(a.cost * 0.7);
    const cd = a.cooldown * this.cooldownScale * (this.run.phase === 'windup' ? 0.35 : 1);
    if (cd > 0) this.cooldowns.set(a.id, cd);
    return true;
  }

  serialize() {
    const cd = {};
    for (const [k, v] of this.cooldowns) cd[k] = Math.round(v * 1000) / 1000;
    return { cd, useCount: this.useCount };
  }

  deserialize(o) {
    this.cooldowns.clear();
    if (!o) return;
    if (o.cd) for (const k in o.cd) this.cooldowns.set(k, o.cd[k]);
    if (typeof o.useCount === 'number') this.useCount = o.useCount;
  }
}

// ---------------------------------------------------------------------------
// The context handed to every ability callback
// ---------------------------------------------------------------------------

const _v = { x: 0, y: 0, z: 0 };

/**
 * Everything an ability is allowed to touch, with every collaborator feature-detected.
 *
 * WHY a fat context instead of importing systems: FRUIT must not import COMBAT, WORLD or
 * CHARACTER concrete classes (ARCHITECTURE §2), and it must keep working headlessly for
 * tools/check-fruit.mjs. One adapter, written once, beats eighteen defensive call sites.
 */
export class FruitContext {
  /** @param {object} sys the FruitSystem @param {object} app */
  constructor(sys, app) {
    this.sys = sys;
    this.app = app;
    this.fruit = null;       // active fruit definition
    this.ability = null;
    this.run = null;
    this.dt = 0;
    this.rng = sys.rng;
    this.meter = sys.meter;
    /** Damage the system has applied but nobody consumed — only used when COMBAT is absent. */
    this.hitLog = [];
  }

  get self() { return this.sys.body; }
  get caps() { return this.sys.caps; }
  get fx() { return this.sys.fx; }

  /** End the running ability from inside onUpdate (a projectile that has retracted, etc). */
  finish() { this.sys.runner.finish(this); }

  // --- world queries -------------------------------------------------------

  /** @returns {object|null} the WORLD system, or null while it is unbuilt */
  get world() { return this.app && this.app.world ? this.app.world : null; }

  /** Ground height at a world XZ, or sea level when WORLD has not landed. */
  heightAt(x, z) {
    const w = this.world;
    return w && w.heightAt ? w.heightAt(x, z) : 0;
  }

  /** Block id at a voxel-ish world position, or 0 (air) when unknown. */
  blockAt(x, y, z) {
    const w = this.world;
    return w && w.blockAt ? w.blockAt(x, y, z) : 0;
  }

  /**
   * Resolve a block name to an id once and cache it. Returns -1 when the vocabulary is not
   * loaded, which every caller treats as "skip the terrain edit".
   * @param {string} name a key of gen/blocks.js `B`
   */
  blockId(name) { return this.sys.blockId(name); }

  /** Write a voxel. No-op (returning false) without WORLD. */
  setBlock(x, y, z, id) {
    const w = this.world;
    if (!w || !w.setBlock || id < 0) return false;
    w.setBlock(Math.floor(x), Math.floor(y), Math.floor(z), id);
    this.sys.stats.blocksChanged++;
    return true;
  }

  /** Sea surface height at an XZ, matching the GPU exactly (ARCHITECTURE §5). */
  seaHeight(x, z) {
    const w = this.app && this.app.water;
    if (!w || !w.sampleHeight) return 0;
    const s = w.sampleHeight(x, z);
    return s && typeof s.y === 'number' ? s.y : 0;
  }

  /** True where the sea is over ground: the only places hie may freeze and suna may fail. */
  isOpenWater(x, z) {
    return this.heightAt(x, z) < this.seaHeight(x, z) - 0.35;
  }

  /** 0..1 rainfall right now. Mera and suna both care, in opposite directions. */
  get rain() {
    const s = this.app && this.app.sky;
    return s && s.weather ? (s.weather.rain || 0) : 0;
  }

  /** 0..1 how wet the player is: rain, spray, or standing in the shallows. */
  get wetness() { return this.sys.wetness; }

  // --- targets -------------------------------------------------------------

  /** @returns {Array<object>} live hostiles, or an empty array before ENEMIES lands. */
  enemies() { return this.sys.enemyList(); }

  /**
   * Nearest hostile within `maxDist` metres of the player.
   * @param {number} maxDist
   * @param {(e:object)=>boolean} [filter]
   * @returns {object|null}
   */
  nearest(maxDist, filter) {
    const list = this.enemies();
    let best = null, bestD = maxDist * maxDist;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (filter && !filter(e)) continue;
      const p = this.sys.posOf(e, _v);
      const dx = p.x - this.self.x, dy = p.y - this.self.y, dz = p.z - this.self.z;
      const d = dx * dx + dy * dy * 0.4 + dz * dz;
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /** Every hostile inside a sphere. @returns {Array<object>} */
  inRadius(x, y, z, r, out) {
    const list = this.enemies();
    const res = out || [];
    res.length = 0;
    const r2 = r * r;
    for (let i = 0; i < list.length; i++) {
      const p = this.sys.posOf(list[i], _v);
      const dx = p.x - x, dy = p.y - y, dz = p.z - z;
      if (dx * dx + dy * dy + dz * dz <= r2) res.push(list[i]);
    }
    return res;
  }

  /** World position of any target-ish object, normalised into {x,y,z}. */
  posOf(e, out) { return this.sys.posOf(e, out || { x: 0, y: 0, z: 0 }); }

  // --- acting on the world -------------------------------------------------

  /**
   * Apply damage and status. Routes through COMBAT when present — never touches hp directly
   * (ARCHITECTURE §5) — and otherwise records the hit so headless checks can assert on it.
   * @param {object} target
   * @param {{amount:number, kind?:string, knock?:number, knockUp?:number, stun?:number,
   *          burn?:number, freeze?:number, slow?:number, blind?:number, dot?:number,
   *          tags?:string[]}} spec
   */
  hit(target, spec) {
    if (!target) return false;
    let amount = spec.amount;
    const p = this.posOf(target, _v);
    const dx = p.x - this.self.x, dz = p.z - this.self.z;
    const len = Math.hypot(dx, dz) || 1;

    // Cluster C owns freeze, shatter, burn and sand-slow for anything it has initialised
    // (damage.js `initCombatant` gives every combatant a `status` block). FRUIT only runs its
    // own shatter maths for targets COMBAT has never seen — otherwise the bonus lands twice.
    const clusterC = !!(target.status && typeof target.status.frozenT === 'number');
    if (!clusterC) {
      const st = this.sys.statusOf(target);
      if (st.frozen > 0) {
        amount *= SHATTER_MULT;
        st.frozen = 0;
        st.shattered = 0.5;
        this.fx.shatter(p);
        this.sound('fruit_shatter');
      }
    }

    const hit = makeHit({
      damage: amount,
      poise: spec.poise !== undefined ? spec.poise : amount * 0.8,
      knockback: spec.knock || 0,
      launch: spec.knockUp ? (spec.knockUp === true ? 7 : spec.knockUp) : 0,
      hitstop: spec.hitstop !== undefined ? spec.hitstop : 0.05,
      element: ELEMENT_OF[spec.kind] || ELEMENT.NONE,
      source: this.sys.playerRef,
      tags: spec.tags ? [TAG.FRUIT].concat(spec.tags) : [TAG.FRUIT],
      blockable: spec.blockable !== undefined ? spec.blockable : 0.7,
      critChance: 0.06,
      fxKind: FXKIND_OF[spec.kind] || 'blunt',
    });
    hit.dirX = dx / len; hit.dirZ = dz / len;
    hit.px = p.x; hit.py = p.y + 1.0; hit.pz = p.z;
    hit.fruitId = this.fruit ? this.fruit.id : null;
    hit.abilityId = this.ability ? this.ability.id : null;

    const c = this.app && this.app.combat;
    if (c && c.applyHit) c.applyHit(target, hit);
    else if (this.hitLog.length < 4096) this.hitLog.push(hit);

    // Extra status the element alone does not express. On a Cluster C combatant these write the
    // documented status fields directly, because COMBAT exposes no applyStatus yet (see §9).
    if (spec.freeze) this.status(target, 'frozen', spec.freeze, 1);
    if (spec.burn) this.status(target, 'burn', spec.burn, 1);
    if (spec.slow) this.status(target, 'slow', spec.slow, 1);
    if (spec.blind) this.status(target, 'blind', spec.blind, 1);
    if (spec.dot) this.status(target, 'drain', spec.dot, 1);

    this.meter.touchCombat();
    this.sys.stats.hits++;
    this.sys.stats.damage += amount;
    return true;
  }

  /**
   * Apply a timed status. Uses COMBAT's own status service when it exists so statuses show up
   * in enemy AI and the HUD; otherwise keeps them in FRUIT's own namespace on the target.
   */
  status(target, name, seconds, power) {
    const c = this.app && this.app.combat;
    if (c && c.applyStatus) { c.applyStatus(target, name, seconds, power); return; }
    const cs = target && target.status;
    if (cs && typeof cs.frozenT === 'number') {
      // damage.js's own vocabulary. Refresh, never stack — that is its documented rule.
      if (name === 'frozen') { cs.frozenT = Math.max(cs.frozenT, seconds); cs.frostStacks = 0; }
      else if (name === 'burn') {
        cs.burnT = Math.max(cs.burnT, seconds);
        cs.burnDps = Math.max(cs.burnDps || 0, 5);
        cs.burnSrc = this.sys.playerRef;
      } else if (name === 'slow' || name === 'blind') cs.sandT = Math.max(cs.sandT, seconds);
      else if (name === 'drain') {
        cs.sandT = Math.max(cs.sandT, seconds);
        cs.burnT = Math.max(cs.burnT, seconds);
        cs.burnDps = Math.max(cs.burnDps || 0, 4);
        cs.burnSrc = this.sys.playerRef;
      }
      return;
    }
    const st = this.sys.statusOf(target);
    st[name] = Math.max(st[name] || 0, seconds);
  }

  /** Add to the player's velocity. The player controller integrates; FRUIT never does. */
  impulse(x, y, z) {
    const b = this.self;
    b.vx += x; b.vy += y; b.vz += z;
    this.sys.overriding = true;
  }

  setVel(x, y, z) {
    const b = this.self;
    b.vx = x; b.vy = y; b.vz = z;
    this.sys.overriding = true;
  }

  /** Hard reposition (burrow resurface, grapple arrival, drowning rescue). */
  teleport(x, y, z) {
    const b = this.self;
    b.x = x; b.y = y; b.z = z;
    this.sys.overriding = true;
    this.sys.stats.teleports++;
  }

  /** Unit forward vector from the player's yaw, into `out`. */
  forward(out) {
    const y = this.self.yaw;
    out = out || { x: 0, y: 0, z: 0 };
    out.x = -Math.sin(y); out.y = 0; out.z = -Math.cos(y);
    return out;
  }

  /** Aim vector including pitch — abilities that travel through the air use this. */
  aim(out) {
    const y = this.self.yaw, p = this.self.pitch;
    out = out || { x: 0, y: 0, z: 0 };
    const cp = Math.cos(p);
    out.x = -Math.sin(y) * cp; out.y = Math.sin(p); out.z = -Math.cos(y) * cp;
    return out;
  }

  /** Roughly chest height on the player — where limbs and beams originate. */
  eye(out) {
    out = out || { x: 0, y: 0, z: 0 };
    out.x = this.self.x; out.y = this.self.y + 1.55; out.z = this.self.z;
    return out;
  }

  // --- feedback ------------------------------------------------------------

  /** Camera trauma. Cluster C budgets it, so a spammed power cannot shake the screen flat. */
  shake(amount, dur) {
    const f = this.app && this.app.fx;
    if (f && f.addShake) f.addShake(clamp01(amount * 0.45));
    this.sys.stats.shake += amount;
  }

  hitstop(s) {
    const f = this.app && this.app.fx;
    if (f && f.addHitstop) { f.addHitstop(s); return; }
    const c = this.app && this.app.clock;
    if (c && c.addHitstop) c.addHitstop(s);
  }

  sound(name, opts) {
    const a = this.app && this.app.audio;
    if (a && a.play) a.play(name, opts);
  }

  toast(text, kind) {
    const u = this.app && this.app.ui;
    if (u && u.toast) u.toast(text, kind || 'info');
  }

  /** Tell QUEST a power was used, with the "was it seen in town" flags bounty cares about. */
  notifyUse(move) { this.sys.notifyFruitUse(move); }
}

/** Damage multiplier applied to a frozen target — only used when COMBAT is absent. */
export const SHATTER_MULT = 2.4;

/** FRUIT damage kind -> Cluster C ELEMENT. This is what makes burn/frost/slow happen at all. */
const ELEMENT_OF = Object.freeze({
  fire: ELEMENT.FLAME, ice: ELEMENT.FROST, sand: ELEMENT.SAND, drain: ELEMENT.SAND,
  quake: ELEMENT.QUAKE, gravity: ELEMENT.GRAVITY, blunt: ELEMENT.NONE, drown: ELEMENT.NONE,
});

/** FRUIT damage kind -> the impact recipe Cluster C's fx pool plays. */
const FXKIND_OF = Object.freeze({
  fire: 'flame', ice: 'frost', sand: 'sand', drain: 'sand',
  quake: 'quake', gravity: 'gravity', blunt: 'blunt',
});

// ---------------------------------------------------------------------------
// Small shared helpers for the ability bodies
// ---------------------------------------------------------------------------

/** Cheap deterministic per-target jitter so cluster effects do not stack perfectly. */
function spread(rng, scale) { return rng.sym() * scale; }

// ---------------------------------------------------------------------------
// GOMU — rubber. Reach, momentum, and giving a hit back.
// ---------------------------------------------------------------------------

const GOMU = [
  {
    id: 'gomu.pistol', name: 'Gum-Gum Pistol', fruit: 'gomu', icon: 'boot', slot: 1,
    cost: 12, cooldown: 1.6, castTime: 0.16, activeTime: 1.1, recoverTime: 0.18,
    animState: CAST_A, castPose: 'castStretch', tags: ['melee', 'stretch', 'projectile'],
    desc: 'The arm keeps going. 18 m of reach with a punch you can watch travel.',
    telegraph: { color: P.telegraphGuard, shape: 'line', range: 18, width: 1.2, time: 0.16 },
    onStart(ctx) {
      const d = ctx.run.data;
      const e = ctx.eye();
      d.ox = e.x; d.oy = e.y; d.oz = e.z;
      const a = ctx.aim();
      d.dx = a.x; d.dy = a.y; d.dz = a.z;
      d.len = 0; d.out = true; d.struck = null;
      // Snap the aim onto a nearby enemy so a fast, long move still feels aimed rather than
      // fired into the void. This is assist, not homing: it only bends the initial vector.
      const t = ctx.nearest(20, (x) => ctx.sys.aliveOf(x));
      if (t) {
        const p = ctx.posOf(t);
        const vx = p.x - e.x, vy = (p.y + 1.0) - e.y, vz = p.z - e.z;
        const l = Math.hypot(vx, vy, vz) || 1;
        const dot = (vx / l) * a.x + (vy / l) * a.y + (vz / l) * a.z;
        if (dot > 0.86) { d.dx = vx / l; d.dy = vy / l; d.dz = vz / l; }
      }
      ctx.fx.gomuLimb(d, 0);
      ctx.sound('fruit_gomu_stretch');
      ctx.notifyUse('pistol');
    },
    onUpdate(ctx, dt) {
      const d = ctx.run.data;
      if (ctx.run.phase === 'windup') return;
      const speed = d.out ? GOMU_FIST_OUT : GOMU_FIST_BACK;
      d.len += (d.out ? 1 : -1) * speed * dt;
      if (d.len >= GOMU_REACH) { d.len = GOMU_REACH; d.out = false; }
      if (d.len <= 0) { ctx.finish(); return; }
      const fx = d.ox + d.dx * d.len, fy = d.oy + d.dy * d.len, fz = d.oz + d.dz * d.len;
      ctx.fx.gomuLimb(d, d.len);
      if (d.out && !d.struck) {
        const hits = ctx.inRadius(fx, fy, fz, 1.35);
        if (hits.length) {
          d.struck = hits[0];
          ctx.hit(hits[0], { amount: 24, kind: 'blunt', knock: 11, stun: 0.35 });
          ctx.hitstop(0.07);
          ctx.shake(0.5, 0.14);
          ctx.fx.impactAt(fx, fy, fz, 'gomu');
          ctx.sound('fruit_gomu_hit');
          d.out = false;
        }
      }
    },
    onEnd(ctx) { ctx.fx.gomuLimbEnd(); },
  },
  {
    id: 'gomu.gatling', name: 'Gum-Gum Gatling', fruit: 'gomu', icon: 'sword', slot: 2,
    cost: 26, cooldown: 5.0, castTime: 0.24, activeTime: 1.15, recoverTime: 0.3,
    animState: CAST_A, castPose: 'castSpin', tags: ['melee', 'multihit', 'commit'],
    desc: 'A blur of arms. Sixteen hits in a metre-wide storm around you.',
    telegraph: { color: P.telegraphGuard, shape: 'ring', range: 3.4, time: 0.24 },
    onStart(ctx) {
      ctx.run.data.next = 0; ctx.run.data.n = 0;
      ctx.sound('fruit_gomu_gatling');
      ctx.notifyUse('gatling');
    },
    onUpdate(ctx, dt) {
      const d = ctx.run.data;
      if (ctx.run.phase !== 'active') return;
      d.next -= dt;
      // The player drifts forward through the barrage — a spin you cannot steer is a trap.
      const f = ctx.forward();
      ctx.impulse(f.x * 9 * dt, 0, f.z * 9 * dt);
      ctx.fx.gomuGatling(ctx.self, ctx.run.t / Math.max(0.001, ctx.ability.activeTime));
      while (d.next <= 0) {
        d.next += GOMU_GATLING_INTERVAL;
        d.n++;
        const ang = ctx.self.yaw + spread(ctx.rng, 0.9);
        const px = ctx.self.x - Math.sin(ang) * 2.0;
        const pz = ctx.self.z - Math.cos(ang) * 2.0;
        const list = ctx.inRadius(px, ctx.self.y + 1.0, pz, 2.2);
        for (const e of list) ctx.hit(e, { amount: 7, kind: 'blunt', knock: 1.6 });
        ctx.fx.impactAt(px, ctx.self.y + 1.1, pz, 'gomu');
        if (list.length) { ctx.hitstop(0.02); ctx.shake(0.16, 0.06); }
      }
    },
    onEnd(ctx) { ctx.fx.gomuGatlingEnd(); },
  },
  {
    id: 'gomu.balloon', name: 'Gum-Gum Balloon', fruit: 'gomu', icon: 'shield', slot: 3,
    cost: 20, cooldown: 8.0, castTime: 0.34, activeTime: 2.6, recoverTime: 0.2,
    animState: CHANNEL, castPose: 'castGuard', tags: ['defensive', 'stance', 'reflect'],
    desc: 'Inflate. The next hit that lands is absorbed and thrown straight back, harder.',
    telegraph: { color: P.telegraphGuard, shape: 'self', time: 0.34 },
    onStart(ctx) {
      ctx.sys.guard = { absorb: true, stored: 0, attacker: null, mult: GOMU_RETURN_MULT };
      ctx.fx.gomuBalloon(ctx.self, 0);
      ctx.sound('fruit_gomu_inflate');
      ctx.notifyUse('balloon');
    },
    onUpdate(ctx) {
      const g = ctx.sys.guard;
      if (ctx.run.phase === 'windup') { ctx.fx.gomuBalloon(ctx.self, ctx.run.t / ctx.ability.castTime * 0.6); return; }
      ctx.fx.gomuBalloon(ctx.self, 1);
      if (g && !g.absorb) {
        // The hit has been eaten — fire it back along the incoming direction.
        const dmg = g.stored * g.mult;
        const targets = g.attacker ? [g.attacker] : ctx.inRadius(ctx.self.x, ctx.self.y + 1, ctx.self.z, 7);
        for (const t of targets) ctx.hit(t, { amount: dmg, kind: 'blunt', knock: 16, stun: 0.7 });
        ctx.fx.gomuRecoil(ctx.self);
        ctx.shake(0.9, 0.22);
        ctx.hitstop(0.1);
        ctx.sound('fruit_gomu_return');
        ctx.sys.guard = null;
        ctx.finish();
      }
    },
    onEnd(ctx) { ctx.sys.guard = null; ctx.fx.gomuBalloonEnd(); },
  },
];

const GOMU_REACH = 18;
const GOMU_FIST_OUT = 34;
const GOMU_FIST_BACK = 48;
const GOMU_GATLING_INTERVAL = 0.07;
const GOMU_RETURN_MULT = 1.8;

// ---------------------------------------------------------------------------
// MERA — flame. Space control and a real, exploitable weakness.
// ---------------------------------------------------------------------------

const MERA = [
  {
    id: 'mera.cone', name: 'Fire Fist', fruit: 'mera', icon: 'flame', slot: 1,
    cost: 22, cooldown: 3.2, castTime: 0.26, activeTime: 0.55, recoverTime: 0.24,
    animState: CAST_A, castPose: 'castCone', tags: ['ranged', 'burn', 'cone'],
    desc: 'A rolling wall of fire. Everything it touches keeps burning.',
    telegraph: { color: P.telegraphWarn, shape: 'cone', range: 11, angle: 0.55, time: 0.26 },
    canUse(ctx) { return ctx.sys.flameStrength > 0.15; },
    onStart(ctx) {
      const f = ctx.forward();
      ctx.run.data.dx = f.x; ctx.run.data.dz = f.z; ctx.run.data.hitSet = new Set();
      ctx.sound('fruit_mera_roar');
      ctx.notifyUse('fireFist');
    },
    onUpdate(ctx, dt) {
      if (ctx.run.phase !== 'active') return;
      const d = ctx.run.data;
      const k = clamp01(ctx.run.t / ctx.ability.activeTime);
      const reach = MERA_CONE_RANGE * ease.outQuad(k) * ctx.sys.flameStrength;
      ctx.fx.meraCone(ctx.self, d.dx, d.dz, reach, k);
      const list = ctx.enemies();
      for (const e of list) {
        if (d.hitSet.has(e)) continue;
        const p = ctx.posOf(e);
        const vx = p.x - ctx.self.x, vz = p.z - ctx.self.z;
        const dist = Math.hypot(vx, vz);
        if (dist > reach || dist < 0.001) continue;
        if ((vx / dist) * d.dx + (vz / dist) * d.dz < Math.cos(MERA_CONE_ANGLE)) continue;
        d.hitSet.add(e);
        ctx.hit(e, {
          amount: 26 * ctx.sys.flameStrength, kind: 'fire',
          knock: 4, burn: 4.0 * ctx.sys.flameStrength,
        });
      }
      // Fire spreads to what fire spreads to.
      ctx.sys.igniteAlong(ctx, ctx.self.x, ctx.self.z, d.dx, d.dz, reach, 1.4);
      if (k > 0.9) ctx.shake(0.25, 0.1);
    },
    onEnd(ctx) { ctx.fx.meraConeEnd(); },
  },
  {
    id: 'mera.pillar', name: 'Flame Pillar', fruit: 'mera', icon: 'flame', slot: 2,
    cost: 26, cooldown: 6.0, castTime: 0.32, activeTime: 0.6, recoverTime: 0.35,
    animState: CAST_B, castPose: 'castUppercut', tags: ['melee', 'burn', 'launcher', 'grounded'],
    desc: 'A column of fire erupts under the enemy in front of you and throws them up.',
    telegraph: { color: P.telegraphWarn, shape: 'circle', range: 4.2, time: 0.32 },
    canUse(ctx) { return ctx.sys.flameStrength > 0.15; },
    onStart(ctx) {
      const f = ctx.forward();
      const d = ctx.run.data;
      d.x = ctx.self.x + f.x * 3.0;
      d.z = ctx.self.z + f.z * 3.0;
      d.y = ctx.heightAt(d.x, d.z);
      d.fired = false;
      ctx.fx.telegraphCircle(d.x, d.y, d.z, 3.0, P.telegraphWarn, ctx.ability.castTime);
      ctx.notifyUse('flamePillar');
    },
    onUpdate(ctx) {
      const d = ctx.run.data;
      if (ctx.run.phase !== 'active') return;
      const k = clamp01(ctx.run.t / ctx.ability.activeTime);
      ctx.fx.meraPillar(d.x, d.y, d.z, k, ctx.sys.flameStrength);
      if (d.fired) return;
      d.fired = true;
      const list = ctx.inRadius(d.x, d.y + 2, d.z, 3.2);
      for (const e of list) {
        ctx.hit(e, {
          amount: 30 * ctx.sys.flameStrength, kind: 'fire',
          knockUp: 1, knock: 3, stun: 0.5, burn: 5.0 * ctx.sys.flameStrength,
        });
      }
      // The caster rides their own pillar a little — this is how mera opens air combos.
      ctx.impulse(0, MERA_PILLAR_SELF_LIFT, 0);
      ctx.sys.ignitePoint(ctx, d.x, d.z, 2.6);
      ctx.shake(0.7, 0.2);
      ctx.hitstop(list.length ? 0.08 : 0);
      ctx.sound('fruit_mera_pillar');
    },
    onEnd(ctx) { ctx.fx.meraPillarEnd(); },
  },
  {
    id: 'mera.ignite', name: 'Kindle', fruit: 'mera', icon: 'flame', slot: 3,
    cost: 18, cooldown: 4.5, castTime: 0.2, activeTime: 0.9, recoverTime: 0.2,
    animState: CHANNEL, castPose: 'castAura', tags: ['utility', 'terrain', 'burn'],
    desc: 'Set the world alight. Wood, thatch and oil burn away — doors become doorways.',
    telegraph: { color: P.telegraphWarn, shape: 'circle', range: 6, time: 0.2 },
    canUse(ctx) { return ctx.sys.flameStrength > 0.3; },
    onStart(ctx) {
      ctx.run.data.tick = 0;
      ctx.sound('fruit_mera_kindle');
      ctx.notifyUse('kindle');
    },
    onUpdate(ctx, dt) {
      if (ctx.run.phase !== 'active') return;
      const d = ctx.run.data;
      d.tick -= dt;
      const f = ctx.forward();
      const cx = ctx.self.x + f.x * 3.0, cz = ctx.self.z + f.z * 3.0;
      ctx.fx.meraKindle(cx, ctx.heightAt(cx, cz), cz, ctx.run.t / ctx.ability.activeTime);
      if (d.tick > 0) return;
      d.tick += 0.12;
      const burned = ctx.sys.burnBarriers(ctx, cx, cz, MERA_KINDLE_RADIUS);
      if (burned > 0) { ctx.shake(0.18, 0.08); ctx.sound('fruit_mera_crackle'); }
      for (const e of ctx.inRadius(cx, ctx.self.y + 1, cz, MERA_KINDLE_RADIUS)) {
        ctx.hit(e, { amount: 6, kind: 'fire', burn: 3.0 });
      }
    },
    onEnd(ctx) { ctx.fx.meraKindleEnd(); },
  },
];

const MERA_CONE_RANGE = 11;
const MERA_CONE_ANGLE = 0.55;
const MERA_PILLAR_SELF_LIFT = 5.0;
const MERA_KINDLE_RADIUS = 4.5;

// ---------------------------------------------------------------------------
// HIE — ice. Rewrites the floor.
// ---------------------------------------------------------------------------

const HIE = [
  {
    id: 'hie.freeze', name: 'Ice Age', fruit: 'hie', icon: 'snowflake', slot: 1,
    cost: 24, cooldown: 5.5, castTime: 0.3, activeTime: 0.35, recoverTime: 0.25,
    animState: CAST_A, castPose: 'castPoint', tags: ['ranged', 'control', 'freeze'],
    desc: 'Freeze one enemy solid. Frozen things shatter — hit them and see.',
    telegraph: { color: P.telegraphGuard, shape: 'line', range: 14, width: 1.6, time: 0.3 },
    onStart(ctx) {
      ctx.run.data.target = ctx.nearest(14, (e) => ctx.sys.aliveOf(e));
      ctx.run.data.fired = false;
      ctx.sound('fruit_hie_charge');
      ctx.notifyUse('iceAge');
    },
    onUpdate(ctx) {
      const d = ctx.run.data;
      if (ctx.run.phase !== 'active' || d.fired) return;
      d.fired = true;
      const t = d.target;
      if (t) {
        const p = ctx.posOf(t);
        ctx.hit(t, { amount: 14, kind: 'ice', freeze: HIE_FREEZE_SECONDS, slow: HIE_FREEZE_SECONDS });
        ctx.fx.hieEncase(p.x, p.y, p.z, HIE_FREEZE_SECONDS);
        ctx.sound('fruit_hie_freeze');
        ctx.shake(0.35, 0.14);
      } else {
        // No target: the beam still lands, and it freezes the ground it lands on.
        const f = ctx.forward();
        ctx.sys.freezeSurface(ctx, ctx.self.x + f.x * 6, ctx.self.z + f.z * 6, 3.0, HIE_SHEET_SECONDS);
        ctx.fx.hieGrow(ctx.self.x + f.x * 6, ctx.heightAt(ctx.self.x + f.x * 6, ctx.self.z + f.z * 6), ctx.self.z + f.z * 6, 3.0);
      }
    },
  },
  {
    id: 'hie.wall', name: 'Ice Wall', fruit: 'hie', icon: 'shield', slot: 2,
    cost: 20, cooldown: 7.0, castTime: 0.28, activeTime: 0.4, recoverTime: 0.22,
    animState: CAST_B, castPose: 'castRaise', tags: ['defensive', 'terrain', 'cover'],
    desc: 'Raise a wall of ice. It stops arrows and cannonballs, and it can be broken.',
    telegraph: { color: P.telegraphGuard, shape: 'line', range: 4, width: 6, time: 0.28 },
    onStart(ctx) {
      const f = ctx.forward();
      ctx.run.data.x = ctx.self.x + f.x * 3.2;
      ctx.run.data.z = ctx.self.z + f.z * 3.2;
      ctx.run.data.dx = -f.z; ctx.run.data.dz = f.x;
      ctx.run.data.built = false;
      ctx.notifyUse('iceWall');
    },
    onUpdate(ctx) {
      const d = ctx.run.data;
      if (ctx.run.phase !== 'active') return;
      const k = clamp01(ctx.run.t / ctx.ability.activeTime);
      ctx.fx.hieWall(d.x, ctx.heightAt(d.x, d.z), d.z, d.dx, d.dz, k);
      if (d.built) return;
      d.built = true;
      ctx.sys.buildIceWall(ctx, d.x, d.z, d.dx, d.dz, HIE_WALL_HALFLEN, HIE_WALL_HEIGHT);
      ctx.sound('fruit_hie_wall');
      ctx.shake(0.4, 0.16);
    },
  },
  {
    id: 'hie.spikes', name: 'Pheasant Beak', fruit: 'hie', icon: 'snowflake', slot: 3,
    cost: 22, cooldown: 4.0, castTime: 0.22, activeTime: 0.5, recoverTime: 0.25,
    animState: CAST_A, castPose: 'castSweep', tags: ['ranged', 'line', 'terrain'],
    desc: 'A line of spikes tears along the ground away from you, freezing what it clips.',
    telegraph: { color: P.telegraphWarn, shape: 'line', range: 16, width: 2, time: 0.22 },
    onStart(ctx) {
      const f = ctx.forward();
      ctx.run.data.dx = f.x; ctx.run.data.dz = f.z; ctx.run.data.reached = 0;
      ctx.run.data.hitSet = new Set();
      ctx.sound('fruit_hie_spikes');
      ctx.notifyUse('pheasantBeak');
    },
    onUpdate(ctx, dt) {
      if (ctx.run.phase !== 'active') return;
      const d = ctx.run.data;
      const prev = d.reached;
      d.reached = Math.min(HIE_SPIKE_RANGE, d.reached + HIE_SPIKE_SPEED * dt);
      const steps = Math.floor(d.reached / HIE_SPIKE_SPACING);
      const from = Math.floor(prev / HIE_SPIKE_SPACING);
      for (let i = from + 1; i <= steps; i++) {
        const x = ctx.self.x + d.dx * i * HIE_SPIKE_SPACING;
        const z = ctx.self.z + d.dz * i * HIE_SPIKE_SPACING;
        const y = ctx.heightAt(x, z);
        ctx.fx.hieSpike(x, y, z, 1.2 + (i % 3) * 0.55);
        ctx.sys.freezeSurface(ctx, x, z, 1.1, HIE_SHEET_SECONDS);
        for (const e of ctx.inRadius(x, y + 1, z, 1.6)) {
          if (d.hitSet.has(e)) continue;
          d.hitSet.add(e);
          ctx.hit(e, { amount: 18, kind: 'ice', knockUp: 1, knock: 2, freeze: 1.1, slow: 3 });
        }
      }
      if (d.reached >= HIE_SPIKE_RANGE) ctx.shake(0.3, 0.12);
    },
    onEnd(ctx) { ctx.fx.hieSpikeEnd(); },
  },
];

const HIE_FREEZE_SECONDS = 3.2;
const HIE_SHEET_SECONDS = 14;
const HIE_WALL_HALFLEN = 3;
const HIE_WALL_HEIGHT = 5;
const HIE_SPIKE_RANGE = 16;
const HIE_SPIKE_SPEED = 34;
const HIE_SPIKE_SPACING = 1.6;

// ---------------------------------------------------------------------------
// SUNA — sand. Being untouchable, until you are wet.
// ---------------------------------------------------------------------------

const SUNA = [
  {
    id: 'suna.ghost', name: 'Suna Suna Body', fruit: 'suna', icon: 'sandglass', slot: 1,
    cost: 15, drain: 12, cooldown: 6.0, castTime: 0.18, activeTime: 6.0, recoverTime: 0.2,
    animState: CHANNEL, castPose: 'castGuard', tags: ['defensive', 'stance', 'channel', 'phase'],
    desc: 'Become sand. Blades pass through you — until rain or seawater makes you mud.',
    telegraph: { color: P.telegraphGuard, shape: 'self', time: 0.18 },
    canUse(ctx) { return ctx.sys.sandIntegrity > 0.25; },
    onStart(ctx) {
      ctx.sys.phasing = true;
      ctx.fx.sunaGhost(ctx.self, 0);
      ctx.sound('fruit_suna_disperse');
      ctx.notifyUse('sandBody');
    },
    onUpdate(ctx, dt) {
      // The drawback is not a debuff icon: wetness eats the stance in real time.
      const wet = Math.max(ctx.wetness, ctx.rain * 0.8);
      if (wet > SUNA_WET_BREAK) {
        ctx.sys.phasing = false;
        ctx.toast('Soaked — the sand will not hold', 'bad');
        ctx.fx.sunaCollapse(ctx.self);
        ctx.sound('fruit_suna_fail');
        ctx.sys.runner.cancel('water', ctx);
        return;
      }
      ctx.sys.phasing = ctx.run.phase !== 'windup';
      ctx.fx.sunaGhost(ctx.self, clamp01(ctx.run.total / 0.4));
    },
    onEnd(ctx) { ctx.sys.phasing = false; ctx.fx.sunaGhostEnd(); },
  },
  {
    id: 'suna.storm', name: 'Desert Spada', fruit: 'suna', icon: 'sandglass', slot: 2,
    cost: 30, cooldown: 9.0, castTime: 0.4, activeTime: 2.4, recoverTime: 0.35,
    animState: CHANNEL, castPose: 'castAura', tags: ['aoe', 'control', 'blind', 'commit'],
    desc: 'A sandstorm around you. Blinded enemies lose their telegraphs and their footing.',
    telegraph: { color: P.telegraphWarn, shape: 'ring', range: 9, time: 0.4 },
    onStart(ctx) {
      ctx.run.data.tick = 0;
      ctx.sound('fruit_suna_storm');
      ctx.notifyUse('sandstorm');
    },
    onUpdate(ctx, dt) {
      if (ctx.run.phase !== 'active') return;
      const d = ctx.run.data;
      const k = clamp01(ctx.run.t / ctx.ability.activeTime);
      ctx.fx.sunaStorm(ctx.self, k, ctx.sys.sandIntegrity);
      d.tick -= dt;
      if (d.tick > 0) return;
      d.tick += 0.25;
      const r = lerp(3, SUNA_STORM_RADIUS, ease.outCubic(k));
      for (const e of ctx.inRadius(ctx.self.x, ctx.self.y + 1, ctx.self.z, r)) {
        ctx.hit(e, { amount: 4.5 * ctx.sys.sandIntegrity, kind: 'sand', blind: 2.2, slow: 2.2, knock: 0.6 });
      }
      ctx.shake(0.12, 0.2);
    },
    onEnd(ctx) { ctx.fx.sunaStormEnd(); },
  },
  {
    id: 'suna.drain', name: 'Ground Death', fruit: 'suna', icon: 'skull', slot: 3,
    cost: 16, cooldown: 3.5, castTime: 0.24, activeTime: 0.4, recoverTime: 0.3,
    animState: CAST_A, castPose: 'castPoint', tags: ['melee', 'dot', 'drain'],
    desc: 'Touch, and take the water out of them. It keeps hurting after you let go.',
    telegraph: { color: P.telegraphDanger, shape: 'circle', range: 3, time: 0.24 },
    onStart(ctx) { ctx.run.data.fired = false; ctx.notifyUse('groundDeath'); },
    onUpdate(ctx) {
      const d = ctx.run.data;
      if (ctx.run.phase !== 'active' || d.fired) return;
      d.fired = true;
      const f = ctx.forward();
      const px = ctx.self.x + f.x * 1.8, pz = ctx.self.z + f.z * 1.8;
      const list = ctx.inRadius(px, ctx.self.y + 1, pz, 2.4);
      for (const e of list) {
        ctx.hit(e, { amount: 12, kind: 'drain', dot: SUNA_DRAIN_SECONDS, slow: SUNA_DRAIN_SECONDS });
        ctx.fx.sunaDrain(ctx.posOf(e), ctx.self);
      }
      if (list.length) {
        ctx.hitstop(0.06);
        ctx.shake(0.3, 0.12);
        ctx.sound('fruit_suna_drain');
        // Draining a body is the one way suna dries itself out again.
        ctx.sys.dryOff(0.35 * list.length);
      }
      // The ground under the strike turns to loose sand.
      ctx.sys.desiccate(ctx, px, pz, 2.2);
    },
  },
];

const SUNA_WET_BREAK = 0.55;
const SUNA_STORM_RADIUS = 9;
const SUNA_DRAIN_SECONDS = 6;

// ---------------------------------------------------------------------------
// GURA — quake. The terrain is the weapon.
// ---------------------------------------------------------------------------

const GURA = [
  {
    id: 'gura.slam', name: 'Island Shaker', fruit: 'gura', icon: 'shockwave', slot: 1,
    cost: 28, cooldown: 6.5, castTime: 0.42, activeTime: 0.5, recoverTime: 0.45,
    animState: CAST_B, castPose: 'castSlam', tags: ['aoe', 'terrain', 'launcher', 'commit'],
    desc: 'Crack the ground open. Everything nearby goes up, and the crack stays.',
    telegraph: { color: P.telegraphDanger, shape: 'circle', range: 8, time: 0.42 },
    onStart(ctx) {
      ctx.run.data.fired = false;
      const y = ctx.heightAt(ctx.self.x, ctx.self.z);
      ctx.fx.telegraphCircle(ctx.self.x, y, ctx.self.z, 8, P.telegraphDanger, ctx.ability.castTime);
      // A visible hop before the slam so the wind-up reads from any camera angle.
      if (ctx.self.grounded) ctx.impulse(0, 4.2, 0);
      ctx.sound('fruit_gura_windup');
      ctx.notifyUse('islandShaker');
    },
    onUpdate(ctx) {
      const d = ctx.run.data;
      if (ctx.run.phase !== 'active' || d.fired) return;
      d.fired = true;
      const cx = ctx.self.x, cz = ctx.self.z;
      const cy = ctx.heightAt(cx, cz);
      ctx.setVel(ctx.self.vx * 0.2, -18, ctx.self.vz * 0.2);
      for (const e of ctx.inRadius(cx, cy + 1.5, cz, GURA_SLAM_RADIUS)) {
        const p = ctx.posOf(e);
        const dist = Math.hypot(p.x - cx, p.z - cz);
        const falloff = 1 - clamp01(dist / GURA_SLAM_RADIUS) * 0.6;
        ctx.hit(e, { amount: 42 * falloff, kind: 'quake', knockUp: 1, knock: 12 * falloff, stun: 0.9 });
      }
      ctx.sys.crackGround(ctx, cx, cz, GURA_SLAM_RADIUS * 0.55, 2);
      ctx.fx.guraRing(cx, cy, cz, GURA_SLAM_RADIUS, 0);
      ctx.fx.guraDecal(cx, cy, cz, GURA_SLAM_RADIUS * 0.7);
      ctx.shake(2.2, 0.5);
      ctx.hitstop(0.12);
      ctx.sound('fruit_gura_slam');
    },
    onEnd(ctx) { ctx.fx.guraRingEnd(); },
  },
  {
    id: 'gura.shockwave', name: 'Fault Line', fruit: 'gura', icon: 'shockwave', slot: 2,
    cost: 24, cooldown: 4.5, castTime: 0.3, activeTime: 1.0, recoverTime: 0.3,
    animState: CAST_A, castPose: 'castSweep', tags: ['ranged', 'line', 'terrain'],
    desc: 'A crack races away along the ground, throwing up everything it passes under.',
    telegraph: { color: P.telegraphDanger, shape: 'line', range: 26, width: 3, time: 0.3 },
    onStart(ctx) {
      const f = ctx.forward();
      ctx.run.data.dx = f.x; ctx.run.data.dz = f.z;
      ctx.run.data.reached = 0; ctx.run.data.hitSet = new Set();
      ctx.sound('fruit_gura_crack');
      ctx.notifyUse('faultLine');
    },
    onUpdate(ctx, dt) {
      if (ctx.run.phase !== 'active') return;
      const d = ctx.run.data;
      const prev = d.reached;
      d.reached = Math.min(GURA_WAVE_RANGE, d.reached + GURA_WAVE_SPEED * dt);
      const step = 2.0;
      for (let s = Math.floor(prev / step) + 1; s <= Math.floor(d.reached / step); s++) {
        const x = ctx.self.x + d.dx * s * step;
        const z = ctx.self.z + d.dz * s * step;
        const y = ctx.heightAt(x, z);
        ctx.fx.guraRing(x, y, z, 3.4, s / 12);
        ctx.sys.crackGround(ctx, x, z, 1.6, 1);
        for (const e of ctx.inRadius(x, y + 1.5, z, 3.0)) {
          if (d.hitSet.has(e)) continue;
          d.hitSet.add(e);
          ctx.hit(e, { amount: 26, kind: 'quake', knockUp: 1, knock: 8, stun: 0.55 });
        }
      }
      if (d.reached >= GURA_WAVE_RANGE) ctx.finish();
    },
  },
  {
    id: 'gura.seaquake', name: 'Sea Quake', fruit: 'gura', icon: 'anchor', slot: 3,
    cost: 45, cooldown: 18, castTime: 0.9, activeTime: 2.2, recoverTime: 0.6,
    animState: CAST_B, castPose: 'castRaise', tags: ['aoe', 'ultimate', 'uncancellable', 'sea'],
    desc: 'Punch the sea. The water rises in rings and every hull inside them pitches.',
    telegraph: { color: P.telegraphDanger, shape: 'ring', range: 40, time: 0.9 },
    onStart(ctx) {
      ctx.run.data.fired = false;
      ctx.sound('fruit_gura_charge');
      ctx.notifyUse('seaQuake');
    },
    onUpdate(ctx, dt) {
      const d = ctx.run.data;
      if (ctx.run.phase !== 'active') return;
      const k = clamp01(ctx.run.t / ctx.ability.activeTime);
      ctx.fx.guraSeaRings(ctx.self, k);
      if (!d.fired) {
        d.fired = true;
        ctx.sys.raiseSea(ctx, GURA_SEA_RADIUS, GURA_SEA_LIFT);
        ctx.shake(3.0, 1.4);
        ctx.hitstop(0.16);
        ctx.sound('fruit_gura_seaquake');
      }
      // The wave keeps hitting as the rings expand outward, not all at once.
      const r = lerp(6, GURA_SEA_RADIUS, k);
      for (const e of ctx.inRadius(ctx.self.x, ctx.self.y, ctx.self.z, r)) {
        const st = ctx.sys.statusOf(e);
        if (st.seaquake > 0) continue;
        st.seaquake = 3;
        ctx.hit(e, { amount: 34, kind: 'quake', knockUp: 1, knock: 14, stun: 1.2 });
      }
    },
    onEnd(ctx) { ctx.fx.guraSeaRingsEnd(); },
  },
];

const GURA_SLAM_RADIUS = 8;
const GURA_WAVE_RANGE = 26;
const GURA_WAVE_SPEED = 26;
const GURA_SEA_RADIUS = 40;
const GURA_SEA_LIFT = 3.5;

// ---------------------------------------------------------------------------
// ZUSHI — gravity. Move everything else instead of yourself.
// ---------------------------------------------------------------------------

const ZUSHI = [
  {
    id: 'zushi.pull', name: 'Attract', fruit: 'zushi', icon: 'gravity', slot: 1,
    cost: 20, cooldown: 5.0, castTime: 0.26, activeTime: 0.9, recoverTime: 0.25,
    animState: CAST_A, castPose: 'castPoint', tags: ['control', 'pull', 'grapple'],
    desc: 'Drag everything loose into one place. With nothing to drag, drag yourself instead.',
    telegraph: { color: P.telegraphGuard, shape: 'circle', range: 18, time: 0.26 },
    onStart(ctx) {
      const f = ctx.aim();
      const d = ctx.run.data;
      d.x = ctx.self.x + f.x * ZUSHI_PULL_RANGE * 0.6;
      d.y = ctx.self.y + 1.2 + f.y * ZUSHI_PULL_RANGE * 0.6;
      d.z = ctx.self.z + f.z * ZUSHI_PULL_RANGE * 0.6;
      d.list = ctx.inRadius(ctx.self.x, ctx.self.y + 1, ctx.self.z, ZUSHI_PULL_RANGE, []).slice(0, 12);
      d.ledge = d.list.length ? null : ctx.sys.findLedge(ctx, f, ZUSHI_PULL_RANGE);
      ctx.sound('fruit_zushi_pull');
      ctx.notifyUse('attract');
    },
    onUpdate(ctx, dt) {
      const d = ctx.run.data;
      if (ctx.run.phase !== 'active') return;
      ctx.fx.zushiWell(d.x, d.y, d.z, clamp01(ctx.run.t / ctx.ability.activeTime), ZUSHI_PULL_RANGE * 0.25);
      if (d.ledge) {
        // No crowd to gather: the well anchors on geometry and reels the player in instead.
        const vx = d.ledge.x - ctx.self.x, vy = d.ledge.y + 1.2 - ctx.self.y, vz = d.ledge.z - ctx.self.z;
        const len = Math.hypot(vx, vy, vz) || 1;
        ctx.setVel(vx / len * ZUSHI_REEL_SPEED, vy / len * ZUSHI_REEL_SPEED + 2, vz / len * ZUSHI_REEL_SPEED);
        if (len < 2.0) ctx.finish();
        return;
      }
      for (const e of d.list) {
        if (!ctx.sys.aliveOf(e)) continue;
        const p = ctx.posOf(e);
        const vx = d.x - p.x, vy = d.y - p.y, vz = d.z - p.z;
        const len = Math.hypot(vx, vy, vz) || 1;
        ctx.sys.pushTarget(e, vx / len * ZUSHI_PULL_ACC * dt, vy / len * ZUSHI_PULL_ACC * dt, vz / len * ZUSHI_PULL_ACC * dt);
        ctx.fx.zushiTether(p, d);
      }
    },
    onEnd(ctx) {
      const d = ctx.run.data;
      if (!d.ledge) for (const e of d.list || []) if (ctx.sys.aliveOf(e)) ctx.hit(e, { amount: 9, kind: 'gravity', stun: 0.4 });
      ctx.fx.zushiWellEnd();
    },
  },
  {
    id: 'zushi.crush', name: 'Weight of the World', fruit: 'zushi', icon: 'gravity', slot: 2,
    cost: 26, cooldown: 7.5, castTime: 0.34, activeTime: 1.6, recoverTime: 0.3,
    animState: CAST_B, castPose: 'castRaise', tags: ['control', 'aoe', 'stun'],
    desc: 'Multiply gravity in a circle. Everything inside is pinned to the ground.',
    telegraph: { color: P.telegraphDanger, shape: 'circle', range: 10, time: 0.34 },
    onStart(ctx) {
      const f = ctx.forward();
      const d = ctx.run.data;
      d.x = ctx.self.x + f.x * 4; d.z = ctx.self.z + f.z * 4;
      d.y = ctx.heightAt(d.x, d.z);
      d.applied = new Set();
      ctx.fx.telegraphCircle(d.x, d.y, d.z, ZUSHI_CRUSH_RADIUS, P.telegraphDanger, ctx.ability.castTime);
      ctx.notifyUse('crush');
    },
    onUpdate(ctx, dt) {
      const d = ctx.run.data;
      if (ctx.run.phase !== 'active') return;
      const k = clamp01(ctx.run.t / ctx.ability.activeTime);
      ctx.fx.zushiCrush(d.x, d.y, d.z, ZUSHI_CRUSH_RADIUS, k);
      for (const e of ctx.inRadius(d.x, d.y + 2, d.z, ZUSHI_CRUSH_RADIUS)) {
        ctx.sys.pushTarget(e, 0, -ZUSHI_CRUSH_ACC * dt, 0);
        if (d.applied.has(e)) continue;
        d.applied.add(e);
        ctx.hit(e, { amount: 20, kind: 'gravity', stun: ZUSHI_CRUSH_STUN, slow: ZUSHI_CRUSH_STUN });
      }
      if (k > 0.98) { ctx.shake(0.8, 0.2); ctx.sound('fruit_zushi_crush'); }
    },
    onEnd(ctx) { ctx.fx.zushiCrushEnd(); },
  },
  {
    id: 'zushi.meteor', name: 'Meteor', fruit: 'zushi', icon: 'star', slot: 3,
    cost: 30, cooldown: 8.0, castTime: 0.2, activeTime: 1.6, recoverTime: 0.4,
    animState: CAST_B, castPose: 'castSlam', tags: ['aerial', 'aoe', 'commit', 'launcher'],
    desc: 'From the air only: fall like a dropped planet and take the ground with you.',
    telegraph: { color: P.telegraphDanger, shape: 'circle', range: 7, time: 0.2 },
    canUse(ctx) { return !ctx.self.grounded; },
    onStart(ctx) {
      ctx.run.data.landed = false;
      ctx.setVel(ctx.self.vx * 0.35, 4.5, ctx.self.vz * 0.35); // the rise before the drop
      ctx.sound('fruit_zushi_rise');
      ctx.notifyUse('meteor');
    },
    onUpdate(ctx, dt) {
      const d = ctx.run.data;
      if (ctx.run.phase !== 'active' || d.landed) return;
      ctx.fx.zushiSphere(ctx.self, clamp01(ctx.run.t / 0.5));
      if (ctx.run.t < 0.25) return;
      ctx.setVel(ctx.self.vx * 0.9, -ZUSHI_METEOR_SPEED, ctx.self.vz * 0.9);
      const ground = ctx.heightAt(ctx.self.x, ctx.self.z);
      if (ctx.self.y > ground + 0.6 && !ctx.self.grounded) return;
      d.landed = true;
      const cx = ctx.self.x, cz = ctx.self.z, cy = ground;
      for (const e of ctx.inRadius(cx, cy + 1.5, cz, ZUSHI_METEOR_RADIUS)) {
        ctx.hit(e, { amount: 38, kind: 'gravity', knockUp: 1, knock: 10, stun: 0.8 });
      }
      ctx.fx.zushiImpact(cx, cy, cz, ZUSHI_METEOR_RADIUS);
      ctx.shake(1.6, 0.4);
      ctx.hitstop(0.11);
      ctx.sound('fruit_zushi_impact');
      ctx.finish();
    },
    onEnd(ctx) { ctx.fx.zushiSphereEnd(); },
  },
];

const ZUSHI_PULL_RANGE = 18;
const ZUSHI_PULL_ACC = 26;
const ZUSHI_REEL_SPEED = 22;
const ZUSHI_CRUSH_RADIUS = 10;
const ZUSHI_CRUSH_ACC = 34;
const ZUSHI_CRUSH_STUN = 1.4;
const ZUSHI_METEOR_SPEED = 42;
const ZUSHI_METEOR_RADIUS = 7;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** All eighteen abilities, in fruit order then slot order. @type {ReadonlyArray<Ability>} */
export const ABILITIES = Object.freeze(
  [].concat(GOMU, MERA, HIE, SUNA, GURA, ZUSHI).map((d) => new Ability(d)),
);

/** @type {Map<string, Ability>} */
export const ABILITY_BY_ID = new Map(ABILITIES.map((a) => [a.id, a]));

/** @type {Map<string, Ability[]>} fruit id -> its three abilities, slot 1..3 */
export const ABILITIES_BY_FRUIT = (() => {
  const m = new Map();
  for (const a of ABILITIES) {
    if (!m.has(a.fruit)) m.set(a.fruit, []);
    m.get(a.fruit).push(a);
  }
  for (const list of m.values()) list.sort((x, y) => x.slot - y.slot);
  return m;
})();

/**
 * The three abilities of one fruit, ordered by slot.
 * @param {string} fruitId
 * @returns {Ability[]}
 */
export function abilitiesFor(fruitId) {
  return ABILITIES_BY_FRUIT.get(fruitId) || [];
}
