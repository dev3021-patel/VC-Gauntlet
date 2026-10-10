import { describe, expect, it } from "vitest";
import { validateBrief } from "./brief";
import { createRoleRegistry, parseContribution, SPECIALIST_ROLES } from "./contract";
import { addFounderInput, beginTurn, completeTurn, createRun, retryTurn, type DebateRun } from "./debate";
import { buildGenerationPrompt, type ModelClient } from "./provider";
import { VC_INSTRUCTIONS, registerVcAgent, runVcTurn } from "./vc";

function newRun(): DebateRun {
  const brief = validateBrief({
    idea: "Clinic intake copilot",
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
  const r = createRoleRegistry();
  registerVcAgent(r);
  return r;
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

function vcJson(
  position: "INVEST" | "MAYBE" | "PASS",
  score: number,
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    summary: `Position ${position} at ${score}.`,
    rationale: `Score ${score} because distribution is unproven and willingness to pay is untested.`,
    assumptions: [
      { statement: "Clinics will pay per location.", grounding: "assumption" },
      { statement: "Two pilot clinics exist.", grounding: "founder_provided" },
      { statement: "Referral rate is unknown.", grounding: "unknown" },
    ],
    risks: ["Looks like a feature inside existing scheduling software."],
    positionLabel: position,
    fields: {
      score,
      investmentPosition: position,
      strongestInvestmentCase: "Missed calls are a measurable revenue leak.",
      biggestFundabilityRisk: "Incumbent scheduling vendors can bundle it.",
      first100Users: "Sell to the founders' clinic network, then clinic consultants.",
      killShotQuestion: "Who renews after the pilot ends?",
      oneLineVerdict: "A feature until it owns the schedule.",
      ...((extra.fields as object) ?? {}),
    },
    changed: extra.changed,
    changeReason: extra.changeReason,
  });
}

async function advance(result: ReturnType<typeof runVcTurn>): Promise<DebateRun> {
  const done = await result;
  expect(done.ok).toBe(true);
  return done.value;
}

function fill(run: DebateRun, role: (typeof SPECIALIST_ROLES)[number]): DebateRun {
  const started = beginTurn(run, role);
  if (!started.ok) throw new Error("fixture");
  const raw =
    role === "vc"
      ? vcJson("MAYBE", 50)
      : role === "competitor"
        ? JSON.stringify({
            summary: "Scheduling incumbents would bundle this feature.",
            rationale: "The attack follows from the clinic workflow they already own.",
            assumptions: [{ statement: "Scheduling vendors own this workflow.", grounding: "assumption" }],
            risks: ["bundle"],
            positionLabel: "COPYABLE_FEATURE",
            fields: {
              threatScore: 2,
              stance: "COPYABLE_FEATURE",
              incumbent: "Scheduling incumbents",
              crushPlan: "Bundle the booking feature and make it free.",
              weakMoat: "No proprietary clinic data.",
              copyabilityRisk: "A vendor can recreate the feature in a sprint.",
              distributionDisadvantage: "The incumbent already owns the clinic relationship.",
              dangerousMove: "Exclusive clinic data the incumbent cannot see.",
              founderQuestion: "What do you own if the incumbent bundles this?",
              verdict: "This is a feature, not a company.",
            },
            changed: started.value.lock?.stage === "rebuttal" ? false : undefined,
            changeReason: started.value.lock?.stage === "rebuttal" ? "Holds." : undefined,
          })
        : JSON.stringify({
            summary: `${role} view`,
            rationale: "Reasoned from the brief.",
            assumptions: [],
            risks: ["risk"],
            positionLabel: "skeptical",
            fields: {},
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
    if (role !== "vc") next = fill(next, role);
  }
  const challenge = beginTurn(next, "red_team");
  if (!challenge.ok) throw new Error("fixture");
  const done = completeTurn(
    challenge.value,
    JSON.stringify({
      summary: "Clinics churn after pilots.",
      rationale: "Pilot clinics rarely convert to paid contracts.",
      assumptions: [],
      risks: ["churn"],
      positionLabel: "challenge",
      fields: { targetedRoles: ["vc"], questions: ["Why would pilot clinics convert to paid?"] },
    }),
  );
  if (!done.ok) throw new Error(done.error.message);
  return done.value;
}

describe("VC role registration", () => {
  it("registers persona instructions and keeps MAYBE distinct from Pivot", () => {
    const r = registry();
    expect(r.instructions("vc")).toBe(VC_INSTRUCTIONS);
    expect(VC_INSTRUCTIONS).toContain("never a synonym for the Chair's Pivot");
    const prompt = buildGenerationPrompt(newRun(), "vc", "assessment", r);
    expect(prompt.ok).toBe(true);
    if (prompt.ok) expect(prompt.system).toContain("INVEST, MAYBE, or PASS");
  });

  it("has no role instructions unless registered", async () => {
    const result = await runVcTurn(newRun(), client(vcJson("PASS", 20)), createRoleRegistry());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("role_not_configured");
  });
});

describe("VC opening", () => {
  for (const [position, score] of [
    ["INVEST", 84],
    ["MAYBE", 52],
    ["PASS", 18],
  ] as const) {
    it(`records a ${position} assessment from the provider`, async () => {
      const c = client(vcJson(position, score));
      const run = await advance(runVcTurn(newRun(), c, registry()));
      const message = run.messages[0];
      expect(c.calls).toBe(1);
      expect(c.last).toContain("Clinic intake copilot");
      expect(message.speaker).toBe("vc");
      expect(message.envelope?.vc).toMatchObject({ score, investmentPosition: position });
      expect(message.envelope?.vc?.killShotQuestion).toMatch(/\?$/);
      expect(message.envelope?.assumptions.map((a) => a.grounding)).toEqual([
        "assumption",
        "founder_provided",
        "unknown",
      ]);
    });
  }

  it("rejects malformed scores, bad positions, Pivot, and citations", () => {
    for (const raw of [
      vcJson("MAYBE", 101),
      vcJson("MAYBE", 50.5),
      vcJson("MAYBE", 50).replace('"positionLabel":"MAYBE"', '"positionLabel":"PIVOT"'),
      vcJson("MAYBE", 50).replace('"summary"', '"citations":["x"],"summary"'),
      "not json",
    ]) {
      expect(parseContribution("vc", "assessment", raw).ok).toBe(false);
    }
  });
});

describe("VC rebuttal", () => {
  it("quotes the challenge, flags a change, and preserves the opening", async () => {
    let run = newRun();
    run = await advance(runVcTurn(run, client(vcJson("MAYBE", 50)), registry()));
    run = toRebuttals(run);
    expect(run.phase).toBe("rebuttals");
    const rebuttal = vcJson("PASS", 30, {
      changed: true,
      changeReason: "Pilot-to-paid conversion is unproven, so I lower my score.",
      fields: { challengeReference: "pilot clinics convert to paid" },
    });
    const c = client(rebuttal);
    run = await advance(runVcTurn(run, c, registry()));
    expect(c.last).toContain("Clinics churn after pilots");
    const vcMessages = run.messages.filter((m) => m.speaker === "vc");
    expect(vcMessages.map((m) => m.stage)).toEqual(["assessment", "rebuttal"]);
    expect(vcMessages[0].envelope?.vc).toMatchObject({ score: 50, investmentPosition: "MAYBE" });
    expect(vcMessages[1].envelope).toMatchObject({ changed: true });
    expect(vcMessages[1].envelope?.vc).toMatchObject({ score: 30, investmentPosition: "PASS" });
  });

  it("rejects a rebuttal that skips the challenge or misreports the change", async () => {
    let run = newRun();
    run = await advance(runVcTurn(run, client(vcJson("MAYBE", 50)), registry()));
    run = toRebuttals(run);
    const bad = [
      vcJson("MAYBE", 50, { changed: false, changeReason: "Holds." }),
      vcJson("MAYBE", 50, {
        changed: false,
        changeReason: "Holds.",
        fields: { challengeReference: "something never said" },
      }),
      vcJson("PASS", 30, {
        changed: false,
        changeReason: "Holds.",
        fields: { challengeReference: "pilot clinics convert to paid" },
      }),
    ];
    for (const raw of bad) {
      const result = await runVcTurn(run, client(raw), registry());
      expect(result.ok).toBe(false);
      expect(result.value.messages.filter((m) => m.stage === "rebuttal")).toHaveLength(0);
    }
  });
});

describe("VC founder response", () => {
  async function founderRun() {
    let run = newRun();
    run = await advance(runVcTurn(run, client(vcJson("MAYBE", 50)), registry()));
    run = toRebuttals(run);
    const rebuttal = vcJson("MAYBE", 50, {
      changed: false,
      changeReason: "The challenge does not move my score.",
      fields: { challengeReference: "pilot clinics convert to paid" },
    });
    run = await advance(runVcTurn(run, client(rebuttal), registry()));
    for (const role of SPECIALIST_ROLES) {
      if (role !== "vc") run = fill(run, role);
    }
    expect(run.phase).toBe("founder");
    const added = addFounderInput(run, "Both pilot clinics signed a paid contract last week.");
    expect(added.ok).toBe(true);
    return added.value;
  }

  it("answers from the founder message without changing the recommendation", async () => {
    const run = await founderRun();
    const reply = JSON.stringify({
      summary: "Signed contracts help, one data point is not a channel.",
      rationale: "Two paid pilots address conversion but not repeatable distribution.",
      assumptions: [{ statement: "Paid contract terms are founder-provided.", grounding: "founder_provided" }],
      risks: ["n=2"],
      positionLabel: "MAYBE",
      fields: {},
    });
    const c = client(reply);
    const next = await advance(runVcTurn(run, c, registry()));
    expect(c.last).toContain("signed a paid contract");
    const last = next.messages[next.messages.length - 1];
    expect(last.stage).toBe("founder_response");
    expect(last.envelope?.positionLabel).toBe("MAYBE");
  });

  it("rejects a founder response that changes the position", async () => {
    const run = await founderRun();
    const reply = JSON.stringify({
      summary: "Now an invest.",
      rationale: "Contracts persuade me.",
      assumptions: [],
      risks: ["n=2"],
      positionLabel: "INVEST",
      fields: {},
    });
    const result = await runVcTurn(run, client(reply), registry());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("cannot change");
  });
});

describe("VC failure recovery", () => {
  it("returns recoverable errors, records nothing, and retries cleanly", async () => {
    const cases: Array<[ModelClient | null, string]> = [
      [null, "missing_credentials"],
      [client(Object.assign(new Error("slow"), { code: "timeout" })), "timeout"],
      [client(new Error("boom")), "provider_failure"],
      [client("{ nope"), "invalid_response"],
    ];
    for (const [c, code] of cases) {
      const result = await runVcTurn(newRun(), c, registry());
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe(code);
      expect(result.value.messages).toHaveLength(0);
      const retried = retryTurn(result.value);
      expect(retried.ok).toBe(true);
      const again = await runVcTurn(retried.value, client(vcJson("MAYBE", 50)), registry());
      expect(again.ok).toBe(true);
      expect(again.value.messages).toHaveLength(1);
    }
  });
});
