import { describe, expect, it } from "vitest";
import { parseContribution } from "./contract";
import { ENGINEER_CARD_FIELDS, ENGINEER_INSTRUCTIONS, formatEngineerOutput } from "./engineer";

function card(overrides: Record<string, unknown> = {}) {
  const fields = { ...ENGINEER_CARD_FIELDS, ...overrides };
  return JSON.stringify({
    summary: "TECHNICAL FEASIBILITY SCORE: 8/10",
    rationale: "The demo is a form and structured model calls.",
    assumptions: [{ statement: "No outside research is required.", grounding: "assumption" }],
    risks: ["Roles may restate the brief."],
    positionLabel: fields.buildPosition,
    fields,
  });
}

describe("engineer scorecard", () => {
  it("parses the CTO card and rejects a Chair verdict label", () => {
    const parsed = parseContribution("engineer", "assessment", card());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.engineer).toMatchObject({
      feasibilityScore: 8,
      buildPosition: "EASY_MVP",
      mvpEstimate: "WEEKS_2",
      dataAccessRisk: "LOW",
    });
    expect(parsed.value.decision).toBeNull();
    expect(parseContribution("engineer", "assessment", card({ ...ENGINEER_CARD_FIELDS, buildPosition: "pivot" })).ok).toBe(false);
    expect(ENGINEER_INSTRUCTIONS).toContain("FAKEABLE MVP");
    expect(ENGINEER_INSTRUCTIONS).toContain("WHAT TO CUT");
    const printed = formatEngineerOutput(ENGINEER_CARD_FIELDS);
    expect(printed).toContain("TECHNICAL FEASIBILITY SCORE: 8/10");
    expect(printed).toContain("BUILD POSITION:\nEASY MVP");
    expect(printed).toContain("MVP ESTIMATE:\n2 WEEKS");
  });
});
