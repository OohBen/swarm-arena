# Swarm Arena — Handoff

> Handoff for the next agent. Read this top to bottom before touching anything.
> Repo: `/Users/bengoihman/Documents/SWARM` · public mirror: `github.com/OohBen/swarm-arena` (branch `master`).

---

## 0. TL;DR

**Swarm Arena** is a real, live, AI-powered strategy game built on **SpacetimeDB** for the SpacetimeDB Launchpad hackathon (NYC Tech Week). It is **not** a mockup — real AI agents make real OpenRouter LLM calls and coordinate through SpacetimeDB reducers.

- **Live:** https://swarm.benautomates.com is the production app. After schema changes, republish `swarm-arena` with `--delete-data=always` before deploying web/runner.
- **Multiplayer battle mode is implemented and locally verified:** one player hosts Blue, a second player joins Red, both draft separate OpenRouter fleets, both lock, then SpacetimeDB starts one shared 11-node battle map. Humans spend command tokens for their own side while AI agents fight.
- **Local reducer smoke passed:** two separate SpacetimeDB identities created/joined a room, submitted different Blue/Red drafts, started a battle, created correct `crew_slot` rows for both teams, and issued Blue + Red orders.
- **✅ CONFIRMED PIVOT:** mixed territory-control + HQ-capture. Humans are commanders; the actual combat is mainly **AI swarm vs AI swarm** on one shared battle map. Canonical spec: `docs/battle-mode.md`.

---

## 1. What it is now

A war-room strategy game for two human commanders. Blue hosts a room and shares the room URL; Red joins that same room. Each side drafts its own fleet from real OpenRouter models, locks the draft, and SpacetimeDB starts an 11-node battle map from both drafts. Both swarms claim combat tasks atomically, run strict structured-output LLM calls, and post results that move pressure, capture nodes, damage HQs, and spend supply.

**Flow:** Build table → Run board → After-Action report. All three are **paper/ink "war-room" aesthetic** (this matters — see §6).

- **Lobby/build (`client/src/components/WarRoomSetup.tsx`):** host/join room, visible share link, Blue/Red commander panels, live `draft_slot` state, independent drafts from real OpenRouter models showing real pricing (`MODELS` in `client/src/lib/missions.ts`), `CREW_POINTS_CAP=14`, custom model id supported.
- **Run (`client/src/components/WarRoomBoard.tsx`):** center battle map, Blue/Red HQ integrity, territory score, per-side command tokens, active orders, crew list, and live SpacetimeDB dispatch log. Each human selects a node and issues Assault/Defend/Reinforce/Sabotage/Scout for their own team through `issue_order`.
- **After-Action (`client/src/components/Scoreboard.tsx`):** paper report with winner, territory, HQ integrity, combat actions, real per-unit latency/cost, and SpacetimeDB coordination tally.

---

## 2. Architecture & where things live

| Piece | Path | Notes |
|---|---|---|
| **SpacetimeDB module (TS)** | `server/spacetimedb/src/index.ts` | The whole backend: tables + reducers. ~950 lines. **TS only — user is 100% committed, never propose Rust.** |
| **Agent runner** | `runner/` | Node + `tsx`. Each agent = its own persistent SpacetimeDB connection making real OpenRouter calls. `--auto` = supervisor mode (deployed). |
| **React client** | `client/` | Vite + React + `spacetimedb/react`. |
| **Generated bindings** | `client/src/module_bindings`, `runner/src/module_bindings` | Regenerate after ANY module change: `spacetime generate --lang typescript --out-dir <path> --module-path server/spacetimedb` (do both). |
| **LLM bench data** | `docs/model-routing.md` | Real latency/cost numbers the model catalog is based on. |
| **Planning docs** | `docs/`, `PLAN.md` | Original (pre-pivot) vision; partly stale now. |

### Module schema (tables)
`room`, `operator`, `draft_slot`, `goal`, `task`, `agent`, `event`, `score`, `crew_slot`, `team_state`, `battle_node`, `battle_order`, `crisis`, `reaper_timer`, `crisis_timer`, `battle_timer`.

Key columns: `operator.team`/`ready`, `draft_slot.team`/`role`/`model`/`count`, `task.required_role`, `task.team`, `task.target_node_id`, `task.action_type`, `task.priority`, `task.latency_ms`/`cost_micros`, `agent.team`, `agent.role`, `goal.run_budget_micros`, `crew_slot.team`, `battle_node.owner`/`fortification`/`blue_pressure`/`red_pressure`/`hq_integrity`, `team_state.command_tokens`/`hq_integrity`.

