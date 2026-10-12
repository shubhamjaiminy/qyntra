/**
 * Qyntra Cloud web app: accounts, organizations, projects, and the
 * dashboard pages over the runs the CLI uploads.
 *
 * Every page that shows tenant data resolves the org from the URL and
 * the signed-in user's membership together (Store.orgForMember), so a
 * user can never reach another organization's page by editing the URL.
 * Every state-changing form carries a CSRF token bound to the session,
 * and every POST must come from this site's own origin.
 */

import { computeStability, maintenanceDebt } from '../scripts/lib/run-history';
import { trackRecord } from '../scripts/lib/release-outcomes';
import { historyEntries } from './api';
import { ROLES, type Org, type Project, type Role, type Store, type User } from './db';
import { field, html, htmlResponse, HttpError, jsonResponse, redirect, type Request, type Response, type Router, type SafeHtml } from './http';
import { limitProblem, limitsFor } from './plans';
import {
  csrfToken,
  csrfValid,
  hashPassword,
  newApiToken,
  newSession,
  passwordProblem,
  randomSecret,
  RateLimiter,
  SESSION_COOKIE,
  sessionCookie,
  sha256,
  verifyPassword,
} from './security';
import { sendEmail } from './email';
import { csrfField, layout, relativeTime, sparkline, statusBadge, verdictBadge } from './views';

export interface WebContext {
  store: Store;
  secret: string;
  baseUrl: string;
  /** Secure cookies: true behind HTTPS. */
  secure: boolean;
}

