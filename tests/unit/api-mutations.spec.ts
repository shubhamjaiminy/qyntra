import { test, expect } from '@playwright/test';

import {
  UNIQUE_NUMBER,
  UNIQUE_STRING,
  crudSpecSource,
  planCrud,
  sampleFromSchema,
} from '../../scripts/lib/api-mutations';
import { SHAPE_HELPER } from '../../scripts/lib/api-tests';
import { resolveApiConfig } from '../../scripts/lib/config';

const SPEC = {
  openapi: '3.0.0',
  paths: {
    '/pets': {
      post: {
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
        responses: { '201': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } },
      },
    },
    '/pets/{petId}': {
      get: { responses: { '200': {}, '404': {} } },
      put: { responses: { '200': {} } },
      delete: { responses: { '204': {} } },
    },
    '/orders': {
      post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } }, responses: { '200': {} } },
    },
    '/events': {
      post: { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { '202': {} } },
    },
    '/events/{id}': { get: { responses: { '200': {} } } },
  },
  components: {
    schemas: {
      Pet: {
        type: 'object',
        required: ['name', 'photoUrls', 'ownerId'],
        properties: {
          id: { type: 'integer', example: 10 },
          name: { type: 'string', example: 'doggie' },
          ownerId: { type: 'integer', example: 7 },
          email: { type: 'string', format: 'email' },
          photoUrls: { type: 'array', items: { type: 'string' } },
          status: { type: 'string', enum: ['available', 'sold'] },
        },
      },
      Order: { type: 'object', properties: { id: { type: 'integer' } } },
    },
  },
};

const plan = (allowedHosts = ['sandbox.example.com']) =>
  planCrud(SPEC, { server: 'https://sandbox.example.com/api', allowedHosts });

test.describe('write-path planning', () => {
  test('a host outside allowedHosts gets no writes at all', () => {
    const result = plan(['other.example.com']);

    expect(result.plans).toEqual([]);
    expect(result.skipped.every((entry) => /not in api\.mutations\.allowedHosts/.test(entry.reason))).toBe(true);
  });

  test('plans create, read, update and delete for a full resource', () => {
    const [pets] = plan().plans;

    expect(pets).toMatchObject({
      resource: '/pets',
      create: { path: '/pets', status: 201 },
      read: { path: '/pets/{petId}', param: 'petId' },
      update: { method: 'PUT', field: 'name' },
      remove: { path: '/pets/{petId}', status: 204, notFound: true },
    });
  });

  test('a write that cannot be read back is not tested', () => {
    expect(plan().skipped.find((entry) => entry.call === 'POST /orders')?.reason).toMatch(/No GET \/orders\/\{id\}/);
  });

  test('a resource without DELETE is planned but flagged', () => {
    const result = plan();

    expect(result.plans.find((entry) => entry.resource === '/events')?.remove).toBeUndefined();
    expect(result.skipped.some((entry) => entry.call === 'DELETE /events/{id}')).toBe(true);
  });
});

test.describe('sample records', () => {
  test('own id is unique, references keep their example, strings get the marker', () => {
    expect(sampleFromSchema(SPEC.components.schemas.Pet, SPEC)).toEqual({
      id: UNIQUE_NUMBER,
      name: UNIQUE_STRING,
      ownerId: 7,
      photoUrls: [UNIQUE_STRING],
    });
  });

  test('formats get valid values', () => {
    expect(sampleFromSchema({ type: 'string', format: 'email' }, {})).toBe(`${UNIQUE_STRING}@example.com`);
    expect(sampleFromSchema({ type: 'string', enum: ['a', 'b'] }, {})).toBe('a');
  });
});

test.describe('generated lifecycle test', () => {
  const [pets] = plan().plans;
  const source = crudSpecSource(pets, SHAPE_HELPER);

  test('re-checks the host at runtime', () => {
    expect(source).toContain("throw new Error('Refusing to write to '");
    expect(source).toContain('const ALLOWED_HOSTS: string[] = ["sandbox.example.com"]');
  });

  test('deletes in finally, so a failed assertion leaves no data', () => {
    expect(source).toMatch(/finally \{[\s\S]*if \(!deleted\)[\s\S]*request\.delete/);
  });

  test('checks the record is gone when a 404 is documented', () => {
    expect(source).toContain("'a deleted record is gone').toBe(404)");
  });

  test('never contains the spec example id', () => {
    expect(source).not.toMatch(/"id": 10\b/);
  });
});

test.describe('mutations config', () => {
  test('off by default', () => {
    expect(resolveApiConfig({}).mutations).toEqual({ enabled: false, allowedHosts: [] });
  });

  test('enabling without a sandbox host is a configuration error', () => {
    expect(() => resolveApiConfig({ mutations: { enabled: true } })).toThrow(/names no allowedHosts/);
  });

  test('hosts must be bare names, not URLs', () => {
    expect(() =>
      resolveApiConfig({ mutations: { enabled: true, allowedHosts: ['https://sandbox.example.com'] } })
    ).toThrow(/host names only/);
  });
});
