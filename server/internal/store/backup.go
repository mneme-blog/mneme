package store

import (
	"context"
	"fmt"
	"time"
)

// Operator backup support. A backup is a full, owner-spanning copy of the relay's
// bookkeeping tables plus the media chunk index — every value is opaque ciphertext
// or accepted metadata (§3), exactly what the relay already stores. The actual
// media bytes live in object storage and are archived separately (internal/backup).
//
// sessions and auth_challenges are deliberately NOT part of a backup: they are
// short-lived secrets (bearer-token hashes, single-use challenges) that must not be
// resurrected from an old archive. A restore therefore clears them and they
// re-establish themselves on the next device handshake.

// The row types below are the on-disk schema of a backup archive. bytea columns are
// []byte, which encoding/json serialises as base64 — the relay never interprets it.

// OwnerRow must carry every security-relevant owners column: dropping one here
// silently resets it to the column default on restore. That bit us once —
// archives written before Status/ApprovalHint/OwnerSignPub existed restored
// rejected owners as approved and erased the device-binding pin (issue #40).
// Absent fields in old archives decode to Go zero values; restore maps those to
// the safe defaults explicitly below.
type OwnerRow struct {
	OwnerID      string    `json:"owner_id"`
	OwnerPub     []byte    `json:"owner_pubkey"`
	CreatedAt    time.Time `json:"created_at"`
	Status       string    `json:"status,omitempty"`
	ApprovalHint string    `json:"approval_hint,omitempty"`
	OwnerSignPub []byte    `json:"owner_sign_pubkey,omitempty"`
}

type DeviceRow struct {
	DeviceID  string    `json:"device_id"`
	OwnerID   string    `json:"owner_id"`
	DevicePub []byte    `json:"device_pubkey"`
	CreatedAt time.Time `json:"created_at"`
}

