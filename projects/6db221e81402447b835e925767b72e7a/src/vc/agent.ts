import type {
  Assumption,
  CompletionProvider,
  DebateMessage,
  IdeaBrief,
  RoleResult,
  VcAssessment,
  VcFounderResponse,
  VcRebuttal,
} from "../contract.ts"
import { VC_ROLE } from "../contract.ts"
import { RoleRunError, toRoleFailure } from "../errors.ts"
import {
  evidenceCorpus,
  labelAssumptions,
  parseModelJson,
  renderAssessment,
  requireBrief,
  requireOverlap,
  requirePosition,
  requireQuestion,
  requireScore,
  requireText,
  stripCitations,
} from "../parse.ts"
import { createServerProvider } from "../provider.ts"
import {
  founderSystemPrompt,
  founderUserPrompt,
  openingSystemPrompt,
  openingUserPrompt,
  rebuttalSystemPrompt,
  rebuttalUserPrompt,
} from "./prompt.ts"

type RunOptions = {
  brief: IdeaBrief
  debate?: DebateMessage[]
  provider?: CompletionProvider
  env?: NodeJS.ProcessEnv
}

function resolveProvider(provider: CompletionProvider | undefined, env: NodeJS.ProcessEnv | undefined): CompletionProvider {
  return provider ?? createServerProvider(env ?? process.env)
}

function cleanAssessment(raw: Record<string, unknown>, corpus: string): { assessment: VcAssessment; assumptions: Assumption[] } {
  const assessment: VcAssessment = {
    score: requireScore(raw.score),
    position: requirePosition(raw.position),
    justification: requireText(raw.justification, "justification"),
    strongestInvestmentCase: requireText(raw.strongestInvestmentCase, "strongestInvestmentCase"),
    biggestFundabilityRisk: requireText(raw.biggestFundabilityRisk, "biggestFundabilityRisk"),
    first100Users: requireText(raw.first100Users, "first100Users"),
    killShotQuestion: requireQuestion(raw.killShotQuestion),
    oneLineVerdict: requireText(raw.oneLineVerdict, "oneLineVerdict"),
  }
  return { assessment, assumptions: labelAssumptions(raw.assumptions, corpus) }
}

export async function runVcOpening(options: RunOptions): Promise<RoleResult> {
  try {
    requireBrief(options.brief)
    const provider = resolveProvider(options.provider, options.env)
    const raw = parseModelJson(
      await provider.complete({
        system: openingSystemPrompt(),
        user: openingUserPrompt(options.brief, options.debate),
      }),
    )
    const { assessment, assumptions } = cleanAssessment(raw, evidenceCorpus(options.brief, options.debate))
    return {
      ok: true,
      role: VC_ROLE,
      contributionType: "opening_assessment",
      content: renderAssessment(assessment),
      assumptions,
      result: assessment,
    }
  } catch (error) {
    return toRoleFailure(error)
  }
}

export async function runVcRebuttal(
  options: RunOptions & { opening: VcAssessment; challenge: string },
): Promise<RoleResult> {
  try {
    requireBrief(options.brief)
    if (typeof options.challenge !== "string" || options.challenge.trim().length < 8) {
      throw new RoleRunError(
        "invalid_input",
        "A Red Team challenge is required before the VC Agent can reconsider.",
      )
    }
    const provider = resolveProvider(options.provider, options.env)
    const raw = parseModelJson(
      await provider.complete({
        system: rebuttalSystemPrompt(),
        user: rebuttalUserPrompt(options.brief, options.opening, options.challenge, options.debate),
      }),
    )
    const revisedScore = requireScore(raw.revisedScore)
    const revisedPosition = requirePosition(raw.revisedPosition)
    const reason = requireText(raw.reason, "reason")
    const rebuttal = requireText(raw.rebuttal, "rebuttal")
    const challengeReference = requireOverlap(
      `${String(raw.challengeReference ?? "")} ${rebuttal}`,
      options.challenge,
      "Red Team challenge",
    )
    const scoreChanged = revisedScore !== options.opening.score
    const positionChanged = revisedPosition !== options.opening.position
    const result: VcRebuttal = {
      challengeReference,
      positionChanged,
      scoreChanged,
      revisedScore,
      revisedPosition,
      reason,
      rebuttal,
      openingAssessment: structuredClone(options.opening),
    }
    const assumptions = labelAssumptions(raw.assumptions, evidenceCorpus(options.brief, options.debate))
    return {
      ok: true,
      role: VC_ROLE,
      contributionType: "rebuttal",
      content: [
        `CHALLENGE ADDRESSED: ${challengeReference}`,
        `POSITION CHANGED: ${positionChanged ? "YES" : "NO"}`,
        `SCORE CHANGED: ${scoreChanged ? "YES" : "NO"}`,
        `REVISED POSITION: ${revisedPosition}`,
        `REVISED SCORE: ${revisedScore}/100`,
        `WHY: ${reason}`,
        rebuttal,
      ].join("\n"),
      assumptions,
      result,
    }
  } catch (error) {
    return toRoleFailure(error)
  }
}

export async function runVcFounderResponse(
  options: RunOptions & { founderMessage: string; opening?: VcAssessment },
): Promise<RoleResult> {
  try {
    requireBrief(options.brief)
    if (typeof options.founderMessage !== "string" || options.founderMessage.trim().length < 8) {
      throw new RoleRunError(
        "invalid_input",
        "A founder question or evidence update is required.",
      )
    }
    const provider = resolveProvider(options.provider, options.env)
    const raw = parseModelJson(
      await provider.complete({
        system: founderSystemPrompt(),
        user: founderUserPrompt(options.brief, options.founderMessage, options.debate, options.opening),
      }),
    )
    const response = stripCitations(requireText(raw.response, "response"))
    const addressesFounder = requireOverlap(
      `${String(raw.addressesFounder ?? "")} ${response}`,
      options.founderMessage,
      "founder message",
    )
    if (!response.toLowerCase().includes(options.brief.idea.toLowerCase().slice(0, Math.min(12, options.brief.idea.length)))) {
      const ideaToken = options.brief.idea.toLowerCase().split(/\W+/).find((word) => word.length > 3)
      if (!ideaToken || !response.toLowerCase().includes(ideaToken)) {
        throw new RoleRunError(
          "invalid_output",
          "The AI provider did not ground its reply in the idea brief. Retry this VC turn.",
        )
      }
    }
    const result: VcFounderResponse = {
      addressesFounder,
      recommendationChanged: false,
      response,
      ...(options.opening
        ? { position: options.opening.position, score: options.opening.score }
        : {}),
    }
    return {
      ok: true,
      role: VC_ROLE,
      contributionType: "founder_response",
      content: [
        `FOUNDER POINT: ${addressesFounder}`,
        "RECOMMENDATION CHANGED: NO",
        response,
        options.opening
          ? `UNCHANGED POSITION: ${options.opening.position} ${options.opening.score}/100`
          : "UNCHANGED POSITION: not revised in founder discussion",
      ].join("\n"),
      assumptions: labelAssumptions(raw.assumptions, evidenceCorpus(options.brief, options.debate)),
      result,
    }
  } catch (error) {
    return toRoleFailure(error)
  }
}

