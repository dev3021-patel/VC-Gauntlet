export const SCHEMA_VERSION = 1 as const;

export const ROLE_IDS = [
  "vc",
  "customer",
  "competitor",
  "engineer",
  "red_team",
  "chair",
] as const;

export type RoleId = (typeof ROLE_IDS)[number];

export const SPECIALIST_ROLES = [
  "vc",
  "customer",
  "competitor",
  "engineer",
] as const;

export type SpecialistRole = (typeof SPECIALIST_ROLES)[number];

export const CONTRIBUTION_STAGES = [
  "assessment",
  "challenge",
  "rebuttal",
  "founder_response",
  "verdict",
] as const;

export type ContributionStage = (typeof CONTRIBUTION_STAGES)[number];

export const VC_POSITIONS = ["INVEST", "MAYBE", "PASS"] as const;
export type VcPosition = (typeof VC_POSITIONS)[number];

export const COMPETITOR_STANCES = ["NOT_A_THREAT", "COPYABLE_FEATURE", "REAL_WEDGE"] as const;
export type CompetitorStance = (typeof COMPETITOR_STANCES)[number];

export const CHAIR_VERDICTS = ["invest", "pivot", "pass"] as const;
export type ChairVerdict = (typeof CHAIR_VERDICTS)[number];

export const GROUNDINGS = [
  "founder_provided",
  "supported_evidence",
  "assumption",
  "unknown",
] as const;

export type Grounding = (typeof GROUNDINGS)[number];

export interface Claim {
  statement: string;
  grounding: Grounding;
  evidenceNote?: string;
}

export type FieldValue = string | number | boolean | string[];
export type RoleFields = Record<string, FieldValue>;

export interface ChairDecision {
  verdict: ChairVerdict;
  decisiveReasons: string[];
  disagreements: string[];
  unresolvedRisks: string[];
  nextSteps: string[];
  pivotDirection?: string;
}

export interface VcScorecard {
  score: number;
  investmentPosition: VcPosition;
  strongestInvestmentCase: string;
  biggestFundabilityRisk: string;
  marketSizeConcern: string;
  first100Users: string;
  defensibilityConcern: string;
  killShotQuestion: string;
  oneLineVerdict: string;
}

export interface CompetitorScorecard {
  threatScore: number;
  stance: CompetitorStance;
  incumbent: string;
  crushPlan: string;
  weakMoat: string;
  copyabilityRisk: string;
  distributionDisadvantage: string;
  dangerousMove: string;
  founderQuestion: string;
  verdict: string;
}

export interface RoleEnvelope {
  schemaVersion: typeof SCHEMA_VERSION;
  role: RoleId;
  stage: ContributionStage;
  summary: string;
  rationale: string;
  assumptions: Claim[];
  risks: string[];
  positionLabel: string;
  changed: boolean | null;
  changeReason: string | null;
  fields: RoleFields;
  decision: ChairDecision | null;
  vc: VcScorecard | null;
  competitor: CompetitorScorecard | null;
}

export interface RoleSlot {
  id: RoleId;
  label: string;
  mandate: string;
}

export const ROLE_SLOTS: readonly RoleSlot[] = [
  {
    id: "vc",
    label: "VC",
    mandate: "Evaluate venture-scale business potential.",
  },
  {
    id: "customer",
    label: "Customer",
    mandate: "Evaluate whether the target customer would adopt this.",
  },
  {
    id: "competitor",
    label: "Competitor",
    mandate: "Attack the submitted idea as the strongest incumbent.",
  },
  {
    id: "engineer",
    label: "Engineer",
    mandate: "Evaluate feasibility and build complexity.",
  },
  {
    id: "red_team",
    label: "Red Team",
    mandate: "Challenge specific arguments from the opening assessments.",
  },
  {
    id: "chair",
    label: "Committee Chair",
    mandate: "Synthesize the debate into Invest, Pivot, or Pass.",
  },
];

