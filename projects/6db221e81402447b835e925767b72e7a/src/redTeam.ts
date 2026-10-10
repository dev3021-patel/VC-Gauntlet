import type { IdeaBrief } from "./brief";
import {
  SPECIALIST_ROLES,
  isSpecialist,
  parseContribution,
  type ContractError,
  type RoleRegistry,
  type SpecialistRole,
} from "./contract";
import {
  beginTurn,
  completeTurn,
  contextSnapshot,
  failTurn,
  type DebateMessage,
  type DebateResult,
  type DebateRun,
} from "./debate";
import { buildGenerationPrompt, sharedRegistry, type ModelClient } from "./provider";

export const RED_TEAM_INSTRUCTIONS = `You are the Red Team in Venture Gauntlet. You do not pitch the startup and you do not issue GO, PIVOT, or KILL. You review the other agents' reasoning: unsupported assumptions, contradictions, weak evidence, over-optimism, and unsupported pessimism.

Use only the founder brief, the SOURCE CONTRIBUTIONS block, and any founder defense in this request. Do not fetch conversations. Do not carry claims from a previous idea. Do not invent missing agents, scores, quotes, contradictions, stronger claims, or evidence to fill a slot.

A simulated or hypothetical customer is not observed willingness to pay. Ability to copy or ship a feature is not proof of displacement. Two agents repeating one sentence are not independent confirmation. An unsourced market size or payment claim is not supported evidence. If founder defense supplies a fact, do not say that fact is absent.

Return JSON with summary, rationale, assumptions, risks, positionLabel, and fields. summary is one sentence. If any specialist assessment is missing, summary must name each missing role and include the phrase "not a complete committee review". If all four assessments are present, do not use that phrase. positionLabel is "challenge" when the review is complete and "partial" when it is not. Never use invest, pivot, or pass. Never return decision, verdict, citations, sources, replacementScore, revisedScore, or newScore. Do not use the old labels BIGGEST CONTRADICTION, MOST IMPORTANT UNANSWERED QUESTION, or WHO SHOULD REVISE.

fields.reasoningQuality is exactly STRONG, MEDIUM, or WEAK.
fields.biggestAssumptionSource is a supplied assessment id. fields.biggestAssumptionAnchor is a verbatim fragment of at least 8 characters from that assessment. fields.biggestAssumption states why that assumption is dangerous.
fields.challengeStatus, challengeTarget, challengeSource, challengeClaim, challengeAnchor, challengeWhy, challengeMust, challengeRevision, and challengeUnavailable are arrays of exactly three strings.
- substantive: challengeTarget is vc, customer, competitor, or engineer; challengeSource is that assessment's id; challengeAnchor is a verbatim fragment of at least 8 characters; challengeClaim contains that anchor; challengeWhy, challengeMust, and challengeRevision are specific. challengeRevision is an actionable change to the claim, not a replacement score. challengeUnavailable is "unavailable".
- unavailable: every other challenge value is "unavailable" and challengeUnavailable is the reason. Do not invent a claim to fill the slot.

The contradiction map has exactly two slots. fields.contradictionSlotStatus, contradictionAgentA, contradictionAgentB, contradictionSourceA, contradictionSourceB, contradictionAnchorA, contradictionAnchorB, contradictionWhy, contradictionStronger, and contradictionEvidence are arrays of exactly two strings.
- present: name two different supplied agents, quote opposing anchors, explain the conflict, and name the evidence needed. contradictionStronger is "inconclusive" unless founder defense contains the winning anchor; then it may be "A" or "B". Do not force a winner.
- none: status "none", agents and anchors "unavailable", contradictionWhy explicitly says there is no contradiction, contradictionStronger and contradictionEvidence are "unavailable". Use this for a second slot when only one conflict exists.

fields.overconfidentStatus is "present" or "none". If none, say none warranted and set overconfidentAgent to "unavailable". If present, cite overconfidentSource and overconfidentAnchor from a supplied assessment and explain the overconfidence. Do not name an agent merely to fill the slot.
fields.underweightedRisk and fields.missingEvidence are specific. If assessments are missing, missingEvidence must name those roles.
fields.unansweredQuestion is one decision-blocking question ending in "?".
fields.readinessVerdict is one sentence. It says the committee needs more evidence or is ready for a final verdict. It must not say GO, PIVOT, or KILL.
fields.revisionWarranted is boolean. If true, revisionTarget is a supplied role and revisionPosition appears in that assessment. revisionReason explains why. Do not propose a replacement number. If false, revisionTarget and revisionPosition are "unavailable" and revisionReason says no revision is warranted.
fields.missingAssessments lists absent role ids in order vc, customer, competitor, engineer. fields.reviewComplete is true only when none are missing.
assumptions use founder_provided, supported_evidence, assumption, or unknown. supported_evidence needs evidenceNote and only for facts the founder or a cited observation actually supplied. Label simulated preferences, copyability, correlated wording, and unsourced market or payment claims as assumption or unknown. risks is a non-empty array.`;

