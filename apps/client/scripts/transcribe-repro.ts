// Regression check for recording transcription (ai/transcribe.ts):
//
//  - the config gate: every "Transcribe" affordance hangs off
//    transcriptionConfig() being non-null, so a disabled assistant, a missing
//    record, an empty URL, or an unusable URL must all read as "off" — there is
//    deliberately no fallback URL for a speech endpoint.
//  - the wire shape: OpenAI-style multipart POST to /v1/audio/transcriptions,
//    bearer auth only when a key is set, filename extension derived from the
//    blob's mime (whisper servers sniff the container from it), and the error
//    mapping (401/403 → auth, 404 → model, other non-2xx and malformed bodies
//    → network).
//  - the server check: a whisper server that has not downloaded the configured
//    model is reachable but 404s every transcription, so the settings sheet
//    asks the model listing and can install it. The 404 → 'model' mapping is
//    what turns an unactionable status code into that instruction.
//  - the storage contract: transcripts ride inside the encrypted body (media
//    node attrs / video-interview cards) and docToText surfaces them, which is
//    what makes them reachable by search, previews, and Ask-my-journal; a
//    video-interview card keeps its transcript when the source clips are
//    dropped, and coercion round-trips it.
//  - the CSP: loopback whisper servers on any port are reachable in the
//    production policy; anything else still needs CSP_CONNECT_EXTRA.
//
// Run: pnpm --filter client exec tsx scripts/transcribe-repro.ts
import {
  checkTranscription,
  installTranscriptionModel,
  resolveTranscriptionUrl,
  transcribe,
  transcriptionConfig,
  transcriptionDestination,
  transcriptionEndpoint,
  transcriptionInstallEndpoint,
  transcriptionModelsEndpoint,
  transcriptionLocal,
  languageName,
  SPOKEN_LANGUAGES,
} from '../src/ai/transcribe';
import { AiError, defaultAiSettings, DEFAULT_TRANSCRIPTION_MODEL, type AiSettings } from '../src/ai/types';
import { docToText } from '../src/editor/doc';
import { coerceVideoInterview, setTranscriptAttr } from '../src/editor/videointerviewData';
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
check('blank model falls back to default', cfg?.model === DEFAULT_TRANSCRIPTION_MODEL);
check('loopback classified local', cfg !== null && transcriptionLocal(cfg));
const cloud = transcriptionConfig(settings({ transcription: { baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'whisper-1' } }));
check('cloud endpoint not local', cloud !== null && !transcriptionLocal(cloud));
check('non-local destination flagged for the per-use confirm', cloud !== null && !transcriptionDestination(cloud).local);

// ── the bundled same-origin default (relative /whisper) ──
// Outside a browser there is no origin to resolve a path against — the
// default must read as OFF, not point somewhere made up.
check('relative path without an origin → off', resolveTranscriptionUrl('/whisper') === null);
check('default settings without an origin → off', transcriptionConfig(settings({ transcription: undefined })) === null);
// With an origin (the browser case), the absent field falls back to the
// bundled default and resolves same-origin — a stock deployment transcribes
// out of the box, and the app origin decides local vs not.
(globalThis as Record<string, unknown>).location = new URL('https://mneme.example/mneme/');
try {
  check('relative path resolves against the app origin', resolveTranscriptionUrl('/whisper') === 'https://mneme.example/whisper');
  const bundled = transcriptionConfig(settings({ transcription: undefined }));
  check('absent field → bundled default on', bundled !== null && bundled.baseUrl.startsWith('https://mneme.example/'));
  check('bundled default on a LAN host is NOT local (phones!)', bundled !== null && !transcriptionLocal(bundled));
  check('cleared URL still means off', transcriptionConfig(settings({ transcription: { baseUrl: '', apiKey: '', model: '' } })) === null);
} finally {
  delete (globalThis as Record<string, unknown>).location;
}