### Reducers
`create_room`, `join_room(room, display_name, team)`, `submit_draft(room, team, ready, title, max_depth, max_tasks, deadline_ms, run_budget_micros, crew[])`, legacy `submit_goal(...)`, `register_agent(room, name, model, role, team)`, `claim_task(room, agent)` (atomic, team/role/priority-scoped), `post_result`, `issue_order`, `human_override`, `heartbeat_agent`, `heartbeat_operator`, `battle_tick`, `reap`, `crisis_tick`, `resolve_crisis`.

### How it fits together
1. Blue calls `create_room`; Red calls `join_room` with `team: "red"`. Reducers atomically prevent two humans from claiming the same side.
2. Each side calls `submit_draft`; draft rows are stored in `draft_slot`. When both `operator.ready` flags are true and both drafts validate under the point cap, the same reducer creates the goal, battle map, team state, opening tasks, and live `crew_slot` rows.
3. The runner/supervisor reads `crew_slot` rows and spawns exactly those agents, one persistent SpacetimeDB connection each.
4. Agents loop: `claim_task` (atomic, team-scoped) → real OpenRouter call (strict structured output) → `post_result` applies combat through reducers. Battle tasks do **not** spawn LLM child tasks.
5. Humans issue `issue_order` against a selected node. Orders spend that commander's team tokens, immediately nudge the selected node, enqueue/raise a high-priority task, and write visible `battle_order`/`order_effect`/`human_order` rows.
5. `battle_tick` regenerates command tokens, expires old orders, ensures each team has a small number of active combat opportunities, and checks supply budget.
6. `crisis_tick` still exists for legacy mode, but battle-mode goals are skipped so random crisis cards do not block combat tasks.

---

## 3. Deployment (it's LIVE — be careful)

- **Cloud DB:** `swarm-arena` on **SpacetimeDB Maincloud** (`wss://maincloud.spacetimedb.com`). Dashboard: https://spacetimedb.com/swarm-arena. This is the canonical DB (we unified on cloud; a local `swarm` DB exists but is not used).
- **Hosting:** **Coolify Cloud** (`app.coolify.io`) → **Hetzner** server (IP `116.203.86.34`), project `swarm-arena` (uuid `rhot5zl57dam32fy4y9ny7mn`), env `production`. Both apps build from the public GitHub repo via Dockerfile.
  - **web** app uuid `wc68d6ebvy1xc241mpy1k9k4` (base `/client`, port 80) → **https://swarm.benautomates.com**
  - **runner** app uuid `l49wky5ariv2qfo4rgans4k7` (base `/runner`, port 8080, runs `--auto`). Env (Coolify secrets): `OPENROUTER_API_KEY`, `SWARM_AUTO=1`, `SWARM_MAX_ROOMS=2`, `SWARM_PACE_MS=4000`.
- **Domain/DNS:** `benautomates.com` is on **Cloudflare** (zone `6ef76a8dd0e698ff35cf492c22e85854`; token in `~/.ai.env` as `CLOUDFLARE_API_TOKEN`). `swarm` is an A record → `116.203.86.34`. Zone SSL = Full; Coolify provisions the Let's Encrypt cert on deploy (first ~60-90s returns Cloudflare **525** until the origin cert exists, then 200).
- **Secrets (never commit/print):** OpenRouter key → `~/.ai.env` (`OPENROUTER_API_KEY`). Coolify token → `~/.config/coolify/config.json`. The user's Coolify-cloud token leaked into a session transcript once — consider rotating.

### Redeploy after changes
```
git add -A && git commit -m "..." && git push origin master
coolify deploy uuid wc68d6ebvy1xc241mpy1k9k4   # web
coolify deploy uuid l49wky5ariv2qfo4rgans4k7   # runner
```
Monitor: `GET https://app.coolify.io/api/v1/deployments/<deployment-uuid>` → `.status` (in_progress|finished|failed). **Coolify CLI cannot create apps** — only the REST API can (`POST /api/v1/applications/public`).

---

## 4. Local dev

