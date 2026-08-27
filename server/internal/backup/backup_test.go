package backup

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/mneme-blog/mneme/server/internal/blobs"
	"github.com/mneme-blog/mneme/server/internal/store"
)

// fakeStore is an in-memory stand-in for *store.Store implementing both the Source
// and Sink interfaces, so the whole create→archive→restore loop runs without a DB.
type fakeStore struct {
	schema int
	data   store.RestoreData
}

func (f *fakeStore) SchemaVersion(context.Context) (int, error) { return f.schema, nil }

func (f *fakeStore) DumpOwners(_ context.Context, fn func(store.OwnerRow) error) error {
	return each(f.data.Owners, fn)
}
func (f *fakeStore) DumpDevices(_ context.Context, fn func(store.DeviceRow) error) error {
	return each(f.data.Devices, fn)
}
func (f *fakeStore) DumpEntries(_ context.Context, fn func(store.EntryRow) error) error {
	return each(f.data.Entries, fn)
}
func (f *fakeStore) DumpMedia(_ context.Context, fn func(store.MediaRow) error) error {
	return each(f.data.Media, fn)
}
func (f *fakeStore) DumpReminders(_ context.Context, fn func(store.ReminderRow) error) error {
	return each(f.data.Reminders, fn)
}
func (f *fakeStore) DumpPushSubs(_ context.Context, fn func(store.PushSubRow) error) error {
	return each(f.data.PushSubs, fn)
}
func (f *fakeStore) DumpUsage(_ context.Context, fn func(store.UsageRow) error) error {
	return each(f.data.Usage, fn)
}

func (f *fakeStore) Restore(_ context.Context, d *store.RestoreData) error {
	f.data = *d
	return nil
}

func each[T any](rows []T, fn func(T) error) error {
	for _, r := range rows {
		if err := fn(r); err != nil {
			return err
		}
	}
	return nil
}

