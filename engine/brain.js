/**
 * The NPC "brain": builds focused prompts from world state and asks Nemotron for a decision.
 * Every call has an offline fallback with an identical output shape.
 */
import { chatJSON, llmConfig } from './llm.js';
import { fallbackTurn, fallbackGossip, fallbackEnding } from './fallback.js';
import { NPC_BY_ID, NPC_IDS, PREMISE, ENTITY_NAMES } from './world.js';
import { canonicalClaim, clamp, claimKey } from './util.js';

const nameOf = (id) => NPC_BY_ID[id]?.short ?? ENTITY_NAMES[id] ?? id;
const trustWord = (t) => (t >= 75 ? 'you trust them' : t >= 55 ? 'warming to them' : t >= 35 ? 'unsure of them' : 'you distrust them');

function describeMemory(m) {
  const when = `Day ${m.day}`;
  const faint = m.strength < 0.5 ? ', faint' : '';
  let src = '';
  if (m.type === 'told') src = 'the player told you';
  else if (m.type === 'heard') {
    const chain = m.chain.filter((c) => c !== m.owner).map(nameOf).reverse().join(' ← ');
    src = `heard from ${chain}`;
  } else if (m.type === 'knowledge') src = 'you know first-hand';
  else if (m.type === 'caught') src = 'you noticed';
  else if (m.type === 'core') src = 'core memory';
  else src = m.type;
  const conf = m.claim && m.confidence < 0.6 ? ` (you half-believe this, ${Math.round(m.confidence * 100)}%)` : '';
  return `- [${when}, ${src}${faint}] ${m.text}${conf}`;
}

function turnPrompt(ctx) {
  const { npc, world, rel, relOthers, memories, shareable, withheld, alerts, existingTopics, state } = ctx;
  const others = NPC_IDS.filter((id) => id !== npc.id)
    .map((id) => `${nameOf(id)}: trust ${relOthers[id].trust}/100, warmth ${relOthers[id].affinity}/100`)
    .join('; ');
  const share = shareable.length
    ? shareable.map((k) => `- (id: ${k.id})${state.revealed.includes(k.id) ? ' [already told the player]' : ''} ${k.text}`).join('\n')
    : '- (nothing yet)';
  const hold = withheld.length ? withheld.map((k) => `- ${k.text}`).join('\n') : '- (nothing)';
  const alertText = alerts.length ? `\nATTENTION:\n${alerts.map((a) => `- ${a.prompt}`).join('\n')}\n` : '';

  return `You are ${npc.name}, ${npc.role} at Moonlight's Midnight Café — a character in "ECHOES", a mystery where every character remembers everything the player says and talks to the others behind their back.

WORLD: ${PREMISE}
It is evening on Day ${world.day} of 3.

WHO YOU ARE: ${npc.personality}
VOICE: ${npc.voice}
GOALS: ${npc.goals.join('; ')}
PRIVATE TRUTH (never state outright; let it colour your behaviour): ${npc.privateTruth}

HOW YOU FEEL ABOUT THE PLAYER: trust ${rel.trust}/100 (${trustWord(rel.trust)}), warmth ${rel.affinity}/100. Current mood: ${state.mood}.
HOW YOU FEEL ABOUT OTHERS: ${others}

WHAT YOU REMEMBER (most relevant first; second-hand things may be wrong):
${memories.map(describeMemory).join('\n') || '- nothing relevant'}

YOU MAY SHARE THESE IF THE CONVERSATION NATURALLY GOES THERE:
${share}

YOU WILL NOT REVEAL THESE YET (deflect, change the subject, or hint that there's more):
${hold}
${alertText}
RULES:
- Stay in character. Reply with 1–3 short sentences of spoken dialogue; you may include one brief *action*.
- Use your memories naturally: bring up things the player told you before, or things you heard about them.
- If the player contradicts what they told you, or what you heard they told someone else, call it out.
- Only reveal a SHARE item if the player gave you an opening. Most turns reveal nothing. Never reveal a WILL NOT REVEAL item.
- Never mention numbers, trust scores, or that you are an AI.

Respond with ONLY a JSON object:
{
  "reply": "what you say",
  "emotion": "one word",
  "trust_delta": integer -10..10,
  "affinity_delta": integer -10..10,
  "revealed": ["ids of SHARE items your reply actually disclosed"],
  "claims": [{"subject": "player|mara|theo|ines|silas|ledger|cafe or a short noun", "topic": "snake_case", "value": "short", "text": "third-person restatement, e.g. 'The player says Theo took the ledger'", "sentiment": -1..1, "importance": 1..10}],
  "memory": "one sentence, from your point of view, about what matters in this exchange",
  "importance": 1..10
}
"claims" lists factual assertions THE PLAYER made in their latest message (not questions, not your own words); empty if none.
Topic conventions: preferences -> "opinion_<thing>" with value "likes" or "dislikes"; theft -> "took_ledger" / "has_ledger" with value "yes"/"no"; whereabouts -> "left_cafe_at" or "at_cafe_after_close".
Reuse an existing topic if one fits: ${existingTopics.join(', ') || 'none yet'}.`;
}

