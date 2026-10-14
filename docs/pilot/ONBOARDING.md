# Qyntra design-partner pilot

Thank you for trying Qyntra on a real application. This page is
everything your team needs: what the pilot is, what it costs you, and
how to set it up in about an hour.

## What you get

- Generated Playwright tests for the flows you name, run in your CI.
- For every failure: a diagnosis that separates a broken test from a real
  product defect, with the evidence behind it.
- Verified repairs for broken tests — patched, re-run twice, kept only
  if they pass.
- A release decision on every pull request: `SAFE`, `SAFE_WITH_RISK` or
  `UNSAFE`, with the reasons.
- Free for the length of the pilot, and a direct line to the person
  building it.

## What we ask

| | |
| --- | --- |
| **Length** | 4 weeks |
| **Setup** | About 1 hour, once |
| **Each release** | One command, 10 seconds: record what happened |
| **Each week** | A 15-minute review: confirm what Qyntra caught ([scorecard](SCORECARD.md)) |
| **End of pilot** | A 30-minute call and the [feedback form](FEEDBACK.md) |

The pilot measures one number each week: **real bugs Qyntra caught,
and false alarms it kept from blocking you**, as confirmed by your team.
Over the four weeks it also measures whether its release decisions were
right, which needs you to record what happened after each release. Those
two habits matter more than anything else here.

## Your data

Qyntra runs inside your repository and your CI. It has no servers and
sends us nothing. The only external calls are to the AI provider *you*
configure — and with Ollama or `"provider": "none"` there are none at
all. The README's *What leaves your environment* section lists exactly
what an AI provider receives.

The weekly pilot report is generated on your side and holds counts and
rates only: no test names, URLs, commit hashes, branch names, notes or
application details. Read it before sending — it is a short Markdown
file.

## Setup

**Requirements:** Node.js 20+, a staging environment Qyntra can reach,
and a test account if the app needs a login. Use staging, never
production: generated tests create data.

### 1. Install

We will send you a package file until Qyntra is on npm:

```bash
npm install --save-dev ./qyntra-0.1.0.tgz @playwright/test
npx playwright install chromium
```

### 2. Configure

```bash
npx qyntra init
```

Edit `.qyntra/config.json`:

- `app.baseUrl` — your staging URL.
- `requirements` — 3 to 5 flows that matter most, in plain English:
  `"User can complete a payment"`, `"Admin can invite a team member"`.
  Start with the flows that would hurt most if they broke.
- `app.auth` — if the app needs a login. Credentials are read from
  environment variables, never from this file.
- `discovery.excludePaths` — anything Qyntra must not click: logout,
  billing, delete-account, admin danger zones.
- `execution.include` — your existing Playwright suites, e.g.
  `["tests/e2e"]`, so Qyntra gates, diagnoses and repairs the tests you
  already have.
- `"gate": { "historyRuns": 1000 }` — keeps the whole pilot's runs.
  The default of 50 can be less than a week on a busy repository, and
  the weekly count needs every run of the week.

### 3. Check

```bash
export QYNTRA_APP_USER="qa-bot@yourcompany.example"
export QYNTRA_APP_PASSWORD="..."

npx qyntra doctor    # config, credentials, AI provider, reachability
npx qyntra login     # only if app.auth is set: proves the login works
npx qyntra run       # first full run, locally
```

Open `qyntra-out/index.html` to see the report. If anything looks wrong,
send us the console output — that is exactly the feedback we need.

### 4. Add to CI

Copy the GitHub Actions workflow from the README's *CI integration*
section and add one step before the artifact upload:

```yaml
      - run: npx qyntra pilot-report
        if: always()
```

The run-history cache step in that workflow is required: without it,
Qyntra cannot tell a new regression from a test that has always been
flaky.

**For the first two weeks, do not make Qyntra a required check.** Let it
run alongside your normal process so its decisions can be compared with
what actually happened, without it blocking anyone.

## Every release: record what happened

After a release has been live for a day or so:

```bash
npx qyntra outcome --commit <sha> --result ok
npx qyntra outcome --commit <sha> --result incident --severity High --area checkout
```

`--result` is one of `ok`, `incident`, `rollback`, `hotfix`. Commit
`.qyntra/release-outcomes.json` so CI sees it. This is how Qyntra learns
whether its `SAFE` calls were safe, and how the pilot is judged.

## Every week: confirm what Qyntra caught

Download the `qyntra-report` artifact from the latest CI run on your
main branch. It has two pilot files:

- **`pilot-report.md`** holds counts and rates only, including bugs
  caught and false alarms avoided for each week. Read it, then send it
  to us.
- **`pilot-review.md`** names the tests behind those counts. **Keep it.**
  Tick each line that was right, and send us only the confirmed counts.

The [weekly scorecard](SCORECARD.md) is the form for this, about five
minutes, followed by a 15-minute call. You can also run it locally:

```bash
npx qyntra pilot-report
```

Run it in CI where possible: the run history that matters is the one in
CI's cache, not your laptop's.

## When something goes wrong

| Exit code | Meaning | What to do |
| --- | --- | --- |
| `1` | Release blocked | Read the reasons in the job summary — is it right? Tell us either way |
| `2` | Configuration error | The message says which field; `npx qyntra doctor` |
| `4` | Application unreachable | Staging down, or CI cannot reach it |
| `5` | Login failed | `npx qyntra login`; see `.qyntra/.auth/login-failure.png` |
| `70` | A Qyntra bug | Send us the full log — this is on us |

A wrong decision is the most useful thing you can report. When Qyntra
says `UNSAFE` and you disagree, or says `SAFE` and something breaks,
tell us the same day if you can.

## Ending the pilot

Remove the CI step and `npm uninstall qyntra`. Delete `.qyntra/` and
`qyntra-out/` if you do not want to keep the generated tests and
history. Nothing exists anywhere else to delete.
