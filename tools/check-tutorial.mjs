#!/usr/bin/env node
// Tutorial contract check (node, no browser).
//
// The one bug class this exists to kill: a lesson that PRINTS a key its satisfy-condition
// does not LISTEN to. The old tutorial shipped four of those (sail F-for-R, dock F-for-G,
// block RMB-for-Q, dodge SPACE-for-C) — each an unwinnable dead end for a player obeying
// the on-screen instruction, and invisible to the playtest because the driver taps the real
// bindings, never the printed label. So: caps must derive from the binds (section 2 pins the
// four repaired labels), the trigger table must be drivable to completion against a mock
// snapshot (3), the boot-berth dock self-pass must stay dead (3), preemption must follow the
// urgency rules (4), and legacy v1 saves must map into the lessons set (5).

import { TUTORIAL_STEPS, Tutorial } from '../src/ui/tutorial.js';
import { DEFAULT_BINDS, capForAction, codeLabel } from '../src/core/input.js';
import { logTutorialEvent } from '../src/core/telemetry.js';

let fails = 0;
const fail = (m) => { console.error('  FAIL  ' + m); fails++; };
const ok = (m) => console.log('  ok    ' + m);
const assert = (cond, m) => (cond ? ok(m) : fail(m));

const DT = 1 / 60;
const stepN = (T, gs, n) => { for (let i = 0; i < n; i++) T.step(DT, gs); };
// Ride out the celebrate flash (0.7 s) plus the completion dwell of the next lesson.
const settle = (T, gs) => stepN(T, gs, 80);

// --- 1. table shape --------------------------------------------------------------------
console.log('--- 1. table shape');
{
  const ids = new Set();
  for (const s of TUTORIAL_STEPS) {
    if (ids.has(s.id)) fail(`duplicate lesson id ${s.id}`);
    ids.add(s.id);
    if (typeof s.priority !== 'number') fail(`${s.id}: priority missing`);
    if (typeof s.arm !== 'function') fail(`${s.id}: arm() missing`);
    if (typeof s.check !== 'function') fail(`${s.id}: check() missing`);
    const cap = s.capOverride || capForAction(s.action, { binds: DEFAULT_BINDS });
    if (!cap) fail(`${s.id}: action '${s.action}' derives no keycap`);
  }
  assert(TUTORIAL_STEPS.length === 13, `13 lessons (${TUTORIAL_STEPS.length})`);
  assert(ids.size === TUTORIAL_STEPS.length, 'lesson ids unique');
  ok('every lesson has priority, arm(), check(), and a derivable keycap');
}

// --- 2. cap regression pins ------------------------------------------------------------
console.log('--- 2. keycap derivation (the four repaired labels stay repaired)');
{
  const capOf = (id) => {
    const s = TUTORIAL_STEPS.find((x) => x.id === id);
    return s.capOverride || capForAction(s.action, { binds: DEFAULT_BINDS });
  };
  assert(capOf('sail') === 'R', `sail prints R (was F, which LOWERS the sail) — got ${capOf('sail')}`);
  assert(capOf('dock') === 'G', `dock prints G (was F; anchor is G) — got ${capOf('dock')}`);
  assert(capOf('block') === 'Q', `block prints Q (was RMB, which is heavy attack) — got ${capOf('block')}`);
  assert(capOf('dodge') === 'C', `dodge prints C (was SPACE, which jumps) — got ${capOf('dodge')}`);
  assert(capOf('attack') === 'LMB', 'attack prints LMB');
  assert(capOf('look') === 'MOUSE', 'look prints MOUSE');
  assert(codeLabel('Space') === 'SPACE' && codeLabel('ControlLeft') === 'CTRL'
    && codeLabel('Digit1') === '1' && codeLabel('KeyC') === 'C', 'codeLabel spot checks');
  const remapped = capForAction('block', { binds: { ...DEFAULT_BINDS, block: ['KeyV'] } });
  assert(remapped === 'V', `remapped bind changes the printed cap (block→V, got ${remapped})`);
}

