import { describe, expect, it } from "vitest";
import { validateBrief, type IdeaBrief } from "./brief";
import {
  SPECIALIST_ROLES,
  chairVerdictFromVcPosition,
  createRoleRegistry,
  parseContribution,
  type RoleId,
} from "./contract";
import {
  addFounderInput,
  beginTurn,
  completeTurn,
  createRun,
  requestVerdict,
  type DebateRun,
} from "./debate";
import type { ModelClient } from "./provider";
import {
  CHAIR_INSTRUCTIONS,
  chairContextGap,
  chairVerdictFromScores,
  displayVerdictFor,
  normalizeChairPayload,
  parseFormattedChair,
  registerChair,
  runChairTurn,
  sharedVerdictFor,
} from "./chair";

function brief(extra: Partial<IdeaBrief> = {}): IdeaBrief {
  const result = validateBrief({
    idea: "Clinic intake copilot",
    problem: "Front desks lose booked visits to phone tag.",
    targetCustomer: "Independent clinic managers",
    solution: "An assistant that books from inbound calls.",
    businessModel: "Per-location monthly subscription",
    ...extra,
  });
  if (!result.ok) throw new Error("fixture");
  return result.value;
}

function client(reply: string | Error): ModelClient & { calls: number; last: string } {
  const state = { calls: 0, last: "" };
  return Object.assign(state, {
    async complete({ system, user }: { system: string; user: string }) {
      state.calls += 1;
      state.last = `${system}\n${user}`;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
}

function specialist(role: RoleId, position: string, stage: "assessment" | "rebuttal", changed = false) {
  const vcFields = {
    score: position === "PASS" ? 22 : 58,
    investmentPosition: position,
    strongestInvestmentCase: "Missed calls leak collected revenue.",
    biggestFundabilityRisk: "Scheduling incumbents can bundle a receptionist.",
    first100Users: "Sell through the founder's clinic network.",
    killShotQuestion: "Who renews after the pilot?",
    oneLineVerdict: "Real leak, unproven company.",
  };
  return JSON.stringify({
    summary: `${role} says ${position} about switching cost.`,
    rationale: `${role} argued from the brief, not from a market study.`,
    assumptions: [{ statement: `${role} demand beyond the brief is unproven.`, grounding: "assumption" }],
    risks: [`${role} channel may not repeat.`],
    positionLabel: position,
    fields: role === "vc" ? vcFields : role === "red_team"
      ? { targetedRoles: [...SPECIALIST_ROLES], questions: ["Which switching claim is evidenced?"] }
      : {},
    changed: stage === "rebuttal" ? changed : undefined,
    changeReason: stage === "rebuttal" ? "The challenge did not add new evidence." : undefined,
  });
}

function fill(run: DebateRun, role: RoleId, raw: string): DebateRun {
  const started = beginTurn(run, role);
  if (!started.ok) throw new Error(started.error.message);
  const done = completeTurn(started.value, raw);
  if (!done.ok) throw new Error(done.error.message);
  return done.value;
}

function ready(options: { founder?: string; customer?: string; engineer?: string; vcChanged?: boolean } = {}): DebateRun {
  let run = createRun(brief());
  run = fill(run, "vc", specialist("vc", "MAYBE", "assessment"));
  run = fill(run, "customer", specialist("customer", options.customer ?? "skeptical", "assessment"));
  run = fill(run, "competitor", specialist("competitor", "crowded", "assessment"));
  run = fill(run, "engineer", specialist("engineer", options.engineer ?? "buildable", "assessment"));
  const challenge = JSON.stringify({
    summary: "Pilot clinics rarely convert.",
    rationale: "A pilot is not willingness to pay.",
    assumptions: [{ statement: "Conversion is unknown.", grounding: "unknown" }],
    risks: ["The wedge is a feature."],
    positionLabel: "challenge",
    fields: {
      targetedRoles: [...SPECIALIST_ROLES],
      questions: ["Which switching claim is evidenced?"],
    },
  });
  run = fill(run, "red_team", challenge);
  run = fill(run, "vc", specialist("vc", options.vcChanged ? "PASS" : "MAYBE", "rebuttal", options.vcChanged));
  run = fill(run, "customer", specialist("customer", options.customer ?? "skeptical", "rebuttal"));
  run = fill(run, "competitor", specialist("competitor", "crowded", "rebuttal"));
  run = fill(run, "engineer", specialist("engineer", options.engineer ?? "buildable", "rebuttal"));
  if (options.founder) {
    const asked = addFounderInput(run, options.founder);
    if (!asked.ok) throw new Error(asked.error.message);
    run = asked.value;
  }
  const requested = requestVerdict(run);
  if (!requested.ok) throw new Error(requested.error.message);
  return requested.value;
}

function payload(display: "GO" | "PIVOT" | "KILL", extra: Record<string, unknown> = {}) {
  const shared = sharedVerdictFor(display);
  const fields: Record<string, unknown> = {
    displayVerdict: display,
    confidence: display === "KILL" ? 28 : 64,
    demand: 7,
    demandReason: "Missed calls already lose booked visits.",
    buildability: 8,
    buildabilityReason: "Call routing can ship with a human fallback.",
    fundability: display === "KILL" ? 2 : 6,
    fundabilityReason: "Seat revenue is plausible only if clinics renew.",
    defensibility: 3,
    defensibilityReason: "Scheduling incumbents can copy a thin wrapper.",
    brutalSummary: "A real leak, still too easy to copy.",
    strongestEvidence: "Clinics already lose visits to unanswered calls.",
    strongestArgument: "Customer switching friction",
    outweighedArgument: "Engineer buildability optimism",
    weakestAssumption: "Clinics will leave their current scheduler.",
    biggestUnresolvedRisk: "No clinic has prepaid after a pilot.",
    whatChanged: extra.whatChanged ?? "The Red Team challenge did not change the conclusion.",
    evidenceWeighting: "Customer switching friction is grounded in the brief, while buildability does not prove anyone will switch.",
    killRisks: [
      "Clinics will not leave their scheduler.",
      "Incumbents can bundle the workflow.",
      "The first channel may not repeat.",
    ],
    debateChanged: extra.debateChanged ?? false,
    changeSource: extra.changeSource ?? "none",
    changeExcerpt: extra.changeExcerpt,
    concessionsCited: extra.concessionsCited,
    testParticipant: "independent clinic managers",
    testAction: "quote a prepaid monthly price for call booking",
    testObservable: "whether they accept a paid pilot",
    testSuccess: "3 of 10 managers accept a prepaid pilot",
    testFailure: "fewer than 2 managers accept a prepaid pilot",
    testDays: 7,
    mvpWorkflow: "a shared inbox that books one call type",
    mvpManual: "a human confirms the appointment",
    mvpMustWork: "the caller leaves with a booked slot",
    mvpHours: display === "KILL" ? 0 : 48,
    doNotBuild: display === "KILL",
    fatalObjection: "Nobody has shown they will pay to switch.",
    goPain: "The brief shows missed calls lose booked visits.",
    goBuildable: "A narrow call-booking workflow is buildable this week.",
    goSwitch: "Managers lose revenue they already count.",
    goRevenue: "A per-location subscription matches how clinics buy software.",
    goCompetition: "A workflow tied to their reminder list is survivable.",
    pivotDimension: "customer",
    pivotDirection: "Sell to clinic groups, not independent managers.",
    formattedVerdict: extra.formattedVerdict,
    ...((extra.fields as object) ?? {}),
  };
  if (display !== "PIVOT") {
    delete fields.pivotDimension;
    delete fields.pivotDirection;
  }
  const decision: Record<string, unknown> = {
    verdict: shared,
    decisiveReasons: ["The recorded buyer evidence outweighs the build story."],
    disagreements: extra.disagreements ?? ["Customer and Engineer disagree on switching."],
    unresolvedRisks: ["No clinic has prepaid after a pilot."],
    nextSteps: ["Run the prepaid pilot test before writing more software."],
  };
  if (display === "PIVOT") decision.pivotDirection = fields.pivotDirection;
  return JSON.stringify({
    summary: "Committee judgment.",
    rationale: "Weight the switching evidence above the build story.",
    assumptions: [{ statement: "Demand beyond the brief is unproven.", grounding: "assumption" }],
    risks: fields.killRisks,
    positionLabel: shared,
    fields,
    decision,
  });
}

describe("Chair registration and mapping", () => {
  it("keeps GO/PIVOT/KILL mapped without translating VC positions or averaging scores", () => {
    const registry = createRoleRegistry();
    registerChair(registry);
    expect(registry.instructions("chair")).toBe(CHAIR_INSTRUCTIONS);
    expect(CHAIR_INSTRUCTIONS).toContain("Do not average specialist scores");
    expect(CHAIR_INSTRUCTIONS).toContain("Do not treat Venture Gauntlet");
    expect(sharedVerdictFor("GO")).toBe("invest");
    expect(sharedVerdictFor("PIVOT")).toBe("pivot");
    expect(sharedVerdictFor("KILL")).toBe("pass");
    expect(displayVerdictFor("invest")).toBe("GO");
    expect(chairVerdictFromVcPosition("MAYBE")).toBeNull();
    expect(chairVerdictFromVcPosition("INVEST")).toBeNull();
    expect(chairVerdictFromScores([9, 9, 9, 9])).toBeNull();
  });
});

describe("Chair verdicts", () => {
  for (const display of ["GO", "PIVOT", "KILL"] as const) {
    it(`records a provider ${display} verdict in the required format`, async () => {
      const run = ready({
        founder: display === "GO" ? "Three clinics prepaid annual contracts." : undefined,
        customer: "will not switch",
        engineer: "buildable",
      });
      const before = run.messages.length;
      const raw = payload(display, {
        disagreements: ["Customer will not switch. Engineer says it is buildable."],
        whatChanged: display === "GO"
          ? "Founder evidence changed the conclusion."
          : "The Red Team challenge did not change the conclusion.",
        debateChanged: display === "GO",
        changeSource: display === "GO" ? "founder" : "none",
        changeExcerpt: display === "GO" ? "Three clinics prepaid" : undefined,
        fields: display === "PIVOT"
          ? {}
          : {},
      });
      const parsed = JSON.parse(raw) as { fields: Record<string, unknown>; decision: Record<string, unknown> };
      if (display === "PIVOT") {
        parsed.fields.finalNote = "Sell to clinic groups, not independent managers. Stop pitching solo sites.";
        parsed.decision.pivotDirection = "Sell to clinic groups, not independent managers.";
        parsed.fields.pivotDirection = parsed.decision.pivotDirection;
      } else {
        parsed.fields.finalNote = display === "KILL"
          ? "Stop. Do not build this wedge."
          : "Run the prepaid test before you hire.";
      }
      const c = client(JSON.stringify(parsed));
      const result = await runChairTurn(run, c, createRoleRegistry({ chair: CHAIR_INSTRUCTIONS }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(c.calls).toBe(1);
      expect(c.last).toContain("Clinic intake copilot");
      expect(c.last).toContain("Which switching claim is evidenced?");
      expect(c.last).toContain("customer");
      expect(c.last).toContain("engineer");
      expect(result.value.messages.length).toBe(before + 1);
      const envelope = result.value.messages.at(-1)?.envelope;
      expect(envelope?.decision?.verdict).toBe(sharedVerdictFor(display));
      expect(envelope?.positionLabel).toBe(sharedVerdictFor(display));
      expect(envelope?.vc).toBeNull();
      const formatted = String(envelope?.fields.formattedVerdict);
      const read = parseFormattedChair(formatted);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.display).toBe(display);
      expect(formatted.indexOf("FINAL VERDICT")).toBeLessThan(formatted.indexOf("INVESTMENT CONFIDENCE"));
      expect(formatted.indexOf("FINAL COMMITTEE NOTE")).toBeGreaterThan(formatted.indexOf("RECOMMENDED 72-HOUR MVP"));
      expect(formatted).toContain("Demand: ");
      expect(formatted).toContain("Success:");
      expect(formatted).toContain("Failure:");
      expect(formatted).toContain("Within 7 days");
      if (display === "KILL") expect(formatted).toContain("Do not build");
      if (display === "PIVOT") expect(envelope?.decision?.pivotDirection).toContain("clinic groups");
      if (display === "GO") expect(formatted).toContain("Three clinics prepaid");
      else expect(formatted).toContain("The founder offered no defense.");
      expect(envelope?.decision?.verdict).not.toBe(chairVerdictFromVcPosition("MAYBE"));
    });
  }

  it("accepts an explicit unchanged conclusion and rejects a blind average", () => {
    const run = ready();
    const held = normalizeChairPayload(run, payload("KILL", {
      fields: { finalNote: "Stop. Do not build this wedge." },
    }));
    expect(held.ok).toBe(true);
    if (held.ok) expect(held.formatted).toContain("did not change the conclusion");

    const averaged = JSON.parse(payload("KILL", {
      fields: { finalNote: "Stop. Do not build this wedge." },
    })) as { fields: Record<string, string> };
    averaged.fields.evidenceWeighting = "Average of the specialist scores.";
    const rejected = normalizeChairPayload(run, JSON.stringify(averaged));
    expect(rejected.ok).toBe(false);
  });

  it("rejects an invented concession and a VC token used as the Chair label", () => {
    const run = ready();
    const conceded = JSON.parse(payload("PIVOT")) as {
      fields: Record<string, unknown>;
      decision: Record<string, unknown>;
    };
    conceded.fields.whatChanged = "Customer conceded the buyer is wrong.";
    conceded.fields.debateChanged = true;
    conceded.fields.changeSource = "customer";
    conceded.fields.changeExcerpt = "customer says skeptical";
    conceded.fields.concessionsCited = ["customer"];
    conceded.fields.finalNote = "Sell to clinic groups, not independent managers.";
    expect(normalizeChairPayload(run, JSON.stringify(conceded)).ok).toBe(false);

    const copied = JSON.parse(payload("GO")) as { positionLabel: string };
    copied.positionLabel = "INVEST";
    expect(normalizeChairPayload(run, JSON.stringify(copied)).ok).toBe(false);
  });
});

describe("Chair recovery", () => {
  it("returns incomplete context without a score or verdict", async () => {
    const run = createRun(brief());
    expect(chairContextGap(run)).toMatch(/missing/i);
    const c = client(payload("KILL"));
    const missingStage = await runChairTurn(run, c, createRoleRegistry({ chair: CHAIR_INSTRUCTIONS }));
    expect(missingStage.ok).toBe(false);
    if (!missingStage.ok) expect(missingStage.error.code).toBe("incomplete_context");
    expect(c.calls).toBe(0);
    expect(missingStage.value.messages.some((message) => message.stage === "verdict")).toBe(false);

    const broken = createRun({ ...brief(), idea: "short" });
    const missingBrief = await runChairTurn(broken, c, createRoleRegistry({ chair: CHAIR_INSTRUCTIONS }));
    expect(missingBrief.ok).toBe(false);
    if (!missingBrief.ok) expect(missingBrief.error.code).toBe("incomplete_context");
    expect(c.calls).toBe(0);
  });

  it("does not call the provider before the explicit verdict request", async () => {
    let run = ready();
    run = { ...run, phase: "founder", verdictRequested: false };
    const c = client(payload("KILL"));
    const result = await runChairTurn(run, c, createRoleRegistry({ chair: CHAIR_INSTRUCTIONS }));
    expect(result.ok).toBe(false);
    expect(c.calls).toBe(0);
    expect(result.value.messages.some((message) => message.stage === "verdict")).toBe(false);
  });

  it("preserves the debate when credentials, timeout, provider, or malformed output fail", async () => {
    const registry = createRoleRegistry({ chair: CHAIR_INSTRUCTIONS });
    const base = ready();
    const count = base.messages.length;
    const missing = await runChairTurn(base, null, registry);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("missing_credentials");
    expect(missing.value.messages).toHaveLength(count);

    const timed = await runChairTurn(
      ready(),
      client(Object.assign(new Error("The AI provider timed out."), { code: "timeout" })),
      registry,
    );
    expect(timed.ok).toBe(false);
    if (!timed.ok) expect(timed.error.code).toBe("timeout");
    expect(timed.value.messages).toHaveLength(count);

    const failed = await runChairTurn(
      ready(),
      client(Object.assign(new Error("The AI provider returned an error."), { code: "provider_failure" })),
      registry,
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe("provider_failure");

    const malformed = await runChairTurn(ready(), client("{not json"), registry);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("invalid_response");
    expect(malformed.value.messages).toHaveLength(count);
    expect(malformed.value.phase).not.toBe("complete");
  });

  it("rejects out-of-range scores, missing sections, and inconsistent verdicts", () => {
    const run = ready();
    const high = JSON.parse(payload("KILL", { fields: { finalNote: "Stop. Do not build this wedge." } })) as {
      fields: Record<string, unknown>;
      decision: Record<string, unknown>;
    };
    high.fields.confidence = 140;
    expect(normalizeChairPayload(run, JSON.stringify(high)).ok).toBe(false);

    const missing = JSON.parse(payload("KILL", { fields: { finalNote: "Stop. Do not build this wedge." } })) as {
      fields: Record<string, unknown>;
    };
    delete missing.fields.brutalSummary;
    expect(normalizeChairPayload(run, JSON.stringify(missing)).ok).toBe(false);

    const inconsistent = JSON.parse(payload("GO")) as {
      fields: Record<string, unknown>;
      decision: Record<string, unknown>;
    };
    inconsistent.fields.displayVerdict = "GO";
    inconsistent.decision.verdict = "pass";
    inconsistent.fields.finalNote = "Run the prepaid test before you hire.";
    expect(normalizeChairPayload(run, JSON.stringify(inconsistent)).ok).toBe(false);

    const quoted = JSON.parse(payload("KILL", { fields: { finalNote: "Stop. Do not build this wedge." } })) as {
      fields: Record<string, unknown>;
    };
    quoted.fields.formattedVerdict = "FINAL VERDICT: GO\n\nINVESTMENT CONFIDENCE: 10%";
    expect(normalizeChairPayload(run, JSON.stringify(quoted)).ok).toBe(false);
  });

  it("round-trips a normalized verdict through the shared envelope", () => {
    const run = ready({ customer: "will not switch", engineer: "buildable" });
    const normalized = normalizeChairPayload(run, payload("PIVOT", {
      disagreements: ["Customer will not switch. Engineer says it is buildable."],
      fields: { finalNote: "Sell to clinic groups, not independent managers." },
    }));
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const parsed = parseContribution("chair", "verdict", normalized.raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.decision?.verdict).toBe("pivot");
    expect(parsed.value.positionLabel).toBe("pivot");
    expect(String(parsed.value.fields.displayVerdict)).toBe("PIVOT");
    expect(parsed.value.summary).toContain("FINAL VERDICT: PIVOT");
    expect(parsed.value.summary).not.toContain("MAYBE");
  });
});
