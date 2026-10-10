import type { CompletionProvider, CompletionRequest } from "./contract.ts"
import { RoleRunError } from "./errors.ts"

const DEFAULT_BASE_URL = "https://api.openai.com/v1"
const DEFAULT_MODEL = "gpt-4o-mini"
const DEFAULT_TIMEOUT_MS = 30_000

export function createServerProvider(env: NodeJS.ProcessEnv = process.env): CompletionProvider {
  const apiKey = env.AI_API_KEY || env.OPENAI_API_KEY
  if (!apiKey) {
    throw new RoleRunError(
      "missing_credentials",
      "No server-side AI credential is configured. Set AI_API_KEY before running the VC Agent.",
    )
  }

  const baseUrl = (env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "")
  const model = env.AI_MODEL || DEFAULT_MODEL
  const timeoutMs = Number(env.AI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)

  return {
    async complete(request: CompletionRequest): Promise<string> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? timeoutMs)
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            temperature: 0.4,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user },
            ],
          }),
        })
        if (!response.ok) {
          throw new RoleRunError(
            "provider_failure",
            `The AI provider returned HTTP ${response.status}. Retry this VC turn.`,
          )
        }
        const body = (await response.json()) as {
          choices?: Array<{ message?: { content?: unknown } }>
        }
        const content = body.choices?.[0]?.message?.content
        if (typeof content !== "string" || content.trim() === "") {
          throw new RoleRunError("invalid_output", "The AI provider returned empty content. Retry this VC turn.")
        }
        return content
      } catch (error) {
        if (error instanceof RoleRunError) throw error
        if (error instanceof Error && error.name === "AbortError") {
          throw new RoleRunError("timeout", "The AI provider timed out. Retry this VC turn.")
        }
        throw new RoleRunError("provider_failure", "The AI provider failed. Retry this VC turn.")
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
