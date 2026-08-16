// Island authoring toolkit.
//
// The brief asks for islands that feel handmade. That is a constraint on the *tools*, not
// just the output: every primitive here takes explicit hand-placed coordinates. Noise only
// ever appears as a bounded ±N-voxel dressing on top of a shape somebody typed in by hand,
// and it is always faded out at the shoreline so the silhouette stays exactly as authored.
//
// Coordinates
//   Voxel space  : integer (vx, vy, vz), vx/vz in [0,sx)/[0,sz), origin at the volume corner.
//   Local metres : (mx, my, mz) with the island centre at (0, ?, 0) and sea level at my = 0.
//   Conversion   : mx = (vx - sx/2) * VOXEL_M,  my = (vy - seaLevel) * VOXEL_M
//
// Everything is a pure function of (canvas, rng) — no wall clock, no Math.random, and the
// only hashing used is the pure hash2/hashFloat pair from core/rng.js, so two builds of the
// same island from the same seed are byte-identical.

import { VoxelVolume } from './voxel.js';
import { clamp, clamp01, lerp, smoothstep, TAU } from '../core/math.js';
import { value2 } from './noise.js';
import { hash2, hashFloat, mix32 } from '../core/rng.js';

/** Terrain voxel edge length in metres (ARCHITECTURE §3). */
export const VOXEL_M = 0.5;

/** Voxels of volume reserved below sea level for the shelf and harbour floors. */
export const SEA_FLOOR_VX = 24;

/** Widest island footprint we ever allocate, in metres (384 voxels). */
export const ISLAND_SIZE_M = 192;
export const ISLAND_SIZE_VX = 384;
export const ISLAND_MAX_HEIGHT_VX = 160;

/** Horizontal margin kept outside the authored coastline for the underwater shelf. */
export const SHELF_MARGIN_M = 14;

const roundUp16 = (v) => Math.ceil(v / 16) * 16;

/**
 * Volume dimensions for an island of a given radius and peak height.
 * Kept tight so streaming a landmark never allocates the full 384³ budget it does not use.
 * @param {number} radiusM island radius in metres
 * @param {number} maxHeightM highest authored point above sea level, in metres
 * @returns {{sx:number, sy:number, sz:number, seaLevel:number}}
 */
export function islandDims(radiusM, maxHeightM) {
  const span = Math.min(ISLAND_SIZE_VX, roundUp16((radiusM + SHELF_MARGIN_M) * 2 / VOXEL_M));
  const sy = clamp(SEA_FLOOR_VX + Math.ceil(maxHeightM / VOXEL_M) + 10, 64, ISLAND_MAX_HEIGHT_VX);
  return { sx: span, sy, sz: span, seaLevel: SEA_FLOOR_VX };
}

/** Signed distance from (px,pz) to a closed polygon. Positive inside. */
export function polySignedDist(pts, px, pz) {
  let best = Infinity;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], zi = pts[i][1];
    const xj = pts[j][0], zj = pts[j][1];
    const dx = xj - xi, dz = zj - zi;
    const l2 = dx * dx + dz * dz || 1e-9;
    let t = ((px - xi) * dx + (pz - zi) * dz) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = xi + t * dx - px, cz = zi + t * dz - pz;
    const d2 = cx * cx + cz * cz;
    if (d2 < best) best = d2;
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return (inside ? 1 : -1) * Math.sqrt(best);
}

/**
 * Sample a closed loop of hand-placed control points into a smooth polygon.
 * Catmull-Rom, so an author can place 8 points and get a coastline that does not look
 * like an octagon. This is the single most useful "handmade" affordance in the toolkit.
 * @param {Array<[number,number]>} ctrl control points, closed loop
 * @param {number} per samples per segment
 */
export function smoothLoop(ctrl, per = 6) {
  const n = ctrl.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n], p1 = ctrl[i], p2 = ctrl[(i + 1) % n], p3 = ctrl[(i + 2) % n];
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  return out;
}

/** Same but for an open polyline (paths, rivers, ridges). */
export function smoothPath(ctrl, per = 6) {
  const n = ctrl.length;
  if (n < 3) return ctrl.slice();
  const ext = [ctrl[0], ...ctrl, ctrl[n - 1]];
  const out = [];
  for (let i = 1; i < ext.length - 2; i++) {
    const p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2];
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(ctrl[n - 1]);
  return out;
}

/**
 * Scanline-rasterise a closed polygon into a 0/1 mask over a sub-rectangle of the canvas.
 * Even-odd rule, sampled at column centres.
 */
function rasterizePolygon(pts, x0, z0, w, h) {
  const mask = new Uint8Array(w * h);
  const xs = [];
  for (let j = 0; j < h; j++) {
    const pz = z0 + j + 0.5;
    xs.length = 0;
    for (let i = 0, k = pts.length - 1; i < pts.length; k = i++) {
      const zi = pts[i][1], zk = pts[k][1];
      if ((zi > pz) !== (zk > pz)) xs.push(pts[k][0] + ((pz - zk) / (zi - zk)) * (pts[i][0] - pts[k][0]));
    }
    xs.sort((a, b) => a - b);
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const a = Math.max(0, Math.ceil(xs[s] - x0 - 0.5));
      const b = Math.min(w - 1, Math.floor(xs[s + 1] - x0 - 0.5));
      for (let x = a; x <= b; x++) mask[j * w + x] = 1;
    }
  }
  return mask;
}

/**
 * Signed distance to a mask's boundary, via 8SSEDT (Danielsson vector propagation).
 * Two linear passes instead of the O(columns x edges) brute force — the difference between
 * a 6 ms island and a 90 ms one, which matters because islands build during streaming.
 * @returns {Float32Array} positive inside the mask, negative outside
 */
function signedDistanceGrid(mask, w, h) {
  const n = w * h;
  const px = new Int32Array(n), py = new Int32Array(n);
  const d2 = new Float64Array(n);
  const BIG = 1e12, FAR = 20000;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const m = mask[k];
      let boundary = false;
      if (i > 0 && mask[k - 1] !== m) boundary = true;
      else if (i < w - 1 && mask[k + 1] !== m) boundary = true;
      else if (j > 0 && mask[k - w] !== m) boundary = true;
      else if (j < h - 1 && mask[k + w] !== m) boundary = true;
      if (boundary) { px[k] = 0; py[k] = 0; d2[k] = 0; }
      else { px[k] = FAR; py[k] = FAR; d2[k] = BIG; }
    }
  }
  // (ox,oy) is the offset from the current cell to the neighbour being read. Written out
  // rather than factored into a helper: this inner body runs eight times per column of
  // every island built, and the call overhead alone shows up in the streaming budget.
  let nx = 0, ny = 0, nd = 0;
  for (let j = 0; j < h; j++) {
    for (let k = j * w, i = 0; i < w; i++, k++) {
      if (i > 0) {
        nx = px[k - 1] - 1; ny = py[k - 1]; nd = nx * nx + ny * ny;
        if (nd < d2[k]) { px[k] = nx; py[k] = ny; d2[k] = nd; }
      }
      if (j > 0) {
        nx = px[k - w]; ny = py[k - w] - 1; nd = nx * nx + ny * ny;
        if (nd < d2[k]) { px[k] = nx; py[k] = ny; d2[k] = nd; }
        if (i > 0) {
          nx = px[k - w - 1] - 1; ny = py[k - w - 1] - 1; nd = nx * nx + ny * ny;
          if (nd < d2[k]) { px[k] = nx; py[k] = ny; d2[k] = nd; }
        }
        if (i < w - 1) {
          nx = px[k - w + 1] + 1; ny = py[k - w + 1] - 1; nd = nx * nx + ny * ny;
          if (nd < d2[k]) { px[k] = nx; py[k] = ny; d2[k] = nd; }
        }
      }
    }
  }
  for (let j = h - 1; j >= 0; j--) {
    for (let k = j * w + w - 1, i = w - 1; i >= 0; i--, k--) {
      if (i < w - 1) {
        nx = px[k + 1] + 1; ny = py[k + 1]; nd = nx * nx + ny * ny;
        if (nd < d2[k]) { px[k] = nx; py[k] = ny; d2[k] = nd; }
      }
      if (j < h - 1) {
        nx = px[k + w]; ny = py[k + w] + 1; nd = nx * nx + ny * ny;
        if (nd < d2[k]) { px[k] = nx; py[k] = ny; d2[k] = nd; }
        if (i < w - 1) {
          nx = px[k + w + 1] + 1; ny = py[k + w + 1] + 1; nd = nx * nx + ny * ny;
          if (nd < d2[k]) { px[k] = nx; py[k] = ny; d2[k] = nd; }
        }
        if (i > 0) {
          nx = px[k + w - 1] - 1; ny = py[k + w - 1] + 1; nd = nx * nx + ny * ny;
          if (nd < d2[k]) { px[k] = nx; py[k] = ny; d2[k] = nd; }
        }
      }
    }
  }
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) out[k] = (mask[k] ? 1 : -1) * Math.sqrt(d2[k]);
  return out;
}

/**
 * Cheap fBm over value noise. Terrain dressing is evaluated once per column of every
 * island, and gradient noise costs eight trig calls per octave per sample — an amount of
 * work you can measure in the streaming budget. Value noise is hash-only and, at the two
 * or three voxels of amplitude this is ever used for, indistinguishable.
 */
function fbmValue(x, y, seeds) {
  let a = 1, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < seeds.length; i++) {
    sum += a * value2(x * f, y * f, seeds[i]);
    norm += a; a *= 0.5; f *= 2;
  }
  return sum / norm;
}

