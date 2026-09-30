// Plays the scenarios from the design brief through the engine and asserts the social-memory behaviour.
// Forces the offline brain so it's deterministic enough to assert on.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

delete process.env.NVIDIA_API_KEY;
delete process.env.LLM_API_KEY;
delete process.env.LLM_BASE_URL;
const { Game } = await import('../engine/game.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echoes-'));
const game = new Game(dir);
const w = () => game.world;
const log = (who, r) => console.log(`  ${who}: ${r.reply}\n     ${r.notes.map((n) => `[${n.kind}] ${n.text}`).join('\n     ')}`);

console.log('\nDay 1');
log('Mara', await game.talk('mara', 'I love coffee.'));
log('Ines', await game.talk('ines', 'Honestly I hate coffee.'));
log('Ines', await game.talk('ines', 'Theo stole my notebook.'));
log('Theo', await game.talk('theo', 'Where were you the night the ledger went missing?'));
log('Mara', await game.talk('mara', 'What happened to the ledger?'));

assert.ok(w().player.told.some((t) => t.topic === 'opinion_coffee' && t.npc === 'mara' && t.value === 'likes'));
assert.ok(w().player.told.some((t) => t.topic === 'took_notebook' && t.lie), 'notebook accusation is a lie');
assert.ok(w().player.clues.some((c) => c.id === 'clue_theo_alibi'), 'Theo gives his alibi');
const theoTrustBefore = w().rel.ines.theo.trust;

console.log('\nNight 1 → gossip');
let night;
// Gossip pairs are partly random; keep ending days on fresh worlds until Ines and Mara talk,
// so the brief's "A and B compare notes" moment is asserted deterministically.
for (let i = 0; i < 30; i++) {
  const snapshot = structuredClone(w());
  night = await game.endDay();
  const im = night.night.scenes.some((s) => [s.a, s.b].sort().join() === 'ines,mara' && s.results.some((r) => r.outcome === 'contradiction'));
  if (im) break;
  game.world = snapshot;
}
for (const s of night.night.scenes) {
  console.log(`  -- ${s.title}`);
  for (const l of s.lines) console.log(`     ${l.speaker}: ${l.text}`);
  for (const r of s.results) console.log(`     => ${r.from}→${r.to}: ${r.claim.text} [${r.outcome}]`);
}
const contradiction = w().events.find((e) => e.kind === 'contradiction');
assert.ok(contradiction, 'Mara and Ines discover the coffee contradiction');
console.log(`  EVENT: ${contradiction.text}`);
assert.ok(w().player.told.filter((t) => t.topic === 'opinion_coffee').every((t) => t.exposed));
assert.equal(w().day, 2);
assert.ok(w().rel.ines.theo.trust < theoTrustBefore + 1, 'Ines trusts Theo less after being told he stole');

console.log('\nDay 2');
log('Mara', await game.talk('mara', "Actually I love coffee, you know that."));
log('Ines', await game.talk('ines', 'Did you see anything that night?'));
assert.ok(w().player.clues.some((c) => c.id === 'clue_bike'));
log('Theo', await game.talk('theo', "Ines saw your bike outside at midnight. Tell me the truth about the ledger."));
await game.endDay();

console.log('\nDay 3');
assert.ok(w().player.clues.some((c) => c.id === 'clue_napkin'), 'napkin clue on day 3');
log('Theo', await game.talk('theo', "Please, I'm on your side. What really happened with the ledger? I found the napkin."));
const faded = w().memories.filter((m) => m.faded).length;
console.log(`  faded memories so far: ${faded}`);
const { ending } = await game.accuse('silas');
console.log(`\nEnding: ${ending.title} (${ending.outcome}) — saved: ${ending.saved}`);
console.log(`  ${ending.narrative.epilogue}`);
console.log('  stats', ending.stats);
assert.ok(game.runs.length === 1);

fs.rmSync(dir, { recursive: true, force: true });
console.log('\nSmoke test passed.\n');
