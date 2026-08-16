// The ship, built as voxels. Owner: SHIP.
//
// A caravel-scale pirate ship, 19 m of hull with a 2 m bowsprit, built at a 0.25 m voxel so it
// carries real detail: a curved sheer line, planked deck, bulwarks with a cap rail, a raised
// aftercastle with a cabin, a mast with a yard and a cambered sail, standing rigging, a helm,
// a carved figurehead, a crow's nest, cargo, a jolly roger, lanterns and an anchor.
//
// WHY the parts are separate volumes: sailing.js animates the sail, yard, wheel, flag, anchor
// and rudder every frame. Each of those is meshed with its vertices expressed *relative to its
// own pivot*, so animating is `mesh.position = pivot; mesh.rotation.x = angle` — no geometry is
// ever rebuilt at runtime. The hull is one static mesh and never moves relative to the ship.
//
// Coordinate frame (ship-local metres, matching ARCHITECTURE §3):
//   +Z is FORWARD (yaw = atan2(dx, dz) means heading 0 points at +Z)
//   +X is to STARBOARD, +Y is up, y = 0 is the design waterline, x = 0 is the centreline.
//
// Art bar (reference/ART_BAR.md §4): every surface goes through a Painter with tonal steps, and
// per-face shading + AO come free from meshVolume. No flat single-colour region survives.

import { P, mixHex, shadeDown } from '../gen/palette.js';
import { VoxelVolume, meshVolume } from '../gen/voxel.js';
import { Rng } from '../core/rng.js';
import { clamp, clamp01, lerp, smoothstep } from '../core/math.js';
import { paintSolid, paintPlank, paintCloth, paintJollyRoger } from '../gen/texture.js';

/** Ship voxel size in metres. Finer than terrain (0.5) so the ship carries detail. */
export const SHIP_VOXEL = 0.25;
const V = SHIP_VOXEL;

// --- volume dimensions -----------------------------------------------------
const SX = 26;          // 6.5 m beam envelope
const SY = 78;          // 19.5 m from keel to truck
const SZ = 84;          // 21 m including the bowsprit

const CX = 13;          // centreline, in voxel units
const CZ = 38;          // hull mid-length
const HULL_Z1 = 75;     // hull ends here; 76..83 is bowsprit only

const WATER_VY = 7;     // design waterline -> draft is 1.75 m
const ORLOP_VY = 9;     // everything below this is solid ballast (and cheap to mesh)
const DECK_VY = 17;     // main deck planking layer
const QDECK_VY = 25;    // quarterdeck planking layer (2 m above the main deck)
const QDECK_Z1 = 28;    // quarterdeck runs from the transom forward to here
const MAX_HALF = 11.5;  // max half-beam in voxels

const MAST_VZ = 46;
const MAST_TOP_VY = 69;
const YARD_VY = 52;
const NEST_VY = 58;
const TOPYARD_VY = 63;

/** Ship-local metres of a voxel coordinate. */
const mx = (vx) => (vx - CX) * V;
const my = (vy) => (vy - WATER_VY) * V;
const mz = (vz) => (vz - CZ) * V;

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

/**
 * Register every tile the ship needs. Idempotent — `TextureLibrary.add` returns the existing
 * layer for a name it already holds, so this may be passed to `App.opts.registerTiles` (before
 * the atlas is built) *and* called again from buildShipModel without paying twice.
 *
 * @param {import('../gen/texture.js').TextureLibrary} tex
 * @returns {Record<string, number>} tile name (without the `ship_` prefix) -> array layer
 */
export function registerShipTiles(tex) {
  const t = {};
  const add = (n, paint) => { t[n] = tex.add('ship_' + n, paint); };

  // Hull. Two strakes: tarred oak below the waterline, oiled oak above.
  add('hullLow', paintPlank(shadeDown(P.woodDark, 0.85), shadeDown(P.woodDark, 1.25), false));
  add('hull', paintPlank(P.wood, P.woodDark, false));
  add('deck', paintPlank(P.plank, P.plankDark, false));
  add('beam', paintPlank(P.woodDark, shadeDown(P.woodDark, 0.6), true));
  add('rail', paintPlank(P.woodPale, P.plankDark, false));
  add('trim', paintSolid(P.gold, { grain: 0.05, bevelStrength: 0.26 }));
  add('mast', paintPlank(P.woodPale, P.woodDark, true));
  add('rope', paintSolid(P.rope, { speckle: 0.14, speckleColor: shadeDown(P.rope, 0.5) }));
  add('metal', paintSolid(P.metal, { grain: 0.04, bevelStrength: 0.22 }));
  add('iron', paintSolid(P.metalDark, { grain: 0.05, bevelStrength: 0.3 }));
  add('plate', paintSolid(mixHex(P.metalDark, P.metal, 0.35), { grain: 0.05, speckle: 0.05, speckleColor: P.metalDark, bevelStrength: 0.34 }));
  add('cannon', paintSolid(shadeDown(P.metalDark, 0.55), { grain: 0.06, bevelStrength: 0.3 }));
  add('glass', paintSolid(P.glass, { grain: 0.03, bevelStrength: 0.18 }));
  add('lamp', paintSolid(P.lanternGlow, { grain: 0.03, bevelStrength: 0.05 }));
  add('barrel', paintPlank(P.barrel, shadeDown(P.barrel, 0.5), true));
  add('crate', paintPlank(P.woodPale, P.plankDark, false));
  add('sail', paintCloth(P.sail));
  add('sailShade', paintCloth(P.sailShade));
  add('sailStorm', paintCloth(P.sailShade, { stripe: mixHex(P.sail, P.marineBlue, 0.30) }));
  add('roger', paintJollyRoger(P.sail, P.ink, 'straw'));
  add('pennant', paintCloth(P.flagRed, { stripe: P.heroGold }));
  add('carve', paintSolid(mixHex(P.woodPale, P.gold, 0.28), { grain: 0.06, bevelStrength: 0.3 }));
  return t;
}

/**
 * Define the block ids the ship uses on a shared registry. Names are prefixed `ship:` so the
 * ship can never collide with world or character blocks. `define` is idempotent by name.
 *
 * @param {import('../gen/voxel.js').BlockRegistry} reg
 * @param {Record<string, number>} tiles from registerShipTiles
 * @returns {Record<string, number>} block key -> block id
 */
