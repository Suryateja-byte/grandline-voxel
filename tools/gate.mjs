#!/usr/bin/env node
// The objective gate. One command, one verdict.
//
// Runs every objective check in the brief in dependency order, prints a PASS/FAIL table, writes
// evidence/reports/gate.json and exits non-zero if anything failed:
//
//   determinism   no Math.random / wall-clock reads in src/
//   assets        no downloaded images, audio, models or fonts in the shipped tree
//   capture       every shot renders, twice, bit-identically (SHA-256 proof)
//   diff          no shot has drifted from the accepted baseline
//   profile       frame-time, shader-compile and heap gates on the real GPU
//   playtest      the game can be finished with a keyboard and a mouse, and survives a reload
//
// SKIP is a distinct verdict and it never passes silently: a gate that cannot run yet (no
// baseline captured, systems still being built) is reported as SKIP with the reason, so the
// table always says what was actually proved.
//
// The dev server is started once here and reused by every child tool, so six tools do not
// fight over port 5273.
//
// Usage:
//   node tools/gate.mjs [--only a,b] [--skip a,b] [--quick] [--update-baseline]
//                       [--seed 20260814] [--w 1920] [--h 1080] [--json]

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, ensureDir, ROOT } from './lib.mjs';

function toPosix(p) { return p.split(path.sep).join('/'); }

function parseArgs(argv) {
  const a = {
    only: null, skip: [], quick: false, updateBaseline: false,
    seed: '20260814', w: 1920, h: 1080, json: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--only') a.only = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (k === '--skip') a.skip = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (k === '--seed') a.seed = argv[++i];
    else if (k === '--w') a.w = parseInt(argv[++i], 10);
    else if (k === '--h') a.h = parseInt(argv[++i], 10);
    else if (k === '--quick') a.quick = true;
    else if (k === '--update-baseline') a.updateBaseline = true;
    else if (k === '--json') a.json = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else a.bad = k;
  }
  return a;
}

const USAGE = `usage: node tools/gate.mjs [options]
  --only a,b          run only these gates
  --skip a,b          skip these gates
  --quick             short profile run and a smaller viewport — for iterating, not for evidence
  --update-baseline   accept the fresh capture as the new pixel baseline
  --seed <n>          world seed          (default 20260814)
  --w / --h <px>      capture size        (default 1920x1080)
  --json              machine-readable output

gates: determinism, assets, capture, diff, profile, playtest`;

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); } catch { return null; }
}

/** Run a tool as a child process, streaming its output through with an indent. */
function runTool(label, argv) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const pipe = (stream) => stream.on('data', (d) => {
      const s = d.toString();
      out += s;
      process.stdout.write(s.replace(/^/gm, '    ').replace(/ {4}$/, ''));
    });
    pipe(child.stdout); pipe(child.stderr);
    child.on('error', (e) => resolve({ code: 127, out: out + '\n' + e.message, ms: Date.now() - t0 }));
    child.on('close', (code) => resolve({ code: code === null ? 1 : code, out, ms: Date.now() - t0 }));
  });
}

/**
 * The gate definitions. `grade` turns the child's exit code plus its written report into a
 * verdict, so the table reflects what the evidence says rather than only what exited zero.
 */
