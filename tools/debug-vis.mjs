// Visual isolation: render the ocean as a world-space checkerboard with no wave displacement.
// If the checker converges to a horizon line, the geometry and projection are correct.
import fs from 'node:fs';
import { launch, startServer } from './lib.mjs';

const server = await startServer(5273);
const b = await launch();
const ctx = await b.newContext({ viewport: { width: 480, height: 270 } });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 400)); });
await page.goto(`${server.url}/harness.html?shot=ocean-noon&seed=20260814&w=480&h=270`, { waitUntil: 'load' });
await page.waitForFunction('window.__SHOT_READY === true', { timeout: 90000 });

const shot = async (name) => {
  const d = await page.evaluate(() => document.getElementById('game').toDataURL('image/png'));
  fs.writeFileSync(`evidence/shots/_dbg_${name}.png`, Buffer.from(d.slice(22), 'base64'));
};

const info = await page.evaluate(() => {
  const app = window.__H.app;
  const src = app.water.material;
  const Ctor = src.constructor;
  const frag = `
precision highp float;
in vec3 vWorld;
in vec3 vNormalW;
in float vCrest;
in float vDist;
layout(location = 0) out vec4 fragColor;
uniform vec3 uCameraPos;
void main() {
  vec2 c = floor(vWorld.xz / 25.0);
  float k = mod(c.x + c.y, 2.0);
  float d = length(uCameraPos - vWorld);
  // red channel = checker, green = log distance, blue = 1 if the fragment is above the camera
  fragColor = vec4(k, clamp(log(max(d,1.0)) / 9.0, 0.0, 1.0), vWorld.y > uCameraPos.y ? 1.0 : 0.0, 1.0);
}`;
  const m = new Ctor({
    glslVersion: src.glslVersion,
    vertexShader: src.vertexShader,
    fragmentShader: frag,
    uniforms: src.uniforms,
    side: src.side,
  });
  app.water.mesh.material = m;
  app.water.uniforms.uWaveScale.value = 0.0;   // flat plane: no displacement to blame
  app.render(0); app.render(0);
  return { ok: true, side: src.side, glsl: String(src.glslVersion) };
});
console.log(JSON.stringify(info));
await shot('checker');

// Same geometry, stock three material, no custom vertex shader. If THIS renders as a disc
// below the horizon, the custom vertex shader is at fault; if it also fills the screen, the
// mesh/geometry setup is.
const basic = await page.evaluate(async () => {
  const app = window.__H.app;
  const mod = await import('/node_modules/three/build/three.module.js');
  const m = new mod.MeshBasicMaterial({ color: 0xff2200, side: mod.DoubleSide, wireframe: false });
  app.water.mesh.material = m;
  app.render(0); app.render(0);
  return { applied: true };
});
console.log('basic', JSON.stringify(basic));
await shot('basic');

// Hypothesis: the shadow pass leaves its cascade camera's matrices bound, so the main pass
// draws the world through an orthographic shadow camera.
const noshadow = await page.evaluate(() => {
  const app = window.__H.app;
  app.renderer.shadow.enabled = false;
  app.render(0); app.render(0);
  return { shadowDisabled: true };
});
console.log('noshadow', JSON.stringify(noshadow));
await shot('noshadow');

// Bypass the whole post chain: render the scene straight to the canvas.
const direct = await page.evaluate(async () => {
  const app = window.__H.app;
  const mod = await import('/node_modules/three/build/three.module.js');
  app.water.mesh.material = new mod.MeshBasicMaterial({ color: 0xff2200, side: mod.DoubleSide });
  const gl = app.renderer.gl;
  gl.setRenderTarget(null);
  gl.setClearColor(0x102030, 1);
  gl.clear(true, true, false);
  gl.render(app.scene, app.camera);
  return {
    viewport: gl.getViewport(new mod.Vector4()).toArray(),
    drawingBuffer: [gl.domElement.width, gl.domElement.height],
    camProj: app.camera.projectionMatrix.elements.slice(0, 6).map(v => +v.toFixed(4)),
    camMWI: app.camera.matrixWorldInverse.elements.slice(12, 15).map(v => +v.toFixed(3)),
  };
});
console.log('direct', JSON.stringify(direct));
await shot('direct');

console.log('wrote _dbg_checker.png and _dbg_skyonly.png');
await b.close();
await server.stop();
