import type { Assumption, AssumptionStatus, DebateMessage, IdeaBrief, VcPosition } from "./contract.ts"
import { isVcPosition } from "./contract.ts"
import { RoleRunError } from "./errors.ts"

const CITATION_PATTERN =
  /https?:\/\/\S+|www\.\S+|\bdoi:\s*\S+|\[\d+\]|\(\s*source:[^)]*\)|\bsource:\s*[^\s,;]+/gi

const REQUIRED_BRIEF_FIELDS = [
  "idea",
  "problem",
  "targetCustomer",
  "proposedSolution",
  "businessModel",
] as const

export function requireBrief(brief: IdeaBrief): void {
  for (const field of REQUIRED_BRIEF_FIELDS) {
    if (typeof brief?.[field] !== "string" || brief[field].trim() === "") {
      throw new RoleRunError(
        "invalid_input",
        `Idea brief is missing ${field}. Provide the startup idea, problem, target customer, proposed solution, and business model.`,
      )
    }
  }
}

export function parseModelJson(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start === -1 || end <= start) {
    throw new RoleRunError("invalid_output", "The AI provider did not return a JSON object. Retry this VC turn.")
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object")
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new RoleRunError("invalid_output", "The AI provider returned invalid JSON. Retry this VC turn.")
  }
}

export function requireText(value: unknown, field: string, min = 12): string {
  if (typeof value !== "string") {
    throw new RoleRunError("invalid_output", `The AI provider omitted ${field}. Retry this VC turn.`)
  }
  const cleaned = stripCitations(value).replace(/\s+/g, " ").trim()
  if (cleaned.length < min) {
    throw new RoleRunError("invalid_output", `The AI provider returned an unusable ${field}. Retry this VC turn.`)
  }
  return cleaned
}

export function requireScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new RoleRunError(
      "invalid_output",
      "The AI provider returned a VC score outside the integer range 0 through 100. Retry this VC turn.",
    )
  }
  return value
}

export function requirePosition(value: unknown): VcPosition {
  if (!isVcPosition(value)) {
    throw new RoleRunError(
      "invalid_output",
      "The AI provider returned a position other than INVEST, MAYBE, or PASS. Retry this VC turn.",
    )
  }
  return value
}

export function requireQuestion(value: unknown): string {
  const text = requireText(value, "killShotQuestion")
  if (!text.includes("?")) {
    throw new RoleRunError("invalid_output", "The AI provider did not return a kill-shot question. Retry this VC turn.")
  }
  return text
}

export function stripCitations(value: string): string {
  return value.replace(CITATION_PATTERN, "").replace(/\s{2,}/g, " ").trim()
}

export function evidenceCorpus(brief: IdeaBrief, debate: DebateMessage[] = []): string {
  return [
    brief.idea,
    brief.problem,
    brief.targetCustomer,
    brief.proposedSolution,
    brief.businessModel,
    brief.traction ?? "",
    brief.evidence ?? "",
    ...debate.filter((message) => message.role === "founder").map((message) => message.content),
  ]
    .join("\n")
    .toLowerCase()
}

export function labelAssumptions(
  value: unknown,
  corpus: string,
): Assumption[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RoleRunError(
      "invalid_output",
      "The AI provider did not label assumptions or unknowns. Retry this VC turn.",
    )
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object") {
      throw new RoleRunError("invalid_output", "The AI provider returned a malformed assumption. Retry this VC turn.")
    }
    const record = entry as Record<string, unknown>
    const claim = requireText(record.claim, `assumptions[${index}].claim`, 8)
    const status = normalizeStatus(record.status, claim, corpus)
    const basis = typeof record.basis === "string" ? stripCitations(record.basis) : undefined
    return basis ? { claim, status, basis } : { claim, status }
  })
}

function normalizeStatus(value: unknown, claim: string, corpus: string): AssumptionStatus {
  if (value !== "assumption" && value !== "unknown" && value !== "supported") {
    throw new RoleRunError("invalid_output", "The AI provider used an unknown assumption status. Retry this VC turn.")
  }
  if (value === "supported" && !claimSupported(claim, corpus)) {
    return "assumption"
  }
  return value
}

function claimSupported(claim: string, corpus: string): boolean {
  const words = claim.toLowerCase().split(/\W+/).filter((word) => word.length > 3)
  if (words.length === 0) return corpus.includes(claim.toLowerCase())
  const hits = words.filter((word) => corpus.includes(word)).length
  return hits / words.length >= 0.6
}

export function requireOverlap(text: string, source: string, field: string): string {
  const quote = longestSharedSlice(text, source)
  if (quote.length < 8) {
    throw new RoleRunError(
      "invalid_output",
      `The AI provider did not address the supplied ${field}. Retry this VC turn.`,
    )
  }
  return quote
}

function longestSharedSlice(text: string, source: string): string {
  const haystack = text.toLowerCase()
  const needle = source.toLowerCase()
  let best = ""
  const window = Math.min(80, needle.length)
  for (let size = window; size >= 8; size -= 1) {
    for (let index = 0; index + size <= needle.length; index += 1) {
      const slice = needle.slice(index, index + size)
      if (haystack.includes(slice) && slice.length > best.length) {
        best = source.slice(index, index + size).trim()
        return best
      }
    }
  }
  return best
}

export function renderAssessment(assessment: {
  score: number
  position: VcPosition
  justification: string
  strongestInvestmentCase: string
  biggestFundabilityRisk: string
  first100Users: string
  killShotQuestion: string
  oneLineVerdict: string
}): string {
  return [
    `VC SCORE: ${assessment.score}/100`,
    "",
    `INVESTMENT POSITION: ${assessment.position}`,
    "",
    "STRONGEST INVESTMENT CASE:",
    assessment.strongestInvestmentCase,
    "",
    "BIGGEST FUNDABILITY RISK:",
    assessment.biggestFundabilityRisk,
    "",
    "FIRST 100 USERS:",
    assessment.first100Users,
    "",
    "KILL-SHOT QUESTION:",
    assessment.killShotQuestion,
    "",
    "ONE-LINE VC VERDICT:",
    assessment.oneLineVerdict,
    "",
    "JUSTIFICATION:",
    assessment.justification,
  ].join("\n")
}
