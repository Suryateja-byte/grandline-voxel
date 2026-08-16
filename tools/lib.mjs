// Shared tooling helpers: browser launch, dev server, hashing, paths.

import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Locate a Chromium. Prefers the Playwright build (fixed version = fixed rasterisation). */
export function findChrome() {
  const pw = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  if (fs.existsSync(pw)) {
    const dirs = fs.readdirSync(pw).filter(d => d.startsWith('chromium-')).sort();
    for (const d of dirs.reverse()) {
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(pw, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  for (const p of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ]) if (fs.existsSync(p)) return p;
  throw new Error('no chromium found');
}

/**
 * Deterministic rendering args. SwiftShader is a software rasteriser: identical output on any
 * machine, which is what makes "two capture runs are bit-identical" a meaningful claim rather
 * than an artefact of one GPU driver.
 */
export const DETERMINISTIC_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-gpu-sandbox',
  '--disable-lcd-text',
  '--disable-font-subpixel-positioning',
  '--force-color-profile=srgb',
  '--disable-partial-raster',
  '--disable-skia-runtime-opts',
  '--deterministic-mode',
  '--run-all-compositor-stages-before-draw',
  '--disable-new-content-rendering-timeout',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--hide-scrollbars',
  '--mute-audio',
  '--js-flags=--random-seed=1 --predictable',
];

/** Real-GPU args, used for profiling only — never for pixel evidence. */
export const GPU_ARGS = [
  '--use-gl=angle',
  '--use-angle=d3d11',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--enable-zero-copy',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-frame-rate-limit',
  // Without these the compositor caps every frame at the 60 Hz refresh and EVERY scenario
  // reports p95 ~16.6 ms regardless of how expensive it actually is. The gate would then be
  // measuring the monitor, not the game.
  '--disable-gpu-vsync',
  '--disable-features=CalculateNativeWinOcclusion',
  '--hide-scrollbars',
  '--mute-audio',
];

export async function launch({ gpu = false, extraArgs = [] } = {}) {
  return chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: [...(gpu ? GPU_ARGS : DETERMINISTIC_ARGS), ...extraArgs],
  });
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function rimraf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

async function portFree(port) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, '127.0.0.1');
  });
}

async function waitForPort(port, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const free = await portFree(port);
    if (!free) return true;
    await new Promise(r => setTimeout(r, 120));
  }
  throw new Error('server did not start on port ' + port);
}

/** Start the vite dev server if it is not already running. Returns { url, stop }. */
export async function startServer(port = 5273) {
  const free = await portFree(port);
  if (!free) return { url: `http://127.0.0.1:${port}`, stop: async () => {}, reused: true };
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev', '--', '--port', String(port), '--strictPort'],
    {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
      // No watcher, no HMR: a measurement server that hot-reloads navigates the page
      // mid-run and destroys the evidence (see vite.config.js).
      env: { ...process.env, GLV_NO_WATCH: '1' },
    });
  let log = '';
  child.stdout.on('data', d => { log += d.toString(); });
  child.stderr.on('data', d => { log += d.toString(); });
  try {
    await waitForPort(port);
  } catch (e) {
    child.kill();
    throw new Error(e.message + '\n' + log.slice(-2000));
  }
  return {
    url: `http://127.0.0.1:${port}`,
    reused: false,
    stop: async () => { try { child.kill(); } catch {} },
  };
}

export function fmt(n, d = 2) { return Number(n).toFixed(d); }