// ── endpoint building ──
check('bare origin gets /v1 path', transcriptionEndpoint('http://localhost:8000') === 'http://localhost:8000/v1/audio/transcriptions');
check('…/v1 base completes', transcriptionEndpoint('https://api.openai.com/v1') === 'https://api.openai.com/v1/audio/transcriptions');
check('full path passes through', transcriptionEndpoint('http://localhost:9000/v1/audio/transcriptions') === 'http://localhost:9000/v1/audio/transcriptions');
// The check/install endpoints share that root, whichever of the three forms
// the user stored — a base ending in /audio/transcriptions must not produce
// /v1/audio/transcriptions/models.
check('models listing from a bare origin', transcriptionModelsEndpoint('http://localhost:8000') === 'http://localhost:8000/v1/models');
check('models listing from a full path', transcriptionModelsEndpoint('http://localhost:8000/v1/audio/transcriptions') === 'http://localhost:8000/v1/models');
// The model id is a Hugging Face repo path: its slash separates path segments
// and must survive, while the rest is encoded.
check('install endpoint keeps the repo slash', transcriptionInstallEndpoint('http://localhost:8000', 'Systran/faster-whisper-small') === 'http://localhost:8000/v1/models/Systran/faster-whisper-small');

// ── the wire shape, against a mocked fetch ──
type Captured = { url: string; method: string; auth: string | undefined; file: File; model: string; language: string | null };
let captured: Captured | null = null;
let respond: () => Response = () => new Response(JSON.stringify({ text: '  hello from the clip  ' }), { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  // The check and install calls carry no body — only transcribe() posts a form.
  const form = init?.body instanceof FormData ? init.body : new FormData();
  captured = {
    url: String(input),
    method: init?.method ?? 'GET',
    auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
    file: form.get('file') as File,
    model: String(form.get('model')),
    language: form.get('language') === null ? null : String(form.get('language')),
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
  // Whisper's `language` is a constraint, not a hint — it must be absent
  // unless the caller genuinely knows it (interview clips do, uploads don't).
  check('no language field by default (auto-detect)', captured!.language === null);

  await transcribe({ ...goodCfg, apiKey: '' }, new Blob(['x'], { type: 'audio/mpeg' }), { language: 'de' });
  check('no auth header without a key', captured!.auth === undefined);
  check('mp3 mime → .mp3 filename', captured!.file.name === 'recording.mp3');
  check('language pinned when the caller knows it', captured!.language === 'de');

  respond = () => new Response('nope', { status: 401 });
  const authErr = await transcribe(goodCfg, new Blob(['x'])).then(() => null, (e: unknown) => e);
  check('401 → AiError auth', authErr instanceof AiError && authErr.hint === 'auth');

  respond = () => new Response('boom', { status: 500 });
  const netErr = await transcribe(goodCfg, new Blob(['x'])).then(() => null, (e: unknown) => e);
  check('500 → AiError network', netErr instanceof AiError && netErr.hint === 'network');

  respond = () => new Response('{"nope":1}', { status: 200 });
  const shapeErr = await transcribe(goodCfg, new Blob(['x'])).then(() => null, (e: unknown) => e);
  check('missing text field → AiError network', shapeErr instanceof AiError && shapeErr.hint === 'network');

  // The bug this whole surface exists for: the bundled Speaches container
  // answers 404 for a model it has not downloaded, which used to reach the
  // user as a bare "404" on the Transcribe button.
  respond = () => new Response('{"detail":"Model is not installed locally"}', { status: 404 });
  const modelErr = await transcribe(goodCfg, new Blob(['x'])).then(() => null, (e: unknown) => e);
  check('404 → AiError model (not a generic network failure)', modelErr instanceof AiError && modelErr.hint === 'model');

  // ── the server check ──
  const models = (ids: string[]): Response =>
    new Response(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }), { status: 200 });

  respond = () => models(['Systran/faster-whisper-small', 'speaches-ai/Kokoro-82M-v1.0-ONNX']);
  const okCheck = await checkTranscription({ ...goodCfg, model: 'Systran/faster-whisper-small' });
  check('installed model → ok', okCheck.ok);
  check('check GETs the models listing', captured!.url === 'http://localhost:8000/v1/models' && captured!.method === 'GET');
  check('check sends no recording', captured!.file === null);
  check('check carries the key', captured!.auth === 'Bearer sk-test');

  const missing = await checkTranscription({ ...goodCfg, model: 'Systran/faster-whisper-medium' });
  check('unlisted model → modelMissing', !missing.ok && missing.reason === 'modelMissing');
  check('modelMissing reports what the server does have', !missing.ok && missing.reason === 'modelMissing' && missing.available.includes('Systran/faster-whisper-small'));

  respond = () => models([]);
  const empty = await checkTranscription(goodCfg);
  check('empty listing → modelMissing (fresh container)', !empty.ok && empty.reason === 'modelMissing');

  respond = () => new Response('nope', { status: 403 });
  const authCheck = await checkTranscription(goodCfg);
  check('403 on the listing → auth', !authCheck.ok && authCheck.reason === 'auth');

  respond = () => new Response('nope', { status: 502 });
  const downCheck = await checkTranscription(goodCfg);
  check('502 on the listing → unreachable', !downCheck.ok && downCheck.reason === 'unreachable');

  respond = () => new Response('<html>', { status: 200 });
  const junkCheck = await checkTranscription(goodCfg);
  check('non-JSON listing → unreachable, never a false ok', !junkCheck.ok && junkCheck.reason === 'unreachable');

  // checkTranscription is the settings sheet's verdict source — it must never
  // throw, or the button would be left spinning.
  globalThis.fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
  const offline = await checkTranscription(goodCfg);
  check('network failure → unreachable, not a throw', !offline.ok && offline.reason === 'unreachable');
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = { url: String(input), method: init?.method ?? 'GET', auth: (init?.headers as Record<string, string> | undefined)?.Authorization, file: null as unknown as File, model: '', language: null };
    return respond();
  }) as typeof fetch;

  // ── the install action ──
  respond = () => new Response('', { status: 201 });
  await installTranscriptionModel({ ...goodCfg, model: 'Systran/faster-whisper-small' });
  check('install POSTs the model path', captured!.method === 'POST' && captured!.url === 'http://localhost:8000/v1/models/Systran/faster-whisper-small');

  respond = () => new Response('nope', { status: 404 });
  const noInstall = await installTranscriptionModel(goodCfg).then(() => null, (e: unknown) => e);
  check('server without the install endpoint → AiError', noInstall instanceof AiError);
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

