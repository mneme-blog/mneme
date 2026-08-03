// The app's Content-Security-Policy — one definition, two consumers.
//
// CLAUDE.md §6 names "strict CSP against XSS" as the mitigation that makes the
// unavoidable in-memory key exposure acceptable: the seed and every key derived
// from it live in JS memory while the vault is unlocked, so any script injection
// can read them *and* all plaintext, unrecoverably (the mnemonic is the only
// recovery anchor). This file is that mitigation.
//
// Consumers:
//   • apps/client/vite.config.ts injects `policy()` as a <meta http-equiv> into
//     the production build, so the policy travels with the artifact no matter
//     who hosts it.
//   • deploy/web/Caddyfile sends it as a response header (authoritative — a
//     header cannot be stripped by markup injected before the meta tag, and it
//     is the only place `frame-ancestors` is honoured).
//
// Both are enforced when both are present; browsers intersect multiple policies,
// so keeping them identical is what stops the effective policy from drifting
// tighter than intended. `pnpm --filter client csp` prints the current string —
// use it when updating the Caddyfile.
//
// Plain JS (not TS) so the Caddy-snippet generator can run it with bare node.

/** Origins the app legitimately talks to, beyond its own. */
export const EGRESS = {
  /** BYO-key AI backend — browser → Anthropic directly, never via the relay. */
  anthropic: 'https://api.anthropic.com',
  /** Address search when inserting a location (the one per-insert leak). */
  nominatim: 'https://nominatim.openstreetmap.org',
  /** Map tiles, fetched once at insert time and then stored encrypted. */
  tiles: 'https://tile.openstreetmap.org',
  /**
   * Local Ollama. Loopback only, matching the validation in src/ai/ollama.ts:
   * a LAN or remote Ollama host needs an explicit connect-src extension, which
   * is deliberate — the UI calls that backend "on this device".
   */
  ollama: ['http://localhost:11434', 'http://127.0.0.1:11434'],
  /**
   * Local speech-to-text servers for the transcription setting (ai/transcribe.ts).
   * Wildcard PORT, loopback HOST only: whisper servers have no canonical port
   * (faster-whisper/Speaches, whisper.cpp, LocalAI all default differently), and
   * a loopback port wildcard adds no cross-origin egress an attacker could
   * exfiltrate to — it reaches only services on the user's own machine. A LAN or
   * cloud endpoint still needs CSP_CONNECT_EXTRA, deliberately.
   */
  whisper: ['http://localhost:*', 'http://127.0.0.1:*'],
};

/**
 * Build the policy.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.connectExtra] Extra connect-src origins. Needed when
 *   the relay is NOT same-origin (the standard Caddy deploy proxies /v1/* under
 *   the app's own origin, so 'self' covers it), or for a non-loopback Ollama.
 * @param {boolean} [opts.frameAncestors] Include frame-ancestors. Only
 *   meaningful in a response header — browsers ignore it in a <meta> policy.
 */
export function policy({ connectExtra = [], frameAncestors = false } = {}) {
  const directives = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    // No <object>/<embed>, and no form posts anywhere: the app has neither.
    'object-src': ["'none'"],
    'form-action': ["'none'"],
    // 'wasm-unsafe-eval' is required by wa-sqlite: instantiating WebAssembly is
    // blocked by a bare script-src 'self'. It permits wasm compilation only —
    // NOT eval() or new Function() — so the XSS bar is unchanged.
    'script-src': ["'self'", "'wasm-unsafe-eval'"],
    // 'unsafe-inline' is load-bearing: the UI styles heavily via inline style
    // attributes and KaTeX emits inline styles. It weakens CSS injection
    // defence only — script execution stays fully locked down.
    'style-src': ["'self'", "'unsafe-inline'"],
    'font-src': ["'self'"],
    // blob:/data: are the decrypted media the client materialises locally.
    'img-src': ["'self'", 'blob:', 'data:', EGRESS.tiles],
    'media-src': ["'self'", 'blob:'],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'connect-src': [
      "'self'",
      'blob:',
      EGRESS.anthropic,
      EGRESS.nominatim,
      ...EGRESS.ollama,
      ...EGRESS.whisper,
      ...connectExtra,
    ],
  };
  if (frameAncestors) directives['frame-ancestors'] = ["'none'"];

  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}
