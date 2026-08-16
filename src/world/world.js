// The world: island placement across a Grand Line-scale sea, terrain streaming, and every
// terrain query the rest of the game depends on (ARCHITECTURE section 5).
//
// THE ONE CORRECTNESS PROPERTY THAT MATTERS
// -----------------------------------------
// Island placement is a PURE FUNCTION of (sector coordinate, world seed). No stateful Rng is
// ever walked in visit order, because the order sectors are visited depends on where the
// player sails, and a placement that depends on the route is a placement that changes when
// you sail back. Every decision below — how many islands a sector wants, where they sit,
// which one wins a spacing conflict, which archetype it is, what seed it builds from — comes
// out of hash2/hash3 of the sector coordinate. Load the same seed twice, visit the sectors in
// opposite orders, and you get the same sea.
//
// Blue-noise spacing is done as a one-round maximal-independent-set on candidate priority: a
// candidate survives only if no candidate within the minimum separation has a higher
// priority. That test is symmetric and local (candidates are drawn per 4096 m sector and the
// separation is 900 m, so the 3x3 sector neighbourhood is always sufficient), which is what
// makes it order-independent. It is deliberately conservative — a candidate blocked by a
// candidate that is itself blocked still loses — because resolving that properly needs an
// iterative pass whose fixed point depends on evaluation order.

import * as THREE from 'three';
import { Rng, hash3, mix32, hashFloat, parseSeed } from '../core/rng.js';
import { clamp, lerp, smoothstep, TAU } from '../core/math.js';
import { buildBlocks } from '../gen/blocks.js';
import { meshVolume, AIR } from '../gen/voxel.js';
import { IslandCanvas, shipHull, VOXEL_M } from '../gen/islandbuild.js';
import {
  LANDMARKS, LANDMARK_BY_ID, MINOR_ARCHETYPES, buildLandmark, generateMinorIsland,
} from '../gen/islands.js';
import { P, shadeDown, shadeUp, mixHex } from '../gen/palette.js';
import { paintSolid, paintCloth } from '../gen/texture.js';
import { IslandInstance, CHUNK_X, CHUNK_Y, CHUNK_Z } from './chunk.js';
import { Streamer } from './stream.js';

// --- world constants --------------------------------------------------------

/** Ocean sector edge, in metres. ARCHITECTURE section 3. */
export const SECTOR_M = 4096;
/** Minimum centre-to-centre spacing between minor islands. */
export const MIN_ISLAND_SEP_M = 900;
/** No minor island may be placed within this of a landmark centre. */
export const LANDMARK_CLEARANCE_M = 1400;
/** Sea features keep this much clear water around any island. */
export const FEATURE_CLEARANCE_M = 260;

/** Islands within this of the focus are built. */
export const LOAD_RADIUS_M = 2600;
/** ...and thrown away past this. The gap is hysteresis: no load/unload thrashing at the edge. */
export const UNLOAD_RADIUS_M = 3400;
/** Hard cap on simultaneously resident islands. */
export const MAX_LOADED_ISLANDS = 14;
/** Sea features within this of the focus get geometry. */
export const SEA_FEATURE_RADIUS_M = 1700;

/** Route corridor: the eight landmarks run west to east between these x bounds at z ~ 0. */
const ROUTE_X0 = -9000;
const ROUTE_X1 = 9000;

// Salts. Distinct per decision so adding a decision never shifts an existing one.
const SALT_COUNT = 0x51ed270b;
const SALT_POS = 0x7feb352d;
const SALT_PRIO = 0x2545f491;
const SALT_ARCH = 0x9e3779b1;
const SALT_SEED = 0x85ebca6b;
const SALT_FEAT = 0xc2b2ae35;

const MIN_SEP_SQ = MIN_ISLAND_SEP_M * MIN_ISLAND_SEP_M;

/**
 * Extra texture tiles the world needs (rain, foam, storm light). Registered by the
 * orchestrator through App's `registerTiles` hook, because a DataArrayTexture has a fixed
 * layer count once built. Everything that consumes these degrades to an existing tile if the
 * hook was never wired, so the world never hard-fails on a missing layer.
 * @param {import('../gen/texture.js').TextureLibrary} tex
 * @returns {import('../gen/texture.js').TextureLibrary} tex, for chaining
 */
export function registerWorldTiles(tex) {
  tex.add('rain_streak', (p) => {
    p.fill(0x000000, 0);
    const pale = mixHex(P.skyHorizon, P.uiWhite, 0.55);
    for (let i = 0; i < 5; i++) {
      const x = 3 + i * 6;
      const y0 = (i * 11) % 32;
      for (let k = 0; k < 13; k++) p.set(x, (y0 + k) & 31, pale, 190 - k * 6);
    }
  });
  tex.add('sea_foam', (p) => {
    p.fill(0x000000, 0);
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const n = ((x * 7 + y * 13) ^ (x * y)) & 15;
        if (n > 8) p.set(x, y, n > 12 ? P.seaFoam : shadeDown(P.seaFoam, 0.25), 210);
      }
    }
  });
  tex.add('storm_light', paintSolid(shadeUp(P.sunDisc, 0.6), { grain: 0.02 }));
  tex.add('sea_banner', paintCloth(P.marineWhite));
  return tex;
}

// --- placement --------------------------------------------------------------

/**
 * How dense island placement should be at a point. 1 along the authored route, falling to a
 * floor offshore — the far sea is sparse, never empty.
 * @param {number} x @param {number} z
 * @returns {number} 0..1
 */
export function routeDensity(x, z) {
  const nx = clamp(x, ROUTE_X0, ROUTE_X1);
  const d = Math.hypot(x - nx, z);
  return 0.12 + 0.88 * (1 - smoothstep(1500, 11000, d));
}

/**
 * Difficulty tier of open water, from the west-to-east route. Tier 1 at the western end,
 * tier 5 at Marineford Reach.
 * @param {number} x @param {number} z
 * @returns {number} 1..5
 */
export function tierAt(x, z) {
  const base = 1 + Math.round((x + 7200) / 3600);
  const offshore = Math.abs(z) > 6000 ? 1 : 0;
  return clamp(base + offshore, 1, 5);
}

