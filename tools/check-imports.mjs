// Import every module under src/. Catches integration blockers (bad exports, top-level DOM
// access, circular imports) before they turn into a blank screen in the browser.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib.mjs';

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(path.join(ROOT, 'src')).sort();
let ok = 0;
const fails = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  // Entry points touch document/window at module scope by design; they run in the browser.
  if (rel.endsWith('-entry.js') || rel === 'src/main.js') {
    console.log(`  skip  ${rel}  (browser entry point)`);
    continue;
  }
  try {
    await import(pathToFileURL(f).href);
    ok++;
  } catch (e) {
    const msg = String((e && e.message) || e).split('\n')[0];
    fails.push({ rel, msg });
    console.log(`  FAIL  ${rel}\n        ${msg}`);
  }
}
console.log(`\n${ok} module(s) imported, ${fails.length} failed`);
if (fails.length) process.exit(1);
