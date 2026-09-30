import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader (no dependencies).
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const { Game } = await import('./engine/game.js');
const { llmStatus } = await import('./engine/llm.js');

const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

// Every visitor gets their own world, keyed by a random id the browser keeps in localStorage.
const SESSIONS_DIR = path.join(ROOT, 'data', 'sessions');
const MAX_LIVE = 300;
const games = new Map();
function gameFor(req) {
  const raw = String(req.headers['x-echoes-session'] || '');
  const id = /^[a-z0-9-]{8,64}$/i.test(raw) ? raw.toLowerCase() : 'local';
  let game = games.get(id);
  if (game) games.delete(id); // re-insert below so the Map stays in least-recently-used order
  else game = new Game(path.join(SESSIONS_DIR, id));
  games.set(id, game);
  if (games.size > MAX_LIVE) games.delete(games.keys().next().value); // still on disk; reloads on return
  return game;
}

// One mutation at a time per world.
const serial = (game, fn) => (game.queue = game.queue.then(fn, fn));

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1e5) throw Object.assign(new Error('Body too large'), { status: 413 });
  }
  return data ? JSON.parse(data) : {};
}

const routes = {
  'GET /api/state': (game) => game.state(),
  'POST /api/talk': (game, b) => game.talk(b.npc, b.text),
  'POST /api/end-day': (game) => game.endDay(),
  'POST /api/accuse': (game, b) => game.accuse(b.npc),
  'POST /api/reset': (game) => game.reset(),
  'POST /api/clear-runs': (game) => game.clearRuns(),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const game = gameFor(req);
      send(res, 200, await serial(game, () => handler(game, body)));
    } catch (err) {
      if (!err.status) console.error(err);
      send(res, err.status || 500, { error: err.message || 'Something went wrong' });
    }
    return;
  }
  if (req.method !== 'GET') return send(res, 404, { error: 'Not found' });
  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  const s = llmStatus();
  console.log(`\n  ECHOES — A World That Remembers You`);
  console.log(`  http://localhost:${port}`);
  console.log(`  Brain: ${s.mode === 'nemotron' ? `Nemotron (${s.model})` : 'offline rule-based brain (set NVIDIA_API_KEY in .env for Nemotron)'}\n`);
});
