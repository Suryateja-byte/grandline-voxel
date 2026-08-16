// The shared spatial layer. Cluster C owns it; player, enemies, projectiles, fruit powers and
// the ship all move through here so that "how far is that thing" has exactly one answer.
//
// Four responsibilities, deliberately kept in one file because they share the same broadphase:
//   1. a uniform spatial hash over actors (cell 4 m), with radius and arc queries
//   2. swept AABB-capsule vs voxel-world collision, with a 0.6 m step-up
//   3. projectile integration (gravity + voxel DDA + actor capsule tests)
//   4. crowd resolution: knockback impulses and soft actor-vs-actor separation
//
// DETERMINISM. Nothing here reads a clock or Math.random. Every query walks cells in a fixed
// nested order and every cell holds actors in insertion order, so two runs that insert the same
// actors in the same order see identical results. That is what lets the fight replay bit-exact.
//
// UNITS. World units are metres (ARCHITECTURE §3). A terrain voxel is 0.5 m, so the DDA grid
// below is 0.5 m and a "cell" in the spatial hash is 4 m — eight voxels, about two body widths,
// which keeps the average bucket at a handful of actors even in a 12-enemy brawl.

import { clamp } from './math.js';

/** Terrain voxel edge length in metres. ARCHITECTURE §3. */
export const VOXEL_M = 0.5;
/** Spatial-hash cell size in metres. */
export const CELL_M = 4;
/** Maximum ledge a walking actor climbs without jumping. Single blocks and stairs, not walls. */
export const STEP_UP_M = 0.6;
/** Gravity. Tuned with jump feel, not physics: a 1.2 m jump peaks in ~0.35 s. */
export const GRAVITY = 26.0;
/** Terminal fall speed, so a long drop stays readable instead of becoming a teleport. */
export const TERMINAL_V = 42.0;
/** Sub-step length for sweeps. Smaller than half the thinnest collider we ever use. */
const SWEEP_STEP_M = 0.18;
/** Epsilon pushed out of surfaces so an actor never re-collides with the face it just left. */
const SKIN = 0.001;

/**
 * The body contract every moving thing in the game satisfies.
 * `y` is the FEET position — not the centre. Every system in cluster C assumes that, because
 * ground contact is the thing gameplay actually cares about.
 *
 * @typedef {object} Body
 * @property {number} x
 * @property {number} y      feet
 * @property {number} z
 * @property {number} vx
 * @property {number} vy
 * @property {number} vz
 * @property {number} radius capsule radius, metres
 * @property {number} height total height, metres
 * @property {number} mass   kg-ish; only ratios matter (knockback, separation)
 * @property {boolean} grounded
 * @property {number} yaw
 */

/**
 * Make a body with sane defaults.
 * @param {Partial<Body>} [o]
 * @returns {Body}
 */
export function makeBody(o = {}) {
  return {
    x: o.x || 0, y: o.y || 0, z: o.z || 0,
    vx: 0, vy: 0, vz: 0,
    radius: o.radius !== undefined ? o.radius : 0.42,
    height: o.height !== undefined ? o.height : 1.8,
    mass: o.mass !== undefined ? o.mass : 70,
    grounded: false,
    yaw: o.yaw || 0,
    /** Seconds since the body last touched ground. Coyote time and landing FX read it. */
    airTime: 0,
    /** Last frame's vertical speed at the moment of landing — drives landing dust strength. */
    landImpact: 0,
    /** True when the feet are below sea level. Fishman damage and splash FX read it. */
    inWater: false,
    /** Set by sweeps: 1 when the last horizontal move was blocked by geometry. */
    blocked: 0,
    /** Set by sweeps: metres the body was lifted by step-up this frame. */
    stepped: 0,
  };
}

// ---------------------------------------------------------------------------
// World access
// ---------------------------------------------------------------------------

/**
 * Resolve a solidity predicate against whatever world implementation is present.
 *
 * WHY a resolver rather than a hard dependency: cluster C ships before `src/world/*` exists,
 * the headless self-check runs against a five-line flat-ground stub, and the capture harness
 * runs shots with only part of the world streamed. All three need the same physics code.
 *
 * Preference order (first available wins):
 *   world.isSolidAt(x, y, z) -> boolean
 *   world.blockAt(x, y, z) + app.blocks.isSolid(id)
 *   world.heightAt(x, z)      (heightfield fallback — everything below the surface is solid)
 *
 * @param {object} app
 * @returns {(x:number, y:number, z:number)=>boolean}
 */
