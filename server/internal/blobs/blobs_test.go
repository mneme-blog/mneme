package blobs

import (
	"context"
	"testing"
)

// DeletePrefix is what makes "delete my vault" true for chunks that were
// uploaded but never finalized (audit finding M2, issue #43): those have no
// media_blobs index row, so index-driven cleanup could never reach them.
func TestDeletePrefixSweepsUnindexedChunks(t *testing.T) {
	ctx := context.Background()
	s := NewMemory()

	keys := []string{
		"media/owner-a/finalized/0",
		"media/owner-a/finalized/1",
		"media/owner-a/never-completed/0", // no index row would exist for this
		"media/owner-b/theirs/0",
		// An owner id that merely starts with the same bytes must not be caught
		// by the sweep — hence the trailing slash in api.ownerMediaPrefix.
		"media/owner-a-2/theirs/0",
	}
	for _, k := range keys {
		if err := s.Put(ctx, k, []byte{0x01}); err != nil {
			t.Fatal(err)
		}
	}

	n, err := s.DeletePrefix(ctx, "media/owner-a/")
	if err != nil {
		t.Fatalf("DeletePrefix: %v", err)
	}
	if n != 3 {
		t.Fatalf("removed %d objects, want 3", n)
	}

	got := s.Keys()
	want := []string{"media/owner-a-2/theirs/0", "media/owner-b/theirs/0"}
	if len(got) != len(want) {
		t.Fatalf("remaining keys = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("remaining keys = %v, want %v", got, want)
		}
	}
}

func TestDeletePrefixOnEmptyStore(t *testing.T) {
	n, err := NewMemory().DeletePrefix(context.Background(), "media/nobody/")
	if err != nil || n != 0 {
		t.Fatalf("DeletePrefix on empty store = (%d, %v), want (0, nil)", n, err)
	}
}
