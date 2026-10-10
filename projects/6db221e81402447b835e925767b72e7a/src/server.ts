import type { IncomingMessage, ServerResponse } from "node:http";
import { validateBrief } from "./brief";
import { SPECIALIST_ROLES, createRoleRegistry, type RoleId } from "./contract";
import { beginTurn, completeTurn, createRun, requestVerdict, type DebateRun } from "./debate";
import { generateContribution, readProviderConfig, createOpenAiClient } from "./provider";
import { ROLE_INSTRUCTIONS } from "./roles";

const runs = new Map<string, DebateRun>();
const registry = createRoleRegistry(ROLE_INSTRUCTIONS);

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const part of req) text += part;
  return text ? JSON.parse(text) : {};
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

export async function handleDebateApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!req.url?.startsWith("/api/debate/")) return false;
  try {
    const input = await body(req) as { brief?: unknown; runId?: string; founderMessage?: string; verdict?: boolean };
    if (req.url.startsWith("/api/debate/start")) {
      const brief = validateBrief(input.brief ?? {});
      if (!brief.ok) return send(res, 400, { error: "Invalid idea brief", fields: brief.errors }), true;
      const run = createRun(brief.value); runs.set(run.id, run); return send(res, 200, { run }), true;
    }
    const run = input.runId ? runs.get(input.runId) : undefined;
    if (!run) return send(res, 404, { error: "Debate run not found" }), true;
    if (req.url.startsWith("/api/debate/founder")) {
      const message = input.founderMessage?.trim();
      if (!message || run.phase !== "founder") return send(res, 400, { error: "Founder discussion is not available yet" }), true;
      run.messages.push({ id: crypto.randomUUID(), speaker: "founder", stage: "founder", body: message, createdAt: new Date().toISOString() });
      const started = beginTurn(run, "customer");
      const config = readProviderConfig();
      if (!started.ok) { runs.set(run.id, run); return send(res, 503, { error: started.error.message, run }), true; }
      if (!config.ok) { runs.set(run.id, run); return send(res, 503, { error: config.error.message, run }), true; }
      const generated = await generateContribution(started.value, "customer", "founder_response", registry, createOpenAiClient(config.value));
      if (!generated.ok) { runs.set(run.id, run); return send(res, 502, { error: generated.error.message, run }), true; }
      const completed = completeTurn(started.value, generated.raw); runs.set(run.id, completed.value);
      return send(res, completed.ok ? 200 : 502, completed.ok ? { run: completed.value } : { error: completed.error.message, run: completed.value }), true;
    }
    if (req.url.startsWith("/api/debate/verdict")) {
      const requested = requestVerdict(run); if (!requested.ok) return send(res, 409, { error: requested.error.message, run: requested.value }), true;
      runs.set(run.id, requested.value);
    }
    const current = runs.get(run.id)!;
    const role = nextRole(current);
    if (!role) return send(res, 409, { error: "Ask a founder question or request the verdict.", run: current }), true;
    const started = beginTurn(current, role); if (!started.ok) return send(res, 409, { error: started.error.message, run: started.value }), true;
    const config = readProviderConfig(); if (!config.ok) return send(res, 503, { error: config.error.message, run: current }), true;
    const generated = await generateContribution(started.value, role, started.value.lock!.stage, registry, createOpenAiClient(config.value));
    if (!generated.ok) return send(res, 502, { error: generated.error.message, run: current }), true;
    const completed = completeTurn(started.value, generated.raw); runs.set(run.id, completed.value);
    return send(res, completed.ok ? 200 : 502, completed.ok ? { run: completed.value } : { error: completed.error.message, run: completed.value }), true;
  } catch { return send(res, 400, { error: "Invalid debate request" }), true; }
}
