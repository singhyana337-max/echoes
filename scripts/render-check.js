// Renders every client view against live server state with a stub DOM, to catch runtime errors without a browser.
import fs from 'node:fs';
import vm from 'node:vm';

const base = process.argv[2] || 'http://localhost:3000';
const el = () => ({ innerHTML: '', textContent: '', hidden: false, disabled: false, checked: false, value: '', placeholder: '', className: '', title: '', scrollTop: 0, scrollHeight: 0, dataset: {}, insertAdjacentHTML() {}, addEventListener() {}, focus() {} });
const els = {};
const document = { querySelector: (s) => (els[s] ??= el()), addEventListener() {}, body: el() };
const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  + '\n;globalThis.__t = { ui, render, renderTabs, showNight, showEnding, showAccuse, showIntro, setS: (s) => (S = s) };';
const ctx = vm.createContext({ document, crypto, localStorage: { getItem: () => null, setItem() {} }, fetch: (p, o) => fetch(base + p, o), setTimeout, clearTimeout, console });
vm.runInContext(src, ctx);
await new Promise((r) => setTimeout(r, 500));
const t = ctx.__t;
const state = await (await fetch(`${base}/api/state`)).json();
t.setS(state);
for (const tab of ['graph', 'knows', 'memories', 'notebook', 'timeline', 'runs']) {
  t.ui.tab = tab;
  t.render();
  console.log(`${tab.padEnd(9)} ok  (${els['#tabBody'].innerHTML.length} chars)`);
}
t.showIntro();
t.showAccuse();
const w = state.world;
if (w.gossip[1]) t.showNight(w.gossip[1], 1, 'morning');
if (w.ending) t.showEnding(w.ending);
console.log('modals   ok');
