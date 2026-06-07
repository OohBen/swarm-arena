import { useEffect, useRef, useState } from 'react';
import { MISSIONS, UNIT_CLASSES } from '../lib/missions';

export function MissionSetup({ conn, identity, isActive, rooms, goals, preRoomId, onEnter }: any) {
  const [name, setName] = useState(localStorage.getItem('swarm_op_name') || 'Commander');
  const [missionId, setMissionId] = useState(MISSIONS[0].id);
  const [crew, setCrew] = useState<Record<string, number>>({
    'openai/gpt-oss-120b:nitro': 2,
    'z-ai/glm-4.7:nitro': 1,
  });
  const [phase, setPhase] = useState<'idle' | 'creating' | 'submitting'>('idle');
  const snapshot = useRef<Set<string>>(new Set());

  const mission = MISSIONS.find((m) => m.id === missionId)!;
  const me = identity?.toHexString();
  const crewList = Object.entries(crew).flatMap(([id, n]) => Array(Math.max(0, n)).fill(id));
  const totalUnits = crewList.length;

  useEffect(() => {
    localStorage.setItem('swarm_op_name', name);
  }, [name]);

  useEffect(() => {
    if (phase !== 'creating' || !conn) return;
    const mine = rooms.filter((r: any) => me && r.createdBy?.toHexString() === me);
    const fresh = mine.find((r: any) => !snapshot.current.has(String(r.id)));
    if (fresh) {
      submitGoal(fresh.id);
      onEnter(fresh.id, crewList);
      setPhase('submitting');
    }
  }, [rooms, phase]);

  const submitGoal = (roomId: bigint) => {
    conn.reducers.submitGoal({
      roomId,
      title: mission.brief,
      maxDepth: mission.maxDepth,
      maxTasks: mission.maxTasks,
      deadlineMs: BigInt(mission.deadlineMs),
      defaultModel: crewList[0] ?? UNIT_CLASSES[0].id,
    });
  };

  const launch = () => {
    if (!conn || !identity || totalUnits === 0) return;
    if (preRoomId != null) {
      submitGoal(preRoomId);
      onEnter(preRoomId, crewList);
      setPhase('submitting');
      return;
    }
    snapshot.current = new Set(
      rooms.filter((r: any) => me && r.createdBy?.toHexString() === me).map((r: any) => String(r.id))
    );
    conn.reducers.createRoom({ name: mission.id, displayName: name });
    setPhase('creating');
  };

  const bump = (id: string, d: number) =>
    setCrew((c) => ({ ...c, [id]: Math.max(0, Math.min(8, (c[id] ?? 0) + d)) }));

  const joinable = rooms.filter((r: any) =>
    goals.some((g: any) => g.roomId === r.id && g.status === 'active')
  );

  return (
    <div className="setup">
      <div className="setup-card wide">
        <h1>SWARM ARENA</h1>
        <div className="sub">
          We give you the world. <b>You build the crew.</b> Command a swarm of AI agents to complete the
          expedition before supplies and deadlines run out — they share one live world-state, and
          SpacetimeDB keeps the swarm in sync.
        </div>

        <span className="micro">① Choose Expedition</span>
        <div className="mission-grid" style={{ marginTop: 8 }}>
          {MISSIONS.map((m) => (
            <button
              key={m.id}
              className={`mission-opt ${m.id === missionId ? 'sel' : ''}`}
              onClick={() => setMissionId(m.id)}
            >
              <div className="mn">{m.name}</div>
              <div className="mb">{m.flavor}</div>
              <div className="mc">
                <span>{m.maxDepth} tiers</span>
                <span>{m.maxTasks} objectives</span>
                <span>{(m.deadlineMs / 1000).toFixed(1)}s window</span>
              </div>
            </button>
          ))}
        </div>

        <span className="micro">② Assemble Your Crew · {totalUnits} unit{totalUnits === 1 ? '' : 's'}</span>
        <div className="crew-grid" style={{ marginTop: 8 }}>
          {UNIT_CLASSES.map((u) => (
            <div key={u.id} className={`unit ${(crew[u.id] ?? 0) > 0 ? 'active' : ''}`}>
              <div className="unit-top">
                <div>
                  <div className="unit-klass">{u.klass}</div>
                  <div className="unit-role">{u.role}</div>
                </div>
                <div className="unit-count">
                  <button onClick={() => bump(u.id, -1)}>−</button>
                  <span>{crew[u.id] ?? 0}</span>
                  <button onClick={() => bump(u.id, 1)}>+</button>
                </div>
              </div>
              <div className="unit-blurb">{u.blurb}</div>
              <div className="unit-stats">
                <Stat label="SPD" v={u.speed} />
                <Stat label="QAL" v={u.quality} />
                <Stat label="$$$" v={u.cost} />
              </div>
            </div>
          ))}
        </div>

        <div className="setup-row" style={{ gridTemplateColumns: '1fr', marginTop: 16 }}>
          <div className="field">
            <span className="micro">③ Commander Callsign</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>

        <button
          className="btn launch"
          disabled={!isActive || phase !== 'idle' || totalUnits === 0}
          onClick={launch}
        >
          {phase === 'idle'
            ? totalUnits === 0
              ? 'Add at least one crew unit'
              : `▶ Launch Expedition · ${totalUnits} agents`
            : 'Launching…'}
        </button>

        {joinable.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <span className="micro">Join Active Expedition</span>
            <div className="rooms">
              {joinable.map((r: any) => (
                <button
                  key={String(r.id)}
                  className="room-chip"
                  onClick={() => {
                    conn?.reducers.joinRoom({ roomId: r.id, displayName: name });
                    onEnter(r.id, crewList);
                  }}
                >
                  {r.name} #{String(r.id)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="status-line">
          <span className={`dot-conn ${isActive ? 'on' : 'off'}`} />
          {isActive ? 'UPLINK ESTABLISHED · maincloud · swarm-arena' : 'Establishing uplink to SpacetimeDB…'}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, v }: { label: string; v: number }) {
  return (
    <div className="unit-stat">
      <span className="micro" style={{ letterSpacing: '0.08em' }}>{label}</span>
      <span className="pips">
        {[1, 2, 3, 4, 5].map((i) => (
          <i key={i} className={i <= v ? 'on' : ''} />
        ))}
      </span>
    </div>
  );
}
