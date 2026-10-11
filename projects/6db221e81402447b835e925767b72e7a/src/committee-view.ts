import type { ChairDecision, Claim, RoleEnvelope, RoleId, SpecialistRole } from "./contract";
import { isSpecialist } from "./contract";
import type { DebateFailure, DebateMessage, DebateRun, Phase } from "./debate";

type AgentMeta = {
  id: RoleId;
  label: string;
  short: string;
  icon: string;
  color: string;
  mandate: string;
};

const agentMeta: AgentMeta[] = [
  { id: "vc", label: "VC", short: "VC", icon: "◇", color: "#f1c46c", mandate: "Venture-scale opportunity" },
  { id: "customer", label: "Customer", short: "CU", icon: "◉", color: "#39c8bd", mandate: "Adoption and willingness to pay" },
  { id: "competitor", label: "Competitor", short: "CO", icon: "◈", color: "#f19758", mandate: "Market alternatives and defensibility" },
  { id: "engineer", label: "Engineer", short: "EN", icon: "⌘", color: "#69a8ff", mandate: "Technical feasibility" },
  { id: "red_team", label: "Red Team", short: "RT", icon: "✦", color: "#ed6c77", mandate: "Pressure-test the case" },
  { id: "chair", label: "Chair", short: "CH", icon: "♛", color: "#b794f4", mandate: "Synthesize a decision" },
];

const byId = Object.fromEntries(agentMeta.map((agent) => [agent.id, agent])) as Record<RoleId, AgentMeta>;

const SPECIALISTS = ["vc", "customer", "competitor", "engineer"] as const;
const scoreKeys: Record<SpecialistRole, { key: string; scale: number }> = {
  vc: { key: "score", scale: 100 },
  customer: { key: "adoptionScore", scale: 10 },
  competitor: { key: "threatScore", scale: 10 },
  engineer: { key: "feasibilityScore", scale: 10 },
};
const pointKeys: Record<RoleId, string[]> = {
  vc: ["strongestInvestmentCase", "killShotQuestion", "marketSizeConcern", "first100Users", "defensibilityConcern", "oneLineVerdict"],
  customer: ["pain", "willingnessToPay", "workaround", "switchingCost", "adoptionBarrier"],
  competitor: ["incumbent", "crushPlan", "weakMoat", "copyabilityRisk", "distributionDisadvantage", "dangerousMove", "founderQuestion", "verdict"],
  engineer: ["dependencies", "operationalRisk", "firstBuild", "sequencing", "buildRisk"],
  red_team: ["unansweredQuestion", "contradictionExplanation", "revisionReason"],
  chair: ["strongestArgument", "outweighedArgument", "weakestAssumption", "brutalSummary", "evidenceWeighting", "finalNote"],
};
const riskKeys = ["biggestFundabilityRisk", "biggestRisk", "biggestUnresolvedRisk", "weakMoat", "buildRisk"];
const stageLabels = ["Brief", "Openings", "Red Team", "Rebuttals", "Founder Pause", "Verdict"] as const;

export type AgentStatus = "queued" | "working" | "completed" | "failed";
export type StageState = "done" | "running" | "waiting" | "failed";
export type Movement = "pending" | "held" | "changed" | "scored" | "none";

export type AssumptionView = {
  statement: string;
  grounding: string;
  evidenceNote: string | null;
};

export type WhyView = {
  /** Which agent's report this is, so repeated toggles on one card stay distinct. */
  title: string;
  report: string | null;
  points: string[];
  risk: string | null;
  assumptions: AssumptionView[];
  changes: string[];
};

export type AgentView = AgentMeta & {
  initialScore: number | null;
  finalScore: number | null;
  scale: number;
  initialPosition: string | null;
  finalPosition: string | null;
  delta: number | null;
  reason: string | null;
  status: AgentStatus;
  why: WhyView | null;
  movement: Movement;
};

export type SpecialistView = AgentView;
export type ChallengeView = {
  slot: number;
  challenger: AgentMeta;
  target: AgentView;
  claim: string | null;
  challengeWhy: string | null;
  response: string | null;
  responsePending: boolean;
};
export type StageView = { label: (typeof stageLabels)[number]; state: StageState };
export type FounderExchange = { question: string; response: string | null };

