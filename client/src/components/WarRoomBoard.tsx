import { useEffect, useMemo, useRef } from 'react';
import { classOf } from '../lib/missions';
import { num, ago, clockTime } from '../lib/format';

const STATUS: Record<string, string> = {
  pending: 'queued', claimed: 'active', done: 'complete',
  blocked: 'failed', cancelled: 'void', paused: 'held',
};

// ---- objective tree layout (layered DAG) -------------------------------------
const NW = 150, NH = 46, HG = 64, VG = 14, PAD = 26;
function layout(tasks: any[]) {
  if (!tasks.length) return { nodes: [], edges: [], width: 0, height: 0 };
  const sorted = [...tasks].sort((a, b) => Number(a.id - b.id));
  const childrenOf = new Map<string, any[]>(); const roots: any[] = [];
  for (const t of sorted) {
    if (t.parentId == null) roots.push(t);
    else { const k = String(t.parentId); (childrenOf.get(k) ?? childrenOf.set(k, []).get(k)!).push(t); }
  }
  const row = new Map<bigint, number>(); let slot = 0;
  const dfs = (t: any): number => {
    const kids = childrenOf.get(String(t.id)) ?? [];
    let r: number;
    if (!kids.length) r = slot++;
    else { const rs = kids.map(dfs); r = (Math.min(...rs) + Math.max(...rs)) / 2; }
    row.set(t.id, r); return r;
  };
  roots.forEach(dfs);
  const nodes = sorted.map((t) => ({ t, x: t.depth * (NW + HG) + PAD, y: (row.get(t.id) ?? 0) * (NH + VG) + PAD }));
  const pos = new Map(nodes.map((n) => [String(n.t.id), n]));
  const edges: any[] = [];
  for (const n of nodes) {
    if (n.t.parentId == null) continue;
    const p = pos.get(String(n.t.parentId)); if (!p) continue;
    const x1 = p.x + NW, y1 = p.y + NH / 2, x2 = n.x, y2 = n.y + NH / 2, mx = (x1 + x2) / 2;
    edges.push({ d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`, fresh: n.t.status === 'pending' });
  }
  const width = Math.max(...nodes.map((n) => n.x + NW)) + PAD;
  const height = Math.max(...nodes.map((n) => n.y + NH)) + PAD;
  return { nodes, edges, width, height };
}

function trunc(s: string, n: number) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

export function WarRoomBoard({ goal, score, tasks, agents, events, ops, roomId, conn, selectedId, setSelectedId, runnerCmd, onNewOp, onBoard }: any) {
  const { nodes, edges, width, height } = useMemo(() => layout(tasks), [tasks]);
  const total = tasks.length;
  const done = tasks.filter((t: any) => t.status === 'done').length;
  const remaining = tasks.filter((t: any) => t.status === 'pending' || t.status === 'claimed').length;
  const completion = total ? Math.round((done / total) * 100) : 0;
  const working = agents.filter((a: any) => a.status === 'working').length;

  const valid = num(score?.validResults), late = num(score?.lateResults);
  const onTime = valid + late ? Math.round((valid / (valid + late)) * 100) : 100;
  const spent = num(score?.estimatedCostMicros);
  const budget = num(goal?.runBudgetMicros);
  const supplyPct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
  const selTask = selectedId != null ? tasks.find((t: any) => t.id === selectedId) ?? null : null;
  const complete = goal?.status === 'complete';
  const stopped = goal?.status === 'stopped';

  return (
    <div className="wb">
      {/* status bar */}
      <div className="wb-status">
        <div className="wb-brand"><span className="wb-stamp">OPS</span><span className="wb-title">SWARM ARENA</span></div>
        <div className="wb-mission"><span className="wb-k">Operation</span><span className="wb-v">{trunc(goal?.title ?? '—', 64)}</span></div>
        <Stat k="State" v={(goal?.status ?? '—').toUpperCase()} tone={complete ? 'good' : stopped ? 'bad' : 'live'} />
        <Stat k="Score" v={num(score?.points).toLocaleString()} />
        <Stat k="Progress" v={`${completion}%`} tone={completion === 100 ? 'good' : ''} />
        <Stat k="Objectives" v={remaining} />
        <Stat k="Crew" v={`${working}/${agents.length}`} tone={working ? 'live' : ''} />
        <Stat k="On-time" v={`${onTime}%`} tone={onTime >= 80 ? 'good' : 'warn'} />
        <div className="wb-supply">
          <span className="wb-k">Supplies</span>
          <div className="wb-supbar"><div className={`wb-supfill ${supplyPct > 85 ? 'crit' : ''}`} style={{ width: `${100 - supplyPct}%` }} /></div>
          <span className="wb-supnum">${((budget - spent) / 1_000_000).toFixed(4)} left</span>
        </div>
      </div>

      <div className="wb-grid">
        {/* crew column */}
        <div className="wb-col wb-crew">
          <div className="wb-slip">
            <div className="wb-slip-h">COMMAND DECK · OP #{String(roomId)}</div>
            <div className="wb-slip-b">
              <div className="wb-kv"><span>Commanders</span><b>{ops.map((o: any) => o.displayName).join(', ') || '—'}</b></div>
              <div className="wb-deploy">{runnerCmd}</div>
              <div className="wb-btns">
                <button className={`wb-btn ${complete || stopped ? 'hot' : ''}`} onClick={onBoard}>After-Action</button>
                <button className="wb-btn" onClick={onNewOp}>New Op</button>
              </div>
            </div>
          </div>
          <div className="wb-slip grow">
            <div className="wb-slip-h">CREW · {working}/{agents.length} ON TASK</div>
            <div className="wb-slip-b scroll">
              {agents.length === 0 && <div className="wb-empty">No crew deployed.</div>}
              {[...agents].sort((a: any, b: any) => Number(a.id - b.id)).map((a: any) => {
                const t = a.currentTaskId != null ? tasks.find((x: any) => x.id === a.currentTaskId) : null;
                return (
                  <div key={String(a.id)} className={`wb-unit ${a.status} ${a.role}`}>
                    <span className="wb-unit-glyph">{a.role === 'lead' ? '◆' : '▣'}</span>
                    <div className="wb-unit-mid">
                      <div className="wb-unit-name">{a.name} <i>{classOf(a.model)}</i></div>
                      <div className="wb-unit-th">{a.status === 'working' && t ? `▸ ${t.title}` : a.latestThought || '—'}</div>
                    </div>
                    <span className="wb-unit-st">{a.status}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* objective board */}
        <div className="wb-board">
          <div className="wb-board-h">
            <span>OBJECTIVE MAP</span>
            <div className="wb-legend">
              {[['queued', 'queued'], ['active', 'active'], ['complete', 'complete'], ['failed', 'failed']].map(([k, l]) => (
                <span key={k} className="wb-lg"><i className={`wb-sw ${k}`} />{l}</span>
              ))}
            </div>
          </div>
          <div className="wb-board-scroll">
            {nodes.length === 0 ? <div className="wb-empty big">Awaiting deployment — objectives will plot as the swarm advances.</div> : (
              <svg width={Math.max(width, 400)} height={Math.max(height, 300)}>
                {edges.map((e: any, i: number) => <path key={i} className={`wb-edge ${e.fresh ? 'fresh' : ''}`} d={e.d} />)}
                {nodes.map((n: any) => {
                  const st = STATUS[n.t.status] ?? 'queued';
                  const sel = selectedId != null && n.t.id === selectedId;
                  return (
                    <g key={String(n.t.id)} className={`wb-node ${st} ${sel ? 'sel' : ''}`} transform={`translate(${n.x},${n.y})`} onClick={() => setSelectedId(n.t.id)}>
                      <rect className="wb-node-rect" width={NW} height={NH} />
                      <rect className="wb-node-bar" width={5} height={NH} />
                      <text className="wb-node-t" x={12} y={18}>{trunc(n.t.title, 22)}</text>
                      <text className="wb-node-t dim" x={12} y={30}>{trunc(n.t.title.slice(22), 22)}</text>
                      <text className="wb-node-m" x={12} y={41}>{st.toUpperCase()}{n.t.assignedModel ? ` · ${classOf(n.t.assignedModel)}` : ''}{n.t.requiredRole === 'lead' ? ' · LEAD' : ''}</text>
                    </g>
                  );
                })}
              </svg>
            )}
          </div>
        </div>

        {/* orders / inspector */}
        <div className="wb-col wb-orders">
          <div className="wb-slip grow">
            <div className="wb-slip-h">ORDERS{selTask ? ` · ${(STATUS[selTask.status] ?? '').toUpperCase()}` : ''}</div>
            <div className="wb-slip-b">
              {!selTask ? <div className="wb-empty">Select an objective to issue commander orders.</div> : (
                <Orders task={selTask} agents={agents} roomId={roomId} conn={conn} />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* dispatch feed */}
      <DispatchFeed events={events} />
    </div>
  );
}

function Stat({ k, v, tone = '' }: any) {
  return <div className="wb-stat"><span className="wb-k">{k}</span><span className={`wb-v ${tone}`}>{v}</span></div>;
}

function Orders({ task, agents, roomId, conn }: any) {
  const agent = task.assignedAgentId != null ? agents.find((a: any) => a.id === task.assignedAgentId) : null;
  const ov = (action: string, extra: any = {}) => conn?.reducers.humanOverride({ roomId, taskId: task.id, action, title: extra.title ?? undefined, targetTaskId: extra.targetTaskId ?? undefined });
  return (
    <>
      <div className="wb-kv col"><span>Objective</span><b>{task.title}</b></div>
      <div className="wb-kv"><span>Tier</span><b>depth {task.depth} · {task.requiredRole}</b></div>
      <div className="wb-kv"><span>Assigned</span><b>{agent ? `${agent.name} (${classOf(task.assignedModel)})` : '—'}</b></div>
      {task.result && <div className="wb-result">{task.result}</div>}
      {task.risk && <div className="wb-result risk">⚠ {task.risk}</div>}
      <div className="wb-orderlabel">COMMANDER ORDERS</div>
      <div className="wb-ord-grid">
        <button className="wb-ord" onClick={() => ov('pause')}>Hold</button>
        <button className="wb-ord" onClick={() => ov('resume')}>Resume</button>
        <button className="wb-ord" onClick={() => ov('reassign')}>Reassign</button>
        <button className="wb-ord" onClick={() => { const t = prompt('New objective:', task.title); if (t) ov('redirect', { title: t }); }}>Redirect</button>
        <button className="wb-ord" onClick={() => { const id = prompt('Merge into objective id:', ''); ov('merge', { targetTaskId: id ? BigInt(id) : undefined }); }}>Merge</button>
        <button className="wb-ord danger" onClick={() => ov('cancel')}>Scrub</button>
      </div>
    </>
  );
}

function DispatchFeed({ events }: any) {
  const ref = useRef<HTMLDivElement>(null);
  const sorted = [...events].sort((a: any, b: any) => Number(a.id - b.id)).slice(-100);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [events.length]);
  return (
    <div className="wb-dispatch">
      <div className="wb-dispatch-h">FIELD DISPATCHES · SPACETIMEDB <span>{events.length}</span></div>
      <div className="wb-dispatch-b" ref={ref}>
        {sorted.map((e: any) => (
          <div className="wb-disp" key={String(e.id)}>
            <span className="wb-disp-t">{clockTime(e.createdAt)}</span>
            <span className={`wb-disp-k k-${e.kind}`}>{e.kind}</span>
            <span className="wb-disp-m">{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
