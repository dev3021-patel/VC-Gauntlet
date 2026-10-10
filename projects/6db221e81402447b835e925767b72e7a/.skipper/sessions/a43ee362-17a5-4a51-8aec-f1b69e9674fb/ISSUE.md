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
- [ ] A valid idea brief produces a provider-generated VC opening assessment with all required role and VC-specific fields.
- [ ] The VC score is an integer from 0 through 100 and its position is exactly `INVEST`, `MAYBE`, or `PASS`; each has a concise justification in the assessment content.
- [ ] Opening output includes a concrete investment case, fundability risk, first-100-user plan, kill-shot founder question, and memorable one-line verdict rather than generic praise.
- [ ] The agent labels unsupported market, customer, competitor, and traction statements as assumptions or unknowns and emits no fabricated citations.
- [ ] A Red Team challenge produces a VC rebuttal that references the supplied challenge, declares whether the score/position changed, and preserves the original assessment separately.
- [ ] A founder question or evidence update receives a response grounded in the idea brief and supplied debate context.
- [ ] Missing provider configuration, timeout, provider failure, and invalid structured output produce honest recoverable errors without duplicate or sample contributions.
- [ ] The role interface retains VC `MAYBE` independently from the Chair’s Invest / Pivot / Pass verdict interface.
- [ ] Focused checks cover output parsing, all three VC positions, assumption labeling, challenge context, founder context, and failure recovery.
- [ ] The implementation is scoped to `projects/6db221e81402447b835e925767b72e7a`, updates its committed `.party/checks.json`, and avoids UI orchestration or other committee-role logic.

