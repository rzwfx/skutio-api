// api/trustcheck.js — Skutio Trust Check: scor de încredere pentru un website.
// Calculează un scor de încredere pentru un website: vârstă domeniu (RDAP public, gratuit)
// + raționament Claude. Limbaj prudent (scut legal).

const { isAuthorized, setCors } = require("../lib/auth");
const { loadPrompt } = require("../lib/prompts");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
// Default Sonnet 4.6 — pre-revenue ținem costul jos. AI_MODEL=claude-opus-4-8 când încasezi.
const MODEL = process.env.AI_MODEL || "claude-sonnet-4-6";

// Promptul de producție stă pe server (vezi lib/prompts.js); acesta e doar exemplul din repo.
const SYSTEM_PROMPT = loadPrompt("trustcheck", `You assess how trustworthy a website is, given its domain and the signals provided.
Never call a real business a scam; use hedged language when data is thin.

Respond with ONLY a raw JSON object, exactly this shape:
{
  "score": <integer 0-100, higher = more trustworthy>,
  "verdict": "trusted" | "caution" | "high_risk",
  "confidence": "low" | "medium" | "high",
  "summary": "<one short sentence>",
  "signals": [ { "label": "<short>", "value": "<short>", "good": true|false } ],
  "explanation": "<2-3 sentences>",
  "advice": "<one short recommendation>"
}
Reply in English.`);

function extractJson(text) {
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}

// Domeniul curat dintr-un URL/string
function extractDomain(input) {
  let s = (input || "").trim().toLowerCase();
  if (!s) return "";
  if (!s.startsWith("http://") && !s.startsWith("https://")) s = `https://${s}`;
  try {
    const host = new URL(s).hostname.replace(/^www\./, "");
    return host.includes(".") ? host : "";
  } catch { return ""; }
}

// Vârsta domeniului via RDAP public (gratuit, fără cheie). Returnează { ageDays, registered } sau null.
async function getDomainAge(domain) {
  try {
    const r = await fetch(`https://rdap.org/domain/${domain}`, { headers: { Accept: "application/rdap+json" } });
    if (!r.ok) return null;
    const data = await r.json();
    const ev = (data.events || []).find(e => e.eventAction === "registration");
    if (!ev || !ev.eventDate) return null;
    const reg = new Date(ev.eventDate);
    const ageDays = Math.floor((Date.now() - reg.getTime()) / 86400000);
    return { ageDays, registered: ev.eventDate.slice(0, 10) };
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  // Gate anti-abuz: secret partajat din aplicație (vezi server/lib/auth.js).
  if (!isAuthorized(req)) return res.status(401).json({ error: "unauthorized" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "server_not_configured" });

  // TODO (Faza 0/RevenueCat): verifică entitlement Pro + rate-limit free tier aici.

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const domain = extractDomain(body.url);
    if (!domain) return res.status(400).json({ error: "invalid_domain" });
    // Blacklist hit transmis de app (opțional) din Google Safe Browsing
    const blacklisted = body.blacklisted === true;

    const age = await getDomainAge(domain);
    const tld = domain.split(".").pop() || "";
    // ccTLD-uri ale căror registre NU publică data înregistrării — "unknown" = lacună de date, nu risc
    const NO_AGE_CCTLDS = new Set(["ro","de","fr","it","nl","be","at","ch","es","pl","cz","se","no","fi","dk","ie","pt","gr","hu","sk","bg","hr","si","lt","lv","ee"]);
    const ageStr = age
      ? `${age.ageDays} days (registered ${age.registered})`
      : NO_AGE_CCTLDS.has(tld)
        ? `unavailable — the .${tld} registry does not publish registration dates. This is a DATA GAP, not a risk signal; do not penalize the score for it.`
        : `unavailable from the public registry. Treat as a data gap unless other red flags exist.`;

    const userMsg =
      `Domain: ${domain}\n` +
      `Domain age: ${ageStr}\n` +
      `Threat blacklist (Google Safe Browsing): ${blacklisted ? "FLAGGED as dangerous" : "no known threats"}\n` +
      `Assess trustworthiness for an everyday user.`;

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
        messages: [{ role: "user", content: userMsg }],
      }),
    });
    if (!aiResp.ok) return res.status(502).json({ error: "ai_upstream_error", status: aiResp.status });

    const data = await aiResp.json();
    const parsed = extractJson(data?.content?.[0]?.text ?? "");
    if (!parsed || typeof parsed.score !== "number") return res.status(502).json({ error: "ai_parse_error" });

    return res.status(200).json({
      domain,
      score: parsed.score,
      verdict: parsed.verdict || "caution",
      confidence: parsed.confidence || "low",
      summary: parsed.summary || "",
      signals: Array.isArray(parsed.signals) ? parsed.signals : [],
      explanation: parsed.explanation || "",
      advice: parsed.advice || "",
    });
  } catch (err) {
    return res.status(500).json({ error: "internal_error" });
  }
};
