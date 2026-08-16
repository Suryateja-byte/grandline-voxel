// Deterministic headless screenshot capture.
//
// Hard requirements from the brief, and how each is met:
//  - "each shot in an isolated page so state cannot leak between captures"
//      -> a fresh BrowserContext *and* page per shot, and (by default) a fresh browser
//         process per shot. No storage, no cache, no GPU program cache reuse.
//  - "deterministic"
//      -> SwiftShader software rasterisation, fixed viewport, fixed seed, no RAF; the page
//         renders exactly two frames and stops. Output PNGs are SHA-256'd.
//  - "prove two consecutive capture runs are bit-identical"
//      -> `--verify` runs the whole list twice and compares hashes.
//
// Usage:
//   node tools/capture/capture.mjs [--out evidence/shots] [--seed 20260814]
//                                  [--shots a,b,c] [--w 1920] [--h 1080]
//                                  [--verify] [--reuse-browser]

import fs from 'node:fs';
import path from 'node:path';
import { launch, startServer, sha256, ensureDir, ROOT, rimraf } from '../lib.mjs';

function parseArgs(argv) {
  const a = { out: 'evidence/shots', seed: '20260814', w: 1920, h: 1080, verify: false, reuseBrowser: false, shots: null, timeout: 120000 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--out') a.out = argv[++i];
    else if (k === '--seed') a.seed = argv[++i];
    else if (k === '--shots') a.shots = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (k === '--w') a.w = parseInt(argv[++i], 10);
    else if (k === '--h') a.h = parseInt(argv[++i], 10);
    else if (k === '--timeout') a.timeout = parseInt(argv[++i], 10);
    else if (k === '--verify') a.verify = true;
    else if (k === '--reuse-browser') a.reuseBrowser = true;
  }
  return a;
}

async function listShots(baseUrl, args) {
  const browser = await launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 640, height: 400 } });
    const page = await ctx.newPage();
    const url = `${baseUrl}/harness.html?shot=__list__&seed=${args.seed}&w=320&h=200`;
    await page.goto(url, { waitUntil: 'load', timeout: args.timeout });
    await page.waitForFunction('window.__H && window.__H.shots', { timeout: args.timeout });
    const shots = await page.evaluate(() => window.__H.shots);
    await ctx.close();
    return shots;
  } finally {
    await browser.close();
  }
}

/** Capture one shot in complete isolation. */
async function captureShot(baseUrl, shot, args, browser) {
  const ownBrowser = !browser;
  const b = browser || await launch();
  try {
    const ctx = await b.newContext({
      viewport: { width: args.w, height: args.h },
      deviceScaleFactor: 1,
      colorScheme: 'light',
      reducedMotion: 'reduce',
      timezoneId: 'UTC',
      locale: 'en-US',
      bypassCSP: true,
      // No storage state: every shot starts from a blank profile.
    });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

    const url = `${baseUrl}/harness.html?shot=${encodeURIComponent(shot)}&seed=${args.seed}&w=${args.w}&h=${args.h}`;
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'load', timeout: args.timeout });
    await page.waitForFunction('window.__SHOT_READY === true', { timeout: args.timeout });
    const info = await page.evaluate(() => ({
      shot: window.__SHOT_INFO || null,
      err: window.__SHOT_ERROR || null,
      stats: window.__H ? window.__H.stats() : null,
    }));
    // Read the WebGL backbuffer directly rather than screenshotting the element. This bypasses
    // the compositor entirely (no scroll-into-view, no stability wait, no page zoom), so what we
    // hash is exactly what the renderer produced. preserveDrawingBuffer is on in capture mode.
    const dataUrl = await page.evaluate(() => document.getElementById('game').toDataURL('image/png'));
    const png = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
    const ms = Date.now() - t0;
    await ctx.close();
    return { png, info, consoleErrors, ms };
  } finally {
    if (ownBrowser) await b.close();
  }
}

