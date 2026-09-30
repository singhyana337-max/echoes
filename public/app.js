// ECHOES client — renders the world state and the social-memory views.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (s) => esc(s).replace(/\*([^*]+)\*/g, '<em>*$1*</em>');
const pct = (n) => `${Math.round(n * 100)}%`;
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let S = null; // latest server state
const ui = {
  npc: store.get('echoes.npc', 'mara'),
  tab: store.get('echoes.tab', 'graph'),
  memNpc: 'mara',
  layers: { trust: true, rumors: true, lies: true },
  focus: '',
  knowsFilter: 'all',
  busy: false,
  director: store.get('echoes.director', true),
  lastRecalled: [],
};

const NPC = () => Object.fromEntries(S.cast.map((c) => [c.id, c]));
const nameOf = (id) => (id === 'player' ? 'You' : NPC()[id]?.short ?? (id === 'world' ? 'The café' : id));
const colorOf = (id) => (id === 'player' ? '#e7ae62' : NPC()[id]?.color ?? '#999');
const stripPlayer = (t) => String(t).replace(/^The player says (that )?/i, '');

// Each browser gets its own world on the server.
const SESSION = (() => {
  let id = store.get('echoes.session', null);
  if (!id) {
    id = crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    store.set('echoes.session', id);
  }
  return id;
})();

