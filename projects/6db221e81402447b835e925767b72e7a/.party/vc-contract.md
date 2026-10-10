# VC Agent contract

Reusable role logic for Venture Gauntlet Agent 1. Integration should import this package rather than reimplement the persona.

## Calls

- `runVcOpening({ brief, debate?, provider?, env? })`
- `runVcRebuttal({ brief, opening, challenge, debate?, provider?, env? })`
- `runVcFounderResponse({ brief, founderMessage, opening?, debate?, provider?, env? })`

Success envelopes use `role: "vc"`, a contribution type, generated `content`, `assumptions`, and a role `result`. VC positions are exactly `INVEST`, `MAYBE`, and `PASS`. `MAYBE` is not the Chair verdict `Pivot`. Chair verdicts stay `Invest`, `Pivot`, and `Pass`.

## Provider

Server calls use `AI_API_KEY` or `OPENAI_API_KEY`, optional `AI_BASE_URL`, `AI_MODEL`, and `AI_TIMEOUT_MS`. Missing credentials, timeouts, provider failures, and invalid JSON return `{ ok: false, recoverable: true }` and never a sample assessment. Founder discussion does not change the recommendation; only a rebuttal may, and it must say whether score or position changed while preserving `openingAssessment`.
