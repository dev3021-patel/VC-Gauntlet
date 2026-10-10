import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { handleDebateApi, storeRun } from "./server";
import type { DebateRun } from "./debate";

const savedKey = process.env.OPENAI_API_KEY;
afterEach(() => { process.env.OPENAI_API_KEY = savedKey; });

async function call(url: string, payload: unknown) {
  const req = Object.assign(Readable.from([JSON.stringify(payload)]), { url });
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end(value: string) { text = value; } };
  await handleDebateApi(req as never, res as never);
  return { status: res.statusCode, body: JSON.parse(text) as { run?: { failure?: { code: string }; lock?: unknown }; error?: string } };
}

describe("debate API recovery", () => {
  it("persists a retryable failure when provider configuration is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    const started = await call("/api/debate/start", { brief: { idea: "Clinic intake", problem: "Phone tag", targetCustomer: "Clinic managers", solution: "Booking assistant", businessModel: "Monthly subscription" } });
    const runId = started.body.run && (started.body.run as { id: string }).id;
    const failed = await call("/api/debate/advance", { runId });
    expect(failed.status).toBe(503);
    expect(failed.body.run?.failure?.code).toBe("missing_credentials");
    expect(failed.body.run?.lock).toBeNull();
  });

  it("uses the stored verdict-phase run for the first Chair generation", async () => {
    delete process.env.OPENAI_API_KEY;
    const id = "ready-for-verdict";
    const roles = ["vc", "customer", "competitor", "engineer"];
    const messages = [
      ...roles.map((speaker) => ({ id: `${speaker}-opening`, speaker, stage: "assessment", body: "opening", envelope: {} })),
      { id: "red-team", speaker: "red_team", stage: "challenge", body: "challenge", envelope: {} },
      ...roles.map((speaker) => ({ id: `${speaker}-rebuttal`, speaker, stage: "rebuttal", body: "rebuttal", envelope: {} })),
    ];
    storeRun({ id, brief: { idea: "Clinic intake", problem: "Phone tag", targetCustomer: "Clinic managers", solution: "Booking assistant", businessModel: "Monthly subscription", traction: "", founderEvidence: "" }, messages, phase: "founder", lock: null, failure: null, verdictRequested: false } as unknown as DebateRun);
    const failed = await call("/api/debate/verdict", { runId: id });
    expect(failed.status).toBe(503);
    expect((failed.body.run as { phase?: string }).phase).toBe("verdict");
    expect(failed.body.run?.failure?.code).toBe("missing_credentials");
  });
});
