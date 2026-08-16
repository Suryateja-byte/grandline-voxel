// Play-mode entry.
import { App, MODE } from './app.js';
import { buildGameSystems } from './game.js';
import { profiler } from './core/profiler.js';

const q = new URLSearchParams(location.search);
const canvas = document.getElementById('game');
const bootEl = document.getElementById('boot');
const bootBar = document.getElementById('bootBar');
const bootText = document.getElementById('bootText');

function dpr() { return 1; }

const app = new App(canvas, {
  mode: MODE.PLAY,
  seed: q.get('seed') || '20260814',
  width: Math.floor(window.innerWidth * dpr()),
  height: Math.floor(window.innerHeight * dpr()),
  // Adaptive quality holds 60fps on weak iGPUs; ?drs=0 pins native resolution.
  dynamicRes: q.get('drs') !== '0',
  temporalShadows: q.get('drs') !== '0',
  onSystems: buildGameSystems,
});
window.__APP = app;

let lastReal = 0;
function frame(now) {
  requestAnimationFrame(frame);
  profiler.begin();
  const dtMs = lastReal ? now - lastReal : 1000 / 60;
  const dt = Math.min(0.25, dtMs / 1000);
  lastReal = now;
  const steps = app.clock.advance(dt);
  for (let i = 0; i < steps; i++) app.step(1 / 60);
  app.render(app.clock.alpha);
  // RAF-to-RAF duration is the honest frame cost (includes GPU wait under vsync).
  app.renderer.updateDynamicRes(dtMs);
  profiler.end();
}

(async () => {
  bootBar.style.width = '25%';
  await app.boot();
  bootBar.style.width = '100%';
  bootText.textContent = 'set sail';
  canvas.width = Math.floor(window.innerWidth);
  canvas.height = Math.floor(window.innerHeight);
  app.resize(window.innerWidth, window.innerHeight);
  if (app.ui && app.ui.resize) app.ui.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', () => {
    app.resize(window.innerWidth, window.innerHeight);
    // The 2D UI overlay has its own canvas; without this it stays at boot size and the
    // HUD drifts off-screen the first time the window changes.
    if (app.ui && app.ui.resize) app.ui.resize(window.innerWidth, window.innerHeight);
  });
  setTimeout(() => { bootEl.style.display = 'none'; }, 60);
  profiler.enabled = true;
  profiler.reset();
  requestAnimationFrame(frame);
})().catch((e) => {
  bootText.textContent = 'boot failed: ' + e.message;
  console.error(e);
});
