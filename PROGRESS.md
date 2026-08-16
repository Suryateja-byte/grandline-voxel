# PROGRESS

Live status. Updated as work lands. Companion to `ARCHITECTURE.md` (the contract) and
`reference/ART_BAR.md` (the bar). Live HTML view: `evidence/progress.html`.

---

## Run-level notes

**Reference image substitution.** `reference/art-bar.png` was **not in the repository** at run
start (the repo was empty). The reference was supplied as an attachment in the task prompt.
Subagent critics receive text only, so the orchestrator transcribed the image into
`reference/ART_BAR.md` — measured palette, silhouette rules, lighting rules, composition. That
document is the operative bar for every blind critique in this run. This is a real deviation
from the brief and is recorded here rather than papered over.

---

## PHASE 0 — HARNESS  ✅ tooling built, determinism proof running

| Piece | State | Evidence |
|---|---|---|
| Deterministic capture, isolated page per shot | **done** | `tools/capture/capture.mjs`, `evidence/shots/manifest.json` |
| Bit-identical proof across two runs | **running** | `capture --verify` |
| Pixel diff gate | **done** (owner: harness agent) | `tools/diff/diff.mjs` |
| Gameplay profiler, p50/p95/p99 + hitch attribution | **done** | `src/core/profiler.js`, `tools/profile/profile.mjs` |
| Scripted playtest driving real input | **done** | `tools/playtest/playtest.mjs` |
| Determinism / asset lints | **done** | `tools/lint-determinism.mjs`, `tools/lint-assets.mjs` |

Design decisions that matter:
- Capture renders on **ANGLE/SwiftShader** (software). Bit-identity then means something on any
  machine, instead of being an artefact of one GPU driver. Profiling uses the **real GPU**
  (Intel UHD — genuinely the "laptop GPU" the brief targets), because software timings are noise.
- Screenshots are read from the **WebGL backbuffer** via `toDataURL`, not element screenshots.
  That removes the compositor, scroll-into-view and stability waits from the evidence path.
- Isolation is a fresh **browser process + context + page per shot**, not just a fresh page.

---

## PHASE 1 — WALKING SKELETON  🔄 assembled, integration defects being worked

**The game now boots, streams a real landmark island, spawns the player, runs combat, physics,
weather, fruit and ship systems, and renders end to end.** `evidence/shots/game-island-approach.png`
is the first frame of the assembled game. 62 source modules import cleanly
(`node tools/check-imports.mjs`), the determinism lint passes across ~30k lines written by nine
different owners, and no binary asset exists anywhere in the tree.

### Integration defects found on first assembly (all real, all logged)

| defect | cause | state |
|---|---|---|
| `physics` undefined in combat | factory named `createPhysicsSystem`, not `createPhysics` | fixed |
| crash in `hasTag` | hits produced without a `tags` array by fruit/enemy code | fixed (null-safe) |
| crash in `resolveDamage` on `status.frozenT` | actors hit before `initCombatant` ran | fixed (lazy init on first contact) |
| crash in `fx.impact` on `pos.x` | weather lightning calls impact with no position | fixed (screen-space path) |
| `this.shake is not a function` | the method is `addShake` | fixed |
| **player renders as a black silhouette** | tiles registered *after* the texture array was uploaded, so those layers have no GPU storage and sample out of range | fixed: all tiles now register before `tex.build()` |
| **props float in mid-air at wrong scale** | prop placement mixing the 0.5 m terrain voxel with the 0.25 m prop voxel | open |
| weather overrides the shot's requested state | `WeatherSystem.step` runs after `setWeather` | open |

The first six were fixed by the orchestrator at the boundary between owners; each fix is a
tolerance change at a contract edge, not a behaviour change, and each is commented with why.

## PHASE 1 — original plan

| Piece | Owner | State |
|---|---|---|
| A-render (renderer, sky, water, shadows, materials, tonemap) | orchestrator | **first frame passing** |
| gen (palette, noise, texture array, voxel mesher, blocks) | orchestrator | **done** |
| core (rng, clock, math, profiler, input) | orchestrator | **done** |
| audio (synth, sfx bank, adaptive music) | agent `audio` | **landed**, integration pending |
| ui (procedural font, HUD, menus, tutorial) | agent `ui-font-hud` | **landed**, integration pending |
| quest (objectives, chains, bounty, crew, dialogue) | agent `quest` | **landed**, integration pending |
| charmodel + props | agent `charmodel` | in flight |
| islands (8 landmarks + minor generator) | agent `islands` | in flight |
| harness tools (diff, profile, playtest, gate) | agent `harness-tools` | **landed** |
| world streaming | orchestrator | not started |
| player / actor / anim / camera | orchestrator | not started |
| combat / fx | orchestrator | not started |
| ship | orchestrator | not started |
| fruit powers | orchestrator | not started |
| save / load | orchestrator | not started |

---

## Bugs found and fixed (Cluster A), with the evidence that found them

These are logged because the diagnosis path matters more than the fix.

1. **Ocean invisible; whole frame was sky.**
   Symptom: `ocean-noon` was a flat pale wash. Three wrong hypotheses were tested and discarded
   (fog density, fresnel, glitter) before instrumenting properly.
   Method that worked: hide the sky, hide the water, read back pixels in each configuration.
   With the sky hidden the frame was empty → the ocean was never rendering.
   Root cause A: the radial ocean fan winds clockwise seen from above, so `FrontSide` culled it.
   Fix: `DoubleSide` (also correct for looking up at the surface from underwater).

