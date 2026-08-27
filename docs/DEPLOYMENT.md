# Production deployment

The grown-up way to run Mneme: a self-hosted, LAN-reachable stack with real HTTPS, restart-on-crash,
and rolling backups. This is the setup to use if you actually intend to keep your journal here. The
root `docker-compose.yml` (the one in the quick-start) is the **dev** stack — published ports, `_dev`
default secrets, plain HTTP. Lovely for hacking, entirely unsuitable for your real diary. Please don't
confuse the two.

For day-two operations (backups, restore, upgrades, health checks, troubleshooting) see
[MAINTENANCE.md](./MAINTENANCE.md). For what the relay exposes, see [API.md](./API.md).

---

## What you get

A four-container stack, reachable from your local network only:

```
browser ──https──> web (Caddy :443, everything under /mneme)
                     ├── /mneme/v1/*, /healthz, /readyz, /admin* ──> server :8080 (prefix stripped)
                     └── everything else under /mneme/: client SPA (static)
                                              server ──> postgres, minio (internal network only)
```

Only ports **80/443** are published on the host. Postgres, MinIO, and the relay are reachable solely
on the compose-internal network — the database is not sitting on the internet waiting to make friends.

The pieces:
- **Caddy (`web`)** — serves the built client and reverse-proxies the relay on one HTTPS origin.
- **`server`** — the Go relay `journald`.
- **`postgres`** — bookkeeping + opaque ciphertext blobs.
- **`minio`** — encrypted media chunks (S3-compatible).

Everything is driven through `./deploy/prod.sh`, a thin wrapper that pins the prod compose file and
your `.env.prod` so you can't accidentally run the wrong stack at 2 a.m.

---

## The fast path: one command

`deploy/install.sh` does everything in "Prerequisites" and "First start" below, in order, on a Linux
host:

```bash
curl -fsSL https://raw.githubusercontent.com/mneme-blog/mneme/main/deploy/install.sh | bash
```

It states its plan, asks for confirmation, then works through six narrated steps: check the machine
(Docker + Compose plugin — offering to install Docker if absent — CPU architecture, ports 80/443,
disk, memory), clone the repository to `~/mneme` (`/opt/mneme` when run as root), write a
`.env.prod` with generated secrets and the LAN address it detected, pull the published images, start
the stack, and poll `https://127.0.0.1/mneme/readyz` until the app genuinely answers through Caddy.
It finishes with the URL, the admin token (printed once), and the backup directory.

Failures stop the run with a diagnosis rather than a trace — the cause, what it means, and the
command that fixes it. The readiness failure additionally dumps `prod.sh ps` and the relay's last log
lines next to the three causes that account for nearly all of them (Postgres still starting, Caddy
unable to bind or given a `SITE_ADDRESS` this host does not have, a migration error).

Flags — pass them through the pipe with `bash -s --`:

| Flag | Default | What it does |
|---|---|---|
| `--dir PATH` | `~/mneme`, `/opt/mneme` as root | Install directory. |
| `--site "IP, host.local"` | detected LAN IP + `<hostname>.local` | `SITE_ADDRESS` for Caddy. |
| `--backups PATH` | `~/mneme-backups` | `BACKUP_HOST_DIR`. |
| `--ref REF` | `main` | Release tag or branch to check out. |
| `--install-docker` | ask | Install Docker via `get.docker.com` without prompting. |
| `--no-start` | start | Configure only; review `.env.prod` and start by hand. |
| `-y`, `--yes` | ask | Non-interactive: accept every default. |

The same values can come from the environment instead (`MNEME_DIR`, `MNEME_SITE_ADDRESS`,
`MNEME_BACKUP_DIR`, `MNEME_REF`, `MNEME_REPO_URL`), which is what to use from a configuration
manager.

It is safe to re-run: an existing `.env.prod` is left alone, the checkout is fast-forwarded to `REF`,
and the stack is restarted onto the current images. It is not an upgrade tool, though — for that see
[MAINTENANCE.md](./MAINTENANCE.md), which has both the manual `pull`/`up -d` path and the one-click
dashboard updates.

What it deliberately does not do: touch anything outside the install directory, the backup directory,
and Docker itself; keep a resident process or a systemd unit of its own (the only unit Mneme installs
is the optional updater agent, `deploy/updater/install.sh`); or use root for anything but installing
Docker. And it never handles a recovery phrase — those are generated in the browser on first use.

Prefer to read before running (a reasonable instinct for anything holding your journal):

```bash
curl -fsSL https://raw.githubusercontent.com/mneme-blog/mneme/main/deploy/install.sh -o install.sh
less install.sh && bash install.sh
```

The rest of this page is the same deployment done by hand — worth reading either way, since it is
what you will be operating.

---

## Prerequisites on the host

Docker Engine + the Compose plugin, enabled at boot, and a clone of this repo.

```bash
# Docker (Debian/Ubuntu; see docs.docker.com for other distros)
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"   # then log out/in so `docker` works without sudo

git clone https://github.com/mneme-blog/mneme.git mneme && cd mneme
```

---

## First start

```bash
cp .env.prod.example .env.prod    # then fill in real secrets — see below
./deploy/prod.sh up -d --build    # build images + start postgres, minio, relay, caddy
./deploy/prod.sh ps               # everything Up / healthy?
curl -k https://<LAN-IP>/mneme/readyz   # relay ready through the proxy
```

Open **`https://<LAN-IP>/mneme/`** (a bare `/` redirects there). Generate or restore a recovery
phrase and you're in.

### Configuring `.env.prod`

`.env.prod` is gitignored. Never commit it. Fill in:

