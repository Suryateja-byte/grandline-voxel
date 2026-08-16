// Perf ablation using throughput measurement (the only method that survived validation:
// RAF is frame-capped in headless, and clientWaitSync has ~92ms of its own overhead).
// A readPixels after N renders blocks until the GPU has actually finished all of them.
import { launch, startServer } from './lib.mjs';

const VARIANTS = [
  { id: 'baseline (msaa4, fp16, bloom, shadow)', a: {} },
  { id: 'msaa=2', a: { msaa: 2 } },
  { id: 'msaa=0', a: { msaa: 0 } },
  { id: 'msaa=0 + rgba8 target', a: { msaa: 0, ldr: true } },
  { id: 'no ocean', a: { ocean: false } },
  { id: 'no sky', a: { sky: false } },
  { id: 'no bloom passes', a: { bloom: false } },
  { id: 'no shadow pass', a: { shadow: false } },
  { id: 'ocean: no detail-normal noise', a: { oceanSimple: 1 } },
  { id: 'ocean: no glitter+foam', a: { oceanSimple: 2 } },
  { id: 'ocean: flat colour only', a: { oceanSimple: 3 } },
];

const server = await startServer(5273);
const b = await launch({ gpu: true });
console.log('throughput ablation @1920x1080, 150 frames each, real GPU\n');
const out = [];
for (const v of VARIANTS) {
  const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  const q = v.a.msaa !== undefined ? `&msaa=${v.a.msaa}` : '';
  await page.goto(`${server.url}/harness.html?shot=ocean-noon&seed=20260814&w=1920&h=1080${q}`,
    { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__SHOT_READY === true', { timeout: 120000 });
  const r = await page.evaluate(async (a) => {
    const app = window.__H.app;
    const R = app.renderer;
    if (a.ldr) { R.ldrTarget = true; R.setSize(1920, 1080); }
    if (a.ocean === false) app.water.mesh.visible = false;
    if (a.sky === false) app.sky.mesh.visible = false;
    if (a.bloom === false) R.skipBloom = true;
    if (a.shadow === false) R.shadow.enabled = false;
    if (a.oceanSimple) {
      const m = app.water.material;
      let f = m.fragmentShader;
      if (a.oceanSimple >= 1) f = f.replace(/vec3 n = normalize\(vNormalW \+[^;]+;/, 'vec3 n = normalize(vNormalW);');
      if (a.oceanSimple >= 2) f = f.replace(/col \+= uSunColor \* glitter[^;]+;/, '')
                                   .replace(/col = mix\(col, foamCol[^;]+;/, '');
      if (a.oceanSimple >= 3) f = f.replace(/fragColor = vec4\(col, 1\.0\);/, 'fragColor = vec4(uDeepColor, 1.0);');
      m.fragmentShader = f;
      m.needsUpdate = true;
      app.render(0);
    }
    const gl = R.gl.getContext();
    const px = new Uint8Array(4);
    for (let i = 0; i < 25; i++) app.render(0);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const N = 150, t0 = performance.now();
    for (let i = 0; i < N; i++) app.render(0);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { perFrame: (performance.now() - t0) / N };
  }, v.a);
  out.push({ id: v.id, ms: r.perFrame, errs: errs.length });
  console.log(`  ${v.id.padEnd(40)} ${r.perFrame.toFixed(2)} ms${errs.length ? '   ERR ' + errs[0].slice(0, 50) : ''}`);
  await ctx.close();
}
await b.close(); await server.stop();
const base = out[0].ms;
console.log('\nsavings vs baseline:');
for (const r of out.slice(1)) {
  const d = base - r.ms;
  console.log(`  ${r.id.padEnd(40)} ${d >= 0 ? '-' : '+'}${Math.abs(d).toFixed(2)} ms  (${((d / base) * 100).toFixed(0)}%)`);
}
