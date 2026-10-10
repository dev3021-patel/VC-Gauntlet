export const VC_ROLE = "vc" as const

export const VC_POSITIONS = ["INVEST", "MAYBE", "PASS"] as const

export const CHAIR_VERDICTS = ["Invest", "Pivot", "Pass"] as const

export type VcPosition = (typeof VC_POSITIONS)[number]

export type ChairVerdict = (typeof CHAIR_VERDICTS)[number]

export type CommitteeRole =
  | "vc"
  | "customer"
  | "competitor"
  | "engineer"
  | "red_team"
  | "chair"
  | "founder"

export type DebateStage =
  | "assessment"
  | "challenge"
  | "rebuttal"
  | "founder_discussion"
  | "verdict"

export type ContributionType =
  | "opening_assessment"
  | "rebuttal"
  | "founder_response"

export type AssumptionStatus = "assumption" | "unknown" | "supported"

export type IdeaBrief = {
  idea: string
  problem: string
  targetCustomer: string
  proposedSolution: string
  businessModel: string
  traction?: string
  evidence?: string
}

export type DebateMessage = {
  id: string
  role: CommitteeRole
  stage: DebateStage
  content: string
}

export type Assumption = {
  claim: string
  status: AssumptionStatus
  basis?: string
}

export type VcAssessment = {
  score: number
  position: VcPosition
  justification: string
  strongestInvestmentCase: string
  biggestFundabilityRisk: string
  first100Users: string
  killShotQuestion: string
  oneLineVerdict: string
}

export type VcRebuttal = {
  challengeReference: string
  positionChanged: boolean
  scoreChanged: boolean
  revisedScore: number
  revisedPosition: VcPosition
  reason: string
  rebuttal: string
  openingAssessment: VcAssessment
}

export type VcFounderResponse = {
  addressesFounder: string
  recommendationChanged: false
  response: string
  position?: VcPosition
  score?: number
}

export type RoleSuccess = {
  ok: true
  role: typeof VC_ROLE
  contributionType: ContributionType
  content: string
  assumptions: Assumption[]
  result: VcAssessment | VcRebuttal | VcFounderResponse
}

export type RoleErrorCode =
  | "invalid_input"
  | "missing_credentials"
  | "timeout"
  | "provider_failure"
  | "invalid_output"

export type RoleFailure = {
  ok: false
  role: typeof VC_ROLE
  recoverable: true
  code: RoleErrorCode
  message: string
}

export type RoleResult = RoleSuccess | RoleFailure

export type CompletionRequest = {
  system: string
  user: string
  timeoutMs?: number
}

export type CompletionProvider = {
  complete(request: CompletionRequest): Promise<string>
}

export function isVcPosition(value: unknown): value is VcPosition {
  return typeof value === "string" && (VC_POSITIONS as readonly string[]).includes(value)
}

export function isChairVerdict(value: unknown): value is ChairVerdict {
  return typeof value === "string" && (CHAIR_VERDICTS as readonly string[]).includes(value)
}
