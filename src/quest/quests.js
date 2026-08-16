// The authored content: eight chains, thirty-three quests, one arc.
//
// Design rules this file obeys:
//   * Story happens in the doing. Nothing here is a cutscene; the longest speech is three lines.
//   * Every chain escalates its own verbs — a chain that opens with "fetch four floats" ends
//     with a boss you could not have fought on the first day.
//   * Devil fruits are chain finales, so acquiring power *is* the progression curve.
//   * Bounty rewards are authored, not derived, because the tier a chain leaves you on is a
//     deliberate difficulty and world-reaction choice (see bounty.js).
//
// Ids are save keys. Renaming one breaks saves; adding is free.

import {
  goto, defeat, defeatBoss, talk, collect, deliver, survive, escort,
  useFruit, sailTo, findSecret, openChest, winWithoutDamage, destroy,
} from './objectives.js';

/** The eight landmark islands, in arc order. */
export const ISLANDS = Object.freeze([
  'shellsCove', 'palmReach', 'cogHarbour', 'drumPeaks',
  'emberfall', 'whisperSands', 'blossomTerrace', 'marinefordReach',
]);

/** Display names for the islands, so no other module invents its own. */
export const ISLAND_NAMES = Object.freeze({
  shellsCove: 'Shells Cove',
  palmReach: 'Palm Reach',
  cogHarbour: 'Cog Harbour',
  drumPeaks: 'Drum Peaks',
  emberfall: 'Emberfall',
  whisperSands: 'Whisper Sands',
  blossomTerrace: 'Blossom Terrace',
  marinefordReach: 'Marineford Reach',
});

/** The six devil fruits, and which chain finale hands each one over. */
export const FRUITS = Object.freeze(['gomu', 'mera', 'hie', 'suna', 'gura', 'zushi']);

/** Enemy kind vocabulary quests reference. Combat/world spawn these names. */
export const ENEMY_KINDS = Object.freeze([
  'thug', 'thug_brute', 'jungle_stalker', 'marine_grunt', 'marine_officer', 'marine_elite',
  'frost_wolf', 'ash_hound', 'forge_wraith', 'dune_bandit', 'mirage_shade',
  'terrace_duelist', 'blossom_ronin',
]);

/** Named boss encounters, one per chain finale plus the arc ender. */
export const BOSSES = Object.freeze({
  'shellsCove.gaff': { name: 'Gaff Ironjaw', island: 'shellsCove', arena: 'shellsCove.boss_arena' },
  'palmReach.canopy_king': { name: 'the Canopy King', island: 'palmReach', arena: 'palmReach.boss_arena' },
  'cogHarbour.inspector': { name: 'Inspector Voss Callar', island: 'cogHarbour', arena: 'cogHarbour.boss_arena' },
  'drumPeaks.summit_warden': { name: 'the Summit Warden', island: 'drumPeaks', arena: 'drumPeaks.boss_arena' },
  'emberfall.caldera_heart': { name: 'Slag, the Caldera Heart', island: 'emberfall', arena: 'emberfall.boss_arena' },
  'whisperSands.sand_king': { name: 'Ozem, the Buried King', island: 'whisperSands', arena: 'whisperSands.boss_arena' },
  'blossomTerrace.terrace_master': { name: 'Master Rakuhen', island: 'blossomTerrace', arena: 'blossomTerrace.boss_arena' },
  'marinefordReach.admiral': { name: 'Admiral Halberd Grize', island: 'marinefordReach', arena: 'marinefordReach.boss_arena' },
});

/** Quest items. Display names live here so the HUD never prints a raw id. */
export const ITEMS = Object.freeze({
  'shellsCove.net_float': 'cork net float',
  'shellsCove.stolen_ledger': "the camp's stolen ledger",
  'palmReach.expedition_tag': 'brass expedition tag',
  'palmReach.ember_seed': 'ember seed',
  'cogHarbour.forged_bolt': 'counterfeit keel bolt',
  'cogHarbour.inspection_seal': "inspector's wax seal",
  'drumPeaks.medicine_case': 'sealed medicine case',
  'drumPeaks.frost_lily': 'frost lily',
  'emberfall.tempered_ingot': 'tempered ingot',
  'emberfall.spice_cache': 'ash-cellar spice cache',
  'whisperSands.compass_shard': 'compass shard',
  'whisperSands.water_glyph': 'water glyph',
  'blossomTerrace.duel_token': 'duelling token',
  'marinefordReach.gate_key': 'sea-gate key',
  'marinefordReach.cipher_slate': 'cipher slate',
});

/** Destructible props quests reference. World places these. */
export const PROPS = Object.freeze({
  'shellsCove.thug_banner': 'raider banner',
  'palmReach.spider_nest': 'canopy nest',
  'cogHarbour.marine_crate': 'sealed Navy crate',
  'drumPeaks.ice_choke': 'ice choke',
  'emberfall.slag_valve': 'slag valve',
  'whisperSands.mirage_pillar': 'mirage pillar',
  'blossomTerrace.duel_gong': 'duelling gong',
  'marinefordReach.signal_horn': 'signal horn',
});

/** Ship upgrades handed out by quests. The ship owner reads `effect`. */
export const SHIP_UPGRADES = Object.freeze({
  reinforced_hull: { name: 'Reinforced Hull', effect: { hullMaxAdd: 60, ramDamageMult: 1.3 } },
  storm_sails: { name: 'Storm Sails', effect: { stormSpeedMult: 1.35, stormDriftMult: 0.8 } },
  cannon_battery: { name: 'Cannon Battery', effect: { broadsideCount: 6, cannonDamageMult: 1.25 } },
});

/** Map fragments. Collect all eight and the Grand Line chart is complete. */
export const MAP_FRAGMENTS = Object.freeze({
  'fragment.first_log': 'The First Log',
  'fragment.canopy_road': 'The Canopy Road',
  'fragment.harbour_chart': 'The Harbour Chart',
  'fragment.snow_line': 'The Snow Line',
  'fragment.ember_road': 'The Ember Road',
  'fragment.dune_sea': 'The Dune Sea',
  'fragment.petal_coast': 'The Petal Coast',
  'fragment.grand_line': 'The Grand Line',
});

// ---------------------------------------------------------------------------
// Authoring helpers
// ---------------------------------------------------------------------------

let _order = 0;
const step = (id, text, objectives) => Object.freeze({ id, text, objectives: Object.freeze(objectives) });

/** Freeze a quest record and stamp its authoring order (used for stable log sorting). */
function Q(o) {
  o.order = _order++;
  o.island = o.id.split('.')[0];
  o.rewards = Object.freeze(Object.assign({ berries: 0, xp: 0, bounty: 0 }, o.rewards));
  o.requires = Object.freeze(o.requires || []);
  o.steps = Object.freeze(o.steps);
  o.dialogue = Object.freeze(o.dialogue);
  return Object.freeze(o);
}

// ---------------------------------------------------------------------------
// SHELLS COVE — help the village, break a raider camp, first crew, the gomu fruit
// ---------------------------------------------------------------------------

