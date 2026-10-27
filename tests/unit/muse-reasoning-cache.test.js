/**
 * Server-side Muse reasoning continuity.
 *
 * Meta returns encrypted reasoning only on the Responses wire. Claude/OpenAI
 * clients cannot echo that field, so the router has to remember it per
 * conversation and replay it with the next turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetMuseReasoningCache,
  buildMuseTurnFingerprint,
  recallMuseReasoning,
  rememberMuseReasoning,
  resolveMuseReasoningSession,
} from "../../open-sse/services/museReasoningCache.js";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const SESSION = "session-1";
const MODEL = "muse-spark-1.3";

const output = () => [
  {
    type: "reasoning",
    id: "rs_1",
    summary: [],
    encrypted_content: "enc_turn_1",
  },
  {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "I'll inspect the repo." }],
  },
  {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "shell",
    arguments: "{\"command\":\"ls\"}",
  },
];

const chatTurn = (overrides = {}) => ({
  role: "assistant",
  content: "I'll inspect the repo.",
  tool_calls: [
    {
      id: "call_1",
      type: "function",
      function: { name: "shell", arguments: "{\n  \"command\": \"ls\"\n}" },
    },
  ],
  ...overrides,
});

function captureStreamTurn(overrides = {}) {
  const state = {
    provider: "muse",
    model: MODEL,
    sessionId: SESSION,
    sourceFormat: FORMATS.OPENAI,
    ...overrides,
  };
  openaiResponsesToOpenAIResponse(
    {
      type: "response.completed",
      response: { status: "completed", output: output() },
    },
    state
  );
  return state;
}

function translateWithCache(messages, credentials = { _museReasoningSession: SESSION }) {
  return openaiToOpenAIResponsesRequest(MODEL, { messages }, true, credentials, "muse");
}

describe("Muse reasoning cache", () => {
  beforeEach(() => {
    _resetMuseReasoningCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetMuseReasoningCache();
  });

  it("captures encrypted reasoning from a streaming Responses turn", () => {
    captureStreamTurn();
    const fingerprint = buildMuseTurnFingerprint(chatTurn());
    const cached = recallMuseReasoning({
      model: MODEL,
      sessionId: SESSION,
      fingerprint,
    });

    expect(cached).toHaveLength(1);
    expect(cached[0].type).toBe("reasoning");
    expect(cached[0].encrypted_content).toBe("enc_turn_1");
    expect(cached[0].summary).toEqual([]);
  });

  it("captures from output_item.done when the terminal event omits output", () => {
    const state = { provider: "muse", model: MODEL, sessionId: SESSION, sourceFormat: FORMATS.OPENAI };
    output().forEach((item, index) => {
      openaiResponsesToOpenAIResponse(
        { type: "response.output_item.done", output_index: index, item },
        state
      );
    });
    openaiResponsesToOpenAIResponse(
      { type: "response.completed", response: { status: "completed" } },
      state
    );

    const cached = recallMuseReasoning({
      model: MODEL,
      sessionId: SESSION,
      fingerprint: buildMuseTurnFingerprint(chatTurn()),
    });
    expect(cached?.[0]?.encrypted_content).toBe("enc_turn_1");
  });

  it("assigns the conversation-scoped session during translateRequest", () => {
    const credentials = {};
    translateRequest(
      "openai",
      "openai-responses",
      MODEL,
      { messages: [{ role: "user", content: "fix the bug" }] },
      true,
      credentials,
      "muse",
      null,
      [],
      "connection-1"
    );

    expect(typeof credentials._museReasoningSession).toBe("string");
    expect(credentials._museReasoningSession).toContain("::");
  });

  it("captures through the real SSE transform pipeline", async () => {
    const encoder = new TextEncoder();
    const events = [
      ...output().map((item, index) => ({
        event: "response.output_item.done",
        data: { type: "response.output_item.done", output_index: index, item },
      })),
      {
        event: "response.completed",
        data: { type: "response.completed", response: { status: "completed", output: output() } },
      },
    ];
    const raw = events
      .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      .join("") + "data: [DONE]\n\n";

    const input = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(raw));
        controller.close();
      },
    });
    const transformed = input.pipeThrough(
      createSSETransformStreamWithLogger(
        FORMATS.OPENAI_RESPONSES,
        FORMATS.OPENAI,
        "muse",
        null,
        null,
        MODEL,
        "connection-1",
        null,
        null,
        null,
        null,
        { _museReasoningSession: SESSION }
      )
    );
    const reader = transformed.getReader();
    while (!(await reader.read()).done) { /* drain */ }

    const cached = recallMuseReasoning({
      model: MODEL,
      sessionId: SESSION,
      fingerprint: buildMuseTurnFingerprint(chatTurn()),
    });
    expect(cached?.[0]?.encrypted_content).toBe("enc_turn_1");
  });

  it("replays cached reasoning before the matching assistant turn", () => {
    captureStreamTurn();
    const out = translateWithCache([
      { role: "user", content: "fix the bug" },
      chatTurn(),
      { role: "tool", tool_call_id: "call_1", content: "ok" },
      { role: "user", content: "continue" },
    ]);

    const reasoning = out.input.find((item) => item.type === "reasoning");
    expect(reasoning?.encrypted_content).toBe("enc_turn_1");
    expect(out.input.indexOf(reasoning)).toBeLessThan(
      out.input.findIndex((item) => item.type === "message" && item.role === "assistant")
    );
  });

  it("matches turns even when tool-call JSON is re-serialized", () => {
    captureStreamTurn();
    const out = translateWithCache([
      { role: "user", content: "fix the bug" },
      chatTurn({ tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: "{\"command\":\"ls\"}" } }] }),
    ]);

    expect(out.input.some((item) => item.type === "reasoning")).toBe(true);
  });

  it("prefers client-supplied encrypted reasoning over the cache", () => {
    captureStreamTurn();
    const out = translateWithCache([
      { role: "user", content: "fix the bug" },
      chatTurn({ encrypted_content: "client_blob" }),
    ]);

    const reasoning = out.input.find((item) => item.type === "reasoning");
    expect(reasoning.encrypted_content).toBe("client_blob");
  });

  it("keeps a client reasoning summary when the cache has no match", () => {
    const out = translateWithCache([
      { role: "user", content: "fix the bug" },
      chatTurn({ reasoning_content: "client plan" }),
    ]);

    const reasoning = out.input.find((item) => item.type === "reasoning");
    expect(reasoning.encrypted_content).toBeUndefined();
    expect(reasoning.summary).toEqual([{ type: "summary_text", text: "client plan" }]);
  });

  it("does not replay a turn whose visible text changed", () => {
    captureStreamTurn();
    const out = translateWithCache([
      { role: "user", content: "fix the bug" },
      chatTurn({ content: "I'll do something else." }),
    ]);

    expect(out.input.some((item) => item.type === "reasoning")).toBe(false);
  });

  it("isolates sessions and models", () => {
    captureStreamTurn();

    const otherSession = translateWithCache(
      [{ role: "user", content: "fix the bug" }, chatTurn()],
      { _museReasoningSession: "other-session" }
    );
    expect(otherSession.input.some((item) => item.type === "reasoning")).toBe(false);

    const otherModel = openaiToOpenAIResponsesRequest(
      "muse-spark-1.2",
      { messages: [{ role: "user", content: "fix the bug" }, chatTurn()] },
      true,
      { _museReasoningSession: SESSION },
      "muse"
    );
    expect(otherModel.input.some((item) => item.type === "reasoning")).toBe(false);
  });

  it("never replays on a non-Muse provider", () => {
    captureStreamTurn();
    const out = openaiToOpenAIResponsesRequest(
      MODEL,
      { messages: [{ role: "user", content: "fix the bug" }, chatTurn()] },
      true,
      { _museReasoningSession: SESSION },
      "openai"
    );
    expect(out.input.some((item) => item.type === "reasoning")).toBe(false);
  });

  it("expires entries after the TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    captureStreamTurn();

    vi.setSystemTime(new Date("2026-01-01T03:00:01Z"));
    const out = translateWithCache([
      { role: "user", content: "fix the bug" },
      chatTurn(),
    ]);
    expect(out.input.some((item) => item.type === "reasoning")).toBe(false);
  });

  it("separates conversations that share one connection-level session", () => {
    captureStreamTurn();
    const base = "connection-session";
    const first = resolveMuseReasoningSession({
      baseSessionId: base,
      body: { messages: [{ role: "user", content: "conversation A" }] },
    });
    const second = resolveMuseReasoningSession({
      baseSessionId: base,
      body: { messages: [{ role: "user", content: "conversation B" }] },
    });

    expect(first).not.toBe(second);
    expect(resolveMuseReasoningSession({
      baseSessionId: base,
      body: { messages: [{ role: "user", content: "conversation A" }, chatTurn()] },
    })).toBe(first);
  });

  it("maps non-stream incomplete responses to a valid Chat finish reason", () => {
    const translated = translateNonStreamingResponse(
      {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "partial" }],
          },
        ],
      },
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI
    );

    expect(translated.choices[0].finish_reason).toBe("length");
  });

  it("keeps tool_calls when an incomplete response also called a tool", () => {
    const translated = translateNonStreamingResponse(
      {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "shell",
            arguments: "{}",
          },
        ],
      },
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI
    );

    expect(translated.choices[0].finish_reason).toBe("tool_calls");
  });
});
