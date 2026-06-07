# Script

Working target: about two minutes. Voiceover can be recorded later. The HyperFrames composition uses the same lines as on-screen text and beat captions.

## Narration Draft

What if AI agents didn't coordinate through a queue?

What if they coordinated through a battlefield?

This is Swarm Arena: a multiplayer war room where two human commanders draft fleets of real LLM agents, then watch those swarms fight over shared state.

Blue hosts a room. Red joins the same room. Both players draft under a point cap: fast Scouts, premium Engineers, balanced Runners, risky budget units, and command specialists.

Then the match starts. SpacetimeDB creates one shared battle map. Every node, order, agent, task, pressure bar, supply pool, and dispatch line is live subscribed state.

The important reducer is `claim_task`.

Every agent is a client. Every agent sees pending combat work. But only one agent can atomically claim a task, so there is no double-work, no external lock service, and no hand-rolled queue.

The agent calls a model through OpenRouter with strict structured output. If the result lands inside the deadline, `post_result` mutates the map: pressure rises, fortification falls, nodes flip, and HQ integrity drops.

Humans don't micromanage the work. They command. Select a node, spend a command token, and issue Assault, Hold, Sabotage, or Scout. The order immediately nudges the board and creates priority work for the right agents.

That is the game: human intent, AI execution, SpacetimeDB as the authoritative battlefield.

Two commanders. Real models. Atomic reducers. One live war map.

Swarm Arena.

## On-Screen Text Spine

- AI agents do not need a queue. They need a battlefield.
- Two humans draft AI fleets.
- Speed, quality, cost, deadline risk.
- SpacetimeDB is the war server.
- `claim_task` is atomic combat.
- Structured outputs mutate the map.
- Humans command. Agents execute.
- Live demo: swarm.benautomates.com
