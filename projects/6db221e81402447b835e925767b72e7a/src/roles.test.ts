import { describe, expect, it } from "vitest";
import { ROLE_IDS, createRoleRegistry } from "./contract";
import { ROLE_INSTRUCTIONS } from "./roles";

describe("committee role registry", () => {
  it("registers every role without conflating VC MAYBE with the Chair verdict", () => {
    const registry = createRoleRegistry(ROLE_INSTRUCTIONS);
    for (const role of ROLE_IDS) expect(registry.instructions(role)).toBeTruthy();
    expect(ROLE_INSTRUCTIONS.vc).toContain("MAYBE");
    expect(ROLE_INSTRUCTIONS.chair).toContain("pivot");
    expect(ROLE_INSTRUCTIONS.engineer).toContain("TECHNICAL FEASIBILITY SCORE");
    expect(ROLE_INSTRUCTIONS.engineer).toContain("EASY_MVP");
    expect(ROLE_INSTRUCTIONS.engineer).not.toContain("Chair verdict label");
  });
});
