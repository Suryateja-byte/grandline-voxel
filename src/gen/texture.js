// Procedural texture generation. No image files exist in this project, by rule.
//
// Everything is painted into a WebGL2 2D *array* texture: one 32x32 layer per material tile.
// An array texture (rather than an atlas grid) means mipmaps never bleed between tiles, which
// is what keeps voxel edges crisp at distance instead of turning to grey mush.
//
// Pixels are written directly into a Uint8Array — never through Canvas2D — because Canvas2D
// antialiasing differs between GPUs and platforms and would break bit-identical capture.

import * as THREE from 'three';
import { hex2rgb, mixHex, shadeDown, shadeUp, P } from './palette.js';
import { Rng, hash2, hashFloat } from '../core/rng.js';
import { clamp01, lerp, smoothstep } from '../core/math.js';

export const TILE = 32;

/** Per-tile painter surface. All coordinates are tile-local pixels. */
export class Painter {
  constructor(size, rng) {
    this.n = size;
    this.data = new Uint8Array(size * size * 4);
    this.rng = rng;
  }
  idx(x, y) { return ((y & (this.n - 1)) * this.n + (x & (this.n - 1))) * 4; }
  set(x, y, hex, a = 255) {
    const i = this.idx(x, y);
    const [r, g, b] = hex2rgb(hex);
    this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b; this.data[i + 3] = a;
  }
  get(x, y) {
    const i = this.idx(x, y);
    return (this.data[i] << 16) | (this.data[i + 1] << 8) | this.data[i + 2];
  }
  getA(x, y) { return this.data[this.idx(x, y) + 3]; }
  fill(hex, a = 255) {
    for (let y = 0; y < this.n; y++) for (let x = 0; x < this.n; x++) this.set(x, y, hex, a);
  }
  rect(x0, y0, w, h, hex, a = 255) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      if (x >= 0 && y >= 0 && x < this.n && y < this.n) this.set(x, y, hex, a);
    }
  }
  /** Filled ellipse — used for eyes, mouths, spots. */
  ellipse(cx, cy, rx, ry, hex, a = 255) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1 && x >= 0 && y >= 0 && x < this.n && y < this.n) this.set(x, y, hex, a);
      }
    }
  }
  line(x0, y0, x1, y1, hex, thick = 1) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 + 1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = Math.round(lerp(x0, x1, t)), y = Math.round(lerp(y0, y1, t));
      for (let oy = 0; oy < thick; oy++) for (let ox = 0; ox < thick; ox++) this.set(x + ox, y + oy, hex);
    }
  }
  /** Per-pixel colour jitter in HSL family — ART_BAR §4 forbids flat single-colour regions. */
  grain(amount = 0.06, scale = 1) {
    const n = this.n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = this.idx(x, y);
      if (this.data[i + 3] === 0) continue;
      const h = hashFloat(hash2(Math.floor(x / scale), Math.floor(y / scale), this.seedTag | 0));
      const f = 1 + (h - 0.5) * 2 * amount;
      this.data[i] = clamp255(this.data[i] * f);
      this.data[i + 1] = clamp255(this.data[i + 1] * f);
      this.data[i + 2] = clamp255(this.data[i + 2] * f);
    }
  }
  /** Quantised tonal steps toward shadow/highlight, giving the 2-3 step look of the bar. */
  steps(baseHex, count = 3, freq = 11, seedTag = 0) {
    const n = this.n;
    const cols = [];
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      // ART_BAR §4 wants 2-3 tonal steps that read as considered shading. The spread has to be
      // narrow: a wide spread at tile frequency reads as dirt, not as painted variation.
      cols.push(t < 0.5 ? mixHex(shadeDown(baseHex, 0.24), baseHex, t * 2) : mixHex(baseHex, shadeUp(baseHex, 0.22), (t - 0.5) * 2));
    }
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const h = hashFloat(hash2(Math.floor(x / freq), Math.floor(y / freq), seedTag));
      this.set(x, y, cols[Math.min(count - 1, Math.floor(h * count))]);
    }
  }
  /** Darken a border ring — reads as a bevel and separates adjacent voxels. */
  bevel(strength = 0.12, width = 2) {
    const n = this.n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const d = Math.min(x, y, n - 1 - x, n - 1 - y);
      if (d >= width) continue;
      const t = (1 - d / width) * strength;
      const i = this.idx(x, y);
      const up = (x + y) < n; // light from upper-left
      const f = up ? 1 + t * 0.9 : 1 - t;
      this.data[i] = clamp255(this.data[i] * f);
      this.data[i + 1] = clamp255(this.data[i + 1] * f);
      this.data[i + 2] = clamp255(this.data[i + 2] * f);
    }
  }
  clear() { this.data.fill(0); }
}

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

