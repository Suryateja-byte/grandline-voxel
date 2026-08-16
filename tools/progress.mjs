// Generates evidence/progress.html — the live view of the run.
//
// Reads whatever evidence exists right now (shot manifest, perf report, gate report, playtest,
// verdicts) and renders a single self-contained page. Missing evidence is shown as missing,
// never as a placeholder that implies work that has not happened.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ensureDir } from './lib.mjs';
import { PNG } from 'pngjs';

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); } catch { return null; }
};
const readText = (p) => {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return null; }
};
/**
 * Inline a shot as base64, box-downsampled so the page stays small enough to open and share.
 * Full-resolution PNGs live in evidence/shots/ and are what the diff gate actually compares.
 */
const b64 = (p, maxW = 720) => {
  try {
    const buf = fs.readFileSync(path.join(ROOT, p));
    const src = PNG.sync.read(buf);
    if (src.width <= maxW) return buf.toString('base64');
    const f = Math.ceil(src.width / maxW);
    const w = Math.floor(src.width / f), h = Math.floor(src.height / f);
    const dst = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let sy = 0; sy < f; sy++) {
          for (let sx = 0; sx < f; sx++) {
            const i = ((y * f + sy) * src.width + (x * f + sx)) * 4;
            r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; n++;
          }
        }
        const o = (y * w + x) * 4;
        dst.data[o] = r / n; dst.data[o + 1] = g / n; dst.data[o + 2] = b / n; dst.data[o + 3] = 255;
      }
    }
    return PNG.sync.write(dst).toString('base64');
  } catch { return null; }
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function gateRow(name, state, detail) {
  const cls = state === 'PASS' ? 'pass' : state === 'FAIL' ? 'fail' : 'unk';
  const label = state === 'PASS' ? 'PASS' : state === 'FAIL' ? 'FAIL' : 'not yet measured';
  return `<tr><td>${esc(name)}</td><td class="${cls}">${label}</td><td class="detail">${esc(detail || '')}</td></tr>`;
}

