# Qyntra — Capabilities

**Qyntra is an AI Quality Engineer.** Point it at an application and a few
plain-English requirements. It discovers what to test, writes and runs
Playwright tests, works out whether a failure is a broken test or a real
product defect, repairs broken tests, and gives an auditable release
decision. It runs in your own CI, and your code and data stay there.

The details for every capability below are in the [README](../README.md).

---

## At a glance

| Layer | What Qyntra does |
| ----- | ---------------- |
| **Inputs** | Reads requirements, the live app, an OpenAPI spec, the git diff, your own Playwright suites, and release outcomes |
| **Application intelligence** | Logs in, explores the app, maps its pages, elements, flows and APIs, and rates risk from what it found |
| **Test intelligence** | Generates UI, API-contract, security, API write-lifecycle, AI-feature and behaviour-probe tests |
| **Execution** | Runs everything in Playwright, in your CI, read-only by default |
| **Failure intelligence** | Diagnoses each failure from trace, network, console, DOM and screenshot, and calls it a *test defect* or a *product defect* |
| **Remediation** | Proposes verified repairs for broken tests, with guards that stop a repair from passing by checking less |
| **Release intelligence** | Gives a `SAFE` / `SAFE_WITH_RISK` / `UNSAFE` verdict with a quality score, using history, flakiness, change risk, performance and the gate's own track record |
| **Cloud** | Keeps history, dashboards, alerts, PR comments, teams and billing, receiving summaries only |

---

## 1. Setup and operability

- **One-command onboarding.** `init` writes the config and picks a free AI
  that works on the machine: Ollama, then Gemini's free tier, then the
  deterministic analyzer. It never picks a paid provider.
- **`doctor` preflight.** Checks the config, credentials and app
  reachability. It also sends a real AI provider request and checks the
  model is installed, loads the OpenAPI spec and reports how much of it
  can be tested, verifies the Cloud token, and counts stored history runs.
- **Secrets never live in the config.** The config names environment
  variables only. A config containing a literal password, username,
  secret or token is rejected.
- **Stable exit codes** for CI branching: 0 success, 1 blocked, 2 config
  error, 3 missing artifact, 4 app unreachable, 5 login failed, 70
  internal error. An outage never looks like an "unsafe" verdict.
- **Structured logging.** Log levels, a JSON-lines format, and automatic
  redaction of values that look like credentials.

## 2. Authentication

- **Real-browser form login** before discovery, saved as a session that
  every test reuses.
- **Login is confirmed, not assumed.** It uses a success selector, or
  requires both that the password field disappears and that the URL
  leaves the login page.
- **Two-step logins** (email → Continue → password, as on Auth0, Okta and
  Google) work with the same config.
- **Clear failure reasons:** wrong credentials, wrong selector or missing
  environment variable, each with its own exit code and a failure
  screenshot.
- **Session hygiene.** Logs in fresh on every run. The session file is
  owner-only, kept outside the uploaded artifacts, and gitignored.
- **Header-token auth** for API and AI-feature tests, read from
  environment variables.

## 3. Application discovery and risk

- **Autonomous exploration** within an action budget, with excluded
  paths, building an application map of pages, elements, forms and
  capabilities.
- **Traffic capture.** Records the XHR and fetch calls the app makes,
  generalises IDs (`/api/articles/{id}`), and ignores analytics and
  monitoring traffic.
- **Page-load timings** (TTFB, DOM ready, load, LCP), measured during
  discovery.
- **Evidence-based risk rating.** Risk comes from what discovery actually
  found: payment and credential surfaces, destructive controls, uploads,
  forms, mutation paths and endpoints. Requirement wording counts for at
  most 3 points and can never make risk CRITICAL on its own. Every point
  is attributed to the evidence that earned it.

## 4. Test generation

### UI tests
- Playwright tests generated from the requirements and the application
  map.
- **Your own suites** can be included in the gate and in diagnosis and
  repair. Only generated tests run by default, so an unrelated green
  suite can't make an untested app look safe.

### API tests from observed traffic
- **Contract tests** for each JSON endpoint seen: status, content type,
  response *shape* (keys and types only, never values), and a
  response-time budget. Nullable and optional fields are handled so they
  don't cause false failures.
- **Anonymous-access refusal tests** (401/403) for every endpoint that
  carried a session. These catch security regressions that UI tests never
  notice.
- **Safe by design.** Writes are never replayed, and credential-like
  query parameters are dropped.

