// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import { nativeUiText } from '../lib/nativeUiCopy';
import { stubSessionWriter } from '../testing/stubSessionWriter';

// UX-UG-BLOCKED-BUTTON-GIVES-NO-REASON-STAFF-DESKS-20261122 (#9468,
// M2-9 and the purpose miss): staff Save contact stayed grey until a member,
// a purpose and, for a follow-up, a date were given, with nothing saying so.
const app = vi.hoisted(() => ({
  language: 'en' as 'en' | 'es', person: 'steward-1', organization: 'org-1', role: 'steward', organizationRoles: ['steward', 'coordinator'],
}));
const adapter = vi.hoisted(() => ({
  load: vi.fn<() => Promise<unknown>>(),
  listHandoffs: vi.fn<() => Promise<unknown>>(),
  searchHandoffMembers: vi.fn<() => Promise<unknown>>(),
  searchHandoffStewards: vi.fn<() => Promise<unknown>>(),
  recordHrContact: vi.fn<(actor: unknown, input: unknown) => Promise<unknown>>(),
  saveOnboardingStep: vi.fn<(actor: unknown, input: unknown) => Promise<unknown>>(),
}));
type MemberSupportModule = typeof import('../../../../src/features/memberSupport/index.js');
vi.mock('../../../../src/features/memberSupport/index.js', async (importOriginal) => {
  const actual = await importOriginal<MemberSupportModule>();
  return { ...actual, createMemberSupportAdapter: () => adapter };
});
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../components/ui', () => import('../testing/uiStandIn'));
vi.mock('../components/Text', () => import('../testing/reactNativeStandIn'));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../lib/announce', () => ({ queueAccessibilityAnnouncement: () => () => undefined, useAccessibilityAnnouncementQueue: () => () => undefined }));
vi.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000001' }));
vi.mock('../lib/config', () => ({ mobileConfig: { portalBaseUrl: 'https://portal.example.test' } }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../services/haptics', () => ({ haptics: { success: vi.fn(), warning: vi.fn(), select: vi.fn() } }));
vi.mock('./guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null }));
vi.mock('./NativeOnboardingOversight', () => ({ NativeOnboardingOversight: () => null }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({
  mode: 'authenticated', memberLanguage: app.language, session: { user: { id: app.person } },
  dashboard: { member: { id: app.person, chapterID: 'chapter-1' } }, organizationID: app.organization, chosenStaffRole: app.role,
  chapterMemberships: [{ chapterID: 'chapter-1', selected: true }], authorizedRoles: ['steward', 'coordinator'],
  organizationRoles: app.organizationRoles, chapterRoles: ['steward', 'coordinator'],
}) }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: () => stubSessionWriter(() => null, app.person), getSupabaseClient: () => null }));

import { HrPanel, MemberSupportScreen } from './MemberSupportScreen';

let view: Rendered | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  Object.assign(app, { language: 'en', person: 'steward-1', organization: 'org-1', role: 'steward', organizationRoles: ['steward', 'coordinator'] });
  setPlatform('ios');
});

const model: Parameters<typeof HrPanel>[0]['model'] = {
  state: 'ready', staff: true, viewerUserId: 'steward-1', hrDirectory: null, hrContacts: [], emergencyChecklists: [], accommodations: [],
  accommodationSummary: { open: 0 }, onboardingProgram: [], onboardingPlan: null, onboardingRoster: [], mentorshipPairs: [],
  mentorshipDirectory: [{ userId: 'member-7', label: 'Avery Lake', chapterId: 'chapter-1' }], handoffs: { items: [], nextCursor: null },
};

