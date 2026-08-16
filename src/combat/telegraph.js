// THE READABILITY SYSTEM.
//
// The Hades test (reference/ART_BAR.md, "Named benchmarks"): with the sound off, at 8–15 m, can
// you tell what an enemy is about to do BEFORE it lands? Everything in this file exists to make
// the answer yes, and nothing in this file is decoration.
//
// Three channels carry every attack, and all three fire together:
//   1. a GROUND DECAL in the exact footprint of the hitbox that will spawn — what is drawn is
//      what hits, because both are generated from the same numbers;
//   2. a CHARACTER TELL — a wind-up pose flash plus an aura ring at the actor, so you can read
//      the attack while looking at the enemy rather than at the floor;
//   3. a COLOUR CLASS, and only three of them, never reused for anything else in the game.
//
// The colour contract (ARCHITECTURE §4 colour rule; palette names are load-bearing):
//   P.telegraphGuard  (cyan)   -> blockable / parryable
//   P.telegraphWarn   (orange) -> dodgeable
//   P.telegraphDanger (red)    -> unblockable, must dodge
// If you find yourself wanting one of these hues for a healing effect or a quest marker: no.
//
// COLOURBLIND SAFETY. Colour alone is not a channel for ~8% of players, so every telegraph also
// carries a SHAPE that survives total colour loss — ring / chevron / cross. The settings menu
// already exposes the toggle; this file reads it and never invents its own UI.
//
// This module holds NO rendering code and imports no three.js. It produces draw commands;
// src/render/fx.js consumes them. That is what lets the whole readability system be tested
// headless in tools/check-combat.mjs.

import { P } from '../gen/palette.js';
import { clamp, clamp01, TAU, ease } from '../core/math.js';

/** Telegraph footprint vocabulary. One per hitbox shape family. */
export const TELEGRAPH_KIND = Object.freeze({
  ARC: 'arc',        // a wedge on the ground: melee swings
  LINE: 'line',      // a lane: charges, thrusts, rifle shots
  CIRCLE: 'circle',  // a disc: slams, explosions, bomber detonation
  CONE: 'cone',      // a widening spray: water jets, breath, buckshot
  POINT: 'point',    // a marker on a spot: summons, delayed strikes, gravity wells
});

/**
 * Danger classes. These are a PROMISE to the player about which defensive option works, and the
 * combat resolver in damage.js enforces the promise — a 'parryable' attack really can be parried.
 */
export const DANGER = Object.freeze({
  BLOCKABLE: 'blockable',       // hold block: heavily reduced
  PARRYABLE: 'parryable',       // block in the 0.15 s window: fully negated, attacker staggers
  DODGEABLE: 'dodgeable',       // blockable too, but the punish is in the dodge
  UNBLOCKABLE: 'unblockable',   // guard does nothing. Move.
});

/** How the decal animates from spawn to strike. Growth is the timer the player reads. */
export const GROWTH = Object.freeze({
  FILL: 'fill',    // the shape fills from the origin outward — "this area, at the end"
  SWEEP: 'sweep',  // a leading edge rotates through the arc — "it lands where the edge is"
  PULSE: 'pulse',  // the outline throbs in place — "any moment now, and it will not move"
});

/** Shapes that survive total colour loss. One per class, never shared. */
export const CB_SHAPE = Object.freeze({
  RING: 'ring',        // blockable / parryable
  CHEVRON: 'chevron',  // dodgeable
  CROSS: 'cross',      // unblockable
});

/** Where the footprint is pinned. */
export const ANCHOR = Object.freeze({
  SELF: 'self',      // moves with the attacker (a swing follows the body)
  GROUND: 'ground',  // frozen at the spot it spawned (a slam you can walk out of)
  TARGET: 'target',  // tracks the victim until the strike (a homing charge)
  WORLD: 'world',    // an authored arena position (boss arena-wide attacks)
});

/** The readability floor. Below this a telegraph is a jump-scare, not information. */
export const MIN_WINDUP = 0.26;

/**
 * The canonical colour for a danger class. This function is the only place the mapping exists.
 * @param {string} danger DANGER.*
 * @returns {number} a palette colour
 */
