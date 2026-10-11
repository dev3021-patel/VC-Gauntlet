import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { emptyBrief, validateBrief, type BriefFieldError, type IdeaBrief } from "./brief";
import {
  demoRun,
  ignoreStaleUpdate,
  toCommitteeView,
  type AgentView,
  type CommitteeView,
  type WhyView,
} from "./committee-view";
import type { DebateRun } from "./debate";
import { requiredStagesComplete } from "./debate";

type Mode = "live" | "demo";
type ApiBody = {
  error?: string;
  fields?: BriefFieldError[];
  run?: DebateRun;
};

const prompts = [
  "Is the market big enough?",
  "Will customers pay?",
  "Can incumbents copy this?",
  "Can this actually be built?",
];

function AgentMark({ agent }: { agent: { icon: string; label: string; color: string } }) {
  return <span className="agent-mark" style={{ "--agent": agent.color } as CSSProperties}><span aria-hidden="true">{agent.icon}</span>{agent.label}</span>;
}

function Stepper({ stages }: { stages: CommitteeView["stages"] }) {
  return <nav className="stepper" aria-label="Committee progress">{stages.map((stage) => <div className={`step ${stage.state}`} key={stage.label}><i aria-hidden="true" /><span>{stage.label}</span></div>)}</nav>;
}

function ScoreMove({ agent }: { agent: AgentView }) {
  if (agent.movement === "pending") return <span className="position-move">Revision pending</span>;
  if (agent.initialScore == null || agent.finalScore == null) {
    if (!agent.initialPosition && !agent.finalPosition) return <span className="position-move">Score unavailable</span>;
    return <span className="position-move">{agent.initialPosition ?? "—"} → {agent.finalPosition ?? agent.initialPosition ?? "—"}</span>;
  }
  const delta = agent.delta ?? 0;
  return <span className={`score-move ${delta === 0 ? "flat" : delta > 0 ? "up" : "down"}`}>{agent.initialScore} <b>→</b> {agent.finalScore} <em>{delta === 0 ? "—" : delta > 0 ? "↑" : "↓"}</em><small>/{agent.scale}</small></span>;
}

function ScoreBars({ agent }: { agent: AgentView }) {
  if (agent.initialScore == null || agent.finalScore == null) {
    return <div className="fallback-score">{agent.initialScore != null && <strong>{agent.initialScore}/{agent.scale}</strong>}<ScoreMove agent={agent} />{agent.movement === "pending" ? <small>Final score is not in yet</small> : <small>Score unavailable in this run</small>}</div>;
  }
  return <div className="score-bars"><div><span>Initial</span><i><b style={{ width: `${(agent.initialScore / agent.scale) * 100}%` }} /></i><strong>{agent.initialScore}/{agent.scale}</strong></div><div><span>Final</span><i><b style={{ width: `${(agent.finalScore / agent.scale) * 100}%` }} /></i><strong>{agent.finalScore}/{agent.scale}</strong></div><ScoreMove agent={agent} /></div>;
}

function Why({ why }: { why: WhyView | null }) {
  if (!why || (!why.report && why.points.length === 0 && !why.risk && why.assumptions.length === 0 && why.changes.length === 0)) return null;
  return <details className="why"><summary>Why</summary>{why.report && <p className="why-report">{why.report}</p>}{why.points.length > 0 && <ol>{why.points.map((point) => <li key={point}>{point}</li>)}</ol>}{why.risk && <p><b>Biggest risk.</b> {why.risk}</p>}{why.assumptions.length > 0 && <ul>{why.assumptions.map((claim) => <li key={`${claim.grounding}-${claim.statement}`}><span>{claim.grounding.replaceAll("_", " ")}</span>{claim.statement}{claim.evidenceNote ? ` — ${claim.evidenceNote}` : ""}</li>)}</ul>}{why.changes.length > 0 && <div>{why.changes.map((change) => <p key={change}>{change}</p>)}</div>}</details>;
}

