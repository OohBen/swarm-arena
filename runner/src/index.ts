import http from 'node:http';
import { Agent } from './agent';
import { DbConnection } from './module_bindings';
import { loadPricing } from './openrouter';
import { runAuto } from './supervisor';

// --- args / config ----------------------------------------------------------
function arg(name: string): string | undefined {
  const pfx = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pfx));
  if (hit) return hit.slice(pfx.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return undefined;
}

const URI = process.env.SWARM_URI ?? 'wss://maincloud.spacetimedb.com';
const DB = process.env.SWARM_DB ?? 'swarm-arena';

// Auto/supervisor mode: staff any active expedition automatically (deployed daemon).
const AUTO = process.argv.includes('--auto') || process.env.SWARM_AUTO === '1';

const roomArg = arg('room') ?? process.env.SWARM_ROOM;
if (!AUTO && !roomArg) throw new Error('room id required: pass --room <id> or set SWARM_ROOM (or run with --auto)');
const roomId = roomArg ? BigInt(roomArg) : 0n;

const models = (
  arg('agents') ??
  process.env.SWARM_AGENTS ??
  'openai/gpt-oss-120b:nitro,openai/gpt-oss-120b:nitro,z-ai/glm-4.7:nitro'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const mission = arg('mission') ?? process.env.SWARM_MISSION;
const maxDepth = Number(arg('max-depth') ?? 3);
const maxTasks = Number(arg('max-tasks') ?? 30);
const deadlineMs = BigInt(arg('deadline-ms') ?? 2000);

// Game-facing crew class per model, so agents read as "scout-1", "engineer-1".
function crewClass(id: string): string {
  if (/gpt-oss/i.test(id)) return 'scout';
  if (/glm/i.test(id)) return 'engineer';
  if (/mercury/i.test(id)) return 'runner';
  const afterSlash = id.includes('/') ? id.split('/')[1] : id;
  return afterSlash.replace(/:(nitro|floor|free)$/, '');
}

// Keep the worker daemon alive: a rejected reducer call (e.g. a race with the
// reaper) must never take down the whole crew. Log loudly, never silently swallow.
process.on('unhandledRejection', (reason) => {
  console.error('[runner] unhandled rejection (continuing):', String((reason as any)?.message ?? reason));
});
process.on('uncaughtException', (err) => {
  console.error('[runner] uncaught exception (continuing):', String(err?.message ?? err));
});

// --- optional bootstrap: submit a goal if the room has none active -----------
function bootstrapGoal(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const conn = DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .onConnect((c) => {
        c.subscriptionBuilder()
          .onApplied(() => {
            const active = [...c.db.goal.iter()].some(
              (g: any) => g.roomId === roomId && g.status === 'active'
            );
            if (active) {
              console.log('[bootstrap] active goal already present; skipping');
              (c as any).disconnect?.();
              resolve();
              return;
            }
            c.reducers.submitGoal({
              roomId,
              title: mission!,
              maxDepth,
              maxTasks,
              deadlineMs,
              defaultModel: models[0],
            });
            const poll = setInterval(() => {
              const ok = [...c.db.goal.iter()].some(
                (g: any) => g.roomId === roomId && g.status === 'active'
              );
              if (ok) {
                clearInterval(poll);
                console.log(`[bootstrap] submitted goal: ${mission}`);
                (c as any).disconnect?.();
                resolve();
              }
            }, 200);
            setTimeout(() => {
              clearInterval(poll);
              (c as any).disconnect?.();
              resolve();
            }, 4000);
          })
          .subscribe([`SELECT * FROM goal WHERE room_id = ${roomId}`]);
      })
      .onConnectError((_c, err) => reject(err))
      .build();
  });
}

// --- launch ------------------------------------------------------------------
await loadPricing();

if (AUTO) {
  // Health endpoint so Coolify (and any uptime check) sees a live port.
  const port = Number(process.env.PORT ?? 8080);
  http
    .createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('swarm supervisor ok');
    })
    .listen(port, () => console.log(`[auto] health endpoint on :${port}`));

  const maxRooms = Number(process.env.SWARM_MAX_ROOMS ?? 2);
  console.log(`[auto] supervisor mode · crew=${models.join(',')} · maxRooms=${maxRooms}`);
  runAuto({ uri: URI, db: DB, crew: models, maxRooms });
} else {
  if (mission) {
    await bootstrapGoal();
  }
  const agents = models.map(
    (model, i) =>
      new Agent({
        uri: URI,
        db: DB,
        roomId,
        name: `${crewClass(model)}-${i + 1}`,
        model,
      })
  );
  for (const a of agents) a.start();
  console.log(`launched ${agents.length} agent(s) into room ${roomId}: ${models.join(', ')}`);
}

process.on('SIGINT', () => {
  console.log('\nshutting down');
  process.exit(0);
});
