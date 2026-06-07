import { num } from '../lib/format';

export function TopStrip({ goal, score, tasks, agents }: any) {
  const total = tasks.length;
  const done = tasks.filter((t: any) => t.status === 'done').length;
  const remaining = tasks.filter((t: any) => t.status === 'pending' || t.status === 'claimed').length;
  const completion = total ? Math.round((done / total) * 100) : 0;
  const working = agents.filter((a: any) => a.status === 'working').length;

  const valid = num(score?.validResults);
  const late = num(score?.lateResults);
  const invalid = num(score?.invalidResults);
  const onTime = valid + late ? Math.round((valid / (valid + late)) * 100) : 100;
  const validRate = valid + invalid ? Math.round((valid / (valid + invalid)) * 100) : 100;
  const cost = num(score?.estimatedCostMicros) / 1_000_000;
  const points = num(score?.points);

  const statusTone =
    goal?.status === 'complete' ? 'good' : goal?.status === 'active' ? 'cy' : 'warn';

  return (
    <div className="topstrip">
      <div className="brand">
        <svg className="logo" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="3" fill="var(--cyan-bright)" />
          {[0, 60, 120, 180, 240, 300].map((a) => {
            const r = (a * Math.PI) / 180;
            return (
              <circle
                key={a}
                cx={12 + Math.cos(r) * 8}
                cy={12 + Math.sin(r) * 8}
                r="1.7"
                fill="var(--cyan)"
              />
            );
          })}
        </svg>
        <div className="title">
          SWARM<small>AI SWARM · EXPEDITION COMMAND</small>
        </div>
      </div>

      <div className="mission-name">
        <span className="micro">Expedition</span>
        <span className="v">{goal?.title ?? 'Awaiting expedition'}</span>
      </div>

      <Stat label="Status" value={(goal?.status ?? '—').toUpperCase()} tone={statusTone} />
      <Stat label="Score" value={points.toLocaleString()} tone="cy" />
      <Stat label="Progress" value={`${completion}%`} tone={completion === 100 ? 'good' : ''} />
      <Stat label="Objectives" value={remaining} tone={remaining ? '' : 'good'} />
      <Stat label="Crew" value={`${working}/${agents.length}`} tone={working ? 'warn' : ''} />
      <Stat label="On-Time" value={`${onTime}%`} tone={onTime >= 80 ? 'good' : 'warn'} />
      <Stat label="Valid" value={`${validRate}%`} tone={validRate >= 90 ? 'good' : 'warn'} />
      <Stat label="Cost" value={`$${cost.toFixed(4)}`} />
    </div>
  );
}

function Stat({ label, value, tone = '' }: { label: string; value: any; tone?: string }) {
  return (
    <div className="stat">
      <span className="micro">{label}</span>
      <span className={`v ${tone}`}>{value}</span>
    </div>
  );
}