/**
 * The texture library. Register named tiles with a painter function; build() produces
 * a DataArrayTexture. Layer indices are assigned in registration order and are stable,
 * which matters because saved games reference material ids, not layer numbers.
 */
export class TextureLibrary {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.names = [];
    this.index = new Map();
    this.layers = [];
    this.texture = null;
  }

  /** @param {string} name @param {(p: Painter, rng: Rng)=>void} paint */
  add(name, paint) {
    if (this.index.has(name)) return this.index.get(name);
    const layer = this.names.length;
    const rng = Rng.fromName(this.seed, 'tex:' + name);
    const p = new Painter(TILE, rng);
    p.seedTag = (this.seed ^ (layer * 2654435761)) >>> 0;
    p.fill(0xff00ff, 255); // magenta means "painter forgot to paint"
    paint(p, rng);
    this.names.push(name);
    this.index.set(name, layer);
    this.layers.push(p.data);
    return layer;
  }

  layerOf(name) {
    const v = this.index.get(name);
    if (v === undefined) throw new Error('texture layer not registered: ' + name);
    return v;
  }

  has(name) { return this.index.has(name); }

  build(anisotropy = 4) {
    const count = this.layers.length;
    const data = new Uint8Array(TILE * TILE * 4 * count);
    for (let i = 0; i < count; i++) data.set(this.layers[i], i * TILE * TILE * 4);
    const tex = new THREE.DataArrayTexture(data, TILE, TILE, count);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.NearestFilter;   // crisp voxel pixels up close
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = true;
    tex.anisotropy = anisotropy;
    tex.needsUpdate = true;
    this.texture = tex;
    return tex;
  }

  get count() { return this.layers.length; }
}

// ---------------------------------------------------------------------------
// Painters. Each one is a small piece of art direction.
// ---------------------------------------------------------------------------

/** Flat-ish material with tonal steps and grain. The default look. */
export function paintSolid(base, opts = {}) {
  return (p, rng) => {
    p.steps(base, opts.stepCount || 3, opts.freq || 11, p.seedTag);
    if (opts.speckle) {
      const sp = opts.speckleColor || shadeDown(base, 0.8);
      for (let i = 0; i < ((opts.speckle * 0.45) * TILE * TILE) | 0; i++) {
        p.set(rng.int(0, TILE - 1), rng.int(0, TILE - 1), sp);
      }
    }
    p.grain(opts.grain !== undefined ? opts.grain : 0.028, 3);
    if (opts.bevel !== false) p.bevel(opts.bevelStrength || 0.10, 3);
  };
}

export function paintGrassTop(base, dark) {
  return (p, rng) => {
    p.steps(base, 3, 12, p.seedTag);
    // Short blades: vertical 1-2px strokes of the darker green.
    for (let i = 0; i < 46; i++) {
      const x = rng.int(0, TILE - 1), y = rng.int(0, TILE - 1);
      const h = rng.int(1, 3);
      const c = rng.chance(0.5) ? dark : shadeUp(base, 0.22);
      for (let k = 0; k < h; k++) p.set(x, y + k, c);
    }
    p.grain(0.032, 2);
    p.bevel(0.10, 3);
  };
}

export function paintGrassSide(grassTop, dirtBase) {
  return (p, rng) => {
    // Dirt body...
    p.steps(dirtBase, 3, 5, p.seedTag);
    for (let i = 0; i < 40; i++) p.set(rng.int(0, TILE - 1), rng.int(0, TILE - 1), shadeDown(dirtBase, 0.7));
    // ...with a ragged grass lip over the top third. The ragged edge is what reads as grass.
    for (let x = 0; x < TILE; x++) {
      const h = 7 + Math.floor(hashFloat(hash2(x, 17, p.seedTag)) * 5);
      for (let y = 0; y < h; y++) {
        const c = y > h - 3 ? shadeDown(grassTop, 0.5) : (y < 2 ? shadeUp(grassTop, 0.35) : grassTop);
        p.set(x, y, c);
      }
    }
    p.grain(0.05, 2);
    p.bevel(0.10, 3);
  };
}

