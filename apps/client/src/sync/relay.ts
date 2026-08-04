// Typed HTTP client for the Go relay. Binary fields are standard base64
// (the relay reads them as Go StdEncoding).

export interface RegisterReq {
  /** base64 X25519 owner public key. */
  ownerPubkey: string;
  /** base64 Ed25519 device public key. */
  devicePubkey: string;
  /** base64 device signature over "mneme:register:" ‖ ownerPub ‖ devicePub. */
  signature: string;
  /** base64 Ed25519 owner identity signing key. */
  ownerSignPubkey: string;
  /** base64 owner signature over "mneme:bind-device:v1:" ‖ ownerPub ‖ ownerSignPub ‖ devicePub. */
  ownerSignature: string;
  approvalHint?: string;
}
export interface RegisterResp {
  owner_id: string;
  device_id: string;
  /** 'approved' | 'pending' | 'rejected'. Absent on relays predating approval. */
  status?: string;
}
export interface ChallengeResp {
  challenge: string;
  expires_at: string;
}
export interface VerifyResp {
  token: string;
  owner_id: string;
  expires_at: string;
}
export interface PushEntry {
  entry_id: string;
  lww_clock: number;
  ciphertext: string; // base64
  deleted: boolean;
}
export interface PushResp {
  results: { entry_id: string; applied: boolean }[];
}
export interface PullItem {
  entry_id: string;
  lww_clock: number;
  ciphertext: string; // base64
  deleted: boolean;
  seq: number;
}
export interface PullResp {
  entries: PullItem[];
  cursor: number;
  more: boolean;
}
export interface MediaMeta {
  media_id: string;
  bytes: number; // total ciphertext bytes
  chunks: number;
}

export class RelayError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

export class RelayClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    // Requests are built by plain concatenation with an absolute path, so a
    // trailing slash in a user-entered base URL would yield "//v1/..." — the Go
    // mux 301s that to the cleaned path and browsers downgrade the POST to GET.
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  register(req: RegisterReq): Promise<RegisterResp> {
    return this.post('/v1/register', {
      owner_pubkey: req.ownerPubkey,
      device_pubkey: req.devicePubkey,
      signature: req.signature,
      // Authorizes binding this device to this owner. A relay older than the
      // H1 fix rejects unknown fields, so an outdated relay fails loudly at
      // sign-in rather than silently accepting an unauthorized binding.
      owner_sign_pubkey: req.ownerSignPubkey,
      owner_signature: req.ownerSignature,
      approval_hint: req.approvalHint ?? '',
    });
  }

  challenge(deviceId: string): Promise<ChallengeResp> {
    return this.post('/v1/auth/challenge', { device_id: deviceId });
  }

  verify(deviceId: string, challenge: string, signature: string): Promise<VerifyResp> {
    return this.post('/v1/auth/verify', { device_id: deviceId, challenge, signature });
  }

  push(token: string, entries: PushEntry[]): Promise<PushResp> {
    return this.post('/v1/sync/push', { entries }, token);
  }

  pull(token: string, since: number, limit = 500): Promise<PullResp> {
    return this.post('/v1/sync/pull', { since, limit }, token);
  }

  // ── media: server-relayed encrypted chunks (opaque to the relay) ──

  /** Upload one encrypted media chunk (raw octet-stream body). */
  async uploadMediaChunk(token: string, mediaId: string, index: number, chunk: Uint8Array): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/media/${mediaId}/chunks/${index}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token}` },
      body: chunk as unknown as BodyInit,
    });
    await this.check(res);
  }

  /** Finalize an upload so other devices can discover its chunk count. */
  completeMedia(token: string, mediaId: string, chunks: number, bytes: number): Promise<{ media_id: string }> {
    return this.post(`/v1/media/${mediaId}/complete`, { chunks, bytes }, token);
  }

  async mediaMeta(token: string, mediaId: string): Promise<MediaMeta> {
    const res = await fetch(`${this.baseUrl}/v1/media/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await this.check(res);
    return (await res.json()) as MediaMeta;
  }

  async downloadMediaChunk(token: string, mediaId: string, index: number): Promise<Uint8Array> {
    const res = await fetch(`${this.baseUrl}/v1/media/${mediaId}/chunks/${index}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await this.check(res);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Permanently delete one media object (index row + ciphertext chunks).
   * Idempotent on the relay, so the offline deletion queue can retry safely.
   */
  async deleteMedia(token: string, mediaId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/media/${mediaId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    await this.check(res);
  }

  /**
   * Permanently delete the authenticated owner and everything stored for it
   * (entries, media, reminders, devices, sessions). Used by phrase rotation
   * after the vault has been re-pushed under the new owner.
   */
  async deleteAccount(token: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/account`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    await this.check(res);
  }

  private async post<T>(path: string, body: unknown, token?: string): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    await this.check(res);
    return (await res.json()) as T;
  }

  /** Throw a RelayError (with the server's error message, if any) on a non-2xx response. */
  private async check(res: Response): Promise<void> {
    if (res.ok) return;
    let msg = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* non-JSON error body */
    }
    throw new RelayError(res.status, msg);
  }
}

// A self-hoster points the app at their own relay; under Tauri there is no
// dev-server origin to infer it from, so the URL is a runtime setting persisted
// here rather than only a build-time env var.
const RELAY_URL_KEY = 'mneme:relay-url';

/**
 * Canonicalize a user-entered relay URL: require an absolute http(s) URL and
 * strip trailing slashes. Returns null when the input can't name a relay — the
 * caller (the Preferences editor) uses that to reject the value with feedback
 * instead of persisting a string fetch() would resolve relative to the app origin.
 */
export function normalizeRelayUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * The user-set relay override, or null when unset or unusable.
 *
 * Re-normalized on READ, not only when the Preferences editor writes it. The key
 * lives in localStorage, which the app is not the only possible writer of — a
 * hostile page sharing the origin (docs/SECURITY.md §6.15), a value left by an
 * older build, a copied profile. Validating only at the write path means a
 * setting that decides where the whole vault gets pushed is trusted verbatim
 * wherever it came from. The payload is ciphertext either way, and the CSP's
 * `connect-src 'self'` blocks the fetch in the standard deployment — but neither
 * of those is a reason to hand an unvalidated string to fetch().
 */
export function getStoredRelayUrl(): string | null {
  try {
    const v = localStorage.getItem(RELAY_URL_KEY);
    return v ? normalizeRelayUrl(v) : null;
  } catch {
    return null;
  }
}

/** Persist the relay override, or clear it when passed null/empty. */
export function setStoredRelayUrl(url: string | null): void {
  try {
    if (url && url.trim()) localStorage.setItem(RELAY_URL_KEY, url.trim());
    else localStorage.removeItem(RELAY_URL_KEY);
  } catch {
    /* storage unavailable — the build-time default still applies */
  }
}

/** The compile-time default relay URL: VITE_RELAY_URL, else localhost:8080. */
export function buildDefaultRelayUrl(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_RELAY_URL ?? 'http://localhost:8080';
}

/** The relay base URL in effect: the stored user override, else the build default. */
export function resolveRelayUrl(): string {
  return getStoredRelayUrl() ?? buildDefaultRelayUrl();
}
