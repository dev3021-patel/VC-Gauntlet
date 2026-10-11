import { describe, expect, it } from "vitest";
import type { RoleEnvelope } from "./contract";
import type { DebateRun } from "./debate";
import { demoRun, demoRunWithoutOptionalScores, ignoreStaleUpdate, toCommitteeView } from "./committee-view";

function envelope(role: RoleEnvelope["role"], stage: RoleEnvelope["stage"], fields: RoleEnvelope["fields"], extra: Partial<RoleEnvelope> = {}): RoleEnvelope {
  return {
    schemaVersion: 1,
    role,
    stage,
    summary: extra.summary ?? `${role} ${stage}`,
    rationale: extra.rationale ?? `${role} reasoning`,
    assumptions: extra.assumptions ?? [],
    risks: extra.risks ?? [],
    positionLabel: extra.positionLabel ?? "OPEN",
    changed: extra.changed ?? null,
    changeReason: extra.changeReason ?? null,
    fields,
    decision: extra.decision ?? null,
    vc: null,
    competitor: null,
  };
}

function run(partial: Partial<DebateRun> & Pick<DebateRun, "messages" | "phase">): DebateRun {
  return {
    id: "run-1",
    brief: {
      idea: "Fresh clinic scheduling idea",
      problem: "Clinics lose patients to phone tag",
      targetCustomer: "Clinic managers",
      solution: "A scheduling assistant",
      businessModel: "Monthly subscription",
      traction: "",
      founderEvidence: "",
    },
    lock: null,
    failure: null,
    verdictRequested: false,
    ...partial,
  };
}

