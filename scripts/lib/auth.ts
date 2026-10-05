/**
 * Application authentication.
 *
 * Most customer applications put everything worth testing behind a
 * login. Qyntra logs in once with a real browser, proves the login
 * worked, and saves the session as a Playwright storage state that
 * discovery and test execution then reuse.
 *
 * Two constraints shape this module:
 *
 *  - The session file is a live credential (cookies, tokens). It is
 *    written under .qyntra/.auth, never into the artifact directory,
 *    because CI uploads that directory as a build artifact.
 *
 *  - A login that silently fails is worse than one that loudly fails:
 *    every downstream stage would "test" the login page and report
 *    plausible nonsense. So success must be positively observed.
 */

import fs from 'fs';
import path from 'path';

import {
  chromium,
  devices,
  type BrowserContextOptions,
  type Locator,
  type Page,
} from '@playwright/test';

import type { AuthConfig, QyntraConfig } from './config';
import { AuthenticationError, ConfigError } from './exit-codes';
import { redact } from './logger';

/** Env var through which the CLI hands the session to spawned stages. */
export const STORAGE_STATE_ENV = 'QYNTRA_STORAGE_STATE';

/**
 * Browser profile shared by login, discovery and test execution.
 *
 * Many apps bind a session to the user agent as anti-hijacking
 * protection (Rack::Protection, most banking stacks). A session captured
 * under Playwright's default headless UA is then rejected when tests
 * replay it as "Desktop Chrome", and every test silently lands back on
 * the login page. Some also check Accept-Language, which Playwright Test
 * sends (locale en-US) and a bare browser context does not. Matching the
 * default Playwright Test project on both avoids that.
 */
export const BROWSER_PROFILE: BrowserContextOptions = {
  ...devices['Desktop Chrome'],
  locale: 'en-US',
};

export interface AuthResult {
  storageStatePath: string;

  /** Where the browser landed after login. */
  landedUrl: string;
}

export function storageStatePath(
  config: QyntraConfig
): string {
  return path.join(
    config.rootDir,
    '.qyntra',
    '.auth',
    'storage-state.json'
  );
}

/**
 * Resolve app.auth.loginUrl, which may be a path relative to baseUrl.
 */
export function resolveLoginUrl(
  auth: AuthConfig,
  baseUrl: string
): string {
  return new URL(auth.loginUrl, baseUrl).toString();
}

function readCredentials(
  auth: AuthConfig
): { username: string; password: string } {
  const username = process.env[auth.usernameEnv];
  const password = process.env[auth.passwordEnv];

  const missing = [
    username ? undefined : auth.usernameEnv,
    password ? undefined : auth.passwordEnv,
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new ConfigError(
      `Login credentials not set: ${missing.join(', ')}`,
      'Export them in your shell or CI secret store. Qyntra never reads credentials from the config file.'
    );
  }

  return { username: username!, password: password! };
}

async function isVisible(
  locator: Locator
): Promise<boolean> {
  return locator.first().isVisible().catch(() => false);
}

/**
 * Best-effort extraction of the app's own error message, so a rejected
 * login reports "Invalid email or password" rather than a timeout.
 */
async function visibleLoginError(
  page: Page
): Promise<string | undefined> {
  const candidates = page.locator(
    '[role="alert"], [aria-live="assertive"], .error, .alert-danger, [class*="error" i]'
  );

  const count = Math.min(await candidates.count().catch(() => 0), 5);

  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);

    if (!(await isVisible(candidate))) {
      continue;
    }

    // Collapse whitespace so multi-line banners (text plus a close "×")
    // render as one log line.
    const text = (await candidate.innerText().catch(() => ''))
      .replace(/[×✕]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (text.length > 0 && text.length < 300) {
      return text;
    }
  }

  return undefined;
}

/**
 * Wait until login is positively confirmed.
 *
 * With successSelector: that element must appear. Without it: the
 * password field must disappear and the URL must leave the login page.
 * Both heuristics fail closed — an unchanged page is never success.
 */
