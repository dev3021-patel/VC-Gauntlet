# Issue #2: Build VC Agent for Venture Gauntlet

**URL:** https://app.party.build/issues/2
**Reference slug:** VC Agent
**Status:** open  **Type:** feature
**Revision:** 501948c9-e78e-4fcc-9d2a-267c92380788
**Annotation coordinates:** use `party issue view <n> --numbered`; this file's lines are not canonical.

## Summary
Build the reusable VC Agent role for Venture Gauntlet. It must use real provider-generated analysis to assess venture-scale potential, preserve a scored INVEST / MAYBE / PASS recommendation, and participate in challenge and founder-discussion rounds without conflicting with the Committee Chair’s final Invest / Pivot / Pass decision.

## Behavior
- **Shared contract:** Accept a validated idea brief containing the startup idea, problem, target customer, proposed solution, and business model; accept optional founder traction or evidence and ordered debate context. Return a common role envelope that identifies the VC role, contribution type, generated content, assumptions, and a role-specific result payload.
- **Opening assessment:** Generate a concise, card-ready assessment using the VC persona. Evaluate market size, timing, business model, distribution, scalability, defensibility, and venture fit. Return a justified integer score from 0 through 100, one position of `INVEST`, `MAYBE`, or `PASS`, and the exact fields `strongestInvestmentCase`, `biggestFundabilityRisk`, `first100Users`, `killShotQuestion`, and `oneLineVerdict`.
- **Grounded judgment:** Treat founder input as provided context, distinguish supported evidence from model assumptions or unknowns, and do not invent market research, customer demand, competitors, traction, or citations.
- **Reconsideration:** Given Red Team challenges and relevant preceding messages, generate a direct rebuttal that addresses the challenge, identifies whether the VC position or score changed, and explains why. Keep the opening result intact for comparison.
- **Founder participation:** Given a founder question or added evidence plus relevant debate context, return a context-aware VC response suitable for the ordered transcript. Added evidence may change the VC recommendation only when a subsequent reconsideration explicitly says so.
- **Real AI and recovery:** Obtain content only from the configured server-side provider. Missing credentials, invalid provider output, timeouts, and provider failures must surface a recoverable role error; never emit scripted fallback content as a real assessment.
- **Integration compatibility:** Preserve the VC `MAYBE` position verbatim. It is a specialist recommendation, not a synonym for the Chair’s `PIVOT`; the VC Agent does not create a final committee verdict or own sequencing/UI work.

## Acceptance Criteria
- [ ] A valid idea brief produces a provider-generated VC opening assessment with all required role and VC-specific fields. [annotation:A1]
- [ ] The VC score is an integer from 0 through 100 and its position is exactly `INVEST`, `MAYBE`, or `PASS`; each has a concise justification in the assessment content. [annotation:A2]
- [ ] Opening output includes a concrete investment case, fundability risk, first-100-user plan, kill-shot founder question, and memorable one-line verdict rather than generic praise. [annotation:A3]
- [ ] The agent labels unsupported market, customer, competitor, and traction statements as assumptions or unknowns and emits no fabricated citations. [annotation:A4]
- [ ] A Red Team challenge produces a VC rebuttal that references the supplied challenge, declares whether the score/position changed, and preserves the original assessment separately. [annotation:A5]
- [ ] A founder question or evidence update receives a response grounded in the idea brief and supplied debate context. [annotation:A6]
- [ ] Missing provider configuration, timeout, provider failure, and invalid structured output produce honest recoverable errors without duplicate or sample contributions. [annotation:A7]
- [ ] The role interface retains VC `MAYBE` independently from the Chair’s Invest / Pivot / Pass verdict interface. [annotation:A8]
- [ ] Focused checks cover output parsing, all three VC positions, assumption labeling, challenge context, founder context, and failure recovery. [annotation:A9]
- [ ] The implementation is scoped to `projects/6db221e81402447b835e925767b72e7a`, updates its committed `.party/checks.json`, and avoids UI orchestration or other committee-role logic. [annotation:A10]


## Annotations

### Annotation A1 · current · open
**Range:** `14:7-14:124`

> A valid idea brief produces a provider-generated VC opening assessment with all required role and VC-specific fields.

#### A1.1 · implemented
engineer · 2026-10-10T18:38:26.242830+00:00

Opening assessment returns a vc envelope with score, INVEST/MAYBE/PASS, card fields, assumptions, and provider-generated content.

**Evidence:**
- File: `party-e272109946de49cf89c6b227f3596c83:projects/6db221e81402447b835e925767b72e7a/src/vc/agent.ts:1-206`

### Annotation A2 · current · open
**Range:** `15:7-15:170`

> The VC score is an integer from 0 through 100 and its position is exactly `INVEST`, `MAYBE`, or `PASS`; each has a concise justification in the assessment content.

#### A2.1 · implemented
engineer · 2026-10-10T18:38:27.497807+00:00

Score must be an integer 0-100 and position must be exactly INVEST, MAYBE, or PASS. Justification is rendered into the assessment content.

