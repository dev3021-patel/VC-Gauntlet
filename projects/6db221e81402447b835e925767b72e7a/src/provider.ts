import {
  createRoleRegistry,
  isSpecialist,
  type ContractError,
  type ContributionStage,
  type RoleId,
  type RoleRegistry,
  SPECIALIST_SCORE_SPECS,
  getPrimaryScore,
} from "./contract";
import { contextSnapshot, renderContext, type DebateRun } from "./debate";

export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export type ProviderStatus =
  | { configured: true; model: string; message: string }
  | { configured: false; model: string; message: string };

export interface ModelClient {
  complete(input: {
    system: string;
    user: string;
    signal?: AbortSignal;
  }): Promise<string>;
}

const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export function providerStatus(env: Record<string, string | undefined> = process.env): ProviderStatus {
  const model = env.GAUNTLET_MODEL?.trim() || DEFAULT_MODEL;
  if (!env.OPENAI_API_KEY?.trim()) {
    return {
      configured: false,
      model,
      message:
        "AI provider is not configured. Set OPENAI_API_KEY on the server. Sample debates are not used.",
    };
  }
  return {
    configured: true,
    model,
    message: "Provider configured. Responses come from the model, not a scripted debate.",
  };
}

export function readProviderConfig(
  env: Record<string, string | undefined> = process.env,
): { ok: true; value: ProviderConfig } | { ok: false; error: ContractError } {
  const status = providerStatus(env);
  if (!status.configured) {
    return {
      ok: false,
      error: { code: "missing_credentials", message: status.message },
    };
  }
  return {
    ok: true,
    value: {
      apiKey: env.OPENAI_API_KEY!.trim(),
      baseUrl: (env.OPENAI_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, ""),
      model: status.model,
    },
  };
}

export function createOpenAiClient(
  config: ProviderConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 45_000,
): ModelClient {
  return {
    async complete({ system, user, signal }) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: config.model,
            temperature: 0.2,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          }),
          signal: combined,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          throw Object.assign(new Error("The AI provider timed out."), { code: "timeout" });
        }
        throw Object.assign(new Error("The AI provider request failed."), {
          code: "provider_failure",
        });
      }
      if (!response.ok) {
        throw Object.assign(new Error("The AI provider returned an error."), {
          code: "provider_failure",
        });
      }
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!content || !content.trim()) {
        throw Object.assign(new Error("The AI provider returned an empty response."), {
          code: "invalid_response",
        });
      }
      return content;
    },
  };
}

const ENVELOPE_INSTRUCTIONS = `Return one JSON object and nothing else.
Required keys: summary, rationale, assumptions, risks, positionLabel, fields.
assumptions is an array of { statement, grounding, evidenceNote? }.
grounding is founder_provided, supported_evidence, assumption, or unknown.
supported_evidence requires evidenceNote. Do not invent citations, URLs, or sources.
risks is a non-empty array of strings.
Do not include citations or sources keys.
Label unsupported market, demand, and competitor claims as assumption or unknown.
VC assessments and rebuttals must set positionLabel to INVEST, MAYBE, or PASS, fields.investmentPosition to that same value, and fields.score to an integer from 0 to 100, plus strongestInvestmentCase, biggestFundabilityRisk, marketSizeConcern, first100Users, defensibilityConcern, killShotQuestion, and oneLineVerdict. first100Users is the distribution question. MAYBE is not Pivot. A founder reply answers the question and does not change the investment position.
Competitor assessments and rebuttals must set positionLabel and fields.stance to NOT_A_THREAT, COPYABLE_FEATURE, or REAL_WEDGE, and fields.threatScore to an integer from 0 to 10, plus incumbent, crushPlan, weakMoat, copyabilityRisk, distributionDisadvantage, dangerousMove, founderQuestion, and verdict. That stance is not a Chair verdict.
Customer assessments and rebuttals must include fields.adoptionScore, an integer from 0 to 10 measuring the likelihood the target customer adopts AND pays, alongside the existing positionLabel and supporting fields.
Engineer assessments and rebuttals must include fields.feasibilityScore, an integer from 0 to 10 measuring buildability, alongside the existing positionLabel and supporting fields.
For Customer and Engineer rebuttals, return the revised score and justify it in rationale and changeReason. When changed is false, retain the opening score. These scores are not Chair verdicts.
Red Team challenges must set fields.targetedRoles and fields.questions to string arrays.
Rebuttals must set changed to a boolean and changeReason to a string, both at the top level of the JSON object. VC and Competitor rebuttals must also set fields.challengeReference to a short phrase copied verbatim, character for character, from the Red Team challenge's summary, rationale, or questions; a rebuttal without fields.challengeReference is invalid.
Only the Chair in stage verdict returns decision: { verdict, decisiveReasons, disagreements, unresolvedRisks, nextSteps, pivotDirection? } with verdict invest, pivot, or pass. Pivot requires pivotDirection. The Chair verdict positionLabel must match that verdict. In verdict_chat, return positionLabel discussion and no decision.`;

