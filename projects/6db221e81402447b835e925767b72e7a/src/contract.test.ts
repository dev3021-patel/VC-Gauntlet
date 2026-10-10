import { describe, expect, it } from "vitest";
import {
  chairVerdictFromVcPosition,
  isChairVerdict,
  isVcPosition,
  parseContribution,
} from "./contract";

const vcJson = JSON.stringify({
  summary: "Distribution is the constraint.",
  rationale: "The buyer and the user are different, and the first channel is unnamed.",
  assumptions: [
    {
      statement: "The category is large enough to support a venture outcome.",
      grounding: "assumption",
    },
  ],
  risks: ["Customer acquisition may cost more than the contract value."],
  positionLabel: "MAYBE",
  fields: {
    score: 46,
    investmentPosition: "MAYBE",
    strongestInvestmentCase: "A painful workflow with a budget owner.",
    biggestFundabilityRisk: "It may be a feature, not a company.",
    first100Users: "Sell alongside the founder's existing design partners.",
    killShotQuestion: "Who signs the first ten contracts?",
    oneLineVerdict: "Real pain, unproven company.",
  },
});

describe("shared envelope", () => {
  it("keeps VC MAYBE distinct from the Chair pivot verdict", () => {
    expect(isVcPosition("MAYBE")).toBe(true);
    expect(isChairVerdict("MAYBE")).toBe(false);
    expect(isChairVerdict("pivot")).toBe(true);
    expect(isVcPosition("pivot")).toBe(false);
    expect(chairVerdictFromVcPosition("MAYBE")).toBeNull();
    const parsed = parseContribution("vc", "assessment", vcJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.vc?.investmentPosition).toBe("MAYBE");
    expect(parsed.value.decision).toBeNull();
  });

  it("rejects a specialist pivot label and generated citations", () => {
    const pivot = parseContribution(
      "customer",
      "assessment",
      JSON.stringify({
        summary: "Maybe pivot the buyer.",
        rationale: "The user will not pay.",
        assumptions: [{ statement: "Nobody pays.", grounding: "assumption" }],
        risks: ["No budget."],
        positionLabel: "pivot",
        fields: {},
      }),
    );
    expect(pivot.ok).toBe(false);

    const citedPayload = JSON.parse(vcJson) as Record<string, unknown>;
    citedPayload.citations = ["https://example.com"];
    const cited = parseContribution("vc", "assessment", JSON.stringify(citedPayload));
    expect(cited.ok).toBe(false);
  });

  it("requires a pivot direction only on a Chair pivot", () => {
    const base = {
      summary: "The committee should not fund the current wedge.",
      rationale: "The specialists disagree on the buyer.",
      assumptions: [{ statement: "A clinic buyer exists.", grounding: "unknown" }],
      risks: ["The wedge is too narrow."],
      positionLabel: "pivot",
      fields: {},
      decision: {
        verdict: "pivot",
        decisiveReasons: ["The current buyer will not pay."],
        disagreements: ["Engineer says it is buildable; Customer says it is unwanted."],
        unresolvedRisks: ["Willingness to pay is untested."],
        nextSteps: ["Interview ten clinic managers."],
      },
    };
    expect(parseContribution("chair", "verdict", JSON.stringify(base)).ok).toBe(false);
    const withDirection = parseContribution(
      "chair",
      "verdict",
      JSON.stringify({
        ...base,
        decision: { ...base.decision, pivotDirection: "Sell to the clinic, not the patient." },
      }),
    );
    expect(withDirection.ok).toBe(true);
    if (withDirection.ok) expect(withDirection.value.decision?.verdict).toBe("pivot");
  });
});
