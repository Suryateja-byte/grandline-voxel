// Terrain streaming: the scheduler that decides what gets built, meshed, hidden and thrown
// away each fixed step, and how much of it is allowed to happen.
//
// THE BUDGET IS IN WORK UNITS, NOT MILLISECONDS. This is not a stylistic preference. A
// wall-clock budget makes the schedule a function of the machine: a fast laptop meshes six
// chunks in its 4 ms and a slow one meshes two, so the same seed and the same route produce
// different chunk sets at the same step, capture stops being reproducible and the profiler
// stops being comparable between runs. A unit budget produces one schedule everywhere. The
// units are calibrated so that the default 4200 units/step lands near 4 ms on the target
// laptop CPU; tools/check-world.mjs prints the measured microseconds-per-unit so the
// calibration is evidence rather than a claim.
//
// Work that cannot be split (building one island's voxel volume) is allowed to overdraw the
// budget; the overdraw becomes debt and the next steps do less. Over any window the average
// holds, and no single step can start a second oversized task on top of the first.

import { CHUNK } from './chunk.js';

/** Work units allowed per fixed step by default. */
export const DEFAULT_BUDGET = 4200;

/** Debt is capped so one enormous island cannot stall streaming for a whole second. */
const MAX_DEBT_STEPS = 6;

/** Chunk priorities are only re-sorted when the focus has moved this far, in metres. */
const RESORT_MOVE_M = 6;
/** ...or after this many steps, so a stationary player still picks up dirtied chunks. */
const RESORT_STEPS = 30;

/** A chunk inside this half-angle of the view direction is meshed first. */
const VIEW_CONE_COS = Math.cos(1.15);      // ~66 degrees
/** Multiplier applied to the squared distance of an in-view chunk. Lower sorts earlier. */
const VIEW_BONUS = 0.30;

/**
 * The per-step work allowance, with carry-over debt.
 */
export class WorkBudget {
  /** @param {number} unitsPerStep */
  constructor(unitsPerStep = DEFAULT_BUDGET) {
    this.unitsPerStep = unitsPerStep;
    this.debt = 0;
    this.spent = 0;
    this.allowance = 0;
    /** Rolling total, for the profiler and the self-check. */
    this.lifetime = 0;
  }

  /** Open a step. @returns {number} units available this step (may be 0) */
  begin() {
    this.spent = 0;
    this.allowance = this.unitsPerStep - this.debt;
    if (this.allowance < 0) this.allowance = 0;
    return this.allowance;
  }

  /** @returns {boolean} true while there is allowance left */
  get open() { return this.spent < this.allowance; }

  /** @param {number} units */
  spend(units) {
    this.spent += units;
    this.lifetime += units;
  }

  /** Close the step, converting any overdraw into debt. */
  end() {
    const over = this.spent - this.allowance;
    this.debt = Math.max(0, this.debt - this.unitsPerStep) + Math.max(0, over);
    if (this.debt > this.unitsPerStep * MAX_DEBT_STEPS) this.debt = this.unitsPerStep * MAX_DEBT_STEPS;
    return this.spent;
  }
}

/**
 * The streamer. It does not know how islands are placed or built — it asks the World for
 * that — and the World does not know about budgets. That split is what keeps both testable.
 */
export class Streamer {
  /**
   * @param {object} world the World; see world.js for the hooks used below
   * @param {{budget?:number, maxChunkMeshes?:number, nearRadius?:number}} opts
   */
  constructor(world, opts = {}) {
    this.world = world;
    this.budget = new WorkBudget(opts.budget || DEFAULT_BUDGET);
    /** Hard cap on resident chunk meshes across all islands. */
    this.maxChunkMeshes = opts.maxChunkMeshes || 460;
    /** Islands closer than this switch from the LOD silhouette to real chunks. */
    this.nearRadius = opts.nearRadius || 1000;
    this.nearHysteresis = 120;

    this._pending = [];           // chunk work list, cheapest-first
    this._pendingIsland = [];     // parallel array of owning IslandInstance
    this._resortIn = 0;
    this._lastSortX = Infinity;
    this._lastSortZ = Infinity;
    this._resident = [];          // scratch used by the eviction pass

    this.stats = {
      islandsLoaded: 0, islandsBuilt: 0, islandsUnloaded: 0,
      chunksMeshed: 0, chunksEvicted: 0, chunksResident: 0, chunksPending: 0,
      triangles: 0, workLastStep: 0, workDebt: 0, workTotal: 0,
      lodBuilt: 0, islandsCompacted: 0, bytesFreed: 0,
    };
  }