/** @returns {boolean} true when (x,z) is inside a landmark's exclusion zone */
export function crowdsLandmark(x, z) {
  for (let i = 0; i < LANDMARKS.length; i++) {
    const L = LANDMARKS[i];
    const dx = x - L.worldPos[0], dz = z - L.worldPos[1];
    const r = LANDMARK_CLEARANCE_M + L.radius;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}

/**
 * Candidate minor-island sites for one sector. Pure in (seed, sectorX, sectorZ).
 * @param {number} seed @param {number} sxi @param {number} szi
 * @returns {Array<{x:number,z:number,prio:number,sx:number,sz:number,i:number}>}
 */
export function minorCandidates(seed, sxi, szi) {
  const cx = sxi * SECTOR_M + SECTOR_M / 2;
  const cz = szi * SECTOR_M + SECTOR_M / 2;
  const d = routeDensity(cx, cz);
  const u = hashFloat(hash3(sxi, szi, 0, seed ^ SALT_COUNT));
  // Thresholds interpolate between "offshore" and "on the route": on the route a sector
  // usually wants two sites, offshore it usually wants none.
  const p0 = lerp(0.58, 0.10, d);
  const p1 = lerp(0.86, 0.42, d);
  const p2 = lerp(0.975, 0.76, d);
  const want = u < p0 ? 0 : u < p1 ? 1 : u < p2 ? 2 : 3;
  const out = [];
  for (let i = 0; i < want; i++) {
    const h = hash3(sxi, szi, i + 1, seed ^ SALT_POS);
    const x = Math.round(sxi * SECTOR_M + hashFloat(h) * SECTOR_M);
    const z = Math.round(szi * SECTOR_M + hashFloat(mix32(h)) * SECTOR_M);
    const prio = hashFloat(hash3(sxi, szi, i + 1, seed ^ SALT_PRIO));
    out.push({ x, z, prio, sx: sxi, sz: szi, i });
  }
  return out;
}

/** Total order on candidates, used only to break exactly-equal priorities. */
function candCmp(a, b) {
  if (a.sx !== b.sx) return a.sx - b.sx;
  if (a.sz !== b.sz) return a.sz - b.sz;
  return a.i - b.i;
}

/**
 * Turn an accepted candidate into a placement record. No voxels are built here — the record
 * is everything the ocean shader, the map and the queries need before the island exists.
 * @param {number} seed @param {{x:number,z:number,sx:number,sz:number,i:number}} c
 */
export function minorRecordFor(seed, c) {
  const tier = tierAt(c.x, c.z);
  const pool = MINOR_ARCHETYPES.filter((a) => a.tiers.indexOf(tier) >= 0);
  const arch = pool[hash3(c.sx, c.sz, c.i + 1, seed ^ SALT_ARCH) % pool.length];
  const islandSeed = (hash3(c.sx, c.sz, c.i + 1, seed ^ SALT_SEED) >>> 0) || 1;
  // generateMinorIsland draws `scale` as the first value from the rng when the archetype is
  // forced, so a throwaway stream on the same seed predicts the radius exactly. The value is
  // reconciled against the built island anyway (see World.buildIsland) so a change in the
  // island generator degrades the prediction, never the determinism.
  const scale = lerp(0.85, 1.15, new Rng(islandSeed).f());
  return {
    id: 'minor_' + arch.id + '_' + (c.x | 0) + '_' + (c.z | 0),
    kind: 'minor',
    name: arch.name,
    biome: arch.biome,
    archetype: arch.id,
    worldPos: [c.x, c.z],
    radius: Math.round(arch.radius * scale),
    maxHeight: Math.round(arch.maxHeight * scale) + 2,
    difficultyTier: tier,
    seed: islandSeed,
    sector: [c.sx, c.sz],
    slot: c.i,
    canvas: null,
  };
}

/**
 * The minor islands a sector actually publishes, after blue-noise spacing and the landmark
 * exclusion. Pure in (seed, sectorX, sectorZ) and independent of visit order.
 * @param {number} seed @param {number} sxi @param {number} szi
 * @returns {object[]} placement records
 */
export function acceptedMinors(seed, sxi, szi) {
  const mine = minorCandidates(seed, sxi, szi).filter((c) => !crowdsLandmark(c.x, c.z));
  if (!mine.length) return [];
  const neigh = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const list = (dx === 0 && dz === 0) ? mine : minorCandidates(seed, sxi + dx, szi + dz);
      for (const c of list) if (!crowdsLandmark(c.x, c.z)) neigh.push(c);
    }
  }
  const out = [];
  for (const c of mine) {
    let ok = true;
    for (const o of neigh) {
      if (o.sx === c.sx && o.sz === c.sz && o.i === c.i) continue;
      const dx = o.x - c.x, dz = o.z - c.z;
      if (dx * dx + dz * dz >= MIN_SEP_SQ) continue;
      if (o.prio > c.prio || (o.prio === c.prio && candCmp(o, c) > 0)) { ok = false; break; }
    }
    if (ok) out.push(minorRecordFor(seed, c));
  }
  return out;
}

/** The eight authored landmarks as placement records. */
export function landmarkRecords() {
  return LANDMARKS.map((L) => ({
    id: L.id,
    kind: 'landmark',
    name: L.name,
    biome: L.biome,
    archetype: L.id,
    worldPos: [L.worldPos[0], L.worldPos[1]],
    radius: L.radius,
    maxHeight: L.maxHeight,
    difficultyTier: L.difficultyTier,
    dockPos: L.dockPos,
    dockYaw: L.dockYaw,
    weatherBias: L.weatherBias,
    ambience: L.ambience,
    musicState: L.musicState,
    seed: 0,
    canvas: null,
  }));
}

// --- sea dressing -----------------------------------------------------------

/** Sea feature kinds. Cheap objects that stop open water reading as an empty plane. */
export const SEA_KINDS = Object.freeze(['spire', 'wreck', 'buoy', 'whirlpool', 'becalmed', 'seaKing']);

// --- the world --------------------------------------------------------------

/**
 * @typedef {{id:string, kind:string, worldPos:[number,number], radius:number,
 *            maxHeight:number, difficultyTier:number, seed:number}} IslandRecord
 */

