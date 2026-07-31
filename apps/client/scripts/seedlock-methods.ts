// Regression check for the sealed-seed record union (no browser, no relay):
//   1. v:1 Argon2id seal → open roundtrip (wrong passphrase must throw).
//   2. v:2 PRF seal → open roundtrip with a fake 32-byte secret (the real one
//      comes from a WebAuthn ceremony, which can't run under tsx).
//   3. sealWithKey over both WrapKey arms reproduces openable records — the
//      phrase-rotation re-seal path.
//   4. Cross-version pinning: a v:1 record must not open via the PRF path and
//      vice versa, and swapping a v:2 blob into a v:1 record must fail the AAD.
//   5. Legacy KDF params still open. Cost lives in the record, not in the code,
//      which is what makes raising DEFAULT_KDF safe — a seal written by an
//      older build must keep opening with the params it was written with.
// Run: pnpm --filter client exec tsx scripts/seedlock-methods.ts
import {
  DEFAULT_KDF,
  sealSeed,
  openSeed,
  sealSeedWithPrfSecret,
  openSeedWithPrfSecret,
  sealWithKey,
  isSealedSeed,
  type SealedSeedArgon2,
} from '../src/crypto/seedlock';
import { randomBytes, utf8 } from '../src/crypto/bytes';
import { encrypt } from '../src/crypto/aead';
import { argon2idAsync } from '@noble/hashes/argon2';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

const seed = randomBytes(64);
const seed2 = randomBytes(64);

// ── 1. v:1 Argon2id roundtrip ───────────────────────────────
const pass = 'correct horse battery staple';
const a = await sealSeed(seed, pass);
if (a.record.v !== 1) fail('argon2 seal did not produce a v:1 record');
if (a.record.blob[0] !== 0x01) fail('v:1 blob is missing the aead version byte');
if (!isSealedSeed(a.record)) fail('isSealedSeed rejected a v:1 record');
const aOpen = await openSeed(a.record, pass);
if (!eq(aOpen.seed, seed)) fail('v:1 roundtrip returned a different seed');
let threw = false;
try {
  await openSeed(a.record, 'wrong passphrase entirely');
} catch {
  threw = true;
}
if (!threw) fail('wrong passphrase opened a v:1 record');
console.log('OK  v:1 argon2 seal/open roundtrip');

// ── 2. v:2 PRF roundtrip ────────────────────────────────────
const secret = randomBytes(32);
const meta = { credentialId: randomBytes(24), prfSalt: randomBytes(32), rpId: 'localhost' };
const p = sealSeedWithPrfSecret(secret, meta, seed);
if (p.record.v !== 2 || p.record.method !== 'prf') fail('prf seal did not produce a v:2/prf record');
if (p.record.blob[0] !== 0x01) fail('v:2 blob is missing the aead version byte');
if (!isSealedSeed(p.record)) fail('isSealedSeed rejected a v:2 record');
if (!eq(p.record.credentialId, meta.credentialId) || !eq(p.record.prfSalt, meta.prfSalt)) fail('v:2 record lost its credential metadata');
const pOpen = openSeedWithPrfSecret(p.record, secret);
if (!eq(pOpen.seed, seed)) fail('v:2 roundtrip returned a different seed');
threw = false;
try {
  openSeedWithPrfSecret(p.record, randomBytes(32));
} catch {
  threw = true;
}
if (!threw) fail('a wrong PRF secret opened a v:2 record');
console.log('OK  v:2 prf seal/open roundtrip');

// ── 3. sealWithKey over both arms (rotation re-seal) ────────
const aRe = sealWithKey(aOpen.wrap, seed2);
if (aRe.v !== 1) fail('argon2 wrap re-seal changed the record version');
if (!eq((await openSeed(aRe, pass)).seed, seed2)) fail('argon2 re-seal did not open with the same passphrase');
const pRe = sealWithKey(pOpen.wrap, seed2);
if (pRe.v !== 2) fail('prf wrap re-seal changed the record version');
if (!eq(openSeedWithPrfSecret(pRe, secret).seed, seed2)) fail('prf re-seal did not open with the same secret');
console.log('OK  sealWithKey re-seal for both methods');

// ── 4. cross-version / AAD pinning ──────────────────────────
threw = false;
try {
  openSeedWithPrfSecret(a.record, secret);
} catch {
  threw = true;
}
if (!threw) fail('a v:1 record opened through the PRF path');
threw = false;
try {
  await openSeed(p.record, pass);
} catch {
  threw = true;
}
if (!threw) fail('a v:2 record opened through the passphrase path');
// Same wrap key, blob transplanted across record kinds → the per-method AAD
// must reject it even though the key would match.
const transplant: SealedSeedArgon2 = { v: 1, salt: randomBytes(16), kdf: { t: 3, m: 64 * 1024, p: 1 }, blob: p.record.blob };
threw = false;
try {
  // Decrypt with the *PRF* wrap key but the v:1 AAD path via a hand-rolled open:
  // openSeed would derive an argon2 key anyway, so exercise the AAD directly.
  const { decrypt } = await import('../src/crypto/aead');
  const { utf8 } = await import('../src/crypto/bytes');
  decrypt(pOpen.wrap.key, transplant.blob, utf8('mneme:seedlock:v1'));
} catch {
  threw = true;
}
if (!threw) fail('a v:2 blob decrypted under the v:1 AAD');
console.log('OK  cross-version and AAD pinning');



// ── 5. A seal written with the pre-#45 params must still open ───────────────
// Hand-build a record the way the old build would have, then open it with
// today's code. If this ever fails, raising DEFAULT_KDF locked people out.
const LEGACY_KDF = { t: 3, m: 64 * 1024, p: 1 };
const legacySalt = randomBytes(16);
const legacyKey = await argon2idAsync(utf8(pass.normalize('NFKD')), legacySalt, {
  ...LEGACY_KDF,
  dkLen: 32,
});
const legacyRecord: SealedSeedArgon2 = {
  v: 1,
  salt: legacySalt,
  kdf: LEGACY_KDF,
  blob: encrypt(legacyKey, seed, utf8('mneme:seedlock:v1')),
};
const legacyOpen = await openSeed(legacyRecord, pass);
if (!eq(legacyOpen.seed, seed)) fail('a legacy-params seal did not open');
if (legacyOpen.wrap.method !== 'argon2' || legacyOpen.wrap.kdf.m !== LEGACY_KDF.m) {
  fail('opening a legacy record did not carry its own params back');
}
// And a fresh seal must use the raised cost, not the legacy one.
const fresh = await sealSeed(seed, pass);
if (fresh.record.v !== 1 || fresh.record.kdf.m !== DEFAULT_KDF.m || fresh.record.kdf.t !== DEFAULT_KDF.t) {
  fail('a new seal did not use DEFAULT_KDF');
}
if (DEFAULT_KDF.m <= LEGACY_KDF.m) fail('DEFAULT_KDF memory cost was not raised');
console.log('OK  legacy-params seal still opens; new seals use the raised cost');

console.log('\nseedlock-methods: all checks passed');
