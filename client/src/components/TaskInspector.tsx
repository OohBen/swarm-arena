import { TASK_COLORS, ago } from '../lib/format';
import { classOf } from '../lib/missions';

export function TaskInspector({ task, agents, roomId, conn }: any) {
  if (!task) {
    return (
      <div className="panel grow">
        <div className="panel-h">
          <span className="micro">Objective Detail</span>
        </div>
        <div className="panel-b">
          <div className="insp-empty">Select an objective on the map to inspect it and command your crew.</div>
        </div>
      </div>
    );
  }

  const agent = task.assignedAgentId != null ? agents.find((a: any) => a.id === task.assignedAgentId) : null;
  const color = TASK_COLORS[task.status] ?? TASK_COLORS.pending;

  const override = (action: string, extra: any = {}) => {
    if (!conn) return;
    conn.reducers.humanOverride({
      roomId,
      taskId: task.id,
      action,
      title: extra.title ?? undefined,
      targetTaskId: extra.targetTaskId ?? undefined,
    });
  };

  return (
    <div className="panel grow">
      <div className="panel-h">
        <span className="micro">Objective Detail</span>
        <span className="tag" style={{ color }}>{task.status}</span>
      </div>
      <div className="panel-b">
        <div className="kv">
          <span className="k">Title</span>
          <span className="vv">{task.title}</span>
          <span className="k">Depth</span>
          <span className="vv">{task.depth} · attempt ×{task.attempts}</span>
          <span className="k">Crew</span>
          <span className="vv">{agent ? agent.name : '—'}</span>
          <span className="k">Unit</span>
          <span className="vv">{classOf(task.assignedModel)}</span>
          <span className="k">Confidence</span>
          <span className="vv">{task.confidence ?? '—'}</span>
          <span className="k">Updated</span>
          <span className="vv">{ago(task.updatedAt)} ago</span>
        </div>

        {task.result && (
          <>
            <span className="micro">Result</span>
            <div className="result-box">{task.result}</div>
          </>
        )}
        {task.risk && (
          <>
            <span className="micro">Risk</span>
            <div className="result-box" style={{ color: 'var(--amber)' }}>{task.risk}</div>
          </>
        )}

        <span className="micro">Commander Override</span>
        <div className="override-grid" style={{ marginTop: 7 }}>
          <button className="btn human" onClick={() => override('pause')}>Pause</button>
          <button className="btn ghost" onClick={() => override('resume')}>Resume</button>
          <button className="btn ghost" onClick={() => override('reassign')}>Reassign</button>
          <button
            className="btn ghost"
            onClick={() => {
              const t = prompt('Redirect task to:', task.title);
              if (t) override('redirect', { title: t });
            }}
          >
            Redirect
          </button>
          <button
            className="btn human"
            onClick={() => {
              const id = prompt('Merge into task id (optional):', '');
              override('merge', { targetTaskId: id ? BigInt(id) : undefined });
            }}
          >
            Merge Dup
          </button>
          <button className="btn danger" onClick={() => override('cancel')}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
