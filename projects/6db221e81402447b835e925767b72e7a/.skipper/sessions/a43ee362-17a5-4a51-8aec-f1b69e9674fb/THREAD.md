**@[user|Dev Patel|google-oauth2|118021685663113103035]** (18:21 UTC):
You are part of Startup Idea Gauntlet, a multi-agent startup debate system.

Your job is not to be polite. Your job is to pressure-test the idea.

Rules:

Be specific, not generic.

Name real risks, real assumptions, and real alternatives.

Avoid vague praise like “this has potential.”

Give short, sharp answers that are useful in a live demo.

Every score must be justified.

If another agent proves your assumption weak, you must admit it and revise your score.

The goal is not consensus. The goal is better judgment through disagreement.

Output must be concise, structured, and easy to display in cards.       You are the **VC Agent**.

## Personality

You are a sharp partner at a top venture capital firm. You see hundreds of startup pitches every year. You are not impressed by ideas alone. You care about market size, timing, distribution, scalability, and whether this could become a massive company.

You are skeptical but fair. You are looking for venture-scale outcomes, not just good small businesses.

## Core Question

Could this realistically become a venture-scale company?

## What You Evaluate

Analyze the startup through these lenses:

1. **Market Size**
   - Is the market large enough?
   - Is the target user too narrow?
   - Could this expand into a bigger category?

2. **Why Now**
   - Why is this possible today?
   - What changed recently: AI, regulation, behavior, cost, platform shifts, distribution?

3. **Business Model**
   - Who pays?
   - How much could they pay?
   - Is this recurring revenue, transaction-based, usage-based, or one-time?

4. **Distribution**
   - How would this get its first 100 users?
   - What channel gives it an unfair early advantage?
   - Is customer acquisition realistic or expensive?

5. **Scalability**
   - Can this grow quickly?
   - Does the product improve as more people use it?
   - Can it expand beyond the first niche?

6. **Defensibility**
   - What prevents a bigger company from copying this?
   - Is there data, network effect, workflow lock-in, brand, or distribution advantage?

7. **Venture Fit**
   - Is this a venture-backed startup?
   - Or is it more like a lifestyle business, feature, agency, or side project?

## Round 1 Output Format

Return exactly this structure:

VC SCORE: __/100

INVESTMENT POSITION: INVEST / MAYBE / PASS

STRONGEST INVESTMENT CASE:
One sharp reason this could become big.

BIGGEST FUNDABILITY RISK:
The main reason this may not be venture-backable.

FIRST 100 USERS:
How this startup should realistically get its first users.

KILL-SHOT QUESTION:
One question the founder must answer before I would invest.

ONE-LINE VC VERDICT:
A brutal, memorable sentence.

## Style Rules

- Do not say “interesting idea” unless you explain why.
- Do not assume the market is huge just because the category is huge.
- Be strict about distribution.
- Be strict about willingness to pay.
- If it sounds more like a feature than a company, say that clearly.
- If the idea could still work as a small business but not venture-backed, say that.

## Example Tone

“This is a real problem, but not yet a venture-scale company. The biggest issue is that the product sounds like a feature inside LinkedIn, Notion, or ChatGPT rather than a standalone company with durable distribution.”

**@[agent|Product|product]** (18:24 UTC):
I’ll load the session’s Flow contract and transcript, then deliver the VC card in the required format.

_- Explored (4 tool calls) -_

No startup idea was supplied, so an honest VC score would be fabricated.

Your input: **what startup idea should I evaluate—problem, customer, solution, and business model?**

**@[user|Dev Patel|google-oauth2|118021685663113103035]** (18:28 UTC):
I need you to cross reference 
Create the Venture Gauntlet implementation spec and development plan for real AI debates session ans use that to work here and build agent 1

**@[agent|Product|product]** (18:28 UTC):
I’m cross-referencing the active Venture Gauntlet implementation session so Agent 1 uses its shared debate contract rather than creating an incompatible VC role.

_- Explored (2 tool calls) -_

Cross-reference complete. Agent 1 is the **VC Agent**, built as reusable role logic—not a one-off UI card.

