// lib/demo.js — demo public: analiză AI reală pe câteva mesaje FIXE.
// Nimeni nu poate trimite text propriu, deci endpoint-ul nu poate fi folosit ca
// proxy gratuit către Claude. Rezultatele sunt ținute în memorie DEMO_TTL_MS, deci
// costul e de cel mult (nr. mesaje × 24) apeluri pe zi, indiferent de trafic.

const fs = require("fs");
const os = require("os");
const { analyzeMessage } = require("../api/analyze");

const DEMO_TTL_MS = Number(process.env.DEMO_TTL_MS) || 60 * 60 * 1000; // 1 oră

const SAMPLES = [
  {
    id: 1,
    label: "SMS curier fals",
    text: "FAN Courier: Coletul dvs. nu a putut fi livrat din cauza unei taxe vamale neachitate de 2,99 RON. Platiti in 24h aici: https://fancourier-ro.delivery-taxa.top/plata altfel coletul va fi returnat.",
  },
  {
    id: 2,
    label: "Email phishing (EN)",
    text: "Netflix: Your payment was declined and your membership will be suspended within 24 hours. Update your billing details now to avoid interruption: https://netflix-billing-update.support/account",
  },
  {
    id: 3,
    label: "Mesaj normal",
    text: "Salut! Ne vedem mâine la 7 la cafeneaua din centru? Am rezervat deja masa.",
  },
];

// Informații despre server — arată că răspunsul vine de pe VPS-ul propriu, nu de pe Vercel.
function readOsName() {
  try {
    const m = fs.readFileSync("/etc/os-release", "utf8").match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    if (m) return m[1];
  } catch {}
  return `${os.type()} ${os.release()}`;
}
const SERVER_INFO = { os: readOsName(), node: process.version, host: os.hostname() };

const cache = new Map();    // id → { result, analyzedAt, durationMs }
const inFlight = new Map(); // id → Promise (mai multe cereri simultane → un singur apel la Claude)

async function refresh(sample) {
  const started = Date.now();
  const { status, body } = await analyzeMessage({ text: sample.text });
  if (status !== 200) throw Object.assign(new Error(body.error || "demo_failed"), { status, body });
  const entry = { result: body, analyzedAt: new Date().toISOString(), durationMs: Date.now() - started };
  cache.set(sample.id, entry);
  return entry;
}

function publicSample({ id, label, text }) {
  return { id, label, text };
}

// Întoarce { status, body } pentru GET /demo?sample=N
async function getDemo(sampleParam) {
  const id = sampleParam === undefined || sampleParam === null || sampleParam === "" ? 1 : Number(sampleParam);
  const sample = SAMPLES.find((s) => s.id === id);
  if (!sample) {
    return { status: 400, body: { error: "invalid_sample", samples: listSamples() } };
  }

  const cached = cache.get(id);
  const fresh = cached && Date.now() - Date.parse(cached.analyzedAt) < DEMO_TTL_MS;
  let entry = fresh ? cached : null;
  let source = "cache";

  if (!entry) {
    if (!inFlight.has(id)) {
      inFlight.set(id, refresh(sample).finally(() => inFlight.delete(id)));
    }
    try {
      entry = await inFlight.get(id);
      source = "live";
    } catch (e) {
      // Claude indisponibil: mai bine ultimul rezultat bun decât o eroare.
      if (cached) {
        entry = cached;
        source = "stale";
      } else {
        return { status: e.status || 502, body: { error: e.body?.error || "demo_unavailable" } };
      }
    }
  }

  return {
    status: 200,
    body: {
      sample: publicSample(sample),
      result: entry.result,
      analyzedAt: entry.analyzedAt,
      analysisMs: entry.durationMs,
      source, // live = analizat acum; cache = analizat în ultima oră; stale = fallback
      server: SERVER_INFO,
    },
  };
}

function listSamples() {
  return SAMPLES.map(publicSample);
}

module.exports = { getDemo, listSamples, _cache: cache };
