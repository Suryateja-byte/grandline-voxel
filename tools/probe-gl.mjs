import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';

export const CHROME = path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe');

const MODES = {
  swiftshader: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
  d3d11: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'],
};

if (import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  for (const name of Object.keys(MODES)) {
    const b = await chromium.launch({ executablePath: CHROME, headless: true, args: MODES[name] });
    const p = await b.newPage();
    const info = await p.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (!gl) return { ok: false };
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      const r = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      return {
        ok: true,
        renderer: r,
        maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        maxLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
        colorBufferFloat: !!gl.getExtension('EXT_color_buffer_float'),
        aniso: !!gl.getExtension('EXT_texture_filter_anisotropic'),
      };
    });
    console.log(name, JSON.stringify(info));
    await b.close();
  }
}