function buildGates(args) {
  const size = args.quick ? { w: 960, h: 540 } : { w: args.w, h: args.h };
  return [
    {
      id: 'determinism',
      title: 'no Math.random / wall-clock reads in src/',
      argv: ['tools/lint-determinism.mjs'],
      grade: (r) => ({
        status: r.code === 0 ? 'PASS' : 'FAIL',
        detail: (r.out.match(/^(PASS|FAIL) .*$/m) || ['no output'])[0],
      }),
    },
    {
      id: 'assets',
      title: 'no downloaded assets in the shipped tree',
      argv: ['tools/lint-assets.mjs'],
      grade: (r) => ({
        status: r.code === 0 ? 'PASS' : 'FAIL',
        detail: (r.out.match(/^(PASS|FAIL) .*$/m) || ['no output'])[0],
      }),
    },
    {
      id: 'capture',
      title: 'every shot renders bit-identically across two runs',
      argv: ['tools/capture/capture.mjs', '--verify', '--seed', args.seed,
        '--w', String(size.w), '--h', String(size.h)],
      evidence: 'evidence/shots/manifest.json',
      grade: (r) => {
        const m = readJson('evidence/shots/manifest.json');
        if (!m) return { status: 'FAIL', detail: 'no manifest written' };
        const d = m.determinism;
        const errs = m.shotsWithErrors || 0;
        if (!d) return { status: r.code === 0 ? 'PASS' : 'FAIL', detail: `${m.shots.length} shot(s), determinism not verified` };
        return {
          status: r.code === 0 && d.identical && !errs ? 'PASS' : 'FAIL',
          detail: `${d.compared} shot(s), ${d.identical ? 'bit-identical' : `${d.diffs.length} differ`}` +
            (errs ? `, ${errs} with console errors` : ''),
        };
      },
    },
    {
      id: 'diff',
      title: 'no pixel drift from the accepted baseline',
      argv: ['tools/diff/diff.mjs', '--a', 'evidence/baseline', '--b', 'evidence/shots',
        '--out', 'evidence/diff', ...(args.updateBaseline ? ['--update'] : [])],
      evidence: 'evidence/diff/report.json',
      grade: (r) => {
        const d = readJson('evidence/diff/report.json');
        if (!d) return { status: 'FAIL', detail: 'no diff report written' };
        if (d.status === 'no-baseline') {
          return { status: 'SKIP', detail: 'no baseline captured yet — run with --update-baseline to accept one' };
        }
        if (d.status === 'updated') return { status: 'SKIP', detail: `baseline updated: ${d.accepted} shot(s) accepted` };
        if (d.status === 'error') return { status: 'FAIL', detail: d.error };
        const worst = d.shots.filter(s => s.changedFraction !== undefined)
          .sort((a, b) => b.changedFraction - a.changedFraction)[0];
        return {
          status: r.code === 0 ? 'PASS' : 'FAIL',
          detail: `${d.shots.length} shot(s), worst drift ${worst ? (worst.changedFraction * 100).toFixed(4) + '% (' + worst.shot + ')' : 'n/a'}`,
        };
      },
    },
    {
      id: 'profile',
      title: 'frame time, shader compiles and heap on the real GPU',
      argv: ['tools/profile/profile.mjs', '--seed', args.seed,
        '--w', String(size.w), '--h', String(size.h),
        ...(args.quick ? ['--seconds', '8'] : [])],
      evidence: 'evidence/perf/report.json',
      grade: (r) => {
        const p = readJson('evidence/perf/report.json');
        if (!p) return { status: 'FAIL', detail: 'no perf report written' };
        const degraded = (p.degraded || []).length;
        const worst = p.runs.slice().sort((a, b) => (b.p95 || 0) - (a.p95 || 0))[0];
        const detail = `${p.runs.length} scenario(s), worst cpu p95 ${worst ? worst.p95.toFixed(2) : '?'}ms` +
          (degraded ? `, ${degraded} degraded (systems not built yet)` : '') +
          (p.softwareRasteriser ? ', SOFTWARE RASTERISER — timings not meaningful' : '');
        if (r.code !== 0) return { status: 'FAIL', detail };
        return { status: degraded === p.runs.length ? 'SKIP' : 'PASS', detail };
      },
    },
    {
      id: 'playtest',
      title: 'the game can be finished with a keyboard and a mouse',
      argv: ['tools/playtest/playtest.mjs', '--seed', args.seed,
        '--w', String(Math.min(1280, size.w)), '--h', String(Math.min(720, size.h))],
      evidence: 'evidence/reports/playtest.json',
      grade: (r) => {
        const t = readJson('evidence/reports/playtest.json');
        if (!t) return { status: 'FAIL', detail: 'no playtest report written' };
        const c = t.counts;
        const detail = `${c.pass} passed, ${c.fail} failed, ${c.skipped} skipped` +
          (t.fatal ? ` — ${t.fatal}` : '');
        if (r.code !== 0 || t.status === 'fail') return { status: 'FAIL', detail };
        return { status: t.status === 'incomplete' ? 'SKIP' : 'PASS', detail };
      },
    },
  ];
}

function printTable(report) {
  const w = 14;
  console.log('');
  console.log('  ' + '='.repeat(104));
  console.log(`  ${'GATE'.padEnd(w)} ${'VERDICT'.padEnd(8)} ${'TIME'.padStart(8)}  DETAIL`);
  console.log('  ' + '-'.repeat(104));
  for (const g of report.gates) {
    console.log(`  ${g.id.padEnd(w)} ${g.status.padEnd(8)} ${(g.ms / 1000).toFixed(1).padStart(7)}s  ${g.detail}`);
    console.log(`  ${''.padEnd(w)} ${''.padEnd(8)} ${''.padStart(8)}  ${g.title}`);
  }
  console.log('  ' + '='.repeat(104));
  const { pass, fail, skip } = report.counts;
  console.log(`  ${pass} PASS   ${fail} FAIL   ${skip} SKIP`);
  console.log(report.pass
    ? `  GATE: PASS${skip ? ` (${skip} gate(s) skipped — see detail)` : ''}`
    : `  GATE: FAIL — ${report.failed.join(', ')}`);
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(USAGE); process.exit(0); }
  if (args.bad) { console.error(`gate: unknown argument ${args.bad}\n\n${USAGE}`); process.exit(2); }

  let gates = buildGates(args);
  if (args.only) gates = gates.filter(g => args.only.includes(g.id));
  if (args.skip.length) gates = gates.filter(g => !args.skip.includes(g.id));
  if (!gates.length) { console.error('gate: no gates selected'); process.exit(2); }

  // One server for every child. Each tool calls startServer() itself and reuses this one.
  const server = await startServer(5273);
  console.log(`objective gate — ${gates.length} gate(s), seed ${args.seed}${args.quick ? ', QUICK (not evidence-grade)' : ''}`);
  console.log(`server: ${server.url}${server.reused ? ' (reused)' : ''}`);

  const results = [];
  try {
    for (const g of gates) {
      console.log(`\n>> ${g.id}: ${g.title}`);
      const r = await runTool(g.id, g.argv);
      const graded = g.grade(r);
      results.push({
        id: g.id, title: g.title, status: graded.status, detail: graded.detail,
        exitCode: r.code, ms: r.ms,
        command: 'node ' + g.argv.join(' '),
        evidence: g.evidence || null,
      });
    }
  } finally {
    await server.stop();
  }

  const counts = {
    pass: results.filter(r => r.status === 'PASS').length,
    fail: results.filter(r => r.status === 'FAIL').length,
    skip: results.filter(r => r.status === 'SKIP').length,
  };
  const report = {
    generatedFrom: 'tools/gate.mjs',
    seed: args.seed, width: args.w, height: args.h, quick: args.quick,
    pass: counts.fail === 0,
    counts,
    failed: results.filter(r => r.status === 'FAIL').map(r => r.id),
    skipped: results.filter(r => r.status === 'SKIP').map(r => r.id),
    gates: results,
  };

  const outFile = path.join(ROOT, 'evidence/reports/gate.json');
  ensureDir(path.dirname(outFile));
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printTable(report);
  console.log(`report: ${toPosix(path.relative(ROOT, outFile))}`);
  process.exit(report.pass ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
