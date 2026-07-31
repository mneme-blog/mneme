//go:build e2e

package e2e

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"testing"
)

// deriveIDForTest mirrors api.deriveID — the public identifier for a public key.
func deriveIDForTest(pub []byte) string {
	sum := sha256.Sum256(pub)
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// vaultKeys is the client-side key material for one vault. A real client derives
// all of it from the BIP39 seed (apps/client/src/crypto/keys.ts); the tests only
// need keys that behave the same way on the wire.
type vaultKeys struct {
	ownerPub     []byte // X25519 in production; opaque 32 bytes to the relay
	signPub      ed25519.PublicKey
	signPriv     ed25519.PrivateKey
	devicePub    ed25519.PublicKey
	devicePriv   ed25519.PrivateKey
	registerBody map[string]string
}

func newVaultKeys(t *testing.T) *vaultKeys {
	t.Helper()
	devicePub, devicePriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signPub, signPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ownerPub := make([]byte, 32)
	if _, err := rand.Read(ownerPub); err != nil {
		t.Fatal(err)
	}
	v := &vaultKeys{
		ownerPub: ownerPub, signPub: signPub, signPriv: signPriv,
		devicePub: devicePub, devicePriv: devicePriv,
	}
	v.registerBody = v.register(devicePub, devicePriv, signPub, signPriv)
	return v
}

// register builds a /v1/register body. The parameters are explicit so a test can
// deliberately mismatch them (e.g. an attacker's device key with the victim's
// owner key) and assert the relay refuses the binding.
func (v *vaultKeys) register(devicePub ed25519.PublicKey, devicePriv ed25519.PrivateKey,
	signPub ed25519.PublicKey, signPriv ed25519.PrivateKey) map[string]string {
	regMsg := append(append([]byte("mneme:register:"), v.ownerPub...), devicePub...)
	bindMsg := append(append(append([]byte("mneme:bind-device:v1:"), v.ownerPub...), signPub...), devicePub...)
	return map[string]string{
		"owner_pubkey":      b64(v.ownerPub),
		"device_pubkey":     b64(devicePub),
		"signature":         b64(ed25519.Sign(devicePriv, regMsg)),
		"owner_sign_pubkey": b64(signPub),
		"owner_signature":   b64(ed25519.Sign(signPriv, bindMsg)),
	}
}
