import { describe, expect, it } from "vitest";
import { createRoleRegistry } from "./contract";
import { createRun, failTurn, retryTurn } from "./debate";
import { buildGenerationPrompt } from "./provider";
import { ROLE_INSTRUCTIONS } from "./roles";

const brief = { idea: "Hourly commercial kitchen rentals", problem: "Leases are unaffordable", targetCustomer: "Food founders", solution: "Book insured off-peak slots", businessModel: "Take rate", traction: "", founderEvidence: "" };

describe("retry hint", () => {
  it("carries the rejection message into the retried prompt and nowhere else", () => {
    const registry = createRoleRegistry(ROLE_INSTRUCTIONS);
    const run = createRun(brief);
    const clean = buildGenerationPrompt(run, "vc", "assessment", registry);
    expect(clean.ok && clean.user).not.toContain("PREVIOUS ATTEMPT REJECTED");
    const failed = failTurn({ ...run, lock: { role: "vc", stage: "assessment" } }, { code: "invalid_response", message: "VC responses require a 0-100 score.", phase: "assessments", role: "vc" });
    const retried = retryTurn(failed);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.retryHint).toBe("VC responses require a 0-100 score.");
    const prompt = buildGenerationPrompt(retried.value, "vc", "assessment", registry);
    expect(prompt.ok && prompt.user).toContain("PREVIOUS ATTEMPT REJECTED");
    expect(prompt.ok && prompt.user).toContain("VC responses require a 0-100 score.");
  });
});
