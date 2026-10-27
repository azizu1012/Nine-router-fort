/**
 * Bounded Muse (Meta) announce-then-stop recovery.
 *
 * Muse 1.3 sometimes ends a turn with only "I'll now ..." and no tool call.
 * Meta only accepts `tool_choice: "auto"`, so the router cannot force the call
 * on the wire. The best it can do is replay the turn's own reasoning + text and
 * ask the model to carry the announced action out, once, in the same client
 * stream. This module does that at the upstream SSE level:
 *
 *   first response (announcement) -> suppress terminal -> second response
 *   (tool call) -> merge output/usage -> one terminal for the client.
 *
 * It never runs for native Responses clients (their turn loop is their own) and
 * fails open: if the retry cannot be made, the first turn's terminal is emitted
 * untouched, so the client behaves exactly as it did before this module.
 */
import { MUSE_PROVIDER_ID } from "../config/providerIds.js";
import {
  MUSE_ANNOUNCEMENT_EN,
  MUSE_ANNOUNCEMENT_RESULT,
  MUSE_ANNOUNCEMENT_VI,
  MUSE_ANNOUNCEMENT_WAIT,
  MUSE_CONTINUATION,
  isMuseContinuationEnabled,
} from "../config/museConstants.js";
import { RESPONSES_ITEM, RESPONSES_MESSAGE_PHASE, ROLE } from "../translator/schema/index.js";

const encoder = new TextEncoder();
const BLOCK_BOUNDARY = /\r?\n\r?\n/;

const ACTION_ITEM_TYPES = new Set([
  RESPONSES_ITEM.FUNCTION_CALL,
  RESPONSES_ITEM.CUSTOM_TOOL_CALL,
  "web_search_call",
  "file_search_call",
  "computer_call",
  "local_shell_call",
  "code_interpreter_call",
  "image_generation_call",
  "mcp_call",
]);

// Lifecycle-only events carry no client-visible content; forwarding one before a
// failed retry still leaves room to fall back to the first turn's terminal.
const MUSE_LIFECYCLE_EVENTS = new Set(["response.created", "response.in_progress"]);

function isActionItem(item) {
  return Boolean(item && ACTION_ITEM_TYPES.has(item.type));
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (typeof part === "string") text += part;
    else if (typeof part?.text === "string") text += part.text;
  }
  return text;
}

function outputText(output) {
  if (!Array.isArray(output)) return "";
  let text = "";
  for (const item of output) {
    if (item?.type === RESPONSES_ITEM.MESSAGE) text += contentText(item.content);
  }
  return text;
}

function itemText(item) {
  return item?.type === RESPONSES_ITEM.MESSAGE ? contentText(item.content) : "";
}

function normalizeReasoningItem(item) {
  const summary = Array.isArray(item.summary)
    ? item.summary
      .filter((part) => part && typeof part.text === "string")
      .map((part) => ({ type: RESPONSES_ITEM.SUMMARY_TEXT, text: part.text }))
    : [];
  const normalized = {
    type: RESPONSES_ITEM.REASONING,
    summary,
    encrypted_content: item.encrypted_content,
  };
  if (typeof item.id === "string" && item.id) normalized.id = item.id;
  return normalized;
}

function nestedNumber(value, path) {
  let current = value;
  for (const key of path.split(".")) current = current?.[key];
  return Number.isFinite(current) ? current : 0;
}

function firstNumber(value, keys) {
  for (const key of keys) {
    if (Number.isFinite(value?.[key])) return value[key];
  }
  return 0;
}

/** Sum usage from both responses. The retry re-sends the prompt, so both calls are billed. */
export function mergeMuseUsage(left, right) {
  if (!left && !right) return null;
  const input = firstNumber(left, ["input_tokens", "prompt_tokens"]) + firstNumber(right, ["input_tokens", "prompt_tokens"]);
  const output = firstNumber(left, ["output_tokens", "completion_tokens"]) + firstNumber(right, ["output_tokens", "completion_tokens"]);
  if (input + output <= 0) return right || left;

  const usage = { input_tokens: input, output_tokens: output, total_tokens: input + output };
  const cached = nestedNumber(left, "input_tokens_details.cached_tokens") + nestedNumber(right, "input_tokens_details.cached_tokens");
  if (cached > 0) usage.input_tokens_details = { cached_tokens: cached };
  const reasoning = nestedNumber(left, "output_tokens_details.reasoning_tokens") + nestedNumber(right, "output_tokens_details.reasoning_tokens");
  if (reasoning > 0) usage.output_tokens_details = { reasoning_tokens: reasoning };
  return usage;
}

