// The block vocabulary. Shared by WORLD, islands, props, ship and FX.
// Adding a block here is cheap; renaming one breaks saves, so treat names as public API.

import { BlockRegistry } from './voxel.js';

/**
 * @param {import('./texture.js').TextureLibrary} tex
 * @returns {{reg: BlockRegistry, B: Record<string, number>}}
 */
export function buildBlocks(tex) {
  const reg = new BlockRegistry();
  const L = (n) => tex.layerOf(n);
  const B = {};
  const d = (name, tiles, opts) => { B[name] = reg.define(name, tiles, opts); };

  // --- ground ---
  d('sand', { top: L('sand_top'), side: L('sand_side'), bottom: L('sand_side') });
  d('sandWet', { top: L('sand_wet'), side: L('sand_side'), bottom: L('sand_side') });
  d('grass', { top: L('grass_top'), side: L('grass_side'), bottom: L('dirt') });
  d('grassDry', { top: L('grass_dry_top'), side: L('grass_side'), bottom: L('dirt') });
  d('grassCold', { top: L('grass_cold_top'), side: L('grass_side'), bottom: L('dirt') });
  d('jungle', { top: L('jungle_top'), side: L('grass_side'), bottom: L('dirt') });
  d('dirt', L('dirt'));
  d('rock', L('rock'));
  d('rockCold', L('rock_cold'));
  d('stone', L('stone'));
  d('volcanic', L('volcanic'));
  d('ash', L('ash'));
  d('snow', { top: L('snow'), side: L('snow'), bottom: L('rock_cold') });
  d('ice', L('ice'), { });
  d('lava', L('lava'), { hazard: 22 });
  d('clay', L('clay'));
  d('coral', L('coral'));
  d('cactus', L('cactus'), { hazard: 4 });

  // --- vegetation ---
  d('wood', { top: L('wood_dark'), side: L('wood'), bottom: L('wood_dark') });
  d('leaves', L('leaves'), { cutout: true, opaque: false });
  d('leavesPalm', L('leaves_palm'), { cutout: true, opaque: false });
  d('leavesCherry', L('leaves_cherry'), { cutout: true, opaque: false });
  d('leavesAutumn', L('leaves_autumn'), { cutout: true, opaque: false });
  d('leavesPine', L('leaves_pine'), { cutout: true, opaque: false });
  d('mushroomCap', L('mushroom_cap'));
  d('mushroomStem', L('mushroom_stem'));

  // --- built ---
  d('plank', L('plank'));
  d('plankV', L('plank_v'));
  d('woodDark', L('wood_dark'));
  d('thatch', L('thatch'));
  d('brick', L('brick'));
  d('roof', L('roof'));
  d('stoneBrick', L('stone'));
  d('metal', L('metal'));
  d('metalDark', L('metal_dark'));
  d('gold', L('gold'));
  d('glass', L('glass'), { opaque: false, cutout: false });
  d('rope', L('rope'), { climbable: true });
  d('sail', L('sail'));
  d('sailShade', L('sail_shade'));
  d('barrel', L('barrel'));
  d('paper', L('paper'));
  d('flagRed', L('flag_red'));
  d('rogerStraw', L('roger_straw'));
  d('rogerSkull', L('roger_skull'));
  d('rogerMarine', L('roger_marine'));

  return { reg, B };
}
