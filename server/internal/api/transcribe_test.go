package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/mneme-blog/mneme/server/internal/config"
)

// authorize calls the handler directly with an already-authenticated principal.
// The auth middleware in front of it needs a database; what is worth testing
// here is what happens once a session is known good.
func authorize(t *testing.T, s *Server, owner string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/v1/transcribe/authorize", nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	req = req.WithContext(context.WithValue(req.Context(), principalKey, principal{OwnerID: owner}))
	rec := httptest.NewRecorder()
	s.handleTranscribeAuthorize(rec, req)
	return rec
}

func transcribeServer(t *testing.T, tc config.TranscribeConfig) *Server {
	t.Helper()
	cfg := testConfig()
	cfg.Transcribe = tc
	return New(nil, nil, cfg)
}

// The daily quota is per vault: one vault running out must not affect another,
// and the limit is on recordings sent, not on anything the client says.
func TestTranscribeDailyQuota(t *testing.T) {
	s := transcribeServer(t, config.TranscribeConfig{QuotaRequestsPerDay: 3})

	for i := 0; i < 3; i++ {
		if rec := authorize(t, s, "vault-a", nil); rec.Code != http.StatusNoContent {
			t.Fatalf("recording %d = %d, want 204", i+1, rec.Code)
		}
	}
	rec := authorize(t, s, "vault-a", nil)
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("past the daily quota = %d, want 429", rec.Code)
	}
	if ra, _ := strconv.Atoi(rec.Header().Get("Retry-After")); ra <= 0 || ra > 86401 {
		t.Errorf("Retry-After = %q, want the seconds left in the UTC day", rec.Header().Get("Retry-After"))
	}
	if rec := authorize(t, s, "vault-b", nil); rec.Code != http.StatusNoContent {
		t.Errorf("a second vault = %d, want 204 — the quota is per vault", rec.Code)
	}
}

// Checking whether the server is up costs nothing: it sends no audio and starts
// no work, and charging it would let someone burn their day in the settings sheet.
func TestTranscribeModelListingIsFree(t *testing.T) {
	s := transcribeServer(t, config.TranscribeConfig{QuotaRequestsPerDay: 1})

	for i := 0; i < 5; i++ {
		rec := authorize(t, s, "vault-a", map[string]string{headerTranscribeKind: kindModels})
		if rec.Code != http.StatusNoContent {
			t.Fatalf("model listing %d = %d, want 204", i+1, rec.Code)
		}
	}
	if rec := authorize(t, s, "vault-a", map[string]string{headerTranscribeKind: kindTranscribe}); rec.Code != http.StatusNoContent {
		t.Errorf("the day's one recording = %d, want 204", rec.Code)
	}
	if rec := authorize(t, s, "vault-a", nil); rec.Code != http.StatusTooManyRequests {
		t.Errorf("second recording = %d, want 429", rec.Code)
	}
}

// An absent or unrecognised kind must be charged: the header comes from the
// proxy, and the safe reading of "I don't know what this is" is "it costs".
func TestTranscribeUnknownKindIsCharged(t *testing.T) {
	s := transcribeServer(t, config.TranscribeConfig{QuotaRequestsPerDay: 1})
	if rec := authorize(t, s, "v", map[string]string{headerTranscribeKind: "something-else"}); rec.Code != http.StatusNoContent {
		t.Fatalf("first = %d, want 204", rec.Code)
	}
	if rec := authorize(t, s, "v", map[string]string{headerTranscribeKind: "something-else"}); rec.Code != http.StatusTooManyRequests {
		t.Errorf("second = %d, want 429 (it should have been charged)", rec.Code)
	}
}

func TestTranscribeByteQuota(t *testing.T) {
	s := transcribeServer(t, config.TranscribeConfig{QuotaMegabytesPerDay: 10})
	big := map[string]string{headerUploadBytes: strconv.Itoa(6 << 20)} // 6 MB

	if rec := authorize(t, s, "v", big); rec.Code != http.StatusNoContent {
		t.Fatalf("first 6 MB = %d, want 204", rec.Code)
	}
	if rec := authorize(t, s, "v", big); rec.Code != http.StatusTooManyRequests {
		t.Errorf("second 6 MB (12 MB > 10 MB) = %d, want 429", rec.Code)
	}
	// A garbage or missing size must not become a negative charge that buys budget.
	s2 := transcribeServer(t, config.TranscribeConfig{QuotaMegabytesPerDay: 1})
	if rec := authorize(t, s2, "v", map[string]string{headerUploadBytes: "-999999999"}); rec.Code != http.StatusNoContent {
		t.Errorf("a negative declared size = %d, want 204 charged as zero", rec.Code)
	}
}

