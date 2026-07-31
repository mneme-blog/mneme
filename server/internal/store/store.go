// Package store is the Postgres data layer for the relay. It stores only opaque
// ciphertext and metadata, and every entry/reminder query is scoped by owner_id
// so a tenant can never reach another tenant's rows.
package store

import (
	"bytes"
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	pool *pgxpool.Pool
}

// New opens a connection pool and verifies connectivity.
func New(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// Migrate applies pending migrations.
func (s *Store) Migrate(ctx context.Context) error { return Migrate(ctx, s.pool) }

// ── Owners & devices ────────────────────────────────────────────────────────

// Owner approval states (migration 0003). An owner may authenticate only while
// StatusApproved. With REQUIRE_APPROVAL off, owners are created approved.
const (
	OwnerStatusPending  = "pending"
	OwnerStatusApproved = "approved"
	OwnerStatusRejected = "rejected"
)

// ErrBindingNotAuthorized is returned when a registration is not allowed to bind
// the presented device to the requested owner — the H1 guard. The caller must
// turn it into a single, undifferentiated 401: which half of the check failed
// (and whether the owner exists at all) is not the caller's business.
var ErrBindingNotAuthorized = errors.New("device binding not authorized for this owner")

// RegisterOwnerDevice creates the owner if absent (trust-on-first-use) and binds
// the device to it, but only when the caller is authorized to do so. Idempotent:
// re-registering the same keys is a no-op — in particular ON CONFLICT DO NOTHING
// means status/hint are set only when the owner is first created and never
// overwritten (an approved owner can't be silently reset to pending by
// re-registering). ownerCreated reports whether this call created a brand-new
// owner (vault), so the caller can count vault creations without storing who
// created what.
//
// ownerSignPub is the Ed25519 owner identity signing key that authorizes binding
// devices to this owner (migration 0004). The API layer has already verified the
// caller's signature under it; what this function decides is whether that key may
// act for this owner:
//
//   - owner does not exist          → TOFU. The key is pinned on creation.
//   - owner has a pinned key        → must equal ownerSignPub, else not authorized.
//   - owner predates migration 0004 → one-shot grandfathering: allowed only from a
//     device already bound to this owner (device keys are seed-derived, so an
//     honest client always presents one and an attacker holding just the owner
//     public key cannot). The presented key is then pinned.
//
// The check and the writes share one transaction, and the owner row is locked for
// the duration, so two concurrent registrations cannot both pass the check and
// then race each other's pin.
func (s *Store) RegisterOwnerDevice(ctx context.Context, ownerID string, ownerPub []byte, deviceID string, devicePub []byte, status, approvalHint string, ownerSignPub []byte) (ownerCreated bool, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // rollback after commit is a no-op

	var pinned []byte
	ownerExists := true
	err = tx.QueryRow(ctx, `SELECT owner_sign_pubkey FROM owners WHERE owner_id = $1 FOR UPDATE`, ownerID).Scan(&pinned)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		ownerExists = false
	case err != nil:
		return false, err
	}

	switch {
	case !ownerExists:
		// TOFU: whoever creates the vault pins its authorization key. A client
		// that sends none creates an owner nothing can ever be re-bound to, so
		// require it — this is the only place the pin can be established safely.
		if len(ownerSignPub) == 0 {
			return false, ErrBindingNotAuthorized
		}
	case len(pinned) > 0:
		if !bytes.Equal(pinned, ownerSignPub) {
			return false, ErrBindingNotAuthorized
		}
	default:
		// Pre-0004 owner: only a device the relay already knows for this owner
		// may register (and thereby pin a key going forward).
		var bound bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM devices WHERE device_id = $1 AND owner_id = $2 AND device_pubkey = $3)`,
			deviceID, ownerID, devicePub).Scan(&bound); err != nil {
			return false, err
		}
		if !bound {
			return false, ErrBindingNotAuthorized
		}
	}

	tag, err := tx.Exec(ctx,
		`INSERT INTO owners (owner_id, owner_pubkey, status, approval_hint, owner_sign_pubkey)
		 VALUES ($1, $2, $3, $4, $5) ON CONFLICT (owner_id) DO NOTHING`,
		ownerID, ownerPub, status, approvalHint, ownerSignPub)
	if err != nil {
		return false, err
	}
	ownerCreated = tag.RowsAffected() == 1
	if !ownerCreated && len(pinned) == 0 && len(ownerSignPub) > 0 {
		// Grandfathering: adopt a signing key for a pre-0004 owner. Guarded by
		// `IS NULL` as well as the row lock, so it is strictly one-shot.
		if _, err := tx.Exec(ctx,
			`UPDATE owners SET owner_sign_pubkey = $2 WHERE owner_id = $1 AND owner_sign_pubkey IS NULL`,
			ownerID, ownerSignPub); err != nil {
			return false, err
		}
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO devices (device_id, owner_id, device_pubkey) VALUES ($1, $2, $3) ON CONFLICT (device_id) DO NOTHING`,
		deviceID, ownerID, devicePub); err != nil {
		return false, err
	}
	return ownerCreated, tx.Commit(ctx)
}

