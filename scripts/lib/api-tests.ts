/**
 * API test generation from observed traffic.
 *
 * Turns the API calls discovery watched the application make into
 * Playwright `request` tests: a contract test per endpoint (status,
 * content type, response shape, a generous time budget) and, for calls
 * that carried a session, a test that the endpoint refuses anonymous
 * access.
 *
 * Only reads are generated. Replaying a POST, PUT, PATCH or DELETE
 * against a customer's environment creates, changes or destroys real
 * data, so mutating calls are listed as untested instead.
 */

import type { ApiCall, Shape } from './api-observation';

export interface GeneratedApiSpec {
  fileName: string;
  source: string;
  /** One line per test, for the stage's summary. */
  tests: string[];
}

export interface SkippedApiCall {
  call: string;
  reason: string;
}

export interface ApiGeneration {
  specs: GeneratedApiSpec[];
  skipped: SkippedApiCall[];
}

const READ_METHODS = new Set(['GET', 'HEAD']);

/** Slow networks and cold caches are not regressions. */
const MIN_BUDGET_MS = 3_000;
const BUDGET_MULTIPLIER = 5;

export function responseBudgetMs(observedMs: number): number {
  return Math.max(MIN_BUDGET_MS, Math.ceil((observedMs * BUDGET_MULTIPLIER) / 100) * 100);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/\{id\}/g, 'id')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

/** A string literal safe to embed in generated TypeScript. */
function literal(value: string): string {
  return JSON.stringify(value);
}

export function generateApiSpecs(calls: ApiCall[]): ApiGeneration {
  const specs: GeneratedApiSpec[] = [];
  const skipped: SkippedApiCall[] = [];

  for (const call of calls) {
    const label = `${call.method} ${call.template}`;

    if (!READ_METHODS.has(call.method)) {
      skipped.push({
        call: label,
        reason: 'Mutating request: replaying it would change real data.',
      });
      continue;
    }

    if (call.status < 200 || call.status >= 300) {
      skipped.push({
        call: label,
        reason: `Observed status ${call.status}; a contract is only taken from a successful call.`,
      });
      continue;
    }

    const tests: string[] = [];
    const blocks: string[] = [];

    // A header token cannot be replayed: it lived in the page's memory
    // or storage, not in the session file the tests run with — unless
    // the config names an env var that holds one (api.auth).
    if (call.auth === 'header' && !call.authHeader) {
      skipped.push({
        call: label,
        reason:
          call.source === 'openapi'
            ? 'Secured in the spec and no api.auth credential is configured; only ' +
              'anonymous refusal is tested.'
            : 'Authenticated with a header token Qyntra cannot replay; only anonymous ' +
              'access is tested.',
      });
    } else {
      tests.push(
        `${label} ${call.source === 'openapi' ? 'matches its documented contract' : 'responds with the observed contract'}`
      );
      blocks.push(contractTest(call, tests[tests.length - 1]));
    }

    const hasContract = tests.length > 0;

    if (call.auth !== 'none') {
      tests.push(`${label} refuses anonymous access`);
      blocks.push(anonymousTest(call, tests[tests.length - 1]));
    }

    if (call.notFound) {
      tests.push(`${label} returns ${call.notFound.status} for an unknown id`);
      blocks.push(notFoundTest(call, tests[tests.length - 1]));
    }

    if (blocks.length === 0) {
      continue;
    }

    const index = String(specs.length + 1).padStart(2, '0');

    specs.push({
      fileName: `api-${index}-${call.method.toLowerCase()}-${slug(call.template) || 'root'}.spec.ts`,
      tests,
      source: specSource(
        call,
        blocks,
        hasContract && call.responseShape !== undefined && /json/.test(call.contentType)
      ),
    });
  }

  return { specs, skipped };
}

/** Request options sending the configured credential, if any. */
function authOptions(call: ApiCall): string {
  return call.authHeader
    ? `, { headers: { ${literal(call.authHeader.name)}: credential() } }`
    : '';
}

function contractTest(call: ApiCall, title: string): string {
  const method = call.method.toLowerCase();
  const budget = responseBudgetMs(call.durationMs);

  const json = /json/.test(call.contentType);

  const budgetNote =
    call.durationMs > 0
      ? `Observed in ${call.durationMs}ms; the budget allows for slower networks.`
      : 'Not timed during discovery; the default budget applies.';

  return `
test(${literal(title)}, async ({ request }) => {
  const started = Date.now();
  const response = await request.${method}(ENDPOINT${authOptions(call)});
  const elapsed = Date.now() - started;

  expect(response.status(), 'status').toBe(${call.status});
${
  call.contentType
    ? `  expect(response.headers()['content-type'] ?? '', 'content type').toContain(${literal(call.contentType)});\n`
    : ''
}
  // ${budgetNote}
  expect(elapsed, 'response time (ms)').toBeLessThan(${budget});
${
  json && call.responseShape && method !== 'head'
    ? `
  expectShape(await response.json(), SHAPE, 'body');
`
    : ''
}});
`;
}

