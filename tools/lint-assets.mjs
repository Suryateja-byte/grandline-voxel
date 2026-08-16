#!/usr/bin/env node
// Asset lint. ARCHITECTURE §1.1: no downloaded assets, ever. Every texture, mesh, animation
// and sound is generated in code at load time.
//
// Fails if any binary asset file exists in the shipped tree. `evidence/` is exempt because it
// is *output* — the whole point of the capture harness is to write PNGs there — and
// `node_modules/` is exempt because it is not ours. Anything else under the repo root ships.
//
// A base64 data: URI is also an embedded asset, so the lint additionally rejects large ones in
// source. Small inline SVG favicons (index.html) are fine: they are markup, not a downloaded
// binary, and they cost nothing.
//
// Usage: node tools/lint-assets.mjs [--json] [--max-data-uri 512]
// Exit:  0 clean, 1 assets found.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Extensions that can only have arrived by download. Grouped so the report reads clearly. */
export const BANNED_EXT = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tga', 'ktx', 'ktx2', 'dds', 'exr', 'hdr'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'],
  model: ['glb', 'gltf', 'fbx', 'obj', 'dae', 'blend', 'ply', 'stl', 'vox'],
  font: ['ttf', 'otf', 'woff', 'woff2', 'eot'],
};
const EXT_KIND = new Map();
for (const [kind, list] of Object.entries(BANNED_EXT)) for (const e of list) EXT_KIND.set(e, kind);

/** Directories never scanned: generated evidence, dependencies, VCS internals. */
const SKIP_DIRS = new Set(['evidence', 'node_modules', '.git', '.vite', '.cache']);

/** Files scanned for embedded base64 payloads. */
const TEXT_EXT = new Set(['js', 'mjs', 'html', 'css', 'json', 'md']);

function toPosix(p) { return p.split(path.sep).join('/'); }
function rel(p) { return toPosix(path.relative(ROOT, p)); }
function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), acc);
    } else {
      acc.push(path.join(dir, e.name));
    }
  }
  return acc;
}

/**
 * Scan the shipped tree for binary assets and oversized embedded data URIs.
 * @param {string} rootDir absolute directory to scan
 * @param {number} maxDataUri largest base64 data: URI (in characters) allowed in a source file
 * @returns {{assets:object[], dataUris:object[], filesScanned:number}}
 */
export function lintAssets(rootDir, maxDataUri = 512) {
  const files = walk(rootDir);
  const assets = [];
  const dataUris = [];
  for (const abs of files) {
    const ext = extOf(abs);
    const kind = EXT_KIND.get(ext);
    if (kind) {
      assets.push({ file: rel(abs), ext, kind, bytes: fs.statSync(abs).size });
      continue;
    }
    if (!TEXT_EXT.has(ext)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    const re = /data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/gi;
    let m;
    while ((m = re.exec(src))) {
      if (m[2].length <= maxDataUri) continue;
      const line = src.slice(0, m.index).split('\n').length;
      dataUris.push({ file: rel(abs), line, mime: m[1], base64Chars: m[2].length });
    }
  }
  return { assets, dataUris, filesScanned: files.length };
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const maxDataUri = argv.includes('--max-data-uri')
    ? parseInt(argv[argv.indexOf('--max-data-uri') + 1], 10) : 512;
  const res = lintAssets(ROOT, maxDataUri);
  const ok = res.assets.length === 0 && res.dataUris.length === 0;
  if (json) {
    console.log(JSON.stringify({ ok, maxDataUri, skipped: [...SKIP_DIRS], ...res }, null, 2));
  } else {
    console.log(`lint-assets: scanned ${res.filesScanned} file(s); skipped ${[...SKIP_DIRS].join(', ')}`);
    for (const a of res.assets) {
      console.log(`  FAIL  ${a.file}  (${a.kind} asset, .${a.ext}, ${a.bytes} bytes) — generate it in code instead`);
    }
    for (const d of res.dataUris) {
      console.log(`  FAIL  ${d.file}:${d.line}  embedded ${d.mime} data: URI, ${d.base64Chars} base64 chars — an asset is an asset`);
    }
    console.log(ok ? 'PASS — no downloaded assets in the shipped tree' : `FAIL — ${res.assets.length + res.dataUris.length} asset(s)`);
  }
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
