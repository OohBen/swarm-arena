import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { OpenRouter } from "@openrouter/sdk";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject } from "ai";
import { z } from "zod";

const REQUEST_TIMEOUT_MS = 20_000;

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
const apiKey = env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw new Error("OPENROUTER_API_KEY missing from ~/.ai.env");
}

const jsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: { type: "string", enum: ["done", "blocked", "spawn_children"] },
    result: { type: "string" },
    child_1: { type: "string" },
    child_2: { type: "string" },
    child_3: { type: "string" },
    child_4: { type: "string" },
    risk: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: [
    "outcome",
    "result",
    "child_1",
    "child_2",
    "child_3",
    "child_4",
    "risk",
    "confidence",
  ],
};

const zodSchema = z.object({
  outcome: z.enum(["done", "blocked", "spawn_children"]),
  result: z.string(),
  child_1: z.string(),
  child_2: z.string(),
  child_3: z.string(),
  child_4: z.string(),
  risk: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
});

const responseFormat = {
  type: "json_schema",
  json_schema: {
    name: "swarm_worker_compact_v1",
    strict: true,
    schema: jsonSchema,
  },
};

const messages = [
  {
    role: "system",
    content: "You are a fast worker agent. Produce concise structured JSON output.",
  },
  {
    role: "user",
    content:
      "Goal: Build a SpacetimeDB demo where AI agents atomically claim tasks, execute them, post results, and spawn follow-up tasks. Return the next worker result.",
  },
];

const prompt = messages.map((message) => `${message.role}: ${message.content}`).join("\n");

const modelConfigs = [
  { label: "Mercury 2", model: "inception/mercury-2" },
  {
    label: "GLM 4.7 / Cerebras",
    model: "z-ai/glm-4.7",
    provider: { only: ["Cerebras"], allow_fallbacks: false },
    reasoning: { effort: "none", exclude: true },
  },
  {
    label: "GPT-OSS 120B / Cerebras",
    model: "openai/gpt-oss-120b",
    provider: { only: ["Cerebras"], allow_fallbacks: false },
  },
  { label: "Grok 4.3", model: "x-ai/grok-4.3" },
  { label: "Qwen3.6 Flash", model: "qwen/qwen3.6-flash" },
  { label: "Trinity Mini", model: "arcee-ai/trinity-mini" },
  { label: "Gemini 3.1 Flash Lite", model: "google/gemini-3.1-flash-lite" },
];

function providerFor(config) {
  return {
    require_parameters: true,
    ...(config.provider ?? {}),
  };
}

function buildBody(config) {
  return {
    model: config.model,
    messages,
    temperature: 0.1,
    stream: false,
    response_format: responseFormat,
    provider: providerFor(config),
    ...(config.reasoning ? { reasoning: config.reasoning } : {}),
  };
}

function validate(value) {
  return zodSchema.safeParse(value).success && Object.keys(value).length === 8;
}

function withTimeout() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return { signal: controller.signal, done: () => clearTimeout(timeout) };
}

function summarizeFailure(text) {
  return text.replace(/\s+/g, " ").slice(0, 260);
}

async function timed(label, fn) {
  const start = performance.now();
  try {
    const result = await fn();
    return { ok: true, label, ms: Math.round(performance.now() - start), ...result };
  } catch (error) {
    return {
      ok: false,
      label,
      ms: Math.round(performance.now() - start),
      error: summarizeFailure(String(error?.message ?? error)),
    };
  }
}

