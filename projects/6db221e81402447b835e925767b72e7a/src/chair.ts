import { validateBrief } from "./brief";
import {
  SPECIALIST_ROLES,
  parseModelJson,
  type ChairVerdict,
  type RoleEnvelope,
  type RoleId,
  type RoleRegistry,
} from "./contract";
import {
  beginTurn,
  completeTurn,
  failTurn,
  requiredStagesComplete,
  type DebateFailure,
  type DebateMessage,
  type DebateResult,
  type DebateRun,
} from "./debate";
import { generateContribution, sharedRegistry, type ModelClient } from "./provider";

export const DISPLAY_VERDICTS = ["GO", "PIVOT", "KILL"] as const;
export type DisplayVerdict = (typeof DISPLAY_VERDICTS)[number];

export const PIVOT_DIMENSIONS = ["customer", "product", "wedge", "business_model"] as const;
export type PivotDimension = (typeof PIVOT_DIMENSIONS)[number];

const CHANGE_SOURCES = [
  "red_team",
  "vc",
  "customer",
  "competitor",
  "engineer",
  "founder",
  "none",
] as const;

type ChangeSource = (typeof CHANGE_SOURCES)[number];

export const CHAIR_SECTION_LABELS = [
  "FINAL VERDICT",
  "CONFIDENCE",
  "SCORES",
  "BRUTAL ONE-LINE SUMMARY",
  "FINAL DECISION RATIONALE",
  "WHAT THE COMMITTEE AGREED ON",
  "WHAT THE COMMITTEE DISAGREED ON",
  "STRONGEST EVIDENCE",
  "WEAKEST ASSUMPTION",
  "WHAT CHANGED DURING DEBATE",
  "MOST INFLUENTIAL AGENT",
  "TOP 3 KILL RISKS",
  "CHEAPEST VALIDATION TEST THIS WEEK",
  "RECOMMENDED 72-HOUR MVP",
  "GO CRITERIA",
  "PIVOT DIRECTION",
  "STOP DOING",
  "FINAL COMMITTEE NOTE",
] as const;

const ROLE_LABEL: Record<string, string> = {
  vc: "VC",
  customer: "Customer",
  competitor: "Competitor",
  engineer: "Engineer",
  red_team: "Red Team",
  founder: "founder",
};

