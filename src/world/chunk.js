// Terrain chunking.
//
// An island is authored as ONE voxel volume (see gen/islandbuild.js). This file is the
// bridge between that volume and the renderer: it slices the volume into 32x96x32 chunks
// (ARCHITECTURE section 3), greedy-meshes them on demand into an opaque mesh plus a cutout
// mesh, and keeps a single coarse LOD mesh so an island still reads as a silhouette from
// kilometres away without paying for ninety chunk draws.
//
// WHY a per-island chunk grid rather than a global one: islands never overlap (placement
// enforces a 900 m minimum separation and the widest island is 192 m across), so a chunk is
// always addressable as (island, cx, cy, cz). That keeps the volume contiguous, makes
// neighbour sampling across a chunk seam a plain array read, and lets an island unload as
// one object instead of leaving orphan chunks behind.
//
// WHY the mesher trims to the occupied bounding box: meshVolume() sweeps every cell of the
// volume it is handed, six times. A full 32x96x32 chunk is 98304 cells whether or not it is
// 90% air. Trimming to the occupied box is the single biggest win in the streaming budget
// and it costs one extra scan of the same cells.

import * as THREE from 'three';
import { VoxelVolume, meshVolume, AIR } from '../gen/voxel.js';
import { VOXEL_M } from '../gen/islandbuild.js';

/** Chunk dimensions in voxels. ARCHITECTURE section 3 fixes these. */
export const CHUNK_X = 32;
export const CHUNK_Y = 96;
export const CHUNK_Z = 32;

/** Chunk dimensions in metres. */
export const CHUNK_W = CHUNK_X * VOXEL_M;   // 16 m
export const CHUNK_H = CHUNK_Y * VOXEL_M;   // 48 m

/**
 * Voxels per LOD cell. 8 gives a 4 m LOD voxel: about four pixels at a kilometre, which is
 * exactly the chunky read the art bar asks for, and it costs a quarter of what factor 4 did.
 */
export const LOD_FACTOR = 8;

/** Chunk lifecycle states. */
export const CHUNK = Object.freeze({
  COLD: 0,      // never looked at
  EMPTY: 1,     // scanned, holds no solid voxels, will never produce a mesh
  MESHED: 2,    // has live geometry
  DIRTY: 3,     // had geometry, a setBlock invalidated it
});

const KEY_STRIDE = 4096;

/**
 * Pack a chunk coordinate into one integer key.
 * @param {number} cx @param {number} cy @param {number} cz
 * @returns {number}
 */
export function chunkKey(cx, cy, cz) {
  return (cy * KEY_STRIDE + cz) * KEY_STRIDE + cx;
}

/**
 * Top solid voxel y per column, or -1 for an empty column.
 * One linear pass in memory order: the index of (x,y,z) is y*plane + (z*sx + x), so the
 * column index is loop-invariant inside a y slice and the walk is fully sequential.
 * @param {VoxelVolume} vol
 * @returns {Int16Array} length sx*sz
 */
export function buildSurfaceMap(vol) {
  const sx = vol.sx, sy = vol.sy, sz = vol.sz;
  const data = vol.data;
  const plane = sx * sz;
  const top = new Int16Array(plane).fill(-1);
  for (let y = 0; y < sy; y++) {
    const base = y * plane;
    for (let c = 0; c < plane; c++) if (data[base + c] !== AIR) top[c] = y;
  }
  return top;
}

/** Scratch volumes, reused across chunk meshes so streaming does not churn the heap. */
const scratchPool = new Map();

/**
 * Borrow a zeroed scratch volume of the given dimensions.
 * @param {number} sx @param {number} sy @param {number} sz
 * @returns {VoxelVolume}
 */
export function scratchVolume(sx, sy, sz) {
  const key = (sx * 1024 + sy) * 1024 + sz;
  let v = scratchPool.get(key);
  if (!v) {
    if (scratchPool.size > 24) scratchPool.clear();   // bounded: chunk dims cluster tightly
    v = new VoxelVolume(sx, sy, sz);
    scratchPool.set(key, v);
  } else {
    v.data.fill(0);
  }
  return v;
}

