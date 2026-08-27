//go:build e2e

// Package e2e exercises the relay against a real Postgres (TEST_DATABASE_URL),
// running the full device handshake and LWW sync through the HTTP surface.
//
//	docker compose up -d postgres
//	TEST_DATABASE_URL=postgres://journal:journal_dev@localhost:5432/journal_test?sslmode=disable \
//	  go test -tags e2e ./e2e/...
package e2e

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/mneme-blog/mneme/server/internal/api"
	"github.com/mneme-blog/mneme/server/internal/blobs"
	"github.com/mneme-blog/mneme/server/internal/config"
	"github.com/mneme-blog/mneme/server/internal/store"
)

func TestFullFlow(t *testing.T) {
	dsn := testDSN(t)
	ctx := context.Background()

	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// Media chunks land in an in-memory blob store: the e2e suite needs only
	// Postgres, while the HTTP surface is exercised exactly as with MinIO.
	bl := blobs.NewMemory()
	ts := httptest.NewServer(api.New(st, bl, config.Config{SessionTTL: time.Hour}).Routes())
	defer ts.Close()
	c := &client{t: t, base: ts.URL}

	// Keys: device and owner-identity keys are Ed25519; the owner pubkey itself
	// is opaque to the server (32 bytes).
	v := newVaultKeys(t)
	devicePriv := v.devicePriv

	// 1. Register.
	var reg struct {
		OwnerID  string `json:"owner_id"`
		DeviceID string `json:"device_id"`
	}
	c.post("/v1/register", v.registerBody, http.StatusOK, &reg)
	if reg.OwnerID == "" || reg.DeviceID == "" {
		t.Fatal("register returned empty ids")
	}

	// 2. Challenge → 3. Verify → session token.
	var chal struct{ Challenge string }
	c.post("/v1/auth/challenge", map[string]string{"device_id": reg.DeviceID}, http.StatusOK, &chal)
	challenge, _ := base64.StdEncoding.DecodeString(chal.Challenge)

	var verified struct {
		Token   string `json:"token"`
		OwnerID string `json:"owner_id"`
	}
	c.post("/v1/auth/verify", map[string]string{
		"device_id": reg.DeviceID,
		"challenge": chal.Challenge,
		"signature": b64(ed25519.Sign(devicePriv, challenge)),
	}, http.StatusOK, &verified)
	if verified.Token == "" {
		t.Fatal("verify returned empty token")
	}
	if verified.OwnerID != reg.OwnerID {
		t.Fatalf("owner mismatch: %s vs %s", verified.OwnerID, reg.OwnerID)
	}
	c.token = verified.Token

	// A second verify with the same challenge must fail (single-use).
	c.post("/v1/auth/verify", map[string]string{
		"device_id": reg.DeviceID,
		"challenge": chal.Challenge,
		"signature": b64(ed25519.Sign(devicePriv, challenge)),
	}, http.StatusUnauthorized, nil)

	// 4. Push an entry (ciphertext = version byte + opaque bytes).
	blob := append([]byte{0x01}, []byte("opaque-ciphertext")...)
	type pushResult struct {
		Results []struct {
			EntryID string `json:"entry_id"`
			Applied bool   `json:"applied"`
		} `json:"results"`
	}
	var pr pushResult
	c.post("/v1/sync/push", map[string]any{
		"entries": []map[string]any{{"entry_id": "e-001", "lww_clock": 5, "ciphertext": b64(blob), "deleted": false}},
	}, http.StatusOK, &pr)
	if len(pr.Results) != 1 || !pr.Results[0].Applied {
		t.Fatalf("first push should apply: %+v", pr.Results)
	}

	// A stale clock must be rejected (LWW).
	c.post("/v1/sync/push", map[string]any{
		"entries": []map[string]any{{"entry_id": "e-001", "lww_clock": 4, "ciphertext": b64(blob), "deleted": false}},
	}, http.StatusOK, &pr)
	if pr.Results[0].Applied {
		t.Fatal("stale clock should not apply")
	}

	// 5. Pull it back.
	var pull struct {
		Entries []struct {
			EntryID    string `json:"entry_id"`
			LWWClock   int64  `json:"lww_clock"`
			Ciphertext string `json:"ciphertext"`
		} `json:"entries"`
		Cursor int64 `json:"cursor"`
	}
	c.post("/v1/sync/pull", map[string]any{"since": 0}, http.StatusOK, &pull)
	if len(pull.Entries) != 1 || pull.Entries[0].EntryID != "e-001" || pull.Entries[0].LWWClock != 5 {
		t.Fatalf("pull mismatch: %+v", pull.Entries)
	}
	if got, _ := base64.StdEncoding.DecodeString(pull.Entries[0].Ciphertext); !bytes.Equal(got, blob) {
		t.Fatal("ciphertext round-trip mismatch")
	}

	// Pulling from the latest cursor yields nothing new.
	var pull2 struct {
		Entries []json.RawMessage `json:"entries"`
	}
	c.post("/v1/sync/pull", map[string]any{"since": pull.Cursor}, http.StatusOK, &pull2)
	if len(pull2.Entries) != 0 {
		t.Fatalf("expected caught-up pull, got %d entries", len(pull2.Entries))
	}

	// The push batch is capped by COUNT, not just by body size: 501 tiny entries
	// fit well inside the 32 MiB body cap but would be 501 sequential writes in
	// a loop (audit finding L7, issue #52). 500 is fine, 501 is not. Run after
	// the pull assertions above so the bulk rows don't perturb them.
	oversized := make([]map[string]any, 0, 501)
	for i := 0; i < 501; i++ {
		oversized = append(oversized, map[string]any{
			"entry_id": "bulk-" + strconv.Itoa(i), "lww_clock": 1, "ciphertext": b64(blob), "deleted": false,
		})
	}
	c.post("/v1/sync/push", map[string]any{"entries": oversized}, http.StatusRequestEntityTooLarge, nil)
	c.post("/v1/sync/push", map[string]any{"entries": oversized[:500]}, http.StatusOK, &pr)
	if len(pr.Results) != 500 {
		t.Fatalf("a 500-entry batch should be accepted, got %d results", len(pr.Results))
	}

	// 6. Reminders: put → list → delete.
	c.do(http.MethodPut, "/v1/reminders", map[string]string{
		"reminder_id": "r-1", "fire_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
	}, http.StatusOK, nil)
	var list struct {
		Reminders []struct {
			ReminderID string `json:"reminder_id"`
		} `json:"reminders"`
	}
	c.do(http.MethodGet, "/v1/reminders", nil, http.StatusOK, &list)
	if len(list.Reminders) != 1 || list.Reminders[0].ReminderID != "r-1" {
		t.Fatalf("reminders list mismatch: %+v", list.Reminders)
	}
	c.do(http.MethodDelete, "/v1/reminders/r-1", nil, http.StatusNoContent, nil)

	// 7. Media: upload chunks → complete → meta → download (opaque ciphertext relay).
	mediaID := "0123456789abcdef0123456789abcdef"
	chunk0 := append([]byte{0x01}, []byte("encrypted-chunk-0")...)
	chunk1 := append([]byte{0x01}, []byte("encrypted-chunk-1")...)
	c.raw(http.MethodPut, "/v1/media/"+mediaID+"/chunks/0", chunk0, http.StatusOK)
	c.raw(http.MethodPut, "/v1/media/"+mediaID+"/chunks/1", chunk1, http.StatusOK)
	c.post("/v1/media/"+mediaID+"/complete",
		map[string]any{"chunks": 2, "bytes": len(chunk0) + len(chunk1)}, http.StatusOK, nil)

	var meta struct {
		Bytes  int64 `json:"bytes"`
		Chunks int   `json:"chunks"`
	}
	c.do(http.MethodGet, "/v1/media/"+mediaID, nil, http.StatusOK, &meta)
	if meta.Chunks != 2 || meta.Bytes != int64(len(chunk0)+len(chunk1)) {
		t.Fatalf("media meta mismatch: %+v", meta)
	}
	if got := c.rawGet("/v1/media/"+mediaID+"/chunks/1", http.StatusOK); !bytes.Equal(got, chunk1) {
		t.Fatal("media chunk round-trip mismatch")
	}
	c.rawGet("/v1/media/"+mediaID+"/chunks/2", http.StatusNotFound)
	c.do(http.MethodGet, "/v1/media/ffffffffffffffffffffffffffffffff", nil, http.StatusNotFound, nil)

	// Tenant isolation smoke test: no token → 401.
	noAuth := &client{t: t, base: ts.URL}
	noAuth.post("/v1/sync/pull", map[string]any{"since": 0}, http.StatusUnauthorized, nil)
	noAuth.rawGet("/v1/media/"+mediaID+"/chunks/0", http.StatusUnauthorized)

	// An upload that is started and never completed still has chunks on disk,
	// but no media_blobs row. It used to be unreachable by every cleanup path
	// and outlived the vault itself (audit finding M2, issue #43).
	orphanID := "fedcba9876543210fedcba9876543210"
	c.raw(http.MethodPut, "/v1/media/"+orphanID+"/chunks/0", []byte{0x01, 0x02, 0x03}, http.StatusOK)
	// Deleting it works even though the relay has no index row for it.
	c.do(http.MethodDelete, "/v1/media/"+orphanID, nil, http.StatusNoContent, nil)
	for _, k := range bl.Keys() {
		if strings.Contains(k, orphanID) {
			t.Fatalf("un-finalized chunk survived media deletion: %s", k)
		}
	}

	// A second one, left in place, must be swept by account deletion below.
	c.raw(http.MethodPut, "/v1/media/"+orphanID+"/chunks/0", []byte{0x01, 0x02, 0x03}, http.StatusOK)

	// 8. Account deletion (the server half of mnemonic rotation): everything the
	// owner ever stored — and the session that asked — must stop existing.
	c.do(http.MethodDelete, "/v1/account", nil, http.StatusNoContent, nil)
	if keys := bl.Keys(); len(keys) != 0 {
		t.Fatalf("account deletion left ciphertext in object storage: %v", keys)
	}
	c.post("/v1/sync/pull", map[string]any{"since": 0}, http.StatusUnauthorized, nil) // session cascaded away
	c.token = ""

	// Re-registering the same keys works (TOFU) and finds a clean slate: no
	// entries, no media. This is exactly what a leaked-but-rotated phrase sees.
	c.post("/v1/register", v.registerBody, http.StatusOK, &reg)
	c.post("/v1/auth/challenge", map[string]string{"device_id": reg.DeviceID}, http.StatusOK, &chal)
	challenge, _ = base64.StdEncoding.DecodeString(chal.Challenge)
	c.post("/v1/auth/verify", map[string]string{
		"device_id": reg.DeviceID,
		"challenge": chal.Challenge,
		"signature": b64(ed25519.Sign(devicePriv, challenge)),
	}, http.StatusOK, &verified)
	c.token = verified.Token

	var afterWipe struct {
		Entries []json.RawMessage `json:"entries"`
	}
	c.post("/v1/sync/pull", map[string]any{"since": 0}, http.StatusOK, &afterWipe)
	if len(afterWipe.Entries) != 0 {
		t.Fatalf("entries survived account deletion: %d", len(afterWipe.Entries))
	}
	c.do(http.MethodGet, "/v1/media/"+mediaID, nil, http.StatusNotFound, nil)
	c.rawGet("/v1/media/"+mediaID+"/chunks/0", http.StatusNotFound)
}

