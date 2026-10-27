/**
 * Muse Spark (Meta) Responses wire correctness.
 *
 * Meta's Responses API is stricter than OpenAI's:
 *   - every replayed `reasoning` item needs `summary` (empty array is valid);
 *   - assistant text before a function_call needs `phase: "commentary"`;
 *   - `tool_choice` accepts only "auto" — "none" means "remove the tools";
 *   - `response.incomplete` is a terminal event, not a successful stop.
 *
 * The quirks are scoped to the direct `muse` provider id so aggregator lanes
 * (opencode/opencode-go/opencode-zen) keep their own dialect.
 */
import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";

import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { isOpenAIResponsesTerminalEvent } from "../../open-sse/utils/responsesStreamHelpers.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { RESPONSES_INCLUDE } from "../../open-sse/translator/formats/responsesApi.js";
import { MUSE_TOOL_USE_DIRECTIVE } from "../../open-sse/config/museConstants.js";

const TOOL = {
  type: "function",
  function: {
    name: "shell",
    description: "Run a shell command",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
};

const assistantWithTool = {
  role: "assistant",
  content: "I'll check the repo first.",
  tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: "{}" } }],
};

function responsesBody(overrides = {}) {
  return {
    messages: [
      { role: "user", content: "fix the bug" },
      assistantWithTool,
      { role: "tool", tool_call_id: "call_1", content: "ok" },
      { role: "user", content: "continue" },
    ],
    tools: [TOOL],
    ...overrides,
  };
}

describe("Muse reasoning replay shape", () => {
  it("emits summary: [] when only encrypted_content survives", () => {
    const out = openaiToOpenAIResponsesRequest(
      "muse-spark-1.3",
      {
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: null,
            encrypted_content: "enc_blob",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: "{}" } }],
          },
        ],
      },
      true,
      null,
      "muse"
    );

    const reasoning = out.input.find((item) => item.type === "reasoning");
    expect(reasoning).toBeTruthy();
    expect(reasoning.encrypted_content).toBe("enc_blob");
    expect(reasoning.summary).toEqual([]);
  });

  it("keeps summary text when the client also replayed reasoning_content", () => {
    const out = openaiToOpenAIResponsesRequest(
      "muse-spark-1.3",
      {
        messages: [
          {
            role: "assistant",
            content: "done",
            reasoning_content: "plan",
            encrypted_content: "enc_blob",
          },
        ],
      },
      true,
      null,
      "muse"
    );

    const reasoning = out.input.find((item) => item.type === "reasoning");
    expect(reasoning.summary).toEqual([{ type: "summary_text", text: "plan" }]);
  });
});

describe("Muse commentary phase", () => {
  it("marks assistant text that precedes a function_call", () => {
    const out = openaiToOpenAIResponsesRequest("muse-spark-1.3", responsesBody(), true, null, "muse");
    const message = out.input.find((item) => item.type === "message" && item.role === "assistant");
    expect(message.phase).toBe("commentary");
  });

  it("does not mark a final assistant message without tool calls", () => {
    const out = openaiToOpenAIResponsesRequest(
      "muse-spark-1.3",
      { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] },
      true,
      null,
      "muse"
    );
    const message = out.input.find((item) => item.type === "message" && item.role === "assistant");
    expect(message.phase).toBeUndefined();
  });

  it("leaves non-Muse Responses providers untouched", () => {
    const out = openaiToOpenAIResponsesRequest("gpt-5.5", responsesBody(), true, null, "openai");
    const message = out.input.find((item) => item.type === "message" && item.role === "assistant");
    expect(message.phase).toBeUndefined();
  });

  it("receives the provider through translateRequest", () => {
    const out = translateRequest("openai", "openai-responses", "muse-spark-1.3", responsesBody(), true, {}, "muse");
    const message = out.input.find((item) => item.type === "message" && item.role === "assistant");
    expect(message.phase).toBe("commentary");
  });
});

