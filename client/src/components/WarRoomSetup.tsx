import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, PointerEvent as ReactPointerEvent } from 'react';
import { MISSIONS, MODELS, CREW_POINTS_CAP, modelById, ModelCard } from '../lib/missions';

type Team = 'blue' | 'red';
type Unit = { uid: string; model: string; tier: 'command' | 'field' };
type PointerDrag = { uid: string; label: string; x: number; y: number; startX: number; startY: number; active: boolean };

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function starterUnits(): Unit[] {
  return [
    { uid: uid(), model: 'z-ai/glm-4.7:nitro', tier: 'command' },
    { uid: uid(), model: 'openai/gpt-oss-120b:nitro', tier: 'field' },
    { uid: uid(), model: 'openai/gpt-oss-120b:nitro', tier: 'field' },
  ];
}

function crewFromUnits(units: Unit[]) {
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
}

function unitsFromDraft(rows: any[]): Unit[] {
  const out: Unit[] = [];
  for (const row of rows) {
    for (let i = 0; i < row.count; i += 1) {
      out.push({ uid: uid(), model: row.model, tier: row.role === 'lead' ? 'command' : 'field' });
    }
  }
  return out.length ? out : starterUnits();
}

function pointsForRows(rows: any[]) {
  return rows.reduce((sum, row) => sum + (modelById(row.model)?.pts ?? 3) * row.count, 0);
}

function countRows(rows: any[]) {
  return rows.reduce((sum, row) => sum + row.count, 0);
}

function sameIdentity(a: any, b: any) {
  return a?.toHexString?.() === b?.toHexString?.();
}

