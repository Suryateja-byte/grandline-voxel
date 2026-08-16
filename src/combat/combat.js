// The combat facade. Everything in cluster C is reachable from here, and `applyHit` is the only
// way anything in the game takes damage (ARCHITECTURE §5).
//
// Responsibilities, in step order:
//   1. drive the player's attacks / block / dodge from intents
//   2. run enemy perception, AI states and attack scheduling under the aggression budget
//   3. spawn and resolve hitboxes
//   4. integrate projectiles
//   5. tick statuses and damage over time
//   6. fire feedback (hitstop, shake, flash, knockback, sound) on every landed hit
//   7. publish telegraph decals, HUD state and quest events
//
// The one rule that keeps this file honest: an enemy CANNOT start an attack except by starting a
// telegraph, and the hitbox is spawned from the telegraph's completion. There is no code path
// that produces damage without a wind-up the player could have read.

import { Rng } from '../core/rng.js';
import { clamp, clamp01, TAU } from '../core/math.js';
import { P } from '../gen/palette.js';
import {
  PhysicsSystem, sweepBody, GRAVITY, TERMINAL_V, applyKnockback,
} from '../core/physics.js';
import {
  HitboxPool, SHAPE, TAG, ELEMENT, makeHit, resolveHitbox, orientHit,
  shapeArc, shapeSphere, shapeBox, shapeSweep, sweepSamplesFor,
} from './hitbox.js';
import { createTelegraphSystem, hudClass, DANGER } from './telegraph.js';
import {
  initCombatant, resolveDamage, makeOutcome, stepStatus, canAct,
  grantIframes, notifyDefeat, notifyDamageTaken, DODGE_IFRAMES, PARRY_STAGGER,
} from './damage.js';
import {
  Enemy, STATE, MOVE_SHAPE, ENEMY_ARCHETYPES, ENEMY_KIND_IDS, archetype,
  AggressionBank, desiredVelocity, chooseReposition,
} from '../entity/enemy.js';

/**
 * The player's move set. No telegraphs — the player's wind-up IS the animation, and the player
 * already knows what they pressed. What they DO need is a legible commitment: every move has a
 * recovery the enemy AI is explicitly built to punish.
 */
export const PLAYER_MOVES = Object.freeze({
  light1: {
    id: 'light1', windup: 0.11, active: 0.09, recovery: 0.18, next: 'light2', window: 0.42,
    damage: 12, poise: 14, knockback: 3.0, launch: 0, hitstop: 0.05, stamina: 6,
    reach: 2.5, halfAngle: 0.95, advance: 1.1, fxKind: 'slash', sfx: 'swing_light',
  },
  light2: {
    id: 'light2', windup: 0.10, active: 0.09, recovery: 0.20, next: 'light3', window: 0.44,
    damage: 13, poise: 16, knockback: 3.4, launch: 0, hitstop: 0.055, stamina: 6,
    reach: 2.6, halfAngle: 1.15, advance: 1.2, fxKind: 'slash', sfx: 'swing_light',
  },
  light3: {
    id: 'light3', windup: 0.16, active: 0.12, recovery: 0.38, next: null, window: 0,
    damage: 22, poise: 34, knockback: 7.0, launch: 1.6, hitstop: 0.08, stamina: 10,
    reach: 3.0, halfAngle: 1.35, advance: 1.6, fxKind: 'slash', sfx: 'swing_heavy',
  },
  heavy: {
    id: 'heavy', windup: 0.34, active: 0.14, recovery: 0.46, next: null, window: 0,
    damage: 32, poise: 60, knockback: 9.0, launch: 2.4, hitstop: 0.10, stamina: 18,
    reach: 3.2, halfAngle: 1.05, advance: 1.9, fxKind: 'slash', sfx: 'swing_heavy',
    guardBreak: true,
  },
});

/** Team ids. 1 = player and crew, 2 = hostiles, 3 = neutral. */
export const TEAM = Object.freeze({ PLAYER: 1, ENEMY: 2, NEUTRAL: 3 });

/**
 * Quest/world vocabulary -> combat archetype. The world, ship and quest layers name enemies
 * with the ENEMY_KINDS list in quest/quests.js (plus a few legacy scenario names); combat's
 * behaviour archetypes are the shorter ENEMY_ARCHETYPES table. This is the input-side bridge —
 * the archetypes' own `questKind` field is the output-side one. Biome flavours map onto the
 * archetype whose RHYTHM matches (a frost wolf lunges like a knifer, a forge wraith soaks and
 * slams like a brute); their identity is preserved in `questKind` for quests and bounty.
 */
export const KIND_ALIASES = Object.freeze({
  thug_brute: 'brute',
  marine_grunt: 'marine_rifle',
  marine_recruit: 'marine_rifle',
  marine_officer: 'captain',
  marine_elite: 'admiral',
  jungle_stalker: 'fishman',
  frost_wolf: 'knifer',
  ash_hound: 'knifer',
  forge_wraith: 'brute',
  dune_bandit: 'bomber',
  mirage_shade: 'knifer',
  terrace_duelist: 'knifer',
  blossom_ronin: 'brute',
  bandit: 'thug',
  marine: 'marine_rifle',
});

/**
 * The system.
 */
