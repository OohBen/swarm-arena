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

  const models: Record<string, any> = {};
  for (const t of tasks) {
    const m = t.assignedModel;
    if (!m) continue;
    const e = models[m] ?? (models[m] = { model: m, tasks: 0, done: 0, lat: [] as number[], cost: 0, under: 0 });
    e.tasks++;
    if (t.status === 'done') {
      e.done++;
      const l = num(t.latencyMs);
      if (l > 0) { e.lat.push(l); if (l <= deadlineMs) e.under++; }
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
  const stopped = goal?.status === 'stopped';
  const verdict = complete ? 'MISSION ACCOMPLISHED' : stopped ? 'SUPPLIES EXHAUSTED' : 'OPERATION ENDED';

  return (
    <div className="ar">
      <div className="ar-sheet">
        <div className="ar-head">
          <div className="ar-head-l">
            <span className={`ar-stamp ${complete ? 'win' : 'fail'}`}>{verdict}</span>
            <h1 className="ar-h1">AFTER-ACTION REPORT</h1>
            <div className="ar-op">{goal?.title}</div>
          </div>
          <div className="ar-score">
            <div className="ar-k">Final Score</div>
            <div className="ar-score-v">{num(score?.points).toLocaleString()}</div>
            <button className="ar-back" onClick={onBack}>◂ Back to Operation</button>
          </div>
        </div>

        <div className="ar-stats">
          <Stat k="Completion" v={`${completion}%`} tone={completion === 100 ? 'good' : ''} />
          <Stat k="On-Time" v={`${onTime}%`} tone={onTime >= 80 ? 'good' : 'warn'} />
          <Stat k="Valid Output" v={`${validRate}%`} tone={validRate >= 90 ? 'good' : 'warn'} />
          <Stat k="Objectives" v={done.length} />
          <Stat k="Run Time" v={`${durationS}s`} />
          <Stat k="Supplies Spent" v={`$${cost.toFixed(4)}`} tone="blue" />
        </div>

        <div className="ar-cols">
          <div className="ar-panel">
            <div className="ar-panel-h">CREW PERFORMANCE · real latency &amp; cost</div>
            <table className="ar-table">
              <thead>
                <tr><th>Unit</th><th>Done</th><th>Avg</th><th>p95</th><th>&lt;{(deadlineMs / 1000).toFixed(1)}s</th><th>Cost</th><th>Value</th></tr>
              </thead>
              <tbody>
                {modelRows.length === 0 && <tr><td colSpan={7} className="ar-empty">No engagement data.</td></tr>}
                {modelRows.map((r: any) => (
                  <tr key={r.model}>
                    <td className="ar-unit">{r.model}</td>
                    <td>{r.done}</td>
                    <td>{r.avg}ms</td>
                    <td>{r.p95}ms</td>
                    <td className={r.under >= 80 ? 'good' : 'warn'}>{r.under}%</td>
                    <td>${r.cost.toFixed(4)}</td>
                    <td className="blue">{r.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="ar-panel ar-coord">
            <div className="ar-panel-h">COORDINATION · SPACETIMEDB</div>
            <div className="ar-coord-b">
              <Line k="Objectives claimed (atomic)" v={tally('task_claimed')} tone="blue" />
              <Line k="Sub-objectives spawned" v={tally('children_spawned')} />
              <Line k="Crew recovered (stale lease)" v={tally('stale_recovery')} tone="warn" />
              <Line k="Commander saves" v={tally('human_override')} tone="human" />
              <Line k="Crises weathered" v={tally('crisis_resolved')} tone="warn" />
              <div className="ar-div" />
              <Line k="Deadline misses" v={tally('deadline_missed')} tone="bad" />
              <Line k="Invalid results" v={invalid} tone="bad" />
              <Line k="Objectives lost" v={tally('task_blocked')} tone="bad" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ k, v, tone = '' }: any) {
  return <div className="ar-stat"><div className="ar-k">{k}</div><div className={`ar-stat-v ${tone}`}>{v}</div></div>;
}
function Line({ k, v, tone = '' }: any) {
  return <div className="ar-line"><span>{k}</span><b className={tone}>{v}</b></div>;
}
