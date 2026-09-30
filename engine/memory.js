import { uid, tokenize, detectEntities, claimKey } from './util.js';

/**
 * Memory types:
 *   core       — backstory the NPC starts with
 *   knowledge  — a fact the NPC knows first-hand (can be gossiped)
 *   told       — something the player told them directly
 *   heard      — second-hand, from another NPC (carries a source chain)
 *   conversation — the NPC's own summary of a chat with the player
 *   shared     — "I told the player X" (so NPCs know who knows what)
 *   gossiped   — "I told Y about X"
 *   caught     — a detected lie or contradiction
 *   observed   — world events (morning news)
 *   feeling    — emotional residue ("everyone was cold to me")
 */
export function addMemory(world, m) {
  const mem = {
    id: uid('m'),
    owner: m.owner,
    day: world.day,
    t: world.tick,
    type: m.type || 'conversation',
    text: m.text,
    about: [...new Set(m.about || [])],
    source: m.source || 'self',
    chain: m.chain || [],
    importance: m.importance ?? 5,
    strength: 1,
    faded: false,
    secret: !!m.secret,
    claim: m.claim || null,
    confidence: m.confidence ?? 1,
    spoken: m.spoken || null, // what the NPC would say out loud about this (used by the offline brain)
  };
  world.memories.push(mem);
  return mem;
}

/**
 * Relevance-weighted recall: keyword overlap + entity overlap + importance×strength + recency.
 * The LLM only ever sees these top-k memories, never the full history.
 */
export function retrieve(world, owner, query, { k = 8, focus = [] } = {}) {
  const q = new Set(tokenize(query));
  const ents = new Set([...detectEntities(query), ...focus]);
  return world.memories
    .filter((m) => m.owner === owner && !m.faded)
    .map((m) => {
      const toks = tokenize(m.text);
      let overlap = 0;
      for (const t of toks) if (q.has(t)) overlap++;
      const relevance = overlap / Math.sqrt(toks.length + 1);
      const entity = m.about.filter((a) => ents.has(a)).length;
      const recency = Math.exp(-(world.tick - m.t) / 12);
      const score =
        2 * relevance + 0.6 * entity + 0.12 * m.importance * m.strength + 0.8 * recency + (m.type === 'caught' ? 0.6 : 0);
      return { m, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.m);
}

/** The NPC's current belief on a subject|topic — the most recent, unfaded claim memory. */
export function beliefFor(world, owner, key) {
  let best = null;
  for (const m of world.memories) {
    if (m.owner === owner && m.claim && !m.faded && claimKey(m.claim) === key && (!best || m.t >= best.t)) best = m;
  }
  return best;
}

export function claimMemories(world, owner) {
  return world.memories.filter((m) => m.owner === owner && m.claim && !m.faded);
}

export function knowsClaim(world, owner, claimId) {
  return world.memories.some((m) => m.owner === owner && m.claim?.id === claimId);
}

/**
 * Forgetting. Every night, memories lose strength in inverse proportion to importance.
 * Importance ≥ 8 never fades; small talk is gone within two nights. Recall (retrieve) refreshes strength.
 */
export function decay(world) {
  const faded = [];
  for (const m of world.memories) {
    if (m.faded || m.importance >= 8 || m.type === 'core') continue;
    m.strength = Math.max(0, +(m.strength - (1 - m.importance / 10) * 0.5).toFixed(2));
    if (m.strength <= 0.2) {
      m.faded = true;
      faded.push(m);
    }
  }
  return faded;
}