export class CombatSystem {
  /**
   * @param {object} app
   * @param {{seed?:number, maxAttackers?:number}} [opts]
   */
  constructor(app, opts = {}) {
    this.app = app;
    this.seed = (opts.seed !== undefined ? opts.seed : (app && app.seed) || 1) >>> 0;
    this.rng = Rng.fromName(this.seed, 'combat');

    // Physics: use the registered system when there is one, otherwise own a private instance so
    // combat is usable (and testable) before src/game.js wires the world.
    this.physics = (app && app.physics) || new PhysicsSystem(app);
    this._ownsPhysics = !(app && app.physics);

    this.telegraphs = (app && app.telegraphs) || createTelegraphSystem(app);
    this._ownsTelegraphs = !(app && app.telegraphs);

    this.hitboxes = new HitboxPool(64);

    /** @type {Enemy[]} */
    this.enemies = [];
    /** @type {object[]} everything that can be hit, including the player. */
    this.combatants = [];

    this.bank = new AggressionBank(opts.maxAttackers || 2);

    // Actor ids are handed out from HERE, not from a module counter. An enemy's RNG stream is
    // derived from its id, so a process-global counter would make the second fight in a session
    // diverge from the first while each one looked internally consistent. Starting at 100 leaves
    // room for the player and crew, which the player system assigns from the low numbers.
    this._actorSeq = 100;

    // --- pooled scratch. Nothing below is ever reallocated. ---
    this._outcome = makeOutcome();
    this._hitPool = new Array(24);
    for (let i = 0; i < 24; i++) this._hitPool[i] = makeHit();
    this._hitNext = 0;
    this._dotHit = makeHit();
    // One hit payload per projectile slot. A rifle round is in flight for up to 3.5 s; a
    // shared round-robin pool would wrap under it and the round would land carrying some
    // later attack numbers.
    this._projHits = new Array(this.physics.projectiles.capacity);
    for (let i = 0; i < this._projHits.length; i++) this._projHits[i] = makeHit();
    // The single argument object handed to fx.impact(). fx.impact takes an options object
    // because that is the readable API, but building a fresh literal (plus two coordinate
    // arrays) on every landed hit is three allocations in the hit path. One reused object
    // gives the same call site and none of the garbage.
    this._fxArgs = {
      pos: [0, 0, 0], dir: [0, 0, 0], kind: 'slash', strength: 1,
      target: null, damage: 0, crit: false, hitstop: 0, shake: 0,
    };
    this._targets = [];
    this._legal = [];
    this._vel = { x: 0, z: 0 };
    this._query = [];
    this._ray = {};
    // Bound predicates, built once. A closure created inside _stepHitboxes would be an
    // allocation per hitbox per step — the exact thing the hit path is not allowed to do.
    this._filterTeam = 0;
    this._targetFilter = (a) => this._isTarget(a, this._filterTeam);
    this._projFilter = (p, a) => this._isTarget(a, p.team);

    // --- harness-visible state (ARCHITECTURE §9) ---
    /** True while any hostile is aware of the player. */
    this.active = false;
    /** Monotone counter of encounters won. A boolean cannot express "won another one". */
    this.victories = 0;
    /** Enemies defeated, ever. */
    this.kills = 0;

    /** @type {object|null} current encounter record */
    this.encounter = null;
    this._encounterSeq = 0;

    this.stats = { enemies: 0, hitboxes: 0, hits: 0, attacksStarted: 0, telegraphsShown: 0 };

    // Player attack state lives here rather than on the player, because the player module may
    // not exist yet and because "what is currently swinging" is combat's business.
    this.playerAttack = {
      move: null, phase: '', t: 0, hitbox: null,
      comboWindow: 0, chainNext: null, trail: null,
    };
    this.playerDodge = 0;
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /** Get a pooled Hit. Round-robin; 24 is far more than can be in flight in one step. */
  _hit() {
    const h = this._hitPool[this._hitNext];
    this._hitNext = (this._hitNext + 1) % this._hitPool.length;
    return h;
  }

  /** The FX system, or a no-op stand-in so combat runs headless. */
  get fx() { return (this.app && this.app.fx) || NULL_FX; }

  /** The player actor, or null. */
  get player() { return (this.app && this.app.player) || null; }

  /**
   * Register any actor as a combatant. The player system calls this once on spawn; enemies do it
   * themselves. Idempotent.
   * @param {object} a
   * @param {object} [stats] passed to initCombatant when the actor is not already one
   */
  register(a, stats) {
    if (!a) return a;
    if (a.maxHp === undefined) {
      initCombatant(a, stats);
    } else if (a.status === undefined) {
      // An actor that already owns its vitals (the Player) still needs the transient combat
      // fields (poise, status, resist, iframes...). Seed them from what it has so nothing
      // authored is clobbered.
      initCombatant(a, Object.assign({
        maxHp: a.maxHp, hp: a.hp, maxStamina: a.maxStamina,
      }, stats));
    }
    if (this.combatants.indexOf(a) < 0) this.combatants.push(a);
    this.physics.addActor(a);
    return a;
  }

  unregister(a) {
    const i = this.combatants.indexOf(a);
    if (i >= 0) this.combatants.splice(i, 1);
    this.physics.removeActor(a);
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  /**
   * Spawn an enemy.
   * @param {string} kind an id from ENEMY_ARCHETYPES, or a quest-vocabulary kind from
   *   quests.js ENEMY_KINDS (world/ship/scenario spawners use those names) — see KIND_ALIASES.
   * @param {number} x
   * @param {number} y feet
   * @param {number} z
   * @param {number} [tier] 1..4
   * @returns {Enemy}
   */
  spawnEnemy(kind, x, y, z, tier = 1) {
    // Resolve the quest/world vocabulary onto a combat archetype, keeping the requested kind
    // as the enemy's questKind so defeat notifications still speak the quest vocabulary.
    const archKind = ENEMY_ARCHETYPES[kind] ? kind : KIND_ALIASES[kind] || null;
    if (!archKind) console.warn('[combat] unknown enemy kind "' + kind + '" — spawning a thug');
    // Ground the spawn. Callers pass whatever y they have — often 0 — and an enemy buried
    // inside terrain fails every line-of-sight test silently: 13 thugs stood in a camp at
    // sea level under 10 m of rock, patrolling forever while the player walked over them.
    const w = this.app && this.app.world;
    if (w && w.heightAt) {
      const gy = w.heightAt(x, z);
      if (Number.isFinite(gy) && (y === undefined || y < gy)) y = gy + 0.05;
    }
    const e = new Enemy(archKind || 'thug', x, y, z, tier, this.seed, ++this._actorSeq);
    if (!ENEMY_ARCHETYPES[kind] && typeof kind === 'string') e.questKind = kind;
    e.team = TEAM.ENEMY;
    e.setState(STATE.PATROL);
    this.enemies.push(e);
    this.combatants.push(e);
    this.physics.addActor(e);
    this.stats.enemies = this.enemies.length;
    return e;
  }

  /**
   * Harness hook: drop a ring of enemies around a point (ARCHITECTURE §9, profile scenarios).
   * @param {{kind?:string, count?:number, around?:number[], radius?:number, tier?:number,
   *          points?:Array<{kind?:string,x:number,y?:number,z:number}>}} o
   *   `points` (the ship's validated deck points, dock.js) wins over the ring when present.
   * @returns {Enemy[]}
   */
  spawnWave(o = {}) {
    const kind = o.kind || 'thug';
    const count = o.count !== undefined ? o.count : 3;
    const cx = o.around ? o.around[0] : 0;
    const cz = o.around ? o.around[1] : 0;
    const r = o.radius !== undefined ? o.radius : 7;
    const tier = o.tier || 1;
    const out = [];
    if (Array.isArray(o.points) && o.points.length) {
      for (const pt of o.points) {
        const y = pt.y !== undefined ? pt.y : this.physics.groundAt(pt.x, pt.z);
        out.push(this.spawnEnemy(pt.kind || kind, pt.x, y, pt.z, tier));
      }
      return out;
    }
    for (let i = 0; i < count; i++) {
      // A fixed ring, offset by a seeded phase: repeatable across runs, not stacked.
      const a = (i / count) * TAU + this.rng.f() * 0.6;
      const x = cx + Math.sin(a) * r;
      const z = cz + Math.cos(a) * r;
      const y = this.physics.groundAt(x, z);
      out.push(this.spawnEnemy(kind, x, y, z, tier));
    }
    return out;
  }

  /**
   * Harness hook: spawn a boss.
   * @param {{at?:number[], tier?:number, kind?:string, id?:string, name?:string}} o
   * @returns {Enemy}
   */
  spawnBoss(o = {}) {
    const kind = o.kind || (o.tier && o.tier >= 4 ? 'admiral' : 'captain');
    const x = o.at ? o.at[0] : 0;
    const z = o.at ? o.at[1] : 0;
    const y = this.physics.groundAt(x, z);
    const e = this.spawnEnemy(kind, x, y, z, o.tier || (kind === 'admiral' ? 4 : 3));
    e.bossId = o.id || null;
    if (o.name) e.name = o.name;
    e.named = true;
    return e;
  }

  /** Every live enemy. The array is owned by combat; treat it as read-only. */
  activeEnemies() { return this.enemies; }

  /**
   * The nearest hostile that is aware of the player, in the shape the HUD target bar wants.
   * Returns null when nothing is hunting you — the target bar must vanish, not show zeroes.
   */
  nearestThreat() {
    const p = this.player;
    if (!p) return null;
    let best = null, bestD = 1e9;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.dead || e.state === STATE.IDLE || e.state === STATE.PATROL) continue;
      const d = e.distTo(p.x, p.z);
      if (d < bestD) { bestD = d; best = e; }
    }
    if (!best) return null;
    const tel = this.telegraphs.forActor(best);
    return {
      name: best.name,
      hp: best.hp,
      maxHp: best.maxHp,
      tier: best.tier,
      dist: bestD,
      actor: best,
      telegraph: tel ? { kind: hudClass(tel.spec.danger), t: tel.t, label: tel.spec.label } : null,
    };
  }

  // -------------------------------------------------------------------------
  // Encounters
  // -------------------------------------------------------------------------

  /**
   * Start an authored encounter.
   *
   * @param {string} id e.g. 'shellsCove.camp1'
   * @param {object} spec
   *   { center:[x,z], radius, waves:[{kind, count, tier, delay}], boss:{kind,id,name,tier},
   *     arena, music }
   * @returns {object} the encounter record
   */
  startEncounter(id, spec = {}) {
    const rec = {
      id,
      seq: ++this._encounterSeq,
      /** The fightId quest objectives key off (ARCHITECTURE §9). */
      fightId: `${id}#${this._encounterSeq}`,
      spec,
      wave: -1,
      waveT: 0,
      /** @type {Enemy[]} */
      spawned: [],
      state: 'running',
      damageTaken: false,
      startedAt: this._simTime(),
    };
    this.encounter = rec;
    this._nextWave();
    return rec;
  }

  /** The encounter view every other system reads. Never returns a partially-built object. */
  encounterState() {
    const rec = this.encounter;
    if (!rec) {
      return {
        id: null, active: false, fightId: null, wave: 0, waves: 0,
        alive: 0, total: 0, victories: this.victories, state: 'idle',
      };
    }
    let alive = 0;
    for (let i = 0; i < rec.spawned.length; i++) if (!rec.spawned[i].dead) alive++;
    return {
      id: rec.id,
      active: rec.state === 'running',
      fightId: rec.fightId,
      wave: rec.wave + 1,
      waves: rec.spec.waves ? rec.spec.waves.length : 1,
      alive,
      total: rec.spawned.length,
      victories: this.victories,
      state: rec.state,
      damageTaken: rec.damageTaken,
    };
  }

