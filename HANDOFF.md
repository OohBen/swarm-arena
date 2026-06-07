# Swarm Arena — Handoff

> Handoff for the next agent. Read this top to bottom before touching anything.
> Repo: `/Users/bengoihman/Documents/SWARM` · public mirror: `github.com/OohBen/swarm-arena` (branch `master`).

---

## 0. TL;DR

**Swarm Arena** is a real, live, AI-powered strategy game built on **SpacetimeDB** for the SpacetimeDB Launchpad hackathon (NYC Tech Week). It is **not** a mockup — real AI agents make real OpenRouter LLM calls, coordinate through a real SpacetimeDB cloud database, and it's deployed at a public HTTPS URL.

- **Live:** https://swarm.benautomates.com (single-player, fully working, war-room aesthetic).
- **The whole single-player loop works:** draft a crew of real models → watch the swarm decompose & execute a mission on a paper "war-room" map → supplies/budget burn down → crisis cards force decisions → after-action report.
- **⚠️ THE BIG OPEN QUESTION (most important section — read §7):** the user has concluded the game "makes no sense as a 1v1 race or single-player — it only works if it's a fight/war." We were mid-pivot to a **two-swarm fight over a shared battle-map** when this handoff was requested. **Do not build more features until you align with the user on the fight model.**

---

## 1. What it is (current single-player game)

A war-room strategy game. The player ("Commander") is given a mission (e.g. *Colonize Mars*), drafts a hierarchy of AI agents, and commands them as they complete the mission under time + supply pressure, responding to crises.

**Flow:** Build table → Run board → After-Action report. All three are **paper/ink "war-room" aesthetic** (this matters — see §6).

- **Build (`client/src/components/WarRoomSetup.tsx`):** pick a mission; draft agents from a roster of **real OpenRouter models** showing **real $/M-token pricing** (`MODELS` in `client/src/lib/missions.ts`); drag units onto **COMMAND** (role=lead) / **FIELD** (role=worker) tiers; a **crew-points cap** (`CREW_POINTS_CAP=20`) makes drafting a tradeoff; custom model id supported.
- **Run (`client/src/components/WarRoomBoard.tsx`):** the crew claims role-tagged objectives off a live objective tree; **supply/budget clock** burns; **crisis cards** (`CrisisAlert`) demand a response; commander **orders** (pause/redirect/reassign/merge/cancel) via `human_override`.
- **After-Action (`client/src/components/Scoreboard.tsx`):** paper report with real per-unit latency/cost + a SpacetimeDB coordination tally.

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
`room`, `operator`, `goal`, `task`, `agent`, `event`, `score`, `crew_slot`, `crisis`, `reaper_timer` (scheduled), `crisis_timer` (scheduled).

Key columns: `task.required_role` ('lead'|'worker'|'any'), `task.latency_ms`/`cost_micros`, `agent.role`, `goal.run_budget_micros` (supply budget; 0=unlimited), `crew_slot` (model+role+count = what the runner deploys).

### Reducers
`create_room`, `join_room`, `submit_goal(room, title, max_depth, max_tasks, deadline_ms, run_budget_micros, crew[])`, `register_agent(room, name, model, role)`, `claim_task(room, agent)` (atomic, role-preferring + budget/goal-active guarded), `post_result`, `human_override`, `heartbeat_agent`, `heartbeat_operator`, `reap` (scheduled stale-lease recovery), `crisis_tick` (scheduled crisis director), `resolve_crisis(crisis_id, choice)`.

### How it fits together
1. Client `submit_goal` writes the goal + root task + **`crew_slot` rows** (the drafted crew).
2. The deployed **supervisor** (`runner --auto`) watches the cloud DB, sees an active goal with pending work, reads its `crew_slot` rows, and spawns exactly that crew (each agent its own connection) with roles.
3. Agents loop: `claim_task` (atomic — role-preferring) → real OpenRouter call (strict structured output) → `post_result` (mutates the task tree, spawns children with role by depth tier: depths 0..`LEAD_TIERS`=1 → lead, deeper → worker).
4. `crisis_tick` (every 9s) injects crises; client renders the card; `resolve_crisis` applies the chosen effect (supply cost / score / blocked objectives); expiry = worse penalty.
5. Budget: when `score.estimated_cost_micros >= goal.run_budget_micros`, `post_result` stops the goal (`status='stopped'`) and `claim_task` stops handing out work.

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
- **Runner (point at a room):** `cd runner && SWARM_ROOM=<id> npx tsx src/index.ts --agents "openai/gpt-oss-120b:nitro,z-ai/glm-4.7:nitro" [--mission "..."]`
- **Runner (auto/supervisor):** `SWARM_AUTO=1 SWARM_MAX_ROOMS=2 SWARM_PACE_MS=4500 npx tsx src/index.ts --auto`
- **Module:** `cd server && spacetime build`, then `spacetime publish swarm-arena --server maincloud --yes` (add `--delete-data=always` for schema changes — **wipes the cloud DB**). Then regenerate bindings (both dirs) + redeploy.
- **Create an op by CLI** (reliable, vs the flaky UI button): from `/tmp`, `spacetime call swarm-arena create_room '"colonize-mars"' '"CMDR"' --server maincloud`, then `spacetime call swarm-arena submit_goal <room> '"<title>"' 3 24 2000 30000 '[{"model":"z-ai/glm-4.7:nitro","role":"lead","count":1},{"model":"openai/gpt-oss-120b:nitro","role":"worker","count":3}]' --server maincloud`.

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

