# Swarm Hackathon Plan

## Vision

Swarm Arena is a multiplayer mission-control game for AI agent teams. Operators pick a mission, spend a limited Model Lab budget testing OpenRouter models, build an agent fleet, then launch the swarm into a SpacetimeDB-backed task graph. Agents atomically claim tasks, execute them through strict structured-output model calls, post results, and spawn follow-up tasks while humans steer the swarm live.

## Demo Goal

A user can pick a mission, test OpenRouter models under a lab budget, assemble an agent fleet, and watch agents race to complete a live task graph before time and run budget expire while another user overrides a bad branch in real time.

## Hackathon Target

- Event: SpacetimeDB Launchpad Hackathon, NYC Tech Week.
- Current date: Saturday, June 6, 2026.
- Submission deadline: Sunday, June 7, 2026 at 2:00 PM.
- Prize fit: Best Web App and Best Use of LLMs, with SpacetimeDB as the core real-time coordination backend.

## Stack

| Layer | Choice |
| --- | --- |
| Real-time backend | SpacetimeDB module |
| Module language | TypeScript first, Rust fallback only if TS module friction appears |
| Frontend | React + TypeScript + Vite |
| Agent runner | Node.js worker process running N agent loops |
| LLM gateway | OpenRouter via `~/.ai.env` |
| LLM output contract | Strict JSON Schema structured outputs |
| Visualization | Force-directed task graph plus live event console |
| Test command | `npm test` once scaffolded; reducer smoke checks via `spacetime call` |

## SpacetimeDB Core

SpacetimeDB is not an accessory here. It owns the hard part: shared mutable state with transactional reducers.

Tables:

- `task`: `id`, `parent_id`, `goal_id`, `title`, `status`, `assigned_agent_id`, `depth`, `attempts`, `created_at`, `updated_at`, `result`, `risk`.
- `agent`: `id`, `name`, `status`, `current_task_id`, `model`, `latest_thought`, `last_heartbeat`.
- `event`: append-only live log rows for task claims, completions, failures, human overrides, and spawned children.
- `operator`: human presence, display name, selected task, cursor or focus state.
- `goal`: submitted top-level goal, status, max depth, max tasks, created_by.

Reducers:

- `submit_goal(title, max_depth, max_tasks)`: creates a goal and root task.
- `register_agent(name, model)`: creates or refreshes an agent row.
- `claim_task(agent_id)`: atomically finds one pending task and assigns it. This is the demo flex.
- `post_result(agent_id, task_id, worker_result)`: marks task done or blocked and creates child tasks within depth/budget limits.
- `human_override(operator_action)`: pauses, resumes, reassigns, edits, or cancels tasks.
- `heartbeat_agent(agent_id, status, latest_thought)`: presence and stale-worker detection.
- `heartbeat_operator(selection)`: multiplayer human presence.

## Agent Loop

1. Subscribe to pending tasks, agent state, and goal budget state.
2. Call `claim_task`.
3. If no task was claimed, sleep briefly and retry.
4. Build a compact worker prompt from the task, ancestors, goal, and recent events.
5. Call OpenRouter with strict structured outputs and no `max_tokens`.
6. Validate the returned object locally.
7. Call `post_result`.
8. On validation/provider failure, retry another model once, then mark the task blocked with a visible event.

Hard safety rules:

- No API token caps in LLM calls.
- Use request timeouts so a stuck provider does not freeze an agent.
- Use SpacetimeDB task budgets: `max_depth`, `max_tasks`, and `attempts`.
- Never let a failed task respawn itself indefinitely.
- Reducers remain deterministic: all network calls stay in the Node agent client.

## LLM Routing

Primary mode:

- OpenRouter League. Operators can test and use any OpenRouter model that passes strict schema/deadline checks.
- Suggested preset: Cerebras Sprint.

Suggested starting models:

- Default fast lane: `openai/gpt-oss-120b:nitro`, pinned to provider `Cerebras`.
- Quality lane: `z-ai/glm-4.7:nitro`, pinned to provider `Cerebras`, with reasoning disabled/excluded.
- Alternate fast lane: `inception/mercury-2:nitro`.
- Custom OpenRouter model ID: allowed after Model Lab schema/deadline test.

Request requirements:

- Always use `response_format.type = "json_schema"`.
- Always set `json_schema.strict = true`.
- Always set `provider.require_parameters = true`.
- For Cerebras Sprint suggestions, also set `provider.only = ["Cerebras"]` and `provider.allow_fallbacks = false`.
- Do not send `max_tokens`.
- Validate parsed output locally before writing results to SpacetimeDB.

Rejected for the hot path:

- Any model that needs `require_parameters = false`.
- Any model that fails Model Lab schema validation.
- Any late result that misses the active task deadline.
- Any result that exceeds remaining game budget.

## Frontend

First screen should be the usable mission-control workspace, not a landing page.

Views:

- Mission setup.
- Model Lab.
- Agent Form.
- Live task graph with task status colors and pulsing active agents.
- Agent roster with current task, model, heartbeat, and latest thought.
- Event stream console.
- Task inspector with result, children, attempts, override controls.
- Multiplayer operator presence.

Visual priority:

- Make `claim_task` concurrency visible.
- Make agent motion visible within seconds.
- Make human steering obvious from a second browser/laptop.

## MVP Build Order

1. Create SpacetimeDB module with tables and reducers.
2. Generate TypeScript bindings.
3. Build Node agent runner with strict structured-output OpenRouter client.
4. Build Model Lab benchmark calls and model bench table.
5. Build Agent Form with 3-6 slots.
6. Build React subscriptions and reducer calls.
7. Add graph visualization and event console.
8. Add human override controls.
9. Run two browser clients plus several worker agents.
10. Polish demo script and seed missions.

## Demo Script

1. Open two browsers as different operators.
2. Choose **Fix Failing Swarm Demo**.
3. Enter Model Lab and test suggested OpenRouter models.
4. Build an agent fleet in Agent Form.
5. Start the live run.
6. Show multiple workers racing to claim tasks, but each task assigned once.
7. Point out `claim_task` is a transactional reducer, so no external queue or lock service is needed.
8. Let agents spawn follow-up tasks.
9. From the second browser, merge duplicates or pause a branch.
10. Show all clients update instantly.

## Out Of Scope

- Character-level collaborative editing.
- Full auth beyond SpacetimeDB identity/presence.
- Long-running web research with citations.
- Perfect autonomous project management.
- Cloud deployment before the local demo is strong.
