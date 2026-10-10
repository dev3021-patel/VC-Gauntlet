import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyBrief } from "./brief";
import { parseContribution, SPECIALIST_ROLES, type RoleEnvelope, type RoleId, type ContributionStage } from "./contract";
import { beginTurn, completeTurn, createRun, type DebateMessage, type DebateRun } from "./debate";
import { handleDebateApi, storeRun } from "./server";
import { parseChairChatReply, runChairChatTurn, type ChairChatInput } from "./verdictChat";

function message(role: RoleId, stage: ContributionStage, summary: string, fields: RoleEnvelope["fields"] = {}): DebateMessage {
  return {
    id: `${role}-${stage}`, speaker: role, stage, body: summary, createdAt: "2026-10-10T00:00:00.000Z",
    envelope: {
      schemaVersion: 1, role, stage, summary, rationale: `${role} reasoning from the supplied brief.`,
      assumptions: [{ statement: "Payment evidence is unverified.", grounding: "founder_provided" }],
      risks: ["Switching friction remains."], positionLabel: role === "chair" ? "pivot" : "skeptical",
      changed: stage === "rebuttal", changeReason: stage === "rebuttal" ? "The challenge exposed payment friction." : null,
      fields, decision: role === "chair" ? {
        verdict: "pivot", pivotDirection: "Start with clinic groups.", decisiveReasons: ["Switching friction blocks adoption."],
        disagreements: ["Customer and Engineer disagree."], unresolvedRisks: ["Payment is unverified."], nextSteps: ["Ask ten clinics to prepay."],
      } : null, vc: null, competitor: null,
    },
  };
}

function completedRun(): DebateRun {
  const run = createRun({ ...emptyBrief(), idea: "Clinic booking assistant", problem: "Unanswered calls waste appointments.", targetCustomer: "Independent clinic managers", solution: "An assistant books incoming calls.", businessModel: "Per-location monthly subscription", founderEvidence: "A pilot ran for two weeks." });
  run.messages = [
    ...SPECIALIST_ROLES.map((role) => message(role, "assessment", `${role} opening argument about clinic demand.`, {
      ...(role === "vc" ? { score: 70 } : role === "customer" ? { adoptionScore: 8 } : role === "engineer" ? { feasibilityScore: 9 } : { threatScore: 3 }),
      supportingDetail: "Unique opening detail that summaries omit.",
    })),
    message("red_team", "challenge", "Pilot usage does not prove willingness to pay.", { challengeSource: ["customer-assessment"], questions: ["Would clinics prepay?"] }),
    ...SPECIALIST_ROLES.map((role) => message(role, "rebuttal", role === "customer" ? "Payment evidence is still missing." : `${role} rebuttal to the payment challenge.`, {
      ...(role === "vc" ? { score: 50 } : role === "customer" ? { adoptionScore: 5 } : role === "engineer" ? { feasibilityScore: 7 } : { threatScore: 2 }),
    })),
    { id: "founder-evidence", speaker: "founder", stage: "founder", body: "Two clinics asked for another pilot.", createdAt: "2026-10-10T00:00:00.000Z" },
    message("customer", "founder_response", "Requests for pilots are not prepaid contracts."),
    message("chair", "verdict", "PIVOT: Start with clinic groups.", { displayVerdict: "PIVOT", confidence: 64 }),
  ];
  run.phase = "complete";
  run.verdictRequested = true;
  return run;
}

function answer(fields: RoleEnvelope["fields"] = {}, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    summary: "The Customer's payment concern drove the pivot.", rationale: "The rebuttal distinguishes use from payment.",
    assumptions: [], risks: ["Payment intent remains unverified."], positionLabel: "discussion",
    fields: { sourceMessageIds: ["customer-rebuttal"], sourceArguments: ["Payment evidence is still missing."], notAssessed: false, newEvidence: false, validationTest: "", ownView: "", provisionalChange: "", provisionalReason: "", ...fields },
    ...extra,
  });
}