async function rawFetch(config) {
  const timeout = withTimeout();
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://localhost/swarm-hackathon",
        "X-Title": "Swarm Harness Benchmark",
      },
      body: JSON.stringify(buildBody(config)),
      signal: timeout.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${summarizeFailure(text)}`);
    }
    const payload = JSON.parse(text);
    const content = payload.choices?.[0]?.message?.content ?? "";
    const object = JSON.parse(content);
    return {
      valid: validate(object),
      contentLength: content.length,
      finish: payload.choices?.[0]?.finish_reason ?? "",
    };
  } finally {
    timeout.done();
  }
}

const openai = new OpenAI({
  apiKey,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": "https://localhost/swarm-hackathon",
    "X-Title": "Swarm Harness Benchmark",
  },
});

async function openaiSdk(config) {
  const timeout = withTimeout();
  try {
    const payload = await openai.chat.completions.create(buildBody(config), {
      signal: timeout.signal,
    });
    const content = payload.choices?.[0]?.message?.content ?? "";
    const object = JSON.parse(content);
    return {
      valid: validate(object),
      contentLength: content.length,
      finish: payload.choices?.[0]?.finish_reason ?? "",
    };
  } finally {
    timeout.done();
  }
}

const openrouterSdkClient = new OpenRouter({
  apiKey,
});

async function openrouterSdk(config) {
  const timeout = withTimeout();
  try {
    const payload = await openrouterSdkClient.chat.send({
      chatRequest: buildBody(config),
    }, {
      signal: timeout.signal,
    });
    const content = payload.choices?.[0]?.message?.content ?? "";
    const object = JSON.parse(content);
    return {
      valid: validate(object),
      contentLength: content.length,
      finish: payload.choices?.[0]?.finish_reason ?? "",
    };
  } finally {
    timeout.done();
  }
}

const aiOpenRouter = createOpenRouter({
  apiKey,
  appName: "Swarm Harness Benchmark",
  compatibility: "strict",
});

async function vercelAiSdk(config) {
  const timeout = withTimeout();
  try {
    const model = aiOpenRouter.chat(config.model, {
      provider: providerFor(config),
      structuredOutputs: { strict: true },
      ...(config.reasoning ? { reasoning: config.reasoning } : {}),
    });
    const result = await generateObject({
      model,
      schema: zodSchema,
      schemaName: "swarm_worker_compact_v1",
      temperature: 0.1,
      prompt,
      maxRetries: 0,
      abortSignal: timeout.signal,
    });
    return {
      valid: validate(result.object),
      contentLength: JSON.stringify(result.object).length,
      finish: result.finishReason ?? "",
    };
  } finally {
    timeout.done();
  }
}

const harnesses = [
  ["raw-fetch", rawFetch],
  ["openai-sdk", openaiSdk],
  ["openrouter-sdk", openrouterSdk],
  ["ai-sdk-generateObject", vercelAiSdk],
];

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? "";
}

async function runModelSweep() {
  console.log("\nMODEL SWEEP, raw fetch, strict schema, no max_tokens");
  console.log("model\tstatus\tbest_ms\tmedian_ms\tvalid_runs\tnotes");
  for (const config of modelConfigs) {
    const runs = [];
    for (let index = 0; index < 2; index++) {
      runs.push(await timed(config.label, () => rawFetch(config)));
    }
    const ok = runs.filter((run) => run.ok);
    const validRuns = ok.filter((run) => run.valid).length;
    const notes = runs
      .map((run) =>
        run.ok
          ? `${run.ms}ms/${run.valid ? "valid" : "invalid"}/len${run.contentLength}`
          : `${run.ms}ms/ERR:${run.error}`,
      )
      .join(" | ");
    console.log(
      [
        `${config.label} (${config.model})`,
        ok.length ? "ok" : "fail",
        ok.length ? Math.min(...ok.map((run) => run.ms)) : "",
        ok.length ? median(ok.map((run) => run.ms)) : "",
        `${validRuns}/${runs.length}`,
        notes,
      ].join("\t"),
    );
  }
}

async function runHarnessSweep() {
  const harnessModels = modelConfigs.filter((config) =>
    ["inception/mercury-2", "z-ai/glm-4.7", "openai/gpt-oss-120b"].includes(config.model),
  );
  console.log("\nHARNESS SWEEP, strict schema, no max_tokens");
  console.log("harness\tmodel\tstatus\tbest_ms\tmedian_ms\tvalid_runs\tnotes");
  for (const [harnessName, harness] of harnesses) {
    for (const config of harnessModels) {
      const runs = [];
      for (let index = 0; index < 2; index++) {
        runs.push(await timed(harnessName, () => harness(config)));
      }
      const ok = runs.filter((run) => run.ok);
      const validRuns = ok.filter((run) => run.valid).length;
      const notes = runs
        .map((run) =>
          run.ok
            ? `${run.ms}ms/${run.valid ? "valid" : "invalid"}/len${run.contentLength}`
            : `${run.ms}ms/ERR:${run.error}`,
        )
        .join(" | ");
      console.log(
        [
          harnessName,
          `${config.label} (${config.model})`,
          ok.length ? "ok" : "fail",
          ok.length ? Math.min(...ok.map((run) => run.ms)) : "",
          ok.length ? median(ok.map((run) => run.ms)) : "",
          `${validRuns}/${runs.length}`,
          notes,
        ].join("\t"),
      );
    }
  }
}

await runModelSweep();
await runHarnessSweep();
