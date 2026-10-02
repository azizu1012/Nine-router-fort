import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function parseList(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    allowedProviders: parseList(row.allowedProviders),
    limitTpm: row.limitTpm || null,
    limitRpd: row.limitRpd || null,
    limitConcurrency: row.limitConcurrency || null,
  };
}

function normalizeLimit(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, options = {}) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");

  // Optional human-readable key id, e.g. customPrefix="team" -> keyId "team_1234".
  let customKeyId = null;
  if (options.customPrefix) {
    const cleanPrefix = String(options.customPrefix).replace(/[^a-zA-Z0-9_]/g, "").toLowerCase().slice(0, 24);
    if (cleanPrefix) {
      let random4 = "";
      for (let i = 0; i < 4; i++) random4 += Math.floor(Math.random() * 10);
      customKeyId = `${cleanPrefix}_${random4}`;
    }
  }

  const result = generateApiKeyWithMachine(machineId, customKeyId);
  const allowedProviders = Array.isArray(options.allowedProviders) && options.allowedProviders.length
    ? options.allowedProviders
    : null;
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    allowedProviders,
    limitTpm: normalizeLimit(options.limitTpm),
    limitRpd: normalizeLimit(options.limitRpd),
    limitConcurrency: normalizeLimit(options.limitConcurrency),
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, allowedProviders, limitTpm, limitRpd, limitConcurrency) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt,
      apiKey.allowedProviders ? JSON.stringify(apiKey.allowedProviders) : null,
      apiKey.limitTpm, apiKey.limitRpd, apiKey.limitConcurrency,
    ]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    if ("allowedProviders" in data) {
      merged.allowedProviders = Array.isArray(data.allowedProviders) && data.allowedProviders.length
        ? data.allowedProviders
        : null;
    }
    for (const field of ["limitTpm", "limitRpd", "limitConcurrency"]) {
      if (field in data) merged[field] = normalizeLimit(data[field]);
    }
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, allowedProviders = ?, limitTpm = ?, limitRpd = ?, limitConcurrency = ? WHERE id = ?`,
      [
        merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0,
        merged.allowedProviders ? JSON.stringify(merged.allowedProviders) : null,
        merged.limitTpm, merged.limitRpd, merged.limitConcurrency, id,
      ]
    );
    result = merged;
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}
