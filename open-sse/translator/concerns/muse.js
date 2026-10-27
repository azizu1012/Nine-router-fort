// Muse (Meta) Responses request quirks shared by the translator chain and the
// same-format path. Native Responses clients (source === target) skip every
// registered translator, so these rules must also run from translateRequest().
import { MUSE_PROVIDER_ID } from "../../config/providerIds.js";
import { MUSE_TOOL_USE_DIRECTIVE, isMuseToolDirectiveEnabled } from "../../config/museConstants.js";

/**
 * Meta's Responses API only accepts `tool_choice: "auto"` — `none`, `required`
 * and forced-function objects all return HTTP 400. `"none"` still carries
 * intent ("do not call tools"), so it removes the tool declarations instead of
 * widening to auto; anything else is downgraded to auto with the tools intact.
 */
export function normalizeMuseToolChoice(result, provider) {
  if (provider !== MUSE_PROVIDER_ID) return result;
  const choice = result?.tool_choice;
  if (choice === undefined) return result;

  if (choice === "none") {
    delete result.tool_choice;
    delete result.tools;
    delete result.parallel_tool_calls;
    return result;
  }
  if (choice === "auto") return result;

  // required / forced function / anything else unsupported by Meta
  result.tool_choice = "auto";
  return result;
}

/**
 * Muse accepts only `tool_choice: "auto"`, so it can decide to answer instead
 * of acting. Append a short directive whenever tools are available; final
 * answers are still allowed once the work is done.
 */
export function applyMuseToolUseDirective(result, provider) {
  if (provider !== MUSE_PROVIDER_ID) return result;
  if (!isMuseToolDirectiveEnabled()) return result;
  if (!Array.isArray(result?.tools) || result.tools.length === 0) return result;
  if (result.tool_choice === "none") return result;

  const existing = typeof result.instructions === "string" ? result.instructions.trimEnd() : "";
  if (existing.includes(MUSE_TOOL_USE_DIRECTIVE)) return result;
  result.instructions = existing ? `${existing}\n\n${MUSE_TOOL_USE_DIRECTIVE}` : MUSE_TOOL_USE_DIRECTIVE;
  return result;
}

/** Apply every Muse-specific request rule. Idempotent. */
export function normalizeMuseResponsesRequest(result, provider) {
  normalizeMuseToolChoice(result, provider);
  applyMuseToolUseDirective(result, provider);
  return result;
}