describe("Muse tool_choice dialect", () => {
  it("turns none into 'no tools' instead of auto", () => {
    const out = openaiToOpenAIResponsesRequest(
      "muse-spark-1.3",
      responsesBody({ tool_choice: "none", parallel_tool_calls: true }),
      true,
      null,
      "muse"
    );

    expect(out.tools).toBeUndefined();
    expect(out.tool_choice).toBeUndefined();
    expect(out.parallel_tool_calls).toBeUndefined();
  });

  it("downgrades required to auto and keeps the tools", () => {
    const out = openaiToOpenAIResponsesRequest(
      "muse-spark-1.3",
      responsesBody({ tool_choice: "required" }),
      true,
      null,
      "muse"
    );

    expect(out.tool_choice).toBe("auto");
    expect(out.tools).toHaveLength(1);
  });

  it("downgrades a forced function to auto and keeps the tools", () => {
    const out = openaiToOpenAIResponsesRequest(
      "muse-spark-1.3",
      responsesBody({ tool_choice: { type: "function", function: { name: "shell" } } }),
      true,
      null,
      "muse"
    );

    expect(out.tool_choice).toBe("auto");
    expect(out.tools).toHaveLength(1);
  });

  it("keeps auto and parallel_tool_calls intact", () => {
    const out = openaiToOpenAIResponsesRequest(
      "muse-spark-1.3",
      responsesBody({ tool_choice: "auto", parallel_tool_calls: true }),
      true,
      null,
      "muse"
    );

    expect(out.tool_choice).toBe("auto");
    expect(out.parallel_tool_calls).toBe(true);
    expect(out.tools).toHaveLength(1);
  });

  it("forwards tool_choice and parallel_tool_calls for non-Muse providers", () => {
    const out = openaiToOpenAIResponsesRequest(
      "gpt-5.5",
      responsesBody({ tool_choice: "none", parallel_tool_calls: true }),
      true,
      null,
      "openai"
    );

    expect(out.tool_choice).toBe("none");
    expect(out.parallel_tool_calls).toBe(true);
    expect(out.tools).toHaveLength(1);
  });

  it("normalizes a native Responses body too", () => {
    const out = openaiToOpenAIResponsesRequest(
      "muse-spark-1.3",
      {
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        tools: [{ type: "function", name: "shell", parameters: { type: "object", properties: {} } }],
        tool_choice: "none",
        parallel_tool_calls: true,
      },
      true,
      null,
      "muse"
    );

    expect(out.tools).toBeUndefined();
    expect(out.tool_choice).toBeUndefined();
    expect(out.parallel_tool_calls).toBeUndefined();
  });

  it("enforces Muse rules when source and target are both Responses", () => {
    const base = () => ({
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [{ type: "function", name: "shell", parameters: { type: "object", properties: {} } }],
      instructions: "existing instructions",
    });

    const forced = translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI_RESPONSES,
      "muse-spark-1.3",
      { ...base(), tool_choice: "required", parallel_tool_calls: true },
      true,
      null,
      "muse"
    );
    expect(forced.tool_choice).toBe("auto");
    expect(forced.parallel_tool_calls).toBe(true);
    expect(forced.tools).toHaveLength(1);
    expect(forced.instructions).toContain("existing instructions");
    expect(forced.instructions).toContain(MUSE_TOOL_USE_DIRECTIVE);

    const none = translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI_RESPONSES,
      "muse-spark-1.3",
      { ...base(), tool_choice: "none", parallel_tool_calls: true },
      true,
      null,
      "muse"
    );
    expect(none.tool_choice).toBeUndefined();
    expect(none.tools).toBeUndefined();
    expect(none.parallel_tool_calls).toBeUndefined();
    expect(none.instructions).not.toContain(MUSE_TOOL_USE_DIRECTIVE);
  });
});

describe("Muse encrypted reasoning include", () => {
  const responsesInput = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];

  it("asks for reasoning.encrypted_content on the stateless Muse path", () => {
    const executor = new DefaultExecutor("muse");
    const out = executor.transformRequest(
      "muse-spark-1.3-contributor",
      { model: "muse-spark-1.3-contributor", input: responsesInput, store: false },
      true,
      {}
    );

    expect(out.include).toContain(RESPONSES_INCLUDE.REASONING_ENCRYPTED_CONTENT);
    expect(out.store).toBe(false);
  });

  it("merges with an existing include list without duplicating", () => {
    const executor = new DefaultExecutor("muse");
    const out = executor.transformRequest(
      "muse-spark-1.3-contributor",
      {
        model: "muse-spark-1.3-contributor",
        input: responsesInput,
        store: false,
        include: ["reasoning.encrypted_content", "other"],
      },
      true,
      {}
    );

    expect(out.include).toEqual(["reasoning.encrypted_content", "other"]);
  });

  it("does not combine include with previous_response_id", () => {
    const executor = new DefaultExecutor("muse");
    const out = executor.transformRequest(
      "muse-spark-1.3-contributor",
      {
        model: "muse-spark-1.3-contributor",
        input: responsesInput,
        store: false,
        previous_response_id: "resp_1",
      },
      true,
      {}
    );

    expect(out.include).toBeUndefined();
  });

  it("leaves other providers alone", () => {
    const executor = new DefaultExecutor("openai");
    const out = executor.transformRequest(
      "gpt-5.5",
      { model: "gpt-5.5", input: responsesInput, store: false },
      true,
      {}
    );

    expect(out.include).toBeUndefined();
  });
});

