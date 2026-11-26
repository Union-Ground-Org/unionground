import { stubSessionWriter } from '../../testing/stubSessionWriter';
// @vitest-environment jsdom
import { act, createElement as h, type PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Button as SharedButton } from '../../components/ui';
import { Alert, getExposed, press, render, type, type Rendered } from '../../testing/reactNativeStandIn';

// BUG-UG-SPANISH-SCREENS-LEFT-IN-ENGLISH-20261122 (#9502): a member
// who chose Spanish saw the Digital Picket Line and Pay tools titles in
// Spanish and everything under them in English: the Withdraw confirmation and
// its buttons, the intro and the states, every Pay tools field, result and
// message. Each screen is rendered here in Spanish and read whole.
const api = vi.hoisted(() => ({ load: vi.fn(), toggle: vi.fn() }));
const app = vi.hoisted(() => ({ language: 'es' as 'es' | 'en' }));
const spoken = vi.hoisted(() => [] as string[]);
vi.mock('react-native', () => import('../../testing/reactNativeStandIn'));
vi.mock('../../components/ui', async (importOriginal) => {
  const { Button } = await importOriginal<{ Button: typeof SharedButton }>();
  return { ...await import('../../testing/uiStandIn'), Button, OptionPicker: () => null };
});
// Keep the real Button's explanation and announcement behavior. The host
// mirrors React Native's distinction between an accessibility state and
// the explicit disabled prop that stops a press.
vi.mock('../../components/PressableScale', () => ({
  usePressSpring: () => ({}),
  PressableScale: ({ children, disabled, onPress, accessibilityLabel, accessibilityHint, accessibilityState }: PropsWithChildren<{
    disabled?: boolean;
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    accessibilityState?: { disabled?: boolean };
  }>) => h('button', {
    disabled, onClick: onPress, 'aria-label': accessibilityLabel,
    'aria-description': accessibilityHint, 'aria-disabled': accessibilityState?.disabled,
  }, children),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'div', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-screens/experimental', () => ({ ScrollViewMarker: 'div' }));
vi.mock('../../components/ScreenKeyboardReveal', () => ({ ScreenKeyboardReveal: 'div', useRevealAboveKeyboard: () => undefined }));
vi.mock('../../components/PinnedHeader', () => ({ usePinnedHeaderChrome: () => null, useScreenNameAlreadySpoken: () => false }));
vi.mock('../../components/optionPicker', () => ({ OptionPicker: () => null }));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => (text: string) => { spoken.push(text); return undefined; } }));
vi.mock('../../services/haptics', () => ({ haptics: new Proxy({}, { get: () => async () => undefined }) }));
vi.mock('./ConnectionSuggestionsPanel', () => ({ ConnectionSuggestionsPanel: () => null }));
vi.mock('../../state/AppProvider', () => ({ useApp: () => ({
  mode: 'authenticated', memberLanguage: app.language, dashboard: { member: { id: 'member-1', chapterID: 'chapter-1', language: app.language } },
  previewHat: null, authorizedRoles: [], chapterMemberships: [{ chapterID: 'chapter-1', organizationID: 'org-1', selected: true }],
  organizationID: 'org-1', organizationRoles: [],
}) }));
vi.mock('../../services/supabase', () => ({ captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => null, session?.user?.id ?? 'member-1'),
  getSupabaseClient: () => null,
  loadMobileCollectiveActions: api.load, toggleMobileCollectiveActionParticipation: api.toggle,
  loadMobileOrganizationIntelligenceSnapshot: vi.fn(), requestMobileCollectiveActionExport: vi.fn(), saveMobileCollectiveAction: vi.fn(),
  saveMobileOrganizationChartNode: vi.fn(), saveMobileOrganizationRelationship: vi.fn(), saveMobileOrganizationTimelineEvent: vi.fn(),
  saveMobileOrganizationTopicProgress: vi.fn(),
}));

import { CollectiveActionsScreen } from './OrganizationIntelligenceScreens';
import { PayToolsScreen } from './PayToolsScreen';
import { buildNativePayActor, createMemoryPayCatalog, toPayActor } from '../../lib/mi1PayShared';

