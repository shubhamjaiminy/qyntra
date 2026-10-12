/**
 * Live demo in one command: Acme Shop and Qyntra Cloud, side by side,
 * with a demo account and project ready.
 *
 *   npm run demo:live                    terminal 1, leave running
 *   npm run demo:check                   terminal 2: check Discount Rules, upload
 *   npm run demo:check -- --app          every feature in the shop's menu
 *   npm run demo:mode -- search-bug      break something, check again
 *   npm run demo:stop                    stop a demo left running elsewhere
 *
 * Each start is a clean slate: a fresh cloud database and healthy mode.
 * Nothing here touches a real Qyntra Cloud or any external service.
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

import { Store } from '../cloud/db';
import { hashPassword, newApiToken } from '../cloud/security';
import { createCloudServer } from '../cloud/server';
import { DEMO_PORT, MODE_FILE, startShop } from './shop-app';

export const CLOUD_PORT = Number(process.env.DEMO_CLOUD_PORT ?? 8080);
export const DEMO_LOGIN = { email: 'demo@acme.example', password: 'qyntra-demo-2026' };

const DB_FILE = path.join(__dirname, 'qyntra-out', 'demo-cloud.db');
const TOKEN_FILE = path.join(__dirname, '.qyntra', '.demo-token');
const CLOUD_CONFIG = path.join(__dirname, '.qyntra', 'cloud.json');

async function start(): Promise<void> {
  fs.writeFileSync(MODE_FILE, 'healthy');

  for (const file of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) fs.rmSync(file, { force: true });
  fs.rmSync(path.join(__dirname, 'qyntra-out', 'features'), { recursive: true, force: true });

  const store = new Store(DB_FILE);
  const { org } = store.createUserWithOrg({ email: DEMO_LOGIN.email, name: 'Demo User', passwordHash: hashPassword(DEMO_LOGIN.password), orgName: 'Acme Shop' });
  store.setPlan(org.id, 'team');
  const project = store.createProject(org.id, 'Acme Shop', 'full');
  const token = newApiToken();
  store.createToken(project.id, 'Demo CI', token.hash, token.prefix);

  fs.writeFileSync(TOKEN_FILE, token.token, { mode: 0o600 });

  const base = JSON.parse(fs.readFileSync(path.join(__dirname, '.qyntra', 'config.json'), 'utf-8'));
  base.cloud = { url: `http://localhost:${CLOUD_PORT}`, project: project.slug, upload: 'full' };
  fs.writeFileSync(CLOUD_CONFIG, `${JSON.stringify(base, null, 2)}\n`);

  try {
    await startShop();
    const cloud = createCloudServer({ store, baseUrl: `http://localhost:${CLOUD_PORT}`, secret: 'demo-secret-demo-secret-demo-secret' });
    await new Promise<void>((resolve, reject) => {
      cloud.once('error', reject);
      cloud.listen(CLOUD_PORT, resolve);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`\n  Port ${(error as { port?: number }).port} is busy — a demo is probably still running.\n  Stop it with Ctrl+C in its terminal, or run: npm run demo:stop\n`);
      process.exit(1);
    }
    throw error;
  }

  console.log(`
  Qyntra live demo is running.

    Acme Shop      http://localhost:${DEMO_PORT}/admin/discount-rules
    Qyntra Cloud   http://localhost:${CLOUD_PORT}/login
                   ${DEMO_LOGIN.email} / ${DEMO_LOGIN.password}

  In another terminal:
    npm run demo:check                 check Discount Rules and upload
    npm run demo:mode -- search-bug    break search (also: filter-bug, validation-bug, healthy)
    npm run demo:check -- --app        every feature in the menu

  Ctrl+C to stop. The next start is a clean slate.
`);
}

/** Run the real CLI against the demo shop, uploading to the demo cloud. */
function check(extra: string[]): number {
  if (!fs.existsSync(TOKEN_FILE)) {
    console.error('Start the demo first: npm run demo:live');
    return 2;
  }

  const app = extra.includes('--app');
  const args = app
    ? ['app', '--concurrency', '3', ...extra.filter((arg) => arg !== '--app')]
    : ['feature', 'Discount Rules', ...extra];

  // Behaviour probes only, unless the presenter asks for AI: seconds, not minutes.
  if (!extra.includes('--with-ai') && !app) args.push('--no-ai');

  const result = spawnSync(
    process.execPath,
    [require.resolve('tsx/cli'), path.join(__dirname, '..', 'scripts', 'cli.ts'), ...args.filter((arg) => arg !== '--with-ai'), '--config', '.qyntra/cloud.json'],
    { cwd: __dirname, stdio: 'inherit', env: { ...process.env, QYNTRA_TOKEN: fs.readFileSync(TOKEN_FILE, 'utf-8').trim() } }
  );

  return result.status ?? 70;
}

/**
 * Stop a demo left running on the demo's ports. Only processes running
 * this demo are stopped: anything else on those ports is someone
 * else's, and is named rather than killed.
 */
function stop(): void {
  for (const port of [DEMO_PORT, CLOUD_PORT]) {
    const found = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf-8' }).stdout.trim();

    for (const pid of found.split('\n').filter(Boolean)) {
      const commandLine = spawnSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf-8' }).stdout.trim();

      if (!/demo\/(live|demo)\.ts|demo:live|demo:app/.test(commandLine)) {
        console.log(`Port ${port} is used by another program, left running: ${commandLine.slice(0, 120)}`);
        continue;
      }

      try {
        process.kill(Number(pid));
        console.log(`Stopped the demo (process ${pid}) on port ${port}`);
      } catch {
        // Already gone.
      }
    }
  }
}

const [command, ...rest] = process.argv.slice(2);

if (command === 'stop') {
  stop();
} else if (command === 'check') {
  process.exitCode = check(rest);
} else {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
