# Shared debate contract

Later agent sessions import `src/index.ts` and register role instructions with `createRoleRegistry`. Do not invent a second envelope.

- VC positions are `INVEST`, `MAYBE`, and `PASS`, with an integer `score` from 0 to 100 plus the existing scorecard fields. `MAYBE` is not the Chair's `pivot`.
- Only the Chair returns `decision.verdict` of `invest`, `pivot`, or `pass`. A pivot requires `pivotDirection`.
- Chair-facing text uses `GO`, `PIVOT`, and `KILL`. Map those to `invest`, `pivot`, and `pass`. Never derive that verdict by translating VC `INVEST` / `MAYBE` / `PASS` or by averaging scores. Register the Chair with `registerChair` from `src/chair.ts`. Missing brief fields or required debate stages are `incomplete_context`, not a verdict.
- The Chair renders the expanded `INVESTMENT COMMITTEE CHAIR OUTPUT` report with `CONFIDENCE`, committee agreement/disagreement, a 2–3 sentence rationale, an attributed influential agent, three measurable GO criteria, pivot direction and stop-doing guidance. Its fields stay inside the existing envelope; no new top-level contract is introduced.
- `goCriteria`, `goCriteriaTests`, `goCriteriaPass`, and `goCriteriaFail` are parallel arrays of length three. `improvementTargets`, `improvementStatus`, `improvementChanges`, `improvementEvidence`, `improvementSuccess`, and `improvementFailure` are parallel arrays: KILL targets PIVOT then GO, PIVOT targets GO, and GO targets maintaining GO. Status is `conditional` or `unavailable`; unavailable routes explain why. Conditional improvement is a future test, never an automatic change to the recorded verdict. A fresh debate with new evidence is required.
- Claims use `founder_provided`, `supported_evidence`, `assumption`, or `unknown`. Supported evidence needs `evidenceNote`. Do not add citations.
- Provider calls read `OPENAI_API_KEY` on the server. Missing credentials return `missing_credentials`. Never substitute sample debate text.
- `OPENAI_BASE_URL` and `GAUNTLET_MODEL` are optional. The default model name is `gpt-4o-mini`.
- Debate order lives in `src/debate.ts`: assessments, Red Team challenge, rebuttals, founder pause, explicit verdict request, Chair. Retry clears a failure without deleting successful messages.

## Specialist scores for UI adapters

- Assessment and rebuttal fields are VC `score` (0–100), Competitor `threatScore` (0–10), Customer `adoptionScore` (0–10), and Engineer `feasibilityScore` (0–10). All scores are integers. Customer adoption measures likelihood of adopting **and paying**; Engineer feasibility measures buildability. Higher Competitor scores mean a greater threat to the incumbent, not greater competitive risk for the startup.
- New generation requests Customer and Engineer scores alongside `positionLabel`. Supplied scores are validated; missing new scores remain valid for older responses. Schema version 1, positions, and existing role fields remain unchanged.
- `SPECIALIST_SCORE_SPECS` exports each field name and native maximum. `getPrimaryScore(envelope)` returns its assessment/rebuttal score or `null` when missing. Import both from `src/index.ts`; fall back to position changes whenever either side lacks a score. Do not invent a numeric fallback or compare different agents' raw scores.
- Rebuttals carry the revised score. `changed: false` retains the opening score when both Customer/Engineer scores are present; old position-only exchanges remain accepted. Later debate context includes recorded scores with their own scales.

## Assessment reports

- Specialist assessment reports reuse `rationale` (2–4 short newline-separated points), `risks` (biggest risk first), and `assumptions` (existing grounding labels and evidence notes). There is no new report field or top-level structure; role scorecards and schema version 1 stay intact. Historical prose remains accepted.
- Shared provider instructions apply this concise format to specialist assessments only. Red Team, rebuttal, founder-response, and Chair formats remain unchanged. Independent opening generation receives only the founder brief. Subsequent debate context includes source message IDs and complete recorded envelopes, preserving assessment reasoning, risks, claim evidence notes, role fields, and revised scores.
- `AssessmentReport` is a reusable UI component accepting a `RoleEnvelope`. It displays the existing content beside the native score and position, with position-only fallback for missing scores. Import it from `src/AssessmentReport.tsx`; its styles are scoped in `src/assessment-report.css`. It can be reused by the separate five-screen UI work without changing the API contract.

## Chair chat after the verdict

- `verdict_chat` is a Chair-only discussion stage. `runChairChatTurn(run, input, client, history)` uses the full completed run, including every structured envelope and the original verdict. It returns a reply, never a changed run. Other Chair generation remains on the existing verdict adapter.
- `POST /api/debate/verdict-chat` accepts `runId`, `question`, and optional `newEvidence`; it returns `{reply}`. The reply uses the existing role envelope with stage `verdict_chat`, position `discussion`, and no decision. Premature chats return 409, invalid input 400, missing credentials 503, and invalid/provider output 502.
- The server stores successful chat exchanges separately and rejects overlapping chat requests with a separate chat lock. No chat input, answer, error, or provisional view is appended to `DebateRun.messages` or alters its phase, failure, lock, verdict, or scores. Chat history is session-memory conversation, not committee evidence.
- Reply fields pair `sourceMessageIds` with verbatim `sourceArguments` from this run. `notAssessed` requires a `validationTest`; `ownView` receives the explicit Chair's own view label. `newEvidence` requires a provisional change and reason. These are explanatory hypotheses, not replacement verdicts or scores.
- `ChairConversation` is a standalone UI component keyed by run ID, shown after completion. It retains failed drafts, provides retry, and discards its local conversation when starting a new idea. UI tests use provider/browser fixtures; they are not evidence of live-provider quality.

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
- `assessmentFromMessage` preserves claim grounding labels and evidence notes, each available primary score with its native scale, and the complete recorded envelope in the existing source text. The dedicated Red Team prompt uses this source context; it does not rely on the generic later-turn renderer to recover discarded metadata. Source IDs and the Red Team output format remain unchanged.


## Integrated API and live UI

- `handleApi` is the shared dev/production boundary. Debate endpoints require POST and exact route matches; provider status requires GET. Bad JSON/object shapes return 400, unknown routes 404, and phase/lock conflicts 409 without generating another turn.
- The API registers the VC and Competitor personas and uses their dedicated adapters. It publishes a run lock before awaiting generation, then records the adapter result once. Adapter/context/provider failures release the lock and retain successful messages.
- Founder input is added immutably only after lock, phase, and failure checks. Failed founder replies retry the recorded role in the existing founder phase; they never append the founder input again. A pending failure must be resolved before a verdict request. Customer/Engineer scored rebuttals must agree with their changed metadata; founder replies cannot change recorded positions or scores.
- Chair change attribution scans all messages by the named source, including later rebuttals. Quotes still require a verbatim supplied argument. Verdict chat remains separate and immutable.
- `RootApp` preserves the approved mock UI in `App` and exposes the real workflow in `LiveDebate`. Live forms show field errors, retain failed drafts, abort abandoned requests, and ignore stale responses. Accepted failed founder messages retry from the transcript and clear the draft on successful recovery.
- Vitest 5 replaces the affected test toolchain; the full test suite and Node runtime tests exercise integration failures. Browser checks use clearly labeled fixtures unless a real configured model is explicitly exercised.
