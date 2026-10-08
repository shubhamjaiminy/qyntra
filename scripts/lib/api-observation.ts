/**
 * API observation: what the application's own API calls look like.
 *
 * Discovery watches the XHR/fetch traffic a real page makes and keeps,
 * per call, what a contract test needs — method, path, status, content
 * type, timing and the *shape* of the JSON response. Shapes are key
 * names and types only: no values are stored, so an application map
 * never captures customer data from an API response.
 */

export type Shape =
  | { type: 'string' | 'number' | 'boolean' | 'any' }
  | { type: 'array'; items?: Shape }
  | { type: 'object'; properties: Record<string, Shape> };

export interface ApiCall {
  method: string;

  /** Replayable URL: origin, path and non-sensitive query parameters. */
  url: string;

  /** Path with ids generalised: /api/articles/{id}. Used to dedupe. */
  template: string;

  status: number;
  contentType: string;
  durationMs: number;

  /** How the request authenticated, as far as discovery could see. */
  auth: 'none' | 'header' | 'cookie';

  /** Shape of the JSON body; absent for non-JSON or oversized bodies. */
  responseShape?: Shape;
}

const MAX_DEPTH = 5;
const MAX_PROPERTIES = 40;
const MAX_ARRAY_SAMPLE = 20;

/** Query parameter names whose values must never be stored or replayed. */
const SENSITIVE_PARAM =
  /token|key|secret|pass|auth|session|sig|signature|code|credential|jwt|nonce|email|phone/i;

/** Analytics, monitoring and ad traffic: not the application's API. */
const NOISE_HOST =
  /google-analytics|googletagmanager|doubleclick|segment\.(io|com)|sentry|hotjar|mixpanel|amplitude|datadoghq|newrelic|nr-data|fullstory|intercom|hubspot|clarity\.ms|facebook\.(com|net)|cloudflareinsights|launchdarkly|optimizely|stripe\.network|recaptcha/i;

const NOISE_PATH = /^\/cdn-cgi\/|\/(collect|beacon|analytics|telemetry|track|rum|metrics|log|events?)(\/|$)/i;

/** Numbers, UUIDs and long hex strings always identify a record. */
const ID_SEGMENT =
  /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;

/**
 * Generated identifiers (Mongo ids, nanoids, slugs with a numeric
 * suffix) are long and contain digits. Readable resource names such as
 * "notification-preferences" do not, and must stay distinct endpoints.
 */
function isIdSegment(segment: string): boolean {
  if (ID_SEGMENT.test(segment)) {
    return true;
  }

  return (
    segment.length >= 16 &&
    /^[A-Za-z0-9_-]+$/.test(segment) &&
    /\d/.test(segment) &&
    // "how-to-train-your-dragon-4721": readable words, generated suffix.
    (!segment.includes('-') || /-[0-9a-z]*\d[0-9a-z]*$/i.test(segment))
  );
}

export function isNoise(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return NOISE_HOST.test(url.hostname) || NOISE_PATH.test(url.pathname);
  } catch {
    return true;
  }
}

export function pathTemplate(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => (isIdSegment(segment) ? '{id}' : segment))
    .join('/');
}

/**
 * Origin + path + query, minus parameters that look like credentials or
 * personal data. Keeps `limit=10&offset=0` so the call is replayable.
 */
export function replayableUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  const kept = new URLSearchParams();

  for (const [name, value] of url.searchParams) {
    if (!SENSITIVE_PARAM.test(name)) {
      kept.append(name, value);
    }
  }

  const query = kept.toString();

  return `${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
}

/** The shape of a JSON value: key names and types, never values. */
export function shapeOf(value: unknown, depth = 0): Shape {
  if (value === null || value === undefined || depth > MAX_DEPTH) {
    // null says nothing about the type the field normally has.
    return { type: 'any' };
  }

  if (Array.isArray(value)) {
    const sample = value.slice(0, MAX_ARRAY_SAMPLE).map((item) => shapeOf(item, depth + 1));

    return sample.length === 0
      ? { type: 'array' }
      : { type: 'array', items: sample.reduce(mergeShapes) };
  }

  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return { type: typeof value as 'string' | 'number' | 'boolean' };

    case 'object': {
      const properties: Record<string, Shape> = {};

      for (const [key, child] of Object.entries(value as object).slice(0, MAX_PROPERTIES)) {
        properties[key] = shapeOf(child, depth + 1);
      }

      return { type: 'object', properties };
    }

    default:
      return { type: 'any' };
  }
}

/**
 * Combine two observations of the same field. Object keys present in
 * only one become optional (dropped: a contract test asserts only what
 * every observation agreed on), and conflicting types become 'any'.
 */
export function mergeShapes(a: Shape, b: Shape): Shape {
  if (a.type === 'any' || b.type === 'any') {
    // A null in one record and a string in another: the field is a
    // nullable string, which 'any' with null tolerance describes.
    return a.type === 'any' ? b : a;
  }

  if (a.type !== b.type) {
    return { type: 'any' };
  }

  if (a.type === 'array' && b.type === 'array') {
    if (!a.items || !b.items) {
      return { type: 'array', ...(a.items ?? b.items ? { items: a.items ?? b.items } : {}) };
    }

    return { type: 'array', items: mergeShapes(a.items, b.items) };
  }

  if (a.type === 'object' && b.type === 'object') {
    const properties: Record<string, Shape> = {};

    for (const key of Object.keys(a.properties)) {
      if (key in b.properties) {
        properties[key] = mergeShapes(a.properties[key], b.properties[key]);
      }
    }

    return { type: 'object', properties };
  }

  return a;
}

/**
 * One call per method + template, preferring a successful observation
 * with a body over a failed or empty one.
 */
export function dedupeCalls(calls: ApiCall[]): ApiCall[] {
  const byKey = new Map<string, ApiCall>();

  const rank = (call: ApiCall) =>
    (call.status >= 200 && call.status < 300 ? 2 : 0) + (call.responseShape ? 1 : 0);

  for (const call of calls) {
    const key = `${call.method} ${new URL(call.url).origin}${call.template}`;
    const existing = byKey.get(key);

    if (!existing || rank(call) > rank(existing)) {
      byKey.set(key, call);
    }
  }

  return [...byKey.values()];
}