### API tests from an OpenAPI 3.x spec
- The spec can be JSON or YAML, a file path or a URL. Qyntra generates
  documented-contract tests (required properties and types),
  secured-operation refusal tests, and unknown-id 404 tests.
- **Parameter values** come from config, then from the spec's examples,
  defaults or enums. Anything it can't test is skipped, named, and given
  a fix.
- **Unsafe operations are skipped:** state-changing GETs (`/logout`,
  `/token`, …), credential parameters and deprecated operations.

### API write-path lifecycle tests (opt-in sandbox)
- create → read back and compare → update → re-read → delete → confirm
  gone.
- **Layered safety.** Off by default, and only runs against an allowlist
  of hosts that the test re-checks at runtime. Records get a unique
  `qyntra-test-…` marker, and delete runs in `finally`.

### Testing the AI features inside your product
- **Endpoint or chat-widget testing.** Calls the API directly, or drives
  the chat UI in a real browser and waits for a streamed reply to finish.
- **Deterministic checks:** `contains`, `notContains`, regex and latency.
- **Built-in adversarial probes:** prompt injection, role escape, data
  exfiltration, and empty, oversized and non-English input.
- **Canary leak detection.** A unique string planted in the system prompt
  fails any answer that contains it.
- **A judge you don't have to take on trust.** Rubrics are graded at
  temperature 0. The judge must quote evidence word for word, the quote
  must contain the facts the rubric names, and each judge is calibrated on
  known good and bad answers before use. A judge that fails calibration
  is skipped, never counted as a pass.

### Feature testing with behaviour probes
- `qyntra feature "<name>"` finds a feature in the menu, explores its
  views, understands it (purpose, users, fields, rules, steps), writes
  Playwright tests from verified unique locators, and keeps only tests
  that pass twice.
- **Behaviour probes written by code, not by the AI.** They cover search,
  filters (native and ARIA dropdowns), sorting (numbers, money, %, dates,
  text, in both directions), pagination, and form validation (empty form,
  out-of-range numbers, invalid email).
- **Anti-vacuity.** AI tests that still pass with their actions removed
  are dropped, and every kept test is retitled by what it actually checks.
- **Ready / ready with issues / not ready.** Only browser-observed facts
  and failing tests can make a feature *not ready*. The AI's review is
  labelled "verify before acting".
- **Observed issues:** HTTP and GraphQL errors, slow rendering, unlabelled
  controls, broken menu links and calls to `localhost`.
- **Read-only enforced at the network.** Mutations and
  POST/PUT/PATCH/DELETE are aborted before they leave the machine.
  `--allow-writes` turns this off for sandboxes.
- **Portable output.** The verified suite runs with plain Playwright,
  without Qyntra.
- **`--no-ai` mode** takes about a minute per feature and sends nothing to
  any model.
- **`qyntra app`** checks every feature in the menu in parallel, puts the
  bugs first in one report, and keeps going if one feature fails to load.

## 5. Failure diagnosis

- **Evidence from the browser, not just the error text:** uncaught page
  exceptions, failed requests, console errors, the test's steps (with the
  failing one marked), the accessibility snapshot and the screenshot.
- **Test defect vs. product defect.** A 5xx response or a page crash
  points to the product even when the symptom is a timeout or a missing
  element.
- **Works without AI.** The deterministic analyzer uses the same evidence.
- **Vision support.** Screenshots go to models that can see, and Qyntra
  asks Ollama which ones can rather than guessing.
- **Resilient AI calls.** Temporary errors are retried with backoff. When
  the provider is out of quota or down, Qyntra falls back to the
  deterministic analyzer and lowers its confidence instead of failing.

## 6. Verified test repair

- **Reproduce → propose → check → verify.** Flaky tests are left alone.
  Patches use locators that were really on the page. Each patch must pass
  twice before it's kept, then the original file is restored and the AI
  gets one retry with the new error.
- **Anti-cheating guards.** A patch is refused if it removes or weakens
  assertions, uses skip/only/fixme/soft/`.not`/try-catch/force/fixed
  waits, or changes what the test simulates (mocks, injected scripts,
  cookies, storage).
- Patches that change an expected value are marked **review required**.
- **Propose-only by default.** Patches are standard unified diffs, and
  `repair --apply` writes them.
- Product defects and Qyntra's own generated tests are never "repaired".
- **Crash-safe.** If a run is interrupted mid-patch, the next run restores
  the original file. A per-run cap limits the number of repairs.

## 7. Release decision

- **Verdict:** `SAFE` / `SAFE_WITH_RISK` / `UNSAFE`, with a quality score,
  confidence, pass rate and risk, and an itemised breakdown of every
  deduction.