export class World {
  /**
   * @param {object} app the App (may be a stub in headless tools: only seed, materials,
   *        rootStatic, tex and water are ever read, and every one of them is optional)
   * @param {{seed?:number, reg?:object, B?:object, budget?:number, maxChunkMeshes?:number,
   *          headless?:boolean, driveWater?:boolean, loadRadius?:number}} opts
   */
  constructor(app, opts = {}) {
    this.app = app || null;
    this.seed = parseSeed(opts.seed !== undefined ? opts.seed : (app ? app.seed : undefined));
    this.opts = opts;

    let reg = opts.reg, B = opts.B;
    if (!reg || !B) {
      const tex = opts.tex || (app && app.tex);
      if (!tex) throw new Error('world: needs a TextureLibrary (app.tex) or an explicit reg/B');
      const built = buildBlocks(tex);
      reg = reg || built.reg;
      B = B || built.B;
    }
    this.reg = reg;
    this.B = B;

    this.materials = opts.headless ? null : (opts.materials || (app && app.materials) || null);
    this.parent = opts.headless ? null : (opts.parent || (app && app.rootStatic) || null);
    this.loadRadius = opts.loadRadius || LOAD_RADIUS_M;
    this.unloadRadius = Math.max(this.loadRadius + 400, opts.unloadRadius || UNLOAD_RADIUS_M);
    this.maxIslands = opts.maxIslands || MAX_LOADED_ISLANDS;
    this.driveWater = opts.driveWater !== false;

    /** @type {Map<string, IslandInstance>} */
    this.loaded = new Map();
    /** Where streaming is centred. Set by the orchestrator each step; see setFocus(). */
    this.focus = { x: 0, y: 2, z: 0, yaw: 0 };

    this.landmarks = landmarkRecords();
    this.landmarkById = new Map(this.landmarks.map((r) => [r.id, r]));
    this._sectorCache = new Map();
    this._featureCache = new Map();
    /** Saved terrain edits keyed by island id, replayed whenever that island loads. */
    this.edits = new Map();
    /** Island ids the player has been inside. Quest and save read this. */
    this.visited = new Set();

    this.streamer = new Streamer(this, opts);
    this.time = 0;
    this._tick = 0;

    // Sea dressing. Variant geometry is authored lazily, at most one variant per tick.
    /** @type {Map<string,{solid:THREE.BufferGeometry|null,cutout:THREE.BufferGeometry|null}>} */
    this._seaBank = new Map();
    this._seaBuildAllowed = false;
    /** @type {Map<string,{feat:object, obj:THREE.Object3D|null}>} */
    this.activeSea = new Map();
    this._seaNear = [];
    this._insideIsland = null;
    this._discScratch = [];
    this.stats = { queries: 0 };

    // Boot-time, not play-time: see prebuildSeaGeometry().
    this.prebuildSeaGeometry();
  }

  // --- focus --------------------------------------------------------------

  /**
   * Move the streaming focus. The orchestrator calls this from the player or the ship each
   * step. It is deliberately NOT read from app.camera during step(): the camera is
   * interpolated in preRender, so reading it here would make the stream schedule depend on
   * the render alpha and stop being reproducible.
   * @param {number} x @param {number} y @param {number} z @param {number} [yaw]
   */
  setFocus(x, y, z, yaw) {
    this.focus.x = x;
    this.focus.y = y;
    this.focus.z = z;
    if (yaw !== undefined) this.focus.yaw = yaw;
    this._focusExplicit = true;
  }

  // --- placement queries --------------------------------------------------

  _sectorMinors(sxi, szi) {
    const key = (sxi + 32768) * 65536 + (szi + 32768);
    let v = this._sectorCache.get(key);
    if (v === undefined) {
      if (this._sectorCache.size > 4096) this._sectorCache.clear();
      v = acceptedMinors(this.seed, sxi, szi);
      this._sectorCache.set(key, v);
    }
    return v;
  }

  /**
   * Every island whose disc comes within `radius` of (x,z), landmarks included.
   * @param {number} x @param {number} z @param {number} radius
   * @returns {IslandRecord[]}
   */
  islandsNear(x, z, radius) {
    const out = [];
    for (const L of this.landmarks) {
      const d = Math.hypot(L.worldPos[0] - x, L.worldPos[1] - z) - L.radius;
      if (d < radius) out.push(L);
    }
    const s0x = Math.floor((x - radius) / SECTOR_M), s1x = Math.floor((x + radius) / SECTOR_M);
    const s0z = Math.floor((z - radius) / SECTOR_M), s1z = Math.floor((z + radius) / SECTOR_M);
    for (let sz = s0z; sz <= s1z; sz++) {
      for (let sx = s0x; sx <= s1x; sx++) {
        for (const r of this._sectorMinors(sx, sz)) {
          const d = Math.hypot(r.worldPos[0] - x, r.worldPos[1] - z) - r.radius;
          if (d < radius) out.push(r);
        }
      }
    }
    return out;
  }

  /**
   * The closest island to (x,z), searched in widening rings so the common case is cheap.
   * @returns {IslandRecord|null}
   */
  nearestIsland(x, z) {
    for (const r of [1200, 3000, 7000, 16000, 40000]) {
      const list = this.islandsNear(x, z, r);
      if (!list.length) continue;
      let best = null, bd = Infinity;
      for (const rec of list) {
        const d = Math.hypot(rec.worldPos[0] - x, rec.worldPos[1] - z);
        if (d < bd) { bd = d; best = rec; }
      }
      if (best) return best;
    }
    return null;
  }

  /**
   * The island (x,z) is standing on, or null over open sea.
   * @returns {IslandRecord|null}
   */
  islandAt(x, z) {
    const list = this.islandsNear(x, z, 8);
    let best = null, bd = Infinity;
    for (const rec of list) {
      const d = Math.hypot(rec.worldPos[0] - x, rec.worldPos[1] - z);
      if (d <= rec.radius && d < bd) { bd = d; best = rec; }
    }
    return best;
  }

  /**
   * Island discs for the ocean shader's shallowing / foam ring. Up to 8, nearest first.
   * The orchestrator wires this into `water.setNearbyIslands()`; World also pushes it
   * itself each step when an App with a Water is present, so it is never stale.
   * @param {number} x @param {number} z
   * @returns {Array<{x:number,z:number,radius:number,falloff:number}>}
   */
  nearbyIslandDiscs(x, z) {
    const list = this.islandsNear(x, z, 2200);
    const out = this._discScratch;
    out.length = 0;
    for (const r of list) {
      out.push({
        x: r.worldPos[0], z: r.worldPos[1], radius: r.radius,
        falloff: clamp(r.radius * 0.5, 18, 48),
        _d: Math.hypot(r.worldPos[0] - x, r.worldPos[1] - z),
      });
    }
    out.sort((a, b) => a._d - b._d);
    if (out.length > 8) out.length = 8;
    return out;
  }

  /** The first island of the route, for the harness (ARCHITECTURE section 9). */
  firstIsland() {
    const L = this.landmarkById.get('shellsCove') || this.landmarks[0];
    return {
      id: L.id,
      x: L.worldPos[0], z: L.worldPos[1],
      dockX: L.worldPos[0] + L.dockPos[0],
      dockZ: L.worldPos[1] + L.dockPos[1],
      radius: L.radius,
    };
  }