export function shipBlocks(reg, tiles) {
  const B = {};
  const d = (key, spec, opts) => { B[key] = reg.define('ship:' + key, spec, opts); };
  d('hullLow', tiles.hullLow);
  d('hull', { top: tiles.rail, side: tiles.hull, bottom: tiles.hullLow });
  d('deck', { top: tiles.deck, side: tiles.beam, bottom: tiles.beam });
  d('beam', tiles.beam);
  d('rail', tiles.rail);
  d('trim', tiles.trim);
  d('mast', { top: tiles.beam, side: tiles.mast, bottom: tiles.beam });
  d('rope', tiles.rope);
  d('metal', tiles.metal);
  d('iron', tiles.iron);
  d('plate', tiles.plate);
  d('cannon', tiles.cannon);
  d('glass', tiles.glass);
  d('lamp', tiles.lamp);
  d('barrel', { top: tiles.beam, side: tiles.barrel, bottom: tiles.beam });
  d('crate', tiles.crate);
  d('sail', tiles.sail);
  d('sailShade', tiles.sailShade);
  d('sailStorm', tiles.sailStorm);
  d('roger', tiles.roger);
  d('pennant', tiles.pennant);
  d('carve', tiles.carve);
  return B;
}

// ---------------------------------------------------------------------------
// Hull form
// ---------------------------------------------------------------------------

/** Half-beam in voxels at fore-and-aft parameter t (0 = transom, 1 = stem). */
function halfBeam(t) {
  const bow = smoothstep(1.0, 0.58, t);        // 1 amidships, 0 at the stem
  const stern = smoothstep(-0.02, 0.22, t);    // the transom is broad but not full beam
  const body = Math.pow(bow, 0.62) * (0.58 + 0.42 * stern);
  return 1.0 + (MAX_HALF - 1.0) * body;
}

/**
 * Vertical section shape: fraction of the half-beam present at height fraction u
 * (0 = keel, 1 = deck). A hard turn of the bilge and a touch of tumblehome — this is what
 * stops the hull reading as an extruded rectangle.
 */
function sectionShape(u) {
  if (u < 0.62) return Math.pow(Math.sin((u / 0.62) * Math.PI * 0.5), 0.55) * 0.99;
  return 1.0 - 0.06 * ((u - 0.62) / 0.38);
}

/** Bulwark height in voxels above the main deck. Curved sheer: rises steeply toward the bow. */
function bulwarkH(t) {
  const bow = smoothstep(0.45, 1.0, t);
  return Math.round(7 + 5.0 * bow * bow);
}

/** Deck planking level (voxels) at station vz — the quarterdeck steps up aft. */
function deckLevel(vz) {
  if (vz <= QDECK_Z1) return QDECK_VY;
  if (vz <= QDECK_Z1 + 3) return QDECK_VY - 2 * (vz - QDECK_Z1);   // three-step companionway
  return DECK_VY;
}

/** Half-width of the hull outline (voxels) at height vy and station vz. */
function halfWidthAt(vy, vz) {
  const t = clamp01(vz / HULL_Z1);
  const hb = halfBeam(t);
  if (vy <= DECK_VY) return Math.max(0.55, hb * sectionShape(clamp01(vy / DECK_VY)));
  return Math.max(0.55, hb * (0.965 - 0.030 * (vy - DECK_VY)));
}

/**
 * Top of the structure (cap rail) at station vz. The quarterdeck carries a low rail rather than
 * a full bulwark — it is already 2 m up, and a full bulwark there would hide the helm.
 */
function topAt(vz) {
  if (vz <= QDECK_Z1) return QDECK_VY + 5;
  return deckLevel(vz) + bulwarkH(clamp01(vz / HULL_Z1));
}

// ---------------------------------------------------------------------------
// Volume helpers
// ---------------------------------------------------------------------------

function box(vol, x0, y0, z0, x1, y1, z1, id) {
  vol.fillBox(x0, y0, z0, x1, y1, z1, id);
}

/** 3D DDA line of single voxels — rigging, ropes, spokes. */
function lineVox(vol, x0, y0, z0, x1, y1, z1, id, thick = 1) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
  for (let i = 0; i <= n; i++) {
    const s = n === 0 ? 0 : i / n;
    const x = Math.round(lerp(x0, x1, s));
    const y = Math.round(lerp(y0, y1, s));
    const z = Math.round(lerp(z0, z1, s));
    for (let ox = 0; ox < thick; ox++) {
      for (let oy = 0; oy < thick; oy++) vol.set(x + ox, y + oy, z, id);
    }
  }
}

/** Solid cylinder about the Y axis. Masts, barrels, capstans. */
function cylY(vol, cx, cz, y0, y1, r, id) {
  for (let y = y0; y <= y1; y++) {
    for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx, dz = z + 0.5 - cz;
        if (dx * dx + dz * dz <= r * r + 0.15) vol.set(x, y, z, id);
      }
    }
  }
}

