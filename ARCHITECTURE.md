# ARCHITECTURE — Grand Line Voxel

This file is **the contract**. No agent edits outside its ownership. If you need something
another owner controls, add it to §9 "Requests across boundaries" and the orchestrator routes it.

---

## 1. Non-negotiable global rules

1. **No downloaded assets.** No `.png`, `.jpg`, `.mp3`, `.wav`, `.glb`, `.gltf`, `.fbx`, no fonts.
   Every texture, mesh, animation and sound is generated in code at load time.
   `tools/lint-assets.mjs` fails the build if a binary asset appears.
2. **No `Math.random()`.** Ever. Use `src/core/rng.js`. `tools/lint-determinism.mjs` enforces it.
3. **No wall-clock reads in simulation.** No `Date.now()`, no `performance.now()` outside
   `core/profiler.js` and `core/clock.js`. Simulation time comes from `Clock.simTime`.
4. **No hardcoded colours.** Every colour resolves through `src/gen/palette.js` (`P.*`).
5. **Fixed timestep.** Simulation runs at exactly 1/60s steps. Rendering interpolates.
6. **Zero shader compilations during play.** Every material must be compiled during boot by
   `Renderer.prewarm()`. A shader compiled after boot is a gate failure.
7. **No placeholder text or dead UI.** If it is on screen, it works.

---

## 2. Coupled clusters (one owner each, sequential within the cluster)

The brief names three coupled systems. They are:

### Cluster A — RENDER (rendering, lighting, sky, water, tone mapping)
Owns: `src/render/renderer.js`, `sky.js`, `water.js`, `shadows.js`, `materials.js`,
`composite.js`, `src/gen/texture.js`, `src/gen/palette.js`.
Rationale: sky drives the light, light drives the water, water drives the tone mapping, and
the tone map decides whether any of it reads. Splitting these produces a frame that fights itself.

### Cluster B — CHARACTER (rig, animation, camera feel)
Owns: `src/entity/actor.js`, `rig.js`, `anim.js`, `src/gen/charmodel.js`, `src/render/camera.js`.
Rationale: how a character reads is 60% animation and 40% where the camera puts it. A rig change
without a camera change looks like a bug.

### Cluster C — COMBAT (combat, physics, hit feedback)
Owns: `src/combat/*`, `src/core/physics.js`, `src/render/fx.js`, `src/entity/enemy.js`.
Rationale: Hades-grade feedback is the loop hitstop → shake → flash → knockback → sound.
One owner or it desynchronises.

### Independent pieces (may run in parallel)
- **WORLD** — `src/world/*`, `src/gen/islands.js`, `src/gen/noise.js`, `src/gen/props.js`
- **SHIP** — `src/ship/*`
- **FRUIT** — `src/fruit/*`
- **QUEST** — `src/quest/*`
- **UI** — `src/ui/*`
- **AUDIO** — `src/audio/*`
- **HARNESS** — `tools/*`

---

## 3. Coordinate system, units, and vocabulary

- **Y up.** Right-handed. `-Z` is world north. Angles in radians; `yaw = atan2(dx, dz)`.
- **Forward and right, once and for all.** `forward(yaw) = (sin y, 0, cos y)`;
  **`right(yaw) = (-cos y, 0, sin y)`** (= forward x up). The tempting `(cos y, 0, -sin y)`
  is LEFT — that exact expression shipped three independent times (camera strafe basis, ship
  "starboard", strafe-animation selector) and inverted A/D for every player. Note `yaw+`
  rotates a heading toward the LEFT/port side (d forward/d yaw = -right). The ship's internal
  torque cluster is phase-locked to the mirrored lateral axis by design — see
  `SailingBody.lateral()` — with the screen-direction correction in `applyHelmInput` only.
- **1 world unit = 1 metre.** A voxel is **0.5 m** for terrain, **0.25 m** for characters
  (so a 14-voxel character is 3.5 m tall — chunky, per ART_BAR §1, and readable at distance).
- **Sea level is y = 0.** Below zero is underwater.
- **Chunk** = 32×96×32 voxels of terrain (16 m × 48 m × 16 m of world).
- **Sector** = 4096 m × 4096 m of ocean. Island placement is per-sector and deterministic.
- **Landmark island** = one of the 8 hand-authored islands. **Minor island** = generated.
- **Tile** = one 32×32 layer of the procedural texture array.
- **Beat** = one authored combat moment (a telegraph + its attack). Not a music term here.

## 4. Simulation contract

```
Clock.FIXED_DT = 1/60
app.step(dt)      // exactly one fixed step, deterministic, no rendering
app.render(alpha) // no state mutation allowed except render-only interpolation
```
Order inside `step()` is fixed and must not be reordered — determinism depends on it:
```
input → player → fruit → combat → enemies → npc → ship → world stream → physics → fx → quest → audio-events
```

## 5. Shared services (read-only to everyone but their owner)

| Service | Provided by | Read as |
|---|---|---|
| Lighting environment | Cluster A `Sky.env` | `app.sky.env` — sun dir, colours, fog, night, storm |
| Wave height at (x,z,t) | Cluster A `water.sampleHeight()` | `app.water.sampleHeight(x, z)` — CPU matches GPU exactly |
| Terrain height / block at world pos | WORLD `world.heightAt(x,z)`, `world.blockAt(x,y,z)` | |
| Damage application | Cluster C `combat.applyHit(target, hit)` | never mutate `hp` directly |
| Screen shake / hitstop | Cluster C `fx.impact(...)` | |
| Sound trigger | AUDIO `audio.play(name, opts)` | fire-and-forget, never awaited |
| Text on screen | UI `hud.*`, `ui.toast(...)` | no module draws its own DOM |
| Save data | `src/core/save.js` | each system implements `serialize()` / `deserialize()` |