func TestCreateRestoreRoundTrip(t *testing.T) {
	ctx := context.Background()
	ts := time.Date(2026, 6, 14, 9, 30, 0, 0, time.UTC)
	p256 := "p256dh-value"

	src := &fakeStore{
		schema: 2,
		data: store.RestoreData{
			Owners: []store.OwnerRow{
				// A rejected owner with a pinned signing key: the security columns
				// (status, approval hint, sign pubkey) must round-trip verbatim —
				// dropping them once resurrected rejected vaults as approved and
				// erased the device-binding pin (issue #40).
				{
					OwnerID: "owner-a", OwnerPub: []byte{1, 2, 3}, CreatedAt: ts,
					Status: "rejected", ApprovalHint: "amber-otter-07", OwnerSignPub: []byte{7, 8, 9},
				},
			},
			Devices: []store.DeviceRow{
				{DeviceID: "dev-1", OwnerID: "owner-a", DevicePub: []byte{4, 5, 6}, CreatedAt: ts},
			},
			Entries: []store.EntryRow{
				{OwnerID: "owner-a", EntryID: "e1", LWWClock: 7, Ciphertext: []byte{0x01, 0xff, 0x00, 0x7e}, Seq: 1, UpdatedAt: ts},
				{OwnerID: "owner-a", EntryID: "e2", LWWClock: 9, Ciphertext: []byte{0x01, 0xab}, Deleted: true, Seq: 2, UpdatedAt: ts},
			},
			Media: []store.MediaRow{
				{OwnerID: "owner-a", MediaID: "m1", S3Key: "media/owner-a/m1", Bytes: 6, Chunks: 2, CreatedAt: ts},
			},
			Reminders: []store.ReminderRow{{OwnerID: "owner-a", ReminderID: "r1", FireAt: ts}},
			PushSubs: []store.PushSubRow{
				{OwnerID: "owner-a", DeviceID: "dev-1", Kind: "webpush", Endpoint: "https://push", P256dh: &p256, Auth: nil},
			},
			Usage: []store.UsageRow{{Day: "2026-06-14", Metric: "requests", Count: 42}},
		},
	}

	// Two media chunks in object storage, keyed exactly as the relay would.
	srcBlobs := blobs.NewMemory()
	chunk0 := []byte("AAA")
	chunk1 := []byte("BBB")
	mustPut(t, srcBlobs, "media/owner-a/m1/0", chunk0)
	mustPut(t, srcBlobs, "media/owner-a/m1/1", chunk1)

	var archive bytes.Buffer
	man, err := Create(ctx, src, srcBlobs, &archive)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if man.Counts.Entries != 2 || man.Counts.Media != 1 || man.Counts.Owners != 1 {
		t.Fatalf("unexpected counts: %+v", man.Counts)
	}
	if !man.IncludesMedia || man.MediaBytes != 6 {
		t.Fatalf("media manifest wrong: includes=%v bytes=%d", man.IncludesMedia, man.MediaBytes)
	}

	// Restore into a fresh, empty store + empty object storage.
	dst := &fakeStore{schema: 2}
	dstBlobs := blobs.NewMemory()
	rman, err := Restore(ctx, dst, dstBlobs, &archive)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if !rman.CreatedAt.Equal(man.CreatedAt) {
		t.Fatalf("manifest created_at mismatch: %v vs %v", rman.CreatedAt, man.CreatedAt)
	}

	// Bookkeeping survived the round trip.
	if len(dst.data.Owners) != 1 || dst.data.Owners[0].OwnerID != "owner-a" {
		t.Fatalf("owners not restored: %+v", dst.data.Owners)
	}
	if !bytes.Equal(dst.data.Owners[0].OwnerPub, []byte{1, 2, 3}) {
		t.Fatalf("owner pubkey corrupted: %v", dst.data.Owners[0].OwnerPub)
	}
	if got := dst.data.Owners[0]; got.Status != "rejected" || got.ApprovalHint != "amber-otter-07" {
		t.Fatalf("owner approval state lost: status=%q hint=%q", got.Status, got.ApprovalHint)
	}
	if !bytes.Equal(dst.data.Owners[0].OwnerSignPub, []byte{7, 8, 9}) {
		t.Fatalf("owner sign pubkey lost: %v", dst.data.Owners[0].OwnerSignPub)
	}
	if len(dst.data.Entries) != 2 {
		t.Fatalf("want 2 entries, got %d", len(dst.data.Entries))
	}
	if !bytes.Equal(dst.data.Entries[0].Ciphertext, []byte{0x01, 0xff, 0x00, 0x7e}) {
		t.Fatalf("ciphertext corrupted: %v", dst.data.Entries[0].Ciphertext)
	}
	if !dst.data.Entries[1].Deleted {
		t.Fatalf("tombstone flag lost")
	}
	if !dst.data.Entries[0].UpdatedAt.Equal(ts) {
		t.Fatalf("timestamp lost: %v", dst.data.Entries[0].UpdatedAt)
	}
	if got := dst.data.PushSubs[0].P256dh; got == nil || *got != p256 {
		t.Fatalf("push sub p256dh lost: %v", got)
	}
	if dst.data.PushSubs[0].Auth != nil {
		t.Fatalf("nullable auth should stay nil, got %v", *dst.data.PushSubs[0].Auth)
	}
	if dst.data.Usage[0].Count != 42 {
		t.Fatalf("usage count lost: %d", dst.data.Usage[0].Count)
	}

	// Media chunks landed back under the original keys.
	for key, want := range map[string][]byte{"media/owner-a/m1/0": chunk0, "media/owner-a/m1/1": chunk1} {
		got, err := dstBlobs.Get(ctx, key)
		if err != nil {
			t.Fatalf("media chunk %s missing after restore: %v", key, err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("media chunk %s corrupted: %q want %q", key, got, want)
		}
	}
}

func TestRestoreRejectsNewerSchema(t *testing.T) {
	ctx := context.Background()
	src := &fakeStore{schema: 5, data: store.RestoreData{
		Owners: []store.OwnerRow{{OwnerID: "o", OwnerPub: []byte{1}, CreatedAt: time.Unix(0, 0).UTC()}},
	}}
	var archive bytes.Buffer
	if _, err := Create(ctx, src, blobs.NewMemory(), &archive); err != nil {
		t.Fatalf("Create: %v", err)
	}
	// Binary only knows schema 3 — an archive from schema 5 must be refused.
	dst := &fakeStore{schema: 3}
	if _, err := Restore(ctx, dst, blobs.NewMemory(), &archive); err == nil {
		t.Fatal("expected restore to reject a newer-schema archive")
	}
	if len(dst.data.Owners) != 0 {
		t.Fatal("rejected restore must not have mutated the store")
	}
}

func TestServiceNameValidation(t *testing.T) {
	svc := NewService(t.TempDir(), 3, nil, nil)
	bad := []string{
		"../etc/passwd",
		"mneme-backup-../x.tar.gz",
		"mneme-backup-20260614T093000Z.tar.gz/..",
		"random.tar.gz",
		"mneme-backup-20260614T093000Z.zip",
	}
	for _, name := range bad {
		if _, _, err := svc.Open(name); err == nil {
			t.Fatalf("Open(%q) should reject a non-archive name", name)
		}
	}
	if _, _, err := svc.Open("mneme-backup-20260614T093000Z.tar.gz"); err != ErrNotFound {
		t.Fatalf("a well-formed but absent name should be ErrNotFound, got %v", err)
	}
}

func mustPut(t *testing.T, b *blobs.Memory, key string, data []byte) {
	t.Helper()
	if err := b.Put(context.Background(), key, data); err != nil {
		t.Fatalf("seed blob %s: %v", key, err)
	}
}
