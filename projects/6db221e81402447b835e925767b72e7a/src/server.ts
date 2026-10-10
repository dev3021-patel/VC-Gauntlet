import type { IncomingMessage, ServerResponse } from "node:http";
import { validateBrief } from "./brief";
import { SPECIALIST_ROLES, createRoleRegistry, type RoleId } from "./contract";
import { addFounderInput, beginTurn, completeTurn, createRun, failTurn, requestVerdict, retryTurn, type DebateResult, type DebateRun } from "./debate";
import { generateContribution, providerStatus, readProviderConfig, createOpenAiClient, type ModelClient } from "./provider";
import { generateRedTeamReview, redTeamRequestFromRun } from "./redTeam";
import { ROLE_INSTRUCTIONS } from "./roles";
import { registerVcAgent, runVcTurn } from "./vc";
import { registerCompetitorAgent, runCompetitorTurn } from "./competitor";
import { registerChair, runChairTurn } from "./chair";
import { chairChatContextGap, runChairChatTurn, type ChairChatExchange } from "./verdictChat";

const runs = new Map<string, DebateRun>();
const chairChats = new Map<string, ChairChatExchange[]>();
const activeChairChats = new Set<string>();
const registry = createRoleRegistry(ROLE_INSTRUCTIONS);
registerVcAgent(registry);
registerCompetitorAgent(registry);
registerChair(registry);

export function storeRun(run: DebateRun) { runs.set(run.id, run); }

function send(res: ServerResponse, status: number, payload: unknown): true {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
  return true;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const part of req) {
    text += part;
    if (Buffer.byteLength(text) > 1_048_576) throw new Error("Request too large");
  }
  const value: unknown = text ? JSON.parse(text) : {};
  if (!record(value)) throw new Error("Invalid object");
  return value;
}

function nextRole(run: DebateRun): RoleId | null {
  if (run.phase === "assessments" || run.phase === "rebuttals") {
    const stage = run.phase === "assessments" ? "assessment" : "rebuttal";
    return SPECIALIST_ROLES.find((role) => !run.messages.some((m) => m.speaker === role && m.stage === stage)) ?? null;
  }
  if (run.phase === "challenge") return "red_team";
  if (run.phase === "verdict") return "chair";
  return null;
}

async function generateTurn(current: DebateRun, locked: DebateRun, role: RoleId, client: ModelClient): Promise<DebateResult> {
  // Adapters own their validation and turn completion. The API publishes the lock
  // before awaiting them, while giving each adapter the unlocked input snapshot.
  if (role === "vc") return runVcTurn(current, client, registry);
  if (role === "competitor") return runCompetitorTurn(current, client, registry);
  if (role === "chair") return runChairTurn(current, client, registry);
  const generated = role === "red_team"
    ? await generateRedTeamReview(redTeamRequestFromRun(locked), client, registry)
    : await generateContribution(locked, role, locked.lock!.stage, registry, client);
  if (!generated.ok) {
    return { ok: false, error: generated.error, value: failTurn(locked, generated.error) };
  }
  return completeTurn(locked, generated.raw);
}

async function executeTurn(run: DebateRun, role: RoleId, res: ServerResponse): Promise<true> {
  const started = beginTurn(run, role);
  if (!started.ok) return send(res, 409, { error: started.error.message, run: started.value });
  storeRun(started.value);
  const config = readProviderConfig();
  if (!config.ok) {
    const failed = failTurn(started.value, config.error);
    storeRun(failed);
    return send(res, 503, { error: config.error.message, run: failed });
  }
  let result: DebateResult;
  try {
    result = await generateTurn(run, started.value, role, createOpenAiClient(config.value));
  } catch {
    const error = { code: "provider_failure" as const, message: "Generation failed. Retry this contribution." };
    result = { ok: false, error, value: failTurn(started.value, error) };
  }
  storeRun(result.value);
  return send(res, result.ok ? 200 : result.error.code === "incomplete_context" ? 409 : 502, result.ok ? { run: result.value } : { error: result.error.message, run: result.value });
}

export async function handleDebateApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = req.url?.split("?")[0];
  if (!path?.startsWith("/api/debate/")) return false;
  if (!["start", "advance", "founder", "verdict", "verdict-chat"].some((route) => path === `/api/debate/${route}`)) {
    return send(res, 404, { error: "Debate endpoint not found." });
  }
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return send(res, 405, { error: "Debate requests require POST." });
  }
  let input: Record<string, unknown>;
  try { input = await body(req); }
  catch { return send(res, 400, { error: "Enter a valid debate request." }); }
  if (path === "/api/debate/start") {
    const brief = validateBrief(record(input.brief) ? input.brief : {});
    if (!brief.ok) return send(res, 400, { error: "Complete the required idea details.", fields: brief.errors });
    const run = createRun(brief.value);
    storeRun(run);
    return send(res, 200, { run });
  }
  if (typeof input.runId !== "string" || !input.runId.trim()) return send(res, 400, { error: "A debate run ID is required." });
  const run = runs.get(input.runId);
  if (!run) return send(res, 404, { error: "Debate run not found." });

  if (path === "/api/debate/verdict-chat") {
    const gap = chairChatContextGap(run);
    if (gap) return send(res, 409, { error: gap });
    if (typeof input.question !== "string" || !input.question.trim() ||
        (input.newEvidence !== undefined && typeof input.newEvidence !== "string")) {
      return send(res, 400, { error: "Enter a question and optional new evidence for the Chair." });
    }
    if (activeChairChats.has(run.id)) return send(res, 409, { error: "Wait for the Chair's current answer." });
    const config = readProviderConfig();
    if (!config.ok) return send(res, 503, { error: config.error.message });
    const chatInput = { question: input.question.trim(), newEvidence: (input.newEvidence as string | undefined)?.trim() };
    activeChairChats.add(run.id);
    try {
      const history = chairChats.get(run.id) ?? [];
      const result = await runChairChatTurn(run, chatInput, createOpenAiClient(config.value), history);
      if (!result.ok) return send(res, 502, { error: result.error.message });
      chairChats.set(run.id, [...history, { input: chatInput, reply: result.reply }]);
      return send(res, 200, { reply: result.reply });
    } finally { activeChairChats.delete(run.id); }
  }

  if (path === "/api/debate/founder") {
    if (typeof input.founderMessage !== "string" || !input.founderMessage.trim()) {
      return send(res, 400, { error: "Enter a founder question or evidence.", run });
    }
    const added = addFounderInput(run, input.founderMessage);
    if (!added.ok) return send(res, 409, { error: added.error.message, run });
    return executeTurn(added.value, "customer", res);
  }

  let current = run;
  if (path === "/api/debate/verdict" && current.phase !== "verdict") {
    const requested = requestVerdict(current);
    if (!requested.ok) return send(res, 409, { error: requested.error.message, run: current });
    current = requested.value;
  }
  // Preserve the failed role before retryTurn clears the failure. In the founder
  // phase there is no ordinary nextRole, so the recorded failure identifies it.
  const role = current.failure?.role ?? nextRole(current);
  if (current.failure) {
    const retried = retryTurn(current);
    if (!retried.ok) return send(res, 409, { error: retried.error.message, run: current });
    current = retried.value;
  }
  if (!role) return send(res, 409, { error: "Ask a founder question or request the verdict.", run: current });
  return executeTurn(current, role, res);
}

/** Shared dev/production API boundary. */
export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.url?.split("?")[0] === "/api/provider-status") {
    if (req.method !== "GET") return send(res, 405, { error: "Provider status requires GET." });
    return send(res, 200, providerStatus());
  }
  return handleDebateApi(req, res);
}
