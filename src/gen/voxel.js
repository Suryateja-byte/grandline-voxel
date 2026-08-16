// Voxel volumes and the greedy mesher.
//
// Produces interleaved geometry with these attributes, matching materials.js:
//   position, normal, uv (0..1 within the tile, tiled across merged quads),
//   aLayer (array-texture layer), aShade (per-face constant), aAo (per-vertex occlusion).
//
// Greedy merging only fuses faces that share layer + AO signature, so ambient occlusion
// survives the merge. This is what keeps voxel corners readable at distance.

import * as THREE from 'three';
import { FACE_SHADE } from './palette.js';

export const AIR = 0;

/** Face order used everywhere: +Y, -Y, +X, -X, +Z, -Z */
export const FACES = [
  { dir: [0, 1, 0], name: 'top' },
  { dir: [0, -1, 0], name: 'bottom' },
  { dir: [1, 0, 0], name: 'east' },
  { dir: [-1, 0, 0], name: 'west' },
  { dir: [0, 0, 1], name: 'south' },
  { dir: [0, 0, -1], name: 'north' },
];

export class BlockRegistry {
  constructor() {
    this.defs = [{ name: 'air', solid: false, opaque: false }];
    this.byName = new Map([['air', 0]]);
  }
  /**
   * @param {string} name
   * @param {{top:number, bottom:number, side:number}|number} tiles layer index or per-face
   * @param {object} opts { solid, opaque, cutout, climbable, hazard, liquid }
   */
  define(name, tiles, opts = {}) {
    if (this.byName.has(name)) return this.byName.get(name);
    const id = this.defs.length;
    const t = typeof tiles === 'number'
      ? { top: tiles, bottom: tiles, east: tiles, west: tiles, south: tiles, north: tiles }
      : {
        top: tiles.top, bottom: tiles.bottom !== undefined ? tiles.bottom : tiles.top,
        east: tiles.side, west: tiles.side, south: tiles.side, north: tiles.side,
        ...tiles,
      };
    this.defs.push({
      name, tiles: t,
      solid: opts.solid !== false,
      opaque: opts.opaque !== false,
      cutout: !!opts.cutout,
      hazard: opts.hazard || 0,
      liquid: !!opts.liquid,
      climbable: !!opts.climbable,
      breakable: opts.breakable !== false,
      hp: opts.hp || 1,
    });
    this.byName.set(name, id);
    return id;
  }
  id(name) {
    const v = this.byName.get(name);
    if (v === undefined) throw new Error('unknown block: ' + name);
    return v;
  }
  def(id) { return this.defs[id] || this.defs[0]; }
  isOpaque(id) { return id !== 0 && this.defs[id] && this.defs[id].opaque; }
  isSolid(id) { return id !== 0 && this.defs[id] && this.defs[id].solid; }
}

export class VoxelVolume {
  constructor(sx, sy, sz) {
    this.sx = sx; this.sy = sy; this.sz = sz;
    this.data = new Uint16Array(sx * sy * sz);
  }
  idx(x, y, z) { return (y * this.sz + z) * this.sx + x; }
  inBounds(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz; }
  get(x, y, z) {
    if (x < 0 || y < 0 || z < 0 || x >= this.sx || y >= this.sy || z >= this.sz) return AIR;
    return this.data[(y * this.sz + z) * this.sx + x];
  }
  set(x, y, z, v) {
    if (x < 0 || y < 0 || z < 0 || x >= this.sx || y >= this.sy || z >= this.sz) return;
    this.data[(y * this.sz + z) * this.sx + x] = v;
  }
  fillBox(x0, y0, z0, x1, y1, z1, v) {
    for (let y = Math.max(0, y0); y <= Math.min(this.sy - 1, y1); y++)
      for (let z = Math.max(0, z0); z <= Math.min(this.sz - 1, z1); z++)
        for (let x = Math.max(0, x0); x <= Math.min(this.sx - 1, x1); x++)
          this.data[(y * this.sz + z) * this.sx + x] = v;
  }
  /** Highest non-air y at column (x,z), or -1. */
  columnTop(x, z) {
    for (let y = this.sy - 1; y >= 0; y--) if (this.get(x, y, z) !== AIR) return y;
    return -1;
  }
  clone() {
    const v = new VoxelVolume(this.sx, this.sy, this.sz);
    v.data.set(this.data);
    return v;
  }
  count() {
    let n = 0;
    for (let i = 0; i < this.data.length; i++) if (this.data[i] !== 0) n++;
    return n;
  }
}

