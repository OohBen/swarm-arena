# Storyboard

**Format:** 1920x1080 landscape
**Audio:** no voiceover in this version; VO script is in `SCRIPT.md` for later recording.
**VO direction:** direct, technical, slightly cinematic; explain the architecture without sounding like a pitch deck.
**Style basis:** `DESIGN.md` and captured Swarm Arena UI.
**Duration:** 132 seconds

## Asset Audit

| Asset | Type | Assign to Beat | Role |
|---|---|---:|---|
| `capture-setup/screenshots/scroll-000.png` | Product screenshot | 2, 3 | Multiplayer lobby, model market, draft mechanics |
| `capture/screenshots/scroll-000.png` | Product screenshot | 1, 5, 6 | Battle board, map, order panel, dispatch feed |
| `capture/assets/svgs/swarm-arena-battle-map.svg` | SVG map capture | 5 | Optional map detail layer |
| Captured fonts | Font assets | all | Saira Condensed, Oswald, IBM Plex Mono/Sans |

## Beat 1 — Cold Open: Agents Need A Battlefield (0:00-0:14)

**Concept:** Start on a tactical document, not a browser. The battle board screenshot sits like evidence on a command table while the thesis stamps in: AI agents are fighting over shared state.

**Visual:** Paper grid fills the frame. A huge `SWARM ARENA` title block lands left. The battle screenshot tilts in as a framed field photograph on the right. Blue and red route lines draw over it. Small task slips pulse around the screenshot: `pending`, `claimed`, `posted`.

**Animation:** Stamp drops, title slides up, screenshot rises from paper, route lines draw, task slips cascade.

**Transition:** Ink wipe sweeps left-to-right into the multiplayer setup.

## Beat 2 — Multiplayer Lobby (0:14-0:33)

**Concept:** Make the multiplayer part unmistakable. Blue and Red are two humans in one room before the agents ever act.

**Visual:** Setup screenshot spans the center in a paper frame. Two commander cards pull out from it: `BLUE HOSTS ROOM`, `RED JOINS LINK`. A room URL strip connects both. Presence dots tick on under `UPLINK LIVE`.

**Animation:** Screenshot slow zoom, commander cards slide in from opposite sides, link line draws between them, presence dots blink.

**Transition:** Vertical rule wipe reveals the model market.

## Beat 3 — Draft The Fleet (0:33-0:52)

**Concept:** Drafting is strategy. Models are not just names; they are classes with point costs, latency, supply cost, and deadline risk.

**Visual:** Six model cards appear as a tactical catalog: Scout, Engineer, Runner, Surveyor, Skirmisher, Analyst. Three meters animate under each: speed, quality, risk. A 14-point cap counter fills and stops at `11/14`.

**Animation:** Cards cascade by row. Point values count up. Risk tags stamp red. Command and Field lanes receive unit counters.

**Transition:** Cards compress into table rows that become SpacetimeDB state tables.

## Beat 4 — SpacetimeDB Is The War Server (0:52-1:15)

**Concept:** Explain why this needs SpacetimeDB. Humans and agents are clients; reducers serialize the fight; tables are the shared battlefield.

**Visual:** Center: large `SPACETIMEDB` ledger box. Left: Blue Commander and Red Commander. Right: AI agents. Below: tables `task`, `battle_node`, `team_state`, `event`. Reducers sit as stamped gates: `issue_order`, `claim_task`, `post_result`, `battle_tick`.

**Animation:** Client arrows draw into SpacetimeDB. Reducer stamps hit in sequence. Tables fill with rows. A red "no double claim" cross-out appears over two agents trying the same task.

**Transition:** `claim_task` stamp expands until it becomes the combat board.

## Beat 5 — Atomic Claim = Combat (1:15-1:39)

**Concept:** The heart of the demo. Every agent sees work, but only one gets the claim. That reducer is the combat lock.

**Visual:** Battle screenshot returns. Three agent cards race toward one task card. `claim_task` flashes. One card locks to the task, the others reroute. A structured JSON result card opens beside it.

**Animation:** Agent cards glide along ruled paths. Claim lock clicks. JSON fields type on: `outcome`, `confidence`, `risk`, `result`. A blue pressure bar grows on a selected node.

**Transition:** Pressure bar becomes the selected node inspector.

## Beat 6 — Humans Command, Agents Execute (1:39-1:56)

**Concept:** Show the player interaction. The human does not complete work manually; the human changes priorities and pressure.

**Visual:** Command panel is enlarged. A command token drops into `ASSAULT`. The selected node gets +18 pressure. A priority task slip appears in the task queue, then an agent claims it.

**Animation:** Token slide, button press depression, pressure bar fill, dispatch event writes into log.

**Transition:** Dispatch feed scrolls into after-action summary.

## Beat 7 — Close: Why It Wins (1:56-2:12)

**Concept:** End with the architecture thesis and live URL. It should be clear, judge-facing, and demo-ready.

**Visual:** Three proof columns: `MULTIPLAYER STATE`, `ATOMIC REDUCERS`, `REAL LLM AGENTS`. Under them: `Two commanders`, `No double claim`, `Strict JSON results`. Final title and URL stamp in.

**Animation:** Columns count in. Dispatch rows scroll faintly behind. Final URL underlines with a drawn rule.

**Transition:** Final fade to paper.

## Production Architecture

```text
videos/swarm-arena-demo/
├── index.html
├── DESIGN.md
├── SCRIPT.md
├── STORYBOARD.md
├── capture/
│   ├── screenshots/
│   ├── assets/
│   └── extracted/
├── capture-setup/
│   ├── screenshots/
│   └── extracted/
└── snapshots/
```
