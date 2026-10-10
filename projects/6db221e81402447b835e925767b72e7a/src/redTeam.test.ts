import { describe, expect, it } from "vitest";
import { validateBrief, type IdeaBrief } from "./brief";
import { createRoleRegistry, parseContribution, SPECIALIST_ROLES, type SpecialistRole } from "./contract";
import { beginTurn, completeTurn, createRun, retryTurn, type DebateRun } from "./debate";
import { ENGINEER_CARD_FIELDS } from "./engineer";
import {
  RED_TEAM_INSTRUCTIONS,
  buildRedTeamPrompt,
  generateRedTeamReview,
  presentationOrderValid,
  registerRedTeamAgent,
  runRedTeamTurn,
  type AssessmentSource,
  type RedTeamRequest,
} from "./redTeam";
import type { ModelClient } from "./provider";

function brief(idea: string, founderEvidence = ""): IdeaBrief {
  const result = validateBrief({
    idea,
    problem: "The current workflow wastes skilled time.",
    targetCustomer: "Operators at independent clinics",
    solution: "Software that removes the repetitive step.",
    businessModel: "Seat-based monthly subscription",
    founderEvidence,
  });
  if (!result.ok) throw new Error("brief");
  return result.value;
}

function registry() {
  const stored = createRoleRegistry();
  registerRedTeamAgent(stored);
  return stored;
}

function source(
  id: string,
  role: SpecialistRole,
  text: string,
  positionLabel: string,
  score?: number,
): AssessmentSource {
  return { id, role, text, positionLabel, ...(score === undefined ? {} : { score }) };
}

function request(
  assessments: AssessmentSource[],
  idea = "Clinic intake copilot",
  founderDefense = "",
): RedTeamRequest {
  return {
    brief: brief(idea),
    assessments,
    ...(founderDefense ? { founderDefense } : {}),
  };
}

function client(reply: string | ((user: string) => string) | Error): ModelClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async complete({ user }) {
      prompts.push(user);
      if (reply instanceof Error) throw reply;
      return typeof reply === "function" ? reply(user) : reply;
    },
  };
}

function baseFields(extra: Record<string, unknown> = {}) {
  return {
    challengeStatus: ["unavailable", "unavailable", "unavailable"],
    challengeTarget: ["unavailable", "unavailable", "unavailable"],
    challengeSource: ["unavailable", "unavailable", "unavailable"],
    challengeClaim: ["unavailable", "unavailable", "unavailable"],
    challengeAnchor: ["unavailable", "unavailable", "unavailable"],
    challengeWhy: ["unavailable", "unavailable", "unavailable"],
    challengeMust: ["unavailable", "unavailable", "unavailable"],
    challengeUnavailable: [
      "No further supportable challenge was supplied.",
      "No further supportable challenge was supplied.",
      "No further supportable challenge was supplied.",
    ],
    contradictionStatus: "none",
    contradictionAgents: [],
    contradictionSources: [],
    contradictionAnchors: [],
    contradictionExplanation: "There is no contradiction in the supplied claims.",
    unansweredQuestion: "Will the target buyer pay a stated price after using the current workaround?",
    revisionWarranted: false,
    revisionTarget: "unavailable",
    revisionPosition: "unavailable",
    revisionReason: "The supplied positions are already explicitly provisional.",
    missingAssessments: [],
    reviewComplete: true,
    ...extra,
  };
}

function payload(summary: string, fields: Record<string, unknown>, assumptions?: unknown) {
  return JSON.stringify({
    summary,
    rationale: "The model rationale is replaced by the required card.",
    assumptions: assumptions ?? [
      { statement: "Unsupported agent claims remain assumptions.", grounding: "assumption" },
    ],
    risks: ["A confident score can hide an untested assumption."],
    positionLabel: "challenge",
    fields,
  });
}

const clinicSources = [
  source("vc-1", "vc", "The total market is $50B so this is fundable.", "MAYBE", 72),
  source("cu-1", "customer", "WILLINGNESS TO PAY: LOW and nobody I know would buy this.", "4/10"),
  source("co-1", "competitor", "This is a feature I can ship in a sprint.", "no moat"),
  source("en-1", "engineer", "The core workflow is easy to build as a weekend project.", "easy"),
];

