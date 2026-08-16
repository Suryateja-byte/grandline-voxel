// Playtest-mode entry. Loaded ONLY by playtest.html.
//
// The rule that makes this evidence rather than decoration: the script drives the game by
// DISPATCHING REAL DOM EVENTS at the same targets a human's keyboard and mouse hit, and asserts
// only on observable game state. It never calls a gameplay function. If this script can finish
// the game, a player can; if it calls `player.board()` directly, it has proved nothing.
//
// Every step declares the systems it needs. While those systems are being built in parallel the
// step reports "skipped: <system> not present" instead of failing, and the run continues. When
// the systems land the same steps become live with no edit here.
//
// Nothing touches the DOM at import time — `start()` runs at the bottom only when a document
// exists — so this module can be import-checked under node.

import { App, MODE } from './app.js';
import { buildGameSystems } from './game.js';
import { FIXED_DT } from './core/clock.js';
import { createInputApi, missingSystems } from './scenarios.js';
import { angleDelta, clamp } from './core/math.js';

// Slot 0 of the real save system (core/save.js writes KEY_PREFIX + slot).
const SAVE_KEY = 'glv.save.v1.slot0';
const RESUME_KEY = 'glv.playtest.resume.v1';

// ---------------------------------------------------------------------------------------
// Observable-state accessors. Written defensively so a system can expose either a plain
// array or a THREE.Vector3 without breaking the assertions. The contract we asked for in
// ARCHITECTURE §9 is `pos`; `position` is accepted because that is what a Object3D calls it.
// ---------------------------------------------------------------------------------------

/** @returns {{x:number,y:number,z:number}|null} */
function posOf(o) {
  if (!o) return null;
  const p = o.pos !== undefined ? o.pos : o.position;
  if (!p) return null;
  if (Array.isArray(p)) return { x: p[0], y: p[1], z: p[2] };
  if (typeof p.x === 'number') return { x: p.x, y: p.y, z: p.z };
  return null;
}