/** Solid cylinder about the Z axis. Cannon barrels, wheel hubs. */
function cylZ(vol, cx, cy, z0, z1, r, id) {
  for (let z = z0; z <= z1; z++) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r * r + 0.15) vol.set(x, y, z, id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The hull volume
// ---------------------------------------------------------------------------

/**
 * Build the static part of the ship: hull, deck, bulwarks, aftercastle, mast, rigging,
 * bowsprit, figurehead, crow's nest, cargo, lanterns, ladder and cannons.
 *
 * @param {Record<string,number>} B block table from shipBlocks
 * @param {{upgrades?: string[], seed?: number}} opts
 * @returns {{vol: VoxelVolume, cannons: object[], stations: object, lanterns: number[][]}}
 */
function buildHullVolume(B, opts) {
  const up = new Set(opts.upgrades || []);
  const rng = new Rng((opts.seed >>> 0) || 1).fork('shiphull');
  const vol = new VoxelVolume(SX, SY, SZ);

  // --- occupancy mask: one pass decides what is "inside the hull outline" ---------------
  const inside = new Uint8Array(SX * SY * SZ);
  const ii = (x, y, z) => (y * SZ + z) * SX + x;
  for (let vz = 0; vz <= HULL_Z1; vz++) {
    const top = topAt(vz);
    for (let vy = 0; vy <= top; vy++) {
      const hw = halfWidthAt(vy, vz);
      for (let vx = 0; vx < SX; vx++) {
        if (Math.abs(vx + 0.5 - CX) <= hw) inside[ii(vx, vy, vz)] = 1;
      }
    }
  }
  const isIn = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ)
    ? 0 : inside[ii(x, y, z)];

  // --- shell + ballast -------------------------------------------------------------------
  // Below the orlop the hull is solid: it is cheaper to mesh (no interior faces at all) and
  // it is also true — that volume is ballast, bilge and keel timber.
  for (let vz = 0; vz <= HULL_Z1; vz++) {
    for (let vy = 0; vy < SY; vy++) {
      for (let vx = 0; vx < SX; vx++) {
        if (!isIn(vx, vy, vz)) continue;
        const shell = !isIn(vx - 1, vy, vz) || !isIn(vx + 1, vy, vz)
          || !isIn(vx, vy - 1, vz) || !isIn(vx, vy + 1, vz)
          || !isIn(vx, vy, vz - 1) || !isIn(vx, vy, vz + 1);
        if (vy <= ORLOP_VY) {
          vol.set(vx, vy, vz, vy < WATER_VY ? B.hullLow : B.hull);
        } else if (shell) {
          vol.set(vx, vy, vz, vy <= DECK_VY ? B.hull : B.hull);
        }
      }
    }
  }

  // Cap rail: the single highest voxel of every bulwark column, in pale wood. Two tonal steps
  // against the hull below is what draws the sheer line from a distance.
  for (let vz = 0; vz <= HULL_Z1; vz++) {
    const top = topAt(vz);
    for (let vx = 0; vx < SX; vx++) {
      if (isIn(vx, top, vz) && !isIn(vx, top + 1, vz)) vol.set(vx, top, vz, B.rail);
    }
  }

  // A gold sheer stripe just under the rail — ART_BAR §3 wants warm accents against the sea.
  for (let vz = 2; vz <= HULL_Z1 - 2; vz++) {
    const y = topAt(vz) - 3;
    for (let vx = 0; vx < SX; vx++) {
      if (vol.get(vx, y, vz) === B.hull && (!isIn(vx - 1, y, vz) || !isIn(vx + 1, y, vz))) {
        vol.set(vx, y, vz, B.trim);
      }
    }
  }

  // --- decks ------------------------------------------------------------------------------
  for (let vz = 0; vz <= HULL_Z1; vz++) {
    const dl = deckLevel(vz);
    for (let vx = 0; vx < SX; vx++) if (isIn(vx, dl, vz)) vol.set(vx, dl, vz, B.deck);
    // Orlop floor, so the hold reads as a room rather than a pit when the hatch is open.
    for (let vx = 0; vx < SX; vx++) if (isIn(vx, ORLOP_VY + 1, vz)) vol.set(vx, ORLOP_VY + 1, vz, B.beam);
  }
  // Deck beams: a darker cross-timber every 6 stations, visible between the planks.
  for (let vz = 32; vz <= HULL_Z1 - 4; vz += 6) {
    for (let vx = 0; vx < SX; vx++) if (vol.get(vx, DECK_VY, vz) === B.deck) vol.set(vx, DECK_VY, vz, B.beam);
  }

  // --- cargo hatch + ladder to below-deck --------------------------------------------------
  const hatchZ0 = 36, hatchZ1 = 41;
  for (let vz = hatchZ0; vz <= hatchZ1; vz++) {
    for (let vx = CX - 3; vx <= CX + 2; vx++) vol.set(vx, DECK_VY, vz, 0);
  }
  // Coaming (the raised frame round the hatch) — without it the hole reads as a bug.
  for (let vz = hatchZ0 - 1; vz <= hatchZ1 + 1; vz++) {
    for (let vx = CX - 4; vx <= CX + 3; vx++) {
      const edge = vz === hatchZ0 - 1 || vz === hatchZ1 + 1 || vx === CX - 4 || vx === CX + 3;
      if (edge) vol.set(vx, DECK_VY + 1, vz, B.beam);
    }
  }
  // Rope ladder down into the hold: climbable rungs on the forward face of the hatch.
  for (let vy = ORLOP_VY + 2; vy <= DECK_VY; vy++) {
    vol.set(CX - 3, vy, hatchZ1, B.rope);
    vol.set(CX + 2, vy, hatchZ1, B.rope);
    if ((vy - ORLOP_VY) % 2 === 0) for (let vx = CX - 3; vx <= CX + 2; vx++) vol.set(vx, vy, hatchZ1, B.rope);
  }

  // --- aftercastle: the cabin on the quarterdeck --------------------------------------------
  const cabZ0 = 2, cabZ1 = 20, cabY0 = QDECK_VY + 1, cabY1 = QDECK_VY + 16;
  for (let vz = cabZ0; vz <= cabZ1; vz++) {
    const hw = Math.floor(halfWidthAt(QDECK_VY, vz)) - 2;
    for (let vy = cabY0; vy <= cabY1; vy++) {
      for (let vx = CX - hw; vx <= CX + hw - 1; vx++) {
        const wall = vx === CX - hw || vx === CX + hw - 1 || vz === cabZ0 || vz === cabZ1
          || vy === cabY1 || vy === cabY0;
        if (wall) vol.set(vx, vy, vz, vy === cabY1 ? B.hull : B.deck);
      }
    }
  }
  // Roof overhang + a gold ridge, so the cabin does not read as a plain crate.
  for (let vz = cabZ0 - 1; vz <= cabZ1 + 1; vz++) {
    const hw = Math.floor(halfWidthAt(QDECK_VY, clamp(vz, cabZ0, cabZ1))) - 1;
    for (let vx = CX - hw; vx <= CX + hw - 1; vx++) vol.set(vx, cabY1 + 1, vz, B.hull);
  }
  for (let vz = cabZ0; vz <= cabZ1; vz++) vol.set(CX, cabY1 + 2, vz, B.trim);
  // Door on the forward face, with a frame and a step.
  for (let vy = cabY0 + 1; vy <= cabY0 + 12; vy++) {
    for (let vx = CX - 2; vx <= CX + 1; vx++) vol.set(vx, vy, cabZ1, 0);
  }
  for (let vy = cabY0; vy <= cabY0 + 13; vy++) {
    vol.set(CX - 3, vy, cabZ1, B.beam);
    vol.set(CX + 2, vy, cabZ1, B.beam);
  }
  for (let vx = CX - 3; vx <= CX + 2; vx++) vol.set(vx, cabY0 + 13, cabZ1, B.beam);
  // Stern windows: three tall lights with mullions. This is the ship's face from astern.
  for (let w = 0; w < 3; w++) {
    const x0 = CX - 5 + w * 4;
    for (let vy = cabY0 + 5; vy <= cabY0 + 12; vy++) {
      for (let vx = x0; vx <= x0 + 2; vx++) vol.set(vx, vy, cabZ0, B.glass);
    }
  }
  // Side lights.
  for (let side = -1; side <= 1; side += 2) {
    const hw = Math.floor(halfWidthAt(QDECK_VY, 10)) - 2;
    const vx = side < 0 ? CX - hw : CX + hw - 1;
    for (let vz = 8; vz <= 14; vz += 3) {
      for (let vy = cabY0 + 7; vy <= cabY0 + 11; vy++) {
        vol.set(vx, vy, vz, B.glass);
        vol.set(vx, vy, vz + 1, B.glass);
      }
    }
  }

  // --- companionway rail round the quarterdeck edge -----------------------------------------
  for (let vx = 0; vx < SX; vx++) {
    if (!isIn(vx, QDECK_VY, QDECK_Z1)) continue;
    for (let vy = QDECK_VY + 1; vy <= QDECK_VY + 4; vy++) {
      if (vy === QDECK_VY + 4 || vx % 4 === 0) vol.set(vx, vy, QDECK_Z1, B.rail);
    }
  }
  // Leave the centre open so a crew member can walk up the steps.
  for (let vy = QDECK_VY + 1; vy <= QDECK_VY + 4; vy++) {
    for (let vx = CX - 3; vx <= CX + 2; vx++) vol.set(vx, vy, QDECK_Z1, 0);
  }

  // --- mast, yard partners, crow's nest ------------------------------------------------------
  cylY(vol, CX, MAST_VZ, DECK_VY + 1, MAST_TOP_VY, 2.1, B.mast);
  cylY(vol, CX, MAST_VZ, MAST_TOP_VY - 12, MAST_TOP_VY, 1.4, B.mast);
  vol.set(CX, MAST_TOP_VY + 1, MAST_VZ, B.trim);   // the truck
  // Mast partners: a wedge collar where the mast meets the deck.
  for (let vz = MAST_VZ - 4; vz <= MAST_VZ + 4; vz++) {
    for (let vx = CX - 4; vx <= CX + 3; vx++) {
      const dx = vx + 0.5 - CX, dz = vz + 0.5 - MAST_VZ;
      if (dx * dx + dz * dz <= 16) vol.set(vx, DECK_VY + 1, vz, B.beam);
    }
  }
  // Crow's nest: a five-across platform with a rail broken at the aft side for the climb.
  for (let vz = NEST_VY * 0 + MAST_VZ - 4; vz <= MAST_VZ + 4; vz++) {
    for (let vx = CX - 4; vx <= CX + 3; vx++) {
      const dx = vx + 0.5 - CX, dz = vz + 0.5 - MAST_VZ;
      if (dx * dx + dz * dz <= 17) vol.set(vx, NEST_VY, vz, B.deck);
    }
  }
  for (let vz = MAST_VZ - 4; vz <= MAST_VZ + 4; vz++) {
    for (let vx = CX - 4; vx <= CX + 3; vx++) {
      const dx = vx + 0.5 - CX, dz = vz + 0.5 - MAST_VZ;
      const r2 = dx * dx + dz * dz;
      if (r2 > 11 && r2 <= 17 && !(dz < -2.5 && Math.abs(dx) < 1.6)) {
        vol.set(vx, NEST_VY + 1, vz, B.rail);
        vol.set(vx, NEST_VY + 2, vz, B.rail);
      }
    }
  }

  // --- standing rigging -----------------------------------------------------------------------
  // Forestay and backstay first: they define the mast's triangle from any angle.
  lineVox(vol, CX, MAST_TOP_VY - 2, MAST_VZ, CX, DECK_VY + 5, HULL_Z1 - 3, B.rope);
  lineVox(vol, CX, MAST_TOP_VY - 2, MAST_VZ, CX, QDECK_VY + 3, QDECK_Z1 - 2, B.rope);
  // Shrouds: three per side from the top down to the channels, with ratlines between them.
  for (let side = -1; side <= 1; side += 2) {
    for (let k = 0; k < 3; k++) {
      const footZ = MAST_VZ - 4 + k * 4;
      const footX = CX + side * (Math.floor(halfWidthAt(DECK_VY, footZ)) - 1);
      lineVox(vol, CX + side * 2, NEST_VY - 1, MAST_VZ, footX, DECK_VY + 2, footZ, B.rope);
    }
    // Ratlines between shroud 0 and shroud 2 make the shrouds climbable and read as a net.
    for (let step = 0; step < 6; step++) {
      const s = step / 6;
      const y = Math.round(lerp(DECK_VY + 4, NEST_VY - 3, s));
      const rx = Math.round(lerp(CX + side * (Math.floor(halfWidthAt(DECK_VY, MAST_VZ - 4)) - 1), CX + side * 2, s));
      const za = Math.round(lerp(MAST_VZ - 4, MAST_VZ, s));
      const zb = Math.round(lerp(MAST_VZ + 4, MAST_VZ, s));
      lineVox(vol, rx, y, za, rx, y, zb, B.rope);
    }
  }

  // --- bowsprit + figurehead ------------------------------------------------------------------
  const bowY = DECK_VY + 6;
  lineVox(vol, CX - 1, bowY, HULL_Z1 - 4, CX - 1, bowY + 6, SZ - 1, B.mast, 2);
  lineVox(vol, CX, bowY + 6, SZ - 3, CX, MAST_TOP_VY - 14, MAST_VZ + 2, B.rope);   // bobstay to the mast
  // The figurehead: a carved sea-hawk under the stem, wings swept back along the bow. It has to
  // break the bow silhouette (ART_BAR §1) or it is just a bump.
  const fz = HULL_Z1 - 1;
  for (let vy = 0; vy < 6; vy++) {
    const w = 2 - Math.floor(vy / 3);
    for (let vx = CX - 1 - w; vx <= CX + w; vx++) vol.set(vx, bowY - 4 + vy, fz - Math.floor(vy / 2), B.carve);
  }
  for (let k = 0; k < 5; k++) {   // beak
    vol.set(CX - 1, bowY + 1, fz + k, B.carve);
    vol.set(CX, bowY + 1, fz + k, B.carve);
  }
  for (let k = 0; k < 7; k++) {   // swept wings
    vol.set(CX - 2 - Math.floor(k / 3), bowY - 3 - Math.floor(k / 2), fz - 2 - k, B.carve);
    vol.set(CX + 1 + Math.floor(k / 3), bowY - 3 - Math.floor(k / 2), fz - 2 - k, B.carve);
  }
  vol.set(CX - 1, bowY + 2, fz - 1, B.trim);
  vol.set(CX, bowY + 2, fz - 1, B.trim);

  // --- helm pedestal (the wheel itself is an animated part) -------------------------------------
  const helmZ = 24;
  box(vol, CX - 3, QDECK_VY + 1, helmZ - 1, CX + 2, QDECK_VY + 3, helmZ + 1, B.beam);
  box(vol, CX - 3, QDECK_VY + 4, helmZ, CX - 3, QDECK_VY + 6, helmZ, B.mast);
  box(vol, CX + 2, QDECK_VY + 4, helmZ, CX + 2, QDECK_VY + 6, helmZ, B.mast);
  // Binnacle: a small lamp box beside the wheel so the helm reads at night.
  box(vol, CX + 4, QDECK_VY + 1, helmZ, CX + 5, QDECK_VY + 3, helmZ + 1, B.beam);
  vol.set(CX + 4, QDECK_VY + 4, helmZ, B.lamp);
  vol.set(CX + 5, QDECK_VY + 4, helmZ, B.lamp);

  // --- capstan, bell, cargo -----------------------------------------------------------------
  cylY(vol, CX, 62, DECK_VY + 1, DECK_VY + 4, 2.4, B.beam);     // capstan, forward
  for (let k = 0; k < 4; k++) {                                  // capstan bars
    const a = (k / 4) * Math.PI * 2;
    lineVox(vol, CX, DECK_VY + 4, 62, Math.round(CX + Math.cos(a) * 5), DECK_VY + 4, Math.round(62 + Math.sin(a) * 5), B.mast);
  }
  const lanterns = [];
  const putLantern = (vx, vy, vz) => {
    box(vol, vx, vy, vz, vx + 1, vy + 2, vz + 1, B.iron);
    box(vol, vx, vy + 1, vz, vx + 1, vy + 1, vz + 1, B.lamp);
    lanterns.push([mx(vx) + V, my(vy + 1) + V * 0.5, mz(vz) + V]);
  };
  putLantern(CX - 6, QDECK_VY + 5, cabZ1 + 1);
  putLantern(CX + 4, QDECK_VY + 5, cabZ1 + 1);
  putLantern(CX - 1, DECK_VY + 2, HULL_Z1 - 8);
  putLantern(CX - 1, NEST_VY + 1, MAST_VZ - 4);

  // Barrels and crates, lashed along the port side and abaft the mast.
  const cargoSpots = [
    [CX - 8, 52], [CX - 8, 56], [CX + 5, 52], [CX - 8, 33], [CX + 5, 30], [CX + 5, 34],
  ];
  for (let i = 0; i < cargoSpots.length; i++) {
    const [bx, bz] = cargoSpots[i];
    if (i % 2 === 0) {
      cylY(vol, bx + 1, bz + 1, DECK_VY + 1, DECK_VY + 5, 2.2, B.barrel);
      cylY(vol, bx + 1, bz + 1, DECK_VY + 2, DECK_VY + 2, 2.5, B.iron);   // hoop
      cylY(vol, bx + 1, bz + 1, DECK_VY + 4, DECK_VY + 4, 2.5, B.iron);
    } else {
      box(vol, bx, DECK_VY + 1, bz, bx + 3, DECK_VY + 4, bz + 3, B.crate);
      box(vol, bx, DECK_VY + 4, bz, bx + 3, DECK_VY + 4, bz + 3, B.beam);
    }
  }
  // A coil of rope by the mast, because a tidy deck reads as an empty deck.
  cylY(vol, CX + 6, MAST_VZ - 6, DECK_VY + 1, DECK_VY + 2, 2.0, B.rope);

  // --- cannons ---------------------------------------------------------------------------------
  const cannons = [];
  const perSide = up.has('cannon_battery') ? 3 : 1;
  const stations = perSide === 3 ? [36, 44, 52] : [44];
  for (let side = -1; side <= 1; side += 2) {
    for (const gz of stations) {
      const hw = Math.floor(halfWidthAt(DECK_VY + 3, gz));
      const gxIn = CX + side * (hw - 3);
      const gxOut = CX + side * (hw + 1);
      // Gunport: cut the bulwark, frame it, then run the barrel out through it.
      for (let vy = DECK_VY + 3; vy <= DECK_VY + 6; vy++) {
        for (let dz = -2; dz <= 2; dz++) {
          for (let vx = CX + side * (hw - 2); vx !== CX + side * (hw + 2); vx += side) {
            vol.set(vx, vy, gz + dz, 0);
          }
        }
      }
      for (let vy = DECK_VY + 2; vy <= DECK_VY + 7; vy++) {
        for (let dz = -3; dz <= 3; dz++) {
          if (vy === DECK_VY + 2 || vy === DECK_VY + 7 || dz === -3 || dz === 3) {
            vol.set(CX + side * (hw - 1), vy, gz + dz, B.trim);
          }
        }
      }
      box(vol, Math.min(gxIn, gxOut) - 1, DECK_VY + 1, gz - 2, Math.max(gxIn, gxOut) - 1, DECK_VY + 2, gz + 1, B.beam);
      const x0 = Math.min(gxIn, gxOut), x1 = Math.max(gxIn, gxOut);
      for (let vx = x0; vx <= x1; vx++) {
        for (let vy = DECK_VY + 3; vy <= DECK_VY + 5; vy++) {
          for (let vz = gz - 1; vz <= gz; vz++) {
            const dy = vy - (DECK_VY + 4), dz2 = vz - gz + 0.5;
            if (dy * dy + dz2 * dz2 <= 2.6) vol.set(vx, vy, vz, B.cannon);
          }
        }
      }
      cannons.push({ side, x: mx(gxOut), y: my(DECK_VY + 4), z: mz(gz) });
    }
  }

  // --- reinforced hull upgrade ------------------------------------------------------------------
  if (up.has('reinforced_hull')) {
    // Iron plating on the outer shell at and just above the waterline, plus bow rams. It has to
    // be visible from the deck too, so the wale line runs the full length.
    for (let vz = 4; vz <= HULL_Z1 - 2; vz++) {
      for (let vy = WATER_VY - 1; vy <= WATER_VY + 4; vy++) {
        for (let vx = 0; vx < SX; vx++) {
          const cur = vol.get(vx, vy, vz);
          if ((cur === B.hull || cur === B.hullLow)
            && (!isIn(vx - 1, vy, vz) || !isIn(vx + 1, vy, vz))) {
            if ((vz + vy) % 5 !== 0) vol.set(vx, vy, vz, B.plate);
          }
        }
      }
    }
    for (let vz = HULL_Z1 - 8; vz <= HULL_Z1; vz++) {
      for (let vy = WATER_VY; vy <= DECK_VY; vy++) {
        for (let vx = 0; vx < SX; vx++) {
          if (vol.get(vx, vy, vz) === B.hull && (!isIn(vx - 1, vy, vz) || !isIn(vx + 1, vy, vz))) {
            vol.set(vx, vy, vz, B.plate);
          }
        }
      }
    }
    // Riveted knees inside the bulwark: the upgrade should be legible from on deck as well.
    for (let vz = 32; vz <= 60; vz += 6) {
      for (let side = -1; side <= 1; side += 2) {
        const hw = Math.floor(halfWidthAt(DECK_VY + 2, vz));
        box(vol, CX + side * (hw - 2), DECK_VY + 1, vz, CX + side * (hw - 2), DECK_VY + 5, vz, B.plate);
      }
    }
  }

  // --- deterministic wear: a ship with no history looks like a toy ------------------------------
  for (let i = 0; i < 240; i++) {
    const vx = rng.int(0, SX - 1), vz = rng.int(0, HULL_Z1), vy = rng.int(ORLOP_VY, DECK_VY + 8);
    const cur = vol.get(vx, vy, vz);
    if (cur === B.hull) vol.set(vx, vy, vz, B.beam);
    else if (cur === B.deck) vol.set(vx, vy, vz, B.beam);
  }

  const st = {
    helm: [0, my(QDECK_VY + 1), mz(helmZ + 3)],
    rigging: [mx(CX + 6), my(DECK_VY + 1), mz(MAST_VZ - 6)],
    lookout: [0, my(NEST_VY + 1), mz(MAST_VZ)],
    galley: [mx(CX - 6), my(DECK_VY + 1), mz(hatchZ0 - 4)],
    repair: [mx(CX + 5), my(DECK_VY + 1), mz(60)],
    bow: [0, my(DECK_VY + 1), mz(HULL_Z1 - 8)],
    waist: [0, my(DECK_VY + 1), mz(46 - 10)],
  };

  return { vol, cannons, stations: st, lanterns, helmZ, cabinZ: [cabZ0, cabZ1] };
}

