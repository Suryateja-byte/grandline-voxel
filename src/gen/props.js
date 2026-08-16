// Procedural voxel props: everything that stands on an island but is not terrain and is not
// a character. Trees, rocks, coral, crates, market stalls, cannon, ruins, treasure.
//
// Every prop is a pure function of an Rng plus the block table, so the same seed always makes
// the same tree. Props are built at TERRAIN voxel scale (0.5 m), not character scale, because
// they share the terrain material and sit in the same grid the world is meshed on.
//
// The bar these are judged against is reference/ART_BAR.md §1 and §4: a prop must read at a
// glance from twenty metres. At 0.5 m per voxel and a 62° camera that is roughly 25 screen
// pixels per voxel at 1080p — so silhouette, not surface detail, is what carries a prop.
// The rules that follow from that, and that every builder below obeys:
//
//   * nothing important is thinner than one voxel or shorter than three
//   * the outline is broken deliberately (drooping fronds, ragged hems, tilted lids)
//   * two block types minimum per prop, so there is a tonal step in the silhouette itself
//   * anything a player walks through (grass, flowers, flame) is a non-solid cutout block

import { P, shadeUp, shadeDown } from './palette.js';
import { VoxelVolume, meshVolume } from './voxel.js';
import {
  TILE, paintSolid, paintCloth, paintLeaves, paintPlank,
} from './texture.js';

/** Prop voxel size in metres — the terrain grid (ARCHITECTURE §3). */
export const PROP_SCALE = 0.5;

// ---------------------------------------------------------------------------
// Extra tiles and blocks. props.js does not edit blocks.js; it extends the shared registry
// through its public API, which is what BlockRegistry.define is for.
// ---------------------------------------------------------------------------

/** Five-petal blossom on a transparent field. Reads as a flower head from a long way off. */
function paintBlossom(petal, core) {
  return (p, rng) => {
    p.fill(petal, 0);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.3;
      p.ellipse(16 + Math.cos(a) * 7.5, 16 + Math.sin(a) * 7.5, 5.5, 5.5,
        rng.chance(0.4) ? shadeUp(petal, 0.35) : petal, 255);
    }
    p.ellipse(16, 16, 4, 4, core, 255);
    p.ellipse(15, 15, 1.5, 1.5, shadeUp(core, 0.6), 255);
    p.grain(0.07, 1);
  };
}

/**
 * Blade tuft on a transparent field, deliberately built from elongated ragged clumps rather
 * than straight strokes. The mesher rotates UVs 90° on ±X faces, so a tile of parallel blades
 * would lie on its side on half of a block; clumps read as foliage at any rotation.
 */
function paintTuft(base, dark) {
  return (p, rng) => {
    p.fill(base, 0);
    for (let i = 0; i < 18; i++) {
      const cx = rng.int(3, TILE - 4), cy = rng.int(6, TILE - 3);
      const c = rng.chance(0.4) ? dark : (rng.chance(0.5) ? shadeUp(base, 0.4) : base);
      p.ellipse(cx, cy, rng.range(1.2, 2.4), rng.range(4.0, 8.0), c, 255);
    }
    for (let i = 0; i < 10; i++) {
      p.ellipse(rng.int(0, TILE - 1), rng.int(0, TILE - 1), rng.range(1.5, 3.0), rng.range(1.5, 3.5), 0, 0);
    }
    p.grain(0.08, 1);
  };
}

/** Wanted poster: paper, an ink skull mark and ruled ink bands where the text sits. */
function paintPoster() {
  return (p, rng) => {
    p.steps(P.paper, 3, 8, p.seedTag);
    p.rect(3, 2, 26, 28, P.uiPaperDark);
    p.rect(4, 3, 24, 26, P.paper);
    for (let x = 5; x < 27; x += 2) p.set(x, 5, P.ink);
    p.ellipse(16, 14, 6, 5.5, P.ink);
    p.rect(13, 12, 3, 4, P.paper);
    p.rect(17, 12, 3, 4, P.paper);
    p.rect(13, 19, 7, 3, P.ink);
    for (let y = 24; y < 28; y += 2) for (let x = 6; x < 26; x++) p.set(x, y, P.ink);
    for (let i = 0; i < 12; i++) p.set(rng.int(4, 27), rng.int(3, 28), P.uiPaperDark);
    p.grain(0.04, 2);
    p.bevel(0.10, 2);
  };
}

/** Cut gemstone: a hard facet split, never a flat colour. */
function paintGem(a, b) {
  return (p, rng) => {
    p.steps(a, 3, 5, p.seedTag);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      if (x + y > TILE) p.set(x, y, y > x ? b : shadeDown(b, 0.5));
    }
    p.rect(6, 6, 5, 5, shadeUp(a, 0.9));
    p.grain(0.05, 2);
    p.bevel(0.22, 3);
  };
}

/**
 * Register every extra texture layer props need. Safe to call more than once.
 * @param {import('./texture.js').TextureLibrary} tex
 */
export function registerPropTiles(tex) {
  const t = (n, f) => tex.add('prop:' + n, f);
  t('flame', paintLeaves(P.fruitMera, P.lavaHot));
  t('ember', paintSolid(P.lava, { speckle: 0.22, speckleColor: P.lavaHot, grain: 0.14 }));
  t('flower_red', paintBlossom(P.heroRed, P.heroGold));
  t('flower_gold', paintBlossom(P.heroGold, P.woodDark));
  t('flower_blue', paintBlossom(P.heroCyan, P.uiWhite));
  t('flower_white', paintBlossom(P.uiWhite, P.heroGold));
  t('flower_violet', paintBlossom(P.royalPurple, P.heroGold));
  t('tuft_grass', paintTuft(P.grass, P.grassDark));
  t('tuft_dry', paintTuft(P.grassDry, shadeDown(P.grassDry, 0.55)));
  t('fern', paintTuft(P.jungle, P.jungleDark));
  t('canvas_red', paintCloth(P.sail, { stripe: P.heroRed }));
  t('canvas_blue', paintCloth(P.sail, { stripe: P.heroCyan }));
  t('poster', paintPoster());
  t('gem', paintGem(P.fruitHie, P.fruitGura));
  t('coin', paintSolid(P.gold, { speckle: 0.18, speckleColor: P.goldDark, bevelStrength: 0.3 }));
  t('stone_mossy', paintSolid(P.stone, { speckle: 0.14, speckleColor: P.grassDark, grain: 0.07 }));
  t('coral_alt', paintSolid(P.coralAlt, { speckle: 0.12, speckleColor: P.coral }));
  t('glow', paintSolid(P.lanternGlow, { grain: 0.03, bevelStrength: 0.05 }));
  t('bark_dead', paintPlank(shadeDown(P.woodDark, 0.3), shadeDown(P.woodDark, 0.8), true));
  t('banner', paintCloth(P.pirateMaroon, { stripe: P.heroGold }));
  return tex;
}

/**
 * Define the prop-only blocks on the shared registry and return the merged block table props
 * expect. Call once, after buildBlocks.
 *
 * @param {import('./texture.js').TextureLibrary} tex
 * @param {import('./voxel.js').BlockRegistry} reg
 * @param {Record<string,number>} B result of buildBlocks
 * @returns {Record<string,number>} B plus the prop blocks
 */
