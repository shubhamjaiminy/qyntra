import { test, expect } from '@playwright/test';
import http from 'http';
import type { AddressInfo } from 'net';

import { Store } from '../../cloud/db';
import { createCloudServer } from '../../cloud/server';
import { newApiToken } from '../../cloud/security';
import { cloudTarget, fetchHistory, isTarget, mergeHistory, ping, sendOutcome, sendRun, type CloudTarget } from '../../scripts/lib/cloud-client';
import { buildUploadPayload, type UploadInputs } from '../../scripts/lib/cloud-upload';
import { COMMENT_MARKER, pullRequestTarget, upsertComment } from '../../scripts/lib/github';
import type { QyntraConfig } from '../../scripts/lib/config';
import type { RunHistoryEntry } from '../../scripts/lib/run-history';

const entry = (runId: string, timestamp: string): RunHistoryEntry => ({
  runId,
  timestamp,
  execution: { total: 1, passed: 1, failed: 0, skipped: 0 },
  verdict: 'SAFE',
  qualityScore: 100,
  risk: { level: 'LOW', score: 1 },
  tests: [],
});

const config = (cloud: Partial<QyntraConfig['cloud']>) => ({ cloud: { upload: 'standard', history: false, ...cloud } }) as QyntraConfig;

test.describe('cloud target', () => {
  test('active only with a URL, a project and the token', () => {
    expect(cloudTarget(config({ url: 'https://c.example', project: 'p' }), { QYNTRA_TOKEN: 'qy_live_x' })).toEqual({ url: 'https://c.example', project: 'p', token: 'qy_live_x' });

    const missing = cloudTarget(config({ project: 'p' }), {});
    expect(isTarget(missing)).toBe(false);
    expect((missing as { missing: string[] }).missing).toEqual(['cloud.url (or QYNTRA_CLOUD_URL)', 'QYNTRA_TOKEN']);

    expect(cloudTarget(config({ project: 'p' }), { QYNTRA_TOKEN: 't', QYNTRA_CLOUD_URL: 'https://env.example/' })).toMatchObject({ url: 'https://env.example' });
  });

  test('history merge keeps one entry per run, oldest first, capped; local wins', () => {
    const local = { version: 1, runs: [entry('b', '2026-10-02T00:00:00Z'), { ...entry('c', '2026-10-03T00:00:00Z'), verdict: 'UNSAFE' }] };
    const remote = [entry('a', '2026-10-01T00:00:00Z'), entry('c', '2026-10-03T00:00:00Z')];

    const merged = mergeHistory(local, remote, 50);
    expect(merged.runs.map((run) => run.runId)).toEqual(['a', 'b', 'c']);
    expect(merged.runs[2].verdict).toBe('UNSAFE');
    expect(mergeHistory(local, remote, 2).runs.map((run) => run.runId)).toEqual(['b', 'c']);
  });
});