type EntryRow struct {
	OwnerID    string    `json:"owner_id"`
	EntryID    string    `json:"entry_id"`
	LWWClock   int64     `json:"lww_clock"`
	Ciphertext []byte    `json:"ciphertext"`
	Deleted    bool      `json:"deleted"`
	Seq        int64     `json:"seq"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type MediaRow struct {
	OwnerID   string    `json:"owner_id"`
	MediaID   string    `json:"media_id"`
	S3Key     string    `json:"s3_key"`
	Bytes     int64     `json:"bytes"`
	Chunks    int       `json:"chunks"`
	CreatedAt time.Time `json:"created_at"`
}

type ReminderRow struct {
	OwnerID    string    `json:"owner_id"`
	ReminderID string    `json:"reminder_id"`
	FireAt     time.Time `json:"fire_at"`
	Dispatched bool      `json:"dispatched"`
}

type PushSubRow struct {
	OwnerID  string  `json:"owner_id"`
	DeviceID string  `json:"device_id"`
	Kind     string  `json:"kind"`
	Endpoint string  `json:"endpoint"`
	P256dh   *string `json:"p256dh"`
	Auth     *string `json:"auth"`
}

type UsageRow struct {
	Day    string `json:"day"` // YYYY-MM-DD (UTC)
	Metric string `json:"metric"`
	Count  int64  `json:"count"`
}

// SchemaVersion returns the highest applied migration version, recorded in the
// archive manifest so a restore can refuse an archive newer than the binary.
func (s *Store) SchemaVersion(ctx context.Context) (int, error) {
	var v int
	err := s.pool.QueryRow(ctx, `SELECT coalesce(max(version), 0) FROM schema_migrations`).Scan(&v)
	return v, err
}

// ── Dump (full-table export, owner-spanning) ────────────────────────────────
//
// Each Dump* streams rows through a callback so a large vault set never has to be
// held in memory at once.

func (s *Store) DumpOwners(ctx context.Context, fn func(OwnerRow) error) error {
	return scan(ctx, s, `SELECT owner_id, owner_pubkey, created_at, status, approval_hint, owner_sign_pubkey FROM owners ORDER BY created_at`,
		func(r pgxRow) error {
			var o OwnerRow
			if err := r.Scan(&o.OwnerID, &o.OwnerPub, &o.CreatedAt, &o.Status, &o.ApprovalHint, &o.OwnerSignPub); err != nil {
				return err
			}
			return fn(o)
		})
}

func (s *Store) DumpDevices(ctx context.Context, fn func(DeviceRow) error) error {
	return scan(ctx, s, `SELECT device_id, owner_id, device_pubkey, created_at FROM devices ORDER BY created_at`,
		func(r pgxRow) error {
			var d DeviceRow
			if err := r.Scan(&d.DeviceID, &d.OwnerID, &d.DevicePub, &d.CreatedAt); err != nil {
				return err
			}
			return fn(d)
		})
}

func (s *Store) DumpEntries(ctx context.Context, fn func(EntryRow) error) error {
	return scan(ctx, s, `SELECT owner_id, entry_id, lww_clock, ciphertext, deleted, seq, updated_at FROM entry_blobs ORDER BY seq`,
		func(r pgxRow) error {
			var e EntryRow
			if err := r.Scan(&e.OwnerID, &e.EntryID, &e.LWWClock, &e.Ciphertext, &e.Deleted, &e.Seq, &e.UpdatedAt); err != nil {
				return err
			}
			return fn(e)
		})
}

func (s *Store) DumpMedia(ctx context.Context, fn func(MediaRow) error) error {
	return scan(ctx, s, `SELECT owner_id, media_id, s3_key, bytes, chunks, created_at FROM media_blobs ORDER BY owner_id, media_id`,
		func(r pgxRow) error {
			var m MediaRow
			if err := r.Scan(&m.OwnerID, &m.MediaID, &m.S3Key, &m.Bytes, &m.Chunks, &m.CreatedAt); err != nil {
				return err
			}
			return fn(m)
		})
}

func (s *Store) DumpReminders(ctx context.Context, fn func(ReminderRow) error) error {
	return scan(ctx, s, `SELECT owner_id, reminder_id, fire_at, dispatched FROM reminders ORDER BY owner_id, reminder_id`,
		func(r pgxRow) error {
			var rem ReminderRow
			if err := r.Scan(&rem.OwnerID, &rem.ReminderID, &rem.FireAt, &rem.Dispatched); err != nil {
				return err
			}
			return fn(rem)
		})
}

func (s *Store) DumpPushSubs(ctx context.Context, fn func(PushSubRow) error) error {
	return scan(ctx, s, `SELECT owner_id, device_id, kind, endpoint, p256dh, auth FROM push_subs ORDER BY owner_id, device_id, kind`,
		func(r pgxRow) error {
			var p PushSubRow
			if err := r.Scan(&p.OwnerID, &p.DeviceID, &p.Kind, &p.Endpoint, &p.P256dh, &p.Auth); err != nil {
				return err
			}
			return fn(p)
		})
}

func (s *Store) DumpUsage(ctx context.Context, fn func(UsageRow) error) error {
	return scan(ctx, s, `SELECT day::text, metric, count FROM usage_daily ORDER BY day, metric`,
		func(r pgxRow) error {
			var u UsageRow
			if err := r.Scan(&u.Day, &u.Metric, &u.Count); err != nil {
				return err
			}
			return fn(u)
		})
}

// ── Restore (full replace, transactional) ───────────────────────────────────

// RestoreData is the decoded bookkeeping half of a backup archive (the media bytes
// are streamed straight to object storage by internal/backup, not held here).
type RestoreData struct {
	Owners    []OwnerRow
	Devices   []DeviceRow
	Entries   []EntryRow
	Media     []MediaRow
	Reminders []ReminderRow
	PushSubs  []PushSubRow
	Usage     []UsageRow
}

// Restore atomically replaces ALL vault data with the archive's contents. It
// truncates every owner-scoped table (cascading from owners) plus usage_daily,
// re-inserts the rows in FK order, and realigns the entry_seq pull cursor so future
// pushes get fresh sequence numbers. The whole operation is one transaction: a
// failure anywhere leaves the existing data untouched. This is the destructive half
// of disaster recovery — callers gate it behind an explicit confirmation.
func (s *Store) Restore(ctx context.Context, d *RestoreData) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // rollback after commit is a no-op

	// owners CASCADE wipes devices, entry_blobs, media_blobs, reminders, push_subs,
	// sessions and auth_challenges; usage_daily has no owner_id so clear it directly.
	if _, err := tx.Exec(ctx, `TRUNCATE owners, usage_daily CASCADE`); err != nil {
		return fmt.Errorf("restore truncate: %w", err)
	}

	for _, o := range d.Owners {
		// Old archives (pre-status/sign-key) decode with zero values: map an
		// absent status to 'approved' (matching the migration-0003 grandfathering
		// of pre-existing owners) and keep an absent sign key NULL (pre-0004
		// grandfathering path). A present value must round-trip verbatim — a
		// rejected owner stays rejected across restore.
		status := o.Status
		if status == "" {
			status = "approved"
		}
		var signPub any
		if len(o.OwnerSignPub) > 0 {
			signPub = o.OwnerSignPub
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO owners (owner_id, owner_pubkey, created_at, status, approval_hint, owner_sign_pubkey)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			o.OwnerID, o.OwnerPub, o.CreatedAt, status, o.ApprovalHint, signPub); err != nil {
			return fmt.Errorf("restore owner %s: %w", o.OwnerID, err)
		}
	}
	for _, dv := range d.Devices {
		if _, err := tx.Exec(ctx,
			`INSERT INTO devices (device_id, owner_id, device_pubkey, created_at) VALUES ($1, $2, $3, $4)`,
			dv.DeviceID, dv.OwnerID, dv.DevicePub, dv.CreatedAt); err != nil {
			return fmt.Errorf("restore device %s: %w", dv.DeviceID, err)
		}
	}
	for _, e := range d.Entries {
		if _, err := tx.Exec(ctx,
			`INSERT INTO entry_blobs (owner_id, entry_id, lww_clock, ciphertext, deleted, seq, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			e.OwnerID, e.EntryID, e.LWWClock, e.Ciphertext, e.Deleted, e.Seq, e.UpdatedAt); err != nil {
			return fmt.Errorf("restore entry %s/%s: %w", e.OwnerID, e.EntryID, err)
		}
	}
	for _, m := range d.Media {
		if _, err := tx.Exec(ctx,
			`INSERT INTO media_blobs (owner_id, media_id, s3_key, bytes, chunks, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			m.OwnerID, m.MediaID, m.S3Key, m.Bytes, m.Chunks, m.CreatedAt); err != nil {
			return fmt.Errorf("restore media %s/%s: %w", m.OwnerID, m.MediaID, err)
		}
	}
	for _, r := range d.Reminders {
		if _, err := tx.Exec(ctx,
			`INSERT INTO reminders (owner_id, reminder_id, fire_at, dispatched) VALUES ($1, $2, $3, $4)`,
			r.OwnerID, r.ReminderID, r.FireAt, r.Dispatched); err != nil {
			return fmt.Errorf("restore reminder %s/%s: %w", r.OwnerID, r.ReminderID, err)
		}
	}
	for _, p := range d.PushSubs {
		if _, err := tx.Exec(ctx,
			`INSERT INTO push_subs (owner_id, device_id, kind, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4, $5, $6)`,
			p.OwnerID, p.DeviceID, p.Kind, p.Endpoint, p.P256dh, p.Auth); err != nil {
			return fmt.Errorf("restore push_sub %s/%s/%s: %w", p.OwnerID, p.DeviceID, p.Kind, err)
		}
	}
	for _, u := range d.Usage {
		if _, err := tx.Exec(ctx,
			`INSERT INTO usage_daily (day, metric, count) VALUES ($1::date, $2, $3)`,
			u.Day, u.Metric, u.Count); err != nil {
			return fmt.Errorf("restore usage %s/%s: %w", u.Day, u.Metric, err)
		}
	}

	// entry_seq is a standalone sequence (not column-owned), so TRUNCATE did not
	// reset it. Park it at the largest restored seq so the next push moves past the
	// whole replayed oplog rather than colliding with it.
	if _, err := tx.Exec(ctx,
		`SELECT setval('entry_seq', GREATEST((SELECT coalesce(max(seq), 0) FROM entry_blobs), 1))`); err != nil {
		return fmt.Errorf("restore entry_seq: %w", err)
	}
	return tx.Commit(ctx)
}

// scan runs a read-only query and feeds each row to fn.
func scan(ctx context.Context, s *Store, sql string, fn func(pgxRow) error) error {
	rows, err := s.pool.Query(ctx, sql)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := fn(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

// pgxRow is the subset of pgx.Rows the Dump scanners need.
type pgxRow interface {
	Scan(dest ...any) error
}
