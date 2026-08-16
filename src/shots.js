// The shot list. One entry per deterministic screenshot the harness captures.
//
// A shot is a pure function of (app, seed): it seeks the world to an exact state, positions
// the camera, and returns. The harness runs each shot in a FRESH page so state cannot leak.
//
// Rules for a shot:
//  - never read wall time
//  - never depend on a previous shot
//  - always `app.simulate(seconds)` to a fixed sim time rather than waiting
//  - set `app.timeFrozen = true` and an explicit `dayT` so lighting is exact

import * as THREE from 'three';

/**
 * Take the camera away from gameplay for the rest of this shot.
 *
 * `app.cameraOverride = true` is the documented flag and it is set here, but on its own it does
 * not hold. src/game.js wraps the follow camera as
 *   `gc.preRender = (alpha, a) => { prev(alpha, a); if (!app.cameraOverride) gc.applyTo(...) }`
 * where `prev` is GameCamera.preRender, which applies the follow transform *unconditionally*.
 * So the guard only skips a second application, and every shot was silently re-framed onto the
 * player on the frame it rendered — measured: `game-island-approach` asked for a camera 98 m
 * offshore at y=40 with fov 58 and rendered from y=6.7 behind the player at fov 62.
 *
 * Until game.js drops that first call, a shot has to unhook the follow camera itself. Both
 * halves are done here so that no shot can remember one and forget the other.
 * @param {object} app
 */
export function takeCamera(app) {
  app.cameraOverride = true;
  const gc = app.gameCamera;
  if (gc && !gc.__shotDetached) {
    gc.__shotDetached = true;
    gc.preRender = () => {};
  }
  return app.camera;
}

/** Aim the camera at a point from a spherical offset. Keeps shot framing declarative. */
function look(app, from, at, fov) {
  takeCamera(app);
  app.camera.position.set(from[0], from[1], from[2]);
  app.camera.lookAt(at[0], at[1], at[2]);
  if (fov) { app.camera.fov = fov; app.camera.updateProjectionMatrix(); }
}

/**
 * A patch of the Grand Line with nothing in it, for the shots that are only about sky and water.
 *
 * The four ocean shots used to be staged at the world origin, which is exactly where the game
 * parks the player's ship — so once the game was assembled they stopped being pictures of the
 * open sea and became pictures of the inside of a hull. Verified empty for 800 m in every
 * direction at this seed by the game-storm-sea capture.
 */
const OPEN_SEA = { x: -4260, z: 1550 };

/**
 * Stage a sky-and-water shot on empty ocean and settle it there.
 *
 * The streaming focus follows the player, so the player has to be *at* the shot, not merely
 * out of frame; and re-asserting every half second is what stops swimming and the current from
 * dragging them somewhere else over the twenty seconds these shots simulate. The ship is sent
 * a kilometre downwind, which is well past the horizon at this eye height.
 * @returns {{x:number, z:number}} the world offset every camera point in the shot is relative to
 */
function seaStage(app, seconds) {
  const O = OPEN_SEA;
  const put = () => {
    const p = app.player;
    if (p && p.pos) {
      p.pos.set(O.x, 2, O.z);
      if (p.prevPos && p.prevPos.set) p.prevPos.set(O.x, 2, O.z);
      if (p.vel && p.vel.set) p.vel.set(0, 0, 0);
    }
    const b = app.ship && app.ship.body;
    if (b) {
      b.pos.x = O.x; b.pos.z = O.z + 1000;
      if (b.vel) { b.vel.x = 0; b.vel.y = 0; b.vel.z = 0; }
    }
  };
  const n = Math.max(1, Math.round(seconds / 0.5));
  for (let i = 0; i < n; i++) { put(); app.simulate(0.5); }
  put();
  app.simulate(2 / 60);
  return O;
}

/**
 * @typedef {{id:string, desc:string, tags:string[], setup:(app:any)=>Promise<void>|void}} Shot
 */

/** @type {Shot[]} */
export const SHOTS = [
  {
    id: 'ocean-noon',
    desc: 'Open ocean at noon. Judges water colour, wave silhouette, horizon and sky gradient.',
    tags: ['water', 'sky', 'horizon'],
    setup(app) {
      app.timeFrozen = true;
      app.dayT = 0.5;
      app.setWeather('breezy', true);
      const O = seaStage(app, 20);
      look(app, [O.x, 9.0, O.z], [O.x + 46, -6.0, O.z + 46], 62);
    },
  },
  {
    id: 'ocean-golden',
    desc: 'Golden hour over open water looking into the sun. Judges tone map highlight rolloff and glitter.',
    tags: ['water', 'sky', 'tonemap'],
    setup(app) {
      app.timeFrozen = true;
      app.dayT = 0.285;
      app.setWeather('clear', true);
      const O = seaStage(app, 20);
      const s = app.sky.update(app.dayT, app.clock.simTime);
      look(app, [O.x, 9.0, O.z],
        [O.x + s.sunDir.x * 120, 2.0, O.z + s.sunDir.z * 120], 62);
    },
  },
  {
    id: 'ocean-storm',
    desc: 'Storm sea state. Judges wave amplitude, foam, desaturated grade and readability in bad weather.',
    tags: ['water', 'weather'],
    setup(app) {
      app.timeFrozen = true;
      app.dayT = 0.42;
      app.setWeather('storm', true);
      const O = seaStage(app, 30);
      look(app, [O.x, 10, O.z], [O.x + 50, -8, O.z + 50], 62);
    },
  },
  {
    id: 'ocean-night',
    desc: 'Night sea. Judges that silhouettes still read and shadows never crush to black.',
    tags: ['water', 'sky', 'night'],
    setup(app) {
      app.timeFrozen = true;
      app.dayT = 0.92;
      app.setWeather('clear', true);
      const O = seaStage(app, 20);
      look(app, [O.x, 9, O.z], [O.x + 45, -4, O.z + 45], 62);
    },
  },
];

/** Shots contributed by systems that only exist after Phase 1. Registered at import time. */
export function registerShot(shot) {
  const i = SHOTS.findIndex(s => s.id === shot.id);
  if (i >= 0) SHOTS[i] = shot; else SHOTS.push(shot);
}

export function getShot(id) {
  return SHOTS.find(s => s.id === id) || null;
}

export function shotIds() {
  return SHOTS.map(s => s.id);
}