function transcript(history, text) {
  const lines = history.map((h) => (h.from === 'player' ? `PLAYER: ${h.text}` : `YOU: ${h.text}`));
  return `${lines.length ? `Earlier tonight and before:\n${lines.join('\n')}\n\n` : ''}PLAYER: ${text}`;
}

function normalizeTurn(raw, ctx) {
  if (!raw || typeof raw.reply !== 'string' || !raw.reply.trim()) throw new Error('Model returned no reply');
  const allowed = new Set(ctx.shareable.map((k) => k.id));
  let claims = Array.isArray(raw.claims) ? raw.claims.filter((c) => c && c.topic).map(canonicalClaim) : [];
  // The regex pre-pass catches claims the model occasionally forgets to list.
  const have = new Set(claims.map(claimKey));
  for (const c of ctx.preClaims) if (!have.has(claimKey(c))) claims.push(c);
  return {
    reply: raw.reply.trim(),
    emotion: String(raw.emotion || 'neutral').toLowerCase().split(/\s+/)[0].slice(0, 20),
    trustDelta: clamp(Math.round(Number(raw.trust_delta) || 0), -10, 10),
    affinityDelta: clamp(Math.round(Number(raw.affinity_delta) || 0), -10, 10),
    revealed: (Array.isArray(raw.revealed) ? raw.revealed : []).filter((id) => allowed.has(id)),
    claims: claims.slice(0, 4),
    memory: String(raw.memory || `The player said: "${ctx.text.slice(0, 80)}"`).slice(0, 240),
    importance: clamp(Math.round(Number(raw.importance) || 4), 1, 10),
  };
}

export async function npcTurn(ctx) {
  if (llmConfig().enabled) {
    try {
      const raw = await chatJSON({ system: turnPrompt(ctx), user: transcript(ctx.history, ctx.text), maxTokens: 700 });
      return { ...normalizeTurn(raw, ctx), source: 'nemotron' };
    } catch (err) {
      console.warn(`[brain] ${ctx.npc.id} turn fell back to offline brain: ${err.message}`);
    }
  }
  return { ...fallbackTurn(ctx), source: 'offline' };
}

