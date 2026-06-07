import { schema, table, t, SenderError } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

// ---------------------------------------------------------------------------
// Swarm Arena — SpacetimeDB module
//
// The shared blackboard for a multiplayer AI-agent ops game. Humans and agents
// are all synced clients writing the same real-time state. The hard part of
// multi-agent coordination — who owns a task, can two agents claim it, what if
// one dies — is owned here by transactional reducers, not a queue + lock layer.
// ---------------------------------------------------------------------------

// Tunables -------------------------------------------------------------------
const STALE_AGENT_MICROS = 10_000_000n; // no heartbeat for 10s = dead crew (margin for cloud jitter)
const REAP_INTERVAL_MICROS = 2_000_000n; // stale-agent sweep cadence
const MAX_ATTEMPTS = 3; // task retries before it is blocked
const LEAD_TIERS = 1; // task depths 0..LEAD_TIERS are Lead (strategy); deeper = Worker
const CRISIS_INTERVAL_MICROS = 9_000_000n; // crisis director cadence
const CRISIS_DEADLINE_MICROS = 16_000_000n; // window to respond before it bites

const CRISIS_KINDS = ['dust_storm', 'supply_leak', 'equipment_failure'];
const CRISIS_MSG: Record<string, string> = {
  dust_storm: 'Dust storm grounding the crew — work is stalling.',
  supply_leak: 'Coolant leak detected — supplies are bleeding out.',
  equipment_failure: 'Critical equipment failure on an objective.',
};

// Score deltas (points is i64 -> bigint)
const PTS_VALID = 100n;
const PTS_CHILD = 50n;
const PTS_MISSION = 500n;
const PTS_OVERRIDE = 150n;
const PEN_LATE = -50n;
const PEN_INVALID = -100n;
const PEN_BLOCKED = -150n;
const PEN_STALE = -200n;

// Tables ---------------------------------------------------------------------

const room = table(
  { name: 'room', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string(),
    created_by: t.identity(),
    created_at: t.timestamp(),
    status: t.string(), // 'setup' | 'running' | 'ended'
  }
);

const operator = table(
  { name: 'operator', public: true },
  {
    identity: t.identity().primaryKey(),
    room_id: t.u64().index('btree'),
    display_name: t.string(),
    selected_task_id: t.option(t.u64()),
    last_heartbeat: t.timestamp(),
  }
);

const goal = table(
  { name: 'goal', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    room_id: t.u64().index('btree'),
    title: t.string(),
    status: t.string(), // 'active' | 'complete' | 'failed' | 'stopped'
    max_depth: t.u32(),
    max_tasks: t.u32(),
    deadline_ms: t.u64(), // per-task deadline in ms
    run_budget_micros: t.u64(), // mission supply budget; 0 = unlimited
    created_by: t.identity(),
    created_at: t.timestamp(),
  }
);

const task = table(
  {
    name: 'task',
    public: true,
    indexes: [
      { accessor: 'by_room_status', algorithm: 'btree', columns: ['room_id', 'status'] },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    room_id: t.u64().index('btree'),
    goal_id: t.u64().index('btree'),
    parent_id: t.option(t.u64()),
    title: t.string(),
    // 'pending' | 'claimed' | 'done' | 'blocked' | 'cancelled' | 'paused'
    status: t.string(),
    required_role: t.string(), // 'lead' | 'worker' | 'any' — who should claim it
    depth: t.u32(),
    attempts: t.u32(),
    assigned_agent_id: t.option(t.u64()),
    assigned_model: t.option(t.string()),
    claimed_at: t.option(t.timestamp()),
    deadline_ms: t.u64(),
    result: t.option(t.string()),
    risk: t.option(t.string()),
    confidence: t.option(t.string()),
    latency_ms: t.u32(), // last worker call latency, for scoreboard model split
    cost_micros: t.u64(), // last worker call cost, for scoreboard model split
    created_at: t.timestamp(),
    updated_at: t.timestamp(),
  }
);

const agent = table(
  { name: 'agent', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    room_id: t.u64().index('btree'),
    owner: t.identity(),
    name: t.string(),
    model: t.string(),
    role: t.string(), // 'lead' | 'worker' | 'reviewer'
    status: t.string(), // 'idle' | 'working' | 'stopped' | 'stale'
    current_task_id: t.option(t.u64()),
    latest_thought: t.string(),
    conn: t.option(t.connectionId()), // live connection; used for precise disconnect recovery
    last_heartbeat: t.timestamp(),
  }
);

const event = table(
  { name: 'event', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    room_id: t.u64().index('btree'),
    goal_id: t.option(t.u64()),
    task_id: t.option(t.u64()),
    agent_id: t.option(t.u64()),
    operator_id: t.option(t.identity()),
    kind: t.string(),
    message: t.string(),
    created_at: t.timestamp(),
  }
);

const score = table(
  { name: 'score', public: true },
  {
    goal_id: t.u64().primaryKey(),
    room_id: t.u64().index('btree'),
    points: t.i64(),
    valid_results: t.u32(),
    late_results: t.u32(),
    invalid_results: t.u32(),
    human_overrides: t.u32(),
    estimated_cost_micros: t.u64(),
  }
);

// The crew the player assembled in the UI. The auto-runner reads these and
// spawns exactly this fleet — so what you build is what deploys.
const crewSlot = table(
  { name: 'crew_slot', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    room_id: t.u64().index('btree'),
    goal_id: t.u64().index('btree'),
    role: t.string(), // 'lead' | 'worker' | 'reviewer'
    model: t.string(),
    count: t.u32(),
  }
);

// Live crises the commander must respond to mid-operation.
const crisis = table(
  { name: 'crisis', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    room_id: t.u64().index('btree'),
    goal_id: t.u64().index('btree'),
    kind: t.string(), // 'dust_storm' | 'supply_leak' | 'equipment_failure'
    message: t.string(),
    status: t.string(), // 'active' | 'resolved' | 'expired'
    choice: t.i32(), // -1 until resolved
    created_at: t.timestamp(),
    deadline_micros: t.u64(), // absolute micros-since-epoch deadline to respond
  }
);

const reaperTimer = table(
  { name: 'reaper_timer', scheduled: (): any => reap },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
  }
);