// ── the out-of-editor write-back (auto-transcribe after save) ──
const storedBody = JSON.stringify(interviewDoc);
const written = setTranscriptAttr(storedBody, 's1', 1, 'thinking about the garden');
check('setTranscriptAttr writes the addressed card', written !== null && coerceVideoInterview((JSON.parse(written!) as { content: { attrs: Record<string, unknown> }[] }).content[0].attrs)?.cards[1].transcript === 'thinking about the garden');
check('setTranscriptAttr leaves other cards alone', written !== null && coerceVideoInterview((JSON.parse(written!) as { content: { attrs: Record<string, unknown> }[] }).content[0].attrs)?.cards[0].transcript === 'it was a long but good day');
check('wrong sessionId → null (entry reused, node replaced)', setTranscriptAttr(storedBody, 'other-session', 0, 'x') === null);
check('out-of-range card → null', setTranscriptAttr(storedBody, 's1', 9, 'x') === null);
check('unparseable body → null', setTranscriptAttr('{nope', 's1', 0, 'x') === null);

// ── the spoken language: chosen, remembered, and never silently wrong ──
// The video interview used to infer this from the app's UI language. Whisper
// treats `language` as a constraint, so that inference turned every answer
// spoken in another language into confident nonsense. (The stored preference
// itself is exercised in video-interview-repro.ts, which has a DOM.)
check('every UI locale is offerable as a spoken language', ['en', 'de', 'fr', 'es', 'it', 'nl', 'fi', 'zh', 'ja', 'ko', 'hi', 'ar'].every((c) => SPOKEN_LANGUAGES.includes(c)));
check('language names render in the reader\'s language', languageName('de', 'de') !== 'de' && languageName('de', 'en') !== languageName('de', 'de'));
check('an unnamed code degrades to the code itself', languageName('zzz', 'en') === 'zzz');

// The session records the language it was conducted in, so a later
// "Transcribe answers" is not at the mercy of the current device's UI.
const langDoc = coerceVideoInterview({ ...interviewDoc.content[0].attrs, lang: 'de' });
check('lang survives coercion', langDoc?.lang === 'de');
check('a session without lang means auto-detect', coerceVideoInterview(interviewDoc.content[0].attrs)?.lang === undefined);
check('a non-string lang is dropped rather than sent', coerceVideoInterview({ ...interviewDoc.content[0].attrs, lang: 7 })?.lang === undefined);

// ── CSP: loopback whisper on any port is reachable in production ──
const csp = policy();
check('CSP allows loopback any-port', csp.includes('http://localhost:*') && csp.includes('http://127.0.0.1:*'));
check('CSP still pins Ollama entries', csp.includes('http://localhost:11434'));

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
