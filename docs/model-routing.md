# Model Routing Notes

## Why Structured Outputs

The agent loop must not depend on prompt-only JSON. Worker outputs create database rows, so malformed or drifting responses can corrupt the task tree. The worker client should use strict JSON Schema structured outputs, parse the returned content, validate the shape locally, and only then call SpacetimeDB reducers.

References:

- OpenRouter structured outputs: https://openrouter.ai/docs/guides/features/structured-outputs
- OpenRouter provider routing and `require_parameters`: https://openrouter.ai/docs/provider-routing
- OpenAI structured outputs guide: https://platform.openai.com/docs/guides/structured-outputs

## No-Cap Smoke Test

Run date: Saturday, June 6, 2026.

Payload constraints:

- OpenRouter Chat Completions endpoint.
- `response_format.type = "json_schema"`.
- `json_schema.strict = true`.
- `provider.require_parameters = true`.
- No `max_tokens` field.
- Local request timeout used only to avoid a hung network/provider call.

Results:

| Model | Provider route | Best observed latency | Strict schema result |
| --- | --- | ---: | --- |
| `inception/mercury-2` | OpenRouter default | 124 ms | valid |
| `z-ai/glm-4.7` | `Cerebras` only | 166 ms | valid |
| `openai/gpt-oss-120b` | `Cerebras` only | 208 ms | valid |
| `qwen/qwen3.5-flash-02-23` | OpenRouter default | 756 ms | invalid, empty content |

Earlier strict-schema checks also found `meta-llama/llama-3.3-70b-instruct` pinned to `Groq` had no route when `require_parameters = true`.

## Recommended Policy

Use three model lanes:

1. `openai/gpt-oss-120b:nitro` as the fastest strict-output worker lane in the latest Nitro run.
2. `z-ai/glm-4.7:nitro` as the second fast worker lane, with reasoning disabled/excluded.
3. `inception/mercury-2:nitro` as a reliable fallback worker.

Do not route first-loop task execution to providers that only work when `require_parameters` is false. Silent parameter dropping is worse than a fast failure.

## Nitro Agentic Sweep

Run date: Saturday, June 6, 2026.

Harness:

- Vercel AI SDK `generateObject` for strict structured worker output.
- Vercel AI SDK `ToolLoopAgent` for a tiny tool-use task.
- OpenRouter model IDs use the `:nitro` suffix.
- `provider.require_parameters = true`.
- No `max_tokens` or `maxOutputTokens`.

| Model | Simple Structured | Detailed Structured | Tool Loop Agent |
| --- | ---: | ---: | ---: |
| `openai/gpt-oss-120b:nitro` | 420 ms, valid | 381 ms, valid | 572 ms, valid |
| `z-ai/glm-4.7:nitro` | 527 ms, valid | 496 ms, valid | 1,149 ms, valid |
| `inception/mercury-2:nitro` | 1,167 ms, valid | 880 ms, valid | 663 ms, valid |
| `google/gemini-3.1-flash-lite:nitro` | 1,119 ms, valid | 3,627 ms, valid | 1,547 ms, valid |
| `x-ai/grok-4.3:nitro` | 3,214 ms, valid | 2,749 ms, valid | 3,254 ms, valid |
| `deepseek/deepseek-v4-flash:nitro` | 3,674 ms, valid | 5,791 ms, valid | 3,650 ms, valid |
| `arcee-ai/trinity-mini:nitro` | 4,389 ms, valid | 3,775 ms, valid | 7,040 ms, valid |
| `qwen/qwen3.6-flash:nitro` | failed schema | failed schema | 2,871 ms, valid |
| `nousresearch/hermes-4-70b:nitro` | no strict route | no strict route | no tool route |

Hermes Agent CLI smoke test:

- Package: `hermes-agent==0.16.0`.
- Command path: `uvx --from hermes-agent hermes --provider openrouter --model openai/gpt-oss-120b:nitro --ignore-user-config --ignore-rules -z <prompt>`.
- Cold/help startup: 5.83 seconds.
- First oneshot simple prompt: 28.2 seconds.
- First oneshot agentic planning prompt: 9.8 seconds.
- Warm oneshot prompts: about 8.3-8.4 seconds.

