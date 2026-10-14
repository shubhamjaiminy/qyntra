# Weekly pilot scorecard

**The one number:** real bugs Qyntra caught, and false alarms it kept
from blocking a release, per week, as confirmed by the team that owns
the app.

Qyntra counts its own claims. Only the partner can say whether each
claim was right, so each week is a short review. It replaces a
"how's it going?" call, which tells you nothing.

## Every week (15 minutes, same day each week)

**Partner, before the call (5 minutes):**

1. In CI, download the `qyntra-report` artifact from the latest run on
   the main branch. It has two pilot files:
   - `pilot-report.md` holds counts only. Read it, then send it.
   - `pilot-review.md` names the tests behind the counts. **Keep it.**
2. Go through `pilot-review.md` and tick each line that was right:
   - **Bugs caught:** was it a real product bug?
   - **False alarms avoided:** was the test really broken or flaky, and
     not the product?
3. Fill in the partner section below and send it with `pilot-report.md`.

**Together, on the call (10 minutes):**

1. Go through anything marked wrong. Each one is a product bug in
   Qyntra, so log it the same day.
2. Ask for one thing that happened this week that Qyntra *should* have
   caught. That's a miss the counts can't show.
3. Ask: "Would you have found the confirmed bugs without Qyntra? When?"

## Partner section

Send this each week. Counts only, no test names.

```
Week of           : YYYY-MM-DD   (the Monday, from pilot-report.md)

Bugs caught       : __ claimed   __ confirmed real
False alarms avoid: __ claimed   __ confirmed broken/flaky test
Missed            : __ bugs that reached main/staging/prod that Qyntra
                       did not flag
Wrong blocks      : __ times Qyntra said UNSAFE and the change was fine

Without Qyntra, the confirmed bugs would have been found:
  [ ] in review  [ ] in QA  [ ] by a customer  [ ] not at all  [ ] not sure

Hours spent on flaky or broken tests this week: __
One sentence on the most useful or most annoying thing it did:
```

## Qyntra's tracker

One row per pilot per week. The **headline** is confirmed bugs plus
confirmed false alarms avoided. **Precision** is how many of Qyntra's
claims were right: confirmed ÷ claimed.

| Pilot | Week of | Bugs claimed | Bugs confirmed | Noise claimed | Noise confirmed | Missed | Wrong blocks | Headline | Precision | Flaky-test hours |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | | | |

### What good looks like by week 4

| Measure | Target | Why |
| --- | --- | --- |
| Headline | ≥ 1 confirmed bug *or* ≥ 3 confirmed false alarms avoided per week | Value the partner can name in one sentence |
| Precision | ≥ 80% | Below that, the team stops trusting the verdict |
| Missed | Falling week on week | Requirements and coverage are improving |
| Wrong blocks | ≤ 1 in 5 `UNSAFE` calls | The same bar as [FEEDBACK.md](FEEDBACK.md) |
| Flaky-test hours | Lower than week 1 | The pain they bought it for |
| Weeks reported | 4 of 4 | A partner who stops reporting has stopped using it |

A pilot with zero confirmed bugs and zero confirmed false alarms after
four weeks is a failed pilot, however polite the feedback. Write down
why: the wrong app, wrong requirements, too few tests, or a product gap.

## How the counts are made

From `qyntra-out/run-history.json`, which the gate updates every run:

- **Bug caught:** a failing test attributed to the product, or one that
  newly fails after passing in every recent run, unless the analysis put
  the failure down to the test itself.
- **False alarm avoided:** a failure on a test diagnosed as broken, or
  known to be flaky or chronically failing, and so down-weighted rather
  than blocking on its own.
- **Counting:** a test counts once per week however many runs it failed
  in. A test that was a bug in one run and noise in another that week
  counts as a bug only.

Run history keeps the last `gate.historyRuns` runs, 50 by default. On a
busy repo that can be less than a week, so pilots set it to 1000 (see
[ONBOARDING.md](ONBOARDING.md)). Runs pulled from Qyntra Cloud carry no
findings and are reported separately, not counted.
