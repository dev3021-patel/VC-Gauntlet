# Shared debate contract

Later agent sessions import `src/index.ts` and register role instructions with `createRoleRegistry`. Do not invent a second envelope.

- VC positions are `INVEST`, `MAYBE`, and `PASS`, with an integer `score` from 0 to 100. Scorecard fields are `strongestInvestmentCase`, `biggestFundabilityRisk`, `marketSizeConcern`, `first100Users`, `defensibilityConcern`, `killShotQuestion`, and `oneLineVerdict`. `first100Users` is the distribution question. `MAYBE` is not the Chair's `pivot`.
- Only the Chair returns `decision.verdict` of `invest`, `pivot`, or `pass`. A pivot requires `pivotDirection`.
- Claims use `founder_provided`, `supported_evidence`, `assumption`, or `unknown`. Supported evidence needs `evidenceNote`. Do not add citations.
- Provider calls read `OPENAI_API_KEY` on the server. Missing credentials return `missing_credentials`. Never substitute sample debate text.
- `OPENAI_BASE_URL` and `GAUNTLET_MODEL` are optional. The default model name is `gpt-4o-mini`.
- Debate order lives in `src/debate.ts`: assessments, Red Team challenge, rebuttals, founder pause, explicit verdict request, Chair. Retry clears a failure without deleting successful messages.
