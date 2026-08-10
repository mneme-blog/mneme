// Package config loads relay configuration from the environment.
package config

import (
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	DatabaseURL string
	ListenAddr  string
	SessionTTL  time.Duration
	// CORSOrigins is a comma-separated allowlist, or "*" to reflect any origin.
	// An explicitly EMPTY value means "allow no cross-origin caller", which is
	// correct for a same-origin deployment behind a reverse proxy — so it is
	// read with LookupEnv, not the empty-means-unset env() helper. Setting
	// CORS_ORIGINS="" used to fall through to the "*" default and quietly give
	// a production relay reflect-any-origin.
	CORSOrigins string
	AdminToken  string // bearer token for /admin; empty disables the admin surface entirely
	Version     string // build identifier, set by main (not from the environment)
	UpdateCheck bool   // whether the admin surface may query GitHub for a newer release
	// UpdateSpoolDir enables one-click updates from /admin. It is the directory
	// the relay shares with the host-side updater agent (deploy/updater): the
	// relay writes an update request there, the agent applies it and writes its
	// progress back. Empty (the default) means the dashboard can report that a
	// newer release exists but offers no button — which is the correct default,
	// because applying an update requires an agent the operator installed on the
	// host on purpose. The relay never gains any host access of its own.
	UpdateSpoolDir string
	// RequireApproval gates new vaults behind operator approval. Off by default
	// (open trust-on-first-use). When on, a newly registered owner is 'pending'
	// and cannot authenticate until approved in /admin; owners already on the
	// relay are grandfathered to 'approved' by migration 0003, so turning this on
	// never locks out an existing user. See CLAUDE.md §3 / docs/API.md "Admin".
	RequireApproval bool
	// TrustProxyHeaders makes rate limiting read the client address from
	// X-Forwarded-For / X-Real-IP. Only turn this on when the relay is actually
	// behind a proxy that overwrites those headers (the deploy/web Caddy setup
	// does): a client can otherwise set them itself and sidestep the limiter.
	TrustProxyHeaders bool
	RateLimit         RateLimitConfig
	Quota             QuotaConfig
	Transcribe        TranscribeConfig
	S3                S3Config
	Backup            BackupConfig
}

// RateLimitConfig throttles the three unauthenticated endpoints (register,
// auth/challenge, auth/verify). They are the only way in, so leaving them
// unbounded means anyone can create owners and consume storage with no
// authenticated actor behind it. Per client IP, in-process (§7: one binary,
// homelab scale) — a distributed attacker is the reverse proxy's problem.
// Setting either value to 0 disables the limiter.
// Admin* bounds guesses at ADMIN_TOKEN on /admin/*. Charged on failed
// authentications only, so a dashboard holding a valid token never spends from
// it — which is why the budget can be much tighter than the client one.
type RateLimitConfig struct {
	AuthPerMinute  int // sustained rate per IP
	AuthBurst      int // bucket ceiling, i.e. how much back-to-back is tolerated
	AdminPerMinute int
	AdminBurst     int
}

// QuotaConfig bounds what a single owner may store. maxMediaChunks caps one
// media object (~10 GiB) but not the number of objects, and nothing capped the
// oplog at all, so one authenticated owner could fill the disk.
// 0 means unlimited, which is the right default for a single-tenant relay and
// the wrong one for anything internet-facing.
type QuotaConfig struct {
	// BytesPerOwner covers entry ciphertext plus finalized media bytes.
	BytesPerOwner int64
}

// TranscribeConfig governs the transcription gate: the relay authorizes each
// call to the bundled speech-to-text service, and the audio itself goes straight
// from the browser to that service (it must never pass through this process —
// CLAUDE.md §2). Every name carries its unit, because "50" on its own could mean
// recordings, minutes, words or megabytes.
//
// Counters live in memory, like the rate limiter (§7: one binary, homelab
// scale). Two consequences worth knowing: a relay restart resets the day's
// usage, and the relay does not write down how often a vault transcribes —
// deliberately, since that would be a new per-owner behavioural record it
// otherwise has no reason to keep.
type TranscribeConfig struct {
	// QuotaRequestsPerDay is how many recordings one vault may send per UTC day.
	// 0 = unlimited.
	QuotaRequestsPerDay int
	// QuotaMegabytesPerDay caps the audio one vault may upload per UTC day.
	// Advisory: it is charged from the request's declared Content-Length, which a
	// client controls. The hard per-request bound is the proxy's body cap
	// (TRANSCRIBE_MAX_UPLOAD_MEGABYTES in deploy/web/Caddyfile). 0 = unlimited.
	QuotaMegabytesPerDay int64
	// RateRequestsPerMinute / RateBurstRequests throttle one vault's calls, which
	// is what bounds how much CPU a single signed-in device can occupy. Either at
	// 0 disables the throttle.
	RateRequestsPerMinute int
	RateBurstRequests     int
}

// Summary is the one-line startup report. It exists so an operator can read the
// effective policy out of the log instead of inferring it from four env vars.
func (t TranscribeConfig) Summary() string {
	quota := "unlimited recordings"
	if t.QuotaRequestsPerDay > 0 {
		quota = fmt.Sprintf("%d recordings", t.QuotaRequestsPerDay)
	}
	if t.QuotaMegabytesPerDay > 0 {
		quota += fmt.Sprintf(" / %d MB of audio", t.QuotaMegabytesPerDay)
	}
	rate := "no per-vault rate limit"
	if t.RateRequestsPerMinute > 0 && t.RateBurstRequests > 0 {
		rate = fmt.Sprintf("%d requests/minute (burst %d)", t.RateRequestsPerMinute, t.RateBurstRequests)
	}
	return fmt.Sprintf(
		"transcription: %s per vault per UTC day, %s; counters are in memory and reset when the relay restarts",
		quota, rate)
}

