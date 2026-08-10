// AEAD for entry bodies (CLAUDE.md §3/§6): [version:1B][nonce:24B][ct+tag],
// XChaCha20-Poly1305 with a random 24-byte nonce. Only the client encrypts and
// decrypts — the relay treats the whole blob as opaque bytes.
// @noble/ciphers v2 dropped extensionless subpath exports — the specifier must
// carry the `.js` (the export map has no './chacha' entry any more).
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from './bytes';

const VERSION = 0x01;
const NONCE_LEN = 24;

// `aad` is authenticated-but-not-encrypted context (e.g. a media chunk's index).
// It is never transmitted — both sides re-derive it — but a blob only decrypts
// when it matches, which pins a ciphertext to its place.
export function encrypt(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_LEN);
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
  const out = new Uint8Array(1 + NONCE_LEN + ct.length);
  out[0] = VERSION;
  out.set(nonce, 1);
  out.set(ct, 1 + NONCE_LEN);
  return out;
}

export function decrypt(key: Uint8Array, blob: Uint8Array, aad?: Uint8Array): Uint8Array {
  if (blob.length < 1 + NONCE_LEN) throw new Error('ciphertext too short');
  if (blob[0] !== VERSION) throw new Error(`unsupported ciphertext version ${blob[0]}`);
  const nonce = blob.subarray(1, 1 + NONCE_LEN);
  const ct = blob.subarray(1 + NONCE_LEN);
  return xchacha20poly1305(key, nonce, aad).decrypt(ct);
}