export function dangerColour(danger) {
  switch (danger) {
    case DANGER.UNBLOCKABLE: return P.telegraphDanger;
    case DANGER.BLOCKABLE:
    case DANGER.PARRYABLE: return P.telegraphGuard;
    case DANGER.DODGEABLE: return P.telegraphWarn;
    default: return P.telegraphWarn;
  }
}

/** The colourblind-safe shape for a danger class. */
export function dangerShape(danger) {
  switch (danger) {
    case DANGER.UNBLOCKABLE: return CB_SHAPE.CROSS;
    case DANGER.BLOCKABLE:
    case DANGER.PARRYABLE: return CB_SHAPE.RING;
    default: return CB_SHAPE.CHEVRON;
  }
}

/** The HUD's three-way class name, so the target bar and the ground decal never disagree. */
export function hudClass(danger) {
  if (danger === DANGER.UNBLOCKABLE) return 'danger';
  if (danger === DANGER.BLOCKABLE || danger === DANGER.PARRYABLE) return 'guard';
  return 'warn';
}

/**
 * Read the colourblind telegraph setting from wherever it lives.
 *
 * Two sources, because two owners legitimately expose it: `app.settings.colourblindTelegraphs`
 * is the flag named in the cluster C brief, and `telegraphMode` is the four-way choice the UI
 * settings menu already ships. Honouring both means neither owner has to change.
 *
 * @param {object} app
 * @returns {'off'|'deuter'|'protan'|'tritan'}
 */
