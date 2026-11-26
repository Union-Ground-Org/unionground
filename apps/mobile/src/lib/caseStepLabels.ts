// BUG-UG-NATIVE-CASE-STEP-KEYS-SHOWN-20261106 (#7197): when a grievance
// procedure applies, member_cases.step and casework_step_transitions hold step
// keys (filing, step_2_appeal, ...). Web names them through
// casework_get_case_procedure (CasesView procedureStep.label); native does the
// same here. A free-text step, a key the procedure does not define, or a failed
// procedure read shows the stored text unchanged, and never hides the case.

export type StepLabels = ReadonlyMap<string, string>;

export type CaseProcedureRequest = (caseID: string) => PromiseLike<{ data: unknown; error: unknown }>;

// The procedure JSON's steps as key -> label; anything malformed is skipped.
export function procedureStepLabels(value: unknown): Map<string, string> {
  const labels = new Map<string, string>();
  const steps = value && typeof value === 'object' && !Array.isArray(value) ? (value as { steps?: unknown }).steps : null;
  if (!Array.isArray(steps)) return labels;
  const items: unknown[] = steps;
  for (const step of items) {
    const row = step && typeof step === 'object' && !Array.isArray(step) ? step as Record<string, unknown> : {};
    if (typeof row.key === 'string' && typeof row.label === 'string' && row.label.trim()) labels.set(row.key, row.label.trim());
  }
  return labels;
}

// The step as a person reads it: the procedure's label for a key it defines,
// otherwise the stored text as written.
export function caseStepText(step: unknown, labels?: StepLabels | null): string {
  const stored = typeof step === 'string' ? step.trim() : '';
  return (stored && labels?.get(stored)) || stored;
}

// One case's procedure labels; a failed or refused read is an empty map.
export async function loadCaseStepLabels(request: CaseProcedureRequest, caseID: string): Promise<Map<string, string>> {
  if (!caseID) return new Map();
  try {
    const { data, error } = await request(caseID);
    return error ? new Map() : procedureStepLabels(data);
  } catch {
    return new Map();
  }
}

export type StepScopeRow = {
  id: string;
  step: unknown;
  organization_id?: unknown;
  chapter_id?: unknown;
  case_type?: unknown;
};

// The server resolves a case's procedure from its organization, chapter and
// case type (private.casework_resolve_procedure), so one read per distinct
// scope labels every case in it. Returns case id -> label for the rows whose
// stored step is a key of their procedure.
export const MAX_STEP_LABEL_SCOPES = 20;

export async function loadCaseStepLabelsByScope(request: CaseProcedureRequest, rows: readonly StepScopeRow[]): Promise<Map<string, string>> {
  const scopes = new Map<string, { probe: string; members: StepScopeRow[] }>();
  for (const row of rows) {
    if (!row.id || typeof row.step !== 'string' || !row.step.trim()) continue;
    const scope = JSON.stringify([row.organization_id ?? null, row.chapter_id ?? null, row.case_type ?? null]);
    const group = scopes.get(scope);
    if (group) group.members.push(row);
    else if (scopes.size < MAX_STEP_LABEL_SCOPES) scopes.set(scope, { probe: row.id, members: [row] });
  }
  const resolved = await Promise.all([...scopes.values()].map(async ({ probe, members }) => ({ members, labels: await loadCaseStepLabels(request, probe) })));
  const byCase = new Map<string, string>();
  for (const { members, labels } of resolved) {
    for (const row of members) {
      const label = labels.get(String(row.step).trim());
      if (label) byCase.set(row.id, label);
    }
  }
  return byCase;
}

// A loaded case's step for display: its procedure label when the dashboard or
// detail read found one, otherwise the stored text.
export function memberCaseStep(item: { step: string; stepLabel?: string }): string {
  return item.stepLabel || item.step;
}

// Screens that pick out cases "in review" read the word in either the stored
// step or its procedure label.
export function caseStepInReview(item: { step: string; stepLabel?: string }): boolean {
  return `${item.step} ${item.stepLabel ?? ''}`.toLowerCase().includes('review');
}