Conclusion: Hermes Agent is a full standalone agent runtime and is too slow/heavy for Swarm's hot worker loop. Use it only as an optional operator-side assistant if needed. For the embedded worker harness, use Vercel AI SDK `generateObject` and `ToolLoopAgent`.

## Complex Fleet Benchmark

Run date: Saturday, June 6, 2026.

Harness:

- Vercel AI SDK `generateObject`.
- Six concurrent harder Swarm tasks per round.
- Tasks cover claim races, duplicate spawned children, stale agents, UI graph lag, budget caps, and human override conflicts.
- Strict structured output, `:nitro`, `provider.require_parameters = true`.
- No `max_tokens` or `maxOutputTokens`.
- Quality score is a local heuristic: schema validity plus useful Swarm terms such as atomic reducers, budgets, events, idempotency, leases, and override handling.

Full two-round sweep:

| Model | Valid | p50 | p90 | p95 | Under 2s | Under 5s | Quality Avg | Est. Cost / Valid |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `openai/gpt-oss-120b:nitro` | 12/12 | 509 ms | 736 ms | 817 ms | 12/12 | 12/12 | 4.0 | $0.000109 |
| `z-ai/glm-4.7:nitro` | 12/12 | 705 ms | 910 ms | 945 ms | 12/12 | 12/12 | 5.1 | $0.000370 |
| `inception/mercury-2:nitro` | 11/12 | 1,089 ms | 1,253 ms | 1,253 ms | 11/12 | 11/12 | 5.5 | $0.000590 |
| `google/gemini-3.1-flash-lite:nitro` | 12/12 | 6,287 ms | 8,970 ms | 9,330 ms | 3/12 | 4/12 | 4.7 | $0.000315 |
| `x-ai/grok-4.3:nitro` | 12/12 | 3,291 ms | 3,540 ms | 3,742 ms | 0/12 | 12/12 | 5.1 | $0.002194 |
| `deepseek/deepseek-v4-flash:nitro` | 12/12 | 8,316 ms | 10,830 ms | 13,414 ms | 0/12 | 0/12 | 5.3 | $0.000193 |
| `arcee-ai/trinity-mini:nitro` | 11/12 | 3,690 ms | 4,869 ms | 4,869 ms | 0/12 | 11/12 | 4.4 | $0.000103 |
| `qwen/qwen3.6-flash:nitro` | 0/12 | n/a | n/a | n/a | 0/12 | 0/12 | 0.0 | n/a |

Top-three consistency pass, five rounds / 30 requests per model:

| Model | Valid | p50 | p90 | p95 | Max | Under 2s | Quality Avg | Est. Cost / Valid |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `openai/gpt-oss-120b:nitro` | 30/30 | 523 ms | 715 ms | 718 ms | 802 ms | 30/30 | 4.3 | $0.000115 |
| `z-ai/glm-4.7:nitro` | 30/30 | 627 ms | 745 ms | 760 ms | 909 ms | 30/30 | 5.0 | $0.000371 |
| `inception/mercury-2:nitro` | 28/30 | 943 ms | 1,171 ms | 1,327 ms | 1,514 ms | 28/30 | 4.3 | $0.000584 |

Decision:

- Default worker model: `openai/gpt-oss-120b:nitro`, pinned to Cerebras.
- High-quality/high-risk worker or reviewer: `z-ai/glm-4.7:nitro`, pinned to Cerebras.
- Tertiary fallback only: `inception/mercury-2:nitro`.
- Do not use `qwen/qwen3.6-flash:nitro` for reducer-writing paths until a repair layer is added.
- Avoid `deepseek/deepseek-v4-flash:nitro`, `x-ai/grok-4.3:nitro`, `arcee-ai/trinity-mini:nitro`, and `google/gemini-3.1-flash-lite:nitro` for the hot loop if the user-visible deadline is 2 seconds.

## Battle Combat Spot Check

Run date: Sunday, June 7, 2026.

Harness:

- Vercel AI SDK `generateObject`.
- Simple battle-action schema: action enum, rationale, confidence.
- `:nitro`, strict structured output, `provider.require_parameters = true`.
- Two requests per model, 15s local request timeout, no token cap.