export function preparePropBlocks(tex, reg, B) {
  registerPropTiles(tex);
  const L = (n) => tex.layerOf('prop:' + n);
  const PB = Object.assign({}, B);
  const foliage = { cutout: true, opaque: false, solid: false };
  const d = (key, name, tile, opts) => { PB[key] = reg.define(name, tile, opts); };

  d('flame', 'propFlame', L('flame'), Object.assign({ hazard: 6 }, foliage));
  d('ember', 'propEmber', L('ember'));
  d('flowerRed', 'propFlowerRed', L('flower_red'), foliage);
  d('flowerGold', 'propFlowerGold', L('flower_gold'), foliage);
  d('flowerBlue', 'propFlowerBlue', L('flower_blue'), foliage);
  d('flowerWhite', 'propFlowerWhite', L('flower_white'), foliage);
  d('flowerViolet', 'propFlowerViolet', L('flower_violet'), foliage);
  d('tuftGrass', 'propTuftGrass', L('tuft_grass'), foliage);
  d('tuftDry', 'propTuftDry', L('tuft_dry'), foliage);
  d('fern', 'propFern', L('fern'), foliage);
  d('canvasRed', 'propCanvasRed', L('canvas_red'));
  d('canvasBlue', 'propCanvasBlue', L('canvas_blue'));
  d('poster', 'propPoster', L('poster'));
  d('gem', 'propGem', L('gem'));
  d('coin', 'propCoin', L('coin'));
  d('stoneMossy', 'propStoneMossy', L('stone_mossy'));
  d('coralAlt', 'propCoralAlt', L('coral_alt'));
  d('glow', 'propGlow', L('glow'));
  d('barkDead', 'propBarkDead', L('bark_dead'));
  d('banner', 'propBanner', L('banner'));
  return PB;
}

/** The five flower blocks, in a fixed order so a seed always picks the same colour. */
export const FLOWER_KEYS = ['flowerRed', 'flowerGold', 'flowerBlue', 'flowerWhite', 'flowerViolet'];

// ---------------------------------------------------------------------------
// Volume helpers
// ---------------------------------------------------------------------------

const V = (sx, sy, sz) => new VoxelVolume(sx, sy, sz);

/** Solid ellipsoid, optionally roughened per-voxel so canopies are not billiard balls. */
function blob(v, cx, cy, cz, rx, ry, rz, id, rng, rough = 0) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry, dz = (z - cz) / rz;
        const d = dx * dx + dy * dy + dz * dz;
        const lim = rough && rng ? 1.0 + rng.sym() * rough : 1.02;
        if (d <= lim) v.set(x, y, z, id);
      }
    }
  }
}

function discXZ(v, y, cx, cz, rx, rz, id) {
  for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx, dz = (z - cz) / rz;
      if (dx * dx + dz * dz <= 1.02) v.set(x, y, z, id);
    }
  }
}

/** Hollow ring in the XZ plane — well kerbs, campfire stones, barrel hoops. */
function ringXZ(v, y, cx, cz, r, id) {
  for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x - cx, dz = z - cz;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d <= r + 0.5 && d >= r - 0.75) v.set(x, y, z, id);
    }
  }
}

function column(v, x, z, y0, y1, id) {
  for (let y = y0; y <= y1; y++) v.set(x, y, z, id);
}

/** Bresenham-ish 3D voxel line. Branches, fronds, rigging. */
function line3(v, x0, y0, z0, x1, y1, z1, id) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    v.set(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), Math.round(z0 + (z1 - z0) * t), id);
  }
}

function prop(name, volume, anchor) {
  return {
    name,
    volume,
    anchor,
    size: [volume.sx, volume.sy, volume.sz],
    radius: Math.max(volume.sx, volume.sz) / 2,
    voxels: volume.count(),
  };
}

/** Bottom-centre anchor, the default for anything that stands on the ground. */
const base = (v) => [v.sx / 2, 0, v.sz / 2];

// ---------------------------------------------------------------------------
// Vegetation
// ---------------------------------------------------------------------------

/**
 * Palm. The read is the bend: a straight palm looks like a pole with a hat on it, so the
 * trunk always leans and the fronds always droop below their attachment point.
 */
export function palmTree(rng, B, opts = {}) {
  const h = opts.height || rng.int(12, 18);
  const lean = rng.range(0.18, 0.42) * (rng.chance(0.5) ? 1 : -1);
  const leanZ = rng.range(-0.25, 0.25);
  const R = 7;                                   // frond reach, so the crown needs R clear
  // The volume is centred on the CROWN, not the base: the trunk leans, and a volume centred
  // on the base clips half the fronds off the far side. The base gets pushed the other way.
  const driftX = lean * h * 0.55, driftZ = leanZ * h * 0.55;
  const v = V(R * 2 + 2, h + 5, R * 2 + 2);
  const cx = R - driftX, cz = R - driftZ;        // trunk foot

  let tx = cx, tz = cz;
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    tx = cx + driftX * t * t;
    tz = cz + driftZ * t * t;
    v.set(Math.round(tx), y, Math.round(tz), B.wood);
    // A second voxel low down thickens the base so it does not read as a stick.
    if (y < 3) { v.set(Math.round(tx) + 1, y, Math.round(tz), B.wood); v.set(Math.round(tx), y, Math.round(tz) + 1, B.wood); }
  }
  const hx = Math.round(tx), hz = Math.round(tz);

  const fronds = rng.int(6, 8);
  const a0 = rng.f() * Math.PI * 2;
  for (let i = 0; i < fronds; i++) {
    const a = a0 + (i / fronds) * Math.PI * 2 + rng.range(-0.18, 0.18);
    const len = rng.int(4, 6);
    const dx = Math.cos(a), dz = Math.sin(a);
    for (let k = 1; k <= len; k++) {
      // Rise then fall: the droop is the whole silhouette.
      const y = h + Math.round(1.6 * Math.sin((k / len) * Math.PI * 0.9) - (k / len) * 2.2);
      const x = Math.round(hx + dx * k), z = Math.round(hz + dz * k);
      v.set(x, y, z, B.leavesPalm);
      if (k > 1 && k < len) {
        v.set(x + Math.round(-dz), y, z + Math.round(dx), B.leavesPalm);
        v.set(x - Math.round(-dz), y, z - Math.round(dx), B.leavesPalm);
      }
    }
  }
  v.set(hx, h, hz, B.leavesPalm);
  v.set(hx, h + 1, hz, B.leavesPalm);
  // Coconuts under the crown.
  for (let i = 0; i < rng.int(2, 4); i++) {
    const a = rng.f() * Math.PI * 2;
    v.set(hx + Math.round(Math.cos(a) * 1.4), h - 1, hz + Math.round(Math.sin(a) * 1.4), B.woodDark);
  }
  return prop('palmTree', v, [cx + 0.5, 0, cz + 0.5]);   // anchor is the trunk foot, not the crown
}

/** Broad-leaf jungle tree: thick bole, two canopy masses at different heights, hanging vines. */
export function jungleTree(rng, B, opts = {}) {
  const h = opts.height || rng.int(14, 22);
  const R = 8;
  const v = V(R * 2 + 1, h + 8, R * 2 + 1);
  const cx = R, cz = R;
  for (let y = 0; y < h; y++) {
    v.fillBox(cx, y, cz, cx + 1, y, cz + 1, B.wood);
    if (y < 2) { v.set(cx - 1, y, cz, B.wood); v.set(cx + 2, y, cz + 1, B.wood); v.set(cx, y, cz - 1, B.wood); }
  }
  // Two limbs, so the canopy has somewhere to hang from.
  for (let i = 0; i < 3; i++) {
    const a = rng.f() * Math.PI * 2;
    const ly = h - rng.int(2, 5);
    line3(v, cx, ly, cz, cx + Math.round(Math.cos(a) * 4), ly + rng.int(1, 3), cz + Math.round(Math.sin(a) * 4), B.wood);
  }
  blob(v, cx + 0.5, h + 2, cz + 0.5, rng.range(5.5, 7), rng.range(3, 4), rng.range(5.5, 7), B.leaves, rng, 0.30);
  blob(v, cx + rng.range(-3, 3), h + rng.range(4, 6), cz + rng.range(-3, 3), rng.range(3, 4.5), 2.6, rng.range(3, 4.5), B.leaves, rng, 0.30);
  for (let i = 0; i < rng.int(3, 6); i++) {
    const a = rng.f() * Math.PI * 2, r = rng.range(3, 6);
    const x = cx + Math.round(Math.cos(a) * r), z = cz + Math.round(Math.sin(a) * r);
    for (let k = 0; k < rng.int(2, 5); k++) v.set(x, h + 1 - k, z, B.leaves);
  }
  return prop('jungleTree', v, [cx + 1, 0, cz + 1]);
}