function main() {
  const manifest = readJson('evidence/shots/manifest.json');
  const perf = readJson('evidence/perf/report.json');
  // The 20-minute session writes to its own directory so a quick re-profile can never
  // overwrite the expensive soak evidence.
  const soak = readJson('evidence/perf-soak/report.json');
  const gate = readJson('evidence/reports/gate.json');
  const playtest = readJson('evidence/reports/playtest.json');
  const verdicts = readJson('evidence/reports/verdicts.json') || { rounds: [] };
  const progressMd = readText('PROGRESS.md') || '';

  // ---- objective gates from the brief -------------------------------------
  const gates = [];
  if (manifest && manifest.determinism) {
    gates.push(['Identical world from an identical seed (bit-identical capture x2)',
      manifest.determinism.identical ? 'PASS' : 'FAIL',
      `${manifest.determinism.compared} shots compared`]);
  } else {
    gates.push(['Identical world from an identical seed (bit-identical capture x2)', 'UNKNOWN', 'run: npm run capture -- --verify']);
  }
  if (manifest) {
    const errs = manifest.shotsWithErrors || 0;
    gates.push(['Zero console errors', errs === 0 ? 'PASS' : 'FAIL', `${errs} shot(s) with errors`]);
    const np = manifest.shots.reduce((a, s) => a + (s.newProgramsSincePrewarm || 0), 0);
    gates.push(['Zero shader compilations during play', np === 0 ? 'PASS' : 'FAIL',
      `${np} program(s) linked after prewarm across ${manifest.shots.length} shots`]);
    const boots = manifest.shots.map(s => s.bootMs).filter(Boolean);
    const worstBoot = boots.length ? Math.max(...boots) : null;
    gates.push(['Boot to playable under 5s', worstBoot === null ? 'UNKNOWN' : (worstBoot < 5000 ? 'PASS' : 'FAIL'),
      worstBoot === null ? '' : `worst boot ${worstBoot.toFixed(0)} ms`]);
  }
  // Frame-time gates take the worse of CPU time and RAF-to-RAF present time per scenario,
  // matching tools/profile/profile.mjs gradeRun — a GPU-bound frame must not pass a CPU gate.
  const worstPct = (runs, key) => Math.max(...runs.map(r => Math.max(r[key] || 0, (r.present && r.present[key]) || 0)));
  if (perf && perf.runs && perf.runs.length && !perf.softwareRasteriser) {
    const runs = perf.runs;
    const worst95 = worstPct(runs, 'p95');
    const worst99 = worstPct(runs, 'p99');
    const clean = runs.every(r => r.status === 'ok');
    gates.push(['p95 frame time under 16.7 ms @1080p', worst95 && clean ? (worst95 < 16.7 ? 'PASS' : 'FAIL') : 'UNKNOWN',
      `worst p95 ${worst95.toFixed(2)} ms across ${runs.length} scenario(s) on ${perf.gpu || 'unknown GPU'}`]);
    gates.push(['p99 frame time under 33 ms @1080p', worst99 && clean ? (worst99 < 33 ? 'PASS' : 'FAIL') : 'UNKNOWN',
      `worst p99 ${worst99.toFixed(2)} ms across ${runs.length} scenario(s)`]);
  } else {
    gates.push(['p95 frame time under 16.7 ms @1080p', 'UNKNOWN', 'run: npm run profile']);
    gates.push(['p99 frame time under 33 ms @1080p', 'UNKNOWN', 'run: npm run profile']);
  }
  const soakRun = soak && soak.runs && soak.runs.find(r => r.heap && r.heap.available && r.heap.growthPct !== null);
  if (soakRun && (soakRun.seconds || 0) >= 19.5 * 60) {
    const h = soakRun.heap;
    gates.push(['Stable memory across a 20 minute session', h.growthPct <= 25 ? 'PASS' : 'FAIL',
      `${soakRun.scenario}: heap ${h.growthPct >= 0 ? '+' : ''}${h.growthPct.toFixed(1)}% over ${(soakRun.seconds / 60).toFixed(1)} min ` +
      `(baseline ${h.baselineMB} MB, end ${h.endMB} MB, peak ${h.peakMB ?? '?'} MB)`]);
  } else {
    gates.push(['Stable memory across a 20 minute session', 'UNKNOWN',
      'run: npm run profile -- --scenarios stress-everything --minutes 20 --out evidence/perf-soak']);
  }
  if (playtest) {
    // Steps report status: 'pass' | 'fail' | 'skip' — there is no boolean `pass` field.
    const steps = playtest.steps || [];
    const failed = steps.filter(s => (s.status ? s.status !== 'pass' : !s.pass));
    gates.push(['Scripted playtest completes the full loop', failed.length === 0 ? 'PASS' : 'FAIL',
      `${steps.length - failed.length}/${steps.length} steps`]);
  } else {
    gates.push(['Scripted playtest completes the full loop', 'UNKNOWN', 'run: npm run playtest']);
  }

  // ---- shots --------------------------------------------------------------
  let shotHtml = '<p class="muted">No captures yet.</p>';
  if (manifest && manifest.shots && manifest.shots.length) {
    shotHtml = manifest.shots.map(s => {
      const img = b64(s.file);
      return `<figure>
        ${img ? `<img loading="lazy" src="data:image/png;base64,${img}" alt="${esc(s.shot)}">` : '<div class="missing">image missing</div>'}
        <figcaption>
          <strong>${esc(s.shot)}</strong>
          <span class="mono">${esc((s.hash || '').slice(0, 12))}</span>
          <span class="muted">${s.drawCalls ?? '?'} draws &middot; ${(s.triangles ?? 0).toLocaleString()} tris &middot; boot ${s.bootMs ?? '?'} ms</span>
          ${s.consoleErrors && s.consoleErrors.length ? `<span class="fail">${s.consoleErrors.length} console error(s)</span>` : ''}
        </figcaption>
      </figure>`;
    }).join('\n');
  }

  // ---- perf ---------------------------------------------------------------
  let perfHtml = '<p class="muted">No profile run yet. <span class="mono">npm run profile</span></p>';
  const perfRows = [
    ...(perf && perf.runs ? perf.runs : []),
    ...(soak && soak.runs ? soak.runs.map(r => ({ ...r, scenario: r.scenario + ' (20-min soak)' })) : []),
  ];
  if (perfRows.length) {
    perfHtml = `<table><thead><tr><th>scenario</th><th>len</th><th>p50</th><th>p95</th><th>p99</th><th>gpu p95</th><th>fps</th><th>res scale</th><th>heap %</th><th>frames</th><th>worst hitch</th><th>gate</th></tr></thead><tbody>` +
      perfRows.map(r => {
        const pr = r.present || { p95: 0, fps: 0 };
        const top = (r.worstHitches || [])[0];
        const heap = r.heap && r.heap.growthPct !== null && r.heap.growthPct !== undefined ? r.heap.growthPct.toFixed(1) : 'n/a';
        const gatePass = r.gate ? r.gate.pass : false;
        const drs = r.dynamicRes && r.dynamicRes.enabled
          ? (r.dynamicRes.minSeen < 1 ? `${r.dynamicRes.scale.toFixed(2)} (min ${r.dynamicRes.minSeen.toFixed(2)})` : 'native')
          : 'native (fixed)';
        return `<tr><td>${esc(r.scenario)}${r.status !== 'ok' ? ` <span class="fail">[${esc(r.status)}]</span>` : ''}</td>` +
          `<td>${((r.seconds ?? 0) / 60) >= 1 ? ((r.seconds ?? 0) / 60).toFixed(1) + 'm' : (r.seconds ?? 0) + 's'}</td>` +
          `<td>${(r.p50 ?? 0).toFixed(2)}</td>` +
          `<td class="${(r.p95 ?? 99) < 16.7 ? 'pass' : 'fail'}">${(r.p95 ?? 0).toFixed(2)}</td>` +
          `<td class="${(r.p99 ?? 99) < 33 ? 'pass' : 'fail'}">${(r.p99 ?? 0).toFixed(2)}</td>` +
          `<td class="${pr.p95 < 16.7 ? 'pass' : 'fail'}">${pr.p95.toFixed(2)}</td>` +
          `<td>${pr.fps ? pr.fps.toFixed(0) : '?'}</td>` +
          `<td>${esc(drs)}</td>` +
          `<td>${heap}</td><td>${r.frames ?? 0}</td>` +
          `<td class="detail">${top ? top.ms.toFixed(1) + ' ms &rarr; ' + esc(top.cause) : '&mdash;'}</td>` +
          `<td class="${gatePass ? 'pass' : 'fail'}">${gatePass ? 'PASS' : 'FAIL'}</td></tr>`;
      }).join('') + '</tbody></table>' +
      `<p class="muted">GPU: ${esc((perf || soak).gpu || 'unknown')} @ ${(perf || soak).width}x${(perf || soak).height}. ` +
      'p50/p95/p99 = max(per-frame CPU, GPU throughput batches) per percentile; gpu p95 = the GPU batch distribution alone. ' +
      '"res scale" is the dynamic-resolution scale the run settled at (shipped adaptive quality; capture evidence always renders native). ' +
      'Percentiles only. Averages are deliberately not reported.</p>';
  }

  // ---- verdicts -----------------------------------------------------------
  let verdictHtml = '<p class="muted">No blind critiques recorded yet.</p>';
  if (verdicts.rounds && verdicts.rounds.length) {
    verdictHtml = verdicts.rounds.map(r => `<div class="verdict ${r.verdict === 'SHIP IT' ? 'ship' : 'fail'}">
      <div class="vhead"><strong>${esc(r.piece)}</strong> &middot; round ${esc(r.round)} &middot;
        <span class="${r.verdict === 'SHIP IT' ? 'pass' : 'fail'}">${esc(r.verdict)}</span></div>
      ${r.gap ? `<div class="vgap"><em>biggest gap:</em> ${esc(r.gap)}</div>` : ''}
      ${r.evidence ? `<div class="vev"><em>evidence:</em> ${esc(r.evidence)}</div>` : ''}
      ${r.minimumChange ? `<div class="vfix"><em>minimum change:</em> ${esc(r.minimumChange)}</div>` : ''}
    </div>`).join('\n');
  }

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Grand Line Voxel — build progress</title>
<style>
:root{--bg:#0f1620;--panel:#17212e;--line:#25333f;--ink:#e9eef5;--muted:#8ba0b5;
      --pass:#5fbf4b;--fail:#e2574c;--gold:#e8b93c;--cyan:#3fc6d6}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{padding:26px 28px 18px;border-bottom:1px solid var(--line);background:var(--panel)}
h1{margin:0 0 6px;font-size:19px;letter-spacing:.14em;text-transform:uppercase;color:var(--gold)}
h2{font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:var(--cyan);
  margin:34px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}
main{padding:0 28px 60px;max-width:1500px}
.muted{color:var(--muted)}
.mono{font-family:inherit;color:var(--muted)}
table{border-collapse:collapse;width:100%;margin:8px 0}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:400;font-size:12px;letter-spacing:.1em;text-transform:uppercase}
.pass{color:var(--pass)}.fail{color:var(--fail)}.unk{color:var(--muted)}
td.detail{color:var(--muted);font-size:13px}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(430px,1fr));gap:18px}
figure{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:6px;overflow:hidden}
figure img{width:100%;display:block;background:#000}
figcaption{padding:9px 11px;display:flex;flex-direction:column;gap:2px;font-size:12px}
.missing{padding:60px;text-align:center;color:var(--fail)}
.verdict{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--fail);
  padding:11px 14px;margin-bottom:10px;border-radius:4px}