export const CHAIR_INSTRUCTIONS = `You are the Investment Committee Chair for Venture Gauntlet. You are the final decision-maker: disciplined, clear, and decisive. You are not another debater and you do not add a fifth opinion. You evaluate the full debate and decide what the founder should do next. You care about evidence quality, not loud opinions.

Use these exact keys inside fields: displayVerdict, confidence, demand, demandReason, buildability, buildabilityReason, fundability, fundabilityReason, defensibility, defensibilityReason, brutalSummary, strongestEvidence, strongestArgument, outweighedArgument, weakestAssumption, biggestUnresolvedRisk, whatChanged, evidenceWeighting, finalNote, killRisks, debateChanged, changeSource, concessionsCited, testParticipant, testAction, testObservable, testSuccess, testFailure, testDays, mvpWorkflow, mvpManual, mvpMustWork, mvpHours, doNotBuild. Reasons and narrative fields are nonempty explanatory strings. Use changeExcerpt when debateChanged is true. For GO also include explanatory strings goPain, goBuildable, goSwitch, goRevenue, goCompetition. For PIVOT include pivotDimension and pivotDirection in fields and the same pivotDirection in decision; finalNote must include that exact direction. Omit pivotDirection for other verdicts. For KILL include fatalObjection and tell the founder to stop or do not build in finalNote; omit disconfirmation unless a bounded prototype is justified. Do not provide formattedVerdict: the adapter renders it. decision must include verdict and nonempty string arrays decisiveReasons, disagreements, unresolvedRisks, nextSteps. Include biggestUnresolvedRisk in decision.unresolvedRisks and name the disagreeing specialists in decision.disagreements.


Expanded report fields: decisionRationale (exactly 2–3 sentences), committeeAgreement, committeeDisagreement, influentialAgent (vc, customer, competitor, engineer, or red_team), influentialReason, influentialExcerpt (a verbatim quote from that agent's supplied contribution), and stopDoing. Name the strongest shared point and unresolved disagreement without inventing consensus; explicitly say when no common ground or unresolved disagreement exists. goCriteria, goCriteriaTests, goCriteriaPass, and goCriteriaFail are four parallel string arrays of length exactly three. Each criterion specifies what must be proven, a concrete test, an observable success threshold and a failure threshold. Together cover real pain and willingness to switch/pay, reliable buildability and viable revenue, and survivable competition. For an existing GO, describe the evidence that must hold before scaling.

Improvement feedback stays in GO CRITERIA and PIVOT DIRECTION, without extra report sections. Use parallel string arrays improvementTargets, improvementStatus, improvementChanges, improvementEvidence, improvementSuccess, improvementFailure. KILL requires targets ["PIVOT", "GO"], PIVOT requires ["GO"], GO requires ["GO"] to maintain the verdict. Each status is "conditional" or "unavailable". For conditional paths specify the exact customer, problem, solution, wedge or business-model change, new evidence required, and observable pass/fail thresholds. KILL-to-GO must overcome the fatal objection and all five GO conditions, not merely rescore the idea. For an unavailable path explain why in improvementChanges; never invent a rescue or promise success. Do not upgrade the current verdict: these are future hypotheses requiring a new debate with fresh evidence. KILL still says not to build the current product; recommend only bounded validation or a manual test of a changed premise.

The startup under evaluation is only the founder brief in the transcript. Do not treat Venture Gauntlet, this software, or the committee product as the idea being judged.

Use GO only when the supplied record supports all five: the pain is real, the product is buildable, the customer has a reason to switch, revenue is plausible, and competition is survivable. Use PIVOT when the problem is real but the customer, product scope, wedge, or business model must change — say exactly which one and how. Use KILL when pain is weak, the customer will not switch or pay, incumbents can crush it, technical risk is too high, it is a feature not a company, or the founder has not answered the core objection. Incomplete input is not a verdict; the adapter rejects it before you speak.

Do not average specialist scores. Do not translate VC INVEST, MAYBE, or PASS into your verdict. MAYBE is not PIVOT. Name the strongest argument, the argument it outweighed, and the weakest assumption. Attribute every change to a supplied challenge, rebuttal, or founder message. If none changed your conclusion, say that it did not change the conclusion. Never invent interviews, research, citations, founder defense, or concessions. Treat simulated customer preference and hypothetical incumbent attacks as assumptions unless the transcript marks them supported.

Return one JSON object. positionLabel and decision.verdict are invest, pivot, or pass — never INVEST, MAYBE, or PASS. fields.displayVerdict is GO, PIVOT, or KILL and must map to that verdict (GO=invest, PIVOT=pivot, KILL=pass). confidence is an integer 0-100 expressing your judgment, not a calibrated success probability. Demand, Buildability, Fundability, and Defensibility are integers 0-10, each with a short reason. killRisks has exactly three distinct strings. The seven-day test names a participant, action, observable result, success threshold, and failure threshold. The 72-hour MVP names the trimmed workflow, what can be manual, and what must work. KILL sets doNotBuild true and tells the founder not to build. PIVOT sets pivotDimension to customer, product, wedge, or business_model and pivotDirection to the exact change. debateChanged is false and changeSource is none when nothing supplied changed the conclusion; otherwise changeSource names the speaker and changeExcerpt quotes that speaker. concessionsCited lists only roles whose rebuttal changed. If the founder sent no message, do not describe a defense.`;

export function registerChair(registry: RoleRegistry = sharedRegistry): void {
  registry.register("chair", CHAIR_INSTRUCTIONS);
}

export function sharedVerdictFor(display: DisplayVerdict): ChairVerdict {
  if (display === "GO") return "invest";
  if (display === "PIVOT") return "pivot";
  return "pass";
}

export function displayVerdictFor(verdict: ChairVerdict): DisplayVerdict {
  if (verdict === "invest") return "GO";
  if (verdict === "pivot") return "PIVOT";
  return "KILL";
}

export function chairVerdictFromScores(_scores: number[]): null {
  return null;
}

export function chairContextGap(run: DebateRun): string | null {
  const brief = validateBrief(run.brief);
  if (!brief.ok) return "The idea brief is missing required fields. No verdict was produced.";
  if (!requiredStagesComplete(run)) {
    return "Required debate stages are missing. No verdict was produced.";
  }
  return null;
}

