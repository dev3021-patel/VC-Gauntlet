import { describe, expect, it } from "vitest";
import { validateBrief } from "./brief";
import { createRoleRegistry } from "./contract";
import { createRun } from "./debate";
import {
  buildGenerationPrompt,
  createOpenAiClient,
  generateContribution,
  providerStatus,
  readProviderConfig,
  sharedRegistry,
  VC_ROLE_INSTRUCTIONS,
} from "./provider";

function run() {
  const brief = validateBrief({
    idea: "Clinic intake copilot",
    problem: "Front desks lose hours to phone tag.",
    targetCustomer: "Independent clinic managers",
    solution: "An assistant that books from inbound calls.",
    businessModel: "Per-location monthly subscription",
  });
  if (!brief.ok) throw new Error("fixture");
  return createRun(brief.value);
}

describe("provider access", () => {
  it("reports missing credentials without inventing a debate", async () => {
    const status = providerStatus({});
    expect(status.configured).toBe(false);
    expect(status.message).toContain("Sample debates are not used");
    expect(readProviderConfig({}).ok).toBe(false);
    const generated = await generateContribution(
      run(),
      "vc",
      "assessment",
      createRoleRegistry({ vc: "Be strict about distribution." }),
      null,
    );
    expect(generated.ok).toBe(false);
    if (generated.ok) return;
    expect(generated.error.code).toBe("missing_credentials");
  });

  it("registers VC instructions and does not turn a provider failure into a sample card", async () => {
    const instructions = sharedRegistry.instructions("vc");
    expect(instructions).toBe(VC_ROLE_INSTRUCTIONS);
    expect(instructions).toContain("marketSizeConcern");
    expect(instructions).toContain("defensibilityConcern");
    expect(instructions).toContain("rebuttal");
    expect(instructions).toContain("founder reply");
    const prompt = buildGenerationPrompt(run(), "vc", "assessment", sharedRegistry);
    expect(prompt.ok).toBe(true);
    if (!prompt.ok) return;
    expect(prompt.user).toContain("Clinic intake copilot");
    expect(prompt.system).not.toContain("Sample debate");
    const failed = await generateContribution(run(), "vc", "assessment", sharedRegistry, {
      complete: async () => {
        throw Object.assign(new Error("The AI provider returned an error."), {
          code: "provider_failure",
        });
      },
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error.code).toBe("provider_failure");
    expect(JSON.stringify(failed)).not.toContain("INVEST");
  });

  it("refuses an unregistered role instead of substituting sample text", () => {
    const prompt = buildGenerationPrompt(run(), "customer", "assessment", createRoleRegistry());
    expect(prompt.ok).toBe(false);
    if (prompt.ok) return;
    expect(prompt.error.code).toBe("role_not_configured");
  });

  it("sends the brief to the provider and does not echo the key", async () => {
    const seen: { authorization?: string; body?: string } = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      const headers = new Headers(init?.headers);
      seen.authorization = headers.get("authorization") ?? undefined;
      seen.body = String(init?.body);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "{\"summary\":\"ok\"}" } }] }),
        { status: 200 },
      );
    };
    const client = createOpenAiClient(
      { apiKey: "secret-key", baseUrl: "https://example.test/v1", model: "test-model" },
      fetchImpl,
    );
    const registry = createRoleRegistry({ engineer: "Judge build complexity." });
    const prompt = buildGenerationPrompt(run(), "engineer", "assessment", registry);
    expect(prompt.ok).toBe(true);
    if (!prompt.ok) return;
    const raw = await client.complete(prompt);
    expect(raw).toContain("summary");
    expect(seen.body).toContain("Clinic intake copilot");
    expect(seen.authorization).toBe("Bearer secret-key");
    expect(seen.body).not.toContain("secret-key");
  });
});
