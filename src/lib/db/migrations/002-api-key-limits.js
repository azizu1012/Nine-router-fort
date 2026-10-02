// Per-API-key access scoping + rate/concurrency limits.
// Additive and idempotent: existing keys keep NULL/empty values (all providers, unlimited).
export default {
  version: 2,
  name: "api-key-limits",
  up(db) {
    const existing = new Set(db.all(`PRAGMA table_info(apiKeys)`).map((r) => r.name));
    const add = (name, def) => {
      if (existing.has(name)) return;
      db.exec(`ALTER TABLE apiKeys ADD COLUMN ${name} ${def}`);
    };
    add("allowedProviders", "TEXT");
    add("limitTpm", "INTEGER");
    add("limitRpd", "INTEGER");
    add("limitConcurrency", "INTEGER");
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)`);
  },
};