const ASSESSMENT_REPORT_INSTRUCTIONS = `Keep the assessment report inside the existing role envelope. Do not add a report key, fields.report, or a separate top-level output structure.
Use rationale as a string containing 2-4 short points, separated by newlines and prefixed with "- ". Explain why the score and position follow from the brief; keep each point to one concrete sentence, like the concise scorecard fields.
Put the single biggest risk first in the existing risks array; keep any remaining risks concise. For the VC, that first risk must agree with fields.biggestFundabilityRisk.
Use the existing assumptions array for labeled claims, with the existing grounding values and evidenceNote rule. Distinguish founder-provided statements from verified evidence, assumptions, and unknowns; never invent facts to fill the card.
Keep summary and all existing role-specific fields. No per-agent report format.`;



/** A retried turn is told why the previous attempt was rejected so the same output is not repeated. */
export function retryHintNote(hint: string | undefined): string {
  const text = hint?.trim();
  if (!text) return "";
  return `PREVIOUS ATTEMPT REJECTED\nYour previous response to this exact request was rejected by the validator with this message: ${text}\nProduce a corrected response that satisfies that rule while still meeting every other requirement.`;
}

/** A founder response may answer but never revise the specialist's recorded position or score. */
function founderResponseRule(run: DebateRun, role: RoleId): string {
  if (!isSpecialist(role)) return "";
  const latest = [...run.messages].reverse().find((item) => item.speaker === role && item.envelope);
  if (!latest?.envelope) return "";
  const { field } = SPECIALIST_SCORE_SPECS[role];
  const scored = [...run.messages].reverse().find((item) => item.speaker === role && item.envelope && getPrimaryScore(item.envelope) !== null);
  const score = scored?.envelope?.fields[field];
  return [
    "FOUNDER RESPONSE RULE",
    `Your recorded position is ${latest.envelope.positionLabel}. positionLabel must be exactly ${latest.envelope.positionLabel}.`,
    score === undefined
      ? `Do not include fields.${field} in this response.`
      : `Either omit fields.${field} or set it to exactly ${JSON.stringify(score)}; any other value is rejected.`,
    "Answer the founder's latest message directly. Do not return changed, changeReason, or decision.",
  ].join("\n");
}

export function buildGenerationPrompt(
  run: DebateRun,
  role: RoleId,
  stage: ContributionStage,
  registry: RoleRegistry,
  appendix = "",
): { ok: true; system: string; user: string } | { ok: false; error: ContractError } {
  const instructions = registry.instructions(role);
  if (!instructions) {
    return {
      ok: false,
      error: {
        code: "role_not_configured",
        message: `${role} has no instructions registered. This foundation session does not invent a debate.`,
      },
    };
  }
  const snapshot = contextSnapshot(run);
  if (isSpecialist(role) && stage === "assessment") snapshot.messages = [];
  const context = renderContext(snapshot);
  const founderRule = isSpecialist(role) && stage === "founder_response" ? founderResponseRule(run, role) : "";
  const retryNote = retryHintNote(run.retryHint);
  return {
    ok: true,
    system: `${instructions}\n\n${ENVELOPE_INSTRUCTIONS}${isSpecialist(role) && stage === "assessment" ? `\n\n${ASSESSMENT_REPORT_INSTRUCTIONS}` : ""}`,
    user: `Role: ${role}\nStage: ${stage}\n\n${context}${appendix.trim() ? `\n\n${appendix.trim()}` : ""}${founderRule ? `\n\n${founderRule}` : ""}${retryNote ? `\n\n${retryNote}` : ""}\n\nRespond only to this brief and the discussion so far.`,
  };
}

export async function generateContribution(
  run: DebateRun,
  role: RoleId,
  stage: ContributionStage,
  registry: RoleRegistry,
  client: ModelClient | null,
  appendix = "",
): Promise<{ ok: true; raw: string } | { ok: false; error: ContractError }> {
  const prompt = buildGenerationPrompt(run, role, stage, registry, appendix);
  if (!prompt.ok) return prompt;
  if (!client) {
    const status = providerStatus();
    return {
      ok: false,
      error: {
        code: "missing_credentials",
        message: status.configured
          ? "No model client was provided."
          : status.message,
      },
    };
  }
  try {
    const raw = await client.complete({ system: prompt.system, user: prompt.user });
    return { ok: true, raw };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: string }).code)
        : "provider_failure";
    const safe =
      code === "timeout" || code === "invalid_response" || code === "provider_failure"
        ? code
        : "provider_failure";
    return {
      ok: false,
      error: {
        code: safe,
        message:
          error instanceof Error && error.message
            ? error.message
            : "The AI provider request failed.",
      },
    };
  }
}

export const sharedRegistry = createRoleRegistry();