export type CommitteeView = {
  idea: string;
  customer: string;
  phase: Phase | "brief";
  failure: DebateFailure | null;
  stages: StageView[];
  agents: AgentView[];
  specialists: AgentView[];
  challenges: ChallengeView[];
  prompts: Array<{ label: string; target: AgentMeta }>;
  verdict: string | null;
  confidence: number | null;
  summary: string | null;
  /** The Chair's full formatted verdict card, shown collapsed under the heading. */
  fullVerdict: string | null;
  radar: Array<{ label: string; value: number; max: number }> | null;
  decisionCards: Array<{ title: string; content: string }>;
  killRisks: string[] | null;
  stats: Array<{ label: string; value: string }>;
  founderExchanges: FounderExchange[];
  network: {
    nodes: Array<AgentMeta & { x: number; y: number }>;
    edges: Array<{ target: string; slot: number; label: string; path: string; labelX: number; labelY: number }>;
  };
};

export function ignoreStaleUpdate(
  activeId: string | null,
  token: number,
  responseToken: number,
  incomingId: string | undefined,
): boolean {
  if (token !== responseToken) return true;
  if (!activeId || !incomingId || activeId !== incomingId) return true;
  return false;
}

function envelope(run: DebateRun, role: RoleId, stage: DebateMessage["stage"]): RoleEnvelope | undefined {
  return run.messages.find((message) => message.speaker === role && message.stage === stage && message.envelope)?.envelope;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.trim() !== "unavailable" ? value.trim() : null;
}

