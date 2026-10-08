/**
 * OpenAPI input: test what the API documents, not only what a browser
 * happened to call.
 *
 * Turns an OpenAPI 3.x document into the same ApiCall plan that
 * observed traffic produces, so lib/api-tests generates both the same
 * way. The spec is the stronger source where it exists: it says which
 * fields are *required* (observation can only guess from samples),
 * which operations need authentication, and which return 404.
 *
 * Read-only, like observed traffic. Writes are listed, never called,
 * and GETs that look state-changing or credential-bearing are skipped
 * too: specs document `GET /logout` and `GET /login?password=` often
 * enough that "GET is safe" cannot be trusted on its own.
 */

import { pathTemplate, type ApiCall, type Shape } from './api-observation';
import type { SkippedApiCall } from './api-tests';

export interface OpenApiOptions {
  /** Where the spec came from; relative server URLs resolve against it. */
  specLocation?: string;

  /** Overrides the spec's servers[0]. */
  baseUrl?: string;

  /** Fallback base when the spec gives no usable server. */
  appBaseUrl?: string;

  /** Values for required parameters, by name: { "petId": "10" }. */
  parameters?: Record<string, string>;

  /** Path substrings to leave out: ["/admin", "/internal"]. */
  exclude?: string[];

  /** Credential for secured operations: header name + env var. */
  auth?: { header: string; env: string };
}

export interface OpenApiPlan {
  title: string;
  version: string;
  server: string;
  calls: ApiCall[];
  skipped: SkippedApiCall[];
  /** Operations in the document, before filtering. */
  totalOperations: number;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

/** GETs whose name says they change state or carry credentials. */
const RISKY_OPERATION =
  /log-?in|log-?out|sign-?in|sign-?out|auth(enticate|orize)?\b|token|session|password|delete|remove|reset|revoke|unsubscribe|activate|confirm|verify|approve|cancel|purge|clear/i;

const SENSITIVE_PARAM =
  /token|key|secret|pass|auth|session|sig|signature|credential|jwt|nonce/i;

const MAX_SCHEMA_DEPTH = 6;

/** Values unlikely to exist, for documented-404 tests. */
const UNKNOWN_INTEGER = '987654321987';
const UNKNOWN_STRING = 'qyntra-unknown-id';

export class OpenApiError extends Error {}

export function planFromOpenApi(
  doc: any,
  options: OpenApiOptions = {}
): OpenApiPlan {
  const version = String(doc?.openapi ?? '');

  if (doc?.swagger) {
    throw new OpenApiError(
      `Swagger ${doc.swagger} documents are not supported; Qyntra reads OpenAPI 3.x. ` +
        'Convert with: npx swagger2openapi spec.json -o openapi.json'
    );
  }

  if (!/^3\./.test(version)) {
    throw new OpenApiError(
      `Not an OpenAPI 3.x document (openapi: ${version || 'missing'}).`
    );
  }

  const server = resolveServer(doc, options);
  const calls: ApiCall[] = [];
  const skipped: SkippedApiCall[] = [];
  let totalOperations = 0;

  for (const [rawPath, pathItem] of Object.entries<any>(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem?.[method];

      if (!operation) {
        continue;
      }

      totalOperations += 1;

      const label = `${method.toUpperCase()} ${rawPath}`;
      const skip = (reason: string) => skipped.push({ call: label, reason });

      if ((options.exclude ?? []).some((part) => part && rawPath.includes(part))) {
        skip('Excluded by api.exclude.');
        continue;
      }

      if (method !== 'get') {
        skip(
          method === 'head' || method === 'options'
            ? 'Only GET operations are tested.'
            : 'Mutating operation: calling it would change real data.'
        );
        continue;
      }

      if (operation.deprecated) {
        skip('Deprecated in the spec.');
        continue;
      }

      const name = `${rawPath} ${operation.operationId ?? ''}`;

      if (RISKY_OPERATION.test(name)) {
        skip('A GET whose name suggests it changes state or handles credentials.');
        continue;
      }

      // Path-level parameters apply to every operation under the path;
      // operation-level ones override by name + location.
      const parameters = mergeParameters(
        resolveRefs(pathItem.parameters ?? [], doc),
        resolveRefs(operation.parameters ?? [], doc)
      );

      if (parameters.some((param) => SENSITIVE_PARAM.test(String(param.name)))) {
        skip('Takes a credential-like parameter; Qyntra does not send secrets in requests.');
        continue;
      }

      const values = new Map<string, string>();
      let missing: string | undefined;

      for (const param of parameters) {
        if (!param.required && param.in !== 'path') {
          continue;
        }

        if (param.in === 'header' || param.in === 'cookie') {
          missing = `required ${param.in} "${param.name}"`;
          break;
        }

        const value = parameterValue(param, doc, options.parameters ?? {});

        if (value === undefined) {
          missing = `a value for ${param.in} parameter "${param.name}"`;
          break;
        }

        values.set(`${param.in}:${param.name}`, value);
      }

      if (missing) {
        skip(
          `Needs ${missing}: add an example to the spec, or set ` +
            `api.parameters in .qyntra/config.json.`
        );
        continue;
      }

      const secured = isSecured(operation, doc);
      const response = successResponse(operation, doc);

      if (!response) {
        skip('Documents no 2xx response to check against.');
        continue;
      }

      const url = buildUrl(server, rawPath, parameters, values);

      const call: ApiCall = {
        method: 'GET',
        url,
        // The spec's own names ({petId}) read better in test titles;
        // matching against observed calls normalises them anyway.
        template: pathTemplate(rawPath),
        status: response.status,
        contentType: response.contentType,
        durationMs: 0,
        auth: secured ? 'header' : 'none',
        source: 'openapi',
        operation: String(operation.summary ?? operation.operationId ?? '').trim() || undefined,
        ...(response.shape ? { responseShape: response.shape } : {}),
        ...(secured && options.auth
          ? { authHeader: { name: options.auth.header, env: options.auth.env } }
          : {}),
      };

      const notFound = notFoundCheck(operation, doc, server, rawPath, parameters, values);

      if (notFound && (!secured || options.auth)) {
        call.notFound = notFound;
      }

      calls.push(call);
    }
  }

  return {
    title: String(doc.info?.title ?? 'API'),
    version: String(doc.info?.version ?? ''),
    server,
    calls,
    skipped,
    totalOperations,
  };
}

// --------------------------------------------------
// SERVERS AND URLS
// --------------------------------------------------

function resolveServer(doc: any, options: OpenApiOptions): string {
  const candidate =
    options.baseUrl ??
    substituteServerVariables(doc.servers?.[0]) ??
    '';

  const bases = [
    /^https?:/.test(options.specLocation ?? '') ? options.specLocation : undefined,
    options.appBaseUrl,
  ].filter(Boolean) as string[];

  try {
    return trimSlash(new URL(candidate).toString());
  } catch {
    for (const base of bases) {
      try {
        return trimSlash(new URL(candidate || '/', base).toString());
      } catch {
        // Try the next base.
      }
    }
  }

  throw new OpenApiError(
    'Cannot work out the API base URL: the spec has no absolute server URL. ' +
      'Set api.baseUrl in .qyntra/config.json.'
  );
}

function substituteServerVariables(server: any): string | undefined {
  if (!server?.url) {
    return undefined;
  }

  return String(server.url).replace(/\{([^}]+)\}/g, (_match, name: string) =>
    String(server.variables?.[name]?.default ?? '')
  );
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function buildUrl(
  server: string,
  rawPath: string,
  parameters: any[],
  values: Map<string, string>
): string {
  const pathPart = rawPath.replace(/\{([^}]+)\}/g, (_match, name: string) =>
    encodeURIComponent(values.get(`path:${name}`) ?? '')
  );