| Model | Strict valid | Average valid latency | Note |
| --- | ---: | ---: | --- |
| `z-ai/glm-4.7:nitro` | 2/2 | 547 ms | Still the best command default. |
| `openai/gpt-oss-120b:nitro` | 2/2 | 782 ms | Still the best worker default. |
| `google/gemini-3.1-flash-lite:nitro` | 2/2 | 893 ms | Fast on simple combat, but slower in the complex sweep above. |
| `z-ai/glm-4.7-flash:nitro` | 1/2 | 2,020 ms | One 15s abort, so mark as risky. |
| `deepseek/deepseek-v4-flash:nitro` | 1/2 | 3,193 ms | One 15s abort, too inconsistent for defaults. |
| `google/gemini-3.5-flash:nitro` | 2/2 | 5,459 ms | Valid but too slow for live combat. |
| `openai/gpt-5.4-mini:nitro` | 0/2 | n/a | No route accepted strict structured output with `require_parameters`. |
| `openai/gpt-5.4-nano:nitro` | 0/2 | n/a | No route accepted strict structured output with `require_parameters`. |

## Pinned Provider Route Check

Run date: Sunday, June 7, 2026.

The user specifically called out `openai/gpt-oss-120b` on Groq and `z-ai/glm-4.7` on Cerebras. Both routes work with `:nitro`, strict JSON schema, `require_parameters`, no token cap, and `allow_fallbacks: false`.

Tiny raw battle-action schema:

| Route | Strict valid | Average | p50 | Max |
| --- | ---: | ---: | ---: | ---: |
| `openai/gpt-oss-120b:nitro` + Groq | 4/4 | 202 ms | 175 ms | 285 ms |
| `openai/gpt-oss-120b:nitro` + Cerebras | 4/4 | 228 ms | 165 ms | 362 ms |
| `z-ai/glm-4.7:nitro` + Cerebras | 4/4 | 230 ms | 200 ms | 328 ms |
| `z-ai/glm-4.7:nitro` + throughput default | 4/4 | 174 ms | 154 ms | 196 ms |

Actual runner `WorkerSchema` path:

| Route | Strict valid | Latencies | Average |
| --- | ---: | --- | ---: |
| `openai/gpt-oss-120b:nitro` + Groq | 3/3 | 1,097 ms, 1,120 ms, 1,144 ms | 1,120 ms |
| `z-ai/glm-4.7:nitro` + Cerebras | 3/3 | 334 ms, 535 ms, 381 ms | 417 ms |

Implementation decision: the runner pins `openai/gpt-oss-120b` to Groq and `z-ai/glm-4.7` to Cerebras in `runner/src/openrouter.ts`. Other models keep OpenRouter throughput sorting.

Product idea: expose a model picker as a timed race. Operators can try different models, but each worker call has a 2-second deadline. Results that arrive late can be shown as "missed deadline" rather than applied to the task tree. This makes model speed visible and keeps the swarm from feeling stuck.

## Request Shape

```ts
const responseFormat = {
  type: "json_schema",
  json_schema: {
    name: "swarm_worker_result",
    strict: true,
    schema: {
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
        confidence: { type: "string", enum: ["low", "medium", "high"] }
      },
      required: [
        "outcome",
        "result",
        "child_1",
        "child_2",
        "child_3",
        "child_4",
        "risk",
        "confidence"
      ]
    }
  }
} as const;

const body = {
  model: "z-ai/glm-4.7:nitro",
  messages,
  temperature: 0.1,
  stream: false,
  response_format: responseFormat,
  provider: {
    only: ["Cerebras"],
    allow_fallbacks: false,
    require_parameters: true
  },
  reasoning: {
    effort: "none",
    exclude: true
  }
};
```

Important: intentionally no `max_tokens`.

For the fast lane, use the same request shape with:

```ts
model: "openai/gpt-oss-120b:nitro"
```

## Reducer Boundary

Keep the LLM call outside SpacetimeDB. Reducers must stay deterministic. The Node agent client performs the network call, validates structured output, then submits the result to reducers.

SpacetimeDB enforces the real execution limits:

- Goal `max_depth`.
- Goal `max_tasks`.
- Task `attempts`.
- Agent heartbeat timeout.
- Human pause/cancel/redirect.