/** Conifer. Stacked skirts that shrink upward; the notch between skirts is the read. */
export function pineTree(rng, B, opts = {}) {
  const h = opts.height || rng.int(14, 22);
  const R = 6;
  const v = V(R * 2 + 1, h + 3, R * 2 + 1);
  const cx = R, cz = R;
  column(v, cx, cz, 0, h, B.wood);
  v.set(cx + 1, 0, cz, B.wood); v.set(cx, 0, cz + 1, B.wood);
  const tiers = rng.int(5, 7);
  const bottom = Math.round(h * 0.22);
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const y = Math.round(bottom + t * (h - bottom - 1));
    const r = 5.4 * (1 - t) + 1.0;
    discXZ(v, y, cx, cz, r, r, B.leavesPine);
    discXZ(v, y + 1, cx, cz, r * 0.62, r * 0.62, B.leavesPine);
  }
  column(v, cx, cz, h + 1, h + 2, B.leavesPine);
  return prop('pineTree', v, [cx + 0.5, 0, cz + 0.5]);
}

/** Blossom tree: low, wide, gnarled. Sits at 10–14 so it never hides a building behind it. */
export function cherryTree(rng, B, opts = {}) {
  const h = opts.height || rng.int(9, 13);
  const R = 7;
  const v = V(R * 2 + 1, h + 6, R * 2 + 1);
  const cx = R, cz = R;
  for (let y = 0; y < h; y++) {
    const wob = Math.round(Math.sin(y * 0.7) * 0.9);
    v.set(cx + wob, y, cz, B.wood);
    v.set(cx + wob, y, cz + 1, B.wood);
    if (y < 2) v.set(cx + wob + 1, y, cz, B.wood);
  }
  const arms = rng.int(3, 4);
  for (let i = 0; i < arms; i++) {
    const a = (i / arms) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const ex = cx + Math.round(Math.cos(a) * rng.range(3, 5));
    const ez = cz + Math.round(Math.sin(a) * rng.range(3, 5));
    line3(v, cx, h - 2, cz, ex, h + rng.int(1, 3), ez, B.wood);
    blob(v, ex, h + 3, ez, rng.range(2.6, 3.8), 2.2, rng.range(2.6, 3.8), B.leavesCherry, rng, 0.32);
  }
  blob(v, cx, h + 2, cz, 4.4, 2.4, 4.4, B.leavesCherry, rng, 0.30);
  return prop('cherryTree', v, [cx + 0.5, 0, cz + 0.5]);
}

/** Dead tree: all silhouette, no canopy. Branch tips deliberately end in single voxels. */
export function deadTree(rng, B, opts = {}) {
  const h = opts.height || rng.int(9, 15);
  const R = 6;
  const v = V(R * 2 + 1, h + 5, R * 2 + 1);
  const cx = R, cz = R;
  let x = cx, z = cz;
  for (let y = 0; y < h; y++) {
    if (y > 2 && rng.chance(0.22)) { x += rng.chance(0.5) ? 1 : -1; }
    if (y > 2 && rng.chance(0.16)) { z += rng.chance(0.5) ? 1 : -1; }
    v.set(x, y, z, B.barkDead);
    if (y < 2) { v.set(x + 1, y, z, B.barkDead); v.set(x, y, z + 1, B.barkDead); v.set(x - 1, y, z, B.barkDead); }
  }
  for (let i = 0; i < rng.int(4, 6); i++) {
    const a = rng.f() * Math.PI * 2;
    const ly = rng.int(Math.floor(h * 0.45), h);
    const len = rng.int(3, 5);
    const ex = x + Math.round(Math.cos(a) * len), ez = z + Math.round(Math.sin(a) * len);
    line3(v, x, ly, z, ex, ly + rng.int(1, 4), ez, B.barkDead);
    v.set(ex, ly + 4, ez, B.barkDead);
  }
  return prop('deadTree', v, [cx + 0.5, 0, cz + 0.5]);
}

/** Columnar cactus with one or two arms. The arms are what stop it reading as a fence post. */
export function cactus(rng, B, opts = {}) {
  const h = opts.height || rng.int(6, 11);
  const v = V(9, h + 3, 5);
  const cx = 4, cz = 2;
  for (let y = 0; y < h; y++) { v.set(cx, y, cz, B.cactus); v.set(cx, y, cz + 1, B.cactus); }
  const arms = rng.int(1, 2);
  for (let i = 0; i < arms; i++) {
    const dir = i === 0 ? (rng.chance(0.5) ? 1 : -1) : -1;
    const ay = rng.int(Math.floor(h * 0.35), Math.floor(h * 0.7));
    const reach = rng.int(2, 3);
    for (let k = 1; k <= reach; k++) v.set(cx + dir * k, ay, cz, B.cactus);
    const up = rng.int(2, 4);
    for (let k = 0; k < up; k++) v.set(cx + dir * reach, ay + k, cz, B.cactus);
    v.set(cx + dir * reach, ay + up, cz, B.flowerRed);   // one bloom per arm, the only warm note
  }
  for (let i = 0; i < 3; i++) v.set(cx, h + i - 1, cz, B.cactus);
  return prop('cactus', v, [cx + 0.5, 0, cz + 1]);
}

/** Giant mushroom: fat stem, wide spotted cap, gills of stem colour under the rim. */
export function giantMushroom(rng, B, opts = {}) {
  const stemH = opts.height || rng.int(5, 9);
  const capR = rng.int(4, 6);
  const v = V(capR * 2 + 3, stemH + capR + 3, capR * 2 + 3);
  const cx = capR + 1, cz = capR + 1;
  for (let y = 0; y < stemH; y++) {
    const r = y < 2 ? 1.6 : 1.1;
    discXZ(v, y, cx, cz, r, r, B.mushroomStem);
  }
  discXZ(v, stemH, cx, cz, capR - 0.5, capR - 0.5, B.mushroomStem);   // gills
  for (let k = 0; k <= capR - 1; k++) {
    const r = capR * Math.sqrt(Math.max(0, 1 - (k / capR) * (k / capR))) + 0.4;
    discXZ(v, stemH + 1 + k, cx, cz, r, r, B.mushroomCap);
  }
  for (let i = 0; i < rng.int(4, 7); i++) {
    const a = rng.f() * Math.PI * 2, r = rng.range(1, capR - 1);
    v.set(cx + Math.round(Math.cos(a) * r), stemH + 2 + rng.int(0, 1), cz + Math.round(Math.sin(a) * r), B.mushroomStem);
  }
  return prop('giantMushroom', v, [cx + 0.5, 0, cz + 0.5]);
}

