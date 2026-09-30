import fs from 'node:fs';
import path from 'node:path';
import { createWorld, NPCS, NPC_IDS, NPC_BY_ID, TRUTH, MORNINGS, ENTITY_NAMES, isLie } from './world.js';
import { addMemory, retrieve, beliefFor, claimMemories, knowsClaim, decay } from './memory.js';
import { npcTurn, gossipScene, endingNarrative } from './brain.js';
import { extractClaims } from './fallback.js';
import { llmStatus } from './llm.js';
import { canonicalClaim, claimKey, valuesConflict, clamp, uid, detectEntities, HttpError } from './util.js';

const nameOf = (id) => NPC_BY_ID[id]?.short ?? ENTITY_NAMES[id] ?? id;
const stripPlayer = (t) => String(t).replace(/^The player says (that )?/i, '');
const toYou = (t) => stripPlayer(t).replace(/\bthey\b/g, 'you').replace(/\btheir\b/g, 'your').replace(/\bthemselves\b/g, 'yourself');

export const OUTCOMES = {
  justice: { title: 'The Lantern Still Burns', saved: true, blurb: 'You named Silas with proof. The ledger came back and the eviction collapsed.' },
  redemption: { title: 'The Apprentice Testifies', saved: true, blurb: 'You named Theo — and he trusted you enough to turn on Silas. The ledger came home.' },
  pressure: { title: 'A Quiet Return', saved: true, blurb: 'Thin evidence, but the people you won over stood behind you. The ledger reappeared by dawn.' },
  bluff: { title: 'The Man in the Grey Coat Walks', saved: false, blurb: 'You were right about Silas, but you could not prove it.' },
  scapegoat: { title: 'The Wrong Kind of Right', saved: false, blurb: 'Theo was caught, but Silas kept the ledger and the lease stayed lost.' },
  denial: { title: 'A Guess in the Dark', saved: false, blurb: 'Theo was guilty, but without evidence or his trust he denied everything.' },
  wrong_ines: { title: 'The Headline Nobody Wanted', saved: false, blurb: 'You accused the one person investigating the real culprit.' },
  wrong_mara: { title: 'Accusing the Owner', saved: false, blurb: 'You accused Mara of stealing her own ledger.' },
};

