import { AnthropicProvider } from './anthropic';
import { OllamaProvider } from './ollama';
import { ollamaScope, resolveOllamaUrl } from './ollamaUrl';
import { type AiProvider, type AiSettings } from './types';

/** Build the provider for the configured backend. */
export function makeProvider(s: AiSettings): AiProvider {
  switch (s.backend) {
    case 'anthropic':
      return new AnthropicProvider(s.anthropic.apiKey, s.anthropic.model);
    case 'ollama':
      // Normalized, and falling back to the loopback default when the stored
      // value isn't a usable http(s) URL — a typo should mean "not reachable",
      // not "plaintext goes somewhere unintended". `local` reflects where the
      // requests actually go, so the UI's on-device claim can't be wrong.
      return new OllamaProvider(
        resolveOllamaUrl(s.ollama.baseUrl),
        s.ollama.model,
        ollamaScope(s.ollama.baseUrl) === 'loopback',
      );
  }
}
