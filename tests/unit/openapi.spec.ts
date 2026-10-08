import { test, expect } from '@playwright/test';

import { generateApiSpecs } from '../../scripts/lib/api-tests';
import { resolveApiConfig } from '../../scripts/lib/config';
import { OpenApiError, planFromOpenApi, schemaToShape } from '../../scripts/lib/openapi';
import { parseSpec } from '../../scripts/lib/openapi-loader';

const SPEC = {
  openapi: '3.0.3',
  info: { title: 'Shop', version: '2.1.0' },
  servers: [{ url: 'https://{env}.shop.example/api', variables: { env: { default: 'staging' } } }],
  paths: {
    '/products': {
      get: {
        operationId: 'listProducts',
        parameters: [{ name: 'category', in: 'query', required: true, schema: { type: 'string', enum: ['books', 'toys'] } }],
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Product' } } } },
          },
        },
      },
      post: { operationId: 'createProduct', responses: { '201': { description: 'created' } } },
    },
    '/products/{productId}': {
      parameters: [{ name: 'productId', in: 'path', required: true, schema: { type: 'integer', example: 7 } }],
      get: {
        summary: 'Get one product',
        security: [{ apiKey: [] }],
        responses: {
          '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } } },
          '404': { description: 'missing' },
        },
      },
      delete: { responses: { '204': { description: 'gone' } } },
    },
    '/orders/{orderId}': {
      get: {
        parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/session/logout': { get: { responses: { '200': { description: 'bye' } } } },
    '/search': {
      get: {
        parameters: [{ name: 'access_token', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/legacy': { get: { deprecated: true, responses: { '200': { description: 'old' } } } },
    '/public': { get: { security: [], responses: { '204': { description: 'no content' } } } },
  },
  components: {
    schemas: {
      Product: {
        type: 'object',
        required: ['id', 'name', 'category'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          price: { type: 'number' },
          category: { $ref: '#/components/schemas/Category' },
        },
      },
      Category: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' }, parent: { $ref: '#/components/schemas/Category' } },
      },
    },
  },
};

const plan = (options = {}) => planFromOpenApi(SPEC, options);
const reasonFor = (call: string, options = {}) =>
  plan(options).skipped.find((entry) => entry.call === call)?.reason;

test.describe('openapi planning', () => {
  test('resolves the server URL, including server variables', () => {
    expect(plan().server).toBe('https://staging.shop.example/api');
    expect(plan({ baseUrl: 'https://qa.shop.example/api/' }).server).toBe('https://qa.shop.example/api');
  });

  test('plans reads with values from enums and examples', () => {
    const urls = plan().calls.map((call) => call.url);

    expect(urls).toContain('https://staging.shop.example/api/products?category=books');
    expect(urls).toContain('https://staging.shop.example/api/products/7');
  });

  test('never plans writes', () => {
    expect(reasonFor('POST /products')).toMatch(/change real data/);
    expect(reasonFor('DELETE /products/{productId}')).toMatch(/change real data/);
  });

  test('skips GETs that change state or carry credentials', () => {
    expect(reasonFor('GET /session/logout')).toMatch(/changes state/);
    expect(reasonFor('GET /search')).toMatch(/credential-like parameter/);
    expect(reasonFor('GET /legacy')).toMatch(/Deprecated/);
  });

  test('says exactly which value is missing, and config supplies it', () => {
    expect(reasonFor('GET /orders/{orderId}')).toMatch(/path parameter "orderId".*api\.parameters/);
    expect(
      plan({ parameters: { orderId: 'A-1' } }).calls.some((call) => call.url.endsWith('/orders/A-1'))
    ).toBe(true);
  });

  test('marks secured operations and honours security: [] opt-outs', () => {
    const byTemplate = Object.fromEntries(plan().calls.map((call) => [call.template, call]));

    expect(byTemplate['/products/{productId}'].auth).toBe('header');
    expect(byTemplate['/products'].auth).toBe('none');
    expect(byTemplate['/public'].auth).toBe('none');
  });

  test('a documented 404 gets an unknown-id check, typed to the parameter', () => {
    const call = plan({ auth: { header: 'x-api-key', env: 'SHOP_KEY' } }).calls.find(
      (entry) => entry.template === '/products/{productId}'
    );

    expect(call?.notFound).toEqual({
      url: 'https://staging.shop.example/api/products/987654321987',
      status: 404,
    });
  });

  test('rejects Swagger 2.0 and non-OpenAPI documents with a fix', () => {
    expect(() => planFromOpenApi({ swagger: '2.0', paths: {} })).toThrow(/swagger2openapi/);
    expect(() => planFromOpenApi({ paths: {} })).toThrow(OpenApiError);
  });
});

test.describe('schemas', () => {
  test('asserts only required properties, through $refs', () => {
    expect(schemaToShape(SPEC.components.schemas.Product, SPEC)).toEqual({
      type: 'object',
      properties: {
        id: { type: 'number' },
        name: { type: 'string' },
        category: { type: 'object', properties: { name: { type: 'string' } } },
      },
    });
  });

  test('recursive schemas stop at the cycle instead of looping', () => {
    const recursive = {
      components: {
        schemas: {
          Node: { type: 'object', required: ['child'], properties: { child: { $ref: '#/components/schemas/Node' } } },
        },
      },
    };

    expect(() => schemaToShape({ $ref: '#/components/schemas/Node' }, recursive)).not.toThrow();
  });

  test('allOf merges, oneOf cannot be checked structurally', () => {
    const merged = schemaToShape(
      {
        allOf: [
          { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
          { type: 'object', required: ['b'], properties: { b: { type: 'boolean' } } },
        ],
      },
      {}
    );

    expect(merged).toEqual({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'boolean' } } });
    expect(schemaToShape({ oneOf: [{ type: 'string' }, { type: 'number' }] }, {})).toEqual({ type: 'any' });
  });

  test('OpenAPI 3.1 nullable type arrays use the non-null type', () => {
    expect(schemaToShape({ type: ['string', 'null'] }, {})).toEqual({ type: 'string' });
  });
});

test.describe('generated tests from a spec', () => {
  test('a secured operation without a credential gets only the anonymous check', () => {
    const { specs, skipped } = generateApiSpecs(plan().calls);
    const product = specs.find((spec) => spec.fileName.includes('productid'));

    expect(product?.tests).toEqual(['GET /products/{productId} refuses anonymous access']);
    expect(product?.source).toContain('The spec marks this operation as secured');
    expect(skipped.some((entry) => /no api\.auth credential/.test(entry.reason))).toBe(true);
  });

  test('with api.auth, the contract and 404 checks authenticate from an env var', () => {
    const { specs } = generateApiSpecs(plan({ auth: { header: 'x-api-key', env: 'SHOP_KEY' } }).calls);
    const product = specs.find((spec) => spec.fileName.includes('productid'));

    expect(product?.tests).toEqual([
      'GET /products/{productId} matches its documented contract',
      'GET /products/{productId} refuses anonymous access',
      'GET /products/{productId} returns 404 for an unknown id',
    ]);
    expect(product?.source).toContain('{ headers: { "x-api-key": credential() } }');
    expect(product?.source).toContain('process.env["SHOP_KEY"]');
    expect(product?.source).not.toMatch(/SHOP_KEY=|x-api-key": "/);
  });
});

test.describe('loading and config', () => {
  test('parses JSON and YAML specs', () => {
    expect(parseSpec('{"openapi":"3.0.0"}', 'a.json').openapi).toBe('3.0.0');
    expect(parseSpec('openapi: 3.1.0\ninfo:\n  title: Shop\n', 'a.yaml').info.title).toBe('Shop');
  });

  test('a malformed spec fails with the file named', () => {
    expect(() => parseSpec('{ not json', 'spec.json')).toThrow(/spec\.json/);
  });

  test('api.auth must name both the header and the env var', () => {
    expect(() => resolveApiConfig({ auth: { header: 'x-api-key' } })).toThrow(/api\.auth\.env/);
    expect(resolveApiConfig({ auth: { header: 'x-api-key', env: 'KEY' } }).auth).toEqual({
      header: 'x-api-key',
      env: 'KEY',
    });
  });

  test('parameters must be an object', () => {
    expect(() => resolveApiConfig({ parameters: ['petId'] })).toThrow(/api\.parameters/);
  });
});