const SHELLS_COVE = [
  Q({
    id: 'shellsCove.q1',
    title: 'Cut Nets',
    giver: 'shellsCove.mira',
    requires: [],
    summary: 'Shells Cove has stopped fishing. The nets keep coming back opened with a knife.',
    steps: [
      step('s1', 'Walk the tideline', [
        goto('shellsCove.dock', 7, 'Look over the ruined nets at the dock'),
        collect('shellsCove.net_float', 4, 'Recover cork floats from the shallows'),
      ]),
      step('s2', 'Find who is cutting them', [
        defeat('thug', 3, 'Drive off the men working the tideline'),
      ]),
      step('s3', 'Take the floats back', [
        deliver('shellsCove.net_float', 'shellsCove.mira', 'Mira'),
      ]),
    ],
    dialogue: {
      offer: [
        'Nets do not tear in straight lines. Somebody is cutting them.',
        'Four floats are still out on the water. Bring them in and I can mend one net tonight.',
      ],
      accept: ['Watch the tideline. They come at slack water.'],
      active: ['Four floats. And keep your head down out there.'],
      turnIn: ['All four. And you found the men who cut them, by the look of you.'],
      reward: ['Take this. It is not much. It is what a village has.'],
      decline: ['Then the nets stay cut. I will still be here.'],
    },
    // The first chain starts the wanted ladder: driving thugs off the tideline is exactly the
    // kind of small-town heroics a Marine report inflates into a first poster. 500k keeps it
    // below q2's 1.2M so the ladder still rises.
    rewards: { berries: 400, xp: 60, bounty: 500000 },
  }),

  Q({
    id: 'shellsCove.q2',
    title: 'The Camp on the Headland',
    giver: 'shellsCove.mira',
    requires: ['shellsCove.q1'],
    summary: 'They are not drifters. They have a camp, banners, and a schedule.',
    steps: [
      step('s1', 'Scout the headland', [
        goto('shellsCove.vista', 8, 'Get eyes on the camp from the headland'),
      ]),
      step('s2', 'Take their colours down', [
        destroy('shellsCove.thug_banner', 3, 'Tear down the raider banners'),
      ]),
      step('s3', 'Break the muscle', [
        defeat('thug_brute', 2, 'Put down the camp bruisers'),
      ]),
    ],
    dialogue: {
      offer: [
        'They fly a flag now. Over my father\'s headland.',
        'Take it down. All three of them. Let them see it come down.',
      ],
      accept: ['If it goes badly, come back along the beach. Not the road.'],
      active: ['Three banners. And the two big ones will notice.'],
      turnIn: ['The headland is bare again. I had forgotten what it looked like.'],
      reward: ['They left a ledger behind. I cannot read half of it. You take it.'],
    },
    rewards: { berries: 900, xp: 120, bounty: 1200000, item: 'shellsCove.stolen_ledger' },
  }),

  Q({
    id: 'shellsCove.q3',
    title: 'Sixty Paces',
    giver: 'shellsCove.pell',
    requires: ['shellsCove.q2'],
    summary: 'The best shot on the island has never shot anything that shot back.',
    steps: [
      step('s1', 'Hear him out', [
        talk('shellsCove.pell', 'Pell Marren'),
      ]),
      step('s2', 'Find him something to shoot with', [
        openChest('shellsCove.chest_1', 'Open the old signal-shot crate'),
      ]),
      step('s3', 'Get him home in one piece', [
        defeat('thug', 4, 'Clear the road while Pell covers you'),
        escort('shellsCove.pell', 'shellsCove.plaza', 'Pell'),
      ]),
    ],
    dialogue: {
      offer: [
        'I have hit every gull on this island. Twice.',
        'Take me up the road. If I miss once, leave me and I will walk back.',
      ],
      accept: ['Sixty paces is my range. Do not let anything closer than that.'],
      active: ['Signal-shot crate. Behind the boathouse. I have been eyeing it for years.'],
      turnIn: ['Four of them and I did not miss. Not once.'],
      reward: ['So. Do you have a ship, or do I have to build one of those as well?'],
    },
    rewards: { berries: 600, xp: 150, bounty: 800000, crew: 'pell_marren' },
  }),

  Q({
    id: 'shellsCove.q4',
    title: 'Gaff Ironjaw',
    giver: 'shellsCove.mira',
    requires: ['shellsCove.q3'],
    summary: 'The ledger names the man the raiders answer to. He is already on the beach.',
    steps: [
      step('s1', 'Show the ledger to someone who can read it', [
        deliver('shellsCove.stolen_ledger', 'shellsCove.harl', 'Harl Dunnage'),
      ]),
      step('s2', 'Meet him where he lands', [
        goto('shellsCove.boss_arena', 8, 'Go down to the black rocks'),
        defeatBoss('shellsCove.gaff', 'Gaff Ironjaw'),
      ]),
      step('s3', 'See what he was really here for', [
        findSecret('shellsCove.secret', 'Find the cave the raiders were digging out'),
        openChest('shellsCove.chest_2', 'Open the sealed crate inside'),
      ]),
    ],
    dialogue: {
      offer: [
        'Harl read the ledger. They were not here for fish.',
        'They were digging. Under the black rocks. And their captain is landing tonight.',
      ],
      accept: ['Whatever is in that cave, do not let him leave with it.'],
      active: ['Black rocks, at the tide line. He will not hide.'],
      turnIn: ['A fruit. All of this, for a piece of fruit.'],
      reward: ['It tastes appalling, apparently. Eat it anyway. You have earned worse.'],
    },
    rewards: {
      berries: 1500, xp: 400, bounty: 3000000,
      fruit: 'gomu', mapFragment: 'fragment.first_log',
    },
  }),
];

// ---------------------------------------------------------------------------
// PALM REACH — a lost expedition in the canopy, a beast, the mera fruit
// ---------------------------------------------------------------------------