/**
 * True when an assistant turn only announced a future action.
 * Conservative by design: result/evidence text, code blocks, a hand-off to the
 * user, or any tool call all mean "do not retry".
 */
export function detectMuseAnnouncementOnly({ text, hasToolCall = false } = {}) {
  if (hasToolCall) return false;
  const value = String(text || "").trim();
  if (!value || value.length > MUSE_CONTINUATION.maxAnnouncementChars) return false;
  if (value.includes("```")) return false;
  if (MUSE_ANNOUNCEMENT_RESULT.test(value)) return false;
  if (MUSE_ANNOUNCEMENT_WAIT.test(value)) return false;
  return MUSE_ANNOUNCEMENT_EN.test(value) || MUSE_ANNOUNCEMENT_VI.test(value);
}

/**
 * Build the one-turn continuation request. Reasoning items must precede the
 * assistant message they produced (Meta rejects a reasoning item followed
 * directly by a user message), so the order is:
 *   [...original input, ...reasoning, assistant announcement, user nudge]
 */
export function buildMuseContinuationBody(body, { text, reasoningItems = [], output = [] } = {}) {
  if (!body || typeof body !== "object" || !Array.isArray(body.input)) return null;
  const assistantText = String(text || "").trim();
  if (!assistantText) return null;

  const items = [];
  const seen = new Set();
  const pushReasoning = (item) => {
    if (!item || item.type !== RESPONSES_ITEM.REASONING) return;
    if (typeof item.encrypted_content !== "string" || !item.encrypted_content) return;
    const key = item.id || item.encrypted_content;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(normalizeReasoningItem(item));
  };
  for (const item of reasoningItems) pushReasoning(item);
  for (const item of output) pushReasoning(item);

  items.push({
    type: RESPONSES_ITEM.MESSAGE,
    role: ROLE.ASSISTANT,
    phase: RESPONSES_MESSAGE_PHASE.COMMENTARY,
    content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text: assistantText }],
  });
  items.push({
    type: RESPONSES_ITEM.MESSAGE,
    role: ROLE.USER,
    content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: MUSE_CONTINUATION.nudge }],
  });

  const next = { ...body, input: [...body.input, ...items], stream: true };
  // Stateless replay cannot be combined with server-managed history.
  delete next.previous_response_id;
  return next;
}

export function shouldContinueMuseResponse({ provider, args, result } = {}) {
  if (provider !== MUSE_PROVIDER_ID) return false;
  if (!isMuseContinuationEnabled() || MUSE_CONTINUATION.maxRetries < 1) return false;
  if (!args?.stream) return false;
  // Native Responses clients (Codex/OpenCode direct) manage their own turns;
  // continuation would duplicate item ids in their event stream.
  if (args.credentials?._museContinuationEligible === false) return false;
  const body = result?.transformedBody;
  if (!body || !Array.isArray(body.input)) return false;
  if (body.previous_response_id) return false;
  if (!Array.isArray(body.tools) || body.tools.length === 0) return false;
  if (body.tool_choice === "none") return false;
  if (!result?.response?.body) return false;
  return true;
}

function createTurnState() {
  return {
    text: "",
    messageText: "",
    output: null,
    reasoningItems: [],
    sawToolCall: false,
    usage: null,
    terminalBlock: null,
    terminalPayload: null,
    terminalType: null,
  };
}

function turnText(turn) {
  return outputText(turn.output) || turn.messageText || turn.text;
}

function turnOutput(turn) {
  const output = Array.isArray(turn.output) ? [...turn.output] : [];
  const seen = new Set(
    output
      .filter((item) => item?.type === RESPONSES_ITEM.REASONING)
      .map((item) => item.id || item.encrypted_content)
      .filter(Boolean)
  );
  const missing = [];
  for (const item of turn.reasoningItems) {
    const key = item?.id || item?.encrypted_content;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    missing.push(item);
  }
  // Terminal output should already contain reasoning, but some upstreams only
  // send the encrypted item in `output_item.done`. Keep the reasoning before
  // the message it belongs to.
  const merged = [...missing, ...output];
  if (!merged.some((item) => item?.type === RESPONSES_ITEM.MESSAGE)) {
    const text = turn.messageText || turn.text;
    if (text) {
      merged.push({
        type: RESPONSES_ITEM.MESSAGE,
        role: ROLE.ASSISTANT,
        content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text }],
      });
    }
  }
  return merged;
}

