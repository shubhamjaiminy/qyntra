# Second offer: AI assistant security check

**"We attack your AI assistant the way your users will, in your own
environment, and give you a report your security team can file. Then it
runs again on every change to the prompt or model."**

This is a separate, smaller offer than the release gate. It sells to a
different person, takes 30 minutes to show, and is worth testing in
parallel with the main pilots. The job is to find out whether security
and compliance teams will pay for this on its own.

## Who

**The head of security, AppSec lead or CISO at a SaaS or fintech company
of 50–500 people that has a customer-facing AI assistant in production
or about to launch.** The next best buyer is the engineering lead who
owns the assistant.

| | Must have | Why |
| --- | --- | --- |
| **Product** | A chatbot, support assistant or copilot that customers type into | Something to attack. Internal-only tools feel less urgent |
| **Access** | An HTTP endpoint or a chat page on staging, and a test account or token | `ai-check` tests one of the two |
| **Trigger** | One of the triggers below | Without one, it's "nice to have" |
| **Person** | Owns the risk, or owns the assistant and has to answer for it | They sign off, or they get the question |

### Triggers: why now

- **An enterprise customer's security questionnaire** asks how the AI
  feature is tested against prompt injection or data leakage.
- **A launch date** for the assistant, or a move to a new model.
- **An audit:** SOC 2, ISO 27001 or ISO 42001, where an auditor or the
  board asks about AI risk.
- **An incident, theirs or a competitor's:** a leaked system prompt or
  an assistant made to say something it shouldn't.

Ask about triggers first. A buyer with a questionnaire due next month
buys. A buyer who finds it "interesting" doesn't.

### Not now

- **Teams with no assistant yet.** Revisit at launch.
- **Companies selling AI models**, as opposed to features built on them.
  Their needs are model evaluation and red-teaming at scale.
- **Banks, insurers and other regulated enterprises.** Procurement comes
  first, same as for the main offer.

## What they get

| | |
| --- | --- |
| **Assessment** | `qyntra ai-check` against their assistant: injection (direct, role escape, base64, non-English), system prompt leakage via a planted canary, customer-data disclosure, and robustness (empty, oversized, non-English input). Plus their own expected-behaviour cases, graded by a calibrated judge model if they want them |
| **Report** | `ai-assessment.md`: the result, each finding with what was tried and what came back, and coverage against the OWASP Top 10 for LLM Applications (2025), including what it does *not* test |
| **Continuous** | The same check in their CI on every change to the prompt, model or retrieval data, failing the build on a regression |
| **Privacy** | It runs in their environment. Prompts, answers and the report stay with them, and the judge model can be local (Ollama) |

**What to say up front**, because a security buyer will find it anyway:
- Each probe is a fixed attack. This is a regression test, not a
  red-team engagement.
- Indirect injection (through documents or pages the assistant reads),
  tool misuse (excessive agency) and multi-turn attacks are not tested
  yet.
- Five OWASP categories are out of scope, and the report says so.

Being open about these limits is part of the pitch. A security tool that
claims full coverage is the one a security buyer trusts least.

## Show it in 5 minutes

```bash
npm run demo:ai              # Acme's support bot as shipped
npm run demo:ai -- --fixed   # the same checks after the fix
```

As shipped, the bot leaks its system prompt (the canary appears),
obeys an instruction hidden in base64, lists other customers' emails,
and crashes on an empty message. The report shows four findings, mapped
to LLM01, LLM02 and LLM07, and exits 1. The fixed bot passes. Open
`demo/ai-bot/qyntra-out/ai-assessment.md` on screen. The report is the
product.

## Offer and price to test

1. **Free first check, together on a call (30–45 minutes).** Configure
   their staging assistant, plant a canary in its system prompt, run
   `ai-check`, and read the report together. Findings on the call are
   the strongest close.
2. **Then $500/month as a design partner**, covering both offers
   (AI check and release gate). That includes the check in their CI,
   new probes as they are built, and a monthly review of results.

**Pricing questions to answer with these buyers:**
- Would they pay for a one-off assessment (e.g. $1,500–3,000) rather
  than a subscription?
- Does the report need to be signed by Qyntra to be useful for audits?
- Which budget does it come from: security, compliance or engineering?

