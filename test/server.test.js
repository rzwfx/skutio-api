// Teste pentru server: rute, securitate, limite și demo — fără apeluri reale la Claude
// (fetch către Anthropic e înlocuit cu un răspuns fals). Rulare: npm test

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.SKUTIO_APP_SECRET = "test-secret";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.PROMPTS_DIR = "/nonexistent"; // folosește prompturile exemplu din cod

const { createServer } = require("../server");
const demo = require("../lib/demo");

const realFetch = globalThis.fetch;
let claudeCalls = 0;
let claudeFails = false;

// Răspuns fals în formatul Claude Messages API.
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith("https://api.anthropic.com/")) return realFetch(url, opts);
  claudeCalls++;
  if (claudeFails) return new Response("overloaded", { status: 529 });
  const verdict = { verdict: "dangerous", score: 95, summary: "Mesaj fals.", redFlags: ["Link suspect"], links: [], advice: "Nu da click." };
  return Response.json({ content: [{ type: "text", text: JSON.stringify(verdict) }] });
};

let server, base;
const origLog = console.log;

before(async () => {
  console.log = () => {}; // fără loguri de request în output-ul testelor
  server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  console.log = origLog;
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  claudeCalls = 0;
  claudeFails = false;
  demo._cache.clear();
});

const post = (path, body, headers = {}) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("GET /health → 200", async () => {
  const r = await fetch(base + "/health");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test("rută inexistentă → 404 JSON", async () => {
  const r = await fetch(base + "/nu-exista");
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, "not_found");
});

test("pagina de prezentare: HTML cu CSP strict și nosniff", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  assert.match(r.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(await r.text(), /Demo live/);
});

test("fișierele statice ale paginii există", async () => {
  for (const p of ["/style.css", "/app.js", "/favicon.svg"]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
  }
});

test("POST pe pagina statică → 405", async () => {
  const r = await post("/", {});
  assert.equal(r.status, 405);
});

test("GET /api/analyze → 405", async () => {
  const r = await fetch(base + "/api/analyze");
  assert.equal(r.status, 405);
});

test("/api/analyze fără cheia aplicației → 401, fără apel la Claude", async () => {
  const r = await post("/api/analyze", { text: "test" });
  assert.equal(r.status, 401);
  assert.equal(claudeCalls, 0);
});

test("/api/analyze cu cheie greșită → 401", async () => {
  const r = await post("/api/analyze", { text: "test" }, { "x-skutio-key": "gresit" });
  assert.equal(r.status, 401);
});

test("/api/analyze cu cheie corectă → verdict", async () => {
  const r = await post("/api/analyze", { text: "Platiti taxa aici: http://x.top" }, { "x-skutio-key": "test-secret" });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.verdict, "dangerous");
  assert.equal(d.score, 95);
  assert.equal(claudeCalls, 1);
});

test("/api/analyze cu text gol → 400", async () => {
  const r = await post("/api/analyze", { text: "   " }, { "x-skutio-key": "test-secret" });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "empty_text");
});

test("/api/analyze cu text peste 5000 caractere → 400", async () => {
  const r = await post("/api/analyze", { text: "a".repeat(5001) }, { "x-skutio-key": "test-secret" });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "text_too_long");
});

test("body peste 10 MB → 413 (răspuns, nu conexiune tăiată)", async () => {
  const r = await fetch(base + "/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-skutio-key": "test-secret" },
    body: "a".repeat(11 * 1024 * 1024),
  });
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error, "body_too_large");
});

test("/api/analyze: eroare de la Claude → 502", async () => {
  claudeFails = true;
  const r = await post("/api/analyze", { text: "test" }, { "x-skutio-key": "test-secret" });
  assert.equal(r.status, 502);
});

test("/demo/samples → lista mesajelor demo", async () => {
  const r = await fetch(base + "/demo/samples");
  assert.equal(r.status, 200);
  const { samples } = await r.json();
  assert.equal(samples.length, 3);
});

test("/demo: prima cerere e live, a doua vine din cache (un singur apel la Claude)", async () => {
  const a = await (await fetch(base + "/demo?sample=1")).json();
  const b = await (await fetch(base + "/demo?sample=1")).json();
  assert.equal(a.source, "live");
  assert.equal(b.source, "cache");
  assert.equal(a.result.verdict, "dangerous");
  assert.equal(claudeCalls, 1);
  assert.ok(a.server.node);
});

test("/demo: cereri simultane → un singur apel la Claude", async () => {
  await Promise.all(Array.from({ length: 5 }, () => fetch(base + "/demo?sample=2")));
  assert.equal(claudeCalls, 1);
});

test("/demo: Claude indisponibil → ultimul rezultat bun (stale)", async () => {
  await fetch(base + "/demo?sample=1");
  const entry = demo._cache.get(1);
  entry.analyzedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // expirat
  claudeFails = true;
  const r = await fetch(base + "/demo?sample=1");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).source, "stale");
});

test("/demo cu sample invalid → 400", async () => {
  const r = await fetch(base + "/demo?sample=99");
  assert.equal(r.status, 400);
  assert.equal(claudeCalls, 0);
});

test("/demo nu acceptă POST (nu poate fi folosit ca proxy gratuit)", async () => {
  const r = await post("/demo", { text: "orice" });
  assert.equal(r.status, 405);
  assert.equal(claudeCalls, 0);
});