/** AO lookup: how many of the 3 neighbours around a vertex are solid -> occlusion 0..1. */
const AO_LEVELS = [1.0, 0.78, 0.60, 0.46];

function vertexAO(side1, side2, corner) {
  if (side1 && side2) return AO_LEVELS[3];
  return AO_LEVELS[(side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner ? 1 : 0)];
}

/**
 * Greedy-mesh a volume.
 * @param {VoxelVolume} vol
 * @param {BlockRegistry} reg
 * @param {object} opts
 *   scale       voxel size in world units (default 1)
 *   origin      [x,y,z] world offset
 *   sample      optional (x,y,z)=>id override, used for cross-chunk neighbour lookups
 *   faceOverride optional Map 'x,y,z,face' -> layer index (used for character faces)
 *   ao          bool, default true
 *   cutoutOnly  only emit blocks whose def.cutout matches this flag
 */
export function meshVolume(vol, reg, opts = {}) {
  const scale = opts.scale || 1;
  const ox = opts.origin ? opts.origin[0] : 0;
  const oy = opts.origin ? opts.origin[1] : 0;
  const oz = opts.origin ? opts.origin[2] : 0;
  const useAo = opts.ao !== false;
  const sample = opts.sample || ((x, y, z) => vol.get(x, y, z));
  const faceOverride = opts.faceOverride || null;
  const wantCutout = opts.cutoutOnly === true;
  const filterCutout = opts.cutoutOnly !== undefined;

  const positions = [];
  const normals = [];
  const uvs = [];
  const layers = [];
  const shades = [];
  const aos = [];
  const indices = [];
  let vcount = 0;

  const dims = [vol.sx, vol.sy, vol.sz];

  // For each of the 3 axes and 2 directions, sweep slices and greedily merge quads.
  for (let f = 0; f < 6; f++) {
    const face = FACES[f];
    const [dx, dy, dz] = face.dir;
    const axis = dx !== 0 ? 0 : dy !== 0 ? 1 : 2;
    const u = (axis + 1) % 3;   // first in-plane axis
    const v = (axis + 2) % 3;   // second in-plane axis
    const du = dims[u], dv = dims[v], da = dims[axis];
    const shade = FACE_SHADE[f];

    // mask[i] = null | { layer, ao:[4], key }
    const mask = new Array(du * dv);

    for (let a = 0; a < da; a++) {
      let any = false;
      for (let j = 0; j < dv; j++) {
        for (let i = 0; i < du; i++) {
          const p = [0, 0, 0];
          p[axis] = a; p[u] = i; p[v] = j;
          const id = vol.get(p[0], p[1], p[2]);
          if (id === AIR) { mask[j * du + i] = null; continue; }
          const def = reg.def(id);
          if (filterCutout && !!def.cutout !== wantCutout) { mask[j * du + i] = null; continue; }
          const n = [p[0] + dx, p[1] + dy, p[2] + dz];
          const nid = sample(n[0], n[1], n[2]);
          // Cutout blocks (leaves) never hide each other — canopies must show internal faces.
          const hidden = def.cutout ? (nid !== AIR && reg.def(nid).opaque) : reg.isOpaque(nid);
          if (hidden) { mask[j * du + i] = null; continue; }

          let layer = def.tiles[face.name];
          if (faceOverride) {
            const ov = faceOverride.get(p[0] + ',' + p[1] + ',' + p[2] + ',' + face.name);
            if (ov !== undefined) layer = ov;
          }

          let ao0 = 1, ao1 = 1, ao2 = 1, ao3 = 1;
          if (useAo && !def.cutout) {
            // Neighbours in the face plane, offset one step along the face normal.
            const solidAt = (di, dj) => {
              const q = [0, 0, 0];
              q[axis] = a + (axis === 0 ? dx : axis === 1 ? dy : dz);
              q[u] = i + di; q[v] = j + dj;
              return reg.isOpaque(sample(q[0], q[1], q[2]));
            };
            const s00 = solidAt(-1, 0), s10 = solidAt(1, 0), s01 = solidAt(0, -1), s11 = solidAt(0, 1);
            const c00 = solidAt(-1, -1), c10 = solidAt(1, -1), c01 = solidAt(-1, 1), c11 = solidAt(1, 1);
            ao0 = vertexAO(s00, s01, c00);
            ao1 = vertexAO(s10, s01, c10);
            ao2 = vertexAO(s10, s11, c11);
            ao3 = vertexAO(s00, s11, c01);
          }
          mask[j * du + i] = {
            layer, ao0, ao1, ao2, ao3,
            key: layer * 1000 + ((ao0 * 9) | 0) * 100 + ((ao1 * 9) | 0) * 10 + ((ao2 * 9) | 0) + (ao3 * 0.001),
          };
          any = true;
        }
      }
      if (!any) continue;

      // Greedy merge over the mask.
      for (let j = 0; j < dv; j++) {
        for (let i = 0; i < du;) {
          const m = mask[j * du + i];
          if (!m) { i++; continue; }
          // Width
          let w = 1;
          while (i + w < du) {
            const m2 = mask[j * du + i + w];
            if (!m2 || m2.key !== m.key) break;
            w++;
          }
          // Height
          let h = 1;
          outer:
          while (j + h < dv) {
            for (let k = 0; k < w; k++) {
              const m2 = mask[(j + h) * du + i + k];
              if (!m2 || m2.key !== m.key) break outer;
            }
            h++;
          }

          // Emit the quad.
          const base = [0, 0, 0];
          base[axis] = a + (dx > 0 || dy > 0 || dz > 0 ? 1 : 0);
          base[u] = i; base[v] = j;

          const du3 = [0, 0, 0]; du3[u] = w;
          const dv3 = [0, 0, 0]; dv3[v] = h;

          const px = base[0] * scale + ox, py = base[1] * scale + oy, pz = base[2] * scale + oz;
          const ux = du3[0] * scale, uy = du3[1] * scale, uz = du3[2] * scale;
          const vx = dv3[0] * scale, vy = dv3[1] * scale, vz = dv3[2] * scale;

          // Winding: flip for negative-facing quads so all faces are front-facing.
          const flip = (dx + dy + dz) < 0;
          const quad = flip
            ? [[0, 0], [1, 0], [1, 1], [0, 1]]
            : [[0, 0], [0, 1], [1, 1], [1, 0]];
          const aoq = flip
            ? [m.ao0, m.ao1, m.ao2, m.ao3]
            : [m.ao0, m.ao3, m.ao2, m.ao1];
          const uvq = flip
            ? [[0, 0], [w, 0], [w, h], [0, h]]
            : [[0, 0], [0, h], [w, h], [w, 0]];

          for (let c = 0; c < 4; c++) {
            const [cu, cv] = quad[c];
            positions.push(px + ux * cu + vx * cv, py + uy * cu + vy * cv, pz + uz * cu + vz * cv);
            normals.push(dx, dy, dz);
            uvs.push(uvq[c][0], uvq[c][1]);
            layers.push(m.layer);
            shades.push(shade);
            aos.push(aoq[c]);
          }
          // Winding. With u = (axis+1)%3 and v = (axis+2)%3, the in-plane basis (u, v, axis) is
          // cyclic, so ê_u x ê_v = ê_axis. Emitting corners in the order base -> +v -> +u+v -> +u
          // therefore yields ê_v x ê_u = -ê_axis: every quad comes out facing INTO the volume.
          // The symptom is subtle and easy to misread as a lighting bug — you see the far inner
          // walls of a box and the near faces vanish. Indices are reversed here so all faces are
          // front-facing, which is what FrontSide culling and the shadow pass both assume.
          const a0 = aoq[0], a1 = aoq[1], a2 = aoq[2], a3 = aoq[3];
          if (a0 + a2 > a1 + a3) {
            indices.push(vcount + 2, vcount + 1, vcount, vcount + 3, vcount + 2, vcount);
          } else {
            indices.push(vcount + 3, vcount + 2, vcount + 1, vcount, vcount + 3, vcount + 1);
          }
          vcount += 4;

          for (let jj = 0; jj < h; jj++) for (let ii = 0; ii < w; ii++) mask[(j + jj) * du + i + ii] = null;
          i += w;
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('aLayer', new THREE.Float32BufferAttribute(layers, 1));
  geo.setAttribute('aShade', new THREE.Float32BufferAttribute(shades, 1));
  geo.setAttribute('aAo', new THREE.Float32BufferAttribute(aos, 1));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  geo.userData.triangles = indices.length / 3;
  return geo;
}
