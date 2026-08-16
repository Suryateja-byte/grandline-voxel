// Hitboxes as DATA, not ad-hoc code.
//
// Every attack in the game — player light, player heavy, brute overhead, admiral arena sweep,
// a devil-fruit shockwave — resolves through the same five shapes and the same resolver. That
// matters for three reasons:
//   1. tuning: a designer changes numbers, not control flow;
//   2. readability: a telegraph is generated FROM the hitbox, so what is drawn is what hits;
//   3. determinism: one resolver means one traversal order means a replayable fight.
//
// The dedupe rule is absolute: an attack may hit a target at most once per activation. Without
// it, a multi-frame sweep hits the same enemy on every sampled frame and a 12-damage swing does
// 60. That bug is invisible in a 1v1 test and lethal in a crowd.

import { clamp, TAU } from '../core/math.js';

/** The shape vocabulary. Anything that cannot be expressed here needs a new shape, not a hack. */
export const SHAPE = Object.freeze({
  /** Horizontal wedge: radius + half-angle about a facing direction. Melee's bread and butter. */
  ARC: 'arc',
  /** Segment with thickness, swept from A to B. Thrusts, charges, beams. */
  CAPSULE: 'capsule',
  /** Point radius. Explosions, shockwaves, projectile impacts. */
  SPHERE: 'sphere',
  /** Oriented box. Ground slams, arena walls, the admiral's cross. */
  BOX: 'box',
  /** Multi-frame capsule sweep sampled along a weapon path. Fast attacks cannot tunnel. */
  SWEEP: 'sweep',
});

/** Damage elements. Each has a fixed FX colour and a fixed status reaction — see damage.js. */
export const ELEMENT = Object.freeze({
  NONE: 'none', FLAME: 'flame', FROST: 'frost', SAND: 'sand', QUAKE: 'quake', GRAVITY: 'gravity',
});

/** Tags a hit may carry. Systems branch on tags, never on the attack's name. */
export const TAG = Object.freeze({
  MELEE: 'melee', RANGED: 'ranged', FRUIT: 'fruit', ENVIRONMENT: 'environment',
  UNBLOCKABLE: 'unblockable', GUARD_BREAK: 'guardBreak', PARRYABLE: 'parryable',
  FINISHER: 'finisher', AOE: 'aoe', DOT: 'dot',
});

/**
 * A hit payload. This is the ONLY currency of damage in the game.
 *
 * @typedef {object} Hit
 * @property {number} damage    raw damage before defence, resistances and bonuses
 * @property {number} poise     stagger pressure; when a target's poise pool empties it staggers
 * @property {number} knockback horizontal impulse in m/s at mass 70
 * @property {number} launch    vertical impulse in m/s at mass 70
 * @property {number} hitstop   seconds of freeze on connect (before the crit multiplier)
 * @property {string} element   ELEMENT.*
 * @property {boolean} crit     rolled by damage.js, never set by the attack author
 * @property {object|null} source the attacker actor
 * @property {string[]} tags    TAG.*
 * @property {number} dirX      normalised impact direction (attacker -> target), filled at resolve
 * @property {number} dirZ
 * @property {number} px        impact point, filled at resolve
 * @property {number} py
 * @property {number} pz
 */

/**
 * Build a hit payload with defaults. Authors specify what differs; everything else is standard.
 * @param {Partial<Hit>} [o]
 * @returns {Hit}
 */
export function makeHit(o = {}) {
  return {
    damage: o.damage !== undefined ? o.damage : 10,
    poise: o.poise !== undefined ? o.poise : 10,
    knockback: o.knockback !== undefined ? o.knockback : 3.5,
    launch: o.launch !== undefined ? o.launch : 0,
    hitstop: o.hitstop !== undefined ? o.hitstop : 0.055,
    element: o.element || ELEMENT.NONE,
    crit: false,
    critChance: o.critChance !== undefined ? o.critChance : 0.08,
    critMult: o.critMult !== undefined ? o.critMult : 1.85,
    source: o.source || null,
    tags: o.tags ? o.tags.slice() : [TAG.MELEE],
    /** How much of this hit a successful block absorbs. 1 = fully blockable. */
    blockable: o.blockable !== undefined ? o.blockable : 1,
    /** Stamina a blocker pays. High values are how a brute breaks a guard. */
    guardCost: o.guardCost !== undefined ? o.guardCost : 12,
    dirX: 0, dirZ: 0, px: 0, py: 0, pz: 0,
    /** Filled by the resolver so FX can pick a flavour without re-deriving it. */
    fxKind: o.fxKind || 'slash',
  };
}

