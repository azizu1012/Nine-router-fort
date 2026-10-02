/**
 * End-to-end proof of the per-API-key gate against the running server.
 *
 * Inserts a temporary scoped+limited key straight into the DB, exercises it over
 * HTTP, then removes it. Nothing sensitive is printed.
 */
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DB = path.join(DATA_DIR, "db", "data.sqlite");

// API_KEY_SECRET out of .env, mirroring how the app generates key ids.
const envText = fs.existsSync(path.join(ROOT, ".env")) ? fs.readFileSync(path.join(ROOT, ".env"), "utf8") : "";
const secret = (envText.match(/^API_KEY_SECRET=(.*)$/m)?.[1] || process.env.API_KEY_SECRET || "").trim();

const db = new DatabaseSync(DB);
db.exec("PRAGMA busy_timeout = 5000");

const machineId = db.prepare(`SELECT machineId FROM apiKeys WHERE machineId IS NOT NULL LIMIT 1`).get()?.machineId;
if (!machineId) { console.log("no machineId available; aborting"); process.exit(1); }

function makeKey(keyId) {
  const crc = crypto.createHmac("sha256", secret).update(machineId + keyId).digest("hex").slice(0, 8);
  return `sk-${machineId}-${keyId}-${crc}`;
}

const id = crypto.randomUUID();
const keyId = "verify" + String(Date.now()).slice(-6);
const key = makeKey(keyId);
// Scope to a provider the user does not run, plus a hard concurrency cap of 1.
const allowed = JSON.stringify(["__no_such_provider__"]);
const createdAt = new Date().toISOString();

db.prepare(`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, allowedProviders, limitTpm, limitRpd, limitConcurrency)
            VALUES(?, ?, ?, ?, 1, ?, ?, 999999, 999999, 1)`)
  .run(id, key, "verify-temp", machineId, createdAt, allowed);

const BASE = "http://127.0.0.1:20128";
const auth = { Authorization: `Bearer ${key}` };
let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};

try {
  // The server memoises key records for 15s, so a fresh insert needs a beat.
  console.log("[1] waiting 16s for the key-record cache to expire...");
  await new Promise((r) => setTimeout(r, 16000));

  console.log("\n[2] /v1/models must be scoped to the allow-list (empty here)");
  const m = await fetch(`${BASE}/v1/models`, { headers: auth });
  const body = await m.json();
  check("GET /v1/models -> 200", m.status === 200, `status=${m.status}`);
  check("model list filtered to 0", Array.isArray(body.data) && body.data.length === 0, `count=${body.data?.length}`);

  console.log("\n[3] chat on a disallowed provider must be 403");
  const chat = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "ag/gemini-3.8-flash", messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
  });
  const chatBody = await chat.text();
  check("POST /v1/chat/completions -> 403", chat.status === 403, `status=${chat.status}`);
  check("message names the provider", /not authorized/i.test(chatBody), chatBody.slice(0, 90).replace(/\s+/g, " "));

  console.log("\n[4] paused key is rejected");
  db.prepare(`UPDATE apiKeys SET isActive = 0 WHERE id = ?`).run(id);
  await new Promise((r) => setTimeout(r, 16000));
  const paused = await fetch(`${BASE}/v1/models`, { headers: auth });
  check("paused key -> 401/403", [401, 403].includes(paused.status), `status=${paused.status}`);
  db.prepare(`UPDATE apiKeys SET isActive = 1 WHERE id = ?`).run(id);
} finally {
  db.prepare(`DELETE FROM apiKeys WHERE id = ?`).run(id);
  console.log("\n[cleanup] temp key removed");
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