function clinicReply(summary = "The fundability claim treats an unsourced market figure as demand."): string {
  return payload(summary, baseFields({
    challengeStatus: ["substantive", "substantive", "substantive"],
    challengeTarget: ["vc", "customer", "competitor"],
    challengeSource: ["vc-1", "cu-1", "co-1"],
    challengeClaim: [
      "The total market is $50B is being treated as reachable demand.",
      "WILLINGNESS TO PAY: LOW is asserted without a purchase attempt.",
      "A feature I can ship in a sprint is not proof buyers will switch.",
    ],
    challengeAnchor: ["total market is $50B", "WILLINGNESS TO PAY: LOW", "ship in a sprint"],
    challengeWhy: [
      "A category total is not addressable demand, and no source was supplied.",
      "An unsourced refusal does not establish that buyers reject a stated price.",
      "Ability to copy does not show an incumbent will ship and displace this.",
    ],
    challengeMust: [
      "A sourced reachable-market estimate must survive a buyer count.",
      "Target buyers must reject a stated price after a real comparison.",
      "An incumbent must ship an equivalent and take the same buyers.",
    ],
    challengeUnavailable: ["unavailable", "unavailable", "unavailable"],
    contradictionStatus: "present",
    contradictionAgents: ["vc", "customer"],
    contradictionSources: ["vc-1", "cu-1"],
    contradictionAnchors: ["total market is $50B", "WILLINGNESS TO PAY: LOW"],
    contradictionExplanation: "A huge market claim does not survive a low willingness-to-pay claim.",
    revisionWarranted: true,
    revisionTarget: "customer",
    revisionPosition: "4/10",
    revisionReason: "The low score is an unsourced hypothesis and should stay provisional.",
  }));
}