export function makeSolidFn(app) {
  const world = app && app.world;
  if (world && typeof world.isSolidAt === 'function') {
    return (x, y, z) => !!world.isSolidAt(x, y, z);
  }
  if (world && typeof world.blockAt === 'function') {
    const reg = app && app.blocks;
    if (reg && typeof reg.isSolid === 'function') {
      return (x, y, z) => reg.isSolid(world.blockAt(x, y, z));
    }
    return (x, y, z) => world.blockAt(x, y, z) !== 0;
  }
  if (world && typeof world.heightAt === 'function') {
    return (x, y, z) => y < world.heightAt(x, z);
  }
  // No world yet: open air. Actors fall until something registers a world, which is exactly
  // what you want during boot — a spawned actor should not stand on an imaginary floor.
  return () => false;
}

/**
 * Resolve a ground-height function. Used for decal placement and AI pathing sanity, never for
 * collision (collision always goes through the solidity predicate).
 * @param {object} app
 * @returns {(x:number, z:number)=>number}
 */
export function makeGroundFn(app) {
  const world = app && app.world;
  if (world && typeof world.heightAt === 'function') return (x, z) => world.heightAt(x, z);
  return () => 0;
}

// ---------------------------------------------------------------------------
// Spatial hash
// ---------------------------------------------------------------------------

/** Hash a cell coordinate pair into a non-negative integer key. */
function cellKey(cx, cz) {
  // Two large odd multipliers, xored — the classic Teschner hash. Cheap and well spread for
  // the small coordinate ranges a fight occupies.
  return ((Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663)) >>> 0);
}

/**
 * Uniform spatial hash over actors. Rebuilt every fixed step — a fight has tens of actors, not
 * thousands, and a full rebuild is both faster and more deterministic than incremental updates.
 */
export class SpatialHash {
  /** @param {number} [cell] cell edge in metres */
  constructor(cell = CELL_M) {
    this.cell = cell;
    this.inv = 1 / cell;
    /** @type {Map<number, object[]>} key -> bucket. Buckets are reused, never reallocated. */
    this.cells = new Map();
    /** Buckets touched this rebuild, so clear() only walks live ones. */
    this._live = [];
    this.count = 0;
  }

  /** Empty every live bucket without releasing its array. Zero allocation. */
  clear() {
    for (let i = 0; i < this._live.length; i++) this._live[i].length = 0;
    this._live.length = 0;
    this.count = 0;
  }

  /**
   * Insert an actor. The actor is stored by reference and must expose numeric `x`/`z`.
   * @param {{x:number,z:number}} a
   */
  insert(a) {
    const cx = Math.floor(a.x * this.inv);
    const cz = Math.floor(a.z * this.inv);
    const k = cellKey(cx, cz);
    let b = this.cells.get(k);
    if (b === undefined) { b = []; this.cells.set(k, b); }
    if (b.length === 0) this._live.push(b);
    b.push(a);
    this.count++;
  }

  /** Rebuild from a list, preserving list order inside every bucket. */
  rebuild(list) {
    this.clear();
    for (let i = 0; i < list.length; i++) this.insert(list[i]);
  }

  /**
   * Everything whose centre lies within `r` metres of (x,z), horizontally.
   * @param {number} x
   * @param {number} z
   * @param {number} r
   * @param {object[]} out cleared and filled; never reallocated by this call
   * @returns {object[]} the same `out`
   */
  query(x, z, r, out) {
    out.length = 0;
    const r2 = r * r;
    const x0 = Math.floor((x - r) * this.inv), x1 = Math.floor((x + r) * this.inv);
    const z0 = Math.floor((z - r) * this.inv), z1 = Math.floor((z + r) * this.inv);
    // Fixed scan order (z outer, x inner) is what makes the result order deterministic.
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const b = this.cells.get(cellKey(cx, cz));
        if (b === undefined || b.length === 0) continue;
        for (let i = 0; i < b.length; i++) {
          const a = b[i];
          const dx = a.x - x, dz = a.z - z;
          if (dx * dx + dz * dz <= r2) out.push(a);
        }
      }
    }
    return out;
  }

  /**
   * Everything inside a horizontal arc: within `r` of the origin AND within `halfAngle` of the
   * facing direction. The workhorse query for melee, cones and aggro checks.
   *
   * The actor's own radius is credited to it — a wide brute clipped by the edge of a swing is
   * hit, because the player can see the overlap and expects the hit to land.
   *
   * @param {number} x
   * @param {number} z
   * @param {number} dirX normalised facing
   * @param {number} dirZ normalised facing
   * @param {number} r
   * @param {number} halfAngle radians
   * @param {object[]} out
   * @returns {object[]}
   */
  queryArc(x, z, dirX, dirZ, r, halfAngle, out) {
    out.length = 0;
    const cosHalf = Math.cos(clamp(halfAngle, 0, Math.PI));
    const x0 = Math.floor((x - r) * this.inv), x1 = Math.floor((x + r) * this.inv);
    const z0 = Math.floor((z - r) * this.inv), z1 = Math.floor((z + r) * this.inv);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const b = this.cells.get(cellKey(cx, cz));
        if (b === undefined || b.length === 0) continue;
        for (let i = 0; i < b.length; i++) {
          const a = b[i];
          const ar = a.radius || 0;
          const dx = a.x - x, dz = a.z - z;
          const d2 = dx * dx + dz * dz;
          const reach = r + ar;
          if (d2 > reach * reach) continue;
          if (d2 < 1e-6) { out.push(a); continue; }
          const d = Math.sqrt(d2);
          const cosA = (dx * dirX + dz * dirZ) / d;
          // Widen the cone by the angle the actor's own radius subtends at this distance.
          const slack = ar > 0 ? Math.min(1.2, ar / d) : 0;
          if (cosA >= cosHalf - slack * (1 - cosHalf) - slack * 0.5) out.push(a);
        }
      }
    }
    return out;
  }

  /** Nearest actor to (x,z) passing an optional filter, or null. Deterministic on ties. */
  nearest(x, z, r, filter) {
    let best = null, bestD = r * r;
    const x0 = Math.floor((x - r) * this.inv), x1 = Math.floor((x + r) * this.inv);
    const z0 = Math.floor((z - r) * this.inv), z1 = Math.floor((z + r) * this.inv);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const b = this.cells.get(cellKey(cx, cz));
        if (b === undefined) continue;
        for (let i = 0; i < b.length; i++) {
          const a = b[i];
          if (filter && !filter(a)) continue;
          const dx = a.x - x, dz = a.z - z;
          const d2 = dx * dx + dz * dz;
          // Strict < keeps the FIRST inserted actor on an exact tie, which is deterministic.
          if (d2 < bestD) { bestD = d2; best = a; }
        }
      }
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// Voxel collision
// ---------------------------------------------------------------------------

