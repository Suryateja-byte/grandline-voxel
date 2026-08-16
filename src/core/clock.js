// The simulation clock. The single source of truth for "what time is it" inside the game.
//
// HARD RULE: no gameplay module may call Date.now(), performance.now(), or read the wall clock.
// Determinism depends on it. Only Clock and Profiler touch real time.

export const FIXED_DT = 1 / 60;
/** Never simulate more than this much wall time in one frame — prevents spiral-of-death. */
const MAX_CATCHUP = 0.25;

export class Clock {
  constructor() {
    /** Total simulated seconds since world start. Deterministic. */
    this.simTime = 0;
    /** Fixed steps taken. Deterministic integer — the canonical "when" for capture. */
    this.step = 0;
    /** Interpolation alpha for rendering between fixed steps. */
    this.alpha = 0;
    /** Scales dt: hitstop sets this to 0, slow-motion to <1. */
    this.timeScale = 1;
    /** Seconds of hitstop remaining (unscaled). */
    this.hitstop = 0;
    this._acc = 0;
    this._lastReal = 0;
    this._started = false;
    /** Frames the sim ran this tick — profiler uses it for attribution. */
    this.stepsThisFrame = 0;
  }

  /** Freeze the simulation for `s` real seconds. Combat impact feel depends on this. */
  addHitstop(s) {
    this.hitstop = Math.max(this.hitstop, s);
  }

  /**
   * Advance by a real-time delta. Returns the number of fixed steps to run.
   * Callers run `runStep(FIXED_DT)` that many times, then render with `this.alpha`.
   */
  advance(realDt) {
    if (realDt > MAX_CATCHUP) realDt = MAX_CATCHUP;
    if (this.hitstop > 0) {
      this.hitstop -= realDt;
      // Hitstop freezes the sim but not the render — the frame still presents.
      this.stepsThisFrame = 0;
      return 0;
    }
    this._acc += realDt * this.timeScale;
    let n = 0;
    while (this._acc >= FIXED_DT && n < 8) {
      this._acc -= FIXED_DT;
      n++;
    }
    if (this._acc >= FIXED_DT) this._acc = 0; // dropped steps; do not accumulate debt
    this.alpha = this._acc / FIXED_DT;
    this.stepsThisFrame = n;
    return n;
  }

  /** Called once per fixed step by the app. */
  commitStep() {
    this.simTime += FIXED_DT;
    this.step++;
  }

  /** Deterministic capture mode: run exactly n steps, ignoring wall time. */
  forceSteps(n) {
    this.alpha = 0;
    this.stepsThisFrame = n;
    return n;
  }
}