const ROLE_LABEL: Record<SpecialistRole, string> = {
  vc: "VC",
  customer: "Customer",
  competitor: "Competitor",
  engineer: "Engineer",
};

const HEADERS = [
  "# RED TEAM AGENT OUTPUT",
  "RED TEAM SUMMARY:",
  "OVERALL REASONING QUALITY:",
  "BIGGEST UNSUPPORTED ASSUMPTION:",
  "AGENT CONTRADICTION MAP:",
  "Contradiction 1:",
  "Contradiction 2:",
  "CHALLENGE 1:",
  "CHALLENGE 2:",
  "CHALLENGE 3:",
  "OVERCONFIDENT AGENT:",
  "UNDERWEIGHTED RISK:",
  "MISSING EVIDENCE:",
  "WHO SHOULD REVISE THEIR SCORE:",
  "DECISION-BLOCKING QUESTION:",
  "RED TEAM VERDICT:",
] as const;

const QUALITIES = ["STRONG", "MEDIUM", "WEAK"] as const;

const OPPOSITES: Array<[RegExp[], RegExp[]]> = [
  [
    [/will not pay/i, /won't pay/i, /willingness to pay: low/i, /nobody (?:i know )?would buy/i],
    [/will pay/i, /willingness to pay: high/i, /huge market/i, /\$\d/i, /total market/i],
  ],
  [
    [/easy to build/i, /weekend project/i, /trivial to build/i],
    [/can copy/i, /ship in a sprint/i, /copy instantly/i],
  ],
  [
    [/pain score: [7-9]/i, /severe pain/i, /high pain/i],
    [/will not pay/i, /willingness to pay: low/i],
  ],
];

export interface AssessmentSource {
  id: string;
  role: SpecialistRole;
  positionLabel: string;
  score?: number;
  text: string;
}

export interface RedTeamRequest {
  brief: IdeaBrief;
  assessments: AssessmentSource[];
  founderDefense?: string;
}

export type RedTeamResult =
  | { ok: true; raw: string; presentation: string }
  | { ok: false; error: ContractError };

interface ChallengeSlot {
  status: "substantive" | "unavailable";
  target: SpecialistRole | null;
  sourceId: string;
  claim: string;
  anchor: string;
  why: string;
  must: string;
  revision: string;
  reason: string;
}

interface ContradictionSlot {
  status: "present" | "none";
  agentA: string;
  agentB: string;
  claimA: string;
  claimB: string;
  why: string;
  stronger: string;
  evidence: string;
}

interface Normalized {
  summary: string;
  quality: "STRONG" | "MEDIUM" | "WEAK";
  biggestAssumption: string;
  contradictions: ContradictionSlot[];
  challenges: ChallengeSlot[];
  overconfident: string;
  underweightedRisk: string;
  missingEvidence: string;
  question: string;
  revision: string;
  readiness: string;
  missing: SpecialistRole[];
  reviewComplete: boolean;
  targetedRoles: SpecialistRole[];
  questions: string[];
  sourceRefs: string[];
  assumptions: unknown;
  risks: string[];
  revisionWarranted: boolean;
}

function invalid(message: string): RedTeamResult {
  return { ok: false, error: { code: "invalid_response", message } };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringList(value: unknown, length?: number): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  const items = value.map((item) => item.trim());
  if (length !== undefined && items.length !== length) return null;
  return items;
}

function oneSentence(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return false;
  const marks = trimmed.match(/[.!?]/g) ?? [];
  return marks.length === 1 && /[.!?]$/.test(trimmed);
}

function oneQuestion(text: string): boolean {
  const trimmed = text.trim();
  return !/[\r\n]/.test(trimmed) && trimmed.endsWith("?") && (trimmed.match(/\?/g) ?? []).length === 1;
}

function roleFrom(value: string): SpecialistRole | null {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((SPECIALIST_ROLES as readonly string[]).includes(key)) return key as SpecialistRole;
  return null;
}

function blob(source: AssessmentSource): string {
  return [source.positionLabel, source.score ?? "", source.text].join("\n");
}

function hasAnchor(text: string, anchor: string): boolean {
  const needle = anchor.trim().toLowerCase();
  return needle.length >= 8 && text.toLowerCase().includes(needle);
}

function opposes(left: string, right: string): boolean {
  return OPPOSITES.some(([a, b]) => {
    const leftA = a.some((pattern) => pattern.test(left));
    const rightB = b.some((pattern) => pattern.test(right));
    const leftB = b.some((pattern) => pattern.test(left));
    const rightA = a.some((pattern) => pattern.test(right));
    return (leftA && rightB) || (leftB && rightA);
  });
}

function forbidden(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(forbidden);
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (
      [
        "decision",
        "verdict",
        "citations",
        "sources",
        "replacementScore",
        "revisedScore",
        "newScore",
      ].includes(key)
    ) {
      return true;
    }
    if (forbidden(child)) return true;
  }
  return false;
}

