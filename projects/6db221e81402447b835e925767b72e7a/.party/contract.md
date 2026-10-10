# Shared debate contract

Later agent sessions import `src/index.ts` and register role instructions with `createRoleRegistry`. Do not invent a second envelope.

- VC positions are `INVEST`, `MAYBE`, and `PASS`, with an integer `score` from 0 to 100 plus the existing scorecard fields. `MAYBE` is not the Chair's `pivot`.
- Only the Chair returns `decision.verdict` of `invest`, `pivot`, or `pass`. A pivot requires `pivotDirection`.
- Claims use `founder_provided`, `supported_evidence`, `assumption`, or `unknown`. Supported evidence needs `evidenceNote`. Do not add citations.
- Provider calls read `OPENAI_API_KEY` on the server. Missing credentials return `missing_credentials`. Never substitute sample debate text.
- `OPENAI_BASE_URL` and `GAUNTLET_MODEL` are optional. The default model name is `gpt-4o-mini`.
- Debate order lives in `src/debate.ts`: assessments, Red Team challenge, rebuttals, founder pause, explicit verdict request, Chair. Retry clears a failure without deleting successful messages.
## VC Agent

`src/vc.ts` registers the VC persona with `registerVcAgent(registry)` and runs one turn with `runVcTurn(run, client, registry)`. It reuses the shared envelope, `generateContribution`, and `completeTurn`; it does not define a second contract.

- The phase picks the stage: assessment, rebuttal, or founder response.
- A rebuttal must copy a phrase from the Red Team challenge into `fields.challengeReference`, and `changed` must match whether score or position differs from the opening. The opening stays in the transcript.
- A founder response must keep the current VC position. Only a rebuttal can change it.
- Failures fail the turn through `failTurn`; the run is retryable and nothing is recorded.

## Red Team

`src/redTeam.ts` registers the persona with `registerRedTeamAgent(registry)`. `runRedTeamTurn(run, client, registry)` reviews the opening assessments already on the run. `generateRedTeamReview(request, client, registry)` reviews a supplied brief, ordered assessments, and optional founder defense without reading another run.

- Output stays on the shared envelope. `summary` is one sentence. `rationale` and `fields.presentation` are the seven required sections in order. `fields.targetedRoles` and `fields.questions` stay populated for the debate orchestrator.
- Parallel `fields.challenge*` arrays are length 3 and keep source contribution ids. Unavailable slots say `unavailable` and include a reason. They are not filled with invented claims.
- A substantive challenge must quote an anchor that appears in the cited assessment. Source ids outside the supplied set are rejected. A simulated opinion, a copied-feature claim, a shared sentence, or an unsourced market or payment claim cannot be labeled `supported_evidence`.
- `fields.reviewComplete` is false when a specialist assessment is missing, and the summary must say the review is not complete. `WHO SHOULD REVISE` cites a supplied position or says no revision is warranted. It does not assign a replacement score or a Chair verdict.
- Missing credentials, timeouts, provider failures, and invalid output fail without recording a sample critique.