// ── tiny HTTP client ────────────────────────────────────────────────────────

type client struct {
	t     *testing.T
	base  string
	token string
}

func (c *client) post(path string, body any, wantStatus int, out any) {
	c.do(http.MethodPost, path, body, wantStatus, out)
}

func (c *client) do(method, path string, body any, wantStatus int, out any) {
	c.t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			c.t.Fatal(err)
		}
	}
	req, err := http.NewRequest(method, c.base+path, &buf)
	if err != nil {
		c.t.Fatal(err)
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != wantStatus {
		c.t.Fatalf("%s %s -> %d, want %d", method, path, resp.StatusCode, wantStatus)
	}
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			c.t.Fatalf("decode %s: %v", path, err)
		}
	}
}

// raw sends a non-JSON body (media chunks are raw octet-streams).
func (c *client) raw(method, path string, body []byte, wantStatus int) {
	c.t.Helper()
	req, err := http.NewRequest(method, c.base+path, bytes.NewReader(body))
	if err != nil {
		c.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != wantStatus {
		c.t.Fatalf("%s %s -> %d, want %d", method, path, resp.StatusCode, wantStatus)
	}
}

// rawGet fetches a binary response body.
func (c *client) rawGet(path string, wantStatus int) []byte {
	c.t.Helper()
	req, err := http.NewRequest(http.MethodGet, c.base+path, nil)
	if err != nil {
		c.t.Fatal(err)
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != wantStatus {
		c.t.Fatalf("GET %s -> %d, want %d", path, resp.StatusCode, wantStatus)
	}
	if wantStatus != http.StatusOK {
		return nil
	}
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(resp.Body); err != nil {
		c.t.Fatal(err)
	}
	return buf.Bytes()
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }
