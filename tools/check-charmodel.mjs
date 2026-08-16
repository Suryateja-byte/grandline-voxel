// Self-check for src/gen/charmodel.js and src/gen/props.js.
//
// Runs headless (no GL): the texture library paints into plain byte arrays and the mesher only
// builds THREE.BufferGeometry, neither of which needs a context. Determinism is checked by
// building everything twice from the same seed and comparing.
//
//   node tools/check-charmodel.mjs [seed]
//
// Exit code 1 on any degenerate result: an empty volume, a zero-triangle part, a head outside
// the art bar's 38–42% band, or two archetypes whose black silhouettes are too close to tell
// apart in play.

import { TextureLibrary, registerCommonTiles } from '../src/gen/texture.js';
import { buildBlocks } from '../src/gen/blocks.js';
import { Rng, parseSeed } from '../src/core/rng.js';
import {
  CHARACTER_SPECS, CHARACTER_IDS, buildCharacter, buildSilhouetteTest,
  silhouetteDistinctness, CHAR_VOXEL,
} from '../src/gen/charmodel.js';
import {
  PROPS, PROP_NAMES, buildProp, preparePropBlocks, meshProp, PROP_SCALE,
} from '../src/gen/props.js';

const SEED = parseSeed(process.argv[2] || 20260814);

// Art-bar thresholds. Failing any of these is a real defect, not a style preference.
const HEAD_RATIO_MIN = 0.38;
const HEAD_RATIO_MAX = 0.42;
const HEAD_WIDTH_MIN = 1.5;
const HEAD_WIDTH_MAX = 1.7;
const HEIGHT_MIN_VOX = 14;
const HEIGHT_MAX_VOX = 18;
const MIN_DISTINCTNESS = 0.20;
const MIN_PROP_VOXELS = 6;

const failures = [];
const fail = (msg) => { failures.push(msg); };
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

// ---------------------------------------------------------------------------

function makeWorld() {
  const tex = new TextureLibrary(SEED);
  registerCommonTiles(tex);
  const commonLayers = tex.count;
  const { reg, B } = buildBlocks(tex);
  const PB = preparePropBlocks(tex, reg, B);
  return { tex, reg, B, PB, commonLayers };
}

const world = makeWorld();
const { tex, reg, PB } = world;

// --- characters ------------------------------------------------------------

console.log('=== CHARACTERS ===  voxel ' + CHAR_VOXEL + ' m, seed ' + SEED);
console.log(pad('id', 18) + padL('h(vox)', 7) + padL('m', 7) + padL('head%', 7) + padL('headW/torsoW', 14)
  + padL('parts', 7) + padL('voxels', 8) + padL('tris', 7) + padL('silpx', 7));

const layerBefore = tex.count;
const chars = {};
let totalTris = 0;
let totalVox = 0;