  /** Force a re-sort on the next step (after a teleport or a load). */
  invalidate() {
    this._resortIn = 0;
    this._lastSortX = Infinity;
    this._lastSortZ = Infinity;
  }

  /**
   * One streaming step. Deterministic: every decision is a function of the focus, the
   * placement (pure hashes) and the budget, none of which read the wall clock.
   */
  step() {
    const world = this.world;
    const f = world.focus;
    const b = this.budget;
    b.begin();

    // 1. Residency. Cheap set arithmetic, always runs, never budgeted — if this were
    //    budgeted a slow frame could leave an island resident forever.
    this._updateResidency();

    // 2. Build at most one island per step. An island build is atomic (the authoring
    //    toolkit has no resumable form) so it is allowed to overdraw into debt.
    if (b.open) {
      const rec = world.nextIslandToBuild();
      if (rec) {
        const work = world.buildIsland(rec);
        b.spend(work);
        this.stats.islandsBuilt++;
        this.invalidate();
      }
    }

    // 3. LOD silhouettes. One per step at most: an island with no LOD and no chunks is
    //    invisible, so this outranks chunk detail.
    if (b.open) {
      let bestInst = null, bestD = Infinity;
      for (const inst of world.loaded.values()) {
        if (inst.lodBuilt) continue;
        const dx = inst.centerX - f.x, dz = inst.centerZ - f.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; bestInst = inst; }
      }
      if (bestInst) {
        b.spend(bestInst.buildLod());
        this.stats.lodBuilt++;
      }
    }

    // 4. Near/far swap, then chunk meshing against the remaining allowance.
    this._updateNear();
    this._refreshPending();
    while (b.open && this._pending.length) {
      const ch = this._pending.pop();
      const inst = this._pendingIsland.pop();
      if (!inst.vol) continue;                       // island unloaded under us
      if (ch.state === CHUNK.MESHED) continue;       // already handled this step
      b.spend(inst.meshChunk(ch));
      this.stats.chunksMeshed++;
    }

    // 5. Memory cap. Runs after meshing so the cap is enforced against the real total.
    this._enforceChunkCap();

    // 6. Hand back the voxel volumes of islands that are only being drawn as silhouettes.
    //    This is the difference between "resident memory grows with the number of islands
    //    you have visited" and "resident memory is a function of where you are standing".
    for (const inst of world.loaded.values()) {
      if (!inst.near && inst.lodBuilt && inst.vol) {
        this.stats.bytesFreed += inst.compact();
        this.stats.islandsCompacted++;
      }
    }

