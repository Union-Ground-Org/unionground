import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { caseStepInReview, caseStepText, loadCaseStepLabels, loadCaseStepLabelsByScope, memberCaseStep, procedureStepLabels } from './caseStepLabels';

// BUG-UG-NATIVE-CASE-STEP-KEYS-SHOWN-20261106 (#7197): the starter
// procedure's keys and English labels
// (supabase/migrations/20261002159000_starter_procedure_and_new_member_items.sql).
const STARTER: [string, string][] = [
  ['filing', 'File the grievance'],
  ['step_1', 'Step 1: management response'],
  ['step_2_appeal', 'Appeal to Step 2'],
  ['step_2', 'Step 2: management response'],
  ['step_3_appeal', 'Appeal to Step 3'],
  ['step_3', 'Step 3: management response'],
  ['arbitration_demand', 'Demand arbitration'],
  ['arbitration', 'Arbitration'],
];
const procedure = { id: 'proc-1', name: 'Starter', steps: STARTER.map(([key, label], position) => ({ key, label, position })), case_step: 'step_2_appeal', allowed_next_steps: ['step_2'] };
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('native issue step labels', () => {
  it('names every starter key by its procedure label', () => {
    const labels = procedureStepLabels(procedure);
    for (const [key, label] of STARTER) expect(caseStepText(key, labels)).toBe(label);
  });

  it('shows a free-text step exactly as stored', () => {
    const labels = procedureStepLabels(procedure);
    expect(caseStepText('Waiting on HR review', labels)).toBe('Waiting on HR review');
    expect(caseStepText('step_2_appeal', null)).toBe('step_2_appeal');
    expect(caseStepText(null, labels)).toBe('');
  });

  it('skips malformed procedure steps and reads a null procedure as no labels', () => {
    expect(procedureStepLabels(null).size).toBe(0);
    expect(procedureStepLabels([]).size).toBe(0);
    expect([...procedureStepLabels({ steps: [{ key: 'filing', label: '  ' }, { key: 7, label: 'x' }, null, { key: 'step_1', label: ' Step 1 ' }] })]).toEqual([['step_1', 'Step 1']]);
  });

  it('falls back to the stored step when the procedure read fails or is refused', async () => {
    expect((await loadCaseStepLabels(vi.fn().mockResolvedValue({ data: null, error: new Error('mfa required') }), 'case-1')).size).toBe(0);
    expect((await loadCaseStepLabels(vi.fn().mockRejectedValue(new Error('offline')), 'case-1')).size).toBe(0);
    expect((await loadCaseStepLabels(vi.fn().mockResolvedValue({ data: procedure, error: null }), 'case-1')).get('filing')).toBe('File the grievance');
  });

  it('reads one procedure per organization, campaign and issue type and labels only key steps', async () => {
    const request = vi.fn(async (caseID: string) => (caseID === 'broken' ? { data: null, error: new Error('nope') } : { data: procedure, error: null }));
    const labels = await loadCaseStepLabelsByScope(request, [
      { id: 'a', step: 'filing', organization_id: 'org', chapter_id: 'ch-1', case_type: 'Grievance' },
      { id: 'b', step: 'step_2_appeal', organization_id: 'org', chapter_id: 'ch-1', case_type: 'Grievance' },
      { id: 'c', step: 'Waiting on HR', organization_id: 'org', chapter_id: 'ch-1', case_type: 'Grievance' },
      { id: 'broken', step: 'step_1', organization_id: 'org', chapter_id: 'ch-2', case_type: 'Grievance' },
      { id: 'd', step: 'step_1', organization_id: 'org', chapter_id: 'ch-2', case_type: 'Grievance' },
      { id: 'blank', step: '  ', organization_id: 'org', chapter_id: 'ch-3', case_type: 'Grievance' },
    ]);
    expect(request.mock.calls.map(([id]) => id)).toEqual(['a', 'broken']);
    expect([...labels]).toEqual([['a', 'File the grievance'], ['b', 'Appeal to Step 2']]);
  });

  it('displays a loaded issue by its label and keeps review matching on either text', () => {
    expect(memberCaseStep({ step: 'step_2_appeal', stepLabel: 'Appeal to Step 2' })).toBe('Appeal to Step 2');
    expect(memberCaseStep({ step: 'Waiting on HR' })).toBe('Waiting on HR');
    expect(caseStepInReview({ step: 'step_9', stepLabel: 'Management review' })).toBe(true);
    expect(caseStepInReview({ step: 'review' })).toBe(true);
    expect(caseStepInReview({ step: 'filing', stepLabel: 'File the grievance' })).toBe(false);
  });

  it('renders the label, never a capitalized key, on issue detail and Home', () => {
    const detail = read('../../app/issue/[id].tsx');
    expect(detail).toContain('<Detail label="Where it stands" value={memberCaseStep(item)} />');
    expect(detail).not.toMatch(/value: \{[^}]*textTransform: 'capitalize'/);
    // This edition has no grievance-step progress view (MemberCaseworkProgress).
    const home = read('../../app/(tabs)/home.tsx');
    expect(home).toContain('{memberCaseStep(nextCase)}');
    expect(home).toContain('dashboard.cases.find(caseStepInReview)');
    expect(home).not.toMatch(/\b(?:nextCase|reviewCase)\.step\b/);
  });
});
