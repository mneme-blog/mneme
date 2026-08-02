// Package deploy is the relay's half of the one-click update mechanism.
//
// The relay cannot update itself. It is PID 1 in the container being replaced,
// so anything it starts dies halfway through the swap — and giving it the Docker
// socket would put root-equivalent host access behind an HTTP endpoint inside the
// very stack it is meant to protect (§1: the relay is deliberately the least
// privileged thing in the deployment).
//
// So it does not update anything. It writes a *request* into a spool directory
// shared with the host, and a small root-owned agent on the host (systemd path
// unit → deploy/updater/mneme-updater.sh) picks it up, drives docker compose,
// health-gates the result, and rolls back if the new version fails to come up.
// The agent writes its progress back as state.json + update.log, which is what
// the dashboard renders.
//
// The trust direction matters: the relay can only ever ask for one of two fixed
// actions against a validated version tag. It cannot name an image, a registry,
// a command, or a path. A fully compromised relay can request a downgrade to a
// published Mneme release or a CI-published main build — no more than that.
package deploy

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Filenames inside the spool directory. Also hard-coded in the host agent —
// changing one means changing both.
const (
	requestFile = "request.json"
	stateFile   = "state.json"
	logFile     = "update.log"
)

// Action is what the operator asked for.
type Action string

const (
	// ActionUpdate moves the stack to a specific published release or main build.
	ActionUpdate Action = "update"
	// ActionRollback returns to the version recorded as previously running.
	ActionRollback Action = "rollback"
)

// Phases reported by the agent. Anything not in this list is still displayed
// verbatim — the agent owns the vocabulary, this is documentation of it.
const (
	PhaseIdle    = "idle"
	PhaseQueued  = "queued"
	PhaseDone    = "done"
	PhaseFailed  = "failed"
	PhaseRolling = "rolling-back"
)

// Results the agent records when a run finishes.
const (
	ResultSuccess    = "success"     // the requested version is up and healthy
	ResultRolledBack = "rolled_back" // it failed to come up; the previous version was restored
	ResultFailed     = "failed"      // it failed AND the rollback failed — needs an operator
)

// ErrBusy is returned when a run is already in flight or queued.
var ErrBusy = errors.New("an update is already in progress")

// ErrDisabled is returned when UPDATE_SPOOL_DIR is unset — one-click updates are
// opt-in, and the default deployment has no updater installed.
var ErrDisabled = errors.New("one-click updates are not enabled on this relay")

// tagPattern constrains what may be requested. The agent composes an image
// reference from this, so it is the boundary between "a version" and "arbitrary
// text that ends up on a docker command line": strict vMAJOR.MINOR.PATCH with an
// optional prerelease/build suffix, or a per-commit main build (main-<sha> as
// published by CI for every commit that passes on main), nothing else. No
// slashes, no colons, no @. Deliberately NOT the bare moving tag "main": the
// updater pins by tag and records "previous" for rollback, both of which need
// tags that keep meaning the same image.
var tagPattern = regexp.MustCompile(`^(?:v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?|main-[0-9a-f]{7,40})$`)

// ValidTag reports whether s is a release or main-build tag the updater will accept.
func ValidTag(s string) bool { return tagPattern.MatchString(s) }

// Request is what the relay writes and the agent consumes.
type Request struct {
	ID     string `json:"id"`
	Action Action `json:"action"`
	// Tag is the release to move to. Required for ActionUpdate; ignored for
	// ActionRollback, where the target comes from the agent's own record of what
	// was running before (the relay must not get to name it — after a bad update
	// the relay is the thing that is broken).
	Tag string `json:"tag,omitempty"`
	// Deep requests the destructive rollback: rebuild the database at the old
	// schema and replay the pre-update backup archive. Needed only when a
	// migration was declared breaking (see migrations/manifest.go). Ignored for
	// ActionUpdate.
	Deep        bool      `json:"deep,omitempty"`
	RequestedAt time.Time `json:"requested_at"`
}

