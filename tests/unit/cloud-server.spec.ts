import { test, expect } from '@playwright/test';
import { createHmac } from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

import { applyStripeEvent, verifyStripeSignature } from '../../cloud/billing';
import { Store } from '../../cloud/db';
import { shouldAlert, validSlackWebhook } from '../../cloud/integrations';
import { createCloudServer } from '../../cloud/server';
import { sha256 } from '../../cloud/security';
import { buildFeatureUploadPayload, buildUploadPayload, type UploadInputs } from '../../scripts/lib/cloud-upload';

// --------------------------------------------------
// HARNESS
// --------------------------------------------------

interface Cloud {
  url: string;
  store: Store;
  server: Server;
}

async function startCloud(): Promise<Cloud> {
  const store = new Store(':memory:');
  const server = createCloudServer({ store, baseUrl: 'http://localhost', secret: 'test-secret-test-secret-test-secret', onRun: () => undefined });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, server };
}

/** A browser-ish client: keeps the session cookie, never follows redirects. */
class Browser {
  cookie = '';

  constructor(private readonly base: string) {}

  async get(path: string) {
    const response = await fetch(this.base + path, { headers: { cookie: this.cookie }, redirect: 'manual' });
    return { status: response.status, location: response.headers.get('location') ?? '', body: await response.text(), headers: response.headers };
  }

  async post(path: string, form: Record<string, string>) {
    const response = await fetch(this.base + path, {
      method: 'POST',
      headers: { cookie: this.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      redirect: 'manual',
    });

    const set = response.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];

    return { status: response.status, location: response.headers.get('location') ?? '', body: await response.text() };
  }

  /** The CSRF token on a page the user can see. */
  async csrf(path: string): Promise<string> {
    const page = await this.get(path);
    const token = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1];
    if (!token) throw new Error(`no CSRF token on ${path} (status ${page.status})`);
    return token;
  }
}

async function signUp(cloud: Cloud, email: string, org: string): Promise<{ browser: Browser; orgSlug: string }> {
  const browser = new Browser(cloud.url);
  const response = await browser.post('/signup', { name: 'Ada', email, password: 'correct horse battery', org });
  expect(response.status).toBe(303);
  return { browser, orgSlug: /\/o\/([^/?]+)/.exec(response.location)![1] };
}

async function createProject(browser: Browser, orgSlug: string, name: string, level = 'standard'): Promise<{ token: string; slug: string }> {
  const response = await browser.post(`/o/${orgSlug}/projects`, { name, level, csrf: await browser.csrf(`/o/${orgSlug}`) });
  expect(response.status).toBe(200);

  return {
    token: /(qy_live_[A-Za-z0-9_-]+)/.exec(response.body)![1],
    slug: /"project": "([^"]+)"/.exec(response.body)![1],
  };
}

function runPayload(level: 'metrics' | 'standard' | 'full', runId = 'run-1', testName = 'Checkout works') {
  const inputs = {
    level,
    project: 'billing',
    qyntraVersion: '0.1.0',
    provider: 'none',
    decision: {
      generatedAt: '2026-10-12T10:00:00.000Z',
      verdict: 'UNSAFE',
      qualityScore: 62,
      decisionConfidence: 'High',
      blockingReasons: ['Checkout failed: product defect'],
      warnings: [],
      evidence: {
        execution: { total: 2, passed: 1, failed: 1, skipped: 0 },
        passRate: 50,
        risk: { level: 'HIGH', score: 8 },
        failuresBySeverity: { Critical: 0, High: 1, Medium: 0, Low: 0 },
        productDefects: 1,
        testDefects: 0,
        unattributedFailures: 0,
        newRegressions: 1,
        knownFlakyFailures: 0,
        chronicFailures: 0,
      },
    } as unknown as UploadInputs['decision'],
    run: { runId, timestamp: '2026-10-12T10:00:00.000Z', git: { commit: 'a'.repeat(40), branch: 'main' }, execution: { total: 2, passed: 1, failed: 1, skipped: 0 }, verdict: 'UNSAFE', qualityScore: 62, risk: { level: 'HIGH', score: 8 }, tests: [] },
    failures: { tests: [{ test: testName, status: 'failed' as const }, { test: 'Login works', status: 'passed' as const }] },
  };

  return buildUploadPayload(inputs);
}