/** One chunk of one island. Geometry is owned here and disposed here. */
export class Chunk {
  constructor(cx, cy, cz) {
    this.cx = cx; this.cy = cy; this.cz = cz;
    this.key = chunkKey(cx, cy, cz);
    this.state = CHUNK.COLD;
    /** @type {THREE.Mesh|null} */ this.opaque = null;
    /** @type {THREE.Mesh|null} */ this.cutout = null;
    this.triangles = 0;
    /** Squared distance from the streaming focus, refreshed by the streamer. */
    this.dist2 = Infinity;
  }

  /** Drop geometry and detach from the island group. */
  dispose(group) {
    for (const m of [this.opaque, this.cutout]) {
      if (!m) continue;
      if (group) group.remove(m);
      m.geometry.dispose();
    }
    this.opaque = null;
    this.cutout = null;
    this.triangles = 0;
    if (this.state === CHUNK.MESHED || this.state === CHUNK.DIRTY) this.state = CHUNK.COLD;
  }
}

/**
 * A loaded island: its voxel volume, its surface map, its chunk table and its meshes.
 * Everything the World needs to answer a query about that island lives here.
 */
export class IslandInstance {
  /**
   * @param {object} record placement + build record (buildLandmark / generateMinorIsland)
   * @param {import('../gen/voxel.js').BlockRegistry} reg
   * @param {{materials?:object, lodFactor?:number}} opts
   */
  constructor(record, reg, opts = {}) {
    const c = record.canvas;
    if (!c) throw new Error('world/chunk: island record has no canvas — build it first');
    this.record = record;
    this.id = record.id;
    this.kind = record.kind;
    this.reg = reg;
    this.canvas = c;
    this.vol = c.vol;
    this.sx = c.sx; this.sy = c.sy; this.sz = c.sz;
    this.seaLevel = c.seaLevel;
    this.materials = opts.materials || null;
    this.lodFactor = opts.lodFactor || LOD_FACTOR;

    // Group space: the island group sits at the volume corner projected to sea level, so
    // geometry coordinates stay under 200 m even 24 km from the world origin.
    this.originX = record.worldPos[0] - (this.sx >> 1) * VOXEL_M;
    this.originZ = record.worldPos[1] - (this.sz >> 1) * VOXEL_M;
    this.centerX = record.worldPos[0];
    this.centerZ = record.worldPos[1];
    this.radius = record.radius;

    this.nx = Math.ceil(this.sx / CHUNK_X);
    this.ny = Math.ceil(this.sy / CHUNK_Y);
    this.nz = Math.ceil(this.sz / CHUNK_Z);

    this.top = buildSurfaceMap(this.vol);
    this.chunkTop = this._buildChunkColumnTops();

    /** Block ids that are alpha-cutout, as a flat lookup. */
    this.cutoutOf = new Uint8Array(reg.defs.length);
    for (let i = 1; i < reg.defs.length; i++) this.cutoutOf[i] = reg.defs[i].cutout ? 1 : 0;

    /** @type {Map<number, Chunk>} */
    this.chunks = new Map();
    /** Chunks that could hold geometry. Ordering is the streamer's business, not ours. */
    this.candidates = this._buildCandidates();

    this.group = null;
    this.lodGroup = null;
    this.lodBuilt = false;
    this.lodTriangles = 0;
    this.near = false;          // true once chunk meshes have taken over from the LOD
    this.meshedChunks = 0;
    this.triangles = 0;
    /** Player edits as a flat [vx,vy,vz,id,...] list. Replayed on reload, saved to disk. */
    this.edits = [];
    this._parent = null;
    /** True once the voxel volume has been given back; see compact(). */
    this.compacted = false;
  }

  // --- geometry roots -----------------------------------------------------

  /**
   * Create the scene groups. Only meaningful when a renderer is present; headless callers
   * (tools/check-world.mjs) skip it and still get every query and every work measurement.
   * @param {THREE.Object3D} parent
   */
  attach(parent) {
    if (!parent || this.group) return;
    this.group = new THREE.Group();
    this.group.name = 'island:' + this.id;
    this.group.position.set(this.originX, -this.seaLevel * VOXEL_M, this.originZ);
    this.lodGroup = new THREE.Group();
    this.lodGroup.name = 'islandLod:' + this.id;
    this.lodGroup.position.copy(this.group.position);
    parent.add(this.group, this.lodGroup);
    this._parent = parent;
  }

  // --- coordinate conversion ---------------------------------------------

