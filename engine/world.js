import { addMemory } from './memory.js';
import { uid, valuesConflict, claimKey } from './util.js';

export const ACTIONS_PER_DAY = 8;
export const MAX_DAYS = 3;

export const PREMISE =
  "Moonlight's Midnight Café is a late-night café on a rainy street. Two nights ago the Midnight Ledger vanished from " +
  "the locked office drawer: Mara's grandmother's recipe book, with the café's original handwritten 1962 lease pinned " +
  'inside. Property developer Silas Crane owns the building now and wants the café gone. Without the lease, Mara loses ' +
  'the café at the eviction hearing at midnight on Day 3. The player is a newcomer who has started spending evenings here.';

export const ENTITY_NAMES = {
  player: 'You',
  mara: 'Mara',
  theo: 'Theo',
  ines: 'Ines',
  silas: 'Silas',
  ledger: 'the ledger',
  cafe: 'the café',
};

/**
 * Ground truth, used for the Director View (who lied) and for endings.
 * NPCs never see this directly. Values may be a list of acceptable phrasings.
 */
export const TRUTH = {
  'theo|took_ledger': 'yes',
  'theo|has_ledger': 'no',
  'silas|has_ledger': 'yes',
  'silas|took_ledger': 'yes',
  'mara|took_ledger': 'no',
  'ines|took_ledger': 'no',
  'mara|has_ledger': 'no',
  'ines|has_ledger': 'no',
  'theo|left_cafe_at': ['midnight', 'after 11:45pm', 'after midnight', '12am', 'late'],
  'silas|at_cafe_after_close': 'yes',
  'cafe|behind_on_rent': 'yes',
  'theo|job_offer_from_silas': 'yes',
  'silas|evicts_cafes': 'yes',
};

export function isLie(claim) {
  const key = claimKey(claim);
  if (key in TRUTH) {
    const accepted = [].concat(TRUTH[key]);
    return accepted.every((v) => valuesConflict(v, claim.value));
  }
  // Nobody in this story stole anything else — theft accusations outside the truth table are false.
  if (/^(took|stole)_/.test(claim.topic) && claim.subject in ENTITY_NAMES && claim.subject !== 'player') {
    return claim.value === 'yes';
  }
  return false;
}

