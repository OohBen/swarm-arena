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
    id: 'colonize-mars',
    name: 'Colonize Mars',
    flavor: 'Establish a self-sustaining colony on the red planet.',
    brief:
      'Establish a self-sustaining human colony on Mars. Plan and execute the full expedition: secure life support and breathable air, extract water, generate power, build pressurized habitats, set up food production, and establish Earth communications. Break the colonization effort into concrete objectives and sub-objectives, then carry them out.',
    maxDepth: 3,
    maxTasks: 24,
    deadlineMs: 2000,
    supplyMicros: 30_000,
  },
  {
    id: 'lunar-gateway',
    name: 'Build the Lunar Gateway',
    flavor: 'Construct an orbital station and surface base on the Moon.',
    brief:
      'Construct the Lunar Gateway: an orbital station plus a permanent surface base on the Moon. Decompose the build into transport, assembly, power, life support, science modules, and resupply logistics, and execute each workstream.',
    maxDepth: 3,
    maxTasks: 24,
    deadlineMs: 2000,
    supplyMicros: 30_000,
  },
  {
    id: 'deep-space-rescue',
    name: 'Deep Space Rescue',
    flavor: 'A crew is stranded. Mount the rescue before life support fails.',
    brief:
      'A research crew is stranded on a disabled vessel in deep space with failing life support. Mount a rescue operation: locate the vessel, plan the intercept, stabilize life support, execute the docking and evacuation, and get everyone home. Break the operation into urgent objectives and act fast.',
    maxDepth: 3,
    maxTasks: 20,
    deadlineMs: 2000,
    supplyMicros: 22_000,
  },
  {
    id: 'terraform',
    name: 'Terraform Operation',
    flavor: 'Kickstart the terraforming of a barren world.',
    brief:
      'Kickstart the terraforming of a barren world: thicken the atmosphere, warm the surface, seed water cycles, and introduce engineered biology. Decompose the century-scale program into concrete first-phase objectives and execute them.',
    maxDepth: 3,
    maxTasks: 24,
    deadlineMs: 2000,
    supplyMicros: 30_000,
  },
];

// Real OpenRouter models, rated from the project's own benchmark sweeps
// (docs/model-routing.md). pts = crew-points cost (your draft cap is finite).
export interface ModelCard {
  id: string;
  name: string;
  tagline: string;
  speed: number; // 1-5
  quality: number; // 1-5
  cost: number; // 1-5 ($ per call)
  pts: number; // crew-points cost
  p50: number; // measured median latency, ms
  beatsDeadline: boolean; // reliably under the 2s window?
  priceIn: number; // $ per 1M input tokens (real OpenRouter pricing)
  priceOut: number; // $ per 1M output tokens
}

export const MODELS: ModelCard[] = [
  { id: 'openai/gpt-oss-120b:nitro', name: 'Scout', tagline: 'Fast, cheap, beats the deadline every time.', speed: 5, quality: 4, cost: 1, pts: 2, p50: 510, beatsDeadline: true, priceIn: 0.10, priceOut: 0.50 },
  { id: 'z-ai/glm-4.7:nitro', name: 'Engineer', tagline: 'High-quality work, still under the deadline.', speed: 4, quality: 5, cost: 2, pts: 4, p50: 705, beatsDeadline: true, priceIn: 0.40, priceOut: 1.60 },
  { id: 'inception/mercury-2:nitro', name: 'Runner', tagline: 'Reliable fast fallback, mid cost.', speed: 4, quality: 4, cost: 3, pts: 3, p50: 1089, beatsDeadline: true, priceIn: 0.25, priceOut: 1.00 },
  { id: 'x-ai/grok-4.3:nitro', name: 'Oracle', tagline: 'Genius-tier — but slow and pricey. Misses the 2s window.', speed: 2, quality: 5, cost: 5, pts: 6, p50: 3291, beatsDeadline: false, priceIn: 3.00, priceOut: 15.00 },
  { id: 'google/gemini-3.1-flash-lite:nitro', name: 'Surveyor', tagline: 'Capable but inconsistent latency; often late.', speed: 2, quality: 4, cost: 2, pts: 3, p50: 6287, beatsDeadline: false, priceIn: 0.10, priceOut: 0.40 },
  { id: 'deepseek/deepseek-v4-flash:nitro', name: 'Analyst', tagline: 'Cheap and thorough, but very slow.', speed: 1, quality: 4, cost: 2, pts: 2, p50: 8316, beatsDeadline: false, priceIn: 0.07, priceOut: 0.28 },
];

export const CREW_POINTS_CAP = 20;

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
