// Memory-based rate limiter and concurrency tracker for API Keys

const activeRequests = new Map(); // keyId -> count
const tokenUsage = new Map(); // keyId -> Array of { timestamp, tokens }
const requestCount = new Map(); // keyId -> Array of timestamp (number)

export function incrementActiveRequest(keyId) {
  const current = activeRequests.get(keyId) || 0;
  activeRequests.set(keyId, current + 1);

  // Track daily requests (request start)
  const history = requestCount.get(keyId) || [];
  history.push(Date.now());
  requestCount.set(keyId, history);
}

export function decrementActiveRequest(keyId) {
  const current = activeRequests.get(keyId) || 0;
  if (current > 0) {
    activeRequests.set(keyId, current - 1);
  }
}

export function getActiveRequestCount(keyId) {
  return activeRequests.get(keyId) || 0;
}

export function addTokenUsage(keyId, tokens) {
  if (!tokens || tokens <= 0) return;
  const history = tokenUsage.get(keyId) || [];
  history.push({ timestamp: Date.now(), tokens });
  tokenUsage.set(keyId, history);
}

export function getMinuteTokenUsage(keyId) {
  const now = Date.now();
  const limitTime = now - 60000;
  const history = tokenUsage.get(keyId) || [];
  const updated = history.filter(item => item.timestamp > limitTime);
  tokenUsage.set(keyId, updated);
  return updated.reduce((sum, item) => sum + item.tokens, 0);
}

export function getDailyRequestCount(keyId) {
  const now = Date.now();
  const limitTime = now - 24 * 60 * 60 * 1000; // 24 hours
  const history = requestCount.get(keyId) || [];
  const updated = history.filter(ts => ts > limitTime);
  requestCount.set(keyId, updated);
  return updated.length;
}
