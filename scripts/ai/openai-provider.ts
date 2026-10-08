import OpenAI from 'openai';

import type { AIConfig } from '../lib/config';
import {
  AIProvider,
  CompletionRequest,
  FailureContext,
  AIAnalysis,
  withRetry,
} from './provider';
import {
  ANALYSIS_JSON_SCHEMA,
  SYSTEM_PROMPT,
  parseAnalysis,
  userMessage,
} from './prompt';

export class OpenAIProvider
  implements AIProvider
{
  private client: OpenAI;

  private model: string;

  constructor(config: AIConfig) {
    const apiKey =
      process.env[config.apiKeyEnv];

    if (!apiKey) {
      throw new Error(
        `${config.apiKeyEnv} is not configured.`
      );
    }

    this.client =
      new OpenAI({
        apiKey,
      });

    this.model =
      config.model;
  }

  async analyzeFailure(
    context: FailureContext
  ): Promise<AIAnalysis> {
    return parseAnalysis(
      await this.completeJSON({
        system: SYSTEM_PROMPT,
        user: userMessage(context),
        schema: ANALYSIS_JSON_SCHEMA,
        screenshot: context.screenshot,
      })
    );
  }

  async completeJSON(
    request: CompletionRequest
  ): Promise<string> {
    const response =
      await withRetry(() => this.client.responses.create({
        model: this.model,

        input: [
          {
            role: 'system',
            content: request.system,
          },

          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: request.user,
              },

              ...(request.screenshot
                ? [
                    {
                      type: 'input_image' as const,
                      detail: 'auto' as const,
                      image_url:
                        `data:${request.screenshot.mimeType};base64,` +
                        request.screenshot.base64,
                    },
                  ]
                : []),
            ],
          },
        ],
      }));

    return response.output_text;
  }
}
