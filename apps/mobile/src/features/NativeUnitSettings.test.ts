import { stubSessionWriter } from '../testing/stubSessionWriter';
vi.mock('../services/supabase', () => ({ getSupabaseClient: () => null, captureSessionWriter: () => ({ ...stubSessionWriter(() => null), isCurrent: async () => { if (mocks.proof) { const proof = mocks.proof; mocks.proof = null; await proof; } return true; } }) }));
// @vitest-environment jsdom
import { act, createElement, StrictMode, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  // The signed-in session the provider holds ( pull request D: the
  // editors' unsent work waits on the shared draft hook, keyed to it).
  app: { mode: 'authenticated', session: { access_token: 'fixture-token', user: { id: 'actor' } }, organizationID: 'org', chosenStaffRole: 'steward', dashboard: { member: { id: 'actor', chapterID: 'chapter' } } },
  load: vi.fn(), editor: vi.fn(), workload: vi.fn(), unit: vi.fn(), chapter: vi.fn(), orgLoad: vi.fn(), orgSave: vi.fn(),
  language: { member: 'en' },
  proof: null as Promise<void> | null,
}));
// The provider syncs the draft holder before its children render.
vi.mock('../state/AppProvider', async () => {
  const { syncResumeDraftContext } = await import('../lib/resumeDraftHolder');
  return { useApp: () => { const app = Object.assign(mocks.app, { memberLanguage: mocks.language.member }); syncResumeDraftContext(app); return app; } };
});
vi.mock('expo-crypto', () => ({ randomUUID: () => 'attempt-key' }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({}) }));
vi.mock('../lib/announce', () => ({ queueAccessibilityAnnouncement: vi.fn() }));
vi.mock('../services/unitSettings', () => ({ loadNativeUnitSettings: mocks.load, loadNativeUnitEditor: mocks.editor,
  saveNativeUnitWorkload: mocks.workload, saveNativeUnitOverrides: mocks.unit, saveNativeChapterUnitSettings: mocks.chapter,
  loadNativeOrganizationWorkload: mocks.orgLoad, saveNativeOrganizationWorkload: mocks.orgSave }));
vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(value: T) => value },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  TextInput: ({ accessibilityLabel, accessibilityHint, value, editable, onChangeText }: { accessibilityLabel: string; accessibilityHint?: string; value: string; editable: boolean; onChangeText: (value: string) => void }) => createElement('input', { 'aria-label': accessibilityLabel, 'aria-description': accessibilityHint, value, disabled: !editable, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText(event.target.value) }),
}));
vi.mock('../components/ui', () => ({
  Body: ({ children }: { children?: ReactNode }) => createElement('p', null, children),
  Heading: ({ children }: { children?: ReactNode }) => createElement('h2', null, children),
  Card: ({ children }: { children?: ReactNode }) => createElement('section', null, children),
  Button: ({ label, onPress, disabled, busy }: { label: string; onPress: () => void; disabled?: boolean; busy?: boolean }) => createElement('button', { onClick: onPress, disabled: disabled || busy }, label),
}));
import { NativeUnitSettingsEditor, NativeUnitWorkloadEntry } from './NativeUnitSettings';
import { queueAccessibilityAnnouncement } from '../lib/announce';
import { syncResumeDraftContext } from '../lib/resumeDraftHolder';
import { attachBusinessRpcProvenance } from '../services/businessWriters';

const units = [{ id: 'north', name: 'North' }, { id: 'south', name: 'South' }];
const base = { workload: [{ key: 'cases', label: 'Issues', visible: true }], forms: ['grievance'], templates: [], capabilities: {} };
const context = (unitId: string | null) => ({ actorId: 'actor', chapterId: 'chapter', organizationId: 'org', units, unitId,
  needsChoice: !unitId, canManage: true, effective: unitId ? { ...base, configuration: { actorId: 'actor', chapterId: 'chapter', organizationId: 'org', unitId,
    unitName: unitId, version: 1, settingsRevision: unitId, definition: { title: 'Issues', period: 'week', statuses: ['logged'], fields: [
      { key: 'cases', label: 'Issues', kind: 'category', type: 'number', visible: true, required: false, retired: false, summary: 'sum', unit: '', options: [] },
    ] } } } : null });