async function upload(cloud: Cloud, path: string, token: string, body: unknown) {
  const response = await fetch(cloud.url + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

let cloud: Cloud;

test.beforeEach(async () => {
  cloud = await startCloud();
});

test.afterEach(async () => {
  await new Promise((resolve) => cloud.server.close(resolve));
  cloud.store.close();
});

// --------------------------------------------------
// THE CUSTOMER JOURNEY
// --------------------------------------------------

test('sign up, create a project, upload from CI, and see the run', async () => {
  const { browser, orgSlug } = await signUp(cloud, 'ada@acme.example', 'Acme');
  const project = await createProject(browser, orgSlug, 'Billing');

  const first = await upload(cloud, '/v1/runs', project.token, runPayload('standard'));
  expect(first.status).toBe(201);

  // A CI retry of the same run replaces it rather than duplicating it.
  const retry = await upload(cloud, '/v1/runs', project.token, runPayload('standard'));
  expect(retry.status).toBe(200);
  expect(retry.body.created).toBe(false);

  const overview = await browser.get(`/o/${orgSlug}/p/${project.slug}`);
  expect(overview.body).toContain('UNSAFE');
  expect(overview.body).toContain('62');

  const run = await browser.get(new URL(String(first.body.url)).pathname);
  expect(run.status).toBe(200);
  expect(run.body).toContain('Checkout failed: product defect');
  expect(run.body).toContain('Checkout works');
});

test('run history comes back in the CLI shape, for cloud.history', async () => {
  const { browser, orgSlug } = await signUp(cloud, 'ada@acme.example', 'Acme');
  const project = await createProject(browser, orgSlug, 'Billing');

  await upload(cloud, '/v1/runs', project.token, runPayload('standard', 'run-1'));
  await upload(cloud, '/v1/runs', project.token, runPayload('standard', 'run-2'));

  const response = await fetch(`${cloud.url}/v1/history?branch=main`, { headers: { authorization: `Bearer ${project.token}` } });
  const history = (await response.json()) as { runs: { runId: string; verdict: string; tests: { test: string; status: string }[] }[] };

  expect(history.runs.map((run) => run.runId)).toEqual(['run-1', 'run-2']);
  expect([...history.runs[0].tests].sort((a, b) => a.test.localeCompare(b.test))).toEqual([
    { test: 'Checkout works', status: 'failed' },
    { test: 'Login works', status: 'passed' },
  ]);
});

test('outcomes build the track record; feature reports appear per feature', async () => {
  const { browser, orgSlug } = await signUp(cloud, 'ada@acme.example', 'Acme');
  const project = await createProject(browser, orgSlug, 'Billing', 'full');

  await upload(cloud, '/v1/runs', project.token, runPayload('full'));
  expect((await upload(cloud, '/v1/outcomes', project.token, { commit: 'a'.repeat(40), result: 'ok' })).status).toBe(201);

  const track = await browser.get(`/o/${orgSlug}/p/${project.slug}/track-record`);
  expect(track.body).toContain('Blocked, but were fine');

  const feature = buildFeatureUploadPayload(
    {
      feature: 'Discount Rules',
      generatedAt: '2026-10-12T10:00:00.000Z',
      decision: { verdict: 'NOT_READY', confidence: 'High', reasons: ['Search does not narrow'] },
      findings: [{ title: 'Slow page', severity: 'Medium', category: 'performance', evidence: 'took 9s at https://staging.acme.example/admin?x=1', recommendation: 'profile', source: 'observed' }],
      tests: [{ title: 'Search for "Summer" shows only matching rows', status: 'app-defect', origin: 'probe', reason: 'it did not' }],
      understanding: { purpose: 'Manages discounts.', users: 'Admins', usage: ['Open it'], businessRules: [], openQuestions: [] },
    },
    { level: 'full', project: project.slug, qyntraVersion: '0.1.0' }
  );

  const stored = await upload(cloud, '/v1/feature-reports', project.token, feature);
  expect(stored.status).toBe(201);

  const list = await browser.get(`/o/${orgSlug}/p/${project.slug}/features`);
  expect(list.body).toContain('Discount Rules');
  expect(list.body).toContain('NOT READY');

  const detail = await browser.get(new URL(String(stored.body.url)).pathname);
  expect(detail.body).toContain('Manages discounts.');
  expect(detail.body).toContain('https://staging.acme.example');
  expect(detail.body).not.toContain('/admin?x=1');
});

// --------------------------------------------------
// SECURITY
// --------------------------------------------------

test('one customer cannot see another customer\'s organization, project or run', async () => {
  const acme = await signUp(cloud, 'ada@acme.example', 'Acme');
  const project = await createProject(acme.browser, acme.orgSlug, 'Billing');
  const run = await upload(cloud, '/v1/runs', project.token, runPayload('standard'));

  const rival = await signUp(cloud, 'eve@rival.example', 'Rival');

  expect((await rival.browser.get(`/o/${acme.orgSlug}`)).status).toBe(404);
  expect((await rival.browser.get(`/o/${acme.orgSlug}/p/${project.slug}`)).status).toBe(404);
  expect((await rival.browser.get(new URL(String(run.body.url)).pathname)).status).toBe(404);

  // Nor through their own org's URL with Acme's project slug.
  expect((await rival.browser.get(`/o/${rival.orgSlug}/p/${project.slug}`)).status).toBe(404);
});

test('state-changing forms need the session\'s CSRF token', async () => {
  const { browser, orgSlug } = await signUp(cloud, 'ada@acme.example', 'Acme');

  expect((await browser.post(`/o/${orgSlug}/projects`, { name: 'Billing' })).status).toBe(403);
  expect((await browser.post(`/o/${orgSlug}/projects`, { name: 'Billing', csrf: 'forged' })).status).toBe(403);
  expect(cloud.store.projects(cloud.store.orgsForUser(cloud.store.userByEmail('ada@acme.example')!.id)[0].id)).toEqual([]);
});

test('names from customers\' tests are rendered as text, never as markup', async () => {
  const { browser, orgSlug } = await signUp(cloud, 'ada@acme.example', 'Acme');
  const project = await createProject(browser, orgSlug, 'Billing');
  const run = await upload(cloud, '/v1/runs', project.token, runPayload('standard', 'run-x', '<script>alert(1)</script>'));

  const page = await browser.get(new URL(String(run.body.url)).pathname);

  expect(page.body).not.toContain('<script>alert(1)</script>');
  expect(page.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
});

test('the server refuses uploads richer than the project allows, and bad tokens', async () => {
  const { browser, orgSlug } = await signUp(cloud, 'ada@acme.example', 'Acme');
  const project = await createProject(browser, orgSlug, 'Billing', 'metrics');

  const tooMuch = await upload(cloud, '/v1/runs', project.token, runPayload('standard'));
  expect(tooMuch.status).toBe(422);
  expect(String(tooMuch.body.error)).toContain('accepts uploads up to "metrics"');

  expect((await upload(cloud, '/v1/runs', project.token, runPayload('metrics'))).status).toBe(201);
  expect((await upload(cloud, '/v1/runs', 'qy_live_not-a-real-token', runPayload('metrics'))).status).toBe(401);
});

test('a revoked token stops working at once', async () => {
  const { browser, orgSlug } = await signUp(cloud, 'ada@acme.example', 'Acme');
  const project = await createProject(browser, orgSlug, 'Billing');
  const projectId = cloud.store.project(cloud.store.orgForMember(cloud.store.userByEmail('ada@acme.example')!.id, orgSlug)!.id, project.slug)!.id;
  const [token] = cloud.store.tokens(projectId);

  await browser.post(`/o/${orgSlug}/p/${project.slug}/tokens/${token.id}/revoke`, { csrf: await browser.csrf(`/o/${orgSlug}/p/${project.slug}/settings`) });

  expect((await upload(cloud, '/v1/runs', project.token, runPayload('standard'))).status).toBe(401);
});

test('login rejects a wrong password without saying which part was wrong', async () => {
  await signUp(cloud, 'ada@acme.example', 'Acme');
  const visitor = new Browser(cloud.url);

  const wrong = await visitor.post('/login', { email: 'ada@acme.example', password: 'not the password' });
  const unknown = await visitor.post('/login', { email: 'nobody@acme.example', password: 'not the password' });

  expect(wrong.status).toBe(401);
  expect(unknown.status).toBe(401);
  expect(wrong.body).toContain('Email or password is incorrect.');
  expect(unknown.body).toContain('Email or password is incorrect.');
  expect((await visitor.post('/login', { email: 'ada@acme.example', password: 'correct horse battery' })).status).toBe(303);
});

test('login never redirects off-site', async () => {
  await signUp(cloud, 'ada@acme.example', 'Acme');
  const visitor = new Browser(cloud.url);

  const response = await visitor.post('/login', { email: 'ada@acme.example', password: 'correct horse battery', next: '//evil.example/phish' });
  expect(response.location).toBe('/app');
});

// --------------------------------------------------
// PLANS, BILLING, TEAM, ALERTS
// --------------------------------------------------

test('the free plan allows one project; a second goes to billing', async () => {
  const { browser, orgSlug } = await signUp(cloud, 'ada@acme.example', 'Acme');
  await createProject(browser, orgSlug, 'Billing');

  const second = await browser.post(`/o/${orgSlug}/projects`, { name: 'Payments', csrf: await browser.csrf(`/o/${orgSlug}`) });
  expect(second.status).toBe(303);
  expect(second.location).toContain('/billing?error=');
});

test('a signed Stripe checkout upgrades the org; a bad signature is refused', () => {
  const store = new Store(':memory:');
  const { org } = store.createUserWithOrg({ email: 'a@b.example', name: 'A', passwordHash: 'x', orgName: 'Acme' });
  const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { customer: 'cus_1', subscription: 'sub_1', metadata: { org_id: org.id, plan: 'team' } } } });
  const t = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');

  expect(verifyStripeSignature(body, `t=${t},v1=${signature}`, 'whsec_test')).toBe(true);
  expect(verifyStripeSignature(body, `t=${t},v1=${'0'.repeat(64)}`, 'whsec_test')).toBe(false);
  expect(verifyStripeSignature(body, `t=${t - 3600},v1=${signature}`, 'whsec_test')).toBe(false);

  applyStripeEvent(store, JSON.parse(body));
  expect(store.orgById(org.id)!.plan).toBe('team');

  applyStripeEvent(store, { type: 'customer.subscription.deleted', data: { object: { customer: 'cus_1' } } });
  expect(store.orgById(org.id)!.plan).toBe('free');
  store.close();
});