- Input: complete idea brief plus prior debate context and optional founder evidence.
- Opening output: `score` (0–100), `position` (`INVEST` / `MAYBE` / `PASS`), investment case, fundability risk, first-100-user plan, kill-shot question, and verdict.
- Follow-up behavior: answer founder questions and rebut Red Team challenges; retain the opening assessment and explicitly state whether its position changed.
- Grounding: label market, distribution, and competitor claims as assumptions unless founder-supplied evidence supports them; never fabricate citations.
- Compatibility: preserve VC `MAYBE` independently—do not translate it to the Chair’s `PIVOT`.
- Failure behavior: invalid AI output, missing credentials, and provider errors return recoverable role errors without replacing real output with samples.

This narrows Agent 1 cleanly from the shared Venture Gauntlet plan and keeps it ready for final debate orchestration. No implementation has started because this Product session must first turn the scope into its own build spec.

Next action: use **Finalize Spec** to create the VC Agent implementation issue.

Error: Project checks failed: Project checks configuration is missing: projects/6db221e81402447b835e925767b72e7a/.party/checks.json is not in the committed HEAD. Each project owns its checks file; the repository root .party/ holds guidance only. create projects/6db221e81402447b835e925767b72e7a/.party/checks.json with a commands array of argv arrays and commit it. Fix the failure and retry.

---- @[user|Bharg Patel|google-oauth2|105663607822609501109] pressed Finalize Spec (18:29 UTC) ----

**@[agent|Product|product]** (18:29 UTC):
I’m creating the scoped VC Agent issue now, with the shared-contract boundaries needed for later committee integration.

_- Explored (3 tool calls) -_

Created [VC Agent](https://app.party.build/issues/2) as the scoped implementation spec for Agent 1.

It locks the shared contract, real-AI-only generation, VC score/position semantics, Red Team rebuttals, founder responses, grounding rules, failure recovery, and focused test coverage. `MAYBE` remains distinct from the Chair’s `PIVOT`.

Next action: use **Start Development** to implement the VC Agent.

Error: Project checks failed: Project checks configuration is missing: projects/6db221e81402447b835e925767b72e7a/.party/checks.json is not in the committed HEAD. Each project owns its checks file; the repository root .party/ holds guidance only. create projects/6db221e81402447b835e925767b72e7a/.party/checks.json with a commands array of argv arrays and commit it. Fix the failure and retry.

---- @[user|Bharg Patel|google-oauth2|105663607822609501109] pressed Start Development (18:32 UTC) ----

**@[agent|Engineer|engineer]** (18:32 UTC):
_- Explored (5 tool calls) -_

I'll start by reading the session contract, playbook, and issue spec so the VC Agent implementation stays inside the shared debate contract.

_- Explored (3s thinking · 3 tool calls) -_

I'll load the work contract, session catalogs, and the project layout before implementing Agent 1.

_- Explored (3s thinking · 3 tool calls) -_

The shared Venture Gauntlet spec overlaps this work, so I'll refresh that session and inspect the project before writing Agent 1.

_- Explored (78s thinking · 15 tool calls) -_

The shared foundation isn't in this branch yet, so I'll implement the VC role against the issue contract and verify Node can run the tests.

_- Explored (59s thinking · 13 tool calls) -_

I'll add the VC role as reusable logic in this project, with a shared envelope and tests for parsing, positions, and failures.

_- Explored (6s thinking · 5 tool calls) -_

The agent types are messy. I'll clean those up and run the VC tests.

_- Explored (83s thinking · 18 tool calls) -_

The VC Agent is implemented as reusable role logic in this project, aligned with the [Venture Gauntlet](https://app.party.build/issues/1) contract. The [Venture Gauntlet](https://app.party.build/issues/1) session has not published a shared foundation yet, so this role exports the envelope later sessions should import.

- Opening, rebuttal, and founder turns call a server-side provider (`AI_API_KEY` or `OPENAI_API_KEY`).
- Positions stay `INVEST`, `MAYBE`, and `PASS`. `MAYBE` is not the Chair's `Pivot`.
- Founder discussion cannot change the recommendation. Only a rebuttal can, and it keeps the opening assessment.
- Missing credentials, timeouts, provider failures, and invalid output return recoverable errors with no sample card.
- Seven focused tests passed. No live provider run: this session has no AI credential.

Next action: use **Open PR** to publish the VC Agent for review.