let screen: Rendered | null = null;
afterEach(async () => {
  await screen?.unmount(); screen = null; app.language = 'es'; spoken.length = 0;
  api.load.mockReset(); api.toggle.mockReset(); vi.restoreAllMocks();
});

// The stand-in's Alert takes no arguments; the screen passes a title, a body and buttons.
type AlertButton = { text: string; style: string; onPress?: () => void };
const alertHost: { alert: (title: string, body?: string, buttons?: AlertButton[]) => void } = Alert;

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

// Every English sentence the record names, and the rest of each screen's copy.
const PICKET_ENGLISH = [
  'Withdraw from this action?', 'You will no longer be counted as joined', 'Stay joined', 'Join petitions, rallies, pickets',
  'can export the list of who joined', 'Loading collective actions', 'Collective actions unavailable', 'No active actions',
  'Published actions will appear here', 'Participation withheld', 'joined ·', 'Goal reached', 'of goal', 'You joined as',
  'Join action', 'Refresh', 'The change was saved', 'The action could not be completed', "Only workers of this action's campaign",
];

describe('Digital Picket Line in Spanish', () => {
  const actions = [
    { id: 'a-1', kind: 'petition', status: 'published', title: 'Plantilla segura', summary: 'Firme antes del viernes.', targetCount: 100, participantCount: 12, strengthPercent: 12, viewerParticipation: 'signature' },
    { id: 'a-2', kind: 'rally', status: 'published', title: 'Mitin', summary: 'En la plaza.', targetCount: 10, participantCount: 10, strengthPercent: 100, viewerParticipation: null },
    { id: 'a-3', kind: 'rally', status: 'published', title: 'Otro campaña', summary: 'Sin acceso.', targetCount: 5, participantCount: null, strengthPercent: null, viewerParticipation: null, viewerCanJoin: false },
  ];

  it('shows the intro, every action line and the Withdraw confirmation in Spanish', async () => {
    api.load.mockResolvedValue({ organizationId: 'org-1', hasMore: false, actions });
    const alert = vi.spyOn(alertHost, 'alert').mockImplementation(() => undefined);
    screen = await render(h(CollectiveActionsScreen));
    await settle();
    const text = screen.container.textContent ?? '';
    for (const english of PICKET_ENGLISH) expect(text).not.toContain(english);
    for (const spanish of [
      'Piquete digital', 'Súmese a peticiones, manifestaciones, piquetes, reuniones y acciones voluntarias de su organización.',
      'pueden exportar la lista de quienes se unieron', '12 participan · meta 100', '12% de la meta', 'Participa como firmante.',
      'Meta alcanzada', 'Participación reservada · meta 5', 'Avance reservado', 'Solo los trabajadores de la campaña de esta acción pueden unirse.',
    ]) expect(text).toContain(spanish);
    expect(getExposed(screen.container, 'Unirse a la acción')).toBeTruthy();
    await press(getExposed(screen.container, 'Retirar'));
    expect(alert).toHaveBeenCalledTimes(1);
    const [title, body, buttons = []] = alert.mock.calls[0] ?? [''];
    expect(title).toBe('¿Retirarse de esta acción?');
    expect(body).toBe('Ya no se le contará como participante. Puede unirse de nuevo mientras la acción esté publicada.');
    expect(buttons.map((button) => [button.text, button.style])).toEqual([['Seguir participando', 'cancel'], ['Retirar', 'destructive']]);
  });

  it('says a failed join in Spanish, aloud and on screen', async () => {
    api.load.mockResolvedValue({ organizationId: 'org-1', hasMore: false, actions: [actions[1]] });
    api.toggle.mockRejectedValue(new Error('refused'));
    screen = await render(h(CollectiveActionsScreen));
    await settle();
    await press(getExposed(screen.container, 'Unirse a la acción'));
    await settle();
    expect(screen.container.textContent).toContain('No se pudo completar la acción.');
    expect(spoken).toContain('No se pudo completar la acción.');
  });

  it('shows the empty and unavailable states in Spanish', async () => {
    api.load.mockResolvedValue({ organizationId: 'org-1', hasMore: false, actions: [] });
    screen = await render(h(CollectiveActionsScreen));
    await settle();
    expect(screen.container.textContent).toContain('No hay acciones activas');
    expect(screen.container.textContent).toContain('Las acciones publicadas aparecerán aquí.');
    await screen.unmount();
    api.load.mockRejectedValue(new Error('offline'));
    screen = await render(h(CollectiveActionsScreen));
    await settle();
    expect(screen.container.textContent).toContain('Acciones colectivas no disponibles');
    expect(screen.container.textContent).toContain('No se muestran datos anteriores de acciones.');
  });

  it('keeps the English screen as it was', async () => {
    app.language = 'en';
    api.load.mockResolvedValue({ organizationId: 'org-1', hasMore: false, actions });
    const alert = vi.spyOn(alertHost, 'alert').mockImplementation(() => undefined);
    screen = await render(h(CollectiveActionsScreen));
    await settle();
    const text = screen.container.textContent ?? '';
    for (const english of ['12 joined · 100 goal', '12% of goal', 'You joined as signature.', 'Goal reached', 'Participation withheld · 5 goal']) expect(text).toContain(english);
    await press(getExposed(screen.container, 'Withdraw'));
    expect(alert.mock.calls[0]?.[0]).toBe('Withdraw from this action?');
  });
});

