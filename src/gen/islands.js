// The eight landmark islands of the Grand Line route, plus the minor-island generator.
//
// Every landmark is authored, not generated. The coastline is a list of points somebody
// placed; the landmark structure is built from explicit coordinates; the path network is
// drawn by hand from the dock to each point of interest. Noise only ever adds a few voxels
// of surface texture on top of an authored shape, and it is always faded out at the shore
// so the island's silhouette is exactly the one in the control points.
//
// Route runs west to east with rising difficulty, tier 1 at x = -7200 m through tier 5 at
// x = +7200 m. Each island answers two questions from 500 m out:
//   1. What shape is it?     (silhouette: crescent, massif, cone, wedding-cake, ...)
//   2. What is that thing?   (one unforgettable landmark breaking the skyline)
//
// build(canvas, rng, ctx) is a pure function. Same seed -> byte-identical voxels.

import { Rng } from '../core/rng.js';
import { clamp, lerp, TAU } from '../core/math.js';
import {
  IslandCanvas, islandDims, smoothLoop, pier, shipHull,
  VOXEL_M, SEA_FLOOR_VX, ISLAND_SIZE_M, ISLAND_SIZE_VX, ISLAND_MAX_HEIGHT_VX,
} from './islandbuild.js';

export { VOXEL_M, SEA_FLOOR_VX, ISLAND_SIZE_M, ISLAND_SIZE_VX, ISLAND_MAX_HEIGHT_VX, islandDims };

/** Metres per terrain voxel — restated here so consumers need only import islands.js. */
export const TERRAIN_VOXEL_M = VOXEL_M;

/** Named spawn points every landmark is required to publish. */
export const REQUIRED_SPAWNS = [
  'dock', 'plaza', 'boss_arena', 'vista', 'secret',
  'npc_1', 'npc_2', 'npc_3', 'npc_4',
  'chest_1', 'chest_2', 'chest_3',
];

/** Local-metre <-> voxel helpers bound to a canvas. Authoring is always done in metres. */
function axes(c) {
  return {
    X: (m) => c.cx + Math.round(m * 2),
    Z: (m) => c.cz + Math.round(m * 2),
    Y: (m) => c.seaLevel + Math.round(m * 2),
    V: (m) => Math.round(m * 2),
  };
}

/** Convert an authored metre polygon into a smoothed voxel-space coastline. */
function coast(c, ptsM, per = 5) {
  const { X, Z } = axes(c);
  return smoothLoop(ptsM.map((p) => [X(p[0]), Z(p[1])]), per);
}

// ---------------------------------------------------------------------------
// Shared landmark structures
// ---------------------------------------------------------------------------

/**
 * The leaning lighthouse. The shell tilts as it climbs and the lamp house is kicked out
 * further still, so the lean reads from the sea; the shaft bored through the shell stays
 * vertical, because a helical stair that also leans has to move sideways and upward on the
 * same tread, and a diagonal is not a step you can climb.
 */
function lighthouse(c, x, z, height, lean) {
  const B = c.B;
  const g = Math.max(1, c.groundY(x, z));
  const leanZ = Math.round(lean * 0.4);
  let topX = x, topZ = z;
  for (let i = 0; i <= height; i++) {
    const t = i / height;
    const r = lerp(6.2, 5.4, t);
    const ox = x + Math.round(lean * t * t);
    const oz = z + Math.round(leanZ * t * t);
    // Bands two metres deep: the classic read, and they give the tower a legible scale.
    c.disc(ox, oz, g + i, r, Math.floor(i / 4) % 2 === 0 ? B.stone : B.brick);
    if (i > 0) c.disc(x, z, g + i, 2.1, 0);
    if (i > 4 && i % 7 === 0) c.set(ox + Math.round(r), g + i, oz, B.glass);
    topX = ox; topZ = oz;
  }
  c.box(x - 1, g + 1, z + 2, x + 1, g + 3, z + 8, 0);        // doorway, out through the shell
  c.spiralStair(x, z, g + 1, g + height, 1, B.plank);

  // The lamp house overhangs a further two voxels in the direction of the lean.
  const lx = topX + 2, lz = topZ + 1;
  const ty = g + height;
  c.disc(lx, lz, ty + 1, 8.0, B.metalDark);                  // gallery deck
  c.box(x - 1, ty + 1, z - 1, x + 1, ty + 1, z + 1, 0);      // stair well, over the shaft
  c.ring(lx, lz, ty + 2, 7.6, B.metal, 1);                   // rail
  for (let a = 0; a < 4; a++) {
    const ang = (a / 4) * TAU + 0.78;
    c.colFill(Math.round(lx + Math.cos(ang) * 5), Math.round(lz + Math.sin(ang) * 5), ty + 2, ty + 6, B.metalDark);
  }
  c.ring(lx, lz, ty + 4, 5.0, B.glass, 1);
  c.ring(lx, lz, ty + 5, 5.0, B.glass, 1);
  c.cyl(lx, lz, ty + 4, ty + 5, 2.2, B.gold);                // the lamp itself
  c.disc(lx, lz, ty + 7, 8.0, B.metalDark);
  c.cone(lx, lz, ty + 8, ty + 14, 8.0, 0.6, B.metalDark);
  c.colFill(lx, lz, ty + 15, ty + 16, B.metal);
  c.hint('light', lx, ty + 5, lz, { tag: 'lighthouse', range: 220 });
  return { x: lx, z: lz, y: ty, deck: ty + 1, shaftX: x, shaftZ: z };
}

/** Gantry crane: lattice tower, counterweighted jib, hanging hook. */
function gantryCrane(c, x, z, height, jib, dir) {
  const B = c.B;
  const g = Math.max(1, c.groundY(x, z));
  c.lattice(x, z, g, g + height, 2, 2, B.metalDark, { brace: B.metal });
  const ty = g + height;
  c.box(x - 1, ty + 1, z - 1, x + 1, ty + 1, z + 1, B.metal);
  // Jib out over the water, short counter-jib behind, both braced from a mast.
  for (let i = 1; i <= jib; i++) {
    c.set(x + dir[0] * i, ty + 2, z + dir[1] * i, B.metalDark);
    if (i % 3 === 0) c.set(x + dir[0] * i, ty + 3, z + dir[1] * i, B.metal);
  }
  for (let i = 1; i <= 5; i++) c.set(x - dir[0] * i, ty + 2, z - dir[1] * i, B.metalDark);
  c.box(x - dir[0] * 6, ty + 1, z - dir[1] * 6, x - dir[0] * 5, ty + 3, z - dir[1] * 5, B.stone);
  c.colFill(x, z, ty + 2, ty + 7, B.metalDark);
  c.cable([x, ty + 7, z], [x + dir[0] * jib, ty + 3, z + dir[1] * jib], B.rope, 1);
  const hx = x + dir[0] * Math.round(jib * 0.75), hz = z + dir[1] * Math.round(jib * 0.75);
  for (let k = 1; k <= 6; k++) c.set(hx, ty + 2 - k, hz, B.rope);
  c.box(hx - 1, ty - 6, hz - 1, hx + 1, ty - 5, hz + 1, B.metalDark);
  c.hint('crane', x, ty, z, { tag: 'crane' });
}

/** Square bell tower with an open belfry and a hanging bell. */
function bellTower(c, x, z, height) {
  const B = c.B;
  const g = Math.max(1, c.groundY(x, z));
  c.box(x - 3, g, z - 3, x + 3, g + height, z + 3, B.stone);
  c.box(x - 2, g + 1, z - 2, x + 2, g + height, z + 2, 0);
  for (const s of [-3, 3]) {
    c.box(x + s, g + 4, z - 1, x + s, g + 6, z + 1, B.glass);
    c.box(x - 1, g + 4, z + s, x + 1, g + 6, z + s, B.glass);
  }
  c.box(x - 1, g + 1, z + 3, x + 1, g + 3, z + 3, 0);   // door
  // Spiral stair up the shaft: the belfry is the port's only high vantage point.
  c.spiralStair(x, z, g + 1, g + height + 1, 2, B.stone);
  const ty = g + height;
  c.box(x - 4, ty + 1, z - 4, x + 4, ty + 1, z + 4, B.stone);
  c.box(x - 2, ty + 1, z - 2, x + 2, ty + 1, z + 2, 0);   // stair well into the belfry
  for (const [ax, az] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) c.colFill(x + ax, z + az, ty + 2, ty + 7, B.stone);
  c.box(x - 4, ty + 8, z - 4, x + 4, ty + 8, z + 4, B.metalDark);
  c.cone(x, z, ty + 9, ty + 14, 4.5, 0.6, B.metalDark);
  c.sphere(x, ty + 5, z, 2.4, B.gold, { squash: 1.15 });   // the bell
  c.colFill(x, z, ty + 6, ty + 7, B.metalDark);
  c.hint('bell', x, ty + 5, z, { tag: 'bell', range: 400 });
  return ty + 2;
}

/** Lattice pylon carrying a cable-car line, with a docked cabin at the lower station. */
function cableTower(c, x, z, height, withCabin) {
  const B = c.B;
  const g = Math.max(1, c.groundY(x, z));
  c.lattice(x, z, g, g + height, 2, 1, B.woodDark, { brace: B.metal });
  const ty = g + height;
  c.box(x - 2, ty + 1, z - 2, x + 2, ty + 1, z + 2, B.metalDark);
  c.colFill(x, z, ty + 2, ty + 3, B.metal);
  if (withCabin) {
    c.box(x - 2, ty - 5, z - 2, x + 2, ty - 1, z + 2, B.plank);
    c.box(x - 1, ty - 4, z - 1, x + 1, ty - 2, z + 1, 0);
    c.box(x - 2, ty - 3, z - 2, x - 2, ty - 3, z + 2, B.glass);
    c.box(x + 2, ty - 3, z - 2, x + 2, ty - 3, z + 2, B.glass);
    c.colFill(x, z, ty, ty + 1, B.metalDark);
  }
  return { x, z, y: ty + 3 };
}

/** Tiered pagoda with flared eaves and a finial. The blossom island's skyline. */
function pagodaTower(c, x, z, tiers, baseW) {
  const B = c.B;
  const g = Math.max(1, c.groundY(x, z));
  let y = g;
  let w = baseW;
  for (let t = 0; t < tiers; t++) {
    const h = t === 0 ? 6 : 4;
    c.box(x - w, y, z - w, x + w, y + h, z + w, B.plank);
    c.box(x - w + 1, y + 1, z - w + 1, x + w - 1, y + h, z + w - 1, 0);
    for (const [ax, az] of [[-w, -w], [w, -w], [-w, w], [w, w]]) c.colFill(x + ax, z + az, y + 1, y + h, B.flagRed);
    // Windows on every face so the tower is not a blank box at any angle.
    c.box(x - w + 2, y + 2, z - w, x + w - 2, y + 3, z - w, B.paper);
    c.box(x - w + 2, y + 2, z + w, x + w - 2, y + 3, z + w, B.paper);
    c.box(x - w, y + 2, z - w + 2, x - w, y + 3, z + w - 2, B.paper);
    c.box(x + w, y + 2, z - w + 2, x + w, y + 3, z + w - 2, B.paper);
    // Eaves: two overhanging slabs, the wider one darker, reading as a curved roof.
    c.box(x - w - 3, y + h + 1, z - w - 3, x + w + 3, y + h + 1, z + w + 3, B.roof);
    c.box(x - w - 2, y + h + 2, z - w - 2, x + w + 2, y + h + 2, z + w + 2, B.roof);
    for (const [ax, az] of [[-w - 3, -w - 3], [w + 3, -w - 3], [-w - 3, w + 3], [w + 3, w + 3]]) {
      c.set(x + ax, y + h + 2, z + az, B.gold);
    }
    y += h + 3;
    w = Math.max(2, w - 1);
  }
  c.colFill(x, z, y, y + 4, B.gold);
  c.set(x, y + 5, z, B.gold);
  c.hint('landmark', x, y, z, { tag: 'pagoda' });
  return y + 5;
}

/** Curved fortress wall with crenellations and a wall-walk you can actually stand on. */
function wallArc(c, cx, cz, r, a0, a1, yBase, height, thick, block, opts = {}) {
  const B = c.B;
  const steps = Math.ceil(Math.abs(a1 - a0) * r) + 8;
  const merlon = opts.merlon !== undefined ? opts.merlon : block;
  for (let i = 0; i <= steps; i++) {
    const a = lerp(a0, a1, i / steps);
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let t = -thick; t <= thick; t++) {
      const px = Math.round(cx + ca * (r + t)), pz = Math.round(cz + sa * (r + t));
      const g = c.groundY(px, pz);
      c.colFill(px, pz, g > 0 ? Math.min(g, yBase) : 1, yBase + height, block);
      if (t === -thick || t === thick) {
        if (i % 4 < 2) c.colFill(px, pz, yBase + height + 1, yBase + height + 2, merlon);
      } else {
        c.set(px, yBase + height, pz, opts.walk !== undefined ? opts.walk : block);
      }
      if (c.inCol(px, pz)) c.gh[pz * c.sx + px] = yBase + height;
    }
  }
}

/** Standing stones in a ring — reads as an arena boundary without walling the player in. */
function standingStones(c, cx, cz, r, n, rng, block) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + 0.2;
    const x = Math.round(cx + Math.cos(a) * r), z = Math.round(cz + Math.sin(a) * r);
    const g = c.groundY(x, z);
    if (g < 1) continue;
    const h = 5 + rng.int(0, 4);
    const lean = rng.int(-1, 1);
    c.cone(x, z, g, g + h, 1.6, 0.9, block, { lean: [lean, rng.int(-1, 1)] });
  }
}

/** Vertical falling-water column with a splash pool and spray blocks at the base. */
function waterfall(c, x, z, yTop, yBottom, width) {
  const W = c.WATER;
  const B = c.B;
  for (let dz = -width; dz <= width; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      c.colFill(x + dx, z + dz, yBottom, yTop, W);
    }
  }
  for (let dz = -width - 2; dz <= width + 2; dz++) {
    for (let dx = -3; dx <= 3; dx++) {
      if (Math.abs(dz) <= width && Math.abs(dx) <= 1) continue;
      if (Math.abs(dx) + Math.abs(dz) > width + 4) continue;
      c.setAir(x + dx, yBottom, z + dz, W);
      if ((dx + dz) % 3 === 0) c.setAir(x + dx, yBottom + 1, z + dz, B.sail);
    }
  }
  c.hint('waterfall', x, yTop, z, { tag: 'waterfall', height: yTop - yBottom });
}

/** Rope-and-plank suspension bridge between two canopy platforms. */
function ropeBridge(c, a, b, y, width) {
  const B = c.B;
  const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const half = (width - 1) / 2;
  const dx = (b[0] - a[0]) / n, dz = (b[1] - a[1]) / n;
  const len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len, nz = dx / len;
  for (let i = 0; i <= n; i++) {
    const sag = Math.round(Math.sin((i / n) * Math.PI) * 2);
    const px = a[0] + dx * i, pz = a[1] + dz * i;
    for (let w = -half; w <= half; w++) {
      c.set(Math.round(px + nx * w), y - sag, Math.round(pz + nz * w), B.plank);
    }
    for (const s of [-1, 1]) {
      c.set(Math.round(px + nx * s * (half + 1)), y - sag + 1, Math.round(pz + nz * s * (half + 1)), B.rope);
      if (i % 4 === 0) c.set(Math.round(px + nx * s * (half + 1)), y - sag, Math.round(pz + nz * s * (half + 1)), B.rope);
    }
  }
}

/** Canopy platform: a plank disc with a rail, sitting in the top of a big tree. */
function canopyDeck(c, x, z, y, r) {
  const B = c.B;
  c.disc(x, z, y, r, B.plank);
  c.ring(x, z, y + 1, r - 0.4, B.rope, 1);
  for (let k = 1; k <= 4; k++) c.set(x, y - k, z, B.wood);
}

/** A shallow flat-bottomed rowing boat, hauled up on a beach or moored at a pier. */
function rowBoat(c, x, z, y, dir, rng) {
  const B = c.B;
  const len = 7 + rng.int(0, 2);
  for (let i = 0; i < len; i++) {
    const wid = i === 0 || i === len - 1 ? 0 : 1;
    for (let w = -wid; w <= wid; w++) {
      const px = dir === 0 ? x + i : x + w, pz = dir === 0 ? z + w : z + i;
      c.set(px, y, pz, B.plank);
      if (Math.abs(w) === wid && wid > 0) c.set(px, y + 1, pz, B.woodDark);
    }
  }
  const ox = dir === 0 ? x + 2 : x + 1, oz = dir === 0 ? z + 1 : z + 2;
  c.set(ox, y + 1, oz, B.wood);
}

