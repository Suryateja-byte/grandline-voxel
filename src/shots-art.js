// Art-direction shots. These exist to be compared, blind, against reference/ART_BAR.md.
// They deliberately use gameplay-representative camera framing, not beauty angles.

import * as THREE from 'three';
import { registerShot, takeCamera } from './shots.js';
import { CHARACTER_SPECS, buildCharacter } from './gen/charmodel.js';
import { buildBlocks } from './gen/blocks.js';
import { preparePropBlocks, registerPropTiles } from './gen/props.js';
import * as PROPS from './gen/props.js';
import { meshVolume } from './gen/voxel.js';
import { Rng } from './core/rng.js';

/** Stand a built character at (x,z) facing the camera. Parts are placed by their own origins. */
function placeCharacter(app, built, x, y, z, yaw) {
  const g = new THREE.Group();
  for (const key of Object.keys(built.parts)) {
    const part = built.parts[key];
    if (!part || !part.geometry) continue;
    const m = new THREE.Mesh(part.geometry, app.materials.actor);
    // buildCharacter bakes the origin-minus-pivot offset into the geometry, so the mesh sits at
    // the pivot; placing the pivot is all that is left.
    m.position.set(part.pivot[0], part.pivot[1], part.pivot[2]);
    m.name = key;
    g.add(m);
  }
  g.position.set(x, y, z);
  g.rotation.y = yaw;
  app.rootActors.add(g);
  return g;
}

/**
 * A small island the characters stand on. Its TOP is at y = GROUND_Y, comfortably above the
 * wave crests — the first version put the deck below sea level and the ocean swallowed
 * everyone's legs, which reads as a character bug rather than a staging bug.
 */
export const GROUND_Y = 2.0;

function platform(app, cx, cz, halfX, halfZ) {
  const { reg, B } = buildBlocks(app.tex);
  const scale = 0.5;
  const sx = Math.ceil((halfX * 2 + 4) / scale), sz = Math.ceil((halfZ * 2 + 4) / scale), sy = 10;
  const { VoxelVolume } = app.__voxelMod;
  const vol = new VoxelVolume(sx, sy, sz);
  const rng = Rng.fromName(app.seed, 'shot:platform');
  const edge = 2;
  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      // Taper the rim into sand so the shoreline reads, per ART_BAR: a hard wall of grass
      // meeting water looks like a bug.
      const dEdge = Math.min(x, z, sx - 1 - x, sz - 1 - z);
      const top = dEdge < edge ? sy - 3 : sy - 1;
      for (let y = 0; y <= top; y++) {
        let b = B.rock;
        if (y === top) b = dEdge < edge + 2 ? B.sand : (rng.chance(0.12) ? B.sandDark || B.sand : B.grass);
        else if (y >= top - 1) b = B.dirt;
        vol.set(x, y, z, b);
      }
    }
  }
  // Place so the top voxel's upper face lands exactly on GROUND_Y.
  const originY = GROUND_Y - sy * scale;
  const geo = meshVolume(vol, reg, {
    scale, origin: [cx - (sx * scale) / 2, originY, cz - (sz * scale) / 2],
  });
  const mesh = new THREE.Mesh(geo, app.materials.terrain);
  app.rootStatic.add(mesh);
  return mesh;
}

async function ensureVoxelMod(app) {
  if (!app.__voxelMod) app.__voxelMod = await import('./gen/voxel.js');
}

/**
 * The character lineup. This is the single most direct comparison against ART_BAR §1 and §2:
 * chunky silhouette, readable face at a glance, saturated palette, soft rim light.
 */
registerShot({
  id: 'char-lineup',
  desc: 'Eight character archetypes at gameplay distance. Judges silhouette, face readability, palette and rim light.',
  tags: ['character', 'art-bar'],
  async setup(app) {
    await ensureVoxelMod(app);
    app.cameraOverride = true;
    app.timeFrozen = true;
    app.dayT = 0.30;                 // low warm sun from the side, per ART_BAR §5
    app.setWeather('clear', true);
    app.simulate(4);

    const ids = ['hero_captain', 'crew_swordsman', 'crew_navigator', 'crew_cook',
      'marine_captain', 'pirate_brute', 'fishman_raider', 'bandit_boss'];
    platform(app, 0, 0, 9, 3);
    let x = -7.7;
    for (const id of ids) {
      const spec = CHARACTER_SPECS[id];
      if (!spec) continue;
      const built = buildCharacter(app.tex, app.blocksReg || buildBlocks(app.tex).reg, spec, app.seed);
      placeCharacter(app, built, x, GROUND_Y, 0, Math.PI);
      x += 2.2;
    }
    app.atlas.needsUpdate = true;
    app.shadowFocus = new THREE.Vector3(0, GROUND_Y + 2, 0);
    app.camera.position.set(0.4, GROUND_Y + 2.4, 20.0);
    app.camera.lookAt(0, GROUND_Y + 1.9, 0);
    app.camera.fov = 50;
    app.camera.updateProjectionMatrix();
  },
});

