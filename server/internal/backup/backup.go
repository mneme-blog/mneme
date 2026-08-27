// Package backup creates and restores operator backup archives for the relay.
//
// An archive is a single gzipped tar holding every vault's opaque ciphertext: the
// bookkeeping tables (as NDJSON) and the client-encrypted media chunks. It contains
// NO keys and NO plaintext — the relay never had any — so an archive is exactly as
// sensitive as the relay's own storage and weakens nothing about the E2EE model
// (CLAUDE.md §1, docs/SECURITY.md). It does aggregate all vaults into one file, so
// the operator must protect it the same way they protect the database and bucket.
//
// Layout:
//
//	manifest.json                  — format version, timestamp, schema version, counts
//	db/owners.ndjson               — one JSON row per line, base64 for bytea columns
//	db/devices.ndjson
//	db/entry_blobs.ndjson
//	db/media_blobs.ndjson
//	db/reminders.ndjson
//	db/push_subs.ndjson
//	db/usage_daily.ndjson
//	media/<owner_id>/<media_id>/<n> — raw client-encrypted chunk bytes
//
// Create streams the metadata into per-table buffers (small relative to media) and
// the media chunks straight through; Restore replays the metadata in one DB
// transaction and re-uploads the chunks to object storage.
package backup

import (
	"context"
	"strconv"
	"time"

	"github.com/mneme-blog/mneme/server/internal/store"
)

// Format is the archive layout version. Bump it on any incompatible change to the
// file layout or row schema; Restore refuses formats it does not understand.
const Format = 1

// File and directory names inside the archive.
const (
	manifestName = "manifest.json"
	dbDir        = "db/"
	mediaDir     = "media/"
)

// Source is the read side a Create needs: the live store dumps every table and the
// blob store yields each media chunk. *store.Store satisfies the table half.
type Source interface {
	SchemaVersion(ctx context.Context) (int, error)
	DumpOwners(ctx context.Context, fn func(store.OwnerRow) error) error
	DumpDevices(ctx context.Context, fn func(store.DeviceRow) error) error
	DumpEntries(ctx context.Context, fn func(store.EntryRow) error) error
	DumpMedia(ctx context.Context, fn func(store.MediaRow) error) error
	DumpReminders(ctx context.Context, fn func(store.ReminderRow) error) error
	DumpPushSubs(ctx context.Context, fn func(store.PushSubRow) error) error
	DumpUsage(ctx context.Context, fn func(store.UsageRow) error) error
}

// Sink is the write side a Restore needs. *store.Store satisfies it.
type Sink interface {
	SchemaVersion(ctx context.Context) (int, error)
	Restore(ctx context.Context, d *store.RestoreData) error
}

// Manifest is the archive's self-description, written first so a reader can
// validate compatibility before touching any data.
type Manifest struct {
	Format        int       `json:"format"`
	CreatedAt     time.Time `json:"created_at"`
	SchemaVersion int       `json:"schema_version"`
	IncludesMedia bool      `json:"includes_media"`
	MediaBytes    int64     `json:"media_bytes"` // sum of indexed media object sizes
	Counts        Counts    `json:"counts"`
}

// Counts is the per-table row tally, for a human-readable summary.
type Counts struct {
	Owners    int `json:"owners"`
	Devices   int `json:"devices"`
	Entries   int `json:"entries"`
	Media     int `json:"media"`
	Reminders int `json:"reminders"`
	PushSubs  int `json:"push_subs"`
	UsageDays int `json:"usage_days"`
}

// chunkArchivePath is where a media chunk lives inside the archive. It mirrors the
// object-store key exactly (s3_key is "media/<owner>/<media>"), so a restore can
// Put it back under the same key the relay reads from.
func chunkArchivePath(s3Key string, n int) string {
	return s3Key + "/" + strconv.Itoa(n)
}