export function colourblindMode(app) {
  if (!app) return 'off';
  const s = app.settings;
  if (s) {
    if (typeof s.telegraphMode === 'string' && s.telegraphMode !== 'off') return s.telegraphMode;
    if (s.colourblindTelegraphs === true) return 'deuter';
    if (typeof s.colourblindTelegraphs === 'string' && s.colourblindTelegraphs !== 'off') {
      return s.colourblindTelegraphs;
    }
  }
  const ui = app.ui;
  if (ui && ui.menus && ui.menus.cb && typeof ui.menus.cb.getSettings === 'function') {
    const m = ui.menus.cb.getSettings().telegraphMode;
    if (typeof m === 'string' && m !== 'off') return m;
  }
  return 'off';
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

/**
 * Declare a telegraph. Every enemy attack has exactly one, and it is frozen so a runtime bug
 * cannot quietly retune an enemy's readability mid-fight.
 *
 * @param {object} o
 * @param {string} o.kind TELEGRAPH_KIND.*
 * @param {number} o.windup seconds from tell to strike. MUST exceed MIN_WINDUP.
 * @param {number} [o.sustain] seconds the mark lingers after the strike (the "it happened here")
 * @param {string} o.danger DANGER.*
 * @param {string} [o.growth] GROWTH.*
 * @param {string} [o.anchor] ANCHOR.*
 * @param {number} [o.radius] metres — ARC/CIRCLE/CONE reach, LINE length
 * @param {number} [o.halfAngle] radians — ARC/CONE spread
 * @param {number} [o.width] metres — LINE width
 * @param {number} [o.offset] metres forward of the anchor
 * @param {number} [o.colour] override; defaults to the danger class colour. Must stay in family.
 * @returns {Readonly<object>}
 */
export function defineTelegraph(o) {
  const kind = o.kind;
  if (!Object.values(TELEGRAPH_KIND).includes(kind)) {
    throw new Error(`telegraph: unknown kind "${kind}"`);
  }
  if (!Object.values(DANGER).includes(o.danger)) {
    throw new Error(`telegraph: unknown danger class "${o.danger}"`);
  }
  const windup = o.windup;
  if (!(windup > MIN_WINDUP)) {
    // Thrown, not warned. A sub-quarter-second wind-up is unreadable by construction and no
    // amount of art fixes it, so it must not be possible to ship one.
    throw new Error(`telegraph: windup ${windup}s is below the ${MIN_WINDUP}s readability floor`);
  }
  return Object.freeze({
    kind,
    windup,
    sustain: o.sustain !== undefined ? o.sustain : 0.18,
    danger: o.danger,
    growth: o.growth || (kind === TELEGRAPH_KIND.ARC ? GROWTH.SWEEP : GROWTH.FILL),
    anchor: o.anchor || ANCHOR.SELF,
    colour: o.colour !== undefined ? o.colour : dangerColour(o.danger),
    cbShape: dangerShape(o.danger),
    radius: o.radius !== undefined ? o.radius : 2.4,
    halfAngle: o.halfAngle !== undefined ? o.halfAngle : 0.85,
    width: o.width !== undefined ? o.width : 1.2,
    offset: o.offset !== undefined ? o.offset : 0,
    /** Aura strength on the attacker's body, 0..1. Bosses push harder. */
    tell: o.tell !== undefined ? o.tell : 1,
    /** Short label the HUD target bar prints. Never a placeholder. */
    label: o.label || (o.danger === DANGER.UNBLOCKABLE ? 'UNBLOCKABLE'
      : o.danger === DANGER.PARRYABLE ? 'PARRY' : 'INCOMING'),
  });
}

/**
 * Validate a spec without constructing it. The self-check walks every archetype through this.
 * @param {object} spec
 * @returns {string[]} problems; empty means legal
 */
export function validateTelegraph(spec) {
  const bad = [];
  if (!spec || typeof spec !== 'object') return ['telegraph missing'];
  if (!Object.values(TELEGRAPH_KIND).includes(spec.kind)) bad.push(`bad kind "${spec.kind}"`);
  if (!Object.values(DANGER).includes(spec.danger)) bad.push(`bad danger class "${spec.danger}"`);
  if (!(spec.windup > MIN_WINDUP)) bad.push(`windup ${spec.windup} <= ${MIN_WINDUP}`);
  if (!Object.values(GROWTH).includes(spec.growth)) bad.push(`bad growth "${spec.growth}"`);
  if (!Object.values(ANCHOR).includes(spec.anchor)) bad.push(`bad anchor "${spec.anchor}"`);
  const want = dangerColour(spec.danger);
  if (spec.colour !== want) bad.push(`colour 0x${(spec.colour >>> 0).toString(16)} is not the class colour 0x${want.toString(16)}`);
  if (spec.cbShape !== dangerShape(spec.danger)) bad.push('colourblind shape does not match the danger class');
  if (!(spec.radius > 0)) bad.push('radius must be positive');
  return bad;
}

// ---------------------------------------------------------------------------
// Live instances
// ---------------------------------------------------------------------------

/** One active telegraph. Pooled; the pool is sized for the worst case (a boss plus adds). */
class Telegraph {
  constructor() {
    this.active = false;
    this.id = 0;
    /** @type {object|null} the frozen spec */
    this.spec = null;
    /** @type {object|null} the attacker */
    this.actor = null;
    /** @type {object|null} the tracked victim, for ANCHOR.TARGET */
    this.target = null;
    this.x = 0; this.y = 0; this.z = 0;
    this.dirX = 0; this.dirZ = 1;
    this.age = 0;
    /** 0..1 through the wind-up. The single number every visual channel is driven by. */
    this.t = 0;
    /** true for exactly one step, on the step the wind-up completes. */
    this.fired = false;
    /** true once fired; the mark is in its sustain tail. */
    this.done = false;
    /** Scale multiplier applied to the spec's reach (a tier-3 brute swings wider). */
    this.scale = 1;
    /** Owner-supplied payload passed back on fire, so combat knows which move landed. */
    this.tag = null;
  }
}

/** A draw command handed to fx. One per active telegraph per frame, reused in place. */
function makeCommand() {
  return {
    kind: 'arc', growth: 'fill', anchor: 'self', cbShape: 'ring', danger: 'dodgeable',
    colour: 0, cb: 'off',
    x: 0, y: 0, z: 0, dirX: 0, dirZ: 1,
    radius: 1, halfAngle: 1, width: 1,
    t: 0, alpha: 1, sustain: 0, fired: false,
    actor: null, tell: 0,
  };
}

/**
 * The telegraph system. Owns every live telegraph, advances them at the fixed timestep, and
 * publishes draw commands.
 *
 * It does NOT own attack scheduling — combat.js decides when to telegraph. This split is what
 * stops "the enemy attacked without a telegraph" from being possible: combat can only start an
 * attack by starting a telegraph, and the attack fires from the telegraph's completion.
 */
export class TelegraphSystem {
  /**
   * @param {object} app
   * @param {{capacity?:number}} [opts]
   */
  constructor(app, opts = {}) {
    this.app = app;
    const cap = opts.capacity || 24;
    this.pool = new Array(cap);
    for (let i = 0; i < cap; i++) this.pool[i] = new Telegraph();
    this.capacity = cap;
    /** @type {Telegraph[]} */
    this.live = [];
    /** Telegraphs that completed this step. Combat drains it; never reallocated. */
    this.fired = [];
    this._seq = 0;
    this._cmds = new Array(cap);
    for (let i = 0; i < cap; i++) this._cmds[i] = makeCommand();
    /** Draw commands for this frame. Reused array of reused objects. */
    this.commands = [];
    this._cb = 'off';
    this._cbPoll = 0;
  }

  /**
   * Begin a telegraph.
   * @param {object} spec a frozen spec from defineTelegraph
   * @param {object} actor the attacker
   * @param {object} [o] { dirX, dirZ, x, z, target, scale, tag }
   * @returns {Telegraph}
   */
  spawn(spec, actor, o = {}) {
    let t = null;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.pool[i].active) { t = this.pool[i]; break; }
    }
    if (!t) {
      // Full: recycle the oldest. An enemy whose telegraph silently failed to appear would
      // attack unannounced, which is the exact failure this whole file exists to prevent, so
      // dropping the OLDEST (nearest to resolution, already read by the player) is the least
      // damaging choice available.
      t = this.live.shift();
      t.active = false;
    }
    t.active = true;
    t.id = ++this._seq;
    t.spec = spec;
    t.actor = actor;
    t.target = o.target || null;
    t.age = 0;
    t.t = 0;
    t.fired = false;
    t.done = false;
    t.scale = o.scale !== undefined ? o.scale : 1;
    t.tag = o.tag !== undefined ? o.tag : null;
    t.dirX = o.dirX !== undefined ? o.dirX : Math.sin(actor ? actor.yaw || 0 : 0);
    t.dirZ = o.dirZ !== undefined ? o.dirZ : Math.cos(actor ? actor.yaw || 0 : 0);
    t.x = o.x !== undefined ? o.x : (actor ? actor.x : 0);
    t.y = o.y !== undefined ? o.y : (actor ? actor.y : 0);
    t.z = o.z !== undefined ? o.z : (actor ? actor.z : 0);
    if (this.live.indexOf(t) < 0) this.live.push(t);
    return t;
  }

  /** Cancel a telegraph — the attack was interrupted. The mark vanishes; nothing fires. */
  cancel(t) {
    if (!t || !t.active) return;
    t.active = false;
    t.fired = false;
    const i = this.live.indexOf(t);
    if (i >= 0) this.live.splice(i, 1);
  }

  /** Cancel every telegraph owned by an actor. Called when it staggers or dies. */
  cancelFor(actor) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      if (this.live[i].actor === actor) {
        this.live[i].active = false;
        this.live.splice(i, 1);
      }
    }
  }

  /** Is this actor currently winding up? Used by AI to avoid double-committing. */
  isWindingUp(actor) {
    for (let i = 0; i < this.live.length; i++) {
      const t = this.live[i];
      if (t.actor === actor && !t.done) return true;
    }
    return false;
  }

  /** The active telegraph for an actor, or null. The HUD target bar reads this. */
  forActor(actor) {
    for (let i = 0; i < this.live.length; i++) {
      const t = this.live[i];
      if (t.actor === actor && !t.done) return t;
    }
    return null;
  }

  /**
   * One fixed step. Advances every telegraph, tracks anchors, and fills `this.fired` with the
   * telegraphs whose wind-up completed on THIS step.
   * @param {number} dt
   */
  step(dt) {
    this.fired.length = 0;
    // Poll the setting a few times a second rather than every step: it is a menu toggle, and
    // reading through three objects 60 times a second for a value that changes once a session
    // is exactly the kind of cost that hides in a profile.
    this._cbPoll -= dt;
    if (this._cbPoll <= 0) { this._cb = colourblindMode(this.app); this._cbPoll = 0.25; }

    for (let i = this.live.length - 1; i >= 0; i--) {
      const t = this.live[i];
      const s = t.spec;
      t.fired = false;
      t.age += dt;

      // --- anchor tracking ---------------------------------------------------
      if (s.anchor === ANCHOR.SELF && t.actor) {
        t.x = t.actor.x; t.y = t.actor.y; t.z = t.actor.z;
        if (!t.done) {
          // The footprint follows the body but NOT the facing after the halfway point: locking
          // aim late is what makes a telegraph dodgeable instead of a homing missile.
          if (t.t < 0.55) {
            t.dirX = Math.sin(t.actor.yaw || 0);
            t.dirZ = Math.cos(t.actor.yaw || 0);
          }
        }
      } else if (s.anchor === ANCHOR.TARGET && t.target && !t.done) {
        // Tracks until the same 0.55 lock point, then commits.
        if (t.t < 0.55) {
          t.x = t.target.x; t.y = t.target.y; t.z = t.target.z;
          if (t.actor) {
            const dx = t.target.x - t.actor.x, dz = t.target.z - t.actor.z;
            const d = Math.hypot(dx, dz);
            if (d > 1e-4) { t.dirX = dx / d; t.dirZ = dz / d; }
          }
        }
      }

      if (!t.done) {
        t.t = clamp01(t.age / s.windup);
        if (t.age >= s.windup) {
          t.t = 1;
          t.fired = true;
          t.done = true;
          this.fired.push(t);
        }
      } else if (t.age >= s.windup + s.sustain) {
        t.active = false;
        this.live.splice(i, 1);
      }
    }
    this._buildCommands();
  }

  /** Rebuild the frame's draw commands in place. Zero allocation. */
  _buildCommands() {
    this.commands.length = 0;
    for (let i = 0; i < this.live.length; i++) {
      const t = this.live[i];
      const s = t.spec;
      const c = this._cmds[i];
      c.kind = s.kind;
      c.growth = s.growth;
      c.anchor = s.anchor;
      c.cbShape = s.cbShape;
      c.danger = s.danger;
      c.colour = s.colour;
      c.cb = this._cb;
      c.x = t.x; c.y = t.y; c.z = t.z;
      c.dirX = t.dirX; c.dirZ = t.dirZ;
      c.radius = s.radius * t.scale;
      c.halfAngle = s.halfAngle;
      c.width = s.width * t.scale;
      c.t = t.t;
      c.fired = t.fired;
      c.actor = t.actor;
      c.tell = s.tell * tellStrength(t.t, t.done);
      c.sustain = t.done ? clamp01((t.age - s.windup) / Math.max(1e-3, s.sustain)) : 0;
      c.alpha = decalAlpha(t.t, t.done, c.sustain);
      this.commands.push(c);
    }
    return this.commands;
  }

  serialize() { return null; }   // telegraphs are transient; a save never lands mid-wind-up
  deserialize() {}

  dispose() {
    for (let i = 0; i < this.capacity; i++) this.pool[i].active = false;
    this.live.length = 0;
    this.fired.length = 0;
    this.commands.length = 0;
  }
}