const PALM_REACH = [
  Q({
    id: 'palmReach.q1',
    title: 'Eleven Names',
    giver: 'palmReach.ines',
    requires: ['shellsCove.q4'],
    summary: 'Eleven surveyors went up the canopy road. The chart says none came down.',
    steps: [
      step('s1', 'Start where they started', [
        goto('palmReach.dock', 7, 'Find the expedition landing'),
      ]),
      step('s2', 'Follow the tags up the road', [
        collect('palmReach.expedition_tag', 5, 'Recover brass tags from the canopy road'),
      ]),
      step('s3', 'Report what the tags say', [
        deliver('palmReach.expedition_tag', 'palmReach.ines', 'Ines Quill'),
      ]),
    ],
    dialogue: {
      offer: [
        'Each surveyor carried a brass tag. They drop them when they turn back.',
        'I found none on the road. That means nobody turned back. Go and prove me wrong.',
      ],
      accept: ['Take the rope line. Where the rope ends, so does my map.'],
      active: ['Five tags, if you can. Even three would tell me something.'],
      turnIn: ['Five. All of them past the rope line. All of them dropped, not placed.'],
      reward: ['Take the survey money. I am not going to need a full expedition budget.'],
    },
    rewards: { berries: 800, xp: 140, bounty: 400000 },
  }),

  Q({
    id: 'palmReach.q2',
    title: 'What Walks the Canopy',
    giver: 'palmReach.moss',
    requires: ['palmReach.q1'],
    summary: 'Something up there has been breeding, and it has stopped being shy.',
    steps: [
      step('s1', 'Get above the leaf line', [
        goto('palmReach.vista', 8, 'Climb to the canopy lookout'),
      ]),
      step('s2', 'Burn out the nests', [
        destroy('palmReach.spider_nest', 4, 'Destroy the canopy nests'),
      ]),
      step('s3', 'Deal with what comes for you', [
        defeat('jungle_stalker', 6, 'Kill the stalkers that answer'),
      ]),
    ],
    dialogue: {
      offer: [
        'Drink is free for anyone going up. I have not poured a paid one in months.',
        'Four nests on the high branches. Take them and the road might reopen.',
      ],
      accept: ['They come when the nests go. That is the whole trick, and it is not a good one.'],
      active: ['Four nests. Then run, or stand. Your choice, not mine.'],
      turnIn: ['The high branches are quiet. I have not heard quiet up there since spring.'],
      reward: ['On the house forever. You will regret accepting that.'],
    },
    rewards: { berries: 1100, xp: 220, bounty: 1600000 },
  }),

  Q({
    id: 'palmReach.q3',
    title: 'The Twelfth',
    giver: 'palmReach.ines',
    requires: ['palmReach.q2'],
    summary: 'Eleven went up. Ines never mentioned the helmsman who took them there.',
    steps: [
      step('s1', 'Find the hollow under the strangler figs', [
        findSecret('palmReach.secret', 'Find the sealed hollow beneath the figs'),
      ]),
      step('s2', 'Talk to whatever is living in it', [
        talk('palmReach.ferra', 'Ferra Yune'),
      ]),
      step('s3', 'Walk her down', [
        escort('palmReach.ferra', 'palmReach.dock', 'Ferra'),
      ]),
    ],
    dialogue: {
      offer: [
        'There were twelve. The helmsman is not on my list because she was not my hire.',
        'If anything survived four months up there, it is her. Bring her down.',
      ],
      accept: ['She will not come easily. Nobody sane would.'],
      active: ['Under the strangler figs. There is a hollow the roots made.'],
      turnIn: ['Four months. She walked out under her own power.'],
      reward: ['Pay her, not me. And keep her — she will not stay here.'],
    },
    rewards: { berries: 900, xp: 300, bounty: 1000000, crew: 'ferra_yune' },
  }),

  Q({
    id: 'palmReach.q4',
    title: 'The Canopy King',
    giver: 'palmReach.ferra',
    requires: ['palmReach.q3'],
    summary: 'Ferra knows exactly what took her crew, and exactly where it sleeps.',
    steps: [
      step('s1', 'Kit up for heat', [
        openChest('palmReach.chest_1', "Take Moss's fireproof kit"),
      ]),
      step('s2', 'Wake it up', [
        goto('palmReach.boss_arena', 9, 'Climb to the burnt crown'),
        defeatBoss('palmReach.canopy_king', 'the Canopy King'),
      ]),
      step('s3', 'Take what it was guarding', [
        collect('palmReach.ember_seed', 1, 'Take the ember seed from the burnt crown'),
      ]),
    ],
    dialogue: {
      offer: [
        'The crown of the tallest tree is burnt black and nothing grows there.',
        'It is not lightning. It sits on something that keeps it warm.',
      ],
      accept: ['Take the kit. The heat comes before the beast does.'],
      active: ['Burnt crown. Straight up. You will smell it before you see it.'],
      turnIn: ['Eleven people. And it was sitting on a fruit the whole time.'],
      reward: ['Eat it. Then never let me see you climb a tree slowly again.'],
    },
    rewards: {
      berries: 2200, xp: 600, bounty: 9000000,
      fruit: 'mera', mapFragment: 'fragment.canopy_road',
    },
  }),
];

// ---------------------------------------------------------------------------
// COG HARBOUR — a rigged shipyard, an inspector who is not what he seems
// ---------------------------------------------------------------------------

const COG_HARBOUR = [
  Q({
    id: 'cogHarbour.q1',
    title: 'Two Bolts Short',
    giver: 'cogHarbour.odd',
    requires: ['palmReach.q4'],
    summary: 'Every keel in slip three is built to fail, and the shipwright signed for all of them.',
    steps: [
      step('s1', 'Get under the hulls in slip three', [
        goto('cogHarbour.dock', 7, 'Go down to slip three'),
      ]),
      step('s2', 'Pull the evidence out', [
        collect('cogHarbour.forged_bolt', 6, 'Pull counterfeit bolts from the keels'),
      ]),
      step('s3', 'Put it in his hands', [
        deliver('cogHarbour.forged_bolt', 'cogHarbour.odd', 'Odd Bracken'),
      ]),
    ],
    dialogue: {
      offer: [
        'Six bolts in slip three are cast, not forged. They will shear in the first real sea.',
        'I cannot pull them myself. The yard watches me. Nobody watches you yet.',
      ],
      accept: ['Under the hulls. Bring me six and I will have a case.'],
      active: ['Slip three. Low tide is your friend and mine.'],
      turnIn: ['Cast iron. Painted to look forged. Somebody was paid very well for this.'],
      reward: ['My own money. It is clean. That is more than I can say for the yard.'],
    },
    rewards: { berries: 1000, xp: 180 },
  }),

  Q({
    id: 'cogHarbour.q2',
    title: 'Night Delivery',
    giver: 'cogHarbour.gil',
    requires: ['cogHarbour.q1'],
    summary: 'A boy who counts crates for fun has noticed a pattern nobody wanted noticed.',
    steps: [
      step('s1', 'Take the high ground before the seventh bell', [
        goto('cogHarbour.vista', 8, 'Get above slip three before the bell'),
      ]),
      step('s2', 'Stay put while they unload', [
        survive(45, {}, 'Stay hidden through the unloading'),
      ]),
      step('s3', 'Take the manifest', [
        openChest('cogHarbour.chest_1', 'Open the manifest box on the quay'),
      ]),
    ],
    dialogue: {
      offer: [
        'Every eighth day, seventh bell, slip three gets a delivery nobody writes down.',
        'I count them. Nine crates. Always nine. Nobody believes me because I am nine.',
      ],
      accept: ['Do not move while they are on the quay. They look up. I have seen them look up.'],
      active: ['Seventh bell. From the ramp above slip three you can see everything.'],
      turnIn: ['Nine crates. I told you it was nine.'],
      reward: ['There was a seal in the box. A proper Navy one. Wax and everything.'],
    },
    rewards: { berries: 700, xp: 200, bounty: 900000, item: 'cogHarbour.inspection_seal' },
  }),

  Q({
    id: 'cogHarbour.q3',
    title: 'The Inspector',
    giver: 'cogHarbour.lys',
    requires: ['cogHarbour.q2'],
    summary: 'Inspector Voss Callar signs off every bad keel in the yard, and imports his own crates.',
    steps: [
      step('s1', 'Take his measure', [
        talk('cogHarbour.voss', 'Inspector Voss Callar'),
      ]),
      step('s2', 'Open his private stock', [
        destroy('cogHarbour.marine_crate', 5, 'Break open the sealed Navy crates'),
      ]),
      step('s3', 'Answer the whistle', [
        defeat('marine_grunt', 6, 'Fight off the yard patrol'),
      ]),
    ],
    dialogue: {
      offer: [
        'Voss signs every keel in this yard and buys nothing from my chandlery. Nothing.',
        'A man who inspects ships for a living and needs no rope is not inspecting ships.',
      ],
      accept: ['Break one crate and you will not get to break the second quietly.'],
      active: ['Five crates. And Voss will be very polite about it, right up until he is not.'],
      turnIn: ['Weapons. Under a Navy seal, in a civilian yard.'],
      reward: ['Buy the good rope with this. You are going to need the good rope.'],
    },
    rewards: { berries: 1300, xp: 320, bounty: 6000000 },
  }),

  Q({
    id: 'cogHarbour.q4',
    title: 'Signed in Salt',
    giver: 'cogHarbour.odd',
    requires: ['cogHarbour.q3'],
    summary: 'The inspector was never Navy. He has been selling the yard to whoever pays.',
    steps: [
      step('s1', 'Corner him in the dry dock', [
        goto('cogHarbour.boss_arena', 9, 'Corner Voss in the dry dock'),
        defeatBoss('cogHarbour.inspector', 'Inspector Voss Callar'),
      ]),
      step('s2', 'Put the seal where it belongs', [
        deliver('cogHarbour.inspection_seal', 'cogHarbour.odd', 'Odd Bracken'),
      ]),
      step('s3', 'Collect what the yard owes you', [
        openChest('cogHarbour.chest_2', "Open the yard's bond chest"),
      ]),
    ],
    dialogue: {
      offer: [
        'That seal is six years out of date. The real inspector died six years ago.',
        'He has been selling my signature ever since. I would like it back.',
      ],
      accept: ['Dry dock. He will not run — running would be an admission.'],
      active: ['He is in the dry dock, counting. He is always counting.'],
      turnIn: ['My name. On paper. Mine again.'],
      reward: ['Bring your ship round. I am going to build you a hull that does not lie.'],
    },
    rewards: {
      berries: 2000, xp: 700, bounty: 18000000,
      crew: 'odd_bracken', shipUpgrade: 'reinforced_hull', mapFragment: 'fragment.harbour_chart',
    },
  }),
];

