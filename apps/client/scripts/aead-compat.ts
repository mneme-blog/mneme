// Ciphertext compatibility for the entry AEAD (CLAUDE.md §3/§6).
//
// Why this exists: `crypto/aead.ts` is the single chokepoint through which every
// entry, template, journal, interview type, AI-settings blob, media chunk and
// at-rest seed seal is encrypted. If a dependency bump ever changed the bytes it
// produces, nothing would fail loudly — new writes would work fine and *every
// existing vault would stop opening*, with the relay holding the only copy of
// data no one can decrypt any more. There is no admin recovery path by design.
//
// So the vectors below are frozen: they were produced by @noble/ciphers 1.3.0,
// the version the first vaults were written with, and are checked against
// whatever version is installed today. They are plain XChaCha20-Poly1305, so
// they should hold across any conforming implementation — that is the point.
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { encrypt, decrypt } from '../src/crypto/aead';

const key = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const nonce = Uint8Array.from({ length: 24 }, (_, i) => 200 - i);
const message = 'the mnemonic is the account';
const pt = new TextEncoder().encode(message);
const aad = new TextEncoder().encode('mneme:record:v1:abc123');

// Frozen output of @noble/ciphers 1.3.0 for (key, nonce, pt[, aad]) above.
const V1_NO_AAD = '4ab117c21a63cefddff6112acea300912b0415ed63ea6333e0998f351a838e4c0e82892de563bc31f9619e';
const V1_WITH_AAD = '4ab117c21a63cefddff6112acea300912b0415ed63ea6333e0998ffdd08e3f39e72ccc166d60c9ecddd99e';

const hex = (u8: Uint8Array): string => Buffer.from(u8).toString('hex');
const fromHex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'hex'));

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (Object.is(got, want)) {
    console.log(`ok: ${name}`);
    return;
  }
  failed++;
  console.error(`FAIL: ${name}\n  got  ${String(got)}\n  want ${String(want)}`);
}

// 1. The primitive still produces the same bytes for the same inputs.
check('primitive matches frozen v1 bytes (no AAD)', hex(xchacha20poly1305(key, nonce).encrypt(pt)), V1_NO_AAD);
check('primitive matches frozen v1 bytes (with AAD)', hex(xchacha20poly1305(key, nonce, aad).encrypt(pt)), V1_WITH_AAD);

// 2. A blob in the stored envelope — [version:1B][nonce:24B][ct+tag] — written
//    by an old client still opens through the real decrypt() every path calls.
const legacyBlob = new Uint8Array(1 + 24 + V1_WITH_AAD.length / 2);
legacyBlob[0] = 0x01;
legacyBlob.set(nonce, 1);
legacyBlob.set(fromHex(V1_WITH_AAD), 25);
check('decrypt() opens a blob written by the old library', new TextDecoder().decode(decrypt(key, legacyBlob, aad)), message);

// 3. The envelope's own invariants.
const blob = encrypt(key, pt, aad);
check('envelope version byte', blob[0], 0x01);
check('envelope length = 1 + 24 + ct+tag', blob.length, 1 + 24 + pt.length + 16);
check('round-trip', new TextDecoder().decode(decrypt(key, blob, aad)), message);

// Two encryptions of the same plaintext must differ — the nonce is random, and a
// repeat would mean it is not.
check('nonce is not reused', hex(encrypt(key, pt, aad)) === hex(encrypt(key, pt, aad)), false);

// 4. The record binding (second-audit finding M2) still holds: a ciphertext must
//    not open under another record's AAD, or the relay could swap records.
let wrongAadRejected = false;
try {
  decrypt(key, blob, new TextEncoder().encode('mneme:record:v1:someoneelse'));
} catch {
  wrongAadRejected = true;
}
check('wrong AAD is rejected', wrongAadRejected, true);

let missingAadRejected = false;
try {
  decrypt(key, blob);
} catch {
  missingAadRejected = true;
}
check('missing AAD is rejected', missingAadRejected, true);

let tamperRejected = false;
try {
  const t = encrypt(key, pt, aad);
  t[t.length - 1] ^= 0x01;
  decrypt(key, t, aad);
} catch {
  tamperRejected = true;
}
check('tampered tag is rejected', tamperRejected, true);

let versionRejected = false;
try {
  const t = encrypt(key, pt, aad);
  t[0] = 0x02;
  decrypt(key, t, aad);
} catch {
  versionRejected = true;
}
check('unknown version byte is rejected', versionRejected, true);

let shortRejected = false;
try {
  decrypt(key, new Uint8Array(10), aad);
} catch {
  shortRejected = true;
}
check('truncated blob is rejected', shortRejected, true);

console.log(failed === 0 ? '\nall aead compatibility checks passed' : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