  /** World metres to volume voxel x. May be out of range; callers must check. */
  vxOf(x) { return Math.floor((x - this.originX) / VOXEL_M); }
  vzOf(z) { return Math.floor((z - this.originZ) / VOXEL_M); }
  vyOf(y) { return Math.floor(y / VOXEL_M) + this.seaLevel; }
  /** Volume voxel y to world metres (the BOTTOM face of that voxel). */
  worldY(vy) { return (vy - this.seaLevel) * VOXEL_M; }

  /** Is this world column inside the island's voxel volume? */
  coversXZ(x, z) {
    const vx = this.vxOf(x), vz = this.vzOf(z);
    return vx >= 0 && vz >= 0 && vx < this.sx && vz < this.sz;
  }

  // --- queries ------------------------------------------------------------

  /**
   * World y of the walkable surface at (x,z): the top face of the highest solid voxel.
   * @returns {number} -Infinity when the column holds nothing.
   */
  heightAt(x, z) {
    const vx = this.vxOf(x), vz = this.vzOf(z);
    if (vx < 0 || vz < 0 || vx >= this.sx || vz >= this.sz) return -Infinity;
    const t = this.top[vz * this.sx + vx];
    if (t < 0) return -Infinity;
    return this.worldY(t + 1);
  }

  /** @returns {number} block id, AIR outside the volume or once the island is compacted */
  blockAt(x, y, z) {
    if (!this.vol) return AIR;
    const vx = this.vxOf(x), vz = this.vzOf(z), vy = this.vyOf(y);
    if (vx < 0 || vz < 0 || vy < 0 || vx >= this.sx || vz >= this.sz || vy >= this.sy) return AIR;
    return this.vol.data[(vy * this.sz + vz) * this.sx + vx];
  }

