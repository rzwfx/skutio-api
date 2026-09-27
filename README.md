# Skutio API

[![CI](https://github.com/rzwfx/skutio-api/actions/workflows/ci.yml/badge.svg)](https://github.com/rzwfx/skutio-api/actions/workflows/ci.yml)

Backend-ul aplicației mobile **Skutio**, care detectează mesaje și site-uri de tip scam cu ajutorul Claude API. Rulează pe un server Linux propriu (Hetzner Cloud, Ubuntu 24.04), cu Node.js sub systemd, PostgreSQL pentru statistici și Nginx cu HTTPS de la Let's Encrypt în față.

**Demo live:** https://api.skutio.app. Pagina rulează o analiză AI reală pe mesaje de test, direct pe acest server.

Proiectul a pornit ca funcții serverless pe Vercel. L-am mutat pe un VPS configurat de la zero ca să înțeleg și să controlez fiecare strat: SSH, firewall, servicii, reverse proxy, certificate, DNS și loguri.

---

## Arhitectură

```
Aplicația mobilă
   │  HTTPS, header x-skutio-key
   ▼
DNS  api.skutio.app  →  2.28.115.171 (A) / 2a01:4f8:1c18:4040::1 (AAAA)
   ▼
ufw firewall ── deschise doar 22 (SSH), 80, 443
   ▼
Nginx ── TLS (Let's Encrypt), redirect HTTP→HTTPS, rate limiting pe IP, headere de securitate
   │  proxy_pass
   ▼
Node.js pe 127.0.0.1:3000 ── serviciu systemd `skutio-api`, user fără privilegii `skutio`
   │  verifică secretul aplicației, încarcă promptul de pe disc
   ├──────────────────────────────┐
   ▼                              ▼
Claude API (Anthropic)       PostgreSQL 16 (local, socket Unix, peer auth)
                                  metadatele analizelor → /stats · backup zilnic (cron)
```

| Componentă | Unde | Rol |
|---|---|---|
| `server.js` | `/opt/skutio-api` | Server HTTP fără dependențe: rute, pagina de prezentare, limită de 10 MB pe body. Adaptează handler-ele scrise pentru Vercel (`res.status`, `res.json`, body JSON). |
| `api/analyze.js` | | Analizează un mesaj sau un screenshot și întoarce un verdict: `safe` / `suspicious` / `dangerous`. |
| `api/trustcheck.js` | | Calculează un scor de încredere pentru un domeniu, din vârsta domeniului (RDAP) și raționamentul modelului. |
| `lib/auth.js` | | Gate anti-abuz: secret partajat în header-ul `x-skutio-key`, comparat în timp constant. |
| `lib/prompts.js` | | Încarcă prompturile de producție din `/etc/skutio-api/prompts`. În repo sunt doar variante exemplu. |
| `lib/db.js` | | PostgreSQL: salvează metadatele fiecărei analize (fără text) și calculează statisticile pentru `/stats`. Opțional: fără config, API-ul merge normal. |
| `migrations/` | | Migrații SQL versionate, aplicate în ordine de `scripts/migrate.js` (`npm run migrate`), fiecare într-o tranzacție. |
| `lib/demo.js` | | Demo public pe 3 mesaje fixe: cache 1 oră, un singur apel la Claude pentru cereri simultane, fallback pe ultimul rezultat bun. |
| `public/` | | Pagina de prezentare (HTML/CSS/JS fără dependențe, CSP strict). |
| `test/` | | 27 de teste (`node --test`), cu Claude API simulat. 7 rulează pe un PostgreSQL real. Rulate de GitHub Actions la fiecare PR. |
| `deploy/skutio-api.service` | `/etc/systemd/system/` | Serviciul systemd: pornire la boot, restart automat, hardening. |
| `deploy/nginx-api.skutio.app.conf` | `/etc/nginx/sites-available/` | Reverse proxy, HTTPS, rate limiting per rută, headere de securitate. |
| `deploy/nginx-ratelimit.conf` | `/etc/nginx/conf.d/` | Zonele de rate limiting (per IP). |
| `deploy/skutio-db-backup.sh` + `.cron` | `/usr/local/bin/`, `/etc/cron.d/` | Backup zilnic cu `pg_dump`, păstrat 7 zile. |

## API

| Metodă | Rută | Acces | Limită / IP |
|---|---|---|---|
| GET | `/` | public | 10/s |
| GET | `/health` | public | 10/s |
| GET | `/demo?sample=1..3` | public | 10/min |
| GET | `/demo/samples` | public | 10/s |
| GET | `/stats` | public | 10/s |
| POST | `/api/analyze` | `x-skutio-key` | 20/min |
| POST | `/api/trustcheck` | `x-skutio-key` | 20/min |

Endpoint-urile `POST` cer header-ul `x-skutio-key`. Fără el, răspunsul e `401`. `/demo` analizează doar mesajele sale fixe și nu acceptă text din afară, deci nu poate fi folosit ca acces gratuit la Claude.

```bash
curl https://api.skutio.app/health
# {"ok":true}

curl https://api.skutio.app/stats
# {"enabled":true,"total":42,"last_24h":7,"dangerous":28,"suspicious":3,"safe":11,"avg_duration_ms":6120,...}

curl https://api.skutio.app/demo?sample=1
# {"sample":{...},"result":{"verdict":"dangerous","score":95,...},"source":"cache","server":{"os":"Ubuntu 24.04.x LTS",...}}

curl -X POST https://api.skutio.app/api/analyze \
  -H "Content-Type: application/json" -H "x-skutio-key: $SKUTIO_APP_SECRET" \
  -d '{"text":"FAN Courier: taxa vamala 2,99 RON neachitata. Platiti aici: https://fancourier-ro.delivery-taxa.top"}'
# {"verdict":"dangerous","score":95,"summary":"...","redFlags":[...],"links":[...],"advice":"..."}

curl -X POST https://api.skutio.app/api/trustcheck \
  -H "Content-Type: application/json" -H "x-skutio-key: $SKUTIO_APP_SECRET" \
  -d '{"url":"emag.ro"}'
# {"domain":"emag.ro","score":95,"verdict":"trusted","confidence":"high",...}
```

| Cod | Când |
|---|---|
| 200 | OK |
| 400 | Input invalid (text gol, text prea lung, domeniu invalid) |
| 401 | Lipsește secretul aplicației sau e greșit |
| 405 | Metodă nepermisă pe ruta respectivă |
| 413 | Body peste 10 MB |
| 429 | Prea multe cereri de pe același IP (Nginx) |
| 500 / 502 | Server neconfigurat / eroare de la Claude API |

## Rulare locală

Necesită Node.js ≥ 20.6.

```bash
cp .env.example .env        # completează ANTHROPIC_API_KEY
npm run dev                 # node --env-file=.env server.js → http://127.0.0.1:3000
```

Fără `PROMPTS_DIR`, serverul folosește prompturile exemplu din cod și scrie asta în log la pornire.

### Teste

```bash
npm test                                                   # 20 de teste, fără Claude, internet sau bază de date
DATABASE_URL=postgres://user:parola@localhost/skutio_test npm test   # + 7 teste PostgreSQL (șterge tabelele din baza dată!)
```

Acoperă rutele, codurile de eroare (401/404/405/413/502), limitele de input, pagina de prezentare (inclusiv CSP), demo-ul (cache, cereri simultane deduplicate, fallback când Claude e indisponibil) și baza de date: migrații idempotente, constrângerile tabelului, faptul că textul mesajelor nu se salvează și agregările din `/stats`. Apelul la Claude e simulat prin înlocuirea `fetch`. [GitHub Actions](.github/workflows/ci.yml) rulează toate testele la fiecare push și pull request, cu un container PostgreSQL 16.

---

## Deploy de la zero pe un VPS

Pașii exacți folosiți pentru `api.skutio.app`, pe Hetzner CX23 cu Ubuntu 24.04.

### 1. Cheie SSH și server

Pe Mac:

```bash
ssh-keygen -t ed25519 -C "email@exemplu.com"      # cu passphrase
pbcopy < ~/.ssh/id_ed25519.pub                    # cheia publică → Hetzner, la crearea serverului
```

În `~/.ssh/config`:

```
Host skutio
    HostName 2.28.115.171
    User razvan
    IdentityFile ~/.ssh/id_ed25519

Host *
    AddKeysToAgent yes
    UseKeychain yes
```

### 2. Securizare

Ca root, la prima conectare:

```bash
apt-get update && apt-get upgrade -y

# user personal cu sudo, aceeași cheie SSH
adduser --disabled-password --gecos "" razvan
usermod -aG sudo razvan
install -d -m 700 -o razvan -g razvan /home/razvan/.ssh
install -m 600 -o razvan -g razvan /root/.ssh/authorized_keys /home/razvan/.ssh/
echo "razvan ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-razvan && chmod 440 /etc/sudoers.d/90-razvan
```

**Testează `ssh razvan@IP` înainte de pasul următor**, altfel riști să te blochezi afară.

```bash
# doar chei SSH, fără root (prefixul 00 = are prioritate față de alte fișiere din sshd_config.d)
cat > /etc/ssh/sshd_config.d/00-hardening.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
EOF
sshd -t && systemctl reload ssh

# firewall: SSH ÎNAINTE de enable
ufw default deny incoming && ufw default allow outgoing
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp
ufw --force enable

reboot   # încarcă kernelul nou după upgrade
```

Actualizările automate de securitate (`unattended-upgrades`) sunt active implicit pe Ubuntu.

### 3. Node.js și aplicația

```bash
# Node 24 LTS din repo-ul oficial NodeSource (Ubuntu 24.04 are doar Node 18, ieșit din suport)
sudo install -d -m 755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
  | sudo tee /etc/apt/sources.list.d/nodesource.list
sudo apt-get update && sudo apt-get install -y nodejs git

# user de serviciu: fără login, fără sudo
sudo useradd --system --no-create-home --shell /usr/sbin/nologin skutio

# codul: aparține lui razvan (poate face git pull); skutio doar îl citește
sudo git clone https://github.com/rzwfx/skutio-api.git /opt/skutio-api
sudo chown -R razvan:razvan /opt/skutio-api

# configurația și secretele, în afara repo-ului
sudo install -d -m 750 -o root -g skutio /etc/skutio-api /etc/skutio-api/prompts
sudo install -m 640 -o root -g skutio analyze.txt trustcheck.txt /etc/skutio-api/prompts/   # copiate cu scp
sudo install -m 600 -o root -g root /dev/null /etc/skutio-api/env
```

Secretele se adaugă fără să apară pe ecran sau în istoricul shell-ului:

```bash
ssh -t skutio 'read -rsp "Cheia: " K; echo; echo "ANTHROPIC_API_KEY=$K" | sudo tee -a /etc/skutio-api/env >/dev/null'
```

### 4. PostgreSQL

```bash
sudo apt-get install -y postgresql            # PostgreSQL 16, ascultă doar pe localhost
sudo -u postgres createuser skutio            # rol cu același nume ca userul Linux al serviciului
sudo -u postgres createdb -O skutio skutio
```

Aplicația se conectează prin socket Unix cu **peer authentication**: Postgres acceptă conexiunea pentru că sistemul de operare garantează că procesul rulează ca userul `skutio`. Nu există parolă care să poată scăpa. În `/etc/skutio-api/env`:

```
PGHOST=/var/run/postgresql
PGDATABASE=skutio
PGUSER=skutio
```

Migrații și backup:

```bash
cd /opt/skutio-api && npm ci --omit=dev
sudo -u skutio PGHOST=/var/run/postgresql PGDATABASE=skutio PGUSER=skutio npm run migrate

sudo install -m 755 deploy/skutio-db-backup.sh /usr/local/bin/skutio-db-backup.sh
sudo install -m 644 deploy/skutio-db-backup.cron /etc/cron.d/skutio-db-backup
sudo -u postgres /usr/local/bin/skutio-db-backup.sh    # test manual
```

### 5. Serviciul systemd

```bash
sudo cp /opt/skutio-api/deploy/skutio-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now skutio-api
curl localhost:3000/health
```

### 6. Nginx, DNS, HTTPS

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo cp /opt/skutio-api/deploy/nginx-ratelimit.conf /etc/nginx/conf.d/skutio-ratelimit.conf
sudo cp /opt/skutio-api/deploy/nginx-api.skutio.app.conf /etc/nginx/sites-available/api.skutio.app
sudo ln -s /etc/nginx/sites-available/api.skutio.app /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Pe un server nou, fără certificat încă: pornește de la blocul `listen 80` (fără liniile „managed by Certbot"), iar certbot le adaugă singur la pasul următor.

La furnizorul DNS (aici Vercel DNS), două înregistrări pentru `api`: **A** → IPv4 și **AAAA** → IPv6. Apoi:

```bash
sudo certbot --nginx -d api.skutio.app --redirect
sudo certbot renew --dry-run          # reînnoirea automată e făcută de certbot.timer
```

---

## Operare

| Ce | Comandă |
|---|---|
| Starea serviciului | `sudo systemctl status skutio-api` |
| Loguri live | `sudo journalctl -u skutio-api -f` |
| Ultimele 50 de linii de log | `sudo journalctl -u skutio-api -n 50` |
| Restart | `sudo systemctl restart skutio-api` |
| Loguri Nginx | `sudo tail -f /var/log/nginx/access.log /var/log/nginx/error.log` |
| Firewall | `sudo ufw status verbose` |
| Certificat | `sudo certbot certificates` |
| Cereri blocate de rate limiting | `sudo grep "limiting requests" /var/log/nginx/error.log` |
| Consolă SQL | `sudo -u skutio psql -d skutio` |
| Ultimele analize | `sudo -u skutio psql -d skutio -c "SELECT created_at, source, verdict, score FROM analyses ORDER BY id DESC LIMIT 10"` |
| Backup-uri | `ls -lh /var/backups/skutio-db/` · log: `grep skutio-db-backup /var/log/syslog` |
| Restaurare backup | `sudo -u postgres pg_restore -d skutio --clean /var/backups/skutio-db/skutio-AAAA-LL-ZZ.dump` |

**Deploy al unei versiuni noi** (după merge în `main`):

```bash
ssh skutio 'cd /opt/skutio-api && git pull && npm ci --omit=dev \
  && sudo -u skutio PGHOST=/var/run/postgresql PGDATABASE=skutio PGUSER=skutio npm run migrate \
  && sudo systemctl restart skutio-api && sleep 1 && curl -s localhost:3000/health'
```

**Rotirea cheii Claude** (cheia `skutio-vps` expiră pe 26 dec 2026): creezi cheia nouă în Anthropic Console, înlocuiești linia `ANTHROPIC_API_KEY` din `/etc/skutio-api/env` (`sudo nano`), faci restart la serviciu și abia apoi revoci cheia veche.

## Decizii de securitate

- **Doar chei SSH**, root dezactivat, userul personal separat de userul serviciului.
- **Principiul privilegiului minim**: procesul Node rulează ca `skutio` (fără shell, fără sudo) și poate doar citi codul. systemd adaugă `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `NoNewPrivileges`.
- **Node ascultă doar pe 127.0.0.1**, iar portul 3000 nu e accesibil din internet. Singura intrare e Nginx.
- **Rate limiting pe IP în Nginx**, separat pe rute: endpoint-urile AI (cost real) au limita cea mai strictă. Peste limită, Nginx răspunde `429` fără să mai ajungă la Node.
- **Headere de securitate:** HSTS, `X-Frame-Options: DENY`, `Referrer-Policy`, `nosniff`, iar pagina de prezentare are un CSP strict (fără scripturi sau stiluri externe ori inline). `server_tokens off` ascunde versiunea Nginx.
- **PostgreSQL:** ascultă doar local, iar aplicația se conectează prin peer auth, fără parolă. Se salvează **doar metadate** (verdict, scor, durată), niciodată textul sau imaginea analizată: minimizarea datelor cerută de GDPR, verificată și de un test. Constrângerile `CHECK` din tabel resping date invalide chiar dacă aplicația ar avea un bug. Înregistrarea nu blochează niciodată răspunsul: dacă baza de date cade, utilizatorul își primește verdictul oricum.
- **Compromis asumat (baza de date):** aplicația folosește același rol și pentru migrații, și pentru runtime. Separarea lor (un rol doar cu `INSERT`/`SELECT` pentru aplicație) e pasul următor.
- **Demo-ul public e sigur din punct de vedere al costului:** mesaje fixe, cache de o oră, deduplicarea cererilor simultane. Costul maxim e de 3 × 24 apeluri pe zi, indiferent de trafic.
- **Secretele și prompturile stau în afara git**, în `/etc/skutio-api/`, cu permisiuni `600`/`640`. Istoricul repo-ului a fost verificat să nu conțină chei sau promptul de producție.
- **Cheie Claude dedicată serverului**, cu expirare, ca să poată fi revocată independent de alte medii.
- **Compromis asumat:** `razvan` are `sudo` fără parolă, ca să permită administrarea non-interactivă. E acceptabil pentru că singura cale de intrare e cheia SSH protejată cu passphrase.
- **Limită cunoscută:** un secret livrat într-o aplicație mobilă poate fi extras. Rate limiting-ul pe IP limitează paguba, iar pasul următor ar fi verificarea abonamentului per utilizator (RevenueCat) înainte de apelul la Claude.

## Cum a fost construit

Am lucrat cu **Claude Code** ca pereche. I-am cerut să adapteze handler-ele Vercel pentru un server Node obișnuit și să mă ghideze pas cu pas prin configurarea serverului, explicând fiecare comandă. Am verificat fiecare pas cu teste concrete (`curl`, `sshd -T`, `ss -ltnp`, `kill -9` pe proces ca să confirm restartul automat), nu doar pe baza output-ului. Două greșeli prinse astfel:

- Scriptul care dezactiva login-ul root s-a oprit silențios (`set -e` + un `cat` pe un folder gol), deci root încă putea intra. Testul explicit de login ca root a arătat problema, iar scriptul a fost refăcut și retestat.
- La limita de 10 MB, serverul tăia conexiunea înainte să trimită `413`. Clientul primea o conexiune ruptă în loc de o eroare clară. Corectat prin drenarea body-ului înainte de răspuns. Cazul e acum acoperit de un test automat.
