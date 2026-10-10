import { describe, expect, it } from "vitest";
import { validateBrief } from "./brief";

describe("idea brief", () => {
  it("rejects missing required fields and preserves the draft", () => {
    const result = validateBrief({
      idea: "Clinic scheduling",
      problem: "",
      targetCustomer: "Office managers",
      solution: "A shared calendar",
      businessModel: "Monthly subscription",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.field === "problem")).toBe(true);
    expect(result.draft.idea).toBe("Clinic scheduling");
    expect(result.draft.solution).toBe("A shared calendar");
  });

  it("accepts optional traction without requiring it", () => {
    const result = validateBrief({
      idea: "Clinic scheduling copilot",
      problem: "Front desks lose hours to phone tag.",
      targetCustomer: "Independent clinic office managers",
      solution: "An assistant that books from inbound calls.",
      businessModel: "Per-location monthly subscription",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.traction).toBe("");
  });
});