// ---------------------------------------------------------------------------
// DRUM PEAKS — a sick child, a climb, the doctor, the hie fruit
// ---------------------------------------------------------------------------

const DRUM_PEAKS = [
  Q({
    id: 'drumPeaks.q1',
    title: 'Three Remedies',
    giver: 'drumPeaks.sena',
    requires: ['cogHarbour.q4'],
    summary: 'The doctor has three medicines and none of them is the one Ivo Hess needs.',
    steps: [
      step('s1', 'Meet the patient', [
        talk('drumPeaks.ivo', 'Ivo Hess'),
      ]),
      step('s2', 'Fetch the case from the only chandlery that stocks it', [
        sailTo('cogHarbour', 'Cog Harbour'),
        openChest('cogHarbour.chest_3', "Collect the case from Lys Auger's chandlery"),
      ]),
      step('s3', 'Get it back up the mountain', [
        sailTo('drumPeaks', 'Drum Peaks'),
        deliver('drumPeaks.medicine_case', 'drumPeaks.sena', 'Sena Brill'),
      ]),
    ],
    dialogue: {
      offer: [
        'She is running a fever I can name and cannot treat. The case I need is in Cog Harbour.',
        'It is four days by the mail packet. I do not have four days. You have a ship.',
      ],
      accept: ['Lys Auger holds it. Tell her it is for the Hess girl and she will not haggle.'],
      active: ['Cog Harbour. Chandlery at the top of the ramp. Go.'],
      turnIn: ['Two days. You did it in two days.'],
      reward: ['It buys her a week. A week is enough time to find the real cure.'],
    },
    rewards: { berries: 900, xp: 200 },
  }),

  Q({
    id: 'drumPeaks.q2',
    title: 'Above the Treeline',
    giver: 'drumPeaks.kessel',
    requires: ['drumPeaks.q1'],
    summary: 'The frost lily grows above the second ridge. So does everything that eats climbers.',
    steps: [
      step('s1', 'Get past the second ridge', [
        goto('drumPeaks.vista', 8, 'Reach the second ridge'),
        destroy('drumPeaks.ice_choke', 3, 'Break the ice chokes blocking the rope line'),
      ]),
      step('s2', 'Clear the slope', [
        defeat('frost_wolf', 8, 'Drive off the frost wolves'),
      ]),
      step('s3', 'Cut three lilies', [
        collect('drumPeaks.frost_lily', 3, 'Cut frost lilies from the snowfield'),
      ]),
    ],
    dialogue: {
      offer: [
        'Above the second ridge the wind takes your voice. Use the rope line and count your steps.',
        'Three lilies. Two for the doctor, one for whoever needs it next. That is the rule.',
      ],
      accept: ['Chokes first. If the rope line is buried you will not find your way back down.'],
      active: ['Three lilies. And do not fight the wolves on open snow.'],
      turnIn: ['Three. And you came down the same way you went up. Good.'],
      reward: ['Guide fee. I did not guide you. Take it anyway.'],
    },
    rewards: { berries: 1400, xp: 380, bounty: 2200000 },
  }),

  Q({
    id: 'drumPeaks.q3',
    title: 'Carry Her Down',
    giver: 'drumPeaks.nel',
    requires: ['drumPeaks.q2'],
    summary: 'Ivo went up for the lily herself, three hours before you came down with it.',
    steps: [
      step('s1', 'Get the lilies to the doctor', [
        deliver('drumPeaks.frost_lily', 'drumPeaks.sena', 'Sena Brill'),
      ]),
      step('s2', 'Find where a nine-year-old would shelter', [
        findSecret('drumPeaks.secret', 'Find the old ridge shelter'),
      ]),
      step('s3', 'Bring her home', [
        escort('drumPeaks.ivo', 'drumPeaks.plaza', 'Ivo'),
      ]),
    ],
    dialogue: {
      offer: [
        'Her bed is empty and her boots are gone. She heard you talking about the lilies.',
        'I cannot make that climb. I have tried twice. Please. Go now.',
      ],
      accept: ['She knows the shelter under the ridge. She has to. She has to know it.'],
      active: ['The old shelter. Kessel showed her once. She remembers everything.'],
      turnIn: ['She is asleep. She is warm and she is asleep.'],
      reward: ['Sena says she is coming with you. I would argue but she has that face on.'],
    },
    rewards: { berries: 1200, xp: 450, bounty: 1800000, crew: 'sena_brill' },
  }),

  Q({
    id: 'drumPeaks.q4',
    title: 'The Summit Warden',
    giver: 'drumPeaks.kessel',
    requires: ['drumPeaks.q3'],
    summary: 'Something on the summit has been keeping the snowline where it is. On purpose.',
    steps: [
      step('s1', 'Reach the summit shelf', [
        goto('drumPeaks.boss_arena', 9, 'Climb to the summit shelf'),
      ]),
      step('s2', 'Face what lives there', [
        defeatBoss('drumPeaks.summit_warden', 'the Summit Warden'),
      ]),
      step('s3', 'Cut it out of the ice', [
        openChest('drumPeaks.chest_2', 'Break open the ice vault on the shelf'),
      ]),
    ],
    dialogue: {
      offer: [
        'I have seen its tracks twice in thirty years. This month I have seen them nine times.',
        'It is coming down. If it reaches the village the lilies will not matter.',
      ],
      accept: ['Summit shelf. Do not let it get behind the wind.'],
      active: ['Up past the shelf. You will hear it before the wind lets you see it.'],
      turnIn: ['Thirty years I have been afraid of that thing.'],
      reward: ['There was something frozen in the vault behind it. Blue. Cold to look at.'],
    },
    rewards: {
      berries: 2600, xp: 800, bounty: 26000000,
      fruit: 'hie', mapFragment: 'fragment.snow_line',
    },
  }),
];

