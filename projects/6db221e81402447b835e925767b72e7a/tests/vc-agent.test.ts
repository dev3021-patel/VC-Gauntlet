import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  CHAIR_VERDICTS,
  VC_POSITIONS,
  isChairVerdict,
  isVcPosition,
  runVcFounderResponse,
  runVcOpening,
  runVcRebuttal,
  type CompletionProvider,
  type IdeaBrief,
  type VcAssessment,
} from "../src/index.ts"

const brief: IdeaBrief = {
  idea: "Ledgerlane",
  problem: "Clinic billing teams lose claims in email threads.",
  targetCustomer: "Independent outpatient clinics",
  proposedSolution: "A claims inbox that drafts payer appeals.",
  businessModel: "Per-clinic monthly subscription",
  traction: "Three clinics paid a $200 pilot.",
}

function provider(payload: unknown): CompletionProvider & { calls: number } {
  return {
    calls: 0,
    async complete() {
      this.calls += 1
      return JSON.stringify(payload)
    },
  }
}

function openingPayload(position: "INVEST" | "MAYBE" | "PASS", score: number) {
  return {
    score,
    position,
    justification: `${position} at ${score} because clinic billing spend can expand but distribution is unproven.`,
    strongestInvestmentCase: "Clinics already pay to recover denied claims, so a workflow wedge can expand into revenue cycle software.",
    biggestFundabilityRisk: "This can stall as a narrow inbox feature that Epic or a billing vendor ships.",
    first100Users: "Sell the paid pilot to clinic administrators through two revenue-cycle consultants.",
    killShotQuestion: "Will clinics pay $500 a month after the consultant who made the introduction leaves?",
    oneLineVerdict: "Real claim leakage, but this still looks like a feature until the wedge locks in the billing workflow.",
    assumptions: [
      {
        claim: "Independent clinics will expand from appeals into full revenue-cycle software.",
        status: "assumption",
        basis: "Model inference, not founder evidence.",
      },
      {
        claim: "Three clinics paid a $200 pilot.",
        status: "supported",
        basis: "Founder traction.",
      },
    ],
  }
}

const opening: VcAssessment = {
  score: 58,
  position: "MAYBE",
  justification: "Maybe until willingness to pay is proven beyond the pilot.",
  strongestInvestmentCase: "Denied claims are a budget line clinics already pay to recover.",
  biggestFundabilityRisk: "A billing incumbent can copy the appeals inbox.",
  first100Users: "Start with the consultant channel that sourced the pilot.",
  killShotQuestion: "What retention exists after month three?",
  oneLineVerdict: "A paid wedge, not yet a venture-scale company.",
}

describe("VC opening assessment", () => {
  it("returns a provider-generated envelope with every required field", async () => {
    const model = provider(openingPayload("MAYBE", 58))
    const result = await runVcOpening({ brief, provider: model })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(model.calls, 1)
    assert.equal(result.role, "vc")
    assert.equal(result.contributionType, "opening_assessment")
    assert.equal(result.result.score, 58)
    assert.equal(result.result.position, "MAYBE")
    assert.match(result.content, /VC SCORE: 58\/100/)
    assert.match(result.content, /INVESTMENT POSITION: MAYBE/)
    assert.match(result.content, /STRONGEST INVESTMENT CASE:/)
    assert.match(result.content, /BIGGEST FUNDABILITY RISK:/)
    assert.match(result.content, /FIRST 100 USERS:/)
    assert.match(result.content, /KILL-SHOT QUESTION:/)
    assert.match(result.content, /ONE-LINE VC VERDICT:/)
    assert.match(result.content, /JUSTIFICATION:/)
    assert.equal(result.content.includes("interesting idea"), false)
    assert.equal("content" in result && !("sample" in result), true)
  })

  it("accepts INVEST, MAYBE, and PASS without mapping MAYBE to a chair verdict", async () => {
    for (const [position, score] of [
      ["INVEST", 82],
      ["MAYBE", 58],
      ["PASS", 24],
    ] as const) {
      const result = await runVcOpening({ brief, provider: provider(openingPayload(position, score)) })
      assert.equal(result.ok, true)
      if (!result.ok) continue
      assert.equal(result.result.position, position)
      assert.equal(result.result.score, score)
      assert.match(result.content, new RegExp(position))
      assert.equal(result.result.position === "PIVOT", false)
      assert.equal(isChairVerdict(result.result.position), false)
    }
    assert.equal(VC_POSITIONS.includes("MAYBE"), true)
    assert.equal(CHAIR_VERDICTS.includes("Pivot"), true)
    assert.equal(CHAIR_VERDICTS.includes("MAYBE" as "Pivot"), false)
    assert.equal(isVcPosition("MAYBE"), true)
    assert.equal(isVcPosition("PIVOT"), false)
  })

  it("rejects scores and positions outside the VC contract", async () => {
    const badScore = await runVcOpening({
      brief,
      provider: provider({ ...openingPayload("PASS", 24), score: 101 }),
    })
    assert.equal(badScore.ok, false)
    if (!badScore.ok) assert.equal(badScore.code, "invalid_output")

    const pivot = await runVcOpening({
      brief,
      provider: provider({ ...openingPayload("PASS", 24), position: "PIVOT" }),
    })
    assert.equal(pivot.ok, false)
    if (!pivot.ok) {
      assert.equal(pivot.code, "invalid_output")
      assert.equal("result" in pivot, false)
      assert.equal(JSON.stringify(pivot).includes("ONE-LINE VC VERDICT"), false)
    }
  })
})

