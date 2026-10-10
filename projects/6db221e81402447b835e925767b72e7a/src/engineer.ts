import type { EngineerScorecard, RoleRegistry } from "./contract";
import { sharedRegistry } from "./provider";

export const ENGINEER_INSTRUCTIONS = `You are the CTO / Engineer Agent in Venture Gauntlet. You are a practical technical cofounder. You care what can actually be built, what is secretly hard, and what can be faked in an MVP without lying to users. Cut scope. Separate demo, MVP, and real product. Call out fake AI autonomy. If technical risk is low but business risk is high, say that. Do not overcomplicate the architecture.

You are evaluating the founder's submitted idea, not Venture Gauntlet. Use only the brief and the debate so far. Label unsupported claims as assumption or unknown. Do not invent citations, market sizes, or integrations the brief did not name.

Opening assessment and rebuttal must return this card in fields. positionLabel must equal buildPosition. That position is not a Chair verdict. Never return decision.

- feasibilityScore: integer 0-10
- buildPosition: EASY_MVP, MODERATE_MVP, HARD_MVP, or TECHNICALLY_RISKY
- mvpEstimate: HOURS_72, WEEKS_2, MONTHS_2, or MONTHS_6_PLUS
- simplestMvp: smallest version that proves the idea
- fakeableMvp: what can be mocked or concierge-tested
- realProductRequirements: what must eventually be automated
- secretlyHardPart: the trap the founder is underestimating
- dataRequirements: what data is needed and whether it is user-provided, public, proprietary, purchased, scraped, or from an API
- dataAccessRisk: HIGH, MEDIUM, or LOW
- dataAccessExplanation: whether the startup can actually get that data
- aiComplexity: LOW, MEDIUM, or HIGH
- aiComplexityExplanation: say which apply: basic prompting, retrieval, multi-agent workflow, fine-tuning, computer vision, voice, real-time automation, personalization, human review
- apiDependencies: required external APIs or "none"
- infrastructureComplexity: HIGH, MEDIUM, or LOW
- infrastructureExplanation: hosting, database, auth, storage, queues, scaling
- securityPrivacyConcern: HIGH, MEDIUM, or LOW
- securityExplanation: sensitive data and what could go wrong
- reliabilityRisk: HIGH, MEDIUM, or LOW
- reliabilityExplanation: hallucinations, bad recommendations, latency, or broken integrations
- costRisk: HIGH, MEDIUM, or LOW
- costExplanation: model, infrastructure, human review, or scaling cost
- buildRisk: the thing most likely to delay the product
- recommendedApproach: a practical build path
- whatToCut: features that should not be built yet
- founderTechQuestion: one question ending in a question mark
- engineerVerdict: 2-3 sentences on whether it is buildable, the fastest MVP, and the biggest technical risk

Also put that card in summary with these headings: TECHNICAL FEASIBILITY SCORE, BUILD POSITION, MVP ESTIMATE, SIMPLEST MVP, FAKEABLE MVP, REAL PRODUCT REQUIREMENTS, SECRETLY HARD PART, DATA REQUIREMENTS, DATA ACCESS RISK, AI COMPLEXITY, API / INTEGRATION DEPENDENCIES, INFRASTRUCTURE COMPLEXITY, SECURITY / PRIVACY CONCERN, RELIABILITY RISK, COST RISK, BUILD RISK, RECOMMENDED TECHNICAL APPROACH, WHAT TO CUT, FOUNDER TECH QUESTION, ENGINEER VERDICT.

Rebuttal: quote the Red Team challenge in fields.challengeReference, return the full card, and set changed only if feasibilityScore or buildPosition differs from the opening.
Founder response: answer the question. Do not change the build position.`;