// ---------------------------------------------------------------------------
// EMBERFALL — a forge master, a caldera descent, the cook, the gura fruit
// ---------------------------------------------------------------------------

const EMBERFALL = [
  Q({
    id: 'emberfall.q1',
    title: 'Steel Does Not Lie',
    giver: 'emberfall.vulca',
    requires: ['drumPeaks.q4'],
    summary: 'Emberfall\'s forge master will not talk to people, but she will talk about steel.',
    steps: [
      step('s1', 'Pull ingots from the cooling floor', [
        collect('emberfall.tempered_ingot', 4, 'Recover tempered ingots from the cooling floor'),
      ]),
      step('s2', 'Clear what came up the vents', [
        defeat('ash_hound', 5, 'Kill the ash hounds in the yard'),
      ]),
      step('s3', 'Deliver the steel', [
        deliver('emberfall.tempered_ingot', 'emberfall.vulca', 'Vulca Ord'),
      ]),
    ],
    dialogue: {
      offer: [
        'Four ingots on the cooling floor and something with claws between me and them.',
        'You want a weapon from me. Bring me the steel and I will consider it.',
      ],
      accept: ['They come up the vents when the ground hums. Listen for the hum.'],
      active: ['Four ingots. Ash hounds will be on the floor by now.'],
      turnIn: ['Good steel. Better than the men who dropped it.'],
      reward: ['A blade. It will not break. That is the only promise steel makes.'],
    },
    rewards: { berries: 1200, xp: 260, bounty: 600000 },
  }),

  Q({
    id: 'emberfall.q2',
    title: 'Three Stuck Valves',
    giver: 'emberfall.tamm',
    requires: ['emberfall.q1'],
    summary: 'The valves keep the caldera breathing. Three are stuck and the ground has started humming.',
    steps: [
      step('s1', 'Get above the vent field', [
        goto('emberfall.vista', 8, 'Climb to the vent field overlook'),
      ]),
      step('s2', 'Free the valves', [
        useFruit('hie', 3, {}, 'Freeze the slag with the hie power so it can be struck'),
        destroy('emberfall.slag_valve', 3, 'Break the slag off three stuck valves'),
      ]),
      step('s3', 'Hold on while it clears its throat', [
        survive(60, {}, 'Ride out the pressure release'),
      ]),
    ],
    dialogue: {
      offer: [
        'Three valves are slagged shut and glowing. Touch one and you lose the hand.',
        'Chill the slag first, break it second, then find something to hold on to for a minute.',
      ],
      accept: ['Cold first. Everyone who skipped that step is a story we tell now.'],
      active: ['Three valves in the vent field. Freeze, break, hold on.'],
      turnIn: ['It is breathing again. Listen to it. That is the sound of not dying.'],
      reward: ['Village fund. Nobody will miss it and everybody will be glad.'],
    },
    rewards: { berries: 1500, xp: 420, bounty: 3400000 },
  }),

  Q({
    id: 'emberfall.q3',
    title: 'Descent',
    giver: 'emberfall.vulca',
    requires: ['emberfall.q2'],
    summary: 'There is an older forge under the caldera floor, and Vulca has never dared go down.',
    steps: [
      step('s1', 'Get down to the caldera floor', [
        goto('emberfall.boss_arena', 9, 'Descend to the caldera floor'),
      ]),
      step('s2', 'Clear the old floor', [
        defeat('forge_wraith', 7, 'Break the forge wraiths on the old floor'),
      ]),
      step('s3', 'Find what she was too sensible to look for', [
        findSecret('emberfall.secret', 'Find the first forge beneath the floor'),
      ]),
    ],
    dialogue: {
      offer: [
        'My grandmother worked a forge below this one. Then the floor closed and we stopped asking.',
        'I have wanted to go down for forty years. I am not going to. You are.',
      ],
      accept: ['If the heat starts to feel comfortable, come back up. That is the sign.'],
      active: ['Caldera floor. Then look for a floor under the floor.'],
      turnIn: ['A whole forge. Cold for two hundred years and still square.'],
      reward: ['There is a cellar behind it. Full of spice, of all the stupid things. My brother will weep.'],
    },
    rewards: { berries: 1800, xp: 560, bounty: 12000000, item: 'emberfall.spice_cache' },
  }),

  Q({
    id: 'emberfall.q4',
    title: 'Ash in the Bread',
    giver: 'emberfall.basil',
    requires: ['emberfall.q3'],
    summary: 'The cook wants the cellar. The mountain wants the cellar back. Only one of them is negotiable.',
    steps: [
      step('s1', 'Hand over the cellar', [
        deliver('emberfall.spice_cache', 'emberfall.basil', 'Basil Ord'),
      ]),
      step('s2', 'Deal with what woke up under it', [
        defeatBoss('emberfall.caldera_heart', 'Slag, the Caldera Heart'),
      ]),
      step('s3', 'Take the prize out of the heart', [
        openChest('emberfall.chest_1', 'Open the heart chamber vault'),
      ]),
    ],
    dialogue: {
      offer: [
        'Two hundred years of spice and it is still good. Do you understand what that means?',
        'It means something down there has been keeping it warm. Politely. Until now.',
      ],
      accept: ['Bring me the cellar. Then go and apologise to whatever owns it.'],
      active: ['The heart chamber. Below the first forge. It is not subtle.'],
      turnIn: ['You killed a mountain\'s heart and carried my paprika out under one arm.'],
      reward: ['I am coming with you. Somebody has to feed a person who does that.'],
    },
    rewards: {
      berries: 3000, xp: 1000, bounty: 74000000,
      crew: 'basil_ord', fruit: 'gura', mapFragment: 'fragment.ember_road',
    },
  }),
];

// ---------------------------------------------------------------------------
// WHISPER SANDS — a buried city, a mirage puzzle, the navigator, the suna fruit
// ---------------------------------------------------------------------------

