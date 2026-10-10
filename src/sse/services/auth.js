import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools, getApiKeyByKey, getComboByName } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { errorResponse } from "open-sse/utils/error.js";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS, getProviderAlias } from "@/shared/constants/providers.js";
import { getAntigravityQuotaCache, getAntigravityModelQuota } from "./antigravityQuota.js";
import * as log from "../utils/logger.js";
import {
  incrementActiveRequest,
  decrementActiveRequest,
  getActiveRequestCount,
  getMinuteTokenUsage,
  getDailyRequestCount,
  resetKeyLimits,
} from "@/shared/utils/keyLimiter.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  const requestedModel = options?.requestedModel || model;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;

    // Filter out model-locked, excluded, and Antigravity quota-exhausted connections.
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      const enabled = c.providerSpecificData?.enabledModels;
      if (providerId === "codex" && Array.isArray(enabled) && enabled.length && requestedModel && !enabled.includes(requestedModel)) return false;
      // Antigravity: skip if live quota exhausted for this model
      if (isAntigravity && model && antigravityQuotaCache) {
        const connQuotas = antigravityQuotaCache.get(c.id);
        const quota = getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model];
        if (quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > Date.now()) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info("AG_QUOTA", `${account} | CACHE_BLOCK ${model} — skip upstream until ${quota.resetAt}`);
          return false;
        }
      }
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing.
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const connQuotas = antigravityQuotaCache.get(c.id);
          const quota = getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model];
          const resetAt = quota?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  if (githubResetAtMs) {
    shouldFallback = true;
    cooldownMs = githubResetAtMs - Date.now();
    newBackoffLevel = 0;
  } else if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    // Antigravity quota API provides exact per-model resetAt. Do not truncate it.
    cooldownMs = resolveProviderId(provider) === "antigravity"
      ? resetsAtMs - Date.now()
      : Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel, resolveProviderId(provider)));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 200) : "Provider error";
  const lockUpdate = buildModelLockUpdate(githubResetAtMs ? null : model, cooldownMs);

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0
    });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-API-key permission + limit layer
//
// Every inbound /v1 request is gated here: provider allow-list, concurrency
// ceiling, rolling TPM and rolling RPD. Counters live in keyLimiter.js and real
// token usage is fed in by usageRepo.saveRequestUsage(), so every modality is
// accounted exactly once.
// ═══════════════════════════════════════════════════════════════════════════
const KEY_RECORD_TTL_MS = 15 * 1000;

// key -> { record, ts }. Shared across Next.js module instances.
if (!global.__apiKeyRecordCache) global.__apiKeyRecordCache = new Map();

async function getCachedKeyRecord(apiKey) {
  const cache = global.__apiKeyRecordCache;
  const hit = cache.get(apiKey);
  if (hit && Date.now() - hit.ts < KEY_RECORD_TTL_MS) return hit.record;
  const record = await getApiKeyByKey(apiKey);
  // Negative results are cached too: an unknown key is a common flood pattern
  // and must not turn into one DB read per request.
  cache.set(apiKey, { record, ts: Date.now() });
  if (cache.size > 2000) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return record;
}

/**
 * Drop cached key records and limit counters.
 * Call after any write to the apiKeys table or to provider connections.
 * @param {string|null} apiKey - one key, or null to clear everything
 */
export function invalidateApiKeyCache(apiKey = null) {
  if (apiKey) {
    global.__apiKeyRecordCache.delete(apiKey);
    resetKeyLimits(apiKey);
  } else {
    global.__apiKeyRecordCache.clear();
  }
}

/**
 * Every prefix a key is allowed to address, derived from its allow-list.
 *
 * `allowedProviders` holds operator-chosen tokens which may be a built-in
 * provider id, a registry alias, a custom node id, a custom prefix, or a
 * connection id. For a custom provider, `connections[].provider` holds the NODE
 * id while models are published under the node's alias — so a node id in the
 * allow-list has to expand to the prefix its models actually use.
 *
 * CRITICAL: this must not become "every identifier that exists". Expanding to all
 * routable aliases would grant access to every provider the operator happens to
 * have connected, which defeats the allow-list entirely. A prefix is reachable
 * only when the operator listed it, or listed a connection that publishes it.
 */
