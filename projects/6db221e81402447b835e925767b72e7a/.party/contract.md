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

## Competitor Agent

`src/competitor.ts` registers the incumbent persona with `registerCompetitorAgent(registry)` and runs one turn with `runCompetitorTurn(run, client, registry)`. It uses the same envelope. It does not score Venture Gauntlet, and it does not return a Chair verdict.

- `threatScore` is an integer from 0 to 10. `positionLabel` and `fields.stance` are `NOT_A_THREAT`, `COPYABLE_FEATURE`, or `REAL_WEDGE`.
- Scorecard fields are `incumbent`, `crushPlan`, `weakMoat`, `copyabilityRisk`, `distributionDisadvantage`, `dangerousMove`, `founderQuestion`, and `verdict`.
- A named incumbent the brief does not supply must appear in an assumption or unknown claim. Another labeled claim does not cover it. No citations.
- A rebuttal quotes the Red Team challenge. Only a rebuttal can change the score or stance. The opening assessment stays in the transcript.