describe("committee view adapter", () => {
  it("maps a completed demo run without inventing missing sections", () => {
    const view = toCommitteeView(demoRun);
    expect(view.verdict).toBe("PIVOT");
    expect(view.confidence).toBe(76);
    expect(view.specialists).toHaveLength(4);
    expect(view.stats[0].value).toBe(String(demoRun.messages.filter((message) => message.envelope).length));
    expect(view.network.edges).toHaveLength(3);
    expect(view.challenges.map((challenge) => challenge.claim)).toEqual([
      "A budgeted audit week is not a venture-scale buyer.",
      "Interest before an audit is not willingness to pay.",
      "A checklist bundle is not a durable wedge.",
    ]);
    expect(view.decisionCards.some((card) => card.title === "Recommended pivot")).toBe(true);
  });

  it("degrades optional specialist scores to positions", () => {
    const view = toCommitteeView(demoRunWithoutOptionalScores);
    const customer = view.specialists.find((agent) => agent.id === "customer");
    const engineer = view.specialists.find((agent) => agent.id === "engineer");
    expect(customer?.initialScore).toBeNull();
    expect(engineer?.finalScore).toBeNull();
    expect(customer?.initialPosition).toBe("INTERESTED");
    expect(customer?.movement).toBe("changed");
    expect(view.network.edges.find((edge) => edge.target === "customer")?.label).toBe("changed");
  });

  it("renders a partial run without a Chair decision", () => {
    const view = toCommitteeView(run({
      phase: "assessments",
      messages: [{
        id: "vc-1",
        speaker: "vc",
        stage: "assessment",
        body: "Opening",
        createdAt: "2026-10-10T21:00:00.000Z",
        envelope: envelope("vc", "assessment", { score: 64, report: "This idea's distribution is unproven." }, { positionLabel: "MAYBE", rationale: "Fallback reasoning" }),
      }],
    }));
    expect(view.verdict).toBeNull();
    expect(view.confidence).toBeNull();
    expect(view.radar).toBeNull();
    expect(view.killRisks).toBeNull();
    expect(view.agents.find((agent) => agent.id === "chair")?.status).toBe("queued");
    expect(view.agents.find((agent) => agent.id === "red_team")?.status).toBe("queued");
    expect(view.agents.find((agent) => agent.id === "vc")?.why?.report).toBe("This idea's distribution is unproven.");
    expect(view.specialists.find((agent) => agent.id === "vc")?.movement).toBe("pending");
    expect(view.network.edges).toHaveLength(0);
  });

  it("keeps challenge slot identity and skips unavailable slots", () => {
    const view = toCommitteeView(run({
      phase: "rebuttals",
      messages: [
        ...(["vc", "customer", "competitor", "engineer"] as const).map((role) => ({
          id: `${role}-open`,
          speaker: role,
          stage: "assessment" as const,
          body: role,
          createdAt: "2026-10-10T21:00:00.000Z",
          envelope: envelope(role, "assessment", role === "vc" ? { score: 50 } : {}, { positionLabel: "OPEN", summary: `${role} opening` }),
        })),
        {
          id: "red",
          speaker: "red_team",
          stage: "challenge",
          body: "review",
          createdAt: "2026-10-10T21:01:00.000Z",
          envelope: envelope("red_team", "challenge", {
            challengeStatus: ["substantive", "unavailable", "substantive"],
            challengeTarget: ["vc", "unavailable", "engineer"],
            challengeClaim: ["Shared summary must not be copied.", "unavailable", "The build plan skips the integration."],
            challengeWhy: ["Score assumes a buyer.", "unavailable", "No connector is named."],
          }, { summary: "One summary for the whole review" }),
        },
        {
          id: "vc-rebuttal",
          speaker: "vc",
          stage: "rebuttal",
          body: "reply",
          createdAt: "2026-10-10T21:02:00.000Z",
          envelope: envelope("vc", "rebuttal", { score: 42 }, { positionLabel: "PASS", summary: "The buyer is narrower.", changeReason: "The challenge named the missing buyer." }),
        },
      ],
    }));
    expect(view.challenges.map((challenge) => challenge.slot)).toEqual([0, 2]);
    expect(view.challenges.map((challenge) => challenge.claim)).toEqual([
      "Shared summary must not be copied.",
      "The build plan skips the integration.",
    ]);
    expect(view.challenges[0].response).toBe("The buyer is narrower.");
    expect(view.challenges[1].responsePending).toBe(true);
    expect(view.challenges[1].response).toBeNull();
    expect(view.network.edges.map((edge) => edge.label)).toEqual(["-8", "pending"]);
  });

  it("falls back from a missing report and does not repeat that text as a point", () => {
    const view = toCommitteeView(run({
      phase: "challenge",
      messages: [{
        id: "vc-1",
        speaker: "vc",
        stage: "assessment",
        body: "Opening",
        createdAt: "2026-10-10T21:00:00.000Z",
        envelope: envelope("vc", "assessment", { strongestInvestmentCase: "Distribution is the open question." }, {
          rationale: "Distribution is the open question.",
          summary: "Distribution is the open question.",
          risks: ["No first-hundred path."],
          assumptions: [{ statement: "Clinics will switch tools.", grounding: "unknown" }],
        }),
      }],
    }));
    const why = view.agents.find((agent) => agent.id === "vc")?.why;
    expect(why?.report).toBe("Distribution is the open question.");
    expect(why?.points.some((point) => point.includes("Distribution is the open question."))).toBe(false);
    expect(why?.risk).toBe("No first-hundred path.");
    expect(why?.assumptions[0]).toEqual({ statement: "Clinics will switch tools.", grounding: "unknown", evidenceNote: null });
  });

  it("does not keep a previous run's report when the idea changes", () => {
    const first = toCommitteeView(demoRun);
    const second = toCommitteeView(run({
      id: "other-run",
      phase: "assessments",
      brief: { ...demoRun.brief, idea: "A completely different marketplace for field technicians" },
      messages: [{
        id: "other-vc",
        speaker: "vc",
        stage: "assessment",
        body: "Other",
        createdAt: "2026-10-10T22:00:00.000Z",
        envelope: envelope("vc", "assessment", { report: "Technician dispatch is a different report." }, { rationale: "Unused fallback" }),
      }],
    }));
    expect(second.idea).not.toBe(first.idea);
    expect(second.agents.find((agent) => agent.id === "vc")?.why?.report).toBe("Technician dispatch is a different report.");
    expect(JSON.stringify(second)).not.toContain("audit-ready evidence");
  });

  it("ignores stale or cross-run responses", () => {
    expect(ignoreStaleUpdate("run-a", 2, 1, "run-a")).toBe(true);
    expect(ignoreStaleUpdate("run-a", 2, 2, "run-b")).toBe(true);
    expect(ignoreStaleUpdate("run-a", 2, 2, "run-a")).toBe(false);
    expect(ignoreStaleUpdate(null, 2, 2, "run-a")).toBe(true);
  });

  it("marks the failed stage without filling a verdict", () => {
    const view = toCommitteeView(run({
      phase: "challenge",
      failure: { code: "missing_credentials", message: "Add the provider key.", phase: "challenge", role: "red_team" },
      messages: [],
    }));
    expect(view.stages.find((stage) => stage.label === "Red Team")?.state).toBe("failed");
    expect(view.verdict).toBeNull();
    expect(view.confidence).toBeNull();
    expect(view.agents.find((agent) => agent.id === "red_team")?.status).toBe("failed");
  });
});
