import OpenAI from 'openai';

import type { AIConfig } from '../lib/config';
import {
  AIProvider,
  FailureContext,
  AIAnalysis,
} from './provider';
import {
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
    const response =
      await this.client.responses.create({
        model: this.model,

        input: [
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
      });

    return parseAnalysis(
      response.output_text
    );
  }
}
