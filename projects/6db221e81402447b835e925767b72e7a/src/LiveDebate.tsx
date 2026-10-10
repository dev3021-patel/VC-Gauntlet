import { useEffect, useRef, useState } from "react";
import { emptyBrief, validateBrief, type BriefFieldError, type IdeaBrief } from "./brief";
import { isSpecialist, ROLE_SLOTS, CONTRIBUTION_STAGES, GROUNDINGS } from "./contract";
import type { DebateRun } from "./debate";
import { ChairConversation } from "./ChairConversation";
import { AssessmentReport } from "./AssessmentReport";
import "./live-debate.css";

const fields: Array<{ key: keyof IdeaBrief; label: string; long?: boolean }> = [
  { key: "idea", label: "Startup idea" }, { key: "problem", label: "Problem", long: true },
  { key: "targetCustomer", label: "Target customer" }, { key: "solution", label: "Proposed solution", long: true },
  { key: "businessModel", label: "Business model" }, { key: "traction", label: "Traction (optional)" },
  { key: "founderEvidence", label: "Founder evidence (optional)", long: true },
];
const phases = { assessments: "Opening assessments", challenge: "Red Team challenge", rebuttals: "Specialist rebuttals", founder: "Founder discussion", verdict: "Committee verdict", complete: "Completed debate" };
const labelFor = (speaker: string) => ROLE_SLOTS.find((role) => role.id === speaker)?.label ?? "Founder";
const fieldLabel = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());

function validRun(value: unknown, expectedId?: string): value is DebateRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<DebateRun>;
  const strings = (values: unknown): values is string[] => Array.isArray(values) && values.every((value) => typeof value === "string");
  const messagesValid = Array.isArray(run.messages) && run.messages.every((message) => {
    if (!message || typeof message.id !== "string" || typeof message.body !== "string" ||
        ![...ROLE_SLOTS.map((role) => role.id), "founder"].includes(message.speaker) ||
        ![...CONTRIBUTION_STAGES, "founder"].includes(message.stage)) return false;
    const envelope = message.envelope;
    if (!envelope) return true;
    return typeof envelope.summary === "string" && typeof envelope.rationale === "string" && typeof envelope.positionLabel === "string" &&
      !!envelope.fields && typeof envelope.fields === "object" && !Array.isArray(envelope.fields) &&
      strings(envelope.risks) && Array.isArray(envelope.assumptions) && envelope.assumptions.every((claim) =>
        claim && typeof claim.statement === "string" && GROUNDINGS.includes(claim.grounding)) &&
      (!envelope.decision || (strings(envelope.decision.nextSteps) && strings(envelope.decision.unresolvedRisks)));
  });
  return typeof run.id === "string" && (!expectedId || run.id === expectedId) && messagesValid &&
    typeof run.phase === "string" && run.phase in phases && !!run.brief &&
    (!run.failure || typeof run.failure.message === "string");
}

