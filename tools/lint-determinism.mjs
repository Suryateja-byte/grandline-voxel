#!/usr/bin/env node
// Determinism lint. ARCHITECTURE §1.2 and §1.3 are the rules; this file is their enforcement.
//
// Bans, anywhere under src/:
//   Math.random(      — all randomness must flow from src/core/rng.js (§1.2)
//   Date.now(         — wall-clock reads desynchronise simulation from capture (§1.3)
//   new Date(
//   performance.now(
//
// Allowed files are the ones that legitimately own real time: the profiler, the clock, and
// the entry points (which drive the RAF loop and therefore must read a timestamp once).
//
// Comments and string literals are blanked before scanning. A comment that *documents* the
// rule ("no Date.now() in gameplay code") is not a violation, and treating it as one teaches
// people to delete the documentation rather than the call.
//
// Usage: node tools/lint-determinism.mjs [--json] [--root src]
// Exit:  0 clean (waivers allowed), 1 violations found, 2 bad invocation.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKSLASH = String.fromCharCode(92);

/** Repo-relative, forward-slashed path. Avoids regex escaping of the Windows separator. */
function toPosix(p) { return p.split(path.sep).join('/'); }
function rel(p) { return toPosix(path.relative(ROOT, p)); }

/** Files permitted to read real time. Paths are repo-relative, forward-slashed. */
const ALLOW_EXACT = new Set([
  'src/core/profiler.js',
  'src/core/clock.js',
  'src/main.js',
]);
/** src/*-entry.js — the capture / profile / playtest entries own their own frame loops. */
const ALLOW_PATTERN = /^src\/[A-Za-z0-9._-]+-entry\.js$/;

/**
 * Acknowledged exceptions. Each is a real hit we have decided to accept, with a reason and a
 * route to removal. Waivers are printed, never hidden — an unlisted violation fails the build,
 * and a waiver matching nothing is reported STALE so the table cannot rot.
 */
const WAIVERS = [
  {
    file: 'src/app.js', rule: 'performance.now(',
    reason: 'boot instrumentation in App.boot(); runs once, before the first fixed step',
    removal: 'ARCHITECTURE §9 request: route boot timing through Profiler.mark()',
  },
  {
    file: 'src/render/renderer.js', rule: 'performance.now(',
    reason: 'Renderer.prewarm() shader-compile timing; runs once during boot, never during play',
    removal: 'ARCHITECTURE §9 request: route prewarm timing through Profiler.mark()',
  },
];

const RULES = [
  { name: 'Math.random(', re: /\bMath\s*\.\s*random\s*\(/g, why: 'use Rng from src/core/rng.js' },
  { name: 'Date.now(', re: /\bDate\s*\.\s*now\s*\(/g, why: 'use Clock.simTime' },
  { name: 'new Date(', re: /\bnew\s+Date\s*\(/g, why: 'no wall clock in simulation' },
  { name: 'performance.now(', re: /\bperformance\s*\.\s*now\s*\(/g, why: 'use Clock.simTime' },
];

/**
 * Blank out comments and string/template literals while preserving byte offsets, so line and
 * column numbers computed on the result still point at the real source.
 * @param {string} src
 * @returns {string} same length as src, with non-code regions replaced by spaces
 */
export function stripNonCode(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j); i = j; continue;
    }
    if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      blank(i, Math.min(n, j + 2)); i = j + 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === BACKSLASH) { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Recursively collect .js/.mjs files under dir. */
function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(js|mjs)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

function isAllowed(relPath) {
  return ALLOW_EXACT.has(relPath) || ALLOW_PATTERN.test(relPath);
}

/**
 * Scan a source tree for banned real-time / randomness calls.
 * @param {string} rootDir absolute directory to scan
 * @returns {{violations:object[], waived:object[], staleWaivers:object[], filesScanned:number}}
 */
export function lintDeterminism(rootDir) {
  const files = walk(rootDir);
  const violations = [];
  const waived = [];
  const usedWaivers = new Set();
  for (const abs of files) {
    const r = rel(abs);
    if (isAllowed(r)) continue;
    const raw = fs.readFileSync(abs, 'utf8');
    const code = stripNonCode(raw);
    const lines = raw.split(/\r?\n/);
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(code))) {
        const before = code.slice(0, m.index);
        const line = before.split('\n').length;
        const col = m.index - code.lastIndexOf('\n', m.index - 1);
        const w = WAIVERS.find(x => x.file === r && x.rule === rule.name);
        const hit = { file: r, line, col, rule: rule.name, why: rule.why, text: (lines[line - 1] || '').trim() };
        if (w) {
          usedWaivers.add(w.file + '|' + w.rule);
          waived.push({ ...hit, reason: w.reason, removal: w.removal });
        } else {
          violations.push(hit);
        }
      }
    }
  }
  const staleWaivers = WAIVERS.filter(w => !usedWaivers.has(w.file + '|' + w.rule));
  return { violations, waived, staleWaivers, filesScanned: files.length };
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const rootArg = argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : 'src';
  const dir = path.resolve(ROOT, rootArg);
  if (!fs.existsSync(dir)) {
    console.error(`lint-determinism: no such directory: ${rootArg}`);
    process.exit(2);
  }
  const res = lintDeterminism(dir);
  const ok = res.violations.length === 0;
  if (json) {
    console.log(JSON.stringify({ ok, ...res }, null, 2));
  } else {
    console.log(`lint-determinism: scanned ${res.filesScanned} file(s) under ${rootArg}/`);
    for (const w of res.waived) {
      console.log(`  WAIVED  ${w.file}:${w.line}:${w.col}  ${w.rule}  — ${w.reason}`);
    }
    for (const v of res.violations) {
      console.log(`  FAIL    ${v.file}:${v.line}:${v.col}  ${v.rule}  — ${v.why}`);
      console.log(`          ${v.text}`);
    }
    for (const s of res.staleWaivers) {
      console.log(`  STALE   waiver for ${s.file} (${s.rule}) matched nothing — delete it`);
    }
    console.log(ok
      ? `PASS — 0 violations, ${res.waived.length} waived`
      : `FAIL — ${res.violations.length} violation(s)`);
  }
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