const PAY_ENGLISH = [
  'Estimates use', 'Pay-scale tables', 'Pay-scale comparison', 'From grade', 'Published grade', 'Comparison annual hours',
  'Enter the contract rule', 'Compare rates', 'Wage and back-pay calculator', 'Hourly rate', 'Regular hours', 'Overtime hours',
  'Optional', 'Night hours', 'Weekend hours', 'Standby hours', 'Amount already paid', 'Raise percent', 'Unpaid pay periods',
  'Estimate', 'Enter hours and either', 'Gross owed', 'Wage underpayment', 'Back pay', 'Hourly difference', 'Annual difference',
  'Per-paycheck difference', 'effective', 'Step ', 'loads no pay rates', 'Catalog publishing is restricted',
  'Check the hours', 'Check entries', 'Done', 'Ready', 'Nothing published', 'payroll',
];

function payActor(roles: string[] = [], mfaSatisfied = true) {
  return buildNativePayActor({ userId: 'member-1', organizationId: 'org-1', roles, authenticated: true, mfaSatisfied });
}

function publishedCatalog() {
  const catalog = createMemoryPayCatalog();
  const admin = toPayActor(payActor(['admin']));
  catalog.upsertGrade(admin, { organizationId: 'org-1', grade: 'A', title: 'Grado A' });
  catalog.upsertStep(admin, { organizationId: 'org-1', grade: 'A', stepNumber: 1, effectiveOn: '2026-01-01', hourlyRateCents: 2500 });
  catalog.upsertStep(admin, { organizationId: 'org-1', grade: 'A', stepNumber: 2, effectiveOn: '2026-01-01', hourlyRateCents: 3000 });
  return catalog;
}

it('shows readable published and comparison dates in English', async () => {
  app.language = 'en';
  const catalog = publishedCatalog();
  catalog.upsertStep(toPayActor(payActor(['admin'])), {
    organizationId: 'org-1', grade: 'A', stepNumber: 2, effectiveOn: '2027-07-01', hourlyRateCents: 3200,
  });
  screen = await render(h(PayToolsScreen, { actor: payActor(), api: { loadCatalog: async () => ({ ok: true, catalog }) } }));
  await settle();
  const container = screen.container;
  expect(container.textContent).toContain('A · Step 1 · $25.00 · effective Jan 1, 2026');
  for (const [label, value] of [
    ['From grade', 'A'], ['From step', '1'], ['From date', '2026-06-01'],
    ['To grade', 'A'], ['To step', '2'], ['To date', '2027-07-01'],
    ['Comparison annual hours', '2080'], ['Comparison paychecks per year', '26'],
  ]) await type(getExposed(container, label!), value!);
  await press(getExposed(container, 'Compare rates'));
  expect(container.textContent).toContain('From A · Step 1 · $25.00 · effective Jan 1, 2026 · annual');
  expect(container.textContent).toContain('To A · Step 2 · $32.00 · effective Jul 1, 2027 · annual');
});