function evidenceConflict(request: RedTeamRequest, assumptions: unknown): string | null {
  if (!Array.isArray(assumptions)) return "Assumptions must be an array.";
  const shared = sharedSentences(request.assessments);
  for (const item of assumptions) {
    const record = asRecord(item);
    if (!record || record.grounding !== "supported_evidence") continue;
    const statement = typeof record.statement === "string" ? record.statement : "";
    const note = typeof record.evidenceNote === "string" ? record.evidenceNote : "";
    const combined = `${statement} ${note}`;
    if (request.assessments.some((source) => /simulat|hypothetical/i.test(source.text))) {
      if (/pay|pain|demand|adopt/i.test(combined)) {
        return "A simulated customer opinion cannot be labeled supported evidence.";
      }
    }
    if (
      request.assessments.some((source) => /ship in a sprint|can copy|copy instantly/i.test(source.text)) &&
      /no moat|displace|erase|customers will switch/i.test(statement)
    ) {
      return "Ability to copy is not supported evidence of displacement.";
    }
    if (
      request.assessments.some((source) => /total market|\$\d|\bbillion\b|\bTAM\b/i.test(source.text)) &&
      /\$\d|\bbillion\b|total market|\bTAM\b/i.test(statement)
    ) {
      return "An unsourced market-size claim cannot be labeled supported evidence.";
    }
    if (
      request.assessments.some((source) =>
        /will not pay|willingness to pay: low|nobody i know would buy/i.test(source.text),
      ) &&
      /will not pay|won't pay|nobody will buy/i.test(statement)
    ) {
      return "An unsupported refusal-to-pay claim cannot be labeled supported evidence.";
    }
    if (shared.length > 0 && /independently confirmed|both agents prove|confirmed by both/i.test(combined)) {
      return "Repeated wording is not supported evidence of independent confirmation.";
    }
  }
  return null;
}

function sharedSentences(assessments: AssessmentSource[]): string[] {
  const bags = assessments.map((source) =>
    source.text
      .split(/[.\n]/)
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length >= 20),
  );
  const found: string[] = [];
  for (let i = 0; i < bags.length; i += 1) {
    for (let j = i + 1; j < bags.length; j += 1) {
      for (const sentence of bags[i]) {
        if (bags[j].includes(sentence)) found.push(sentence);
      }
    }
  }
  return found;
}

function citesPosition(source: AssessmentSource, position: string): boolean {
  const needle = position.trim().toLowerCase();
  if (needle.length < 2 || needle === "unavailable") return false;
  return blob(source).toLowerCase().includes(needle);
}

function ignoresDefense(defense: string, why: string): boolean {
  if (!/paid contract|signed a paid|purchased/i.test(defense)) return false;
  if (!/no evidence|nobody has paid|unproven willingness|untested willingness/i.test(why)) {
    return false;
  }
  return !/paid contract|signed a paid|purchased/i.test(why);
}

function missingRoles(assessments: AssessmentSource[]): SpecialistRole[] {
  const present = new Set(assessments.map((source) => source.role));
  return SPECIALIST_ROLES.filter((role) => !present.has(role));
}

function catalog(request: RedTeamRequest): string {
  const lines = ["SOURCE CONTRIBUTIONS"];
  if (request.assessments.length === 0) lines.push("(none)");
  for (const source of request.assessments) {
    lines.push(
      `- id: ${source.id} role: ${source.role} position: ${source.positionLabel}${
        source.score === undefined ? "" : ` score: ${source.score}`
      }`,
    );
    lines.push(source.text);
  }
  lines.push("", "FOUNDER DEFENSE:", request.founderDefense?.trim() || "(none)");
  return lines.join("\n");
}

export function assessmentFromMessage(message: DebateMessage): AssessmentSource | null {
  if (message.speaker === "founder" || !isSpecialist(message.speaker) || message.stage !== "assessment" || !message.envelope) {
    return null;
  }
  const envelope = message.envelope;
  const text = [
    envelope.summary,
    envelope.rationale,
    envelope.positionLabel,
    ...envelope.assumptions.map((claim) => claim.statement),
    ...envelope.risks,
    ...Object.entries(envelope.fields).map(([key, value]) => `${key}: ${String(value)}`),
  ].join("\n");
  return {
    id: message.id,
    role: message.speaker,
    positionLabel: envelope.positionLabel,
    ...(envelope.vc ? { score: envelope.vc.score } : {}),
    text,
  };
}

function contradictionLines(slot: ContradictionSlot, index: number): string[] {
  return [
    `Contradiction ${index}:`,
    `- Agent A Claim: ${slot.claimA}`,
    `- Agent B Claim: ${slot.claimB}`,
    `- Why These Conflict: ${slot.why}`,
    `- Which Claim Seems Stronger: ${slot.stronger}`,
    `- Evidence Needed: ${slot.evidence}`,
    "",
  ];
}

