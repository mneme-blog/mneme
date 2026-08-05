package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"

	"github.com/plasticparticle/mneme/server/internal/blobs"
	"github.com/plasticparticle/mneme/server/internal/store"
)

// Bounds on what a single archive member may claim. Restore is the one place the
// relay parses a file it did not just write — reachable from
// POST /admin/backups/{name}/restore and from `journald restore`, i.e. from any
// archive an operator was persuaded to put in BACKUP_DIR. Without a bound, one
// member declaring gigabytes is read straight into memory (gzip makes that cheap
// to author), and disaster recovery is exactly when a corrupt or hostile archive
// is plausible. tar.Reader never returns more than the declared size, so
// checking the header is a complete check.
const (
	// A chunk is one client-encrypted ~1 MiB block; the relay refuses to store a
	// larger one (api.maxChunkBytes), so it can never legitimately restore one.
	maxRestoreChunkBytes = 2 << 20
	// The bookkeeping tables are NDJSON and are decoded into memory whole. Sized
	// so a genuinely large vault still restores: entry_blobs.ndjson is the big
	// one, at roughly the vault's ciphertext size plus base64 overhead.
	maxRestoreTableBytes = 2 << 30
)

// chunkKeyRe is the exact shape Create writes: media/{owner_id}/{media_id}/{n},
// with both ids in the base64url/hex alphabet the relay derives them from.
var chunkKeyRe = regexp.MustCompile(`^media/[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128}/[0-9]{1,6}$`)

// Restore replays an archive built by Create: it re-uploads every media chunk to
// object storage and replaces ALL relay bookkeeping data in one transaction (see
// store.Restore). It is the destructive half of disaster recovery — the caller must
// have already confirmed intent. The returned Manifest describes what was applied.
//
// Restore refuses an archive whose schema version is newer than this binary's (the
// rows could reference columns that do not exist yet) — upgrade journald first. An
// archive from an older or equal schema is fine: the DB is migrated to head before
// restore, and the replayed rows only ever populate columns that already existed.
func Restore(ctx context.Context, sink Sink, bl blobs.Store, r io.Reader) (*Manifest, error) {
	current, err := sink.SchemaVersion(ctx)
	if err != nil {
		return nil, fmt.Errorf("read schema version: %w", err)
	}

	gz, err := gzip.NewReader(r)
	if err != nil {
		return nil, fmt.Errorf("open gzip: %w", err)
	}
	defer gz.Close() //nolint:errcheck // read-only stream

	tr := tar.NewReader(gz)
	var man *Manifest
	data := &store.RestoreData{}

	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read archive: %w", err)
		}

		// Bound before reading anything: a member is only ever a small JSON
		// document, an NDJSON table, or one media chunk.
		limit := int64(maxRestoreTableBytes)
		if strings.HasPrefix(hdr.Name, mediaDir) {
			limit = maxRestoreChunkBytes
		}
		if hdr.Size > limit {
			return nil, fmt.Errorf("archive member %s is %d bytes, above the %d-byte limit — refusing to read it", hdr.Name, hdr.Size, limit)
		}

		switch {
		case hdr.Name == manifestName:
			man = &Manifest{}
			if err := json.NewDecoder(tr).Decode(man); err != nil {
				return nil, fmt.Errorf("decode manifest: %w", err)
			}
			if man.Format != Format {
				return nil, fmt.Errorf("unsupported archive format %d (this binary writes %d)", man.Format, Format)
			}
			if man.SchemaVersion > current {
				return nil, fmt.Errorf("archive schema v%d is newer than this binary (schema v%d) — upgrade journald before restoring", man.SchemaVersion, current)
			}

		case hdr.Name == dbDir+"owners.ndjson":
			err = decodeNDJSON(tr, &data.Owners)
		case hdr.Name == dbDir+"devices.ndjson":
			err = decodeNDJSON(tr, &data.Devices)
		case hdr.Name == dbDir+"entry_blobs.ndjson":
			err = decodeNDJSON(tr, &data.Entries)
		case hdr.Name == dbDir+"media_blobs.ndjson":
			err = decodeNDJSON(tr, &data.Media)
		case hdr.Name == dbDir+"reminders.ndjson":
			err = decodeNDJSON(tr, &data.Reminders)
		case hdr.Name == dbDir+"push_subs.ndjson":
			err = decodeNDJSON(tr, &data.PushSubs)
		case hdr.Name == dbDir+"usage_daily.ndjson":
			err = decodeNDJSON(tr, &data.Usage)

		case strings.HasPrefix(hdr.Name, mediaDir):
			// The manifest is always first in the archive, so it is validated by now.
			if man == nil {
				return nil, errors.New("archive media precedes its manifest (corrupt archive)")
			}
			// The member name becomes the object key verbatim. Nothing but a
			// chunk path may be written, so a crafted archive cannot place an
			// object outside the media namespace (or traverse, for a blob store
			// that maps keys onto a filesystem).
			if !chunkKeyRe.MatchString(hdr.Name) {
				return nil, fmt.Errorf("archive member %s is not a media chunk path", hdr.Name)
			}
			chunk, rerr := io.ReadAll(tr)
			if rerr != nil {
				return nil, fmt.Errorf("read media chunk %s: %w", hdr.Name, rerr)
			}
			if perr := bl.Put(ctx, hdr.Name, chunk); perr != nil {
				if errors.Is(perr, blobs.ErrNotConfigured) {
					return nil, fmt.Errorf("archive contains media but object storage is not configured (set S3_ENDPOINT to restore %s)", hdr.Name)
				}
				return nil, fmt.Errorf("restore media chunk %s: %w", hdr.Name, perr)
			}

		default:
			// Unknown member — ignore for forward compatibility within a format.
		}
		if err != nil {
			return nil, fmt.Errorf("decode %s: %w", hdr.Name, err)
		}
	}

	if man == nil {
		return nil, errors.New("archive is missing its manifest")
	}
	if err := sink.Restore(ctx, data); err != nil {
		return nil, fmt.Errorf("apply restore: %w", err)
	}
	return man, nil
}

// decodeNDJSON reads newline-delimited JSON objects from one archive member into out.
func decodeNDJSON[T any](r io.Reader, out *[]T) error {
	dec := json.NewDecoder(r)
	for {
		var row T
		if err := dec.Decode(&row); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		*out = append(*out, row)
	}
}