const workspace = (unitId: string | null, canSetChapter = false) => ({ actorId: 'actor', chapterId: 'chapter', units, unitId, canSetChapter,
  defaults: base, organizationDefaults: base, chapterOverrides: {}, effective: base, overrides: {}, allowed: { forms: true },
  chapterVersion: 0, unitVersion: 0, formChoices: [{ key: 'grievance', labelEn: 'Grievance', labelEs: 'Queja' }], templateChoices: [], audit: [] });
// The organization's default form (version 0) as get_organization_workload_configuration returns it, trimmed.
const number = (key: string, label: string, kind: 'category' | 'field' = 'category') => ({ key, label, kind, type: 'number', visible: true, required: false, retired: false, summary: kind === 'category' ? 'sum' : 'none', unit: '', options: [] as string[] });
const organizationForm = { organizationId: 'org', version: 0, definition: { title: 'Workplace log', period: 'month', statuses: ['logged'], fields: [
  number('pending', 'workload.cat.pending'), number('todos', 'workload.cat.todos'), number('weeklyAssigned', 'workload.weeklyAssigned', 'field'),
  { key: 'employment', label: 'Employment', kind: 'field', type: 'select', visible: true, required: false, retired: false, summary: 'none', unit: '', options: ['full_time', 'part_time'] },
  { key: 'otWorked', label: 'workload.otWorked', kind: 'field', type: 'boolean', visible: true, required: false, retired: false, summary: 'none', unit: '', options: [] },
  number('otHours', 'workload.otHours', 'field'),
  { key: 'note', label: 'Note', kind: 'field', type: 'text', visible: true, required: false, retired: false, summary: 'none', unit: '', options: [] },
  { ...number('aged_cases', 'workload.cat.aged_cases'), visible: false },
] } };
const held = () => mocks.load.mockResolvedValue({ ...context(null), legacy: true });
const type = async (label: string, value: string) => {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(input, label).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => { setter?.call(input, value); input!.dispatchEvent(new Event('input', { bubbles: true })); });
};
let root: Root; let host: HTMLDivElement;
const click = async (label: string) => {
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent === label);
  expect(button, label).toBeTruthy(); await act(async () => { button!.click(); });
};
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // No draft carries over from another case: sign out, then the actor's session.
  syncResumeDraftContext({ mode: 'signedOut', session: null, organizationID: null });
  vi.resetAllMocks(); mocks.proof = null; mocks.app.dashboard.member = { id: 'actor', chapterID: 'chapter' }; mocks.app.chosenStaffRole = 'steward'; mocks.language.member = 'en';
  mocks.orgLoad.mockResolvedValue(organizationForm); mocks.orgSave.mockResolvedValue(undefined);
  mocks.load.mockImplementation(async (unitId: string | null) => context(unitId));
  mocks.editor.mockImplementation(async (_chapter: string, unitId: string | null) => workspace(unitId));
  mocks.workload.mockResolvedValue(undefined); mocks.unit.mockImplementation(async () => workspace('south'));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('mounted native unit workflows', () => {
  it('does not announce a settings save when its scope retires during the awaited proof', async () => {
    await act(async () => { root.render(createElement(NativeUnitSettingsEditor)); });
    await click('South');
    let release!: () => void;
    mocks.proof = new Promise<void>((resolve) => { release = resolve; });
    await click('Save unit settings');
    mocks.app.dashboard.member = { id: 'other', chapterID: 'chapter' };
    await act(async () => { root.render(createElement(NativeUnitSettingsEditor)); });
    await act(async () => { release(); });
    expect(queueAccessibilityAnnouncement).not.toHaveBeenCalledWith('Settings saved.');
  });

  it('requires an explicit choice and freezes it while saving, including StrictMode effect replay', async () => {
    let release: (() => void) | undefined;
    mocks.workload.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    await act(async () => { root.render(createElement(StrictMode, null, createElement(NativeUnitWorkloadEntry))); });
    expect(host.querySelector('input')).toBeNull();
    await click('South'); expect(host.querySelector('input')).not.toBeNull();
    await click('Save workload');
    expect(mocks.workload).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), expect.objectContaining({ unitId: 'south' }), {}, 'logged');
    expect([...host.querySelectorAll('button')].filter((button) => ['North', 'South'].includes(button.textContent ?? '')).every((button) => button.disabled)).toBe(true);
    await act(async () => { release?.(); });
    expect(host.textContent).toContain('Workload saved.');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'North')?.disabled).toBe(false);
  });
  it('keeps the loaded unit when the selected unit is pressed again (gate stage 153 r1s5)', async () => {
    await act(async () => { root.render(createElement(NativeUnitWorkloadEntry)); });
    await click('South'); expect(host.querySelector('input')).not.toBeNull();
    const loads = mocks.load.mock.calls.length;
    await click('South');
    expect(host.querySelector('input')).not.toBeNull(); expect(mocks.load.mock.calls.length).toBe(loads);
  });
  it('draws nothing while loading, and nothing about units while the feature is held', async () => {
    let release: ((value: unknown) => void) | undefined;
    mocks.load.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    mocks.editor.mockRejectedValue(Object.assign(new Error('unit editor required'), { code: '42501' }));
    await act(async () => { root.render(createElement('div', null, createElement(NativeUnitWorkloadEntry), createElement(NativeUnitSettingsEditor))); });
    expect(host.textContent).toBe(''); expect(mocks.orgLoad).not.toHaveBeenCalled();
    await act(async () => { release?.({ ...context(null), legacy: true }); });
    expect(host.textContent).not.toMatch(/unit/i);
    expect(host.textContent).toContain('Workplace log');
  });
  it('does not publish a late previous account reply', async () => {
    let release: ((value: ReturnType<typeof context>) => void) | undefined;
    mocks.load.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    await act(async () => { root.render(createElement(NativeUnitWorkloadEntry)); });
    const old = release;
    mocks.app.dashboard.member = { id: 'other', chapterID: 'other-chapter' };
    await act(async () => { root.render(createElement(NativeUnitWorkloadEntry)); });
    await act(async () => { old?.(context('south')); });
    expect(host.querySelector('input')).toBeNull(); expect(mocks.workload).not.toHaveBeenCalled();
  });
  it('lets a unit committee member change only delegated choices for the explicit unit', async () => {
    await act(async () => { root.render(createElement(NativeUnitSettingsEditor)); });
    expect(host.textContent).not.toContain('Allow unit committee members');
    expect(host.textContent).not.toContain('Save unit settings');
    await click('South');
    await click('Use campaign settings for Forms: On'); await click('Grievance: Shown'); await click('Save unit settings');
    expect(mocks.unit).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), expect.objectContaining({ unitId: 'south' }), { forms: [] });
    expect(mocks.chapter).not.toHaveBeenCalled();
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'Use campaign settings for Workload categories: On')?.disabled).toBe(true);
  });
  it('loads a target campaign for an organization admin without substituting the home campaign', async () => {
    mocks.app.chosenStaffRole = 'admin'; mocks.editor.mockResolvedValue({ ...workspace(null, true), chapterId: 'target' });
    await act(async () => { root.render(createElement(NativeUnitSettingsEditor, { chapterId: 'target' })); });
    expect(mocks.editor).toHaveBeenCalledWith('target', null);
    expect(host.textContent).toContain('Allow unit committee members');
  });
});