for (const id of CHARACTER_IDS) {
  const spec = CHARACTER_SPECS[id];
  const ch = buildCharacter(tex, reg, spec, SEED);
  chars[id] = ch;

  let tris = 0, vox = 0, parts = 0;
  for (const key of Object.keys(ch.parts)) {
    const p = ch.parts[key];
    parts++;
    tris += p.geometry.userData.triangles;
    vox += p.voxels;
    if (p.voxels === 0) fail(`${id}.${key}: empty volume`);
    if (p.geometry.userData.triangles === 0) fail(`${id}.${key}: zero triangles`);
    if (!Number.isFinite(p.pivot[0] + p.pivot[1] + p.pivot[2])) fail(`${id}.${key}: non-finite pivot`);
  }
  totalTris += tris;
  totalVox += vox;

  const hv = Math.round(ch.height / CHAR_VOXEL);
  const hr = ch.metrics.headRatio;
  const hw = ch.metrics.headWidthRatio;
  const sil = buildSilhouetteTest(spec);

  if (hv < HEIGHT_MIN_VOX || hv > HEIGHT_MAX_VOX) fail(`${id}: height ${hv} voxels outside 14–18`);
  if (hr < HEAD_RATIO_MIN - 1e-6 || hr > HEAD_RATIO_MAX + 1e-6) fail(`${id}: head ${(hr * 100).toFixed(1)}% outside 38–42%`);
  if (hw < HEAD_WIDTH_MIN - 1e-6 || hw > HEAD_WIDTH_MAX + 1e-6) fail(`${id}: head width ${hw.toFixed(2)}x outside 1.5–1.7x`);
  if (!ch.parts.hat) fail(`${id}: no identity element`);
  if (sil.filled < 40) fail(`${id}: silhouette only ${sil.filled} cells`);

  // The identity element must actually leave the head outline, or it is decoration, not read.
  const headTop = ch.parts.head.origin[1] + ch.parts.head.volume.sy * CHAR_VOXEL;
  const headL = ch.parts.head.origin[0];
  const headR = headL + ch.parts.head.volume.sx * CHAR_VOXEL;
  const hat = ch.parts.hat;
  const hatTop = hat.origin[1] + hat.volume.sy * CHAR_VOXEL;
  const headB = ch.parts.head.origin[2];
  const headF = headB + ch.parts.head.volume.sz * CHAR_VOXEL;
  const breaksUp = hatTop > headTop + 1e-6;
  const breaksWide = hat.origin[0] < headL - 1e-6 || hat.origin[0] + hat.volume.sx * CHAR_VOXEL > headR + 1e-6;
  const breaksDeep = hat.origin[2] < headB - 1e-6 || hat.origin[2] + hat.volume.sz * CHAR_VOXEL > headF + 1e-6;
  if (!breaksUp && !breaksWide && !breaksDeep) fail(`${id}: identity element does not break the head silhouette`);

  console.log(pad(id, 18) + padL(hv, 7) + padL(ch.height.toFixed(2), 7) + padL((hr * 100).toFixed(1), 7)
    + padL(hw.toFixed(2), 14) + padL(parts, 7) + padL(vox, 8) + padL(tris, 7) + padL(sil.filled, 7));
}

console.log(`total: ${CHARACTER_IDS.length} archetypes, ${totalVox} voxels, ${totalTris} triangles, `
  + `${tex.count - layerBefore} character texture layers`);

// --- silhouette distinctness ----------------------------------------------

console.log('\n=== SILHOUETTE DISTINCTNESS (1 - IoU of the front projections) ===');
const short = CHARACTER_IDS.map((id) => id.slice(0, 4));
console.log(pad('', 18) + short.map((s) => padL(s, 5)).join(''));

let minD = 1, minPair = '', sumD = 0, nD = 0;
const matrix = [];
for (let i = 0; i < CHARACTER_IDS.length; i++) {
  const row = [];
  for (let j = 0; j < CHARACTER_IDS.length; j++) {
    const d = i === j ? 0 : silhouetteDistinctness(CHARACTER_SPECS[CHARACTER_IDS[i]], CHARACTER_SPECS[CHARACTER_IDS[j]]);
    row.push(d);
    if (j > i) {
      sumD += d; nD++;
      if (d < minD) { minD = d; minPair = `${CHARACTER_IDS[i]} / ${CHARACTER_IDS[j]}`; }
      if (d < MIN_DISTINCTNESS) fail(`silhouettes too close (${d.toFixed(3)}): ${CHARACTER_IDS[i]} vs ${CHARACTER_IDS[j]}`);
    }
  }
  matrix.push(row);
  console.log(pad(CHARACTER_IDS[i], 18) + row.map((d) => padL(d.toFixed(2), 5)).join(''));
}
console.log(`min ${minD.toFixed(3)} (${minPair})   mean ${(sumD / nD).toFixed(3)}   threshold ${MIN_DISTINCTNESS}`);

// --- props -----------------------------------------------------------------

console.log('\n=== PROPS ===  voxel ' + PROP_SCALE + ' m, seed ' + SEED);
console.log(pad('prop', 16) + padL('size (x,y,z)', 16) + padL('voxels', 8) + padL('solidTri', 10)
  + padL('cutTri', 8) + padL('h(m)', 7));

const propVariants = {
  rock: ['small', 'medium', 'large'],
  chest: [false, true],
  statue: ['guard', 'hero', 'kraken'],
};