// ---------------------------------------------------------------------------
// 1. Shells Cove — starter fishing village
// ---------------------------------------------------------------------------

function buildShellsCove(c, rng) {
  const B = c.B;
  const { X, Z, Y, V } = axes(c);

  // Crescent: a full body to the north, with the bay biting deep in from the south.
  const shore = coast(c, [
    [0, -56], [26, -50], [44, -32], [54, -8], [52, 18], [40, 37],
    [27, 46], [17, 33], [5, 26], [-8, 24], [-20, 30], [-29, 42],
    [-41, 36], [-50, 17], [-56, -8], [-46, -34], [-24, -52],
  ]);
  c.heightmapFromPolygon(shore, {
    peak: V(9), edge: 2, reach: V(26), shelf: V(15), profile: 'dome', noise: 2.6, noiseScale: 0.028,
    fill: B.rock, soil: B.dirt, soilDepth: 3, surface: B.grass, seedTag: 3,
  });

  // The headland: a rocky finger on the east that the lighthouse stands on.
  c.ridge([X(30), Z(-24)], [X(48), Z(-6)], [V(9), V(15)], V(11), {
    fill: B.rock, surface: B.rock, falloff: 'shoulder',
  });
  // Two low dune spines behind the beach — the only relief in the village.
  c.ridge([X(-38), Z(-14)], [X(-8), Z(-26)], V(7), V(9), { fill: B.rock, soil: B.dirt, soilDepth: 3, surface: B.grass });
  c.ridge([X(6), Z(-38)], [X(30), Z(-40)], V(8), V(10), { fill: B.rock, soil: B.dirt, soilDepth: 3, surface: B.grass });

  c.beach(6, { depth: 3, jitter: 2.4 });
  c.paint((x, z, y, i) => {
    if (i.slope >= 3 && i.hM > 2.5) return B.rock;
    if (i.hM > 7.5) return [B.grassDry, B.dirt];
    return undefined;
  });

  // Village terrace and plaza. Flat ground is what makes a settlement read as built.
  const px = X(-8), pz = Z(2), py = Y(4.5);
  c.plateau(px, pz, V(13), py, { blend: V(5), surface: B.grass, soil: B.dirt, fill: B.rock });
  c.disc(px, pz, py, V(4.5), B.stone);
  c.ring(px, pz, py, V(4.5), B.stoneBrick, 1);
  // The well: the visual centre of the plaza.
  c.cyl(px, pz, py, py + 2, 2.4, B.stone, { hollow: true, thick: 1 });
  c.colFill(px, pz, py, py + 1, 0);
  for (const s of [-2, 2]) c.colFill(px + s, pz, py + 3, py + 5, B.woodDark);
  c.box(px - 2, py + 6, pz - 1, px + 2, py + 6, pz + 1, B.thatch);
  c.set(px, py + 5, pz, B.rope);

  const homes = c.town(rng, [
    { x: X(-22), z: Z(-4), w: 9, d: 8, h: 5, doorSide: 0, chimney: true },
    { x: X(-20), z: Z(8), w: 8, d: 8, h: 4, doorSide: 0 },
    { x: X(-2), z: Z(-10), w: 10, d: 8, h: 5, doorSide: 2 },
    { x: X(4), z: Z(6), w: 9, d: 9, h: 5, doorSide: 1, chimney: true },
    { x: X(-4), z: Z(14), w: 8, d: 7, h: 4, doorSide: 3, style: 'shack' },
    { x: X(12), z: Z(-2), w: 11, d: 8, h: 6, doorSide: 1, banner: B.flagRed },
    { x: X(14), z: Z(12), w: 8, d: 8, h: 4, doorSide: 3, style: 'shack' },
  ], 'cottage', { lantern: B.gold });

  // Fish-drying racks and net frames along the bay front: the island's whole economy.
  for (let i = 0; i < 6; i++) {
    const rx = X(-17 + i * 5), rz = Z(21);
    const g = c.groundY(rx, rz);
    if (g < 1) continue;
    c.colFill(rx, rz, g + 1, g + 4, B.woodDark);
    c.colFill(rx + 3, rz, g + 1, g + 4, B.woodDark);
    for (let k = 0; k <= 3; k++) c.set(rx + k, g + 4, rz, B.rope);
    if (i % 2 === 0) for (let k = 1; k < 3; k++) c.set(rx + k, g + 3, rz, B.sailShade);
  }

  // The dock. Ships arrive from the south, into the shelter of the crescent.
  const dockDeck = pier(c, [X(-4), Z(23)], [X(-4), Z(40)], 5, { deckY: Y(1.5), post: B.woodDark });
  for (const dz of [26, 32, 38]) {
    c.colFill(X(-8), Z(dz), dockDeck, dockDeck + 3, B.woodDark);
    c.set(X(-8), dockDeck + 4, Z(dz), B.gold);
  }
  rowBoat(c, X(1), Z(30), dockDeck, 1, rng);

  // Path network — dock to plaza to every point of interest.
  c.path([[X(-4), Z(24)], [X(-5), Z(16)], [px, pz + V(6)]], 5, B.plank, { headroom: 5 });
  c.path([[px + V(3), pz], [X(10), Z(0)], [X(26), Z(-8)], [X(38), Z(-13)], [X(45), Z(-6)], [X(45), Z(-2)]],
    4, B.stone, { edge: B.stoneBrick, maxStep: 1 });
  c.path([[px, pz - V(4)], [X(-14), Z(-14)], [X(-26), Z(-22)], [X(-34), Z(-28)]], 4, B.dirt);
  c.path([[px - V(6), pz + V(3)], [X(-24), Z(18)], [X(-32), Z(26)]], 3, B.sand);

  // Lighthouse last on the headland, so the road is laid under it rather than cut through
  // it: a path levels ground and clears headroom, and it does not know about towers.
  const lh = lighthouse(c, X(45), Z(-9), 28, 3);

  // Boss arena: a bandit camp on the western spit, ringed with standing stones.
  const bx = X(-34), bz = Z(28);
  c.plateau(bx, bz, V(11), Y(2.5), { blend: V(5), surface: B.sand, soil: B.sand, fill: B.rock });
  standingStones(c, bx, bz, V(9), 8, rng, B.rock);
  c.building(bx - V(9), bz - V(3), 8, 7, 4, 'tent', { doorSide: 0 });
  for (let i = 0; i < 5; i++) {
    const cx2 = bx + rng.int(-7, 7), cz2 = bz + rng.int(-7, 7);
    const g = c.groundY(cx2, cz2);
    if (g > 0) c.colFill(cx2, cz2, g + 1, g + 1 + rng.int(0, 1), B.barrel);
  }
  c.disc(bx + V(3), bz + V(2), c.groundY(bx + V(3), bz + V(2)) + 1, 1.6, B.ash);   // the camp fire pit

  // Secret: a sea cave under the headland, entered from the eastern shingle.
  c.cave([
    [X(53), Y(1.5), Z(4)], [X(48), Y(2.5), Z(-1)], [X(43), Y(3.5), Z(-6)], [X(41), Y(4), Z(-12)],
  ], [3.2, 4.6], { floor: B.sand });
  c.colFill(X(41), Z(-12), Y(3.6), Y(4.6), B.gold);

  // Vegetation: palms on the beach ring, tussock grass inland.
  const offTower = (x, z) => Math.hypot(x - X(45), z - Z(-9)) > 12;
  c.scatter(rng, { cx: c.cx, cz: c.cz, r: V(56), spacing: 7, filter: offTower }, 0.55, (x, z, y, r) => {
    const hM = (y - c.seaLevel) * VOXEL_M;
    const b = c.get(x, y, z);
    if (hM < 0.6 || hM > 9) return;
    if (b === B.sand || b === B.sandWet) c.tree(x, z, 'palm', r);
    else if (b === B.grass && r.chance(0.35)) c.tree(x, z, 'dead', r, { scale: 0.7 });
  });

  c.mark('dock', X(-4), Z(38), { y: dockDeck + 1, yaw: 0 });
  c.mark('plaza', px, pz + V(6), { y: py + 1 });
  c.mark('boss_arena', bx, bz, { y: c.groundY(bx, bz) + 1 });
  c.mark('vista', lh.x + 6, lh.z, { y: lh.deck + 1 });
  c.mark('secret', X(41), Z(-12), { y: Y(3.6) });
  c.mark('npc_1', X(-6), Z(17));
  c.mark('npc_2', px + V(5), pz - V(3));
  c.mark('npc_3', X(18), Z(-3));
  c.mark('npc_4', X(-4), Z(30), { y: dockDeck + 1 });
  c.mark('chest_1', lh.x + 1, lh.z + 6, { y: lh.deck + 1 });
  c.mark('chest_2', X(41), Z(-12), { y: Y(3.6) });
  c.mark('chest_3', bx + 6, bz - 6);
}

// ---------------------------------------------------------------------------
// 2. Palm Reach — jungle, three-tier waterfall, canopy bridges
// ---------------------------------------------------------------------------

function buildPalmReach(c, rng) {
  const B = c.B;
  const { X, Z, Y, V } = axes(c);

  const shore = coast(c, [
    [4, -62], [34, -54], [54, -30], [62, 0], [54, 26], [34, 44],
    [16, 52], [4, 44], [-6, 50], [-24, 52], [-42, 40], [-56, 16],
    [-58, -14], [-44, -42], [-20, -58],
  ]);
  c.heightmapFromPolygon(shore, {
    peak: V(10), edge: 2, reach: V(22), shelf: V(14), profile: 'shoulder', noise: 3, noiseScale: 0.03,
    fill: B.rock, soil: B.dirt, soilDepth: 3, surface: B.jungle, seedTag: 7,
  });

  // The massif: three stacked plateaus stepping up to the north. Each one is a hand-set
  // height, which is why the waterfall lands where it is supposed to.
  const tierY = [Y(7), Y(15), Y(23)];
  c.plateau(X(-2), Z(-14), V(30), tierY[0], { blend: V(9), surface: B.jungle, soil: B.dirt, fill: B.rock, shape: 'disc' });
  c.plateau(X(0), Z(-26), V(22), tierY[1], { blend: V(7), surface: B.jungle, soil: B.dirt, fill: B.rock });
  c.plateau(X(2), Z(-38), V(15), tierY[2], { blend: V(5), surface: B.jungle, soil: B.dirt, fill: B.rock });
  c.ridge([X(-26), Z(-44)], [X(26), Z(-46)], V(24), V(14), { fill: B.rock, surface: B.rock, falloff: 'dome' });

  // The lagoon: carved below sea level and opened to the sea, so the ocean fills it.
  c.crater(X(0), Z(28), V(17), V(9), { rim: 0, surface: B.sand, soil: B.sand, fill: B.rock, floorFlat: 0.4 });
  c.carveRiver([[X(0), Z(30)], [X(2), Z(44)], [X(4), Z(56)]], V(9), { depth: V(5), bed: B.sand, bankBlock: B.rock });

  c.beach(5, { depth: 3, jitter: 2.2 });
  c.paint((x, z, y, i) => {
    if (i.slope >= 4 && i.hM > 3) return B.rock;
    if (i.hM > 1.2 && i.hM < 16 && i.slope < 3) return B.jungle;
    return undefined;
  });

  // Three-tier waterfall down the front of the massif into the lagoon.
  const wx = X(2);
  const notch = [[Z(-34), tierY[2], tierY[1]], [Z(-22), tierY[1], tierY[0]], [Z(-8), tierY[0], Y(0)]];
  for (const [nz, yTop, yBot] of notch) {
    c.carveRiver([[wx, nz - V(3)], [wx, nz + V(4)]], V(4), { depth: 3, bed: B.rock, bankBlock: B.rock });
    waterfall(c, wx, nz + V(4), yTop, yBot + 1, 3);
    // Plunge pool at the foot of each drop.
    c.disc(wx, nz + V(6), yBot + 1, V(3.5), c.WATER);
    c.ring(wx, nz + V(6), yBot, V(4), B.rock, 1);
  }
  // The stream continues across the lower terrace and out into the lagoon.
  c.carveRiver([[wx, Z(-4)], [X(1), Z(8)], [X(0), Z(20)]], V(5), {
    depth: V(2), fill: c.WATER, bed: B.sand, bankBlock: B.rock,
  });

  // Cave behind the top fall: you walk through the water to reach it.
  c.cave([
    [wx, Y(24), Z(-32)], [wx, Y(24.5), Z(-40)], [X(-5), Y(25), Z(-46)], [X(-12), Y(25), Z(-48)],
  ], [4, 6], { floor: B.rock });
  c.disc(X(-12), Z(-48), Y(24.4), 5, B.stone);
  c.colFill(X(-12), Z(-48), Y(25), Y(26), B.gold);

  // Three giant trees carrying the canopy bridge network.
  const bigTrees = [[X(-24), Z(-6)], [X(-6), Z(10)], [X(20), Z(-2)], [X(28), Z(-22)]];
  const deckY = [];
  for (const [tx, tz] of bigTrees) {
    const g = c.groundY(tx, tz);
    c.cyl(tx, tz, g, g + 26, 2.4, B.wood);
    for (const [ax, az] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) {
      c.colFill(tx + ax, tz + az, g, g + 3, B.wood);
      c.set(tx + Math.sign(ax) * 2, g + 4, tz + Math.sign(az) * 2, B.wood);
    }
    c.sphere(tx, g + 30, tz, 9, B.leaves, { squash: 0.55 });
    c.sphere(tx, g + 26, tz, 7, B.leaves, { squash: 0.6 });
    const dy = g + 22;
    canopyDeck(c, tx, tz, dy, 5);
    deckY.push(dy);
    // Ladder up the trunk so the network is reachable without the bridges.
    for (let k = 1; k <= 22; k++) c.set(tx + 3, g + k, tz, B.rope);
  }
  for (let i = 0; i < bigTrees.length - 1; i++) {
    ropeBridge(c, bigTrees[i], bigTrees[i + 1], Math.min(deckY[i], deckY[i + 1]), 3);
  }
  ropeBridge(c, bigTrees[3], [X(14), Z(-34)], deckY[3], 3);
  canopyDeck(c, X(14), Z(-34), deckY[3], 4);

  // Explorers' camp on the lower terrace.
  c.plateau(X(-20), Z(-16), V(9), tierY[0], { blend: V(4), surface: B.dirt, soil: B.dirt, fill: B.rock });
  c.town(rng, [
    { x: X(-24), z: Z(-20), w: 8, d: 7, h: 4, style: 'tent', doorSide: 2 },
    { x: X(-16), z: Z(-19), w: 7, d: 7, h: 4, style: 'tent', doorSide: 2 },
    { x: X(-21), z: Z(-12), w: 9, d: 7, h: 4, style: 'shack', doorSide: 3 },
  ], 'tent');
  c.disc(X(-19), Z(-15), tierY[0] + 1, 2, B.ash);

  // The dock is inside the lagoon: ships come up the channel and moor on its western shore.
  const dockDeck = pier(c, [X(-20), Z(27)], [X(-9), Z(27)], 5, { deckY: Y(1.5), post: B.woodDark });
  // The shore clearing beside it — flat sand ringed by jungle. This is the arena.
  c.plateau(X(-27), Z(23), V(11), Y(1.5), { blend: V(6), surface: B.sand, soil: B.sand, fill: B.rock });

  // One long climb from the lagoon up past the falls to the top terrace. It is a single
  // `path` call because the slope limiter only guarantees walkability end to end.
  c.path([[X(-21), Z(27)], [X(-27), Z(23)], [X(-29), Z(15)]], 4, B.sand, { maxStep: 1 });
  c.path([
    [X(-29), Z(15)], [X(-23), Z(7)], [X(-15), Z(1)], [X(-13), Z(-9)],
    [X(-15), Z(-19)], [X(-9), Z(-25)], [X(-5), Z(-33)], [X(0), Z(-40)],
  ], 4, B.dirt, { maxStep: 1 });
  c.path([[X(-15), Z(-19)], [X(-18), Z(-17)], [X(-20), Z(-16)]], 3, B.dirt, { maxStep: 1 });
  c.path([[X(0), Z(-40)], [X(-8), Z(-43)], [X(-14), Z(-46)]], 3, B.dirt, { maxStep: 1 });

  // Jungle cover, thinning near the shore so the beach silhouette stays clean.
  const clearing = (x, z) => Math.hypot(x - X(-27), z - Z(23)) > V(14);
  c.scatter(rng, { cx: c.cx, cz: c.cz, r: V(58), spacing: 6, filter: clearing }, 0.72, (x, z, y, r) => {
    const hM = (y - c.seaLevel) * VOXEL_M;
    const b = c.get(x, y, z);
    if (b === B.sand || b === B.sandWet) { if (r.chance(0.4)) c.tree(x, z, 'palm', r); return; }
    if (b !== B.jungle || hM < 1) return;
    const k = r.f();
    if (k < 0.62) c.tree(x, z, 'jungle', r);
    else if (k < 0.82) c.tree(x, z, 'palm', r);
    else if (k < 0.92) { c.colFill(x, z, y + 1, y + 1 + r.int(1, 3), B.mushroomStem); c.sphere(x, y + 4, z, 2.2, B.mushroomCap, { squash: 0.6 }); }
  });

  c.mark('dock', X(-11), Z(27), { y: dockDeck + 1, yaw: Math.PI * 0.5 });
  c.mark('plaza', X(-20), Z(-16));
  c.mark('boss_arena', X(-27), Z(23));
  c.mark('vista', X(0), Z(-40));
  c.mark('secret', X(-12), Z(-48), { y: Y(24.5) });
  c.mark('npc_1', X(-16), Z(27), { y: dockDeck + 1 });
  c.mark('npc_2', X(-21), Z(-14));
  c.mark('npc_3', X(-28), Z(19));
  c.mark('npc_4', X(-14), Z(-2));
  c.mark('chest_1', X(-12), Z(-48), { y: Y(24.5) });
  c.mark('chest_2', bigTrees[2][0], bigTrees[2][1], { y: deckY[2] + 1 });
  c.mark('chest_3', X(-2), Z(-40));
}