describe('workload entry while units are held (BUG-UG-NATIVE-IOS-WORKLOAD-LOG-HAS-NO-ENTRY-20261117)', () => {
  it('records this week on the organization form through the website write and asks the history to refresh', async () => {
    held(); const onSaved = vi.fn();
    await act(async () => { root.render(createElement(NativeUnitWorkloadEntry, { onSaved })); });
    expect(mocks.orgLoad).toHaveBeenCalledTimes(1);
    expect(host.querySelector('input[aria-label="Aged issues"]')).toBeNull();
    await type('Pending', '4'); await type('To-dos', '2'); await type('New issues this week', '3'); await click('Full-time');
    await click('Save workload');
    expect(mocks.orgSave).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), organizationForm, { pending: 4, todos: 2, weeklyAssigned: 3, employment: 'full_time', otWorked: false, otHours: 0 }, 'logged');
    expect(mocks.workload).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Workload saved.');
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Pending"]')?.value).toBe('');
  });
  it('refuses values the server would refuse, before any write, and says which field and why', async () => {
    held();
    await act(async () => { root.render(createElement(NativeUnitWorkloadEntry)); });
    await type('Pending', '2.5'); await click('Save workload');
    expect(mocks.orgSave).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Check the marked fields: Pending.');
    expect(host.textContent).toContain('Enter a whole number from 0 to 300.');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Pending"]')?.value).toBe('2.5');
  });
  it('lets an optional choice be cleared by pressing it again', async () => {
    held();
    await act(async () => { root.render(createElement(NativeUnitWorkloadEntry)); });
    await click('Part-time'); await click('Part-time'); await click('Save workload');
    expect(mocks.orgSave).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), organizationForm, { otWorked: false, otHours: 0 }, 'logged');
  });
  it('translates a retained refusal and its field hint when the worker switches to Spanish', async () => {
    held();
    await act(async () => { root.render(createElement(NativeUnitWorkloadEntry)); });
    await type('Pending', '2.5'); await click('Save workload');
    expect(host.textContent).toContain('Check the marked fields: Pending.');
    mocks.language.member = 'es';
    await act(async () => { root.render(createElement(NativeUnitWorkloadEntry)); });
    expect(host.textContent).toContain('Revisa los campos marcados: Pendientes.');
    expect(host.textContent).not.toContain('Check the marked fields');
    expect(host.textContent).toContain('Escribe un número entero de 0 a 300.');
    const pending = host.querySelector<HTMLInputElement>('input[aria-label="Pendientes"]');
    expect(pending?.value).toBe('2.5');
    expect(pending?.getAttribute('aria-description')).toBe('Escribe un número entero de 0 a 300.');
    expect(mocks.orgSave).not.toHaveBeenCalled();
    await type('Pendientes', '2');
    expect(pending?.getAttribute('aria-description')).toBeNull();
    await click('Guardar carga de trabajo');
    expect(mocks.orgSave).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), organizationForm, { pending: 2, otWorked: false, otHours: 0 }, 'logged');
  });
  it('shows the form in Spanish for a Spanish-language worker', async () => {
    held(); mocks.language.member = 'es';
    await act(async () => { root.render(createElement(NativeUnitWorkloadEntry)); });
    for (const text of ['Registro de carga de trabajo', 'Pendientes', 'Casos nuevos esta semana', 'Empleo', 'Tiempo completo', 'Trabajé horas extra: No', 'Nota', 'Estado', 'Registrado', 'Guardar carga de trabajo']) expect(host.textContent).toContain(text);
    await type('Pendientes', '1'); await click('Guardar carga de trabajo');
    expect(host.textContent).toContain('Carga de trabajo guardada.');
  });
  it('keeps admin-written labels and choices exactly as typed', async () => {
    held(); mocks.language.member = 'es';
    mocks.orgLoad.mockResolvedValue({ ...organizationForm, version: 3, definition: { ...organizationForm.definition, title: 'Weekly', fields: [
      { ...number('cases', 'Note'), key: 'cases' }, { key: 'shift', label: 'Shift', kind: 'field', type: 'select', visible: true, required: false, retired: false, summary: 'none', unit: '', options: ['full_time'] },
    ] } });
    await act(async () => { root.render(createElement(NativeUnitWorkloadEntry)); });
    expect(host.textContent).toContain('Weekly'); expect(host.textContent).toContain('Note'); expect(host.textContent).toContain('full time');
    expect(host.textContent).not.toContain('Nota'); expect(host.textContent).not.toContain('Tiempo completo');
  });
  // BUG-UG-WORKLOAD-EMPTY-CUSTOM-FIELD-NAMED-LIKE-AN-OBJECT-PROPERTY-BLOCKS-THE-SAVE-20261118 .
  it('saves with optional fields keyed constructor, valueOf and toString left empty, and shows them empty', async () => {
    held();
    const form = { ...organizationForm, version: 3, definition: { ...organizationForm.definition, title: 'Weekly', fields: [
      { key: 'constructor', label: 'Remarks', kind: 'field', type: 'text', visible: true, required: false, retired: false, summary: 'none', unit: '', options: [] as string[] },
      { ...number('valueOf', 'Calls', 'field') },
      { key: 'toString', label: 'Shift', kind: 'field', type: 'select', visible: true, required: false, retired: false, summary: 'none', unit: '', options: ['day'] },
      { ...number('visits', 'Visits', 'field') },
    ] } };
    mocks.orgLoad.mockResolvedValue(form);
    await act(async () => { root.render(createElement(NativeUnitWorkloadEntry)); });
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Remarks"]')?.value).toBe('');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Calls"]')?.value).toBe('');
    expect(host.textContent).not.toContain('native code');
    await type('Visits', '3'); await click('Save workload');
    expect(mocks.orgSave).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), form, { visits: 3 }, 'logged');
    expect(host.textContent).toContain('Workload saved.');
  });
  it('offers a retry when the form cannot load, and never shows another organization form', async () => {
    held(); mocks.orgLoad.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { root.render(createElement(NativeUnitWorkloadEntry)); });
    expect(host.textContent).toContain('The workload form could not be loaded.');
    mocks.orgLoad.mockResolvedValueOnce({ ...organizationForm, organizationId: 'other-org' });
    await click('Retry workload form');
    expect(host.querySelector('input')).toBeNull(); expect(host.textContent).toContain('The workload form could not be loaded.');
    await click('Retry workload form');
    expect(host.querySelector('input[aria-label="Pending"]')).not.toBeNull();
  });
  it('tells the worker to reload when the server refuses the write', async () => {
    // The refusal as businessRpc throws it: PostgREST's 409 body with its status ( pull request D2).
    held(); mocks.orgSave.mockRejectedValue(attachBusinessRpcProvenance({ code: 'PT409', message: 'workload configuration changed; reload', details: 'workload_configuration_changed', hint: null }, 409));
    await act(async () => { root.render(createElement(NativeUnitWorkloadEntry)); });
    await type('Pending', '1'); await click('Save workload');
    expect(host.textContent).toContain('Your settings or access may have changed. Reload before saving again.');
    const loads = mocks.orgLoad.mock.calls.length;
    await click('Reload workload form');
    expect(mocks.orgLoad.mock.calls.length).toBe(loads + 1);
  });
});