export interface ContractError {
  code:
    | "invalid_response"
    | "role_not_configured"
    | "missing_credentials"
    | "provider_failure"
    | "timeout";
  message: string;
}

export type ParseResult =
  | { ok: true; value: RoleEnvelope }
  | { ok: false; error: ContractError };

export interface RoleRegistry {
  instructions(role: RoleId): string | null;
  register(role: RoleId, instructions: string): void;
}

export function createRoleRegistry(
  initial: Partial<Record<RoleId, string>> = {},
): RoleRegistry {
  const stored = new Map<RoleId, string>();
  for (const role of ROLE_IDS) {
    const text = initial[role];
    if (text && text.trim()) stored.set(role, text.trim());
  }
  return {
    instructions(role) {
      return stored.get(role) ?? null;
    },
    register(role, instructions) {
      const text = instructions.trim();
      if (!text) {
        throw new Error("Role instructions cannot be empty.");
      }
      stored.set(role, text);
    },
  };
}

export function isSpecialist(role: RoleId): role is SpecialistRole {
  return (SPECIALIST_ROLES as readonly string[]).includes(role);
}

export function isChairVerdict(value: string): value is ChairVerdict {
  return (CHAIR_VERDICTS as readonly string[]).includes(value);
}

export function isVcPosition(value: string): value is VcPosition {
  return (VC_POSITIONS as readonly string[]).includes(value);
}

export function isCompetitorStance(value: string): value is CompetitorStance {
  return (COMPETITOR_STANCES as readonly string[]).includes(value);
}

export function chairVerdictFromVcPosition(_position: VcPosition): null {
  return null;
}

function invalid(message: string): ParseResult {
  return { ok: false, error: { code: "invalid_response", message } };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const items = value.map((item) => (typeof item === "string" ? item.trim() : ""));
  if (items.some((item) => !item)) return null;
  return items;
}

function parseClaims(value: unknown): Claim[] | null {
  if (!Array.isArray(value)) return null;
  const claims: Claim[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) return null;
    const statement = requiredString(record, "statement");
    const grounding = record.grounding;
    if (!statement || typeof grounding !== "string") return null;
    if (!(GROUNDINGS as readonly string[]).includes(grounding)) return null;
    const evidenceNote =
      typeof record.evidenceNote === "string" ? record.evidenceNote.trim() : "";
    if (grounding === "supported_evidence" && !evidenceNote) return null;
    if (
      (grounding === "assumption" || grounding === "unknown") &&
      /https?:\/\//i.test(statement)
    ) {
      return null;
    }
    claims.push({
      statement,
      grounding: grounding as Grounding,
      ...(evidenceNote ? { evidenceNote } : {}),
    });
  }
  return claims;
}

function parseFields(value: unknown): RoleFields | null {
  const record = asRecord(value);
  if (!record) return null;
  if ("citations" in record || "sources" in record) return null;
  const fields: RoleFields = {};
  for (const [key, field] of Object.entries(record)) {
    if (typeof field === "string" || typeof field === "number" || typeof field === "boolean") {
      fields[key] = field;
      continue;
    }
    if (Array.isArray(field) && field.every((item) => typeof item === "string")) {
      fields[key] = field.map((item) => item.trim()).filter(Boolean);
      continue;
    }
    return null;
  }
  return fields;
}

