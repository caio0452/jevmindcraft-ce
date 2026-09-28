# Jev bot — architecture & run guide

Jev (`typesafe/jev-1.13` via OpenRouter) is a **decision model, not a chat
model**: it takes a JSON `state` plus typed questions (`choice`/`noul`/`score`)
and returns probabilities — no text, no reasoning trace. This bot is currently
**Jev-only**: all LLM calls (chat, codegen, vision, memory summaries,
embeddings) are gated off behind `jev_autonomous` in `andy.json`, and Jev
drives game progression directly.

## Architecture

```
andy.json  (model + jev_autonomous flag + decision_model)
keys.json  (OPENROUTER_API_KEY for Jev)
    │
    ▼
src/models/jev.js — thin Decisions-API client
    decide(state, questions): validates (1–255 choice alternatives),
    retries with backoff, tracks cost/tokens, verbose request/response logs.
    sendRequest() intentionally throws: Jev is not a chat model.
    │
    ▼
src/agent/jev/jev_progression.js — the controller (JevProgression)
    every idle tick:
      1. scan (cached: blocks 15s, entities 5s) — logs, tables, furnaces,
         stone, EXPOSED ores (≥1 open neighbour, no wall-digging),
         nearby torches, ceiling column (cave detection), animals, hostiles
      2. reactive overrides first (starving→eat, close hostile→fight/flee)
      3. buildCandidates() — the bot enumerates what is VIABLE
         (pickaxe tiers, table/furnace/material prerequisites, failure
         cooldowns); each with distances and plain-language hints
      4. buildJevState() — Jev sees percentages + words, never raw game
         units (health/hunger %, pickaxe capabilities, daylight description,
         stock summary, next-upgrade frontier, recent + failed actions)
      5. ONE Decisions call: next_action (Choice) + in_danger (Noul) +
         urgency (Score); winner sampled top-3 weighted p1, p2², p3²
         (anti-hoarding) instead of argmax
      6. execute via mineflayer skills; explicit `false` = failure →
         exponential cooldown; same action failing back-to-back → unstick
         (break blocking neighbour, move away)
    │
    ▼
src/agent/commands/index.js — !jevStep / !jevAuto / !jevStop / !jevStats
src/agent/agent.js — Jev-only gates (isJevOnly()) + autostart of the
    progression loop on spawn; src/models/prompter.js skips embeddings;
    self-prompter/coder/vision/NPC-goals/memory-summaries all refuse.
```

Progression covered: wood → planks/sticks/table → wooden→stone→iron→diamond
pickaxes, swords, furnace + smelting, torches (craft/place when dark),
iron armor piece-by-piece, hunting/cooking, 64-block exploration when iron
or fuel is missing, cave retreat when underground and threatened.

## Run

Requirements: Node ≥ 22.13, a running Minecraft server (Java), `npm ci`.

```bash
cp keys.example.json keys.json   # then set OPENROUTER_API_KEY in keys.json
npm ci
node main.js                     # uses ./andy.json (Jev-only: jev_autonomous=true)
```

- Point at your server via `settings.js` (`host`, `port`) or CLI env.
- `!jevStop` pauses autonomy; `!jevStep` single-steps; `!jevStats` shows
  Jev calls/tokens/cost. `JEV_VERBOSE=0` quiets decision logs.
- Back to normal LLM mode: set `jev_autonomous: false` in `andy.json`
  (all `TEMP` gates key off it) and set a chat `model` + key.