export function renderRedTeamCard(review: Normalized): string {
  const lines = [
    "# RED TEAM AGENT OUTPUT",
    "",
    "RED TEAM SUMMARY:",
    review.summary,
    "",
    "OVERALL REASONING QUALITY:",
    review.quality,
    "",
    "BIGGEST UNSUPPORTED ASSUMPTION:",
    review.biggestAssumption,
    "",
    "AGENT CONTRADICTION MAP:",
    "",
  ];
  review.contradictions.forEach((slot, index) => lines.push(...contradictionLines(slot, index + 1)));
  review.challenges.forEach((challenge, index) => {
    lines.push(`CHALLENGE ${index + 1}:`);
    if (challenge.status === "unavailable") {
      lines.push("Target Agent: unavailable");
      lines.push("Specific Claim: unavailable");
      lines.push(`Why It Is Weak: unavailable — ${challenge.reason}`);
      lines.push("What Must Be True For This Claim To Hold: unavailable");
      lines.push("Suggested Revision: unavailable");
    } else {
      lines.push(`Target Agent: ${ROLE_LABEL[challenge.target!]}`);
      lines.push(`Specific Claim: ${challenge.claim}`);
      lines.push(`Why It Is Weak: ${challenge.why}`);
      lines.push(`What Must Be True For This Claim To Hold: ${challenge.must}`);
      lines.push(`Suggested Revision: ${challenge.revision}`);
    }
    lines.push("");
  });
  lines.push("OVERCONFIDENT AGENT:", review.overconfident, "");
  lines.push("UNDERWEIGHTED RISK:", review.underweightedRisk, "");
  lines.push("MISSING EVIDENCE:", review.missingEvidence, "");
  lines.push("WHO SHOULD REVISE THEIR SCORE:", review.revision, "");
  lines.push("DECISION-BLOCKING QUESTION:", review.question, "");
  lines.push("RED TEAM VERDICT:", review.readiness);
  return lines.join("\n");
}

