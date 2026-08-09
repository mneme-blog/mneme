// Run every repro/regression script that needs no external service — the same
// set CI runs on every PR (`pnpm --filter client check`). The relay-dependent
// scripts (integration, templates-roundtrip, interview-types-roundtrip,
// journal-sync-roundtrip, ai-roundtrip) need `docker compose up -d` and stay
// manual, as does film-e2e.mjs (real Chrome + WebCodecs).
//
// Keep this list in sync when adding a script: a check that exists but runs
// nowhere is documentation, not enforcement.
import { spawnSync } from 'node:child_process';

const SCRIPTS = [
  // security-relevant regressions first — fail fast on what matters most
  'record-codec', // wire-codec field mapping (silent LWW field loss)
  'record-binding', // AAD record binding (audit M2)
  'seedlock-methods', // at-rest seals (Argon2id / PRF)
  'link-safety', // href allowlist (audit M1, #42)
  'ollama-url', // privacy-badge URL classification (audit L4, #49)
  'transcribe-repro', // transcription gating incl. CSP + same-origin default
  // feature regressions
  'badges-repro',
  'dayone-import',
  'dayone-import-persist',
  'i18n-dump',
  'interview-title',
  'labbook-repro',
  'location-repro',
  'markdown-editor-smoke',
  'markdown-roundtrip',
  'math-click-repro',
  'video-interview-repro',
];

let failed = 0;
for (const name of SCRIPTS) {
  console.log(`\n━━ ${name} ━━`);
  const r = spawnSync('pnpm', ['exec', 'tsx', `scripts/${name}.ts`], {
    stdio: 'inherit',
    cwd: new URL('..', import.meta.url).pathname,
  });
  if (r.status !== 0) {
    failed++;
    console.error(`✗ ${name} FAILED (exit ${r.status})`);
  }
}

console.log(failed === 0 ? `\nAll ${SCRIPTS.length} checks passed.` : `\n${failed}/${SCRIPTS.length} checks FAILED.`);
process.exit(failed === 0 ? 0 : 1);
