import { useEffect, useRef, useState } from 'react';
import { MISSIONS, MODELS, ROLES, CREW_POINTS_CAP } from '../lib/missions';

type CrewEntry = { role: string; count: number };

export function MissionSetup({ conn, identity, isActive, rooms, goals, preRoomId, onEnter }: any) {
  const [name, setName] = useState(localStorage.getItem('swarm_op_name') || 'Commander');
  const [missionId, setMissionId] = useState(MISSIONS[0].id);
  // crew keyed by model id → { role, count }
  const [crew, setCrew] = useState<Record<string, CrewEntry>>({
    'openai/gpt-oss-120b:nitro': { role: 'worker', count: 6 },
    'z-ai/glm-4.7:nitro': { role: 'lead', count: 1 },
  });
  const [phase, setPhase] = useState<'idle' | 'creating' | 'submitting'>('idle');
  const snapshot = useRef<Set<string>>(new Set());

  const mission = MISSIONS.find((m) => m.id === missionId)!;
  const me = identity?.toHexString();

  const entries = Object.entries(crew).filter(([, c]) => c.count > 0);
  const totalUnits = entries.reduce((s, [, c]) => s + c.count, 0);
  const pointsUsed = entries.reduce((s, [id, c]) => s + (MODELS.find((m) => m.id === id)?.pts ?? 0) * c.count, 0);
  const leads = entries.filter(([, c]) => c.role === 'lead').reduce((s, [, c]) => s + c.count, 0);
  const workers = entries.filter(([, c]) => c.role === 'worker').reduce((s, [, c]) => s + c.count, 0);
  const reviewers = entries.filter(([, c]) => c.role === 'reviewer').reduce((s, [, c]) => s + c.count, 0);
  const overCap = pointsUsed > CREW_POINTS_CAP;
  const crewSpec = entries.map(([model, c]) => ({ model, role: c.role, count: c.count }));

  useEffect(() => { localStorage.setItem('swarm_op_name', name); }, [name]);

  useEffect(() => {
    if (phase !== 'creating' || !conn) return;
    const mine = rooms.filter((r: any) => me && r.createdBy?.toHexString() === me);
    const fresh = mine.find((r: any) => !snapshot.current.has(String(r.id)));
    if (fresh) {
      submit(fresh.id);
      onEnter(fresh.id, crewSpec.flatMap((s) => Array(s.count).fill(s.model)));
      setPhase('submitting');
    }
  }, [rooms, phase]);

  const submit = (roomId: bigint) => {
    conn.reducers.submitGoal({
      roomId,
      title: mission.brief,
      maxDepth: mission.maxDepth,
      maxTasks: mission.maxTasks,
      deadlineMs: BigInt(mission.deadlineMs),
      runBudgetMicros: BigInt(mission.supplyMicros),
      crew: crewSpec,
    });
  };

  const launch = () => {
    if (!conn || !identity || totalUnits === 0 || overCap) return;
    if (preRoomId != null) {
      submit(preRoomId);
      onEnter(preRoomId, crewSpec.flatMap((s) => Array(s.count).fill(s.model)));
      setPhase('submitting');
      return;
    }
    snapshot.current = new Set(
      rooms.filter((r: any) => me && r.createdBy?.toHexString() === me).map((r: any) => String(r.id))
    );
    conn.reducers.createRoom({ name: mission.id, displayName: name });
    setPhase('creating');
  };

  const setCount = (id: string, d: number) =>
    setCrew((c) => {
      const cur = c[id] ?? { role: 'worker', count: 0 };
      return { ...c, [id]: { ...cur, count: Math.max(0, Math.min(12, cur.count + d)) } };
    });
  const setRole = (id: string, role: string) =>
    setCrew((c) => ({ ...c, [id]: { role, count: c[id]?.count ?? 1 } }));

  const joinable = rooms.filter((r: any) => goals.some((g: any) => g.roomId === r.id && g.status === 'active'));

  return (
    <div className="setup">
      <div className="setup-card wide">
        <div className="setup-brand">
          <span className="setup-kicker">SWARM ARENA</span>
          <h1>Assemble the expedition.</h1>
          <p className="sub">
            We give you the world — you build the crew. Draft AI agents, set the chain of command, and
            command the swarm to finish the mission before supplies and deadlines run out.
          </p>
        </div>

        <Section n="01" label="Choose expedition" />
        <div className="mission-grid">
          {MISSIONS.map((m) => (
            <button key={m.id} className={`mission-opt ${m.id === missionId ? 'sel' : ''}`} onClick={() => setMissionId(m.id)}>
              <div className="mn">{m.name}</div>
              <div className="mb">{m.flavor}</div>
              <div className="mc">
                <span>{m.maxTasks} objectives</span>
                <span>{(m.deadlineMs / 1000).toFixed(1)}s window</span>
                <span>${(m.supplyMicros / 1_000_000).toFixed(3)} supplies</span>
              </div>
            </button>
          ))}
        </div>

        <Section n="02" label="Draft your crew">
          <div className={`points ${overCap ? 'over' : ''}`}>
            <span className="micro">Crew points</span>
            <div className="points-bar">
              <div className="points-fill" style={{ width: `${Math.min(100, (pointsUsed / CREW_POINTS_CAP) * 100)}%` }} />
            </div>
            <span className="mono points-num">{pointsUsed}/{CREW_POINTS_CAP}</span>
          </div>
        </Section>

        <div className="model-grid">
          {MODELS.map((m) => {
            const c = crew[m.id] ?? { role: 'worker', count: 0 };
            const active = c.count > 0;
            return (
              <div key={m.id} className={`mcard ${active ? 'active' : ''} ${!m.beatsDeadline ? 'risky' : ''}`}>
                <div className="mcard-head">
                  <div>
                    <div className="mcard-name">{m.name}</div>
                    <div className="mcard-id mono">{m.id.split('/')[1]}</div>
                  </div>
                  <div className="mcard-pts">{m.pts} <span>pts</span></div>
                </div>
                <div className="mcard-tag">{m.tagline}</div>
                <div className="mcard-stats">
                  <Pips label="SPD" v={m.speed} />
                  <Pips label="QAL" v={m.quality} />
                  <Pips label="$$$" v={m.cost} warn />
                </div>
                {!m.beatsDeadline && <div className="mcard-warn">⚠ often misses the 2s deadline</div>}
                <div className="mcard-foot">
                  <div className="role-pills">
                    {ROLES.map((r) => (
                      <button
                        key={r.id}
                        className={`rpill ${c.role === r.id ? 'on' : ''}`}
                        title={r.tagline}
                        onClick={() => setRole(m.id, r.id)}
                      >
                        {r.name[0]}
                      </button>
                    ))}
                  </div>
                  <div className="count">
                    <button onClick={() => setCount(m.id, -1)}>−</button>
                    <span className="mono">{c.count}</span>
                    <button onClick={() => setCount(m.id, 1)} disabled={pointsUsed + m.pts > CREW_POINTS_CAP}>+</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="hierarchy">
          <span className="micro">Chain of command</span>
          <div className="hier-row">
            <Chip role="lead" n={leads} label="Lead" />
            <span className="hier-arrow">→</span>
            <Chip role="worker" n={workers} label="Worker" />
            {reviewers > 0 && (<><span className="hier-arrow">→</span><Chip role="reviewer" n={reviewers} label="Reviewer" /></>)}
          </div>
          {leads === 0 && totalUnits > 0 && (
            <div className="hier-hint">No Lead assigned — a Worker will improvise the strategy. Add a Lead for cleaner decomposition.</div>
          )}
        </div>

        <div className="setup-foot">
          <input className="input commander" value={name} onChange={(e) => setName(e.target.value)} placeholder="Commander callsign" />
          <button className="btn launch" disabled={!isActive || phase !== 'idle' || totalUnits === 0 || overCap} onClick={launch}>
            {phase !== 'idle' ? 'Launching…' : overCap ? 'Over crew-point cap' : totalUnits === 0 ? 'Draft at least one unit' : `Launch · ${totalUnits} agents`}
          </button>
        </div>

        {joinable.length > 0 && (
          <div className="joinable">
            <span className="micro">Join active expedition</span>
            <div className="rooms">
              {joinable.map((r: any) => (
                <button key={String(r.id)} className="room-chip" onClick={() => { conn?.reducers.joinRoom({ roomId: r.id, displayName: name, team: 'blue' }); onEnter(r.id, crewSpec.flatMap((s) => Array(s.count).fill(s.model))); }}>
                  {r.name} #{String(r.id)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="status-line">
          <span className={`dot-conn ${isActive ? 'on' : 'off'}`} />
          {isActive ? 'Uplink established · maincloud · swarm-arena' : 'Establishing uplink…'}
        </div>
      </div>
    </div>
  );
}

function Section({ n, label, children }: any) {
  return (
    <div className="section-h">
      <span className="section-n mono">{n}</span>
      <span className="section-l">{label}</span>
      <div className="section-line" />
      {children}
    </div>
  );
}

function Pips({ label, v, warn }: { label: string; v: number; warn?: boolean }) {
  return (
    <div className="pipstat">
      <span className="micro">{label}</span>
      <span className="pips">{[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= v ? (warn ? 'on warn' : 'on') : ''} />)}</span>
    </div>
  );
}

function Chip({ role, n, label }: { role: string; n: number; label: string }) {
  return (
    <div className={`hchip ${role} ${n === 0 ? 'empty' : ''}`}>
      <span className="hchip-n mono">{n}</span>
      <span className="hchip-l">{label}{n === 1 ? '' : 's'}</span>
    </div>
  );
}