- **Configurable gate:** limits on critical and high failures, a minimum
  score, and whether product defects, new regressions or performance
  regressions block.
- **History-aware classification:** new regression, known flaky (40%
  weight), chronic (30% weight), intermittent or unknown.
- **Safety properties:**
  - zero tests can never pass;
  - degraded analysis lowers confidence and never fakes a pass;
  - missing history never earns a discount;
  - flakiness can't wave a product defect through;
  - verdicts are idempotent across CI retries.
- **Change intelligence.** Reads the git diff, classifies changed files
  (source, test, dependency), flags sensitive areas (auth, payments, data,
  security), and adds capped risk points. It warns when a changed area has
  no test that mentions it.
- **Performance regression tracking.** Measures API p50, p95 and error
  rate plus page-load timings against the median of previous runs, with
  noise thresholds. Regressions warn by default and can be made to block.
  This is deliberately not a load test.
- **Learning from releases.** `qyntra outcome` records ok, incident,
  rollback or hotfix (`--detect` infers outcomes from git). Incidents
  raise risk in matching areas for 30–90 days. The gate's own track record
  of SAFE calls that later caused trouble lowers its confidence.
- **Outputs:** `release-decision.json`, a self-contained HTML dashboard
  with embedded screenshots, a GitHub job summary, and a PR comment that
  is updated on every push.

## 8. CI integration

- A GitHub Action plus a ready-made workflow (`docs/ci/qyntra.yml`): a
  decision on every PR, and a daily job that detects release outcomes.
- Works as a **required status check**. `gate` can run as a separate,
  later job.
- Per-environment overrides for the AI provider and model: Ollama locally,
  Gemini in CI.
- Run history persists through the CI cache or through Qyntra Cloud.

## 9. Qyntra Cloud (SaaS / self-hostable)

- **Ingest API.** Takes runs (idempotent), history, outcomes and feature
  reports. Authenticated with project tokens.
- **Dashboards:** per project and across projects, run history,
  flaky-test tracking, release track record, and feature and app reports
  over time.
- **Upload levels (`metrics` / `standard` / `full`)** are enforced on the
  server, which rejects anything richer than the project allows. No level
  includes source, screenshots, traces, DOM or request bodies. URLs are
  cut down to their origin and credentials are masked. `upload --dry-run`
  shows exactly what would be sent.
- **Cloud-backed history** (`cloud.history`) makes flakiness detection work
  without a CI cache.
- **Collaboration:** organizations, projects, members and roles,
  invitations, password reset, and account self-service.
- **Alerts and workflow:** Slack alerts on blocked releases (only
  `hooks.slack.com` URLs are accepted, to prevent SSRF), and GitHub PR
  comments with no app to install.
- **Billing:** Stripe Checkout and the customer portal, with the webhook as
  the source of truth for each plan. Free, Team ($49/project), Business
  ($299) and Enterprise plans, with limits enforced where usage happens.
- **Operator console** for setting plans by hand (pilots, invoiced
  enterprise customers).
- **Security:** only hashes of passwords (scrypt), sessions and tokens are
  stored. CSRF protection, same-origin POSTs, tenant isolation on every
  query, escape-by-default HTML, and server-rendered pages with no
  JavaScript under a strict CSP.
- **Self-hosting:** one Node.js process and one SQLite file
  (`npm run cloud` or `Dockerfile.cloud`).

## 10. Privacy and AI choice

- **Free and local first:** Ollama (fully local), Gemini free tier, OpenAI
  (paid), or `none` (deterministic analyzer).
- **Nothing leaves your environment** except calls to the LLM you chose
  and, if you opt in, Cloud summaries.
- **What reaches the AI is minimised:** URLs are cut to origin and path,
  credentials are masked, and source code, request and response bodies,
  cookies and video are never sent. Screenshots can be kept local
  (`includeScreenshots: false`).
- `qyntra pilot-report` produces shareable, counts-only summaries of runs,
  decisions, accuracy and repairs.

---

## Current limitations

- Login is form-based only. No MFA/OTP, CAPTCHA or SSO buttons.
- Chromium only.
- No load or capacity testing.
- Write tests need an OpenAPI 3.x spec and a named sandbox. No Swagger 2.0
  or external `$ref`s.
- Change analysis reads paths, line counts and route strings, not
  semantics.
- Repair needs an AI provider. Small local models can fix locators but
  often not expected values.
- Rubric judging is only as good as the judge model. Chat-UI tests read
  text replies only.
- Run history keys on test title, so renaming a test resets its baseline.