const WHISPER_SANDS = [
  Q({
    id: 'whisperSands.q1',
    title: 'Every Chart Is Wrong',
    giver: 'whisperSands.nia',
    requires: ['emberfall.q4'],
    summary: 'Nia Sarrow drew four charts of this coast and believes all four of them are lies.',
    steps: [
      step('s1', 'Check her working against a coast that holds still', [
        sailTo('palmReach', 'Palm Reach'),
        goto('palmReach.vista', 8, 'Sight the Palm Reach headland from the lookout'),
      ]),
      step('s2', 'Come back and sight the dune sea', [
        sailTo('whisperSands', 'Whisper Sands'),
        goto('whisperSands.vista', 8, 'Sight the dune sea from the high ridge'),
      ]),
      step('s3', 'Recover what the last surveyor dropped', [
        collect('whisperSands.compass_shard', 3, 'Recover compass shards from the dunes'),
      ]),
    ],
    dialogue: {
      offer: [
        'A coast cannot move. This one moves. So either I am wrong four times, or it moves.',
        'Sight a coast that behaves, then sight this one. Then tell me I am mad.',
      ],
      accept: ['Palm Reach first. It has the decency to stay where I left it.'],
      active: ['Two sightings, then find the shards. The last surveyor smashed his compass here.'],
      turnIn: ['Eleven degrees of error. Consistent. That is not error, that is a signal.'],
      reward: ['Take the surveying purse. I am about to stop being paid for this.'],
    },
    rewards: { berries: 1400, xp: 300, bounty: 1000000 },
  }),

  Q({
    id: 'whisperSands.q2',
    title: 'Instructions, Not Tricks',
    giver: 'whisperSands.sabek',
    requires: ['whisperSands.q1'],
    summary: 'The mirages repeat. Sabek Turr thinks they are not heat. He thinks they are directions.',
    steps: [
      step('s1', 'Break the false road', [
        destroy('whisperSands.mirage_pillar', 4, 'Shatter the four mirage pillars'),
      ]),
      step('s2', 'Read what is left standing', [
        collect('whisperSands.water_glyph', 3, 'Copy the three water glyphs'),
      ]),
      step('s3', 'Open the door they point at', [
        findSecret('whisperSands.secret', 'Find the door the glyphs describe'),
      ]),
    ],
    dialogue: {
      offer: [
        'Nine generations of my family guarded a door nobody could find.',
        'The mirage shows four pillars. There are only three. Break the fourth and see what stays.',
      ],
      accept: ['Break them in the order the shadows fall. Morning shadows. Not evening.'],
      active: ['Four pillars, three glyphs, one door. In that order.'],
      turnIn: ['It was under the false pillar the entire time. Nine generations.'],
      reward: ['Family money. It has been waiting for a door to open. Consider it opened.'],
    },
    rewards: { berries: 1700, xp: 480, bounty: 4000000 },
  }),

  Q({
    id: 'whisperSands.q3',
    title: 'Short Memory',
    giver: 'whisperSands.hara',
    requires: ['whisperSands.q2'],
    summary: 'Hara Dune robbed six caravans and never found the road they came from. The road is under the sand.',
    steps: [
      step('s1', 'Clear her old crew off the buried road', [
        defeat('dune_bandit', 8, 'Break the bandits camped on the road'),
      ]),
      step('s2', 'Deal with what the city sends up', [
        defeat('mirage_shade', 6, 'Destroy the mirage shades'),
      ]),
      step('s3', 'Take the caravan money nobody came back for', [
        openChest('whisperSands.chest_1', 'Open the last caravan strongbox'),
      ]),
    ],
    dialogue: {
      offer: [
        'Six caravans. Full of water and glass and city coin. Coming from nowhere.',
        'My old crew still camps on that nowhere. Move them and I will show you the way down.',
      ],
      accept: ['They were mine. Do not expect me to be sentimental about it.'],
      active: ['The buried road. My crew first, then the things that are not people.'],
      turnIn: ['That is the strongbox from the sixth caravan. I have wanted it for four years.'],
      reward: ['Half. That was always the deal, even when nobody was offering it.'],
    },
    rewards: { berries: 2000, xp: 620, bounty: 22000000 },
  }),

  Q({
    id: 'whisperSands.q4',
    title: 'The Buried King',
    giver: 'whisperSands.nia',
    requires: ['whisperSands.q3'],
    summary: 'The city did not sink. Something pulled it down, and it is still holding on.',
    steps: [
      step('s1', 'Get the well out of a nine-year-old', [
        talk('whisperSands.pip', 'Pip Sarrow'),
      ]),
      step('s2', 'Go down to the throne floor', [
        goto('whisperSands.boss_arena', 9, 'Descend to the throne floor'),
        defeatBoss('whisperSands.sand_king', 'Ozem, the Buried King'),
      ]),
      step('s3', 'Take what he was sitting on', [
        openChest('whisperSands.chest_2', 'Open the throne reliquary'),
      ]),
    ],
    dialogue: {
      offer: [
        'The city is intact. Streets, doors, cups on tables. It did not sink, it was pulled.',
        'My brother has been drawing the same well for a month. He has never been down there.',
      ],
      accept: ['Ask Pip. He will tell you exactly where, and he will be exactly right.'],
      active: ['Throne floor, below the well. Bring water you do not intend to drink.'],
      turnIn: ['The dunes stopped moving. All of them. At once.'],
      reward: ['Eleven degrees of error, solved. I am not staying here to draw a fifth chart.'],
    },
    rewards: {
      berries: 3400, xp: 1200, bounty: 153000000,
      crew: 'nia_sarrow', fruit: 'suna', mapFragment: 'fragment.dune_sea',
    },
  }),
];

// ---------------------------------------------------------------------------
// BLOSSOM TERRACE — nine rungs of a duelling ladder, the swordsman, the zushi fruit
// ---------------------------------------------------------------------------

