import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject, stepCountIs, tool, ToolLoopAgent } from "ai";
import { z } from "zod";

const REQUEST_TIMEOUT_MS = 25_000;

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
  appName: "Swarm Nitro Agentic Benchmark",
  compatibility: "strict",
});

const workerSchema = z.object({
  outcome: z.enum(["done", "blocked", "spawn_children"]),
  result: z.string(),
  child_1: z.string(),
  child_2: z.string(),
  child_3: z.string(),
  child_4: z.string(),
  risk: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
});

const models = [
  { label: "Mercury 2 Nitro", id: "inception/mercury-2:nitro" },
  {
    label: "GLM 4.7 Nitro",
    id: "z-ai/glm-4.7:nitro",
    reasoning: { effort: "none", exclude: true },
  },
  { label: "GPT-OSS 120B Nitro", id: "openai/gpt-oss-120b:nitro" },
  { label: "Grok 4.3 Nitro", id: "x-ai/grok-4.3:nitro" },
  { label: "Qwen3.6 Flash Nitro", id: "qwen/qwen3.6-flash:nitro" },
  { label: "Trinity Mini Nitro", id: "arcee-ai/trinity-mini:nitro" },
  { label: "Gemini 3.1 Flash Lite Nitro", id: "google/gemini-3.1-flash-lite:nitro" },
  { label: "DeepSeek V4 Flash Nitro", id: "deepseek/deepseek-v4-flash:nitro" },
  { label: "Hermes 4 70B Nitro", id: "nousresearch/hermes-4-70b:nitro" },
];

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

async function timed(fn) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = performance.now();
  try {
    const result = await fn(controller.signal);
    return { ok: true, ms: Math.round(performance.now() - started), ...result };
  } catch (error) {
    return {
      ok: false,
      ms: Math.round(performance.now() - started),
      error: String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 280),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function simpleStructured(config, abortSignal) {
  const result = await generateObject({
    model: makeModel(config),
    schema: workerSchema,
    schemaName: "swarm_worker_simple_v1",
    temperature: 0.1,
    maxRetries: 0,
    abortSignal,
    prompt:
      "Return concise JSON for this simple Swarm task: triage a stuck task named 'frontend graph flickers after updates'. Include four concrete child tasks.",
  });
  return {
    valid: workerSchema.safeParse(result.object).success,
    size: JSON.stringify(result.object).length,
  };
}

async function detailedStructured(config, abortSignal) {
  const result = await generateObject({
    model: makeModel(config),
    schema: workerSchema,
    schemaName: "swarm_worker_detailed_v1",
    temperature: 0.1,
    maxRetries: 0,
    abortSignal,
    prompt:
      "Return concise JSON for this more detailed agentic Swarm task: inspect a failing SpacetimeDB demo where three workers race to claim tasks, one task is duplicated, and the UI graph lags by two seconds. Produce the next result and four follow-up tasks that would move the build forward.",
  });
  return {
    valid: workerSchema.safeParse(result.object).success,
    size: JSON.stringify(result.object).length,
  };
}

async function toolLoopAgentic(config, abortSignal) {
  const calls = [];
  const agent = new ToolLoopAgent({
    model: makeModel(config),
    instructions:
      "You are a fast Swarm worker agent. Use JSON-capable concise reasoning. Call inspect_task once, then give a short final operator update with the next action.",
    temperature: 0.1,
    tools: {
      inspect_task: tool({
        description: "Inspect the current task and return local task state.",
        inputSchema: z.object({
          task_id: z.string(),
        }),
        execute: async ({ task_id }) => {
          calls.push(`inspect_task:${task_id}`);
          return {
            task_id,
            status: "pending",
            depth: 2,
            attempts: 1,
            budget_remaining: 9,
            recent_event: "agent-beta failed validation after spawning duplicate child",
          };
        },
      }),
    },
    stopWhen: stepCountIs(3),
  });

  const result = await agent.generate({
    abortSignal,
    timeout: { totalMs: REQUEST_TIMEOUT_MS },
    prompt:
      "Task id task-42. Decide the next action for a live SpacetimeDB AI swarm demo. You must inspect the task before finalizing. Keep the final answer under 60 words.",
  });

  const steps = result.steps ?? [];
  const toolCalls = steps.flatMap((step) => step.toolCalls ?? []);
  return {
    valid: calls.length > 0 || toolCalls.length > 0,
    size: result.text.length,
    calls: calls.length || toolCalls.length,
  };
}

function note(result) {
  if (!result.ok) return `ERR ${result.ms}ms ${result.error}`;
  const callNote = result.calls == null ? "" : ` calls=${result.calls}`;
  return `${result.ms}ms valid=${result.valid} size=${result.size}${callNote}`;
}

console.log("model\tsimple_structured\tdetailed_structured\ttool_loop_agent");
for (const config of models) {
  const simple = await timed((signal) => simpleStructured(config, signal));
  const detailed = await timed((signal) => detailedStructured(config, signal));
  const agentic = await timed((signal) => toolLoopAgentic(config, signal));
  console.log([`${config.label} (${config.id})`, note(simple), note(detailed), note(agentic)].join("\t"));
}

