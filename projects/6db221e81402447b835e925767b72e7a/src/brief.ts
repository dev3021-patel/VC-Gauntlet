export interface IdeaBrief {
  idea: string;
  problem: string;
  targetCustomer: string;
  solution: string;
  businessModel: string;
  traction: string;
  founderEvidence: string;
}

export interface BriefFieldError {
  field: keyof IdeaBrief;
  message: string;
}

export type BriefResult =
  | { ok: true; value: IdeaBrief }
  | { ok: false; errors: BriefFieldError[]; draft: IdeaBrief };

const REQUIRED: Array<keyof IdeaBrief> = [
  "idea",
  "problem",
  "targetCustomer",
  "solution",
  "businessModel",
];

const LABELS: Record<keyof IdeaBrief, string> = {
  idea: "Startup idea",
  problem: "Problem",
  targetCustomer: "Target customer",
  solution: "Proposed solution",
  businessModel: "Business model",
  traction: "Traction",
  founderEvidence: "Founder evidence",
};

export function emptyBrief(): IdeaBrief {
  return {
    idea: "",
    problem: "",
    targetCustomer: "",
    solution: "",
    businessModel: "",
    traction: "",
    founderEvidence: "",
  };
}

export function normalizeBrief(input: Partial<IdeaBrief>): IdeaBrief {
  const blank = emptyBrief();
  const draft = { ...blank };
  for (const key of Object.keys(blank) as Array<keyof IdeaBrief>) {
    const value = input[key];
    draft[key] = typeof value === "string" ? value : "";
  }
  return draft;
}

export function validateBrief(input: Partial<IdeaBrief>): BriefResult {
  const draft = normalizeBrief(input);
  const errors: BriefFieldError[] = [];
  for (const field of REQUIRED) {
    const value = draft[field].trim();
    if (!value) {
      errors.push({ field, message: `${LABELS[field]} is required.` });
      continue;
    }
    if (value.length < 8) {
      errors.push({
        field,
        message: `${LABELS[field]} needs a bit more detail.`,
      });
    }
  }
  if (errors.length > 0) return { ok: false, errors, draft };
  return {
    ok: true,
    value: {
      ...draft,
      idea: draft.idea.trim(),
      problem: draft.problem.trim(),
      targetCustomer: draft.targetCustomer.trim(),
      solution: draft.solution.trim(),
      businessModel: draft.businessModel.trim(),
      traction: draft.traction.trim(),
      founderEvidence: draft.founderEvidence.trim(),
    },
  };
}
