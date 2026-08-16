# Grand Line Voxel

A browser-based open-world voxel action game. Sail a Grand Line-scale ocean, fight, use devil
fruit powers, run quest chains. Three.js + WebGL2, no game engine.

**Every texture, mesh, animation and sound in this project is generated in code at load time.**
There are no image, audio, font or model files anywhere in the repository, and
`npm run lint:assets` fails the build if one appears.

---

## Run it

Requirements: **Node 20+** and a browser with **WebGL2** (Chrome, Edge, Firefox, Safari 16+).
Nothing else. No backend, no accounts, no network access at runtime.

```bash
npm install
```

```bash
npm run dev
```

Then open **http://127.0.0.1:5273**. First boot takes about a second while the textures,
meshes and sounds are generated; there is a progress bar.

For a production build:

```bash
npm run build && npm run preview
```

### Controls

| | |
|---|---|
| Move | `W` `A` `S` `D` |
| Look | mouse (click the canvas once to capture the pointer) |
| Sprint | `Shift` |
| Jump | `Space` |
| Dodge | `C` |
| Attack / heavy | left mouse / right mouse |
| Block (hold) / parry (tap on impact) | `Q` |
| Devil fruit abilities | `1` `2` `3` |
| Interact / talk / board / dock | `E` |
| Raise / lower sail | `R` / `F` |
| Anchor | `G` |
| Lock on | `T` |
| Swap devil fruit | `X` |
| Map / quests / crew | `M` / `J` / `K` |
| Pause, save, load, settings | `Esc` |

The first-time flow teaches all of this in play. You do not need this table.

### URL parameters

| parameter | meaning |
|---|---|
| `?seed=20260814` | world seed. The same seed always produces the same world. |
| `?seed=anything` | text seeds work too; they are hashed. |

---

## Repository layout

```
src/
  app.js            boot order, fixed-step loop, render call
  game.js           the ONLY file that knows about every system; wires them in step order
  main.js           play-mode entry
  core/             rng, clock, math, input, profiler, save
  gen/              procedural generation: palette, noise, textures, voxels, blocks,
                    character models, props, islands
  render/           renderer + render graph, sky, water, shadows, materials, camera, fx
  world/            island placement, chunk streaming, weather, spawning
  entity/           actor base, rig, animation, player, enemies, npcs
  combat/           attacks, hitboxes, telegraphs, damage
  ship/             ship model, sailing physics, docking, crew aboard
  fruit/            the six devil fruit powers
  quest/            objectives, quest chains, bounty, crew, dialogue
  ui/               procedural typeface, HUD, menus, tutorial
  audio/            synthesis toolkit, sound bank, adaptive music
tools/              the evidence harness (see below)
evidence/           generated output: screenshots, diffs, perf, reports, progress.html
reference/          ART_BAR.md — the art standard everything is judged against
```

`ARCHITECTURE.md` is the contract between systems: ownership, coordinate conventions, the
lighting contract, the save format, and the harness contract. Read it before changing anything
that crosses a module boundary.

`PROGRESS.md` is the running log: what is done, what is in flight, verdicts, failed approaches,
and the next action.

---

## The evidence harness

Nothing in this project is claimed without being measured. The tooling that does the measuring is
built first and is a first-class part of the repo.

```bash
npm run capture              # deterministic screenshots of the fixed shot list
npm run capture -- --verify  # proves two consecutive runs are bit-identical
npm run diff                 # pixel-diff gate against evidence/baseline
npm run profile              # frame-time profiler on the real GPU: p50/p95/p99 + hitch causes
npm run playtest             # scripted playtest driving real input events
npm run gate                 # every objective gate, in order, PASS/FAIL table
npm run lint:determinism     # bans Math.random / wall-clock reads in simulation code
npm run lint:assets          # bans binary assets
node tools/progress.mjs      # regenerates evidence/progress.html
```

Then open **`evidence/progress.html`** for the current state of every gate, the latest
screenshots, and the performance numbers.

Design notes that matter if you touch the harness:

- **Captures run on ANGLE/SwiftShader** (software rasterisation). That is what makes
  "bit-identical" mean something on any machine rather than being an artefact of one GPU driver.
- **Profiling runs on the real GPU.** Software timings are meaningless.
- **Every shot gets a fresh browser process, context and page.** State cannot leak between shots.
- Screenshots are read from the **WebGL backbuffer**, not the compositor, so the evidence is
  exactly what the renderer produced.
- The profiler reports **percentiles and per-hitch attribution, never averages** — averages hide
  precisely the stalls that make a game feel bad.

### Adding a shot

Add an entry to `src/shots.js`. A shot seeks the world to an exact state and frames the camera;
it must never read wall time and must never depend on a previous shot. Then:

```bash
npm run capture -- --shots your-shot-id
```

---

## The rules this codebase enforces on itself

These are checked by tooling, not by convention:

1. No downloaded assets of any kind. (`lint:assets`)
2. No `Math.random()`. All randomness flows from the world seed through named streams in
   `src/core/rng.js`, so adding a consumer never shifts an existing one. (`lint:determinism`)
3. No wall-clock reads in simulation code. Simulation time comes from `Clock.simTime`.
   (`lint:determinism`, with an explicit waiver list for boot instrumentation)
4. Fixed 1/60 s timestep. Rendering interpolates; it never mutates simulation state.
5. Zero shader compilations after boot. Everything is compiled by `Renderer.prewarm()`, and the
   capture manifest reports any program linked afterwards.
6. No colour is hardcoded outside `src/gen/palette.js`.

---

## Troubleshooting

**A black screen and `WebGL2 not supported`.** The game needs WebGL2. Check `chrome://gpu`.
Software rendering works but will be slow.

**Port 5273 already in use.** `npm run dev -- --port 5299`, or stop the other server. The capture
tool reuses an already-running dev server on 5273 if it finds one.

**`npm run capture` cannot find a browser.** It looks for a Playwright-managed Chromium first,
then a system Chrome. Install one with `npx playwright install chromium`.

**Captures differ between runs.** That is a real bug, not a flake — the whole point of the
harness. `npm run capture -- --verify` will name the shots that differ. The usual cause is new
code reading `Math.random()` or the wall clock; `npm run lint:determinism` finds it.

**Saves.** Progress lives in `localStorage` under `glv.save.v1.slot0..2`. Clearing site data
starts a new game. A save stores the seed plus what you changed — the world itself is
regenerated from the seed, never stored.