/**
 * Is any voxel overlapping this world-space AABB solid?
 * @param {(x:number,y:number,z:number)=>boolean} solid
 * @returns {boolean}
 */
export function boxHitsWorld(solid, minX, minY, minZ, maxX, maxY, maxZ) {
  const ix0 = Math.floor(minX / VOXEL_M), ix1 = Math.floor((maxX - SKIN) / VOXEL_M);
  const iy0 = Math.floor(minY / VOXEL_M), iy1 = Math.floor((maxY - SKIN) / VOXEL_M);
  const iz0 = Math.floor(minZ / VOXEL_M), iz1 = Math.floor((maxZ - SKIN) / VOXEL_M);
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        if (solid((ix + 0.5) * VOXEL_M, (iy + 0.5) * VOXEL_M, (iz + 0.5) * VOXEL_M)) return true;
      }
    }
  }
  return false;
}

/** Body AABB test at an arbitrary position. */
function bodyHits(solid, b, x, y, z) {
  const r = b.radius;
  return boxHitsWorld(solid, x - r, y + SKIN, z - r, x + r, y + b.height - SKIN, z + r);
}

/**
 * Swept capsule (treated as a vertical AABB, which is the correct shape in a voxel world) vs the
 * voxel world, with step-up.
 *
 * Order is Y, then X, then Z. Doing Y first means an actor that walks off a ledge starts falling
 * on the same step it leaves the ledge, instead of hovering for one frame — the single most
 * visible artefact of the more common X/Z/Y ordering.
 *
 * STEP-UP is what makes a voxel world walkable. Without it, every 0.5 m block edge, every stair
 * and every dock plank is a wall you have to jump, and combat footwork turns into platforming.
 * With it, anything up to 0.6 m is absorbed silently.
 *
 * @param {(x:number,y:number,z:number)=>boolean} solid
 * @param {Body} b mutated in place
 * @param {number} dx desired displacement this step
 * @param {number} dy
 * @param {number} dz
 * @param {{stepUp?:number, noStep?:boolean}} [opts]
 * @returns {Body} the same body
 */
