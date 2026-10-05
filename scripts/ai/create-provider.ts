import type { AIConfig } from '../lib/config';
import type { AIProvider } from './provider';

/**
 * Build the configured provider, or null for 'none'.
 *
 * Providers are required lazily so a customer using Ollama never pays
 * for loading the OpenAI or Gemini SDKs, and a broken optional SDK
 * cannot take down the analyzer for everyone else.
 */
export function createProvider(
  config: AIConfig
): AIProvider | null {
  switch (config.provider) {
    case 'openai':
      return new (require('./openai-provider').OpenAIProvider)(config);

    case 'gemini':
      return new (require('./gemini-provider').GeminiProvider)(config);

    case 'ollama':
      return new (require('./ollama-provider').OllamaProvider)(config);

    case 'none':
      return null;
  }
}

/** Human-readable name for logs, e.g. "ollama (qwen2.5-coder:7b)". */
export function describeProvider(
  config: AIConfig
): string {
  return config.provider === 'none'
    ? 'none'
    : `${config.provider} (${config.model})`;
}
