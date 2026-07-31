package api

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"time"

	"github.com/plasticparticle/mneme/server/internal/store"
)

const (
	x25519PubLen    = 32
	challengeTTL    = 2 * time.Minute
	sessionTokenLen = 32
)

// registerMessage is what a device signs to prove possession of its private key.
func registerMessage(ownerPub, devicePub []byte) []byte {
	msg := append([]byte("mneme:register:"), ownerPub...)
	return append(msg, devicePub...)
}

// bindDeviceMessage is what the OWNER identity signing key signs to authorize
// binding a device to this owner. Both public keys are inside the message, so a
// captured signature cannot be replayed for a different owner or a different
// device — which is the whole point: possession of the owner *public* key must
// not be enough to join a vault.
func bindDeviceMessage(ownerPub, ownerSignPub, devicePub []byte) []byte {
	msg := append([]byte("mneme:bind-device:v1:"), ownerPub...)
	msg = append(msg, ownerSignPub...)
	return append(msg, devicePub...)
}

// POST /v1/register
//
// Two proofs are required (§6 pairing, resolves the H1 audit finding):
//   - the caller controls the DEVICE key it presents (self-signed registerMessage), and
//   - the caller controls the OWNER identity signing key — an Ed25519 key the
//     client derives from the same BIP39 seed — over bindDeviceMessage.
//
// Trust-on-first-use survives only for a brand-new owner: whoever creates the
// vault pins its owner signing key. Every later registration must sign with that
// same pinned key, so learning a victim's owner_pubkey no longer lets an attacker
// bind a device (and thereby read, overwrite, tombstone or wipe the vault).
//
// Grandfathering: owners registered before migration 0004 have no pinned key yet.
// For them the relay adopts the presented key once, and only when the request
// comes from a device already bound to that owner — device keys are seed-derived,
// so an honest client always presents one and an attacker cannot.
func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req struct {
		OwnerPubkey  string `json:"owner_pubkey"`  // base64, X25519 (32 bytes)
		DevicePubkey string `json:"device_pubkey"` // base64, Ed25519 (32 bytes)
		Signature    string `json:"signature"`     // base64, device-signed registerMessage
		// Owner identity signing key (Ed25519, 32 bytes) and its signature over
		// bindDeviceMessage. Required for a new owner; required to match the pinned
		// key for an existing one.
		OwnerSignPubkey string `json:"owner_sign_pubkey"`
		OwnerSignature  string `json:"owner_signature"`
		// Optional operator hint (only meaningful when REQUIRE_APPROVAL is on): a
		// short code the client DERIVES from the seed so the operator can tell which
		// pending vault is which. Constrained to [a-z0-9-]{0,32} so it can never carry
		// markup or free-form text — it is not a secret and not user-typed.
		ApprovalHint string `json:"approval_hint"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if !validApprovalHint(req.ApprovalHint) {
		writeError(w, http.StatusBadRequest, "approval_hint must match [a-z0-9-]{0,32}")
		return
	}

	ownerPub, err := base64.StdEncoding.DecodeString(req.OwnerPubkey)
	if err != nil || len(ownerPub) != x25519PubLen {
		writeError(w, http.StatusBadRequest, "owner_pubkey must be 32 base64-encoded bytes")
		return
	}
	devicePub, err := base64.StdEncoding.DecodeString(req.DevicePubkey)
	if err != nil || len(devicePub) != ed25519.PublicKeySize {
		writeError(w, http.StatusBadRequest, "device_pubkey must be 32 base64-encoded bytes")
		return
	}
	sig, err := base64.StdEncoding.DecodeString(req.Signature)
	if err != nil {
		writeError(w, http.StatusBadRequest, "signature must be base64")
		return
	}
	if !ed25519.Verify(ed25519.PublicKey(devicePub), registerMessage(ownerPub, devicePub), sig) {
		writeError(w, http.StatusUnauthorized, "signature does not verify against device_pubkey")
		return
	}

	// Owner authorization material is optional on the wire only so a client that
	// predates this change keeps working against its own already-bound device;
	// authorizeBinding rejects every other use of the empty case.
	var ownerSignPub, ownerSig []byte
	if req.OwnerSignPubkey != "" || req.OwnerSignature != "" {
		ownerSignPub, err = base64.StdEncoding.DecodeString(req.OwnerSignPubkey)
		if err != nil || len(ownerSignPub) != ed25519.PublicKeySize {
			writeError(w, http.StatusBadRequest, "owner_sign_pubkey must be 32 base64-encoded bytes")
			return
		}
		ownerSig, err = base64.StdEncoding.DecodeString(req.OwnerSignature)
		if err != nil {
			writeError(w, http.StatusBadRequest, "owner_signature must be base64")
			return
		}
		if !ed25519.Verify(ed25519.PublicKey(ownerSignPub), bindDeviceMessage(ownerPub, ownerSignPub, devicePub), ownerSig) {
			writeError(w, http.StatusUnauthorized, "owner_signature does not verify against owner_sign_pubkey")
			return
		}
	}

	ownerID := deriveID(ownerPub)
	deviceID := deriveID(devicePub)

	// A brand-new owner is 'pending' when approval is required, else 'approved'.
	// (The status is applied only if this creates the owner — see the store.)
	status := store.OwnerStatusApproved
	if s.cfg.RequireApproval {
		status = store.OwnerStatusPending
	}
	ownerCreated, err := s.store.RegisterOwnerDevice(r.Context(), ownerID, ownerPub, deviceID, devicePub, status, req.ApprovalHint, ownerSignPub)
	if errors.Is(err, store.ErrBindingNotAuthorized) {
		// Deliberately one message for every rejected case: it must not reveal
		// whether the owner exists, nor which half of the check failed.
		writeError(w, http.StatusUnauthorized, "registration is not authorized for this owner")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "registration failed")
		return
	}
	if ownerCreated {
		s.metrics.bump(metricVaultsCreated, 1)
	}
	// Report the owner's effective status so the client can show a "pending
	// approval" screen instead of failing an auth it can't yet pass. For an owner
	// that already existed we return its live status, not the would-be initial one.
	effective := status
	if !ownerCreated {
		if cur, err := s.store.OwnerStatus(r.Context(), ownerID); err == nil {
			effective = cur
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"owner_id":  ownerID,
		"device_id": deviceID,
		"status":    effective,
	})
}

// validApprovalHint enforces the constrained charset for the operator hint.
// Empty is always valid (the field is optional / unused when approval is off).
func validApprovalHint(h string) bool {
	if len(h) > 32 {
		return false
	}
	for _, c := range h {
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
			return false
		}
	}
	return true
}

// POST /v1/auth/challenge
func (s *Server) handleChallenge(w http.ResponseWriter, r *http.Request) {
	var req struct {
		DeviceID string `json:"device_id"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if _, _, err := s.store.DevicePubkey(r.Context(), req.DeviceID); err != nil {
		writeError(w, http.StatusNotFound, "unknown device")
		return
	}

	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		writeError(w, http.StatusInternalServerError, "could not generate challenge")
		return
	}
	expires := time.Now().Add(challengeTTL)
	if err := s.store.SaveChallenge(r.Context(), req.DeviceID, nonce, expires); err != nil {
		writeError(w, http.StatusInternalServerError, "could not store challenge")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"challenge":  base64.StdEncoding.EncodeToString(nonce),
		"expires_at": expires.UTC().Format(time.RFC3339),
	})
}