// ---------------------------------------------------------------------------
// 3. Cog Harbour — industrial port on stilts
// ---------------------------------------------------------------------------

function buildCogHarbour(c, rng) {
  const B = c.B;
  const { X, Z, Y, V } = axes(c);

  // Deliberately angular coastline: this island was cut, not eroded.
  const shore = coast(c, [
    [-46, -50], [0, -56], [40, -46], [58, -18], [56, 10], [40, 30],
    [10, 40], [-14, 36], [-38, 28], [-56, 4], [-58, -26],
  ], 3);
  c.heightmapFromPolygon(shore, {
    peak: V(11), edge: 3, reach: V(16), shelf: V(13), profile: 'mesa', noise: 1.6, noiseScale: 0.04,
    fill: B.rock, soil: B.rock, soilDepth: 2, surface: B.stone, seedTag: 13,
  });
  c.plateau(X(-4), Z(-10), V(34), Y(6), { blend: V(10), surface: B.stone, soil: B.rock, fill: B.rock });

  c.beach(3, { depth: 2, jitter: 1.6 });
  c.paint((x, z, y, i) => {
    if (i.hM > 1.5 && i.slope < 2) return B.stone;
    if (i.slope >= 3) return B.rock;
    return undefined;
  });

  // The drydock: a rectangular cut below sea level with a half-built hull in it.
  const dx0 = X(14), dz0 = Z(2);
  c.plateau(dx0, dz0, V(13), Y(-3.5), { shape: 'rect', rz: V(9), blend: 2, surface: B.stone, soil: B.rock, fill: B.rock });
  c.box(X(14) - V(13), Y(-3), Z(2) - V(9), X(14) + V(13), Y(7), Z(2) + V(9), 0);
  c.box(X(14) - V(13), Y(-3.5), Z(2) - V(9), X(14) + V(13), Y(-3.5), Z(2) + V(9), B.stone);
  // Stepped dock walls, so the pit reads as engineered and is climbable.
  for (let s = 0; s < 4; s++) {
    c.boxShell(dx0 - V(13) + s, Y(-3) + s * 2, dz0 - V(9) + s, dx0 + V(13) - s, Y(-3) + s * 2 + 1, dz0 + V(9) - s, B.stone, 1);
  }
  c.carveRiver([[X(28), Z(2)], [X(46), Z(6)], [X(60), Z(10)]], V(9), { depth: V(5), bed: B.stone, bankBlock: B.stone });
  shipHull(c, dx0 - V(11), dz0, V(22), V(11), Y(-2), { ribsOnly: true, hull: B.plank, rib: B.woodDark, mast: 0 });
  // Scaffolding around the hull.
  for (let i = 0; i < 5; i++) {
    const sx = dx0 - V(10) + i * V(5);
    c.lattice(sx, dz0 - V(7), Y(-3), Y(3), 1, 1, B.woodDark, { brace: B.plank });
    c.lattice(sx, dz0 + V(7), Y(-3), Y(3), 1, 1, B.woodDark, { brace: B.plank });
  }
  c.hint('drydock', dx0, Y(-3), dz0, { tag: 'drydock' });

  // Stilt district: a plank deck out over the shallow water on the south shore.
  const deckY = Y(3);
  c.deck(X(-40), Z(20), X(-6), Z(44), deckY, B.plank, { post: B.woodDark, spacing: 4 });
  for (let x = X(-40); x <= X(-6); x += 1) c.set(x, deckY + 1, Z(44), B.rope);
  c.town(rng, [
    { x: X(-38), z: Z(23), w: 11, d: 9, h: 6, style: 'stilt', doorSide: 2, baseY: deckY + 1 },
    { x: X(-24), z: Z(23), w: 12, d: 9, h: 7, style: 'stilt', doorSide: 2, baseY: deckY + 1 },
    { x: X(-36), z: Z(34), w: 10, d: 8, h: 5, style: 'stilt', doorSide: 3, baseY: deckY + 1 },
    { x: X(-22), z: Z(34), w: 11, d: 8, h: 6, style: 'stilt', doorSide: 3, baseY: deckY + 1 },
  ], 'stilt', { props: false });

  // Warehouse row and the works yard on the plateau.
  c.town(rng, [
    { x: X(-30), z: Z(-6), w: 16, d: 11, h: 7, style: 'warehouse', doorSide: 2 },
    { x: X(-10), z: Z(-8), w: 14, d: 11, h: 8, style: 'warehouse', doorSide: 2, banner: B.flagRed },
    { x: X(-28), z: Z(-24), w: 13, d: 10, h: 6, style: 'warehouse', doorSide: 3 },
    { x: X(-8), z: Z(-26), w: 12, d: 10, h: 6, style: 'forge', doorSide: 3, chimney: true },
    { x: X(8), z: Z(-24), w: 10, d: 9, h: 5, style: 'forge', doorSide: 3, chimney: true },
  ], 'warehouse', { lantern: B.gold });

  // Boilers and pipework — the machinery that makes the port feel powered.
  for (let i = 0; i < 3; i++) {
    const bx = X(24) + i * 7, bz = Z(-30);
    const g = c.groundY(bx, bz);
    c.cyl(bx, bz, g + 1, g + 9, 3.2, B.metal);
    c.cyl(bx, bz, g + 10, g + 14, 1.4, B.metalDark);
    c.ring(bx, bz, g + 5, 3.6, B.metalDark, 1);
    for (let k = 0; k < 6; k++) c.set(bx + 4, g + 3, bz + k, B.metalDark);
    c.hint('smoke', bx, g + 14, bz, { tag: 'smokestack' });
  }
  // Coal heaps.
  for (let i = 0; i < 3; i++) {
    const hx = X(30) + rng.int(-3, 3), hz = Z(-14) + i * 8;
    const g = c.groundY(hx, hz);
    c.sphere(hx, g + 1, hz, 3.4, B.ash, { hemisphere: true, squash: 0.55 });
  }

  // Three cranes on the quay: the silhouette read from the sea.
  gantryCrane(c, X(2), Z(24), 26, 16, [0, 1]);
  gantryCrane(c, X(20), Z(20), 30, 18, [0, 1]);
  gantryCrane(c, X(34), Z(-4), 24, 14, [1, 0]);

  const belfryY = bellTower(c, X(-2), Z(-40), 22);

  // Quays: hard stone edges all along the working waterfront.
  c.path([[X(-6), Z(18)], [X(20), Z(16)], [X(38), Z(4)]], 6, B.stone, { edge: B.stoneBrick });
  c.path([[X(-2), Z(16)], [X(-4), Z(-2)], [X(-2), Z(-20)], [X(-2), Z(-34)]], 6, B.stone, { edge: B.stoneBrick });
  c.path([[X(-20), Z(16)], [X(-24), Z(0)], [X(-26), Z(-16)]], 5, B.stone, { edge: B.stoneBrick });
  c.path([[X(-8), Z(21)], [X(-16), Z(23)], [X(-24), Z(24)]], 4, B.plank, { bridge: true, deckY, post: B.woodDark });
  c.path([[X(-2), Z(-34)], [X(-2), Z(-37)]], 4, B.stone, { edge: B.stoneBrick });
  c.stairs([X(-8), Y(6), Z(13)], [X(-8), deckY, Z(21)], 5, B.stone, { headroom: 9 });  // quay to the stilt deck
  c.stairs([X(14), Y(6), Z(-18)], [X(14), Y(-2.5), Z(-3)], 5, B.stone);   // ramp into the drydock

  // The harbour apron: the plateau is cut back down to the waterline here, because a port
  // whose quay stands eighteen metres above the sea is a cliff, not a port.
  c.plateau(X(46), Z(18), V(11), Y(3), { blend: V(7), surface: B.stone, soil: B.rock, fill: B.rock });
  c.path([[X(20), Z(16)], [X(34), Z(12)], [X(44), Z(16)], [X(47), Z(20)]], 6, B.stone,
    { edge: B.stoneBrick, maxStep: 1 });
  const dock = pier(c, [X(48), Z(22)], [X(58), Z(30)], 6, { deckY: Y(3), post: B.metalDark, deck: B.plank });
  for (let i = 0; i < 4; i++) c.colFill(X(43) + i * 3, Z(23), Y(3) + 1, Y(3) + 2, B.barrel);

  c.mark('dock', X(57), Z(29), { y: dock + 1, yaw: Math.PI * 0.75 });
  c.mark('plaza', X(-2), Z(-32), { y: Y(6) + 1 });
  c.mark('boss_arena', dx0, dz0, { y: Y(-3) + 1 });
  c.mark('vista', X(-2) + 3, Z(-40), { y: belfryY - 1 });
  c.mark('secret', X(-30), Z(38), { y: deckY + 1 });
  c.mark('npc_1', X(45), Z(18));
  c.mark('npc_2', X(-4), Z(-12));
  c.mark('npc_3', X(-30), Z(34), { y: deckY + 1 });
  c.mark('npc_4', X(4), Z(-16));
  c.mark('chest_1', dx0 + V(9), dz0 - V(6), { y: Y(-3) + 1 });
  c.mark('chest_2', X(-2) - 3, Z(-40), { y: belfryY - 1 });
  c.mark('chest_3', X(-36), Z(40), { y: deckY + 1 });
}

// ---------------------------------------------------------------------------
// 4. Drum Peaks — snow, twin peaks, cliff castle-hospital
// ---------------------------------------------------------------------------

function buildDrumPeaks(c, rng) {
  const B = c.B;
  const { X, Z, Y, V } = axes(c);

  const shore = coast(c, [
    [0, -66], [34, -58], [58, -34], [68, -2], [60, 28], [38, 50],
    [8, 60], [-22, 56], [-48, 38], [-64, 8], [-62, -26], [-40, -52],
  ]);
  c.heightmapFromPolygon(shore, {
    peak: V(12), edge: 2, reach: V(22), shelf: V(15), profile: 'shoulder', noise: 3, noiseScale: 0.026,
    fill: B.rockCold, soil: B.dirt, soilDepth: 3, surface: B.grassCold, seedTag: 19,
  });

  // The twin peaks. Two ridges crossing near the middle, with the saddle between them
  // deliberately left low — that saddle is where the castle goes.
  c.ridge([X(-40), Z(-6)], [X(-18), Z(-28)], [V(20), V(60)], V(20), { fill: B.rockCold, surface: B.rockCold, falloff: 'dome' });
  c.ridge([X(-18), Z(-28)], [X(-6), Z(-44)], [V(60), V(26)], V(17), { fill: B.rockCold, surface: B.rockCold });
  c.ridge([X(38), Z(-8)], [X(20), Z(-32)], [V(18), V(53)], V(19), { fill: B.rockCold, surface: B.rockCold, falloff: 'dome' });
  c.ridge([X(20), Z(-32)], [X(8), Z(-46)], [V(53), V(24)], V(16), { fill: B.rockCold, surface: B.rockCold });
  c.ridge([X(-14), Z(-30)], [X(16), Z(-34)], V(30), V(12), { fill: B.rockCold, surface: B.rockCold });

  // Frozen lake in a bowl on the lower southern shelf.
  const lx = X(4), lz = Z(22);
  c.crater(lx, lz, V(15), V(6), { rim: 2, rimWidth: 8, surface: B.rockCold, soil: B.rockCold, fill: B.rockCold });
  c.plateau(lx, lz, V(13), Y(3), { blend: V(4), surface: B.ice, soil: B.ice, soilDepth: 2, fill: B.rockCold });
  c.disc(lx, lz, Y(3), V(13), B.ice);
  // Cracks: three straight fissures, hand-aimed, so the ice is not a blank disc.
  for (const [ax, az, bx2, bz2] of [[-11, -4, 6, 3], [-2, -11, 3, 9], [4, -8, 11, 2]]) {
    for (let t = 0; t <= 24; t++) {
      const px = Math.round(lerp(lx + V(ax), lx + V(bx2), t / 24));
      const pz = Math.round(lerp(lz + V(az), lz + V(bz2), t / 24));
      c.set(px, Y(3), pz, B.rockCold);   // a pressure crack, dark against the ice
    }
  }
  c.hint('lake', lx, Y(3), lz, { tag: 'frozen_lake', radius: 13 });

  c.beach(4, { depth: 3, jitter: 2.2 });
  c.paint((x, z, y, i) => {
    if (i.hM > 9 && i.slope < 4) return [B.snow, B.snow, B.rockCold];
    if (i.hM > 5) return i.slope >= 4 ? B.rockCold : B.snow;
    if (i.slope >= 4) return B.rockCold;
    if (i.hM > 1) return B.grassCold;
    return undefined;
  });

  // Castle-hospital on the saddle: a keep, two round towers, a red-roofed ward wing.
  const kx = X(0), kz = Z(-30), ky = Y(30);
  c.plateau(kx, kz, V(17), ky, { shape: 'rect', rz: V(11), blend: V(4), surface: B.stone, soil: B.rockCold, fill: B.rockCold });
  c.building(kx - V(9), kz - V(7), V(18), V(11), 14, 'keep', { doorSide: 2, baseY: ky, banner: B.flagRed });
  for (const sx of [-V(10), V(10)]) {
    c.cyl(kx + sx, kz - V(4), ky, ky + 22, 4.2, B.stone, { hollow: true, thick: 1 });
    c.disc(kx + sx, kz - V(4), ky + 23, 5, B.stone);
    c.cone(kx + sx, kz - V(4), ky + 24, ky + 31, 5, 0.6, B.roof);
    c.colFill(kx + sx, kz - V(4), ky + 32, ky + 34, B.flagRed);
  }
  c.building(kx + V(7), kz + V(5), V(13), V(9), 8, 'chalet', { doorSide: 3, baseY: ky });
  // A white cross on the ward roof: the one identity mark on the whole silhouette.
  const cy = ky + 12;
  c.box(kx + V(11), cy, kz + V(7), kx + V(15), cy, kz + V(7), B.sail);
  c.box(kx + V(13), cy, kz + V(5), kx + V(13), cy, kz + V(9), B.sail);
  wallArc(c, kx, kz, V(19), Math.PI * 0.15, Math.PI * 0.85, ky, 5, 1, B.stone, { walk: B.stone });

  // Cable-car line: shore station, two pylons up the cliff, top station at the castle.
  const stations = [[X(10), Z(40)], [X(8), Z(22)], [X(6), Z(0)], [X(3), Z(-20)]];
  const tops = [];
  for (let i = 0; i < stations.length; i++) {
    tops.push(cableTower(c, stations[i][0], stations[i][1], i === 0 ? 16 : 20, i === 0));
  }
  for (let i = 0; i < tops.length - 1; i++) {
    c.cable([tops[i].x, tops[i].y, tops[i].z], [tops[i + 1].x, tops[i + 1].y, tops[i + 1].z], B.rope, 3);
  }
  c.cable([tops[3].x, tops[3].y, tops[3].z], [kx, ky + 16, kz + V(9)], B.rope, 2);

  // Shore village of stone huts under the peaks.
  c.plateau(X(-16), Z(38), V(14), Y(3.5), { blend: V(5), surface: B.snow, soil: B.dirt, fill: B.rockCold });
  c.town(rng, [
    { x: X(-26), z: Z(32), w: 9, d: 8, h: 5, style: 'stoneHut', doorSide: 2 },
    { x: X(-14), z: Z(31), w: 10, d: 8, h: 5, style: 'chalet', doorSide: 2, chimney: true },
    { x: X(-25), z: Z(42), w: 9, d: 8, h: 4, style: 'stoneHut', doorSide: 3 },
    { x: X(-12), z: Z(42), w: 11, d: 9, h: 6, style: 'chalet', doorSide: 3, banner: B.flagRed },
    { x: X(-2), z: Z(36), w: 8, d: 8, h: 4, style: 'stoneHut', doorSide: 1 },
  ], 'stoneHut', { lantern: B.gold });

  const dock = pier(c, [X(-8), Z(50)], [X(-8), Z(62)], 5, { deckY: Y(1.5), post: B.woodDark });

  // Paths: a switchback road is the only honest way up a mountain.
  c.path([[X(-8), Z(48)], [X(-10), Z(42)], [X(-14), Z(38)]], 4, B.stone, { edge: B.stoneBrick });
  c.path([[X(-14), Z(38)], [X(0), Z(34)], [X(8), Z(30)], [X(6), Z(24)]], 4, B.stone);
  // One continuous mountain road, all the way onto the castle terrace, in a single call:
  // the slope limiter only guarantees a walkable grade end to end.
  c.path([
    [X(6), Z(24)], [X(18), Z(18)], [X(26), Z(6)], [X(16), Z(-4)],
    [X(2), Z(-2)], [X(-12), Z(-6)], [X(-20), Z(-12)], [X(-16), Z(-20)],
    [X(-6), Z(-22)], [X(0), Z(-24)],
  ], 4, B.stone, { edge: B.rockCold, maxStep: 1 });
  c.path([[X(-24), Z(-14)], [X(-30), Z(-20)], [X(-34), Z(-26)]], 3, B.snow, { maxStep: 1 });

  // Secret: an ice cave in the flank of the southern peak.
  c.cave([
    [X(34), Y(11), Z(4)], [X(30), Y(13), Z(-4)], [X(26), Y(15), Z(-12)], [X(24), Y(16), Z(-18)],
  ], [3.4, 5], { floor: B.ice });
  c.colFill(X(24), Z(-18), Y(16.5), Y(17.5), B.gold);

  c.scatter(rng, { cx: c.cx, cz: c.cz, r: V(60), spacing: 6 }, 0.7, (x, z, y, r) => {
    const hM = (y - c.seaLevel) * VOXEL_M;
    const b = c.get(x, y, z);
    if (hM < 1 || hM > 26) return;
    if (b === B.grassCold || (b === B.snow && hM < 20)) {
      if (r.chance(0.72)) c.tree(x, z, 'pine', r, { scale: hM > 14 ? 0.7 : 1 });
      else if (r.chance(0.3)) c.colFill(x, z, y + 1, y + 1, B.rockCold);
    }
  });

  c.mark('dock', X(-8), Z(60), { y: dock + 1, yaw: 0 });
  c.mark('plaza', X(-16), Z(38), { y: Y(3.5) + 1 });
  c.mark('boss_arena', lx, lz, { y: Y(3) + 1 });
  c.mark('vista', X(-16), Z(-32));
  c.mark('secret', X(24), Z(-18), { y: Y(16.5) });
  c.mark('npc_1', X(-8), Z(52), { y: dock + 1 });
  c.mark('npc_2', X(-18), Z(37), { y: Y(3.5) + 1 });
  c.mark('npc_3', X(-6), Z(-22));
  c.mark('npc_4', X(14), Z(37));
  c.mark('chest_1', X(24), Z(-18), { y: Y(16.5) });
  c.mark('chest_2', kx - V(10), kz - V(4), { y: ky + 23 });
  c.mark('chest_3', lx + V(9), lz - V(7), { y: Y(3) + 1 });
}