const crisisTimer = table(
  { name: 'crisis_timer', scheduled: (): any => crisisTick },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
  }
);

// One crew slot as submitted by the client (model + role + how many).
const CrewSpec = t.object('CrewSpec', {
  model: t.string(),
  role: t.string(),
  count: t.u32(),
});

// Worker result is the strict structured output the agent runner submits.
const WorkerResult = t.object('WorkerResult', {
  outcome: t.string(), // 'done' | 'blocked' | 'spawn_children'
  result: t.string(),
  children: t.array(t.string()),
  risk: t.string(),
  confidence: t.string(),
});

const spacetimedb = schema({
  room,
  operator,
  goal,
  task,
  agent,
  event,
  score,
  crewSlot,
  crisis,
  reaperTimer,
  crisisTimer,
});
export default spacetimedb;

// Helpers --------------------------------------------------------------------

type EventOpts = {
  goal_id?: bigint;
  task_id?: bigint;
  agent_id?: bigint;
  operator_id?: any;
};

function emit(ctx: any, room_id: bigint, kind: string, message: string, opts: EventOpts = {}): void {
  ctx.db.event.insert({
    id: 0n,
    room_id,
    goal_id: opts.goal_id,
    task_id: opts.task_id,
    agent_id: opts.agent_id,
    operator_id: opts.operator_id,
    kind,
    message,
    created_at: ctx.timestamp,
  });
}

type ScoreCounters = {
  valid?: number;
  late?: number;
  invalid?: number;
  overrides?: number;
  cost?: bigint;
};

function bumpScore(ctx: any, goal_id: bigint, deltaPoints: bigint, counters: ScoreCounters = {}): void {
  const s = ctx.db.score.goal_id.find(goal_id);
  if (!s) return;
  ctx.db.score.goal_id.update({
    ...s,
    points: s.points + deltaPoints,
    valid_results: s.valid_results + (counters.valid ?? 0),
    late_results: s.late_results + (counters.late ?? 0),
    invalid_results: s.invalid_results + (counters.invalid ?? 0),
    human_overrides: s.human_overrides + (counters.overrides ?? 0),
    estimated_cost_micros: s.estimated_cost_micros + (counters.cost ?? 0n),
  });
}

function freeAgent(ctx: any, agent_id: bigint | undefined): void {
  if (agent_id === undefined) return;
  const a = ctx.db.agent.id.find(agent_id);
  if (a) ctx.db.agent.id.update({ ...a, status: 'idle', current_task_id: undefined });
}

// Marks the goal complete and awards the mission bonus once no actionable
// tasks remain. Actionable = pending | claimed | paused.
function checkGoalComplete(ctx: any, goal_id: bigint, room_id: bigint): void {
  const tasks = [...ctx.db.task.goal_id.filter(goal_id)];
  if (tasks.length === 0) return;
  const remaining = tasks.filter(
    (x: any) => x.status === 'pending' || x.status === 'claimed' || x.status === 'paused'
  );
  if (remaining.length > 0) return;
  const g = ctx.db.goal.id.find(goal_id);
  if (g && g.status === 'active') {
    ctx.db.goal.id.update({ ...g, status: 'complete' });
    bumpScore(ctx, goal_id, PTS_MISSION);
    emit(ctx, room_id, 'mission_complete', 'All critical tasks complete', { goal_id });
  }
}