/** Low shrub. Two leaf tones and a ragged top so it does not read as a green pillow. */
export function bush(rng, B, opts = {}) {
  const r = opts.radius || rng.range(2.0, 3.2);
  const leaf = opts.leaf || B.leaves;
  const v = V(Math.ceil(r * 2) + 3, Math.ceil(r * 2) + 2, Math.ceil(r * 2) + 3);
  const cx = v.sx / 2 - 0.5, cz = v.sz / 2 - 0.5;
  blob(v, cx, r - 0.3, cz, r, r * 0.85, r, leaf, rng, 0.34);
  blob(v, cx + rng.range(-1, 1), r * 1.4, cz + rng.range(-1, 1), r * 0.6, r * 0.5, r * 0.6, leaf, rng, 0.34);
  for (let i = 0; i < 3; i++) v.set(Math.round(cx + rng.sym() * r), 0, Math.round(cz + rng.sym() * r), B.woodDark);
  return prop('bush', v, [v.sx / 2, 0, v.sz / 2]);
}

/** Fern: three or four fronds fanned from one root. Understory filler with a real outline. */
export function fern(rng, B) {
  const v = V(5, 4, 5);
  v.set(2, 0, 2, B.fern);
  const n = rng.int(3, 5);
  const a0 = rng.f() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2;
    const dx = Math.round(Math.cos(a)), dz = Math.round(Math.sin(a));
    v.set(2 + dx, 1, 2 + dz, B.fern);
    v.set(2 + dx * 2, 1, 2 + dz * 2, B.fern);
    v.set(2 + dx, 2, 2 + dz, B.fern);
  }
  v.set(2, 2, 2, B.fern);
  v.set(2, 3, 2, B.fern);
  return prop('fern', v, [2.5, 0, 2.5]);
}

/** Grass tuft, two or three voxels tall, scattered off-centre so a field never grids up. */
export function tallGrass(rng, B, opts = {}) {
  const dry = opts.dry === true;
  const id = dry ? B.tuftDry : B.tuftGrass;
  const v = V(3, 3, 3);
  // Centre blade is always two or three tall, and two side blades always exist, so a tuft is
  // never a single lonely voxel that reads as terrain noise.
  column(v, 1, 1, 0, rng.chance(0.55) ? 2 : 1, id);
  const corners = [[0, 1], [2, 1], [1, 0], [1, 2]];
  rng.shuffle(corners);
  for (let i = 0; i < 2 + (rng.chance(0.4) ? 1 : 0); i++) {
    const [x, z] = corners[i];
    v.set(x, 0, z, id);
    if (rng.chance(0.6)) v.set(x, 1, z, id);
  }
  return prop('tallGrass', v, [1.5, 0, 1.5]);
}

/** Flower patch: one dominant colour plus a second accent, seated in grass. */
export function flowerPatch(rng, B, opts = {}) {
  const r = opts.radius || rng.int(2, 4);
  const v = V(r * 2 + 1, 3, r * 2 + 1);
  const main = B[opts.color || rng.pick(FLOWER_KEYS)];
  const accent = B[rng.pick(FLOWER_KEYS)];
  const cx = r, cz = r;
  for (let z = 0; z <= r * 2; z++) {
    for (let x = 0; x <= r * 2; x++) {
      const d = Math.hypot(x - cx, z - cz);
      if (d > r + 0.2) continue;
      if (rng.chance(0.55)) v.set(x, 0, z, B.tuftGrass);
      if (rng.chance(0.42)) {
        v.set(x, 0, z, B.tuftGrass);
        v.set(x, 1, z, rng.chance(0.75) ? main : accent);
      }
    }
  }
  v.set(cx, 1, cz, main);
  return prop('flowerPatch', v, [cx + 0.5, 0, cz + 0.5]);
}

// ---------------------------------------------------------------------------
// Stone
// ---------------------------------------------------------------------------

/**
 * Rock. @param {'small'|'medium'|'large'|object} opts
 * Lumps rather than spheres: three overlapping ellipsoids with different centres.
 */
export function rock(rng, B, opts = {}) {
  const size = typeof opts === 'string' ? opts : (opts.size || 'medium');
  // Even 'small' stays above 1.6 voxels of radius: a two-voxel pebble vanishes at twenty
  // metres, which is the distance every prop in this file is judged at.
  const r = size === 'small' ? rng.range(1.7, 2.3) : size === 'large' ? rng.range(3.4, 4.6) : rng.range(2.5, 3.4);
  const id = (typeof opts === 'object' && opts.block) || B.rock;
  const n = Math.ceil(r * 2) + 3;
  const v = V(n, Math.ceil(r * 2) + 2, n);
  const cx = n / 2 - 0.5, cz = n / 2 - 0.5;
  blob(v, cx, r * 0.75, cz, r, r * 0.8, r, id, rng, 0.26);
  for (let i = 0; i < 2; i++) {
    blob(v, cx + rng.sym() * r * 0.6, r * 0.5 + rng.range(0, r * 0.6), cz + rng.sym() * r * 0.6,
      r * 0.62, r * 0.5, r * 0.62, id, rng, 0.26);
  }
  // A darker crown catches the key light and stops the lump reading as one flat mass.
  if (r > 2) {
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
      const top = v.columnTop(x, z);
      if (top > 0 && rng.chance(0.35)) v.set(x, top, z, B.stone);
    }
  }
  return prop('rock', v, [n / 2, 0, n / 2]);
}

/** Boulder: one big mass with a mossy cap and a shelf, so it reads as climbable. */
export function boulder(rng, B, opts = {}) {
  const r = opts.radius || rng.range(4.0, 5.8);
  const n = Math.ceil(r * 2) + 4;
  const v = V(n, Math.ceil(r * 1.7) + 3, n);
  const cx = n / 2 - 0.5, cz = n / 2 - 0.5;
  blob(v, cx, r * 0.6, cz, r, r * 0.72, r * 0.9, B.rock, rng, 0.22);
  blob(v, cx + r * 0.4, r * 0.95, cz - r * 0.3, r * 0.55, r * 0.42, r * 0.55, B.rock, rng, 0.24);
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const top = v.columnTop(x, z);
    if (top > 1 && rng.chance(0.5)) v.set(x, top, z, B.stoneMossy);
  }
  return prop('boulder', v, [n / 2, 0, n / 2]);
}

/** Coral head: branching fingers in two hues. Only ever placed below sea level. */
export function coralClump(rng, B, opts = {}) {
  const h = opts.height || rng.int(4, 8);
  const n = 11;
  const v = V(n, h + 3, n);
  const cx = 5, cz = 5;
  blob(v, cx, 1, cz, 2.6, 1.4, 2.6, B.coral, rng, 0.3);
  const arms = rng.int(3, 6);
  for (let i = 0; i < arms; i++) {
    const a = (i / arms) * Math.PI * 2 + rng.range(-0.4, 0.4);
    const len = rng.int(3, h);
    const id = rng.chance(0.5) ? B.coral : B.coralAlt;
    let x = cx, z = cz;
    for (let k = 0; k < len; k++) {
      x += k > 1 && rng.chance(0.5) ? Math.round(Math.cos(a)) : 0;
      z += k > 1 && rng.chance(0.5) ? Math.round(Math.sin(a)) : 0;
      v.set(x, 1 + k, z, id);
      if (k === len - 1) { v.set(x + 1, 1 + k, z, id); v.set(x, 1 + k, z + 1, id); }
    }
  }
  return prop('coralClump', v, [cx + 0.5, 0, cz + 0.5]);
}

// ---------------------------------------------------------------------------
// Containers and dressing
// ---------------------------------------------------------------------------

