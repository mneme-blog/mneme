// Regression check for recording transcription (ai/transcribe.ts):
//
//  - the config gate: every "Transcribe" affordance hangs off
//    transcriptionConfig() being non-null, so a disabled assistant, a missing
//    record, an empty URL, or an unusable URL must all read as "off" — there is
//    deliberately no fallback URL for a speech endpoint.
//  - the wire shape: OpenAI-style multipart POST to /v1/audio/transcriptions,
//    bearer auth only when a key is set, filename extension derived from the
//    blob's mime (whisper servers sniff the container from it), and the error
//    mapping (401/403 → auth, other non-2xx and malformed bodies → network).
//  - the storage contract: transcripts ride inside the encrypted body (media
//    node attrs / video-interview cards) and docToText surfaces them, which is
//    what makes them reachable by search, previews, and Ask-my-journal; a
//    video-interview card keeps its transcript when the source clips are
//    dropped, and coercion round-trips it.
//  - the CSP: loopback whisper servers on any port are reachable in the
//    production policy; anything else still needs CSP_CONNECT_EXTRA.
//
// Run: pnpm --filter client exec tsx scripts/transcribe-repro.ts
import { transcribe, transcriptionConfig, transcriptionEndpoint, transcriptionLocal } from '../src/ai/transcribe';
import { AiError, defaultAiSettings, type AiSettings } from '../src/ai/types';
import { docToText } from '../src/editor/doc';
import { coerceVideoInterview } from '../src/editor/videointerviewData';
// eslint-disable-next-line no-restricted-imports
import { policy } from '../csp.js';