// ---------------------------------------------------------------------------
// Animated parts
// ---------------------------------------------------------------------------

/**
 * The yard and its sail. `state` is 'full' | 'half' | 'furled'.
 * The sail is CAMBERED: it bulges to leeward as a function of position across and down the
 * cloth. A flat sheet of voxels reads as cardboard; a bellied one reads as canvas under load.
 */
function buildSailVolume(B, state, big) {
  const w = big ? 40 : 34;            // cloth width in voxels
  const hFull = big ? 32 : 26;        // cloth drop in voxels
  const h = state === 'full' ? hFull : state === 'half' ? Math.round(hFull * 0.45) : 3;
  const belly = state === 'full' ? 2 : state === 'half' ? 1 : 0;
  const sx = w + 6, sy = hFull + 6, sz = 4 + belly * 2;
  const vol = new VoxelVolume(sx, sy, sz);
  const cx = sx >> 1, cz = sz >> 1, topY = sy - 2;

  // The yard: a tapered spar, longer than the cloth, with iron bands at the slings.
  for (let vx = 1; vx < sx - 1; vx++) {
    const taper = Math.abs(vx + 0.5 - cx) / (sx * 0.5);
    const th = taper > 0.86 ? 1 : 2;
    for (let k = 0; k < th; k++) {
      vol.set(vx, topY + k, cz, B.mast);
      if (th === 2) vol.set(vx, topY + k, cz - 1, B.mast);
    }
  }
  for (const bx of [cx - 1, cx, Math.round(cx - w * 0.42), Math.round(cx + w * 0.42)]) {
    vol.set(bx, topY, cz, B.iron);
    vol.set(bx, topY + 1, cz, B.iron);
  }

  // Cloth.
  const cloth = big ? B.sailStorm : B.sail;
  for (let row = 0; row < h; row++) {
    const vy = topY - 1 - row;
    const v = h <= 1 ? 0 : row / (h - 1);
    // The foot of a set sail curves up at the clews — the classic square-sail arc.
    const halfW = state === 'furled' ? w * 0.5 : (w * 0.5) * (1 - 0.10 * v * v);
    for (let vx = Math.round(cx - halfW); vx <= Math.round(cx + halfW); vx++) {
      const u = (vx + 0.5 - cx) / (halfW || 1);
      const bulge = Math.round(belly * Math.cos(u * Math.PI * 0.5) * Math.sin(Math.PI * clamp01(0.15 + v * 0.85)));
      const z = cz - 1 - bulge;
      const edge = Math.abs(u) > 0.94 || row === 0 || row === h - 1;
      const reef = state !== 'furled' && (row % 9 === 5);
      vol.set(vx, vy, z, edge || reef ? B.sailShade : cloth);
      if (state === 'furled') vol.set(vx, vy, z - 1, B.sailShade);
    }
  }

  // Running rigging: braces from the yardarms and bunt lines down the cloth face.
  for (const side of [-1, 1]) {
    lineVox(vol, cx + side * (sx / 2 - 2) | 0, topY, cz, cx + side * (sx / 2 - 4) | 0, topY - h - 3, cz - 1, B.rope);
  }
  if (state !== 'furled') {
    for (let k = -1; k <= 1; k++) {
      const bx = cx + k * Math.round(w * 0.28);
      lineVox(vol, bx, topY - 1, cz - 1, bx, topY - h, cz - 1 - belly, B.rope);
    }
  }

  return { vol, pivotV: [cx, topY, cz], dims: [sx, sy, sz], width: w * V, drop: h * V };
}