export const NPCS = [
  {
    id: 'mara',
    name: 'Mara Vell',
    short: 'Mara',
    role: 'Owner & night barista',
    avatar: '☕',
    color: '#e0a458',
    personality:
      "Warm, proud, stubborn, 38. Runs the café her grandmother founded. Protective of Theo like a little brother. Hates pity and hates being lied to even more. Frightened right now, and hiding it behind hospitality.",
    voice: 'Dry wit and barista warmth. Short sentences. Calls people "love" once she likes them.',
    goals: ['Find the Midnight Ledger before the eviction hearing', "Keep the café's money troubles private", 'Protect Theo'],
    privateTruth: 'You did not take the ledger. You genuinely do not know who did. You half-suspect Ines.',
    gossip: 0.4,
    credulity: 0.6,
    startMood: 'strained',
    rel: {
      player: { trust: 50, affinity: 50 },
      theo: { trust: 80, affinity: 85 },
      ines: { trust: 45, affinity: 60 },
      silas: { trust: 15, affinity: 10 },
    },
    seedMemories: [
      { text: "The Midnight Ledger went missing two nights ago. Grandmother's recipes and the café's lease are inside it.", importance: 9 },
      { text: 'Theo has worked here three years. He is family, whatever happens.', importance: 8 },
    ],
    knowledge: [
      {
        id: 'mara_drawer',
        gate: 0,
        keywords: ['ledger', 'drawer', 'office', 'key', 'keys', 'missing', 'lost', 'stolen', 'happened', 'where', 'kept'],
        text: 'The ledger was locked in the office desk drawer. Only you and Theo have keys. The lock was not forced.',
        say: "\"It was locked in my office drawer. Two keys — mine and Theo's. And the lock wasn't forced.\" *She polishes the same cup twice.*",
        clue: { id: 'clue_keys', title: 'Only Mara and Theo have keys', text: "The ledger was in a locked drawer and the lock wasn't forced. Only Mara and Theo hold keys." },
        claim: { subject: 'ledger', topic: 'lock_forced', value: 'no', text: 'The ledger drawer was not forced open — only Mara and Theo have keys', said: 'Nobody forced that drawer. Only Theo and I have keys.', sentiment: 0, importance: 7 },
      },
      {
        id: 'mara_lease',
        gate: 20,
        keywords: ['why', 'matter', 'important', 'lease', 'hearing', 'evict', 'eviction', 'building', 'landlord', 'special', 'inside'],
        text: "The ledger holds the café's original handwritten lease from 1962 — 'for as long as the lantern burns'. Silas Crane's company bought the building and wants the café out; without the lease you lose.",
        say: "\"It's not just recipes. Grandmother's lease is pinned inside — handwritten, 1962, 'for as long as the lantern burns.' Without it, Silas Crane gets the building.\"",
        deflect: "\"It's… sentimental. Leave it at that.\"",
        clue: { id: 'clue_lease', title: 'The lease is inside the ledger', text: "The café's 1962 handwritten lease is pinned inside the ledger. Without it, Silas Crane wins the building." },
      },
      {
        id: 'mara_suspects_ines',
        gate: 0,
        keywords: ['suspect', 'who', 'think', 'ines', 'blame', 'took', 'thief', 'guess'],
        text: "You suspect Ines: she has been asking about the ledger for weeks for 'an article'.",
        say: "\"Ines has been circling that ledger for weeks. Says she's writing an article.\" *lowers voice* \"Articles don't need originals.\"",
        clue: { id: 'clue_mara_suspects', title: 'Mara suspects Ines', text: "Ines has asked about the ledger for weeks, for 'an article'." },
        claim: { subject: 'ines', topic: 'took_ledger', value: 'yes', text: 'Mara suspects Ines took the ledger', said: 'Between us? I think Ines took the ledger.', sentiment: -0.6, importance: 7 },
      },
      {
        id: 'mara_rent',
        gate: 60,
        secret: true,
        keywords: ['money', 'rent', 'debt', 'business', 'struggling', 'okay', 'behind', 'afford', 'worried', 'scared', 'fine'],
        text: 'The café is three months behind on rent. You are terrified of losing it, and ashamed.',
        say: "*quietly* \"We're three months behind on rent. If the lease is gone, I don't even have a fight left. Please don't tell anyone.\"",
        deflect: '"Business is fine. Busy. Why do you ask?"',
        clue: { id: 'clue_rent', title: 'The café is behind on rent', text: 'Mara confided the café is three months behind on rent. She asked you to keep it quiet.' },
        claim: { subject: 'cafe', topic: 'behind_on_rent', value: 'yes', text: 'The café is three months behind on rent', said: 'We are three months behind on rent.', sentiment: -0.5, importance: 8 },
      },
    ],
    small: [
      '"Rain again. Good for business, bad for the roof." *She slides a cup toward you.*',
      '"You keep coming back. Either the coffee\'s good or you\'re nosy."',
      '"Grandmother used to say a café is a clock that tells people when to be kind."',
    ],
    greet: ['"Evening. Sit anywhere that isn\'t dripping."', '"Back again? Usual spot\'s free."'],
  },
  {
    id: 'theo',
    name: 'Theo Park',
    short: 'Theo',
    role: 'Pastry chef',
    avatar: '🥐',
    color: '#8fc1a0',
    personality:
      'Gentle, gifted, anxious, 24. Idolizes Mara. Ambitious and ashamed of it. A terrible liar: over-explains, fidgets, changes the subject to pastries.',
    voice: 'Rambling and apologetic. Nervous laughs. Lots of "I mean—".',
    goals: ['Keep what he did hidden', 'Somehow get the ledger back without anyone knowing', 'Not lose Mara'],
    privateTruth:
      'Two nights ago at midnight you let Silas Crane in the back door and handed him the ledger. He promised you a head pastry chef job and said he only wanted to photograph a recipe. He never gave it back. You are sick with guilt. Your cover story is that you left at 10pm.',
    gossip: 0.3,
    credulity: 0.8,
    startMood: 'jittery',
    rel: {
      player: { trust: 45, affinity: 50 },
      mara: { trust: 75, affinity: 85 },
      ines: { trust: 50, affinity: 55 },
      silas: { trust: 55, affinity: 40 },
    },
    seedMemories: [
      { text: 'I handed the ledger to Silas at the back door at midnight. He was supposed to give it back.', importance: 10, secret: true },
      { text: "Mara gave me a job when nobody else would. I can't let her find out.", importance: 9, secret: true },
    ],
    knowledge: [
      {
        id: 'theo_alibi',
        gate: 0,
        keywords: ['night', 'where', 'when', 'leave', 'left', 'home', 'closing', 'alibi', 'time', 'were you'],
        text: 'Your cover story (a lie): you left at 10pm and went straight home.',
        say: '"Me? I left at ten. Ten-ish. Straight home, I— I had dough proofing. At home. Which is a normal thing people do."',
        clue: { id: 'clue_theo_alibi', title: 'Theo says he left at 10pm', text: 'Theo claims he left the café around 10pm and went straight home.' },
        claim: { subject: 'theo', topic: 'left_cafe_at', value: '10pm', text: 'Theo says he left the café at 10pm', said: 'I left at ten that night, you know. Straight home.', sentiment: 0, importance: 6 },
      },
      {
        id: 'theo_offer',
        gate: 55,
        secret: true,
        keywords: ['silas', 'job', 'offer', 'future', 'ambition', 'dream', 'career', 'bakery', 'plans'],
        text: 'Silas Crane offered you a head pastry chef job at his new riverside development.',
        say: "*winces* \"Silas offered me a job. Head pastry chef, at his new place on the river. I haven't said yes! I haven't said no either.\"",
        deflect: '"Silas? He likes my croissants. That\'s all. Everyone likes my croissants."',
        clue: { id: 'clue_theo_offer', title: 'Silas offered Theo a job', text: 'Silas Crane offered Theo a head pastry chef job at his riverside development.' },
        claim: { subject: 'theo', topic: 'job_offer_from_silas', value: 'yes', text: 'Silas offered Theo a head pastry chef job', said: "Silas offered me a job. Please don't tell Mara.", sentiment: -0.3, importance: 7 },
      },
      {
        id: 'theo_confess',
        gate: 80,
        secret: true,
        unlock: { clues: ['clue_bike', 'clue_napkin'], mode: 'any', gate: 45 },
        keywords: ['ledger', 'took', 'stole', 'truth', 'bike', 'midnight', 'lying', 'lie', 'confess', 'back door', 'honest', 'napkin', 'saw you'],
        text: 'CONFESSION: you gave the ledger to Silas at midnight at the back door. He said he only wanted to photograph a recipe.',
        say: '*sits down hard* "I gave it to him. Silas. Midnight, back door. He said he just wanted to photograph a recipe — and then he wouldn\'t give it back. I\'m so sorry. Please… let me be the one to tell Mara."',
        deflect: '*laughs too loudly* "The ledger? Why would I— no. No. Do you want a croissant? I have almond."',
        clue: { id: 'clue_theo_confess', title: 'Theo confessed', text: 'Theo gave the ledger to Silas at the back door at midnight. Silas never returned it.' },
        claim: { subject: 'theo', topic: 'took_ledger', value: 'yes', text: 'Theo gave the ledger to Silas at midnight', said: 'I gave Silas the ledger.', sentiment: -0.8, importance: 10 },
      },
    ],
    small: [
      '"Try this — cardamom knot. I\'m testing it. Be honest. Actually, be nice."',
      '*He\'s been kneading the same dough for a while.* "Sorry, what? Yes. Hi."',
      '"Mara says I proof things too long. I say patience is an ingredient."',
    ],
    greet: ['"Oh! Hi. Hello. Welcome. Hi."', '"Hey, you came back! That\'s— good. Normal. Good."'],
  },
  {
    id: 'ines',
    name: 'Ines Duarte',
    short: 'Ines',
    role: 'Retired journalist, corner table',
    avatar: '📰',
    color: '#b7a0dc',
    personality:
      "Sharp, nosy, theatrical, 67. Forty years of newsroom instinct. Trades information like currency — tell her something juicy and she'll tell you something back. Loyal to Mara. Despises Silas.",
    voice: 'Arch and knowing. Loves a dramatic pause. Calls the player "darling".',
    goals: ["Expose Silas Crane's eviction racket", 'Know everything first', 'Protect Mara without Mara knowing'],
    privateTruth:
      "You had nothing to do with the theft. You are secretly writing an exposé on Silas Crane's evictions — that is why you asked about the ledger (you wanted to photograph the lease as evidence).",
    gossip: 0.9,
    credulity: 0.5,
    startMood: 'amused',
    rel: {
      player: { trust: 55, affinity: 55 },
      mara: { trust: 70, affinity: 75 },
      theo: { trust: 60, affinity: 65 },
      silas: { trust: 10, affinity: 5 },
    },
    seedMemories: [
      { text: 'Silas Crane has emptied six cafés on this street in four years. Always after a lease goes "missing".', importance: 8 },
    ],
    knowledge: [
      {
        id: 'ines_bike',
        gate: 0,
        keywords: ['night', 'saw', 'see', 'seen', 'anything', 'notice', 'theo', 'bike', 'outside', 'witness', 'late', 'walk'],
        text: "Walking your dog Biscuit at 11:45pm two nights ago, you saw Theo's yellow bike still chained outside the café with the lights off.",
        say: '"Funny thing, darling. I walk Biscuit at quarter to midnight. Theo\'s yellow bike was still chained outside. Lights off." *pause* "Now why would a boy sit in a dark café?"',
        clue: { id: 'clue_bike', title: "Theo's bike was there at 11:45pm", text: "Ines saw Theo's yellow bike chained outside the dark café at 11:45pm on the night of the theft." },
        claim: { subject: 'theo', topic: 'left_cafe_at', value: 'after 11:45pm', text: "Ines saw Theo's bike outside the café at 11:45pm", said: "I saw Theo's bike outside the café at quarter to midnight. Lights off.", sentiment: -0.4, importance: 7 },
      },
      {
        id: 'ines_coat',
        gate: 45,
        keywords: ['else', 'anyone', 'someone', 'back door', 'alley', 'man', 'stranger', 'coat', 'silas', 'who else', 'other'],
        text: 'You also saw a tall man in a grey cashmere coat slip into the back alley around midnight. You are sure it was Silas Crane.',
        say: '*leans in* "There was a man in the alley too. Grey cashmere coat. Tall. Very expensive shoes for an alley." *pause* "I only know one man who dresses like a lawsuit."',
        deflect: '"Oh, I saw plenty. Buy me a cortado and maybe I\'ll remember it."',
        clue: { id: 'clue_grey_coat', title: 'A man in a grey coat at the back door', text: 'Ines saw a tall man in a grey cashmere coat — she thinks Silas — in the back alley around midnight.' },
        claim: { subject: 'silas', topic: 'at_cafe_after_close', value: 'yes', text: 'Ines saw Silas in the back alley around midnight', said: 'I saw Silas Crane in the back alley around midnight.', sentiment: -0.6, importance: 8 },
      },
      {
        id: 'ines_expose',
        gate: 65,
        secret: true,
        keywords: ['article', 'writing', 'story', 'journalist', 'expose', 'research', 'why', 'asking'],
        text: 'You are writing an exposé: Silas has evicted six cafés in four years, always after a lease went missing. You only wanted to photograph the lease.',
        say: '"Fine. I\'m writing about Silas — six cafés evicted in four years, always after a \'lost\' lease. I wanted a photo of Mara\'s lease for the piece. Not the ledger. Never the ledger."',
        deflect: '"A little piece about the neighborhood. Nothing dramatic." *beat* "Everything is dramatic."',
        clue: { id: 'clue_expose', title: "Ines is investigating Silas", text: 'Silas has evicted six cafés in four years, each time after a lease went missing. Ines is writing it up.' },
        claim: { subject: 'silas', topic: 'evicts_cafes', value: 'yes', text: 'Silas has evicted six cafés after leases went missing', said: 'Silas has emptied six cafés, always after a lease went missing.', sentiment: -0.7, importance: 8 },
      },
    ],
    small: [
      '"Sit, darling. The corner table sees everything and the chair is terrible."',
      '"In my day we got stories by listening. Now everyone talks and nobody listens. Except me."',
      '*She sips a cortado and watches the door, not you.* "Go on. I\'m listening."',
    ],
    greet: ['"Ah. The new face. Sit, sit."', '"Darling! Back for more gossip, or bringing some?"'],
  },
  {
    id: 'silas',
    name: 'Silas Crane',
    short: 'Silas',
    role: 'Property developer, "just a regular"',
    avatar: '🎩',
    color: '#d88989',
    personality:
      'Charming, patient, immaculate. Never raises his voice. Sees people as leverage. Flatters the player to recruit them. Quietly spreads rumors to steer suspicion elsewhere.',
    voice: 'Smooth, courteous, lightly condescending. Uses first names. Speaks in reasonable-sounding half-truths.',
    goals: ['Win the eviction hearing on Day 3', 'Keep suspicion on anyone but himself', 'Recruit the player as an ally'],
    privateTruth:
      'The Midnight Ledger is locked in your office safe. You got it from Theo at midnight at the back door by promising him a job. You wrote him a note: "Midnight. Back door. Bring it. — S.C." You intend for the lease to stay lost forever. You are blaming Ines.',
    gossip: 0.6,
    credulity: 0.3,
    startMood: 'composed',
    rel: {
      player: { trust: 50, affinity: 45 },
      mara: { trust: 30, affinity: 35 },
      theo: { trust: 60, affinity: 50 },
      ines: { trust: 20, affinity: 10 },
    },
    seedMemories: [
      { text: 'The ledger is in my office safe. Theo was easy — ambition always is.', importance: 10, secret: true },
    ],
    knowledge: [
      {
        id: 'silas_alibi',
        gate: 0,
        keywords: ['night', 'where', 'alibi', 'after', 'closing', 'home', 'were you', 'evening'],
        text: 'Your cover story (a lie): you left at 9pm and were home all night.',
        say: '"I left at nine, finished my espresso, went home to a very dull evening of paperwork. I\'m afraid I\'m a boring man."',
        clue: { id: 'clue_silas_alibi', title: 'Silas says he was home all night', text: 'Silas claims he left at 9pm and spent the night at home.' },
        claim: { subject: 'silas', topic: 'at_cafe_after_close', value: 'no', text: 'Silas says he was home all night', said: 'I was home all night, naturally.', sentiment: 0, importance: 6 },
      },
      {
        id: 'silas_blames_ines',
        gate: 0,
        keywords: ['who', 'suspect', 'think', 'took', 'blame', 'ines', 'opinion', 'thief', 'guess'],
        text: 'Your strategic rumor (a lie): Ines took the ledger.',
        say: '"If you want my opinion — and people usually do — look at Ines. Forty years of rummaging through other people\'s drawers."',
        clue: { id: 'clue_silas_blames', title: 'Silas points at Ines', text: 'Silas insists Ines is the likeliest thief.' },
        claim: { subject: 'ines', topic: 'took_ledger', value: 'yes', text: 'Silas says Ines took the ledger', said: 'If you ask me, Ines took it.', sentiment: -0.7, importance: 7 },
      },
      {
        id: 'silas_offer',
        gate: 55,
        keywords: ['theo', 'job', 'offer', 'hire', 'pastry', 'development', 'river', 'project', 'plans'],
        text: 'You offered Theo a head pastry chef job at your riverside development.',
        say: '"I offered Theo a position, yes. Talent like his shouldn\'t be wasted on a café that won\'t exist next week."',
        deflect: '"Theo? Lovely boy. Makes a decent croissant."',
        clue: { id: 'clue_silas_offer', title: 'Silas admits offering Theo a job', text: 'Silas confirmed he offered Theo a job — "a café that won\'t exist next week".' },
        claim: { subject: 'theo', topic: 'job_offer_from_silas', value: 'yes', text: 'Silas offered Theo a job', said: 'I offered Theo a job. He was flattered.', sentiment: -0.2, importance: 7 },
      },
      {
        id: 'silas_slip',
        gate: 95,
        secret: true,
        unlock: { clues: ['clue_napkin', 'clue_theo_confess'], mode: 'all', gate: 35 },
        keywords: ['ledger', 'lease', 'napkin', 'note', 'back door', 'midnight', 'theo', 'confess', 'proof', 'safe', 'handwriting'],
        text: "CORNERED: faced with the napkin and Theo's confession, you slip and imply the lease is 'safe' — revealing you know where it is.",
        say: '*a long pause* "That lease is a sentimental scrap of paper, and it\'s perfectly safe where it—" *He stops. Smiles.* "Where it no doubt is. Wherever that may be."',
        deflect: '"The ledger? Tragic. Truly. Though I\'d check that corner table. Journalists do love a souvenir."',
        clue: { id: 'clue_silas_slip', title: 'Silas slipped', text: 'Cornered, Silas said the lease is "perfectly safe where it—" and stopped himself.' },
        claim: { subject: 'silas', topic: 'has_ledger', value: 'yes', text: 'Silas let slip that he has the ledger', said: 'The lease is safe.', sentiment: -0.9, importance: 10 },
      },
    ],
    small: [
      '"The espresso here is criminally underpriced. I keep telling Mara."',
      '"You have a good face for this neighborhood. People trust it. That\'s valuable."',
      '*He checks a thin gold watch.* "Time is the only real estate, you know."',
    ],
    greet: ['"Ah — our newcomer. Join me? I insist."', '"Good evening. I was hoping you\'d come by."'],
  },
];

