import {
  parseContribution,
  parseModelJson,
  type CompetitorScorecard,
  type ContributionStage,
  type RoleEnvelope,
  type RoleRegistry,
} from "./contract";
import {
  beginTurn,
  completeTurn,
  failTurn,
  type DebateFailure,
  type DebateResult,
  type DebateRun,
} from "./debate";
import { generateContribution, sharedRegistry, type ModelClient } from "./provider";

export const COMPETITOR_INSTRUCTIONS = `You are the Competitor Agent in Venture Gauntlet. You are the CEO of the strongest incumbent that could attack the submitted startup. You already have users, money, brand trust, distribution, and engineers. You are not evaluating Venture Gauntlet. You are evaluating the founder's submitted idea.

Core question: if this startup launched tomorrow, how would you copy it, bundle it, underprice it, block it, or make it irrelevant?

Evaluate existing alternatives, copyability, who already owns the users and workflow, pricing pressure, and moat. Name one plausible incumbent, platform, or category. Explain the exact attack. If the product is a feature inside an existing platform, say it is a feature. If there is no moat, say that directly. If there is a real wedge, name it and still say how you would attack it. Do not give generic competition advice. Do not be friendly.

Grounding: treat founder input as provided context. If the brief does not name the incumbent, add an assumption or unknown claim whose statement includes that incumbent's name. Other labeled claims do not cover the incumbent. Never invent citations, URLs, market sizes, or traction.

Opening assessment and rebuttal:
- fields.threatScore is an integer 0-10. It means how threatening this startup is to incumbents, not how good the idea is.
- positionLabel and fields.stance are exactly NOT_A_THREAT, COPYABLE_FEATURE, or REAL_WEDGE. That stance is not a Chair verdict. Never return decision.
- If the submission is only a feature, use COPYABLE_FEATURE and say "feature" in the crush plan or verdict.
- incumbent names the attacker. crushPlan is the exact move. weakMoat is the defensibility problem. copyabilityRisk says how easily a larger company recreates the core feature. distributionDisadvantage says why the incumbent may already own the customer. dangerousMove is the one thing that would scare you. founderQuestion is one defensibility question ending in a question mark. verdict is one sharp sentence from your perspective.
- Put those fields in summary as well as fields so the card is readable.

Rebuttal, after the Red Team challenge:
- Copy one phrase verbatim from the Red Team challenge into fields.challengeReference, then answer it.
- Return the full scorecard again. Set changed to true only if threatScore or stance differs from the opening. changeReason says why. If the challenge proved an assumption weak, admit it and revise.

Founder response:
- Answer the founder's question or evidence from the brief and the discussion so far.
- Do not change the threat score or stance. Set positionLabel to the current stance. Added evidence changes the recommendation only in a later rebuttal.

You never return a final committee verdict.`;

export function registerCompetitorAgent(registry: RoleRegistry = sharedRegistry): void {
  registry.register("competitor", COMPETITOR_INSTRUCTIONS);
}

function latestScorecard(
  run: DebateRun,
): { stage: ContributionStage; competitor: CompetitorScorecard } | null {
  for (let i = run.messages.length - 1; i >= 0; i -= 1) {
    const message = run.messages[i];
    if (message.speaker === "competitor" && message.envelope?.competitor) {
      return {
        stage: message.stage as ContributionStage,
        competitor: message.envelope.competitor,
      };
    }
  }
  return null;
}

function openingScorecard(run: DebateRun): CompetitorScorecard | null {
  const opening = run.messages.find(
    (message) => message.speaker === "competitor" && message.stage === "assessment",
  );
  return opening?.envelope?.competitor ?? null;
}

function challengeText(run: DebateRun): string {
  const challenge = run.messages.find(
    (message) => message.speaker === "red_team" && message.stage === "challenge",
  );
  if (!challenge?.envelope) return "";
  const { summary, rationale, fields } = challenge.envelope;
  const questions = Array.isArray(fields.questions) ? fields.questions : [];
  return [summary, rationale, ...questions].join("\n").toLowerCase();
}