it.each<{
  language: 'en' | 'es';
  accommodations: string[];
  channels: string[];
  dispositions: string[];
  spoken: string[];
}>([
  {
    language: 'en',
    accommodations: ['Schedule', 'Equipment', 'Workspace', 'Leave', 'Communication', 'Remote work', 'Other'],
    channels: ['Email', 'Phone', 'Meeting', 'Letter', 'Portal', 'Other'],
    dispositions: ['Planned', 'Attempted', 'Reached', 'Follow-up due', 'Resolved'],
    spoken: ['Accommodation type, Remote work, 6 of 7', 'HR contact channel, Phone, 2 of 6', 'HR contact disposition, Follow-up due, 4 of 5'],
  },
  {
    language: 'es',
    accommodations: ['Horario', 'Equipo', 'Espacio de trabajo', 'Licencia', 'Comunicación', 'Trabajo remoto', 'Otro'],
    channels: ['Correo electrónico', 'Teléfono', 'Reunión', 'Carta', 'Portal web', 'Otro'],
    dispositions: ['Planificado', 'Intentado', 'Contacto realizado', 'Seguimiento pendiente', 'Resuelto'],
    spoken: ['Tipo de adaptación, Trabajo remoto, 6 de 7', 'Medio de contacto con RR. HH., Teléfono, 2 de 6', 'Resultado del contacto con RR. HH., Seguimiento pendiente, 4 de 5'],
  },
])('names Worker support choices and history for a worker in $language', async ({ language, accommodations, channels, dispositions, spoken }) => {
  app.language = language;
  app.person = 'member-7';
  app.role = 'member';
  app.organizationRoles = ['member'];
  setPlatform('android');
  adapter.load.mockReset().mockResolvedValue({
    ...model, staff: false, viewerUserId: 'member-7',
    accommodations: [{ id: 'accommodation-1', memberUserId: 'member-7', memberLabel: 'Avery Lake', requestType: 'remote_work',
      description: 'Work from home on Tuesday', status: 'submitted', staffNote: '', submittedAt: null }],
    hrContacts: [{ id: 'contact-1', memberLabel: 'Avery Lake', channel: 'phone', purpose: 'Work schedule',
      disposition: 'follow_up_due', note: '', occurredAt: null, followUpOn: '2026-12-01' }],
  });
  adapter.recordHrContact.mockReset().mockResolvedValue(undefined);
  view = await render(h(MemberSupportScreen, {}));
  const { container } = view;
  const radios = () => [...container.querySelectorAll('[role="radio"]')];
  const radioTexts = () => radios().map((item) => item.textContent);
  await press(getExposed(container, 'Accommodations'));
  expect(radioTexts()).toEqual(accommodations);
  expect(radios()[5]?.getAttribute('aria-label')).toBe(spoken[0]);
  expect(container.querySelector('[data-testid="accommodation-request"]')?.textContent).toContain(accommodations[5]);

  await press(getExposed(container, 'HR contact'));
  expect(radioTexts()).toEqual([...channels, ...dispositions]);
  expect(radios()[1]?.getAttribute('aria-label')).toBe(spoken[1]);
  expect(radios()[9]?.getAttribute('aria-label')).toBe(spoken[2]);
  const savedContact = getExposed(container, 'Work schedule').parentElement;
  expect(savedContact?.textContent).toContain(channels[1]);
  expect(savedContact?.textContent).toContain(dispositions[3]);

  await press(radios()[1]!);
  await press(radios()[9]!);
  expect(radios()[9]?.getAttribute('aria-selected')).toBe('true');
  await type(getExposed(container, 'Contact purpose'), 'Shift schedule');
  await type(getExposed(container, 'Follow-up date'), '2026-12-01');
  await press(getExposed(container, 'Save contact'));
  expect(adapter.recordHrContact).toHaveBeenCalledOnce();
  expect(adapter.recordHrContact.mock.calls[0]?.[1]).toMatchObject({
    channel: 'phone', disposition: 'follow_up_due', purpose: 'Shift schedule', followUpOn: '2026-12-01',
  });
});

const REASON_LANGUAGES: Array<'en' | 'es'> = ['en', 'es'];

it.each<['en' | 'es', string, string, string]>([
  ['en', 'Enter at least 2 characters to search.', 'No workers match “Zed”.', 'No receiving committee members match “Zed”.'],
  ['es', 'Escribe al menos 2 caracteres para buscar.', 'Ningún trabajador coincide con “Zed”.', 'Ningún integrante del comité receptor coincide con “Zed”.'],
])('explains too-short and empty handoff searches in %s', async (language, hint, memberEmpty, stewardEmpty) => {
  app.language = language;
  app.organizationRoles = ['steward'];
  adapter.load.mockReset().mockResolvedValue(model);
  adapter.listHandoffs.mockReset().mockResolvedValue(model.handoffs);
  adapter.searchHandoffMembers.mockReset().mockResolvedValue([]);
  adapter.searchHandoffStewards.mockReset().mockResolvedValue([]);
  view = await render(h(MemberSupportScreen, {}));
  const { container } = view;
  await press(getExposed(container, 'Handoffs'));
  const memberInput = getExposed(container, 'Search workers for handoff');
  const stewardInput = getExposed(container, 'Search receiving committee members');
  expect(memberInput.getAttribute('aria-description')).toBe(hint);
  expect(stewardInput.getAttribute('aria-description')).toBe(hint);
  expect(container.textContent).toContain(hint);
  await type(memberInput, 'Zed');
  await press(getExposed(container, 'Search workers'));
  expect(container.textContent).toContain(memberEmpty);
  await type(stewardInput, 'Zed');
  const stewardSearch = [...container.querySelectorAll('[role="button"]')].find((control) => control.getAttribute('aria-label') === 'Search receiving committee members')!;
  await press(stewardSearch);
  expect(container.textContent).toContain(stewardEmpty);
  await type(memberInput, 'Avery');
  expect(container.textContent).not.toContain(memberEmpty);
  expect(container.textContent).toContain(stewardEmpty);
  adapter.searchHandoffMembers.mockRejectedValueOnce(new Error('network'));
  await press(getExposed(container, 'Search workers'));
  expect(container.textContent).toContain('Worker search could not be completed.');
  expect(container.textContent).not.toMatch(/match “Avery”|coincide con “Avery”/);
});