  /** Abandon the current encounter without counting a victory. */
  endEncounter(won) {
    const rec = this.encounter;
    if (!rec) return;
    rec.state = won ? 'won' : 'abandoned';
    if (won) this.victories++;
    this.encounter = null;
  }

  _nextWave() {
    const rec = this.encounter;
    if (!rec) return;
    const waves = rec.spec.waves || [];
    rec.wave++;
    if (rec.wave >= waves.length) {
      if (rec.spec.boss && !rec.bossSpawned) {
        rec.bossSpawned = true;
        const b = rec.spec.boss;
        const c = rec.spec.center || [0, 0];
        const boss = this.spawnBoss({
          at: c, kind: b.kind, id: b.id, name: b.name, tier: b.tier || 3,
        });
        rec.spawned.push(boss);
        this.fx.addShake(0.3);
        return;
      }
      rec.state = 'won';
      this.victories++;
      this.encounter = null;
      return;
    }
    const w = waves[rec.wave];
    const c = rec.spec.center || [0, 0];
    const list = this.spawnWave({
      kind: w.kind, count: w.count, around: c,
      radius: rec.spec.radius || 8, tier: w.tier || 1,
    });
    for (let i = 0; i < list.length; i++) rec.spawned.push(list[i]);
  }

  // -------------------------------------------------------------------------
  // The one damage entry point
  // -------------------------------------------------------------------------

  /**
   * Apply a hit. THE only way anything takes damage anywhere in the game.
   *
   * @param {object} target
   * @param {import('./hitbox.js').Hit} hit
   * @returns {object} the pooled outcome — read it before the next applyHit call
   */
  applyHit(target, hit) {
    const app = this.app;
    // Normalise every incoming hit through makeHit(). applyHit is the one door into damage and
    // it is called from combat, fruit powers, the ship, the world and the weather — producers
    // that mostly build a plain object literal. A missing field there is silently `undefined`,
    // and `hp -= undefined` is NaN, which propagates forever and never throws. That exact bug
    // put the player at NaN health on the first step of every session. Defaulting here kills
    // the whole class rather than one instance of it.
    if (hit && (hit.damage === undefined || hit.poise === undefined || hit.knockback === undefined)) {
      hit = makeHit(hit);
    }
    const bonuses = this._bonuses();
    const o = resolveDamage(target, hit, {
      rng: this.rng,
      simTime: this._simTime(),
      outcome: this._outcome,
      bonuses,
    });
    if (!o.connected) {
      if (o.dodged) {
        // A dodged hit still gets a whisper of feedback: without it, a perfect dodge is
        // indistinguishable from a whiffed attack and the player never learns the timing.
        this._impact('block', target.x, target.y + (target.height || 1.8) * 0.6, target.z,
          hit.dirX, hit.dirZ, 0.25, null, 0, false, 0, 0.03);
        this._sfx('dodge_woosh', target.x, target.y, target.z);
      }
      return o;
    }
    this.stats.hits++;

    // --- parry: the attacker eats the consequences ---------------------------
    if (o.parried) {
      const atk = hit.source;
      if (atk) {
        atk.stagger = Math.max(atk.stagger || 0, PARRY_STAGGER);
        atk.poise = atk.maxPoise !== undefined ? atk.maxPoise : atk.poise;
        this.telegraphs.cancelFor(atk);
        this._releaseAttack(atk, true);
        this.fx.setFlash(atk, P.parrySpark, 1);
      }
      this._impact('parry', hit.px, hit.py, hit.pz, hit.dirX, hit.dirZ,
        1.4, target, 0, false, o.hitstop, o.shake);
      this._sfx('parry', target.x, target.y, target.z);
      return o;
    }

    // --- knockback -----------------------------------------------------------
    if (hit.knockback !== 0 || hit.launch !== 0) {
      const scale = o.blocked ? 0.35 : 1;
      applyKnockback(target, hit.dirX, hit.dirZ, hit.knockback * scale, hit.launch * scale);
    }

    // --- feedback ------------------------------------------------------------
    this._impact(
      o.blocked ? 'block' : (o.shatter ? 'frost' : hit.fxKind),
      hit.px, hit.py, hit.pz, hit.dirX, hit.dirZ,
      clamp(o.damage / 22, 0.3, 2.2), target,
      o.blocked ? 0 : o.damage, o.crit, o.hitstop, o.shake);
    if (o.guardBroken) {
      this._sfx('guard_break', target.x, target.y, target.z);
      this._impact('blunt', target.x, target.y + 1.2, target.z, hit.dirX, hit.dirZ,
        1.6, null, 0, false, 0.07, 0.26);
    } else if (o.blocked) {
      this._sfx('block', target.x, target.y, target.z);
    } else if (o.crit) {
      this._sfx('hit_crit', target.x, target.y, target.z);
    } else {
      this._sfx(target.armoured ? 'hit_armor' : 'hit_flesh', target.x, target.y, target.z);
    }

    // Interrupting a wind-up cancels its telegraph, so the mark on the ground never outlives the
    // attack it promised.
    if (o.staggered || o.guardBroken) {
      this.telegraphs.cancelFor(target);
      this._releaseAttack(target, true);
    }

    // --- quest / encounter bookkeeping --------------------------------------
    const p = this.player;
    if (target === p) {
      if (this.encounter) this.encounter.damageTaken = true;
      notifyDamageTaken(app, this.encounter ? this.encounter.fightId : null);
      if (app && app.post) app.post.damage = Math.min(1, (app.post.damage || 0) + o.damage / 60);
    }

    if (o.killed) this._onDeath(target, hit);
    return o;
  }

  /**
   * Fire feedback through the one FX entry point, without allocating.
   * @param {string} kind fx flavour
   * @param {number} px impact point
   * @param {number} py
   * @param {number} pz
   * @param {number} dx impact direction (attacker -> target), XZ
   * @param {number} dz
   * @param {number} strength 0..2.5
   * @param {object|null} target struck actor, for the white flash
   * @param {number} damage 0 to suppress the damage number
   * @param {boolean} crit
   * @param {number} hitstop seconds
   * @param {number} shake trauma 0..1
   */
  _impact(kind, px, py, pz, dx, dz, strength, target, damage, crit, hitstop, shake) {
    const a = this._fxArgs;
    a.pos[0] = px; a.pos[1] = py; a.pos[2] = pz;
    a.dir[0] = dx; a.dir[1] = 0; a.dir[2] = dz;
    a.kind = kind;
    a.strength = strength;
    a.target = target || null;
    a.damage = damage;
    a.crit = crit;
    a.hitstop = hitstop;
    a.shake = shake;
    this.fx.impact(a);
  }

  /**
   * Borrow a pooled Hit for an ad-hoc damage source (fruit powers, lava, drowning, fall
   * damage). Fill it and hand it straight to applyHit; do not keep the reference.
   * @returns {import('./hitbox.js').Hit}
   */
  borrowHit() { return this._hit(); }

  /** Quest crew bonuses, or null. Read every step; the quest layer caches internally. */
  _bonuses() {
    const q = this.app && (this.app.quests || this.app.quest);
    if (q && typeof q.activeBonuses === 'function') return q.activeBonuses();
    return null;
  }

  _simTime() {
    return this.app && this.app.clock ? this.app.clock.simTime : this._t || 0;
  }

  _sfx(name, x, y, z) {
    const a = this.app && this.app.audio;
    if (!a) return;
    if (typeof a.playAt === 'function') a.playAt(name, x, y, z);
    else if (typeof a.play === 'function') a.play(name);
  }