describe('Pay tools in Spanish', () => {
  it('labels every field and states every result in Spanish', async () => {
    screen = await render(h(PayToolsScreen, { actor: payActor(), api: { loadCatalog: async () => ({ ok: true, catalog: publishedCatalog() }) } }));
    await settle();
    const container = screen.container;
    expect(container.textContent).toContain('Disponible');
    expect(container.textContent).toContain('Ingresa las horas y una tarifa directa, o selecciona un grado y un escalón de la tabla publicada e ingresa la fecha de cálculo.');
    expect(container.textContent).toContain('A · Escalón 1 · $25.00 · vigente desde 1 ene 2026');
    // A run with nothing entered is refused, in Spanish, aloud and on screen.
    await press(getExposed(container, 'Calcular'));
    expect(container.textContent).toContain('Revisa los datos');
    expect(spoken.at(-1)).toMatch(/^(Revisa|Ingresa)/);
    await type(getExposed(container, 'Tarifa por hora'), '30');
    await type(getExposed(container, 'Horas regulares'), '10');
    await type(getExposed(container, 'Horas extra'), '2');
    await type(getExposed(container, 'Multiplicador de horas extra'), '1.5');
    await type(getExposed(container, 'Monto ya pagado'), '100');
    await type(getExposed(container, 'Porcentaje de aumento'), '5');
    await type(getExposed(container, 'Horas anuales'), '2080');
    await type(getExposed(container, 'Cheques de pago por año'), '26');
    await type(getExposed(container, 'Períodos de pago adeudados'), '2');
    await press(getExposed(container, 'Calcular'));
    let text = container.textContent ?? '';
    for (const spanish of ['Tarifa por hora $30.00', 'Tiempo regular · 10 h', 'Horas extra · 2 h', 'Total bruto adeudado: $390.00', 'Monto ya pagado $100.00', 'Pago insuficiente $290.00', 'Aumento 5%', 'Pago anual actual', 'Nuevo pago anual', 'Diferencia anual del aumento', 'Diferencia por cheque de pago', 'Pago retroactivo del aumento $240.00', 'Retroactivo $530.00', 'Listo']) expect(text).toContain(spanish);
    // 10 h × $30 + 2 h × $45 = $390 gross; $390 − $100 paid = $290; $290 + 2 periods × $120 raise = $530.
    expect(spoken.at(-1)).toBe('Estimado de pago. Total bruto adeudado: $390.00. Pago insuficiente $290.00. Retroactivo $530.00.');
    await type(getExposed(container, 'Grado inicial'), 'A');
    await type(getExposed(container, 'Escalón inicial'), '1');
    await type(getExposed(container, 'Fecha inicial'), '2026-06-01');
    await type(getExposed(container, 'Grado final'), 'A');
    await type(getExposed(container, 'Escalón final'), '2');
    await type(getExposed(container, 'Fecha final'), '2026-06-01');
    await type(getExposed(container, 'Horas anuales de la comparación'), '2080');
    await type(getExposed(container, 'Cheques de pago por año de la comparación'), '26');
    await press(getExposed(container, 'Comparar tarifas'));
    text = container.textContent ?? '';
    for (const spanish of ['Desde A · Escalón 1 · $25.00 · vigente desde 1 ene 2026 · anual', 'Hasta A · Escalón 2 · $30.00 · vigente desde 1 ene 2026 · anual', 'Diferencia por hora $5.00', 'Diferencia anual', 'La publicación del catálogo está restringida']) expect(text).toContain(spanish);
    // $30 − $25 = $5 an hour; × 2080 h = $10,400 a year; ÷ 26 paychecks = $400.
    expect(spoken.at(-1)).toBe('Comparación de escala salarial. Diferencia por hora $5.00. Diferencia anual $10400.00. Diferencia por cheque de pago $400.00.');
    for (const english of PAY_ENGLISH) expect(text, english).not.toContain(english);
    for (const field of ['Horas nocturnas', 'Horas de fin de semana', 'Horas de guardia', 'Grado', 'Escalón']) expect(getExposed(container, field)).toBeTruthy();
  });

  it('says an unreachable catalog and an empty scale in Spanish', async () => {
    screen = await render(h(PayToolsScreen, { actor: payActor(), api: { loadCatalog: async () => ({ ok: false }) } }));
    await settle();
    expect(screen.container.textContent).toContain('No se pudo acceder al catálogo salarial. Inténtalo de nuevo.');
    expect(screen.container.textContent).toContain('Catálogo no disponible');
    await press(getExposed(screen.container, 'Comparar tarifas'));
    expect(getExposed(screen.container, 'Reintentar el catálogo')).toBeTruthy();
    expect(spoken.at(-1)).toBe('No se pudo acceder al catálogo salarial. Inténtalo de nuevo.');
    await screen.unmount();
    screen = await render(h(PayToolsScreen, { actor: payActor(), api: { loadCatalog: async () => ({ ok: true, catalog: createMemoryPayCatalog() }) } }));
    await settle();
    expect(screen.container.textContent).toContain('Esta organización aún no ha agregado sus tarifas salariales del contrato.');
    expect(screen.container.textContent).toContain('Nada publicado');
  });

  it.each([
    {
      language: 'en', publish: 'Publish rate', grade: 'Rate grade (required)', step: 'Catalog step (required)',
      date: 'Rate effective date (required)', rate: 'Published hourly rate (required)',
      gradeError: 'Enter a published rate grade of 1 to 32 characters on one line.',
      stepError: 'Step must be a whole number from 1 to 99.',
      dateError: 'Enter a valid effective date as YYYY-MM-DD.',
      rateError: 'Enter an hourly rate from $0.01 to $100,000.',
    },
    {
      language: 'es', publish: 'Publicar tarifa', grade: 'Grado de la tarifa (obligatorio)', step: 'Escalón del catálogo (obligatorio)',
      date: 'Fecha de vigencia de la tarifa (obligatorio)', rate: 'Tarifa por hora publicada (obligatorio)',
      gradeError: 'Escribe un grado publicado de 1 a 32 caracteres en una sola línea.',
      stepError: 'El escalón debe ser un número entero del 1 al 99.',
      dateError: 'Escribe una fecha de vigencia válida como AAAA-MM-DD.',
      rateError: 'Escribe una tarifa por hora de $0.01 a $100,000.',
    },
  ])('explains each blocked rate field in $language before dispatching a write', async (entry) => {
    app.language = entry.language === 'es' ? 'es' : 'en';
    const upsertStep = vi.fn(async () => ({ ok: true }));
    const publisher = {
      loadCatalog: async () => ({ ok: true, catalog: publishedCatalog() }),
      upsertGrade: vi.fn(async () => ({ ok: true })),
      upsertStep,
    };
    screen = await render(h(PayToolsScreen, { actor: payActor(['vp']), api: publisher }));
    await settle();
    const container = screen.container;
    async function expectReason(reason: string) {
      await press(getExposed(container, entry.publish));
      expect(container.textContent).toContain(reason);
      expect(getExposed(container, entry.publish).getAttribute('aria-description')).toBe(reason);
      expect(spoken.at(-1)).toBe(reason);
      expect(upsertStep).not.toHaveBeenCalled();
    }

    await expectReason(entry.gradeError);
    await type(getExposed(container, entry.grade), 'A');
    expect(container.textContent).not.toContain(entry.gradeError);
    await type(getExposed(container, entry.step), '100');
    await expectReason(entry.stepError);
    await type(getExposed(container, entry.step), '1');
    await type(getExposed(container, entry.date), '2026-02-30');
    await expectReason(entry.dateError);
    await type(getExposed(container, entry.date), entry.language === 'en' ? ' 2026-02-28 ' : '2026-02-28');
    await type(getExposed(container, entry.rate), '0');
    await expectReason(entry.rateError);
    await type(getExposed(container, entry.rate), '31.50');
    await press(getExposed(container, entry.publish));
    await settle();
    expect(upsertStep).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      organizationId: 'org-1', grade: 'A', stepNumber: 1, effectiveOn: '2026-02-28', hourlyRate: 31.5,
    });
    expect(container.textContent).not.toContain(entry.rateError);
  });

  it('explains blocked grade fields before publishing a valid grade', async () => {
    app.language = 'en';
    const upsertGrade = vi.fn(async () => ({ ok: true }));
    screen = await render(h(PayToolsScreen, {
      actor: payActor(['vp']),
      api: {
        loadCatalog: async () => ({ ok: true, catalog: publishedCatalog() }),
        upsertGrade,
        upsertStep: vi.fn(async () => ({ ok: true })),
      },
    }));
    await settle();
    const container = screen.container;

    await press(getExposed(container, 'Publish grade'));
    expect(container.textContent).toContain('Enter a catalog grade of 1 to 32 characters on one line.');
    await type(getExposed(container, 'Catalog grade (required)'), 'B');
    await press(getExposed(container, 'Publish grade'));
    expect(container.textContent).toContain('Enter a grade title of 1 to 120 characters.');
    await type(getExposed(container, 'Grade title (required)'), 'Grade B');
    await type(getExposed(container, 'Number of steps'), '1.5');
    await press(getExposed(container, 'Publish grade'));
    expect(container.textContent).toContain('Number of steps must be a whole number from 1 to 99.');
    expect(upsertGrade).not.toHaveBeenCalled();
    await type(getExposed(container, 'Number of steps'), '2');
    await press(getExposed(container, 'Publish grade'));
    await settle();
    expect(upsertGrade).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      organizationId: 'org-1', grade: 'B', title: 'Grade B', jobFamily: null, stepCount: 2, description: null,
    });
  });

  it('runs the publisher in Spanish', async () => {
    const upsertGrade = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, reason: 'invalid_input' }).mockRejectedValueOnce(new Error('offline'));
    const upsertStep = vi.fn().mockResolvedValue({ ok: false, reason: 'denied' });
    screen = await render(h(PayToolsScreen, { actor: payActor(['admin']), api: { loadCatalog: async () => ({ ok: true, catalog: publishedCatalog() }), upsertGrade, upsertStep } }));
    await settle();
    const container = screen.container;
    expect(container.textContent).toContain('Publicar registros de escala salarial');
    await type(getExposed(container, 'Grado del catálogo (obligatorio)'), 'B');
    await type(getExposed(container, 'Título del grado (obligatorio)'), 'Grado B');
    await press(getExposed(container, 'Publicar grado'));
    await settle();
    expect(container.textContent).toContain('Publicado');
    expect(container.textContent).toContain('Grado publicado para la organización seleccionada.');
    expect(spoken).toContain('Grado publicado para la organización seleccionada.');
    await press(getExposed(container, 'Publicar grado'));
    await settle();
    expect(container.textContent).toContain('No publicado');
    expect(container.textContent).toContain('Revisa los campos del catálogo e inténtalo de nuevo.');
    await press(getExposed(container, 'Publicar grado'));
    await settle();
    expect(container.textContent).toContain('No se pudo publicar el registro de escala salarial. Inténtalo de nuevo.');
    await type(getExposed(container, 'Grado de la tarifa (obligatorio)'), 'B');
    await type(getExposed(container, 'Escalón del catálogo (obligatorio)'), '1');
    await type(getExposed(container, 'Fecha de vigencia de la tarifa (obligatorio)'), '2026-01-01');
    await type(getExposed(container, 'Tarifa por hora publicada (obligatorio)'), '31');
    await press(getExposed(container, 'Publicar tarifa'));
    await settle();
    expect(spoken.at(-1)).toBe('No se pudo publicar el registro de escala salarial. Inténtalo de nuevo.');
  });

  it('asks for two-step sign-in before publishing, in Spanish', async () => {
    screen = await render(h(PayToolsScreen, { actor: payActor(['admin'], false), api: { loadCatalog: async () => ({ ok: true, catalog: publishedCatalog() }) } }));
    await settle();
    expect(screen.container.textContent).toContain('Se requiere MFA');
    expect(screen.container.textContent).toContain('Completa MFA antes de publicar registros de escala salarial.');
    await screen.unmount();
    screen = await render(h(PayToolsScreen, { actor: payActor(['admin']), api: { loadCatalog: async () => ({ ok: true, catalog: publishedCatalog() }) } }));
    await settle();
    expect(screen.container.textContent).toContain('Publicación del catálogo no disponible');
  });
});
