// Regression check for Ollama base-URL classification (audit finding L4,
// issue #49). The backend is badged "stays on this device", but baseUrl is free
// text used verbatim to POST decrypted journal excerpts, AND AI settings sync
// across the vault's devices — so a value typed on one device decides where
// another one ships plaintext. The label must never be able to lie.
// Run: pnpm --filter client exec tsx scripts/ollama-url.ts
import { normalizeOllamaUrl, ollamaScope, resolveOllamaUrl } from '../src/ai/ollamaUrl';
import { DEFAULT_OLLAMA_URL } from '../src/ai/types';

let failures = 0;
function check(label: string, ok: boolean): void {
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${label}`);
  } else {
    console.log(`  ok    ${label}`);
  }
}

const CASES: [string, ReturnType<typeof ollamaScope>][] = [
  // Genuinely on this device.
  ['http://localhost:11434', 'loopback'],
  ['http://127.0.0.1:11434', 'loopback'],
  ['http://127.2.3.4:11434', 'loopback'],
  ['http://[::1]:11434', 'loopback'],
  ['https://localhost:11434/', 'loopback'],
  ['  http://localhost:11434///  ', 'loopback'],
  // On the network — plaintext leaves this device.
  ['http://192.168.1.50:11434', 'private'],
  ['http://10.0.0.9:11434', 'private'],
  ['http://172.16.4.4:11434', 'private'],
  ['http://172.31.4.4:11434', 'private'],
  ['http://nas.local:11434', 'private'],
  ['http://box.internal:11434', 'private'],
  // Off the network entirely.
  ['http://ollama.example.com:11434', 'remote'],
  ['https://8.8.8.8:11434', 'remote'],
  // 172.32 is NOT in the private range — a classic off-by-one in these checks.
  ['http://172.32.0.1:11434', 'remote'],
  // Not usable at all.
  ['', 'invalid'],
  ['   ', 'invalid'],
  ['not a url', 'invalid'],
  ['file:///etc/passwd', 'invalid'],
  ['javascript:alert(1)', 'invalid'],
  ['ftp://example.com', 'invalid'],
];

console.log('ollamaScope classifies each address');
for (const [raw, want] of CASES) {
  const got = ollamaScope(raw);
  check(`${JSON.stringify(raw)} → ${want}${got === want ? '' : ` (got ${got})`}`, got === want);
}

console.log('\nnormalizeOllamaUrl strips whitespace and trailing slashes');
check('trailing slashes', normalizeOllamaUrl('http://localhost:11434///') === 'http://localhost:11434');
check('surrounding space', normalizeOllamaUrl('  http://localhost:11434  ') === 'http://localhost:11434');
check('path preserved', normalizeOllamaUrl('http://localhost:11434/api/v1') === 'http://localhost:11434/api/v1');
check('bad scheme rejected', normalizeOllamaUrl('file:///x') === null);

console.log('\nresolveOllamaUrl falls back to loopback rather than an unusable value');
check('empty → default', resolveOllamaUrl('') === DEFAULT_OLLAMA_URL);
check('garbage → default', resolveOllamaUrl('not a url') === DEFAULT_OLLAMA_URL);
check('valid passes through', resolveOllamaUrl('http://192.168.1.5:11434/') === 'http://192.168.1.5:11434');

console.log(failures === 0 ? '\nAll Ollama URL checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
