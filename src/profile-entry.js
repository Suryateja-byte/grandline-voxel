// Profile-mode entry. Loaded ONLY by profile.html.
//
// This is the same App, the same buildGameSystems and the same fixed-step loop that play mode
// runs — a perf number measured against a different code path is worthless. What differs:
//   * the profiler is on
//   * input comes from src/scenarios.js as real DOM events instead of a human
//   * the run is a fixed number of simulated seconds, so two runs are comparable
//
// Real time is read here (RAF timestamps, heap sampling). That is why this file is on the
// determinism lint's allowlist: it is the boundary between the wall clock and the simulation.
//
// Nothing touches the DOM at import time — `start()` is called at the bottom only when a
// document exists — so the module can be import-checked under node.

import { App, MODE } from './app.js';
import { buildGameSystems } from './game.js';
import { profiler } from './core/profiler.js';
import { FIXED_DT } from './core/clock.js';
import { SCENARIOS, getScenario, scenarioIds, createInputApi, missingSystems } from './scenarios.js';

/** Heap in MB, or null when the browser was not started with --enable-precise-memory-info. */
function heapMB() {
  return performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;
}

/** Ask V8 to collect, when --js-flags=--expose-gc is set. Makes heap growth a real signal. */
function collect() {
  if (typeof window.gc === 'function') { try { window.gc(); } catch { /* not exposed */ } }
}

/**
 * Growth measured from a post-warmup baseline, not from frame zero: the first seconds of any
 * scenario legitimately allocate (chunks, meshes, pools), and counting that as a leak would
 * make the gate cry wolf on every run.
 * @param {number|null} startMB
 * @param {number|null} endMB
 * @param {{usedMB:number}[]} samples
 */
function heapGrowth(startMB, endMB, samples) {
  if (startMB === null || endMB === null) {
    return { available: false, startMB: null, baselineMB: null, endMB: null, growthPct: null };
  }
  let baseline = startMB;
  if (samples.length >= 4) {
    const warm = samples.slice(Math.floor(samples.length * 0.2));
    baseline = Math.min(...warm.map(s => s.usedMB));
  }
  return {
    available: true,
    startMB: +startMB.toFixed(2),
    baselineMB: +baseline.toFixed(2),
    endMB: +endMB.toFixed(2),
    growthPct: baseline > 0 ? +(((endMB - baseline) / baseline) * 100).toFixed(2) : 0,
  };
}

/**
 * Percentiles of a sample set. Same shape as the profiler's own numbers, and for the same
 * reason: an average frame time is the one statistic that cannot describe a stutter.
 * @param {number[]} xs
 */
function pctl(xs) {
  if (!xs.length) return { samples: 0, p50: 0, p95: 0, p99: 0, worst: 0, fps: 0 };
  const a = Float64Array.from(xs).sort();
  const at = (p) => a[Math.min(a.length - 1, Math.round((p / 100) * (a.length - 1)))];
  return {
    samples: a.length,
    p50: +at(50).toFixed(3),
    p95: +at(95).toFixed(3),
    p99: +at(99).toFixed(3),
    worst: +a[a.length - 1].toFixed(3),
    fps: +(1000 / at(50)).toFixed(1),
  };
}