describe("grounding", () => {
  it("relabels unsupported claims and strips fabricated citations", async () => {
    const result = await runVcOpening({
      brief,
      provider: provider({
        ...openingPayload("PASS", 31),
        oneLineVerdict: "Pass until distribution is proven. Source: https://example.com/fake-market [1]",
        assumptions: [
          {
            claim: "The outpatient billing software market is $40 billion.",
            status: "supported",
            basis: "According to a fabricated analyst note https://example.com/report",
          },
        ],
      }),
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.assumptions[0]?.status, "assumption")
    assert.equal(JSON.stringify(result).includes("http"), false)
    assert.equal(JSON.stringify(result).includes("[1]"), false)
    assert.equal(JSON.stringify(result).includes("example.com"), false)
  })
})

describe("rebuttal and founder turns", () => {
  it("references the Red Team challenge, declares the change, and preserves the opening", async () => {
    const challenge = "Your distribution plan depends on two consultants who do not scale."
    const result = await runVcRebuttal({
      brief,
      opening,
      challenge,
      provider: provider({
        challengeReference: "two consultants who do not scale",
        positionChanged: false,
        scoreChanged: true,
        revisedScore: 44,
        revisedPosition: "MAYBE",
        reason: "The consultant channel is a first-100 plan, not a venture distribution engine, so the score drops.",
        rebuttal: "The challenge on two consultants who do not scale is fair. MAYBE stands, but 44 reflects a weaker path to scale.",
        assumptions: [
          {
            claim: "Consultant-led clinic sales will not scale past the first cohort.",
            status: "assumption",
          },
        ],
      }),
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.contributionType, "rebuttal")
    assert.match(result.content, /two consultants who do not scale/)
    assert.equal(result.result.scoreChanged, true)
    assert.equal(result.result.positionChanged, false)
    assert.equal(result.result.revisedPosition, "MAYBE")
    assert.deepEqual(result.result.openingAssessment, opening)
    assert.notEqual(result.result.openingAssessment, opening)
  })

  it("answers a founder question from the brief without changing the recommendation", async () => {
    const founderMessage = "We now have six clinics asking for annual contracts."
    const result = await runVcFounderResponse({
      brief,
      opening,
      founderMessage,
      debate: [
        {
          id: "f1",
          role: "founder",
          stage: "founder_discussion",
          content: founderMessage,
        },
      ],
      provider: provider({
        addressesFounder: "six clinics asking for annual contracts",
        response: "Ledgerlane still needs proof those annual contracts renew. Six clinics is useful evidence, not a new investment decision.",
        position: "INVEST",
        score: 90,
        assumptions: [
          {
            claim: "Six clinics asking for annual contracts.",
            status: "supported",
          },
        ],
      }),
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.contributionType, "founder_response")
    assert.match(result.content, /six clinics asking for annual contracts/)
    assert.match(result.content, /Ledgerlane/)
    assert.equal(result.result.recommendationChanged, false)
    assert.equal(result.result.position, "MAYBE")
    assert.equal(result.result.score, 58)
    assert.equal(result.assumptions[0]?.status, "supported")
  })
})

describe("failure recovery", () => {
  it("returns recoverable errors and no sample contribution", async () => {
    const missing = await runVcOpening({ brief, env: {} })
    const timeout = await runVcOpening({
      brief,
      provider: {
        async complete() {
          const error = new Error("timed out")
          error.name = "AbortError"
          throw error
        },
      },
    })
    const failed = await runVcOpening({
      brief,
      provider: {
        async complete() {
          throw new Error("socket closed")
        },
      },
    })
    const invalid = await runVcOpening({
      brief,
      provider: {
        async complete() {
          return "not json"
        },
      },
    })
    const incomplete = await runVcOpening({
      brief: { ...brief, businessModel: " " },
      provider: provider(openingPayload("PASS", 10)),
    })

    for (const [result, code] of [
      [missing, "missing_credentials"],
      [timeout, "timeout"],
      [failed, "provider_failure"],
      [invalid, "invalid_output"],
      [incomplete, "invalid_input"],
    ] as const) {
      assert.equal(result.ok, false)
      if (result.ok) continue
      assert.equal(result.recoverable, true)
      assert.equal(result.role, "vc")
      assert.equal(result.code, code)
      assert.equal("result" in result, false)
      assert.equal("content" in result, false)
    }
  })
})
