# ECHOES — A World That Remembers You

One café. Four people. Three nights. One missing ledger.

Every character remembers what you told them. After closing, they talk to each other, and they remember **who knows what**. Tell Mara you love coffee and Ines you hate it, and by morning they've compared notes. Tell Ines that Theo stole something, and she'll pass it on. Theo won't know why everyone has gone cold on him.

## Run it

```bash
cd echoes
npm start            # http://localhost:3000
```

No dependencies; you need Node 20 or newer.

**Nemotron:** copy `.env.example` to `.env`, add an `NVIDIA_API_KEY` from https://build.nvidia.com, then restart. Without a key the game runs on a deterministic **offline brain** that returns the same structured output, so the memory, gossip and contradiction engine behaves identically. To run Nemotron locally (Ollama, a NIM container, vLLM), set `LLM_BASE_URL` to your server.

## The story

Moonlight's Midnight Café. The Midnight Ledger held the café's original 1962 lease, and it vanished from a locked drawer. The eviction hearing is at midnight on Night 3.

| | Public face | Secret |
|---|---|---|
| ☕ Mara | Owner, frightened, proud | Three months behind on rent |
| 🥐 Theo | Anxious pastry chef | Handed the ledger to Silas for a job offer |
| 📰 Ines | Nosy retired journalist | Writing an exposé on Silas |
| 🎩 Silas | Charming developer | Has the ledger in his safe; blames Ines |

What people tell you is gated by trust. Some clues lower another character's guard: once you have Ines's sighting of Theo's bike, Theo can confess. On Night 3 you accuse someone. The ending comes from world state: who you accused, what evidence you hold, who trusts you enough to back you, and how many lies you told and how many were caught. The epilogue is generated from what you actually said and who repeated it.

## Architecture

```
PLAYER → server.js → Game (engine/game.js)
                       ├─ World state   engine/world.js    story, cast, secrets, ground truth
                       ├─ Memory        engine/memory.js   per-NPC memories, recall, forgetting
                       ├─ Brain         engine/brain.js    focused prompts → Nemotron (JSON)
                       │                engine/fallback.js offline brain, same output shape
                       └─ World update  claims, beliefs, trust, propagation, events
```

- **Memories are per-NPC and typed:** `told`, `heard` (with a source chain like *Mara ← Ines ← You*), `knowledge`, `caught`, `feeling`, and so on. Each has an importance, a strength and a confidence.
- **Recall:** the LLM never sees the whole history. For each turn it gets the top 8 memories, scored on keyword overlap, who the memory is about, importance × strength, and recency. Recalling a memory makes it stronger.
- **Forgetting:** every night, memories lose strength in inverse proportion to their importance. Small talk fades within two nights; anything with importance 8 or higher is permanent.
- **Claims:** Nemotron pulls structured claims out of what the player says (`subject|topic = value`, plus a sentiment score). They are normalised so different phrasings still line up, then stored as beliefs with a confidence based on how much the listener trusts the source.
- **Gossip:** each night the engine picks three pairs of characters. Each character chooses what to share by importance, juiciness and novelty, won't incriminate themselves, and won't repeat an accusation to its target's face. Listeners either adopt the belief, doubt it, or catch you out. The engine decides what moves between characters; Nemotron only writes the scene.
- **Misinformation:** a negative belief about someone lowers the holder's trust in them. A character who suddenly gets the cold shoulder remembers that people turned cold and doesn't know why.
- **Director view** shows the ground truth: lies, secrets, which memories were recalled, which faded, and the trust thresholds that gate each secret.

## Scripts

- `npm run smoke`: plays the brief's scenarios through the engine and checks the social-memory behaviour.
- `node scripts/render-check.js`: renders every UI view against a running server using a stub DOM.

Save data lives in `data/save.json`. Finished playthroughs go to `data/runs.json` and appear in the **Playthroughs** tab side by side.
