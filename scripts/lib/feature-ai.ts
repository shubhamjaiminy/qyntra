/**
 * AI steps of feature testing: understand the feature, write tests for
 * it, fix a test that failed, and review the feature as a QA engineer.
 *
 * The model only ever sees what the explorer observed — aria snapshots,
 * one screenshot, and the problems recorded — never source code. Every
 * answer is parsed defensively: a small local model returning a broken
 * object must degrade the report, not crash the run.
 */

import fs from 'fs';

import type { AIProvider } from '../ai/provider';
import type { FeatureObservation } from './feature-explorer';

// --------------------------------------------------
// SHAPES
// --------------------------------------------------

export interface FeatureUnderstanding {
  purpose: string;
  /** Who uses it and when. */
  users: string;
  /** The things it manages, e.g. "fee rule", "tour". */
  entities: string[];
  /** Fields, with what they mean as far as the UI shows. */
  fields: { name: string; meaning: string }[];
  /** Rules the UI implies, e.g. "a window applies to days before the event". */
  businessRules: string[];
  /** How to use the feature, step by step. */
  usage: string[];
  /** What the UI leaves unclear, for the team to answer. */
  openQuestions: string[];
}

export interface WrittenTest {
  title: string;
  /** Why this test matters: the behaviour it protects. */
  intent: string;
  /** Body of `async ({ page }) => { ... }`, starting on the feature page. */
  body: string;
}

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'] as const;
export type FindingSeverity = (typeof SEVERITIES)[number];

export const FINDING_CATEGORIES = [
  'functional',
  'usability',
  'accessibility',
  'performance',
  'reliability',
  'data',
  'security',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export interface Finding {
  title: string;
  severity: FindingSeverity;
  category: FindingCategory;
  /** What was observed. Must point at evidence, not opinion. */
  evidence: string;
  recommendation: string;
  /** 'observed' from the browser; 'ai-review' from the model's reading. */
  source: 'observed' | 'ai-review';
}

// --------------------------------------------------
// CONTEXT
// --------------------------------------------------

/** Characters of view snapshots sent per request; fits a 16k window. */
const CONTEXT_BUDGET = 11_000;

export function describeViews(observation: FeatureObservation, budget = CONTEXT_BUDGET, withLocators = false): string {
  const parts: string[] = [];
  let used = 0;

  for (const [index, view] of observation.views.entries()) {
    const remaining = budget - used;
    if (remaining < 400) break;

    const snapshot = view.snapshot.length > remaining ? `${view.snapshot.slice(0, remaining)}\n…` : view.snapshot;
    const locators = withLocators && view.locators.length > 0
      ? `\nVerified locators in this view (each matches exactly one element):\n${view.locators.map((locator) => `- ${locator}`).join('\n')}`
      : '';

    parts.push(`### View ${index + 1}: ${view.how} (${view.kind}, ${view.url})\n${snapshot}${locators}`);
    used += snapshot.length + locators.length;
  }

  return parts.join('\n\n');
}

function screenshotOf(observation: FeatureObservation) {
  const file = observation.views[0]?.screenshot;

  return file && fs.existsSync(file)
    ? { mimeType: 'image/png', base64: fs.readFileSync(file).toString('base64') }
    : undefined;
}

function parseObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');

  if (start === -1 || end <= start) {
    throw new Error('The model did not return a JSON object.');
  }

  return JSON.parse(text.slice(start, end + 1));
}

const strings = (value: unknown, max = 20): string[] =>
  (Array.isArray(value) ? value : [])
    .map((entry) => String(entry ?? '').trim())
    .filter((entry) => entry !== '')
    .slice(0, max);

// --------------------------------------------------
// UNDERSTAND
// --------------------------------------------------

const UNDERSTAND_SCHEMA = {
  type: 'object',
  properties: {
    purpose: { type: 'string' },
    users: { type: 'string' },
    entities: { type: 'array', items: { type: 'string' } },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, meaning: { type: 'string' } },
        required: ['name', 'meaning'],
      },
    },
    businessRules: { type: 'array', items: { type: 'string' } },
    usage: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['purpose', 'users', 'entities', 'fields', 'businessRules', 'usage', 'openQuestions'],
};