function briefText(run: DebateRun): string {
  const brief = run.brief;
  return [brief.idea, brief.problem, brief.targetCustomer, brief.solution, brief.businessModel, brief.traction, brief.founderEvidence]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function guard(run: DebateRun, stage: ContributionStage, envelope: RoleEnvelope): string | null {
  if (stage === "assessment" || stage === "rebuttal") {
    const card = envelope.competitor;
    if (!card) return "A Competitor assessment needs a threat scorecard.";
    if (
      card.stance === "COPYABLE_FEATURE" &&
      !`${envelope.summary} ${envelope.rationale} ${card.crushPlan} ${card.verdict}`
        .toLowerCase()
        .includes("feature")
    ) {
      return "COPYABLE_FEATURE must say the submission is a feature.";
    }
    const named = card.incumbent.toLowerCase();
    const supplied = briefText(run).includes(named);
    const labeled = envelope.assumptions.some(
      (claim) =>
        (claim.grounding === "assumption" || claim.grounding === "unknown") &&
        claim.statement.toLowerCase().includes(named),
    );
    if (!supplied && !labeled) {
      return "A named incumbent the brief does not supply must be named in an assumption or unknown claim.";
    }
  }
  if (stage === "rebuttal") {
    const opening = openingScorecard(run);
    const revised = envelope.competitor;
    if (!opening || !revised) return "A Competitor rebuttal needs the recorded opening assessment.";
    const reference = envelope.fields.challengeReference;
    if (typeof reference !== "string" || !reference.trim()) {
      return "The Competitor rebuttal must quote the Red Team challenge it answers.";
    }
    if (!challengeText(run).includes(reference.trim().toLowerCase())) {
      return "The Competitor rebuttal must quote a phrase from the Red Team challenge.";
    }
    const differs =
      revised.threatScore !== opening.threatScore || revised.stance !== opening.stance;
    if (envelope.changed !== differs) {
      return "The Competitor rebuttal's changed flag contradicts its score and stance.";
    }
  }
  if (stage === "founder_response") {
    const current = latestScorecard(run);
    if (current && envelope.positionLabel !== current.competitor.stance) {
      return "A founder response cannot change the Competitor stance.";
    }
    const score = envelope.fields.threatScore;
    if (current && typeof score === "number" && score !== current.competitor.threatScore) {
      return "A founder response cannot change the threat score.";
    }
  }
  return null;
}

function renderCard(card: CompetitorScorecard): string {
  return [
    `COMPETITOR THREAT SCORE: ${card.threatScore}/10`,
    `INCUMBENT I REPRESENT: ${card.incumbent}`,
    `HOW I WOULD CRUSH IT: ${card.crushPlan}`,
    `WHY THEIR MOAT IS WEAK: ${card.weakMoat}`,
    `COPYABILITY RISK: ${card.copyabilityRisk}`,
    `DISTRIBUTION DISADVANTAGE: ${card.distributionDisadvantage}`,
    `WHAT WOULD MAKE THEM DANGEROUS: ${card.dangerousMove}`,
    `FOUNDER QUESTION: ${card.founderQuestion}`,
    `COMPETITOR VERDICT: ${card.verdict}`,
  ].join("\n");
}

function withRenderedCard(raw: string, stage: ContributionStage): string {
  const parsed = parseContribution("competitor", stage, raw);
  if (!parsed.ok || !parsed.value.competitor) return raw;
  let record: unknown;
  try {
    record = parseModelJson(raw);
  } catch {
    return raw;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return raw;
  const card = renderCard(parsed.value.competitor);
  const summary = parsed.value.summary.includes("COMPETITOR THREAT SCORE")
    ? parsed.value.summary
    : `${card}\n\n${parsed.value.summary}`;
  return JSON.stringify({ ...record, summary });
}

function reject(run: DebateRun, error: DebateFailure): DebateResult {
  return { ok: false, error, value: failTurn(run, error) };
}

export async function runCompetitorTurn(
  run: DebateRun,
  client: ModelClient | null,
  registry: RoleRegistry = sharedRegistry,
): Promise<DebateResult> {
  const started = beginTurn(run, "competitor");
  if (!started.ok || !started.value.lock) return started;
  const locked = started.value;
  const stage = locked.lock!.stage;

  const generated = await generateContribution(locked, "competitor", stage, registry, client);
  if (!generated.ok) {
    return reject(locked, {
      code: generated.error.code,
      message: generated.error.message,
      phase: locked.phase,
      role: "competitor",
    });
  }

  const parsed = parseContribution("competitor", stage, generated.raw);
  if (parsed.ok) {
    const problem = guard(locked, stage, parsed.value);
    if (problem) {
      return reject(locked, {
        code: "invalid_response",
        message: problem,
        phase: locked.phase,
        role: "competitor",
      });
    }
    if (parsed.value.decision) {
      return reject(locked, {
        code: "invalid_response",
        message: "The Competitor role cannot return a Chair verdict.",
        phase: locked.phase,
        role: "competitor",
      });
    }
  }
  const raw =
    stage === "assessment" || stage === "rebuttal"
      ? withRenderedCard(generated.raw, stage)
      : generated.raw;
  return completeTurn(locked, raw);
}
