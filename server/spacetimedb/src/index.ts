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
const CRISIS_COOLDOWN_MICROS = 28_000_000n; // avoid crisis spam
const BATTLE_INTERVAL_MICROS = 4_000_000n; // battle director cadence
const MAX_COMMAND_TOKENS = 3;
const MAX_ACTIVE_BATTLE_TASKS = 2;
const DRAFT_POINTS_CAP = 14;
const MAX_DRAFT_UNITS = 12;
const NEUTRAL_CAPTURE_THRESHOLD = 160;
const CAPTURE_THRESHOLD = 220;
const HQ_MAX_INTEGRITY = 100;
const NODE_FORTIFY_MAX = 80;

const CRISIS_KINDS = ['dust_storm', 'supply_leak', 'equipment_failure'];
const CRISIS_MSG: Record<string, string> = {
  dust_storm: 'Dust storm grounding the crew — work is stalling.',
  supply_leak: 'Coolant leak detected — supplies are bleeding out.',
  equipment_failure: 'Critical equipment failure on an objective.',
};

const MODEL_POINTS: Record<string, number> = {
  'openai/gpt-oss-120b:nitro': 2,
  'z-ai/glm-4.7:nitro': 4,
  'inception/mercury-2:nitro': 3,
  'google/gemini-3.1-flash-lite:nitro': 3,
  'z-ai/glm-4.7-flash:nitro': 1,
  'x-ai/grok-4.3:nitro': 6,
  'google/gemini-3.5-flash:nitro': 4,
  'deepseek/deepseek-v4-flash:nitro': 2,
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
    team: t.string(), // 'blue' | 'red' | 'spectator'
    ready: t.bool(),
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
    team: t.string(), // 'blue' | 'red' | 'neutral' (legacy tasks default blue)
    target_node_id: t.option(t.u64()), // battle_node.id when this is combat work
    action_type: t.string(), // 'plan' | 'assault' | 'defend' | 'scout' | 'sabotage' | 'fortify'
    priority: t.u32(),
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
    team: t.string(), // 'blue' | 'red'
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
    team: t.string(), // 'blue' | 'red'
    model: t.string(),
    count: t.u32(),
  }
);

// Draft rows live before the battle starts. Each human commander owns exactly
// one side, and these rows are copied into crew_slot when both sides lock.
const draftSlot = table(
  { name: 'draft_slot', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    room_id: t.u64().index('btree'),
    team: t.string(), // 'blue' | 'red'
    role: t.string(), // 'lead' | 'worker' | 'reviewer'
    model: t.string(),
    count: t.u32(),
    updated_by: t.identity(),
    updated_at: t.timestamp(),
  }
);

const teamState = table(
  { name: 'team_state', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    room_id: t.u64().index('btree'),
    goal_id: t.u64().index('btree'),
    team: t.string(), // 'blue' | 'red'
    supply_micros: t.u64(),
    morale: t.i32(),
    command_tokens: t.i32(),
    hq_integrity: t.i32(),
    status: t.string(), // 'fighting' | 'winner' | 'defeated'
    updated_at: t.timestamp(),
  }
);

