/**
 * Write-path API tests: create → read → update → delete → gone.
 *
 * Read-only contract tests cannot tell whether an API *stores* what it
 * is given. A lifecycle test can, and it is the strongest functional
 * API test there is — but it creates and deletes real records, so it
 * is only ever generated when the team opts in for named sandbox hosts:
 *
 *   "api": { "mutations": { "enabled": true, "allowedHosts": ["staging-api.acme.example"] } }
 *
 * Safety, in layers:
 *   - Off by default; enabling without allowedHosts is a config error.
 *   - Planned only against an allowed host, so pointing api.baseUrl
 *     elsewhere generates no writes; the generated test re-checks the
 *     host at runtime, so editing the file cannot bypass the list.
 *   - Every record gets unique ids and a "qyntra-test-…" marker, never
 *     the spec's example ids (which often name real, shared records).
 *   - Delete runs in `finally`: a failed assertion never leaves data.
 */

import type { Shape } from './api-observation';
import { schemaToShape } from './openapi';
import type { SkippedApiCall } from './api-tests';

export interface CrudPlan {
  /** "/pet" — the collection the record is created in. */
  resource: string;
  server: string;
  create: { path: string; status: number };
  read?: { path: string; param: string; status: number };
  update?: { path: string; method: 'PUT' | 'PATCH'; status: number; field: string };
  remove?: { path: string; param: string; status: number; notFound: boolean };
  /** Request body with unique-value placeholders, filled at runtime. */
  body: unknown;
  /** Response field holding the new record's id. */
  idField: string;
  /** String fields whose sent value must come back on read. */
  echoFields: string[];
  responseShape?: Shape;
  authHeader?: { name: string; env: string };
  allowedHosts: string[];
}

export const UNIQUE_STRING = '__QYNTRA_UNIQUE_STRING__';
export const UNIQUE_NUMBER = '__QYNTRA_UNIQUE_NUMBER__';

const MAX_SAMPLE_DEPTH = 4;

export interface MutationOptions {
  server: string;
  allowedHosts: string[];
  auth?: { header: string; env: string };
}

