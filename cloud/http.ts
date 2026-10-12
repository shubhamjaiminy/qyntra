/**
 * Minimal HTTP layer for Qyntra Cloud: routing, body parsing, cookies,
 * security headers, and HTML that escapes by default.
 *
 * No framework: the surface is small, and every byte that reaches a
 * customer's browser passes through `html`, which escapes interpolated
 * values unless they are already-built markup. Test names and error
 * messages come from customers' apps; a test titled "<script>" must
 * render as text.
 */

import type { IncomingMessage, ServerResponse } from 'http';

import { parseCookies } from './security';

// --------------------------------------------------
// HTML
// --------------------------------------------------

export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type Interpolation = SafeHtml | string | number | boolean | null | undefined | Interpolation[];

function render(value: Interpolation): string {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(value);
}

/** Tagged template: `html\`<p>${name}</p>\`` escapes `name`. */
export function html(strings: TemplateStringsArray, ...values: Interpolation[]): SafeHtml {
  let out = strings[0];
  values.forEach((value, index) => {
    out += render(value) + strings[index + 1];
  });
  return new SafeHtml(out);
}

/** Markup built elsewhere and known to be safe, e.g. a static SVG. */
export const raw = (markup: string): SafeHtml => new SafeHtml(markup);

// --------------------------------------------------
// REQUEST AND RESPONSE
// --------------------------------------------------

export interface Request {
  method: string;
  url: URL;
  path: string;
  headers: IncomingMessage['headers'];
  cookies: Record<string, string>;
  /** Parsed JSON or form body. */
  body: Record<string, unknown>;
  rawBody: string;
  params: Record<string, string>;
  ip: string;
}

export interface Response {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
}

export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  // No scripts at all: every page is plain HTML and forms.
  'content-security-policy': "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

export function htmlResponse(body: SafeHtml, status = 200, headers: Record<string, string | string[]> = {}): Response {
  return { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers }, body: body.value };
}

export function jsonResponse(value: unknown, status = 200, headers: Record<string, string | string[]> = {}): Response {
  return { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }, body: JSON.stringify(value) };
}

export function redirect(location: string, headers: Record<string, string | string[]> = {}): Response {
  return { status: 303, headers: { location, ...headers }, body: '' };
}

export async function readRequest(incoming: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of incoming) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }

  const rawBody = Buffer.concat(chunks).toString('utf-8');
  const type = String(incoming.headers['content-type'] ?? '');
  let body: Record<string, unknown> = {};

  if (rawBody !== '') {
    if (type.includes('application/json')) {
      try {
        const parsed = JSON.parse(rawBody);
        body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        throw new HttpError(400, 'Body is not valid JSON.');
      }
    } else if (type.includes('application/x-www-form-urlencoded')) {
      body = Object.fromEntries(new URLSearchParams(rawBody));
    }
  }

  const url = new URL(incoming.url ?? '/', 'http://localhost');
  const forwarded = String(incoming.headers['x-forwarded-for'] ?? '').split(',')[0].trim();

  return {
    method: (incoming.method ?? 'GET').toUpperCase(),
    url,
    path: url.pathname.replace(/\/+$/, '') || '/',
    headers: incoming.headers,
    cookies: parseCookies(incoming.headers.cookie),
    body,
    rawBody,
    params: {},
    ip: forwarded || incoming.socket.remoteAddress || 'unknown',
  };
}

export function writeResponse(outgoing: ServerResponse, response: Response): void {
  outgoing.writeHead(response.status, { ...SECURITY_HEADERS, ...response.headers });
  outgoing.end(response.body);
}

// --------------------------------------------------
// ROUTING
// --------------------------------------------------

export type Handler = (request: Request) => Response | Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/\/:([a-zA-Z]+)/g, (_match, key: string) => {
        keys.push(key);
        return '/([^/]+)';
      })}$`
    );

    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  get(path: string, handler: Handler): this {
    return this.add('GET', path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.add('POST', path, handler);
  }

  /** The handler for a request, with its params filled in; 405 when only the method is wrong. */
  match(request: Request): Handler | 'method-not-allowed' | undefined {
    let pathMatched = false;

    for (const route of this.routes) {
      const found = route.pattern.exec(request.path);
      if (!found) continue;

      pathMatched = true;
      if (route.method !== request.method && !(route.method === 'GET' && request.method === 'HEAD')) continue;

      request.params = Object.fromEntries(route.keys.map((key, index) => [key, decodeURIComponent(found[index + 1])]));
      return route.handler;
    }

    return pathMatched ? 'method-not-allowed' : undefined;
  }
}

export function field(request: Request, name: string, max = 500): string {
  const value = request.body[name];
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