// State is what the agent writes and the dashboard reads.
type State struct {
	RequestID  string     `json:"request_id,omitempty"`
	Action     Action     `json:"action,omitempty"`
	Phase      string     `json:"phase"`
	Running    bool       `json:"running"`
	From       string     `json:"from,omitempty"`
	To         string     `json:"to,omitempty"`
	StartedAt  *time.Time `json:"started_at,omitempty"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
	Result     string     `json:"result,omitempty"`
	Error      string     `json:"error,omitempty"`
	// BackupArchive is the archive taken immediately before the change. It is the
	// deep-rollback input, and the reason an update is never a one-way door.
	BackupArchive string `json:"backup_archive,omitempty"`
	// Installed is the version the agent believes is running, and Previous the one
	// before it. Both come from the agent's own state, not from this binary's
	// compiled-in version, so they stay meaningful even when the relay is down.
	Installed string `json:"installed,omitempty"`
	Previous  string `json:"previous,omitempty"`
	// PreviousSchema is the schema head the previous release migrates to, recorded
	// at update time. Compared against this build's MinSafeSchema to decide whether
	// a rollback is an image swap or needs the archive.
	PreviousSchema int `json:"previous_schema,omitempty"`
}

// Status is the full picture handed to the dashboard.
type Status struct {
	Enabled bool     `json:"enabled"`
	State   State    `json:"state"`
	Pending *Request `json:"pending,omitempty"`
	Log     []string `json:"log,omitempty"`
	// Error reports a problem reading the spool itself (agent not installed, the
	// directory not shared correctly). Distinct from State.Error, which is the
	// agent reporting a failed run.
	Error string `json:"error,omitempty"`
}

// Spool is the shared directory. The zero value is disabled.
type Spool struct {
	dir string
	mu  sync.Mutex
}

// NewSpool returns a Spool rooted at dir. An empty dir yields a disabled Spool
// whose Submit always returns ErrDisabled.
func NewSpool(dir string) *Spool { return &Spool{dir: strings.TrimSpace(dir)} }

// Enabled reports whether one-click updates are configured. Nil-safe: a Server
// assembled without a spool behaves exactly like one where the feature is off.
func (s *Spool) Enabled() bool { return s != nil && s.dir != "" }

// Submit queues a request for the host agent. It refuses while a run is in
// flight, so a double-click cannot start two updates against one stack.
func (s *Spool) Submit(req Request) error {
	if !s.Enabled() {
		return ErrDisabled
	}
	if req.Action != ActionUpdate && req.Action != ActionRollback {
		return fmt.Errorf("unknown action %q", req.Action)
	}
	if req.Action == ActionUpdate && !ValidTag(req.Tag) {
		return fmt.Errorf("%q is not a release or main-build tag", req.Tag)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// Reject if the agent is mid-run, or if a request is already waiting to be
	// picked up. Checked under the lock and immediately before the write, which
	// closes the window between two concurrent admin clicks; the agent additionally
	// takes a flock, because this process is not the only possible writer (the
	// operator can drop a request in by hand).
	if st, err := s.readState(); err == nil && st.Running {
		return ErrBusy
	}
	if _, err := os.Stat(filepath.Join(s.dir, requestFile)); err == nil {
		return ErrBusy
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("spool not readable: %w", err)
	}

	body, err := json.MarshalIndent(req, "", "  ")
	if err != nil {
		return err
	}
	// Write-then-rename: the agent is woken by the file existing, so it must never
	// observe a half-written one.
	tmp := filepath.Join(s.dir, "."+requestFile+".partial")
	if err := os.WriteFile(tmp, append(body, '\n'), 0o600); err != nil {
		return fmt.Errorf("write request: %w", err)
	}
	if err := os.Rename(tmp, filepath.Join(s.dir, requestFile)); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("queue request: %w", err)
	}
	return nil
}

// Status reads back whatever the agent has recorded. Missing files are not an
// error: they mean the agent has simply never run.
func (s *Spool) Status(logLines int) Status {
	out := Status{Enabled: s.Enabled()}
	if !s.Enabled() {
		out.State.Phase = PhaseIdle
		return out
	}

	st, err := s.readState()
	if err != nil {
		out.Error = err.Error()
		out.State.Phase = PhaseIdle
		return out
	}
	out.State = st
	if out.State.Phase == "" {
		out.State.Phase = PhaseIdle
	}

	if req, err := s.readRequest(); err == nil && req != nil {
		out.Pending = req
		if !out.State.Running {
			out.State.Phase = PhaseQueued
		}
	}
	out.Log = s.tailLog(logLines)
	return out
}

func (s *Spool) readState() (State, error) {
	var st State
	body, err := os.ReadFile(filepath.Join(s.dir, stateFile))
	if errors.Is(err, os.ErrNotExist) {
		return State{Phase: PhaseIdle}, nil
	}
	if err != nil {
		return st, fmt.Errorf("read update state: %w", err)
	}
	if err := json.Unmarshal(body, &st); err != nil {
		return State{Phase: PhaseIdle}, fmt.Errorf("update state is not readable JSON: %w", err)
	}
	return st, nil
}

func (s *Spool) readRequest() (*Request, error) {
	body, err := os.ReadFile(filepath.Join(s.dir, requestFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var req Request
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, err
	}
	return &req, nil
}

// tailLog returns the last n lines of the agent's log. Bounded read: the log is
// rotated by the agent, but a runaway one must not be able to blow up the relay's
// memory just because someone opened the dashboard.
func (s *Spool) tailLog(n int) []string {
	if n <= 0 {
		return nil
	}
	const maxBytes = 256 << 10
	path := filepath.Join(s.dir, logFile)
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return nil
	}
	offset := int64(0)
	if info.Size() > maxBytes {
		offset = info.Size() - maxBytes
	}
	buf := make([]byte, min(info.Size()-offset, int64(maxBytes)))
	if _, err := f.ReadAt(buf, offset); err != nil && len(buf) > 0 {
		return nil
	}

	lines := strings.Split(strings.TrimRight(string(buf), "\n"), "\n")
	if offset > 0 && len(lines) > 0 {
		lines = lines[1:] // the first line was cut mid-way by the offset
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines
}
