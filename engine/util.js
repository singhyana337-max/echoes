export const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

let counter = 0;
export const uid = (prefix = 'id') => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;

const STOP = new Set(
  ('the a an and or but to of in on at for with is was are were be been you he she it they we me my your our their ' +
    'this that what who why how when did do does have has had not just so very about from as by if then than there ' +
    'here its it\'s i\'m you\'re can could would should will say said tell told know').split(' ')
);

const stem = (w) => w.replace(/(ing|ed|es|s)$/, '');

export function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map(stem);
}

export const slug = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);

const ENTITY_PATTERNS = {
  mara: /\bmara\b/i,
  theo: /\btheo\b/i,
  ines: /\bin[eè]s\b/i,
  silas: /\bsilas\b|\bcrane\b/i,
  ledger: /\bledger\b|\blease\b|\brecipe book\b/i,
  cafe: /\bcaf[eé]\b/i,
};

export function detectEntities(text) {
  return Object.entries(ENTITY_PATTERNS)
    .filter(([, re]) => re.test(text || ''))
    .map(([id]) => id);
}

const POSITIVE = new Set(['yes', 'true', 'likes', 'like', 'loves', 'love', 'enjoys', 'adores', 'good', 'positive']);
const NEGATIVE = new Set(['no', 'false', 'hates', 'hate', 'dislikes', 'dislike', 'detests', 'bad', 'negative', 'never']);

export const normValue = (v) =>
  String(v ?? '')
    .toLowerCase()
    .trim()
    .replace(/[.!?"']+/g, '')
    .replace(/\s+/g, ' ');

export function polarity(v) {
  const n = normValue(v);
  if (POSITIVE.has(n)) return 1;
  if (NEGATIVE.has(n)) return -1;
  return 0;
}

export function valuesConflict(a, b) {
  const pa = polarity(a);
  const pb = polarity(b);
  if (pa && pb) return pa !== pb;
  return normValue(a).replace(/\s/g, '') !== normValue(b).replace(/\s/g, '');
}

export const claimKey = (c) => `${c.subject}|${c.topic}`;

/** Normalizes the many ways an LLM (or regex) can phrase the same claim so contradictions line up. */
export function canonicalClaim(c) {
  let subject = slug(c.subject || 'player');
  if (/^(me|i|you|the_player|player_s|newcomer|stranger)$/.test(subject)) subject = 'player';
  if (/^ines|^in_s/.test(subject)) subject = 'ines';
  if (/crane/.test(subject)) subject = 'silas';
  let topic = slug(c.topic || 'fact');
  let value = normValue(c.value || 'yes');

  const pref = topic.match(/^(likes|like|loves|love|enjoys|adores|hates|hate|dislikes|dislike|detests)_(.+)$/);
  if (pref) {
    topic = `opinion_${pref[2]}`;
    const pol = polarity(pref[1]) * (polarity(value) || 1);
    value = pol >= 0 ? 'likes' : 'dislikes';
  } else if (topic.startsWith('opinion_')) {
    value = polarity(value) >= 0 ? 'likes' : 'dislikes';
  }

  const theft = topic.match(/^(stole|took|has|hid|steal|take|taking|stealing)_(.+)$/);
  if (theft) {
    const obj = /ledger|lease|recipe/.test(theft[2]) ? 'ledger' : theft[2].replace(/^(the|my|your|a)_/, '');
    topic = obj === 'ledger' && /has|hid/.test(theft[1]) ? 'has_ledger' : `took_${obj}`;
  }
  if (polarity(value) === 1) value = /^opinion_/.test(topic) ? value : 'yes';
  if (polarity(value) === -1 && !/^opinion_/.test(topic)) value = 'no';

  return {
    subject,
    topic,
    value,
    text: String(c.text || `${subject} ${topic.replace(/_/g, ' ')}: ${value}`).slice(0, 200),
    sentiment: clamp(Number(c.sentiment) || 0, -1, 1),
    importance: clamp(Math.round(Number(c.importance) || 5), 1, 10),
  };
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