export function sweepBody(solid, b, dx, dy, dz, opts) {
  const stepUp = opts && opts.stepUp !== undefined ? opts.stepUp : STEP_UP_M;
  const allowStep = !(opts && opts.noStep);
  b.blocked = 0;
  b.stepped = 0;

  const total = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
  let steps = Math.ceil(total / SWEEP_STEP_M);
  if (steps < 1) steps = 1;
  if (steps > 64) steps = 64;      // a 12 m teleport still resolves, just coarser
  const sx = dx / steps, sy = dy / steps, sz = dz / steps;

  let grounded = false;
  for (let s = 0; s < steps; s++) {
    // --- vertical -----------------------------------------------------------
    if (sy !== 0) {
      const ny = b.y + sy;
      if (bodyHits(solid, b, b.x, ny, b.z)) {
        if (sy < 0) {
          // Landed: snap the feet to the top of the voxel we entered.
          const cell = Math.floor(ny / VOXEL_M);
          b.y = (cell + 1) * VOXEL_M;
          grounded = true;
          if (b.vy < 0) { b.landImpact = -b.vy; b.vy = 0; }
        } else {
          // Head hit: snap under the ceiling and kill upward velocity.
          const cell = Math.floor((ny + b.height) / VOXEL_M);
          b.y = cell * VOXEL_M - b.height - SKIN;
          if (b.vy > 0) b.vy = 0;
        }
      } else {
        b.y = ny;
      }
    }

    // --- horizontal ---------------------------------------------------------
    if (sx !== 0) {
      const nx = b.x + sx;
      if (!bodyHits(solid, b, nx, b.y, b.z)) {
        b.x = nx;
      } else if (allowStep && tryStepUp(solid, b, nx, b.z, stepUp)) {
        b.x = nx;
      } else {
        b.blocked = 1;
        if (b.vx * sx > 0) b.vx = 0;
      }
    }
    if (sz !== 0) {
      const nz = b.z + sz;
      if (!bodyHits(solid, b, b.x, b.y, nz)) {
        b.z = nz;
      } else if (allowStep && tryStepUp(solid, b, b.x, nz, stepUp)) {
        b.z = nz;
      } else {
        b.blocked = 1;
        if (b.vz * sz > 0) b.vz = 0;
      }
    }
  }

  // Ground probe: a hair below the feet. Cheaper and steadier than trusting the sweep result,
  // which misses the case of an actor already resting on the floor with dy == 0.
  if (!grounded) {
    grounded = bodyHits(solid, b, b.x, b.y - 0.06, b.z);
  }
  b.grounded = grounded;
  return b;
}

/**
 * Try to lift the body onto a ledge no taller than `maxRise` and continue horizontally.
 * Returns true (and commits `b.y`) only if there is both a surface to stand on and headroom.
 */
function tryStepUp(solid, b, nx, nz, maxRise) {
  if (maxRise <= 0) return false;
  // Probe in quarter-voxel increments: fine enough for a 0.25 m character voxel, coarse enough
  // that the worst case is 5 AABB tests.
  const inc = VOXEL_M * 0.5;
  for (let rise = inc; rise <= maxRise + 1e-6; rise += inc) {
    const ny = b.y + rise;
    if (bodyHits(solid, b, b.x, ny, b.z)) return false;      // no headroom where we stand
    if (!bodyHits(solid, b, nx, ny, nz)) {
      b.y = ny;
      b.stepped = rise;
      return true;
    }
  }
  return false;
}

/**
 * Drop a point to the surface below it. Used to place ground decals and to spawn actors.
 * @returns {number} the y of the first solid top face at or below `fromY`, or `minY`.
 */
export function groundBelow(solid, x, fromY, z, minY = -64) {
  let iy = Math.floor(fromY / VOXEL_M);
  const iyMin = Math.floor(minY / VOXEL_M);
  for (; iy >= iyMin; iy--) {
    if (solid(x, (iy + 0.5) * VOXEL_M, z)) return (iy + 1) * VOXEL_M;
  }
  return minY;
}

// ---------------------------------------------------------------------------
// Raycasts
// ---------------------------------------------------------------------------

/**
 * Ray vs voxel world, Amanatides & Woo DDA on the 0.5 m grid.
 * @param {(x:number,y:number,z:number)=>boolean} solid
 * @param {number} ox ray origin
 * @param {number} oy
 * @param {number} oz
 * @param {number} dx normalised direction
 * @param {number} dy
 * @param {number} dz
 * @param {number} maxDist metres
 * @param {object} out reused result object
 * @returns {{hit:boolean, t:number, x:number, y:number, z:number, nx:number, ny:number, nz:number}}
 */
