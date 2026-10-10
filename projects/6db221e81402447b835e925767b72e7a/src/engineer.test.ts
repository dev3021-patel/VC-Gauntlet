import { describe, expect, it } from "vitest";
import { parseContribution } from "./contract";
import { ENGINEER_CARD_FIELDS, ENGINEER_INSTRUCTIONS } from "./engineer";

function card(fields: Record<string, unknown> = ENGINEER_CARD_FIELDS) {
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
  });
});
