// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import palette from '../theme/palette.json';

// BUG-UG-NATIVE-SEVEN-FEATURE-KEYS-OPEN-ONLY-THE-GENERIC-SCREEN-20261113
//, gate stage 118 on: the live Forms screen on the shared
// stand-in. A Save that is still pending must not wipe answers typed after it
// started (r1s1), and Start must open the member's open draft of that
// template when the recent list does not show it, instead of an empty form
// that save_form_draft would write over it (r1s2).
const port = vi.hoisted(() => ({
  push: vi.fn(), templates: vi.fn(), forms: vi.fn(), openDraft: vi.fn(), save: vi.fn(), openAnswers: vi.fn(), sign: vi.fn(), submit: vi.fn(), filed: vi.fn(), stored: vi.fn(), files: vi.fn(), addFile: vi.fn(), pick: vi.fn(), cosigning: vi.fn(), respond: vi.fn(), withdraw: vi.fn(), invite: vi.fn(), filing: vi.fn(), openFile: vi.fn(), recheck: vi.fn(), removeFile: vi.fn(), unitLoad: vi.fn(),
  app: {} as Record<string, unknown>,
}));
// The survey card, the unit editors ( pull request D), the campaign draft and Be heard (pull request C) import the shared draft hook, whose attempt keys come from expo-crypto.
vi.mock('expo-crypto', () => ({ randomUUID: () => 'attempt-key' }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../components/ui', async () => {
  const ui = await import('../testing/uiStandIn');
  return { ...ui, StateMessage: ({ title, body, action }: { title: string; body?: string; action?: ReactNode }) => h('section', null, title, body, action) };
});
// One press on the pad draws a two-point stroke, the shape the server accepts.
vi.mock('../components/SignaturePad', async () => {
  const native = await import('../testing/reactNativeStandIn');
  return {
    SignaturePad: ({ label, onChange, disabled }: { label: string; onChange: (strokes: { x: number; y: number }[][]) => void; disabled?: boolean }) => h(native.Pressable, {
      accessibilityRole: 'button', accessibilityLabel: label, disabled, onPress: () => onChange([[{ x: 100, y: 100 }, { x: 300, y: 200 }]]),
    }),
  };
});
vi.mock('expo-router', () => ({ useRouter: () => ({ push: port.push }) }));
vi.mock('../services/formFiles', async (original) => ({
  ...(await original() as typeof import('../services/formFiles')),
  listFormFiles: port.files, addFormFile: port.addFile, shareFilingCopy: port.filing, openFormFile: port.openFile, recheckFormFile: port.recheck, removeFormFile: port.removeFile,
}));
vi.mock('../services/attachments', () => ({ pickAuthorizedDocument: port.pick }));
vi.mock('../services/formCosigners', async (original) => ({
  ...(await original() as typeof import('../services/formCosigners')),
  loadCosigning: port.cosigning, respondToCosign: port.respond, withdrawCosign: port.withdraw, inviteCosigner: port.invite,
}));
vi.mock('../services/privateFileAccess', () => ({ PrivateFileError: class extends Error {}, requestPrivateFileInspection: vi.fn(), downloadPrivateObjectToFile: vi.fn(), privateFileApiOrigin: () => 'https://sample.unionground.example' }));
vi.mock('../state/AppProvider', () => ({ useApp: () => port.app }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn() } }));
vi.mock('../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => vi.fn() }));
vi.mock('../lib/hatFunctions', () => ({ STAFF_HAT_FUNCTIONS: { steward: [] } }));
vi.mock('../services/supabase', () => ({ getSupabaseClient: () => ({}), readStepDeadlinePages: vi.fn() }));
vi.mock('../services/unitSettings', () => ({ loadNativeUnitSettings: port.unitLoad, loadNativeUnitEditor: vi.fn(),
  saveNativeUnitWorkload: vi.fn(), saveNativeUnitOverrides: vi.fn(), saveNativeChapterUnitSettings: vi.fn() }));
vi.mock('../services/memberForms', async (original) => ({
  ...(await original() as typeof import('../services/memberForms')),
  loadFormTemplates: port.templates, loadMyForms: port.forms, loadMyOpenFormDraft: port.openDraft, saveMyFormDraft: port.save,
  openFormAnswers: port.openAnswers, signMyForm: port.sign, submitMyForm: port.submit, myFormWasFiled: port.filed, readStoredFormAnswers: port.stored,
}));

import { FormActionError, formTemplateFromRow, type FormSaveLane, type FormTemplate } from '../services/memberForms';
import { LiveFormsScreen, type FormEdit, type FormOutcome } from './LiveFeatureScreens';
import { useKeptFormEditor, type KeptFormEditor } from './forms/keptFormEditor';
import { LiveCosignRequests } from './forms/LiveCosignRequests';
import { nativeUiText, type NativeLanguage } from '../lib/nativeUiCopy';
import { CosignChangedSincePreview, type CosignRequest } from '../services/formCosigners';

const grievance = formTemplateFromRow({
  key: 'grievance', version: 1, label_en: 'Grievance', active: true, available_to_start: true, is_platform_seed: true, organization_id: null,
  field_schema: { steps: [{ title: 'What happened', fields: [{ key: 'summary', type: 'text', label: 'Summary', required: true }] }] },
}) as FormTemplate;

const serviceRequest = formTemplateFromRow({
  key: 'service_request', version: 1, label_en: 'Service request', active: true, available_to_start: true, is_platform_seed: true, organization_id: null,
  field_schema: { steps: [{ title: 'Request', fields: [{ key: 'summary', type: 'text', label: 'Summary', required: true }] }] },
}) as FormTemplate;
const savedForm = (id: string, templateKey: string, summary: string) => ({ id, templateKey, templateVersion: 1, status: 'draft', answers: { summary }, step: 0, reviewNote: '', updatedAt: '2026-11-01T15:00:00Z', signed: false, signatureCurrent: false, sealedMarker: false, sealedPlaintext: false });
const saved = (formID: string, dataVersion: string | null = null) => ({ formID, dataVersion });

let screen: Rendered | null = null;
beforeEach(() => {
  vi.clearAllMocks();
  port.app = { memberLanguage: 'en', session: { user: { id: 'member-a' } }, dashboard: { member: { id: 'member-a', chapterID: 'chapter-a', language: 'en' } }, duesContext: null };
  port.templates.mockResolvedValue([grievance]);
  port.forms.mockResolvedValue([]);
  port.openDraft.mockResolvedValue(null);
  port.filed.mockResolvedValue(false);
  port.stored.mockRejectedValue(new FormActionError('unavailable'));
  port.files.mockResolvedValue([]);
  port.cosigning.mockResolvedValue({ cosigners: {}, requests: [] });
  port.unitLoad.mockResolvedValue({ actorId: '', chapterId: '', organizationId: '', units: [], unitId: null, needsChoice: false, effective: null, canManage: false, legacy: true });
});
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); });

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe.each(['ios', 'android'] as const)('live Forms on %s', (os) => {
  it('keeps answers typed while a Save is pending, and keeps the editor open', async () => {
    setPlatform(os);
    let finish: (result: { formID: string; dataVersion: string | null }) => void = () => {};
    port.save.mockImplementation(() => new Promise<{ formID: string; dataVersion: string | null }>((resolve) => { finish = resolve; }));
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Start Grievance'));
    await settle();
    await type(getExposed(screen.container, 'Summary'), 'Overtime');
    await press(getExposed(screen.container, 'Save'));
    expect(port.save).toHaveBeenCalledWith(expect.objectContaining({ key: 'grievance' }), { summary: 'Overtime' }, 0, expect.objectContaining({ formID: null, dataVersion: null }));
    // Leaving the editor waits for the save.
    await press(getExposed(screen.container, 'All forms'));
    await type(getExposed(screen.container, 'Summary'), 'Overtime not paid on the 12th');
    await act(async () => { finish(saved('form-1')); await Promise.resolve(); });
    await settle();
    expect((getExposed(screen.container, 'Summary') as HTMLInputElement).value).toBe('Overtime not paid on the 12th');
  });

  it('opens the worker’s open draft of the template when the recent list does not show it', async () => {
    setPlatform(os);
    port.openDraft.mockResolvedValue({ ...savedForm('form-old', 'grievance', 'Written last spring'), updatedAt: '2026-04-01T15:00:00Z' });
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Start Grievance'));
    await settle();
    expect(port.openDraft).toHaveBeenCalledWith('member-a', 'grievance');
    expect((getExposed(screen.container, 'Summary') as HTMLInputElement).value).toBe('Written last spring');
  });

  // Gate stage 121 on  (r3s1): a Start lookup that finishes after the
  // member opened another form from their history does not replace it.
  it('ignores a Start lookup that finishes after the worker opened another form', async () => {
    setPlatform(os);
    port.templates.mockResolvedValue([grievance, serviceRequest]);
    port.forms.mockResolvedValue([savedForm('form-sr', 'service_request', 'Parking pass')]);
    let finish: (draft: unknown) => void = () => {};
    port.openDraft.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Start Grievance'));
    await press(getExposed(screen.container, 'Continue Service request'));
    await type(getExposed(screen.container, 'Summary'), 'Parking pass for the night shift');
    await act(async () => { finish(savedForm('form-old', 'grievance', 'Written last spring')); await Promise.resolve(); });
    await settle();
    expect((getExposed(screen.container, 'Summary') as HTMLInputElement).value).toBe('Parking pass for the night shift');
  });

  // Gate stage 121 on  (r4s1): after a Save, Continue reopens the saved
  // answers, not the copy the history read before the save.
  const savedBases = (): unknown[] => (port.save.mock.calls as unknown[][]).map((call) => (call[3] as FormSaveLane).baseAnswers);
  //: an ordinary save names the answers last known to be stored, as
  // the website does: the row as stored when the form opens, then what each
  // save stored, and the stored form after a refusal shows it.
  it('names as base the stored row, then each save\'s answers, then the stored form after a refusal', async () => {
    port.forms.mockResolvedValue([{ ...savedForm('form-1', 'grievance', 'Before'), storedAnswers: { summary: 'Before', hours: 6 } }]);
    port.save.mockResolvedValueOnce({ formID: 'form-1', dataVersion: null, answers: { summary: 'First edit' } })
      .mockRejectedValueOnce(new FormActionError('form-changed'))
      .mockResolvedValue({ formID: 'form-1', dataVersion: null, answers: { summary: 'Third edit' } });
    port.stored.mockResolvedValue({ answers: { summary: 'Another device' }, dataVersion: null, stored: { summary: 'Another device' } });
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue Grievance'));
    for (const text of ['First edit', 'Second edit', 'Third edit']) {
      await type(getExposed(screen.container, 'Summary'), text);
      await press(getExposed(screen.container, 'Save'));
      await settle();
    }
    expect(savedBases()).toEqual([
      { summary: 'Before', hours: 6 },
      { summary: 'First edit' },
      { summary: 'Another device' },
    ]);
  });

  // The website's gate final on  (r3s1): a refused first save knew no
  // form, so the phone binds the member's open draft of the template, shows its
  // stored answers, and saves against them next.
  it('binds the other session\'s draft after a refused first save, and saves against it next', async () => {
    port.forms.mockResolvedValue([]);
    port.openDraft.mockResolvedValueOnce(null).mockResolvedValue({ ...savedForm('form-theirs', 'grievance', 'Saved elsewhere'), storedAnswers: { summary: 'Saved elsewhere' } });
    port.save.mockRejectedValueOnce(new FormActionError('form-changed'))
      .mockResolvedValue({ formID: 'form-theirs', dataVersion: null, answers: { summary: 'Saved elsewhere' } });
    port.stored.mockResolvedValue({ answers: { summary: 'Saved elsewhere' }, dataVersion: null, stored: { summary: 'Saved elsewhere' } });
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Start Grievance'));
    await settle();
    await type(getExposed(screen.container, 'Summary'), 'Typed here');
    await press(getExposed(screen.container, 'Save'));
    await settle();
    expect((getExposed(screen.container, 'Summary') as HTMLInputElement).value).toBe('Saved elsewhere');
    await type(getExposed(screen.container, 'Summary'), 'Reviewed and corrected');
    await press(getExposed(screen.container, 'Save'));
    await settle();
    const second = (port.save.mock.calls as unknown[][])[1];
    expect((second?.[3] as FormSaveLane).formID).toBe('form-theirs');
    expect((second?.[3] as FormSaveLane).baseAnswers).toEqual({ summary: 'Saved elsewhere' });
  });

  it('names {} as the base of a new form\'s first save', async () => {
    port.forms.mockResolvedValue([]);
    port.openDraft.mockResolvedValue(null);
    port.save.mockResolvedValue({ formID: 'form-n', dataVersion: null, answers: { summary: 'New' } });
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Start Grievance'));
    await settle();
    await type(getExposed(screen.container, 'Summary'), 'New');
    await press(getExposed(screen.container, 'Save'));
    await settle();
    expect(savedBases()[0]).toEqual({});
  });

  //  review G7-2: reopening a just-saved form before the list is read
  // again names what that save stored as its base, not the row's older copy.
  //  review G7-3: an ordinary save refused as changed elsewhere keeps
  // what the member typed beside the stored answers, for an explicit choice.
  it('keeps the typing a refusal did not save, and lets the worker use it or keep the stored answers', async () => {
    port.forms.mockResolvedValue([{ ...savedForm('form-1', 'grievance', 'Before'), storedAnswers: { summary: 'Before' } }]);
    port.save.mockRejectedValueOnce(new FormActionError('form-changed'))
      .mockResolvedValue({ formID: 'form-1', dataVersion: null, answers: { summary: 'Typed on this phone' } });
    port.stored.mockResolvedValue({ answers: { summary: 'Another device' }, dataVersion: null, stored: { summary: 'Another device' } });
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue Grievance'));
    await type(getExposed(screen.container, 'Summary'), 'Typed on this phone');
    await press(getExposed(screen.container, 'Save'));
    await settle();
    expect((getExposed(screen.container, 'Summary') as HTMLInputElement).value).toBe('Another device');
    expect(screen.container.textContent).toContain('The answers you typed on this phone were not saved.');
    await press(getExposed(screen.container, 'Use my answers'));
    expect((getExposed(screen.container, 'Summary') as HTMLInputElement).value).toBe('Typed on this phone');
    await press(getExposed(screen.container, 'Save'));
    await settle();
    const last = (port.save.mock.calls as unknown[][]).at(-1);
    expect(last?.[1]).toEqual({ summary: 'Typed on this phone' });
    expect((last?.[3] as FormSaveLane).baseAnswers).toEqual({ summary: 'Another device' });
    expect(screen.container.textContent).not.toContain('The answers you typed on this phone were not saved.');
  });

  it('drops the unsaved typing when the worker keeps the stored answers', async () => {
    port.forms.mockResolvedValue([{ ...savedForm('form-1', 'grievance', 'Before'), storedAnswers: { summary: 'Before' } }]);
    port.save.mockRejectedValueOnce(new FormActionError('form-changed'));
    port.stored.mockResolvedValue({ answers: { summary: 'Another device' }, dataVersion: null, stored: { summary: 'Another device' } });
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue Grievance'));
    await type(getExposed(screen.container, 'Summary'), 'Typed on this phone');
    await press(getExposed(screen.container, 'Save'));
    await settle();
    await press(getExposed(screen.container, 'Keep the stored answers'));
    expect((getExposed(screen.container, 'Summary') as HTMLInputElement).value).toBe('Another device');
    expect(screen.container.textContent).not.toContain('The answers you typed on this phone were not saved.');
  });

  it('names the just-saved answers as base when the form is reopened before the history reloads', async () => {
    port.forms.mockResolvedValueOnce([{ ...savedForm('form-1', 'grievance', 'Before'), storedAnswers: { summary: 'Before' } }]);
    port.forms.mockImplementation(() => new Promise(() => {}));
    port.save.mockResolvedValueOnce({ formID: 'form-1', dataVersion: null, answers: { summary: 'First edit' } })
      .mockResolvedValue({ formID: 'form-1', dataVersion: null, answers: { summary: 'Second edit' } });
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue Grievance'));
    await type(getExposed(screen.container, 'Summary'), 'First edit');
    await press(getExposed(screen.container, 'Save'));
    await settle();
    await press(getExposed(screen.container, 'All forms'));
    await press(getExposed(screen.container, 'Continue Grievance'));
    await type(getExposed(screen.container, 'Summary'), 'Second edit');
    await press(getExposed(screen.container, 'Save'));
    await settle();
    expect(savedBases()).toEqual([{ summary: 'Before' }, { summary: 'First edit' }]);
  });

  it('reopens the saved answers after a Save, before the history has reloaded', async () => {
    setPlatform(os);
    port.forms.mockResolvedValueOnce([savedForm('form-1', 'grievance', 'Before')]);
    port.forms.mockImplementation(() => new Promise(() => {}));
    port.save.mockResolvedValue(saved('form-1'));
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue Grievance'));
    await type(getExposed(screen.container, 'Summary'), 'After the meeting');
    await press(getExposed(screen.container, 'Save'));
    await settle();
    await press(getExposed(screen.container, 'All forms'));
    await press(getExposed(screen.container, 'Continue Grievance'));
    expect((getExposed(screen.container, 'Summary') as HTMLInputElement).value).toBe('After the meeting');
  });
});