const battleNode = table(
  {
    name: 'battle_node',
    public: true,
    indexes: [
      { accessor: 'by_room_owner', algorithm: 'btree', columns: ['room_id', 'owner'] },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    room_id: t.u64().index('btree'),
    goal_id: t.u64().index('btree'),
    node_key: t.string(),
    name: t.string(),
    kind: t.string(), // 'hq' | 'strongpoint' | 'relay' | 'depot' | 'post'
    lane: t.string(), // 'north' | 'center' | 'south' | 'base'
    owner: t.string(), // 'blue' | 'red' | 'neutral'
    status: t.string(), // 'held' | 'contested' | 'damaged'
    x: t.i32(),
    y: t.i32(),
    adjacent_keys: t.string(), // comma-separated node_key list
    fortification: t.i32(),
    blue_pressure: t.i32(),
    red_pressure: t.i32(),
    hq_integrity: t.i32(),
    updated_at: t.timestamp(),
  }
);

const battleOrder = table(
  { name: 'battle_order', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    room_id: t.u64().index('btree'),
    goal_id: t.u64().index('btree'),
    team: t.string(),
    target_node_id: t.u64().index('btree'),
    order_type: t.string(), // 'assault' | 'defend' | 'sabotage' | 'reinforce' | 'scout'
    priority: t.u32(),
    status: t.string(), // 'active' | 'spent' | 'expired'
    issued_by: t.identity(),
    created_at: t.timestamp(),
    expires_at_micros: t.u64(),
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

const battleTimer = table(
  { name: 'battle_timer', scheduled: (): any => battleTick },
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
  draftSlot,
  teamState,
  battleNode,
  battleOrder,
  crisis,
  reaperTimer,
  crisisTimer,
  battleTimer,
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

function sameIdentity(a: any, b: any): boolean {
  if (!a || !b) return false;
  return typeof a.equals === 'function' ? a.equals(b) : String(a) === String(b);
}

function isPlayableTeam(team: string): boolean {
  return team === 'blue' || team === 'red';
}

function modelPoints(model: string): number {
  if (MODEL_POINTS[model] !== undefined) return MODEL_POINTS[model];
  const noRoute = model.replace(/:nitro$/, '');
  const matched = Object.keys(MODEL_POINTS).find((id) => id.replace(/:nitro$/, '') === noRoute);
  return matched ? MODEL_POINTS[matched] : 3;
}

function draftRows(ctx: any, room_id: bigint, team: string): any[] {
  return [...ctx.db.draftSlot.room_id.filter(room_id)].filter((s: any) => s.team === team);
}

function draftStats(rows: any[]): { units: number; points: number } {
  return rows.reduce(
    (acc, row) => ({
      units: acc.units + row.count,
      points: acc.points + modelPoints(row.model) * row.count,
    }),
    { units: 0, points: 0 }
  );
}

function validateDraft(rows: any[]): void {
  const stats = draftStats(rows);
  if (stats.units <= 0) throw new SenderError('draft needs at least one unit');
  if (stats.units > MAX_DRAFT_UNITS) throw new SenderError('too many units');
  if (stats.points > DRAFT_POINTS_CAP) throw new SenderError('draft over point cap');
  if (!rows.some((s: any) => s.role === 'lead' && s.count > 0)) throw new SenderError('draft needs a command unit');
}

function teamCommander(ctx: any, room_id: bigint, team: string): any {
  return [...ctx.db.operator.room_id.filter(room_id)].find((op: any) => op.team === team) ?? null;
}

function operatorForSender(ctx: any, room_id: bigint): any {
  const op = ctx.db.operator.identity.find(ctx.sender);
  return op && op.room_id === room_id ? op : null;
}

function requireTeamCommander(ctx: any, room_id: bigint, team: string): any {
  if (!isPlayableTeam(team)) throw new SenderError('bad team');
  const op = operatorForSender(ctx, room_id);
  if (!op || op.team !== team) throw new SenderError('not commander for this team');
  return op;
}

function upsertOperator(ctx: any, room_id: bigint, display_name: string, team: string, ready: boolean): void {
  const existing = ctx.db.operator.identity.find(ctx.sender);
  if (existing) {
    ctx.db.operator.identity.update({
      ...existing,
      room_id,
      display_name,
      team,
      ready,
      selected_task_id: undefined,
      last_heartbeat: ctx.timestamp,
    });
  } else {
    ctx.db.operator.insert({
      identity: ctx.sender,
      room_id,
      display_name,
      team,
      ready,
      selected_task_id: undefined,
      last_heartbeat: ctx.timestamp,
    });
  }
}

function assertTeamAvailable(ctx: any, room_id: bigint, team: string): void {
  if (!isPlayableTeam(team)) return;
  const holder = teamCommander(ctx, room_id, team);
  if (holder && !sameIdentity(holder.identity, ctx.sender)) {
    throw new SenderError(`${team} already has a commander`);
  }
}

function replaceDraft(ctx: any, room_id: bigint, team: string, crew: any[]): void {
  for (const existing of draftRows(ctx, room_id, team)) {
    ctx.db.draftSlot.id.delete(existing.id);
  }

  for (const slot of crew) {
    const count = Math.max(0, slot.count);
    if (count <= 0 || slot.model.length === 0) continue;
    const role = slot.role === 'lead' ? 'lead' : slot.role === 'reviewer' ? 'reviewer' : 'worker';
    ctx.db.draftSlot.insert({
      id: 0n,
      room_id,
      team,
      role,
      model: slot.model,
      count,
      updated_by: ctx.sender,
      updated_at: ctx.timestamp,
    });
  }
}

function maybeStartBattleFromDrafts(
  ctx: any,
  room_id: bigint,
  title: string,
  max_depth: number,
  max_tasks: number,
  deadline_ms: bigint,
  run_budget_micros: bigint
): void {
  const r = ctx.db.room.id.find(room_id);
  if (!r || r.status !== 'setup') return;
  if ([...ctx.db.goal.room_id.filter(room_id)].some((g: any) => g.status === 'active')) return;

  const blue = teamCommander(ctx, room_id, 'blue');
  const red = teamCommander(ctx, room_id, 'red');
  if (!blue || !red || !blue.ready || !red.ready) return;

  const blueDraft = draftRows(ctx, room_id, 'blue');
  const redDraft = draftRows(ctx, room_id, 'red');
  validateDraft(blueDraft);
  validateDraft(redDraft);

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

  seedBattlefield(ctx, room_id, g.id, run_budget_micros);

  for (const slot of [...blueDraft, ...redDraft]) {
    ctx.db.crewSlot.insert({
      id: 0n,
      room_id,
      goal_id: g.id,
      role: slot.role,
      team: slot.team,
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
  seedOpeningTasks(ctx, room_id, g.id);
  ensureBattleTasks(ctx, g.id, room_id);
  emit(ctx, room_id, 'battle_started', `Battle started: ${title}`, { goal_id: g.id });
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

function enemyTeam(team: string): string {
  return team === 'red' ? 'blue' : 'red';
}

function isBattleGoal(ctx: any, goal_id: bigint): boolean {
  return [...ctx.db.battleNode.goal_id.filter(goal_id)].length > 0;
}

function adjKeys(node: any): string[] {
  return String(node.adjacent_keys ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function findNodeByKey(ctx: any, goal_id: bigint, key: string): any {
  return [...ctx.db.battleNode.goal_id.filter(goal_id)].find((n: any) => n.node_key === key) ?? null;
}

function teamRow(ctx: any, goal_id: bigint, team: string): any {
  return [...ctx.db.teamState.goal_id.filter(goal_id)].find((s: any) => s.team === team) ?? null;
}

function activeBattleTasks(ctx: any, goal_id: bigint, team: string): any[] {
  return [...ctx.db.task.goal_id.filter(goal_id)].filter(
    (tk: any) => tk.team === team && (tk.status === 'pending' || tk.status === 'claimed' || tk.status === 'paused')
  );
}

function hasActiveTask(ctx: any, goal_id: bigint, team: string, node_id: bigint, action: string): boolean {
  return activeBattleTasks(ctx, goal_id, team).some(
    (tk: any) => tk.target_node_id === node_id && tk.action_type === action
  );
}

function actionTitle(action: string, team: string, node: any): string {
  const side = team === 'blue' ? 'Blue' : 'Red';
  const verb: Record<string, string> = {
    assault: 'assault',
    defend: 'hold',
    scout: 'recon',
    sabotage: 'sabotage',
    fortify: 'fortify',
    reinforce: 'reinforce',
  };
  return `${side} ${verb[action] ?? action}: ${node.name}`;
}

function insertBattleTask(
  ctx: any,
  room_id: bigint,
  goal_id: bigint,
  team: string,
  node: any,
  action: string,
  priority: number,
  required_role = 'worker'
): void {
  if (hasActiveTask(ctx, goal_id, team, node.id, action)) return;
  ctx.db.task.insert({
    id: 0n,
    room_id,
    goal_id,
    parent_id: undefined,
    title: actionTitle(action, team, node),
    status: 'pending',
    required_role,
    depth: action === 'scout' || action === 'defend' ? 1 : 2,
    attempts: 0,
    assigned_agent_id: undefined,
    assigned_model: undefined,
    claimed_at: undefined,
    deadline_ms: ctx.db.goal.id.find(goal_id)?.deadline_ms ?? 2000n,
    result: undefined,
    risk: undefined,
    confidence: undefined,
    team,
    target_node_id: node.id,
    action_type: action,
    priority,
    latency_ms: 0,
    cost_micros: 0n,
    created_at: ctx.timestamp,
    updated_at: ctx.timestamp,
  });
}

type NodeSpec = {
  key: string;
  name: string;
  kind: string;
  lane: string;
  owner: string;
  x: number;
  y: number;
  adj: string;
  fort: number;
  hq?: number;
};

function seedBattlefield(ctx: any, room_id: bigint, goal_id: bigint, supply_micros: bigint): void {
  ctx.db.teamState.insert({
    id: 0n,
    room_id,
    goal_id,
    team: 'blue',
    supply_micros,
    morale: 100,
    command_tokens: 2,
    hq_integrity: HQ_MAX_INTEGRITY,
    status: 'fighting',
    updated_at: ctx.timestamp,
  });
  ctx.db.teamState.insert({
    id: 0n,
    room_id,
    goal_id,
    team: 'red',
    supply_micros,
    morale: 100,
    command_tokens: 2,
    hq_integrity: HQ_MAX_INTEGRITY,
    status: 'fighting',
    updated_at: ctx.timestamp,
  });

  const nodes: NodeSpec[] = [
    { key: 'blue_hq', name: 'BLUE HQ', kind: 'hq', lane: 'base', owner: 'blue', x: 6, y: 50, adj: 'blue_north,blue_center,blue_south', fort: 70, hq: HQ_MAX_INTEGRITY },
    { key: 'blue_north', name: 'Blue North Post', kind: 'post', lane: 'north', owner: 'blue', x: 22, y: 22, adj: 'blue_hq,mid_north,mid_center', fort: 35 },
    { key: 'blue_center', name: 'Blue Relay', kind: 'relay', lane: 'center', owner: 'blue', x: 22, y: 50, adj: 'blue_hq,mid_north,mid_center,mid_south', fort: 40 },
    { key: 'blue_south', name: 'Blue Supply Depot', kind: 'depot', lane: 'south', owner: 'blue', x: 22, y: 78, adj: 'blue_hq,mid_center,mid_south', fort: 35 },
    { key: 'mid_north', name: 'North Ridge', kind: 'strongpoint', lane: 'north', owner: 'neutral', x: 44, y: 24, adj: 'blue_north,blue_center,red_north,mid_center', fort: 20 },
    { key: 'mid_center', name: 'Central Relay', kind: 'relay', lane: 'center', owner: 'neutral', x: 50, y: 50, adj: 'blue_north,blue_center,blue_south,red_north,red_center,red_south,mid_north,mid_south', fort: 15 },
    { key: 'mid_south', name: 'South Depot', kind: 'depot', lane: 'south', owner: 'neutral', x: 44, y: 76, adj: 'blue_center,blue_south,red_center,red_south,mid_center', fort: 20 },
    { key: 'red_north', name: 'Red North Post', kind: 'post', lane: 'north', owner: 'red', x: 72, y: 22, adj: 'red_hq,mid_north,mid_center', fort: 35 },
    { key: 'red_center', name: 'Red Relay', kind: 'relay', lane: 'center', owner: 'red', x: 72, y: 50, adj: 'red_hq,mid_north,mid_center,mid_south', fort: 40 },
    { key: 'red_south', name: 'Red Supply Depot', kind: 'depot', lane: 'south', owner: 'red', x: 72, y: 78, adj: 'red_hq,mid_center,mid_south', fort: 35 },
    { key: 'red_hq', name: 'RED HQ', kind: 'hq', lane: 'base', owner: 'red', x: 92, y: 50, adj: 'red_north,red_center,red_south', fort: 70, hq: HQ_MAX_INTEGRITY },
  ];

  for (const n of nodes) {
    ctx.db.battleNode.insert({
      id: 0n,
      room_id,
      goal_id,
      node_key: n.key,
      name: n.name,
      kind: n.kind,
      lane: n.lane,
      owner: n.owner,
      status: 'held',
      x: n.x,
      y: n.y,
      adjacent_keys: n.adj,
      fortification: n.fort,
      blue_pressure: 0,
      red_pressure: 0,
      hq_integrity: n.hq ?? 0,
      updated_at: ctx.timestamp,
    });
  }
}

function seedOpeningTasks(ctx: any, room_id: bigint, goal_id: bigint): void {
  const nodes = [...ctx.db.battleNode.goal_id.filter(goal_id)];
  for (const node of nodes) {
    if (node.owner !== 'neutral') continue;
    insertBattleTask(ctx, room_id, goal_id, 'blue', node, 'scout', 4, 'lead');
    insertBattleTask(ctx, room_id, goal_id, 'red', node, 'scout', 4, 'lead');
    if (node.node_key === 'mid_center') {
      insertBattleTask(ctx, room_id, goal_id, 'blue', node, 'assault', 7, 'worker');
      insertBattleTask(ctx, room_id, goal_id, 'red', node, 'assault', 7, 'worker');
    }
  }
}

function legalTargets(ctx: any, goal_id: bigint, team: string): any[] {
  const nodes = [...ctx.db.battleNode.goal_id.filter(goal_id)];
  const owned = nodes.filter((n: any) => n.owner === team);
  const byKey = new Map(nodes.map((n: any) => [n.node_key, n]));
  const out = new Map<string, any>();
  for (const n of owned) {
    for (const key of adjKeys(n)) {
      const target = byKey.get(key);
      if (!target || target.owner === team) continue;
      out.set(String(target.id), target);
    }
  }
  return [...out.values()];
}

function ensureBattleTasks(ctx: any, goal_id: bigint, room_id: bigint): void {
  const g = ctx.db.goal.id.find(goal_id);
  if (!g || g.status !== 'active' || !isBattleGoal(ctx, goal_id)) return;

  for (const team of ['blue', 'red']) {
    const ts = teamRow(ctx, goal_id, team);
    if (!ts || ts.status !== 'fighting') continue;

    const current = activeBattleTasks(ctx, goal_id, team);
    if (current.length >= MAX_ACTIVE_BATTLE_TASKS) continue;

    const targets = legalTargets(ctx, goal_id, team).sort((a: any, b: any) => {
      const aw = a.kind === 'hq' ? 100 : a.owner === 'neutral' ? 20 : 40;
      const bw = b.kind === 'hq' ? 100 : b.owner === 'neutral' ? 20 : 40;
      return bw - aw;
    });

    for (const node of targets) {
      if (activeBattleTasks(ctx, goal_id, team).length >= MAX_ACTIVE_BATTLE_TASKS) break;
      const priority = node.kind === 'hq' ? 10 : node.owner === 'neutral' ? 5 : 7;
      insertBattleTask(ctx, room_id, goal_id, team, node, 'assault', priority, 'worker');
      if (node.fortification > 45 && activeBattleTasks(ctx, goal_id, team).length < MAX_ACTIVE_BATTLE_TASKS) {
        insertBattleTask(ctx, room_id, goal_id, team, node, 'sabotage', priority - 1, 'worker');
      }
    }

    const ownedUnderPressure = [...ctx.db.battleNode.goal_id.filter(goal_id)].filter((node: any) => {
      if (node.owner !== team) return false;
      const enemyPressure = team === 'blue' ? node.red_pressure : node.blue_pressure;
      return enemyPressure > 15;
    });
    for (const node of ownedUnderPressure) {
      if (activeBattleTasks(ctx, goal_id, team).length >= MAX_ACTIVE_BATTLE_TASKS) break;
      insertBattleTask(ctx, room_id, goal_id, team, node, 'defend', 8, 'worker');
    }
  }
}

function confidenceBonus(confidence: string): number {
  if (confidence === 'high') return 8;
  if (confidence === 'medium') return 4;
  return 0;
}

function modelBonus(model?: string): number {
  if (!model) return 0;
  if (/glm/i.test(model)) return 5;
  if (/grok/i.test(model)) return 7;
  if (/gpt-oss/i.test(model)) return 3;
  if (/mercury/i.test(model)) return 2;
  return 1;
}

function combatPower(ctx: any, tk: any, worker: any, latency_ms: number): number {
  const base: Record<string, number> = {
    scout: 8,
    assault: 22,
    defend: 22,
    fortify: 20,
    reinforce: 24,
    sabotage: 18,
  };
  const action = tk.action_type ?? 'assault';
  const speed = latency_ms > 0 && latency_ms <= Number(tk.deadline_ms) ? 6 : 0;
  const role = tk.required_role === 'lead' ? 4 : 0;
  return (base[action] ?? 20) + confidenceBonus(worker.confidence) + modelBonus(tk.assigned_model) + speed + role + ctx.random.integerInRange(0, 10);
}

function maybeEndBattle(ctx: any, goal_id: bigint, room_id: bigint, winner: string, reason: string): void {
  const g = ctx.db.goal.id.find(goal_id);
  if (!g || g.status !== 'active') return;
  const loser = enemyTeam(winner);
  for (const ts of [...ctx.db.teamState.goal_id.filter(goal_id)]) {
    ctx.db.teamState.id.update({
      ...ts,
      status: ts.team === winner ? 'winner' : ts.team === loser ? 'defeated' : ts.status,
      updated_at: ctx.timestamp,
    });
  }
  ctx.db.goal.id.update({ ...g, status: 'complete' });
  const r = ctx.db.room.id.find(room_id);
  if (r) ctx.db.room.id.update({ ...r, status: 'ended' });
  bumpScore(ctx, goal_id, winner === 'blue' ? PTS_MISSION : -PTS_MISSION);
  emit(ctx, room_id, winner === 'blue' ? 'battle_won' : 'battle_lost', `${winner.toUpperCase()} wins — ${reason}`, { goal_id });
}

function finishBattleByTerritory(ctx: any, goal_id: bigint, room_id: bigint, reason: string): void {
  const nodes = [...ctx.db.battleNode.goal_id.filter(goal_id)].filter((n: any) => n.kind !== 'hq');
  const blue = nodes.filter((n: any) => n.owner === 'blue').length;
  const red = nodes.filter((n: any) => n.owner === 'red').length;
  let winner = 'blue';
  if (red > blue) winner = 'red';
  if (blue === red) {
    const blueHq = teamRow(ctx, goal_id, 'blue')?.hq_integrity ?? 0;
    const redHq = teamRow(ctx, goal_id, 'red')?.hq_integrity ?? 0;
    winner = blueHq >= redHq ? 'blue' : 'red';
  }
  maybeEndBattle(ctx, goal_id, room_id, winner, `${reason}; territory ${blue}-${red}`);
}

function updateHqIntegrity(ctx: any, goal_id: bigint, team: string, integrity: number): void {
  const ts = teamRow(ctx, goal_id, team);
  if (ts) {
    ctx.db.teamState.id.update({
      ...ts,
      hq_integrity: integrity,
      updated_at: ctx.timestamp,
    });
  }
}

function resolveCapture(ctx: any, node: any, team: string, power: number): void {
  const enemy = enemyTeam(team);
  const room_id = node.room_id;
  const goal_id = node.goal_id;

  if (node.kind === 'hq' && node.owner === enemy) {
    const damage = Math.max(4, Math.floor(power * 0.25));
    const nextIntegrity = Math.max(0, node.hq_integrity - damage);
    ctx.db.battleNode.id.update({
      ...node,
      hq_integrity: nextIntegrity,
      status: nextIntegrity <= 35 ? 'damaged' : 'contested',
      fortification: Math.max(0, node.fortification - Math.floor(power / 4)),
      updated_at: ctx.timestamp,
    });
    updateHqIntegrity(ctx, goal_id, enemy, nextIntegrity);
    emit(ctx, room_id, 'hq_hit', `${team.toUpperCase()} hit ${node.name} for ${damage} integrity`, { goal_id });
    if (nextIntegrity <= 0) maybeEndBattle(ctx, goal_id, room_id, team, `${node.name} cracked`);
    return;
  }

  const ownPressure = team === 'blue' ? node.blue_pressure : node.red_pressure;
  const enemyPressure = team === 'blue' ? node.red_pressure : node.blue_pressure;
  const effective = Math.max(6, Math.floor(power * 0.75) - Math.floor(node.fortification / 10));
  const nextOwn = ownPressure + effective;
  const threshold =
    node.owner === 'neutral'
      ? NEUTRAL_CAPTURE_THRESHOLD
      : CAPTURE_THRESHOLD + Math.floor(node.fortification / 2);

  if (nextOwn >= threshold) {
    ctx.db.battleNode.id.update({
      ...node,
      owner: team,
      status: 'held',
      fortification: Math.min(NODE_FORTIFY_MAX, Math.max(15, Math.floor(node.fortification / 2) + 12)),
      blue_pressure: 0,
      red_pressure: 0,
      updated_at: ctx.timestamp,
    });
    bumpScore(ctx, goal_id, team === 'blue' ? 120n : -80n);
    emit(ctx, room_id, 'node_captured', `${team.toUpperCase()} captured ${node.name}`, { goal_id });
    ensureBattleTasks(ctx, goal_id, room_id);
    return;
  }

  ctx.db.battleNode.id.update({
    ...node,
    status: nextOwn > enemyPressure ? 'contested' : node.status,
    blue_pressure: team === 'blue' ? nextOwn : Math.max(0, enemyPressure - Math.floor(power / 3)),
    red_pressure: team === 'red' ? nextOwn : Math.max(0, enemyPressure - Math.floor(power / 3)),
    fortification: Math.max(0, node.fortification - Math.floor(power / 12)),
    updated_at: ctx.timestamp,
  });
  emit(ctx, room_id, 'assault_pressure', `${team.toUpperCase()} pressed ${node.name} (+${effective})`, { goal_id });
}

function resolveDefense(ctx: any, node: any, team: string, power: number): void {
  const enemyPressureKey = team === 'blue' ? 'red_pressure' : 'blue_pressure';
  const nextEnemyPressure = Math.max(0, node[enemyPressureKey] - Math.floor(power * 0.8));
  const update: any = {
    ...node,
    status: nextEnemyPressure > 0 ? 'contested' : 'held',
    fortification: Math.min(NODE_FORTIFY_MAX, node.fortification + Math.floor(power / 4)),
    updated_at: ctx.timestamp,
  };
  update[enemyPressureKey] = nextEnemyPressure;
  ctx.db.battleNode.id.update(update);
  bumpScore(ctx, node.goal_id, team === 'blue' ? 40n : -20n);
  emit(ctx, node.room_id, 'node_defended', `${team.toUpperCase()} reinforced ${node.name}`, { goal_id: node.goal_id });
}

function resolveSabotage(ctx: any, node: any, team: string, power: number): void {
  const pressureKey = team === 'blue' ? 'blue_pressure' : 'red_pressure';
  const update: any = {
    ...node,
    status: node.owner === team ? node.status : 'contested',
    fortification: Math.max(0, node.fortification - Math.floor(power * 0.5)),
    updated_at: ctx.timestamp,
  };
  update[pressureKey] = node[pressureKey] + Math.floor(power / 4);
  ctx.db.battleNode.id.update(update);
  bumpScore(ctx, node.goal_id, team === 'blue' ? 60n : -35n);
  emit(ctx, node.room_id, 'sabotage', `${team.toUpperCase()} sabotaged ${node.name}`, { goal_id: node.goal_id });
}

function resolveScout(ctx: any, node: any, team: string, power: number): void {
  const pressureKey = team === 'blue' ? 'blue_pressure' : 'red_pressure';
  const nudge = Math.max(3, Math.floor(power / 5));
  const update: any = {
    ...node,
    status: node.owner === 'neutral' ? 'contested' : node.status,
    updated_at: ctx.timestamp,
  };
  update[pressureKey] = node[pressureKey] + nudge;
  ctx.db.battleNode.id.update(update);
  emit(ctx, node.room_id, 'scout_report', `${team.toUpperCase()} recon marked ${node.name} (+${nudge})`, { goal_id: node.goal_id });
}

function applyOrderSurge(ctx: any, node: any, team: string, order_type: string): void {
  const enemy = enemyTeam(team);
  const ownKey = team === 'blue' ? 'blue_pressure' : 'red_pressure';
  const enemyKey = team === 'blue' ? 'red_pressure' : 'blue_pressure';
  const goal_id = node.goal_id;
  const room_id = node.room_id;

  if (node.kind === 'hq' && node.owner === enemy && order_type === 'assault') {
    const damage = 3;
    const nextIntegrity = Math.max(0, node.hq_integrity - damage);
    ctx.db.battleNode.id.update({
      ...node,
      hq_integrity: nextIntegrity,
      status: nextIntegrity <= 35 ? 'damaged' : 'contested',
      fortification: Math.max(0, node.fortification - 5),
      updated_at: ctx.timestamp,
    });
    updateHqIntegrity(ctx, goal_id, enemy, nextIntegrity);
    emit(ctx, room_id, 'order_effect', `${team.toUpperCase()} command strike clipped ${node.name} (-${damage} HQ)`, { goal_id });
    if (nextIntegrity <= 0) maybeEndBattle(ctx, goal_id, room_id, team, `${node.name} cracked by command strike`);
    return;
  }

  const update: any = { ...node, updated_at: ctx.timestamp };
  let msg = '';
  if (order_type === 'assault') {
    update[ownKey] = node[ownKey] + 18;
    update[enemyKey] = Math.max(0, node[enemyKey] - 6);
    update.fortification = Math.max(0, node.fortification - 3);
    update.status = node.owner === team ? node.status : 'contested';
    msg = `command surge pressed ${node.name} (+18 pressure)`;
  } else if (order_type === 'defend' || order_type === 'reinforce') {
    update[enemyKey] = Math.max(0, node[enemyKey] - 20);
    update.fortification = Math.min(NODE_FORTIFY_MAX, node.fortification + 8);
    update.status = node.owner === team ? (update[enemyKey] > 0 ? 'contested' : 'held') : 'contested';
    msg = `command hold stabilized ${node.name} (-20 enemy pressure)`;
  } else if (order_type === 'sabotage') {
    update[ownKey] = node[ownKey] + 8;
    update.fortification = Math.max(0, node.fortification - 14);
    update.status = node.owner === team ? node.status : 'contested';
    msg = `command sabotage weakened ${node.name} (-14 fortification)`;
  } else if (order_type === 'scout') {
    update[ownKey] = node[ownKey] + 6;
    update.status = node.owner === 'neutral' ? 'contested' : node.status;
    msg = `command scout marked ${node.name} (+6 pressure)`;
  } else {
    return;
  }

  ctx.db.battleNode.id.update(update);
  emit(ctx, room_id, 'order_effect', `${team.toUpperCase()} ${msg}`, { goal_id });
}

function applyCombatResult(ctx: any, tk: any, worker: any, latency_ms: number, estimated_cost_micros: bigint): void {
  const room_id = tk.room_id;
  const goal_id = tk.goal_id;
  const team = tk.team || 'blue';
  const node = tk.target_node_id !== undefined ? ctx.db.battleNode.id.find(tk.target_node_id) : null;

  ctx.db.task.id.update({
    ...tk,
    status: worker.outcome === 'blocked' ? 'blocked' : 'done',
    result: worker.result,
    risk: worker.risk,
    confidence: worker.confidence,
    latency_ms,
    cost_micros: estimated_cost_micros,
    updated_at: ctx.timestamp,
  });
  freeAgent(ctx, tk.assigned_agent_id);

  if (!node || worker.outcome === 'blocked') {
    bumpScore(ctx, goal_id, worker.outcome === 'blocked' ? PEN_BLOCKED : PTS_VALID, { valid: worker.outcome === 'blocked' ? 0 : 1 });
    emit(ctx, room_id, worker.outcome === 'blocked' ? 'task_blocked' : 'result_posted', `${team.toUpperCase()} ${worker.outcome}: "${tk.title}"`, {
      goal_id,
      task_id: tk.id,
      agent_id: tk.assigned_agent_id,
    });
    ensureBattleTasks(ctx, goal_id, room_id);
    return;
  }

  const power = combatPower(ctx, tk, worker, latency_ms);
  if (tk.action_type === 'defend' || tk.action_type === 'fortify' || tk.action_type === 'reinforce') {
    resolveDefense(ctx, node, team, power);
  } else if (tk.action_type === 'sabotage') {
    resolveSabotage(ctx, node, team, power);
  } else if (tk.action_type === 'scout') {
    resolveScout(ctx, node, team, power);
  } else {
    resolveCapture(ctx, node, team, power);
  }

  bumpScore(ctx, goal_id, team === 'blue' ? PTS_VALID : -40n, { valid: 1 });
  emit(ctx, room_id, 'combat_result', `${team.toUpperCase()} ${tk.action_type} resolved at ${node.name} (${power})`, {
    goal_id,
    task_id: tk.id,
    agent_id: tk.assigned_agent_id,
  });
  ensureBattleTasks(ctx, goal_id, room_id);
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
  ctx.db.battleTimer.insert({
    scheduled_id: 0n,
    scheduled_at: ScheduleAt.interval(BATTLE_INTERVAL_MICROS),
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
    upsertOperator(ctx, r.id, display_name, 'blue', false);
    emit(ctx, r.id, 'room_created', `${display_name} created lobby ${name} as BLUE`, {
      operator_id: ctx.sender,
    });
  }
);

export const joinRoom = spacetimedb.reducer(
  { room_id: t.u64(), display_name: t.string(), team: t.string() },
  (ctx, { room_id, display_name, team }) => {
    const r = ctx.db.room.id.find(room_id);
    if (!r) throw new SenderError('room not found');
    const claimedTeam = isPlayableTeam(team) ? team : 'spectator';
    if (r.status === 'setup') assertTeamAvailable(ctx, room_id, claimedTeam);
    upsertOperator(ctx, room_id, display_name, claimedTeam, false);
    emit(ctx, room_id, 'operator_joined', `${display_name} joined as ${claimedTeam.toUpperCase()}`, { operator_id: ctx.sender });
  }
);

export const submitDraft = spacetimedb.reducer(
  {
    room_id: t.u64(),
    team: t.string(),
    ready: t.bool(),
    title: t.string(),
    max_depth: t.u32(),
    max_tasks: t.u32(),
    deadline_ms: t.u64(),
    run_budget_micros: t.u64(),
    crew: t.array(CrewSpec),
  },
  (ctx, { room_id, team, ready, title, max_depth, max_tasks, deadline_ms, run_budget_micros, crew }) => {
    const r = ctx.db.room.id.find(room_id);
    if (!r) throw new SenderError('room not found');
    if (r.status !== 'setup') throw new SenderError('draft is closed');

    const op = requireTeamCommander(ctx, room_id, team);
    replaceDraft(ctx, room_id, team, crew);
    const rows = draftRows(ctx, room_id, team);
    if (ready) validateDraft(rows);

    ctx.db.operator.identity.update({
      ...op,
      ready,
      selected_task_id: undefined,
      last_heartbeat: ctx.timestamp,
    });

    const stats = draftStats(rows);
    emit(ctx, room_id, ready ? 'draft_locked' : 'draft_updated', `${team.toUpperCase()} ${ready ? 'locked' : 'updated'} ${stats.units} units (${stats.points}/${DRAFT_POINTS_CAP} pts)`, {
      operator_id: ctx.sender,
    });
    maybeStartBattleFromDrafts(ctx, room_id, title, max_depth, max_tasks, deadline_ms, run_budget_micros);
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

    seedBattlefield(ctx, room_id, g.id, run_budget_micros);

    // Persist the assembled crew so the auto-runner deploys exactly this fleet.
    // Blue is human-commanded. Red mirrors the same fleet for a fair AI rival.
    for (const slot of crew) {
      if (slot.count <= 0 || slot.model.length === 0) continue;
      ctx.db.crewSlot.insert({
        id: 0n,
        room_id,
        goal_id: g.id,
        role: slot.role,
        team: 'blue',
        model: slot.model,
        count: slot.count,
      });
      ctx.db.crewSlot.insert({
        id: 0n,
        room_id,
        goal_id: g.id,
        role: slot.role,
        team: 'red',
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
    seedOpeningTasks(ctx, room_id, g.id);
    ensureBattleTasks(ctx, g.id, room_id);
    emit(ctx, room_id, 'battle_started', `Blue vs Red battle opened: ${title}`, { goal_id: g.id });
  }
);

export const registerAgent = spacetimedb.reducer(
  { room_id: t.u64(), name: t.string(), model: t.string(), role: t.string(), team: t.string() },
  (ctx, { room_id, name, model, role, team }) => {
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
        team,
        status: 'idle',
        conn: ctx.connectionId ?? undefined,
        last_heartbeat: ctx.timestamp,
      });
      emit(ctx, room_id, 'agent_registered', `${team.toUpperCase()} ${name} re-registered on ${model}`, {
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
        team,
        status: 'idle',
        current_task_id: undefined,
        latest_thought: '',
        conn: ctx.connectionId ?? undefined,
        last_heartbeat: ctx.timestamp,
      });
      emit(ctx, room_id, 'agent_registered', `${team.toUpperCase()} ${name} joined on ${model}`, { agent_id: a.id });
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

    const pending = [...ctx.db.task.by_room_status.filter([room_id, 'pending'])]
      .filter((tk: any) => tk.goal_id === activeGoal.id && (tk.team || 'blue') === (a.team || 'blue'))
      .sort((x: any, y: any) => {
        if (x.priority !== y.priority) return y.priority - x.priority;
        return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
      });
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
        if (isBattleGoal(ctx, goal_id)) {
          finishBattleByTerritory(ctx, goal_id, room_id, 'supplies exhausted');
        } else {
          ctx.db.goal.id.update({ ...g, status: 'stopped' });
          emit(ctx, room_id, 'budget_exhausted', `Supplies exhausted — mission halted`, { goal_id });
        }
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

    if (tk.target_node_id !== undefined) {
      applyCombatResult(ctx, tk, worker, latency_ms, estimated_cost_micros);
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
            team: tk.team || 'blue',
            target_node_id: undefined,
            action_type: 'plan',
            priority: 1,
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

export const issueOrder = spacetimedb.reducer(
  {
    room_id: t.u64(),
    target_node_id: t.u64(),
    order_type: t.string(), // 'assault' | 'defend' | 'sabotage' | 'reinforce' | 'scout'
    team: t.string(),
  },
  (ctx, { room_id, target_node_id, order_type, team }) => {
    const activeGoal = [...ctx.db.goal.room_id.filter(room_id)].find((g: any) => g.status === 'active');
    if (!activeGoal) throw new SenderError('no active battle');
    const node = ctx.db.battleNode.id.find(target_node_id);
    if (!node || node.goal_id !== activeGoal.id) throw new SenderError('battle node not found');
    requireTeamCommander(ctx, room_id, team);

    const ts = teamRow(ctx, activeGoal.id, team);
    if (!ts || ts.status !== 'fighting') throw new SenderError('team is not fighting');
    if (ts.command_tokens <= 0) throw new SenderError('no command tokens');

    const action = order_type === 'reinforce' ? 'reinforce' : order_type;
    const existing = activeBattleTasks(ctx, activeGoal.id, team).find(
      (tk: any) => tk.target_node_id === target_node_id && tk.action_type === action
    );
    if (existing) {
      ctx.db.task.id.update({ ...existing, priority: Math.max(existing.priority, 12), updated_at: ctx.timestamp });
    } else {
      insertBattleTask(ctx, room_id, activeGoal.id, team, node, action, 12, action === 'scout' ? 'lead' : 'worker');
    }
    applyOrderSurge(ctx, node, team, order_type);

    ctx.db.teamState.id.update({
      ...ts,
      command_tokens: ts.command_tokens - 1,
      updated_at: ctx.timestamp,
    });
    ctx.db.battleOrder.insert({
      id: 0n,
      room_id,
      goal_id: activeGoal.id,
      team,
      target_node_id,
      order_type,
      priority: 12,
      status: 'active',
      issued_by: ctx.sender,
      created_at: ctx.timestamp,
      expires_at_micros: ctx.timestamp.microsSinceUnixEpoch + 30_000_000n,
    });
    bumpScore(ctx, activeGoal.id, team === 'blue' ? PTS_OVERRIDE : 0n, { overrides: team === 'blue' ? 1 : 0 });
    emit(ctx, room_id, 'human_order', `${team.toUpperCase()} order: ${order_type} ${node.name}`, {
      goal_id: activeGoal.id,
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

// ---- Battle director --------------------------------------------------------

export const battleTick = spacetimedb.reducer(
  { timer: battleTimer.rowType },
  (ctx, _args) => {
    const now = ctx.timestamp.microsSinceUnixEpoch;

    for (const order of [...ctx.db.battleOrder.iter()]) {
      if (order.status !== 'active' || now <= order.expires_at_micros) continue;
      ctx.db.battleOrder.id.update({ ...order, status: 'expired' });
    }

    for (const g of [...ctx.db.goal.iter()]) {
      if (g.status !== 'active' || !isBattleGoal(ctx, g.id)) continue;

      for (const ts of [...ctx.db.teamState.goal_id.filter(g.id)]) {
        if (ts.status !== 'fighting') continue;
        const depotBonus = [...ctx.db.battleNode.goal_id.filter(g.id)].filter(
          (n: any) => n.owner === ts.team && n.kind === 'depot'
        ).length;
        const maxTokens = MAX_COMMAND_TOKENS + Math.min(1, depotBonus);
        if (ts.command_tokens < maxTokens) {
          ctx.db.teamState.id.update({
            ...ts,
            command_tokens: ts.command_tokens + 1,
            updated_at: ctx.timestamp,
          });
        }
      }

      ensureBattleTasks(ctx, g.id, g.room_id);
      checkBudget(ctx, g.id, g.room_id);
    }
  }
);

// ---- Crisis director --------------------------------------------------------

function checkBudget(ctx: any, goal_id: bigint, room_id: bigint): void {
  const g = ctx.db.goal.id.find(goal_id);
  if (!g || g.status !== 'active' || g.run_budget_micros <= 0n) return;
  const s = ctx.db.score.goal_id.find(goal_id);
  if (s && s.estimated_cost_micros >= g.run_budget_micros) {
    if (isBattleGoal(ctx, goal_id)) {
      finishBattleByTerritory(ctx, goal_id, room_id, 'supplies exhausted');
    } else {
      ctx.db.goal.id.update({ ...g, status: 'stopped' });
      emit(ctx, room_id, 'budget_exhausted', 'Supplies exhausted — mission halted', { goal_id });
    }
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
      if (isBattleGoal(ctx, c.goal_id)) {
        ctx.db.crisis.id.update({ ...c, status: 'expired', choice: -1 });
        continue;
      }
      applyCrisisEffect(ctx, c, -1);
      ctx.db.crisis.id.update({ ...c, status: 'expired', choice: -1 });
    }

    // Maybe throw a new crisis at each active operation with real work left.
    for (const g of [...ctx.db.goal.iter()]) {
      if (g.status !== 'active') continue;
      const isBattle = isBattleGoal(ctx, g.id);
      if (isBattle) continue;
      const age = now - g.created_at.microsSinceUnixEpoch;

      const hasActive = [...ctx.db.crisis.iter()].some((c: any) => c.room_id === g.room_id && c.status === 'active');
      if (hasActive) continue;
      const hasRecent = [...ctx.db.crisis.iter()].some((c: any) => c.room_id === g.room_id && now - c.created_at.microsSinceUnixEpoch < CRISIS_COOLDOWN_MICROS);
      if (hasRecent) continue;
      const hasWork = [...ctx.db.task.goal_id.filter(g.id)].some((tk: any) => tk.status === 'pending' || tk.status === 'claimed');
      if (!hasWork) continue;
      if (ctx.random() > 0.45) continue;

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