## 6. The lighting contract (Cluster A owns, everyone obeys)

`Sky.env` is the only source of light values:
```
{ sunDir, sunColor, sunIntensity, skyColor, groundColor, ambientIntensity,
  fogColor, fogDensity, night, storm, rimColor, rimStrength, dayT, exposure }
```
Any module that needs to light something calls `materials.makeVoxelMaterial()` or
`makeActorMaterial()`. **No module writes its own lighting maths.** This is what keeps the
frame coherent and it is the difference between "a game" and "a tech demo".

## 7. Save format

`localStorage['glv.save.v1']`, one JSON object:
```jsonc
{
  "v": 1, "seed": 20260814, "simTime": 1234.5, "dayT": 0.35,
  "player": { "pos":[x,y,z], "yaw":0, "hp":100, "maxHp":100, "stam":100,
              "fruit":"gomu", "unlocked":["gomu"], "bounty":30000000, "berries":1200,
              "level":3, "xp":420 },
  "ship": { "pos":[x,y,z], "yaw":0, "sail":0.5, "hull":100, "upgrades":[] },
  "crew": [{ "id":"navigator_nami_like", "recruitedAt":123.4 }],
  "quests": { "shellsCove.q1": { "state":"done", "step":3, "counters":{} } },
  "world": { "visited":["shellsCove"], "cleared":["shellsCove.camp1"], "chests":["..."] },
  "ui": { "v": 2, "tutorial": { "learned": ["look","move"], "skipped": false,
          "done": false, "undocked": false, "total": 41.3 } }
}
```
Rules: forward-compatible (unknown keys preserved), never store derived data, never store
anything reconstructible from the seed. `flags.tutorialDone` is DERIVED (re-set every step
from `ui.tutorial.isDone()`), never stored. The ui slice carries its own `v`: a v1 slice
(`{i, done}` linear index) is migrated inside `Tutorial.deserialize` — the index maps onto
the first `i` lessons in table order — without touching the top-level save version.

## 8. Harness contract (HARNESS owns; everyone depends on it)

`harness.html?shot=<id>&seed=<n>&w=<px>&h=<px>` boots the app in **capture mode**:

- `window.__CAPTURE = true` before module load.
- No `requestAnimationFrame` loop. The harness drives the app explicitly.
- The page exposes `window.__H` once ready:
```js
window.__H = {
  ready: Promise<void>,        // resolves when boot + prewarm complete
  runShot(shotId): Promise<void>,   // seeks the world to the shot state, renders one frame
  stats(): object,             // draw calls, triangles, shader compiles, boot ms
  errors: string[],            // any console error captured
}
window.__SHOT_READY = true     // set after runShot resolves and the frame is presented
```
- **Isolation:** the capture tool opens a fresh browser *context and page* per shot. State
  cannot leak between shots. This is a hard requirement of the brief.
- **Determinism:** a shot is `(seed, shotId)` → identical pixels, always. Two consecutive
  capture runs must be **bit-identical** (verified by SHA-256 per PNG).

`profile.html?scenario=<id>&seed=<n>` boots in **profile mode**: a real RAF loop with
scripted input, real GPU, 1080p, and `window.__P.report()` returning the Profiler JSON.

### 8b. GPU measurement + adaptive quality (Cluster A owns; measured 2026-08-15)

Facts about this ANGLE/D3D11 stack, learned the hard way and not to be relearned:
- `gl.finish()` is a no-op and `fenceSync`+`clientWaitSync(0)` polling signals long before the
  driver executes (frames read 3 ms while a ~500 ms backlog stalled the loop). Fences do NOT
  bound frames-in-flight here.
- A `readPixels` drain works but costs a fixed ~+4 ms/frame and serialises CPU/GPU: a drain
  every frame has a ~12 ms measurement floor — larger than the 16.7 ms budget it would gate.
- The only valid GPU cost measurement is **throughput**: drain (untimed), then time N renders
  + one drain. The profiler samples such batches across each scenario and gates
  `max(cpu pXX, gpuBatch pXX)`; both distributions are in the report (`cpuOnly`, `gpuBatch`).
- The iGPU thermally throttles: identical work costs 11–12 ms rested and 17–18 ms hot. Numbers
  from back-to-back ablation runs are not comparable across minutes.

**Adaptive quality** (renderer opts, OFF by default): `dynamicRes` — internal render scale
0.7–1.0 driven by over-budget frame fraction per 30-frame window (`drsBudgetMs`: play 17.4,
vsync-aware; profile 15.9 with `drsUpMarginMs` 1.8 — step up only with real headroom, or the
controller hunts across the capacity cliff and the overshoot fails the p95 gate); composite
always outputs native canvas size. `temporalShadows` —
far cascade refreshes every other frame, its camera matrix frozen with its depth tile.
Play and profile entries opt in (`?drs=0` pins native). **Capture mode never enables either**:
both depend on wall-clock timing or frame parity, and deterministic pixel evidence cannot.
Entries pass frame durations into `renderer.updateDynamicRes(ms)`; the renderer reads no clock.

`playtest.html?script=<id>` boots in **playtest mode**: drives real input events through the
same input layer a human uses, and asserts on game state.

## 9. Requests across boundaries

Append here. Format: `owner-needed | requester | what | why`.

### From HARNESS (tools/*, src/scenarios.js, src/profile-entry.js, src/playtest-entry.js)

