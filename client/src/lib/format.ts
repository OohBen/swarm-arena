// Helpers for rendering SpacetimeDB rows. Timestamps arrive as { microsSinceUnixEpoch: bigint }.

export function microsToMs(ts: any): number {
  if (!ts) return 0;
  const micros: bigint = ts.microsSinceUnixEpoch ?? 0n;
  return Number(micros / 1000n);
}

export function ago(ts: any): string {
  const ms = microsToMs(ts);
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 1000) return 'now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  return `${Math.floor(diff / 3_600_000)}h`;
}

export function clockTime(ts: any): string {
  const ms = microsToMs(ts);
  if (!ms) return '--:--:--';
  const d = new Date(ms);
  return d.toLocaleTimeString('en-US', { hour12: false });
}

// Task status → visual treatment.
export const TASK_COLORS: Record<string, string> = {
  pending: 'var(--c-pending)',
  claimed: 'var(--c-working)',
  done: 'var(--c-done)',
  blocked: 'var(--c-blocked)',
  cancelled: 'var(--c-muted)',
  paused: 'var(--c-paused)',
};

export const EVENT_TONE: Record<string, string> = {
  room_created: 'sys',
  operator_joined: 'sys',
  goal_submitted: 'sys',
  agent_registered: 'sys',
  task_claimed: 'claim',
  result_posted: 'good',
  children_spawned: 'spawn',
  mission_complete: 'win',
  deadline_missed: 'bad',
  invalid_result: 'bad',
  task_blocked: 'bad',
  budget_hit: 'warn',
  stale_recovery: 'warn',
  human_override: 'human',
};

export function dollars(micros: bigint | number | undefined): string {
  const m = typeof micros === 'bigint' ? Number(micros) : (micros ?? 0);
  return `$${(m / 1_000_000).toFixed(4)}`;
}

export function num(v: bigint | number | undefined): number {
  if (typeof v === 'bigint') return Number(v);
  return v ?? 0;
}
