import { test, expect } from '@playwright/test';

import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { startLoginApp, type LoginApp } from '../fixtures/login-app';

// Exit codes are a contract: customers' CI branches on them. These run
// the real CLI. The one that matters most: an environment that is down
// must never exit 1, which means "the gate blocked this release".
test.describe.configure({ mode: 'serial', timeout: 120_000 });

let app: LoginApp;
let dir: string;

test.beforeAll(async () => {
  app = await startLoginApp();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qyntra-exit-'));
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ app: { baseUrl: `${app.url}/login` }, requirements: ['x'], ai: { provider: 'none' } })
  );
});

test.afterAll(async () => {
  await app.close();
});

/**
 * Run the CLI without blocking: the fixture server lives in this
 * process, and spawnSync would freeze it — every request the CLI made
 * would time out and look like "environment down".
 */
function qyntra(...args: string[]): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [require.resolve('tsx/cli'), path.resolve('scripts/cli.ts'), ...args, '--config', path.join(dir, 'config.json')],
      { cwd: dir, env: { ...process.env, QYNTRA_LOG_LEVEL: 'error' } }
    );

    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (status) => resolve({ status, output }));
  });
}

/** A port nothing listens on: bound, then released. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('environment down: 4, with the reason', async () => {
  const url = `http://127.0.0.1:${await closedPort()}`;
  const result = await qyntra('run', '--url', url);

  expect(result.status).toBe(4);
  expect(result.output).toContain(`Could not reach ${url}/: ECONNREFUSED`);
});

test('environment returns 5xx: 4, for run and doctor', async () => {
  const run = await qyntra('run', '--url', `${app.url}/broken`);

  expect(run.status).toBe(4);
  // The reason must be the 500 itself, not a timeout.
  expect(run.output).toContain('returned HTTP 500');
  expect((await qyntra('doctor', '--url', `${app.url}/broken`)).status).toBe(4);
});

test('wrong URL (404): 2, a configuration error', async () => {
  const result = await qyntra('run', '--url', `${app.url}/no-such-page`);

  expect(result.status).toBe(2);
  expect(result.output).toContain('returned HTTP 404');
});

test('healthy environment: doctor passes', async () => {
  expect((await qyntra('doctor')).status).toBe(0);
});
