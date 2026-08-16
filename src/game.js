// Game assembly. The ONLY file that knows about every system.
//
// Two orderings matter and they are NOT the same:
//   * construction order — dependency order (world before anything that stands on it)
//   * step order         — the fixed order in ARCHITECTURE §4, which determinism depends on
// Systems are constructed below, then registered in step order at the end.
//
// Systems are loaded defensively: a subsystem that is absent is skipped with a recorded reason
// rather than throwing. That keeps the harness, the profiler and the art shots usable while the
// game is being assembled, and it makes a missing piece show up as a named gap in the evidence
// instead of a blank screen.

import * as THREE from 'three';
import { Input, capForAction } from './core/input.js';
import { createSaveSystem } from './core/save.js';
import { buildBlocks } from './gen/blocks.js';

/** Import a module, returning null (and recording why) if it is not present yet. */
async function tryImport(path, missing) {
  try {
    return await import(/* @vite-ignore */ path);
  } catch (e) {
    missing.push({ path, reason: String((e && e.message) || e).split('\n')[0] });
    return null;
  }
}

export async function buildGameSystems(app) {
  const missing = [];
  app.missingSystems = missing;

  // --- shared block registry -------------------------------------------------
  // Terrain, props, ship and fruit terrain-destruction all resolve block ids through this one
  // registry. It must be built after the texture library and before anything meshes geometry.
  // App.boot() already built the registry and registered every tile BEFORE uploading the
  // texture array. Reuse it — building a second registry here would hand out ids that do not
  // match the uploaded layers.
  const reg = app.blocks || buildBlocks(app.tex).reg;
  const B = app.B || buildBlocks(app.tex).B;
  app.blocks = reg;
  app.B = B;

  // --- input -----------------------------------------------------------------
  app.input = new Input();
  if (typeof window !== 'undefined') app.input.attach(window);

  // --- cross-cutting state ----------------------------------------------------
  // app.flags: story/tutorial flags other systems read (fruits.js gates drowning damage on
  // flags.tutorialDone; the playtest asserts it). app.signals: the monotonic counters the
  // tutorial advances on (see the contract at the top of src/ui/tutorial.js). Both must exist
  // from boot, or every reader silently sees "not yet".
  app.flags = app.flags || {};
  app.signals = app.signals || {
    lookAmount: 0, moveDistance: 0, attack: 0, block: 0, dodge: 0,
    fruitPower: 0, npcTalk: 0, questAccept: 0, mapOpen: 0,
  };

  // --- construction, in dependency order -------------------------------------
  const mods = {
    physics: await tryImport('./core/physics.js', missing),
    world: await tryImport('./world/world.js', missing),
    weather: await tryImport('./world/weather.js', missing),
    spawn: await tryImport('./world/spawn.js', missing),
    fx: await tryImport('./render/fx.js', missing),
    camera: await tryImport('./render/camera.js', missing),
    combat: await tryImport('./combat/combat.js', missing),
    player: await tryImport('./entity/player.js', missing),
    npc: await tryImport('./entity/npc.js', missing),
    fruit: await tryImport('./fruit/fruits.js', missing),
    ship: await tryImport('./ship/ship.js', missing),
    quest: await tryImport('./quest/quest.js', missing),
    audio: await tryImport('./audio/audio.js', missing),
    ui: await tryImport('./ui/ui.js', missing),
  };

  // The authored island table. The ship's dock controller, the compass and the start berth all
  // read it; importing it once here keeps every consumer looking at the same records.
  const islandsMod = await tryImport('./gen/islands.js', missing);
  const LANDMARKS = (islandsMod && islandsMod.LANDMARKS) || null;

  const made = {};
  const make = (name, fn) => {
    try {
      const s = fn();
      if (s) made[name] = s;
      return s;
    } catch (e) {
      missing.push({ path: name, reason: 'construct: ' + String((e && e.message) || e).split('\n')[0] });
      return null;
    }
  };

  // Physics is a service, not a stepped system — everything else queries it.
  if (mods.physics) {
    app.physics = make('physics', () => mods.physics.createPhysicsSystem(app, {}));
  }

  if (mods.world) {
    make('world', () => mods.world.createWorldSystem(app, { reg, B }));
  }
  // WeatherSystem resolves its world reference exactly once, in its constructor — so the world
  // must be passed explicitly here (app.world is not assigned until the registration loop).
  if (mods.weather) make('weather', () => mods.weather.createWeatherSystem(app, { world: made.world || null }));
  if (mods.fx) make('fx', () => mods.fx.createFxSystem(app, {}));
  if (mods.quest) {
    make('quests', () => new mods.quest.QuestSystem(app.seed));
  }
  if (mods.audio) {
    make('audio', () => new mods.audio.AudioSystem(app.seed));
  }
  if (mods.combat) make('combat', () => mods.combat.createCombatSystem(app));
  // ARCHITECTURE §9b: `app.enemies` is the spawn facade WORLD, SHIP and the harness call.
  // Without it every camp/patrol/boarding spawn silently no-ops.
  if (made.combat && mods.combat && mods.combat.createEnemiesFacade) {
    app.enemies = mods.combat.createEnemiesFacade(made.combat);
  }
  if (mods.player) make('player', () => mods.player.createPlayer(app, {}));
  // Register the player as a combatant. Without this the status loop ("statuses and DoT for
  // every combatant, including the player") never includes the player: hitstun from the FIRST
  // hit ever taken never decays, canAct() stays false forever, and the player can never swing
  // again for the rest of the session. Measured live: 15 s at full hp, 13 attack inputs,
  // attacksStarted 0, hitstun pinned. This was the real reason the quest fight never won.
  if (made.player && made.combat && typeof made.combat.register === 'function') {
    made.combat.register(made.player);
  }
  if (mods.fruit) make('fruit', () => mods.fruit.createFruitSystem(app, {}));
  if (mods.npc) make('npc', () => mods.npc.createNpcSystem(app));
  // The ship is constructed with the island table so the DockController can dock, gate
  // boarding, and offer fast-travel destinations (ARCHITECTURE's ship request).
  if (mods.ship) make('ship', () => mods.ship.createShipSystem(app, { islands: LANDMARKS || [] }));
  if (mods.spawn) make('spawn', () => mods.spawn.createSpawnSystem(app));
  if (mods.camera) {
    app.gameCamera = make('gameCamera', () => mods.camera.createGameCamera(app, {}));
  }
  if (mods.ui && typeof document !== 'undefined') {
    make('ui', () => {
      const ui = new mods.ui.UISystem({ seed: app.seed });
      ui.attach(document.getElementById('app') || document.body,
        app.renderer.width, app.renderer.height);
      // App steps systems as step(dt, app), but UISystem.step wants the HUD state shape, and
      // UISystem.draw() was never called by anyone -- the HUD had never rendered. Decorating the
      // instance (rather than wrapping it) keeps app.ui === UISystem, which fx.damageNumber
      // and the menus rely on.
      const realStep = ui.step.bind(ui);
      ui.step = (dt, appRef) => {
        const a = appRef || app;
        realStep(dt, buildUiState(a, ui));
        // The tutorial's completion is a flag other systems read (drowning grace, playtest).
        if (ui.tutorial && ui.tutorial.isDone()) { a.flags = a.flags || {}; a.flags.tutorialDone = true; }
      };
      ui.preRender = () => { try { ui.draw(); } catch (e) { console.error('[ui] draw: ' + e.message); } };
      // NOTE: wireMenuCallbacks runs AFTER the registration loop below — app.save and
      // app.quests do not exist yet, and wiring now would leave the menus on demo stubs.
      return ui;
    });
  }

  // If boot has to rebuild the texture array (a system registered a tile late), every material
  // holding the old texture must be re-pointed — including the per-character materials rigs make.
  app.onAtlasRebuilt = (atlas) => {
    app.scene.traverse((o) => {
      const m = o.material;
      if (m && m.uniforms && m.uniforms.uAtlas) m.uniforms.uAtlas.value = atlas;
    });
  };

  // --- starting position -----------------------------------------------------
  // Without this the player spawns at world origin, which is open ocean. A devil fruit user
  // cannot swim, so a new game began by drowning eleven times and washing ashore at 16 hp
  // before the player had touched a key. Start them on the first island's dock instead.
  if (made.player && made.world && LANDMARKS) {
    try {
      const start = LANDMARKS.find(l => l.id === 'shellsCove') || LANDMARKS[0];
      if (start) {
        const sx = start.worldPos[0] + (start.dockPos ? start.dockPos[0] : 0);
        const sz = start.worldPos[1] + (start.dockPos ? start.dockPos[1] : 0);
        // Stream the island in before asking it how high the ground is, then stand on it.
        if (typeof made.world.ensureLoaded === 'function') made.world.ensureLoaded(sx, sz);
        let gy = made.world.heightAt(sx, sz);
        if (!Number.isFinite(gy)) gy = 2;          // dock deck height if the query is not ready
        made.player.pos.set(sx, gy + 0.1, sz);
        if (made.player.teleport) made.player.teleport(sx, gy + 0.1, sz);
        made.player.yaw = start.dockYaw || 0;
        app.startIsland = start.id;
      }
    } catch (e) {
      console.warn('[game] could not place the player at the start island: ' + e.message);
    }
  }

  // --- ship berth -------------------------------------------------------------
  // The ship starts moored at the same dock the player spawns on. Without this it floats at
  // world origin, kilometres of open ocean away from a captain who cannot swim.
  if (made.ship && app.startIsland) {
    try {
      if (typeof made.ship.berthAt === 'function') made.ship.berthAt(app.startIsland);
    } catch (e) {
      console.warn('[game] could not berth the ship at the start island: ' + e.message);
    }
  }

  // Death handling. Without this, hp 0 is a permanent softlock: the corpse lies where it
  // fell for the rest of the session (the playtest measured 275 s of a dead player "fighting").
  // Sea-of-thieves rules: a beaten pirate wakes on the dock, hurting but alive.
  if (made.player) {
    made.__respawn = { t: 0 };
    const r = made.__respawn;
    app.addSystemLater = null;
    made.respawn = {
      step(dt, a) {
        const pl = a.player;
        // Out-of-combat health regeneration. The measured death spiral: respawn at half hp,
        // walk 40 s back to the camp, die again before landing three kills — repeat for the
        // whole quest budget. Eight calm seconds (no damage taken) starts a slow mend, so the
        // walk back IS the recovery. The cook's crew bonus stacks on top of the base rate.
        if (pl && !pl.dead && Number.isFinite(pl.hp) && pl.hp > 0 && pl.hp < pl.maxHp) {
          const calmFor = a.clock.simTime - (pl.lastHitTime !== undefined ? pl.lastHitTime : -999);
          const drowning = a.fruit && a.fruit.submerged;
          if (calmFor > 6 && !drowning) {
            let rate = 6;                       // hp per second; ~15 s from half to full
            try {
              const b = a.quests && a.quests.activeBonuses ? a.quests.activeBonuses() : null;
              if (b && Number.isFinite(b.regen)) rate += b.regen;
            } catch {}
            pl.hp = Math.min(pl.maxHp, pl.hp + rate * dt);
          }
        }
        if (!pl || !pl.dead) { r.t = 0; return; }
        r.t += dt;
        if (r.t < 3) return;                       // a beat to read the death, then wake
        r.t = 0;
        const isl = a.startIsland && LANDMARKS ? LANDMARKS.find(l => l.id === a.startIsland) : null;
        const sx = isl ? isl.worldPos[0] + (isl.dockPos ? isl.dockPos[0] : 0) : pl.pos.x;
        const sz = isl ? isl.worldPos[1] + (isl.dockPos ? isl.dockPos[1] : 0) : pl.pos.z;
        let gy = a.world && a.world.heightAt ? a.world.heightAt(sx, sz) : 2;
        if (!Number.isFinite(gy)) gy = 2;
        if (pl.revive) pl.revive();
        // revive() sets the Actor-side `alive` flag — but combat keeps its own `dead` flag
        // (initCombatant), and _stepPlayer early-returns on it. Missing this line left an
        // immortal corpse at the dock: hp restored, position restored, permanently dead to
        // the combat system, respawn re-firing every three seconds forever.
        pl.dead = false;
        pl.removed = false;
        pl.hitstun = 0;
        pl.stagger = 0;
        if (pl.status) { pl.status.burnT = 0; pl.status.frozenT = 0; pl.status.gravityT = 0; }
        pl.iframes = 1.2;   // a breath of spawn protection so a camped dock is not a death loop
        pl.hp = Math.max(1, Math.round((pl.maxHp || 100) * 0.5));
        pl.teleport ? pl.teleport(sx, gy + 0.1, sz) : pl.pos.set(sx, gy + 0.1, sz);
        // Waking into the same fight is not a second chance; drop all aggro.
        if (a.combat && a.combat.enemies) for (const e of a.combat.enemies) { e.target = null; if (e.setState) e.setState('patrol'); }
        if (a.ui && a.ui.toast) a.ui.toast('You wash up on the dock', 'bad');
      },
    };
  }

  // --- dockside sparring partner ------------------------------------------------------------
  // A safe trainer beside the start island's dock, so the tutorial's attack/block/dodge
  // lessons happen against slow telegraphs, a damage floor and an opponent who cannot die —
  // instead of against whatever patrol wanders past a player still learning to walk.
  // Deterministic: fixed reserved actor id (no _actorSeq bump, so every camp enemy's rng
  // stream is byte-identical with or without him) and fixed candidate spots, no rng draws.
  // Re-ensured every step so he survives any future enemy-clearing path.
  if (made.combat && made.world && LANDMARKS) {
    const SPAR_ID = 100000;
    const SPAR_SPOTS = [[3, 34], [6, 31], [0, 31], [8, 28]];   // local metres, fixed order
    made.sparring = {
      step(dt, a) {
        const c = a.combat;
        if (!c) return;
        let spar = a._sparring && !a._sparring.removed ? a._sparring : null;
        if (!spar) {
          for (const e of c.enemies) { if (e.kind === 'sparring' && !e.removed) { spar = e; break; } }
        }
        if (!spar) {
          const start = LANDMARKS.find((l) => l.id === (a.startIsland || 'shellsCove'));
          if (!start || !a.world || typeof a.world.heightAt !== 'function') return;
          for (const [lx, lz] of SPAR_SPOTS) {
            const x = start.worldPos[0] + lx, z = start.worldPos[1] + lz;
            const y = a.world.heightAt(x, z);
            if (Number.isFinite(y) && y > 0.8) {
              spar = c.spawnEnemy('sparring', x, y, z, 1, { id: SPAR_ID });
              break;
            }
          }
          if (!spar) return;
        }
        a._sparring = spar;
        // Passive once attack, block and dodge are all learned (or the whole tutorial is
        // done/skipped): stops aggroing, idles at his post, stays as dockside flavour.
        const tut = a.ui && a.ui.tutorial;
        const learned = tut && tut.learned;
        const done = (learned && learned.has('attack') && learned.has('block') && learned.has('dodge'))
          || !!(a.flags && a.flags.tutorialDone);
        if (done && !spar.passive) {
          spar.passive = true;
          spar.target = null;
          if (spar.setState) spar.setState('patrol');
        } else if (!done && spar.passive) {
          spar.passive = false;
        }
      },
    };
  }

  app.save = createSaveSystem(app);

  // --- registration, in the fixed step order from ARCHITECTURE §4 -------------
  // §4: input → player → fruit → combat → npc → ship → world → physics → fx → ...
  // 'physics' is REGISTERED here, not just constructed: its step rebuilds the broadphase hash
  // every hitbox and projectile resolves against. Unstepped, the hash stays empty and no
  // attack in the game can connect with anything.
  const STEP_ORDER = [
    'player', 'respawn', 'sparring', 'fruit', 'combat', 'npc', 'ship', 'world', 'spawn',
    'weather', 'physics', 'fx', 'quests', 'gameCamera', 'ui', 'audio', 'save',
  ];
  for (const name of STEP_ORDER) {
    const sys = name === 'save' ? app.save : made[name];
    if (sys) app.addSystem(name, sys);
  }
  // Alias: the quest system registers as 'quests' but npc.js, the playtest and older callers
  // read app.quest. Publish both names for one object.
  if (made.quests) {
    app.quest = made.quests;
    // The playtest (and the bounty HUD niceties) read app.player.bounty; the source of truth
    // is QuestSystem.bounty. Mirror it after every quest step.
    if (made.player) {
      const qStep = made.quests.step.bind(made.quests);
      made.quests.step = (dt, ctx) => {
        qStep(dt, ctx);
        try { made.player.bounty = made.quests.bountyState().total; } catch {}
      };
      try { made.player.bounty = made.quests.bountyState().total; } catch {}
    }
    // Tutorial signal: quests accepted, however they were accepted (dialogue, menu, script).
    const qAccept = made.quests.accept.bind(made.quests);
    made.quests.accept = (id) => {
      const ok = qAccept(id);
      if (ok && app.signals) app.signals.questAccept++;
      return ok;
    };
  }
  // Input is stepped first, by hand, because every other system reads its snapshot.
  app.addSystemFirst = null;
  app.inputSystem = {
    __name: 'input',
    step() {
      // Menus own the keyboard while open; without this the character fights and walks while
      // the player navigates the pause menu.
      app.input.blocked = !!(app.ui && app.ui.menuOpen);
      app.input.step();
      // M opens the voyage log (quest journal grouped by island — the closest thing to a map).
      // Consumed here because the UI's own listeners only see keys while a menu is open.
      const st = app.input.state;
      if (st && st.pressed && st.pressed.map && app.ui && !app.ui.menuOpen) {
        if (app.ui.openMenu('quests') && app.signals) app.signals.mapOpen++;
      }
    },
  };
  // Mouse look needs pointer lock, and NOTHING ever requested it -- the single biggest control
  // defect in the first playable build. The UI canvas sits on top of the game canvas, so listen
  // on window; the UI's own handlers run first and consume clicks when a menu is open.
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', () => {
      if (app.ui && app.ui.menuOpen) return;
      if (!app.input.pointerLocked) app.input.requestPointerLock(app.canvas);
    });
    // Audio contexts start suspended until a user gesture; unlock on the first interaction.
    const unlockOnce = () => {
      if (app.audio && app.audio.unlock) app.audio.unlock();
      window.removeEventListener('pointerdown', unlockOnce);
      window.removeEventListener('keydown', unlockOnce);
    };
    window.addEventListener('pointerdown', unlockOnce);
    window.addEventListener('keydown', unlockOnce);
  }
  app.systems.unshift(app.inputSystem);

  // --- wire the cross-system services listed in ARCHITECTURE §5 ---------------
  wireServices(app, made);

  // Menus are wired LAST, once app.save, app.quests, app.audio and app.fruit all exist —
  // wiring earlier left every guard false and the pause menu running on demo stubs.
  if (made.ui) wireMenuCallbacks(app, made.ui);

  if (missing.length) {
    // Not an error: this is the honest record of what is not assembled yet.
    console.warn('[game] systems not assembled: ' +
      missing.map(m => m.path).join(', '));
  }
  app.assembled = Object.keys(made);
  return app;
}