// ---------------------------------------------------------------------------
// 5. Emberfall — volcanic caldera, lava channels, obsidian spires
// ---------------------------------------------------------------------------

function buildEmberfall(c, rng) {
  const B = c.B;
  const { X, Z, Y, V } = axes(c);

  const shore = coast(c, [
    [0, -62], [30, -56], [52, -34], [62, -4], [56, 24], [36, 46],
    [6, 56], [-26, 50], [-50, 30], [-62, 2], [-56, -28], [-32, -52],
  ]);
  c.heightmapFromPolygon(shore, {
    peak: V(44), edge: 2, reach: V(46), shelf: V(14), profile: 'cone', noise: 3.4, noiseScale: 0.03,
    fill: B.volcanic, soil: B.ash, soilDepth: 3, surface: B.ash, seedTag: 23,
  });

  // Flatten the summit into a rim walk wide enough to fight on...
  c.plateau(c.cx, c.cz, V(21), Y(44), { blend: V(8), surface: B.volcanic, soil: B.volcanic, fill: B.volcanic });
  // ...then open the caldera straight down through the middle of it.
  c.crater(c.cx, c.cz, V(15), V(22), {
    rimWidth: V(4), surface: B.volcanic, soil: B.volcanic, fill: B.volcanic, floorFlat: 0.45,
  });
  const lavaY = Y(24);
  c.cyl(c.cx, c.cz, lavaY - 5, lavaY, V(11), B.lava);
  c.disc(c.cx, c.cz, lavaY, V(11), B.lava);
  c.ring(c.cx, c.cz, lavaY + 1, V(11.6), B.volcanic, 2);
  c.hint('lava', c.cx, lavaY, c.cz, { tag: 'lava_lake', radius: 11 });

  // Three lava channels running down the flanks to the sea. Hand-drawn, not simulated.
  const runs = [
    [[c.cx - V(16), c.cz - V(13)], [X(-26), Z(-24)], [X(-38), Z(-40)], [X(-46), Z(-52)]],
    [[c.cx + V(18), c.cz + V(8)], [X(30), Z(16)], [X(42), Z(30)], [X(50), Z(42)]],
    [[c.cx + V(6), c.cz - V(19)], [X(12), Z(-32)], [X(16), Z(-48)], [X(14), Z(-60)]],
  ];
  for (const run of runs) {
    c.carveRiver(run, V(4), { depth: V(2.5), fill: B.lava, bed: B.volcanic, bankBlock: B.volcanic });
  }

  // Obsidian spires: five hand-placed leaning needles, no two alike.
  const spires = [
    [X(-30), Z(6), 30, 3.4, -3, 2], [X(-14), Z(28), 22, 2.8, 2, -2],
    [X(26), Z(-18), 34, 3.8, 3, 3], [X(40), Z(8), 24, 3.0, -2, 1],
    [X(4), Z(40), 26, 3.2, 1, -3],
  ];
  for (const [sx, sz, h, r, lx2, lz2] of spires) {
    const g = Math.max(1, c.groundY(sx, sz));
    c.cone(sx, sz, g - 2, g + h, r, 0.7, B.volcanic, { lean: [lx2, lz2] });
    c.cone(sx + Math.round(r), sz + 1, g - 1, g + Math.round(h * 0.55), r * 0.55, 0.6, B.volcanic, { lean: [lx2, 0] });
    c.hint('spire', sx, g + h, sz, { tag: 'obsidian_spire' });
  }

  c.beach(4, { sand: B.ash, wet: B.volcanic, depth: 3, jitter: 2.4 });
  c.paint((x, z, y, i) => {
    if (i.hM < 1.5) return B.ash;
    if (i.hM > 26) return B.volcanic;
    if (i.slope >= 4) return B.volcanic;
    if (i.hM < 8 && i.slope < 2) return [B.ash, B.volcanic];
    return undefined;
  });

  // Forge village on the north-west flank, on a cut shelf beside a lava channel.
  const fx = X(-30), fz = Z(-28), fy = Y(13);
  c.plateau(fx, fz, V(17), fy, { blend: V(6), surface: B.volcanic, soil: B.volcanic, fill: B.volcanic });
  c.town(rng, [
    { x: fx - V(12), z: fz - V(8), w: 12, d: 10, h: 6, style: 'forge', doorSide: 2, chimney: true },
    { x: fx + V(1), z: fz - V(8), w: 11, d: 10, h: 6, style: 'forge', doorSide: 2, chimney: true },
    { x: fx - V(12), z: fz + V(3), w: 10, d: 9, h: 5, style: 'stoneHut', doorSide: 3 },
    { x: fx + V(2), z: fz + V(3), w: 12, d: 9, h: 7, style: 'warehouse', doorSide: 3, banner: B.flagRed },
  ], 'forge', { lantern: B.lavaHot !== undefined ? B.gold : B.gold });
  // The great forge: a lava tap running into a stone trough, with anvils either side.
  c.box(fx - V(3), fy, fz + V(8), fx + V(3), fy + 2, fz + V(11), B.stone);
  c.box(fx - V(2), fy + 1, fz + V(9), fx + V(2), fy + 2, fz + V(10), B.lava);
  for (const s of [-V(5), V(5)]) {
    c.box(fx + s, fy + 1, fz + V(9), fx + s + 1, fy + 2, fz + V(10), B.metalDark);
  }
  c.carveRiver([[fx, fz + V(4)], [fx, fz + V(9)]], 4, { depth: 2, fill: B.lava, bed: B.volcanic, bankBlock: B.stone });
  c.hint('forge', fx, fy + 2, fz + V(9), { tag: 'great_forge' });

  const dock = pier(c, [X(-40), Z(-44)], [X(-50), Z(-54)], 5, { deckY: Y(1.5), post: B.metalDark });

  c.path([[X(-42), Z(-42)], [X(-38), Z(-36)], [fx - V(2), fz + V(2)]], 4, B.stone, { edge: B.volcanic });
  // Switchback to the rim. Long enough that the climb reads as a road, not a ladder.
  c.path([
    [fx + V(6), fz], [X(-20), Z(-34)], [X(-6), Z(-38)], [X(6), Z(-30)],
    [X(8), Z(-16)], [X(-2), Z(-8)], [X(-16), Z(-12)], [X(-19), Z(-4)],
  ], 4, B.stone, { edge: B.volcanic, maxStep: 1 });
  c.path([[fx, fz - V(10)], [X(-32), Z(-42)], [X(-30), Z(-50)]], 3, B.ash);
  c.path([[X(-6), Z(30)], [X(4), Z(38)], [X(12), Z(46)]], 3, B.ash);

  // Secret: a lava tube from the south shore into the base of the cone.
  c.cave([
    [X(10), Y(3), Z(48)], [X(8), Y(6), Z(38)], [X(4), Y(10), Z(28)], [X(0), Y(13), Z(20)],
  ], [3.4, 5.4], { floor: B.volcanic });
  c.disc(X(0), Z(20), Y(12.4), 5, B.stone);
  c.colFill(X(0), Z(20), Y(13), Y(14), B.gold);

  c.scatter(rng, { cx: c.cx, cz: c.cz, r: V(58), r0: V(20), spacing: 8 }, 0.5, (x, z, y, r) => {
    const hM = (y - c.seaLevel) * VOXEL_M;
    if (hM < 1 || hM > 22) return;
    const k = r.f();
    if (k < 0.5) c.cone(x, z, y, y + r.int(2, 5), 1.7, 0.6, B.volcanic, { lean: [r.int(-1, 1), r.int(-1, 1)] });
    else if (k < 0.75) c.tree(x, z, 'dead', r, { scale: 0.8 });
    else c.sphere(x, y + 1, z, r.range(1.6, 2.6), B.ash, { hemisphere: true, squash: 0.5 });
  });

  c.mark('dock', X(-49), Z(-53), { y: dock + 1, yaw: Math.PI * 1.25 });
  c.mark('plaza', fx, fz, { y: fy + 1 });
  c.mark('boss_arena', c.cx - V(18), c.cz);
  c.mark('vista', c.cx - V(19), c.cz - V(6));
  c.mark('secret', X(0), Z(20), { y: Y(13) });
  c.mark('npc_1', X(-42), Z(-40));
  c.mark('npc_2', fx - V(6), fz + V(1), { y: fy + 1 });
  c.mark('npc_3', fx + V(7), fz + V(2), { y: fy + 1 });
  c.mark('npc_4', X(-14), Z(-20));
  c.mark('chest_1', X(0), Z(20), { y: Y(13) });
  c.mark('chest_2', spires[2][0] + 5, spires[2][1] + 5);
  c.mark('chest_3', c.cx + V(16), c.cz + V(10));
}

// ---------------------------------------------------------------------------
// 6. Whisper Sands — desert, sunken city, giant stone arch
// ---------------------------------------------------------------------------

