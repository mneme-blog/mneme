// Hand-written declarations for csp.js (kept as plain JS so vite.config.ts and
// the Caddyfile-generation script can consume it without a build step).
export const EGRESS: Record<string, readonly string[]>;
export function policy(opts?: { connectExtra?: string[]; frameAncestors?: boolean }): string;
