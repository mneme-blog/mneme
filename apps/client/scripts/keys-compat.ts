// Key-derivation compatibility (CLAUDE.md §6).
//
// Why this exists: `crypto/keys.ts` turns the mnemonic into everything the vault
// is addressed and encrypted by — dataKey, mediaKey, aiKey, the X25519 owner key
// the relay knows as ownerId, and the Ed25519 keys that authorize device binding.
// It is to identity what `crypto/aead.ts` is to content, and it fails the same
// silent way: if a dependency bump changed the derived bytes, a new install would
// look healthy while every existing vault would resolve to a *different owner* —
// signing in with the right mnemonic and finding an empty journal, with the relay
// holding blobs whose key no longer exists. There is no admin recovery path.
//
// So the vectors below are frozen: they were produced by @noble/curves 1.9.7 /
// @noble/hashes 1.8.0 / @scure/bip39 1.6.0 — the versions the first vaults were
// written with — and are checked against whatever is installed today. They are
// plain BIP39 / HKDF-SHA256 / X25519 / Ed25519, so they should hold across any
// conforming implementation; that is the point.
import { deriveIdentity, deriveApprovalHint, signWithDevice, signWithOwner } from '../src/crypto/keys';
import { mnemonicToSeed, validateMnemonic, generateMnemonic } from '../src/crypto/mnemonic';

// A BIP39 test-vector phrase, never a real one.
const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

const FROZEN = {
  seed: '878386efb78845b3355bd15ea4d39ef97d179cb712b77d5c12b6be415fffeffe5f377ba02bf3f8544ab800b955e51fbff09828f682052a20faa6addbbddfb096',
  dataKey: 'eee1f4a9449984a5e076dc4150bbbd36f831722b153cfaa3cb923daad89c6ddf',
  mediaKey: 'b41b5d40e878b9920d260cfd9b448ea258842e89e373f18f87bbff5ca9af0c28',
  aiKey: 'a721209ff72a1957dd5298df4e7dcf9c6774a76d3e3d721ece2ebe5fb3c9eb69',
  ownerPub: '0e5ed7ed7657c93535c68390f9f7f925cad890f4689c1f41e008be22c2333a18',
  ownerSignPub: '61a9695605b68b10adc54fd3cb17c8e3018efddea23b4e13bfda6366f6c9ff16',
  devicePub: '23548ea457780cddecb29256b15a347d0a577e0ff42955d4e9a0632d70ee31fc',
  // base64url(sha256(ownerPub)) — the id the relay scopes every row by.
  ownerId: 'uTfd3b1JJNrAoOG-MguEFe8yqPom5moSIiPoTTQ43bg',
  approvalHint: 'spry-bison-36',
  // Ed25519 is deterministic (RFC 8032), so signatures are frozen too.
  sigDevice:
    '69ca8fb34bf70a265866a62a728d2fecec2694c11652e57c91691800f7398acc34e35217e7cf8c23cd7ed810031e11b4b7a445cedb9947072a4ebcbf809da106',
  sigOwner:
    'f2876985da0adde8ee7c2dbef28a2829f5e5971e2820848c80294f6b7e8904b5d98dd51192a0b437de2680e5aa3db8dce6754e997b570130672fc22c4b4ec702',
};

const MESSAGE = new TextEncoder().encode('mneme:bind-device:v1:test-message');

const hex = (u8: Uint8Array): string => Buffer.from(u8).toString('hex');

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (Object.is(got, want)) {
    console.log(`ok: ${name}`);
    return;
  }
  failed++;
  console.error(`FAIL: ${name}\n  got  ${String(got)}\n  want ${String(want)}`);
}

// 1. BIP39 still turns the phrase into the same seed.
const seed = mnemonicToSeed(MNEMONIC);
check('bip39 seed', hex(seed), FROZEN.seed);
check('mnemonic validates', validateMnemonic(MNEMONIC), true);
check('generated phrase is 12 words', generateMnemonic().split(' ').length, 12);
check('generated phrase validates', validateMnemonic(generateMnemonic()), true);

// 2. HKDF still derives the same content keys. A change here orphans every blob.
const id = deriveIdentity(seed);
check('dataKey', hex(id.dataKey), FROZEN.dataKey);
check('mediaKey', hex(id.mediaKey), FROZEN.mediaKey);
check('aiKey', hex(id.aiKey), FROZEN.aiKey);

// 3. The identity keys still address the same owner on the relay.
check('ownerPub (X25519)', hex(id.ownerPub), FROZEN.ownerPub);
check('ownerId', id.ownerId, FROZEN.ownerId);
check('ownerSignPub (Ed25519)', hex(id.ownerSignPub), FROZEN.ownerSignPub);
check('devicePub (Ed25519)', hex(id.devicePub), FROZEN.devicePub);
check('approvalHint', id.approvalHint, FROZEN.approvalHint);
check('approvalHint is a pure function of the seed', deriveApprovalHint(seed), id.approvalHint);

// 4. Signatures still verify against a relay that pinned the old public key.
check('device signature', hex(signWithDevice(id.devicePriv, MESSAGE)), FROZEN.sigDevice);
check('owner binding signature', hex(signWithOwner(id.ownerSignPriv, MESSAGE)), FROZEN.sigOwner);

// 5. Derivation is deterministic and domain-separated: same seed → same identity,
// and no two labels ever collide onto the same key material.
const again = deriveIdentity(mnemonicToSeed(MNEMONIC));
check('deterministic across calls', again.ownerId, id.ownerId);
const keys = [id.dataKey, id.mediaKey, id.aiKey, id.ownerSignPriv, id.devicePriv].map(hex);
check('HKDF labels are domain-separated', new Set(keys).size, keys.length);

console.log(failed === 0 ? '\nAll key-derivation compatibility checks passed.' : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