  /**
   * World-space named spawn points of a LOADED island. Local metres in the canvas are
   * relative to the island centre, which is exactly the island's world position.
   * @param {string|IslandInstance} island
   * @returns {Record<string,{x:number,y:number,z:number,yaw:number}>|null}
   */
  spawnPointsOf(island) {
    const inst = typeof island === 'string' ? this.loaded.get(island) : island;
    if (!inst || !inst.record.spawnPoints) return null;
    const out = {};
    const sp = inst.record.spawnPoints;
    for (const k of Object.keys(sp)) {
      const p = sp[k];
      out[k] = { x: inst.centerX + p.x, y: p.y, z: inst.centerZ + p.z, yaw: p.yaw || 0 };
    }
    return out;
  }

  /** Weather bias table nearest to (x,z), or null when far from land. */
  weatherBiasAt(x, z) {
    const rec = this.nearestIsland(x, z);
    if (!rec) return null;
    const d = Math.hypot(rec.worldPos[0] - x, rec.worldPos[1] - z);
    const reach = rec.radius + 900;
    if (d > reach) return null;
    const bias = rec.weatherBias || (LANDMARK_BY_ID.get(rec.id) || {}).weatherBias;
    if (!bias) return null;
    return { bias, influence: 1 - smoothstep(rec.radius * 0.5, reach, d), island: rec };
  }

  // --- terrain queries ----------------------------------------------------

  _instanceAt(x, z) {
    const inside = this._insideIsland;
    if (inside && inside.vol && inside.coversXZ(x, z)) return inside;
    for (const inst of this.loaded.values()) {
      if (inst.vol && inst.coversXZ(x, z)) { this._insideIsland = inst; return inst; }
    }
    return null;
  }

  /**
   * Top solid surface y at (x,z).
   * @returns {number} world metres, or -Infinity over open sea (and over land that has not
   *          streamed in yet — use islandAt() to ask whether land is *placed* there).
   */
  heightAt(x, z) {
    const inst = this._instanceAt(x, z);
    return inst ? inst.heightAt(x, z) : -Infinity;
  }

  /** @returns {number} block id at a world position, 0 (air) outside any island */
  blockAt(x, y, z) {
    const inst = this._instanceAt(x, z);
    return inst ? inst.blockAt(x, y, z) : AIR;
  }

  /**
   * Write a block. Used by the fruit powers that destroy terrain; the affected chunks are
   * re-meshed lazily by the streamer, at the head of the queue.
   * @returns {boolean} true when a block actually changed
   */
  setBlock(x, y, z, id) {
    const inst = this._instanceAt(x, z);
    if (!inst) return false;
    if (!inst.setBlock(x, y, z, id)) return false;
    let list = this.edits.get(inst.id);
    if (!list) { list = []; this.edits.set(inst.id, list); }
    const vx = inst.vxOf(x), vy = inst.vyOf(y), vz = inst.vzOf(z);
    list.push(vx, vy, vz, id);
    this.streamer.invalidate();
    return true;
  }

  /** @returns {boolean} */
  isSolid(x, y, z) {
    const id = this.blockAt(x, y, z);
    return id !== AIR && this.reg.isSolid(id);
  }

  /**
   * Alias of isSolid under the name src/core/physics.js resolves first (ARCHITECTURE section 9,
   * COMBAT's request). One predicate, two names, so nobody has to fall back to heightAt.
   * @returns {boolean}
   */
  isSolidAt(x, y, z) { return this.isSolid(x, y, z); }

  /**
   * Water occupies everything below sea level that terrain does not.
   * @returns {boolean}
   */
  isWater(x, y, z) {
    if (y > 0) return false;
    return !this.isSolid(x, y, z);
  }

  /** Depth of water at (x,z): 0 on land, positive over the sea. */
  depthAt(x, z) {
    const h = this.heightAt(x, z);
    if (h === -Infinity) return 400;
    return Math.max(0, -h);
  }

  /**
   * Voxel DDA raycast against loaded terrain (Amanatides and Woo).
   * @param {{x:number,y:number,z:number}|number[]} origin
   * @param {{x:number,y:number,z:number}|number[]} dir need not be normalised
   * @param {number} maxDist metres
   * @returns {{x:number,y:number,z:number,vx:number,vy:number,vz:number,id:number,
   *            normal:number[],dist:number,island:string}|null}
   */
  raycast(origin, dir, maxDist = 64) {
    const ox = origin.x !== undefined ? origin.x : origin[0];
    const oy = origin.y !== undefined ? origin.y : origin[1];
    const oz = origin.z !== undefined ? origin.z : origin[2];
    let dx = dir.x !== undefined ? dir.x : dir[0];
    let dy = dir.y !== undefined ? dir.y : dir[1];
    let dz = dir.z !== undefined ? dir.z : dir[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-9) return null;
    dx /= len; dy /= len; dz /= len;

    const s = VOXEL_M;
    let vx = Math.floor(ox / s), vy = Math.floor(oy / s), vz = Math.floor(oz / s);
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const inf = Infinity;
    const tDeltaX = dx !== 0 ? Math.abs(s / dx) : inf;
    const tDeltaY = dy !== 0 ? Math.abs(s / dy) : inf;
    const tDeltaZ = dz !== 0 ? Math.abs(s / dz) : inf;
    const bx = (vx + (stepX > 0 ? 1 : 0)) * s;
    const by = (vy + (stepY > 0 ? 1 : 0)) * s;
    const bz = (vz + (stepZ > 0 ? 1 : 0)) * s;
    let tMaxX = dx !== 0 ? (bx - ox) / dx : inf;
    let tMaxY = dy !== 0 ? (by - oy) / dy : inf;
    let tMaxZ = dz !== 0 ? (bz - oz) / dz : inf;
    let nx = 0, ny = 0, nz = 0;
    let t = 0;
    const maxSteps = Math.ceil(maxDist / s) + 3;

    for (let i = 0; i < maxSteps && t <= maxDist; i++) {
      const wx = (vx + 0.5) * s, wy = (vy + 0.5) * s, wz = (vz + 0.5) * s;
      const inst = this._instanceAt(wx, wz);
      if (inst) {
        const id = inst.blockAt(wx, wy, wz);
        if (id !== AIR && this.reg.isSolid(id)) {
          return {
            x: wx, y: wy, z: wz,
            vx, vy, vz, id,
            normal: [nx, ny, nz],
            dist: t,
            island: inst.id,
          };
        }
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        vx += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY < tMaxZ) {
        vy += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
      } else {
        vz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
      }
    }
    return null;
  }

