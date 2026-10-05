import {
  AIAnalysis,
  FailureContext,
} from './provider';

/**
 * Shared by every provider, so switching from OpenAI to a local model
 * changes who answers, not what is asked.
 */
export const SYSTEM_PROMPT = `
You are Qyntra AI, an expert Quality
Engineering intelligence engine.

Analyze the supplied automated test
failure using:

- failure information
- stack trace
- source code
- application discovery
- framework
- discovered selectors
- test context

Determine whether the failure is most likely:

1. Test defect
2. Product defect
3. Environment/infrastructure issue

Do not automatically blame the test.

If the application discovery information
shows a valid selector or behavior that
contradicts the test, identify that as a
likely test defect.

If the test expectation appears correct
but the application behavior is incorrect,
identify a likely product defect.

Return ONLY valid JSON.

The JSON must contain exactly:

{
  "category": "...",
  "severity": "...",
  "confidence": 0.0,
  "rootCause": "...",
  "whyItHappened": "...",
  "recommendation": "...",
  "suggestedFix": "...",
  "suggestedCode": "...",
  "isLikelyTestDefect": true,
  "isLikelyProductDefect": false
}

category must be one of: "Locator / UI",
"Timeout / Synchronization", "API / Network",
"Functional / Assertion",
"Environment / Infrastructure",
"Unknown / Environment".

severity must be one of: "Critical",
"High", "Medium", "Low".

confidence must be a number from 0 to 1.
`.trim();

const CATEGORIES: AIAnalysis['category'][] = [
  'Locator / UI',
  'Timeout / Synchronization',
  'API / Network',
  'Functional / Assertion',
  'Environment / Infrastructure',
  'Unknown / Environment',
];

const SEVERITIES: AIAnalysis['severity'][] = [
  'Critical',
  'High',
  'Medium',
  'Low',
];

/**
 * JSON Schema for the response. Providers that support constrained
 * decoding (Ollama, Gemini) are held to it, which matters most for
 * small local models that otherwise drift from the enums.
 */
export const ANALYSIS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: CATEGORIES },
    severity: { type: 'string', enum: SEVERITIES },
    confidence: { type: 'number' },
    rootCause: { type: 'string' },
    whyItHappened: { type: 'string' },
    recommendation: { type: 'string' },
    suggestedFix: { type: 'string' },
    suggestedCode: { type: 'string' },
    isLikelyTestDefect: { type: 'boolean' },
    isLikelyProductDefect: { type: 'boolean' },
  },
  required: [
    'category',
    'severity',
    'confidence',
    'rootCause',
    'whyItHappened',
    'recommendation',
    'suggestedFix',
    'suggestedCode',
    'isLikelyTestDefect',
    'isLikelyProductDefect',
  ],
} as const;

export function userMessage(
  context: FailureContext
): string {
  return JSON.stringify(
    context,
    null,
    2
  );
}

/**
 * Parse and sanity-check a provider response.
 *
 * A response that is not JSON, or names a category or severity Qyntra
 * does not know, is rejected so the caller falls back to the
 * deterministic analyzer instead of feeding the gate a made-up value.
 */
export function parseAnalysis(
  text: string | undefined | null
): AIAnalysis {
  if (!text) {
    throw new Error(
      'Qyntra AI returned an empty response.'
    );
  }

  let parsed: any;

  try {
    // Some models wrap JSON in a markdown fence despite instructions.
    parsed = JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
    );
  } catch {
    throw new Error(
      'Qyntra AI returned invalid JSON.'
    );
  }

  if (!CATEGORIES.includes(parsed?.category)) {
    throw new Error(
      `Qyntra AI returned an unknown category: ${parsed?.category}`
    );
  }

  if (!SEVERITIES.includes(parsed?.severity)) {
    throw new Error(
      `Qyntra AI returned an unknown severity: ${parsed?.severity}`
    );
  }

  const confidence = Number(parsed.confidence);

  return {
    ...parsed,
    confidence: Number.isFinite(confidence)
      ? Math.min(1, Math.max(0, confidence))
      : 0.5,
    isLikelyTestDefect: parsed.isLikelyTestDefect === true,
    isLikelyProductDefect: parsed.isLikelyProductDefect === true,
  } as AIAnalysis;
}
