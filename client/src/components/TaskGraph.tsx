import { useMemo } from 'react';
import { TASK_COLORS } from '../lib/format';
import { classOf } from '../lib/missions';

const NODE_W = 158;
const NODE_H = 50;
const H_GAP = 70;
const V_GAP = 16;
const PAD = 28;

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function TaskGraph({ tasks, selectedId, onSelect }: any) {
  const { nodes, edges, width, height } = useMemo(() => layout(tasks), [tasks]);

  return (
    <div className="panel graph">
      <div className="panel-h">
        <span className="micro">Mission Map · Objective Tree</span>
        <div className="graph-legend">
          {[
            ['pending', 'Queued'],
            ['claimed', 'Active'],
            ['done', 'Complete'],
            ['blocked', 'Failed'],
            ['paused', 'Held'],
          ].map(([k, label]) => (
            <span className="lg" key={k}>
              <span className="sw" style={{ background: TASK_COLORS[k] }} />
              <span className="micro" style={{ letterSpacing: '0.1em' }}>{label}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="panel-b">
        <div className="graph-scroll">
          {nodes.length === 0 ? (
            <div className="empty-hint">No tasks yet — submit a mission to seed the root task.</div>
          ) : (
            <svg width={Math.max(width, 400)} height={Math.max(height, 300)}>
              {edges.map((e: any, i: number) => (
                <path key={i} className={`edge ${e.fresh ? 'spawn' : ''}`} d={e.d} />
              ))}
              {nodes.map((n: any) => {
                const color = TASK_COLORS[n.t.status] ?? TASK_COLORS.pending;
                const sel = selectedId != null && n.t.id === selectedId;
                return (
                  <g
                    key={String(n.t.id)}
                    className={`node-card ${n.t.status === 'claimed' ? 'working' : ''} ${sel ? 'sel' : ''}`}
                    transform={`translate(${n.x}, ${n.y})`}
                    onClick={() => onSelect(n.t.id)}
                  >
                    <rect className="node-rect" width={NODE_W} height={NODE_H} stroke={color} />
                    <rect x={0} y={0} width={4} height={NODE_H} fill={color} rx={2} />
                    <text className="node-title" x={11} y={18}>
                      {truncate(n.t.title, 26)}
                    </text>
                    <text className="node-title" x={11} y={31} opacity={0.65}>
                      {truncate(n.t.title.slice(26), 26)}
                    </text>
                    <text className="node-meta" x={11} y={44}>
                      {n.t.status.toUpperCase()}
                      {n.t.assignedModel ? ` · ${classOf(n.t.assignedModel)}` : ''}
                      {n.t.attempts > 1 ? ` · ×${n.t.attempts}` : ''}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}

function layout(tasks: any[]) {
  if (!tasks.length) return { nodes: [], edges: [], width: 0, height: 0 };

  const sorted = [...tasks].sort((a, b) => Number(a.id - b.id));
  const byId = new Map<bigint, any>();
  const childrenOf = new Map<string, any[]>();
  const roots: any[] = [];

  for (const t of sorted) {
    byId.set(t.id, t);
    if (t.parentId == null) roots.push(t);
    else {
      const k = String(t.parentId);
      if (!childrenOf.has(k)) childrenOf.set(k, []);
      childrenOf.get(k)!.push(t);
    }
  }

  // Assign each node a "row" — leaves get the next slot, parents center over kids.
  const row = new Map<bigint, number>();
  let slot = 0;
  const dfs = (t: any): number => {
    const kids = childrenOf.get(String(t.id)) ?? [];
    let r: number;
    if (kids.length === 0) r = slot++;
    else {
      const rs = kids.map(dfs);
      r = (Math.min(...rs) + Math.max(...rs)) / 2;
    }
    row.set(t.id, r);
    return r;
  };
  roots.forEach(dfs);

  const nodes = sorted.map((t) => ({
    t,
    x: t.depth * (NODE_W + H_GAP) + PAD,
    y: (row.get(t.id) ?? 0) * (NODE_H + V_GAP) + PAD,
  }));
  const posOf = new Map(nodes.map((n) => [String(n.t.id), n]));

  const edges: any[] = [];
  for (const n of nodes) {
    if (n.t.parentId == null) continue;
    const p = posOf.get(String(n.t.parentId));
    if (!p) continue;
    const x1 = p.x + NODE_W;
    const y1 = p.y + NODE_H / 2;
    const x2 = n.x;
    const y2 = n.y + NODE_H / 2;
    const mx = (x1 + x2) / 2;
    edges.push({
      d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
      fresh: n.t.status === 'pending',
    });
  }

  const width = Math.max(...nodes.map((n) => n.x + NODE_W)) + PAD;
  const height = Math.max(...nodes.map((n) => n.y + NODE_H)) + PAD;
  return { nodes, edges, width, height };
}
