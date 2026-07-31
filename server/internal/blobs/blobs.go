// Package blobs is the seam for media object storage (S3-compatible: MinIO/Garage).
// Media arrives client-encrypted and chunked; the relay never inspects it — every
// value here is an opaque ciphertext chunk keyed by an owner-scoped path.
//
// §12's "relayed vs. presigned" question is resolved as server-relayed for now:
// chunks stream through the relay's existing authenticated origin, so the object
// store never needs to be reachable (or CORS-configured) for clients. At the §7
// scale this is trivial I/O; a presigned impl can still slot in behind Store later.
package blobs

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"

	"github.com/plasticparticle/mneme/server/internal/config"
)

// ErrNotConfigured is returned when no object store is configured (S3_ENDPOINT unset).
var ErrNotConfigured = errors.New("media storage not configured")

// ErrNotFound is returned for keys that were never stored.
var ErrNotFound = errors.New("blob not found")

// Store holds opaque, client-encrypted media chunks.
type Store interface {
	Put(ctx context.Context, key string, data []byte) error
	Get(ctx context.Context, key string) ([]byte, error)
	// Delete removes one chunk. Deleting a key that was never stored is not an error.
	Delete(ctx context.Context, key string) error
	// DeletePrefix removes every object whose key starts with prefix, and
	// reports how many it removed. This is what makes "delete my vault" true:
	// cleanup driven off the media_blobs index can only ever reach chunks that
	// were finalized, and a chunk PUT that is never completed has no index row.
	// Enumerating object storage directly catches those too.
	//
	// Callers MUST pass a prefix that already contains the owner scope (see
	// api.mediaKeyPrefix) — this is the one operation that can reach across
	// objects, so the boundary is the caller's to get right.
	DeletePrefix(ctx context.Context, prefix string) (int, error)
}

// New selects a Store from config: S3/MinIO when an endpoint is set, Disabled otherwise.
func New(cfg config.S3Config) (Store, error) {
	if cfg.Endpoint == "" {
		return Disabled{}, nil
	}
	return newS3(cfg)
}

// Disabled is a no-op Store used when no object store is configured.
type Disabled struct{}

func (Disabled) Put(context.Context, string, []byte) error { return ErrNotConfigured }
func (Disabled) Get(context.Context, string) ([]byte, error) {
	return nil, ErrNotConfigured
}
func (Disabled) Delete(context.Context, string) error { return ErrNotConfigured }
func (Disabled) DeletePrefix(context.Context, string) (int, error) {
	return 0, ErrNotConfigured
}

// Memory is an in-process Store for tests.
type Memory struct {
	mu sync.Mutex
	m  map[string][]byte
}

func NewMemory() *Memory { return &Memory{m: map[string][]byte{}} }

func (s *Memory) Put(_ context.Context, key string, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := make([]byte, len(data))
	copy(cp, data)
	s.m[key] = cp
	return nil
}

func (s *Memory) Get(_ context.Context, key string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, ok := s.m[key]
	if !ok {
		return nil, ErrNotFound
	}
	return data, nil
}

func (s *Memory) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, key)
	return nil
}

func (s *Memory) DeletePrefix(_ context.Context, prefix string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for k := range s.m {
		if strings.HasPrefix(k, prefix) {
			delete(s.m, k)
			n++
		}
	}
	return n, nil
}

// Keys returns every stored key — tests only, so they can assert that a wipe
// really emptied object storage rather than just the index.
func (s *Memory) Keys() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.m))
	for k := range s.m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
