// Opt-in AI assistant (client-only). The relay is never involved: requests go
// browser → provider directly. Cloud backends are a user-consented extension of
// the trust boundary; the Ollama backend keeps everything on-device.

export type AiBackend = 'anthropic' | 'ollama';

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatParams {
  system: string;
  /** Alternating turns, first 'user'. */
  messages: AiMessage[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** Streaming callback; tokens arrive in document order. */
  onToken?: (text: string) => void;
}

export interface AiProvider {
  readonly id: AiBackend;
  readonly label: string;
  /** True when nothing leaves the device — drives the privacy badge in every surface. */
  readonly local: boolean;
  /** Streams via onToken; resolves the full text. Rejects with AiError. */
  chat(params: ChatParams): Promise<string>;
  /** Cheap config check for the settings sheet "Test connection" button. */
  verify(): Promise<void>;
  /** Model picker population (Ollama /api/tags). */
  listModels?(): Promise<string[]>;
}

// 'model': the server answered, but does not have the requested model — a
// whisper server without the model downloaded 404s every transcription.
// 'session': the bundled transcription server is gated by the relay, and the
//   vault session behind that gate is missing or expired — a different problem
//   from 'auth' (a rejected API key) and a different thing to tell the user.
// 'quota': the relay refused because this vault has used up its transcription
//   allowance for the day, or is asking too fast.
export type AiErrorHint =
  | 'auth'
  | 'network'
  | 'refused'
  | 'aborted'
  | 'model'
  | 'session'
  | 'quota';

export class AiError extends Error {
  readonly hint: AiErrorHint;
  constructor(hint: AiErrorHint, message: string) {
    super(message);
    this.name = 'AiError';
    this.hint = hint;
  }
}

/** Map a thrown value from a provider fetch to an AiError. */
export function toAiError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new AiError('aborted', 'stopped');
  }
  return new AiError('network', err instanceof Error ? err.message : 'request failed');
}

/**
 * Speech-to-text for video/audio recordings: any server speaking the OpenAI
 * `/v1/audio/transcriptions` shape (a local whisper server, or a cloud key).
 * Optional on AiSettings — records sealed before the feature existed lack it.
 */
export interface TranscriptionSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Decrypted settings — in memory only while the vault is unlocked. */
export interface AiSettings {
  v: 1;
  enabled: boolean;
  backend: AiBackend;
  anthropic: { apiKey: string; model: string };
  ollama: { baseUrl: string; model: string };
  transcription?: TranscriptionSettings;
}

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';
export const ANTHROPIC_MODELS = ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'];
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
/**
 * The default model of the bundled Speaches container (MIT weights, loaded on
 * demand). Whisper large-v3-turbo: the full large-v3 encoder with the decoder
 * pruned from 32 layers to 4 (809M params), which is what makes it affordable —
 * it transcribes close to large-v3 while decoding several times faster, and it
 * is multilingual, unlike the distil-* models.
 *
 * This replaced faster-whisper-small, whose accuracy outside English was poor
 * enough that transcripts read as guesswork. The download is ~1.6 GB against
 * small's ~0.5 GB, and on the CPU image a clip takes noticeably longer — the
 * trade the quality is worth. Keep in step with WHISPER_MODEL in both compose
 * files, which install it into the container's cache on `up`.
 */
export const DEFAULT_TRANSCRIPTION_MODEL = 'deepdml/faster-whisper-large-v3-turbo-ct2';

/**
 * The deployment-bundled whisper proxy, as a same-origin path. The standard
 * Caddy deploy serves the app under a base path and proxies `<base>/whisper`
 * to the whisper container (deploy/web/Caddyfile); the dev server proxies
 * /whisper to localhost:8000 (vite.config.ts). A relative VITE_RELAY_URL is
 * that base path, so the whisper path lives beside it; with an absolute or
 * unset relay URL the app is served from the origin root.
 */
export function bundledWhisperUrl(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const relay = env?.VITE_RELAY_URL ?? '';
  return relay.startsWith('/') ? `${relay.replace(/\/+$/, '')}/whisper` : '/whisper';
}

export function defaultTranscriptionSettings(): TranscriptionSettings {
  return { baseUrl: bundledWhisperUrl(), apiKey: '', model: DEFAULT_TRANSCRIPTION_MODEL };
}

export function defaultAiSettings(): AiSettings {
  return {
    v: 1,
    enabled: false,
    backend: 'ollama',
    anthropic: { apiKey: '', model: DEFAULT_ANTHROPIC_MODEL },
    ollama: { baseUrl: DEFAULT_OLLAMA_URL, model: '' },
    transcription: defaultTranscriptionSettings(),
  };
}