/** Crate: plank box with dark corner bracing on every visible face. */
export function crate(rng, B, opts = {}) {
  const s = opts.size || 3;
  const v = V(s, s, s);
  v.fillBox(0, 0, 0, s - 1, s - 1, s - 1, B.plank);
  for (let i = 0; i < s; i++) {
    v.set(0, i, 0, B.woodDark); v.set(s - 1, i, 0, B.woodDark);
    v.set(0, i, s - 1, B.woodDark); v.set(s - 1, i, s - 1, B.woodDark);
    v.set(i, 0, 0, B.woodDark); v.set(i, s - 1, 0, B.woodDark);
    v.set(i, 0, s - 1, B.woodDark); v.set(i, s - 1, s - 1, B.woodDark);
    v.set(0, 0, i, B.woodDark); v.set(0, s - 1, i, B.woodDark);
    v.set(s - 1, 0, i, B.woodDark); v.set(s - 1, s - 1, i, B.woodDark);
  }
  return prop('crate', v, base(v));
}

/** Barrel: round in plan, with two dark hoops. The hoops are the read. */
export function barrel(rng, B, opts = {}) {
  const h = opts.height || 5;
  const v = V(5, h, 5);
  for (let y = 0; y < h; y++) {
    const bulge = y === 0 || y === h - 1 ? 1.7 : 2.2;
    discXZ(v, y, 2, 2, bulge, bulge, (y === 1 || y === h - 2) ? B.metalDark : B.barrel);
  }
  discXZ(v, h - 1, 2, 2, 1.7, 1.7, B.woodDark);
  return prop('barrel', v, base(v));
}

/**
 * Chest. @param {boolean|object} opts `true` (or {open:true}) tilts the lid back and shows gold.
 * The open lid is a separate stepped stack rather than a rotated box — voxels do not rotate.
 */
export function chest(rng, B, opts = {}) {
  const open = typeof opts === 'boolean' ? opts : !!opts.open;
  const v = V(7, open ? 8 : 6, 5);
  v.fillBox(0, 0, 0, 6, 3, 4, B.plank);
  v.fillBox(0, 0, 0, 6, 0, 4, B.woodDark);
  for (let x = 1; x < 6; x += 2) { column(v, x, 0, 0, 3, B.metalDark); column(v, x, 4, 0, 3, B.metalDark); }
  if (open) {
    v.fillBox(1, 4, 1, 5, 4, 3, B.coin);
    for (let i = 0; i < 5; i++) v.set(rng.int(1, 5), 5, rng.int(1, 3), rng.chance(0.4) ? B.gem : B.coin);
    // Lid stepped backwards, leaning open.
    for (let k = 0; k < 4; k++) v.fillBox(0, 4 + k, Math.max(0, 1 - k), 6, 4 + k, Math.max(0, 2 - k), B.woodDark);
    v.fillBox(0, 4, 0, 6, 4, 0, B.plank);
  } else {
    for (let k = 0; k < 2; k++) v.fillBox(k, 4 + k, k, 6 - k, 4 + k, 4 - k, B.plank);
    v.fillBox(2, 4, 4, 4, 5, 4, B.gold);
  }
  v.fillBox(3, 2, 4, 3, 3, 4, B.gold);
  return prop('chest', v, base(v));
}

/** Coiled rope: a flat spiral, two turns. Small, but it says "working dock". */
export function ropeCoil(rng, B) {
  const v = V(7, 2, 7);
  ringXZ(v, 0, 3, 3, 2.8, B.rope);
  ringXZ(v, 0, 3, 3, 1.5, B.rope);
  ringXZ(v, 1, 3, 3, 2.1, B.rope);
  v.set(3, 1, 3, B.rope);
  return prop('ropeCoil', v, base(v));
}

/** Post lantern: the glow block is a full voxel so it reads as a light source at distance. */
export function lantern(rng, B, opts = {}) {
  const h = opts.height || rng.int(5, 7);
  const v = V(3, h + 4, 3);
  column(v, 1, 1, 0, h, B.woodDark);
  v.fillBox(0, h + 1, 0, 2, h + 1, 2, B.metalDark);
  v.fillBox(0, h + 2, 0, 2, h + 2, 2, B.glow);
  v.fillBox(0, h + 2, 0, 0, h + 2, 2, B.metalDark);
  v.fillBox(2, h + 2, 0, 2, h + 2, 2, B.metalDark);
  v.fillBox(0, h + 3, 0, 2, h + 3, 2, B.metalDark);
  v.set(1, h + 3, 1, B.metal);
  return prop('lantern', v, [1.5, 0, 1.5]);
}

/** Wall or ground torch: stub post, iron cradle, flame. */
export function torch(rng, B, opts = {}) {
  const h = opts.height || 4;
  const v = V(3, h + 3, 3);
  column(v, 1, 1, 0, h - 1, B.woodDark);
  v.set(1, h, 1, B.metalDark);
  v.set(1, h + 1, 1, B.flame);
  v.set(0, h + 1, 1, B.flame); v.set(2, h + 1, 1, B.flame);
  v.set(1, h + 1, 0, B.flame); v.set(1, h + 1, 2, B.flame);
  v.set(1, h + 2, 1, B.flame);
  return prop('torch', v, [1.5, 0, 1.5]);
}

/** Campfire: stone ring, crossed logs, a flame column and embers under it. */
export function campfire(rng, B) {
  const v = V(7, 6, 7);
  ringXZ(v, 0, 3, 3, 2.7, B.rock);
  for (let i = 0; i < 3; i++) {
    const a = rng.f() * Math.PI * 2;
    const dx = Math.round(Math.cos(a) * 2), dz = Math.round(Math.sin(a) * 2);
    line3(v, 3 - dx, 1, 3 - dz, 3 + dx, 1, 3 + dz, B.woodDark);
  }
  v.fillBox(2, 1, 2, 4, 1, 4, B.ember);
  v.fillBox(2, 2, 2, 4, 3, 4, B.flame);
  v.fillBox(3, 2, 3, 3, 4, 3, B.flame);
  v.set(3, 5, 3, B.flame);
  v.set(2, 3, 3, 0); v.set(4, 3, 3, 0);
  return prop('campfire', v, [3.5, 0, 3.5]);
}

/** A-frame tent: canvas walls, ridge pole, guy lines, an open flap on the front. */
export function tent(rng, B, opts = {}) {
  const len = opts.length || 9, w = 9, h = 7;
  const canvas = rng.chance(0.5) ? B.canvasRed : B.canvasBlue;
  const v = V(w, h, len);
  // Wall slope is derived, not guessed: the ground course must land on the volume edge or the
  // canvas gets clipped away and the tent turns into a bare ridge pole.
  const spreadAt = (k) => Math.round(((h - 2 - k) / (h - 2)) * ((w - 1) / 2));
  for (let z = 0; z < len; z++) {
    for (let k = 0; k < h - 1; k++) {
      const spread = spreadAt(k);
      v.set(4 - spread, k, z, canvas);
      v.set(4 + spread, k, z, canvas);
      if (spread > 1) { v.set(4 - spread + 1, k, z, canvas); v.set(4 + spread - 1, k, z, canvas); }
    }
  }
  for (let z = 0; z < len; z++) v.set(4, h - 2, z, canvas);
  // Open flap: cut the front face out so the tent has a dark interior to read against.
  for (let k = 1; k < h - 2; k++) {
    const spread = spreadAt(k);
    for (let x = 4 - spread + 1; x <= 4 + spread - 1; x++) v.set(x, k, len - 1, 0);
  }
  column(v, 4, 0, 0, h - 2, B.woodDark);
  column(v, 4, len - 1, 0, h - 2, B.woodDark);
  v.set(2, 0, len - 1, B.rope); v.set(6, 0, len - 1, B.rope);
  v.set(1, 0, 0, B.rope); v.set(7, 0, 0, B.rope);
  return prop('tent', v, [w / 2, 0, len / 2]);
}