/** One hero, close, low angle — the reference image's own framing (ART_BAR §6). */
registerShot({
  id: 'char-hero-closeup',
  desc: 'Hero at close range from a low angle, matching the reference composition. Judges face, palette and rim light directly.',
  tags: ['character', 'art-bar'],
  async setup(app) {
    await ensureVoxelMod(app);
    app.cameraOverride = true;
    app.timeFrozen = true;
    app.dayT = 0.31;
    app.setWeather('clear', true);
    app.simulate(4);
    platform(app, 0, 0, 4, 4);
    const spec = CHARACTER_SPECS.hero_captain;
    const built = buildCharacter(app.tex, buildBlocks(app.tex).reg, spec, app.seed);
    placeCharacter(app, built, 0, GROUND_Y, 0, Math.PI + 0.42);
    app.atlas.needsUpdate = true;
    app.shadowFocus = new THREE.Vector3(0, GROUND_Y + 2, 0);
    // Low camera looking slightly UP at the subject; subject ~55% of frame height (ART_BAR §6).
    app.camera.position.set(2.6, GROUND_Y + 1.15, 7.2);
    app.camera.lookAt(0, GROUND_Y + 2.5, 0);
    app.camera.fov = 46;
    app.camera.updateProjectionMatrix();
  },
});

/** Props and terrain materials at gameplay distance — judges ART_BAR §4 tonal steps and AO. */
registerShot({
  id: 'props-materials',
  desc: 'Procedural props and terrain blocks. Judges per-face shading, tonal steps within a material, and AO.',
  tags: ['world', 'art-bar'],
  async setup(app) {
    await ensureVoxelMod(app);
    const { VoxelVolume } = app.__voxelMod;
    app.cameraOverride = true;
    app.timeFrozen = true;
    app.dayT = 0.33;
    app.setWeather('clear', true);
    app.simulate(4);
    // Props need their own block ids registered against the shared registry — passing an
    // undefined block table was why the first pass rendered an empty island.
    const { reg, B } = buildBlocks(app.tex);
    preparePropBlocks(app.tex, reg, B);
    platform(app, 0, 0, 13, 9);

    const rng = Rng.fromName(app.seed, 'shot:props');
    const wanted = ['palmTree', 'jungleTree', 'pineTree', 'cherryTree', 'boulder', 'crate',
      'barrel', 'chest', 'lantern', 'campfire', 'signpost', 'well', 'cannon', 'stoneArch',
      'ruinColumn', 'treasurePile', 'bountyBoard', 'mooringPost'];
    let i = 0;
    for (const name of wanted) {
      const fn = PROPS[name];
      if (typeof fn !== 'function') continue;
      let built;
      try { built = fn(rng, B); } catch (e) { console.error('prop ' + name + ': ' + e.message); continue; }
      const vol = built && (built.volume || built.vol || built);
      if (!vol || typeof vol.get !== 'function') continue;
      const col = i % 6, row = (i / 6) | 0;
      const px = -8.5 + col * 3.4, pz = -3.6 + row * 3.6;
      const geo = meshVolume(vol, reg, {
        scale: built.scale || 0.25,
        origin: [px, GROUND_Y, pz],
      });
      app.rootStatic.add(new THREE.Mesh(geo, app.materials.prop));
      i++;
    }
    app.atlas.needsUpdate = true;
    app.shadowFocus = new THREE.Vector3(0, GROUND_Y + 2, 0);
    app.camera.position.set(0.0, GROUND_Y + 6.0, 19.0);
    app.camera.lookAt(0, GROUND_Y + 1.2, 0);
    app.camera.fov = 52;
    app.camera.updateProjectionMatrix();
  },
});

// ---------------------------------------------------------------------------
// The assembled game, framed the way it is played.
//
// Five shots, all of the real world streamed by the real world system, all pinned in weather
// and in time of day so each is a pure function of (seed, shotId). None of them is a beauty
// angle: every camera sits somewhere a player's camera actually goes — the deck of the ship,
// over the shoulder on a beach, standing on the island's high point.
// ---------------------------------------------------------------------------

/** Shells Cove, the first landmark on the route. Its landmark is a 34 m leaning lighthouse. */
const FIRST_ISLAND = { id: 'shellsCove', x: -7200, z: 0 };

