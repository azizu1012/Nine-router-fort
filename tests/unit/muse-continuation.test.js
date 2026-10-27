import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildMuseContinuationBody,
  createMuseContinuationStream,
  detectMuseAnnouncementOnly,
  mergeMuseUsage,
  shouldContinueMuseResponse,
} from "../../open-sse/services/museContinuation.js";
import { MUSE_CONTINUATION } from "../../open-sse/config/museConstants.js";

const MODEL = "muse-spark-1.3-contributor";

function sseEvent(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamOf(text, chunkSize = 0) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      if (!chunkSize) {
        controller.enqueue(bytes);
      } else {
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          controller.enqueue(bytes.slice(offset, offset + chunkSize));
        }
      }
      controller.close();
    },
  });
}

async function collect(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseSse(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => {
      let event = null;
      const data = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      const raw = data.join("\n");
      if (!raw) return null;
      if (raw === "[DONE]") return { event: null, data: { done: true } };
      try {
        return { event, data: JSON.parse(raw) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const reasoning1 = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc_1" };
const message1 = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  content: [{ type: "output_text", text: "I'll check the repository now." }],
};
const call1 = {
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name: "shell",
  arguments: "{\"command\":\"ls\"}",
};
const reasoning2 = { type: "reasoning", id: "rs_2", summary: [], encrypted_content: "enc_2" };

const originalBody = {
  model: MODEL,
  stream: true,
  store: false,
  include: ["reasoning.encrypted_content"],
  tool_choice: "auto",
  tools: [{ type: "function", name: "shell", parameters: { type: "object", properties: {} } }],
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug" }] }],
};

const firstTurnSse = [
  sseEvent("response.output_item.done", {
    type: "response.output_item.done",
    output_index: 0,
    item: reasoning1,
  }),
  sseEvent("response.output_text.delta", {
    type: "response.output_text.delta",
    delta: "I'll check the repository now.",
  }),
  sseEvent("response.output_item.done", {
    type: "response.output_item.done",
    output_index: 1,
    item: message1,
  }),
  sseEvent("response.completed", {
    type: "response.completed",
    response: {
      status: "completed",
      output: [reasoning1, message1],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 4 },
        output_tokens_details: { reasoning_tokens: 3 },
      },
    },
  }),
  "data: [DONE]\n\n",
].join("");

const secondTurnSse = [
  sseEvent("response.created", {
    type: "response.created",
    response: { id: "resp_2", status: "in_progress" },
  }),
  sseEvent("response.output_item.done", {
    type: "response.output_item.done",
    output_index: 0,
    item: reasoning2,
  }),
  sseEvent("response.output_item.added", {
    type: "response.output_item.added",
    output_index: 1,
    item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "shell", arguments: "" },
  }),
  sseEvent("response.function_call_arguments.delta", {
    type: "response.function_call_arguments.delta",
    item_id: "fc_1",
    delta: "{\"command\":\"ls\"}",
  }),
  sseEvent("response.output_item.done", {
    type: "response.output_item.done",
    output_index: 1,
    item: call1,
  }),
  sseEvent("response.completed", {
    type: "response.completed",
    response: {
      status: "completed",
      output: [reasoning2, call1],
      usage: {
        input_tokens: 20,
        output_tokens: 7,
        total_tokens: 27,
        output_tokens_details: { reasoning_tokens: 2 },
      },
    },
  }),
  "data: [DONE]\n\n",
].join("");

function firstTurnWithToolSse() {
  return [
    sseEvent("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item: reasoning1,
    }),
    sseEvent("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 1,
      item: call1,
    }),
    sseEvent("response.completed", {
      type: "response.completed",
      response: { status: "completed", output: [reasoning1, call1] },
    }),
    "data: [DONE]\n\n",
  ].join("");
}

