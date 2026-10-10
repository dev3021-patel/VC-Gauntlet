import {
  createRoleRegistry,
  type ContractError,
  type ContributionStage,
  type RoleId,
  type RoleRegistry,
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

const DEFAULT_MODEL = "gpt-4o-mini";
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
            temperature: 0.4,
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
VC assessments and rebuttals must set positionLabel to INVEST, MAYBE, or PASS and fields.score to an integer from 0 to 100, plus strongestInvestmentCase, biggestFundabilityRisk, marketSizeConcern, first100Users, defensibilityConcern, killShotQuestion, and oneLineVerdict. first100Users is the distribution question. MAYBE is not Pivot. A founder reply answers the question and does not change the investment position.
Red Team challenges must set fields.targetedRoles and fields.questions to string arrays.
Rebuttals must set changed to a boolean and changeReason to a string.
Only the Chair returns decision: { verdict, decisiveReasons, disagreements, unresolvedRisks, nextSteps, pivotDirection? } with verdict invest, pivot, or pass. Pivot requires pivotDirection. The Chair positionLabel must match that verdict.`;

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
  const context = renderContext(contextSnapshot(run));
  return {
    ok: true,
    system: `${instructions}\n\n${ENVELOPE_INSTRUCTIONS}`,
    user: `Role: ${role}\nStage: ${stage}\n\n${context}${appendix.trim() ? `\n\n${appendix.trim()}` : ""}\n\nRespond only to this brief and the discussion so far.`,
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
