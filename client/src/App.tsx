import { useEffect, useState } from 'react';
import { useSwarm } from './lib/useSwarm';
import { TopStrip } from './components/TopStrip';
import { AgentRoster } from './components/AgentRoster';
import { EventConsole } from './components/EventConsole';
import { TaskGraph } from './components/TaskGraph';
import { TaskInspector } from './components/TaskInspector';
import { MissionSetup } from './components/MissionSetup';
import { Scoreboard } from './components/Scoreboard';

export default function App() {
  const swarm = useSwarm();
  const { conn, identity, isActive, subscribed, goals, tasks, agents, events, scores, operators } = swarm;

  const [roomId, setRoomId] = useState<bigint | null>(null);
  const [selectedId, setSelectedId] = useState<bigint | null>(null);
  const [view, setView] = useState<'live' | 'board'>('live');
  const [crew, setCrew] = useState<string[]>([
    'openai/gpt-oss-120b:nitro',
    'openai/gpt-oss-120b:nitro',
    'z-ai/glm-4.7:nitro',
  ]);

  const activeGoal =
    roomId != null ? goals.find((g: any) => g.roomId === roomId && g.status !== 'stopped') ?? null : null;

  // Operator presence heartbeat while in a room.
  useEffect(() => {
    if (!conn || roomId == null) return;
    const beat = () =>
      conn.reducers.heartbeatOperator({ roomId, selectedTaskId: selectedId ?? undefined });
    beat();
    const h = setInterval(beat, 3000);
    return () => clearInterval(h);
  }, [conn, roomId, selectedId]);

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
      <MissionSetup
        conn={conn}
        identity={identity}
        isActive={isActive}
        rooms={swarm.rooms}
        goals={goals}
        preRoomId={roomId}
        onEnter={(id: bigint, chosen?: string[]) => {
          setRoomId(id);
          if (chosen && chosen.length) setCrew(chosen);
        }}
      />
    );
  }

  const roomTasks = tasks.filter((t: any) => t.roomId === roomId);
  const roomAgents = agents.filter((a: any) => a.roomId === roomId);
  const roomEvents = events.filter((e: any) => e.roomId === roomId);
  const roomOps = operators.filter((o: any) => o.roomId === roomId);
  const score = scores.find((s: any) => s.goalId === activeGoal.id) ?? null;
  const selectedTask = selectedId != null ? roomTasks.find((t: any) => t.id === selectedId) ?? null : null;

  const runnerCmd = `SWARM_ROOM=${roomId} npx tsx src/index.ts --agents "${crew.join(',')}"`;

  if (view === 'board') {
    return (
      <Scoreboard
        goal={activeGoal}
        score={score}
        tasks={roomTasks}
        events={roomEvents}
        onBack={() => setView('live')}
      />
    );
  }

  return (
    <div className="app">
      <TopStrip goal={activeGoal} score={score} tasks={roomTasks} agents={roomAgents} />

      <div className="rail-left">
        <div className="panel">
          <div className="panel-h">
            <span className="micro">Command Deck</span>
            <span className="micro">Expedition #{String(roomId)}</span>
          </div>
          <div className="panel-b">
            <div className="kv" style={{ marginBottom: 8 }}>
              <span className="k">Commanders</span>
              <span className="vv">{roomOps.map((o: any) => o.displayName).join(', ') || '—'}</span>
              <span className="k">Expedition</span>
              <span className="vv">{activeGoal.status}</span>
            </div>
            <span className="micro">Deploy Crew (terminal)</span>
            <div className="result-box" style={{ fontSize: 9.5, margin: '6px 0 10px' }}>{runnerCmd}</div>
            <div className="btn-row">
              <button
                className={`btn ${activeGoal.status === 'complete' ? 'glow' : 'ghost'}`}
                onClick={() => setView('board')}
              >
                ▣ After-Action
              </button>
              <button className="btn ghost" onClick={() => { setRoomId(null); setSelectedId(null); }}>
                ◂ New Op
              </button>
            </div>
          </div>
        </div>

        <AgentRoster agents={roomAgents} tasks={roomTasks} />
      </div>

      <TaskGraph tasks={roomTasks} selectedId={selectedId} onSelect={setSelectedId} />

      <div className="rail-right">
        <TaskInspector task={selectedTask} agents={roomAgents} roomId={roomId} conn={conn} />
      </div>

      <EventConsole events={roomEvents} />
    </div>
  );
}
