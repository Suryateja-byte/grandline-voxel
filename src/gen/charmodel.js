// Procedural voxel characters. Owner: Cluster B (character / rig / animation / camera).
//
// A character is NOT one mesh. It is a set of independent VoxelVolumes — head, torso, two
// arms, two legs, an identity element ("hat") and an optional weapon — each meshed with its
// vertices expressed relative to its own joint pivot. The rig therefore only has to position
// and rotate; it never rebuilds geometry. That is the whole reason parts exist.
//
// Art bar this file is judged against (reference/ART_BAR.md §1, §2, §4):
//   * voxel size 0.25 m, character 14–18 voxels tall
//   * head is 38–42% of total height, head width 1.5–1.7x torso width
//   * one identity element per archetype that BREAKS THE HEAD SILHOUETTE
//   * the face is painted into the texture, never modelled, with eyes 2–3 voxels across
//   * every surface carries 2–3 tonal steps (all painters here go through Painter.steps)
//
// A note on the height table. The art bar allows 14–18 voxels total and a 38–42% head. With
// whole voxels that leaves exactly three legal totals: 15 (head 6 = 40.0%), 17 (head 7 =
// 41.2%) and 18 (head 7 = 38.9%). 14 and 16 have no integer head that lands in the band, so
// they are not used. Size variety comes from bulk and from the identity element instead,
// which is also where silhouette variety actually lives.

import { P, shadeUp, shadeDown } from './palette.js';
import { Rng, hashString } from '../core/rng.js';
import { VoxelVolume, meshVolume } from './voxel.js';
import {
  TILE, Painter, paintFace, paintSolid, paintCloth,
} from './texture.js';

/** Character voxel size in metres (ARCHITECTURE §3). */
export const CHAR_VOXEL = 0.25;
const S = CHAR_VOXEL;

/** How many voxel rows of the head front the painted face is stretched across. */
const FACE_ROWS = 4;
/** Face never spans more than this many columns, so wide-skulled brutes keep visible cheeks. */
const FACE_MAX_COLS = 6;

// Symbolic materials. Part volumes are filled with these; buildCharacter remaps them to
// block ids from the per-spec tile map. Keeping the layout symbolic is what lets
// buildSilhouetteTest run with no TextureLibrary and no GL context at all.
const M = {
  SKIN: 1, HAIR: 2, TOP: 3, TOPALT: 4, SASH: 5, PANTS: 6,
  BOOT: 7, HAT: 8, HATALT: 9, ACCENT: 10, METAL: 11, GRIP: 12,
};
const M_NAMES = {
  1: 'skin', 2: 'hair', 3: 'top', 4: 'topAlt', 5: 'sash', 6: 'pants',
  7: 'boot', 8: 'hat', 9: 'hatAlt', 10: 'accent', 11: 'metal', 12: 'grip',
};

// ---------------------------------------------------------------------------
// Small volume helpers. All of them clip silently — VoxelVolume.set bounds-checks.
// ---------------------------------------------------------------------------

/** Solid ellipse in the XZ plane at height y. Used for hat brims and domes. */
function discXZ(vol, y, cx, cz, rx, rz, id) {
  for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx, dz = (z - cz) / rz;
      if (dx * dx + dz * dz <= 1.02) vol.set(x, y, z, id);
    }
  }
}

/** Solid ellipsoid. The workhorse for hair masses, domes and pommels. */
function blob(vol, cx, cy, cz, rx, ry, rz, id) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry, dz = (z - cz) / rz;
        if (dx * dx + dy * dy + dz * dz <= 1.02) vol.set(x, y, z, id);
      }
    }
  }
}

