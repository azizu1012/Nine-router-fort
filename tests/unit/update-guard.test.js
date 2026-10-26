// The fork keeps the upstream version check but must never run the public npm
// updater: `npm i -g 9router` would replace the fork and drop local changes.
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/lib/appUpdater", () => ({
  killAppProcesses: vi.fn(async () => {}),
  spawnUpdaterAndExit: vi.fn(),
}));

const { POST: updatePOST } = await import("../../src/app/api/version/update/route.js");
const { POST: shutdownPOST } = await import("../../src/app/api/version/shutdown/route.js");

const KEYS = ["DISABLE_IN_APP_UPDATE", "DISABLE_UPDATE_CHECK"];
const saved = {};

function restoreEnv() {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

afterEach(restoreEnv);

describe("self-managed fork update guard", () => {
  it("is disabled by default when DISABLE_IN_APP_UPDATE is unset", async () => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    expect((await updatePOST()).status).toBe(403);
    expect((await shutdownPOST()).status).toBe(403);
  });

  it("stays disabled with DISABLE_IN_APP_UPDATE=true even when the version check is on", async () => {
    saved.DISABLE_IN_APP_UPDATE = process.env.DISABLE_IN_APP_UPDATE;
    saved.DISABLE_UPDATE_CHECK = process.env.DISABLE_UPDATE_CHECK;
    process.env.DISABLE_IN_APP_UPDATE = "true";
    process.env.DISABLE_UPDATE_CHECK = "false";
    expect((await updatePOST()).status).toBe(403);
    expect((await shutdownPOST()).status).toBe(403);
  });
});