describe("Red Team role", () => {
  it("registers instructions that forbid a chair verdict and scripted fallback", () => {
    expect(registry().instructions("red_team")).toBe(RED_TEAM_INSTRUCTIONS);
    expect(RED_TEAM_INSTRUCTIONS).toContain("simulated");
    expect(RED_TEAM_INSTRUCTIONS).toContain("not proof of displacement");
    expect(RED_TEAM_INSTRUCTIONS).not.toContain("sample critique");
    const prompt = buildRedTeamPrompt(request(clinicSources), registry());
    expect(prompt.ok).toBe(true);
    if (!prompt.ok) return;
    expect(prompt.user).toContain("Clinic intake copilot");
    expect(prompt.user).toContain("id: vc-1");
    expect(prompt.system).toContain("INVEST, MAYBE, or PASS");
  });

  it("returns a provider envelope with the seven sections in order", async () => {
    const result = await generateRedTeamReview(request(clinicSources), client(clinicReply()), registry());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const envelope = parseContribution("red_team", "challenge", result.raw);
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    expect(envelope.value.role).toBe("red_team");
    expect(envelope.value.stage).toBe("challenge");
    expect(envelope.value.decision).toBeNull();
    expect(envelope.value.positionLabel).toBe("challenge");
    expect(envelope.value.summary.endsWith(".")).toBe(true);
    expect(presentationOrderValid(result.presentation)).toBe(true);
    expect(envelope.value.fields.sourceRefs).toEqual(["vc-1", "cu-1", "co-1"]);
    expect(envelope.value.fields.targetedRoles).toEqual(["vc", "customer", "competitor"]);
    expect(String(envelope.value.fields.questions)).toContain("stated price");
    expect(result.presentation).toContain("Target Agent: VC");
    expect(result.presentation).toContain("VC and Customer disagree");
    expect(result.presentation).toContain("Customer should revise 4/10");
    expect(result.presentation).not.toContain("replacement score of");
  });

  it("accepts two challenges against one agent and an unavailable third slot", async () => {
    const raw = payload(
      "Only two claims are supportable, so the third slot stays empty.",
      baseFields({
        challengeStatus: ["substantive", "substantive", "unavailable"],
        challengeTarget: ["vc", "vc", "unavailable"],
        challengeSource: ["vc-1", "vc-1", "unavailable"],
        challengeClaim: [
          "The total market is $50B is not reachable demand.",
          "The first hundred users are still unproven in this claim.",
          "unavailable",
        ],
        challengeAnchor: ["total market is $50B", "first hundred users", "unavailable"],
        challengeWhy: [
          "No source converts the category total into buyers who can be reached.",
          "The position stays generous while the first hundred users are still unproven.",
          "unavailable",
        ],
        challengeMust: [
          "A sourced reachable-market estimate must survive a buyer count.",
          "The score must be tied to a channel the founder can actually name.",
          "unavailable",
        ],
        challengeUnavailable: ["unavailable", "unavailable", "The third assessment adds no distinct claim."],
        revisionWarranted: true,
        revisionTarget: "vc",
        revisionPosition: "MAYBE",
        revisionReason: "MAYBE is ahead of the evidence and should be marked provisional.",
      }),
    );
    const sources = [
      source(
        "vc-1",
        "vc",
        "The total market is $50B so this is fundable. The first hundred users are still unproven.",
        "MAYBE",
        72,
      ),
      ...clinicSources.slice(1),
    ];
    const result = await generateRedTeamReview(request(sources), client(raw), registry());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.presentation).toContain("Target Agent: unavailable");
    expect(result.presentation).toContain("The third assessment adds no distinct claim.");
    expect(result.presentation).not.toContain("Engineer claims");
  });

  it("discloses missing assessments inside the required format", async () => {
    const partial = clinicSources.filter((item) => item.role !== "engineer");
    const raw = payload(
      "Engineer was not supplied, so this is not a complete committee review.",
      baseFields({
        missingAssessments: ["engineer"],
        reviewComplete: false,
        challengeStatus: ["substantive", "unavailable", "unavailable"],
        challengeTarget: ["customer", "unavailable", "unavailable"],
        challengeSource: ["cu-1", "unavailable", "unavailable"],
        challengeClaim: ["WILLINGNESS TO PAY: LOW is not observed demand.", "unavailable", "unavailable"],
        challengeAnchor: ["WILLINGNESS TO PAY: LOW", "unavailable", "unavailable"],
        challengeWhy: ["No interview or purchase attempt supports the low score.", "unavailable", "unavailable"],
        challengeMust: ["Target buyers must reject a stated price in a real comparison.", "unavailable", "unavailable"],
        challengeUnavailable: [
          "unavailable",
          "Competitor adds no distinct supportable claim beyond copyability.",
          "Engineer was not supplied, so no engineering claim can be challenged.",
        ],
      }),
    );
    const result = await generateRedTeamReview(request(partial), client(raw), registry());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const envelope = parseContribution("red_team", "challenge", result.raw);
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    expect(envelope.value.positionLabel).toBe("partial");
    expect(envelope.value.fields.reviewComplete).toBe(false);
    expect(envelope.value.fields.missingAssessments).toEqual(["engineer"]);
    expect(result.presentation).toContain("not a complete committee review");
    expect(result.presentation).toContain("Missing assessments: Engineer");
    expect(result.presentation).not.toContain("easy to build");
  });

  it("rejects a fabricated contradiction and a replacement score", async () => {
    const compatible = [
      source("vc-2", "vc", "Pain is moderate and the budget owner is unknown.", "MAYBE", 40),
      source("cu-2", "customer", "Pain is moderate and the budget owner is unknown.", "unsure"),
    ];
    const fabricated = payload(
      "The agents are being treated as if they disagreed.",
      baseFields({
        missingAssessments: ["competitor", "engineer"],
        reviewComplete: false,
        summary: undefined,
        contradictionStatus: "present",
        contradictionAgents: ["vc", "customer"],
        contradictionSources: ["vc-2", "cu-2"],
        contradictionAnchors: ["Pain is moderate", "budget owner is unknown"],
        contradictionExplanation: "They emphasize different words.",
      }),
    );
    const replaced = clinicReply().replace(
      "The low score is an unsourced hypothesis and should stay provisional.",
      "Change their score to 80.",
    );
    const verdict = clinicReply().replace('"positionLabel":"challenge"', '"positionLabel":"pass","decision":{"verdict":"pass"}');
    const missingSource = clinicReply().replace("cu-1", "not-a-real-id");
    for (const raw of [fabricated, replaced, verdict, missingSource]) {
      const result = await generateRedTeamReview(
        raw === fabricated ? request(compatible) : request(clinicSources),
        client(raw),
        registry(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("invalid_response");
      expect(result.error.message).not.toContain("RED TEAM SUMMARY:");
    }
    const honest = payload(
      "Competitor and Engineer were not supplied, so this is not a complete committee review.",
      baseFields({
        missingAssessments: ["competitor", "engineer"],
        reviewComplete: false,
        contradictionExplanation: "There is no contradiction in the supplied claims.",
      }),
    );
    const accepted = await generateRedTeamReview(request(compatible), client(honest), registry());
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.presentation).toContain("no contradiction");
    expect(accepted.presentation).toContain("No revision is warranted");
  });
});

