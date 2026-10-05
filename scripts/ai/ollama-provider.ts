import type { AIConfig } from '../lib/config';
import {
  AIProvider,
  FailureContext,
  AIAnalysis,
  ProviderUnavailableError,
} from './provider';
import {
  ANALYSIS_JSON_SCHEMA,
  SYSTEM_PROMPT,
  parseAnalysis,
  userMessage,
} from './prompt';

/** Local models are slow on a cold start; the first call loads weights. */
const REQUEST_TIMEOUT_MS = 180_000;

/**
 * Ollama: an open-source model on the customer's own machine or CI
 * runner. Free, needs no key, and nothing leaves the environment.
 *
 * Uses Ollama's native /api/chat rather than its OpenAI-compatible
 * endpoint because only the native one enforces a JSON schema, which
 * keeps a 7B model inside the category and severity enums.
 */
export class OllamaProvider
  implements AIProvider
{
  private baseUrl: string;

  private model: string;

  constructor(config: AIConfig) {
    this.baseUrl =
      ollamaBaseUrl(config);

    this.model =
      config.model;
  }

  async analyzeFailure(
    context: FailureContext
  ): Promise<AIAnalysis> {
    let response: Response;

    try {
      response =
        await fetch(
          `${this.baseUrl}/api/chat`,
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json',
            },

            body: JSON.stringify({
              model: this.model,

              stream: false,

              format:
                ANALYSIS_JSON_SCHEMA,

              // Greedy decoding with a fixed seed: the same failure
              // must get the same diagnosis on every run, or the gate
              // could flip a verdict on identical evidence.
              options: {
                temperature: 0,
                seed: 42,
              },

              messages: [
                {
                  role: 'system',
                  content: SYSTEM_PROMPT,
                },

                {
                  role: 'user',
                  content:
                    userMessage(
                      context
                    ),
                },
              ],
            }),

            signal:
              AbortSignal.timeout(
                REQUEST_TIMEOUT_MS
              ),
          }
        );
    } catch (error: any) {
      throw new ProviderUnavailableError(
        `Ollama is not reachable at ${this.baseUrl} ` +
          `(${error?.cause?.code ?? error?.message}). ` +
          'Start it with: ollama serve'
      );
    }

    if (response.status === 404) {
      throw new ProviderUnavailableError(
        `Ollama model "${this.model}" is not installed. ` +
          `Run: ollama pull ${this.model}`
      );
    }

    if (!response.ok) {
      throw new Error(
        `Ollama returned HTTP ${response.status}: ` +
          (await response.text()).slice(0, 300)
      );
    }

    const body: any =
      await response.json();

    return parseAnalysis(
      body?.message?.content
    );
  }
}

export function ollamaBaseUrl(
  config: AIConfig
): string {
  return (
    config.baseUrl ??
    'http://localhost:11434'
  ).replace(/\/+$/, '');
}

/**
 * Whether Ollama is running and has the configured model, for
 * `qyntra doctor`. Returns a problem description, or null when ready.
 */
export async function checkOllama(
  config: AIConfig
): Promise<string | null> {
  const baseUrl =
    ollamaBaseUrl(config);

  let body: any;

  try {
    const response =
      await fetch(
        `${baseUrl}/api/tags`,
        {
          signal:
            AbortSignal.timeout(
              5_000
            ),
        }
      );

    body =
      await response.json();
  } catch {
    return (
      `Ollama is not reachable at ${baseUrl}. ` +
      'Start it with: ollama serve'
    );
  }

  const installed: string[] =
    (body?.models ?? []).map(
      (entry: any) =>
        String(entry?.name ?? '')
    );

  // "llama3" in config matches "llama3:latest" as Ollama reports it.
  const wanted =
    config.model.includes(':')
      ? config.model
      : `${config.model}:latest`;

  if (!installed.includes(wanted)) {
    return (
      `Ollama model "${config.model}" is not installed. ` +
      `Run: ollama pull ${config.model}`
    );
  }

  return null;
}
