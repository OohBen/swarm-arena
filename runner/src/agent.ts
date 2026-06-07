import { DbConnection } from './module_bindings';
import { runWorker } from './openrouter';

export interface AgentConfig {
  uri: string;
  db: string;
  roomId: bigint;
  name: string;
  model: string;
  role: string; // 'lead' | 'worker' | 'reviewer'
  team?: string; // 'blue' | 'red'
  tickMs?: number;
}

// One Swarm agent = one persistent SpacetimeDB connection running a claim/work/post
// loop. State is read from the local subscription cache; all mutations go through
// reducers. The agent never owns the board — SpacetimeDB does.
export class Agent {
  private conn: DbConnection | null = null;
  private agentId: bigint | null = null;
  private subscribed = false;
  private processing = false;
  private claimInFlight = false;
  private lastIdleHeartbeat = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private cfg: AgentConfig) {}

  start(): void {
    this.conn = DbConnection.builder()
      .withUri(this.cfg.uri)
      .withDatabaseName(this.cfg.db)
      .onConnect((conn) => this.onConnect(conn))
      .onConnectError((_ctx, err) => console.error(`[${this.cfg.name}] connect error: ${err.message}`))
      .onDisconnect(() => console.log(`[${this.cfg.name}] disconnected`))
      .build();
  }

  // Stand the crew member down (mission over / slot recycled).
  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    try {
      (this.conn as any)?.disconnect?.();
    } catch {
      /* already gone */
    }
  }

  private onConnect(conn: DbConnection): void {
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        this.subscribed = true;
        this.afterSubscribed(conn);
      })
      .subscribe([
        `SELECT * FROM goal WHERE room_id = ${this.cfg.roomId}`,
        `SELECT * FROM task WHERE room_id = ${this.cfg.roomId}`,
        `SELECT * FROM agent WHERE room_id = ${this.cfg.roomId}`,
        `SELECT * FROM event WHERE room_id = ${this.cfg.roomId}`,
        `SELECT * FROM battle_node WHERE room_id = ${this.cfg.roomId}`,
        `SELECT * FROM team_state WHERE room_id = ${this.cfg.roomId}`,
        `SELECT * FROM battle_order WHERE room_id = ${this.cfg.roomId}`,
      ]);
  }

  private afterSubscribed(conn: DbConnection): void {
    conn.reducers.registerAgent({
      roomId: this.cfg.roomId,
      name: this.cfg.name,
      model: this.cfg.model,
      role: this.cfg.role,
      team: this.cfg.team ?? 'blue',
    });
    console.log(`[${this.cfg.name}] registered as ${this.cfg.team ?? 'blue'} ${this.cfg.role} on ${this.cfg.model}`);
    this.tickTimer = setInterval(() => {
      this.tick().catch((e) => console.error(`[${this.cfg.name}] tick error: ${String(e)}`));
    }, this.cfg.tickMs ?? 400);
  }

  private findMe(): any {
    const conn = this.conn!;
    for (const a of conn.db.agent.iter()) {
      if (a.name === this.cfg.name && a.roomId === this.cfg.roomId) return a;
    }
    return null;
  }

  private async tick(): Promise<void> {
    const conn = this.conn;
    if (!conn || !this.subscribed || this.processing) return;

    const me = this.findMe();
    if (!me) return; // registration not yet visible in cache
    this.agentId = me.id;

    // Hold a task → work it.
    if (me.currentTaskId !== undefined && me.currentTaskId !== null) {
      await this.processTask(me.currentTaskId);
      return;
    }

    // Idle: keep presence fresh and race for a pending task.
    const now = Date.now();
    if (now - this.lastIdleHeartbeat > 2000) {
      this.lastIdleHeartbeat = now;
      conn.reducers.heartbeatAgent({ agentId: me.id, status: 'idle', latestThought: me.latestThought ?? '' });
    }

    if (me.status === 'idle' && !this.claimInFlight && this.hasPendingTask()) {
      this.claimInFlight = true;
      conn.reducers.claimTask({ roomId: this.cfg.roomId, agentId: me.id });
      // Cleared on the next tick after the claim applies (or times out harmlessly).
      setTimeout(() => {
        this.claimInFlight = false;
      }, 700);
    }
  }

  private hasPendingTask(): boolean {
    const conn = this.conn!;
    for (const t of conn.db.task.iter()) {
      if (t.roomId === this.cfg.roomId && t.status === 'pending') return true;
    }
    return false;
  }

  private buildContext(task: any): { system: string; prompt: string } {
    const conn = this.conn!;
    const goal = conn.db.goal.id.find(task.goalId);
    const node =
      task.targetNodeId !== undefined && task.targetNodeId !== null
        ? conn.db.battleNode.id.find(task.targetNodeId)
        : null;
    const team = task.team ?? this.cfg.team ?? 'blue';
    const enemy = team === 'blue' ? 'red' : 'blue';

    const ancestors: string[] = [];
    let cur =
      task.parentId !== undefined && task.parentId !== null ? conn.db.task.id.find(task.parentId) : null;
    let guard = 0;
    while (cur && guard++ < 12) {
      ancestors.unshift(cur.title);
      cur =
        cur.parentId !== undefined && cur.parentId !== null ? conn.db.task.id.find(cur.parentId) : null;
    }

    const recent = [...conn.db.event.iter()]
      .filter((e: any) => e.roomId === this.cfg.roomId)
      .sort((a: any, b: any) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, 6)
      .map((e: any) => `- ${e.kind}: ${e.message}`)
      .reverse();

    const maxDepth = goal?.maxDepth ?? 3;
    const atMaxDepth = task.depth >= maxDepth;

    if (node) {
      const nodes = [...conn.db.battleNode.iter()]
        .filter((n: any) => n.roomId === this.cfg.roomId && n.goalId === task.goalId)
        .sort((a: any, b: any) => (a.x === b.x ? a.y - b.y : a.x - b.x));
      const map = nodes
        .map(
          (n: any) =>
            `- ${n.name}: owner=${n.owner}, status=${n.status}, fort=${n.fortification}, blue_pressure=${n.bluePressure}, red_pressure=${n.redPressure}` +
            (n.kind === 'hq' ? `, hq=${n.hqIntegrity}` : '')
        )
        .join('\n');
      const teamRows = [...conn.db.teamState.iter()]
        .filter((s: any) => s.roomId === this.cfg.roomId && s.goalId === task.goalId)
        .map((s: any) => `${s.team}: HQ ${s.hqIntegrity}, morale ${s.morale}, orders ${s.commandTokens}`)
        .join(' | ');
      const orders = [...conn.db.battleOrder.iter()]
        .filter((o: any) => o.roomId === this.cfg.roomId && o.goalId === task.goalId && o.team === team && o.status === 'active')
        .slice(-4)
        .map((o: any) => `- ${o.orderType} node#${o.targetNodeId}`)
        .join('\n');

      const system = [
        `You are a ${team.toUpperCase()} AI combat unit in Swarm Arena, a two-swarm battle run through SpacetimeDB reducers.`,
        `Enemy team: ${enemy.toUpperCase()}. Humans command intent; AI agents execute.`,
        'Return STRICT structured JSON matching the schema.',
        'For combat tasks, almost always use outcome="done"; the server turns your result into combat pressure, capture progress, defense, sabotage, or HQ damage.',
        'Use outcome="blocked" only when this action is tactically impossible. Do not spawn children for combat tasks.',
        '"thought" is one short tactical radio update for the live commander UI.',
      ].join('\n');

      const prompt = [
        `BATTLE: ${goal?.title ?? '(unknown)'}`,
        `TEAM: ${team.toUpperCase()}`,
        `ACTION: ${task.actionType}`,
        `TARGET NODE: ${node.name} (${node.kind}, lane=${node.lane})`,
        `TARGET STATE: owner=${node.owner}, status=${node.status}, fortification=${node.fortification}, blue_pressure=${node.bluePressure}, red_pressure=${node.redPressure}, hq_integrity=${node.hqIntegrity}`,
        `TEAM STATE: ${teamRows || '(unknown)'}`,
        orders ? `ACTIVE HUMAN/COMMAND ORDERS:\n${orders}` : '',
        recent.length ? `RECENT BATTLE EVENTS:\n${recent.join('\n')}` : '',
        `FULL MAP:\n${map}`,
        'Write result as the concrete tactical execution of this one action. Mention the intended effect briefly.',
      ]
        .filter(Boolean)
        .join('\n');

      return { system, prompt };
    }

    const roleLine =
      this.cfg.role === 'lead'
        ? 'You are a LEAD strategist. Your job is to break high-level objectives into concrete sub-objectives — strongly prefer "spawn_children".'
        : this.cfg.role === 'reviewer'
          ? 'You are a REVIEWER. Execute carefully and flag risks; prefer "done" with a clear result and an honest "risk".'
          : 'You are a WORKER. Your job is to execute this objective concretely — prefer "done"; only split if genuinely necessary.';

    const system = [
      'You are an agent in a multi-agent swarm solving a mission modeled as a task tree.',
      roleLine,
      'Return STRICT structured JSON matching the schema. Decide the OUTCOME for THIS task only:',
      '- "spawn_children": the task is broad and should be decomposed. Provide 2-4 concrete, non-overlapping subtasks in child_1..child_4; leave unused ones as empty strings.',
      '- "done": the task is concrete/atomic (or at max depth). Put the concrete deliverable in "result"; leave all child_* empty.',
      '- "blocked": you genuinely cannot proceed; explain why in "risk".',
      'Prefer decomposing only while it adds real structure; finish leaf work as "done". Keep strings concise and specific.',
      '"thought" is one short sentence shown live to human operators.',
    ].join('\n');

    const prompt = [
      `MISSION: ${goal?.title ?? '(unknown)'}`,
      `THIS TASK: ${task.title}`,
      `DEPTH: ${task.depth} of max ${maxDepth}`,
      ancestors.length ? `PARENT CHAIN: ${ancestors.join(' > ')}` : 'PARENT CHAIN: (this is the root task)',
      recent.length ? `RECENT SWARM EVENTS:\n${recent.join('\n')}` : '',
      task.depth === 0
        ? 'This is the ROOT task. You MUST decompose it: outcome="spawn_children" with 3-4 major workstreams. Never mark the root "done".'
        : '',
      task.depth > 0 && task.depth < maxDepth
        ? 'If this task is broad enough to split into 2-3 concrete sub-steps, prefer "spawn_children"; otherwise finish it as "done".'
        : '',
      atMaxDepth ? 'You are at MAX DEPTH: do NOT spawn children — mark this task "done" or "blocked".' : '',
    ]
      .filter(Boolean)
      .join('\n');

    return { system, prompt };
  }

  private async processTask(taskId: bigint): Promise<void> {
    const conn = this.conn!;
    const task = conn.db.task.id.find(taskId);
    if (!task || task.status !== 'claimed' || this.agentId === null) return;

    this.processing = true;
    const agentId = this.agentId;

    // Heartbeat throughout the model call so the reaper never reclaims a task
    // from a live-but-busy agent (model calls can outlast the stale threshold).
    const hb = setInterval(() => {
      conn.reducers.heartbeatAgent({
        agentId,
        status: 'working',
        latestThought: `Working: ${task.title}`.slice(0, 140),
      });
    }, 1500);

    try {
      conn.reducers.heartbeatAgent({
        agentId,
        status: 'working',
        latestThought: `Working: ${task.title}`.slice(0, 140),
      });

      const { system, prompt } = this.buildContext(task);
      const { object, latencyMs, estimatedCostMicros } = await runWorker({
        modelId: this.cfg.model,
        system,
        prompt,
      });

      const isCombatTask = task.targetNodeId !== undefined && task.targetNodeId !== null;
      const normalizedOutcome = isCombatTask && object.outcome === 'spawn_children' ? 'done' : object.outcome;
      const children = isCombatTask
        ? []
        : [object.child_1, object.child_2, object.child_3, object.child_4]
        .map((c) => (c ?? '').trim())
        .filter((c) => c.length > 0);

      // The task may have been recovered or reassigned (reaper / commander
      // override) while we were thinking. Abandon gracefully rather than posting
      // into a task we no longer own — that would be rejected server-side.
      const live = conn.db.task.id.find(task.id);
      if (!live || live.status !== 'claimed' || live.assignedAgentId !== agentId) {
        console.log(`[${this.cfg.name}] abandoned "${task.title}" (no longer owned)`);
        return;
      }

      conn.reducers.postResult({
        agentId,
        taskId: task.id,
        worker: {
          outcome: normalizedOutcome,
          result: object.result,
          children,
          risk: object.risk,
          confidence: object.confidence,
        },
        latencyMs,
        estimatedCostMicros,
      });
      console.log(
        `[${this.cfg.name}] ${normalizedOutcome} "${task.title}" ${latencyMs}ms` +
          (children.length ? ` (+${children.length} children)` : '')
      );
      conn.reducers.heartbeatAgent({ agentId, status: 'idle', latestThought: (object.thought ?? '').slice(0, 140) });
    } catch (err: any) {
      const msg = String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 140);
      console.error(`[${this.cfg.name}] worker error on "${task.title}": ${msg}`);
      // Designed failure path: post a visible blocked result rather than let the
      // task hang. The event stream and score reflect it; nothing is hidden.
      conn.reducers.postResult({
        agentId,
        taskId: task.id,
        worker: { outcome: 'blocked', result: 'worker error', children: [], risk: msg, confidence: 'low' },
        latencyMs: 0,
        estimatedCostMicros: 0n,
      });
      conn.reducers.heartbeatAgent({ agentId, status: 'idle', latestThought: 'worker error; task blocked' });
    } finally {
      clearInterval(hb);
      // Deliberate pace so the operation is watchable, not over in 15s. The
      // per-task deadline is unaffected (that's claim→post); this is downtime
      // between objectives. Tunable via SWARM_PACE_MS.
      const pace = Number(process.env.SWARM_PACE_MS ?? 8000);
      if (pace > 0) await new Promise((r) => setTimeout(r, pace));
      this.processing = false;
    }
  }
}
