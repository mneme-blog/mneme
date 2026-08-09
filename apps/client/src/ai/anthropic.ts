// Anthropic Messages API, called directly from the browser (CORS is allowed
// when the dangerous-direct-browser-access header is set — appropriate here
// because the key is the user's own, BYO by design). Deliberately no SDK:
// raw fetch + a small SSE reader keeps the dependency surface at zero, same
// as the Ollama backend.
import { AiError, toAiError, type AiProvider, type ChatParams } from './types';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODELS_URL = 'https://api.anthropic.com/v1/models';
const VERSION = '2023-06-01';

interface SseEvent {
  type?: string;
  delta?: { type?: string; text?: string; stop_reason?: string };
  error?: { message?: string };
}

export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic' as const;
  readonly label = 'Anthropic (cloud)';
  readonly local = false;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }

  async chat(params: ChatParams): Promise<string> {
    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: this.headers(),
        signal: params.signal,
        body: JSON.stringify({
          model: this.model,
          max_tokens: params.maxTokens ?? 2048,
          system: params.system,
          messages: params.messages,
          stream: true,
        }),
      });
    } catch (e) {
      throw toAiError(e);
    }
    if (res.status === 401 || res.status === 403) throw new AiError('auth', 'invalid API key');
    if (!res.ok || !res.body) throw new AiError('network', `request failed (${res.status})`);

    // SSE: events separated by blank lines, payload on `data:` lines.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const ev = JSON.parse(line.slice(5)) as SseEvent;
            if (ev.type === 'error') throw new AiError('network', ev.error?.message ?? 'stream error');
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
              text += ev.delta.text;
              params.onToken?.(ev.delta.text);
            }
            if (ev.type === 'message_delta' && ev.delta?.stop_reason === 'refusal') {
              throw new AiError('refused', 'the model declined to answer');
            }
          }
        }
      }
    } catch (e) {
      throw toAiError(e);
    } finally {
      // Thrown mid-stream errors must release the reader — an unreleased one
      // keeps the connection open until GC.
      void reader.cancel().catch(() => undefined);
    }
    return text;
  }

  async verify(): Promise<void> {
    // Zero-token key check; falls back to a 1-token message if /v1/models
    // turns out not to be CORS-reachable from a browser.
    try {
      const res = await fetch(MODELS_URL, { headers: this.headers() });
      if (res.status === 401 || res.status === 403) throw new AiError('auth', 'invalid API key');
      if (res.ok) return;
    } catch (e) {
      if (e instanceof AiError) throw e;
      /* CORS/network on the models endpoint — try the real one */
    }
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model: this.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    }).catch((e: unknown) => {
      throw toAiError(e);
    });
    if (res.status === 401 || res.status === 403) throw new AiError('auth', 'invalid API key');
    if (!res.ok) throw new AiError('network', `request failed (${res.status})`);
  }
}
