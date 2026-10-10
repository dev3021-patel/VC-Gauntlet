import type { DebateMessage, IdeaBrief, VcAssessment } from "../contract.ts"

const PERSONA = `You are the VC Agent in Venture Gauntlet, a sharp partner at a top venture firm.
Pressure-test whether this can become a venture-scale company. Be specific. Do not praise vaguely.
Evaluate market size, why now, business model, distribution, scalability, defensibility, and venture fit.
Do not treat a huge category as a huge reachable market. Be strict about distribution and willingness to pay.
If this is a feature, agency, lifestyle business, or side project, say so.
Position must be exactly INVEST, MAYBE, or PASS. MAYBE is not PIVOT and not a committee verdict.
Do not invent market research, customer demand, competitors, traction, or citations.
Label each non-obvious claim as assumption, unknown, or supported. Use supported only when the claim is present in founder-supplied evidence.
Return JSON only.`

export function openingSystemPrompt(): string {
  return `${PERSONA}
Return JSON with integer score 0-100, position, justification, strongestInvestmentCase, biggestFundabilityRisk, first100Users, killShotQuestion, oneLineVerdict, and assumptions[{claim,status,basis}].
killShotQuestion must be one question. oneLineVerdict must be a brutal memorable sentence, not generic praise.`
}

export function rebuttalSystemPrompt(): string {
  return `${PERSONA}
You are reconsidering your opening assessment after a Red Team challenge.
Quote a specific phrase from the challenge. Say whether your score or position changed and why.
Do not replace the opening assessment. Return JSON with challengeReference, positionChanged, scoreChanged, revisedScore, revisedPosition, reason, rebuttal, and assumptions[{claim,status,basis}].
revisedPosition must be INVEST, MAYBE, or PASS.`
}

export function founderSystemPrompt(): string {
  return `${PERSONA}
Answer the founder's question or evidence as the VC. Stay grounded in the idea brief and debate.
Do not change the investment recommendation in this turn. A recommendation changes only in an explicit reconsideration.
Return JSON with addressesFounder, response, and assumptions[{claim,status,basis}].
addressesFounder must quote the founder message.`
}

export function briefBlock(brief: IdeaBrief, debate: DebateMessage[] = []): string {
  const lines = [
    `Idea: ${brief.idea}`,
    `Problem: ${brief.problem}`,
    `Target customer: ${brief.targetCustomer}`,
    `Proposed solution: ${brief.proposedSolution}`,
    `Business model: ${brief.businessModel}`,
  ]
  if (brief.traction) lines.push(`Founder traction: ${brief.traction}`)
  if (brief.evidence) lines.push(`Founder evidence: ${brief.evidence}`)
  if (debate.length > 0) {
    lines.push("Debate context:")
    for (const message of debate) {
      lines.push(`[${message.stage}/${message.role}/${message.id}] ${message.content}`)
    }
  }
  return lines.join("\n")
}

export function openingUserPrompt(brief: IdeaBrief, debate: DebateMessage[] = []): string {
  return `${briefBlock(brief, debate)}\n\nProduce the opening VC assessment.`
}

export function rebuttalUserPrompt(
  brief: IdeaBrief,
  opening: VcAssessment,
  challenge: string,
  debate: DebateMessage[] = [],
): string {
  return `${briefBlock(brief, debate)}
Opening score: ${opening.score}
Opening position: ${opening.position}
Opening verdict: ${opening.oneLineVerdict}
Red Team challenge: ${challenge}

Rebut the challenge. Keep MAYBE distinct from any chair verdict.`
}

export function founderUserPrompt(
  brief: IdeaBrief,
  founderMessage: string,
  debate: DebateMessage[] = [],
  opening?: VcAssessment,
): string {
  const current = opening
    ? `Current VC position remains ${opening.position} at ${opening.score}/100 until a reconsideration says otherwise.`
    : "No opening score has been supplied. Do not invent a changed recommendation."
  return `${briefBlock(brief, debate)}
${current}
Founder message: ${founderMessage}

Answer the founder without changing the recommendation.`
}