- **Client:** `cd client && npm run dev` (Vite, port 5173). Connects to cloud `swarm-arena` by default (`client/src/config.ts`).
- **Local battle client:** `cd client && VITE_SPACETIMEDB_URI=ws://127.0.0.1:3000 VITE_MODULE_NAME=swarm-arena-battle-test npm run dev -- --host 127.0.0.1`
- **Runner (point at a room):** `cd runner && SWARM_ROOM=<id> npx tsx src/index.ts --agents "openai/gpt-oss-120b:nitro,z-ai/glm-4.7:nitro" [--mission "..."]`
- **Runner (auto/supervisor):** `SWARM_AUTO=1 SWARM_MAX_ROOMS=2 SWARM_PACE_MS=4500 npx tsx src/index.ts --auto`
- **Module:** `cd server && spacetime build`, then publish local with `spacetime publish swarm-arena-battle-test --server local --module-path server/spacetimedb --yes`. Cloud publish to `swarm-arena` needs `--delete-data=always` and explicit user approval.
- **Create a multiplayer op by CLI** (cloud/local shape): call `create_room '"mars-front"' '"BLUE"'`, call `join_room <room_id> '"RED"' '"red"'` from a second identity/client, then call `submit_draft` for Blue and Red with `ready=true`, `deadline_ms=3000`, `run_budget_micros=180000`, and crew rows like `[{"model":"z-ai/glm-4.7:nitro","role":"lead","count":1},{"model":"openai/gpt-oss-120b:nitro","role":"worker","count":2}]`.

---

## 5. Gotchas that cost real time (read before debugging)

- **Client LAUNCH button is disabled until the SpacetimeDB connection is active.** Automated clicks right after a reload hit a disabled button and silently do nothing → no room created. Wait ~7s+ after connect, or check `!button.disabled`. Also `location.reload()` kills any `setTimeout` you queued in the same eval.
- **`spacetime call`/`sql` from inside `server/`** mis-resolve the DB name (look for `server-xxxx`). Run from elsewhere (e.g. `/tmp`) with `--server maincloud` and explicit DB `swarm-arena`. `spacetime sql` does **not** support `ORDER BY` or `COUNT(*)`.
- **Schema changes** (new non-optional columns) require `--delete-data=always` republish = **wipes cloud data**. The user must authorize wipes (auto-mode classifier blocks them otherwise).
- **Coolify API is behind Cloudflare:** Python `urllib` default UA → HTTP 403 "error code: 1010". Set header `User-Agent: curl/8.7.1`. Env-create body is just `{key, value}` (no `is_build_time`).
- **Field casing:** client bindings are **camelCase** (`roomId`, `goalId`, `requiredRole`, `deadlineMicros`, `estimatedCostMicros`…); the server module uses **snake_case** column names. Reducers called as `conn.reducers.claimTask({ roomId, agentId })`.
- **Reducers are deterministic:** use `ctx.random` / `ctx.timestamp`, NOT `Math.random`/`Date.now` (those throw in the module). The browser client uses `Math.random`/`Date.now` freely.
- **Runner uses `tsx` (esbuild) — no typecheck.** `any` types are fine; it runs despite TS errors.
- **Disconnect/reap:** module `onDisconnect` is a **no-op** on purpose (cloud WS flaps; marking agents stale on disconnect once stole in-flight tasks and crashed the runner). Recovery is heartbeat-wedge only (`STALE_AGENT_MICROS=10s`). The runner re-checks task ownership before `post_result` and has process-level `unhandledRejection`/`uncaughtException` guards — keep these.
- **Local `spacetime start` must match the CLI version** (2.4.1). A stale 2.4.0 standalone caused `invalid bsatn module def: unknown tag 0xd` on publish → kill the old `spacetimedb-standalone` PID, restart. (Mostly irrelevant now since we use cloud.)

---

## 6. Design constraints (HARD — the user is design-led and has rejected work twice)

- **Aesthetic = "war-room map":** paper/ink tactical (aged-paper bg `#e8e2d0`/`#ded7c2`, ink `#1f1b14`, friendly-blue `#2e5a8c`, hostile-red `#a8332e`, NATO unit counters, drawing title-block, red ops stamp, crop marks). **Light theme, NOT dark.** Fonts: Saira Condensed + Oswald + IBM Plex Sans/Mono. CSS classes: `.wr-*` (build), `.wb-*` (run board), `.ar-*` (after-action).
- **DO NOT regress to "AI slop":** the user explicitly rejected dark-bg + gradient-accent + glassmorphism + generic grotesk + neon HUD **twice** ("corny", then "AI slop, doom and despair"). They picked the war-room direction after a research pass. Commit hard to it; do not blend back to the generic dark dashboard. (Research notes live in the memory file `swarm-design-direction.md`.)
- **TS module only.** No Rust, ever.
- **Don't reduce scope without explicit permission.** The user decides cuts.
- The game must have **real conflict, be watchable, and not be over in ~15s.**