/** The ship's wheel. Rotates about the fore-and-aft axis, so it is a disc in the XY plane. */
function buildWheelVolume(B) {
  const s = 15, cx = 7, cy = 7, cz = 1;
  const vol = new VoxelVolume(s, s, 3);
  const R = 5.4;
  for (let vy = 0; vy < s; vy++) {
    for (let vx = 0; vx < s; vx++) {
      const dx = vx + 0.5 - cx, dy = vy + 0.5 - cy;
      const r = Math.hypot(dx, dy);
      if (r <= R + 0.6 && r >= R - 0.9) { vol.set(vx, vy, cz, B.mast); vol.set(vx, vy, cz + 1, B.mast); }
    }
  }
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const ex = Math.round(cx + Math.cos(a) * (R + 2.6));
    const ey = Math.round(cy + Math.sin(a) * (R + 2.6));
    lineVox(vol, cx, cy, cz, ex, ey, cz, B.mast);       // spoke + handle beyond the rim
    vol.set(ex, ey, cz, B.rail);
  }
  cylZ(vol, cx, cy, 0, 2, 1.9, B.iron);                 // hub
  vol.set(cx, cy, 0, B.trim);
  return { vol, pivotV: [cx, cy, cz], dims: [s, s, 3] };
}

/** Jolly roger at the masthead. Hangs aft of the mast so it never clips the sail. */
function buildFlagVolume(B, crewColour) {
  const sx = 3, sy = 14, sz = 22;
  const vol = new VoxelVolume(sx, sy, sz);
  const cx = 1;
  // The main flag: the roger tile carries the painted skull; a pennant strip rides above it.
  for (let vz = 2; vz < 18; vz++) {
    const t = (vz - 2) / 15;
    const drop = Math.round(Math.sin(t * Math.PI) * 1.4);      // the fly sags and lifts
    for (let vy = 3; vy < 12; vy++) {
      vol.set(cx, vy - drop, vz, B.roger);
    }
  }
  for (let vz = 2; vz < 20; vz++) vol.set(cx, 12, vz, B.pennant);
  for (let vy = 0; vy < 13; vy++) vol.set(cx, vy, 1, B.rope);   // the hoist
  // A crew pennant below, tinted by who is aboard (crewColour comes from CrewRoster).
  if (crewColour) {
    for (let vz = 2; vz < 12; vz++) vol.set(cx, 1, vz, B.pennant);
  }
  return { vol, pivotV: [cx, 12, 1], dims: [sx, sy, sz] };
}

