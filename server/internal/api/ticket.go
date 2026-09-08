package api

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"sync"
	"time"
)

// Short-lived, single-use tickets for downloads the BROWSER must perform itself.
//
// Everything else on the admin surface is a fetch() carrying the ADMIN_TOKEN in
// an Authorization header. A backup archive cannot be: a header only rides on
// XHR/fetch, so the page had to buffer the whole response and hand the bytes to
// a synthetic <a download> pointing at a blob: URL. That works in a lab and
// fails in the field — the archive is held twice in memory before anything is
// written to disk, there is no progress and no resume, and the blob+anchor step
// is exactly the sequence browsers and extensions treat with suspicion, so the
// button can do nothing at all with no error to show for it.
//
// A ticket moves the transfer back to the browser's own download machinery: the
// page asks for a ticket with its token, then points a plain navigation at
// GET /admin/backups/{name}?ticket=…, which streams to disk like any other file.
//
// The ticket is a bearer credential in a URL, so it is deliberately weak on
// purpose and narrow in scope:
//
//   - random 256 bits, compared in constant time,
//   - bound to ONE archive name (it cannot be replayed against another),
//   - single use (redeeming removes it),
//   - two minutes to live,
//   - it grants exactly one read of one archive — opaque ciphertext, no keys and
//     no plaintext — and nothing else on the admin surface.
//
// Referrer-Policy: no-referrer is already set relay-wide, so the URL does not
// leak onward through a Referer header. It does reach browser history and any
// proxy log in between, which is the trade the two-minute single use buys down.
type ticketStore struct {
	mu  sync.Mutex
	m   map[string]ticket
	ttl time.Duration
	// max bounds the map so a caller holding the admin token cannot grow it
	// without limit by minting tickets it never redeems.
	max int
}

type ticket struct {
	scope   string // the archive name this ticket may fetch
	expires time.Time
}

func newTicketStore(ttl time.Duration) *ticketStore {
	return &ticketStore{m: make(map[string]ticket), ttl: ttl, max: 64}
}

// issue mints a ticket for one scope and returns its opaque value.
func (t *ticketStore) issue(scope string, now time.Time) (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	val := base64.RawURLEncoding.EncodeToString(b[:])

	t.mu.Lock()
	defer t.mu.Unlock()
	t.sweep(now)
	if len(t.m) >= t.max {
		// Full of unredeemed tickets: drop the whole set rather than refuse.
		// They are two minutes from worthless anyway and every holder can mint
		// another with the token they already have.
		t.m = make(map[string]ticket)
	}
	t.m[val] = ticket{scope: scope, expires: now.Add(t.ttl)}
	return val, nil
}

// redeem consumes a ticket, reporting whether it was valid for scope. A ticket
// is spent whether or not the transfer that follows succeeds — a failed download
// is re-armed by clicking the button again, which is one more fetch.
func (t *ticketStore) redeem(val, scope string, now time.Time) bool {
	if val == "" {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.sweep(now)
	// Constant-time over the whole set: a plain map lookup would answer "no such
	// ticket" faster than "wrong scope", and the values are secrets.
	var found bool
	var got ticket
	for k, v := range t.m {
		if subtle.ConstantTimeCompare([]byte(k), []byte(val)) == 1 {
			found, got = true, v
			delete(t.m, k)
		}
	}
	return found && got.scope == scope && now.Before(got.expires)
}

// sweep drops expired tickets. Callers hold the lock.
func (t *ticketStore) sweep(now time.Time) {
	for k, v := range t.m {
		if !now.Before(v.expires) {
			delete(t.m, k)
		}
	}
}