function normalize(request: RedTeamRequest, parsed: unknown): RedTeamResult | { ok: true; value: Normalized } {
  if (forbidden(parsed)) {
    return invalid("Red Team cannot return a verdict, citation, or replacement score.");
  }
  const record = asRecord(parsed);
  if (!record) return invalid("The model response must be a JSON object.");
  const fields = asRecord(record.fields);
  if (!fields) return invalid("The response is missing fields.");
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  if (!oneSentence(summary)) return invalid("RED TEAM SUMMARY must be one sentence.");
  const positionLabel = typeof record.positionLabel === "string" ? record.positionLabel.trim().toLowerCase() : "";
  if (["invest", "pivot", "pass"].includes(positionLabel)) {
    return invalid("Red Team cannot emit a Chair verdict.");
  }
  const risks = stringList(record.risks);
  if (!risks || risks.length === 0 || risks.some((item) => !item)) {
    return invalid("Red Team must name at least one risk in the reasoning.");
  }
  const evidence = evidenceConflict(request, record.assumptions);
  if (evidence) return invalid(evidence);

  const ids = new Map(request.assessments.map((source) => [source.id, source]));
  if (ids.size !== request.assessments.length) {
    return invalid("Supplied assessments must have distinct source ids.");
  }
  const roles = request.assessments.map((source) => source.role);
  if (new Set(roles).size !== roles.length) {
    return invalid("Supplied assessments must have distinct roles.");
  }
  const missing = missingRoles(request.assessments);
  const reviewComplete = missing.length === 0;
  if (fields.reviewComplete !== reviewComplete) {
    return invalid("Partial review cannot be marked as a complete committee review.");
  }
  const statedMissing = stringList(fields.missingAssessments);
  if (!statedMissing) return invalid("missingAssessments must list absent specialist roles.");
  if (statedMissing.join(",") !== missing.join(",")) {
    return invalid("missingAssessments does not match the supplied assessments.");
  }
  if (reviewComplete && /not a complete committee review/i.test(summary)) {
    return invalid("A complete review must not claim it is partial.");
  }
  if (!reviewComplete) {
    if (!/not a complete committee review/i.test(summary)) {
      return invalid("A partial review must say it is not a complete committee review.");
    }
    for (const role of missing) {
      if (!summary.includes(ROLE_LABEL[role])) {
        return invalid("A partial review must name each missing assessment.");
      }
    }
  }

  const status = stringList(fields.challengeStatus, 3);
  const target = stringList(fields.challengeTarget, 3);
  const source = stringList(fields.challengeSource, 3);
  const claim = stringList(fields.challengeClaim, 3);
  const anchor = stringList(fields.challengeAnchor, 3);
  const why = stringList(fields.challengeWhy, 3);
  const must = stringList(fields.challengeMust, 3);
  const revisionText = stringList(fields.challengeRevision, 3);
  const unavailable = stringList(fields.challengeUnavailable, 3);
  if (!status || !target || !source || !claim || !anchor || !why || !must || !revisionText || !unavailable) {
    return invalid("Red Team must return three challenge slots.");
  }

  const defense = request.founderDefense?.trim() ?? "";
  const challenges: ChallengeSlot[] = [];
  const seenAnchors = new Set<string>();
  for (let i = 0; i < 3; i += 1) {
    if (status[i] === "unavailable") {
      if (!unavailable[i] || unavailable[i] === "unavailable") {
        return invalid("An unavailable challenge slot must include a reason.");
      }
      challenges.push({
        status: "unavailable",
        target: null,
        sourceId: "unavailable",
        claim: "unavailable",
        anchor: "unavailable",
        why: "unavailable",
        must: "unavailable",
        revision: "unavailable",
        reason: unavailable[i],
      });
      continue;
    }
    if (status[i] !== "substantive") return invalid("Challenge status must be substantive or unavailable.");
    const role = roleFrom(target[i]);
    const cited = ids.get(source[i]);
    if (!role || !cited || cited.role !== role) {
      return invalid("A challenge source is outside the supplied assessments.");
    }
    if (!hasAnchor(blob(cited), anchor[i]) || !claim[i].toLowerCase().includes(anchor[i].toLowerCase())) {
      return invalid("A challenge must quote or faithfully include a fragment of the cited claim.");
    }
    if (seenAnchors.has(anchor[i].toLowerCase())) {
      return invalid("Challenge slots must not repeat the same claim.");
    }
    seenAnchors.add(anchor[i].toLowerCase());
    if (why[i].length < 20 || must[i].length < 20 || revisionText[i].length < 12) {
      return invalid("Each substantive challenge needs a weakness, a condition, and a suggested revision.");
    }
    if (revisionText[i] === "unavailable" || /replacement score|should be \d+|change (?:the|their) score to \d+/i.test(revisionText[i])) {
      return invalid("A suggested revision must be actionable and cannot assign a replacement score.");
    }
    if (ignoresDefense(defense, why[i])) {
      return invalid("A challenge cannot deny founder defense that was supplied.");
    }
    challenges.push({
      status: "substantive",
      target: role,
      sourceId: cited.id,
      claim: claim[i],
      anchor: anchor[i],
      why: why[i],
      must: must[i],
      revision: revisionText[i],
      reason: "",
    });
  }

  const quality = typeof fields.reasoningQuality === "string" ? fields.reasoningQuality.trim() : "";
  if (!(QUALITIES as readonly string[]).includes(quality)) {
    return invalid("OVERALL REASONING QUALITY must be STRONG, MEDIUM, or WEAK.");
  }
  const assumptionSource = typeof fields.biggestAssumptionSource === "string" ? fields.biggestAssumptionSource.trim() : "";
  const assumptionAnchor = typeof fields.biggestAssumptionAnchor === "string" ? fields.biggestAssumptionAnchor.trim() : "";
  const assumptionText = typeof fields.biggestAssumption === "string" ? fields.biggestAssumption.trim() : "";
  let biggestAssumption = "";
  if (request.assessments.length === 0) {
    if (!/unavailable/i.test(assumptionText)) {
      return invalid("A review with no assessments cannot invent an unsupported assumption.");
    }
    biggestAssumption = assumptionText;
  } else {
    const cited = ids.get(assumptionSource);
    if (!cited || !hasAnchor(blob(cited), assumptionAnchor) || !assumptionText.toLowerCase().includes(assumptionAnchor.toLowerCase())) {
      return invalid("The biggest unsupported assumption must quote a supplied claim.");
    }
    biggestAssumption = `${ROLE_LABEL[cited.role]}: ${assumptionText}`;
  }

  const slotStatus = stringList(fields.contradictionSlotStatus, 2);
  const agentA = stringList(fields.contradictionAgentA, 2);
  const agentB = stringList(fields.contradictionAgentB, 2);
  const sourceA = stringList(fields.contradictionSourceA, 2);
  const sourceB = stringList(fields.contradictionSourceB, 2);
  const anchorA = stringList(fields.contradictionAnchorA, 2);
  const anchorB = stringList(fields.contradictionAnchorB, 2);
  const conflictWhy = stringList(fields.contradictionWhy, 2);
  const stronger = stringList(fields.contradictionStronger, 2);
  const evidenceNeeded = stringList(fields.contradictionEvidence, 2);
  if (!slotStatus || !agentA || !agentB || !sourceA || !sourceB || !anchorA || !anchorB || !conflictWhy || !stronger || !evidenceNeeded) {
    return invalid("The contradiction map must contain two slots.");
  }
  const contradictions: ContradictionSlot[] = [];
  for (let i = 0; i < 2; i += 1) {
    if (slotStatus[i] === "none") {
      if (!/no contradiction/i.test(conflictWhy[i])) {
        return invalid("If no contradiction exists, say so explicitly.");
      }
      if (stronger[i] !== "unavailable" || evidenceNeeded[i] !== "unavailable") {
        return invalid("A missing contradiction cannot force a stronger claim.");
      }
      contradictions.push({
        status: "none",
        agentA: "unavailable",
        agentB: "unavailable",
        claimA: "unavailable",
        claimB: "unavailable",
        why: conflictWhy[i],
        stronger: "unavailable",
        evidence: "unavailable",
      });
      continue;
    }
    if (slotStatus[i] !== "present") return invalid("Contradiction status must be present or none.");
    const leftRole = roleFrom(agentA[i]);
    const rightRole = roleFrom(agentB[i]);
    const left = ids.get(sourceA[i]);
    const right = ids.get(sourceB[i]);
    if (!leftRole || !rightRole || !left || !right || left.role !== leftRole || right.role !== rightRole) {
      return invalid("A contradiction cites an assessment that was not supplied.");
    }
    if (leftRole === rightRole) return invalid("A contradiction needs two agents.");
    if (!hasAnchor(blob(left), anchorA[i]) || !hasAnchor(blob(right), anchorB[i])) {
      return invalid("A contradiction must quote the supplied claims it opposes.");
    }
    if (!opposes(anchorA[i], anchorB[i])) {
      return invalid("No contradiction is present in the quoted claims.");
    }
    if (conflictWhy[i].length < 12 || evidenceNeeded[i].length < 12) {
      return invalid("A contradiction must explain the conflict and the evidence needed.");
    }
    const defenseBacksA = defense.toLowerCase().includes(anchorA[i].toLowerCase());
    const defenseBacksB = defense.toLowerCase().includes(anchorB[i].toLowerCase());
    if (stronger[i] === "A" && !defenseBacksA) {
      return invalid("Which claim seems stronger must follow supplied evidence, not a forced preference.");
    }
    if (stronger[i] === "B" && !defenseBacksB) {
      return invalid("Which claim seems stronger must follow supplied evidence, not a forced preference.");
    }
    if (!["A", "B", "inconclusive"].includes(stronger[i])) {
      return invalid("Which claim seems stronger must be A, B, or inconclusive.");
    }
    contradictions.push({
      status: "present",
      agentA: ROLE_LABEL[leftRole],
      agentB: ROLE_LABEL[rightRole],
      claimA: `${ROLE_LABEL[leftRole]}: "${anchorA[i]}"`,
      claimB: `${ROLE_LABEL[rightRole]}: "${anchorB[i]}"`,
      why: `${ROLE_LABEL[leftRole]} and ${ROLE_LABEL[rightRole]} disagree. ${conflictWhy[i]}`,
      stronger: stronger[i] === "inconclusive" ? "inconclusive" : `${stronger[i] === "A" ? ROLE_LABEL[leftRole] : ROLE_LABEL[rightRole]} — supplied founder defense supports that claim`,
      evidence: evidenceNeeded[i],
    });
  }

  const question = typeof fields.unansweredQuestion === "string" ? fields.unansweredQuestion.trim() : "";
  if (!oneQuestion(question)) return invalid("The unanswered question must be one question.");

  if (typeof fields.revisionWarranted !== "boolean") {
    return invalid("revisionWarranted must be boolean.");
  }
  const revisionTarget = typeof fields.revisionTarget === "string" ? fields.revisionTarget.trim() : "";
  const revisionPosition = typeof fields.revisionPosition === "string" ? fields.revisionPosition.trim() : "";
  const revisionReason = typeof fields.revisionReason === "string" ? fields.revisionReason.trim() : "";
  if (!revisionReason || /replacement score|should be \d+|change (?:the|their) score to \d+/i.test(revisionReason)) {
    return invalid("Revision guidance cannot assign a replacement score.");
  }
  let revision = "";
  if (fields.revisionWarranted) {
    const role = roleFrom(revisionTarget);
    const cited = request.assessments.find((source) => source.role === role);
    if (!role || !cited || !citesPosition(cited, revisionPosition)) {
      return invalid("Revision must cite a score or position that was actually supplied.");
    }
    revision = `${ROLE_LABEL[role]} should revise ${revisionPosition} because ${revisionReason} This does not assign a replacement score.`;
  } else {
    if (revisionTarget !== "unavailable" || revisionPosition !== "unavailable") {
      return invalid("An unwarranted revision must not name a replacement position.");
    }
    revision = `No revision is warranted. ${revisionReason}`;
  }
  if (missing.length > 0) {
    revision += ` Missing assessments: ${missing.map((role) => ROLE_LABEL[role]).join(", ")}.`;
  }

  const overStatus = fields.overconfidentStatus;
  const overWhy = typeof fields.overconfidentWhy === "string" ? fields.overconfidentWhy.trim() : "";
  let overconfident = "";
  if (overStatus === "none") {
    if (!/none warranted|no agent is overconfident/i.test(overWhy)) {
      return invalid("If no agent is overconfident, say none warranted.");
    }
    overconfident = overWhy;
  } else if (overStatus === "present") {
    const overRole = roleFrom(typeof fields.overconfidentAgent === "string" ? fields.overconfidentAgent : "");
    const overSource = ids.get(typeof fields.overconfidentSource === "string" ? fields.overconfidentSource.trim() : "");
    const overAnchor = typeof fields.overconfidentAnchor === "string" ? fields.overconfidentAnchor.trim() : "";
    if (!overRole || !overSource || overSource.role !== overRole || !hasAnchor(blob(overSource), overAnchor) || overWhy.length < 20) {
      return invalid("An overconfident agent must be a supplied role with a quoted claim.");
    }
    overconfident = `${ROLE_LABEL[overRole]} is overconfident because ${overWhy}`;
  } else {
    return invalid("overconfidentStatus must be present or none.");
  }

  const underweightedRisk = typeof fields.underweightedRisk === "string" ? fields.underweightedRisk.trim() : "";
  const missingEvidence = typeof fields.missingEvidence === "string" ? fields.missingEvidence.trim() : "";
  if (underweightedRisk.length < 20) return invalid("UNDERWEIGHTED RISK must name a specific risk.");
  if (missingEvidence.length < 20) return invalid("MISSING EVIDENCE must name the evidence still required.");
  for (const role of missing) {
    if (!missingEvidence.includes(ROLE_LABEL[role])) {
      return invalid("Missing evidence must name each missing assessment.");
    }
  }
  const readiness = typeof fields.readinessVerdict === "string" ? fields.readinessVerdict.trim() : "";
  if (!oneSentence(readiness) || /\b(GO|PIVOT|KILL)\b/.test(readiness) || !/more evidence|ready for a final verdict/i.test(readiness)) {
    return invalid("RED TEAM VERDICT must be one sentence about readiness and must not issue GO, PIVOT, or KILL.");
  }

  const targeted = [
    ...new Set(
      challenges.flatMap((challenge) => (challenge.target ? [challenge.target] : [])),
    ),
  ];
  const questions = challenges.flatMap((challenge) =>
    challenge.status === "substantive" ? [challenge.must] : [],
  );
  return {
    ok: true,
    value: {
      summary,
      quality: quality as Normalized["quality"],
      biggestAssumption,
      contradictions,
      challenges,
      overconfident,
      underweightedRisk,
      missingEvidence,
      question,
      revision,
      readiness,
      missing,
      reviewComplete,
      targetedRoles: targeted.length > 0 ? targeted : request.assessments.map((source) => source.role),
      questions: questions.length > 0 ? questions : [question],
      sourceRefs: challenges.flatMap((challenge) =>
        challenge.status === "substantive" ? [challenge.sourceId] : [],
      ),
      assumptions: record.assumptions,
      risks,
      revisionWarranted: fields.revisionWarranted,
    },
  };
}