describe("Muse announce-then-stop detection", () => {
  it("detects a short future-action announcement", () => {
    expect(detectMuseAnnouncementOnly({ text: "I'll check the repository now." })).toBe(true);
    expect(detectMuseAnnouncementOnly({ text: "Let me verify the logs." })).toBe(true);
    expect(detectMuseAnnouncementOnly({ text: "Next, I'll run the tests." })).toBe(true);
    expect(detectMuseAnnouncementOnly({ text: "Tôi sẽ kiểm tra log." })).toBe(true);
  });

  it("never treats an actionable turn as an announcement", () => {
    expect(detectMuseAnnouncementOnly({ text: "I'll check the repo.", hasToolCall: true })).toBe(false);
  });

  it("does not retry a final answer with results or a hand-off", () => {
    expect(detectMuseAnnouncementOnly({
      text: "I'll check the repo. Found the issue: the cache key is wrong.",
    })).toBe(false);
    expect(detectMuseAnnouncementOnly({
      text: "I've updated the file and the tests pass.",
    })).toBe(false);
    expect(detectMuseAnnouncementOnly({
      text: "I'll check the tests if you want me to.",
    })).toBe(false);
    expect(detectMuseAnnouncementOnly({
      text: "Let me know if you need anything else.",
    })).toBe(false);
  });

  it("does not retry long text or code blocks", () => {
    expect(detectMuseAnnouncementOnly({
      text: `I'll check the file. ${"x".repeat(MUSE_CONTINUATION.maxAnnouncementChars)}`,
    })).toBe(false);
    expect(detectMuseAnnouncementOnly({
      text: "I'll check the file.\n```js\nconst x = 1;\n```",
    })).toBe(false);
  });
});

describe("Muse continuation request", () => {
  it("replays reasoning and appends a commentary message plus a nudge", () => {
    const next = buildMuseContinuationBody(
      { ...originalBody, previous_response_id: "resp_old" },
      {
        text: "I'll check the repository now.",
        reasoningItems: [
          { type: "reasoning", summary: [], encrypted_content: "enc_1" },
          { type: "reasoning", summary: [{ type: "summary_text", text: "plan" }], encrypted_content: "enc_2" },
        ],
      }
    );

    expect(next.previous_response_id).toBeUndefined();
    expect(next.stream).toBe(true);
    expect(next.input[0]).toEqual(originalBody.input[0]);
    expect(next.input.at(-4)).toEqual({
      type: "reasoning",
      summary: [],
      encrypted_content: "enc_1",
    });
    expect(next.input.at(-3)).toEqual({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "plan" }],
      encrypted_content: "enc_2",
    });
    expect(next.input.at(-2)).toMatchObject({
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: "I'll check the repository now." }],
    });
    expect(next.input.at(-1)).toMatchObject({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: MUSE_CONTINUATION.nudge }],
    });
  });

  it("does not build a continuation without assistant text", () => {
    expect(buildMuseContinuationBody(originalBody, { text: "   " })).toBeNull();
  });

  it("sums usage from both calls", () => {
    expect(mergeMuseUsage(
      { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } },
      { input_tokens: 20, output_tokens: 7, output_tokens_details: { reasoning_tokens: 2 } }
    )).toEqual({
      input_tokens: 30,
      output_tokens: 12,
      total_tokens: 42,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens_details: { reasoning_tokens: 2 },
    });
  });
});

describe("Muse continuation eligibility", () => {
  const base = () => ({
    provider: "muse",
    args: { stream: true, credentials: {} },
    result: {
      transformedBody: {
        ...originalBody,
        input: [...originalBody.input],
      },
      response: { body: new ReadableStream() },
    },
  });

  afterEach(() => {
    delete process.env.MUSE_CONTINUATION;
  });

  it("enables continuation for translated Muse clients with tools", () => {
    expect(shouldContinueMuseResponse(base())).toBe(true);
  });

  it("never wraps native Responses clients", () => {
    const input = base();
    input.args.credentials._museContinuationEligible = false;
    expect(shouldContinueMuseResponse(input)).toBe(false);
  });

  it("requires tools, streaming, and stateless replay", () => {
    const noTools = base();
    delete noTools.result.transformedBody.tools;
    expect(shouldContinueMuseResponse(noTools)).toBe(false);

    const noStream = base();
    noStream.args.stream = false;
    expect(shouldContinueMuseResponse(noStream)).toBe(false);

    const previous = base();
    previous.result.transformedBody.previous_response_id = "resp_old";
    expect(shouldContinueMuseResponse(previous)).toBe(false);

    const noChoice = base();
    noChoice.result.transformedBody.tool_choice = "none";
    expect(shouldContinueMuseResponse(noChoice)).toBe(false);

    const otherProvider = base();
    otherProvider.provider = "opencode";
    expect(shouldContinueMuseResponse(otherProvider)).toBe(false);
  });

  it("honors the MUSE_CONTINUATION kill switch", () => {
    process.env.MUSE_CONTINUATION = "0";
    expect(shouldContinueMuseResponse(base())).toBe(false);
  });
});