function consumeEvent(payload, turn) {
  const type = payload.type || payload.event;

  if (type === "response.output_text.delta") {
    turn.text += payload.delta || "";
    return;
  }

  if (type === "response.output_item.added" && isActionItem(payload.item)) {
    turn.sawToolCall = true;
    return;
  }

  if (type === "response.output_item.done") {
    const item = payload.item;
    if (!item) return;
    if (item.type === RESPONSES_ITEM.REASONING) turn.reasoningItems.push(item);
    else if (item.type === RESPONSES_ITEM.MESSAGE) turn.messageText += itemText(item);
    else if (isActionItem(item)) turn.sawToolCall = true;
    return;
  }

  if (type === "response.completed" || type === "response.done" || type === "response.incomplete" || type === "response.failed") {
    const response = payload.response || {};
    if (Array.isArray(response.output) && response.output.length > 0) {
      turn.output = response.output;
      for (const item of response.output) {
        if (item?.type === RESPONSES_ITEM.REASONING) turn.reasoningItems.push(item);
        else if (isActionItem(item)) turn.sawToolCall = true;
      }
    }
    if (response.usage) turn.usage = response.usage;
  }
}

function isTerminalEvent(type) {
  return type === "response.completed" || type === "response.done" ||
    type === "response.incomplete" || type === "response.failed" || type === "error";
}

function shouldRetryTerminal(type, payload, turn, signal) {
  if (signal?.aborted) return false;
  if (type !== "response.completed" && type !== "response.done") return false;
  const response = payload.response || {};
  if (response.error) return false;
  if (response.status && response.status !== "completed") return false;
  if (turn.sawToolCall) return false;
  return Boolean(turnText(turn));
}

function mergeTerminal(payload, first, second) {
  const response = payload.response || {};
  const usage = mergeMuseUsage(first.usage, second.usage);
  return {
    ...payload,
    response: {
      ...response,
      output: [...turnOutput(first), ...turnOutput(second)],
      ...(usage ? { usage } : {}),
    },
  };
}

function parseBlock(block) {
  if (!block) return null;
  let event = null;
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (data.length === 0) return null;
  const text = data.join("\n").trim();
  if (text === "[DONE]") return { done: true };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      if (event && !parsed.type) parsed.type = event;
      return parsed;
    }
  } catch {
    // Non-JSON data line: caller decides whether to forward it.
  }
  return null;
}

