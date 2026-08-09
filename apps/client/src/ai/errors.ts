// Shared AiError → user-message mapping. The hint→catalog ladder existed in
// five copies across the AI surfaces; two families cover them all, and keeping
// them here stops the copies from drifting (three surfaces once disagreed on
// what a refusal should say without anyone deciding that).
import type { AiError } from './types';
import { t, type MessageKey } from '../i18n';

/**
 * Chat/completion failures (Ask my journal, guided interview, editor actions).
 * Only the refusal wording is per-surface — pass that surface's catalog key.
 * Callers handle 'aborted' themselves (it is a user action, not an error).
 */
export function chatErrorMessage(err: AiError, providerLocal: boolean, refusedKey: MessageKey): string {
  if (err.hint === 'auth') return t('assistant.error.keyRejected');
  if (err.hint === 'refused') return t(refusedKey);
  // A local provider that stopped answering is almost always "Ollama isn't
  // running", which deserves its own copy over a generic failure.
  if (providerLocal) return t('assistant.error.ollamaUnreachable');
  return t('assistant.error.requestFailed', { message: err.message });
}

/** Transcription failures (media cards + video-interview answers) — identical
 *  ladder in both surfaces, including the relay-gate hints (session/quota). */
export function transcribeErrorMessage(err: AiError): string {
  if (err.hint === 'auth') return t('assistant.error.keyRejectedShort');
  if (err.hint === 'session') return t('media.transcribe.signedOut');
  if (err.hint === 'quota') return t('media.transcribe.limitReached');
  if (err.hint === 'model') return t('media.transcribe.modelMissing');
  return t('media.transcribe.failed', { message: err.message });
}