  /** Handle a defeat: rewards, quest events, FX, and the start of the dissolve. */
  _onDeath(target, hit) {
    target.dead = true;
    target.deathT = 0;
    this.telegraphs.cancelFor(target);
    this._releaseAttack(target, true);
    this.bank.release(target);

    const isEnemy = this.enemies.indexOf(target) >= 0;
    if (isEnemy) {
      this.kills++;
      const app = this.app;
      notifyDefeat(app, target, this.encounter ? this.encounter.fightId : null);
      const q = app && (app.quests || app.quest);
      if (q) {
        if (typeof q.addXp === 'function') q.addXp(target.arch.xp * target.tier);
        if (typeof q.addBerries === 'function') q.addBerries(target.arch.berries * target.tier);
      }
      this._sfx('death_enemy', target.x, target.y, target.z);
      this._impact('slash', target.x, target.y + (target.height || 1.8) * 0.55, target.z,
        hit ? hit.dirX : 0, hit ? hit.dirZ : 1, 1.5, null, 0, false, 0.09, 0.18);
    } else if (target === this.player) {
      this._sfx('death_player', target.x, target.y, target.z);
      this.fx.addShake(0.6);
    }
  }

  // -------------------------------------------------------------------------
  // Attacks
  // -------------------------------------------------------------------------

  /**
   * Configure a pooled hitbox for a move and make it live.
   * @param {object} owner
   * @param {object} m the move (enemy move or PLAYER_MOVES entry)
   * @param {number} team the owner's team
   * @returns {object|null} the hitbox
   */
  _spawnHitbox(owner, m, team) {
    const shape = m.shape || MOVE_SHAPE.SWEEP;
    const dirX = Math.sin(owner.yaw || 0), dirZ = Math.cos(owner.yaw || 0);
    // Weapon path height: chest height, CAPPED at 2 m above the feet. Combat's capsules are
    // authored at human scale (enemy heights 1.7–2.6), while rendered characters are voxel
    // scale (4.25 m ref) — uncapped, the player's sweep rides at 2.3 m and passes clean over
    // every standard enemy's head, so no melee swing can ever connect.
    const hy = owner.y + Math.min(2.0, (owner.height || 1.8) * 0.55);
    let hb;

    if (shape === MOVE_SHAPE.PROJECTILE) {
      this._fireProjectile(owner, m, team, dirX, dirZ);
      return null;
    }

    if (shape === MOVE_SHAPE.SPHERE) {
      hb = this.hitboxes.acquire(SHAPE.SPHERE);
      shapeSphere(hb, owner.x + dirX * (m.advance || 0), hy, owner.z + dirZ * (m.advance || 0), m.reach);
      hb.y0 = owner.y - 0.4;
      hb.y1 = owner.y + (owner.height || 1.8) + 0.6;
    } else if (shape === MOVE_SHAPE.LINE) {
      hb = this.hitboxes.acquire(SHAPE.BOX);
      shapeBox(hb, owner.x + dirX * m.reach * 0.5, hy, owner.z + dirZ * m.reach * 0.5,
        dirX, dirZ, m.width * 0.5, m.reach * 0.5,
        owner.y - 0.2, owner.y + (owner.height || 1.8) + 0.3);
    } else if (shape === MOVE_SHAPE.ARC) {
      hb = this.hitboxes.acquire(SHAPE.ARC);
      shapeArc(hb, owner.x, hy, owner.z, dirX, dirZ, m.reach, m.halfAngle,
        owner.y - 0.3, owner.y + (owner.height || 1.8) + 0.4);
    } else {
      // SWEEP: a weapon path. The endpoints are advanced every step so a fast swing is sampled
      // along its whole arc and cannot pass through a target between frames.
      const half = m.halfAngle !== undefined ? m.halfAngle : 0.9;
      const a0 = Math.atan2(dirX, dirZ) - half;
      const r = m.reach;
      const path = 2 * half * r;
      hb = this.hitboxes.acquire(SHAPE.SWEEP);
      shapeSweep(hb,
        owner.x + Math.sin(a0) * r * 0.25, hy, owner.z + Math.cos(a0) * r * 0.25,
        owner.x + Math.sin(a0) * r, hy, owner.z + Math.cos(a0) * r,
        Math.max(0.28, (m.width || 0.7) * 0.5), sweepSamplesFor(path, 0.4));
      hb.y0 = owner.y - 0.25;
      hb.y1 = owner.y + (owner.height || 1.8) + 0.45;
      hb._sweepHalf = half;
      hb._sweepReach = r;
      hb._sweepBase = Math.atan2(dirX, dirZ);
    }

    hb.duration = m.active;
    hb.dirX = dirX; hb.dirZ = dirZ;
    hb.team = team;
    hb.source = owner;

    // The hitbox slot owns its payload — see Hitbox.ownHit.
    const h = hb.ownHit;
    h.damage = m.damage;
    h.poise = m.poise;
    h.knockback = m.knockback;
    h.launch = m.launch || 0;
    h.hitstop = m.hitstop;
    h.element = m.element || ELEMENT.NONE;
    h.crit = false;
    h.critChance = owner === this.player ? 0.10 : 0.05;
    h.critMult = 1.85;
    h.source = owner;
    h.blockable = m.blockable !== undefined ? m.blockable : 1;
    h.guardCost = m.guardCost !== undefined ? m.guardCost : 12;
    h.fxKind = m.fxKind || 'slash';
    h.tags.length = 0;
    const tags = m.tags || [TAG.MELEE];
    for (let i = 0; i < tags.length; i++) h.tags.push(tags[i]);
    if (m.guardBreak && h.tags.indexOf(TAG.GUARD_BREAK) < 0) h.tags.push(TAG.GUARD_BREAK);
    hb.hit = h;

    // Weapon trail: the visual record of the arc that just swept.
    if (shape === MOVE_SHAPE.SWEEP || shape === MOVE_SHAPE.ARC) {
      this.fx.slashArc(owner.x, hy, owner.z, dirX, dirZ, m.reach,
        m.halfAngle !== undefined ? m.halfAngle : 0.9,
        owner === this.player ? P.hitFlash : P.telegraphWarn, 1);
    }
    this.stats.hitboxes = this.hitboxes.live.length;
    return hb;
  }

  /** Fire a projectile move. */
  _fireProjectile(owner, m, team, dirX, dirZ) {
    const t = owner === this.player ? this._nearestEnemyTo(owner) : owner.target;
    let vx = dirX, vy = 0, vz = dirZ;
    const oy = owner.y + (owner.height || 1.8) * 0.72;
    if (t) {
      const ty = t.y + (t.height || 1.8) * 0.55;
      let dx = t.x - owner.x, dy = ty - oy, dz = t.z - owner.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      dx /= d; dy /= d; dz /= d;
      // Lead the shot by gravity drop over the flight time — a rifle that always shoots at your
      // feet is not a rifle, it is a bug report.
      if (m.gravity > 0) dy += (GRAVITY * m.gravity * (d / m.speed)) / (2 * m.speed);
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      vx = dx / l; vy = dy / l; vz = dz / l;
    }
    const pr = this.physics.projectiles.fire({
      x: owner.x + vx * 0.6, y: oy, z: owner.z + vz * 0.6,
      vx: vx * m.speed, vy: vy * m.speed, vz: vz * m.speed,
      gravity: m.gravity, radius: m.projRadius, maxLife: 3.5,
      source: owner, team, hit: null, kind: m.fxKind, element: m.element,
    });
    // Fill the payload that belongs to THIS pool slot, so a round in flight for three seconds
    // still lands with the numbers it was fired with.
    const h = this._projHits[pr.slot];
    h.damage = m.damage;
    h.poise = m.poise;
    h.knockback = m.knockback;
    h.launch = m.launch || 0;
    h.hitstop = m.hitstop;
    h.element = m.element || ELEMENT.NONE;
    h.crit = false;
    h.critChance = 0.05;
    h.critMult = 1.85;
    h.source = owner;
    h.blockable = m.blockable !== undefined ? m.blockable : 1;
    h.guardCost = m.guardCost !== undefined ? m.guardCost : 12;
    h.fxKind = m.fxKind || 'bullet';
    h.tags.length = 0;
    const tags = m.tags || [TAG.RANGED];
    for (let i = 0; i < tags.length; i++) h.tags.push(tags[i]);
    pr.hit = h;
    if (owner.ammo > 0) owner.ammo--;
  }

  _nearestEnemyTo(a) {
    let best = null, bestD = 1e9;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.dead) continue;
      const d = e.distTo(a.x, a.z);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /** Release an actor's aggression token and clear its in-flight move. */
  _releaseAttack(a, interrupted) {
    if (!a) return;
    this.bank.release(a);
    if (a.move !== undefined) {
      a.move = null;
      if (interrupted && a.setState) a.setState(STATE.RECOVER);
      if (interrupted && a.recoverT !== undefined) a.recoverT = Math.max(a.recoverT || 0, 0.25);
    }
  }

