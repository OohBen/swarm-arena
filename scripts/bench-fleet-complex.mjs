import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject } from "ai";
import { z } from "zod";

const REQUEST_TIMEOUT_MS = Number(process.env.SWARM_BENCH_TIMEOUT_MS ?? 25_000);
const ROUNDS = Number(process.env.SWARM_BENCH_ROUNDS ?? 2);
const DEADLINE_FAST_MS = Number(process.env.SWARM_BENCH_FAST_DEADLINE_MS ?? 2_000);
const DEADLINE_DEMO_MS = Number(process.env.SWARM_BENCH_DEMO_DEADLINE_MS ?? 5_000);
const MODEL_FILTER = new Set(
  (process.env.SWARM_BENCH_MODELS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

function parseEnv(file) {
  const env = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

const env = parseEnv(path.join(os.homedir(), ".ai.env"));
if (!env.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY missing from ~/.ai.env");
}

const openrouter = createOpenRouter({
  apiKey: env.OPENROUTER_API_KEY,
  appName: "Swarm Complex Fleet Benchmark",
  compatibility: "strict",
});

const fleetSchema = z.object({
  decision: z.enum([
    "post_result",
    "spawn_children",
    "human_override",
    "block_task",
    "retry_task",
  ]),
  diagnosis: z.string(),
  reducer_action: z.string(),
  client_action: z.string(),
  spawn_policy: z.string(),
  operator_message: z.string(),
  child_1: z.string(),
  child_2: z.string(),
  child_3: z.string(),
  child_4: z.string(),
  risk: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
});

const tasks = [
  {
    id: "race-claim",
    prompt:
      "Eight workers subscribed to pending tasks. Two agents appear to complete task T-17. The log shows both called claim_task within 40ms. Diagnose and propose reducer/client follow-up tasks for a SpacetimeDB swarm demo.",
    terms: ["claim", "atomic", "reducer", "transaction"],
  },
  {
    id: "duplicate-spawn",
    prompt:
      "A worker validates output, posts result, then crashes. On restart it posts again and creates duplicate child tasks under the same parent. Diagnose and propose a bounded recovery plan.",
    terms: ["duplicate", "idempot", "parent", "attempt"],
  },
  {
    id: "stale-agent",
    prompt:
      "Agent gamma claimed a task and stopped heartbeating. The task stays assigned forever while pending work drains. Diagnose the lease/heartbeat behavior and propose the next reducer action.",
    terms: ["heartbeat", "stale", "lease", "retry"],
  },
  {
    id: "graph-lag",
    prompt:
      "The React graph is two seconds behind when 12 agents spawn events rapidly. SpacetimeDB state is correct, but the UI appears frozen and then jumps. Diagnose the client/subscription path.",
    terms: ["subscription", "event", "batch", "graph"],
  },
  {
    id: "budget-cap",
    prompt:
      "The root goal is at max_depth 3 with max_tasks nearly exhausted. A model wants to spawn four more children from a depth-3 task. Decide whether to post, block, retry, or override.",
    terms: ["depth", "budget", "cap", "block"],
  },
  {
    id: "human-conflict",
    prompt:
      "Two human operators edit the same task title while an agent is writing its result. One operator pauses the branch. Decide the safest action and what event should be visible to everyone.",
    terms: ["human", "override", "pause", "event"],
  },
];

const models = [
  { label: "GPT-OSS 120B Nitro", id: "openai/gpt-oss-120b:nitro" },
  {
    label: "GLM 4.7 Nitro",
    id: "z-ai/glm-4.7:nitro",
    reasoning: { effort: "none", exclude: true },
  },
  { label: "Mercury 2 Nitro", id: "inception/mercury-2:nitro" },
  { label: "Gemini 3.1 Flash Lite Nitro", id: "google/gemini-3.1-flash-lite:nitro" },
  { label: "Grok 4.3 Nitro", id: "x-ai/grok-4.3:nitro" },
  { label: "DeepSeek V4 Flash Nitro", id: "deepseek/deepseek-v4-flash:nitro" },
  { label: "Trinity Mini Nitro", id: "arcee-ai/trinity-mini:nitro" },
  { label: "Qwen3.6 Flash Nitro", id: "qwen/qwen3.6-flash:nitro" },
].filter((model) => !MODEL_FILTER.size || MODEL_FILTER.has(model.id) || MODEL_FILTER.has(model.label));

async function loadPricing() {
  const response = await fetch("https://openrouter.ai/api/v1/models");
  if (!response.ok) return new Map();
  const payload = await response.json();
  return new Map(
    payload.data.map((model) => [
      model.id,
      {
        prompt: Number(model.pricing?.prompt ?? 0),
        completion: Number(model.pricing?.completion ?? 0),
      },
    ]),
  );
}

function baseModelId(id) {
  return id.replace(/:(nitro|floor|free)$/, "");
}

function estimateCostUsd(config, usage, pricingByModel) {
  const pricing = pricingByModel.get(baseModelId(config.id));
  if (!pricing || !usage) return 0;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return inputTokens * pricing.prompt + outputTokens * pricing.completion;
}

function makeModel(config) {
  return openrouter.chat(config.id, {
    provider: {
      require_parameters: true,
      sort: "throughput",
    },
    structuredOutputs: { strict: true },
    ...(config.reasoning ? { reasoning: config.reasoning } : {}),
  });
}

function qualityScore(object, task) {
  const text = Object.values(object).join(" ").toLowerCase();
  const taskHits = task.terms.filter((term) => text.includes(term)).length;
  const globalTerms = [
    ["spacetime", "reducer", "transaction", "atomic"],
    ["budget", "depth", "attempt", "cap"],
    ["event", "operator", "visible", "log"],
    ["validate", "schema", "structured", "idempot"],
  ];
  const globalHits = globalTerms.filter((group) => group.some((term) => text.includes(term))).length;
  const decisionHit =
    (task.id === "budget-cap" && ["block_task", "human_override"].includes(object.decision)) ||
    (task.id === "stale-agent" && ["retry_task", "human_override"].includes(object.decision)) ||
    (task.id === "human-conflict" && object.decision === "human_override") ||
    (task.id !== "budget-cap" && task.id !== "stale-agent" && task.id !== "human-conflict");

  return taskHits + globalHits + (decisionHit ? 1 : 0);
}

async function runOne(config, task, round, pricingByModel) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = performance.now();
  try {
    const result = await generateObject({
      model: makeModel(config),
      schema: fleetSchema,
      schemaName: "swarm_complex_fleet_decision_v1",
      temperature: 0.1,
      maxRetries: 0,
      abortSignal: controller.signal,
      prompt: [
        "Return strict structured JSON for a live AI-agent swarm worker.",
        "Choose the safest decision for this task. Keep strings concise but specific.",
        "Mention the reducer action, client/UI action, spawn policy, visible operator message, and four follow-up child tasks.",
        `Round: ${round}. Task ${task.id}: ${task.prompt}`,
      ].join("\n"),
    });
    const ms = Math.round(performance.now() - started);
    const parsed = fleetSchema.safeParse(result.object);
    return {
      ok: parsed.success,
      ms,
      taskId: task.id,
      round,
      score: parsed.success ? qualityScore(result.object, task) : 0,
      decision: parsed.success ? result.object.decision : "invalid",
      size: JSON.stringify(result.object).length,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      costUsd: estimateCostUsd(config, result.usage, pricingByModel),
    };
  } catch (error) {
    return {
      ok: false,
      ms: Math.round(performance.now() - started),
      taskId: task.id,
      round,
      score: 0,
      decision: "error",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      error: String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 180),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function percentile(values, p) {
  if (!values.length) return "";
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function summarize(config, results) {
  const oks = results.filter((result) => result.ok);
  const ms = oks.map((result) => result.ms);
  const scores = oks.map((result) => result.score);
  const totalInputTokens = results.reduce((sum, result) => sum + result.inputTokens, 0);
  const totalOutputTokens = results.reduce((sum, result) => sum + result.outputTokens, 0);
  const totalCostUsd = results.reduce((sum, result) => sum + result.costUsd, 0);
  const fastPass = oks.filter((result) => result.ms <= DEADLINE_FAST_MS).length;
  const demoPass = oks.filter((result) => result.ms <= DEADLINE_DEMO_MS).length;
  const failed = results.filter((result) => !result.ok);

  return {
    model: `${config.label} (${config.id})`,
    valid: `${oks.length}/${results.length}`,
    p50: percentile(ms, 0.5),
    p90: percentile(ms, 0.9),
    p95: percentile(ms, 0.95),
    min: ms.length ? Math.min(...ms) : "",
    max: ms.length ? Math.max(...ms) : "",
    stdev: Math.round(stdev(ms)),
    fastPass: `${fastPass}/${results.length}`,
    demoPass: `${demoPass}/${results.length}`,
    scoreAvg: scores.length ? mean(scores).toFixed(1) : "0.0",
    scoreMin: scores.length ? Math.min(...scores) : 0,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    totalCostUsd,
    costPerValid: oks.length ? totalCostUsd / oks.length : 0,
    errors: failed.slice(0, 2).map((result) => `${result.taskId}:${result.error}`).join(" | "),
  };
}

const pricingByModel = await loadPricing();

console.log(`rounds=${ROUNDS}\tfleet_width=${tasks.length}\trequests_per_model=${ROUNDS * tasks.length}`);
console.log(
  [
    "model",
    "valid",
    "p50_ms",
    "p90_ms",
    "p95_ms",
    "min_ms",
    "max_ms",
    "jitter_stdev",
    `under_${DEADLINE_FAST_MS}ms`,
    `under_${DEADLINE_DEMO_MS}ms`,
    "quality_avg",
    "quality_min",
    "input_tokens",
    "output_tokens",
    "total_cost_usd",
    "cost_per_valid_usd",
    "errors",
  ].join("\t"),
);

for (const config of models) {
  const allResults = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const roundResults = await Promise.all(
      tasks.map((task) => runOne(config, task, round, pricingByModel)),
    );
    allResults.push(...roundResults);
  }
  const row = summarize(config, allResults);
  console.log(
    [
      row.model,
      row.valid,
      row.p50,
      row.p90,
      row.p95,
      row.min,
      row.max,
      row.stdev,
      row.fastPass,
      row.demoPass,
      row.scoreAvg,
      row.scoreMin,
      row.inputTokens,
      row.outputTokens,
      row.totalCostUsd.toFixed(6),
      row.costPerValid.toFixed(6),
      row.errors,
    ].join("\t"),
  );
}
