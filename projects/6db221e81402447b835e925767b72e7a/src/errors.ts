import { VC_ROLE, type RoleErrorCode, type RoleFailure } from "./contract.ts"

export class RoleRunError extends Error {
  readonly code: RoleErrorCode

  constructor(code: RoleErrorCode, message: string) {
    super(message)
    this.name = "RoleRunError"
    this.code = code
  }
}

export function roleFailure(code: RoleErrorCode, message: string): RoleFailure {
  return {
    ok: false,
    role: VC_ROLE,
    recoverable: true,
    code,
    message,
  }
}

export function toRoleFailure(error: unknown): RoleFailure {
  if (error instanceof RoleRunError) {
    return roleFailure(error.code, error.message)
  }
  if (error instanceof Error && error.name === "AbortError") {
    return roleFailure("timeout", "The AI provider timed out. Retry this VC turn.")
  }
  return roleFailure("provider_failure", "The AI provider failed. Retry this VC turn.")
}