function anonymousTest(call: ApiCall, title: string): string {
  const why =
    call.source === 'openapi'
      ? 'The spec marks this operation as secured'
      : 'This endpoint was called with a session during discovery';

  return `
test(${literal(title)}, async ({ playwright }) => {
  // Explicitly empty: inside a test, newContext() inherits the file's
  // test.use({ storageState }) — the logged-in session — so without
  // this the "anonymous" request would carry the login cookie and pass
  // against an endpoint that is wide open.
  const anonymous = await playwright.request.newContext({
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: {},
    httpCredentials: undefined,
  });

  try {
    const response = await anonymous.${call.method.toLowerCase()}(ENDPOINT);
    const status = response.status();

    expect(
      status === 401 || status === 403,
      \`${why}, but an anonymous request got HTTP \${status} (expected 401 or 403)\`
    ).toBe(true);
  } finally {
    await anonymous.dispose();
  }
});
`;
}

function notFoundTest(call: ApiCall, title: string): string {
  return `
test(${literal(title)}, async ({ request }) => {
  // An id that should not exist. The spec documents ${call.notFound!.status} for this case.
  const response = await request.${call.method.toLowerCase()}(${literal(call.notFound!.url)}${authOptions(call)});

  expect(response.status(), 'status for an unknown id').toBe(${call.notFound!.status});
});
`;
}

/**
 * Reads the credential at test time. Fails loudly rather than sending
 * an empty header, which would test anonymous access by accident.
 */
function credentialHelper(call: ApiCall): string {
  if (!call.authHeader) {
    return '';
  }

  return `
function credential(): string {
  const value = process.env[${literal(call.authHeader.env)}];

  if (!value) {
    throw new Error(${literal(`${call.authHeader.env} is not set (api.auth in .qyntra/config.json).`)});
  }

  return value;
}
`;
}

function specSource(call: ApiCall, blocks: string[], withShape: boolean): string {
  const provenance =
    call.source === 'openapi'
      ? ` * Documented by the OpenAPI spec${call.operation ? ` ("${call.operation.replace(/\*\//g, '')}")` : ''}:
 *   ${call.method} ${call.url}
 *   → ${call.status} ${call.contentType || '(no content type)'}
 *
 * The shape below asserts the properties the spec marks as required.`
      : ` * Observed during discovery:
 *   ${call.method} ${call.url}
 *   → ${call.status} ${call.contentType || '(no content type)'} in ${call.durationMs}ms
 *
 * The shape below is key names and types only — no response values
 * were stored. A key is asserted only if every observed record had it.`;

  return `/**
 * Generated by Qyntra API Test Generator. Do not edit: regenerated on
 * every \`qyntra run\`.
 *
${provenance}
 */

import { test, expect } from '@playwright/test';

// Session saved by \`qyntra login\` / \`qyntra run\` for apps behind a login.
if (process.env.QYNTRA_STORAGE_STATE) {
  test.use({ storageState: process.env.QYNTRA_STORAGE_STATE });
}

const ENDPOINT = ${literal(call.url)};
${withShape ? `\nconst SHAPE: Shape = ${JSON.stringify(call.responseShape, null, 2)};\n` : ''}${blocks.join('')}${credentialHelper(call)}${withShape ? SHAPE_HELPER : ''}`;
}

/**
 * Emitted into each spec so generated tests have no runtime dependency
 * on Qyntra. Scalars tolerate null: an observed string field may be
 * null in another record, and that is not a contract break.
 */
export const SHAPE_HELPER = `
type Shape =
  | { type: 'string' | 'number' | 'boolean' | 'any' }
  | { type: 'array'; items?: Shape }
  | { type: 'object'; properties: Record<string, Shape> };

function expectShape(value: unknown, shape: Shape, at: string): void {
  if (shape.type === 'any') {
    return;
  }

  if (shape.type === 'array') {
    expect(Array.isArray(value), \`\${at} is an array\`).toBe(true);

    if (shape.items) {
      (value as unknown[]).slice(0, 5).forEach((item, index) =>
        expectShape(item, shape.items!, \`\${at}[\${index}]\`)
      );
    }

    return;
  }

  if (shape.type === 'object') {
    expect(
      typeof value === 'object' && value !== null && !Array.isArray(value),
      \`\${at} is an object\`
    ).toBe(true);

    for (const [key, child] of Object.entries(shape.properties)) {
      expect(value as object, \`\${at}.\${key} is present\`).toHaveProperty([key]);
      expectShape((value as Record<string, unknown>)[key], child, \`\${at}.\${key}\`);
    }

    return;
  }

  if (value !== null) {
    expect(typeof value, \`\${at} is a \${shape.type}\`).toBe(shape.type);
  }
}
`;
