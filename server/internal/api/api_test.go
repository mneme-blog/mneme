package api

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/plasticparticle/mneme/server/internal/config"
)

func testConfig() config.Config {
	return config.Config{ListenAddr: ":0", SessionTTL: time.Hour}
}

func TestHealthz(t *testing.T) {
	srv := New(nil, nil, testConfig())
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)

	srv.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["status"] != "ok" {
		t.Fatalf("status = %q, want ok", body["status"])
	}
}

func TestProtectedRouteRequiresToken(t *testing.T) {
	srv := New(nil, nil, testConfig())
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/sync/pull", nil)

	srv.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (auth runs before any store access)", rec.Code)
	}
}

func TestDeleteMediaRequiresToken(t *testing.T) {
	srv := New(nil, nil, testConfig())
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, "/v1/media/0123456789abcdef", nil)

	srv.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (media deletion must be device-authenticated)", rec.Code)
	}
}

func TestDeleteAccountRequiresToken(t *testing.T) {
	srv := New(nil, nil, testConfig())
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, "/v1/account", nil)

	srv.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (account deletion must be device-authenticated)", rec.Code)
	}
}

func TestDeriveIDDeterministic(t *testing.T) {
	pub := []byte("a-32-byte-public-key-fixture-xx!")
	if got, want := deriveID(pub), deriveID(pub); got != want {
		t.Fatalf("deriveID not deterministic: %q vs %q", got, want)
	}
	if deriveID(pub) == deriveID([]byte("different-32-byte-public-key-xx!")) {
		t.Fatal("deriveID collided on distinct inputs")
	}
}

func TestRegisterMessageVerifies(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	ownerPub := make([]byte, x25519PubLen)
	msg := registerMessage(ownerPub, pub)
	sig := ed25519.Sign(priv, msg)

	if !ed25519.Verify(pub, msg, sig) {
		t.Fatal("registerMessage signature did not verify")
	}
	if ed25519.Verify(pub, registerMessage([]byte("tampered-owner-key-bytes-32-byte"), pub), sig) {
		t.Fatal("signature verified against a different owner key — message binding is broken")
	}
}

// The owner authorization signature (H1) must be bound to all three keys, so a
// captured registration cannot be replayed for another owner or another device.
func TestBindDeviceMessageBinding(t *testing.T) {
	signPub, signPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	devicePub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	ownerPub := bytes.Repeat([]byte{1}, x25519PubLen)
	sig := ed25519.Sign(signPriv, bindDeviceMessage(ownerPub, signPub, devicePub))

	if !ed25519.Verify(signPub, bindDeviceMessage(ownerPub, signPub, devicePub), sig) {
		t.Fatal("bindDeviceMessage signature did not verify")
	}

	otherDevice, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	for name, msg := range map[string][]byte{
		"different owner":     bindDeviceMessage(bytes.Repeat([]byte{2}, x25519PubLen), signPub, devicePub),
		"different device":    bindDeviceMessage(ownerPub, signPub, otherDevice),
		"different sign key":  bindDeviceMessage(ownerPub, otherDevice, devicePub),
		"register-msg domain": registerMessage(ownerPub, devicePub),
	} {
		if ed25519.Verify(signPub, msg, sig) {
			t.Fatalf("signature verified against %s — message binding is broken", name)
		}
	}
}