/** Market stall: four posts, a striped awning with a scalloped edge, counter and goods. */
export function marketStall(rng, B, opts = {}) {
  const w = 9, d = 7, h = 8;
  const canvas = rng.chance(0.5) ? B.canvasRed : B.canvasBlue;
  const v = V(w, h, d);
  for (const [x, z] of [[0, 0], [w - 1, 0], [0, d - 1], [w - 1, d - 1]]) column(v, x, z, 0, h - 3, B.woodDark);
  // Awning: two slopes meeting at a ridge, front edge scalloped.
  for (let z = 0; z < d; z++) {
    const rise = Math.round(Math.abs(z - (d - 1) / 2) * -0.8 + 2);
    for (let x = 0; x < w; x++) v.set(x, h - 3 + rise, z, canvas);
  }
  for (let x = 0; x < w; x += 2) v.set(x, h - 4, d - 1, canvas);
  v.fillBox(0, 2, d - 2, w - 1, 2, d - 1, B.plank);      // counter
  v.fillBox(0, 0, d - 2, w - 1, 1, d - 1, B.plankV);
  for (let i = 0; i < rng.int(3, 5); i++) {
    v.set(rng.int(1, w - 2), 3, d - 2 + rng.int(0, 1), rng.chance(0.5) ? B.mushroomCap : B.barrel);
  }
  v.fillBox(1, 0, 1, 2, 2, 2, B.barrel);
  return prop('marketStall', v, [w / 2, 0, d / 2]);
}

/** Stilt hut over the shallows: plank deck, thatch roof, ladder and a drying net. */
export function fishingHut(rng, B, opts = {}) {
  const w = 11, d = 11, h = 14;
  const stilt = opts.stilt !== undefined ? opts.stilt : 4;
  const v = V(w, h, d);
  for (const [x, z] of [[1, 1], [w - 2, 1], [1, d - 2], [w - 2, d - 2], [w >> 1, 1], [w >> 1, d - 2]]) {
    column(v, x, z, 0, stilt, B.woodDark);
  }
  v.fillBox(0, stilt + 1, 0, w - 1, stilt + 1, d - 1, B.plank);
  const wallTop = stilt + 5;
  for (let y = stilt + 2; y <= wallTop; y++) {
    for (let x = 1; x < w - 1; x++) { v.set(x, y, 1, B.plankV); v.set(x, y, d - 2, B.plankV); }
    for (let z = 1; z < d - 1; z++) { v.set(1, y, z, B.plankV); v.set(w - 2, y, z, B.plankV); }
  }
  v.fillBox(4, stilt + 2, 1, 6, wallTop - 1, 1, 0);        // doorway
  v.fillBox(1, stilt + 4, 5, 1, stilt + 4, 6, B.glass);    // window
  for (let k = 0; k <= 4; k++) {
    const r = 5 - k;
    if (r < 0) break;
    for (let z = (d >> 1) - r; z <= (d >> 1) + r; z++) {
      for (let x = (w >> 1) - r; x <= (w >> 1) + r; x++) {
        if (Math.abs(x - (w >> 1)) === r || Math.abs(z - (d >> 1)) === r || k === 4) v.set(x, wallTop + 1 + k, z, B.thatch);
      }
    }
  }
  for (let k = 0; k <= stilt + 1; k += 2) v.set(5, k, 0, B.woodDark);
  for (let z = 2; z < d - 2; z++) v.set(w - 1, stilt + 3, z, B.rope);
  return prop('fishingHut', v, [w / 2, 0, d / 2]);
}

/** Dock section: plank deck on piles, with a bollard and a gap between boards. */
export function dockPlanks(rng, B, opts = {}) {
  const w = opts.width || 8, d = opts.length || 12, h = 5;
  const v = V(w, h, d);
  for (let z = 1; z < d; z += 4) {
    column(v, 0, z, 0, h - 2, B.woodDark);
    column(v, w - 1, z, 0, h - 2, B.woodDark);
  }
  v.fillBox(0, h - 1, 0, w - 1, h - 1, d - 1, B.plank);
  for (let z = 3; z < d; z += 4) v.fillBox(0, h - 1, z, w - 1, h - 1, z, B.plankV);
  v.fillBox(0, h - 2, 0, w - 1, h - 2, 0, B.woodDark);
  v.fillBox(0, h - 2, d - 1, w - 1, h - 2, d - 1, B.woodDark);
  return prop('dockPlanks', v, [w / 2, 0, d / 2]);
}

/** Mooring post: fat bollard with a rope turn and a scarred cap. */
export function mooringPost(rng, B, opts = {}) {
  const h = opts.height || 5;
  const v = V(5, h + 1, 5);
  for (let y = 0; y < h; y++) discXZ(v, y, 2, 2, y > h - 3 ? 1.5 : 1.2, y > h - 3 ? 1.5 : 1.2, B.woodDark);
  ringXZ(v, Math.max(1, h - 4), 2, 2, 1.7, B.rope);
  ringXZ(v, Math.max(2, h - 3), 2, 2, 1.7, B.rope);
  discXZ(v, h, 2, 2, 1.5, 1.5, B.metalDark);
  return prop('mooringPost', v, [2.5, 0, 2.5]);
}

/** Signpost: post, a board that overhangs on one side, and an arrow point. */
export function signpost(rng, B, opts = {}) {
  const h = opts.height || 7;
  const v = V(9, h + 1, 3);
  column(v, 4, 1, 0, h, B.woodDark);
  const dir = rng.chance(0.5) ? 1 : -1;
  const y = h - 2;
  const x0 = dir > 0 ? 3 : 1, x1 = dir > 0 ? 7 : 5;
  v.fillBox(x0, y, 1, x1, y + 2, 1, B.plank);
  const tip = dir > 0 ? x1 + 1 : x0 - 1;
  v.fillBox(tip, y + 1, 1, tip, y + 1, 1, B.plank);
  v.fillBox(x0, y, 1, x0, y + 2, 1, B.woodDark);
  v.set(4, h, 1, B.woodDark);
  if (rng.chance(0.5)) v.fillBox(x0 + 1, y + 2, 1, x1 - 1, y + 2, 1, B.poster);
  return prop('signpost', v, [4.5, 0, 1.5]);
}

/** Village well: stone kerb, two posts, a pitched roof and a bucket on a rope. */
export function well(rng, B) {
  const v = V(9, 12, 9);
  for (let y = 0; y < 3; y++) ringXZ(v, y, 4, 4, 3.2, y === 2 ? B.stone : B.stoneBrick);
  discXZ(v, 0, 4, 4, 2.4, 2.4, B.stoneMossy);
  column(v, 1, 4, 3, 7, B.woodDark);
  column(v, 7, 4, 3, 7, B.woodDark);
  for (let k = 0; k <= 3; k++) {
    for (let z = 1; z <= 7; z++) {
      v.set(4 - (3 - k), 8 + k, z, B.roof);
      v.set(4 + (3 - k), 8 + k, z, B.roof);
    }
  }
  for (let z = 1; z <= 7; z++) v.set(4, 11, z, B.woodDark);
  for (let x = 2; x <= 6; x++) v.set(x, 7, 4, B.woodDark);
  column(v, 4, 4, 5, 6, B.rope);
  v.fillBox(3, 4, 3, 5, 4, 5, B.barrel);
  return prop('well', v, [4.5, 0, 4.5]);
}

