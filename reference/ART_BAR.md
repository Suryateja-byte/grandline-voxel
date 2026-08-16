# ART BAR — transcription of `reference/art-bar.png`

## Provenance note (read this first)

`reference/art-bar.png` was **not present** in the repository at run start (the repo was empty).
The reference image was supplied as an attachment in the task prompt. Because subagent critics
receive text only, the orchestrator transcribed the reference into the measurable specification
below. **This document is the operative art bar for all blind critiques.** Where this document
and the original image disagree, the image wins — but no agent in this run can see the image, so
this document is what gets enforced.

Everything below is a *standard to beat*, not a design to copy.

---

## 1. Subject and silhouette

- **Chibi voxel proportions.** Head is ~38–42% of total character height. Head width ≈ 1.5–1.7×
  torso width. Legs are short and thick; arms are thick and taper little.
- **Character height in voxels: 14–18.** Voxels are large and individually readable. You should be
  able to count the cubes across the character's chest from a gameplay camera distance.
- **The silhouette must survive being filled with flat black.** A pure-black cutout of the
  character must remain identifiable: hat brim breaking the head outline, an open dynamic pose with
  a raised limb, clear negative space between limbs and torso.
- **Headgear / identity element extends past the head silhouette** (the straw hat brim is ~1.3×
  head width). Every character archetype needs one silhouette-breaking identity element.
- **Pose is diagonal and dynamic**, never a T-pose or a symmetric idle. Weight is off-centre.

## 2. Face readability (the hardest gate)

- Faces read **at a glance, at gameplay distance**, from high-contrast dark features on light skin.
- Eyes are **large, dark, angular** shapes — 2×2 to 3×2 voxel-equivalents. Happy/closed eyes are
  bold inverted-V wedges. Never small dots.
- Mouth is a **large dark aperture** with a distinct dark-red interior and a lighter tooth band.
- Face detail is drawn into the **texture**, not modelled as geometry.
- One asymmetric identity mark (a scar, a freckle cluster, an eyepatch) per named character.

## 3. Palette (measured from the reference)

Saturated, high-key, warm-vs-cool complementary separation. No muddy mid-tones. No greys.

| Role | Hex | Note |
|---|---|---|
| Sky zenith | `#59B7EC` | clean saturated cyan-blue |
| Sky horizon | `#A8DCF5` | pale, warmer |
| Cloud | `#FFFFFF` | pure white, hard-edged voxel blocks |
| Sea (deep) | `#2FA8C4` | turquoise, not navy |
| Sea (shallow) | `#5FD6DE` | brightens sharply toward shore |
| Sand (lit) | `#F0DDB4` | |
| Sand (shadow) | `#E4C58F` | |
| Grass | `#7CC24B` / `#5FA83C` | two tonal steps minimum |
| Rock | `#8A6A4E` | warm brown-grey, never neutral grey |
| Palm frond | `#4E9E3A` | |
| Skin (lit) | `#F2C99A` | warm tan |
| Skin (highlight) | `#FFE0BC` | |
| Skin (shadow) | `#D19A6B` | still warm, never grey |
| Hero red (vest) | `#D93A2B` | fully saturated |
| Hero gold (sash) | `#E8B93C` | |
| Straw hat | `#E8C170` | with `#D4342B` band |
| Hero cyan (shorts) | `#3FA9E0` → `#7FD0F0` | |
| Hair / dark features | `#1B2233` → `#2A2F45` | blue-black, never pure black |
| Mouth interior | `#7A1A1A` | |

**Rule:** the hero silhouette is separated from the sky by **hue complement** (warm red/gold vs cool
cyan), not by an outline shader. If a character disappears against the sky, the fix is hue, not
contrast.

## 4. Material tonal steps

- Every material shows **2–3 tonal steps within a single surface** — the hat is not one flat yellow.
  Flat single-colour regions are a FAIL.
- Steps come from (a) per-voxel palette jitter baked into the texture and (b) per-face shading.
- **Per-face shading is mandatory and constant:** top faces brightest, ±X faces mid,
  ±Z faces darkest. Approximate ratios 1.00 / 0.86 / 0.72. This is what makes a cube read as a cube.
- Ambient occlusion darkens voxel-to-voxel concave corners. Subtle — never a dirty smear.

## 5. Lighting

- **One strong key sun**, upper-left, slightly behind subject.
- **Soft rim light on the upper-right edges** of characters and terrain, sky-coloured, clearly
  visible. This is the single most identifiable feature of the reference. A render without rim
  light does not match the bar.
- **Shadows are never crushed to black.** Shadowed albedo sits at ~55–65% luminance of the lit side
  and shifts **blue-violet**, picking up sky ambient. Pure-black shadow is a FAIL.
- Ambient is **hemispheric**: blue-tinted sky fill from above, warm bounce from below (sand/water).
- No visible specular hotspots on characters. Water is the only strongly specular surface.

## 6. Camera and composition

- Low camera, looking **slightly up** at the subject.
- Subject occupies ~50–60% of frame height.
- Everything crisp — **no depth of field, no motion blur.** Distance is conveyed by aerial
  perspective (fog tinted toward the sky horizon colour), not by blur.
- Small **detached floating voxel motes** in the air convey speed and scale. These are cheap and
  they matter.

## 7. Tone mapping / grade

- Output is bright and high-key. Highlights roll off softly; they do not clip to flat white patches.
- Slight warm lift in highlights, slight cool push in shadows.
- Saturation is high but not neon — colours stay believable as painted objects.
- No heavy bloom. A thin bloom on sun/water sparkle only.

---

## Named benchmarks (also standards to beat)

- **Minecraft** — block-world terrain readability, biome silhouette at distance. Judge: at 300m can
  you name the biome and read the island's shape? Is the horizon line interesting?
- **Sea of Thieves** — sailing feel, water behaviour, horizon. Judge: does the ship feel heavy and
  driven by the water rather than sliding on it? Do waves have a believable period and steepness?
  Does the horizon sell scale?
- **Hades** — combat readability. Judge: can you tell what an enemy is about to do before it hits
  you, from the telegraph alone, with the sound off? Does every hit land with weight (hitstop,
  shake, flash, knockback)? Is each ability instantly legible as itself?

## Blind-critique protocol

Critics receive: the goal, this document, the raw evidence (screenshots/metrics), and nothing else.
Never the owner's reasoning. Verdict is exactly one of **FAIL** or **SHIP IT**.
**SHIP IT only when the critic prefers ours or genuinely cannot tell the two apart.**
On FAIL, the critic returns: the single biggest gap, the observable evidence for it, and the
minimum change required to re-review. **No numeric scores, ever.**
