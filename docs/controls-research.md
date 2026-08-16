# Control Scheme Research — Grand Line Voxel

Research phase. Nothing here is implemented. Every claim is attributed; sources at the end.

---

## 1. What the problem actually is

The game currently binds **23 distinct actions**:

| group | actions | count |
|---|---|---|
| Locomotion | forward, back, left, right, jump, sprint, dodge | 7 |
| Combat | attack, heavy, block/parry, lock-on | 4 |
| Abilities | ability1, ability2, ability3, swapFruit | 4 |
| Ship | sailUp, sailDown, anchor | 3 |
| World | interact | 1 |
| Menus | map, quests, crew, pause | 4 |

Twenty-three is past what a player holds in working memory. The research is blunt about this:
*"If you give a user 10 new buttons at once, their brain freezes"*, and the rate at which players
absorb new controls is fixed by human cognition — introduce one element at a time (Cognitive Load
in Game UX; Game Tutorial Design / FTUE).

But the count is not the real problem. The real problem is that **all 23 are bound globally, in a
game with three mutually exclusive modes** (on foot, at the helm, in a menu). `R`, `F` and `G` do
nothing on foot; `1`/`2`/`3`, `T` and `C` do nothing at the helm. That is dead weight the player
still has to memorise.

`src/scenarios.js` already documents the correct instinct — *"On foot and aboard ship share the
movement keys deliberately: a player should never have to learn a second set of controls to
sail"* — and `W`/`S` already double as raise/reef sail. So `R`/`F` are a **second, redundant**
binding for something `W`/`S` already does. The principle is in the codebase; it just hasn't been
carried to its conclusion.

---

## 2. The principles the research agrees on

### 2.1 Context-sensitivity is right — but only in "black and white" contexts

Context-sensitive controls put several commands on one button and let the game pick, explicitly to
*reduce what the player must memorise* (Game Wisdom / Game Developer). The stated test for when
it's safe: **commands the player would never need at the same time**. "Open a door / close a door /
pull a lever / press a button" collapse safely into one *Use* key.

The failure modes are equally documented:

- **Too many commands per button** — each extra conditional raises the error rate.
- **Poor context detection** — the cited case is accidentally dashing when you meant to dodge in
  *Valdis Story*. The article's specific warning against pairing *attack* with *open door* maps
  directly onto us: `E` firing mid-combat next to an NPC is that same bug class.
- **No player guidance** — players will not remember contextual actions, so on-screen prompts are
  mandatory. *Assassin's Creed* used a persistent "paper doll" showing what each button currently
  does.

**Verdict for us:** helm vs. on-foot is a genuinely black-and-white context — the player enters it
deliberately with `E`, it's visually unmistakable, and you cannot swing a sword and trim a sail in
the same instant. Layering ship verbs onto the movement keys is *supported*. Overloading `E` with
combat-adjacent actions is *warned against*.

### 2.2 Map by analogous intent, not by name — the Black Flag rule

*Assassin's Creed IV: Black Flag* keeps separate Character / Ship / Shortcut control screens, but
**R2 = sprint on land and hold-full-sail at sea**. Same button, same meaning ("go faster"),
different mode. That's the model: don't invent new keys for the ship — map ship verbs onto the
on-foot key whose *intent* already matches.

### 2.3 But don't go too far: vital actions keep dedicated keys

The counterweight ("5 Tips for Designing Control Schemes", tip 3): over-reliance on context
sensitivity means unintended actions fire easily. **Commands that are vital or constantly used
deserve their own button** — jump in a platformer being canonical. For us: attack, heavy, dodge,
block, jump must never be contextual.

### 2.4 Neutral position and reachability

Tip 1 of the same article: fingers rest in a neutral position and frequent actions must be
reachable from it. *"A sure sign of failure is having the player constantly shift their hands away
from the neutral position during play."*

MMO keybinding practice divides the left hand into zones:

| zone | keys | cost |
|---|---|---|
| **Easy** (no travel) | `WASD`, `Q`, `E`, `Space`, `Shift`, `Ctrl` | free |
| **Medium** (slight travel) | `R`, `F`, `1`–`5`, `Z`/`X`/`C` | cheap |
| **Hard** (hand repositions) | `6`–`0`, `Alt`, symbols | avoid for real-time actions |