| Variable | What it is |
|---|---|
| `POSTGRES_PASSWORD` | Postgres superuser password (opaque blobs only, but still — pick a real one). |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | MinIO root creds; the relay reuses them as its S3 credentials. |
| `ADMIN_TOKEN` | Bearer token for `/admin`. **Leave empty to disable the admin surface entirely** (every `/admin` path 404s). Generate one with `openssl rand -base64 32`. |
| `SITE_ADDRESS` | Comma-separated addresses Caddy answers on (LAN IP, hostname). The client bundle is hostname-agnostic, so list whatever your LAN resolves. |
| `DEFAULT_SNI` | Certificate served when a client connects by bare IP (sends no SNI). |
| `BACKUP_HOST_DIR` | Host directory where rolling backup archives land (created if missing). |
| `BACKUP_INTERVAL` / `BACKUP_KEEP` | Backup cadence (e.g. `24h`) and how many to keep (newest first; `0` keeps all). |

---

## HTTPS on a LAN (why, and how to stop the browser sulking)

The client requires a **secure context** (OPFS local database, camera/mic capture), so plain
`http://<ip>` simply will not work — the browser disables half the app. Caddy issues certificates from
its own internal CA (`tls internal`):

- **Quick path:** open the site and accept the browser warning once per device. Slightly grubby, works
  immediately.
- **Clean path:** install Caddy's root cert on your devices so the warning disappears for good:

  ```bash
  ./deploy/prod.sh cp web:/data/caddy/pki/authorities/local/root.crt .
  # then import root.crt as a trusted CA on each device and restart the browser
  ```

The CA and issued certs persist in the `caddy_data` volume, so they survive restarts and redeploys.

### Installing it as an app (PWA)

Once the origin is served over trusted HTTPS, the client is an installable PWA — the service worker
(precached app shell, offline-capable) plus `manifest.webmanifest` satisfy the browser's install
criteria. On desktop Chrome/Edge an install icon appears in the address bar; on Android Chrome use
**⋮ → Add to Home screen / Install app**; on iOS Safari use **Share → Add to Home Screen**.

One catch specific to install: a service worker will **not** register on an origin with a certificate
*error*, so the "accept the warning once" quick path above is enough to *use* the app but **not** to
install it. For install you need the **clean path** — import Caddy's root CA so the certificate is
actually trusted (no warning). Real public certs (a proper domain) trivially satisfy this.

See [PWA.md](./PWA.md) for the developer-side story (installing from the dev server for testing).

---

## The operator admin dashboard

Set `ADMIN_TOKEN` and an operator dashboard appears at `https://<host>/mneme/admin` (authenticate
with the token as a bearer). Leave `ADMIN_TOKEN` empty and the surface does not exist — every
`/admin` path returns a plain `404`. Set it to a real secret in production (`openssl rand -base64 32`).

Crucially, the dashboard shows **health and growth, never people**. It is built so the operator gains
*no* ability to read or even identify anyone's content:

- **Per-vault storage footprints** — how much space each vault uses, keyed by a **truncated,
  pseudonymous** owner id (a hash, not a name or email).
- **Daily aggregate counters** — request, record, media, and vault metrics, stored deliberately
  **without any owner column**, so they can't be tied back to an individual.
- **Vault deletion** — wipe a vault by id, gated behind a typed `"delete"` confirmation. (Users can
  also delete their own vault from inside the app.)
- **Backups & disaster recovery** — trigger, list, download, and restore archives (restore gated
  behind a typed `"restore"` confirmation, since it replaces all relay data). A backup is one gzipped
  archive of every vault's **encrypted** blobs and media chunks — **no keys, no plaintext**, because
  the relay never had any. See [MAINTENANCE.md](./MAINTENANCE.md) for the full backup and restore
  runbook.

What the dashboard fundamentally *cannot* do is tell you what anyone wrote — that data never reaches
the server in readable form. Full API details in [API.md](./API.md#admin).

---

## Deploying a new version

```bash
./deploy/prod.sh pull             # fetch the released images
./deploy/prod.sh up -d            # rolling restart onto them
./deploy/prod.sh ps               # confirm healthy
```

Building from your own working tree instead: `./deploy/prod.sh up -d --build`.

You can also do this from the dashboard — one button, with an automatic pre-update backup and an
automatic rollback if the new version doesn't come up. It needs a small root-owned agent installed on
the host first (the relay itself has no business restarting the stack); see
[MAINTENANCE.md → One-click updates](./MAINTENANCE.md#one-click-updates).

Changed `SITE_ADDRESS`? `./deploy/prod.sh restart web` to pick it up. Stopping the stack while keeping
all data is `./deploy/prod.sh down` (note: `down -v` **destroys the volumes** — that's your entire
dataset, so don't, unless you mean it).

---

## Staying up on its own

Every service has `restart: unless-stopped`, and the Docker daemon is enabled at boot, so the stack
comes back by itself after a power cycle or a crash — no 3 a.m. heroics required. Data lives in named
volumes (`pgdata`, `miniodata`, `caddy_data`, `caddy_config`) plus the backup bind mount.

---

## What deployment does *not* buy you

The E2EE model means none of this changes the fundamental deal: an archive, a database dump, or a full
MinIO bucket is **useless without a user's 12-word recovery phrase**, and a forgotten phrase is
unrecoverable — from backups too. You are hosting encrypted blobs beautifully. You still can't read
them, and neither can anyone who steals the box. That's the feature.

Next: [MAINTENANCE.md](./MAINTENANCE.md) for backups, restore, upgrades, and the operations crib sheet.