/** Frame the camera. Shots own the camera — see takeCamera() in shots.js for why both halves. */
function frame(app, from, at, fov) {
  takeCamera(app);
  app.camera.up.set(0, 1, 0);
  app.camera.position.set(from[0], from[1], from[2]);
  app.camera.lookAt(at[0], at[1], at[2]);
  app.camera.fov = fov;
  app.camera.updateProjectionMatrix();
}

/** ARCHITECTURE section 3: yaw = atan2(dx, dz), -Z is north. */
function yawTo(x, z, tx, tz) {
  return Math.atan2(tx - x, tz - z);
}

/**
 * Simulate `seconds`, re-asserting `pin()` twice a second.
 *
 * A shot cannot teleport and render. Chunk meshing is budgeted across steps and the streaming
 * focus follows the player, so the world only exists where the subject has been for a while.
 * Re-asserting rather than simulating once is what stops gravity, swimming, the wind and the
 * tide carrying the subject off its mark during those seconds — which is exactly how the first
 * version of the approach shot ended up 30 m from where it asked to be, in the water.
 * @param {object} app @param {(i:number)=>void} pin @param {number} seconds
 */
function settle(app, pin, seconds) {
  const slice = 0.5;
  const n = Math.max(1, Math.round(seconds / slice));
  for (let i = 0; i < n; i++) { pin(i); app.simulate(slice); }
  pin(n);
  app.simulate(2 / 60);      // two clean steps so prev/cur interpolation is exact at alpha 0
}

/** Hold the player still at a world point. */
function pinPlayer(app, x, y, z, yaw) {
  const p = app.player;
  if (!p || !p.pos) return;
  p.pos.set(x, y, z);
  if (p.prevPos && p.prevPos.set) p.prevPos.set(x, y, z);
  if (p.vel && p.vel.set) p.vel.set(0, 0, 0);
  p.yaw = yaw; p.prevYaw = yaw; p.targetYaw = yaw;
}

/**
 * Stand the player on the ground at (x,z) while the island streams in around them. The ground
 * height is re-read every slice because `heightAt` returns -Infinity until the chunk exists.
 * @returns {number} the ground height they ended up on
 */
function standAt(app, x, z, yaw, seconds) {
  let y = 12;                 // above anything at Shells Cove, so nobody spawns inside rock
  settle(app, () => {
    const h = app.world ? app.world.heightAt(x, z) : -Infinity;
    if (Number.isFinite(h)) y = h;
    pinPlayer(app, x, y, z, yaw);
  }, seconds);
  return y;
}

/**
 * Hold the ship on station at (x,z) while the world streams, then put the player on deck.
 * @returns {?object} the ship system
 */
function sailAt(app, x, z, yaw, seconds) {
  const ship = app.ship;
  settle(app, () => {
    const b = ship && ship.body;
    if (b) {
      b.pos.x = x; b.pos.z = z; b.yaw = yaw;
      if (b.vel) { b.vel.x = 0; b.vel.y = 0; b.vel.z = 0; }
      b.yawRate = 0;
      if (b.anchorPos) { b.anchorPos.x = x; b.anchorPos.z = z; }
    }
    pinPlayer(app, x, 5, z, yaw);
  }, seconds);
  if (ship && ship.boardPlayer && app.player) ship.boardPlayer(app.player.pos);
  app.simulate(0.5);          // let the hull find the wave it is actually sitting on
  return ship;
}

/**
 * The third-person gameplay camera, stated as an offset from the subject.
 *
 * Every on-foot shot uses this rather than hand-placed eye points, because the thing being
 * judged is what the game looks like from where its camera actually is. `side` is the
 * over-the-shoulder offset: it pushes the camera to starboard so the character sits off-centre
 * and whatever they are looking at is not behind their own head — which is what the first pass
 * of the night shot did to the lighthouse.
 *
 * @param {object} app
 * @param {number} x @param {number} y ground height @param {number} z @param {number} yaw
 * @param {{back:number, rise:number, side:number, ahead:number, aim:number, fov:number}} o
 */
function overShoulder(app, x, y, z, yaw, o) {
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const rx = -fz, rz = fx;                    // camera-right for a Y-up right-handed frame
  frame(app,
    [x - fx * o.back + rx * o.side, y + o.rise, z - fz * o.back + rz * o.side],
    [x + fx * o.ahead + rx * o.side * 0.3, y + o.aim, z + fz * o.ahead + rz * o.side * 0.3],
    o.fov);
}

