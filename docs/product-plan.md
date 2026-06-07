# Swarm Arena Product Plan

## One-Liner

Swarm Arena is a multiplayer mission-control game where humans test OpenRouter models, build AI agent fleets, deploy them into a live SpacetimeDB task graph, and race to finish a mission before time and model budget run out.

## What We Are Building

Not a generic agent dashboard. Not just chat with a graph.

The app should feel like a live strategy/ops game:

1. A mission starts from one high-level objective.
2. Several agents enter the board as active workers.
3. Every worker must atomically claim a task through SpacetimeDB.
4. The worker calls the model selected for that agent.
5. The result must arrive before the deadline and pass strict schema validation.
6. Valid on-time results mutate the shared task tree.
7. Late, invalid, duplicated, or over-budget results become visible events and penalties.
8. Humans can pause, redirect, merge, or kill branches live.

The winning demo: the graph grows, agents pulse, events stream, a second human changes the plan, and the system remains consistent because SpacetimeDB reducers own the shared state.

## How Players Understand It

The setup flow should make the game clear before the mission starts:

- Pick a mission.
- Read the win condition.
- Enter Model Lab and test models with limited time and budget.
- Set run time and budget constraints.
- Assign models to agent slots.
- Start the run.

The simplest player-facing line:

> Finish the mission before time and model budget run out. Every task result must beat the 2-second deadline or it becomes a penalty.

The app has one primary league and one recommended preset:

- **OpenRouter League**: main mode where operators can try any model, but late, invalid, or over-budget results do not apply to the task tree.
- **Cerebras Sprint**: recommended preset inside OpenRouter League with Racer 120B and Strategist GLM 4.7.

## Match Phases

1. **Mission Pick**
   - Choose a mission template or write a custom mission.
   - See win condition, likely task count, difficulty, and recommended constraints.

2. **Model Lab**
   - Full game: `5:00` and `$2.00` testing budget.
   - Hackathon demo: `2:00` and `$0.25` testing budget.
   - Test suggested models or custom OpenRouter model IDs.
   - Record latency, p95, valid-output rate, cost, and quality score.

3. **Agent Form**
   - Full game: `3:00` build window.
   - Hackathon demo: `1:00` build window.
   - Assign models and roles to agent slots.
   - Set retry, deadline, and budget policy.

4. **Live Run**
   - Full game: `10:00` and `$2.00` run budget.
   - Hackathon demo: `5:00` and `$0.50` run budget.
   - Agents claim tasks, call their assigned model, and post validated results.

5. **Scoreboard**
   - Compare mission completion, latency, validity, cost, model split, and human saves.

## Suggested Model Picks

Recommended starting cards:

- **Racer 120B**: `openai/gpt-oss-120b:nitro`
  - Suggested role: worker.
  - Fast, cheap, consistent.

- **Strategist GLM 4.7**: `z-ai/glm-4.7:nitro`
  - Suggested role: reviewer/planner.
  - Better local quality score, higher cost.

- **Mercury 2**: `inception/mercury-2:nitro`
  - Suggested role: alternate worker.
  - Fast but had strict-output misses in fleet tests.

- **Custom OpenRouter Model**
  - Suggested role: experiment.
  - Must pass schema and deadline tests before being added to the fleet.

No `max_tokens` or `maxOutputTokens`.

## Game Loop

1. Operator creates a room.
2. Operator enters Model Lab and tests models under a clock and budget.
3. Operator builds an agent form: fleet size, model per agent, role per agent, budget policy.
4. `submit_goal` creates the root task.
5. Agent clients call `claim_task`.
6. Claimed tasks show a two-second countdown.
7. Agent result returns as strict structured output.
8. `post_result` applies it only if the task is still valid and within policy.
9. Child tasks spawn until depth/task budget is exhausted.
10. Operators intervene when the swarm branches badly.
11. The run ends when no actionable tasks remain, the budget is exhausted, or the operator stops the mission.

## Scoring

Score gives the app game energy without compromising the real architecture.

