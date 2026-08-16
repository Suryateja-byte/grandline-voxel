// Deterministic noise. Pure functions of (coords, seed) — no internal state, so results are
// independent of evaluation order. Required for identical worlds from identical seeds.

import { hash2, hash3, mix32 } from '../core/rng.js';

const F = (h) => (h >>> 8) * (1 / 16777216);
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

/** Value noise in 2D, output [-1,1]. */
export function value2(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const a = F(hash2(xi, yi, seed));
  const b = F(hash2(xi + 1, yi, seed));
  const c = F(hash2(xi, yi + 1, seed));
  const d = F(hash2(xi + 1, yi + 1, seed));
  return (lerp(lerp(a, b, u), lerp(c, d, u), v) * 2 - 1);
}

/** Value noise in 3D, output [-1,1]. */
export function value3(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = fade(xf), v = fade(yf), w = fade(zf);
  const c000 = F(hash3(xi, yi, zi, seed));
  const c100 = F(hash3(xi + 1, yi, zi, seed));
  const c010 = F(hash3(xi, yi + 1, zi, seed));
  const c110 = F(hash3(xi + 1, yi + 1, zi, seed));
  const c001 = F(hash3(xi, yi, zi + 1, seed));
  const c101 = F(hash3(xi + 1, yi, zi + 1, seed));
  const c011 = F(hash3(xi, yi + 1, zi + 1, seed));
  const c111 = F(hash3(xi + 1, yi + 1, zi + 1, seed));
  const x00 = lerp(c000, c100, u), x10 = lerp(c010, c110, u);
  const x01 = lerp(c001, c101, u), x11 = lerp(c011, c111, u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 2 - 1;
}

/** Gradient (Perlin-style) noise in 2D, output roughly [-1,1]. Smoother than value noise. */
export function grad2(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const g = (ix, iy, dx, dy) => {
    const h = hash2(ix, iy, seed) & 7;
    const a = (h / 8) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const n00 = g(xi, yi, xf, yf);
  const n10 = g(xi + 1, yi, xf - 1, yf);
  const n01 = g(xi, yi + 1, xf, yf - 1);
  const n11 = g(xi + 1, yi + 1, xf - 1, yf - 1);
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 1.4;
}

/** Fractal Brownian motion over grad2. */
export function fbm2(x, y, seed, octaves = 4, lac = 2.0, gain = 0.5) {
  let a = 1, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += a * grad2(x * f, y * f, mix32(seed + i * 7919));
    norm += a;
    a *= gain; f *= lac;
  }
  return sum / norm;
}

/** Ridged multifractal — produces mountain ridges and island spines. */
export function ridge2(x, y, seed, octaves = 4, lac = 2.0, gain = 0.5) {
  let a = 1, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(grad2(x * f, y * f, mix32(seed + i * 6151)));
    sum += a * n * n;
    norm += a;
    a *= gain; f *= lac;
  }
  return (sum / norm) * 2 - 1;
}

/** Billowy (absolute) fBm — good for clouds and rolling hills. */
export function billow2(x, y, seed, octaves = 4) {
  let a = 1, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += a * Math.abs(grad2(x * f, y * f, mix32(seed + i * 4093)));
    norm += a; a *= 0.5; f *= 2;
  }
  return (sum / norm) * 2 - 1;
}

/** Domain-warped fBm. The cheapest way to make terrain stop looking procedural. */
export function warpedFbm2(x, y, seed, octaves = 4, warp = 1.4) {
  const qx = fbm2(x + 5.2, y + 1.3, mix32(seed ^ 0x1234), 2);
  const qy = fbm2(x + 9.7, y + 8.1, mix32(seed ^ 0x5678), 2);
  return fbm2(x + warp * qx, y + warp * qy, seed, octaves);
}

/**
 * Worley / cellular noise. Returns { f1, f2, id } where id is the deterministic
 * cell identifier — used for biome patches and island scattering.
 */
export function worley2(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 1e9, f2 = 1e9, id = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const h = hash2(cx, cy, seed);
      const px = cx + F(h);
      const py = cy + F(mix32(h));
      const d = Math.hypot(px - x, py - y);
      if (d < f1) { f2 = f1; f1 = d; id = h; }
      else if (d < f2) { f2 = d; }
    }
  }
  return { f1, f2, id };
}

/** Tileable value noise on a WxH grid — used for seamless textures. */
export function tileValue2(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const w = (i) => ((i % period) + period) % period;
  const a = F(hash2(w(xi), w(yi), seed));
  const b = F(hash2(w(xi + 1), w(yi), seed));
  const c = F(hash2(w(xi), w(yi + 1), seed));
  const d = F(hash2(w(xi + 1), w(yi + 1), seed));
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/** Tileable fBm for textures. Output [0,1]. */
export function tileFbm2(x, y, period, seed, octaves = 4) {
  let a = 1, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += a * tileValue2(x * f, y * f, period * f, mix32(seed + i * 2749));
    norm += a; a *= 0.5; f *= 2;
  }
  return sum / norm;
}