export function paintSandTop(base, dark) {
  return (p, rng) => {
    p.steps(base, 3, 13, p.seedTag);
    for (let i = 0; i < 46; i++) p.set(rng.int(0, TILE - 1), rng.int(0, TILE - 1), rng.chance(0.5) ? dark : shadeUp(base, 0.20));
    // Two faint ripple bands only. A band every few pixels tiles into a chevron pattern that
    // reads as a texture error across a whole beach.
    for (let b = 0; b < 2; b++) {
      const y0 = 7 + b * 15;
      for (let x = 0; x < TILE; x++) {
        const yy = y0 + ((x * 7) % 3);
        p.set(x, yy, dark);
      }
    }
    p.grain(0.03, 2);
    p.bevel(0.08, 3);
  };
}

export function paintRock(base, dark) {
  return (p, rng) => {
    p.steps(base, 3, 13, p.seedTag);
    // Angular fracture lines. These are the readable feature; everything else is noise floor.
    for (let i = 0; i < 3; i++) {
      const x0 = rng.int(0, TILE - 1), y0 = rng.int(0, TILE - 1);
      const x1 = x0 + rng.int(-12, 12), y1 = y0 + rng.int(-12, 12);
      p.line(x0, y0, x1, y1, dark, 1);
    }
    for (let i = 0; i < 16; i++) p.set(rng.int(0, TILE - 1), rng.int(0, TILE - 1), rng.chance(0.5) ? dark : shadeUp(base, 0.18));
    p.grain(0.035, 3);
    p.bevel(0.16, 3);
  };
}

export function paintPlank(base, dark, vertical = false) {
  return (p, rng) => {
    p.steps(base, 3, 12, p.seedTag);
    const bandH = 8;
    for (let b = 0; b <= TILE / bandH; b++) {
      const at = b * bandH;
      for (let i = 0; i < TILE; i++) {
        if (vertical) p.set(at, i, dark);
        else p.set(i, at, dark);
      }
    }
    // Wood grain streaks along the plank direction.
    for (let i = 0; i < 11; i++) {
      const a = rng.int(0, TILE - 1), len = rng.int(5, 16), s = rng.int(0, TILE - 1);
      const c = rng.chance(0.5) ? shadeDown(base, 0.28) : shadeUp(base, 0.18);
      for (let k = 0; k < len; k++) {
        if (vertical) p.set(a, (s + k) % TILE, c); else p.set((s + k) % TILE, a, c);
      }
    }
    // Nail heads at the plank joints — small, but they sell "built by hand".
    for (let b = 0; b <= TILE / bandH; b++) {
      const at = b * bandH;
      const q = 4;
      if (vertical) { p.set(at + 1, q, P.metalDark); p.set(at + 1, TILE - q, P.metalDark); }
      else { p.set(q, at + 1, P.metalDark); p.set(TILE - q, at + 1, P.metalDark); }
    }
    p.grain(0.05, 2);
    p.bevel(0.12, 3);
  };
}

export function paintLeaves(base, dark) {
  return (p, rng) => {
    p.fill(base, 0);
    // Cluster of overlapping leaf blobs with holes — silhouette must stay ragged.
    for (let i = 0; i < 26; i++) {
      const cx = rng.int(2, TILE - 3), cy = rng.int(2, TILE - 3);
      const r = rng.range(3, 7);
      const c = rng.chance(0.4) ? dark : (rng.chance(0.5) ? shadeUp(base, 0.35) : base);
      p.ellipse(cx, cy, r, r * rng.range(0.7, 1.1), c, 255);
    }
    // Punch holes so light reads through the canopy.
    for (let i = 0; i < 14; i++) {
      const cx = rng.int(0, TILE - 1), cy = rng.int(0, TILE - 1);
      p.ellipse(cx, cy, rng.range(1, 2.4), rng.range(1, 2.4), 0, 0);
    }
    p.grain(0.08, 1);
  };
}

export function paintWater(base) {
  return (p) => {
    p.steps(base, 3, 8, p.seedTag);
    p.grain(0.05, 2);
  };
}