function AgentCard({ agent }: { agent: AgentView }) {
  const score = agent.finalScore ?? agent.initialScore;
  return <article className="agent-card" style={{ "--agent": agent.color } as CSSProperties}><div className="card-top"><AgentMark agent={agent} /><span className={`live ${agent.status}`}>{agent.status}</span></div>{score != null && agent.scale > 0 ? <div className="dial"><svg viewBox="0 0 36 36" aria-label={`${agent.label} score ${score} out of ${agent.scale}`}><circle cx="18" cy="18" r="15" /><circle className="dial-value" cx="18" cy="18" r="15" pathLength="100" strokeDasharray={`${(score / agent.scale) * 100} 100`} /></svg><b>{score}<small>/{agent.scale}</small></b></div> : <div className="dial fallback-dial">—</div>}{agent.finalPosition || agent.initialPosition ? <span className="position" style={{ background: `${agent.color}22`, color: agent.color }}>{agent.finalPosition ?? agent.initialPosition}</span> : null}<p>{agent.mandate}</p><Why why={agent.why} /></article>;
}

function Radar({ values }: { values: NonNullable<CommitteeView["radar"]> }) {
  const points = values.map((value, index) => {
    const angle = (Math.PI * 2 * index) / values.length - Math.PI / 2;
    const radius = 44 * (value.value / value.max);
    return `${60 + Math.cos(angle) * radius},${60 + Math.sin(angle) * radius}`;
  }).join(" ");
  return <div className="radar"><svg viewBox="0 0 120 120" role="img" aria-label="Chair score radar"><polygon className="radar-grid" points="60,10 110,60 60,110 10,60" /><polygon className="radar-shape" points={points} />{values.map((item, index) => { const angle = (Math.PI * 2 * index) / values.length - Math.PI / 2; return <text key={item.label} x={60 + Math.cos(angle) * 54} y={60 + Math.sin(angle) * 54} textAnchor="middle">{item.label}</text>; })}</svg><div className="radar-key">{values.map((item) => <span key={item.label}>{item.label} <b>{item.value}/{item.max}</b></span>)}</div></div>;
}

function ConfidenceGauge({ value }: { value: number }) {
  return <div className="gauge"><svg viewBox="0 0 120 68" role="img" aria-label={`Confidence ${value} percent`}><path d="M 17 59 A 43 43 0 0 1 103 59" className="gauge-track" /><path d="M 17 59 A 43 43 0 0 1 103 59" className="gauge-value" pathLength="100" strokeDasharray={`${value} 100`} /></svg><b>{value}%</b><span>Chair confidence</span></div>;
}

const advanceFlights = new Map<string, Promise<{ status: number; body: ApiBody }>>();

async function postDebate(path: string, payload: unknown, signal: AbortSignal): Promise<{ status: number; body: ApiBody }> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const body = await response.json() as ApiBody;
  return { status: response.status, body };
}

