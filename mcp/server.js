#!/usr/bin/env node
// mcp/server.js — server MCP (Model Context Protocol) pentru Skutio.
//
// Dă unui agent AI (Claude Code, Claude Desktop sau orice client MCP) trei unelte care
// folosesc API-ul Skutio: analiza unui mesaj suspect, verificarea unui site și statistici.
// Comunică prin stdio: clientul pornește procesul și vorbește cu el pe stdin/stdout.
// De aceea nu scriem NIMIC pe stdout în afară de protocol; logurile merg pe stderr.
//
// Configurare (vezi README):
//   SKUTIO_API_URL      default https://api.skutio.app
//   SKUTIO_APP_SECRET   secretul aplicației; alternativ, citit din SKUTIO_SECRET_FILE
//   SKUTIO_SECRET_FILE  default ~/.config/skutio-mcp/secret (chmod 600)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const API_URL = (process.env.SKUTIO_API_URL || "https://api.skutio.app").replace(/\/+$/, "");
const SECRET_FILE = process.env.SKUTIO_SECRET_FILE || path.join(os.homedir(), ".config", "skutio-mcp", "secret");
const TIMEOUT_MS = 60_000; // Claude poate avea nevoie de 20-30 s la mesaje lungi

// Secretul se citește la fiecare apel: dacă e configurat după pornire, merge fără restart.
function readSecret() {
  if (process.env.SKUTIO_APP_SECRET) return process.env.SKUTIO_APP_SECRET.trim();
  try {
    return fs.readFileSync(SECRET_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

const VERDICT_RO = { dangerous: "PERICULOS", suspicious: "SUSPECT", safe: "SIGUR" };
const TRUST_RO = { trusted: "DE ÎNCREDERE", caution: "PRUDENȚĂ", high_risk: "RISC RIDICAT" };

// Mesaj clar pentru agent, ca să poată explica utilizatorului ce s-a întâmplat.
function httpError(status, body) {
  if (status === 401) return `Cheia aplicației lipsește sau e greșită. Configureaz-o în SKUTIO_APP_SECRET sau în ${SECRET_FILE}.`;
  if (status === 429) return "Prea multe cereri într-un minut (rate limiting). Încearcă din nou puțin mai târziu.";
  if (status === 400) return `Input invalid: ${body?.error || "cerere respinsă"}.`;
  return `API-ul Skutio a răspuns cu eroarea ${status}${body?.error ? ` (${body.error})` : ""}.`;
}

async function callApi(method, route, payload, { auth = true } = {}) {
  const headers = { Accept: "application/json" };
  if (payload) headers["Content-Type"] = "application/json";
  if (auth) {
    const secret = readSecret();
    if (!secret) throw new Error(`Lipsește secretul aplicației. Setează SKUTIO_APP_SECRET sau scrie-l în ${SECRET_FILE}.`);
    headers["x-skutio-key"] = secret;
  }
  let res;
  try {
    res = await fetch(API_URL + route, {
      method,
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Nu mă pot conecta la ${API_URL}: ${e.name === "TimeoutError" ? "timeout" : e.message}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(httpError(res.status, body));
  return body;
}

const ok = (text, data) => ({ content: [{ type: "text", text }], structuredContent: data });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: e.message }] });
const bullets = (items) => items.map((x) => `- ${x}`).join("\n");

function createServer() {
  const server = new McpServer({ name: "skutio", version: "1.0.0" });

  server.registerTool(
    "analyze_message",
    {
      title: "Analizează un mesaj suspect",
      description:
        "Verifică dacă un mesaj (SMS, WhatsApp, email, DM) e o țeapă, phishing sau fraudă. " +
        "Întoarce un verdict (safe / suspicious / dangerous), un scor de risc 0-100, semnalele de alarmă, " +
        "linkurile găsite și o recomandare. Răspunsul e în limba mesajului.",
      inputSchema: { text: z.string().trim().min(1).max(5000).describe("Textul complet al mesajului, copiat exact") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ text }) => {
      try {
        const r = await callApi("POST", "/api/analyze", { text });
        const lines = [
          `Verdict: ${VERDICT_RO[r.verdict] || r.verdict} (risc ${r.score}/100)`,
          r.summary,
          r.redFlags?.length ? `\nSemnale de alarmă:\n${bullets(r.redFlags)}` : "",
          r.links?.length ? `\nLinkuri găsite:\n${bullets(r.links)}` : "",
          r.advice ? `\nRecomandare: ${r.advice}` : "",
        ];
        return ok(lines.filter(Boolean).join("\n"), r);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "check_website",
    {
      title: "Verifică încrederea unui site",
      description:
        "Estimează cât de sigur e un site pentru un utilizator obișnuit, din vârsta domeniului și analiza AI. " +
        "Întoarce un scor de încredere 0-100 (mai mare = mai de încredere), verdict și semnale.",
      inputSchema: { url: z.string().trim().min(3).max(500).describe("Domeniul sau URL-ul, ex. emag.ro sau https://exemplu.com") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url }) => {
      try {
        const r = await callApi("POST", "/api/trustcheck", { url });
        const signals = (r.signals || []).map((s) => `${s.good ? "✓" : "✗"} ${s.label}: ${s.value}`);
        const lines = [
          `${r.domain}: ${TRUST_RO[r.verdict] || r.verdict} (încredere ${r.score}/100, siguranța evaluării: ${r.confidence})`,
          r.summary,
          signals.length ? `\nSemnale:\n${bullets(signals)}` : "",
          r.explanation ? `\n${r.explanation}` : "",
          r.advice ? `\nRecomandare: ${r.advice}` : "",
        ];
        return ok(lines.filter(Boolean).join("\n"), r);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_stats",
    {
      title: "Statistici Skutio",
      description: "Statistici agregate despre analizele făcute de serverul Skutio: total, ultimele 24h, verdicte, timp mediu.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const s = await callApi("GET", "/stats", null, { auth: false });
        if (!s.enabled) return ok("Statisticile nu sunt activate pe acest server.", s);
        const text =
          `Analize în total: ${s.total} (ultimele 24h: ${s.last_24h})\n` +
          `Periculoase: ${s.dangerous} · Suspecte: ${s.suspicious} · Sigure: ${s.safe}\n` +
          `Timp mediu de analiză: ${s.avg_duration_ms ? (s.avg_duration_ms / 1000).toFixed(1).replace(".", ",") + " s" : "–"}`;
        return ok(text, s);
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

if (require.main === module) {
  const server = createServer();
  server
    .connect(new StdioServerTransport())
    .then(() => console.error(`skutio-mcp pornit (API: ${API_URL})`))
    .catch((e) => {
      console.error("skutio-mcp nu a putut porni:", e);
      process.exit(1);
    });
}

module.exports = { createServer };