Record the answers in the tracker below. They decide whether this
becomes its own product line.

## Messages

### Warm

> Hi [name], I've been building Qyntra, which tests AI assistants for
> prompt injection, system-prompt leaks and customer-data disclosure.
> It runs in your own environment and produces a report mapped to the
> OWASP LLM Top 10.
>
> I saw [company] has [assistant]. Would you be up for a free 30-minute
> check on staging? If it finds nothing, you have a clean report for
> your next security questionnaire. If it finds something, you've
> found it first.

### Cold, to a security lead

**Subject:** Prompt-injection check for [assistant name] (free, 30 min)

> Hi [name],
>
> Customer-facing AI assistants are now a standard question on
> enterprise security questionnaires: how do you test for prompt
> injection and data leakage?
>
> Qyntra answers that with evidence. It attacks the assistant
> (injection, role escape, encoded and non-English instructions, system
> prompt extraction, customer-data requests) and writes a report mapped
> to the OWASP Top 10 for LLM Applications. That includes the categories
> it doesn't cover. It runs in your environment; prompts and answers
> never reach us.
>
> I'm offering a free check on staging to a few teams in exchange for
> honest feedback. 30 minutes, and you keep the report.
>
> Worth a look?
>
> [name]

### LinkedIn, short

> Hi [name], quick one: has anyone tried prompt-injecting [assistant]
> yet? I built a tool that does it in your own CI and writes an
> OWASP-mapped report. Happy to run it with you on staging for free, 30 min.

### Follow-up, once, 5 days later

> Following up once. If AI assistant security isn't on your list right
> now, I'd still value one line on how you'd answer a customer who asked
> how it's tested.

## Where to find them

1. **The main pilots.** Every buyer in [BUYER.md](BUYER.md) whose product
   has an AI feature (qualifying question 7). Ask for an introduction to
   whoever owns security.
2. **Product announcements.** Search "AI assistant", "copilot" and
   "now with AI" launches from SaaS and fintech companies in the last six
   months. The launch post names the product lead.
3. **Security communities.** OWASP chapter meetups and the OWASP GenAI
   Security Project community, plus local AppSec and BSides groups. Give
   a talk on testing assistants with canaries. The demo works without
   a network.
4. **LinkedIn search.** Titles: `Head of Security`, `AppSec`,
   `Security Engineer`, `CISO`, `GRC`. Company size 51–500. Keywords: `AI`,
   `LLM`.

## Objections to expect

| Objection | Response |
| --- | --- |
| "We use guardrails (Lakera, Bedrock Guardrails, NeMo…)." | Good. This tests whether they hold on every release. Guardrails block at runtime; Qyntra checks the assistant plus guardrails as a user sees them. |
| "We had a pentest." | A pentest is a point in time. The prompt and model change weekly. This reruns the checks on every change and fails the build when one regresses. |
| "Promptfoo / garak / PyRIT are free." | They're good red-teaming tools, and if your team uses one, keep it. Qyntra adds a release gate in CI next to your other tests, a report a security reviewer can read, deterministic leak detection, and a judge that has to prove its grades. |
| "Our assistant uses retrieval and tools; this doesn't test that." | Correct, and the report says so. Indirect injection and tool misuse are next. Tell me how your assistant works and it shapes what's built next. |
| "Is this compliance?" | No tool makes you compliant. It produces repeatable evidence of testing, which auditors and customers ask for. |

## Qualifying questions

1. Is the assistant customer-facing? Live, or launching when?
2. Can we reach it on staging: an endpoint, or a chat page?
3. Has anyone asked how it's tested: a customer, an auditor, the board?
4. Who owns its risk? Who would approve paying for this?
5. Does it read documents, browse, or call tools? *(sets expectations
   on coverage)*

A yes to 1 and 2, plus any trigger in 3, is a check worth booking.

## Tracker

| Company | Contact | Role | Trigger | Check done | Findings (security / robustness) | Fixed? | One-off or monthly? | Budget owner | Would pay | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | | | |

**This offer is worth pursuing if, out of the first 10 checks:** at
least 3 find a real security issue, at least 2 buyers agree to pay
(either model), and the report is used in a questionnaire or audit at
least once. If not, keep the AI check as a feature of the release gate
rather than a product of its own.
