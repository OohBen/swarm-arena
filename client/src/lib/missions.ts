export interface MissionTemplate {
  id: string;
  name: string;
  brief: string;
  flavor: string;
  maxDepth: number;
  maxTasks: number;
  deadlineMs: number;
}

// The environment we provide: each expedition is a high-level objective the
// player's AI crew must decompose and execute as a live objective tree.
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
  },
  {
    id: 'deep-space-rescue',
    name: 'Deep Space Rescue',
    flavor: 'A crew is stranded. Mount the rescue before life support fails.',
    brief:
      'A research crew is stranded on a disabled vessel in deep space with failing life support. Mount a rescue operation: locate the vessel, plan the intercept, stabilize life support, execute the docking and evacuation, and get everyone home. Break the operation into urgent objectives and act fast.',
    maxDepth: 3,
    maxTasks: 24,
    deadlineMs: 2000,
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
  },
];

// The crew the player assembles. Each unit class maps to an OpenRouter model.
export interface UnitClass {
  id: string; // OpenRouter model id
  klass: string; // game-facing class name
  role: string;
  blurb: string;
  speed: number; // 1-5
  quality: number; // 1-5
  cost: number; // 1-5 (higher = pricier)
}

export const UNIT_CLASSES: UnitClass[] = [
  {
    id: 'openai/gpt-oss-120b:nitro',
    klass: 'Scout',
    role: 'Worker',
    blurb: 'Fast recon. Cheap, consistent, beats the deadline.',
    speed: 5,
    quality: 3,
    cost: 1,
  },
  {
    id: 'z-ai/glm-4.7:nitro',
    klass: 'Engineer',
    role: 'Reviewer',
    blurb: 'Deep problem-solver. Higher quality, higher cost.',
    speed: 4,
    quality: 5,
    cost: 3,
  },
  {
    id: 'inception/mercury-2:nitro',
    klass: 'Runner',
    role: 'Worker',
    blurb: 'Rapid responder. A reliable fast fallback.',
    speed: 4,
    quality: 3,
    cost: 2,
  },
];

export function unitFor(modelId?: string): UnitClass | undefined {
  if (!modelId) return undefined;
  return UNIT_CLASSES.find((u) => u.id === modelId || u.id.startsWith(modelId));
}

export function classOf(modelId?: string): string {
  return unitFor(modelId)?.klass ?? (modelId ? modelId.split('/').pop()!.replace(/:.*$/, '') : '—');
}
