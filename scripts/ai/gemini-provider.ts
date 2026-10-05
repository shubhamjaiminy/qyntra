import { GoogleGenAI } from '@google/genai';

import type { AIConfig } from '../lib/config';
import {
  AIProvider,
  FailureContext,
  AIAnalysis,
} from './provider';
import {
  ANALYSIS_JSON_SCHEMA,
  SYSTEM_PROMPT,
  parseAnalysis,
  userMessage,
} from './prompt';

/**
 * Google Gemini. Has a free tier (key from aistudio.google.com), which
 * makes it the zero-cost option for teams that cannot run a local model.
 */
export class GeminiProvider
  implements AIProvider
{
  private client: GoogleGenAI;

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
      new GoogleGenAI({
        apiKey,
      });

    this.model =
      config.model;
  }

  async analyzeFailure(
    context: FailureContext
  ): Promise<AIAnalysis> {
    const response =
      await this.client.models.generateContent({
        model: this.model,

        contents:
          userMessage(
            context
          ),

        config: {
          systemInstruction:
            SYSTEM_PROMPT,

          responseMimeType:
            'application/json',

          responseJsonSchema:
            ANALYSIS_JSON_SCHEMA,
        },
      });

    return parseAnalysis(
      response.text
    );
  }
}