export function WarRoomSetup({ conn, identity, isActive, rooms, goals, operators, draftSlots, preRoomId, currentRoom, onEnter, onExit }: any) {
  const [name, setName] = useState(localStorage.getItem('swarm_op_name') || 'CMDR');
  const [missionId, setMissionId] = useState(MISSIONS[0].id);
  const [units, setUnits] = useState<Unit[]>(starterUnits);
  const [custom, setCustom] = useState('');
  const [phase, setPhase] = useState<'idle' | 'creating'>('idle');
  const [copied, setCopied] = useState(false);
  const [draggingUnit, setDraggingUnit] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<'command' | 'field' | null>(null);
  const [pointerDrag, setPointerDrag] = useState<PointerDrag | null>(null);
  const snapshot = useRef<Set<string>>(new Set());
  const hydrated = useRef<string>('');
  const pointerDragRef = useRef<PointerDrag | null>(null);
  const me = identity?.toHexString();

  const room = currentRoom ?? (preRoomId != null ? rooms.find((r: any) => r.id === preRoomId) ?? null : null);
  const mission = MISSIONS.find((m) => m.id === (room?.name ?? missionId)) ?? MISSIONS[0];
  const roomId = room?.id ?? null;
  const roomOps = roomId != null ? operators.filter((o: any) => o.roomId === roomId) : [];
  const blueOp = roomOps.find((o: any) => o.team === 'blue') ?? null;
  const redOp = roomOps.find((o: any) => o.team === 'red') ?? null;
  const meOp = me ? roomOps.find((o: any) => o.identity?.toHexString() === me) ?? null : null;
  const myTeam: Team | null = meOp?.team === 'blue' || meOp?.team === 'red' ? meOp.team : null;
  const locked = Boolean(meOp?.ready);
  const canEdit = Boolean(room && room.status === 'setup' && myTeam && !locked);
  const shareUrl = room ? `${window.location.origin}${window.location.pathname}?room=${String(room.id)}` : '';

  const teamRows = (team: Team) =>
    draftSlots.filter((s: any) => roomId != null && s.roomId === roomId && s.team === team);
  const blueDraft = teamRows('blue');
  const redDraft = teamRows('red');

  const ptsOf = (id: string) => modelById(id)?.pts ?? 3;
  const pointsUsed = units.reduce((s, u) => s + ptsOf(u.model), 0);
  const overCap = pointsUsed > CREW_POINTS_CAP;
  const command = units.filter((u) => u.tier === 'command');
  const field = units.filter((u) => u.tier === 'field');
  const crewSpec = useMemo(() => crewFromUnits(units), [units]);
  const crewSig = JSON.stringify(crewSpec);
  const modelLabel = (u: Unit) => modelById(u.model)?.name ?? u.model.split('/').pop()?.replace(/:.*$/, '') ?? u.model;

  const estBurn = units.reduce((s, u) => {
    const m = modelById(u.model);
    return s + (m ? (m.priceIn * 500 + m.priceOut * 500) / 1_000_000 : 0.0015);
  }, 0);

  useEffect(() => { localStorage.setItem('swarm_op_name', name); }, [name]);

  useEffect(() => {
    if (phase !== 'creating' || !conn) return;
    const mine = rooms.filter((r: any) => me && r.createdBy?.toHexString() === me && r.status === 'setup');
    const fresh = mine.find((r: any) => !snapshot.current.has(String(r.id)));
    if (fresh) {
      onEnter(fresh.id);
      setPhase('idle');
    }
  }, [rooms, phase, conn, me, onEnter]);

  useEffect(() => {
    if (!room || !myTeam) return;
    const key = `${String(room.id)}:${myTeam}`;
    if (hydrated.current === key) return;
    const rows = teamRows(myTeam);
    if (rows.length > 0) setUnits(unitsFromDraft(rows));
    else setUnits(starterUnits());
    hydrated.current = key;
  }, [room?.id, myTeam, draftSlots.length]);

  useEffect(() => {
    if (!conn || !room || room.status !== 'setup' || !myTeam || locked || overCap || units.length === 0) return;
    const h = window.setTimeout(() => {
      conn.reducers.submitDraft({
        roomId: room.id,
        team: myTeam,
        ready: false,
        title: mission.brief,
        maxDepth: mission.maxDepth,
        maxTasks: mission.maxTasks,
        deadlineMs: BigInt(mission.deadlineMs),
        runBudgetMicros: BigInt(mission.supplyMicros),
        crew: crewSpec,
      });
    }, 350);
    return () => window.clearTimeout(h);
  }, [conn, room?.id, room?.status, myTeam, locked, overCap, units.length, mission.id, crewSig]);

  const host = () => {
    if (!conn || !identity || phase !== 'idle') return;
    snapshot.current = new Set(
      rooms.filter((r: any) => me && r.createdBy?.toHexString() === me).map((r: any) => String(r.id))
    );
    conn.reducers.createRoom({ name: missionId, displayName: name });
    setPhase('creating');
  };

  const joinSide = (id: bigint, team: Team | 'spectator') => {
    conn?.reducers.joinRoom({ roomId: id, displayName: name, team });
    onEnter(id);
  };

  const lockDraft = () => {
    if (!conn || !room || !myTeam || overCap || units.length === 0) return;
    conn.reducers.submitDraft({
      roomId: room.id,
      team: myTeam,
      ready: true,
      title: mission.brief,
      maxDepth: mission.maxDepth,
      maxTasks: mission.maxTasks,
      deadlineMs: BigInt(mission.deadlineMs),
      runBudgetMicros: BigInt(mission.supplyMicros),
      crew: crewSpec,
    });
  };

  const copyShare = async () => {
    if (!shareUrl) return;
    await navigator.clipboard?.writeText(shareUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const addUnit = (model: string, tier: 'command' | 'field') => {
    if (!canEdit) return;
    setUnits((u) => [...u, { uid: uid(), model, tier }]);
  };
  const moveUnit = (id: string, tier: 'command' | 'field') => {
    if (!canEdit) return;
    setUnits((u) => u.map((x) => (x.uid === id ? { ...x, tier } : x)));
  };
  const removeUnit = (id: string) => {
    if (!canEdit) return;
    setUnits((u) => u.filter((x) => x.uid !== id));
  };

  const beginPointerDrag = (u: Unit) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!canEdit || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const next = {
      uid: u.uid,
      label: modelLabel(u),
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
    };
    pointerDragRef.current = next;
    setPointerDrag(next);
    setDraggingUnit(u.uid);
  };

  useEffect(() => {
    const tierAt = (x: number, y: number): 'command' | 'field' | null => {
      const hit = document.elementFromPoint(x, y) as HTMLElement | null;
      const tier = hit?.closest?.('.wr-tier');
      if (!tier) return null;
      if (tier.classList.contains('command')) return 'command';
      if (tier.classList.contains('field')) return 'field';
      return null;
    };

    const onMove = (e: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag) return;
      const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 5;
      const next = { ...drag, x: e.clientX, y: e.clientY, active: drag.active || moved };
      pointerDragRef.current = next;
      setPointerDrag(next);
      setDragTarget(tierAt(e.clientX, e.clientY));
    };

    const onUp = (e: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag) return;
      const target = tierAt(e.clientX, e.clientY);
      if (canEdit && drag.active && target) {
        setUnits((u) => u.map((x) => (x.uid === drag.uid ? { ...x, tier: target } : x)));
      }
      pointerDragRef.current = null;
      setPointerDrag(null);
      setDraggingUnit(null);
      setDragTarget(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [canEdit]);

  const onDrop = (tier: 'command' | 'field') => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragTarget(null);
    setDraggingUnit(null);
    const unitId = e.dataTransfer.getData('application/x-swarm-unit') || e.dataTransfer.getData('unit');
    if (unitId) {
      moveUnit(unitId, tier);
      return;
    }
    const model = e.dataTransfer.getData('application/x-swarm-model') || e.dataTransfer.getData('model');
    if (model) addUnit(model, tier);
  };
  const allow = (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const leaveDrop = (tier: 'command' | 'field') => (e: DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    if (dragTarget === tier) setDragTarget(null);
  };

  const setupRooms = rooms.filter((r: any) => r.status === 'setup');
  const runningRooms = rooms.filter((r: any) => goals.some((g: any) => g.roomId === r.id && g.status === 'active'));
  const waitingOn = !room
    ? 'Host a room, then send the room link to the second commander.'
    : !blueOp
      ? 'Waiting for Blue commander.'
      : !redOp
        ? 'Waiting for Red commander.'
        : !blueOp.ready || !redOp.ready
          ? 'Both commanders draft independently, then lock. Battle starts automatically.'
          : 'Both sides locked. Starting battle...';

  return (
    <div className="wr">
      <div className="wr-sheet">
        <div className="wr-titleblock">
          <div className="wr-tb-left">
            <div className="wr-stamp">MULTIPLAYER</div>
            <h1 className="wr-h1">SWARM ARENA</h1>
            <div className="wr-sub">Two human commanders draft AI fleets; SpacetimeDB runs the shared battle state live</div>
          </div>
          <div className="wr-tb-right">
            <div className="wr-reg">{room ? `ROOM ${String(room.id)} · ${room.status.toUpperCase()}` : 'NO ROOM'}</div>
            <div className={`wr-link ${isActive ? 'on' : ''}`}>{isActive ? '● UPLINK LIVE' : '○ LINKING'}</div>
          </div>
        </div>

        <div className="wr-lobbybar">
          <div>
            <div className="wr-label">01 · Multiplayer lobby</div>
            <div className="wr-lobbyline">{waitingOn}</div>
          </div>
          {room && (
            <div className="wr-share">
              <input className="wr-input" value={shareUrl} readOnly />
              <button className="wr-btn-sm" onClick={copyShare}>{copied ? 'copied' : 'copy link'}</button>
              <button className="wr-btn-sm" onClick={onExit}>leave</button>
            </div>
          )}
        </div>

        <div className="wr-commanders">
          <TeamPanel
            team="blue"
            op={blueOp}
            draft={blueDraft}
            isMe={sameIdentity(blueOp?.identity, identity)}
            canJoin={Boolean(room && room.status === 'setup' && (!blueOp || sameIdentity(blueOp.identity, identity)))}
            onJoin={() => room && joinSide(room.id, 'blue')}
          />
          <TeamPanel
            team="red"
            op={redOp}
            draft={redDraft}
            isMe={sameIdentity(redOp?.identity, identity)}
            canJoin={Boolean(room && room.status === 'setup' && (!redOp || sameIdentity(redOp.identity, identity)))}
            onJoin={() => room && joinSide(room.id, 'red')}
          />
        </div>

        {!room && (setupRooms.length > 0 || runningRooms.length > 0) && (
          <div className="wr-lobby-strip">
            {setupRooms.length > 0 && (
              <div className="wr-join">
                <span className="wr-label">Open lobbies</span>
                {setupRooms.map((r: any) => {
                  const ops = operators.filter((o: any) => o.roomId === r.id);
                  const hasBlue = ops.some((o: any) => o.team === 'blue');
                  const hasRed = ops.some((o: any) => o.team === 'red');
                  return (
                    <span key={String(r.id)} className="wr-roomgroup">
                      <button className="wr-chip" disabled={hasBlue} onClick={() => joinSide(r.id, 'blue')}>{r.name} #{String(r.id)} Blue</button>
                      <button className="wr-chip red" disabled={hasRed} onClick={() => joinSide(r.id, 'red')}>Red</button>
                    </span>
                  );
                })}
              </div>
            )}

            {runningRooms.length > 0 && (
              <div className="wr-join">
                <span className="wr-label">Live battles</span>
                {runningRooms.map((r: any) => (
                  <button key={String(r.id)} className="wr-chip" onClick={() => joinSide(r.id, 'spectator')}>
                    Watch #{String(r.id)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="wr-label">02 · Operation</div>
        <div className="wr-missions">
          {MISSIONS.map((m) => (
            <button
              key={m.id}
              className={`wr-mtab ${m.id === mission.id ? 'sel' : ''}`}
              disabled={Boolean(room)}
              onClick={() => setMissionId(m.id)}
            >
              <span className="wr-mtab-name">{m.name}</span>
              <span className="wr-mtab-meta">{m.maxTasks} actions · {(m.deadlineMs / 1000).toFixed(1)}s · ${(m.supplyMicros / 1_000_000).toFixed(3)} supply</span>
            </button>
          ))}
        </div>
        <div className="wr-brief">
          <span><b>Blue</b> human commander drafts Blue fleet</span>
          <span><b>Red</b> second human drafts Red fleet</span>
          <span><b>Fight</b> AI agents claim combat tasks live</span>
        </div>
        <div className="wr-playbook">
          <span><b>Draft</b> Command units take scout/recon work; field units execute assault, hold, and sabotage tasks.</span>
          <span><b>Orders</b> A command token instantly nudges one node and queues priority work for your side's agents.</span>
          <span><b>Supply</b> Blue and Red spend separate supply pools when their own models answer.</span>
        </div>

        {!room && (
          <div className="wr-dispatch compact">
            <div className="wr-callsign">
              <span className="wr-label">Callsign</span>
              <input className="wr-input cs" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <button className="wr-launch" disabled={!isActive || phase !== 'idle'} onClick={host}>
              {phase === 'creating' ? 'CREATING ROOM...' : 'HOST BLUE LOBBY'}
            </button>
          </div>
        )}

        {room && (
          <div className="wr-grid">
            <div className="wr-market">
              <div className="wr-label">03 · Model market</div>
              <div className="wr-market-list">
                {MODELS.map((m) => <MarketCard key={m.id} m={m} disabled={!canEdit} onAdd={() => addUnit(m.id, 'field')} />)}
              </div>
              <div className="wr-custom">
                <input className="wr-input" disabled={!canEdit} placeholder="custom openrouter id..." value={custom} onChange={(e) => setCustom(e.target.value)} />
                <button className="wr-btn-sm" disabled={!canEdit || !custom.trim()} onClick={() => { addUnit(custom.trim(), 'field'); setCustom(''); }}>+ field</button>
              </div>
            </div>

            <div className={`wr-table ${myTeam ?? 'spectator'}`} onDragOver={allow}>
              <div className="wr-label-row">
                <span className="wr-label">04 · {myTeam ? `${myTeam} draft` : 'Choose a side to draft'}</span>
                <span className={`wr-points ${overCap ? 'over' : ''}`}>
                  CREW {pointsUsed}/{CREW_POINTS_CAP} <span className="wr-burn">· est. burn ${estBurn.toFixed(4)}/round</span>
                </span>
              </div>

              <div
                className={`wr-tier command ${command.length === 0 ? 'empty' : ''} ${dragTarget === 'command' ? 'drop-hot' : ''}`}
                onDrop={onDrop('command')}
                onDragEnter={() => setDragTarget('command')}
                onDragLeave={leaveDrop('command')}
                onDragOver={allow}
              >
                <div className="wr-tier-tag">◆ COMMAND</div>
                <div className="wr-counters">
                  {command.length === 0 && <div className="wr-drop">drop one Lead here</div>}
                  {command.map((u) => (
                    <Counter
                      key={u.uid}
                      u={u}
                      locked={!canEdit}
                      onRemove={() => removeUnit(u.uid)}
                      onMove={() => moveUnit(u.uid, 'field')}
                      dragging={draggingUnit === u.uid}
                      onPointerDown={beginPointerDrag(u)}
                    />
                  ))}
                </div>
              </div>

              <div className="wr-spine"><span>{locked ? 'draft locked' : 'live draft syncs to spacetime'}</span></div>

              <div
                className={`wr-tier field ${field.length === 0 ? 'empty' : ''} ${dragTarget === 'field' ? 'drop-hot' : ''}`}
                onDrop={onDrop('field')}
                onDragEnter={() => setDragTarget('field')}
                onDragLeave={leaveDrop('field')}
                onDragOver={allow}
              >
                <div className="wr-tier-tag">▣ FIELD</div>
                <div className="wr-counters">
                  {field.length === 0 && <div className="wr-drop">drop Workers here</div>}
                  {field.map((u) => (
                    <Counter
                      key={u.uid}
                      u={u}
                      locked={!canEdit}
                      onRemove={() => removeUnit(u.uid)}
                      onMove={() => moveUnit(u.uid, 'command')}
                      dragging={draggingUnit === u.uid}
                      onPointerDown={beginPointerDrag(u)}
                    />
                  ))}
                </div>
              </div>

              <div className="wr-dispatch">
                <div className="wr-callsign">
                  <span className="wr-label">Callsign</span>
                  <input className="wr-input cs" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <button className="wr-launch" disabled={!canEdit || overCap || units.length === 0 || command.length === 0} onClick={lockDraft}>
                  {locked ? 'LOCKED' : overCap ? 'OVER CREW CAP' : !myTeam ? 'JOIN A SIDE' : `LOCK ${myTeam.toUpperCase()} DRAFT`}
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
      {pointerDrag?.active && (
        <div className={`wr-drag-ghost ${myTeam ?? ''}`} style={{ left: pointerDrag.x, top: pointerDrag.y }}>
          {pointerDrag.label}
        </div>
      )}
    </div>
  );
}

function TeamPanel({ team, op, draft, isMe, canJoin, onJoin }: any) {
  const locked = Boolean(op?.ready);
  const units = countRows(draft);
  const points = pointsForRows(draft);
  return (
    <div className={`wr-team ${team} ${locked ? 'locked' : ''} ${isMe ? 'me' : ''}`}>
      <div className="wr-team-top">
        <span>{team.toUpperCase()}</span>
        <b>{locked ? 'LOCKED' : op ? 'DRAFTING' : 'OPEN'}</b>
      </div>
      <div className="wr-team-name">{op?.displayName ?? 'Waiting for commander'}</div>
      <div className="wr-team-meta">{units} units · {points}/{CREW_POINTS_CAP} pts</div>
      {canJoin && <button className="wr-team-join" onClick={onJoin}>{op ? 'rejoin side' : `join ${team}`}</button>}
    </div>
  );
}

function MarketCard({ m, disabled, onAdd }: { m: ModelCard; disabled: boolean; onAdd: () => void }) {
  return (
    <div
      className={`wr-unit-card ${!m.beatsDeadline ? 'risky' : ''} ${disabled ? 'disabled' : ''}`}
      draggable={!disabled}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('application/x-swarm-model', m.id);
        e.dataTransfer.setData('model', m.id);
        e.dataTransfer.setData('text/plain', m.name);
      }}
    >
      <div className="wr-uc-head">
        <span className="wr-uc-name">{m.name}</span>
        <span className="wr-uc-pts">{m.pts}<i>pt</i></span>
      </div>
      <div className="wr-uc-id">{m.id.split('/')[1]}</div>
      <div className="wr-uc-price">
        ${m.priceIn.toFixed(2)} in · ${m.priceOut.toFixed(2)} out <span className="wr-uc-perm">/M tok</span>
      </div>
      <div className="wr-uc-lat">strict JSON p50 ~{m.p50.toLocaleString()}ms</div>
      <div className="wr-uc-bars">
        <Bar label="SPD" v={m.speed} /><Bar label="QAL" v={m.quality} />
        {!m.beatsDeadline && <span className="wr-uc-late">LATE</span>}
      </div>
      <button className="wr-uc-add" disabled={disabled} onClick={onAdd}>+ deploy</button>
    </div>
  );
}

function Counter({
  u,
  locked,
  dragging,
  onRemove,
  onMove,
  onPointerDown,
}: {
  u: Unit;
  locked: boolean;
  dragging: boolean;
  onRemove: () => void;
  onMove: () => void;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const m = modelById(u.model);
  const name = m?.name ?? u.model.split('/').pop()?.replace(/:.*$/, '') ?? u.model;
  return (
    <div
      className={`wr-counter ${u.tier} ${locked ? 'locked' : ''} ${dragging ? 'dragging' : ''}`}
      draggable={false}
      onPointerDown={locked ? undefined : onPointerDown}
      title={locked ? 'draft locked' : 'drag between Command and Field or use the move button'}
    >
      <span className="wr-counter-glyph">{u.tier === 'command' ? '◆' : '▣'}</span>
      <span className="wr-counter-name">{name}</span>
      {!locked && (
        <button
          type="button"
          className="wr-counter-move"
          onClick={(e) => {
            e.stopPropagation();
            onMove();
          }}
          aria-label={`Move ${name} to ${u.tier === 'command' ? 'Field' : 'Command'}`}
        >
          {u.tier === 'command' ? 'FIELD' : 'CMD'}
        </button>
      )}
      {!locked && (
        <button
          type="button"
          className="wr-counter-x"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={`Remove ${name}`}
        >
          X
        </button>
      )}
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
