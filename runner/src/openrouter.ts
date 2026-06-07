import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateObject } from 'ai';
import { z } from 'zod';
import { OPENROUTER_API_KEY } from './env';

// Strict structured worker output. Mirrors the benchmarked fleet schema shape
// (child_1..4 strings) that validated 30/30 on gpt-oss-120b:nitro — arrays are
// avoided on the hot path because some providers drop them under strict mode.
export const WorkerSchema = z.object({
  outcome: z.enum(['done', 'spawn_children', 'blocked']),
  result: z.string(),
  child_1: z.string(),
  child_2: z.string(),
  child_3: z.string(),
  child_4: z.string(),
  risk: z.string(),
  confidence: z.enum(['low', 'medium', 'high']),
  thought: z.string(),
});
export type WorkerObject = z.infer<typeof WorkerSchema>;

const REQUEST_TIMEOUT_MS = Number(process.env.SWARM_WORKER_TIMEOUT_MS ?? 12_000);

const openrouter = createOpenRouter({
  apiKey: OPENROUTER_API_KEY,
  appName: 'Swarm Arena',
  compatibility: 'strict',
});

// GLM emits reasoning by default; exclude it so it stays in the fast lane.
function reasoningFor(id: string): { effort: 'none'; exclude: true } | undefined {
  return /glm/i.test(id) ? { effort: 'none', exclude: true } : undefined;
}

function makeModel(id: string) {
  const reasoning = reasoningFor(id);
  return openrouter.chat(id, {
    provider: providerFor(id),
    structuredOutputs: { strict: true },
    ...(reasoning ? { reasoning } : {}),
  });
}

function baseModelId(id: string): string {
  return id.replace(/:(nitro|floor|free)$/, '');
}

function providerFor(id: string) {
  const base = baseModelId(id);
  if (base === 'openai/gpt-oss-120b') {
    return { only: ['Groq'], allow_fallbacks: false, require_parameters: true };
  }
  if (base === 'z-ai/glm-4.7') {
    return { only: ['Cerebras'], allow_fallbacks: false, require_parameters: true };
  }
  return { require_parameters: true, sort: 'throughput' as const };
}

let pricing: Map<string, { prompt: number; completion: number }> | null = null;

export async function loadPricing(): Promise<void> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    if (!res.ok) {
      console.warn(`[pricing] OpenRouter models endpoint ${res.status}; cost estimates will be 0`);
      pricing = new Map();
      return;
    }
    const payload: any = await res.json();
    pricing = new Map(
      payload.data.map((m: any) => [
        m.id,
        { prompt: Number(m.pricing?.prompt ?? 0), completion: Number(m.pricing?.completion ?? 0) },
      ])
    );
  } catch (err) {
    console.warn(`[pricing] failed to load (${String(err)}); cost estimates will be 0`);
    pricing = new Map();
  }
}

function estimateCostMicros(id: string, usage: any): bigint {
  if (!pricing || !usage) return 0n;
  const p = pricing.get(baseModelId(id));
  if (!p) return 0n;
  const inTok = usage.inputTokens ?? 0;
  const outTok = usage.outputTokens ?? 0;
  const usd = inTok * p.prompt + outTok * p.completion;
  return BigInt(Math.max(0, Math.round(usd * 1_000_000)));
}

export interface WorkerRun {
  object: WorkerObject;
  latencyMs: number;
  estimatedCostMicros: bigint;
}

export async function runWorker(args: {
  modelId: string;
  system: string;
  prompt: string;
}): Promise<WorkerRun> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = performance.now();
  try {
    const result = await generateObject({
      model: makeModel(args.modelId),
      schema: WorkerSchema,
      schemaName: 'swarm_worker_result',
      system: args.system,
      prompt: args.prompt,
      temperature: 0.1,
      maxRetries: 0,
      abortSignal: controller.signal,
    });
    const latencyMs = Math.round(performance.now() - started);
    return {
      object: result.object,
      latencyMs,
      estimatedCostMicros: estimateCostMicros(args.modelId, result.usage),
    };
  } finally {
    clearTimeout(timer);
  }
}
