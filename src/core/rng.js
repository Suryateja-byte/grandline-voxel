// Deterministic RNG. Math.random() is banned repo-wide (see tools/lint-determinism.mjs).
// All randomness flows from the world seed through named streams so that adding a new
// consumer never shifts an existing consumer's sequence.

/** 32-bit string hash (FNV-1a), used to derive stream seeds from names. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Integer mix (splitmix32). Deterministic, well-distributed. */
export function mix32(x) {
  x = (x + 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97) >>> 0;
  return (x ^ (x >>> 15)) >>> 0;
}

/** Hash 2 integers to a uint32. Order-independent of call history — pure. */
export function hash2(x, y, seed = 0) {
  let h = (seed ^ 0x27d4eb2d) >>> 0;
  h = mix32(h ^ Math.imul(x | 0, 0x85ebca6b));
  h = mix32(h ^ Math.imul(y | 0, 0xc2b2ae35));
  return h >>> 0;
}

/** Hash 3 integers to a uint32. */
export function hash3(x, y, z, seed = 0) {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = mix32(h ^ Math.imul(x | 0, 0x85ebca6b));
  h = mix32(h ^ Math.imul(y | 0, 0xc2b2ae35));
  h = mix32(h ^ Math.imul(z | 0, 0x27d4eb2d));
  return h >>> 0;
}

/** Uniform [0,1) from a uint32 hash. */
export function hashFloat(h) {
  return (h >>> 8) * (1 / 16777216);
}

/**
 * A stateful stream. Cheap, deterministic, and reproducible from (seed, name).
 * Use a distinct stream per subsystem so ordering between subsystems is irrelevant.
 */
export class Rng {
  constructor(seed) {
    this.s = (seed >>> 0) || 1;
    this._g = null;
  }

  static fromName(worldSeed, name) {
    return new Rng(mix32((worldSeed >>> 0) ^ hashString(name)));
  }

  /** Fork a child stream that will not disturb this one. */
  fork(name) {
    return new Rng(mix32(this.s ^ hashString(name)));
  }

  /** uint32 */
  u32() {
    this.s = (this.s + 0x9e3779b9) >>> 0;
    let x = this.s;
    x = Math.imul(x ^ (x >>> 16), 0x21f0aaad) >>> 0;
    x = Math.imul(x ^ (x >>> 15), 0x735a2d97) >>> 0;
    return (x ^ (x >>> 15)) >>> 0;
  }

  /** [0,1) */
  f() {
    return (this.u32() >>> 8) * (1 / 16777216);
  }

  /** [a,b) */
  range(a, b) {
    return a + (b - a) * this.f();
  }

  /** integer [a,b] inclusive */
  int(a, b) {
    return a + (this.u32() % (b - a + 1));
  }

  /** true with probability p */
  chance(p) {
    return this.f() < p;
  }

  /** [-1,1) */
  sym() {
    return this.f() * 2 - 1;
  }

  pick(arr) {
    return arr[this.u32() % arr.length];
  }

  /** In-place Fisher-Yates. Deterministic. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.u32() % (i + 1);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /** Standard normal via Box-Muller, cached pair. */
  normal() {
    if (this._g !== null) {
      const g = this._g;
      this._g = null;
      return g;
    }
    let u = 0, v = 0;
    while (u === 0) u = this.f();
    while (v === 0) v = this.f();
    const r = Math.sqrt(-2 * Math.log(u));
    const t = 2 * Math.PI * v;
    this._g = r * Math.sin(t);
    return r * Math.cos(t);
  }

  /** Random unit vector on a circle (XZ). */
  dir2() {
    const a = this.f() * Math.PI * 2;
    return [Math.cos(a), Math.sin(a)];
  }
}

/** Parse a user-facing seed (number or text) into a uint32. */
export function parseSeed(v) {
  if (v === undefined || v === null || v === '') return 20260814;
  const n = Number(v);
  if (Number.isFinite(n)) return (n >>> 0) || 1;
  return hashString(String(v)) || 1;
}
