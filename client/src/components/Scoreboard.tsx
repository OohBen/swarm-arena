import { num, microsToMs } from '../lib/format';
import { classOf } from '../lib/missions';

function pctl(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}

export function Scoreboard({ goal, score, tasks, events, onBack }: any) {
  const done = tasks.filter((t: any) => t.status === 'done');
  const total = tasks.length;
  const completion = total ? Math.round((done.length / total) * 100) : 0;
  const deadlineMs = num(goal?.deadlineMs) || 2000;

  // ---- per-model split (real latency/cost from task rows) ----
  const models: Record<string, any> = {};
  for (const t of tasks) {
    const m = t.assignedModel;
    if (!m) continue;
    const e = models[m] ?? (models[m] = { model: m, tasks: 0, done: 0, lat: [] as number[], cost: 0, under: 0 });
    e.tasks++;
    if (t.status === 'done') {
      e.done++;
      const l = num(t.latencyMs);
      if (l > 0) {
        e.lat.push(l);
        if (l <= deadlineMs) e.under++;
      }
      e.cost += num(t.costMicros) / 1_000_000;
    }
  }
  const modelRows = Object.values(models)
    .map((e: any) => ({
      model: classOf(e.model),
      done: e.done,
      avg: e.lat.length ? Math.round(e.lat.reduce((a: number, b: number) => a + b, 0) / e.lat.length) : 0,
      p95: pctl(e.lat, 0.95),
      under: e.lat.length ? Math.round((e.under / e.lat.length) * 100) : 0,
      cost: e.cost,
      value: e.cost > 0 ? Math.round((e.done * 100) / (e.cost * 1000)) : 0,
    }))
    .sort((a, b) => b.done - a.done);

  const tally = (k: string) => events.filter((e: any) => e.kind === k).length;
  const valid = num(score?.validResults);
  const late = num(score?.lateResults);
  const invalid = num(score?.invalidResults);
  const onTime = valid + late ? Math.round((valid / (valid + late)) * 100) : 100;
  const validRate = valid + invalid ? Math.round((valid / (valid + invalid)) * 100) : 100;
  const cost = num(score?.estimatedCostMicros) / 1_000_000;

  const times = events.map((e: any) => microsToMs(e.createdAt)).filter((x: number) => x > 0);
  const durationS = times.length ? Math.round((Math.max(...times) - Math.min(...times)) / 1000) : 0;

  const complete = goal?.status === 'complete';

  return (
    <div className="scoreboard">
      <div className="sb-inner">
        <div className="sb-head">
          <div>
            <div className="micro">Expedition Report</div>
            <div className={`sb-status ${complete ? 'win' : ''}`}>
              {complete ? 'EXPEDITION COMPLETE' : (goal?.status ?? 'in progress').toUpperCase()}
            </div>
            <div className="sb-mission">{goal?.title}</div>
          </div>
          <div className="sb-score">
            <div className="micro">Final Score</div>
            <div className="sb-score-v">{num(score?.points).toLocaleString()}</div>
          </div>
          <button className="btn ghost" style={{ width: 160, alignSelf: 'flex-start' }} onClick={onBack}>
            ◂ Back to Live
          </button>
        </div>

        <div className="sb-stats">
          <Big label="Completion" v={`${completion}%`} tone={completion === 100 ? 'good' : ''} />
          <Big label="On-Time Rate" v={`${onTime}%`} tone={onTime >= 80 ? 'good' : 'warn'} />
          <Big label="Valid Output" v={`${validRate}%`} tone={validRate >= 90 ? 'good' : 'warn'} />
          <Big label="Tasks Done" v={done.length} />
          <Big label="Run Time" v={`${durationS}s`} />
          <Big label="Total Cost" v={`$${cost.toFixed(4)}`} tone="cy" />
        </div>

        <div className="sb-cols">
          <div className="panel" style={{ flex: 1 }}>
            <div className="panel-h"><span className="micro">Crew Performance · real latency &amp; cost</span></div>
            <div className="panel-b" style={{ padding: 0 }}>
              <table className="sb-table">
                <thead>
                  <tr>
                    <th>Model</th><th>Done</th><th>Avg</th><th>p95</th><th>&lt;{(deadlineMs/1000).toFixed(1)}s</th><th>Cost</th><th>Pts/¢</th>
                  </tr>
                </thead>
                <tbody>
                  {modelRows.length === 0 && (
                    <tr><td colSpan={7} style={{ color: 'var(--ink-faint)', fontStyle: 'italic', padding: 16 }}>No model data yet.</td></tr>
                  )}
                  {modelRows.map((r: any) => (
                    <tr key={r.model}>
                      <td className="hud" style={{ color: 'var(--ink)' }}>{r.model}</td>
                      <td>{r.done}</td>
                      <td>{r.avg}ms</td>
                      <td>{r.p95}ms</td>
                      <td className={r.under >= 80 ? 'good' : 'warn'}>{r.under}%</td>
                      <td>${r.cost.toFixed(4)}</td>
                      <td className="cy">{r.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel" style={{ width: 320 }}>
            <div className="panel-h"><span className="micro">Coordination · SpacetimeDB</span></div>
            <div className="panel-b">
              <Line label="Objectives claimed (atomic)" v={tally('task_claimed')} tone="cy" />
              <Line label="Sub-objectives spawned" v={tally('children_spawned')} />
              <Line label="Crew recovered (stale lease)" v={tally('stale_recovery')} tone="warn" />
              <Line label="Commander saves" v={tally('human_override')} tone="human" />
              <div className="sb-div" />
              <Line label="Deadline misses" v={tally('deadline_missed')} tone="bad" />
              <Line label="Invalid results" v={invalid} tone="bad" />
              <Line label="Supply caps hit" v={tally('budget_hit')} tone="warn" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Big({ label, v, tone = '' }: any) {
  return (
    <div className="sb-big">
      <div className="micro">{label}</div>
      <div className={`sb-big-v ${tone}`}>{v}</div>
    </div>
  );
}

function Line({ label, v, tone = '' }: any) {
  return (
    <div className="sb-line">
      <span>{label}</span>
      <span className={`mono ${tone}`} style={{ fontWeight: 600 }}>{v}</span>
    </div>
  );
}
