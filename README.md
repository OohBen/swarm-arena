# Swarm Arena

Multiplayer mission control for AI-agent war games, built for the SpacetimeDB Launchpad Hackathon.

Two human commanders join the same live room. Each drafts a fleet of real OpenRouter LLM agents. SpacetimeDB starts one shared battle map, agents atomically claim combat tasks, models return strict structured outputs, and reducers turn those results into pressure, fortification, captures, HQ damage, supply spend, and the live dispatch feed.

Live demo: https://swarm.benautomates.com

## Tech Used

- **SpacetimeDB** - authoritative real-time backend, tables, reducers, subscriptions, timers, and atomic task claiming.
- **TypeScript SpacetimeDB module** - all game state and reducer logic in `server/spacetimedb/src/index.ts`.
- **React + Vite + TypeScript** - multiplayer lobby, draft market, war-room map, command panel, and after-action UI in `client/`.
- **SpacetimeDB TypeScript SDK** - generated bindings for both the browser client and agent runner.
- **Node + tsx agent runner** - deployed worker supervisor in `runner/`; each AI agent is a SpacetimeDB client.
- **OpenRouter + AI SDK + Zod** - real model calls with strict structured outputs.
- **Coolify + Docker + Nginx** - production web and runner deploys.

## Why SpacetimeDB Is Core

This game is a live shared-state blackboard for humans and AI agents. That is exactly where SpacetimeDB matters.

SpacetimeDB owns the authoritative state:

- `room` - multiplayer lobby and lifecycle.
- `operator` - human commanders, side selection, readiness, presence.
- `draft_slot` - live synced Blue and Red fleet drafts.
- `crew_slot` / `agent` - deployed AI units and worker presence.
- `battle_node` - the shared map: owner, pressure, fortification, HQ integrity.
- `battle_order` - human command orders visible to both sides.
- `task` - combat work queue for agents.
- `event` - live dispatch log.
- `team_state` / `score` - supplies, command tokens, HQ state, scoreboard.

Reducers are the game server:

- `create_room`, `join_room`, `submit_draft` build the multiplayer match.
- `claim_task` is the important one: it atomically assigns one pending task to one eligible agent. Two agents cannot grab the same combat job.
- `post_result` validates the structured model result and mutates the battle map.
- `issue_order` spends a command token, applies an immediate tactical nudge, and queues priority work.
- `battle_tick` refills command tokens, expires old orders, keeps active combat tasks flowing, and checks supply loss.
- `reap` recovers tasks from dead or stale agents.

The frontend and AI agents are both just subscribed clients. Humans click orders; agents claim tasks; SpacetimeDB serializes the conflict.

## How The Game Works

Swarm Arena is Blue swarm vs Red swarm on one shared battlefield.

Win conditions:

- Crack the enemy HQ.
- Hold more territory if the fight ends by supply or action budget.
- Force the enemy to run out of supply.

Each side has separate supply. Model calls spend that side's supply, so expensive models can be powerful but risky.

Each side also has command tokens. A command token lets the human commander select a map node and issue one order:

- **Assault** - adds pressure, trims enemy pressure and fortification, then queues a Field assault.
- **Reinforce / Hold** - cuts enemy pressure and adds fortification, then queues defensive work.
- **Sabotage** - lowers fortification and adds light pressure, then queues sabotage work.
- **Scout** - adds a small pressure nudge and queues Command recon.

Agents do the actual fighting. They claim tasks from SpacetimeDB, call a model, and post a strict JSON result. If the result lands inside the combat deadline, the reducer applies it to the map. If it is late, it retries and does not move the map.

## Model Draft

Each commander drafts under a 14-point cap. Current curated model classes:

| Class | Model | Points | Role in the game |
|---|---:|---:|---|
| Scout | `openai/gpt-oss-120b:nitro` | 3 | Fast recon and cheap lane pressure; weaker at sabotage and HQ cracking. |
| Engineer | `z-ai/glm-4.7:nitro` | 5 | Premium fortify, sabotage, and HQ push; powerful but eats crew cap. |
| Runner | `inception/mercury-2:nitro` | 3 | Balanced assault unit for open lanes. |
| Surveyor | `google/gemini-3.1-flash-lite:nitro` | 3 | Recon specialist and good command pick. |
| Skirmisher | `z-ai/glm-4.7-flash:nitro` | 1 | Cheap assault/sabotage body with deadline risk. |
| Analyst | `deepseek/deepseek-v4-flash:nitro` | 2 | Budget command/recon/sabotage with deadline risk. |

`RISK` means the model's measured latency is near or above the 3.0s live combat window. Late answers do not affect the map.

## How To Play

1. Open https://swarm.benautomates.com.
2. Host a Blue lobby.
3. Send the room link to the second player.
4. Second player joins Red.
5. Both players draft a fleet:
   - Put at least one unit in **Command**.
   - Put at least one unit in **Field**.
   - Stay under the 14-point cap.
6. Lock both drafts. The battle starts automatically.
7. Click a node on the map.
8. Read the command panel:
   - **Intent** tells you what the selected node needs.
   - **Fight** shows pressure, threshold, and enemy pressure.
   - **Agents** explains what work will be queued.
9. Spend command tokens on Assault, Hold/Reinforce, Sabotage, or Scout.
10. Watch the dispatch feed and map pressure bars. Agents fight live.
11. Open After-Action to see winner, costs, latency, misses, and model performance.

Key reads:

- Blue and Red pressure race toward the node capture threshold.
- Enemy pressure slows or blocks your lane.
- Fortification makes capture harder.
- Command units create recon and order capacity.
- Field units execute combat work.
- Fast models are not automatically best; role fit, point cost, supply cost, and deadline risk matter.

## Local Development

Install dependencies:

```bash
npm install
npm --prefix client install
npm --prefix runner install
npm --prefix server/spacetimedb install
```

Build the SpacetimeDB module:

```bash
cd server/spacetimedb
spacetime build
```

Run the client:

```bash
npm --prefix client run dev
```

The client defaults to the live SpacetimeDB Maincloud database:

```text
wss://maincloud.spacetimedb.com / swarm-arena
```

Override it for local work:

```bash
VITE_SPACETIMEDB_URI=ws://127.0.0.1:3000 \
VITE_MODULE_NAME=swarm-arena-local \
npm --prefix client run dev
```

Run the agent runner for a room:

```bash
SWARM_ROOM=5 npm --prefix runner start -- --team blue
```

Run supervisor mode:

```bash
SWARM_AUTO=1 SWARM_MAX_ROOMS=2 npm --prefix runner start -- --auto
```

The runner needs an OpenRouter key from either the environment or `~/.ai.env`:

```bash
OPENROUTER_API_KEY=...
```

## Verification

Useful checks before demo:

```bash
(cd server/spacetimedb && spacetime build)
npm --prefix client run build
(cd runner && npx tsc --noEmit)
```

Production is deployed from `master` through Coolify. The current production app is:

```text
https://swarm.benautomates.com
```
