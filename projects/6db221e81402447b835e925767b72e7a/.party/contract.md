# Shared debate contract

Later agent sessions import `src/index.ts` and register role instructions with `createRoleRegistry`. Do not invent a second envelope.

- VC positions are `INVEST`, `MAYBE`, and `PASS`, with an integer `score` from 0 to 100 plus the existing scorecard fields. `MAYBE` is not the Chair's `pivot`.
- Only the Chair returns `decision.verdict` of `invest`, `pivot`, or `pass`. A pivot requires `pivotDirection`.
- Chair-facing text uses `GO`, `PIVOT`, and `KILL`. Map those to `invest`, `pivot`, and `pass`. Never derive that verdict by translating VC `INVEST` / `MAYBE` / `PASS` or by averaging scores. Register the Chair with `registerChair` from `src/chair.ts`. Missing brief fields or required debate stages are `incomplete_context`, not a verdict.
- Claims use `founder_provided`, `supported_evidence`, `assumption`, or `unknown`. Supported evidence needs `evidenceNote`. Do not add citations.
- Provider calls read `OPENAI_API_KEY` on the server. Missing credentials return `missing_credentials`. Never substitute sample debate text.
- `OPENAI_BASE_URL` and `GAUNTLET_MODEL` are optional. The default model name is `gpt-4o-mini`.
- Debate order lives in `src/debate.ts`: assessments, Red Team challenge, rebuttals, founder pause, explicit verdict request, Chair. Retry clears a failure without deleting successful messages.

## Specialist scores for UI adapters

- Assessment and rebuttal fields are VC `score` (0–100), Competitor `threatScore` (0–10), Customer `adoptionScore` (0–10), and Engineer `feasibilityScore` (0–10). All scores are integers. Customer adoption measures likelihood of adopting **and paying**; Engineer feasibility measures buildability. Higher Competitor scores mean a greater threat to the incumbent, not greater competitive risk for the startup.
- New generation requests Customer and Engineer scores alongside `positionLabel`. Supplied scores are validated; missing new scores remain valid for older responses. Schema version 1, positions, and existing role fields remain unchanged.
- `SPECIALIST_SCORE_SPECS` exports each field name and native maximum. `getPrimaryScore(envelope)` returns its assessment/rebuttal score or `null` when missing. Import both from `src/index.ts`; fall back to position changes whenever either side lacks a score. Do not invent a numeric fallback or compare different agents' raw scores.
- Rebuttals carry the revised score. `changed: false` retains the opening score when both Customer/Engineer scores are present; old position-only exchanges remain accepted. Later debate context includes recorded scores with their own scales.

## VC Agent

`src/vc.ts` registers the VC persona with `registerVcAgent(registry)` and runs one turn with `runVcTurn(run, client, registry)`. It reuses the shared envelope, `generateContribution`, and `completeTurn`; it does not define a second contract.

- The phase picks the stage: assessment, rebuttal, or founder response.
- A rebuttal must copy a phrase from the Red Team challenge into `fields.challengeReference`, and `changed` must match whether score or position differs from the opening. The opening stays in the transcript.
- A founder response must keep the current VC position. Only a rebuttal can change it.
- Failures fail the turn through `failTurn`; the run is retryable and nothing is recorded.

## Competitor Agent

`src/competitor.ts` registers the incumbent persona with `registerCompetitorAgent(registry)` and runs one turn with `runCompetitorTurn(run, client, registry)`. It uses the same envelope. It does not score Venture Gauntlet, and it does not return a Chair verdict.

- `threatScore` is an integer from 0 to 10. `positionLabel` and `fields.stance` are `NOT_A_THREAT`, `COPYABLE_FEATURE`, or `REAL_WEDGE`.
- Scorecard fields are `incumbent`, `crushPlan`, `weakMoat`, `copyabilityRisk`, `distributionDisadvantage`, `dangerousMove`, `founderQuestion`, and `verdict`.
- A named incumbent the brief does not supply must appear in an assumption or unknown claim. Another labeled claim does not cover it. No citations.
- A rebuttal quotes the Red Team challenge. Only a rebuttal can change the score or stance. The opening assessment stays in the transcript.

## Red Team

`src/redTeam.ts` registers the persona with `registerRedTeamAgent(registry)`. `runRedTeamTurn(run, client, registry)` reviews the opening assessments already on the run. `generateRedTeamReview(request, client, registry)` reviews a supplied brief, ordered assessments, and optional founder defense without reading another run.

- Output stays on the shared envelope. `summary` is one sentence. `rationale` and `fields.presentation` are the seven required sections in order. `fields.targetedRoles` and `fields.questions` stay populated for the debate orchestrator.
- Parallel `fields.challenge*` arrays are length 3 and keep source contribution ids. Unavailable slots say `unavailable` and include a reason. They are not filled with invented claims.
- A substantive challenge must quote an anchor that appears in the cited assessment. Source ids outside the supplied set are rejected. A simulated opinion, a copied-feature claim, a shared sentence, or an unsourced market or payment claim cannot be labeled `supported_evidence`.
- `fields.reviewComplete` is false when a specialist assessment is missing, and the summary must say the review is not complete. `WHO SHOULD REVISE` cites a supplied position or says no revision is warranted. It does not assign a replacement score or a Chair verdict.
- Missing credentials, timeouts, provider failures, and invalid output fail without recording a sample critique.