/** Copy `src` into `dst` without allocating. Used to hand a pooled hit to the damage resolver. */
export function copyHit(dst, src) {
  dst.damage = src.damage; dst.poise = src.poise; dst.knockback = src.knockback;
  dst.launch = src.launch; dst.hitstop = src.hitstop; dst.element = src.element;
  dst.crit = src.crit; dst.critChance = src.critChance; dst.critMult = src.critMult;
  dst.source = src.source; dst.blockable = src.blockable; dst.guardCost = src.guardCost;
  dst.dirX = src.dirX; dst.dirZ = src.dirZ; dst.px = src.px; dst.py = src.py; dst.pz = src.pz;
  dst.fxKind = src.fxKind;
  dst.tags.length = 0;
  for (let i = 0; i < src.tags.length; i++) dst.tags.push(src.tags[i]);
  return dst;
}

/**
 * Does a hit carry a tag?
 * Tolerates a missing `tags` array: hits are constructed by combat, fruit powers, enemies and
 * the world, and requiring every one of those producers to remember an empty array turns a
 * benign omission into a crash mid-fight.
 */
export function hasTag(hit, tag) {
  const t = hit && hit.tags;
  if (!t) return false;
  for (let i = 0; i < t.length; i++) if (t[i] === tag) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Shape tests
// ---------------------------------------------------------------------------

/** Squared distance from point p to segment ab, in XZ. */
function segDist2XZ(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 1e-9 ? ((px - ax) * abx + (pz - az) * abz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + abx * t, cz = az + abz * t;
  const dx = px - cx, dz = pz - cz;
  return dx * dx + dz * dz;
}

/** Vertical overlap between a hitbox band [y0,y1] and an actor standing at ay with height h. */
function verticalOverlap(y0, y1, ay, h) {
  return y1 >= ay && y0 <= ay + h;
}

/**
 * Does this hitbox contain the given actor?
 * Pure and side-effect free — the resolver calls it, and the self-check calls it directly.
 * @param {Hitbox} hb
 * @param {{x:number,y:number,z:number,radius:number,height:number}} a
 * @returns {boolean}
 */
export function hitboxContains(hb, a) {
  const ar = a.radius !== undefined ? a.radius : 0.42;
  const ah = a.height !== undefined ? a.height : 1.8;
  if (!verticalOverlap(hb.y0, hb.y1, a.y, ah)) return false;

  switch (hb.shape) {
    case SHAPE.SPHERE: {
      const dx = a.x - hb.x, dz = a.z - hb.z;
      const r = hb.radius + ar;
      return dx * dx + dz * dz <= r * r;
    }
    case SHAPE.ARC: {
      const dx = a.x - hb.x, dz = a.z - hb.z;
      const d2 = dx * dx + dz * dz;
      const reach = hb.radius + ar;
      if (d2 > reach * reach) return false;
      // Inner cut-out: a spin attack that should miss a target hugging the caster.
      if (hb.inner > 0 && d2 < hb.inner * hb.inner) return false;
      if (d2 < 1e-6) return true;
      const d = Math.sqrt(d2);
      const cosA = (dx * hb.dirX + dz * hb.dirZ) / d;
      // Credit the target's own radius: an enemy visibly overlapping the wedge edge is hit.
      const angSlack = Math.asin(clamp(ar / Math.max(d, ar), 0, 1));
      return cosA >= Math.cos(clamp(hb.halfAngle + angSlack, 0, Math.PI));
    }
    case SHAPE.CAPSULE:
    case SHAPE.SWEEP: {
      const r = hb.radius + ar;
      return segDist2XZ(a.x, a.z, hb.x, hb.z, hb.x2, hb.z2) <= r * r;
    }
    case SHAPE.BOX: {
      // Rotate the target into box space. dirX/dirZ is the box's local +Z.
      const dx = a.x - hb.x, dz = a.z - hb.z;
      const fx = hb.dirX, fz = hb.dirZ;
      const localZ = dx * fx + dz * fz;
      const localX = dx * fz - dz * fx;      // perpendicular (right-hand)
      return Math.abs(localX) <= hb.halfW + ar && Math.abs(localZ) <= hb.halfL + ar;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Hitbox
// ---------------------------------------------------------------------------

let _hbSeq = 0;

/**
 * A hitbox instance. Pooled — never construct one in the hit path, take one from a HitboxPool.
 *
 * Coordinates are world-space metres. `y0`/`y1` are absolute world heights, not offsets, because
 * an overhead that clears a ducking enemy and a sweep that clips their ankles are different
 * attacks and must be expressible as different numbers.
 */
export class Hitbox {
  constructor() {
    this.id = 0;
    this.shape = SHAPE.ARC;
    this.active = false;
    /** Origin / first endpoint. */
    this.x = 0; this.y = 0; this.z = 0;
    /** Second endpoint for CAPSULE / SWEEP. */
    this.x2 = 0; this.y2 = 0; this.z2 = 0;
    /** Previous frame's endpoints — SWEEP interpolates between them. */
    this.px = 0; this.py = 0; this.pz = 0;
    this.px2 = 0; this.py2 = 0; this.pz2 = 0;
    this.dirX = 0; this.dirZ = 1;
    this.radius = 2;
    this.inner = 0;
    this.halfAngle = 0.8;
    this.halfW = 1; this.halfL = 1;
    this.y0 = 0; this.y1 = 2;
    /** Sub-samples along the sweep path. 1 = a plain capsule. */
    this.samples = 1;
    /** @type {Hit|null} */
    this.hit = null;
    this.team = 0;
    this.source = null;
    /** Attack instance id — the dedupe key namespace. */
    this.attackId = 0;
    /** Ids already hit by THIS activation. Reused array, never reallocated. */
    this.seen = [];
    /** How many targets this activation has connected with. Combos and FX read it. */
    this.hitCount = 0;
    /** Seconds the hitbox has been active. */
    this.age = 0;
    this.duration = 0.1;
    /** Broadphase scratch, allocated once with the pool slot. */
    this._b = { cx: 0, cz: 0, r: 0 };
    /**
     * This slot OWNS its hit payload.
     *
     * The alternative — handing out payloads from a shared round-robin pool — aliases: a slow
     * projectile or a long active window outlives the pool wrap, and the hit that finally lands
     * carries some later attack numbers. That bug is nearly impossible to reproduce on demand
     * and trivial to avoid by giving every slot its own payload.
     */
    this.ownHit = makeHit();
  }

  /** Clear for reuse. Keeps the `seen` array allocation. */
  reset() {
    this.active = false;
    this.seen.length = 0;
    this.hitCount = 0;
    this.age = 0;
    this.samples = 1;
    this.inner = 0;
    this.hit = null;
    this.source = null;
  }

  /** Has this activation already connected with `target`? */
  hasSeen(target) {
    const id = target.id | 0;
    const s = this.seen;
    for (let i = 0; i < s.length; i++) if (s[i] === id) return true;
    return false;
  }

  /** Record `target` as hit by this activation. */
  markSeen(target) {
    this.seen.push(target.id | 0);
    this.hitCount++;
  }

  /**
   * Advance the sweep endpoints. Call once per step BEFORE resolving, so the sweep spans the
   * distance the weapon actually travelled between frames.
   */
  advanceTo(x, y, z, x2, y2, z2) {
    this.px = this.x; this.py = this.y; this.pz = this.z;
    this.px2 = this.x2; this.py2 = this.y2; this.pz2 = this.z2;
    this.x = x; this.y = y; this.z = z;
    this.x2 = x2; this.y2 = y2; this.z2 = z2;
  }

  /**
   * Centre and radius of the broadphase query.
   *
   * For a SWEEP this MUST cover the previous frame's endpoints as well as this frame's, or the
   * broadphase silently undoes the anti-tunnelling the narrowphase just paid for: a weapon that
   * travelled 12 m in one step would query a 2 m bubble around where it ended up and never even
   * consider the target it passed straight through. That bug only appears at high swing speeds,
   * which is exactly when it matters.
   */
  _bounds() {
    const b = this._b;
    if (this.shape === SHAPE.SPHERE || this.shape === SHAPE.ARC) {
      b.cx = this.x; b.cz = this.z; b.r = this.radius;
      return b;
    }
    if (this.shape === SHAPE.BOX) {
      b.cx = this.x; b.cz = this.z;
      b.r = Math.sqrt(this.halfW * this.halfW + this.halfL * this.halfL);
      return b;
    }
    let minX = Math.min(this.x, this.x2), maxX = Math.max(this.x, this.x2);
    let minZ = Math.min(this.z, this.z2), maxZ = Math.max(this.z, this.z2);
    if (this.shape === SHAPE.SWEEP) {
      minX = Math.min(minX, this.px, this.px2); maxX = Math.max(maxX, this.px, this.px2);
      minZ = Math.min(minZ, this.pz, this.pz2); maxZ = Math.max(maxZ, this.pz, this.pz2);
    }
    b.cx = (minX + maxX) * 0.5;
    b.cz = (minZ + maxZ) * 0.5;
    b.r = Math.hypot(maxX - minX, maxZ - minZ) * 0.5 + this.radius;
    return b;
  }

  broadRadius() { return this._bounds().r; }
  broadX() { return this._bounds().cx; }
  broadZ() { return this._bounds().cz; }
}

/**
 * Fixed-capacity hitbox pool. Combat holds one; nothing else allocates a Hitbox.
 */
export class HitboxPool {
  /** @param {number} [capacity] */
  constructor(capacity = 48) {
    this.pool = new Array(capacity);
    for (let i = 0; i < capacity; i++) this.pool[i] = new Hitbox();
    this.capacity = capacity;
    /** @type {Hitbox[]} live boxes, in activation order. Reused array. */
    this.live = [];
  }

  /**
   * Take a cleared hitbox and mark it live.
   * @param {string} shape SHAPE.*
   * @returns {Hitbox}
   */
  acquire(shape) {
    for (let i = 0; i < this.capacity; i++) {
      const h = this.pool[i];
      if (!h.active) {
        h.reset();
        h.active = true;
        h.shape = shape;
        h.id = ++_hbSeq;
        h.attackId = h.id;
        this.live.push(h);
        return h;
      }
    }
    // Pool exhausted: recycle the oldest live box rather than drop the swing. An attack that
    // visibly happens and cannot hit is a worse failure than a dropped stale hitbox.
    const h = this.live.shift();
    h.reset();
    h.active = true;
    h.shape = shape;
    h.id = ++_hbSeq;
    h.attackId = h.id;
    this.live.push(h);
    return h;
  }

  /** Retire a hitbox. */
  release(h) {
    h.active = false;
    const i = this.live.indexOf(h);
    if (i >= 0) this.live.splice(i, 1);
  }

  /** Age every live box and retire the expired ones. */
  step(dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const h = this.live[i];
      h.age += dt;
      if (h.age >= h.duration) { h.active = false; this.live.splice(i, 1); }
    }
  }

  clear() {
    for (let i = 0; i < this.capacity; i++) this.pool[i].reset();
    this.live.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Scratch state for the resolver. One instance, reused; nothing here is per-call. */
const _res = {
  candidates: [],
  out: [],
  sweep: new Hitbox(),
};

/**
 * Resolve a hitbox against the actor broadphase.
 *
 * A SWEEP samples `hb.samples` intermediate capsules between the previous and current endpoints.
 * That is the whole anti-tunnelling story: a katana tip moving 6 m in one 16 ms frame is tested
 * at 6 positions along its path, so a knifer standing anywhere along the arc is caught.
 *
 * @param {Hitbox} hb
 * @param {import('../core/physics.js').SpatialHash} hash
 * @param {(a:object)=>boolean} filter which actors are legal targets
 * @param {object[]} out cleared and filled with newly-hit actors, in deterministic order
 * @returns {object[]} the same `out`
 */
export function resolveHitbox(hb, hash, filter, out) {
  out.length = 0;
  const cand = _res.candidates;
  const b = hb._bounds();
  // The +2 m pad covers the widest body radius in the game plus a little slack; the narrowphase
  // is what actually decides, so an over-wide broadphase costs a few distance tests, while an
  // under-wide one drops hits.
  hash.query(b.cx, b.cz, b.r + 2.0, cand);
  if (cand.length === 0) return out;

  if (hb.shape === SHAPE.SWEEP && hb.samples > 1) {
    const s = _res.sweep;
    s.shape = SHAPE.CAPSULE;
    s.radius = hb.radius;
    s.y0 = hb.y0; s.y1 = hb.y1;
    const n = hb.samples;
    for (let k = 0; k < n; k++) {
      const t = n === 1 ? 1 : k / (n - 1);
      s.x = hb.px + (hb.x - hb.px) * t;
      s.y = hb.py + (hb.y - hb.py) * t;
      s.z = hb.pz + (hb.z - hb.pz) * t;
      s.x2 = hb.px2 + (hb.x2 - hb.px2) * t;
      s.y2 = hb.py2 + (hb.y2 - hb.py2) * t;
      s.z2 = hb.pz2 + (hb.z2 - hb.pz2) * t;
      // Sample band tracks the sampled segment so a rising overhead does not hit ankles.
      s.y0 = Math.min(s.y, s.y2) - hb.radius;
      s.y1 = Math.max(s.y, s.y2) + hb.radius;
      for (let i = 0; i < cand.length; i++) {
        const a = cand[i];
        if (a.dead || a.removed) continue;
        if (filter && !filter(a)) continue;
        if (hb.hasSeen(a)) continue;
        if (!hitboxContains(s, a)) continue;
        hb.markSeen(a);
        out.push(a);
      }
    }
    return out;
  }

  for (let i = 0; i < cand.length; i++) {
    const a = cand[i];
    if (a.dead || a.removed) continue;
    if (filter && !filter(a)) continue;
    if (hb.hasSeen(a)) continue;         // the one-hit-per-activation rule
    if (!hitboxContains(hb, a)) continue;
    hb.markSeen(a);
    out.push(a);
  }
  return out;
}

/**
 * Fill in a hit's impact direction and point from attacker -> target. Called by combat right
 * before applyHit, so knockback and FX always agree with the geometry that produced the hit.
 * @param {Hit} hit
 * @param {Hitbox} hb
 * @param {{x:number,y:number,z:number,height:number}} target
 */
export function orientHit(hit, hb, target) {
  let dx = target.x - hb.x, dz = target.z - hb.z;
  // A sphere centred exactly on the target (a bomber detonating inside you) has no direction of
  // its own; fall back to the attacker's facing so the launch is still readable.
  const d2 = dx * dx + dz * dz;
  if (d2 < 1e-6) { dx = hb.dirX; dz = hb.dirZ; }
  else { const inv = 1 / Math.sqrt(d2); dx *= inv; dz *= inv; }
  hit.dirX = dx; hit.dirZ = dz;
  // Impact point: on the target's surface, at chest height. That is where sparks belong; the
  // centre of the capsule puts them inside the body where they are invisible.
  const r = target.radius !== undefined ? target.radius : 0.42;
  const h = target.height !== undefined ? target.height : 1.8;
  hit.px = target.x - dx * r;
  hit.pz = target.z - dz * r;
  hit.py = target.y + h * 0.62;
  return hit;
}

/**
 * Convenience builders for the shapes an attack author actually writes.
 * Each mutates and returns a pooled hitbox, so no call site allocates.
 */
export const shapeArc = (hb, x, y, z, dirX, dirZ, radius, halfAngle, y0, y1) => {
  hb.shape = SHAPE.ARC;
  hb.x = x; hb.y = y; hb.z = z;
  hb.dirX = dirX; hb.dirZ = dirZ;
  hb.radius = radius; hb.halfAngle = halfAngle;
  hb.y0 = y0; hb.y1 = y1;
  return hb;
};

export const shapeSphere = (hb, x, y, z, radius) => {
  hb.shape = SHAPE.SPHERE;
  hb.x = x; hb.y = y; hb.z = z; hb.radius = radius;
  hb.y0 = y - radius; hb.y1 = y + radius;
  return hb;
};

export const shapeCapsule = (hb, x, y, z, x2, y2, z2, radius) => {
  hb.shape = SHAPE.CAPSULE;
  hb.x = x; hb.y = y; hb.z = z;
  hb.x2 = x2; hb.y2 = y2; hb.z2 = z2;
  hb.radius = radius;
  hb.y0 = Math.min(y, y2) - radius; hb.y1 = Math.max(y, y2) + radius;
  return hb;
};

export const shapeBox = (hb, x, y, z, dirX, dirZ, halfW, halfL, y0, y1) => {
  hb.shape = SHAPE.BOX;
  hb.x = x; hb.y = y; hb.z = z;
  hb.dirX = dirX; hb.dirZ = dirZ;
  hb.halfW = halfW; hb.halfL = halfL;
  hb.y0 = y0; hb.y1 = y1;
  return hb;
};

/**
 * A weapon-path sweep. `samples` should be at least ceil(pathLength / (radius * 1.5)) so
 * consecutive samples overlap — that is the condition for "cannot tunnel".
 */
export const shapeSweep = (hb, x, y, z, x2, y2, z2, radius, samples) => {
  hb.shape = SHAPE.SWEEP;
  hb.px = hb.x = x; hb.py = hb.y = y; hb.pz = hb.z = z;
  hb.px2 = hb.x2 = x2; hb.py2 = hb.y2 = y2; hb.pz2 = hb.z2 = z2;
  hb.radius = radius;
  hb.samples = Math.max(1, samples | 0);
  hb.y0 = Math.min(y, y2) - radius; hb.y1 = Math.max(y, y2) + radius;
  return hb;
};

/** Minimum sample count that guarantees overlapping samples along a path. */
export function sweepSamplesFor(pathLength, radius) {
  return Math.max(2, Math.min(12, Math.ceil(pathLength / Math.max(0.05, radius * 1.5)) + 1));
}

/** Full-circle helper: an arc with halfAngle = PI reads as a radial burst. */
export const FULL_CIRCLE = TAU / 2;
