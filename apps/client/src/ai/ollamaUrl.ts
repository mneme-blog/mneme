// Validation for the Ollama server URL.
//
// The Ollama backend is badged "on this device" and its privacy copy says
// nothing leaves the device. But `baseUrl` is free text, it is used verbatim to
// POST decrypted journal excerpts, and AI settings SYNC across the vault's
// devices — so a value typed (or mistyped) on one device silently decides where
// another one ships plaintext, while the UI keeps claiming on-device. Nothing
// here is an SSRF boundary (it is the user's own browser reaching the user's own
// network); the point is that the label must not be able to lie.
import { DEFAULT_OLLAMA_URL } from './types';

/**
 * Where an Ollama URL actually points, from the user's perspective:
 *  - `loopback` — this device. What the "on this device" badge claims.
 *  - `private`  — another machine on the local network. Plaintext leaves this
 *                 device, usually unencrypted (Ollama speaks plain HTTP).
 *  - `remote`   — anything else. Plaintext leaves the network entirely.
 *  - `invalid`  — not a usable http(s) URL.
 */
export type OllamaScope = 'loopback' | 'private' | 'remote' | 'invalid';

// A full dotted-quad literal. The range checks below must only ever run against
// actual IP literals: DNS labels may be numeric ("10.example.net") or start with
// hex that looks like an IPv6 prefix ("fdroid.example.com"), and a prefix match
// against a *name* would hand a remote host the softer "local network" copy.
const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;
const PRIVATE_V4 =
  /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** Trim, drop trailing slashes, and reject anything that isn't an http(s) URL. */
export function normalizeOllamaUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  // Only http(s): the request is a fetch(), so a file:/data: URL is nonsense
  // here, and allowing an arbitrary scheme through is how odd things start.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''));
}

/** Classify a raw (not necessarily normalized) URL. */
export function ollamaScope(raw: string): OllamaScope {
  const normalized = normalizeOllamaUrl(raw);
  if (normalized === null) return 'invalid';
  const host = new URL(normalized).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isV4 = IPV4_LITERAL.test(host);
  // An IPv6 literal always contains ':' after the brackets are stripped; a DNS
  // name never does.
  const isV6 = host.includes(':');

  if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || (isV4 && host.startsWith('127.'))) {
    return 'loopback';
  }
  if (isV4 && PRIVATE_V4.test(host)) return 'private';
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (isV6 && (/^f[cd]/.test(host) || host.startsWith('fe80:'))) return 'private';
  // mDNS names resolve on the LAN only.
  if (host.endsWith('.local') || host.endsWith('.home.arpa') || host.endsWith('.internal')) {
    return 'private';
  }
  return 'remote';
}

/**
 * The URL the provider should actually use. Falls back to the loopback default
 * rather than to whatever unusable string was stored, so a typo degrades to
 * "Ollama isn't reachable" instead of "requests go somewhere unintended".
 */
export function resolveOllamaUrl(raw: string): string {
  return normalizeOllamaUrl(raw) ?? DEFAULT_OLLAMA_URL;
}

/** The host shown in settings, so the effective destination is never implicit. */
export function ollamaHostLabel(raw: string): string {
  const normalized = normalizeOllamaUrl(raw);
  return normalized === null ? DEFAULT_OLLAMA_URL : normalized;
}
