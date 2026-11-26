import { beforeEach, describe, expect, it, vi } from 'vitest';

// BUG-UG-NATIVE-SEVEN-FEATURE-KEYS-OPEN-ONLY-THE-GENERIC-SCREEN-20261113
// (#8630) and REQ-UG-NATIVE-FORMS-FULL-PARITY-WITH-THE-WEBSITE-20261113
// (#8699, an owner decision): the
// phone saves ordinary forms through save_form_draft and sealed FMLA forms
// through the web's sensitive-content transport, signs through
// sign_member_form and submits through submit_form. The co-signed grievance
// stays on the website until the second part of #8699.
type Call = [string, ...unknown[]];
const calls: Call[] = [];
let answer: { data: unknown; error: unknown } = { data: [], error: null };
// Registry pages answered in turn by range(); empty means `answer`.
let pages: { data: unknown; error: unknown }[] = [];
const backend = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), auth: { getSession: vi.fn() }, pinned: vi.fn() }));
const sealed = vi.hoisted(() => ({ rpc: vi.fn(), origin: vi.fn() }));
// The captured-session client answers through the same backend, and records
// whose session it was pinned to.
vi.mock('./supabase', () => ({ getSupabaseClient: () => backend, createCapturedSessionRpcClient: (pinned: { user: { id: string } }) => { backend.pinned(pinned.user.id); return backend; } }));
vi.mock('../../../../src/lib/sensitiveContentApi.js', () => ({ sensitiveContentRpc: sealed.rpc }));
vi.mock('./privateFileAccess', () => ({ privateFileApiOrigin: sealed.origin }));

import {
  FormActionError,
  cleanFormAnswers,
  formIsEditable,
  formTemplateForNewStart,
  formTemplateFromRow,
  loadFormTemplates,
  loadMyForms,
  loadMyOpenFormDraft,
  missingRequiredFields,
  myFormWasFiled,
  openFormAnswers,
  readStoredFormAnswers,
  sameStoredAnswers,
  saveMyFormDraft,
  signMyForm,
  startableFormTemplates,
  submitMyForm,
  templateForForm,
  unsavedAnswerFields,
  type FormTemplate,
  type MemberForm,
} from './memberForms';

const session = (userID: string) => ({ data: { session: { access_token: `token-${userID}`, user: { id: userID } } } });
const lane = (fields: { formID?: string | null; dataVersion?: string | null; unconfirmed?: Record<string, string>[]; onFormID?: (id: string) => void } = {}) => ({ ownerID: 'user-1', formID: null, dataVersion: null, ...fields });

beforeEach(() => {
  calls.length = 0;
  answer = { data: [], error: null };
  pages = [];
  backend.from.mockImplementation((table: string) => {
    calls.push(['from', table]);
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'order']) query[method] = (...args: unknown[]) => { calls.push([method, ...args]); return query; };
    query.limit = async (...args: unknown[]) => { calls.push(['limit', ...args]); return answer; };
    query.range = async (...args: unknown[]) => { calls.push(['range', ...args]); return pages.length ? pages.shift() : answer; };
    return query;
  });
  backend.rpc.mockImplementation(async (name: string, args: unknown) => { calls.push(['rpc', name, args]); return answer; });
  backend.auth.getSession.mockResolvedValue(session('user-1'));
  sealed.origin.mockReset();
  sealed.origin.mockReturnValue('https://sample.unionground.example');
  sealed.rpc.mockReset();
  backend.pinned.mockReset();
});