describe("evaluation fixtures", () => {
  async function reject(raw: string, assessments: AssessmentSource[], defense = "") {
    const result = await generateRedTeamReview(request(assessments, "Clinic intake copilot", defense), client(raw), registry());
    expect(result.ok).toBe(false);
    if (result.ok) return "";
    return result.error.message;
  }

  it("rejects unsupported optimism, pessimism, simulation, copying, and correlated proof", async () => {
    const optimism = await reject(
      payload("The committee is treating a category total as proof.", baseFields(), [
        { statement: "The market is $50B.", grounding: "supported_evidence", evidenceNote: "VC said so." },
      ]),
      clinicSources,
    );
    expect(optimism).toContain("market-size");

    const pessimism = await reject(
      payload("The committee is treating a hunch as proof.", baseFields(), [
        { statement: "Users will not pay.", grounding: "supported_evidence", evidenceNote: "Customer said so." },
      ]),
      [source("cu-3", "customer", "WILLINGNESS TO PAY: LOW and nobody I know would buy this.", "LOW")],
    );
    expect(pessimism).toContain("refusal-to-pay");

    const simulated = await reject(
      payload("The committee is treating a role-play as proof.", baseFields(), [
        { statement: "Customers will not pay.", grounding: "supported_evidence", evidenceNote: "Simulated buyer." },
      ]),
      [source("cu-4", "customer", "As a simulated buyer I would not pay for this tool.", "LOW")],
    );
    expect(simulated).toContain("simulated");

    const copying = await reject(
      payload("The committee is treating a sprint estimate as displacement.", baseFields(), [
        {
          statement: "There is no moat because incumbents will erase the product.",
          grounding: "supported_evidence",
          evidenceNote: "Competitor said it can be copied.",
        },
      ]),
      [source("co-4", "competitor", "This is a feature I can ship in a sprint.", "no moat")],
    );
    expect(copying).toContain("displacement");

    const shared = "Users will pay twenty dollars a month for this workflow.";
    const correlated = await reject(
      payload("The committee is treating repetition as confirmation.", baseFields(), [
        {
          statement: "Both agents independently confirmed the price.",
          grounding: "supported_evidence",
          evidenceNote: "VC and Customer used the same sentence.",
        },
      ]),
      [
        source("vc-5", "vc", shared, "MAYBE", 60),
        source("cu-5", "customer", shared, "medium"),
      ],
    );
    expect(correlated).toContain("independent confirmation");
  });

  it("rejects criticism that denies supplied founder defense, and accepts an honest pass", async () => {
    const defense = "Two clinics signed a paid contract at $400 per month.";
    const assessments = [
      source("cu-6", "customer", "WILLINGNESS TO PAY: LOW and nobody I know would buy this.", "4/10"),
      source("vc-6", "vc", "Pain is moderate and the budget owner is unknown.", "MAYBE", 44),
    ];
    const denied = payload(
      "Competitor and Engineer were not supplied, so this is not a complete committee review.",
      baseFields({
        missingAssessments: ["competitor", "engineer"],
        reviewComplete: false,
        challengeStatus: ["substantive", "unavailable", "unavailable"],
        challengeTarget: ["customer", "unavailable", "unavailable"],
        challengeSource: ["cu-6", "unavailable", "unavailable"],
        challengeClaim: ["WILLINGNESS TO PAY: LOW means nobody has paid.", "unavailable", "unavailable"],
        challengeAnchor: ["WILLINGNESS TO PAY: LOW", "unavailable", "unavailable"],
        challengeWhy: ["There is no evidence anybody paid, so the low score is already proven.", "unavailable", "unavailable"],
        challengeMust: ["A buyer would have to produce a receipt before this score could move.", "unavailable", "unavailable"],
        challengeUnavailable: ["unavailable", "No second supportable challenge.", "No third supportable challenge."],
      }),
    );
    const bad = await generateRedTeamReview(request(assessments, "Clinic intake copilot", defense), client(denied), registry());
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toContain("founder defense");

    const honest = payload(
      "Competitor and Engineer were not supplied, so this is not a complete committee review.",
      baseFields({
        missingAssessments: ["competitor", "engineer"],
        reviewComplete: false,
        challengeStatus: ["substantive", "unavailable", "unavailable"],
        challengeTarget: ["customer", "unavailable", "unavailable"],
        challengeSource: ["cu-6", "unavailable", "unavailable"],
        challengeClaim: [
          "WILLINGNESS TO PAY: LOW ignores the signed paid contract.",
          "unavailable",
          "unavailable",
        ],
        challengeAnchor: ["WILLINGNESS TO PAY: LOW", "unavailable", "unavailable"],
        challengeWhy: [
          "Founder defense says two clinics signed a paid contract, so a blanket low score is too dismissive.",
          "unavailable",
          "unavailable",
        ],
        challengeMust: [
          "The score should stay provisional until the contract terms are inspected.",
          "unavailable",
          "unavailable",
        ],
        challengeUnavailable: ["unavailable", "No second distinct claim was supplied.", "No third distinct claim was supplied."],
        revisionWarranted: true,
        revisionTarget: "customer",
        revisionPosition: "4/10",
        revisionReason: "The low position ignores a signed paid contract and should be provisional.",
      }),
    );
    const good = await generateRedTeamReview(request(assessments, "Clinic intake copilot", defense), client(honest), registry());
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.presentation).toContain("signed a paid contract");
    expect(good.presentation).not.toContain("No revision is warranted");
  });
});