/**
 * Ship-local point to world. Falls back to the raw offset if the ship never assembled.
 *
 * Where a shipboard camera can go was measured, not guessed. Casting a 7x5 fan of rays across
 * a 55-degree forward view from each candidate and counting hits on the ship's own meshes:
 *   amidships on the deck (0, 5.6, -1)   35/35 rays blocked   — inside the rigging
 *   port quarterdeck      (-2.6, 6.6, -8.6) 20/35             — the frame is stern castle
 *   foredeck              (-1.0, 4.5, 7.5) 13/35              — the bulwark eats the left third
 *   sailing chase cam     (0, 9.5, -20)     4/35              — the ship sits in the lower centre
 *   ahead of the bowsprit (0, 5.6, 12.5)    0/35              — but nothing of the ship in shot
 * The chase camera is both the clearest view and the one the game actually uses under sail, so
 * that is where both sea shots are taken from.
 */
function onDeck(app, lx, ly, lz) {
  const b = app.ship && app.ship.body;
  const out = { x: 0, y: 0, z: 0 };
  if (b && b.toWorld) { b.toWorld(lx, ly, lz, out); return [out.x, out.y, out.z]; }
  return [lx, ly, lz];
}

/**
 * The island as you first see it: from the deck of your ship, still well out to sea.
 *
 * Framing answers ART_BAR's Minecraft question — "at 300 m can you name the biome and read the
 * island's shape?" — against the geometry Shells Cove actually has. Its body is a low crescent
 * topping out at 11 m across 120 m of width; only the lighthouse headland reaches 34 m. From a
 * ship's rail at 6 m of eye height an 11 m island subtends one degree at 300 m, which is the
 * smudge this shot used to be. So the camera stands off at 135 m instead, on the north-east
 * quarter where the lighthouse clears the body rather than hiding behind it, and the low morning
 * sun rakes in from the left. The lighthouse then breaks the horizon by nearly 19 degrees and
 * the coastline spans half the frame width: shape, landmark and biome all read.
 *
 * The camera is the sailing chase camera, not a deck position: measured, every on-deck point
 * puts the ship's own bulwark or rigging across a third of the frame or more, which is a
 * picture of a boat rather than of an island. From astern the hull and masts lead the eye into
 * the island instead of hiding it.
 */
registerShot({
  id: 'game-island-approach',
  desc: 'The first landmark island seen from a ship 135 m out. Judges island silhouette, the '
    + 'lighthouse landmark, shoreline, sea and whole-frame coherence.',
  tags: ['world', 'ship', 'integration', 'art-bar'],
  async setup(app) {
    app.cameraOverride = true;
    app.timeFrozen = true;
    app.dayT = 0.30;                  // low morning sun, ESE — a side key from the left here
    app.setWeather('breezy', true);   // pins: the field may not overwrite it while we stream

    const I = FIRST_ISLAND;
    const DIST = 135;
    const sx = I.x + 0.71 * DIST, sz = I.z - 0.71 * DIST;
    const yaw = yawTo(sx, sz, I.x + 26, I.z - 3);
    sailAt(app, sx, sz, yaw, 9);

    // Offset to port: from the centre line the mainmast and sail stand exactly where the island
    // is, and a 6.5 m sidestep swings them 15 degrees to starboard without altering the course.
    const cam = onDeck(app, -6.5, 9.0, -21);
    frame(app, cam, [I.x + 26, 14, I.z - 3], 50);
  },
});

/**
 * Ashore: standing on the eastern spit of the cove, looking across the bay at the village.
 * This is the frame a player is in for most of an island visit — third person, over the
 * shoulder, subject in the lower third and the objective ahead of them.
 */
registerShot({
  id: 'game-island-shore',
  desc: 'On the beach of the first island looking inland across the bay, dock and village in '
    + 'frame. Judges shoreline materials, settlement readability and character-in-world scale.',
  tags: ['world', 'character', 'integration', 'art-bar'],
  async setup(app) {
    app.cameraOverride = true;
    app.timeFrozen = true;
    app.dayT = 0.34;
    app.setWeather('clear', true);

    const I = FIRST_ISLAND;
    // Standing on the sand at the head of the bay, exactly where the dock puts you ashore:
    // the jetty (local -4, +38) is behind and below the camera, the village street runs away
    // north to the plaza (local -8, +5), and the beach carries the bottom of the frame.
    // The first pass stood further out on the eastern spit and rendered a palm trunk.
    const px = I.x - 4, pz = I.z + 30;
    const yaw = yawTo(px, pz, I.x - 7, I.z + 4);
    const y = standAt(app, px, pz, yaw, 9);
    overShoulder(app, px, y, pz, yaw,
      { back: 10.0, rise: 3.4, side: 1.9, ahead: 22, aim: 2.6, fov: 56 });
  },
});