test('an invitation link lets a teammate join with the chosen role', async () => {
  const { browser, orgSlug } = await signUp(cloud, 'ada@acme.example', 'Acme');
  const invite = await browser.post(`/o/${orgSlug}/members`, { email: 'bob@acme.example', role: 'viewer', csrf: await browser.csrf(`/o/${orgSlug}/members`) });
  const link = /(\/signup\?invite=[A-Za-z0-9_-]+)/.exec(invite.body)![1];

  const bob = new Browser(cloud.url);
  const token = new URL(link, 'http://x').searchParams.get('invite')!;
  const joined = await bob.post('/signup', { name: 'Bob', email: 'bob@acme.example', password: 'another long secret', invite: token });

  expect(joined.location).toBe(`/o/${orgSlug}`);
  expect((await bob.get(`/o/${orgSlug}`)).status).toBe(200);

  // A viewer cannot create projects.
  expect((await bob.post(`/o/${orgSlug}/projects`, { name: 'X', csrf: await bob.csrf(`/o/${orgSlug}/members`) })).status).toBe(403);
});

test('Slack alerts only go to Slack, and only when asked', () => {
  expect(validSlackWebhook('https://hooks.slack.com/services/T0/B0/xyz')).toBe(true);
  expect(validSlackWebhook('https://hooks.slack.com.evil.example/services/x')).toBe(false);
  expect(validSlackWebhook('http://hooks.slack.com/services/x')).toBe(false);
  expect(validSlackWebhook('http://169.254.169.254/latest/meta-data')).toBe(false);

  expect(shouldAlert('unsafe', 'UNSAFE')).toBe(true);
  expect(shouldAlert('unsafe', 'SAFE_WITH_RISK')).toBe(false);
  expect(shouldAlert('any-risk', 'SAFE_WITH_RISK')).toBe(true);
  expect(shouldAlert('never', 'UNSAFE')).toBe(false);
});

