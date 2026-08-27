package backup

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"time"

	"github.com/mneme-blog/mneme/server/internal/blobs"
	"github.com/mneme-blog/mneme/server/internal/store"
)

// Create writes a backup archive to w. It first serialises each bookkeeping table
// into an in-memory NDJSON buffer (metadata is small next to media), then writes the
// manifest, the table buffers, and finally streams every media chunk straight from
// object storage into the archive. The returned Manifest summarises what was written.
//
// A media chunk that the index references but object storage no longer has is logged
// and skipped — the archive stays internally consistent (its media_blobs row simply
// points at fewer present chunks, exactly as the live relay would serve it).
func Create(ctx context.Context, src Source, bl blobs.Store, w io.Writer) (*Manifest, error) {
	man := &Manifest{Format: Format}

	schema, err := src.SchemaVersion(ctx)
	if err != nil {
		return nil, fmt.Errorf("read schema version: %w", err)
	}
	man.SchemaVersion = schema

	// 1. Serialise every table to a buffer, tallying counts. Media rows are also
	//    kept so their chunks can be streamed afterwards.
	ownersB, err := dumpTable(&man.Counts.Owners, func(emit func(store.OwnerRow) error) error {
		return src.DumpOwners(ctx, emit)
	})
	if err != nil {
		return nil, fmt.Errorf("dump owners: %w", err)
	}
	devicesB, err := dumpTable(&man.Counts.Devices, func(emit func(store.DeviceRow) error) error {
		return src.DumpDevices(ctx, emit)
	})
	if err != nil {
		return nil, fmt.Errorf("dump devices: %w", err)
	}
	entriesB, err := dumpTable(&man.Counts.Entries, func(emit func(store.EntryRow) error) error {
		return src.DumpEntries(ctx, emit)
	})
	if err != nil {
		return nil, fmt.Errorf("dump entries: %w", err)
	}

	var mediaRows []store.MediaRow
	mediaB, err := dumpTable(&man.Counts.Media, func(emit func(store.MediaRow) error) error {
		return src.DumpMedia(ctx, func(m store.MediaRow) error {
			mediaRows = append(mediaRows, m)
			man.MediaBytes += m.Bytes
			return emit(m)
		})
	})
	if err != nil {
		return nil, fmt.Errorf("dump media: %w", err)
	}
	man.IncludesMedia = len(mediaRows) > 0

	remindersB, err := dumpTable(&man.Counts.Reminders, func(emit func(store.ReminderRow) error) error {
		return src.DumpReminders(ctx, emit)
	})
	if err != nil {
		return nil, fmt.Errorf("dump reminders: %w", err)
	}
	pushB, err := dumpTable(&man.Counts.PushSubs, func(emit func(store.PushSubRow) error) error {
		return src.DumpPushSubs(ctx, emit)
	})
	if err != nil {
		return nil, fmt.Errorf("dump push_subs: %w", err)
	}
	usageB, err := dumpTable(&man.Counts.UsageDays, func(emit func(store.UsageRow) error) error {
		return src.DumpUsage(ctx, emit)
	})
	if err != nil {
		return nil, fmt.Errorf("dump usage: %w", err)
	}

	man.CreatedAt = time.Now().UTC()

	// 2. Write the archive: manifest first, then tables, then media chunks.
	gz := gzip.NewWriter(w)
	tw := tar.NewWriter(gz)

	manifestJSON, err := json.MarshalIndent(man, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := writeFile(tw, manifestName, manifestJSON, man.CreatedAt); err != nil {
		return nil, err
	}

	files := []struct {
		name string
		data []byte
	}{
		{dbDir + "owners.ndjson", ownersB},
		{dbDir + "devices.ndjson", devicesB},
		{dbDir + "entry_blobs.ndjson", entriesB},
		{dbDir + "media_blobs.ndjson", mediaB},
		{dbDir + "reminders.ndjson", remindersB},
		{dbDir + "push_subs.ndjson", pushB},
		{dbDir + "usage_daily.ndjson", usageB},
	}
	for _, f := range files {
		if err := writeFile(tw, f.name, f.data, man.CreatedAt); err != nil {
			return nil, err
		}
	}

	for _, m := range mediaRows {
		for n := 0; n < m.Chunks; n++ {
			key := chunkArchivePath(m.S3Key, n)
			data, err := bl.Get(ctx, key)
			if err != nil {
				if errors.Is(err, blobs.ErrNotFound) || errors.Is(err, blobs.ErrNotConfigured) {
					log.Printf("backup: media chunk %s unavailable (%v) — skipping", key, err)
					continue
				}
				return nil, fmt.Errorf("read media chunk %s: %w", key, err)
			}
			if err := writeFile(tw, key, data, man.CreatedAt); err != nil {
				return nil, err
			}
		}
	}

	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return man, nil
}

// dumpTable serialises a table to NDJSON (one JSON object per line), counting rows.
func dumpTable[T any](count *int, run func(emit func(T) error) error) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	err := run(func(row T) error {
		*count++
		return enc.Encode(row) // Encode appends a newline → NDJSON
	})
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// writeFile adds one regular file to the tar with restrictive permissions.
func writeFile(tw *tar.Writer, name string, data []byte, mod time.Time) error {
	if err := tw.WriteHeader(&tar.Header{
		Name:    name,
		Mode:    0o600,
		Size:    int64(len(data)),
		ModTime: mod,
	}); err != nil {
		return err
	}
	_, err := tw.Write(data)
	return err
}
