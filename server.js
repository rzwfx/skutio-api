// server.js — rulează handler-ele Skutio (scrise pentru Vercel) pe un server Linux obișnuit.
// Node pur, zero dependențe. Ascultă DOAR pe 127.0.0.1: din internet se ajunge aici
// numai prin Nginx (reverse proxy + HTTPS). Variabilele de mediu vin din systemd
// (EnvironmentFile=/etc/skutio-api/env) sau local din `node --env-file=.env server.js`.

const http = require("http");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY = 10 * 1024 * 1024; // 10 MB — analyze acceptă imagini base64 până la ~7 MB

const routes = {
  "/api/analyze": require("./api/analyze"),
  "/api/trustcheck": require("./api/trustcheck"),
};

// Adaugă pe `res` metodele pe care Vercel le oferă și handler-ele le folosesc.
function vercelCompat(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
    return res;
  };
}

// Citește body-ul și îl parsează ca JSON (ca Vercel). JSON invalid → rămâne string,
// iar handler-ul răspunde singur cu eroare.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on("data", (c) => {
      if (tooLarge) return; // restul se citește și se aruncă, ca să putem răspunde 413
      size += c.length;
      if (size > MAX_BODY) { tooLarge = true; chunks.length = 0; reject(Object.assign(new Error("too_large"), { code: 413 })); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const path = (req.url || "/").split("?")[0];
  vercelCompat(res);
  // O linie per request → ajunge în jurnal (journalctl -u skutio-api).
  res.on("finish", () => {
    console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`);
  });

  if (path === "/health") return res.status(200).json({ ok: true });

  const handler = routes[path];
  if (!handler) return res.status(404).json({ error: "not_found" });

  try {
    req.body = await readBody(req);
  } catch (e) {
    res.setHeader("Connection", "close");
    return res.status(e.code === 413 ? 413 : 400).json({ error: e.code === 413 ? "body_too_large" : "bad_request" });
  }

  try {
    await handler(req, res);
  } catch (e) {
    console.error(`handler error ${path}:`, e);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  }
});

server.listen(PORT, HOST, () => console.log(`skutio-api ascultă pe http://${HOST}:${PORT}`));

// systemd trimite SIGTERM la stop/restart: închidem curat conexiunile.
process.on("SIGTERM", () => server.close(() => process.exit(0)));
