import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssessmentReport } from "./AssessmentReport";
import { emptyBrief } from "./brief";
import { createRoleRegistry, parseContribution, type RoleEnvelope } from "./contract";
import { beginTurn, completeTurn, createRun } from "./debate";
import { buildGenerationPrompt } from "./provider";
import { ROLE_INSTRUCTIONS } from "./roles";

const response = {
  summary: "Switching value still needs proof.",
  rationale: "- The buyer needs measurable time savings.\n- Willingness to pay is untested.",
  risks: ["The buyer may keep the existing workflow.", "Integration access is unknown."],
  assumptions: [
    { statement: "The founder targets clinics.", grounding: "founder_provided" },
    { statement: "Clinics will pay.", grounding: "assumption" },
    { statement: "A pilot saved two hours.", grounding: "supported_evidence", evidenceNote: "Supplied pilot log, entry 4." },
    { statement: "Integration access is unconfirmed.", grounding: "unknown" },
  ],
  positionLabel: "skeptical",
  fields: { adoptionScore: 4 },
};

function envelope(raw: object = response): RoleEnvelope {
  const parsed = parseContribution("customer", "assessment", JSON.stringify(raw));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

describe("assessment reports on the existing envelope", () => {
  it("requests one concise format for all four specialist assessments only", () => {
    const registry = createRoleRegistry(ROLE_INSTRUCTIONS);
    for (const role of ["vc", "customer", "competitor", "engineer"] as const) {
      const prompt = buildGenerationPrompt(createRun(emptyBrief()), role, "assessment", registry);
      if (!prompt.ok) throw new Error(prompt.error.message);
      expect(prompt.system).toContain("rationale as a string containing 2-4 short points");
      expect(prompt.system).toContain("single biggest risk first in the existing risks array");
      expect(prompt.system).toContain("Do not add a report key, fields.report");
      for (const stage of ["rebuttal", "founder_response"] as const) {
        const later = buildGenerationPrompt(createRun(emptyBrief()), role, stage, registry);
        if (!later.ok) throw new Error(later.error.message);
        expect(later.system).not.toContain("2-4 short points");
      }
    }
    for (const [role, stage] of [["red_team", "challenge"], ["chair", "verdict"], ["chair", "verdict_chat"]] as const) {
      const prompt = buildGenerationPrompt(createRun(emptyBrief()), role, stage, registry);
      if (!prompt.ok) throw new Error(prompt.error.message);
      expect(prompt.system).not.toContain("2-4 short points");
    }
  });

  it("keeps both legacy prose and concise points inside the existing content fields", () => {
    for (const rationale of [response.rationale, "Legacy prose explains why switching is difficult."]) {
      const value = envelope({ ...response, rationale });
      expect(value.rationale).toBe(rationale);
      expect(value.risks).toEqual(response.risks);
      expect(value.assumptions).toEqual(response.assumptions);
      expect(value.fields).toEqual({ adoptionScore: 4 });
      expect(value).not.toHaveProperty("report");
      expect(value.schemaVersion).toBe(1);
    }
  });

  it("carries the assessment reasoning, risks, and evidence notes into subsequent generation", () => {
    const started = beginTurn(createRun(emptyBrief()), "customer");
    if (!started.ok) throw new Error(started.error.message);
    const recorded = completeTurn(started.value, JSON.stringify(response));
    if (!recorded.ok) throw new Error(recorded.error.message);
    const prompt = buildGenerationPrompt(recorded.value, "engineer", "assessment", createRoleRegistry(ROLE_INSTRUCTIONS));
    if (!prompt.ok) throw new Error(prompt.error.message);
    expect(prompt.user).toContain(response.rationale);
    expect(prompt.user).toContain(`Biggest risk: ${response.risks[0]}`);
    expect(prompt.user).toContain(`Risk: ${response.risks[1]}`);
    expect(prompt.user).toContain("Claim (supported_evidence): A pilot saved two hours. Evidence note: Supplied pilot log, entry 4.");
    expect(prompt.user).toContain("Primary score (adoptionScore): 4/10");
  });

  it("renders points, the biggest risk, labeled claims and a score without altering the envelope", () => {
    const value = envelope();
    const before = structuredClone(value);
    const html = renderToStaticMarkup(createElement(AssessmentReport, { envelope: value }));
    expect(html).toContain("Adoption score: 4/10");
    expect(html).toContain("<li>The buyer needs measurable time savings.</li>");
    expect(html).toContain("<strong>Biggest risk:</strong>");
    for (const label of ["Founder-provided", "Assumption", "Unknown", "Supported evidence"]) {
      expect(html).toContain(`<strong>${label}:</strong>`);
    }
    expect(html).toContain("Evidence note: Supplied pilot log, entry 4.");
    expect(value).toEqual(before);
  });

  it("uses position-only display for missing scores and preserves old prose and escaped content", () => {
    const legacy = envelope({ ...response, fields: {}, rationale: "A legacy explanation with <untrusted markup>." });
    const html = renderToStaticMarkup(createElement(AssessmentReport, { envelope: legacy }));
    expect(html).toContain("Position: skeptical");
    expect(html).not.toContain("Adoption score:");
    expect(html).toContain("A legacy explanation with &lt;untrusted markup&gt;.");
    for (const value of [{ ...legacy, stage: "rebuttal" }, { ...legacy, role: "chair", stage: "verdict" }] as RoleEnvelope[]) {
      expect(renderToStaticMarkup(createElement(AssessmentReport, { envelope: value }))).toBe("");
    }
  });
});