/**
 * Connect the shared services. Each of these is a place where two owners meet, so they are all
 * in one function where the coupling is visible instead of scattered through the systems.
 */
function wireServices(app, made) {
  // The ocean shader needs the nearest island discs for its shore gradient and surf foam.
  if (made.world && app.water) {
    const prevPreRender = made.world.preRender;
    made.world.preRender = function (alpha, a) {
      if (prevPreRender) prevPreRender.call(this, alpha, a);
      if (typeof this.nearbyIslandDiscs === 'function') {
        const p = app.player ? app.player.pos : app.camera.position;
        app.water.setNearbyIslands(this.nearbyIslandDiscs(p.x, p.z) || []);
      }
    };
  }

  // Interactables: the Player's interact cone consults world.interactablesNear; the spawn
  // system is what actually owns the chests, quest pickups and destructible props.
  if (made.world && made.spawn && typeof made.world.interactablesNear !== 'function'
    && typeof made.spawn.interactablesNear === 'function') {
    made.world.interactablesNear = (x, z, r) => made.spawn.interactablesNear(x, z, r);
  }

  // Quest progress is driven only by notify(). Combat and world announce, quests decide.
  if (made.quests) {
    app.notifyQuest = (event, data) => {
      try { made.quests.notify(event, data); } catch (e) { console.error('[quest] ' + e.message); }
    };
  } else {
    app.notifyQuest = () => {};
  }

  // Audio is fire-and-forget from everywhere.
  if (made.audio) {
    app.playSound = (name, opts) => { try { made.audio.play(name, opts); } catch {} };
    app.playSoundAt = (name, x, y, z, opts) => { try { made.audio.playAt(name, x, y, z, opts); } catch {} };
  } else {
    app.playSound = () => {};
    app.playSoundAt = () => {};
  }

  // The player must be a registered combatant: perception, enemy hitboxes and the spatial
  // hash all resolve against combat's lists ("The player system calls this once on spawn" —
  // combat.register's own doc — but nothing ever did).
  if (made.combat && made.player && typeof made.combat.register === 'function') {
    made.combat.register(made.player, { team: 1, maxPoise: 55 });
  }

  // Impact feedback: one entry point, so hitstop/shake/flash can never drift apart.
  if (made.fx) {
    app.impact = (spec) => { try { made.fx.impact(spec); } catch (e) { console.error('[fx] ' + e.message); } };
  } else {
    app.impact = () => {};
  }

  // The shadow cascades follow the player, not the camera: cascade 0 is small and must hug
  // whatever the eye is actually reading, which is the character.
  app.shadowFocus = new THREE.Vector3();
  const focus = app.shadowFocus;
  const prevRender = app.render.bind(app);
  app.render = function (alpha) {
    if (app.player && app.player.pos) focus.copy(app.player.pos);
    else focus.copy(app.camera.position);
    prevRender(alpha);
  };

  // The game camera owns the THREE camera during play; shots and the profiler may override.
  // Combat screen shake: FX publishes `app.fx.shake` {x, y, roll} every step (ARCHITECTURE
  // §9b says the camera reads it each frame); apply it here, after the camera has framed the
  // shot, in camera space. Without this every landed hit paused (hitstop) without shaking.
  if (made.gameCamera && made.player) {
    made.gameCamera.follow(made.player);
    const gc = made.gameCamera;
    const prev = gc.preRender ? gc.preRender.bind(gc) : null;
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    gc.preRender = (alpha, a) => {
      if (prev) prev(alpha, a);
      if (app.cameraOverride) return;
      gc.applyTo(app.camera, alpha);
      const sh = made.fx && made.fx.shake;
      if (sh && (sh.x || sh.y || sh.roll)) {
        const cam = app.camera;
        right.set(1, 0, 0).applyQuaternion(cam.quaternion);
        up.set(0, 1, 0).applyQuaternion(cam.quaternion);
        cam.position.addScaledVector(right, sh.x).addScaledVector(up, sh.y);
        if (sh.roll) cam.rotateZ(sh.roll);
      }
    };
  }
}