describe("Muse continuation stream", () => {
  it("suppresses the announce-only terminal and merges the tool-call retry", async () => {
    const retry = vi.fn(async () => new Response(streamOf(secondTurnSse, 13), {
      headers: { "content-type": "text/event-stream" },
    }));

    const output = await collect(
      streamOf(firstTurnSse, 11).pipeThrough(
        createMuseContinuationStream({ body: originalBody, retry })
      )
    );

    expect(retry).toHaveBeenCalledTimes(1);
    const retryBody = retry.mock.calls[0][0];
    expect(retryBody.input.at(-2)).toMatchObject({
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: "I'll check the repository now." }],
    });
    expect(retryBody.input.at(-1).content[0].text).toContain("Continue now");
    expect(retryBody.input).toContainEqual({
      type: "reasoning",
      id: "rs_1",
      summary: [],
      encrypted_content: "enc_1",
    });

    const blocks = parseSse(output);
    const completed = blocks.filter((block) => block.event === "response.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0].data.response.output.map((item) => item.call_id || item.id)).toEqual([
      "rs_1",
      "msg_1",
      "rs_2",
      "call_1",
    ]);
    expect(completed[0].data.response.usage).toEqual({
      input_tokens: 30,
      output_tokens: 12,
      total_tokens: 42,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens_details: { reasoning_tokens: 5 },
    });

    expect((output.match(/\[DONE\]/g) || []).length).toBe(1);
    // The announcement streams once as a text delta; it also appears in the
    // item.done and merged terminal events, which is normal Responses framing.
    expect((output.match(/event: response\.output_text\.delta/g) || []).length).toBe(1);
    expect(output).toContain("event: response.function_call_arguments.delta");
  });

  it("does not retry a turn that already called a tool", async () => {
    const retry = vi.fn();
    const output = await collect(
      streamOf(firstTurnWithToolSse()).pipeThrough(
        createMuseContinuationStream({ body: originalBody, retry })
      )
    );

    expect(retry).not.toHaveBeenCalled();
    const completed = parseSse(output).filter((block) => block.event === "response.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0].data.response.output.map((item) => item.call_id || item.id)).toEqual(["rs_1", "call_1"]);
    expect(output).toContain("[DONE]");
  });

  it("does not retry a final answer", async () => {
    const finalSse = [
      sseEvent("response.output_text.delta", {
        type: "response.output_text.delta",
        delta: "I've checked the repository. The fix is in place.",
      }),
      sseEvent("response.completed", {
        type: "response.completed",
        response: {
          status: "completed",
          output: [{
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I've checked the repository. The fix is in place." }],
          }],
        },
      }),
      "data: [DONE]\n\n",
    ].join("");
    const retry = vi.fn();
    const output = await collect(
      streamOf(finalSse).pipeThrough(createMuseContinuationStream({ body: originalBody, retry }))
    );

    expect(retry).not.toHaveBeenCalled();
    expect(output).toContain("The fix is in place.");
    expect(output).toContain("[DONE]");
  });

  it("falls back to the first terminal when the retry fails", async () => {
    const retry = vi.fn(async () => {
      throw new Error("HTTP 500");
    });
    const output = await collect(
      streamOf(firstTurnSse).pipeThrough(
        createMuseContinuationStream({ body: originalBody, retry })
      )
    );

    const completed = parseSse(output).filter((block) => block.event === "response.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0].data.response.output.map((item) => item.id)).toEqual(["rs_1", "msg_1"]);
    expect(output).toContain("[DONE]");
  });

  it("does not retry after the client aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const retry = vi.fn();
    const output = await collect(
      streamOf(firstTurnSse).pipeThrough(
        createMuseContinuationStream({ body: originalBody, retry, signal: controller.signal })
      )
    );

    expect(retry).not.toHaveBeenCalled();
    expect(output).toContain("event: response.completed");
    expect(output).toContain("[DONE]");
  });
});