function addSupplyCost(ctx: any, goal_id: bigint, micros: bigint): void {
  const s = ctx.db.score.goal_id.find(goal_id);
  if (s) ctx.db.score.goal_id.update({ ...s, estimated_cost_micros: s.estimated_cost_micros + micros });
}

// Knock out up to n pending objectives (a crisis consequence).
function blockPending(ctx: any, goal_id: bigint, room_id: bigint, n: number): number {
  const pending = [...ctx.db.task.goal_id.filter(goal_id)]
    .filter((tk: any) => tk.status === 'pending')
    .sort((a: any, b: any) => (a.id < b.id ? 1 : -1)); // deepest/newest first
  let hit = 0;
  for (const tk of pending) {
    if (hit >= n) break;
    ctx.db.task.id.update({ ...tk, status: 'blocked', updated_at: ctx.timestamp });
    hit += 1;
  }
  if (hit > 0) emit(ctx, room_id, 'task_blocked', `${hit} objective(s) lost to the crisis`, { goal_id });
  return hit;
}

// Lifecycle ------------------------------------------------------------------

export const init = spacetimedb.init((ctx) => {
  // Schedule the stale-agent reaper to sweep every couple seconds.
  ctx.db.reaperTimer.insert({
    scheduled_id: 0n,
    scheduled_at: ScheduleAt.interval(REAP_INTERVAL_MICROS),
  });
  ctx.db.crisisTimer.insert({
    scheduled_id: 0n,
    scheduled_at: ScheduleAt.interval(CRISIS_INTERVAL_MICROS),
  });
});

export const onConnect = spacetimedb.clientConnected((_ctx) => {
  // Presence is established explicitly via create_room / join_room.
});

export const onDisconnect = spacetimedb.clientDisconnected((_ctx) => {
  // Intentionally a no-op. Cloud WebSocket connections flap (transient reconnects),
  // and marking a working agent stale on every disconnect caused the reaper to
  // steal an agent's in-flight task — crashing the worker on its next post_result.
  // Recovery is owned solely by the heartbeat-wedge reaper: an agent that truly
  // dies stops heartbeating and is reclaimed within STALE_AGENT_MICROS.
});

// Reducers -------------------------------------------------------------------

export const createRoom = spacetimedb.reducer(
  { name: t.string(), display_name: t.string() },
  (ctx, { name, display_name }) => {
    const r = ctx.db.room.insert({
      id: 0n,
      name,
      created_by: ctx.sender,
      created_at: ctx.timestamp,
      status: 'setup',
    });
    // Upsert presence — an operator (PK = identity) may already exist from a
    // prior room, so updating avoids a unique-constraint abort on re-create.
    const existingOp = ctx.db.operator.identity.find(ctx.sender);
    if (existingOp) {
      ctx.db.operator.identity.update({
        ...existingOp,
        room_id: r.id,
        display_name,
        selected_task_id: undefined,
        last_heartbeat: ctx.timestamp,
      });
    } else {
      ctx.db.operator.insert({
        identity: ctx.sender,
        room_id: r.id,
        display_name,
        selected_task_id: undefined,
        last_heartbeat: ctx.timestamp,
      });
    }
    emit(ctx, r.id, 'room_created', `${display_name} created room ${name}`, {
      operator_id: ctx.sender,
    });
  }
);

export const joinRoom = spacetimedb.reducer(
  { room_id: t.u64(), display_name: t.string() },
  (ctx, { room_id, display_name }) => {
    if (!ctx.db.room.id.find(room_id)) throw new SenderError('room not found');
    const existing = ctx.db.operator.identity.find(ctx.sender);
    if (existing) {
      ctx.db.operator.identity.update({
        ...existing,
        room_id,
        display_name,
        last_heartbeat: ctx.timestamp,
      });
    } else {
      ctx.db.operator.insert({
        identity: ctx.sender,
        room_id,
        display_name,
        selected_task_id: undefined,
        last_heartbeat: ctx.timestamp,
      });
    }
    emit(ctx, room_id, 'operator_joined', `${display_name} joined`, { operator_id: ctx.sender });
  }
);

