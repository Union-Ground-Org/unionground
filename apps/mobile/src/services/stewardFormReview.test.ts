import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  sensitive: vi.fn(),
}));

function query(data: unknown, error: { message?: string } | null = null) {
  const chain: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'limit', 'in']) chain[name] = () => chain;
  chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => (
    Promise.resolve({ data, error }).then(resolve, reject)
  );
  return chain;
}

vi.mock('./supabase', () => ({
  getSupabaseClient: () => ({ rpc: backend.rpc, from: backend.from }),
}));
vi.mock('../../../../src/lib/sensitiveContentApi.js', () => ({
  sensitiveContentRpc: backend.sensitive,
}));
vi.mock('../lib/config', () => ({ mobileConfig: { portalBaseUrl: 'https://sample.unionground.example' } }));

import {
  formatFormSubmittedAt,
  loadStewardFormReviewDetail,
  projectStewardFormRow,
  stewardFormApprovalBlock,
  type StewardFormReviewRow,
} from './stewardFormReview';

const submitted = '2026-11-01T15:04:00.000Z';

function row(overrides: Record<string, unknown> = {}): StewardFormReviewRow {
  const projected = projectStewardFormRow({
    id: 'f1',
    user_id: 'member-1',
    member_name: 'Marcus Greene',
    template_key: 'grievance',
    template_version: 3,
    status: 'submitted',
    submitted_at: submitted,
    answers: { summary: 'The posted schedule changed.', incident_date: '2026-10-30' },
    ...overrides,
  });
  if (!projected) throw new Error('row was not reviewable');
  return projected;
}

beforeEach(() => {
  backend.rpc.mockReset();
  backend.from.mockReset();
  backend.sensitive.mockReset();
  backend.from.mockImplementation((table: string) => table === 'member_form_cosigners' || table === 'member_profiles' ? query([]) : query([{
    key: 'grievance',
    version: 3,
    label_en: 'Workplace issue report',
    field_schema: {
      steps: [{
        title: { en: 'What happened' },
        fields: [
          { key: 'summary', type: 'text', label: { en: 'Summary' } },
          { key: 'incident_date', type: 'date', label: { en: 'Incident date' } },
        ],
      }],
    },
  }]));
  backend.rpc.mockResolvedValue({
    data: { filerSigned: true, attachments: [{ id: 'file-1', filename: 'schedule.pdf', scanCurrent: true, confirmedAt: '2026-11-01T15:00:00Z' }] },
    error: null,
  });
});

