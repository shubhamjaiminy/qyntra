# Qyntra Cloud — hosted layer design

Status: built, 2026-10-12 — `cloud/` (server, dashboard, API, billing,
alerts) and the CLI side (`scripts/lib/cloud-client.ts`, `github.ts`).
Deviations from this design, chosen for a one-person team: SQLite via
Node's built-in `node:sqlite` instead of Postgres, and server-rendered
HTML with no JavaScript instead of Next.js — zero runtime dependencies,
one process, one file to back up. PR comments come from the CLI with the
job's `GITHUB_TOKEN` instead of a GitHub App. Deployment: `docs/saas/DEPLOY.md`.

## 1. The principle

**Tests run in the customer's CI. The hosted layer only ever sees
results.**

Qyntra's differentiator is that customer code, application data and
browser evidence never leave their environment. Most competitors run
the customer's tests on their own infrastructure. The hosted layer must
not give that up, so it is split in two:

| | Data plane (customer's CI) | Control plane (Qyntra Cloud) |
| --- | --- | --- |
| Runs | Discovery, generation, Playwright, diagnosis, repair, gate | Storage, dashboard, integrations, billing |
| Sees | Everything: source, DOM, screenshots, traces | Run summaries the customer chose to upload |
| Code | Today's `qyntra` CLI, unchanged | New |
| Works offline | Yes, always | — |

The CLI keeps working with no account. The cloud is additive: if it is
unreachable, a run still finishes, the gate still decides, and the exit
code is unchanged. **An upload failure never changes a release
decision.**

## 2. What the cloud adds (what customers pay for)

Each of these is something the CLI cannot do alone, because it needs
state across runs, repos or people:

1. **History that survives CI.** Today run history lives in a CI cache
   that expires and is per-branch. The cloud keeps every run, forever,
   across branches — so flakiness and trends are real.
2. **Automatic release outcomes.** Today a person must run
   `qyntra outcome` after each release; in practice nobody will. The
   cloud learns outcomes from GitHub deployments, reverts, hotfix
   branches, and incident tools (PagerDuty, Opsgenie, Sentry release
   health). This turns "was SAFE actually safe?" from a chore into a
   number on the dashboard — the product's core proof.
3. **One view across repos and teams.** Quality score, escape rate and
   flaky-test debt per service, for the engineering manager who buys.
4. **Workflow.** PR comments and check runs with the verdict; Slack
   alerts on `UNSAFE`; approve or reject a proposed repair from the
   browser; override a block with a recorded reason (an audit trail).
5. **Enterprise controls.** SSO, roles, audit log, data retention,
   region choice.
6. **Managed AI (optional).** Customers without their own key or GPU
   use Qyntra's. This is the one feature that sends failure evidence to
   us, so it is opt-in per project and documented separately.

## 3. What gets uploaded

Upload is opt-in per project, with three levels. The level is set in
`.qyntra/config.json` so it is reviewed in code review, not hidden in
a dashboard toggle.

```json
"cloud": { "project": "acme-billing", "upload": "standard" }
```

| Level | Contains | Never contains |
| --- | --- | --- |
| `metrics` | The pilot report's counts, verdict, score, confidence, durations | Any names or text |
| `standard` (default) | + commit SHA, branch, PR number, test names and per-test status, blocking reasons and warnings, failure category and severity | Source, DOM, screenshots, traces, URLs beyond origin, error messages, AI root-cause text |
| `full` | + error messages, AI diagnosis text, proposed repair diffs | Source files, screenshots, traces, video, cookies |

`metrics` exists for regulated customers; it is what
`qyntra pilot-report` already produces, so it is proven. `standard` is
what the dashboard needs to be useful (you cannot show "the 3 flakiest
tests" without names). `full` enables repair approval in the browser.

The CLI applies the level **before** sending, and the same redaction
already used for logs (`lib/logger.ts` `redact`) runs over every string.
`qyntra upload --dry-run` prints exactly what would be sent.

## 4. Components

```
Customer CI                                Qyntra Cloud
───────────                                ────────────
qyntra run ──► qyntra-out/*.json
            └─► uploader ── HTTPS ──►  Ingest API ──► Postgres
                 (QYNTRA_TOKEN)             │            ▲
                                            ▼            │
                                       Job queue ──► Workers
                                                    ├─ GitHub App (checks, PR comments)
                                                    ├─ Slack
                                                    ├─ Outcome detectors
                                                    └─ Managed AI proxy (opt-in)

Browser ──► Web app (dashboard, settings, billing) ──► Postgres
```

### 4.1 CLI uploader (in this repo)

- New stage at the end of `qyntra run` and `qyntra gate`, plus
  `qyntra upload` to send existing artifacts and `--dry-run`.
- Enabled only when `cloud.project` is configured **and**
  `QYNTRA_TOKEN` is set. Either missing: silent no-op.
- Payload: one JSON document per run, built from
  `release-decision.json`, the latest `run-history.json` entry,
  `failures.json`, `ai-analysis.json` and `remediation.json`, filtered
  to the upload level. Versioned schema (`payloadVersion`).
- 10-second timeout, two retries, then a warning. Never a non-zero
  exit.
- `qyntra doctor` gains a check: token valid, project exists, level
  shown.
- History can be **read back** from the cloud at the start of a run
  (`cloud.history: true`), replacing the CI-cache step in the README —
  the biggest setup pain today.

### 4.2 Ingest API

- `POST /v1/runs` — idempotent on `(project, runId)`, so CI retries are
  safe. Validates the schema, rejects fields above the project's
  configured upload level (defence in depth: the server enforces the
  level too).
- `GET /v1/projects/:id/history?branch=` — for `cloud.history`.
- `POST /v1/outcomes` — what `qyntra outcome` calls when the cloud is
  configured.
- Auth: project tokens (`qy_live_…`), stored hashed, scoped to one
  project, write-only by default. Revocable in the dashboard.

### 4.3 Web app

Pages, in build order:

1. **Project overview** — latest verdict per branch, quality-score
   trend, escape rate, false-alarm rate.
2. **Run detail** — the release decision as the CLI shows it, plus the
   per-test table.
3. **Tests** — flakiest and chronic tests, with history; the
   maintenance debt view.
4. **Track record** — every release, the verdict it got, and what
   happened. The page that sells the product.
5. **Org overview** — all projects, for managers.
6. **Settings** — members, tokens, integrations, billing, upload level.

### 4.4 Integrations

| Integration | Purpose | When |
| --- | --- | --- |
| GitHub App | Sign-in, check runs, PR comment with verdict, deployments + reverts as outcomes | MVP |
| Slack | Alert on `UNSAFE` on main and on escapes | Phase 2 |
| Sentry / PagerDuty / Opsgenie | Incidents after a release → `incident` outcome | Phase 2 |
| Jira / Linear | Requirements in; product defects out as tickets | Phase 3 |
| GitLab | Same as GitHub | Phase 3, on demand |

### 4.5 Outcome detection (the moat)

A release outcome is inferred, then shown for a human to confirm or
correct with one click:

| Signal | Inferred outcome |
| --- | --- |
| Deployment succeeded, no incident or revert for 72 h | `ok` |
| Revert commit of the release commit | `rollback` |
| `hotfix/*` branch merged within 72 h | `hotfix` |
| Incident opened in a linked tool within 72 h, same service | `incident` (severity mapped) |

Every confirmed outcome sharpens the gate's calibration — and the
cross-customer, anonymized escape-rate data becomes something no new
competitor has.

## 5. Data model

Postgres, every table carries `org_id`, with row-level security on
`org_id` so a missed `WHERE` in application code cannot leak across
tenants.

```
orgs            id, name, plan, stripe_customer_id, region, created_at
users           id, email, name, auth_provider
memberships     org_id, user_id, role (owner | admin | member | viewer)
projects        id, org_id, name, repo, upload_level, retention_days
tokens          id, project_id, hash, scopes, last_used_at, revoked_at
runs            id, project_id, run_id, commit, branch, pr, verdict,
                quality_score, confidence, total, passed, failed,
                skipped, risk_level, ai_provider, payload_version,
                started_at, payload jsonb
run_tests       run_id, test_name, status, category, severity,
                product_defect, test_defect
outcomes        id, project_id, commit, result, severity, area, source
                (cli | github | sentry | …), confirmed_by, occurred_at
repairs         id, run_id, test_name, status, diff (full level only),
                decision (pending | approved | rejected), decided_by
audit_log       id, org_id, actor, action, target, at
```

`runs.payload` keeps the raw upload so new dashboard features can be
backfilled without asking customers to re-run anything.

## 6. Stack

Chosen for one developer, low cost, and the language already in use:

| Concern | Choice | Why |
| --- | --- | --- |
| Language | TypeScript everywhere | Shares types with the CLI (`RunHistoryEntry`, `ReleaseDecision`) |
| Web + API | Next.js on Vercel | One deploy for dashboard and API; free tier to start |
| Database | Postgres on Neon or Supabase | Row-level security; free tier; branches for previews |
| Queue | Postgres-backed (pg-boss) | No extra service until volume demands one |
| Auth | GitHub OAuth first; WorkOS for SSO/SAML later | Buyers are on GitHub; SSO is an enterprise-tier upsell |
| Billing | Stripe | Standard |
| Email | Resend | Free tier |
| Errors | Sentry | Free tier |

Running cost until the first paying customers: about $0–50/month.

Shared types: extract the artifact interfaces from `scripts/lib` into a
`@qyntra/schema` package used by both the CLI and the cloud, so the
upload format cannot drift.

## 7. Security

- Tokens hashed (SHA-256), shown once, scoped per project.
- Server-side enforcement of the upload level, not only client-side.
- Row-level security on every tenant table.
- Encryption at rest (provider default) and TLS only.
- Retention per project (default 13 months; `metrics` data kept
  indefinitely as it holds nothing sensitive).
- Audit log for membership, tokens, upload level, overrides, repair
  approvals.
- Export and delete-all per org, self-serve.
- SOC 2 Type I when the first enterprise deal requires it (Vanta or
  Drata); the choices above are made so that is paperwork, not a
  rewrite.

## 8. Pricing (hypothesis, to test in pilots)

| Plan | Price | For |
| --- | --- | --- |
| **Open source CLI** | Free forever | Everything that runs in CI today |
| **Team** | $49 per project / month | Cloud history, dashboard, GitHub App, Slack, outcome detection, 5 users |
| **Business** | $299 / month + $29 per project | Unlimited users, org view, incident integrations, repair approval, managed AI quota |
| **Enterprise** | Annual contract | SSO/SAML, audit export, retention control, region, SLA, SOC 2 report |

Priced per project, not per test run, so teams are never punished for
running Qyntra more. The pilot feedback form's pricing question is how
these numbers get replaced with real ones.

## 9. Build plan

Each phase ends with something a pilot partner uses.

| Phase | Scope | Rough effort (solo) |
| --- | --- | --- |
| **0. Schema** | `@qyntra/schema` package; upload payload + levels; `qyntra upload --dry-run` | 1 week |
| **1. MVP** | Ingest API, GitHub sign-in, one org/project, overview + run detail + tests pages, tokens, `cloud.history` | 4–6 weeks |
| **2. GitHub App** | Check runs, PR comments, deployment/revert outcome detection, track-record page | 3 weeks |
| **3. Paid** | Stripe, plans, limits, Slack, member roles | 2–3 weeks |
| **4. Incidents** | Sentry/PagerDuty outcome detection, repair approval in browser | 3 weeks |
| **5. Enterprise** | SSO, audit export, retention, managed AI, SOC 2 | When a deal requires it |

Start phase 1 only when at least two pilot partners are running the CLI
in CI: the dashboard should be designed around their real data, not the
TodoMVC demo.

## 10. Open questions

1. **License for the CLI.** Recommended: open source (Apache-2.0 or
   MIT) to earn trust and adoption; the cloud is the business. The
   alternative — source-available (e.g. BSL) — protects against a
   competitor hosting it, at some cost to adoption.
2. **Managed AI provider and margin.** Which model, and whether its cost
   is bundled or metered.
3. **Self-hosted control plane** for customers who will not use any
   SaaS (banks, defence). Probably Enterprise-only, later.
4. **Company and legal entity**, terms of service, DPA — needed before
   the first invoice.
