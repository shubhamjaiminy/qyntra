import { test, expect } from '@playwright/test';

import fs from 'fs';
import os from 'os';
import path from 'path';

import { authenticate } from '../../scripts/lib/auth';
import { loadConfig } from '../../scripts/lib/config';
import { LOGIN_EMAIL, LOGIN_PASSWORD, startLoginApp, type LoginApp } from '../fixtures/login-app';

// Real browser, real form, real cookie: these drive Qyntra's own login
// code against a local app, so every documented outcome is checked in CI.
test.describe.configure({ mode: 'serial', timeout: 60_000 });

let app: LoginApp;
let root: string;

test.beforeAll(async () => {
  app = await startLoginApp();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qyntra-auth-'));
});

test.afterAll(async () => {
  await app.close();
});

test.afterEach(() => {
  delete process.env.QYNTRA_APP_USER;
  delete process.env.QYNTRA_APP_PASSWORD;
});

function config(auth: Record<string, unknown> = {}, timeoutMs = 10_000) {
  const file = path.join(root, `config-${Math.random().toString(36).slice(2)}.json`);

  fs.writeFileSync(
    file,
    JSON.stringify({
      app: {
        baseUrl: `${app.url}/dashboard`,
        auth: {
          type: 'form',
          loginUrl: `${app.url}/login`,
          usernameSelector: '#email',
          passwordSelector: '#password',
          submitSelector: 'button[type="submit"]',
          usernameEnv: 'QYNTRA_APP_USER',
          passwordEnv: 'QYNTRA_APP_PASSWORD',
          successSelector: '[data-testid="dashboard"]',
          ...auth,
        },
      },
      requirements: ['User reaches the dashboard'],
      discovery: { timeoutMs },
    })
  );

  return loadConfig({ rootDir: root, configPath: file });
}

function credentials(password = LOGIN_PASSWORD) {
  process.env.QYNTRA_APP_USER = LOGIN_EMAIL;
  process.env.QYNTRA_APP_PASSWORD = password;
}

test('correct credentials: logged in, session saved owner-only', async () => {
  credentials();

  const result = await authenticate(config());

  expect(result.landedUrl).toBe(`${app.url}/dashboard`);

  const state = JSON.parse(fs.readFileSync(result.storageStatePath, 'utf-8'));

  expect(state.cookies.some((cookie: any) => cookie.name === 'session')).toBe(true);
  // A session file is a credential: owner read/write only.
  expect(fs.statSync(result.storageStatePath).mode & 0o777).toBe(0o600);
});

test('wrong password: rejected, with the application\'s own message', async () => {
  credentials('wrong');

  await expect(authenticate(config())).rejects.toThrow(/Invalid email or password/);
});

test('the password never appears in an error', async () => {
  credentials('hunter2-secret');

  const error: unknown = await authenticate(config()).then(
    () => undefined,
    (caught: unknown) => caught
  );

  expect(error).toBeInstanceOf(Error);
  expect(String((error as Error).message)).not.toContain('hunter2-secret');
});

test('wrong selector: says which selector matched nothing', async () => {
  credentials();

  await expect(authenticate(config({ usernameSelector: '#username' }, 3_000))).rejects.toThrow(
    /usernameSelector "#username" matched nothing visible/
  );
});

test('credentials not exported: a config error naming the variables', async () => {
  await expect(authenticate(config())).rejects.toThrow(/QYNTRA_APP_USER/);
});

test('a login page that never finishes loading names what is stuck', async () => {
  credentials();

  await expect(authenticate(config({ loginUrl: `${app.url}/hang` }, 3_000))).rejects.toThrow(
    /answered HTTP 200, but did not finish loading.*never\.js/
  );
});
