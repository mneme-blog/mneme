package backup

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/mneme-blog/mneme/server/internal/blobs"
	"github.com/mneme-blog/mneme/server/internal/store"
)

// filePrefix/fileSuffix bracket an archive name; the timestamp between them is the
// archive's UTC creation instant, so a lexical sort is also a chronological one.
const (
	filePrefix = "mneme-backup-"
	fileSuffix = ".tar.gz"
	tsLayout   = "20060102T150405Z"
)

// nameRe matches exactly the archive names this package produces. It is the only
// gate between an admin-supplied name and the filesystem, so it must reject path
// separators, "..", and anything else that is not a literal archive filename.
var nameRe = regexp.MustCompile(`^mneme-backup-\d{8}T\d{6}Z\.tar\.gz$`)

var (
	// ErrDisabled is returned by server-side operations when BACKUP_DIR is unset.
	ErrDisabled = errors.New("backups disabled (BACKUP_DIR not set)")
	// ErrBusy is returned when a backup is already running.
	ErrBusy = errors.New("a backup is already in progress")
	// ErrBadName is returned for an archive name that is not a well-formed archive.
	ErrBadName = errors.New("invalid backup name")
	// ErrNotFound is returned when a named archive does not exist.
	ErrNotFound = errors.New("backup not found")
)

// Service manages the on-disk archive directory: it runs scheduled and on-demand
// backups (never two at once), prunes by retention, and lists/serves/deletes the
// stored archives. A Service with an empty Dir is disabled — every operation that
// would touch the directory returns ErrDisabled.
type Service struct {
	dir   string
	keep  int
	store *store.Store
	blobs blobs.Store

	mu       sync.Mutex
	running  bool
	lastName string
	lastAt   time.Time
	lastErr  string
}

// NewService builds a Service. dir == "" yields a disabled Service.
func NewService(dir string, keep int, st *store.Store, bl blobs.Store) *Service {
	return &Service{dir: dir, keep: keep, store: st, blobs: bl}
}

// Enabled reports whether a backup directory is configured.
func (s *Service) Enabled() bool { return s.dir != "" }

// Record describes one stored archive.
type Record struct {
	Name      string    `json:"name"`
	Bytes     int64     `json:"bytes"`
	CreatedAt time.Time `json:"created_at"`
}

// Status is the service's current state for the admin dashboard.
type Status struct {
	Enabled    bool      `json:"enabled"`
	Dir        string    `json:"dir"`
	Keep       int       `json:"keep"`
	Running    bool      `json:"running"`
	LastName   string    `json:"last_name,omitempty"`
	LastAt     time.Time `json:"last_at,omitempty"`
	LastError  string    `json:"last_error,omitempty"`
	Backups    []Record  `json:"backups"`
	TotalBytes int64     `json:"total_bytes"`
}

// Status returns the current service state plus the listing of stored archives.
func (s *Service) Status() (Status, error) {
	s.mu.Lock()
	st := Status{
		Enabled:   s.Enabled(),
		Dir:       s.dir,
		Keep:      s.keep,
		Running:   s.running,
		LastName:  s.lastName,
		LastAt:    s.lastAt,
		LastError: s.lastErr,
	}
	s.mu.Unlock()
	if !s.Enabled() {
		return st, nil
	}
	recs, err := s.List()
	if err != nil {
		return st, err
	}
	st.Backups = recs
	for _, r := range recs {
		st.TotalBytes += r.Bytes
	}
	return st, nil
}

// RunNow writes a fresh archive to the directory, then prunes to the retention
// limit. It is mutually exclusive with the scheduled worker and other RunNow calls
// (ErrBusy if one is already running). The archive is written to a ".partial" file
// and atomically renamed on success, so a crash mid-write never leaves a truncated
// archive that looks complete.
func (s *Service) RunNow(ctx context.Context) (Record, error) {
	if !s.Enabled() {
		return Record{}, ErrDisabled
	}
	if !s.acquire() {
		return Record{}, ErrBusy
	}
	defer s.release()

	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return s.fail(fmt.Errorf("create backup dir: %w", err))
	}

	created := time.Now().UTC()
	name := filePrefix + created.Format(tsLayout) + fileSuffix
	final := filepath.Join(s.dir, name)
	tmp := final + ".partial"

	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return s.fail(fmt.Errorf("create archive: %w", err))
	}
	man, werr := Create(ctx, s.store, s.blobs, f)
	cerr := f.Close()
	if werr != nil || cerr != nil {
		_ = os.Remove(tmp)
		if werr != nil {
			return s.fail(fmt.Errorf("write archive: %w", werr))
		}
		return s.fail(fmt.Errorf("flush archive: %w", cerr))
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Remove(tmp)
		return s.fail(fmt.Errorf("finalize archive: %w", err))
	}

	fi, err := os.Stat(final)
	if err != nil {
		return s.fail(fmt.Errorf("stat archive: %w", err))
	}

	s.mu.Lock()
	s.lastName = name
	s.lastAt = man.CreatedAt
	s.lastErr = ""
	s.mu.Unlock()

	if err := s.prune(); err != nil {
		log.Printf("backup: prune failed: %v", err)
	}
	return Record{Name: name, Bytes: fi.Size(), CreatedAt: man.CreatedAt}, nil
}