const BLOSSOM_TERRACE = [
  Q({
    id: 'blossomTerrace.q1',
    title: 'Nine Rungs',
    giver: 'blossomTerrace.ohana',
    requires: ['whisperSands.q4'],
    summary: 'Nine terraces, nine names. You start at the bottom or you do not start.',
    steps: [
      step('s1', 'Put your name in the ledger', [
        goto('blossomTerrace.plaza', 7, 'Sign the ledger in the lower plaza'),
      ]),
      step('s2', 'Take the first two rungs', [
        defeat('terrace_duelist', 2, 'Beat the first and second rungs'),
      ]),
      step('s3', 'Claim the ladder blade', [
        openChest('blossomTerrace.chest_1', 'Take the practice blade from the rung chest'),
      ]),
    ],
    dialogue: {
      offer: [
        'Nine rungs, nine names, and one that has not moved in eleven years.',
        'Challenge in order. Skip a rung and the terrace closes to you permanently.',
      ],
      accept: ['First rung is at the bottom of the steps. Everyone finds that funny once.'],
      active: ['Rungs one and two. In that order. The ledger is watching.'],
      turnIn: ['Two rungs on your first afternoon. The ledger has noted the time.'],
      reward: ['The ladder blade. Blunt, honest, and it has beaten better people than you.'],
    },
    rewards: { berries: 1500, xp: 350, bounty: 2000000, item: 'blossomTerrace.duel_token' },
  }),

  Q({
    id: 'blossomTerrace.q2',
    title: 'Third Rung',
    giver: 'blossomTerrace.goro',
    requires: ['blossomTerrace.q1'],
    summary: 'Goro Tsai has held the third rung for two years by making people bleed for it.',
    steps: [
      step('s1', 'Present the token', [
        deliver('blossomTerrace.duel_token', 'blossomTerrace.goro', 'Goro Tsai'),
      ]),
      step('s2', 'Beat him the way the ladder respects', [
        winWithoutDamage('blossomTerrace.rung3', 'Beat Goro Tsai'),
      ]),
      step('s3', 'Ring out, then break the gong', [
        destroy('blossomTerrace.duel_gong', 1, 'Break the third-rung gong, as tradition demands'),
      ]),
    ],
    dialogue: {
      offer: [
        'Third rung. Held it two years. Nobody takes it clean.',
        'Touch me once and I will let you climb. Take it without a scratch and I will mean it.',
      ],
      accept: ['Untouched or not at all. Those are my terms and the ladder likes them.'],
      active: ['Present the token first. I am not a thug, whatever they say downstairs.'],
      turnIn: ['Not one hit. Two years and not one hit.'],
      reward: ['Break the gong. It is mine to give and I am tired of hearing it.'],
    },
    rewards: { berries: 1900, xp: 500, bounty: 18000000 },
  }),

  Q({
    id: 'blossomTerrace.q3',
    title: 'Rungs Four Through Eight',
    giver: 'blossomTerrace.ohana',
    requires: ['blossomTerrace.q2'],
    summary: 'Five rungs in one climb. Nobody has done it in the ledger\'s memory.',
    steps: [
      step('s1', 'Get a proper edge from a proper forge', [
        sailTo('emberfall', 'Emberfall'),
        openChest('emberfall.chest_2', "Take the whetstone from Vulca Ord's bench"),
      ]),
      step('s2', 'Climb', [
        sailTo('blossomTerrace', 'Blossom Terrace'),
        defeat('blossom_ronin', 5, 'Beat the five ronin rungs'),
        defeat('terrace_duelist', 6, 'Beat their seconds'),
      ]),
      step('s3', 'Find the garden behind the eighth terrace', [
        findSecret('blossomTerrace.secret', 'Find the garden behind the eighth terrace'),
      ]),
    ],
    dialogue: {
      offer: [
        'Rungs four through eight are ronin. They do not fight for the ladder, they fight for the day.',
        'And your blade is blunt. Vulca Ord in Emberfall keeps the only stone worth the trip.',
      ],
      accept: ['Sharpen first. The ledger has watched a great many blunt people fail politely.'],
      active: ['Emberfall for the stone. Then five ronin, and their seconds will not wait their turn.'],
      turnIn: ['Five rungs. One climb. I am rewriting the front page of the ledger.'],
      reward: ['Nobody has seen that garden in eleven years except the ninth rung.'],
    },
    rewards: { berries: 2400, xp: 780, bounty: 60000000 },
  }),

  Q({
    id: 'blossomTerrace.q4',
    title: 'Petals Fall, Nobody Claps',
    giver: 'blossomTerrace.sen',
    requires: ['blossomTerrace.q3'],
    summary: 'The ninth rung has been waiting eleven years for someone worth coming down for.',
    steps: [
      step('s1', 'Meet him in the garden', [
        talk('blossomTerrace.sen', 'Sen Ishiba'),
      ]),
      step('s2', 'Take the ninth rung', [
        goto('blossomTerrace.boss_arena', 9, 'Climb to the ninth terrace'),
        defeatBoss('blossomTerrace.terrace_master', 'Master Rakuhen'),
      ]),
      step('s3', 'Take what the ladder was actually guarding', [
        openChest('blossomTerrace.chest_2', 'Open the ninth-rung reliquary'),
      ]),
    ],
    dialogue: {
      offer: [
        'I am the ninth rung. Rakuhen is the reason there is a ninth rung.',
        'He built the ladder to keep something at the top. Climb it and I will show you what.',
      ],
      accept: ['I will not fight you. I stopped being the point of this place years ago.'],
      active: ['Ninth terrace. He will be under the oldest tree, and he will not stand up first.'],
      turnIn: ['Eleven years I guarded a locked box for a man who lied about what was in it.'],
      reward: ['Take it. And take me. I would like to be somewhere without a ledger.'],
    },
    rewards: {
      berries: 4000, xp: 1500, bounty: 270000000,
      crew: 'sen_ishiba', fruit: 'zushi', mapFragment: 'fragment.petal_coast',
    },
  }),
];

// ---------------------------------------------------------------------------
// MARINEFORD REACH — infiltrate, survive, end the arc
// ---------------------------------------------------------------------------