/** Resample a polyline to roughly one sample per `step` voxels. */
function resample(pts, step) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) out.push([lerp(x0, x1, k / n), lerp(z0, z1, k / n)]);
  }
  out.push(pts[pts.length - 1].slice());
  return out;
}

const PROFILES = {
  dome: (t) => smoothstep(0, 1, t),
  cliff: (t) => smoothstep(0, 0.15, t),
  mesa: (t) => smoothstep(0, 0.34, t),
  cone: (t) => t,
  bowl: (t) => t * t,
  shoulder: (t) => smoothstep(0, 0.55, t) * 0.72 + t * 0.28,
};

/**
 * A voxel volume plus the hand-authoring helpers that write into it.
 *
 * The canvas keeps a per-column ground height map (`gh`) alongside the volume. Every terrain
 * operation updates it, so later operations (paths, beaches, scatter, biome paint) can ask
 * "where is the ground here?" in O(1) instead of scanning a 160-tall column.
 */
export class IslandCanvas {
  /**
   * @param {{sx:number, sy:number, sz:number, seaLevel:number,
   *          B:Record<string,number>, seed:number}} opts
   */
  constructor(opts = {}) {
    this.sx = opts.sx || 256;
    this.sy = opts.sy || 96;
    this.sz = opts.sz || 256;
    this.seaLevel = opts.seaLevel !== undefined ? opts.seaLevel : SEA_FLOOR_VX;
    this.B = opts.B || {};
    this.seed = (opts.seed >>> 0) || 1;
    this.vol = new VoxelVolume(this.sx, this.sy, this.sz);
    this.data = this.vol.data;
    this.yStride = this.sx * this.sz;
    /** Ground surface height per column, -1 where the column is empty. @type {Int16Array} */
    this.gh = new Int16Array(this.sx * this.sz).fill(-1);
    /** Signed distance to the authored coastline, positive inland. @type {Float32Array} */
    this.sd = new Float32Array(this.sx * this.sz).fill(-1e6);
    /** Named local-metre spawn points produced by build(). */
    this.spawnPoints = {};
    /** Hints for the PROPS / QUEST / AUDIO owners: { kind, x, y, z, yaw, tag }. */
    this.markers = [];
    this.cx = this.sx >> 1;
    this.cz = this.sz >> 1;
  }

  // --- block lookup -------------------------------------------------------

  /** Block id by name; throws so a typo fails loudly at build time, not visually. */
  blk(name) {
    const v = this.B[name];
    if (v === undefined) throw new Error('islandbuild: unknown block "' + name + '"');
    return v;
  }

  /** First of `names` that the registry actually defines. Lets islands degrade gracefully. */
  blkOr(...names) {
    for (const n of names) if (this.B[n] !== undefined) return this.B[n];
    throw new Error('islandbuild: none of [' + names.join(', ') + '] are defined');
  }

  /** Standing water surface block. Falls back to ice until a `water` block exists. */
  get WATER() {
    if (this._water === undefined) this._water = this.B.water !== undefined ? this.B.water : this.blk('ice');
    return this._water;
  }

  // --- coordinate helpers -------------------------------------------------

  /** local metres -> voxel x */
  vx(mx) { return Math.round(this.cx + mx / VOXEL_M); }
  /** local metres -> voxel z */
  vz(mz) { return Math.round(this.cz + mz / VOXEL_M); }
  /** metres above sea -> voxel y */
  vy(my) { return Math.round(this.seaLevel + my / VOXEL_M); }
  /** voxel x -> local metres */
  mx(vx) { return (vx - this.cx) * VOXEL_M; }
  mz(vz) { return (vz - this.cz) * VOXEL_M; }
  my(vy) { return (vy - this.seaLevel) * VOXEL_M; }

  ci(x, z) { return z * this.sx + x; }
  inCol(x, z) { return x >= 0 && z >= 0 && x < this.sx && z < this.sz; }

  /** Ground height (voxel y of the top terrain block) at a column, or -1. */
  groundY(x, z) { return this.inCol(x, z) ? this.gh[z * this.sx + x] : -1; }

  /** Signed distance to the authored coastline at a column. */
  shoreDist(x, z) { return this.inCol(x, z) ? this.sd[z * this.sx + x] : -1e6; }

  /** Highest non-air voxel in a column, scanning the volume. Use sparingly. */
  solidTop(x, z) { return this.vol.columnTop(x, z); }

  // --- raw voxel writes ---------------------------------------------------

  get(x, y, z) { return this.vol.get(x, y, z); }

  set(x, y, z, v) {
    if (x < 0 || y < 0 || z < 0 || x >= this.sx || y >= this.sy || z >= this.sz) return;
    this.data[(y * this.sz + z) * this.sx + x] = v;
  }

  /** Set only if the target is currently air. Keeps authored detail from being overwritten. */
  setAir(x, y, z, v) {
    if (x < 0 || y < 0 || z < 0 || x >= this.sx || y >= this.sy || z >= this.sz) return;
    const i = (y * this.sz + z) * this.sx + x;
    if (this.data[i] === 0) this.data[i] = v;
  }

  /** Vertical run write. Hot path: the index only ever increments by one y stride. */
  colFill(x, z, y0, y1, v) {
    if (x < 0 || z < 0 || x >= this.sx || z >= this.sz) return;
    const a = Math.max(0, y0), b = Math.min(this.sy - 1, y1);
    if (b < a) return;
    let i = (a * this.sz + z) * this.sx + x;
    const step = this.yStride;
    for (let y = a; y <= b; y++, i += step) this.data[i] = v;
  }

  box(x0, y0, z0, x1, y1, z1, v) {
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
    const az = Math.min(z0, z1), bz = Math.max(z0, z1);
    for (let z = az; z <= bz; z++) for (let x = ax; x <= bx; x++) this.colFill(x, z, Math.min(y0, y1), Math.max(y0, y1), v);
  }

  /** Walls only (no floor, no ceiling), `t` voxels thick. */
  boxShell(x0, y0, z0, x1, y1, z1, v, t = 1) {
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
    const az = Math.min(z0, z1), bz = Math.max(z0, z1);
    for (let z = az; z <= bz; z++) {
      for (let x = ax; x <= bx; x++) {
        const edge = x - ax < t || bx - x < t || z - az < t || bz - z < t;
        if (edge) this.colFill(x, z, Math.min(y0, y1), Math.max(y0, y1), v);
      }
    }
  }

  /** Flat slab one voxel thick. */
  slab(x0, z0, x1, z1, y, v) { this.box(x0, y, z0, x1, y, z1, v); }

