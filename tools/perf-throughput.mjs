// Throughput measurement: render as fast as the browser will let us, no RAF, no fence.
// Wall time / frames is a real number the GPU cannot fake, and it detects regressions.
import { launch, startServer } from './lib.mjs';
const server = await startServer(5273);
const b = await launch({ gpu: true });
for (const res of [1.0, 0.5, 0.25]) {
  const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  await page.goto(`${server.url}/harness.html?shot=ocean-noon&seed=20260814&w=1920&h=1080&res=${res}`,
    { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__SHOT_READY === true', { timeout: 120000 });
  const r = await page.evaluate(async (n) => {
    const app = window.__H.app;
    const gl = app.renderer.gl.getContext();
    for (let i = 0; i < 30; i++) { app.render(0); }          // warm
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // drain the queue
    const t0 = performance.now();
    for (let i = 0; i < n; i++) app.render(0);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // blocks until all N complete
    const total = performance.now() - t0;
    return { total, perFrame: total / n,
             size: [app.renderer.width, app.renderer.height],
             draws: app.renderer.stats.drawCalls };
  }, 200);
  console.log(`  res=${res.toFixed(2)}  buffer=${r.size[0]}x${r.size[1]}  ${r.perFrame.toFixed(2)} ms/frame  (${(1000 / r.perFrame).toFixed(0)} fps equiv)  draws=${r.draws}`);
  await ctx.close();
}
await b.close(); await server.stop();
