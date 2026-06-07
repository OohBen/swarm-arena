import { useEffect, useState } from 'react';
import { useSwarm } from './lib/useSwarm';
import { WarRoomSetup } from './components/WarRoomSetup';
import { WarRoomBoard } from './components/WarRoomBoard';
import { Scoreboard } from './components/Scoreboard';

export default function App() {
  const swarm = useSwarm();
  const { conn, identity, isActive, subscribed, goals, tasks, agents, events, scores, operators, draftSlots, crises, teamStates, battleNodes, battleOrders } = swarm;

  const [roomId, setRoomId] = useState<bigint | null>(null);
  const [selectedId, setSelectedId] = useState<bigint | null>(null);
  const [view, setView] = useState<'live' | 'board'>('live');

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('room');
    if (id && /^\d+$/.test(id)) setRoomId(BigInt(id));
  }, []);

  const enterRoom = (id: bigint) => {
    setRoomId(id);
    setSelectedId(null);
    const url = new URL(window.location.href);
    url.searchParams.set('room', String(id));
    window.history.replaceState(null, '', url);
  };

  const leaveRoom = () => {
    setRoomId(null);
    setSelectedId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState(null, '', url);
  };

  const activeGoal =
    roomId != null ? goals.find((g: any) => g.roomId === roomId && g.status !== 'stopped') ?? null : null;
  const currentRoom = roomId != null ? swarm.rooms.find((r: any) => r.id === roomId) ?? null : null;
  const roomOps = roomId != null ? operators.filter((o: any) => o.roomId === roomId) : [];
  const myOp = identity ? roomOps.find((o: any) => o.identity?.toHexString() === identity.toHexString()) ?? null : null;
  const myTeam = myOp && (myOp.team === 'blue' || myOp.team === 'red') ? myOp.team : null;
  const shareUrl = roomId != null ? `${window.location.origin}${window.location.pathname}?room=${String(roomId)}` : '';

  // Operator presence heartbeat while in a room.
  useEffect(() => {
    if (!conn || roomId == null || !myOp) return;
    const beat = () =>
      conn.reducers.heartbeatOperator({ roomId, selectedTaskId: selectedId ?? undefined });
    beat();
    const h = setInterval(beat, 3000);
    return () => clearInterval(h);
  }, [conn, roomId, selectedId, myOp]);

  if (!isActive || !subscribed) {
    return (
      <div className="setup">
        <div className="setup-card" style={{ textAlign: 'center' }}>
          <h1>SWARM ARENA</h1>
          <div className="status-line" style={{ justifyContent: 'center' }}>
            <span className="dot-conn off" /> Linking to SpacetimeDB · maincloud…
          </div>
        </div>
      </div>
    );
  }

  if (roomId == null || !activeGoal) {
    return (
      <WarRoomSetup
        conn={conn}
        identity={identity}
        isActive={isActive}
        rooms={swarm.rooms}
        goals={goals}
        operators={operators}
        draftSlots={draftSlots}
        preRoomId={roomId}
        currentRoom={currentRoom}
        onEnter={enterRoom}
        onExit={leaveRoom}
      />
    );
  }

  const roomTasks = tasks.filter((t: any) => t.roomId === roomId);
  const roomAgents = agents.filter((a: any) => a.roomId === roomId);
  const roomEvents = events.filter((e: any) => e.roomId === roomId);
  const roomTeamStates = teamStates.filter((s: any) => s.roomId === roomId && s.goalId === activeGoal.id);
  const roomBattleNodes = battleNodes.filter((n: any) => n.roomId === roomId && n.goalId === activeGoal.id);
  const roomBattleOrders = battleOrders.filter((o: any) => o.roomId === roomId && o.goalId === activeGoal.id);
  const score = scores.find((s: any) => s.goalId === activeGoal.id) ?? null;
  const selectedTask = selectedId != null ? roomTasks.find((t: any) => t.id === selectedId) ?? null : null;

  const runnerCmd = 'Cloud runner staffs Blue and Red from locked lobby drafts';

  if (view === 'board') {
    return (
      <Scoreboard
        goal={activeGoal}
        score={score}
        tasks={roomTasks}
        teamStates={roomTeamStates}
        battleNodes={roomBattleNodes}
        events={roomEvents}
        onBack={() => setView('live')}
      />
    );
  }

  return (
    <WarRoomBoard
      goal={activeGoal}
      score={score}
      tasks={roomTasks}
      agents={roomAgents}
      teamStates={roomTeamStates}
      battleNodes={roomBattleNodes}
      battleOrders={roomBattleOrders}
      events={roomEvents}
      ops={roomOps}
      crises={crises.filter((c: any) => c.roomId === roomId && c.status === 'active')}
      roomId={roomId}
      conn={conn}
      myTeam={myTeam}
      shareUrl={shareUrl}
      selectedId={selectedId}
      setSelectedId={setSelectedId}
      runnerCmd={runnerCmd}
      onNewOp={leaveRoom}
      onBoard={() => setView('board')}
    />
  );
}
