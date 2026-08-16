#!/usr/bin/env node
// End-to-end playtest gate.
//
// Drives the real game through a real browser with real input events and asserts on observable
// game state, from a cold boot to a save/reload round trip:
//
//   boot -> tutorial -> board ship -> sail to the first island -> dock -> walk ashore ->
//   enter combat -> win a fight -> use a devil fruit power -> accept a quest -> complete it ->
//   bounty increases -> save -> RELOAD THE PAGE -> state restored
//
// The reload is why this tool exists as a driver rather than a single page script: only the
// runner can navigate the page and then re-attach to a run in progress. The page persists its
// progress in sessionStorage across the reload; the runner just calls run() again.
//
// Steps whose systems are not built yet report "skipped: <system> not present" and the run
// continues. A skip is not a pass — the run status becomes `incomplete`, printed as SKIP — but
// it is not a failure either, because a system that does not exist cannot regress.
//
// Usage:
//   node tools/playtest/playtest.mjs [--seed 20260814] [--w 1280] [--h 720]
//                                    [--out evidence/reports/playtest.json]
//                                    [--max-minutes 25] [--headed] [--json]
//
// Exit: 0 pass or incomplete, 1 a step failed, 2 the page never became ready.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, startServer, ensureDir, ROOT } from '../lib.mjs';

function toPosix(p) { return p.split(path.sep).join('/'); }

function parseArgs(argv) {
  const a = {
    seed: '20260814', w: 1280, h: 720,
    out: 'evidence/reports/playtest.json',
    maxMinutes: 25, headed: false, json: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--seed') a.seed = argv[++i];
    else if (k === '--w') a.w = parseInt(argv[++i], 10);
    else if (k === '--h') a.h = parseInt(argv[++i], 10);
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--max-minutes') a.maxMinutes = parseFloat(argv[++i]);
    else if (k === '--headed') a.headed = true;
    else if (k === '--json') a.json = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else a.bad = k;
  }
  return a;
}

const USAGE = `usage: node tools/playtest/playtest.mjs [options]
  --seed <n>          world seed                (default 20260814)
  --w / --h <px>      viewport                  (default 1280x720)
  --out <file>        report path               (default evidence/reports/playtest.json)
  --max-minutes <f>   wall-clock budget for the whole script (default 25)
  --headed            show the browser
  --json              machine-readable output`;

const ICON = { pass: 'o', fail: 'X', skipped: '-', blocked: '.' };

function printReport(report) {
  console.log('');
  for (const s of report.steps) {
    const icon = ICON[s.status] || '?';
    const time = s.simSeconds ? `${s.simSeconds.toFixed(1)}s sim` : '';
    console.log(`  ${icon} ${s.id.padEnd(24)} ${s.status.padEnd(9)} ${time.padStart(10)}  ${s.desc}`);
    if (s.status === 'fail') console.log(`      ${s.note}`);
    else if (s.status === 'skipped') console.log(`      ${s.note}`);
  }
  console.log('');
  const counts = report.counts;
  console.log(`  ${counts.pass} passed, ${counts.fail} failed, ${counts.skipped} skipped ` +
    `of ${report.steps.length} step(s); ${report.simSeconds}s simulated in ${report.wallSeconds}s wall`);
  if (report.consoleErrors.length) {
    console.log(`  console errors (${report.consoleErrors.length}):`);
    for (const e of report.consoleErrors.slice(0, 6)) console.log(`    ${String(e).slice(0, 180)}`);
  }
  console.log(report.status === 'pass'
    ? 'PLAYTEST: PASS — the game can be finished with a keyboard and a mouse'
    : report.status === 'incomplete'
      ? `PLAYTEST: SKIP — ${counts.skipped} step(s) need systems that do not exist yet: ${report.skipped.join(', ')}`
      : `PLAYTEST: FAIL — ${report.failed.join(', ')}`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(USAGE); process.exit(0); }
  if (args.bad) { console.error(`playtest: unknown argument ${args.bad}\n\n${USAGE}`); process.exit(2); }

  const server = await startServer(5273);
  console.log(`server: ${server.url}${server.reused ? ' (reused)' : ''}`);
  // Real GPU: the playtest is meant to behave like a player's session, and a software
  // rasteriser changes frame pacing enough to change what the input script experiences.
  const browser = await launch({ gpu: true });
  const budgetMs = args.maxMinutes * 60000;
  const t0 = Date.now();

  const ctx = await browser.newContext({
    viewport: { width: args.w, height: args.h },
    deviceScaleFactor: 1,
    timezoneId: 'UTC',
    locale: 'en-US',
    bypassCSP: true,
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  let result = null;
  let reloads = 0;
  let fatal = null;

  try {
    const url = `${server.url}/playtest.html?seed=${args.seed}&w=${args.w}&h=${args.h}`;
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });

    // The script can hand control back at the reload boundary; loop until it is done.
    for (let leg = 0; leg < 4; leg++) {
      await page.waitForFunction('window.__T && window.__PLAYTEST_READY === true', { timeout: 180000 });
      const bootError = await page.evaluate(() => window.__PLAYTEST_ERROR || null);
      if (bootError) throw new Error('boot failed: ' + String(bootError).split('\n')[0]);

      const left = budgetMs - (Date.now() - t0);
      if (left <= 0) throw new Error(`wall-clock budget of ${args.maxMinutes} minute(s) exhausted`);

      process.stdout.write(leg === 0 ? '  running script ... ' : `  resuming after reload ... `);
      result = await page.evaluate(() => window.__T.run(), undefined, { timeout: left });
      process.stdout.write(`${result.status}\n`);

      if (!result.needsReload) break;
      reloads++;
      await page.reload({ waitUntil: 'load', timeout: 120000 });
    }
    if (result && result.needsReload) fatal = 'the script asked to reload more times than the runner allows';
  } catch (e) {
    fatal = String(e && e.message ? e.message : e);
  } finally {
    await ctx.close();
    await browser.close();
    await server.stop();
  }

  const steps = (result && result.steps) || [];
  const counts = {
    pass: steps.filter(s => s.status === 'pass').length,
    fail: steps.filter(s => s.status === 'fail').length,
    skipped: steps.filter(s => s.status === 'skipped').length,
  };
  const pageErrors = [...new Set([...((result && result.errors) || []), ...consoleErrors])];
  const status = fatal ? 'fail'
    : counts.fail ? 'fail'
      : counts.skipped ? 'incomplete' : 'pass';

  const report = {
    generatedFrom: 'tools/playtest/playtest.mjs',
    seed: args.seed, width: args.w, height: args.h,
    status,
    fatal,
    reloads,
    counts,
    steps,
    skipped: steps.filter(s => s.status === 'skipped').map(s => s.id),
    failed: steps.filter(s => s.status === 'fail').map(s => s.id),
    simSeconds: (result && result.simSeconds) || 0,
    wallSeconds: +((Date.now() - t0) / 1000).toFixed(1),
    consoleErrors: pageErrors,
    inputPolicy: 'real KeyboardEvent / MouseEvent / WheelEvent dispatched at the game canvas; '
      + 'no gameplay function is called directly',
  };

  const outFile = path.resolve(ROOT, args.out);
  ensureDir(path.dirname(outFile));
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  if (fatal) console.log(`  fatal: ${fatal}`);
  console.log(`report: ${toPosix(path.relative(ROOT, outFile))}`);

  process.exit(status === 'fail' ? 1 : 0);
}

// Only run when invoked directly — importing this module must not launch a browser.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