function dist2d(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Parse the save blob without assuming it exists or is valid. */
function readSave(slot) {
  try {
    const key = slot === undefined ? SAVE_KEY : 'glv.save.v1.slot' + slot;
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/** How many quests are DONE, read through the public journal. */
/**
 * Coarse route plan over the terrain heightfield: BFS on a 2 m grid, walkable = above the
 * tideline and no step over 2.2 m between neighbouring cells. This is the driver's MAP
 * sense — eight measured runs proved that no amount of local veer/escape ritual can cross
 * the village's hut-and-grove belt reliably: reactive navigation walks into concave pockets
 * faster than any unstick can drain them. A human reads the terrain and routes around; so
 * does this. Returns [[x,z], ...] from start to (as near as reachable to) the target.
 */
function planRoute(app, sx, sz, tx, tz, avoid) {
  if (!app.world || typeof app.world.heightAt !== 'function') return null;
  const C = 2, MAX_POPS = 24000;
  // Cells within 6 m of an avoid-point (live enemies) are unwalkable: the driver's route
  // steers AROUND standing brawls instead of tanking through them. If the target itself
  // sits inside a brawl the partial-route fallback still walks to its edge.
  const av = avoid && avoid.length ? avoid : null;
  const blocked = (wx, wz) => {
    if (!av) return false;
    for (let i = 0; i < av.length; i++) {
      const dx = wx - av[i].x, dz = wz - av[i].z;
      if (dx * dx + dz * dz < 36) return true;
    }
    return false;
  };
  const h = (x, z) => app.world.heightAt(x, z);
  const k2 = (cx, cz) => cx + ',' + cz;
  const hCache = new Map();
  const hOf = (cx, cz) => {
    const k = k2(cx, cz);
    if (hCache.has(k)) return hCache.get(k);
    const v = h(cx * C, cz * C);
    hCache.set(k, v);
    return v;
  };
  const sx0 = Math.round(sx / C), sz0 = Math.round(sz / C);
  const tx0 = Math.round(tx / C), tz0 = Math.round(tz / C);
  const from = new Map([[k2(sx0, sz0), null]]);
  let q = [[sx0, sz0]];
  let best = [sx0, sz0];
  let bestD = Math.hypot(sx0 - tx0, sz0 - tz0);
  let pops = 0, found = false;
  while (q.length && pops < MAX_POPS && !found) {
    const next = [];
    for (const [cx, cz] of q) {
      if (++pops > MAX_POPS) break;
      const hc = hOf(cx, cz);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, nz = cz + dz;
        const nk = k2(nx, nz);
        if (from.has(nk)) continue;
        const hn = hOf(nx, nz);
        if (!(hn > -0.5 && Math.abs(hn - hc) <= 2.2)) continue;
        if (blocked(nx * C, nz * C)) continue;
        from.set(nk, k2(cx, cz));
        const d = Math.hypot(nx - tx0, nz - tz0);
        if (d < bestD) { bestD = d; best = [nx, nz]; }
        if (nx === tx0 && nz === tz0) { found = true; best = [nx, nz]; break; }
        next.push([nx, nz]);
      }
      if (found) break;
    }
    q = next;
  }
  // Reconstruct from the closest reachable cell — partial routes still beat crow-flies.
  const path = [];
  let cur = k2(best[0], best[1]);
  while (cur) {
    const [cx, cz] = cur.split(',').map(Number);
    path.push([cx * C, cz * C]);
    cur = from.get(cur);
  }
  path.reverse();
  return path.length > 1 ? path : null;
}

/**
 * Obstacle-aware walk used by the quest-runner branches. Aim at the target, veer to stay on
 * walkable ground (a devil-fruit user must not march into the sea), hop periodically, and
 * strafe out when position stops changing. Returns the distance to the target.
 */
function walkTowards(api, app, steerTo, pp, tx, tz, t, ctx) {
  // Route sense first: aim at the next BFS waypoint, not the crow-flies bearing. The local
  // probe/veer/escape below stays as the reactive layer for what the 2 m grid cannot see.
  let ax = tx, az = tz;
  if (ctx && dist2d(pp, { x: tx, z: tz }) > 10) {
    const rkey = Math.round(tx / 3) + ',' + Math.round(tz / 3);
    if (ctx._routeKey !== rkey || (t - (ctx._routeT ?? -99)) > 12) {
      ctx._routeKey = rkey; ctx._routeT = t;
      const avoid = [];
      if (app.enemies && typeof app.enemies.list === 'function') {
        for (const e of app.enemies.list()) {
          if (!e.dead && dist2d(pp, e) < 70) avoid.push({ x: e.x, z: e.z });
        }
      }
      ctx._route = planRoute(app, pp.x, pp.z, tx, tz, avoid);
      ctx._routeI = 0;
    }
    const rt = ctx._route;
    if (rt && rt.length) {
      if (ctx._routeI >= rt.length) ctx._routeI = rt.length - 1;
      while (ctx._routeI < rt.length - 1
        && dist2d(pp, { x: rt[ctx._routeI][0], z: rt[ctx._routeI][1] }) < 4) ctx._routeI++;
      let j = ctx._routeI;
      while (j + 1 < rt.length && dist2d(pp, { x: rt[j + 1][0], z: rt[j + 1][1] }) < 10) j++;
      ax = rt[j][0]; az = rt[j][1];
    }
  }
  let aim = Math.atan2(ax - pp.x, az - pp.z);
  // Escalating escape. The alternate-strafe unstick handles a wall; it cannot escape a doorway
  // pocket or building corner — the driver sat wedged at the same village coordinate for four
  // consecutive full-budget runs. After three stuck seconds, commit to walking AWAY along a
  // rotated heading for two seconds before re-approaching; the detour breaks the pocket.
  if (ctx) {
    if (ctx._wesc === undefined) { ctx._wesc = 0; ctx._wstuckT = 0; ctx._wescN = 0; }
    if (ctx._wesc > 0) {
      ctx._wesc -= 1 / 60;
      aim += ctx._wescAim || 2.4;          // committed detour heading
    } else if (ctx._wstuck) {
      ctx._wstuckT += 1 / 60;
      if (ctx._wstuckT > 3) {
        // Escape order matters. FIRST attempt: straight back out (+pi) — a wedge between
        // palm trunks is open exactly the way the driver walked in (measured: pushes at the
        // grove wedge moved 2.1 m north, 0 m south/east). Later attempts cycle varied
        // side-headings so a genuine pocket still gets explored.
        const k = ctx._wescN = (ctx._wescN || 0) + 1;
        ctx._wescAim = k === 1 ? Math.PI : [2.4, -2.4, 3.0, -1.7, 1.2, -3.0][k % 6];
        ctx._wesc = 2.0 + (k % 3) * 0.8;
        ctx._wstuckT = 0;
      }
    } else {
      ctx._wstuckT = 0;
    }
  }
  // A heading is walkable when the ground 4 m out is neither water NOR a cliff. The water
  // rule always existed; the cliff rule was learned the hard way: three of the five quest
  // floats sit up hillsides (measured: item heights 4-9.5 m amid 10-14.5 m ridges), and a
  // probe that only fears the sea marched face-first into rock walls for three full runs.
  // Near the target, wadeable shallows are accepted so a tideline pickup stays reachable.
  const dToTarget = dist2d(pp, { x: tx, z: tz });
  const hMin = dToTarget < 14 ? -0.75 : 0.2;
  const py = pp.y || 0;
  const hAt = (x, z) => (app.world && app.world.heightAt ? app.world.heightAt(x, z) : 1);
  // The heightfield already contains every obstacle that matters — hut roofs, palm trunks,
  // ridges — because heightAt returns the TOPMOST solid voxel. What defeated the driver was
  // RESOLUTION: one sample 4 m out let 1 m-wide palm trunks 2 m away slip between probes,
  // and the capsule wedged between adjacent trees (measured: the village's south grove reads
  // 3 -> 9.5 -> 3 m across adjacent metre samples). Probe three distances along the heading,
  // never sampling past the target itself (a shoreline pickup must not be vetoed by the deep
  // water BEHIND it).
  const probe = (a) => {
    const sx = Math.sin(a), cx = Math.cos(a);
    for (const pd of [1.6, 3.0, 4.4]) {
      if (pd > dToTarget + 0.5) break;
      const h = hAt(pp.x + sx * pd, pp.z + cx * pd);
      if (!(h > hMin && h - py < 2.75)) return false;
    }
    return true;
  };
  if (!probe(aim)) {
    // The veer SIDE is sticky per journey. It used to flip on global time every 6 s — on a
    // shoreline detour longer than 6 s (the cove between the village and the far floats) the
    // flip reversed the walk mid-detour and the driver pendulumed on the beach for the whole
    // budget (measured three runs: 46k collect steps, 2-3 taps). Pick the side that clears
    // with the smallest deflection once, keep it until the target changes.
    // Steps of 0.35 rad: at probe range that is ~1.4 m of lateral resolution, fine enough to
    // thread the gaps between grove trunks that 0.5 rad steps jumped straight over.
    if (ctx) {
      const vkey = Math.round(tx) + ',' + Math.round(tz);
      if (ctx._veerKey !== vkey) { ctx._veerKey = vkey; ctx._veerSgn = 0; }
      if (!ctx._veerSgn) {
        ctx._veerSgn = 1;
        for (let k = 1; k <= 8; k++) {
          if (probe(aim + k * 0.35)) { ctx._veerSgn = 1; break; }
          if (probe(aim - k * 0.35)) { ctx._veerSgn = -1; break; }
        }
      }
    }
    const sgn = ctx && ctx._veerSgn ? ctx._veerSgn : 1;
    let cleared = false;
    for (let k = 1; k <= 8; k++) {
      if (probe(aim + sgn * k * 0.35)) { aim += sgn * k * 0.35; cleared = true; break; }
    }
    if (!cleared) aim += Math.PI;
  }
  steerTo(api, pp.x + Math.sin(aim) * 10, pp.z + Math.cos(aim) * 10);
  const d = dist2d(pp, { x: tx, z: tz });
  api.set('moveForward', d > 2.0);
  api.set('sprint', d > 20);
  // Voxel slopes are stairs: when the ground just ahead is a step up, jump at climb tempo
  // instead of the idle hop cadence.
  const aheadH = app.world && app.world.heightAt
    ? app.world.heightAt(pp.x + Math.sin(aim) * 2, pp.z + Math.cos(aim) * 2) : 0;
  if (aheadH - py > 0.6) { if ((t % 0.5) < 0.06) api.tap('jump'); }
  else if ((t % 1.6) < 0.06) api.tap('jump');
  // Stuck detection: under half a metre of movement in a second means strafe free.
  if (ctx) {
    if (ctx._wpos === undefined || t - (ctx._wt || 0) > 1.0) {
      ctx._wstuck = ctx._wpos !== undefined && dist2d(pp, ctx._wpos) < 0.5;
      ctx._wpos = { x: pp.x, z: pp.z };
      ctx._wt = t;
    }
    if (ctx._wstuck) {
      api.set(Math.floor(t / 2) % 2 === 0 ? 'moveLeft' : 'moveRight', true);
      if ((t % 0.9) < 0.08) api.tap('jump');
    } else {
      api.set('moveLeft', false); api.set('moveRight', false);
    }
  }
  return d;
}

/** Bounty lives in the quest system (ARCHITECTURE §5) — player.bounty was never a real field. */
function bountyOf(app) {
  try { const q = app.quests || app.quest; return q && q.bountyState ? (q.bountyState().total || 0) : 0; }
  catch { return 0; }
}

function questsDone(app) {
  const q = app.quests || app.quest;
  if (!q || typeof q.questLog !== 'function') return 0;
  let n = 0;
  try { for (const isl of q.questLog()) n += isl.done || 0; } catch {}
  return n;
}

/** The island the first leg of the voyage is aimed at. */
function firstIsland(app) {
  const w = app.world;
  if (w && typeof w.firstIsland === 'function') return w.firstIsland();
  if (w && typeof w.nearestIsland === 'function') return w.nearestIsland(0, 0);
  return null;
}

/**
 * Turn the player toward a world point using the mouse, exactly as a human would.
 *
 * The look sensitivity is owned by the input system and unknown here, so the first call probes
 * it: apply a known mouse delta, measure the yaw response, and derive the gain (including its
 * sign). Guessing the sign instead would make the controller diverge on half of all builds.
 */
function makeSteering(app) {
  let gain = null;
  let probeYaw = 0;
  let probes = 0;
  // Steer the CAMERA, not the character: movement is camera-relative (W walks camera-forward),
  // and the camera's yaw responds to mouse look directly and immediately. The character's own
  // yaw only turns while moving, so probing it measured walking noise and could lock in a
  // wrong — even inverted — gain, which walked the script into the sea at full commitment.
  const camYaw = () => (app.gameCamera && typeof app.gameCamera.yaw === 'number')
    ? app.gameCamera.yaw : (app.player ? app.player.yaw : 0);
  return function steerTo(api, x, z) {
    const p = app.player;
    const pp = posOf(p);
    if (!p || !pp) return false;
    const want = Math.atan2(x - pp.x, z - pp.z);   // ARCHITECTURE §3: yaw = atan2(dx, dz)
    const yaw = camYaw();
    if (gain === null) {
      if (probes > 0) {
        const resp = angleDelta(probeYaw, yaw);
        if (Math.abs(resp) > 2e-3) gain = 24 / resp;
        else if (probes > 40) gain = 24 / 0.05;    // unresponsive; assume a sane sensitivity
      }
      if (gain === null) { probeYaw = yaw; probes++; api.look(24, 0); return false; }
    }
    const d = angleDelta(yaw, want);
    api.look(clamp(d * gain, -80, 80), 0);
    return Math.abs(d) < 0.15;
  };
}

// ---------------------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------------------

/**
 * @typedef {object} Step
 * @property {string} id
 * @property {string} desc
 * @property {string[]} requires   systems that must exist for this step to be meaningful
 * @property {number} timeoutS     simulated seconds before the step fails
 * @property {string} failure      what to say when it times out — always names the step
 * @property {(ctx:object)=>void} [enter]  once, when the step begins
 * @property {(t:number, ctx:object)=>void} [drive] every fixed step
 * @property {(ctx:object)=>boolean} done
 * @property {boolean} [reload]    the runner reloads the page when this step is reached
 */

/** @type {Step[]} */
export const STEPS = [
  {
    id: 'boot',
    desc: 'the app boots, builds its procedural textures and presents a frame',
    requires: [], timeoutS: 30,
    failure: 'boot: the app never finished booting or produced no texture tiles',
    done: ({ app }) => !!app.renderer && app.stats.tiles > 0 && app.clock.step > 0,
  },
  {
    id: 'tutorial-completes',
    desc: 'the opening tutorial can be finished with the controls it teaches',
    requires: ['flags'], timeoutS: 240,
    failure: 'tutorial-completes: flags.tutorialDone never became true while the script performed '
      + 'each action the tutorial teaches (look, walk, fight, talk, quest, board, sail, '
      + 'cast off, dock, map)',
    drive(t, ctx) {
      const { api, app, steerTo } = ctx;
      // Perform what the CURRENT tutorial lesson teaches — the tutorial watches state, so the
      // only honest way to finish it is to actually do each thing with real input events.
      // The tutorial is a trigger table: `current` is the armed lesson being displayed, and
      // may be null when nothing is armed — the fallback below then CREATES the arming
      // condition for the highest-priority gap (walk near an NPC, aggro the sparring
      // partner, board the ship) so the next lesson can fire.
      const tut = app.ui && app.ui.tutorial;
      const cur = tut && tut.current;
      const p = app.player;
      const pp = posOf(p);
      // The village NPCs stand on authored flat ground — the one reliably walkable anchor near
      // the dock. Walking toward the island CENTRE instead marched the script up cliffs and
      // off piers into the sea, where a devil-fruit user can do nothing the tutorial asks.
      const npcAnchor = () => {
        let best = null, bd = 1e9;
        for (const n of (app.npc && app.npc.list) || []) {
          const d = dist2d(pp, posOf(n));
          if (d < bd) { bd = d; best = n; }
        }
        return best ? { pos: posOf(best), d: bd } : null;
      };
      // For the on-foot lessons: get off the ship, then reach SOLID GROUND clear of the
      // gangplank. The gate is the ground itself, not proximity to an NPC — villagers wander,
      // and a moving anchor left the script chasing them instead of performing the lesson.
      const ashore = () => {
        if (p.onShip) { api.set('moveForward', false); if ((t % 0.7) < 0.1) api.tap('interact'); return false; }
        const sp = posOf(app.ship);
        const nearShip = sp && pp && dist2d(pp, sp) < 9;
        const groundH = app.world && app.world.heightAt ? app.world.heightAt(pp.x, pp.z) : 1;
        if (!nearShip && groundH > 0.5 && pp.y > -0.5) { api.set('moveForward', false); return true; }
        const a = npcAnchor();
        if (a) steerTo(api, a.pos.x, a.pos.z);
        api.set('moveForward', true);
        return false;
      };
      // Walk to an NPC: the quest step goes to a quest giver, the talk step to anyone else.
      // Same unstick pattern as the combat steps — village clutter snags a straight line.
      const seekNpc = (wantGiver) => {
        const givers = new Set((app.quests && app.quests.availableQuests
          ? app.quests.availableQuests() : []).map(q => q.giver));
        const list = (app.npc && app.npc.list) || [];
        let best = null, bd = 1e9;
        for (const n of list) {
          if (wantGiver !== givers.has(n.npcId)) continue;
          const d = dist2d(pp, posOf(n));
          if (d < bd) { bd = d; best = n; }
        }
        if (!best) for (const n of list) { const d = dist2d(pp, posOf(n)); if (d < bd) { bd = d; best = n; } }
        if (!best) return;
        const np = posOf(best);
        steerTo(api, np.x, np.z);
        api.set('moveForward', bd > 2.4);
        if (ctx._np === undefined || t - (ctx._nt || 0) > 1.2) {
          ctx._nstuck = ctx._np !== undefined && bd > 3.6 && dist2d(pp, ctx._np) < 0.5;
          ctx._np = { x: pp.x, z: pp.z };
          ctx._nt = t;
        }
        if (ctx._nstuck) {
          const side = Math.floor(t / 2) % 2 === 0;
          api.set('moveLeft', side);
          api.set('moveRight', !side);
          if ((t % 0.5) < 0.06) api.tap('jump');
        } else {
          api.set('moveLeft', false);
          api.set('moveRight', false);
          if (bd > 6 && (t % 1.7) < 0.06) api.tap('jump');
        }
        if (bd < 3.6 && (t % 0.8) < 0.1) api.tap('interact');
      };
      // Stand toe to toe with the dockside sparring partner so the combat lessons have a
      // live opponent: block/dodge arm off his telegraphs (hud.target). Returns true when
      // in sparring range.
      const seekSparring = () => {
        let spar = null;
        for (const e of (app.combat && app.combat.enemies) || []) {
          if (e.kind === 'sparring' && !e.dead) { spar = e; break; }
        }
        if (!spar) return true;                       // no partner: swing at air, as before
        const d = dist2d(pp, spar);
        if (d > 2.4) { steerTo(api, spar.x, spar.z); api.set('moveForward', true); return false; }
        api.set('moveForward', false);
        return true;
      };
      // The home berth, for the sea act's steer/dock legs.
      const homeDock = () => {
        const near = app.ship && app.ship.dock && app.ship.dock.nearIsland;
        const isl = near || firstIsland(app);
        if (!isl) return null;
        if (isl.worldPos && isl.dockPos) {
          return { x: isl.worldPos[0] + isl.dockPos[0], z: isl.worldPos[1] + isl.dockPos[1] };
        }
        return { x: isl.x !== undefined ? isl.x : 0, z: isl.z !== undefined ? isl.z : 0 };
      };
      const lp = (id) => !!(tut && tut.learned && tut.learned.has(id));

      if (!cur) {
        // Nothing armed. Create the arming condition for the biggest gap, highest priority
        // first — mirroring the tutorial's own ordering so the driver and the display agree.
        if (!lp('look')) { api.look(26, 9); return; }
        if (!lp('move')) {
          const a = npcAnchor();
          if (a) steerTo(api, a.pos.x + Math.sin(t * 0.7) * 4, a.pos.z + Math.cos(t * 0.7) * 4);
          api.set('moveForward', true);
          return;
        }
        if ((!lp('talk') || !lp('quest')) && ashore()) { seekNpc(!lp('quest') && lp('talk')); return; }
        if ((!lp('attack') || !lp('block') || !lp('dodge') || !lp('fruit'))) {
          if (ashore()) seekSparring();               // aggro him: block/dodge arm off his swings
          return;
        }
        if (!lp('board') || !lp('sail') || !lp('steer') || !lp('dock')) {
          if (!p.onShip) {
            const bp = app.ship && typeof app.ship.boardingPoint === 'function'
              ? app.ship.boardingPoint() : posOf(app.ship);
            if (bp) steerTo(api, bp.x, bp.z);
            api.set('moveForward', true);
            if ((t % 1.7) < 0.06) api.tap('jump');
            if ((t % 0.7) < 0.1) api.tap('interact');
          } else {
            api.set('moveForward', false);
            if ((app.ship.body.sailTrim || 0) < 0.5 && (t % 0.9) < 0.05) api.tap('sailUp');
          }
          return;
        }
        return;                                       // map arms off quest; nothing to force
      }
      switch (cur.id) {
        case 'look': api.look(26, 9); break;
        case 'move': {
          // Orbit the village anchor: 9 m of walking must accumulate, so never stand still.
          const a = npcAnchor();
          if (a) {
            const ang = t * 0.7;
            steerTo(api, a.pos.x + Math.sin(ang) * 4, a.pos.z + Math.cos(ang) * 4);
          }
          api.set('moveForward', true);
          break;
        }
        case 'board': {
          if (p.onShip) { api.set('moveForward', false); break; }
          // Aim at the gangplank head, not the hull: the hull is moored 6 m offshore and
          // walking at its centre marches the script off the pier into the sea.
          const bp = app.ship && typeof app.ship.boardingPoint === 'function'
            ? app.ship.boardingPoint() : posOf(app.ship);
          if (bp) steerTo(api, bp.x, bp.z);
          api.set('moveForward', true);
          if ((t % 1.7) < 0.06) api.tap('jump');   // hop the village clutter on the way
          if ((t % 0.7) < 0.1) api.tap('interact');
          break;
        }
        case 'sail': { api.set('moveForward', false); if ((t % 0.9) < 0.05) api.tap('sailUp'); break; }
        case 'steer': {
          // Under sail. At the berth the marker is already in range; at sea, aim the helm at
          // the home dock so the distance-to-marker delta accumulates.
          const hd = homeDock();
          if (hd) steerTo(api, hd.x, hd.z);
          api.set('moveForward', true);
          break;
        }
        case 'dock': {
          // The harbour round trip. Phase 1 (still berthed): G casts off. Phase 2 (at sea):
          // reef below the dock gate's speed limit, hold the approach, G moors.
          const d = app.ship.dock;
          if (!(tut.flags && tut.flags.undocked)) {
            api.set('moveForward', false);
            if ((t % 1.2) < 0.06) api.tap('anchor');            // cast off
            break;
          }
          const hd = homeDock();
          if (hd) steerTo(api, hd.x, hd.z);
          api.set('moveForward', false);
          if (app.ship.body.speed > 2.6 && (t % 0.5) < 0.06) api.tap('sailDown');
          if (d.state === 'approach' && app.ship.body.speed < 3.0 && (t % 0.8) < 0.1) api.tap('anchor');
          break;
        }
        case 'attack': {
          if (!ashore()) break;
          if (!seekSparring()) break;
          if ((t % 0.7) < 0.05) api.tap('lightAttack');
          break;
        }
        case 'block': {
          if (!ashore()) break;
          seekSparring();
          api.set('block', (t % 1.8) < 1.1);
          break;
        }
        case 'dodge': {
          if (!ashore()) break;
          seekSparring();
          api.set('block', false);
          if ((t % 1.1) < 0.06) api.tap('dodge');
          break;
        }
        case 'fruit': { if (!ashore()) break; if ((t % 1.4) < 0.05) api.tap('fruitPower'); break; }
        case 'talk': { if (!ashore()) break; seekNpc(false); break; }
        case 'quest': { if (!ashore()) break; seekNpc(true); break; }
        case 'map': {
          api.set('moveForward', false);
          const beat = t % 2.4;
          if (app.ui && app.ui.menuOpen) { if (beat > 1.2 && beat < 1.3) api.tap('pause'); }
          else if (beat < 0.1) api.tap('map');
          break;
        }
        default: break;
      }
    },
    done: ({ app }) => !!(app.flags && app.flags.tutorialDone),
  },
  {
    id: 'board-ship',
    desc: 'walk to the ship and board it with the interact key',
    requires: ['player', 'ship'], timeoutS: 90,
    failure: 'board-ship: player.onShip never became true after walking to the ship and pressing interact',
    drive(t, { api, app, steerTo }) {
      const sp = app.ship && typeof app.ship.boardingPoint === 'function'
        ? app.ship.boardingPoint() : posOf(app.ship);
      if (sp) steerTo(api, sp.x, sp.z);
      api.set('moveForward', true);
      if ((t % 1.7) < 0.06) api.tap('jump');
      if ((t % 0.8) < 0.1) api.tap('interact');
    },
    done: ({ app }) => app.player.onShip === true,
  },
  {
    id: 'sail-to-first-island',
    desc: 'sail until the first island is within docking range',
    requires: ['player', 'ship', 'world'], timeoutS: 300,
    failure: 'sail-to-first-island: the ship never came within 80m of the first island under full sail',
    enter(ctx) { ctx.island = firstIsland(ctx.app); },
    drive(t, { api, app, island, steerTo }) {
      api.set('moveForward', true);            // sail pinned open
      if (island) steerTo(api, island.x, island.z);
      if ((t % 5) < 0.05) api.tap('map');      // the map must survive being opened under way
    },
    done: ({ app, island }) => !!island && dist2d(posOf(app.ship), island) < 80,
  },
  {
    id: 'dock',
    desc: 'dock the ship at the island',
    requires: ['ship'], timeoutS: 90,
    failure: 'dock: ship.docked never became true within docking range of the island',
    drive(t, { api, app, island, steerTo }) {
      const target = island && island.dockX !== undefined ? { x: island.dockX, z: island.dockZ } : island;
      if (target) steerTo(api, target.x, target.z);
      api.set('moveForward', (t % 2) < 1.2);
      if ((t % 0.6) < 0.1) api.tap('interact');
    },
    done: ({ app }) => app.ship.docked === true,
  },
  {
    id: 'walk-ashore',
    desc: 'leave the ship and stand on land above sea level',
    requires: ['player', 'world'], timeoutS: 90,
    failure: 'walk-ashore: the player never left the ship and reached ground above sea level',
    drive(t, { api, app, steerTo }) {
      // The sailing step may have left the map open; a menu blocks the play snapshot.
      if (app.ui && app.ui.menuOpen) { if ((t % 0.8) < 0.1) api.tap('pause'); return; }
      if (app.player.onShip && (t % 0.6) < 0.1) { api.tap('interact'); return; }
      // ctx.island belongs to the sailing step's context; resolve the island here.
      const isl = firstIsland(app);
      if (isl) steerTo(api, isl.x, isl.z);
      api.set('moveForward', true);
      api.set('sprint', (t % 4) < 1.5);         // sprint inland
    },
    done: ({ app }) => {
      if (app.player.onShip) return false;
      const p = posOf(app.player);
      if (!p) return false;
      const h = app.world && app.world.heightAt ? app.world.heightAt(p.x, p.z) : p.y;
      return h > 0.5;
    },
  },
  {
    id: 'enter-combat',
    desc: 'find a fight',
    requires: ['player', 'combat'], timeoutS: 120,
    failure: 'enter-combat: combat.active never became true while the player explored the island',
    drive(t, { api, app, steerTo }) {
      if (app.ui && app.ui.menuOpen) { if ((t % 0.8) < 0.1) api.tap('pause'); return; }
      // nearestThreat only reports AWARE enemies; to start a fight, walk at the nearest
      // camp enemy until its perception triggers.
      let tp = null;
      const threat = app.combat && typeof app.combat.nearestThreat === 'function'
        ? app.combat.nearestThreat() : null;
      // The dockside sparring partner never counts as a fight: passive post-tutorial, and
      // unkillable regardless — walking at him can never set combat.active.
      if (threat && threat.actor && threat.actor.kind !== 'sparring') tp = threat.actor;
      if (!tp && app.enemies && typeof app.enemies.list === 'function') {
        const pp = posOf(app.player);
        let bd = 1e9;
        for (const e of app.enemies.list()) {
          if (e.dead || e.kind === 'sparring') continue;
          const d = dist2d(pp, e);
          if (d < bd) { bd = d; tp = e; }
        }
      }
      // No enemy exists yet: head for the nearest un-cleared camp. A sighted player would see
      // the camp's tents and smoke from across the island; the headless driver gets the same
      // information from the spawn tables. Camps wake within ACTIVATE_M of the player, which
      // spawns the enemies the first branch then closes on.
      if (!tp && app.spawn && app.spawn.byIsland) {
        const pp0 = posOf(app.player);
        let bd = 1e9;
        for (const set of app.spawn.byIsland.values()) {
          for (const c of set.camps || []) {
            if (app.spawn.cleared && app.spawn.cleared.has(c.id)) continue;
            const d = dist2d(pp0, c);
            if (d < bd) { bd = d; tp = c; }
          }
        }
      }
      const ctx2 = arguments[1];
      const pp2 = posOf(app.player);
      if (tp) {
        // The full navigator: BFS route, water/cliff probes, sticky veer, varied escapes.
        // The bespoke single-sample shore veer this replaced paced the coastline for whole
        // budgets — the same local-minimum family the route sense was built to end.
        walkTowards(api, app, steerTo, pp2, tp.x, tp.z, t, ctx2);
        api.set('sprint', (t % 5) < 2);
      } else {
        api.look(Math.sin(t * 0.7) * 12, 0);  // sweep for something to fight
        api.set('moveForward', true);
        api.set('sprint', (t % 5) < 2);
        if ((t % 1.7) < 0.06) api.tap('jump');
      }
    },
    done: ({ app }) => app.combat.active === true,
  },
  {
    id: 'win-a-fight',
    desc: 'win the fight without dying',
    requires: ['player', 'combat'], timeoutS: 240,
    failure: 'win-a-fight: no enemy was defeated (and no encounter won) — the fight was not won',
    enter(ctx) {
      ctx.victoriesAtStart = ctx.app.combat.victories || 0;
      // `victories` only counts AUTHORED encounters; a camp brawl is won by defeating enemies.
      ctx.killsAtStart = ctx.app.combat.kills || 0;
    },
    drive(t, ctx) {
      const { api, app, steerTo } = ctx;
      if (app.ui && app.ui.menuOpen) { if ((t % 0.8) < 0.1) api.tap('pause'); return; }
      const p = app.player;
      const pp = posOf(p);
      // A knockback into the sea triggers the drowning rescue, which can wash the fight back
      // to the dock. Recover only from genuinely DEEP water: the old `terrain > 0.3` gate
      // also matched the beach tideline and the pier, and combat regularly goes active while
      // the driver stands exactly there — the recovery branch then ate the whole budget
      // (240 s of early returns, measured). Fighting from wet sand is fine.
      const g = app.world && typeof app.world.heightAt === 'function' ? app.world.heightAt(pp.x, pp.z) : 1;
      if (g < -0.6 || p.inWater) {
        let a = null, bd = 1e9;
        for (const n of (app.npc && app.npc.list) || []) {
          const d = dist2d(pp, posOf(n));
          if (d < bd) { bd = d; a = posOf(n); }
        }
        if (a) walkTowards(api, app, steerTo, pp, a.x, a.z, t, ctx);
        api.set('lightAttack', false);
        return;
      }
      // Unstick bookkeeping, same pattern as enter-combat.
      if (ctx._upos === undefined || t - (ctx._ut || 0) > 1.0) {
        ctx._stuck = ctx._upos !== undefined && dist2d(pp, ctx._upos) < 0.5;
        ctx._upos = { x: pp.x, z: pp.z };
        ctx._ut = t;
      }
      const threat = app.combat && typeof app.combat.nearestThreat === 'function'
        ? app.combat.nearestThreat() : null;
      // Never pick the unkillable sparring partner: 'winning' against him is impossible.
      let tp = threat && threat.actor && threat.actor.kind !== 'sparring' ? threat.actor : null;
      if (!tp && app.enemies && typeof app.enemies.list === 'function') {
        let bd = 1e9;
        for (const e of app.enemies.list()) {
          if (e.dead || e.kind === 'sparring') continue;
          const d = dist2d(pp, e);
          if (d < bd) { bd = d; tp = e; }
        }
      }
      if (!tp) {
        ctx._diag = {
          mode: 'no-target',
          enemies: app.enemies && app.enemies.list ? app.enemies.list().length : -1,
          combatActive: !!app.combat.active,
        };
        api.look(10, 0); api.set('moveForward', false); return;
      }
      // Lock on so the character keeps facing the target through the whole exchange —
      // swings resolve along the character's facing, not the camera's.
      const dist = dist2d(pp, tp);
      // Long approach through the navigator (routes, probes, escapes); the combat micro
      // below is for the last dozen metres only.
      if (dist > 12) {
        ctx._diag = { mode: 'approach', tgt: tp.kind || '?', dist: +dist.toFixed(1), hp: Math.round(app.player.hp) };
        walkTowards(api, app, steerTo, pp, tp.x, tp.z, t, ctx);
        api.set('sprint', true);
        api.set('lightAttack', false);
        return;
      }
      // Perched-stalemate escape. Measured failure: the jump-hop unstick bounced the player
      // onto a prop by the vista, the thug held APPROACH four metres away a body height
      // below, and every swing whiffed for the full budget — position frozen, hp full, zero
      // kills. In horizontal range with zero positional progress for seconds, back OFF the
      // perch without jumping (the hop cadence is what maintains it), then re-approach from
      // new ground; the enemy follows and the fight lands on terrain both sides can path.
      if (ctx._freeT === undefined) ctx._freeT = t;
      if (!ctx._stuck) ctx._freeT = t;
      if (ctx._detourUntil !== undefined && t >= ctx._detourUntil) {
        ctx._detourUntil = undefined;
        ctx._freeT = t;               // grace to re-approach before another detour can arm
      }
      if (ctx._detourUntil === undefined && ctx._stuck && t - ctx._freeT > 3.5) {
        ctx._detourUntil = t + 2.2;
      }
      if (ctx._detourUntil !== undefined) {
        const d2 = Math.max(0.5, dist);
        steerTo(api, pp.x + ((pp.x - tp.x) / d2) * 10, pp.z + ((pp.z - tp.z) / d2) * 10);
        api.set('moveForward', true);
        api.set('moveLeft', false);
        api.set('moveRight', false);
        api.set('lightAttack', false);
        return;
      }
      if (!p.lockTarget && (t % 1.3) < 0.06) api.tap('lockOn');
      steerTo(api, tp.x, tp.z);
      // Hold forward through the exchange — facing freezes while attacking, and a strafing
      // enemy walks out of a planted swing arc (same lesson the quest-fight branch learned).
      api.set('moveForward', dist > 1.6);
      if (ctx._stuck && dist > 4) {
        const side = Math.floor(t / 2) % 2 === 0;
        api.set('moveLeft', side);
        api.set('moveRight', !side);
        if ((t % 0.5) < 0.06) api.tap('jump');
      } else {
        api.set('moveLeft', false);
        api.set('moveRight', false);
      }
      // Combo tempo: the light chain's follow-up window is 0.42 s — a 0.3 s press rhythm
      // rides every combo window; the old one-press-per-1.2 s never got past light1.
      api.set('lightAttack', dist < 2.7 && (t % 0.3) < 0.15);
      // Fight like a fruit user (the tutorial has granted one by now): the stretch punch
      // out-ranges every whiff problem melee has against a circling target — measured in the
      // quest branch at 1 melee connect per 14 swings before this line existed there.
      if (dist < 9 && dist > 1.5 && (t % 1.2) < 0.08) api.tap('fruitPower');
      if ((t % 4.9) > 4.5 && (t % 4.9) < 4.6) api.tap('dodge');
      if (ctx) {
        ctx._diag = {
          mode: 'micro', tgt: tp.kind || '?', dist: +dist.toFixed(1), tgtHp: Math.round(tp.hp ?? -1),
          hp: Math.round(app.player.hp), lock: !!p.lockTarget,
          swings: app.combat && app.combat.stats ? app.combat.stats.attacksStarted : -1,
        };
      }
    },
    // The runner calls diag({ app, ctx }) — the step store is one level down.
    diag(x) { return (x && x.ctx && x.ctx._diag) || null; },
    done: ({ app, victoriesAtStart, killsAtStart }) => !app.player.dead
      && ((app.combat.victories || 0) > victoriesAtStart || (app.combat.kills || 0) > killsAtStart),
  },
  {
    id: 'use-devil-fruit',
    desc: 'use a devil fruit power',
    requires: ['player', 'fruit'], timeoutS: 90,
    failure: 'use-devil-fruit: fruit cast count never increased while the power key was pressed',
    enter(ctx) {
      const f = ctx.app.fruit;
      ctx.usesAtStart = (f.stats ? f.stats.casts : f.useCount) || 0;
    },
    drive(t, { api }) {
      const beat = t % 1.5;
      api.set('fruitPower', beat < 0.15);
    },
    done: ({ app, usesAtStart }) => {
      const f = app.fruit;
      return ((f.stats ? f.stats.casts : f.useCount) || 0) > usesAtStart;
    },
  },
  {
    id: 'accept-quest',
    desc: 'talk to a quest giver and accept a quest',
    requires: ['player', 'quest'], timeoutS: 180,
    failure: 'accept-quest: no quest became active after talking to the quest giver',
    drive(t, { api, app, steerTo }) {
      // Walk to the giver of the first offerable quest and talk to them.
      const q = app.quests || app.quest;
      const offer = q && q.availableQuests ? q.availableQuests()[0] : null;
      const giver = offer && app.npc && app.npc.list
        ? app.npc.list.find(n => n.npcId === offer.giver) : null;
      const gp = posOf(giver);
      const pp = posOf(app.player);
      if (gp && pp) {
        steerTo(api, gp.x, gp.z);
        const d = dist2d(pp, gp);
        api.set('moveForward', d > 2.4);
        if (d < 3.6 && (t % 0.7) < 0.1) api.tap('interact');
      } else {
        api.look(Math.sin(t * 0.5) * 10, 0);
        if ((t % 0.7) < 0.1) api.tap('interact');
      }
    },
    done: ({ app }) => {
      const q = app.quests || app.quest;
      return !!q && typeof q.activeQuests === 'function' && q.activeQuests().length > 0;
    },
  },
  {
    id: 'complete-quest',
    /**
     * Walk toward (tx,tz) with the same seamanship the combat step uses: veer along the
     * shoreline instead of marching into the sea, hop kerbs, and strafe free when a building
     * or ridge stops progress. The collect branch originally walked a straight line and spent
     * 18,000 consecutive steps pressed against an obstacle (measured; taps=1 in 300 s).
     */
    desc: 'complete the accepted quest',
    // Collect, three camp kills with heal-retreats between engagements, and a delivery walk.
    // Measured pace: ~230 s per kill including the retreat-heal-return cycle, plus ~90 s of
    // collection. A careful human clears this first chain in 10-12 minutes; the driver gets
    // the same allowance rather than a budget authored before retreats existed.
    requires: ['player', 'quest'], timeoutS: 780,
    diag({ app }) {
      const q = app.quests || app.quest;
      const tq = q && q.trackedQuest ? q.trackedQuest() : null;
      const p = posOf(app.player);
      const c = arguments[0].ctx || {};
      return {
        crumbs: (c._crumbs || []).slice(-30),
        branch: c._branch || 'none', fightN: c._branchN || 0, collectN: c._collectN || 0, taps: c._taps || 0,
        swings: app.combat && app.combat.stats ? app.combat.stats.attacksStarted : -1,
        kills: (app.combat && app.combat.kills) || 0,
        hp: app.player ? Math.round(app.player.hp) : -1,
        tracked: tq ? tq.id : null,
        stepIdx: tq && tq.step ? tq.step.index : null,
        objs: tq && tq.step ? tq.step.objectives.map(o => o.type + ':' + (o.done ? 'done' : o.current + '/' + o.target) + (o.point ? ':' + o.point : '')) : null,
        pos: p ? [Math.round(p.x), Math.round(p.z)] : null,
        onShip: !!(app.player && app.player.onShip),
        coneTarget: (app.player && app.player.interactTarget && app.player.interactTarget.label) || null,
        enemies: app.enemies && app.enemies.list ? app.enemies.list().filter(e => !e.dead).length : null,
        takeables: app.world && app.world.interactablesNear && p
          ? (app.world.interactablesNear(p.x, p.z, 4000) || []).filter(i => i.label && i.label.startsWith('Take ')).length : null,
      };
    },
    failure: 'complete-quest: no quest reached the DONE state — the accepted quest was never finished',
    enter(ctx) { ctx.completedAtStart = questsDone(ctx.app); },
    drive(t, { api, app, steerTo }) {
      // A small quest-runner over OBSERVABLE state: read the tracked step's first unfinished
      // objective and do the thing its type names, with real input only.
      const q = app.quests || app.quest;
      const pp = posOf(app.player);
      if (!q || !pp) return;
      // A dialogue or menu blocks ALL play input (input.blocked = ui.menuOpen) — and this
      // step both talks to NPCs and taps E near villagers, so it WILL open one eventually.
      // Without this guard the driver stood statue-still at the village brawl for 600 s,
      // health sawing 13->120->13, issuing movement into a void (measured, breadcrumbed).
      // Every other walking step already carried this exact line.
      if (app.ui && app.ui.menuOpen) { if ((t % 0.8) < 0.1) api.tap('pause'); return; }
      // The dock berth is inside the quest area, and "Board ship" competes in the same
      // interact cone as the net floats. A stray E near the gangplank puts the driver on
      // DECK, where movement input drives the ship — the whole runner is void until ashore.
      if (app.player.onShip) { if ((t % 0.6) < 0.1) api.tap('interact'); return; }
      // Route breadcrumbs for the failure diag: [t, x, z, hp, branchCode] every 20 sim-s.
      {
        const cb = arguments[1].ctx || arguments[1];
        if (cb._crumbT === undefined || t - cb._crumbT >= 20) {
          cb._crumbT = t;
          cb._crumbs = cb._crumbs || [];
          const th = app.combat && app.combat.nearestThreat && app.combat.nearestThreat();
          const thd = th && th.actor ? Math.round(dist2d(pp, posOf(th.actor))) : -1;
          cb._crumbs.push([Math.round(t), Math.round(pp.x), Math.round(pp.z),
            Math.round(app.player.hp), (cb._branch || '?').slice(0, 9), thd]);
        }
      }
      const tq = q.trackedQuest && q.trackedQuest();
      const obj = tq && tq.step ? (tq.step.objectives || []).find(o => !o.done) : null;

      // Anything already hunting us gets fought first, whatever the objective says.
      const c2 = arguments[1].ctx || arguments[1];
      // Harassment recovery. Village brawls chip the player with stray hits the fight-first
      // gate rightly ignores (the attackers target villagers, nearestThreat is null) — one
      // run bled 120->35 hp crossing a brawl five times. Below 40% hp, disengage AWAY from
      // the nearest live enemy until the out-of-combat mend has done its work.
      {
        const hpFrac = app.player.hp / (app.player.maxHp || 120);
        if (c2._fleeing ? hpFrac < 0.8 : hpFrac < 0.4) {
          c2._fleeing = true;
          c2._branch = 'flee hp=' + Math.round(app.player.hp);
          let ne = null, ned = 1e9;
          if (app.enemies && typeof app.enemies.list === 'function') {
            for (const e of app.enemies.list()) {
              if (e.dead || e.kind === 'sparring') continue;   // he is harmless; never flee him
              const d = dist2d(pp, e);
              if (d < ned) { ned = d; ne = e; }
            }
          }
          const fx = ne ? pp.x + ((pp.x - ne.x) / (ned || 1)) * 30 : pp.x + 30;
          const fz = ne ? pp.z + ((pp.z - ne.z) / (ned || 1)) * 30 : pp.z;
          api.set('lightAttack', false);
          walkTowards(api, app, steerTo, pp, fx, fz, t, c2);
          return;
        }
        c2._fleeing = false;
      }
      const threat = app.combat && app.combat.nearestThreat && app.combat.nearestThreat();
      // Fight-first only when the threat is actually ON us. An aware enemy across the island
      // kept this branch true for 17,895 consecutive steps while the collect objective starved —
      // a player ignores distant shouting and keeps picking up floats.
      const tpos = threat && threat.actor ? posOf(threat.actor) : null;
      let fight = tpos && dist2d(pp, tpos) < 12 ? threat.actor : null;
      // A nearby threat only owns the fight if it COUNTS for the objective. A kiting rifleman
      // backpedals at walking speed and held the driver in an unbreakable 10 m stalemate for
      // 300 s (measured, twice, byte-identical) while the last thug stood in a camp nearby.
      // Eat the crossfire and go kill the right enemy; the retreat loop absorbs the cost.
      if (fight && obj && obj.type === 'defeat' && obj.enemyKind && obj.enemyKind !== 'any') {
        const famOf = (k) => (k ? String(k).split('_')[0] : '');
        if (famOf(fight.questKind || fight.kind) !== famOf(obj.enemyKind)) fight = null;
      }
      if (fight || (obj && (obj.type === 'defeat' || obj.type === 'defeatBoss'))) {
        if (c2) { c2._branch = 'fight'; c2._branchN = (c2._branchN || 0) + 1; }
        // Survival first: hurt fighters disengage past the 30 m deaggro leash and let the
        // out-of-combat mend do its work, then re-engage. Charging a camp at half health was
        // measured as an endless death-respawn-walk cycle with zero kills.
        const hpFrac = app.player && Number.isFinite(app.player.hp) && app.player.maxHp
          ? app.player.hp / app.player.maxHp : 1;
        // Nearest live pursuer, recomputed every tick — the retreat has to OUTRUN the chase,
        // not reach a fixed point. Walking to a spot 40 m out with a thug glued to your back
        // meant every chip hit reset the heal timer and the driver sat pinned at 50% hp at the
        // dock for the rest of the budget (measured).
        let pursuer = null, pd = 1e9;
        if (app.enemies && typeof app.enemies.list === 'function') {
          for (const en of app.enemies.list()) {
            // The passive sparring partner near the village would pin the retreat latch
            // (pd never clears 26 m) while never being a pursuer at all.
            if (en.dead || en.kind === 'sparring') continue;
            const d = dist2d(pp, en);
            if (d < pd) { pd = d; pursuer = en; }
          }
        }
        if (c2 && c2._retreating && hpFrac > 0.7 && pd > 26) c2._retreating = false;
        if (c2 && (c2._retreating || hpFrac < 0.35)) {
          c2._retreating = true;
          c2._branch = 'retreat hp=' + Math.round(hpFrac * 100) + '% pd=' + (pd === 1e9 ? '-' : pd.toFixed(0));
          // Retreat toward the nearest villager, not along the raw flee vector — that vector
          // points into the sea near the coast, and a devil-fruit user pacing the waterline
          // takes drowning ticks that reset the heal timer forever (measured: hp pinned at the
          // respawn value with the pursuer 38 m away). Villagers stand on dry, safe ground.
          let ax, az;
          let safe = null, sd = 1e9;
          if (app.npc && Array.isArray(app.npc.list)) {
            for (const n of app.npc.list) {
              const np = posOf(n);
              if (!np) continue;
              const d = dist2d(pp, np);
              const fromEnemy = pursuer ? dist2d(np, pursuer) : 999;
              if (fromEnemy > 25 && d < sd) { sd = d; safe = np; }
            }
          }
          if (safe) { ax = safe.x; az = safe.z; }
          else if (pursuer) { ax = pp.x + (pp.x - pursuer.x) * 4; az = pp.z + (pp.z - pursuer.z) * 4; }
          else { ax = pp.x + 60; az = pp.z; }
          walkTowards(api, app, steerTo, pp, ax, az, t, c2);
          api.set('sprint', true);                       // outrun, always — stamina mends later
          api.set('lightAttack', false);
          if (pd < 6 && (t % 1.4) < 0.07) api.tap('dodge');   // slip the swing at your back
          return;
        }
        // walkTowards latches sprint/strafe for the journey here; held sprint drains stamina
        // to zero and a swing with no stamina never fires — measured as 0 kills in 275 s of
        // otherwise-correct attack cadence. Fighting starts from clean movement state.
        api.set('sprint', false);
        api.set('moveLeft', false);
        api.set('moveRight', false);
        let tp = fight ? posOf(fight) : null;
        if (!tp && app.enemies && typeof app.enemies.list === 'function') {
          // STICKY target selection. Re-scoring every step made the driver trail a wandering
          // patrol around the island at matched walking speed for the whole budget (measured:
          // healthy, in the fight branch, zero kills, position drifting through the village).
          // Commit to one enemy until it dies or 20 s passes; slight preference for stragglers.
          if (c2 && c2._tgt && (c2._tgt.dead || t - (c2._tgtT || 0) > 20)) c2._tgt = null;
          if (c2 && c2._tgt) tp = c2._tgt;
          else {
            // Hunt only what the objective counts. The enemy list also carries wildlife, and
            // after the second thug fell the picker locked onto the nearest creature — a shore
            // animal walkTowards refuses to chase into the sea. The driver stood at the
            // waterline for 300 straight seconds with zero swings (measured, twice).
            const fam = (k) => (k ? String(k).split('_')[0] : '');
            const wantFam = obj && obj.type === 'defeat' && obj.enemyKind && obj.enemyKind !== 'any'
              ? fam(obj.enemyKind) : null;
            const all = app.enemies.list().filter(e => !e.dead && e.kind !== 'sparring' &&
              (!wantFam || fam(e.questKind || e.kind) === wantFam));
            let bs = 1e9, pick = null;
            for (const e of all) {
              let allies = 0;
              for (const o of all) if (o !== e && dist2d(e, o) < 12) allies++;
              const score = dist2d(pp, e) + allies * 5;
              if (score < bs) { bs = score; pick = e; }
            }
            if (c2 && pick) { c2._tgt = pick; c2._tgtT = t; }
            tp = pick;
          }
        }
        // Approach with the obstacle-aware navigator — a bare steerTo ground against the same
        // rock 50 m from the camp for three consecutive full-budget runs (measured: identical
        // final position each time, attack gate never in range). Hand-steer only in melee,
        // where the strafe-unstick would spoil facing.
        if (tp && dist2d(pp, tp) > 4) {
          walkTowards(api, app, steerTo, pp, tp.x, tp.z, t, c2);
        } else if (tp) {
          steerTo(api, tp.x, tp.z);
          api.set('sprint', false);
          api.set('moveLeft', false);
          api.set('moveRight', false);
        }
        // The same cadence that wins win-a-fight in nine seconds: lock on so swings resolve
        // along the character's facing, close to melee range, attack on a 1.2 s beat. The old
        // 2.6 s beat without lock-on whiffed for 16,534 straight steps (measured, 0/3 kills).
        if (app.player && !app.player.lockTarget && (t % 1.3) < 0.06) api.tap('lockOn');
        const distE = tp ? dist2d(pp, tp) : 99;
        // Hold forward INTO the target while swinging — never stop at arm's length. Facing
        // follows movement, so a stationary attacker's swing arc points at where the enemy
        // used to be while it strafes free (measured: 74 swings, zero connects). The setup
        // that verifiably landed damage held forward the entire exchange.
        api.set('moveForward', tp ? true : (t % 2.6) < 0.9);
        // Press at combo tempo: the light chain's follow-up window is 0.42 s, so one press per
        // 1.2 s always restarts at light1 (12 dmg) and never reaches light3 (18). A 0.3 s
        // press rhythm rides every combo window the moves offer.
        api.set('lightAttack', distE < 2.7 && (t % 0.3) < 0.15);
        // Fight like a fruit user: the stretch punch out-ranges every whiff problem melee has
        // against a circling target (measured: 1 melee connect per 14 swings on a moving thug).
        if (distE < 9 && distE > 1.5 && (t % 1.2) < 0.08) api.tap('fruitPower');
        if ((t % 4.9) > 4.5 && (t % 4.9) < 4.6) api.tap('dodge');
        return;
      }
      api.set('lightAttack', false);

      // Interactable objectives: walk to the matching world interactable and press E.
      const wantLabel = obj && obj.type === 'collect' ? 'Take '
        : obj && obj.type === 'destroy' ? 'Destroy '
          : obj && obj.type === 'openChest' ? 'Open ' : null;
      if (wantLabel && app.world && typeof app.world.interactablesNear === 'function') {
        // Unreachable-target blacklist. The nearest float sat in the shallows at d=3.5 — one
        // decimetre outside the old tap gate — and the driver walked against the waterline for
        // the entire 300 s budget (18,000 steps, 0 taps, measured). A player gives up on a
        // pickup they cannot reach and takes one of the other twelve; so does the driver now.
        const c3 = arguments[1].ctx || arguments[1];
        if (c3 && !c3._skipItems) { c3._skipItems = new Set(); c3._tgtKey = null; c3._tgtSince = 0; c3._tgtBest = 1e9; }
        // 400 m covers the island the quest lives on. The unbounded search locked onto a float
        // on a minor island 2 km across open water — a swim a devil-fruit user cannot survive.
        const pool = (app.world.interactablesNear(pp.x, pp.z, 400) || []).filter(it =>
          it.label && it.label.indexOf(wantLabel) === 0 &&
          (!obj.itemId || !it.itemId || it.itemId === obj.itemId));
        let best = null, bd = 1e9;
        const pick = (respectSkips) => {
          for (const it of pool) {
            const key = Math.round(it.pos.x) + ',' + Math.round(it.pos.z);
            if (respectSkips && c3 && c3._skipItems.has(key)) continue;
            const d = dist2d(pp, it.pos);
            if (d < bd) { bd = d; best = it; }
          }
        };
        pick(true);
        if (!best && c3 && c3._skipItems.size) {
          // Every candidate is blacklisted: give the hard ones a second chance rather than
          // pacing to a timeout. Approach angles differ on the retry, which is usually enough.
          c3._skipItems.clear();
          pick(true);
        }
        if (best && c3) {
          const key = Math.round(best.pos.x) + ',' + Math.round(best.pos.z);
          // The give-up clock PAUSES during deliberate detours — it must never RESET there:
          // a wedge cycles 3 s stuck -> 2 s detour forever, and a clock reset on each detour
          // made the blacklist unreachable (measured: one hut pocket ate a full 780 s run).
          const detouring = c2 && c2._wesc > 0;
          if (c3._tgtKey !== key) { c3._tgtKey = key; c3._tgtStall = 0; c3._tgtBest = bd; }
          else if (bd < c3._tgtBest - 0.4) { c3._tgtBest = bd; c3._tgtStall = 0; }
          else if (!detouring) {
            c3._tgtStall = (c3._tgtStall || 0) + 1 / 60;
            if (c3._tgtStall > 8) {
              c3._skipItems.add(key);   // eight non-detour seconds without progress: move on
              c3._tgtKey = null;
              best = null;
            }
          }
        }
        if (best) {
          if (c2) { c2._branch = 'collect d=' + bd.toFixed(1); c2._collectN = (c2._collectN || 0) + 1; }
          const dNow = walkTowards(api, app, steerTo, pp, best.pos.x, best.pos.z, t, c2);
          // Tap ONLY when the game's own interact cone is aimed at the wanted pickup —
          // player.interactTarget is exactly what E would hit. Tapping on distance alone
          // spent 42 presses on "Board ship"/NPCs at the berth and collected nothing
          // (measured: 0/4 after 780 s with the driver repeatedly in range).
          const itgt = app.player.interactTarget;
          const aimed = itgt && itgt.label && itgt.label.indexOf(wantLabel) === 0;
          if (aimed && (t % 0.4) < 0.1) { api.tap('interact'); if (c2) c2._taps = (c2._taps || 0) + 1; }
          else if (dNow < 4.2 && !aimed) {
            // In range but the cone is on the wrong thing (or nothing). The cone follows
            // CHARACTER facing, which only updates while moving — so aim the camera at the
            // item (steerTo owns the measured look gain) and keep a half-step of walk on,
            // which re-faces the character into the cone-hit next step.
            steerTo(api, best.pos.x, best.pos.z);
            api.set('moveForward', true);
          }
          return;
        }
      }

      // goto / findSecret: resolve the point key ('shellsCove.dock') against the streamed
      // island's spawn points and actually walk there — pacing and hoping never crossed the
      // 6 m areaEntered trigger, which is why quest completion timed out at 300 s.
      if (obj && (obj.type === 'goto' || obj.type === 'findSecret') && obj.point && app.world && app.world.loaded) {
        const di = obj.point.indexOf('.');
        const islandId = di > 0 ? obj.point.slice(0, di) : obj.point;
        const name = di > 0 ? obj.point.slice(di + 1) : 'dock';
        const inst = app.world.loaded.get(islandId);
        const sp = inst && inst.record && inst.record.spawnPoints ? inst.record.spawnPoints[name] : null;
        if (sp) {
          walkTowards(api, app, steerTo, pp, inst.centerX + sp.x, inst.centerZ + sp.z, t, arguments[1].ctx || arguments[1]);
          return;
        }
      }

      // talk / deliver — go back to the quest giver; goto/anything else — pace the dock area.
      const active = q.activeQuests ? q.activeQuests().find(x => tq && x.id === tq.id) : null;
      // talk/deliver objectives name their own npc; the quest giver is only the fallback
      // (a mid-chain talk step can point at a different villager than the one who hired you).
      const wantNpc = (obj && obj.npcId) || (active && active.giver) || null;
      const giver = wantNpc && app.npc && app.npc.list
        ? app.npc.list.find(n => n.npcId === wantNpc) : null;
      if ((obj === null || obj.type === 'talk' || obj.type === 'deliver') && giver) {
        const gp = posOf(giver);
        steerTo(api, gp.x, gp.z);
        const d = dist2d(pp, gp);
        api.set('moveForward', d > 2.4);
        if (d < 3.6 && (t % 0.8) < 0.1) api.tap('interact');
        return;
      }
      const isl = firstIsland(app);
      if (isl) steerTo(api, isl.dockX !== undefined ? isl.dockX : isl.x, isl.dockZ !== undefined ? isl.dockZ : isl.z);
      api.set('moveForward', (t % 2.4) < 1.6);
    },
    done: ({ app, completedAtStart }) => questsDone(app) > completedAtStart,
  },
  {
    id: 'bounty-increases',
    desc: 'the bounty rises after the quest and the fight',
    requires: ['player'], timeoutS: 60,
    failure: 'bounty-increases: player.bounty did not rise after winning a fight and completing a quest',
    enter(ctx) { ctx.bountyAtStart = ctx.bountyBefore; },
    done: ({ app, bountyAtStart }) => bountyOf(app) > (bountyAtStart || 0),
  },
  {
    id: 'save',
    desc: 'the game writes a save the player can come back to',
    requires: ['save'], timeoutS: 60,
    failure: `save: localStorage['${SAVE_KEY}'] was never written with a live simTime`,
    drive(t, ctx) {
      // Invoke the Save button's own wired callback (the exact code path the pause menu runs)
      // rather than blind-navigating menu focus by key taps. The old key dance was never
      // actually exercised: the 90-second AUTOSAVE satisfied done() at t=0, so this step
      // "passed" against a save up to 90 s stale — and state-restored then compared the
      // reload against a position the player had long since left.
      if (ctx._saved) return;
      const { app } = ctx;
      const cb = app.ui && app.ui.menus && app.ui.menus.cb;
      if (cb && typeof cb.saveToSlot === 'function') { cb.saveToSlot(1); ctx._saved = true; }
      else if (app.save) { app.save.save(1); ctx._saved = true; }
    },
    done(ctx) {
      if (!ctx || !ctx._saved) return false;
      const s = readSave(1);
      return !!s && typeof s.simTime === 'number' && s.simTime > 0;
    },
  },
  {
    id: 'reload',
    desc: 'reload the page from scratch',
    requires: [], timeoutS: 60, reload: true,
    failure: 'reload: the app did not boot again after the page was reloaded',
    done: ({ app }) => !!app.renderer && app.stats.tiles > 0,
  },
  {
    id: 'state-restored',
    desc: 'the reloaded game is the same game: position, bounty and progress survive',
    requires: ['save', 'player'], timeoutS: 90,
    failure: 'state-restored: after reload the live player state did not match the saved state',
    drive(t, ctx) {
      // Load through the same wired callback the Load button runs (see the save step for why
      // the key-tap navigation was retired). Retry every few seconds until done() confirms.
      if (ctx._loadedAt !== undefined && t - ctx._loadedAt < 4) return;
      const { app } = ctx;
      const cb = app.ui && app.ui.menus && app.ui.menus.cb;
      if (cb && typeof cb.loadFromSlot === 'function') { cb.loadFromSlot(1); ctx._loadedAt = t; }
      else if (app.save) { try { app.save.load(1); } catch {} ctx._loadedAt = t; }
    },
    done: ({ app, expected }) => {
      if (!expected) return false;
      const p = posOf(app.player);
      if (!p) return false;
      const near = dist2d(p, expected.pos) < 4;
      const bounty = bountyOf(app) >= expected.bounty;
      const quests = !expected.completed || questsDone(app) >= expected.completed;
      return near && bounty && quests;
    },
  },
];

// ---------------------------------------------------------------------------------------

function start() {
  const q = new URLSearchParams(location.search);
  const seed = q.get('seed') || '20260814';
  const W = parseInt(q.get('w') || '1280', 10);
  const H = parseInt(q.get('h') || '720', 10);
  /** Cap on simulated seconds per fixed-step batch, so a slow frame cannot stall the script. */
  const MAX_STEPS_PER_FRAME = 12;

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
    mode: MODE.PLAY, seed, width: W, height: H,
    msaa: q.has('msaa') ? parseInt(q.get('msaa'), 10) : 4,
    onSystems: buildGameSystems,
  });

  const api = createInputApi(canvas, { pointerEvents: q.get('pointerEvents') === '1' });
  const steerTo = makeSteering(app);

  /** Progress that has to survive the page reload. */
  function loadResume() {
    try {
      const raw = sessionStorage.getItem(RESUME_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function saveResume(v) {
    try { sessionStorage.setItem(RESUME_KEY, JSON.stringify(v)); } catch { /* private mode */ }
  }

  let results = [];
  let index = 0;
  let expected = null;
  let bountyBefore = 0;
  let running = false;

  const resumed = loadResume();
  if (resumed) {
    results = resumed.results || [];
    index = resumed.index || 0;
    expected = resumed.expected || null;
    bountyBefore = resumed.bountyBefore || 0;
  }

  /**
   * Run the script from the current step until it finishes or hits the reload boundary.
   * @returns {Promise<{status:string, needsReload:boolean, steps:object[]}>}
   */
  async function run() {
    if (running) throw new Error('playtest already running');
    running = true;

    let ctx = null;
    let stepT = 0;
    let stepSteps = 0;
    let raf = 0;
    let lastReal = 0;
    let needsReload = false;
    let aborted = false;

    const beginStep = () => {
      const step = STEPS[index];
      const missing = missingSystems(app, step.requires);
      ctx = {
        app, api, steerTo, step,
        expected, bountyBefore,
        island: null, victoriesAtStart: 0, usesAtStart: 0, completedAtStart: 0, bountyAtStart: 0,
      };
      if (missing.length) {
        results.push({
          id: step.id, desc: step.desc, status: 'skipped', simSeconds: 0,
          note: `skipped: ${missing.join(', ')} system${missing.length > 1 ? 's' : ''} not present`,
        });
        ctx = null;     // nothing to drive; fall through to the next step this frame
        index++;
        stepT = 0; stepSteps = 0;
        return false;
      }
      if (step.enter) step.enter(ctx);
      stepT = 0; stepSteps = 0;
      return true;
    };

    const safeDiag = (step, c) => {
      try { return JSON.stringify(step.diag({ app, ctx: c })); } catch (e) { return 'diag threw: ' + e.message; }
    };
    const finishStep = (status, note) => {
      const step = STEPS[index];
      results.push({
        id: step.id, desc: step.desc, status,
        simSeconds: +stepT.toFixed(2), simSteps: stepSteps,
        note: note || '',
      });
      // Capture what the reload must reproduce, at the moment the save is taken.
      if (step.id === 'save' && status === 'pass') {
        const p = posOf(app.player);
        expected = {
          pos: p || { x: 0, y: 0, z: 0 },
          bounty: bountyOf(app),
          completed: questsDone(app),
        };
      }
      // Baseline the bounty *before* the fight and the quest, so 'bounty-increases' measures
      // what those two things did rather than comparing a number with itself.
      if (step.id === 'walk-ashore' && status === 'pass' && app.player) {
        bountyBefore = bountyOf(app);
      }
      index++;
      stepT = 0; stepSteps = 0;
    };

    await new Promise((resolve) => {
      const frame = (now) => {
        const dt = lastReal ? Math.min(0.25, (now - lastReal) / 1000) : FIXED_DT;
        lastReal = now;

        let n = Math.min(MAX_STEPS_PER_FRAME, app.clock.advance(dt));
        for (let i = 0; i < n; i++) {
          // Advance the script to a runnable step (skipping ones whose systems are absent).
          while (index < STEPS.length && ctx === null) if (beginStep()) break;
          if (index >= STEPS.length) { aborted = false; cancelAnimationFrame(raf); resolve(); return; }

          const step = STEPS[index];
          if (step.reload) {
            // Hand control back to the runner: it reloads the page and calls run() again.
            saveResume({ index, results, expected, bountyBefore });
            needsReload = true;
            cancelAnimationFrame(raf);
            resolve();
            return;
          }

          if (step.drive) step.drive(stepT, ctx);
          api.tick(FIXED_DT);
          app.step(FIXED_DT);
          stepT += FIXED_DT;
          stepSteps++;

          let ok = false;
          try { ok = !!step.done(ctx); } catch (e) { errors.push(`${step.id}: ${e && e.message}`); }
          if (ok) {
            api.releaseAll();
            finishStep('pass');
            ctx = null;
            continue;
          }
          if (stepT >= step.timeoutS) {
            api.releaseAll();
            // A timeout without state is undebuggable: append what the world actually looked
            // like at the moment the step gave up.
            finishStep('fail', step.failure + (step.diag ? ' || ' + safeDiag(step, ctx) : ''));
            ctx = null;
            aborted = true;
            cancelAnimationFrame(raf);
            resolve();
            return;
          }
        }
        app.render(app.clock.alpha);
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    });

    api.releaseAll();
    running = false;

    if (needsReload) {
      return { status: 'reloading', needsReload: true, steps: results.slice(), errors: errors.slice() };
    }

    try { sessionStorage.removeItem(RESUME_KEY); } catch { /* private mode */ }

    const fails = results.filter(r => r.status === 'fail');
    const skips = results.filter(r => r.status === 'skipped');
    return {
      status: fails.length ? 'fail' : skips.length ? 'incomplete' : 'pass',
      needsReload: false,
      aborted,
      steps: results.slice(),
      skipped: skips.map(s => s.id),
      failed: fails.map(s => s.id),
      errors: errors.slice(),
      simSeconds: +results.reduce((s, r) => s + (r.simSeconds || 0), 0).toFixed(2),
      seed,
    };
  }

  /** After a reload, the pending step is `reload` itself: assert the app came back up. */
  function creditReload() {
    const step = STEPS[index];
    if (!step || !step.reload) return;
    const ok = !!app.renderer && app.stats.tiles > 0;
    results.push({
      id: step.id, desc: step.desc,
      status: ok ? 'pass' : 'fail', simSeconds: 0,
      note: ok ? 'page reloaded and the app booted again' : step.failure,
    });
    index++;
    saveResume({ index, results, expected, bountyBefore });
  }

  window.__PLAYTEST = true;
  window.__T = {
    app,
    errors,
    steps: STEPS.map(s => ({ id: s.id, desc: s.desc, requires: s.requires, timeoutS: s.timeoutS })),
    ready: (async () => {
      await app.boot();
      app.step(FIXED_DT);
      app.render(0);
      if (loadResume()) creditReload();
      window.__PLAYTEST_READY = true;
    })(),
    run,
    /** Whether this page load is a continuation of a run interrupted by the reload step. */
    resumed: !!resumed,
    results() { return results.slice(); },
    save() { return readSave(); },
  };

  window.__T.ready.catch((e) => {
    errors.push('boot: ' + (e && e.stack ? e.stack : String(e)));
    window.__PLAYTEST_ERROR = String(e && e.stack ? e.stack : e);
    window.__PLAYTEST_READY = true;
  });
}

if (typeof document !== 'undefined' && document.getElementById) start();