// OwnerStatus returns an owner's approval status, or ErrNotFound if it is absent.
func (s *Store) OwnerStatus(ctx context.Context, ownerID string) (string, error) {
	var status string
	err := s.pool.QueryRow(ctx, `SELECT status FROM owners WHERE owner_id = $1`, ownerID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return status, err
}

// SetOwnerStatus records an operator's approve/reject decision. found=false when
// no such owner exists. Enforcement is immediate: the auth middleware reads the
// live status on every request, so a rejected owner is cut off on its next call
// rather than when its session eventually expires.
func (s *Store) SetOwnerStatus(ctx context.Context, ownerID, status string) (found bool, err error) {
	tag, err := s.pool.Exec(ctx, `UPDATE owners SET status = $2 WHERE owner_id = $1`, ownerID, status)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

var ErrNotFound = errors.New("not found")

// DevicePubkey returns the owner_id and Ed25519 public key for a device.
func (s *Store) DevicePubkey(ctx context.Context, deviceID string) (ownerID string, pub []byte, err error) {
	err = s.pool.QueryRow(ctx,
		`SELECT owner_id, device_pubkey FROM devices WHERE device_id = $1`, deviceID).
		Scan(&ownerID, &pub)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, ErrNotFound
	}
	return ownerID, pub, err
}

// ── Auth: challenges & sessions ─────────────────────────────────────────────

func (s *Store) SaveChallenge(ctx context.Context, deviceID string, challenge []byte, expires time.Time) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO auth_challenges (device_id, challenge, expires_at) VALUES ($1, $2, $3)`,
		deviceID, challenge, expires)
	return err
}

// ConsumeChallenge atomically deletes a still-valid challenge, returning true if
// it existed and had not expired (single-use).
func (s *Store) ConsumeChallenge(ctx context.Context, deviceID string, challenge []byte) (bool, error) {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM auth_challenges WHERE device_id = $1 AND challenge = $2 AND expires_at > now()`,
		deviceID, challenge)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func (s *Store) CreateSession(ctx context.Context, tokenHash []byte, deviceID, ownerID string, expires time.Time) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO sessions (token_hash, device_id, owner_id, expires_at) VALUES ($1, $2, $3, $4)`,
		tokenHash, deviceID, ownerID, expires)
	return err
}

// LookupSession returns the owner/device (and the owner's live approval status)
// for a valid, unexpired session token hash. The status ride-along lets the auth
// middleware enforce approval/revocation on every request without a second query.
func (s *Store) LookupSession(ctx context.Context, tokenHash []byte) (ownerID, deviceID, status string, err error) {
	err = s.pool.QueryRow(ctx,
		`SELECT s.owner_id, s.device_id, o.status
		   FROM sessions s JOIN owners o ON o.owner_id = s.owner_id
		  WHERE s.token_hash = $1 AND s.expires_at > now()`,
		tokenHash).Scan(&ownerID, &deviceID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", "", ErrNotFound
	}
	return ownerID, deviceID, status, err
}

// ── Account deletion (mnemonic rotation) ────────────────────────────────────

// ListOwnerMedia returns every media index row for an owner, so the caller can
// remove the chunk objects from object storage before/after the DB wipe.
func (s *Store) ListOwnerMedia(ctx context.Context, ownerID string) ([]MediaBlob, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT media_id, s3_key, bytes, chunks FROM media_blobs WHERE owner_id = $1`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []MediaBlob
	for rows.Next() {
		var m MediaBlob
		if err := rows.Scan(&m.MediaID, &m.S3Key, &m.Bytes, &m.Chunks); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// DeleteOwner removes the owner row; every other table (devices, sessions,
// challenges, entry_blobs, media_blobs, reminders, push_subs) cascades from it.
// This is the server half of mnemonic rotation: after the client has re-pushed
// everything under a fresh owner, the old owner's data must stop existing — the
// leaked phrase keeps authenticating otherwise. found=false when no such owner
// existed (already idempotently gone).
func (s *Store) DeleteOwner(ctx context.Context, ownerID string) (found bool, err error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM owners WHERE owner_id = $1`, ownerID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// PurgeExpired removes stale challenges and sessions. Safe to call periodically.
func (s *Store) PurgeExpired(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, `DELETE FROM auth_challenges WHERE expires_at <= now()`); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE expires_at <= now()`)
	return err
}