function numberValue(envelopeValue: RoleEnvelope | undefined, key: string): number | null {
  const value = envelopeValue?.fields[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function labelFor(key: string): string {
  const spaced = key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
  return spaced;
}

function claimView(claim: Claim): AssumptionView | null {
  const statement = claim.statement?.trim();
  if (!statement) return null;
  return {
    statement,
    grounding: claim.grounding,
    evidenceNote: claim.evidenceNote?.trim() || null,
  };
}

function pointsFrom(source: RoleEnvelope | undefined, report: string | null, risk: string | null): string[] {
  if (!source) return [];
  const seen = new Set<string>();
  const points: string[] = [];
  const add = (label: string, value: string | null) => {
    if (!value || value === report || value === risk || seen.has(value)) return;
    seen.add(value);
    points.push(`${label}: ${value}`);
  };
  for (const key of pointKeys[source.role]) add(labelFor(key), textValue(source.fields[key]));
  if (source.role === "red_team") {
    stringList(source.fields.challengeClaim).forEach((claim, index) => {
      const why = stringList(source.fields.challengeWhy)[index];
      add(`Challenge ${index + 1}`, textValue(claim));
      add(`Challenge ${index + 1} reason`, textValue(why));
    });
  }
  if (source.role === "chair" && source.decision) {
    source.decision.decisiveReasons.forEach((reason, index) => add(`Decisive reason ${index + 1}`, reason.trim() || null));
  }
  // The Chair's summary is the full formatted verdict card; the verdict screen renders it on its own.
  if (!(source.role === "chair" && isFormattedVerdict(source))) add("Summary", source.summary.trim() || null);
  return points;
}

function riskFrom(source: RoleEnvelope | undefined): string | null {
  if (!source) return null;
  for (const key of riskKeys) {
    const value = textValue(source.fields[key]);
    if (value) return value;
  }
  if (source.role === "chair") {
    const unresolved = source.decision?.unresolvedRisks.find((risk) => risk.trim());
    if (unresolved) return unresolved.trim();
  }
  return source.risks.find((risk) => risk.trim())?.trim() ?? null;
}

function changesFrom(source: RoleEnvelope | undefined): string[] {
  if (!source || source.role !== "chair") return [];
  const changes: string[] = [];
  const whatChanged = textValue(source.fields.whatChanged);
  const excerpt = textValue(source.fields.changeExcerpt);
  const changeSource = textValue(source.fields.changeSource);
  if (whatChanged) changes.push(whatChanged);
  if (excerpt) changes.push(excerpt);
  if (changeSource && changeSource !== "none") changes.push(`Recorded source: ${changeSource}`);
  if (source.fields.debateChanged === false) changes.push("The recorded debate did not change the conclusion.");
  return changes;
}

function whyFrom(sources: Array<RoleEnvelope | undefined>): WhyView | null {
  const present = sources.filter((source): source is RoleEnvelope => Boolean(source));
  if (present.length === 0) return null;
  const report = present.map((source) => textValue(source.fields.report) ?? textValue(source.rationale)).find(Boolean) ?? null;
  const risk = present.map(riskFrom).find(Boolean) ?? null;
  const points = present.flatMap((source) => pointsFrom(source, report, risk));
  const uniquePoints = [...new Set(points)];
  const assumptions = present.flatMap((source) => source.assumptions.map(claimView).filter((claim): claim is AssumptionView => Boolean(claim)));
  const changes = present.flatMap(changesFrom);
  const title = [...new Set(present.map((source) => byId[source.role].label))].join(" & ");
  return { title, report, points: uniquePoints, risk, assumptions, changes };
}

function movementFor(initialScore: number | null, finalScore: number | null, opening: RoleEnvelope | undefined, rebuttal: RoleEnvelope | undefined): Movement {
  if (!opening) return "none";
  if (!rebuttal) return "pending";
  if (initialScore != null && finalScore != null) return "scored";
  return opening.positionLabel === rebuttal.positionLabel ? "held" : "changed";
}

function statusFor(run: DebateRun, role: RoleId, complete: boolean): AgentStatus {
  if (run.failure?.role === role) return "failed";
  if (run.lock?.role === role) return "working";
  return complete ? "completed" : "queued";
}

function specialist(run: DebateRun, id: SpecialistRole): AgentView {
  const opening = envelope(run, id, "assessment");
  const rebuttal = envelope(run, id, "rebuttal");
  const source = scoreKeys[id];
  const initialScore = numberValue(opening, source.key);
  const finalScore = numberValue(rebuttal, source.key);
  const rebuttalExpected = run.phase === "rebuttals" || run.phase === "founder" || run.phase === "verdict" || run.phase === "complete";
  const complete = rebuttalExpected ? Boolean(rebuttal) : Boolean(opening);
  return {
    ...byId[id],
    initialScore,
    finalScore,
    scale: source.scale,
    initialPosition: opening?.positionLabel ?? null,
    finalPosition: rebuttal?.positionLabel ?? null,
    delta: initialScore == null || finalScore == null ? null : finalScore - initialScore,
    reason: rebuttal?.changeReason?.trim() || null,
    status: statusFor(run, id, complete || Boolean(opening)),
    why: whyFrom([opening, rebuttal]),
    movement: movementFor(initialScore, finalScore, opening, rebuttal),
  };
}

function edgeLabel(agent: AgentView): string {
  if (agent.movement === "pending" || agent.movement === "none") return "pending";
  if (agent.delta != null) return `${agent.delta > 0 ? "+" : ""}${agent.delta}`;
  if (agent.movement === "held") return "held";
  if (agent.movement === "changed") return "changed";
  return "pending";
}

function stagesFor(run: DebateRun | null): StageView[] {
  if (!run?.id) return stageLabels.map((label, index) => ({ label, state: index === 0 ? "running" : "waiting" }));
  const current = run.phase === "complete" ? stageLabels.length : { assessments: 1, challenge: 2, rebuttals: 3, founder: 4, verdict: 5 }[run.phase];
  return stageLabels.map((label, index) => {
    if (run.failure && index === current) return { label, state: "failed" };
    if (index < current) return { label, state: "done" };
    if (index === current) return { label, state: "running" };
    return { label, state: "waiting" };
  });
}

function challengesFor(run: DebateRun, specialists: AgentView[]): ChallengeView[] {
  const review = envelope(run, "red_team", "challenge");
  if (!review) return [];
  const targets = stringList(review.fields.challengeTarget);
  const statuses = stringList(review.fields.challengeStatus);
  const claims = stringList(review.fields.challengeClaim);
  const reasons = stringList(review.fields.challengeWhy);
  if (targets.length === 0) {
    const legacy = stringList(review.fields.targetedRoles).filter((id): id is SpecialistRole => isSpecialist(id as RoleId));
    return legacy.map((id, index) => {
      const target = specialists.find((agent) => agent.id === id)!;
      const rebuttal = envelope(run, id, "rebuttal");
      return {
        slot: index,
        challenger: byId.red_team,
        target,
        claim: legacy.length === 1 ? review.summary : null,
        challengeWhy: null,
        response: rebuttal?.summary ?? null,
        responsePending: !rebuttal,
      };
    });
  }
  return targets.flatMap((targetId, slot) => {
    const unavailable = statuses[slot] === "unavailable" || targetId === "unavailable" || !isSpecialist(targetId as RoleId);
    if (unavailable) return [];
    const target = specialists.find((agent) => agent.id === targetId);
    if (!target) return [];
    const rebuttal = envelope(run, target.id, "rebuttal");
    return [{
      slot,
      challenger: byId.red_team,
      target,
      claim: textValue(claims[slot]),
      challengeWhy: textValue(reasons[slot]),
      response: rebuttal?.summary ?? null,
      responsePending: !rebuttal,
    }];
  });
}

function founderExchanges(messages: DebateMessage[]): FounderExchange[] {
  const exchanges: FounderExchange[] = [];
  for (const message of messages) {
    if (message.speaker === "founder" && message.stage === "founder") {
      exchanges.push({ question: message.body, response: null });
      continue;
    }
    if (message.stage !== "founder_response") continue;
    const response = message.envelope?.summary || message.body;
    const open = exchanges.find((exchange) => exchange.response == null);
    if (open) open.response = response;
    else exchanges.push({ question: "", response });
  }
  return exchanges;
}

function elapsed(messages: DebateMessage[]): string {
  const stamps = messages.map((message) => Date.parse(message.createdAt)).filter((stamp) => Number.isFinite(stamp));
  if (stamps.length < 2) return "—";
  const seconds = Math.max(0, Math.round((stamps[stamps.length - 1] - stamps[0]) / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function radarFrom(chair: RoleEnvelope | undefined): CommitteeView["radar"] {
  if (!chair) return null;
  const dimensions = ["demand", "buildability", "fundability", "defensibility"] as const;
  const values = dimensions.map((key) => numberValue(chair, key));
  if (values.some((value) => value == null)) return null;
  return dimensions.map((key, index) => ({
    label: key[0].toUpperCase() + key.slice(1),
    value: values[index] as number,
    max: 10,
  }));
}

const DISPLAY_FOR_SHARED: Record<string, string> = { invest: "GO", pivot: "PIVOT", pass: "KILL" };

/** The founder-facing label: the Chair's GO, PIVOT or KILL, never the shared invest/pivot/pass position. */
function displayVerdict(chair: RoleEnvelope | undefined): string | null {
  const decision = chair?.decision;
  if (!decision) return null;
  const display = textValue(chair?.fields.displayVerdict);
  if (display && ["GO", "PIVOT", "KILL"].includes(display.toUpperCase())) return display.toUpperCase();
  return DISPLAY_FOR_SHARED[decision.verdict] ?? decision.verdict.toUpperCase();
}

function isFormattedVerdict(chair: RoleEnvelope): boolean {
  const formatted = textValue(chair.fields.formattedVerdict);
  const summary = chair.summary.trim();
  return summary === formatted || /^FINAL VERDICT:/.test(summary);
}

/** One readable line for the verdict heading; the formatted card is exposed separately. */
function verdictSummary(chair: RoleEnvelope | undefined): string | null {
  if (!chair) return null;
  return textValue(chair.fields.brutalSummary) ?? (isFormattedVerdict(chair) ? textValue(chair.fields.finalNote) : chair.summary.trim() || null);
}

function fullVerdict(chair: RoleEnvelope | undefined): string | null {
  if (!chair) return null;
  return textValue(chair.fields.formattedVerdict) ?? (isFormattedVerdict(chair) ? chair.summary.trim() : null);
}

function decisionCards(chair: RoleEnvelope | undefined): Array<{ title: string; content: string }> {
  const decision = chair?.decision;
  if (!chair || !decision) return [];
  const display = displayVerdict(chair);
  const cards = [
    // decisiveReasons argue for the verdict, so on a KILL they are reasons to kill; label them as such.
    ["Strongest case for the idea", [textValue(chair.fields.strongestArgument), textValue(chair.fields.strongestEvidence)].filter(Boolean).join(" · ")],
    [display ? `Why the committee says ${display}` : "Decisive reasons", decision.decisiveReasons.filter(Boolean).join(" · ")],
    ["Unresolved risks", decision.unresolvedRisks.filter(Boolean).join(" · ")],
    ["Biggest disagreement", decision.disagreements.find(Boolean) ?? ""],
    ["Recommended pivot", decision.verdict === "pivot" ? decision.pivotDirection ?? "" : ""],
    ["Next experiment", decision.nextSteps.filter(Boolean).join(" · ")],
  ] as const;
  return cards.filter(([, content]) => content.trim()).map(([title, content]) => ({ title, content }));
}

export function toCommitteeView(run: DebateRun | null): CommitteeView {
  const specialists = run ? SPECIALISTS.map((id) => specialist(run, id)) : SPECIALISTS.map((id) => specialist(emptyRun(), id));
  const active = run ?? emptyRun();
  const chair = envelope(active, "chair", "verdict");
  const decision = chair?.decision ?? null;
  const challenges = challengesFor(active, specialists);
  const redComplete = Boolean(envelope(active, "red_team", "challenge"));
  const chairComplete = Boolean(decision);
  const agents: AgentView[] = [
    ...specialists,
    {
      ...byId.red_team,
      initialScore: null,
      finalScore: null,
      scale: 0,
      initialPosition: redComplete ? envelope(active, "red_team", "challenge")?.positionLabel ?? null : null,
      finalPosition: null,
      delta: null,
      reason: null,
      status: statusFor(active, "red_team", redComplete),
      why: whyFrom([envelope(active, "red_team", "challenge")]),
      movement: "none",
    },
    {
      ...byId.chair,
      initialScore: null,
      finalScore: null,
      scale: 0,
      initialPosition: displayVerdict(chair),
      finalPosition: displayVerdict(chair),
      delta: null,
      reason: null,
      status: statusFor(active, "chair", chairComplete),
      why: whyFrom([chair]),
      movement: "none",
    },
  ];
  const edges = challenges.map((challenge, index) => {
    const x = 160 + index * 150;
    return {
      target: challenge.target.id,
      slot: challenge.slot,
      label: edgeLabel(challenge.target),
      path: `M310 54 Q ${x} 86 ${x} ${118}`,
      labelX: (310 + x) / 2,
      labelY: 86,
    };
  });
  return {
    idea: active.brief.idea,
    customer: active.brief.targetCustomer,
    phase: active.id ? active.phase : "brief",
    failure: active.failure,
    stages: stagesFor(run?.id ? run : null),
    agents,
    specialists,
    challenges,
    prompts: [
      { label: "Is the market big enough?", target: byId.vc },
      { label: "Will customers pay?", target: byId.customer },
      { label: "Can incumbents copy this?", target: byId.competitor },
      { label: "Can this actually be built?", target: byId.engineer },
    ],
    verdict: displayVerdict(chair),
    confidence: numberValue(chair, "confidence"),
    summary: verdictSummary(chair),
    fullVerdict: fullVerdict(chair),
    radar: radarFrom(chair),
    decisionCards: decisionCards(chair),
    killRisks: chair && Array.isArray(chair.fields.killRisks) ? stringList(chair.fields.killRisks) : null,
    stats: [
      { label: "Model calls", value: String(active.messages.filter((message) => message.envelope).length) },
      { label: "Elapsed time", value: elapsed(active.messages) },
    ],
    founderExchanges: founderExchanges(active.messages),
    network: {
      nodes: [{ ...byId.red_team, x: 310, y: 45 }, ...specialists.map((agent, index) => ({ ...agent, x: 160 + index * 150, y: 150 }))],
      edges,
    },
  };
}

function emptyRun(): DebateRun {
  return {
    id: "",
    brief: { idea: "", problem: "", targetCustomer: "", solution: "", businessModel: "", traction: "", founderEvidence: "" },
    messages: [],
    phase: "assessments",
    lock: null,
    failure: null,
    verdictRequested: false,
  };
}

function message(id: string, speaker: RoleId, stage: DebateMessage["stage"], body: string, roleEnvelope: RoleEnvelope, createdAt: string): DebateMessage {
  return { id, speaker, stage, body, envelope: roleEnvelope, createdAt };
}

function spec(
  role: SpecialistRole,
  stage: "assessment" | "rebuttal",
  positionLabel: string,
  fields: Record<string, string | number>,
  summary: string,
  changeReason: string | null,
  rationale = summary,
): RoleEnvelope {
  return {
    schemaVersion: 1,
    role,
    stage,
    summary,
    rationale,
    assumptions: stage === "assessment" && role === "vc"
      ? [{ statement: "Clinic leaders already budget for audit preparation.", grounding: "assumption" }]
      : [],
    risks: role === "engineer" ? ["Evidence normalization may slip the first delivery."] : [],
    positionLabel,
    changed: stage === "rebuttal",
    changeReason,
    fields,
    decision: null,
    vc: null,
    competitor: null,
  };
}

const time = "2026-10-10T20:";
const decision: ChairDecision = {
  verdict: "pivot",
  decisiveReasons: ["A clear wedge in a regulated workflow", "Founders can reach early adopters"],
  disagreements: ["The committee differs on whether the buyer feels urgency before compliance pressure."],
  unresolvedRisks: ["Prove renewal after the first compliance cycle", "Show a repeatable channel outside the founder network"],
  nextSteps: ["Run a seven-day paid concierge pilot with three clinics"],
  pivotDirection: "Start with clinic compliance teams, not general practice operations.",
};

export const demoRun: DebateRun = {
  id: "demo-run",
  brief: {
    idea: "A compliance copilot that turns clinical notes into audit-ready evidence.",
    problem: "Independent clinics lose time preparing for audits.",
    targetCustomer: "Operations leaders at independent clinics",
    solution: "An evidence workflow that connects notes to audit requirements.",
    businessModel: "Per-clinic subscription",
    traction: "",
    founderEvidence: "",
  },
  phase: "complete",
  lock: null,
  failure: null,
  verdictRequested: true,
  messages: [
    message("a1", "vc", "assessment", "The pain is credible, but the market needs a sharper wedge.", spec("vc", "assessment", "MAYBE", { score: 84, report: "The pain is real, but the buyer and the wedge are still too broad for a venture check.", strongestInvestmentCase: "Audit prep is budgeted and recurring.", biggestFundabilityRisk: "The category may stay a feature inside an EHR.", killShotQuestion: "Who renews after the first audit?" }, "The pain is credible, but the market needs a sharper wedge.", null), `${time}00:00.000Z`),
    message("a2", "customer", "assessment", "Operators would pay if this removes the audit scramble.", spec("customer", "assessment", "INTERESTED", { adoptionScore: 8, report: "Operators would trial this if it removes the week before an audit.", pain: "Audit week consumes the operations lead.", willingnessToPay: "A subscription is plausible only beside a scheduled audit." }, "Operators would pay if this removes the audit scramble.", null), `${time}00:18.000Z`),
    message("a3", "competitor", "assessment", "Incumbents can bundle this unless the workflow becomes sticky.", spec("competitor", "assessment", "WATCH", { threatScore: 6, report: "An EHR suite can ship a shallow checklist unless the evidence workflow is hard to copy.", incumbent: "The clinic's current EHR suite", crushPlan: "Bundle a checklist into the existing chart.", weakMoat: "A document export is easy to copy." }, "Incumbents can bundle this unless the workflow becomes sticky.", null), `${time}00:34.000Z`),
    message("a4", "engineer", "assessment", "The integration path is feasible with a narrow first connector.", spec("engineer", "assessment", "FEASIBLE", { feasibilityScore: 8, report: "A narrow connector is buildable; normalizing evidence across systems is the hard part.", dependencies: "One EHR export is enough for a pilot.", buildRisk: "Evidence normalization can swallow the first release." }, "The integration path is feasible with a narrow first connector.", null), `${time}00:51.000Z`),
    message("r1", "red_team", "challenge", "The openings treat an audit calendar as observed demand.", {
      schemaVersion: 1,
      role: "red_team",
      stage: "challenge",
      summary: "The openings treat an audit calendar as observed demand.",
      rationale: "Three openings assert demand, defensibility, or delivery without a recorded buyer action.",
      assumptions: [{ statement: "A scheduled audit is not the same as a budget owner.", grounding: "assumption" }],
      risks: ["The committee may be scoring a calendar event as a market."],
      positionLabel: "CHALLENGE",
      changed: null,
      changeReason: null,
      fields: {
        report: "The openings assert adoption, defensibility, and delivery without a recorded buyer action.",
        challengeStatus: ["substantive", "substantive", "substantive"],
        challengeTarget: ["vc", "customer", "competitor"],
        challengeClaim: [
          "A budgeted audit week is not a venture-scale buyer.",
          "Interest before an audit is not willingness to pay.",
          "A checklist bundle is not a durable wedge.",
        ],
        challengeWhy: [
          "The VC score assumes renewal that the brief does not show.",
          "The customer position cites interest, not a paid pilot.",
          "The competitor plan does not show why the workflow cannot be copied.",
        ],
      },
      decision: null,
      vc: null,
      competitor: null,
    }, `${time}01:05.000Z`),
    message("b1", "vc", "rebuttal", "The initial market is narrower than the headline TAM suggests.", spec("vc", "rebuttal", "MAYBE", { score: 71, report: "The rebuttal narrows the buyer to compliance leads and cuts the score.", strongestInvestmentCase: "Compliance leads already feel the pain.", biggestFundabilityRisk: "Renewal after the audit is unproven." }, "The initial market is narrower than the headline TAM suggests.", "The initial wedge is smaller than the headline market."), `${time}01:25.000Z`),
    message("b2", "customer", "rebuttal", "The proof is strongest when tied to a scheduled compliance event.", spec("customer", "rebuttal", "MAYBE", { adoptionScore: 6, report: "Payment is plausible only when an audit date is already on the calendar." }, "The proof is strongest when tied to a scheduled compliance event.", "Urgency depends on a concrete audit deadline."), `${time}01:41.000Z`),
    message("b3", "competitor", "rebuttal", "Workflow depth can protect the wedge, but it must arrive quickly.", spec("competitor", "rebuttal", "WATCH", { threatScore: 7, report: "The bundling threat is higher once the first workflow is only an export." }, "Workflow depth can protect the wedge, but it must arrive quickly.", "The bundling threat grew after the challenge."), `${time}01:59.000Z`),
    message("c1", "chair", "verdict", "PIVOT: prove a paid compliance wedge before pursuing the broader operations platform.", {
      schemaVersion: 1,
      role: "chair",
      stage: "verdict",
      summary: "PIVOT: prove a paid compliance wedge before pursuing the broader operations platform.",
      rationale: "The pain is specific enough to test, but the current buyer and wedge are too broad.",
      assumptions: [],
      risks: [],
      positionLabel: "PIVOT",
      changed: null,
      changeReason: null,
      fields: {
        report: "Prove a paid compliance wedge before expanding into clinic operations.",
        confidence: 76,
        demand: 7,
        buildability: 7,
        fundability: 5,
        defensibility: 4,
        killRisks: [
          "The audit trigger may not create recurring urgency.",
          "Large EHR vendors can bundle a shallow version.",
          "Evidence normalization may slow initial delivery.",
        ],
        whatChanged: "The VC and customer scores fell after the Red Team separated interest from payment.",
        debateChanged: true,
        changeSource: "red_team",
        changeExcerpt: "Interest before an audit is not willingness to pay.",
        biggestUnresolvedRisk: "Prove renewal after the first compliance cycle",
      },
      decision,
      vc: null,
      competitor: null,
    }, `${time}02:36.000Z`),
  ],
};

export const demoRunWithoutOptionalScores: DebateRun = {
  ...demoRun,
  messages: demoRun.messages.map((entry) => entry.envelope && (entry.speaker === "customer" || entry.speaker === "engineer")
    ? {
      ...entry,
      envelope: {
        ...entry.envelope,
        fields: Object.fromEntries(Object.entries(entry.envelope.fields).filter(([key]) => key !== "adoptionScore" && key !== "feasibilityScore")),
      },
    }
    : entry),
};