async function call(run: DebateRun, input: Partial<ChairChatInput>, method = "POST") {
  const req = Object.assign(Readable.from([JSON.stringify({ runId: run.id, ...input })]), { url: "/api/debate/verdict-chat", method });
  let output = "";
  const res = { statusCode: 200, setHeader() {}, end(value: string) { output = value; } };
  await handleDebateApi(req as never, res as never);
  return { status: res.statusCode, body: JSON.parse(output) as { reply?: RoleEnvelope; error?: string; run?: DebateRun } };
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Chair verdict chat", () => {
  it("uses the entire completed run, including revised scores and verdict, without modifying it", async () => {
    const run = completedRun();
    const before = structuredClone(run);
    const complete = vi.fn(async (_input: { user: string; system: string }) => answer());
    const result = await runChairChatTurn(run, { question: "Why pivot?" }, { complete });
    expect(result.ok).toBe(true);
    expect(run).toEqual(before);
    const prompt = complete.mock.calls[0][0] as { user: string; system: string };
    const json = prompt.user.split("IMMUTABLE COMPLETE RUN\n")[1].split("\n\nCHAT HISTORY")[0];
    expect(JSON.parse(json)).toEqual(before);
    expect(prompt.user).toContain('"adoptionScore":5');
    expect(prompt.user).toContain('"feasibilityScore":7');
    expect(prompt.user).toContain("Unique opening detail that summaries omit.");
    if (result.ok) {
      expect(result.reply.stage).toBe("verdict_chat");
      expect(result.reply.summary).toContain("customer (rebuttal)");
      expect(result.reply.decision).toBeNull();
    }
  });

  it("rejects chat before the verdict and cannot record chat as a debate turn", async () => {
    const run = completedRun();
    const complete = vi.fn(async () => answer());
    expect((await runChairChatTurn({ ...run, phase: "founder" }, { question: "Why pivot?" }, { complete })).ok).toBe(false);
    expect(complete).not.toHaveBeenCalled();
    expect(beginTurn(run, "chair").ok).toBe(false);
    expect(completeTurn({ ...run, lock: { role: "chair", stage: "verdict_chat" } }, answer()).ok).toBe(false);
    expect(parseContribution("chair", "assessment", answer()).ok).toBe(false);
    expect(parseContribution("customer", "verdict_chat", answer()).ok).toBe(false);
  });

  it("rejects citations to other runs, fabricated excerpts, and replacement decisions or scores", () => {
    const run = completedRun();
    for (const raw of [
      answer({ sourceMessageIds: ["other-run-message"] }),
      answer({ sourceArguments: ["Invented willingness to pay is certain."] }),
      answer({ sourceMessageIds: [] }),
      answer({ score: 90 }),
      answer({}, { decision: { verdict: "invest" } }),
    ]) expect(parseChairChatReply(run, raw, { question: "Why pivot?" }).ok).toBe(false);
  });

  it("labels unassessed questions with an actionable test and separates the Chair's own view", () => {
    const run = completedRun();
    const raw = answer({ sourceMessageIds: [], sourceArguments: [], notAssessed: true, validationTest: "Pilot with ten hospital administrators and measure prepaid conversions.", ownView: "Hospitals may need a longer procurement test." });
    const result = parseChairChatReply(run, raw, { question: "Will hospitals in Brazil buy this?" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reply.summary).toContain("Not assessed by the committee. Test:");
      expect(result.reply.summary).toContain("Chair's own view:");
    }
    expect(parseChairChatReply(run, answer({ notAssessed: true }), { question: "New market?" }).ok).toBe(false);
  });

  it("requires provisional change and reasoning for new evidence, preserving the verdict and scores", async () => {
    const run = completedRun();
    const before = JSON.stringify(run);
    const input = { question: "Does payment change the verdict?", newEvidence: "Three clinics prepaid annual contracts." };
    expect(parseChairChatReply(run, answer(), input).ok).toBe(false);
    expect(parseChairChatReply(run, answer({ newEvidence: true }), input).ok).toBe(false);
    const result = await runChairChatTurn(run, input, { complete: async () => answer({ newEvidence: true, provisionalChange: "I would provisionally strengthen the adoption case if the contracts are verified.", provisionalReason: "Prepayment would address the Customer's stated payment gap." }) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reply.summary).toContain("The stored verdict and scores remain unchanged.");
    expect(JSON.stringify(run)).toBe(before);
  });

  it("returns honest provider failures without changing a completed run", async () => {
    const run = completedRun();
    const before = structuredClone(run);
    for (const client of [null, { complete: async () => { throw Object.assign(new Error("Timed out"), { code: "timeout" }); } }, { complete: async () => "not JSON" }]) {
      expect((await runChairChatTurn(run, { question: "Why pivot?" }, client)).ok).toBe(false);
      expect(run).toEqual(before);
    }
  });
});

describe("verdict chat API isolation", () => {
  it("keeps repeated exchanges in chat history while leaving the original stored debate intact", async () => {
    const run = completedRun();
    storeRun(run);
    const before = structuredClone(run);
    vi.stubEnv("OPENAI_API_KEY", "test-only-key");
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, options: RequestInit) => {
      seen.push(String(options.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: answer() } }] }), { status: 200 });
    });
    const first = await call(run, { question: "Explain the payment concern." });
    const second = await call(run, { question: "Which assumption mattered?" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.run).toBeUndefined();
    expect(seen[1]).toContain("Explain the payment concern.");
    expect(run).toEqual(before);
    const duplicateVerdictReq = Object.assign(Readable.from([JSON.stringify({ runId: run.id })]), { url: "/api/debate/verdict" });
    let output = "";
    const res = { statusCode: 200, setHeader() {}, end(value: string) { output = value; } };
    await handleDebateApi(duplicateVerdictReq as never, res as never);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(output).run).toEqual(before);
  });

  it("validates requests and retains retryability after configuration and output failures", async () => {
    const run = completedRun();
    storeRun(run);
    const before = structuredClone(run);
    vi.stubEnv("OPENAI_API_KEY", "");
    expect((await call(run, { question: "Why pivot?" })).status).toBe(503);
    expect((await call(run, { question: "" })).status).toBe(400);
    expect((await call(run, { question: "Why pivot?" }, "GET")).status).toBe(405);
    vi.stubEnv("OPENAI_API_KEY", "test-only-key");
    const provider = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "not JSON" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", provider);
    expect((await call(run, { question: "Why pivot?" })).status).toBe(502);
    provider.mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: answer() } }] }), { status: 200 }));
    expect((await call(run, { question: "Why pivot?" })).status).toBe(200);
    expect(run).toEqual(before);
  });

  it("rejects concurrent chats without locking or changing the debate", async () => {
    const run = completedRun();
    storeRun(run);
    const before = structuredClone(run);
    vi.stubEnv("OPENAI_API_KEY", "test-only-key");
    let release!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", async () => {
      began(); await pending;
      return new Response(JSON.stringify({ choices: [{ message: { content: answer() } }] }), { status: 200 });
    });
    const first = call(run, { question: "First question" });
    await started;
    const second = await call(run, { question: "Second question" });
    expect(second.status).toBe(409);
    expect(run).toEqual(before);
    release();
    expect((await first).status).toBe(200);
    expect((await call(run, { question: "Third question" })).status).toBe(200);
  });
});
