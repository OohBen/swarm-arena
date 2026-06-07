import { ago } from '../lib/format';
import { classOf } from '../lib/missions';

export function AgentRoster({ agents, tasks }: any) {
  const sorted = [...agents].sort((a: any, b: any) => Number(a.id - b.id));
  const active = agents.filter((a: any) => a.status === 'working').length;
  return (
    <div className="panel grow">
      <div className="panel-h">
        <span className="micro">Active Crew</span>
        <span className="micro">{active}/{agents.length} on task</span>
      </div>
      <div className="panel-b">
        {sorted.length === 0 && <div className="empty-hint">No crew deployed yet.<br/>Run the deploy command.</div>}
        {sorted.map((a: any) => {
          const task = a.currentTaskId != null ? tasks.find((t: any) => t.id === a.currentTaskId) : null;
          return (
            <div key={String(a.id)} className={`agent ${a.status}`}>
              <span className="dot" />
              <div style={{ minWidth: 0 }}>
                <div className="nm">{a.name}</div>
                <div className="md">{classOf(a.model)} unit</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="st">{a.status}</div>
                <div className="md">{ago(a.lastHeartbeat)}</div>
              </div>
              <div className="th">
                {a.status === 'working' && task ? `▸ ${task.title}` : a.latestThought || '—'}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
