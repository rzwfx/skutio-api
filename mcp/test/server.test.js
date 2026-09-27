// Teste pentru serverul MCP: un client MCP real (din SDK) pornește serverul prin stdio,
// exact ca Claude Code, iar serverul vorbește cu un API Skutio fals, pornit local.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const SECRET = "test-secret";
let api, apiUrl;
const seen = []; // cererile primite de API-ul fals

// API fals: aceleași rute și coduri ca serverul real.
before(async () => {
  api = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, key: req.headers["x-skutio-key"], body: raw });
      const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/stats") return send(200, { enabled: true, total: 12, last_24h: 3, dangerous: 7, suspicious: 1, safe: 4, avg_duration_ms: 5400 });
      if (req.headers["x-skutio-key"] !== SECRET) return send(401, { error: "unauthorized" });
      const body = JSON.parse(raw || "{}");
      if (req.url === "/api/analyze") {
        if (body.text.includes("rate")) return send(429, { error: "rate_limited" });
        return send(200, {
          verdict: "dangerous", score: 95, summary: "Mesaj fals care imită un curier.",
          redFlags: ["Domeniu fals", "Urgență artificială"], links: ["https://curier-fals.top"], advice: "Nu da click.",
        });
      }
      if (req.url === "/api/trustcheck") {
        return send(200, {
          domain: "emag.ro", score: 95, verdict: "trusted", confidence: "high", summary: "Retailer cunoscut.",
          signals: [{ label: "Brand", value: "cunoscut", good: true }], explanation: "E un site legitim.", advice: "Poți cumpăra.",
        });
      }
      send(404, { error: "not_found" });
    });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${api.address().port}`;
});

after(() => api.close());

// Pornește serverul MCP ca proces separat, cu configurația dată, și conectează un client.
async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, "..", "server.js")],
    env: { PATH: process.env.PATH, SKUTIO_API_URL: apiUrl, SKUTIO_SECRET_FILE: "/nonexistent", ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

test("expune cele 3 unelte, toate read-only", async () => {
  const client = await connect({ SKUTIO_APP_SECRET: SECRET });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["analyze_message", "check_website", "get_stats"]);
  for (const t of tools) assert.equal(t.annotations.readOnlyHint, true, t.name);
  await client.close();
});

test("analyze_message trimite textul cu cheia și formatează verdictul", async () => {
  const client = await connect({ SKUTIO_APP_SECRET: SECRET });
  const r = await client.callTool({ name: "analyze_message", arguments: { text: "Platiti taxa aici" } });
  assert.equal(r.isError, undefined);
  const text = r.content[0].text;
  assert.match(text, /Verdict: PERICULOS \(risc 95\/100\)/);
  assert.match(text, /- Domeniu fals/);
  assert.match(text, /Recomandare: Nu da click\./);
  assert.equal(r.structuredContent.score, 95);
  const last = seen.at(-1);
  assert.equal(last.url, "/api/analyze");
  assert.equal(last.key, SECRET);
  assert.deepEqual(JSON.parse(last.body), { text: "Platiti taxa aici" });
  await client.close();
});

test("check_website formatează scorul de încredere și semnalele", async () => {
  const client = await connect({ SKUTIO_APP_SECRET: SECRET });
  const r = await client.callTool({ name: "check_website", arguments: { url: "emag.ro" } });
  assert.match(r.content[0].text, /emag\.ro: DE ÎNCREDERE \(încredere 95\/100/);
  assert.match(r.content[0].text, /✓ Brand: cunoscut/);
  await client.close();
});

test("get_stats merge fără cheie", async () => {
  const client = await connect({});
  const r = await client.callTool({ name: "get_stats", arguments: {} });
  assert.match(r.content[0].text, /Analize în total: 12/);
  assert.equal(seen.at(-1).key, undefined);
  await client.close();
});

test("fără secret → eroare clară, fără cerere la API", async () => {
  const before = seen.length;
  const client = await connect({});
  const r = await client.callTool({ name: "analyze_message", arguments: { text: "test" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Lipsește secretul aplicației/);
  assert.equal(seen.length, before);
  await client.close();
});

test("secretul poate fi citit dintr-un fișier", async () => {
  const fs = require("fs");
  const os = require("os");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "skutio-mcp-")), "secret");
  fs.writeFileSync(file, SECRET + "\n", { mode: 0o600 });
  const client = await connect({ SKUTIO_SECRET_FILE: file });
  const r = await client.callTool({ name: "analyze_message", arguments: { text: "test" } });
  assert.equal(r.isError, undefined);
  await client.close();
});

test("cheie greșită → eroare 401 explicată", async () => {
  const client = await connect({ SKUTIO_APP_SECRET: "gresit" });
  const r = await client.callTool({ name: "analyze_message", arguments: { text: "test" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Cheia aplicației lipsește sau e greșită/);
  await client.close();
});

test("rate limiting (429) → eroare explicată", async () => {
  const client = await connect({ SKUTIO_APP_SECRET: SECRET });
  const r = await client.callTool({ name: "analyze_message", arguments: { text: "rate" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Prea multe cereri/);
  await client.close();
});

test("text gol → respins de validarea din schema, fără cerere la API", async () => {
  const before = seen.length;
  const client = await connect({ SKUTIO_APP_SECRET: SECRET });
  const r = await client.callTool({ name: "analyze_message", arguments: { text: "   " } });
  assert.equal(r.isError, true);
  assert.equal(seen.length, before);
  await client.close();
});

test("API indisponibil → eroare de conexiune explicată", async () => {
  const client = await connect({ SKUTIO_APP_SECRET: SECRET, SKUTIO_API_URL: "http://127.0.0.1:1" });
  const r = await client.callTool({ name: "analyze_message", arguments: { text: "test" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Nu mă pot conecta/);
  await client.close();
});
