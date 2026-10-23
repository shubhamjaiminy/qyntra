# Developing Qyntra

For the engineer who maintains Qyntra. The README is for people who
*use* it. This guide is for changing it safely.

## Set up

```bash
npm ci
npx playwright install chromium
npm run typecheck        # whole repo: CLI, Cloud, demo, tests
npm run test:unit        # ~430 tests, about 40 seconds, no network or AI
npm run build            # dist/, what customers install
npm run cloud:build      # dist-cloud/, what Qyntra Cloud runs
```

CI (`.github/workflows/qa.yml`) runs all of these on every push and
pull request, then runs Qyntra on itself. Keep it green: a red main
branch means nobody can tell whether their change broke something.

Useful while working:

| Command | What it is for |
| --- | --- |
| `npm run qyntra -- <command>` | The CLI from source, no build needed |
| `npm run demo:live` and `npm run demo:check` | A shop with switchable bugs, and Qyntra Cloud ([DEMO.md](DEMO.md)) |
| `npm run demo:benchmark` | Every shop bug mode through the real CLI, scored |
| `npm run demo:pilot`, `npm run demo:ai` | A pilot week; the AI-assistant check |
| `QYNTRA_HEADED=1` | Show the browser during login and feature exploration |
| `QYNTRA_LOG_LEVEL=debug` | Everything Qyntra decides, and why |

## How it fits together

Two products share one repository:

- **The CLI** (`scripts/`): runs in the customer's CI and is published as the `qyntra` package
- **Qyntra Cloud** (`cloud/`): one Node process and one SQLite file. Receives summaries from the CLI ([saas/ARCHITECTURE.md](saas/ARCHITECTURE.md))

### `qyntra run`: the release-gate pipeline

`scripts/cli.ts` runs each stage as its own process, in order, and the
stages talk through JSON files in `qyntra-out/`:

```
application-discovery → risk-analyzer → scenario-mapper → test-generator
  → api-test-generator → llm-test-generator → performance
  → Playwright → analyze-failures → ai-analyzer → repair → gate
```

| Layer | Where |
| --- | --- |
| Config, credentials, validation | `lib/config.ts`, `lib/auth.ts`, `lib/login-discovery.ts` |
| What the app is (discovery, API traffic, OpenAPI) | `application-discovery.ts`, `lib/api-observation.ts`, `lib/openapi*.ts` |
| What could go wrong (risk, change) | `lib/risk-intelligence.ts`, `lib/change-intelligence.ts` |
| Tests | `test-generator.ts`, `lib/api-tests.ts`, `lib/api-mutations.ts`, `lib/llm-tests.ts` |
| Why it failed | `analyze-failures.ts`, `lib/failure-evidence.ts`, `lib/attribution.ts`, `ai-analyzer.ts` |
| Fixing broken tests | `repair.ts`, `lib/remediation.ts` |
| The decision | `lib/release-intelligence.ts`, `lib/run-history.ts`, `lib/release-outcomes.ts`, `lib/performance.ts` |
| Output | `generate-dashboard.ts`, `lib/dashboard-sections.ts`, `lib/github.ts`, `lib/cloud-upload.ts` |

### `qyntra feature` and `qyntra app`: checking one feature

`lib/feature-run.ts` runs these steps in order:
1. Explore (`lib/feature-explorer.ts`, inside `lib/read-only-guard.ts`).
2. Behaviour probes (`lib/feature-probes.ts`).
3. Optional AI steps (`lib/feature-ai.ts`, `lib/feature-tests.ts`).
4. Report and verdict (`lib/feature-report.ts`).

`lib/app-run.ts` does the same for every feature in the menu.

### AI

`scripts/ai/` has one provider per model service, behind the interface
in `provider.ts`, and the prompts every provider shares. Every AI step
is optional: with no provider, or one that fails, Qyntra falls back to
deterministic code and lowers its confidence. It never fails the run
because of the AI.

## Rules that keep Qyntra trustworthy

These come from mistakes that were made and fixed. Break one and a
customer gets a wrong answer.

1. **Every real-site mistake becomes a benchmark page.** When Qyntra
   gets a real site wrong, rebuild the page's *structure* (never its
   data) in `tests/fixtures/real-world/pages.ts`, with the right answer.
   `tests/unit/real-world-benchmark.spec.ts` then fails if the mistake
   ever comes back. Write the benchmark page before the fix, and watch
   it fail.
2. **A finding must survive its own self-check.** List probes run inside
   `witnessed()`. If the elements a probe watches didn't change but the
   list around them did, the probe withdraws its finding. Don't remove
   this to make a probe "find more".
3. **Oracles are code, not AI.** A probe's pass/fail rule is written by
   Qyntra's code, so a model can't weaken it. AI opinions are labelled
   "verify before acting", and can never make a feature *not ready* on
   their own.
4. **Read-only by default, enforced at the network.** Exploration and
   generated tests run behind `read-only-guard.ts`. Any new code that
   drives a customer's app must too.
5. **Not knowing is not passing.** A run with zero tests can't be SAFE.
   A network failure is *not run*, never *failed*. A missing baseline
   is reported, never treated as a discount.
6. **Nothing leaves the customer's environment unannounced.** Anything
   new sent to an AI provider or to Qyntra Cloud must be added to *What
   leaves your environment* in the README, and must respect the upload
   levels.
7. **Exit codes are a contract** (`lib/exit-codes.ts`). Customers branch
   on them in CI.

## Adding a behaviour probe

1. Add a benchmark page in `tests/fixtures/real-world/pages.ts`, once
   working and once broken, with the right answers. Run
   `npx playwright test -c playwright.unit.config.ts real-world`. The
   broken page fails, because nothing catches it yet.
2. In `lib/feature-probes.ts`, detect the control: look for roles,
   labels and options, not site-specific class names. Generated class
   names (anything with a digit, like `jss274`) never go into a
   selector.
3. Emit the test with `witnessed(rows, [...])` for anything that watches
   a list. Generated test code is source text: never embed a compiled
   function (tsx inserts `__name` helpers), and never use `new Function`
   inside the page (a strict Content-Security-Policy refuses it).
4. Unit tests in `tests/unit/feature-probes.spec.ts`: the probe is found,
   it passes on the working page, and it fails on the broken one with a
   message a person understands.
5. Try it on a real site: `QYNTRA_HEADED=1 npm run qyntra -- feature
   "<name>" --path <path> --no-ai`. Then confirm any finding by hand
   before believing it.

## Releasing

1. CI must be green on `main`.
2. Bump the version in `package.json`. The pilot report and uploads
   carry it.
3. `npm run build && npm pack`. Install the `.tgz` in a fresh project
   and run `init`, `doctor` and `run` against the demo shop. That's
   what a customer does first.
4. Cloud: `npm run cloud:build`, then deploy as in [saas/DEPLOY.md](saas/DEPLOY.md).
   Database migrations run on start and only ever add.