  const query = new URLSearchParams();

  for (const param of parameters) {
    if (param.in !== 'query') {
      continue;
    }

    const value = values.get(`query:${param.name}`);

    if (value !== undefined) {
      query.append(param.name, value);
    }
  }

  const search = query.toString();

  return `${server}${pathPart}${search ? `?${search}` : ''}`;
}

// --------------------------------------------------
// PARAMETERS
// --------------------------------------------------

function mergeParameters(pathLevel: any[], operationLevel: any[]): any[] {
  const key = (param: any) => `${param.in}:${param.name}`;
  const overridden = new Set(operationLevel.map(key));

  return [...pathLevel.filter((param) => !overridden.has(key(param))), ...operationLevel];
}

/**
 * A value for a required parameter: configured first, then whatever
 * the spec offers — example, examples, schema example, default, enum.
 */
function parameterValue(
  param: any,
  doc: any,
  configured: Record<string, string>
): string | undefined {
  if (configured[param.name] !== undefined) {
    return String(configured[param.name]);
  }

  const schema = resolveRef(param.schema ?? {}, doc);

  const firstExample = param.examples
    ? (Object.values<any>(param.examples)[0] as any)
    : undefined;

  const candidates = [
    param.example,
    resolveRef(firstExample ?? {}, doc)?.value,
    schema.example,
    schema.examples?.[0],
    schema.default,
    schema.enum?.[0],
    schema.items ? resolveRef(schema.items, doc).example : undefined,
    schema.items ? resolveRef(schema.items, doc).enum?.[0] : undefined,
  ];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) {
      continue;
    }

    return Array.isArray(candidate) ? String(candidate[0]) : String(candidate);
  }

  return undefined;
}

