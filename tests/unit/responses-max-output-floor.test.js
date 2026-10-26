/**
 * Responses `max_output_tokens` floor (Meta Muse probe 400).
 *
 * Health-check probes send max_tokens: 1 to save quota. On Responses-wire
 * models (Muse Spark, opencode families) that maps 1:1 to max_output_tokens,
 * and strict upstreams (Meta api.meta.ai) reject anything < 16 with
 * HTTP 400 "`max_output_tokens` The number must be `>= 16`".
 *
 * The translator + executors clamp tiny-but-present values up to 16 so a
 * probe passes instead of knocking the model out of rotation.
 */
import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import {
  clampResponsesMaxOutputTokens,
  MIN_RESPONSES_MAX_OUTPUT_TOKENS,
} from "../../open-sse/translator/formats/responsesApi.js";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { OpenCodeGoExecutor } from "../../open-sse/executors/opencode-go.js";

const MODEL = "muse-spark-1.3-contributor";

function chatBody(maxTokens) {
  return {
    messages: [{ role: "user", content: "hi" }],
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
  };
}

describe("clampResponsesMaxOutputTokens", () => {
  it("raises tiny values to the upstream floor", () => {
    expect(MIN_RESPONSES_MAX_OUTPUT_TOKENS).toBe(16);
    expect(clampResponsesMaxOutputTokens({ max_output_tokens: 1 }).max_output_tokens).toBe(16);
    expect(clampResponsesMaxOutputTokens({ max_output_tokens: 15 }).max_output_tokens).toBe(16);
    expect(clampResponsesMaxOutputTokens({ max_output_tokens: 0 }).max_output_tokens).toBe(16);
  });

  it("leaves normal values and absent caps alone", () => {
    expect(clampResponsesMaxOutputTokens({ max_output_tokens: 16 }).max_output_tokens).toBe(16);
    expect(clampResponsesMaxOutputTokens({ max_output_tokens: 4096 }).max_output_tokens).toBe(4096);
    expect(clampResponsesMaxOutputTokens({}).max_output_tokens).toBeUndefined();
    expect(clampResponsesMaxOutputTokens(null)).toBeNull();
  });
});

describe("openai → responses translation applies the floor", () => {
  it("clamps a probe max_tokens: 1 to 16", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, MODEL, chatBody(1), true);
    expect(out.max_output_tokens).toBe(16);
    expect(out.max_tokens).toBeUndefined();
  });

  it("clamps max_completion_tokens: 1 to 16", () => {
    const out = translateRequest(
      FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, MODEL,
      { messages: [{ role: "user", content: "hi" }], max_completion_tokens: 1 }, true,
    );
    expect(out.max_output_tokens).toBe(16);
  });

  it("passes normal caps through untouched", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, MODEL, chatBody(4096), true);
    expect(out.max_output_tokens).toBe(4096);
  });

  it("leaves an absent cap absent", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, MODEL, chatBody(undefined), true);
    expect(out.max_output_tokens).toBeUndefined();
  });
});

describe("claude → responses chain (probe path) applies the floor", () => {
  it("clamps a Claude probe max_tokens: 1 to 16", () => {
    const out = translateRequest(
      FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, MODEL,
      { model: MODEL, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }, true,
    );
    expect(out.max_output_tokens).toBe(16);
  });
});

describe("opencode-go executor applies the floor", () => {
  it("clamps max_tokens: 1 carried on the translated body", () => {
    const ex = new OpenCodeGoExecutor();
    const out = ex.transformRequest(MODEL, {
      model: MODEL,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      max_tokens: 1,
    }, true, {});
    expect(out.max_output_tokens).toBe(16);
    expect(out.max_tokens).toBeUndefined();
  });
});