interface Session {
  user: User;
  id: string;
  csrf: string;
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** Per server, not per process: two servers must not share counters. */
const limiters = new WeakMap<Store, { login: RateLimiter; signup: RateLimiter }>();

function limiterFor(store: Store) {
  let found = limiters.get(store);
  if (!found) {
    found = { login: new RateLimiter(10, 15 * 60_000), signup: new RateLimiter(10, 60 * 60_000) };
    limiters.set(store, found);
  }
  return found;
}

/** Thrown to send the browser elsewhere from deep inside a handler. */
export class Redirect extends Error {
  constructor(readonly location: string) {
    super(location);
  }
}

// --------------------------------------------------
// SESSION HELPERS
// --------------------------------------------------

function session(context: WebContext, request: Request): Session | undefined {
  const id = request.cookies[SESSION_COOKIE];
  if (!id) return undefined;

  const user = context.store.sessionUser(sha256(id));
  return user ? { user, id, csrf: csrfToken(id, context.secret) } : undefined;
}

function requireSession(context: WebContext, request: Request): Session {
  const current = session(context, request);
  if (!current) throw new Redirect(`/login?next=${encodeURIComponent(request.path)}`);
  return current;
}

/** The org in the URL, for a member with at least `minimum` role. */
function requireOrg(context: WebContext, request: Request, minimum: Role = 'viewer'): { session: Session; org: Org & { role: Role } } {
  const current = requireSession(context, request);
  const org = context.store.orgForMember(current.user.id, request.params.org);

  if (!org) throw new HttpError(404, 'Not found.');
  if (ROLE_RANK[org.role] < ROLE_RANK[minimum]) throw new HttpError(403, `This needs the ${minimum} role.`);

  return { session: current, org };
}

function requireProject(context: WebContext, request: Request, minimum: Role = 'viewer') {
  const { session: current, org } = requireOrg(context, request, minimum);
  const project = context.store.project(org.id, request.params.project);
  if (!project) throw new HttpError(404, 'Not found.');
  return { session: current, org, project };
}

/**
 * Forms that change state: same-origin, and (when signed in) a CSRF
 * token bound to the session. SameSite=Lax already blocks most
 * cross-site posts; the Origin check covers login and signup forms,
 * which have no session yet.
 */
function checkForm(context: WebContext, request: Request, current?: Session): void {
  const origin = String(request.headers.origin ?? '');
  const expected = new URL(context.baseUrl).origin;

  if (origin && origin !== 'null' && origin !== expected) {
    throw new HttpError(403, 'Cross-site form submission refused.');
  }

  if (current && !csrfValid(current.id, field(request, 'csrf', 200), context.secret)) {
    throw new HttpError(403, 'This form has expired. Go back, reload the page and try again.');
  }
}

function flash(request: Request): { kind: 'ok' | 'error'; text: string } | undefined {
  const ok = request.url.searchParams.get('ok');
  const error = request.url.searchParams.get('error');
  return error ? { kind: 'error', text: error.slice(0, 300) } : ok ? { kind: 'ok', text: ok.slice(0, 300) } : undefined;
}

function signIn(context: WebContext, userId: string, location: string): Response {
  const created = newSession();
  context.store.createSession(created.hash, userId, created.expiresAt);
  return redirect(location, { 'set-cookie': sessionCookie(created.id, context.secure) });
}

/** Only same-site paths: `next` must not become an open redirect. */
function safeNext(next: string | null | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/app';
}

const page = (context: WebContext, request: Request, title: string, content: SafeHtml, extra: { session?: Session; orgSlug?: string } = {}) =>
  htmlResponse(
    layout(
      {
        title,
        user: extra.session?.user,
        csrf: extra.session?.csrf,
        orgSlug: extra.orgSlug,
        flash: flash(request),
      },
      content
    )
  );

// --------------------------------------------------
// ACCOUNTS
// --------------------------------------------------

function signupForm(context: WebContext, request: Request, values: Record<string, string> = {}, error?: string): Response {
  const invite = request.url.searchParams.get('invite') ?? values.invite ?? '';

  return htmlResponse(
    layout(
      { title: 'Create your account', flash: error ? { kind: 'error', text: error } : undefined },
      html`<div class="card" style="max-width:520px;margin:2rem auto">
        <h1>${invite ? 'Join your team on Qyntra' : 'Start free'}</h1>
        <p class="muted">No credit card. Your tests keep running in your CI; Qyntra Cloud stores only results.</p>
        <form method="post" action="/signup">
          <input type="hidden" name="invite" value="${invite}">
          <label for="name">Your name</label><input id="name" name="name" type="text" required value="${values.name ?? ''}" autocomplete="name">
          <label for="email">Work email</label><input id="email" name="email" type="email" required value="${values.email ?? ''}" autocomplete="email">
          <label for="password">Password</label><input id="password" name="password" type="password" required minlength="10" autocomplete="new-password">
          ${invite ? '' : html`<label for="org">Company or team name</label><input id="org" name="org" type="text" required value="${values.org ?? ''}">`}
          <p><button type="submit">Create account</button></p>
          <p class="small muted">By creating an account you agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy policy</a>.</p>
        </form>
        <p class="small">Already have an account? <a href="/login">Log in</a></p>
      </div>`
    ),
    error ? 422 : 200
  );
}

function signup(context: WebContext, request: Request): Response {
  checkForm(context, request);

  if (!limiterFor(context.store).signup.take(request.ip)) {
    throw new HttpError(429, 'Too many sign-ups from this network. Try again in an hour.');
  }

  const values = { name: field(request, 'name', 100), email: field(request, 'email', 200).toLowerCase(), org: field(request, 'org', 100), invite: field(request, 'invite', 200) };
  const password = typeof request.body.password === 'string' ? request.body.password : '';
  const invite = values.invite ? context.store.invite(sha256(values.invite)) : undefined;

  if (values.invite && !invite) return signupForm(context, request, values, 'This invitation has expired or was already used. Ask for a new one.');
  if (!values.name) return signupForm(context, request, values, 'Enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) return signupForm(context, request, values, 'Enter a valid email address.');
  if (invite && invite.email.toLowerCase() !== values.email) return signupForm(context, request, values, `This invitation is for ${invite.email}.`);
  if (!invite && !values.org) return signupForm(context, request, values, 'Enter your company or team name.');

  const problem = passwordProblem(password, values.email);
  if (problem) return signupForm(context, request, values, problem);

  if (context.store.userByEmail(values.email)) {
    return signupForm(context, request, values, 'An account with this email already exists. Log in instead.');
  }

  if (invite) {
    const user = context.store.createUser({ email: values.email, name: values.name, passwordHash: hashPassword(password) });
    context.store.addMember(invite.orgId, user.id, invite.role);
    context.store.acceptInvite(invite.id);
    context.store.audit(invite.orgId, user.email, 'member.joined', invite.role);
    return signIn(context, user.id, `/o/${context.store.orgById(invite.orgId)!.slug}`);
  }

  const { user, org } = context.store.createUserWithOrg({ email: values.email, name: values.name, passwordHash: hashPassword(password), orgName: values.org });
  return signIn(context, user.id, `/o/${org.slug}?ok=${encodeURIComponent('Welcome! Create your first project to get a token for CI.')}`);
}

function loginForm(request: Request, error?: string, email = ''): Response {
  const next = request.url.searchParams.get('next') ?? (typeof request.body.next === 'string' ? request.body.next : '');

  return htmlResponse(
    layout(
      { title: 'Log in', flash: error ? { kind: 'error', text: error } : flash(request) },
      html`<div class="card" style="max-width:460px;margin:2rem auto">
        <h1>Log in</h1>
        <form method="post" action="/login">
          <input type="hidden" name="next" value="${next}">
          <label for="email">Email</label><input id="email" name="email" type="email" required value="${email}" autocomplete="email">
          <label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password">
          <p><button type="submit">Log in</button></p>
        </form>
        <p class="small"><a href="/forgot">Forgot your password?</a> · New to Qyntra? <a href="/signup">Create an account</a></p>
      </div>`
    ),
    error ? 401 : 200
  );
}

function login(context: WebContext, request: Request): Response {
  checkForm(context, request);

  const email = field(request, 'email', 200).toLowerCase();
  const password = typeof request.body.password === 'string' ? request.body.password : '';

  if (!limiterFor(context.store).login.take(`${request.ip}:${email}`)) {
    return loginForm(request, 'Too many attempts. Wait 15 minutes and try again.', email);
  }

  const user = context.store.userByEmail(email);

  // Same message either way: do not reveal which emails have accounts.
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return loginForm(request, 'Email or password is incorrect.', email);
  }

  return signIn(context, user.id, safeNext(typeof request.body.next === 'string' ? request.body.next : undefined));
}

function logout(context: WebContext, request: Request): Response {
  const current = session(context, request);
  checkForm(context, request, current);

  if (current) context.store.deleteSession(sha256(current.id));
  return redirect('/', { 'set-cookie': sessionCookie('', context.secure, 0) });
}

// --------------------------------------------------
// ORGANIZATION
// --------------------------------------------------

function appHome(context: WebContext, request: Request): Response {
  const current = requireSession(context, request);
  const [first] = context.store.orgsForUser(current.user.id);
  return redirect(first ? `/o/${first.slug}` : '/signup');
}

function projectsPage(context: WebContext, request: Request): Response {
  const { session: current, org } = requireOrg(context, request);
  const projects = context.store.projects(org.id);
  const limits = limitsFor(org.plan);

  const rows = projects.map((project) => {
    const [latest] = context.store.runs(project.id, { limit: 1 });
    return html`<tr>
      <td><a href="/o/${org.slug}/p/${project.slug}"><strong>${project.name}</strong></a></td>
      <td>${verdictBadge(latest?.verdict)}</td>
      <td>${latest ? `${latest.quality_score}` : '—'}</td>
      <td>${latest?.branch ?? '—'}</td>
      <td class="muted">${relativeTime(latest?.received_at)}</td>
    </tr>`;
  });

  return page(
    context,
    request,
    org.name,
    html`<h1>${org.name}</h1>
    <p class="muted">${limits.name} plan · ${projects.length} of ${limits.projects} project(s) · ${context.store.runsThisMonth(org.id)} of ${limits.runsPerMonth} runs this month</p>
    ${projects.length > 0
      ? html`<table><thead><tr><th>Project</th><th>Latest verdict</th><th>Score</th><th>Branch</th><th>Last run</th></tr></thead><tbody>${rows}</tbody></table>`
      : html`<div class="card"><h2 style="margin-top:0">Create your first project</h2><p>A project is one application or repository. You will get a token to put in CI.</p></div>`}
    ${ROLE_RANK[org.role] >= ROLE_RANK.admin
      ? html`<div class="card"><h2 style="margin-top:0">New project</h2>
        <form method="post" action="/o/${org.slug}/projects">${csrfField(current.csrf)}
          <label for="name">Name</label><input id="name" name="name" type="text" required placeholder="e.g. Billing app">
          <label for="level">What CI uploads</label>
          <select id="level" name="level">
            <option value="metrics">metrics — verdict, score and counts only</option>
            <option value="standard" selected>standard — plus test names, commit, branch</option>
            <option value="full">full — plus error messages and AI diagnoses</option>
          </select>
          <p><button type="submit">Create project</button></p>
        </form></div>`
      : ''}`,
    { session: current, orgSlug: org.slug }
  );
}

function createProject(context: WebContext, request: Request): Response {
  const { session: current, org } = requireOrg(context, request, 'admin');
  checkForm(context, request, current);

  const name = field(request, 'name', 80);
  const level = ['metrics', 'standard', 'full'].includes(field(request, 'level')) ? field(request, 'level') : 'standard';

  if (!name) return redirect(`/o/${org.slug}?error=${encodeURIComponent('Enter a project name.')}`);

  const problem = limitProblem(org.plan, { projects: context.store.projects(org.id).length }, 'project');
  if (problem) return redirect(`/o/${org.slug}/billing?error=${encodeURIComponent(problem)}`);

  const project = context.store.createProject(org.id, name, level);
  const token = newApiToken();
  context.store.createToken(project.id, 'CI', token.hash, token.prefix);
  context.store.audit(org.id, current.user.email, 'project.created', project.name);

  return tokenShown(context, request, current, org, project, token.token, true);
}

/** The one page that ever shows a token in full. */
function tokenShown(context: WebContext, request: Request, current: Session, org: Org, project: Project, token: string, isNew: boolean): Response {
  return page(
    context,
    request,
    `Connect ${project.name}`,
    html`<h1>${isNew ? `${project.name} is ready` : 'New token created'}</h1>
    <div class="card">
      <h2 style="margin-top:0">1. Save this token as a CI secret named <code>QYNTRA_TOKEN</code></h2>
      <p class="token"><code>${token}</code></p>
      <p class="small muted">It is shown once. Qyntra stores only a hash of it.</p>
    </div>
    <div class="card">
      <h2 style="margin-top:0">2. Point the CLI at this project</h2>
      <p>New to Qyntra? In your repository:</p>
      <pre>npm install --save-dev qyntra @playwright/test
npx qyntra init --url https://your-staging-app --cloud-url ${context.baseUrl} --project ${project.slug}</pre>
      <p>Already set up? Add to <code>.qyntra/config.json</code>:</p>
      <pre>"cloud": { "url": "${context.baseUrl}", "project": "${project.slug}", "upload": "${project.uploadLevel}", "history": true }</pre>
      <p>Then every <code>qyntra run</code> and <code>qyntra gate</code> in CI uploads its result. Check it with:</p>
      <pre>npx qyntra upload --dry-run   # see exactly what is sent
npx qyntra doctor             # confirms the token works</pre>
    </div>
    <p><a class="button" href="/o/${org.slug}/p/${project.slug}">Go to the project</a></p>`,
    { session: current, orgSlug: org.slug }
  );
}

// --------------------------------------------------
// PROJECT PAGES
// --------------------------------------------------

function tabs(org: Org, project: Project, on: string): SafeHtml {
  const tab = (key: string, label: string, href: string) => html`<a class="${on === key ? 'on' : ''}" href="${href}">${label}</a>`;
  const base = `/o/${org.slug}/p/${project.slug}`;

  return html`<div class="tabs">${tab('overview', 'Overview', base)}${tab('features', 'Features', `${base}/features`)}${tab('tests', 'Tests', `${base}/tests`)}${tab('track', 'Track record', `${base}/track-record`)}${tab('integrations', 'Alerts', `${base}/integrations`)}${tab('settings', 'Settings', `${base}/settings`)}</div>`;
}

function overview(context: WebContext, request: Request): Response {
  const { session: current, org, project } = requireProject(context, request);
  const runs = context.store.runs(project.id, { limit: 50 });
  const latest = runs[0];
  const branches = new Map<string, (typeof runs)[number]>();

  for (const run of runs) {
    if (run.branch && !branches.has(run.branch)) branches.set(run.branch, run);
  }

  const record = trackRecord(outcomesFor(context.store, project.id), historyEntries(context.store, project.id, { limit: 500 }));
  const features = context.store.latestFeatureReports(project.id);
  const passRate = latest && latest.total > 0 ? Math.round((latest.passed / latest.total) * 100) : undefined;

  return page(
    context,
    request,
    project.name,
    html`<p class="small"><a href="/o/${org.slug}">${org.name}</a> /</p><h1>${project.name}</h1>
    ${tabs(org, project, 'overview')}
    ${!latest
      ? html`${features.length > 0
          ? html`<div class="card"><h2 style="margin-top:0">${features.length} feature(s) checked</h2>
              <p>${features.filter((report) => report.bugs > 0).length} with failing behaviour, ${features.filter((report) => report.verdict === 'NOT_READY').length} not ready. <a href="/o/${org.slug}/p/${project.slug}/features">See the feature reports →</a></p></div>`
          : ''}
        <div class="card"><h2 style="margin-top:0">${features.length > 0 ? 'Release decisions appear here' : 'Waiting for the first run'}</h2>
          <p>Every <code>qyntra run</code> or <code>qyntra gate</code> in CI uploads its decision here once <code>QYNTRA_TOKEN</code> and the <code>cloud</code> block are set. Lost the token? Create one in <a href="/o/${org.slug}/p/${project.slug}/settings">Settings</a>.</p></div>`
      : html`<div class="grid">
        <div class="card stat"><div class="label">Latest verdict</div><div class="value">${verdictBadge(latest.verdict)}</div><div class="small muted">${latest.branch ?? ''} · ${relativeTime(latest.received_at)}</div></div>
        <div class="card stat"><div class="label">Quality score</div><div class="value">${latest.quality_score}</div><div class="small muted">confidence ${latest.confidence}</div></div>
        <div class="card stat"><div class="label">Pass rate</div><div class="value">${passRate === undefined ? '—' : `${passRate}%`}</div><div class="small muted">${latest.passed} of ${latest.total} tests</div></div>
        <div class="card stat"><div class="label">Called safe, then broke</div><div class="value">${record.escapeRate === null ? '—' : `${Math.round(record.escapeRate * 100)}%`}</div><div class="small muted">${record.escapes} of ${record.calledSafe} judged releases</div></div>
      </div>
      <div class="card"><div class="small muted">Quality score, last ${runs.length} runs</div>${sparkline(runs.map((run) => run.quality_score).reverse())}</div>
      ${branches.size > 1
        ? html`<h2>By branch</h2><table><thead><tr><th>Branch</th><th>Verdict</th><th>Score</th><th>When</th></tr></thead><tbody>
          ${[...branches.values()].map((run) => html`<tr><td>${run.branch}</td><td>${verdictBadge(run.verdict)}</td><td>${run.quality_score}</td><td class="muted">${relativeTime(run.received_at)}</td></tr>`)}
          </tbody></table>`
        : ''}
      <h2>Recent runs</h2>
      <table><thead><tr><th>When</th><th>Verdict</th><th>Score</th><th>Tests</th><th>Branch</th><th>Commit</th></tr></thead><tbody>
      ${runs.slice(0, 25).map(
        (run) => html`<tr>
          <td><a href="/o/${org.slug}/p/${project.slug}/runs/${run.id}">${relativeTime(run.received_at)}</a></td>
          <td>${verdictBadge(run.verdict)}</td><td>${run.quality_score}</td>
          <td>${run.passed}/${run.total}${run.failed ? html` <span class="badge bad">${run.failed} failed</span>` : ''}</td>
          <td>${run.branch ?? '—'}${run.pull_request ? ` #${run.pull_request}` : ''}</td>
          <td><code>${run.commit_sha?.slice(0, 7) ?? '—'}</code></td>
        </tr>`
      )}
      </tbody></table>`}`,
    { session: current, orgSlug: org.slug }
  );
}

function runPage(context: WebContext, request: Request): Response {
  const { session: current, org, project } = requireProject(context, request);
  const run = context.store.run(project.id, request.params.run);
  if (!run) throw new HttpError(404, 'Not found.');

  const payload = JSON.parse(run.payload) as {
    reasons?: { blocking: string[]; warnings: string[] };
    decision?: Record<string, number>;
    diagnoses?: { test: string; error: string; rootCause: string }[];
  };
  const tests = context.store.runTests(run.id);

  return page(
    context,
    request,
    `Run ${run.commit_sha?.slice(0, 7) ?? run.id.slice(0, 8)}`,
    html`<p class="small"><a href="/o/${org.slug}/p/${project.slug}">${project.name}</a> /</p>
    <h1>${verdictBadge(run.verdict)} Quality score ${run.quality_score}</h1>
    <p class="muted">${run.branch ?? ''}${run.pull_request ? ` · PR #${run.pull_request}` : ''}${run.commit_sha ? html` · <code>${run.commit_sha.slice(0, 12)}</code>` : ''} · decided ${relativeTime(run.decided_at ?? run.received_at)} · confidence ${run.confidence} · AI ${run.ai_provider ?? 'none'} · uploaded at level "${run.level}"</p>
    <div class="grid">
      <div class="card stat"><div class="label">Tests</div><div class="value">${run.passed}/${run.total}</div><div class="small muted">${run.failed} failed, ${run.skipped} skipped</div></div>
      <div class="card stat"><div class="label">Product defects</div><div class="value">${payload.decision?.productDefects ?? 0}</div></div>
      <div class="card stat"><div class="label">New regressions</div><div class="value">${payload.decision?.newRegressions ?? 0}</div></div>
      <div class="card stat"><div class="label">Known flaky failures</div><div class="value">${payload.decision?.knownFlakyFailures ?? 0}</div></div>
    </div>
    ${payload.reasons?.blocking.length ? html`<h2>Why it was blocked</h2><div class="card"><ul>${payload.reasons.blocking.map((reason) => html`<li>${reason}</li>`)}</ul></div>` : ''}
    ${payload.reasons?.warnings.length ? html`<h2>Warnings</h2><div class="card"><ul>${payload.reasons.warnings.map((warning) => html`<li>${warning}</li>`)}</ul></div>` : ''}
    ${payload.diagnoses?.length
      ? html`<h2>Diagnoses</h2>${payload.diagnoses.map((diagnosis) => html`<div class="card"><strong>${diagnosis.test}</strong><p>${diagnosis.rootCause}</p><pre>${diagnosis.error}</pre></div>`)}`
      : ''}
    <h2>Tests</h2>
    ${tests.length === 0
      ? html`<p class="muted">This project uploads at the "metrics" level, which does not include test names.</p>`
      : html`<table><thead><tr><th>Test</th><th>Status</th><th>Category</th><th>Severity</th><th>Diagnosis</th></tr></thead><tbody>
        ${tests.map(
          (test) => html`<tr><td>${test.name}</td><td>${statusBadge(test.status)}</td><td>${test.category ?? ''}</td><td>${test.severity ?? ''}</td>
            <td>${test.product_defect ? html`<span class="badge bad">product defect</span>` : test.test_defect ? html`<span class="badge warn">test defect</span>` : ''}</td></tr>`
        )}</tbody></table>`}`,
    { session: current, orgSlug: org.slug }
  );
}

function testsPage(context: WebContext, request: Request): Response {
  const { session: current, org, project } = requireProject(context, request);
  const stability = computeStability(historyEntries(context.store, project.id, { limit: 50 }));
  const debt = maintenanceDebt(stability);
  const all = Object.values(stability).sort((a, b) => b.failRate - a.failRate || a.test.localeCompare(b.test));

  return page(
    context,
    request,
    `${project.name} tests`,
    html`<p class="small"><a href="/o/${org.slug}">${org.name}</a> /</p><h1>${project.name}</h1>
    ${tabs(org, project, 'tests')}
    <div class="grid">
      <div class="card stat"><div class="label">Tests tracked</div><div class="value">${all.length}</div></div>
      <div class="card stat"><div class="label">Flaky or always failing</div><div class="value">${debt.length}</div><div class="small muted">maintenance debt — not this release's fault</div></div>
    </div>
    ${all.length === 0
      ? html`<p class="muted">No test history yet. It needs uploads at the "standard" level or higher.</p>`
      : html`<table><thead><tr><th>Test</th><th>Failed</th><th>Fail rate</th><th>Flips</th><th>State</th></tr></thead><tbody>
        ${all.slice(0, 300).map((record) => {
          const chronic = record.failures === record.observedRuns && record.failures > 0;
          const flaky = !chronic && record.transitions >= 2;
          return html`<tr><td>${record.test}</td><td>${record.failures} of ${record.observedRuns}</td><td>${Math.round(record.failRate * 100)}%</td><td>${record.transitions}</td>
            <td>${chronic ? html`<span class="badge bad">always failing</span>` : flaky ? html`<span class="badge warn">flaky</span>` : record.failures === 0 ? html`<span class="badge ok">stable</span>` : html`<span class="badge neutral">intermittent</span>`}</td></tr>`;
        })}</tbody></table>`}`,
    { session: current, orgSlug: org.slug }
  );
}

function outcomesFor(store: Store, projectId: string) {
  return store.outcomes(projectId).map((outcome) => ({
    commit: outcome.commit_sha,
    result: outcome.result as 'ok' | 'incident' | 'rollback' | 'hotfix',
    ...(outcome.severity ? { severity: outcome.severity as 'Critical' | 'High' | 'Medium' | 'Low' } : {}),
    ...(outcome.area ? { area: outcome.area } : {}),
    occurredAt: outcome.occurred_at,
    recordedAt: outcome.recorded_at,
  }));
}

function trackRecordPage(context: WebContext, request: Request): Response {
  const { session: current, org, project } = requireProject(context, request);
  const outcomes = outcomesFor(context.store, project.id);
  const runs = historyEntries(context.store, project.id, { limit: 500 });
  const record = trackRecord(outcomes, runs);

  const verdictFor = (commit: string) => [...runs].reverse().find((run) => run.git?.commit && (run.git.commit.startsWith(commit) || commit.startsWith(run.git.commit)));

  return page(
    context,
    request,
    `${project.name} track record`,
    html`<p class="small"><a href="/o/${org.slug}">${org.name}</a> /</p><h1>${project.name}</h1>
    ${tabs(org, project, 'track')}
    <p>Was "safe" actually safe? Each release Qyntra judged, and what happened after it shipped.</p>
    <div class="grid">
      <div class="card stat"><div class="label">Releases judged</div><div class="value">${record.judged}</div></div>
      <div class="card stat"><div class="label">Called safe, then broke</div><div class="value">${record.escapes}</div><div class="small muted">${record.escapeRate === null ? 'no safe calls yet' : `${Math.round(record.escapeRate * 100)}% of ${record.calledSafe}`}</div></div>
      <div class="card stat"><div class="label">Blocked, but were fine</div><div class="value">${record.falseAlarms}</div></div>
      <div class="card stat"><div class="label">Incidents Qyntra never saw</div><div class="value">${record.unjudgedIncidents}</div></div>
    </div>
    ${outcomes.length === 0
      ? html`<div class="card"><h2 style="margin-top:0">No outcomes recorded yet</h2><p>After a release, record what happened — from CI or a laptop:</p>
          <pre>npx qyntra outcome --commit &lt;sha&gt; --result ok
npx qyntra outcome --commit &lt;sha&gt; --result incident --severity High --area checkout</pre></div>`
      : html`<table><thead><tr><th>When</th><th>Commit</th><th>Qyntra said</th><th>What happened</th><th>Area</th></tr></thead><tbody>
        ${outcomes.map((outcome) => {
          const run = verdictFor(outcome.commit);
          const escape = run && (run.verdict === 'SAFE' || run.verdict === 'SAFE_WITH_RISK') && outcome.result !== 'ok';
          return html`<tr><td>${outcome.occurredAt.slice(0, 10)}</td><td><code>${outcome.commit.slice(0, 7)}</code></td><td>${verdictBadge(run?.verdict)}</td>
            <td>${outcome.result === 'ok' ? html`<span class="badge ok">ok</span>` : html`<span class="badge bad">${outcome.result}${outcome.severity ? ` · ${outcome.severity}` : ''}</span>`}${escape ? html` <strong>escape</strong>` : ''}</td>
            <td>${outcome.area ?? ''}</td></tr>`;
        })}</tbody></table>`}`,
    { session: current, orgSlug: org.slug }
  );
}

function settingsPage(context: WebContext, request: Request): Response {
  const { session: current, org, project } = requireProject(context, request);
  const tokens = context.store.tokens(project.id);
  const canEdit = ROLE_RANK[org.role] >= ROLE_RANK.admin;
  const base = `/o/${org.slug}/p/${project.slug}`;

  return page(
    context,
    request,
    `${project.name} settings`,
    html`<p class="small"><a href="/o/${org.slug}">${org.name}</a> /</p><h1>${project.name}</h1>
    ${tabs(org, project, 'settings')}
    <h2>CI tokens</h2>
    <table><thead><tr><th>Name</th><th>Token</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>
    ${tokens.map(
      (token) => html`<tr><td>${token.name}</td><td><code>${token.prefix}…</code></td><td>${token.createdAt.slice(0, 10)}</td><td>${relativeTime(token.lastUsedAt)}</td>
        <td>${token.revokedAt
          ? html`<span class="badge neutral">revoked</span>`
          : canEdit
            ? html`<form class="inline" method="post" action="${base}/tokens/${token.id}/revoke">${csrfField(current.csrf)}<button class="secondary" type="submit">Revoke</button></form>`
            : ''}</td></tr>`
    )}</tbody></table>
    ${canEdit
      ? html`<form method="post" action="${base}/tokens">${csrfField(current.csrf)}<label for="tname">New token name</label>
          <input id="tname" name="name" type="text" placeholder="e.g. GitHub Actions"><p><button type="submit">Create token</button></p></form>
        <h2>Upload level</h2>
        <form method="post" action="${base}/settings">${csrfField(current.csrf)}
          <label for="level">The most this project accepts from CI</label>
          <select id="level" name="level">${['metrics', 'standard', 'full'].map((level) => html`<option value="${level}" ${level === project.uploadLevel ? 'selected' : ''}>${level}</option>`)}</select>
          <p class="small muted">The server refuses any upload richer than this, whatever the CLI is configured to send.</p>
          <label for="retention">Keep runs for (days)</label>
          <input id="retention" name="retention" type="text" inputmode="numeric" value="${project.retentionDays}">
          <p class="small muted">Your plan allows up to ${limitsFor(org.plan).retentionDays} days.</p>
          <p><button type="submit">Save</button></p>
        </form>
        <h2>Delete project</h2>
        <form method="post" action="${base}/delete">${csrfField(current.csrf)}
          <label for="confirm">Type the project name to delete it and all its runs</label><input id="confirm" name="confirm" type="text">
          <p><button class="danger" type="submit">Delete project</button></p></form>`
      : html`<p class="muted">Ask an admin to manage tokens and settings.</p>`}`,
    { session: current, orgSlug: org.slug }
  );
}

// --------------------------------------------------
// MEMBERS, AUDIT, EXPORT
// --------------------------------------------------

function membersPage(context: WebContext, request: Request, invited?: string): Response {
  const { session: current, org } = requireOrg(context, request);
  const members = context.store.members(org.id);
  const invites = context.store.pendingInvites(org.id);
  const isAdmin = ROLE_RANK[org.role] >= ROLE_RANK.admin;

  return page(
    context,
    request,
    'Members',
    html`<h1>Members of ${org.name}</h1>
    ${invited ? html`<div class="card"><strong>Send this invitation link</strong> (valid 7 days, works once):<p class="token"><code>${invited}</code></p></div>` : ''}
    <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead><tbody>
    ${members.map(
      (member) => html`<tr><td>${member.name}</td><td>${member.email}</td>
        <td>${org.role === 'owner' && member.id !== current.user.id
          ? html`<form class="inline" method="post" action="/o/${org.slug}/members/${member.id}/role">${csrfField(current.csrf)}
              <select name="role">${ROLES.map((role) => html`<option ${role === member.role ? 'selected' : ''}>${role}</option>`)}</select> <button class="secondary" type="submit">Change</button></form>`
          : member.role}</td>
        <td>${isAdmin && member.role !== 'owner' && member.id !== current.user.id
          ? html`<form class="inline" method="post" action="/o/${org.slug}/members/${member.id}/remove">${csrfField(current.csrf)}<button class="secondary" type="submit">Remove</button></form>`
          : ''}</td></tr>`
    )}
    ${invites.map((invite) => html`<tr><td class="muted">invited</td><td>${invite.email}</td><td>${invite.role}</td><td class="muted small">expires ${invite.expiresAt.slice(0, 10)}</td></tr>`)}
    </tbody></table>
    ${isAdmin
      ? html`<h2>Invite someone</h2><form method="post" action="/o/${org.slug}/members">${csrfField(current.csrf)}
          <label for="email">Email</label><input id="email" name="email" type="email" required>
          <label for="role">Role</label><select id="role" name="role">${ROLES.filter((role) => role !== 'owner').map((role) => html`<option ${role === 'member' ? 'selected' : ''}>${role}</option>`)}</select>
          <p class="small muted">viewer: read only · member: read · admin: projects, tokens and members</p>
          <p><button type="submit">Create invitation</button></p></form>`
      : ''}`,
    { session: current, orgSlug: org.slug }
  );
}

async function invite(context: WebContext, request: Request): Promise<Response> {
  const { session: current, org } = requireOrg(context, request, 'admin');
  checkForm(context, request, current);

  const email = field(request, 'email', 200).toLowerCase();
  const role = (['viewer', 'member', 'admin'] as const).find((candidate) => candidate === field(request, 'role')) ?? 'member';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return redirect(`/o/${org.slug}/members?error=${encodeURIComponent('Enter a valid email.')}`);

  const problem = limitProblem(org.plan, { members: context.store.members(org.id).length + context.store.pendingInvites(org.id).length }, 'member');
  if (problem) return redirect(`/o/${org.slug}/billing?error=${encodeURIComponent(problem)}`);

  const existing = context.store.userByEmail(email);

  if (existing) {
    context.store.addMember(org.id, existing.id, role);
    context.store.audit(org.id, current.user.email, 'member.added', `${email} as ${role}`);
    return redirect(`/o/${org.slug}/members?ok=${encodeURIComponent(`${email} added as ${role}.`)}`);
  }

  const token = randomSecret(24);
  const link = `${context.baseUrl}/signup?invite=${token}`;
  context.store.createInvite(org.id, email, role, sha256(token), current.user.email);
  context.store.audit(org.id, current.user.email, 'member.invited', `${email} as ${role}`);

  // The link is always shown too: email may be off, or land in spam.
  await sendEmail(
    {
      to: email,
      subject: `${current.user.name} invited you to ${org.name} on Qyntra`,
      text: `${current.user.name} (${current.user.email}) invited you to join ${org.name} on Qyntra as ${role}.\n\nAccept (works once, for 7 days):\n${link}`,
    },
    context.secure
  );

  return membersPage(context, request, link);
}

function removeMember(context: WebContext, request: Request): Response {
  const { session: current, org } = requireOrg(context, request, 'admin');
  checkForm(context, request, current);

  const member = context.store.members(org.id).find((candidate) => candidate.id === request.params.user);
  if (member && member.role !== 'owner' && member.id !== current.user.id) {
    context.store.removeMember(org.id, member.id);
    context.store.audit(org.id, current.user.email, 'member.removed', member.email);
  }

  return redirect(`/o/${org.slug}/members?ok=${encodeURIComponent('Member removed.')}`);
}

function auditPage(context: WebContext, request: Request): Response {
  const { session: current, org } = requireOrg(context, request, 'admin');

  return page(
    context,
    request,
    'Audit log',
    html`<h1>Audit log</h1>
    <p class="muted">Who changed what in ${org.name}: projects, tokens, members, settings, billing.</p>
    <table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead><tbody>
    ${context.store.auditLog(org.id, 200).map((entry) => html`<tr><td>${entry.at.slice(0, 16).replace('T', ' ')}</td><td>${entry.actor}</td><td>${entry.action}</td><td>${entry.target ?? ''}</td></tr>`)}
    </tbody></table>
    ${org.role === 'owner'
      ? html`<h2>Your data</h2><div class="card">
        <form class="inline" method="post" action="/o/${org.slug}/export">${csrfField(current.csrf)}<button class="secondary" type="submit">Export everything (JSON)</button></form>
        <form method="post" action="/o/${org.slug}/delete" style="margin-top:1rem">${csrfField(current.csrf)}
          <label for="confirm">Type the organization name to delete it and all its data, permanently</label><input id="confirm" name="confirm" type="text">
          <p><button class="danger" type="submit">Delete organization</button></p></form></div>`
      : ''}`,
    { session: current, orgSlug: org.slug }
  );
}

// --------------------------------------------------
// ROUTES
// --------------------------------------------------

export function webRoutes(router: Router, context: WebContext, extra: { featurePages?: (router: Router) => void } = {}): void {
  router.get('/signup', (request) => (session(context, request) ? redirect('/app') : signupForm(context, request)));
  router.post('/signup', (request) => signup(context, request));
  router.get('/login', (request) => (session(context, request) ? redirect('/app') : loginForm(request)));
  router.post('/login', (request) => login(context, request));
  router.post('/logout', (request) => logout(context, request));
  router.get('/app', (request) => appHome(context, request));

  router.get('/o/:org', (request) => projectsPage(context, request));
  router.post('/o/:org/projects', (request) => createProject(context, request));
  router.get('/o/:org/members', (request) => membersPage(context, request));
  router.post('/o/:org/members', (request) => invite(context, request));
  router.post('/o/:org/members/:user/remove', (request) => removeMember(context, request));
  router.get('/o/:org/audit', (request) => auditPage(context, request));

  router.post('/o/:org/export', (request) => {
    const { session: current, org } = requireOrg(context, request, 'owner');
    checkForm(context, request, current);
    context.store.audit(org.id, current.user.email, 'org.exported');
    return jsonResponse(context.store.exportOrg(org.id), 200, { 'content-disposition': `attachment; filename="qyntra-${org.slug}.json"` });
  });

  router.post('/o/:org/delete', (request) => {
    const { session: current, org } = requireOrg(context, request, 'owner');
    checkForm(context, request, current);
    if (field(request, 'confirm', 200) !== org.name) {
      return redirect(`/o/${org.slug}/audit?error=${encodeURIComponent('The name did not match; nothing was deleted.')}`);
    }
    context.store.deleteOrg(org.id);
    return redirect(`/?ok=${encodeURIComponent('Organization and all its data deleted.')}`);
  });

  router.get('/o/:org/p/:project', (request) => overview(context, request));
  router.get('/o/:org/p/:project/runs/:run', (request) => runPage(context, request));
  router.get('/o/:org/p/:project/tests', (request) => testsPage(context, request));
  router.get('/o/:org/p/:project/track-record', (request) => trackRecordPage(context, request));
  router.get('/o/:org/p/:project/settings', (request) => settingsPage(context, request));

  router.post('/o/:org/p/:project/tokens', (request) => {
    const { session: current, org, project } = requireProject(context, request, 'admin');
    checkForm(context, request, current);
    const token = newApiToken();
    context.store.createToken(project.id, field(request, 'name', 60) || 'CI', token.hash, token.prefix);
    context.store.audit(org.id, current.user.email, 'token.created', `${project.name}: ${token.prefix}…`);
    return tokenShown(context, request, current, org, project, token.token, false);
  });

  router.post('/o/:org/p/:project/tokens/:token/revoke', (request) => {
    const { session: current, org, project } = requireProject(context, request, 'admin');
    checkForm(context, request, current);
    context.store.revokeToken(project.id, request.params.token);
    context.store.audit(org.id, current.user.email, 'token.revoked', project.name);
    return redirect(`/o/${org.slug}/p/${project.slug}/settings?ok=${encodeURIComponent('Token revoked. CI using it will be refused from now on.')}`);
  });

  router.post('/o/:org/p/:project/settings', (request) => {
    const { session: current, org, project } = requireProject(context, request, 'admin');
    checkForm(context, request, current);
    const level = ['metrics', 'standard', 'full'].includes(field(request, 'level')) ? field(request, 'level') : project.uploadLevel;
    const retention = Math.min(Math.max(Number(field(request, 'retention')) || project.retentionDays, 1), limitsFor(org.plan).retentionDays);
    context.store.updateProject(org.id, project.id, { uploadLevel: level, retentionDays: retention });
    context.store.audit(org.id, current.user.email, 'project.settings', `${project.name}: level ${level}, ${retention} days`);
    return redirect(`/o/${org.slug}/p/${project.slug}/settings?ok=${encodeURIComponent('Saved.')}`);
  });

  router.post('/o/:org/p/:project/delete', (request) => {
    const { session: current, org, project } = requireProject(context, request, 'admin');
    checkForm(context, request, current);
    if (field(request, 'confirm', 200) !== project.name) {
      return redirect(`/o/${org.slug}/p/${project.slug}/settings?error=${encodeURIComponent('The name did not match; nothing was deleted.')}`);
    }
    context.store.deleteProject(org.id, project.id);
    context.store.audit(org.id, current.user.email, 'project.deleted', project.name);
    return redirect(`/o/${org.slug}?ok=${encodeURIComponent(`${project.name} deleted.`)}`);
  });

  extra.featurePages?.(router);
}

/** For other page modules: the same guards and layout. */
export const guards = { session, requireSession, requireOrg, requireProject, checkForm, page, tabs, ROLE_RANK };
