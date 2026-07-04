import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getApiKeyByKey } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { errorResponse } from "open-sse/utils/error.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import * as log from "../utils/logger.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

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
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: override.proxyPoolId || "" });
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

    // Filter out model-locked and excluded connections
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
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
      // Find earliest lock expiry across all connections for retry timing
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
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

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    cooldownMs = Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 100) : "Provider error";
  const lockUpdate = buildModelLockUpdate(model, cooldownMs);

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
    Object.assign(clearObj, { testStatus: "active", lastError: null, lastErrorAt: null, backoffLevel: 0 });
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

/**
 * Verify API Key permissions, including provider restrictions and rate/concurrency limits.
 */
export async function verifyApiKeyPermissions(apiKey, provider, modelStr) {
  if (!apiKey) return { valid: true };

  const keyRecord = await getApiKeyByKey(apiKey);
  if (!keyRecord) {
    return { valid: false, status: 401, error: "Invalid API key" };
  }
  if (!keyRecord.isActive) {
    return { valid: false, status: 403, error: "API key is paused" };
  }

  // 1. Check provider restrictions (only when provider is known)
  // allowedProviders may contain either:
  //   - built-in provider names (e.g. "openai", "anthropic")
  //   - provider node IDs (e.g. "openai-compatible-chat-a327e1f7-...")
  // providerConnections.provider stores the node ID for custom providers.
  if (provider && keyRecord.allowedProviders && keyRecord.allowedProviders.length > 0) {
    const normalizedProvider = provider.toLowerCase();
    const allowedSet = new Set(keyRecord.allowedProviders.map(p => p.toLowerCase()));

    // Check 1: simple built-in name match (e.g. "openai" in ["openai"])
    let isAllowed = allowedSet.has(normalizedProvider);

    // Check 2: built-in provider connections (provider field = provider name)
    if (!isAllowed) {
      try {
        const connections = await getProviderConnections({ provider });
        isAllowed = connections.some(
          c => allowedSet.has(c.id?.toLowerCase()) || allowedSet.has(c.provider?.toLowerCase())
        );
      } catch (_) {
        isAllowed = true;
      }
    }

    // Check 3: custom provider nodes — allowedProviders contains node IDs.
    // Find all connections where their provider field (which stores node ID) is in allowedProviders.
    // These connections can serve any base provider type (openai-compatible etc.).
    if (!isAllowed) {
      try {
        const allConnections = await getProviderConnections({});
        isAllowed = allConnections.some(
          c => allowedSet.has(c.provider?.toLowerCase()) || allowedSet.has(c.id?.toLowerCase())
        );
      } catch (_) {
        isAllowed = true;
      }
    }

    if (!isAllowed) {
      return { valid: false, status: 403, error: `API key not authorized for provider: ${provider}` };
    }
  }

  // 2. Check Concurrency Limit (Workers)
  if (keyRecord.limitConcurrency && keyRecord.limitConcurrency > 0) {
    const { getActiveRequestCount } = await import("@/shared/utils/keyLimiter");
    const activeCount = getActiveRequestCount(keyRecord.id);
    if (activeCount >= keyRecord.limitConcurrency) {
      return { valid: false, status: 429, error: "Concurrency limit (workers) exceeded for this API key" };
    }
  }

  // 3. Check TPM (Tokens Per Minute) Limit
  if (keyRecord.limitTpm && keyRecord.limitTpm > 0) {
    const { getMinuteTokenUsage } = await import("@/shared/utils/keyLimiter");
    const usedTokens = getMinuteTokenUsage(keyRecord.id);
    if (usedTokens >= keyRecord.limitTpm) {
      return { valid: false, status: 429, error: "TPM (Tokens per Minute) limit exceeded for this API key" };
    }
  }

  // 4. Check RPD (Requests Per Day) Limit
  if (keyRecord.limitRpd && keyRecord.limitRpd > 0) {
    const { getDailyRequestCount } = await import("@/shared/utils/keyLimiter");
    const usedRequests = getDailyRequestCount(keyRecord.id);
    if (usedRequests >= keyRecord.limitRpd) {
      return { valid: false, status: 429, error: "RPD (Requests per Day) limit exceeded for this API key" };
    }
  }

  return { valid: true, keyRecord };
}

/**
 * Wrap a Response body stream to trigger a cleanup function when the stream completes/aborts.
 */
export function wrapResponseWithCleanup(response, cleanupFn) {
  if (!response || !response.body) {
    cleanupFn();
    return response;
  }

  let cleaned = false;
  const runCleanup = () => {
    if (!cleaned) {
      cleaned = true;
      cleanupFn();
    }
  };

  const stream = response.body;

  if (typeof stream.getReader !== "function") {
    if (typeof stream.on === "function") {
      stream.on("end", runCleanup);
      stream.on("close", runCleanup);
      stream.on("error", runCleanup);
    } else {
      runCleanup();
    }
    return response;
  }

  const wrappedStream = new ReadableStream({
    async start(controller) {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            runCleanup();
            controller.close();
            break;
          }
          controller.enqueue(value);
        }
      } catch (err) {
        runCleanup();
        controller.error(err);
      }
    },
    cancel(reason) {
      runCleanup();
      if (typeof stream.cancel === "function") {
        stream.cancel(reason);
      }
    }
  });

  return new Response(wrappedStream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

/**
 * Generic wrapper to check API key permissions and enforce TPM/RPD/concurrency limits.
 */
export async function withApiKeyLimits(request, innerHandler, clientRawRequest = null) {
  let providerVal = null;
  let modelStr = null;
  let keyRecord = null;
  let apiKey = null;

  try {
    apiKey = extractApiKey(request);
  } catch (e) {}

  const settings = await getSettings();

  if (settings.requireApiKey || apiKey) {
    try {
      const cloned = request.clone();
      const contentType = request.headers.get("content-type") || "";
      if (contentType.includes("multipart/form-data")) {
        const formData = await cloned.formData();
        modelStr = formData.get("model");
      } else {
        const body = await cloned.json();
        modelStr = body?.model || null;
      }

      if (modelStr) {
        const { getModelInfo } = await import("./model.js");
        const modelInfo = await getModelInfo(modelStr);
        providerVal = modelInfo?.provider || null;
      }
    } catch (e) {
      // Ignore if body parsing fails (e.g. GET request, empty request)
    }

    if (settings.requireApiKey && !apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }

    if (apiKey) {
      const authResult = await verifyApiKeyPermissions(apiKey, providerVal, modelStr);
      if (!authResult.valid) {
        log.warn("AUTH", authResult.error);
        return errorResponse(authResult.status, authResult.error);
      }
      keyRecord = authResult.keyRecord;
    }
  }

  if (keyRecord) {
    const { incrementActiveRequest } = await import("@/shared/utils/keyLimiter");
    incrementActiveRequest(keyRecord.id);
  }

  let response;
  try {
    if (clientRawRequest !== null) {
      response = await innerHandler(request, clientRawRequest);
    } else {
      response = await innerHandler(request);
    }
  } catch (err) {
    if (keyRecord) {
      const { decrementActiveRequest } = await import("@/shared/utils/keyLimiter");
      decrementActiveRequest(keyRecord.id);
    }
    throw err;
  }

  if (keyRecord) {
    const { decrementActiveRequest } = await import("@/shared/utils/keyLimiter");
    response = wrapResponseWithCleanup(response, () => {
      decrementActiveRequest(keyRecord.id);
    });
  }

  return response;
}