export function raycastVoxel(solid, ox, oy, oz, dx, dy, dz, maxDist, out) {
  const o = out || {};
  o.hit = false; o.t = maxDist; o.nx = 0; o.ny = 0; o.nz = 0;
  o.x = ox + dx * maxDist; o.y = oy + dy * maxDist; o.z = oz + dz * maxDist;

  let ix = Math.floor(ox / VOXEL_M), iy = Math.floor(oy / VOXEL_M), iz = Math.floor(oz / VOXEL_M);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const INF = Infinity;
  const tDeltaX = stepX !== 0 ? Math.abs(VOXEL_M / dx) : INF;
  const tDeltaY = stepY !== 0 ? Math.abs(VOXEL_M / dy) : INF;
  const tDeltaZ = stepZ !== 0 ? Math.abs(VOXEL_M / dz) : INF;
  const bx = (ix + (stepX > 0 ? 1 : 0)) * VOXEL_M;
  const by = (iy + (stepY > 0 ? 1 : 0)) * VOXEL_M;
  const bz = (iz + (stepZ > 0 ? 1 : 0)) * VOXEL_M;
  let tMaxX = stepX !== 0 ? (bx - ox) / dx : INF;
  let tMaxY = stepY !== 0 ? (by - oy) / dy : INF;
  let tMaxZ = stepZ !== 0 ? (bz - oz) / dz : INF;

  // The origin cell counts: a shot fired from inside geometry hits immediately.
  if (solid((ix + 0.5) * VOXEL_M, (iy + 0.5) * VOXEL_M, (iz + 0.5) * VOXEL_M)) {
    o.hit = true; o.t = 0; o.x = ox; o.y = oy; o.z = oz; o.ny = 1;
    return o;
  }

  let guard = 0;
  const maxIter = Math.ceil(maxDist / VOXEL_M) * 3 + 8;
  while (guard++ < maxIter) {
    let t;
    let nx = 0, ny = 0, nz = 0;
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      ix += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX;
    } else if (tMaxY <= tMaxZ) {
      iy += stepY; t = tMaxY; tMaxY += tDeltaY; ny = -stepY;
    } else {
      iz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nz = -stepZ;
    }
    if (t > maxDist) break;
    if (solid((ix + 0.5) * VOXEL_M, (iy + 0.5) * VOXEL_M, (iz + 0.5) * VOXEL_M)) {
      o.hit = true; o.t = t;
      o.x = ox + dx * t; o.y = oy + dy * t; o.z = oz + dz * t;
      o.nx = nx; o.ny = ny; o.nz = nz;
      return o;
    }
  }
  return o;
}

/**
 * Ray vs one actor's capsule, approximated as a vertical cylinder with hemispherical caps.
 * Returns the entry distance along the ray, or -1.
 *
 * Approximating with the cylinder body only would let a shot pass through a crouching enemy's
 * head; the cap tests are two extra sphere solves and remove the whole class of complaint.
 */
export function raycastCapsule(ox, oy, oz, dx, dy, dz, maxDist, cx, cy, cz, radius, height) {
  const r = radius;
  const yLo = cy + r, yHi = cy + height - r;   // segment endpoints of the capsule spine

  // --- infinite cylinder about the spine (XZ quadratic) ---
  const px = ox - cx, pz = oz - cz;
  const a = dx * dx + dz * dz;
  let best = -1;
  if (a > 1e-9) {
    const b = 2 * (px * dx + pz * dz);
    const c = px * px + pz * pz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sd = Math.sqrt(disc);
      // Both roots, checked without building a temporary array — this runs once per actor per
      // projectile per step and allocation here shows up as a p99 hitch in a crowd fight.
      const t0 = (-b - sd) / (2 * a);
      if (t0 >= 0 && t0 <= maxDist) {
        const y0 = oy + dy * t0;
        if (y0 >= yLo && y0 <= yHi) best = t0;
      }
      if (best < 0) {
        const t1 = (-b + sd) / (2 * a);
        if (t1 >= 0 && t1 <= maxDist) {
          const y1 = oy + dy * t1;
          if (y1 >= yLo && y1 <= yHi) best = t1;
        }
      }
    }
  }
  // --- spherical caps ---
  for (let k = 0; k < 2; k++) {
    const sy = k === 0 ? yLo : yHi;
    const ex = ox - cx, ey = oy - sy, ez = oz - cz;
    const b = 2 * (ex * dx + ey * dy + ez * dz);
    const c = ex * ex + ey * ey + ez * ez - r * r;
    const disc = b * b - 4 * c;                  // direction is unit, so a == 1
    if (disc < 0) continue;
    const sd = Math.sqrt(disc);
    const t0 = (-b - sd) / 2, t1 = (-b + sd) / 2;
    if (t0 >= 0 && t0 <= maxDist && (best < 0 || t0 < best)) best = t0;
    else if (t1 >= 0 && t1 <= maxDist && (best < 0 || t1 < best)) best = t1;
  }
  return best;
}

/**
 * Ray vs the actor set, nearest first, honouring world occlusion.
 * @param {SpatialHash} hash
 * @param {(x:number,y:number,z:number)=>boolean} solid
 * @param {object} out reused
 * @returns {{hit:boolean, actor:object|null, t:number, x:number, y:number, z:number, world:boolean}}
 */
