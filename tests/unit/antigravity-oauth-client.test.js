// SECURITY: OAuth client credentials must come from env only — never hardcoded in the repo.
import { describe, it, expect, beforeAll } from "vitest";

const EXPECTED = {
  clientId: process.env.ANTIGRAVITY_CLIENT_ID,
  clientSecret: process.env.ANTIGRAVITY_CLIENT_SECRET,
};
const GOOGLE = {
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
};

describe("antigravity oauth client (env-only)", () => {
  beforeAll(() => {
    // Registry modules snapshot process.env at import time, so seed before any import.
    if (process.env.ANTIGRAVITY_CLIENT_ID === undefined) process.env.ANTIGRAVITY_CLIENT_ID = "test-antigravity-id";
    if (process.env.ANTIGRAVITY_CLIENT_SECRET === undefined) process.env.ANTIGRAVITY_CLIENT_SECRET = "test-antigravity-secret";
    if (process.env.GOOGLE_CLIENT_ID === undefined) process.env.GOOGLE_CLIENT_ID = "test-google-id";
    if (process.env.GOOGLE_CLIENT_SECRET === undefined) process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
  });

  it("shared source reads the canonical credentials from env", async () => {
    const { ANTIGRAVITY_OAUTH_CLIENT } = await import("../../open-sse/providers/shared.js");
    expect(ANTIGRAVITY_OAUTH_CLIENT.clientId).toBe(process.env.ANTIGRAVITY_CLIENT_ID);
    expect(ANTIGRAVITY_OAUTH_CLIENT.clientSecret).toBe(process.env.ANTIGRAVITY_CLIENT_SECRET);
  });

  it("registry transport keeps clientId/clientSecret from env", async () => {
    const ag = (await import("../../open-sse/providers/registry/antigravity.js")).default;
    expect(ag.transport.clientId).toBe(process.env.ANTIGRAVITY_CLIENT_ID);
    expect(ag.transport.clientSecret).toBe(process.env.ANTIGRAVITY_CLIENT_SECRET);
  });

  it("google client shared by gemini + gemini-cli, from env", async () => {
    const { GOOGLE_OAUTH_CLIENT } = await import("../../open-sse/providers/shared.js");
    expect(GOOGLE_OAUTH_CLIENT.clientId).toBe(process.env.GOOGLE_CLIENT_ID);
    expect(GOOGLE_OAUTH_CLIENT.clientSecret).toBe(process.env.GOOGLE_CLIENT_SECRET);
    const gemini = (await import("../../open-sse/providers/registry/gemini.js")).default;
    const gc = (await import("../../open-sse/providers/registry/gemini-cli.js")).default;
    expect(gemini.transport.clientSecret).toBe(process.env.GOOGLE_CLIENT_SECRET);
    expect(gc.transport.clientSecret).toBe(process.env.GOOGLE_CLIENT_SECRET);
  });

  // Guard: no literal Google client secret may reappear anywhere in the runtime source tree.
  it("no hardcoded OAuth secrets in the runtime source tree", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const roots = [join(here, "../../open-sse"), join(here, "../../src")];
    const pattern = new RegExp(`${"GOCS"}PX-[A-Za-z0-9_-]{20,}`);
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(js|mjs|cjs|json)$/.test(entry)) continue;
        if (pattern.test(readFileSync(full, "utf8"))) offenders.push(full);
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });

  // Guard: oauth.js must spread shared clients + derive from registry (PROVIDER_OAUTH).
  it("src oauth.js imports shared client + keeps full shape", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../../src/lib/oauth/constants/oauth.js"), "utf8");
    expect(src).toContain('import { ANTIGRAVITY_OAUTH_CLIENT, GOOGLE_OAUTH_CLIENT } from "open-sse/providers/shared.js"');
    expect(src).toContain("...ANTIGRAVITY_OAUTH_CLIENT");
    expect(src).toContain("...GOOGLE_OAUTH_CLIENT");
    // authorizeUrl now lives in registry; oauth.js derives via PROVIDER_OAUTH spread
    expect(src).toContain('PROVIDER_OAUTH["antigravity"]');
    expect(src).toContain('PROVIDER_OAUTH["gemini-cli"]');
  });
});