  /**
   * Write a block and invalidate every chunk that can see it.
   * @returns {boolean} true when something actually changed
   */
  setBlock(x, y, z, id) {
    if (!this.vol) return false;
    const vx = this.vxOf(x), vz = this.vzOf(z), vy = this.vyOf(y);
    if (vx < 0 || vz < 0 || vy < 0 || vx >= this.sx || vz >= this.sz || vy >= this.sy) return false;
    const i = (vy * this.sz + vz) * this.sx + vx;
    if (this.vol.data[i] === id) return false;
    this.vol.data[i] = id;
    this.edits.push(vx, vy, vz, id);

    // Surface map: incremental update. A full column rescan only happens when the block
    // that was removed WAS the surface, which is the rare case.
    const col = vz * this.sx + vx;
    const t = this.top[col];
    if (id !== AIR) {
      if (vy > t) this.top[col] = vy;
    } else if (vy === t) {
      let ny = vy - 1;
      while (ny >= 0 && this.vol.data[(ny * this.sz + vz) * this.sx + vx] === AIR) ny--;
      this.top[col] = ny;
    }
    const ck = ((vz / CHUNK_Z) | 0) * this.nx + ((vx / CHUNK_X) | 0);
    if (this.top[col] > this.chunkTop[ck]) this.chunkTop[ck] = this.top[col];

    // A face on the boundary belongs to the neighbouring chunk's mesh too, so dirty every
    // chunk within one voxel of the edit.
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          this._dirty(((vx + dx) / CHUNK_X) | 0, ((vy + dy) / CHUNK_Y) | 0, ((vz + dz) / CHUNK_Z) | 0);
        }
      }
    }
    return true;
  }

  _dirty(cx, cy, cz) {
    if (cx < 0 || cy < 0 || cz < 0 || cx >= this.nx || cy >= this.ny || cz >= this.nz) return;
    const k = chunkKey(cx, cy, cz);
    let ch = this.chunks.get(k);
    if (!ch) {
      ch = new Chunk(cx, cy, cz);
      this.chunks.set(k, ch);
      this.candidates.push(ch);
      return;
    }
    if (ch.state === CHUNK.MESHED) ch.state = CHUNK.DIRTY;
    else if (ch.state === CHUNK.EMPTY) ch.state = CHUNK.COLD;
  }

  /**
   * Replay a saved edit list. Called immediately after the island is built so that a
   * reloaded world looks exactly like the one that was saved.
   * @param {number[]} flat [vx,vy,vz,id, ...]
   */
  applyEdits(flat) {
    if (!flat || !flat.length) return;
    for (let i = 0; i + 3 < flat.length; i += 4) {
      const vx = flat[i], vy = flat[i + 1], vz = flat[i + 2], id = flat[i + 3];
      if (vx < 0 || vy < 0 || vz < 0 || vx >= this.sx || vy >= this.sy || vz >= this.sz) continue;
      this.setBlock(
        this.originX + (vx + 0.5) * VOXEL_M,
        this.worldY(vy) + 0.5 * VOXEL_M,
        this.originZ + (vz + 0.5) * VOXEL_M,
        id,
      );
    }
  }

  // --- chunk bookkeeping --------------------------------------------------

  _buildChunkColumnTops() {
    const nx = Math.ceil(this.sx / CHUNK_X), nz = Math.ceil(this.sz / CHUNK_Z);
    const out = new Int16Array(nx * nz).fill(-1);
    for (let z = 0; z < this.sz; z++) {
      const cz = (z / CHUNK_Z) | 0;
      const row = z * this.sx;
      for (let x = 0; x < this.sx; x++) {
        const t = this.top[row + x];
        if (t < 0) continue;
        const k = cz * nx + ((x / CHUNK_X) | 0);
        if (t > out[k]) out[k] = t;
      }
    }
    return out;
  }

  /**
   * Chunks that could possibly hold geometry: the chunk column must contain at least one
   * non-empty voxel column, and the chunk's y band must start at or below that column's
   * top. This prunes roughly two thirds of the grid before a single cell is read.
   */
  _buildCandidates() {
    const out = [];
    for (let cz = 0; cz < this.nz; cz++) {
      for (let cx = 0; cx < this.nx; cx++) {
        const maxTop = this.chunkTop[cz * this.nx + cx];
        if (maxTop < 0) continue;
        const topChunk = Math.min(this.ny - 1, (maxTop / CHUNK_Y) | 0);
        for (let cy = 0; cy <= topChunk; cy++) {
          const ch = new Chunk(cx, cy, cz);
          this.chunks.set(ch.key, ch);
          out.push(ch);
        }
      }
    }
    return out;
  }

  /**
   * World-space centre of a chunk, in metres.
   * @param {Chunk} ch @param {{x:number,y:number,z:number}} [out]
   */
  chunkCenter(ch, out) {
    const o = out || { x: 0, y: 0, z: 0 };
    o.x = this.originX + (ch.cx * CHUNK_X + CHUNK_X / 2) * VOXEL_M;
    o.y = this.worldY(ch.cy * CHUNK_Y + CHUNK_Y / 2);
    o.z = this.originZ + (ch.cz * CHUNK_Z + CHUNK_Z / 2) * VOXEL_M;
    return o;
  }

  // --- meshing ------------------------------------------------------------

  /**
   * Mesh one chunk into an opaque mesh plus a cutout mesh.
   *
   * Three trims decide whether this costs 4 ms or 15 ms, and all three exist because
   * meshVolume() sweeps every cell of whatever volume it is handed, six times:
   *   1. the opaque blocks and the cutout blocks get SEPARATE bounding boxes. Foliage lives
   *      in a thin canopy band, so the cutout pass usually sweeps a tenth of the chunk.
   *   2. the opaque box's floor is raised past any run of completely solid slices at the
   *      bottom of the chunk. An island's shelf is dozens of layers of buried rock whose
   *      faces are all interior; only the topmost of those layers can produce a face.
   *   3. the box's ceiling comes from the chunk-column height map, so the empty sky above
   *      a chunk is never swept at all.
   *
   * @param {Chunk} ch
   * @returns {number} work spent, in work units — never milliseconds, because the streaming
   *          budget has to produce the same schedule on every machine.
   */
  meshChunk(ch) {
    const wasMeshed = ch.state === CHUNK.MESHED || ch.state === CHUNK.DIRTY;
    if (wasMeshed) {
      this.triangles -= ch.triangles;
      ch.dispose(this.group);
      this.meshedChunks--;
    }

    const sx = this.sx, sz = this.sz;
    const data = this.vol.data;
    const plane = sx * sz;
    const x0 = ch.cx * CHUNK_X, z0 = ch.cz * CHUNK_Z, y0 = ch.cy * CHUNK_Y;
    const x1 = Math.min(sx, x0 + CHUNK_X);
    const z1 = Math.min(sz, z0 + CHUNK_Z);
    const colTop = this.chunkTop[ch.cz * this.nx + ch.cx];
    const y1 = Math.min(this.sy, y0 + CHUNK_Y, colTop + 1);
    const area = Math.max(0, (x1 - x0) * (z1 - z0));

    // ox* is the opaque box, cx* the cutout box.
    let ox0 = 1 << 30, oy0 = 1 << 30, oz0 = 1 << 30, ox1 = -1, oy1 = -1, oz1 = -1;
    let kx0 = 1 << 30, ky0 = 1 << 30, kz0 = 1 << 30, kx1 = -1, ky1 = -1, kz1 = -1;
    let opaque = 0, cut = 0;
    let solidRun = true, firstGap = y1;
    for (let y = y0; y < y1; y++) {
      const yb = y * plane;
      let sliceSolid = 0;
      for (let z = z0; z < z1; z++) {
        const row = yb + z * sx;
        for (let x = x0; x < x1; x++) {
          const id = data[row + x];
          if (id === AIR) continue;
          sliceSolid++;
          if (this.cutoutOf[id]) {
            cut++;
            if (x < kx0) kx0 = x;
            if (x > kx1) kx1 = x;
            if (y < ky0) ky0 = y;
            if (y > ky1) ky1 = y;
            if (z < kz0) kz0 = z;
            if (z > kz1) kz1 = z;
          } else {
            opaque++;
            if (x < ox0) ox0 = x;
            if (x > ox1) ox1 = x;
            if (y < oy0) oy0 = y;
            if (y > oy1) oy1 = y;
            if (z < oz0) oz0 = z;
            if (z > oz1) oz1 = z;
          }
        }
      }
      if (solidRun) {
        if (sliceSolid === area) firstGap = y + 1;
        else solidRun = false;
      }
    }
    const scanned = Math.max(0, area * (y1 - y0));
    let work = 37 + scanned / 20;

    if (opaque + cut === 0) {
      ch.state = CHUNK.EMPTY;
      ch.triangles = 0;
      return work;
    }
    // Keep the LAST fully solid slice: its top faces are the ones that can still be seen
    // where the slice above it is not solid.
    if (opaque > 0 && firstGap > oy0 + 1) oy0 = Math.min(firstGap - 1, oy1);

    const self = this;
    let tris = 0;
    const pass = (bx0, by0, bz0, bx1, by1, bz1, cutoutOnly, materialKey) => {
      const w = bx1 - bx0 + 1, h = by1 - by0 + 1, d = bz1 - bz0 + 1;
      const sub = scratchVolume(w, h, d);
      for (let y = 0; y < h; y++) {
        const src = (by0 + y) * plane;
        const dst = y * (w * d);
        for (let z = 0; z < d; z++) {
          const srow = src + (bz0 + z) * sx + bx0;
          const drow = dst + z * w;
          for (let x = 0; x < w; x++) sub.data[drow + x] = data[srow + x];
        }
      }
      // Neighbour lookups reach into the parent volume so a face at a chunk seam is hidden
      // exactly as in a single-volume mesh. Without this every chunk boundary becomes a
      // wall of invisible-but-drawn quads and the triangle count roughly doubles.
      const sample = (x, y, z) => {
        const ax = x + bx0, ay = y + by0, az = z + bz0;
        if (ax < 0 || ay < 0 || az < 0 || ax >= sx || ay >= self.sy || az >= sz) return AIR;
        return data[(ay * sz + az) * sx + ax];
      };
      // ORIGIN IS IN GROUP SPACE, NOT WORLD SPACE — all three components. The island group
      // is already translated to (originX, -seaLevel*VOXEL_M, originZ) by attach(), so a
      // voxel at (vx,vy,vz) must be emitted at (vx,vy,vz)*VOXEL_M and nothing else.
      // This line used to read `this.worldY(by0)`, which is (by0 - seaLevel)*VOXEL_M — a
      // WORLD y. Adding it to a group that already carries -seaLevel*VOXEL_M subtracted the
      // sea level twice and drew every chunk seaLevel*VOXEL_M = 12 m below where heightAt(),
      // blockAt() and the physics all said it was. The island rendered fully submerged and
      // anything standing on the real surface — the player, props, NPCs — appeared to float
      // over open water.
      const origin = [bx0 * VOXEL_M, by0 * VOXEL_M, bz0 * VOXEL_M];
      const geo = meshVolume(sub, this.reg, { scale: VOXEL_M, origin, sample, cutoutOnly });
      work += (w * h * d) / 6.6 + geo.userData.triangles / 15;
      if (geo.userData.triangles > 0) {
        const mesh = this._makeMesh(geo, materialKey, ch);
        if (materialKey === 'terrainCutout') ch.cutout = mesh; else ch.opaque = mesh;
        tris += geo.userData.triangles;
      } else geo.dispose();
    };

    if (opaque > 0) pass(ox0, oy0, oz0, ox1, oy1, oz1, false, 'terrain');
    if (cut > 0) pass(kx0, ky0, kz0, kx1, ky1, kz1, true, 'terrainCutout');

    ch.triangles = tris;
    this.triangles += tris;
    this.meshedChunks++;
    ch.state = CHUNK.MESHED;
    return work;
  }

  _makeMesh(geo, materialKey, ch) {
    const mat = this.materials ? this.materials[materialKey] : null;
    if (!mat || !this.group) { geo.dispose(); return null; }
    const m = new THREE.Mesh(geo, mat);
    m.name = this.id + ':' + ch.cx + ',' + ch.cy + ',' + ch.cz + ':' + materialKey;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    m.visible = this.near;
    this.group.add(m);
    return m;
  }

  /**
   * Build the distance mesh: one column per LOD cell, height taken from the surface map.
   * It never reads the volume interior, so it costs a fraction of a chunk, and it is what
   * makes an island legible from two kilometres for two draw calls.
   * @returns {number} work units
   */
  buildLod() {
    if (this.lodBuilt) return 0;
    this.lodBuilt = true;
    const f = this.lodFactor;
    const sx = this.sx, sz = this.sz;
    const baseVy = Math.max(0, this.seaLevel - 8);
    // Crop to the columns that actually hold something above the LOD floor. A minor island
    // occupies a fraction of its volume's footprint, and the sweep cost is per cell.
    let maxTop = -1, cx0 = sx, cz0 = sz, cx1 = -1, cz1 = -1;
    for (let z = 0; z < sz; z++) {
      const row = z * sx;
      for (let x = 0; x < sx; x++) {
        const t = this.top[row + x];
        if (t < baseVy) continue;
        if (t > maxTop) maxTop = t;
        if (x < cx0) cx0 = x;
        if (x > cx1) cx1 = x;
        if (z < cz0) cz0 = z;
        if (z > cz1) cz1 = z;
      }
    }
    if (maxTop < baseVy) return 40;

    const lx = Math.ceil((cx1 - cx0 + 1) / f), lz = Math.ceil((cz1 - cz0 + 1) / f);
    const ly = Math.ceil((maxTop - baseVy + 1) / f);
    const lod = new VoxelVolume(lx, ly, lz);
    const data = this.vol.data;
    let anyCutout = false;

    for (let z = 0; z < lz; z++) {
      for (let x = 0; x < lx; x++) {
        // Take the TALLEST column in the group, not the average: averaging a coastline
        // erodes the silhouette, which is the one thing the LOD exists to preserve.
        let best = -1, bx = 0, bz = 0;
        for (let dz = 0; dz < f; dz++) {
          const zz = cz0 + z * f + dz;
          if (zz > cz1) break;
          const row = zz * sx;
          for (let dx = 0; dx < f; dx++) {
            const xx = cx0 + x * f + dx;
            if (xx > cx1) break;
            const t = this.top[row + xx];
            if (t > best) { best = t; bx = xx; bz = zz; }
          }
        }
        if (best < baseVy) continue;
        const surfId = data[(best * sz + bz) * sx + bx];
        const bodyVy = Math.max(baseVy, best - f * 2);
        const bodyId = data[(bodyVy * sz + bz) * sx + bx] || surfId;
        if (this.cutoutOf[surfId]) anyCutout = true;
        const hCells = Math.min(ly, Math.ceil((best - baseVy + 1) / f));
        for (let yy = 0; yy < hCells; yy++) lod.set(x, yy, z, yy === hCells - 1 ? surfId : bodyId);
      }
    }

    // Group space, same rule as meshChunk(): the lodGroup carries the -seaLevel*VOXEL_M
    // offset, so the LOD floor voxel `baseVy` is emitted at baseVy*VOXEL_M, not worldY(baseVy).
    const origin = [cx0 * VOXEL_M, baseVy * VOXEL_M, cz0 * VOXEL_M];
    const scale = f * VOXEL_M;
    let tris = 0;
    const passes = anyCutout
      ? [[false, 'terrain', 'lod'], [true, 'terrainCutout', 'lodCutout']]
      : [[false, 'terrain', 'lod']];
    for (const [cutoutOnly, key, name] of passes) {
      const geo = meshVolume(lod, this.reg, { scale, origin, cutoutOnly });
      if (geo.userData.triangles > 0 && this.materials && this.lodGroup) {
        const m = new THREE.Mesh(geo, this.materials[key]);
        m.name = this.id + ':' + name;
        m.matrixAutoUpdate = false;
        m.updateMatrix();
        this.lodGroup.add(m);
        tris += geo.userData.triangles;
      } else {
        tris += geo.userData.triangles;
        geo.dispose();
      }
    }
    this.lodTriangles = tris;
    if (this.lodGroup) this.lodGroup.visible = !this.near;
    return 390 + (lx * ly * lz) * (anyCutout ? 2.4 : 1.2) + tris / 2;
  }

  /**
   * Swap between the LOD silhouette and the real chunk meshes. Called from step(), never
   * from preRender, so the swap point is a function of simulation state alone.
   * @param {boolean} near
   */
  setNear(near) {
    if (this.near === near) return;
    this.near = near;
    if (this.lodGroup) this.lodGroup.visible = !near;
    if (!this.group) return;
    for (const m of this.group.children) m.visible = near;
  }

  /** Resident chunk meshes (a chunk counts once whether or not it has a cutout half). */
  get residentChunks() { return this.meshedChunks; }

  /**
   * Give back the voxel volume but keep the island visible and queryable at distance.
   *
   * The volume is 95% of an island's memory — 35 MB for a landmark — and past a kilometre
   * nothing reads it: the LOD silhouette is what is on screen, and the only query that still
   * has to answer is heightAt(), which the surface map serves on its own. A twenty-minute
   * voyage touches a dozen islands; without this, resident memory is the sum of all of them.
   * Coming back inside the near radius rebuilds the volume from the seed, which is exactly
   * what the determinism contract guarantees is safe.
   */
  compact() {
    if (!this.vol || this.near) return 0;
    const freed = this.vol.data.byteLength;
    for (const ch of this.chunks.values()) ch.dispose(this.group);
    this.meshedChunks = 0;
    this.triangles = 0;
    this.vol = null;
    this.canvas = null;
    if (this.record) this.record.canvas = null;
    this.compacted = true;
    return freed;
  }

  /**
   * Drop one chunk's geometry. Used by the resident-memory cap; the chunk goes back to COLD
   * and will be re-meshed if the player comes back.
   * @returns {number} triangles freed
   */
  evictChunk(ch) {
    if (ch.state !== CHUNK.MESHED && ch.state !== CHUNK.DIRTY) return 0;
    const tris = ch.triangles;
    ch.dispose(this.group);
    this.meshedChunks--;
    this.triangles -= tris;
    return tris;
  }

  dispose() {
    for (const ch of this.chunks.values()) ch.dispose(this.group);
    this.chunks.clear();
    this.candidates.length = 0;
    if (this.lodGroup) {
      for (const m of this.lodGroup.children) m.geometry.dispose();
      this.lodGroup.clear();
    }
    if (this._parent) {
      if (this.group) this._parent.remove(this.group);
      if (this.lodGroup) this._parent.remove(this.lodGroup);
    }
    this.group = null;
    this.lodGroup = null;
    this.meshedChunks = 0;
    this.triangles = 0;
    this.lodTriangles = 0;
    // The volume is the big allocation — up to 47 MB for a 384x160x384 landmark. Dropping
    // these references is what makes a twenty-minute voyage memory-stable.
    this.vol = null;
    this.canvas = null;
    this.top = null;
    this.chunkTop = null;
    if (this.record) this.record.canvas = null;
  }
}