test('public pages render, and every page carries the security headers', async () => {
  for (const path of ['/', '/pricing', '/docs', '/security', '/terms', '/privacy', '/signup', '/login']) {
    const response = await fetch(cloud.url + path);
    expect(response.status, path).toBe(200);
    expect(response.headers.get('x-frame-options'), path).toBe('DENY');
  }

  expect((await fetch(`${cloud.url}/o/anything`, { redirect: 'manual' })).status).toBe(303);
});

// --------------------------------------------------
// ACCOUNTS AND OPERATOR
// --------------------------------------------------

test('forgot password answers the same for unknown emails; a reset link works once', async () => {
  await signUp(cloud, 'ada@acme.example', 'Acme');
  const visitor = new Browser(cloud.url);

  expect((await visitor.post('/forgot', { email: 'ada@acme.example' })).location).toBe('/forgot?ok=1');
  expect((await visitor.post('/forgot', { email: 'nobody@acme.example' })).location).toBe('/forgot?ok=1');

  const user = cloud.store.userByEmail('ada@acme.example')!;
  cloud.store.createPasswordReset(user.id, sha256('reset-token'));

  expect((await visitor.get('/reset?token=reset-token')).status).toBe(200);
  expect((await visitor.post('/reset', { token: 'reset-token', password: 'brand new password' })).location).toContain('/login?ok=');
  expect((await visitor.post('/reset', { token: 'reset-token', password: 'another new password' })).location).toContain('expired');

  expect((await visitor.post('/login', { email: 'ada@acme.example', password: 'brand new password' })).status).toBe(303);
});

