# Qyntra — the AI Quality Engineer that decides if a release is safe

## The problem

Every team shipping software asks one question before each release:
**"Is this safe to ship?"** Today the answer is a wall of test results
that a person has to interpret.

- **Test suites lie.** Flaky tests train teams to ignore red builds, so
  real bugs get through alongside the noise.
- **Failures take hours to triage.** Someone opens the trace, decides
  whether the test broke or the product did, and fixes the selector —
  again.
- **Coverage lags the product.** Writing and maintaining end-to-end
  tests is the job nobody has time for.
- **AI testing tools want your app in their cloud.** Many companies
  cannot send source, screenshots or customer data to a vendor.

## What Qyntra does

Point it at an application and a few plain-English requirements. In the
team's own CI, Qyntra:

1. **Discovers** the app — pages, flows, APIs, login — and rates risk.
2. **Generates and runs** Playwright UI and API tests for what matters.
3. **Diagnoses every failure** from traces, screenshots and the DOM:
   broken test or real product defect, and why.
4. **Repairs broken tests** — patches, re-runs twice, keeps the fix only
   if it passes.
5. **Decides**: `SAFE`, `SAFE_WITH_RISK` or `UNSAFE`, with the reasons
   and a quality score, as a required check on the pull request.
6. **Learns** from what happened after each release, so it trusts itself
   less when it has been wrong.

## Why Qyntra wins

| | Qyntra | Typical AI testing tool |
| --- | --- | --- |
| Where tests run | Your CI | Their cloud |
| Your code and data | Never leave your environment | Uploaded |
| Output | An auditable release decision | Test results |
| Repairs | Verified by re-running, guarded against cheating | Suggested, or applied blind |
| Measures its own accuracy | Yes — escape rate, false-alarm rate | No |
| AI | Your choice, including free and fully local | Theirs |

The privacy model opens doors closed to competitors: fintech, health,
and any company whose security team says no to uploading their app.

## Business model

**Open-source CLI, paid cloud.** The CLI that runs in CI is free and
builds trust and adoption. Qyntra Cloud adds what a single CI run
cannot: permanent history, automatic release-outcome tracking, a view
across every repo, GitHub and Slack workflow, and enterprise controls.

| Plan | Price |
| --- | --- |
| Team | $49 per project / month |
| Business | $299 / month + $29 per project |
| Enterprise | Annual contract — SSO, audit, SLA |

## Market

Software testing is a market worth tens of billions of dollars a year,
and most of it is still people's time. Playwright is now the default
for new end-to-end suites, and AI-assisted testing is the fastest-moving
part of the category. Qyntra's buyers are engineering and QA leaders at
companies with 20–500 engineers that ship weekly or faster.

## Where we are

- **Built:** the full pipeline above, working end to end as an
  installable package — UI and API test generation, OpenAPI input,
  login handling, failure diagnosis from browser evidence, verified
  repair, release decisions, performance regression tracking, change
  risk from the git diff, and testing of AI features inside the product.
- **Qyntra Cloud, built:** sign-up, teams and roles, projects and CI
  tokens, dashboards (runs, flaky tests, release track record, feature
  reports), Stripe billing, Slack alerts, pull request comments,
  automatic release outcomes from git, audit log, export and deletion.
  One process and one database file; deploys to a $5 server.
- **Behaviour checks that catch real bugs:** on a benchmark app with
  planted defects, Qyntra caught every one (search, filter, validation)
  with no false alarm — without any AI.
- **Verified:** 395 automated tests; the full loop — CLI finds a bug,
  uploads, dashboard shows it — runs end to end.
- **Not yet:** real customers, a public deployment and a domain.
  Design-partner pilots start now.

## Next 6 months

1. **Months 0–2:** 3–5 design-partner pilots on real applications,
   measuring decision accuracy.
2. **Months 2–4:** Qyntra Cloud live for pilots; pricing tested with them.
3. **Months 4–6:** first paying customers; public open-source launch.

## The ask

**Design partners:** teams with a staging environment and a CI
pipeline, willing to run Qyntra for 4 weeks and tell us honestly what
it got wrong. Free, about an hour of setup, and direct influence on the
product.

---

**Contact:** [name] · [email] · [link]