interface ChairParts {
  display: DisplayVerdict;
  shared: ChairVerdict;
  confidence: number;
  scores: Array<{ label: string; score: number; reason: string }>;
  brutalSummary: string;
  strongestEvidence: string;
  strongestArgument: string;
  outweighedArgument: string;
  weakestAssumption: string;
  biggestUnresolvedRisk: string;
  whatChanged: string;
  evidenceWeighting: string;
  killRisks: string[];
  testText: string;
  mvpText: string;
  finalNote: string;
  founderLine: string;
  decisionRationale: string;
  committeeAgreement: string;
  committeeDisagreement: string;
  influentialAgent: string;
  influentialReason: string;
  goCriteriaText: string;
  improvementText: string;
  stopDoing: string;
  pivotDirection?: string;
  assumptions: RoleEnvelope["assumptions"];
  disagreements: string[];
  unresolvedRisks: string[];
  decisiveReasons: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integer(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return null;
  }
  return value;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const items = value.map((item) => (typeof item === "string" ? item.trim() : ""));
  if (items.some((item) => !item)) return null;
  return items;
}

function blindAverage(value: string): boolean {
  return /\baverage[ds]?\b/i.test(value) && !/did not average|not an average|without averaging/i.test(value);
}

function founderMessages(run: DebateRun): DebateMessage[] {
  return run.messages.filter((message) => message.speaker === "founder");
}

function speakerText(message: DebateMessage): string {
  const envelope = message.envelope;
  const questions = envelope && Array.isArray(envelope.fields.questions) ? envelope.fields.questions : [];
  return [message.body, envelope?.summary, envelope?.rationale, envelope?.changeReason, ...questions]
    .filter((item): item is string => typeof item === "string")
    .join("\n");
}

function latestSpecialistLabels(run: DebateRun): string[] {
  return SPECIALIST_ROLES.map((role) => {
    const rebuttal = [...run.messages].reverse().find(
      (message) => message.speaker === role && message.stage === "rebuttal",
    );
    return rebuttal?.envelope?.positionLabel ?? "";
  }).filter(Boolean);
}

function roleChanged(run: DebateRun, role: string): boolean | null {
  const rebuttal = run.messages.find(
    (message) => message.speaker === role && message.stage === "rebuttal",
  );
  return typeof rebuttal?.envelope?.changed === "boolean" ? rebuttal.envelope.changed : null;
}

function readSharedLabel(label: string): ChairVerdict | null {
  if (label === "INVEST" || label === "MAYBE" || label === "PASS") return null;
  if ((DISPLAY_VERDICTS as readonly string[]).includes(label)) {
    return sharedVerdictFor(label as DisplayVerdict);
  }
  const lower = label.toLowerCase();
  if (lower === "invest" || lower === "pivot" || lower === "pass") return lower;
  return null;
}

function founderLine(run: DebateRun): string {
  const messages = founderMessages(run);
  if (messages.length === 0) return "The founder offered no defense.";
  return `Founder defense supplied: "${messages.map((message) => message.body).join(" ")}"`;
}

function contradictsFounder(run: DebateRun, value: string): boolean {
  const supplied = founderMessages(run).length > 0;
  if (!supplied && /founder (said|defended|showed|proved|provided|demonstrated)/i.test(value)) {
    return !/offered no defense|no founder defense|did not defend/i.test(value);
  }
  if (supplied && /offered no defense|no founder defense/i.test(value)) return true;
  return false;
}

