//go:build e2e

// Exercises REQUIRE_APPROVAL end-to-end against a real Postgres:
//
//	TEST_DATABASE_URL=postgres://journal:journal_dev@localhost:5432/journal_test?sslmode=disable \
//	  go test -tags e2e ./e2e/...
package e2e

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/plasticparticle/mneme/server/internal/api"
	"github.com/plasticparticle/mneme/server/internal/blobs"
	"github.com/plasticparticle/mneme/server/internal/config"
	"github.com/plasticparticle/mneme/server/internal/store"
)

func TestApprovalFlow(t *testing.T) {
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

	const adminToken = "test-admin-token"
	ts := httptest.NewServer(api.New(st, blobs.NewMemory(), config.Config{
		SessionTTL:      time.Hour,
		RequireApproval: true,
		AdminToken:      adminToken,
	}).Routes())
	defer ts.Close()
	c := &client{t: t, base: ts.URL}

	v := newVaultKeys(t)
	devicePriv := v.devicePriv

	// Register → the new vault is created 'pending' and says so.
	regBody := map[string]string{"approval_hint": "amber-otter-07"}
	for k, val := range v.registerBody {
		regBody[k] = val
	}
	var reg struct {
		OwnerID  string `json:"owner_id"`
		DeviceID string `json:"device_id"`
		Status   string `json:"status"`
	}
	c.post("/v1/register", regBody, http.StatusOK, &reg)
	// Don't leak one owner row per run into the shared test DB (the suite is
	// only order-tolerant today because the backup test resets first).
	t.Cleanup(func() {
		if _, err := st.DeleteOwner(context.Background(), reg.OwnerID); err != nil {
			t.Logf("cleanup owner: %v", err)
		}
	})
	if reg.Status != store.OwnerStatusPending {
		t.Fatalf("new owner should be pending, got %q", reg.Status)
	}

	// A fresh challenge+signature each time (challenges are single-use).
	signChallenge := func() (challenge, signature string) {
		var chal struct{ Challenge string }
		c.post("/v1/auth/challenge", map[string]string{"device_id": reg.DeviceID}, http.StatusOK, &chal)
		raw, _ := base64.StdEncoding.DecodeString(chal.Challenge)
		return chal.Challenge, b64(ed25519.Sign(devicePriv, raw))
	}

	// Verify while pending → 403, no session issued (signature is valid; it's the
	// approval gate that blocks it).
	ch, sg := signChallenge()
	c.post("/v1/auth/verify", map[string]string{
		"device_id": reg.DeviceID, "challenge": ch, "signature": sg,
	}, http.StatusForbidden, nil)

	// Operator approves the vault.
	adminPost(t, ts.URL, "/admin/owners/"+reg.OwnerID+"/approve", adminToken, http.StatusNoContent)

	// Verify now yields a session token.
	ch, sg = signChallenge()
	var verified struct {
		Token string `json:"token"`
	}
	c.post("/v1/auth/verify", map[string]string{
		"device_id": reg.DeviceID, "challenge": ch, "signature": sg,
	}, http.StatusOK, &verified)
	if verified.Token == "" {
		t.Fatal("approved owner got no session token")
	}
	c.token = verified.Token

	// An authenticated call now works.
	c.post("/v1/sync/pull", map[string]any{"since": 0}, http.StatusOK, nil)

	// Operator rejects → the still-valid session is cut off on the very next
	// request (the auth middleware reads live status, not a snapshot).
	adminPost(t, ts.URL, "/admin/owners/"+reg.OwnerID+"/reject", adminToken, http.StatusNoContent)
	c.post("/v1/sync/pull", map[string]any{"since": 0}, http.StatusForbidden, nil)
}

// adminPost issues an admin POST with the operator token and asserts the status.
func adminPost(t *testing.T, base, path, token string, want int) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, base+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != want {
		t.Fatalf("admin POST %s -> %d, want %d", path, resp.StatusCode, want)
	}
}
