package deploy

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestValidTag(t *testing.T) {
	ok := []string{"v0.0.1", "v1.2.3", "v10.20.30", "v1.0.0-rc.1", "v1.0.0+build.5",
		"main-abc1234", "main-0123456789abcdef0123456789abcdef01234567"}
	for _, s := range ok {
		if !ValidTag(s) {
			t.Errorf("ValidTag(%q) = false, want true", s)
		}
	}
	// Everything the agent must never be handed: anything that could turn into a
	// different image reference, a flag, or a shell fragment.
	bad := []string{
		"", "latest", "main", "1.2.3", "v1.2", "v1.2.3.4",
		"ghcr.io/evil/img:v1.0.0",
		"v1.0.0 --privileged",
		"v1.0.0;rm -rf /",
		"v1.0.0@sha256:abc",
		"../../etc/passwd",
		"v1.0.0\nv2.0.0",
		// main builds: only the immutable per-commit form, lowercase hex, ≥7 chars.
		"main-", "main-abc123", "main-ABC1234", "main-abc1234;x", "main-xyzxyzx",
		"main-0123456789abcdef0123456789abcdef012345678", // 41 hex chars
	}
	for _, s := range bad {
		if ValidTag(s) {
			t.Errorf("ValidTag(%q) = true, want false", s)
		}
	}
}

func TestSubmitWritesRequest(t *testing.T) {
	dir := t.TempDir()
	s := NewSpool(dir)

	req := Request{ID: "abc", Action: ActionUpdate, Tag: "v0.3.0", RequestedAt: time.Now().UTC()}
	if err := s.Submit(req); err != nil {
		t.Fatalf("Submit: %v", err)
	}

	body, err := os.ReadFile(filepath.Join(dir, requestFile))
	if err != nil {
		t.Fatalf("request file: %v", err)
	}
	var got Request
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("request json: %v", err)
	}
	if got.Tag != "v0.3.0" || got.Action != ActionUpdate || got.ID != "abc" {
		t.Fatalf("round-trip mismatch: %+v", got)
	}

	// No partial file may survive a successful write.
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("expected exactly the request file, got %d entries", len(entries))
	}
}

func TestSubmitRejectsBadInput(t *testing.T) {
	s := NewSpool(t.TempDir())

	if err := s.Submit(Request{Action: ActionUpdate, Tag: "latest"}); err == nil {
		t.Fatal("expected a rejection for a non-tag")
	}
	if err := s.Submit(Request{Action: "delete-everything"}); err == nil {
		t.Fatal("expected a rejection for an unknown action")
	}
	// A rollback needs no tag: the target is the agent's business, not the relay's.
	if err := s.Submit(Request{Action: ActionRollback}); err != nil {
		t.Fatalf("rollback without a tag should be accepted: %v", err)
	}
}

func TestSubmitIsBusyWhileQueuedOrRunning(t *testing.T) {
	dir := t.TempDir()
	s := NewSpool(dir)

	if err := s.Submit(Request{Action: ActionUpdate, Tag: "v0.3.0"}); err != nil {
		t.Fatalf("first Submit: %v", err)
	}
	if err := s.Submit(Request{Action: ActionUpdate, Tag: "v0.3.1"}); !errors.Is(err, ErrBusy) {
		t.Fatalf("second Submit = %v, want ErrBusy", err)
	}

	// Agent picks the request up and starts working.
	if err := os.Remove(filepath.Join(dir, requestFile)); err != nil {
		t.Fatal(err)
	}
	writeState(t, dir, State{Phase: "pulling", Running: true})
	if err := s.Submit(Request{Action: ActionUpdate, Tag: "v0.3.1"}); !errors.Is(err, ErrBusy) {
		t.Fatalf("Submit during a run = %v, want ErrBusy", err)
	}

	// Once it finishes, the next request goes through.
	writeState(t, dir, State{Phase: PhaseDone, Running: false, Result: ResultSuccess})
	if err := s.Submit(Request{Action: ActionUpdate, Tag: "v0.3.1"}); err != nil {
		t.Fatalf("Submit after completion: %v", err)
	}
}

func TestDisabledSpool(t *testing.T) {
	s := NewSpool("")
	if s.Enabled() {
		t.Fatal("an empty dir must be disabled")
	}
	if err := s.Submit(Request{Action: ActionUpdate, Tag: "v1.0.0"}); !errors.Is(err, ErrDisabled) {
		t.Fatalf("Submit = %v, want ErrDisabled", err)
	}
	st := s.Status(10)
	if st.Enabled || st.State.Phase != PhaseIdle {
		t.Fatalf("disabled status = %+v", st)
	}
}

func TestStatusReportsQueuedAndRunning(t *testing.T) {
	dir := t.TempDir()
	s := NewSpool(dir)

	// Nothing has ever happened.
	if st := s.Status(10); st.State.Phase != PhaseIdle || st.Pending != nil {
		t.Fatalf("fresh spool status = %+v", st)
	}

	if err := s.Submit(Request{ID: "r1", Action: ActionUpdate, Tag: "v0.3.0"}); err != nil {
		t.Fatal(err)
	}
	st := s.Status(10)
	if st.State.Phase != PhaseQueued {
		t.Fatalf("phase = %q, want %q", st.State.Phase, PhaseQueued)
	}
	if st.Pending == nil || st.Pending.Tag != "v0.3.0" {
		t.Fatalf("pending = %+v", st.Pending)
	}

	// A running agent's own phase wins over "queued".
	writeState(t, dir, State{RequestID: "r1", Phase: "verifying", Running: true, To: "v0.3.0"})
	if st := s.Status(10); st.State.Phase != "verifying" {
		t.Fatalf("phase = %q, want the agent's own phase", st.State.Phase)
	}
}

func TestStatusSurvivesCorruptState(t *testing.T) {
	dir := t.TempDir()
	s := NewSpool(dir)
	if err := os.WriteFile(filepath.Join(dir, stateFile), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	st := s.Status(10)
	if st.Error == "" {
		t.Fatal("expected the read error to be surfaced")
	}
	if st.State.Phase != PhaseIdle {
		t.Fatalf("phase = %q, want a safe fallback", st.State.Phase)
	}
}

func TestTailLog(t *testing.T) {
	dir := t.TempDir()
	s := NewSpool(dir)

	var b strings.Builder
	for i := range 500 {
		b.WriteString("line ")
		b.WriteString(string(rune('a' + i%26)))
		b.WriteByte('\n')
	}
	if err := os.WriteFile(filepath.Join(dir, logFile), []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}

	lines := s.Status(20).Log
	if len(lines) != 20 {
		t.Fatalf("got %d lines, want 20", len(lines))
	}
	if lines[len(lines)-1] != "line "+string(rune('a'+499%26)) {
		t.Fatalf("last line = %q", lines[len(lines)-1])
	}
}

func writeState(t *testing.T, dir string, st State) {
	t.Helper()
	body, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, stateFile), body, 0o600); err != nil {
		t.Fatal(err)
	}
}
