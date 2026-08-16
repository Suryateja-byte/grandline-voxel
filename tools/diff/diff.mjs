#!/usr/bin/env node
// Pixel diff gate. Compares a capture run against the accepted baseline and fails the build
// when a shot drifts further than the threshold.
//
// Why linear space and why luma-weighted:
//   PNGs are sRGB-encoded, so a fixed difference in stored bytes means a much larger physical
//   difference in the shadows than in the highlights. Comparing raw bytes therefore under-reports
//   exactly the region ART_BAR §5 cares most about ("shadows never crush to black"). We decode to
//   linear light first. Human vision then resolves luminance far more finely than chroma, so a
//   1-unit luma shift is a real regression while a 1-unit chroma shift usually is not — luma is
//   weighted 4x, matching how the frame will actually be judged.
//
// Usage:
//   node tools/diff/diff.mjs --a evidence/baseline --b evidence/shots --out evidence/diff
//                            [--threshold 0.002] [--pixel-eps 0.0035] [--update] [--json]
//
// Exit: 0 pass (or no baseline yet), 1 a shot exceeded the threshold, 2 bad invocation.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { P, mixHex, shadeDown, hex2rgb, srgb2lin, lin2srgb } from '../../src/gen/palette.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function toPosix(p) { return p.split(path.sep).join('/'); }
function rel(p) { return toPosix(path.relative(ROOT, p)); }

// --- colours -----------------------------------------------------------------------------
// No hardcoded hex anywhere: the diff visualisation is composed from the game palette so the
// evidence page and the game are graded from the same file.

/** Hot magenta for changed pixels: the one hue the game never uses at full strength. */
const HOT = hex2rgb(mixHex(P.fruitGomu, P.fruitGura, 0.28));
/** Deep ink used as the diff-image ground, so a dimmed frame still reads as "context". */
const GROUND = hex2rgb(shadeDown(P.uiShadow, 0.6));

/** Rec.709 luminance of a linear RGB triple. */
function luma(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

/** sRGB byte -> linear float, memoised over the 256 possible inputs. */
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) LIN[i] = srgb2lin(i);

// --- io ----------------------------------------------------------------------------------

function readPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

function listShots(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.png'))
    .map(f => f.slice(0, -4))
    .sort();
}

// --- comparison --------------------------------------------------------------------------

/**
 * Compare two decoded PNGs and render a diff image.
 *
 * The diff image dims and desaturates B (so you can still see *where* you are in the frame)
 * and paints changed pixels hot magenta whose intensity scales with the per-pixel delta, so a
 * hairline antialiasing shift and a wholesale colour regression do not look alike.
 *
 * @param {PNG} a baseline image
 * @param {PNG} b candidate image
 * @param {number} pixelEps per-pixel linear delta above which a pixel counts as changed
 * @returns {{changedPixels:number, changedFraction:number, maxDelta:number, meanDelta:number, diff:PNG}}
 */
export function comparePng(a, b, pixelEps) {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const diff = new PNG({ width: w, height: h });
  const total = w * h;
  let changed = 0, maxDelta = 0, sumDelta = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ia = (a.width * y + x) << 2;
      const ib = (b.width * y + x) << 2;
      const io = (w * y + x) << 2;

      // Premultiply by alpha so a transparency change registers as a colour change.
      const aa = a.data[ia + 3] / 255, ab = b.data[ib + 3] / 255;
      const ar = LIN[a.data[ia]] * aa, ag = LIN[a.data[ia + 1]] * aa, abl = LIN[a.data[ia + 2]] * aa;
      const br = LIN[b.data[ib]] * ab, bg = LIN[b.data[ib + 1]] * ab, bb = LIN[b.data[ib + 2]] * ab;

      const dr = br - ar, dg = bg - ag, db = bb - abl;
      const dY = luma(dr, dg, db);
      // Chroma residual: what is left of the difference once luma is removed.
      const dCb = db - dY, dCr = dr - dY;
      const delta = Math.sqrt(dY * dY + 0.25 * (dCb * dCb + dCr * dCr));

      sumDelta += delta;
      if (delta > maxDelta) maxDelta = delta;

      if (delta > pixelEps) {
        changed++;
        // Scale to full heat over roughly a tenth of the linear range; small real changes
        // must still be visible on the page, not a faint blush.
        const heat = Math.min(1, 0.25 + delta * 7.5);
        diff.data[io] = Math.round(GROUND[0] + (HOT[0] - GROUND[0]) * heat);
        diff.data[io + 1] = Math.round(GROUND[1] + (HOT[1] - GROUND[1]) * heat);
        diff.data[io + 2] = Math.round(GROUND[2] + (HOT[2] - GROUND[2]) * heat);
      } else {
        const y709 = luma(br, bg, bb);
        const v = lin2srgb(y709 * 0.22);
        diff.data[io] = Math.round(GROUND[0] * 0.35 + v * 0.8);
        diff.data[io + 1] = Math.round(GROUND[1] * 0.35 + v * 0.8);
        diff.data[io + 2] = Math.round(GROUND[2] * 0.35 + v * 0.8);
      }
      diff.data[io + 3] = 255;
    }
  }

  return {
    changedPixels: changed,
    changedFraction: total ? changed / total : 0,
    maxDelta: +maxDelta.toFixed(6),
    meanDelta: total ? +(sumDelta / total).toFixed(8) : 0,
    diff,
  };
}

