#!/usr/bin/env node
// Performance gate. Runs each scenario in a real browser on the REAL GPU and fails the build
// when a frame-time, shader or memory objective is missed.
//
// Why the real GPU: SwiftShader gives us bit-identical pixels, which is what pixel evidence
// needs and exactly what performance evidence must not use. A software rasteriser's timings
// describe a CPU that is not shipping the game.
//
// Gates (all from the brief):
//   p95 <= 16.7ms            a 60fps frame, at the 95th percentile, not on average
//   p99 <= 33ms              no visible hitching
//   shader compiles == 0     everything is compiled by Renderer.prewarm()
//   console errors == 0
//   heap growth <= 25%       measured from a post-warmup baseline
//
// Usage:
//   node tools/profile/profile.mjs [--scenarios a,b] [--seed 20260814] [--w 1920] [--h 1080]
//                                  [--seconds 30] [--minutes 20] [--out evidence/perf] [--json]
//                                  [--headed] [--keep-open]
//
// --minutes runs a single long session per scenario; that is the memory-stability run.
//
// Exit: 0 all gates pass, 1 a gate failed, 2 bad invocation or the page never became ready.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, startServer, ensureDir, ROOT } from '../lib.mjs';

const GATES = {
  p95Ms: 16.7,
  p99Ms: 33.0,
  shaderCompiles: 0,
  consoleErrors: 0,
  heapGrowthPct: 25,
};

function toPosix(p) { return p.split(path.sep).join('/'); }

function parseArgs(argv) {
  const a = {
    out: 'evidence/perf', seed: '20260814', w: 1920, h: 1080,
    scenarios: null, seconds: null, minutes: null, json: false,
    headed: false, keepOpen: false, reuseBrowser: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--out') a.out = argv[++i];
    else if (k === '--seed') a.seed = argv[++i];
    else if (k === '--w') a.w = parseInt(argv[++i], 10);
    else if (k === '--h') a.h = parseInt(argv[++i], 10);
    else if (k === '--scenarios') a.scenarios = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (k === '--seconds') a.seconds = parseFloat(argv[++i]);
    else if (k === '--minutes') a.minutes = parseFloat(argv[++i]);
    else if (k === '--headed') a.headed = true;
    else if (k === '--keep-open') a.keepOpen = true;
    else if (k === '--reuse-browser') a.reuseBrowser = true;
    else if (k === '--json') a.json = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else a.bad = k;
  }
  if (a.minutes) a.seconds = a.minutes * 60;
  return a;
}

const USAGE = `usage: node tools/profile/profile.mjs [options]
  --scenarios a,b   only these scenario ids            (default: all)
  --seed <n>        world seed                         (default 20260814)
  --w / --h <px>    viewport                           (default 1920x1080)
  --seconds <f>     override each scenario's length
  --minutes <f>     run each scenario this long — the memory-stability session
  --out <dir>       report directory                   (default evidence/perf)
  --reuse-browser   one browser for every scenario     (faster; less isolated)
  --headed          show the browser
  --json            machine-readable output`;

/**
 * Extra Chromium flags the profiler needs.
 *   --enable-precise-memory-info : performance.memory, without which heap growth is unmeasurable
 *   --expose-gc                  : lets the page collect before sampling, so growth means growth
 */
const PROFILE_ARGS = [
  '--enable-precise-memory-info',
  '--js-flags=--expose-gc',
];

/** Evaluate the gates against one scenario report. */
function gradeRun(r) {
  const checks = [];
  const push = (name, actual, limit, ok, unit) => checks.push({ name, actual, limit, unit, pass: ok });

  push('p95', r.p95, GATES.p95Ms, r.p95 <= GATES.p95Ms, 'ms');
  push('p99', r.p99, GATES.p99Ms, r.p99 <= GATES.p99Ms, 'ms');
  // The profiler times CPU inside the RAF callback. GPU wait and compositor time show up only
  // as the gap between callbacks, so throughput is gated too — otherwise a GPU-bound frame
  // passes a CPU gate while the game visibly stutters.
  if (r.present && r.present.samples > 30) {
    push('presentP95', r.present.p95, GATES.p95Ms, r.present.p95 <= GATES.p95Ms, 'ms');
    push('presentP99', r.present.p99, GATES.p99Ms, r.present.p99 <= GATES.p99Ms, 'ms');
  }
  push('shaderCompiles', r.shaderCompilesDuringPlay, GATES.shaderCompiles,
    r.shaderCompilesDuringPlay <= GATES.shaderCompiles, '');
  push('consoleErrors', r.errors.length, GATES.consoleErrors, r.errors.length <= GATES.consoleErrors, '');
  if (r.heap && r.heap.available && r.heap.growthPct !== null) {
    push('heapGrowth', r.heap.growthPct, GATES.heapGrowthPct, r.heap.growthPct <= GATES.heapGrowthPct, '%');
  } else {
    checks.push({
      name: 'heapGrowth', actual: null, limit: GATES.heapGrowthPct, unit: '%', pass: true,
      skipped: 'skipped: performance.memory unavailable (needs --enable-precise-memory-info)',
    });
  }
  return { checks, pass: checks.every(c => c.pass) };
}

