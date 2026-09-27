// Teste PostgreSQL pe o bază de date REALĂ (în CI: container postgres:16).
// Rulează doar dacă DATABASE_URL e setat; altfel sunt sărite. ATENȚIE: șterge tabelele din baza dată.
// Local: DATABASE_URL=postgres://.../skutio_test npm test

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const skip = !process.env.DATABASE_URL && "setează DATABASE_URL ca să rulezi testele PostgreSQL";

process.env.SKUTIO_APP_SECRET = "test-secret";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.PROMPTS_DIR = "/nonexistent";

const db = require("../lib/db");
const { migrate } = require("../scripts/migrate");
const { createServer } = require("../server");

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith("https://api.anthropic.com/")) return realFetch(url, opts);
  const verdict = { verdict: "dangerous", score: 91, summary: "Fals.", redFlags: [], links: [], advice: "Nu." };
  return Response.json({ content: [{ type: "text", text: JSON.stringify(verdict) }] });
};

let server, base;
const origLog = console.log;
const origErr = console.error;

before(async () => {
  if (skip) return;
  console.log = () => {};
  console.error = () => {};
  await db.getPool().query("DROP TABLE IF EXISTS analyses, schema_migrations");
  server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  console.log = origLog;
  console.error = origErr;
  globalThis.fetch = realFetch;
  if (server) server.close();
  await db.close();
});

const count = async () => (await db.getPool().query("SELECT count(*)::int AS n FROM analyses")).rows[0].n;
const tick = () => new Promise((r) => setTimeout(r, 50)); // înregistrarea se face după răspuns

test("migrațiile se aplică o dată, apoi sunt idempotente", { skip }, async () => {
  assert.equal(await migrate({ log: () => {} }), 1);
  assert.equal(await migrate({ log: () => {} }), 0);
  const { rows } = await db.getPool().query("SELECT version FROM schema_migrations");
  assert.deepEqual(rows.map((r) => r.version), ["001_create_analyses.sql"]);
});

test("recordAnalysis salvează metadatele", { skip }, async () => {
  const ok = await db.recordAnalysis({ source: "demo", inputType: "text", inputChars: 42, verdict: "safe", score: 3, durationMs: 1200 });
  assert.equal(ok, true);
  const { rows } = await db.getPool().query("SELECT source, input_type, input_chars, verdict, score, duration_ms FROM analyses");
  assert.deepEqual(rows[0], { source: "demo", input_type: "text", input_chars: 42, verdict: "safe", score: 3, duration_ms: 1200 });
});

test("verdict necunoscut → nu se salvează", { skip }, async () => {
  const before = await count();
  assert.equal(await db.recordAnalysis({ source: "api", inputType: "text", verdict: "maybe", score: 50, durationMs: 1 }), false);
  assert.equal(await count(), before);
});

test("constrângerile din tabel resping date invalide", { skip }, async () => {
  await assert.rejects(
    db.getPool().query("INSERT INTO analyses (source, input_type, verdict, score, duration_ms) VALUES ('api','text','safe',150,1)"),
    /check constraint/,
  );
});

test("tabelul nu are nicio coloană pentru textul mesajului", { skip }, async () => {
  const { rows } = await db.getPool().query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'analyses' ORDER BY ordinal_position",
  );
  assert.deepEqual(rows.map((r) => r.column_name), ["id", "created_at", "source", "input_type", "input_chars", "verdict", "score", "duration_ms"]);
});

test("POST /api/analyze salvează o analiză (fără text)", { skip }, async () => {
  const before = await count();
  const r = await fetch(base + "/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-skutio-key": "test-secret" },
    body: JSON.stringify({ text: "Platiti taxa aici" }),
  });
  assert.equal(r.status, 200);
  await tick();
  assert.equal(await count(), before + 1);
  const { rows } = await db.getPool().query("SELECT source, input_chars, verdict, score FROM analyses ORDER BY id DESC LIMIT 1");
  assert.deepEqual(rows[0], { source: "api", input_chars: 17, verdict: "dangerous", score: 91 });
});

test("GET /stats agregă corect din PostgreSQL", { skip }, async () => {
  const r = await fetch(base + "/stats");
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.enabled, true);
  assert.equal(s.total, await count());
  assert.equal(s.dangerous + s.suspicious + s.safe, s.total);
  assert.equal(s.last_24h, s.total);
  assert.ok(s.avg_duration_ms >= 0);
});