export const ENGINEER_CARD_FIELDS: EngineerScorecard = {
  feasibilityScore: 8,
  buildPosition: "EASY_MVP",
  mvpEstimate: "WEEKS_2",
  simplestMvp: "A form, one model, and a structured transcript.",
  fakeableMvp: "A founder can paste the brief into a prompted thread before the pipeline exists.",
  realProductRequirements: "Distinct role outputs, failure recovery, and no sample text labeled as a debate.",
  secretlyHardPart: "Six prompts on one model restate the brief unless each turn attacks a prior claim.",
  dataRequirements: "The founder supplies the idea brief. No proprietary market dataset.",
  dataAccessRisk: "LOW",
  dataAccessExplanation: "The user provides the brief. External research is not required for the MVP.",
  aiComplexity: "MEDIUM",
  aiComplexityExplanation: "Basic structured prompting plus a multi-step workflow. No vision, voice, or fine-tuning.",
  apiDependencies: "One chat-completions provider. No other platform API.",
  infrastructureComplexity: "LOW",
  infrastructureExplanation: "A small web app and server-side key. No queue or multi-tenant auth in the first cut.",
  securityPrivacyConcern: "MEDIUM",
  securityExplanation: "Founders paste unreleased ideas. The provider key must stay on the server.",
  reliabilityRisk: "MEDIUM",
  reliabilityExplanation: "Invalid JSON and confident assumptions can look like research.",
  costRisk: "LOW",
  costExplanation: "A handful of model calls per debate. No human review queue.",
  buildRisk: "Schema failures and roles that collapse into one voice.",
  recommendedApproach: "Start with a form, structured outputs, and ordered stages. Add retrieval only after demand.",
  whatToCut: "Accounts, web research, saved history, and tool-using agents.",
  founderTechQuestion: "Must a role cite a fact the founder did not type?",
  engineerVerdict: "This is buildable. The fastest MVP is a form and structured model calls. The risk is sounding sure without outside evidence.",
};

const BUILD_LABELS = {
  EASY_MVP: "EASY MVP",
  MODERATE_MVP: "MODERATE MVP",
  HARD_MVP: "HARD MVP",
  TECHNICALLY_RISKY: "TECHNICALLY RISKY",
} as const;

const ESTIMATE_LABELS = {
  HOURS_72: "72 HOURS",
  WEEKS_2: "2 WEEKS",
  MONTHS_2: "2 MONTHS",
  MONTHS_6_PLUS: "6+ MONTHS",
} as const;

export function formatEngineerOutput(card: EngineerScorecard): string {
  return [
    `TECHNICAL FEASIBILITY SCORE: ${card.feasibilityScore}/10`,
    "",
    "BUILD POSITION:",
    BUILD_LABELS[card.buildPosition],
    "",
    "MVP ESTIMATE:",
    ESTIMATE_LABELS[card.mvpEstimate],
    "",
    "SIMPLEST MVP:",
    card.simplestMvp,
    "",
    "FAKEABLE MVP:",
    card.fakeableMvp,
    "",
    "REAL PRODUCT REQUIREMENTS:",
    card.realProductRequirements,
    "",
    "SECRETLY HARD PART:",
    card.secretlyHardPart,
    "",
    "DATA REQUIREMENTS:",
    card.dataRequirements,
    "",
    "DATA ACCESS RISK:",
    card.dataAccessRisk,
    "",
    card.dataAccessExplanation,
    "",
    "AI COMPLEXITY:",
    card.aiComplexity,
    "",
    card.aiComplexityExplanation,
    "",
    "API / INTEGRATION DEPENDENCIES:",
    card.apiDependencies,
    "",
    "INFRASTRUCTURE COMPLEXITY:",
    card.infrastructureComplexity,
    "",
    card.infrastructureExplanation,
    "",
    "SECURITY / PRIVACY CONCERN:",
    card.securityPrivacyConcern,
    "",
    card.securityExplanation,
    "",
    "RELIABILITY RISK:",
    card.reliabilityRisk,
    "",
    card.reliabilityExplanation,
    "",
    "COST RISK:",
    card.costRisk,
    "",
    card.costExplanation,
    "",
    "BUILD RISK:",
    card.buildRisk,
    "",
    "RECOMMENDED TECHNICAL APPROACH:",
    card.recommendedApproach,
    "",
    "WHAT TO CUT:",
    card.whatToCut,
    "",
    "FOUNDER TECH QUESTION:",
    card.founderTechQuestion,
    "",
    "ENGINEER VERDICT:",
    card.engineerVerdict,
  ].join("\n");
}

export function registerEngineerAgent(registry: RoleRegistry = sharedRegistry): void {
  registry.register("engineer", ENGINEER_INSTRUCTIONS);
}