function buildWhisperSands(c, rng) {
  const B = c.B;
  const { X, Z, Y, V } = axes(c);

  const shore = coast(c, [
    [0, -70], [38, -60], [62, -34], [72, 0], [62, 32], [36, 56],
    [0, 66], [-34, 58], [-60, 34], [-72, 0], [-62, -34], [-34, -60],
  ]);
  c.heightmapFromPolygon(shore, {
    peak: V(8), edge: 2, reach: V(26), shelf: V(16), profile: 'dome', noise: 2.4, noiseScale: 0.02,
    fill: B.clay, soil: B.sand, soilDepth: 4, surface: B.sand, seedTag: 29,
  });

  // Dune crests: hand-drawn arcs, each one a ridge with a soft lee side.
  const dunes = [
    [[X(-58), Z(-16)], [X(-30), Z(-30)], [X(-4), Z(-26)], 13],
    [[X(6), Z(-44)], [X(34), Z(-34)], [X(52), Z(-12)], 15],
    [[X(48), Z(16)], [X(26), Z(38)], [X(-2), Z(46)], 12],
    [[X(-24), Z(40)], [X(-46), Z(24)], [X(-58), Z(4)], 11],
    [[X(-14), Z(-6)], [X(6), Z(4)], [X(22), Z(-4)], 9],
  ];
  for (const d of dunes) {
    c.ridge([d[0], d[1], d[2]], null, [V(4), V(d[3] * 0.5)], V(16), {
      fill: B.clay, soil: B.sand, soilDepth: 4, surface: B.sand, falloff: 'dome',
    });
  }

  // The sunken city sits in a shallow basin so the dunes visibly swallow it.
  const sx0 = X(-6), sz0 = Z(12);
  c.crater(sx0, sz0, V(26), V(7), { surface: B.sand, soil: B.sand, fill: B.clay, floorFlat: 0.55 });

  c.beach(5, { depth: 4, jitter: 3 });
  c.paint((x, z, y, i) => {
    if (i.slope >= 4) return B.clay;
    if (i.hM > 6.5) return [B.sand, B.sand, B.clay];
    return B.sand;
  });

  // Half-buried city: an authored street grid, with each building sunk by a different
  // amount so the skyline is a broken comb rather than a row of identical blocks.
  const bury = [7, 2, 5, 0, 8, 3, 6, 1, 4, 9, 2, 6];
  let k = 0;
  for (let gz = 0; gz < 3; gz++) {
    for (let gx = 0; gx < 4; gx++) {
      const bx = sx0 + V(-20 + gx * 13), bz = sz0 + V(-14 + gz * 13);
      const g = c.groundY(bx, bz);
      if (g < 1) { k++; continue; }
      const sink = bury[k % bury.length];
      const h = 12 - sink;
      if (h > 2) {
        // Mud-brick where the sand has protected it, bare stone where it has not.
        c.building(bx, bz, 9 + (k % 3), 9, h, sink > 5 ? 'ruin' : 'adobe',
          { baseY: g - sink, doorSide: (k + gz) % 4 });
      }
      // Broken columns marking the buried street corners.
      if ((gx + gz) % 2 === 0) {
        const px = bx - 3, pz = bz - 3;
        const pg = c.groundY(px, pz);
        if (pg > 0) c.cyl(px, pz, pg, pg + 4 + (k % 4), 1.6, B.stone);
      }
      k++;
    }
  }
  // The sunken plaza and its broken obelisk: the boss arena.
  c.plateau(sx0, sz0, V(11), Y(0.5), { blend: V(4), surface: B.stone, soil: B.clay, fill: B.clay });
  c.ring(sx0, sz0, Y(0.5), V(10), B.stoneBrick, 2);
  c.cyl(sx0, sz0, Y(0.5), Y(7), 2.4, B.stone);
  c.cone(sx0, sz0, Y(7), Y(9), 2.4, 1.4, B.stone, { lean: [2, 1] });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + 0.3;
    const px = Math.round(sx0 + Math.cos(a) * V(8)), pz = Math.round(sz0 + Math.sin(a) * V(8));
    c.cyl(px, pz, Y(0.5), Y(0.5) + 3 + (i % 5), 1.5, B.stone);
  }

  // The giant arch — the one thing you can see from anywhere on the island.
  const ax = X(30), az = Z(-16);
  c.plateau(ax, az, V(16), Y(6), { blend: V(7), surface: B.clay, soil: B.clay, fill: B.clay });
  c.arch(ax, az, Y(6), V(24), V(17), 3, B.stone, 'x');
  // Buttressed legs. The eastern one is stepped up to a viewing ring, so the arch is a
  // place you stand under and on, not only a thing you photograph.
  c.cyl(ax - V(12), az, Y(6), Y(9), 5, B.stone);
  c.cyl(ax + V(12), az, Y(6), Y(13), 6, B.stone);
  c.disc(ax + V(12), az, Y(13), 6, B.stone);
  c.ring(ax + V(12), az, Y(14), 5.6, B.stoneBrick, 1);
  c.hint('landmark', ax, Y(23), az, { tag: 'great_arch' });

  // Oasis: a spring in a hollow, ringed with palms. The only green on the island.
  const ox = X(-34), oz = Z(-6);
  c.crater(ox, oz, V(11), V(4), { surface: B.grassDry, soil: B.dirt, fill: B.clay, floorFlat: 0.5 });
  c.disc(ox, oz, Y(-0.5), V(6), c.WATER);
  c.cyl(ox, oz, Y(-1.5), Y(-0.5), V(6), c.WATER);
  c.ring(ox, oz, Y(0), V(6.6), B.grassDry, 2);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * TAU + 0.4;
    const px = Math.round(ox + Math.cos(a) * V(8.5)), pz = Math.round(oz + Math.sin(a) * V(8.5));
    c.tree(px, pz, 'palm', rng);
  }
  c.building(ox + V(9), oz - V(6), 8, 7, 4, 'tent', { doorSide: 1 });
  c.hint('oasis', ox, Y(0), oz, { tag: 'oasis', radius: 6 });

  const dock = pier(c, [X(-2), Z(60)], [X(-2), Z(70)], 5, { deckY: Y(1.5), post: B.woodDark });

  c.path([[X(-2), Z(58)], [X(-4), Z(46)], [X(-6), Z(32)], [sx0, sz0 + V(11)]], 4, B.clay, { edge: B.stone });
  c.path([[sx0 + V(11), sz0], [X(14), Z(6)], [X(26), Z(-6)], [ax, az + V(12)]], 4, B.clay, { edge: B.stone });
  c.path([[sx0 - V(11), sz0 - V(3)], [X(-22), Z(2)], [ox + V(6), oz + V(4)]], 4, B.clay);
  c.path([[X(-40), Z(-14)], [X(-46), Z(-26)], [X(-50), Z(-36)]], 3, B.sand);
  c.path([[ax, az + V(12)], [ax + V(14), az + V(9)], [ax + V(22), az + V(1)]], 4, B.clay, { edge: B.stone, maxStep: 1 });
  c.stairs([ax + V(22), Math.max(2, c.groundY(ax + V(22), az + V(1))), az + V(1)],
    [ax + V(13), Y(13), az], 4, B.stoneBrick, { side: B.stone });

  // Secret: a tomb under the northern dune, reached through a collapsed shaft.
  c.cave([
    [X(-30), Y(6), Z(-32)], [X(-26), Y(3), Z(-38)], [X(-20), Y(1), Z(-44)], [X(-12), Y(0.5), Z(-46)],
  ], [3, 5], { floor: B.stone });
  c.box(X(-16), Y(0), Z(-49), X(-8), Y(0), Z(-43), B.stone);
  c.colFill(X(-12), Z(-46), Y(0.5), Y(1.5), B.gold);
  c.cyl(X(-30), Z(-32), Y(6), Y(8), 3, B.stone, { hollow: true, thick: 1 });

  c.scatter(rng, { cx: c.cx, cz: c.cz, r: V(66), spacing: 9 }, 0.5, (x, z, y, r) => {
    const hM = (y - c.seaLevel) * VOXEL_M;
    if (hM < 1.2) return;
    const kk = r.f();
    if (kk < 0.45) c.tree(x, z, 'cactus', r);
    else if (kk < 0.62) c.tree(x, z, 'dead', r, { scale: 0.7 });
    else if (kk < 0.8) c.cyl(x, z, y, y + r.int(1, 3), 1.4, B.clay);
    else c.set(x, y + 1, z, B.stone);
  });

  c.mark('dock', X(-2), Z(68), { y: dock + 1, yaw: 0 });
  c.mark('plaza', sx0, sz0 + V(6), { y: Y(0.5) + 1 });
  c.mark('boss_arena', sx0, sz0, { y: Y(0.5) + 1 });
  c.mark('vista', ax + V(12), az, { y: Y(13) + 1 });
  c.mark('secret', X(-12), Z(-46), { y: Y(0.5) });
  c.mark('npc_1', X(-2), Z(56));
  c.mark('npc_2', ox + V(7), oz - V(4));
  c.mark('npc_3', sx0 - V(8), sz0 + V(4), { y: Y(0.5) + 1 });
  c.mark('npc_4', ax + V(3), az + V(11));
  c.mark('chest_1', X(-12), Z(-46), { y: Y(0.5) });
  c.mark('chest_2', ax, az, { y: Y(6) + V(17) + 3 });
  c.mark('chest_3', ox - V(8), oz + V(7));
}

// ---------------------------------------------------------------------------
// 7. Blossom Terrace — cherry terraces, summit pagoda, torii stair
// ---------------------------------------------------------------------------

function buildBlossomTerrace(c, rng) {
  const B = c.B;
  const { X, Z, Y, V } = axes(c);

  const shore = coast(c, [
    [0, -64], [32, -56], [54, -32], [64, -2], [56, 28], [34, 50],
    [4, 60], [-28, 54], [-52, 32], [-64, 2], [-56, -30], [-30, -54],
  ]);
  c.heightmapFromPolygon(shore, {
    peak: V(40), edge: 2, reach: V(52), shelf: V(14), profile: 'shoulder', noise: 2.2, noiseScale: 0.028,
    fill: B.rock, soil: B.dirt, soilDepth: 4, surface: B.grass, seedTag: 31,
  });

  c.beach(4, { depth: 3, jitter: 2.2 });
  // Terracing is what turns this hill into cultivated ground.
  c.terrace({
    cx: c.cx, cz: c.cz, r: V(56), step: 8, base: c.seaLevel + 6,
    from: c.seaLevel + 5, to: c.sy - 1, wall: B.stone, surface: B.grass, fill: B.dirt,
  });
  c.paint((x, z, y, i) => {
    if (i.slope >= 5) return B.stone;
    if (i.hM < 1.4) return B.sand;
    if (i.hM > 34) return B.stone;
    return B.grass;
  });

  // Summit platform and the pagoda that crowns it.
  c.plateau(c.cx, c.cz, V(15), Y(38), { blend: V(5), surface: B.stone, soil: B.rock, fill: B.rock });
  c.ring(c.cx, c.cz, Y(38), V(14), B.stoneBrick, 2);
  const pagodaTop = pagodaTower(c, c.cx, c.cz, 5, 6);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + 0.4;
    const px = Math.round(c.cx + Math.cos(a) * V(12)), pz = Math.round(c.cz + Math.sin(a) * V(12));
    c.colFill(px, pz, Y(38) + 1, Y(38) + 4, B.woodDark);
    c.set(px, Y(38) + 5, pz, B.gold);
  }

  // The torii stair: one long straight climb from the dock to the summit, nine gates.
  // One levelled climb from the waterline to the summit. At half a metre per voxel the
  // slope limiter *is* the staircase, and unlike hand-placed flights it can never end up
  // two voxels above the terrace it is meant to land on.
  const stairX = c.cx;
  c.path([
    [stairX, Z(64)], [stairX, Z(52)], [stairX, Z(40)], [stairX, Z(28)],
    [stairX, Z(16)], [stairX, Z(6)], [stairX, Z(-2)],
  ], 7, B.stone, { edge: B.stoneBrick, maxStep: 1, smooth: 2 });
  for (let i = 0; i < 9; i++) {
    const gz = Math.round(lerp(Z(54), Z(10), i / 8));
    const gy = c.groundY(stairX, gz);
    if (gy > 0) c.torii(stairX, gz, gy + 1, 9, 7, { post: B.flagRed, beam: B.flagRed, axis: 'x' });
  }
  c.hint('landmark', stairX, Y(20), Z(28), { tag: 'torii_stair' });

  // Koi ponds on the second terrace, with stone rims and a plank footbridge.
  const ponds = [[X(-22), Z(14), 7], [X(-30), Z(2), 5], [X(-16), Z(2), 6]];
  for (const [px, pz, pr] of ponds) {
    const g = c.groundY(px, pz);
    c.plateau(px, pz, V(pr + 3), g, { blend: 3, surface: B.grass, soil: B.dirt, fill: B.rock });
    c.cyl(px, pz, g - 3, g - 1, V(pr), c.WATER);
    c.disc(px, pz, g - 1, V(pr), c.WATER);
    c.colFill(px, pz, g - 1, g - 1, c.WATER);
    c.ring(px, pz, g, V(pr) + 1, B.stone, 2);
    c.hint('pond', px, g, pz, { tag: 'koi_pond', radius: pr });
  }
  for (let i = -6; i <= 6; i++) c.set(X(-23) + i, c.groundY(X(-23), Z(8)) + 1, Z(8), B.plank);
  for (const s of [-6, 6]) c.colFill(X(-23) + s, Z(8), c.groundY(X(-23), Z(8)) + 1, c.groundY(X(-23), Z(8)) + 2, B.flagRed);

  // Duelling ground: raked gravel, a rope fence, and one old cherry tree off-centre.
  const dgx = X(26), dgz = Z(6);
  const dgy = c.groundY(dgx, dgz);
  c.plateau(dgx, dgz, V(14), dgy, { blend: V(4), surface: B.sand, soil: B.dirt, fill: B.rock });
  c.ring(dgx, dgz, dgy, V(13), B.stone, 2);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU;
    const px = Math.round(dgx + Math.cos(a) * V(13.5)), pz = Math.round(dgz + Math.sin(a) * V(13.5));
    c.colFill(px, pz, dgy + 1, dgy + 2, B.woodDark);
    const a2 = ((i + 1) / 16) * TAU;
    c.cable([px, dgy + 2, pz], [Math.round(dgx + Math.cos(a2) * V(13.5)), dgy + 2, Math.round(dgz + Math.sin(a2) * V(13.5))], B.rope, 0);
  }
  c.tree(dgx + V(8), dgz - V(7), 'cherry', rng, { scale: 1.4 });
  c.torii(dgx, dgz + V(13), dgy + 1, 9, 7, { post: B.woodDark, beam: B.flagRed });

  // Teahouse village on the third terrace.
  c.town(rng, [
    { x: X(-40), z: Z(-16), w: 10, d: 9, h: 5, style: 'teahouse', doorSide: 2 },
    { x: X(-28), z: Z(-18), w: 11, d: 9, h: 5, style: 'teahouse', doorSide: 2, banner: B.flagRed },
    { x: X(-38), z: Z(-6), w: 9, d: 8, h: 4, style: 'teahouse', doorSide: 3 },
    { x: X(-26), z: Z(-30), w: 12, d: 10, h: 6, style: 'pagoda', doorSide: 2 },
  ], 'teahouse', { lantern: B.gold });

  const dock = pier(c, [X(0), Z(54)], [X(0), Z(64)], 6, { deckY: Y(1.5), post: B.flagRed });
  c.torii(stairX, Z(56), Y(1.5) + 1, 11, 9, { post: B.flagRed, beam: B.flagRed });

  c.path([[X(-4), Z(44)], [X(-14), Z(36)], [X(-24), Z(24)], [X(-24), Z(16)]], 4, B.stone, { edge: B.stoneBrick });
  c.path([[X(-26), Z(0)], [X(-32), Z(-10)], [X(-34), Z(-18)]], 4, B.stone, { edge: B.stoneBrick });
  c.path([[X(6), Z(30)], [X(16), Z(22)], [dgx, dgz + V(14)]], 4, B.stone, { edge: B.stoneBrick });
  c.path([[X(40), Z(-4)], [X(46), Z(-16)], [X(48), Z(-28)]], 3, B.dirt);

  // Secret: a hillside shrine behind a waterfall-fed cistern on the north face.
  c.cave([
    [X(4), Y(30), Z(-16)], [X(2), Y(30.5), Z(-24)], [X(-4), Y(31), Z(-30)],
  ], [3.2, 4.6], { floor: B.stone });
  c.torii(X(4), Z(-15), Y(30), 7, 5, { post: B.flagRed, beam: B.flagRed });
  c.colFill(X(-4), Z(-30), Y(31), Y(32), B.gold);

  c.scatter(rng, { cx: c.cx, cz: c.cz, r: V(56), spacing: 7 }, 0.7, (x, z, y, r) => {
    const hM = (y - c.seaLevel) * VOXEL_M;
    const b = c.get(x, y, z);
    if (b !== B.grass || hM < 1.5) return;
    const kk = r.f();
    if (kk < 0.66) c.tree(x, z, 'cherry', r, { scale: r.range(0.8, 1.25) });
    else if (kk < 0.78) c.tree(x, z, 'pine', r, { scale: 0.7 });
    else if (kk < 0.9) c.set(x, y + 1, z, B.leavesCherry);
  });

  c.mark('dock', X(0), Z(62), { y: dock + 1, yaw: 0 });
  c.mark('plaza', c.cx, c.cz + V(11), { y: Y(38) + 1 });
  c.mark('boss_arena', dgx, dgz, { y: dgy + 1 });
  c.mark('vista', c.cx - V(12), c.cz, { y: Y(38) + 1 });
  c.mark('secret', X(-4), Z(-30), { y: Y(31) });
  c.mark('npc_1', X(0), Z(50));
  c.mark('npc_2', X(-34), Z(-12));
  c.mark('npc_3', X(-24), Z(10));
  c.mark('npc_4', dgx - V(9), dgz + V(6), { y: dgy + 1 });
  c.mark('chest_1', X(-4), Z(-30), { y: Y(31) });
  c.mark('chest_2', c.cx, c.cz, { y: pagodaTop - 4 });
  c.mark('chest_3', X(-26), Z(-30));
}

// ---------------------------------------------------------------------------
// 8. Marineford Reach — tiered fortress island
// ---------------------------------------------------------------------------