let failures = 0;
function check(label: string, ok: boolean): void {
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${label}`);
  } else {
    console.log(`  ok    ${label}`);
  }
}

function settings(patch: Partial<AiSettings>): AiSettings {
  return { ...defaultAiSettings(), enabled: true, ...patch };
}

// ── the config gate ──
check('null settings → off', transcriptionConfig(null) === null);
check('assistant disabled → off', transcriptionConfig({ ...settings({}), enabled: false }) === null);
check('no transcription record (pre-feature seal) → off', transcriptionConfig(settings({ transcription: undefined })) === null);
check('empty URL → off', transcriptionConfig(settings({ transcription: { baseUrl: '', apiKey: '', model: '' } })) === null);
check('garbage URL → off', transcriptionConfig(settings({ transcription: { baseUrl: 'not a url', apiKey: '', model: '' } })) === null);
check('file: URL → off', transcriptionConfig(settings({ transcription: { baseUrl: 'file:///etc', apiKey: '', model: '' } })) === null);

const cfg = transcriptionConfig(settings({ transcription: { baseUrl: 'http://localhost:8000///', apiKey: 'k', model: '  ' } }));
check('loopback URL → configured', cfg !== null);
check('trailing slashes normalized', cfg?.baseUrl === 'http://localhost:8000');
check('blank model falls back to default', cfg?.model === 'whisper-1');
check('loopback classified local', cfg !== null && transcriptionLocal(cfg));
const cloud = transcriptionConfig(settings({ transcription: { baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'whisper-1' } }));
check('cloud endpoint not local', cloud !== null && !transcriptionLocal(cloud));

// ── endpoint building ──
check('bare origin gets /v1 path', transcriptionEndpoint('http://localhost:8000') === 'http://localhost:8000/v1/audio/transcriptions');
check('…/v1 base completes', transcriptionEndpoint('https://api.openai.com/v1') === 'https://api.openai.com/v1/audio/transcriptions');
check('full path passes through', transcriptionEndpoint('http://localhost:9000/v1/audio/transcriptions') === 'http://localhost:9000/v1/audio/transcriptions');

// ── the wire shape, against a mocked fetch ──
type Captured = { url: string; auth: string | undefined; file: File; model: string };
let captured: Captured | null = null;
let respond: () => Response = () => new Response(JSON.stringify({ text: '  hello from the clip  ' }), { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const form = init?.body as FormData;
  captured = {
    url: String(input),
    auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
    file: form.get('file') as File,
    model: String(form.get('model')),
  };
  return respond();
}) as typeof fetch;

try {
  const goodCfg = { baseUrl: 'http://localhost:8000', apiKey: 'sk-test', model: 'whisper-1' };
  const text = await transcribe(goodCfg, new Blob(['x'], { type: 'video/webm;codecs=vp8,opus' }));
  check('resolves trimmed transcript', text === 'hello from the clip');
  check('POSTs the /v1/audio/transcriptions endpoint', captured!.url === 'http://localhost:8000/v1/audio/transcriptions');
  check('bearer auth when a key is set', captured!.auth === 'Bearer sk-test');
  check('model field carried', captured!.model === 'whisper-1');
  check('codec-suffixed webm mime → .webm filename', captured!.file.name === 'recording.webm');

  await transcribe({ ...goodCfg, apiKey: '' }, new Blob(['x'], { type: 'audio/mpeg' }));
  check('no auth header without a key', captured!.auth === undefined);
  check('mp3 mime → .mp3 filename', captured!.file.name === 'recording.mp3');

  respond = () => new Response('nope', { status: 401 });
  const authErr = await transcribe(goodCfg, new Blob(['x'])).then(() => null, (e: unknown) => e);
  check('401 → AiError auth', authErr instanceof AiError && authErr.hint === 'auth');

  respond = () => new Response('boom', { status: 500 });
  const netErr = await transcribe(goodCfg, new Blob(['x'])).then(() => null, (e: unknown) => e);
  check('500 → AiError network', netErr instanceof AiError && netErr.hint === 'network');

  respond = () => new Response('{"nope":1}', { status: 200 });
  const shapeErr = await transcribe(goodCfg, new Blob(['x'])).then(() => null, (e: unknown) => e);
  check('missing text field → AiError network', shapeErr instanceof AiError && shapeErr.hint === 'network');
} finally {
  globalThis.fetch = realFetch;
}

// ── storage contract: docToText surfaces transcripts ──
const mediaDoc = {
  type: 'doc',
  content: [
    { type: 'mediaAttachment', attrs: { id: 'm1', kind: 'video', mime: 'video/webm', bytes: 9, createdAt: 1, transcript: 'today I planted the tomatoes' } },
    { type: 'mediaAttachment', attrs: { id: 'm2', kind: 'audio', mime: 'audio/webm', bytes: 9, createdAt: 1 } },
  ],
};
const mediaText = docToText(mediaDoc);
check('media transcript is searchable text', mediaText.includes('today I planted the tomatoes'));
check('untranscribed media keeps its bare marker', mediaText.includes('🎙 audio'));

const interviewDoc = {
  type: 'doc',
  content: [
    {
      type: 'videoInterview',
      attrs: {
        sessionId: 's1',
        typeName: 'Daily check-in',
        cards: [
          { q: 'How was your day?', clip: null, transcript: 'it was a long but good day' },
          { q: 'What is on your mind?', clip: null },
        ],
        film: null,
        renderedAt: null,
      },
    },
  ],
};
const interviewText = docToText(interviewDoc);
check('interview question still surfaces', interviewText.includes('How was your day?'));
check('interview answer transcript surfaces', interviewText.includes('it was a long but good day'));

// ── storage contract: coercion round-trips, and clip-drop keeps the text ──
const coerced = coerceVideoInterview(interviewDoc.content[0].attrs as Record<string, unknown>);
check('coerce keeps the card transcript', coerced?.cards[0].transcript === 'it was a long but good day');
check('coerce leaves absent transcript undefined', coerced?.cards[1].transcript === undefined);
// What the node view writes when dropping clips: clip nulled, transcript kept.
const dropped = coerceVideoInterview({
  ...interviewDoc.content[0].attrs,
  cards: coerced!.cards.map((c) => ({ q: c.q, clip: null, transcript: c.transcript })),
} as Record<string, unknown>);
check('dropping clips keeps the transcript', dropped?.cards[0].transcript === 'it was a long but good day');

// ── CSP: loopback whisper on any port is reachable in production ──
const csp = policy();
check('CSP allows loopback any-port', csp.includes('http://localhost:*') && csp.includes('http://127.0.0.1:*'));
check('CSP still pins Ollama entries', csp.includes('http://localhost:11434'));

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