export const submitGoal = spacetimedb.reducer(
  {
    room_id: t.u64(),
    title: t.string(),
    max_depth: t.u32(),
    max_tasks: t.u32(),
    deadline_ms: t.u64(),
    run_budget_micros: t.u64(),
    crew: t.array(CrewSpec),
  },
  (ctx, { room_id, title, max_depth, max_tasks, deadline_ms, run_budget_micros, crew }) => {
    const r = ctx.db.room.id.find(room_id);
    if (!r) throw new SenderError('room not found');

    const g = ctx.db.goal.insert({
      id: 0n,
      room_id,
      title,
      status: 'active',
      max_depth,
      max_tasks,
      deadline_ms,
      run_budget_micros,
      created_by: ctx.sender,
      created_at: ctx.timestamp,
    });

    const leadModel = crew.find((c: any) => c.role === 'lead')?.model ?? crew[0]?.model ?? '';

    // Root is a Lead objective — strategy belongs to the smart units.
    ctx.db.task.insert({
      id: 0n,
      room_id,
      goal_id: g.id,
      parent_id: undefined,
      title,
      status: 'pending',
      required_role: 'lead',
      depth: 0,
      attempts: 0,
      assigned_agent_id: undefined,
      assigned_model: leadModel.length > 0 ? leadModel : undefined,
      claimed_at: undefined,
      deadline_ms,
      result: undefined,
      risk: undefined,
      confidence: undefined,
      latency_ms: 0,
      cost_micros: 0n,
      created_at: ctx.timestamp,
      updated_at: ctx.timestamp,
    });

    // Persist the assembled crew so the auto-runner deploys exactly this fleet.
    for (const slot of crew) {
      if (slot.count <= 0 || slot.model.length === 0) continue;
      ctx.db.crewSlot.insert({
        id: 0n,
        room_id,
        goal_id: g.id,
        role: slot.role,
        model: slot.model,
        count: slot.count,
      });
    }

    ctx.db.score.insert({
      goal_id: g.id,
      room_id,
      points: 0n,
      valid_results: 0,
      late_results: 0,
      invalid_results: 0,
      human_overrides: 0,
      estimated_cost_micros: 0n,
    });

    ctx.db.room.id.update({ ...r, status: 'running' });
    emit(ctx, room_id, 'goal_submitted', title, { goal_id: g.id });
  }
);

export const registerAgent = spacetimedb.reducer(
  { room_id: t.u64(), name: t.string(), model: t.string(), role: t.string() },
  (ctx, { room_id, name, model, role }) => {
    if (!ctx.db.room.id.find(room_id)) throw new SenderError('room not found');
    // Names are unique-per-room by convention (runner assigns them), so the
    // client can rediscover its agent row by (room_id, name).
    const existing = [...ctx.db.agent.room_id.filter(room_id)].find((a: any) => a.name === name);
    if (existing) {
      ctx.db.agent.id.update({
        ...existing,
        owner: ctx.sender,
        model,
        role,
        status: 'idle',
        conn: ctx.connectionId ?? undefined,
        last_heartbeat: ctx.timestamp,
      });
      emit(ctx, room_id, 'agent_registered', `${name} re-registered on ${model}`, {
        agent_id: existing.id,
      });
    } else {
      const a = ctx.db.agent.insert({
        id: 0n,
        room_id,
        owner: ctx.sender,
        name,
        model,
        role,
        status: 'idle',
        current_task_id: undefined,
        latest_thought: '',
        conn: ctx.connectionId ?? undefined,
        last_heartbeat: ctx.timestamp,
      });
      emit(ctx, room_id, 'agent_registered', `${name} joined on ${model}`, { agent_id: a.id });
    }
  }
);

// THE demo flex: two agents racing both call this, but reducers run serially,
// so the second caller sees the first's write and cannot double-claim.
export const claimTask = spacetimedb.reducer(
  { room_id: t.u64(), agent_id: t.u64() },
  (ctx, { room_id, agent_id }) => {
    const a = ctx.db.agent.id.find(agent_id);
    if (!a) throw new SenderError('agent not found');
    if (a.status === 'stopped') throw new SenderError('agent stopped');

    // Mission must be active (not complete / out of supplies).
    const activeGoal = [...ctx.db.goal.room_id.filter(room_id)].find((g: any) => g.status === 'active');
    if (!activeGoal) return;

    const pending = [...ctx.db.task.by_room_status.filter([room_id, 'pending'])].sort((x: any, y: any) =>
      x.id < y.id ? -1 : x.id > y.id ? 1 : 0
    );
    if (pending.length === 0) return; // nothing to do; agent will retry

    // Role preference: claim work matching this unit's role; fall back to any
    // pending task so the swarm never deadlocks when a role is unstaffed.
    const forRole = pending.filter((tk: any) => tk.required_role === a.role || tk.required_role === 'any');
    const claimed = forRole.length > 0 ? forRole[0] : pending[0];
    ctx.db.task.id.update({
      ...claimed,
      status: 'claimed',
      assigned_agent_id: agent_id,
      assigned_model: a.model,
      claimed_at: ctx.timestamp,
      attempts: claimed.attempts + 1,
      updated_at: ctx.timestamp,
    });
    ctx.db.agent.id.update({
      ...a,
      status: 'working',
      current_task_id: claimed.id,
      conn: ctx.connectionId ?? a.conn,
      last_heartbeat: ctx.timestamp,
    });
    emit(ctx, room_id, 'task_claimed', `${a.name} claimed "${claimed.title}"`, {
      goal_id: claimed.goal_id,
      task_id: claimed.id,
      agent_id,
    });
  }
);