The profile and playtest harnesses drive the game the way a player does: they dispatch real
`KeyboardEvent` / `MouseEvent` / `WheelEvent` objects and assert on observable state. They never
call a gameplay function. That makes the following the harness's entire dependency surface.
Everything below is already coded against — each hook is feature-detected, so nothing breaks
while it is missing; the corresponding scenario or playtest step reports
`skipped: <system> not present` until the hook lands, then goes live with no harness edit.

**1. Input event targets and bindings**

- `input | harness | src/core/input.js must attach its listeners to the game canvas (`#game`),
  the document, or the window — anything in that chain. Harness events are dispatched at the
  canvas with `bubbles: true, composed: true`, so a listener anywhere on that path receives
  them. Listening on a detached element, or requiring Pointer Lock to be genuinely engaged
  before reading input, makes the game undriveable by automation. | Without this no perf and no
  playtest evidence can be produced at all.`
- `input | harness | listen to the MouseEvent family (mousedown / mouseup / mousemove /
  contextmenu / wheel). If you prefer the PointerEvent family, say so and the harness flips one
  flag (`createInputApi(canvas, { pointerEvents: true })`) — but pick one family, because
  listening to both double-counts a synthesised click. | The harness must fire exactly the
  events the game consumes, once each.`
- `input | harness | read look deltas from `event.movementX` / `event.movementY`, falling back
  to client-coordinate deltas when Pointer Lock is not engaged. | Headless browsers cannot
  engage Pointer Lock; the harness sets `movementX/Y` explicitly on every synthetic move.`
- `input | harness | the default bindings the harness drives are in `src/scenarios.js`
  (`BINDINGS`): WASD move, Space jump, ShiftLeft dodge, KeyE interact, KeyQ / KeyR fruit powers,
  KeyJ quest log, KeyM map, Escape pause, Enter confirm, Mouse0 light attack, Mouse2 heavy
  attack. Aboard ship the movement keys are reused (W/S sail, A/D steer, E dock). If the input
  owner picks different codes, change `BINDINGS` — it is the single place both the scenarios and
  the playtest name controls. | One binding table or the two drift.`

**2. Observable state the playtest asserts on**

The playtest asserts only on these. They must be readable without side effects.

- `player | harness | app.player.{ pos, yaw, hp, bounty, onShip } | steps board-ship,
  walk-ashore, bounty-increases and state-restored have no other observable. `pos` may be a
  `[x,y,z]` array or anything with `.x/.y/.z`.`
- `ship | harness | app.ship.{ pos, yaw, docked } | steps sail-to-first-island and dock.`
- `world | harness | app.world.heightAt(x, z), and app.world.firstIsland() returning
  { id, x, z, dockX, dockZ } (or nearestIsland(x, z)) | the harness must aim a voyage at the
  first island without hardcoding coordinates that a worldgen change would invalidate. A fixed
  fallback is used meanwhile, so the scenarios still run.`
- `combat | harness | app.combat.{ active, victories }, app.combat.nearestThreat() | steps
  enter-combat and win-a-fight. `victories` is a monotone counter — a boolean cannot express
  "won another one".`
- `enemies | harness | app.enemies.spawnWave({ kind, count, around:[x,z], radius }) and
  app.enemies.spawnBoss({ at:[x,z], tier }) | profile scenarios combat-3v1, combat-boss and
  stress-everything need a repeatable fight to measure; these are setup hooks, never used by the
  playtest.`
- `fruit | harness | app.fruit.{ useCount }, app.fruit.grant(id), app.fruit.setCooldownScale(s)
  | step use-devil-fruit and scenario fruit-spam. `useCount` is monotone for the same reason.`
- `quest | harness | app.quest.{ active[], completed[] }, app.quest.nearestGiver(),
  app.quest.nextObjective() | steps accept-quest and complete-quest. The two lookups let the
  script walk to the giver and the objective with the mouse instead of teleporting.`
- `ui / core | harness | app.flags.tutorialDone | step tutorial-completes. Derived from
  ui.tutorial.isDone() every step (§7). The tutorial is a TRIGGER TABLE, not a queue: each
  lesson has an arming precondition, `ui.tutorial.current` is the armed lesson on display and
  may be null when nothing is armed, `ui.tutorial.learned` is the Set of finished lesson ids,
  and done = all 13 learned or skipped (hold H). Keycaps derive from the input binds
  (capForAction) — tools/check-tutorial.mjs pins the four labels the old table got wrong.`
- `save | harness | app.save registered as a system, writing localStorage['glv.save.v1'] per §7,
  and reachable from the pause menu with the bound keys | the save -> reload -> restore round
  trip is an objective gate. The playtest presses Escape and Enter; if saving is only reachable
  another way, say which keys.`
- `player / ship | harness | teleport(x, y, z, yaw) and player.boardShip() | profile scenario
  *setup* only — never the playtest, which must reach every state through real input.`

**3. Waivers the harness would like to delete**

- `app (cluster A) | harness | route App.boot()'s boot timing and Renderer.prewarm()'s
  shader-compile timing through Profiler.mark() instead of calling performance.now() directly |
  they are the only two entries in the determinism lint's waiver table
  (tools/lint-determinism.mjs). Both are legitimate boot instrumentation, so the lint reports
  them as WAIVED rather than failing — but a waiver table that grows is a rule that is dying,
  and Profiler already owns real time.`

**From QUEST (`src/quest/*`)** — the quest layer is pure data + event folding; it never reads the
world. Everything below is what it needs pushed *to* it, or read *from* it.

- `world | quest | all 8 landmark islands must expose spawn points named exactly dock, plaza, boss_arena, vista, secret, npc_1..npc_4, chest_1..chest_3 | every goto/escort/openChest/findSecret objective addresses them as \`${islandId}.${pointName}\`. No extra points are needed.`
- `world | quest | call questSystem.notify('areaEntered', {point, dist}) on point entry, plus {secret:<pointId>} for the secret point and {npcId, point} when an escorted npc arrives | notify() is the only path progress takes; goto honours the authored radius when dist is supplied.`
- `world | quest | call notify('chestOpened',{id}), notify('itemCollected',{itemId,count}), notify('islandDocked',{islandId}), notify('propDestroyed',{propId, marineProperty}) | chests, quest items, docking and props drive 12 of the 33 chains.`
- `world | quest | place the 32 named NPCs exported as NPCS from src/quest/dialogue.js at their {island, spawn}; each carries a paintFace-compatible portrait spec built from P.* | npc_1..npc_4 on every island are already allocated, one per named person.`
- `world | quest | spawn the pickups in ITEMS and the destructibles in PROPS (src/quest/quests.js). Note cogHarbour.chest_3 and emberfall.chest_2 are opened by *other* islands' chains (drumPeaks.q1 and blossomTerrace.q3) | those two are deliberate cross-island errands.`
- `combat | quest | on defeat call notify('enemyDefeated',{kind,named,elite,fightId}) and notify('bossDefeated',{id,name,fightId}); on player damage call notify('damageTaken',{fightId}) | kind must be one of ENEMY_KINDS and id one of BOSSES (src/quest/quests.js). fightId is required for the winWithoutDamage objective in blossomTerrace.q2.`
- `combat | quest | read questSystem.activeBonuses(): meleeDamageMult, rangedDamageMult, maxHpMult, markNearestEnemy, markRange, outOfCombatRegen, regenDelay | crew bonuses are meant to be felt, not displayed.`
- `ship | quest | read questSystem.activeBonuses(): sailSpeedMult, turnRateMult, stormDriftMult, hullRepairPerSec, weatherWarningS, markerRange; and questSystem.shipUpgrades().effect for hullMaxAdd / ramDamageMult / stormSpeedMult / broadsideCount / cannonDamageMult | three upgrades are quest rewards.`
- `fruit | quest | gate equipping on questSystem.isUnlocked(fruitId) for gomu, mera, hie, suna, gura, zushi; on use call notify('fruitUsed',{fruitId, move, seen, town}) | seen+town is what raises bounty for using a power in public, and emberfall.q2 / marinefordReach.q2 have useFruit objectives.`
- `ui | quest | HUD/log read trackedQuest(), activeQuests(), availableQuests(), questLog(), progression(), bountyState() (incl. posterArt for the wanted poster) and drainEvents() for toasts; conversations run through DialogueRunner from src/quest/dialogue.js | no module draws its own DOM, so UI owns presentation of all of it.`
- `audio | quest | read bountyState().musicTension (0..1) each frame for mix tension | it already folds short-term heat into the tier value.`
- `world/combat | quest | spawn difficulty should read bountyState().spawnTierBonus, marinePatrolChance and ambushChance, and npc greeting should read questSystem.reactionTo(npcKind) | that is what makes the bounty number change the world rather than decorate the HUD.`

**From FRUIT (`src/fruit/*`)** — six powers whose entire point is that they change traversal and
combat, so FRUIT necessarily reaches further than a self-contained system. Every hook below is
**feature-detected**: FRUIT runs, and `tools/check-fruit.mjs` passes (444 checks), with none of
them present. Status as of this wave is marked per line.

**Open — these change what the player experiences**

- `app / boot | fruit | OPEN, and this is the one that matters. Call registerFruitFxTiles(tex) (exported from src/fruit/fruitfx.js and re-exported from fruits.js) inside App.opts.registerTiles, i.e. BEFORE tex.build(). src/main.js currently passes no registerTiles hook at all, so WORLD, ACTOR, SHIP and FRUIT tiles are all unregistered. | A DataArrayTexture has a fixed layer count; a tile added after the atlas upload does not exist on the GPU. FRUIT logs one console.warn and runs without its bespoke effect geometry rather than throwing, but that means the six silhouettes — the whole visual identity of the powers — do not draw.`
- `combat | fruit | OPEN. Call app.fruit.absorbHit(hit) BEFORE applying any damage to the player; a true return means the hit was consumed. hit should carry { damage, kind, source }. | Three mechanics are meaningless without it: the gomu balloon's absorb-and-return, suna's intangibility, and the untargetable window while burrowed. FRUIT cannot intercept damage from its own side because applyHit is COMBAT's entry point.`
- `combat | fruit | OPEN. applyStatus(target, name, seconds, power) with names frozen | burn | slow | blind | drain. | FRUIT currently writes damage.js's documented status fields (status.frozenT, burnT/burnDps/burnSrc, sandT) directly, because there is no setter. That works and it is commented as such, but it couples FRUIT to a struct layout instead of an API.`
- `player | fruit | OPEN. Each step read app.fruit.movement() -> { gravityScale, friction, airControlMult, speedMult, jumpMult, fallDamageMult, bounciness, waterWalk, untargetable, phasing, overrideJump, overrideVelocity } and apply it in place of the controller's own constants; skip the controller's velocity integration while overrideVelocity is true. | This is the traversal contract. FRUIT already works around the jump half by cancelling the controller's jump from its own step (it runs after PLAYER), but friction on ice, glide gravity and the sand-body speed penalty have no other route.`
- `player | fruit | OPEN. Read app.fruit.animState (a real Animator state name, or null) each step and play it when the controller has no stronger claim; call app.fruit.cancelCast('dodge') when a dodge starts. | The eight traversal poses (compression, grapple, air dash, hover, skate, burrow, glide, drown) have no other way onto the body.`
- `character (cluster B) | fruit | OPEN, optional but it is gomu's identity. rig.setLimbStretch(limbName, lengthMetres, dirX, dirY, dirZ). | Gum-Gum Pistol is "the arm keeps going". Without the hook fruitfx draws the limb as separate geometry beside the character, which reads as a thrown prop rather than a stretched arm.`
- `character (cluster B) | fruit | OPEN, quality. Cluster B ships three fruit poses — fruit_cast_a (horizontal throw), fruit_cast_b (overhead slam), fruit_channel (held) — and eighteen abilities map onto them. Each ability also declares `castPose`, one of the ten finer intents in FRUIT_CAST_POSES (castStretch, castSpin, castGuard, castCone, castUppercut, castPoint, castSweep, castRaise, castSlam, castAura). Adding those as states, or accepting a variant argument on play(), needs no FRUIT change: the gate already asserts every castPose is a published intent. | ART_BAR's Hades benchmark asks that each ability be "instantly legible as itself". Three poses for eighteen moves is the largest remaining gap against that.`
- `water (cluster A) | fruit | OPEN, optional. water.addSwell(x, z, radius, liftMetres) with a decaying lifetime. | Gura's Sea Quake is supposed to raise the sea around the ship. Without it the rings are FRUIT's own geometry and the ship only takes a vertical impulse.`
- `world | fruit | OPEN, optional. inTown(x, z). | QUEST raises bounty for a power used where townspeople can see it (`notify('fruitUsed', {seen, town})`); without this every fruit use reads as unwitnessed and that bounty path never fires.`
- `core | fruit | OPEN. app.flags.tutorialDone readable on the app. | The drowning rescue fires after 2.0 s and at 45% of the health drain before the tutorial completes, and after 5.0 s at full drain afterwards. "Devil fruit users cannot swim" must not soft-lock a player who walks off the first jetty; without the flag every player gets the harsher timing.`

**Satisfied by work already landed — recorded so the coupling is visible**

- `game.js | fruit | LANDED. app.addSystem('fruit', createFruitSystem(app)) in the fruit slot of §4, after player and before combat.`
- `combat | fruit | LANDED. applyHit(target, hit) with the hitbox.js Hit payload; FRUIT builds hits with makeHit() and the real ELEMENT/TAG vocabulary, so burn, frost stacking, freeze, shatter and sand-slow are all resolved by damage.js rather than duplicated. COMBAT's enemies roster is read through combat.enemies / activeEnemies().`
- `fx (cluster C) | fruit | LANDED. fx.impact(), addShake(), addHitstop(), ring(), quakeCrack(), gravityWell(), setAura() are all consumed. FRUIT draws its own six silhouettes into two CubeBatch meshes and never edits src/render/fx.js.`
- `world | fruit | LANDED. setBlock / blockAt / heightAt, with the block vocabulary resolved through app.blocks (the BlockRegistry game.js builds). Hie freezes the sea, mera burns wooden barriers, gura cracks shortcuts — all real voxel writes, all reverted on load, ice additionally on a melt timer.`
- `player | fruit | LANDED. PLAYER calls app.fruit.canUse(index) before posing a cast and reads app.fruit.airJumps each step; both are implemented. airJumps is non-zero only for mera and only while its flame is not smothered, which is how the rain drawback reaches the movement layer.`
- `ui | fruit | LANDED on FRUIT's side. app.fruit.hudState() returns the `st.fruit` block src/ui/hud.js draws; app.fruit.wheelFruits() returns the array src/ui/menus.js getFruits() expects; selectFruit(id) should call app.fruit.equip(id).`
- `audio | fruit | sound names, fire-and-forget, a missing name must be a no-op: fruit_gomu_{stretch,hit,gatling,inflate,return,launch,zip,bounce}, fruit_mera_{roar,pillar,kindle,crackle,dash}, fruit_hie_{charge,freeze,wall,spikes,sheet,ramp}, fruit_suna_{disperse,fail,storm,drain,burrow,surface}, fruit_gura_{windup,slam,crack,charge,seaquake,leap,break}, fruit_zushi_{pull,crush,rise,impact,well}, fruit_shatter, player_drown_start, player_rescued, ui_denied.`

**The two input verbs FRUIT owns**

FRUIT binds no new keys. It reuses `ability1..3` for the three combat moves, and gives JUMP and
SPRINT a second, fruit-specific meaning:

| fruit | JUMP | SPRINT |
|---|---|---|
| gomu | hold to compress, release to launch | fire a grapple at the aim point and zip to it |
| mera | press in mid-air to dash (3, refilled on landing) | hold in the air to hover on a jet |
| hie | — | freeze the sea into a walkable sheet, or raise an ice ramp on land |
| suna | hold on the ground to burrow; press again to surface | hold in the air to ride a sand stream |
| gura | hold to charge a shockwave leap | punch a hole through what is in front of you |
| zushi | hold in the air to glide | plant a gravity well and ride it upward |

Six fruits times five bespoke keys is a control scheme nobody learns; two verbs that mean
something different per fruit is one the player masters.

**Animator states FRUIT drives** — mirrored by `REQUIRED_ANIM_STATES` in `src/fruit/abilities.js`
and asserted against Cluster B's exported `STATE_NAMES` by `tools/check-fruit.mjs`:

```
fruit_cast_a fruit_cast_b fruit_channel dodge_dash jump_air sprint swim_stroke fall swim_idle
```

### WORLD requests (from `src/world/*`)

The world owns placement, streaming and the terrain queries. Everything below is either a hook
it needs called, or a value it publishes that somebody else has to pick up. All of it is
feature-detected, so nothing is broken while a request is open.

- `game.js (orchestrator) | world | register the three systems in §4 order:
  `app.addSystem('world', createWorldSystem(app))`, then
  `app.addSystem('weather', createWeatherSystem(app, { world: app.world }))`, then
  `app.addSystem('spawn', createSpawnSystem(app, { world: app.world }))`. WEATHER and SPAWN both
  take the World by reference and must be constructed after it. | they are three systems, not
  one, because weather is a pure field and spawn is pure bookkeeping — only the World holds
  voxels, and keeping them apart is what lets the self-check run all three headless.`
- `app (cluster A) | world | call `registerWorldTiles(tex)` from `App.boot`'s `registerTiles`
  hook (`import { registerWorldTiles } from './world/world.js'`) | a `DataArrayTexture` has a
  fixed layer count once built, and systems are constructed after `tex.build()`, so the world
  cannot register its own rain / foam / storm-light tiles in time. Every consumer falls back to
  an existing tile when the hook is absent, so this is fidelity, not correctness.`
- `voxel mesher (`src/gen/voxel.js`) | world | hoist the two per-cell array allocations out of
  `meshVolume()`'s mask sweep — `const p = [0, 0, 0]` and `const n = [p[0]+dx, ...]` — into two
  loop-invariant scratch arrays. No behaviour change. | MEASURED: a 32x96x32 half-filled chunk
  takes 35.0 ms, and an isolated sweep shows ~885 000 short-lived arrays accounting for roughly
  three quarters of it. Chunk meshing is the largest line item in the streaming budget; after
  the world's own bounding-box trimming the median chunk is 3.3 ms, but the p95 is 15 ms. The
  hoist is worth about 3x and is the highest-value change left in the streaming path.`
- `islands (`src/gen/islands.js`) | world | a resumable island build, or a cheaper one.
  `buildLandmark()` / `generateMinorIsland()` are atomic and MEASURED at ~58 ms each (8 builds,
  mean 58 ms). The streamer absorbs the cost into its work-unit debt so the average budget
  holds, but the frame that runs the build still stalls for the full 58 ms — once per island as
  it crosses the 2600 m load radius, so roughly once every two minutes of sailing. Everything
  else in the streaming path is now under 4 ms per step (worst idle step measured at 1.35 ms),
  which makes this the only remaining stall in a steady-state voyage. Either a build that yields
  between phases, or a fast path producing only the height map for islands beyond the near
  radius, removes it.`
- `render (cluster A) | world | consume `app.post.flash` (0..1) in the composite as a brief
  additive white lift | WEATHER writes it on every lightning strike. Until it is consumed the
  flash is delivered by scaling `Sky.env.exposure / ambientIntensity / rimStrength` for one
  frame inside `WeatherSystem.preRender()` — which works and cannot accumulate, because
  `Sky.update()` reassigns all three every frame, but it is a second place the frame's lighting
  is being scaled and it should be one.`
- `ship | world | read `world.currentAt(x, z)` (m/s, zero everywhere except inside a whirlpool)
  and `world.seaEventAt(x, z)` (`whirlpool` / `becalmed` / `seaKing`, with `t` = 0..1 depth into
  the zone) | the sea events only exist as gameplay if the ship is pulled by them: a becalmed
  zone should kill the sail and a whirlpool should be survivable but expensive.`
- `player / ship | world | call `world.setFocus(x, y, z, yaw)` each step, or leave it: the world
  falls back to `app.player.pos` -> `app.ship.pos` -> `app.camera.position`, and the camera
  fallback switches off permanently the first time `setFocus` is called. The yaw matters —
  chunks inside the view cone are meshed first. | `app.camera` is interpolated in `preRender`,
  so the world deliberately never reads it during `step()` once a simulation-owned focus
  exists; reading it would make the streaming schedule depend on the render alpha.`
- `combat / fruit | world | call `world.setBlock(x, y, z, 0)` to destroy terrain. Affected chunks
  jump to the head of the mesh queue automatically and the edit is written into
  `world.serialize().edits`, keyed by island. | that is the whole terrain-destruction contract.
  Note also that `world.isSolidAt(x, y, z)` now exists, so physics resolves its preferred
  predicate rather than falling through to `heightAt`.`
- `combat | world | call `spawn.markCleared(campId)` when a camp is wiped out | the camp ids are
  published on the objects handed to `enemies.spawnWave()` via `spawn.drain()`
  (`{type:'camp', id, kind, count, around, radius, elite, tier}`). Without the call, sailing away
  and back resurrects the camp, because the island is genuinely rebuilt from the seed.`
- `ui / ship | world | `world.nearbyIslandDiscs(x, z)` is pushed into `water.setNearbyIslands()`
  by the world itself every sixth step when `app.water` exists; pass `{ driveWater: false }` to
  the factory if the orchestrator would rather own that call. | stated so it is not wired twice.`

**From SHIP (`src/ship/*`)** — the ship is a hero object: one 19 m voxel hull with 17k triangles,
six animated sub-meshes, and a crew standing on a deck that moves. Everything below is already
feature-detected, so the ship runs today with only render + gen + quest present and lights each
item up as it lands.

- `app (cluster A) | ship | call registerShipTiles(tex) from src/ship/shipmodel.js inside
  App.boot(), in the same place registerCharacterTiles() is called — i.e. BEFORE
  this.tex.build(). It adds 22 layers. | A DataArrayTexture has a fixed layer count. Tiles
  registered after the atlas is uploaded do not exist on the GPU, and the ship renders with
  whatever layer index happens to be there. This is the one item that is a visual bug rather
  than a missing feature. Passing it as opts.registerTiles works equally well.`
- `game.js | ship | construct with createShipSystem(app, { islands, animator, start }) and, once
  the world has generated, call app.ship.dock.setIslands(list). The list may be LANDMARKS
  records ({ id, name, worldPos, dockPos, radius }) or flat ({ id, name, x, z, dockX, dockZ,
  radius }) — normaliseIslands() in src/ship/dock.js accepts both. | Without islands the ship
  sails but never finds a harbour.`
- `world | ship | world.heightAt(x, z) must return the SEABED height at sea (negative below the
  waterline), not clamp to 0. | It is the ship's grounding test: water under the keel is
  waveHeight - heightAt - 1.75 m. Clamped to zero, the whole ocean reads as a sandbank.`
- `cluster B | ship | an Animator factory from src/entity/anim.js, shaped
  (charModel, seed) => { play(clip, env), step(dt, env), pose }, where `pose` is
  { root:{y,pitch,roll,yaw}, torso, head, armL, armR, legL, legR } with each part carrying
  {rx,ry,rz}. Inject it as createShipSystem(app, { animator }) or app.ship.crew.setAnimator(fn).
  Clips the crew ask for: idle_helm, idle_rigging, idle_lookout, idle_galley, idle_repair, walk,
  climb, brace, combat, cheer. | Until then src/ship/crewaboard.js drives the same clip names
  and the same pose shape with its own CrewPoser, so the crew are animated either way; the
  injection point exists so Cluster B's rig replaces it without a ship-side edit.`
- `cluster C (fx) | ship | a spray emitter, any one of fx.spray(x, y, z, dirX, dirZ, power),
  fx.burst('spray', x, y, z, opts), fx.particles(x, y, z, opts) or fx.emit('spray', ...). |
  emitSpray() in src/ship/sailing.js probes for all four and no-ops if none exist. The bow
  buries itself and throws water perhaps twice a minute in a breeze and constantly in a storm;
  it is the single cheapest thing that sells the sea.`
- `cluster C (enemies) | ship | enemies.spawnWave({ kind, count, around:[x,z], radius, onDeck,
  points }) should honour `points` — an array of { kind, x, y, z } world positions. | Marine
  boarders must appear ON the deck. src/ship/dock.js validates each position against the deck
  bounds before handing them over; spawning them on a radius around the hull puts them in the
  sea or inside the hull.`
- `ui | ship | draw app.ship.hud() — { speedKnots, pointOfSail, heelAngle, apparentWind,
  sailTrim, helm, anchorDown, luff, broaching, beached, hull, hullMax, tier, upgrades,
  dockState, prompt, island, crew[], patrol, aboard } — and show `prompt` when it is non-null.
  It is never a placeholder: if it is set, the bound key does the thing it says. | No module
  draws its own DOM (§5).`
- `input / ui | ship | while docked, bind the `anchor` action (KeyG) to app.ship.castOff(). At
  sea the ship already consumes moveX (helm, held), moveZ (sail trim), sailUp/sailDown
  (KeyR/KeyF, one notch), anchor (KeyG, drop/weigh) and interact (KeyE, dock / go ashore). |
  Casting off is the one verb with no key yet; everything else maps to the existing ACTIONS.`
- `ui / world | ship | the map screen should call app.ship.fastTravel(islandId) for any id in
  app.ship.dock.destinations(). | Fast travel is a real scripted voyage, not a fade: the hull
  keeps riding the swell and laying a wake for 7-22 s. The player stays on deck throughout.`

## 10. Ownership map (updated per wave)

| Piece | Owner agent | Status |
|---|---|---|
| A-render | orchestrator | in flight |
| B-character | — | not started |
| C-combat | — | not started |
| world | — | not started |
| ship | — | not started |
| fruit | — | not started |
| quest | — | not started |
| ui | — | not started |
| audio | — | not started |
| harness | harness-owner | built — `node tools/gate.mjs` runs every objective gate |

---

## 9b. Requests across boundaries — from CLUSTER C (combat)

Owner of `src/combat/*`, `src/core/physics.js`, `src/render/fx.js`, `src/entity/enemy.js`.
Every item below is **feature-detected**: cluster C runs, and `node tools/check-combat.mjs`
passes, with none of them present. Each one goes live the moment the named owner lands it, with
no edit on the combat side.

### Registration (orchestrator, `src/game.js`)

```js
import { createPhysicsSystem } from './core/physics.js';
import { createTelegraphSystem } from './combat/telegraph.js';
import { createCombatSystem, createEnemiesFacade } from './combat/combat.js';
import { createFxSystem } from './render/fx.js';

// inside App.boot()'s onSystems hook, in ARCHITECTURE §4 order:
const physics    = app.addSystem('physics',    createPhysicsSystem(app));
const telegraphs = app.addSystem('telegraphs', createTelegraphSystem(app));
const combat     = app.addSystem('combat',     createCombatSystem(app, { maxAttackers: 2 }));
const fx         = app.addSystem('fx',         createFxSystem(app));
app.enemies = createEnemiesFacade(combat);   // spawn hooks for the profile harness (§9)
```

Two ordering constraints, both load-bearing:

- `app (cluster A) | combat | createFxSystem(app) MUST be called inside opts.onSystems, i.e.
  before App.prewarmAll() runs | FX pushes its three ShaderMaterials onto app.extraMaterials,
  which prewarmAll() reads. Constructed later, those three shaders compile on the first presented
  frame and the "zero shader compilations during play" gate (§1.6) fails.`
- `app (cluster A) | combat | register physics BEFORE combat | combat falls back to a private
  PhysicsSystem when app.physics is absent, which works but means the broadphase is built twice.`

### From WORLD (`src/world/*`)

- `world | combat | ONE of: world.isSolidAt(x,y,z)->bool (preferred), world.blockAt(x,y,z)->id
  together with app.blocks.isSolid(id), or world.heightAt(x,z) | src/core/physics.js resolves
  these in that order (makeSolidFn). Everything in the game that collides — actors, projectiles,
  line-of-sight, the DDA raycast — goes through the resolved predicate. Coordinates are world
  metres, not voxel indices; the 0.5 m grid is applied inside physics.`
- `world | combat | world.heightAt(x,z) | ground decals, spawn placement and the rifleman's
  cover sampling. Without it every decal lands at y = 0.`

### From CLUSTER B (rig / animation / camera)

- `rig | fx | actor.rig.setFlash(colourHex, amount) | the white flash on a struck body. FX
  already writes actor.hitFlash / actor.hitFlashColor as a fallback, so the rig can simply read
  those instead if that is easier — but the flash must reach the actor material's uFlash uniform
  or a landed hit has no impact frame.`
- `rig | fx | actor.rig.setAura(colourHex, amount) | the character-level half of a telegraph.
  Fallback fields are actor.aura / actor.auraColor. This is the tell that lets a player fight by
  watching the enemy instead of the floor; ground decals alone are not enough at 8–15 m.`
- `rig | fx | actor.rig.setDissolve(t) | the death dissolve, driving uDissolve. Fallback field is
  actor.dissolve, written every step for 0.75 s after a kill.`
- `camera | fx | read app.fx.shake = { x, y, roll } each frame and add it to the camera transform
  | trauma-based, already budgeted and decayed; x/y are in metres of camera offset and roll is in
  radians. Cluster C deliberately does not touch the camera.`
- `rig | combat | an attack wind-up pose driven by actor.telegraphT (0..1) would strengthen the
  tell further. Optional; the aura ring and pose flash carry it meanwhile.`

### From PLAYER (orchestrator)

Combat drives the player's attack, block and dodge state machine off `app.player`. It needs:

- `player | combat | app.player exists with a physics body (x/y/z, vx/vy/vz, radius, height,
  mass, yaw) and is passed once to combat.register(app.player) | combat writes hp, poise,
  stamina, iframes, stagger, blocking, blockTime, recovery and attacking onto it.`
- `player | combat | app.player.intents = { attack, heavy, block, dodge } | pressed-edge for
  attack/heavy/dodge, held for block. If absent, combat falls back to reading app.input.state
  directly (pressed.attack / pressed.heavy / down.block / pressed.dodge), so the game is already
  playable — but the player system should own the mapping.`
- `player | combat | consume app.player.dodgeImpulse = { x, z, t } | combat owns the i-frames,
  the stamina cost and the speed lines; the MOVER owns the movement. t counts down from 0.22 s.`
- `player | combat | apply movementScale(player) from src/combat/damage.js to the walk speed |
  this is what makes sand slow you, a stagger root you and a freeze stop you dead. Without it,
  every status effect is invisible.`

### From UI

- `ui | combat | the colourblind telegraph setting | telegraph.js reads, in order:
  app.settings.telegraphMode, app.settings.colourblindTelegraphs, then
  app.ui.menus.cb.getSettings().telegraphMode. The UI menu already ships telegraphMode with
  options off/deuter/protan/tritan and that is the one cluster C treats as canonical — the
  brief's `app.settings.colourblindTelegraphs` name is honoured as an alias. No UI change needed.`
- `ui | combat | keep ui.damageNumber(worldPos, value, kind, projectFn) | FX routes every damage
  number through it with a reusable projection closure. Kinds used: hit, crit, block, parry.`
- `ui | combat | the HUD target bar can read combat.nearestThreat(), which returns
  { name, hp, maxHp, tier, dist, actor, telegraph:{ kind, t, label } } where kind is exactly the
  'guard' | 'warn' | 'danger' string hud.js already expects | no shape change on either side.`

### From AUDIO

Combat fires these by name through `audio.playAt(name, x, y, z)` (falling back to `play`). All of
them already exist in `src/audio/sfx.js`; this list is here so a rename is caught:

`swing_light, swing_heavy, hit_flesh, hit_armor, hit_crit, block, parry, guard_break,
dodge_woosh, enemy_windup, enemy_windup_unblockable, death_enemy, death_player, land_hard,
water_enter, water_exit`

### From QUEST

Already implemented against `src/quest/quest.js` as landed; listed for completeness.

- combat emits `notify('enemyDefeated', { kind, named, elite, fightId })` with `kind` drawn from
  `ENEMY_KINDS`, and `notify('bossDefeated', { id, name, fightId })` when the enemy carries a
  `bossId` set by `combat.startEncounter`. `fightId` is always supplied.
- combat emits `notify('damageTaken', { fightId })` whenever the player is hit.
- combat reads `questSystem.activeBonuses()` for `meleeDamageMult` / `rangedDamageMult` every
  resolution, and calls the optional `addXp(n)` / `addBerries(n)` if they exist.

### Waivers cluster C would like NOT to need

None. `src/core/physics.js`, `src/combat/*`, `src/entity/enemy.js` and `src/render/fx.js` contain
no `Math.random`, no wall-clock read and no hardcoded colour, and `node tools/lint-determinism.mjs`
reports them clean.