export function formatChairVerdict(parts: ChairParts): string {
  const scores = parts.scores
    .map((item) => `${item.label}: ${item.score}/10 — ${item.reason}`)
    .join("\n");
  const risks = parts.killRisks.map((risk, index) => `${index + 1}. ${risk}`).join("\n");
  const changed = [
    parts.whatChanged,
    parts.founderLine,
    `The strongest argument was ${parts.strongestArgument}. It outweighed ${parts.outweighedArgument} because ${parts.evidenceWeighting}`,
    `Weakest assumption: ${parts.weakestAssumption}`,
  ].join(" ");
  const sections = [
    "# INVESTMENT COMMITTEE CHAIR OUTPUT",
    `FINAL VERDICT:\n${parts.display}`,
    `CONFIDENCE:\n${parts.confidence}%`,
    `SCORES:\n${scores}`,
    `BRUTAL ONE-LINE SUMMARY:\n${parts.brutalSummary}`,
    `FINAL DECISION RATIONALE:\n${parts.decisionRationale}`,
    `WHAT THE COMMITTEE AGREED ON:\n${parts.committeeAgreement}`,
    `WHAT THE COMMITTEE DISAGREED ON:\n${parts.committeeDisagreement}`,
    `STRONGEST EVIDENCE:\n${parts.strongestEvidence}`,
    `WEAKEST ASSUMPTION:\n${parts.weakestAssumption}`,
    `WHAT CHANGED DURING DEBATE:\n${changed}`,
    `MOST INFLUENTIAL AGENT:\n${ROLE_LABEL[parts.influentialAgent]} — ${parts.influentialReason}`,
    `TOP 3 KILL RISKS:\n${risks}`,
    `CHEAPEST VALIDATION TEST THIS WEEK:\n${parts.testText}`,
    `RECOMMENDED 72-HOUR MVP:\n${parts.mvpText}`,
    `GO CRITERIA:\n${parts.goCriteriaText}\n\n${parts.improvementText}`,
    `PIVOT DIRECTION:\n${parts.display === "PIVOT" ? parts.pivotDirection : parts.display === "KILL" ? "Do not build the current idea. Test only the conditional changes described above; no upgrade is earned yet." : "No pivot required by this verdict. Validate the GO criteria before scaling."}`,
    `STOP DOING:\n${parts.stopDoing}`,
    `FINAL COMMITTEE NOTE:\n${parts.finalNote}`,
  ];
  return sections.join("\n\n");
}

export function parseFormattedChair(raw: string): { ok: true; display: DisplayVerdict; confidence: number; scores: number[] } | { ok: false; message: string } {
  const labels = [...raw.matchAll(/^([A-Z][A-Z 0-9-]+):$/gm)].map((match) => match[1]);
  if (labels.length !== CHAIR_SECTION_LABELS.length || labels.some((label, index) => label !== CHAIR_SECTION_LABELS[index])) {
    return { ok: false, message: "The Chair output must use exactly the required sections in order." };
  }
  const indexes = CHAIR_SECTION_LABELS.map((label) => raw.indexOf(`${label}:`));
  if (indexes.some((index) => index < 0)) {
    return { ok: false, message: "The Chair output is missing a required section." };
  }
  for (let i = 1; i < indexes.length; i += 1) {
    if (indexes[i] <= indexes[i - 1]) {
      return { ok: false, message: "The Chair sections are out of order." };
    }
  }
  const verdict = raw.match(/FINAL VERDICT:\s*(GO|PIVOT|KILL)\b/);
  const confidence = raw.match(/CONFIDENCE:\s*(\d{1,3})%/);
  if (!verdict || !confidence) {
    return { ok: false, message: "The Chair verdict line is malformed." };
  }
  const parsedConfidence = Number(confidence[1]);
  if (!Number.isInteger(parsedConfidence) || parsedConfidence > 100) {
    return { ok: false, message: "Investment confidence must be an integer percentage from 0 to 100." };
  }
  const scores = ["Demand", "Buildability", "Fundability", "Defensibility"].map((label) => {
    const match = raw.match(new RegExp(`${label}:\\s*(\\d{1,2})/10\\s+—\\s+\\S`));
    return match ? Number(match[1]) : null;
  });
  if (scores.some((score) => score == null || score > 10)) {
    return { ok: false, message: "Each Chair score needs an integer from 0 to 10 and a justification." };
  }
  const riskLines = raw.split("TOP 3 KILL RISKS:")[1]?.split("CHEAPEST VALIDATION TEST THIS WEEK:")[0] ?? "";
  const risks = [...riskLines.matchAll(/^\d+\.\s+\S.+$/gm)].map((match) => match[0]);
  if (risks.length !== 3) {
    return { ok: false, message: "The Chair must list exactly three kill risks." };
  }
  return {
    ok: true,
    display: verdict[1] as DisplayVerdict,
    confidence: parsedConfidence,
    scores: scores as number[],
  };
}

