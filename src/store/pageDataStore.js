"use client";

import { CLIENT_STORE_TTL_MS } from "@/shared/constants/config";

/**
 * Client-side response cache for dashboard GET payloads.
 *
 * Every dashboard page re-fetched `/api/providers`, `/api/keys`, `/api/settings`
 * on mount, so each navigation re-ran the same queries and flashed a skeleton.
 * This holds the last payload per key and serves it on the next mount.
 *
 * Two independent mechanisms, because they have very different risk profiles:
 *
 *  1. In-flight dedup — always safe. Concurrent callers for the same key share
 *     one request, so a page that fans out to /api/providers + /api/provider-nodes
 *     + /api/settings + /api/combos issues each query exactly once.
 *  2. TTL cache — bounded by `read(key, ttlMs)`. The default is a short handoff
 *     window, not a freshness promise: long enough to cover back-and-forth
 *     navigation, short enough that a mutation elsewhere is picked up quickly.
 *     Callers that own their data (the providers list, API keys) pass a short
 *     TTL and also `invalidate()` on write.
 *
 * Deliberately a plain module singleton, not a React store: reads go through
 * `read()` (no subscription, no re-render) and writes only mutate memory. A
 * zustand store here would re-render every mounted page on every cache write.
 */

/** Navigation-handoff window: absorbs re-mounts without promising freshness. */
export const DEFAULT_HANDOFF_TTL_MS = 5000;
/** Read-mostly diagnostics (tool config probes, service status). */
export const STATUS_TTL_MS = CLIENT_STORE_TTL_MS;

const cache = new Map();
const lastAccess = new Map();
const inFlight = new Map();
const MAX_ENTRIES = 200;

function pruneIfNeeded() {
  if (cache.size <= MAX_ENTRIES) return;
  const sorted = [...lastAccess.entries()].sort((a, b) => a[1] - b[1]);
  for (const [key] of sorted) {
    if (cache.size <= MAX_ENTRIES) break;
    cache.delete(key);
    lastAccess.delete(key);
  }
}

/** Store `data` under `key` and stamp the current time. */
export function setCached(key, data) {
  if (!key) return;
  cache.set(key, { data, timestamp: Date.now() });
  lastAccess.set(key, Date.now());
  pruneIfNeeded();
}

/**
 * Cached value for `key` when it is younger than `ttlMs`, otherwise null.
 * Never subscribes to the cache, so a write cannot re-render the caller.
 */
export function read(key, ttlMs = DEFAULT_HANDOFF_TTL_MS) {
  if (!key) return null;
  const entry = cache.get(key);
  if (!entry) return null;
  lastAccess.set(key, Date.now());
  if (Date.now() - entry.timestamp > ttlMs) {
    cache.delete(key);
    lastAccess.delete(key);
    return null;
  }
  return entry.data;
}

/** Drop one key, every key matching a prefix, or the whole cache. */
export function invalidate(key) {
  if (!key) {
    cache.clear();
    lastAccess.clear();
    return;
  }
  for (const k of [...cache.keys()]) {
    if (k === key || k.startsWith(`${key}:`)) {
      cache.delete(k);
      lastAccess.delete(k);
    }
  }
}

/**
 * Run `fetcher` under `key`, sharing one in-flight request across callers.
 * Bypasses the cache entirely — this is the "I want it now" path.
 */
export async function dedupe(key, fetcher) {
  if (!key) return fetcher();
  const pending = inFlight.get(key);
  if (pending) return pending;
  const promise = (async () => {
    try {
      return await fetcher();
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

/**
 * Cache-first read: serve `key` when fresh, otherwise fetch (deduped), cache and
 * return. `ttlMs` controls how long the stored payload is reused.
 */
export async function fetchThrough(key, fetcher, ttlMs = DEFAULT_HANDOFF_TTL_MS) {
  const cached = read(key, ttlMs);
  if (cached !== null) return cached;
  const data = await dedupe(key, fetcher);
  setCached(key, data ?? null);
  return data ?? null;
}

/** Cache-key prefix -> request path prefixes that invalidate it on write. */
const INVALIDATION_MAP = [
  ["providers:", ["/api/providers", "/api/provider-nodes"]],
  ["api-keys", ["/api/keys"]],
  ["settings", ["/api/settings"]],
  ["combos:", ["/api/combos"]],
  ["proxy-pools:", ["/api/proxy-pools"]],
  ["mitm", ["/api/keys", "/api/models/alias", "/api/providers"]],
  ["usage-stats", ["/api/providers", "/api/provider-nodes", "/api/settings", "/api/combos", "/api/keys", "/api/pricing"]],
  ["usage-providers", ["/api/providers", "/api/provider-nodes"]],
  ["token-saver", ["/api/settings"]],
  ["profile-settings", ["/api/settings"]],
  ["cli-tools-status", ["/api/cli-tools", "/api/keys", "/api/providers"]],
  ["pxpipe", ["/api/pxpipe", "/api/settings"]],
  ["basic-chat-providers", ["/api/providers", "/api/provider-nodes"]],
];

function invalidateForRequest(method, url) {
  if (!url || (method || "GET").toUpperCase() === "GET" || method === "HEAD") return;
  for (const [key, prefixes] of INVALIDATION_MAP) {
    if (prefixes.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`))) {
      invalidate(key);
    }
  }
}

let interceptorInstalled = false;

/**
 * Drop cached reads whose source a write just changed.
 *
 * Installed once from the dashboard layout rather than at ~50 individual fetch
 * call sites: a mutation handler that forgets to invalidate is the one way this
 * cache could serve stale data, so the invalidation has to sit on the write path
 * itself. Reads still refetch on mount, so this only removes the stale window.
 */
export function installCacheInvalidationInterceptor() {
  if (interceptorInstalled || typeof window === "undefined") return;
  interceptorInstalled = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = function patchedFetch(input, init) {
    try {
      const url = typeof input === "string" ? input : input?.url;
      const method = init?.method || (typeof input === "object" && input ? input.method : undefined);
      const promise = originalFetch(input, init);
      // Invalidate optimistically on request dispatch: the handler's own refetch
      // is issued after this, so it must not read the pre-write snapshot.
      invalidateForRequest(method, url);
      return promise;
    } catch (err) {
      return originalFetch(input, init);
    }
  };
}

const usePageDataStore = {
  read,
  getData: read,
  setData: setCached,
  setCached,
  invalidate,
  dedupe,
  fetchWithCache: fetchThrough,
  fetchThrough,
};

export default usePageDataStore;
