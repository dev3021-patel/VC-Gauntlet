import {
  parseContribution,
  type ContributionStage,
  type RoleEnvelope,
  type RoleRegistry,
  type VcScorecard,
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

export const VC_INSTRUCTIONS = `You are the VC Agent in Venture Gauntlet: a sharp partner at a top venture firm who has seen hundreds of pitches. You are skeptical but fair. Your core question: could this realistically become a venture-scale company? Pressure-test the idea. Be specific, never generic. No vague praise.

Evaluate: market size (do not treat a huge category as a huge reachable market), why now, business model (who pays, how much, recurring or not), distribution (be strict about the first 100 users and willingness to pay), scalability, defensibility, and venture fit. If it is a feature, agency, lifestyle business, or side project, say so. If it works as a small business but not a venture one, say that.

Grounding: treat founder input as provided context. Label every unsupported market, customer, competitor, and traction claim as assumption or unknown. Never invent market research, demand, competitors, traction, citations, or URLs.

Opening assessment (stage assessment):
- fields.score is an integer 0-100 and positionLabel plus fields.investmentPosition is exactly INVEST, MAYBE, or PASS. MAYBE is your own position, never a synonym for the Chair's Pivot.
- rationale justifies the score and the position in a few sharp sentences.
- strongestInvestmentCase is one sharp reason this could become big. biggestFundabilityRisk is the main reason it may not be venture-backable. first100Users is a realistic channel plan. killShotQuestion is one question the founder must answer before you invest. oneLineVerdict is a brutal, memorable sentence.

Rebuttal (stage rebuttal), after the Red Team challenge:
- Copy one phrase verbatim from the Red Team challenge into fields.challengeReference, then answer it directly.
- Return the full scorecard fields again. Set changed to true only if your score or position differs from your opening; set changed to false if both are identical. changeReason says why. If a challenge proved an assumption weak, admit it and revise the score.

Founder response (stage founder_response):
- Answer the founder's question or evidence from the brief and the discussion so far, in a few sharp sentences.
- Do not change your recommendation here. Set positionLabel to your current position and do not return a decision. Added evidence changes your recommendation only in a later explicit reconsideration.

You never return a final committee verdict.`;

export function registerVcAgent(registry: RoleRegistry = sharedRegistry): void {
  registry.register("vc", VC_INSTRUCTIONS);
}

function latestScorecard(run: DebateRun): { stage: ContributionStage; vc: VcScorecard } | null {
  for (let i = run.messages.length - 1; i >= 0; i -= 1) {
    const message = run.messages[i];
    if (message.speaker === "vc" && message.envelope?.vc) {
      return { stage: message.stage as ContributionStage, vc: message.envelope.vc };
    }
  }
  return null;
}

function openingScorecard(run: DebateRun): VcScorecard | null {
  const opening = run.messages.find(
    (message) => message.speaker === "vc" && message.stage === "assessment",
  );
  return opening?.envelope?.vc ?? null;
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

function guard(run: DebateRun, stage: ContributionStage, envelope: RoleEnvelope): string | null {
  if (stage === "rebuttal") {
    const opening = openingScorecard(run);
    const revised = envelope.vc;
    if (!opening || !revised) return "A VC rebuttal needs the recorded opening assessment.";
    const reference = envelope.fields.challengeReference;
    if (typeof reference !== "string" || !reference.trim()) {
      return "The VC rebuttal must quote the Red Team challenge it answers.";
    }
    if (!challengeText(run).includes(reference.trim().toLowerCase())) {
      return "The VC rebuttal must quote a phrase from the Red Team challenge.";
    }
    const differs =
      revised.score !== opening.score ||
      revised.investmentPosition !== opening.investmentPosition;
    if (envelope.changed !== differs) {
      return "The VC rebuttal's changed flag contradicts its score and position.";
    }
  }
  if (stage === "founder_response") {
    const current = latestScorecard(run);
    if (current && envelope.positionLabel !== current.vc.investmentPosition) {
      return "A founder response cannot change the VC recommendation.";
    }
  }
  return null;
}

function reject(run: DebateRun, error: DebateFailure): DebateResult {
  return { ok: false, error, value: failTurn(run, error) };
}

/**
 * Runs one VC turn for the run's current phase: assessment, rebuttal, or
 * founder response. Real generation only; failures leave the run retryable
 * and never record a substitute contribution.
 */
export async function runVcTurn(
  run: DebateRun,
  client: ModelClient | null,
  registry: RoleRegistry = sharedRegistry,
): Promise<DebateResult> {
  const started = beginTurn(run, "vc");
  if (!started.ok || !started.value.lock) return started;
  const locked = started.value;
  const stage = locked.lock!.stage;

  const generated = await generateContribution(locked, "vc", stage, registry, client);
  if (!generated.ok) {
    return reject(locked, {
      code: generated.error.code,
      message: generated.error.message,
      phase: locked.phase,
      role: "vc",
    });
  }

  const parsed = parseContribution("vc", stage, generated.raw);
  if (parsed.ok) {
    const problem = guard(locked, stage, parsed.value);
    if (problem) {
      return reject(locked, {
        code: "invalid_response",
        message: problem,
        phase: locked.phase,
        role: "vc",
      });
    }
  }
  return completeTurn(locked, generated.raw);
}
