# Skutio API

Backend-ul aplicației mobile **Skutio**, care detectează mesaje și site-uri de tip scam cu ajutorul Claude API. Rulează pe un server Linux propriu (Hetzner Cloud, Ubuntu 24.04), cu Node.js sub systemd, în spatele Nginx cu HTTPS de la Let's Encrypt.

**Live:** https://api.skutio.app/health

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
Nginx ── TLS (Let's Encrypt), redirect HTTP→HTTPS, limită body 10 MB
   │  proxy_pass
   ▼
Node.js pe 127.0.0.1:3000 ── serviciu systemd `skutio-api`, user fără privilegii `skutio`
   │  verifică secretul aplicației, încarcă promptul de pe disc
   ▼
Claude API (Anthropic)
```

| Componentă | Unde | Rol |
|---|---|---|
| `server.js` | `/opt/skutio-api` | Server HTTP fără dependențe. Adaptează handler-ele scrise pentru Vercel (`res.status`, `res.json`, body JSON). |
| `api/analyze.js` | | Analizează un mesaj sau un screenshot și întoarce un verdict: `safe` / `suspicious` / `dangerous`. |
| `api/trustcheck.js` | | Calculează un scor de încredere pentru un domeniu, din vârsta domeniului (RDAP) și raționamentul modelului. |
| `lib/auth.js` | | Gate anti-abuz: secret partajat în header-ul `x-skutio-key`, comparat în timp constant. |
| `lib/prompts.js` | | Încarcă prompturile de producție din `/etc/skutio-api/prompts`. În repo sunt doar variante exemplu. |
| `deploy/skutio-api.service` | `/etc/systemd/system/` | Serviciul systemd: pornire la boot, restart automat, hardening. |
| `deploy/nginx-api.skutio.app.conf` | `/etc/nginx/sites-available/` | Reverse proxy. Blocul HTTPS e adăugat de certbot. |

## API

Toate endpoint-urile `POST` cer header-ul `x-skutio-key`. Fără el, răspunsul e `401`.

```bash
curl https://api.skutio.app/health
# {"ok":true}

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
| 405 | Metodă diferită de POST |
| 413 | Body peste 10 MB |
| 500 / 502 | Server neconfigurat / eroare de la Claude API |

## Rulare locală

Necesită Node.js ≥ 20.6.

```bash
cp .env.example .env        # completează ANTHROPIC_API_KEY
npm run dev                 # node --env-file=.env server.js → http://127.0.0.1:3000
```

Fără `PROMPTS_DIR`, serverul folosește prompturile exemplu din cod și scrie asta în log la pornire.

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

### 4. Serviciul systemd

```bash
sudo cp /opt/skutio-api/deploy/skutio-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now skutio-api
curl localhost:3000/health
```

### 5. Nginx, DNS, HTTPS

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo cp /opt/skutio-api/deploy/nginx-api.skutio.app.conf /etc/nginx/sites-available/api.skutio.app
sudo ln -s /etc/nginx/sites-available/api.skutio.app /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

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

**Deploy al unei versiuni noi** (după merge în `main`):

```bash
ssh skutio 'cd /opt/skutio-api && git pull && sudo systemctl restart skutio-api && sleep 1 && curl -s localhost:3000/health'
```

**Rotirea cheii Claude** (cheia `skutio-vps` expiră pe 26 dec 2026): creezi cheia nouă în Anthropic Console, înlocuiești linia `ANTHROPIC_API_KEY` din `/etc/skutio-api/env` (`sudo nano`), faci restart la serviciu și abia apoi revoci cheia veche.

## Decizii de securitate

- **Doar chei SSH**, root dezactivat, userul personal separat de userul serviciului.
- **Principiul privilegiului minim**: procesul Node rulează ca `skutio` (fără shell, fără sudo) și poate doar citi codul. systemd adaugă `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `NoNewPrivileges`.
- **Node ascultă doar pe 127.0.0.1**, iar portul 3000 nu e accesibil din internet. Singura intrare e Nginx.
- **Secretele și prompturile stau în afara git**, în `/etc/skutio-api/`, cu permisiuni `600`/`640`. Istoricul repo-ului a fost verificat să nu conțină chei sau promptul de producție.
- **Cheie Claude dedicată serverului**, cu expirare, ca să poată fi revocată independent de alte medii.
- **Compromis asumat:** `razvan` are `sudo` fără parolă, ca să permită administrarea non-interactivă. E acceptabil pentru că singura cale de intrare e cheia SSH protejată cu passphrase.
- **Limită cunoscută:** un secret livrat într-o aplicație mobilă poate fi extras. Următorul pas planificat e rate-limiting pe IP.

## Cum a fost construit

Am lucrat cu **Claude Code** ca pereche. I-am cerut să adapteze handler-ele Vercel pentru un server Node obișnuit și să mă ghideze pas cu pas prin configurarea serverului, explicând fiecare comandă. Am verificat fiecare pas cu teste concrete (`curl`, `sshd -T`, `ss -ltnp`, `kill -9` pe proces ca să confirm restartul automat), nu doar pe baza output-ului. Două greșeli prinse astfel:

- Scriptul care dezactiva login-ul root s-a oprit silențios (`set -e` + un `cat` pe un folder gol), deci root încă putea intra. Testul explicit de login ca root a arătat problema, iar scriptul a fost refăcut și retestat.
- La limita de 10 MB, serverul tăia conexiunea înainte să trimită `413`. Clientul primea o conexiune ruptă în loc de o eroare clară. Corectat prin drenarea body-ului înainte de răspuns.