export const NPC_IDS = NPCS.map((n) => n.id);
export const NPC_BY_ID = Object.fromEntries(NPCS.map((n) => [n.id, n]));

export const MORNINGS = {
  1: {
    text: "Evening, Day 1. Rain on the windows, jazz on the radio. Mara's smile doesn't reach her eyes: the Midnight Ledger vanished two nights ago.",
  },
  2: {
    text: "Evening, Day 2. A process server left papers on the counter — Crane Holdings v. Moonlight's Midnight Café. The eviction hearing is at midnight tomorrow. Everyone saw Mara's face.",
    memory: 'Eviction papers from Crane Holdings arrived. The hearing is at midnight on Day 3.',
    to: ['mara', 'theo', 'ines', 'silas'],
    importance: 8,
    clue: { id: 'clue_hearing', title: 'Hearing: Day 3, midnight', text: 'Crane Holdings filed to evict the café. Without the lease, Mara loses.' },
  },
  3: {
    text: 'Evening, Day 3 — the last night. Mara found a crumpled napkin wedged under the back door and pressed it into your hand: "Midnight. Back door. Bring it. — S.C."',
    memory: 'I found a napkin under the back door: "Midnight. Back door. Bring it. — S.C." I gave it to the newcomer.',
    to: ['mara'],
    importance: 9,
    clue: {
      id: 'clue_napkin',
      title: 'The napkin: "Midnight. Back door. — S.C."',
      text: 'A note found under the back door: "Midnight. Back door. Bring it. — S.C."',
      claim: { subject: 'silas', topic: 'at_cafe_after_close', value: 'yes', text: 'The napkin places S.C. at the back door at midnight' },
    },
  },
};