export async function understandFeature(
  provider: AIProvider,
  observation: FeatureObservation,
  appName: string
): Promise<FeatureUnderstanding> {
  const text = await provider.completeJSON({
    system:
      'You are a senior QA engineer learning a feature of a web application from what is on screen. ' +
      'Describe only what the screens show or clearly imply. Never invent fields or behaviour. ' +
      'Where the UI is ambiguous, add an open question instead of guessing.',
    user:
      `Application: ${appName}\nFeature: ${observation.feature}\n\n` +
      'Below are accessibility snapshots of the feature page and of views reached from it.\n\n' +
      `${describeViews(observation)}\n\n` +
      'Return: purpose (2-3 sentences), users (who uses it and when), entities, fields (name and meaning), ' +
      'businessRules (rules the UI implies), usage (numbered steps to use the feature, as plain sentences), ' +
      'openQuestions (what the UI leaves unclear).',
    schema: UNDERSTAND_SCHEMA,
    screenshot: screenshotOf(observation),
  });

  const raw = parseObject(text);

  return {
    purpose: String(raw.purpose ?? '').trim(),
    users: String(raw.users ?? '').trim(),
    entities: strings(raw.entities),
    fields: (Array.isArray(raw.fields) ? raw.fields : [])
      .map((field: any) => ({ name: String(field?.name ?? '').trim(), meaning: String(field?.meaning ?? '').trim() }))
      .filter((field) => field.name !== '')
      .slice(0, 30),
    businessRules: strings(raw.businessRules),
    usage: strings(raw.usage).map((step) => step.replace(/^\d+[.)]\s*/, '')),
    openQuestions: strings(raw.openQuestions),
  };
}

// --------------------------------------------------
// WRITE TESTS
// --------------------------------------------------

const TESTS_SCHEMA = {
  type: 'object',
  properties: {
    tests: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          intent: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['title', 'intent', 'body'],
      },
    },
  },
  required: ['tests'],
};

const TEST_RULES = (readOnly: boolean) =>
  [
    'Rules for every test body:',
    '- It is the body of `async ({ page }) => { ... }`. The page is ALREADY on the feature page and fully loaded; do not call page.goto for it.',
    '- Locate elements ONLY with the "Verified locators" listed for each view, copied character for character. Never invent a locator, never use getByLabel, and never use getByText without { exact: true }.',
    '- A view reached by a click is only available after that click: click the listed control first, then use that view\'s locators.',
    '- Every test must end with at least one `await expect(...)` assertion about something visible.',
    '- Use expect(...).toBeVisible(), toHaveText, toContainText, toHaveCount, toBeEnabled, toBeDisabled, toHaveValue. Default timeouts only.',
    '- No `import`, no `test(...)` wrapper, no comments, no page.waitForTimeout.',
    readOnly
      ? '- READ-ONLY: never save, submit, delete, or change data. Opening forms, dialogs, filters, sorting, searching and typing into a form you then cancel are allowed. Write requests are blocked by the network anyway, so a test that saves will fail.'
      : '- Writes are allowed, but every test must leave the data as it found it.',
    '- Each test checks ONE behaviour and is independent of the others.',
  ].join('\n');