2. **Every frame was a magnified crop of the lower-left corner.**
   Symptom: after fixing (1) the ocean covered 100% of the frame, a 25 m checker filled the
   screen with two cells, and the sky gradient was nearly flat.
   Method: rendered the ocean geometry with a stock `MeshBasicMaterial` (still full-screen, so
   not the custom vertex shader), then dumped renderer state during a direct-to-canvas render.
   `viewport = [0,0,2048,1024]` with a `480x270` drawing buffer.
   Root cause: `ShadowAtlas.render()` tiles cascades by writing three's **single persistent
   viewport/scissor** and never restored it, so every later pass inherited the shadow atlas
   viewport. Fix: save/restore viewport, scissor, scissor-test and clear colour around the
   shadow pass, and have each renderer pass set its own viewport explicitly.
   Lesson recorded: **three.js renderer state is global and persistent.** Any hand-rolled pass
   must save and restore it.

3. **"Breezy" weather produced 5 m swells.**
   Root cause: the Gerstner formula conflated steepness `Q` with amplitude `A`
   (`a = steep/k * amp`). Fix: `A` is amplitude in metres, `Q` only pinches crests horizontally.
   Verified numerically: breezy now ranges ±1.47 m.

4. **Fog saturated at ~150 m.**
   Root cause: `exp(-density * dist²)` tuned as if it were linear in distance. Densities were
   ~500x too high. Retuned so 300 m is barely hazy and 4 km is the horizon.

---

5. **The perf gate was measuring the monitor, not the game.**
   The first real-GPU profile run reported `p95 = 16.20 ms` with *only sky and ocean on screen*
   and called it PASS. Two separate measurement faults:
   (a) headless Chrome still v-synced, so every scenario reports ~16.6 ms no matter how cheap or
       expensive it is — the gate would have passed forever and then "suddenly" failed;
   (b) the ablation harness synced with `gl.finish()`, which is effectively a no-op in a browser
       (the work happens in the GPU process), so it timed command submission, not rendering.
   Fixes: `--disable-gpu-vsync` in `GPU_ARGS`, and a real `fenceSync` + `clientWaitSync` in the
   ablation tool. **Any perf number recorded before this fix is void.**

6. **Every voxel face in the game was wound backwards.**
   Symptom: the props shot rendered an empty trough — the near walls of a solid block of terrain
   were missing and the far *inner* walls were visible, and characters read as flat cardboard.
   This was initially misread as a lighting problem.
   Root cause: in the greedy mesher, `u = (axis+1)%3` and `v = (axis+2)%3` make `(u, v, axis)`
   cyclic, so `ê_u × ê_v = ê_axis`. Emitting corners `base → +v → +u+v → +u` therefore produces
   `ê_v × ê_u = −ê_axis`: every quad faced *into* the volume, for both the positive and negative
   face directions. Fix: reverse the index order for all quads.
   This is the same class of bug as the ocean's `FrontSide` culling — **winding was wrong twice,
   in two independently written pieces of geometry code.** Any new hand-built geometry in this
   project should be checked against a solid-block render before anything else is tuned.

7. **The rim light was a full-surface wash, not a rim.**
   Symptom: every character bleached to cream; only the water kept its colour.
   Measured: at fresnel exponent 3 and gain 0.85 the rim term alone reached ~1.1 in linear on top
   of a key of ~1.3, so the tone map clipped to white. Fix: exponent 5, gain 0.42, and the rim is
   now attenuated where the sun already lights the surface, so it reads as an edge rather than a
   second flat key light.

8. **MSAA 4x cost 34 ms of a 43 ms frame** at 1080p on the target Intel UHD.
   Measured by throughput ablation. Replaced with single-pass FXAA in the composite.
   Result: **42.85 ms → 9.21 ms** per frame for sky + ocean at 1080p.
   Attribution table is in the "Performance" section below.

9. **The player had NaN health from the first step of every session.**
   Found by opening the game and driving `app.step()` by hand, not by any test.
   `FruitSystem._drownDamage` sent `{ amount }` but the hit contract is `{ damage }`
   (`makeHit`, src/combat/hitbox.js), so `resolveDamage` computed `hp -= undefined`. NaN then
   propagated to `poise` and never threw. Two call sites in src/fruit/fruits.js were affected.
   Class-level fix: `CombatSystem.applyHit()` now normalises any hit missing `damage`/`poise`/
   `knockback` through `makeHit()`. applyHit is the single door into damage and most of its
   callers build plain object literals, so defaulting there kills the whole family of bug.

10. **A new game began by drowning.** The player spawned at world origin — open ocean — and a
   devil fruit user cannot swim, so a fresh session drowned 11 times and washed ashore at
   16 / 120 hp before the player touched a key. `game.js` now places the player on the first
   landmark's dock (shellsCove), streaming the island in first and standing them on the queried
   ground height. Measured after: full 120 hp, 0 drownings.

11. **Lazy combat-body init clobbered actor configuration.** The `initCombatant` fallback added
   during integration seeded purely from `spec`, resetting a player built with `maxHp: 120` back
   to the 100 default on its first hit. It now preserves the actor's existing values.

### 2026-08-15 — controls review outcome (orchestrator)

Playtest is now **10 of 11 steps green**: boot, tutorial, board ship, sail, dock, walk ashore,
enter combat, win the fight, use a devil fruit, accept a quest. Fixed this session, each
verified live: enemy spawns grounded (they spawned at y=0 inside 10 m of rock, so line-of-sight
always failed and no enemy could ever notice the player), flat x/y/z accessors on Actor (the
fifth flat-vs-Vector3 contract bug), plus the full control wiring (pointer lock, HUD bridge,
input gating, menu callbacks, resize, audio unlock).