export const postResult = spacetimedb.reducer(
  {
    agent_id: t.u64(),
    task_id: t.u64(),
    worker: WorkerResult,
    latency_ms: t.u32(),
    estimated_cost_micros: t.u64(),
  },
  (ctx, { agent_id, task_id, worker, latency_ms, estimated_cost_micros }) => {
    const tk = ctx.db.task.id.find(task_id);
    if (!tk) throw new SenderError('task not found');
    if (tk.assigned_agent_id !== agent_id) throw new SenderError('task not assigned to this agent');
    if (tk.status !== 'claimed') throw new SenderError('task is not in a claimable state');

    const room_id = tk.room_id;
    const goal_id = tk.goal_id;
    const g = ctx.db.goal.id.find(goal_id);
    if (!g) throw new SenderError('goal not found');

    // Cost is always recorded, even for late/invalid results.
    bumpScore(ctx, goal_id, 0n, { cost: estimated_cost_micros });

    // Supply budget: once the run budget is spent, halt the mission. claim_task
    // stops handing out work, so the swarm stands down. This is a loss condition.
    if (g.run_budget_micros > 0n && g.status === 'active') {
      const s = ctx.db.score.goal_id.find(goal_id);
      if (s && s.estimated_cost_micros >= g.run_budget_micros) {
        ctx.db.goal.id.update({ ...g, status: 'stopped' });
        emit(ctx, room_id, 'budget_exhausted', `Supplies exhausted — mission halted`, { goal_id });
      }
    }

    // Deadline check.
    const now = ctx.timestamp.microsSinceUnixEpoch;
    const claimedAt = tk.claimed_at ? tk.claimed_at.microsSinceUnixEpoch : now;
    const late = tk.claimed_at !== undefined && now - claimedAt > tk.deadline_ms * 1000n;

    if (late) {
      freeAgent(ctx, agent_id);
      const blocked = tk.attempts >= MAX_ATTEMPTS;
      ctx.db.task.id.update({
        ...tk,
        status: blocked ? 'blocked' : 'pending',
        assigned_agent_id: undefined,
        assigned_model: undefined,
        claimed_at: undefined,
        latency_ms,
        cost_micros: estimated_cost_micros,
        updated_at: ctx.timestamp,
      });
      bumpScore(ctx, goal_id, PEN_LATE, { late: 1 });
      emit(ctx, room_id, 'deadline_missed', `Late by deadline on "${tk.title}" (${latency_ms}ms)`, {
        goal_id,
        task_id,
        agent_id,
      });
      // A late result may have just blocked the final task — check completion so
      // the expedition can't get stuck "active" with no actionable work left.
      if (blocked) checkGoalComplete(ctx, goal_id, room_id);
      return;
    }

    const outcome = worker.outcome;

    if (outcome === 'done') {
      ctx.db.task.id.update({
        ...tk,
        status: 'done',
        result: worker.result,
        risk: worker.risk,
        confidence: worker.confidence,
        latency_ms,
        cost_micros: estimated_cost_micros,
        updated_at: ctx.timestamp,
      });
      freeAgent(ctx, agent_id);
      bumpScore(ctx, goal_id, PTS_VALID, { valid: 1 });
      emit(ctx, room_id, 'result_posted', `Done: "${tk.title}" (${latency_ms}ms)`, {
        goal_id,
        task_id,
        agent_id,
      });
      checkGoalComplete(ctx, goal_id, room_id);
      return;
    }

    if (outcome === 'spawn_children') {
      ctx.db.task.id.update({
        ...tk,
        status: 'done',
        result: worker.result,
        risk: worker.risk,
        confidence: worker.confidence,
        latency_ms,
        cost_micros: estimated_cost_micros,
        updated_at: ctx.timestamp,
      });
      freeAgent(ctx, agent_id);
      bumpScore(ctx, goal_id, PTS_VALID, { valid: 1 });
      emit(ctx, room_id, 'result_posted', `Planned: "${tk.title}" (${latency_ms}ms)`, {
        goal_id,
        task_id,
        agent_id,
      });

      const childDepth = tk.depth + 1;
      const titles = worker.children.filter((c: string) => c.trim().length > 0);
      if (childDepth > g.max_depth) {
        emit(ctx, room_id, 'budget_hit', `Max depth reached at "${tk.title}"`, { goal_id, task_id });
      } else {
        let spawned = 0;
        for (const childTitle of titles) {
          const total = [...ctx.db.task.goal_id.filter(goal_id)].length;
          if (total >= g.max_tasks) {
            emit(ctx, room_id, 'budget_hit', `Max tasks reached; dropped "${childTitle}"`, {
              goal_id,
              task_id,
            });
            break;
          }
          ctx.db.task.insert({
            id: 0n,
            room_id,
            goal_id,
            parent_id: task_id,
            title: childTitle,
            status: 'pending',
            // Strategy tiers stay with Leads; execution tiers go to Workers.
            required_role: childDepth <= LEAD_TIERS ? 'lead' : 'worker',
            depth: childDepth,
            attempts: 0,
            assigned_agent_id: undefined,
            assigned_model: undefined,
            claimed_at: undefined,
            deadline_ms: tk.deadline_ms,
            result: undefined,
            risk: undefined,
            confidence: undefined,
            latency_ms: 0,
            cost_micros: 0n,
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
          });
          spawned += 1;
        }
        if (spawned > 0) {
          bumpScore(ctx, goal_id, PTS_CHILD * BigInt(spawned));
          emit(ctx, room_id, 'children_spawned', `Spawned ${spawned} subtasks of "${tk.title}"`, {
            goal_id,
            task_id,
          });
        }
      }
      checkGoalComplete(ctx, goal_id, room_id);
      return;
    }

    if (outcome === 'blocked') {
      ctx.db.task.id.update({
        ...tk,
        status: 'blocked',
        result: worker.result,
        risk: worker.risk,
        confidence: worker.confidence,
        latency_ms,
        cost_micros: estimated_cost_micros,
        updated_at: ctx.timestamp,
      });
      freeAgent(ctx, agent_id);
      bumpScore(ctx, goal_id, PEN_BLOCKED);
      emit(ctx, room_id, 'task_blocked', `Blocked: "${tk.title}" — ${worker.risk}`, {
        goal_id,
        task_id,
        agent_id,
      });
      checkGoalComplete(ctx, goal_id, room_id);
      return;
    }

    // Unknown outcome -> invalid result.
    freeAgent(ctx, agent_id);
    const blocked = tk.attempts >= MAX_ATTEMPTS;
    ctx.db.task.id.update({
      ...tk,
      status: blocked ? 'blocked' : 'pending',
      assigned_agent_id: undefined,
      assigned_model: undefined,
      claimed_at: undefined,
      updated_at: ctx.timestamp,
    });
    bumpScore(ctx, goal_id, PEN_INVALID, { invalid: 1 });
    emit(ctx, room_id, 'invalid_result', `Invalid outcome "${outcome}" on "${tk.title}"`, {
      goal_id,
      task_id,
      agent_id,
    });
    if (blocked) checkGoalComplete(ctx, goal_id, room_id);
  }
);

