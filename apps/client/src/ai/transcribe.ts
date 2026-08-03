// Speech-to-text for recordings (client-only, like every AI surface): the
// decrypted media bytes go browser → the configured transcription server,
// never near the relay. The server is anything speaking the de-facto-standard
// OpenAI `/v1/audio/transcriptions` multipart shape — a local whisper server
// (faster-whisper/Speaches, whisper.cpp, LocalAI) keeps everything on-device;
// a cloud endpoint + API key is a user-consented extension of the trust
// boundary, exactly like the Anthropic chat backend.
//
// The resulting transcript is stored as node-attr text inside the encrypted
// entry body (editor/media.tsx, editor/videointerviewData.ts), so it syncs
// like any entry content and docToText surfaces it to search, previews, and
// the Ask-my-journal context.
import { AiError, toAiError, DEFAULT_TRANSCRIPTION_MODEL, type AiSettings, type TranscriptionSettings } from './types';
// URL hygiene shared with the Ollama backend: same normalization (http(s)
// only) and the same loopback classification driving the local/cloud badge.
import { normalizeOllamaUrl as normalizeHttpUrl, ollamaScope as httpUrlScope } from './ollamaUrl';

/**
 * The usable transcription config, or null when the feature is unavailable
 * (AI off, no server configured, or an unusable URL). Null gates every
 * "Transcribe" affordance — unlike the Ollama URL there is no loopback
 * fallback, because a half-configured speech endpoint should look "off",
 * not quietly point somewhere else.
 */
export function transcriptionConfig(settings: AiSettings | null | undefined): TranscriptionSettings | null {
  if (!settings?.enabled || !settings.transcription) return null;
  const baseUrl = normalizeHttpUrl(settings.transcription.baseUrl);
  if (!baseUrl) return null;
  return {
    baseUrl,
    apiKey: settings.transcription.apiKey ?? '',
    model: settings.transcription.model.trim() || DEFAULT_TRANSCRIPTION_MODEL,
  };
}

/** True when the server is loopback — nothing leaves the device. */
export function transcriptionLocal(cfg: TranscriptionSettings): boolean {
  return httpUrlScope(cfg.baseUrl) === 'loopback';
}

/** Accepts a bare origin, an `…/v1` base, or a full `…/audio/transcriptions` path. */
export function transcriptionEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith('/audio/transcriptions')) return base;
  if (base.endsWith('/v1')) return `${base}/audio/transcriptions`;
  return `${base}/v1/audio/transcriptions`;
}

// Whisper servers sniff the container from the filename, and MediaRecorder
// blobs commonly carry a codec suffix ("video/webm;codecs=vp8,opus").
function fileExt(mime: string): string {
  const bare = mime.split(';')[0].trim().toLowerCase();
  const map: Record<string, string> = {
    'video/webm': 'webm',
    'audio/webm': 'webm',
    'video/mp4': 'mp4',
    'audio/mp4': 'm4a',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
  };
  return map[bare] ?? 'webm';
}

/**
 * Transcribe one recording. Resolves the transcript text (may be empty for a
 * silent clip); rejects with AiError ('auth' for a rejected key, 'aborted',
 * else 'network').
 */
export async function transcribe(
  cfg: TranscriptionSettings,
  media: Blob,
  opts?: { mime?: string; signal?: AbortSignal },
): Promise<string> {
  const mime = opts?.mime || media.type || 'video/webm';
  const form = new FormData();
  form.set('file', new File([media], `recording.${fileExt(mime)}`, { type: mime }));
  form.set('model', cfg.model);
  form.set('response_format', 'json');
  let res: Response;
  try {
    res = await fetch(transcriptionEndpoint(cfg.baseUrl), {
      method: 'POST',
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : undefined,
      body: form,
      signal: opts?.signal,
    });
  } catch (e) {
    throw toAiError(e);
  }
  if (res.status === 401 || res.status === 403) throw new AiError('auth', `HTTP ${res.status}`);
  if (!res.ok) throw new AiError('network', `HTTP ${res.status}`);
  let text: unknown;
  try {
    text = ((await res.json()) as { text?: unknown }).text;
  } catch {
    throw new AiError('network', 'malformed transcription response');
  }
  if (typeof text !== 'string') throw new AiError('network', 'malformed transcription response');
  return text.trim();
}