**PARKED: complete-quest (the last playtest step).** Diagnosis so far: the quest engine and the
areaEntered emitter are verified correct (goto radius honoured, point keys match, kill events
carry questKind). The failure is in the playtest driver: it has no working navigation for
`goto` objectives — the added branch reads `obj.point`/`obj.type` off `trackedQuest()`'s
objective view, which likely exposes a different shape. NEXT ACTION: print the actual objective
view shape from a live session, fix the field names in src/playtest-entry.js (the branch is
commented), and re-run. The game-side quest chain is proven completable by
tools/check-quests.mjs (889/889).

### 2026-08-15 (later) — complete-quest campaign: six real fixes landed, step still red

Diag-driven session (every claim below is from a measured playtest diagnostic, not theory):

FIXED and verified through the step-by-step diag progression:
1. objectiveProgress() now passes identity fields (point/npcId/itemId/enemyKind...) through the
   view — before this, nothing downstream could know WHERE an objective was. goto now completes.
2. Level-triggered area re-arm: QuestSystem.progressRevision clears the world's areaEntered
   dedup set on quest progress. Accepting a quest while standing on its target now counts —
   the boot spawn had permanently swallowed the dock trigger.
3. Playtest driver: obstacle-aware walkTowards (shore-following, kerb hops, stuck-strafe) for
   goto/collect; unreachable-pickup blacklist with retry; local-island item filter (it chased a
   float 2 km across open sea); itemId now rides on spawn interactables. collect: 4/4 completes.
4. Fight-first gate requires the threat within 12 m — an aware enemy across the island had
   starved the collect objective for 17,895 straight steps.
5. Player respawn (game feature, not harness): death was a permanent softlock for real players.
   Beaten players wake on the starter dock at half hp, aggro dropped.
6. Quest/spawn vocabulary hardening (game bug): defeat('thug') was uncompletable on seeds whose
   camps rolled only thug_brute/marine_grunt. Kills now emit a family ('thug' for thug_brute)
   and defeat objectives match kind OR family. check-quests still 889/889.

STILL RED — the last step, now precisely characterised: after collect completes, the driver
must kill 3 thugs. The only thug-family enemies are a 12-strong pair of camps; the driver
charges them at 50% hp (post-respawn), survives a few seconds per attempt, and lands 0 kills
in 275 s of cycling (measured: pos oscillates dock<->camp, defeat 0/3). win-a-fight passes in
8.8 s against the same camp at full hp, so combat itself is sound.

OUTCOME OF THE TWO OPTIONS (both tried, measured):
  b was tried BOTH ways — skipping the rng draw reshuffled the whole island (tutorial 35s->215s);
  preserving the draw but capping the count still changed enemy identities and BROKE the
  previously-passing win-a-fight (240 s, no kill). Reverted to the proven configuration.
  CONCLUSION: the driver's kill ability is marginal and configuration-sensitive — win-a-fight's
  8.8 s pass was a fortunate deterministic matchup, not robust competence. The durable fix is
  (a)+: give the driver real combat competence (target isolated patrols, kite single enemies
  out of camps using the 30 m deaggro leash, retreat when hp < 40%) — or give the PLAYER
  out-of-combat health regeneration, which fixes the half-hp death spiral for humans too and
  is standard in the genre. Either is a bounded, well-scoped next session.

ORIGINAL OPTIONS WERE:
  a. Driver: prefer ISOLATED targets — spawn.js places wandering patrols; fight those, not the
     camp. Or retreat-and-heal loop against camp stragglers (enemies deaggro at 30 m; kite one).
  b. Game difficulty (arguably the truer fix): starter-island camps spawn count=clamp(2+tier+rng,3,8)
     = 4-5 enemies x2 camps for a tier-1 island. A fresh player faces 9+ thugs — cap tier-1
     camps at 3 and the first fight becomes winnable for humans AND the driver.

### 2026-08-15 (final) — PLAYTEST 15/15. The full loop is proven.

`node tools/playtest/playtest.mjs`: boot, tutorial, board ship, sail, dock, walk ashore, enter
combat, win the fight, use a devil fruit, accept the quest, COMPLETE the quest, bounty rises,
save, reload, state restored — all fifteen steps green in one run, driving real input only.

The campaign to close the last step found and fixed, in order (each diagnosed from a measured
run, never guessed):
1. GAME: out-of-combat health regen (6 hp/s after 6 calm seconds; cook bonus stacks). The
   half-hp death spiral is gone for humans too.
2. GAME: revive() sets the Actor-side `alive` but combat reads `dead` — the sixth
   two-vocabularies bug. Respawn now clears combat's flags (dead/removed/hitstun/stagger/
   status) and grants 1.2 s of spawn protection. Without this the player was an immortal
   corpse at the dock, respawn re-firing every 3 s forever.
3. GAME: quest q1 now awards a first bounty (500k) — the wanted ladder starts with the first
   chain, as the brief demands.
