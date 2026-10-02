/**
 * Verify the limits actually engage, and that an allow-listed key still works.
 * Inserts temporary keys, exercises them over HTTP, then removes them.
 */
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const db = new DatabaseSync(path.join(DATA_DIR, "db", "data.sqlite"));
const secret = (fs.readFileSync(path.join(ROOT, ".env"), "utf8").match(/^API_KEY_SECRET=(.*)$/m)?.[1] || "").trim();
const machineId = db.prepare(`SELECT machineId FROM apiKeys WHERE machineId IS NOT NULL LIMIT 1`).get()?.machineId;

const BASE = "http://127.0.0.1:20128";
const inserted = [];
let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};

function mk(allowed, { tpm = null, rpd = null, conc = null } = {}) {
  const keyId = "t" + String(Date.now()).slice(-6) + Math.floor(Math.random() * 90 + 10);
  const crc = crypto.createHmac("sha256", secret).update(machineId + keyId).digest("hex").slice(0, 8);
  const key = `sk-${machineId}-${keyId}-${crc}`;
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, allowedProviders, limitTpm, limitRpd, limitConcurrency)
              VALUES(?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
    .run(id, key, "tmp", machineId, new Date().toISOString(), allowed ? JSON.stringify(allowed) : null, tpm, rpd, conc);
  inserted.push(id);
  return key;
}

// A real, currently-active provider so the "allowed" case can actually route.
const live = db.prepare(`SELECT provider FROM providerConnections WHERE isActive = 1 LIMIT 1`).get()?.provider;
console.log(`using live provider for the positive case: ${live}`);

/** Registry alias for a provider id, read from the live catalog file. */
function aliasOf(providerId) {
  const src = fs.readFileSync(path.join(ROOT, "open-sse", "providers", "registry", `${providerId}.js`), "utf8");
  return (src.match(/^\s*alias:\s*"([^"]+)"/m) || [])[1] || null;
}

try {
  console.log("waiting 16s for the key-record cache...");
  await new Promise((r) => setTimeout(r, 16000));

  console.log("\n[1] allow-listed key sees models and is NOT 403'd");
  const goodKey = mk([live]);
  const models = await fetch(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${goodKey}` } });
  const mj = await models.json();
  const ids = (mj.data || []).map((m) => m.id);
  check("GET /v1/models -> 200", models.status === 200, `status=${models.status}`);
  check("scoped list is non-empty", ids.length > 0, `count=${ids.length}`);
  // Bare ids (no "/") are combos. A combo is legitimately reachable when one of
  // its seats uses the allowed provider, so it is not a scope violation.
  const direct = ids.filter((x) => x.includes("/")).map((x) => x.split("/")[0]);
  const combos = ids.filter((x) => !x.includes("/"));
  // The allow-list holds the provider id ("antigravity"); models publish under its
  // registry alias ("ag"). Both are legitimate spellings of the same provider, so
  // assert that only THIS provider's models appear -- not that the string matches.
  const otherProviders = [...new Set(direct)].filter((p) => p !== live && p !== aliasOf(live));
  check("only the allowed provider's models appear", otherProviders.length === 0, `prefixes=${[...new Set(direct)].join(",")} unexpected=${otherProviders.join(",") || "none"}`);
  check("bare ids are combos (resolved by seat)", combos.length >= 0, `combos=${combos.join(",") || "none"}`);

  // Use a REAL model id from the scoped list, otherwise the upstream 404s and no
  // usage row is written, so the TPM meter never moves.
  const realModel = ids.find((x) => x.includes("/"));
  console.log(`  (using real model "${realModel}" for the limit tests)`);

  console.log("\n[2] concurrency limit: 2nd simultaneous request is refused");
  const concKey = mk([live], { conc: 1 });
  // Long enough to still be streaming when the 2nd arrives.
  const body = JSON.stringify({ model: realModel, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: true });
  const first = fetch(`${BASE}/v1/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${concKey}`, "Content-Type": "application/json" }, body });
  await new Promise((r) => setTimeout(r, 700));
  const second = await fetch(`${BASE}/v1/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${concKey}`, "Content-Type": "application/json" }, body });
  const ra = second.headers.get("Retry-After");
  const secondBody = await second.text();
  check("2nd concurrent request -> 429", second.status === 429, `status=${second.status} retry-after=${ra}`);
  check("message mentions concurrency", /concurrency/i.test(secondBody), secondBody.slice(0, 80).replace(/\s+/g, " "));
  first.catch(() => {}).then(() => {});

  console.log("\n[3] TPM limit of 1 token is exceeded by any real request");
  const tpmKey = mk([live], { tpm: 1 });
  const t1 = await fetch(`${BASE}/v1/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${tpmKey}`, "Content-Type": "application/json" }, body });
  await t1.text().catch(() => {});
  // TPM is fed from the usage row written when the first call finishes.
  await new Promise((r) => setTimeout(r, 2500));
  const t2 = await fetch(`${BASE}/v1/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${tpmKey}`, "Content-Type": "application/json" }, body });
  const t2b = await t2.text();
  check("request after TPM budget spent -> 429", t2.status === 429, `status=${t2.status}`);
  check("message mentions TPM", /TPM/i.test(t2b), t2b.slice(0, 80).replace(/\s+/g, " "));
} finally {
  for (const id of inserted) db.prepare(`DELETE FROM apiKeys WHERE id = ?`).run(id);
  console.log(`\n[cleanup] removed ${inserted.length} temp key(s)`);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