export function raycastActors(hash, solid, ox, oy, oz, dx, dy, dz, maxDist, filter, out, scratch) {
  const o = out || {};
  o.hit = false; o.actor = null; o.t = maxDist; o.world = false;
  o.x = ox + dx * maxDist; o.y = oy + dy * maxDist; o.z = oz + dz * maxDist;

  // Clip against geometry first so an enemy behind a wall is never "seen".
  const wall = raycastVoxel(solid, ox, oy, oz, dx, dy, dz, maxDist, scratch && scratch.wall);
  const limit = wall.hit ? wall.t : maxDist;

  const list = scratch && scratch.list ? scratch.list : [];
  // A capsule can be clipped by the ray without its centre being inside the swept radius, so
  // pad the broadphase by a generous body radius.
  const midX = ox + dx * limit * 0.5, midZ = oz + dz * limit * 0.5;
  hash.query(midX, midZ, limit * 0.5 + 3.0, list);

  let bestT = limit, bestA = null;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (filter && !filter(a)) continue;
    const t = raycastCapsule(ox, oy, oz, dx, dy, dz, bestT,
      a.x, a.y, a.z, a.radius || 0.42, a.height || 1.8);
    if (t >= 0 && t < bestT) { bestT = t; bestA = a; }
  }
  if (bestA) {
    o.hit = true; o.actor = bestA; o.t = bestT;
    o.x = ox + dx * bestT; o.y = oy + dy * bestT; o.z = oz + dz * bestT;
  } else if (wall.hit) {
    o.hit = true; o.world = true; o.t = wall.t;
    o.x = wall.x; o.y = wall.y; o.z = wall.z;
  }
  return o;
}

// ---------------------------------------------------------------------------
// Knockback and crowd separation
// ---------------------------------------------------------------------------

/**
 * Apply a knockback impulse. Mass-scaled so a brute shrugs off what launches a knifer, which is
 * how the player learns weight classes without being told.
 * @param {Body} b
 * @param {number} dirX normalised
 * @param {number} dirZ normalised
 * @param {number} force horizontal impulse, metres/sec at mass 70
 * @param {number} [launch] vertical impulse, metres/sec at mass 70
 */
export function applyKnockback(b, dirX, dirZ, force, launch = 0) {
  const scale = 70 / Math.max(1, b.mass);
  b.vx += dirX * force * scale;
  b.vz += dirZ * force * scale;
  if (launch !== 0) {
    b.vy += launch * scale;
    if (b.vy > 0) b.grounded = false;
  }
}

/**
 * Soft actor-vs-actor separation.
 *
 * WHY soft and not a hard constraint: hard separation in a crowd produces jitter (A pushes B
 * pushes A) and makes enemies feel like billiard balls. A single relaxation pass that moves each
 * pair a fraction of their overlap converges over a few frames, reads as bodies leaning on each
 * other, and — critically — never teleports an enemy out of a telegraph the player already read.
 *
 * @param {SpatialHash} hash
 * @param {object[]} actors
 * @param {number} dt
 * @param {number} [strength] 0..1 fraction of overlap resolved per step
 */
export function separateActors(hash, actors, dt, strength = 0.5) {
  const scratch = separateActors._scratch || (separateActors._scratch = []);
  for (let i = 0; i < actors.length; i++) {
    const a = actors[i];
    if (a.dead || a.noPush) continue;
    const ra = a.radius || 0.42;
    hash.query(a.x, a.z, ra + 1.6, scratch);
    for (let j = 0; j < scratch.length; j++) {
      const b = scratch[j];
      if (b === a || b.dead || b.noPush) continue;
      // Resolve each pair once, from the lower-id side, so the result cannot depend on the
      // iteration order of the hash. `id` is assigned monotonically at spawn.
      if ((b.id | 0) <= (a.id | 0)) continue;
      const rb = b.radius || 0.42;
      const minD = ra + rb;
      let dx = b.x - a.x, dz = b.z - a.z;
      let d2 = dx * dx + dz * dz;
      if (d2 >= minD * minD) continue;
      if (d2 < 1e-8) {
        // Perfectly co-located: break the tie with the id, never with a random direction.
        dx = ((a.id | 0) & 1) ? 1 : 0; dz = ((a.id | 0) & 1) ? 0 : 1; d2 = 1;
      }
      const d = Math.sqrt(d2);
      const overlap = (minD - d);
      const nx = dx / d, nz = dz / d;
      const ma = a.mass || 70, mb = b.mass || 70;
      const total = ma + mb;
      // Heavier bodies move less. A brute wading through thugs shoves them aside.
      const push = overlap * strength * Math.min(1, dt * 60);
      const wa = mb / total, wb = ma / total;
      a.x -= nx * push * wa; a.z -= nz * push * wa;
      b.x += nx * push * wb; b.z += nz * push * wb;
    }
  }
}

// ---------------------------------------------------------------------------
// Projectiles
// ---------------------------------------------------------------------------

