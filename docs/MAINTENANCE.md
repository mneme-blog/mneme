# Maintenance & operations

The unglamorous-but-load-bearing side of running a Mneme relay: backups, restore, upgrades, health
checks, and what to do when something goes sideways. This assumes you've already stood up the
production stack from [DEPLOYMENT.md](./DEPLOYMENT.md); commands use the `./deploy/prod.sh` wrapper.

A reassuring reminder before we start: the relay is a **dumb encrypted-blob courier**. It holds no
keys and no plaintext, so most "maintenance" here is ordinary infrastructure hygiene — copy some
files, watch some logs, prune some images — rather than anything that could actually read a soul.

> **Dev vs prod:** in the dev stack, swap `./deploy/prod.sh` for `docker compose` and the CLI path
> `/journald` still applies (`docker compose exec server /journald …`).

---

## The 30-second health check

```bash
./deploy/prod.sh ps                          # every service Up / healthy?
curl -k https://<host>/mneme/healthz         # {"status":"ok"}  — liveness
curl -k https://<host>/mneme/readyz          # readiness — also pings Postgres
```

If `/healthz` answers but `/readyz` doesn't, the relay is alive but can't reach Postgres — check the
`postgres` container and credentials before anything else.

The **admin dashboard** at `https://<host>/mneme/admin` (with your `ADMIN_TOKEN`) shows per-vault
storage footprints, daily aggregates, runtime stats, and the backup controls. It shows health and
growth, never people — see [API.md](./API.md#admin).

---

## Backups

The relay writes a gzipped-tar archive of **every vault's ciphertext** — bookkeeping tables as NDJSON
plus the client-encrypted media chunks. **No keys, no plaintext** (the relay never had any), so an
archive is exactly as sensitive as the relay's own storage: it neither strengthens nor weakens E2EE.
`sessions` and `auth_challenges` are deliberately excluded so a restore can't resurrect a stale
credential.

In production, backups run **automatically** on `BACKUP_INTERVAL` (default 24 h), keeping the newest
`BACKUP_KEEP` (default 14) in `BACKUP_HOST_DIR`. To take one right now, or see what exists:

```bash
./deploy/prod.sh exec server /journald backup          # write one archive now
./deploy/prod.sh exec server /journald list-backups    # list archives in BACKUP_DIR
```

You can also trigger and download backups from the admin dashboard, or via the API
(`POST /admin/backups`, `GET /admin/backups`, `GET /admin/backups/{name}`).

### Copy them off the box (this is the actual disaster recovery)

A backup that lives only on the server it protects is not a backup; it's a slightly smug copy waiting
to die alongside the original. **Copy archives to another machine.** They're already encrypted (only
client-encrypted blobs inside), so moving them around is safe. A cron on another host does the job:

```bash
0 5 * * * rsync -a user@mneme-host:/home/user/mneme-backups/ ~/mneme-backups-mirror/
```

> **Belt and braces:** although archives contain no plaintext, they *do* concentrate all vaults' data
> and the accepted metadata into one portable file. Restrict the directory (`0700` / files `0600`),
> and if you're shipping them somewhere less trusted, wrap them with `age` or `gpg` first.

---

## Restore (disaster recovery)

Restore is **destructive**: it replaces *all* relay data with the archive's contents (a transactional
truncate-and-replay; a failure leaves existing data untouched), then re-uploads media chunks to object
storage. It clears sessions, so every device re-authenticates on next sync. The **recommended** path
is the CLI, run against a **stopped** relay — which is the usual state when you're recovering anyway:

```bash
./deploy/prod.sh stop server
./deploy/prod.sh run --rm server restore /backups/<archive> --yes
./deploy/prod.sh start server
```

There's also an admin-surface restore (`POST /admin/backups/{name}/restore` with a typed
`{"confirm":"restore"}` body) for restoring on a running server. An archive whose schema version is
newer than the running binary is refused — **upgrade `journald` first**.

And the load-bearing caveat, one more time: a restored archive is still just ciphertext. It brings back
everyone's encrypted blobs; it does **not** bring back anyone's forgotten recovery phrase. There is no
phrase in there to restore.

---

## Upgrades

Two ways: from the dashboard (one click, with an automatic backup and rollback) or on the host by
hand. Both end up in the same place; the button is the same sequence, minus you being awake for it.