function serializeEvent(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}`;
}

function takeBlock(buffer) {
  const match = BLOCK_BOUNDARY.exec(buffer);
  if (!match) return null;
  return {
    block: buffer.slice(0, match.index),
    rest: buffer.slice(match.index + match[0].length),
  };
}

/**
 * Wrap an upstream Responses SSE body with the bounded continuation.
 *
 * @param {object} options
 * @param {object} options.body - the transformed Responses request.
 * @param {(body: object) => Promise<Response|ReadableStream>} options.retry
 * @param {AbortSignal|null} options.signal
 * @param {object|null} options.log
 * @param {number} options.maxRetries
 */
export function createMuseContinuationStream({
  body,
  retry,
  signal = null,
  log = null,
  maxRetries = MUSE_CONTINUATION.maxRetries,
} = {}) {
  if (typeof retry !== "function" || !isMuseContinuationEnabled() || maxRetries < 1) {
    return new TransformStream();
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buffer = "";
  let first = createTurnState();
  let firstDone = null;
  let firstTerminalForwarded = false;
  let retried = false;
  let continuationFailed = false;
  let continuationTerminalForwarded = false;
  let continuationForwardedAny = false;
  let closed = false;

  const enqueue = (controller, text) => {
    if (!text || closed) return;
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      closed = true;
    }
  };

  const forward = (controller, block) => {
    if (!block) return;
    enqueue(controller, `${block}\n\n`);
  };

  const pumpContinuation = async (controller, stream) => {
    const reader = stream.getReader();
    const secondDecoder = new TextDecoder("utf-8", { fatal: false });
    const second = createTurnState();
    let pending = "";
    let secondDone = null;

    const handle = (block) => {
      const parsed = parseBlock(block);
      if (!parsed) {
        // A non-SSE payload here is an upstream error body, not client SSE.
        log?.warn?.("MUSE", "ignoring non-SSE continuation payload");
        return;
      }
      if (parsed.done) {
        secondDone = block;
        return;
      }
      const type = parsed.type || parsed.event;
      consumeEvent(parsed, second);
      if (isTerminalEvent(type)) {
        second.terminalBlock = block;
        second.terminalPayload = parsed;
        second.terminalType = type;
        // Some upstreams close with more than one terminal-shaped event. Only
        // the first can be the client's terminal; later ones are ignored.
        if (continuationTerminalForwarded) return;
        continuationTerminalForwarded = true;
        continuationForwardedAny = true;
        if (type === "error") {
          forward(controller, block);
          return;
        }
        forward(controller, serializeEvent(type, mergeTerminal(parsed, first, second)));
        return;
      }
      if (!MUSE_LIFECYCLE_EVENTS.has(type)) continuationForwardedAny = true;
      forward(controller, block);
    };

    try {
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += secondDecoder.decode(value, { stream: true });
        let taken;
        while ((taken = takeBlock(pending))) {
          pending = taken.rest;
          handle(taken.block);
        }
      }
      if (!closed) {
        pending += secondDecoder.decode();
        if (pending.trim()) handle(pending);
        if (second.terminalPayload && !continuationTerminalForwarded) {
          forward(controller, serializeEvent(second.terminalType, mergeTerminal(second.terminalPayload, first, second)));
          continuationTerminalForwarded = true;
        }
        if (secondDone) forward(controller, secondDone);
      }
    } finally {
      reader.releaseLock?.();
    }
  };

  const processFirstBlock = async (controller, block) => {
    if (retried) {
      // Drain the rest of the original stream after a retry. Keep its [DONE]
      // so a failed retry can still terminate the first turn cleanly.
      if (!firstDone) {
        const parsed = parseBlock(block);
        if (parsed?.done) firstDone = block;
      }
      return;
    }
    const parsed = parseBlock(block);
    if (!parsed) {
      forward(controller, block);
      return;
    }
    if (parsed.done) {
      firstDone = block;
      return;
    }

    const type = parsed.type || parsed.event;
    consumeEvent(parsed, first);

    if (!isTerminalEvent(type)) {
      forward(controller, block);
      return;
    }

    first.terminalBlock = block;
    first.terminalPayload = parsed;
    first.terminalType = type;

    if (!shouldRetryTerminal(type, parsed, first, signal)) {
      forward(controller, block);
      firstTerminalForwarded = true;
      return;
    }

    const text = turnText(first);
    if (!detectMuseAnnouncementOnly({ text, hasToolCall: first.sawToolCall })) {
      forward(controller, block);
      firstTerminalForwarded = true;
      return;
    }

    retried = true;
    log?.info?.("MUSE", "announcement-only turn; retrying with an act-now nudge");
    const continuationBody = buildMuseContinuationBody(body, {
      text,
      reasoningItems: first.reasoningItems,
      output: first.output,
    });
    if (!continuationBody) {
      continuationFailed = true;
      return;
    }

    try {
      const response = await retry(continuationBody);
      if (closed) return;
      const stream = response?.body || response;
      if (!stream) throw new Error("continuation retry returned no body");
      await pumpContinuation(controller, stream);
    } catch (error) {
      log?.warn?.("MUSE", `continuation retry failed: ${error?.message || error}`);
      continuationFailed = true;
    }
  };

  return new TransformStream({
    async transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let taken;
      while ((taken = takeBlock(buffer))) {
        buffer = taken.rest;
        await processFirstBlock(controller, taken.block);
      }
    },
    async flush(controller) {
      buffer += decoder.decode();
      if (buffer.trim()) {
        const block = buffer;
        buffer = "";
        await processFirstBlock(controller, block);
      }
      if (!retried) {
        if (!firstTerminalForwarded && first.terminalBlock) {
          forward(controller, first.terminalBlock);
          firstTerminalForwarded = true;
        }
        if (firstDone) forward(controller, firstDone);
        return;
      }
      if (continuationFailed && !continuationTerminalForwarded && !continuationForwardedAny) {
        forward(controller, first.terminalBlock);
        if (firstDone) forward(controller, firstDone);
      }
    },
  });
}
