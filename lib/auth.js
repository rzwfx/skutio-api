// server/lib/auth.js — gate comun pentru funcțiile serverless Skutio.
// Protecție anti-abuz cu un secret partajat (app secret): aplicația trimite
// header-ul `x-skutio-key`, serverul îl verifică. Oprește boții care scanează
// URL-uri Vercel și abuzul ocazional — fără infra, gratuit.
//
// ATENȚIE: un secret livrat într-o aplicație mobilă poate fi extras de un
// atacator determinat. Asta blochează 99% din abuzul real (scanere/boți), nu
// un reverse-engineer dedicat. Pentru asta ar fi nevoie de rate-limit pe IP.

const crypto = require("crypto");

// Comparație în timp constant (evită timing attacks pe secret).
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Autorizat? Aplicarea e activă DOAR când SKUTIO_APP_SECRET e setat pe server.
// Rollout fără downtime: (1) deploy cod, (2) rebuild app cu header-ul,
// (3) setezi env var-ul pe Vercel → de-abia atunci începe să respingă.
function isAuthorized(req) {
  const secret = process.env.SKUTIO_APP_SECRET;
  if (!secret) return true; // neconfigurat încă → permite (vezi README, secțiunea rollout)
  const provided = req.headers["x-skutio-key"] || "";
  return timingSafeEqualStr(provided, secret);
}

// CORS restrâns: niciun client web nu folosește aceste endpoint-uri, deci NU
// publicăm `Access-Control-Allow-Origin: *`. Fetch-ul nativ (React Native) nu e
// supus CORS, deci aplicația nu e afectată; un browser, în schimb, e blocat.
function setCors(res) {
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-skutio-key");
}

module.exports = { isAuthorized, setCors };