/** Bell tower: stone base, timber shaft, open belfry with a gold bell and a pitched cap. */
export function bellTower(rng, B, opts = {}) {
  const shaft = opts.shaft || rng.int(10, 14);
  const v = V(9, shaft + 12, 9);
  for (let y = 0; y < 4; y++) {
    for (let z = 1; z <= 7; z++) for (let x = 1; x <= 7; x++) {
      if (x === 1 || x === 7 || z === 1 || z === 7) v.set(x, y, z, y === 3 ? B.stone : B.stoneBrick);
    }
  }
  for (const [x, z] of [[2, 2], [6, 2], [2, 6], [6, 6]]) column(v, x, z, 4, shaft, B.woodDark);
  for (let y = 6; y < shaft; y += 3) {
    for (let x = 2; x <= 6; x++) { v.set(x, y, 2, B.plank); v.set(x, y, 6, B.plank); }
    for (let z = 2; z <= 6; z++) { v.set(2, y, z, B.plank); v.set(6, y, z, B.plank); }
  }
  v.fillBox(1, shaft + 1, 1, 7, shaft + 1, 7, B.plank);
  for (const [x, z] of [[1, 1], [7, 1], [1, 7], [7, 7]]) column(v, x, z, shaft + 2, shaft + 5, B.woodDark);
  // The bell hangs in open air — that hole in the silhouette is what names the building.
  v.fillBox(3, shaft + 3, 3, 5, shaft + 4, 5, B.gold);
  v.set(4, shaft + 5, 4, B.metalDark);
  for (let k = 0; k <= 4; k++) {
    const r = 4 - k;
    for (let z = 4 - r; z <= 4 + r; z++) for (let x = 4 - r; x <= 4 + r; x++) {
      if (Math.abs(x - 4) === r || Math.abs(z - 4) === r || k === 4) v.set(x, shaft + 6 + k, z, B.roof);
    }
  }
  return prop('bellTower', v, [4.5, 0, 4.5]);
}

/** One windmill sail. Anchor is the hub end, so the mill can spin it about its own origin. */
export function windmillBlade(rng, B, opts = {}) {
  const len = opts.length || 16;
  const v = V(5, len, 2);
  for (let y = 0; y < len; y++) v.set(2, y, 0, B.woodDark);
  for (let y = 2; y < len - 1; y++) {
    const wide = y % 3 === 0;
    v.set(1, y, 0, wide ? B.woodDark : B.sail);
    v.set(3, y, 0, wide ? B.woodDark : B.sail);
    if (y > 4 && y < len - 4) { v.set(0, y, 0, B.sail); v.set(4, y, 0, B.sail); }
  }
  v.set(2, len - 1, 0, B.woodDark);
  return prop('windmillBlade', v, [2.5, 0, 0.5]);
}

/** Deck cannon: tapered iron barrel, timber carriage, two wheels and a shot pile. */
export function cannon(rng, B, opts = {}) {
  const v = V(5, 6, 11);
  for (let z = 2; z < 10; z++) {
    const r = z < 4 ? 1.6 : z > 8 ? 1.5 : 1.2;
    discXZ(v, 3, 2, z, r, r, B.metalDark);
    discXZ(v, 4, 2, z, r * 0.7, r * 0.7, B.metalDark);
  }
  v.set(2, 3, 10, B.metal);
  v.fillBox(1, 1, 2, 3, 2, 8, B.plank);
  v.fillBox(1, 2, 2, 3, 2, 3, B.woodDark);
  for (const z of [3, 7]) {
    for (let k = 0; k < 3; k++) { v.set(0, k, z, B.woodDark); v.set(4, k, z, B.woodDark); }
    v.set(0, 1, z - 1, B.woodDark); v.set(4, 1, z - 1, B.woodDark);
    v.set(0, 1, z + 1, B.woodDark); v.set(4, 1, z + 1, B.woodDark);
  }
  v.set(2, 0, 1, B.metalDark); v.set(1, 0, 1, B.metalDark); v.set(3, 0, 1, B.metalDark);
  v.set(2, 1, 1, B.metalDark);
  return prop('cannon', v, [2.5, 0, 5.5]);
}

/** Gravestone: leaning slab with a rounded head, a carved band and grass at the foot. */
export function gravestone(rng, B, opts = {}) {
  const h = opts.height || rng.int(4, 6);
  const v = V(5, h + 1, 3);
  const tilt = rng.chance(0.5) ? 1 : 0;
  for (let y = 0; y < h; y++) {
    const x = 2 + (tilt && y > h - 3 ? 1 : 0);
    v.set(x - 1, y, 1, B.stone); v.set(x, y, 1, B.stone); v.set(x + 1, y, 1, B.stone);
  }
  const tx = 2 + tilt;
  v.set(tx, h, 1, B.stone);
  v.fillBox(tx - 1, Math.max(1, h - 3), 1, tx + 1, Math.max(1, h - 3), 1, B.stoneMossy);
  v.set(1, 0, 0, B.tuftGrass); v.set(3, 0, 2, B.tuftGrass);
  return prop('gravestone', v, [2.5, 0, 1.5]);
}

/**
 * Stone statue. @param {'guard'|'hero'|'kraken'|object} opts
 * All three share a plinth so they read as one set from a distance and differ in outline.
 */
export function statue(rng, B, opts = {}) {
  const pose = typeof opts === 'string' ? opts : (opts.pose || 'guard');
  const v = V(11, 20, 9);
  const cx = 5, cz = 4;
  v.fillBox(2, 0, 1, 8, 1, 7, B.stoneBrick);
  v.fillBox(3, 2, 2, 7, 2, 6, B.stone);
  const y0 = 3;

  if (pose === 'kraken') {
    blob(v, cx, y0 + 5, cz, 3.2, 3.6, 3.0, B.stone, rng, 0.16);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.4;
      let x = cx + Math.round(Math.cos(a) * 2), z = cz + Math.round(Math.sin(a) * 2), y = y0 + 3;
      for (let k = 0; k < 7; k++) {
        x += Math.round(Math.cos(a)); z += Math.round(Math.sin(a));
        y += k < 3 ? -1 : 1;
        v.set(x, Math.max(y0, y), z, B.stoneMossy);
      }
    }
    return prop('statue', v, [5.5, 0, 4.5]);
  }

  // Humanoid: plinth, legs, torso, head, and one arm raised clear of the body.
  v.fillBox(cx - 2, y0, cz - 1, cx - 1, y0 + 5, cz + 1, B.stone);
  v.fillBox(cx + 1, y0, cz - 1, cx + 2, y0 + 5, cz + 1, B.stone);
  v.fillBox(cx - 2, y0 + 6, cz - 1, cx + 2, y0 + 11, cz + 1, B.stone);
  v.fillBox(cx - 2, y0 + 9, cz - 1, cx + 2, y0 + 9, cz + 1, B.stoneMossy);
  v.fillBox(cx - 1, y0 + 12, cz - 1, cx + 1, y0 + 14, cz + 1, B.stone);
  if (pose === 'hero') {
    // Sword arm straight up: the tallest, simplest read in the prop set.
    v.fillBox(cx + 3, y0 + 8, cz, cx + 3, y0 + 13, cz, B.stone);
    v.fillBox(cx + 3, y0 + 14, cz, cx + 3, y0 + 16, cz, B.stoneMossy);
    v.fillBox(cx + 2, y0 + 14, cz, cx + 4, y0 + 14, cz, B.stoneMossy);
    v.fillBox(cx - 3, y0 + 6, cz, cx - 3, y0 + 11, cz, B.stone);
  } else {
    // Guard: both hands on a grounded spear, shoulders squared.
    v.fillBox(cx + 3, y0 + 7, cz, cx + 3, y0 + 11, cz, B.stone);
    v.fillBox(cx - 3, y0 + 7, cz, cx - 3, y0 + 11, cz, B.stone);
    v.fillBox(cx + 4, y0, cz, cx + 4, y0 + 15, cz, B.stone);
    v.fillBox(cx + 4, y0 + 16, cz, cx + 4, y0 + 17, cz, B.stoneMossy);
    v.fillBox(cx - 2, y0 + 15, cz - 1, cx + 2, y0 + 15, cz + 1, B.stoneMossy);
  }
  return prop('statue', v, [5.5, 0, 4.5]);
}