// ── Sync: LWW oplog ─────────────────────────────────────────────────────────

type EntryBlob struct {
	EntryID    string
	LWWClock   int64
	Ciphertext []byte
	Deleted    bool
	Seq        int64
}

// PushEntry applies a single entry using last-write-wins on lww_clock. Returns
// applied=false when the incoming clock is not strictly newer than what's stored,
// and created=true when the row is brand new (an insert, not an LWW update) —
// xmax = 0 only holds for freshly inserted rows. The server never inspects
// ciphertext — only the clock decides.
func (s *Store) PushEntry(ctx context.Context, ownerID string, e EntryBlob) (applied, created bool, err error) {
	var seq int64
	err = s.pool.QueryRow(ctx, `
		INSERT INTO entry_blobs (owner_id, entry_id, lww_clock, ciphertext, deleted, seq, updated_at)
		VALUES ($1, $2, $3, $4, $5, nextval('entry_seq'), now())
		ON CONFLICT (owner_id, entry_id) DO UPDATE
			SET lww_clock  = EXCLUDED.lww_clock,
			    ciphertext = EXCLUDED.ciphertext,
			    deleted    = EXCLUDED.deleted,
			    seq        = nextval('entry_seq'),
			    updated_at = now()
			WHERE EXCLUDED.lww_clock > entry_blobs.lww_clock
		RETURNING seq, (xmax = 0)`,
		ownerID, e.EntryID, e.LWWClock, e.Ciphertext, e.Deleted).Scan(&seq, &created)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, false, nil // conflict, and incoming clock was not newer
	}
	if err != nil {
		return false, false, err
	}
	return true, created, nil
}

