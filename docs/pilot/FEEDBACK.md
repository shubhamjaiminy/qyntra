# Qyntra pilot feedback

Fill this in at the end of the pilot, before the wrap-up call. Short
answers are fine; honest ones matter more than polite ones. Attach the
final `pilot-report.md`.

**Company / team:**
**Your role:**
**Pilot dates:**
**Application type** (e.g. B2B dashboard, e-commerce, internal tool):

---

## 1. Release decisions

1. How many times did Qyntra say `UNSAFE` when you believed the release
   was fine? What was the reason it gave?
2. Did anything break in production that Qyntra had called `SAFE`?
   What was it?
3. Would you make Qyntra a required check on your main branch today?
   - [ ] Yes  - [ ] Yes, with changes  - [ ] No
   - What would have to change?

## 2. Generated tests

4. Of the tests Qyntra generated, roughly what share were worth keeping?
   - [ ] Most  - [ ] About half  - [ ] Few  - [ ] None
5. Which important flows did it miss?
6. Did it generate anything harmful or noisy (created junk data, clicked
   something it should not have)?

## 3. Failure diagnosis

7. When a test failed, was the "broken test vs. real bug" call right?
   - [ ] Almost always  - [ ] Usually  - [ ] Often wrong
8. Did the diagnosis save you time compared with reading the Playwright
   trace yourself? Roughly how much per failure?

## 4. Repairs

9. Did you accept any repair Qyntra proposed? Did you reject any — why?

## 5. Setup and day-to-day

10. How long did setup take? Where did you get stuck?
11. Which AI provider did you use (Ollama, Gemini, OpenAI, none)? Was it
    fast and reliable enough?
12. Did you record release outcomes every release? If not, what got in
    the way?

## 6. Value

13. What is the single most useful thing Qyntra did during the pilot?
14. What is the single biggest reason you would *not* keep using it?
15. If Qyntra kept your data in your CI and added a hosted dashboard
    (history across repos, team approvals, Slack/Jira alerts), what would
    your team expect to pay per month?
    - [ ] Nothing  - [ ] < $100  - [ ] $100–500  - [ ] $500–2,000
    - [ ] > $2,000
16. Who else at your company would need to approve buying it?
17. Would you keep using it after the pilot? Can we name you as an early
    user?

---

## For Qyntra: scoring the pilot

Filled in by us from the reports and the call.

| Metric | Target | Result |
| --- | --- | --- |
| Confirmed bugs caught + false alarms avoided, per week | ≥ 1 bug or ≥ 3 false alarms ([scorecard](SCORECARD.md)) | |
| Precision of those claims | ≥ 80% | |
| Releases with a recorded outcome | ≥ 80% | |
| Escape rate (called safe, then broke) | ≤ 10% | |
| False alarms (blocked, but fine) | ≤ 1 in 5 `UNSAFE` calls | |
| Generated tests worth keeping | ≥ 50% | |
| Test-vs-product diagnosis right | ≥ 80% | |
| Still running in CI at week 4 | Yes | |
| Would pay | Yes | |
| Paying after week 2 ([DESIGN-PARTNER.md](DESIGN-PARTNER.md)) | Yes, $500/month | |
