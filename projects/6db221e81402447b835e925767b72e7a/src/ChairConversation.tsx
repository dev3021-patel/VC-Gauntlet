import { useEffect, useRef, useState } from "react";
import type { RoleEnvelope } from "./contract";
import type { ChairChatExchange } from "./verdictChat";

export function ChairConversation({ runId }: { runId: string }) {
  const [question, setQuestion] = useState("");
  const [evidence, setEvidence] = useState("");
  const [exchanges, setExchanges] = useState<ChairChatExchange[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function ask() {
    if (pending.current || !question.trim()) return;
    const controller = new AbortController();
    pending.current = controller;
    const input = { question: question.trim(), newEvidence: evidence.trim() };
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/debate/verdict-chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, ...input }), signal: controller.signal,
      });
      const result = await response.json() as { reply?: RoleEnvelope; error?: string };
      if (!response.ok || !result.reply) throw new Error(result.error || "The Chair could not answer. Try again.");
      if (controller.signal.aborted) return;
      setExchanges((previous) => [...previous, { input, reply: result.reply! }]);
      setQuestion("");
      setEvidence("");
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "The request failed. Try again.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      pending.current = null;
    }
  }

  return <section className="verdict-chat" aria-labelledby="verdict-chat-title">
    <h2 id="verdict-chat-title">Discuss your verdict with the Chair</h2>
    <p>Explore the committee's reasoning or bring new evidence. Your original verdict stays as issued.</p>
    <ol className="transcript" role="log" aria-label="Chair conversation" aria-live="polite">
      {exchanges.map((exchange, index) => <li key={index}>
        <strong>You</strong><p>{exchange.input.question}</p>
        {exchange.input.newEvidence ? <p>New evidence: {exchange.input.newEvidence}</p> : null}
        <strong>Committee Chair</strong><p className="chair-output">{exchange.reply.summary}</p>
      </li>)}
    </ol>
    <form onSubmit={(event) => { event.preventDefault(); void ask(); }}>
      <label htmlFor="chair-question">Ask the Chair<textarea id="chair-question" required disabled={busy} value={question} onChange={(event) => setQuestion(event.target.value)} /></label>
      <label htmlFor="chair-evidence">New evidence (optional)<textarea id="chair-evidence" disabled={busy} value={evidence} onChange={(event) => setEvidence(event.target.value)} /></label>
      {error ? <p className="failure" role="alert">{error} Your question is saved; you can try again.</p> : null}
      <p role="status">{busy ? "The Chair is reviewing the full debate…" : ""}</p>
      <button disabled={busy || !question.trim()}>{busy ? "Reviewing…" : error ? "Retry question" : "Ask the Chair"}</button>
    </form>
  </section>;
}