export function LiveDebate() {
  const [draft, setDraft] = useState<IdeaBrief>(emptyBrief());
  const [errors, setErrors] = useState<BriefFieldError[]>([]);
  const [run, setRun] = useState<DebateRun | null>(null);
  const [notice, setNotice] = useState("Checking AI availability…");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/provider-status", { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error();
      const status = await response.json() as { message?: unknown };
      if (!controller.signal.aborted) setNotice(typeof status.message === "string" ? status.message : "AI availability is unknown.");
    }).catch(() => { if (!controller.signal.aborted) setNotice("AI availability could not be checked. You can retry a debate step."); });
    return () => { controller.abort(); active.current?.abort(); active.current = null; };
  }, []);

  async function call(path: string, payload: { runId?: string; brief?: IdeaBrief; founderMessage?: string }): Promise<boolean> {
    if (active.current) return false;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal });
      const result = await response.json() as { run?: unknown; error?: unknown; fields?: BriefFieldError[] };
      if (active.current !== controller || controller.signal.aborted) return false;
      if (!result || typeof result !== "object" || (result.run && !validRun(result.run, payload.runId))) throw new Error();
      if (validRun(result.run, payload.runId)) setRun(result.run);
      if (!response.ok) {
        if (Array.isArray(result.fields)) setErrors(result.fields.filter((error) => fields.some((field) => field.key === error.field) && typeof error.message === "string"));
        setNotice(typeof result.error === "string" ? result.error : "This step failed. Your draft is saved; try again.");
        return false;
      }
      if (!validRun(result.run, payload.runId)) throw new Error();
      setNotice("Live debate updated. Every recorded contribution came from the configured AI provider.");
      return true;
    } catch {
      if (active.current === controller && !controller.signal.aborted) setNotice("The request failed. Your draft is saved; retry this step.");
      return false;
    } finally {
      if (active.current === controller) { active.current = null; setBusy(false); }
    }
  }

  function reset() {
    active.current?.abort(); active.current = null;
    setBusy(false); setRun(null); setDraft(emptyBrief()); setErrors([]); setQuestion("");
    setNotice("Start a fresh live debate. Earlier contributions are kept separate.");
  }

  return <main className="live-debate shell">
    <header><p className="eyebrow">Live AI investment committee</p><h1>Test your startup idea.</h1><p className="lede">Independent openings, a Red Team challenge, specialist rebuttals, and a verdict you can question.</p></header>
    <section className="status" aria-live="polite"><h2>AI availability</h2><p>{notice}</p></section>
    {!run ? <form ref={form} className="brief" noValidate onSubmit={(event) => {
      event.preventDefault(); const validated = validateBrief(draft);
      if (!validated.ok) { setErrors(validated.errors); form.current?.querySelector<HTMLElement>(`[name="${validated.errors[0].field}"]`)?.focus(); return; }
      setErrors([]); void call("/api/debate/start", { brief: validated.value });
    }}><h2>Start a live debate</h2><p>Give each required detail at least eight characters so the committee has enough context.</p>
      {fields.map((field) => {
        const error = errors.find((item) => item.field === field.key);
        const props = { id: `brief-${field.key}`, name: field.key, value: draft[field.key], disabled: busy, "aria-invalid": !!error, "aria-describedby": error ? `error-${field.key}` : undefined,
          onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setDraft({ ...draft, [field.key]: event.target.value }); setErrors((items) => items.filter((item) => item.field !== field.key)); } };
        return <div className="brief-field" key={field.key}><label htmlFor={props.id}>{field.label}</label>{field.long ? <textarea {...props} /> : <input {...props} />}{error ? <p id={`error-${field.key}`} className="field-error">{error.message}</p> : null}</div>;
      })}
      <button disabled={busy}>{busy ? "Starting…" : "Start live debate"}</button>
    </form> : <section className="debate" aria-busy={busy}>
      <div className="debate-head"><div><p className="eyebrow">Current stage</p><h2>{phases[run.phase]}</h2></div><button className="secondary" onClick={reset}>New idea</button></div>
      {run.failure ? <p className="failure" role="alert">{run.failure.message} Retry the failed contribution to continue.</p> : null}
      <ol className="transcript">{run.messages.map((message) => <li key={message.id}>
        <strong>{labelFor(message.speaker)}</strong><span className="message-stage">{message.stage.replace(/_/g, " ")}</span>
        <p className="message-body">{typeof message.envelope?.fields.presentation === "string" ? message.envelope.fields.presentation : message.body}</p>
        {message.envelope ? <AssessmentReport envelope={message.envelope} /> : null}
        {message.envelope && message.envelope.changed !== null ? <p className="trail">Position changed: {message.envelope.changed ? "yes" : "no"}{message.envelope.changeReason ? ` — ${message.envelope.changeReason}` : ""}</p> : null}
        {message.envelope && isSpecialist(message.envelope.role) && Object.keys(message.envelope.fields).length ? <details className="scorecard-details"><summary>Scorecard details</summary><dl>{Object.entries(message.envelope.fields).map(([key, value]) => <div key={key}><dt>{fieldLabel(key)}</dt><dd>{Array.isArray(value) ? value.join(" · ") : String(value)}</dd></div>)}</dl></details> : null}
        {message.envelope?.decision ? <div className="decision"><p>Chair verdict: <strong>{String(message.envelope.fields.displayVerdict ?? message.envelope.decision.verdict)}</strong></p><p>Next steps: {message.envelope.decision.nextSteps.join(" · ")}</p><p>Unresolved risks: {message.envelope.decision.unresolvedRisks.join(" · ")}</p></div> : null}
        {message.envelope && !(isSpecialist(message.envelope.role) && message.stage === "assessment") ? message.envelope.assumptions.map((claim, i) => <small key={i}>{claim.grounding.replace(/_/g, " ")}: {claim.statement}</small>) : null}
      </li>)}</ol>
      {run.failure ? <button disabled={busy} onClick={async () => { if (await call("/api/debate/advance", { runId: run.id }) && run.phase === "founder") setQuestion(""); }}>{busy ? "Retrying…" : `Retry ${labelFor(run.failure.role ?? "customer")} contribution`}</button> : null}
      {run.phase === "founder" && !run.failure ? <div className="founder"><h2>Founder discussion</h2><label htmlFor="founder-question">Question or evidence</label><textarea id="founder-question" disabled={busy} value={question} onChange={(event) => setQuestion(event.target.value)} /><div className="actions"><button disabled={busy || !question.trim()} onClick={async () => { if (await call("/api/debate/founder", { runId: run.id, founderMessage: question })) setQuestion(""); }}>Add to discussion</button><button className="secondary" disabled={busy} onClick={() => void call("/api/debate/verdict", { runId: run.id })}>Request verdict</button></div></div> : null}
      {run.phase !== "founder" && run.phase !== "complete" && !run.failure ? <button disabled={busy} onClick={() => void call("/api/debate/advance", { runId: run.id })}>{busy ? "Generating…" : run.phase === "verdict" ? "Generate Chair verdict" : "Generate next contribution"}</button> : null}
      {run.phase === "complete" ? <ChairConversation key={run.id} runId={run.id} /> : null}
    </section>}
  </main>;
}