### On the host

```bash
./deploy/prod.sh pull                   # fetch the released images
./deploy/prod.sh up -d                  # rolling restart onto them
./deploy/prod.sh ps                     # confirm healthy
```

To build from your own working tree instead of the published images:

```bash
git pull
./deploy/prod.sh up -d --build
```

Database migrations are **forward-only** and **embedded in the binary** — they apply automatically on
startup. There's no separate migration step to run and, by design, no "down" migrations. See
[Rolling back](#rolling-back) for what that means when you need to reverse one.

---

## One-click updates

The `/admin` dashboard can apply an update itself: **Version & updates** → *Update to vX.Y.Z*. It
takes a full backup first, pulls the release, restarts, waits for the stack to report healthy, and
**puts the previous version back automatically if it doesn't**.

This is off by default and needs a one-time install, because applying an update means restarting the
stack — a privilege the relay deliberately does not have.

### How it's put together

```
/admin  ──POST /admin/update──>  relay  ──writes request.json──>  spool dir (shared)
                                                                        │
                                                        systemd path unit fires
                                                                        ▼
                                       mneme-updater.sh (root, on the host)
                                       backup → pull → up -d → health gate
                                                     │ fails
                                                     ▼
                                            previous version restored
```

The relay writes a request and reads back progress. It never touches Docker, and **the Docker socket
is never mounted into any container** — the agent that holds that privilege lives on the host, runs
as root under systemd, and accepts exactly two instructions: *update to `<validated version tag>`* or
*roll back*. Nothing else about the operation comes from the relay: not the registry, not the image,
not a command. A fully compromised relay can ask for a downgrade to a published Mneme release, and
that is the entire blast radius.

### Install it

```bash
sudo ./deploy/updater/install.sh
```

Then add the two lines it prints to `.env.prod` and restart the stack:

```bash
UPDATE_SPOOL_HOST_DIR=/var/lib/mneme/spool
UPDATE_SPOOL_DIR=/var/lib/mneme/spool

./deploy/prod.sh up -d
```

Requires `docker`, `jq`, `curl`, `flock`, and systemd on the host. Until those two lines are set the
dashboard still reports new releases and simply offers no button — installing the agent does not
silently switch the feature on.

Watch a run: `journalctl -u mneme-updater.service -f`, or the log tail shown in the dashboard panel.
Remove it again with `sudo ./deploy/updater/install.sh --uninstall`.

### What a run actually does

1. **Backup** — a full archive of every vault, before anything changes. Failing here aborts the
   update; nothing is touched.
2. **Pin & pull** — writes `deploy/version.env` (the installed-version record `prod.sh` reads) and
   pulls `mneme-server` and `mneme-web` at the requested tag. A failed pull restores the old pin.
3. **Restart** — `up -d --no-build` onto the new images. Migrations run at startup, as always.
4. **Health gate** — waits for the relay container to report healthy. The container healthcheck runs
   `journald healthcheck` → `/readyz`, which only passes once migrations have applied *and* Postgres
   is reachable, so a release that can't migrate is detected rather than left serving errors.
   Optionally also probes the site through Caddy.
5. **Rollback on failure** — if it doesn't come up, the previous images (still in the local cache)
   go straight back and the dashboard says so.

The stack is briefly unavailable during step 3. Clients don't care: the local database on each device
is the source of truth, so they keep working offline and sync when the relay returns.

---

## Rolling back

**Version & updates → Roll back** returns to the previously installed version. Whether that's cheap
or expensive depends on what the update did to the schema, and the dashboard tells you which *before*
you commit.

Migrations are forward-only, so rolling the *binary* back to N−1 leaves the *schema* at N. That's
fine when the migration only added things — an older relay simply never selects the new column — and
broken when it removed or narrowed something the old code still reads. Every migration declares which
it is (`-- rollback: safe` / `-- rollback: breaking`, enforced by a test), the release workflow
publishes that as the release's `mneme-release.json` asset, and the relay reads it:

| Cost | What happens | Data loss |
|---|---|---|
| **fast** | The images are swapped back. The newer schema stays; the older binary ignores the parts it doesn't know. | None |
| **deep** | The database is rebuilt at the old schema and the **pre-update backup** is replayed into it. | Everything written since the update |
| **unknown** | The release published no schema manifest (anything from before this mechanism). Try fast; the pre-update archive is still there if it fails. | — |

A deep rollback is offered only when it's the actual remedy, and needs its own tick-box on top of the
typed confirmation. It is genuinely destructive: it is the answer to "the update broke the schema",
not to "I don't like the new button".

Two things a server-side rollback does **not** undo:

- **Client-side migrations.** Each device's local database is also forward-only. Once someone has
  opened the new client, their device is migrated; serving them the old bundle again doesn't reverse
  that. It degrades rather than corrupts, but it isn't guaranteed, so treat rollback as a server-side
  remedy.
- **Anything written after the update**, if you go deep. That's inherent to replaying a backup.

Manual equivalent, if the agent isn't installed or you'd rather drive it yourself:

```bash
# fast: pin the old tag and restart
printf 'MNEME_VERSION=v0.2.1\nMNEME_SERVER_IMAGE=ghcr.io/plasticparticle/mneme-server:v0.2.1\nMNEME_WEB_IMAGE=ghcr.io/plasticparticle/mneme-web:v0.2.1\n' > deploy/version.env
./deploy/prod.sh pull && ./deploy/prod.sh up -d --no-build

# deep: rebuild the database at the old schema, then restore
./deploy/prod.sh stop server web
./deploy/prod.sh exec -T postgres psql -U journal -d postgres \
  -c 'DROP DATABASE journal WITH (FORCE)' -c 'CREATE DATABASE journal OWNER journal'
./deploy/prod.sh up -d server                       # old binary migrates to its own head
./deploy/prod.sh exec -T server /journald restore /backups/<archive> --yes
./deploy/prod.sh up -d
```

---

## Logs & troubleshooting

```bash
./deploy/prod.sh logs -f server         # relay logs (auth, sync, errors)
./deploy/prod.sh logs -f web            # Caddy: access logs + TLS issuance
./deploy/prod.sh logs -f postgres       # database
```

| Symptom | Likely cause & fix |
|---|---|
| Client shows "offline", relay is up | Wrong relay URL, or the browser rejected Caddy's cert. Check the Relay-server row in Preferences and that you accepted/installed the CA (see [DEPLOYMENT.md](./DEPLOYMENT.md#https-on-a-lan-why-and-how-to-stop-the-browser-sulking)). |
| Media uploads stay queued | `S3_ENDPOINT` unset or MinIO down — media endpoints answer `503` and clients retry. Check the `minio` container. |
| `/readyz` failing | Postgres unreachable — check the `postgres` container, volume, and password. |
| New relay endpoint 404s after a deploy | Compose reused a stale image. Force it: `./deploy/prod.sh up -d --build server`. |
| `/admin` returns 404 | Intended when `ADMIN_TOKEN` is empty. Set it in `.env.prod` and redeploy to enable the surface. |
| A client feels haunted after a dependency bump | A long-lived dev Vite server can go stale; restart it against a cold server before chasing ghosts. |

---

## Housekeeping

```bash
docker system prune                     # drop dangling image layers (occasionally)
./deploy/prod.sh exec postgres \
  psql -U mneme -c 'SELECT count(*) FROM entry_blobs;'   # poke the bookkeeping DB directly
```

- **Volumes** (`pgdata`, `miniodata`, `caddy_data`, `caddy_config`) hold everything. `./deploy/prod.sh
  down` keeps them; `down -v` **destroys** them. The distinction is one character and your entire
  dataset — respect it.
- **Rotating dev credentials:** if you ever ran the dev stack with `_dev` defaults and then went to
  prod, make sure `.env.prod` has genuinely new secrets. The `_dev` values are public knowledge (they
  live in `docker-compose.yml`), which is fine for localhost and catastrophic anywhere else.
- **Reclaiming abandoned vaults:** an operator can wipe a vault by id from the admin dashboard (typed
  `"delete"` confirmation) or `DELETE /admin/vaults/{id}`. This frees storage; it cannot read anything
  first.

---

## What maintenance can never do

No amount of operator access lets you read, recover, or reset a user's journal. That isn't a missing
runbook entry — it's the [security model](./SECURITY.md) working exactly as designed. If a user loses
their phrase, the kindest and only true answer is: it's gone. Point them at the big yellow warning box
they were shown at the start, gently.