/**
 * Decal opacity over the life of a telegraph.
 *
 * Deliberately NOT a linear ramp: it snaps to a readable floor almost immediately (you must see
 * it in the first 100 ms or the wind-up is wasted), holds, then flashes to full on the strike and
 * fades through the sustain. The 8–15 m visibility requirement is an ALPHA FLOOR, not a size.
 *
 * @param {number} t 0..1 through the wind-up
 * @param {boolean} done past the strike
 * @param {number} sustainT 0..1 through the sustain tail
 * @returns {number} 0..1
 */
export function decalAlpha(t, done, sustainT) {
  if (done) return (1 - ease.outQuad(clamp01(sustainT))) * 0.9;
  // 0 -> 0.62 in the first 12% of the wind-up, then a slow climb to 0.95.
  const rise = clamp01(t / 0.12);
  return 0.62 * ease.outQuad(rise) + 0.33 * ease.inQuad(t);
}

/**
 * Character-tell strength over the life of a telegraph — the aura ring and pose flash amount.
 *
 * Peaks at ~85% of the wind-up rather than at 100%: the eye needs the warning slightly BEFORE
 * the strike, and a tell that peaks on the frame the hitbox spawns is a tell you read too late.
 *
 * @param {number} t
 * @param {boolean} done
 * @returns {number} 0..1
 */