async function getAllowedPrefixes(allowedSet) {
  const prefixes = new Set(allowedSet);
  if (allowedSet.size === 0) return prefixes;
  let connections;
  try {
    connections = await getProviderConnections({});
  } catch (err) {
    // Fail-open on a DB hiccup: a transient error must not lock everyone out.
    log.warn("AUTH", `allow-list expansion unavailable, restrictions skipped: ${err?.message}`);
    return null;
  }
  for (const c of connections) {
    if (!c) continue;
    const ids = connectionIdentifiers(c);
    // Selected by the operator (directly, or via one of its ids) -> every prefix
    // this connection publishes becomes reachable.
    if (ids.some((v) => allowedSet.has(v))) {
      for (const v of ids) prefixes.add(v);
    }
  }
  return prefixes;
}

/** All the names one connection can be addressed by. */
function connectionIdentifiers(conn) {
  const out = [];
  const push = (v) => {
    if (!v) return;
    const s = String(v).trim().toLowerCase();
    if (s && !out.includes(s)) out.push(s);
  };
  push(conn.provider);
  push(conn.id);
  push(conn?.providerSpecificData?.prefix);
  if (conn.provider) push(getProviderAlias(conn.provider));
  return out;
}

/** True when `modelStr` is a bare combo whose seats include an allowed prefix. */
async function isComboAllowed(modelStr, allowedPrefixes) {
  let combo = null;
  try {
    combo = await getComboByName(modelStr);
  } catch {
    return false;
  }
  if (!combo) return false;
  const byName = new Map([[combo.name, combo]]);
  return (combo.models || []).some((seat) => isModelRefAllowed(seat, allowedPrefixes, byName));
}

/**
 * Verify API key permissions: provider allow-list + concurrency/TPM/RPD limits.
 * @returns {{ valid: boolean, status?: number, error?: string, retryAfter?: number }}
 */
export async function verifyApiKeyPermissions(apiKey, modelStr) {
  if (!apiKey) return { valid: true };

  const keyRecord = await getCachedKeyRecord(apiKey);
  if (!keyRecord) return { valid: true };
  if (!keyRecord.isActive) return { valid: false, status: 403, error: "API key is paused" };

  const allowed = Array.isArray(keyRecord.allowedProviders) ? keyRecord.allowedProviders : [];
  if (allowed.length > 0) {
    const allowedSet = new Set(allowed.map((x) => String(x).trim().toLowerCase()).filter(Boolean));
    const prefixes = await getAllowedPrefixes(allowedSet);
    // null = the DB read failed and we deliberately fail open this cycle.
    if (prefixes) {
      const prefix = String(modelStr || "").split("/")[0];
      const ok = prefix
        ? prefixes.has(prefix.trim().toLowerCase())
        : await isComboAllowed(modelStr, prefixes);
      if (!ok) {
        return { valid: false, status: 403, error: `API key not authorized for provider: ${prefix || modelStr || "unknown"}` };
      }
    }
  }

  if (keyRecord.limitConcurrency && getActiveRequestCount(apiKey) >= keyRecord.limitConcurrency) {
    return {
      valid: false, status: 429, retryAfter: 10,
      error: `Concurrency limit (${keyRecord.limitConcurrency} workers) exceeded for this API key`,
    };
  }

  if (keyRecord.limitTpm) {
    const minuteUsage = getMinuteTokenUsage(apiKey);
    if (minuteUsage >= keyRecord.limitTpm) {
      return {
        valid: false, status: 429, retryAfter: 60,
        error: `TPM limit (${keyRecord.limitTpm} tokens/min) exceeded for this API key`,
      };
    }
  }

  if (keyRecord.limitRpd) {
    const dailyRequests = getDailyRequestCount(apiKey);
    if (dailyRequests >= keyRecord.limitRpd) {
      return {
        valid: false, status: 429, retryAfter: 3600,
        error: `RPD limit (${keyRecord.limitRpd} requests/day) exceeded for this API key`,
      };
    }
  }

  return { valid: true };
}

