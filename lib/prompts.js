// lib/prompts.js — încarcă system prompt-urile din fișiere de pe server, în afara repo-ului.
// Prompturile de producție sunt proprietate intelectuală și NU stau în git; în repo există
// doar variante exemplu (fallback), suficiente ca oricine să poată rula proiectul.
//
// Caută <PROMPTS_DIR>/<nume>.txt (default /etc/skutio-api/prompts). Lipsește → fallback.

const fs = require("fs");
const path = require("path");

const PROMPTS_DIR = process.env.PROMPTS_DIR || "/etc/skutio-api/prompts";

function loadPrompt(name, fallback) {
  const file = path.join(PROMPTS_DIR, `${name}.txt`);
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    if (text) {
      console.log(`prompt "${name}": ${file}`);
      return text;
    }
  } catch {}
  console.log(`prompt "${name}": exemplu din cod (nu există ${file})`);
  return fallback;
}

module.exports = { loadPrompt };
