/**
 * Muse (Meta) reasoning continuity cache.
 *
 * Muse Spark is Responses-only and runs with `store: false`. Meta returns the
 * model's encrypted chain of thought only when the request asks for
 * `include: ["reasoning.encrypted_content"]`, and that blob must be replayed on
 * the next turn to keep reasoning continuity.
 *
 * Native Responses clients (Codex) echo the blob themselves. Chat Completions /
 * Claude Code clients cannot — the field is not part of their wire format — so
 * the router remembers the blob per conversation and re-injects it while
 * translating the next request.
 *
 * Matching is by a turn fingerprint (assistant text + tool call names/arguments)
 * rather than by position: clients may compact history, and tool-call ids may be
 * rewritten, but a turn's visible output is stable. Entries are scoped by
 * session + model and bounded by TTL/size caps.
 */
import crypto from "crypto";
import { MUSE_PROVIDER_ID } from "../config/providerIds.js";
import { MUSE_REASONING_CACHE } from "../config/runtimeConfig.js";

const SESSION_SEPARATOR = "\n";
const MAX_SESSION_SEED_LEN = 2000;

// sessionKey -> { turns: Array<{ fingerprint, items, at, bytes }>, bytes, lastUsed }
const sessions = new Map();
let totalBytes = 0;

function hash(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function normalizeModel(model) {
  return typeof model === "string" ? model.trim().toLowerCase() : "";
}

function sessionKey(sessionId, model) {
  if (!sessionId) return null;
  return `${sessionId}${SESSION_SEPARATOR}${normalizeModel(model)}`;
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();
}

/** Assistant text from an OpenAI/Responses/Claude content value. */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    if (typeof part?.text === "string") text += part.text;
    else if (typeof part?.content === "string") text += part.content;
  }
  return text;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
  }
  return value;
}

/** Canonical form of tool-call arguments so JSON whitespace/key order drift does not break matching. */
function canonicalArguments(args) {
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed) return "";
    try {
      return JSON.stringify(stableValue(JSON.parse(trimmed)));
    } catch {
      return trimmed;
    }
  }
  if (args === undefined || args === null) return "";
  try {
    return JSON.stringify(stableValue(args));
  } catch {
    return String(args);
  }
}

function fingerprint({ text, calls }) {
  const payload = JSON.stringify({
    text: normalizeText(text),
    calls: calls.map((call) => [call.name || "", call.arguments || ""]),
  });
  return hash(payload);
}

/** Fingerprint of an assistant turn in Chat Completions shape. */
export function buildMuseTurnFingerprint(message) {
  if (!message || typeof message !== "object") return null;
  const calls = [];
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      calls.push({
        name: call?.function?.name || call?.name || "",
        arguments: canonicalArguments(call?.function?.arguments ?? call?.arguments),
      });
    }
  }
  if (message.function_call) {
    calls.push({
      name: message.function_call.name || "",
      arguments: canonicalArguments(message.function_call.arguments),
    });
  }
  return fingerprint({ text: contentText(message.content), calls });
}

/** Fingerprint of the same assistant turn in Responses output shape. */
export function buildMuseOutputFingerprint(output) {
  if (!Array.isArray(output)) return null;
  let text = "";
  const calls = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      text += contentText(item.content);
    } else if (item.type === "function_call") {
      calls.push({ name: item.name || "", arguments: canonicalArguments(item.arguments) });
    } else if (item.type === "custom_tool_call") {
      calls.push({ name: item.name || "", arguments: canonicalArguments(item.input) });
    }
  }
  if (!normalizeText(text) && calls.length === 0) return null;
  return fingerprint({ text, calls });
}

function cloneReasoningItem(item) {
  const summary = Array.isArray(item.summary)
    ? item.summary
      .map((part) => ({
        type: part?.type || "summary_text",
        text: typeof part?.text === "string" ? part.text : "",
      }))
      .filter((part) => part.text)
    : [];
  const cloned = {
    type: "reasoning",
    summary,
    encrypted_content: item.encrypted_content,
  };
  if (typeof item.id === "string" && item.id) cloned.id = item.id;
  if (Array.isArray(item.content)) cloned.content = item.content;
  return cloned;
}

function collectReasoningItems(output, extraItems) {
  const items = [];
  const seen = new Set();
  const push = (item) => {
    if (!item || item.type !== "reasoning") return;
    if (typeof item.encrypted_content !== "string" || !item.encrypted_content) return;
    const key = item.id || item.encrypted_content;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(cloneReasoningItem(item));
  };
  for (const item of Array.isArray(output) ? output : []) push(item);
  for (const item of Array.isArray(extraItems) ? extraItems : []) push(item);
  return items;
}

function estimateBytes(items) {
  try {
    return new TextEncoder().encode(JSON.stringify(items)).length;
  } catch {
    return 0;
  }
}

function dropTurn(session, index) {
  const [entry] = session.turns.splice(index, 1);
  if (!entry) return;
  session.bytes = Math.max(0, session.bytes - entry.bytes);
  totalBytes = Math.max(0, totalBytes - entry.bytes);
}

