import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { handleDebateApi } from "./server";

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
});