/** Admiralty anchor: shank, stock, two flukes, ring. Hangs from the cathead at the bow. */
function buildAnchorVolume(B) {
  const sx = 15, sy = 22, sz = 5;
  const vol = new VoxelVolume(sx, sy, sz);
  const cx = 7, cz = 2;
  box(vol, cx, 2, cz, cx, 19, cz, B.iron);              // shank
  box(vol, cx - 1, 2, cz, cx, 19, cz, B.iron);
  box(vol, cx - 5, 18, cz, cx + 4, 18, cz, B.iron);     // stock
  for (let k = 0; k < 6; k++) {                          // arms sweeping out to the flukes
    vol.set(cx - 1 - k, 2 + Math.round(k * 0.9), cz, B.iron);
    vol.set(cx + k, 2 + Math.round(k * 0.9), cz, B.iron);
  }
  for (let k = 0; k < 3; k++) {                          // flukes (the triangular blades)
    for (let j = 0; j <= k; j++) {
      vol.set(cx - 6 - j, 7 + k, cz, B.metal);
      vol.set(cx + 5 + j, 7 + k, cz, B.metal);
    }
  }
  vol.set(cx, 20, cz, B.iron); vol.set(cx - 1, 20, cz, B.iron);
  vol.set(cx, 21, cz, B.rope); vol.set(cx - 1, 21, cz, B.rope);
  return { vol, pivotV: [cx, 21, cz], dims: [sx, sy, sz] };
}