export function paintCloth(base, opts = {}) {
  return (p, rng) => {
    p.steps(base, 3, 6, p.seedTag);
    // Weave: alternating 1px cross-hatch, very subtle.
    for (let y = 0; y < TILE; y += 3) for (let x = 0; x < TILE; x++) {
      if ((x + y) % 2 === 0) p.set(x, y, shadeDown(base, 0.22));
    }
    if (opts.stripe) {
      for (let y = 0; y < TILE; y++) {
        if (Math.floor(y / 6) % 2 === 0) for (let x = 0; x < TILE; x++) p.set(x, y, opts.stripe);
      }
    }
    if (opts.patch) {
      p.rect(rng.int(2, 18), rng.int(2, 18), rng.int(5, 9), rng.int(5, 9), shadeDown(base, 0.35));
    }
    p.grain(0.04, 2);
    p.bevel(0.08, 3);
  };
}

/**
 * Face painter. ART_BAR §2 is explicit: faces are drawn into the texture, are high contrast,
 * and use large angular eyes. This is the single highest-leverage art function in the project.
 *
 * @param {object} spec
 *  skin, eye: 'open'|'happy'|'angry'|'dead'|'shock'|'sly', mouth: 'smile'|'grin'|'flat'|'snarl'|'open',
 *  scar: 'none'|'cheek'|'eye'|'cross', brow: 'none'|'angry'|'sad', blush: bool, eyeColor
 */
export function paintFace(spec) {
  return (p, rng) => {
    const skin = spec.skin || P.skin;
    p.steps(skin, 3, 7, p.seedTag);
    p.grain(0.035, 2);

    const dark = spec.eyeColor || P.eyeDark;
    const eyeY = 13;
    const lx = 9, rx = 22;

    const drawBrow = (cx, dir) => {
      if (spec.brow === 'angry') p.line(cx - 4, eyeY - 6 + (dir > 0 ? 2 : 0), cx + 4, eyeY - 6 + (dir > 0 ? 0 : 2), dark, 2);
      else if (spec.brow === 'sad') p.line(cx - 4, eyeY - 5 + (dir > 0 ? 0 : 2), cx + 4, eyeY - 5 + (dir > 0 ? 2 : 0), dark, 2);
    };

    const eye = spec.eye || 'open';
    const drawEye = (cx, dir) => {
      if (eye === 'happy') {
        // Bold inverted-V wedge. Never dots (ART_BAR §2).
        p.line(cx - 5, eyeY + 3, cx, eyeY - 3, dark, 3);
        p.line(cx, eyeY - 3, cx + 5, eyeY + 3, dark, 3);
      } else if (eye === 'angry') {
        p.rect(cx - 5, eyeY - 2, 10, 6, dark);
        p.rect(cx - 5, eyeY - 4, 10, 3, skin);
        p.line(cx - 5 - dir * 1, eyeY - 4, cx + 5 - dir * 1, eyeY - 1, dark, 2);
        p.rect(cx - 2, eyeY - 1, 3, 3, P.eyeWhite);
      } else if (eye === 'dead') {
        p.line(cx - 5, eyeY - 4, cx + 5, eyeY + 4, dark, 3);
        p.line(cx + 5, eyeY - 4, cx - 5, eyeY + 4, dark, 3);
      } else if (eye === 'shock') {
        p.ellipse(cx, eyeY, 5.5, 6, P.eyeWhite);
        p.ellipse(cx, eyeY, 2.6, 3, dark);
      } else if (eye === 'sly') {
        p.rect(cx - 5, eyeY - 1, 10, 4, dark);
        p.rect(cx - 2, eyeY, 3, 2, P.eyeWhite);
      } else {
        // 'open': big angular eye, white with a dark pupil block and a highlight pixel.
        p.rect(cx - 5, eyeY - 5, 10, 10, dark);
        p.rect(cx - 4, eyeY - 4, 8, 8, P.eyeWhite);
        p.rect(cx - 3, eyeY - 3, 6, 6, dark);
        p.rect(cx - 2, eyeY - 2, 3, 3, P.eyeWhite);
      }
      drawBrow(cx, dir);
    };
    drawEye(lx, 1);
    drawEye(rx, -1);

    const mouth = spec.mouth || 'smile';
    const my = 24;
    if (mouth === 'grin') {
      p.ellipse(16, my, 8, 5, P.mouth);
      p.rect(8, my - 5, 17, 3, P.tooth);
      p.rect(8, my - 5, 17, 1, shadeDown(P.tooth, 0.4));
    } else if (mouth === 'open') {
      p.ellipse(16, my, 5, 5.5, P.mouth);
      p.rect(11, my - 5, 11, 2, P.tooth);
    } else if (mouth === 'flat') {
      p.rect(11, my, 11, 2, shadeDown(skin, 1.0));
    } else if (mouth === 'snarl') {
      p.ellipse(16, my, 7, 4, P.mouth);
      for (let i = 0; i < 4; i++) p.rect(10 + i * 4, my - 4, 3, 4, P.tooth);
      p.line(9, my - 4, 23, my - 4, shadeDown(P.mouth, 0.5), 1);
    } else {
      // 'smile'
      p.line(10, my - 1, 13, my + 2, shadeDown(skin, 1.1), 2);
      p.line(13, my + 2, 19, my + 2, shadeDown(skin, 1.1), 2);
      p.line(19, my + 2, 22, my - 1, shadeDown(skin, 1.1), 2);
    }

    if (spec.scar === 'cheek') {
      p.line(6, 19, 6, 22, P.heroRedDark, 2);
      p.line(5, 20, 8, 20, P.heroRedDark, 1);
    } else if (spec.scar === 'eye') {
      p.line(lx, 5, lx - 2, 22, P.heroRedDark, 2);
    } else if (spec.scar === 'cross') {
      p.line(20, 6, 27, 20, P.heroRedDark, 2);
      p.line(27, 8, 20, 19, P.heroRedDark, 2);
    }
    if (spec.blush) {
      for (let i = 0; i < 3; i++) {
        p.rect(3, 19 + i * 2, 4, 1, mixHex(skin, P.heroRed, 0.35));
        p.rect(25, 19 + i * 2, 4, 1, mixHex(skin, P.heroRed, 0.35));
      }
    }
    p.bevel(0.06, 2);
  };
}

