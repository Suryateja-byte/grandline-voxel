// Capture-mode entry. Loaded ONLY by harness.html. No RAF loop: the harness drives frames.
import { App, MODE } from './app.js';
import { getShot, shotIds } from './shots.js';
import './shots-art.js';   // registers the art-direction shots
import { buildGameSystems } from './game.js';

const q = new URLSearchParams(location.search);
const shotId = q.get('shot') || 'ocean-noon';
const seed = q.get('seed') || '20260814';
const W = parseInt(q.get('w') || '1920', 10);
const H = parseInt(q.get('h') || '1080', 10);

const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message || e)));
window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + String(e.reason)));
const origError = console.error.bind(console);
console.error = (...a) => { errors.push(a.map(String).join(' ')); origError(...a); };

const canvas = document.getElementById('game');
canvas.width = W; canvas.height = H;
canvas.style.width = W + 'px';
canvas.style.height = H + 'px';

const app = new App(canvas, {
  mode: MODE.CAPTURE, seed, width: W, height: H,
  msaa: q.has('msaa') ? parseInt(q.get('msaa'), 10) : 0,
  resolutionScale: q.has('res') ? parseFloat(q.get('res')) : 1,
  onSystems: buildGameSystems,
});

window.__H = {
  app,
  errors,
  shots: shotIds(),
  ready: (async () => {
    await app.boot();
  })(),
  programKeys() {
    const ps = app.renderer.gl.info.programs || [];
    return ps.map(p => String(p.cacheKey || ''));
  },
  async runShot(id) {
    const shot = getShot(id || shotId);
    if (!shot) throw new Error('unknown shot: ' + id);
    window.__PROGRAMS_BEFORE = this.programKeys();
    await shot.setup(app);
    // Two renders: the first can trigger lazy GPU uploads, the second is the measured frame.
    app.render(0);
    app.render(0);
    window.__PROGRAMS_AFTER = this.programKeys();
    return {
      id: shot.id,
      drawCalls: app.renderer.stats.drawCalls,
      triangles: app.renderer.stats.triangles,
      newPrograms: app.renderer.newProgramsSincePrewarm(),
    };
  },
  stats() {
    return {
      bootMs: +app.bootMs.toFixed(1),
      prewarmMs: +app.stats.prewarmMs.toFixed(1),
      tiles: app.stats.tiles,
      drawCalls: app.renderer.stats.drawCalls,
      triangles: app.renderer.stats.triangles,
      programs: app.renderer.stats.programs,
      newProgramsSincePrewarm: app.renderer.newProgramsSincePrewarm(),
      errors: errors.slice(),
    };
  },
};

(async () => {
  try {
    await window.__H.ready;
    const info = await window.__H.runShot(shotId);
    window.__SHOT_INFO = info;
    window.__SHOT_READY = true;
  } catch (e) {
    errors.push('boot: ' + (e && e.stack ? e.stack : String(e)));
    window.__SHOT_ERROR = String(e && e.stack ? e.stack : e);
    window.__SHOT_READY = true;
  }
})();