  // -------------------------------------------------------------------------
  // Player
  // -------------------------------------------------------------------------

  /**
   * Read the player's intents. Prefers `player.intents` (set by the player system) and falls
   * back to the raw input snapshot, so combat works whichever lands first.
   */
  _intents() {
    const p = this.player;
    const i = this._intentScratch || (this._intentScratch = {
      attack: false, heavy: false, block: false, dodge: false, chargedT: 0, fromPlayer: false,
    });
    // The Player publishes a QUEUE of {kind, ...} intents and combat drains it once per step
    // (the contract at the top of entity/player.js). Fold the queue into the flags this state
    // machine reads. A 'parry' intent counts as the block hold beginning, so damage.js's
    // blockTime-based parry window opens on the press, exactly as the player animated it.
    if (p && typeof p.drainIntents === 'function' && Array.isArray(p.intents)) {
      const list = p.drainIntents();
      i.attack = false; i.heavy = false; i.block = false; i.dodge = false;
      i.chargedT = 0; i.fromPlayer = true;
      for (let k = 0; k < list.length; k++) {
        const it = list[k];
        if (it.kind === 'attack') i.attack = true;
        else if (it.kind === 'heavy') { i.heavy = true; i.chargedT = it.chargedT || 0; }
        else if (it.kind === 'block' || it.kind === 'parry') i.block = true;
        else if (it.kind === 'dodge') i.dodge = true;
      }
      return i;
    }
    if (p && p.intents && !Array.isArray(p.intents)) return p.intents;
    const inp = this.app && this.app.input;
    if (inp && inp.state) {
      const s = inp.state;
      i.attack = !!s.pressed.attack;
      i.heavy = !!s.pressed.heavy;
      i.block = !!s.down.block;
      i.dodge = !!s.pressed.dodge;
      i.chargedT = 0; i.fromPlayer = false;
      return i;
    }
    return null;
  }

  /** Drive the player's attack / block / dodge state machine. */
  _stepPlayer(dt) {
    const p = this.player;
    if (!p || p.dead) return;
    if (p.maxHp === undefined) initCombatant(p, { team: TEAM.PLAYER, maxHp: 100, maxPoise: 55 });
    const it = this._intents();
    const pa = this.playerAttack;

    // Block is a hold, and the parry window is measured by damage.js from blockTime, which
    // stepStatus advances. Losing your guard while staggered or out of stamina is automatic.
    const canBlock = canAct(p) && p.stamina > 1;
    p.blocking = !!(it && it.block) && canBlock && !pa.move;

    if (pa.comboWindow > 0) pa.comboWindow -= dt;

    // Dodge. When the intent came from the Player system (fromPlayer), the player has already
    // paid the stamina and applied the dodge movement itself — combat owns only the i-frames,
    // the swing cancel and the FX. The stamina/impulse block is the input-fallback path.
    if (this.playerDodge > 0) this.playerDodge -= dt;
    if (it && it.dodge && canAct(p) && this.playerDodge <= 0 && (it.fromPlayer || p.stamina >= 14)) {
      const dx = Math.sin(p.yaw || 0), dz = Math.cos(p.yaw || 0);
      const mvx = p.moveX !== undefined ? p.moveX : 0;
      const mvz = p.moveZ !== undefined ? p.moveZ : 0;
      const ddx = (mvx || mvz) ? mvx : dx;
      const ddz = (mvx || mvz) ? mvz : dz;
      const dl = Math.hypot(ddx, ddz) || 1;
      if (!it.fromPlayer) {
        p.stamina -= 14;
        p.staminaDelay = 0.6;
        // The player system consumes this and applies the movement; combat owns the i-frames and
        // the FX, the mover owns the movement.
        p.dodgeImpulse = p.dodgeImpulse || { x: 0, z: 0, t: 0 };
        p.dodgeImpulse.x = ddx / dl; p.dodgeImpulse.z = ddz / dl; p.dodgeImpulse.t = 0.22;
        this._sfx('dodge_woosh', p.x, p.y, p.z);
      }
      this.playerDodge = 0.5;
      grantIframes(p, DODGE_IFRAMES);
      // Cancel a swing: dodge-cancelling is the core defensive verb and must always be available.
      if (pa.hitbox) this.hitboxes.release(pa.hitbox);
      pa.move = null; pa.hitbox = null; pa.phase = '';
      this.fx.speedLines(p.x, p.y, p.z, ddx / dl, ddz / dl, 1);
      return;
    }

    // Attack input.
    if (!pa.move && canAct(p) && it) {
      let want = null;
      if (it.heavy && p.stamina >= PLAYER_MOVES.heavy.stamina) want = PLAYER_MOVES.heavy;
      else if (it.attack) {
        const chainId = pa.comboWindow > 0 && pa.chainNext ? pa.chainNext : 'light1';
        const m = PLAYER_MOVES[chainId];
        if (p.stamina >= m.stamina) want = m;
      }
      if (want) {
        pa.move = want;
        pa.phase = 'windup';
        pa.t = 0;
        pa.hitbox = null;
        pa.chainNext = want.next;
        p.stamina -= want.stamina;
        p.staminaDelay = 0.5;
        p.blocking = false;
        this.stats.attacksStarted++;
        this._sfx(want.sfx, p.x, p.y, p.z);
      }
    }

    // Attack phases.
    if (pa.move) {
      pa.t += dt;
      const m = pa.move;
      if (pa.phase === 'windup' && pa.t >= m.windup) {
        pa.phase = 'active';
        pa.t = 0;
        pa.hitbox = this._spawnHitbox(p, {
          shape: MOVE_SHAPE.SWEEP,
          reach: m.reach, halfAngle: m.halfAngle, width: 0.8,
          damage: m.damage, poise: m.poise, knockback: m.knockback, launch: m.launch,
          hitstop: m.hitstop, active: m.active, advance: m.advance, guardBreak: m.guardBreak,
          fxKind: m.fxKind, tags: [TAG.MELEE],
        }, TEAM.PLAYER);
        // Lunge: the advance is applied as velocity so it collides with the world properly.
        const dx = Math.sin(p.yaw || 0), dz = Math.cos(p.yaw || 0);
        p.vx += dx * m.advance * 6;
        p.vz += dz * m.advance * 6;
      } else if (pa.phase === 'active' && pa.t >= m.active) {
        pa.phase = 'recover';
        pa.t = 0;
        if (pa.hitbox) { this.hitboxes.release(pa.hitbox); pa.hitbox = null; }
        pa.comboWindow = m.window;
      } else if (pa.phase === 'recover' && pa.t >= m.recovery) {
        pa.move = null;
        pa.phase = '';
      }
    }
    // The enemy AI reads this to decide whether to punish. Exposing it as a plain number rather
    // than a state string is deliberate: "how many seconds of recovery are left" is the only
    // question the AI actually asks.
    p.recovery = pa.move && pa.phase === 'recover' ? pa.move.recovery - pa.t : 0;
    p.attacking = !!pa.move;
  }

  // -------------------------------------------------------------------------
  // Enemies
  // -------------------------------------------------------------------------