func TestTranscribeRateLimit(t *testing.T) {
	s := transcribeServer(t, config.TranscribeConfig{
		RateRequestsPerMinute: 60, RateBurstRequests: 2,
	})
	for i := 0; i < 2; i++ {
		if rec := authorize(t, s, "v", nil); rec.Code != http.StatusNoContent {
			t.Fatalf("burst request %d = %d, want 204", i+1, rec.Code)
		}
	}
	if rec := authorize(t, s, "v", nil); rec.Code != http.StatusTooManyRequests {
		t.Errorf("past the burst = %d, want 429", rec.Code)
	}
}

func TestTranscribeUnlimitedByDefault(t *testing.T) {
	s := transcribeServer(t, config.TranscribeConfig{}) // all zeroes = off
	for i := 0; i < 50; i++ {
		if rec := authorize(t, s, "v", nil); rec.Code != http.StatusNoContent {
			t.Fatalf("request %d = %d, want 204 with every bound disabled", i+1, rec.Code)
		}
	}
}

// The day's counters roll over at UTC midnight, and the map is emptied with them.
func TestTranscribeQuotaRollsOverAtMidnight(t *testing.T) {
	q := newTranscribeQuota(1, 0)
	day1 := time.Date(2026, 8, 5, 23, 59, 0, 0, time.UTC)

	if ok, _ := q.charge("v", 0, day1); !ok {
		t.Fatal("first charge should succeed")
	}
	if ok, retry := q.charge("v", 0, day1); ok || retry <= 0 {
		t.Fatalf("second charge on the same day = (%v, %v), want (false, >0)", ok, retry)
	}
	if ok, _ := q.charge("v", 0, day1.Add(2*time.Minute)); !ok {
		t.Error("the next UTC day should start fresh")
	}
	if len(q.used) != 1 {
		t.Errorf("rollover should drop the previous day's counters, got %d entries", len(q.used))
	}
}

// The per-IP bucket in front of the gate is spent by unauthenticated callers
// only — a signed-in device transcribing all day must never be throttled by it.
func TestTranscribeGateChargesOnlyFailures(t *testing.T) {
	cfg := testConfig()
	cfg.RateLimit.AuthPerMinute = 60
	cfg.RateLimit.AuthBurst = 3
	s := New(nil, nil, cfg)

	ok := s.transcribeGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	for i := 0; i < 10; i++ {
		rec := httptest.NewRecorder()
		ok.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/transcribe/authorize", nil))
		if rec.Code != http.StatusNoContent {
			t.Fatalf("authorized request %d = %d, want 204 — successes must not be charged", i+1, rec.Code)
		}
	}

	denied := s.transcribeGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusUnauthorized, "nope")
	}))
	codes := make([]int, 0, 5)
	for i := 0; i < 5; i++ {
		rec := httptest.NewRecorder()
		denied.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/transcribe/authorize", nil))
		codes = append(codes, rec.Code)
	}
	if codes[len(codes)-1] != http.StatusTooManyRequests {
		t.Errorf("repeated failures = %v, want the last one throttled to 429", codes)
	}
}

// The startup line has to be readable by an operator and carry its units.
func TestTranscribeSummary(t *testing.T) {
	got := config.TranscribeConfig{
		QuotaRequestsPerDay: 50, RateRequestsPerMinute: 6, RateBurstRequests: 6,
	}.Summary()
	for _, want := range []string{"50 recordings", "per vault per UTC day", "6 requests/minute", "in memory"} {
		if !strings.Contains(got, want) {
			t.Errorf("summary %q is missing %q", got, want)
		}
	}
	off := config.TranscribeConfig{}.Summary()
	if !strings.Contains(off, "unlimited recordings") || !strings.Contains(off, "no per-vault rate limit") {
		t.Errorf("summary with everything disabled reads wrong: %q", off)
	}
}
