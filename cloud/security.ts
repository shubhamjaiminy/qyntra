/**
 * Passwords, sessions, API tokens and CSRF for Qyntra Cloud.
 *
 * Only hashes are stored: a leaked database yields no usable password,
 * session or token. Session ids and API tokens are 256-bit random values
 * hashed with SHA-256 (they are not guessable, so a slow hash adds
 * nothing); passwords use scrypt because people choose guessable ones.
 */

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

// --------------------------------------------------
// PASSWORDS
// --------------------------------------------------

const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 64 };

export const MIN_PASSWORD_LENGTH = 10;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, cost, salt, hash] = stored.split('$');

  if (scheme !== 'scrypt' || !salt || !hash) {
    return false;
  }

  const expected = Buffer.from(hash, 'base64url');
  const actual = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length, { N: Number(cost), r: SCRYPT.r, p: SCRYPT.p });

  return timingSafeEqual(actual, expected);
}

/** A reason the password is unacceptable, or undefined. */
export function passwordProblem(password: string, email: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 200) return 'Use at most 200 characters.';
  if (email && password.toLowerCase().includes(email.split('@')[0].toLowerCase())) return 'Do not include your email address in the password.';
  return undefined;
}

// --------------------------------------------------
// RANDOM SECRETS
// --------------------------------------------------

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** A project token: shown once, stored as a hash, recognisable in logs. */
export function newApiToken(): { token: string; hash: string; prefix: string } {
  const token = `qy_live_${randomSecret(24)}`;
  return { token, hash: sha256(token), prefix: token.slice(0, 12) };
}

// --------------------------------------------------
// SESSIONS AND CSRF
// --------------------------------------------------

export const SESSION_COOKIE = 'qy_session';
export const SESSION_DAYS = 30;

export function newSession(): { id: string; hash: string; expiresAt: string } {
  const id = randomSecret(32);
  return { id, hash: sha256(id), expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString() };
}

/**
 * CSRF token bound to the session: an HMAC of its id with the server
 * secret. Valid for exactly one session, stores nothing, and cannot be
 * forged without the secret.
 */
export function csrfToken(sessionId: string, secret: string): string {
  return createHmac('sha256', secret).update(`csrf:${sessionId}`).digest('base64url');
}

export function csrfValid(sessionId: string, token: string | undefined, secret: string): boolean {
  if (!token) return false;

  const expected = Buffer.from(csrfToken(sessionId, secret));
  const actual = Buffer.from(token);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};

  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) {
      const name = part.slice(0, index).trim();
      try {
        cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        // A malformed cookie is ignored, not fatal.
      }
    }
  }

  return cookies;
}

export function sessionCookie(id: string, secure: boolean, maxAgeSeconds = SESSION_DAYS * 86_400): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(id)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

// --------------------------------------------------
// RATE LIMITING
// --------------------------------------------------

/**
 * Fixed-window counter per key, in memory. Enough for one server; a
 * multi-instance deployment would move this to the database.
 */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** True when the request is allowed. */
  take(key: string, at = Date.now()): boolean {
    const window = this.windows.get(key);

    if (!window || at - window.start >= this.windowMs) {
      this.windows.set(key, { start: at, count: 1 });
      if (this.windows.size > 10_000) this.sweep(at);
      return true;
    }

    window.count += 1;
    return window.count <= this.limit;
  }

  private sweep(at: number): void {
    for (const [key, window] of this.windows) {
      if (at - window.start >= this.windowMs) this.windows.delete(key);
    }
  }
}