  // --- streaming hooks (called by Streamer) --------------------------------

  /**
   * The nearest island inside the load radius that needs voxels: either never built, or
   * built-then-compacted and now close enough that the LOD will not do any more.
   * @returns {IslandRecord|null}
   */
  nextIslandToBuild() {
    const f = this.focus;
    const list = this.islandsNear(f.x, f.z, this.loadRadius);
    // A compacted island is only worth rebuilding once it is inside the SAME radius that
    // will immediately mark it near. Using a wider band here builds an island, watches the
    // streamer compact it again on the same step because it is still far, and loops.
    const nearBand = this.streamer.nearRadius;
    let best = null, bd = Infinity;
    for (const rec of list) {
      const inst = this.loaded.get(rec.id);
      const d = Math.hypot(rec.worldPos[0] - f.x, rec.worldPos[1] - f.z) - rec.radius;
      if (inst) {
        if (!inst.compacted || d >= nearBand) continue;
      } else if (this.loaded.size >= this.maxIslands) {
        continue;
      }
      if (d < bd) { bd = d; best = rec; }
    }
    return best;
  }

  /** Loaded islands that have fallen outside the unload radius, or over the island cap. */
  islandsToUnload() {
    const f = this.focus;
    const out = [];
    const keep = [];
    for (const inst of this.loaded.values()) {
      const d = Math.hypot(inst.centerX - f.x, inst.centerZ - f.z) - inst.radius;
      if (d > this.unloadRadius) out.push(inst);
      else keep.push({ inst, d });
    }
    if (keep.length > this.maxIslands) {
      keep.sort((a, b) => b.d - a.d);
      for (let i = 0; i < keep.length - this.maxIslands; i++) out.push(keep[i].inst);
    }
    return out;
  }

  /**
   * Build one island's voxel volume and register it. Atomic — the island authoring toolkit
   * has no resumable form — so the streamer treats the cost as debt against later steps.
   * @param {IslandRecord} rec
   * @returns {number} work units spent
   */
  buildIsland(rec) {
    // Rebuilding a compacted island: drop the shell first so chunk state, the surface map
    // and the LOD are all regenerated from one consistent volume.
    const prev = this.loaded.get(rec.id);
    if (prev) {
      this.loaded.delete(rec.id);
      if (this._insideIsland === prev) this._insideIsland = null;
      prev.dispose();
    }
    let built;
    if (rec.kind === 'landmark') {
      built = buildLandmark(LANDMARK_BY_ID.get(rec.id), { B: this.B, seed: this.seed });
    } else {
      built = generateMinorIsland(new Rng(rec.seed), rec.worldPos, rec.difficultyTier, {
        B: this.B, archetype: rec.archetype,
      });
    }
    // The placement record is the authority on identity and position; the build is the
    // authority on the exact radius it ended up with.
    built.id = rec.id;
    built.worldPos = rec.worldPos;
    rec.radius = built.radius;
    rec.maxHeight = built.maxHeight;
    rec.spawnPoints = built.spawnPoints;
    rec.markers = built.markers;
    rec.ambience = built.ambience;
    rec.weatherBias = built.weatherBias;
    rec.musicState = built.musicState;
    rec.dockPos = built.dockPos;
    rec.dockYaw = built.dockYaw;
    rec.description = built.description;
    rec.canvas = built.canvas;

    const inst = new IslandInstance(rec, this.reg, {
      materials: this.materials,
      lodFactor: this.opts.lodFactor,
    });
    inst.attach(this.parent);
    const saved = this.edits.get(rec.id);
    if (saved && saved.length) inst.applyEdits(saved);
    this.loaded.set(rec.id, inst);
    if (this.onIslandLoaded) this.onIslandLoaded(inst);

    // Work estimate scales with the volume actually allocated, which is what the authoring
    // toolkit's cost scales with (rasterise, distance field, column fill, scatter).
    return 2940 + (inst.sx * inst.sy * inst.sz) / 131;
  }

  /** @param {IslandInstance} inst */
  unloadIsland(inst) {
    if (this.onIslandUnloaded) this.onIslandUnloaded(inst);
    this.loaded.delete(inst.id);
    if (this._insideIsland === inst) this._insideIsland = null;
    inst.dispose();
  }

  // --- sea dressing --------------------------------------------------------