    this.stats.workLastStep = b.end();
    this.stats.workDebt = b.debt;
    this.stats.workTotal = b.lifetime;
    this.stats.chunksPending = this._pending.length;
    this._recount();
  }

  // --- residency ----------------------------------------------------------

  _updateResidency() {
    const world = this.world;
    const drop = world.islandsToUnload();
    for (const inst of drop) {
      world.unloadIsland(inst);
      this.stats.islandsUnloaded++;
      this.invalidate();
    }
  }

  _updateNear() {
    const f = this.world.focus;
    for (const inst of this.world.loaded.values()) {
      const dx = inst.centerX - f.x, dz = inst.centerZ - f.z;
      const d = Math.sqrt(dx * dx + dz * dz) - inst.radius;
      const on = inst.near ? this.nearRadius + this.nearHysteresis : this.nearRadius;
      const near = d < on;
      if (near !== inst.near) {
        inst.setNear(near);
        this.invalidate();
        if (!near) {
          // Leaving an island: its chunks are the largest block of memory we can give
          // back, and the LOD already covers the silhouette.
          for (const ch of inst.chunks.values()) {
            if (ch.state === CHUNK.MESHED || ch.state === CHUNK.DIRTY) {
              inst.evictChunk(ch);
              this.stats.chunksEvicted++;
            }
          }
        }
      }
    }
  }

  // --- chunk work list ----------------------------------------------------

  /**
   * Rebuild the cheapest-first work list when the focus has moved enough to change the
   * answer. Sorted DESCENDING so the hot loop can pop() from the end.
   */
  _refreshPending() {
    const f = this.world.focus;
    const moved = Math.hypot(f.x - this._lastSortX, f.z - this._lastSortZ);
    if (this._resortIn > 0 && moved < RESORT_MOVE_M && this._pending.length) {
      this._resortIn--;
      return;
    }
    this._resortIn = RESORT_STEPS;
    this._lastSortX = f.x;
    this._lastSortZ = f.z;

    const list = this._pending;
    const owner = this._pendingIsland;
    list.length = 0;
    owner.length = 0;

    // View direction from the simulation-owned focus yaw. Deliberately not read from the
    // camera object: the camera is interpolated in preRender and reading it here would
    // make the schedule depend on the render alpha.
    const vdx = Math.sin(f.yaw), vdz = Math.cos(f.yaw);
    const c = { x: 0, y: 0, z: 0 };

    for (const inst of this.world.loaded.values()) {
      if (!inst.near || !inst.vol) continue;
      for (const ch of inst.candidates) {
        if (ch.state === CHUNK.MESHED || ch.state === CHUNK.EMPTY) continue;
        inst.chunkCenter(ch, c);
        const dx = c.x - f.x, dy = c.y - f.y, dz = c.z - f.z;
        let d2 = dx * dx + dy * dy + dz * dz;
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        if ((dx * vdx + dz * vdz) / len > VIEW_CONE_COS) d2 *= VIEW_BONUS;
        // A dirtied chunk is a hole the player just punched in the terrain. It jumps the
        // queue unconditionally — waiting on it is visible as a missing wall.
        if (ch.state === CHUNK.DIRTY) d2 = -1e9 + d2 * 1e-3;
        ch.dist2 = d2;
        list.push(ch);
        owner.push(inst);
      }
    }

    // Sort both arrays together by building an index permutation — the two arrays are
    // parallel and Array.prototype.sort cannot see that.
    const n = list.length;
    if (n > 1) {
      const order = new Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      order.sort((a, b) => list[b].dist2 - list[a].dist2);   // descending: pop() = nearest
      const l2 = new Array(n), o2 = new Array(n);
      for (let i = 0; i < n; i++) { l2[i] = list[order[i]]; o2[i] = owner[order[i]]; }
      for (let i = 0; i < n; i++) { list[i] = l2[i]; owner[i] = o2[i]; }
    }
  }

  // --- memory cap ---------------------------------------------------------

  /**
   * Hard cap on resident chunk meshes. Without it a player who tours six islands without
   * ever leaving the load radius accumulates geometry until the tab dies; with it, the
   * furthest chunks are given back and re-meshed on demand.
   */
  _enforceChunkCap() {
    let total = 0;
    for (const inst of this.world.loaded.values()) total += inst.meshedChunks;
    if (total <= this.maxChunkMeshes) return;

    const f = this.world.focus;
    const res = this._resident;
    res.length = 0;
    const c = { x: 0, y: 0, z: 0 };
    for (const inst of this.world.loaded.values()) {
      for (const ch of inst.chunks.values()) {
        if (ch.state !== CHUNK.MESHED && ch.state !== CHUNK.DIRTY) continue;
        inst.chunkCenter(ch, c);
        const dx = c.x - f.x, dy = c.y - f.y, dz = c.z - f.z;
        res.push({ inst, ch, d2: dx * dx + dy * dy + dz * dz });
      }
    }
    res.sort((a, b) => b.d2 - a.d2);          // furthest first
    let over = total - this.maxChunkMeshes;
    for (let i = 0; i < res.length && over > 0; i++, over--) {
      res[i].inst.evictChunk(res[i].ch);
      this.stats.chunksEvicted++;
    }
    res.length = 0;
    this.invalidate();
  }

  _recount() {
    let chunks = 0, tris = 0;
    for (const inst of this.world.loaded.values()) {
      chunks += inst.meshedChunks;
      tris += inst.triangles + inst.lodTriangles;
    }
    this.stats.chunksResident = chunks;
    this.stats.triangles = tris;
    this.stats.islandsLoaded = this.world.loaded.size;
  }

  /** Run the streamer until nothing is pending. Used by capture setup and the self-check. */
  settle(maxSteps = 4000) {
    let n = 0;
    for (; n < maxSteps; n++) {
      this.step();
      const rec = this.world.nextIslandToBuild();
      if (!rec && !this._pending.length && this.budget.debt === 0) {
        let missingLod = false;
        for (const inst of this.world.loaded.values()) if (!inst.lodBuilt) missingLod = true;
        if (!missingLod) break;
      }
    }
    return n;
  }
}