  disc(cx, cz, y, r, v) {
    const r2 = r * r;
    for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
      const dz = z - cz;
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x - cx;
        if (dx * dx + dz * dz <= r2) this.set(x, y, z, v);
      }
    }
  }

  /** Vertical cylinder. `hollow` leaves the interior as air with `thick` walls. */
  cyl(cx, cz, y0, y1, r, v, opts = {}) {
    const t = opts.thick || 1;
    const r2 = r * r, ri2 = Math.max(0, r - t) * (r - t);
    for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
      const dz = z - cz;
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x - cx, d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        if (opts.hollow && d2 < ri2) continue;
        this.colFill(x, z, y0, y1, v);
      }
    }
  }

  /** Ring of blocks at one height — plaza kerbs, crater rims, pond edges. */
  ring(cx, cz, y, r, v, thick = 1) {
    const ro = r + thick * 0.5, ri = r - thick * 0.5;
    for (let z = Math.floor(cz - ro); z <= Math.ceil(cz + ro); z++) {
      const dz = z - cz;
      for (let x = Math.floor(cx - ro); x <= Math.ceil(cx + ro); x++) {
        const dx = x - cx, d = Math.sqrt(dx * dx + dz * dz);
        if (d <= ro && d >= ri) this.set(x, y, z, v);
      }
    }
  }

  sphere(cx, cy, cz, r, v, opts = {}) {
    const r2 = r * r;
    const yFlat = opts.squash || 1;
    for (let y = Math.floor(cy - r * yFlat); y <= Math.ceil(cy + r * yFlat); y++) {
      const dy = (y - cy) / yFlat;
      if (opts.hemisphere && y < cy) continue;
      for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
        const dz = z - cz;
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
          const dx = x - cx;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > r2) continue;
          if (opts.hollow && d2 < (r - (opts.thick || 1)) * (r - (opts.thick || 1))) continue;
          this.set(x, y, z, v);
        }
      }
    }
  }

  /** Cone / spire. Radius shrinks linearly from r0 at y0 to r1 at y1. */
  cone(cx, cz, y0, y1, r0, r1, v, opts = {}) {
    const lean = opts.lean || [0, 0];
    const n = Math.max(1, y1 - y0);
    for (let y = y0; y <= y1; y++) {
      const t = (y - y0) / n;
      const r = lerp(r0, r1, t);
      const ox = cx + lean[0] * t, oz = cz + lean[1] * t;
      const r2 = r * r;
      for (let z = Math.floor(oz - r); z <= Math.ceil(oz + r); z++) {
        const dz = z - oz;
        for (let x = Math.floor(ox - r); x <= Math.ceil(ox + r); x++) {
          const dx = x - ox;
          if (dx * dx + dz * dz <= r2) this.set(x, y, z, v);
        }
      }
    }
  }

  /** Semicircular arch spanning `span` voxels with `rise` height. axis 'x' or 'z'. */
  arch(cx, cz, yBase, span, rise, thick, v, axis = 'x') {
    const half = span / 2;
    const steps = Math.max(24, Math.ceil((span + rise) * 2));
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI;
      const u = -Math.cos(a) * half;
      const yy = Math.round(yBase + Math.sin(a) * rise);
      for (let t = 0; t < thick; t++) {
        for (let w = -thick; w <= thick; w++) {
          if (axis === 'x') this.set(Math.round(cx + u), yy + t, cz + w, v);
          else this.set(cx + w, yy + t, Math.round(cz + u), v);
        }
      }
    }
    // Legs down to the ground so the arch stands rather than floats.
    for (const s of [-1, 1]) {
      const lx = axis === 'x' ? Math.round(cx + s * half) : cx;
      const lz = axis === 'x' ? cz : Math.round(cz + s * half);
      for (let w = -thick; w <= thick; w++) {
        const gx = axis === 'x' ? lx : lx + w;
        const gz = axis === 'x' ? lz + w : lz;
        const g = this.groundY(gx, gz);
        this.colFill(gx, gz, g > 0 ? g : 1, yBase + thick - 1, v);
      }
    }
  }

  // --- terrain ------------------------------------------------------------

  /**
   * Stamp one column of terrain: fill to `top`, cap with soil and a surface block, and
   * clear whatever used to be above it.
   */
  setColumn(x, z, top, o) {
    if (!this.inCol(x, z)) return;
    const i = z * this.sx + x;
    const prev = this.gh[i];
    const t = clamp(Math.round(top), 0, this.sy - 2);
    if (t < 1) {
      if (prev >= 0) this.colFill(x, z, 0, prev, 0);
      this.gh[i] = -1;
      return;
    }
    // Only write the delta. Plateaus, terraces and river carving all re-stamp columns that
    // are already solid, and rewriting every one from y=0 costs more than everything else in
    // an island build put together. Whatever is buried below stays buried — which also reads
    // as strata when a later cut exposes it.
    const soilDepth = o.soilDepth === undefined ? 3 : o.soilDepth;
    const soilFrom = soilDepth > 0 && o.soil !== undefined ? Math.max(0, t - soilDepth + 1) : t + 1;
    if (prev < 0) this.colFill(x, z, 0, soilFrom - 1, o.fill);
    else if (t > prev) this.colFill(x, z, prev + 1, Math.min(t, soilFrom - 1), o.fill);
    else if (t < prev) this.colFill(x, z, t + 1, prev, 0);
    if (soilFrom <= t) this.colFill(x, z, soilFrom, t, o.soil);
    if (o.surface !== undefined) this.set(x, t, z, o.surface);
    this.gh[i] = t;
  }

  /**
   * The primary silhouette tool. Hand-place a closed loop of coastline points; this raises
   * land inside it and tapers an underwater shelf outside it.
   *
   * @param {Array<[number,number]>} points closed polygon in voxel coordinates
   * @param {object} opts
   *   peak       voxels of relief from shoreline to the inland plateau
   *   edge       voxels above sea level at the shoreline itself (1..3 reads as a beach)
   *   reach      distance inland, in voxels, over which `peak` is reached
   *   shelf      distance offshore, in voxels, over which the sea floor drops away
   *   profile    'dome' | 'cliff' | 'mesa' | 'cone' | 'bowl' | 'shoulder'
   *   noise      max voxels of fBm dressing (faded to zero at the shore)
   *   fill/soil/surface/soilDepth  block ids
   *   mode       'max' (default, unions with existing land) | 'set'
   */
  heightmapFromPolygon(points, opts = {}) {
    const o = {
      peak: 20, edge: 2, reach: 60, shelf: 32, profile: 'dome',
      noise: 0, noiseScale: 0.03, mode: 'max', seedTag: 11,
      fill: this.blk('rock'), soil: this.blk('dirt'), soilDepth: 3, surface: this.blk('grass'),
      ...opts,
    };
    const prof = PROFILES[o.profile] || PROFILES.dome;
    const sea = this.seaLevel;
    const nseed = (this.seed ^ Math.imul(o.seedTag, 2654435761)) >>> 0;
    const nseeds = [mix32(nseed), mix32(nseed + 7919)];

    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of points) {
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < z0) z0 = p[1]; if (p[1] > z1) z1 = p[1];
    }
    const pad = o.shelf + 3;
    x0 = Math.max(0, Math.floor(x0 - pad)); x1 = Math.min(this.sx - 1, Math.ceil(x1 + pad));
    z0 = Math.max(0, Math.floor(z0 - pad)); z1 = Math.min(this.sz - 1, Math.ceil(z1 + pad));
    const gw = x1 - x0 + 1, gh = z1 - z0 + 1;
    const sdf = signedDistanceGrid(rasterizePolygon(points, x0, z0, gw, gh), gw, gh);

    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const d = sdf[(z - z0) * gw + (x - x0)];
        const i = z * this.sx + x;
        if (d > this.sd[i]) this.sd[i] = d;
        let h;
        if (d >= 0) {
          h = sea + o.edge + o.peak * prof(clamp01(d / o.reach));
          if (o.noise > 0) {
            const fade = clamp01(d / 8);
            h += fbmValue(x * o.noiseScale, z * o.noiseScale, nseeds) * o.noise * fade;
          }
        } else {
          const u = clamp01(-d / o.shelf);
          h = lerp(sea + o.edge, 1, Math.pow(u, 1.35));
          if (u >= 1) continue;
        }
        const cur = this.gh[i];
        if (o.mode === 'max' && cur >= h) continue;
        this.setColumn(x, z, h, o);
      }
    }
    return this;
  }

  /**
   * Raise a hand-drawn spine. `h` is the crest height in voxels above sea level, either a
   * single number or [startHeight, endHeight]. Falls off to the existing ground over `w`.
   */
  ridge(from, to, h, w, opts = {}) {
    const o = {
      fill: this.blk('rock'), soil: this.blk('rock'), soilDepth: 1,
      surface: opts.surface !== undefined ? opts.surface : this.blk('rock'),
      falloff: 'dome', flatTop: 0, ...opts,
    };
    const h0 = Array.isArray(h) ? h[0] : h;
    const h1 = Array.isArray(h) ? h[1] : h;
    const pts = resample(Array.isArray(from[0]) ? from : [from, to], 2);
    const fall = PROFILES[o.falloff] || PROFILES.dome;
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (const p of pts) {
      if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0];
      if (p[1] < mnz) mnz = p[1]; if (p[1] > mxz) mxz = p[1];
    }
    const bx0 = Math.max(0, Math.floor(mnx - w - 1));
    const bx1 = Math.min(this.sx - 1, Math.ceil(mxx + w + 1));
    const bz0 = Math.max(0, Math.floor(mnz - w - 1));
    const bz1 = Math.min(this.sz - 1, Math.ceil(mxz + w + 1));

    // Bucket the spine samples on a grid of cell size w, so a column only ever tests the
    // nine cells around it instead of the whole polyline.
    const cw = clamp(w, 4, 10);
    const bw = Math.max(1, Math.ceil((bx1 - bx0 + 1) / cw));
    const bh = Math.max(1, Math.ceil((bz1 - bz0 + 1) / cw));
    const buckets = new Array(bw * bh);
    const last = Math.max(1, pts.length - 1);
    for (let k = 0; k < pts.length; k++) {
      const gx = clamp(Math.floor((pts[k][0] - bx0) / cw), 0, bw - 1);
      const gz2 = clamp(Math.floor((pts[k][1] - bz0) / cw), 0, bh - 1);
      const bi = gz2 * bw + gx;
      if (!buckets[bi]) buckets[bi] = [];
      buckets[bi].push(k);
    }

    for (let z = bz0; z <= bz1; z++) {
      const gz2 = clamp(Math.floor((z - bz0) / cw), 0, bh - 1);
      for (let x = bx0; x <= bx1; x++) {
        const gx = clamp(Math.floor((x - bx0) / cw), 0, bw - 1);
        let best = Infinity, bt = 0;
        for (let cz = gz2 - 1; cz <= gz2 + 1; cz++) {
          if (cz < 0 || cz >= bh) continue;
          for (let cx = gx - 1; cx <= gx + 1; cx++) {
            if (cx < 0 || cx >= bw) continue;
            const list = buckets[cz * bw + cx];
            if (!list) continue;
            for (let n = 0; n < list.length; n++) {
              const k = list[n];
              const dx = pts[k][0] - x - 0.5, dz = pts[k][1] - z - 0.5;
              const d2 = dx * dx + dz * dz;
              if (d2 < best) { best = d2; bt = k / last; }
            }
          }
        }
        const d = Math.sqrt(best);
        if (d > w) continue;
        const crest = this.seaLevel + lerp(h0, h1, bt);
        const t = clamp01(1 - (d - o.flatTop) / Math.max(1e-3, w - o.flatTop));
        const target = crest * fall(t) + this.gh[z * this.sx + x] * (1 - fall(t));
        if (target > this.gh[z * this.sx + x]) this.setColumn(x, z, target, o);
      }
    }
    return this;
  }

  /**
   * Flatten a region to an exact height. This is what makes a plaza read as built rather
   * than found — perfectly level ground next to organic terrain.
   */
  plateau(cx, cz, r, y, opts = {}) {
    const o = {
      shape: 'disc', rz: r, blend: 6,
      fill: this.blk('rock'), soil: this.blk('dirt'), soilDepth: 2,
      surface: opts.surface !== undefined ? opts.surface : this.blk('grass'), ...opts,
    };
    const rx = r, rz = o.rz;
    const b = o.blend;
    for (let z = Math.floor(cz - rz - b); z <= Math.ceil(cz + rz + b); z++) {
      for (let x = Math.floor(cx - rx - b); x <= Math.ceil(cx + rx + b); x++) {
        if (!this.inCol(x, z)) continue;
        const cur = this.gh[z * this.sx + x];
        if (cur < 0 && !o.overWater) continue;
        let t;
        if (o.shape === 'rect') {
          const ex = Math.max(0, Math.abs(x - cx) - rx), ez = Math.max(0, Math.abs(z - cz) - rz);
          t = 1 - clamp01(Math.max(ex, ez) / Math.max(1e-3, b));
        } else {
          const d = Math.hypot((x - cx) / rx, (z - cz) / rz) * rx;
          t = 1 - clamp01((d - rx) / Math.max(1e-3, b));
        }
        if (t <= 0) continue;
        const target = lerp(cur < 0 ? 1 : cur, y, smoothstep(0, 1, t));
        this.setColumn(x, z, target, o);
      }
    }
    return this;
  }

  /**
   * Bowl out a depression — calderas, oases, quarry pits, koi ponds.
   * `depth` is voxels below the current ground; `rim` optionally lifts the edge first.
   */
  crater(cx, cz, r, depth, opts = {}) {
    const o = {
      fill: this.blk('rock'), soil: this.blk('rock'), soilDepth: 1,
      surface: opts.surface !== undefined ? opts.surface : this.blk('rock'),
      rim: 0, rimWidth: 8, floorFlat: 0.25, ...opts,
    };
    const outer = r + o.rimWidth;
    for (let z = Math.floor(cz - outer); z <= Math.ceil(cz + outer); z++) {
      for (let x = Math.floor(cx - outer); x <= Math.ceil(cx + outer); x++) {
        if (!this.inCol(x, z)) continue;
        const i = z * this.sx + x;
        const cur = this.gh[i];
        if (cur < 0) continue;
        const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz);
        if (d > outer) continue;
        let target = cur;
        if (o.rim > 0 && d > r) {
          const t = 1 - clamp01((d - r) / o.rimWidth);
          target = cur + o.rim * smoothstep(0, 1, t);
        } else if (d <= r) {
          const t = clamp01((d / r - o.floorFlat) / (1 - o.floorFlat));
          const bowl = 1 - smoothstep(0, 1, t);
          target = cur + o.rim - depth * bowl;
        }
        this.setColumn(x, z, target, o);
      }
    }
    return this;
  }

  /**
   * Carve a channel along a hand-drawn polyline and optionally flood it.
   * Used for rivers, lava runs, harbour channels and the drydock cut.
   */
  carveRiver(points, width, opts = {}) {
    const o = {
      depth: 4, fill: null, bankBlock: null, bed: this.blk('sand'),
      levelMode: 'follow', level: null, ...opts,
    };
    const pts = resample(points, 1);
    const half = width / 2;
    for (let k = 0; k < pts.length; k++) {
      const [px, pz] = pts[k];
      for (let z = Math.floor(pz - half - 1); z <= Math.ceil(pz + half + 1); z++) {
        for (let x = Math.floor(px - half - 1); x <= Math.ceil(px + half + 1); x++) {
          if (!this.inCol(x, z)) continue;
          const d = Math.hypot(x + 0.5 - px, z + 0.5 - pz);
          if (d > half + 1) continue;
          const i = z * this.sx + x;
          const cur = this.gh[i];
          if (cur < 0) continue;
          const cut = o.depth * (1 - clamp01((d - half * 0.35) / Math.max(1e-3, half * 0.65 + 1)));
          if (cut <= 0) continue;
          const target = Math.round(cur - cut);
          this.setColumn(x, z, target, { fill: o.bankBlock || this.blk('rock'), soil: o.bed, soilDepth: 1, surface: o.bed });
          if (o.fill !== null) {
            const surf = o.levelMode === 'flat' && o.level !== null ? o.level : target + Math.max(1, Math.round(o.depth * 0.5));
            if (surf > target) this.colFill(x, z, target + 1, surf, o.fill);
          }
        }
      }
    }
    return this;
  }

  /**
   * Quantise ground into steps with retaining walls on the risers.
   * The rice-terrace / fortress-tier look; also the single cheapest way to make terrain
   * read as cultivated rather than eroded.
   */
  terrace(opts = {}) {
    const o = {
      cx: this.cx, cz: this.cz, r: Math.min(this.sx, this.sz) * 0.5,
      step: 6, base: this.seaLevel + 2, from: this.seaLevel + 1, to: this.sy - 1,
      wall: this.blk('stone'), surface: null, fill: this.blk('dirt'), ...opts,
    };
    const r2 = o.r * o.r;
    const touched = [];
    for (let z = Math.max(0, Math.floor(o.cz - o.r)); z <= Math.min(this.sz - 1, Math.ceil(o.cz + o.r)); z++) {
      for (let x = Math.max(0, Math.floor(o.cx - o.r)); x <= Math.min(this.sx - 1, Math.ceil(o.cx + o.r)); x++) {
        const dx = x + 0.5 - o.cx, dz = z + 0.5 - o.cz;
        if (dx * dx + dz * dz > r2) continue;
        const i = z * this.sx + x;
        const cur = this.gh[i];
        if (cur < o.from || cur > o.to) continue;
        const snapped = o.base + Math.round((cur - o.base) / o.step) * o.step;
        if (snapped !== cur) {
          this.setColumn(x, z, snapped, {
            fill: o.fill, soil: o.fill, soilDepth: 2,
            surface: o.surface !== null ? o.surface : this.get(x, cur, z) || o.fill,
          });
        }
        touched.push(i);
      }
    }
    // Second pass: face the risers with the wall block so every step has a built edge.
    for (const i of touched) {
      const x = i % this.sx, z = (i / this.sx) | 0;
      const y = this.gh[i];
      let lowest = y;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const nz = z + (k === 2 ? 1 : k === 3 ? -1 : 0);
        const ny = this.groundY(nx, nz);
        if (ny >= 0 && ny < lowest) lowest = ny;
      }
      if (lowest < y - 1) this.colFill(x, z, lowest + 1, y - 1, o.wall);
    }
    return this;
  }

  /**
   * Lay a walkable path. Ground is levelled and slope-limited along the polyline, so the
   * result is always traversable — this is the tool that turns a landscape into a level.
   * With `bridge: true` it builds a plank deck on posts instead (piers, boardwalks).
   */
  path(points, width, block, opts = {}) {
    const o = { headroom: 5, edge: null, smooth: 4, maxStep: 1, bridge: false, deckY: null, post: null, rail: null, fillBlock: undefined, ...opts };
    const pts = resample(smoothPath(points, 4), 1);
    const half = Math.max(0.5, width / 2);

    // 1. sample, 2. smooth, 3. slope-limit. Order matters: smoothing first keeps the
    //    profile natural, slope-limiting afterwards guarantees walkability.
    const ys = new Float64Array(pts.length);
    for (let k = 0; k < pts.length; k++) {
      const g = this.groundY(Math.round(pts[k][0]), Math.round(pts[k][1]));
      ys[k] = g >= 0 ? g : this.seaLevel + 2;
    }
    if (o.bridge && o.deckY !== null) ys.fill(o.deckY);
    else {
      const sm = new Float64Array(ys.length);
      const w = o.smooth;
      for (let k = 0; k < ys.length; k++) {
        let s = 0, n = 0;
        for (let j = -w; j <= w; j++) {
          const q = k + j;
          if (q < 0 || q >= ys.length) continue;
          s += ys[q]; n++;
        }
        sm[k] = s / n;
      }
      ys.set(sm);
      for (let k = 1; k < ys.length; k++) ys[k] = clamp(ys[k], ys[k - 1] - o.maxStep, ys[k - 1] + o.maxStep);
      for (let k = ys.length - 2; k >= 0; k--) ys[k] = clamp(ys[k], ys[k + 1] - o.maxStep, ys[k + 1] + o.maxStep);
    }

    const deckBlock = block;
    for (let k = 0; k < pts.length; k++) {
      const px = pts[k][0], pz = pts[k][1];
      const y = Math.round(ys[k]);
      for (let z = Math.floor(pz - half - 1); z <= Math.ceil(pz + half + 1); z++) {
        for (let x = Math.floor(px - half - 1); x <= Math.ceil(px + half + 1); x++) {
          if (!this.inCol(x, z)) continue;
          const d = Math.hypot(x + 0.5 - px, z + 0.5 - pz);
          if (d > half + (o.edge ? 1 : 0)) continue;
          if (d > half) { if (o.edge !== null) this.setAir(x, y, z, o.edge); continue; }
          if (o.bridge) {
            this.set(x, y, z, deckBlock);
            this.colFill(x, z, y + 1, y + o.headroom, 0);
            if (o.rail !== null && d > half - 1) this.set(x, y + 1, z, o.rail);
          } else {
            // Cut down or build up to the levelled height, touching only the voxels that
            // change. Rewriting whole columns here would both cost time and erase the
            // material the terrain pass carefully chose for the cliff below.
            const g = this.groundY(x, z);
            if (g < 0) this.colFill(x, z, 1, y - 1, this.blk('rock'));
            else if (y > g) this.colFill(x, z, g + 1, y - 1, o.fillBlock !== undefined ? o.fillBlock : this.blk('dirt'));
            else if (y < g) this.colFill(x, z, y + 1, g, 0);
            this.set(x, y, z, d > half - 1 && o.edge !== null ? o.edge : deckBlock);
            this.colFill(x, z, y + 1, y + o.headroom, 0);
            this.gh[z * this.sx + x] = y;
          }
        }
      }
      // Posts under a bridge deck, every 5 voxels.
      if (o.bridge && o.post !== null && k % 5 === 0) {
        for (const s of [-1, 1]) {
          const qx = Math.round(px + s * (half - 0.5)), qz = Math.round(pz);
          const g = this.groundY(qx, qz);
          this.colFill(qx, qz, g >= 0 ? g : 1, y - 1, o.post);
        }
      }
    }
    return this;
  }

  /**
   * A deck laid over shallow water — quays, stilt districts, boardwalks. Only columns whose
   * ground sits below the deck are covered, so attaching a wharf to an island never buries
   * the island. Registers itself as the walkable ground and drops posts on a grid.
   */
  deck(x0, z0, x1, z1, y, block, opts = {}) {
    const o = { post: null, spacing: 4, headroom: 4, ...opts };
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
    const az = Math.min(z0, z1), bz = Math.max(z0, z1);
    for (let z = az; z <= bz; z++) {
      for (let x = ax; x <= bx; x++) {
        if (!this.inCol(x, z)) continue;
        const i = z * this.sx + x;
        const g = this.gh[i];
        if (g >= y - 1) continue;
        this.set(x, y, z, block);
        this.colFill(x, z, y + 1, y + o.headroom, 0);
        this.gh[i] = y;
        if (o.post !== null && (x - ax) % o.spacing === 0 && (z - az) % o.spacing === 0) {
          this.colFill(x, z, g >= 0 ? g : 1, y - 1, o.post);
        }
      }
    }
    return this;
  }

  /** Discrete staircase between two voxel points. Always climbable at one voxel per tread. */
  stairs(from, to, width, block, opts = {}) {
    const o = { headroom: 5, side: null, tread: 1, ...opts };
    const [x0, y0, z0] = from, [x1, y1, z1] = to;
    const n = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0), Math.abs(y1 - y0));
    if (n === 0) return this;
    const px = (x1 - x0) / n, pz = (z1 - z0) / n;
    // Perpendicular in the ground plane, for the tread width.
    const plen = Math.hypot(px, pz) || 1;
    const nx = -pz / plen, nz = px / plen;
    const half = (width - 1) / 2;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const cx = x0 + (x1 - x0) * t, cz = z0 + (z1 - z0) * t;
      const y = Math.round(lerp(y0, y1, t));
      for (let w = -half; w <= half; w += 1) {
        const sx = Math.round(cx + nx * w), sz = Math.round(cz + nz * w);
        this.colFill(sx, sz, Math.max(1, y - 3), y, block);
        this.colFill(sx, sz, y + 1, y + o.headroom, 0);
        if (this.inCol(sx, sz)) this.gh[sz * this.sx + sx] = y;
        if (o.side !== null && Math.abs(w) > half - 1) this.set(sx, y + 1, sz, o.side);
      }
    }
    return this;
  }

  /**
   * Square-plan spiral stair inside a shaft: one voxel of rise per one voxel of horizontal
   * move, walked around the perimeter of a (2r+1) square. Square rather than circular
   * because a circular helix rounds onto diagonal neighbours, and a diagonal is not a step —
   * you cannot climb it. `drift` leans the shaft over its height (see the lighthouse), and
   * the lean is spent on steps where the ring position holds, for the same reason.
   *
   * @param {number} cx @param {number} cz shaft centre in voxels
   * @param {number} y0 first tread @param {number} y1 last tread
   * @param {number} r half-width of the square the stair walks around (1 or 2)
   */
  spiralStair(cx, cz, y0, y1, r, block, opts = {}) {
    const drift = opts.drift || [0, 0];
    const n = Math.max(1, y1 - y0);
    const ring = [];
    for (let z = -r; z <= r; z++) ring.push([r, z]);
    for (let x = r - 1; x >= -r; x--) ring.push([x, r]);
    for (let z = r - 1; z >= -r; z--) ring.push([-r, z]);
    for (let x = -r + 1; x <= r - 1; x++) ring.push([x, -r]);
    const per = ring.length;
    const at = (o, kk) => {
      const cell = ring[((kk % per) + per) % per];
      return [cx + o[0] + cell[0], cz + o[1] + cell[1]];
    };
    let k = opts.phase || 0, ox = 0, oz = 0;
    let prev1 = null, prev2 = null;
    for (let y = y0; y <= y1; y++) {
      const t = (y - y0) / n;
      const wx = Math.round(drift[0] * t * t), wz = Math.round(drift[1] * t * t);
      // Exactly one move per tread: advance the lean, or advance around the ring. Both at
      // once is a diagonal. The ordering also has to dodge landing back on the tread two
      // levels below, because that tread would then have a ceiling and stop being a step.
      const cands = [];
      if (ox !== wx) cands.push([ox + Math.sign(wx - ox), oz, k]);
      if (oz !== wz) cands.push([ox, oz + Math.sign(wz - oz), k]);
      cands.push([ox, oz, k + 1]);           // always last, so it is the fallback
      const same = (a2, b2) => a2 && b2 && a2[0] === b2[0] && a2[1] === b2[1];
      let pick = cands[cands.length - 1];
      for (const cnd of cands) {
        if (same(at(cnd, cnd[2]), prev2)) continue;
        // A lean step followed by a ring step can walk straight back onto the tread two
        // below, so look one further ahead before spending the lean here.
        if (cnd[2] === k && same(at(cnd, k + 1), prev1)) continue;
        pick = cnd;
        break;
      }
      ox = pick[0]; oz = pick[1]; k = pick[2];
      const tread = at([ox, oz], k);
      this.set(tread[0], y, tread[1], block);
      prev2 = prev1;
      prev1 = tread;
    }
    return this;
  }

  /** Carve a tube along a polyline of [x,y,z] points. Caves, lava tubes, sally ports. */
  cave(points, radius, opts = {}) {
    const o = { floor: null, wall: null, ...opts };
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      const len = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])));
      for (let k = 0; k <= len; k++) {
        const t = k / len;
        const cx = lerp(a[0], b[0], t), cy = lerp(a[1], b[1], t), cz = lerp(a[2], b[2], t);
        const r = Array.isArray(radius) ? lerp(radius[0], radius[1], (i + t) / (points.length - 1)) : radius;
        const r2 = r * r;
        for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
          for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
            for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
              const dx = x - cx, dy = (y - cy) * 1.25, dz = z - cz;
              if (dx * dx + dy * dy + dz * dz > r2) continue;
              this.set(x, y, z, 0);
            }
          }
        }
        if (o.floor !== null) this.disc(cx, cz, Math.round(cy - r * 0.8), r * 0.85, o.floor);
      }
    }
    return this;
  }

  /**
   * Taper the coast into sand. The ragged edge comes from a hash, not from an rng stream,
   * so calling beach() never shifts any other consumer's random sequence.
   */
  beach(edgeWidth = 5, opts = {}) {
    const o = {
      sand: this.blk('sand'), wet: this.blkOr('sandWet', 'sand'),
      depth: 3, jitter: 2.5, minDist: -18, ...opts,
    };
    const sea = this.seaLevel;
    const tag = (this.seed ^ 6204183) >>> 0;   // fixed salt: the shoreline jitter is a hash, not a stream
    for (let z = 0; z < this.sz; z++) {
      for (let x = 0; x < this.sx; x++) {
        const i = z * this.sx + x;
        const y = this.gh[i];
        if (y < 1) continue;
        const d = this.sd[i];
        if (d < o.minDist) continue;
        const above = y - sea;
        const j = (hashFloat(hash2(x >> 1, z >> 1, tag)) - 0.5) * 2 * o.jitter;
        if (above + j > edgeWidth) continue;
        const near = clamp01(1 - (above + j) / Math.max(1, edgeWidth));
        const dep = Math.max(1, Math.round(o.depth * near));
        const b = above <= 1 ? o.wet : o.sand;
        this.colFill(x, z, y - dep + 1, y, b);
      }
    }
    return this;
  }

  /**
   * Per-column biome material rule. `fn(x, z, y, info)` returns a block id to place on the
   * surface, an array to place downward from the surface, or undefined to leave the column.
   * info = { hM: metres above sea, slope: max neighbour height delta, d: distance inland }
   */
  paint(fn) {
    const info = { hM: 0, slope: 0, d: 0, canvas: this };
    for (let z = 0; z < this.sz; z++) {
      for (let x = 0; x < this.sx; x++) {
        const i = z * this.sx + x;
        const y = this.gh[i];
        if (y < 1) continue;
        let slope = 0;
        if (x > 0) slope = Math.max(slope, Math.abs(y - this.gh[i - 1]));
        if (x < this.sx - 1) slope = Math.max(slope, Math.abs(y - this.gh[i + 1]));
        if (z > 0) slope = Math.max(slope, Math.abs(y - this.gh[i - this.sx]));
        if (z < this.sz - 1) slope = Math.max(slope, Math.abs(y - this.gh[i + this.sx]));
        info.hM = (y - this.seaLevel) * VOXEL_M;
        info.slope = slope;
        info.d = this.sd[i];
        const r = fn(x, z, y, info);
        if (r === undefined || r === null) continue;
        if (Array.isArray(r)) { for (let k = 0; k < r.length; k++) if (r[k] !== null) this.set(x, y - k, z, r[k]); }
        else this.set(x, y, z, r);
      }
    }
    return this;
  }

  /**
   * Blue-noise scatter with a hard minimum spacing. A jittered grid gives the placement its
   * organic feel; the spacing rejection stops trees from clumping into unreadable blobs.
   *
   * @param {import('../core/rng.js').Rng} rng
   * @param {{cx?:number,cz?:number,r?:number,r0?:number,x0?:number,z0?:number,x1?:number,z1?:number,
   *          spacing?:number, filter?:Function}} region
   * @param {number} density chance a candidate cell is used, 0..1
   * @param {(x:number,z:number,y:number,rng:any,i:number)=>void} fn
   */
  scatter(rng, region, density, fn) {
    const spacing = region.spacing || 6;
    const cell = Math.max(1, spacing / Math.SQRT2);
    let x0, x1, z0, z1;
    if (region.r !== undefined) {
      x0 = region.cx - region.r; x1 = region.cx + region.r;
      z0 = region.cz - region.r; z1 = region.cz + region.r;
    } else {
      x0 = region.x0; x1 = region.x1; z0 = region.z0; z1 = region.z1;
    }
    x0 = Math.max(0, Math.floor(x0)); x1 = Math.min(this.sx - 1, Math.ceil(x1));
    z0 = Math.max(0, Math.floor(z0)); z1 = Math.min(this.sz - 1, Math.ceil(z1));
    const gw = Math.max(1, Math.ceil((x1 - x0) / cell));
    const gh = Math.max(1, Math.ceil((z1 - z0) / cell));
    const acc = new Float64Array(gw * gh * 2).fill(NaN);
    const sp2 = spacing * spacing;
    let n = 0;
    for (let gz = 0; gz < gh; gz++) {
      for (let gx = 0; gx < gw; gx++) {
        if (!rng.chance(density)) continue;
        const px = x0 + (gx + rng.f()) * cell;
        const pz = z0 + (gz + rng.f()) * cell;
        if (px > x1 || pz > z1) continue;
        if (region.r !== undefined) {
          const d = Math.hypot(px - region.cx, pz - region.cz);
          if (d > region.r || (region.r0 !== undefined && d < region.r0)) continue;
        }
        let ok = true;
        for (let dz = -2; dz <= 2 && ok; dz++) {
          for (let dx = -2; dx <= 2; dx++) {
            const qx = gx + dx, qz = gz + dz;
            if (qx < 0 || qz < 0 || qx >= gw || qz >= gh) continue;
            const k = (qz * gw + qx) * 2;
            if (Number.isNaN(acc[k])) continue;
            const ddx = acc[k] - px, ddz = acc[k + 1] - pz;
            if (ddx * ddx + ddz * ddz < sp2) { ok = false; break; }
          }
        }
        if (!ok) continue;
        const ix = Math.round(px), iz = Math.round(pz);
        const y = this.groundY(ix, iz);
        if (y < 1) continue;
        if (region.filter && !region.filter(ix, iz, y, this)) continue;
        const k = (gz * gw + gx) * 2;
        acc[k] = px; acc[k + 1] = pz;
        fn(ix, iz, y, rng, n++);
      }
    }
    return n;
  }

  // --- built structures ---------------------------------------------------

  /**
   * A building with a door you can walk through, windows you can see through, and a roof
   * with a real pitch. Styles carry their own block palette so a town reads as one place.
   *
   * @param {number} x min-corner voxel x
   * @param {number} z min-corner voxel z
   * @param {number} w footprint width  (>= 4)
   * @param {number} d footprint depth  (>= 4)
   * @param {number} h wall height in voxels
   * @param {string} style see BUILDING_STYLES
   * @param {object} opts { baseY, doorSide: 0..3 (+x,-x,+z,-z), rng, sign, chimney }
   */
  building(x, z, w, d, h, style, opts = {}) {
    const S = this.styleOf(style);
    const o = { doorSide: 2, baseY: null, banner: null, ...opts };
    if (o.chimney === undefined) o.chimney = S.chimney;
    const x1 = x + w - 1, z1 = z + d - 1;
    let base = o.baseY;
    if (base === null) {
      let lo = 1e9;
      for (let zz = z; zz <= z1; zz++) for (let xx = x; xx <= x1; xx++) {
        const g = this.groundY(xx, zz);
        if (g >= 0 && g < lo) lo = g;
      }
      base = lo === 1e9 ? this.seaLevel + 1 : lo;
    }

    // Stilts / foundation. Stilt buildings are the reason cogHarbour reads as a port.
    if (S.stilts) {
      for (const [px, pz] of [[x, z], [x1, z], [x, z1], [x1, z1], [x + (w >> 1), z], [x + (w >> 1), z1]]) {
        const g = this.groundY(px, pz);
        this.colFill(px, pz, g >= 0 ? g : 1, base - 1, S.post);
      }
    } else {
      for (let zz = z; zz <= z1; zz++) for (let xx = x; xx <= x1; xx++) {
        const g = this.groundY(xx, zz);
        if (g >= 0 && g < base) this.colFill(xx, zz, g, base - 1, S.foundation);
        else if (g < 0) this.colFill(xx, zz, 1, base - 1, S.foundation);
      }
    }

    this.slab(x, z, x1, z1, base, S.floor);
    this.box(x, base + 1, z, x1, base + h, z1, 0);           // clear the interior first
    this.boxShell(x, base + 1, z, x1, base + h, z1, S.wall, 1);
    // Corner posts: two tonal steps on one surface, per the art bar.
    for (const [px, pz] of [[x, z], [x1, z], [x, z1], [x1, z1]]) this.colFill(px, pz, base + 1, base + h, S.post);
    if (S.beltCourse && h >= 5) this.boxShell(x, base + Math.floor(h / 2), z, x1, base + Math.floor(h / 2), z1, S.trim, 1);

    // Door: 2 wide x 3 tall, always on a wall long enough to hold it.
    const door = this.carveDoor(x, z, x1, z1, base, o.doorSide, S);
    // Windows every third voxel, at eye height, skipping the door wall centre.
    const wy = base + 2;
    for (let xx = x + 2; xx <= x1 - 2; xx += 3) {
      if (!(o.doorSide === 2 && Math.abs(xx - door.x) <= 1)) this.set(xx, wy, z1, S.window);
      if (!(o.doorSide === 3 && Math.abs(xx - door.x) <= 1)) this.set(xx, wy, z, S.window);
    }
    for (let zz = z + 2; zz <= z1 - 2; zz += 3) {
      if (!(o.doorSide === 0 && Math.abs(zz - door.z) <= 1)) this.set(x1, wy, zz, S.window);
      if (!(o.doorSide === 1 && Math.abs(zz - door.z) <= 1)) this.set(x, wy, zz, S.window);
    }

    this.roof(x, z, x1, z1, base + h, S);

    if (o.chimney) {
      const cxp = x + 1, czp = z + 1;
      this.colFill(cxp, czp, base + 1, base + h + Math.max(3, Math.round(w * 0.4)), S.chimneyBlock || S.trim);
    }
    if (o.banner !== null && o.banner !== undefined) {
      const bz = o.doorSide === 2 ? z1 + 1 : z - 1;
      this.set(door.x, base + h - 1, bz, o.banner);
      this.set(door.x, base + h - 2, bz, o.banner);
    }
    const rec = { x, z, w, d, h, base, style, door };
    this.markers.push({ kind: 'building', tag: style, x: this.mx(x + w / 2), y: this.my(base), z: this.mz(z + d / 2) });
    return rec;
  }

  /** @private */
  carveDoor(x, z, x1, z1, base, side, S) {
    const midX = x + ((x1 - x) >> 1), midZ = z + ((z1 - z) >> 1);
    let dx = midX, dz = midZ;
    if (side === 0) dx = x1; else if (side === 1) dx = x;
    else if (side === 2) dz = z1; else dz = z;
    const vertical = side === 0 || side === 1;
    for (let k = 0; k < 2; k++) {
      const ax = vertical ? dx : dx + k;
      const az = vertical ? dz + k : dz;
      this.colFill(ax, az, base + 1, base + 3, 0);
      this.set(ax, base + 4, az, S.trim);
      // A step outside the door so the doorway is enterable from sloped ground.
      const ox = ax + (side === 0 ? 1 : side === 1 ? -1 : 0);
      const oz = az + (side === 2 ? 1 : side === 3 ? -1 : 0);
      const g = this.groundY(ox, oz);
      if (g >= 0 && g < base) this.colFill(ox, oz, g, base, S.floor);
    }
    return { x: dx, z: dz, side };
  }

  /** @private Roof kinds: gable, hip, flat, cone, pagoda, shed. */
  roof(x, z, x1, z1, y, S) {
    const kind = S.roofKind;
    const b = S.roof;
    const w = x1 - x + 1, d = z1 - z + 1;
    if (kind === 'flat') {
      this.slab(x - 1, z - 1, x1 + 1, z1 + 1, y + 1, b);
      this.boxShell(x - 1, y + 2, z - 1, x1 + 1, y + 2, z1 + 1, S.trim, 1);
    } else if (kind === 'gable') {
      const k = Math.ceil(d / 2);
      for (let i = 0; i <= k; i++) {
        const za = z - 1 + i, zb = z1 + 1 - i;
        if (za > zb) break;
        this.slab(x - 1, za, x1 + 1, za, y + 1 + i, b);
        this.slab(x - 1, zb, x1 + 1, zb, y + 1 + i, b);
        if (i > 0) { this.slab(x, za, x1, za, y + i, S.wall); this.slab(x, zb, x1, zb, y + i, S.wall); }
      }
    } else if (kind === 'hip') {
      const k = Math.ceil(Math.min(w, d) / 2);
      for (let i = 0; i <= k; i++) {
        const ax = x - 1 + i, bx = x1 + 1 - i, az = z - 1 + i, bz = z1 + 1 - i;
        if (ax > bx || az > bz) break;
        this.boxShell(ax, y + 1 + i, az, bx, y + 1 + i, bz, b, 1);
        if (i === k) this.slab(ax, az, bx, bz, y + 1 + i, b);
      }
    } else if (kind === 'cone') {
      const r = Math.max(w, d) / 2 + 1;
      this.cone(x + w / 2 - 0.5, z + d / 2 - 0.5, y + 1, y + 1 + Math.round(r * 1.4), r, 0.5, b);
    } else if (kind === 'pagoda') {
      let ax = x - 2, bx = x1 + 2, az = z - 2, bz = z1 + 2, yy = y + 1;
      for (let t = 0; t < 3; t++) {
        this.slab(ax, az, bx, bz, yy, b);
        this.boxShell(ax, yy + 1, az, bx, yy + 1, bz, S.trim, 1);
        ax += 2; bx -= 2; az += 2; bz -= 2; yy += 3;
        if (ax >= bx || az >= bz) break;
        this.boxShell(ax, yy - 2, az, bx, yy, bz, S.wall, 1);
      }
      this.colFill(x + (w >> 1), z + (d >> 1), yy, yy + 2, S.trim);
    } else { // shed
      for (let i = 0; i < d; i++) this.slab(x - 1, z + i, x1 + 1, z + i, y + 1 + Math.floor(i / 2), b);
    }
  }

  /** Block palette per building style. Exposed so islands can tweak one field. */
  styleOf(style) {
    const B = this.B;
    const base = {
      wall: B.plank, post: B.woodDark, floor: B.plank, roof: B.thatch, trim: B.woodDark,
      window: B.glass, foundation: B.rock, roofKind: 'gable', stilts: false,
      beltCourse: false, chimney: false,
    };
    const S = BUILDING_STYLES[style];
    if (!S) throw new Error('islandbuild: unknown building style "' + style + '"');
    const out = Object.assign({}, base);
    for (const k of Object.keys(S)) {
      const v = S[k];
      out[k] = typeof v === 'string' && B[v] !== undefined ? B[v] : v;
    }
    return out;
  }

  /**
   * Place a cluster of buildings on hand-authored plots and dress the gaps between them.
   * Returns the building records so the caller can path-link the doors by hand.
   *
   * @param {import('../core/rng.js').Rng} rng
   * @param {Array<{x:number,z:number,w:number,d:number,h?:number,style?:string,doorSide?:number}>} plots
   * @param {string} style default style for plots that do not name one
   */
  town(rng, plots, style, opts = {}) {
    const o = { props: true, lantern: null, ...opts };
    const out = [];
    for (let i = 0; i < plots.length; i++) {
      const p = plots[i];
      const h = p.h !== undefined ? p.h : 4 + rng.int(0, 2);
      const bo = {
        doorSide: p.doorSide !== undefined ? p.doorSide : rng.int(0, 3),
        banner: p.banner !== undefined ? p.banner : null,
      };
      if (p.chimney !== undefined) bo.chimney = p.chimney;
      if (p.baseY !== undefined) bo.baseY = p.baseY;
      const b = this.building(p.x, p.z, p.w, p.d, h, p.style || style, bo);
      out.push(b);
      if (o.props) {
        // A crate or barrel beside the door: the small stuff is what sells a lived-in town.
        const side = b.door.side;
        const ox = b.door.x + (side === 0 ? 2 : side === 1 ? -2 : rng.int(-1, 1));
        const oz = b.door.z + (side === 2 ? 2 : side === 3 ? -2 : rng.int(-1, 1));
        const g = this.groundY(ox, oz);
        if (g > 0) {
          const kind = rng.f();
          if (kind < 0.45) this.colFill(ox, oz, g + 1, g + 1 + rng.int(0, 1), this.B.barrel);
          else if (kind < 0.7) this.set(ox, g + 1, oz, this.B.plank);
        }
      }
      if (o.lantern !== null && i % 2 === 0) {
        const lx = b.x - 1, lz = b.z - 1;
        const g = this.groundY(lx, lz);
        if (g > 0) { this.colFill(lx, lz, g + 1, g + 3, this.B.woodDark); this.set(lx, g + 4, lz, o.lantern); }
      }
    }
    return out;
  }

  /**
   * A tree. Kinds: palm, jungle, pine, cherry, dead, cactus, mangrove.
   * Trunks lean deterministically so a grove never looks like a stamped array.
   */
  tree(x, z, kind, rng, opts = {}) {
    const B = this.B;
    const g = opts.baseY !== undefined ? opts.baseY : this.groundY(x, z);
    if (g < 1) return;
    const scale = opts.scale || 1;
    if (kind === 'palm') {
      const h = Math.round((9 + rng.int(0, 4)) * scale);
      const bend = rng.int(-1, 1), bend2 = rng.chance(0.5) ? 1 : -1;
      let tx = x, tz = z;
      for (let i = 1; i <= h; i++) {
        if (i > h * 0.55 && i % 3 === 0) { tx += bend; tz += bend2 * (rng.chance(0.4) ? 1 : 0); }
        this.set(tx, g + i, tz, B.wood);
      }
      const top = g + h;
      for (let a = 0; a < 6; a++) {
        const ang = (a / 6) * TAU + rng.f() * 0.4;
        const dx = Math.cos(ang), dz = Math.sin(ang);
        const len = 3 + rng.int(0, 2);
        for (let k = 1; k <= len; k++) {
          const drop = k >= len - 1 ? -1 : 0;
          this.setAir(Math.round(tx + dx * k), top + drop + (k < 2 ? 1 : 0), Math.round(tz + dz * k), B.leavesPalm);
          if (k === 2) this.setAir(Math.round(tx + dx * k + dz * 0.9), top + 1, Math.round(tz + dz * k - dx * 0.9), B.leavesPalm);
        }
      }
      this.set(tx, top + 1, tz, B.leavesPalm);
      if (rng.chance(0.4)) this.set(tx + 1, top, tz, B.mushroomCap); // coconut cluster
    } else if (kind === 'jungle') {
      const h = Math.round((12 + rng.int(0, 7)) * scale);
      const r = 3 + rng.int(0, 2);
      this.colFill(x, z, g + 1, g + h, B.wood);
      if (rng.chance(0.6)) { this.colFill(x + 1, z, g + 1, g + 2, B.wood); this.colFill(x, z + 1, g + 1, g + 2, B.wood); }
      this.sphere(x, g + h, z, r, B.leaves, { squash: 0.65 });
      this.sphere(x + rng.int(-2, 2), g + h - 2, z + rng.int(-2, 2), r - 1, B.leaves, { squash: 0.7 });
      // Hanging vines: the readable jungle signal at distance.
      for (let v = 0; v < 3; v++) {
        const vx = x + rng.int(-r, r), vz = z + rng.int(-r, r);
        const vl = rng.int(2, 5);
        for (let k = 0; k < vl; k++) this.setAir(vx, g + h - r + 1 - k, vz, B.leaves);
      }
    } else if (kind === 'pine') {
      const h = Math.round((10 + rng.int(0, 6)) * scale);
      this.colFill(x, z, g + 1, g + h, B.woodDark);
      let r = 3.4;
      for (let y = g + Math.round(h * 0.35); y <= g + h; y += 2) {
        this.disc(x, z, y, r, B.leavesPine);
        this.disc(x, z, y + 1, Math.max(0.8, r - 1.2), B.leavesPine);
        r = Math.max(0.9, r - 0.75);
      }
      this.set(x, g + h + 1, z, B.leavesPine);
    } else if (kind === 'cherry') {
      const h = Math.round((5 + rng.int(0, 3)) * scale);
      this.colFill(x, z, g + 1, g + h, B.woodDark);
      const armDirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const a of armDirs) {
        if (rng.chance(0.4)) continue;
        this.set(x + a[0], g + h - 1, z + a[1], B.woodDark);
        this.set(x + a[0] * 2, g + h, z + a[1] * 2, B.woodDark);
      }
      this.sphere(x, g + h + 1, z, 3.4 * scale, B.leavesCherry, { squash: 0.7 });
      this.sphere(x + rng.int(-2, 2), g + h, z + rng.int(-2, 2), 2.4 * scale, B.leavesCherry, { squash: 0.75 });
    } else if (kind === 'dead') {
      const h = Math.round((5 + rng.int(0, 4)) * scale);
      let tx = x, tz = z;
      for (let i = 1; i <= h; i++) {
        if (i % 3 === 0) tx += rng.int(-1, 1);
        this.set(tx, g + i, tz, B.woodDark);
      }
      for (let a = 0; a < 3; a++) {
        const ang = rng.f() * TAU;
        const bx = Math.round(tx + Math.cos(ang) * 2), bz = Math.round(tz + Math.sin(ang) * 2);
        this.set(Math.round(tx + Math.cos(ang)), g + h - a, tz, B.woodDark);
        this.set(bx, g + h - a + 1, bz, B.woodDark);
      }
    } else if (kind === 'cactus') {
      const h = Math.round((4 + rng.int(0, 4)) * scale);
      this.colFill(x, z, g + 1, g + h, B.cactus);
      if (h > 4) {
        const s = rng.chance(0.5) ? 1 : -1;
        this.set(x + s, g + h - 2, z, B.cactus);
        this.colFill(x + s * 2, z, g + h - 2, g + h, B.cactus);
      }
    } else if (kind === 'mangrove') {
      const h = Math.round((6 + rng.int(0, 3)) * scale);
      this.colFill(x, z, g + 1, g + h, B.woodDark);
      for (const a of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        this.set(x + a[0], g + 1, z + a[1], B.woodDark);
        this.set(x + a[0] * 2, g, z + a[1] * 2, B.woodDark);
      }
      this.sphere(x, g + h, z, 3, B.leaves, { squash: 0.6 });
    }
  }

  /** Torii gate — two posts, a curved lintel, a tie beam. Faces along `axis`. */
  torii(x, z, y, width, height, opts = {}) {
    const B = this.B;
    const post = opts.post !== undefined ? opts.post : B.woodDark;
    const beam = opts.beam !== undefined ? opts.beam : B.flagRed;
    const half = width >> 1;
    const ax = opts.axis === 'z' ? 0 : 1;
    for (const s of [-1, 1]) {
      const px = x + (ax ? s * half : 0), pz = z + (ax ? 0 : s * half);
      this.colFill(px, pz, y, y + height, post);
    }
    for (let i = -half - 1; i <= half + 1; i++) {
      const px = x + (ax ? i : 0), pz = z + (ax ? 0 : i);
      const lift = Math.abs(i) > half - 1 ? 1 : 0;
      this.set(px, y + height + 1 + lift, pz, beam);
      this.set(px, y + height + 2 + lift, pz, beam);
      if (Math.abs(i) <= half) this.set(px, y + height - 1, pz, post);
    }
  }

  /** A hanging cable of `block` between two voxel points — cable cars, rigging, vines. */
  cable(a, b, block, sag = 2) {
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const s = Math.sin(t * Math.PI) * sag;
      this.setAir(
        Math.round(lerp(a[0], b[0], t)),
        Math.round(lerp(a[1], b[1], t) - s),
        Math.round(lerp(a[2], b[2], t)), block,
      );
    }
  }

  /** Open lattice tower (crane legs, cable-car pylons, scaffolding). */
  lattice(cx, cz, y0, y1, r0, r1, block, opts = {}) {
    const brace = opts.brace !== undefined ? opts.brace : block;
    const n = Math.max(1, y1 - y0);
    for (let y = y0; y <= y1; y++) {
      const t = (y - y0) / n;
      const r = Math.round(lerp(r0, r1, t));
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) this.set(cx + sx * r, y, cz + sz * r, block);
      if ((y - y0) % 3 === 0) {
        for (let i = -r; i <= r; i++) {
          this.set(cx + i, y, cz - r, brace); this.set(cx + i, y, cz + r, brace);
          this.set(cx - r, y, cz + i, brace); this.set(cx + r, y, cz + i, brace);
        }
      }
    }
  }

  /**
   * Record a named spawn point, snapped onto the ground at that column. Ground height wins
   * over the topmost solid voxel: a tree or an awning over the column should not teleport
   * an NPC into the canopy. Pass an explicit `y` for anything on a deck, tower or cave floor.
   */
  mark(name, vx, vz, opts = {}) {
    let y = opts.y;
    if (y === undefined) {
      const g = this.groundY(vx, vz);
      const t = g >= 0 ? g : this.solidTop(vx, vz);
      y = (t >= 0 ? t : this.seaLevel) + 1;
    }
    this.spawnPoints[name] = { x: this.mx(vx), y: this.my(y), z: this.mz(vz), yaw: opts.yaw || 0, tag: opts.tag || name };
    return this.spawnPoints[name];
  }

  /** Free-form hint for other systems (props, quests, audio emitters). */
  hint(kind, vx, vy, vz, extra = {}) {
    this.markers.push(Object.assign({ kind, x: this.mx(vx), y: this.my(vy), z: this.mz(vz) }, extra));
  }

  /** Total non-air voxels. Used by the self-check. */
  count() { return this.vol.count(); }

  /** Tight bounding box of non-air voxels in voxel space, or null when empty. */
  bounds() {
    let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9, any = false;
    const d = this.data;
    for (let y = 0; y < this.sy; y++) {
      for (let z = 0; z < this.sz; z++) {
        const row = (y * this.sz + z) * this.sx;
        for (let x = 0; x < this.sx; x++) {
          if (d[row + x] === 0) continue;
          any = true;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
          if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
      }
    }
    return any ? { x0, y0, z0, x1, y1, z1 } : null;
  }
}

