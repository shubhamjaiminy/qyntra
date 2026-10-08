import { GoogleGenAI } from '@google/genai';

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
      await withRetry(() => this.client.models.generateContent({
        model: this.model,

        contents: [
          {
            role: 'user',
            parts: [
              {
                text: request.user,
              },

              ...(request.screenshot
                ? [
                    {
                      inlineData: {
                        mimeType:
                          request.screenshot.mimeType,
                        data:
                          request.screenshot.base64,
                      },
                    },
                  ]
                : []),
            ],
          },
        ],

        config: {
          systemInstruction:
            request.system,

          responseMimeType:
            'application/json',

          responseJsonSchema:
            request.schema,
        },
      }));

    return response.text ?? '';
  }
}
