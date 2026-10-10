import { describe, expect, it } from "vitest";
import { validateBrief, type IdeaBrief } from "./brief";
import { SPECIALIST_ROLES, type RoleId, type SpecialistRole } from "./contract";
import {
  addFounderInput,
  beginTurn,
  completeTurn,
  contextSnapshot,
  createRun,
  failTurn,
  renderContext,
  requestVerdict,
  retryTurn,
  type DebateRun,
} from "./debate";

function brief(idea: string): IdeaBrief {
  const result = validateBrief({
    idea,
    problem: "The current workflow wastes skilled time.",
    targetCustomer: "Operators at independent clinics",
    solution: "Software that removes the repetitive step.",
    businessModel: "Seat-based monthly subscription",
  });
  if (!result.ok) throw new Error("brief fixture invalid");
  return result.value;
}

function envelope(role: RoleId, extra: Record<string, unknown> = {}) {
  const vcFields = {
    score: 46,
    investmentPosition: "MAYBE",
    strongestInvestmentCase: "The pain is frequent and budgeted.",
    biggestFundabilityRisk: "It may stay a service.",
    first100Users: "Use the founder's clinic network.",
    killShotQuestion: "Who renews after month three?",
    oneLineVerdict: "Promising wedge, unproven scale.",
  };
  return JSON.stringify({
    summary: `${role} weighs ${extra.summary ?? "the submitted idea"}.`,
    rationale: "The argument follows from the brief, not a generic market claim.",
    assumptions: [
      {
        statement: "Demand beyond the founder's network is unproven.",
        grounding: "assumption",
      },
    ],
    risks: ["The first channel may not repeat."],
    positionLabel: role === "vc" ? "MAYBE" : role === "chair" ? "pass" : "skeptical",
    fields:
      role === "vc"
        ? vcFields
        : role === "red_team"
          ? { targetedRoles: [...SPECIALIST_ROLES], questions: ["Which claim is evidenced?"] }
          : {},
    changed: extra.changed,
    changeReason: extra.changeReason,
    decision: extra.decision,
    ...("summary" in extra ? { summary: extra.summary } : {}),
  });
}

function finish(run: DebateRun, role: RoleId, raw: string): DebateRun {
  const started = beginTurn(run, role);
  expect(started.ok).toBe(true);
  if (!started.ok) return run;
  const done = completeTurn(started.value, raw);
  expect(done.ok).toBe(true);
  if (!done.ok) return started.value;
  return done.value;
}

function throughFounder(idea: string): DebateRun {
  let run = createRun(brief(idea));
  for (const role of SPECIALIST_ROLES) {
    run = finish(run, role, envelope(role));
  }
  expect(run.phase).toBe("challenge");
  run = finish(run, "red_team", envelope("red_team"));
  expect(run.phase).toBe("rebuttals");
  for (const role of SPECIALIST_ROLES) {
    run = finish(
      run,
      role,
      envelope(role, { changed: false, changeReason: "The challenge did not change the evidence." }),
    );
  }
  expect(run.phase).toBe("founder");
  return run;
}

describe("debate order and recovery", () => {
  it("blocks the Chair until required stages finish and keeps initial positions", () => {
    let run = createRun(brief("Clinic intake copilot"));
    expect(requestVerdict(run).ok).toBe(false);
    run = finish(run, "vc", envelope("vc"));
    expect(run.messages[0]?.envelope?.vc?.investmentPosition).toBe("MAYBE");
    expect(beginTurn(run, "red_team").ok).toBe(false);
    for (const role of SPECIALIST_ROLES.slice(1)) run = finish(run, role, envelope(role));
    run = finish(run, "red_team", envelope("red_team"));
    expect(requestVerdict(run).ok).toBe(false);
    const initial = run.messages.filter((message) => message.stage === "assessment");
    for (const role of SPECIALIST_ROLES) {
      run = finish(
        run,
        role,
        envelope(role, { changed: true, changeReason: "The challenge exposed a weaker buyer." }),
      );
    }
    expect(run.messages.filter((message) => message.stage === "assessment")).toEqual(initial);
    expect(requestVerdict(run).ok).toBe(true);
  });

  it("includes a founder clarification in later context and isolates a fresh run", () => {
    let run = throughFounder("Warehouse slotting tool");
    const asked = addFounderInput(run, "We already have three paid pilots.");
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    const started = beginTurn(asked.value, "customer");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const prompt = renderContext(contextSnapshot(started.value));
    expect(prompt).toContain("Warehouse slotting tool");
    expect(prompt).toContain("We already have three paid pilots.");
    const fresh = createRun(brief("A completely different pet pharmacy"));
    expect(fresh.id).not.toBe(run.id);
    expect(renderContext(contextSnapshot(fresh))).not.toContain("three paid pilots");
    expect(renderContext(contextSnapshot(fresh))).toContain("pet pharmacy");
  });

  it("retries a failed stage without duplicating a successful contribution", () => {
    let run = createRun(brief("Field service dispatch"));
    run = finish(run, "vc", envelope("vc"));
    const started = beginTurn(run, "customer");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const failed = failTurn(started.value, {
      code: "provider_failure",
      message: "The AI provider returned an error.",
      role: "customer",
    });
    expect(failed.messages).toHaveLength(1);
    expect(requestVerdict(failed).ok).toBe(false);
    expect(beginTurn(failed, "customer").ok).toBe(false);
    const retried = retryTurn(failed);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    run = finish(retried.value, "customer", envelope("customer"));
    expect(run.messages.filter((message) => message.speaker === "vc")).toHaveLength(1);
    expect(run.messages.filter((message) => message.speaker === "customer")).toHaveLength(1);
  });

  it("rejects overlapping generations", () => {
    const run = createRun(brief("Local services marketplace"));
    const started = beginTurn(run, "engineer");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(beginTurn(started.value, "vc").ok).toBe(false);
  });

  it("does not record a verdict when the Chair response is invalid", () => {
    let run = throughFounder("Niche newsletter studio");
    const requested = requestVerdict(run);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    const started = beginTurn(requested.value, "chair");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const failed = completeTurn(started.value, "{not json");
    expect(failed.ok).toBe(false);
    expect(failed.value.phase).not.toBe("complete");
    expect(failed.value.messages.some((message) => message.stage === "verdict")).toBe(false);
    const role: SpecialistRole = "vc";
    expect(failed.value.messages.some((message) => message.speaker === role)).toBe(true);
  });
});
