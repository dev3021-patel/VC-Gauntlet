import { describe, expect, it } from "vitest";
import {
  SPECIALIST_SCORE_SPECS,
  createRoleRegistry,
  getPrimaryScore,
  parseContribution,
  type ContributionStage,
  type RoleEnvelope,
} from "./contract";
import { emptyBrief } from "./brief";
import { beginTurn, completeTurn, contextSnapshot, createRun, renderContext } from "./debate";
import { buildGenerationPrompt } from "./provider";
import { ROLE_INSTRUCTIONS } from "./roles";

function response(field: string, score: unknown, changed = false) {
  return JSON.stringify({
    summary: "The buying workflow limits adoption.",
    rationale: "The buyer must leave their current workflow; this score is an assumption.",
    assumptions: [{ statement: "Payment intent is untested.", grounding: "assumption" }],
    risks: ["The buyer may not switch."],
    positionLabel: "skeptical",
    fields: score === undefined ? {} : { [field]: score },
    changed,
    changeReason: changed ? "The challenge weakened the assumption." : "The evidence did not change.",
  });
}

describe.each(["customer", "engineer"] as const)("%s numeric score compatibility", (role) => {
  const { field } = SPECIALIST_SCORE_SPECS[role];

  it("preserves scores and positions on assessments and rebuttals", () => {
    for (const stage of ["assessment", "rebuttal"] as const) {
      for (const score of [0, 6, 10]) {
        const result = parseContribution(role, stage, response(field, score));
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error.message);
        expect(result.value.schemaVersion).toBe(1);
        expect(getPrimaryScore(result.value)).toBe(score);
        expect(result.value.positionLabel).toBe("skeptical");
      }
    }
  });

  it("keeps legacy responses valid and signals the position-only fallback", () => {
    for (const stage of ["assessment", "rebuttal"] as const) {
      const result = parseContribution(role, stage, response(field, undefined));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(getPrimaryScore(result.value)).toBeNull();
      expect(result.value.fields).not.toHaveProperty(field);
      expect(result.value.positionLabel).toBe("skeptical");
    }
  });

  it("rejects malformed supplied scores on both stages", () => {
    for (const stage of ["assessment", "rebuttal"] as const) {
      for (const score of [-1, 11, 4.5, "7", true, ["7"], null]) {
        expect(parseContribution(role, stage, response(field, score)).ok).toBe(false);
      }
    }
  });

  it("requests the score for opening and revised model output", () => {
    const registry = createRoleRegistry(ROLE_INSTRUCTIONS);
    for (const stage of ["assessment", "rebuttal"] as const) {
      const prompt = buildGenerationPrompt(createRun(emptyBrief()), role, stage, registry);
      expect(prompt.ok).toBe(true);
      if (!prompt.ok) throw new Error(prompt.error.message);
      expect(prompt.system).toContain(`fields.${field}`);
      expect(prompt.system).toContain("integer from 0 to 10");
      expect(prompt.system).toContain("When changed is false, retain the opening score");
    }
  });

  it("records a revised score without overwriting the opening, and carries both into later context", () => {
    const started = beginTurn(createRun(emptyBrief()), role);
    if (!started.ok) throw new Error(started.error.message);
    const opening = completeTurn(started.value, response(field, 8));
    if (!opening.ok) throw new Error(opening.error.message);
    const rebuttal = beginTurn({ ...opening.value, phase: "rebuttals" }, role);
    if (!rebuttal.ok) throw new Error(rebuttal.error.message);
    const revised = completeTurn(rebuttal.value, response(field, 4, true));
    expect(revised.ok).toBe(true);
    expect(revised.value.messages[0]).toEqual(opening.value.messages[0]);
    expect(getPrimaryScore(revised.value.messages[1].envelope!)).toBe(4);
    const context = renderContext(contextSnapshot(revised.value));
    expect(context).toContain(`Primary score (${field}): 8/10`);
    expect(context).toContain(`Primary score (${field}): 4/10`);
  });

  it("rejects a changed score labelled unchanged and keeps the failed turn retryable", () => {
    const start = beginTurn(createRun(emptyBrief()), role);
    if (!start.ok) throw new Error(start.error.message);
    const opening = completeTurn(start.value, response(field, 8));
    if (!opening.ok) throw new Error(opening.error.message);
    const rebuttal = beginTurn({ ...opening.value, phase: "rebuttals" }, role);
    if (!rebuttal.ok) throw new Error(rebuttal.error.message);
    const rejected = completeTurn(rebuttal.value, response(field, 4, false));
    expect(rejected.ok).toBe(false);
    expect(rejected.value.lock).toBeNull();
    expect(rejected.value.failure?.code).toBe("invalid_response");
    expect(rejected.value.messages).toEqual(opening.value.messages);
    expect(completeTurn(rebuttal.value, response(field, 8, false)).ok).toBe(true);
    expect(completeTurn(rebuttal.value, response(field, undefined, false)).ok).toBe(true);
  });
});

it("reads each specialist's native scale and excludes non-scoring roles and stages", () => {
  for (const [role, spec] of Object.entries(SPECIALIST_SCORE_SPECS)) {
    const envelope = { role, stage: "assessment", fields: { [spec.field]: spec.max } } as RoleEnvelope;
    expect(getPrimaryScore(envelope)).toBe(spec.max);
    for (const stage of ["founder_response", "challenge", "verdict"] as ContributionStage[]) {
      expect(getPrimaryScore({ ...envelope, stage })).toBeNull();
    }
  }
  expect(getPrimaryScore({ role: "chair", stage: "verdict", fields: { score: 90 } })).toBeNull();
  expect(getPrimaryScore({ role: "red_team", stage: "challenge", fields: { score: 9 } })).toBeNull();
});