// --- 3. mock-snapshot playthrough ------------------------------------------------------
console.log('--- 3. trigger-table playthrough to isDone()');
{
  // A controllable snapshot. Everything the arm/check functions read, driven stage by stage.
  const gs = {
    signals: {
      lookAmount: 0, moveDistance: 0, attack: 0, block: 0, dodge: 0,
      fruitPower: 0, npcTalk: 0, questAccept: 0, mapOpen: 0,
    },
    onShip: false,
    ship: { sail: 0, distToMarker: 30, docked: true },
    hud: { target: null, fruit: null },
    app: {
      clock: { simTime: 0 },
      input: { binds: DEFAULT_BINDS, pointerLocked: true },
      ship: { dock: { state: 'docked' } },
      npc: { nearest: () => null },
      quests: { availableQuests: () => [] },
      player: { pos: { x: 0, z: 0 } },
    },
  };
  const T = new Tutorial({});
  let dockLearnedWhileBerthed = false;
  const watchDock = () => { if (T.learned.has('dock') && !T.flags.undocked) dockLearnedWhileBerthed = true; };

  const expectCurrent = (id, note) => {
    stepN(T, gs, 5);
    assert(T.currentId === id, `${note}: current is ${T.currentId} (want ${id})`);
  };

  expectCurrent('look', 'boot');
  gs.signals.lookAmount = 4; settle(T, gs); watchDock();
  assert(T.learned.has('look'), 'look learned from the look signal');

  expectCurrent('move', 'after look');
  gs.signals.moveDistance = 10; settle(T, gs); watchDock();
  assert(T.learned.has('move'), 'move learned from walked metres');

  // Ashore with no NPC and no target: attack (25) outranks the board directive (15).
  expectCurrent('attack', 'basics done, ashore');
  gs.signals.attack = 3; settle(T, gs); watchDock();
  assert(T.learned.has('attack'), 'attack learned from three swings');

  // A villager steps into range: talk (70) beats fruit (30).
  gs.hud.fruit = { id: 'gomu' };
  gs.app.npc.nearest = () => ({ npcId: 'mira' });
  expectCurrent('talk', 'NPC in range');
  gs.signals.npcTalk = 1; settle(T, gs); watchDock();
  assert(T.learned.has('talk'), 'talk learned');

  gs.app.quests.availableQuests = () => [{ giver: 'mira' }];
  expectCurrent('quest', 'quest available after talk');
  gs.signals.questAccept = 1; settle(T, gs); watchDock();
  assert(T.learned.has('quest'), 'quest learned');

  // An enemy telegraphs a blockable swing: block goes urgent (92) over fruit (30).
  gs.hud.target = { telegraph: { kind: 'guard' } };
  expectCurrent('block', 'blockable telegraph is urgent');
  gs.signals.block = 1; settle(T, gs); watchDock();
  assert(T.learned.has('block'), 'block learned');

  gs.hud.target = { telegraph: { kind: 'danger' } };
  expectCurrent('dodge', 'red telegraph is urgent');
  gs.signals.dodge = 2; settle(T, gs); watchDock();
  assert(T.learned.has('dodge'), 'dodge learned');

  gs.hud.target = null;
  expectCurrent('fruit', 'calm again: fruit outranks the directives');
  gs.signals.fruitPower = 1; settle(T, gs); watchDock();
  assert(T.learned.has('fruit'), 'fruit learned');

  expectCurrent('map', 'map directive (20) over board (15)');
  gs.signals.mapOpen = 1; settle(T, gs); watchDock();
  assert(T.learned.has('map'), 'map learned');

  expectCurrent('board', 'board is the last ashore directive');
  gs.onShip = true; settle(T, gs); watchDock();
  assert(T.learned.has('board'), 'board learned from standing on deck');

  expectCurrent('sail', 'aboard: sail first');
  gs.ship.sail = 0.6; settle(T, gs); watchDock();
  assert(T.learned.has('sail'), 'sail learned');

  expectCurrent('steer', 'sail up: steer');
  settle(T, gs); watchDock();   // berthed: marker inside 150 m satisfies on its own
  assert(T.learned.has('steer'), 'steer learned at the near marker');

  // The harbour round trip. The ship has been docked since boot — the lesson must NOT have
  // completed at any point before a genuine cast-off.
  expectCurrent('dock', 'dock lesson last at sea');
  assert(!dockLearnedWhileBerthed && !T.learned.has('dock'),
    'dock never self-passed from the boot berth');
  // Casting off flips docked false on the same frame in the real dock state machine
  // (docked is a getter on state === DOCKED); the mock must agree.
  gs.app.ship.dock.state = 'undocking'; gs.ship.docked = false; stepN(T, gs, 10);
  assert(T.flags.undocked === true, 'cast-off sets the undocked flag');
  gs.app.ship.dock.state = 'approach'; stepN(T, gs, 30);
  assert(!T.learned.has('dock'), 'dock not learned while still approaching');
  gs.app.ship.dock.state = 'docked'; gs.ship.docked = true; settle(T, gs);
  assert(T.learned.has('dock'), 'dock learned after the round trip');

  assert(T.isDone(), 'all 13 lessons learned → isDone()');
}