// REQ-UG-NATIVE-FMLA-FORMS-SHOW-GINA-NOTICE-AND-NO-DIAGNOSIS-HINT-20261113
//: the live Forms screen shows the GINA notice and the no-diagnosis
// hint on the FMLA forms it lists, in the member's language, and the no-dues
// service request description in an organization that runs no dues.
const fmlaFamily = formTemplateFromRow({
  key: 'fmla_family', version: 1, label_en: 'FMLA family care', label_es: 'FMLA cuidado familiar', blurb_en: 'Request leave to care for a family member.', active: true, available_to_start: true, is_platform_seed: true, organization_id: null,
  field_schema: { steps: [{ title: 'Leave', fields: [{ key: 'reason', type: 'text', label: 'Leave needed', required: true }] }] },
}) as FormTemplate;
const GINA_EN = 'The Genetic Information Nondiscrimination Act of 2008 (GINA) prohibits employers';
const HINT_EN = 'Do not enter a diagnosis, a family member';
const GINA_ES = 'La Ley de No Discriminación por Información Genética de 2008 (GINA';
const HINT_ES = 'No escribas un diagnóstico';
const NO_DUES_EN = 'Ask the campaign for help with benefits, training, or anything else.';
const NO_DUES_ES = 'Pide ayuda a la campaña con beneficios, capacitación o cualquier otra cosa.';
const DUES_EN = 'Ask the campaign for help with dues, benefits, or training.';
const DUES_ES = 'Pide ayuda a la campaña con cuotas, beneficios o capacitación.';
const withBlurb = (template: FormTemplate, blurb: string): FormTemplate => ({ ...template, blurb });
const dated = formTemplateFromRow({
  key: 'leave_dates', version: 1, label_en: 'Leave dates', active: true, available_to_start: true, is_platform_seed: true, organization_id: null,
  field_schema: { steps: [{ title: 'Dates', fields: [{ key: 'start_date', type: 'date', label: 'Start date', required: true }] }] },
}) as FormTemplate;

describe('live Forms health notice and no-dues description', () => {
  it('shows the GINA notice and the no-diagnosis hint on an FMLA form in English, and on no other form', async () => {
    port.templates.mockResolvedValue([fmlaFamily, grievance]);
    screen = await render(h(LiveFormsScreen));
    await settle();
    const text = screen.container.textContent ?? '';
    expect(text).toContain(GINA_EN);
    expect(text).toContain(HINT_EN);
    expect(text).not.toContain(GINA_ES);
    // One copy, on the FMLA card: the grievance card shows neither.
    expect(text.split(GINA_EN)).toHaveLength(2);
    expect(text.split(HINT_EN)).toHaveLength(2);
    expect(text.indexOf(GINA_EN)).toBeGreaterThan(text.indexOf('FMLA family care'));
    expect(text.indexOf(GINA_EN)).toBeLessThan(text.indexOf('Grievance'));
  });

  it('shows both texts in Spanish for a worker whose saved language is Spanish', async () => {
    port.app = { ...port.app, memberLanguage: 'es' };
    port.templates.mockResolvedValue([fmlaFamily, grievance]);
    screen = await render(h(LiveFormsScreen));
    await settle();
    expect(port.templates).toHaveBeenCalledWith(true);
    const text = screen.container.textContent ?? '';
    expect(text).toContain(GINA_ES);
    expect(text).toContain(HINT_ES);
    expect(text).not.toContain(GINA_EN);
    expect(text).not.toContain(HINT_EN);
  });

  it('shows the notice on the worker’s unfinished FMLA form, and not on a submitted one', async () => {
    // The form's pinned version, no longer offered to start.
    port.templates.mockResolvedValue([grievance, { ...fmlaFamily, startable: false }]);
    port.forms.mockResolvedValue([savedForm('form-fmla', 'fmla_family', '')]);
    screen = await render(h(LiveFormsScreen));
    await settle();
    // Since  the phone continues an FMLA form itself.
    expect(screen.container.textContent).not.toContain('Finish this form on the website.');
    getExposed(screen.container, 'Continue FMLA family care');
    expect(screen.container.textContent).toContain(GINA_EN);
    await screen.unmount();
    port.forms.mockResolvedValue([{ ...savedForm('form-fmla', 'fmla_family', ''), status: 'submitted' }]);
    screen = await render(h(LiveFormsScreen));
    await settle();
    expect(screen.container.textContent).not.toContain(GINA_EN);
  });

  // language, runsDues, the seeded description, the description shown.
  const duesCases: ['en' | 'es', boolean | null, string, string][] = [
    ['en', false, DUES_EN, NO_DUES_EN],
    ['es', false, DUES_ES, NO_DUES_ES],
    ['en', true, DUES_EN, DUES_EN],
    ['en', null, DUES_EN, DUES_EN],
    ['es', null, DUES_ES, DUES_ES],
  ];
  it.each(duesCases)('in %s with runsDues %s, the service request reads its matching description', async (language, runsDues, seeded, shown) => {
    port.app = { ...port.app, memberLanguage: language, duesContext: runsDues === null ? null : { runsDues } };
    port.templates.mockResolvedValue([withBlurb(serviceRequest, seeded)]);
    screen = await render(h(LiveFormsScreen));
    await settle();
    const text = screen.container.textContent ?? '';
    expect(text).toContain(shown);
    if (shown !== seeded) expect(text).not.toContain(seeded);
    await press(getExposed(screen.container, language === 'es' ? 'Empezar Service request' : 'Start Service request'));
    await settle();
    expect(screen.container.textContent).toContain(shown);
  });

  it('keeps a description the organization wrote itself in an organization that runs no dues', async () => {
    port.app = { ...port.app, duesContext: { runsDues: false } };
    port.templates.mockResolvedValue([withBlurb(serviceRequest, 'Ask the Westside campaign for anything at all.')]);
    screen = await render(h(LiveFormsScreen));
    await settle();
    expect(screen.container.textContent).toContain('Ask the Westside campaign for anything at all.');
    expect(screen.container.textContent).not.toContain(NO_DUES_EN);
  });
});

