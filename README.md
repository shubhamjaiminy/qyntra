# Qyntra

**AI Quality Engineer.** Point Qyntra at an application and a set of
requirements. It discovers what should be tested, generates and runs
Playwright tests, explains failures, distinguishes broken tests from real
product defects, and produces an auditable release decision.

Qyntra runs as a dev dependency inside your repository and executes in
your CI. No Qyntra-operated servers, no agents, and your source code and
test data never leave your environment.

---

## Quick start

```bash
npm install --save-dev qyntra
npx qyntra init      # writes .qyntra/config.json
npx qyntra doctor    # validates config, credentials, reachability
npx qyntra login     # apps behind a login: proves app.auth works
npx qyntra run       # full pipeline, ends with a release decision
```

`doctor` before `run` is worth the ten seconds: it catches the
misconfigurations that otherwise surface as a confusing mid-pipeline
failure.

---

## Configuration

`.qyntra/config.json`, created by `qyntra init`:

```json
{
  "app": {
    "name": "Acme Billing",
    "baseUrl": "https://staging.acme.example",
    "auth": {
      "type": "form",
      "loginUrl": "https://staging.acme.example/login",
      "usernameSelector": "#email",
      "passwordSelector": "#password",
      "submitSelector": "button[type=\"submit\"]",
      "usernameEnv": "QYNTRA_APP_USER",
      "passwordEnv": "QYNTRA_APP_PASSWORD",
      "successSelector": "[data-testid=\"dashboard\"]"
    }
  },

  "requirements": [
    "User can complete a payment",
    "User cannot check out with an expired card"
  ],

  "output": { "dir": "qyntra-out" },

  "discovery": {
    "explore": true,
    "maxActions": 25,
    "timeoutMs": 30000,
    "excludePaths": ["/logout", "/admin/billing"]
  },

  "ai": {
    "provider": "openai",
    "model": "gpt-5-mini",
    "apiKeyEnv": "OPENAI_API_KEY"
  },

  "gate": {
    "maxCriticalFailures": 0,
    "maxHighFailures": 0,
    "minQualityScore": 80,
    "allowLowSeverityFailures": true,
    "blockOnProductDefect": true,
    "blockOnNewRegression": true,
    "historyRuns": 50
  }
}
```

### Credentials

**Qyntra never reads credentials from the config file.** The file names
the environment variables to read them from, and Qyntra rejects a config
containing a literal `password`, `username`, `secret` or `token` field.
Config files get committed; secrets must not be.

Set them as CI secrets:

```bash
export QYNTRA_APP_USER="qa-bot@acme.example"
export QYNTRA_APP_PASSWORD="..."
export OPENAI_API_KEY="..."
```

With no API key — or a provider that is out of quota or not running —
Qyntra degrades to its deterministic analyzer rather than failing: the
pipeline still runs, and the release decision reports lower confidence
to reflect it.

### AI providers

