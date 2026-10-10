import type { IdeaBrief } from "./brief";
import {
  SPECIALIST_ROLES,
  SPECIALIST_SCORE_SPECS,
  getPrimaryScore,
  isSpecialist,
  parseContribution,
  type ContributionStage,
  type RoleEnvelope,
  type RoleId,
  type SpecialistRole,
} from "./contract";

export type Phase =
  | "assessments"
  | "challenge"
  | "rebuttals"
  | "founder"
  | "verdict"
  | "complete";

export interface DebateFailure {
  code:
    | "overlap"
    | "duplicate"
    | "premature_verdict"
    | "wrong_phase"
    | "incomplete"
    | "invalid_response"
    | "missing_credentials"
    | "provider_failure"
    | "timeout"
    | "role_not_configured"
    | "incomplete_context";
  message: string;
  phase?: Phase;
  role?: RoleId;
}

export interface DebateMessage {
  id: string;
  speaker: RoleId | "founder";
  stage: ContributionStage | "founder";
  body: string;
  envelope?: RoleEnvelope;
  createdAt: string;
}

export interface DebateRun {
  id: string;
  brief: IdeaBrief;
  messages: DebateMessage[];
  phase: Phase;
  lock: { role: RoleId; stage: ContributionStage } | null;
  failure: DebateFailure | null;
  verdictRequested: boolean;
}

export interface DebateContext {
  brief: IdeaBrief;
  messages: DebateMessage[];
  phase: Phase;
  verdictRequested: boolean;
}

export type DebateResult =
  | { ok: true; value: DebateRun }
  | { ok: false; error: DebateFailure; value: DebateRun };

const REQUIRED_PHASES: Phase[] = ["assessments", "challenge", "rebuttals"];

function failure(
  run: DebateRun,
  error: DebateFailure,
): DebateResult {
  return { ok: false, error, value: run };
}

function id(): string {
  return crypto.randomUUID();
}

export function createRun(brief: IdeaBrief): DebateRun {
  return {
    id: id(),
    brief: { ...brief },
    messages: [],
    phase: "assessments",
    lock: null,
    failure: null,
    verdictRequested: false,
  };
}

export function contextSnapshot(run: DebateRun): DebateContext {
  return {
    brief: { ...run.brief },
    messages: run.messages.map((message) => ({ ...message })),
    phase: run.phase,
    verdictRequested: run.verdictRequested,
  };
}

function stageFor(phase: Phase): ContributionStage | null {
  if (phase === "assessments") return "assessment";
  if (phase === "challenge") return "challenge";
  if (phase === "rebuttals") return "rebuttal";
  if (phase === "founder") return "founder_response";
  if (phase === "verdict") return "verdict";
  return null;
}

function hasContribution(run: DebateRun, role: RoleId, stage: ContributionStage): boolean {
  return run.messages.some(
    (message) => message.speaker === role && message.stage === stage && message.envelope,
  );
}

function specialistsDone(run: DebateRun, stage: ContributionStage): boolean {
  return SPECIALIST_ROLES.every((role) => hasContribution(run, role, stage));
}

export function requiredStagesComplete(run: DebateRun): boolean {
  return (
    specialistsDone(run, "assessment") &&
    hasContribution(run, "red_team", "challenge") &&
    specialistsDone(run, "rebuttal")
  );
}

function nextPhase(run: DebateRun): Phase {
  if (run.phase === "assessments" && specialistsDone(run, "assessment")) return "challenge";
  if (run.phase === "challenge" && hasContribution(run, "red_team", "challenge")) {
    return "rebuttals";
  }
  if (run.phase === "rebuttals" && specialistsDone(run, "rebuttal")) return "founder";
  if (run.phase === "verdict" && hasContribution(run, "chair", "verdict")) return "complete";
  return run.phase;
}

