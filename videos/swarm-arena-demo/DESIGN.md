# Design System

## Overview

Swarm Arena uses a paper-and-ink war-room interface: tactical map, NATO-style unit counters, stamped labels, thin ruled borders, and dense operational readouts. The visual identity is light, not dark: aged parchment surfaces carry black ink typography with restrained blue and red team colors. Layouts are structured like field documents, with gridded backgrounds, crop marks, command cards, status strips, and dispatch logs. The video should feel like a multiplayer battle plan coming alive on a command table.

## Colors

- **Paper Surface**: `#E8E2D0` - primary parchment background.
- **Raised Paper**: `#F4EFE0` - cards, panels, and callout surfaces.
- **Warm Panel**: `#EFE9D8` - secondary UI cards and draft panels.
- **Ink**: `#1F1B14` - primary type, borders, map labels.
- **Muted Ink**: `#6B6553` - metadata, captions, subdued copy.
- **Blue Team**: `#2E5A8C` - Blue commander, friendly nodes, pressure.
- **Red Team**: `#A8332E` - Red commander, hostile nodes, risk.
- **Paper Shadow**: `#DED7C2` - depth, separators, quiet fill.
- **Warning Amber**: `#B3631A` - dispatch activity and contested readouts.

## Typography

- **Saira Condensed** - main title and tactical headings. Heavy weights 700-800, uppercase, compact, poster-like.
- **Oswald** - labels, stamps, buttons, small section headers. Uppercase with generous letter spacing.
- **IBM Plex Mono** - status strips, reducer names, dispatch feed, model IDs, metrics. Small and precise, tabular.
- **IBM Plex Sans** - longer explanatory text where mono would become too harsh.
- **Hierarchy**: title 96-140px, scene heading 54-76px, body 24-34px, tactical label 16-22px.

## Elevation

Depth comes from physical-document layering rather than glass or glow. Use 1.5-2px ink borders, subtle offset shadows, ruled grid paper, hatch fills, and crop marks. Panels should feel laid on a command table, not floating in a glossy dashboard.

## Components

- **Operation Title Block** - red stamp, huge title, small mono subhead, bottom rule.
- **Commander Panels** - Blue and Red side cards with left colored rails and status labels.
- **Model Market Cards** - gridded tactical cards with point values, model IDs, latency, and risk tags.
- **Battle Map** - large parchment panel with blue/red/neutral nodes, dashed contested routes, pressure bars.
- **Reducer Blackboard** - diagram view where clients, reducers, tables, and agents connect through ruled arrows.
- **Dispatch Feed** - lower terminal-like log with event kind labels and mono event text.
- **Command Inspector** - node card plus Intent/Fight/Agents rows and order buttons.

## Do's and Don'ts

### Do's

- Use the exact paper palette and team colors above.
- Keep borders crisp, square, and document-like.
- Show real UI screenshots inside paper frames with slow camera movement.
- Use animated rules, stamps, counters, and arrows to explain architecture.
- Make SpacetimeDB central: tables, reducers, subscriptions, and atomic `claim_task`.

### Don'ts

- Do not use neon, glassmorphism, dark SaaS dashboards, or purple-blue gradients.
- Do not center every scene as a generic title card.
- Do not make it feel like a static slide deck; every beat needs map movement, counters, arrows, or scrolling logs.
- Do not hide the multiplayer aspect behind generic AI claims.
- Do not invent model names or mechanics that are not in the current game.
