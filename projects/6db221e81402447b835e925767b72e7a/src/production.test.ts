import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createApplication } from "./production";

let server: ReturnType<typeof createApplication> | undefined;
let directory: string | undefined;
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); }
  if (directory) await rm(directory, { recursive: true, force: true });
  server = undefined; directory = undefined;
  vi.unstubAllEnvs();
});

it("serves built UI and the same real API locally without provider credentials or scripted fallback", async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  const output = process.env.PARTY_OUTPUT_DIR || join(process.cwd(), ".skipper");
  await mkdir(output, { recursive: true });
  directory = await mkdtemp(join(output, "runtime-test-"));
  const client = join(directory, "client");
  await mkdir(join(client, "assets"), { recursive: true });
  await writeFile(join(client, "index.html"), "<!doctype html><title>Runtime fixture</title>");
  await writeFile(join(client, "assets", "app.js"), "console.log('fixture');");
  await writeFile(join(directory, "private.json"), "should not be served");
  server = createApplication(client);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const page = await fetch(`${base}/?mode=live`);
  expect(page.status).toBe(200); expect(await page.text()).toContain("Runtime fixture");
  const js = await fetch(`${base}/assets/app.js`);
  expect(js.headers.get("content-type")).toContain("javascript");
  expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
  expect((await fetch(`${base}/%2e%2e%2fprivate.json`)).status).toBe(403);
  const status = await fetch(`${base}/api/provider-status`).then((response) => response.json());
  expect(status.configured).toBe(false); expect(JSON.stringify(status)).not.toContain("apiKey");
  const started = await fetch(`${base}/api/debate/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brief: { idea: "Clinic intake copilot", problem: "Phone tag wastes booked visits.", targetCustomer: "Independent clinic managers", solution: "An assistant books incoming calls.", businessModel: "Monthly subscription per clinic" } }) }).then((response) => response.json());
  const advance = await fetch(`${base}/api/debate/advance`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: started.run.id }) });
  expect(advance.status).toBe(503);
  const failed = await advance.json();
  expect(failed.run.messages).toEqual([]); expect(failed.run.lock).toBeNull(); expect(failed.run.failure.code).toBe("missing_credentials");
});
