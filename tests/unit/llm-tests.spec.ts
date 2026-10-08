import { test, expect } from '@playwright/test';

import { resolveAIConfig, resolveLlmConfig } from '../../scripts/lib/config';
import { ALL_PROBES, generateLlmSpecs, type LlmFeature } from '../../scripts/lib/llm-tests';

const ai = resolveAIConfig({ provider: 'ollama', model: 'qwen2.5-coder:7b' });

function feature(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Support bot',
    endpoint: 'https://app.example/api/assistant',
    body: { message: '{{input}}' },
    responsePath: 'reply.text',
    canaries: ['CANARY-7f3a'],
    cases: [{ name: 'refund window', input: 'Can I return this?', expect: { contains: ['30 days'] } }],
    ...overrides,
  };
}

const resolve = (overrides: Record<string, unknown> = {}, judge?: unknown) =>
  resolveLlmConfig({ features: [feature(overrides)], ...(judge ? { judge } : {}) }, ai);

test.describe('llm config', () => {
  test('a feature gets every probe by default, and the judge follows ai', () => {
    const config = resolve();

    expect(config.features[0].probes).toEqual(ALL_PROBES);
    expect(config.judge).toMatchObject({ provider: 'ollama', model: 'qwen2.5-coder:7b' });
  });

  test('a body without {{input}} is rejected: every probe would send the same request', () => {
    expect(() => resolve({ body: { message: 'hello' } })).toThrow(/must contain "\{\{input\}\}"/);
  });

  test('a case must check something', () => {
    expect(() => resolve({ cases: [{ name: 'x', input: 'y', expect: {} }] })).toThrow(/must check something/);
  });

  test('an invalid regex and an unknown probe are rejected', () => {
    expect(() => resolve({ cases: [{ name: 'x', input: 'y', expect: { matches: '([' } }] })).toThrow(/regular expression/);
    expect(() => resolve({ probes: ['mind-reading'] })).toThrow(/unknown probe/);
  });

  test('probes can be narrowed or switched off', () => {
    expect(resolve({ probes: ['role-escape'] }).features[0].probes).toEqual(['role-escape']);
    expect(resolve({ probes: false }).features[0].probes).toEqual([]);
  });

  test('OpenAI is not offered as a judge: the emitted helper cannot call it', () => {
    expect(resolveLlmConfig({ features: [feature()] }, resolveAIConfig({ provider: 'openai' })).judge).toBeUndefined();
    expect(() => resolve({}, { provider: 'openai' })).toThrow(/ollama" or "gemini/);
  });

  test('a gemini judge reads its key from an env var', () => {
    expect(resolve({}, { provider: 'gemini' }).judge).toEqual({
      provider: 'gemini',
      model: 'gemini-3.5-flash',
      apiKeyEnv: 'GEMINI_API_KEY',
    });
  });
});

test.describe('llm spec generation', () => {
  test('the judge helper is emitted only when a check uses it', () => {
    const config = resolve({}, { provider: 'gemini' });
    const [spec] = generateLlmSpecs(config.features as LlmFeature[], config.judge);

    expect(spec.source).not.toContain('async function expectJudged');
  });

  const generate = (overrides: Record<string, unknown> = {}, judge?: unknown) => {
    const config = resolve(overrides, judge);
    return generateLlmSpecs(config.features as LlmFeature[], config.judge)[0];
  };

  test('one spec per feature with the cases, then every probe', () => {
    const spec = generate();

    expect(spec.fileName).toBe('llm-01-support-bot.spec.ts');
    expect(spec.tests).toEqual([
      'Support bot: refund window',
      ...ALL_PROBES.map((probe) => `Support bot: probe ${probe}`),
    ]);
  });

  test('prompt injection is graded by the canary, with no judge involved', () => {
    const spec = generate({ probes: ['prompt-injection'] });

    expect(spec.source).toContain('expectNoCanary(answer)');
    expect(spec.source).toContain('const CANARIES: string[] = ["CANARY-7f3a"]');
    expect(spec.source).not.toContain('async function expectJudged');
  });

  test('without a canary, prompt injection falls back to the judge', () => {
    const spec = generate({ canaries: [], probes: ['prompt-injection'] });

    expect(spec.source).toContain('await expectJudged(');
    expect(spec.source).toContain('function calibrateJudge');
  });

  test('without a canary or a judge, the probe is not generated and says why', () => {
    const config = resolveLlmConfig(
      { features: [feature({ canaries: [], probes: ['prompt-injection'] })] },
      resolveAIConfig({ provider: 'none' })
    );

    const [spec] = generateLlmSpecs(config.features, config.judge);

    expect(spec.tests).toEqual(['Support bot: refund window']);
    expect(spec.notes[0]).toMatch(/needs a canary .* or a judge/);
  });

  test('a rubric produces a judged check guarded by evidence, anchors and calibration', () => {
    const spec = generate({ cases: [{ name: 'policy', input: 'Refunds?', expect: { rubric: 'States the 30 day window.' } }] });

    expect(spec.source).toContain('await expectJudged(answer, "States the 30 day window.", input)');
    expect(spec.source).toContain('its quoted evidence is not in the answer');
    expect(spec.source).toContain('function anchorsOf');
    expect(spec.source).toContain('failed calibration');
  });

  test('credentials are read from env at test time, never written into the spec', () => {
    const spec = generate(
      {
        auth: { header: 'Authorization', env: 'BOT_TOKEN' },
        cases: [{ name: 'tone', input: 'Hi', expect: { rubric: 'Is polite.' } }],
      },
      { provider: 'gemini' }
    );

    expect(spec.source).toContain('credential("BOT_TOKEN")');
    expect(spec.source).toContain('process.env[JUDGE.apiKeyEnv!]');
    expect(spec.source).not.toMatch(/Bearer |AIza/);
  });

  test('the input is substituted everywhere in the body template', () => {
    const spec = generate({
      body: { messages: [{ role: 'user', content: 'Q: {{input}}' }], meta: { echo: '{{input}}' } },
    });

    expect(spec.source).toContain("return template.split('{{input}}').join(input);");
    expect(spec.source).toContain('"content": "Q: {{input}}"');
  });
});