async function waitForLoginSuccess(
  page: Page,
  auth: AuthConfig,
  loginUrl: string,
  timeoutMs: number
): Promise<boolean> {
  if (auth.successSelector) {
    return page
      .locator(auth.successSelector)
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(() => true)
      .catch(() => false);
  }

  const loginPath = new URL(loginUrl).pathname;
  const passwordField = page.locator(auth.passwordSelector);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const leftLoginPage = new URL(page.url()).pathname !== loginPath;

    if (leftLoginPage && !(await isVisible(passwordField))) {
      return true;
    }

    await page.waitForTimeout(250);
  }

  return false;
}

/**
 * Log in and persist the session.
 *
 * Supports single-page forms and two-step flows (username, continue,
 * then password) such as Auth0, Okta and Google.
 */
export async function authenticate(
  config: QyntraConfig
): Promise<AuthResult> {
  const auth = config.app.auth;

  if (!auth) {
    throw new ConfigError('authenticate() called without app.auth.');
  }

  const { username, password } = readCredentials(auth);
  const loginUrl = resolveLoginUrl(auth, config.app.baseUrl);
  const statePath = storageStatePath(config);
  const timeoutMs = config.discovery.timeoutMs;

  fs.mkdirSync(path.dirname(statePath), { recursive: true });

  const browser = await chromium.launch({
    headless: process.env.QYNTRA_HEADED !== '1',
  });

  // Playwright error messages can echo call arguments; scrub the
  // password from anything we rethrow into a CI log.
  const scrub = (message: string): string =>
    redact(message.split(password).join('***'));

  try {
    const context = await browser.newContext(BROWSER_PROFILE);
    const page = await context.newPage();

    await page.goto(loginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    const usernameField = page.locator(auth.usernameSelector).first();
    const passwordField = page.locator(auth.passwordSelector).first();
    const submitButton = page.locator(auth.submitSelector).first();

    try {
      await usernameField.waitFor({ state: 'visible', timeout: timeoutMs });
    } catch {
      throw new AuthenticationError(
        `Login form not found: app.auth.usernameSelector "${auth.usernameSelector}" matched nothing visible at ${page.url()}.`,
        'Open the login page, inspect the username field, and update the selector.'
      );
    }

    await usernameField.fill(username);

    // Two-step flows reveal the password field only after the username
    // is submitted.
    if (!(await isVisible(passwordField))) {
      await submitButton.click();
    }

    try {
      await passwordField.waitFor({ state: 'visible', timeout: timeoutMs });
    } catch {
      const appError = await visibleLoginError(page);

      throw new AuthenticationError(
        appError
          ? `Login rejected before the password step: "${appError}"`
          : `Login form incomplete: app.auth.passwordSelector "${auth.passwordSelector}" matched nothing visible at ${page.url()}.`,
        'Check the username and the password field selector.'
      );
    }

    await passwordField.fill(password);
    await submitButton.click();

    const succeeded = await waitForLoginSuccess(
      page,
      auth,
      loginUrl,
      timeoutMs
    );

    if (!succeeded) {
      const appError = await visibleLoginError(page);

      await page
        .screenshot({
          path: path.join(path.dirname(statePath), 'login-failure.png'),
        })
        .catch(() => undefined);

      throw new AuthenticationError(
        appError
          ? `Login rejected by the application: "${appError}"`
          : auth.successSelector
            ? `Login not confirmed: app.auth.successSelector "${auth.successSelector}" did not appear within ${timeoutMs}ms.`
            : `Login not confirmed: still on the login page after ${timeoutMs}ms.`,
        `Screenshot saved to ${path.join(path.dirname(statePath), 'login-failure.png')}. ` +
          'Run with QYNTRA_HEADED=1 to watch the login.'
      );
    }

    // Let post-login redirects and token exchanges settle before the
    // session is captured.
    await page
      .waitForLoadState('networkidle', { timeout: 10_000 })
      .catch(() => undefined);

    await context.storageState({ path: statePath });

    // Owner-only: this file is a working session for the customer's app.
    fs.chmodSync(statePath, 0o600);

    return { storageStatePath: statePath, landedUrl: page.url() };
  } catch (error) {
    if (error instanceof AuthenticationError) {
      throw error;
    }

    throw new AuthenticationError(
      `Login failed: ${scrub((error as Error)?.message ?? String(error))}`,
      'Run with QYNTRA_HEADED=1 to watch the login.'
    );
  } finally {
    await browser.close();
  }
}
