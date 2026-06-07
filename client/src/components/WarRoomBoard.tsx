import { useEffect, useMemo, useRef, useState } from 'react';
import { classOf } from '../lib/missions';
import { num, ago, clockTime } from '../lib/format';

const STATUS: Record<string, string> = {
  pending: 'queued', claimed: 'active', done: 'complete',
  blocked: 'failed', cancelled: 'void', paused: 'held',
};

const OWNER_LABEL: Record<string, string> = { blue: 'BLUE', red: 'RED', neutral: 'NEUTRAL' };
const ORDER_GUIDE: Record<string, { title: string; instant: string; queued: string }> = {
  assault: {
    title: 'Assault',
    instant: '+18 pressure; trims enemy pressure and fortification',
    queued: 'queues a priority Field assault; on-time result adds capture or HQ damage',
  },
  reinforce: {
    title: 'Reinforce',
    instant: '-20 enemy pressure; adds +8 fortification',
    queued: 'queues a Field hold; good Engineers make this stick',
  },
  defend: {
    title: 'Hold',
    instant: '-20 enemy pressure; buys time on hostile ground',
    queued: 'queues a Field defense so your side can stabilize the lane',
  },
  sabotage: {
    title: 'Sabotage',
    instant: '-14 fortification; adds light pressure',
    queued: 'queues a Field sabotage; opens fortified posts for assault',
  },
  scout: {
    title: 'Scout',
    instant: '+6 pressure and marks the node contested',
    queued: 'queues a Command recon task; Scouts and Surveyors shine here',
  },
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
function clamp(n: number, min = 0, max = 100) { return Math.max(min, Math.min(max, n)); }
function splitAdj(s: string) { return (s || '').split(',').map((x) => x.trim()).filter(Boolean); }
function captureLimit(n: any) { return n?.owner === 'neutral' ? 160 : 220 + Math.floor((n?.fortification ?? 0) / 2); }
function pressureGap(n: any) { return num(n?.bluePressure) - num(n?.redPressure); }
function pressureGapFor(n: any, team = 'blue') {
  return team === 'red' ? num(n?.redPressure) - num(n?.bluePressure) : pressureGap(n);
}
function supplyLeft(teamState: any, fallbackBudget: number) {
  if (!teamState) return fallbackBudget;
  return num(teamState.supplyMicros);
}
function nodeCall(n: any, team = 'blue') {
  if (!n) return 'Select a front-line node';
  const enemy = team === 'red' ? 'blue' : 'red';
  const ownPressure = team === 'red' ? num(n.redPressure) : num(n.bluePressure);
  const enemyPressure = team === 'red' ? num(n.bluePressure) : num(n.redPressure);
  if (n.kind === 'hq') return n.owner === enemy ? `Crack ${OWNER_LABEL[enemy]} HQ` : `Protect ${OWNER_LABEL[team]} HQ`;
  if (n.owner === team) return enemyPressure > 0 ? `Hold ${n.name}` : `Fortify ${n.name}`;
  if (ownPressure - enemyPressure >= 40) return `Finish ${n.name}`;
  if (ownPressure - enemyPressure < -20) return `Stop ${OWNER_LABEL[enemy]} at ${n.name}`;
  return `Contest ${n.name}`;
}

const CRISIS_CARDS: Record<string, { title: string; choices: { label: string; detail: string }[] }> = {
  dust_storm: { title: 'DUST STORM', choices: [{ label: 'Shelter crew', detail: 'spend supplies, stay safe' }, { label: 'Push through', detail: 'risk losing an objective' }] },
  supply_leak: { title: 'SUPPLY LEAK', choices: [{ label: 'Seal breach', detail: 'costs supplies now' }, { label: 'Ration', detail: 'morale / score hit' }] },
  equipment_failure: { title: 'EQUIPMENT FAILURE', choices: [{ label: 'Repair', detail: 'costs supplies, keep it' }, { label: 'Reroute', detail: 'lose the objective' }] },
};

function useTick() {
  const [, set] = useState(0);
  useEffect(() => {
    const h = setInterval(() => set((x) => x + 1), 1000);
    return () => clearInterval(h);
  }, []);
}

function CrisisAlert({ crises, conn }: any) {
  useTick();
  if (!crises || crises.length === 0) return null;
  const c = crises[0];
  const card = CRISIS_CARDS[c.kind] ?? { title: c.kind, choices: [{ label: 'Respond', detail: '' }, { label: 'Ignore', detail: '' }] };
  const remain = Math.max(0, Math.round((Number(c.deadlineMicros) / 1000 - Date.now()) / 1000));
  return (
    <div className="wb-crisis-wrap">
      <div className="wb-crisis">
        <div className="wb-crisis-h">⚠ CRISIS · {card.title} <span className="wb-crisis-t">{remain}s to respond</span></div>
        <div className="wb-crisis-msg">{c.message}</div>
        <div className="wb-crisis-choices">
          {card.choices.map((ch, i) => (
            <button key={i} className="wb-crisis-btn" onClick={() => conn?.reducers.resolveCrisis({ crisisId: c.id, choice: i })}>
              <b>{ch.label}</b><span>{ch.detail}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function WarRoomBoard({ goal, score, tasks, agents, teamStates = [], battleNodes = [], battleOrders = [], events, ops, crises, roomId, conn, myTeam, shareUrl, selectedId, setSelectedId, runnerCmd, onNewOp, onBoard }: any) {
  const hasBattle = battleNodes.length > 0;
  const { nodes, edges, width, height } = useMemo(() => layout(tasks), [tasks]);
  const total = tasks.length;
  const done = tasks.filter((t: any) => t.status === 'done').length;
  const remaining = tasks.filter((t: any) => t.status === 'pending' || t.status === 'claimed').length;
  const completion = total ? Math.round((done / total) * 100) : 0;
  const working = agents.filter((a: any) => a.status === 'working').length;
  const blueTeam = teamStates.find((s: any) => s.team === 'blue') ?? null;
  const redTeam = teamStates.find((s: any) => s.team === 'red') ?? null;
  const myTeamState = myTeam ? teamStates.find((s: any) => s.team === myTeam) ?? null : null;
  const blueOp = ops.find((o: any) => o.team === 'blue') ?? null;
  const redOp = ops.find((o: any) => o.team === 'red') ?? null;
  const blueTerritory = battleNodes.filter((n: any) => n.owner === 'blue').length;
  const redTerritory = battleNodes.filter((n: any) => n.owner === 'red').length;
  const contested = battleNodes.filter((n: any) => n.status === 'contested' || n.status === 'damaged').length;

  const valid = num(score?.validResults), late = num(score?.lateResults);
  const onTime = valid + late ? Math.round((valid / (valid + late)) * 100) : 100;
  const totalSpent = num(score?.estimatedCostMicros);
  const budget = num(goal?.runBudgetMicros);
  const supplyPct = budget > 0 ? Math.min(100, (totalSpent / budget) * 100) : 0;
  const blueSupply = supplyLeft(blueTeam, budget);
  const redSupply = supplyLeft(redTeam, budget);
  const selTask = selectedId != null ? tasks.find((t: any) => t.id === selectedId) ?? null : null;
  const selNode = selectedId != null ? battleNodes.find((n: any) => n.id === selectedId) ?? null : null;
  const complete = goal?.status === 'complete';
  const stopped = goal?.status === 'stopped';
  const winner = teamStates.find((s: any) => s.status === 'winner') ?? null;
  const viewTeam = myTeam === 'red' ? 'red' : 'blue';
  const enemyPressureKey = viewTeam === 'red' ? 'bluePressure' : 'redPressure';
  const bestPush = [...battleNodes]
    .filter((n: any) => n.owner !== viewTeam && n.kind !== 'hq')
    .sort((a: any, b: any) => pressureGapFor(b, viewTeam) - pressureGapFor(a, viewTeam))[0] ?? null;
  const mustHold = [...battleNodes]
    .filter((n: any) => n.owner === viewTeam && n.kind !== 'hq' && num(n[enemyPressureKey]) > 0)
    .sort((a: any, b: any) => num(b[enemyPressureKey]) - num(a[enemyPressureKey]))[0] ?? null;

  useEffect(() => {
    if (!hasBattle || battleNodes.length === 0) return;
    const selectedIsNode = selectedId != null && battleNodes.some((n: any) => n.id === selectedId);
    if (selectedIsNode) return;
    const preferred =
      battleNodes.find((n: any) => n.nodeKey === 'mid_center') ??
      battleNodes.find((n: any) => n.owner === 'neutral') ??
      battleNodes[0];
    if (preferred) setSelectedId(preferred.id);
  }, [hasBattle, battleNodes, selectedId, setSelectedId]);

  return (
    <div className="wb">
      <CrisisAlert crises={crises} conn={conn} />
      {/* status bar */}
      <div className="wb-status">
        <div className="wb-brand"><span className="wb-stamp">OPS</span><span className="wb-title">SWARM ARENA</span></div>
        <div className="wb-mission"><span className="wb-k">Operation</span><span className="wb-v">{trunc(goal?.title ?? '—', 64)}</span></div>
        <Stat k="State" v={(goal?.status ?? '—').toUpperCase()} tone={complete ? 'good' : stopped ? 'bad' : 'live'} />
        <Stat k="Score" v={num(score?.points).toLocaleString()} />
        {hasBattle ? (
          <>
            <Stat k="Blue HQ" v={`${blueTeam?.hqIntegrity ?? 100}%`} tone={(blueTeam?.hqIntegrity ?? 100) > 35 ? 'good' : 'bad'} />
            <Stat k="Red HQ" v={`${redTeam?.hqIntegrity ?? 100}%`} tone={(redTeam?.hqIntegrity ?? 100) > 35 ? 'bad' : 'good'} />
            <Stat k="Territory" v={`${blueTerritory}-${redTerritory}`} tone={blueTerritory >= redTerritory ? 'good' : 'warn'} />
            <Stat k="Contested" v={contested} tone={contested ? 'live' : ''} />
            <Stat k="My Side" v={myTeam ? myTeam.toUpperCase() : 'WATCH'} tone={myTeam === 'blue' ? 'good' : myTeam === 'red' ? 'bad' : ''} />
            <Stat k="Orders" v={myTeamState?.commandTokens ?? 0} tone={(myTeamState?.commandTokens ?? 0) > 0 ? 'good' : 'warn'} />
          </>
        ) : (
          <>
            <Stat k="Progress" v={`${completion}%`} tone={completion === 100 ? 'good' : ''} />
            <Stat k="Objectives" v={remaining} />
          </>
        )}
        <Stat k="Crew" v={`${working}/${agents.length}`} tone={working ? 'live' : ''} />
        {!hasBattle && <Stat k="On-time" v={`${onTime}%`} tone={onTime >= 80 ? 'good' : 'warn'} />}
        {hasBattle ? (
          <>
            <TeamSupply team="blue" left={blueSupply} budget={budget} />
            <TeamSupply team="red" left={redSupply} budget={budget} />
          </>
        ) : (
          <div className="wb-supply">
            <span className="wb-k">Supplies</span>
            <div className="wb-supbar"><div className={`wb-supfill ${supplyPct > 85 ? 'crit' : ''}`} style={{ width: `${100 - supplyPct}%` }} /></div>
            <span className="wb-supnum">${((budget - totalSpent) / 1_000_000).toFixed(4)} left</span>
          </div>
        )}
      </div>
      {hasBattle && (
        <div className="wb-situation">
          <span className="wb-sit-chip">WIN · HQ, territory, or supply</span>
          <span className="wb-sit-chip">NOW · {winner ? `${String(winner.team).toUpperCase()} victory` : nodeCall(mustHold ?? bestPush ?? selNode, viewTeam)}</span>
          <span className="wb-sit-chip">ORDER · {selNode ? nodeCall(selNode, viewTeam) : 'Central Relay'}</span>
        </div>
      )}

      <div className="wb-grid">
        {/* crew column */}
        <div className="wb-col wb-crew">
          <div className="wb-slip">
            <div className="wb-slip-h">COMMAND DECK · OP #{String(roomId)}</div>
            <div className="wb-slip-b">
              <div className="wb-kv"><span>Commanders</span><b>{ops.map((o: any) => o.displayName).join(', ') || '—'}</b></div>
              <div className="wb-kv"><span>Blue</span><b>{blueOp?.displayName ?? '—'}</b></div>
              <div className="wb-kv"><span>Red</span><b>{redOp?.displayName ?? '—'}</b></div>
              {shareUrl && <div className="wb-deploy share">{shareUrl}</div>}
              <div className="wb-deploy" title={runnerCmd}>{agents.length > 0 ? 'AUTONOMOUS FLEETS ONLINE' : 'AWAITING FLEET DAEMON'}</div>
              <div className="wb-loop">
                <b>CONTROL LOOP</b>
                <span>Command units run recon and expand orders; field units claim combat tasks atomically; model results mutate the map.</span>
              </div>
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
                  <div key={String(a.id)} className={`wb-unit ${a.status} ${a.role} ${a.team ?? 'blue'}`}>
                    <span className="wb-unit-glyph">{a.team === 'red' ? '▰' : a.role === 'lead' ? '◆' : '▣'}</span>
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
            <span>{hasBattle ? 'BATTLE MAP · FRONT LINE' : 'OBJECTIVE MAP'}</span>
            <div className="wb-legend">
              {hasBattle ? (
                [['blue', 'blue'], ['red', 'red'], ['neutral', 'neutral'], ['contested', 'contested']].map(([k, l]) => (
                  <span key={k} className="wb-lg"><i className={`wb-sw ${k}`} />{l}</span>
                ))
              ) : (
                [['queued', 'queued'], ['active', 'active'], ['complete', 'complete'], ['failed', 'failed']].map(([k, l]) => (
                  <span key={k} className="wb-lg"><i className={`wb-sw ${k}`} />{l}</span>
                ))
              )}
            </div>
          </div>
          <div className="wb-board-scroll">
            {hasBattle ? (
              <BattleMap
                nodes={battleNodes}
                tasks={tasks}
                orders={battleOrders}
                selectedId={selectedId}
                setSelectedId={setSelectedId}
              />
            ) : nodes.length === 0 ? <div className="wb-empty big">Awaiting deployment — objectives will plot as the swarm advances.</div> : (
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
            <div className="wb-slip-h">
              {hasBattle ? `COMMAND ORDERS${selNode ? ` · ${trunc(selNode.name, 18).toUpperCase()}` : ''}` : `ORDERS${selTask ? ` · ${(STATUS[selTask.status] ?? '').toUpperCase()}` : ''}`}
            </div>
            <div className="wb-slip-b">
              {hasBattle ? (
                !selNode ? <div className="wb-empty">Select a battlefield node to issue commander orders.</div> : (
                  <BattleOrders node={selNode} team={myTeam} teamStates={teamStates} battleOrders={battleOrders} tasks={tasks} agents={agents} roomId={roomId} conn={conn} />
                )
              ) : !selTask ? <div className="wb-empty">Select an objective to issue commander orders.</div> : (
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

function TeamSupply({ team, left, budget }: { team: 'blue' | 'red'; left: number; budget: number }) {
  const remaining = budget > 0 ? Math.max(0, Math.min(100, (left / budget) * 100)) : 100;
  return (
    <div className={`wb-supply team ${team}`}>
      <span className="wb-k">{team} supply</span>
      <div className="wb-supbar"><div className={`wb-supfill ${team} ${remaining < 18 ? 'crit' : ''}`} style={{ width: `${remaining}%` }} /></div>
      <span className="wb-supnum">${(left / 1_000_000).toFixed(4)} left</span>
    </div>
  );
}

function BattleMap({ nodes, tasks, orders, selectedId, setSelectedId }: any) {
  const W = 980;
  const H = 520;
  const byKey = new Map<string, any>(nodes.map((n: any) => [n.nodeKey, n]));
  const edges: any[] = [];
  for (const n of nodes) {
    for (const key of splitAdj(n.adjacentKeys)) {
      const target = byKey.get(key);
      if (!target || String(n.id) > String(target.id)) continue;
      edges.push({ a: n, b: target });
    }
  }
  const activeOrders = orders.filter((o: any) => o.status === 'active');
  const taskByNode = new Map<string, any[]>();
  for (const t of tasks) {
    if (t.targetNodeId == null) continue;
    const k = String(t.targetNodeId);
    const arr = taskByNode.get(k) ?? [];
    arr.push(t);
    taskByNode.set(k, arr);
  }

  return (
    <svg className="wb-battle-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Swarm Arena battle map">
      <defs>
        <pattern id="mapHatch" width="12" height="12" patternUnits="userSpaceOnUse">
          <path d="M0 12 L12 0" className="wb-hatch" />
        </pattern>
      </defs>
      <rect className="wb-map-paper" x="0" y="0" width={W} height={H} />
      <line className="wb-front-axis" x1={W / 2} y1="24" x2={W / 2} y2={H - 24} />
      {edges.map((e, i) => (
        <line
          key={i}
          className={`wb-bedge ${e.a.owner}-${e.b.owner}`}
          x1={(e.a.x / 100) * W}
          y1={(e.a.y / 100) * H}
          x2={(e.b.x / 100) * W}
          y2={(e.b.y / 100) * H}
        />
      ))}
      {activeOrders.map((o: any) => {
        const n = nodes.find((x: any) => x.id === o.targetNodeId);
        if (!n) return null;
        return (
          <g key={String(o.id)} className={`wb-order-mark ${o.team}`} transform={`translate(${(n.x / 100) * W},${(n.y / 100) * H})`}>
            <circle r="36" />
            <text y="-42">{o.orderType.toUpperCase()}</text>
          </g>
        );
      })}
      {nodes.map((n: any) => {
        const x = (n.x / 100) * W;
        const y = (n.y / 100) * H;
        const selected = selectedId != null && n.id === selectedId;
        const nodeTasks = taskByNode.get(String(n.id)) ?? [];
        const active = nodeTasks.some((t: any) => t.status === 'claimed');
        const queued = nodeTasks.filter((t: any) => t.status === 'pending').length;
        const limit = captureLimit(n);
        const blueW = clamp((n.bluePressure / limit) * 44, 0, 44);
        const redW = clamp((n.redPressure / limit) * 44, 0, 44);
        return (
          <g
            key={String(n.id)}
            className={`wb-bnode ${n.owner} ${n.status} ${n.kind} ${selected ? 'sel' : ''} ${active ? 'active' : ''}`}
            transform={`translate(${x},${y})`}
            onClick={() => setSelectedId(n.id)}
          >
            <rect className="wb-bnode-box" x="-58" y="-28" width="116" height="56" />
            <rect className="wb-bnode-band" x="-58" y="-28" width="7" height="56" />
            {n.status === 'contested' && <rect className="wb-bnode-hatch" x="-58" y="-28" width="116" height="56" />}
            <text className="wb-bnode-name" x="-45" y="-9">{trunc(n.name, 18)}</text>
            <text className="wb-bnode-meta" x="-45" y="4">{OWNER_LABEL[n.owner] ?? n.owner} · {n.kind.toUpperCase()}</text>
            {n.kind === 'hq' ? (
              <>
                <rect className="wb-hqbar-bg" x="-45" y="13" width="88" height="6" />
                <rect className="wb-hqbar" x="-45" y="13" width={clamp(n.hqIntegrity, 0, 100) * 0.88} height="6" />
                <text className="wb-bnode-small" x="-45" y="25">HQ {n.hqIntegrity}%</text>
              </>
            ) : (
              <>
                <rect className="wb-pressure blue" x="-45" y="12" width={blueW} height="5" />
                <rect className="wb-pressure red" x={45 - redW} y="18" width={redW} height="5" />
                <text className="wb-bnode-small" x="-45" y="25">B{n.bluePressure} R{n.redPressure} · Q{queued}</text>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function BattleOrders({ node, team, teamStates, battleOrders, tasks, agents, roomId, conn }: any) {
  const teamState = team ? teamStates.find((s: any) => s.team === team) : null;
  const tokens = teamState?.commandTokens ?? 0;
  const limit = captureLimit(node);
  const bluePct = clamp((num(node.bluePressure) / limit) * 100, 0, 100);
  const redPct = clamp((num(node.redPressure) / limit) * 100, 0, 100);
  const nodeTasks = tasks.filter((t: any) => t.targetNodeId === node.id && (!team || t.team === team));
  const active = nodeTasks.filter((t: any) => t.status === 'pending' || t.status === 'claimed');
  const assigned = active
    .map((t: any) => (t.assignedAgentId != null ? agents.find((a: any) => a.id === t.assignedAgentId)?.name : null))
    .filter(Boolean)
    .join(', ');
  const orders = battleOrders.filter((o: any) => o.targetNodeId === node.id && o.status === 'active' && (!team || o.team === team));
  const canOrder = Boolean(team) && tokens > 0;
  const holdType = node.owner === team ? 'reinforce' : 'defend';
  const guides = ['assault', holdType, 'sabotage', 'scout'].map((k) => ORDER_GUIDE[k]);
  const readTeam = team === 'red' ? 'red' : 'blue';
  const teamLabel = OWNER_LABEL[readTeam];
  const enemy = readTeam === 'red' ? 'blue' : 'red';
  const ownPressure = readTeam === 'red' ? num(node.redPressure) : num(node.bluePressure);
  const enemyPressure = readTeam === 'red' ? num(node.bluePressure) : num(node.redPressure);
  const fightRead = node.kind === 'hq'
    ? `Damage ${OWNER_LABEL[node.owner] ?? node.owner} HQ to 0 integrity. Assaults hit harder after adjacent posts are held.`
    : `${teamLabel} needs ${Math.max(0, limit - ownPressure)} more pressure; ${OWNER_LABEL[enemy]} pressure (${enemyPressure}) slows the lane.`;
  const issue = (orderType: string) => {
    if (!team) return;
    conn?.reducers.issueOrder({ roomId, targetNodeId: node.id, orderType, team });
  };

  return (
    <>
      <div className={`wb-nodecard ${node.owner}`}>
        <div className="wb-nodecard-k">{node.lane.toUpperCase()} · {node.kind.toUpperCase()}</div>
        <div className="wb-nodecard-name">{node.name}</div>
        <div className="wb-nodecard-owner">{OWNER_LABEL[node.owner] ?? node.owner} · {node.status}</div>
      </div>
      <div className="wb-doctrine">
        <div><b>Intent</b><span>{nodeCall(node, readTeam)}</span></div>
        <div><b>Fight</b><span>{fightRead}</span></div>
        <div><b>Agents</b><span>Orders create priority tasks; one agent claims each task atomically; only on-time structured results change this node.</span></div>
      </div>
      <div className="wb-kv"><span>Blue pressure</span><b>{node.bluePressure}</b></div>
      <div className="wb-kv"><span>Red pressure</span><b>{node.redPressure}</b></div>
      <div className="wb-kv"><span>Fortification</span><b>{node.fortification}</b></div>
      {node.kind !== 'hq' && (
        <div className="wb-pressure-card">
          <div className="wb-pressure-track">
            <i className="blue" style={{ width: `${bluePct}%` }} />
            <i className="red" style={{ width: `${redPct}%` }} />
          </div>
          <div className="wb-pressure-caption">capture threshold {limit}</div>
        </div>
      )}
      {node.kind === 'hq' && <div className="wb-kv"><span>HQ integrity</span><b>{node.hqIntegrity}%</b></div>}
      <div className="wb-kv"><span>Active tasks</span><b>{active.length}</b></div>
      <div className="wb-kv"><span>Assigned</span><b>{assigned || '—'}</b></div>
      {orders.length > 0 && (
        <div className="wb-active-orders">
          {orders.map((o: any) => <span key={String(o.id)}>{o.orderType}</span>)}
        </div>
      )}
      <div className="wb-orderlabel">{team ? `${team.toUpperCase()} COMMAND TOKENS` : 'SPECTATOR MODE'} · {tokens}</div>
      <div className="wb-order-guide">
        {guides.map((g) => (
          <div key={g.title} className="wb-order-guide-row">
            <b>{g.title}</b>
            <span>{g.instant}</span>
            <i>{g.queued}</i>
          </div>
        ))}
      </div>
      <div className="wb-ord-grid">
        <button className="wb-ord primary" disabled={!canOrder} onClick={() => issue('assault')}>Assault</button>
        <button className="wb-ord" disabled={!canOrder} onClick={() => issue(holdType)}>{node.owner === team ? 'Reinforce' : 'Hold'}</button>
        <button className="wb-ord" disabled={!canOrder} onClick={() => issue('sabotage')}>Sabotage</button>
        <button className="wb-ord" disabled={!canOrder} onClick={() => issue('scout')}>Scout</button>
      </div>
      <div className="wb-orderhint">
        {team ? `Orders immediately shift the node, then ${team.toUpperCase()} agents carry it through the reducer queue.` : 'Join Blue or Red from the lobby to issue orders.'}
      </div>
    </>
  );
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