describe("Muse tool-use guidance", () => {
  it("appends the act-now directive when tools are available", () => {
    const out = openaiToOpenAIResponsesRequest(
      "muse-spark-1.3",
      {
        ...responsesBody(),
        messages: [
          { role: "system", content: "Be helpful." },
          { role: "user", content: "fix the bug" },
          assistantWithTool,
          { role: "tool", tool_call_id: "call_1", content: "ok" },
          { role: "user", content: "continue" },
        ],
      },
      true,
      null,
      "muse"
    );

    expect(out.instructions).toContain("Be helpful.");
    expect(out.instructions).toContain(MUSE_TOOL_USE_DIRECTIVE);
  });

  it("does not add the directive when the caller removed tools", () => {
    const out = openaiToOpenAIResponsesRequest(
      "muse-spark-1.3",
      responsesBody({ tool_choice: "none" }),
      true,
      null,
      "muse"
    );

    expect(out.instructions || "").not.toContain(MUSE_TOOL_USE_DIRECTIVE);
  });

  it("does not add the directive without tools", () => {
    const out = openaiToOpenAIResponsesRequest(
      "muse-spark-1.3",
      { messages: [{ role: "user", content: "hi" }] },
      true,
      null,
      "muse"
    );

    expect(out.instructions || "").not.toContain(MUSE_TOOL_USE_DIRECTIVE);
  });

  it("keeps non-Muse providers untouched", () => {
    const out = openaiToOpenAIResponsesRequest("gpt-5.5", responsesBody(), true, null, "openai");
    expect(out.instructions || "").not.toContain(MUSE_TOOL_USE_DIRECTIVE);
  });

  it("is idempotent when the client already sent the directive", () => {
    const out = openaiToOpenAIResponsesRequest(
      "muse-spark-1.3",
      responsesBody({ messages: [{ role: "system", content: MUSE_TOOL_USE_DIRECTIVE }, { role: "user", content: "go" }] }),
      true,
      null,
      "muse"
    );

    const occurrences = out.instructions.split(MUSE_TOOL_USE_DIRECTIVE).length - 1;
    expect(occurrences).toBe(1);
  });

  it("also guides a native Responses body", () => {
    const out = openaiToOpenAIResponsesRequest(
      "muse-spark-1.3",
      {
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }],
        tools: [{ type: "function", name: "shell", parameters: { type: "object", properties: {} } }],
      },
      true,
      null,
      "muse"
    );

    expect(out.instructions).toContain(MUSE_TOOL_USE_DIRECTIVE);
  });
});

describe("Responses incomplete is terminal and truncating", () => {
  it("maps response.incomplete/max_output_tokens to length", () => {
    const state = {};
    const out = openaiResponsesToOpenAIResponse(
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      },
      state
    );

    expect(out.choices[0].finish_reason).toBe("length");
    expect(state.finishReason).toBe("length");
    expect(state.usage).toBeTruthy();
  });

  it("maps response.completed carrying status incomplete to length", () => {
    const state = {};
    const out = openaiResponsesToOpenAIResponse(
      {
        type: "response.completed",
        response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
      },
      state
    );

    expect(out.choices[0].finish_reason).toBe("length");
  });

  it("maps a content_filter truncation to content_filter", () => {
    const state = {};
    const out = openaiResponsesToOpenAIResponse(
      {
        type: "response.incomplete",
        response: { status: "incomplete", incomplete_details: { reason: "content_filter" } },
      },
      state
    );

    expect(out.choices[0].finish_reason).toBe("content_filter");
  });

  it("still reports tool_calls when the turn called a tool", () => {
    const state = {};
    openaiResponsesToOpenAIResponse(
      {
        type: "response.output_item.added",
        item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "shell" },
      },
      state
    );
    const out = openaiResponsesToOpenAIResponse(
      {
        type: "response.incomplete",
        response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
      },
      state
    );

    expect(out.choices[0].finish_reason).toBe("tool_calls");
  });

  it("treats response.incomplete as a terminal stream event", () => {
    expect(isOpenAIResponsesTerminalEvent("response.incomplete", { type: "response.incomplete" })).toBe(true);
    expect(isOpenAIResponsesTerminalEvent(null, { response: { status: "incomplete" } })).toBe(true);
  });
});