function parseVc(fields: RoleFields, positionLabel: string): VcScorecard | null {
  const score = fields.score;
  const investmentPosition = fields.investmentPosition;
  if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100) {
    return null;
  }
  if (typeof investmentPosition !== "string" || !isVcPosition(investmentPosition)) {
    return null;
  }
  if (positionLabel !== investmentPosition) return null;
  const strongestInvestmentCase = fields.strongestInvestmentCase;
  const biggestFundabilityRisk = fields.biggestFundabilityRisk;
  const marketSizeConcern = fields.marketSizeConcern;
  const first100Users = fields.first100Users;
  const defensibilityConcern = fields.defensibilityConcern;
  const killShotQuestion = fields.killShotQuestion;
  const oneLineVerdict = fields.oneLineVerdict;
  if (
    typeof strongestInvestmentCase !== "string" ||
    typeof biggestFundabilityRisk !== "string" ||
    typeof marketSizeConcern !== "string" ||
    typeof first100Users !== "string" ||
    typeof defensibilityConcern !== "string" ||
    typeof killShotQuestion !== "string" ||
    typeof oneLineVerdict !== "string"
  ) {
    return null;
  }
  if (
    !strongestInvestmentCase.trim() ||
    !biggestFundabilityRisk.trim() ||
    !marketSizeConcern.trim() ||
    !first100Users.trim() ||
    !defensibilityConcern.trim() ||
    !killShotQuestion.trim() ||
    !oneLineVerdict.trim()
  ) {
    return null;
  }
  return {
    score,
    investmentPosition,
    strongestInvestmentCase: strongestInvestmentCase.trim(),
    biggestFundabilityRisk: biggestFundabilityRisk.trim(),
    marketSizeConcern: marketSizeConcern.trim(),
    first100Users: first100Users.trim(),
    defensibilityConcern: defensibilityConcern.trim(),
    killShotQuestion: killShotQuestion.trim(),
    oneLineVerdict: oneLineVerdict.trim(),
  };
}

function requiredField(fields: RoleFields, key: string): string | null {
  const value = fields[key];
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}

function parseCompetitor(fields: RoleFields, positionLabel: string): CompetitorScorecard | null {
  const threatScore = fields.threatScore;
  const stance = fields.stance;
  if (
    typeof threatScore !== "number" ||
    !Number.isInteger(threatScore) ||
    threatScore < 0 ||
    threatScore > 10
  ) {
    return null;
  }
  if (typeof stance !== "string" || !isCompetitorStance(stance) || positionLabel !== stance) {
    return null;
  }
  const incumbent = requiredField(fields, "incumbent");
  const crushPlan = requiredField(fields, "crushPlan");
  const weakMoat = requiredField(fields, "weakMoat");
  const copyabilityRisk = requiredField(fields, "copyabilityRisk");
  const distributionDisadvantage = requiredField(fields, "distributionDisadvantage");
  const dangerousMove = requiredField(fields, "dangerousMove");
  const founderQuestion = requiredField(fields, "founderQuestion");
  const verdict = requiredField(fields, "verdict");
  if (
    !incumbent ||
    !crushPlan ||
    !weakMoat ||
    !copyabilityRisk ||
    !distributionDisadvantage ||
    !dangerousMove ||
    !founderQuestion ||
    !verdict ||
    !founderQuestion.includes("?")
  ) {
    return null;
  }
  return {
    threatScore,
    stance,
    incumbent,
    crushPlan,
    weakMoat,
    copyabilityRisk,
    distributionDisadvantage,
    dangerousMove,
    founderQuestion,
    verdict,
  };
}

function parseDecision(record: Record<string, unknown>): ChairDecision | null {
  const verdict = record.verdict;
  if (typeof verdict !== "string" || !isChairVerdict(verdict)) return null;
  const decisiveReasons = stringList(record.decisiveReasons);
  const disagreements = stringList(record.disagreements);
  const unresolvedRisks = stringList(record.unresolvedRisks);
  const nextSteps = stringList(record.nextSteps);
  if (!decisiveReasons || !disagreements || !unresolvedRisks || !nextSteps) return null;
  const pivotDirection =
    typeof record.pivotDirection === "string" ? record.pivotDirection.trim() : "";
  if (verdict === "pivot" && !pivotDirection) return null;
  if (verdict !== "pivot" && pivotDirection) return null;
  return {
    verdict,
    decisiveReasons,
    disagreements,
    unresolvedRisks,
    nextSteps,
    ...(verdict === "pivot" ? { pivotDirection } : {}),
  };
}