let propTotalTris = 0;
for (const name of PROP_NAMES) {
  const variants = propVariants[name] || [undefined];
  for (const variant of variants) {
    const rng = Rng.fromName(SEED, 'prop:' + name + ':' + String(variant));
    const p = buildProp(name, rng, PB, variant);
    const m = meshProp(p, reg);
    const solidTri = m.solid ? m.solid.userData.triangles : 0;
    const cutTri = m.cutout ? m.cutout.userData.triangles : 0;
    propTotalTris += solidTri + cutTri;

    if (p.voxels < MIN_PROP_VOXELS) fail(`${name}${variant !== undefined ? '/' + variant : ''}: only ${p.voxels} voxels`);
    if (solidTri + cutTri === 0) fail(`${name}: meshed to zero triangles`);
    if (p.volume.sy < 2) fail(`${name}: less than 2 voxels tall`);
    // Anything that fills its whole bounding box is a cube and will not read as a prop.
    const boxFill = p.voxels / (p.volume.sx * p.volume.sy * p.volume.sz);
    if (boxFill > 0.97 && name !== 'crate') fail(`${name}: fills ${(boxFill * 100) | 0}% of its box — no silhouette`);

    const label = name + (variant !== undefined ? '/' + String(variant) : '');
    console.log(pad(label, 16) + padL(`${p.size[0]},${p.size[1]},${p.size[2]}`, 16) + padL(p.voxels, 8)
      + padL(solidTri, 10) + padL(cutTri, 8) + padL((p.size[1] * PROP_SCALE).toFixed(1), 7));
  }
}
console.log(`total: ${PROP_NAMES.length} prop kinds, ${propTotalTris} triangles, ${tex.count} texture layers overall`);

// --- determinism -----------------------------------------------------------

console.log('\n=== DETERMINISM ===');
const w2 = makeWorld();
let charMatch = true;
for (const id of CHARACTER_IDS) {
  const a = chars[id];
  const b = buildCharacter(w2.tex, w2.reg, CHARACTER_SPECS[id], SEED);
  for (const key of Object.keys(a.parts)) {
    const va = a.parts[key].volume.data, vb = b.parts[key].volume.data;
    if (va.length !== vb.length) { charMatch = false; break; }
    for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) { charMatch = false; break; }
  }
}
if (!charMatch) fail('character volumes differ between two builds from the same seed');

let propMatch = true;
for (const name of PROP_NAMES) {
  const a = buildProp(name, Rng.fromName(SEED, 'det:' + name), PB);
  const b = buildProp(name, Rng.fromName(SEED, 'det:' + name), w2.PB);
  if (a.volume.data.length !== b.volume.data.length) { propMatch = false; continue; }
  for (let i = 0; i < a.volume.data.length; i++) {
    if (a.volume.data[i] !== b.volume.data[i]) { propMatch = false; break; }
  }
}
if (!propMatch) fail('prop volumes differ between two builds from the same seed');

// Texture bytes must match too, or capture would not be bit-identical between runs.
let texMatch = tex.count === w2.tex.count;
if (texMatch) {
  for (let i = 0; i < tex.layers.length && texMatch; i++) {
    const a = tex.layers[i], b = w2.tex.layers[i];
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) { texMatch = false; break; }
  }
}
if (!texMatch) fail('texture layers differ between two builds from the same seed');

console.log(`characters identical: ${charMatch}`);
console.log(`props identical:      ${propMatch}`);
console.log(`textures identical:   ${texMatch} (${tex.count} layers)`);

// A layer that is still all magenta was never painted (TextureLibrary's sentinel); a layer
// that is fully transparent would render as a hole in an opaque block. Both are silent bugs.
let unpainted = 0;
for (let i = 0; i < tex.layers.length; i++) {
  const d = tex.layers[i];
  let allMagenta = true, allClear = true;
  for (let k = 0; k < d.length; k += 4) {
    if (!(d[k] === 255 && d[k + 1] === 0 && d[k + 2] === 255)) allMagenta = false;
    if (d[k + 3] !== 0) allClear = false;
    if (!allMagenta && !allClear) break;
  }
  if (allMagenta || allClear) {
    unpainted++;
    fail(`texture layer ${i} (${tex.names[i]}) is ${allMagenta ? 'unpainted magenta' : 'fully transparent'}`);
  }
}
console.log(`unpainted layers:     ${unpainted}`);

// ---------------------------------------------------------------------------

console.log('\n=== RESULT ===');
if (failures.length === 0) {
  console.log('PASS — no degenerate results.');
} else {
  console.log(`FAIL — ${failures.length} problem(s):`);
  for (const f of failures) console.log('  * ' + f);
  process.exit(1);
}