/**
 * Run one scenario in its own page.
 *
 * A fresh browser *process* per scenario by default, for the same reason capture uses one:
 * state cannot leak, and — specific to profiling — Chromium refuses a new WebGL context when a
 * previous one in the same process has not been reclaimed yet, which would report as a boot
 * failure in a scenario that is perfectly healthy.
 */
async function runScenario(browser, baseUrl, id, args) {
  const ctx = await browser.newContext({
    viewport: { width: args.w, height: args.h },
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
    timezoneId: 'UTC',
    locale: 'en-US',
    bypassCSP: true,
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
    // Long sessions (--minutes) heartbeat through console so the log shows progress.
    else if (m.text().startsWith('[profile]')) console.log('  ' + m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  // Generous: a 20-minute session plus boot, plus slack for a cold shader cache.
  const budgetMs = Math.max(180000, (args.seconds || 60) * 1000 * 1.8 + 120000);

  try {
    const url = `${baseUrl}/profile.html?scenario=${encodeURIComponent(id)}&seed=${args.seed}&w=${args.w}&h=${args.h}`;
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction('window.__P && window.__PROFILE_READY === true', { timeout: 180000 });

    const bootError = await page.evaluate(() => window.__PROFILE_ERROR || null);
    if (bootError) throw new Error('boot failed: ' + String(bootError).split('\n')[0]);

    const report = await page.evaluate(
      ({ id: sid, seconds }) => window.__P.run(sid, seconds || undefined),
      { id, seconds: args.seconds },
      { timeout: budgetMs },
    );
    report.errors = [...new Set([...(report.errors || []), ...consoleErrors])];
    await page.evaluate(() => window.__P.dispose());
    return report;
  } catch (e) {
    return {
      scenario: id, status: 'error',
      error: String(e && e.message ? e.message : e),
      errors: consoleErrors,
      p50: 0, p95: 0, p99: 0, p999: 0, worst: 0, frames: 0,
      shaderCompilesDuringPlay: 0,
      heap: { available: false, growthPct: null },
    };
  } finally {
    if (!args.keepOpen) await ctx.close();
  }
}

/** Read the scenario catalog from the page, so the tool never hardcodes the list. */
async function readCatalog(browser, baseUrl, args) {
  const ctx = await browser.newContext({ viewport: { width: 320, height: 200 } });
  const page = await ctx.newPage();
  try {
    await page.goto(`${baseUrl}/profile.html?scenario=__list__&seed=${args.seed}&w=320&h=200`,
      { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction('window.__P && window.__P.catalog', { timeout: 120000 });
    return await page.evaluate(() => window.__P.catalog);
  } finally {
    await ctx.close();
  }
}

function pad(s, n) { return String(s).padEnd(n); }
function padl(s, n) { return String(s).padStart(n); }

function printTable(report) {
  console.log('');
  console.log('  cpu = time inside the frame callback; present = RAF-to-RAF, which includes GPU wait');
  console.log(`  ${pad('scenario', 24)} ${pad('status', 9)} ${padl('frames', 7)} ${padl('cpu p50', 8)} ${padl('cpu p95', 8)} ${padl('cpu p99', 8)} ${padl('pres p95', 9)} ${padl('fps', 6)} ${padl('shader', 7)} ${padl('heap%', 7)} ${padl('errs', 5)}  gate`);
  console.log('  ' + '-'.repeat(124));
  for (const r of report.runs) {
    const g = r.gate;
    const heap = r.heap && r.heap.growthPct !== null ? r.heap.growthPct.toFixed(1) : ' n/a';
    const pr = r.present || { p95: 0, fps: 0 };
    console.log(`  ${pad(r.scenario, 24)} ${pad(r.status, 9)} ${padl(r.frames || 0, 7)} ` +
      `${padl((r.p50 || 0).toFixed(2), 8)} ${padl((r.p95 || 0).toFixed(2), 8)} ${padl((r.p99 || 0).toFixed(2), 8)} ` +
      `${padl(pr.p95.toFixed(2), 9)} ${padl(pr.fps.toFixed(0), 6)} ${padl(r.shaderCompilesDuringPlay || 0, 7)} ${padl(heap, 7)} ` +
      `${padl((r.errors || []).length, 5)}  ${g.pass ? 'PASS' : 'FAIL'}`);
    for (const c of g.checks) {
      if (c.skipped) console.log(`      - ${c.name}: ${c.skipped}`);
      else if (!c.pass) console.log(`      X ${c.name}: ${c.actual}${c.unit} > ${c.limit}${c.unit}`);
    }
    if (r.note) console.log(`      ! ${r.note}`);
    if (r.error) console.log(`      X ${r.error}`);
    if (r.warmup) console.log(`      warmup: ${r.warmup.frames} frame(s), worst ${r.warmup.worstMs}ms (boot cost, not gated)`);
    const top = (r.worstHitches || [])[0];
    if (top) console.log(`      worst hitch ${top.ms}ms attributed to ${top.cause} (${top.causeMs}ms)`);
    for (const e of (r.errors || []).slice(0, 3)) console.log(`      console: ${String(e).slice(0, 160)}`);
  }
  console.log('');
  console.log(report.pass
    ? `PERF: PASS — ${report.runs.length} scenario(s), all gates met`
    : `PERF: FAIL — ${report.failed.join(', ')}`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(USAGE); process.exit(0); }
  if (args.bad) { console.error(`profile: unknown argument ${args.bad}\n\n${USAGE}`); process.exit(2); }

  const server = await startServer(5273);
  console.log(`server: ${server.url}${server.reused ? ' (reused)' : ''}`);
  const browser = await launch({ gpu: true, extraArgs: PROFILE_ARGS });

  try {
    // Confirm we really are on hardware. A profile run on SwiftShader is a false pass.
    const probeCtx = await browser.newContext({ viewport: { width: 320, height: 200 } });
    const probe = await probeCtx.newPage();
    const gpuInfo = await probe.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (!gl) return { ok: false, renderer: 'no webgl2' };
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      return { ok: true, renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
    });
    await probeCtx.close();
    const software = /swiftshader|llvmpipe|software/i.test(gpuInfo.renderer || '');
    console.log(`gpu: ${gpuInfo.renderer}${software ? '  <-- SOFTWARE: timings are not meaningful' : ''}`);

    const catalog = await readCatalog(browser, server.url, args);
    const all = catalog.map(c => c.id);
    let ids = args.scenarios ? args.scenarios.filter(s => all.includes(s)) : all;
    if (args.scenarios) {
      const missing = args.scenarios.filter(s => !all.includes(s));
      if (missing.length) console.log('warning: unknown scenarios ignored: ' + missing.join(','));
    }
    if (!ids.length) { console.error('profile: no scenarios to run'); process.exit(2); }

    const lengths = Object.fromEntries(catalog.map(c => [c.id, c.seconds]));
    const totalS = ids.reduce((s, id) => s + (args.seconds || lengths[id]), 0);
    console.log(`scenarios: ${ids.length} @ ${args.w}x${args.h} seed=${args.seed}` +
      `  (~${Math.round(totalS)}s of simulated play)`);

    const outDir = path.join(ROOT, args.out);
    ensureDir(outDir);

    const runs = [];
    for (const id of ids) {
      process.stdout.write(`  running ${id} ... `);
      const own = args.reuseBrowser ? null : await launch({ gpu: true, extraArgs: PROFILE_ARGS });
      let r;
      try {
        r = await runScenario(own || browser, server.url, id, args);
      } finally {
        if (own) await own.close();
      }
      r.gate = gradeRun(r);
      r.status = r.status || 'ok';
      runs.push(r);
      fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(r, null, 2));
      process.stdout.write(`${r.status} cpu-p95=${(r.p95 || 0).toFixed(2)}ms ` +
        `present-p95=${((r.present && r.present.p95) || 0).toFixed(2)}ms ${r.gate.pass ? 'PASS' : 'FAIL'}\n`);
    }

    const failed = runs.filter(r => !r.gate.pass || r.status === 'error').map(r => r.scenario);
    const report = {
      generatedFrom: 'tools/profile/profile.mjs',
      seed: args.seed, width: args.w, height: args.h,
      gpu: gpuInfo.renderer, softwareRasteriser: software,
      gates: GATES,
      secondsOverride: args.seconds,
      minutes: args.minutes,
      degraded: runs.filter(r => r.status === 'degraded').map(r => ({ scenario: r.scenario, missing: r.missingSystems })),
      pass: failed.length === 0 && !software,
      failed,
      runs,
    };
    if (software) report.failed.push('software-rasteriser');
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printTable(report);
    console.log(`report: ${toPosix(path.relative(ROOT, path.join(outDir, 'report.json')))}`);
    process.exitCode = report.pass ? 0 : 1;
  } finally {
    await browser.close();
    await server.stop();
  }
}

// Only run when invoked directly — importing this module (for its gates, or an import check)
// must not launch a browser.
// The explicit exit matters: a hung browser.close() once left a finished run alive with its
// last page still rendering, silently sharing the GPU with (and corrupting) the next
// measurement session. The report is on disk by now; nothing after it deserves the process.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(process.exitCode ?? 0),
    e => { console.error(e); process.exit(1); },
  );
}
