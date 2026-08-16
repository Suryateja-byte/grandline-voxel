// Ad-hoc probe: boot the harness page and interrogate the live scene.
import { launch, startServer } from './lib.mjs';

const server = await startServer(5273);
const b = await launch();
const ctx = await b.newContext({ viewport: { width: 960, height: 540 } });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto(`${server.url}/harness.html?shot=${process.argv[2] || 'ocean-noon'}&seed=20260814&w=960&h=540`, { waitUntil: 'load' });
await page.waitForFunction('window.__SHOT_READY === true', { timeout: 90000 });

const out = await page.evaluate(() => {
  const app = window.__H.app;
  const cam = app.camera;
  const d = new (cam.getWorldDirection(new (cam.position.constructor)()).constructor)();
  cam.getWorldDirection(d);
  const pitchDeg = Math.asin(Math.max(-1, Math.min(1, d.y))) * 180 / Math.PI;
  const water = app.water;
  const wm = water.mesh;
  const geo = wm.geometry;
  const pos = geo.getAttribute('position');
  // Sample a few ring radii
  const radii = [];
  for (const i of [0, 1, 200, 2000, 6000, pos.count - 1]) {
    if (i < pos.count) radii.push(+Math.hypot(pos.getX(i), pos.getZ(i)).toFixed(2));
  }
  return {
    camPos: cam.position.toArray().map(v => +v.toFixed(2)),
    camDir: d.toArray().map(v => +v.toFixed(4)),
    pitchDeg: +pitchDeg.toFixed(2),
    fov: cam.fov, aspect: +cam.aspect.toFixed(4), near: cam.near, far: cam.far,
    canvas: [app.canvas.width, app.canvas.height],
    drawingBuffer: [app.renderer.gl.domElement.width, app.renderer.gl.domElement.height],
    rtSize: [app.renderer.sceneTarget.width, app.renderer.sceneTarget.height],
    waterVerts: pos.count,
    radiiSample: radii,
    waterVisible: wm.visible,
    waterUCam: water.uniforms.uCameraPos.value.toArray().map(v => +v.toFixed(2)),
    waveScale: water.uniforms.uWaveScale.value,
    fogDensity: water.uniforms.uFogDensity.value,
    simTime: +app.clock.simTime.toFixed(2),
    dayT: app.dayT,
    sunDir: app.sky.env.sunDir.toArray().map(v => +v.toFixed(3)),
    heightAt0: +app.water.heightAt(0, 0).toFixed(3),
    sceneChildren: app.scene.children.map(c => c.name || c.type),
    projected: (() => {
      const THREE = window.__THREE;
      const out = {};
      const v = new (app.camera.position.constructor)();
      for (const [name, x, y, z] of [['near10', 7, 0, 7], ['at50', 35, 0, 35], ['at200', 141, 0, 141],
                                     ['at2000', 1414, 0, 1414], ['at5900', 4172, 0, 4172]]) {
        v.set(x, y, z).project(app.camera);
        out[name] = { ndcY: +v.y.toFixed(3), screenPct: +((1 - v.y) * 50).toFixed(1) };
      }
      return out;
    })(),
  };
});
console.log(JSON.stringify(out, null, 2));
await b.close();
await server.stop();