export class Game {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.savePath = path.join(dataDir, 'save.json');
    this.runsPath = path.join(dataDir, 'runs.json');
    this.queue = Promise.resolve();
    fs.mkdirSync(dataDir, { recursive: true });
    this.world = this.#read(this.savePath) ?? createWorld();
    this.runs = this.#read(this.runsPath) ?? [];
  }

  #read(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  save() {
    fs.writeFileSync(this.savePath, JSON.stringify(this.world));
  }

  reset() {
    this.world = createWorld();
    this.save();
    return this.state();
  }

  clearRuns() {
    this.runs = [];
    fs.writeFileSync(this.runsPath, '[]');
    return this.state();
  }

  state() {
    const cast = NPCS.map(({ seedMemories, small, greet, ...rest }) => ({
      ...rest,
      knowledge: rest.knowledge.map(({ say, deflect, keywords, ...k }) => ({ ...k, effectiveGate: this.#gate(k) })),
    }));
    return { world: this.world, cast, truth: TRUTH, llm: llmStatus(), runs: this.runs };
  }

  // ─── Knowledge gates ────────────────────────────────────────────────────────

  #hasClue(id) {
    return this.world.player.clues.some((c) => c.id === id);
  }

  #gate(item) {
    const u = item.unlock;
    if (!u) return item.gate;
    const ok = u.mode === 'all' ? u.clues.every((c) => this.#hasClue(c)) : u.clues.some((c) => this.#hasClue(c));
    return ok ? Math.min(item.gate, u.gate) : item.gate;
  }

  knowledgeFor(npcId) {
    const trust = this.world.rel[npcId].player.trust;
    const shareable = [];
    const withheld = [];
    for (const k of NPC_BY_ID[npcId].knowledge) (trust >= this.#gate(k) ? shareable : withheld).push(k);
    return { shareable, withheld };
  }

  topicKeys() {
    const keys = new Set();
    for (const m of this.world.memories) if (m.claim) keys.add(claimKey(m.claim));
    return [...keys].slice(0, 40);
  }

  // ─── Talking ────────────────────────────────────────────────────────────────

  contradictionAlerts(npcId, claims) {
    const alerts = [];
    for (const c of claims) {
      if (c.subject === npcId && c.sentiment < 0 && isLie(c)) {
        alerts.push({ kind: 'about-me', priorText: '', prompt: `The player just made a false claim about YOU ("${c.text}"). You know it is untrue.` });
        continue;
      }
      const prior = beliefFor(this.world, npcId, claimKey(c));
      if (!prior || prior.claim.origin !== 'player' || !valuesConflict(prior.claim.value, c.value)) continue;
      if (prior.type === 'told') {
        alerts.push({ kind: 'self', priorText: prior.claim.text, prompt: `On Day ${prior.day} the player told YOU: "${prior.claim.text}". Their new message says the opposite. Call it out.` });
      } else {
        alerts.push({
          kind: 'heard',
          via: prior.source,
          priorText: prior.claim.text,
          prompt: `${nameOf(prior.source)} told you the player said: "${prior.claim.text}". The player's new message contradicts that. Confront them — mention ${nameOf(prior.source)}.`,
        });
      }
    }
    return alerts;
  }

  async talk(npcId, rawText) {
    const w = this.world;
    const npc = NPC_BY_ID[npcId];
    if (!npc) throw new HttpError(400, 'Unknown character.');
    if (w.over) throw new HttpError(409, 'This story has ended. Start a new playthrough.');
    if (w.actionsLeft <= 0) throw new HttpError(409, 'The café is closing. End the night to continue.');
    const text = String(rawText ?? '').trim().slice(0, 400);
    if (!text) throw new HttpError(400, 'Say something first.');

    w.tick++;
    const rel = w.rel[npcId].player;
    const trustBefore = rel.trust;
    const preClaims = extractClaims(text).map(canonicalClaim);
    const alerts = this.contradictionAlerts(npcId, preClaims);
    const recalled = retrieve(w, npcId, text, { k: 8, focus: ['player'] });
    for (const m of recalled) m.strength = Math.min(1, +(m.strength + 0.1).toFixed(2)); // rehearsal
    const { shareable, withheld } = this.knowledgeFor(npcId);

    const out = await npcTurn({
      npc,
      world: w,
      state: w.npcs[npcId],
      rel,
      relOthers: w.rel[npcId],
      memories: recalled,
      shareable,
      withheld,
      history: w.dialogue[npcId].slice(-8),
      text,
      alerts,
      preClaims,
      existingTopics: this.topicKeys(),
    });

    w.dialogue[npcId].push({ from: 'player', text, day: w.day, t: w.tick });
    const line = { from: 'npc', text: out.reply, emotion: out.emotion, day: w.day, t: w.tick, source: out.source, recalled: recalled.map((m) => m.id), notes: [] };
    w.dialogue[npcId].push(line);

    rel.trust = clamp(rel.trust + out.trustDelta);
    rel.affinity = clamp(rel.affinity + out.affinityDelta);

    const notes = [];
    for (const c of out.claims) this.#receivePlayerClaim(npcId, c, notes);
    for (const id of out.revealed) this.#reveal(npcId, id, notes);

    const mem = addMemory(w, {
      owner: npcId,
      type: 'conversation',
      text: out.memory,
      about: ['player', ...detectEntities(text)],
      importance: out.importance,
      source: 'player',
    });
    w.npcs[npcId].mood = out.emotion;
    w.actionsLeft--;

    const delta = rel.trust - trustBefore;
    if (delta) notes.push({ kind: delta > 0 ? 'trust-up' : 'trust-down', text: `${npc.short}'s trust in you ${delta > 0 ? '+' : ''}${delta} → ${rel.trust}` });
    notes.push({ kind: 'memory', text: `${npc.short} will remember: "${out.memory}" (importance ${out.importance})` });
    line.notes = notes;

    this.save();
    return { reply: out.reply, emotion: out.emotion, source: out.source, notes, recalled: recalled.map((m) => m.id), memoryId: mem.id, state: this.state() };
  }

  #receivePlayerClaim(npcId, c, notes) {
    const w = this.world;
    const rel = w.rel[npcId].player;
    const npc = NPC_BY_ID[npcId];
    const claim = { id: uid('c'), ...c, origin: 'player', chain: ['player'], lie: isLie(c) };
    const told = { id: claim.id, npc: npcId, day: w.day, t: w.tick, ...c, lie: claim.lie, exposed: false };
    w.player.told.push(told);
    w.propagation.push({ claimId: claim.id, from: 'player', to: npcId, day: w.day, t: w.tick, origin: 'player', text: claim.text, lie: claim.lie });
    if (claim.lie) w.events.push({ day: w.day, t: w.tick, kind: 'lie', text: `You told ${npc.short}: "${stripPlayer(c.text)}" — that's false.`, involved: ['player', npcId] });

    // The subject of a false accusation knows it's false.
    if (c.subject === npcId && claim.lie) {
      rel.trust = clamp(rel.trust - 12);
      told.exposed = true;
      addMemory(w, { owner: npcId, type: 'caught', text: `The newcomer told me "${stripPlayer(c.text)}" — about me. That's a lie.`, about: ['player'], importance: 9, source: 'player' });
      w.events.push({ day: w.day, t: w.tick, kind: 'caught', text: `${npc.short} knows your claim about them is false.`, involved: ['player', npcId] });
      notes.push({ kind: 'caught', text: `${npc.short} knows that's not true — it's about them.` });
      return;
    }

    let confidence = clamp((rel.trust / 100) * (0.5 + npc.credulity * 0.5), 0.05, 1);
    const prior = beliefFor(w, npcId, claimKey(claim));
    if (prior && valuesConflict(prior.claim.value, claim.value)) {
      if (prior.claim.origin === 'player') {
        const direct = prior.type === 'told';
        rel.trust = clamp(rel.trust - (direct ? 10 : 8));
        told.exposed = true;
        const priorTold = w.player.told.find((t) => t.id === prior.claim.id);
        if (priorTold) priorTold.exposed = true;
        const text = direct
          ? `The newcomer contradicted themselves: first "${stripPlayer(prior.claim.text)}", now "${stripPlayer(c.text)}".`
          : `${nameOf(prior.source)} said the newcomer told them "${stripPlayer(prior.claim.text)}" — but they just told me "${stripPlayer(c.text)}". They're telling people different stories.`;
        addMemory(w, { owner: npcId, type: 'caught', text, about: ['player', claim.subject], importance: 9, source: 'player' });
        w.events.push({ day: w.day, t: w.tick, kind: 'contradiction', text: `${npc.short} caught you: ${text}`, involved: ['player', npcId, ...(direct ? [] : [prior.source])] });
        notes.push({ kind: 'caught', text: direct ? `${npc.short} remembers you said the opposite before.` : `${npc.short} already heard your other version from ${nameOf(prior.source)}.` });
        confidence *= 0.4;
      } else if (prior.claim.origin === npcId) {
        confidence *= 0.3; // they know better first-hand
        notes.push({ kind: 'doubt', text: `${npc.short} doesn't buy it — they know otherwise.` });
      }
    }

    addMemory(w, {
      owner: npcId,
      type: 'told',
      text: claim.text,
      about: [claim.subject, 'player'],
      importance: claim.importance,
      source: 'player',
      chain: ['player'],
      claim,
      confidence: +confidence.toFixed(2),
    });

    if (claim.subject in NPC_BY_ID && claim.subject !== npcId && claim.sentiment !== 0) {
      const r = w.rel[npcId][claim.subject];
      const shift = Math.round(18 * confidence * claim.sentiment);
      r.trust = clamp(r.trust + shift);
      r.affinity = clamp(r.affinity + Math.round(shift / 2));
      if (shift) notes.push({ kind: 'influence', text: `${npc.short}'s trust in ${nameOf(claim.subject)} ${shift > 0 ? '+' : ''}${shift} (believes you ${Math.round(confidence * 100)}%)` });
    }
  }

  #reveal(npcId, knowledgeId, notes) {
    const w = this.world;
    const item = NPC_BY_ID[npcId].knowledge.find((k) => k.id === knowledgeId);
    if (!item) return;
    const st = w.npcs[npcId];
    const first = !st.revealed.includes(item.id);
    if (first) st.revealed.push(item.id);
    if (!this.#hasClue(item.clue.id)) {
      w.player.clues.push({ ...item.clue, day: w.day, from: npcId, claim: item.claim ? { ...item.claim } : null, knowledgeId: item.id });
      notes.push({ kind: 'clue', text: `Clue: ${item.clue.title}` });
      w.events.push({ day: w.day, t: w.tick, kind: 'reveal', text: `${nameOf(npcId)} told you: ${item.clue.title}.`, involved: [npcId, 'player'] });
      w.propagation.push({ claimId: `k_${item.id}`, from: npcId, to: 'player', day: w.day, t: w.tick, origin: npcId, text: item.clue.title, lie: item.claim ? isLie(item.claim) : false });
    }
    if (first) {
      addMemory(w, { owner: npcId, type: 'shared', text: `I told the newcomer: ${item.text}`, about: ['player'], importance: item.secret ? 8 : 5 });
    }
  }

  // ─── Night: gossip, propagation, forgetting ─────────────────────────────────

  #choosePairs() {
    const w = this.world;
    const pairs = [];
    for (let i = 0; i < NPC_IDS.length; i++)
      for (let j = i + 1; j < NPC_IDS.length; j++) {
        const [a, b] = [NPC_IDS[i], NPC_IDS[j]];
        const bond = (w.rel[a][b].trust + w.rel[b][a].trust) / 200;
        const chatty = NPC_BY_ID[a].gossip + NPC_BY_ID[b].gossip;
        const material = this.#candidates(a, b).length + this.#candidates(b, a).length;
        pairs.push({ a, b, score: bond + chatty + Math.min(material, 4) * 0.25 + Math.random() * 0.6 });
      }
    pairs.sort((x, y) => y.score - x.score);
    const chosen = [];
    const seen = new Set();
    for (const p of pairs) {
      if (chosen.length >= 3) break;
      // Prefer pairs that bring someone new into the conversation.
      if (chosen.length < 2 || !seen.has(p.a) || !seen.has(p.b)) {
        chosen.push(p);
        seen.add(p.a);
        seen.add(p.b);
      }
    }
    // Chattier NPC speaks first.
    return chosen.map((p) => (NPC_BY_ID[p.a].gossip >= NPC_BY_ID[p.b].gossip ? [p.a, p.b] : [p.b, p.a]));
  }

  #candidates(speaker, listener) {
    const w = this.world;
    const closeness = w.rel[speaker][listener].trust;
    const seen = new Set();
    return claimMemories(w, speaker)
      .filter((m) => {
        const c = m.claim;
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        if (knowsClaim(w, listener, c.id)) return false;
        if (c.subject === speaker && c.sentiment < 0) return false; // nobody incriminates themselves
        if (c.subject === listener && c.sentiment < 0 && closeness < 80) return false; // you don't say it to their face
        if (m.confidence < 0.2) return false;
        return true;
      })
      .map((m) => ({
        m,
        score: m.claim.importance / 10 + Math.abs(m.claim.sentiment) + (m.claim.origin === 'player' ? 0.4 : 0) + m.confidence * 0.5 + Math.random() * 0.3,
      }))
      .sort((x, y) => y.score - x.score);
  }

  #transmit(from, to, m) {
    const w = this.world;
    const c = m.claim;
    const listener = NPC_BY_ID[to];
    const result = { from, to, claim: { ...c }, outcome: 'adopted', confidence: 0, conflictText: '' };
    w.propagation.push({ claimId: c.id, from, to, day: w.day, t: w.tick, origin: c.origin, text: c.text, lie: !!c.lie });
    addMemory(w, { owner: from, type: 'gossiped', text: `I told ${listener.short}: ${c.text}`, about: [to, c.subject], importance: 3 });

    const prior = beliefFor(w, to, claimKey(c));
    if (prior && prior.claim.id !== c.id && valuesConflict(prior.claim.value, c.value)) {
      result.conflictText = prior.claim.text;
      if (prior.claim.origin === 'player' && c.origin === 'player') {
        result.outcome = 'contradiction';
        w.rel[from].player.trust = clamp(w.rel[from].player.trust - 12);
        w.rel[to].player.trust = clamp(w.rel[to].player.trust - 12);
        for (const t of w.player.told) if (t.id === c.id || t.id === prior.claim.id) t.exposed = true;
        addMemory(w, {
          owner: to,
          type: 'caught',
          text: `${nameOf(from)} says the newcomer told them "${stripPlayer(c.text)}" — but the newcomer told me "${stripPlayer(prior.claim.text)}". They're playing us.`,
          spoken: `"I talked to ${nameOf(from)}. Apparently you told them ${toYou(c.text)}. You told me ${toYou(prior.claim.text)}. So which is it?"`,
          about: ['player', from],
          importance: 9,
        });
        addMemory(w, {
          owner: from,
          type: 'caught',
          text: `${listener.short} says the newcomer told them "${stripPlayer(prior.claim.text)}" — the opposite of what they told me. They're playing us.`,
          spoken: `"${listener.short} and I compared notes. You told them ${toYou(prior.claim.text)}, and me ${toYou(c.text)}. Interesting."`,
          about: ['player', to],
          importance: 9,
        });
        w.events.push({
          day: w.day,
          t: w.tick,
          kind: 'contradiction',
          text: `${nameOf(from)} and ${listener.short} compared notes: you told them opposite things ("${stripPlayer(c.text)}" vs "${stripPlayer(prior.claim.text)}").`,
          involved: ['player', from, to],
        });
        return result;
      }
      result.outcome = 'doubt';
      addMemory(w, {
        owner: to,
        type: 'heard',
        text: `${nameOf(from)} told me: ${c.text}. That doesn't match what I believed (${prior.claim.text}).`,
        about: [c.subject, from],
        importance: Math.max(5, c.importance - 1),
        source: from,
        chain: [...c.chain, from],
        claim: { ...c },
        confidence: 0.3,
      });
      return result;
    }
    if (prior && prior.claim.id === c.id) {
      result.outcome = 'known';
      return result;
    }

    const confidence = clamp(m.confidence * (w.rel[to][from].trust / 100) * (0.6 + listener.credulity * 0.4), 0.05, 1);
    result.confidence = confidence;
    addMemory(w, {
      owner: to,
      type: 'heard',
      text: c.origin === 'player' ? `${nameOf(from)} says the newcomer told them: ${stripPlayer(c.text)}` : `${nameOf(from)} told me: ${c.text}`,
      about: [c.subject, from, ...(c.origin === 'player' ? ['player'] : [])],
      importance: c.importance,
      source: from,
      chain: [...c.chain, from],
      claim: { ...c },
      confidence: +confidence.toFixed(2),
    });
    if (c.subject in NPC_BY_ID && c.subject !== to && c.sentiment !== 0) {
      const r = w.rel[to][c.subject];
      const shift = Math.round(15 * confidence * c.sentiment);
      r.trust = clamp(r.trust + shift);
      r.affinity = clamp(r.affinity + Math.round(shift / 2));
      result.shift = shift;
    }
    if (c.lie) {
      w.events.push({
        day: w.day,
        t: w.tick,
        kind: 'rumor',
        text: `${nameOf(from)} passed a falsehood to ${listener.short}: "${stripPlayer(c.text)}"${c.origin === 'player' ? ' — it started with you.' : ''}`,
        involved: [from, to, c.subject],
      });
    }
    return result;
  }

  async endDay() {
    const w = this.world;
    if (w.over) throw new HttpError(409, 'This story has ended.');
    if (w.day >= w.maxDays) throw new HttpError(409, 'It is the last night. Make your accusation.');
    w.tick++;

    const before = structuredClone(w.rel);
    const scenes = [];
    for (const [a, b] of this.#choosePairs()) {
      const results = [];
      const budget = (speaker, listener) => (w.rel[speaker][listener].trust >= 30 ? Math.max(1, Math.round(NPC_BY_ID[speaker].gossip * 3)) : NPC_BY_ID[speaker].gossip > 0.7 ? 1 : 0);
      for (const { m } of this.#candidates(a, b).slice(0, budget(a, b))) results.push(this.#transmit(a, b, m));
      for (const { m } of this.#candidates(b, a).slice(0, budget(b, a))) results.push(this.#transmit(b, a, m));
      scenes.push({ a, b, results });
    }

    // "B doesn't know why everyone distrusts them."
    const cold = [];
    for (const x of NPC_IDS) {
      const others = NPC_IDS.filter((y) => y !== x && w.rel[y][x].trust < before[y][x].trust);
      const drop = others.reduce((s, y) => s + (before[y][x].trust - w.rel[y][x].trust), 0);
      if (drop >= 6) {
        const aware = w.memories.some((m) => m.owner === x && m.claim?.subject === x && m.day === w.day && m.type === 'heard');
        addMemory(w, {
          owner: x,
          type: 'feeling',
          text: aware
            ? `People are talking about me — ${others.map(nameOf).join(' and ')} went cold.`
            : `${others.map(nameOf).join(' and ')} ${others.length > 1 ? 'were' : 'was'} colder to me tonight. I don't know what I did.`,
          about: others,
          importance: 7,
        });
        w.npcs[x].mood = 'uneasy';
        cold.push({ npc: x, from: others, drop });
        w.events.push({ day: w.day, t: w.tick, kind: 'coldness', text: `${nameOf(x)} noticed ${others.map(nameOf).join(' and ')} turning cold — and doesn't know why.`, involved: [x, ...others] });
      }
    }

    await Promise.all(scenes.map(async (s) => Object.assign(s, await gossipScene({ ...s, world: w }))));

    const faded = decay(w);
    const endedDay = w.day;
    w.gossip[endedDay] = { scenes, cold, faded: faded.map((m) => ({ id: m.id, owner: m.owner, text: m.text })) };

    w.day++;
    w.actionsLeft = w.actionsPerDay;
    const morning = MORNINGS[w.day];
    w.events.push({ day: w.day, t: w.tick, kind: 'morning', text: morning.text, involved: morning.to || [] });
    for (const id of morning.to || []) addMemory(w, { owner: id, type: 'observed', text: morning.memory, about: ['cafe', 'silas'], importance: morning.importance });
    if (morning.clue && !this.#hasClue(morning.clue.id)) w.player.clues.push({ ...morning.clue, day: w.day, from: 'world' });
    w.trustHistory.push({ day: w.day, trust: Object.fromEntries(NPC_IDS.map((id) => [id, w.rel[id].player.trust])) });

    this.save();
    return { night: w.gossip[endedDay], morning: morning.text, state: this.state() };
  }

  // ─── Final night ────────────────────────────────────────────────────────────

  async accuse(npcId) {
    const w = this.world;
    if (!NPC_BY_ID[npcId]) throw new HttpError(400, 'Unknown character.');
    if (w.over) throw new HttpError(409, 'This story has ended.');
    if (w.day < w.maxDays) throw new HttpError(409, 'You can only make your accusation on the last night.');

    const has = (id) => this.#hasClue(id);
    const trust = Object.fromEntries(NPC_IDS.map((id) => [id, w.rel[id].player.trust]));
    const allies = NPC_IDS.filter((id) => id !== npcId && trust[id] >= 60);
    let outcome;
    if (npcId === 'silas') {
      const proof = ['clue_napkin', 'clue_theo_confess', 'clue_silas_slip', 'clue_grey_coat'].filter(has).length;
      if (proof >= 3 || (has('clue_theo_confess') && has('clue_napkin'))) outcome = 'justice';
      else if (proof >= 1 && allies.length >= 2) outcome = 'pressure';
      else outcome = 'bluff';
    } else if (npcId === 'theo') {
      if (has('clue_theo_confess') && trust.theo >= 55) outcome = 'redemption';
      else if (has('clue_theo_confess') || has('clue_bike')) outcome = 'scapegoat';
      else outcome = 'denial';
    } else {
      outcome = npcId === 'ines' ? 'wrong_ines' : 'wrong_mara';
    }

    const stats = {
      lies: w.player.told.filter((t) => t.lie).length,
      claimsMade: w.player.told.length,
      contradictionsExposed: w.events.filter((e) => e.kind === 'contradiction').length,
      rumorHops: w.propagation.filter((p) => p.origin === 'player' && p.from !== 'player').length,
      cluesFound: w.player.clues.length,
      allies,
      enemies: NPC_IDS.filter((id) => trust[id] <= 30),
      fadedMemories: w.memories.filter((m) => m.faded).length,
    };
    const meta = OUTCOMES[outcome];
    const narrative = await endingNarrative({ outcome, accused: npcId, stats, trust, world: w, outcomeMeta: meta });

    w.over = true;
    w.ending = { accused: npcId, outcome, ...meta, narrative, stats, trust };
    w.events.push({ day: w.day, t: ++w.tick, kind: 'ending', text: `You accused ${nameOf(npcId)}. ${meta.title}.`, involved: ['player', npcId] });

    const reach = {};
    for (const p of w.propagation) if (p.origin === 'player' && p.from !== 'player') reach[p.claimId] = (reach[p.claimId] || 0) + 1;
    const run = {
      id: w.id,
      finishedAt: new Date().toISOString(),
      mode: llmStatus().mode,
      accused: npcId,
      outcome,
      title: meta.title,
      saved: meta.saved,
      stats,
      trust,
      clues: w.player.clues.map((c) => c.title),
      said: w.player.told.map((t) => ({ npc: t.npc, text: t.text, lie: t.lie, exposed: t.exposed, reach: reach[t.id] || 0 })),
      trustHistory: w.trustHistory.concat({ day: 'end', trust }),
      epilogue: narrative.epilogue,
    };
    this.runs = [run, ...this.runs.filter((r) => r.id !== run.id)].slice(0, 20);
    fs.writeFileSync(this.runsPath, JSON.stringify(this.runs, null, 2));
    this.save();
    return { ending: w.ending, state: this.state() };
  }
}