const schema = {
  steps: [
    { title: { en: 'What happened', es: 'Qué pasó' }, fields: [
      { key: 'summary', type: 'textarea', label: { en: 'Summary', es: 'Resumen' }, required: true, maxLength: 20 },
      { key: 'date', type: 'date', label: 'Date', required: true },
      { key: 'category', type: 'select', label: 'Category', required: true, options: [{ value: 'pay', label: 'Pay' }, { value: 'dues', label: 'Dues' }] },
      { key: 'witnesses', type: 'multiselect', label: 'Witnesses', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      { key: 'agree', type: 'checkbox', label: 'I agree', required: true },
      { key: 'hours', type: 'number', label: 'Hours' },
      { key: 'upload', type: 'file', label: 'Not a field the phone draws' },
    ] },
  ],
};
const row = { key: 'service_request', version: 2, label_en: 'Service request', label_es: 'Solicitud', blurb_en: 'Ask for help.', active: true, available_to_start: true, organization_id: null, is_platform_seed: true, field_schema: schema };
const template = formTemplateFromRow(row) as FormTemplate;

// Part 2 of #8699: nothing stays on the website. The co-signed grievance is
// edited and saved on the phone like any ordinary form.
describe('every form on the phone', () => {
  it('edits every draft or returned form, the co-signed grievance included', () => {
    expect(formIsEditable({ status: 'draft', templateKey: 'fmla_self' })).toBe(true);
    expect(formIsEditable({ status: 'returned', templateKey: 'fmla_family' })).toBe(true);
    expect(formIsEditable({ status: 'draft', templateKey: 'alliance_grievance' })).toBe(true);
    expect(formIsEditable({ status: 'submitted', templateKey: 'grievance' })).toBe(false);
  });

  it('saves the co-signed grievance through save_form_draft', async () => {
    answer = { data: 'form-a', error: null };
    expect(await saveMyFormDraft({ ...template, key: 'alliance_grievance' }, { summary: 'Short' }, 0, lane())).toEqual({ formID: 'form-a', dataVersion: null, answers: { summary: 'Short' } });
    expect(calls).toEqual([['rpc', 'save_form_draft', { p_template_key: 'alliance_grievance', p_answers: { summary: 'Short' }, p_step: 0 }]]);
    expect(sealed.rpc).not.toHaveBeenCalled();
  });
});

const fmla = { ...template, key: 'fmla_self' };
const sealedForm = (fields: Partial<MemberForm> = {}): MemberForm => ({
  id: '11111111-1111-4111-8111-111111111111', templateKey: 'fmla_self', templateVersion: 1, status: 'draft', answers: {}, step: 0, reviewNote: '',
  updatedAt: '', signed: false, signatureCurrent: false, sealedMarker: true, sealedPlaintext: false, storedAnswers: {}, ...fields,
});

describe('sealed FMLA answers', () => {
  it('saves through prepare_sealed_form then save_sealed_form_draft, never save_form_draft, naming the form and the data version', async () => {
    sealed.rpc.mockImplementation(async (_client: unknown, operation: string) => (operation === 'prepare_sealed_form'
      ? { data: { formId: 'form-9' }, error: null }
      : { data: { formId: 'form-9', dataVersion: 'v-2' }, error: null }));
    const seen: string[] = [];
    const saved = await saveMyFormDraft(fmla, { summary: 'Leave in March', hours: 'x' }, 1, lane({ onFormID: (id) => { seen.push(id); } }));
    expect(saved).toEqual({ formID: 'form-9', dataVersion: 'v-2', answers: { summary: 'Leave in March' } });
    expect(seen).toEqual(['form-9']);
    expect(sealed.rpc.mock.calls).toEqual([
      [backend, 'prepare_sealed_form', { templateKey: 'fmla_self' }, 'https://sample.unionground.example', 'token-user-1'],
      [backend, 'save_sealed_form_draft', { templateKey: 'fmla_self', answers: { summary: 'Leave in March' }, step: 1, expectedDataVersion: null, formId: 'form-9' }, 'https://sample.unionground.example', 'token-user-1'],
    ]);
    expect(calls).toEqual([]);
  });

  it('names the known form and its data version on a later save, without preparing again', async () => {
    sealed.rpc.mockResolvedValue({ data: { formId: 'form-9', dataVersion: 'v-3' }, error: null });
    expect(await saveMyFormDraft(fmla, { summary: 'Changed' }, 0, lane({ formID: 'form-9', dataVersion: 'v-2' }))).toMatchObject({ formID: 'form-9', dataVersion: 'v-3' });
    expect(sealed.rpc.mock.calls.map((call) => call[1])).toEqual(['save_sealed_form_draft']);
    expect(sealed.rpc.mock.calls[0]?.[2]).toMatchObject({ expectedDataVersion: 'v-2', formId: 'form-9' });
  });

  it('drops the answers when the signed-in worker changes during the save', async () => {
    sealed.rpc.mockResolvedValue({ data: { formId: 'form-9' }, error: null });
    backend.auth.getSession.mockResolvedValueOnce(session('user-1')).mockResolvedValue(session('user-2'));
    await expect(saveMyFormDraft(fmla, { summary: 'Private' }, 0, lane())).rejects.toMatchObject({ reason: 'session-changed' });
    expect(sealed.rpc.mock.calls.map((call) => call[1])).toEqual([]);
  });

  // Gate stage 136 on #8700 (r1): the session is captured before the portal
  // origin is resolved, so a switch from member A to member B during that wait
  // prepares and saves nothing, rather than B's token carrying A's answers into
  // a form prepared for B.
  it('prepares and saves nothing when the worker changes while the portal origin resolves', async () => {
    sealed.rpc.mockResolvedValue({ data: { formId: 'form-b', dataVersion: 'v-1' }, error: null });
    sealed.origin.mockImplementation(() => {
      backend.auth.getSession.mockResolvedValue(session('user-2'));
      return 'https://sample.unionground.example';
    });
    await expect(saveMyFormDraft(fmla, { summary: 'Answers from worker A' }, 0, lane())).rejects.toMatchObject({ reason: 'session-changed' });
    expect(sealed.rpc).not.toHaveBeenCalled();
  });

  it('prepares and saves nothing for an editor whose worker is no longer signed in', async () => {
    backend.auth.getSession.mockResolvedValue(session('user-2'));
    sealed.rpc.mockResolvedValue({ data: { formId: 'form-b', dataVersion: 'v-1' }, error: null });
    await expect(saveMyFormDraft(fmla, { summary: 'Answers from worker A' }, 0, lane())).rejects.toMatchObject({ reason: 'session-changed' });
    await expect(saveMyFormDraft(template, { summary: 'Answers from worker A' }, 0, lane())).rejects.toMatchObject({ reason: 'session-changed' });
    expect(sealed.rpc).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('opens nothing when the worker changes while the portal origin resolves', async () => {
    sealed.origin.mockImplementation(() => {
      backend.auth.getSession.mockResolvedValue(session('user-2'));
      return 'https://sample.unionground.example';
    });
    await expect(openFormAnswers(sealedForm(), 'user-1')).rejects.toMatchObject({ reason: 'session-changed' });
    expect(sealed.rpc).not.toHaveBeenCalled();
  });

  it('refuses a save the server refused, or one for a different form, and sends nothing from a build whose backend and portal do not pair', async () => {
    sealed.rpc.mockResolvedValue({ data: null, error: { code: 'SENSITIVE_DATA_UNAVAILABLE' } });
    await expect(saveMyFormDraft(fmla, {}, 0, lane({ formID: 'form-9', dataVersion: 'v-2' }))).rejects.toMatchObject({ reason: 'failed' });
    sealed.rpc.mockResolvedValue({ data: { formId: 'form-other', dataVersion: 'v-3' }, error: null });
    await expect(saveMyFormDraft(fmla, {}, 0, lane({ formID: 'form-9', dataVersion: 'v-2' }))).rejects.toMatchObject({ reason: 'failed' });
    sealed.rpc.mockClear();
    sealed.origin.mockImplementation(() => { throw new Error('unavailable'); });
    await expect(saveMyFormDraft(fmla, {}, 0, lane({ formID: 'form-9', dataVersion: 'v-2' }))).rejects.toMatchObject({ reason: 'failed' });
    await expect(openFormAnswers(sealedForm(), 'user-1')).rejects.toMatchObject({ reason: 'unavailable' });
    expect(sealed.rpc).not.toHaveBeenCalled();
  });

  // Gate stage 136 on #8700 (r1s3): a reply lost after the save committed
  // does not leave the editor retrying a version the server has moved past.
  it('adopts the stored version after a lost save reply only when the stored answers are exactly the ones sent', async () => {
    sealed.rpc.mockImplementation(async (_client: unknown, operation: string) => (operation === 'save_sealed_form_draft'
      ? { data: null, error: { code: 'SENSITIVE_DATA_UNAVAILABLE' } }
      : { data: [{ id: 'form-9', answers: { summary: 'Leave in March' }, dataVersion: 'v-3' }], error: null }));
    answer = { data: [{ status: 'draft' }], error: null };
    expect(await saveMyFormDraft(fmla, { summary: 'Leave in March' }, 0, lane({ formID: 'form-9', dataVersion: 'v-2' }))).toMatchObject({ formID: 'form-9', dataVersion: 'v-3' });
    expect(sealed.rpc.mock.calls.map((call) => [call[1], call[4]])).toEqual([['save_sealed_form_draft', 'token-user-1'], ['get_sealed_forms', 'token-user-1']]);
    // Different stored answers on a newer version were saved elsewhere: a
    // changed form, never adopted (the #8700 device run ruling).
    await expect(saveMyFormDraft(fmla, { summary: 'Leave in April' }, 0, lane({ formID: 'form-9', dataVersion: 'v-2' }))).rejects.toMatchObject({ reason: 'form-changed' });
    // A read-back that fails stays a failure, which carries the answers sent
    // so the next save can recognise them (r3s3).
    sealed.rpc.mockImplementation(async () => ({ data: null, error: { code: 'SENSITIVE_DATA_UNAVAILABLE' } }));
    await expect(saveMyFormDraft(fmla, { summary: 'Leave in April' }, 0, lane({ formID: 'form-9', dataVersion: 'v-2' }))).rejects.toMatchObject({ reason: 'failed', sent: { summary: 'Leave in April' } });
    sealed.rpc.mockImplementation(async (_client: unknown, operation: string) => (operation === 'save_sealed_form_draft'
      ? { data: null, error: { code: 'SENSITIVE_DATA_UNAVAILABLE' } }
      : { data: [{ id: 'form-9', answers: { summary: 'Leave in March' }, dataVersion: 'v-3' }], error: null }));
    // The same answers on a form already submitted are not a save (r3s1).
    answer = { data: [{ status: 'submitted' }], error: null };
    await expect(saveMyFormDraft(fmla, { summary: 'Leave in March' }, 0, lane({ formID: 'form-9', dataVersion: 'v-2' }))).rejects.toMatchObject({ reason: 'closed' });
  });

  // Gate stage 138 on #8700 (r3s3): answers stored by a save whose reply and
  // read-back were both lost are recognised before newer answers are sent.
  // Gate stage 146 on #8700 (r7s1): an empty draft prepared but never given
  // answers has no envelope, so a read of it returns a null version; that is a
  // successful read, and the newer answers are sent against it.
  // #8700 device run, ruled for #8699 part 2: a sealed save refused because
  // another session saved a newer version is a changed form, never a
  // connection failure.
  it('reports a sealed save refused over a newer version from another session as a changed form', async () => {
    const storedAs = (answers: Record<string, string>, dataVersion: string | null) => {
      sealed.rpc.mockReset();
      sealed.rpc.mockImplementation(async (_client: unknown, operation: string) => (operation === 'save_sealed_form_draft'
        ? { data: null, error: { code: 'SENSITIVE_DATA_UNAVAILABLE' } }
        : { data: [{ id: 'form-9', answers, dataVersion }], error: null }));
    };
    storedAs({ summary: 'Leave until February 12' }, 'v-5');
    answer = { data: [{ status: 'draft' }], error: null };
    await expect(saveMyFormDraft(fmla, { summary: 'Leave until January 29' }, 0, lane({ formID: 'form-9', dataVersion: 'v-4' }))).rejects.toMatchObject({ reason: 'form-changed', sent: null });
    // The same version as the one named: the save itself failed.
    storedAs({ summary: 'Leave until February 12' }, 'v-4');
    await expect(saveMyFormDraft(fmla, { summary: 'Leave until January 29' }, 0, lane({ formID: 'form-9', dataVersion: 'v-4' }))).rejects.toMatchObject({ reason: 'failed' });
    // A newer version holding an earlier save of this editor's is its own.
    storedAs({ summary: 'Leave until January 15' }, 'v-5');
    await expect(saveMyFormDraft(fmla, { summary: 'Leave until January 29' }, 0, lane({ formID: 'form-9', dataVersion: 'v-4', unconfirmed: [{ summary: 'Leave until January 15' }] }))).rejects.toMatchObject({ reason: 'failed' });
    // Moved on and filed elsewhere.
    storedAs({ summary: 'Leave until February 12' }, 'v-5');
    answer = { data: [{ status: 'submitted' }], error: null };
    await expect(saveMyFormDraft(fmla, { summary: 'Leave until January 29' }, 0, lane({ formID: 'form-9', dataVersion: 'v-4' }))).rejects.toMatchObject({ reason: 'closed' });
  });

  it('recovers against an empty sealed draft whose version is still null', async () => {
    sealed.rpc.mockImplementation(async (_client: unknown, operation: string) => (operation === 'save_sealed_form_draft'
      ? { data: { formId: 'form-9', dataVersion: 'v-1' }, error: null }
      : { data: [{ id: 'form-9', answers: {}, dataVersion: null }], error: null }));
    expect(await saveMyFormDraft(fmla, { summary: 'Leave in March' }, 0, lane({ formID: 'form-9', dataVersion: null, unconfirmed: [{}] })))
      .toMatchObject({ formID: 'form-9', dataVersion: 'v-1' });
    expect(sealed.rpc.mock.calls.map((call) => call[1])).toEqual(['get_sealed_forms', 'save_sealed_form_draft']);
    expect(sealed.rpc.mock.calls[1]?.[2]).toMatchObject({ expectedDataVersion: null, formId: 'form-9' });
  });

  it('names the version of an unanswered save it recognises, and keeps its baseline otherwise', async () => {
    sealed.rpc.mockImplementation(async (_client: unknown, operation: string, args: { expectedDataVersion?: string }) => (operation === 'save_sealed_form_draft'
      ? { data: { formId: 'form-9', dataVersion: `after-${args.expectedDataVersion}` }, error: null }
      : { data: [{ id: 'form-9', answers: { summary: 'Leave in March' }, dataVersion: 'v-2' }], error: null }));
    expect(await saveMyFormDraft(fmla, { summary: 'Leave in March and April' }, 0, lane({ formID: 'form-9', dataVersion: 'v-1', unconfirmed: [{ summary: 'Leave in March' }] })))
      .toMatchObject({ formID: 'form-9', dataVersion: 'after-v-2' });
    expect(sealed.rpc.mock.calls.map((call) => call[1])).toEqual(['get_sealed_forms', 'save_sealed_form_draft']);
    // A save that fails after recognising one still hands its version back
    // as the baseline (gate stage 139 on #8700, r6s2).
    sealed.rpc.mockImplementation(async (_client: unknown, operation: string) => (operation === 'save_sealed_form_draft'
      ? { data: null, error: { code: 'SENSITIVE_DATA_UNAVAILABLE' } }
      : { data: [{ id: 'form-9', answers: { summary: 'Leave in March' }, dataVersion: 'v-2' }], error: null }));
    await expect(saveMyFormDraft(fmla, { summary: 'Leave in May' }, 0, lane({ formID: 'form-9', dataVersion: 'v-1', unconfirmed: [{ summary: 'Leave in March' }] })))
      .rejects.toMatchObject({ reason: 'failed', sent: { summary: 'Leave in May' }, baseline: 'v-2' });
    sealed.rpc.mockImplementation(async (_client: unknown, operation: string, args: { expectedDataVersion?: string }) => (operation === 'save_sealed_form_draft'
      ? { data: { formId: 'form-9', dataVersion: `after-${args.expectedDataVersion}` }, error: null }
      : { data: [{ id: 'form-9', answers: { summary: 'Leave in March' }, dataVersion: 'v-2' }], error: null }));
    // Stored answers the editor never sent keep its baseline; the server refuses.
    expect(await saveMyFormDraft(fmla, { summary: 'Leave in May' }, 0, lane({ formID: 'form-9', dataVersion: 'v-1', unconfirmed: [{ summary: 'Leave in June' }] })))
      .toMatchObject({ formID: 'form-9', dataVersion: 'after-v-1' });
    // A read-back that fails sends nothing newer.
    sealed.rpc.mockReset();
    sealed.rpc.mockResolvedValue({ data: null, error: { code: 'SENSITIVE_DATA_UNAVAILABLE' } });
    await expect(saveMyFormDraft(fmla, { summary: 'Leave in May' }, 0, lane({ formID: 'form-9', dataVersion: 'v-1', unconfirmed: [{ summary: 'Leave in June' }] }))).rejects.toMatchObject({ reason: 'failed', sent: null });
    expect(sealed.rpc.mock.calls.map((call) => call[1])).toEqual(['get_sealed_forms']);
  });

  it('opens sealed answers and their data version through get_sealed_forms', async () => {
    sealed.rpc.mockResolvedValue({ data: [{ id: sealedForm().id, answers: { summary: 'Leave in March' }, dataVersion: 'v-2' }], error: null });
    expect(await openFormAnswers(sealedForm(), 'user-1')).toEqual({ answers: { summary: 'Leave in March' }, dataVersion: 'v-2' });
    expect(sealed.rpc).toHaveBeenCalledWith(backend, 'get_sealed_forms', { formIds: [sealedForm().id] }, 'https://sample.unionground.example', 'token-user-1');
  });

  it('never opens a sealed form whose answers cannot be read, or that still holds plaintext, as empty', async () => {
    sealed.rpc.mockResolvedValue({ data: [{ id: sealedForm().id, answers: {}, contentError: 'sensitive-content-unavailable' }], error: null });
    await expect(openFormAnswers(sealedForm(), 'user-1')).rejects.toMatchObject({ reason: 'unavailable' });
    sealed.rpc.mockResolvedValue({ data: null, error: { code: 'SENSITIVE_DATA_UNAVAILABLE' } });
    await expect(openFormAnswers(sealedForm(), 'user-1')).rejects.toMatchObject({ reason: 'unavailable' });
    sealed.rpc.mockClear();
    await expect(openFormAnswers(sealedForm({ sealedMarker: false, sealedPlaintext: true }), 'user-1')).rejects.toMatchObject({ reason: 'unavailable' });
    expect(sealed.rpc).not.toHaveBeenCalled();
    // A sealed draft with no envelope yet opens empty, with no baseline.
    expect(await openFormAnswers(sealedForm({ sealedMarker: false }), 'user-1')).toEqual({ answers: {}, dataVersion: null });
  });
});

describe('signing and submitting', () => {
  const strokes = [[{ x: 10, y: 20 }, { x: 30, y: 40 }]];

  const review = (fields: Partial<{ formID: string; dataVersion: string | null; answers: Record<string, string> }> = {}, attachmentIDs: string[] = []) => ({
    saved: { formID: 'form-1', dataVersion: null, answers: { summary: 'Short' }, ...fields }, attachmentIDs,
  });

  it('signs through sign_member_form with consent, server-shaped strokes and what the worker reviewed', async () => {
    answer = { data: { formId: 'form-1' }, error: null };
    await signMyForm('service_request', strokes, true, 'user-1', review({}, ['file-1']));
    // An ordinary form names its exact saved answers and the attachment ids
    // shown (#8702).
    expect(calls).toEqual([['rpc', 'sign_member_form', { p_form_id: 'form-1', p_strokes: strokes, p_consent: true, p_expected: { attachmentIds: ['file-1'], answers: { summary: 'Short' } } }]]);
    expect(backend.pinned).toHaveBeenCalledWith('user-1');
    calls.length = 0;
    // A sealed form names the data version its checked save returned, never
    // its answers.
    await signMyForm('fmla_self', strokes, true, 'user-1', review({ dataVersion: 'v-3' }));
    expect(calls).toEqual([['rpc', 'sign_member_form', { p_form_id: 'form-1', p_strokes: strokes, p_consent: true, p_expected: { attachmentIds: [], dataVersion: 'v-3' } }]]);
    calls.length = 0;
    await expect(signMyForm('service_request', strokes, false, 'user-1', review())).rejects.toMatchObject({ reason: 'signature-required' });
    await expect(signMyForm('service_request', [[{ x: 10, y: 20 }]], true, 'user-1', review())).rejects.toMatchObject({ reason: 'signature-required' });
    await expect(signMyForm('service_request', [[{ x: 10.5, y: 20 }, { x: 30, y: 40 }]], true, 'user-1', review())).rejects.toMatchObject({ reason: 'signature-required' });
    // Another member signed in: nothing is signed.
    backend.auth.getSession.mockResolvedValue(session('user-2'));
    await expect(signMyForm('service_request', strokes, true, 'user-1', review())).rejects.toMatchObject({ reason: 'session-changed' });
    expect(calls).toEqual([]);
    backend.auth.getSession.mockResolvedValue(session('user-1'));
    answer = { data: null, error: { message: 'form not found or not signable' } };
    await expect(signMyForm('service_request', strokes, true, 'user-1', review())).rejects.toMatchObject({ reason: 'failed' });
    // The server found the form changed since the review and signed nothing.
    answer = { data: null, error: { code: 'PT409', message: 'form changed since review', details: 'form_changed_since_review' } };
    await expect(signMyForm('service_request', strokes, true, 'user-1', review())).rejects.toMatchObject({ reason: 'form-changed' });
  });

  it('submits through submit_form naming what the worker reviewed, and words the server’s refusals', async () => {
    answer = { data: { id: 'form-1', status: 'submitted' }, error: null };
    await submitMyForm('service_request', 'user-1', review());
    // The same reviewed content the signature names (#8705).
    expect(calls).toEqual([['rpc', 'submit_form', { p_form_id: 'form-1', p_expected: { attachmentIds: [], answers: { summary: 'Short' } } }]]);
    expect(backend.pinned).toHaveBeenCalledWith('user-1');
    calls.length = 0;
    await submitMyForm('fmla_self', 'user-1', review({ dataVersion: 'v-3' }));
    expect(calls).toEqual([['rpc', 'submit_form', { p_form_id: 'form-1', p_expected: { attachmentIds: [], dataVersion: 'v-3' } }]]);
    calls.length = 0;
    backend.auth.getSession.mockResolvedValue(session('user-2'));
    await expect(submitMyForm('service_request', 'user-1', review())).rejects.toMatchObject({ reason: 'session-changed' });
    expect(calls).toEqual([]);
    backend.auth.getSession.mockResolvedValue(session('user-1'));
    answer = { data: null, error: { message: 'draw and save a current signature before submitting' } };
    await expect(submitMyForm('service_request', 'user-1', review())).rejects.toMatchObject({ reason: 'signature-required' });
    answer = { data: null, error: { message: 'wait for every attachment inspection to finish' } };
    await expect(submitMyForm('service_request', 'user-1', review())).rejects.toMatchObject({ reason: 'attachments-pending' });
    answer = { data: null, error: { message: 'form not submittable' } };
    await expect(submitMyForm('service_request', 'user-1', review())).rejects.toMatchObject({ reason: 'failed' });
    // Changed since the review, even signed again elsewhere: nothing is filed.
    answer = { data: null, error: { code: 'PT409', message: 'form changed since review', details: 'form_changed_since_review' } };
    await expect(submitMyForm('service_request', 'user-1', review())).rejects.toMatchObject({ reason: 'form-changed' });
  });
});

describe('templates', () => {
  it('reads the registry the web reads and keeps only fields the phone can draw', async () => {
    answer = { data: [row], error: null };
    const templates = await loadFormTemplates();
    expect(calls).toContainEqual(['from', 'form_template_registry']);
    expect(templates[0]?.steps[0]?.fields.map((field) => field.key)).toEqual(['summary', 'date', 'category', 'witnesses', 'agree', 'hours']);
  });

  it('reads Spanish labels with an English fallback', () => {
    const spanish = formTemplateFromRow(row, true) as FormTemplate;
    expect(spanish.label).toBe('Solicitud');
    expect(spanish.blurb).toBe('Ask for help.');
    expect(spanish.steps[0]?.title).toBe('Qué pasó');
    expect(spanish.steps[0]?.fields[0]?.label).toBe('Resumen');
  });

  // Gate stage 118 on #8668 (r1s3): only a new form drops the Dues choice; a
  // saved form keeps its pinned template whole, so a later save keeps its answer.
  it('drops the Dues choice only for a new form where the organization runs no dues', () => {
    expect(formTemplateForNewStart(template, false).steps[0]?.fields[2]?.options.map((option) => option.value)).toEqual(['pay']);
    expect(formTemplateForNewStart(template, null)).toBe(template);
    expect(template.steps[0]?.fields[2]?.options.map((option) => option.value)).toEqual(['pay', 'dues']);
    expect(cleanFormAnswers(template, { category: 'dues', summary: 'Changed only the summary' })).toEqual({ category: 'dues', summary: 'Changed only the sum' });
  });

  // Gate stage 118 on #8668 (r1s5): the registry is read a page at a time until a short page.
  it('reads every registry page, and fails rather than show a partial list', async () => {
    pages = [{ data: Array.from({ length: 500 }, (_, index) => ({ ...row, version: index + 1 })), error: null }, { data: [{ ...row, version: 501 }], error: null }];
    const templates = await loadFormTemplates();
    expect(templates).toHaveLength(501);
    expect(calls.filter(([method]) => method === 'range')).toEqual([['range', 0, 499], ['range', 500, 999]]);
    pages = [{ data: Array.from({ length: 500 }, () => row), error: null }, { data: null, error: { message: 'timeout' } }];
    await expect(loadFormTemplates()).rejects.toBeTruthy();
  });

  it('starts the organization’s own copy above a platform seed, then the newest version, among startable rows', () => {
    const seed1 = formTemplateFromRow({ ...row, version: 1 }) as FormTemplate;
    const seed3 = formTemplateFromRow({ ...row, version: 3 }) as FormTemplate;
    const own1 = formTemplateFromRow({ ...row, version: 1, is_platform_seed: false, organization_id: 'org-1' }) as FormTemplate;
    const closed = formTemplateFromRow({ ...row, key: 'old_form', available_to_start: false }) as FormTemplate;
    expect(startableFormTemplates([seed1, seed3, own1, closed])).toEqual([own1]);
    expect(startableFormTemplates([seed1, seed3])).toEqual([seed3]);
    // Gate stage 118 on #8668 (r1s4): precedence first, then the active check,
    // so an organization that turned its own copy off does not revive the seed.
    const ownOff = formTemplateFromRow({ ...row, version: 1, is_platform_seed: false, organization_id: 'org-1', active: false }) as FormTemplate;
    expect(startableFormTemplates([seed1, seed3, ownOff])).toEqual([]);
    expect(templateForForm([seed1, seed3], { templateKey: 'service_request', templateVersion: 1 })).toBe(seed1);
    expect(templateForForm([seed3], { templateKey: 'service_request', templateVersion: 1 })).toBeNull();
  });
});

describe('answers', () => {
  it('names the required answers still missing', () => {
    expect(missingRequiredFields(template, {})).toEqual(['Summary', 'Date', 'Category', 'I agree']);
    expect(missingRequiredFields(template, { summary: 'Short shift', date: '2026-11-13', category: 'pay', agree: true })).toEqual([]);
    // Gate stage 136 on #8700 (r1s2): an explicit No is an answer, as on the web and in submit_form.
    expect(missingRequiredFields(template, { summary: 'Short shift', date: '2026-11-13', category: 'pay', agree: false })).toEqual([]);
  });

  it('names answers the save leaves out because they do not parse', () => {
    expect(unsavedAnswerFields(template, { summary: 'Short', date: '11/13/2026', hours: 'six', agree: false })).toEqual(['Date', 'Hours']);
    expect(unsavedAnswerFields(template, { summary: 'Short', date: '2026-11-13', hours: '6' })).toEqual([]);
  });

  it('saves answers in the web’s shapes, leaving out what does not parse', () => {
    expect(cleanFormAnswers(template, {
      summary: '  Overtime was not paid this week  ',
      date: '11/13/2026',
      category: 'not-an-option',
      witnesses: ['a', 'z'],
      agree: true,
      hours: 'six',
      stray: 'not on the form',
    })).toEqual({ summary: 'Overtime was not pai', witnesses: ['a'], agree: true });
    expect(cleanFormAnswers(template, { date: '2026-11-13', category: 'pay', hours: '6.5' })).toEqual({ date: '2026-11-13', category: 'pay', hours: '6.5' });
  });

  it('saves through save_form_draft with the cleaned answers and returns the draft id', async () => {
    answer = { data: 'form-1', error: null };
    expect(await saveMyFormDraft(template, { summary: 'Short', hours: 'x' }, 3, lane())).toEqual({ formID: 'form-1', dataVersion: null, answers: { summary: 'Short' } });
    expect(calls).toEqual([['rpc', 'save_form_draft', { p_template_key: 'service_request', p_answers: { summary: 'Short' }, p_step: 3 }]]);
    // The ordinary save is sent on the member's captured session.
    expect(backend.pinned).toHaveBeenCalledWith('user-1');
    expect(sealed.rpc).not.toHaveBeenCalled();
    answer = { data: null, error: { message: 'answers too large' } };
    await expect(saveMyFormDraft(template, {}, 0, lane())).rejects.toMatchObject({ reason: 'failed' });
  });

  // Gate stage 138 on #8700 (r3s1): an editor bound to a form never follows
  // it into another draft once it is submitted or replaced.
  // Gate stage 139 on #8700 (r5s1, #8702): an editor bound to a form names it,
  // and the server refuses under its lock, writing nothing, when that form is
  // no longer the member's editable one.
  it('names the bound form on every save and stops when the server says it is no longer editable', async () => {
    answer = { data: 'form-1', error: null };
    expect(await saveMyFormDraft(template, { summary: 'Short' }, 0, lane({ formID: 'form-1' }))).toEqual({ formID: 'form-1', dataVersion: null, answers: { summary: 'Short' } });
    expect(calls).toEqual([['rpc', 'save_form_draft', { p_template_key: 'service_request', p_answers: { summary: 'Short' }, p_step: 0, p_expected_form_id: 'form-1' }]]);
    answer = { data: null, error: { code: 'PT409', message: 'form no longer editable', details: 'form_not_editable' } };
    await expect(saveMyFormDraft(template, { summary: 'Short' }, 0, lane({ formID: 'form-1' }))).rejects.toMatchObject({ reason: 'closed' });
    // A save that still lands in another form is never adopted.
    answer = { data: 'form-2', error: null };
    await expect(saveMyFormDraft(template, { summary: 'Short' }, 0, lane({ formID: 'form-1' }))).rejects.toMatchObject({ reason: 'closed' });
  });

  it('reads back whether an unanswered submission was filed', async () => {
    answer = { data: [{ status: 'submitted' }], error: null };
    expect(await myFormWasFiled('form-1', 'user-1')).toBe(true);
    expect(calls).toContainEqual(['eq', 'id', 'form-1']);
    expect(calls).toContainEqual(['eq', 'user_id', 'user-1']);
    for (const read of [{ data: [{ status: 'draft' }], error: null }, { data: [], error: null }, { data: null, error: { message: 'offline' } }]) {
      answer = read;
      expect(await myFormWasFiled('form-1', 'user-1')).toBe(false);
    }
    backend.auth.getSession.mockResolvedValue(session('user-2'));
    await expect(myFormWasFiled('form-1', 'user-1')).rejects.toMatchObject({ reason: 'session-changed' });
  });

  it('saves for the chosen unit: save_unit_form_draft, and the sealed calls carry the unit as the web sends it (#7667)', async () => {
    const unit = { unitId: 'south', actorId: 'member-a', chapterId: 'chapter-a', organizationId: 'org-a' };
    answer = { data: 'form-2', error: null };
    expect(await saveMyFormDraft(template, { summary: 'Short' }, 1, { ...lane(), unit })).toEqual({ formID: 'form-2', dataVersion: null, answers: { summary: 'Short' } });
    expect(calls).toEqual([['rpc', 'save_unit_form_draft', { p_template_key: 'service_request', p_answers: { summary: 'Short' }, p_step: 1,
      p_unit: 'south', p_actor: 'member-a', p_chapter: 'chapter-a', p_organization: 'org-a' }]]);
    sealed.rpc.mockImplementation(async (_client: unknown, operation: string) => (operation === 'prepare_sealed_form'
      ? { data: { formId: 'form-9' }, error: null }
      : { data: { formId: 'form-9', dataVersion: 'v-2' }, error: null }));
    await saveMyFormDraft(fmla, { summary: 'Leave in March' }, 1, { ...lane(), unit });
    expect(sealed.rpc.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ['prepare_sealed_form', { templateKey: 'fmla_self', ...unit }],
      ['save_sealed_form_draft', { templateKey: 'fmla_self', answers: { summary: 'Leave in March' }, step: 1, expectedDataVersion: null, formId: 'form-9', ...unit }],
    ]);
  });
});

// BUG-UG-PHONE-FORM-SAVE-OVERWRITES-A-NEWER-EDIT-FROM-ANOTHER-SESSION-20261115
// (#8806): an ordinary save names the answers it was based on, as the website
// does (#8719), so a newer edit from another session refuses it.
describe('an ordinary save names its base', () => {
  const elsewhere = { data: null, error: { code: 'PT409', message: 'form changed elsewhere', details: 'form_saved_elsewhere' } };
  const missing = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
  const answering = (...answers: { data: unknown; error: unknown }[]) => {
    backend.rpc.mockImplementation(async (name: string, args: unknown) => { calls.push(['rpc', name, args]); return answers.shift() ?? answer; });
  };
  const rpcCalls = () => calls.filter((call) => call[0] === 'rpc') as [string, string, Record<string, unknown>][];

  it('sends the base on an ordinary and a unit save, {} for a new form', async () => {
    answer = { data: 'form-1', error: null };
    await saveMyFormDraft(template, { summary: 'New' }, 0, { ...lane(), baseAnswers: {} });
    const unit = { unitId: 'south', actorId: 'member-a', chapterId: 'chapter-a', organizationId: 'org-a' };
    await saveMyFormDraft(template, { summary: 'Newer' }, 0, { ...lane({ formID: 'form-1' }), unit, baseAnswers: { summary: 'New', hours: 6 } });
    expect(rpcCalls().map(([, name, args]) => [name, args.p_base_answers])).toEqual([
      ['save_form_draft', {}],
      ['save_unit_form_draft', { summary: 'New', hours: 6 }],
    ]);
  });

  it('says the form changed, and does not retry, when another session saved since', async () => {
    answering(elsewhere);
    await expect(saveMyFormDraft(template, { summary: 'Stale' }, 0, { ...lane({ formID: 'form-1' }), baseAnswers: { summary: 'Old' } }))
      .rejects.toMatchObject({ reason: 'form-changed' });
    expect(rpcCalls()).toHaveLength(1);
  });

  it('saves again on its own unanswered save when that is what is stored, and only then', async () => {
    answering(elsewhere, { data: 'form-1', error: null });
    answer = { data: [{ answers: { summary: 'Lost reply' } }], error: null };
    expect((await saveMyFormDraft(template, { summary: 'Next' }, 0, { ...lane({ formID: 'form-1', unconfirmed: [{ summary: 'Lost reply' }] }), baseAnswers: { summary: 'Old' } })).formID).toBe('form-1');
    expect(rpcCalls().map(([, , args]) => args.p_base_answers)).toEqual([{ summary: 'Old' }, { summary: 'Lost reply' }]);
    calls.length = 0;
    answering(elsewhere);
    answer = { data: [{ answers: { summary: 'Another device' } }], error: null };
    await expect(saveMyFormDraft(template, { summary: 'Next' }, 0, { ...lane({ formID: 'form-1', unconfirmed: [{ summary: 'Lost reply' }] }), baseAnswers: { summary: 'Old' } }))
      .rejects.toMatchObject({ reason: 'form-changed' });
    expect(rpcCalls()).toHaveLength(1);
  });

  // #8952 review G7-1, as #8309 rules for the website: a save is never resent
  // with fewer arguments, so a server without the base refuses it as unsaved
  // rather than taking the unbased overwrite the base exists to refuse.
  it('never resends a save without its base, whatever the refusal, and carries the answers of a save with no answer', async () => {
    for (const refusal of [missing, { data: null, error: { code: '42883', message: 'function private.unrelated_helper() does not exist' } }, { data: null, error: { status: 404, message: 'Not found' } }]) {
      calls.length = 0;
      answering(refusal);
      await expect(saveMyFormDraft(template, { summary: 'Short' }, 0, { ...lane({ formID: 'form-1' }), baseAnswers: {} })).rejects.toMatchObject({ reason: 'failed' });
      expect(rpcCalls()).toHaveLength(1);
      expect(rpcCalls()[0]?.[2]).toHaveProperty('p_base_answers');
    }
    answering({ data: null, error: { message: 'Failed to fetch' } });
    await expect(saveMyFormDraft(template, { summary: 'Short' }, 0, { ...lane({ formID: 'form-1' }), baseAnswers: {} }))
      .rejects.toMatchObject({ reason: 'failed', sent: { summary: 'Short' } });
  });
});

describe('the unit a form was made for (#7667)', () => {
  it('reads the unit stamp, and reads without it from a server that predates it', async () => {
    answer = { data: [{ id: 'f1', template_key: 'service_request', status: 'draft', answers: {}, settings_scope: { chapterId: 'c', unitId: 'north', unitName: 'North' } },
      { id: 'f2', template_key: 'service_request', status: 'draft', answers: {}, settings_scope: {} }], error: null };
    const [bound, unbound] = await loadMyForms('user-1');
    expect(bound?.boundUnit).toEqual({ unitId: 'north' });
    expect(unbound?.boundUnit).toBeUndefined();
    answer = { data: null, error: { code: '42703', message: 'column member_forms.settings_scope does not exist' } };
    calls.length = 0;
    // The stub answers every query alike, so the retry fails too; what matters
    // is that it was made, without the column.
    await expect(loadMyForms('user-1')).rejects.toBeTruthy();
    expect(calls.filter((call) => call[0] === 'select').map((call) => call[1])).toEqual([
      'id,template_key,template_version,status,answers,step,review_note,updated_at,filer_signed_at,filer_signature_digest,settings_scope',
      'id,template_key,template_version,status,answers,step,review_note,updated_at,filer_signed_at,filer_signature_digest',
    ]);
  });
});

describe('the worker’s own forms', () => {
  it('reads only the worker’s forms, bounded, and never shows a sealed form’s answers', async () => {
    answer = { data: [
      { id: 'f1', template_key: 'service_request', template_version: 2, status: 'returned', answers: { summary: 'Short', hours: 6, sealed: true }, step: 1, review_note: 'Add the date.', updated_at: '2026-11-13T15:00:00Z', filer_signed_at: null, filer_signature_digest: null },
      { id: 'f2', template_key: 'fmla_self', template_version: 1, status: 'draft', answers: { sealed: true, condition: 'private' }, step: 0, review_note: null, updated_at: '2026-11-12T15:00:00Z', filer_signed_at: '2026-11-12T16:00:00Z', filer_signature_digest: 'digest' },
      { id: 'f3', template_key: 'fmla_family', template_version: 1, status: 'draft', answers: { reason: 'plaintext before the backfill' }, step: 0, review_note: null, updated_at: '2026-11-11T15:00:00Z', filer_signed_at: null },
    ], error: null };
    const forms = await loadMyForms('user-1');
    expect(calls).toContainEqual(['eq', 'user_id', 'user-1']);
    expect(calls).toContainEqual(['select', 'id,template_key,template_version,status,answers,step,review_note,updated_at,filer_signed_at,filer_signature_digest,settings_scope']);
    // A plain field named "sealed" on an ordinary template is an answer (#6329).
    expect(forms[0]).toEqual({ id: 'f1', templateKey: 'service_request', templateVersion: 2, status: 'returned', answers: { summary: 'Short', hours: '6', sealed: true }, step: 1, reviewNote: 'Add the date.', updatedAt: '2026-11-13T15:00:00Z', signed: false, signatureCurrent: false, sealedMarker: false, sealedPlaintext: false,
      // The base an ordinary save names is the row as stored, the number included (#8806).
      storedAnswers: { summary: 'Short', hours: 6, sealed: true } });
    expect(forms[1]).toMatchObject({ storedAnswers: {}, answers: {}, signed: true, signatureCurrent: true, sealedMarker: true, sealedPlaintext: false });
    expect(forms[2]).toMatchObject({ answers: {}, sealedMarker: false, sealedPlaintext: true });
    expect(await loadMyForms('')).toEqual([]);
  });

  // Gate stage 118 on #8668 (r1s2): the open draft save_form_draft would write
  // into is found by template key, not only among the recent forms.
  it('finds the worker’s open draft of a template by key, newest first', async () => {
    answer = { data: [{ id: 'f9', template_key: 'grievance', template_version: 1, status: 'draft', answers: { summary: 'Older draft' }, step: 2, review_note: null, updated_at: '2026-01-02T15:00:00Z', filer_signed_at: null }], error: null };
    const draft = await loadMyOpenFormDraft('user-1', 'grievance');
    expect(calls).toContainEqual(['eq', 'user_id', 'user-1']);
    expect(calls).toContainEqual(['eq', 'template_key', 'grievance']);
    expect(calls).toContainEqual(['in', 'status', ['draft', 'returned']]);
    expect(calls).toContainEqual(['limit', 1]);
    expect(draft?.id).toBe('f9');
    expect(draft?.answers).toEqual({ summary: 'Older draft' });
    answer = { data: [], error: null };
    expect(await loadMyOpenFormDraft('user-1', 'grievance')).toBeNull();
  });
});

// Gate stage 138 on #8700 (r3s2, server fix #8702): a signature is read back
// against the answers stored now.
describe('reading a signed form back', () => {
  it('reads an ordinary form’s stored answers on the worker’s session, and a sealed one through get_sealed_forms', async () => {
    answer = { data: [{ answers: { summary: 'Short', hours: 6 } }], error: null };
    expect(await readStoredFormAnswers('service_request', 'form-1', 'user-1')).toEqual({ answers: { summary: 'Short', hours: '6' }, dataVersion: null, stored: { summary: 'Short', hours: 6 } });
    expect(calls).toContainEqual(['eq', 'id', 'form-1']);
    expect(calls).toContainEqual(['eq', 'user_id', 'user-1']);
    expect(backend.pinned).toHaveBeenCalledWith('user-1');
    answer = { data: [], error: null };
    await expect(readStoredFormAnswers('service_request', 'form-1', 'user-1')).rejects.toMatchObject({ reason: 'unavailable' });
    sealed.rpc.mockResolvedValue({ data: [{ id: 'form-9', answers: { summary: 'Leave in March' }, dataVersion: 'v-4' }], error: null });
    expect(await readStoredFormAnswers('fmla_self', 'form-9', 'user-1')).toEqual({ answers: { summary: 'Leave in March' }, dataVersion: 'v-4' });
    expect(sealed.rpc).toHaveBeenCalledWith(backend, 'get_sealed_forms', { formIds: ['form-9'] }, 'https://sample.unionground.example', 'token-user-1');
    sealed.rpc.mockResolvedValue({ data: [{ id: 'form-9', answers: {}, contentError: 'sensitive-content-unavailable' }], error: null });
    await expect(readStoredFormAnswers('fmla_self', 'form-9', 'user-1')).rejects.toMatchObject({ reason: 'unavailable' });
    backend.auth.getSession.mockResolvedValue(session('user-2'));
    await expect(readStoredFormAnswers('service_request', 'form-1', 'user-1')).rejects.toMatchObject({ reason: 'session-changed' });
  });

  it('compares answers as the save stores them, in any key order', () => {
    expect(sameStoredAnswers(template, { summary: 'Short', hours: 'x', stray: 'y' }, { summary: 'Short' })).toBe(true);
    expect(sameStoredAnswers(template, { category: 'pay', summary: 'Short' }, { summary: 'Short', category: 'pay' })).toBe(true);
    expect(sameStoredAnswers(template, { summary: 'Short' }, { summary: 'Shorter' })).toBe(false);
  });
});
