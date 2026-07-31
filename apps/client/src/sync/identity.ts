// Bootstrap a device session from a mnemonic: derive identity locally, then
// register + challenge-response authenticate against the relay.
import { deriveIdentity, signWithDevice, signWithOwner, type Identity } from '../crypto/keys';
import { mnemonicToSeed } from '../crypto/mnemonic';
import { toBase64, fromBase64 } from '../crypto/base64';
import { concat, utf8 } from '../crypto/bytes';
import { RelayError, type RelayClient } from './relay';

/**
 * The relay accepted the device but the operator has not approved this vault
 * (REQUIRE_APPROVAL). The identity is valid — the caller should show the
 * "pending approval" state (quoting identity.approvalHint) and retry later,
 * NOT treat this as a plain network failure.
 */
export class PendingApprovalError extends Error {
  constructor() {
    super('vault pending operator approval');
    this.name = 'PendingApprovalError';
  }
}

export interface Session {
  token: string;
  ownerId: string;
  deviceId: string;
  identity: Identity;
}

/** Local-only step: derive the full identity from the phrase. Never hits the network. */
export function identityFromMnemonic(mnemonic: string): Identity {
  return deriveIdentity(mnemonicToSeed(mnemonic));
}

const REGISTER_PREFIX = utf8('mneme:register:');
const BIND_PREFIX = utf8('mneme:bind-device:v1:');

/**
 * Network step: register the device and exchange a signed challenge for a token.
 *
 * Registration carries two signatures. The device signature proves possession of
 * the device key; the OWNER signature proves possession of the seed and is what
 * authorizes attaching this device to this vault. Trust-on-first-use now applies
 * only to creating a vault — joining an existing one requires the owner key, so
 * the owner *public* key (which is not a secret) no longer opens anything.
 */
export async function authenticate(relay: RelayClient, identity: Identity): Promise<Session> {
  const regMsg = concat(REGISTER_PREFIX, identity.ownerPub, identity.devicePub);
  const regSig = signWithDevice(identity.devicePriv, regMsg);
  const bindMsg = concat(BIND_PREFIX, identity.ownerPub, identity.ownerSignPub, identity.devicePub);
  const bindSig = signWithOwner(identity.ownerSignPriv, bindMsg);
  const { device_id, status } = await relay.register({
    ownerPubkey: toBase64(identity.ownerPub),
    devicePubkey: toBase64(identity.devicePub),
    signature: toBase64(regSig),
    ownerSignPubkey: toBase64(identity.ownerSignPub),
    ownerSignature: toBase64(bindSig),
    approvalHint: identity.approvalHint,
  });

  // Approval-gated relay: don't bother exchanging a challenge we can't complete —
  // surface pending straight away so the UI can show the approval screen.
  if (status && status !== 'approved') {
    throw new PendingApprovalError();
  }

  const { challenge } = await relay.challenge(device_id);
  const challengeSig = signWithDevice(identity.devicePriv, fromBase64(challenge));
  let verified;
  try {
    verified = await relay.verify(device_id, challenge, toBase64(challengeSig));
  } catch (e) {
    // A 403 here means the same thing (older relay without the register status
    // field, or an owner rejected between register and verify).
    if (e instanceof RelayError && e.status === 403) throw new PendingApprovalError();
    throw e;
  }

  return { token: verified.token, ownerId: verified.owner_id, deviceId: device_id, identity };
}