export function tellStrength(t, done) {
  if (done) return 0;
  if (t < 0.85) return ease.inQuad(t / 0.85);
  return 1;
}

/**
 * How much of the footprint is currently "hot", by growth mode. FX uses it to decide what to
 * fill; the value is also exactly what a player is reading, so it lives here and not in fx.js.
 *
 * @param {string} growth GROWTH.*
 * @param {number} t 0..1
 * @returns {number} 0..1
 */
export function growthAmount(growth, t) {
  switch (growth) {
    case GROWTH.FILL: return ease.inQuad(clamp01(t));
    case GROWTH.SWEEP: return clamp01(t);
    case GROWTH.PULSE: {
      // Three throbs across the wind-up, accelerating — the audio-free metronome.
      const beats = 3;
      const phase = clamp01(t) * beats;
      const local = phase - Math.floor(phase);
      return 0.45 + 0.55 * Math.sin(local * Math.PI) * (0.6 + 0.4 * clamp01(t));
    }
    default: return clamp01(t);
  }
}

/**
 * Is a world position inside a telegraph's declared footprint? Used by AI (to avoid friendly
 * fire and to path out of an ally's slam) and by the self-check (to prove that what is drawn is
 * what hits).
 * @param {object} cmdOrTel a draw command or a live telegraph with a spec
 * @param {number} x
 * @param {number} z
 * @returns {boolean}
 */