/**
 * Building style table. Values that name a block key are resolved against the registry at
 * use time, so a style survives blocks being reordered.
 */
export const BUILDING_STYLES = {
  cottage: { wall: 'plank', post: 'woodDark', floor: 'plank', roof: 'thatch', trim: 'woodDark', roofKind: 'gable', chimney: true },
  shack: { wall: 'plankV', post: 'wood', floor: 'plank', roof: 'thatch', trim: 'wood', roofKind: 'shed' },
  stilt: { wall: 'plankV', post: 'woodDark', floor: 'plank', roof: 'metalDark', trim: 'metal', roofKind: 'shed', stilts: true },
  warehouse: { wall: 'brick', post: 'metalDark', floor: 'stone', roof: 'metal', trim: 'metalDark', roofKind: 'gable', beltCourse: true },
  forge: { wall: 'stone', post: 'metalDark', floor: 'volcanic', roof: 'metalDark', trim: 'metal', roofKind: 'shed', chimney: true, chimneyBlock: 'brick' },
  stoneHut: { wall: 'stone', post: 'rockCold', floor: 'stone', roof: 'roof', trim: 'woodDark', roofKind: 'hip', chimney: true },
  chalet: { wall: 'plank', post: 'woodDark', floor: 'plank', roof: 'roof', trim: 'woodDark', roofKind: 'gable', chimney: true },
  keep: { wall: 'stone', post: 'stone', floor: 'stone', roof: 'roof', trim: 'metalDark', roofKind: 'hip', beltCourse: true },
  barracks: { wall: 'stoneBrick', post: 'stone', floor: 'stone', roof: 'metal', trim: 'metalDark', roofKind: 'gable', beltCourse: true },
  pagoda: { wall: 'plank', post: 'flagRed', floor: 'plank', roof: 'roof', trim: 'flagRed', roofKind: 'pagoda' },
  teahouse: { wall: 'paper', post: 'woodDark', floor: 'plank', roof: 'roof', trim: 'flagRed', roofKind: 'hip' },
  adobe: { wall: 'clay', post: 'clay', floor: 'sand', roof: 'clay', trim: 'woodDark', roofKind: 'flat' },
  ruin: { wall: 'stone', post: 'stone', floor: 'stone', roof: 'stone', trim: 'stone', roofKind: 'flat' },
  tent: { wall: 'sail', post: 'wood', floor: 'dirt', roof: 'sailShade', trim: 'rope', roofKind: 'gable' },
};