/**
 * The island's high point — the lighthouse headland at 29 m — looking back out over the sea the
 * player has just crossed. A vista is a real gameplay reward here (every landmark publishes a
 * named `vista` spawn point), so it is framed as one rather than as a postcard.
 */
registerShot({
  id: 'game-island-vista',
  desc: 'From the lighthouse headland, the island high point, looking back out to sea. Judges '
    + 'aerial perspective, horizon scale and terrain silhouette seen from above.',
  tags: ['world', 'sky', 'integration', 'art-bar'],
  async setup(app) {
    app.cameraOverride = true;
    app.timeFrozen = true;
    app.dayT = 0.68;                  // late afternoon: sun in the west, behind us, lighting the sea
    app.setWeather('clear', true);

    const I = FIRST_ISLAND;
    // The open shoulder of the headland, clear of the lighthouse footprint (local x 43..52,
    // z -12..-3, which is 33 m of solid tower — standing on it filled the frame with masonry).
    const px = I.x + 34, pz = I.z - 26;
    const yaw = yawTo(px, pz, I.x + 420, I.z - 130);   // east-north-east, out past the coast
    const y = standAt(app, px, pz, yaw, 9);
    // Nearly level, so the horizon sits just above the middle and half the frame is sky, but
    // pitched down just enough to keep the shoreline 30 m below inside the bottom of the frame:
    // without it there is nothing in shot to say the camera is standing on a high point. The
    // first pass pitched down 5 degrees instead, and turned a vista into a picture of water.
    overShoulder(app, px, y, pz, yaw,
      { back: 10.5, rise: 4.6, side: 2.4, ahead: 240, aim: -8.0, fov: 60 });
  },
});

/**
 * Open sea in a full storm, from the deck of the ship. Deliberately far from any land, so the
 * only things on trial are wave amplitude and period, the grade under storm cloud, whether rain
 * is legible without erasing the frame, and whether the hull reads as driven by the water
 * rather than sliding on it (ART_BAR, the Sea of Thieves benchmark).
 */
registerShot({
  id: 'game-storm-sea',
  desc: 'Open sea in a storm from a ship deck. Judges wave amplitude and period, rain, the '
    + 'storm grade, and whether the hull reads as driven by the water rather than sliding on it.',
  tags: ['water', 'weather', 'ship', 'integration', 'art-bar'],
  async setup(app) {
    app.cameraOverride = true;
    app.timeFrozen = true;
    app.dayT = 0.46;                  // near noon: the darkness is the storm, not the hour
    app.setWeather('storm', true);

    // Mid-ocean between two landmarks, outside every island's clearance radius.
    const sx = -4260, sz = 1550;
    const yaw = 0.85;                 // quartering the swell, so the hull rolls as well as pitches
    sailAt(app, sx, sz, yaw, 12);

    // Astern at the height of the poop rail, looking forward down the length of the ship: the
    // hull and the swell it is riding are both in frame, which is the only way to judge whether
    // the water is driving the ship or the ship is sliding on it.
    const cam = onDeck(app, 0, 7.4, -23);
    const fore = onDeck(app, 0, 2.6, 34);
    frame(app, cam, fore, 58);
  },
});

/**
 * The island at night. ART_BAR section 5's hardest claim is that shadows never crush to black,
 * and night is where that claim is cheapest to break. This frame puts a silhouette, a lit face,
 * a shadowed face and open sky in one image so they can be compared against each other.
 */
registerShot({
  id: 'game-night-island',
  desc: 'The first island at night from its beach, the lighthouse headland against the sky. '
    + 'Judges that silhouettes still read and that shadows never crush to black (ART_BAR 5).',
  tags: ['world', 'night', 'integration', 'art-bar'],
  async setup(app) {
    app.cameraOverride = true;
    app.timeFrozen = true;
    app.dayT = 0.92;                  // deep night, the same hour as the ocean-night reference
    app.setWeather('clear', true);

    const I = FIRST_ISLAND;
    const px = I.x + 8, pz = I.z + 26;                 // the shore at the head of the bay
    const yaw = yawTo(px, pz, I.x + 48, I.z - 6);      // toward the lighthouse, 50 m away
    const y = standAt(app, px, pz, yaw, 9);
    // A wide shoulder offset: at night the lighthouse IS the silhouette being judged, and the
    // first pass put the player's head exactly on top of it.
    overShoulder(app, px, y, pz, yaw,
      { back: 9.5, rise: 3.2, side: 3.0, ahead: 40, aim: 7.5, fov: 56 });
  },
});