/** Sail cloth with a hand-painted jolly roger. Used for pirate ships and flags. */
export function paintJollyRoger(cloth, ink, kind = 'skull') {
  return (p, rng) => {
    p.steps(cloth, 3, 7, p.seedTag);
    for (let y = 0; y < TILE; y += 3) for (let x = 0; x < TILE; x++) if ((x + y) % 2 === 0) p.set(x, y, shadeDown(cloth, 0.18));
    const cx = 16, cy = 14;
    if (kind === 'skull' || kind === 'straw') {
      p.ellipse(cx, cy, 7, 6.5, ink);
      p.rect(cx - 4, cy + 5, 8, 4, ink);
      p.rect(cx - 4, cy - 2, 3, 4, cloth);   // eye sockets
      p.rect(cx + 1, cy - 2, 3, 4, cloth);
      p.rect(cx - 1, cy + 3, 2, 2, cloth);   // nose
      for (let i = 0; i < 3; i++) p.rect(cx - 3 + i * 3, cy + 6, 1, 3, cloth); // teeth
      // Crossbones
      p.line(cx - 11, cy + 12, cx + 11, cy + 4, ink, 2);
      p.line(cx - 11, cy + 4, cx + 11, cy + 12, ink, 2);
      if (kind === 'straw') {
        p.rect(cx - 9, cy - 8, 18, 3, P.strawHat);
        p.rect(cx - 6, cy - 11, 12, 3, P.strawHat);
        p.rect(cx - 9, cy - 6, 18, 1, P.hatBand);
      }
    } else if (kind === 'marine') {
      p.rect(cx - 9, cy - 6, 18, 14, P.marineWhite);
      p.rect(cx - 7, cy - 4, 14, 10, P.marineBlue);
      for (let i = 0; i < 5; i++) p.rect(cx - 7 + i * 3, cy - 4, 2, 10, P.marineWhite);
      p.rect(cx - 9, cy + 9, 18, 2, P.marineNavy);
    }
    p.grain(0.04, 2);
  };
}

