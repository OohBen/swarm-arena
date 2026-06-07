export interface MissionTemplate {
  id: string;
  name: string;
  brief: string;
  flavor: string;
  maxDepth: number;
  maxTasks: number;
  deadlineMs: number;
  supplyMicros: number; // run budget — mission halts if spent (loss condition)
}

export const MISSIONS: MissionTemplate[] = [
  {
    id: 'mars-front',
    name: 'Mars Front',
    flavor: 'Blue and Red swarms fight for the central relay chain.',
    brief:
      'Mars Front: command the Blue AI swarm against a rival Red swarm on a shared three-lane battle map. Capture neutral relays, fortify supply depots, break through enemy posts, and crack the Red HQ before supplies expire. If neither HQ falls, win by holding more territory.',
    maxDepth: 2,
    maxTasks: 80,
    deadlineMs: 3000,
    supplyMicros: 180_000,
  },
  {
    id: 'lunar-siege',
    name: 'Lunar Siege',
    flavor: 'A tight relay fight around exposed lunar supply lines.',
    brief:
      'Lunar Siege: Blue and Red AI swarms contest relay posts between two lunar HQs. Hold supply depots for extra command tokens, sabotage fortified enemy posts, and open a lane to destroy the Red HQ.',
    maxDepth: 2,
    maxTasks: 80,
    deadlineMs: 3000,
    supplyMicros: 180_000,
  },
  {
    id: 'orbital-breach',
    name: 'Orbital Breach',
    flavor: 'Fast center-lane pressure with fragile HQ integrity.',
    brief:
      'Orbital Breach: two autonomous swarms fight over docking relays around a damaged orbital platform. The commander must pick where Blue pushes, where it holds, and when to spend scarce orders before Red breaks through.',
    maxDepth: 2,
    maxTasks: 80,
    deadlineMs: 3000,
    supplyMicros: 160_000,
  },
  {
    id: 'terraform-war',
    name: 'Terraform War',
    flavor: 'A longer territory-control match with more supply pressure.',
    brief:
      'Terraform War: Blue and Red agent fleets battle over terraforming infrastructure. Capture depots, defend relays, sabotage hardened posts, and either crack the enemy HQ or win by territory when supplies run out.',
    maxDepth: 2,
    maxTasks: 90,
    deadlineMs: 3000,
    supplyMicros: 220_000,
  },
];

// Real OpenRouter models. Latency values come from this repo's structured-output
// sweeps plus the latest local spot checks; prices come from OpenRouter's live
// models endpoint. pts = crew-points cost (your draft cap is finite).
export interface ModelCard {
  id: string;
  name: string;
  tagline: string;
  speed: number; // 1-5
  quality: number; // 1-5
  cost: number; // 1-5 ($ per call)
  pts: number; // crew-points cost
  p50: number; // measured median latency, ms
  beatsDeadline: boolean; // recommended for the 3s live combat window?
  priceIn: number; // $ per 1M input tokens (real OpenRouter pricing)
  priceOut: number; // $ per 1M output tokens
}

export const MODELS: ModelCard[] = [
  { id: 'openai/gpt-oss-120b:nitro', name: 'Scout', tagline: 'Groq-pinned strict JSON. Best worker default.', speed: 5, quality: 4, cost: 1, pts: 2, p50: 1120, beatsDeadline: true, priceIn: 0.039, priceOut: 0.18 },
  { id: 'z-ai/glm-4.7:nitro', name: 'Engineer', tagline: 'Cerebras-pinned command model. Fastest high-quality lane.', speed: 5, quality: 5, cost: 2, pts: 4, p50: 417, beatsDeadline: true, priceIn: 0.40, priceOut: 1.75 },
  { id: 'inception/mercury-2:nitro', name: 'Runner', tagline: 'Reliable fallback with solid tactical writing.', speed: 4, quality: 4, cost: 2, pts: 3, p50: 943, beatsDeadline: true, priceIn: 0.25, priceOut: 0.75 },
  { id: 'google/gemini-3.1-flash-lite:nitro', name: 'Surveyor', tagline: 'Fast on simple combat, weaker on complex ops.', speed: 4, quality: 3, cost: 2, pts: 3, p50: 893, beatsDeadline: true, priceIn: 0.25, priceOut: 1.50 },
  { id: 'z-ai/glm-4.7-flash:nitro', name: 'Skirmisher', tagline: 'Very cheap GLM variant, but route jitter is real.', speed: 3, quality: 3, cost: 1, pts: 1, p50: 2020, beatsDeadline: false, priceIn: 0.06, priceOut: 0.40 },
  { id: 'x-ai/grok-4.3:nitro', name: 'Oracle', tagline: 'High reasoning budget, usually too slow for combat.', speed: 2, quality: 5, cost: 5, pts: 6, p50: 3291, beatsDeadline: false, priceIn: 1.25, priceOut: 2.50 },
  { id: 'google/gemini-3.5-flash:nitro', name: 'Flash', tagline: 'Good text, but missed the live combat window.', speed: 2, quality: 4, cost: 4, pts: 4, p50: 5459, beatsDeadline: false, priceIn: 1.50, priceOut: 9.00 },
  { id: 'deepseek/deepseek-v4-flash:nitro', name: 'Analyst', tagline: 'Cheap and thoughtful, too inconsistent for hot tasks.', speed: 2, quality: 4, cost: 1, pts: 2, p50: 3193, beatsDeadline: false, priceIn: 0.0983, priceOut: 0.1966 },
];

export const CREW_POINTS_CAP = 14;

export interface RoleDef {
  id: string;
  name: string;
  tagline: string;
}

export const ROLES: RoleDef[] = [
  { id: 'lead', name: 'Lead', tagline: 'Commands strategy — decomposes the mission into objectives.' },
  { id: 'worker', name: 'Worker', tagline: 'Executes objectives on the ground.' },
  { id: 'reviewer', name: 'Reviewer', tagline: 'Checks risky work and flags problems.' },
];

export function modelById(id?: string): ModelCard | undefined {
  if (!id) return undefined;
  return MODELS.find((m) => m.id === id || m.id.startsWith(id));
}

// Short display name for a model (used across the live board).
export function classOf(modelId?: string): string {
  return modelById(modelId)?.name ?? (modelId ? modelId.split('/').pop()!.replace(/:.*$/, '') : '—');
}