/**
 * Half-buried / half-built hull. Used by the wreck archetype, the cogHarbour drydock and
 * marinefordReach's warship — one authored shape, three very different dressings.
 * @param {IslandCanvas} c
 */
export function shipHull(c, x, z, len, beam, y, opts = {}) {
  const B = c.B;
  const o = { hull: B.plank, rib: B.woodDark, deck: B.plank, ribsOnly: false, mast: 0, lean: 0, sailBlock: null, ...opts };
  const half = beam / 2;
  for (let i = 0; i < len; i++) {
    const t = i / (len - 1);
    // Fine at the bow, full amidships, tapered at the stern — a real waterline plan.
    const wid = Math.max(1, Math.round(half * Math.sin(Math.pow(t, 0.72) * Math.PI) * 1.06 + 0.4));
    const rise = Math.round(Math.pow(Math.abs(t - 0.5) * 2, 2.2) * 3);
    const lx = Math.round(o.lean * (1 - t));
    const rib = o.ribsOnly && i % 3 !== 0;
    for (let w = -wid; w <= wid; w++) {
      const px = x + i + lx, pz = z + w;
      if (rib && Math.abs(w) < wid) continue;
      c.colFill(px, pz, y - 2, y + rise, Math.abs(w) === wid ? o.rib : o.hull);
    }
    if (!o.ribsOnly && i > 2 && i < len - 2) {
      for (let w = -wid + 1; w <= wid - 1; w++) c.set(x + i + lx, y + rise, z + w, o.deck);
    }
  }
  if (o.mast > 0) {
    const mx = x + Math.round(len * 0.45), mz = z;
    c.colFill(mx, mz, y, y + o.mast, B.wood);
    for (let i = -3; i <= 3; i++) c.set(mx, y + o.mast - 2, mz + i, B.woodDark);
    if (o.sailBlock !== null) {
      for (let i = -2; i <= 2; i++) c.box(mx, y + o.mast - 8, mz + i, mx, y + o.mast - 3, mz + i, o.sailBlock);
    }
  }
}

/** A dock: plank deck on posts, running from the beach out over the water. */
export function pier(c, from, to, width, opts = {}) {
  const B = c.B;
  const deckY = opts.deckY !== undefined ? opts.deckY : c.seaLevel + 3;
  c.path([from, to], width, opts.deck || B.plank, {
    bridge: true, deckY, post: opts.post || B.woodDark, rail: opts.rail !== undefined ? opts.rail : null, headroom: 4,
  });
  // Bollards at the seaward end, so a moored ship has somewhere to belong.
  const dx = to[0] - from[0], dz = to[1] - from[1];
  const len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len, nz = dx / len;
  for (const s of [-1, 1]) {
    const bx = Math.round(to[0] + nx * (width / 2 - 0.5)), bz = Math.round(to[1] + nz * (width / 2 - 0.5));
    c.colFill(bx, bz, deckY + 1, deckY + 1 + (s > 0 ? 1 : 1), B.woodDark);
  }
  return deckY;
}
