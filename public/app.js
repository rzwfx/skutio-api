// Pagina de prezentare: status live (/health) + demo AI (/demo). Fără dependențe.
"use strict";

const $ = (id) => document.getElementById(id);
const VERDICT_LABEL = { dangerous: "Periculos", suspicious: "Suspect", safe: "Sigur" };

function timeAgo(iso) {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return "chiar acum";
  if (min === 1) return "acum 1 minut";
  if (min < 60) return `acum ${min} minute`;
  return "acum peste o oră";
}

async function checkHealth() {
  const box = $("status");
  const started = performance.now();
  try {
    const r = await fetch("/health", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    const ms = Math.round(performance.now() - started);
    box.className = "status ok";
    $("status-text").textContent = `Operațional · ${ms} ms`;
  } catch {
    box.className = "status down";
    $("status-text").textContent = "Indisponibil";
  }
}

const fmt = (n) => Number(n).toLocaleString("ro-RO");
const sec = (ms) => (ms / 1000).toLocaleString("ro-RO", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

async function loadStats() {
  try {
    const r = await fetch("/stats", { cache: "no-store" });
    if (!r.ok) return;
    const s = await r.json();
    if (!s.enabled) return;
    $("st-total").textContent = fmt(s.total);
    $("st-24h").textContent = fmt(s.last_24h);
    $("st-danger").textContent = s.total ? `${Math.round((s.dangerous / s.total) * 100)}%` : "–";
    $("st-avg").textContent = s.avg_duration_ms ? `${sec(s.avg_duration_ms)} s` : "–";
    $("st-meta").textContent = s.since
      ? `Date colectate din ${new Date(s.since).toLocaleDateString("ro-RO", { day: "numeric", month: "long", year: "numeric" })} · actualizat la fiecare minut`
      : "";
    $("stats-card").hidden = false;
  } catch {}
}

let current = 0;

async function loadDemo(sample) {
  current = sample;
  document.querySelectorAll("#tabs button").forEach((b) => {
    b.setAttribute("aria-selected", String(Number(b.dataset.sample) === sample));
  });
  $("message").textContent = SAMPLE_TEXT[sample] || "…";
  $("loading").hidden = false;
  $("result-body").hidden = true;
  $("error").hidden = true;
  $("meta").textContent = "";

  try {
    const r = await fetch(`/demo?sample=${sample}`);
    const data = await r.json();
    if (sample !== current) return; // utilizatorul a schimbat tab-ul între timp
    if (r.status === 429) throw new Error("Prea multe cereri într-un timp scurt. Încearcă din nou peste un minut.");
    if (!r.ok) throw new Error("Analiza nu e disponibilă momentan. Încearcă din nou puțin mai târziu.");
    render(data);
    if (data.source === "live") loadStats(); // o analiză nouă tocmai a intrat în baza de date
  } catch (e) {
    if (sample !== current) return;
    $("loading").hidden = true;
    $("error").hidden = false;
    $("error").textContent = e.message;
  }
}

function render({ sample, result, analyzedAt, analysisMs, source, server }) {
  $("message").textContent = sample.text;

  const v = VERDICT_LABEL[result.verdict] ? result.verdict : "suspicious";
  $("verdict").className = `verdict ${v}`;
  $("verdict").textContent = VERDICT_LABEL[v];
  $("score").textContent = result.score;
  $("meter").parentElement.className = `meter ${v}`;
  $("meter").style.width = `${Math.max(3, Math.min(100, result.score))}%`;
  $("summary").textContent = result.summary;

  const flags = $("flags");
  flags.replaceChildren(...result.redFlags.map((f) => Object.assign(document.createElement("li"), { textContent: f })));
  $("flags-wrap").hidden = result.redFlags.length === 0;
  $("advice").textContent = result.advice;

  $("loading").hidden = true;
  $("result-body").hidden = false;

  const when = source === "live" ? "Analizat chiar acum" : `Analizat ${timeAgo(analyzedAt)}`;
  $("meta").textContent = `${when} de Claude, în ${sec(analysisMs)} s · ${server.os} · Node ${server.node}`;
  $("server-line").textContent = `Servit de ${server.host} · ${server.os}`;
}

document.querySelectorAll("#tabs button").forEach((b) => {
  b.addEventListener("click", () => loadDemo(Number(b.dataset.sample)));
});

// Mesajul se afișează imediat, înainte de răspunsul AI.
const SAMPLE_TEXT = {};
fetch("/demo/samples").then((r) => r.json()).then((d) => {
  (d.samples || []).forEach((s) => { SAMPLE_TEXT[s.id] = s.text; });
  if (SAMPLE_TEXT[current] && $("message").textContent === "…") $("message").textContent = SAMPLE_TEXT[current];
}).catch(() => {});

loadStats();
checkHealth();
setInterval(checkHealth, 30000);
loadDemo(1);