Positive:

- On-time valid result.
- Useful child tasks spawned.
- Branch completed under budget.
- Human override prevents a bad branch.
- Final synthesis completed.

Penalties:

- Missed two-second deadline.
- Invalid structured output.
- Duplicate child task.
- Task blocked after max attempts.
- Branch hits depth or task budget.
- Agent heartbeat expires while holding a task.

Visible run stats:

- Completion percent.
- Average latency.
- On-time rate.
- Valid-output rate.
- Model split: Racer vs Strategist.
- Estimated model cost.
- Human saves.
- Budget remaining.

## First Screen

The first screen is the actual mission-control app.

Layout:

- Left rail: room, operators, mission/rules, fleet controls.
- Center: live task graph.
- Right rail: selected task inspector and override buttons.
- Bottom: event stream terminal.
- Top strip: mission status, score, budget, latency, on-time rate.

Core visual cues:

- Agent nodes pulse while working.
- Claimed tasks show model badge and countdown ring.
- On-time completions flash green.
- Late/invalid results flash red and stream into the event log.
- Human override creates a visible command event.
- Task tree edges animate when children spawn.

## MVP Screens

0. **Mission Setup**
   - Pick mission template.
   - Show win condition.
   - Set time limit, budget, per-task deadline, max tasks, and max depth.
   - Enter OpenRouter League.
   - Assign models to agent slots.
   - Explain rules in a compact How To Play strip.

1. **Model Lab**
   - Test suggested OpenRouter models.
   - Add custom model ID.
   - Run schema, mission, and fleet tests.
   - Track testing time, budget, p50/p95, valid rate, cost, and quality.

2. **Agent Form**
   - Assign model and role to each agent slot.
   - Set retry/deadline/budget policy.
   - Show estimated run cost.

3. **Room Lobby**
   - Create or join room.
   - Pick display name.
   - See connected operators.

4. **Mission Control**
   - Submit goal.
   - Review selected fleet and run constraints.
   - Set fleet size, max depth, max tasks, deadline.
   - Start/stop mission.

5. **Live Graph**
   - Task nodes by status.
   - Agent assignment.
   - Parent/child structure.
   - Click to inspect task.

6. **Task Inspector**
   - Title, status, depth, attempts.
   - Assigned agent and model.
   - Result/risk/confidence.
   - Children.
   - Pause/resume/cancel/redirect buttons.

7. **Event Console**
   - Goal submitted.
   - Agent registered.
   - Task claimed.
   - Result posted.
   - Children spawned.
   - Deadline missed.
   - Human override.

8. **Scoreboard**
   - Current run score.
   - Model stats.
   - Cost estimate.
   - Run summary.

## SpacetimeDB Tables

`room`

- `id`
- `name`
- `created_by`
- `created_at`
- `status`

`operator`

- `identity`
- `room_id`
- `display_name`
- `selected_task_id`
- `last_heartbeat`

`goal`

- `id`
- `room_id`
- `title`
- `status`
- `max_depth`
- `max_tasks`
- `deadline_ms`
- `created_by`
- `created_at`

`task`

- `id`
- `room_id`
- `goal_id`
- `parent_id`
- `title`
- `status`
- `depth`
- `attempts`
- `assigned_agent_id`
- `assigned_model`
- `claimed_at`
- `deadline_ms`
- `result`
- `risk`
- `confidence`
- `created_at`
- `updated_at`

`agent`

- `id`
- `room_id`
- `name`
- `model`
- `status`
- `current_task_id`
- `latest_thought`
- `last_heartbeat`

`event`

- `id`
- `room_id`
- `goal_id`
- `task_id`
- `agent_id`
- `operator_id`
- `kind`
- `message`
- `created_at`

`score`

- `room_id`
- `goal_id`
- `points`
- `valid_results`
- `late_results`
- `invalid_results`
- `human_overrides`
- `estimated_cost_micros`

## Reducers

`create_room(display_name)`

- Creates a room and operator presence.

`join_room(room_id, display_name)`