export function parseModelJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

export function parseContribution(
  role: RoleId,
  stage: ContributionStage,
  raw: string,
): ParseResult {
  let parsed: unknown;
  try {
    parsed = parseModelJson(raw);
  } catch {
    return invalid("The model response was not valid JSON.");
  }
  const record = asRecord(parsed);
  if (!record) return invalid("The model response must be a JSON object.");
  if ("citations" in record || "sources" in record) {
    return invalid("Generated citations are not accepted in this release.");
  }
  const summary = requiredString(record, "summary");
  const rationale = requiredString(record, "rationale");
  const positionLabel = requiredString(record, "positionLabel");
  const assumptions = parseClaims(record.assumptions);
  const risks = stringList(record.risks);
  const fields = parseFields(record.fields ?? {});
  if (!summary || !rationale || !positionLabel || !assumptions || !risks || !fields) {
    return invalid("The response is missing required envelope fields.");
  }
  if (isChairVerdict(positionLabel) && role !== "chair") {
    return invalid("Only the Chair may use an Invest, Pivot, or Pass verdict label.");
  }
  if (role !== "chair" && positionLabel.toLowerCase() === "pivot") {
    return invalid("Pivot is a Chair verdict, not a specialist position.");
  }

  let changed: boolean | null = null;
  let changeReason: string | null = null;
  if (stage === "rebuttal") {
    if (typeof record.changed !== "boolean") {
      return invalid("A rebuttal must state whether the recommendation changed.");
    }
    changed = record.changed;
    changeReason = requiredString(record, "changeReason");
    if (!changeReason) {
      return invalid("A rebuttal must explain why the recommendation changed or held.");
    }
  }

  let decision: ChairDecision | null = null;
  let vc: VcScorecard | null = null;
  let competitor: CompetitorScorecard | null = null;
  if (role === "chair") {
    if (stage !== "verdict") return invalid("The Chair only speaks at the verdict.");
    const decisionRecord = asRecord(record.decision);
    if (!decisionRecord) return invalid("The Chair response is missing a decision.");
    decision = parseDecision(decisionRecord);
    if (!decision) return invalid("The Chair decision is incomplete.");
    if (positionLabel.toLowerCase() !== decision.verdict) {
      return invalid("The Chair position label must match the verdict.");
    }
  } else if (record.decision != null) {
    return invalid("Only the Chair may return a final verdict.");
  }

  if (role === "vc" && (stage === "assessment" || stage === "rebuttal")) {
    vc = parseVc(fields, positionLabel);
    if (!vc) {
      return invalid(
        "VC responses require a 0-100 score, INVEST, MAYBE, or PASS, plus market size, distribution, and defensibility. MAYBE is not Pivot.",
      );
    }
  }

  if (role === "competitor" && (stage === "assessment" || stage === "rebuttal")) {
    competitor = parseCompetitor(fields, positionLabel);
    if (!competitor) {
      return invalid(
        "Competitor responses require a 0-10 threat score and NOT_A_THREAT, COPYABLE_FEATURE, or REAL_WEDGE.",
      );
    }
  }

  if (role === "red_team" && stage === "challenge") {
    const targeted = fields.targetedRoles;
    const questions = fields.questions;
    if (!Array.isArray(targeted) || targeted.length === 0) {
      return invalid("Red Team must name the roles it is challenging.");
    }
    if (!Array.isArray(questions) || questions.length === 0) {
      return invalid("Red Team must ask targeted questions.");
    }
  }

  return {
    ok: true,
    value: {
      schemaVersion: SCHEMA_VERSION,
      role,
      stage,
      summary,
      rationale,
      assumptions,
      risks,
      positionLabel,
      changed,
      changeReason,
      fields,
      decision,
      vc,
      competitor,
    },
  };
}