function rewrite(review: Normalized): { raw: string; presentation: string } {
  const presentation = renderRedTeamCard(review);
  const slot = <T>(pick: (challenge: ChallengeSlot) => T) => review.challenges.map(pick);
  const raw = JSON.stringify({
    summary: review.summary,
    rationale: presentation,
    assumptions: review.assumptions,
    risks: review.risks,
    positionLabel: review.reviewComplete ? "challenge" : "partial",
    fields: {
      targetedRoles: review.targetedRoles,
      questions: review.questions,
      sourceRefs: review.sourceRefs,
      presentation,
      reviewComplete: review.reviewComplete,
      missingAssessments: review.missing,
      challengeStatus: slot((challenge) => challenge.status),
      challengeTarget: slot((challenge) => challenge.target ?? "unavailable"),
      challengeSource: slot((challenge) => challenge.sourceId),
      challengeClaim: slot((challenge) => challenge.claim),
      challengeAnchor: slot((challenge) => challenge.anchor),
      challengeWhy: slot((challenge) => challenge.why),
      challengeMust: slot((challenge) => challenge.must),
      challengeRevision: slot((challenge) => challenge.revision),
      challengeUnavailable: slot((challenge) => challenge.reason || "unavailable"),
      revisionWarranted: review.revisionWarranted,
      reasoningQuality: review.quality,
      biggestAssumption: review.biggestAssumption,
      underweightedRisk: review.underweightedRisk,
      missingEvidence: review.missingEvidence,
      unansweredQuestion: review.question,
      readinessVerdict: review.readiness,
      revision: review.revision,
    },
  });
  return { raw, presentation };
}