- Adds or refreshes operator presence.

`submit_goal(room_id, title, max_depth, max_tasks, deadline_ms, default_model)`

- Creates goal and root task.
- Emits `goal_submitted`.

`register_agent(room_id, name, model)`

- Creates or refreshes an agent.
- Model must be present in the room's tested model bench unless the room is using a fixed suggested preset.

`claim_task(room_id, agent_id)`

- Atomic reducer.
- Finds one pending task in the room.
- Assigns it to the agent.
- Sets `claimed_at`, `deadline_ms`, `attempts += 1`.
- Emits `task_claimed`.

`post_result(agent_id, task_id, worker_result, latency_ms, estimated_cost_micros)`

- Verifies task is still assigned to agent.
- Rejects late results according to stored deadline.
- Rejects child spawns over max depth/task budget.
- Marks task done/blocked.
- Creates child tasks when valid.
- Updates score.
- Emits result and spawn events.

`human_override(room_id, task_id, action, payload)`

- Pause, resume, cancel, redirect, reassign, merge duplicate.
- Emits `human_override`.

`heartbeat_agent(agent_id, status, latest_thought)`

- Keeps agent presence live.

`heartbeat_operator(room_id, selected_task_id)`

- Keeps human presence live.

## Agent Runner

Node process running N agents.

Each agent:

1. Registers with room and assigned OpenRouter model.
2. Loops while mission active.
3. Calls `claim_task`.
4. Builds prompt from goal, task, ancestors, sibling context, and recent events.
5. Calls OpenRouter with strict structured output.
6. Validates result with Zod.
7. Calls `post_result`.
8. On timeout or validation failure, calls `post_result` as blocked/invalid.

Worker result schema should stay compact:

- `decision`
- `diagnosis`
- `reducer_action`
- `client_action`
- `spawn_policy`
- `operator_message`
- `child_1`
- `child_2`
- `child_3`
- `child_4`
- `risk`
- `confidence`

## Demo Mission Templates

Use templates that show branching but do not require real web research.

1. **Real-Time Database Competitive Analysis**
   - Good for final synthesis and judge relevance.

2. **Fix a Failing Swarm Demo**
   - Forces agents to reason about claim races, duplicate spawns, stale workers, graph lag, and budgets.

3. **Launch Plan Under Deadline**
   - Forces project decomposition and visible task expansion.

4. **Incident War Room**
   - Simulated production incident with logs and competing priorities.

Recommended live demo mission:

> Fix a failing SpacetimeDB AI swarm demo where duplicate tasks appear, one agent is stale, and the graph lags behind events.

This mission showcases why transactional reducers matter.

## Build Order

1. SpacetimeDB module tables and reducers.
2. Reducer smoke calls from CLI.
3. TypeScript bindings.
4. Node agent runner with selected OpenRouter models.
5. Model Lab and Agent Form UI.
6. React app shell with subscriptions.
7. Event console and operator presence.
8. Task graph.
9. Task inspector and human override.
10. Scoreboard and deadline/cost stats.
11. Demo mission templates.

## Scope Cuts If Time Gets Tight

Cut:

- Fancy force physics.
- Custom room browser.
- Long-term run history.
- Full final report generation.
- Complex model quality scoring.

Do not cut:

- Atomic `claim_task`.
- Two human clients live.
- Multiple agent clients live.
- Strict structured output.
- Deadline handling.
- Event stream.
- Human override.

## Judge Pitch

The core line:

> Multi-agent systems are a blackboard concurrency problem. In most AI frameworks you hand-roll queues, locks, and lease recovery. Here the shared blackboard is SpacetimeDB, and `claim_task` is a transactional reducer, so two agents cannot claim the same task. Humans and agents are just synced clients writing to the same real-time state.

Then show it:

1. Start mission.
2. Agents race.
3. One task gets claimed exactly once.
4. Model results arrive under deadline.
5. Children spawn.
6. Human pauses a bad branch from another laptop.
7. Everyone sees it instantly.