/**
 * Rudder blade. Hangs on the sternpost and pivots about Y at its leading edge, so the blade
 * extends AFT of the pivot (-Z) and downward from the head — exactly how it is hung on the ship.
 */
function buildRudderVolume(B) {
  const sx = 3, sy = 13, sz = 9;
  const vol = new VoxelVolume(sx, sy, sz);
  const cx = 1, stockZ = sz - 1;
  for (let vy = 0; vy <= 10; vy++) {
    const len = Math.round(3 + 4 * smoothstep(0, 9, vy));      // deeper chord near the head
    for (let k = 1; k <= len; k++) vol.set(cx, vy, stockZ - k, vy > 7 ? B.beam : B.mast);
  }
  for (let vy = 0; vy < sy; vy++) vol.set(cx, vy, stockZ, B.iron);   // the stock
  for (const vy of [2, 6, 10]) {                                      // pintles and gudgeons
    vol.set(cx - 1, vy, stockZ, B.iron);
    vol.set(cx + 1, vy, stockZ, B.iron);
  }
  return { vol, pivotV: [cx, sy - 1, stockZ], dims: [sx, sy, sz] };
}

/** Gangplank. Stows on deck, swings out to starboard and drops onto the pier when docking. */
function buildGangplankVolume(B) {
  const sx = 18, sy = 5, sz = 7;
  const vol = new VoxelVolume(sx, sy, sz);
  for (let vx = 0; vx < sx; vx++) {
    for (let vz = 1; vz <= 5; vz++) vol.set(vx, 1, vz, B.deck);
    if (vx % 4 === 0) { vol.set(vx, 2, 1, B.beam); vol.set(vx, 2, 5, B.beam); }   // cleats
  }
  for (let vx = 0; vx < sx; vx += 6) {                       // rope hand-line on stanchions
    vol.set(vx, 2, 0, B.mast); vol.set(vx, 3, 0, B.mast);
  }
  for (let vx = 0; vx < sx; vx++) vol.set(vx, 4, 0, B.rope);
  return { vol, pivotV: [0, 1, 3], dims: [sx, sy, sz] };
}

// ---------------------------------------------------------------------------
// Upgrade tiers
// ---------------------------------------------------------------------------

/**
 * The three visible upgrade tiers, matching SHIP_UPGRADES in src/quest/quests.js.
 * `bigSail` and `topsail` are read by the sail builder; `plating` and `cannons` by the hull.
 */
export const SHIP_UPGRADE_VISUALS = Object.freeze({
  reinforced_hull: Object.freeze({ label: 'Reinforced Hull', plating: true }),
  storm_sails: Object.freeze({ label: 'Storm Sails', bigSail: true, topsail: true }),
  cannon_battery: Object.freeze({ label: 'Cannon Battery', cannons: 6 }),
});