export function beginTurn(run: DebateRun, role: RoleId): DebateResult {
  if (run.lock) {
    return failure(run, {
      code: "overlap",
      message: "A generation is already in progress.",
      phase: run.phase,
      role: run.lock.role,
    });
  }
  if (run.failure) {
    return failure(run, {
      code: "incomplete",
      message: "Retry the failed step before starting another generation.",
      phase: run.phase,
      role: run.failure.role,
    });
  }
  const stage = stageFor(run.phase);
  if (!stage || run.phase === "complete") {
    return failure(run, {
      code: "wrong_phase",
      message: "This debate is not accepting another generation.",
      phase: run.phase,
    });
  }
  if (run.phase === "assessments" && (!isSpecialist(role) || hasContribution(run, role, stage))) {
    return failure(run, {
      code: hasContribution(run, role, "assessment") ? "duplicate" : "wrong_phase",
      message: hasContribution(run, role, "assessment")
        ? "That assessment is already recorded."
        : "Only the four specialists open the debate.",
      phase: run.phase,
      role,
    });
  }
  if (run.phase === "challenge" && role !== "red_team") {
    return failure(run, {
      code: "wrong_phase",
      message: "Red Team challenges only after the opening assessments.",
      phase: run.phase,
      role,
    });
  }
  if (run.phase === "rebuttals" && (!isSpecialist(role) || hasContribution(run, role, "rebuttal"))) {
    return failure(run, {
      code: hasContribution(run, role, "rebuttal") ? "duplicate" : "wrong_phase",
      message: hasContribution(run, role, "rebuttal")
        ? "That rebuttal is already recorded."
        : "Only the four specialists rebut the challenge.",
      phase: run.phase,
      role,
    });
  }
  if (run.phase === "founder" && role === "chair") {
    return failure(run, {
      code: "wrong_phase",
      message: "The Chair waits for an explicit verdict request.",
      phase: run.phase,
      role,
    });
  }
  if (run.phase === "verdict") {
    if (!run.verdictRequested || role !== "chair") {
      return failure(run, {
        code: "premature_verdict",
        message: "The Chair runs only after an explicit verdict request.",
        phase: run.phase,
        role,
      });
    }
  }
  return {
    ok: true,
    value: { ...run, lock: { role, stage } },
  };
}

export function completeTurn(run: DebateRun, raw: string): DebateResult {
  if (!run.lock) {
    return failure(run, {
      code: "wrong_phase",
      message: "No generation is waiting to be recorded.",
      phase: run.phase,
    });
  }
  const { role, stage } = run.lock;
  if (stage === "verdict_chat") {
    return failure(run, { code: "wrong_phase", message: "Chair chat is separate from the debate record.", role });
  }
  if (hasContribution(run, role, stage) && stage !== "founder_response") {
    return failure(run, {
      code: "duplicate",
      message: "That contribution is already recorded.",
      phase: run.phase,
      role,
    });
  }
  const parsed = parseContribution(role, stage, raw);
  if (!parsed.ok) {
    const error: DebateFailure = {
      code: "invalid_response",
      message: parsed.error.message,
      phase: run.phase,
      role,
    };
    return { ok: false, error, value: failTurn(run, error) };
  }
  if (stage === "rebuttal" && (role === "customer" || role === "engineer")) {
    const opening = run.messages.find((item) => item.speaker === role && item.stage === "assessment");
    const initial = opening?.envelope ? getPrimaryScore(opening.envelope) : null;
    const revised = getPrimaryScore(parsed.value);
    if (initial !== null && revised !== null && parsed.value.changed === false && initial !== revised) {
      const error: DebateFailure = {
        code: "invalid_response",
        message: "An unchanged recommendation must retain its opening score.",
        phase: run.phase,
        role,
      };
      return { ok: false, error, value: failTurn(run, error) };
    }
  }
  if (stage === "challenge") {
    const targeted = parsed.value.fields.targetedRoles;
    const assessments = new Set(
      run.messages
        .filter((message) => message.stage === "assessment")
        .map((message) => message.speaker),
    );
    if (
      !Array.isArray(targeted) ||
      targeted.some((item) => !assessments.has(item as SpecialistRole))
    ) {
      const error: DebateFailure = {
        code: "invalid_response",
        message: "Red Team must challenge roles that already assessed the idea.",
        phase: run.phase,
        role,
      };
      return { ok: false, error, value: failTurn(run, error) };
    }
  }
  const message: DebateMessage = {
    id: id(),
    speaker: role,
    stage,
    body: parsed.value.summary,
    envelope: parsed.value,
    createdAt: new Date().toISOString(),
  };
  const next: DebateRun = {
    ...run,
    messages: [...run.messages, message],
    lock: null,
    failure: null,
  };
  next.phase = nextPhase(next);
  return { ok: true, value: next };
}

export function failTurn(run: DebateRun, error: DebateFailure): DebateRun {
  return {
    ...run,
    lock: null,
    failure: { ...error, phase: error.phase ?? run.phase, role: error.role ?? run.lock?.role },
  };
}