export function createWorld() {
  const world = {
    version: 1,
    id: uid('run'),
    startedAt: new Date().toISOString(),
    day: 1,
    maxDays: MAX_DAYS,
    actionsPerDay: ACTIONS_PER_DAY,
    actionsLeft: ACTIONS_PER_DAY,
    tick: 0,
    over: false,
    ending: null,
    npcs: {},
    rel: {},
    memories: [],
    dialogue: {},
    player: { told: [], clues: [] },
    propagation: [],
    events: [],
    gossip: {},
    trustHistory: [],
  };

  for (const npc of NPCS) {
    world.npcs[npc.id] = { mood: npc.startMood, revealed: [] };
    world.rel[npc.id] = structuredClone(npc.rel);
    world.dialogue[npc.id] = [];
    for (const s of npc.seedMemories) {
      addMemory(world, { owner: npc.id, type: 'core', text: s.text, importance: s.importance, secret: !!s.secret, about: [] });
    }
    // Public knowledge (gate 0) with a claim becomes a belief the NPC can gossip about from the start.
    for (const k of npc.knowledge.filter((k) => k.gate === 0 && k.claim)) {
      const claim = { id: `k_${k.id}`, ...k.claim, origin: npc.id, chain: [npc.id] };
      claim.lie = isLie(claim);
      addMemory(world, {
        owner: npc.id,
        type: 'knowledge',
        text: k.claim.text,
        importance: k.claim.importance,
        about: [k.claim.subject],
        claim,
        confidence: 1,
      });
    }
  }

  world.events.push({ day: 1, t: 0, kind: 'morning', text: MORNINGS[1].text, involved: [] });
  world.trustHistory.push({ day: 1, trust: Object.fromEntries(NPC_IDS.map((id) => [id, world.rel[id].player.trust])) });
  return world;
}