/**
 * Assemble the HUD state shape (see blankHudState in src/ui/hud.js) from live systems.
 * Every read is defensive: a missing system leaves the HUD default rather than crashing the
 * draw loop, and this bridge is the ONE place the UI learns about the rest of the game.
 */
function buildUiState(app, ui) {
  const hud = {};
  const p = app.player;
  if (p) {
    if (Number.isFinite(p.hp)) hud.hp = p.hp;
    if (Number.isFinite(p.maxHp)) hud.maxHp = p.maxHp;
    if (Number.isFinite(p.stamina)) hud.stamina = p.stamina;
    if (Number.isFinite(p.maxStamina)) hud.maxStamina = p.maxStamina;
  }
  const q = app.quests;
  if (q) {
    try {
      const bs = q.bountyState();
      if (bs) {
        hud.bounty = bs.total || 0;
        hud.wanted = bs.tierIndex !== undefined ? bs.tierIndex : (bs.tier && bs.tier.index) || 0;
      }
    } catch {}
    try { hud.crew = (q.crew() || []).map(c => ({ name: c.name, role: c.role })); } catch {}
    try {
      // trackedQuest() returns { title, step: { index, count, text, objectives } } where each
      // objective is objectiveProgress(): { current, target, done, text } (quest.js/objectives.js).
      const t = q.trackedQuest && q.trackedQuest();
      if (t && t.step) {
        const objs = t.step.objectives || [];
        const active = objs.find(o => !o.done) || objs[objs.length - 1] || null;
        hud.quest = {
          title: t.title || t.id,
          objective: (active && active.text) || t.step.text || '',
          progress: active ? active.current : 0,
          total: active ? active.target : 0,
        };
      }
    } catch {}
    for (const k of ['berries', 'level', 'xp', 'xpToNext']) {
      try {
        const v = typeof q[k] === 'function' ? q[k]() : (q.progress && q.progress[k]);
        if (Number.isFinite(v)) hud[k] = v;
      } catch {}
    }
  }
  const f = app.fruit;
  if (f) {
    // FruitSystem.hudState() returns exactly the st.fruit block hud.js draws — ability pips
    // with runner cooldowns, meter, and the sealed (deep water) state.
    try { if (typeof f.hudState === 'function') hud.fruit = f.hudState(); } catch {}
  }
  const c = app.combat;
  if (c) {
    try {
      // nearestThreat() returns { name, hp, maxHp, tier, dist, actor, telegraph:{kind,t,label} }.
      const t = c.nearestThreat && c.nearestThreat();
      if (t) hud.target = {
        name: t.name || 'enemy',
        hp: t.hp, maxHp: t.maxHp, tier: t.tier || 1,
        telegraph: t.telegraph || null,
      };
    } catch {}
    if (c.combo !== undefined) { hud.combo = c.combo; hud.comboTimer = c.comboTimer || 0; }
  }
  // Compass: camera yaw plus island markers, which is how the player finds the next landmark.
  const yaw = app.gameCamera && app.gameCamera.yaw !== undefined ? app.gameCamera.yaw : (p ? p.yaw : 0);
  const markers = [];
  if (app.world && p) {
    try {
      for (const isl of app.world.islandsNear(p.pos.x, p.pos.z, 2600) || []) {
        // World records carry worldPos:[x,z]; the flat harness shape carries x/z.
        const ix = isl.worldPos ? isl.worldPos[0] : isl.x;
        const iz = isl.worldPos ? isl.worldPos[1] : isl.z;
        if (!Number.isFinite(ix) || !Number.isFinite(iz)) continue;
        const dx = ix - p.pos.x, dz = iz - p.pos.z;
        markers.push({ yaw: Math.atan2(dx, dz), dist: Math.hypot(dx, dz), kind: 'island', label: isl.name || isl.id });
      }
    } catch {}
  }
  hud.compass = { yaw, markers };
  // The prompt's keycap is derived from the live binds, same as the tutorial's — a label
  // that cannot drift from the binding.
  const interactCap = capForAction('interact', app.input) || 'E';
  if (p && p.interactTarget) {
    hud.prompt = { key: interactCap, label: p.interactTarget.label || p.interactTarget.prompt || 'Interact' };
  } else if (p && !p.onShip && app.ship && app.ship.docked
    && typeof app.ship.canBoard === 'function' && app.ship.canBoard(p.pos)) {
    hud.prompt = { key: interactCap, label: 'Board ship' };
  }
  hud.onShip = !!(p && p.onShip);
  hud.weather = app.weatherKey;
  hud.timeOfDay = app.dayT;

  // --- tutorial signals (see the contract at the top of src/ui/tutorial.js) ---------------
  // Monotonic counters accumulated here, once per fixed step, from observable state. The
  // private baselines live under _prev so the counters themselves stay clean numbers.
  const sig = app.signals;
  if (sig) {
    const pv = sig._prev || (sig._prev = {});
    const gc = app.gameCamera;
    if (gc && typeof gc.yaw === 'number') {
      if (typeof pv.yaw === 'number') {
        let dy = Math.abs(gc.yaw - pv.yaw); if (dy > Math.PI) dy = Math.abs(dy - 2 * Math.PI);
        const dp = Math.abs((gc.pitch || 0) - (pv.pitch || 0));
        if (dy + dp < 1) sig.lookAmount += dy + dp;     // ignore snaps/teleports
      }
      pv.yaw = gc.yaw; pv.pitch = gc.pitch || 0;
    }
    if (p && p.pos) {
      if (pv.px !== undefined && !hud.onShip) {
        const d = Math.hypot(p.pos.x - pv.px, p.pos.z - pv.pz);
        if (d < 3) sig.moveDistance += d;               // ignore teleports and rescues
      }
      pv.px = p.pos.x; pv.pz = p.pos.z;
      if (p.attack && p.attack !== pv.attackRef) sig.attack++;
      pv.attackRef = p.attack || null;
      if (p.blocking && !pv.blocking) sig.block++;
      pv.blocking = !!p.blocking;
      if (p.dodgeKind && !pv.dodging) sig.dodge++;
      pv.dodging = !!p.dodgeKind;
    }
    if (f && f.stats && Number.isFinite(f.stats.casts)) sig.fruitPower = f.stats.casts;
  }

  // --- ship block for the tutorial's sailing steps ----------------------------------------
  let shipState;
  const ship = app.ship;
  if (ship && ship.body) {
    let distToMarker;
    for (const mk of markers) if (distToMarker === undefined || mk.dist < distToMarker) distToMarker = mk.dist;
    shipState = { sail: ship.body.sailTrim || 0, distToMarker, docked: !!ship.docked };
  }

  // Virtual (scripted) input counts as locked: the profiler and harness never hold a real
  // pointer lock, and the click-to-play scrim would be a lie in front of them.
  return {
    hud, onShip: hud.onShip, signals: sig, ship: shipState, app,
    pointerLocked: !!(app.input && (app.input.pointerLocked || app.input.virtual)),
  };
}

