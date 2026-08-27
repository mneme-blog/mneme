//go:build e2e

package e2e

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mneme-blog/mneme/server/internal/api"
	"github.com/mneme-blog/mneme/server/internal/blobs"
	"github.com/mneme-blog/mneme/server/internal/config"
	"github.com/mneme-blog/mneme/server/internal/store"
)

// TestDeviceBindingAuthorization is the regression test for the H1 finding
// (issue #40): the owner PUBLIC key must not be enough to join a vault.
//
// Before the fix, an attacker who learned a victim's 32-byte owner_pubkey could
// generate a device keypair, self-sign the registration, bind to the victim's
// owner, and then pull / overwrite / tombstone / wipe everything in it. The
// vault stayed unreadable (no seed → no plaintext), but its integrity and
// availability were entirely at the attacker's mercy.
func TestDeviceBindingAuthorization(t *testing.T) {
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

	ts := httptest.NewServer(api.New(st, blobs.NewMemory(), config.Config{SessionTTL: time.Hour}).Routes())
	defer ts.Close()
	c := &client{t: t, base: ts.URL}

	victim := newVaultKeys(t)
	var reg struct {
		OwnerID  string `json:"owner_id"`
		DeviceID string `json:"device_id"`
	}
	c.post("/v1/register", victim.registerBody, http.StatusOK, &reg)
	t.Cleanup(func() {
		if _, err := st.DeleteOwner(context.Background(), reg.OwnerID); err != nil {
			t.Logf("cleanup owner: %v", err)
		}
	})

	// The attacker knows only owner_pubkey — public by design (§3: "the pubkey is
	// not sensitive"). They mint their own device key AND their own owner signing
	// key, and self-sign a well-formed registration.
	attackerDevicePub, attackerDevicePriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	attackerSignPub, attackerSignPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	forged := victim.register(attackerDevicePub, attackerDevicePriv, attackerSignPub, attackerSignPriv)
	c.post("/v1/register", forged, http.StatusUnauthorized, nil)

	// Same attempt without any owner authorization material at all (what a
	// pre-fix client sends) must be refused for the same reason.
	noOwnerSig := map[string]string{
		"owner_pubkey":  forged["owner_pubkey"],
		"device_pubkey": forged["device_pubkey"],
		"signature":     forged["signature"],
	}
	c.post("/v1/register", noOwnerSig, http.StatusUnauthorized, nil)

	// And the attacker's device never became a device: no challenge for it.
	attackerDeviceID := deviceIDOf(t, st, reg.OwnerID, attackerDevicePub)
	if attackerDeviceID != "" {
		t.Fatal("attacker device was bound to the victim's owner")
	}

	// The genuine client, holding the seed, still registers and authenticates.
	c.post("/v1/register", victim.registerBody, http.StatusOK, &reg)
	var chal struct{ Challenge string }
	c.post("/v1/auth/challenge", map[string]string{"device_id": reg.DeviceID}, http.StatusOK, &chal)
}

// deviceIDOf returns the device_id bound to owner for pub, or "" if none is.
func deviceIDOf(t *testing.T, st *store.Store, ownerID string, pub ed25519.PublicKey) string {
	t.Helper()
	id := deriveIDForTest(pub)
	gotOwner, _, err := st.DevicePubkey(context.Background(), id)
	if err != nil {
		return ""
	}
	if gotOwner != ownerID {
		return ""
	}
	return id
}