// S3Config is consumed by the media blob coordination (internal/blobs) — §10 step 5.
type S3Config struct {
	Endpoint  string
	AccessKey string
	SecretKey string
	Bucket    string
}

// BackupConfig governs operator backups (internal/backup). A backup is a single
// archive of every vault's opaque ciphertext blobs + media chunks — no keys, no
// plaintext — so it is exactly as sensitive as the relay's own storage. An empty
// Dir disables the scheduled worker and the dashboard's server-side backup actions
// (the `journald backup`/`restore` CLI subcommands still work with an explicit path).
type BackupConfig struct {
	Dir      string        // BACKUP_DIR; empty disables server-side backups
	Interval time.Duration // BACKUP_INTERVAL; cadence of the scheduled worker
	Keep     int           // BACKUP_KEEP; retained archives (newest first), 0 = keep all
}

// Load reads configuration from the environment, applying dev-friendly defaults.
func Load() Config {
	return Config{
		DatabaseURL: env("DATABASE_URL", "postgres://journal:journal_dev@localhost:5432/journal?sslmode=disable"),
		ListenAddr:  env("LISTEN_ADDR", ":8080"),
		SessionTTL:  envDuration("SESSION_TTL", 24*time.Hour),
		CORSOrigins: envAllowEmpty("CORS_ORIGINS", "*"),
		AdminToken:  env("ADMIN_TOKEN", ""),
		// Version is stamped in by main via -ldflags; not an env value.
		UpdateCheck:       envBool("UPDATE_CHECK", true),
		UpdateSpoolDir:    env("UPDATE_SPOOL_DIR", ""),
		RequireApproval:   envBool("REQUIRE_APPROVAL", false),
		TrustProxyHeaders: envBool("TRUST_PROXY_HEADERS", false),
		RateLimit: RateLimitConfig{
			// Generous enough that a real client never notices: a sign-in is
			// three calls, and a retry loop a handful more.
			AuthPerMinute: envInt("RATE_LIMIT_AUTH_PER_MINUTE", 30),
			AuthBurst:     envInt("RATE_LIMIT_AUTH_BURST", 15),
			// Forgiving enough that an operator mistyping the token a few times
			// is not locked out for long, tight enough that guessing is hopeless.
			AdminPerMinute: envInt("RATE_LIMIT_ADMIN_PER_MINUTE", 10),
			AdminBurst:     envInt("RATE_LIMIT_ADMIN_BURST", 10),
		},
		Quota: QuotaConfig{
			BytesPerOwner: envInt64("QUOTA_BYTES_PER_OWNER", 0),
		},
		Transcribe: TranscribeConfig{
			// 50 recordings a day is invisible to a person keeping a journal and
			// expensive for anything else: each one occupies a CPU core for the
			// length of the audio.
			QuotaRequestsPerDay:   envInt("TRANSCRIBE_QUOTA_REQUESTS_PER_DAY", 50),
			QuotaMegabytesPerDay:  envInt64("TRANSCRIBE_QUOTA_MEGABYTES_PER_DAY", 0),
			RateRequestsPerMinute: envInt("TRANSCRIBE_RATE_REQUESTS_PER_MINUTE", 6),
			RateBurstRequests:     envInt("TRANSCRIBE_RATE_BURST_REQUESTS", 6),
		},
		S3: S3Config{
			Endpoint:  env("S3_ENDPOINT", ""),
			AccessKey: env("S3_ACCESS_KEY", ""),
			SecretKey: env("S3_SECRET_KEY", ""),
			Bucket:    env("S3_BUCKET", ""),
		},
		Backup: BackupConfig{
			Dir:      env("BACKUP_DIR", ""),
			Interval: envDuration("BACKUP_INTERVAL", 24*time.Hour),
			Keep:     envInt("BACKUP_KEEP", 7),
		},
	}
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// envAllowEmpty distinguishes "unset" from "set to the empty string". For most
// settings those mean the same thing; for an allowlist they are opposites —
// unset means "no preference, use the default", empty means "allow nothing".
func envAllowEmpty(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return def
}

// The env parsers below never fail silently: a value that doesn't parse (or a
// negative where none makes sense) falls back to the default WITH a warning in
// the log. Silence here turned `QUOTA_BYTES_PER_OWNER=10GB` into "unlimited"
// and a mistyped SESSION_TTL into already-expired sessions, with nothing
// telling the operator.

func envDuration(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			if d < 0 {
				log.Printf("config: %s=%q is negative — using default %s", key, v, def)
				return def
			}
			return d
		}
		log.Printf("config: %s=%q is not a duration (want e.g. \"24h\", \"30m\") — using default %s", key, v, def)
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			if n < 0 {
				log.Printf("config: %s=%q is negative — using default %d", key, v, def)
				return def
			}
			return n
		}
		log.Printf("config: %s=%q is not an integer — using default %d", key, v, def)
	}
	return def
}

func envInt64(key string, def int64) int64 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			if n < 0 {
				log.Printf("config: %s=%q is negative — using default %d", key, v, def)
				return def
			}
			return n
		}
		log.Printf("config: %s=%q is not an integer — using default %d", key, v, def)
	}
	return def
}

func envBool(key string, def bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	switch v {
	case "":
		return def
	case "0", "false", "off", "no":
		return false
	case "1", "true", "on", "yes":
		return true
	default:
		// Only known spellings flip the switch: "flase" must not silently mean
		// true (the asymmetric direction for anything security-relevant).
		log.Printf("config: %s=%q is not a boolean (want true/false) — using default %v", key, v, def)
		return def
	}
}
