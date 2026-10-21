# The first buyer

One buyer, described precisely enough that you can tell in two minutes
whether a person is worth contacting. Everyone in the first 5–10 pilots
should match it. A pilot with someone who doesn't match teaches you
little, even when it goes well.

## Who

**An engineering manager, QA lead, SDET lead or staff engineer at a
SaaS or fintech company with 20–200 engineers, whose team already
writes Playwright tests and whose CI goes red for reasons nobody
trusts.**

| | Must have | Why |
| --- | --- | --- |
| **Company** | B2B SaaS or fintech startup or scale-up (seed to Series C), 20–200 engineers | Big enough to feel release risk. Small enough that one person can say yes without procurement |
| **Stack** | A web app with **Playwright** end-to-end tests already in the repo | Qyntra gates, diagnoses and repairs *their* suite on day one. No migration to sell |
| **CI** | GitHub Actions, running on pull requests | What the action and docs cover. Setup takes an hour, not a week |
| **Environment** | A staging or preview URL that CI can reach | Without one there is nothing to test |
| **Cadence** | Ships at least weekly | Four weeks gives enough releases to judge the gate |
| **Pain** | Flaky end-to-end tests: retries, `test.fixme`, "just re-run it", a red build ignored | This is the problem Qyntra fixes first. No pain, no pilot |
| **Person** | Owns test quality or release sign-off, and can install a dev dependency | The person who suffers is also the person who can act |

**Fintech means startups and scale-ups**, such as payments, lending,
expense, payroll or crypto infrastructure companies with a modern web
stack. It does not mean banks or insurers. They need a security review
before trying any tool, which comes later, after SOC 2 and a track record.

### Signals worth looking for

Any two of these make a strong lead:

- A job posting for an **SDET, QA automation engineer or "quality
  engineer" mentioning Playwright**. They are hiring people to do what
  Qyntra does.
- A public repo or engineering blog with `playwright.config.ts`,
  `retries`, `test.fixme`, `test.skip`, or issues labelled `flaky`.
- A post or talk by someone at the company about flaky tests, test
  maintenance or release confidence.
- A changelog showing releases several times a week.
- A recent incident or status-page entry about a regression.
- An AI feature (assistant, chatbot, copilot) in their product. This is
  the opening for the second offer.

### Not now

- **No end-to-end tests at all.** Qyntra can generate tests, but these
  teams first need convincing that end-to-end testing is worth doing.
  That makes the sale slower.
- **Cypress or Selenium only.** Qyntra runs Playwright. A migration is a
  second project.
- **Banks, insurers, healthcare enterprises, government.** Procurement
  and security review come before any trial.
- **Agencies and consultancies.** Every client's app is different and
  the pain isn't theirs to fix.
- **Under 10 engineers.** Usually there's no dedicated test owner and no
  budget line.
- **Mobile-only or desktop apps.** Qyntra tests the web, in Chromium.

## What they say, and what Qyntra answers

Use their words in messages and on calls. Swap these phrases for the
real ones you hear.

| They say | Qyntra's answer |
| --- | --- |
| "We just re-run CI until it's green." | Every failure is classified as new regression, known flaky or chronic, so a re-run is no longer the strategy. Flaky tests are down-weighted, and real regressions still block. |
| "Half my week is fixing selectors." | Broken tests are repaired with locators taken from the real page, and each fix is kept only if it passes twice. A fix can't make a test pass by checking less. |
| "I can't tell if it's the test or the app." | The diagnosis reads the trace: a 500 or page crash means the product, even when the symptom is a timeout. |
| "Nobody owns the go/no-go." | Every PR gets SAFE / SAFE_WITH_RISK / UNSAFE, with each point of the score explained. |
| "Security won't let us send code to an AI vendor." | It runs in your CI. Code, screenshots and traces stay there. The AI can be fully local (Ollama). |
| "We tried an AI testing tool, it was a black box." | Every decision is itemised and auditable, and the gate reports how often its own SAFE was wrong. |

## Objections to expect

| Objection | Response |
| --- | --- |
| "Playwright has its own AI agents now." | They write and heal tests. Qyntra decides whether the release is safe, separates test defects from product defects, refuses repairs that weaken tests, and tracks its own accuracy. Use both. |
| "We'll just have Claude/Cursor write tests." | Good, and Qyntra gates on those tests too. Writing tests was never the hard part. Trusting the red and green is. |
| "Another tool in CI?" | It's one dev dependency and one workflow step, and it uses the tests you already have. Remove it in one line. |
| "Who are you? What if you disappear?" | The CLI runs in your repo and its output is plain Playwright tests and JSON. Nothing is locked in. |
| "What does it cost?" | Design partners pay $500/month and help shape the product. Your suite and data stay yours. |

## Where to find them

In order of how well each converts:

1. **Warm contacts.** Former colleagues and managers now at SaaS or
   fintech companies, and friends at startups. Ask for an introduction
   to whoever owns end-to-end tests.
2. **Job boards.** Search LinkedIn, Wellfound and company career pages
   for `SDET Playwright`, `QA automation Playwright` and
   `quality engineer Playwright`, filtered to 51–500 employees. The
   hiring manager on the posting is the buyer.
3. **GitHub.** Search code for `filename:playwright.config.ts` in
   organisation-owned repos, and issues for `flaky playwright`. Open
   source companies (dev tools, open-core SaaS) show their CI in public.
4. **Communities.** The Playwright Discord and GitHub discussions,
   Ministry of Testing, r/QualityAssurance, r/softwaretesting, and local
   QA and DevOps meetups. Answer questions about flaky tests first.
   Mention Qyntra only when it really fits.
5. **LinkedIn search.** Titles: `QA Lead`, `Head of QA`, `SDET Lead`,
   `Engineering Manager`, `Staff Engineer`. Industry: Software / Financial
   Services. Company size 51–200 or 201–500. Keyword: `Playwright`.

## Qualifying on the first call

Ask these before showing anything. A pilot needs **yes** to the first
four:

1. Do you have Playwright tests running in CI today?
2. Is there a staging or preview environment CI can reach?
3. Do you ship at least weekly?
4. Can you add a dev dependency and a workflow step without a review
   board?
5. How many hours a week go into flaky or broken tests? *(this is the
   number to beat)*
6. What reached production last quarter that a test should have caught?
7. Does your product have an AI feature? Who worries about it?
   *(this sets up the second offer: [AI-OFFER.md](AI-OFFER.md))*

Record the answers in the tracking table in [OUTREACH.md](OUTREACH.md).