export function buildRedTeamPrompt(
  request: RedTeamRequest,
  registry: RoleRegistry,
): { ok: true; system: string; user: string } | { ok: false; error: ContractError } {
  const run: DebateRun = {
    id: "red-team-context",
    brief: request.brief,
    messages: request.assessments.map((source) => ({
      id: source.id,
      speaker: source.role,
      stage: "assessment" as const,
      body: source.text,
      createdAt: "1970-01-01T00:00:00.000Z",
    })),
    phase: "challenge",
    lock: null,
    failure: null,
    verdictRequested: false,
  };
  const prompt = buildGenerationPrompt(run, "red_team", "challenge", registry);
  if (!prompt.ok) return prompt;
  return {
    ok: true,
    system: prompt.system,
    user: `${prompt.user}\n\n${catalog(request)}\n\nCite only these source ids. Do not use claims from any other idea.`,
  };
}

function providerError(error: unknown): ContractError {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: string }).code)
      : "provider_failure";
  const safe =
    code === "timeout" || code === "invalid_response" || code === "provider_failure"
      ? code
      : "provider_failure";
  return {
    code: safe,
    message:
      error instanceof Error && error.message
        ? error.message
        : "The AI provider request failed.",
  };
}

export function registerRedTeamAgent(registry: RoleRegistry = sharedRegistry): void {
  registry.register("red_team", RED_TEAM_INSTRUCTIONS);
}