export const humanOverride = spacetimedb.reducer(
  {
    room_id: t.u64(),
    task_id: t.u64(),
    action: t.string(), // 'pause' | 'resume' | 'cancel' | 'redirect' | 'reassign' | 'merge'
    title: t.option(t.string()),
    target_task_id: t.option(t.u64()),
  },
  (ctx, { room_id, task_id, action, title, target_task_id }) => {
    const tk = ctx.db.task.id.find(task_id);
    if (!tk) throw new SenderError('task not found');

    let message = '';
    switch (action) {
      case 'pause': {
        freeAgent(ctx, tk.assigned_agent_id);
        ctx.db.task.id.update({
          ...tk,
          status: 'paused',
          assigned_agent_id: undefined,
          claimed_at: undefined,
          updated_at: ctx.timestamp,
        });
        message = `Paused "${tk.title}"`;
        break;
      }
      case 'resume': {
        ctx.db.task.id.update({ ...tk, status: 'pending', updated_at: ctx.timestamp });
        message = `Resumed "${tk.title}"`;
        break;
      }
      case 'cancel': {
        freeAgent(ctx, tk.assigned_agent_id);
        ctx.db.task.id.update({
          ...tk,
          status: 'cancelled',
          assigned_agent_id: undefined,
          claimed_at: undefined,
          updated_at: ctx.timestamp,
        });
        message = `Cancelled "${tk.title}"`;
        break;
      }
      case 'redirect': {
        freeAgent(ctx, tk.assigned_agent_id);
        ctx.db.task.id.update({
          ...tk,
          title: title && title.length > 0 ? title : tk.title,
          status: 'pending',
          assigned_agent_id: undefined,
          claimed_at: undefined,
          updated_at: ctx.timestamp,
        });
        message = `Redirected to "${title ?? tk.title}"`;
        break;
      }
      case 'reassign': {
        freeAgent(ctx, tk.assigned_agent_id);
        ctx.db.task.id.update({
          ...tk,
          status: 'pending',
          assigned_agent_id: undefined,
          assigned_model: undefined,
          claimed_at: undefined,
          updated_at: ctx.timestamp,
        });
        message = `Reassigned "${tk.title}"`;
        break;
      }
      case 'merge': {
        freeAgent(ctx, tk.assigned_agent_id);
        ctx.db.task.id.update({
          ...tk,
          status: 'cancelled',
          assigned_agent_id: undefined,
          claimed_at: undefined,
          result: target_task_id !== undefined ? `merged into #${target_task_id}` : 'merged duplicate',
          updated_at: ctx.timestamp,
        });
        message = `Merged duplicate "${tk.title}"`;
        break;
      }
      default:
        throw new SenderError(`unknown override action: ${action}`);
    }

    bumpScore(ctx, tk.goal_id, PTS_OVERRIDE, { overrides: 1 });
    emit(ctx, room_id, 'human_override', message, {
      goal_id: tk.goal_id,
      task_id,
      operator_id: ctx.sender,
    });
  }
);