## 7. ⚠️ THE OPEN DESIGN PIVOT — start here

The user has reframed the core game multiple times. The **latest, unresolved** conclusion (verbatim intent): *"it makes no sense as a 1v1 race or single-player — it only works if it's a fight/war."*

**Why:** a race between two *productive* swarms is parallel solitaire (both just doing chores faster, no interaction). Single-player has no opponent. The fun requires **direct conflict**.

**The proposed pivot (mine, not yet confirmed):** turn it into a **two-swarm fight over one shared battle-map** — Blue (player) vs Red (rival). The key realization: **SpacetimeDB's atomic `claim_task` IS combat** — when two enemy swarms lunge for the same contested point, whoever wins the atomic claim takes the ground. Mechanics: capture contested objectives, **assault** to flip enemy-held points, **sabotage** to disrupt enemy agents, supplies+clock as pressure. The war-room map becomes a real front line (blue/red territory shifting live). This also fixes "over too fast" (it's "hold the line till the clock runs out", not "finish the chores"). Start the rival as an **AI swarm** (playable solo immediately), add human-vs-human later.

**I was about to ask which win-condition** when the user requested this handoff. The three options on the table:
1. **Territory control** — capture & hold contested points; most territory when supplies/time run out wins (most "war", reuses atomic claim directly). *My recommendation.*
2. **Capture the HQ** — push a lane through the tree to crack the enemy core (MOBA-style).
3. **Attrition** — bleed the enemy's supplies dry; last swarm standing.

**Next-agent action: confirm the fight model with the user BEFORE building.** Given the churn history, do not start the big rework on assumption. Once confirmed, this is a substantial backend change (two teams / ownership / flipping / win conditions / an AI rival swarm).

---

## 8. Known bugs / smaller TODOs

- **Crisis card lingers on a finished op** — once `goal.status` is complete/stopped, active crises should be cleared (or the client should hide the card). Currently a `dust_storm`/`supply_leak` card can show over a COMPLETE board. (User noticed this.)
- **After-Action verdict mid-run** shows "OPERATION ENDED" because the verdict only checks complete/stopped; viewing it before the op ends reads wrong. Minor.
- **Pacing**: even with `SWARM_PACE_MS=4000`, a 24-objective op finishes in ~40-60s with 7 agents — still too fast for the human to meaningfully act. The fight pivot should fix this structurally; otherwise consider bigger missions / a phase-ladder.
- **Dead code:** the old dark components `TopStrip.tsx`, `TaskGraph.tsx`, `AgentRoster.tsx`, `EventConsole.tsx`, `TaskInspector.tsx` (and `MissionSetup.tsx`) are unused now (replaced by `WarRoomSetup`/`WarRoomBoard`). The old dark CSS (`.app`, `.panel`, `.topstrip`, `.wb`/`.wr`/`.ar` are the live ones) is still in `styles.css`. Safe to delete the dark stuff once you're sure.
- **Cost:** the deployed runner spends real OpenRouter credits on every launched op (capped at `SWARM_MAX_ROOMS=2`). To pause spend: `coolify app stop l49wky5ariv2qfo4rgans4k7`.

---

## 9. Model catalog (real, benchmarked)

In `client/src/lib/missions.ts` (`MODELS`), with real pricing + bench-measured latency (`docs/model-routing.md`):
- **Scout** `openai/gpt-oss-120b:nitro` — fast/cheap (~510ms p50), beats the 2s deadline. The reliable workhorse.
- **Engineer** `z-ai/glm-4.7:nitro` — high quality, ~705ms, beats deadline.
- **Runner** `inception/mercury-2:nitro` — mid.
- **Oracle** `x-ai/grok-4.3:nitro` — genius-tier but slow + pricey, **misses the 2s deadline** (a trap).
- **Surveyor** `google/gemini-3.1-flash-lite:nitro`, **Analyst** `deepseek/deepseek-v4-flash:nitro` — slow, often late.

The deadline interplay is a real strategic layer: slow/expensive models miss the per-task deadline → penalties.

---

## 10. Status one-liner

Single-player war-room game: **DONE & LIVE.** Next: **the fight/war pivot (§7) — confirm model with user, then build the two-swarm battle.**