describe("context isolation and recovery", () => {
  it("grounds two briefs separately and passes founder defense without leakage", async () => {
    const prompts: string[] = [];
    const model: ModelClient = {
      async complete({ user }) {
        prompts.push(user);
        const pet = user.includes("Pet pharmacy refill");
        const defense = user.includes("Paid contracts from two clinics.");
        const summary =
          "Customer, Competitor, and Engineer were not supplied, so this is not a complete committee review.";
        return payload(summary, baseFields({
            challengeStatus: ["substantive", "unavailable", "unavailable"],
            challengeTarget: ["vc", "unavailable", "unavailable"],
            challengeSource: [pet ? "pet-vc" : "vc-1", "unavailable", "unavailable"],
            challengeClaim: [
              pet
                ? "refill reminders are the wedge is assumed, not observed."
                : "The total market is $50B is being treated as reachable demand.",
              "unavailable",
              "unavailable",
            ],
            challengeAnchor: [
              pet ? "refill reminders are the wedge" : "total market is $50B",
              "unavailable",
              "unavailable",
            ],
            challengeWhy: [
              defense
                ? "Paid contracts from two clinics do not by themselves prove the market figure."
                : "No sourced buyer count supports the quoted claim.",
              "unavailable",
              "unavailable",
            ],
            challengeMust: [
              "A buyer outside the founder's network must request this workflow.",
              "unavailable",
              "unavailable",
            ],
            challengeUnavailable: [
              "unavailable",
              "No second distinct claim was supplied.",
              "No third distinct claim was supplied.",
            ],
            missingAssessments: ["customer", "competitor", "engineer"],
            reviewComplete: false,
            revisionWarranted: true,
            revisionTarget: "vc",
            revisionPosition: pet ? "PASS" : "MAYBE",
            revisionReason: "The position should stay provisional until a buyer count exists.",
        }));
      },
    };
    const clinic = request(
      [source("vc-1", "vc", "The total market is $50B so this is fundable.", "MAYBE", 72)],
      "Clinic intake copilot",
      "Paid contracts from two clinics.",
    );
    const pet = request(
      [source("pet-vc", "vc", "The refill reminders are the wedge for every shelter.", "PASS", 20)],
      "Pet pharmacy refill",
    );
    const first = await generateRedTeamReview(clinic, model, registry());
    const second = await generateRedTeamReview(pet, model, registry());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(prompts[0]).toContain("Clinic intake copilot");
    expect(prompts[0]).toContain("Paid contracts from two clinics.");
    expect(prompts[0]).not.toContain("Pet pharmacy refill");
    expect(prompts[1]).toContain("Pet pharmacy refill");
    expect(prompts[1]).not.toContain("Clinic intake copilot");
    expect(prompts[1]).not.toContain("Paid contracts from two clinics.");
    expect(first.presentation).toContain("total market is $50B");
    expect(first.presentation).toContain("Paid contracts from two clinics");
    expect(second.presentation).toContain("refill reminders are the wedge");
    expect(second.presentation).not.toContain("Clinic intake");
  });

  it("records a full-committee turn and leaves specialist assessments intact", async () => {
    let run = createRun(brief("Clinic intake copilot", "Two clinics asked for a pilot."));
    run = record(run, "vc", "The total market is $50B so this is fundable.", "MAYBE");
    run = record(run, "customer", "WILLINGNESS TO PAY: LOW and nobody I know would buy this.", "4/10");
    run = record(run, "competitor", "This is a feature I can ship in a sprint.", "no moat");
    run = record(run, "engineer", "The core workflow is easy to build as a weekend project.", "easy");
    expect(run.phase).toBe("challenge");
    const before = run.messages.map((message) => message.id);
    const model = client((user) => {
      const id = (role: string) => user.match(new RegExp(`id: (\\S+) role: ${role}`))?.[1] ?? "";
      return clinicReply().replaceAll("vc-1", id("vc")).replaceAll("cu-1", id("customer")).replaceAll("co-1", id("competitor"));
    });
    const done = await runRedTeamTurn(run, model, registry());
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.phase).toBe("rebuttals");
    expect(done.value.messages.filter((message) => message.speaker === "red_team")).toHaveLength(1);
    expect(done.value.messages.filter((message) => message.stage === "assessment").map((message) => message.id)).toEqual(before);
    expect(model.prompts[0]).toContain("Two clinics asked for a pilot.");
    expect(done.value.messages.at(-1)?.envelope?.decision).toBeNull();
    const again = await runRedTeamTurn(done.value, model, registry());
    expect(again.ok).toBe(false);
    expect(again.value.messages.filter((message) => message.speaker === "red_team")).toHaveLength(1);
  });

  it("returns recoverable errors and records no sample critique", async () => {
    let run = createRun(brief("Clinic intake copilot"));
    for (const role of SPECIALIST_ROLES) {
      run = record(run, role, `${role} weighs the submitted idea without a sourced demand claim.`, role === "vc" ? "MAYBE" : "unsure");
    }
    const before = run.messages.length;
    const cases: Array<[ModelClient | null, string]> = [
      [null, "missing_credentials"],
      [client(Object.assign(new Error("The AI provider timed out."), { code: "timeout" })), "timeout"],
      [client(Object.assign(new Error("The AI provider returned an error."), { code: "provider_failure" })), "provider_failure"],
      [client("not json"), "invalid_response"],
      [client(clinicReply().replace("vc-1", "missing-id")), "invalid_response"],
    ];
    for (const [model, code] of cases) {
      const result = await runRedTeamTurn(run, model, registry());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(code);
      expect(result.value.messages).toHaveLength(before);
      expect(JSON.stringify(result.value.messages)).not.toContain("RED TEAM SUMMARY:");
      const retried = retryTurn(result.value);
      expect(retried.ok).toBe(true);
      if (!retried.ok) return;
      run = retried.value;
    }
    const unregistered = await runRedTeamTurn(run, client(clinicReply()), createRoleRegistry());
    expect(unregistered.ok).toBe(false);
    if (!unregistered.ok) expect(unregistered.error.code).toBe("role_not_configured");
    expect(unregistered.value.messages).toHaveLength(before);
  });
});

