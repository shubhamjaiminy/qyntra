# Finding design partners

Goal: **3–5 teams running Qyntra in CI within 6 weeks.** Expect to
contact about 30 people to get there: roughly a third reply, a third of
those try it, and some of those stick.

## Who to ask

One buyer, defined in [BUYER.md](BUYER.md): an engineering or QA lead
at a 20–200 engineer SaaS or fintech company that already runs
Playwright tests and has flaky CI. That file also lists the signals to
look for, where to find these people, their objections, and the
qualifying questions for the first call.

In short, a good design partner has all of these:

- A web application with a **staging environment** reachable from CI.
- **Playwright end-to-end tests** already in the repo.
- A **CI pipeline** on GitHub Actions (others work, but GitHub is what
  the docs cover).
- **Ships at least weekly**, so 4 weeks gives enough releases to judge.
- **Feels the pain**: flaky end-to-end tests and slow failure triage.
- A **person who can say yes** without procurement.

Start with people who already know you: former colleagues, managers and
teams; QA and SDET communities you are part of; friends at startups.
Warm introductions convert many times better than cold messages.

Avoid for now: companies that need a security review before trying any
tool (banks, insurers, healthcare enterprises; fintech *startups* are
fine) — they are the right customers
later, when there is a track record and a SOC 2 report.

## Message 1 — warm contact (LinkedIn / WhatsApp / email)

> Hi [name] — I've been building Qyntra, an AI quality engineer for web
> apps. It runs in your own CI, generates Playwright tests for the flows
> you name, works out whether each failure is a broken test or a real
> bug, repairs broken tests, and gives every PR a SAFE / UNSAFE release
> decision with reasons. Your code and data never leave your CI.
>
> I'm looking for 3–5 teams to try it free for 4 weeks on a real staging
> app and tell me honestly what it gets wrong. Setup is about an hour.
>
> Would [team/company] be up for it, or is there someone you'd suggest I
> talk to?

## Message 2 — cold, to a QA or engineering lead

**Subject:** Is this release safe to ship? (4-week free pilot)

> Hi [name],
>
> I'm building Qyntra, which answers one question on every pull request:
> is this safe to ship? It runs inside your CI, generates and runs
> Playwright tests, separates broken tests from real product defects,
> repairs flaky selectors (verified by re-running), and posts a
> SAFE / UNSAFE decision with the reasons.
>
> Unlike most AI testing tools, nothing is uploaded: tests, code and
> screenshots stay in your CI, and it can run on a fully local model.
>
> I'm looking for a few design partners for a free 4-week pilot. In
> return I'd ask for an hour of setup and honest feedback on its
> decisions. One-page overview attached.
>
> Worth a 20-minute call?
>
> [name]

Attach `docs/PITCH.md` exported as PDF.

## Follow-up — 5 days later, once only

> Hi [name], following up once in case this got buried. If flaky
> end-to-end tests or slow release sign-off aren't a problem for your
> team right now, no worries — I'd still value a one-line reply on what
> *is* the biggest testing pain for you.

That last question is useful even from people who say no.

## The first call (20 minutes)

1. **Their pain (10 min)** — ask before showing anything:
   - How do you decide a release is safe today? Who decides?
   - What broke in production in the last quarter? Would a test have
     caught it?
   - How much time goes into flaky or broken tests each week?
2. **Show (5 min)** — `qyntra run` on the TodoMVC demo, then the
   dashboard and the release decision.
3. **Ask (5 min)** — "Would you try it on your staging app for 4 weeks?"
   If yes, agree a setup session date and send `ONBOARDING.md`.

Write down their exact words about the pain. They become the
website copy.

## Tracking

Keep one row per person; review weekly.

| Name | Company | Role | Source (warm/cold) | Contacted | Replied | Call | Pilot started | Status / notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | |

A pilot counts as **started** only when Qyntra has run in their CI at
least once. A "yes, sounds great" is not a pilot.
