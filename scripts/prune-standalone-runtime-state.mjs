/**
 * Remove runtime state from the Next.js standalone output.
 *
 * The file tracer cannot resolve every path the app touches at runtime
 * (homedir(), %APPDATA%, process.cwd()), so a few entries end up with an
 * over-broad trace and the standalone bundle picks up directories that must
 * never ship:
 *
 *   data/   DATA_DIR when it lives inside the project — the live SQLite DB with
 *           every provider OAuth token / API key, plus the 54MB cloudflared
 *           binary and the MITM CA.
 *   logs/   request/response logs, which can contain full prompt bodies.
 *
 * Leaving them in is a credential-disclosure problem (the bundle is a
 * deployable artifact and gets baked into Docker images), adds ~65MB, and makes
 * the build fail with ENOENT when a file is pruned while the copy is running.
 *
 * Idempotent and fail-soft: a missing directory is not an error.
 */
import fs from "node:fs";
import path from "node:path";

const STANDALONE = path.join(process.cwd(), ".next", "standalone");

// Only prune directories that are actually inside the standalone tree.
const TARGETS = ["data", "logs", "mitm-dumps"];

if (!fs.existsSync(STANDALONE)) {
  console.log("[prune-standalone] no standalone output, nothing to do");
  process.exit(0);
}

let removed = 0;
for (const name of TARGETS) {
  const target = path.join(STANDALONE, name);
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(STANDALONE) + path.sep)) {
    console.warn(`[prune-standalone] skip ${name}: resolves outside standalone`);
    continue;
  }
  if (!fs.existsSync(target)) continue;
  try {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`[prune-standalone] removed ${name}/`);
    removed++;
  } catch (err) {
    // Never fail the build over cleanup.
    console.warn(`[prune-standalone] could not remove ${name}/: ${err.message}`);
  }
}

console.log(`[prune-standalone] done (${removed} removed)`);