export async function gossipScene({ a, b, results, world }) {
  const fallback = fallbackGossip({ a, b, results });
  if (!llmConfig().enabled) return { ...fallback, source: 'offline' };
  const A = NPC_BY_ID[a];
  const B = NPC_BY_ID[b];
  const facts = results.length
    ? results
        .map((r) => {
          const what = r.claim.origin === 'player' ? `${r.claim.text} (the newcomer said this)` : r.claim.text;
          const outcome = {
            adopted: `${nameOf(r.to)} believes it (${Math.round(r.confidence * 100)}%).`,
            contradiction: `${nameOf(r.to)} realises the newcomer told THEM the opposite: "${r.conflictText}". They both conclude the newcomer is telling different people different stories.`,
            doubt: `${nameOf(r.to)} had heard differently ("${r.conflictText}") and is doubtful.`,
            known: `${nameOf(r.to)} already knew.`,
          }[r.outcome];
          return `- ${nameOf(r.from)} tells ${nameOf(r.to)}: ${what}. ${outcome}`;
        })
        .join('\n')
    : '- Nothing new is exchanged; it is a quiet, tense moment.';
  const system = `You write short, vivid scenes for "ECHOES", a mystery set in Moonlight's Midnight Café.
${PREMISE}
It is after closing on Day ${world.day}. The player is NOT present.

${A.name} (${A.role}): ${A.personality} Voice: ${A.voice}
${B.name} (${B.role}): ${B.personality} Voice: ${B.voice}
Private truths (they would never say these aloud, but it colours how they talk): ${A.short}: ${A.privateTruth} ${B.short}: ${B.privateTruth}

In this scene, exactly this information changes hands:
${facts}

Write 4–7 lines of dialogue that clearly convey each exchange and each reaction above, in character. Do not invent other new facts about the theft.
Respond with ONLY JSON: {"title": "short scene title", "lines": [{"speaker": "${a}" or "${b}", "text": "..."}]}`;
  try {
    const raw = await chatJSON({ system, user: 'Write the scene.', maxTokens: 700, temperature: 0.8 });
    const lines = (raw.lines || [])
      .filter((l) => l && (l.speaker === a || l.speaker === b) && typeof l.text === 'string')
      .map((l) => ({ speaker: l.speaker, text: l.text.trim() }));
    if (lines.length < 2) throw new Error('scene too short');
    return { title: String(raw.title || fallback.title).slice(0, 80), lines, source: 'nemotron' };
  } catch (err) {
    console.warn(`[brain] gossip ${a}/${b} fell back: ${err.message}`);
    return { ...fallback, source: 'offline' };
  }
}

export async function endingNarrative({ outcome, accused, stats, trust, world, outcomeMeta }) {
  const fallback = fallbackEnding({ outcome, accused, stats, trust });
  if (!llmConfig().enabled) return { ...fallback, source: 'offline' };
  const told = world.player.told
    .slice(-12)
    .map((t) => `- To ${nameOf(t.npc)} on Day ${t.day}: "${t.text}"${t.lie ? ' [a lie]' : ''}${t.exposed ? ' [caught]' : ''}`)
    .join('\n');
  const rumors = world.propagation
    .filter((p) => p.from !== 'player' && p.to !== 'player' && p.origin === 'player')
    .map((p) => `- ${nameOf(p.from)} → ${nameOf(p.to)}: ${p.text}`)
    .join('\n');
  const system = `You write the ending of "ECHOES", a three-night mystery at Moonlight's Midnight Café.
${PREMISE}
THE TRUTH: Theo handed the ledger to Silas Crane at the back door at midnight, lured by a job offer. Silas has it in his safe.

On the final night the player accused ${nameOf(accused)}. Outcome: "${outcomeMeta.title}" — ${outcomeMeta.blurb} The café is ${outcomeMeta.saved ? 'SAVED' : 'LOST'}.
Clues the player found: ${world.player.clues.map((c) => c.title).join('; ') || 'none'}.
Final trust in the player: ${Object.entries(trust).map(([id, t]) => `${nameOf(id)} ${t}/100`).join(', ')}.
Lies the player told: ${stats.lies}. Times the player was caught contradicting themselves: ${stats.contradictionsExposed}. Times the player's words were repeated between characters: ${stats.rumorHops}.
What the player told people:
${told || '- very little'}
How their words spread:
${rumors || '- they did not spread'}

Write an ending that makes the player feel the world remembered them: reference specific things they said and who repeated them. Keep the outcome exactly as given.
Respond with ONLY JSON: {"epilogue": "one paragraph, 90-140 words, second person", "fates": {"mara": "one sentence", "theo": "one sentence", "ines": "one sentence", "silas": "one sentence"}}`;
  try {
    const raw = await chatJSON({ system, user: 'Write the ending.', maxTokens: 900, temperature: 0.8 });
    if (!raw.epilogue) throw new Error('no epilogue');
    return { title: null, epilogue: String(raw.epilogue), fates: { ...fallback.fates, ...(raw.fates || {}) }, source: 'nemotron' };
  } catch (err) {
    console.warn(`[brain] ending fell back: ${err.message}`);
    return { ...fallback, source: 'offline' };
  }
}
