// The master palette. Every colour in the game resolves through here.
// Values transcribed from reference/ART_BAR.md §3. Owner: art-direction.
//
// Rule enforced by convention: no module may hardcode a hex colour. If you need a new
// colour, add it here with a name, so the whole game can be regraded from one file.

/** '#rrggbb' -> [r,g,b] in 0..255 */
export function hex2rgb(hex) {
  const n = typeof hex === 'number' ? hex : parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgb2hex(r, g, b) {
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

/** sRGB 0..255 -> linear 0..1 (matches THREE.SRGBColorSpace decode) */
export function srgb2lin(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function lin2srgb(c) {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, v)) * 255);
}

/** Perceptual-ish HSL helpers so palette variants stay in family. */
export function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h, s, l];
}

export function hsl2rgb(h, s, l) {
  h = ((h % 1) + 1) % 1;
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** Shift a colour in HSL space. dh in turns, ds/dl additive. */
export function shift(hex, dh, ds, dl) {
  const [r, g, b] = hex2rgb(hex);
  let [h, s, l] = rgb2hsl(r, g, b);
  h += dh; s = Math.max(0, Math.min(1, s + ds)); l = Math.max(0, Math.min(1, l + dl));
  const [R, G, B] = hsl2rgb(h, s, l);
  return rgb2hex(R, G, B);
}

/**
 * Shadow variant per ART_BAR §5: 55–65% luminance and a blue-violet hue push.
 * Never darken by multiplying toward black — that produces the muddy look the bar rejects.
 */
export function shadeDown(hex, amount = 1) {
  const [r, g, b] = hex2rgb(hex);
  let [h, s, l] = rgb2hsl(r, g, b);
  const target = 0.66; // hue of blue-violet in turns
  let dh = target - h;
  if (dh > 0.5) dh -= 1; if (dh < -0.5) dh += 1;
  h += dh * 0.16 * amount;
  s = Math.min(1, s * (1 + 0.10 * amount));
  l = l * (1 - 0.38 * amount);
  const [R, G, B] = hsl2rgb(h, s, l);
  return rgb2hex(R, G, B);
}

/** Highlight variant: warm lift, per ART_BAR §7. */
export function shadeUp(hex, amount = 1) {
  const [r, g, b] = hex2rgb(hex);
  let [h, s, l] = rgb2hsl(r, g, b);
  const target = 0.09; // warm yellow-orange
  let dh = target - h;
  if (dh > 0.5) dh -= 1; if (dh < -0.5) dh += 1;
  h += dh * 0.10 * amount;
  s = Math.max(0, s * (1 - 0.08 * amount));
  l = Math.min(1, l + (1 - l) * 0.28 * amount);
  const [R, G, B] = hsl2rgb(h, s, l);
  return rgb2hex(R, G, B);
}

export function mixHex(a, b, t) {
  const [ar, ag, ab] = hex2rgb(a);
  const [br, bg, bb] = hex2rgb(b);
  return rgb2hex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}


export const P = {
  // --- sky / atmosphere ---
  skyZenith: 0x59b7ec,
  skyHorizon: 0xa8dcf5,
  skyZenithDusk: 0x3d5f9e,
  skyHorizonDusk: 0xf2a15c,
  skyZenithNight: 0x111a38,
  skyHorizonNight: 0x2a3560,
  skyZenithStorm: 0x4a5566,
  skyHorizonStorm: 0x8e9aa6,
  cloud: 0xffffff,
  cloudShade: 0xc6d8ea,
  cloudStorm: 0x6e7a88,
  sunDisc: 0xfff3cf,
  sunLight: 0xfff0d2,
  sunLightDusk: 0xffb877,
  moonDisc: 0xdfe8ff,
  moonLight: 0x8fa6e8,
  star: 0xffffff,

  // --- sea ---
  seaDeep: 0x2fa8c4,
  seaShallow: 0x5fd6de,
  seaAbyss: 0x1b6f8c,
  seaSSS: 0x7ff0e2,
  seaFoam: 0xffffff,
  seaDeepNight: 0x14384f,
  seaShallowNight: 0x2a6d80,
  seaDeepStorm: 0x2a6274,
  seaShallowStorm: 0x4f9aa8,

  // --- terrain blocks ---
  sand: 0xf0ddb4,
  sandDark: 0xe4c58f,
  sandWet: 0xd6bd8c,
  grass: 0x7cc24b,
  grassDark: 0x5fa83c,
  grassDry: 0xc9c05a,
  grassCold: 0x8fc8a0,
  jungle: 0x4e9e3a,
  jungleDark: 0x35772a,
  dirt: 0x9c6f45,
  dirtDark: 0x7a5334,
  rock: 0x8a6a4e,
  rockDark: 0x6d523c,
  rockCold: 0x7f8796,
  stone: 0x9a9a94,
  stoneDark: 0x77776f,
  snow: 0xf4f8ff,
  ice: 0xa8e4f0,
  iceDeep: 0x6fc4dc,
  lava: 0xff6a1e,
  lavaHot: 0xffd05a,
  ash: 0x4a4340,
  volcanicRock: 0x3c3330,
  clay: 0xc98a5c,
  coral: 0xf27fa5,
  coralAlt: 0xf5c65a,
  cactus: 0x5c9e52,
  mushroomCap: 0xe0546a,
  mushroomStem: 0xf0e6d2,
  cherryBlossom: 0xf7a9c4,
  autumnLeaf: 0xe0813a,

  // --- built / props ---
  wood: 0xa9713f,
  woodDark: 0x7d5230,
  woodPale: 0xd2a570,
  plank: 0xc08a4e,
  plankDark: 0x96683a,
  thatch: 0xd9b063,
  rope: 0xd9c08a,
  sail: 0xf5efe0,
  sailShade: 0xdcd2bd,
  metal: 0xb8c0cc,
  metalDark: 0x848e9e,
  gold: 0xe8b93c,
  goldDark: 0xb88b21,
  barrel: 0x9a6b3c,
  lanternGlow: 0xffc75a,
  flagRed: 0xd93a2b,
  paper: 0xf2e6c8,
  ink: 0x2a2f45,
  glass: 0x9fd8e8,
  brickRed: 0xb5533f,
  roofTile: 0xc4523f,
  roofTileDark: 0x963a2c,

  // --- character ---
  skin: 0xf2c99a,
  skinHi: 0xffe0bc,
  skinLo: 0xd19a6b,
  skinTan: 0xd9a066,
  skinDark: 0x9c6b45,
  skinPale: 0xfae0c4,
  hair: 0x1b2233,
  hairSoft: 0x2a2f45,
  hairBrown: 0x6b4326,
  hairGinger: 0xe08040,
  hairBlonde: 0xf0d070,
  hairGreen: 0x4e9e5a,
  hairWhite: 0xeef2f8,
  mouth: 0x7a1a1a,
  tooth: 0xfdf6ec,
  eyeWhite: 0xfdf6ec,
  eyeDark: 0x1b2233,

  heroRed: 0xd93a2b,
  heroRedDark: 0xa8281c,
  heroGold: 0xe8b93c,
  heroCyan: 0x3fa9e0,
  heroCyanLight: 0x7fd0f0,
  strawHat: 0xe8c170,
  strawHatDark: 0xc79f52,
  hatBand: 0xd4342b,

  marineBlue: 0x2f5fa8,
  marineNavy: 0x1d3c6e,
  marineWhite: 0xf2f2ee,
  pirateBlack: 0x2b2b33,
  pirateMaroon: 0x7a2438,
  bandit: 0x6b5a3c,
  fishmanTeal: 0x3aa8a0,
  fishmanDeep: 0x24756f,
  royalPurple: 0x6c4bb5,
  bruiserOrange: 0xe07a2b,
  assassinViolet: 0x8b5cc7,

  // --- devil fruit signature colours (one hue each, never reused) ---
  fruitGomu: 0xff5c8a,
  fruitMera: 0xff6a1e,
  fruitMeraHot: 0xffd05a,
  fruitHie: 0x8fe8ff,
  fruitHieDeep: 0x3f9fd0,
  fruitSuna: 0xe0b76a,
  fruitSunaDark: 0xb98d43,
  fruitGura: 0xb07de8,
  fruitGuraDark: 0x6b3fb0,
  fruitZushi: 0x4ad6a8,
  fruitZushiDark: 0x1f8f6b,

  // --- UI ---
  uiInk: 0x1b2233,
  uiPaper: 0xf4e7c8,
  uiPaperDark: 0xd9c69c,
  uiGold: 0xe8b93c,
  uiRed: 0xd93a2b,
  uiGreen: 0x5fbf4b,
  uiCyan: 0x3fc6d6,
  uiWhite: 0xfdf9f0,
  uiShadow: 0x2a2f45,

  // --- combat feedback ---
  telegraphWarn: 0xff9a2b,   // wind-up, dodgeable
  telegraphDanger: 0xff3b30, // unblockable, must dodge
  telegraphGuard: 0x4ad6ff,  // blockable / parryable
  hitFlash: 0xffffff,
  critFlash: 0xffe066,
  damageNumber: 0xfff0c0,
  damageNumberCrit: 0xffb020,
  healNumber: 0x7fe89a,
  parrySpark: 0x9fe8ff,
  bloodless: 0xffd9a0,       // impact motes; stylised, not gore
};

/** Three-step tonal ramp for a base colour: [shadow, base, highlight]. */
export function ramp(hex) {
  return [shadeDown(hex, 1), hex, shadeUp(hex, 1)];
}

/** Per-face voxel shading multipliers, per ART_BAR §4. Order: +Y, -Y, +X, -X, +Z, -Z */
export const FACE_SHADE = [1.0, 0.62, 0.86, 0.86, 0.74, 0.74];