async function runOnce(baseUrl, shots, args, outDir) {
  ensureDir(outDir);
  const results = [];
  let browser = args.reuseBrowser ? await launch() : null;
  try {
    for (const shot of shots) {
      const r = await captureShot(baseUrl, shot, args, browser);
      const file = path.join(outDir, `${shot}.png`);
      fs.writeFileSync(file, r.png);
      const hash = sha256(r.png);
      const errs = (r.consoleErrors || []).concat((r.info && r.info.stats && r.info.stats.errors) || []);
      results.push({
        shot, file: path.relative(ROOT, file).replace(/\\/g, '/'), hash,
        bytes: r.png.length, ms: r.ms,
        drawCalls: r.info && r.info.shot ? r.info.shot.drawCalls : null,
        triangles: r.info && r.info.shot ? r.info.shot.triangles : null,
        newProgramsSincePrewarm: r.info && r.info.shot ? r.info.shot.newPrograms : null,
        bootMs: r.info && r.info.stats ? r.info.stats.bootMs : null,
        prewarmMs: r.info && r.info.stats ? r.info.stats.prewarmMs : null,
        error: (r.info && r.info.err) || null,
        consoleErrors: errs,
      });
      const bad = errs.length || (r.info && r.info.err);
      process.stdout.write(`  ${bad ? 'X' : 'o'} ${shot.padEnd(26)} ${hash.slice(0, 12)}  ${String(r.ms).padStart(6)}ms` +
        `  draws=${r.info && r.info.shot ? r.info.shot.drawCalls : '?'}` +
        `  newProg=${r.info && r.info.shot ? r.info.shot.newPrograms : '?'}\n`);
      if (bad) {
        if (r.info && r.info.err) process.stdout.write(`      ERROR: ${r.info.err.split('\n')[0]}\n`);
        for (const e of errs.slice(0, 3)) process.stdout.write(`      console: ${e.slice(0, 200)}\n`);
      }
    }
  } finally {
    if (browser) await browser.close();
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  const server = await startServer(5273);
  console.log(`server: ${server.url}${server.reused ? ' (reused)' : ''}`);
  try {
    const all = await listShots(server.url, args);
    const shots = args.shots ? args.shots.filter(s => all.includes(s)) : all;
    if (args.shots) {
      const missing = args.shots.filter(s => !all.includes(s));
      if (missing.length) console.log('warning: unknown shots ignored: ' + missing.join(','));
    }
    console.log(`shots: ${shots.length} @ ${args.w}x${args.h} seed=${args.seed}`);

    const outDir = path.join(ROOT, args.out);
    console.log('run 1:');
    const r1 = await runOnce(server.url, shots, args, outDir);

    let determinism = null;
    if (args.verify) {
      const outDir2 = path.join(ROOT, args.out + '__verify');
      rimraf(outDir2);
      console.log('run 2 (fresh browser processes, fresh contexts):');
      const r2 = await runOnce(server.url, shots, args, outDir2);
      const diffs = [];
      for (let i = 0; i < r1.length; i++) {
        if (r1[i].hash !== r2[i].hash) diffs.push({ shot: r1[i].shot, a: r1[i].hash, b: r2[i].hash });
      }
      determinism = { identical: diffs.length === 0, compared: r1.length, diffs };
      console.log(diffs.length === 0
        ? `\nDETERMINISM: PASS — ${r1.length}/${r1.length} shots bit-identical across two runs`
        : `\nDETERMINISM: FAIL — ${diffs.length}/${r1.length} shots differ:\n` + diffs.map(d => '  ' + d.shot).join('\n'));
      if (diffs.length === 0) rimraf(outDir2);
    }

    // Merge with any existing manifest so a partial run (--shots a,b) does not erase the
    // evidence for every other shot. A manifest that silently loses shots turns the gate
    // readout into a lie.
    const mpathPrev = path.join(ROOT, args.out, 'manifest.json');
    let merged = r1;
    let prevDeterminism = null;
    if (args.shots && fs.existsSync(mpathPrev)) {
      try {
        const prev = JSON.parse(fs.readFileSync(mpathPrev, 'utf8'));
        if (prev.width === args.w && prev.height === args.h && String(prev.seed) === String(args.seed)) {
          prevDeterminism = prev.determinism || null;
          const byId = new Map((prev.shots || []).map(s => [s.shot, s]));
          for (const r of r1) byId.set(r.shot, r);
          merged = [...byId.values()].sort((a, b) => a.shot.localeCompare(b.shot));
        }
      } catch { /* a corrupt manifest is simply replaced */ }
    }

    const errCount = merged.filter(r => r.error || r.consoleErrors.length).length;
    const manifest = {
      generatedFrom: 'tools/capture/capture.mjs',
      seed: args.seed, width: args.w, height: args.h,
      rasteriser: 'ANGLE/SwiftShader (software, deterministic)',
      isolation: args.reuseBrowser ? 'fresh context+page per shot' : 'fresh browser process+context+page per shot',
      shots: merged,
      shotsWithErrors: errCount,
      determinism: determinism || prevDeterminism,
      partialRun: args.shots ? args.shots : null,
    };
    ensureDir(path.join(ROOT, 'evidence'));
    const mpath = path.join(ROOT, args.out, 'manifest.json');
    fs.writeFileSync(mpath, JSON.stringify(manifest, null, 2));
    console.log(`\nmanifest: ${path.relative(ROOT, mpath).replace(/\\/g, '/')}`);
    console.log(`shots with errors: ${errCount}`);
    if (errCount > 0) process.exitCode = 2;
    if (determinism && !determinism.identical) process.exitCode = 3;
  } finally {
    await server.stop();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