| Provider | Cost | Key | Data leaves your machine |
| -------- | ---- | --- | ------------------------ |
| `ollama` | Free | None | No — the model runs locally |
| `gemini` | Free tier | `GEMINI_API_KEY` ([aistudio.google.com](https://aistudio.google.com/apikey)) | Yes, to Google |
| `openai` | Paid | `OPENAI_API_KEY` | Yes, to OpenAI |
| `none`   | Free | None | No — deterministic analyzer only |

Only `provider` is required; `model`, `apiKeyEnv` and (for Ollama)
`baseUrl` default per provider:

```json
"ai": { "provider": "ollama", "model": "qwen2.5-coder:7b" }
```

To run Ollama:

```bash
brew install ollama         # or see ollama.com/download
ollama serve                # leave running
ollama pull qwen2.5-coder:7b
npx qyntra doctor           # confirms the model is installed
```

A 7B model needs about 8 GB of free RAM and takes a few seconds to tens
of seconds per failure. To share one GPU machine across a team or CI,
point `"baseUrl"` at it, e.g. `"http://gpu-box:11434"`.

Temporary provider errors — 503 "high demand", gateway errors, rate
limits — are retried after about 2, 6 and 15 seconds. If the provider is
still unavailable, or the account is out of quota, Qyntra stops calling
it and analyzes the remaining failures deterministically, rather than
repeating the same error for every failing test.

`qyntra doctor` sends one tiny real request to cloud providers. A key
that is set proves nothing on its own: the model may have been retired
(Google retires Gemini models for new accounts), or the account may be
out of credit. Doctor reports the provider's own message.

The default Gemini model is pinned (`gemini-3.5-flash`), not an alias
like `gemini-flash-latest`, so the model behind a release decision does
not change between runs without you choosing it. It is deliberately not
the newest: on the free tier the newest model was persistently
overloaded while this one answered in seconds.

### Authentication

When `app.auth` is set, Qyntra logs in with a real browser before
discovery, **confirms the login worked**, and saves the session. Discovery
and every test then run as that logged-in user.

```bash
npx qyntra login     # log in, confirm, save the session — nothing else
```

Run `qyntra login` first whenever you point Qyntra at a new app: it takes
seconds and tells you exactly what is wrong.

| Outcome | What you see | Exit |
| ------- | ------------ | ---- |
| Logged in | `Landed on : https://app.example/dashboard` | `0` |
| Wrong credentials | `Login rejected by the application: "Invalid email or password"` | `5` |
| Wrong selector | `Login form not found: app.auth.usernameSelector "#email" matched nothing visible` | `5` |
| Credentials not exported | `Login credentials not set: QYNTRA_APP_USER` | `2` |

How success is decided: with `successSelector`, that element must appear.
Without it, the password field must disappear *and* the URL must leave the
login page. An unchanged page is never treated as success, because a
silently failed login would have every later stage testing the login
screen and reporting plausible nonsense. On failure a screenshot is saved
to `.qyntra/.auth/login-failure.png`; set `QYNTRA_HEADED=1` to watch the
login happen.

Two-step logins (email → Continue → password, as on Auth0, Okta and
Google) work with the same config: if the password field is not visible
after the username is filled, Qyntra clicks submit and waits for it.

**The session file is a credential.** It is written to
`.qyntra/.auth/storage-state.json` with owner-only permissions — outside
`qyntra-out/`, which CI uploads as an artifact — and must be gitignored:

```gitignore
.qyntra/.auth/
```

Qyntra logs in fresh on every `run` and never reuses an old session, so
expired sessions cannot cause false failures.

**Your own tests** can reuse the session too. Generated tests pick it up
automatically; for hand-written ones add one line to `playwright.config.ts`:

```ts
use: {
  storageState: process.env.QYNTRA_STORAGE_STATE,
}
```

Qyntra logs in as Playwright's `Desktop Chrome` device with locale
`en-US`, the Playwright Test defaults. Many apps bind a session to the
browser's user agent and language as anti-hijacking protection; if your
Playwright project uses a different device or locale, the session may be
rejected and tests will land on the login page.

---

## How failures are diagnosed

The error message says what the test saw. The browser says what the
application did, and that is usually what separates a broken test from
a broken product. For every failure Qyntra reads the artifacts
Playwright already captures (`trace: 'retain-on-failure'`,
`screenshot: 'only-on-failure'`) and extracts:

| Evidence | From | Why it matters |
| -------- | ---- | -------------- |
| Uncaught page exceptions | trace | The application crashed during the test |
| Failed requests (4xx/5xx, never completed) | trace | A 500 explains a "missing element" better than any locator |
| Console errors and warnings | trace | What the application itself logged |
| The test's steps, failing one marked | trace | Could these steps even produce the expected state? |
| Page accessibility snapshot | `error-context.md` | What was actually on the page |
| Screenshot | attachment | Sent as an image to vision-capable models |

A 5xx response or an uncaught exception during the test makes Qyntra
attribute the failure to the product, even when the visible symptom is a
timeout or a missing element — the element is missing *because* the page
broke. This applies with no AI configured too: the deterministic analyzer
uses the same evidence.

Every failure card on the dashboard shows this evidence with the
screenshot embedded, plus the command to open the full trace.

Screenshots reach a model only if it can see. Gemini and OpenAI can;
among local models `qwen2.5-coder:7b` (the default) cannot, while
`gemma3:4b` can and fits in less memory. Qyntra asks Ollama for the
model's capabilities rather than guessing from its name.

---

## Repairing broken tests

When a failure is diagnosed as a **test defect**, Qyntra tries to fix the
test and proves the fix before showing it to you:

1. **Reproduce.** The test is re-run alone. If it passes, it is flaky, and
   Qyntra leaves it alone — rewriting a flaky test fixes nothing.
2. **Propose.** The model suggests minimal edits, choosing locators from
   the elements actually on the page at failure (test ids, roles,
   labels), taken from the trace.
3. **Check.** The patch is refused before it runs if it would make the
   test pass by checking less (see below).
4. **Verify.** The patch is applied, the test is run twice, and the
   original file is restored. If it still fails, the model sees the new
   error and gets one more try.

`qyntra run` only proposes: verified patches are written to
`qyntra-out/remediation/*.patch` (standard unified diffs — `git apply`
works), shown on the dashboard, and listed in the release decision's
warnings. Your test files change only when you ask:

```bash
npx qyntra repair --apply
```

Failures attributed to the **product** are never repaired. Changing a
test to agree with a bug is the one thing a quality gate must not do.

### What a repair may not do

A repair may change how a test finds things. It may not change whether
the test can fail. A patch is refused if it:

- removes or comments out an assertion, or removes a test
- swaps a value check (`toHaveText`, `toHaveCount`, `toEqual`, …) for a
  presence check (`toBeVisible`, …)
- asserts on an element located by the very text it checks
  (`getByText('Saved')` … `toHaveText('Saved')` can never fail)
- adds `test.skip`, `.fixme`, `.fail`, `.only`, `try`/`.catch()`,
  `expect.soft`, `.not`, `force: true` or `waitForTimeout`
- changes what the test **simulates** — network mocks (`page.route`,
  `route.fulfill`), injected scripts (`page.evaluate`,
  `addInitScript`), cookies, storage or page content. A mocked 500 is
  usually the point of a test ("shows an error banner when the API
  fails"); turning it into a 200 makes a passing test about something
  else.

Constructs your test already used are not held against the patch.
Patches that change an **expected value** are verified like any other,
but marked *review required*: a passing test only proves the new value
is what the app does now, not that it is what the app *should* do.

If Qyntra is interrupted while a patch is on disk, the next run
restores the original file before doing anything else. Repairs per run
are capped by `"remediation": { "maxRepairs": 5 }`; set
`"enabled": false` to switch remediation off.

---

## Learning from releases

A gate that never finds out whether its SAFE was right cannot be
trusted, and cannot get better. After a release, record what happened:

```bash
npx qyntra outcome --commit 4e489eb --result incident --severity High \
  --area checkout --note "Double charge on retry"
npx qyntra outcome --commit 427a4b7 --result ok
npx qyntra outcome --list      # outcomes and the gate's track record
```

`--result` is `ok`, `incident`, `rollback` or `hotfix`. `--date` sets
when it happened (default: now). A later outcome for the same commit
replaces the earlier one, so "ok" on deploy day and an incident found a
week later do not both count.

Outcomes are stored in `.qyntra/release-outcomes.json`. **Commit it.**
It is a small, human-written record that your team and CI should share,
and unlike the run history it is not something a cache eviction should
be able to erase.

Outcomes feed back in two places:

- **Risk.** An incident raises the risk of later runs whose requirement
  or discovered capabilities share a word with its `--area`. A High or
  Critical incident adds 2 points for 30 days and 1 point up to 90; a
  lesser one adds 1 point for 30 days. History adds at most 3 points in
  total, and is reported as its own `[history]` factor — never credited
  to discovery:

  ```
  +2  [history] A High incident in "checkout" followed a release 7 day(s) ago
         └─ commit 4e489ebbed33: Double charge on retry
  ```

  An incident with no `--area` counts against the whole application at
  1 point. An incident in an unrelated area counts for nothing.

- **The gate's confidence in itself.** Outcomes are joined with the
  gate's own past verdicts (by commit, from run history), so the gate
  knows how often its SAFE was wrong:

  ```
  Warnings:
    - In the last 90 days 3 of 4 release(s) this gate called safe later caused an incident, rollback or hotfix:
    - 1ce242f was called SAFE (score 100) and then caused a High incident in todo list.
    - Confidence lowered: 75% of recent SAFE calls were wrong. Add tests for the areas listed above, or raise gate.minQualityScore.
  ```

  With at least 3 judged releases and more than 20% of SAFE calls
  wrong, decision confidence drops a level. The verdict and score do
  not change — the track record is evidence about the gate, not about
  this release.

In CI the gate reads the cached run history, so it measures the CI gate
that actually let those commits ship. An outcome on a commit the gate
never judged still counts towards risk, and is reported separately.

---

## How risk is rated

Risk multiplies the cost of a failure, so it is derived from what
discovery actually observed in your application — payment and credential
surfaces, destructive controls, file uploads, forms, mutation paths, API
endpoints — not from keywords in the requirement string. Wording is a
signal, but a capped one: it contributes at most 3 points and can never
on its own reach `CRITICAL`. "Remove the payment reminder tooltip" on a
read-only docs page is not a critical change, and Qyntra will not say it
is.

Every point is attributed, with the evidence that earned it:

```
Risk Level  : HIGH
Risk Score  : 6/10
Confidence  : High
Derived From: observed application surface

Risk factors
  +3  [discovered] 2 destructive action(s) reachable in the UI (data loss path)
         └─ Delete/remove style controls found in the discovered element set
  +1  [discovered] Application exposes state-changing capabilities
         └─ Create Todo
  +2  [requirement] Requirement wording suggests a business-critical or security-sensitive operation (payment)
```

With no application map — or one from a page that failed to load —
`Confidence` drops and `Derived From` reads `requirement text`. A missing
map is reported, not silently treated as a safe surface.

---

## The release decision

Qyntra does not block a release on any failure. It weighs severity, risk,
defect attribution and each test's own history into a quality score, and
every deduction is itemised so the verdict is auditable:

```
Verdict        : UNSAFE
Quality Score  : 63/100
Confidence     : High
Pass Rate      : 83.3%
Risk           : HIGH (8/10)
Compared to    : 12 previous runs

Failure history:
  - Checkout applies the discount code: first failure in 12 runs — likely a real regression from this change.
  - Dashboard chart renders: failed 4 of 12 runs, flipping repeatedly — known flaky. Needs repair, not a release block.
  - Legacy report export: failed all 12 recent runs — chronic. Fix or quarantine it.

Blocking:
  - 1 high-severity failure(s); gate allows 0.
  - Quality score 63 is below the required 80.
  - 1 failure(s) look like product defects rather than broken tests.
  - 1 test(s) newly failing after passing in every recent run — likely a regression from this change.

Warnings:
  - 2 medium-severity failure(s) did not block the release.
  - 1 failure(s) are on known-flaky tests and were down-weighted. They are maintenance debt, not release blockers.
  - 1 test(s) have failed in every recent run. Fix or quarantine them — while they stay red they tell you nothing about a release.

Score breakdown:
  +100  Baseline
  -14   1 high-severity failure (x1.15 for HIGH risk)
  -2    1 known-flaky test at 40% weight (historically unstable, not evidence about this release)
  -2    1 chronically failing test at 30% weight (historically unstable, not evidence about this release)
  -9    1 test newly failing after passing in every recent run
  -10   1 failure attributed to a likely product defect
```

Written to `qyntra-out/release-decision.json` for your own tooling.

### Was this always broken, or did we break it?

The first question anyone asks a gate. Qyntra keeps the last
`historyRuns` runs in `qyntra-out/run-history.json` and classifies each
failure against that baseline:

| Verdict | Meaning | Effect on the score |
| ------- | ------- | ------------------- |
| `new-regression` | Passed in every recent run, failing now | Extra penalty; blocks by default |
| `known-flaky` | Flips between pass and fail | Counted at 40% weight |
| `chronic` | Red in every recent run | Counted at 30% weight, reported as debt |
| `intermittent` | Has failed before, but is not flapping | Full weight |
| `unknown` | Not enough history to say | Full weight |

Set `"blockOnNewRegression": false` to keep the penalty but stop it
blocking. `"historyRuns"` (3–1000) sets how many runs the baseline spans.

Four deliberate properties:

- **A run with zero tests can never pass.** Absence of evidence is not
  evidence of quality, and it is the most dangerous way for a gate to
  produce a false pass.
- **Degraded analysis lowers `Confidence`, it does not fake a pass.**
  "We could not analyse these failures" is a different statement from
  "these failures are benign".
- **No history is never a discount.** A failure Qyntra cannot classify is
  scored at full weight, and the missing baseline is reported as a
  limitation of the verdict rather than passed over.
- **Flakiness cannot wave a product defect through.** Down-weighting
  applies to the severity arithmetic only; a failure attributed to a
  product defect still blocks at full force however unstable its test is.

The verdict is also idempotent: re-running `qyntra gate` on the same
results compares against the same baseline and reaches the same verdict,
so a CI retry cannot flip a release decision.

---

## CI integration

```yaml
name: Qyntra
on: [pull_request]

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci
      - run: npx playwright install --with-deps chromium

      # Required for flakiness detection. Without it the history file
      # dies with the workspace and every failure looks brand new.
      - uses: actions/cache@v4
        with:
          path: qyntra-out/run-history.json
          key: qyntra-history-${{ github.ref_name }}-${{ github.run_id }}
          restore-keys: |
            qyntra-history-${{ github.ref_name }}-
            qyntra-history-

      - run: npx qyntra run
        env:
          QYNTRA_APP_USER: ${{ secrets.QYNTRA_APP_USER }}
          QYNTRA_APP_PASSWORD: ${{ secrets.QYNTRA_APP_PASSWORD }}
          # Hosted runners have no Ollama: use Gemini's free tier in CI
          # when the secret exists, the deterministic analyzer otherwise.
          QYNTRA_AI_PROVIDER: ${{ secrets.GEMINI_API_KEY != '' && 'gemini' || 'none' }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: qyntra-report
          path: qyntra-out/
```

Qyntra exits non-zero when the release is blocked, so it works directly
as a required status check. In GitHub Actions it also writes the verdict,
blocking reasons, warnings and score breakdown to the job summary, so
reviewers see *why* without downloading the report.

`QYNTRA_AI_PROVIDER` and `QYNTRA_AI_MODEL` override the config's `ai`
block per environment — typically Ollama on developer machines and
Gemini or OpenAI in CI. Switching provider this way also resets the
model, key and endpoint to the new provider's defaults.

The cache step is not optional if you want the flakiness half of the
gate. `qyntra-out/` is ephemeral in CI, so without it Qyntra starts from
an empty baseline on every run, classifies every failure as `unknown`,
and can never tell a new regression from a test that has been red for a
month. `qyntra doctor` reports how many runs are stored — if it says zero
on the second CI run, the cache is not wired up. The key is unique per
run so the cache is always written; `restore-keys` pulls the most recent
previous copy.

### Exit codes

Stable across releases — branch on them in CI.

| Code | Meaning |
| ---- | ------- |
| `0`  | Success |
| `1`  | Release blocked by the quality gate |
| `2`  | Configuration error (nothing executed) |
| `3`  | Required artifact missing |
| `4`  | Application unreachable |
| `5`  | Login to the application failed |
| `70` | Internal error (a Qyntra bug) |

A broken pipeline never looks like a clean "unsafe" verdict.

---

## Commands

| Command | Purpose |
| ------- | ------- |
| `qyntra init` | Scaffold `.qyntra/config.json` |
| `qyntra doctor` | Validate config, credentials, reachability |
| `qyntra login` | Log in via `app.auth`, confirm it worked, save the session |
| `qyntra run` | Full pipeline, ending in a release decision |
| `qyntra gate` | Release decision from existing artifacts |
| `qyntra repair [--apply]` | Propose and verify fixes for broken tests; `--apply` writes them |
| `qyntra outcome ...` | Record what happened after a release; `--list` shows the track record |

`gate` is separate from `run` so you can compute the verdict in a later
CI job — commonly a required status check after the test job.

### Logging

`QYNTRA_LOG_LEVEL` (`debug`/`info`/`warn`/`error`) and
`QYNTRA_LOG_FORMAT=json` for one JSON object per line, for shipping
Qyntra output into your own observability stack. Values that look like
credentials are redacted from log lines.

---

## What leaves your environment

Nothing, except calls to your configured LLM provider. With
`"ai": { "provider": "ollama" }` the model runs on your own machine, and
with `"provider": "none"` Qyntra uses its deterministic analyzer; either
way Qyntra makes no external AI calls at all.

When an LLM provider is configured, each failure analysis sends: the test
name, the error and stack trace, the failing test's source, the
discovered application map (selectors, headings, endpoint paths), and the
browser evidence described in [How failures are diagnosed](#how-failures-are-diagnosed):
the test's steps, a page accessibility snapshot, console errors, uncaught
page errors and failed request URLs. Request URLs are reduced to origin
and path — query strings and fragments are dropped — and values that look
like credentials are masked. It does not send your application source
code, request or response bodies, cookies, or the video.

The failure screenshot is also sent, as an image, to providers that
accept one. Screenshots can show whatever was on screen, including
customer data in a staging environment; set
`"ai": { "includeScreenshots": false }` to keep them local.

Run history stays local: it is a file in your output directory, held in
your own CI cache. Qyntra has nowhere to send it.

---

## Current limitations

Stated plainly, because you will find them anyway:

- **UI tests only.** Discovery records API endpoints, but generated tests
  drive the browser. API, performance and LLM-feature testing are not
  implemented.
- **The codebase is not an input.** Discovery is black-box. Risk is
  derived from the application surface, not from your diff.
- **Repair needs an AI provider and fixes test defects only.** Without
  one, failures are still diagnosed but no patches are proposed. Repair
  quality depends on the model: a local 7B model reliably fixes broken
  locators but often finds no *safe* fix for a wrong expected value — it
  reports that rather than producing a weaker test. Gemini fixed both
  kinds in testing.
- **Run history is a cached file, not a database.** It lives in your CI
  cache, is bounded to `historyRuns`, and keys on test title — renaming a
  test resets its baseline. Evicting the cache costs you flakiness
  detection until enough runs accumulate again.
- **Form login only.** Single-page and two-step username/password forms
  work, including hosted login pages you are redirected to. MFA/OTP,
  CAPTCHA, SSO buttons ("Sign in with Google") and API-token auth are not
  supported.
- **Single browser.** Chromium.