// --- 4. selection: hysteresis and urgency ----------------------------------------------
console.log('--- 4. preemption rules');
{
  const mkGs = () => ({
    signals: { lookAmount: 0, moveDistance: 0, attack: 0, block: 0, dodge: 0, fruitPower: 0, npcTalk: 0, questAccept: 0, mapOpen: 0 },
    onShip: false,
    ship: { sail: 0, distToMarker: 500, docked: true },
    hud: { target: null, fruit: null },
    app: {
      clock: { simTime: 0 }, input: { binds: DEFAULT_BINDS },
      ship: { dock: { state: 'docked' } },
      npc: { nearest: () => null }, quests: { availableQuests: () => [] },
      player: { pos: { x: 0, z: 0 } },
    },
  });
  // Learn 'look' honestly: the counter baseline is captured at activation, so the signal
  // must move AFTER the lesson is live (pre-seeding it tests nothing).
  const learnLook = (T, gs) => {
    stepN(T, gs, 5);
    gs.signals.lookAmount += 9;
    settle(T, gs);
  };

  // (a) A half-walked move lesson is NOT hijacked by a villager stepping into range.
  let gs = mkGs();
  let T = new Tutorial({});
  learnLook(T, gs);
  stepN(T, gs, 10);                                 // move is current
  gs.signals.moveDistance = 5;                      // progress: 5 of 9 metres
  stepN(T, gs, 10);
  assert(T.currentId === 'move' && T.progress > 0, 'move current with progress');
  gs.app.npc.nearest = () => ({ npcId: 'mira' });   // talk (70) arms, non-urgent
  stepN(T, gs, 30);                                 // half a second
  assert(T.currentId === 'move', 'progressing lesson resists a non-urgent higher priority');

  // (b) A dead-air lesson (no progress, not yet shown) IS replaced immediately.
  gs = mkGs();
  T = new Tutorial({});
  learnLook(T, gs);
  stepN(T, gs, 10);
  assert(T.currentId === 'move' && T.progress === 0, 'move current, untouched');
  gs.app.npc.nearest = () => ({ npcId: 'mira' });
  stepN(T, gs, 3);
  assert(T.currentId === 'talk', 'untouched lesson yields to a contextual one');

  // (c) An urgent telegraph preempts regardless of progress.
  gs = mkGs();
  T = new Tutorial({});
  learnLook(T, gs);
  stepN(T, gs, 10);
  gs.signals.moveDistance = 5;
  stepN(T, gs, 10);
  assert(T.currentId === 'move', 'move current again');
  gs.hud.target = { telegraph: { kind: 'guard' } }; // incoming blockable swing
  stepN(T, gs, 3);
  assert(T.currentId === 'block', 'urgent telegraph preempts at once');
}

// --- 5. serialization ------------------------------------------------------------------
console.log('--- 5. serialize v2 + v1 migration');
{
  const T = new Tutorial({});
  T.learned.add('look'); T.learned.add('move'); T.flags.undocked = true;
  const s = T.serialize();
  const T2 = new Tutorial({});
  T2.deserialize(s);
  assert([...T2.learned].join() === 'look,move' && T2.flags.undocked && !T2.isDone(),
    'v2 round-trip preserves learned/undocked');

  const v1 = new Tutorial({});
  v1.deserialize({ i: 5, done: false, total: 12 });
  assert([...v1.learned].join() === TUTORIAL_STEPS.slice(0, 5).map((x) => x.id).join()
    && !v1.isDone(), 'v1 {i:5} maps to the first five lessons of the legacy order');

  const v1done = new Tutorial({});
  v1done.deserialize({ i: 13, done: true, total: 60 });
  assert(v1done.isDone() && !v1done.skipped, 'v1 completed save stays done');

  const v1skip = new Tutorial({});
  v1skip.deserialize({ i: 4, done: true, total: 9 });
  assert(v1skip.isDone() && v1skip.skipped, 'v1 done-before-the-end reads as a skip');

  const junk = new Tutorial({});
  junk.deserialize({ learned: ['look', 'no-such-lesson'], skipped: false });
  assert([...junk.learned].join() === 'look', 'unknown lesson ids are dropped on load');
}

// --- 6. telemetry inert under node -----------------------------------------------------
console.log('--- 6. telemetry');
assert(logTutorialEvent('lesson_armed', { lesson: 'x', simTime: 0 }) === false,
  'telemetry drops events without localStorage, never throws');

console.log(fails ? `\n=== RESULT ===\nFAIL — ${fails} check(s) failed.` : '\n=== RESULT ===\nPASS — caps derive from binds, the trigger table completes, v1 saves migrate.');
process.exit(fails ? 1 : 0);