// Run drives scheduled backups until ctx is cancelled. It is a no-op for a disabled
// service. The interval is floored at a minute to avoid a hot loop on misconfig.
func (s *Service) Run(ctx context.Context, interval time.Duration) {
	if !s.Enabled() {
		return
	}
	if interval < time.Minute {
		interval = time.Minute
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	log.Printf("backup: scheduled every %s into %s (keep %d)", interval, s.dir, s.keep)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			rec, err := s.RunNow(ctx)
			if err != nil {
				if errors.Is(err, ErrBusy) {
					continue
				}
				log.Printf("backup: scheduled run failed: %v", err)
				continue
			}
			log.Printf("backup: wrote %s (%d bytes)", rec.Name, rec.Bytes)
		}
	}
}

// List returns the stored archives, newest first.
func (s *Service) List() ([]Record, error) {
	if !s.Enabled() {
		return nil, ErrDisabled
	}
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil // not created yet — no backups, not an error
		}
		return nil, err
	}
	var recs []Record
	for _, e := range entries {
		if e.IsDir() || !nameRe.MatchString(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		recs = append(recs, Record{Name: e.Name(), Bytes: info.Size(), CreatedAt: parseStamp(e.Name())})
	}
	sort.Slice(recs, func(i, j int) bool { return recs[i].Name > recs[j].Name })
	return recs, nil
}

// Open returns a read handle to a stored archive (the caller closes it) plus its
// size, for streaming a download. The name is validated against nameRe first.
func (s *Service) Open(name string) (io.ReadCloser, int64, error) {
	p, err := s.path(name)
	if err != nil {
		return nil, 0, err
	}
	f, err := os.Open(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, 0, ErrNotFound
		}
		return nil, 0, err
	}
	fi, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, 0, err
	}
	return f, fi.Size(), nil
}

// RestoreFrom replays a stored archive into the relay (destructive — see Restore).
func (s *Service) RestoreFrom(ctx context.Context, name string) (*Manifest, error) {
	p, err := s.path(name)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	defer f.Close() //nolint:errcheck // read-only stream
	return Restore(ctx, s.store, s.blobs, f)
}

// Delete removes one stored archive.
func (s *Service) Delete(name string) error {
	p, err := s.path(name)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ErrNotFound
		}
		return err
	}
	return nil
}

// prune keeps the s.keep newest archives and removes the rest. keep <= 0 keeps all.
func (s *Service) prune() error {
	if s.keep <= 0 {
		return nil
	}
	recs, err := s.List()
	if err != nil {
		return err
	}
	for _, r := range recs[min(len(recs), s.keep):] {
		if err := os.Remove(filepath.Join(s.dir, r.Name)); err != nil {
			return err
		}
		log.Printf("backup: pruned %s (retention %d)", r.Name, s.keep)
	}
	return nil
}

// path validates name and joins it onto the backup dir. The regex is the security
// boundary: it permits only literal archive filenames, so the join cannot escape.
func (s *Service) path(name string) (string, error) {
	if !s.Enabled() {
		return "", ErrDisabled
	}
	if !nameRe.MatchString(name) {
		return "", ErrBadName
	}
	return filepath.Join(s.dir, name), nil
}

func (s *Service) acquire() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		return false
	}
	s.running = true
	return true
}

func (s *Service) release() {
	s.mu.Lock()
	s.running = false
	s.mu.Unlock()
}

// fail records an error against the service status and returns it.
func (s *Service) fail(err error) (Record, error) {
	s.mu.Lock()
	s.lastErr = err.Error()
	s.mu.Unlock()
	return Record{}, err
}

// parseStamp recovers an archive's creation time from its name; a parse failure
// (should not happen for nameRe-matching names) falls back to the zero time.
func parseStamp(name string) time.Time {
	stamp := name[len(filePrefix) : len(name)-len(fileSuffix)]
	t, err := time.Parse(tsLayout, stamp)
	if err != nil {
		return time.Time{}
	}
	return t
}
