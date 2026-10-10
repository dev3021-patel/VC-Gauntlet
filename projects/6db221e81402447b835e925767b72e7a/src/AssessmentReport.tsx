import {
  getPrimaryScore,
  isSpecialist,
  SPECIALIST_SCORE_SPECS,
  type Grounding,
  type RoleEnvelope,
  type SpecialistRole,
} from "./contract";
import "./assessment-report.css";

const scoreLabels: Record<SpecialistRole, string> = {
  vc: "Venture score",
  customer: "Adoption score",
  competitor: "Threat to incumbent",
  engineer: "Feasibility score",
};

const groundingLabels: Record<Grounding, string> = {
  founder_provided: "Founder-provided",
  supported_evidence: "Supported evidence",
  assumption: "Assumption",
  unknown: "Unknown",
};

/** Display existing assessment content without changing the output contract. */
export function AssessmentReport({ envelope }: { envelope: RoleEnvelope }) {
  if (!isSpecialist(envelope.role) || envelope.stage !== "assessment") return null;
  const score = getPrimaryScore(envelope);
  const reasoning = envelope.rationale.split(/\r?\n/)
    .map((point) => point.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  return <section className="assessment-report" aria-label="Assessment report">
    <p className="assessment-report-position">
      {score !== null ? `${scoreLabels[envelope.role]}: ${score}/${SPECIALIST_SCORE_SPECS[envelope.role].max} · ` : ""}
      Position: {envelope.positionLabel}
    </p>
    <h3>Why this assessment</h3>
    <ul>{reasoning.map((point, index) => <li key={index}>{point}</li>)}</ul>
    {envelope.risks[0] ? <p><strong>Biggest risk:</strong> {envelope.risks[0]}</p> : null}
    {envelope.assumptions.length ? <>
      <h3>Assumptions and evidence</h3>
      <ul>{envelope.assumptions.map((claim, index) => <li key={index}>
        <strong>{groundingLabels[claim.grounding]}:</strong> {claim.statement}
        {claim.evidenceNote ? <p className="assessment-report-evidence">Evidence note: {claim.evidenceNote}</p> : null}
      </li>)}</ul>
    </> : <p>No assumptions recorded.</p>}
  </section>;
}