/**
 * Box-downscale a PNG by an integer factor, for embedding in the report page. Full-resolution
 * PNGs stay on disk; the page would otherwise be tens of megabytes.
 */
function downscale(src, maxW) {
  const factor = Math.max(1, Math.ceil(src.width / maxW));
  if (factor === 1) return src;
  const w = Math.floor(src.width / factor), h = Math.floor(src.height / factor);
  const out = new PNG({ width: w, height: h });
  const n = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < factor; sy++) {
        const row = (y * factor + sy) * src.width;
        for (let sx = 0; sx < factor; sx++) {
          const i = (row + x * factor + sx) << 2;
          r += LIN[src.data[i]]; g += LIN[src.data[i + 1]]; b += LIN[src.data[i + 2]];
        }
      }
      const o = (w * y + x) << 2;
      out.data[o] = lin2srgb(r / n);
      out.data[o + 1] = lin2srgb(g / n);
      out.data[o + 2] = lin2srgb(b / n);
      out.data[o + 3] = 255;
    }
  }
  return out;
}

function dataUri(png) {
  return 'data:image/png;base64,' + PNG.sync.write(png, { deflateLevel: 9 }).toString('base64');
}

// --- report page -------------------------------------------------------------------------

function hex(n) { return '#' + n.toString(16).padStart(6, '0'); }

/**
 * Build the self-contained evidence page. Every image is inlined; the file can be copied
 * anywhere and still render.
 */