// POST /v1/auth/verify
func (s *Server) handleVerify(w http.ResponseWriter, r *http.Request) {
	var req struct {
		DeviceID  string `json:"device_id"`
		Challenge string `json:"challenge"`
		Signature string `json:"signature"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	challenge, err := base64.StdEncoding.DecodeString(req.Challenge)
	if err != nil {
		writeError(w, http.StatusBadRequest, "challenge must be base64")
		return
	}
	sig, err := base64.StdEncoding.DecodeString(req.Signature)
	if err != nil {
		writeError(w, http.StatusBadRequest, "signature must be base64")
		return
	}

	ownerID, pub, err := s.store.DevicePubkey(r.Context(), req.DeviceID)
	if err != nil {
		writeError(w, http.StatusNotFound, "unknown device")
		return
	}
	if !ed25519.Verify(ed25519.PublicKey(pub), challenge, sig) {
		writeError(w, http.StatusUnauthorized, "signature does not verify")
		return
	}
	// Approval gate: don't mint a session for an owner the operator hasn't approved.
	// Checked only after the signature verifies, so it never reveals an owner's
	// status to a caller that doesn't hold the device key. The client turns this
	// 403 into a "pending approval" screen rather than a hard error.
	if status, err := s.store.OwnerStatus(r.Context(), ownerID); err == nil && status != store.OwnerStatusApproved {
		writeError(w, http.StatusForbidden, "vault is pending operator approval")
		return
	}
	// Single-use: consume the challenge only after the signature checks out.
	ok, err := s.store.ConsumeChallenge(r.Context(), req.DeviceID, challenge)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "challenge lookup failed")
		return
	}
	if !ok {
		writeError(w, http.StatusUnauthorized, "challenge expired or already used")
		return
	}

	tokenBytes := make([]byte, sessionTokenLen)
	if _, err := rand.Read(tokenBytes); err != nil {
		writeError(w, http.StatusInternalServerError, "could not issue session")
		return
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	hash := sha256.Sum256([]byte(token))
	expires := time.Now().Add(s.cfg.SessionTTL)
	if err := s.store.CreateSession(r.Context(), hash[:], req.DeviceID, ownerID, expires); err != nil {
		writeError(w, http.StatusInternalServerError, "could not store session")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token":      token,
		"owner_id":   ownerID,
		"expires_at": expires.UTC().Format(time.RFC3339),
	})
}
