import { useEffect, useState } from "react";
import { emptyBrief, validateBrief, type BriefFieldError, type IdeaBrief } from "./brief";
import { ROLE_SLOTS } from "./contract";
import { createRun, type DebateRun } from "./debate";

interface ProviderStatus {
  configured: boolean;
  model: string;
  message: string;
}

const FIELDS: Array<{ key: keyof IdeaBrief; label: string; required: boolean; long?: boolean }> = [
  { key: "idea", label: "Startup idea", required: true },
  { key: "problem", label: "Problem", required: true, long: true },
  { key: "targetCustomer", label: "Target customer", required: true },
  { key: "solution", label: "Proposed solution", required: true, long: true },
  { key: "businessModel", label: "Business model", required: true },
  { key: "traction", label: "Traction", required: false },
  { key: "founderEvidence", label: "Founder evidence", required: false, long: true },
];

export function App() {
  const [draft, setDraft] = useState<IdeaBrief>(emptyBrief());
  const [errors, setErrors] = useState<BriefFieldError[]>([]);
  const [run, setRun] = useState<DebateRun | null>(null);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [statusError, setStatusError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/provider-status", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("status");
        setStatus((await response.json()) as ProviderStatus);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatusError("Provider status unavailable. No sample debate will be shown.");
      });
    return () => controller.abort();
  }, []);

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const result = validateBrief(draft);
    if (!result.ok) {
      setErrors(result.errors);
      setDraft(result.draft);
      setRun(null);
      return;
    }
    setErrors([]);
    setDraft(result.value);
    setRun(createRun(result.value));
  }

  function startFresh() {
    setDraft(emptyBrief());
    setErrors([]);
    setRun(null);
  }

  return (
    <main className="shell">
      <header className="masthead">
        <p className="eyebrow">Shared foundation</p>
        <h1>Venture Gauntlet</h1>
        <p className="lede">
          Submit an idea brief. Six committee roles will debate it in later sessions.
          This session defines the contract they must share. It does not invent their arguments.
        </p>
      </header>

      <section className="status" aria-live="polite">
        <h2>AI provider</h2>
        <p className={status?.configured ? "badge ready" : "badge waiting"}>
          {status ? (status.configured ? "Configured" : "Not configured") : "Checking"}
        </p>
        <p>{status?.message ?? statusError ?? "Checking whether a server-side provider key is set."}</p>
        {status ? <p className="meta">Model name: {status.model}. The key stays on the server.</p> : null}
      </section>

      <div className="layout">
        <form className="brief" onSubmit={onSubmit} noValidate>
          <h2>Idea brief</h2>
          {errors.length > 0 ? (
            <div className="errors" role="alert">
              <p>Complete the required fields. Your text is still here.</p>
              <ul>
                {errors.map((error) => (
                  <li key={error.field}>{error.message}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {FIELDS.map((field) => {
            const error = errors.find((item) => item.field === field.key);
            const id = `brief-${field.key}`;
            return (
              <label key={field.key} htmlFor={id}>
                <span>
                  {field.label}
                  {field.required ? " (required)" : " (optional)"}
                </span>
                {field.long ? (
                  <textarea
                    id={id}
                    name={field.key}
                    value={draft[field.key]}
                    aria-invalid={error ? true : undefined}
                    onChange={(event) =>
                      setDraft({ ...draft, [field.key]: event.target.value })
                    }
                  />
                ) : (
                  <input
                    id={id}
                    name={field.key}
                    value={draft[field.key]}
                    aria-invalid={error ? true : undefined}
                    onChange={(event) =>
                      setDraft({ ...draft, [field.key]: event.target.value })
                    }
                  />
                )}
              </label>
            );
          })}
          <div className="actions">
            <button type="submit">Accept brief</button>
            <button type="button" className="secondary" onClick={startFresh}>
              Start fresh
            </button>
          </div>
        </form>

        <aside className="contract">
          <h2>Committee contract</h2>
          <ol>
            {ROLE_SLOTS.map((slot) => (
              <li key={slot.id}>
                <strong>{slot.label}</strong>
                <span>{slot.mandate}</span>
              </li>
            ))}
          </ol>
          <p className="meta">
            VC scores use Invest, Maybe, or Pass, plus market size, distribution, and
            defensibility. Only the Chair returns Invest, Pivot, or Pass. Maybe is never
            rewritten as Pivot.
          </p>
          {run ? (
            <div className="receipt">
              <h3>Brief accepted</h3>
              <p>
                Run {run.id.slice(0, 8)} is in the {run.phase} stage. VC instructions are
                registered. Other roles are not, so no debate has been generated.
              </p>
              <dl>
                <div>
                  <dt>Idea</dt>
                  <dd>{run.brief.idea}</dd>
                </div>
                <div>
                  <dt>Customer</dt>
                  <dd>{run.brief.targetCustomer}</dd>
                </div>
              </dl>
            </div>
          ) : (
            <p className="meta">A valid brief starts a fresh run. It does not carry a previous idea.</p>
          )}
        </aside>
      </div>
    </main>
  );
}
