// Key derivation (CLAUDE.md §6). seed → HKDF-SHA256 → data/media keys + identity.
//
// NOTE: the locked decision (§3) named libsodium-wasm; this implementation uses the
// audited @noble/@scure stack instead — a deliberate, recorded override. The §6
// derivation (BIP39 → HKDF-SHA256 → keys; X25519 owner, Ed25519 device) is unchanged.
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { utf8 } from './bytes';
import { toBase64Url } from './base64';
import { HINT_ADJECTIVES, HINT_NOUNS } from './hintwords';

const SALT = utf8('journal-v1');
const KEY_LEN = 32;

export interface Identity {
  /** XChaCha20-Poly1305 key for entry bodies. */
  dataKey: Uint8Array;
  /** XChaCha20-Poly1305 key for chunked media (crypto/media.ts). */
  mediaKey: Uint8Array;
  /** Wraps the sealed AI-assistant settings (API key etc.) at rest. */
  aiKey: Uint8Array;
  /** X25519 owner public key (for sealed-box pairing). */
  ownerPub: Uint8Array;
  /**
   * Ed25519 owner identity signing key. Authorizes binding a device to this
   * owner at registration: the relay pins the public half the first time a vault
   * is created and refuses every later registration that isn't signed by it.
   * Without this, knowing the (non-secret) owner public key was enough to join
   * someone's vault and overwrite or wipe it — see docs/SECURITY.md §4.
   */
  ownerSignPriv: Uint8Array;
  /** Ed25519 owner identity signing public key. */
  ownerSignPub: Uint8Array;
  /** base64url(sha256(ownerPub)) — must match the relay's derivation. */
  ownerId: string;
  /**
   * Memorable, non-secret operator hint derived one-way from the seed (like a
   * friendly sibling of ownerId), e.g. "amber-otter-07". Sent at registration so
   * an operator running REQUIRE_APPROVAL can tell which pending vault is which;
   * shown to the user so they can quote it. Never used for auth. See
   * crypto/hintwords.ts and docs/SECURITY.md (accepted leaks).
   */
  approvalHint: string;
  /** Ed25519 device private key (seed) for challenge-response auth. */
  devicePriv: Uint8Array;
  /** Ed25519 device public key. */
  devicePub: Uint8Array;
}

/**
 * Derive everything from the BIP39 seed. The device key is derived from the seed
 * too (info="device"), so nothing needs to be persisted: the mnemonic regenerates
 * the full identity on every cold start.
 */
export function deriveIdentity(seed: Uint8Array): Identity {
  const dataKey = hkdf(sha256, seed, SALT, utf8('data'), KEY_LEN);
  const mediaKey = hkdf(sha256, seed, SALT, utf8('media'), KEY_LEN);
  const aiKey = hkdf(sha256, seed, SALT, utf8('ai-settings'), KEY_LEN);

  const identitySeed = hkdf(sha256, seed, SALT, utf8('identity'), KEY_LEN);
  const ownerPub = x25519.getPublicKey(identitySeed);

  // Separate HKDF label, so the signing key is never the same bytes as the
  // X25519 identity key even though both speak for the same owner.
  const ownerSignPriv = hkdf(sha256, seed, SALT, utf8('identity-sign'), KEY_LEN);
  const ownerSignPub = ed25519.getPublicKey(ownerSignPriv);

  const deviceSeed = hkdf(sha256, seed, SALT, utf8('device'), KEY_LEN);
  const devicePub = ed25519.getPublicKey(deviceSeed);

  return {
    dataKey,
    mediaKey,
    aiKey,
    ownerPub,
    ownerSignPriv,
    ownerSignPub,
    ownerId: toBase64Url(sha256(ownerPub)),
    approvalHint: deriveApprovalHint(seed),
    devicePriv: deviceSeed,
    devicePub,
  };
}

/**
 * Derive the memorable operator hint from the seed: 3 HKDF bytes → an adjective,
 * a noun, and a two-digit number, e.g. "amber-otter-07". Deterministic (the same
 * mnemonic always yields the same hint) and one-way, so it reveals nothing about
 * the seed — exactly like ownerId.
 */
export function deriveApprovalHint(seed: Uint8Array): string {
  const b = hkdf(sha256, seed, SALT, utf8('approval-hint'), 3);
  const adj = HINT_ADJECTIVES[b[0] % HINT_ADJECTIVES.length];
  const noun = HINT_NOUNS[b[1] % HINT_NOUNS.length];
  const num = (b[2] % 100).toString().padStart(2, '0');
  return `${adj}-${noun}-${num}`;
}

/** Ed25519 signature for challenge-response auth and registration. */
export function signWithDevice(devicePriv: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, devicePriv);
}

/** Ed25519 signature by the owner identity key — authorizes device binding. */
export function signWithOwner(ownerSignPriv: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, ownerSignPriv);
}
