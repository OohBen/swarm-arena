# Swarm Arena Battle Mode

Status: multiplayer lobby and battle mode implemented locally and verified, June 7, 2026.

## One-line pitch

Two AI swarms fight over the same live SpacetimeDB battle map. Humans are commanders: they choose priorities and spend limited orders, while the agents do most of the scouting, assaulting, defending, sabotaging, and replanning.

## Core mode

This is a mix of territory control and HQ capture.

- Blue swarm: drafted and commanded by one human.
- Red swarm: drafted and commanded by a second human.
- Primary win: capture/crack the enemy HQ.
- Secondary win: if the clock or supplies expire, the team with stronger map control wins.
- The match must be watchable for several minutes, not a chore race that ends in one burst.

Current tuning:

- Default draft: each side starts from 1 command model + 2 field models, then can customize independently before locking.
- Deadline: 3 seconds per combat action.
- Runner pace: 8 seconds between actions by default.
- Reducer cap: 2 active battle tasks per team, plus human orders.
- Orders: spend a command token, immediately nudge the selected node, and enqueue a high-priority AI task.
- Battle crises: disabled; commander orders are the human steering layer.

## Why this fits SpacetimeDB

The battle is a shared mutable blackboard. Every agent and human is a client writing to one source of truth.

The flex is still atomic reducers:

- Two agents cannot both claim the same combat opportunity.
- Two teams cannot both resolve the same contested objective as captured.
- Human orders, AI results, supply penalties, and combat outcomes all land in one transaction log.

In the demo, say: "Our combat system is the blackboard problem. The database reducer is the lock."

## Player loop

1. Blue hosts a battlefield room and sends the room URL to Red.
2. Blue and Red each draft a swarm from the OpenRouter model roster.
3. Both commanders lock their drafts. The `submit_draft` reducer starts the match only after both sides are ready and valid.
4. Watch both swarms race for neutral ground and probe each other's front line.
5. Spend limited command orders for your own side to swing a live node.
6. Watch the immediate command surge land, then see your agents carry the order through the reducer queue while the enemy keeps advancing through the same rules.
7. Win by cracking enemy HQ, or by holding more ground when the timer/supplies run out.

Humans should feel like commanders, not task workers. The fun is deciding where to push, when to defend, and when to spend a scarce order.

## Battle map

The current task tree becomes a war map with lanes and ownership.

Node types:

- HQ: team core. Capturing or reducing it wins the match.
- Strongpoint: high-value territory, slows enemy advances.
- Relay: enables deeper attacks into adjacent territory.
- Supply depot: increases team supply or command-token regen.
- Forward post: normal capture point.

Node state:

- `owner`: neutral, blue, red, or contested.
- `lane`: top, center, bottom, or custom.
- `adjacent_keys`: legal attack routes.
- `fortification`: defensive strength.
- `blue_pressure` / `red_pressure`: current assault pressure.
- `blue_pressure` / `red_pressure` render as the visible tug-of-war meter.
- `hq_integrity`: only for HQ nodes.

Map rule: agents can attack neutral nodes adjacent to owned nodes, or enemy nodes once a route exists. This creates a readable front line.

## Agents

Agents are AI units, not just workers.

COMMAND agents:

- Read the map.
- Propose priorities.
- Spawn tactical tasks for field agents.
- Decide when to reinforce, probe, or exploit a lane.

FIELD agents:

- Scout neutral/enemy nodes.
- Assault objectives.
- Defend owned objectives.
- Sabotage enemy nodes or agents.
- Repair/fortify friendly nodes.

Suggested roles:

- Scout: fast claims, reveals enemy intent, cheaper but weaker.
- Striker: wins assaults, higher cost.
- Engineer: fortifies and repairs.
- Saboteur: disrupts enemy pressure or supply.
- Commander: assigns priorities and resolves strategic tasks.

## Human controls

Keep this high-leverage and limited.