async function api(path, body) {
  const headers = { 'X-Echoes-Session': SESSION };
  const res = await fetch(path, body !== undefined ? { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 4000);
}

// Mirrors the server's contradiction logic for the notebook.
const POS_V = new Set(['yes', 'true', 'likes', 'loves', 'like', 'love']);
const NEG_V = new Set(['no', 'false', 'dislikes', 'hates', 'dislike', 'hate']);
const norm = (v) => String(v ?? '').toLowerCase().replace(/[.!?"'\s]+/g, '');
const pol = (v) => (POS_V.has(norm(v)) ? 1 : NEG_V.has(norm(v)) ? -1 : 0);
const conflict = (a, b) => (pol(a) && pol(b) ? pol(a) !== pol(b) : norm(a) !== norm(b));

// ─── Render ──────────────────────────────────────────────────────────────────

function render() {
  if (!S) return;
  renderHeader();
  renderCast();
  renderChat();
  renderTabs();
}

function renderHeader() {
  const w = S.world;
  $('#nights').innerHTML = Array.from({ length: w.maxDays }, (_, i) => {
    const d = i + 1;
    const cls = d < w.day || w.over ? 'done' : d === w.day ? 'now' : '';
    return `<span class="night-pip ${cls}">Night ${d}</span>`;
  }).join('');
  $('#actions').innerHTML = Array.from({ length: w.actionsPerDay }, (_, i) => `<i class="candle ${i < w.actionsLeft && !w.over ? '' : 'out'}"></i>`).join('');
  $('#perDay').textContent = w.actionsPerDay;
  const b = $('#brain');
  b.className = `brain ${S.llm.mode === 'nemotron' ? 'on' : 'off'}`;
  b.textContent = S.llm.mode === 'nemotron' ? `● Nemotron · ${S.llm.model.split('/').pop()}` : '● Offline brain';
  b.title = S.llm.mode === 'nemotron'
    ? `LLM calls: ${S.llm.calls}, failures: ${S.llm.failures}${S.llm.lastError ? `\nLast error: ${S.llm.lastError}` : ''}`
    : 'No NVIDIA_API_KEY set — using the deterministic rule-based brain. Add a key to .env and restart for Nemotron.';
  const adv = $('#advance');
  adv.disabled = ui.busy;
  adv.textContent = w.over ? 'See ending' : w.day < w.maxDays ? `End night ${w.day} →` : 'Make your accusation';
  adv.className = `btn ${w.day >= w.maxDays && !w.over ? 'danger' : 'primary'}`;
  $('#director').checked = ui.director;
}

function trustColor(t) {
  return t >= 65 ? 'var(--green)' : t <= 35 ? 'var(--red)' : 'var(--amber)';
}

function renderCast() {
  const w = S.world;
  const morning = [...w.events].reverse().find((e) => e.kind === 'morning');
  $('#morning').textContent = morning?.text ?? '';
  $('#castList').innerHTML = S.cast
    .map((c) => {
      const rel = w.rel[c.id].player;
      const heard = w.memories.filter((m) => m.owner === c.id && m.type === 'heard' && m.claim?.origin === 'player' && !m.faded).length;
      const caught = w.memories.filter((m) => m.owner === c.id && m.type === 'caught').length;
      const cold = w.memories.some((m) => m.owner === c.id && m.type === 'feeling' && m.day === w.day - 1);
      return `<button class="npc-card ${ui.npc === c.id ? 'active' : ''}" data-npc="${c.id}" style="--c:${c.color}">
        <div class="avatar">${c.avatar}</div>
        <div>
          <div class="npc-name">${esc(c.short)} <span class="mood">${esc(w.npcs[c.id].mood)}</span></div>
          <div class="npc-role">${esc(c.role)}</div>
          <div class="meter"><i style="width:${rel.trust}%;background:${trustColor(rel.trust)}"></i></div>
          <div class="meter-label"><span>trusts you</span><span>${rel.trust}</span></div>
          <div class="badges">
            ${heard ? `<span class="badge warn" title="Things you said that reached ${esc(c.short)} second-hand">👂 heard ${heard} of your words</span>` : ''}
            ${caught ? `<span class="badge bad" title="Contradictions or lies ${esc(c.short)} caught">⚡ caught you ×${caught}</span>` : ''}
            ${cold ? `<span class="badge" title="Others turned cold overnight">🥶 feels shunned</span>` : ''}
          </div>
        </div>
      </button>`;
    })
    .join('');
}

const SUGGESTIONS = {
  mara: [['What happened to the ledger?'], ['Why does the ledger matter so much?'], ['Who do you suspect?'], ['Is the café doing okay? You seem worried.'], ['I love coffee.'], ['Ines took the ledger.', true]],
  theo: [['Where were you the night it went missing?'], ['Does Silas ever talk to you about work?'], ['What are your plans for the future?'], ['Ines saw your bike outside at midnight.'], ["I promise I won't tell Mara."], ['Silas is a liar.']],
  ines: [['Did you see anything that night?'], ['Did you see anyone else in the alley?'], ['What are you writing about?'], ['I hate coffee.'], ['Theo stole my notebook.', true], ['Mara is hiding something.']],
  silas: [['Where were you after closing?'], ['Who do you think took it?'], ['Did you offer Theo a job?'], ['I found a napkin signed S.C.'], ['Mara stole the ledger herself.', true], ['I work for the city council.']],
};

function renderChat() {
  const w = S.world;
  const c = NPC()[ui.npc];
  $('#chatHeader').innerHTML = `<div class="avatar" style="--c:${c.color}">${c.avatar}</div>
    <div><h3>${esc(c.name)}</h3><p>${esc(c.role)} · ${esc(c.voice)}</p></div>`;
  const lines = w.dialogue[ui.npc];
  const log = $('#chatLog');
  if (!lines.length) {
    log.innerHTML = `<p class="empty">${esc(c.short)} hasn't met you yet. Whatever you say — true or not — ${esc(c.short)} will remember, and may repeat it to the others after closing.</p>`;
  } else {
    let day = 0;
    const memById = Object.fromEntries(w.memories.map((m) => [m.id, m]));
    log.innerHTML = lines
      .map((l) => {
        let html = '';
        if (l.day !== day) {
          day = l.day;
          html += `<div class="day-divider">Night ${day}</div>`;
        }
        if (l.from === 'player') return `${html}<div class="bubble player">${esc(l.text)}</div>`;
        html += `<div class="bubble npc" style="--c:${c.color}">${fmt(l.text)}
          <div class="bubble-meta"><span class="emo">${esc(l.emotion)}</span><span>${l.source === 'nemotron' ? 'Nemotron' : 'offline brain'}</span></div></div>`;
        const notes = (l.notes || []).filter((n) => n.kind !== 'memory' || ui.director);
        if (notes.length) {
          const icon = { clue: '📓', caught: '⚡', 'trust-up': '▲', 'trust-down': '▼', influence: '↯', memory: '🧠', doubt: '？' };
          html += `<div class="notes">${notes.map((n) => `<div class="note ${n.kind}"><span>${icon[n.kind] || '•'}</span><span>${esc(n.text)}</span></div>`).join('')}</div>`;
        }
        if (l.recalled?.length && ui.director) {
          const rec = l.recalled.map((id) => memById[id]).filter(Boolean);
          html += `<details class="recall"><summary>🔎 recalled ${rec.length} memories to answer</summary><ul>${rec.map((m) => `<li>${esc(m.text)}</li>`).join('')}</ul></details>`;
        }
        return html;
      })
      .join('');
  }
  if (ui.busy === 'talk') log.insertAdjacentHTML('beforeend', `<div class="typing">${esc(c.short)} is remembering</div>`);
  log.scrollTop = log.scrollHeight;

  const disabled = !!ui.busy || w.over || w.actionsLeft <= 0;
  $('#chatInput').disabled = disabled;
  $('#sendBtn').disabled = disabled;
  $('#chatInput').placeholder = w.over
    ? 'The story has ended.'
    : w.actionsLeft <= 0
      ? 'The café is closing — end the night.'
      : `Say something to ${c.short}… (truth or lies — they'll remember)`;
  $('#chips').innerHTML = disabled
    ? ''
    : SUGGESTIONS[ui.npc]
        .map(([t, lie]) => `<button class="chip ${lie && ui.director ? 'lie' : ''}" data-say="${esc(t)}" ${lie && ui.director ? 'title="This is a lie"' : ''}>${esc(t)}</button>`)
        .join('');
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

const TABS = [
  ['graph', 'Social graph'],
  ['knows', 'Who knows what'],
  ['memories', 'Memories'],
  ['notebook', 'Notebook'],
  ['timeline', 'Timeline'],
  ['runs', 'Playthroughs'],
];

function renderTabs() {
  const counts = { notebook: S.world.player.clues.length, runs: S.runs.length };
  $('#tabs').innerHTML = TABS.map(([id, label]) => `<button class="tab ${ui.tab === id ? 'active' : ''}" data-tab="${id}">${label}${counts[id] ? `<span class="count">${counts[id]}</span>` : ''}</button>`).join('');
  const body = $('#tabBody');
  const scroll = body.scrollTop;
  body.innerHTML = { graph: graphView, knows: knowsView, memories: memoriesView, notebook: notebookView, timeline: timelineView, runs: runsView }[ui.tab]();
  body.scrollTop = scroll;
}

// Social graph ────────────────────────────────────────────────────────────────

const POS = { player: [300, 228], mara: [92, 82], theo: [508, 82], ines: [92, 374], silas: [508, 374] };
const DIAG = new Set(['mara-silas', 'silas-mara', 'theo-ines', 'ines-theo']);
const COLORS = { green: '#86c29b', red: '#e07f7f', gray: '#5b546a', blue: '#82b4ea', violet: '#b59ce0', orange: '#f09a4f', amber: '#e7ae62' };

function toward([x, y], [tx, ty], r) {
  const d = Math.hypot(tx - x, ty - y) || 1;
  return [x + ((tx - x) / d) * r, y + ((ty - y) / d) * r];
}

function curve(a, b, bend) {
  const p = POS[a];
  const q = POS[b];
  const [dx, dy] = [q[0] - p[0], q[1] - p[1]];
  const len = Math.hypot(dx, dy);
  const c = [(p[0] + q[0]) / 2 + (-dy / len) * bend, (p[1] + q[1]) / 2 + (dx / len) * bend];
  const s = toward(p, c, 34);
  const e = toward(q, c, 40);
  return { d: `M${s[0].toFixed(1)},${s[1].toFixed(1)} Q${c[0].toFixed(1)},${c[1].toFixed(1)} ${e[0].toFixed(1)},${e[1].toFixed(1)}`, lx: 0.25 * s[0] + 0.5 * c[0] + 0.25 * e[0], ly: 0.25 * s[1] + 0.5 * c[1] + 0.25 * e[1] };
}

function edge(a, b, { bend = 22, color = 'gray', width = 1.6, dash = false, flow = false, label = '', opacity = 1, title = '' }) {
  const k = curve(a, b, DIAG.has(`${a}-${b}`) ? bend * 3 : bend);
  return `<g opacity="${opacity}">${title ? `<title>${esc(title)}</title>` : ''}
    <path class="edge ${flow ? 'flow' : ''}" d="${k.d}" stroke="${COLORS[color]}" stroke-width="${width}" ${dash && !flow ? 'stroke-dasharray="5 4"' : ''} marker-end="url(#ah-${color})"/>
    ${label ? `<text class="edge-label" x="${k.lx.toFixed(1)}" y="${k.ly.toFixed(1)}" text-anchor="middle" dominant-baseline="central">${esc(label)}</text>` : ''}</g>`;
}

function claimGroups() {
  const groups = new Map();
  for (const p of S.world.propagation) {
    if (!groups.has(p.claimId)) groups.set(p.claimId, { id: p.claimId, text: p.text, origin: p.origin, lie: p.lie, hops: [] });
    groups.get(p.claimId).hops.push(p);
  }
  return [...groups.values()].sort((a, b) => (b.origin === 'player') - (a.origin === 'player') || b.hops.length - a.hops.length);
}

function graphView() {
  const w = S.world;
  const ids = S.cast.map((c) => c.id);
  const parts = [];
  const groups = claimGroups();
  const focus = ui.focus && groups.find((g) => g.id === ui.focus);

  if (focus) {
    focus.hops
      .slice()
      .sort((a, b) => a.t - b.t)
      .forEach((h, i) => {
        const k = curve(h.from, h.to, DIAG.has(`${h.from}-${h.to}`) ? 66 : 22);
        parts.push(`<g><path class="edge flow" d="${k.d}" stroke="${COLORS[focus.lie && ui.director ? 'orange' : 'amber']}" stroke-width="2.4" marker-end="url(#ah-${focus.lie && ui.director ? 'orange' : 'amber'})"/>
          <circle cx="${k.lx}" cy="${k.ly}" r="9" fill="${COLORS.amber}"/><text class="step" x="${k.lx}" y="${k.ly}">${i + 1}</text></g>`);
      });
  } else {
    if (ui.layers.trust) {
      for (const a of ids) {
        for (const b of [...ids, 'player']) {
          if (a === b) continue;
          const t = w.rel[a][b].trust;
          const strong = t >= 65 || t <= 35;
          const color = t >= 65 ? 'green' : t <= 35 ? 'red' : 'gray';
          const label = b === 'player' ? `${t >= 65 ? 'trusts' : t <= 35 ? 'distrusts' : 'unsure'} ${t}` : strong ? `${t >= 65 ? 'trusts' : 'distrusts'} ${t}` : '';
          parts.push(edge(a, b, { color, width: 1 + t / 45, label, opacity: strong || b === 'player' ? 0.95 : 0.35, title: `${nameOf(a)} → ${nameOf(b)}: trust ${t}` }));
        }
      }
    }
    if (ui.layers.rumors) {
      const agg = new Map();
      for (const p of w.propagation) {
        if (p.to === 'player') continue;
        const key = `${p.from}>${p.to}`;
        if (!agg.has(key)) agg.set(key, { from: p.from, to: p.to, items: [], lies: 0 });
        const g = agg.get(key);
        g.items.push(p.text);
        if (p.lie) g.lies++;
      }
      for (const g of agg.values()) {
        const fromYou = g.from === 'player';
        const liesShown = ui.layers.lies && ui.director && g.lies;
        parts.push(edge(g.from, g.to, {
          bend: fromYou ? -26 : 48,
          color: liesShown ? 'orange' : fromYou ? 'blue' : 'violet',
          width: 1.4 + Math.min(g.items.length, 5) * 0.5,
          flow: !fromYou,
          dash: true,
          label: fromYou ? `${liesShown ? `lied ×${g.lies}, ` : ''}told ${g.items.length}` : `${liesShown ? 'spread lie' : 'retold'} ${g.items.length}`,
          title: g.items.map((t) => `• ${stripPlayer(t)}`).join('\n'),
        }));
      }
    }
  }

  const knowers = focus ? new Set(focus.hops.flatMap((h) => [h.from, h.to])) : null;
  const nodes = ['player', ...ids]
    .map((id) => {
      const [x, y] = POS[id];
      const c = colorOf(id);
      const dim = knowers && !knowers.has(id) ? 0.35 : 1;
      const avatar = id === 'player' ? '★' : NPC()[id].avatar;
      const sub = id === 'player' ? `${w.player.told.length} things said` : w.npcs[id].mood;
      return `<g opacity="${dim}">
        <circle cx="${x}" cy="${y}" r="30" fill="${c}" fill-opacity="0.16" stroke="${c}" stroke-width="${id === 'player' ? 2.5 : 1.5}"/>
        <text x="${x}" y="${y + 1}" text-anchor="middle" dominant-baseline="central" font-size="${id === 'player' ? 22 : 24}" fill="${c}">${avatar}</text>
        <text class="node-name" x="${x}" y="${y + 47}">${esc(nameOf(id))}</text>
        <text class="node-sub" x="${x}" y="${y + 61}">${esc(sub)}</text></g>`;
    })
    .join('');

  const markers = Object.entries(COLORS)
    .map(([k, v]) => `<marker id="ah-${k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="${v}"/></marker>`)
    .join('');

  const caption = focus
    ? `<div class="path-caption"><b>${focus.origin === 'player' ? 'You said' : `${esc(nameOf(focus.origin))} said`}:</b> “${esc(stripPlayer(focus.text))}”
        ${focus.lie && ui.director ? '<span class="tag lie">LIE</span>' : ''}<br/>
        ${focus.hops.slice().sort((a, b) => a.t - b.t).map((h, i) => `<span class="hop">${i + 1}.</span> ${esc(nameOf(h.from))} → ${esc(nameOf(h.to))} <span style="color:var(--faint)">(night ${h.day})</span>`).join(' &nbsp; ')}</div>`
    : '';

  return `<div class="row" style="justify-content:space-between">
      <div class="seg">
        ${['trust', 'rumors', 'lies'].map((l) => `<button class="${ui.layers[l] ? 'on' : ''}" data-layer="${l}" ${l === 'lies' && !ui.director ? 'disabled title="Enable Director view"' : ''}>${{ trust: 'Trust', rumors: 'Who told whom', lies: 'Lies' }[l]}</button>`).join('')}
      </div>
      <select class="select" id="focusSelect">
        <option value="">Trace a piece of information…</option>
        ${groups.map((g) => `<option value="${esc(g.id)}" ${g.id === ui.focus ? 'selected' : ''}>${g.origin === 'player' ? 'You' : esc(nameOf(g.origin))}: ${esc(stripPlayer(g.text).slice(0, 55))} (${g.hops.length} hop${g.hops.length > 1 ? 's' : ''})</option>`).join('')}
      </select>
    </div>
    <div class="graph-wrap"><svg class="graph" viewBox="0 0 600 460" role="img" aria-label="Social graph"><defs>${markers}</defs>${parts.join('')}${nodes}</svg></div>
    ${caption}
    <div class="legend">
      <span><i style="border-color:${COLORS.green}"></i>trusts</span>
      <span><i style="border-color:${COLORS.red}"></i>distrusts</span>
      <span><i class="dash" style="border-color:${COLORS.blue}"></i>you told</span>
      <span><i class="dash" style="border-color:${COLORS.violet}"></i>retold behind your back</span>
      ${ui.director ? `<span><i class="dash" style="border-color:${COLORS.orange}"></i>lie travelling</span>` : ''}
    </div>
    <p class="sub" style="margin-top:10px">Hover an edge to see exactly what was said. Pick an item above to trace how it moved through the café.</p>`;
}

// Who knows what ──────────────────────────────────────────────────────────────

function knowsView() {
  const w = S.world;
  const ids = S.cast.map((c) => c.id);
  const rows = new Map();
  for (const m of w.memories) {
    if (!m.claim) continue;
    if (!rows.has(m.claim.id)) rows.set(m.claim.id, { claim: m.claim, holders: {} });
    const r = rows.get(m.claim.id);
    const prev = r.holders[m.owner];
    if (!prev || (prev.faded && !m.faded)) r.holders[m.owner] = m;
  }
  const toPlayer = new Set(w.propagation.filter((p) => p.to === 'player').map((p) => p.claimId));
  let list = [...rows.values()];
  if (ui.knowsFilter === 'you') list = list.filter((r) => r.claim.origin === 'player');
  if (ui.knowsFilter === 'lies') list = list.filter((r) => r.claim.lie);
  list.sort((a, b) => (b.claim.origin === 'player') - (a.claim.origin === 'player') || Object.keys(b.holders).length - Object.keys(a.holders).length);

  const cell = (r, id) => {
    const m = r.holders[id];
    if (!m) return '';
    if (m.faded) return `<span class="dot faded" title="${esc(nameOf(id))} has forgotten this"></span>`;
    if (r.claim.origin === id) return `<span class="dot origin" title="${esc(nameOf(id))} knows this first-hand"></span>`;
    if (m.type === 'heard') {
      const chain = m.chain.map(nameOf).reverse().join(' ← ');
      return `<span class="dot heard" title="Heard via ${esc(chain)} — ${pct(m.confidence)} sure"></span>`;
    }
    return `<span class="dot direct" title="${esc(nameOf(id))} heard it straight from ${esc(nameOf(m.source))} — ${pct(m.confidence)} sure"></span>`;
  };

  return `<div class="section-title">Who knows what</div>
    <p class="sub">The world doesn't just remember what happened — it remembers <i>who knows what</i>, and from whom they heard it.</p>
    <div class="row" style="margin-bottom:10px">
      <div class="seg">${[['all', 'Everything'], ['you', 'Things you said'], ...(ui.director ? [['lies', 'Lies']] : [])].map(([k, l]) => `<button class="${ui.knowsFilter === k ? 'on' : ''}" data-knows="${k}">${l}</button>`).join('')}</div>
    </div>
    <div class="scroll-x"><table class="matrix">
      <thead><tr><th style="text-align:left">Information</th>${ids.map((id) => `<th>${esc(nameOf(id))}</th>`).join('')}<th>You</th></tr></thead>
      <tbody>${list
        .map((r) => {
          const you = r.claim.origin === 'player' || toPlayer.has(r.claim.id);
          const exposed = r.claim.origin === 'player' && w.player.told.find((t) => t.id === r.claim.id)?.exposed;
          return `<tr><td>${esc(stripPlayer(r.claim.text))}
            ${r.claim.origin === 'player' ? '<span class="tag you">you said</span>' : ''}
            ${r.claim.lie && ui.director ? '<span class="tag lie">lie</span>' : ''}
            ${exposed ? '<span class="tag caught">caught</span>' : ''}</td>
            ${ids.map((id) => `<td class="cell">${cell(r, id)}</td>`).join('')}
            <td class="cell">${you ? '<span class="dot direct" title="You know this"></span>' : ''}</td></tr>`;
        })
        .join('') || `<tr><td colspan="6" class="sub">Nothing yet.</td></tr>`}</tbody>
    </table></div>
    <div class="legend"><span><span class="dot origin"></span> first-hand</span><span><span class="dot direct"></span> told directly</span><span><span class="dot heard"></span> heard second-hand</span><span><span class="dot faded"></span> forgotten</span></div>`;
}

// Memories ────────────────────────────────────────────────────────────────────

const MEM_ICON = { core: '🕯', knowledge: '📌', told: '💬', heard: '👂', conversation: '🗨', shared: '📤', gossiped: '🗣', caught: '⚡', observed: '👁', feeling: '💭' };

function memoriesView() {
  const w = S.world;
  const c = NPC()[ui.memNpc];
  const last = [...w.dialogue[ui.memNpc]].reverse().find((l) => l.from === 'npc');
  const recalled = new Set(last?.recalled || []);
  const mems = w.memories
    .filter((m) => m.owner === ui.memNpc && (ui.director || !m.secret))
    .sort((a, b) => (a.type === 'core') - (b.type === 'core') || b.t - a.t || b.importance - a.importance);
  const faded = mems.filter((m) => m.faded).length;
  const rel = w.rel[ui.memNpc].player.trust;

  const gates = ui.director
    ? `<div class="section-title">Knowledge & secrets <span class="tag secret">director</span></div>
       <p class="sub">What ${esc(c.short)} will share depends on how much they trust you (now ${rel}).</p>
       ${c.knowledge
         .map((k) => {
           const shared = w.npcs[c.id].revealed.includes(k.id);
           const open = rel >= k.effectiveGate;
           const status = shared ? '<b style="color:var(--green)">✓ told you</b>' : open ? '<b style="color:var(--amber)">● would share</b>' : `<b style="color:var(--faint)">🔒 needs ${k.effectiveGate}</b>`;
           const unlock = k.unlock && k.effectiveGate === k.gate ? `<div class="sub" style="margin:2px 0 0">Drops to ${k.unlock.gate} if you hold ${k.unlock.mode === 'all' ? 'all of' : 'any of'}: ${k.unlock.clues.map((id) => id.replace('clue_', '').replace(/_/g, ' ')).join(', ')}</div>` : '';
           return `<div class="gate">${status}<div>${esc(k.text)}${unlock}</div></div>`;
         })
         .join('')}
       <div class="gate"><b style="color:var(--violet)">Private truth</b><div>${esc(c.privateTruth)}</div></div>`
    : '';

  return `<div class="pills">${S.cast.map((n) => `<button class="pill ${ui.memNpc === n.id ? 'on' : ''}" style="--c:${n.color}" data-mem="${n.id}">${n.avatar} ${esc(n.short)}</button>`).join('')}</div>
    <div class="section-title" style="margin-top:14px">${esc(c.short)}'s memory</div>
    <p class="sub">${mems.length} memories · ${faded} forgotten · ${recalled.size} recalled for the last reply (highlighted). Recall = keyword overlap + who it's about + importance × strength + recency. Unimportant memories fade each night unless recalled.</p>
    ${mems
      .map((m) => {
        const via = m.type === 'heard' ? ` · via ${m.chain.filter((x) => x !== m.owner).map(nameOf).reverse().join(' ← ')}` : m.type === 'told' ? ' · from you' : '';
        return `<div class="mem ${m.faded ? 'faded' : ''} ${recalled.has(m.id) ? 'recalled' : ''}">
          <div class="mem-head"><span class="mem-type">${MEM_ICON[m.type] || '•'} ${m.type} · night ${m.day}${esc(via)}</span>
            <span>${m.secret ? '<span class="tag secret">secret</span>' : ''}${m.claim && m.type !== 'knowledge' ? ` believes ${pct(m.confidence)} ·` : ''} importance ${m.importance}${m.faded ? ' · forgotten' : ''}</span></div>
          <div class="mem-text">${esc(m.text)}${m.claim?.lie && ui.director ? ' <span class="tag lie">false</span>' : ''}</div>
          <div class="strength" title="Memory strength ${pct(m.strength)}"><i style="width:${m.strength * 100}%"></i></div>
        </div>`;
      })
      .join('')}
    ${gates}`;
}

// Notebook ────────────────────────────────────────────────────────────────────

function notebookView() {
  const w = S.world;
  const clues = w.player.clues;
  const clueHtml = clues
    .map((c) => {
      const others = c.claim ? clues.filter((o) => o !== c && o.claim && o.claim.subject === c.claim.subject && o.claim.topic === c.claim.topic && conflict(o.claim.value, c.claim.value)) : [];
      return `<div class="clue"><h4>${esc(c.title)}</h4><p>${esc(c.text)}</p>
        <p class="sub" style="margin:4px 0 0">Night ${c.day} · from ${esc(nameOf(c.from))}</p>
        ${others.map((o) => `<div class="conflict">⚡ Contradicts: ${esc(o.title)}</div>`).join('')}</div>`;
    })
    .join('');

  const reach = {};
  for (const p of w.propagation) if (p.origin === 'player' && p.from !== 'player') reach[p.claimId] = (reach[p.claimId] || 0) + 1;
  const byKey = new Map();
  for (const t of w.player.told) {
    const k = `${t.subject}|${t.topic}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  const told = [...byKey.values()]
    .map((items) => {
      const inconsistent = items.some((a) => items.some((b) => conflict(a.value, b.value)));
      return items
        .map((t) => `<div class="said"><div>“${esc(stripPlayer(t.text))}”
            ${t.lie && ui.director ? '<span class="tag lie">lie</span>' : ''}
            ${t.exposed ? '<span class="tag caught">caught</span>' : inconsistent ? '<span class="tag lie">inconsistent</span>' : ''}
            <div class="who">to ${esc(nameOf(t.npc))} · night ${t.day}${reach[t.id] ? ` · repeated ${reach[t.id]}× behind your back` : ''}</div></div>
            <div style="color:${colorOf(t.npc)}">${NPC()[t.npc].avatar}</div></div>`)
        .join('');
    })
    .join('');

  return `<div class="section-title">Clues</div>
    ${clueHtml || '<p class="sub">Ask questions. People share more as they trust you more.</p>'}
    <div class="section-title">What you've told people</div>
    <p class="sub">Your side of the world memory. Tell different people different things and see if it holds.</p>
    ${told || '<p class="sub">You haven\'t claimed anything yet.</p>'}`;
}

// Timeline ────────────────────────────────────────────────────────────────────

const EVENT_ICON = { morning: '🌙', reveal: '📓', lie: '🎭', caught: '⚡', contradiction: '⚡', rumor: '🗣', coldness: '🥶', ending: '🏁' };

function timelineView() {
  const w = S.world;
  const days = [...new Set(w.events.map((e) => e.day))].sort((a, b) => b - a);
  return days
    .map((d) => {
      const evs = w.events.filter((e) => e.day === d && (ui.director || e.kind !== 'lie')).sort((a, b) => b.t - a.t);
      const replay = w.gossip[d] ? `<button class="btn small" data-replay="${d}">Replay night ${d} gossip</button>` : '';
      return `<div class="row" style="justify-content:space-between"><div class="section-title">Night ${d}</div>${replay}</div>
        ${evs.map((e) => `<div class="event ${e.kind}"><span class="ico">${EVENT_ICON[e.kind] || '•'}</span><span>${esc(e.text)}</span></div>`).join('')}`;
    })
    .join('');
}

// Playthroughs ────────────────────────────────────────────────────────────────

function runsView() {
  const runs = S.runs.slice(0, 6);
  if (!runs.length) {
    return `<div class="section-title">Playthroughs</div>
      <p class="sub">Finish a playthrough, then play again and make different choices: trust someone else, tell a lie, keep a secret. Every run's world state is recorded here side by side.</p>
      <p class="empty" style="margin-top:40px">“We didn't write ten endings. The world generated them from what you said, to whom, and who repeated it.”</p>`;
  }
  const ids = S.cast.map((c) => c.id);
  const col = (fn) => runs.map((r) => `<td>${fn(r)}</td>`).join('');
  const top = (r) => {
    const s = [...r.said].sort((a, b) => b.reach - a.reach)[0];
    return s && s.reach ? `“${esc(stripPlayer(s.text))}” <span class="sub">(${s.reach}×)</span>` : '<span class="sub">—</span>';
  };
  return `<div class="row" style="justify-content:space-between"><div class="section-title">Same café. Different worlds.</div><button class="btn small ghost" id="clearRuns">Clear history</button></div>
    <p class="sub">Each ending came from world state — not a script.</p>
    <div class="scroll-x"><table class="cmp">
      <tr><th></th>${runs.map((r, i) => `<th>Run ${S.runs.length - i}</th>`).join('')}</tr>
      <tr><th>Ending</th>${col((r) => `<span class="outcome ${r.saved ? 'saved' : 'lost'}">${esc(r.title)}</span>`)}</tr>
      <tr><th>Café</th>${col((r) => (r.saved ? '<span class="saved">saved</span>' : '<span class="lost">lost</span>'))}</tr>
      <tr><th>Accused</th>${col((r) => esc(nameOf(r.accused)))}</tr>
      <tr><th>Lies told</th>${col((r) => r.stats.lies)}</tr>
      <tr><th>Caught contradicting</th>${col((r) => r.stats.contradictionsExposed)}</tr>
      <tr><th>Words retold</th>${col((r) => r.stats.rumorHops)}</tr>
      <tr><th>Clues</th>${col((r) => r.stats.cluesFound)}</tr>
      ${ids.map((id) => `<tr><th>${esc(nameOf(id))}'s trust</th>${col((r) => `<div class="meter" style="width:80px"><i style="width:${r.trust[id]}%;background:${trustColor(r.trust[id])}"></i></div><span class="sub">${r.trust[id]}</span>`)}</tr>`).join('')}
      <tr><th>Most repeated</th>${col(top)}</tr>
      <tr><th>Brain</th>${col((r) => (r.mode === 'nemotron' ? 'Nemotron' : 'offline'))}</tr>
    </table></div>
    ${runs.map((r, i) => `<div class="clue" style="margin-top:12px;border-color:${r.saved ? 'var(--green)' : 'var(--red)'}"><h4>Run ${S.runs.length - i}: ${esc(r.title)}</h4><p>${esc(r.epilogue)}</p></div>`).join('')}`;
}

// ─── Modals ──────────────────────────────────────────────────────────────────

function openModal(html) {
  $('#modalCard').innerHTML = html;
  $('#modal').hidden = false;
  $('#modalCard').scrollTop = 0;
}
function closeModal() {
  $('#modal').hidden = true;
}

function showIntro() {
  const offline = S.llm.mode !== 'nemotron';
  openModal(`<div class="kicker">A world that remembers you</div>
    <h2>Moonlight's Midnight Café</h2>
    <p>Two nights ago, the <b>Midnight Ledger</b> vanished from a locked drawer: Mara's grandmother's recipe book, with the café's original handwritten lease inside. Without it, the café is evicted at midnight on the third night.</p>
    <ol class="steps">
      <li><span><b>Talk.</b> Four people, eight conversations a night. Say anything: questions, confessions, lies.</span></li>
      <li><span><b>They remember, and they talk.</b> After closing, the characters gossip. What you told one of them travels. If you told two people different stories, they'll compare notes.</span></li>
      <li><span><b>Accuse.</b> On the third night, name who took the ledger. The ending comes from who trusts you, what you learned, and what you set in motion.</span></li>
    </ol>
    <p class="sub"><b>Director view</b> (top right) shows the machinery: lies, secrets, memory recall and forgetting. Turn it off to play blind.</p>
    ${offline ? '<p class="sub">Running on the <b>offline brain</b>. Add <code>NVIDIA_API_KEY</code> to <code>.env</code> and restart to let Nemotron voice the characters.</p>' : `<p class="sub">Characters are voiced by <b>${esc(S.llm.model)}</b>.</p>`}
    <div class="modal-actions"><button class="btn primary" data-close>Enter the café</button></div>`);
  store.set('echoes.introSeen', true);
}

function sceneHtml(s) {
  const results = s.results
    .map((r) => {
      const t = stripPlayer(r.claim.text);
      if (r.outcome === 'contradiction') return `<div class="result contradiction">⚡ ${esc(nameOf(r.from))} and ${esc(nameOf(r.to))} realise you told them opposite things. Both trust you less.</div>`;
      if (r.outcome === 'doubt') return `<div class="result">？ ${esc(nameOf(r.to))} doubts “${esc(t)}” — it clashes with what they believed.</div>`;
      if (r.outcome === 'known') return `<div class="result">${esc(nameOf(r.to))} already knew.</div>`;
      const shift = r.shift ? ` · trust in ${esc(nameOf(r.claim.subject))} ${r.shift > 0 ? '+' : ''}${r.shift}` : '';
      return `<div class="result adopted">↯ ${esc(nameOf(r.to))} now believes “${esc(t)}” (${pct(r.confidence)})${r.claim.origin === 'player' ? ' — <b>you said this</b>' : ''}${r.claim.lie && ui.director ? ' <span class="tag lie">lie</span>' : ''}${shift}</div>`;
    })
    .join('');
  return `<h2 style="font-size:21px">${esc(s.title)}</h2>
    ${s.lines.map((l, i) => `<div class="scene-line" style="--c:${colorOf(l.speaker)};animation-delay:${i * 0.12}s"><div class="avatar">${NPC()[l.speaker]?.avatar ?? '•'}</div><div><b>${esc(nameOf(l.speaker))}</b><div>${fmt(l.text)}</div></div></div>`).join('')}
    ${results ? `<div class="results">${results}</div>` : ''}`;
}

function showNight(night, day, morning) {
  const pages = night.scenes.map((s, i) => `<div class="kicker">Night ${day} · after closing · ${i + 1} of ${night.scenes.length}</div>${sceneHtml(s)}`);
  const cold = night.cold.map((c) => `<div class="result">🥶 ${esc(nameOf(c.npc))} felt ${c.from.map(nameOf).join(' and ')} turn cold — and doesn't know why.</div>`).join('');
  const faded = night.faded.length
    ? `<div class="result">🌫 ${night.faded.length} unimportant memor${night.faded.length > 1 ? 'ies' : 'y'} faded overnight${ui.director ? `: ${night.faded.slice(0, 3).map((f) => `${esc(nameOf(f.owner))} forgot “${esc(f.text.slice(0, 50))}”`).join('; ')}` : ''}.</div>`
    : '';
  if (morning) {
    pages.push(`<div class="kicker">While you were gone</div><h2 style="font-size:21px">Morning comes</h2>
      ${cold || faded ? `<div class="results" style="border:none;padding:0">${cold}${faded}</div>` : ''}
      <p style="font-family:var(--serif);font-style:italic;margin-top:16px">${esc(morning)}</p>`);
  }
  let i = 0;
  const draw = () =>
    openModal(`${pages[i]}<div class="modal-actions">
      ${i > 0 ? '<button class="btn ghost" data-prev>Back</button>' : ''}
      ${i < pages.length - 1 ? '<button class="btn primary" data-next>Next</button>' : `<button class="btn primary" data-close>${morning ? `Begin night ${day + 1}` : 'Close'}</button>`}</div>`);
  showNight.nav = (d) => {
    i = Math.max(0, Math.min(pages.length - 1, i + d));
    draw();
  };
  draw();
}

function showAccuse() {
  openModal(`<div class="kicker">The last night · the hearing is at midnight</div>
    <h2>Who took the Midnight Ledger?</h2>
    <p>Name them in front of everyone. Whoever trusts you will back you up; whatever you've learned is your evidence. This ends the story.</p>
    <div class="suspects">${S.cast.map((c) => `<button class="suspect" data-accuse="${c.id}" style="--c:${c.color}"><div class="avatar" style="margin:0 auto 8px">${c.avatar}</div><b>${esc(c.short)}</b><div class="sub" style="margin:4px 0 0">trusts you ${S.world.rel[c.id].player.trust}</div></button>`).join('')}</div>
    <div class="modal-actions"><button class="btn ghost" data-close>Not yet</button></div>`);
}

function confirmAccuse(id) {
  const c = NPC()[id];
  openModal(`<div class="kicker">No going back</div><h2>Accuse ${esc(c.name)}?</h2>
    <p>You have ${S.world.player.clues.length} clue${S.world.player.clues.length === 1 ? '' : 's'}. ${S.cast.filter((n) => n.id !== id && S.world.rel[n.id].player.trust >= 60).map((n) => n.short).join(', ') || 'Nobody'} trusts you enough to stand beside you.</p>
    <div class="modal-actions"><button class="btn ghost" data-accuse-back>Back</button><button class="btn danger" data-accuse-confirm="${id}">Accuse ${esc(c.short)}</button></div>`);
}

function showEnding(e) {
  const n = e.narrative;
  openModal(`<div class="kicker ${e.saved ? 'saved' : 'lost'}">${e.saved ? 'The café is saved' : 'The café is lost'} · you accused ${esc(nameOf(e.accused))}</div>
    <h2>${esc(e.title)}</h2>
    <p class="sub">${esc(e.blurb)}</p>
    <p style="font-family:var(--serif);font-size:15.5px;line-height:1.65">${esc(n.epilogue)}</p>
    <div class="fates">${Object.entries(n.fates || {}).map(([id, t]) => `<div class="fate" style="--c:${colorOf(id)}"><div class="avatar" style="width:34px;height:34px;font-size:16px">${NPC()[id]?.avatar ?? ''}</div><div><b>${esc(nameOf(id))}</b> — ${esc(t)}</div></div>`).join('')}</div>
    <div class="stats">
      <div class="stat"><b>${e.stats.lies}</b><span>lies told</span></div>
      <div class="stat"><b>${e.stats.contradictionsExposed}</b><span>times caught</span></div>
      <div class="stat"><b>${e.stats.rumorHops}</b><span>times your words were retold</span></div>
      <div class="stat"><b>${e.stats.cluesFound}</b><span>clues</span></div>
      <div class="stat"><b>${e.stats.fadedMemories}</b><span>memories forgotten</span></div>
    </div>
    <div class="modal-actions"><button class="btn ghost" data-compare>Compare playthroughs</button><button class="btn primary" data-restart>Play again, differently</button></div>`);
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function say(text) {
  text = text.trim();
  if (!text || ui.busy) return;
  const npc = ui.npc;
  S.world.dialogue[npc].push({ from: 'player', text, day: S.world.day });
  ui.busy = 'talk';
  $('#chatInput').value = '';
  render();
  try {
    const r = await api('/api/talk', { npc, text });
    S = r.state;
  } catch (err) {
    S.world.dialogue[npc].pop();
    toast(err.message);
    $('#chatInput').value = text;
  } finally {
    ui.busy = false;
    render();
    $('#chatInput').focus();
  }
}

async function advance() {
  const w = S.world;
  if (w.over) return showEnding(w.ending);
  if (w.day >= w.maxDays) return showAccuse();
  if (w.actionsLeft > 0) {
    openModal(`<div class="kicker">Close up early?</div><h2>End night ${w.day}</h2>
      <p>You still have ${w.actionsLeft} conversation${w.actionsLeft > 1 ? 's' : ''} left tonight. Once you leave, they'll talk about you.</p>
      <div class="modal-actions"><button class="btn ghost" data-close>Stay</button><button class="btn primary" data-endday>Leave for the night</button></div>`);
    return;
  }
  await endDay();
}

async function endDay() {
  ui.busy = 'night';
  const day = S.world.day;
  openModal(`<div class="kicker">Night ${day}</div><h2>The café closes.</h2><p class="typing" style="font-size:15px">Voices carry after dark</p>`);
  render();
  try {
    const r = await api('/api/end-day', {});
    S = r.state;
    ui.busy = false;
    render();
    showNight(r.night, day, r.morning);
  } catch (err) {
    ui.busy = false;
    closeModal();
    toast(err.message);
    render();
  }
}

async function accuse(id) {
  ui.busy = 'accuse';
  openModal(`<div class="kicker">Midnight</div><h2>You stand up in the café.</h2><p class="typing" style="font-size:15px">Everyone turns to look</p>`);
  try {
    const r = await api('/api/accuse', { npc: id });
    S = r.state;
    ui.busy = false;
    render();
    showEnding(r.ending);
  } catch (err) {
    ui.busy = false;
    closeModal();
    toast(err.message);
  }
}

async function restart(confirmed) {
  if (!S.world.over && !confirmed && S.world.dialogue && Object.values(S.world.dialogue).some((d) => d.length)) {
    openModal(`<div class="kicker">Start over</div><h2>Begin a new playthrough?</h2>
      <p>This playthrough hasn't reached an ending, so it won't be recorded. Everyone will forget you.</p>
      <div class="modal-actions"><button class="btn ghost" data-close>Cancel</button><button class="btn danger" data-restart-confirm>Start over</button></div>`);
    return;
  }
  S = await api('/api/reset', {});
  ui.focus = '';
  closeModal();
  render();
}

// ─── Events ──────────────────────────────────────────────────────────────────

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, [data-close]');
  if (!t) {
    if (e.target === $('#modal') && !ui.busy) closeModal();
    return;
  }
  const d = t.dataset;
  if (d.npc) {
    ui.npc = d.npc;
    ui.memNpc = d.npc;
    store.set('echoes.npc', ui.npc);
    render();
    $('#chatInput').focus();
  } else if (d.say) say(d.say);
  else if (d.tab) {
    ui.tab = d.tab;
    store.set('echoes.tab', ui.tab);
    renderTabs();
  } else if (d.layer) {
    ui.layers[d.layer] = !ui.layers[d.layer];
    renderTabs();
  } else if (d.knows) {
    ui.knowsFilter = d.knows;
    renderTabs();
  } else if (d.mem) {
    ui.memNpc = d.mem;
    renderTabs();
  } else if (d.replay) {
    showNight(S.world.gossip[d.replay], Number(d.replay), null);
  } else if ('close' in d) closeModal();
  else if ('next' in d) showNight.nav(1);
  else if ('prev' in d) showNight.nav(-1);
  else if ('endday' in d) endDay();
  else if (d.accuse) confirmAccuse(d.accuse);
  else if ('accuseBack' in d) showAccuse();
  else if (d.accuseConfirm) accuse(d.accuseConfirm);
  else if ('compare' in d) {
    ui.tab = 'runs';
    closeModal();
    render();
  } else if ('restart' in d) restart(true);
  else if ('restartConfirm' in d) restart(true);
  else if (t.id === 'advance') advance();
  else if (t.id === 'newRun') restart(false);
  else if (t.id === 'clearRuns') {
    S = await api('/api/clear-runs', {});
    render();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'focusSelect') {
    ui.focus = e.target.value;
    renderTabs();
  } else if (e.target.id === 'director') {
    ui.director = e.target.checked;
    store.set('echoes.director', ui.director);
    if (!ui.director && ui.knowsFilter === 'lies') ui.knowsFilter = 'all';
    render();
  }
});

$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  say($('#chatInput').value);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').hidden && !ui.busy) closeModal();
});

(async () => {
  try {
    S = await api('/api/state');
  } catch (err) {
    document.body.innerHTML = `<p class="empty" style="margin-top:20vh">Couldn't reach the ECHOES server: ${esc(err.message)}</p>`;
    return;
  }
  if (!S.cast.some((c) => c.id === ui.npc)) ui.npc = 'mara';
  ui.memNpc = ui.npc;
  render();
  if (!store.get('echoes.introSeen', false)) showIntro();
  else if (S.world.over) showEnding(S.world.ending);
})();