4. HARNESS driver, taught to actually play: hold-forward through melee exchanges (facing
   follows movement; a stationary attacker's arc points at where the enemy was), combo-tempo
   presses (one press per 1.2 s could never chain the 0.42 s combo window), sticky targets
   (re-scoring per step trailed a wandering patrol at matched speed forever), family-filtered
   hunting (it chased shore wildlife it could never reach, and a kiting rifleman held it in a
   10 m stalemate), retreat that OUTRUNS pursuit toward dry ground near villagers (the fixed-
   point retreat was chased and chip-reset the heal timer; the flee vector pointed into the
   sea), and an escalating detour escape in the navigator (the alternate-strafe could not
   escape a village doorway pocket — same frozen coordinate four runs straight).
5. HARNESS: save/load steps now invoke the pause menu's own wired callbacks instead of blind
   focus-navigation by key taps — the old dance never ran (the autosave satisfied the check at
   t=0 against a position up to 90 s stale), which is why state-restored could never match.
6. HARNESS: bounty read from the owning system (quests.bountyState) — player.bounty never
   existed.

Step budget for complete-quest is 780 s: measured pace is ~230 s per camp kill including the
retreat-heal-return cycle; a careful human clears the chain in 10–12 minutes too.

## Failed approaches (do not retry)

- Tuning fresnel / glitter / fog to fix the "flat pale ocean". The ocean was not being drawn at
  all, then was being drawn through a broken viewport. **Three rounds of parameter tuning
  produced zero real progress.** The fix was isolation instrumentation, not art direction.
- Trusting a perf PASS without checking the measurement could ever produce a FAIL. A gate that
  cannot fail is not a gate.
- `requestAnimationFrame` as the perf measurement in headless Chrome. It is frame-capped and
  reported a flat 65 fps / ~15.5 ms regardless of real cost, even with `--disable-gpu-vsync`.
- `gl.finish()` as a GPU sync. It is effectively a no-op in a browser.
- `clientWaitSync` spin loops: real, but carry ~92 ms of their own overhead here, which swamps
  the signal. **The method that works is throughput: render N frames, then `readPixels`, which
  blocks until the GPU has genuinely finished all N.**
- `element.screenshot()` for capture: introduced a stability wait that timed out and coupled the
  evidence to the compositor. Replaced with backbuffer readback.

---

## Performance — measured, real GPU (Intel UHD 1080p, sky + ocean only)

Throughput ablation, `tools/perf-ablation.mjs`:

| variant | ms/frame |
|---|---|
| MSAA 4x + fp16 (original default) | 42.85 |
| MSAA 2x | 13.71 |
| MSAA 0 | 8.66 |
| MSAA 0 + rgba8 target | 8.64 |
| no ocean (MSAA 4x) | 10.97 |
| no bloom passes | 42.95 |

Conclusion: MSAA dominated everything; fp16 and the bloom chain are both free by comparison.
Shipping config is **MSAA off + FXAA**, measured at **9.21 ms** at 1080p, leaving roughly
7 ms of the 16.7 ms budget for terrain, characters and combat.

## Next action

1. Finish the Phase 0 bit-identity proof and lock a baseline.
2. Build world streaming + player + combat + ship + fruit (orchestrator-owned Phase 1 core).
3. Integrate the landed agent systems (audio, ui, quest, charmodel, islands) into `src/game.js`.
4. Start the Phase 2 gauntlet with the first blind critique of Cluster A.

## Budget used

Approximate, this run: 1 workflow (6 parallel owner agents), ~55 tool calls by the orchestrator.

---

## 2026-08-14 — FIXER pass: confirmed reviewer findings closed

Three independent reviews produced 22 confirmed findings (blockers + majors). Every one was
reproduced against the live game (`index.html`, playwright, real DOM events) before fixing,
and re-verified with the same probe afterwards. `node tools/check-imports.mjs`,
`tools/lint-determinism.mjs` and every area self-check (`combat`, `ship`, `fruit`, `world`,
`quests`, `character`, `charmodel`, `islands`) pass after the changes.

### Ship / controls (blockers)
- **Ship spawned at world origin, 7.2 km from the player.** `src/game.js` now imports
  `LANDMARKS` once, constructs the ship with `{ islands: LANDMARKS }`, and berths it at the
  start island's dock via the new `ShipSystem.berthAt(islandId)` /
  `DockController.berthAtIsland()` (DOCKED state, plank out, anchor down). Measured live:
  ship 6 m from the spawn point, `dock.state === 'docked'`, 8 islands in the dock table.
- **KeyE could never board.** Two real paths now exist: the player's interact cone offers the
  gangplank (`player._findInteractable` considers `ship.canBoard`/`boardingPoint`), and
  `ShipSystem.step` boards on `pressed.interact` when ashore at a docked berth (facing-agnostic,
  skipped when the press was already spent on an NPC). Verified with real `KeyE` keydown/keyup:
  board → sail (`KeyR` trims) → disembark → re-board, repeatably.
- **Disembark teleported the player back over the water.** The "player as a passenger" block in
  `ShipSystem.step` used the stale `aboard` local captured before `_interact()` ran; it now
  re-checks the live mount, so going ashore lands on the validated shore point.

### Assembly / contracts (blockers)
- **`app.enemies` facade never created** — wired in `src/game.js` right after combat is made.
  World camps/patrols, dock boarders and the profile scenarios all spawn now.
- **`app.quest` vs `app.quests`** — `app.quest` is published as an alias; `npc.js` reads
  `(app.quests || app.quest)`. NPC conversations reach `QuestSystem.converse` again.
- **`wireMenuCallbacks` ran before `app.save`/`app.quests` existed** — it now runs after the
  registration loop; the pause menu uses real save slots, real settings, real fruit/crew/quests.
  Settings keys were also aligned with `SETTINGS_SCHEMA` (`master`/`sfx`/`music`, shadowQuality
  `off/low/high/ultra`) and `AudioSystem` gained `setSfxVolume`/`setMusicVolume` per-bus
  volumes (underwater duck now scales with the music setting instead of overwriting it).
- **Physics was constructed but never registered** — added to `STEP_ORDER` (§4 slot between
  world and fx). Without it the broadphase hash was never rebuilt and NO hitbox or projectile
  in the game could connect with anything.
- **The player was never `combat.register()`ed** and had no flat body shape. `Actor` now
  exposes `x/y/z`, `vx/vy/vz` accessors (bridging to its `pos`/`vel` vectors) plus `mass`;
  `combat.register` seeds the transient combat fields for an actor that already owns its
  vitals; `game.js` registers the player. Enemy perception, enemy hitboxes and knockback now
  see the player.
- **Player intents array vs combat's flags object** — `combat._intents()` drains the player's
  intent queue into the flags shape ('parry' opens the block window on the press; a
  player-sourced dodge keeps combat's i-frames/cancel but not the double stamina charge).
- **Melee vertical mismatch** — combat capsules are authored human-scale (1.7–2.6 m) while
  characters are voxel-scale (4.25 m); the weapon-path height is now capped at 2 m above the
  feet so player sweeps connect. Verified live: locked on with `KeyT` (lock-on now accepts the
  facade's `list()` function, flat enemy positions, and `nearestThreat().actor`), real clicks
  killed a Dock Thug; damage numbers, hit sfx and camera shake all fired.
- **Enemy kind vocabulary** — `KIND_ALIASES` in `combat.js` maps quest/world kinds
  (`marine_grunt`, `thug_brute`, `frost_wolf`, ...) onto behaviour archetypes and preserves the
  requested kind as `questKind` for defeat notifications; `archetype()` warns and falls back to
  `thug` instead of throwing; `spawnWave` honours the dock's validated deck `points`.

### HUD / UI (majors)
- `buildUiState` now uses the real APIs: `fruit.hudState()` (ability pips + cooldowns + meter
  render — measured 3 pips with gomu), `nearestThreat()`'s actual shape (target bar shows the
  enemy's name and the telegraph band draws), `trackedQuest().step.objectives` (HUD shows the
  live objective text and progress), and compass markers read `worldPos` (they were NaN).
- **fx.shake now reaches the camera**: applied in camera space (x/y offset + roll) after
  `gameCamera.applyTo` each frame in `wireServices`.
- **Fruit DoT and drowning hits** are billed in whole points a few times a second with
  poise/hitstop/knockback/crit all zeroed (mirroring combat's own DoT path) — no more 60 Hz
  stagger-lock/slash/sfx spam. Measured: 1.5 s of drowning = 3 hp, poise untouched, 3 impacts.
- **Tutorial signals + flags**: `app.signals` (look/move/attack/block/dodge/fruit/npcTalk/
  questAccept/mapOpen) is accumulated in `buildUiState` and by the owning systems;
  `gs.ship {sail, distToMarker, docked}` is supplied; `app.flags.tutorialDone` is set from
  `ui.tutorial.isDone()`. `KeyM` opens the voyage log (quest journal) and counts as mapOpen.
  The playtest contract holes (`app.quest`, `app.flags`, `app.player.bounty`) are all filled —
  the bounty is mirrored from `quests.bountyState().total` after every quest step.

### Quest events and world content (majors)
- `npcTalked` is emitted on every NPC conversation; conversations returned by `converse()` are
  actually played (lines surface as toasts, effects applied via `applyDialogueEffect`, offers
  auto-accept — "the first choice is the accept branch"). Verified live: talked to Mira with a
  real `KeyE`, `shellsCove.q1` became active, HUD showed "Cut Nets".
- `itemCollected` / `propDestroyed` now have emitters: `spawn.js` places every `collect` item
  and `destroy` prop the island's quest chain references (count + 1, deterministic placement),
  draws them (bundle/banner voxel props), and exposes them — plus chests, which were also
  unreachable — through `spawn.interactablesNear()`, wired to `world.interactablesNear` for the
  player's interact cone. Collected/destroyed sets serialize. Verified live: took a cork net
  float with `KeyE`; the quest inventory recorded it.
- **NPCs actually spawn**: `spawn.js` hands each loaded island's authored NPCs to
  `app.npc.spawn` (kind → character spec mapping), despawns on unload. 8 NPCs live on the
  start island.

### Boot (major)
- `App.boot()` registers fruit-FX, world and ship tiles before the atlas upload (no entry ever
  passed `opts.registerTiles`). Fruit powers get their bespoke effect geometry, rain/foam tiles
  exist, and the boot-time atlas rebuild is gone (`stats.atlasRebuilt === false`, 494 tiles).
- `WeatherSystem` is constructed with `{ world }` so biome weather bias and sea events engage.

### Known gaps (out of scope for this pass, recorded honestly)
- Enemies still have no visual rigs — combat is fully functional (perception, telegraphs,
  hits, deaths) but enemy bodies are not rendered by any system. Needs a Cluster C renderer.
- Quest pickups/props use generic bundle/banner geometry rather than per-island art.
- Dialogue plays through toasts and auto-accepts offers; a real dialogue panel with choices
  is still owed by UI.

### Playtest gate — from failing at step 3 to failing at step 7 (same session, later pass)

`node tools/playtest/playtest.mjs` before this pass: **boot passed, tutorial skipped
("flags system not present"), board-ship FAILED** — 1 real step of 15.

Defects found and fixed while driving it (all with real DOM events):

- **Combat could not connect at all in the live game**: `physics` was constructed but never
  in `STEP_ORDER`, so the broadphase hash every hitbox resolves against was never rebuilt.
  The player was also never `combat.register()`ed, the Player published an intent QUEUE while
  combat read an intent FLAGS object (`_intents()` now drains the queue; a player-sourced
  dodge keeps i-frames + swing-cancel without double stamina), and the 4.25 m voxel player's
  weapon path passed over every human-scale (1.7–2.6 m) enemy capsule — now capped at 2 m
  above the feet. Verified live: lock-on, swings, damage numbers, kill.
- **Scripted-input contract drift** (`src/scenarios.js`): the synthesised key codes had
  drifted from `DEFAULT_BINDS` (dodge sent ShiftLeft = sprint; fruitPower sent KeyQ = block).
  BINDINGS now mirrors the game's binds and adds sail/anchor/lock/block/sprint/digit actions.
  Untrusted (scripted) mousemove is honoured by `core/input.js` without pointer lock, which
  synthetic events can never acquire.
- **Playtest steering was calibrated against the character's yaw**, which only turns while
  walking — a noisy probe could lock in an inverted gain and the script walked into the sea
  at full commitment. It now steers the camera, whose response to look input is direct.
- **The `map` tap during sailing left the quest journal open forever**, blocking all play
  input for the rest of the run. KeyM now toggles the journal closed (ui.js) and the drivers
  clear any open menu.
- **Drowning rescue preferred the ship deck over the beach 5 m away**, ping-ponging anyone
  who fell in near a tideline back to the harbour. `_rescue` now picks the genuinely nearest
  safe footing (shore first, deck only when closer).
- The tutorial driver now actually performs each lesson (look/walk/board/sail/fight/talk/
  quest/map) instead of mashing four keys; later steps use real APIs (`combat.kills`,
  `quests.activeQuests()`, `fruit.stats.casts`, save slot key `glv.save.v1.slot0`) and
  save/load through the pause menu with real key navigation.

**Current gate status**: boot, tutorial-completes (~35 s sim, all 13 lessons by real input),
board-ship, sail-to-first-island, dock, and walk-ashore all PASS. `enter-combat` /
`win-a-fight` still fail intermittently: the script's blind straight-line navigation cannot
reliably cross the cove between the village and the raider camp without falling in (combat
itself is proven live — perception, telegraphs, hits both ways, kills). That is a
script-navigation gap, not a game defect; it needs waypointed routes from the spawn set
(follow-up), after which the quest/save/reload steps become reachable.

## 2026-08-15 (later) — performance gates: 7/7 FAIL at "40 ms" to 7/7 PASS at 12 ms

The first-ever `npm run profile` on the assembled game failed every scenario at cpu-p95
37–41 ms. The tell was the SHAPE of the numbers: a 6x range of content (empty ocean vs
stress-everything) produced a 10% spread of frame times. A cost that ignores content is not
content — it was the measurement, plus thermals, plus two real but modest render costs.

### What was actually wrong (each claim measured, in one browser instance)
- **The profiler's per-frame `readPixels` drain has a ~12 ms floor on ANGLE/D3D11** — larger
  than the 16.7 ms budget it was gating. The same game state measured 18.6 ms in the drain
  loop and 6.8 ms by throughput. A gate must measure the game, not the harness.
- **`fenceSync` + `clientWaitSync(0)` polling does not bound frames-in-flight here** (fences
  signal before the driver executes, like `gl.finish()`): frames read 3 ms while a ~500 ms
  driver backlog periodically stalled the loop. Rejected after one measured run.
- **The iGPU thermally throttles**: identical work cost 18.1 ms right after a 10-minute
  profile campaign and 11.2 ms rested. Ablation numbers minutes apart are not comparable —
  the first attribution pass (bloom "2.3 ms", shadows "3.3 ms") was mostly thermal drift;
  same-instance re-measurement gave bloom ~0.2 ms, shadows ~1.7 ms.
- Real content costs found: sky cloud FBM (10 octaves/pixel, ~1.7 ms), shadow pass
  (~227 of 253 draw calls — the whole of Shells Cove into two cascades, legitimately),
  and a latent composite-viewport bug (composite drew at the INTERNAL scaled size, so any
  resolutionScale < 1 rendered into a corner of the canvas — nothing ever exercised it).
- `profile.html` and `playtest.html` still defaulted to MSAA 4x, a configuration the game
  does not ship (play mode is FXAA); the profiler now matches play mode exactly.

### The fix, in three parts
1. **Honest measurement** (`src/profile-entry.js`): unsynced RAF loop for true per-frame CPU
   percentiles + hitch attribution, plus a GPU throughput batch (drain untimed, time 15
   renders + one drain) every ~45 frames. Gated percentiles are max(cpu, gpuBatch) per
   percentile; both distributions ship unmerged in the report (`cpuOnly`, `gpuBatch`).
   Warmup now also waits for DRS to settle so the gate never charges p95 for frames the
   shipping adaptive quality would not present.
2. **Adaptive quality as shipped tech** (`renderer.js`): dynamic resolution 0.7–1.0 driven by
   over-budget-frame fraction per 30-frame window (play budget 17.4 ms = vsync-aware; profile
   16.2 ms), composite always outputs native 1080p; and the far shadow cascade refreshes every
   other frame with its matrix frozen alongside its depth tile. Both OFF in capture mode —
   deterministic evidence cannot depend on wall clocks or frame parity. `?drs=0` pins native.
3. **Native trims**: sky cloud FBM 10 → 7 octaves (the 3-tier quantisation was erasing the
   detail those octaves cost ~1.7 ms to produce).

### Result (rested GPU, 1920x1080, seed 20260814)
All 7 scenarios PASS: p95 11.61–12.65 ms (gate 16.7), p99 12.05–13.29 ms (gate 33), zero
shader compiles, zero console errors, DRS never needed to leave native 1.0. True pipelined
throughput 10.3–12.3 ms/frame. Isolated 90–140 ms driver-backlog stalls land on single
frames in the unsynced loop (visible as `worst`, attributed to `draw`); p99 is unaffected.
All 9 subsystem self-checks + both lints re-verified PASS after the changes.

### Do not retry
- Per-frame GPU drains or blocking fence waits as a frame-time gate on ANGLE/D3D11.
- Cross-browser-instance or minutes-apart ablation comparisons on this thermally-throttling
  iGPU: re-measure in ONE instance with an interleaved baseline, or trust nothing.

## 2026-08-16 — the 20-minute soak: three runs to green, each failure a different lesson

`stress-everything --minutes 20` (the memory + endurance gate) took three attempts, and the
frame gates' final margins came from controller tuning, not rendering changes:

1. **Run 1 never finished (85+ min).** Cause: a FINISHED profile run's `browser.close()` had
   hung, leaving its last page silently rendering — two full 1080p pipelines sharing one iGPU.
   Fixes: `profile.mjs` now hard-exits after the report is on disk, and long runs heartbeat
   (`[profile] 540s/1200s simulated, scale 0.875, heap 116MB`) so a soak is never a black box.
   (Also learned: Playwright's `page.evaluate` takes no timeout option — the old `budgetMs`
   third argument was silently ignored, which is why nothing ever timed out.)
2. **Run 2 FAILED p95 17.57** — heap PASSED (+12.2%, sawtooth 89–116MB = GC, not a leak) and
   CPU stayed flat all 20 minutes (p95 5.1ms — no gameplay accumulation). The entire miss was
   the DRS controller HUNTING: one clean 30-frame window triggered +0.025 scale, overshooting
   the hot GPU's capacity cliff; the overshoot samples were the p95.
3. **Run 3 FAILED worse (cpu p95 24.4, p99 34.7)** — an attempted optimisation (batch every
   180 frames instead of 45, to cut wall time) let the driver backlog grow between drains
   until it stalled the loop inside random gl calls (~130ms spikes). Dense sampling costs
   wall-clock; sparse sampling costs the measurement itself. Reverted.
4. **Run 4 PASS**: p95 16.15, p99 17.57, heap +12.9%, 0 compiles, 0 errors. Controller now
   steps down with no cooldown (a late thermal reaction records frames a player would see)
   and climbs only when a full window clears budget by 2.5ms; profile budget 15.9 so it
   settles ~1ms under the 16.7 gate. Scale rode 0.75–0.975 across the run — the hot-GPU
   equilibrium this feature exists for (rested, all 7 short scenarios hold native 1.0).

### Do not retry
- GPU sampling sparser than ~45 frames between drains on this stack (driver-backlog stalls
  poison the CPU distribution).
- DRS step-up without a headroom margin when fed true-cost samples (it hunts the cliff).

## 2026-08-16 (later) — the A/D inversion: one wrong vector, shipped three times

User report: "when I press A it moves right, D moves left." Confirmed, and worse than a
keybind mixup — the expression `(cos yaw, 0, -sin yaw)` had been used as the RIGHT vector in
three independent, hand-written copies, when in this convention (yaw = atan2(dx,dz), forward
(sin y, 0, cos y), Y-up right-handed) it is exactly LEFT:

- `camera.js getRightFlat` — sole consumer is the player's movement basis → A/D inverted
  on foot (and dodge rolls with them).
- `sailing.js starboard()` — the whole ship torque cluster (weather helm, broach, brace
  assist, heel, wake, flag) phase-locked to the mirrored axis → D steered to PORT.
- `actor.js` strafe-animation selector — mirrored strafe_l/strafe_r under lock-on.

Why no gate caught it: the playtest's on-foot steering deliberately MEASURES its gain sign
instead of assuming it (so it worked either way), its strafe use is a symmetric unstick
square-wave, and the sail/dock steps pass at the home island without an open-sea voyage.
Nothing in the suite encoded "which way is screen-right" — the convention itself was the bug.

The fix:
- `getRightFlat` returns the true right `(-cos y, 0, sin y)`; player fallback matched.
- Animation selector projects onto the true right.
- Ship: `applyHelmInput` maps D to a NEGATIVE helm (yaw- = true starboard turn). The internal
  torque cluster is intentionally untouched — it is self-consistent and tuned; flipping its
  axis would require flipping five subtle sign chains in one commit for zero player-visible
  gain. `starboard()` is renamed `lateral()` with documentation, because a vector named for a
  side it does not point at is this project's oldest bug family.
- ARCHITECTURE §3 now states the forward/right formulas and the yaw+ = port fact.

Verification: a new acceptance probe measures DIRECTION in the real build — on foot, virtual
D/A/W displace the player along camera right/left/forward (dot products +-1.00); at sea, D
turns the bow starboard and A port through the full sailing physics. All self-checks, both
lints, and the 15-step playtest re-run PASS after the change.

## 2026-08-16 (later) — onboarding: the tutorial taught four wrong keys and hid its first step

Research pass (14 sources: CHI 2012 tutorial study, Hodent's GDC onboarding UX, playtest
data showing >80% of players skip instruction screens) followed by an audit of
src/ui/tutorial.js. Three faults found, none caught by any gate:

- Four steps printed a key their satisfy-condition does not listen to: sail showed `F`
  (which LOWERS the sail; raise is `R`), dock showed `F` (anchor is `G`), block showed
  `RMB` (block is `Q`; RMB is heavy attack), dodge showed `SPACE` (dodge is `C`; Space
  jumps). Each was a dead end — the step waits on a signal only the real binding produces.
  Why no gate caught it: the playtest driver taps the real bindings and never reads the
  printed label; the one thing the player sees was the one thing untested.
- Step zero was invisible: mouse-look needs pointer lock, lock needs a click, and the only
  place that said so was the README. Escape (pause) also drops the lock with no re-prompt.
- The 13 steps were a linear queue: the whole sea act (board -> sail -> steer -> dock) sat
  in front of every ashore lesson, so a player who walked into the village was told to
  board a ship and taught nothing about the villagers, quests and enemies around them.
  Also latent: the dock step self-passed (the ship starts berthed, ship.docked true on
  frame one) and `castOff()` was dead code — no input path could leave the berth at all.

The rebuild:

- Trigger table, not a queue: every lesson carries an arming precondition ("is the player
  in a position to learn this right now?"); the highest-priority armed lesson is displayed,
  with hysteresis, and telegraph-reactive block/dodge lessons preempt urgently. Ashore and
  sea acts are independent. `Tutorial.learned` is a Set; v1 saves ({i}) migrate inside the
  ui slice (v2) without touching SAVE_VERSION.
- Keycaps derive from the binds (`capForAction`), so a printed label can no longer drift
  from a binding; the HUD interact prompt derives too. tools/check-tutorial.mjs (now in
  `npm run check`) pins the four repaired labels, drives the trigger table to completion
  against a mock snapshot, asserts the boot-berth dock self-pass stays dead, and checks
  the v1 migration.
- Pointer-lock scrim: "Click to take the helm" whenever the lock is absent and no menu is
  open — first boot and every Esc-menu-close. Virtual input counts as locked so the
  profiler and harness never see it.
- Hint ladder per lesson: 6 s quiet, then a static tag, then animated highlight + pulsing
  keycap (the playtest-evidence fix — motion until the action lands), then a fuller
  goal-naming line at 25 s. Progress backs the ladder off.
- Hold `Tab` for a control card generated from the live binds. `G` now casts off at the
  berth and moors at an approach (castOff un-deadened); README updated.
- A sparring partner stands beside the Shells Cove dock: new `sparring` archetype
  (1.2-1.4 s windups covering block/parry/dodge), nonLethal (never takes anyone below 30%
  maxHp — clamped at the resolveDamage seam) and unkillable (pins at 1 hp, concedes the
  round, rests, heals). Solo (no group alerts either way), leashed to 16 m, fixed reserved
  actor id 100000 and fixed spawn spots so every camp enemy's rng stream is byte-identical.
  Goes passive once attack+block+dodge are learned. The playtest steps that pick fight
  targets skip kind 'sparring'.
- Tutorial telemetry (lesson_armed/shown/learned/skipped, sim-time stamped — no wall
  clock) into localStorage['glv.tutorial.v1'], capped at 300 events, dropped silently
  where storage is unavailable.

Playtest note: tutorial-completes now performs a real cast-off and re-moor (the first
genuine undock the suite has ever driven); the ship ends re-berthed at the home island so
every later step's preconditions are unchanged. Combat music now triggers at the dock
during the sparring lessons — intended.

## 2026-08-16 (evening) — controls fixed for humans, and the campaign that followed

The user's live report — "A moves right, D moves left" — turned into the longest diagnostic
campaign of the project. Full detail in the entries above and ARCHITECTURE §3/§8b; the short
version, in the order the truth arrived:

1. **The A/D inversion was a wrong FORMULA, not a keybind**: `(cos y, 0, -sin y)` used as
   "right" in three hand-written copies (camera strafe basis, ship starboard, strafe-anim
   selector). Fixed everywhere; ship keeps its internally-consistent mirrored torque cluster
   with the correction at the helm input alone. A new acceptance probe measures real on-screen
   displacement directions in the live build, so the whole bug family is now caught by math,
   not by eyes.
2. **The playtest regressed because its luck ran out, not because the game broke**: the new
   trajectories exposed latent driver gaps one at a time — taps that ignored what the interact
   cone was aimed at, no concept of cliffs, huts invisible to a terrain-only probe, an escape
   ritual that always turned the same way, a give-up clock reset by its own detours, a menu
   guard missing from exactly one step, and no map sense at all. The endgame: a BFS route
   planner over the heightfield (with enemy-cluster avoidance), the full navigator in every
   walking step, and a disengage rule for brawl chip damage.
3. **One real GAME defect surfaced and was fixed**: knockback could park the player's capsule
   inside voxel pockets no walking input leaves — measured as a 600 s full-health statue. The
   player now carries an anti-enclosure rescue (displacement-anchored so it survives panic
   hopping): 3 s of pushing inside a half-metre circle relocates to the nearest standable pose.
4. **The harness fought back harder than the game**: vite's HMR watcher navigated pages
   MID-RUN on spurious Windows file events (three runs died at ~17 s), so harness servers now
   run watch-free — which in turn means a reused server serves FROZEN code after edits (two
   more runs "tested" old code byte-identically). Rules now enforced: measurement servers get
   their own port (`--port`), no watcher, and are killed after every edit; the runner retries
   the deterministic script on a fresh page after a tab crash.
5. **A second session's work merged in mid-campaign** (dockside sparring partner, tutorial v2
   with cast-off/dock lessons, Tab controls overlay). The fight steps learned to never target
   the unkillable trainer, and the win-a-fight recipe adopted the proven combo tempo + stretch
   punch (live-probed: kills a thug in 3 s).

**Final state: PLAYTEST 15/15 PASS**, with complete-quest at 82 s — 7x faster than the
original pass, because the driver now walks like it has a map. All self-checks and lints
PASS except check-islands' warm-build TIME budget, which flakes purely with machine load
after 16 h of continuous testing (same code passed at 22 ms mean this morning; generation
untouched today) — a soft perf assertion, not a correctness gate.

### Do not retry
- Reusing a watch-free vite server across code edits (serves frozen transforms forever).
- Trusting any impossible-looking result before curl-grepping what the server actually serves.