**Evidence:**
- File: `party-e272109946de49cf89c6b227f3596c83:projects/6db221e81402447b835e925767b72e7a/src/parse.ts:1-202`

### Annotation A3 · current · open
**Range:** `16:7-16:184`

> Opening output includes a concrete investment case, fundability risk, first-100-user plan, kill-shot founder question, and memorable one-line verdict rather than generic praise.

#### A3.1 · implemented
engineer · 2026-10-10T18:38:34.220575+00:00

Opening content includes the investment case, fundability risk, first-100 plan, kill-shot question, and one-line verdict from the provider payload.

**Evidence:**
- File: `party-e272109946de49cf89c6b227f3596c83:projects/6db221e81402447b835e925767b72e7a/src/vc/agent.ts:1-206`

### Annotation A4 · current · open
**Range:** `17:7-17:151`

> The agent labels unsupported market, customer, competitor, and traction statements as assumptions or unknowns and emits no fabricated citations.

#### A4.1 · implemented
engineer · 2026-10-10T18:38:35.767047+00:00

Unsupported supported-status claims are relabeled assumptions, and citation-like text is stripped before the envelope is returned.

**Evidence:**
- File: `party-e272109946de49cf89c6b227f3596c83:projects/6db221e81402447b835e925767b72e7a/src/parse.ts:1-202`

### Annotation A5 · current · open
**Range:** `18:7-18:185`

> A Red Team challenge produces a VC rebuttal that references the supplied challenge, declares whether the score/position changed, and preserves the original assessment separately.

#### A5.1 · implemented
engineer · 2026-10-10T18:38:36.918512+00:00

Rebuttals must quote the supplied challenge, declare score and position changes from the revised values, and keep the caller opening assessment intact.

**Evidence:**
- File: `party-e272109946de49cf89c6b227f3596c83:projects/6db221e81402447b835e925767b72e7a/src/vc/agent.ts:1-206`

### Annotation A6 · current · open
**Range:** `19:7-19:120`

> A founder question or evidence update receives a response grounded in the idea brief and supplied debate context.

#### A6.1 · implemented
engineer · 2026-10-10T18:38:38.140147+00:00

Founder replies must address the founder message and the idea brief. Founder discussion cannot change the recommendation.

**Evidence:**
- File: `party-e272109946de49cf89c6b227f3596c83:projects/6db221e81402447b835e925767b72e7a/src/vc/agent.ts:1-206`

### Annotation A7 · current · open
**Range:** `20:7-20:172`

> Missing provider configuration, timeout, provider failure, and invalid structured output produce honest recoverable errors without duplicate or sample contributions.

#### A7.1 · implemented
engineer · 2026-10-10T18:38:39.459105+00:00

Missing credentials, timeout, provider failure, invalid JSON, and incomplete briefs return recoverable role errors with no sample content.

**Evidence:**
- File: `party-e272109946de49cf89c6b227f3596c83:projects/6db221e81402447b835e925767b72e7a/tests/vc-agent.test.ts:1-285`

### Annotation A8 · current · open
**Range:** `21:7-21:116`

> The role interface retains VC `MAYBE` independently from the Chair’s Invest / Pivot / Pass verdict interface.

#### A8.1 · implemented
engineer · 2026-10-10T18:38:40.622130+00:00

VC positions stay INVEST, MAYBE, and PASS. Chair verdicts remain Invest, Pivot, and Pass. MAYBE is not mapped to Pivot.

**Evidence:**
- File: `party-e272109946de49cf89c6b227f3596c83:projects/6db221e81402447b835e925767b72e7a/src/vc/agent.ts:1-206`

### Annotation A9 · current · open
**Range:** `22:7-22:146`

> Focused checks cover output parsing, all three VC positions, assumption labeling, challenge context, founder context, and failure recovery.

#### A9.1 · implemented
engineer · 2026-10-10T18:38:41.813658+00:00

tests/vc-agent.test.ts covers parsing, all three positions, assumption labeling, challenge context, founder context, and failure recovery.

**Evidence:**
- File: `party-e272109946de49cf89c6b227f3596c83:projects/6db221e81402447b835e925767b72e7a/tests/vc-agent.test.ts:1-285`

### Annotation A10 · current · open
**Range:** `23:7-23:186`

> The implementation is scoped to `projects/6db221e81402447b835e925767b72e7a`, updates its committed `.party/checks.json`, and avoids UI orchestration or other committee-role logic.

#### A10.1 · implemented
engineer · 2026-10-10T18:38:43.015232+00:00

VC role logic and checks.json are committed under projects/6db221e81402447b835e925767b72e7a. No UI sequencing or other committee roles were added.

**Evidence:**
- File: `party-e272109946de49cf89c6b227f3596c83:projects/6db221e81402447b835e925767b72e7a/.party/checks.json:1-5`

Reply with `party issue annotation reply <n> <A1> ...`; resolve with `party issue annotation resolve <n> <A1>`.
