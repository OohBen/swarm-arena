import { useEffect, useRef, useState } from 'react';
import { MISSIONS, MODELS, CREW_POINTS_CAP, modelById, ModelCard } from '../lib/missions';

type Unit = { uid: string; model: string; tier: 'command' | 'field' };

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

export function WarRoomSetup({ conn, identity, isActive, rooms, goals, preRoomId, onEnter }: any) {
  const [name, setName] = useState(localStorage.getItem('swarm_op_name') || 'CMDR');
  const [missionId, setMissionId] = useState(MISSIONS[0].id);
  const [units, setUnits] = useState<Unit[]>([
    { uid: uid(), model: 'z-ai/glm-4.7:nitro', tier: 'command' },
    { uid: uid(), model: 'openai/gpt-oss-120b:nitro', tier: 'field' },
    { uid: uid(), model: 'openai/gpt-oss-120b:nitro', tier: 'field' },
    { uid: uid(), model: 'openai/gpt-oss-120b:nitro', tier: 'field' },
  ]);
  const [custom, setCustom] = useState('');
  const [phase, setPhase] = useState<'idle' | 'creating' | 'submitting'>('idle');
  const snapshot = useRef<Set<string>>(new Set());
  const mission = MISSIONS.find((m) => m.id === missionId)!;
  const me = identity?.toHexString();

  const ptsOf = (id: string) => modelById(id)?.pts ?? 3;
  const pointsUsed = units.reduce((s, u) => s + ptsOf(u.model), 0);
  const overCap = pointsUsed > CREW_POINTS_CAP;
  const command = units.filter((u) => u.tier === 'command');
  const field = units.filter((u) => u.tier === 'field');

  // estimated fleet burn ($/1k objective tokens, rough) from real pricing
  const estBurn = units.reduce((s, u) => {
    const m = modelById(u.model);
    return s + (m ? (m.priceIn * 0.5 + m.priceOut * 0.5) : 1.5);
  }, 0);

  const crewSpec = (() => {
    const map: Record<string, number> = {};
    for (const u of units) {
      const role = u.tier === 'command' ? 'lead' : 'worker';
      const k = `${u.model}|${role}`;
      map[k] = (map[k] ?? 0) + 1;
    }
    return Object.entries(map).map(([k, count]) => {
      const [model, role] = k.split('|');
      return { model, role, count };
    });
  })();

  useEffect(() => { localStorage.setItem('swarm_op_name', name); }, [name]);

  useEffect(() => {
    if (phase !== 'creating' || !conn) return;
    const mine = rooms.filter((r: any) => me && r.createdBy?.toHexString() === me);
    const fresh = mine.find((r: any) => !snapshot.current.has(String(r.id)));
    if (fresh) { submit(fresh.id); onEnter(fresh.id, units.map((u) => u.model)); setPhase('submitting'); }
  }, [rooms, phase]);

  const submit = (roomId: bigint) => {
    conn.reducers.submitGoal({
      roomId, title: mission.brief,
      maxDepth: mission.maxDepth, maxTasks: mission.maxTasks,
      deadlineMs: BigInt(mission.deadlineMs), runBudgetMicros: BigInt(mission.supplyMicros),
      crew: crewSpec,
    });
  };

  const launch = () => {
    if (!conn || !identity || units.length === 0 || overCap) return;
    if (preRoomId != null) { submit(preRoomId); onEnter(preRoomId, units.map((u) => u.model)); setPhase('submitting'); return; }
    snapshot.current = new Set(rooms.filter((r: any) => me && r.createdBy?.toHexString() === me).map((r: any) => String(r.id)));
    conn.reducers.createRoom({ name: mission.id, displayName: name });
    setPhase('creating');
  };

  const addUnit = (model: string, tier: 'command' | 'field') =>
    setUnits((u) => [...u, { uid: uid(), model, tier }]);
  const removeUnit = (id: string) => setUnits((u) => u.filter((x) => x.uid !== id));

  const onDrop = (tier: 'command' | 'field') => (e: React.DragEvent) => {
    e.preventDefault();
    const model = e.dataTransfer.getData('model');
    if (model) addUnit(model, tier);
  };
  const allow = (e: React.DragEvent) => e.preventDefault();

  const joinable = rooms.filter((r: any) => goals.some((g: any) => g.roomId === r.id && g.status === 'active'));

  return (
    <div className="wr">
      <div className="wr-sheet">
        {/* title block */}
        <div className="wr-titleblock">
          <div className="wr-tb-left">
            <div className="wr-stamp">OPERATIONS</div>
            <h1 className="wr-h1">SWARM ARENA</h1>
            <div className="wr-sub">Field Command · assemble &amp; deploy an autonomous agent task force</div>
          </div>
          <div className="wr-tb-right">
            <div className="wr-reg">REV 2 · SECTOR M-04</div>
            <div className={`wr-link ${isActive ? 'on' : ''}`}>{isActive ? '● UPLINK LIVE' : '○ LINKING…'}</div>
          </div>
        </div>

        {/* mission tabs */}
        <div className="wr-label">01 · Operation</div>
        <div className="wr-missions">
          {MISSIONS.map((m) => (
            <button key={m.id} className={`wr-mtab ${m.id === missionId ? 'sel' : ''}`} onClick={() => setMissionId(m.id)}>
              <span className="wr-mtab-name">{m.name}</span>
              <span className="wr-mtab-meta">{m.maxTasks} obj · {(m.deadlineMs / 1000).toFixed(1)}s · ${(m.supplyMicros / 1_000_000).toFixed(3)}</span>
            </button>
          ))}
        </div>

        <div className="wr-grid">
          {/* model market */}
          <div className="wr-market">
            <div className="wr-label">02 · Roster — drag units onto the table</div>
            <div className="wr-market-list">
              {MODELS.map((m) => <MarketCard key={m.id} m={m} onAdd={() => addUnit(m.id, 'field')} />)}
            </div>
            <div className="wr-custom">
              <input className="wr-input" placeholder="custom openrouter id…" value={custom} onChange={(e) => setCustom(e.target.value)} />
              <button className="wr-btn-sm" disabled={!custom.trim()} onClick={() => { addUnit(custom.trim(), 'field'); setCustom(''); }}>+ field</button>
            </div>
          </div>

          {/* command table */}
          <div className="wr-table" onDragOver={allow}>
            <div className="wr-label-row">
              <span className="wr-label">03 · Command structure</span>
              <span className={`wr-points ${overCap ? 'over' : ''}`}>
                CREW {pointsUsed}/{CREW_POINTS_CAP} <span className="wr-burn">· est. burn ${estBurn.toFixed(2)}/k</span>
              </span>
            </div>

            <div className={`wr-tier command ${command.length === 0 ? 'empty' : ''}`} onDrop={onDrop('command')} onDragOver={allow}>
              <div className="wr-tier-tag">◆ COMMAND</div>
              <div className="wr-counters">
                {command.length === 0 && <div className="wr-drop">drop a Lead here</div>}
                {command.map((u) => <Counter key={u.uid} u={u} onRemove={() => removeUnit(u.uid)} />)}
              </div>
            </div>

            <div className="wr-spine"><span>chain of command</span></div>

            <div className={`wr-tier field ${field.length === 0 ? 'empty' : ''}`} onDrop={onDrop('field')} onDragOver={allow}>
              <div className="wr-tier-tag">▣ FIELD</div>
              <div className="wr-counters">
                {field.length === 0 && <div className="wr-drop">drop Workers here</div>}
                {field.map((u) => <Counter key={u.uid} u={u} onRemove={() => removeUnit(u.uid)} />)}
              </div>
            </div>
          </div>
        </div>

        {/* dispatch / launch */}
        <div className="wr-dispatch">
          <div className="wr-callsign">
            <span className="wr-label">Callsign</span>
            <input className="wr-input cs" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <button className="wr-launch" disabled={!isActive || phase !== 'idle' || units.length === 0 || overCap} onClick={launch}>
            {phase !== 'idle' ? 'DEPLOYING…' : overCap ? 'OVER CREW CAP' : units.length === 0 ? 'ASSEMBLE A FORCE' : `▸ DEPLOY · ${units.length} UNITS`}
          </button>
        </div>

        {joinable.length > 0 && (
          <div className="wr-join">
            <span className="wr-label">Active operations</span>
            {joinable.map((r: any) => (
              <button key={String(r.id)} className="wr-chip" onClick={() => { conn?.reducers.joinRoom({ roomId: r.id, displayName: name }); onEnter(r.id, units.map((u) => u.model)); }}>
                {r.name} #{String(r.id)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MarketCard({ m, onAdd }: { m: ModelCard; onAdd: () => void }) {
  return (
    <div
      className={`wr-unit-card ${!m.beatsDeadline ? 'risky' : ''}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('model', m.id)}
    >
      <div className="wr-uc-head">
        <span className="wr-uc-name">{m.name}</span>
        <span className="wr-uc-pts">{m.pts}<i>pt</i></span>
      </div>
      <div className="wr-uc-id">{m.id.split('/')[1]}</div>
      <div className="wr-uc-price">
        ${m.priceIn.toFixed(2)} in · ${m.priceOut.toFixed(2)} out <span className="wr-uc-perm">/M tok</span>
      </div>
      <div className="wr-uc-bars">
        <Bar label="SPD" v={m.speed} /><Bar label="QAL" v={m.quality} />
        {!m.beatsDeadline && <span className="wr-uc-late">LATE</span>}
      </div>
      <button className="wr-uc-add" onClick={onAdd}>+ deploy</button>
    </div>
  );
}

function Counter({ u, onRemove }: { u: Unit; onRemove: () => void }) {
  const m = modelById(u.model);
  const name = m?.name ?? u.model.split('/').pop()?.replace(/:.*$/, '') ?? u.model;
  return (
    <div className={`wr-counter ${u.tier}`} onClick={onRemove} title="click to remove">
      <span className="wr-counter-glyph">{u.tier === 'command' ? '◆' : '▣'}</span>
      <span className="wr-counter-name">{name}</span>
      <span className="wr-counter-x">✕</span>
    </div>
  );
}

function Bar({ label, v }: { label: string; v: number }) {
  return (
    <span className="wr-bar">
      <i>{label}</i>
      {[1, 2, 3, 4, 5].map((k) => <b key={k} className={k <= v ? 'on' : ''} />)}
    </span>
  );
}