// REQ-UG-PER-UNIT-SETTINGS-20261109, gate stage 153 r1s2:
// a member of two units picks the unit before the new-form picker shows that
// unit's forms, and the draft saves for that unit.
describe('live Forms for a worker of two units', () => {
  const units = [{ id: 'north', name: 'North' }, { id: 'south', name: 'South' }];
  const unitContext = (unitId: string | null) => ({ actorId: 'member-a', chapterId: 'chapter-a', organizationId: 'org-a', units, unitId,
    needsChoice: !unitId, canManage: false, effective: unitId ? { workload: [], forms: unitId === 'south' ? ['grievance'] : [], templates: [], capabilities: {} } : null });

  it('asks for the unit first, shows only that unit\'s forms, and saves for it', async () => {
    port.app = { ...port.app, mode: 'authenticated', organizationID: 'org-a' };
    port.templates.mockResolvedValue([grievance, serviceRequest]);
    port.unitLoad.mockImplementation(async (unitId: string | null) => unitContext(unitId));
    port.save.mockResolvedValue({ formID: 'form-9', dataVersion: null, answers: { summary: 'Overtime' } });
    screen = await render(h(LiveFormsScreen));
    await settle();
    expect(screen.container.textContent).toContain('Choose the unit for this work to see its forms.');
    expect(screen.container.textContent).not.toContain('Start Grievance');
    await press(getExposed(screen.container, 'South'));
    await settle();
    expect(screen.container.textContent).not.toContain('Service request');
    await press(getExposed(screen.container, 'Start Grievance'));
    await settle();
    await type(getExposed(screen.container, 'Summary'), 'Overtime');
    await press(getExposed(screen.container, 'Save'));
    await settle();
    expect(port.save).toHaveBeenCalledWith(expect.objectContaining({ key: 'grievance' }), { summary: 'Overtime' }, 0,
      expect.objectContaining({ unit: { unitId: 'south', actorId: 'member-a', chapterId: 'chapter-a', organizationId: 'org-a' } }));
  });

  it('keeps a new draft on the unit of its first save and stops offering the unit choice (ledger 231)', async () => {
    port.app = { ...port.app, mode: 'authenticated', organizationID: 'org-a' };
    port.templates.mockResolvedValue([grievance]);
    port.unitLoad.mockImplementation(async (unitId: string | null) => ({ ...unitContext(unitId), effective: unitId ? { workload: [], forms: ['grievance'], templates: [], capabilities: {} } : null }));
    port.save.mockResolvedValue({ formID: 'form-7', dataVersion: null, answers: { summary: 'Overtime' } });
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'South'));
    await settle();
    await press(getExposed(screen.container, 'Start Grievance'));
    await settle();
    expect(screen.container.textContent).toContain('Choose the unit for this work');
    await type(getExposed(screen.container, 'Summary'), 'Overtime');
    await press(getExposed(screen.container, 'Save'));
    await settle();
    // The saved draft belongs to South now: no unit choice in its editor.
    expect(screen.container.textContent).not.toContain('Choose the unit for this work');
    await type(getExposed(screen.container, 'Summary'), 'Overtime, again');
    await press(getExposed(screen.container, 'Save'));
    await settle();
    expect(port.save).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'grievance' }), { summary: 'Overtime, again' }, 0,
      expect.objectContaining({ formID: 'form-7', unit: { unitId: 'south', actorId: 'member-a', chapterId: 'chapter-a', organizationId: 'org-a' } }));
  });

  it('saves a resumed draft under the unit it was made for, without asking again (gate stage 184 r3s3, r4s1)', async () => {
    port.app = { ...port.app, mode: 'authenticated', organizationID: 'org-a' };
    port.templates.mockResolvedValue([grievance]);
    port.forms.mockResolvedValue([{ ...savedForm('form-n', 'grievance', 'Overtime'), boundUnit: { unitId: 'north' } }]);
    port.unitLoad.mockImplementation(async (unitId: string | null) => unitContext(unitId));
    port.save.mockResolvedValue({ formID: 'form-n', dataVersion: null, answers: { summary: 'Overtime, again' } });
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue Grievance'));
    await settle();
    await type(getExposed(screen.container, 'Summary'), 'Overtime, again');
    await press(getExposed(screen.container, 'Save'));
    await settle();
    expect(port.save).toHaveBeenCalledWith(expect.objectContaining({ key: 'grievance' }), { summary: 'Overtime, again' }, 0,
      expect.objectContaining({ formID: 'form-n', unit: { unitId: 'north', actorId: 'member-a', chapterId: 'chapter-a', organizationId: 'org-a' } }));
  });
});

// REQ-UG-NATIVE-FORMS-FULL-PARITY-WITH-THE-WEBSITE-20261113:
// the phone opens the sealed FMLA forms through the sensitive-content path,
// steps through a form to Review & submit, signs it with a drawn signature and
// consent, and submits it; a returned form is signed again and resubmitted.
const CONSENT = 'I intend this drawing to be my signature on this version of the form.';
const STROKES = [[{ x: 100, y: 100 }, { x: 300, y: 200 }]];
const disabled = (element: HTMLElement) => element.getAttribute('aria-disabled') === 'true';
//: a held signature button names what is missing.
const hint = (element: HTMLElement) => element.getAttribute('aria-description');
const DRAW_FIRST = 'Draw your signature in the box above, then tick the box to confirm it.';
const TICK_FIRST = 'Tick the box above to confirm this drawing is your signature.';
const DRAW_ONLY = 'Draw your signature in the box above.';

async function signHere(container: Element) {
  await press(getExposed(container, 'Draw your signature'));
  await press(getExposed(container, CONSENT));
  await press(getExposed(container, 'Save signature'));
  await settle();
}

describe('live Forms parity with the website', () => {
  it('opens an FMLA form on the phone with the GINA notice and hint before its first step, in English and Spanish', async () => {
    port.templates.mockResolvedValue([fmlaFamily]);
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Start FMLA family care'));
    await settle();
    getExposed(screen.container, 'Leave needed');
    expect(screen.container.textContent).toContain(GINA_EN);
    expect(screen.container.textContent).toContain(HINT_EN);
    await screen.unmount();
    port.app = { ...port.app, memberLanguage: 'es' };
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Empezar FMLA family care'));
    await settle();
    expect(screen.container.textContent).toContain(GINA_ES);
    expect(screen.container.textContent).toContain(HINT_ES);
    expect(screen.container.textContent).toContain('Paso 1 de 2');
  });

  it('opens a sealed draft through the sensitive-content path and saves it naming its form and data version', async () => {
    port.templates.mockResolvedValue([fmlaFamily]);
    port.forms.mockResolvedValue([{ ...savedForm('form-s', 'fmla_family', ''), answers: {}, sealedMarker: true }]);
    port.openAnswers.mockResolvedValue({ answers: { reason: 'Leave in March' }, dataVersion: 'v-2' });
    port.save.mockResolvedValue(saved('form-s', 'v-3'));
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue FMLA family care'));
    await settle();
    expect(port.openAnswers).toHaveBeenCalledWith(expect.objectContaining({ id: 'form-s', sealedMarker: true }), 'member-a');
    expect((getExposed(screen.container, 'Leave needed') as HTMLInputElement).value).toBe('Leave in March');
    await type(getExposed(screen.container, 'Leave needed'), 'Leave in April');
    await press(getExposed(screen.container, 'Save'));
    await settle();
    expect(port.save).toHaveBeenCalledWith(expect.objectContaining({ key: 'fmla_family' }), { reason: 'Leave in April' }, 0, expect.objectContaining({ ownerID: 'member-a', formID: 'form-s', dataVersion: 'v-2' }));
  });

  it('never opens a sealed form whose answers cannot be read', async () => {
    port.templates.mockResolvedValue([fmlaFamily]);
    port.forms.mockResolvedValue([{ ...savedForm('form-s', 'fmla_family', ''), answers: {}, sealedMarker: true }]);
    port.openAnswers.mockRejectedValue(new FormActionError('unavailable'));
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue FMLA family care'));
    await settle();
    expect(screen.container.textContent).toContain('This form’s answers can’t be opened right now.');
    expect(() => getExposed(screen!.container, 'Leave needed')).toThrow();
    expect(port.save).not.toHaveBeenCalled();
  });

  it('saves, then signs with consent, then submits, and Submit waits for a current signature', async () => {
    port.save.mockResolvedValue(saved('form-1'));
    port.sign.mockResolvedValue(undefined);
    port.submit.mockResolvedValue(undefined);
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Start Grievance'));
    await settle();
    await type(getExposed(screen.container, 'Summary'), 'Overtime');
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    expect(port.save).toHaveBeenCalledTimes(1);
    expect(screen.container.textContent).toContain('Summary: Overtime');
    expect(disabled(getExposed(screen.container, 'Submit for committee member review'))).toBe(true);
    // Consent is required before the signature can be saved.
    expect(hint(getExposed(screen.container, 'Save signature'))).toBe(DRAW_FIRST);
    // Ticked with a blank pad: only the drawing is missing.
    await press(getExposed(screen.container, CONSENT));
    expect(disabled(getExposed(screen.container, 'Save signature'))).toBe(true);
    expect(hint(getExposed(screen.container, 'Save signature'))).toBe(DRAW_ONLY);
    await press(getExposed(screen.container, CONSENT));
    expect(hint(getExposed(screen.container, 'Save signature'))).toBe(DRAW_FIRST);
    await press(getExposed(screen.container, 'Draw your signature'));
    expect(disabled(getExposed(screen.container, 'Save signature'))).toBe(true);
    expect(hint(getExposed(screen.container, 'Save signature'))).toBe(TICK_FIRST);
    await press(getExposed(screen.container, CONSENT));
    await press(getExposed(screen.container, 'Save signature'));
    await settle();
    expect(port.sign).toHaveBeenCalledWith('grievance', STROKES, true, 'member-a', { saved: { formID: 'form-1', dataVersion: null }, attachmentIDs: [] });
    // Signing saves first even with nothing changed (gate stage 136 on, r1s1).
    expect(port.save).toHaveBeenCalledTimes(2);
    expect(screen.container.textContent).toContain('Filer signature saved');
    await press(getExposed(screen.container, 'Submit for committee member review'));
    await settle();
    expect(port.submit).toHaveBeenCalledWith('grievance', 'member-a', { saved: { formID: 'form-1', dataVersion: null }, attachmentIDs: [] });
    expect(screen.container.textContent).toContain('Form submitted — in review');
    expect(() => getExposed(screen!.container, 'Submit for committee member review')).toThrow();
  });

  it('asks for a fresh signature when the answers change after signing', async () => {
    port.save.mockResolvedValue(saved('form-1'));
    port.sign.mockResolvedValue(undefined);
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Start Grievance'));
    await type(getExposed(screen.container, 'Summary'), 'Overtime');
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    await signHere(screen.container);
    await press(getExposed(screen.container, 'Back'));
    await type(getExposed(screen.container, 'Summary'), 'Overtime on the 12th');
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    expect(screen.container.textContent).toContain('Answers or attachments changed. Draw and save your signature again.');
    expect(disabled(getExposed(screen.container, 'Submit for committee member review'))).toBe(true);
  });

  it('shows a returned form’s committee member note, signs it again and resubmits it', async () => {
    port.forms.mockResolvedValue([{ ...savedForm('form-r', 'grievance', 'Overtime'), status: 'returned', reviewNote: 'Add the date.', signed: true }]);
    port.save.mockResolvedValue(saved('form-r'));
    port.sign.mockResolvedValue(undefined);
    port.submit.mockResolvedValue(undefined);
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue Grievance'));
    await settle();
    expect(screen.container.textContent).toContain('Returned — Add the date.');
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    expect(screen.container.textContent).toContain('Answers or attachments changed. Draw and save your signature again.');
    await signHere(screen.container);
    await press(getExposed(screen.container, 'Submit for committee member review'));
    await settle();
    // The signature and the resubmission each save first, naming the returned form.
    expect(port.save).toHaveBeenCalledTimes(2);
    expect(port.save).toHaveBeenCalledWith(expect.objectContaining({ key: 'grievance' }), { summary: 'Overtime' }, 1, expect.objectContaining({ formID: 'form-r' }));
    expect(port.sign).toHaveBeenCalledWith('grievance', STROKES, true, 'member-a', expect.objectContaining({ saved: expect.objectContaining({ formID: 'form-r' }), attachmentIDs: [] }));
    expect(port.submit).toHaveBeenCalledWith('grievance', 'member-a', expect.objectContaining({ saved: expect.objectContaining({ formID: 'form-r' }), attachmentIDs: [] }));
  });

  it('keeps the editor open and says why when the server refuses the submission', async () => {
    port.save.mockResolvedValue(saved('form-1'));
    port.sign.mockResolvedValue(undefined);
    port.submit.mockRejectedValue(new FormActionError('signature-required'));
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Start Grievance'));
    await type(getExposed(screen.container, 'Summary'), 'Overtime');
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    await signHere(screen.container);
    await press(getExposed(screen.container, 'Submit for committee member review'));
    await settle();
    expect(screen.container.textContent).toContain('Draw and save your signature before submitting.');
    expect(disabled(getExposed(screen.container, 'Submit for committee member review'))).toBe(true);
  });
});