---

## 7. ✅ CONFIRMED DESIGN PIVOT — start here

The user has confirmed the fight model: **mix territory control and HQ capture.** The game is mainly **AI vs AI**, with humans controlling/managing the swarm at a commander level.

Canonical spec: `docs/battle-mode.md`.

**Why:** a race between two *productive* swarms is parallel solitaire (both just doing chores faster, no interaction). Single-player has no opponent. The fun requires **direct conflict**.

**Implemented mode:** two human commanders draft separate Blue and Red AI swarms, then both swarms fight over one shared battle map. The key realization: **SpacetimeDB's atomic `claim_task` IS combat**. Mechanics: capture contested objectives, assault to flip enemy-held points, sabotage/defend/scout, supplies as pressure, and HQ integrity as the primary kill condition.

**Win condition:** crack/capture the enemy HQ, or win on territory control when the clock/supplies expire.

**Human role:** humans do not manually complete tasks. They issue high-leverage commander intent by selecting battlefield nodes and spending limited command tokens. AI agents perform the live scouting/assault/defense/sabotage loop.

**Current tuning:** each side defaults to 1 command unit + 2 field units, `deadline_ms=3000`, runner default `SWARM_PACE_MS=8000`, `MAX_ACTIVE_BATTLE_TASKS=2`, immediate command-order surges, and battle crises disabled.

---

## 8. Known bugs / smaller TODOs

- **Cloud deployment:** schema changes require wiping/publishing cloud `swarm-arena` with `--delete-data=always`, then redeploying web and runner.
- **Pacing:** latest short local 3v3 test produced 32 valid combat results, 0 late/invalid, ~$0.0086 estimated cost, a human order effect, Central Relay capture, and deeper front-line pressure instead of an instant HQ kill. Still watch it in a longer run before presenting.
- **After-Action mid-run** now has battle stats but still can be opened before the match ends; copy may need polish for "live report" vs "final report".
- **Dead code:** the old dark components `TopStrip.tsx`, `TaskGraph.tsx`, `AgentRoster.tsx`, `EventConsole.tsx`, `TaskInspector.tsx` (and `MissionSetup.tsx`) are unused now (replaced by `WarRoomSetup`/`WarRoomBoard`). The old dark CSS (`.app`, `.panel`, `.topstrip`, `.wb`/`.wr`/`.ar` are the live ones) is still in `styles.css`. Safe to delete the dark stuff once you're sure.
- **Cost:** the deployed runner spends real OpenRouter credits on every launched op (capped at `SWARM_MAX_ROOMS=2`). To pause spend: `coolify app stop l49wky5ariv2qfo4rgans4k7`.

---

## 9. Model catalog (real, benchmarked)

In `client/src/lib/missions.ts` (`MODELS`), with live OpenRouter pricing and strict structured-output checks:
- **Scout** `openai/gpt-oss-120b:nitro` — default worker, pinned to Groq in the runner; tiny strict schema ~202ms avg, full worker schema ~1.12s avg; $0.039/$0.18 per M tokens.
- **Engineer** `z-ai/glm-4.7:nitro` — default command, pinned to Cerebras in the runner; tiny strict schema ~230ms avg, full worker schema ~417ms avg; $0.40/$1.75 per M tokens.
- **Runner** `inception/mercury-2:nitro` — reliable fallback, ~943ms p50, $0.25/$0.75 per M tokens.
- **Surveyor** `google/gemini-3.1-flash-lite:nitro` — fast on the simple combat spot-check (~893ms avg) but previously slow on complex tasks.
- **Skirmisher** `z-ai/glm-4.7-flash:nitro`, **Flash** `google/gemini-3.5-flash:nitro`, **Analyst** `deepseek/deepseek-v4-flash:nitro`, **Oracle** `x-ai/grok-4.3:nitro` — useful experiments, not defaults.
- **Do not recommend** `openai/gpt-5.4-mini:nitro` or `openai/gpt-5.4-nano:nitro` for reducer-writing agents right now: both existed in the models endpoint but failed strict structured-output routing with `require_parameters`.

The deadline interplay is a real strategic layer: slow/expensive models miss the per-task deadline → penalties.

---

## 10. Status one-liner

Battle-mode war-room game: **implemented and locally verified.** Next: get explicit approval to wipe/publish cloud `swarm-arena`, then redeploy web + runner and do one full public smoke test.