export function App() {
  const [mode, setMode] = useState<Mode>("live");
  const [brief, setBrief] = useState<IdeaBrief>(emptyBrief);
  const [errors, setErrors] = useState<BriefFieldError[]>([]);
  const [run, setRun] = useState<DebateRun | null>(null);
  const [screen, setScreen] = useState(0);
  const [revealed, setRevealed] = useState(0);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [providerReady, setProviderReady] = useState<boolean | null>(null);
  const epoch = useRef(0);
  const runRef = useRef<DebateRun | null>(null);
  runRef.current = run;
  const view = toCommitteeView(mode === "demo" ? demoRun : run);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/provider-status", { signal: controller.signal })
      .then((response) => response.json() as Promise<{ configured?: boolean }>)
      .then((status) => setProviderReady(Boolean(status.configured)))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const advanceKey = `${mode}|${run?.id ?? ""}|${run?.phase ?? ""}|${run?.messages.length ?? 0}|${run?.failure?.code ?? ""}|${expired}`;
  useEffect(() => {
    if (mode !== "live" || !run || run.failure || expired) return;
    if (run.phase === "founder" || run.phase === "verdict" || run.phase === "complete") return;
    const token = epoch.current;
    const activeId = run.id;
    let cancelled = false;
    setBusy(true);
    const existing = advanceFlights.get(advanceKey);
    const flight = existing ?? postDebate("/api/debate/advance", { runId: activeId }, new AbortController().signal)
      .finally(() => advanceFlights.delete(advanceKey));
    if (!existing) advanceFlights.set(advanceKey, flight);
    void flight.then((result) => {
      if (cancelled || epoch.current !== token) return;
      applyResult(token, activeId, result);
    }).catch((error: unknown) => {
      if (cancelled || epoch.current !== token) return;
      setNotice(error instanceof Error ? error.message : "The debate request failed.");
      setBusy(false);
    });
    return () => {
      cancelled = true;
    };
  }, [advanceKey]);
  useEffect(() => {
    if (mode !== "live" || !run) return;
    if (run.messages.some((message) => message.speaker === "chair" && message.envelope?.decision)) setScreen(4);
    else if (run.phase === "founder" || run.phase === "verdict") setScreen(3);
    else if (run.messages.some((message) => message.speaker === "red_team" && message.envelope)) setScreen(2);
    else if (run.id) setScreen(1);
  }, [mode, run]);
  useEffect(() => {
    if (mode === "live") setRevealed(view.challenges.length);
  }, [mode, view.challenges.length]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
      if (event.code !== "Space" || screen !== 2) return;
      event.preventDefault();
      setRevealed((value) => Math.min(value + 1, view.challenges.length));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, view.challenges.length]);

  function applyResult(token: number, activeId: string, result: { status: number; body: ApiBody }) {
    const incoming = result.body.run;
    if (ignoreStaleUpdate(runRef.current?.id ?? activeId, epoch.current, token, incoming?.id ?? activeId)) return;
    setBusy(false);
    if (result.status === 404) {
      setExpired(true);
      setNotice("This run is no longer on the server. Start again to keep live data separate from the demo.");
      return;
    }
    if (incoming) setRun(incoming);
    if (!result.body.error && result.status < 400) {
      setNotice(null);
      setExpired(false);
      return;
    }
    setNotice(result.body.error ?? "The debate step failed.");
    if (result.body.fields) setErrors(result.body.fields);
  }

  function resetEpoch() {
    epoch.current += 1;
    setBusy(false);
  }

  function resetLive(nextBrief = emptyBrief()) {
    resetEpoch();
    setMode("live");
    setBrief(nextBrief);
    setRun(null);
    setScreen(0);
    setRevealed(0);
    setDraft("");
    setNotice(null);
    setExpired(false);
    setErrors([]);
  }

  function switchMode() {
    resetEpoch();
    setNotice(null);
    setExpired(false);
    setErrors([]);
    setRevealed(0);
    setScreen(0);
    setDraft("");
    if (mode === "live") {
      setRun(null);
      setMode("demo");
      return;
    }
    setMode("live");
    setRun(null);
  }

  async function submitLive() {
    const checked = validateBrief(brief);
    if (!checked.ok) {
      setErrors(checked.errors);
      setBrief(checked.draft);
      return;
    }
    setErrors([]);
    setExpired(false);
    setNotice(null);
    const token = epoch.current;
    const controller = new AbortController();
    setBusy(true);
    try {
      const result = await postDebate("/api/debate/start", { brief: checked.value }, controller.signal);
      if (epoch.current !== token) return;
      setBusy(false);
      if (result.body.fields) setErrors(result.body.fields);
      if (!result.body.run) {
        setNotice(result.body.error ?? "The brief was not accepted.");
        return;
      }
      setRun(result.body.run);
      setScreen(1);
      setRevealed(0);
    } catch (error) {
      if (epoch.current !== token) return;
      setBusy(false);
      setNotice(error instanceof Error ? error.message : "The debate request failed.");
    }
  }

  async function sendFounder(message: string) {
    const text = message.trim();
    if (!run || !text) return;
    const token = epoch.current;
    const activeId = run.id;
    setBusy(true);
    setNotice(null);
    try {
      const result = await postDebate("/api/debate/founder", { runId: activeId, founderMessage: text }, new AbortController().signal);
      applyResult(token, activeId, result);
      if (result.status < 400) setDraft("");
    } catch (error) {
      if (epoch.current !== token) return;
      setBusy(false);
      setNotice(error instanceof Error ? error.message : "The founder question failed.");
    }
  }

  async function requestVerdict() {
    if (!run) return;
    if (run.failure && ["assessments", "challenge", "rebuttals"].includes(run.failure.phase ?? "")) {
      setNotice("Resolve the failed stage before requesting a verdict.");
      return;
    }
    if (!requiredStagesComplete(run) || ["assessments", "challenge", "rebuttals"].includes(run.phase)) {
      setNotice("The Chair cannot run until openings, Red Team, and rebuttals finish.");
      return;
    }
    const token = epoch.current;
    const activeId = run.id;
    setBusy(true);
    try {
      const result = await postDebate("/api/debate/verdict", { runId: activeId }, new AbortController().signal);
      applyResult(token, activeId, result);
      if (result.body.run?.messages.some((message) => message.speaker === "chair" && message.envelope?.decision)) setScreen(4);
    } catch (error) {
      if (epoch.current !== token) return;
      setBusy(false);
      setNotice(error instanceof Error ? error.message : "The verdict request failed.");
    }
  }

  async function retry() {
    if (!run) return;
    const token = epoch.current;
    const activeId = run.id;
    const path = run.phase === "verdict" ? "/api/debate/verdict" : "/api/debate/advance";
    setBusy(true);
    setNotice(null);
    try {
      const result = await postDebate(path, { runId: activeId }, new AbortController().signal);
      applyResult(token, activeId, result);
    } catch (error) {
      if (epoch.current !== token) return;
      setBusy(false);
      setNotice(error instanceof Error ? error.message : "Retry failed.");
    }
  }

  const fieldError = (field: keyof IdeaBrief) => errors.find((error) => error.field === field)?.message;
  const visibleChallenges = view.challenges.slice(0, revealed);
  const founderReady = mode === "demo" || (run?.phase === "founder" || run?.phase === "verdict" || run?.phase === "complete");
  const verdictReady = mode === "demo" || (run != null && requiredStagesComplete(run) && !["assessments", "challenge", "rebuttals"].includes(run.phase) && !(run.failure && ["assessments", "challenge", "rebuttals"].includes(run.failure.phase ?? "")));

  return <main className="gauntlet">
    <header className="hero">
      <p>Venture Gauntlet <span>— AI investment committee</span></p>
      <div className="button-row">
        <button className="ghost" onClick={switchMode}>{mode === "live" ? "Use demo data" : "Back to live"}</button>
        <button className="ghost" onClick={() => mode === "demo" ? (setScreen(0), setRevealed(0)) : resetLive()}>New brief</button>
      </div>
    </header>
    {mode === "demo" && <p className="mode-banner" role="status">Demo mode — sample committee data, not this idea’s live debate.</p>}
    {notice && <p className="failure-banner" role="alert">{notice}{mode === "live" && run?.failure && !expired && <button onClick={retry} disabled={busy}>Retry failed step</button>}{expired && <button onClick={() => resetLive(brief)}>Start again</button>}</p>}
    <Stepper stages={view.stages} />
    {screen === 0 && <section className="idea screen">
      <p className="kicker">{mode === "live" ? "Live committee" : "Sample brief"}</p>
      <h1>What company should the committee decide on?</h1>
      {mode === "live" && providerReady === false && <p className="field-error">No model provider is configured. A live run will fail visibly and will not switch to demo data.</p>}
      {mode === "demo" ? <>
        <label>Startup idea<textarea value={view.idea} readOnly /></label>
        <label>Target customer<input value={view.customer} readOnly /></label>
        <button className="primary" onClick={() => setScreen(1)}>Convene the committee <span>→</span></button>
      </> : <form onSubmit={(event) => { event.preventDefault(); void submitLive(); }}>
        <BriefField label="Startup idea" value={brief.idea} error={fieldError("idea")} multiline onChange={(idea) => setBrief({ ...brief, idea })} />
        <BriefField label="Problem" value={brief.problem} error={fieldError("problem")} multiline onChange={(problem) => setBrief({ ...brief, problem })} />
        <BriefField label="Target customer" value={brief.targetCustomer} error={fieldError("targetCustomer")} onChange={(targetCustomer) => setBrief({ ...brief, targetCustomer })} />
        <BriefField label="Proposed solution" value={brief.solution} error={fieldError("solution")} multiline onChange={(solution) => setBrief({ ...brief, solution })} />
        <BriefField label="Business model" value={brief.businessModel} error={fieldError("businessModel")} onChange={(businessModel) => setBrief({ ...brief, businessModel })} />
        <BriefField label="Traction, optional" value={brief.traction} error={fieldError("traction")} onChange={(traction) => setBrief({ ...brief, traction })} />
        <BriefField label="Founder evidence, optional" value={brief.founderEvidence} error={fieldError("founderEvidence")} multiline onChange={(founderEvidence) => setBrief({ ...brief, founderEvidence })} />
        <button className="primary" type="submit" disabled={busy}>{busy ? "Starting the live run…" : "Convene the committee"} <span>→</span></button>
      </form>}
    </section>}
    {screen === 1 && <section className="screen">
      <div className="screen-intro"><p className="kicker">Six independent views</p><h1>Committee is taking positions.</h1><p>Scores and reports appear only after that agent’s real contribution is recorded.</p></div>
      <div className="agent-grid">{view.agents.map((agent) => <AgentCard key={agent.id} agent={agent} />)}</div>
      <button className="primary" disabled={mode === "live" && !view.challenges.length} onClick={() => setScreen(2)}>Start the debate <span>→</span></button>
    </section>}
    {screen === 2 && <section className="screen debate-screen">
      <div className="screen-intro"><p className="kicker">Red Team cross-examination</p><h1>The uncomfortable questions.</h1></div>
      {visibleChallenges.length === 0 && <p className="waiting">{view.challenges.length ? "Reveal the first recorded challenge." : "No Red Team challenge is recorded yet."}</p>}
      {visibleChallenges.map((challenge) => <article className="challenge-card" key={challenge.slot}><div className="challenge-route"><AgentMark agent={challenge.challenger} /><b>→</b><AgentMark agent={challenge.target} /></div><blockquote>{challenge.claim ? `“${challenge.claim}”` : "Claim unavailable for this slot."}</blockquote>{challenge.challengeWhy && <p>{challenge.challengeWhy}</p>}<p className="response">{challenge.responsePending ? "Rebuttal not recorded yet." : challenge.response}</p>{challenge.responsePending ? <span className="position-move">Revision pending</span> : <ScoreMove agent={challenge.target} />}<Why why={challenge.challenger.id === "red_team" ? view.agents.find((agent) => agent.id === "red_team")?.why ?? null : null} /><Why why={challenge.target.why} /></article>)}
      <div className="network"><h2>Points under pressure</h2><svg viewBox="0 0 760 230" role="img" aria-label="Debate network diagram">{view.network.nodes.map((node) => <g key={node.id}><circle cx={node.x} cy={node.y} r="30" fill={node.color} /><text x={node.x} y={node.y + 4} textAnchor="middle">{node.short}</text></g>)}{view.network.edges.filter((edge) => visibleChallenges.some((challenge) => challenge.slot === edge.slot)).map((edge) => <g key={`${edge.slot}-${edge.target}`}><path d={edge.path} /><text x={edge.labelX} y={edge.labelY}>{edge.label}</text></g>)}</svg></div>
      <div className="button-row">
        <button className="ghost" disabled={revealed >= view.challenges.length} onClick={() => setRevealed((value) => value + 1)}>Next challenge</button>
        <button className="primary" disabled={!founderReady || revealed < view.challenges.length} onClick={() => setScreen(3)}>Founder pause <span>→</span></button>
      </div>
    </section>}
    {screen === 3 && <section className="screen intervention">
      <div className="screen-intro"><p className="kicker">Founder pause</p><h1>What should the committee weigh?</h1><p>These questions go to the live founder endpoint. The API answers from the customer seat and does not route a button to a chosen specialist.</p></div>
      <div className="challenge-buttons">{prompts.map((prompt) => <button key={prompt} disabled={mode === "live" && (busy || !run || run.phase !== "founder")} onClick={() => mode === "demo" ? setScreen(4) : void sendFounder(prompt)}>{prompt}</button>)}</div>
      <label>Add a question or evidence<textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => event.stopPropagation()} placeholder="Give the committee something new to weigh…" /></label>
      {view.founderExchanges.map((exchange) => <article className="challenge-card" key={exchange.question}><p>{exchange.question}</p><p className="response">{exchange.response ?? "Response not recorded yet."}</p></article>)}
      <div className="button-row">
        <button className="ghost" disabled={mode === "live" && busy} onClick={() => mode === "demo" ? setScreen(4) : void sendFounder(draft)}>Send to the committee</button>
        <button className="primary" disabled={!verdictReady || busy} onClick={() => mode === "demo" ? setScreen(4) : void requestVerdict()}>Request verdict <span>→</span></button>
      </div>
    </section>}
    {screen === 4 && <section className="screen verdict">
      <div className="verdict-head"><div><p className="kicker">The committee’s decision</p><h1>{view.verdict ?? "Verdict unavailable"}</h1><p>{view.summary ?? "The Chair has not recorded a decision for this run."}</p></div>{view.confidence == null ? <p>Confidence unavailable</p> : <ConfidenceGauge value={view.confidence} />}</div>
      <div className="stats">{view.stats.map((stat) => <div key={stat.label}><b>{stat.value}</b><span>{stat.label}</span></div>)}</div>
      <div className="verdict-grid"><section className="radar-card"><h2>Decision geometry</h2>{view.radar ? <Radar values={view.radar} /> : <p>Chair dimension scores are unavailable.</p>}</section><section className="decision-cards">{view.decisionCards.map((card) => <article key={card.title}><h2>{card.title}</h2><p>{card.content}</p></article>)}{view.agents.find((agent) => agent.id === "chair") && <Why why={view.agents.find((agent) => agent.id === "chair")?.why ?? null} />}</section></div>
      <section className="risk-card"><h2>Kill risks to solve</h2>{view.killRisks == null ? <p>Kill risks unavailable.</p> : view.killRisks.map((risk) => <p key={risk}>× {risk}</p>)}</section>
      <section className="changed"><div><p className="kicker">What changed</p><h2>Every position, before and after.</h2></div><div className="score-list">{view.specialists.map((agent) => <article key={agent.id}><AgentMark agent={agent} /><ScoreBars agent={agent} />{agent.reason && <p>{agent.reason}</p>}</article>)}</div></section>
      <button className="primary" onClick={() => mode === "demo" ? (setScreen(0), setRevealed(0)) : resetLive()}>Run another idea <span>↻</span></button>
    </section>}
  </main>;
}

function BriefField({ label, value, error, multiline = false, onChange }: { label: string; value: string; error?: string; multiline?: boolean; onChange: (value: string) => void }) {
  return <label>{label}{multiline ? <textarea value={value} aria-invalid={Boolean(error)} onChange={(event) => onChange(event.target.value)} /> : <input value={value} aria-invalid={Boolean(error)} onChange={(event) => onChange(event.target.value)} />}{error && <small className="field-error">{error}</small>}</label>;
}