// Gate stage 136 on  (r1): an editor belongs to the member it was opened
// for. When another member signs in it closes, and a save that finishes late
// opens nothing on the new member's screen.
it('closes the editor when another worker signs in, and a late save changes nothing', async () => {
  let finish: (result: { formID: string; dataVersion: string | null }) => void = () => {};
  port.save.mockImplementation(() => new Promise<{ formID: string; dataVersion: string | null }>((resolve) => { finish = resolve; }));
  screen = await render(h(LiveFormsScreen));
  await settle();
  await press(getExposed(screen.container, 'Start Grievance'));
  await type(getExposed(screen.container, 'Summary'), 'Worker A’s account of the shift');
  await press(getExposed(screen.container, 'Save'));
  expect(port.save).toHaveBeenCalledWith(expect.objectContaining({ key: 'grievance' }), { summary: 'Worker A’s account of the shift' }, 0, expect.objectContaining({ ownerID: 'member-a' }));
  port.app = { ...port.app, session: { user: { id: 'member-b' } }, dashboard: { member: { id: 'member-b', chapterID: 'chapter-a', language: 'en' } } };
  await screen.rerender(h(LiveFormsScreen));
  await settle();
  expect(() => getExposed(screen!.container, 'Summary')).toThrow();
  await act(async () => { finish(saved('form-a')); await Promise.resolve(); });
  await settle();
  expect(() => getExposed(screen!.container, 'Summary')).toThrow();
  expect(screen.container.textContent).not.toContain('Worker A’s account of the shift');
});

// Gate stage 136 on, round 1.
describe('live Forms review and signing after round 1', () => {
  // r1s1, r2s1: a clean sealed draft is still saved, naming the version the
  // editor opened, before it is signed; a refusal (the website changed it)
  // stops the signature.
  it('saves a clean sealed draft against its opened version before signing, and signs nothing when that save is refused', async () => {
    port.templates.mockResolvedValue([fmlaFamily]);
    port.forms.mockResolvedValue([{ ...savedForm('form-s', 'fmla_family', ''), answers: {}, sealedMarker: true }]);
    port.openAnswers.mockResolvedValue({ answers: { reason: 'Leave in March' }, dataVersion: 'v-2' });
    port.save.mockRejectedValue(new FormActionError('failed'));
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue FMLA family care'));
    await settle();
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    expect(port.save).not.toHaveBeenCalled();
    await signHere(screen.container);
    expect(port.save).toHaveBeenCalledWith(expect.objectContaining({ key: 'fmla_family' }), { reason: 'Leave in March' }, 1, expect.objectContaining({ formID: 'form-s', dataVersion: 'v-2' }));
    expect(port.sign).not.toHaveBeenCalled();
    expect(screen.container.textContent).toContain('Your signature was not saved.');
    expect(disabled(getExposed(screen.container, 'Submit for committee member review'))).toBe(true);
  });

  // r1s4, r2s3: the review shows what the save stores, names answers it
  // leaves out, and Submit waits until they are corrected.
  it('reviews the answers the save stores and holds Submit while one does not parse', async () => {
    port.templates.mockResolvedValue([dated]);
    port.save.mockResolvedValue(saved('form-d'));
    port.sign.mockResolvedValue(undefined);
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Start Leave dates'));
    await settle();
    await type(getExposed(screen.container, 'Start date'), '01/31/2027');
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    expect(screen.container.textContent).not.toContain('Start date: 01/31/2027');
    expect(screen.container.textContent).toContain('These answers are not in a form that can be saved. Go back and correct them: Start date.');
    expect(screen.container.textContent).toContain('Start date');
    await signHere(screen.container);
    expect(disabled(getExposed(screen.container, 'Submit for committee member review'))).toBe(true);
  });

  // r2s2: a signature saved here reopens as saved.
  it('reopens a form signed here as signed', async () => {
    port.forms.mockResolvedValue([savedForm('form-g', 'grievance', 'Overtime')]);
    port.forms.mockResolvedValueOnce([savedForm('form-g', 'grievance', 'Overtime')]).mockImplementation(() => new Promise(() => {}));
    port.save.mockResolvedValue(saved('form-g'));
    port.sign.mockResolvedValue(undefined);
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue Grievance'));
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    await signHere(screen.container);
    await press(getExposed(screen.container, 'All forms'));
    await press(getExposed(screen.container, 'Continue Grievance'));
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    expect(screen.container.textContent).toContain('Filer signature saved');
    expect(disabled(getExposed(screen.container, 'Submit for committee member review'))).toBe(false);
  });
});

// Gate stage 138 on, the final.
describe('live Forms after the final', () => {
  // r3s1: a submission whose reply was lost is read back by its own form id,
  // so a retry closes the editor instead of filing a second copy.
  it('reads a lost submission back and files nothing twice', async () => {
    port.save.mockResolvedValue(saved('form-1'));
    port.sign.mockResolvedValue(undefined);
    port.submit.mockRejectedValue(new FormActionError('failed'));
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Start Grievance'));
    await type(getExposed(screen.container, 'Summary'), 'Overtime');
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    await signHere(screen.container);
    await press(getExposed(screen.container, 'Submit for committee member review'));
    await settle();
    expect(port.filed).toHaveBeenCalledWith('form-1', 'member-a');
    expect(screen.container.textContent).toContain('The form was not submitted.');
    // The retry: the submission had in fact been filed. The bound save refuses
    // to follow it into a new draft, and the read-back closes the editor.
    port.save.mockRejectedValue(new FormActionError('closed'));
    port.filed.mockResolvedValue(true);
    await press(getExposed(screen.container, 'Submit for committee member review'));
    await settle();
    expect(port.submit).toHaveBeenCalledTimes(1);
    expect(screen.container.textContent).toContain('Form submitted — in review');
    expect(() => getExposed(screen!.container, 'Submit for committee member review')).toThrow();
  });

  it('says the form was submitted or replaced when a plain Save finds it closed, and never sends that editor’s save again', async () => {
    port.forms.mockResolvedValue([savedForm('form-1', 'grievance', 'Overtime')]);
    port.save.mockRejectedValue(new FormActionError('closed'));
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue Grievance'));
    await type(getExposed(screen.container, 'Summary'), 'Overtime on the 12th');
    await press(getExposed(screen.container, 'Save'));
    await settle();
    expect(screen.container.textContent).toContain('This form was already submitted or replaced, so nothing was saved.');
    // form_not_editable is final: another Save sends nothing.
    await press(getExposed(screen.container, 'Save'));
    await settle();
    expect(port.save).toHaveBeenCalledTimes(1);
    expect(screen.container.textContent).toContain('This form was already submitted or replaced, so nothing was saved.');
  });

  // r3s3: the answers of a sealed save with no reply ride on the next save,
  // so it can recognise them as stored; a confirmed save clears them.
  it('carries the answers of an unanswered sealed save into the next one', async () => {
    port.templates.mockResolvedValue([fmlaFamily]);
    port.forms.mockResolvedValue([{ ...savedForm('form-s', 'fmla_family', ''), answers: {}, sealedMarker: true }]);
    port.openAnswers.mockResolvedValue({ answers: { reason: 'Leave in March' }, dataVersion: 'v-1' });
    port.save.mockRejectedValueOnce(new FormActionError('failed', { reason: 'Leave in April' }));
    port.save.mockResolvedValue(saved('form-s', 'v-3'));
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue FMLA family care'));
    await settle();
    await type(getExposed(screen.container, 'Leave needed'), 'Leave in April');
    await press(getExposed(screen.container, 'Save'));
    await settle();
    await type(getExposed(screen.container, 'Leave needed'), 'Leave in April and May');
    await press(getExposed(screen.container, 'Save'));
    await settle();
    expect(port.save).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'fmla_family' }), { reason: 'Leave in April and May' }, 0,
      expect.objectContaining({ formID: 'form-s', dataVersion: 'v-1', unconfirmed: [{ reason: 'Leave in April' }] }));
    await type(getExposed(screen.container, 'Leave needed'), 'Leave in April and June');
    await press(getExposed(screen.container, 'Save'));
    await settle();
    expect(port.save).toHaveBeenLastCalledWith(expect.anything(), { reason: 'Leave in April and June' }, 0, expect.objectContaining({ dataVersion: 'v-3', unconfirmed: [] }));
  });

  // r3s4, r4s1: a list read started before the signature, answered after it,
  // does not reopen the form unsigned.
  it('keeps a signature saved here when an older list read answers late', async () => {
    let late: (forms: unknown) => void = () => {};
    port.forms.mockResolvedValueOnce([savedForm('form-g', 'grievance', 'Overtime')])
      .mockImplementationOnce(() => new Promise((resolve) => { late = resolve; }))
      .mockImplementation(() => new Promise(() => {}));
    port.save.mockResolvedValue(saved('form-g'));
    port.sign.mockResolvedValue(undefined);
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue Grievance'));
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    await signHere(screen.container);
    await act(async () => { late([savedForm('form-g', 'grievance', 'Overtime')]); await Promise.resolve(); });
    await settle();
    await press(getExposed(screen.container, 'All forms'));
    await press(getExposed(screen.container, 'Continue Grievance'));
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    expect(screen.container.textContent).toContain('Filer signature saved');
    expect(disabled(getExposed(screen.container, 'Submit for committee member review'))).toBe(false);
  });
});