function notFoundCheck(
  operation: any,
  doc: any,
  server: string,
  rawPath: string,
  parameters: any[],
  values: Map<string, string>
): ApiCall['notFound'] {
  if (!operation.responses?.['404']) {
    return undefined;
  }

  const pathParams = parameters.filter((param) => param.in === 'path');

  if (pathParams.length === 0) {
    return undefined;
  }

  // Replace the last path parameter only: /users/{u}/orders/{id} with a
  // real user and an unknown order isolates what is "not found".
  const target = pathParams[pathParams.length - 1];
  const schema = resolveRef(target.schema ?? {}, doc);
  const unknown =
    schema.type === 'integer' || schema.type === 'number' ? UNKNOWN_INTEGER : UNKNOWN_STRING;

  const unknownValues = new Map(values);
  unknownValues.set(`path:${target.name}`, unknown);

  return { url: buildUrl(server, rawPath, parameters, unknownValues), status: 404 };
}

// --------------------------------------------------
// SECURITY AND RESPONSES
// --------------------------------------------------

/** Operation-level security wins; `security: []` explicitly opts out. */
function isSecured(operation: any, doc: any): boolean {
  const requirements = operation.security ?? doc.security ?? [];

  return (
    Array.isArray(requirements) &&
    requirements.length > 0 &&
    // [{}] means "anonymous allowed" as one of the alternatives.
    !requirements.some((requirement: any) => Object.keys(requirement ?? {}).length === 0)
  );
}

function successResponse(
  operation: any,
  doc: any
): { status: number; contentType: string; shape?: Shape } | undefined {
  const codes = Object.keys(operation.responses ?? {})
    .filter((code) => /^2\d\d$/.test(code))
    .sort();

  const code = codes.includes('200') ? '200' : codes[0];

  if (!code) {
    return undefined;
  }

  const response = resolveRef(operation.responses[code], doc);
  const content = response?.content ?? {};

  const jsonType = Object.keys(content).find((type) => /json/.test(type));

  if (!jsonType) {
    return { status: Number(code), contentType: '' };
  }

  const schema = content[jsonType]?.schema;

  return {
    status: Number(code),
    contentType: jsonType === '*/*' ? '' : jsonType.split(';')[0],
    ...(schema ? { shape: schemaToShape(schema, doc) } : {}),
  };
}

// --------------------------------------------------
// SCHEMAS
// --------------------------------------------------

/**
 * JSON Schema → Shape. Only `required` properties are asserted — the
 * spec says the others may be absent. oneOf/anyOf cannot be checked
 * structurally without a full validator, so they become 'any'.
 */
export function schemaToShape(
  raw: any,
  doc: any,
  depth = 0,
  seen: Set<string> = new Set()
): Shape {
  if (!raw || depth > MAX_SCHEMA_DEPTH) {
    return { type: 'any' };
  }

  if (typeof raw.$ref === 'string') {
    // A recursive schema (Category.parent: Category) stops at the cycle.
    if (seen.has(raw.$ref)) {
      return { type: 'any' };
    }

    return schemaToShape(resolveRef(raw, doc), doc, depth, new Set([...seen, raw.$ref]));
  }

  if (Array.isArray(raw.allOf)) {
    const parts = raw.allOf.map((part: any) => schemaToShape(part, doc, depth + 1, seen));
    const properties: Record<string, Shape> = {};

    for (const part of parts) {
      if (part.type === 'object') {
        Object.assign(properties, part.properties);
      }
    }

    return { type: 'object', properties };
  }

  if (raw.oneOf || raw.anyOf) {
    return { type: 'any' };
  }

  // OpenAPI 3.1: type: ["string", "null"].
  const type = Array.isArray(raw.type)
    ? raw.type.find((entry: string) => entry !== 'null')
    : raw.type;

  switch (type) {
    case 'string':
      return { type: 'string' };

    case 'integer':
    case 'number':
      return { type: 'number' };

    case 'boolean':
      return { type: 'boolean' };

    case 'array':
      return raw.items
        ? { type: 'array', items: schemaToShape(raw.items, doc, depth + 1, seen) }
        : { type: 'array' };
  }

  if (type === 'object' || raw.properties) {
    const required = new Set<string>(Array.isArray(raw.required) ? raw.required : []);
    const properties: Record<string, Shape> = {};

    for (const [key, child] of Object.entries<any>(raw.properties ?? {})) {
      if (required.has(key)) {
        properties[key] = schemaToShape(child, doc, depth + 1, seen);
      }
    }

    return { type: 'object', properties };
  }

  return { type: 'any' };
}

/** Resolve a local `#/...` reference; external refs are not followed. */
function resolveRef(value: any, doc: any): any {
  let current = value;
  const visited = new Set<string>();

  while (current && typeof current.$ref === 'string') {
    const ref: string = current.$ref;

    if (!ref.startsWith('#/') || visited.has(ref)) {
      return {};
    }

    visited.add(ref);

    current = ref
      .slice(2)
      .split('/')
      .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce((node: any, part) => node?.[part], doc);
  }

  return current ?? {};
}

function resolveRefs(values: any[], doc: any): any[] {
  return values.map((value) => resolveRef(value, doc));
}