  /**
   * Sea features in one sector. Pure in (seed, sector); islands are consulted only through
   * the equally pure placement records, so this never depends on what is loaded.
   * @param {number} sxi @param {number} szi
   * @returns {object[]}
   */
  seaFeaturesInSector(sxi, szi) {
    const key = (sxi + 32768) * 65536 + (szi + 32768);
    let v = this._featureCache.get(key);
    if (v !== undefined) return v;
    if (this._featureCache.size > 2048) this._featureCache.clear();

    const out = [];
    const cx = sxi * SECTOR_M + SECTOR_M / 2;
    const cz = szi * SECTOR_M + SECTOR_M / 2;
    const dens = routeDensity(cx, cz);

    const clearOf = (x, z) => {
      if (crowdsLandmark(x, z)) {
        // Landmarks get a wide berth for islands but only a small one for dressing: a buoy
        // 300 m off the harbour mouth is the point of buoys.
        for (const L of this.landmarks) {
          const d = Math.hypot(L.worldPos[0] - x, L.worldPos[1] - z);
          if (d < L.radius + FEATURE_CLEARANCE_M) return false;
        }
      }
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const r of this._sectorMinors(sxi + dx, szi + dz)) {
            const d = Math.hypot(r.worldPos[0] - x, r.worldPos[1] - z);
            if (d < r.radius + FEATURE_CLEARANCE_M) return false;
          }
        }
      }
      return true;
    };

    const place = (slot, kind, prob, extra) => {
      const h = hash3(sxi, szi, slot, this.seed ^ SALT_FEAT);
      if (hashFloat(h) >= prob) return;
      const x = Math.round(sxi * SECTOR_M + hashFloat(mix32(h)) * SECTOR_M);
      const z = Math.round(szi * SECTOR_M + hashFloat(mix32(mix32(h))) * SECTOR_M);
      if (!clearOf(x, z)) return;
      out.push(Object.assign({
        id: kind + '_' + sxi + '_' + szi + '_' + slot,
        kind, x, z, seed: (mix32(h ^ 0x51ab) >>> 0) || 1,
        variant: mix32(h) % 3,
        yaw: hashFloat(mix32(h ^ 0x7f4a)) * TAU,
      }, extra || {}));
    };

    place(11, 'spire', 0.42);
    place(12, 'spire', 0.26);
    place(21, 'wreck', 0.28);
    if (dens > 0.55) {
      place(31, 'buoy', 0.55);
      place(32, 'buoy', 0.40);
    }
    // One sea event per sector at most: they are set pieces, not scenery.
    const eh = hash3(sxi, szi, 41, this.seed ^ SALT_FEAT);
    if (hashFloat(eh) < 0.17) {
      const kinds = ['whirlpool', 'becalmed', 'seaKing'];
      place(42, kinds[mix32(eh) % 3], 1.0, { radius: 90 + hashFloat(mix32(eh ^ 0x99)) * 110 });
    }

    this._featureCache.set(key, out);
    return out;
  }

  /** Sea features within `radius` of (x,z). */
  seaFeaturesNear(x, z, radius) {
    const out = [];
    const s0x = Math.floor((x - radius) / SECTOR_M), s1x = Math.floor((x + radius) / SECTOR_M);
    const s0z = Math.floor((z - radius) / SECTOR_M), s1z = Math.floor((z + radius) / SECTOR_M);
    for (let sz = s0z; sz <= s1z; sz++) {
      for (let sx = s0x; sx <= s1x; sx++) {
        for (const f of this.seaFeaturesInSector(sx, sz)) {
          if (Math.hypot(f.x - x, f.z - z) < radius) out.push(f);
        }
      }
    }
    return out;
  }

  /**
   * The sea event whose zone contains (x,z), or null. SHIP reads this for the whirlpool
   * pull and the becalmed dead-air; WEATHER reads it to bias the local field.
   * @returns {object|null}
   */
  seaEventAt(x, z) {
    for (const f of this.seaFeaturesNear(x, z, 400)) {
      if (!f.radius) continue;
      const d = Math.hypot(f.x - x, f.z - z);
      if (d < f.radius) return Object.assign({ dist: d, t: 1 - d / f.radius }, f);
    }
    return null;
  }

  /**
   * Horizontal current at a point, in m/s. Only whirlpools produce one; everything else
   * returns zero so a caller can add this unconditionally.
   * @returns {{x:number, z:number}}
   */
  currentAt(x, z) {
    const e = this.seaEventAt(x, z);
    if (!e || e.kind !== 'whirlpool') return { x: 0, z: 0 };
    const dx = e.x - x, dz = e.z - z;
    const d = Math.hypot(dx, dz) || 1;
    const pull = 5.5 * e.t * e.t;
    const swirl = 7.5 * e.t;
    // Inward plus tangential: the two together are what reads as a whirlpool rather than
    // as a magnet.
    return { x: (dx / d) * pull + (-dz / d) * swirl, z: (dz / d) * pull + (dx / d) * swirl };
  }

  // --- sea geometry --------------------------------------------------------

  /**
   * Variants per sea-feature kind. Only one variant is ever built per streaming tick — see
   * _seaVariant. Building the whole bank at once was a 290 ms stall the first time a spire
   * came over the horizon, which is exactly the kind of hitch the profiler exists to catch.
   */
  static SEA_VARIANTS = { spire: 3, wreck: 2, buoy: 1, whirlpool: 1, seaKing: 1, becalmed: 1 };

  /**
   * Author every sea-feature variant up front: nine small volumes, paid during boot where no
   * frame is being presented. Built lazily instead, the first wreck to come over the horizon
   * cost a 48 ms stall in the middle of a sail — measured, which is why this exists.
   */
  prebuildSeaGeometry() {
    if (!this.materials) return 0;
    let n = 0;
    for (const kind of Object.keys(World.SEA_VARIANTS)) {
      for (let v = 0; v < World.SEA_VARIANTS[kind]; v++) {
        const key = kind + ':' + v;
        if (this._seaBank.has(key)) continue;
        this._seaBank.set(key, this._buildSeaVariant(kind, v));
        n++;
      }
    }
    return n;
  }

  /**
   * Fetch one sea-feature variant's geometry. Normally a map hit — prebuildSeaGeometry() has
   * already authored all of them — with a one-per-tick lazy fallback so a World constructed
   * without materials, then given them later, still works.
   * @returns {{solid:THREE.BufferGeometry|null, cutout:THREE.BufferGeometry|null}|null}
   */
  _seaVariant(kind, variant) {
    const count = World.SEA_VARIANTS[kind];
    if (!count || !this.materials) return null;
    const key = kind + ':' + (variant % count);
    const have = this._seaBank.get(key);
    if (have !== undefined) return have;
    if (!this._seaBuildAllowed) return null;
    this._seaBuildAllowed = false;
    const bank = this._buildSeaVariant(kind, variant % count);
    this._seaBank.set(key, bank);
    return bank;
  }

  /** Author one sea-feature variant. Volumes are kept tight: the mesher sweeps every cell. */
  _buildSeaVariant(kind, v) {
    const B = this.B;
    const r = Rng.fromName(this.seed, 'sea:' + kind + v);
    // The cutout pass is a second full sweep of the volume, so it only runs when the volume
    // actually contains an alpha-tested block. Most sea dressing is planks and rock.
    const mk = (c, origin) => {
      let cutout = false;
      for (let i = 0; i < c.vol.data.length && !cutout; i++) {
        const id = c.vol.data[i];
        if (id !== AIR && this.reg.def(id).cutout) cutout = true;
      }
      return {
        solid: meshVolume(c.vol, this.reg, { scale: VOXEL_M, origin, cutoutOnly: false }),
        cutout: cutout ? meshVolume(c.vol, this.reg, { scale: VOXEL_M, origin, cutoutOnly: true }) : null,
      };
    };

    if (kind === 'spire') {
      // Three leaning needles with clearly different silhouettes, tallest last.
      const h = 20 + v * 10;
      const c = new IslandCanvas({ sx: 22, sy: h + 12, sz: 22, seaLevel: 8, B, seed: r.u32() });
      c.cone(11, 11, 0, h, 5.2 - v * 0.6, 0.9, B.rock, { lean: [r.int(-3, 3), r.int(-2, 2)] });
      c.sphere(11, 2, 11, 6.5 - v * 0.5, B.rock, { hemisphere: true, squash: 0.35 });
      for (let k = 0; k < 4 + v; k++) {
        const a = r.f() * TAU;
        c.set(Math.round(11 + Math.cos(a) * 4), 9 + r.int(0, h - 4), Math.round(11 + Math.sin(a) * 4), B.coral);
      }
      return mk(c, [-5.5, -4, -5.5]);
    }

    if (kind === 'wreck') {
      // Half a hull out of the water with its mast still up and its back broken.
      const c = new IslandCanvas({ sx: 44, sy: 26, sz: 20, seaLevel: 8, B, seed: r.u32() });
      shipHull(c, 3, 10, 36, 12, 7, { hull: B.plank, rib: B.woodDark, deck: B.plank, lean: v === 0 ? 4 : -5 });
      c.box(20, 5, 6, 27, 14, 14, 0);
      for (let k = 0; k < 16; k++) c.set(15 + Math.round(k * 0.4), 9 + k, 10 + (v ? 1 : -1), B.wood);
      for (let k = 0; k < 7; k++) c.setAir(17 + k, 19, 10, B.sailShade);
      c.colFill(8, 14, 9, 10, B.barrel);
      return mk(c, [-11, -4, -5]);
    }

    if (kind === 'buoy') {
      // Barrel hull, cage, lamp and a rag of flag — the flag is what reads at 400 m.
      const c = new IslandCanvas({ sx: 12, sy: 26, sz: 12, seaLevel: 6, B, seed: r.u32() });
      c.cyl(6, 6, 3, 8, 2.6, B.barrel);
      c.cyl(6, 6, 9, 9, 3.0, B.metalDark);
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * TAU;
        c.colFill(Math.round(6 + Math.cos(a) * 2), Math.round(6 + Math.sin(a) * 2), 10, 15, B.metal);
      }
      c.cyl(6, 6, 16, 17, 1.6, B.gold);
      c.colFill(6, 6, 18, 22, B.metalDark);
      for (let k = 0; k < 4; k++) c.setAir(7 + k, 21, 6, B.flagRed);
      return mk(c, [-3, -3, -3]);
    }

    if (kind === 'whirlpool') {
      // Concentric rings of foam that the world spins. One draw call, no particle system.
      const c = new IslandCanvas({ sx: 64, sy: 6, sz: 64, seaLevel: 3, B, seed: 7 });
      for (let ring = 0; ring < 4; ring++) {
        const rad = 9 + ring * 6.5;
        const n = 16 + ring * 7;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * TAU + ring * 0.4;
          c.set(Math.round(32 + Math.cos(a) * rad), 3 + (r.u32() & 1), Math.round(32 + Math.sin(a) * rad), B.snow);
        }
      }
      return mk(c, [-16, -1.5, -16]);
    }

    if (kind === 'seaKing') {
      // A dark bulk that moves under the surface and never breaks it. The shadow is the scare.
      const c = new IslandCanvas({ sx: 72, sy: 12, sz: 32, seaLevel: 6, B, seed: 11 });
      c.sphere(24, 6, 16, 9, B.volcanic, { squash: 0.42 });
      c.sphere(42, 6, 16, 6.5, B.volcanic, { squash: 0.4 });
      c.cone(56, 16, 3, 9, 5, 1.2, B.volcanic, { lean: [8, 0] });
      for (let k = 0; k < 9; k++) c.set(15 - k, 7, 16 + Math.round(Math.sin(k * 0.7) * 3), B.volcanic);
      return mk(c, [-18, -3, -8]);
    }

    // becalmed: a raft of drifting timber, so a dead-air zone still has something in it.
    const c = new IslandCanvas({ sx: 36, sy: 10, sz: 36, seaLevel: 4, B, seed: r.u32() });
    for (let k = 0; k < 26; k++) {
      const px = 6 + r.int(0, 20), pz = 6 + r.int(0, 20);
      c.box(px, 4, pz, px + r.int(1, 5), 4, pz + r.int(0, 1), r.chance(0.6) ? B.plank : B.woodDark);
    }
    c.colFill(18, 18, 5, 6, B.barrel);
    for (let k = 0; k < 7; k++) c.setAir(12 + k, 5, 22, B.leaves);
    return mk(c, [-9, -2, -9]);
  }

  _updateSeaFeatures() {
    if (!this.materials || !this.parent) return;
    this._seaBuildAllowed = true;      // at most one variant authored per tick
    const f = this.focus;
    const near = this.seaFeaturesNear(f.x, f.z, SEA_FEATURE_RADIUS_M);
    const seen = new Set();
    for (const feat of near) {
      seen.add(feat.id);
      if (this.activeSea.has(feat.id)) continue;
      const pick = this._seaVariant(feat.kind, feat.variant);
      if (!pick) continue;             // not authored yet; picked up on a later tick
      const group = new THREE.Group();
      group.name = 'sea:' + feat.id;
      if (pick.solid && pick.solid.userData.triangles > 0) {
        group.add(new THREE.Mesh(pick.solid, this.materials.prop || this.materials.terrain));
      }
      if (pick.cutout && pick.cutout.userData.triangles > 0) {
        group.add(new THREE.Mesh(pick.cutout, this.materials.terrainCutout));
      }
      group.position.set(feat.x, 0, feat.z);
      group.rotation.y = feat.yaw;
      this.parent.add(group);
      this.activeSea.set(feat.id, { feat, obj: group });
    }
    for (const [id, entry] of this.activeSea) {
      if (seen.has(id)) continue;
      // Geometry is shared per variant and lives for the session — only the node goes.
      if (entry.obj && entry.obj.parent) entry.obj.parent.remove(entry.obj);
      this.activeSea.delete(id);
    }
  }

  // --- system interface ----------------------------------------------------

  /**
   * One fixed step. Deterministic: nothing here reads the wall clock or the render alpha.
   * @param {number} dt @param {object} app
   */
  step(dt, app) {
    this.time += dt;
    const a = app || this.app;

    // Focus follows the player, then the ship, then the camera — whichever exists. The
    // camera fallback only matters in capture mode, where the render alpha is always 0.
    if (a && !this.opts.manualFocus) {
      // The camera is only a fallback, and only until somebody takes ownership of the
      // focus: once setFocus() has been called, the camera never overrides it again. A
      // harness that drives a voyage by hand would otherwise be silently ignored.
      const p = (a.player && a.player.pos) || (a.ship && a.ship.pos)
        || (this._focusExplicit ? null : (a.camera && a.camera.position));
      if (p) {
        const yaw = (a.player && a.player.yaw) !== undefined ? a.player.yaw
          : (a.ship && a.ship.yaw) !== undefined ? a.ship.yaw : this.focus.yaw;
        if (Array.isArray(p)) this.setFocus(p[0], p[1], p[2], yaw);
        else this.setFocus(p.x, p.y, p.z, yaw);
      }
    }

    this.streamer.step();
    // Sea dressing and the ocean shader's island discs change on the scale of seconds, not
    // frames. Throttling them keeps the per-step allocation of an idle voyage near zero.
    this._tick = (this._tick + 1) % 10;
    if (this._tick === 0) this._updateSeaFeatures();

    // Docking / arrival events for QUEST. Only fires on a transition, never per frame.
    const here = this.islandAt(this.focus.x, this.focus.z);
    const q = a && (a.quests || a.quest);
    if (here && here.id !== this._lastIslandId) {
      this._lastIslandId = here.id;
      if (!this.visited.has(here.id)) this.visited.add(here.id);
      if (q && q.notify) q.notify('islandDocked', { islandId: here.id });
    } else if (!here && this._lastIslandId) {
      this._lastIslandId = null;
    }
    if (here && q && q.notify) this._notifyAreas(here, q);

    if (this._tick === 5 && this.driveWater && a && a.water && a.water.setNearbyIslands) {
      a.water.setNearbyIslands(this.nearbyIslandDiscs(this.focus.x, this.focus.z));
    }
  }

  _notifyAreas(rec, q) {
    const inst = this.loaded.get(rec.id);
    if (!inst || !inst.record.spawnPoints) return;
    if (!this._areaSeen) this._areaSeen = new Set();
    // Re-arm every trigger when quest progress changes. The dedup set exists so standing on a
    // spawn point does not spam areaEntered sixty times a second — but it also swallowed the
    // event forever for any point the player was ALREADY on when a quest started (the dock,
    // where the game begins, being the first casualty). Objective handlers are idempotent, so
    // a duplicate event after the clear is harmless.
    if (q && q.progressRevision !== undefined && q.progressRevision !== this._areaRev) {
      this._areaRev = q.progressRevision;
      this._areaSeen.clear();
    }
    const sp = inst.record.spawnPoints;
    const f = this.focus;
    for (const name of Object.keys(sp)) {
      const p = sp[name];
      const d = Math.hypot(inst.centerX + p.x - f.x, inst.centerZ + p.z - f.z);
      const key = rec.id + '.' + name;
      if (d < 6) {
        if (this._areaSeen.has(key)) continue;
        this._areaSeen.add(key);
        q.notify('areaEntered', name === 'secret' ? { point: key, dist: d, secret: key } : { point: key, dist: d });
      } else if (d > 12) {
        this._areaSeen.delete(key);
      }
    }
  }

  /**
   * Render-only interpolation. Floats the sea dressing on the real wave surface and spins
   * the whirlpools. No simulation state is touched.
   * @param {number} alpha @param {object} app
   */
  preRender(alpha, app) {
    const a = app || this.app;
    const water = a && a.water;
    const t = this.time;
    for (const entry of this.activeSea.values()) {
      const o = entry.obj;
      if (!o) continue;
      const feat = entry.feat;
      if (feat.kind === 'whirlpool') {
        o.rotation.y = feat.yaw - t * 0.55;
        o.position.y = -1.2 + Math.sin(t * 0.6) * 0.2;
        continue;
      }
      if (feat.kind === 'seaKing') {
        // A slow circuit under the surface. Never breaks the water: the shadow IS the scare.
        const ang = feat.yaw + t * 0.055;
        o.position.x = feat.x + Math.cos(ang) * 120;
        o.position.z = feat.z + Math.sin(ang) * 120;
        o.rotation.y = ang + Math.PI * 0.5;
        o.position.y = -6.5 + Math.sin(t * 0.3) * 0.8;
        continue;
      }
      if (!water || !water.heightAt) continue;
      const h = water.heightAt(feat.x, feat.z);
      o.position.y = feat.kind === 'spire' ? 0 : h;
      if (feat.kind === 'buoy' || feat.kind === 'becalmed') {
        const hx = water.heightAt(feat.x + 2, feat.z);
        const hz = water.heightAt(feat.x, feat.z + 2);
        o.rotation.z = clamp((h - hx) * 0.35, -0.4, 0.4);
        o.rotation.x = clamp((hz - h) * 0.35, -0.4, 0.4);
      }
    }
  }

  // --- save ----------------------------------------------------------------

  /** @returns {object} save payload; see ARCHITECTURE section 7 */
  serialize() {
    const edits = {};
    for (const [id, list] of this.edits) if (list.length) edits[id] = list.slice();
    return {
      seed: this.seed,
      visited: [...this.visited],
      edits,
    };
  }

  /** @param {object} o */
  deserialize(o) {
    if (!o) return;
    if (o.visited) { this.visited = new Set(o.visited); }
    this.edits.clear();
    if (o.edits) {
      for (const id of Object.keys(o.edits)) this.edits.set(id, o.edits[id].slice());
    }
    // Any island already resident has to be rebuilt so the saved edits land in its volume.
    for (const inst of [...this.loaded.values()]) this.unloadIsland(inst);
    this.streamer.invalidate();
  }

  /** Aggregate numbers for the profiler and the self-check. */
  report() {
    let volumeBytes = 0, chunkTris = 0, lodTris = 0;
    for (const inst of this.loaded.values()) {
      if (inst.vol) volumeBytes += inst.vol.data.byteLength + inst.top.byteLength;
      chunkTris += inst.triangles;
      lodTris += inst.lodTriangles;
    }
    return Object.assign({}, this.streamer.stats, {
      islands: this.loaded.size,
      volumeBytes,
      chunkTriangles: chunkTris,
      lodTriangles: lodTris,
      seaFeatures: this.activeSea.size,
      visited: this.visited.size,
    });
  }

  dispose() {
    for (const inst of [...this.loaded.values()]) this.unloadIsland(inst);
    for (const entry of this.activeSea.values()) {
      if (entry.obj && entry.obj.parent) entry.obj.parent.remove(entry.obj);
    }
    this.activeSea.clear();
    if (this._seaBank) {
      for (const bank of this._seaBank.values()) {
        if (!bank) continue;
        if (bank.solid) bank.solid.dispose();
        if (bank.cutout) bank.cutout.dispose();
      }
      this._seaBank.clear();
    }
  }
}

/**
 * Factory used by src/game.js.
 * @param {object} app
 * @param {object} [opts]
 * @returns {World}
 */
export function createWorldSystem(app, opts = {}) {
  return new World(app, opts);
}

export { CHUNK_X, CHUNK_Y, CHUNK_Z };
export default World;