/** Utility: a tile that is a flat colour with tonal steps — the common case. */
export function registerCommonTiles(lib) {
  const t = (n, f) => lib.add(n, f);
  t('sand_top', paintSandTop(P.sand, P.sandDark));
  t('sand_side', paintSolid(P.sandDark, { speckle: 0.05, speckleColor: P.sandWet }));
  t('sand_wet', paintSandTop(P.sandWet, shadeDown(P.sandWet, 0.5)));
  t('grass_top', paintGrassTop(P.grass, P.grassDark));
  t('grass_side', paintGrassSide(P.grass, P.dirt));
  t('grass_dry_top', paintGrassTop(P.grassDry, shadeDown(P.grassDry, 0.5)));
  t('grass_cold_top', paintGrassTop(P.grassCold, shadeDown(P.grassCold, 0.5)));
  t('jungle_top', paintGrassTop(P.jungle, P.jungleDark));
  t('dirt', paintSolid(P.dirt, { speckle: 0.08, speckleColor: P.dirtDark }));
  t('rock', paintRock(P.rock, P.rockDark));
  t('rock_cold', paintRock(P.rockCold, shadeDown(P.rockCold, 0.6)));
  t('stone', paintRock(P.stone, P.stoneDark));
  t('volcanic', paintRock(P.volcanicRock, 0x241d1b));
  t('ash', paintSolid(P.ash, { speckle: 0.1, speckleColor: 0x6a625e }));
  t('snow', paintSolid(P.snow, { grain: 0.03, speckle: 0.04, speckleColor: 0xdfe8f5 }));
  t('ice', paintSolid(P.ice, { grain: 0.06, stepCount: 3 }));
  t('lava', paintSolid(P.lava, { speckle: 0.12, speckleColor: P.lavaHot, grain: 0.12 }));
  t('clay', paintSolid(P.clay, { speckle: 0.05 }));
  t('coral', paintSolid(P.coral, { speckle: 0.1, speckleColor: P.coralAlt }));
  t('wood', paintPlank(P.wood, P.woodDark, true));
  t('plank', paintPlank(P.plank, P.plankDark, false));
  t('plank_v', paintPlank(P.plank, P.plankDark, true));
  t('wood_dark', paintPlank(P.woodDark, 0x5a3a20, true));
  t('thatch', paintSolid(P.thatch, { speckle: 0.14, speckleColor: shadeDown(P.thatch, 0.6) }));
  t('leaves', paintLeaves(P.jungle, P.jungleDark));
  t('leaves_palm', paintLeaves(0x4e9e3a, 0x35772a));
  t('leaves_cherry', paintLeaves(P.cherryBlossom, shadeDown(P.cherryBlossom, 0.4)));
  t('leaves_autumn', paintLeaves(P.autumnLeaf, shadeDown(P.autumnLeaf, 0.5)));
  t('leaves_pine', paintLeaves(0x2f7a4a, 0x1f5a34));
  t('sail', paintCloth(P.sail));
  t('sail_shade', paintCloth(P.sailShade));
  t('rope', paintSolid(P.rope, { speckle: 0.12, speckleColor: shadeDown(P.rope, 0.5) }));
  t('metal', paintSolid(P.metal, { grain: 0.04, bevelStrength: 0.2 }));
  t('metal_dark', paintSolid(P.metalDark, { grain: 0.04, bevelStrength: 0.2 }));
  t('gold', paintSolid(P.gold, { grain: 0.05, bevelStrength: 0.24 }));
  t('glass', paintSolid(P.glass, { grain: 0.03 }));
  t('brick', paintPlank(P.brickRed, shadeDown(P.brickRed, 0.5), false));
  t('roof', paintPlank(P.roofTile, P.roofTileDark, false));
  t('paper', paintSolid(P.paper, { grain: 0.04, speckle: 0.03, speckleColor: P.uiPaperDark }));
  t('cactus', paintSolid(P.cactus, { speckle: 0.06, speckleColor: shadeUp(P.cactus, 0.4) }));
  t('mushroom_cap', paintSolid(P.mushroomCap, { speckle: 0.06, speckleColor: P.uiWhite }));
  t('mushroom_stem', paintSolid(P.mushroomStem, {}));
  t('barrel', paintPlank(P.barrel, shadeDown(P.barrel, 0.5), true));
  t('flag_red', paintCloth(P.flagRed));
  t('roger_straw', paintJollyRoger(P.sail, P.ink, 'straw'));
  t('roger_skull', paintJollyRoger(P.sail, P.ink, 'skull'));
  t('roger_marine', paintJollyRoger(P.marineWhite, P.marineBlue, 'marine'));
  return lib;
}