/** Projectile pool slot. Fields are fixed so the pool never changes shape. */
function makeProjectile(slot) {
  return {
    alive: false, id: 0,
    /** Fixed index into the pool. Lets an owner keep per-slot side data without a Map. */
    slot: slot,
    x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0,
    vx: 0, vy: 0, vz: 0,
    gravity: 1, radius: 0.22, life: 0, maxLife: 3,
    source: null, team: 0, hit: null, kind: 'bullet', element: 'none',
    /** Set when the projectile stopped this step: 'actor' | 'world' | 'expire' | null */
    endedBy: null, endActor: null,
  };
}

/**
 * Fixed-capacity projectile pool with voxel + capsule collision.
 * Firing when full silently reuses the oldest slot — dropping a shot is worse than recycling one,
 * because a marine that visibly fires and does nothing reads as a bug.
 */
export class ProjectilePool {
  /** @param {number} [capacity] */
  constructor(capacity = 96) {
    /** @type {ReturnType<makeProjectile>[]} */
    this.pool = new Array(capacity);
    for (let i = 0; i < capacity; i++) this.pool[i] = makeProjectile(i);
    this.capacity = capacity;
    this._next = 0;
    this._seq = 0;
    this._ray = {};
    this._scratch = { wall: {}, list: [] };
    /** Slots that ended this step. Combat drains it; never reallocated. */
    this.ended = [];
    // One bound predicate reused by every projectile every step. Building a closure per
    // projectile per step is the classic invisible allocation in a bullet loop.
    this._cur = null;
    this._filter = null;
    this._boundFilter = (a) => this._filter(this._cur, a);
  }

  /**
   * @param {object} spec { x,y,z, vx,vy,vz, gravity, radius, maxLife, source, team, hit, kind, element }
   * @returns {object} the pooled projectile
   */
  fire(spec) {
    let p = null;
    for (let i = 0; i < this.capacity; i++) {
      const c = this.pool[(this._next + i) % this.capacity];
      if (!c.alive) { p = c; this._next = (this._next + i + 1) % this.capacity; break; }
    }
    if (!p) { p = this.pool[this._next]; this._next = (this._next + 1) % this.capacity; }
    p.alive = true;
    p.id = ++this._seq;
    p.x = spec.x; p.y = spec.y; p.z = spec.z;
    p.px = spec.x; p.py = spec.y; p.pz = spec.z;
    p.vx = spec.vx; p.vy = spec.vy; p.vz = spec.vz;
    p.gravity = spec.gravity !== undefined ? spec.gravity : 1;
    p.radius = spec.radius !== undefined ? spec.radius : 0.22;
    p.life = 0;
    p.maxLife = spec.maxLife !== undefined ? spec.maxLife : 3;
    p.source = spec.source || null;
    p.team = spec.team || 0;
    p.hit = spec.hit || null;
    p.kind = spec.kind || 'bullet';
    p.element = spec.element || 'none';
    p.endedBy = null; p.endActor = null;
    return p;
  }

  /**
   * Integrate every live projectile one fixed step and collide it.
   * Collision is a segment test from last position to new position, so a 90 m/s rifle round
   * cannot tunnel through a body between frames.
   *
   * @param {number} dt
   * @param {SpatialHash} hash
   * @param {(x:number,y:number,z:number)=>boolean} solid
   * @param {(p:object)=>boolean} targetFilter which actors this projectile may hit
   * @returns {object[]} `this.ended`, the projectiles that stopped this step
   */
  step(dt, hash, solid, targetFilter) {
    this.ended.length = 0;
    this._filter = targetFilter || null;
    for (let i = 0; i < this.capacity; i++) {
      const p = this.pool[i];
      if (!p.alive) continue;
      this._cur = p;
      p.px = p.x; p.py = p.y; p.pz = p.z;
      p.vy -= GRAVITY * p.gravity * dt;
      const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, nz = p.z + p.vz * dt;
      let sx = nx - p.x, sy = ny - p.y, sz = nz - p.z;
      const segLen = Math.sqrt(sx * sx + sy * sy + sz * sz);

      if (segLen > 1e-6) {
        const inv = 1 / segLen;
        sx *= inv; sy *= inv; sz *= inv;
        const r = raycastActors(hash, solid, p.x, p.y, p.z, sx, sy, sz, segLen,
          targetFilter ? this._boundFilter : null, this._ray, this._scratch);
        if (r.hit) {
          p.x = r.x; p.y = r.y; p.z = r.z;
          p.alive = false;
          p.endedBy = r.world ? 'world' : 'actor';
          p.endActor = r.actor;
          this.ended.push(p);
          continue;
        }
      }
      p.x = nx; p.y = ny; p.z = nz;
      p.life += dt;
      if (p.life >= p.maxLife) {
        p.alive = false; p.endedBy = 'expire'; p.endActor = null;
        this.ended.push(p);
      }
    }
    return this.ended;
  }

  /** Live projectile count. */
  get live() {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) if (this.pool[i].alive) n++;
    return n;
  }

  clear() {
    for (let i = 0; i < this.capacity; i++) this.pool[i].alive = false;
    this.ended.length = 0;
  }
}

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