function buildHtml(report, cards) {
  const rows = cards.map((c) => {
    const r = c.result;
    const status = r.status;
    const cls = status === 'pass' ? 'ok' : status === 'fail' ? 'bad' : 'warn';
    const imgs = ['a', 'b', 'diff'].map((k) => c.img[k]
      ? `<figure><img src="${c.img[k]}" alt="${r.shot} ${k}" loading="lazy" /><figcaption>${k === 'a' ? 'A — baseline' : k === 'b' ? 'B — candidate' : 'diff'}</figcaption></figure>`
      : `<figure class="missing"><div>no ${k === 'a' ? 'baseline' : k}</div><figcaption>${k === 'a' ? 'A — baseline' : k === 'b' ? 'B — candidate' : 'diff'}</figcaption></figure>`).join('');
    const nums = r.changedPixels === undefined ? '<span class="note">' + (r.note || '') + '</span>' : `
      <span><b>${r.changedPixels.toLocaleString('en-US')}</b> px changed</span>
      <span><b>${(r.changedFraction * 100).toFixed(4)}%</b> of frame</span>
      <span>max &Delta; <b>${r.maxDelta.toFixed(4)}</b></span>
      <span>mean &Delta; <b>${r.meanDelta.toExponential(2)}</b></span>`;
    return `<section class="shot ${cls}">
      <header><h2>${r.shot}</h2><span class="badge">${status.toUpperCase()}</span></header>
      <div class="nums">${nums}</div>
      <div class="grid">${imgs}</div>
    </section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>pixel diff — ${report.shots.length} shot(s)</title>
<style>
  :root{
    --ink:${hex(P.uiInk)}; --paper:${hex(P.uiPaper)}; --paper2:${hex(P.uiPaperDark)};
    --gold:${hex(P.uiGold)}; --red:${hex(P.uiRed)}; --green:${hex(P.uiGreen)};
    --cyan:${hex(P.uiCyan)}; --shadow:${hex(P.uiShadow)};
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--ink);color:var(--paper);
    font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  header.top{padding:20px 24px;border-bottom:2px solid var(--shadow)}
  h1{margin:0 0 6px;font-size:16px;letter-spacing:.18em;text-transform:uppercase;color:var(--gold)}
  .meta{opacity:.7}
  .meta b{color:var(--paper)}
  .verdict{display:inline-block;margin-top:10px;padding:4px 12px;border-radius:3px;
    font-weight:700;letter-spacing:.16em;color:var(--ink)}
  .verdict.pass{background:var(--green)} .verdict.fail{background:var(--red)}
  .verdict.none{background:var(--gold)}
  .shot{border-bottom:1px solid var(--shadow);padding:18px 24px}
  .shot header{display:flex;align-items:center;gap:12px}
  h2{margin:0;font-size:14px;color:var(--cyan)}
  .badge{font-size:11px;padding:2px 8px;border-radius:2px;color:var(--ink);background:var(--paper2)}
  .shot.ok .badge{background:var(--green)}
  .shot.bad .badge{background:var(--red)}
  .shot.warn .badge{background:var(--gold)}
  .nums{display:flex;flex-wrap:wrap;gap:18px;margin:8px 0 12px;opacity:.85}
  .nums b{color:var(--gold)}
  .note{opacity:.75;font-style:italic}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
  figure{margin:0}
  figure img{width:100%;height:auto;display:block;border:1px solid var(--shadow);border-radius:2px}
  figure.missing div{display:flex;align-items:center;justify-content:center;aspect-ratio:16/9;
    border:1px dashed var(--shadow);border-radius:2px;opacity:.5}
  figcaption{margin-top:5px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;opacity:.6}
  footer{padding:18px 24px;opacity:.55}
</style></head>
<body>
<header class="top">
  <h1>pixel diff gate</h1>
  <div class="meta">
    A <b>${report.a}</b> &rarr; B <b>${report.b}</b> &middot;
    threshold <b>${(report.threshold * 100).toFixed(3)}%</b> of frame &middot;
    per-pixel eps <b>${report.pixelEps}</b> (linear) &middot;
    <b>${report.shots.length}</b> shot(s)
  </div>
  <div class="verdict ${report.status}">${report.status.toUpperCase()}</div>
</header>
${rows}
<footer>Compared in linear light, luma weighted 4&times; over chroma. Changed pixels are painted
hot magenta scaled by delta; unchanged pixels are dimmed and desaturated for context.
Previews are downscaled; full-resolution PNGs are alongside this file.</footer>
</body></html>`;
}

// --- driver ------------------------------------------------------------------------------

function parseArgs(argv) {
  const a = {
    a: 'evidence/baseline', b: 'evidence/shots', out: 'evidence/diff',
    threshold: 0.002, pixelEps: 0.0035, update: false, json: false, previewWidth: 900,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--a') a.a = argv[++i];
    else if (k === '--b') a.b = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--threshold') a.threshold = parseFloat(argv[++i]);
    else if (k === '--pixel-eps') a.pixelEps = parseFloat(argv[++i]);
    else if (k === '--preview-width') a.previewWidth = parseInt(argv[++i], 10);
    else if (k === '--update') a.update = true;
    else if (k === '--json') a.json = true;
    else if (k === '--help' || k === '-h') { a.help = true; }
    else { a.bad = k; }
  }
  return a;
}

const USAGE = `usage: node tools/diff/diff.mjs [options]
  --a <dir>            baseline directory        (default evidence/baseline)
  --b <dir>            candidate directory       (default evidence/shots)
  --out <dir>          diff output directory     (default evidence/diff)
  --threshold <f>      max changed fraction      (default 0.002)
  --pixel-eps <f>      per-pixel linear delta    (default 0.0035)
  --preview-width <n>  embedded preview width    (default 900)
  --update             accept B as the new baseline
  --json               machine-readable output`;

/**
 * Run the diff gate.
 * @param {object} args parsed CLI arguments
 * @returns {object} the report written to <out>/report.json
 */
export async function runDiff(args) {
  const aDir = path.resolve(ROOT, args.a);
  const bDir = path.resolve(ROOT, args.b);
  const outDir = path.resolve(ROOT, args.out);

  fs.mkdirSync(outDir, { recursive: true });
  // Every outcome writes report.json, including "nothing to compare". The gate reads this file
  // to distinguish a skip from a pass, and a missing file is indistinguishable from a crash.
  const write = (r) => { fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(r, null, 2)); return r; };

  const bShots = listShots(bDir);
  if (!bShots.length) {
    return write({
      generatedFrom: 'tools/diff/diff.mjs',
      status: 'error', a: rel(aDir), b: rel(bDir), out: rel(outDir),
      threshold: args.threshold, pixelEps: args.pixelEps, shots: [],
      error: `no PNGs in candidate directory ${rel(bDir)} — run the capture tool first`,
    });
  }

  const aShots = listShots(aDir);

  // --update: accept the candidate wholesale. Done before comparison so `--update` on a
  // fresh repo is the documented way to seed a baseline.
  if (args.update) {
    if (path.resolve(aDir) === path.resolve(bDir)) {
      return write({
        generatedFrom: 'tools/diff/diff.mjs',
        status: 'error', a: rel(aDir), b: rel(bDir), out: rel(outDir),
        threshold: args.threshold, pixelEps: args.pixelEps, shots: [],
        error: '--update with --a and --b pointing at the same directory would delete the candidates',
      });
    }
    fs.mkdirSync(aDir, { recursive: true });
    for (const f of fs.readdirSync(aDir)) if (f.toLowerCase().endsWith('.png')) fs.unlinkSync(path.join(aDir, f));
    for (const s of bShots) fs.copyFileSync(path.join(bDir, s + '.png'), path.join(aDir, s + '.png'));
    const manifest = path.join(bDir, 'manifest.json');
    if (fs.existsSync(manifest)) fs.copyFileSync(manifest, path.join(aDir, 'manifest.json'));
    return write({
      generatedFrom: 'tools/diff/diff.mjs',
      status: 'updated', a: rel(aDir), b: rel(bDir), out: rel(outDir),
      threshold: args.threshold, pixelEps: args.pixelEps,
      accepted: bShots.length,
      shots: bShots.map(s => ({ shot: s, status: 'accepted' })),
    });
  }

  if (!aShots.length) {
    return write({
      generatedFrom: 'tools/diff/diff.mjs',
      status: 'no-baseline', a: rel(aDir), b: rel(bDir), out: rel(outDir),
      threshold: args.threshold, pixelEps: args.pixelEps,
      note: `no baseline in ${rel(aDir)} — nothing to compare against. ` +
            `Run with --update to accept ${rel(bDir)} as the baseline.`,
      shots: bShots.map(s => ({ shot: s, status: 'skipped', note: 'no baseline image' })),
    });
  }

  const all = [...new Set([...aShots, ...bShots])].sort();
  const results = [];
  const cards = [];

  for (const shot of all) {
    const aFile = path.join(aDir, shot + '.png');
    const bFile = path.join(bDir, shot + '.png');
    const hasA = fs.existsSync(aFile), hasB = fs.existsSync(bFile);

    if (!hasA) {
      // A shot that exists only in B is new work, not a regression.
      const bp = readPng(bFile);
      results.push({ shot, status: 'added', note: 'new shot — not in baseline', width: bp.width, height: bp.height });
      cards.push({ result: results[results.length - 1], img: { a: null, b: dataUri(downscale(bp, args.previewWidth)), diff: null } });
      continue;
    }
    if (!hasB) {
      // A shot that vanished is a regression: the evidence it provided is gone.
      const ap = readPng(aFile);
      results.push({ shot, status: 'removed', note: 'shot missing from candidate run', width: ap.width, height: ap.height });
      cards.push({ result: results[results.length - 1], img: { a: dataUri(downscale(ap, args.previewWidth)), b: null, diff: null } });
      continue;
    }

    const ap = readPng(aFile), bp = readPng(bFile);
    if (ap.width !== bp.width || ap.height !== bp.height) {
      results.push({
        shot, status: 'fail', note: `size changed ${ap.width}x${ap.height} -> ${bp.width}x${bp.height}`,
        changedPixels: bp.width * bp.height, changedFraction: 1, maxDelta: 1, meanDelta: 1,
        width: bp.width, height: bp.height,
      });
      cards.push({
        result: results[results.length - 1],
        img: { a: dataUri(downscale(ap, args.previewWidth)), b: dataUri(downscale(bp, args.previewWidth)), diff: null },
      });
      continue;
    }

    const cmp = comparePng(ap, bp, args.pixelEps);
    const diffFile = path.join(outDir, shot + '.diff.png');
    fs.writeFileSync(diffFile, PNG.sync.write(cmp.diff));
    const pass = cmp.changedFraction <= args.threshold;
    const r = {
      shot, status: pass ? 'pass' : 'fail',
      width: ap.width, height: ap.height,
      changedPixels: cmp.changedPixels,
      changedFraction: +cmp.changedFraction.toFixed(8),
      maxDelta: cmp.maxDelta,
      meanDelta: cmp.meanDelta,
      identical: cmp.changedPixels === 0,
      diffImage: rel(diffFile),
    };
    results.push(r);
    cards.push({
      result: r,
      img: {
        a: dataUri(downscale(ap, args.previewWidth)),
        b: dataUri(downscale(bp, args.previewWidth)),
        diff: dataUri(downscale(cmp.diff, args.previewWidth)),
      },
    });
  }

  const failed = results.filter(r => r.status === 'fail' || r.status === 'removed');
  const report = {
    generatedFrom: 'tools/diff/diff.mjs',
    a: rel(aDir), b: rel(bDir), out: rel(outDir),
    threshold: args.threshold, pixelEps: args.pixelEps,
    colorSpace: 'linear (sRGB decoded)', weighting: 'luma 1.0, chroma 0.25',
    status: failed.length ? 'fail' : 'pass',
    failed: failed.map(r => r.shot),
    shots: results,
  };
  fs.writeFileSync(path.join(outDir, 'index.html'), buildHtml(report, cards));
  return write(report);
}

function printTable(report) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`diff: A=${report.a}  B=${report.b}  threshold=${report.threshold}`);
  if (report.status === 'no-baseline') {
    console.log(`  ${report.note}`);
    for (const s of report.shots) console.log(`  - ${pad(s.shot, 26)} skipped: no baseline image`);
    console.log('NO BASELINE — gate skipped');
    return;
  }
  if (report.status === 'updated') {
    for (const s of report.shots) console.log(`  + ${s.shot}`);
    console.log(`BASELINE UPDATED — ${report.accepted} shot(s) accepted from ${report.b}`);
    return;
  }
  if (report.status === 'error') { console.log('  ' + report.error); return; }

  console.log(`  ${pad('shot', 26)} ${pad('status', 8)} ${'changed px'.padStart(11)} ${'fraction'.padStart(10)} ${'maxD'.padStart(8)} ${'meanD'.padStart(10)}`);
  for (const r of report.shots) {
    if (r.changedPixels === undefined) {
      console.log(`  ${pad(r.shot, 26)} ${pad(r.status, 8)} ${(r.note || '').slice(0, 44)}`);
      continue;
    }
    console.log(`  ${pad(r.shot, 26)} ${pad(r.status, 8)} ${String(r.changedPixels).padStart(11)} ` +
      `${(r.changedFraction * 100).toFixed(4).padStart(9)}% ${r.maxDelta.toFixed(4).padStart(8)} ${r.meanDelta.toExponential(2).padStart(10)}`);
  }
  console.log(`  report: ${report.out}/report.json`);
  console.log(`  page:   ${report.out}/index.html`);
  console.log(report.status === 'pass'
    ? `PASS — ${report.shots.length} shot(s) within threshold`
    : `FAIL — ${report.failed.length} shot(s) over threshold: ${report.failed.join(', ')}`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(USAGE); process.exit(0); }
  if (args.bad) { console.error(`diff: unknown argument ${args.bad}\n\n${USAGE}`); process.exit(2); }
  if (!Number.isFinite(args.threshold) || args.threshold < 0) { console.error('diff: --threshold must be >= 0'); process.exit(2); }
  const report = await runDiff(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printTable(report);
  if (report.status === 'error') process.exit(2);
  process.exit(report.status === 'fail' ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