test.describe('CLI against a real cloud', () => {
  let server: http.Server;
  let store: Store;
  let target: CloudTarget;

  test.beforeEach(async () => {
    store = new Store(':memory:');
    const { org } = store.createUserWithOrg({ email: 'a@acme.example', name: 'A', passwordHash: 'x', orgName: 'Acme' });
    const project = store.createProject(org.id, 'Billing');
    const token = newApiToken();
    store.createToken(project.id, 'CI', token.hash, token.prefix);

    server = createCloudServer({ store, baseUrl: 'http://localhost', secret: 's'.repeat(40), onRun: () => undefined });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    target = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, project: project.slug, token: token.token };
  });

  test.afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });

  test('ping, upload, history and outcome round-trip', async () => {
    expect((await ping(target)).body).toMatchObject({ ok: true, project: 'billing', plan: 'free', uploadLevel: 'standard' });

    const payload = buildUploadPayload({
      level: 'standard',
      project: 'billing',
      qyntraVersion: '0.1.0',
      provider: 'none',
      decision: {
        generatedAt: '2026-10-12T10:00:00.000Z',
        verdict: 'SAFE',
        qualityScore: 95,
        decisionConfidence: 'High',
        blockingReasons: [],
        warnings: [],
        evidence: { execution: { total: 1, passed: 1, failed: 0, skipped: 0 }, passRate: 100, risk: { level: 'LOW', score: 1 }, failuresBySeverity: {}, productDefects: 0, testDefects: 0, unattributedFailures: 0, newRegressions: 0, knownFlakyFailures: 0, chronicFailures: 0 },
      } as unknown as UploadInputs['decision'],
      run: { ...entry('run-1', '2026-10-12T10:00:00.000Z'), git: { commit: 'b'.repeat(40), branch: 'main' } },
      failures: { tests: [{ test: 'Login works', status: 'passed' }] },
    });

    const sent = await sendRun(target, payload);
    expect(sent.ok).toBe(true);
    expect(sent.body?.url).toContain('/o/acme/p/billing/runs/');

    const history = await fetchHistory(target, 'main', 50);
    expect(history.body?.runs.map((run) => [run.runId, run.verdict])).toEqual([['run-1', 'SAFE']]);

    expect((await sendOutcome(target, { commit: 'b'.repeat(40), result: 'ok', occurredAt: '2026-10-12T12:00:00.000Z' })).ok).toBe(true);
  });

  test('a wrong token is a clear refusal, not a crash', async () => {
    const refused = await ping({ ...target, token: 'qy_live_wrong' });
    expect(refused.ok).toBe(false);
    expect(refused.status).toBe(401);
    expect(refused.error).toContain('Token not recognised');
  });

  test('an unreachable cloud is a result, never an exception', async () => {
    const down = await ping({ ...target, url: 'http://127.0.0.1:9' });
    expect(down.ok).toBe(false);
    expect(down.status).toBe(0);
  });
});

test.describe('pull request comment', () => {
  test('only in a PR job with a token, and not when switched off', () => {
    const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'acme/app' };
    expect(pullRequestTarget(env, 7)).toMatchObject({ repository: 'acme/app', pullRequest: 7, api: 'https://api.github.com' });
    expect(pullRequestTarget(env, undefined)).toBeUndefined();
    expect(pullRequestTarget({ GITHUB_REPOSITORY: 'acme/app' }, 7)).toBeUndefined();
    expect(pullRequestTarget({ ...env, QYNTRA_PR_COMMENT: '0' }, 7)).toBeUndefined();
  });

  test('posts once, then updates the same comment', async () => {
    const comments: { id: number; body: string }[] = [{ id: 1, body: 'someone else' }];
    const calls: string[] = [];

    const github = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        calls.push(`${request.method} ${request.url}`);
        response.setHeader('content-type', 'application/json');

        if (request.method === 'GET') return response.end(JSON.stringify(comments));
        if (request.method === 'POST') {
          comments.push({ id: 2, body: JSON.parse(body).body });
          response.statusCode = 201;
          return response.end('{}');
        }
        comments.find((comment) => request.url?.endsWith(`/${comment.id}`))!.body = JSON.parse(body).body;
        response.end('{}');
      });
    });

    await new Promise<void>((resolve) => github.listen(0, '127.0.0.1', resolve));
    const target = { token: 't', repository: 'acme/app', pullRequest: 7, api: `http://127.0.0.1:${(github.address() as AddressInfo).port}` };

    expect((await upsertComment(target, 'SAFE')).message).toBe('Posted the decision on PR #7');
    expect((await upsertComment(target, 'UNSAFE')).message).toBe('Updated the decision on PR #7');

    expect(comments).toHaveLength(2);
    expect(comments[1].body).toBe(`${COMMENT_MARKER}\nUNSAFE`);
    expect(calls).toEqual([
      'GET /repos/acme/app/issues/7/comments?per_page=100',
      'POST /repos/acme/app/issues/7/comments',
      'GET /repos/acme/app/issues/7/comments?per_page=100',
      'PATCH /repos/acme/app/issues/comments/2',
    ]);

    await new Promise((resolve) => github.close(resolve));
  });
});