function buildMarinefordReach(c, rng) {
  const B = c.B;
  const { X, Z, Y, V } = axes(c);

  const shore = coast(c, [
    [0, -72], [40, -62], [66, -36], [76, 0], [66, 34], [40, 58],
    [6, 68], [-32, 60], [-60, 36], [-74, 0], [-64, -36], [-34, -62],
  ]);
  c.heightmapFromPolygon(shore, {
    peak: V(16), edge: 2, reach: V(40), shelf: V(15), profile: 'mesa', noise: 2, noiseScale: 0.03,
    fill: B.rock, soil: B.dirt, soilDepth: 3, surface: B.grassDry, seedTag: 37,
  });
  c.beach(4, { depth: 3, jitter: 2 });

  // Three concentric terraces climbing away from the sea to the south.
  const tierY = [Y(5), Y(12), Y(20)];
  c.plateau(c.cx, c.cz + V(6), V(52), tierY[0], { blend: V(9), surface: B.stone, soil: B.rock, fill: B.rock });
  c.plateau(c.cx, c.cz - V(2), V(38), tierY[1], { blend: V(7), surface: B.stone, soil: B.rock, fill: B.rock });
  c.plateau(c.cx, c.cz - V(10), V(24), tierY[2], { blend: V(5), surface: B.stone, soil: B.rock, fill: B.rock });

  c.paint((x, z, y, i) => {
    if (i.hM < 1.4) return B.sand;
    if (i.hM > 3 && i.slope < 3) return B.stone;
    if (i.slope >= 4) return B.rock;
    return undefined;
  });

  // The three walls. Arcs facing the sea, each with a wall-walk and crenellations.
  wallArc(c, c.cx, c.cz + V(6), V(50), 0.10, Math.PI - 0.10, tierY[0], 9, 2, B.stoneBrick, { walk: B.stone, merlon: B.stone });
  wallArc(c, c.cx, c.cz - V(2), V(37), 0.16, Math.PI - 0.16, tierY[1], 8, 2, B.stoneBrick, { walk: B.stone, merlon: B.stone });
  wallArc(c, c.cx, c.cz - V(10), V(23), 0.20, Math.PI - 0.20, tierY[2], 7, 2, B.stoneBrick, { walk: B.stone, merlon: B.stone });

  // The great gate, dead on the north-south axis, with flanking drum towers.
  const gz = c.cz + V(56);
  c.box(c.cx - V(6), tierY[0], gz - 3, c.cx + V(6), tierY[0] + 15, gz + 3, B.stoneBrick);
  c.arch(c.cx, gz, tierY[0], V(11), V(8), 3, B.stone, 'x');
  c.box(c.cx - V(5), tierY[0], gz - 3, c.cx + V(5), tierY[0] + 8, gz + 3, 0);
  c.box(c.cx - V(5), tierY[0] + 9, gz - 1, c.cx + V(5), tierY[0] + 10, gz + 1, B.metalDark);
  for (const s of [-1, 1]) {
    const tx = c.cx + s * V(9);
    c.cyl(tx, gz, tierY[0] - 4, tierY[0] + 20, 5.4, B.stoneBrick, { hollow: true, thick: 2 });
    c.ring(tx, gz, tierY[0] + 21, 5.6, B.stone, 2);
    c.cone(tx, gz, tierY[0] + 22, tierY[0] + 29, 5.6, 0.7, B.metal);
    c.colFill(tx, gz, tierY[0] + 30, tierY[0] + 32, B.metalDark);
    c.box(tx, tierY[0] + 30, gz + 1, tx, tierY[0] + 31, gz + 3, B.rogerMarine);
  }
  c.hint('landmark', c.cx, tierY[0] + 15, gz, { tag: 'great_gate' });

  // Watchtowers along the walls: six, alternating between the two outer rings.
  const towers = [
    [c.cx - V(44), c.cz + V(26), tierY[0]], [c.cx + V(44), c.cz + V(26), tierY[0]],
    [c.cx - V(34), c.cz - V(2), tierY[1]], [c.cx + V(34), c.cz - V(2), tierY[1]],
    [c.cx - V(20), c.cz - V(26), tierY[2]], [c.cx + V(20), c.cz - V(26), tierY[2]],
  ];
  let tallest = null;
  for (let i = 0; i < towers.length; i++) {
    const [tx, tz, ty] = towers[i];
    const h = 20 + (i % 3) * 5;
    c.cyl(tx, tz, ty - 6, ty + h, 5, B.stoneBrick, { hollow: true, thick: 2 });
    c.disc(tx, tz, ty - 1, 4, B.stone);                       // guard-room floor at grade
    for (let k = 6; k < h; k += 5) {
      c.box(tx - 5, ty + k, tz, tx - 5, ty + k + 1, tz, 0);
      c.box(tx + 5, ty + k, tz, tx + 5, ty + k + 1, tz, 0);
    }
    c.box(tx - 1, ty, tz + 3, tx + 1, ty + 2, tz + 5, 0);     // door through the wall
    c.disc(tx, tz, ty + h + 1, 6, B.stone);
    c.disc(tx, tz, ty + h + 1, 3.2, 0);                       // stair well onto the crown
    c.ring(tx, tz, ty + h + 2, 5.6, B.stone, 1);
    // The roof stands on posts, leaving headroom on the crown — a watch platform you
    // cannot stand upright on is just a hat.
    for (let a = 0; a < 4; a++) {
      const ang = (a / 4) * TAU + 0.78;
      c.colFill(Math.round(tx + Math.cos(ang) * 5), Math.round(tz + Math.sin(ang) * 5), ty + h + 2, ty + h + 3, B.metalDark);
    }
    c.cone(tx, tz, ty + h + 4, ty + h + 11, 6, 0.7, B.metal);
    c.colFill(tx, tz, ty + h + 12, ty + h + 14, B.metalDark);
    // Internal spiral stair, in the bore rather than buried in the wall, so a watchtower
    // is a post you can actually stand at.
    c.spiralStair(tx, tz, ty, ty + h + 1, 2, B.stone);
    if (!tallest || h > tallest.h) tallest = { x: tx, z: tz, y: ty + h + 1, h };
  }

  // The plaza and its execution scaffold — the single most charged space in the game.
  const py = tierY[2];
  c.plateau(c.cx, c.cz - V(14), V(19), py, { blend: V(4), surface: B.stone, soil: B.rock, fill: B.rock });
  c.ring(c.cx, c.cz - V(14), py, V(18), B.stoneBrick, 2);
  const scz = c.cz - V(20);
  c.box(c.cx - V(6), py + 1, scz - V(4), c.cx + V(6), py + 5, scz + V(4), B.stoneBrick);
  c.box(c.cx - V(5), py + 6, scz - V(3), c.cx + V(5), py + 6, scz + V(3), B.stone);
  for (const s of [-V(4), V(4)]) c.colFill(c.cx + s, scz, py + 7, py + 14, B.woodDark);
  c.box(c.cx - V(4), py + 15, scz, c.cx + V(4), py + 15, scz, B.woodDark);
  c.stairs([c.cx, py, scz + V(7)], [c.cx, py + 6, scz + V(4)], 5, B.stone);
  c.hint('arena', c.cx, py + 1, c.cz - V(14), { tag: 'plaza', radius: 18 });

  // Barracks behind the second wall.
  c.town(rng, [
    { x: c.cx - V(30), z: c.cz - V(4), w: 16, d: 10, h: 6, style: 'barracks', doorSide: 2 },
    { x: c.cx + V(14), z: c.cz - V(4), w: 16, d: 10, h: 6, style: 'barracks', doorSide: 2 },
    { x: c.cx - V(28), z: c.cz + V(12), w: 14, d: 10, h: 5, style: 'barracks', doorSide: 2 },
    { x: c.cx + V(14), z: c.cz + V(12), w: 14, d: 10, h: 5, style: 'barracks', doorSide: 2 },
    { x: c.cx - V(26), z: c.cz + V(21), w: 16, d: 11, h: 7, style: 'keep', doorSide: 2, banner: B.rogerMarine },
  ], 'barracks', { lantern: B.gold });

  // Drydock on the east flank, with a marine warship in it.
  const ddx = X(46), ddz = Z(14);
  c.plateau(ddx, ddz, V(12), Y(-3), { shape: 'rect', rz: V(8), blend: 2, surface: B.stone, soil: B.rock, fill: B.rock });
  c.box(ddx - V(12), Y(-2.5), ddz - V(8), ddx + V(12), Y(8), ddz + V(8), 0);
  c.box(ddx - V(12), Y(-3), ddz - V(8), ddx + V(12), Y(-3), ddz + V(8), B.stone);
  for (let s = 0; s < 3; s++) {
    c.boxShell(ddx - V(12) + s, Y(-2.5) + s * 2, ddz - V(8) + s, ddx + V(12) - s, Y(-2.5) + s * 2 + 1, ddz + V(8) - s, B.stone, 1);
  }
  c.carveRiver([[ddx + V(12), ddz], [X(62), Z(18)], [X(74), Z(22)]], V(8), { depth: V(5), bed: B.stone, bankBlock: B.stone });
  shipHull(c, ddx - V(10), ddz, V(20), V(10), Y(-2), {
    hull: B.plank, rib: B.woodDark, deck: B.plank, mast: 22, sailBlock: B.sail,
  });
  gantryCrane(c, ddx - V(14), ddz + V(6), 20, 12, [1, 0]);

  const dock = pier(c, [X(-14), Z(62)], [X(-16), Z(74)], 7, { deckY: Y(1.5), post: B.stone, deck: B.stone });

  // The processional route. Each wall is pierced on the axis, so a ship sailing in looks
  // straight up the road at the scaffold on the top tier.
  c.path([[X(-14), Z(64)], [X(-7), Z(64)], [X(0), Z(64)]], 6, B.stone, { edge: B.stoneBrick });
  c.stairs([c.cx, Y(1.5), Z(64)], [c.cx, tierY[0], gz + 5], 9, B.stone, { side: B.stoneBrick });
  c.path([[c.cx, gz - 5], [c.cx, c.cz + V(40)]], 7, B.stone, { edge: B.stoneBrick });

  const g1z = c.cz + V(35);
  c.box(c.cx - V(5), tierY[0], g1z - 4, c.cx + V(5), tierY[1] + 10, g1z + 4, 0);
  c.arch(c.cx, g1z, tierY[0], V(10), V(7), 2, B.stone, 'x');
  c.stairs([c.cx, tierY[0], g1z + 6], [c.cx, tierY[1], g1z - 6], 8, B.stone, { side: B.stoneBrick });
  c.path([[c.cx, g1z - 8], [c.cx, c.cz + V(18)]], 6, B.stone, { edge: B.stoneBrick });

  const g2z = c.cz + V(13);
  c.box(c.cx - V(4), tierY[1], g2z - 4, c.cx + V(4), tierY[2] + 9, g2z + 4, 0);
  c.arch(c.cx, g2z, tierY[1], V(8), V(6), 2, B.stone, 'x');
  c.stairs([c.cx, tierY[1], g2z + 6], [c.cx, tierY[2], g2z - 6], 7, B.stone, { side: B.stoneBrick });
  c.path([[c.cx, g2z - 8], [c.cx, c.cz - V(8)]], 6, B.stone, { edge: B.stoneBrick });

  c.path([[X(20), Z(24)], [X(34), Z(20)], [ddx - V(13), ddz]], 5, B.stone, { edge: B.stoneBrick });
  c.stairs([ddx - V(13), tierY[0], ddz], [ddx - V(11), Y(-2), ddz], 4, B.stone);

  // Secret: a sea gate under the west wall, opening into the fortress cisterns.
  c.cave([
    [X(-62), Y(1), Z(16)], [X(-54), Y(2), Z(10)], [X(-46), Y(3), Z(2)], [X(-40), Y(3.5), Z(-6)],
  ], [3.6, 5.4], { floor: B.stone });
  c.arch(X(-61), Z(16), Y(1), V(6), V(4), 2, B.stoneBrick, 'z');
  c.colFill(X(-40), Z(-6), Y(3.5), Y(4.5), B.gold);

  c.scatter(rng, { cx: c.cx, cz: c.cz, r: V(66), r0: V(46), spacing: 8 }, 0.45, (x, z, y, r) => {
    const hM = (y - c.seaLevel) * VOXEL_M;
    if (hM < 1.2 || hM > 6) return;
    if (r.chance(0.45)) c.tree(x, z, 'pine', r, { scale: 0.75 });
    else c.cyl(x, z, y, y + r.int(1, 2), 1.4, B.rock);
  });

  c.mark('dock', X(-16), Z(72), { y: dock + 1, yaw: 0 });
  c.mark('plaza', c.cx, c.cz - V(10), { y: py + 1 });
  c.mark('boss_arena', c.cx, c.cz - V(14), { y: py + 1 });
  c.mark('vista', tallest.x + 4, tallest.z, { y: tallest.y + 1 });
  c.mark('secret', X(-40), Z(-6), { y: Y(3.5) });
  c.mark('npc_1', X(-14), Z(58));
  c.mark('npc_2', c.cx + V(8), gz - 8, { y: tierY[0] + 1 });
  c.mark('npc_3', c.cx - V(10), c.cz + V(6));
  c.mark('npc_4', X(30), Z(21));
  c.mark('chest_1', X(-40), Z(-6), { y: Y(3.5) });
  c.mark('chest_2', tallest.x - 4, tallest.z, { y: tallest.y + 1 });
  c.mark('chest_3', ddx + V(6), ddz + V(5), { y: Y(-2) + 1 });
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

/**
 * The eight authored landmark islands, west to east along the Grand Line route.
 *
 * Fields:
 *  id             stable camelCase key; save data references this, never the index
 *  worldPos       [x, z] world metres of the island centre
 *  radius         authored coastline radius in metres (used for streaming and for dims)
 *  maxHeight      highest authored point in metres above sea level
 *  dockPos        [x, z] in LOCAL metres — where a ship moors
 *  dockYaw        radians; yaw a moored ship takes (atan2(dx, dz), -Z is north)
 *  spawnPoints    authored [x, z] local metres; build() resolves the y and republishes
 *                 them on canvas.spawnPoints with the ground height filled in
 *  ambience       AUDIO owner's bed description
 *  weatherBias    weights over the WEATHER presets in render/sky.js
 *  musicState     MUSIC state key
 * @type {Array<object>}
 */
export const LANDMARKS = [
  {
    id: 'shellsCove',
    name: 'Shells Cove',
    biome: 'coast',
    worldPos: [-7200, 0],
    radius: 62,
    maxHeight: 36,
    difficultyTier: 1,
    dockPos: [-4, 38],
    dockYaw: 0,
    spawnPoints: {
      dock: [-4, 38], plaza: [-8, 5], boss_arena: [-34, 28], vista: [51.5, -8], secret: [20.5, -6],
      npc_1: [-6, 17], npc_2: [-5.5, -0.5], npc_3: [18, -3], npc_4: [-4, 30],
      chest_1: [49, -5], chest_2: [20.5, -6], chest_3: [-31, 25],
    },
    build: buildShellsCove,
    ambience: { bed: 'shore', wind: 0.35, water: 0.75, wildlife: 0.55, crowd: 0.35, machinery: 0 },
    weatherBias: { clear: 0.62, breezy: 0.28, overcast: 0.08, squall: 0.02, storm: 0 },
    musicState: 'town_calm',
    description: 'A sandy crescent bay under a lighthouse that has leaned east for eighty years. '
      + 'Nets dry on the seafront, the well is the centre of the world, and the bandits on the '
      + 'western spit are the worst thing that has ever happened here.',
  },
  {
    id: 'palmReach',
    name: 'Palm Reach',
    biome: 'jungle',
    worldPos: [-5200, 400],
    radius: 70,
    maxHeight: 40,
    difficultyTier: 2,
    dockPos: [-11, 27],
    dockYaw: Math.PI * 0.5,
    spawnPoints: {
      dock: [-11, 27], plaza: [-20, -16], boss_arena: [-27, 23], vista: [0, -40], secret: [-12, -48],
      npc_1: [-16, 27], npc_2: [-21, -14], npc_3: [-28, 19], npc_4: [-14, -2],
      chest_1: [-12, -48], chest_2: [20, -2], chest_3: [-2, -40],
    },
    build: buildPalmReach,
    ambience: { bed: 'jungle', wind: 0.25, water: 0.85, wildlife: 1.0, crowd: 0.1, machinery: 0 },
    weatherBias: { clear: 0.42, breezy: 0.3, overcast: 0.18, squall: 0.1, storm: 0 },
    musicState: 'explore_wild',
    description: 'Three plateaus stacked like plates, with one river falling off all of them into '
      + 'a lagoon. Rope bridges string the canopy between four trees older than the route itself, '
      + 'and there is a dry room behind the top fall that somebody has clearly been using.',
  },
  {
    id: 'cogHarbour',
    name: 'Cog Harbour',
    biome: 'industrial',
    worldPos: [-3000, -300],
    radius: 68,
    maxHeight: 30,
    difficultyTier: 3,
    dockPos: [57, 29],
    dockYaw: Math.PI * 0.75,
    spawnPoints: {
      dock: [57, 29], plaza: [-2, -32], boss_arena: [14, 2], vista: [1, -40], secret: [-30, 38],
      npc_1: [45, 18], npc_2: [-4, -12], npc_3: [-30, 34], npc_4: [4, -16],
      chest_1: [18.5, -1], chest_2: [-5, -40], chest_3: [-36, 40],
    },
    build: buildCogHarbour,
    ambience: { bed: 'port', wind: 0.4, water: 0.6, wildlife: 0.15, crowd: 0.6, machinery: 1.0 },
    weatherBias: { clear: 0.3, breezy: 0.3, overcast: 0.28, squall: 0.1, storm: 0.02 },
    musicState: 'town_busy',
    description: 'A working port cut square out of the rock, half of it standing on stilts over its '
      + 'own shallows. Three cranes lean out over the water, the bell tower rings the shifts, and '
      + 'there is a ship in the drydock that has been half-built for a suspiciously long time.',
  },
  {
    id: 'drumPeaks',
    name: 'Drum Peaks',
    biome: 'snow',
    worldPos: [-900, 600],
    radius: 76,
    maxHeight: 62,
    difficultyTier: 4,
    dockPos: [-8, 60],
    dockYaw: 0,
    spawnPoints: {
      dock: [-8, 60], plaza: [-16, 38], boss_arena: [4, 22], vista: [-16, -32], secret: [24, -18],
      npc_1: [-8, 52], npc_2: [-18, 37], npc_3: [-6, -22], npc_4: [14, 37],
      chest_1: [24, -18], chest_2: [-10, -32], chest_3: [13, 15],
    },
    build: buildDrumPeaks,
    ambience: { bed: 'alpine', wind: 0.9, water: 0.35, wildlife: 0.25, crowd: 0.3, machinery: 0.2 },
    weatherBias: { clear: 0.28, breezy: 0.24, overcast: 0.3, squall: 0.14, storm: 0.04 },
    musicState: 'explore_cold',
    description: 'Two peaks with a castle wedged in the saddle between them, flying a white cross '
      + 'because it is a hospital and has been for two hundred years. A cable car climbs to it from '
      + 'the shore. The lake below freezes hard enough to fight on.',
  },
  {
    id: 'emberfall',
    name: 'Emberfall',
    biome: 'volcanic',
    worldPos: [1400, -500],
    radius: 72,
    maxHeight: 48,
    difficultyTier: 4,
    dockPos: [-49, -53],
    dockYaw: Math.PI * 1.25,
    spawnPoints: {
      dock: [-49, -53], plaza: [-30, -28], boss_arena: [-9, 0], vista: [-9.5, -3], secret: [0, 20],
      npc_1: [-42, -40], npc_2: [-36, -27], npc_3: [-26.5, -27], npc_4: [-14, -20],
      chest_1: [0, 20], chest_2: [28.5, -15.5], chest_3: [8, 5],
    },
    build: buildEmberfall,
    ambience: { bed: 'volcanic', wind: 0.5, water: 0.3, wildlife: 0.05, crowd: 0.3, machinery: 0.5 },
    weatherBias: { clear: 0.35, breezy: 0.25, overcast: 0.25, squall: 0.12, storm: 0.03 },
    musicState: 'explore_hostile',
    description: 'A cone with its top opened, a lava lake at the bottom of the hole and three '
      + 'channels of it running down the flanks to a black-sand shore. Obsidian needles lean out '
      + 'of the ash. The smiths built their village upwind and tapped the mountain for heat.',
  },
  {
    id: 'whisperSands',
    name: 'Whisper Sands',
    biome: 'desert',
    worldPos: [3400, 300],
    radius: 78,
    maxHeight: 28,
    difficultyTier: 5,
    dockPos: [-2, 68],
    dockYaw: 0,
    spawnPoints: {
      dock: [-2, 68], plaza: [-6, 18], boss_arena: [-6, 12], vista: [36, -16], secret: [-12, -46],
      npc_1: [-2, 56], npc_2: [-27, -10], npc_3: [-14, 16], npc_4: [33, -5],
      chest_1: [-12, -46], chest_2: [30, -16], chest_3: [-42, 1],
    },
    build: buildWhisperSands,
    ambience: { bed: 'desert', wind: 1.0, water: 0.2, wildlife: 0.1, crowd: 0.15, machinery: 0 },
    weatherBias: { clear: 0.66, breezy: 0.22, overcast: 0.08, squall: 0.04, storm: 0 },
    musicState: 'explore_ruins',
    description: 'A city the dunes ate. Roofs and column tops break the sand in a grid you can '
      + 'still read as streets, and a stone arch two hundred feet across stands over the whole '
      + 'thing, older than the city and in much better repair.',
  },
  {
    id: 'blossomTerrace',
    name: 'Blossom Terrace',
    biome: 'blossom',
    worldPos: [5300, -700],
    radius: 72,
    maxHeight: 58,
    difficultyTier: 5,
    dockPos: [0, 62],
    dockYaw: 0,
    spawnPoints: {
      dock: [0, 62], plaza: [0, 11], boss_arena: [26, 6], vista: [-12, 0], secret: [-4, -30],
      npc_1: [0, 50], npc_2: [-34, -12], npc_3: [-24, 10], npc_4: [17, 12],
      chest_1: [-4, -30], chest_2: [0, 0], chest_3: [-26, -30],
    },
    build: buildBlossomTerrace,
    ambience: { bed: 'garden', wind: 0.4, water: 0.4, wildlife: 0.6, crowd: 0.35, machinery: 0 },
    weatherBias: { clear: 0.5, breezy: 0.34, overcast: 0.12, squall: 0.04, storm: 0 },
    musicState: 'town_serene',
    description: 'Cut terraces all the way up, a straight stair of nine torii from the water to '
      + 'the summit, and a five-tier pagoda on top that catches the sun an hour before the sea '
      + 'does. Somebody rakes the duelling ground every morning. Somebody uses it every evening.',
  },
  {
    id: 'marinefordReach',
    name: 'Marineford Reach',
    biome: 'fortress',
    worldPos: [7200, 0],
    radius: 80,
    maxHeight: 42,
    difficultyTier: 5,
    dockPos: [-16, 72],
    dockYaw: 0,
    spawnPoints: {
      dock: [-16, 72], plaza: [0, -10], boss_arena: [0, -14], vista: [-8, -26], secret: [-40, -6],
      npc_1: [-14, 58], npc_2: [8, 52], npc_3: [-10, 6], npc_4: [30, 21],
      chest_1: [-40, -6], chest_2: [-12, -26], chest_3: [52, 19],
    },
    build: buildMarinefordReach,
    ambience: { bed: 'fortress', wind: 0.6, water: 0.5, wildlife: 0.1, crowd: 0.7, machinery: 0.35 },
    weatherBias: { clear: 0.4, breezy: 0.3, overcast: 0.2, squall: 0.08, storm: 0.02 },
    musicState: 'tension_high',
    description: 'Three rings of white stone stepping up out of the sea to a plaza with a scaffold '
      + 'in the middle of it. The great gate is on the axis so that anyone sailing in has to look '
      + 'straight up the road at what waits at the top of it.',
  },
];

/** Landmarks keyed by id. */
export const LANDMARK_BY_ID = new Map(LANDMARKS.map((l) => [l.id, l]));

/** @param {string} id @returns {object|undefined} */
export function getLandmark(id) { return LANDMARK_BY_ID.get(id); }

/** Ids in route order, west to east. */
export const LANDMARK_ORDER = LANDMARKS.map((l) => l.id);

// ---------------------------------------------------------------------------
// Minor islands
// ---------------------------------------------------------------------------

/**
 * Minor-island archetypes. Each one has a different silhouette on purpose: a ring, a stack,
 * a wedge, a dot, a dome, a broken cylinder, a mushroom cluster and a slab. Two of them
 * next to each other should never be mistaken for one another.
 * `tiers` gates where an archetype can appear along the route.
 */
export const MINOR_ARCHETYPES = [
  { id: 'atoll', name: 'Atoll', biome: 'coast', radius: 34, maxHeight: 7, tiers: [1, 2, 3, 4, 5] },
  { id: 'spireStack', name: 'Spire Stack', biome: 'rock', radius: 20, maxHeight: 30, tiers: [1, 2, 3, 4, 5] },
  { id: 'wreckIsle', name: 'Wreck', biome: 'coast', radius: 26, maxHeight: 8, tiers: [1, 2, 3, 4, 5] },
  { id: 'sandbar', name: 'Sandbar', biome: 'coast', radius: 15, maxHeight: 4, tiers: [1, 2, 3, 4, 5] },
  { id: 'jungleKnuckle', name: 'Jungle Knuckle', biome: 'jungle', radius: 28, maxHeight: 24, tiers: [1, 2, 3, 4, 5] },
  { id: 'ruinedWatch', name: 'Ruined Watchtower', biome: 'ruins', radius: 24, maxHeight: 22, tiers: [2, 3, 4, 5] },
  { id: 'mushroomShelf', name: 'Mushroom Shelf', biome: 'fungal', radius: 27, maxHeight: 16, tiers: [2, 3, 4, 5] },
  { id: 'frostFloe', name: 'Frost Floe', biome: 'snow', radius: 30, maxHeight: 10, tiers: [3, 4, 5] },
];

/** Ring of sand and coral around a shallow lagoon, with palms on the windward arc. */
function minorAtoll(c, rng) {
  const B = c.B;
  const { X, Z, Y, V } = axes(c);
  const shore = coast(c, [
    [0, -30], [20, -24], [29, -6], [26, 15], [12, 27], [-8, 30],
    [-24, 21], [-30, 2], [-24, -18],
  ], 5);
  c.heightmapFromPolygon(shore, {
    peak: V(3.5), edge: 1, reach: V(8), shelf: V(11), profile: 'dome', noise: 1.2,
    fill: B.coral, soil: B.sand, soilDepth: 3, surface: B.sand, seedTag: 41,
  });
  c.crater(c.cx, c.cz, V(15), V(6), { surface: B.sand, soil: B.sand, fill: B.coral, floorFlat: 0.6 });
  c.carveRiver([[X(0), Z(14)], [X(2), Z(26)], [X(3), Z(36)]], V(6), { depth: V(4), bed: B.sand, bankBlock: B.coral });
  c.beach(4, { depth: 3, jitter: 2 });
  c.scatter(rng, { cx: c.cx, cz: c.cz, r: V(26), r0: V(15), spacing: 6 }, 0.7, (x, z, y, r) => {
    if (r.chance(0.62)) c.tree(x, z, 'palm', r);
    else c.set(x, y + 1, z, B.coral);
  });
  for (let i = 0; i < 5; i++) {
    const a = rng.f() * TAU;
    const px = Math.round(c.cx + Math.cos(a) * V(11)), pz = Math.round(c.cz + Math.sin(a) * V(11));
    const g = c.groundY(px, pz);
    if (g > 0) c.sphere(px, g + 1, pz, rng.range(1.4, 2.6), B.coral, { hemisphere: true, squash: 0.6 });
  }
  const g = Math.max(1, c.groundY(X(-14), Z(14)));
  c.colFill(X(-14), Z(14), g + 1, g + 1, B.barrel);
  c.mark('landing', X(0), Z(20), { y: Y(0.5) });
  c.mark('vista', X(-22), Z(0));
  c.mark('chest_1', X(-14), Z(14));
}

/** A stack of leaning rock needles on a tiny plinth. Nothing grows here. */
function minorSpireStack(c, rng) {
  const B = c.B;
  const { X, Z, Y, V } = axes(c);
  const shore = coast(c, [[0, -17], [13, -11], [17, 3], [9, 15], [-6, 17], [-16, 6], [-14, -9]], 4);
  c.heightmapFromPolygon(shore, {
    peak: V(6), edge: 1, reach: V(7), shelf: V(9), profile: 'cliff', noise: 1.6,
    fill: B.rock, soil: B.rock, soilDepth: 1, surface: B.rock, seedTag: 43,
  });
  const spires = [[0, 0, 28, 4.6], [-8, 5, 19, 3.2], [7, -6, 22, 3.4], [4, 9, 13, 2.6], [-6, -8, 15, 2.4]];
  for (const [mx, mz, h, r] of spires) {
    const px = X(mx), pz = Z(mz);
    const g = Math.max(1, c.groundY(px, pz));
    c.cone(px, pz, g - 2, g + V(h * 0.5), r, 0.8, B.rock, { lean: [rng.int(-3, 3), rng.int(-3, 3)] });
  }
  c.beach(2, { depth: 1, jitter: 1.2 });
  // A gull-nest ledge on the tallest needle, with the one thing worth climbing for.
  const ty = c.solidTop(X(0), Z(0));
  c.disc(X(0), Z(0), ty + 1, 3, B.dirt);
  c.ring(X(0), Z(0), ty + 2, 2.6, B.wood, 1);
  c.colFill(X(0), Z(0), ty + 2, ty + 2, B.gold);
  for (let k = 1; k <= ty - c.seaLevel; k++) c.set(X(2), c.seaLevel + k, Z(0), B.rope);
  c.mark('landing', X(-10), Z(9));
  c.mark('vista', X(0), Z(0), { y: ty + 2 });
  c.mark('chest_1', X(0), Z(0), { y: ty + 2 });
}

/** A sandbar with a broken ship on it, mast down, cargo strewn up the beach. */
function minorWreckIsle(c, rng) {
  const B = c.B;
  const { X, Z, Y, V } = axes(c);
  const shore = coast(c, [[0, -22], [16, -17], [23, -2], [18, 14], [3, 22], [-13, 18], [-22, 3], [-17, -13]], 5);
  c.heightmapFromPolygon(shore, {
    peak: V(3), edge: 1, reach: V(10), shelf: V(10), profile: 'dome', noise: 1.4,
    fill: B.rock, soil: B.sand, soilDepth: 3, surface: B.sand, seedTag: 47,
  });
  c.ridge([X(-12), Z(-8)], [X(10), Z(4)], V(6), V(7), { fill: B.rock, soil: B.sand, soilDepth: 2, surface: B.sand });
  c.beach(5, { depth: 3, jitter: 2.6 });
  // The hull, driven up the beach at an angle and broken amidships.
  const hy = Math.max(c.seaLevel + 1, c.groundY(X(-4), Z(2)));
  shipHull(c, X(-14), Z(2), V(16), V(8), hy, { hull: B.plank, rib: B.woodDark, deck: B.plank, lean: 3, ribsOnly: false });
  c.box(X(-2), hy - 1, Z(-1), X(2), hy + 3, Z(5), 0);          // the break
  shipHull(c, X(3), Z(6), V(9), V(6), hy - 1, { hull: B.plank, rib: B.woodDark, ribsOnly: true, lean: -2 });
  // Fallen mast lying across the sand with its rigging still attached.
  for (let i = 0; i < 24; i++) c.set(X(-8) + i, hy + 1 + (i > 14 ? -1 : 0), Z(-9) + Math.round(i * 0.35), B.wood);
  for (let i = 0; i < 10; i++) c.setAir(X(-6) + i * 2, hy + 2, Z(-10) + i, B.sailShade);
  c.scatter(rng, { cx: c.cx, cz: c.cz, r: V(19), spacing: 5 }, 0.55, (x, z, y, r) => {
    const kk = r.f();
    if (kk < 0.4) c.colFill(x, z, y + 1, y + 1 + r.int(0, 1), B.barrel);
    else if (kk < 0.62) c.set(x, y + 1, z, B.plank);
    else if (kk < 0.78) c.tree(x, z, 'palm', r, { scale: 0.8 });
  });
  c.colFill(X(-11), Z(2), hy + 1, hy + 1, B.gold);
  c.mark('landing', X(4), Z(16));
  c.mark('vista', X(-14), Z(-6));
  c.mark('chest_1', X(-11), Z(2), { y: hy + 1 });
}

/** A dot of sand with exactly one palm and one piece of driftwood. The joke island. */
function minorSandbar(c, rng) {
  const B = c.B;
  const { X, Z, Y, V } = axes(c);
  const shore = coast(c, [[0, -11], [8, -7], [11, 2], [6, 10], [-3, 11], [-10, 4], [-9, -6]], 4);
  c.heightmapFromPolygon(shore, {
    peak: V(1.6), edge: 1, reach: V(6), shelf: V(9), profile: 'dome', noise: 0.8,
    fill: B.sand, soil: B.sand, soilDepth: 3, surface: B.sand, seedTag: 53,
  });
  c.beach(4, { depth: 3, jitter: 1.6 });
  c.tree(X(1), Z(-1), 'palm', rng, { scale: 1.25 });
  for (let i = 0; i < 5; i++) c.set(X(-4) + i, c.groundY(X(-4) + i, Z(5)) + 1, Z(5) + (i > 2 ? 1 : 0), B.woodDark);
  const g = c.groundY(X(-3), Z(-4));
  c.colFill(X(-3), Z(-4), g + 1, g + 1, B.barrel);
  c.mark('landing', X(0), Z(7));
  c.mark('vista', X(1), Z(-1));
  c.mark('chest_1', X(-3), Z(-4));
}

/** A steep green fist of rock: all canopy, no beach to speak of, vines to the water. */
function minorJungleKnuckle(c, rng) {
  const B = c.B;
  const { X, Z, Y, V } = axes(c);
  const shore = coast(c, [[0, -25], [18, -18], [25, -1], [19, 16], [2, 25], [-16, 19], [-25, 1], [-19, -17]], 5);
  c.heightmapFromPolygon(shore, {
    peak: V(21), edge: 2, reach: V(16), shelf: V(9), profile: 'cliff', noise: 2.6,
    fill: B.rock, soil: B.dirt, soilDepth: 3, surface: B.jungle, seedTag: 59,
  });
  c.beach(2, { depth: 2, jitter: 1.4 });
  c.paint((x, z, y, i) => (i.slope >= 4 && i.hM > 3 ? B.rock : undefined));
  c.scatter(rng, { cx: c.cx, cz: c.cz, r: V(22), spacing: 5 }, 0.85, (x, z, y, r) => {
    const hM = (y - c.seaLevel) * VOXEL_M;
    if (hM < 1) return;
    if (r.chance(0.7)) c.tree(x, z, 'jungle', r, { scale: r.range(0.7, 1.1) });
    else c.tree(x, z, 'palm', r, { scale: 0.8 });
  });
  // Vines down the seaward cliff — the archetype's identity read.
  for (let i = 0; i < 14; i++) {
    const a = rng.f() * TAU;
    const px = Math.round(c.cx + Math.cos(a) * V(19)), pz = Math.round(c.cz + Math.sin(a) * V(19));
    const g = c.groundY(px, pz);
    if (g < c.seaLevel + 4) continue;
    for (let k = 0; k < rng.int(4, 12); k++) c.setAir(px, g - k, pz, B.leaves);
  }
  const tx = X(0), tz = Z(0);
  const ty = c.groundY(tx, tz);
  c.disc(tx, tz, ty, 3, B.dirt);
  c.colFill(tx, tz, ty + 1, ty + 1, B.gold);
  c.mark('landing', X(2), Z(21));
  c.mark('vista', tx, tz);
  c.mark('chest_1', tx, tz);
}

/** A broken stone watchtower on a rock plinth, with a cold brazier at the door. */
function minorRuinedWatch(c, rng) {
  const B = c.B;
  const { X, Z, Y, V } = axes(c);
  const shore = coast(c, [[0, -21], [15, -15], [21, 1], [14, 15], [-2, 21], [-16, 13], [-21, -3], [-13, -16]], 4);
  c.heightmapFromPolygon(shore, {
    peak: V(8), edge: 2, reach: V(11), shelf: V(10), profile: 'mesa', noise: 1.8,
    fill: B.rock, soil: B.dirt, soilDepth: 2, surface: B.grassDry, seedTag: 61,
  });
  c.beach(3, { depth: 2, jitter: 1.8 });
  c.plateau(c.cx, c.cz, V(9), Y(8), { blend: V(4), surface: B.stone, soil: B.rock, fill: B.rock });
  const g = c.groundY(c.cx, c.cz);
  // The tower, broken off on one side so it reads as a ruin from any angle.
  const h = 26;
  for (let y = 0; y <= h; y++) {
    const gap = y > 12 ? Math.min(0.5, (y - 12) * 0.05) : 0;
    c.ring(c.cx, c.cz, g + y, 5, B.stone, 2);
    if (gap > 0) {
      for (let a = 0; a < TAU * gap && a < TAU; a += 0.12) {
        c.set(Math.round(c.cx + Math.cos(a + 1.2) * 5), g + y, Math.round(c.cz + Math.sin(a + 1.2) * 5), 0);
      }
    }
  }
  c.disc(c.cx, c.cz, g, 5, B.stone);
  c.box(c.cx - 1, g + 1, c.cz + 5, c.cx + 1, g + 3, c.cz + 5, 0);
  for (let k = 0; k <= h - 4; k++) {
    const a = k * 0.45;
    c.set(Math.round(c.cx + Math.cos(a) * 3), g + k, Math.round(c.cz + Math.sin(a) * 3), B.stone);
  }
  c.cyl(c.cx + 6, c.cz + 7, g + 1, g + 2, 1.6, B.metalDark);
  c.set(c.cx + 6, g + 3, c.cz + 7, B.ash);
  // Fallen masonry scattered downhill.
  c.scatter(rng, { cx: c.cx, cz: c.cz, r: V(18), r0: V(7), spacing: 5 }, 0.6, (x, z, y, r) => {
    if (r.chance(0.5)) c.cyl(x, z, y, y + r.int(1, 3), r.range(1.2, 2.2), B.stone);
    else c.tree(x, z, 'dead', r, { scale: 0.7 });
  });
  c.colFill(c.cx, c.cz, g + h - 3, g + h - 3, B.gold);
  c.mark('landing', X(0), Z(17));
  c.mark('vista', c.cx, c.cz, { y: g + h - 3 });
  c.mark('chest_1', c.cx, c.cz, { y: g + h - 3 });
}

/** A damp shelf of rock carrying a forest of oversized mushrooms. */
function minorMushroomShelf(c, rng) {
  const B = c.B;
  const { X, Z, Y, V } = axes(c);
  const shore = coast(c, [[0, -24], [17, -18], [24, -2], [18, 16], [1, 24], [-17, 17], [-24, 0], [-17, -17]], 5);
  c.heightmapFromPolygon(shore, {
    peak: V(11), edge: 2, reach: V(9), shelf: V(10), profile: 'mesa', noise: 1.4,
    fill: B.rock, soil: B.dirt, soilDepth: 3, surface: B.grassCold, seedTag: 67,
  });
  c.beach(3, { depth: 2, jitter: 1.6 });
  c.terrace({ cx: c.cx, cz: c.cz, r: V(20), step: 5, base: c.seaLevel + 4, wall: B.rock, surface: B.grassCold, fill: B.dirt });
  c.scatter(rng, { cx: c.cx, cz: c.cz, r: V(21), spacing: 6 }, 0.85, (x, z, y, r) => {
    const hM = (y - c.seaLevel) * VOXEL_M;
    if (hM < 1) return;
    const sh = r.int(3, 8);
    c.colFill(x, z, y + 1, y + sh, B.mushroomStem);
    const cr = r.range(2.6, 4.6);
    c.sphere(x, y + sh + 1, z, cr, B.mushroomCap, { squash: 0.55, hemisphere: true });
    c.disc(x, z, y + sh, cr - 0.8, B.mushroomStem);
  });
  const g = c.groundY(c.cx, c.cz);
  c.colFill(c.cx, c.cz, g + 1, g + 1, B.gold);
  c.mark('landing', X(0), Z(20));
  c.mark('vista', X(-8), Z(-8));
  c.mark('chest_1', c.cx, c.cz);
}

/** A low ice slab with a pressure ridge and a frozen-in mast. */
function minorFrostFloe(c, rng) {
  const B = c.B;
  const { X, Z, Y, V } = axes(c);
  const shore = coast(c, [[0, -27], [21, -20], [28, -2], [21, 18], [2, 28], [-19, 20], [-28, 0], [-20, -19]], 4);
  c.heightmapFromPolygon(shore, {
    peak: V(2.5), edge: 1, reach: V(9), shelf: V(11), profile: 'mesa', noise: 1.2,
    fill: B.ice, soil: B.ice, soilDepth: 3, surface: B.snow, seedTag: 71,
  });
  // Pressure ridge: where two floes met and one lost.
  c.ridge([X(-20), Z(6)], [X(18), Z(-8)], V(9), V(7), { fill: B.ice, soil: B.ice, soilDepth: 2, surface: B.ice, falloff: 'cliff' });
  c.beach(2, { sand: B.snow, wet: B.ice, depth: 2, jitter: 2 });
  c.paint((x, z, y, i) => (i.slope >= 3 ? B.ice : B.snow));
  // A mast sticking out of the floe, which is all that is left of whoever tried this route.
  const g = Math.max(1, c.groundY(X(6), Z(10)));
  for (let k = 1; k <= 16; k++) c.set(X(6) + Math.round(k * 0.18), g + k, Z(10), B.wood);
  for (let i = -4; i <= 4; i++) c.set(X(7), g + 12, Z(10) + i, B.woodDark);
  for (let i = -3; i <= 3; i++) c.setAir(X(7), g + 11, Z(10) + i, B.sailShade);
  c.scatter(rng, { cx: c.cx, cz: c.cz, r: V(24), spacing: 7 }, 0.6, (x, z, y, r) => {
    const kk = r.f();
    if (kk < 0.5) c.cone(x, z, y, y + r.int(2, 6), r.range(1.4, 2.6), 0.7, B.ice, { lean: [r.int(-1, 1), r.int(-1, 1)] });
    else if (kk < 0.7) c.sphere(x, y + 1, z, r.range(1.4, 2.4), B.ice, { hemisphere: true, squash: 0.5 });
  });
  c.colFill(X(-10), Z(-6), Math.max(1, c.groundY(X(-10), Z(-6))) + 1, Math.max(1, c.groundY(X(-10), Z(-6))) + 1, B.gold);
  c.mark('landing', X(0), Z(22));
  c.mark('vista', X(0), Z(-2));
  c.mark('chest_1', X(-10), Z(-6));
}

const MINOR_BUILDERS = {
  atoll: minorAtoll,
  spireStack: minorSpireStack,
  wreckIsle: minorWreckIsle,
  sandbar: minorSandbar,
  jungleKnuckle: minorJungleKnuckle,
  ruinedWatch: minorRuinedWatch,
  mushroomShelf: minorMushroomShelf,
  frostFloe: minorFrostFloe,
};

const MINOR_AMBIENCE = {
  atoll: { bed: 'shore', wind: 0.4, water: 0.9, wildlife: 0.5, crowd: 0, machinery: 0 },
  spireStack: { bed: 'cliff', wind: 0.9, water: 0.7, wildlife: 0.4, crowd: 0, machinery: 0 },
  wreckIsle: { bed: 'shore', wind: 0.6, water: 0.8, wildlife: 0.3, crowd: 0, machinery: 0 },
  sandbar: { bed: 'shore', wind: 0.3, water: 0.95, wildlife: 0.2, crowd: 0, machinery: 0 },
  jungleKnuckle: { bed: 'jungle', wind: 0.3, water: 0.7, wildlife: 0.9, crowd: 0, machinery: 0 },
  ruinedWatch: { bed: 'ruins', wind: 0.8, water: 0.6, wildlife: 0.2, crowd: 0, machinery: 0 },
  mushroomShelf: { bed: 'fungal', wind: 0.35, water: 0.5, wildlife: 0.5, crowd: 0, machinery: 0 },
  frostFloe: { bed: 'alpine', wind: 1.0, water: 0.6, wildlife: 0.1, crowd: 0, machinery: 0 },
};

const MINOR_WEATHER = {
  atoll: { clear: 0.66, breezy: 0.26, overcast: 0.06, squall: 0.02, storm: 0 },
  spireStack: { clear: 0.36, breezy: 0.32, overcast: 0.22, squall: 0.09, storm: 0.01 },
  wreckIsle: { clear: 0.42, breezy: 0.3, overcast: 0.2, squall: 0.07, storm: 0.01 },
  sandbar: { clear: 0.74, breezy: 0.2, overcast: 0.06, squall: 0, storm: 0 },
  jungleKnuckle: { clear: 0.4, breezy: 0.28, overcast: 0.2, squall: 0.12, storm: 0 },
  ruinedWatch: { clear: 0.34, breezy: 0.28, overcast: 0.28, squall: 0.09, storm: 0.01 },
  mushroomShelf: { clear: 0.26, breezy: 0.24, overcast: 0.38, squall: 0.1, storm: 0.02 },
  frostFloe: { clear: 0.24, breezy: 0.26, overcast: 0.32, squall: 0.15, storm: 0.03 },
};

const MINOR_DESCRIPTION = {
  atoll: 'A ring of coral and sand around water so shallow you can read the bottom of it.',
  spireStack: 'Five rock needles leaning on each other above a plinth barely wider than they are.',
  wreckIsle: 'Something big came ashore here at speed and never left. The mast is still rigged.',
  sandbar: 'Sand, one palm, one plank. Charts do not agree that it is there.',
  jungleKnuckle: 'A green fist of rock with no landing, vines hanging into the water all round it.',
  ruinedWatch: 'A watchtower snapped off at the shoulder, still holding the highest ground for miles.',
  mushroomShelf: 'Damp stepped rock under a canopy of mushrooms tall enough to shelter under.',
  frostFloe: 'A slab of old ice with a pressure ridge across it and a mast frozen upright in it.',
};

/**
 * Build one minor island. Archetype, size and dressing are all chosen from `rng` and the
 * tier, so the same (seed, worldPos, tier) always produces the same island.
 *
 * @param {import('../core/rng.js').Rng} rng
 * @param {[number,number]} worldPos world metres of the island centre
 * @param {number} tier 1..5, gates which archetypes may appear
 * @param {{B: Record<string, number>, archetype?: string}} ctx block registry map, plus an
 *        optional archetype id to force (authored placement and tests use this)
 * @returns {object} a built-island record with the same shape buildLandmark returns
 */
export function generateMinorIsland(rng, worldPos, tier, ctx = {}) {
  const t = clamp(Math.round(tier) || 1, 1, 5);
  const pool = MINOR_ARCHETYPES.filter((a) => a.tiers.indexOf(t) >= 0);
  const forced = ctx.archetype ? MINOR_ARCHETYPES.find((a) => a.id === ctx.archetype) : null;
  if (ctx.archetype && !forced) throw new Error('islands: unknown minor archetype "' + ctx.archetype + '"');
  const arch = forced || pool[rng.u32() % pool.length];
  const scale = lerp(0.85, 1.15, rng.f());
  const radius = Math.round(arch.radius * scale);
  const maxHeight = Math.round(arch.maxHeight * scale) + 2;
  const dims = islandDims(radius, maxHeight);
  const seed = rng.u32();
  const c = new IslandCanvas({ ...dims, B: ctx.B || {}, seed });
  const buildRng = new Rng(seed);
  MINOR_BUILDERS[arch.id](c, buildRng);

  const landing = c.spawnPoints.landing || { x: 0, y: 1, z: radius * 0.6 };
  const id = 'minor_' + arch.id + '_' + (worldPos[0] | 0) + '_' + (worldPos[1] | 0);
  return {
    id,
    name: arch.name,
    biome: arch.biome,
    archetype: arch.id,
    kind: 'minor',
    worldPos: [worldPos[0], worldPos[1]],
    radius,
    maxHeight,
    difficultyTier: t,
    seed,
    dockPos: [landing.x, landing.z],
    dockYaw: Math.atan2(landing.x, landing.z),
    canvas: c,
    spawnPoints: c.spawnPoints,
    markers: c.markers,
    ambience: MINOR_AMBIENCE[arch.id],
    weatherBias: MINOR_WEATHER[arch.id],
    musicState: t >= 4 ? 'explore_hostile' : 'explore_calm',
    description: MINOR_DESCRIPTION[arch.id],
  };
}

/**
 * Build a landmark island into a fresh canvas.
 *
 * @param {object|string} def a LANDMARKS entry or its id
 * @param {{B: Record<string, number>, seed?: number}} ctx block map plus the world seed
 * @returns {object} { def, canvas, spawnPoints, markers, ... } — the same record shape
 *          generateMinorIsland returns, so WORLD can treat both identically
 */
export function buildLandmark(def, ctx = {}) {
  const d = typeof def === 'string' ? LANDMARK_BY_ID.get(def) : def;
  if (!d) throw new Error('islands: unknown landmark "' + def + '"');
  const worldSeed = (ctx.seed >>> 0) || 20260814;
  const dims = islandDims(d.radius, d.maxHeight);
  const seed = Rng.fromName(worldSeed, 'island:' + d.id).u32();
  const c = new IslandCanvas({ ...dims, B: ctx.B || {}, seed });
  const rng = new Rng(seed);
  d.build(c, rng, { def: d, worldSeed, tier: d.difficultyTier, B: ctx.B || {} });

  // Authored spawn points are the intent; build() publishes the resolved ones. Any that
  // build() did not resolve fall back to the authored [x, z] at the terrain surface.
  for (const key of REQUIRED_SPAWNS) {
    if (c.spawnPoints[key]) continue;
    const p = d.spawnPoints[key];
    if (!p) throw new Error('islands: ' + d.id + ' is missing spawn point "' + key + '"');
    c.mark(key, c.vx(p[0]), c.vz(p[1]));
  }

  return {
    id: d.id,
    name: d.name,
    biome: d.biome,
    kind: 'landmark',
    archetype: d.id,
    worldPos: d.worldPos,
    radius: d.radius,
    maxHeight: d.maxHeight,
    difficultyTier: d.difficultyTier,
    seed,
    dockPos: d.dockPos,
    dockYaw: d.dockYaw,
    canvas: c,
    spawnPoints: c.spawnPoints,
    markers: c.markers,
    ambience: d.ambience,
    weatherBias: d.weatherBias,
    musicState: d.musicState,
    description: d.description,
    def: d,
  };
}