function start() {
  const q = new URLSearchParams(location.search);
  const seed = q.get('seed') || '20260814';
  const W = parseInt(q.get('w') || '1920', 10);
  const H = parseInt(q.get('h') || '1080', 10);
  const defaultScenario = q.get('scenario') || 'sail-open-sea';

  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.message || e)));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + String(e.reason)));
  const origError = console.error.bind(console);
  console.error = (...a) => { errors.push(a.map(String).join(' ')); origError(...a); };

  const canvas = document.getElementById('game');
  canvas.width = W; canvas.height = H;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';

  const app = new App(canvas, {
    mode: MODE.PROFILE, seed, width: W, height: H,
    // Default must match play mode (app.js: msaa 0 → FXAA). Profiling MSAA 4x would gate a
    // configuration the game does not ship; pass ?msaa=4 explicitly to measure that instead.
    msaa: q.has('msaa') ? parseInt(q.get('msaa'), 10) : 0,
    // Adaptive quality, exactly as play mode ships it (?drs=0 pins native resolution).
    // The budget is stricter than play's vsync-aware default because this loop runs with
    // vsync off: frame gaps are true frame cost, and the gate is p95 < 16.7 ms.
    dynamicRes: q.get('drs') !== '0',
    temporalShadows: q.get('drs') !== '0',
    // Budget below the 16.7 gate and a step-up margin: the controller settles ~1ms under
    // budget instead of hunting across the capacity cliff (which is what fails a p95 gate).
    drsBudgetMs: 15.9,
    drsUpMarginMs: 2.5,
    onSystems: buildGameSystems,
  });

  const input = createInputApi(canvas, { pointerEvents: q.get('pointerEvents') === '1' });

  /**
   * GPU measurement on this stack, and why it is shaped this way.
   *
   * A frame's true cost is what a real swapchain would hold a player to: the pipelined
   * throughput of CPU and GPU overlapped. Three ways to observe it were tried on this
   * ANGLE/D3D11 iGPU and two are invalid:
   *   - fenceSync + clientWaitSync(0) polling: fences signal long before the driver executes
   *     the work (like gl.finish(), a no-op here) — frames read 3ms while a ~500ms driver
   *     backlog stalled the loop.
   *   - readPixels drain EVERY frame: the only working sync, but the drain serialises CPU and
   *     GPU and adds a fixed readback tax — a measurement floor of ~12ms/frame, LARGER than
   *     the 16.7ms budget being gated. Measured: loop said 18.6ms while true throughput of the
   *     same state was 6.8ms. A gate must measure the game, not the harness.
   *   - throughput batches: drain the queue (untimed), then time N renders + one drain.
   *     Amortised sync cost ~0; validated against the capture tools. This is the default.
   *
   * So the loop runs unsynced (giving true per-frame CPU percentiles and hitch attribution),
   * and every ~45 frames a batch samples the GPU's true per-frame cost of the current scene.
   * The gated percentiles are max(cpu, gpuBatch) per percentile — conservative composition of
   * two honestly-measured distributions. Batches also feed DRS: unsynced RAF gaps cannot see
   * GPU pressure (play mode gets that signal from vsync backpressure instead).
   * Known limit, disclosed: a single-frame GPU-only spike inside one batch is averaged over
   * its 15 frames. CPU-side spikes — where hitches actually originate — are per-frame.
   * ?gpuSync=read restores the drain-every-frame mode; ?gpuSync=0 disables GPU syncing.
   */
  const syncPixel = new Uint8Array(4);
  const syncMode = q.get('gpuSync') === '1' ? 'batch' : (q.get('gpuSync') || 'batch');
  const BATCH_N = 15;
  function gpuBatchSample() {
    try {
      const gl = app.renderer.gl.getContext();
      app.renderer.gl.setRenderTarget(null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncPixel);  // flush backlog, untimed
      const t0 = performance.now();
      for (let i = 0; i < BATCH_N; i++) app.render(0);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncPixel);
      return (performance.now() - t0) / BATCH_N;
    } catch { return null; /* context lost — the error handler already recorded it */ }
  }
  function gpuSync() {
    if (syncMode !== 'read') return;
    profiler.zone('present');
    try {
      app.renderer.gl.setRenderTarget(null);
      const gl = app.renderer.gl.getContext();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncPixel);
    } catch { /* context lost — the error handler already recorded it */ }
    profiler.endZone();
  }

  let running = false;
  let lastReport = null;

  /**
   * Run one scenario for `seconds` of simulated time and return its report.
   *
   * The loop is the play-mode loop: RAF drives Clock.advance, which decides how many fixed
   * steps to run. Scenario input is injected once per fixed step, so the script is identical
   * on a 30fps machine and a 300fps one.
   *
   * The first WARMUP_STEPS of simulation are driven but not measured. The first presented frame
   * after a teleport pays for texture uploads and the GPU pipeline filling up — a cost a player
   * pays behind the loading screen, once. It is reported separately as `warmup` rather than
   * hidden, but folding an 8-second boot stall into p99 would make the gate meaningless.
   *
   * @param {string} scenarioId
   * @param {number} [seconds] overrides the scenario's own length
   * @returns {Promise<object>} the profile report
   */
  async function run(scenarioId, seconds) {
    if (running) throw new Error('a scenario is already running');
    const scn = getScenario(scenarioId);
    if (!scn) throw new Error('unknown scenario: ' + scenarioId);
    running = true;

    // Warmup ends only once BOTH the simulation and the presentation pipeline have settled:
    // half a second of simulated play, and enough presented frames that the driver has stopped
    // paying first-use costs. The cap keeps a pathologically slow machine from warming up
    // forever and reporting zero measured frames.
    const WARMUP_STEPS = 30;
    const WARMUP_FRAMES = 45;
    const WARMUP_FRAME_CAP = 600;
    const missing = missingSystems(app, scn.requires);
    const measuredSteps = Math.round((seconds || scn.seconds) / FIXED_DT);

    input.releaseAll();
    app.clock.simTime = 0;
    app.clock.step = 0;
    app.timeFrozen = false;
    scn.setup(app);

    const programsAtStart = app.renderer.newProgramsSincePrewarm();
    let steps = 0;
    let measuredDone = 0;
    let lastReal = 0;
    let raf = 0;
    let seenPrograms = programsAtStart;
    let peakDraws = 0, peakTris = 0;
    let measuring = false;
    let heapStart = null;
    let warmupWorstMs = 0;
    let warmupFrames = 0;
    /** RAF-to-RAF gaps, informational in batch mode (unsynced gaps cannot see GPU wait). */
    const presentGaps = [];
    let lastPresent = 0;
    /** GPU throughput samples from mid-scenario batches — the gated GPU distribution. */
    const gpuSamples = [];
    let framesSinceBatch = 0;
    let warmClean = 0;      // consecutive settled warmup batches; measurement waits for 2
    let batchRan = false;
    let skipGap = false;
    let lastHeartbeat = 0;

    await new Promise((resolve) => {
      const frame = (now) => {
        // GPU batches run OUTSIDE the profiled section so their cost never lands in the frame
        // stats; the RAF gap containing a batch is excluded from presentGaps below.
        if (syncMode === 'batch') {
          framesSinceBatch++;
          // 45 frames, always — measured both ways on the 20-min soak. At 180 the driver
          // backlog between drains grows until it stalls the loop inside random gl calls
          // (~130ms spikes, cpu p95 24.4 vs 5.1 at 45), poisoning the CPU distribution, and
          // DRS reacts seconds late to thermal swings. Dense batching costs wall-clock time;
          // sparse batching costs the measurement itself.
          if (framesSinceBatch >= (measuring ? 45 : 20)) {
            framesSinceBatch = 0;
            const ms = gpuBatchSample();
            if (ms !== null) {
              if (measuring) gpuSamples.push(ms);
              else if (ms <= app.renderer._drs.budget
                || app.renderer.resolutionScale <= app.renderer._drs.min + 0.001) warmClean++;
              else warmClean = 0;
              // One batch = one full controller window: the sample IS the frame cost, so DRS
              // reacts to true GPU pressure the unsynced RAF gap cannot see.
              if (app.renderer.dynamicRes) {
                for (let k = 0; k < 30; k++) app.renderer.updateDynamicRes(ms);
              }
            }
            batchRan = true;
          }
        }
        // Warmup ends only after DRS has settled (2 consecutive in-budget batches, or the
        // floor): measuring while the scale is still stepping down would charge p95 for
        // frames the shipping adaptive quality would never present.
        const drsSettled = syncMode !== 'batch' || !app.renderer.dynamicRes || warmClean >= 2;
        if (!measuring && ((steps >= WARMUP_STEPS && warmupFrames >= WARMUP_FRAMES && drsSettled)
          || warmupFrames >= WARMUP_FRAME_CAP)) {
          measuring = true;
          collect();
          heapStart = heapMB();
          profiler.enabled = true;
          profiler.reset();
          lastPresent = now;
        }
        const frameT0 = performance.now();
        profiler.begin();
        const dtMs = lastReal ? now - lastReal : 1000 / 60;
        const dt = Math.min(0.25, dtMs / 1000);
        lastReal = now;

        let n = app.clock.advance(dt);
        // The measured window is counted in *measured* steps, never in total steps: a slow
        // machine burns more simulation during warmup, and clamping on the total would leave
        // it with a short measured window — or none at all.
        if (measuring && measuredDone + n > measuredSteps) n = measuredSteps - measuredDone;
        for (let i = 0; i < n; i++) {
          profiler.zone('input');
          scn.input(steps * FIXED_DT, input);
          input.tick(FIXED_DT);
          profiler.endZone();
          app.step(FIXED_DT);
          steps++;
          if (measuring) measuredDone++;
        }
        // While no player system owns the camera, the scenario's scripted flythrough drives it,
        // so the renderer is measured under motion rather than from a frozen viewpoint.
        if (!app.player && scn.camera) scn.camera(steps * FIXED_DT, app);

        app.render(app.clock.alpha);
        gpuSync();
        // In read/off modes DRS falls back to the play-mode signal (RAF gaps); in batch mode
        // it is driven from the batch samples above instead.
        if (syncMode !== 'batch') app.renderer.updateDynamicRes(dtMs);

        // A program linked after prewarm is a stall a player would feel. Record it as a mark so
        // it lands in hitch attribution, not only in a counter.
        const progs = app.renderer.newProgramsSincePrewarm();
        if (progs > seenPrograms) {
          profiler.mark('shader-compile', profiler.lastFrameMs, `${progs - seenPrograms} program(s)`);
          seenPrograms = progs;
        }
        if (app.renderer.stats.drawCalls > peakDraws) peakDraws = app.renderer.stats.drawCalls;
        if (app.renderer.stats.triangles > peakTris) peakTris = app.renderer.stats.triangles;

        profiler.end();

        if (measuring) {
          if (lastPresent && !skipGap) presentGaps.push(now - lastPresent);
          // A batch that ran in THIS callback executes after this frame's timestamp, so the
          // gap it pollutes is the NEXT one pushed.
          skipGap = batchRan;
          batchRan = false;
          lastPresent = now;
        } else {
          warmupFrames++;
          warmupWorstMs = Math.max(warmupWorstMs, performance.now() - frameT0);
        }

        // Heartbeat every 60 simulated seconds so a long soak is observable from the runner.
        if (measuring && measuredDone - lastHeartbeat >= 3600) {
          lastHeartbeat = measuredDone;
          console.log(`[profile] ${(measuredDone * FIXED_DT).toFixed(0)}s/${(measuredSteps * FIXED_DT).toFixed(0)}s simulated, ` +
            `scale ${app.renderer.resolutionScale}, heap ${heapMB() === null ? '?' : heapMB().toFixed(0)}MB`);
        }
        if (measuring && measuredDone >= measuredSteps) { cancelAnimationFrame(raf); resolve(); return; }
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    });

    input.releaseAll();
    profiler.enabled = false;
    collect();

    // True pipelined frame cost of the end-of-scenario state: N renders, ONE drain — the
    // validated throughput method. The per-frame drain in the loop above is conservative by
    // its ~4ms sync cost; this is the number a player's real swapchain would hold them to.
    let gpuThroughputMs = null;
    try {
      const tgl = app.renderer.gl.getContext();
      for (let i = 0; i < 10; i++) app.render(0);
      tgl.readPixels(0, 0, 1, 1, tgl.RGBA, tgl.UNSIGNED_BYTE, syncPixel);
      const tt0 = performance.now();
      for (let i = 0; i < 60; i++) app.render(0);
      tgl.readPixels(0, 0, 1, 1, tgl.RGBA, tgl.UNSIGNED_BYTE, syncPixel);
      gpuThroughputMs = +((performance.now() - tt0) / 60).toFixed(2);
    } catch { /* context lost — the error handler already recorded it */ }

    const base = profiler.report();
    const heap = heapGrowth(heapStart, heapMB(), profiler.memSamples);
    if (base.memTrend) heap.peakMB = base.memTrend.peakMB;
    heap.samples = base.memTrend ? base.memTrend.samples : 0;
    presentGaps.shift(); // the gap spanning the warmup boundary is not a play frame

    lastReport = {
      scenario: scn.id,
      desc: scn.desc,
      seed, width: W, height: H,
      seconds: +(measuredDone * FIXED_DT).toFixed(2),
      simSteps: measuredDone,
      status: missing.length ? 'degraded' : 'ok',
      missingSystems: missing,
      note: missing.length
        ? `skipped: ${missing.join(', ')} system${missing.length > 1 ? 's' : ''} not present — ` +
          'renderer and scripted camera were profiled; gameplay load was not'
        : '',
      ...base,
      // Gated percentiles are max(cpu, gpuBatch) per percentile — see the measurement note
      // above gpuBatchSample(). Both source distributions are reported unmerged below.
      ...(syncMode === 'batch' && gpuSamples.length ? (() => {
        const g = pctl(gpuSamples);
        return {
          p50: Math.max(base.p50 || 0, g.p50),
          p95: Math.max(base.p95 || 0, g.p95),
          p99: Math.max(base.p99 || 0, g.p99),
          worst: Math.max(base.worst || 0, g.worst),
          cpuOnly: { p50: base.p50, p95: base.p95, p99: base.p99, worst: base.worst },
          gpuBatch: g,
        };
      })() : {}),
      gpuSync: syncMode,
      // Disclosed, never hidden: the frame-time gate is met WITH the shipping adaptive
      // quality active. minSeen is the lowest internal scale the run ever needed.
      dynamicRes: app.renderer.drsState(),
      gpuThroughputMs,
      present: syncMode === 'batch' && gpuSamples.length ? pctl(gpuSamples) : pctl(presentGaps),
      warmup: { frames: warmupFrames, worstMs: +warmupWorstMs.toFixed(2), simSteps: steps - measuredDone },
      shaderCompilesDuringPlay: seenPrograms - programsAtStart,
      programsAtStart,
      peakDrawCalls: peakDraws,
      peakTriangles: peakTris,
      heap,
      bootMs: +app.bootMs.toFixed(1),
      prewarmMs: +app.stats.prewarmMs.toFixed(1),
      errors: errors.slice(),
    };
    running = false;
    return lastReport;
  }

  window.__PROFILE = true;
  window.__P = {
    app,
    errors,
    scenarios: scenarioIds(),
    catalog: SCENARIOS.map(s => ({ id: s.id, desc: s.desc, seconds: s.seconds, requires: s.requires })),
    ready: (async () => {
      await app.boot();
      // Present one frame so the page is not black while the runner attaches.
      app.render(0);
      window.__PROFILE_READY = true;
    })(),
    run,
    report() { return lastReport; },
    /**
     * Release the WebGL context. Chromium caps live contexts per process; without an explicit
     * release the next scenario's page is refused a context and the run reports a boot failure
     * that has nothing to do with the game.
     */
    dispose() {
      try { app.dispose(); } catch { /* already gone */ }
      try {
        const gl = app.renderer.gl.getContext();
        const ext = gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      } catch { /* already gone */ }
    },
    /** Which of a scenario's systems are still missing. Lets the runner label a run honestly. */
    missing(scenarioId) {
      const s = getScenario(scenarioId);
      return s ? missingSystems(app, s.requires) : ['unknown scenario'];
    },
  };

  window.__P.ready.catch((e) => {
    errors.push('boot: ' + (e && e.stack ? e.stack : String(e)));
    window.__PROFILE_ERROR = String(e && e.stack ? e.stack : e);
    window.__PROFILE_READY = true;
  });

  // Opened directly in a browser with ?auto=1 and no runner attached: run and log the report.
  if (q.get('auto') === '1') {
    window.__P.ready
      .then(() => run(defaultScenario, q.has('seconds') ? parseFloat(q.get('seconds')) : undefined))
      .then((r) => { window.__PROFILE_DONE = true; console.log(JSON.stringify(r, null, 2)); })
      .catch((e) => { errors.push('run: ' + (e && e.stack ? e.stack : String(e))); window.__PROFILE_DONE = true; });
  }
}

if (typeof document !== 'undefined' && document.getElementById) start();