/** Mirror everything already written into the -X half onto the +X half. */
function mirrorX(vol) {
  const w = vol.sx;
  for (let y = 0; y < vol.sy; y++) {
    for (let z = 0; z < vol.sz; z++) {
      for (let x = 0; x < (w >> 1); x++) {
        const v = vol.get(x, y, z);
        if (v) vol.set(w - 1 - x, y, z, v);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Texture registration
// ---------------------------------------------------------------------------

// Content-addressed layer cache, per TextureLibrary. Two archetypes that wear the same
// colour of cloth share one layer instead of paying for two, which matters: a lineup of
// twenty characters would otherwise push the texture array past 700 layers.
const TILE_CACHE = new WeakMap();
const MAP_CACHE = new WeakMap();

function cacheFor(tex) {
  let c = TILE_CACHE.get(tex);
  if (!c) { c = new Map(); TILE_CACHE.set(tex, c); }
  return c;
}

/** FNV-1a over the painted RGBA bytes. Only used for dedupe, never for gameplay. */
function hashBytes(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Paint a tile off to the side, then register it only if no byte-identical layer exists.
 * `contentKey` must describe the *pixels* (colours + style), never the character id, or
 * dedupe silently stops working.
 */
function addTile(tex, name, contentKey, paint) {
  const cache = cacheFor(tex);
  const rng = Rng.fromName(tex.seed, 'chartile:' + contentKey);
  const p = new Painter(TILE, rng);
  p.seedTag = (tex.seed ^ hashString(contentKey)) >>> 0;
  p.clear();               // fully transparent: a painter that forgets leaves a visible hole
  paint(p, rng);
  const h = hashBytes(p.data);
  const hit = cache.get(h);
  if (hit !== undefined) return hit;
  const layer = tex.add(name, (q) => { q.data.set(p.data); });
  cache.set(h, layer);
  return layer;
}

/** Straw / thatch weave: bright base, dense darker flecks, so it never reads as flat yellow. */
function paintStraw(base) {
  return (p, rng) => {
    p.steps(base, 3, 4, p.seedTag);
    for (let i = 0; i < 150; i++) {
      const x = rng.int(0, TILE - 1), y = rng.int(0, TILE - 1), len = rng.int(2, 5);
      const c = rng.chance(0.5) ? shadeDown(base, 0.55) : shadeUp(base, 0.35);
      for (let k = 0; k < len; k++) p.set(x + k, y, c);
    }
    p.grain(0.05, 1);
    p.bevel(0.12, 3);
  };
}

/** Hair: tonal steps plus directional strand streaks, so a head of hair is not a solid slab. */
function paintHair(base) {
  return (p, rng) => {
    p.steps(base, 3, 5, p.seedTag);
    for (let i = 0; i < 40; i++) {
      const x = rng.int(0, TILE - 1), y = rng.int(0, TILE - 1), len = rng.int(4, 11);
      const c = rng.chance(0.45) ? shadeDown(base, 0.5) : shadeUp(base, 0.55);
      for (let k = 0; k < len; k++) p.set(x, y + k, c);
    }
    p.grain(0.05, 1);
    p.bevel(0.14, 3);
  };
}

/** Leather / boot: darker, scuffed, with a stitch line so boots read as boots. */
function paintLeather(base) {
  return (p, rng) => {
    p.steps(base, 3, 6, p.seedTag);
    for (let i = 0; i < 30; i++) p.set(rng.int(0, TILE - 1), rng.int(0, TILE - 1), shadeUp(base, 0.4));
    for (let x = 0; x < TILE; x += 3) p.set(x, 6, shadeDown(base, 0.7));
    p.grain(0.05, 2);
    p.bevel(0.16, 3);
  };
}

/**
 * Slice one 32x32 painted face across a cols x rows block of voxel front-faces.
 *
 * The vertical flip is not cosmetic: DataArrayTexture uploads with flipY = false, so data row
 * 0 lands at v = 0, and the mesher maps v = 0 to the *bottom* of a +Z quad. paintFace draws in
 * image convention (mouth below eyes, larger y), so without this flip every character in the
 * game would smile out of its forehead.
 */
function sliceFace(tex, spec, cols, rows) {
  const f = spec.face || {};
  const skin = spec.skin || P.skin;
  const contentKey = ['face', skin, f.eye || 'open', f.mouth || 'smile', f.scar || 'none',
    f.brow || 'none', f.blush ? 1 : 0, f.eyeColor || P.eyeDark, cols, rows].join('|');

  const rng = Rng.fromName(tex.seed, 'charface:' + contentKey);
  const src = new Painter(TILE, rng);
  // Seed the skin grain from the skin colour alone, not from the expression. Two archetypes
  // with the same complexion then produce byte-identical featureless cells (cheeks, temples,
  // forehead corners) and share those layers instead of duplicating them.
  src.seedTag = hashString('skin|' + skin) >>> 0;
  src.fill(P.skin, 255);
  paintFace({
    skin, eye: f.eye, mouth: f.mouth, scar: f.scar, brow: f.brow,
    blush: f.blush, eyeColor: f.eyeColor,
  })(src, rng);

  const cells = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      const name = `char:${spec.id}:face_${r}_${c}`;
      const key = contentKey + '|' + r + '|' + c;
      row.push(addTile(tex, name, key, (p) => {
        for (let py = 0; py < TILE; py++) {
          for (let px = 0; px < TILE; px++) {
            const u = (c * TILE + px) / (cols * TILE);
            const v = (r * TILE + py) / (rows * TILE);
            const sx = Math.min(TILE - 1, (u * TILE) | 0);
            const sy = TILE - 1 - Math.min(TILE - 1, (v * TILE) | 0);
            const si = (sy * TILE + sx) * 4;
            const di = (py * TILE + px) * 4;
            p.data[di] = src.data[si];
            p.data[di + 1] = src.data[si + 1];
            p.data[di + 2] = src.data[si + 2];
            p.data[di + 3] = 255;
          }
        }
      }));
    }
    cells.push(row);
  }
  return cells;
}

/**
 * Register every texture layer one character archetype needs.
 * Idempotent: calling it twice for the same (tex, spec) returns the identical map.
 *
 * @param {import('./texture.js').TextureLibrary} tex shared library
 * @param {object} spec entry from CHARACTER_SPECS
 * @returns {{skin:number, hair:number, top:number, topAlt:number, sash:number, pants:number,
 *            boot:number, hat:number, hatAlt:number, accent:number, metal:number, grip:number,
 *            face:number[][], faceCols:number, faceRows:number}}
 */
export function registerCharacterTiles(tex, spec) {
  let maps = MAP_CACHE.get(tex);
  if (!maps) { maps = new Map(); MAP_CACHE.set(tex, maps); }
  const cached = maps.get(spec.id);
  if (cached) return cached;

  const g = geometryOf(spec);
  const c = spec.cloth;
  const skin = spec.skin;
  const id = spec.id;
  const T = (part, contentKey, paint) => addTile(tex, `char:${id}:${part}`, contentKey, paint);

  const map = {
    skin: T('skin', 'skin|' + skin, paintSolid(skin, { stepCount: 3, freq: 6, grain: 0.045, bevelStrength: 0.10 })),
    hair: T('hair', 'hair|' + spec.hair.color, paintHair(spec.hair.color)),
    top: T('top', ['top', c.top, c.stripe || 0, c.patch ? 1 : 0].join('|'),
      paintCloth(c.top, { stripe: c.stripe, patch: c.patch })),
    topAlt: T('topAlt', 'cloth|' + c.topAlt, paintCloth(c.topAlt)),
    sash: T('sash', 'cloth|' + c.sash, paintCloth(c.sash)),
    pants: T('pants', ['top', c.pants, c.pantStripe || 0, 0].join('|'),
      paintCloth(c.pants, { stripe: c.pantStripe })),
    boot: T('boot', 'leather|' + c.boot, paintLeather(c.boot)),
    accent: T('accent', 'cloth|' + c.accent, paintCloth(c.accent)),
    metal: T('metal', 'metal|' + (c.metal || P.metal),
      paintSolid(c.metal || P.metal, { stepCount: 3, grain: 0.035, bevelStrength: 0.26 })),
    grip: T('grip', 'leather|' + (c.grip || P.woodDark), paintLeather(c.grip || P.woodDark)),
  };

  const hat = spec.ident;
  map.hat = hat.straw
    ? T('hat', 'straw|' + hat.color, paintStraw(hat.color))
    : T('hat', 'cloth|' + hat.color, paintCloth(hat.color));
  map.hatAlt = T('hatAlt', 'cloth|' + (hat.alt || c.accent), paintCloth(hat.alt || c.accent));

  map.faceCols = g.faceCols;
  map.faceRows = g.faceRows;
  map.face = sliceFace(tex, spec, g.faceCols, g.faceRows);

  maps.set(spec.id, map);
  return map;
}

// ---------------------------------------------------------------------------
// Proportions
// ---------------------------------------------------------------------------

// total -> [headH, torsoH, legH]. Only these three totals keep the head inside 38–42%.
const BUILD_TABLE = {
  15: [6, 4, 5],
  17: [7, 4, 6],
  18: [7, 5, 6],
};
// torso width -> [head width, head depth]. Ratios: 5/3, 6/4, 8/5, 9/6 -> 1.67, 1.50, 1.60, 1.50.
const HEAD_TABLE = {
  3: [5, 4],
  4: [6, 5],
  5: [8, 6],
  6: [9, 7],
};

/** Derive every voxel dimension from the spec's build block. Pure, cheap, no allocation. */
function geometryOf(spec) {
  const b = spec.build;
  const [headH, torsoH, legH] = BUILD_TABLE[b.h];
  const [headW, headD] = HEAD_TABLE[b.torsoW];
  const torsoW = b.torsoW;
  const torsoD = Math.max(2, torsoW - 1);
  const armW = b.armW || (torsoW >= 6 ? 3 : 2);
  const armD = armW;
  const armLen = torsoH + (b.longArms ? 3 : 1);
  const legW = torsoW <= 4 ? 2 : 3;
  const legD = legW + 1;
  const legGap = torsoW >= 5 ? 1 : 0;
  return {
    h: b.h, headH, torsoH, legH, headW, headD, torsoW, torsoD,
    armW, armD, armLen, legW, legD, legGap,
    headYv: legH + torsoH,
    shoulderYv: legH + torsoH,
    armOffX: (torsoW + armW) / 2,
    legOffX: (legW + legGap) / 2,
    bootH: b.bootH !== undefined ? b.bootH : 2,
    faceRows: FACE_ROWS,
    faceCols: Math.min(headW, FACE_MAX_COLS),
  };
}

// ---------------------------------------------------------------------------
// Identity elements. ART_BAR §1: every archetype needs one, and it must extend past the head.
// Each returns a volume plus its voxel offset relative to the head volume's min corner.
// ---------------------------------------------------------------------------

const IDENT = {
  /**
   * Wide flat brim at ~1.33x head width with a crown *narrower* than the skull. The step
   * out-then-in is what makes a black cutout read as a hat rather than as a taller head.
   */
  strawHat(g) {
    const w = g.headW + 2, d = g.headD + 2;
    const vol = new VoxelVolume(w, 3, d);
    discXZ(vol, 0, (w - 1) / 2, (d - 1) / 2, w / 2, d / 2, M.HAT);
    vol.fillBox(2, 1, 2, w - 3, 2, d - 3, M.HAT);
    vol.fillBox(2, 1, 2, w - 3, 1, d - 3, M.HATALT);
    return { vol, off: [-1, g.headH - 1, -1] };
  },

  /** Floppy sun hat: even wider brim, low dome, ribbon. Reads slight and breezy. */
  sunHat(g) {
    const w = g.headW + 4, d = g.headD + 4;
    const vol = new VoxelVolume(w, 3, d);
    discXZ(vol, 0, (w - 1) / 2, (d - 1) / 2, w / 2, d / 2, M.HAT);
    discXZ(vol, 1, (w - 1) / 2, (d - 1) / 2, w / 2 - 1.2, d / 2 - 1.2, M.HATALT);
    discXZ(vol, 2, (w - 1) / 2, (d - 1) / 2, w / 2 - 2.0, d / 2 - 2.0, M.HAT);
    return { vol, off: [-2, g.headH - 1, -2] };
  },

  /** Head wrap, a knot standing proud at the back, and two tails streaming back and down. */
  bandana(g) {
    const tail = 5;
    const vol = new VoxelVolume(g.headW, 7, g.headD + tail);
    vol.fillBox(0, 5, tail, g.headW - 1, 5, tail + g.headD - 1, M.ACCENT);
    // The knot is the only part that clears the skull; without it the wrap reads as hair.
    vol.fillBox((g.headW >> 1) - 1, 6, tail - 1, g.headW >> 1, 6, tail, M.ACCENT);
    for (let k = 0; k < tail; k++) {
      const y = 5 - Math.round(k * 0.9);
      vol.set(1, y, tail - 1 - k, M.ACCENT);
      vol.set(2, y, tail - 1 - k, M.ACCENT);
      vol.set(g.headW - 3, y - 1, tail - 1 - k, M.ACCENT);
      vol.set(g.headW - 2, y - 1, tail - 1 - k, M.ACCENT);
    }
    return { vol, off: [0, g.headH - 6, -tail] };
  },

  /** Kerchief: wrap plus a knot at the back. Villager read, quieter than a bandana. */
  headscarf(g) {
    const vol = new VoxelVolume(g.headW, 4, g.headD + 3);
    vol.fillBox(0, 1, 3, g.headW - 1, 3, 3 + g.headD - 1, M.ACCENT);
    blob(vol, (g.headW - 1) / 2, 2, 1, 1.6, 1.6, 1.6, M.ACCENT);
    vol.set(1, 0, 1, M.ACCENT);
    vol.set(g.headW - 2, 0, 1, M.ACCENT);
    return { vol, off: [0, g.headH - 3, -3] };
  },

  /** Hood: a shell over the crown that peaks up and trails back. */
  hood(g) {
    const w = g.headW + 2, d = g.headD + 4;
    const vol = new VoxelVolume(w, 5, d);
    // Back and side shell, deliberately open at the front so the face still reads.
    for (let y = 0; y < 4; y++) {
      for (let z = 0; z < d - 2; z++) {
        vol.set(0, y, z, M.HAT);
        vol.set(w - 1, y, z, M.HAT);
      }
      for (let x = 0; x < w; x++) vol.set(x, y, 0, M.HAT);
    }
    for (let x = 0; x < w; x++) for (let z = 0; z < d - 2; z++) vol.set(x, 4, z, M.HAT);
    // Peak that flops backwards — the bit that survives being filled with black.
    vol.set((w >> 1) - 1, 4, 0, M.HAT); vol.set(w >> 1, 4, 0, M.HAT);
    blob(vol, (w - 1) / 2, 3, 0, 1.4, 1.4, 1.2, M.HATALT);
    return { vol, off: [-1, g.headH - 4, -4] };
  },

  /** Antler nubs plus a soft cap. Reads small and friendly at any distance. */
  doctorCap(g) {
    const w = g.headW + 4;
    const vol = new VoxelVolume(w, 5, g.headD + 1);
    discXZ(vol, 0, (w - 1) / 2, (g.headD - 1) / 2, g.headW / 2 + 0.6, g.headD / 2 + 0.6, M.HAT);
    blob(vol, (w - 1) / 2, 2, (g.headD - 1) / 2, g.headW / 2 - 0.4, 1.6, g.headD / 2 - 0.4, M.HAT);
    blob(vol, (w - 1) / 2, 3, (g.headD - 1) / 2, 1.2, 1.2, 1.2, M.HATALT);
    for (let k = 0; k < 3; k++) { vol.set(1, 1 + k, 1, M.HATALT); }
    vol.set(0, 3, 1, M.HATALT);
    mirrorX(vol);
    return { vol, off: [-2, g.headH - 1, 0] };
  },

  /** Tall pleated cook's hat. Doubles the head height — unmistakable from across a deck. */
  chefHat(g) {
    const w = g.headW, d = g.headD;
    const vol = new VoxelVolume(w + 2, 7, d + 2);
    vol.fillBox(1, 0, 1, w, 1, d, M.HATALT);
    for (let y = 2; y < 5; y++) discXZ(vol, y, (w + 1) / 2, (d + 1) / 2, w / 2, d / 2, M.HAT);
    discXZ(vol, 5, (w + 1) / 2, (d + 1) / 2, w / 2 + 0.9, d / 2 + 0.9, M.HAT);
    discXZ(vol, 6, (w + 1) / 2, (d + 1) / 2, w / 2 - 0.4, d / 2 - 0.4, M.HAT);
    return { vol, off: [-1, g.headH - 1, -1] };
  },

  /** Three-cornered hat: brim with upturned front and side points. Bandit-lord read. */
  tricorn(g) {
    const w = g.headW + 4, d = g.headD + 4;
    const vol = new VoxelVolume(w, 4, d);
    discXZ(vol, 0, (w - 1) / 2, (d - 1) / 2, w / 2, d / 2, M.HAT);
    vol.fillBox(2, 1, 2, w - 3, 2, d - 3, M.HAT);
    vol.fillBox(2, 1, 2, w - 3, 1, d - 3, M.HATALT);
    // Three upturned corners.
    for (let x = 1; x < w - 1; x++) vol.set(x, 1, d - 1, M.HAT);
    for (let z = 1; z < d - 1; z++) { vol.set(0, 1, z, M.HAT); vol.set(w - 1, 1, z, M.HAT); }
    vol.set((w >> 1), 2, d - 1, M.HATALT);
    return { vol, off: [-2, g.headH - 1, -2] };
  },

  /** Flat-topped marine cap with a forward peak. `rank` grows the crown and adds a crest. */
  marineCap(g, spec) {
    const rank = spec.ident.rank || 0;
    const w = g.headW + 2, d = g.headD + 3, h = 5 + rank;
    const vol = new VoxelVolume(w, h, d);
    vol.fillBox(1, 0, 2, w - 2, 0, d - 1, M.HATALT);           // band
    for (let y = 1; y < 1 + 1 + rank; y++) vol.fillBox(1, y, 2, w - 2, y, d - 1, M.HAT);
    const top = 1 + rank;
    vol.fillBox(0, top + 1, 1, w - 1, top + 1, d - 1, M.HAT);   // flat wide crown
    vol.fillBox(1, 0, 0, w - 2, 0, 1, M.HATALT);                // peak, forward of the brow
    if (rank > 0) {
      vol.fillBox((w >> 1) - 1, top + 2, 2, (w >> 1) + 1, top + 2, d - 3, M.METAL);
      vol.set((w >> 1), 0, 0, M.METAL);
    }
    if (rank > 1) {
      for (let x = 0; x < w; x++) vol.set(x, top + 2, d - 1, M.METAL);
    }
    return { vol, off: [-1, g.headH - 1, -1] };
  },

  /**
   * Dome helm with two horns curling out and up. The horn path is authored voxel by voxel and
   * stays face-connected to the helm band — a horn that floats free of the skull reads as a
   * meshing bug, not as a horn.
   */
  hornedHelm(g) {
    const w = g.headW + 6;
    const vol = new VoxelVolume(w, 7, g.headD + 1);
    const cz = Math.round((g.headD - 1) / 2);
    // Straight-sided helm body, not a dome: a dome narrows away from the horn root and leaves
    // a hole in the front projection two rows up.
    vol.fillBox(3, 0, 0, w - 4, 2, g.headD, M.METAL);
    discXZ(vol, 3, (w - 1) / 2, g.headD / 2, g.headW / 2 + 0.2, g.headD / 2 + 0.2, M.METAL);
    discXZ(vol, 4, (w - 1) / 2, g.headD / 2, g.headW / 2 - 1.4, g.headD / 2 - 1.4, M.METAL);
    const horn = [[2, 1], [2, 2], [1, 2], [1, 3], [0, 3], [0, 4], [0, 5]];
    for (const [hx, hy] of horn) {
      vol.set(hx, hy, cz, M.HAT);
      vol.set(hx, hy, cz + 1, M.HAT);
    }
    mirrorX(vol);
    return { vol, off: [-3, g.headH - 1, 0] };
  },

  /**
   * Goggles pushed up onto the crown plus a long pointed nose. The nose is the read from the
   * side, the lens pods are the read from the front — nothing else in the cast is wide at
   * exactly brow height.
   */
  longNose(g) {
    const w = g.headW + 2, d = g.headD + 4, h = g.headH + 2;
    const vol = new VoxelVolume(w, h, d);
    // Nose: four voxels straight out of the face, at eye height (head row 2).
    for (let k = 0; k < 4; k++) vol.set(w >> 1, 2, g.headD + k, M.SKIN);
    vol.set((w >> 1) - 1, 2, g.headD, M.SKIN);
    // Strap over the crown, lens pods sitting proud of the skull on both sides.
    vol.fillBox(1, g.headH, 1, w - 2, g.headH, g.headD, M.ACCENT);
    blob(vol, 0, g.headH, g.headD - 1, 1.3, 1.2, 1.2, M.METAL);
    blob(vol, w - 1, g.headH, g.headD - 1, 1.3, 1.2, 1.2, M.METAL);
    return { vol, off: [-1, 0, 0] };
  },

  /** Swept-back pompadour. Shipwright read: all mass, no hardware. */
  pompadour(g) {
    const w = g.headW + 2, d = g.headD + 3;
    const vol = new VoxelVolume(w, 5, d);
    blob(vol, (w - 1) / 2, 1, d - 3, g.headW / 2 + 0.6, 2.0, g.headD / 2 + 0.5, M.HAIR);
    blob(vol, (w - 1) / 2, 3, d - 5, g.headW / 2 - 0.4, 1.6, g.headD / 2 - 0.6, M.HAIR);
    for (let k = 0; k < 3; k++) vol.set(2 + k * 2, 4, d - 4 - k, M.HAIR);
    return { vol, off: [-1, g.headH - 2, -2] };
  },

  /** Afro plus a tall hat. The single largest silhouette in the cast. */
  afroTopHat(g) {
    const w = g.headW + 5, d = g.headD + 5;
    const vol = new VoxelVolume(w, 10, d);
    blob(vol, (w - 1) / 2, 2, (d - 1) / 2, w / 2 - 0.3, 2.8, d / 2 - 0.3, M.HAIR);
    vol.fillBox(2, 4, 2, w - 3, 4, d - 3, M.HAT);
    for (let y = 5; y < 9; y++) vol.fillBox(3, y, 3, w - 4, y, d - 4, M.HAT);
    vol.fillBox(3, 5, 3, w - 4, 5, d - 4, M.HATALT);
    vol.fillBox(3, 9, 3, w - 4, 9, d - 4, M.HAT);
    return { vol, off: [-2, g.headH - 3, -2] };
  },

  /** Dorsal crest. Fishman read — nothing else in the cast has a blade on its skull. */
  finCrest(g) {
    const d = g.headD + 3;
    const vol = new VoxelVolume(g.headW, 6, d);
    const cx = g.headW >> 1;
    for (let z = 0; z < d; z++) {
      const h = Math.max(0, 5 - Math.abs(z - (d - 4)) * 1.1) | 0;
      for (let y = 0; y <= h; y++) { vol.set(cx, y, z, M.ACCENT); vol.set(cx - 1, y, z, M.ACCENT); }
    }
    vol.fillBox(0, 0, d - g.headD, g.headW - 1, 0, d - 1, M.ACCENT);
    // Gill flashes at the temples.
    for (let k = 0; k < 3; k++) { vol.set(0, 1, d - 2 - k, M.HATALT); vol.set(g.headW - 1, 1, d - 2 - k, M.HATALT); }
    return { vol, off: [0, g.headH - 1, -3] };
  },

  /** Bowler with a stubby brim. Merchant read: neat, small, prosperous. */
  bowler(g) {
    const w = g.headW + 2, d = g.headD + 2;
    const vol = new VoxelVolume(w, 4, d);
    discXZ(vol, 0, (w - 1) / 2, (d - 1) / 2, w / 2, d / 2, M.HAT);
    vol.set(0, 1, (d - 1) >> 1, M.HAT); vol.set(w - 1, 1, (d - 1) >> 1, M.HAT);
    blob(vol, (w - 1) / 2, 1, (d - 1) / 2, g.headW / 2 + 0.2, 2.2, g.headD / 2 + 0.2, M.HAT);
    vol.fillBox(1, 1, 1, w - 2, 1, d - 2, M.HATALT);
    return { vol, off: [-1, g.headH - 1, -1] };
  },

  /** Conical woven hat. Elder read; the tallest simple cone in the cast. */
  coneHat(g) {
    const w = g.headW + 4, d = g.headD + 4;
    const vol = new VoxelVolume(w, 6, d);
    for (let y = 0; y < 6; y++) {
      const t = 1 - y / 5.4;
      discXZ(vol, y, (w - 1) / 2, (d - 1) / 2, Math.max(0.6, (w / 2) * t), Math.max(0.6, (d / 2) * t), M.HAT);
    }
    discXZ(vol, 1, (w - 1) / 2, (d - 1) / 2, (w / 2) * 0.82, (d / 2) * 0.82, M.HATALT);
    return { vol, off: [-2, g.headH - 1, -2] };
  },

  /** Rag turban with a jewelled pin. Raider read. */
  turban(g) {
    const w = g.headW + 2, d = g.headD + 2;
    const vol = new VoxelVolume(w, 4, d);
    for (let y = 0; y < 3; y++) {
      const r = y === 1 ? 0.4 : 0;
      discXZ(vol, y, (w - 1) / 2, (d - 1) / 2, w / 2 - r, d / 2 - r, y === 1 ? M.HATALT : M.HAT);
    }
    blob(vol, (w - 1) / 2, 3, (d - 1) / 2, g.headW / 2 - 0.6, 1.1, g.headD / 2 - 0.6, M.HAT);
    vol.set(w >> 1, 2, d - 1, M.METAL);
    return { vol, off: [-1, g.headH - 1, -1] };
  },
};

// ---------------------------------------------------------------------------
// Optional back / chin attachments. These hang past the body outline.
// ---------------------------------------------------------------------------

const EXTRA = {
  /** Officer's coat worn over the shoulders. Doubles the body's apparent mass from behind. */
  cape(g) {
    const w = g.torsoW + 4, len = g.torsoH + g.legH - 1, d = 2;
    const vol = new VoxelVolume(w, len, d);
    for (let y = 0; y < len; y++) {
      const inset = y > len - 3 ? 1 : 0;
      for (let x = inset; x < w - inset; x++) {
        // Ragged hem — a straight-cut cape reads as a wall.
        if (y === 0 && (x % 3) === 1) continue;
        vol.set(x, y, d - 1, M.TOPALT);
        if (y < len * 0.5) vol.set(x, y, d - 2, M.TOPALT);   // billow away from the legs
      }
    }
    vol.fillBox(1, len - 1, d - 1, w - 2, len - 1, d - 1, M.SASH);
    return {
      vol, attach: 'torso',
      pivotV: [0, g.headYv, -g.torsoD / 2],
      originV: [-w / 2, g.headYv - len, -g.torsoD / 2 - d],
    };
  },

  /** Beard hanging past the chin. Breaks the silhouette downward instead of upward. */
  beard(g) {
    const w = g.headW - 2, len = 5, d = 3;
    const vol = new VoxelVolume(w, len, d);
    for (let y = 0; y < len; y++) {
      const half = Math.max(1, Math.round((w / 2) * (0.45 + 0.55 * (y / (len - 1)))));
      for (let x = (w >> 1) - half; x <= (w >> 1) + half; x++) {
        vol.set(x, y, d - 1, M.HAIR);
        if (y > 1) vol.set(x, y, d - 2, M.HAIR);
      }
    }
    return {
      vol, attach: 'head',
      pivotV: [0, g.headYv + 1, g.headD / 2],
      originV: [-w / 2, g.headYv + 1 - len, g.headD / 2 - 2],
    };
  },

  /** Slung satchel. Small, but it stops a short character reading as a plain block. */
  backpack(g) {
    const w = g.torsoW, h = g.torsoH, d = 2;
    const vol = new VoxelVolume(w, h, d);
    vol.fillBox(0, 0, 0, w - 1, h - 1, d - 1, M.BOOT);
    vol.fillBox(0, h - 2, 0, w - 1, h - 2, d - 1, M.SASH);
    for (let x = 1; x < w; x += 2) vol.set(x, 0, d - 1, M.METAL);
    return {
      vol, attach: 'torso',
      pivotV: [0, g.legH + g.torsoH, -g.torsoD / 2],
      originV: [-w / 2, g.legH, -g.torsoD / 2 - d],
    };
  },

  /** Swept-back dorsal fin. The fishman read from every angle except dead-on front. */
  tailFin(g) {
    const w = 3, h = g.torsoH + 2, d = 4;
    const vol = new VoxelVolume(w, h, d);
    for (let y = 0; y < h; y++) {
      const reach = Math.max(1, Math.round(d * (1 - y / h)));
      for (let k = 0; k < reach; k++) {
        vol.set(1, y, d - 1 - k, M.ACCENT);
        if (y < 2) { vol.set(0, y, d - 1 - k, M.ACCENT); vol.set(2, y, d - 1 - k, M.ACCENT); }
      }
    }
    return {
      vol, attach: 'torso',
      pivotV: [0, g.legH + g.torsoH, -g.torsoD / 2],
      originV: [-w / 2, g.legH, -g.torsoD / 2 - d],
    };
  },
};

// ---------------------------------------------------------------------------
// Weapons. Volume is built blade-up; the pivot is the grip, which is what the hand holds.
// ---------------------------------------------------------------------------

const WEAPON = {
  katana() {
    const vol = new VoxelVolume(3, 14, 1);
    vol.fillBox(1, 0, 0, 1, 2, 0, M.GRIP);
    vol.fillBox(0, 3, 0, 2, 3, 0, M.METAL);
    for (let y = 4; y < 14; y++) vol.set(1, y, 0, M.METAL);
    return { vol, gripV: [1, 1, 0] };
  },
  cutlass() {
    const vol = new VoxelVolume(4, 10, 1);
    vol.fillBox(1, 0, 0, 1, 2, 0, M.GRIP);
    vol.fillBox(0, 3, 0, 2, 3, 0, M.METAL);
    for (let y = 4; y < 10; y++) vol.set(1 + Math.min(2, ((y - 4) / 3) | 0), y, 0, M.METAL);
    return { vol, gripV: [1, 1, 0] };
  },
  sabre() {
    const vol = new VoxelVolume(4, 13, 1);
    vol.fillBox(1, 0, 0, 1, 2, 0, M.GRIP);
    vol.fillBox(0, 3, 0, 2, 3, 0, M.METAL);
    vol.set(0, 2, 0, M.METAL); vol.set(0, 1, 0, M.METAL);   // knuckle bow
    for (let y = 4; y < 13; y++) vol.set(1 + Math.min(2, ((y - 4) / 4) | 0), y, 0, M.METAL);
    return { vol, gripV: [1, 1, 0] };
  },
  heavySabre() {
    const vol = new VoxelVolume(5, 16, 1);
    vol.fillBox(2, 0, 0, 2, 3, 0, M.GRIP);
    vol.fillBox(0, 4, 0, 4, 4, 0, M.METAL);
    for (let y = 5; y < 16; y++) {
      const x = 2 + Math.min(2, ((y - 5) / 5) | 0);
      vol.set(x, y, 0, M.METAL);
      if (y < 13) vol.set(x - 1, y, 0, M.METAL);
    }
    return { vol, gripV: [2, 2, 0] };
  },
  dagger() {
    const vol = new VoxelVolume(3, 7, 1);
    vol.fillBox(1, 0, 0, 1, 1, 0, M.GRIP);
    vol.fillBox(0, 2, 0, 2, 2, 0, M.METAL);
    for (let y = 3; y < 7; y++) vol.set(1, y, 0, M.METAL);
    return { vol, gripV: [1, 1, 0] };
  },
  club() {
    const vol = new VoxelVolume(4, 13, 4);
    vol.fillBox(1, 0, 1, 2, 4, 2, M.GRIP);
    vol.fillBox(0, 5, 0, 3, 12, 3, M.HAT);
    vol.fillBox(0, 7, 0, 0, 7, 0, M.METAL);
    vol.fillBox(3, 9, 3, 3, 9, 3, M.METAL);
    vol.fillBox(0, 11, 3, 0, 11, 3, M.METAL);
    return { vol, gripV: [1, 2, 1] };
  },
  trident() {
    const vol = new VoxelVolume(5, 18, 1);
    for (let y = 0; y < 13; y++) vol.set(2, y, 0, M.GRIP);
    vol.fillBox(0, 13, 0, 4, 13, 0, M.METAL);
    for (let y = 14; y < 18; y++) { vol.set(0, y, 0, M.METAL); vol.set(2, y, 0, M.METAL); vol.set(4, y, 0, M.METAL); }
    return { vol, gripV: [2, 4, 0] };
  },
  axe() {
    const vol = new VoxelVolume(5, 12, 1);
    for (let y = 0; y < 12; y++) vol.set(1, y, 0, M.GRIP);
    vol.fillBox(0, 8, 0, 4, 11, 0, M.METAL);
    vol.set(4, 8, 0, 0); vol.set(4, 11, 0, 0);
    vol.fillBox(1, 9, 0, 1, 10, 0, M.GRIP);
    return { vol, gripV: [1, 3, 0] };
  },
  staff() {
    const vol = new VoxelVolume(3, 15, 3);
    for (let y = 0; y < 13; y++) vol.set(1, y, 1, M.GRIP);
    blob(vol, 1, 13, 1, 1.4, 1.4, 1.4, M.ACCENT);
    return { vol, gripV: [1, 4, 1] };
  },
  slingshot() {
    const vol = new VoxelVolume(5, 9, 1);
    for (let y = 0; y < 5; y++) vol.set(2, y, 0, M.GRIP);
    for (let k = 0; k < 4; k++) { vol.set(2 - Math.min(2, k), 5 + k, 0, M.GRIP); vol.set(2 + Math.min(2, k), 5 + k, 0, M.GRIP); }
    vol.fillBox(0, 8, 0, 4, 8, 0, M.ACCENT);
    return { vol, gripV: [2, 2, 0] };
  },
  cane() {
    const vol = new VoxelVolume(4, 12, 1);
    for (let y = 0; y < 10; y++) vol.set(1, y, 0, M.GRIP);
    vol.fillBox(1, 10, 0, 3, 10, 0, M.GRIP);
    vol.set(3, 11, 0, M.ACCENT);
    return { vol, gripV: [1, 8, 0] };
  },
  hammer() {
    const vol = new VoxelVolume(5, 14, 3);
    for (let y = 0; y < 10; y++) vol.set(2, y, 1, M.GRIP);
    vol.fillBox(0, 10, 0, 4, 13, 2, M.METAL);
    vol.fillBox(1, 11, 1, 3, 12, 1, M.HATALT);
    return { vol, gripV: [2, 3, 1] };
  },
  musket() {
    const vol = new VoxelVolume(2, 16, 2);
    for (let y = 3; y < 16; y++) vol.set(1, y, 0, M.METAL);
    vol.fillBox(0, 0, 0, 1, 4, 0, M.GRIP);
    vol.fillBox(0, 4, 0, 0, 8, 0, M.GRIP);
    vol.set(0, 5, 1, M.METAL);
    return { vol, gripV: [1, 4, 0] };
  },
  fiddle() {
    const vol = new VoxelVolume(4, 12, 2);
    blob(vol, 1.5, 2.5, 0.5, 2.0, 2.6, 1.0, M.GRIP);
    blob(vol, 1.5, 6.0, 0.5, 1.6, 2.2, 0.9, M.GRIP);
    for (let y = 8; y < 12; y++) vol.set(1, y, 0, M.HAT);
    vol.set(2, 11, 0, M.HAT);
    for (let y = 1; y < 8; y++) vol.set(2, y, 1, M.ACCENT);
    return { vol, gripV: [1, 1, 0] };
  },
};

// ---------------------------------------------------------------------------
// Layout: pure geometry, no textures, no GL. Everything else is built on top of this.
// ---------------------------------------------------------------------------

function buildTorso(g, spec, rng) {
  const c = spec.cloth;
  const pads = spec.build.epaulettes ? 1 : 0;
  const w = g.torsoW + pads * 2;
  const vol = new VoxelVolume(w, g.torsoH, g.torsoD);
  vol.fillBox(pads, 0, 0, pads + g.torsoW - 1, g.torsoH - 1, g.torsoD - 1, M.TOP);

  // Waistband / sash: one bold horizontal band. Chibi bodies need a waist or they read as a box.
  if (c.sashRow !== false) vol.fillBox(pads, 0, 0, pads + g.torsoW - 1, 0, g.torsoD - 1, M.SASH);

  if (c.collar) vol.fillBox(pads, g.torsoH - 1, 0, pads + g.torsoW - 1, g.torsoH - 1, g.torsoD - 1, M.TOPALT);

  // Open vest / bare chest: the front-centre columns show skin. Reads instantly at distance.
  if (c.openFront) {
    const x0 = pads + 1, x1 = pads + g.torsoW - 2;
    for (let x = x0; x <= x1; x++) {
      for (let y = 1; y < g.torsoH; y++) vol.set(x, y, g.torsoD - 1, M.SKIN);
    }
    vol.set(pads + 1, g.torsoH - 1, g.torsoD - 1, M.TOP);
    vol.set(pads + g.torsoW - 2, g.torsoH - 1, g.torsoD - 1, M.TOP);
  }

  if (c.buttons) {
    const cx = pads + (g.torsoW >> 1);
    for (let y = 1; y < g.torsoH; y += 2) vol.set(cx, y, g.torsoD - 1, M.METAL);
  }

  if (pads) {
    for (let z = 0; z < g.torsoD; z++) {
      vol.set(0, g.torsoH - 1, z, M.HATALT);
      vol.set(w - 1, g.torsoH - 1, z, M.HATALT);
    }
  }

  // Wear: a couple of deterministic patches so no two archetypes tile identically.
  if (c.worn) {
    for (let i = 0; i < 3; i++) {
      vol.set(pads + rng.int(0, g.torsoW - 1), rng.int(1, g.torsoH - 1), g.torsoD - 1, M.TOPALT);
    }
  }

  return {
    vol,
    originV: [-w / 2, g.legH, -g.torsoD / 2],
    pivotV: [0, g.legH, 0],
  };
}

function buildHead(g, spec, rng) {
  const vol = new VoxelVolume(g.headW, g.headH, g.headD);
  vol.fillBox(0, 0, 0, g.headW - 1, g.headH - 1, g.headD - 1, M.SKIN);

  // Hair lives inside the head box. Nothing here may touch the front plane below FACE_ROWS,
  // or it would fight the face tiles that get stamped onto exactly those quads.
  const style = spec.hair.style;
  const capTop = g.headH - 1, capLow = g.headH - 2;
  const backOnly = g.headD - 1;
  if (style !== 'bald') {
    for (let y = (style === 'buzz' ? capTop : capLow); y <= capTop; y++) {
      vol.fillBox(0, y, 0, g.headW - 1, y, g.headD - 1, M.HAIR);
    }
    for (let y = 1; y <= capTop; y++) vol.fillBox(0, y, 0, g.headW - 1, y, 0, M.HAIR);
    // Temple wrap: one row of hair down each side, kept off the face plane.
    for (let z = 0; z < backOnly; z++) {
      vol.set(0, capLow - 1, z, M.HAIR);
      vol.set(g.headW - 1, capLow - 1, z, M.HAIR);
    }
  }
  if (style === 'long') {
    for (let y = 0; y <= capTop; y++) {
      for (let z = 0; z < backOnly; z++) { vol.set(0, y, z, M.HAIR); vol.set(g.headW - 1, y, z, M.HAIR); }
    }
  }
  if (style === 'swept') {
    // Fringe: alternating voxels along the hairline so the front edge is not a ruled line.
    for (let x = 0; x < g.headW; x++) vol.set(x, capLow, g.headD - 1, x % 2 === 0 ? M.HAIR : M.SKIN);
  }
  if (style === 'curly') {
    // Carve the crown corners instead of adding volume — a ragged outline costs nothing.
    for (let i = 0; i < 5; i++) {
      const x = rng.chance(0.5) ? 0 : g.headW - 1;
      const z = rng.int(0, g.headD - 1);
      vol.set(x, capTop, z, 0);
    }
  }

  return {
    vol,
    originV: [-g.headW / 2, g.headYv, -g.headD / 2],
    pivotV: [0, g.headYv, 0],
    faceX0: (g.headW - g.faceCols) >> 1,
  };
}

function buildArm(g, spec, side) {
  const c = spec.cloth;
  const vol = new VoxelVolume(g.armW, g.armLen, g.armD);
  const sleeve = c.sleeve || 'short';
  vol.fillBox(0, 0, 0, g.armW - 1, g.armLen - 1, g.armD - 1, sleeve === 'none' ? M.SKIN : M.TOP);
  if (sleeve === 'short') {
    vol.fillBox(0, 0, 0, g.armW - 1, g.armLen - 3, g.armD - 1, M.SKIN);
  } else if (sleeve === 'long') {
    vol.fillBox(0, 0, 0, g.armW - 1, 0, g.armD - 1, M.SKIN);
  } else if (sleeve === 'glove') {
    vol.fillBox(0, 0, 0, g.armW - 1, 1, g.armD - 1, M.BOOT);
  }
  if (c.cuff) vol.fillBox(0, 1, 0, g.armW - 1, 1, g.armD - 1, M.TOPALT);
  const x = side * g.armOffX;
  return {
    vol,
    originV: [x - g.armW / 2, g.shoulderYv - g.armLen, -g.armD / 2],
    pivotV: [x, g.shoulderYv, 0],
    handV: [x, g.shoulderYv - g.armLen, 0],
  };
}

function buildLeg(g, spec, side) {
  const vol = new VoxelVolume(g.legW, g.legH, g.legD);
  vol.fillBox(0, 0, 0, g.legW - 1, g.legH - 1, g.legD - 1, M.PANTS);
  vol.fillBox(0, 0, 0, g.legW - 1, g.bootH - 1, g.legD - 1, M.BOOT);
  if (spec.cloth.cuff) vol.fillBox(0, g.bootH, 0, g.legW - 1, g.bootH, g.legD - 1, M.TOPALT);
  const x = side * g.legOffX;
  return {
    vol,
    originV: [x - g.legW / 2, 0, -g.legD / 2],
    pivotV: [x, g.legH, 0],
  };
}

/**
 * Full symbolic layout of one archetype. Pure function of the spec — no textures, no THREE.
 * @param {object} spec
 * @returns {object} { g, parts, metrics }
 */
export function layoutCharacter(spec) {
  const g = geometryOf(spec);
  const rng = Rng.fromName(hashString(spec.id), 'charlayout');
  const parts = {};

  parts.torso = buildTorso(g, spec, rng);
  const head = buildHead(g, spec, rng);
  parts.head = head;
  parts.armL = buildArm(g, spec, +1);
  parts.armR = buildArm(g, spec, -1);
  parts.legL = buildLeg(g, spec, +1);
  parts.legR = buildLeg(g, spec, -1);

  const ident = IDENT[spec.ident.kind](g, spec, rng);
  parts.hat = {
    vol: ident.vol,
    originV: [head.originV[0] + ident.off[0], head.originV[1] + ident.off[1], head.originV[2] + ident.off[2]],
    pivotV: head.pivotV.slice(),
  };

  if (spec.extra && EXTRA[spec.extra]) parts.extra = EXTRA[spec.extra](g, spec, rng);

  if (spec.weapon) {
    const w = WEAPON[spec.weapon.kind]();
    const hand = parts.armR.handV;
    parts.weapon = {
      vol: w.vol,
      originV: [hand[0] - w.gripV[0] - 0.5, hand[1] - w.gripV[1], hand[2] - w.gripV[2] - 0.5],
      pivotV: [hand[0], hand[1], hand[2]],
    };
  }

  const metrics = {
    height: g.h * S,
    hipY: g.legH * S,
    shoulderY: g.shoulderYv * S,
    headY: g.headYv * S,
    handL: parts.armL.handV.map((v) => v * S),
    handR: parts.armR.handV.map((v) => v * S),
    headHeight: g.headH * S,
    headRatio: g.headH / g.h,
    headWidthRatio: g.headW / g.torsoW,
  };

  return { g, parts, metrics, faceX0: head.faceX0 };
}

// ---------------------------------------------------------------------------
// Build: layout + textures + meshes
// ---------------------------------------------------------------------------

/** Define (or reuse) the block ids this archetype's materials need on the shared registry. */
function charBlocks(reg, spec, tiles) {
  const ids = {};
  for (const code of Object.keys(M_NAMES)) {
    const part = M_NAMES[code];
    ids[code] = reg.define(`char:${spec.id}:${part}`, tiles[part]);
  }
  return ids;
}

/** Copy a symbolic volume into a block-id volume. */
function realise(src, ids) {
  const out = new VoxelVolume(src.sx, src.sy, src.sz);
  for (let i = 0; i < src.data.length; i++) {
    const v = src.data[i];
    if (v) out.data[i] = ids[v];
  }
  return out;
}

/**
 * Per-instance wear. Two marines standing side by side must not be pixel twins, but the
 * silhouette has to stay identical or the distinctness matrix stops meaning anything — so
 * wear only ever *recolours* an already-solid voxel, never adds or removes one.
 */
function applyWear(volume, ids, rng, count) {
  const swap = [ids[M.TOPALT], ids[M.SASH], ids[M.BOOT]];
  for (let i = 0; i < count; i++) {
    const x = rng.int(0, volume.sx - 1), y = rng.int(0, volume.sy - 1), z = rng.int(0, volume.sz - 1);
    if (volume.get(x, y, z) === 0) continue;
    volume.set(x, y, z, swap[rng.u32() % swap.length]);
  }
}

/**
 * Build one character: textures, blocks, volumes and meshed geometry per part.
 *
 * Geometry for every part is emitted **relative to that part's pivot**, so the rig sets
 * `mesh.position = pivot` (plus animation offset) and rotates about the mesh origin. `origin`
 * is also returned — it is the bind-pose world offset of the volume's min corner, which is
 * what collision and shadow-proxy code wants.
 *
 * @param {import('./texture.js').TextureLibrary} tex
 * @param {import('./voxel.js').BlockRegistry} reg
 * @param {object} spec entry from CHARACTER_SPECS
 * @param {number} seed world seed; drives per-instance deterministic detail
 */
export function buildCharacter(tex, reg, spec, seed = 1) {
  const tiles = registerCharacterTiles(tex, spec);
  const layout = layoutCharacter(spec);
  const ids = charBlocks(reg, spec, tiles);
  const g = layout.g;
  const rng = Rng.fromName(seed >>> 0, 'char:' + spec.id);

  // Face tiles ride on the +Z faces of the head's lower rows. Distinct layer indices never
  // greedy-merge with each other, so every cell keeps its own 1x1 quad and its own uv 0..1.
  const faceOverride = new Map();
  const z = g.headD - 1;
  for (let r = 0; r < g.faceRows; r++) {
    for (let c = 0; c < g.faceCols; c++) {
      faceOverride.set(`${layout.faceX0 + c},${r},${z},south`, tiles.face[r][c]);
    }
  }

  const parts = {};
  for (const key of Object.keys(layout.parts)) {
    const pl = layout.parts[key];
    const origin = [pl.originV[0] * S, pl.originV[1] * S, pl.originV[2] * S];
    const pivot = [pl.pivotV[0] * S, pl.pivotV[1] * S, pl.pivotV[2] * S];
    const volume = realise(pl.vol, ids);
    if (key === 'torso' || key === 'legL' || key === 'legR') applyWear(volume, ids, rng, 2);
    const geometry = meshVolume(volume, reg, {
      scale: S,
      origin: [origin[0] - pivot[0], origin[1] - pivot[1], origin[2] - pivot[2]],
      ao: true,
      faceOverride: key === 'head' ? faceOverride : null,
    });
    geometry.name = `char:${spec.id}:${key}`;
    parts[key] = {
      name: key, volume, origin, pivot, geometry,
      voxels: volume.count(),
      attach: pl.attach || (key === 'hat' ? 'head' : key === 'weapon' ? 'handR' : 'root'),
    };
  }

  return {
    id: spec.id,
    spec,
    seed: seed >>> 0,
    parts,
    tiles,
    voxelSize: S,
    bindPose: spec.pose,
    height: layout.metrics.height,
    hipY: layout.metrics.hipY,
    shoulderY: layout.metrics.shoulderY,
    headY: layout.metrics.headY,
    handL: layout.metrics.handL,
    handR: layout.metrics.handR,
    metrics: layout.metrics,
  };
}

// ---------------------------------------------------------------------------
// Silhouette tests. ART_BAR §1: a black cutout must still name the character.
// ---------------------------------------------------------------------------

/** Canonical silhouette raster: 1 cell = 1 character voxel, feet on row 0, centred on x = 0. */
export const SIL_W = 34;
export const SIL_H = 30;

function rot(v, pitch, roll) {
  // Rz(roll) * Rx(pitch), applied to a pivot-relative offset.
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const y1 = v[1] * cp - v[2] * sp;
  const z1 = v[1] * sp + v[2] * cp;
  const cr = Math.cos(roll), sr = Math.sin(roll);
  return [v[0] * cr - y1 * sr, v[0] * sr + y1 * cr, z1];
}

/**
 * Front (looking down -Z) occupancy of one archetype in its authored bind pose.
 * @param {object} spec entry from CHARACTER_SPECS
 * @returns {{w:number, h:number, data:Uint8Array, rows:boolean[][], filled:number}}
 */
export function buildSilhouetteTest(spec) {
  const layout = layoutCharacter(spec);
  const pose = spec.pose || {};
  const data = new Uint8Array(SIL_W * SIL_H);
  const cx = SIL_W / 2;

  for (const key of Object.keys(layout.parts)) {
    const pl = layout.parts[key];
    // The weapon rides the right arm — same rotation, same shoulder pivot, or it would swing
    // about a hand that has already moved.
    let p = pose[key] || null;
    let piv = pl.pivotV;
    if (key === 'weapon') { p = pose.armR; piv = layout.parts.armR.pivotV; }
    if ((key === 'head' || key === 'hat') && pose.headTilt) p = [0, pose.headTilt];
    const lean = pose.lean || 0;
    const pitch = p ? p[0] : 0;
    const roll = p ? p[1] : 0;

    for (let y = 0; y < pl.vol.sy; y++) {
      for (let zz = 0; zz < pl.vol.sz; zz++) {
        for (let x = 0; x < pl.vol.sx; x++) {
          if (!pl.vol.get(x, y, zz)) continue;
          const wx = pl.originV[0] + x + 0.5;
          const wy = pl.originV[1] + y + 0.5;
          const wz = pl.originV[2] + zz + 0.5;
          let o = [wx - piv[0], wy - piv[1], wz - piv[2]];
          if (pitch || roll) o = rot(o, pitch, roll);
          // Whole-body lean about the hips: what makes the stance diagonal, per ART_BAR §1.
          let px = piv[0] + o[0], py = piv[1] + o[1];
          if (lean) {
            const dy = py - layout.g.legH;
            px += dy * Math.sin(lean);
            py = layout.g.legH + dy * Math.cos(lean);
          }
          const col = Math.floor(px + cx);
          const row = Math.floor(py);
          if (col >= 0 && col < SIL_W && row >= 0 && row < SIL_H) data[row * SIL_W + col] = 1;
        }
      }
    }
  }

  const rows = [];
  let filled = 0;
  for (let r = 0; r < SIL_H; r++) {
    const line = new Array(SIL_W);
    for (let c = 0; c < SIL_W; c++) {
      const v = data[r * SIL_W + c] === 1;
      line[c] = v;
      if (v) filled++;
    }
    rows.push(line);
  }
  return { w: SIL_W, h: SIL_H, data, rows, filled };
}

const SIL_MEMO = new Map();
function silOf(spec) {
  let s = SIL_MEMO.get(spec.id);
  if (!s) { s = buildSilhouetteTest(spec); SIL_MEMO.set(spec.id, s); }
  return s;
}

/**
 * How different two archetypes look as flat black cutouts. Jaccard distance of the front
 * projections: 0 = the same shape, 1 = no shared cell. Two archetypes below ~0.20 will be
 * mistaken for each other in play.
 * @returns {number} 0..1
 */
export function silhouetteDistinctness(specA, specB) {
  if (specA === specB || specA.id === specB.id) return 0;
  const a = silOf(specA).data, b = silOf(specB).data;
  let inter = 0, union = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x | y) union++;
    if (x & y) inter++;
  }
  return union === 0 ? 0 : 1 - inter / union;
}

// ---------------------------------------------------------------------------
// The cast
// ---------------------------------------------------------------------------

// Shorthand so the table below stays readable.
const skinTan = P.skinTan;
const cloth = (o) => Object.assign({
  top: P.heroRed, topAlt: P.heroRedDark, sash: P.heroGold, pants: P.heroCyan,
  boot: P.woodDark, accent: P.uiWhite, metal: P.metal, grip: P.woodDark,
  sleeve: 'short',
}, o);

/**
 * The authored cast. Every entry carries: build proportions, skin, hair style + colour, an
 * identity element that breaks the head silhouette, clothing pulled from the palette, a face
 * spec for paintFace, an optional weapon, and an authored asymmetric bind pose.
 * @type {Record<string, object>}
 */
export const CHARACTER_SPECS = {
  hero_captain: {
    id: 'hero_captain', name: 'Straw-Hat Captain', faction: 'crew',
    build: { h: 17, torsoW: 4 },
    skin: P.skin,
    hair: { color: P.hair, style: 'short' },
    ident: { kind: 'strawHat', color: P.strawHat, alt: P.hatBand, straw: true },
    cloth: cloth({ top: P.heroRed, topAlt: P.heroRedDark, pants: P.heroCyan, sash: P.heroGold, sleeve: 'none', openFront: true, boot: P.rope }),
    face: { eye: 'open', mouth: 'grin', scar: 'cheek', brow: 'none' },
    weapon: null,
    pose: { armL: [-0.25, 0.55], armR: [0.20, -1.15], legL: [0.10, 0.16], legR: [-0.12, -0.10], lean: 0.06, headTilt: 0.10 },
  },

  crew_swordsman: {
    id: 'crew_swordsman', name: 'Three-Blade Swordsman', faction: 'crew',
    build: { h: 18, torsoW: 5, armW: 3 },
    skin: skinTan,
    hair: { color: P.hairGreen, style: 'short' },
    ident: { kind: 'bandana', color: P.hairGreen, alt: P.hair },
    cloth: cloth({ top: P.hairGreen, topAlt: P.jungleDark, pants: P.pirateBlack, sash: P.heroGold, sleeve: 'none', openFront: true, boot: P.pirateBlack }),
    face: { eye: 'angry', mouth: 'flat', scar: 'eye', brow: 'angry' },
    weapon: { kind: 'katana' },
    pose: { armL: [-0.10, 0.30], armR: [-0.55, -0.35], legL: [0.05, 0.22], legR: [-0.05, -0.22], lean: -0.05, headTilt: -0.06 },
  },

  crew_navigator: {
    id: 'crew_navigator', name: 'Chart-Reader', faction: 'crew',
    build: { h: 15, torsoW: 3 },
    skin: P.skinPale,
    hair: { color: P.hairGinger, style: 'long' },
    ident: { kind: 'sunHat', color: P.thatch, alt: P.heroCyan, straw: true },
    cloth: cloth({ top: P.heroCyan, topAlt: P.heroCyanLight, pants: P.marineWhite, sash: P.heroGold, sleeve: 'short', boot: P.plankDark }),
    face: { eye: 'sly', mouth: 'smile', scar: 'none', blush: true },
    weapon: { kind: 'staff' },
    pose: { armL: [-0.40, 0.85], armR: [0.10, -0.22], legL: [0.06, 0.10], legR: [-0.06, -0.14], lean: 0.09, headTilt: 0.12 },
  },

  crew_cook: {
    id: 'crew_cook', name: 'Sea Cook', faction: 'crew',
    build: { h: 17, torsoW: 4 },
    skin: P.skin,
    hair: { color: P.hairBlonde, style: 'swept' },
    ident: { kind: 'chefHat', color: P.marineWhite, alt: P.pirateBlack },
    cloth: cloth({ top: P.pirateBlack, topAlt: P.uiWhite, pants: P.pirateBlack, sash: P.marineWhite, sleeve: 'long', collar: true, buttons: true, boot: P.pirateBlack, cuff: true }),
    face: { eye: 'sly', mouth: 'smile', scar: 'none', brow: 'angry' },
    weapon: null,
    pose: { armL: [-0.15, 0.28], armR: [-0.30, -0.30], legL: [-0.30, 0.08], legR: [0.35, -0.05], lean: 0.04, headTilt: -0.08 },
  },

  crew_sniper: {
    id: 'crew_sniper', name: 'Long-Shot Gunner', faction: 'crew',
    build: { h: 17, torsoW: 3 },
    skin: skinTan,
    hair: { color: P.hairBrown, style: 'curly' },
    ident: { kind: 'longNose', color: P.bandit, alt: P.woodDark },
    cloth: cloth({ top: P.bandit, topAlt: P.woodDark, pants: P.bandit, sash: P.heroRed, sleeve: 'long', worn: true, boot: P.woodDark }),
    face: { eye: 'shock', mouth: 'open', scar: 'none', brow: 'sad' },
    weapon: { kind: 'slingshot' },
    pose: { armL: [-0.80, 0.95], armR: [-0.65, -0.75], legL: [0.18, 0.14], legR: [-0.20, -0.08], lean: -0.10, headTilt: 0.05 },
  },

  crew_shipwright: {
    id: 'crew_shipwright', name: 'Hull-Wright', faction: 'crew',
    build: { h: 18, torsoW: 6, armW: 3, longArms: true },
    skin: skinTan,
    hair: { color: P.heroCyanLight, style: 'buzz' },
    ident: { kind: 'pompadour', color: P.heroCyanLight, alt: P.heroCyan },
    cloth: cloth({ top: P.heroCyan, topAlt: P.marineWhite, pants: P.marineBlue, sash: P.heroGold, sleeve: 'none', openFront: true, boot: P.metalDark }),
    face: { eye: 'happy', mouth: 'grin', scar: 'none' },
    weapon: { kind: 'hammer' },
    pose: { armL: [-0.35, 1.05], armR: [-0.20, -0.95], legL: [0.05, 0.26], legR: [-0.05, -0.26], lean: 0.03, headTilt: -0.05 },
  },

  crew_doctor: {
    id: 'crew_doctor', name: 'Ship Doctor', faction: 'crew',
    build: { h: 15, torsoW: 3, bootH: 1 },
    skin: P.skinPale,
    hair: { color: P.hairBrown, style: 'short' },
    ident: { kind: 'doctorCap', color: P.mushroomCap, alt: P.hairBrown },
    cloth: cloth({ top: P.mushroomCap, topAlt: P.uiWhite, pants: P.uiWhite, sash: P.heroRed, sleeve: 'long', boot: P.hairBrown, cuff: true }),
    face: { eye: 'happy', mouth: 'smile', blush: true },
    weapon: null,
    extra: 'backpack',
    pose: { armL: [-0.55, 0.65], armR: [-0.55, -0.65], legL: [0.14, 0.10], legR: [-0.14, -0.10], lean: 0.02, headTilt: 0.14 },
  },

  crew_musician: {
    id: 'crew_musician', name: 'Deck Fiddler', faction: 'crew',
    build: { h: 18, torsoW: 3, longArms: true, bootH: 3 },
    skin: P.skinPale,
    hair: { color: P.hair, style: 'bald' },
    ident: { kind: 'afroTopHat', color: P.pirateBlack, alt: P.royalPurple },
    cloth: cloth({ top: P.royalPurple, topAlt: P.heroGold, pants: P.pirateBlack, sash: P.heroGold, sleeve: 'long', collar: true, buttons: true, boot: P.pirateBlack }),
    face: { eye: 'happy', mouth: 'grin', scar: 'none' },
    weapon: { kind: 'fiddle' },
    pose: { armL: [-0.95, 0.50], armR: [-1.10, -0.40], legL: [0.30, 0.08], legR: [-0.34, -0.06], lean: 0.11, headTilt: -0.16 },
  },

  marine_recruit: {
    id: 'marine_recruit', name: 'Marine Recruit', faction: 'marine',
    build: { h: 15, torsoW: 4 },
    skin: P.skin,
    hair: { color: P.hairBrown, style: 'buzz' },
    ident: { kind: 'marineCap', color: P.marineWhite, alt: P.marineNavy, rank: 0 },
    cloth: cloth({ top: P.marineWhite, topAlt: P.marineBlue, pants: P.marineBlue, sash: P.marineNavy, sleeve: 'long', collar: true, boot: P.pirateBlack }),
    face: { eye: 'open', mouth: 'flat', brow: 'sad' },
    weapon: { kind: 'musket' },
    pose: { armL: [-0.05, 0.16], armR: [-0.35, -0.28], legL: [0.04, 0.08], legR: [-0.04, -0.08], lean: -0.02, headTilt: 0.04 },
  },

  marine_officer: {
    id: 'marine_officer', name: 'Marine Officer', faction: 'marine',
    build: { h: 17, torsoW: 5, epaulettes: true },
    skin: skinTan,
    hair: { color: P.hair, style: 'short' },
    ident: { kind: 'marineCap', color: P.marineWhite, alt: P.marineNavy, rank: 1 },
    cloth: cloth({ top: P.marineBlue, topAlt: P.heroGold, pants: P.marineNavy, sash: P.marineWhite, sleeve: 'long', collar: true, buttons: true, boot: P.pirateBlack }),
    face: { eye: 'angry', mouth: 'flat', brow: 'angry' },
    weapon: { kind: 'sabre' },
    pose: { armL: [-0.20, 0.24], armR: [-0.75, -0.45], legL: [0.06, 0.12], legR: [-0.06, -0.12], lean: -0.06, headTilt: -0.05 },
  },

  marine_captain: {
    id: 'marine_captain', name: 'Marine Captain', faction: 'marine',
    build: { h: 18, torsoW: 6, armW: 3, epaulettes: true },
    skin: skinTan,
    hair: { color: P.hairWhite, style: 'short' },
    ident: { kind: 'marineCap', color: P.marineWhite, alt: P.heroGold, rank: 2 },
    cloth: cloth({ top: P.marineNavy, topAlt: P.heroGold, pants: P.marineNavy, sash: P.heroGold, sleeve: 'long', collar: true, buttons: true, boot: P.pirateBlack }),
    face: { eye: 'angry', mouth: 'snarl', scar: 'cross', brow: 'angry' },
    weapon: { kind: 'heavySabre' },
    extra: 'cape',
    pose: { armL: [-0.28, 0.34], armR: [-0.95, -0.55], legL: [0.08, 0.20], legR: [-0.08, -0.20], lean: -0.08, headTilt: -0.04 },
  },

  pirate_thug: {
    id: 'pirate_thug', name: 'Deckhand Thug', faction: 'pirate',
    build: { h: 15, torsoW: 4 },
    skin: skinTan,
    hair: { color: P.hair, style: 'short' },
    ident: { kind: 'headscarf', color: P.pirateMaroon, alt: P.pirateBlack },
    cloth: cloth({ top: P.marineWhite, topAlt: P.pirateMaroon, stripe: P.pirateMaroon, pants: P.woodDark, sash: P.heroRed, sleeve: 'short', worn: true, boot: P.woodDark }),
    face: { eye: 'angry', mouth: 'snarl', brow: 'angry' },
    weapon: { kind: 'cutlass' },
    pose: { armL: [-0.30, 0.42], armR: [-0.45, -0.60], legL: [0.16, 0.14], legR: [-0.18, -0.06], lean: 0.10, headTilt: 0.08 },
  },

  pirate_brute: {
    id: 'pirate_brute', name: 'Anchor Brute', faction: 'pirate',
    build: { h: 18, torsoW: 6, armW: 3, longArms: true, bootH: 3 },
    skin: P.skinDark,
    hair: { color: P.hair, style: 'bald' },
    ident: { kind: 'hornedHelm', color: P.metalDark, alt: P.bandit },
    cloth: cloth({ top: P.pirateBlack, topAlt: P.bruiserOrange, pants: P.bandit, sash: P.bruiserOrange, sleeve: 'none', openFront: true, boot: P.woodDark, metal: P.metalDark }),
    face: { eye: 'angry', mouth: 'snarl', scar: 'cross', brow: 'angry' },
    weapon: { kind: 'club' },
    pose: { armL: [-0.20, 1.10], armR: [-0.30, -1.00], legL: [0.06, 0.30], legR: [-0.06, -0.30], lean: -0.12, headTilt: 0.06 },
  },

  pirate_knifer: {
    id: 'pirate_knifer', name: 'Alley Knifer', faction: 'pirate',
    build: { h: 15, torsoW: 3, bootH: 1 },
    skin: P.skinPale,
    hair: { color: P.hair, style: 'bald' },
    ident: { kind: 'hood', color: P.pirateBlack, alt: P.assassinViolet },
    cloth: cloth({ top: P.pirateBlack, topAlt: P.assassinViolet, pants: P.pirateBlack, sash: P.assassinViolet, sleeve: 'glove', boot: P.pirateBlack }),
    face: { eye: 'sly', mouth: 'flat', brow: 'angry' },
    weapon: { kind: 'dagger' },
    pose: { armL: [-1.05, 0.35], armR: [-0.95, -0.30], legL: [0.34, 0.10], legR: [-0.30, -0.10], lean: 0.24, headTilt: 0.18 },
  },

  fishman_raider: {
    id: 'fishman_raider', name: 'Fishman Raider', faction: 'pirate',
    build: { h: 18, torsoW: 5, armW: 3 },
    skin: P.fishmanTeal,
    hair: { color: P.fishmanDeep, style: 'bald' },
    ident: { kind: 'finCrest', color: P.fishmanDeep, alt: P.coral },
    cloth: cloth({ top: P.fishmanDeep, topAlt: P.coral, pants: P.pirateMaroon, sash: P.heroGold, sleeve: 'none', openFront: true, boot: P.fishmanDeep, accent: P.fishmanDeep }),
    face: { eye: 'angry', mouth: 'snarl', eyeColor: P.fishmanDeep, brow: 'angry' },
    weapon: { kind: 'trident' },
    extra: 'tailFin',
    pose: { armL: [-0.45, 0.75], armR: [-0.85, -0.50], legL: [0.10, 0.24], legR: [-0.10, -0.24], lean: -0.14, headTilt: -0.10 },
  },

  bandit_boss: {
    id: 'bandit_boss', name: 'Bandit Boss', faction: 'bandit',
    build: { h: 17, torsoW: 6, armW: 3 },
    skin: P.skinDark,
    hair: { color: P.hairBrown, style: 'long' },
    ident: { kind: 'tricorn', color: P.bandit, alt: P.heroGold },
    cloth: cloth({ top: P.bandit, topAlt: P.heroGold, pants: P.woodDark, sash: P.pirateMaroon, sleeve: 'long', collar: true, worn: true, boot: P.woodDark }),
    face: { eye: 'sly', mouth: 'grin', scar: 'cheek', brow: 'angry' },
    weapon: { kind: 'axe' },
    extra: 'cape',
    pose: { armL: [-0.22, 0.55], armR: [-0.60, -0.85], legL: [0.08, 0.26], legR: [-0.08, -0.22], lean: -0.09, headTilt: -0.07 },
  },

  villager_a: {
    id: 'villager_a', name: 'Island Fisher', faction: 'villager',
    build: { h: 15, torsoW: 4, bootH: 1 },
    skin: skinTan,
    hair: { color: P.hairBrown, style: 'short' },
    ident: { kind: 'coneHat', color: P.thatch, alt: P.woodDark, straw: true },
    cloth: cloth({ top: P.grassCold, topAlt: P.jungleDark, pants: P.woodDark, sash: P.rope, sleeve: 'short', worn: true, boot: P.woodDark }),
    face: { eye: 'open', mouth: 'smile' },
    // The pole is shouldered, not carried at the side — it is the whole reason this villager
    // does not read as a marine recruit from thirty metres.
    weapon: { kind: 'staff' },
    pose: { armL: [-0.14, 0.22], armR: [-0.45, -1.42], legL: [0.10, 0.08], legR: [-0.08, -0.08], lean: 0.14, headTilt: 0.10 },
  },

  villager_b: {
    id: 'villager_b', name: 'Market Girl', faction: 'villager',
    build: { h: 15, torsoW: 3 },
    skin: P.skin,
    hair: { color: P.hairBrown, style: 'long' },
    ident: { kind: 'headscarf', color: P.heroCyanLight, alt: P.uiWhite },
    cloth: cloth({ top: P.mushroomCap, topAlt: P.uiWhite, pants: P.uiPaperDark, sash: P.uiWhite, sleeve: 'short', boot: P.plankDark }),
    face: { eye: 'happy', mouth: 'smile', blush: true },
    weapon: null,
    pose: { armL: [-0.30, 0.60], armR: [-0.10, -0.18], legL: [0.08, 0.10], legR: [-0.08, -0.10], lean: 0.07, headTilt: 0.16 },
  },

  merchant: {
    id: 'merchant', name: 'Port Merchant', faction: 'villager',
    build: { h: 15, torsoW: 5, bootH: 1 },
    skin: P.skin,
    hair: { color: P.hairWhite, style: 'short' },
    ident: { kind: 'bowler', color: P.woodDark, alt: P.heroGold },
    cloth: cloth({ top: P.royalPurple, topAlt: P.heroGold, pants: P.woodDark, sash: P.heroGold, sleeve: 'long', collar: true, buttons: true, boot: P.pirateBlack }),
    face: { eye: 'sly', mouth: 'grin' },
    weapon: null,
    pose: { armL: [-0.45, 0.40], armR: [-0.40, -0.44], legL: [0.05, 0.12], legR: [-0.05, -0.12], lean: -0.04, headTilt: -0.10 },
  },

  elder: {
    id: 'elder', name: 'Village Elder', faction: 'villager',
    build: { h: 15, torsoW: 3, bootH: 1 },
    skin: P.skinTan,
    hair: { color: P.hairWhite, style: 'long' },
    ident: { kind: 'turban', color: P.uiPaperDark, alt: P.pirateMaroon },
    cloth: cloth({ top: P.uiPaperDark, topAlt: P.pirateMaroon, pants: P.bandit, sash: P.pirateMaroon, sleeve: 'long', boot: P.woodDark }),
    face: { eye: 'happy', mouth: 'flat', brow: 'sad' },
    weapon: { kind: 'cane' },
    extra: 'beard',
    pose: { armL: [-0.10, 0.14], armR: [-0.50, -0.36], legL: [0.10, 0.06], legR: [-0.08, -0.06], lean: 0.26, headTilt: 0.22 },
  },

  // The dockside sparring partner: brute-class bulk in villager dress. Green-and-gold — no
  // hostile wears these colours — bare fists, and a boxer's guard with a grin, so the
  // silhouette reads friendly at the same glance that reads a thug as trouble.
  sparring_mate: {
    id: 'sparring_mate', name: 'Dockside Sparring Mate', faction: 'villager',
    build: { h: 18, torsoW: 6, armW: 3, longArms: true },
    skin: skinTan,
    hair: { color: P.hairBrown, style: 'short' },
    ident: { kind: 'headscarf', color: P.grassCold, alt: P.heroGold },
    cloth: cloth({ top: P.rope, topAlt: P.grassCold, pants: P.plankDark, sash: P.heroGold, sleeve: 'none', openFront: true, worn: true, boot: P.plankDark }),
    face: { eye: 'happy', mouth: 'grin' },
    weapon: null,
    pose: { armL: [-0.50, 0.80], armR: [-0.50, -0.80], legL: [0.06, 0.24], legR: [-0.06, -0.24], lean: -0.04, headTilt: 0.05 },
  },
};

/** Stable iteration order for tools and lineup shots. */
export const CHARACTER_IDS = Object.keys(CHARACTER_SPECS);

/** Look up a spec by id, with a clear failure instead of `undefined` propagating into a mesh. */
export function characterSpec(id) {
  const s = CHARACTER_SPECS[id];
  if (!s) throw new Error('unknown character spec: ' + id);
  return s;
}