describe.each(REASON_LANGUAGES)('staff Save contact, in %s', (language) => {
  const t = nativeUiText(language);
  const shown = () => view?.container.textContent ?? '';
  const radio = (name: string) => [...view!.container.querySelectorAll('[role="radio"]')].find((item) => item.textContent === name)!;

  it('names the missing worker, purpose and follow-up date in turn, and saves only when all are given', async () => {
    app.language = language;
    const commit = vi.fn(async () => true);
    view = await render(h(HrPanel, { model, actor: {}, adapter: {} as never, busy: false, disabled: false, commit }));
    const save = () => getExposed(view!.container, 'Save contact');
    await press(save());
    expect(shown()).toContain(t('Choose the worker this contact was with.'));
    await press(radio('Avery Lake'));
    expect(save().getAttribute('aria-description')).toBe(t('Enter the purpose of this contact.'));
    await type(getExposed(view.container, 'Contact purpose'), 'Schedule question');
    await press(radio(t('Follow-up due')));
    expect(shown()).toContain(t('Follow-up date (YYYY-MM-DD)'));
    await press(save());
    expect(shown()).toContain(t('Enter the follow-up date as YYYY-MM-DD.'));
    expect(commit).not.toHaveBeenCalled();
    await type(getExposed(view.container, 'Follow-up date'), '2026-12-01');
    await press(save());
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('gives no reason of its own while the panel is held', async () => {
    app.language = language;
    view = await render(h(HrPanel, { model, actor: {}, adapter: {} as never, busy: false, disabled: true, commit: vi.fn() }));
    expect(getExposed(view.container, 'Save contact').getAttribute('aria-description')).toBeNull();
  });
});

const draftCases: {
  tab: string;
  save: string;
  operation: 'recordHrContact' | 'saveOnboardingStep';
  fields: string[];
  draft: string[];
  newer: string[];
  cleared: string[];
}[] = [
  {
    tab: 'HR contact', save: 'Save contact', operation: 'recordHrContact',
    fields: ['Contact purpose', 'Contact note', 'Follow-up date'],
    draft: ['Confirm schedule', 'Spoke after lunch', '2026-11-25'],
    newer: ['Ask about overtime', 'Call on Thursday', '2026-11-26'],
    cleared: ['', '', ''],
  },
  {
    tab: 'Onboarding', save: 'Add onboarding step', operation: 'saveOnboardingStep',
    fields: ['Onboarding step title', 'Onboarding step description', 'Onboarding step position'],
    draft: ['Meet the safety rep', 'Arrange an introduction', '30'],
    newer: ['Review the checklist', 'Bring a question', '50'],
    cleared: ['', '', '40'],
  },
];

describe.each(draftCases)('$tab draft settlement (record #9469)', ({ tab, save, operation, fields, draft, newer, cleared }) => {
  const control = (name: string) => getExposed(view!.container, name);
  const values = () => fields.map((field) => (control(field) as HTMLInputElement).value);
  const fill = async (next: string[]) => {
    for (const [index, field] of fields.entries()) await type(control(field), next[index]!);
  };

  async function openEditor() {
    await press(control(tab));
    if (operation === 'recordHrContact') {
      for (const name of ['Avery Lake', 'Follow-up due']) {
        const radio = [...view!.container.querySelectorAll('[role="radio"]')].find((item) => item.textContent === name);
        expect(radio).toBeDefined();
        await press(radio!);
      }
    }
  }

  async function mountEditor() {
    adapter.load.mockReset().mockResolvedValue(model);
    adapter.listHandoffs.mockReset().mockResolvedValue(model.handoffs);
    view = await render(h(MemberSupportScreen, {}));
    await openEditor();
    return adapter[operation].mockReset();
  }

  async function submitPending() {
    const write = await mountEditor();
    let finish!: () => void;
    write.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await fill(draft);
    const button = control(save);
    const pressReached = vi.fn<() => void>();
    button.addEventListener('click', pressReached);
    await act(async () => {
      button.click();
      button.click();
    });
    button.removeEventListener('click', pressReached);
    expect(pressReached).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledOnce();
    expect(values()).toEqual(draft);
    return async () => { await act(async () => { finish(); }); };
  }

  it.each<'ios' | 'android'>(['ios', 'android'])('keeps the draft and retry payload after network and timeout errors on %s', async (platform) => {
    setPlatform(platform);
    const write = (await mountEditor())
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockRejectedValueOnce(new DOMException('Request timed out', 'TimeoutError'))
      .mockResolvedValueOnce(undefined);
    await fill(draft);
    for (const attempt of [1, 2]) {
      await press(control(save));
      expect(write).toHaveBeenCalledTimes(attempt);
      expect(view!.container.textContent).toContain('That change was not confirmed. Try again.');
      expect(values()).toEqual(draft);
    }
    await press(control(save));
    expect(write).toHaveBeenCalledTimes(3);
    expect(write.mock.calls[1]).toEqual(write.mock.calls[0]);
    expect(write.mock.calls[2]).toEqual(write.mock.calls[0]);
    expect(values()).toEqual(cleared);
  });

  it('ignores a second press and resets only fields untouched while pending', async () => {
    const finish = await submitPending();
    await type(control(fields[1]!), newer[1]!);
    await type(control(fields[2]!), newer[2]!);
    await type(control(fields[2]!), draft[2]!);
    await finish();
    expect(values()).toEqual([cleared[0], newer[1], draft[2]]);
  });

  it.each<'role' | 'organization' | 'person'>(['role', 'organization', 'person'])(
    'retires the pending reply after a %s switch', async (key) => {
      const finish = await submitPending();
      app[key] = { role: 'coordinator', organization: 'org-2', person: 'steward-2' }[key];
      await view!.rerender(h(MemberSupportScreen, {}));
      await openEditor();
      await fill(draft);
      const reads = adapter.load.mock.calls.length;

      await finish();
      expect(values()).toEqual(draft);
      expect(adapter.load).toHaveBeenCalledTimes(reads);
      expect(view!.container.textContent).not.toMatch(/recorded\.|step saved\.|not confirmed|Refresh/u);
    },
  );

  it('retires the confirmation read and its refresh receipt on a role switch', async () => {
    const finish = await submitPending();
    let finishRead!: (workspace: typeof model) => void;
    adapter.load.mockImplementationOnce(() => new Promise<typeof model>((resolve) => { finishRead = resolve; }));
    await finish();
    expect(adapter.load).toHaveBeenCalledTimes(2);

    app.role = 'coordinator';
    await view!.rerender(h(MemberSupportScreen, {}));
    await openEditor();
    await fill(draft);
    await act(async () => { finishRead({ ...model, state: 'retired' }); });

    expect(values()).toEqual(draft);
    expect(view!.container.textContent).not.toMatch(/recorded\.|step saved\.|not confirmed|Refresh/u);
  });

  it('shows the saved record in the reopened editor and keeps its new draft', async () => {
    const finish = await submitPending();
    await press(control('Accommodations'));
    await openEditor();
    await fill(newer);

    const savedLabel = draft[0]!;
    const refreshed: typeof model = operation === 'recordHrContact'
      ? { ...model, hrContacts: [{
          id: 'saved-contact', memberLabel: 'Avery Lake', channel: 'email',
          purpose: savedLabel, disposition: 'follow_up_due', note: draft[1]!,
          occurredAt: '2026-11-24T13:00:00Z', followUpOn: draft[2]!,
        }] }
      : { ...model, onboardingProgram: [{
          id: 'saved-step', title: savedLabel, description: draft[1]!, position: Number(draft[2]), active: true,
        }] };
    const reads = adapter.load.mock.calls.length;
    adapter.load.mockResolvedValueOnce(refreshed);

    await finish();

    expect(control(savedLabel)).toBeTruthy();
    expect(values()).toEqual(newer);
    expect(adapter.load).toHaveBeenCalledTimes(reads + 1);
    expect(view!.container.textContent).not.toMatch(/recorded\.|step saved\.|not confirmed|Refresh/u);
  });

  it('keeps the reopened draft available to edit if the confirmation read fails', async () => {
    const finish = await submitPending();
    await press(control('Accommodations'));
    await openEditor();
    await fill(newer);
    adapter.load.mockResolvedValueOnce({ ...model, state: 'error' });

    await finish();

    expect(values()).toEqual(newer);
    expect(control('Refresh')).toBeTruthy();
    await press(control(save));
    expect(adapter[operation]).toHaveBeenCalledOnce();
    expect(view!.container.textContent).not.toMatch(/recorded\.|step saved\.|not confirmed/u);
  });

  it('ignores a reply after screen unmount', async () => {
    const finish = await submitPending();
    await view!.unmount();
    view = await render(h(MemberSupportScreen, {}));
    await openEditor();
    await fill(draft);
    const reads = adapter.load.mock.calls.length;

    await finish();
    expect(values()).toEqual(draft);
    expect(adapter.load).toHaveBeenCalledTimes(reads);
    expect(view!.container.textContent).not.toMatch(/recorded\.|step saved\.|not confirmed|Refresh/u);
  });
});

it.each<{
  language: 'en' | 'es';
  request: string;
  requestHistory: string;
  contactHeadings: string[];
  statuses: string[];
}>([
  {
    language: 'en', request: 'Accommodation request', requestHistory: 'Request history · 6',
    contactHeadings: ['HR directory is not configured', 'Configure HR directory', 'Record HR contact', 'Contact history · 1'],
    statuses: ['Request submitted', 'Request under review', 'Request approved', 'Request denied', 'Request withdrawn', 'Request status unavailable'],
  },
  {
    language: 'es', request: 'Solicitud de adaptación', requestHistory: 'Historial de solicitudes · 6',
    contactHeadings: ['El directorio de RR. HH. aún no está configurado', 'Configurar el directorio de RR. HH.',
      'Registrar contacto con RR. HH.', 'Historial de contactos · 1'],
    statuses: ['Solicitud enviada', 'Solicitud en revisión', 'Solicitud aprobada', 'Solicitud denegada', 'Solicitud retirada', 'Estado de la solicitud no disponible'],
  },
])('names accommodation statuses and panel headings in $language', async ({ language, request, requestHistory, contactHeadings, statuses }) => {
  app.language = language;
  const savedStatuses = ['submitted', 'under_review', 'approved', 'denied', 'withdrawn', 'future_status'];
  const accommodations = savedStatuses.map((status, index) => ({
    id: `request-${index}`, memberUserId: 'member-7', memberLabel: 'Avery Lake', requestType: 'schedule',
    description: `Schedule adjustment ${index + 1}`, status, staffNote: '', submittedAt: null,
  }));
  adapter.load.mockReset().mockResolvedValue({ ...model, accommodations,
    hrContacts: [{ id: 'contact-1', memberLabel: 'Avery Lake', channel: 'phone', purpose: 'Shift schedule',
      disposition: 'reached', note: '', occurredAt: null, followUpOn: null }],
  });
  adapter.listHandoffs.mockReset().mockResolvedValue(model.handoffs);
  view = await render(h(MemberSupportScreen, {}));
  const { container } = view;

  await press(getExposed(container, 'Accommodations'));
  const statusHeadings = [...container.querySelectorAll('[role="heading"][data-testid="accommodation-request-status"]')];
  expect(statusHeadings.map((heading) => heading.textContent)).toEqual(statuses);
  expect(getExposed(container, request).getAttribute('role')).toBe('heading');
  expect(getExposed(container, requestHistory).getAttribute('role')).toBe('heading');

  await press(getExposed(container, 'HR contact'));
  for (const heading of [...contactHeadings, 'Shift schedule']) {
    expect(getExposed(container, heading).getAttribute('role')).toBe('heading');
  }
  if (language === 'es') {
    const directoryHeading = getExposed(container, 'El directorio de RR. HH. aún no está configurado');
    expect(directoryHeading.parentElement?.textContent).toContain('Aquí no se muestran datos de contacto de ejemplo.');
  }
});

it('uses the Spanish heading for an empty accommodation history', async () => {
  app.language = 'es';
  app.organizationRoles = ['member'];
  adapter.load.mockReset().mockResolvedValue({ ...model, staff: false });
  view = await render(h(MemberSupportScreen, {}));
  const { container } = view;
  await press(getExposed(container, 'Accommodations'));
  const emptyHeading = getExposed(container, 'No hay solicitudes de adaptación');
  expect(emptyHeading.getAttribute('role')).toBe('heading');
  expect(emptyHeading.parentElement?.textContent).toContain('Aquí verás la solicitud que envíes y cada cambio de estado.');
  expect(getExposed(container, 'Historial de solicitudes · 0').getAttribute('role')).toBe('heading');
});
