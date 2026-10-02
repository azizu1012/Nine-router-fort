/**
 * In-memory per-API-key accounting: concurrency, TPM (rolling 60s) and RPD
 * (rolling 24h). Deliberately process-local — the gateway runs as a single
 * Node process, and the maps are bounded so a flood of distinct keys cannot
 * grow them without limit.
 */

const MAX_TRACKED_KEYS = 5000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Token usage older than this can never affect a TPM window — drop it eagerly.
const TOKEN_RETENTION_MS = 5 * MINUTE_MS;
// Request timestamps older than this can never affect an RPD window.
const REQUEST_RETENTION_MS = 2 * DAY_MS;

const activeRequests = new Map();
const tokenUsage = new Map();
const requestCount = new Map();

function ensureTracked(keyId) {
  if (tokenUsage.has(keyId) || requestCount.has(keyId) || activeRequests.has(keyId)) return;
  if (tokenUsage.size + requestCount.size < MAX_TRACKED_KEYS * 2) return;
  // Evict the least-recently-used idle key.
  for (const map of [tokenUsage, requestCount]) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
}

export function incrementActiveRequest(keyId) {
  if (!keyId) return;
  ensureTracked(keyId);
  activeRequests.set(keyId, (activeRequests.get(keyId) || 0) + 1);
  const history = requestCount.get(keyId) || [];
  history.push(Date.now());
  requestCount.set(keyId, history);
}

export function decrementActiveRequest(keyId) {
  if (!keyId) return;
  const current = activeRequests.get(keyId) || 0;
  if (current > 1) {
    activeRequests.set(keyId, current - 1);
  } else if (current === 1) {
    activeRequests.delete(keyId);
  }
}

export function getActiveRequestCount(keyId) {
  return activeRequests.get(keyId) || 0;
}

export function addTokenUsage(keyId, tokens) {
  if (!keyId || !tokens || tokens <= 0) return;
  ensureTracked(keyId);
  const history = tokenUsage.get(keyId) || [];
  history.push({ timestamp: Date.now(), tokens });
  tokenUsage.set(keyId, history);
}

export function getMinuteTokenUsage(keyId) {
  if (!keyId) return 0;
  const now = Date.now();
  const history = tokenUsage.get(keyId) || [];
  const kept = history.filter((item) => item.timestamp > now - MINUTE_MS);
  if (kept.length === 0) {
    tokenUsage.delete(keyId);
    return 0;
  }
  tokenUsage.set(keyId, kept.filter((item) => item.timestamp > now - TOKEN_RETENTION_MS));
  return kept.reduce((sum, item) => sum + item.tokens, 0);
}

export function getDailyRequestCount(keyId) {
  if (!keyId) return 0;
  const now = Date.now();
  const history = requestCount.get(keyId) || [];
  const kept = history.filter((ts) => ts > now - DAY_MS);
  if (kept.length === 0) {
    requestCount.delete(keyId);
    return 0;
  }
  requestCount.set(keyId, kept.filter((ts) => ts > now - REQUEST_RETENTION_MS));
  return kept.length;
}

/** Drop every counter for a key (called when a key is deleted or paused). */
export function resetKeyLimits(keyId) {
  if (!keyId) return;
  activeRequests.delete(keyId);
  tokenUsage.delete(keyId);
  requestCount.delete(keyId);
}
