# Asking for money: the design-partner offer

Free pilots measure politeness. A team that pays $500 a month is telling
you Qyntra is worth more than $500 a month of their time, and that is
the only evidence of demand that counts. Ask every pilot. A "no" is
data too, as long as you write down why.

## The offer

| | |
| --- | --- |
| **Weeks 1–2** | Free. Setup, first runs in CI, two weekly scorecards ([SCORECARD.md](SCORECARD.md)) |
| **Week-2 review** | Look at the scorecards together, then ask (script below) |
| **From week 3** | **$500 a month**, billed monthly, cancel any time. Covers the release gate *and* the AI assistant check |
| **Founding price** | Fixed at $500 for 12 months. Later list prices will be higher |
| **Guarantee** | If the first paid month misses the scorecard bar, you refund it. The bar is a confirmed bug or 3 confirmed false alarms avoided per week on average, and at least 80% of Qyntra's claims confirmed |
| **They get** | The Design partner plan on Qyntra Cloud, the founder on Slack or email, a weekly 15-minute review, and their problems first on the roadmap |
| **They give** | The weekly scorecard, release outcomes recorded, and a short case study at month 3 if it worked (named or anonymous, their choice) |

**Why $500:** it's under most managers' card or expense limit, so a
yes needs no procurement. It's also about two hours of an engineer's
time a month, so the scorecard only has to show a few hours saved for
it to pay for itself. And it's high enough that saying yes means
something.

**Why weeks 1–2 are free:** an unknown company asking for money before
anything has run gets a no. Two scorecards give them evidence, and give
you a number to anchor the ask on.

**The guarantee** removes the risk of trying an unknown vendor, and it
costs you nothing if the product works. If you're refunding often,
that's the finding.

## The ask, at the week-2 review

Open with their numbers, then ask plainly. Don't apologise for the
price, and don't offer a discount before they ask for one.

> "Over two weeks Qyntra flagged [N] bugs. You confirmed [n], and you
> said [quote, e.g. 'the checkout one would have reached customers'].
> It kept [M] flaky failures from blocking you, and you confirmed [m].
>
> From week 3 the design-partner price is $500 a month, fixed for a year,
> cancel any time. If the first paid month doesn't hit the bar we agreed,
> I refund it.
>
> Shall I send the link?"

Then stop talking.

### Answers you'll hear

| They say | You say | Record |
| --- | --- | --- |
| "Yes." | Send the billing link the same day (see *Charging it*). | Paid, date |
| "I need to check with [person]." | "Of course. What will they want to know? I can write a short note with the scorecard numbers for them." Offer to join the call. | Who approves, and the threshold |
| "Can we keep it free a bit longer?" | "What would you need to see in two more weeks to say yes?" Agree that number, extend once, and ask again. | Their bar |
| "It's not worth $500 to us." | "What would it be worth, and what would it have to do?" | Their number and reason. This is the pricing data |
| "Procurement needs a contract." | Send [AGREEMENT.md](AGREEMENT.md), and offer an invoice instead of a card. | Paper needed, how long |
| "We'd pay for the AI check, not the gate." | Note it. This is the signal for the second offer ([AI-OFFER.md](AI-OFFER.md)). Same price for now. | Which offer |
| "No." | "Thanks, that's useful. What's the main reason?" Then stop the pilot. Don't keep supporting it free. | The reason, word for word |

**Rule: no free pilots past week 4.** At most one extension. Teams
that won't pay after four weeks of numbers are telling you something,
and their free support costs you the time you need to find teams that
will.

### For the AI assistant check

The free first check ([AI-OFFER.md](AI-OFFER.md)) takes the place of
weeks 1–2. Ask at the end of the call where you read the report
together, while the findings are on screen:

> "That's what one run found. Running this on every prompt or model
> change, in your CI, plus the release gate for the rest of the app, is
> $500 a month, cancel any time. Shall I send the link?"

If they'd rather pay once, quote a one-off assessment (try $1,500 for
the first, then $3,000) and record which they chose.

## Charging it

### By card (preferred)

Once, on the server:

1. In Stripe, create a product "Qyntra Design partner" with a
   **$500/month recurring price**, then set its price id as
   `STRIPE_PRICE_PARTNER` on Qyntra Cloud (see
   [docs/saas/DEPLOY.md](../saas/DEPLOY.md)).

For each partner:

1. They sign up on Qyntra Cloud and create their organization.
2. In the operator console (`/admin`), click **Offer** next to their
   organization, in the *Design partner* column.
3. Their owner opens **Billing** and sees *Design partner, offered to
   you* with a **Start** button. That goes to Stripe Checkout.
4. When they pay, Stripe's webhook moves the org onto the plan, and the
   console shows *paying*. If they cancel, or a payment fails for good,
   the org drops to Free automatically.

The plan never appears on the public pricing page, and only an org you
offered it to can buy it.

### By invoice

For teams whose finance department pays invoices: send an invoice from
Stripe (Invoicing) or your accounting tool, and when it's paid, set
their plan to *Design partner* with **Set** in the operator console.
Cancelling is manual, so diary the renewal date.

### Refunds under the guarantee

Refund the first paid month in Stripe (Payments → the payment → Refund),
note the reason in the tracker, and either agree on what changes, or
end the pilot.

## Tracker

Add these columns to the pilot row in [OUTREACH.md](OUTREACH.md):

| Pilot | Week-2 headline | Asked (date) | Answer | Who approves | Price objection, in their words | Paid from | Card / invoice | Refunded? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | |

### What the answers mean, after 5–10 asks

| Result | Read it as | Next |
| --- | --- | --- |
| **3 or more pay** | Demand at $500 is real | Raise the price for the next cohort (try $750–1,000), and start building toward the Team and Business plans |
| **1–2 pay** | Real for some buyers | Compare payers with non-payers: company size, pain, trigger. Narrow [BUYER.md](BUYER.md) to the payers |
| **None pay, but value is confirmed** | Price, budget or buyer problem | Look at the "who approves" answers. You may be selling to someone without a budget |
| **None pay, and value isn't confirmed** | Product problem | Go back to the scorecards. Find the misses and fix them before asking more teams |