// Gate stage 138 on  (r3s2): the signature call signs whatever the form
// holds when it runs (server fix). The phone reads the form back, and
// answers changed on another device are shown for review and signed again
// before Submit.
describe('live Forms signature read-back', () => {
  it('shows answers changed on another device for review and holds Submit until they are signed again', async () => {
    port.forms.mockResolvedValue([savedForm('form-g', 'grievance', 'Overtime')]);
    port.save.mockResolvedValue(saved('form-g'));
    port.sign.mockResolvedValue(undefined);
    port.stored.mockResolvedValue({ answers: { summary: 'Overtime on the 12th' }, dataVersion: null });
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue Grievance'));
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    await signHere(screen.container);
    await settle();
    expect(port.stored).toHaveBeenCalledWith('grievance', 'form-g', 'member-a');
    expect(screen.container.textContent).toContain('This form was changed on another device. Review the answers below, then sign again.');
    expect(screen.container.textContent).toContain('Summary: Overtime on the 12th');
    expect(disabled(getExposed(screen.container, 'Submit for committee member review'))).toBe(true);
    // The pad cleared: the consent is given again for the answers now shown.
    expect(disabled(getExposed(screen.container, 'Save signature'))).toBe(true);
    await signHere(screen.container);
    await settle();
    expect(port.save).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'grievance' }), { summary: 'Overtime on the 12th' }, 1, expect.objectContaining({ formID: 'form-g' }));
    expect(screen.container.textContent).toContain('Filer signature saved');
    expect(disabled(getExposed(screen.container, 'Submit for committee member review'))).toBe(false);
  });

  it('treats a sealed form saved again elsewhere with the same answers as changed', async () => {
    port.templates.mockResolvedValue([fmlaFamily]);
    port.forms.mockResolvedValue([{ ...savedForm('form-s', 'fmla_family', ''), answers: {}, sealedMarker: true }]);
    port.openAnswers.mockResolvedValue({ answers: { reason: 'Leave in March' }, dataVersion: 'v-2' });
    port.save.mockResolvedValue(saved('form-s', 'v-2'));
    port.sign.mockResolvedValue(undefined);
    port.stored.mockResolvedValue({ answers: { reason: 'Leave in March' }, dataVersion: 'v-4' });
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue FMLA family care'));
    await settle();
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    await signHere(screen.container);
    await settle();
    expect(screen.container.textContent).toContain('This form was changed on another device.');
    expect(disabled(getExposed(screen.container, 'Submit for committee member review'))).toBe(true);
  });
});

// Gate stage 139 on . r5s2, r6s1: a signature covers every confirmed
// attachment and the phone cannot show them yet, so a form with any is signed
// and submitted on the website. r6s2: a stored earlier save found by a failed
// one becomes the baseline at once.
describe('live Forms after the second final', () => {
  const file = (id: string, confirmed = true) => ({ id, formID: 'form-g', bucketID: 'member-form-files', objectName: `member-a/form-g/${id}`, filename: `${id}.pdf`, mimeType: 'application/pdf', sizeBytes: 2048, confirmed, createdAt: '2026-11-14T05:00:00Z', scanCurrent: true });
  const CHANGED = 'The attachments changed on another device. Review them below, then sign again.';
  async function openSignedReview(forms = [savedForm('form-g', 'grievance', 'Overtime')]) {
    port.forms.mockResolvedValue(forms);
    port.save.mockResolvedValue(saved('form-g'));
    port.sign.mockResolvedValue(undefined);
    port.submit.mockResolvedValue(undefined);
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue Grievance'));
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    return screen;
  }

  // Part 2 of: the files are shown in the filing step, the signature
  // covers them, and Submit goes through.
  it('shows the form’s attachments, signs over them and submits', async () => {
    port.files.mockResolvedValue([file('file-1')]);
    await openSignedReview();
    expect(port.files).toHaveBeenCalledWith({ formID: 'form-g', templateKey: 'grievance', ownerID: 'member-a' });
    expect(screen!.container.textContent).toContain('file-1.pdf · 2 KB · Checked');
    await signHere(screen!.container);
    await settle();
    // The signature names the attachment ids the member was shown .
    expect(port.sign).toHaveBeenCalledWith('grievance', STROKES, true, 'member-a', expect.objectContaining({ attachmentIDs: ['file-1'] }));
    expect(disabled(getExposed(screen!.container, 'Submit for committee member review'))).toBe(false);
    await press(getExposed(screen!.container, 'Submit for committee member review'));
    await settle();
    // The submission names the same shown files .
    expect(port.submit).toHaveBeenCalledWith('grievance', 'member-a', expect.objectContaining({ attachmentIDs: ['file-1'] }));
  });

  // r5s2: a file attached on another device after the list was shown is put
  // on screen, and nothing is signed over it unseen.
  it('signs nothing when the attachments changed since they were shown', async () => {
    port.files.mockResolvedValueOnce([]).mockResolvedValue([file('file-1')]);
    await openSignedReview();
    await signHere(screen!.container);
    await settle();
    expect(port.sign).not.toHaveBeenCalled();
    expect(screen!.container.textContent).toContain(CHANGED);
    expect(screen!.container.textContent).toContain('file-1.pdf');
    expect(disabled(getExposed(screen!.container, 'Submit for committee member review'))).toBe(true);
  });

  // r6s1: one that arrives while the signature is on its way holds Submit.
  it('holds Submit when an attachment arrives while the signature is on its way', async () => {
    port.files.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue([file('file-1')]);
    await openSignedReview();
    await signHere(screen!.container);
    await settle();
    expect(port.sign).toHaveBeenCalledTimes(1);
    expect(screen!.container.textContent).toContain(CHANGED);
    expect(disabled(getExposed(screen!.container, 'Submit for committee member review'))).toBe(true);
  });

  it('submits nothing while an upload or its check is unfinished, or when the files changed', async () => {
    port.files.mockResolvedValue([file('file-1', false)]);
    await openSignedReview([{ ...savedForm('form-g', 'grievance', 'Overtime'), signed: true, signatureCurrent: true }]);
    expect(screen!.container.textContent).toContain('file-1.pdf · 2 KB · Upload pending');
    expect(disabled(getExposed(screen!.container, 'Submit for committee member review'))).toBe(true);
    await screen!.unmount();
    port.files.mockReset();
    port.files.mockResolvedValueOnce([file('file-1')]).mockResolvedValue([file('file-1'), file('file-2')]);
    await openSignedReview([{ ...savedForm('form-g', 'grievance', 'Overtime'), signed: true, signatureCurrent: true }]);
    await press(getExposed(screen!.container, 'Submit for committee member review'));
    await settle();
    expect(port.submit).not.toHaveBeenCalled();
    expect(screen!.container.textContent).toContain(CHANGED);
  });

  it('adds a picked file to the saved form and clears the signature it no longer covers', async () => {
    const picked = { uri: 'file:///picked/a.pdf', filename: 'file-2.pdf', mimeType: 'application/pdf', sizeBytes: 2048, cacheOwned: true };
    port.pick.mockResolvedValue(picked);
    port.addFile.mockResolvedValue(file('file-2'));
    port.files.mockResolvedValueOnce([file('file-1')]).mockResolvedValue([file('file-1'), file('file-2')]);
    await openSignedReview([{ ...savedForm('form-g', 'grievance', 'Overtime'), signed: true, signatureCurrent: true }]);
    expect(screen!.container.textContent).toContain('Filer signature saved');
    await press(getExposed(screen!.container, 'Add a file'));
    await settle();
    expect(port.addFile).toHaveBeenCalledWith({ formID: 'form-g', templateKey: 'grievance', ownerID: 'member-a' }, picked, expect.any(Function));
    expect(screen!.container.textContent).toContain('file-2.pdf · 2 KB · Checked');
    expect(screen!.container.textContent).toContain('Answers or attachments changed. Draw and save your signature again.');
    expect(disabled(getExposed(screen!.container, 'Submit for committee member review'))).toBe(true);
  });

  it('adopts a stored earlier save found by a failed one, and keeps a repeated retry once', async () => {
    port.templates.mockResolvedValue([fmlaFamily]);
    port.forms.mockResolvedValue([{ ...savedForm('form-s', 'fmla_family', ''), answers: {}, sealedMarker: true }]);
    port.openAnswers.mockResolvedValue({ answers: { reason: 'Leave in March' }, dataVersion: 'v-1' });
    port.save.mockRejectedValueOnce(new FormActionError('failed', { reason: 'Leave in April' }))
      .mockRejectedValueOnce(new FormActionError('failed', { reason: 'Leave in May' }, 'v-2'))
      .mockRejectedValueOnce(new FormActionError('failed', { reason: 'Leave in May' }))
      .mockResolvedValue(saved('form-s', 'v-3'));
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue FMLA family care'));
    await settle();
    await type(getExposed(screen.container, 'Leave needed'), 'Leave in April');
    await press(getExposed(screen.container, 'Save'));
    await settle();
    await type(getExposed(screen.container, 'Leave needed'), 'Leave in May');
    await press(getExposed(screen.container, 'Save'));
    await settle();
    await press(getExposed(screen.container, 'Save'));
    await settle();
    await press(getExposed(screen.container, 'Save'));
    await settle();
    // The April save was found stored at v-2 by the second attempt: v-2 is the
    // baseline from then on, and the May retry is kept once.
    expect(port.save).toHaveBeenLastCalledWith(expect.anything(), { reason: 'Leave in May' }, 0,
      expect.objectContaining({ dataVersion: 'v-2', unconfirmed: [{ reason: 'Leave in May' }] }));
  });
});

//: the server refuses a signature, signing nothing, when the form holds
// other answers than the member reviewed.
it('puts the stored answers up for review when the server refuses a signature over a changed form', async () => {
  port.forms.mockResolvedValue([savedForm('form-g', 'grievance', 'Overtime')]);
  port.save.mockResolvedValue({ formID: 'form-g', dataVersion: null, answers: { summary: 'Overtime' } });
  port.sign.mockRejectedValue(new FormActionError('form-changed'));
  port.stored.mockResolvedValue({ answers: { summary: 'Overtime on the 12th' }, dataVersion: null });
  screen = await render(h(LiveFormsScreen));
  await settle();
  await press(getExposed(screen.container, 'Continue Grievance'));
  await press(getExposed(screen.container, 'Review & submit'));
  await settle();
  await signHere(screen.container);
  await settle();
  expect(port.sign).toHaveBeenCalledWith('grievance', STROKES, true, 'member-a', { saved: { formID: 'form-g', dataVersion: null, answers: { summary: 'Overtime' } }, attachmentIDs: [] });
  expect(screen.container.textContent).toContain('This form was changed on another device. Review the answers below, then sign again.');
  expect(screen.container.textContent).toContain('Summary: Overtime on the 12th');
  expect(disabled(getExposed(screen.container, 'Save signature'))).toBe(true);
  expect(disabled(getExposed(screen.container, 'Submit for committee member review'))).toBe(true);
});