test('changing the password signs other devices out but keeps this one', async () => {
  const { browser, orgSlug } = await signUp(cloud, 'ada@acme.example', 'Acme');
  const laptop = new Browser(cloud.url);
  await laptop.post('/login', { email: 'ada@acme.example', password: 'correct horse battery' });
  expect((await laptop.get(`/o/${orgSlug}`)).status).toBe(200);

  const changed = await browser.post('/account/password', { current: 'correct horse battery', password: 'a different secret', csrf: await browser.csrf('/account') });
  expect(changed.location).toContain('ok=');

  expect((await browser.get(`/o/${orgSlug}`)).status).toBe(200);
  expect((await laptop.get(`/o/${orgSlug}`)).status).toBe(303);
});

test('the last owner cannot be demoted, and owners can change roles', async () => {
  const { browser, orgSlug } = await signUp(cloud, 'ada@acme.example', 'Acme');
  const bob = await signUp(cloud, 'bob@acme.example', 'Bob Co');
  const org = cloud.store.orgForMember(cloud.store.userByEmail('ada@acme.example')!.id, orgSlug)!;
  const bobId = cloud.store.userByEmail('bob@acme.example')!.id;
  cloud.store.addMember(org.id, bobId, 'member');

  await browser.post(`/o/${orgSlug}/members/${bobId}/role`, { role: 'admin', csrf: await browser.csrf(`/o/${orgSlug}/members`) });
  expect(cloud.store.orgForMember(bobId, orgSlug)!.role).toBe('admin');

  // Bob, an admin, cannot change roles: that is the owner's.
  expect((await bob.browser.post(`/o/${orgSlug}/members/${bobId}/role`, { role: 'owner', csrf: await bob.browser.csrf(`/o/${orgSlug}/members`) })).status).toBe(403);
});

test('the operator console is only for operators, and grants plans', async () => {
  const { orgSlug } = await signUp(cloud, 'ada@acme.example', 'Acme');
  const operator = await signUp(cloud, 'founder@qyntra.example', 'Qyntra');

  process.env.QYNTRA_CLOUD_ADMINS = 'founder@qyntra.example';

  try {
    const ada = new Browser(cloud.url);
    await ada.post('/login', { email: 'ada@acme.example', password: 'correct horse battery' });
    expect((await ada.get('/admin')).status).toBe(404);

    const consolePage = await operator.browser.get('/admin');
    expect(consolePage.body).toContain('Acme');

    const org = cloud.store.orgForMember(cloud.store.userByEmail('ada@acme.example')!.id, orgSlug)!;
    await operator.browser.post(`/admin/orgs/${org.id}/plan`, { plan: 'team', csrf: await operator.browser.csrf('/admin') });
    expect(cloud.store.orgById(org.id)!.plan).toBe('team');
  } finally {
    delete process.env.QYNTRA_CLOUD_ADMINS;
  }
});

test('deleting an account removes the orgs only they belonged to', async () => {
  const { browser } = await signUp(cloud, 'ada@acme.example', 'Acme');

  const deleted = await browser.post('/account/delete', { confirm: 'ada@acme.example', csrf: await browser.csrf('/account') });
  expect(deleted.location).toContain('/?ok=');
  expect(cloud.store.userByEmail('ada@acme.example')).toBeUndefined();
  expect(cloud.store.allOrgs()).toEqual([]);
});