export const heartbeatAgent = spacetimedb.reducer(
  { agent_id: t.u64(), status: t.string(), latest_thought: t.string() },
  (ctx, { agent_id, status, latest_thought }) => {
    const a = ctx.db.agent.id.find(agent_id);
    if (!a) throw new SenderError('agent not found');
    ctx.db.agent.id.update({
      ...a,
      status,
      latest_thought,
      conn: ctx.connectionId ?? a.conn,
      last_heartbeat: ctx.timestamp,
    });
  }
);

export const heartbeatOperator = spacetimedb.reducer(
  { room_id: t.u64(), selected_task_id: t.option(t.u64()) },
  (ctx, { room_id, selected_task_id }) => {
    const op = ctx.db.operator.identity.find(ctx.sender);
    if (!op) throw new SenderError('operator not found');
    ctx.db.operator.identity.update({
      ...op,
      room_id,
      selected_task_id,
      last_heartbeat: ctx.timestamp,
    });
  }
);

// Scheduled stale-agent lease recovery. An agent that claimed a task but stopped
// heartbeating has its task returned to the pool so the swarm never deadlocks.
export const reap = spacetimedb.reducer(
  { timer: reaperTimer.rowType },
  (ctx, _args) => {
    const now = ctx.timestamp.microsSinceUnixEpoch;
    // Recover by task, not by agent: any claimed task whose holder has gone
    // (missing), been marked stale by disconnect, or stopped heartbeating gets
    // returned to the pool so the swarm never deadlocks on a dead lease.
    for (const tk of [...ctx.db.task.iter()]) {
      if (tk.status !== 'claimed') continue;
      const aid = tk.assigned_agent_id;
      const a = aid !== undefined ? ctx.db.agent.id.find(aid) : null;

      const gone = a === null;
      const disconnected = a !== null && a.status === 'stale';
      const wedged = a !== null && now - a.last_heartbeat.microsSinceUnixEpoch > STALE_AGENT_MICROS;
      if (!gone && !disconnected && !wedged) continue;

      if (a) ctx.db.agent.id.update({ ...a, status: 'stale', current_task_id: undefined });
      ctx.db.task.id.update({
        ...tk,
        status: 'pending',
        assigned_agent_id: undefined,
        assigned_model: undefined,
        claimed_at: undefined,
        updated_at: ctx.timestamp,
      });
      bumpScore(ctx, tk.goal_id, PEN_STALE);
      emit(ctx, tk.room_id, 'stale_recovery', `Recovered "${tk.title}" from ${a ? a.name : 'a gone agent'}`, {
        goal_id: tk.goal_id,
        task_id: tk.id,
        agent_id: aid,
      });
    }
  }
);

// ---- Crisis director --------------------------------------------------------