function record(run: DebateRun, role: SpecialistRole, summary: string, position: string): DebateRun {
  const started = beginTurn(run, role);
  if (!started.ok) throw new Error(started.error.message);
  const vcFields = {
    score: 72,
    investmentPosition: "MAYBE",
    strongestInvestmentCase: "Missed calls are a measurable revenue leak.",
    biggestFundabilityRisk: "The total market is $50B is not a buyer list.",
    marketSizeConcern: "The clinic segment may not support venture scale.",
    first100Users: "Sell through the founder's clinic network.",
    defensibilityConcern: "Scheduling incumbents can copy call booking.",
    killShotQuestion: "Who renews after the pilot?",
    oneLineVerdict: "A feature until the buyer is named.",
  };
  const done = completeTurn(
    started.value,
    JSON.stringify({
      summary,
      rationale: "Reasoned only from the submitted brief.",
      assumptions: [{ statement: "Demand beyond the brief is unproven.", grounding: "assumption" }],
      risks: ["The first channel may not repeat."],
      positionLabel: role === "vc" ? "MAYBE" : role === "competitor" ? "COPYABLE_FEATURE" : role === "engineer" ? "EASY_MVP" : position,
      fields: role === "vc" ? vcFields : role === "competitor"
        ? {
            threatScore: 2,
            stance: "COPYABLE_FEATURE",
            incumbent: "Scheduling incumbents",
            crushPlan: "Bundle the booking feature and make it free.",
            weakMoat: "No proprietary clinic data.",
            copyabilityRisk: "A vendor can recreate the feature in a sprint.",
            distributionDisadvantage: "The incumbent already owns the clinic relationship.",
            dangerousMove: "Exclusive clinic data the incumbent cannot see.",
            founderQuestion: "What do you own if the incumbent bundles this?",
            verdict: "This is a feature, not a company.",
          }
        : role === "engineer"
          ? ENGINEER_CARD_FIELDS
          : { note: summary },
    }),
  );
  if (!done.ok) throw new Error(done.error.message);
  return done.value;
}