export function retryTurn(run: DebateRun): DebateResult {
  if (run.lock) {
    return failure(run, {
      code: "overlap",
      message: "Wait for the current generation before retrying.",
      phase: run.phase,
    });
  }
  if (!run.failure) {
    return failure(run, {
      code: "wrong_phase",
      message: "There is no failed step to retry.",
      phase: run.phase,
    });
  }
  return { ok: true, value: { ...run, failure: null } };
}

export function addFounderInput(run: DebateRun, text: string): DebateResult {
  const body = text.trim();
  if (!body) {
    return failure(run, {
      code: "invalid_response",
      message: "Enter a question or piece of evidence.",
      phase: run.phase,
    });
  }
  if (run.lock) {
    return failure(run, {
      code: "overlap",
      message: "Wait for the current generation before sending another message.",
      phase: run.phase,
    });
  }
  if (run.phase !== "founder") {
    return failure(run, {
      code: "wrong_phase",
      message: "Founder questions open after the rebuttals.",
      phase: run.phase,
    });
  }
  if (run.failure && REQUIRED_PHASES.includes(run.phase)) {
    return failure(run, {
      code: "incomplete",
      message: "Resolve the failed step before continuing.",
      phase: run.phase,
    });
  }
  const message: DebateMessage = {
    id: id(),
    speaker: "founder",
    stage: "founder",
    body,
    createdAt: new Date().toISOString(),
  };
  return {
    ok: true,
    value: { ...run, messages: [...run.messages, message], failure: null },
  };
}

export function requestVerdict(run: DebateRun): DebateResult {
  if (run.lock) {
    return failure(run, {
      code: "overlap",
      message: "Wait for the current generation before requesting a verdict.",
      phase: run.phase,
    });
  }
  if (run.phase === "complete" || hasContribution(run, "chair", "verdict")) {
    return failure(run, {
      code: "duplicate",
      message: "A verdict is already recorded.",
      phase: run.phase,
    });
  }
  if (!requiredStagesComplete(run) || run.phase === "assessments" || run.phase === "challenge" || run.phase === "rebuttals") {
    return failure(run, {
      code: "premature_verdict",
      message: "The Chair cannot run before assessments, the challenge, and rebuttals finish.",
      phase: run.phase,
    });
  }
  if (run.failure && run.failure.phase && REQUIRED_PHASES.includes(run.failure.phase)) {
    return failure(run, {
      code: "incomplete",
      message: "A failed required stage cannot produce a verdict.",
      phase: run.phase,
    });
  }
  return {
    ok: true,
    value: {
      ...run,
      phase: "verdict",
      verdictRequested: true,
      failure: null,
    },
  };
}

export function renderContext(context: DebateContext): string {
  const lines = [
    "FOUNDER BRIEF",
    `Idea: ${context.brief.idea}`,
    `Problem: ${context.brief.problem}`,
    `Target customer: ${context.brief.targetCustomer}`,
    `Solution: ${context.brief.solution}`,
    `Business model: ${context.brief.businessModel}`,
  ];
  if (context.brief.traction) lines.push(`Traction (founder-provided): ${context.brief.traction}`);
  if (context.brief.founderEvidence) {
    lines.push(`Founder evidence: ${context.brief.founderEvidence}`);
  }
  lines.push("", "DISCUSSION SO FAR");
  if (context.messages.length === 0) lines.push("(none)");
  for (const message of context.messages) {
    lines.push(`[${message.stage}] ${message.speaker}: ${message.body}`);
    if (message.envelope?.positionLabel) {
      lines.push(`Position: ${message.envelope.positionLabel}`);
    }
    if (message.envelope && isSpecialist(message.envelope.role)) {
      const score = getPrimaryScore(message.envelope);
      if (score !== null) {
        const { field, max } = SPECIALIST_SCORE_SPECS[message.envelope.role];
        lines.push(`Primary score (${field}): ${score}/${max}`);
      }
      if (message.envelope.stage === "assessment") {
        lines.push(`Assessment reasoning: ${message.envelope.rationale}`);
        message.envelope.risks.forEach((risk, index) => {
          lines.push(`${index === 0 ? "Biggest risk" : "Risk"}: ${risk}`);
        });
      }
    }
    for (const claim of message.envelope?.assumptions ?? []) {
      lines.push(`Claim (${claim.grounding}): ${claim.statement}${claim.evidenceNote ? ` Evidence note: ${claim.evidenceNote}` : ""}`);
    }
  }
  return lines.join("\n");
}