/** Ruined arch: two tapering legs, a stepped span and a broken chunk missing from one side. */
export function stoneArch(rng, B, opts = {}) {
  const span = opts.span || 11, h = opts.height || 12;
  const v = V(span, h, 5);
  const legW = 2;
  for (let y = 0; y < h - 4; y++) {
    for (let k = 0; k < legW; k++) {
      v.fillBox(k, y, 1, k, y, 3, B.stoneBrick);
      v.fillBox(span - 1 - k, y, 1, span - 1 - k, y, 3, B.stoneBrick);
    }
  }
  for (let k = 0; k < 4; k++) {
    const inset = legW + k;
    const y = h - 4 + k;
    v.fillBox(inset, y, 1, span - 1 - inset, y, 3, B.stoneBrick);
    v.fillBox(legW + k - 1, y, 1, legW + k - 1, y, 3, B.stoneBrick);
    v.fillBox(span - legW - k, y, 1, span - legW - k, y, 3, B.stoneBrick);
  }
  // Weathering: knock out a few blocks and moss the top course.
  for (let i = 0; i < 6; i++) v.set(rng.int(0, span - 1), rng.int(1, h - 5), rng.int(1, 3), 0);
  for (let x = 0; x < span; x++) if (rng.chance(0.5)) v.set(x, h - 1, 2, B.stoneMossy);
  return prop('stoneArch', v, [span / 2, 0, 2.5]);
}

/** Broken column: fluted shaft, snapped at an angle, with fallen drums at the base. */
export function ruinColumn(rng, B, opts = {}) {
  const h = opts.height || rng.int(7, 13);
  const v = V(7, h + 2, 7);
  const cx = 3, cz = 3;
  v.fillBox(cx - 2, 0, cz - 2, cx + 2, 0, cz + 2, B.stoneBrick);
  for (let y = 1; y < h; y++) {
    discXZ(v, y, cx, cz, 1.7, 1.7, B.stone);
    if (y % 4 === 0) discXZ(v, y, cx, cz, 1.9, 1.9, B.stoneBrick);
  }
  // Snapped top: shave one side away so the break reads at distance.
  const dir = rng.chance(0.5) ? 1 : -1;
  for (let k = 0; k < 3; k++) {
    for (let z = cz - 2; z <= cz + 2; z++) v.set(cx + dir * (2 - k), h - 1 - k, z, 0);
  }
  for (let i = 0; i < rng.int(1, 3); i++) {
    const a = rng.f() * Math.PI * 2;
    const x = cx + Math.round(Math.cos(a) * 2.4), z = cz + Math.round(Math.sin(a) * 2.4);
    v.set(x, 1, z, B.stoneMossy);
    v.set(x, 2, z, B.stone);
  }
  return prop('ruinColumn', v, [cx + 0.5, 0, cz + 0.5]);
}

/** Treasure heap: gold mound, scattered gems, a couple of coin stacks and a spilled chest. */
export function treasurePile(rng, B, opts = {}) {
  const r = opts.radius || rng.range(3.0, 4.5);
  const n = Math.ceil(r * 2) + 4;
  const v = V(n, 6, n);
  const cx = n / 2 - 0.5, cz = n / 2 - 0.5;
  blob(v, cx, 0.6, cz, r, r * 0.55, r, B.coin, rng, 0.30);
  blob(v, cx + rng.sym() * r * 0.5, 1.4, cz + rng.sym() * r * 0.5, r * 0.5, 0.9, r * 0.5, B.coin, rng, 0.30);
  for (let i = 0; i < rng.int(4, 8); i++) {
    const a = rng.f() * Math.PI * 2, d = rng.range(0, r);
    const x = Math.round(cx + Math.cos(a) * d), z = Math.round(cz + Math.sin(a) * d);
    const top = v.columnTop(x, z);
    if (top >= 0) v.set(x, top + 1, z, rng.chance(0.6) ? B.gem : B.gold);
  }
  for (let i = 0; i < 2; i++) {
    const x = Math.round(cx + rng.sym() * r), z = Math.round(cz + rng.sym() * r);
    column(v, x, z, 1, rng.int(2, 4), B.coin);
  }
  v.fillBox(1, 0, 1, 3, 1, 2, B.plank);
  v.fillBox(1, 2, 1, 3, 2, 1, B.woodDark);
  return prop('treasurePile', v, [n / 2, 0, n / 2]);
}

/** Bounty board: two posts, a plank board with a top rail, and pinned posters. */
export function bountyBoard(rng, B, opts = {}) {
  const w = 9, h = 10;
  const v = V(w, h, 3);
  column(v, 1, 1, 0, h - 2, B.woodDark);
  column(v, w - 2, 1, 0, h - 2, B.woodDark);
  v.fillBox(1, 3, 1, w - 2, h - 3, 1, B.plank);
  v.fillBox(0, h - 2, 1, w - 1, h - 2, 1, B.woodDark);
  v.fillBox(1, 3, 1, w - 2, 3, 1, B.woodDark);
  const slots = [[2, 4], [5, 4], [2, 7], [5, 7]];
  for (const [x, y] of slots) {
    if (!rng.chance(0.78)) continue;
    v.fillBox(x, y, 0, x + 1, y + 2, 0, B.poster);
    v.set(x, y + 2, 0, B.metalDark);
  }
  if (rng.chance(0.5)) v.fillBox(1, h - 3, 0, w - 2, h - 3, 0, B.banner);
  return prop('bountyBoard', v, [w / 2, 0, 1.5]);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Every prop builder, keyed by name. Stable order — tools iterate it. */
export const PROPS = {
  palmTree, jungleTree, pineTree, cherryTree, deadTree, cactus, giantMushroom,
  bush, fern, tallGrass, flowerPatch,
  rock, boulder, coralClump,
  crate, barrel, chest, ropeCoil, lantern, torch, campfire,
  tent, marketStall, fishingHut, dockPlanks, mooringPost, signpost, well, bellTower,
  windmillBlade, cannon, gravestone, statue, stoneArch, ruinColumn, treasurePile, bountyBoard,
};

export const PROP_NAMES = Object.keys(PROPS);

/**
 * Build a prop by name.
 * @param {string} name key of PROPS
 * @param {import('../core/rng.js').Rng} rng
 * @param {Record<string,number>} B block table from preparePropBlocks
 * @param {object|string|boolean} [opts] per-prop options (rock size, chest open, statue pose)
 */
export function buildProp(name, rng, B, opts) {
  const fn = PROPS[name];
  if (!fn) throw new Error('unknown prop: ' + name);
  return fn(rng, B, opts);
}

/**
 * Mesh a prop into up to two geometries: opaque blocks and alpha-tested cutout blocks
 * (foliage, flame). They need different materials, which is why they cannot share a draw.
 *
 * Vertices are emitted relative to the prop's anchor, so placing it is a single position set.
 *
 * @returns {{solid:import('three').BufferGeometry|null, cutout:import('three').BufferGeometry|null}}
 */
export function meshProp(p, reg, opts = {}) {
  const s = opts.scale || PROP_SCALE;
  const origin = [-p.anchor[0] * s, -p.anchor[1] * s, -p.anchor[2] * s];
  const mk = (cutoutOnly) => {
    const g = meshVolume(p.volume, reg, { scale: s, origin, ao: opts.ao !== false, cutoutOnly });
    return g.userData.triangles > 0 ? g : null;
  };
  return { solid: mk(false), cutout: mk(true) };
}
