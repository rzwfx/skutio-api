// api/analyze.js — Skutio AI proxy: analiza de mesaje scam prin Claude API.
// Proxează analiza de mesaje scam către Claude API. Cheia API stă DOAR pe server.
// Necesită env ANTHROPIC_API_KEY (vezi .env.example).

const { isAuthorized, setCors } = require("../lib/auth");
const { loadPrompt } = require("../lib/prompts");
const { recordAnalysis } = require("../lib/db");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
// Configurabil din env. Default Sonnet 4.6 — pre-revenue ținem costul jos (vezi regula "free tools until revenue").
// Când încasezi și vrei acuratețe maximă: pune AI_MODEL=claude-opus-4-8.
const MODEL = process.env.AI_MODEL || "claude-sonnet-4-6";

// Promptul de producție stă pe server (vezi lib/prompts.js); acesta e doar exemplul din repo.
const SYSTEM_PROMPT = loadPrompt("analyze", `You are a scam-detection assistant. Analyze the user-provided message (or screenshot)
for signs of scam, phishing or fraud.

Respond with ONLY a raw JSON object, exactly this shape:
{
  "verdict": "safe" | "suspicious" | "dangerous",
  "score": <integer 0-100, higher = more dangerous>,
  "summary": "<one short sentence>",
  "redFlags": ["<short red flag>"],
  "links": ["<every URL found, verbatim>"],
  "advice": "<one short recommendation>"
}
Reply in the same language as the analyzed message.`);

// Extrage primul obiect JSON dintr-un text (model-ul ar trebui să dea JSON curat, dar fim defensivi)
function extractJson(text) {
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}

// Logica de analiză, separată de HTTP ca să poată fi refolosită (ex. /demo).
// Întoarce { status, body } — handler-ul doar o traduce în răspuns HTTP.
async function analyzeMessage({ text = "", image = "", mediaType } = {}, apiKey = process.env.ANTHROPIC_API_KEY) {
  if (!apiKey) return { status: 500, body: { error: "server_not_configured" } };

  text = String(text).trim();
  image = image ? String(image) : "";

  // Construiește conținutul user-ului: imagine (screenshot) sau text
  let userContent;
  if (image) {
    const b64 = image.replace(/^data:[^;]+;base64,/, "");
    if (b64.length > 7_000_000) return { status: 400, body: { error: "image_too_large" } };
    const media = mediaType === "image/jpeg" ? "image/jpeg" : "image/png";
    userContent = [
      { type: "image", source: { type: "base64", media_type: media, data: b64 } },
      { type: "text", text: "Analyze this screenshot for scams. Read any visible text and links, then assess." },
    ];
  } else {
    if (!text) return { status: 400, body: { error: "empty_text" } };
    if (text.length > 5000) return { status: 400, body: { error: "text_too_long" } };
    userContent = text;
  }

  const aiResp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!aiResp.ok) return { status: 502, body: { error: "ai_upstream_error", status: aiResp.status } };

  const data = await aiResp.json();
  const raw = data?.content?.[0]?.text ?? "";
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed.verdict !== "string") return { status: 502, body: { error: "ai_parse_error" } };

  return {
    status: 200,
    body: {
      verdict: parsed.verdict,
      score: typeof parsed.score === "number" ? parsed.score : 0,
      summary: parsed.summary || "",
      redFlags: Array.isArray(parsed.redFlags) ? parsed.redFlags : [],
      links: Array.isArray(parsed.links) ? parsed.links : [],
      advice: parsed.advice || "",
    },
  };
}

async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  // Gate anti-abuz: secret partajat din aplicație (vezi lib/auth.js).
  if (!isAuthorized(req)) return res.status(401).json({ error: "unauthorized" });

  // TODO (RevenueCat): verifică entitlement Pro + rate-limit free tier aici, înainte de a chema Claude.

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const started = Date.now();
    const { status, body: out } = await analyzeMessage({ text: body.text || "", image: body.image, mediaType: body.mediaType });
    if (status === 200) {
      // Doar metadate — textul/imaginea nu se salvează. Fără await: răspunsul nu așteaptă baza de date.
      recordAnalysis({
        source: "api",
        inputType: body.image ? "image" : "text",
        inputChars: body.image ? null : String(body.text || "").trim().length,
        verdict: out.verdict,
        score: out.score,
        durationMs: Date.now() - started,
      });
    }
    return res.status(status).json(out);
  } catch (err) {
    return res.status(500).json({ error: "internal_error" });
  }
}

module.exports = handler;
module.exports.analyzeMessage = analyzeMessage;
