export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
  return t * t * (3 - 2 * t);
};
export const smootherstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/** Framerate-independent exponential approach. rate = fraction remaining after 1s. */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.pow(rate, dt));

/** Shortest signed angular difference b - a, in (-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function dampAngle(a, b, rate, dt) {
  return a + angleDelta(a, b) * (1 - Math.pow(rate, dt));
}

export const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
export const distSq2 = (ax, az, bx, bz) => {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
};

/** Easing curves used by animation + FX. All map [0,1] -> [0,1]. */
export const ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outQuart: (t) => 1 - Math.pow(1 - t, 4),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inExpo: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  outBack: (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
  outElastic: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -9 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  outBounce: (t) => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
  /** rises fast, holds, falls — for punch/impact scale pops */
  pop: (t) => Math.sin(Math.PI * Math.pow(t, 0.6)),
};

/** Deterministic low-discrepancy sequence, used for particle spread. */
export function halton(i, base) {
  let f = 1, r = 0, n = i + 1;
  while (n > 0) {
    f /= base;
    r += f * (n % base);
    n = Math.floor(n / base);
  }
  return r;
}

/** Sorted percentile from an unsorted numeric array. p in [0,100]. */
export function percentile(arr, p) {
  if (!arr.length) return 0;
  const a = Float64Array.from(arr).sort();
  const idx = (p / 100) * (a.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

/** Axis-aligned box overlap test in 3D. */
export function aabbOverlap(ax, ay, az, ahx, ahy, ahz, bx, by, bz, bhx, bhy, bhz) {
  return Math.abs(ax - bx) <= ahx + bhx && Math.abs(ay - by) <= ahy + bhy && Math.abs(az - bz) <= ahz + bhz;
}

/** Is point p inside a 2D arc (cone) centred on dir, half-angle in radians? */
export function inArc(px, pz, ox, oz, dirX, dirZ, radius, halfAngle) {
  const dx = px - ox, dz = pz - oz;
  const d2 = dx * dx + dz * dz;
  if (d2 > radius * radius) return false;
  if (d2 < 1e-6) return true;
  const inv = 1 / Math.sqrt(d2);
  return dx * inv * dirX + dz * inv * dirZ >= Math.cos(halfAngle);
}

/** Format an integer with thousand separators (used for bounty). Locale-free. */
export function commify(n) {
  const s = Math.round(n).toString();
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return out;
}
