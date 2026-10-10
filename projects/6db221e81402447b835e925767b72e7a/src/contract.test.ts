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
    marketSizeConcern: "The named buyer may be too narrow for a venture outcome.",
    first100Users: "Sell alongside the founder's existing design partners.",
    defensibilityConcern: "A larger clinic suite can copy the workflow.",
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
    expect(parsed.value.vc?.marketSizeConcern).toContain("too narrow");
    expect(parsed.value.vc?.defensibilityConcern).toContain("copy");
    expect(parsed.value.decision).toBeNull();
  });

  it("accepts INVEST and PASS and rejects a scorecard missing the new concerns", () => {
    const fields = JSON.parse(vcJson) as {
      positionLabel: string;
      fields: Record<string, string | number>;
    };
    for (const position of ["INVEST", "PASS"] as const) {
      fields.positionLabel = position;
      fields.fields.investmentPosition = position;
      fields.fields.score = position === "INVEST" ? 82 : 18;
      const parsed = parseContribution("vc", "assessment", JSON.stringify(fields));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.vc?.investmentPosition).toBe(position);
    }
    delete fields.fields.marketSizeConcern;
    fields.positionLabel = "MAYBE";
    fields.fields.investmentPosition = "MAYBE";
    expect(parseContribution("vc", "assessment", JSON.stringify(fields)).ok).toBe(false);
    fields.fields.marketSizeConcern = "Narrow buyer.";
    delete fields.fields.defensibilityConcern;
    expect(parseContribution("vc", "assessment", JSON.stringify(fields)).ok).toBe(false);
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