export async function generateRedTeamReview(
  request: RedTeamRequest,
  client: ModelClient | null,
  registry: RoleRegistry,
): Promise<RedTeamResult> {
  const prompt = buildRedTeamPrompt(request, registry);
  if (!prompt.ok) return prompt;
  if (!client) {
    return {
      ok: false,
      error: {
        code: "missing_credentials",
        message:
          "AI provider is not configured. Set OPENAI_API_KEY on the server. Sample debates are not used.",
      },
    };
  }
  let raw = "";
  try {
    raw = await client.complete({ system: prompt.system, user: prompt.user });
  } catch (error) {
    return { ok: false, error: providerError(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    return invalid("The model response was not valid JSON.");
  }
  const normalized = normalize(request, parsed);
  if (!("value" in normalized)) return normalized;
  const written = rewrite(normalized.value);
  const envelope = parseContribution("red_team", "challenge", written.raw);
  if (!envelope.ok) return { ok: false, error: envelope.error };
  if (envelope.value.decision || envelope.value.role !== "red_team") {
    return invalid("Red Team cannot emit a Chair verdict.");
  }
  return { ok: true, raw: written.raw, presentation: written.presentation };
}

export function redTeamRequestFromRun(run: DebateRun): RedTeamRequest {
  const assessments = run.messages
    .map(assessmentFromMessage)
    .filter((source): source is AssessmentSource => source !== null);
  const defense = [
    run.brief.founderEvidence,
    ...run.messages.filter((message) => message.speaker === "founder").map((message) => message.body),
  ]
    .map((item) => item.trim())
    .filter(Boolean)
    .join("\n");
  return { brief: run.brief, assessments, ...(defense ? { founderDefense: defense } : {}) };
}

export async function runRedTeamTurn(
  run: DebateRun,
  client: ModelClient | null,
  registry: RoleRegistry,
): Promise<DebateResult> {
  const started = beginTurn(run, "red_team");
  if (!started.ok || !started.value.lock) return started;
  const locked = started.value;
  const generated = await generateRedTeamReview(redTeamRequestFromRun(locked), client, registry);
  if (!generated.ok) {
    const error = {
      code: generated.error.code,
      message: generated.error.message,
      phase: locked.phase,
      role: "red_team" as const,
    };
    return { ok: false, error, value: failTurn(locked, error) };
  }
  const recorded = completeTurn(locked, generated.raw);
  if (!recorded.ok) return recorded;
  const specialists = contextSnapshot(run).messages.filter((message) => message.stage === "assessment");
  const preserved = recorded.value.messages.filter((message) => message.stage === "assessment");
  if (JSON.stringify(specialists) !== JSON.stringify(preserved)) {
    const error = {
      code: "invalid_response" as const,
      message: "Red Team must not change specialist assessments.",
      phase: locked.phase,
      role: "red_team" as const,
    };
    return { ok: false, error, value: failTurn(locked, error) };
  }
  return recorded;
}

export function presentationOrderValid(presentation: string): boolean {
  let at = -1;
  for (const header of HEADERS) {
    const next = presentation.indexOf(header);
    if (next <= at) return false;
    at = next;
  }
  const first = presentation.indexOf("CHALLENGE 1:");
  const second = presentation.indexOf("CHALLENGE 2:");
  const body = presentation.slice(first, second);
  const mapStart = presentation.indexOf("Contradiction 1:");
  const mapEnd = presentation.indexOf("Contradiction 2:");
  const map = presentation.slice(mapStart, mapEnd);
  return (
    body.includes("Target Agent:") &&
    body.includes("Specific Claim:") &&
    body.includes("Why It Is Weak:") &&
    body.includes("What Must Be True For This Claim To Hold:") &&
    body.includes("Suggested Revision:") &&
    map.includes("- Agent A Claim:") &&
    map.includes("- Agent B Claim:") &&
    map.includes("- Why These Conflict:") &&
    map.includes("- Which Claim Seems Stronger:") &&
    map.includes("- Evidence Needed:") &&
    !presentation.split("\n").some((line) =>
      ["BIGGEST CONTRADICTION:", "MOST IMPORTANT UNANSWERED QUESTION:", "WHO SHOULD REVISE:"].includes(line),
    )
  );
}