export async function writeTests(
  provider: AIProvider,
  observation: FeatureObservation,
  understanding: FeatureUnderstanding | undefined,
  maxTests: number
): Promise<WrittenTest[]> {
  const text = await provider.completeJSON({
    system:
      'You write Playwright tests in TypeScript for a web application feature, from accessibility snapshots. ' +
      'Your tests must pass against the application as it is now, and fail if the behaviour they protect breaks.',
    user:
      `Feature: ${observation.feature}\n` +
      (understanding ? `Purpose: ${understanding.purpose}\nBusiness rules:\n- ${understanding.businessRules.join('\n- ')}\n` : '') +
      `\n${describeViews(observation, CONTEXT_BUDGET, true)}\n\n` +
      `${TEST_RULES(observation.readOnly)}\n\n` +
      `Write ${maxTests} tests covering: the feature loads with its key content; each view listed above can be opened ` +
      'and shows its key fields; table or list behaviour (columns, sorting, search, filters) where present; form ' +
      'validation where a form exists. Return { tests: [{ title, intent, body }] }.',
    schema: TESTS_SCHEMA,
  });

  return parseTests(text, maxTests);
}

export function parseTests(text: string, max: number): WrittenTest[] {
  const raw = parseObject(text);
  const tests = Array.isArray(raw.tests) ? raw.tests : [];

  return tests
    .map((entry: any) => ({
      title: String(entry?.title ?? '').trim().slice(0, 120),
      intent: String(entry?.intent ?? '').trim(),
      body: cleanBody(String(entry?.body ?? '')),
    }))
    .filter((entry) => entry.title !== '' && /expect\s*\(/.test(entry.body))
    // Results are matched to tests by title, so titles must be unique.
    .filter((entry, index, all) => all.findIndex((other) => other.title === entry.title) === index)
    .slice(0, max);
}

/**
 * Models wrap bodies in fences, a test() call or an arrow function
 * despite being told not to. Strip the wrapper, keep the statements.
 */
export function cleanBody(body: string): string {
  let text = body.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();

  const wrapped = /^(?:test\([^,]+,\s*)?async\s*\(\s*\{[^}]*\}\s*\)\s*=>\s*\{([\s\S]*)\}\s*\)?\s*;?\s*$/.exec(text);
  if (wrapped) text = wrapped[1].trim();

  return text
    .split('\n')
    .filter((line) => !/^\s*import\s/.test(line))
    .join('\n')
    .trim();
}

// --------------------------------------------------
// FIX A FAILING TEST
// --------------------------------------------------

const FIX_SCHEMA = {
  type: 'object',
  properties: { body: { type: 'string' }, appDefect: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['body', 'appDefect', 'reason'],
};

export interface TestFix {
  body: string;
  /** The model believes the application, not the test, is wrong. */
  appDefect: boolean;
  reason: string;
}

export async function fixTest(
  provider: AIProvider,
  observation: FeatureObservation,
  test: WrittenTest,
  error: string,
  pageAtFailure: string | undefined
): Promise<TestFix> {
  const text = await provider.completeJSON({
    system:
      'You fix failing Playwright tests. Decide first whether the test is wrong (wrong locator, wrong expected ' +
      'text, wrong assumption) or the application is wrong (the behaviour the test protects is genuinely broken). ' +
      'If the test is wrong, return a corrected body. If the application is wrong, set appDefect true, explain ' +
      'why in reason, and return the body unchanged. Never weaken an assertion just to make it pass.',
    user:
      `Feature: ${observation.feature}\nTest: ${test.title}\nIntent: ${test.intent}\n\n` +
      `Body:\n${test.body}\n\nError:\n${error.slice(0, 2_000)}\n\n` +
      (pageAtFailure ? `Page at failure (accessibility snapshot):\n${pageAtFailure.slice(0, 6_000)}\n\n` : '') +
      `Views of the feature:\n${describeViews(observation, 5_000, true)}\n\n${TEST_RULES(observation.readOnly)}`,
    schema: FIX_SCHEMA,
  });

  const raw = parseObject(text);

  return {
    body: cleanBody(String(raw.body ?? test.body)),
    appDefect: raw.appDefect === true,
    reason: String(raw.reason ?? '').trim(),
  };
}

// --------------------------------------------------
// REVIEW
// --------------------------------------------------

/**
 * What a model can judge from screens. Accessibility, performance and
 * reliability are measured in the browser instead; a model reading a
 * snapshot only restates (or contradicts) those measurements.
 */
export const REVIEW_CATEGORIES = ['functional', 'usability', 'data'] as const;

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: [...SEVERITIES] },
          category: { type: 'string', enum: [...REVIEW_CATEGORIES] },
          evidence: { type: 'string' },
          recommendation: { type: 'string' },
        },
        required: ['title', 'severity', 'category', 'evidence', 'recommendation'],
      },
    },
  },
  required: ['findings'],
};