/** Point the menus at the real systems: real saves, real settings, real fruits and crew. */
function wireMenuCallbacks(app, ui) {
  if (!ui.setCallbacks) return;
  const cb = {};
  cb.resume = () => ui.closeMenu();
  cb.getStatus = () => {
    const p = app.player, q = app.quests;
    let bounty = 0; try { bounty = q ? q.bountyState().total : 0; } catch {}
    return { hp: p ? p.hp : 0, maxHp: p ? p.maxHp : 0, bounty, island: app.startIsland || 'At sea' };
  };
  if (app.save) {
    cb.listSlots = () => app.save.allSlots();
    cb.saveToSlot = (slot) => { const r = app.save.save(slot); ui.toast('Voyage logged', 'good'); return r; };
    cb.loadFromSlot = (slot) => {
      try { const ok = app.save.load(slot); if (ok) ui.toast('Voyage restored', 'good'); return ok; }
      catch (e) { ui.toast('Load failed: ' + e.message, 'bad'); return false; }
    };
    cb.eraseSlot = (slot) => app.save.erase(slot);
  }
  // Keys MUST match SETTINGS_SCHEMA in src/ui/menus.js ('master'/'sfx'/'music', shadowQuality
  // one of off/low/high/ultra) — the sliders read and write these exact names.
  const settings = app.settings = Object.assign({
    master: 0.8, sfx: 1, music: 0.7, shadowQuality: 'high',
    renderScale: 1, invertY: false, sensitivity: 1, telegraphMode: 'off',
  }, (app.save && app.save.loadSettings()) || {});
  const applySetting = (key, value) => {
    settings[key] = value;
    if (key === 'master' && app.audio && app.audio.setMasterVolume) app.audio.setMasterVolume(value);
    if (key === 'sfx' && app.audio && app.audio.setSfxVolume) app.audio.setSfxVolume(value);
    if (key === 'music' && app.audio && app.audio.setMusicVolume) app.audio.setMusicVolume(value);
    if (key === 'invertY') app.input.invertY = !!value;
    if (key === 'sensitivity') app.input.sensitivity = 0.0026 * (value || 1);
    if (key === 'shadowQuality' && app.renderer) app.renderer.shadow.enabled = value !== 'off';
    if (app.save) app.save.saveSettings(settings);
  };
  cb.getSettings = () => Object.assign({}, settings);
  cb.setSetting = applySetting;
  for (const k of Object.keys(settings)) applySetting(k, settings[k]);   // apply persisted now
  if (app.quests) {
    cb.getFruits = () => {
      // FruitSystem.wheelFruits() returns the exact shape the fruit wheel draws.
      try { if (app.fruit && app.fruit.wheelFruits) return app.fruit.wheelFruits(); } catch {}
      let unlocked = []; try { unlocked = app.quests.unlockedFruits(); } catch {}
      const current = app.fruit && app.fruit.def ? app.fruit.def.id : null;
      return unlocked.map(id => ({ id, name: id, unlocked: true, equipped: id === current }));
    };
    cb.selectFruit = (id) => { if (app.fruit && app.fruit.equip) { app.fruit.equip(id); ui.toast('Power changed: ' + id, 'good'); } };
    cb.getCrew = () => { try { return app.quests.crew(); } catch { return []; } };
    cb.getQuests = () => { try { return app.quests.questLog(); } catch { return []; } };
    cb.setTrackedQuest = (id) => { try { app.quests.track && app.quests.track(id); } catch {} };
    cb.abandonQuest = (id) => { try { app.quests.abandon(id); } catch {} };
  }
  cb.toast = (text, kind) => ui.toast(text, kind);
  ui.setCallbacks(cb);
}