// Gate stage 146 on  (r7s2): a save that changes a signed form's answers
// clears the cached signature too, so reopening before the list refresh
// answers asks for a new signature.
it('reopens a signed form whose answers were changed and saved as needing a new signature', async () => {
  port.forms.mockResolvedValueOnce([{ ...savedForm('form-g', 'grievance', 'Overtime'), signed: true, signatureCurrent: true }])
    .mockImplementation(() => new Promise(() => {}));
  port.save.mockResolvedValue(saved('form-g'));
  screen = await render(h(LiveFormsScreen));
  await settle();
  await press(getExposed(screen.container, 'Continue Grievance'));
  await type(getExposed(screen.container, 'Summary'), 'Overtime on the 12th');
  await press(getExposed(screen.container, 'Save'));
  await settle();
  await press(getExposed(screen.container, 'All forms'));
  await press(getExposed(screen.container, 'Continue Grievance'));
  await press(getExposed(screen.container, 'Review & submit'));
  await settle();
  expect(screen.container.textContent).not.toContain('Filer signature saved');
  expect(screen.container.textContent).toContain('Answers or attachments changed. Draw and save your signature again.');
  expect(disabled(getExposed(screen.container, 'Submit for committee member review'))).toBe(true);
});

// Gate stage 146 on  (r8s1,): the server refuses a submission,
// filing nothing, when the form holds other content than the member reviewed,
// even a version signed again elsewhere.
it('puts the stored answers up for review and holds Submit when the server refuses a submission over a changed form', async () => {
  port.forms.mockResolvedValue([{ ...savedForm('form-g', 'grievance', 'Overtime'), signed: true, signatureCurrent: true }]);
  port.save.mockResolvedValue({ formID: 'form-g', dataVersion: null, answers: { summary: 'Overtime' } });
  port.submit.mockRejectedValue(new FormActionError('form-changed'));
  port.stored.mockResolvedValue({ answers: { summary: 'Overtime in February' }, dataVersion: null });
  screen = await render(h(LiveFormsScreen));
  await settle();
  await press(getExposed(screen.container, 'Continue Grievance'));
  await press(getExposed(screen.container, 'Review & submit'));
  await settle();
  await press(getExposed(screen.container, 'Submit for committee member review'));
  await settle();
  expect(port.submit).toHaveBeenCalledWith('grievance', 'member-a', { saved: { formID: 'form-g', dataVersion: null, answers: { summary: 'Overtime' } }, attachmentIDs: [] });
  expect(port.filed).not.toHaveBeenCalled();
  expect(screen.container.textContent).toContain('This form was changed on another device. Review the answers below, then sign again.');
  expect(screen.container.textContent).toContain('Summary: Overtime in February');
  expect(disabled(getExposed(screen.container, 'Submit for committee member review'))).toBe(true);
  expect(port.submit).toHaveBeenCalledTimes(1);
});

// Part 2 of: alliance grievance co-signers on the phone.
describe('live Forms co-signers', () => {
  const alliance = formTemplateFromRow({
    key: 'alliance_grievance', version: 1, label_en: 'Group workplace issue', active: true, available_to_start: true, is_platform_seed: true, organization_id: null,
    field_schema: { steps: [{ title: 'What happened', fields: [{ key: 'summary', type: 'text', label: 'Summary', required: true }] }] },
  }) as FormTemplate;
  const invited = { formID: 'other-1', status: 'invited', summary: 'Unsafe staffing on 4 West', filerName: 'Jordan R.', reviewDigest: 'digest-1', previewUnavailable: false, grievance: null };

  it('shows an invitation with only its summary, accepts it with a drawn signature, or declines it', async () => {
    port.templates.mockResolvedValue([alliance]);
    port.cosigning.mockResolvedValue({ cosigners: {}, requests: [invited] });
    port.respond.mockResolvedValue(undefined);
    screen = await render(h(LiveFormsScreen));
    await settle();
    await settle();
    expect(port.cosigning).toHaveBeenCalledWith('member-a', new Set());
    expect(screen.container.textContent).toContain('Jordan R. invited you to co-sign an alliance grievance.');
    expect(screen.container.textContent).toContain('Issue: Unsafe staffing on 4 West');
    expect(screen.container.textContent).toContain('You’ll see the full issue report only after you accept.');
    await press(getExposed(screen.container, 'Accept'));
    expect(disabled(getExposed(screen.container, 'Sign and accept'))).toBe(true);
    expect(hint(getExposed(screen.container, 'Sign and accept'))).toBe(DRAW_FIRST);
    // Ticked with a blank pad: only the drawing is missing.
    await press(getExposed(screen.container, 'I intend this drawing to be my signature on this version of the issue report.'));
    expect(disabled(getExposed(screen.container, 'Sign and accept'))).toBe(true);
    expect(hint(getExposed(screen.container, 'Sign and accept'))).toBe(DRAW_ONLY);
    await press(getExposed(screen.container, 'I intend this drawing to be my signature on this version of the issue report.'));
    expect(hint(getExposed(screen.container, 'Sign and accept'))).toBe(DRAW_FIRST);
    await press(getExposed(screen.container, 'Draw your co-signature'));
    expect(hint(getExposed(screen.container, 'Sign and accept'))).toBe(TICK_FIRST);
    await press(getExposed(screen.container, 'I intend this drawing to be my signature on this version of the issue report.'));
    await press(getExposed(screen.container, 'Sign and accept'));
    await settle();
    expect(port.respond).toHaveBeenCalledWith('other-1', true, STROKES, 'member-a', 'digest-1');
    await press(getExposed(screen.container, 'Decline'));
    await settle();
    expect(port.respond).toHaveBeenLastCalledWith('other-1', false, null, 'member-a');
  });

  it('reviews an accepted grievance and withdraws the co-signature', async () => {
    port.templates.mockResolvedValue([alliance]);
    port.cosigning.mockResolvedValue({ cosigners: {}, requests: [{ ...invited, status: 'accepted', grievance: { templateKey: 'alliance_grievance', templateVersion: 1, answers: { summary: 'Unsafe staffing, three nights running' } } }] });
    port.withdraw.mockResolvedValue(undefined);
    screen = await render(h(LiveFormsScreen));
    await settle();
    await settle();
    expect(screen.container.textContent).toContain('You co-signed Jordan R.’s alliance grievance.');
    await press(getExposed(screen.container, 'Review issue report'));
    expect(screen.container.textContent).toContain('Summary: Unsafe staffing, three nights running');
    await press(getExposed(screen.container, 'Withdraw'));
    await settle();
    expect(port.withdraw).toHaveBeenCalledWith('other-1', 'member-a');
  });

  it('starts an alliance grievance on the phone, lists its co-signers, invites one and warns before an edit', async () => {
    port.templates.mockResolvedValue([alliance]);
    port.forms.mockResolvedValue([savedForm('form-a', 'alliance_grievance', 'Unsafe staffing')]);
    port.cosigning.mockResolvedValue({ cosigners: { 'form-a': [
      { id: 'c1', email: 'lee@example.org', status: 'accepted', invitedAt: '' },
      { id: 'c2', email: 'sam@example.org', status: 'invited', invitedAt: '' },
    ] }, requests: [] });
    port.save.mockResolvedValue(saved('form-a'));
    port.invite.mockResolvedValue(undefined);
    screen = await render(h(LiveFormsScreen));
    await settle();
    await settle();
    expect(screen.container.textContent).not.toContain('on the website');
    await press(getExposed(screen.container, 'Continue Group workplace issue'));
    expect(screen.container.textContent).toContain('1 co-signed this issue report as written.');
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    expect(screen.container.textContent).toContain('lee@example.org · Accepted');
    expect(screen.container.textContent).toContain('sam@example.org · Invited');
    await type(getExposed(screen.container, 'Worker email'), 'not-an-email');
    await press(getExposed(screen.container, 'Send invite'));
    expect(screen.container.textContent).toContain('Enter a valid email address.');
    expect(port.invite).not.toHaveBeenCalled();
    await type(getExposed(screen.container, 'Worker email'), 'Kim@Example.org');
    await press(getExposed(screen.container, 'Send invite'));
    await settle();
    expect(port.invite).toHaveBeenCalledWith('form-a', 'Kim@Example.org', 'member-a');
  });
});

// Part 2 of: an approved form's official filing copy, as the website
// offers it.
it('shares an approved form’s filing copy in the worker’s language', async () => {
  port.forms.mockResolvedValue([{ ...savedForm('form-ok', 'grievance', 'Overtime'), status: 'approved' }]);
  port.filing.mockResolvedValue(undefined);
  screen = await render(h(LiveFormsScreen));
  await settle();
  expect(() => getExposed(screen!.container, 'Continue Grievance')).toThrow();
  await press(getExposed(screen.container, 'Download the filing copy of Grievance'));
  await settle();
  expect(port.filing).toHaveBeenCalledWith('form-ok', 'member-a', 'en');
  const { FormFileError } = await import('../services/formFiles');
  port.filing.mockRejectedValue(new FormFileError('unavailable'));
  await press(getExposed(screen.container, 'Download the filing copy of Grievance'));
  await settle();
  expect(screen.container.textContent).toContain('Could not prepare the filing copy. Try again.');
});

//  device run, ruled for  part 2.
describe('live Forms when another session changed the form', () => {
  const CHANGED = 'This form was changed on another device. Review the answers below, then sign again.';

  // Ruling item 1: the versioned save before Submit was refused because the
  // website saved a newer version. The stored form goes on screen, Submit is
  // off, nothing is sent again, and the member is not told to check the
  // connection.
  it('shows the stored sealed form and holds Submit when the save before Submit is refused as changed', async () => {
    port.templates.mockResolvedValue([fmlaFamily]);
    port.forms.mockResolvedValue([{ ...savedForm('form-s', 'fmla_family', ''), answers: {}, sealedMarker: true, signed: true, signatureCurrent: true }]);
    port.openAnswers.mockResolvedValue({ answers: { reason: 'Leave until January 29' }, dataVersion: 'v-4' });
    port.save.mockRejectedValue(new FormActionError('form-changed'));
    port.stored.mockResolvedValue({ answers: { reason: 'Leave until February 12' }, dataVersion: 'v-5' });
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue FMLA family care'));
    await settle();
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    await press(getExposed(screen.container, 'Submit for committee member review'));
    await settle();
    expect(port.submit).not.toHaveBeenCalled();
    expect(port.filed).not.toHaveBeenCalled();
    expect(screen.container.textContent).toContain(CHANGED);
    expect(screen.container.textContent).not.toContain('Check your connection');
    expect(screen.container.textContent).toContain('Leave needed: Leave until February 12');
    expect(disabled(getExposed(screen.container, 'Submit for committee member review'))).toBe(true);
    expect(port.save).toHaveBeenCalledTimes(1);
  });

  // Gate stage 163 P2: a refused signature whose recovery read also fails
  // keeps no current signature, so Submit stays off.
  it('holds Submit when a signature is refused as changed and the stored form cannot be read', async () => {
    port.forms.mockResolvedValue([{ ...savedForm('form-g', 'grievance', 'Overtime'), signed: true, signatureCurrent: true }]);
    port.save.mockResolvedValue({ formID: 'form-g', dataVersion: null, answers: { summary: 'Overtime' } });
    port.sign.mockRejectedValue(new FormActionError('form-changed'));
    port.stored.mockRejectedValue(new FormActionError('unavailable'));
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue Grievance'));
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    expect(disabled(getExposed(screen.container, 'Submit for committee member review'))).toBe(false);
    await signHere(screen.container);
    await settle();
    expect(screen.container.textContent).toContain(CHANGED);
    expect(screen.container.textContent).not.toContain('Filer signature saved');
    expect(disabled(getExposed(screen.container, 'Submit for committee member review'))).toBe(true);
  });

  it('shows the stored form when a plain Save is refused as changed', async () => {
    port.templates.mockResolvedValue([fmlaFamily]);
    port.forms.mockResolvedValue([{ ...savedForm('form-s', 'fmla_family', ''), answers: {}, sealedMarker: true }]);
    port.openAnswers.mockResolvedValue({ answers: { reason: 'Leave until January 29' }, dataVersion: 'v-4' });
    port.save.mockRejectedValue(new FormActionError('form-changed'));
    port.stored.mockResolvedValue({ answers: { reason: 'Leave until February 12' }, dataVersion: 'v-5' });
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue FMLA family care'));
    await settle();
    await type(getExposed(screen.container, 'Leave needed'), 'Leave until January 30');
    await press(getExposed(screen.container, 'Save'));
    await settle();
    expect(screen.container.textContent).toContain(CHANGED);
    expect((getExposed(screen.container, 'Leave needed') as HTMLInputElement).value).toBe('Leave until February 12');
  });
});