  /** Perception: who has noticed the player, and does a group notice together? */
  _stepPerception(dt) {
    const p = this.player;
    let anyActive = false;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.dead) continue;
      if (!p || p.dead) { e.target = null; continue; }
      const d = e.distTo(p.x, p.z);
      const aware = e.state !== STATE.IDLE && e.state !== STATE.PATROL;
      if (!aware) {
        if (d <= e.aggroRadius && this._canSee(e, p)) {
          e.target = p;
          e.setState(STATE.ALERT);
          e.alertT = e.arch.ai.reaction;
          // Group awareness: allies nearby notice too. Pulling a camp one enemy at a time looks
          // like a bug, and fighting six of them at once is what the token bank is for.
          this._alertNearby(e, 9);
        }
      } else {
        anyActive = true;
        e.target = p;
        if (d > e.arch.ai.deaggro) {
          e.target = null;
          e.setState(STATE.PATROL);
          this.bank.release(e);
          this.telegraphs.cancelFor(e);
        }
      }
    }
    this.active = anyActive;
  }

  _alertNearby(src, radius) {
    for (let i = 0; i < this.enemies.length; i++) {
      const o = this.enemies[i];
      if (o === src || o.dead) continue;
      if (o.state !== STATE.IDLE && o.state !== STATE.PATROL) continue;
      if (o.distTo(src.x, src.z) > radius) continue;
      o.target = src.target;
      o.setState(STATE.ALERT);
      // Staggered reactions so the group does not turn as one block.
      o.alertT = o.arch.ai.reaction * (1 + o.rng.f() * 0.9);
    }
  }

  _canSee(e, t) {
    const ey = e.y + e.height * 0.82;
    const ty = t.y + (t.height || 1.8) * 0.62;
    return this.physics.lineOfSight(e.x, ey, e.z, t.x, ty, t.z);
  }

  /** One enemy, one step: state machine, movement, attack scheduling. */
  _stepEnemy(e, dt) {
    const ai = e.arch.ai;
    const t = e.target;

    e.stepCooldowns(dt);
    e.checkPhase();
    if (e.pendingPhase >= 0) this._runPhaseChange(e);

    // Wetness, for the fishman. Rain counts, standing in the sea counts more.
    if (ai.wetBonus) {
      const storm = this.app && this.app.sky ? (this.app.sky.env.storm || 0) : 0;
      const inSea = e.y < 0.4;
      e.wet = clamp01(e.wet + (inSea ? dt * 2 : storm > 0.4 ? dt * 0.4 : -dt * 0.25));
    }

    // Interrupted? Stagger and guard break override everything, including a live wind-up.
    if (!canAct(e)) {
      if (e.state !== STATE.STAGGERED) {
        this.telegraphs.cancelFor(e);
        this.bank.release(e);
        e.move = null;
        e.setState(STATE.STAGGERED);
      }
      return;
    }
    if (e.state === STATE.STAGGERED) e.setState(t ? STATE.STRAFE : STATE.PATROL);

    e.stateT += dt;

    switch (e.state) {
      case STATE.IDLE:
        if (e.stateT > 1.5) e.setState(STATE.PATROL);
        break;

      case STATE.PATROL:
        break;

      case STATE.ALERT: {
        if (!t) { e.setState(STATE.PATROL); break; }
        e.faceToward(t.x, t.z, dt, 1.4);
        e.alertT -= dt;
        if (e.alertT <= 0) e.setState(STATE.APPROACH);
        break;
      }

      case STATE.APPROACH: {
        if (!t) { e.setState(STATE.PATROL); break; }
        e.faceToward(t.x, t.z, dt);
        const d = e.distTo(t.x, t.z);
        // Riflemen back off instead of closing when you get inside their panic range.
        if (ai.panicRange && d < ai.panicRange) { this._beginReposition(e); break; }
        if (d <= ai.preferredMax) e.setState(STATE.STRAFE);
        break;
      }

      case STATE.STRAFE: {
        if (!t) { e.setState(STATE.PATROL); break; }
        e.faceToward(t.x, t.z, dt);
        const d = e.distTo(t.x, t.z);
        if (ai.panicRange && d < ai.panicRange) { this._beginReposition(e); break; }
        if (d > ai.preferredMax * 1.6) { e.setState(STATE.APPROACH); break; }

        e.strafeT -= dt;
        if (e.strafeT <= 0) {
          e.strafeT = e.rng.range(ai.strafeHold[0], ai.strafeHold[1]);
          // A flanking archetype biases its circling toward your back rather than flipping at
          // random; everything else flips, which reads as "sizing you up".
          if (ai.flank && t) {
            const fx = Math.sin(t.yaw || 0), fz = Math.cos(t.yaw || 0);
            const rx = e.x - t.x, rz = e.z - t.z;
            const side = rx * fz - rz * fx;
            e.strafeDir = side > 0 ? -1 : 1;
          } else if (e.rng.chance(0.5)) {
            e.strafeDir = -e.strafeDir;
          }
          if (e.rng.f() < ai.repositionChance) { this._beginReposition(e); break; }
        }
        this._trySchedule(e, d, dt);
        break;
      }

      case STATE.ATTACK: {
        if (t) {
          // Tracking during a wind-up is deliberately weak, and it stops entirely once the
          // telegraph has locked. A telegraph you cannot out-position is not a telegraph.
          const tel = e.telegraph;
          const lock = tel && tel.t > 0.55;
          if (!lock) e.faceToward(t.x, t.z, dt, 0.55);
        }
        // The telegraph firing is what advances this state; see _stepTelegraphFires.
        break;
      }

      case STATE.RECOVER: {
        e.recoverT -= dt;
        if (e.recoverT <= 0) {
          this.bank.release(e);
          e.setState(t ? STATE.STRAFE : STATE.PATROL);
        }
        break;
      }

      case STATE.REPOSITION: {
        e.stateT += 0;
        const d = Math.hypot(e.repositionX - e.x, e.repositionZ - e.z);
        if (e.reloadT > 0) {
          e.reloadT -= dt;
          if (e.reloadT <= 0) e.ammo = ai.magazine;
        }
        if (t) e.faceToward(t.x, t.z, dt, 0.7);
        if ((d < 0.6 && e.reloadT <= 0) || e.stateT > 3.0) {
          e.setState(t ? STATE.STRAFE : STATE.PATROL);
        }
        break;
      }

      case STATE.FLEE: {
        if (!t || e.stateT > 2.5 || e.hpFrac > ai.fleeHp * 2) e.setState(STATE.STRAFE);
        break;
      }
      default: break;
    }

    // Health-triggered flight, checked outside the switch so it can interrupt any state.
    if (ai.fleeHp > 0 && e.hpFrac < ai.fleeHp && e.state !== STATE.FLEE && e.state !== STATE.ATTACK) {
      e.setState(STATE.FLEE);
      this.bank.release(e);
    }

    // The bomber has no scheduling: proximity lights the fuse, full stop.
    if (e.kind === 'bomber' && t && !e.fuseLit && e.distTo(t.x, t.z) < 5.5) {
      e.fuseLit = true;
      this._beginMove(e, 0, true);
    }
  }

  _beginReposition(e) {
    chooseReposition(e, this.physics);
    e.setState(STATE.REPOSITION);
    const ai = e.arch.ai;
    if (ai.magazine && e.ammo <= 0) {
      e.reloadT = ai.reloadTime;
      // The reload is the window. It has to be visible, so it gets its own tell.
      this.fx.setAura(e, P.telegraphGuard, 0.5);
    }
  }

  /**
   * Decide whether to attack this step.
   *
   * The gate order matters: legality (range, cooldown, phase) -> intent (reaction timing and
   * punish opportunism) -> BUDGET. Checking the budget last means a waiting enemy has already
   * decided what it wants to do, so it commits the instant a slot frees.
   */
  _trySchedule(e, dist, dt) {
    const ai = e.arch.ai;
    const t = e.target;
    if (!t || t.dead) return;
    if (this.telegraphs.isWindingUp(e)) return;

    const legal = e.legalMoves(dist, this._legal);
    if (legal.length === 0) return;

    // Punish opportunism: an enemy that sees you locked in recovery attacks immediately, which
    // is what teaches the player that the third combo hit is a commitment.
    const punishing = t.recovery > 0.08 && e.rng.f() < ai.punishRecovery;
    if (!punishing) {
      e._urge = (e._urge || 0) + dt;
      const need = ai.reaction * (0.7 + e.rng.f() * 0.9);
      if (e._urge < need) return;
    }

    const idx = e.pickMove(legal);
    if (idx < 0) return;
    const m = e.arch.moves[idx];
    const cost = m.tokens * (ai.tokens > 1 ? 1 : 1);
    if (cost > 0 && !this.bank.canTake(cost)) return;
    if (cost > 0 && !this.bank.take(e, cost)) return;
    e._urge = 0;
    this._beginMove(e, idx, false);
  }

  /** Start a move: spawn its telegraph. The hitbox comes later, from the telegraph completing. */
  _beginMove(e, moveIndex, bypassBudget) {
    const m = e.arch.moves[moveIndex];
    if (!m) return;
    e.move = m;
    e.moveIndex = moveIndex;
    e.setState(STATE.ATTACK);
    const dirX = Math.sin(e.yaw || 0), dirZ = Math.cos(e.yaw || 0);

    // The telegraph's wind-up is scaled by phase, and the spec is frozen, so the scale rides on
    // the instance instead of mutating the spec (which every enemy of this kind shares).
    const spec = m.telegraph;
    const tel = this.telegraphs.spawn(spec, e, {
      dirX, dirZ, target: e.target, tag: moveIndex,
      scale: e.tier > 2 ? 1.12 : 1,
    });
    // Phase speed-up: shorten the effective wind-up by starting the clock partly advanced. This
    // keeps the frozen spec authoritative while still letting a phase-2 boss feel faster.
    const wm = e.windupMult;
    if (wm < 1) tel.age = spec.windup * (1 - wm);
    e.telegraph = tel;
    this.stats.telegraphsShown++;
    this.stats.attacksStarted++;
    if (m.sfx) this._sfx(m.sfx, e.x, e.y, e.z);
    // `bypassBudget` means "this move did not have to ask for a token" (a bomber's fuse, the
    // second half of a chained combo). It must NOT clear the tokens the enemy already holds —
    // doing that orphans them in the bank and the budget drains to zero over a long fight.
    void bypassBudget;
  }

  /** Consume telegraphs that completed this step and turn them into hitboxes. */
  _stepTelegraphFires() {
    const fired = this.telegraphs.fired;
    for (let i = 0; i < fired.length; i++) {
      const tel = fired[i];
      const e = tel.actor;
      if (!e || e.dead || typeof tel.tag !== 'number') continue;
      const m = e.arch.moves[tel.tag];
      if (!m) continue;

      // Effects that change the body rather than spawning a plain hitbox.
      if (m.effect === 'detonate') {
        this._spawnHitbox(e, m, e.team);
        this._impact('explode', e.x, e.y + 0.8, e.z, 0, 1, 2.0, null, 0, false, 0.11, 0.5);
        // The bomber dies to its own blast. It has no other ending.
        e.hp = 0;
        this._onDeath(e, null);
        continue;
      }
      if (m.effect === 'leap') {
        const t = e.target;
        if (t) {
          // A ballistic arc that lands on the telegraph's locked circle, which is the promise
          // the decal made when it stopped tracking.
          const dx = tel.x - e.x, dz = tel.z - e.z;
          const d = Math.hypot(dx, dz) || 1;
          const flight = clamp(d / 9, 0.35, 0.9);
          e.vx = dx / flight;
          e.vz = dz / flight;
          e.vy = GRAVITY * flight * 0.5 + 3;
          e.grounded = false;
        }
      }
      if (m.effect === 'charge') {
        e.chargeT = m.active;
        e.chargeX = Math.sin(e.yaw || 0);
        e.chargeZ = Math.cos(e.yaw || 0);
      }

      this._spawnHitbox(e, m, e.team);
      e.cooldowns[tel.tag] = m.cooldown;

      // Lunge / advance.
      if (m.advance > 0 && m.effect !== 'charge') {
        e.vx += Math.sin(e.yaw || 0) * m.advance * 5;
        e.vz += Math.cos(e.yaw || 0) * m.advance * 5;
      }

      // Chain straight into the follow-up without releasing the token: a two-hit combo is one
      // commitment, and freeing the slot between the swings would let a second enemy join.
      if (m.chain) {
        const nextIdx = e.arch.moves.findIndex((x) => x.id === m.chain);
        if (nextIdx >= 0) {
          e.move = e.arch.moves[nextIdx];
          e._pendingChain = nextIdx;
          e._pendingChainT = m.active + 0.04;
          e.setState(STATE.RECOVER);
          e.recoverT = m.active + 0.05;
          continue;
        }
      }
      e.setState(STATE.RECOVER);
      e.recoverT = m.recovery + m.active;
      e.move = null;
      e.telegraph = null;
    }
  }

  /** A boss phase transition: summons, a shockwave, and a moment of theatre. */
  _runPhaseChange(e) {
    const ph = e.arch.phases[e.pendingPhase];
    e.pendingPhase = -1;
    if (!ph) return;
    this.telegraphs.cancelFor(e);
    this.bank.release(e);
    e.move = null;
    // A guaranteed opening: the transition itself is a punish window, which is the reward for
    // getting the boss to half.
    e.setState(STATE.RECOVER);
    e.recoverT = 1.1;
    e.stagger = 0.9;
    this._impact('slam', e.x, e.y + e.height * 0.5, e.z, 0, 1, 2.2, null, 0, false, 0.14, 0.55);
    this.fx.setAura(e, P.telegraphDanger, 1);
    if (ph.summon) {
      const n = ph.summonCount || 2;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + 0.4;
        const x = e.x + Math.sin(a) * 4.5;
        const z = e.z + Math.cos(a) * 4.5;
        const add = this.spawnEnemy(ph.summon, x, this.physics.groundAt(x, z), z,
          Math.max(1, e.tier - 1));
        add.target = e.target;
        add.setState(STATE.APPROACH);
        if (this.encounter) this.encounter.spawned.push(add);
        this.fx.ring(x, this.physics.groundAt(x, z), z, 2.0, P.telegraphDanger, 0.6);
      }
      // The adds also raise the attack budget, or a captain plus two thugs is quieter than the
      // captain alone was.
      this.bank.setCapacity(this.bank.capacity + 1);
    }
  }

  // -------------------------------------------------------------------------
  // Hitbox resolution
  // -------------------------------------------------------------------------

  /** Advance every live hitbox and resolve it against legal targets. */
  _stepHitboxes(dt) {
    const live = this.hitboxes.live;
    for (let i = 0; i < live.length; i++) {
      const hb = live[i];
      const owner = hb.source;
      if (!owner || owner.removed) continue;

      // A swinging weapon sweeps through its arc over the active window; the sweep hitbox is
      // advanced to the new endpoints so consecutive frames overlap.
      if (hb.shape === SHAPE.SWEEP && hb._sweepHalf !== undefined) {
        const f = clamp01(hb.age / Math.max(1e-4, hb.duration));
        const a = hb._sweepBase - hb._sweepHalf + 2 * hb._sweepHalf * f;
        // Same 2 m cap as _spawnHitbox — see the scale note there.
        const hy = owner.y + Math.min(2.0, (owner.height || 1.8) * 0.55);
        const r = hb._sweepReach;
        hb.advanceTo(
          owner.x + Math.sin(a) * r * 0.25, hy, owner.z + Math.cos(a) * r * 0.25,
          owner.x + Math.sin(a) * r, hy, owner.z + Math.cos(a) * r);
      } else if (hb.shape === SHAPE.ARC) {
        hb.x = owner.x; hb.z = owner.z;
        hb.y = owner.y + (owner.height || 1.8) * 0.55;
      }

      this._filterTeam = hb.team;
      const out = resolveHitbox(hb, this.physics.hash, this._targetFilter, this._targets);
      for (let k = 0; k < out.length; k++) {
        const target = out[k];
        orientHit(hb.hit, hb, target);
        this.applyHit(target, hb.hit);
      }
    }
    this.hitboxes.step(dt);
    this.stats.hitboxes = this.hitboxes.live.length;
  }

  /** Is `a` a legal target for team `team`? */
  _isTarget(a, team) {
    if (!a || a.dead || a.removed) return false;
    const at = a.team !== undefined ? a.team : TEAM.NEUTRAL;
    return at !== team;
  }

  /** Projectiles that ended this step: apply their hit or spend them on the world. */
  _stepProjectiles(dt) {
    const ended = this.physics.projectiles.step(dt, this.physics.hash, this.physics.solid,
      this._projFilter);
    for (let i = 0; i < ended.length; i++) {
      const pr = ended[i];
      if (pr.endedBy === 'actor' && pr.endActor && pr.hit) {
        const h = pr.hit;
        let dx = pr.vx, dz = pr.vz;
        const d = Math.hypot(dx, dz) || 1;
        h.dirX = dx / d; h.dirZ = dz / d;
        h.px = pr.x; h.py = pr.y; h.pz = pr.z;
        this.applyHit(pr.endActor, h);
      } else if (pr.endedBy === 'world') {
        this._impact(pr.kind || 'bullet', pr.x, pr.y, pr.z, pr.vx, pr.vz,
          0.5, null, 0, false, 0, 0.02);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Movement
  // -------------------------------------------------------------------------

  /** Move every enemy: AI velocity, gravity, world sweep. */
  _stepEnemyMovement(dt) {
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.dead) continue;

      // A live charge overrides steering entirely — that is what makes it a charge.
      if (e.chargeT > 0) {
        e.chargeT -= dt;
        e.vx = e.chargeX * 15;
        e.vz = e.chargeZ * 15;
      } else {
        const want = desiredVelocity(e, dt, this._vel);
        // Blend toward the desired velocity rather than snapping: acceleration is most of what
        // makes a heavy enemy read as heavy.
        const accel = e.mass > 150 ? 7 : 16;
        const k = clamp01(accel * dt);
        e.vx += (want.x - e.vx) * k;
        e.vz += (want.z - e.vz) * k;
      }

      // Gravity well pull, from the gravity element.
      const st = e.status;
      if (st.gravityT > 0) {
        const dx = st.gravityX - e.x, dz = st.gravityZ - e.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.2) { e.vx += (dx / d) * st.gravityPull * dt * 5; e.vz += (dz / d) * st.gravityPull * dt * 5; }
      }

      e.vy -= GRAVITY * dt;
      if (e.vy < -TERMINAL_V) e.vy = -TERMINAL_V;
      const wasGrounded = e.grounded;
      sweepBody(this.physics.solid, e, e.vx * dt, e.vy * dt, e.vz * dt);
      if (e.grounded) {
        if (!wasGrounded && e.landImpact > 6) {
          this.fx.dust(e.x, e.y, e.z, clamp(e.landImpact / 9, 0.4, 2));
          this._sfx('land_hard', e.x, e.y, e.z);
        }
        e.landImpact = 0;
        e.airTime = 0;
        // Ground friction. Knockback decays here, which is why a launched enemy slides.
        const f = Math.exp(-9 * dt);
        e.vx *= f; e.vz *= f;
      } else {
        e.airTime += dt;
      }
      // Water contact, for the fishman buff and for splash FX.
      const wasWater = e.inWater;
      e.inWater = e.y < 0;
      if (e.inWater !== wasWater) {
        this.fx.splash(e.x, 0, e.z, 1);
        this._sfx(e.inWater ? 'water_enter' : 'water_exit', e.x, 0, e.z);
      }
      e.yaw = e.yaw % TAU;
    }
  }

  // -------------------------------------------------------------------------
  // Step
  // -------------------------------------------------------------------------

  /**
   * One fixed step. Deterministic: same seed + same inputs => same state, always.
   * @param {number} dt always 1/60
   */
  step(dt) {
    this._t = (this._t || 0) + dt;
    this.bank.step(dt);

    // 1. player
    this._stepPlayer(dt);

    // 2. statuses and DoT for every combatant, including the player
    for (let i = 0; i < this.combatants.length; i++) {
      const a = this.combatants[i];
      if (a.dead) continue;
      const tick = stepStatus(a, dt, this._dotHit);
      if (tick) this.applyHit(a, tick);
    }

    // 3. perception and AI
    this._stepPerception(dt);
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.dead) continue;
      // Deferred combo chain: fires after the previous swing's active window.
      if (e._pendingChain !== undefined && e._pendingChain >= 0) {
        e._pendingChainT -= dt;
        if (e._pendingChainT <= 0) {
          const idx = e._pendingChain;
          e._pendingChain = -1;
          if (canAct(e)) this._beginMove(e, idx, true);
          else { this.bank.release(e); e.setState(STATE.RECOVER); e.recoverT = 0.3; }
          continue;
        }
      }
      this._stepEnemy(e, dt);
    }

    // 4. telegraphs advance, and completed ones become hitboxes
    this.telegraphs.step(dt);
    this._stepTelegraphFires();

    // 5. hitboxes and projectiles
    this._stepHitboxes(dt);
    this._stepProjectiles(dt);

    // 6. movement
    this._stepEnemyMovement(dt);

    // 7. deaths, dissolves, removal
    this._stepDeaths(dt);

    // 8. encounter progression
    this._stepEncounter(dt);

    // 9. publish the readability layer
    this.fx.telegraphs(this.telegraphs.commands);

    this.stats.enemies = this.enemies.length;
  }

  _stepDeaths(dt) {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!e.dead) continue;
      e.deathT = (e.deathT || 0) + dt;
      // Bodies fall, then dissolve into motes. 0.35 s of ragdoll before the dissolve starts so
      // the kill has a beat instead of the enemy blinking out.
      if (e.deathT < 0.35) {
        e.vy -= GRAVITY * dt;
        sweepBody(this.physics.solid, e, e.vx * dt, e.vy * dt, e.vz * dt);
        const f = Math.exp(-5 * dt);
        e.vx *= f; e.vz *= f;
      }
      const dis = clamp01((e.deathT - 0.35) / 0.75);
      this.fx.dissolve(e, dis);
      if (dis >= 1) {
        e.removed = true;
        this.physics.removeActor(e);
        const ci = this.combatants.indexOf(e);
        if (ci >= 0) this.combatants.splice(ci, 1);
        this.enemies.splice(i, 1);
      }
    }
  }

  _stepEncounter(dt) {
    const rec = this.encounter;
    if (!rec || rec.state !== 'running') return;
    rec.waveT += dt;
    let alive = 0;
    for (let i = 0; i < rec.spawned.length; i++) if (!rec.spawned[i].dead) alive++;
    if (alive === 0 && rec.waveT > 0.5) {
      rec.waveT = 0;
      this._nextWave();
    }
  }

  // -------------------------------------------------------------------------
  // Save / dispose
  // -------------------------------------------------------------------------

  /**
   * Combat state worth persisting is small: live enemies are reconstructible from the encounter,
   * so only the encounter, the counters and the player's combat pools are stored (§7: never store
   * anything reconstructible from the seed).
   */
  serialize() {
    return {
      victories: this.victories,
      kills: this.kills,
      encounter: this.encounter ? { id: this.encounter.id, wave: this.encounter.wave } : null,
    };
  }

  deserialize(o) {
    if (!o) return;
    if (typeof o.victories === 'number') this.victories = o.victories;
    if (typeof o.kills === 'number') this.kills = o.kills;
  }

  /** Remove every enemy without granting rewards. Used on load and on fast travel. */
  clearEnemies() {
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      e.removed = true;
      this.physics.removeActor(e);
      const ci = this.combatants.indexOf(e);
      if (ci >= 0) this.combatants.splice(ci, 1);
    }
    this.enemies.length = 0;
    this.bank.reset();
    this.hitboxes.clear();
    this.telegraphs.dispose();
    this.physics.projectiles.clear();
    this.encounter = null;
  }

  dispose() {
    this.clearEnemies();
    this.combatants.length = 0;
    if (this._ownsPhysics) this.physics.dispose();
  }
}

