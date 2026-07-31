// Ollama backend: a model running on the user's own machine — nothing leaves
// the device. Streaming chat is NDJSON (one JSON object per line).
import { AiError, toAiError, type AiProvider, type ChatParams } from './types';

interface OllamaChunk {
  message?: { content?: string };
  done?: boolean;
  error?: string;
}

export class OllamaProvider implements AiProvider {
  readonly id = 'ollama' as const;
  readonly label: string;
  /**
   * Whether requests really stay on this device. Not a constant: `baseUrl` is
   * user-supplied and syncs between the vault's devices, so a value pointing at
   * another machine means journal text does leave — and `local` has to say so
   * rather than assert the happy case. Set by makeProvider from ollamaScope().
   */
  readonly local: boolean;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    local = true,
  ) {
    this.local = local;
    this.label = local ? 'Ollama (on this device)' : `Ollama (${baseUrl})`;
  }

  async chat(params: ChatParams): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: params.signal,
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'system', content: params.system }, ...params.messages],
          stream: true,
          options: params.maxTokens ? { num_predict: params.maxTokens } : undefined,
        }),
      });
    } catch (e) {
      throw toAiError(e);
    }
    if (!res.ok || !res.body) throw new AiError('network', `Ollama request failed (${res.status})`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const chunk = JSON.parse(line) as OllamaChunk;
          if (chunk.error) throw new AiError('network', chunk.error);
          if (chunk.message?.content) {
            text += chunk.message.content;
            params.onToken?.(chunk.message.content);
          }
          if (chunk.done) return text;
        }
      }
    } catch (e) {
      throw toAiError(e);
    }
    return text;
  }

  async verify(): Promise<void> {
    await this.listModels();
  }

  async listModels(): Promise<string[]> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/tags`);
    } catch (e) {
      throw toAiError(e);
    }
    if (!res.ok) throw new AiError('network', `Ollama not reachable (${res.status})`);
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).map((m) => m.name).filter((n): n is string => Boolean(n));
  }
}