export function footprintContains(cmdOrTel, x, z) {
  const kind = cmdOrTel.kind || (cmdOrTel.spec && cmdOrTel.spec.kind);
  const radius = cmdOrTel.radius !== undefined ? cmdOrTel.radius : cmdOrTel.spec.radius;
  const halfAngle = cmdOrTel.halfAngle !== undefined ? cmdOrTel.halfAngle : cmdOrTel.spec.halfAngle;
  const width = cmdOrTel.width !== undefined ? cmdOrTel.width : cmdOrTel.spec.width;
  const ox = cmdOrTel.x, oz = cmdOrTel.z;
  const dx = x - ox, dz = z - oz;
  const d2 = dx * dx + dz * dz;
  switch (kind) {
    case TELEGRAPH_KIND.CIRCLE:
    case TELEGRAPH_KIND.POINT:
      return d2 <= radius * radius;
    case TELEGRAPH_KIND.ARC:
    case TELEGRAPH_KIND.CONE: {
      if (d2 > radius * radius) return false;
      if (d2 < 1e-6) return true;
      const d = Math.sqrt(d2);
      return (dx * cmdOrTel.dirX + dz * cmdOrTel.dirZ) / d >= Math.cos(halfAngle);
    }
    case TELEGRAPH_KIND.LINE: {
      const along = dx * cmdOrTel.dirX + dz * cmdOrTel.dirZ;
      if (along < 0 || along > radius) return false;
      const side = dx * cmdOrTel.dirZ - dz * cmdOrTel.dirX;
      return Math.abs(side) <= width * 0.5;
    }
    default: return false;
  }
}

/**
 * Factory. Registered as `app.addSystem('telegraphs', createTelegraphSystem(app))`.
 * @param {object} app
 * @param {object} [opts]
 * @returns {TelegraphSystem}
 */
export function createTelegraphSystem(app, opts) {
  return new TelegraphSystem(app, opts);
}

/** Re-exported so callers never need to reach into math.js just to build a spec. */
export { clamp, TAU };
