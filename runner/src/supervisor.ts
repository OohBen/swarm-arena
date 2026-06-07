import { Agent } from './agent';
import { DbConnection, tables } from './module_bindings';

const MAX_AGENTS_PER_ROOM = 16; // hard safety cap on spawned agents per expedition

export interface SupervisorConfig {
  uri: string;
  db: string;
  crew: string[]; // fallback models per staffed expedition
  maxRooms: number; // concurrency cap (bounds spend)
  pollMs?: number;
}

// Auto mode: watch the cloud DB and staff any active expedition with a crew,
// recycling slots when missions finish. This makes the deployed public site
// self-sufficient — agents appear without anyone running a terminal — while the
// maxRooms cap keeps OpenRouter spend bounded.
export function runAuto(cfg: SupervisorConfig): void {
  const pollMs = cfg.pollMs ?? 3000;
  const staffed = new Map<string, Agent[]>();
  let ready = false;
  let conn: DbConnection | null = null;

  conn = DbConnection.builder()
    .withUri(cfg.uri)
    .withDatabaseName(cfg.db)
    .onConnect((c) => {
      c.subscriptionBuilder()
        .onApplied(() => {
          ready = true;
          console.log('[supervisor] online — watching for expeditions');
        })
        .subscribe([tables.room, tables.goal, tables.agent, tables.task, tables.crewSlot]);
    })
    .onConnectError((_ctx, err) => console.error('[supervisor] connect error:', err.message))
    .onDisconnect(() => {
      ready = false;
      console.log('[supervisor] disconnected');
    })
    .build();

  setInterval(() => {
    if (!ready || !conn) return;

    // Recycle finished expeditions so their slots free up.
    for (const [roomKey, crew] of [...staffed.entries()]) {
      const goal = [...conn.db.goal.iter()].find(
        (g: any) => String(g.roomId) === roomKey && g.status === 'active'
      );
      if (!goal) {
        crew.forEach((a) => a.stop());
        staffed.delete(roomKey);
        console.log(`[supervisor] stood down crew for expedition ${roomKey}`);
      }
    }

    // Staff new active expeditions up to the cap.
    const activeGoals = [...conn.db.goal.iter()].filter((g: any) => g.status === 'active');
    for (const g of activeGoals) {
      const roomKey = String(g.roomId);
      if (staffed.has(roomKey)) continue;
      if (staffed.size >= cfg.maxRooms) break;

      // Only staff expeditions with real actionable work — never burn spend on a
      // stale or already-finished room.
      const hasPending = [...conn.db.task.iter()].some(
        (t: any) => t.roomId === g.roomId && t.status === 'pending'
      );
      if (!hasPending) continue;

      // Deploy exactly the crew the player assembled (crew_slot rows). Fall back
      // to a default worker crew only if none was specified.
      const slots = [...conn.db.crewSlot.iter()].filter((s: any) => String(s.goalId) === String(g.id));
      let specs: { model: string; role: string; team: string }[] = [];
      if (slots.length > 0) {
        for (const s of slots) {
          for (let k = 0; k < s.count; k++) specs.push({ model: s.model, role: s.role, team: s.team ?? 'blue' });
        }
      } else {
        specs = cfg.crew.flatMap((m) => [
          { model: m, role: 'worker', team: 'blue' },
          { model: m, role: 'worker', team: 'red' },
        ]);
      }
      specs = specs.slice(0, MAX_AGENTS_PER_ROOM); // safety cap on spend/resources

      const existing = [...conn.db.agent.iter()].filter((a: any) => a.roomId === g.roomId).length;
      if (existing >= specs.length) {
        staffed.set(roomKey, []); // already staffed elsewhere; just track it
        continue;
      }

      const roleCount: Record<string, number> = {};
      const crew = specs.map((sp) => {
        const key = `${sp.team}-${sp.role}`;
        roleCount[key] = (roleCount[key] ?? 0) + 1;
        return new Agent({
          uri: cfg.uri,
          db: cfg.db,
          roomId: g.roomId,
          name: `${sp.team}-${sp.role}-${roleCount[key]}`,
          model: sp.model,
          role: sp.role,
          team: sp.team,
        });
      });
      crew.forEach((a) => a.start());
      staffed.set(roomKey, crew);
      console.log(`[supervisor] staffed battle ${roomKey} with ${crew.length} agents (${specs.map((s) => `${s.team}:${s.role}`).join(',')})`);
    }
  }, pollMs);
}