function pruneExpired(now) {
  const ttl = MUSE_REASONING_CACHE.ttlMs;
  for (const [key, session] of sessions) {
    for (let i = session.turns.length - 1; i >= 0; i--) {
      if (now - session.turns[i].at > ttl) dropTurn(session, i);
    }
    if (session.turns.length === 0) sessions.delete(key);
  }
}

function enforceSessionCap(session) {
  while (session.turns.length > MUSE_REASONING_CACHE.maxTurnsPerSession) dropTurn(session, 0);
  while (totalBytes > MUSE_REASONING_CACHE.maxBytes && sessions.size > 0) {
    const oldestKey = sessions.keys().next().value;
    const oldest = sessions.get(oldestKey);
    sessions.delete(oldestKey);
    totalBytes = Math.max(0, totalBytes - (oldest?.bytes || 0));
  }
}

/**
 * Remember the encrypted reasoning that produced one assistant turn.
 * No-op unless the provider is Muse and the output actually carries a blob.
 */
export function rememberMuseReasoning({ provider, model, sessionId, output, reasoningItems = null }) {
  if (provider !== MUSE_PROVIDER_ID) return false;
  const key = sessionKey(sessionId, model);
  if (!key) return false;

  const items = collectReasoningItems(output, reasoningItems);
  if (items.length === 0) return false;

  const turnFingerprint = buildMuseOutputFingerprint(output);
  if (!turnFingerprint) return false;

  const now = Date.now();
  pruneExpired(now);

  let session = sessions.get(key);
  if (!session) {
    session = { turns: [], bytes: 0, lastUsed: now };
    sessions.set(key, session);
    while (sessions.size > MUSE_REASONING_CACHE.maxSessions) {
      const oldestKey = sessions.keys().next().value;
      const oldest = sessions.get(oldestKey);
      sessions.delete(oldestKey);
      totalBytes = Math.max(0, totalBytes - (oldest?.bytes || 0));
    }
  } else {
    // Refresh LRU position.
    sessions.delete(key);
    sessions.set(key, session);
  }
  session.lastUsed = now;

  const sameFingerprint = session.turns.filter((entry) => entry.fingerprint === turnFingerprint);
  while (sameFingerprint.length >= MUSE_REASONING_CACHE.maxEntriesPerFingerprint) {
    const oldest = sameFingerprint.shift();
    const index = session.turns.indexOf(oldest);
    if (index >= 0) dropTurn(session, index);
  }

  const bytes = estimateBytes(items);
  session.turns.push({ fingerprint: turnFingerprint, items, at: now, bytes });
  session.bytes += bytes;
  totalBytes += bytes;

  enforceSessionCap(session);
  return true;
}

/**
 * Return the cached reasoning items for an assistant turn, or null on a miss.
 * `occurrence` disambiguates repeated identical turns (same text + same calls).
 */
export function recallMuseReasoning({ provider = MUSE_PROVIDER_ID, model, sessionId, fingerprint, occurrence = 0 }) {
  if (provider !== MUSE_PROVIDER_ID || !fingerprint) return null;
  const key = sessionKey(sessionId, model);
  if (!key) return null;

  const now = Date.now();
  pruneExpired(now);
  const session = sessions.get(key);
  if (!session) return null;

  const matches = session.turns.filter((entry) => entry.fingerprint === fingerprint);
  if (matches.length === 0) return null;
  const entry = matches[Math.min(Math.max(0, occurrence), matches.length - 1)];
  if (!entry) return null;

  session.lastUsed = now;
  sessions.delete(key);
  sessions.set(key, session);

  return entry.items.map((item) => ({
    ...item,
    summary: Array.isArray(item.summary) ? item.summary.map((part) => ({ ...part })) : [],
  }));
}

function firstUserText(body) {
  const messages = Array.isArray(body?.messages)
    ? body.messages
    : Array.isArray(body?.input)
      ? body.input
      : [];
  for (const message of messages) {
    if (message?.role !== "user") continue;
    const text = normalizeText(contentText(message.content));
    if (text) return text.slice(0, MAX_SESSION_SEED_LEN);
  }
  return normalizeText(contentText(body?.system) || contentText(body?.instructions)).slice(0, MAX_SESSION_SEED_LEN);
}

/**
 * Stable per-conversation key: the resolved client session (Claude Code header,
 * metadata user id, ...) plus a hash of the first user turn. The second part
 * keeps the connection-level fallback from leaking reasoning between
 * conversations that share one API key.
 */
export function resolveMuseReasoningSession({ baseSessionId, body }) {
  const seed = firstUserText(body);
  const conversation = seed ? hash(seed) : "";
  if (baseSessionId) return `${baseSessionId}::${conversation}`;
  return conversation ? `conv::${conversation}` : null;
}

/** Test-only: drop all cached sessions. */
export function _resetMuseReasoningCache() {
  sessions.clear();
  totalBytes = 0;
}

/** Test/diagnostics: current cache footprint. */
export function getMuseReasoningCacheStats() {
  let turns = 0;
  for (const session of sessions.values()) turns += session.turns.length;
  return { sessions: sessions.size, turns, bytes: totalBytes };
}