const MARINEFORD_REACH = [
  Q({
    id: 'marinefordReach.q1',
    title: 'The Reach',
    giver: 'marinefordReach.ansel',
    requires: ['blossomTerrace.q4'],
    summary: 'A cadet who signed up to stop pirates would like a pirate to stop something else.',
    steps: [
      step('s1', 'Come in under the guns', [
        sailTo('marinefordReach', 'Marineford Reach'),
        goto('marinefordReach.dock', 7, 'Tie up under the sea gate'),
      ]),
      step('s2', 'Get past the sea gate', [
        collect('marinefordReach.gate_key', 1, "Take the sea-gate key from the gate house"),
      ]),
      step('s3', 'Meet the cadet where nobody looks', [
        talk('marinefordReach.ansel', 'Cadet Ansel Rook'),
      ]),
    ],
    dialogue: {
      offer: [
        'There are cells under the parade ground that are not on any roll.',
        'I cannot open them. I can tell you when the shift changes. Seventh bell. That is all I have.',
      ],
      accept: ['Gate house, left of the arch. The key is on the hook, because nobody would dare.'],
      active: ['Under the sea gate. Tie up short and come in on foot.'],
      turnIn: ['You are inside. Nobody is inside. That is the whole point of this place.'],
      reward: ['Take my pay. I am not going to be collecting it much longer.'],
    },
    rewards: { berries: 2000, xp: 500, bounty: 8000000 },
  }),

  Q({
    id: 'marinefordReach.q2',
    title: 'Off the Manifest',
    giver: 'marinefordReach.ansel',
    requires: ['marinefordReach.q1'],
    summary: 'Three signal horns stand between quiet work and the whole Reach waking up.',
    steps: [
      step('s1', 'Silence the alarm posts', [
        useFruit('gomu', 2, {}, 'Vault the north wall twice with the gomu power'),
        destroy('marinefordReach.signal_horn', 3, 'Wreck the three signal horns'),
      ]),
      step('s2', 'Handle the patrols that notice anyway', [
        defeat('marine_grunt', 10, 'Put down the responding patrols'),
      ]),
      step('s3', 'Take the quartermaster\'s ledger', [
        openChest('marinefordReach.chest_1', "Open Dane Hobb's manifest chest"),
      ]),
    ],
    dialogue: {
      offer: [
        'Three horns. North wall, gate house, parade ground. One blows and the whole Reach stands to.',
        'The north wall has no stair. Whatever you did to that mountain, do it to the wall.',
        'Hobb keeps the real manifest in a chest under his desk. Everything on this rock is in it.',
      ],
      accept: ['North wall first. Over the top, not through the gate.'],
      active: ['Three horns. Then the chest. In that order or not at all.'],
      turnIn: ['A cipher slate. Names, cells, dates. Eight years of them.'],
      reward: ['I do not want it. I want somebody who is not Navy to be holding it.'],
    },
    rewards: { berries: 2400, xp: 700, bounty: 40000000, item: 'marinefordReach.cipher_slate' },
  }),

  Q({
    id: 'marinefordReach.q3',
    title: 'Eight Years of Rivets',
    giver: 'marinefordReach.yoro',
    requires: ['marinefordReach.q2'],
    summary: 'Captain Yoro Bell has been in a box for eight years and has counted every rivet twice.',
    steps: [
      step('s1', 'Get the slate to the man it names', [
        deliver('marinefordReach.cipher_slate', 'marinefordReach.yoro', 'Captain Yoro Bell'),
      ]),
      step('s2', 'Walk him out through the officers', [
        defeat('marine_officer', 4, 'Cut through the officer corps'),
        escort('marinefordReach.yoro', 'marinefordReach.dock', 'Yoro Bell'),
      ]),
      step('s3', 'Take the rigging he promised you', [
        openChest('marinefordReach.chest_2', 'Open the confiscated-rig locker'),
      ]),
    ],
    dialogue: {
      offer: [
        'Eight years. I have counted every rivet in this cell twice and I got a different number.',
        'That slate has my crew on it. Read me the third column and I will get you out of here alive.',
      ],
      accept: ['Walk in front. If they shoot, they will shoot the one they recognise.'],
      active: ['Officers first. Grunts run. Officers write reports.'],
      turnIn: ['Salt air. Eight years, and it is exactly as I remembered it.'],
      reward: ['The rig locker. Everything they took off everyone. Take the storm sails, they are mine.'],
    },
    rewards: { berries: 2800, xp: 900, bounty: 90000000, shipUpgrade: 'storm_sails' },
  }),

  Q({
    id: 'marinefordReach.q4',
    title: 'The Parade Ground',
    giver: 'marinefordReach.vale',
    requires: ['marinefordReach.q3'],
    summary: 'The Vice Admiral will not stop you leaving. He will simply make it take all day.',
    steps: [
      step('s1', 'Walk out onto the parade ground', [
        goto('marinefordReach.boss_arena', 10, 'Step onto the parade ground'),
      ]),
      step('s2', 'Outlast the muster', [
        survive(120, {}, 'Survive the full muster'),
      ]),
      step('s3', 'Break the line they are so proud of', [
        defeat('marine_elite', 12, 'Break the elite line'),
      ]),
    ],
    dialogue: {
      offer: [
        'You are welcome to leave. You will simply have to cross the parade ground to do it.',
        'Every pirate arrives certain. I have watched a great many of them stop being certain here.',
      ],
      accept: ['Two minutes. That is the muster. After that it is only twelve of my best.'],
      active: ['The parade ground. There is no clever way across. That is the design.'],
      turnIn: ['Two minutes and twelve of my best. I am revising my estimate of you.'],
      reward: ['The Admiral has asked for you by name. That has happened four times in my career.'],
    },
    rewards: { berries: 3200, xp: 1300, bounty: 260000000 },
  }),

  Q({
    id: 'marinefordReach.q5',
    title: 'Admiral Halberd Grize',
    giver: 'marinefordReach.vale',
    requires: ['marinefordReach.q4'],
    summary: 'The last man on the Reach. After this the sea in front of you is the open one.',
    steps: [
      step('s1', 'Accept the summons', [
        talk('marinefordReach.vale', 'Vice Admiral Corrin Vale'),
      ]),
      step('s2', 'End it', [
        defeatBoss('marinefordReach.admiral', 'Admiral Halberd Grize'),
      ]),
      step('s3', 'Take the flag out of the locker on the way past', [
        findSecret('marinefordReach.secret', 'Find the flag locker beneath the muster hall'),
      ]),
    ],
    dialogue: {
      offer: [
        'He is on the upper wall. He has been standing there since the seventh bell.',
        'He will not speak first. He never does. It is not arrogance, it is procedure.',
      ],
      accept: ['I will not stop you. I would like the record to show I was asked to.'],
      active: ['Upper wall. He is waiting, and he has all day.'],
      turnIn: ['The Reach has never lost. It says so on the gate. Somebody will have to sand that off.'],
      reward: ['Take the flag from the locker. Fly it upside down. They hate that.'],
    },
    rewards: {
      berries: 12000, xp: 5000, bounty: 620000000,
      shipUpgrade: 'cannon_battery', mapFragment: 'fragment.grand_line',
    },
  }),
];

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Every quest in the game, in authoring order. */
export const QUESTS = Object.freeze([].concat(
  SHELLS_COVE, PALM_REACH, COG_HARBOUR, DRUM_PEAKS,
  EMBERFALL, WHISPER_SANDS, BLOSSOM_TERRACE, MARINEFORD_REACH,
));

export const QUEST_BY_ID = Object.freeze(new Map(QUESTS.map((q) => [q.id, q])));

/** questId list per island, in chain order. */
export const CHAINS = Object.freeze(ISLANDS.reduce((acc, island) => {
  acc[island] = Object.freeze(QUESTS.filter((q) => q.island === island).map((q) => q.id));
  return acc;
}, {}));

/** Which quest hands over each devil fruit. @type {Object<string,string>} */
export const FRUIT_SOURCE = Object.freeze(QUESTS.reduce((acc, q) => {
  if (q.rewards.fruit) acc[q.rewards.fruit] = q.id;
  return acc;
}, {}));

/** Which quest recruits each crew member. @type {Object<string,string>} */
export const CREW_SOURCE = Object.freeze(QUESTS.reduce((acc, q) => {
  if (q.rewards.crew) acc[q.rewards.crew] = q.id;
  return acc;
}, {}));

/** Sum of all authored bounty rewards — the arc's guaranteed floor. */
export const TOTAL_QUEST_BOUNTY = QUESTS.reduce((n, q) => n + (q.rewards.bounty || 0), 0);

// --- progression ------------------------------------------------------------

/** XP needed to *reach* `level` (level 1 is 0). Quadratic: fast early, deliberate later. */
export function xpForLevel(level) {
  const n = Math.max(1, level | 0) - 1;
  return Math.round(120 * n + 45 * n * n);
}

/** Level implied by a total xp value. @returns {number} */
export function levelForXp(xp) {
  let lv = 1;
  while (lv < 60 && xp >= xpForLevel(lv + 1)) lv++;
  return lv;
}

/** Level progress readout for the HUD. @returns {{level:number,into:number,need:number,ratio:number}} */
export function levelProgress(xp) {
  const level = levelForXp(xp);
  const base = xpForLevel(level);
  const next = xpForLevel(level + 1);
  const need = Math.max(1, next - base);
  return { level, into: xp - base, need, ratio: Math.min(1, (xp - base) / need) };
}

/** Human label for a reward key/value pair, used by the log and the toast. @returns {string} */
export function rewardLabel(key, value) {
  switch (key) {
    case 'berries': return value + ' berries';
    case 'xp': return value + ' xp';
    case 'bounty': return 'bounty +' + value;
    case 'crew': return 'a new crew member';
    case 'fruit': return 'the ' + value + ' fruit';
    case 'shipUpgrade': return SHIP_UPGRADES[value] ? SHIP_UPGRADES[value].name : value;
    case 'mapFragment': return MAP_FRAGMENTS[value] || value;
    case 'item': return ITEMS[value] || value;
    default: return key;
  }
}