// BUG-UG-NATIVE-WORKLOAD-LOG-SAVE-REFUSAL-NAMES-NO-FIELD-20261118:
// a Spanish-language member typed the week's 46 hours into the one-day Hours
// worked field, marked 6 overtime hours, wrote a note and left the worked day
// empty. The save was refused with "Revisa los campos antes de guardar." and
// nothing said which field. Each refused field now says what to change, in the
// member's language, what was typed stays, and the corrected save lands in
// History.
describe('a refused workload save names each field (#9101)', () => {
  const date = (key: string, label: string, required = false) => ({ key, label, kind: 'field', type: 'date', visible: true, required, retired: false, summary: 'none', unit: '', options: [] as string[] });
  const dayForm = (workedOnRequired: boolean) => ({ ...organizationForm, definition: { ...organizationForm.definition, fields: [
    ...organizationForm.definition.fields.filter((field) => field.key !== 'note'),
    date('workedOn', 'workload.workedOn', workedOnRequired), { ...number('hoursWorked', 'workload.hoursWorked', 'field'), unit: 'hours' },
    { key: 'note', label: 'Note', kind: 'field', type: 'text', visible: true, required: false, retired: false, summary: 'none', unit: '', options: [] },
  ] } });
  // The Workload log screen's History, reloaded by the entry's onSaved as
  // LiveWorkloadScreen reloads it (onSaved={retry}).
  const saved: Record<string, unknown>[] = [];
  function WorkloadLogWithHistory() {
    const [logs, setLogs] = useState<Record<string, unknown>[]>([]);
    return createElement('div', null,
      createElement(NativeUnitWorkloadEntry, { onSaved: () => setLogs([...saved]) }),
      createElement('h3', null, `HISTORY ${logs.length} logs`),
      ...logs.map((log, index) => createElement('p', { key: index }, `${String(log.hoursWorked)} h · ${String(log.note)}`)));
  }
  beforeEach(() => { saved.length = 0; mocks.orgSave.mockImplementation(async (_writer: unknown, _form: unknown, values: Record<string, unknown>) => { saved.push(values); }); });

  it('says beside each field what to change, keeps what was typed, then saves the corrected week into History', async () => {
    held(); mocks.language.member = 'es'; mocks.orgLoad.mockResolvedValue(dayForm(true));
    await act(async () => { root.render(createElement(WorkloadLogWithHistory)); });
    await type('Horas trabajadas', '46'); await click('Trabajé horas extra: No'); await type('Horas extra', '6');
    await type('Nota', 'Semana del 14 al 20 de septiembre');
    await click('Guardar carga de trabajo');
    expect(mocks.orgSave).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Revisa los campos marcados: Día trabajado, Horas trabajadas.');
    expect(host.textContent).toContain('Obligatorio: escribe una fecha como AAAA-MM-DD.');
    expect(host.textContent).toContain('Escribe las horas de este único día: 24 o menos, en cuartos de hora, como 7,5. Registra cada día por separado.');
    expect(host.textContent).not.toContain('Revisa los campos antes de guardar.');
    expect(host.textContent).toContain('HISTORY 0 logs');
    for (const [label, value] of [['Horas trabajadas', '46'], ['Horas extra', '6'], ['Nota', 'Semana del 14 al 20 de septiembre']]) {
      expect(host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.value).toBe(value);
    }
    // Each note leaves with its field's change; the comma decimal the Spanish
    // keypad types is the same number.
    await type('Horas trabajadas', '7,5');
    expect(host.textContent).not.toContain('Escribe las horas de este único día');
    expect(host.textContent).not.toContain('Revisa los campos marcados');
    await type('Día trabajado', '2026-11-16');
    await click('Guardar carga de trabajo');
    expect(mocks.orgSave).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), dayForm(true), { otWorked: true, otHours: 6, workedOn: '2026-11-16', hoursWorked: 7.5, note: 'Semana del 14 al 20 de septiembre' }, 'logged');
    expect(host.textContent).toContain('Carga de trabajo guardada.');
    expect(host.textContent).toContain('HISTORY 1 logs');
    expect(host.textContent).toContain('7.5 h · Semana del 14 al 20 de septiembre');
  });

  it.each([
    ['Hours worked', '24.1', 'Enter the hours for this one day: 24 or fewer, in quarter hours, such as 7.5. Log each day on its own.'],
    ['New issues this week', '301', 'Enter a whole number from 0 to 300.'],
    ['Overtime hours', '100', 'Enter a whole number from 0 to 99.'],
    ['Day worked', '2026-13-01', 'Enter a date as YYYY-MM-DD, such as 2026-11-16.'],
    ['Day worked', '2999-01-01', 'Enter today or an earlier day.'],
  ])('states the limit when %s is %s', async (label, value, text) => {
    held(); mocks.orgLoad.mockResolvedValue(dayForm(false));
    await act(async () => { root.render(createElement(NativeUnitWorkloadEntry)); });
    await type(label, value); await click('Save workload');
    expect(mocks.orgSave).not.toHaveBeenCalled();
    expect(host.textContent).toContain(text);
    expect(host.textContent).toContain(`Check the marked fields: ${label}.`);
  });

  it('names the overtime hours when overtime is marked without them', async () => {
    held();
    await act(async () => { root.render(createElement(NativeUnitWorkloadEntry)); });
    await click('Worked overtime: No'); await click('Save workload');
    expect(mocks.orgSave).not.toHaveBeenCalled();
    expect(host.textContent).toContain('You marked overtime: enter the overtime hours, 1 or more.');
    expect(host.textContent).toContain('Check the marked fields: Overtime hours.');
  });

  // Configured keys that name Object.prototype properties keep
  // valid answers valid and get no inherited limit or note.
  it('saves valid answers for constructor and toString keys and marks only the refused field', async () => {
    const field = (key: string, type: string, label: string) => ({ key, label, kind: 'field', type, visible: true, required: false, retired: false, summary: 'none', unit: '', options: [] as string[] });
    const customForm = { organizationId: 'org', version: 2, definition: { title: 'Tamarack visits', period: 'week', statuses: ['logged'], fields: [field('constructor', 'text', 'Task details'), field('toString', 'number', 'Visit hours'), field('valueOf', 'number', 'Visits')] } };
    held(); mocks.orgLoad.mockResolvedValue(customForm);
    await act(async () => { root.render(createElement(NativeUnitWorkloadEntry)); });
    await type('Task details', 'issue review'); await type('Visit hours', '7.5'); await type('Visits', '-1');
    await click('Save workload');
    expect(mocks.orgSave).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Check the marked fields: Visits.');
    expect(host.textContent).toContain('Enter a number from 0 to 1,000,000.');
    expect(host.textContent).not.toContain('Required: fill this in before saving.');
    await type('Visits', '3'); await click('Save workload');
    expect(mocks.orgSave).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), customForm, { constructor: 'issue review', toString: 7.5, valueOf: 3 }, 'logged');
    expect(host.textContent).toContain('Workload saved.');
  });
});