function fail(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

export function normalizeChairPayload(
  run: DebateRun,
  raw: string,
): { ok: true; raw: string; formatted: string } | { ok: false; message: string } {
  const gap = chairContextGap(run);
  if (gap) return fail(gap);
  let parsed: unknown;
  try {
    parsed = parseModelJson(raw);
  } catch {
    return fail("The model response was not valid JSON.");
  }
  const record = asRecord(parsed);
  if (!record) return fail("The model response must be a JSON object.");
  if ("citations" in record || "sources" in record) {
    return fail("Generated citations are not accepted.");
  }
  const fields = asRecord(record.fields);
  const decision = asRecord(record.decision);
  if (!fields || !decision) return fail("The Chair response is missing structured fields.");

  const displayText = text(fields.displayVerdict);
  if (!(DISPLAY_VERDICTS as readonly string[]).includes(displayText)) {
    return fail("The Chair display verdict must be GO, PIVOT, or KILL.");
  }
  const display = displayText as DisplayVerdict;
  const fromLabel = readSharedLabel(text(record.positionLabel));
  const decisionVerdict = text(decision.verdict);
  if (fromLabel == null || (decisionVerdict !== "invest" && decisionVerdict !== "pivot" && decisionVerdict !== "pass")) {
    return fail("The Chair verdict is invalid or copies a VC position.");
  }
  const shared = sharedVerdictFor(display);
  if (fromLabel !== shared || decisionVerdict !== shared) {
    return fail("Structured Chair fields disagree with the formatted verdict.");
  }

  const confidence = integer(fields.confidence, 0, 100);
  const scoreFields = [
    ["Demand", "demand", "demandReason"],
    ["Buildability", "buildability", "buildabilityReason"],
    ["Fundability", "fundability", "fundabilityReason"],
    ["Defensibility", "defensibility", "defensibilityReason"],
  ] as const;
  const scores = scoreFields.map(([label, scoreKey, reasonKey]) => ({
    label,
    score: integer(fields[scoreKey], 0, 10),
    reason: text(fields[reasonKey]),
  }));
  if (confidence == null || scores.some((item) => item.score == null || item.reason.length < 8)) {
    return fail("Chair confidence or scores are missing or out of range.");
  }

  const brutalSummary = text(fields.brutalSummary);
  const strongestEvidence = text(fields.strongestEvidence);
  const strongestArgument = text(fields.strongestArgument);
  const outweighedArgument = text(fields.outweighedArgument);
  const weakestAssumption = text(fields.weakestAssumption);
  const biggestUnresolvedRisk = text(fields.biggestUnresolvedRisk);
  const whatChanged = text(fields.whatChanged);
  const evidenceWeighting = text(fields.evidenceWeighting);
  const finalNote = text(fields.finalNote);
  const decisionRationale = text(fields.decisionRationale);
  const committeeAgreement = text(fields.committeeAgreement);
  const committeeDisagreement = text(fields.committeeDisagreement);
  const influentialAgent = text(fields.influentialAgent);
  const influentialReason = text(fields.influentialReason);
  const influentialExcerpt = text(fields.influentialExcerpt);
  const stopDoing = text(fields.stopDoing);
  const sentenceCount = decisionRationale.split(/[.!?]+(?:\s+|$)/).filter((sentence) => sentence.trim()).length;
  if (sentenceCount < 2 || sentenceCount > 3 || [committeeAgreement, committeeDisagreement, influentialReason, stopDoing].some((value) => value.length < 12)) {
    return fail("The expanded Chair report needs a 2–3 sentence rationale, agreement, disagreement, agent influence, and stop-doing guidance.");
  }
  if (![...SPECIALIST_ROLES, "red_team"].includes(influentialAgent) || influentialExcerpt.length < 8 || !run.messages.some((message) => message.speaker === influentialAgent && speakerText(message).includes(influentialExcerpt))) {
    return fail("The most influential agent must quote an actual supplied agent contribution.");
  }
  const criteriaArrays = ["goCriteria", "goCriteriaTests", "goCriteriaPass", "goCriteriaFail"].map((key) => stringList(fields[key]));
  if (criteriaArrays.some((items) => !items || items.length !== 3 || items.some((item) => item.length < 8)) || new Set(criteriaArrays[0]).size !== 3) {
    return fail("GO criteria require exactly three distinct claims, each with a concrete test and pass/fail thresholds.");
  }
  const [criteria, criteriaTests, criteriaPass, criteriaFail] = criteriaArrays as string[][];
  const goCriteriaText = criteria.map((criterion, index) => `${index + 1}. ${criterion} Test: ${criteriaTests[index]} Success: ${criteriaPass[index]} Failure: ${criteriaFail[index]}`).join("\n");
  const expectedTargets = display === "KILL" ? ["PIVOT", "GO"] : ["GO"];
  const improvementArrays = ["improvementTargets", "improvementStatus", "improvementChanges", "improvementEvidence", "improvementSuccess", "improvementFailure"].map((key) => stringList(fields[key]));
  if (improvementArrays.some((items) => !items || items.length !== expectedTargets.length)) {
    return fail("Improvement feedback must include every required verdict path and its evidence and thresholds.");
  }
  const [targets, statuses, changes, evidence, successes, failures] = improvementArrays as string[][];
  if (targets.some((target, index) => target !== expectedTargets[index]) || statuses.some((status) => status !== "conditional" && status !== "unavailable")) {
    return fail("Improvement paths must preserve the current verdict and identify conditional or unavailable routes.");
  }
  if (changes.some((change, index) => change.length < 12 || (statuses[index] === "conditional" && [evidence[index], successes[index], failures[index]].some((value) => value.length < 8)))) {
    return fail("A conditional improvement needs an exact change, new evidence, and observable pass/fail thresholds.");
  }
  const improvementText = targets.map((target, index) => {
    const route = display === "GO" ? "Maintain GO" : `${display} → ${target}`;
    return statuses[index] === "unavailable"
      ? `${route}: No credible path identified. ${changes[index]}`
      : `${route} (conditional): ${changes[index]} Evidence required: ${evidence[index]} Success: ${successes[index]} Failure: ${failures[index]} Reassess in a new debate; the current verdict remains ${display}.`;
  }).join("\n\n");
  if (
    brutalSummary.length < 12 ||
    strongestEvidence.length < 12 ||
    strongestArgument.length < 8 ||
    outweighedArgument.length < 8 ||
    strongestArgument.toLowerCase() === outweighedArgument.toLowerCase() ||
    weakestAssumption.length < 8 ||
    biggestUnresolvedRisk.length < 8 ||
    whatChanged.length < 12 ||
    evidenceWeighting.length < 24 ||
    finalNote.length < 12
  ) {
    return fail("The Chair response is missing a required section.");
  }
  if (blindAverage(evidenceWeighting) || blindAverage(text(record.rationale))) {
    return fail("The Chair must not average specialist scores.");
  }
  if (contradictsFounder(run, `${whatChanged}\n${text(record.rationale)}\n${finalNote}`)) {
    return fail("The Chair invented or erased founder defense.");
  }

  const killRisks = stringList(fields.killRisks);
  if (!killRisks || killRisks.length !== 3) return fail("The Chair must list exactly three kill risks.");
  if (new Set(killRisks.map((risk) => risk.toLowerCase())).size !== 3) {
    return fail("Kill risks must be distinct.");
  }

  const debateChanged = fields.debateChanged;
  const changeSource = text(fields.changeSource);
  if (typeof debateChanged !== "boolean" || !(CHANGE_SOURCES as readonly string[]).includes(changeSource)) {
    return fail("The Chair must say whether the debate changed the conclusion.");
  }
  const source = changeSource as ChangeSource;
  if (!debateChanged) {
    if (source !== "none" || !/did not change the conclusion/i.test(whatChanged)) {
      return fail("Unchanged Chair reasoning must say the conclusion did not change.");
    }
  } else {
    const excerpt = text(fields.changeExcerpt);
    const matches = run.messages.some((message) => message.speaker === source &&
      speakerText(message).toLowerCase().includes(excerpt.toLowerCase()));
    if (source === "none" || excerpt.length < 8 || !matches) {
      return fail("Debate-change reasoning must quote a supplied contribution.");
    }
  }
  if (/conceded/i.test(whatChanged) && !Array.isArray(fields.concessionsCited)) {
    return fail("The Chair invented a concession.");
  }
  if (Array.isArray(fields.concessionsCited)) {
    for (const role of fields.concessionsCited) {
      if (typeof role !== "string" || roleChanged(run, role) !== true) {
        return fail("The Chair invented a concession.");
      }
    }
  }

  const participant = text(fields.testParticipant);
  const action = text(fields.testAction);
  const observable = text(fields.testObservable);
  const success = text(fields.testSuccess);
  const failure = text(fields.testFailure);
  const testDays = integer(fields.testDays, 1, 7);
  if (!participant || !action || !observable || !success || !failure || testDays == null) {
    return fail("The seven-day test needs a participant, action, observable result, and pass/fail threshold.");
  }
  const testText = `Within ${testDays} days, ask ${participant} to ${action}. Observe ${observable}. Success: ${success}. Failure: ${failure}.`;

  const doNotBuild = fields.doNotBuild === true;
  const workflow = text(fields.mvpWorkflow);
  const manual = text(fields.mvpManual);
  const mustWork = text(fields.mvpMustWork);
  const mvpHours = integer(fields.mvpHours, 0, 72);
  const disconfirmation = text(fields.disconfirmation);
  let mvpText = "";
  if (display === "KILL") {
    if (!doNotBuild || !text(fields.fatalObjection)) {
      return fail("KILL must name the fatal objection and tell the founder not to build.");
    }
    if (disconfirmation) {
      if (mvpHours == null || mvpHours < 1 || mvpHours > 72 || !/disconfirmation/i.test(disconfirmation)) {
        return fail("A KILL disconfirmation prototype must stay inside 72 hours.");
      }
      mvpText = `Do not build the product. Bounded disconfirmation prototype only, within ${mvpHours} hours: ${disconfirmation}`;
    } else {
      mvpText = "Do not build.";
    }
  } else if (mvpHours == null || mvpHours < 1 || !workflow || !manual || !mustWork) {
    return fail("The 72-hour MVP needs a trimmed workflow, a manual part, and what must work.");
  } else {
    mvpText = `Within ${mvpHours} hours, build only this workflow: ${workflow}. Manual: ${manual}. Must work: ${mustWork}.`;
  }

  const pivotDimension = text(fields.pivotDimension);
  const pivotDirection = text(decision.pivotDirection) || text(fields.pivotDirection);
  if (display === "PIVOT") {
    if (!(PIVOT_DIMENSIONS as readonly string[]).includes(pivotDimension) || pivotDirection.length < 12) {
      return fail("PIVOT must name the exact customer, product, wedge, or business-model change.");
    }
    if (!finalNote.includes(pivotDirection)) {
      return fail("The committee note must tell the founder the exact pivot.");
    }
  } else if (pivotDirection) {
    return fail("pivotDirection is only valid for PIVOT.");
  }
  if (display === "GO") {
    const reasons = ["goPain", "goBuildable", "goSwitch", "goRevenue", "goCompetition"].map((key) => text(fields[key]));
    if (reasons.some((reason) => reason.length < 12 || /^(unknown|none|n\/a|no evidence|unproven)$/i.test(reason))) {
      return fail("GO requires evidence-backed reasoning for pain, buildability, switching, revenue, and competition.");
    }
  }
  if (display === "KILL" && !/do not build|stop/i.test(finalNote)) {
    return fail("KILL must tell the founder not to build.");
  }

  const disagreements = stringList(decision.disagreements);
  const unresolvedRisks = stringList(decision.unresolvedRisks);
  const modelReasons = stringList(decision.decisiveReasons);
  const modelSteps = stringList(decision.nextSteps);
  if (!disagreements || !unresolvedRisks || !modelReasons || !modelSteps) {
    return fail("The Chair decision is incomplete.");
  }
  if (!unresolvedRisks.some((risk) => risk.includes(biggestUnresolvedRisk) || biggestUnresolvedRisk.includes(risk))) {
    return fail("The biggest unresolved risk must appear in the structured decision.");
  }
  const labels = latestSpecialistLabels(run);
  if (new Set(labels).size > 1) {
    const named = Object.values(ROLE_LABEL).filter((label) => disagreements.join(" ").includes(label));
    if (named.length < 2) return fail("The Chair must resolve the specialists' disagreement.");
  }
  if (text(fields.formattedVerdict)) {
    const supplied = parseFormattedChair(text(fields.formattedVerdict));
    if (!supplied.ok || supplied.display !== display || supplied.confidence !== confidence || supplied.scores.some((score, index) => score !== scores[index].score)) {
      return fail("Structured Chair fields disagree with the formatted verdict.");
    }
  }

  const assumptions = record.assumptions;
  if (!Array.isArray(assumptions)) return fail("The Chair response is missing assumptions.");
  const founderFact = founderLine(run);
  const goReasons = ["goPain", "goBuildable", "goSwitch", "goRevenue", "goCompetition"].map((key) => text(fields[key])).filter(Boolean);
  const decisiveReasons = display === "GO" ? goReasons : display === "KILL" ? [text(fields.fatalObjection), ...modelReasons] : [pivotDirection, ...modelReasons];
  const parts: ChairParts = {
    decisionRationale,
    committeeAgreement,
    committeeDisagreement,
    influentialAgent,
    influentialReason,
    goCriteriaText,
    improvementText,
    stopDoing,
    display,
    shared,
    confidence,
    scores: scores as ChairParts["scores"],
    brutalSummary,
    strongestEvidence,
    strongestArgument,
    outweighedArgument,
    weakestAssumption,
    biggestUnresolvedRisk,
    whatChanged,
    evidenceWeighting,
    killRisks,
    testText,
    mvpText,
    finalNote,
    founderLine: founderFact,
    ...(display === "PIVOT" ? { pivotDirection } : {}),
    assumptions: [],
    disagreements,
    unresolvedRisks,
    decisiveReasons,
  };
  const formatted = formatChairVerdict(parts);
  const checked = parseFormattedChair(formatted);
  if (!checked.ok || checked.display !== display || sharedVerdictFor(checked.display) !== shared) {
    return fail("Structured Chair fields disagree with the formatted verdict.");
  }

  const canonical = {
    summary: formatted,
    rationale: decisionRationale,
    assumptions,
    risks: killRisks,
    positionLabel: shared,
    fields: {
      ...fields,
      displayVerdict: display,
      confidence,
      formattedVerdict: formatted,
      doNotBuild: display === "KILL",
    },
    decision: {
      verdict: shared,
      decisiveReasons,
      disagreements,
      unresolvedRisks,
      nextSteps: [testText, mvpText, goCriteriaText, improvementText, `Stop doing: ${stopDoing}`],
      ...(display === "PIVOT" ? { pivotDirection } : {}),
    },
  };
  return { ok: true, raw: JSON.stringify(canonical), formatted };
}

export function chairDossier(run: DebateRun): string {
  const lines = [
    "CHAIR DOSSIER",
    "Judge only the founder brief below. Do not evaluate Venture Gauntlet itself.",
    "Do not average scores. Do not translate VC INVEST, MAYBE, or PASS.",
    founderLine(run),
  ];
  for (const message of run.messages) {
    const envelope = message.envelope;
    const score = envelope?.vc
      ? ` openingOrRevisedScore ${envelope.vc.score} positionWas ${envelope.vc.investmentPosition}`
      : "";
    const changed = envelope?.changed == null ? "" : ` changed=${envelope.changed} because ${envelope.changeReason ?? ""}`;
    const questions = envelope && Array.isArray(envelope.fields.questions)
      ? ` questions ${envelope.fields.questions.join(" | ")}`
      : "";
    lines.push(
      `[${message.stage}] ${message.speaker}${score}${changed} position ${envelope?.positionLabel ?? "none"}: ${message.body}${questions}`,
    );
    for (const claim of envelope?.assumptions ?? []) {
      lines.push(`Claim (${claim.grounding}): ${claim.statement}`);
    }
  }
  return lines.join("\n");
}

function reject(run: DebateRun, error: DebateFailure): DebateResult {
  return { ok: false, error, value: failTurn(run, error) };
}

export async function runChairTurn(
  run: DebateRun,
  client: ModelClient | null,
  registry: RoleRegistry = sharedRegistry,
): Promise<DebateResult> {
  const gap = chairContextGap(run);
  if (gap) {
    return reject(run, {
      code: "incomplete_context",
      message: gap,
      phase: run.phase,
      role: "chair",
    });
  }
  const started = beginTurn(run, "chair");
  if (!started.ok || !started.value.lock) return started;
  const locked = started.value;
  const generated = await generateContribution(
    locked,
    "chair",
    "verdict",
    registry,
    client,
    chairDossier(locked),
  );
  if (!generated.ok) {
    return reject(locked, {
      code: generated.error.code,
      message: generated.error.message,
      phase: locked.phase,
      role: "chair",
    });
  }
  const normalized = normalizeChairPayload(locked, generated.raw);
  if (!normalized.ok) {
    return reject(locked, {
      code: "invalid_response",
      message: normalized.message,
      phase: locked.phase,
      role: "chair",
    });
  }
  return completeTurn(locked, normalized.raw);
}

export function chairRoleId(): RoleId {
  return "chair";
}
