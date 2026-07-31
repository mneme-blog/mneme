//go:build e2e

// Exercises the backup/restore round trip against a real Postgres, so the actual
// SQL (TRUNCATE … CASCADE, entry_seq realignment, timestamptz/bytea round-trips)
// is covered — the unit test in internal/backup fakes the store.
//
//	docker compose up -d postgres
//	TEST_DATABASE_URL=postgres://journal:journal_dev@localhost:5432/journal?sslmode=disable \
//	  go test -tags e2e ./e2e/...
package e2e

import (
	"bytes"
	"context"
	"crypto/rand"
	"os"
	"testing"
	"time"

	"github.com/plasticparticle/mneme/server/internal/backup"
	"github.com/plasticparticle/mneme/server/internal/blobs"
	"github.com/plasticparticle/mneme/server/internal/store"
)

func TestBackupRestoreRoundTrip(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run e2e")
	}
	ctx := context.Background()

	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// Start from a clean slate so assertions are exact (restore truncates anyway,
	// but seeding should not collide with leftovers from other e2e tests).
	if err := st.Restore(ctx, &store.RestoreData{}); err != nil {
		t.Fatalf("reset: %v", err)
	}

	owner := "owner-bk-" + randHex(t, 6)
	device := "dev-bk-" + randHex(t, 6)
	ownerPub := randBytes(t, 32)
	devicePub := randBytes(t, 32)
	if _, err := st.RegisterOwnerDevice(ctx, owner, ownerPub, device, devicePub, store.OwnerStatusApproved, "", randBytes(t, 32)); err != nil {
		t.Fatalf("register: %v", err)
	}

	// Two entries (one tombstoned), a media object with two chunks, a reminder.
	ct1 := append([]byte{0x01}, randBytes(t, 40)...)
	ct2 := append([]byte{0x01}, randBytes(t, 12)...)
	if _, _, err := st.PushEntry(ctx, owner, store.EntryBlob{EntryID: "e1", LWWClock: 1, Ciphertext: ct1}); err != nil {
		t.Fatalf("push e1: %v", err)
	}
	if _, _, err := st.PushEntry(ctx, owner, store.EntryBlob{EntryID: "e2", LWWClock: 1, Ciphertext: ct2, Deleted: true}); err != nil {
		t.Fatalf("push e2: %v", err)
	}
	if _, err := st.FinalizeMedia(ctx, owner, store.MediaBlob{
		MediaID: "m1", S3Key: "media/" + owner + "/m1", Bytes: 6, Chunks: 2,
	}); err != nil {
		t.Fatalf("finalize media: %v", err)
	}
	fireAt := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	if err := st.UpsertReminder(ctx, owner, "r1", fireAt); err != nil {
		t.Fatalf("reminder: %v", err)
	}

	bl := blobs.NewMemory()
	chunk0, chunk1 := []byte("AAA"), []byte("BBB")
	_ = bl.Put(ctx, "media/"+owner+"/m1/0", chunk0)
	_ = bl.Put(ctx, "media/"+owner+"/m1/1", chunk1)

	// Back up.
	var archive bytes.Buffer
	man, err := backup.Create(ctx, st, bl, &archive)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if man.Counts.Owners != 1 || man.Counts.Entries != 2 || man.Counts.Media != 1 || man.Counts.Reminders != 1 {
		t.Fatalf("unexpected manifest counts: %+v", man.Counts)
	}

	// Mutate the live state so the restore has something to overwrite, including a
	// brand-new vault that must vanish after the restore (TRUNCATE CASCADE).
	other := "owner-bk-" + randHex(t, 6)
	if _, err := st.RegisterOwnerDevice(ctx, other, randBytes(t, 32), "dev-"+randHex(t, 6), randBytes(t, 32), store.OwnerStatusApproved, "", randBytes(t, 32)); err != nil {
		t.Fatalf("register other: %v", err)
	}
	if _, _, err := st.PushEntry(ctx, owner, store.EntryBlob{EntryID: "e3", LWWClock: 5, Ciphertext: []byte{0x01, 0x02}}); err != nil {
		t.Fatalf("push e3: %v", err)
	}

	// Restore.
	restoreBlobs := blobs.NewMemory()
	if _, err := backup.Restore(ctx, st, restoreBlobs, &archive); err != nil {
		t.Fatalf("restore: %v", err)
	}

	// The mutating vault is gone; the original vault is back to its backed-up state.
	vaults, err := st.ListVaultStats(ctx)
	if err != nil {
		t.Fatalf("list vaults: %v", err)
	}
	if len(vaults) != 1 || vaults[0].OwnerID != owner {
		t.Fatalf("want only %s after restore, got %+v", owner, vaults)
	}

	entries, err := st.PullEntries(ctx, owner, 0, 100)
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("want 2 entries (e3 should be gone), got %d", len(entries))
	}
	byID := map[string]store.EntryBlob{}
	for _, e := range entries {
		byID[e.EntryID] = e
	}
	if _, ok := byID["e3"]; ok {
		t.Fatal("e3 (post-backup write) survived the restore")
	}
	if !bytes.Equal(byID["e1"].Ciphertext, ct1) {
		t.Fatal("e1 ciphertext corrupted across round trip")
	}
	if !byID["e2"].Deleted {
		t.Fatal("e2 tombstone flag lost")
	}

	// A fresh push after restore must get a seq beyond the replayed cursor.
	maxSeq := int64(0)
	for _, e := range entries {
		if e.Seq > maxSeq {
			maxSeq = e.Seq
		}
	}
	if _, _, err := st.PushEntry(ctx, owner, store.EntryBlob{EntryID: "e4", LWWClock: 1, Ciphertext: []byte{0x01, 0x09}}); err != nil {
		t.Fatalf("push after restore: %v", err)
	}
	after, _ := st.PullEntries(ctx, owner, maxSeq, 100)
	if len(after) != 1 || after[0].EntryID != "e4" {
		t.Fatalf("entry_seq cursor not realigned: pull after restore returned %+v", after)
	}

	// Media index + reminder survived; chunks were re-uploaded to object storage.
	if m, err := st.GetMedia(ctx, owner, "m1"); err != nil || m.Chunks != 2 {
		t.Fatalf("media index lost: %+v err=%v", m, err)
	}
	if got, err := restoreBlobs.Get(ctx, "media/"+owner+"/m1/1"); err != nil || !bytes.Equal(got, chunk1) {
		t.Fatalf("media chunk not restored: %q err=%v", got, err)
	}
	rems, err := st.ListReminders(ctx, owner)
	if err != nil || len(rems) != 1 || !rems[0].FireAt.Equal(fireAt) {
		t.Fatalf("reminder lost: %+v err=%v", rems, err)
	}
}

func randHex(t *testing.T, n int) string {
	t.Helper()
	const hex = "0123456789abcdef"
	b := randBytes(t, n)
	out := make([]byte, n)
	for i, v := range b {
		out[i] = hex[v&0x0f]
	}
	return string(out)
}

func randBytes(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}
