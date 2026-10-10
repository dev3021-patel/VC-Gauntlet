import { useEffect, useState } from "react";
import { emptyBrief, type IdeaBrief } from "./brief";
import type { DebateRun } from "./debate";

const fields: Array<{ key: keyof IdeaBrief; label: string; long?: boolean }> = [
  { key: "idea", label: "Startup idea" }, { key: "problem", label: "Problem", long: true },
  { key: "targetCustomer", label: "Target customer" }, { key: "solution", label: "Proposed solution", long: true },
  { key: "businessModel", label: "Business model" }, { key: "traction", label: "Traction (optional)" },
  { key: "founderEvidence", label: "Founder evidence (optional)", long: true },
];

async function request(path: string, payload: unknown) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  return await response.json() as { run?: DebateRun; error?: string };
}

export function App() {
  const [draft, setDraft] = useState<IdeaBrief>(emptyBrief());
  const [run, setRun] = useState<DebateRun | null>(null);
  const [notice, setNotice] = useState("Checking provider configuration…");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { fetch("/api/provider-status").then((r) => r.json()).then((s) => setNotice(s.message)).catch(() => setNotice("Provider status unavailable.")); }, []);
  async function call(path: string, payload: object) {
    setBusy(true);
    try { const result = await request(path, payload); if (result.run) setRun(result.run); if (result.error) setNotice(result.error); }
    catch { setNotice("The request failed. You can retry this stage."); }
    finally { setBusy(false); }
  }
  return <main className="shell"><header className="masthead"><p className="eyebrow">AI investment committee</p><h1>Venture Gauntlet</h1><p className="lede">Independent specialist assessments, a named Red Team challenge, and a decision trail you can interrogate.</p></header>
    <section className="status" aria-live="polite"><h2>Provider status</h2><p>{notice}</p></section>
    {!run ? <form className="brief" onSubmit={(e) => { e.preventDefault(); void call("/api/debate/start", { brief: draft }); }}><h2>Start a debate</h2>{fields.map((field) => <label key={field.key}>{field.label}{field.long ? <textarea value={draft[field.key]} onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })} /> : <input value={draft[field.key]} onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })} />}</label>)}<button disabled={busy}>Accept brief</button></form> : <section className="debate"><div className="debate-head"><div><p className="eyebrow">Stage</p><h2>{run.phase}</h2></div><button className="secondary" onClick={() => { setRun(null); setDraft(emptyBrief()); }}>New idea</button></div>
      {run.failure ? <p className="failure" role="alert">{run.failure.message} Retry the current stage when the provider is available.</p> : null}
      <ol className="transcript">{run.messages.map((message) => <li key={message.id}><strong>{message.speaker.replace("_", " ")}</strong><span>{message.stage.replace("_", " ")}</span><p>{message.body}</p>
        {message.envelope?.changed !== null ? <p className="trail">Position changed: {message.envelope?.changed ? "yes" : "no"}{message.envelope?.changeReason ? ` — ${message.envelope.changeReason}` : ""}</p> : null}
        {message.envelope?.fields.targetedRoles ? <p className="trail">Challenges: {(message.envelope.fields.targetedRoles as string[]).join(", ")}</p> : null}
        {message.envelope?.fields.questions ? <p className="trail">Questions: {(message.envelope.fields.questions as string[]).join(" · ")}</p> : null}
        {message.envelope?.decision ? <div className="decision"><p>Chair verdict: <strong>{message.envelope.decision.verdict}</strong></p><p>Next steps: {message.envelope.decision.nextSteps.join(" · ")}</p><p>Unresolved risks: {message.envelope.decision.unresolvedRisks.join(" · ")}</p></div> : null}
        {message.envelope?.assumptions?.map((claim, i) => <small key={i}>{claim.grounding}: {claim.statement}</small>)}</li>)}</ol>
      {run.phase === "founder" ? <div className="founder"><label>Question or evidence<textarea value={question} onChange={(e) => setQuestion(e.target.value)} /></label><button disabled={busy || !question.trim()} onClick={() => { void call("/api/debate/founder", { runId: run.id, founderMessage: question }); setQuestion(""); }}>Add to discussion</button><button disabled={busy} onClick={() => void call("/api/debate/verdict", { runId: run.id })}>Request verdict</button></div> : null}
      {run.phase !== "founder" && run.phase !== "complete" ? <button disabled={busy} onClick={() => void call("/api/debate/advance", { runId: run.id })}>{busy ? "Generating…" : run.phase === "verdict" ? "Generate Chair verdict" : "Generate next contribution"}</button> : null}
    </section>}</main>;
}