describe('committee member form review content', () => {
  it('keeps a submitted form and an in-review form readable, and drops a draft', () => {
    const submittedRow = row();
    const reviewing = row({ id: 'f2', status: 'in_review', answers: { summary: 'Still open.' } });
    expect(projectStewardFormRow({ id: 'draft', status: 'draft', template_key: 'grievance', answers: { summary: 'private' } })).toBeNull();
    expect(submittedRow).toMatchObject({
      templateKey: 'grievance',
      templateLabel: 'Workplace issue report',
      templateVersion: 3,
      status: 'submitted',
      answers: { summary: 'The posted schedule changed.', incident_date: '2026-10-30' },
    });
    expect(reviewing.status).toBe('in_review');
    expect(formatFormSubmittedAt(submittedRow.submittedAt)).toContain('ET');
    expect(formatFormSubmittedAt(null)).toBe('Submission time is not recorded.');
  });

  it('shows the filed labels, version and a current attachment', async () => {
    const detail = await loadStewardFormReviewDetail(row());
    expect(detail.templateVersion).toBe(3);
    expect(detail.lines).toEqual([
      { label: 'Summary', value: 'The posted schedule changed.' },
      { label: 'Incident date', value: '2026-10-30' },
    ]);
    expect(detail.attachments).toEqual([{ id: 'file-1', filename: 'schedule.pdf', scanCurrent: true, confirmed: true }]);
    expect(stewardFormApprovalBlock(detail)).toBeNull();
    expect(backend.rpc).toHaveBeenCalledWith('get_form_filing_status', { p_form_id: 'f1' });
    expect(backend.sensitive).not.toHaveBeenCalled();
  });

  it('refuses a protected form whose answers cannot be opened and hides plaintext', async () => {
    const sealed = row({
      template_key: 'fmla_self',
      answers: { sealed: true },
    });
    expect(sealed.answers).toEqual({ sealed: true });
    backend.sensitive.mockResolvedValue({ data: null, error: { message: 'sensitive-data-unavailable' } });
    const refused = await loadStewardFormReviewDetail(sealed);
    expect(refused.answersUnavailable).toBe(true);
    expect(refused.lines).toEqual([]);
    expect(stewardFormApprovalBlock(refused)).toBe('This form\'s answers cannot be opened right now, so it cannot be approved.');
    expect(backend.sensitive).toHaveBeenCalledWith(
      expect.anything(),
      'get_sealed_forms',
      { formIds: ['f1'] },
      'https://sample.unionground.example',
    );

    const leaked = row({ template_key: 'fmla_family', answers: { condition_type: 'continuous' } });
    expect(leaked.answers).toEqual({});
    expect(leaked.answersHidden).toBe(true);
    const hidden = await loadStewardFormReviewDetail(leaked);
    expect(hidden.answersUnavailable).toBe(true);
    expect(hidden.lines).toEqual([]);
  });

  it('keeps approval unavailable when the signature is missing or an attachment is stale', async () => {
    backend.rpc.mockResolvedValueOnce({
      data: { filerSigned: false, attachments: [] },
      error: null,
    });
    const unsigned = await loadStewardFormReviewDetail(row());
    expect(stewardFormApprovalBlock(unsigned)).toBe('The worker signature is missing, so this form cannot be approved.');

    backend.rpc.mockResolvedValueOnce({
      data: { filerSigned: true, attachments: [{ id: 'file-2', filename: 'note.pdf', scanCurrent: false }] },
      error: null,
    });
    const stale = await loadStewardFormReviewDetail(row());
    expect(stewardFormApprovalBlock(stale)).toBe('These attachments need a current check before approval: note.pdf.');

    // REQ-UG-FORMS-SIGNATURE-ONLY-ON-SIGNED-STATEMENTS-20261115 (#8957): a
    // template that is not a signed statement is approvable unsigned; a server
    // that does not say so is read as requiring the signature.
    backend.rpc.mockResolvedValueOnce({ data: { filerSigned: false, signatureRequired: false, attachments: [] }, error: null });
    const optional = await loadStewardFormReviewDetail(row({ template_key: 'service_request' }));
    expect(optional.signatureRequired).toBe(false);
    expect(stewardFormApprovalBlock(optional)).toBeNull();
    expect(unsigned.signatureRequired).toBe(true);

    backend.rpc.mockResolvedValueOnce({ data: null, error: { message: 'form unavailable' } });
    const unread = await loadStewardFormReviewDetail(row());
    expect(stewardFormApprovalBlock(unread)).toBe('Filing attachments are unavailable right now, so this form cannot be approved.');
    expect(unread.attachments).toEqual([]);
  });

  it('records what an ordinary review showed: its answers, confirmed files and accepted co-signers (#8728)', async () => {
    backend.rpc.mockResolvedValueOnce({
      data: {
        filerSigned: true,
        attachments: [
          { id: 'file-1', filename: 'schedule.pdf', scanCurrent: true, confirmedAt: '2026-11-01T15:00:00Z' },
          { id: 'file-2', filename: 'pending.pdf', scanCurrent: true, confirmedAt: null },
        ],
      },
      error: null,
    });
    const tables: string[] = [];
    const registry = backend.from.getMockImplementation()!;
    backend.from.mockImplementation((table: string) => {
      tables.push(table);
      if (table === 'member_form_cosigners') return query([{ id: 'cosigner-1', cosigner_user_id: 'user-n' }]);
      if (table === 'member_profiles') return query([{ id: 'user-n', full_name: 'Naomi Brooks' }]);
      return registry(table);
    });
    const shown = row();
    const detail = await loadStewardFormReviewDetail(shown);
    expect(tables).toContain('member_form_cosigners');
    expect(detail.cosigners).toEqual([{ id: 'cosigner-1', name: 'Naomi Brooks' }]);
    expect(detail.expectation).toEqual({ answers: shown.answers, attachmentIds: ['file-1'], cosignerIds: ['cosigner-1'] });
    expect(stewardFormApprovalBlock(detail)).toBeNull();
  });

  it('records a sealed review by the stored version its opened answers came from, never the answers (#8728)', async () => {
    backend.sensitive.mockResolvedValue({ data: [{ id: 'f1', answers: { condition_type: 'continuous' }, dataVersion: 'v9' }], error: null });
    const detail = await loadStewardFormReviewDetail(row({ template_key: 'fmla_self', answers: { sealed: true } }));
    expect(detail.answersUnavailable).toBe(false);
    expect(detail.expectation).toEqual({ dataVersion: 'v9', attachmentIds: ['file-1'], cosignerIds: [] });
  });

  it('keeps approval off when the co-signers cannot be read, never naming none (#8728)', async () => {
    const registry = backend.from.getMockImplementation()!;
    backend.from.mockImplementation((table: string) => (
      table === 'member_form_cosigners' ? query(null, { message: 'permission denied' }) : registry(table)
    ));
    const detail = await loadStewardFormReviewDetail(row());
    expect(detail.cosignersUnavailable).toBe(true);
    expect(detail.expectation).toBeNull();
    expect(stewardFormApprovalBlock(detail)).toBe('The co-signers could not be read right now, so this form cannot be approved.');
  });

  it('does not offer a decision until the submitted form has loaded, and refuses the filer\'s own form', () => {
    const screen = readFileSync(new URL('../features/StewardDeskSectionsScreen.tsx', import.meta.url), 'utf8');
    const review = screen.slice(screen.indexOf('function FormReview'), screen.indexOf('function BroadcastsSection'));
    const loading = review.indexOf('title="Loading the submitted form"');
    const approve = review.indexOf('label="Approve"');
    expect(loading).toBeGreaterThan(-1);
    expect(approve).toBeGreaterThan(loading);
    expect(review).toContain('disabled={disabled || busy !== null || approvalBlock !== null}');
    expect(review).toContain('This form is yours. Another committee member reviews it.');
    expect(review.slice(0, loading)).not.toContain('label="Approve"');
    const ownAt = review.indexOf('{own ?');
    const decideAt = review.indexOf('label="Start review"');
    expect(ownAt).toBeGreaterThan(loading);
    expect(decideAt).toBeGreaterThan(ownAt);
    expect(review.slice(ownAt, decideAt)).toContain('This form is yours. Another committee member reviews it.');
    expect(review.slice(ownAt, decideAt)).not.toContain('label="Approve"');
  });
});
