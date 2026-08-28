# Mneme docs

The full documentation set. The top-level [`../README.md`](../README.md) is the short orientation —
what Mneme is and how to get it running in one command; everything here is the detailed reference. Start wherever your curiosity (or your
incident) points you.

## For everyone

| Doc | What's in it |
|---|---|
| [FEATURES.md](./FEATURES.md) | Everything Mneme can do **today**, in one place. |
| [ROADMAP.md](./ROADMAP.md) | Honest status board — built, planned, and deliberately-not-building. |

## How it works

| Doc | What's in it |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | How the system fits together — components, key derivation, the sync sequence, the data model. Has diagrams. |
| [ENCRYPTION.md](./ENCRYPTION.md) | The cryptography: primitives, the key hierarchy, the ciphertext envelope, at-rest seals, and rotation. |
| [SECURITY.md](./SECURITY.md) | The E2EE threat model and a frank list of **attack vectors and known weaknesses** (mitigated / accepted / open), including the folded-in code-review findings. |
| [API.md](./API.md) | The relay's HTTP API — endpoints, request/response shapes, auth, admin, backups. |

## Running it

| Doc | What's in it |
|---|---|
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Self-hosted **production** deployment: the one-command installer (`deploy/install.sh`), the Docker + Caddy stack, HTTPS on a LAN, first start. |
| [PWA.md](./PWA.md) | Installing Mneme as an app — the secure-context rule, and testing install from the dev server on a phone. |
| [MAINTENANCE.md](./MAINTENANCE.md) | Day-two operations: backups, restore, upgrades, health checks, troubleshooting. |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Dev setup, the quality gates, conventions, and where things live. |

## Related, outside `docs/`

- [`../README.md`](../README.md) — the friendly overview + quick local start.
- [`../server/README.md`](../server/README.md) — running and testing the Go relay specifically.
- [`../CLAUDE.md`](../CLAUDE.md) — the **decision document** and source of truth (§0 is the operating
  guide; §1–§12 the binding decisions). Locked decisions and the build-order roadmap live here.
- [`../SECURITY-AUDITS.md`](../SECURITY-AUDITS.md) — both internal security audit passes, verbatim,
  newest first, with what each finding turned into.

> If a doc here ever disagrees with `CLAUDE.md` on a *decision*, `CLAUDE.md` wins. These docs describe
> and explain; `CLAUDE.md` decides.