.verdict.ship{border-left-color:var(--pass)}
.vhead{margin-bottom:5px}
.vgap,.vev,.vfix{color:var(--muted);font-size:13px;margin-top:3px}
pre{background:var(--panel);border:1px solid var(--line);padding:14px;border-radius:6px;
  overflow-x:auto;white-space:pre-wrap;font-size:13px;color:var(--muted)}
.stamp{color:var(--muted);font-size:12px}
</style></head><body>
<header>
  <h1>Grand Line Voxel — build progress</h1>
  <div class="stamp">generated by <span class="mono">tools/progress.mjs</span> from the evidence on disk.
  Every number below was measured, not described. Anything unmeasured says so.</div>
</header>
<main>

<h2>Objective gates</h2>
<table><thead><tr><th>gate</th><th>state</th><th>evidence</th></tr></thead><tbody>
${gates.map(g => gateRow(g[0], g[1], g[2])).join('\n')}
</tbody></table>

<h2>Latest captures${manifest ? ` &mdash; seed ${esc(manifest.seed)} @ ${manifest.width}x${manifest.height}, ${esc(manifest.rasteriser)}` : ''}</h2>
<div class="shots">
${shotHtml}
</div>

<h2>Performance (real GPU, percentiles only)</h2>
${perfHtml}

<h2>Blind critique verdicts</h2>
${verdictHtml}

<h2>PROGRESS.md</h2>
<pre>${esc(progressMd)}</pre>

</main></body></html>`;

  ensureDir(path.join(ROOT, 'evidence'));
  const out = path.join(ROOT, 'evidence/progress.html');
  fs.writeFileSync(out, html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`wrote evidence/progress.html (${kb} KB)`);
  const failing = gates.filter(g => g[1] === 'FAIL').length;
  const unknown = gates.filter(g => g[1] === 'UNKNOWN').length;
  console.log(`gates: ${gates.length - failing - unknown} pass, ${failing} fail, ${unknown} not yet measured`);
}

main();
