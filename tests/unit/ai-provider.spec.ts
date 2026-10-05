import { test, expect } from '@playwright/test';

import { parseAnalysis } from '../../scripts/ai/prompt';
import { isProviderOutage } from '../../scripts/ai/provider';
import { resolveAIConfig } from '../../scripts/lib/config';

const VALID = {
  category: 'Functional / Assertion',
  severity: 'High',
  confidence: 0.8,
  rootCause: 'Counter shows 1, test expects 5.',
  whyItHappened: 'Only one todo was created.',
  recommendation: 'Fix the expectation.',
  suggestedFix: 'Expect "1 item left".',
  suggestedCode: "await expect(count).toHaveText('1 item left');",
  isLikelyTestDefect: true,
  isLikelyProductDefect: false,
};

test.describe('ai config resolution', () => {
  test('defaults to openai for backward compatibility', () => {
    expect(resolveAIConfig(undefined)).toEqual({
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKeyEnv: 'OPENAI_API_KEY',
    });
  });

  test('ollama needs no key and gets a local endpoint', () => {
    const ai = resolveAIConfig({ provider: 'ollama' });

    expect(ai.apiKeyEnv).toBe('');
    expect(ai.model).toBe('qwen2.5-coder:7b');
    expect(ai.baseUrl).toBe('http://localhost:11434');
  });

  test('gemini reads its own key, never OPENAI_API_KEY', () => {
    expect(resolveAIConfig({ provider: 'gemini' }).apiKeyEnv).toBe(
      'GEMINI_API_KEY'
    );
  });

  test('explicit fields win over provider defaults', () => {
    const ai = resolveAIConfig({
      provider: 'ollama',
      model: 'llama3',
      baseUrl: 'http://gpu-box:11434',
    });

    expect(ai.model).toBe('llama3');
    expect(ai.baseUrl).toBe('http://gpu-box:11434/');
  });

  test('an unknown provider is rejected, not silently ignored', () => {
    expect(() => resolveAIConfig({ provider: 'claude-ish' })).toThrow(
      /Unsupported "ai.provider"/
    );
  });

  test('a malformed baseUrl is rejected', () => {
    expect(() =>
      resolveAIConfig({ provider: 'ollama', baseUrl: 'localhost' })
    ).toThrow(/not a valid URL/);
  });
});

test.describe('ai response parsing', () => {
  test('accepts a well-formed analysis', () => {
    expect(parseAnalysis(JSON.stringify(VALID))).toEqual(VALID);
  });

  test('strips a markdown fence some models add', () => {
    const fenced = '```json\n' + JSON.stringify(VALID) + '\n```';

    expect(parseAnalysis(fenced).category).toBe('Functional / Assertion');
  });

  test('rejects an invented category so the gate never sees it', () => {
    expect(() =>
      parseAnalysis(JSON.stringify({ ...VALID, category: 'Vibes' }))
    ).toThrow(/unknown category/);
  });

  test('rejects an invented severity', () => {
    expect(() =>
      parseAnalysis(JSON.stringify({ ...VALID, severity: 'Urgent' }))
    ).toThrow(/unknown severity/);
  });

  test('clamps confidence into 0..1', () => {
    expect(
      parseAnalysis(JSON.stringify({ ...VALID, confidence: 7 })).confidence
    ).toBe(1);
  });

  test('defect flags must be literally true', () => {
    const parsed = parseAnalysis(
      JSON.stringify({ ...VALID, isLikelyProductDefect: 'yes' })
    );

    expect(parsed.isLikelyProductDefect).toBe(false);
  });

  test('empty and non-JSON responses are rejected', () => {
    expect(() => parseAnalysis('')).toThrow(/empty/);
    expect(() => parseAnalysis('I think it is a locator issue')).toThrow(
      /invalid JSON/
    );
  });
});

test.describe('provider outage detection', () => {
  test('quota, auth and connection errors are outages', () => {
    expect(isProviderOutage({ status: 429 })).toBe(true);
    expect(isProviderOutage({ status: 401 })).toBe(true);
    expect(
      isProviderOutage({ message: 'fetch failed', cause: { code: 'ECONNREFUSED' } })
    ).toBe(true);
  });

  test('a single bad response is not an outage', () => {
    expect(
      isProviderOutage(new Error('Qyntra AI returned invalid JSON.'))
    ).toBe(false);
  });
});
