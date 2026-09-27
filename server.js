// server.js — rulează handler-ele Skutio (scrise pentru Vercel) pe un server Linux obișnuit.
// Node pur, zero dependențe. Ascultă DOAR pe 127.0.0.1: din internet se ajunge aici
// numai prin Nginx (reverse proxy + HTTPS). Variabilele de mediu vin din systemd
// (EnvironmentFile=/etc/skutio-api/env) sau local din `node --env-file=.env server.js`.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { getDemo, listSamples } = require("./lib/demo");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY = 10 * 1024 * 1024; // 10 MB — analyze acceptă imagini base64 până la ~7 MB

const routes = {
  "/api/analyze": require("./api/analyze"),
  "/api/trustcheck": require("./api/trustcheck"),
};

// Pagina de prezentare (public/). Listă explicită: nu servim nimic altceva de pe disc.
const PUBLIC_DIR = path.join(__dirname, "public");
const STATIC_FILES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
};
// Pagina încarcă doar resurse proprii: fără scripturi/stiluri externe sau inline.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function serveStatic(req, res, entry) {
  fs.readFile(path.join(PUBLIC_DIR, entry.file), (err, data) => {
    if (err) return res.status(500).json({ error: "internal_error" });
    res.setHeader("Content-Type", entry.type);
    res.setHeader("Cache-Control", "no-cache"); // fișiere mici: mereu versiunea curentă după deploy
    if (entry.type.startsWith("text/html")) res.setHeader("Content-Security-Policy", CSP);
    res.statusCode = 200;
    res.end(req.method === "HEAD" ? undefined : data);
  });
}

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
      size += c.length;
      if (tooLarge) {
        // Restul se citește și se aruncă; răspundem 413 abia la final, altfel clientul care încă
        // trimite primește o conexiune ruptă în loc de răspuns. Peste 4× limita tăiem conexiunea.
        if (size > 4 * MAX_BODY) req.destroy();
        return;
      }
      if (size > MAX_BODY) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) return reject(Object.assign(new Error("too_large"), { code: 413 }));
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
    });
    req.on("error", reject);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url || "/", "http://localhost");
    const route = url.pathname;
    vercelCompat(res);
    res.setHeader("X-Content-Type-Options", "nosniff");
    // O linie per request → ajunge în jurnal (journalctl -u skutio-api).
    res.on("finish", () => {
      console.log(`${req.method} ${route} ${res.statusCode} ${Date.now() - started}ms`);
    });

    const isRead = req.method === "GET" || req.method === "HEAD";

    if (route === "/health") return res.status(200).json({ ok: true });

    if (STATIC_FILES[route]) {
      if (!isRead) return res.status(405).json({ error: "method_not_allowed" });
      return serveStatic(req, res, STATIC_FILES[route]);
    }

    if (route === "/demo/samples") {
      if (!isRead) return res.status(405).json({ error: "method_not_allowed" });
      return res.status(200).json({ samples: listSamples() });
    }

    if (route === "/demo") {
      if (!isRead) return res.status(405).json({ error: "method_not_allowed" });
      try {
        const { status, body } = await getDemo(url.searchParams.get("sample"));
        res.setHeader("Cache-Control", "no-store");
        return res.status(status).json(body);
      } catch (e) {
        console.error("demo error:", e);
        return res.status(500).json({ error: "internal_error" });
      }
    }

    const handler = routes[route];
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
      console.error(`handler error ${route}:`, e);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });
}

// Pornește doar când e rulat direct (`node server.js`); testele importă createServer().
if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => console.log(`skutio-api ascultă pe http://${HOST}:${PORT}`));
  // systemd trimite SIGTERM la stop/restart: închidem curat conexiunile.
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}

module.exports = { createServer };