/**
 * The physics system registered on the App. It owns the broadphase for the frame and exposes it
 * to everyone else; it deliberately does NOT move actors, because who moves and in what order is
 * a gameplay decision that belongs to the player and combat systems.
 *
 * Registration order (ARCHITECTURE §4) puts physics after the movers, so the hash it publishes is
 * built from end-of-step positions — which is what queries during the NEXT step want.
 */
export class PhysicsSystem {
  /**
   * @param {object} app
   * @param {{cell?:number, projectiles?:number}} [opts]
   */
  constructor(app, opts = {}) {
    this.app = app;
    this.hash = new SpatialHash(opts.cell || CELL_M);
    this.projectiles = new ProjectilePool(opts.projectiles || 96);
    /** @type {object[]} everything the broadphase indexes. Owned by combat, read by all. */
    this.actors = [];
    this._solid = makeSolidFn(app);
    this._ground = makeGroundFn(app);
    this._worldRef = app ? app.world : null;
    this._scratch = { wall: {}, list: [] };
    this._ray = {};
    this.stats = { actors: 0, projectiles: 0, separations: 0 };
  }

  /** Re-resolve world accessors if the world system appeared or was replaced. */
  _refreshWorld() {
    const w = this.app ? this.app.world : null;
    if (w !== this._worldRef) {
      this._worldRef = w;
      this._solid = makeSolidFn(this.app);
      this._ground = makeGroundFn(this.app);
    }
  }

  /** @returns {(x:number,y:number,z:number)=>boolean} */
  get solid() { return this._solid; }

  /** Ground height at (x,z). @returns {number} */
  groundAt(x, z) { return this._ground(x, z); }

  /** Register an actor with the broadphase. Combat calls this on spawn. */
  addActor(a) {
    if (this.actors.indexOf(a) < 0) this.actors.push(a);
    return a;
  }

  removeActor(a) {
    const i = this.actors.indexOf(a);
    if (i >= 0) this.actors.splice(i, 1);
  }

  /** Move a body through the world. @see sweepBody */
  move(body, dx, dy, dz, opts) {
    return sweepBody(this._solid, body, dx, dy, dz, opts);
  }

  /** Radius query. `out` is cleared and filled. */
  query(x, z, r, out) { return this.hash.query(x, z, r, out); }

  /** Arc query. `out` is cleared and filled. */
  queryArc(x, z, dirX, dirZ, r, halfAngle, out) {
    return this.hash.queryArc(x, z, dirX, dirZ, r, halfAngle, out);
  }

  /** Ray against world geometry only. */
  rayWorld(ox, oy, oz, dx, dy, dz, maxDist, out) {
    return raycastVoxel(this._solid, ox, oy, oz, dx, dy, dz, maxDist, out || this._ray);
  }

  /** Ray against actors, occluded by geometry. */
  rayActors(ox, oy, oz, dx, dy, dz, maxDist, filter, out) {
    return raycastActors(this.hash, this._solid, ox, oy, oz, dx, dy, dz, maxDist, filter,
      out || this._ray, this._scratch);
  }

  /** Straight line of sight between two points, ignoring actors. */
  lineOfSight(ax, ay, az, bx, by, bz) {
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-5) return true;
    dx /= d; dy /= d; dz /= d;
    const r = raycastVoxel(this._solid, ax, ay, az, dx, dy, dz, d, this._scratch.wall);
    return !r.hit;
  }

  /** One fixed step: rebuild the broadphase, separate crowds, integrate projectiles. */
  step(dt) {
    this._refreshWorld();
    // Drop anything combat marked as gone before the hash sees it.
    for (let i = this.actors.length - 1; i >= 0; i--) {
      if (this.actors[i].removed) this.actors.splice(i, 1);
    }
    this.hash.rebuild(this.actors);
    separateActors(this.hash, this.actors, dt, 0.5);
    // Separation moved bodies, so the hash is one relaxation pass stale; rebuild so every query
    // made later this step (and next step) sees the settled positions.
    this.hash.rebuild(this.actors);
    this.stats.actors = this.actors.length;
    this.stats.projectiles = this.projectiles.live;
  }

  serialize() { return null; }   // physics holds no authoritative state; combat owns the actors
  deserialize() {}

  dispose() {
    this.actors.length = 0;
    this.hash.clear();
    this.projectiles.clear();
  }
}

/**
 * Factory. Registered by src/game.js as `app.addSystem('physics', createPhysicsSystem(app))`.
 * @param {object} app
 * @param {object} [opts]
 * @returns {PhysicsSystem}
 */
export function createPhysicsSystem(app, opts) {
  return new PhysicsSystem(app, opts);
}
