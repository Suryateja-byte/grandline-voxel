// Game-mode perf ablation: the assembled game (profile.html, full systems), measured with the
// validated throughput method — render N frames, then ONE readPixels that blocks until the GPU
// has drained all of them. Amortised sync overhead ~0, so the number is the true GPU+submit
// cost per frame.
//
// Exists because the profiler's per-frame gpuSync readPixels carries a fixed ANGLE/D3D11
// drain overhead every frame. When all seven scenarios report the same p95 regardless of
// content, this tool answers two questions the profiler cannot:
//   1. methodology: throughput vs per-frame-synced on the SAME state — the gap is sync overhead
//   2. attribution: which feature owns the real GPU cost (shadow, bloom, water, sky, fp16)
//
// Usage: node tools/perf-game-ablation.mjs [--scenario sail-open-sea] [--frames 150]

import { launch, startServer } from './lib.mjs';

const scenario = process.argv.includes('--scenario')
  ? process.argv[process.argv.indexOf('--scenario') + 1] : 'sail-open-sea';
const N = process.argv.includes('--frames')
  ? parseInt(process.argv[process.argv.indexOf('--frames') + 1], 10) : 150;

const VARIANTS = [
  { id: 'baseline (throughput, all features)', a: {} },
  { id: 'per-frame readPixels backbuffer', a: { syncEvery: 'backbuffer' } },
  { id: 'per-frame readPixels 1x1 FBO', a: { syncEvery: 'fbo' } },
  { id: 'no shadow pass', a: { shadow: false } },
  { id: 'no bloom passes', a: { bloom: false } },
  { id: 'no ocean', a: { ocean: false } },
  { id: 'no sky', a: { sky: false } },
  { id: 'ocean: no detail-normal noise', a: { oceanSimple: 1 } },
  { id: 'ocean: no glitter+foam', a: { oceanSimple: 2 } },
  { id: 'rgba8 scene target (no fp16)', a: { ldr: true } },
  { id: 'resolutionScale 0.667 (diagnostic)', a: { res: 0.667 } },
];

const PROFILE_ARGS = ['--enable-precise-memory-info', '--js-flags=--expose-gc'];

const server = await startServer(5273);
console.log(`game ablation @1920x1080, scenario=${scenario}, ${N} frames per variant, real GPU\n`);
const out = [];
for (const v of VARIANTS) {
  const b = await launch({ gpu: true, extraArgs: PROFILE_ARGS });
  const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(`${server.url}/profile.html?scenario=${scenario}&seed=20260814&w=1920&h=1080`,
    { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__P && window.__PROFILE_READY === true', { timeout: 180000 });
  const r = await page.evaluate(async ({ a, N, scenario }) => {
    // Reach a representative in-scenario state, then hold it: 2 simulated seconds of play.
    await window.__P.run(scenario, 2);
    const app = window.__P.app;
    const R = app.renderer;
    if (a.shadow === false) R.shadow.enabled = false;
    if (a.bloom === false) R.skipBloom = true;
    if (a.ocean === false) app.water.mesh.visible = false;
    if (a.sky === false) app.sky.mesh.visible = false;
    // setSize early-returns when W/H are unchanged, so force a rebuild for target-format
    // changes by invalidating the cached size first.
    if (a.ldr) { R.ldrTarget = true; R.width = 0; R.setSize(1920, 1080); }
    if (a.res) { R.resolutionScale = a.res; R.width = 0; R.setSize(1920, 1080); }
    if (a.oceanSimple) {
      const m = app.water.material;
      let f = m.fragmentShader;
      if (a.oceanSimple >= 1) f = f.replace(/vec3 n = normalize\(vNormalW \+[^;]+;/, 'vec3 n = normalize(vNormalW);');
      if (a.oceanSimple >= 2) f = f.replace(/col \+= uSunColor \* glitter[^;]+;/, '')
                                   .replace(/col = mix\(col, foamCol[^;]+;/, '');
      m.fragmentShader = f;
      m.needsUpdate = true;
    }
    const gl = R.gl.getContext();
    const px = new Uint8Array(4);
    let fbo = null;
    if (a.syncEvery === 'fbo') {
      fbo = gl.createFramebuffer();
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    const sync = () => {
      if (a.syncEvery === 'fbo') {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } else {
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
    };
    // Warmup: fill caches, settle clocks.
    for (let i = 0; i < 25; i++) app.render(0);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const n = a.syncEvery ? Math.min(N, 60) : N;
    const t0 = performance.now();
    if (a.syncEvery) {
      for (let i = 0; i < n; i++) { app.render(0); sync(); }
    } else {
      for (let i = 0; i < n; i++) app.render(0);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    const perFrame = (performance.now() - t0) / n;
    return { perFrame, draws: R.stats.drawCalls, tris: R.stats.triangles };
  }, { a: v.a, N, scenario });
  out.push({ id: v.id, ms: r.perFrame, errs: errs.length });
  console.log(`  ${v.id.padEnd(42)} ${r.perFrame.toFixed(2)} ms  (${r.draws} draws, ${r.tris.toLocaleString()} tris)${errs.length ? '  ERR ' + errs[0].slice(0, 60) : ''}`);
  await ctx.close();
  await b.close();
}
await server.stop();
const base = out[0].ms;
console.log('\nvs baseline:');
for (const r of out.slice(1)) {
  const d = base - r.ms;
  console.log(`  ${r.id.padEnd(42)} ${d >= 0 ? '-' : '+'}${Math.abs(d).toFixed(2)} ms  (${((d / base) * 100).toFixed(0)}%)`);
}
