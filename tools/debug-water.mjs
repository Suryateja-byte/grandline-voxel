import { launch, startServer } from './lib.mjs';

const server = await startServer(5273);
const b = await launch();
const ctx = await b.newContext({ viewport: { width: 480, height: 270 } });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300)); });
await page.goto(`${server.url}/harness.html?shot=ocean-noon&seed=20260814&w=480&h=270`, { waitUntil: 'load' });
await page.waitForFunction('window.__SHOT_READY === true', { timeout: 90000 });

const out = await page.evaluate(() => {
  const app = window.__H.app;
  const cv = app.canvas;
  const g = cv.getContext('webgl2');
  const read = () => {
    const px = new Uint8Array(4);
    const samples = {};
    for (const [name, fx, fy] of [['y02', 0.5, 0.02], ['y20', 0.5, 0.20], ['y40', 0.5, 0.40],
                                  ['y60', 0.5, 0.60], ['y68', 0.5, 0.68], ['y72', 0.5, 0.72],
                                  ['y85', 0.5, 0.85], ['y98', 0.5, 0.98]]) {
      // gl readPixels origin is bottom-left
      g.readPixels(Math.floor(cv.width * fx), Math.floor(cv.height * (1 - fy)), 1, 1, g.RGBA, g.UNSIGNED_BYTE, px);
      samples[name] = [px[0], px[1], px[2]];
    }
    return samples;
  };
  const res = {};
  res.normal = read();

  // 1) hide the sky: whatever remains is genuinely the water pass
  app.sky.mesh.visible = false;
  app.render(0);
  res.noSky = read();
  app.sky.mesh.visible = true;

  // 2) hide the water: whatever remains is genuinely the sky
  app.water.mesh.visible = false;
  app.render(0);
  res.noWater = read();
  app.water.mesh.visible = true;

  // 3) what is the water's own base colour uniform, in linear?
  const u = app.water.uniforms;
  res.uniforms = {
    deep: u.uDeepColor.value.toArray().map(v => +v.toFixed(3)),
    shallow: u.uShallowColor.value.toArray().map(v => +v.toFixed(3)),
    sunIntensity: u.uSunIntensity.value,
    fogDensity: u.uFogDensity.value,
    horizon: u.uHorizonColor.value.toArray().map(v => +v.toFixed(3)),
    sky: u.uSkyColor.value.toArray().map(v => +v.toFixed(3)),
    waveScale: u.uWaveScale.value,
  };
  // Where does the ocean geometry actually land on screen? Replicate the vertex shader in JS.
  {
    const geo = app.water.mesh.geometry;
    const pos = geo.getAttribute('position');
    const V = app.camera.position.constructor;
    const v = new V();
    let minY = 1e9, maxY = -1e9, minR = 1e9, maxR = -1e9, nAbove = 0, total = 0;
    const cam = app.camera;
    for (let i = 0; i < pos.count; i += 7) {
      const x = pos.getX(i), z = pos.getZ(i);
      const wy = app.water.heightAt(x + cam.position.x, z + cam.position.z);
      v.set(x + cam.position.x, wy, z + cam.position.z).project(cam);
      if (!isFinite(v.y)) continue;
      total++;
      minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
      const r = Math.hypot(x, z); minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      if (v.y > 0.38) nAbove++;   // horizon sits near ndcY = +0.38 for this shot
    }
    res.geom = { total, ndcYmin: +minY.toFixed(3), ndcYmax: +maxY.toFixed(3),
                 radiusMin: +minR.toFixed(1), radiusMax: +maxR.toFixed(1), verticesAboveHorizon: nAbove };
  }
  res.exposure = app.renderer.compositeMat.uniforms.uExposure.value;
  res.saturation = app.renderer.compositeMat.uniforms.uSaturation.value;
  res.bloom = app.renderer.compositeMat.uniforms.uBloomStrength.value;
  return res;
});

// Paint the ocean flat magenta and screenshot it: the only unambiguous way to see coverage.
await page.evaluate(async () => {
  const app = window.__H.app;
  const THREE = app.water.mesh.material.constructor;
  const m = new (Object.getPrototypeOf(app.water.mesh.material).constructor)({
    glslVersion: app.water.material.glslVersion,
    vertexShader: app.water.material.vertexShader,
    fragmentShader: app.water.material.fragmentShader.replace(
      /fragColor = vec4\(col, 1.0\);/, 'fragColor = vec4(clamp(vWorld.y * 0.25 + 0.5, 0.0, 1.0), clamp(viewDist / 3000.0, 0.0, 1.0), clamp(length(vWorld.xz) / 3000.0, 0.0, 1.0), 1.0);'),
    uniforms: app.water.material.uniforms,
    side: app.water.material.side,
  });
  app.water.mesh.material = m;
  app.render(0); app.render(0);
});
const fs = await import('node:fs');
const durl = await page.evaluate(() => document.getElementById('game').toDataURL('image/png'));
fs.writeFileSync('evidence/shots/_debug_water_coverage.png', Buffer.from(durl.slice(22), 'base64'));
console.log('wrote evidence/shots/_debug_water_coverage.png');

const fmt = (o) => Object.entries(o).map(([k, v]) => k + '=' + v.join(',')).join('  ');
console.log('normal :', fmt(out.normal));
console.log('noSky  :', fmt(out.noSky));
console.log('noWater:', fmt(out.noWater));
console.log('uniforms:', JSON.stringify(out.uniforms));
console.log('geom:', JSON.stringify(out.geom));
await b.close();
await server.stop();
