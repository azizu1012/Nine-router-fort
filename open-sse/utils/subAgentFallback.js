/**
 * Graceful degradation for orchestrator sub-agent calls.
 *
 * A sub-agent cannot do anything useful with a raw upstream error: it has no way
 * to pick another provider or retry, and a hard error frame aborts the parent's
 * whole run. Detecting one and answering with a 200 that carries a
 * machine-readable reason lets the parent decide to degrade, retry or continue.
 *
 * Lives in open-sse/ rather than the app layer because chatCore.js is the caller
 * and the engine must not import from @/.
 */

/**
 * Heuristic: a long tool-heavy agent session whose assistant turns carry
 * thinking blocks is an orchestrator sub-agent, not a human chat.
 * The explicit system-prompt marker is the strong signal; the shape heuristic
 * is the fallback for clients that do not set one.
 */
export function isSubAgentRequest(body) {
  if (!body) return false;

  if (Array.isArray(body.system)) {
    if (body.system.map((b) => b?.text || "").join("\n").includes("You are an expert software engineer")) {
      return true;
    }
  }
  const systemPrompt = body.system || "";
  if (typeof systemPrompt === "string" && systemPrompt.includes("You are an expert software engineer")) {
    return true;
  }

  if (Array.isArray(body.messages) && body.messages.length > 5) {
    const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
    const thinkingTurnCount = body.messages.filter((m) =>
      m.role === "assistant" && m.content?.some?.((c) => c?.type === "thinking")
    ).length;
    if (toolCount > 0 && thinkingTurnCount > 3) return true;
  }

  return false;
}

// Ordered: first match wins, so put the specific patterns before the generic ones.
const SUB_AGENT_REASONS = [
  [/(401|unauthorized|invalid_grant|invalid_client)/i, "auth_expired"],
  [/(429|rate.?limit|too many requests|quota)/i, "rate_limited"],
  [/insufficient_quota|quota_exceeded|billing|payment/i, "quota_exceeded"],
  [/no available|all accounts|unavailable|exhausted/i, "pool_exhausted"],
];

function classifySubAgentError(errorMsg) {
  for (const [pattern, reason] of SUB_AGENT_REASONS) {
    if (pattern.test(errorMsg)) return reason;
  }
  return "pool_exhausted";
}

/**
 * Build a 200 Response in the client's own format whose single content block is a
 * JSON document describing the failure.
 *
 * @param {object} body - original client request body
 * @param {Error|string} error
 * @param {string} sourceFormat - detected client format
 * @returns {Response}
 */
export function handleSubAgentError(body, error, sourceFormat) {
  const errorMsg = String(error?.message || error || "");
  const payload = {
    _subagent_error: true,
    reason: classifySubAgentError(errorMsg),
    message: errorMsg.slice(0, 500),
    suggestion: "The upstream provider errored. This sub-agent turn degraded gracefully instead of aborting the run.",
  };

  // Responses API / JSON callers get a well-formed completed response object.
  if (sourceFormat === "openai-responses" || body?.stream === false) {
    return new Response(JSON.stringify({
      id: "subagent_error_fallback",
      object: "response",
      status: "completed",
      created: Math.floor(Date.now() / 1000),
      model: body?.model || "unknown",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify(payload) }],
      }],
      usage: { input_tokens: 0, output_tokens: 0 },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Everything else gets a Claude-shaped SSE transcript terminated with [DONE],
  // which every streaming client in the matrix can parse.
  const model = JSON.stringify(body?.model || "unknown");
  const text = JSON.stringify(JSON.stringify(payload));
  const fakeSSE = [
    `data: {"type":"message_start","message":{"id":"subagent_error_fallback","role":"assistant","content":[],"model":${model},"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}`,
    "",
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    "",
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${text}}}`,
    "",
    `data: {"type":"content_block_stop","index":0}`,
    "",
    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  return new Response(fakeSSE, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