function checkBudget(ctx: any, goal_id: bigint, room_id: bigint): void {
  const g = ctx.db.goal.id.find(goal_id);
  if (!g || g.status !== 'active' || g.run_budget_micros <= 0n) return;
  const s = ctx.db.score.goal_id.find(goal_id);
  if (s && s.estimated_cost_micros >= g.run_budget_micros) {
    ctx.db.goal.id.update({ ...g, status: 'stopped' });
    emit(ctx, room_id, 'budget_exhausted', 'Supplies exhausted — mission halted', { goal_id });
  }
}

// Apply a crisis outcome. choice 0/1 = commander's response; -1 = ignored/expired.
function applyCrisisEffect(ctx: any, c: any, choice: number): void {
  const room_id = c.room_id;
  const goal_id = c.goal_id;
  let msg = '';
  if (c.kind === 'dust_storm') {
    if (choice === 0) { addSupplyCost(ctx, goal_id, 4_000n); bumpScore(ctx, goal_id, 20n); msg = 'Sheltered the crew through the storm'; }
    else if (choice === 1) { blockPending(ctx, goal_id, room_id, 1); bumpScore(ctx, goal_id, -60n); msg = 'Pushed through — lost an objective to the storm'; }
    else { blockPending(ctx, goal_id, room_id, 2); bumpScore(ctx, goal_id, -120n); msg = 'Storm overran the site — objectives lost'; }
  } else if (c.kind === 'supply_leak') {
    if (choice === 0) { addSupplyCost(ctx, goal_id, 6_000n); bumpScore(ctx, goal_id, 20n); msg = 'Sealed the leak'; }
    else if (choice === 1) { bumpScore(ctx, goal_id, -80n); msg = 'Rationed supplies — morale hit'; }
    else { addSupplyCost(ctx, goal_id, 14_000n); bumpScore(ctx, goal_id, -100n); msg = 'Leak ran unchecked — supplies bled out'; }
  } else { // equipment_failure
    if (choice === 0) { addSupplyCost(ctx, goal_id, 5_000n); bumpScore(ctx, goal_id, 20n); msg = 'Repaired the equipment'; }
    else if (choice === 1) { blockPending(ctx, goal_id, room_id, 1); bumpScore(ctx, goal_id, -40n); msg = 'Rerouted around the failure'; }
    else { blockPending(ctx, goal_id, room_id, 2); bumpScore(ctx, goal_id, -120n); msg = 'Failure cascaded — objectives lost'; }
  }
  emit(ctx, room_id, 'crisis_resolved', msg, { goal_id });
  checkBudget(ctx, goal_id, room_id);
}

export const crisisTick = spacetimedb.reducer(
  { timer: crisisTimer.rowType },
  (ctx, _args) => {
    const now = ctx.timestamp.microsSinceUnixEpoch;

    // Expire overdue crises (the commander didn't respond in time).
    for (const c of [...ctx.db.crisis.iter()]) {
      if (c.status !== 'active') continue;
      if (now <= c.deadline_micros) continue;
      applyCrisisEffect(ctx, c, -1);
      ctx.db.crisis.id.update({ ...c, status: 'expired', choice: -1 });
    }

    // Maybe throw a new crisis at each active operation with real work left.
    for (const g of [...ctx.db.goal.iter()]) {
      if (g.status !== 'active') continue;
      const hasActive = [...ctx.db.crisis.iter()].some((c: any) => c.room_id === g.room_id && c.status === 'active');
      if (hasActive) continue;
      const hasWork = [...ctx.db.task.goal_id.filter(g.id)].some((tk: any) => tk.status === 'pending' || tk.status === 'claimed');
      if (!hasWork) continue;
      if (ctx.random() > 0.85) continue; // ~85% chance per cadence when eligible

      const kind = CRISIS_KINDS[ctx.random.integerInRange(0, CRISIS_KINDS.length - 1)];
      ctx.db.crisis.insert({
        id: 0n,
        room_id: g.room_id,
        goal_id: g.id,
        kind,
        message: CRISIS_MSG[kind] ?? kind,
        status: 'active',
        choice: -1,
        created_at: ctx.timestamp,
        deadline_micros: now + CRISIS_DEADLINE_MICROS,
      });
      emit(ctx, g.room_id, 'crisis', `⚠ ${CRISIS_MSG[kind] ?? kind}`, { goal_id: g.id });
    }
  }
);

export const resolveCrisis = spacetimedb.reducer(
  { crisis_id: t.u64(), choice: t.i32() },
  (ctx, { crisis_id, choice }) => {
    const c = ctx.db.crisis.id.find(crisis_id);
    if (!c) throw new SenderError('crisis not found');
    if (c.status !== 'active') return; // already handled
    applyCrisisEffect(ctx, c, choice);
    ctx.db.crisis.id.update({ ...c, status: 'resolved', choice });
  }
);
