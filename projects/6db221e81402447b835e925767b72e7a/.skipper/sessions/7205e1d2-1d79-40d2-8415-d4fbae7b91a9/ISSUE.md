# Issue #3: Integrate reliable Venture Gauntlet debate pipeline

**URL:** https://app.party.build/issues/3
**Reference slug:** Cross Reference Chats
**Status:** open  **Type:** bug
**Revision:** 27ee98fb-7408-49d6-8137-d29dbb8a3e42
**Annotation coordinates:** use `party issue view <n> --numbered`; this file's lines are not canonical.

# Problem

Venture Gauntlet cannot run a real six-role debate from the active branch. The shared debate foundation and the VC role were created on separate sibling branches, both based on the same parent, and neither is integrated here. The current foundation UI intentionally accepts a brief but has no registered roles or generation endpoint.

# Cause

- There is no unified project branch containing both the foundation and VC role.
- Provider utilities exist but are not exposed through a server-owned generation API.
- The browser UI does not execute debate stages, persist the debate state, or register role instructions.
- A live provider end-to-end run cannot be verified until a server-side provider credential is available.

# Proposed fix

1. Establish the foundation branch as the application baseline, then integrate the VC module through a small adapter to the shared role envelope.
2. Add a server-side debate API that owns provider configuration and performs typed role generation; never expose provider credentials to the browser.
3. Add the orchestration controller: idempotent stage/role requests, preserved successful messages, retry only the failed role, strict ordering, and Chair gating.
4. Register all six roles through the shared registry, preserving VC INVEST/MAYBE/PASS separately from the Chair Invest/Pivot/Pass verdict.
5. Update the UI to display the ordered transcript, claim grounding, named Red Team challenges, initial-versus-revised positions, founder questions, and validation next steps.
6. Add integration tests with a deterministic provider fake, plus a real provider smoke test when credentials are present.

# Definition of done

- A valid brief runs all required stages against registered provider-backed roles.
- Provider errors, timeouts, malformed responses, duplicate requests, and premature verdicts are recoverable and never manufacture content.
- The customer can see how the Red Team challenged specific claims and whether a specialist changed position.
- Existing project checks run npm ci, tests, and production build.

