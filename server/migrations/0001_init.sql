-- 0001_init.sql — initial relay schema (forward-only).
-- Everything here is opaque ciphertext or pure metadata; the server never
-- sees plaintext, keys, or the mnemonic. See CLAUDE.md §5b.
--
-- rollback: safe — the base schema; there is no earlier release to fall back to.

-- owner identity = public key derived from the mnemonic seed; no password, no email.
CREATE TABLE owners (
    owner_id     TEXT PRIMARY KEY,        -- = base64url(sha256(owner_pubkey))
    owner_pubkey BYTEA NOT NULL,          -- X25519, for sealed-box device pairing
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE devices (
    device_id     TEXT PRIMARY KEY,       -- = base64url(sha256(device_pubkey))
    owner_id      TEXT NOT NULL REFERENCES owners (owner_id) ON DELETE CASCADE,
    device_pubkey BYTEA NOT NULL,         -- Ed25519, for challenge-response auth
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX devices_owner_idx ON devices (owner_id);

-- Monotonic cursor for sync pull. Bumped on every push so clients can page
-- "everything changed since <seq>".
CREATE SEQUENCE entry_seq;

-- The LWW oplog: opaque ciphertext blobs. The server compares ONLY lww_clock.
CREATE TABLE entry_blobs (
    owner_id   TEXT   NOT NULL REFERENCES owners (owner_id) ON DELETE CASCADE,
    entry_id   TEXT   NOT NULL,
    lww_clock  BIGINT NOT NULL,           -- server compares this number, never the content
    ciphertext BYTEA  NOT NULL,           -- [version:1B][nonce:24B][ct+tag]
    deleted    BOOLEAN NOT NULL DEFAULT false,
    seq        BIGINT NOT NULL,           -- pull cursor (nextval('entry_seq'))
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, entry_id)
);
CREATE INDEX entry_blobs_pull_idx ON entry_blobs (owner_id, seq);

-- Media index. s3_key points at chunked, client-encrypted media in object storage.
CREATE TABLE media_blobs (
    owner_id   TEXT   NOT NULL REFERENCES owners (owner_id) ON DELETE CASCADE,
    media_id   TEXT   NOT NULL,
    s3_key     TEXT   NOT NULL,
    bytes      BIGINT NOT NULL,
    chunks     INT    NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, media_id)
);

-- fire_at is CLEARTEXT (an accepted leak — the scheduler needs it). Reminders
-- fire generically; the client decrypts the actual entry locally.
CREATE TABLE reminders (
    owner_id    TEXT NOT NULL REFERENCES owners (owner_id) ON DELETE CASCADE,
    reminder_id TEXT NOT NULL,
    fire_at     TIMESTAMPTZ NOT NULL,
    dispatched  BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (owner_id, reminder_id)
);
CREATE INDEX reminders_due_idx ON reminders (fire_at) WHERE NOT dispatched;

CREATE TABLE push_subs (
    owner_id  TEXT NOT NULL REFERENCES owners (owner_id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
    kind      TEXT NOT NULL,              -- 'webpush' | 'apns' | 'fcm'
    endpoint  TEXT NOT NULL,
    p256dh    TEXT,
    auth      TEXT,
    PRIMARY KEY (owner_id, device_id, kind)
);

-- Auth: short-lived challenges + opaque session tokens. The server holds no
-- long-term secret here — tokens are random strings (stored hashed), NOT content keys.
CREATE TABLE auth_challenges (
    device_id  TEXT  NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
    challenge  BYTEA NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (device_id, challenge)
);

CREATE TABLE sessions (
    token_hash BYTEA PRIMARY KEY,         -- sha256(bearer token); raw token never stored
    device_id  TEXT NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
    owner_id   TEXT NOT NULL REFERENCES owners (owner_id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);
