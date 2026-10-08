import { test, expect } from '@playwright/test';

import {
  dedupeCalls,
  isNoise,
  mergeShapes,
  pathTemplate,
  replayableUrl,
  shapeOf,
  type ApiCall,
} from '../../scripts/lib/api-observation';
import { generateApiSpecs, responseBudgetMs } from '../../scripts/lib/api-tests';

function call(overrides: Partial<ApiCall> = {}): ApiCall {
  return {
    method: 'GET',
    url: 'https://api.example/api/articles?limit=10',
    template: '/api/articles',
    status: 200,
    contentType: 'application/json',
    durationMs: 180,
    auth: 'none',
    responseShape: shapeOf({ articles: [{ slug: 'a' }], articlesCount: 1 }),
    ...overrides,
  };
}

test.describe('response shapes', () => {
  test('records key names and types, never values', () => {
    const shape = shapeOf({ email: 'ceo@acme.example', age: 42, admin: false });

    expect(shape).toEqual({
      type: 'object',
      properties: {
        email: { type: 'string' },
        age: { type: 'number' },
        admin: { type: 'boolean' },
      },
    });
    expect(JSON.stringify(shape)).not.toContain('ceo@acme.example');
  });

  test('array items require only the keys every item had', () => {
    const shape = shapeOf([{ id: 1, extra: true }, { id: 2 }]);

    expect(shape).toEqual({
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'number' } } },
    });
  });

  test('null in one record and a value in another is a nullable field', () => {
    expect(mergeShapes(shapeOf(null), shapeOf('bio'))).toEqual({ type: 'string' });
  });

  test('conflicting types become any rather than a false contract', () => {
    expect(mergeShapes(shapeOf(1), shapeOf('1'))).toEqual({ type: 'any' });
  });
});

test.describe('urls and noise', () => {
  test('ids in paths are generalised', () => {
    expect(pathTemplate('/api/articles/42/comments/0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(
      '/api/articles/{id}/comments/{id}'
    );
    expect(pathTemplate('/api/articles/how-to-train-your-dragon')).toBe('/api/articles/how-to-train-your-dragon');
    expect(pathTemplate('/api/user/notification-preferences')).toBe('/api/user/notification-preferences');
    expect(pathTemplate('/api/articles/how-to-train-your-dragon-4721')).toBe('/api/articles/{id}');
    expect(pathTemplate('/api/users/V1StGXR8_Z5jdHi6B')).toBe('/api/users/{id}');
  });

  test('credential-like query parameters are never kept', () => {
    expect(replayableUrl('https://a.example/x?limit=10&access_token=t&apiKey=k&email=e&offset=0')).toBe(
      'https://a.example/x?limit=10&offset=0'
    );
  });

  test('analytics and monitoring traffic is not the application API', () => {
    expect(isNoise('https://app.example/cdn-cgi/rum?')).toBe(true);
    expect(isNoise('https://www.google-analytics.com/g/collect')).toBe(true);
    expect(isNoise('https://o1.ingest.sentry.io/api/1/envelope/')).toBe(true);
    expect(isNoise('https://api.example/api/articles')).toBe(false);
  });

  test('dedupe keeps the successful observation with a body', () => {
    const kept = dedupeCalls([
      call({ status: 500, responseShape: undefined, url: 'https://api.example/api/articles/1', template: '/api/articles/{id}' }),
      call({ url: 'https://api.example/api/articles/2', template: '/api/articles/{id}' }),
    ]);

    expect(kept).toHaveLength(1);
    expect(kept[0].status).toBe(200);
  });
});

test.describe('api test generation', () => {
  test('a successful read gets a contract test', () => {
    const { specs, skipped } = generateApiSpecs([call()]);

    expect(skipped).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0].fileName).toBe('api-01-get-api-articles.spec.ts');
    expect(specs[0].tests).toEqual(['GET /api/articles responds with the observed contract']);
    expect(specs[0].source).toContain('toBe(200)');
    expect(specs[0].source).toContain("expectShape(await response.json(), SHAPE, 'body')");
  });

  test('mutating calls are never replayed', () => {
    const { specs, skipped } = generateApiSpecs(
      ['POST', 'PUT', 'PATCH', 'DELETE'].map((method) => call({ method }))
    );

    expect(specs).toEqual([]);
    expect(skipped.every((entry) => /change real data/.test(entry.reason))).toBe(true);
  });

  test('a failed observation is not taken as the contract', () => {
    const { specs, skipped } = generateApiSpecs([call({ status: 500 })]);

    expect(specs).toEqual([]);
    expect(skipped[0].reason).toMatch(/Observed status 500/);
  });

  test('a session-cookie call also gets an anonymous-access test', () => {
    const [spec] = generateApiSpecs([call({ auth: 'cookie' })]).specs;

    expect(spec.tests).toEqual([
      'GET /api/articles responds with the observed contract',
      'GET /api/articles refuses anonymous access',
    ]);
    expect(spec.source).toContain('playwright.request.newContext()');
  });

  test('a header-token call is only tested for anonymous refusal', () => {
    const { specs, skipped } = generateApiSpecs([call({ auth: 'header' })]);

    expect(specs[0].tests).toEqual(['GET /api/articles refuses anonymous access']);
    expect(skipped[0].reason).toMatch(/header token/);
  });

  test('the time budget is generous, never tighter than 3 seconds', () => {
    expect(responseBudgetMs(50)).toBe(3_000);
    expect(responseBudgetMs(1_234)).toBe(6_200);
  });

  test('urls and titles are embedded as safe string literals', () => {
    const [spec] = generateApiSpecs([
      call({ url: 'https://api.example/api/q?name=a"b`${x}', template: '/api/q' }),
    ]).specs;

    expect(spec.source).toContain('const ENDPOINT = "https://api.example/api/q?name=a\\"b`${x}";');
  });

  test('the generated shape check accepts the observed body and rejects a broken one', () => {
    const [spec] = generateApiSpecs([call()]).specs;

    // Run the emitted helper itself, so a template typo cannot ship.
    const helper = spec.source.slice(spec.source.indexOf('function expectShape'));
    const js = helper
      .replace(/: unknown/g, '')
      .replace(/: Shape/g, '')
      .replace(/: string\)/g, ')')
      .replace(/: void/g, '')
      .replace(/ as unknown\[\]/g, '')
      .replace(/ as object/g, '')
      .replace(/ as Record<string, unknown>/g, '')
      .replace(/shape\.items!/g, 'shape.items');

    const expectShape = new Function('expect', `${js}; return expectShape;`)(expect);
    const shape = shapeOf({ articles: [{ slug: 'a' }], articlesCount: 1 });

    expect(() => expectShape({ articles: [{ slug: 'b' }], articlesCount: 3 }, shape, 'body')).not.toThrow();
    expect(() => expectShape({ articles: [{ slug: 'b' }] }, shape, 'body')).toThrow(/articlesCount is present/);
    expect(() => expectShape({ articles: [{ slug: 7 }], articlesCount: 1 }, shape, 'body')).toThrow(/slug is a string/);
  });
});