Our defaults score: `Q` block ✓, `E` interact ✓, `1`/`2`/`3` ✓, `M`/`J`/`K` ✓ (not real-time),
`C` dodge ⚠, `R`/`F`/`G` ⚠, `T` lock-on ⚠, `X` swap ⚠.

`C` for dodge is the notable ergonomic cost: the ring finger leaves `A`/`D` mid-fight. Modifiers
and mouse side-buttons are cheaper.

### 2.5 Modifiers multiply the map for free

Staying near `WASD` gives roughly eleven fast keys; **with `Shift` and `Ctrl` modifiers that
triples to ~33 bindings** without leaving neutral. This is the standard answer to "too many verbs."
(Web caveat in §4.4 — `Ctrl` is dangerous in a browser.)

### 2.6 Tap vs. hold on one key — the Genshin pattern

*Genshin Impact* gives some Elemental Skills **different behaviour tapped vs. held** — the held
version stronger with a longer cooldown (Sayu's roll is the cited example). Doubles ability count
with no extra key.

**Cost:** detecting a hold means you cannot resolve the tap until the hold window expires, adding
latency to the *tap*. Fine for abilities, unacceptable for attack/dodge.

### 2.7 Radial menus don't scale past ~8

Radial menus give fast one-handed access, show only relevant items, and shine on controller. But
**"radial menus don't scale great; if you have more than eight options you need another wheel or a
different solution."** Six fruits × three abilities = 18, so one wheel is out — hotbar plus
set-swap (what we have) is the right structure for keyboard.

### 2.8 Forgiveness windows are what "tight controls" actually means

Coyote time (accept a jump shortly *after* leaving a ledge) and input buffering (accept a press
shortly *before* the action is legal) are the two most impactful forgiveness mechanics, and neither
is visible: *"Games like Celeste and Super Meat Boy are widely cited as having the best-feeling
controls ever made, and neither community talks about coyote time as a feature — they talk about
the controls feeling tight and responsive."*

The physiological basis: human vision runs ~13 ms behind reality, so by the time the player *sees*
the character leave the ledge it has already been airborne for several frames.

Published ranges:

| game type | coyote | buffer |
|---|---|---|
| tight precision platformer | 70–100 ms | 70–110 ms |
| **action platformer (us)** | **90–140 ms** | **100–150 ms** |
| casual mobile | 110–170 ms | 120–180 ms |

Applies to jump, dodge, *and* combo chaining — buffering is what lets a queued light attack fire
the instant the previous animation's cancel window opens.

### 2.9 Lock-on: don't cycle targets with the mouse

Lock-on frees the aiming hand and lets combat widen its input vocabulary. **Soft lock** persists
only while held; **hard lock** toggles until released — commonly one button split by press
duration.

The specific K&M complaint from Souls players is worth designing out: *"moving the camera while
locked on will tell the game you want to cycle targets, so you shouldn't move the mouse while
locked on if you don't intend to cycle."* **Put target cycling on the wheel or discrete keys, never
on raw mouse delta.**

---

## 3. Accessibility — the part with hard requirements

Two authorities: the **Game Accessibility Guidelines** (GAG) and **Xbox Accessibility Guideline
107** (XAG 107). XAG 107 is a certification-adjacent checklist, not a soft suggestion.

### 3.1 Full in-game remapping — GAG rates this "Basic" tier, best-value

GAG calls remapping *"one of the best value accessibility features."* Requirements:

- **In-game, not platform-level.** In-game remapping lets prompts reflect the current mapping,
  supports separate maps per mode (explicitly: *"walking/driving separately"* — i.e. **on-foot vs.
  helm**), and puts settings where players look.
- **Ship presets *and* a full custom option.** Presets cut setup burden; custom covers the rest.
- Cited best practice: *CS:GO*, *Overwatch*, *Street Fighter IV*.
- GAG explicitly names **AZERTY users** as beneficiaries — which folds into §4.2.

XAG 107 adds:

- Remapping must include **the Esc key on PC**.
- Remapped labels must propagate to **every hint, tip, tutorial and control map**.
- Ideally assign an action to *any* input, not merely swap two buttons.
- Better still: **remap *actions*, not controls** — if an action needs two simultaneous buttons, let
  the player bind that action to one button.

**Current state:** `src/core/input.js` supports remapping (`this.binds`, persisted via save), but
`src/ui/menus.js` exposes only Invert-Y and Look Sensitivity. There is no rebinding UI. This is the
largest single gap against the guidelines.

### 3.2 Hold vs. toggle — every hold needs an alternative

XAG 107 names three input barriers remapping alone does **not** fix:

- **Speed** — actions requiring rapid activation (combat).
- **Complexity** — simultaneous or ordered multi-button inputs.
- **Duration** — sustained holds fatigue; *"re-assigning accelerate to a different input does not
  eliminate the source of the barrier."*

Prescribed fixes: **toggles and "auto" holds** (auto-sprint, auto-fire, Minecraft's auto-jump),
game speed control, and action-level remapping. *The Long Dark* is cited for an "accessible
interactions" option that **converts all press-and-hold actions into press actions**.

Also explicitly to avoid or provide alternatives for:

- mechanics needing **two buttons simultaneously**;
- mechanics needing a key **held a long time before registering**;
- **button-mashing and QTEs** — *Gears 5* lets players pick press-and-hold *or* quick-taps.

Community evidence converges: hold-to-sprint is widely reported as fatiguing, players with wrist
injuries specifically request toggle/auto-sprint, and the trend is to ship **both**.

**Our holds:** sprint (`Shift`), block (`Q`), and critically **block-hold with parry-on-tap is one
key carrying a duration-sensitive distinction** — exactly the pattern XAG 107 flags. It is a good
design; it needs an alternative path, not removal.

### 3.3 Digital alternatives to analogue input

XAG 107's stated goal: *"a player can operate the gaming interface through input mechanisms of
their choice."* Wherever analogue input (mouse look) is required, **single-press digital input must
achieve the same task**. The worked example is *Grounded*: `WASD` to walk **plus arrow keys to
look**, so the mouse is never essential.

We bind arrow keys as movement aliases, so a keyboard-only player has **no way to turn the
camera**. The plumbing exists — `Space` and the arrows are already `preventDefault`ed.

Also required: sensitivity adjustable by **at least ±50%** of default (we ship 0.2×–3.0× ✓), and
**everything from launch to quit reachable by keyboard alone**.

### 3.4 Menus: activate on release, not on press

XAG 107: for pointer-operated content the **down event must not activate** — activation happens on
the **up event**, so a player who presses the wrong thing can slide off to cancel. If cancel isn't
possible, provide undo.

**Explicit carve-out:** where down-event activation is *essential* — the guideline names *"shooting
a gun"* — this does not apply. So **combat stays on key-down; menus move to key-up.**

Related: **hold-to-confirm** (press and hold 1–5 s) beats a confirmation dialog for destructive
actions, eliminating accidental activation. Good for overwrite-save / abandon-quest — but per §3.2,
always with a tap alternative.

---

## 4. Web-platform constraints — the ones that will actually bite

Where a browser game differs from a native one, and where the current build has concrete defects.

### 4.1 Escape cannot be your pause key under pointer lock — **live defect**

**Escape always exits pointer lock and a page cannot prevent it** — a deliberate security guarantee
against cursor-trapping. Reported consequence: *"Chrome absorbs the first Escape press to unlock
the pointer, which means Escape needs to be pressed twice to open the pause menu."*

We bind `pause: ['Escape']`. The first Esc gets eaten by the browser.

Documented fixes:

1. Bind pause to a **second key** as well (`P`, `Tab`, or `Backquote`).
2. Listen to **`pointerlockchange`**: when the lock drops and we didn't request it, treat that as
   "player wants out" and **open the pause menu from the lock-loss event**, not the keypress. This
   turns the browser's behaviour into the feature instead of fighting it.

The `pointerlockchange` handler already exists in `input.js` (`onLockChange`) and currently only
records state.

### 4.2 `KeyboardEvent.code` ✓ correct — but the *labels* are wrong on non-QWERTY

We already read `e.code` throughout, which is right: `code` is the **physical position**, `key` is
**the label on the cap**. Using `code` means WASD auto-becomes **ZQSD on AZERTY**, `,AOE` on
Dvorak, with no per-layout tables.

The other half of the problem: **we display "W A S D" as literal text** in the README, HUD and
tutorial. An AZERTY player presses the right physical key but is told the wrong letter. Fix:

```js
const map = await navigator.keyboard.getLayoutMap();
map.get('KeyW');   // "w" on QWERTY, "z" on AZERTY
```

Caveats: **Chromium-only**, needs a secure context, may be blocked in sandboxed/embedded contexts —
so it needs a QWERTY fallback table. A `layoutchange` event fires when the layout changes, so
prompts can refresh live.

### 4.3 Raw mouse input is one line and we're not using it — **free win**

```js
await canvas.requestPointerLock({ unadjustedMovement: true });
```

**Bypasses OS-level mouse acceleration** and delivers raw deltas — the difference between "floaty"
and "1:1" camera feel. Supported in Chrome (not on Linux) and now Firefox. You can toggle between
accelerated and raw by re-requesting the lock without releasing it, so it can be a settings option.
Our `requestPointerLock` currently passes no options.

### 4.4 `Ctrl` is actively hazardous in a browser — **live defect**

We bind `dodge: ['KeyC', 'ControlLeft']`. In a browser:

- **`Ctrl`+`W` closes the tab instantly, with no warning and no save prompt.**
- `W` is our forward key. Dodging while running forward is the most common input in the game.
- **Firefox explicitly refuses to let scripts override `Ctrl`+`W`/`N`/`T`** — `preventDefault()`
  cannot save us. Also reserved: `Ctrl`+`L`, `Ctrl`+`R`, `F5`, `Alt`+`F4`.

`ControlLeft` should come out of the defaults. It can remain *available* to players who explicitly
pick it in a rebind UI, but it must not ship as a default.

### 4.5 Keyboard ghosting sets a ceiling on simultaneous keys

Cheap membrane keyboards commonly do **6-key rollover**, and anti-ghosting is often applied only to
the `WASD` zone. Crucially: **`Shift`/`Ctrl`/`Alt` sit on a separate circuit and don't count toward
the rollover budget** — a 6KRO board handles 6 keys *plus* held modifiers.

Consequences: prefer **modifier + key** over **letter + letter**, and keep required simultaneous
*letter* presses to three or fewer. Our realistic worst case today, `W`+`A`+`Shift`+`Q`+`1`, is
fine — two letters plus `Q`, a digit and a modifier — but it is near the line.

### 4.6 Gamepad support: absent, and ~96% available

`navigator.getGamepads()` is a W3C standard with **~96% global support**; only IE and the legacy
stock Android browser lack it. There is **no gamepad code anywhere in `src/`**.

For an action game with lock-on combat and a ship, this is the largest missing input mode.
Implementation notes that matter:

- Prefer `mapping === "standard"` (Xbox-360-style normalised layout), with a fallback for generic
  DirectInput devices.
- **`getGamepads()` returns a snapshot, not live objects** — re-fetch every frame; a held reference
  never updates.
- **Deadzone filtering is mandatory** or the character drifts.
- **Triggers are analogue** — read `button.value` against a threshold, not `button.pressed`.
- Gate reads on `gamepad.connected`; the array slot persists after a disconnect.
- `GamepadHapticActuator` gives dual-rumble from Chrome 89+.

Controller also unlocks what our verb set wants: **analogue movement** (we're 8-way digital only)
and a **radial/D-pad ability selector** usable one-handed while still moving.

---

## 5. Synthesis — the scheme the research points to

Design rules, in priority order:

1. **Mode-scoped bindings, not global ones.** Ship verbs live only in helm mode, on the movement
   keys whose intent already matches (§2.2). This deletes `R`/`F`/`G` from the global map.
2. **Dedicated keys for anything used in combat** — attack, heavy, block, dodge, jump, lock-on,
   abilities. Never contextual (§2.3).
3. **Nothing real-time outside the easy/medium reach zones** (§2.4).
4. **Modifier layers before new letters** (§2.5) — except `Ctrl` in browsers (§4.4).
5. **Every hold has a toggle; every timing-critical input has a forgiving alternative** (§3.2).
6. **Every default rebindable, per mode, in-game, with labels that update** (§3.1, §4.2).

Applying those:

| action | on foot | at the helm | notes |
|---|---|---|---|
| move / steer | `W` `A` `S` `D` | `A` `D` = helm | unchanged |
| sail more / less | — | `W` / `S` | already true; **`R`/`F` become redundant** |
| go faster | `Shift` sprint | `Shift` full sail | the Black Flag rule |
| jump | `Space` | — | dedicated |
| dodge | `Mouse4`, or `Space`-modified — **off `Ctrl`** | — | `C` costs an `A`/`D` finger |
| attack / heavy | `LMB` / `RMB` | — | dedicated, key-**down** |
| block / parry | `Q` hold / tap | — | needs a toggle alternative (§3.2) |
| lock-on | `T` or `Mouse3` | — | cycle on **wheel**, not mouse delta (§2.9) |
| abilities | `1` `2` `3` | — | tap/hold could double these (§2.6) |
| swap fruit set | `X` or wheel | — | needs loud visual feedback |
| interact / board / dock / anchor | `E` | `E` | **anchor folds into contextual `E`** — but guard against `E` firing mid-combat (§2.1) |
| map / quests / crew | `M` `J` `K` | same | not real-time; fine as they are |
| pause | `Esc` **+ second key** + `pointerlockchange` | same | §4.1 |

Unused capacity worth noting: `Mouse4`/`Mouse5` are never read (`input.js` handles only buttons 0
and 2), and `mouse.wheel` is captured but unused. Three free, easy-zone inputs.

---

## 6. Gap list against the current build

| # | finding | severity |
|---|---|---|
| 1 | `ControlLeft` bound to dodge → `Ctrl`+`W` closes the tab, unpreventable in Firefox | **defect** |
| 2 | `Esc` is the only pause key; browsers eat the first press under pointer lock | **defect** |
| 3 | No rebinding UI despite `input.js` supporting it — GAG "Basic" tier miss | **major** |
| 4 | No gamepad support at all (~96% of browsers can) | **major** |
| 5 | No keyboard-only look (arrow keys are movement aliases) — XAG 107 miss | **major** |
| 6 | `requestPointerLock()` doesn't pass `unadjustedMovement: true` | **easy win** |
| 7 | Key labels hardcoded QWERTY; `getLayoutMap()` unused | **moderate** |
| 8 | `R`/`F`/`G` globally bound but only meaningful at the helm | **moderate** |
| 9 | No toggle alternatives for sprint / block holds — XAG 107 miss | **moderate** |
| 10 | Menu activation on key-down rather than key-up | **minor** |

Items 1, 2 and 6 are small, self-contained changes. Items 3, 4 and 5 are features.

---

## Sources

**Control-scheme design**

- [Implementing Context Sensitive Commands in UI Design — Game Developer](https://www.gamedeveloper.com/design/implementing-context-sensitive-commands-in-ui-design)
- [Implementing Context Sensitive Commands in UI Design — Game Wisdom](https://game-wisdom.com/critical/context-sensitive-commands-ui-design)
- [5 Tips for Designing Control Schemes — Game Wisdom](https://game-wisdom.com/critical/5-tips-for-control-schemes)
- [Defining "Button-Heavy" Game Design — Game Wisdom](https://game-wisdom.com/critical/button-heavy-game-design)
- [Context-Sensitive Button — TV Tropes](https://tvtropes.org/pmwiki/pmwiki.php/Main/ContextSensitiveButton)
- [Game controls for 3rd person and First Person Shooter Games — Game Developer](https://www.gamedeveloper.com/game-platforms/game-controls-for-3rd-person-and-first-person-shooter-games)

**Genre precedent**

- [Assassin's Creed Black Flag Resynced Controls List and Guide — VULKK](https://vulkk.com/2026/07/09/assassins-creed-black-flag-resynced-controls-list-and-guide/)
- [Controls Reference — AC Black Flag Resynced Wiki](https://assassinscreedblackflagresynced.wiki/game-info/controls/)
- [Controls: PC, PlayStation & Xbox — Elden Ring Wiki (Fextralife)](https://eldenring.wiki.fextralife.com/Controls)
- [Ultimate Keyboard and Mouse Control Settings: Dark Souls Inspired — Steam Guide](https://steamcommunity.com/sharedfiles/filedetails/?id=3335382471)
- [Lock-On Styles in Action Games — Celia Wagar's CritPoints](https://critpoints.net/2015/05/24/what-is-your-ideal-form-of-lock-on-in-action-games/)
- [Camera Lock-On — TV Tropes](https://tvtropes.org/pmwiki/pmwiki.php/Main/CameraLockOn)
- [Elemental Skill — Genshin Impact Wiki](https://genshin-impact.fandom.com/wiki/Elemental_Skill)
- [Elemental Burst — Genshin Impact Wiki](https://genshin-impact.fandom.com/wiki/Elemental_Burst)

**Ergonomics & keybinding practice**

- [MMO Keybinding 101 — Game Informer](https://gameinformer.com/b/news/archive/2010/12/29/mmo-keybinding-101.aspx)
- [The Art of Keybinding — iXie Gaming](https://www.ixiegaming.com/blog/the-art-of-keybinding/)
- [Guide to Keybinding in MMOs for PVP and PVE — Taugrim](https://taugrim.com/2011/04/07/guide-to-strafing-movement-and-keybindings/comment-page-2/)
- [Best Keybinds: Fix Awkward Controls Fast — walkthroughs.games](https://walkthroughs.games/blog/best-keybinds-fix-awkward-controls-fast)
- [Why Your MMO Keybinds Are Wrong — EJS Computers](https://ejscomputers.com/blogs/news/why-your-mmo-keybinds-are-wrong-and-mine-are-perfect)

**Menus & ability selection**

- [Radial Menus in Game Design: Boosting UX & Player Speed — 300mind](https://300mind.studio/blog/radial-menus-in-game-design/)
- [The power of the radial menu — UX Collective](https://uxdesign.cc/the-power-of-the-radial-menu-a-love-letter-to-apex-legends-from-a-ux-designer-and-perpetual-noob-1bec9b05e805)
- [Button Prompts (Contextual) — Game UI Database](https://www.gameuidatabase.com/index.php?set=1&tag=30%2C101%2C15&scrn=151)

**Game feel & forgiveness**

- [Coyote Time, Input Buffering, and the Art of Forgiving Controls — GameJuice](https://www.gamejuice.co.uk/articles/coyote-time-input-buffering)
- [Input Buffering and Coyote Time — a Godot 4 and Unity-Friendly Timing Primer](https://gamineai.com/blog/input-buffering-and-coyote-time-in-2d-a-godot-4-and-unity-friendly-timing-primer)
- [Input Buffering, Action Canceling, and also Forbidden Knowledge — Yosi Spring](https://medium.com/@yosispring/input-buffering-action-canceling-and-also-forbidden-knowledge-47a3f8a95151)
- [Mastering Input Buffering: The Secret to Responsive Game Controls — Wayline](https://www.wayline.io/blog/mastering-input-buffering-responsive-game-controls)

**Accessibility**

- [Allow controls to be remapped / reconfigured — Game Accessibility Guidelines](https://gameaccessibilityguidelines.com/allow-controls-to-be-remapped-reconfigured/)
- [Xbox Accessibility Guideline 107 — Microsoft Learn](https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/107)
- [Avoid / provide alternatives to requiring buttons to be held down — GAG](http://gameaccessibilityguidelines.com/avoid-provide-alternatives-to-requiring-buttons-to-be-held-down)
- [Ensure that all key actions can be carried out by digital controls — GAG](http://gameaccessibilityguidelines.com/ensure-that-all-key-actions-can-be-carried-out-by-digital-controls-pad-keys-presses-with-more-complex-input-eg-analogue-speech-gesture-not-required-and-included-only-as-supplementary-al)
- [Accessible Control Schemes: Moving Beyond Remappable Buttons — Filament Games](https://www.filamentgames.com/blog/accessible-control-schemes-moving-beyond-remappable-buttons/)
- [Control Guidelines — Accessible Game Design](https://accessiblegamedesign.com/guidelines/controls.html)
- [Motor/Physical Accessibility Guide — Can I Play That?](https://caniplaythat.com/2019/07/04/basic-accessibility-options-for-mobility/)
- [Exploring Preferences: Shift to Sprint or Toggle Sprint? — LevelUpTalk](https://leveluptalk.com/news/sprinting-preferences-hold-shift-or-toggle/)

**Web platform**

- [Pointer Lock API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_Lock_API)
- [Element: requestPointerLock() — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestPointerLock)
- [Pointer lock and first person shooter controls — web.dev](https://web.dev/articles/pointerlock-intro)
- [Disable mouse acceleration to provide a better FPS gaming experience — web.dev](https://web.dev/articles/disable-mouse-acceleration)
- [Raw mouse input in the browser — easimer.net](https://easimer.net/homepage/2024/09/25/pointer-lock-raw-input.html)
- [Pointer Lock 2.0 — W3C](https://www.w3.org/TR/pointerlock-2/)
- [Pointer lock (mouse look) on the web — Castle Game Engine](https://castle-engine.io/wp/2026/08/02/pointer-lock-mouse-look-on-the-web-plus-a-big-refactor-and-windows-improvements/)
- [WASD Controls on the Web: use KeyboardEvent.code — bram.us](https://www.bram.us/2022/03/31/wasd-controls-on-the-web/)
- [KeyboardEvent: code property — MDN](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code)
- [Internationalize your keyboard controls — Mozilla Hacks](https://hacks.mozilla.org/2017/03/internationalize-your-keyboard-controls/)
- [Keyboard: getLayoutMap() — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Keyboard/getLayoutMap)
- [KeyboardLayoutMap — MDN](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardLayoutMap)
- [keyboard-map explainer — WICG](https://github.com/WICG/keyboard-map/blob/main/explainer.md)
- [Ctrl+W closes browser games — Construct bug #8003](https://github.com/Scirra/Construct-bugs/issues/8003)
- [Ctrl+N, Ctrl+T and Ctrl+W no longer available to scripts — Mozilla Bug 1291706](https://bugzilla.mozilla.org/show_bug.cgi?id=1291706)
- [Keyboard shortcuts do not conflict with browser defaults — AuditBuffet](https://auditbuffet.com/patterns/ab-001376)
- [Using the Gamepad API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API/Using_the_Gamepad_API)
- [Gamepad: mapping property — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad/mapping)
- [The HTML5 Gamepad API: A Developer's Guide to Browser Controllers (2026)](https://gamepadtester.pro/the-html5-gamepad-api-a-developers-guide-to-browser-controllers/)
- [Gamepad API: Browser Support, Features, Known Issues — TestMu AI](https://www.testmuai.com/learning-hub/gamepad-api-browser-support/)

**Keyboard hardware**

- [Understanding N-Key Rollover and Anti-Ghosting — Laptop Outlet](https://www.laptopoutlet.co.uk/blog/understanding-n-key-rollover-anti-ghosting-gaming-keyboards.html)
- [Diagnosing Modifier Ghosting — AttackShark](https://attackshark.com/blogs/knowledges/diagnosing-modifier-ghosting-fix-multi-key-input)
- [What Is Keyboard Ghosting? Anti-Ghosting, NKRO & Fixes (2026)](https://keyboardtester.click/blog/what-is-keyboard-ghosting-anti-ghosting-fix-guide.php)

**Onboarding & cognitive load**

- [The Gamer's Brain, Part 2: UX of Onboarding and Player Engagement (GDC16) — Celia Hodent](https://celiahodent.com/gamers-brain-ux-onboarding/)
- [Game Tutorial Design: Reducing Cognitive Load in Your FTUE — game-changr](https://www.game-changr.com/post/game-tutorial-design-cognitive-load-ftue)
- [Cognitive Load and Usability in Game Interface Design — Zeynep Balıbek Cihanbeyoğlu](https://medium.com/@zeynepbalibek.ux/cognitive-load-and-usability-in-game-interface-design-ad381ffc7651)
- [Minimizing Cognitive Load: Simplifying Complex Systems in Game UX — Corey Hobson](https://coreyhobson.medium.com/minimizing-cognitive-load-strategies-for-simplifying-complex-systems-in-game-ux-fcc72544c8e3)
- [Player Onboarding in a Low-Complexity Game Favouring Implicit Instructions (thesis, PDF)](https://www.diva-portal.org/smash/get/diva2:1871016/FULLTEXT01.pdf)

**Destructive-action UX**

- [Why holding buttons is superior to confirmation dialogs in UX design — DEV](https://dev.to/tomj/why-holding-buttons-is-superior-to-confirmation-dialogs-in-ux-design-1fic)
- [A UX guide to destructive actions — Bootcamp](https://medium.com/design-bootcamp/a-ux-guide-to-destructive-actions-their-use-cases-and-best-practices-f1d8a9478d03)
- [Why do games require us to hold down a button to interact? — ResetEra](https://www.resetera.com/threads/why-do-games-require-us-to-hold-down-a-button-to-interact.147409/)
