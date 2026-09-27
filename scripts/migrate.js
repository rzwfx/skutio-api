// scripts/migrate.js — aplică migrațiile SQL din migrations/, în ordine, o singură dată.
// Fiecare migrație rulează într-o tranzacție: ori se aplică toată, ori deloc.
// Cele aplicate sunt ținute în tabelul schema_migrations. Rulare: npm run migrate

const fs = require("fs");
const path = require("path");
const { getPool, isEnabled, close } = require("../lib/db");

const DIR = path.join(__dirname, "..", "migrations");

async function migrate({ log = console.log } = {}) {
  if (!isEnabled()) throw new Error("Setează PGDATABASE (sau DATABASE_URL) ca să rulezi migrațiile.");
  const db = getPool();

  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const { rows } = await db.query("SELECT version FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.version));
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(DIR, file), "utf8");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      log(`aplicată: ${file}`);
      count++;
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`${file}: ${e.message}`);
    } finally {
      client.release();
    }
  }
  log(count ? `${count} migrații aplicate` : "baza de date e la zi");
  return count;
}

if (require.main === module) {
  migrate()
    .catch((e) => { console.error("migrare eșuată:", e.message); process.exitCode = 1; })
    .finally(close);
}

module.exports = { migrate };
