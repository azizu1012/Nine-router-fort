import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToKey(row) {
  if (!row) return null;
  let allowedProviders = null;
  if (row.allowedProviders) {
    try {
      allowedProviders = JSON.parse(row.allowedProviders);
    } catch (e) {
      allowedProviders = null;
    }
  }
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    allowedProviders,
    limitTpm: row.limitTpm || null,
    limitRpd: row.limitRpd || null,
    limitConcurrency: row.limitConcurrency || null,
  };
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
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, options = {}) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");

  let customKeyId = null;
  if (options.customPrefix) {
    const cleanPrefix = options.customPrefix.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
    let random4 = "";
    for (let i = 0; i < 4; i++) {
      random4 += Math.floor(Math.random() * 10);
    }
    customKeyId = `${cleanPrefix}_${random4}`;
  }

  const result = generateApiKeyWithMachine(machineId, customKeyId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    allowedProviders: options.allowedProviders ? JSON.stringify(options.allowedProviders) : null,
    limitTpm: options.limitTpm || null,
    limitRpd: options.limitRpd || null,
    limitConcurrency: options.limitConcurrency || null,
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, allowedProviders, limitTpm, limitRpd, limitConcurrency) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      apiKey.id,
      apiKey.key,
      apiKey.name,
      apiKey.machineId,
      1,
      apiKey.createdAt,
      apiKey.allowedProviders,
      apiKey.limitTpm,
      apiKey.limitRpd,
      apiKey.limitConcurrency,
    ]
  );
  return {
    ...apiKey,
    allowedProviders: options.allowedProviders || null,
  };
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };

    const allowedProvidersStr = Array.isArray(merged.allowedProviders)
      ? JSON.stringify(merged.allowedProviders)
      : (typeof merged.allowedProviders === "string" ? merged.allowedProviders : null);

    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, allowedProviders = ?, limitTpm = ?, limitRpd = ?, limitConcurrency = ? WHERE id = ?`,
      [
        merged.key,
        merged.name,
        merged.machineId,
        merged.isActive ? 1 : 0,
        allowedProvidersStr,
        merged.limitTpm || null,
        merged.limitRpd || null,
        merged.limitConcurrency || null,
        id
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
