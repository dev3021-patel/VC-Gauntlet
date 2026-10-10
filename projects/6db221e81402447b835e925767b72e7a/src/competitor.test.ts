import { describe, expect, it } from "vitest";
import { validateBrief } from "./brief";
import { createRoleRegistry, parseContribution, SPECIALIST_ROLES } from "./contract";
import { addFounderInput, beginTurn, completeTurn, createRun, retryTurn, type DebateRun } from "./debate";
import { buildGenerationPrompt, type ModelClient } from "./provider";
import { COMPETITOR_INSTRUCTIONS, competitorCardFields, registerCompetitorAgent, runCompetitorTurn } from "./competitor";

function newRun(idea = "Clinic intake copilot"): DebateRun {
  const brief = validateBrief({
    idea,
    problem: "Front desks lose hours to phone tag.",
    targetCustomer: "Independent clinic managers",
    solution: "An assistant that books from inbound calls.",
    businessModel: "Per-location monthly subscription",
    traction: "Two pilot clinics",
  });
  if (!brief.ok) throw new Error("fixture");
  return createRun(brief.value);
}

function registry() {
  const stored = createRoleRegistry();
  registerCompetitorAgent(stored);
  return stored;
}

function client(...replies: Array<string | Error>): ModelClient & { calls: number; last: string } {
  const state = { calls: 0, last: "" };
  return Object.assign(state, {
    async complete({ system, user }: { system: string; user: string }) {
      state.last = `${system}\n${user}`;
      const reply = replies[Math.min(state.calls, replies.length - 1)];
      state.calls += 1;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
}

function cardJson(
  moatStrength: "NONE" | "WEAK" | "STRONG",
  threatScore: number,
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    summary: `Moat ${moatStrength} at ${threatScore}.`,
    rationale: "The attack follows from who already owns the clinic workflow.",
    assumptions: [
      { statement: "Scheduling incumbents already sit in this workflow.", grounding: "assumption" },
      { statement: "Two pilot clinics exist.", grounding: "founder_provided" },
      { statement: "Renewal rate is unknown.", grounding: "unknown" },
    ],
    risks: ["The incumbent can ship the same step inside software clinics already pay for."],
    positionLabel: moatStrength,
    fields: {
      ...competitorCardFields({ moatStrength, threatScore }),
      ...((extra.fields as object) ?? {}),
    },
    changed: extra.changed,
    changeReason: extra.changeReason,
    decision: extra.decision,
  });
}

async function advance(result: ReturnType<typeof runCompetitorTurn>): Promise<DebateRun> {
  const done = await result;
  expect(done.ok).toBe(true);
  return done.value;
}

function fill(run: DebateRun, role: (typeof SPECIALIST_ROLES)[number]): DebateRun {
  const started = beginTurn(run, role);
  if (!started.ok) throw new Error("fixture");
  const raw =
    role === "competitor"
      ? cardJson("NONE", 2)
      : JSON.stringify({
          summary: `${role} view`,
          rationale: "Reasoned from the brief.",
          assumptions: [],
          risks: ["risk"],
          positionLabel: role === "vc" ? "MAYBE" : "skeptical",
          fields:
            role === "vc"
              ? {
                  score: 40,
                  investmentPosition: "MAYBE",
                  strongestInvestmentCase: "Missed calls leak revenue.",
                  biggestFundabilityRisk: "Vendors can bundle it.",
                  marketSizeConcern: "Independent clinics may be too narrow.",
                  first100Users: "The founder's clinics.",
                  defensibilityConcern: "A clinic suite can copy the workflow.",
                  killShotQuestion: "Who renews?",
                  oneLineVerdict: "A feature until it owns the schedule.",
                }
              : {},
          changed: started.value.lock?.stage === "rebuttal" ? false : undefined,
          changeReason: started.value.lock?.stage === "rebuttal" ? "Holds." : undefined,
        });
  const done = completeTurn(started.value, raw);
  if (!done.ok) throw new Error(done.error.message);
  return done.value;
}

function toRebuttals(run: DebateRun): DebateRun {
  let next = run;
  for (const role of SPECIALIST_ROLES) {
    if (role !== "competitor") next = fill(next, role);
  }
  const challenge = beginTurn(next, "red_team");
  if (!challenge.ok) throw new Error("fixture");
  const done = completeTurn(
    challenge.value,
    JSON.stringify({
      summary: "The incumbent already booked these calls.",
      rationale: "Existing scheduling software already owns the front desk.",
      assumptions: [],
      risks: ["bundle"],
      positionLabel: "challenge",
      fields: {
        targetedRoles: ["competitor"],
        questions: ["Why would clinics leave software they already pay for?"],
      },
    }),
  );
  if (!done.ok) throw new Error(done.error.message);
  return done.value;
}

describe("Competitor role registration", () => {
  it("registers incumbent instructions and refuses a Chair verdict", () => {
    const stored = registry();
    expect(stored.instructions("competitor")).toBe(COMPETITOR_INSTRUCTIONS);
    expect(COMPETITOR_INSTRUCTIONS).toContain("not evaluating Venture Gauntlet");
    const prompt = buildGenerationPrompt(newRun(), "competitor", "assessment", stored);
    expect(prompt.ok).toBe(true);
    if (prompt.ok) {
      expect(prompt.system).toContain("STRONG, MEDIUM, WEAK, or NONE");
      expect(prompt.system).not.toContain("decision.verdict");
    }
  });

  it("has no role instructions unless registered", async () => {
    const result = await runCompetitorTurn(newRun(), client(cardJson("NONE", 1)), createRoleRegistry());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("role_not_configured");
  });
});

describe("Competitor opening", () => {
  for (const [moatStrength, score] of [
    ["NONE", 1],
    ["WEAK", 3],
    ["STRONG", 8],
  ] as const) {
    it(`records a ${moatStrength} assessment from the provider`, async () => {
      const model = client(cardJson(moatStrength, score));
      const run = await advance(runCompetitorTurn(newRun(), model, registry()));
      const message = run.messages[0];
      expect(model.calls).toBe(1);
      expect(model.last).toContain("Clinic intake copilot");
      expect(message.speaker).toBe("competitor");
      expect(message.body).toContain(`COMPETITOR THREAT SCORE: ${score}/10`);
      expect(message.body).toContain("EXISTING ALTERNATIVES:");
      expect(message.body).toContain("FEATURE VS. COMPANY RISK:");
      expect(message.envelope?.competitor).toMatchObject({ threatScore: score, moatStrength });
      expect(message.envelope?.competitor?.founderQuestion).toMatch(/\?$/);
      expect(message.envelope?.decision).toBeNull();
      expect(message.envelope?.assumptions.map((claim) => claim.grounding)).toEqual([
        "assumption",
        "founder_provided",
        "unknown",
      ]);
    });
  }

  it("rejects bad scores, Chair labels, missing attacks, and citations", () => {
    for (const raw of [
      cardJson("NONE", 11),
      cardJson("NONE", 2.5),
      cardJson("NONE", 3).replace('"positionLabel":"NONE"', '"positionLabel":"pivot"'),
      cardJson("NONE", 3).replace('"summary"', '"citations":["x"],"summary"'),
      cardJson("NONE", 3, { decision: { verdict: "pass" } }),
      "not json",
    ]) {
      expect(parseContribution("competitor", "assessment", raw).ok).toBe(false);
    }
  });

  it("rejects an unnamed incumbent that is not labeled as an assumption", async () => {
    const raw = cardJson("NONE", 1).replace(
      '"assumptions":[{"statement":"Scheduling incumbents already sit in this workflow.","grounding":"assumption"},{"statement":"Two pilot clinics exist.","grounding":"founder_provided"},{"statement":"Renewal rate is unknown.","grounding":"unknown"}]',
      '"assumptions":[{"statement":"Two pilot clinics exist.","grounding":"founder_provided"}]',
    );
    const result = await runCompetitorTurn(newRun(), client(raw), registry());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("assumption");
    expect(result.value.messages).toHaveLength(0);
  });

  it("rejects an assumption that does not name the incumbent", async () => {
    const raw = cardJson("NONE", 1).replace(
      "Scheduling incumbents already sit in this workflow.",
      "Some vendor already sits in this workflow.",
    );
    const result = await runCompetitorTurn(newRun(), client(raw), registry());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("named in an assumption");
    expect(result.value.messages).toHaveLength(0);
  });
});

describe("Competitor rebuttal", () => {
  it("quotes the challenge, flags a change, and preserves the opening", async () => {
    let run = newRun();
    run = await advance(runCompetitorTurn(run, client(cardJson("NONE", 3)), registry()));
    run = toRebuttals(run);
    expect(run.phase).toBe("rebuttals");
    const rebuttal = cardJson("STRONG", 8, {
      changed: true,
      changeReason: "The challenge showed the incumbent does not own this channel.",
      fields: { challengeReference: "clinics leave software they already pay for" },
    });
    const model = client(rebuttal);
    run = await advance(runCompetitorTurn(run, model, registry()));
    expect(model.last).toContain("The incumbent already booked these calls.");
    const messages = run.messages.filter((message) => message.speaker === "competitor");
    expect(messages.map((message) => message.stage)).toEqual(["assessment", "rebuttal"]);
    expect(messages[0].envelope?.competitor).toMatchObject({
      threatScore: 3,
      moatStrength: "NONE",
    });
    expect(messages[1].envelope).toMatchObject({ changed: true });
    expect(messages[1].envelope?.competitor).toMatchObject({ threatScore: 8, moatStrength: "STRONG" });
  });

  it("rejects a rebuttal that skips the challenge or misreports the change", async () => {
    let run = newRun();
    run = await advance(runCompetitorTurn(run, client(cardJson("NONE", 3)), registry()));
    run = toRebuttals(run);
    const bad = [
      cardJson("NONE", 3, { changed: false, changeReason: "Holds." }),
      cardJson("NONE", 3, {
        changed: false,
        changeReason: "Holds.",
        fields: { challengeReference: "something never said" },
      }),
      cardJson("STRONG", 8, {
        changed: false,
        changeReason: "Holds.",
        fields: { challengeReference: "clinics leave software they already pay for" },
      }),
    ];
    for (const raw of bad) {
      const result = await runCompetitorTurn(run, client(raw), registry());
      expect(result.ok).toBe(false);
      expect(result.value.messages.filter((message) => message.stage === "rebuttal")).toHaveLength(0);
    }
  });
});

describe("Competitor founder response", () => {
  async function founderRun() {
    let run = newRun("Night-shift staffing board");
    run = await advance(runCompetitorTurn(run, client(cardJson("NONE", 3)), registry()));
    run = toRebuttals(run);
    const rebuttal = cardJson("NONE", 3, {
      changed: false,
      changeReason: "The challenge does not move the score.",
      fields: { challengeReference: "clinics leave software they already pay for" },
    });
    run = await advance(runCompetitorTurn(run, client(rebuttal), registry()));
    for (const role of SPECIALIST_ROLES) {
      if (role !== "competitor") run = fill(run, role);
    }
    expect(run.phase).toBe("founder");
    const added = addFounderInput(run, "We have an exclusive contract with the clinic network.");
    expect(added.ok).toBe(true);
    return added.value;
  }

  it("answers from the founder message without changing the recommendation", async () => {
    const run = await founderRun();
    const reply = JSON.stringify({
      summary: "An exclusive contract is founder-provided, not yet a moat I cannot copy.",
      rationale: "One contract does not stop me from bundling the feature for everyone else.",
      assumptions: [{ statement: "The contract terms are founder-provided.", grounding: "founder_provided" }],
      risks: ["The exclusive term may be short."],
      positionLabel: "NONE",
      fields: { threatScore: 3 },
    });
    const model = client(reply);
    const next = await advance(runCompetitorTurn(run, model, registry()));
    expect(model.last).toContain("Night-shift staffing board");
    expect(model.last).toContain("exclusive contract with the clinic network");
    const last = next.messages[next.messages.length - 1];
    expect(last.stage).toBe("founder_response");
    expect(last.envelope?.positionLabel).toBe("NONE");
    expect(next.messages.find((message) => message.stage === "assessment")?.envelope?.competitor?.threatScore).toBe(3);
  });

  it("rejects a founder response that changes the stance", async () => {
    const run = await founderRun();
    const reply = JSON.stringify({
      summary: "Now a real wedge.",
      rationale: "The contract persuades me.",
      assumptions: [],
      risks: ["term length"],
      positionLabel: "STRONG",
      fields: { threatScore: 9 },
    });
    const result = await runCompetitorTurn(run, client(reply), registry());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("cannot change");
  });
});

describe("Competitor failure recovery", () => {
  it("returns recoverable errors, records nothing, and retries cleanly", async () => {
    const cases: Array<[ModelClient | null, string]> = [
      [null, "missing_credentials"],
      [client(Object.assign(new Error("slow"), { code: "timeout" })), "timeout"],
      [client(new Error("boom")), "provider_failure"],
      [client("{ nope"), "invalid_response"],
    ];
    for (const [model, code] of cases) {
      const result = await runCompetitorTurn(newRun(), model, registry());
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe(code);
      expect(result.value.messages).toHaveLength(0);
      const retried = retryTurn(result.value);
      expect(retried.ok).toBe(true);
      const again = await runCompetitorTurn(retried.value, client(cardJson("NONE", 2)), registry());
      expect(again.ok).toBe(true);
      expect(again.value.messages).toHaveLength(1);
    }
  });
});
