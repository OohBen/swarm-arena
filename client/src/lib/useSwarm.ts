import { useEffect, useRef, useState } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { DbConnection, tables } from '../module_bindings';

// Connects the React tree to the live SpacetimeDB cache. Subscribes once, then
// exposes every table reactively. Room scoping is done by the caller.
export function useSwarm() {
  const { isActive, identity, token, getConnection } = useSpacetimeDB();
  const conn = getConnection() as DbConnection | null;
  const [subscribed, setSubscribed] = useState(false);
  const subRef = useRef(false);

  useEffect(() => {
    if (token) localStorage.setItem('swarm_auth_token', token);
  }, [token]);

  useEffect(() => {
    if (!conn || !isActive || subRef.current) return;
    subRef.current = true;
    conn
      .subscriptionBuilder()
      .onApplied(() => setSubscribed(true))
      .subscribe([
        tables.room,
        tables.operator,
        tables.goal,
        tables.task,
        tables.agent,
        tables.event,
        tables.score,
        tables.draftSlot,
        tables.teamState,
        tables.battleNode,
        tables.battleOrder,
        tables.crisis,
      ]);
  }, [conn, isActive]);

  const [rooms] = useTable(tables.room);
  const [operators] = useTable(tables.operator);
  const [goals] = useTable(tables.goal);
  const [tasks] = useTable(tables.task);
  const [agents] = useTable(tables.agent);
  const [events] = useTable(tables.event);
  const [scores] = useTable(tables.score);
  const [draftSlots] = useTable(tables.draftSlot);
  const [teamStates] = useTable(tables.teamState);
  const [battleNodes] = useTable(tables.battleNode);
  const [battleOrders] = useTable(tables.battleOrder);
  const [crises] = useTable(tables.crisis);

  return {
    conn,
    identity,
    isActive,
    subscribed,
    rooms: rooms as any[],
    operators: operators as any[],
    goals: goals as any[],
    tasks: tasks as any[],
    agents: agents as any[],
    events: events as any[],
    scores: scores as any[],
    draftSlots: draftSlots as any[],
    teamStates: teamStates as any[],
    battleNodes: battleNodes as any[],
    battleOrders: battleOrders as any[],
    crises: crises as any[],
  };
}