- Priority marker: "main effort" on one objective.
- Secondary marker: "hold this" on one friendly objective.
- Order cards: assault, defend, sabotage, reinforce, retreat/reroute.
- Optional stance: aggressive, balanced, defensive, economy.

Use command tokens so humans cannot spam perfect control. Example: one order every 20-30 seconds, plus bonus tokens from supply depots.

## Combat model

A contested node is a shared objective both teams can pressure.

Basic flow:

1. Agent claims a battle task atomically.
2. Runner calls the chosen model with structured output.
3. Result posts pressure, fortification damage, sabotage, or capture progress.
4. Reducer checks whether the node flips, becomes contested, or damages HQ.
5. Events stream the outcome to all clients.

Fast models matter because slow agents miss tempo windows. Expensive models can be stronger, but burn supply. That preserves the OpenRouter league idea inside the war game.

## Backend shape

Keep the module TypeScript-only.

Table additions or changes:

- `operator`: now carries `team` and `ready`, so humans claim Blue/Red and lock drafts.
- `draft_slot`: pre-battle team drafts. Copied into `crew_slot` when both sides lock.
- `team_state`: room, team, supply, morale, command tokens, hq integrity, status.
- `battle_node`: room, node key, lane, kind, owner, position, adjacency, fortification, pressure, HQ integrity.
- `battle_order`: room, team, target node, order type, priority, expires at, issued by.
- `battle_result`: optional per-action combat telemetry for scoring and replay.
- Existing `task`: add team, target node, action type, and combat fields, or replace mission tasks with battle tasks for this mode.

Reducers:

- `create_room`: creates a setup lobby and assigns the creator to Blue.
- `join_room`: assigns a second human to Red or a spectator seat; side claim is atomic.
- `submit_draft`: writes a team's draft, locks readiness, validates both teams, and starts the battle once both sides are ready.
- `issue_order`: human spends command token and writes an order.
- `claim_task`: keep atomic; scope by team, role, target node, and current battle state.
- `post_result`: applies structured agent result to node/team state and spawns follow-up tasks.
- `resolve_node`: flips ownership or damages HQ when pressure thresholds are met.
- `battle_tick`: scheduled pacing, command-token regen, stale-order cleanup, and battle task seeding.

Do not add random client-side combat. Reducers own the authoritative outcome.

## UI shape

Stay with the paper war-room aesthetic.

Run screen:

- Center: paper battle map with blue/red front line, HQs, lanes, contested nodes, and moving agent counters.
- Left: Blue command panel with orders, tokens, selected objective, and crew status.
- Right: Red intelligence panel with visible enemy pressure and partial unknowns.
- Bottom: event ticker / radio log.
- Right panel: selected node details and command-order controls.

Visual priority:

- Blue/red territory should be legible in one glance.
- Contested objectives should pulse or stamp visibly.
- HQ threat must be obvious.
- Human order effects should draw arrows or command marks on the map.

## Pacing targets

- Demo match length: 3-6 minutes.
- First contested node: within 15 seconds.
- First human decision: within 30 seconds.
- HQ threat: visible by 60-90 seconds.
- Comeback lever: at least one human order can meaningfully change the front.

## Scoring

After-action report should show:

- Winner and win condition.
- Territory held.
- HQ integrity.
- Supply spent.
- Agent costs and latency.
- Successful claims / failed claims.
- Human orders issued.
- Best-performing model/unit.

## Demo beat

1. Blue opens a room; Red joins from the room link.
2. Both humans draft different AI fleets and lock.
3. SpacetimeDB starts Blue vs Red on a three-lane map.
4. Both swarms rush neutral relays.
5. One contested relay is decided by an atomic claim.
6. Each human spends a command order on the same contested node.
7. The map shifts live, then AI agents keep fighting from the updated state.

The judge-facing story: "This is multiplayer state, AI coordination, and transactional combat all using SpacetimeDB as the core backend."
