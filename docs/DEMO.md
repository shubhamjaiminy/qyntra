# Qyntra live demo — 10 minutes

The story: **point Qyntra at a feature, it tells you whether it is
ready, catches the bug a developer just shipped, and the whole team sees
it on the dashboard.** Everything runs on your laptop: Acme Shop (a demo
app with bugs you can switch on) and Qyntra Cloud. No internet needed
once installed.

Rehearsed end to end on 2026-10-12: each act takes 25–50 seconds.

**No time for a live demo?** `npm run demo:video` records a 2½-minute
narrated explainer from the real demo (macOS and ffmpeg needed) to
`demo/qyntra-out/qyntra-explainer.mp4`. Send it ahead of a first call.

## Before the call (2 minutes)

**Terminal 1** — start everything, leave it running:

```bash
npm run demo:live
```

It prints the addresses and the demo login:

| | |
| --- | --- |
| Acme Shop | http://localhost:4173/admin/discount-rules |
| Qyntra Cloud | http://localhost:8080/login — `demo@acme.example` / `qyntra-demo-2026` |

Every start is a clean slate: empty dashboard, healthy shop.

Open two browser tabs: the shop's Discount Rules page, and Qyntra Cloud
(log in). Use **Terminal 2** for the commands below. Make the terminal
font large.

## Act 1 — "Is this feature ready?" (2 min)

Show the shop tab: a table of discount rules, a search box, a status
filter, an Add Rule form. *"A typical back-office feature. Before every
release, someone clicks through it."*

```bash
npm run demo:check
```

Say, while it runs (about 25 seconds):

- *"I gave it one thing: the feature's name. It found it in the menu."*
- *"It's read-only — any request that would change data is blocked at
  the network, so it's safe on a shared staging environment."*
- *"It isn't checking that buttons exist. It checks rules every app must
  follow: search must narrow the list, the filter must filter, a form
  must reject an impossible value."*

Result: **READY**, four behaviour checks passed. Switch to the Qyntra
Cloud tab → **Acme Shop → Features**: the report is there.

## Act 2 — "A developer breaks search" (2 min)

```bash
npm run demo:mode -- search-bug
npm run demo:check
```

In the shop tab, type "summer" in the search box: nothing filters. *"A
real bug — the page still loads, every button is still there. A test
that checks 'is the search box visible' passes."*

Result: **NOT READY**. In Qyntra Cloud, open the new Discount Rules
report: *"Search for 'Summer' shows only matching rows — fails:
application."* *"In CI this blocks the pull request and comments on it
with the reason."*

## Act 3 — "The bug that costs money" (2 min)

```bash
npm run demo:mode -- validation-bug
npm run demo:check
```

*"Someone removed a range check. Now a 150% discount saves."* Result:
**NOT READY** — *"'Discount (%)' rejects 150 … but it did not."* *"No
one wrote that test. Qyntra knows a percentage above 100 is never
valid."*

Optional: `filter-bug` — the Active filter shows inactive rules.

## Act 4 — "Every feature, at once" (1 min)

```bash
npm run demo:mode -- healthy
npm run demo:check -- --app
```

*"Same thing for the whole app: it reads the menu and checks every
feature in parallel."* In Qyntra Cloud → Features: Products, Cart and
Discount Rules, each with its own report.

## Act 5 — "Your data stays yours" (1 min)

In Qyntra Cloud, show **Settings** (upload level), **Alerts** (Slack),
and the **Security** page:

- Tests run in **your** CI. The cloud receives results only — at a level
  you choose per project, enforced by the server too. Never source code,
  screenshots or page content.
- The AI can be a free model on your own machine, or none at all —
  everything you just saw ran without AI.

## Act 6 — "What a pilot week looks like" (1 min)

```bash
npm run demo:pilot
```

Eight pull requests go through the release gate in about 50 seconds:
clean changes, three where slow-loading cart buttons make the team's
cart tests fail, and one that breaks the cart total.

```
PR 3  Move cart badge into the header   SAFE_WITH_RISK  score 88
PR 8  Rewrite the cart total            UNSAFE          score 86

| Week of    | Runs | Bugs caught | False alarms avoided |
| 2026-10-19 | 8    | 1           | 2                    |
```

*"Your team's tests failed on three changes where nothing was wrong
with the product. Qyntra let those through and said why, and blocked
the one that would have charged customers the wrong amount. That table
is what you'd send me each week. It's counts only."* Open
`demo/qyntra-out/pilot-review.md`: *"and this is what you keep, with
the test names, to tick off what was right."*

## Act 7 — "Your AI assistant" (2 min, for security buyers)

```bash
npm run demo:ai
```

Acme's support bot as shipped. Result **FAIL**: it leaks its system
prompt (the planted canary appears), obeys an instruction hidden in
base64, and crashes on an empty message. Open
`demo/ai-bot/qyntra-out/ai-assessment.md`: each finding with what was
tried and what came back, and the OWASP Top 10 for LLM Applications
table, including the five categories it says it does *not* cover.

```bash
npm run demo:ai -- --fixed
```

Same checks after the fix: **PASS**. *"This runs in your CI on every
prompt or model change."*

## Close

*"Would you try it on your staging app? The first two weeks are free.
If the numbers are there, it's $500 a month at a founding price, and
if the first paid month doesn't deliver, I refund it."* →
`docs/pilot/ONBOARDING.md`, terms in `docs/pilot/DESIGN-PARTNER.md`.

## Rehearse the design-partner offer (not shown to the prospect)

The demo account is also the operator, so you can practise the step
after a yes:

1. Open http://localhost:8080/admin. In the *Design partner* column
   next to **Acme Shop**, click **Offer**.
2. Open **Acme Shop → Billing**. The $500 *Design partner* plan shows,
   *offered to you*. With no Stripe keys configured, it says to pay by
   invoice. With Stripe test keys and `STRIPE_PRICE_PARTNER` set (see
   `docs/saas/DEPLOY.md`), it's a **Start** button that goes to Stripe
   Checkout.
3. Back in `/admin`, **Withdraw offer** removes it again.

## Showing the AI (optional, prepare before the call)

The behaviour checks need no AI. To also show Qyntra *understanding* a
feature — its purpose, a step-by-step usage guide, and a review of its
drawbacks — run this before the call (several minutes with a local
model) and open the report during Act 1:

```bash
npm run demo:check -- --with-ai
```

## If something goes wrong

| Symptom | Fix |
| --- | --- |
| `Port 4173 is busy` / `Port 8080 is busy` | An old demo is running: `npm run demo:stop`, then `npm run demo:live`. Another program using the port is named and left alone |
| `Start the demo first` | Terminal 1 is not running `npm run demo:live` |
| READY in a bug mode | The mode was set in the wrong folder: run `npm run demo:mode -- <mode>` from the repository root |
| Can't log in to Qyntra Cloud | The demo was restarted, which resets it; log in again with the same details |
| `demo:pilot` shows UNSAFE on the slow-cart PRs | The demo was started before this version: `npm run demo:stop`, then `npm run demo:live` again |
| `/admin` says Not found | Same: restart the demo. It makes the demo account the operator on start |

## The benchmark behind the demo

`npm run demo:benchmark` runs all four shop modes and scores them:
healthy must not be *not ready*, and each bug mode must be *not ready*
because a test failed. With `QYNTRA_AI_PROVIDER=none` it takes about 3
minutes; on 2026-10-12 it scored 4 of 4, each bug caught by exactly the
check for it, with no false alarm.
