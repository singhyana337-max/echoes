/**
 * Offline brain: a deterministic, rule-based stand-in for Nemotron.
 * It produces the exact same output shape as the LLM path, so the whole memory /
 * gossip / contradiction engine works identically without an API key.
 */
import { NPC_BY_ID, ENTITY_NAMES } from './world.js';
import { slug } from './util.js';

const NAME_RE = '(mara|theo|in[eè]s|silas|crane)';
const npcIdFrom = (s) => {
  const n = s.toLowerCase();
  if (n.startsWith('in')) return 'ines';
  if (n === 'crane') return 'silas';
  return n;
};
const pick = (arr, seed = Math.random()) => arr[Math.floor(seed * arr.length) % arr.length];
const nameOf = (id) => NPC_BY_ID[id]?.short ?? ENTITY_NAMES[id] ?? id;

/** Pulls factual assertions out of the player's message. */
export function extractClaims(text) {
  const claims = [];
  const sentences = String(text).split(/(?<=[.!?;])\s+|\n/);
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    const isQuestion = /\?\s*$/.test(s);

    let m = s.match(
      /\bi\s+(?:really\s+|absolutely\s+|honestly\s+|kind of\s+|totally\s+)?(love|like|adore|enjoy|hate|dislike|detest|can't stand|cannot stand|don't like|do not like)\s+([a-z][a-z' -]{1,30})/i
    );
    if (m && !isQuestion) {
      const verb = m[1].toLowerCase();
      const obj = m[2].replace(/\b(the|a|an|your|my|this|that|it|here|very|much|so)\b/gi, '').trim().split(/\s+/).slice(0, 2).join(' ');
      if (obj) {
        const negative = /hate|dislike|detest|stand|don't|do not/.test(verb);
        claims.push({
          subject: 'player',
          topic: `opinion_${slug(obj)}`,
          value: negative ? 'dislikes' : 'likes',
          text: `The player says they ${negative ? 'dislike' : 'love'} ${obj}`,
          sentiment: 0,
          importance: 4,
        });
      }
    }

    m = s.match(new RegExp(`\\b${NAME_RE}\\b[^.?!]*?\\b(stole|took|has|hid|swiped|nicked|pinched|grabbed|is hiding)\\b\\s+(?:the\\s+|my\\s+|your\\s+|a\\s+|her\\s+|his\\s+)?([a-z][a-z' ]{1,25})`, 'i'));
    if (m && !isQuestion) {
      const subject = npcIdFrom(m[1]);
      const objRaw = m[3].trim().split(/\s+/).slice(0, 2).join(' ');
      const obj = /ledger|lease|recipe/i.test(objRaw) ? 'ledger' : slug(objRaw.split(' ')[0]);
      const negated = new RegExp(`${m[1]}\\s+(didn't|did not|never|hasn't|has not|doesn't have|wouldn't)`, 'i').test(s);
      const has = /has|hid|hiding/.test(m[2].toLowerCase());
      claims.push({
        subject,
        topic: obj === 'ledger' && has ? 'has_ledger' : `took_${obj}`,
        value: negated ? 'no' : 'yes',
        text: `The player says ${nameOf(subject)} ${negated ? "didn't take" : m[2].toLowerCase()} ${obj === 'ledger' ? 'the ledger' : `the ${objRaw}`}`,
        sentiment: negated ? 0.3 : -0.9,
        importance: 8,
      });
    }

    m = s.match(new RegExp(`\\b${NAME_RE}\\b\\s+(?:is|'s)\\s+(?:a\\s+|an\\s+|totally\\s+|really\\s+)?(liar|lying|thief|crook|dangerous|suspicious|trustworthy|kind|honest|innocent|guilty|hiding something)`, 'i'));
    if (m && !isQuestion) {
      const subject = npcIdFrom(m[1]);
      const trait = m[2].toLowerCase();
      const good = /trustworthy|kind|honest|innocent/.test(trait);
      claims.push({
        subject,
        topic: 'character',
        value: trait,
        text: `The player says ${nameOf(subject)} is ${/^(liar|thief|crook)$/.test(trait) ? `a ${trait}` : trait}`,
        sentiment: good ? 0.5 : -0.7,
        importance: 7,
      });
    }

    m = s.match(new RegExp(`\\b${NAME_RE}\\b[^.?!]*\\b(was|came|went|snuck|sneaked)\\b[^.?!]*\\b(here|caf[eé]|back door|alley)\\b[^.?!]*\\b(midnight|late|after clos\\w+|last night|that night)`, 'i'));
    if (m && !isQuestion) {
      const subject = npcIdFrom(m[1]);
      claims.push({
        subject,
        topic: 'at_cafe_after_close',
        value: 'yes',
        text: `The player says ${nameOf(subject)} was at the café late that night`,
        sentiment: -0.5,
        importance: 7,
      });
    }

    m = s.match(/\bi\s*(?:am|'m)\s+(?:a|an)\s+([a-z][a-z ]{2,24})/i);
    if (m && !isQuestion) {
      const who = m[1].trim().split(/\s+/).slice(0, 2).join(' ');
      claims.push({ subject: 'player', topic: 'identity', value: who, text: `The player says they are a ${who}`, sentiment: 0, importance: 5 });
    }

    m = s.match(/\bi\s+(?:promise|swear)\s+(?:to\s+|that\s+i'?ll\s+|i'?ll\s+)?(.{3,60})/i);
    if (m) {
      claims.push({
        subject: 'player',
        topic: `promise_${slug(m[1].split(/\s+/).slice(0, 3).join(' '))}`,
        value: 'yes',
        text: `The player promised: ${m[1].trim()}`,
        sentiment: 0.2,
        importance: 6,
      });
    }
  }
  return claims;
}

const KIND = /\b(thank|thanks|please|sorry|appreciate|lovely|delicious|beautiful|kind|help you|i believe you|trust you|on your side)\b/i;
const RUDE = /\b(shut up|stupid|idiot|liar|pathetic|useless|hate you|boring|ugly)\b/i;
const GREETING = /^\s*(hi|hello|hey|good (evening|morning|night)|evening|yo)\b/i;

function matchesKnowledge(text, item) {
  const t = text.toLowerCase();
  return item.keywords.reduce((n, k) => n + (t.includes(k) ? 1 : 0), 0);
}

/**
 * ctx: { npc, rel, relOthers, memories, shareable, withheld, history, text, alerts, preClaims, state }
 */
export function fallbackTurn(ctx) {
  const { npc, rel, text, alerts, preClaims, shareable, withheld, history, memories, relOthers } = ctx;
  const lower = text.toLowerCase();
  let trustDelta = 0;
  let affinityDelta = 0;
  let emotion = 'neutral';
  const revealed = [];
  const parts = [];

  if (KIND.test(text)) {
    trustDelta += 3;
    affinityDelta += 4;
    emotion = 'warm';
  }
  if (RUDE.test(text) && !/\b(mara|theo|ines|silas)\b/i.test(text)) {
    trustDelta -= 6;
    affinityDelta -= 8;
    emotion = 'offended';
  }
  if (npc.id === 'ines' && preClaims.some((c) => c.subject !== 'player')) {
    trustDelta += 3; // she loves being told things
    emotion = 'delighted';
  }
  if (npc.id === 'silas' && /\b(ines)\b/i.test(text) && preClaims.some((c) => c.sentiment < 0)) {
    trustDelta += 4;
    emotion = 'pleased';
  }

  // 1. Contradictions come first — the whole point is that they remember.
  const state = ctx.state;
  state.confronted ??= [];
  const grudge = memories.find((m) => m.type === 'caught' && m.spoken && !state.confronted.includes(m.id));
  if (grudge && !alerts.length) {
    state.confronted.push(grudge.id);
    trustDelta -= 2;
    emotion = 'cold';
    parts.push(`*${npc.short} doesn't smile.* ${grudge.spoken}`);
  }
  if (alerts.length) {
    const a = alerts[0];
    trustDelta -= 4;
    emotion = a.kind === 'about-me' ? 'indignant' : 'suspicious';
    if (a.kind === 'self') parts.push(`*${npc.short} sets down the cup.* "Hold on. Earlier you told me ${a.priorText.replace(/^The player says (they )?/i, '')}. Now it's the opposite?"`);
    else if (a.kind === 'heard') parts.push(`"Funny. ${nameOf(a.via)} tells me you said ${a.priorText.replace(/^The player says (they )?/i, '')}. Which version am I getting?"`);
    else parts.push(`"About me? That's not true, and you know it."`);
  } else if (preClaims.some((c) => c.subject === npc.id && c.sentiment < 0)) {
    trustDelta -= 8;
    emotion = 'hurt';
    parts.push(
      {
        mara: '"You\'re accusing me of stealing my own grandmother\'s ledger. Bold. Finish your coffee and think about that."',
        theo: '*goes pale* "What? I— no. Who told you that? That\'s— no."',
        ines: '"Darling, if I stole things I would at least steal something with a byline."',
        silas: '*smiles thinly* "Careful. Accusations are expensive, and I can afford better lawyers than you."',
      }[npc.id]
    );
  } else {
    const aboutOther = preClaims.find((c) => c.subject in NPC_BY_ID && c.subject !== npc.id && c.sentiment < 0);
    if (aboutOther) {
      const other = nameOf(aboutOther.subject);
      emotion = emotion === 'neutral' ? 'intrigued' : emotion;
      parts.push(
        {
          mara: `*her jaw tightens* "${other}? You're sure about that?"`,
          theo: `"${other}? Oh. Oh no. Are you— really? I mean, that makes sense. Doesn't it? Maybe?"`,
          ines: `*eyes light up* "${other}! Oh, darling, that is delicious. Tell me everything."`,
          silas: `"${other}. Well. I'm hardly surprised. People are rarely what they pretend."`,
        }[npc.id]
      );
    }
    const pref = preClaims.find((c) => c.topic.startsWith('opinion_'));
    if (pref && !aboutOther && !grudge) {
      const thing = pref.topic.replace('opinion_', '').replace(/_/g, ' ');
      const liked = pref.value === 'likes';
      parts.push(
        {
          mara: liked ? `"Someone who likes ${thing}. I'll remember that."` : `"No ${thing} for you, then. Noted."`,
          theo: liked ? `"Me too! Well, I— yes. ${thing[0].toUpperCase() + thing.slice(1)}. Great."` : `"Oh! Okay. No ${thing}. Got it. I won't bake you anything with ${thing}."`,
          ines: `"${liked ? 'Loves' : 'Hates'} ${thing}. Filed away, darling. I never forget a detail."`,
          silas: `"A person of ${liked ? 'taste' : 'strong opinions'}. I like that."`,
        }[npc.id]
      );
    }
  }

  // 2. Knowledge — share what trust allows, deflect what it doesn't.
  if (!parts.length || !alerts.length) {
    const ranked = [...shareable, ...withheld]
      .map((k) => ({ k, score: matchesKnowledge(lower, k), open: shareable.includes(k) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || Number(b.open) - Number(a.open));
    const fresh = ranked.find((x) => x.open && !ctx.state.revealed.includes(x.k.id));
    const best = fresh || ranked[0];
    if (best) {
      if (best.open) {
        parts.push(ctx.state.revealed.includes(best.k.id) ? `"Like I said —" ${best.k.say}` : best.k.say);
        if (!ctx.state.revealed.includes(best.k.id)) revealed.push(best.k.id);
        if (emotion === 'neutral') emotion = best.k.secret ? 'vulnerable' : 'thoughtful';
      } else if (best.k.deflect) {
        parts.push(best.k.deflect);
        if (emotion === 'neutral') emotion = 'guarded';
      }
    }
  }

  // 3. Opinions about people.
  if (!parts.length) {
    const who = ['mara', 'theo', 'ines', 'silas'].find((id) => id !== npc.id && new RegExp(`\\b${id}\\b`, 'i').test(lower));
    if (who && relOthers[who]) {
      const t = relOthers[who].trust;
      const n = nameOf(who);
      parts.push(t >= 65 ? `"${n}? I'd trust ${n} with my keys."` : t <= 35 ? `"${n}? Keep your distance. That's all I'll say."` : `"${n}'s… fine. I suppose."`);
    }
  }

  // 4. Memory callbacks and small talk.
  if (!parts.length) {
    if (GREETING.test(text)) parts.push(history.length ? npc.greet[1] : npc.greet[0]);
    const remembered = memories.find((m) => m.type === 'told' && m.claim?.topic?.startsWith('opinion_'));
    if (remembered && Math.random() < 0.6) {
      const thing = remembered.claim.topic.replace('opinion_', '').replace(/_/g, ' ');
      parts.push(remembered.claim.value === 'likes' ? `"Still loving ${thing}, I hope?"` : `"Don't worry, I remember — no ${thing}."`);
    } else {
      const heard = memories.find((m) => m.type === 'heard' && m.claim?.origin === 'player');
      if (heard && Math.random() < 0.5) parts.push(`"${nameOf(heard.source)} mentioned you said something interesting. ${heard.claim.text.replace(/^The player says /i, 'That ')}."`);
      else if (!parts.length) parts.push(pick(npc.small));
    }
  }

  if (trustDelta === 0 && text.length > 25) trustDelta = 1;
  if (rel.trust > 75 && emotion === 'neutral') emotion = 'fond';

  const importance = Math.max(3, ...preClaims.map((c) => c.importance), revealed.length ? 6 : 0, alerts.length ? 8 : 0);
  return {
    reply: parts.join(' '),
    emotion,
    trustDelta,
    affinityDelta,
    revealed,
    claims: preClaims,
    memory: `The newcomer said: "${text.length > 90 ? text.slice(0, 87) + '…' : text}"`,
    importance,
  };
}

export function fallbackGossip({ a, b, results }) {
  const A = NPC_BY_ID[a];
  const B = NPC_BY_ID[b];
  const lines = [];
  const openers = {
    mara: 'Long night. Help me stack the chairs?',
    theo: "I'll sweep. I— I like sweeping. It's calming.",
    ines: "Sit a moment. I've heard things.",
    silas: 'A nightcap before I go? My treat.',
  };
  lines.push({ speaker: a, text: openers[a] });
  for (const r of results) {
    const speaker = r.from;
    const listener = r.to;
    const said =
      r.claim.origin === 'player'
        ? `The newcomer told me something. ${r.claim.text.replace(/^The player says /i, 'Apparently ')}.`
        : r.claim.origin === speaker && r.claim.said
          ? r.claim.said
          : `Did you hear? ${r.claim.text}.`;
    lines.push({ speaker, text: said });
    const subjName = nameOf(r.claim.subject);
    const suspicious = [
      `${subjName}? I wouldn't have guessed. I'll keep an eye out.`,
      `That doesn't sound like ${subjName}. …Does it?`,
      `I'll be watching ${subjName} tomorrow, then.`,
    ];
    const neutral = ['Huh. Good to know.', "I'll remember that.", 'Interesting.'];
    const reaction = {
      adopted: pick(r.claim.sentiment < -0.3 && r.claim.subject in NPC_BY_ID ? suspicious : neutral),
      contradiction: `Wait. The newcomer told ME the opposite — ${String(r.conflictText || '').replace(/^The player says /i, '')}. Someone's playing us.`,
      doubt: "That's not what I heard. Not at all.",
      known: 'I know. I heard.',
    }[r.outcome];
    lines.push({ speaker: listener, text: reaction });
  }
  if (results.length === 0) lines.push({ speaker: b, text: 'Quiet night. Let\'s just close up.' });
  if (results.some((r) => r.outcome === 'contradiction')) {
    lines.push({ speaker: a, text: 'Then the newcomer is telling each of us a different story.' });
  }
  return { title: `${A.short} & ${B.short}, after closing`, lines };
}

const FALLBACK_EPILOGUES = {
  justice: 'Silas Crane smiled all the way into the hearing room — right up until the napkin, Theo, and a very prepared journalist walked in behind you. The ledger came out of his safe by morning.',
  redemption: 'Theo told Mara everything before you could. Then he told the court. The ledger came home in an evidence bag, and the lantern above the door never went out.',
  pressure: 'You had no proof, only a room full of people who believed you. By dawn the ledger was on the counter, unsigned and rain-spotted. Nobody asked how.',
  bluff: "Silas listened politely, called his lawyer, and won. The café's windows were papered over within the month.",
  scapegoat: 'Theo broke down and admitted what he did. But the man who took the ledger from him simply said "What ledger?" — and the lease stayed lost.',
  denial: 'Theo denied everything, badly. Without proof there was nothing to do but watch the hearing go the wrong way.',
  wrong_ines: 'Ines laughed, then stopped laughing. The café lost its lease, and she took her story — and her evidence — somewhere else.',
  wrong_mara: "Mara looked at you for a long moment, then turned the sign to CLOSED. It's the last time anyone saw it lit.",
  wrong_theo: '',
};

export function fallbackEnding({ outcome, accused, stats, trust }) {
  const fates = {};
  for (const id of Object.keys(trust)) {
    const t = trust[id];
    const n = nameOf(id);
    fates[id] =
      t >= 65 ? `${n} counts you as a friend now — the kind who remembers your order.`
        : t <= 30 ? `${n} still tells the story of the newcomer who couldn't keep their stories straight.`
          : `${n} nods when you come in. Nothing more, nothing less.`;
  }
  return {
    title: null,
    epilogue:
      FALLBACK_EPILOGUES[outcome] +
      (stats.contradictionsExposed > 0 ? ` People noticed you told different people different things (${stats.contradictionsExposed} times).` : '') +
      (stats.rumorHops > 0 ? ` Your words travelled ${stats.rumorHops} times without you in the room.` : ''),
    fates,
    accused,
  };
}
