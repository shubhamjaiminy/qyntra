/**
 * Public pages: landing, pricing, docs, security, and legal templates.
 */

import { html, htmlResponse, type Router } from './http';
import { PLANS } from './plans';
import { layout } from './views';

const page = (title: string, content: ReturnType<typeof html>) => htmlResponse(layout({ title, section: 'public' }, content));

export function publicRoutes(router: Router, options: { baseUrl: string }): void {
  router.get('/', () =>
    page(
      'The AI quality engineer that decides if a release is safe',
      html`<section class="hero">
        <h1>Know if a release is safe — before your users find out.</h1>
        <p>Qyntra finds your app's features, tests how they behave, explains every failure, and gives each pull request a release decision you can audit. Your tests run in your CI. Your code never leaves it.</p>
        <p><a class="button" href="/signup">Start free</a> <a class="button secondary" href="/docs">Read the docs</a></p>
      </section>
      <section id="how" class="features">
        <div class="card"><h2 style="margin-top:0">Point it at a feature</h2><p><code>qyntra feature "Billing"</code> finds it in your app's menu, explores it read-only, and works out what it is for — no selectors, no test scripts.</p></div>
        <div class="card"><h2 style="margin-top:0">It tests behaviour, not buttons</h2><p>Search must narrow. Filters must filter. Sorting must sort. A 150% discount must be rejected. Qyntra checks the rules every app must follow, and catches the bug a developer just shipped.</p></div>
        <div class="card"><h2 style="margin-top:0">Every failure explained</h2><p>Broken test or real bug? Qyntra reads the trace, screenshot and page, says which — and repairs broken tests, keeping a fix only when it passes twice.</p></div>
        <div class="card"><h2 style="margin-top:0">A decision, not a wall of red</h2><p><strong>SAFE</strong>, <strong>SAFE WITH RISK</strong> or <strong>UNSAFE</strong> on every pull request, with the reasons — and a track record of whether "safe" was actually safe.</p></div>
        <div class="card"><h2 style="margin-top:0">Your data stays yours</h2><p>Everything runs in your CI, read-only by default. The cloud receives results only, at a level you choose: counts, test names, or full diagnoses. Never source, screenshots or traces.</p></div>
        <div class="card"><h2 style="margin-top:0">Any AI, including none</h2><p>Use a free model on your own machine, Gemini, or OpenAI — or no AI at all: the behaviour checks and release decisions still work.</p></div>
      </section>
      <section class="card">
        <h2 style="margin-top:0">Five minutes to the first decision</h2>
        <pre>npm install --save-dev qyntra
npx qyntra init
npx qyntra app            # every feature in the menu, checked
npx qyntra run            # tests, diagnosis, release decision</pre>
        <p>Add <code>QYNTRA_TOKEN</code> to CI and every run lands on your dashboard, with history, flaky-test tracking and the release track record.</p>
      </section>`
    )
  );

  router.get('/pricing', () =>
    page(
      'Pricing',
      html`<h1>Pricing</h1>
      <p class="muted">The CLI is free and runs in your CI. Plans add the cloud: history, dashboards, track record, team and alerts.</p>
      <div class="plans">
        ${Object.entries(PLANS).filter(([, plan]) => !plan.hidden).map(
          ([key, plan]) => html`<div class="card plan">
            <h2 style="margin-top:0">${plan.name}</h2>
            <div class="price">${plan.price === undefined ? 'Talk to us' : plan.price === 0 ? '$0' : `$${plan.price}`}<span class="small muted">${plan.price ? (plan.perProject ? ' / project / month' : ' / month') : ''}</span></div>
            <ul>${plan.features.map((feature) => html`<li>${feature}</li>`)}</ul>
            ${key === 'enterprise' ? html`<a class="button secondary" href="mailto:sales@qyntra.dev">Contact sales</a>` : html`<a class="button" href="/signup">Start free</a>`}
          </div>`
        )}
      </div>
      <p class="small muted">Prices in USD, excluding tax. Cancel any time; you keep the CLI and everything it generated.</p>`
    )
  );

  router.get('/docs', () =>
    page(
      'Docs',
      html`<h1>Get started</h1>
      <div class="card"><h2 style="margin-top:0">1. Install and configure</h2>
        <pre>npm install --save-dev qyntra @playwright/test
npx playwright install chromium
npx qyntra init      # writes .qyntra/config.json
npx qyntra doctor    # checks config, login, AI and reachability</pre></div>
      <div class="card"><h2 style="margin-top:0">2. Check features</h2>
        <pre>npx qyntra feature "Fee Rules"       # one feature, with AI
npx qyntra feature "Fee Rules" --no-ai   # behaviour checks only, about a minute
npx qyntra app --concurrency 4          # every feature in the menu</pre>
        <p>Read-only by default: write requests are blocked at the network. Reports land in <code>qyntra-out/</code>.</p></div>
      <div class="card"><h2 style="margin-top:0">3. Connect the cloud</h2>
        <p>Create a project, save its token as the CI secret <code>QYNTRA_TOKEN</code>, and add to <code>.qyntra/config.json</code>:</p>
        <pre>"cloud": { "url": "${options.baseUrl}", "project": "your-project", "upload": "standard" }</pre>
        <p><code>npx qyntra upload --dry-run</code> shows exactly what would be sent. <code>"history": true</code> in the cloud block makes CI read run history from the cloud, so flaky-test detection needs no CI cache.</p></div>
      <div class="card"><h2 style="margin-top:0">4. Record what happened</h2>
        <pre>npx qyntra outcome --commit &lt;sha&gt; --result ok|incident|rollback|hotfix</pre>
        <p>This builds the track record: how often "safe" was actually safe.</p></div>
      <p>The complete reference is the README shipped with the package.</p>`
    )
  );

  router.get('/security', () =>
    page(
      'Security',
      html`<h1>Security</h1>
      <div class="card"><h2 style="margin-top:0">Where your data is</h2>
        <p>Qyntra runs in your CI. Exploration, tests, diagnosis and repair happen there; screenshots, traces, DOM and source code never leave it. The cloud receives a run summary at the level you choose per project, enforced by both the CLI and the server:</p>
        <ul><li><strong>metrics</strong> — verdict, score, counts</li><li><strong>standard</strong> — plus commit, branch, test names and statuses, blocking reasons</li><li><strong>full</strong> — plus truncated error messages, AI diagnoses and verified repair diffs</li></ul>
        <p>URLs in any text are cut to their origin, and credential-like values are masked, before upload.</p></div>
      <div class="card"><h2 style="margin-top:0">How it is protected</h2>
        <ul>
          <li>CI tokens and sessions are stored only as SHA-256 hashes; passwords with scrypt.</li>
          <li>Every page and API call is scoped to the organization it belongs to.</li>
          <li>Pages run no JavaScript; the Content-Security-Policy forbids scripts entirely.</li>
          <li>CSRF tokens on every form, same-origin checks on every post, rate limits on login and the API.</li>
          <li>An audit log of projects, tokens, members, settings and billing; self-serve export and deletion.</li>
          <li>Read-only testing by default: write requests from exploration and generated tests are blocked at the network.</li>
        </ul></div>
      <p>Report a vulnerability: <a href="mailto:security@qyntra.dev">security@qyntra.dev</a></p>`
    )
  );

  const legal = (title: string, sections: [string, string][]) =>
    page(
      title,
      html`<h1>${title}</h1>
      <div class="flash error">Draft template — to be reviewed by a lawyer before Qyntra accepts paying customers.</div>
      ${sections.map(([heading, text]) => html`<h2>${heading}</h2><p>${text}</p>`)}`
    );

  router.get('/terms', () =>
    legal('Terms of service', [
      ['The service', 'Qyntra Cloud stores and displays results that your copy of the Qyntra CLI uploads. The CLI runs in your environment under its own license.'],
      ['Your account', 'You are responsible for activity under your account and for keeping CI tokens secret. Revoke a token as soon as it may be exposed.'],
      ['Your data', 'You own the data you upload. We process it only to provide the service, and delete it when you delete it or your organization.'],
      ['Acceptable use', 'Use Qyntra only on applications you are allowed to test. Do not use it to test systems without their owner\'s permission.'],
      ['Plans and billing', 'Paid plans renew monthly until cancelled. Limits are described on the pricing page.'],
      ['Liability', 'Release decisions are guidance. Your team remains responsible for what it releases.'],
    ])
  );

  router.get('/privacy', () =>
    legal('Privacy policy', [
      ['What we collect', 'Account details (name, email), organization and project names, and the run summaries your CI uploads at the level you choose.'],
      ['What we never collect', 'Your source code, screenshots, traces, page content or test data. Those stay in your CI.'],
      ['How long we keep it', 'Runs are kept for the retention you set per project, within your plan\'s limit. Deleting an organization deletes all of its data.'],
      ['Who sees it', 'Members of your organization. We do not sell data or share it with advertisers.'],
      ['Your rights', 'Export everything from the Audit log page; delete your organization at any time.'],
    ])
  );
}