/** Plan one lifecycle per POST collection that has a readable item path. */
export function planCrud(
  doc: any,
  options: MutationOptions
): { plans: CrudPlan[]; skipped: SkippedApiCall[] } {
  const plans: CrudPlan[] = [];
  const skipped: SkippedApiCall[] = [];

  const host = new URL(options.server).hostname;

  if (!options.allowedHosts.includes(host)) {
    for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
      for (const method of ['post', 'put', 'patch', 'delete']) {
        if (item?.[method]) {
          skipped.push({
            call: `${method.toUpperCase()} ${path}`,
            reason: `Host ${host} is not in api.mutations.allowedHosts; writes are only sent to named sandboxes.`,
          });
        }
      }
    }

    return { plans, skipped };
  }

  const paths: Record<string, any> = doc.paths ?? {};

  for (const [collection, item] of Object.entries<any>(paths)) {
    const create = item?.post;

    if (!create) {
      continue;
    }

    const label = `POST ${collection}`;
    const schema = jsonSchema(create.requestBody, doc);

    if (!schema) {
      skipped.push({ call: label, reason: 'No JSON request body in the spec to build a record from.' });
      continue;
    }

    if (isSecured(create, doc) && !options.auth) {
      skipped.push({ call: label, reason: 'Secured in the spec and no api.auth credential is configured.' });
      continue;
    }

    // The item path: /pet → /pet/{petId}.
    const itemPath = Object.keys(paths).find((candidate) =>
      new RegExp(`^${escapeRegex(collection)}/\\{[^}/]+\\}$`).test(candidate)
    );

    const read = itemPath && paths[itemPath]?.get;

    if (!itemPath || !read) {
      skipped.push({
        call: label,
        reason: `No GET ${collection}/{id} to read the record back, so a write could not be verified.`,
      });
      continue;
    }

    const param = itemPath.match(/\{([^}]+)\}$/)![1];
    const createdStatus = successStatus(create);
    const responseSchema = jsonSchema(create.responses?.[String(createdStatus)], doc);

    // The id comes back under the param's name or plain "id".
    const responseProps = Object.keys(resolve(responseSchema ?? {}, doc)?.properties ?? {});
    const idField = [param, 'id'].find((name) => responseProps.includes(name)) ?? 'id';

    const body = sampleFromSchema(schema, doc, 0, idField);

    const resolvedBody = resolve(schema, doc);
    const echoFields = Object.entries<any>(resolvedBody?.properties ?? {})
      .filter(([name, prop]) => resolve(prop, doc)?.type === 'string' && !resolve(prop, doc)?.enum && name in (body as object))
      .map(([name]) => name)
      .slice(0, 3);

    const remove = paths[itemPath]?.delete;
    const updateOp = item?.put ? { op: item.put, method: 'PUT' as const, path: collection } : paths[itemPath]?.put
      ? { op: paths[itemPath].put, method: 'PUT' as const, path: itemPath }
      : paths[itemPath]?.patch
        ? { op: paths[itemPath].patch, method: 'PATCH' as const, path: itemPath }
        : undefined;

    // Never update the record's key: renaming it and reading back by
    // the old one would fail for the wrong reason.
    const updateField = echoFields.find((field) => field !== idField && field !== param);

    plans.push({
      resource: collection,
      server: options.server,
      create: { path: collection, status: createdStatus },
      read: { path: itemPath, param, status: successStatus(read) },
      ...(updateOp && updateField
        ? { update: { path: updateOp.path, method: updateOp.method, status: successStatus(updateOp.op), field: updateField } }
        : {}),
      ...(remove
        ? {
            remove: {
              path: itemPath,
              param,
              status: successStatus(remove),
              notFound: Boolean(read.responses?.['404']),
            },
          }
        : {}),
      body,
      idField,
      echoFields,
      ...(responseSchema ? { responseShape: schemaToShape(responseSchema, doc) } : {}),
      ...(options.auth ? { authHeader: { name: options.auth.header, env: options.auth.env } } : {}),
      allowedHosts: options.allowedHosts,
    });

    if (!remove) {
      skipped.push({
        call: `DELETE ${itemPath}`,
        reason: 'Not documented: records created by this test cannot be cleaned up, so review them.',
      });
    }
  }

  return { plans, skipped };
}

/**
 * A minimal valid record: required properties only, from examples,
 * defaults and enums — except ids and identifiers, which are unique
 * per run so a test never writes over a real record.
 */
export function sampleFromSchema(raw: any, doc: any, depth = 0, idField = 'id'): unknown {
  const schema = resolve(raw, doc);

  if (!schema || depth > MAX_SAMPLE_DEPTH) {
    return null;
  }

  if (Array.isArray(schema.allOf)) {
    return Object.assign({}, ...schema.allOf.map((part: any) => sampleFromSchema(part, doc, depth + 1, idField)));
  }

  const type = Array.isArray(schema.type) ? schema.type.find((entry: string) => entry !== 'null') : schema.type;

  if (type === 'object' || schema.properties) {
    const required = new Set<string>(schema.required ?? []);
    const result: Record<string, unknown> = {};

    for (const [name, prop] of Object.entries<any>(schema.properties ?? {})) {
      // Only the record's own id is unique. Other *Id fields reference
      // existing records (an order's petId); a random one points at
      // nothing, so they keep the spec's example like any field.
      const isId = name === idField || name === 'id';

      // Ids are always set uniquely: an omitted id lets some servers
      // reuse one, and the spec's example id is usually a real record.
      if (isId && ['integer', 'number'].includes(resolve(prop, doc)?.type)) {
        result[name] = UNIQUE_NUMBER;
      } else if (isId) {
        result[name] = UNIQUE_STRING;
      } else if (required.has(name)) {
        const value = resolve(prop, doc);

        result[name] =
          value?.example !== undefined && value?.type !== 'string'
            ? value.example
            : sampleFromSchema(prop, doc, depth + 1, idField);
      }
    }

    return result;
  }

  if (schema.enum?.length) {
    return schema.enum[0];
  }

  switch (type) {
    case 'string':
      if (schema.format === 'email') return `${UNIQUE_STRING}@example.com`;
      if (schema.format === 'date-time') return new Date(0).toISOString();
      if (schema.format === 'date') return '1970-01-01';
      if (schema.format === 'uri' || schema.format === 'url') return `https://example.com/${UNIQUE_STRING}`;
      return UNIQUE_STRING;

    case 'integer':
    case 'number':
      return schema.example ?? schema.default ?? schema.minimum ?? 1;

    case 'boolean':
      return schema.default ?? false;

    case 'array':
      return schema.items ? [sampleFromSchema(schema.items, doc, depth + 1, idField)] : [];
  }

  return null;
}