/**
 * The model's review of the feature's design: what a careful QA
 * engineer would flag from the screens. Evidence-bound: a finding that
 * does not cite something visible is dropped by the prompt's rules and
 * by the report's wording ("ai-review", never "observed").
 */
export async function reviewFeature(
  provider: AIProvider,
  observation: FeatureObservation,
  understanding: FeatureUnderstanding | undefined,
  observed: Finding[]
): Promise<Finding[]> {
  const text = await provider.completeJSON({
    system:
      'You are a senior QA engineer reviewing a feature before release. Report drawbacks a user or the business ' +
      'would hit in how the feature works: confusing or ambiguous labels, missing or wrong validation, ' +
      'destructive actions without confirmation, unclear states, inconsistent terminology, risky defaults, data ' +
      'that looks wrong. Do NOT report accessibility, performance or network problems — those are measured ' +
      'separately. Every finding must quote the exact label or value from the snapshots as evidence, and the ' +
      'evidence must show the problem: if the evidence shows the feature handles it (e.g. a disabled button ' +
      'when fields are empty IS validation), it is not a finding. Severity: Critical blocks use; High likely ' +
      'causes wrong charges or lost data; Medium confuses users; Low is polish. Report at most 6, most ' +
      'important first. Fewer, well-evidenced findings are better than many weak ones.',
    user:
      `Feature: ${observation.feature}\n` +
      (understanding ? `Purpose: ${understanding.purpose}\n` : '') +
      `Already observed (do not repeat):\n- ${observed.map((finding) => finding.title).join('\n- ') || 'none'}\n\n` +
      describeViews(observation),
    schema: REVIEW_SCHEMA,
    screenshot: screenshotOf(observation),
  });

  const raw = parseObject(text);

  return (Array.isArray(raw.findings) ? raw.findings : [])
    .map((entry: any): Finding => ({
      title: String(entry?.title ?? '').trim(),
      severity: (SEVERITIES as readonly string[]).includes(entry?.severity) ? entry.severity : 'Low',
      category: (REVIEW_CATEGORIES as readonly string[]).includes(entry?.category) ? entry.category : 'usability',
      evidence: String(entry?.evidence ?? '').trim(),
      recommendation: String(entry?.recommendation ?? '').trim(),
      source: 'ai-review',
    }))
    .filter((finding) => finding.title !== '' && finding.evidence !== '')
    // The model is told not to; small ones do anyway.
    .filter((finding) => !/accessib|aria|screen reader|load time|slow|performance/i.test(`${finding.title} ${finding.evidence}`))
    .slice(0, 6);
}

// --------------------------------------------------
// HONEST TITLES
// --------------------------------------------------

const RETITLE_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
};

/**
 * Title a verified test by what its code checks, not by what it was
 * meant to check. A test called "validation is enforced" that only
 * checks a label is visible must not be reported as validation coverage.
 */
export async function retitleTest(provider: AIProvider, test: WrittenTest): Promise<string> {
  const text = await provider.completeJSON({
    system:
      'You describe what a Playwright test verifies, from its code alone, in at most 10 words, in plain English. ' +
      'Describe only what the assertions check after the actions. Do not claim anything the code does not check.',
    // The old title is deliberately not shown: given one, small models
    // repeat it, which is exactly the overclaim this step removes.
    user: `What does this test check?\n\nCode:\n${test.body}`,
    schema: RETITLE_SCHEMA,
  });

  const title = String(parseObject(text).title ?? '').trim().replace(/[.]$/, '');

  return title.length >= 5 && title.length <= 120 ? title : test.title;
}
