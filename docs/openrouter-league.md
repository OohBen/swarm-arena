# OpenRouter League

## Core Game

OpenRouter League is the primary game mode.

Players are given:

- A mission.
- A testing window.
- A testing budget.
- A short agent-build window.
- A live run with a time limit and run budget.

The strategic question:

> Which model fleet can finish the mission fastest, cheapest, and most reliably under hard constraints?

This turns model choice into gameplay. A slow expensive model might be smarter, but if it misses task deadlines or burns budget, it loses.

## Match Flow

### 1. Pick Mission

Players choose a mission template or custom mission.

Recommended templates:

- Fix Failing Swarm Demo.
- Incident War Room.
- Realtime DB Competitive Analysis.
- Launch Plan Under Deadline.

Mission config includes:

- Critical paths.
- Expected task depth.
- Max tasks.
- Starting budget.
- Live run time limit.
- Per-task deadline.

### 2. Model Lab

Players get a short sandbox to test models before the real run.

Default full-game settings:

- Testing time: `5:00`.
- Testing budget: `$2.00`.
- Test prompts: generated from the selected mission.
- Output contract: strict structured output.
- Metrics: latency, p95, validity, estimated cost, quality score.

Hackathon demo settings:

- Testing time: `2:00`.
- Testing budget: `$0.25`.
- Enough to show the mechanic without eating the demo.

What players can do:

- Search/select any OpenRouter model ID.
- Run a simple schema test.
- Run a mission-like task test.
- Run a small concurrent/fleet test.
- Save a model into the bench.
- Compare model cards.

Model card fields:

- Model name.
- Provider route.
- Speed: p50 / p95.
- Valid-output rate.
- Quality score.
- Cost per call.
- Suggested role.
- Last test result.

Suggested starting picks:

- `openai/gpt-oss-120b:nitro`: default fast worker.
- `z-ai/glm-4.7:nitro`: reviewer/strategist.
- `inception/mercury-2:nitro`: fallback/alternate fast worker.
- `google/gemini-3.1-flash-lite:nitro`: experimental.
- `deepseek/deepseek-v4-flash:nitro`: slower reasoning lane.

The app should warn that non-suggested models may fail schema or miss deadlines.

### 3. Agent Form

Players build the fleet.

Full-game settings:

- Build time: `3:00`.

Hackathon demo settings:

- Build time: `1:00`.

Agent form choices:

- Fleet size.
- Model per agent.
- Agent role.
- Max task depth.
- Per-task deadline.
- Retry policy.
- Escalation policy.
- Budget cap per agent.

Agent roles:

- **Worker**: fast task execution.
- **Planner**: spawns child tasks.
- **Reviewer**: checks risky results.
- **Fixer**: handles blocked or duplicate tasks.
- **Closer**: final synthesis / report.

MVP can keep roles as labels only. The first implementation can use the same loop for every role and vary only the prompt.

### 4. Live Run

The run starts after the build window.

Default full-game settings:

- Run time: `10:00`.
- Run budget: configurable, default `$2.00`.
- Per-task deadline: `2.0s`.

Hackathon demo settings:

- Run time: `5:00`.
- Run budget: `$0.50`.
- Per-task deadline: `2.0s`.

Live run rules:

- Agents claim tasks through SpacetimeDB.
- The model call starts a deadline timer.
- Results must be valid strict structured output.
- Late results do not mutate the task tree.
- Over-budget agents are stopped.
- Invalid results create visible penalties.
- Human overrides can save bad branches.

### 5. Scoreboard

Scoreboard compares:

- Mission completion.
- Time used.
- Budget used.
- On-time rate.
- Valid-output rate.
- Average latency.
- p95 latency.
- Human saves.
- Atomic claims.
- Duplicate/late/invalid penalties.
- Cost by model.
- Best model value: points per dollar.

## Budget Model

There are two budgets:

1. **Testing budget**: spent during Model Lab.
2. **Run budget**: spent during the live mission.

The app budget is a soft game budget enforced locally:

- Estimate cost from OpenRouter model pricing and returned token usage.
- Subtract from the game budget.
- Stop agents when the game budget is exhausted.

This does not need to be a hard OpenRouter account-level spending limit for MVP. The app should stop making calls when its game budget is exhausted.

## Timing Model

There are three clocks:

1. Model Lab clock.
2. Agent Form clock.
3. Live Run clock.

Every task also has its own deadline.

Recommended defaults:

| Mode | Model Lab | Agent Form | Live Run | Test Budget | Run Budget | Task Deadline |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Demo | 2:00 | 1:00 | 5:00 | $0.25 | $0.50 | 2.0s |
| Full Match | 5:00 | 3:00 | 10:00 | $2.00 | $2.00 | 2.0s |
| Speed Round | 1:00 | 0:30 | 3:00 | $0.10 | $0.25 | 1.5s |

## Suggested UI

### Mission Setup

Shows:

- Mission picker.
- Win condition.
- Rule summary.
- Timers and budgets.

### Model Lab

Shows:

- Search model ID.
- Suggested model shelf.
- Test prompt preview.
- Run simple test.
- Run mission test.
- Run fleet test.
- Model leaderboard.
- Remaining lab time and budget.

### Agent Form

Shows:

- Agent slots.
- Role selector.
- Model selector.
- Budget cap.
- Deadline policy.
- Retry policy.
- Estimated run cost.

### Live Run

Shows:

- Task graph.
- Agent roster.
- Event stream.
- Selected task inspector.
- Model/cost/latency metrics.
- Human override controls.

### Scoreboard

Shows:

- Winner/mission result.
- Score.
- Cost and latency table by model.
- Atomic claim stats.
- Human save stats.
- Replay timeline.

## What To Build First

MVP order:

1. Mission Setup with fixed templates.
2. Model Lab with suggested model cards and one custom model field.
3. Agent Form with 3-6 agent slots.
4. Live Run using the selected model per agent.
5. Scoreboard with cost/latency stats.

Cut if time is tight:

- Full model search.
- Rich custom role logic.
- Many mission templates.
- Replay controls.

Do not cut:

- Model Lab.
- Agent Form.
- App-enforced budget.
- App-enforced per-task deadline.
- Strict structured output validation.
- SpacetimeDB atomic `claim_task`.