// --------------------------------------------------
// GENERATION
// --------------------------------------------------

function literal(value: unknown): string {
  return JSON.stringify(value);
}

export function crudSpecSource(plan: CrudPlan, shapeHelper: string): string {
  const auth = plan.authHeader ? `, headers: { ${literal(plan.authHeader.name)}: credential() }` : '';
  const authOnly = plan.authHeader ? `{ headers: { ${literal(plan.authHeader.name)}: credential() } }` : '{}';
  const itemUrl = (path: string, param: string) =>
    `SERVER + ${literal(path.split(`{${param}}`)[0])} + encodeURIComponent(String(id))`;

  const title = `${plan.resource}: create, read back${plan.update ? ', update' : ''}${plan.remove ? ', delete' : ''}`;

  return `/**
 * Generated by Qyntra API Test Generator — WRITE PATH. Do not edit:
 * regenerated on every \`qyntra run\`.
 *
 * Creates, reads${plan.update ? ', updates' : ''}${plan.remove ? ' and deletes' : ''} a record in ${plan.resource}, because
 * api.mutations is enabled for ${plan.allowedHosts.join(', ')}. Records
 * carry unique ids and a "qyntra-test-" marker, and are deleted in
 * \`finally\` even when an assertion fails.
 */

import { test, expect } from '@playwright/test';

const SERVER = ${literal(plan.server)};
const ALLOWED_HOSTS: string[] = ${literal(plan.allowedHosts)};
const BODY_TEMPLATE: unknown = ${JSON.stringify(plan.body, null, 2)};
const ECHO_FIELDS: string[] = ${literal(plan.echoFields)};
${plan.responseShape ? `\nconst SHAPE: Shape = ${JSON.stringify(plan.responseShape, null, 2)};\n` : ''}
test(${literal(title)}, async ({ request }) => {
  // Checked again at runtime, so a hand-edited SERVER cannot bypass the
  // allowlist. (A changed api.baseUrl is refused at generation.)
  const host = new URL(SERVER).hostname;

  if (!ALLOWED_HOSTS.includes(host)) {
    throw new Error('Refusing to write to ' + host + ': not in api.mutations.allowedHosts.');
  }

  const marker = 'qyntra-test-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const unique = Number(String(Date.now()).slice(-9)) + Math.floor(Math.random() * 1000);
  const body = fill(BODY_TEMPLATE, marker, unique) as Record<string, unknown>;

  const created = await request.post(SERVER + ${literal(plan.create.path)}, { data: body${auth} });
  expect(created.status(), 'create').toBe(${plan.create.status});

  const record = await created.json();
${plan.responseShape ? `  expectShape(record, SHAPE, 'created');\n` : ''}
  const id = record?.[${literal(plan.idField)}] ?? body[${literal(plan.idField)}];
  expect(id, 'the created record has an id').toBeDefined();

  let deleted = false;

  try {
    const read = await request.get(${itemUrl(plan.read!.path, plan.read!.param)}, ${authOnly});
    expect(read.status(), 'read back').toBe(${plan.read!.status});

    const stored = await read.json();

    // What was sent is what was stored.
    for (const field of ECHO_FIELDS) {
      expect(stored?.[field], 'stored ' + field).toBe(body[field]);
    }
${
  plan.update
    ? `
    const changed = { ...stored, ${literal(plan.update.field)}: marker + '-updated' };
    const updated = await request.${plan.update.method.toLowerCase()}(${
        plan.update.path === plan.create.path ? `SERVER + ${literal(plan.create.path)}` : itemUrl(plan.update.path, plan.read!.param)
      }, { data: changed${auth} });
    expect(updated.status(), 'update').toBe(${plan.update.status});

    const reread = await request.get(${itemUrl(plan.read!.path, plan.read!.param)}, ${authOnly});
    expect((await reread.json())?.[${literal(plan.update.field)}], 'update was stored').toBe(marker + '-updated');
`
    : ''
}${
  plan.remove
    ? `
    const removed = await request.delete(${itemUrl(plan.remove.path, plan.remove.param)}, ${authOnly});
    expect(removed.status(), 'delete').toBe(${plan.remove.status});
    deleted = true;
${
  plan.remove.notFound
    ? `
    const gone = await request.get(${itemUrl(plan.read!.path, plan.read!.param)}, ${authOnly});
    expect(gone.status(), 'a deleted record is gone').toBe(404);
`
    : ''
}`
    : ''
}  } finally {
${
  plan.remove
    ? `    // Never leave test data behind, whatever failed above.
    if (!deleted) {
      await request.delete(${itemUrl(plan.remove.path, plan.remove.param)}, ${authOnly}).catch(() => undefined);
    }`
    : `    // The spec documents no delete: this record stays. Its marker is
    // in the test output so it can be found and removed.
    console.log('Left behind (no DELETE in the spec): ' + marker);`
}
  }
});

/** Replace the unique-value placeholders, at any depth. */
function fill(template: unknown, marker: string, unique: number): unknown {
  if (template === ${literal(UNIQUE_NUMBER)}) {
    return unique;
  }

  if (typeof template === 'string') {
    return template.split(${literal(UNIQUE_STRING)}).join(marker);
  }

  if (Array.isArray(template)) {
    return template.map((item) => fill(item, marker, unique));
  }

  if (template && typeof template === 'object') {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, fill(value, marker, unique)]));
  }

  return template;
}
${
  plan.authHeader
    ? `
function credential(): string {
  const value = process.env[${literal(plan.authHeader.env)}];

  if (!value) {
    throw new Error(${literal(`${plan.authHeader.env} is not set (api.auth in .qyntra/config.json).`)});
  }

  return value;
}
`
    : ''
}${plan.responseShape ? shapeHelper : ''}`;
}

// --------------------------------------------------
// SPEC HELPERS
// --------------------------------------------------

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolve(value: any, doc: any): any {
  let current = value;
  const seen = new Set<string>();

  while (current && typeof current.$ref === 'string' && current.$ref.startsWith('#/') && !seen.has(current.$ref)) {
    seen.add(current.$ref);
    current = current.$ref
      .slice(2)
      .split('/')
      .reduce((node: any, part: string) => node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
  }

  return current;
}

function jsonSchema(holder: any, doc: any): any {
  const content = resolve(holder, doc)?.content ?? {};
  const type = Object.keys(content).find((name) => /json/.test(name));

  return type ? content[type]?.schema : undefined;
}

function successStatus(operation: any): number {
  const codes = Object.keys(operation?.responses ?? {}).filter((code) => /^2\d\d$/.test(code)).sort();

  return Number(codes.includes('200') ? '200' : codes[0] ?? 200);
}

function isSecured(operation: any, doc: any): boolean {
  const requirements = operation.security ?? doc.security ?? [];

  return (
    Array.isArray(requirements) &&
    requirements.length > 0 &&
    !requirements.some((requirement: any) => Object.keys(requirement ?? {}).length === 0)
  );
}
