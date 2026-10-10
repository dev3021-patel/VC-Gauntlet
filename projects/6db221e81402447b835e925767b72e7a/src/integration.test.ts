import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyBrief } from "./brief";
import { SPECIALIST_ROLES, createRoleRegistry, type RoleId } from "./contract";
import { beginTurn, completeTurn, createRun, type DebateRun } from "./debate";
import { handleDebateApi, storeRun } from "./server";
import { buildGenerationPrompt } from "./provider";
import { ROLE_INSTRUCTIONS } from "./roles";

const brief = { ...emptyBrief(), idea: "Clinic intake copilot", problem: "Phone tag wastes booked visits.", targetCustomer: "Independent clinic managers", solution: "An assistant books incoming calls.", businessModel: "Monthly subscription per clinic" };
function raw(role: RoleId, changed?: boolean, overrides: Record<string, unknown> = {}) {
  const fields = role === "vc" ? { score: 58, investmentPosition: "MAYBE", strongestInvestmentCase: "Frequent budgeted pain.", biggestFundabilityRisk: "The first channel may not repeat.", marketSizeConcern: "The reachable segment is unproven.", first100Users: "Start with clinic referrals.", defensibilityConcern: "Incumbents can copy the workflow.", killShotQuestion: "Who renews after the pilot?", oneLineVerdict: "Real pain, unproven scale.", challengeReference: "Payment intent remains unknown" }
    : role === "competitor" ? { threatScore: 2, stance: "COPYABLE_FEATURE", incumbent: "Scheduling incumbents", crushPlan: "Bundle the feature into the existing clinic suite.", weakMoat: "No proprietary clinic data.", copyabilityRisk: "The core feature is easy to recreate.", distributionDisadvantage: "The incumbent owns the buyer relationship.", dangerousMove: "Become the clinic's system of record.", founderQuestion: "What do you own after bundling?", verdict: "A feature that I can bundle.", challengeReference: "Payment intent remains unknown" }
    : role === "customer" ? { adoptionScore: 5, supportingDetail: "Unique buyer detail that the summary omits." }
    : role === "engineer" ? { feasibilityScore: 7, dependencies: ["Booking integration", "Human fallback"] }
    : { targetedRoles: [...SPECIALIST_ROLES], questions: ["Payment intent remains unknown"] };
  return JSON.stringify({ summary: role === "red_team" ? "Payment intent remains unknown." : `Unique opening ${role} argument.`, rationale: "- Switching value is not yet demonstrated.\n- The score reflects untested demand.", assumptions: [{ statement: "Scheduling incumbents represent the competition.", grounding: "assumption" }], risks: ["The first channel may not repeat."], positionLabel: role === "vc" ? "MAYBE" : role === "competitor" ? "COPYABLE_FEATURE" : role === "red_team" ? "challenge" : "skeptical", fields, changed, changeReason: changed === undefined ? undefined : "The payment challenge has been considered.", ...overrides });
}
function fill(run: DebateRun, role: RoleId, changed?: boolean): DebateRun {
  const started = beginTurn(run, role);
  if (!started.ok) throw new Error(started.error.message);
  const done = completeTurn(started.value, raw(role, changed));
  if (!done.ok) throw new Error(done.error.message);
  return done.value;
}
function founderRun() {
  let run = createRun(brief);
  for (const role of SPECIALIST_ROLES) run = fill(run, role);
  run = fill(run, "red_team");
  for (const role of SPECIALIST_ROLES) run = fill(run, role, false);
  storeRun(run);
  return run;
}
async function call(path: string, payload: unknown, method = "POST") {
  const req = Object.assign(Readable.from([JSON.stringify(payload)]), { url: `/api/debate/${path}`, method });
  let output = "";
  const res = { statusCode: 200, setHeader() {}, end(value: string) { output = value; } };
  await handleDebateApi(req as never, res as never);
  return { status: res.statusCode, body: JSON.parse(output) as { run?: DebateRun; error?: string } };
}
const response = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function configure() { vi.stubEnv("OPENAI_API_KEY", "test-key"); vi.stubEnv("OPENAI_BASE_URL", "https://provider.invalid/v1"); }