/** Pass a Response through, running `cleanupFn` exactly once on end/cancel/error. */
export function wrapResponseWithCleanup(response, cleanupFn) {
  let done = false;
  const once = () => { if (!done) { done = true; cleanupFn(); } };
  if (!response || !response.body) {
    once();
    return response;
  }
  const reader = response.body.getReader();
  const cleanupWrapper = new ReadableStream({
    start(controller) {
      const push = () => {
        reader.read().then(({ done: finished, value }) => {
          if (finished) { once(); try { controller.close(); } catch { /* already closed */ } return; }
          try { controller.enqueue(value); } catch { once(); return; }
          push();
        }).catch((err) => { once(); try { controller.error(err); } catch { /* already closed */ } });
      };
      push();
    },
    cancel() { once(); reader.cancel().catch(() => {}); },
  });
  return new Response(cleanupWrapper, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Gate + account one /v1 request. Wraps the real handler so the concurrency
 * counter is held for the whole stream lifetime, not just the handshake.
 */
export async function withApiKeyLimits(request, innerHandler, clientRawRequest = null) {
  const apiKey = extractApiKey(request);
  if (!apiKey) return innerHandler(request, clientRawRequest);

  let modelStr = null;
  try {
    modelStr = (await request.clone().json())?.model || null;
  } catch {
    // Non-JSON bodies (STT multipart) simply skip the provider allow-list check.
  }

  const permCheck = await verifyApiKeyPermissions(apiKey, modelStr);
  if (!permCheck.valid) {
    log.warn("AUTH", permCheck.error);
    return errorResponse(
      permCheck.status || 429,
      permCheck.error || "API key permission denied",
      permCheck.retryAfter ? { "Retry-After": String(permCheck.retryAfter) } : null
    );
  }

  incrementActiveRequest(apiKey);
  let innerResult;
  try {
    innerResult = await innerHandler(request, clientRawRequest);
  } catch (err) {
    decrementActiveRequest(apiKey);
    throw err;
  }

  if (innerResult instanceof Response) {
    return wrapResponseWithCleanup(innerResult, () => decrementActiveRequest(apiKey));
  }
  decrementActiveRequest(apiKey);
  return innerResult;
}

/**
 * The set of model prefixes this request's API key may address, or null when the
 * key is unrestricted. Callers pass it to isModelRefAllowed().
 */
export async function resolveKeyProviderScope(request) {
  const apiKey = extractApiKey(request);
  if (!apiKey) return null;
  const record = await getCachedKeyRecord(apiKey);
  const allowed = Array.isArray(record?.allowedProviders) ? record.allowedProviders : [];
  const allowedSet = new Set(allowed.map((x) => String(x).trim().toLowerCase()).filter(Boolean));
  if (allowedSet.size === 0) return null;
  return (await getAllowedPrefixes(allowedSet)) ?? null;
}

/**
 * Does this connection serve a provider the allow-list selected? Compares against
 * the EXPANDED prefix set, so listing a custom node id or a connection id also
 * admits the alias its models are published under.
 */
export function isConnectionAllowed(conn, allowedPrefixes) {
  if (!allowedPrefixes) return true;
  if (!conn) return false;
  return connectionIdentifiers(conn).some((v) => allowedPrefixes.has(v));
}

/**
 * Is this `prefix/model` ref (or bare combo name) usable under the scope?
 * Combos count as allowed when at least one seat is, mirroring the chat gate.
 * @param {Map<string, object>} [combosByName] - for resolving nested combos
 */
export function isModelRefAllowed(ref, allowedPrefixes, combosByName = new Map(), depth = 0) {
  if (!allowedPrefixes) return true;
  if (depth > 5) return false;
  const text = String(ref || "").trim();
  if (!text) return false;
  const slash = text.indexOf("/");
  if (slash > 0) return allowedPrefixes.has(text.slice(0, slash).trim().toLowerCase());
  const combo = combosByName.get(text);
  if (!combo) return allowedPrefixes.has(text.toLowerCase());
  return (combo.models || []).some((seat) => isModelRefAllowed(seat, allowedPrefixes, combosByName, depth + 1));
}

// Sub-agent degradation is engine-side (open-sse) because chatCore.js is the
// caller and the engine must not import from @/. Re-exported here so app code
// keeps a single auth entry point.
export { isSubAgentRequest, handleSubAgentError } from "open-sse/utils/subAgentFallback.js";