/** Visible tier 0..3 — simply how many of the three upgrades are fitted. */
export function shipTier(upgrades) {
  let n = 0;
  for (const id of upgrades || []) if (SHIP_UPGRADE_VISUALS[id]) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Public build
// ---------------------------------------------------------------------------

/**
 * Build the whole ship: one static hull geometry plus the animated sub-meshes.
 *
 * Every geometry is in ship-local metres. The hull's vertices are absolute in that frame; each
 * animated part's vertices are relative to its own `pivot`, which is given in the same frame.
 *
 * @param {import('../gen/texture.js').TextureLibrary} tex
 * @param {import('../gen/voxel.js').BlockRegistry} reg
 * @param {{upgrades?: string[], seed?: number, crewColour?: number}} [opts]
 * @returns {object} the ship model — see `parts`, `metrics`, `buoyancy`, `stations`
 */
export function buildShipModel(tex, reg, opts = {}) {
  const tiles = registerShipTiles(tex);
  const B = shipBlocks(reg, tiles);
  const upgrades = opts.upgrades || [];
  const up = new Set(upgrades);
  const seed = (opts.seed >>> 0) || 1;

  const hull = buildHullVolume(B, { upgrades, seed });
  const origin = [-CX * V, -WATER_VY * V, -CZ * V];
  const hullGeo = meshVolume(hull.vol, reg, { scale: V, origin, ao: true });
  hullGeo.name = 'ship:hull';

  const big = up.has('storm_sails');
  const mkPart = (built, pivotM, name) => {
    const g = meshVolume(built.vol, reg, {
      scale: V,
      origin: [-built.pivotV[0] * V, -built.pivotV[1] * V, -built.pivotV[2] * V],
      ao: true,
    });
    g.name = 'ship:' + name;
    return { geometry: g, pivot: pivotM, triangles: g.userData.triangles };
  };

  const yardPivot = [0, my(YARD_VY), mz(MAST_VZ) + V];
  const sail = {
    full: mkPart(buildSailVolume(B, 'full', big), yardPivot, 'sail_full'),
    half: mkPart(buildSailVolume(B, 'half', big), yardPivot, 'sail_half'),
    furled: mkPart(buildSailVolume(B, 'furled', big), yardPivot, 'sail_furled'),
    pivot: yardPivot,
  };
  const parts = {
    sail,
    wheel: mkPart(buildWheelVolume(B), [0, my(QDECK_VY + 7), mz(hull.helmZ)], 'wheel'),
    flag: mkPart(buildFlagVolume(B, opts.crewColour), [0, my(MAST_TOP_VY - 3), mz(MAST_VZ) - V], 'flag'),
    anchor: mkPart(buildAnchorVolume(B), [mx(CX + 6), my(DECK_VY + 6), mz(HULL_Z1 - 12)], 'anchor'),
    rudder: mkPart(buildRudderVolume(B), [0, my(WATER_VY + 2), mz(2)], 'rudder'),
    gangplank: mkPart(buildGangplankVolume(B), [mx(CX + 11), my(DECK_VY + 1), mz(40)], 'gangplank'),
  };
  if (up.has('storm_sails')) {
    const topPivot = [0, my(TOPYARD_VY + 8), mz(MAST_VZ) + V];
    parts.topsail = {
      full: mkPart(buildSailVolume(B, 'half', false), topPivot, 'topsail_full'),
      half: mkPart(buildSailVolume(B, 'furled', false), topPivot, 'topsail_half'),
      furled: mkPart(buildSailVolume(B, 'furled', false), topPivot, 'topsail_furled'),
      pivot: topPivot,
    };
  }

  // Eight buoyancy sample points at keel level, spread so that both the pitch and the roll
  // lever arms are real. sailing.js integrates a force at each one.
  const keelY = my(0);
  const buoyancy = [
    { x: 0.0, y: keelY, z: 8.3 },
    { x: -1.6, y: keelY, z: 4.6 }, { x: 1.6, y: keelY, z: 4.6 },
    { x: -2.4, y: keelY, z: 0.0 }, { x: 2.4, y: keelY, z: 0.0 },
    { x: -2.0, y: keelY, z: -4.6 }, { x: 2.0, y: keelY, z: -4.6 },
    { x: 0.0, y: keelY, z: -8.4 },
  ];

  const metrics = {
    voxelSize: V,
    lengthM: (HULL_Z1 + 1) * V,
    overallM: SZ * V,
    beamM: MAX_HALF * 2 * V,
    draftM: WATER_VY * V,
    freeboardM: (DECK_VY - WATER_VY) * V,
    deckY: my(DECK_VY + 1),
    quarterDeckY: my(QDECK_VY + 1),
    quarterDeckZ1: mz(QDECK_Z1),
    mastTopY: my(MAST_TOP_VY),
    yardY: my(YARD_VY),
    bowZ: mz(HULL_Z1),
    sternZ: mz(0),
    sailAreaM2: (big ? 40 : 34) * (big ? 32 : 26) * V * V,
    tier: shipTier(upgrades),
  };

  return {
    voxelSize: V,
    seed,
    upgrades: upgrades.slice(),
    tier: metrics.tier,
    blocks: B,
    tiles,
    hull: { geometry: hullGeo, triangles: hullGeo.userData.triangles, voxels: hull.vol.count() },
    parts,
    buoyancy,
    stations: hull.stations,
    lanterns: hull.lanterns,
    cannons: hull.cannons,
    metrics,
    deck: {
      yMain: metrics.deckY,
      yQuarter: metrics.quarterDeckY,
      quarterZ1: metrics.quarterDeckZ1,
      halfWidthAt: deckHalfWidth,
      heightAt: deckHeightAt,
    },
  };
}

/**
 * Walkable half-width of the deck at ship-local z, in metres. Used by dock.js and
 * crewaboard.js to keep anybody aboard inside the bulwarks — the ship must never place a
 * person outside its own rail.
 * @param {number} zLocal ship-local metres, +Z forward
 */
export function deckHalfWidth(zLocal) {
  const vz = clamp(zLocal / V + CZ, 0, HULL_Z1);
  const vy = vz <= QDECK_Z1 ? QDECK_VY : DECK_VY;
  return Math.max(0.35, (halfWidthAt(vy, vz) - 2.2) * V);
}

/**
 * Deck height (ship-local metres) at ship-local z: the quarterdeck aft, the main deck forward,
 * with the companionway steps in between.
 * @param {number} zLocal
 */
export function deckHeightAt(zLocal) {
  const vz = clamp(zLocal / V + CZ, 0, HULL_Z1);
  return my(deckLevel(Math.round(vz)) + 1);
}

/** Fore-and-aft extent of walkable deck, in ship-local metres. */
export const DECK_Z_RANGE = Object.freeze({ aft: mz(2), fore: mz(HULL_Z1 - 3) });

export default buildShipModel;