describe("integrated debate regressions", () => {
  it("keeps all four API-generated openings independent and uses the registered personas", async () => {
    configure();
    const prompts: Array<{ system: string; user: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { messages } = JSON.parse(String(init.body));
      prompts.push({ system: messages[0].content, user: messages[1].content });
      const role = messages[1].content.match(/Role: (\w+)/)[1] as RoleId;
      return response(raw(role));
    }));
    const initial = await call("start", { brief });
    let run = initial.body.run!;
    for (const role of SPECIALIST_ROLES) {
      const next = await call("advance", { runId: run.id });
      expect(next.status, next.body.error).toBe(200);
      run = next.body.run!;
      expect(run.messages.at(-1)?.speaker).toBe(role);
    }
    expect(run.phase).toBe("challenge");
    expect(prompts).toHaveLength(4);
    for (const prompt of prompts) {
      expect(prompt.user).toContain(brief.idea);
      expect(prompt.user).toContain("DISCUSSION SO FAR\n(none)");
      expect(prompt.user).not.toContain("Unique opening");
    }
    expect(prompts[0].system).toContain("a sharp partner");
    expect(prompts[2].system).toContain("strongest incumbent");
    expect(run.messages[2].body).toContain("COMPETITOR THREAT SCORE");
  });

  it("rejects an inconsistent VC rebuttal through the API and retries without overwriting openings", async () => {
    configure();
    const complete = founderRun();
    const run = { ...complete, phase: "rebuttals" as const, messages: complete.messages.filter((m) => m.stage !== "rebuttal") };
    storeRun(run);
    const fields = { ...JSON.parse(raw("vc")).fields, score: 59 };
    vi.stubGlobal("fetch", vi.fn(async () => response(raw("vc", false, { fields }))));
    const failed = await call("advance", { runId: run.id });
    expect(failed.status).toBe(502);
    expect(failed.body.run?.failure?.code).toBe("invalid_response");
    expect(failed.body.run?.messages).toEqual(run.messages);
    vi.stubGlobal("fetch", vi.fn(async () => response(raw("vc", true, { fields }))));
    const retried = await call("advance", { runId: run.id });
    expect(retried.status).toBe(200);
    expect(retried.body.run?.messages.slice(0, run.messages.length)).toEqual(run.messages);
    expect(retried.body.run?.messages.at(-1)?.envelope?.vc?.score).toBe(59);
  });

  it("enforces the Competitor's incumbent grounding through the actual API", async () => {
    configure();
    let run = createRun(brief);
    run = fill(fill(run, "vc"), "customer");
    storeRun(run);
    vi.stubGlobal("fetch", vi.fn(async () => response(raw("competitor", undefined, { assumptions: [{ statement: "Copying is an assumption.", grounding: "assumption" }] }))));
    const failed = await call("advance", { runId: run.id });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toContain("incumbent");
    expect(failed.body.run?.messages).toEqual(run.messages);
  });

  it("rejects an overlapping founder submission without changing the locked run", async () => {
    configure();
    const run = founderRun();
    let release!: (value: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => { entered(); return new Promise<Response>((resolve) => { release = resolve; }); }));
    const first = call("founder", { runId: run.id, founderMessage: "Accepted first founder question." });
    await started;
    const locked = (await call("advance", { runId: run.id })).body.run!;
    const rejected = await call("founder", { runId: run.id, founderMessage: "Rejected overlapping question." });
    expect(rejected.status).toBe(409);
    expect(rejected.body.run).toEqual(locked);
    release(response(raw("customer")));
    const completed = await first;
    expect(completed.status).toBe(200);
    expect(completed.body.run?.messages.filter((m) => m.stage === "founder").map((m) => m.body)).toEqual(["Accepted first founder question."]);
    expect(run.messages).toHaveLength(9);
  });

  it("retries the original accepted founder message once after failure", async () => {
    configure();
    const run = founderRun();
    const provider = vi.fn(async () => new Response("", { status: 503 }));
    vi.stubGlobal("fetch", provider);
    const failed = await call("founder", { runId: run.id, founderMessage: "Would clinics pay for saved time?" });
    expect(failed.status).toBe(502);
    const before = structuredClone(failed.body.run!);
    expect((await call("founder", { runId: run.id, founderMessage: "Skip the failed question." })).status).toBe(409);
    expect((await call("verdict", { runId: run.id })).status).toBe(409);
    expect(provider).toHaveBeenCalledTimes(1);
    provider.mockImplementation(async (_url?: unknown, _input?: unknown) => response(raw("customer")));
    const retry = await call("advance", { runId: run.id });
    expect(retry.status, retry.body.error).toBe(200);
    expect(retry.body.run?.messages.slice(0, before.messages.length)).toEqual(before.messages);
    expect(retry.body.run?.messages.filter((m) => m.stage === "founder")).toHaveLength(1);
    expect(retry.body.run?.messages.at(-1)?.stage).toBe("founder_response");
    expect(retry.body.run?.failure).toBeNull();
    expect((await call("advance", { runId: run.id })).status).toBe(409);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("carries source identity and complete structured role content into later turns", () => {
    const run = founderRun();
    const prompt = buildGenerationPrompt(run, "engineer", "founder_response", createRoleRegistry(ROLE_INSTRUCTIONS));
    if (!prompt.ok) throw new Error(prompt.error.message);
    for (const message of run.messages) {
      expect(prompt.user).toContain(message.id);
      expect(prompt.user).toContain(JSON.stringify(message.envelope));
    }
    expect(prompt.user).toContain("Unique buyer detail that the summary omits.");
    expect(prompt.user).toContain("Booking integration");
  });

  it("rejects unknown paths, wrong methods and malformed input without advancing", async () => {
    const run = founderRun();
    const before = structuredClone(run);
    expect((await call("advance-extra", { runId: run.id })).status).toBe(404);
    expect((await call("founder", { runId: run.id, founderMessage: "Wrong method." }, "GET")).status).toBe(405);
    expect((await call("founder", { runId: run.id, founderMessage: 123 })).status).toBe(400);
    expect((await call("start", null)).status).toBe(400);
    expect(run).toEqual(before);
  });
});
