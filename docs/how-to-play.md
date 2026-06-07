# Swarm Arena: How To Play

## Core Fantasy

You are not chatting with an agent. You are commanding a fleet.

Swarm Arena is a multiplayer strategy/ops game where a team of humans deploys AI agents into a shared real-time task graph. The agents race to complete a mission before the clock and model budget run out. Every mutation goes through SpacetimeDB, so the board stays consistent even when many agents and humans act at once.

## Win Condition

Complete all critical mission tasks before:

- The mission timer expires.
- The model budget is spent.
- The task budget is exhausted.
- Too many critical branches become blocked or invalid.

The app should always make this visible:

- Time remaining.
- Budget remaining.
- Critical tasks remaining.
- Active agents.
- On-time rate.
- Valid-output rate.

## What The Player Does

Players are human operators.

They do six things:

1. Choose the mission.
2. Spend a limited Model Lab window testing OpenRouter models.
3. Pick constraints: time limit, budget, max tasks, max depth, per-task deadline.
4. Build an agent fleet by assigning models and roles.
5. Start the mission and watch the swarm work.
6. Intervene when the swarm goes wrong.

The main controls:

- Start or pause the fleet.
- Change an agent model.
- Pause a branch.
- Merge duplicate children.
- Redirect an agent.
- Cancel a task.
- Mark a task as critical.
- Ask Strategist GLM 4.7 to review a risky branch.

## What Agents Do

Agents are SpacetimeDB clients.

Loop:

1. Register in the room.
2. Call `claim_task`.
3. If a task is claimed, start a local deadline timer.
4. Call the selected model.
5. Validate strict structured output.
6. Call `post_result`.
7. Spawn children only if depth/task budget allows it.
8. Heartbeat while alive.

The important point: agents do not own the board. SpacetimeDB does.

## Model Leagues

### OpenRouter League

This is the main game mode.

Operators can choose any OpenRouter model, but the same constraints apply:

- The model must return strict structured output.
- The result must arrive before the task deadline.
- The call must fit inside the remaining model budget.
- Late results become penalties.
- Over-budget agents stop.
- Invalid results do not mutate the task graph.

This makes model choice part of the game. A slower model might produce better plans, but if it misses the deadline, it loses.

The game includes two pre-run phases:

- **Model Lab**: test models under a lab clock and lab budget.
- **Agent Form**: build your fleet from the models you tested.

Default full-match settings:

- Model Lab: `5:00`.
- Testing budget: `$2.00`.
- Agent Form: `3:00`.
- Live Run: `10:00`.
- Live Run budget: `$2.00`.
- Per-task deadline: `2.0s`.

Hackathon demo settings:

- Model Lab: `2:00`.
- Testing budget: `$0.25`.
- Agent Form: `1:00`.
- Live Run: `5:00`.
- Live Run budget: `$0.50`.
- Per-task deadline: `2.0s`.

Suggested models:

- `openai/gpt-oss-120b:nitro`: default fast worker.
- `z-ai/glm-4.7:nitro`: reviewer/strategist.
- `inception/mercury-2:nitro`: fallback fast worker.
- `google/gemini-3.1-flash-lite:nitro`: experimental.
- `deepseek/deepseek-v4-flash:nitro`: slower reasoning lane.

### Cerebras Sprint

This is the curated fast preset inside OpenRouter League.

Allowed lanes:

- **Racer 120B**: `openai/gpt-oss-120b:nitro`
- **Strategist GLM 4.7**: `z-ai/glm-4.7:nitro`

Both are pinned to Cerebras:

```ts
provider: {
  only: ["Cerebras"],
  allow_fallbacks: false,
  require_parameters: true,
  sort: "throughput"
}
```

Use this mode for the judged demo because it is fast, consistent, and easy to explain.

## Scoring

Start simple.

Positive points:

- `+100` on-time valid task result.
- `+50` useful child task spawned.
- `+250` critical task completed.
- `+150` human override prevents late/duplicate/blocked branch.
- `+500` mission completed.

Penalties:

- `-50` missed deadline.
- `-100` invalid structured output.
- `-100` duplicate child detected.
- `-150` task blocked after max attempts.
- `-200` stale agent lease recovery.
- `-250` budget exhausted.

Score is less important than clarity. It gives the audience a reason to understand the constraints quickly.

## Mission Templates

### 1. Fix Failing Swarm Demo

Best live demo mission.

Briefing:

> The swarm demo is failing. Duplicate tasks are appearing, one agent is stale, and the task graph is lagging behind events. Diagnose root causes and fix the system.

Why it works:

- Shows atomic claims.
- Shows duplicate spawn as a different idempotency issue.
- Shows human override.
- Shows SpacetimeDB event stream.

### 2. Real-Time DB Competitive Analysis

Good judge-facing mission.

Briefing:

> Produce a competitive analysis of real-time databases and explain where SpacetimeDB is uniquely strong.

Why it works:

- Creates readable output.
- Lets final synthesis use Strategist GLM 4.7.
- Connects directly to judging criteria.

### 3. Incident War Room

Good ops-game mission.

Briefing:

> A simulated production system is degrading. Triage logs, isolate root causes, and produce a recovery plan before the incident budget runs out.

Why it works:

- Intuitive to spectators.
- Makes deadlines and model latency feel natural.

### 4. Launch Plan Under Deadline

Good general-purpose mission.

Briefing:

> Build a launch plan for a product demo under hard time and budget constraints.

Why it works:

- Easy to understand.
- Produces clean task decomposition.

## What Must Be Obvious On Screen

The UI must answer these questions without explanation:

1. What mission are we trying to finish?
2. How much time is left?
3. How much budget is left?
4. Which agents are active?
5. Which model is each agent using?
6. Which task is claimed right now?
7. Did the task beat the deadline?
8. Did the result pass validation?
9. What did SpacetimeDB accept?
10. What did a human override?

## Demo Beat

Use this script live:

1. Open two clients in the same room.
2. Choose **Fix Failing Swarm Demo**.
3. Enter **Model Lab** with `2:00` and `$0.25`.
4. Test `openai/gpt-oss-120b:nitro`, `z-ai/glm-4.7:nitro`, and one custom OpenRouter model.
5. Enter **Agent Form** with `1:00`.
6. Assign most agents to the fastest valid model and one reviewer to the higher-quality model.
7. Start mission with `5:00`, `$0.50`, and a `2.0s` task deadline.
8. Point to task graph expanding.
9. Point to `task_claimed` events and say `claim_task` is transactional.
10. Let duplicate spawned children appear.
11. From second client, click **Merge Duplicates** or **Pause Branch**.
12. Show everyone sees the override instantly.
13. End on scoreboard: on-time rate, valid-output rate, atomic claims, human saves, cost.

## Why This Wins

This is not "LLM wrapper plus realtime backend."

The hard part of multi-agent coordination is shared mutable state:

- Who owns this task?
- Can two agents claim it?
- What happens if one dies?
- Can a human override the branch?
- Does every client see the same truth?

SpacetimeDB is the product backbone because reducers make the shared blackboard transactional and subscriptions make the board live.