// PullEntries returns entries for an owner with seq strictly greater than `since`,
// ordered by seq, capped at `limit`. The caller derives the next cursor from the
// last returned Seq.
func (s *Store) PullEntries(ctx context.Context, ownerID string, since int64, limit int) ([]EntryBlob, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT entry_id, lww_clock, ciphertext, deleted, seq
		FROM entry_blobs
		WHERE owner_id = $1 AND seq > $2
		ORDER BY seq ASC
		LIMIT $3`,
		ownerID, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []EntryBlob
	for rows.Next() {
		var e EntryBlob
		if err := rows.Scan(&e.EntryID, &e.LWWClock, &e.Ciphertext, &e.Deleted, &e.Seq); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// ── Media ───────────────────────────────────────────────────────────────────

// MediaBlob indexes one chunked, client-encrypted media object in object storage.
// s3_key is the chunk-key prefix; the content itself never touches Postgres.
type MediaBlob struct {
	MediaID string
	S3Key   string
	Bytes   int64
	Chunks  int
}

// FinalizeMedia records a fully-uploaded media object. Idempotent re-uploads of
// the same media id simply refresh the index row. created=true only for a brand
// new object (xmax = 0 holds only for inserts), so retries don't double-count.
func (s *Store) FinalizeMedia(ctx context.Context, ownerID string, m MediaBlob) (created bool, err error) {
	err = s.pool.QueryRow(ctx, `
		INSERT INTO media_blobs (owner_id, media_id, s3_key, bytes, chunks)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (owner_id, media_id) DO UPDATE
			SET s3_key = EXCLUDED.s3_key, bytes = EXCLUDED.bytes, chunks = EXCLUDED.chunks
		RETURNING (xmax = 0)`,
		ownerID, m.MediaID, m.S3Key, m.Bytes, m.Chunks).Scan(&created)
	return created, err
}

// GetMedia returns the index row for a finalized media object.
func (s *Store) GetMedia(ctx context.Context, ownerID, mediaID string) (MediaBlob, error) {
	m := MediaBlob{MediaID: mediaID}
	err := s.pool.QueryRow(ctx,
		`SELECT s3_key, bytes, chunks FROM media_blobs WHERE owner_id = $1 AND media_id = $2`,
		ownerID, mediaID).Scan(&m.S3Key, &m.Bytes, &m.Chunks)
	if errors.Is(err, pgx.ErrNoRows) {
		return MediaBlob{}, ErrNotFound
	}
	return m, err
}

// DeleteMedia removes a media object's index row. Deleting an unknown id is not
// an error — the client's offline deletion queue retries until acknowledged.
func (s *Store) DeleteMedia(ctx context.Context, ownerID, mediaID string) error {
	_, err := s.pool.Exec(ctx,
		`DELETE FROM media_blobs WHERE owner_id = $1 AND media_id = $2`,
		ownerID, mediaID)
	return err
}

// ── Reminders ───────────────────────────────────────────────────────────────

type Reminder struct {
	ReminderID string
	FireAt     time.Time
	Dispatched bool
}

func (s *Store) UpsertReminder(ctx context.Context, ownerID, reminderID string, fireAt time.Time) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO reminders (owner_id, reminder_id, fire_at, dispatched)
		VALUES ($1, $2, $3, false)
		ON CONFLICT (owner_id, reminder_id) DO UPDATE
			SET fire_at = EXCLUDED.fire_at, dispatched = false`,
		ownerID, reminderID, fireAt)
	return err
}

func (s *Store) ListReminders(ctx context.Context, ownerID string) ([]Reminder, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT reminder_id, fire_at, dispatched FROM reminders WHERE owner_id = $1 ORDER BY fire_at ASC`,
		ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Reminder
	for rows.Next() {
		var r Reminder
		if err := rows.Scan(&r.ReminderID, &r.FireAt, &r.Dispatched); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) DeleteReminder(ctx context.Context, ownerID, reminderID string) (bool, error) {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM reminders WHERE owner_id = $1 AND reminder_id = $2`, ownerID, reminderID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// DueReminder is one reminder ready to fire, with its owner.
type DueReminder struct {
	OwnerID    string
	ReminderID string
	FireAt     time.Time
}

// ClaimDueReminders marks up-to-`limit` due reminders dispatched and returns them.
// Atomic claim (UPDATE ... RETURNING) so concurrent schedulers don't double-fire.
func (s *Store) ClaimDueReminders(ctx context.Context, now time.Time, limit int) ([]DueReminder, error) {
	rows, err := s.pool.Query(ctx, `
		UPDATE reminders SET dispatched = true
		WHERE (owner_id, reminder_id) IN (
			SELECT owner_id, reminder_id FROM reminders
			WHERE NOT dispatched AND fire_at <= $1
			ORDER BY fire_at ASC
			LIMIT $2
			FOR UPDATE SKIP LOCKED
		)
		RETURNING owner_id, reminder_id, fire_at`,
		now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []DueReminder
	for rows.Next() {
		var d DueReminder
		if err := rows.Scan(&d.OwnerID, &d.ReminderID, &d.FireAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