// Gate stage 168 on  (r1s4): a confirmed file whose safety verdict
// lapsed is offered Re-check, after a stale open or when the list says so,
// and Submit waits for it.
describe('live Forms attachment re-check', () => {
  const file = (fields: Record<string, unknown> = {}) => ({ id: 'file-1', formID: 'form-g', bucketID: 'member-form-files', objectName: 'member-a/form-g/file-1', filename: 'provider.pdf', mimeType: 'application/pdf', sizeBytes: 2048, confirmed: true, createdAt: '', scanCurrent: true, ...fields });
  async function openReview() {
    port.forms.mockResolvedValue([{ ...savedForm('form-g', 'grievance', 'Overtime'), signed: true, signatureCurrent: true }]);
    port.save.mockResolvedValue(saved('form-g'));
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Continue Grievance'));
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
  }

  it('offers Re-check after an open finds the safety check lapsed, and runs it', async () => {
    port.files.mockResolvedValue([file()]);
    const { FormFileError } = await import('../services/formFiles');
    port.openFile.mockRejectedValue(new FormFileError('stale'));
    port.recheck.mockResolvedValue(undefined);
    await openReview();
    expect(() => getExposed(screen!.container, 'Re-check provider.pdf')).toThrow();
    await press(getExposed(screen!.container, 'Open provider.pdf'));
    await settle();
    expect(screen!.container.textContent).toContain('This file needs a fresh safety check before it can open.');
    await press(getExposed(screen!.container, 'Re-check provider.pdf'));
    await settle();
    expect(port.recheck).toHaveBeenCalledWith({ formID: 'form-g', templateKey: 'grievance', ownerID: 'member-a' }, 'file-1');
    expect(() => getExposed(screen!.container, 'Re-check provider.pdf')).toThrow();
  });

  it('marks a file whose check lapsed, offers Re-check and holds Submit until it is current', async () => {
    port.files.mockResolvedValue([file({ scanCurrent: false })]);
    await openReview();
    expect(screen!.container.textContent).toContain('provider.pdf · 2 KB · Needs a fresh safety check');
    getExposed(screen!.container, 'Re-check provider.pdf');
    expect(disabled(getExposed(screen!.container, 'Submit for committee member review'))).toBe(true);
  });
});

// Gate stage 169 (r3s1): an approved grievance takes no withdrawal, and a
// refusal is worded as one.
describe('live Forms co-signers after the final', () => {
  const alliance = formTemplateFromRow({
    key: 'alliance_grievance', version: 1, label_en: 'Group workplace issue', active: true, available_to_start: true, is_platform_seed: true, organization_id: null,
    field_schema: { steps: [{ title: 'What happened', fields: [{ key: 'summary', type: 'text', label: 'Summary', required: true }] }] },
  }) as FormTemplate;
  const accepted = (status: string) => ({ formID: 'other-1', status: 'accepted', summary: 'Unsafe staffing on 4 West', filerName: 'Jordan R.', grievance: { templateKey: 'alliance_grievance', templateVersion: 1, answers: { summary: 'Unsafe staffing' }, status } });

  it('offers no Withdraw on an approved grievance and says why', async () => {
    port.templates.mockResolvedValue([alliance]);
    port.cosigning.mockResolvedValue({ cosigners: {}, requests: [accepted('approved')] });
    screen = await render(h(LiveFormsScreen));
    await settle();
    await settle();
    expect(screen.container.textContent).toContain('You co-signed Jordan R.’s alliance grievance.');
    expect(() => getExposed(screen!.container, 'Withdraw')).toThrow();
    expect(screen.container.textContent).toContain('This issue report was approved, so your co-signature can no longer be withdrawn.');
  });

  it('words a refused withdrawal or answer as the server’s answer and reads the list again', async () => {
    const { CosignRefusal } = await import('../services/formCosigners');
    port.templates.mockResolvedValue([alliance]);
    port.cosigning.mockResolvedValue({ cosigners: {}, requests: [accepted('submitted'), { formID: 'other-2', status: 'invited', summary: 'Heat in the garage', filerName: 'Sam P.', grievance: null }] });
    port.withdraw.mockRejectedValue(new CosignRefusal('not-withdrawable'));
    port.respond.mockRejectedValue(new CosignRefusal('not-open'));
    screen = await render(h(LiveFormsScreen));
    await settle();
    await settle();
    const reads = port.cosigning.mock.calls.length;
    await press(getExposed(screen.container, 'Withdraw'));
    await settle();
    expect(screen.container.textContent).toContain('This co-signature can no longer be withdrawn, so nothing changed.');
    expect(screen.container.textContent).not.toContain('Check your connection');
    await press(getExposed(screen.container, 'Decline'));
    await settle();
    expect(screen.container.textContent).toContain('This invitation is no longer open, so nothing changed.');
    expect(port.cosigning.mock.calls.length).toBeGreaterThan(reads);
  });

  it('words a refused invitation by its reason', async () => {
    const { CosignRefusal } = await import('../services/formCosigners');
    port.templates.mockResolvedValue([alliance]);
    port.forms.mockResolvedValue([savedForm('form-a', 'alliance_grievance', 'Unsafe staffing')]);
    port.cosigning.mockResolvedValue({ cosigners: { 'form-a': [] }, requests: [] });
    port.save.mockResolvedValue(saved('form-a'));
    port.invite.mockRejectedValue(new CosignRefusal('limit'));
    screen = await render(h(LiveFormsScreen));
    await settle();
    await settle();
    await press(getExposed(screen.container, 'Continue Group workplace issue'));
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    await type(getExposed(screen.container, 'Worker email'), 'kim@example.org');
    await press(getExposed(screen.container, 'Send invite'));
    await settle();
    expect(screen.container.textContent).toContain('This issue report already has 10 co-signers.');
    expect(screen.container.textContent).not.toContain('Check your connection');
  });
});

it('words a failed removal as a removal, not as a file that was not attached', async () => {
  const { FormFileError } = await import('../services/formFiles');
  port.forms.mockResolvedValue([savedForm('form-g', 'grievance', 'Overtime')]);
  port.save.mockResolvedValue(saved('form-g'));
  port.files.mockResolvedValue([{ id: 'file-1', formID: 'form-g', bucketID: 'b', objectName: 'o', filename: 'provider.pdf', mimeType: 'application/pdf', sizeBytes: 2048, confirmed: true, createdAt: '', scanCurrent: true }]);
  port.removeFile.mockRejectedValue(new FormFileError('failed'));
  screen = await render(h(LiveFormsScreen));
  await settle();
  await press(getExposed(screen.container, 'Continue Grievance'));
  await press(getExposed(screen.container, 'Review & submit'));
  await settle();
  await press(getExposed(screen.container, 'Remove provider.pdf'));
  await settle();
  expect(screen.container.textContent).toContain('The file was not removed. Nothing changed; try again.');
  expect(screen.container.textContent).not.toContain('The file was not attached.');
});

// BUG-UG-ONE-CATCH-ALL-LINE-FOR-EVERY-REFUSAL-20261122:
// the limits show before the picker opens, and a refused file names why.
describe('a file the phone refuses', () => {
  async function addRefused(language: 'en' | 'es', message: string) {
    const es = language === 'es';
    port.app = { ...port.app, memberLanguage: language };
    port.forms.mockResolvedValue([savedForm('form-g', 'grievance', 'Overtime')]);
    port.save.mockResolvedValue(saved('form-g'));
    port.pick.mockRejectedValue(Object.assign(new Error(message), { name: 'AttachmentError', code: 'validation' }));
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, es ? 'Continuar Grievance' : 'Continue Grievance'));
    await press(getExposed(screen.container, es ? 'Revisar y enviar' : 'Review & submit'));
    await settle();
    const limits = screen.container.textContent;
    await press(getExposed(screen.container, es ? 'Agregar un archivo' : 'Add a file'));
    await settle();
    return { limits, text: screen.container.textContent };
  }

  it('states the limits and names a too-large file', async () => {
    const { limits, text } = await addRefused('en', 'Choose a file between 1 byte and 10 MiB.');
    expect(limits).toContain('Attach a PDF, JPG/JPEG, PNG, WebP, TXT, CSV, DOCX or XLSX file of up to 10 MiB;');
    expect(text).toContain('Choose a file that has content and is 10 MiB or smaller.');
    expect(text).not.toContain('Nothing was saved; try again.');
  });

  it('names a wrong file type in Spanish', async () => {
    const { limits, text } = await addRefused('es', 'Choose a PDF, image, text, CSV, Word, or Excel file.');
    expect(limits).toContain('Adjunta un archivo PDF, JPG/JPEG, PNG, WebP, TXT, CSV, DOCX o XLSX de hasta 10 MiB');
    expect(text).toContain('no se adjuntó. Elige un archivo PDF, JPG/JPEG, PNG, WebP, TXT, CSV, DOCX o XLSX.');
    expect(text).not.toContain('no se guardó nada');
  });

  it('keeps the neutral line for an unknown refusal', async () => {
    const { text } = await addRefused('en', 'The selected file could not be copied into protected app storage.');
    expect(text).toContain('The file was not attached. Nothing was saved; try again.');
    expect(text).not.toContain('protected app storage');
  });
});

// BUG-UG-NATIVE-FORM-EDITOR-CLOSES-WHEN-THE-MEMBER-RETURNS-FROM-THE-FILE-PICKER-20261114
//: every return to the foreground (after the file picker or a share
// sheet) clears the dashboard while the session is re-checked. The editor
// follows the signed-in session, so it stays open for the same member and
// still closes on sign-out or when another member signs in.
describe('live Forms editor across a return to the foreground', () => {
  async function openEditor() {
    screen = await render(h(LiveFormsScreen));
    await settle();
    await press(getExposed(screen.container, 'Start Grievance'));
    await type(getExposed(screen.container, 'Summary'), 'Overtime on the 12th');
  }

  it('stays open, with what was typed, while the dashboard is empty for a moment for the same worker', async () => {
    await openEditor();
    const signedIn = port.app;
    port.app = { ...signedIn, dashboard: null };
    await screen!.rerender(h(LiveFormsScreen));
    await settle();
    port.app = signedIn;
    await screen!.rerender(h(LiveFormsScreen));
    await settle();
    expect((getExposed(screen!.container, 'Summary') as HTMLInputElement).value).toBe('Overtime on the 12th');
  });

  it('closes on sign-out', async () => {
    await openEditor();
    port.app = { ...port.app, session: null, dashboard: null };
    await screen!.rerender(h(LiveFormsScreen));
    await settle();
    expect(() => getExposed(screen!.container, 'Summary')).toThrow();
    expect(screen!.container.textContent).not.toContain('Overtime on the 12th');
  });

  it('closes when another worker signs in, even before the dashboard has changed', async () => {
    await openEditor();
    port.app = { ...port.app, session: { user: { id: 'member-b' } } };
    await screen!.rerender(h(LiveFormsScreen));
    await settle();
    expect(() => getExposed(screen!.container, 'Summary')).toThrow();
  });
});

