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
  it("requires the customer agent's complete practical evaluation", () => {
    const customer = parseContribution(
      "customer",
      "assessment",
      JSON.stringify({
        summary: "Useful once, but not a recurring paid workflow yet.",
        rationale: "The founder supplied no evidence that customers pay for this today.",
        assumptions: [{ statement: "Customers currently use ChatGPT for this task.", grounding: "assumption" }],
        risks: ["The free workaround may remain good enough."],
        positionLabel: "MAYBE TRY",
        fields: {
          customerPainScore: 4,
          position: "MAYBE TRY",
          firstPersonVerdict: "As the customer, I would try it once, but I would not pay monthly yet.",
          currentWorkaround: "I use ChatGPT and a spreadsheet.",
          painIntensity: "LOW",
          painDetail: "This is occasional time loss, not urgent operational risk.",
          switchingFriction: "MEDIUM",
          switchingFrictionDetail: "I would need to trust a new workflow with my idea.",
          willingnessToPay: "LOW",
          willingnessToPayDetail: "I would use a free trial before considering a purchase.",
          trustBarrier: "HIGH",
          trustBarrierDetail: "Unsupported claims could push me toward a bad decision.",
          expectedUsageFrequency: "Rarely",
          momTestRealityCheck: "NONE",
          adoptionTrigger: "A deadline on an idea I am about to fund.",
          retentionRisk: "HIGH",
          customerSegmentFit: "MEDIUM",
          biggestObjection: "I already get most of this value from ChatGPT.",
          whatWouldChangeMyMind: "Five founders returning weekly after using it on live decisions.",
          customerTest: "Interview 15 founders about their last validation decision and manually run one review today.",
          customerVerdict: "I might try it, but I would not pay until it replaces repeated manual research.",
        },
      }),
    );
    expect(customer.ok).toBe(true);
    if (customer.ok) expect(customer.value.customer?.painScore).toBe(4);
  });

  it("rejects a customer response that omits the required decision trail", () => {
    const customer = parseContribution(
      "customer",
      "assessment",
      JSON.stringify({
        summary: "Not enough evidence.", rationale: "The proof is missing.",
        assumptions: [{ statement: "Demand exists.", grounding: "unknown" }], risks: ["No proof."],
        positionLabel: "WOULD IGNORE", fields: { customerPainScore: 2, position: "WOULD IGNORE" },
      }),
    );
    expect(customer.ok).toBe(false);
  });

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
