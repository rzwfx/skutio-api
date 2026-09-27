// lib/db.js — PostgreSQL: jurnalul analizelor și statistici.
//
// Conexiunea folosește variabilele standard PG* (PGHOST, PGDATABASE, PGUSER) sau
// DATABASE_URL. Pe server: socket Unix + peer auth, deci fără parolă (vezi README).
// Fără nicio variabilă setată, baza de date e dezactivată și API-ul merge normal:
// înregistrarea e opțională și nu blochează niciodată un răspuns către utilizator.

const { Pool } = require("pg");

const VERDICTS = new Set(["safe", "suspicious", "dangerous"]);
const STATS_TTL_MS = 60 * 1000;

let pool = null;

function isEnabled() {
  return Boolean(process.env.DATABASE_URL || process.env.PGDATABASE);
}

function getPool() {
  if (!isEnabled()) return null;
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 3000 });
    pool.on("error", (e) => console.error("db pool error:", e.message));
  }
  return pool;
}

// Salvează metadatele unei analize reușite. Nu aruncă niciodată: o problemă cu baza
// de date se loghează, dar utilizatorul își primește verdictul oricum.
async function recordAnalysis({ source, inputType, inputChars, verdict, score, durationMs }) {
  const db = getPool();
  if (!db || !VERDICTS.has(verdict)) return false;
  try {
    await db.query(
      `INSERT INTO analyses (source, input_type, input_chars, verdict, score, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [source, inputType, inputChars ?? null, verdict, Math.max(0, Math.min(100, Math.round(score) || 0)), Math.max(0, Math.round(durationMs))],
    );
    statsCache = null; // următoarea cerere la /stats vede noua analiză
    return true;
  } catch (e) {
    console.error("db insert error:", e.message);
    return false;
  }
}

const STATS_SQL = `
  SELECT
    count(*)::int                                                        AS total,
    count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last_24h,
    count(*) FILTER (WHERE verdict = 'dangerous')::int                   AS dangerous,
    count(*) FILTER (WHERE verdict = 'suspicious')::int                  AS suspicious,
    count(*) FILTER (WHERE verdict = 'safe')::int                        AS safe,
    round(avg(duration_ms))::int                                         AS avg_duration_ms,
    min(created_at)                                                      AS since
  FROM analyses`;

let statsCache = null; // { at, body }

// Statistici agregate, ținute în memorie un minut ca pagina să nu interogheze baza la fiecare vizită.
async function getStats() {
  const db = getPool();
  if (!db) return { status: 200, body: { enabled: false } };
  if (statsCache && Date.now() - statsCache.at < STATS_TTL_MS) return { status: 200, body: statsCache.body };
  try {
    const { rows } = await db.query(STATS_SQL);
    const body = { enabled: true, ...rows[0], generatedAt: new Date().toISOString() };
    statsCache = { at: Date.now(), body };
    return { status: 200, body };
  } catch (e) {
    console.error("db stats error:", e.message);
    return { status: 503, body: { error: "stats_unavailable" } };
  }
}

async function close() {
  if (pool) await pool.end();
  pool = null;
  statsCache = null;
}

module.exports = { isEnabled, getPool, recordAnalysis, getStats, close, STATS_SQL };