//: an accept names the preview the co-signer is reading, and a refusal
// because the filer changed the grievance after it stores and retries nothing.
describe.each<NativeLanguage>(['en', 'es'])('co-signing only the previewed version in %s', (language) => {
  const tr = nativeUiText(language);
  const request = (reviewDigest: string, summary: string): CosignRequest => ({ formID: 'other-1', status: 'invited', summary, filerName: 'Jordan R.', reviewDigest, previewUnavailable: false, grievance: null });
  // What the re-read gives when member_form_cosigners loads but the preview
  // read fails (gate stage 185 on, r1s1).
  const unloaded: CosignRequest = { formID: 'other-1', status: 'invited', summary: '', filerName: '', reviewDigest: null, previewUnavailable: true, grievance: null };
  const listOf = (requests: CosignRequest[], onChanged: () => void) => h(LiveCosignRequests, { requests, templateFor: () => null, ownerID: 'member-a', drawingChange: () => {}, onChanged });
  async function signFor(rendered: Rendered) {
    await press(getExposed(rendered.container, tr('Draw your co-signature')));
    await press(getExposed(rendered.container, tr('I intend this drawing to be my signature on this version of the issue report.')));
    await press(getExposed(rendered.container, tr('Sign and accept')));
    await settle();
  }

  it('sends the digest of the request on screen when the worker signs, not the one the sheet opened with', async () => {
    port.app = { ...port.app, memberLanguage: language };
    port.respond.mockResolvedValue(undefined);
    const onChanged = vi.fn();
    screen = await render(listOf([request('digest-1', 'Unsafe staffing on 4 West')], onChanged));
    await press(getExposed(screen.container, tr('Accept')));
    await screen.rerender(listOf([request('digest-2', 'Unsafe staffing on 4 West and 5 East')], onChanged));
    await signFor(screen);
    expect(port.respond).toHaveBeenCalledTimes(1);
    expect(port.respond).toHaveBeenCalledWith('other-1', true, STROKES, 'member-a', 'digest-2');
  });

  it('closes the sheet, clears the signature and consent, reads the requests again and says why when the grievance changed', async () => {
    port.app = { ...port.app, memberLanguage: language };
    port.respond.mockRejectedValueOnce(new CosignChangedSincePreview());
    const onChanged = vi.fn();
    screen = await render(listOf([request('digest-1', 'Unsafe staffing on 4 West')], onChanged));
    await press(getExposed(screen.container, tr('Accept')));
    await signFor(screen);
    expect(port.respond).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(() => getExposed(screen!.container, tr('Sign and accept'))).toThrow();
    const reason = tr('{name} changed this issue report after you opened the request, so you did not co-sign it. The issue shown now is the current one. Read it again, then accept or decline.', { name: 'Jordan R.' });
    expect(screen.container.textContent).toContain(reason);
    await screen.rerender(listOf([request('digest-2', 'Unsafe staffing on 4 West and 5 East')], onChanged));
    expect(screen.container.textContent).toContain(reason);
    expect(screen.container.textContent).toContain(tr('Issue: {summary}', { summary: 'Unsafe staffing on 4 West and 5 East' }));
    await press(getExposed(screen.container, tr('Accept')));
    expect(disabled(getExposed(screen.container, tr('Sign and accept')))).toBe(true);
    expect(hint(getExposed(screen.container, tr('Sign and accept')))).toBe(language === 'es' ? 'Dibuja tu firma en el recuadro de arriba y luego marca la casilla para confirmarla.' : DRAW_FIRST);
    port.respond.mockResolvedValue(undefined);
    await signFor(screen);
    expect(port.respond).toHaveBeenLastCalledWith('other-1', true, STROKES, 'member-a', 'digest-2');
    expect(screen.container.textContent).not.toContain(reason);
  });

  it('never answers a request whose preview failed to load during the recovery, and offers a retry', async () => {
    port.app = { ...port.app, memberLanguage: language };
    port.respond.mockRejectedValueOnce(new CosignChangedSincePreview());
    const onChanged = vi.fn();
    screen = await render(listOf([request('digest-1', 'Unsafe staffing on 4 West')], onChanged));
    await press(getExposed(screen.container, tr('Accept')));
    await signFor(screen);
    expect(onChanged).toHaveBeenCalledTimes(1);
    await screen.rerender(listOf([unloaded], onChanged));
    expect(screen.container.textContent).toContain(tr('This invitation could not be loaded, so it cannot be answered yet. Try again.'));
    expect(() => getExposed(screen!.container, tr('Accept'))).toThrow();
    expect(() => getExposed(screen!.container, tr('Decline'))).toThrow();
    expect(() => getExposed(screen!.container, tr('Sign and accept'))).toThrow();
    await press(getExposed(screen.container, tr('Try again')));
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(port.respond).toHaveBeenCalledTimes(1);
  });

  it('closes an open sign sheet when the re-read preview did not load', async () => {
    port.app = { ...port.app, memberLanguage: language };
    const onChanged = vi.fn();
    screen = await render(listOf([request('digest-1', 'Unsafe staffing on 4 West')], onChanged));
    await press(getExposed(screen.container, tr('Accept')));
    await screen.rerender(listOf([unloaded], onChanged));
    expect(() => getExposed(screen!.container, tr('Sign and accept'))).toThrow();
    expect(port.respond).not.toHaveBeenCalled();
  });
});

// Ledger 223 (gate stage 183 on, r9s1 and r10s1): attachment lists read
// for one editor never land on another, or over a newer list, across a return
// to the foreground. The route keeps the editor (useKeptFormEditor), as
// FeatureScreen does, so work from the unmounted screen is relayed.
describe('live Forms attachment reads across a return to the foreground (ledger 223)', () => {
  const file = (id: string, formID: string) => ({ id, formID, bucketID: 'member-form-files', objectName: `member-a/${formID}/${id}`, filename: `${id}.pdf`, mimeType: 'application/pdf', sizeBytes: 2048, confirmed: true, createdAt: '2026-11-14T05:00:00Z', scanCurrent: true });
  // The screen as FeatureScreen renders it, with the editor the route keeps.
  const KeptForms = LiveFormsScreen as (props: { kept: KeptFormEditor<FormEdit, FormOutcome> }) => ReturnType<typeof LiveFormsScreen>;
  function Route({ shown }: { shown: boolean }) {
    const kept = useKeptFormEditor<FormEdit, FormOutcome>('member-a', 'authenticated', 'scope-a');
    return shown ? h(KeptForms, { kept }) : null;
  }
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  it('never puts a closed form’s late attachment list on the form opened after a resume', async () => {
    port.templates.mockResolvedValue([grievance, serviceRequest]);
    port.forms.mockResolvedValue([savedForm('form-g', 'grievance', 'Overtime'), savedForm('form-s', 'service_request', 'Locker')]);
    const late = deferred<ReturnType<typeof file>[]>();
    port.files.mockImplementation(async (target: { formID: string }) => (target.formID === 'form-g' ? late.promise : [file('s-file', 'form-s')]));
    screen = await render(h(Route, { shown: true }));
    await settle();
    await press(getExposed(screen.container, 'Continue Grievance'));
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    // All forms, then the app goes to the background and comes back.
    await press(getExposed(screen.container, 'All forms'));
    await screen.rerender(h(Route, { shown: false }));
    await screen.rerender(h(Route, { shown: true }));
    await settle();
    await press(getExposed(screen.container, 'Continue Service request'));
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    expect(screen.container.textContent).toContain('s-file.pdf');
    late.resolve([file('g-file', 'form-g')]);
    await settle();
    await settle();
    expect(screen.container.textContent).toContain('s-file.pdf');
    expect(screen.container.textContent).not.toContain('g-file.pdf');
  });

  it('keeps the newer list when the read made for a signature answers after a resume', async () => {
    port.forms.mockResolvedValue([savedForm('form-g', 'grievance', 'Overtime')]);
    port.save.mockResolvedValue(saved('form-g'));
    port.sign.mockReturnValue(new Promise(() => {}));
    const signTime = deferred<ReturnType<typeof file>[]>();
    port.files
      .mockResolvedValueOnce([file('file-1', 'form-g')])
      .mockReturnValueOnce(signTime.promise)
      .mockResolvedValue([file('file-1', 'form-g'), file('file-2', 'form-g')]);
    screen = await render(h(Route, { shown: true }));
    await settle();
    await press(getExposed(screen.container, 'Continue Grievance'));
    await press(getExposed(screen.container, 'Review & submit'));
    await settle();
    await signHere(screen.container);
    // Back from the background: the kept editor's list is read again and now
    // holds a file added on another device.
    await screen.rerender(h(Route, { shown: false }));
    await screen.rerender(h(Route, { shown: true }));
    await settle();
    await settle();
    expect(screen.container.textContent).toContain('file-2.pdf');
    signTime.resolve([file('file-1', 'form-g')]);
    await settle();
    await settle();
    expect(screen.container.textContent).toContain('file-2.pdf');
  });
});

// Ledger 224 (gate stage 186 on, r3s1): a sign sheet whose preview became
// unavailable is cleared, so the retry that loads it again starts empty.
describe.each<NativeLanguage>(['en', 'es'])('a co-sign sheet after an unavailable preview in %s (ledger 224)', (language) => {
  const tr = nativeUiText(language);
  const request = (reviewDigest: string, summary: string): CosignRequest => ({ formID: 'other-1', status: 'invited', summary, filerName: 'Jordan R.', reviewDigest, previewUnavailable: false, grievance: null });
  const unloaded: CosignRequest = { formID: 'other-1', status: 'invited', summary: '', filerName: '', reviewDigest: null, previewUnavailable: true, grievance: null };
  const listOf = (requests: CosignRequest[], onChanged: () => void) => h(LiveCosignRequests, { requests, templateFor: () => null, ownerID: 'member-a', drawingChange: () => {}, onChanged });

  it('clears the drawn signature and consent, so a successful retry starts the sheet empty', async () => {
    port.app = { ...port.app, memberLanguage: language };
    const onChanged = vi.fn();
    screen = await render(listOf([request('digest-1', 'Unsafe staffing on 4 West')], onChanged));
    await press(getExposed(screen.container, tr('Accept')));
    await press(getExposed(screen.container, tr('Draw your co-signature')));
    await press(getExposed(screen.container, tr('I intend this drawing to be my signature on this version of the issue report.')));
    expect(disabled(getExposed(screen.container, tr('Sign and accept')))).toBe(false);
    await screen.rerender(listOf([unloaded], onChanged));
    await press(getExposed(screen.container, tr('Try again')));
    await screen.rerender(listOf([request('digest-2', 'Unsafe staffing on 4 West and 5 East')], onChanged));
    // The old signature does not come back beside the new preview.
    expect(() => getExposed(screen!.container, tr('Sign and accept'))).toThrow();
    await press(getExposed(screen.container, tr('Accept')));
    expect(disabled(getExposed(screen.container, tr('Sign and accept')))).toBe(true);
    expect(getExposed(screen.container, tr('I intend this drawing to be my signature on this version of the issue report.')).getAttribute('aria-checked')).not.toBe('true');
    expect(port.respond).not.toHaveBeenCalled();
  });
});