/**
 * A no-op FX implementation so combat runs headless (self-check, server-side determinism proof)
 * without every call site needing a null guard. It counts calls, which is exactly what the
 * self-check asserts on.
 */
export const NULL_FX = {
  calls: { impact: 0, shake: 0, hitstop: 0, flash: 0, telegraphs: 0 },
  impact() { this.calls.impact++; },
  addShake() { this.calls.shake++; },
  addHitstop() { this.calls.hitstop++; },
  setFlash() { this.calls.flash++; },
  setAura() {},
  dissolve() {},
  ring() {}, ringAt() {}, quakeCrack() {}, gravityWell() {},
  dust() {}, splash() {}, speedLines() {}, levelUp() {},
  slashArc() { return null; },
  beginTrail() { return null; }, trailPoint() {}, endTrail() {},
  damageNumber() { return null; },
  telegraphs() { this.calls.telegraphs++; },
};

/**
 * A thin, non-stepping facade so `app.enemies` can expose the spawn hooks the profile harness
 * needs (ARCHITECTURE §9) without registering combat twice.
 * @param {CombatSystem} combat
 */
export function createEnemiesFacade(combat) {
  return {
    spawnWave: (o) => combat.spawnWave(o),
    spawnBoss: (o) => combat.spawnBoss(o),
    list: () => combat.activeEnemies(),
    get count() { return combat.enemies.length; },
    kinds: ENEMY_KIND_IDS,
  };
}

/**
 * Factory. Registered by src/game.js as `app.addSystem('combat', createCombatSystem(app))`.
 * @param {object} app
 * @param {object} [opts]
 * @returns {CombatSystem}
 */
export function createCombatSystem(app, opts) {
  return new CombatSystem(app, opts);
}

export { STATE, ENEMY_ARCHETYPES, ENEMY_KIND_IDS, DANGER };
