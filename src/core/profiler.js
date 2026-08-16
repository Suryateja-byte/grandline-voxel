// Frame-time profiler with per-hitch attribution.
//
// Reports p50 / p95 / p99 and the worst frames with a named cause. Never reports an average —
// averages hide exactly the stalls that make a game feel bad.

import { percentile } from './math.js';

/** Zones are the named phases of a frame. Attribution assigns a hitch to its heaviest zone. */
export const ZONES = [
  'input', 'sim', 'ai', 'combat', 'physics', 'stream', 'mesh', 'anim',
  'fx', 'ui', 'cull', 'shadow', 'draw', 'present', 'gc?',
];

export class Profiler {
  constructor(capacity = 20000) {
    this.enabled = false;
    this.capacity = capacity;
    this.frames = new Float32Array(capacity);
    this.frameCount = 0;
    this.head = 0;
    this.zoneTotals = Object.create(null);
    this.zoneStack = [];
    this._zoneStart = Object.create(null);
    this._frameZones = Object.create(null);
    this.hitches = [];
    this.hitchThreshold = 33.0; // ms — anything above this is a p99-class stall
    this.frameStart = 0;
    this.lastFrameMs = 0;
    this.marks = [];           // named one-off events (chunk build, shader compile, ...)
    this.shaderCompiles = 0;
    this.shaderCompileMs = 0;
    this.startedAt = 0;
    this.memSamples = [];
    this._frameIdx = 0;
    for (const z of ZONES) this.zoneTotals[z] = 0;
  }

  reset() {
    this.frameCount = 0;
    this.head = 0;
    this.hitches.length = 0;
    this.marks.length = 0;
    this.memSamples.length = 0;
    this.shaderCompiles = 0;
    this.shaderCompileMs = 0;
    this._frameIdx = 0;
    for (const z of ZONES) this.zoneTotals[z] = 0;
    this.startedAt = performance.now();
  }

  begin() {
    if (!this.enabled) return;
    this.frameStart = performance.now();
    this._frameZones = Object.create(null);
  }

  /** Open a named zone. Nesting is allowed; time is attributed to the innermost open zone. */
  zone(name) {
    if (!this.enabled) return;
    this.zoneStack.push([name, performance.now()]);
  }

  endZone() {
    if (!this.enabled || !this.zoneStack.length) return;
    const [name, t0] = this.zoneStack.pop();
    const ms = performance.now() - t0;
    this._frameZones[name] = (this._frameZones[name] || 0) + ms;
    this.zoneTotals[name] = (this.zoneTotals[name] || 0) + ms;
  }

  /** Convenience: time a synchronous function inside a zone. */
  measure(name, fn) {
    if (!this.enabled) return fn();
    this.zone(name);
    try { return fn(); } finally { this.endZone(); }
  }

  /** One-off named event, e.g. 'chunk-mesh', 'shader-compile'. Shows up in hitch attribution. */
  mark(name, ms, detail) {
    if (!this.enabled) return;
    this.marks.push({ frame: this._frameIdx, name, ms, detail: detail || '' });
    this._frameZones[name] = (this._frameZones[name] || 0) + ms;
    if (name === 'shader-compile') { this.shaderCompiles++; this.shaderCompileMs += ms; }
  }

  end() {
    if (!this.enabled) return;
    const ms = performance.now() - this.frameStart;
    this.lastFrameMs = ms;
    this.frames[this.head] = ms;
    this.head = (this.head + 1) % this.capacity;
    if (this.frameCount < this.capacity) this.frameCount++;
    if (ms >= this.hitchThreshold) {
      // Attribute the hitch to the zone that consumed the most time this frame.
      let worst = 'unattributed', worstMs = 0, accounted = 0;
      for (const k in this._frameZones) {
        accounted += this._frameZones[k];
        if (this._frameZones[k] > worstMs) { worstMs = this._frameZones[k]; worst = k; }
      }
      const unaccounted = ms - accounted;
      // If most of the frame is outside our zones it is almost always GC or driver stall.
      if (unaccounted > worstMs && unaccounted > ms * 0.5) { worst = 'gc-or-driver'; worstMs = unaccounted; }
      this.hitches.push({
        frame: this._frameIdx,
        ms: +ms.toFixed(2),
        cause: worst,
        causeMs: +worstMs.toFixed(2),
        unaccountedMs: +unaccounted.toFixed(2),
        zones: Object.fromEntries(Object.entries(this._frameZones).map(([k, v]) => [k, +v.toFixed(2)])),
      });
      if (this.hitches.length > 400) this.hitches.shift();
    }
    this._frameIdx++;
    if ((this._frameIdx & 63) === 0 && performance.memory) {
      this.memSamples.push({
        frame: this._frameIdx,
        usedMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(2),
      });
    }
  }

  samples() {
    const out = new Array(this.frameCount);
    const start = this.frameCount < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.frameCount; i++) out[i] = this.frames[(start + i) % this.capacity];
    return out;
  }

  report() {
    const s = this.samples();
    const durationS = (performance.now() - this.startedAt) / 1000;
    const causes = Object.create(null);
    for (const h of this.hitches) causes[h.cause] = (causes[h.cause] || 0) + 1;
    const mem = this.memSamples;
    const memTrend = mem.length > 4
      ? { firstMB: mem[0].usedMB, lastMB: mem[mem.length - 1].usedMB, peakMB: Math.max(...mem.map(m => m.usedMB)), samples: mem.length }
      : null;
    return {
      frames: s.length,
      durationS: +durationS.toFixed(2),
      // Percentiles only. No averages, by design.
      p50: +percentile(s, 50).toFixed(3),
      p95: +percentile(s, 95).toFixed(3),
      p99: +percentile(s, 99).toFixed(3),
      p999: +percentile(s, 99.9).toFixed(3),
      worst: +Math.max(0, ...s).toFixed(3),
      framesOver16_7: s.filter(v => v > 16.7).length,
      framesOver33: s.filter(v => v > 33).length,
      shaderCompiles: this.shaderCompiles,
      shaderCompileMs: +this.shaderCompileMs.toFixed(2),
      hitchCauses: causes,
      worstHitches: this.hitches.slice().sort((a, b) => b.ms - a.ms).slice(0, 12),
      zoneTotalsMs: Object.fromEntries(
        Object.entries(this.zoneTotals).filter(([, v]) => v > 0).map(([k, v]) => [k, +v.toFixed(1)])
      ),
      memTrend,
    };
  }
}

export const profiler = new Profiler();
