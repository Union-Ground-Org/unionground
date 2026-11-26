// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NEW_CHART, type ChartFigures, type SavedChart } from '../lib/savedPulseCharts';
import type { classifyQuarterlyGate } from '../lib/memberSurveysShared';
import { resolveTheme } from '../theme/tokens';
const runtime = vi.hoisted(() => ({ app: { mode: 'authenticated', session: { access_token: 'test', user: { id: 'user-a' } }, organizationID: 'org-a', dashboard: { member: { chapterID: 'chapter-a' as string | null } }, authorizedRoles: [] as string[], sessionRestricted: false },
  list: vi.fn(), options: vi.fn(), preview: vi.fn(), save: vi.fn(), remove: vi.fn(), load: vi.fn(), share: vi.fn(), destinations: vi.fn(), picture: vi.fn(),
  listeners: new Set<(state: string) => void>(), appearance: 'union-ground', queueAnnouncement: vi.fn(),
  memberLanguage: 'en',
  gate: vi.fn<() => Promise<ReturnType<typeof classifyQuarterlyGate>>>(),
  push: vi.fn<(route: string) => void>(),
}));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ ...runtime.app, memberLanguage: runtime.memberLanguage }) }));
vi.mock('../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => runtime.queueAnnouncement }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => resolveTheme('union-ground', runtime.appearance === 'union-ground-dark') }));
vi.mock('../lib/reduceMotion', () => ({ useReduceMotion: () => true }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('../services/savedPulseCharts', () => ({ pulseChartClient: () => ({ rpc: () => {} }), listCharts: runtime.list, chartOptions: runtime.options, previewChart: runtime.preview, saveChart: runtime.save, removeChart: runtime.remove, loadChart: runtime.load, shareChart: runtime.share, chartDestinations: runtime.destinations, exportChartPNG: runtime.picture }));
vi.mock('expo-router', async () => { const react = await import('react'); return { useFocusEffect: (callback: () => (() => void) | void) => react.useEffect(callback, [callback]), useIsFocused: () => true, useRouter: () => ({ push: runtime.push }) }; });
vi.mock('../services/memberSurveys', () => ({ loadMobileQuarterlySurveyGateStatus: runtime.gate }));
vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const text = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return {
    View: ({ children, accessibilityLabel, accessibilityLiveRegion }: { children?: ReactNode; accessibilityLabel?: string; accessibilityLiveRegion?: 'polite' }) =>
      h('div', { 'aria-label': accessibilityLabel, 'aria-live': accessibilityLiveRegion }, children),
    Text: text, ScrollView: text, Platform: { OS: 'ios' }, StyleSheet: { create: <T,>(styles: T) => styles },
    Modal: ({ children }: { children?: ReactNode }) => h('div', { role: 'dialog' }, children),
    TextInput: ({ value, onChangeText, accessibilityLabel }: { value: string; onChangeText: (value: string) => void; accessibilityLabel: string }) => h('input', { value, onChange: (e) => onChangeText(e.currentTarget.value), 'aria-label': accessibilityLabel }),
    Pressable: ({ children, onPress, accessibilityLabel }: { children?: ReactNode; onPress: () => void; accessibilityLabel: string }) => h('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
    AppState: { addEventListener: (_: string, fn: (state: string) => void) => { runtime.listeners.add(fn); return { remove: () => runtime.listeners.delete(fn) }; } },
  };
});
vi.mock('react-native-svg', async () => {
  const { createElement: h, forwardRef, useImperativeHandle } = await import('react');
  const text = ({ children }: { children?: ReactNode }) => h('g', null, children);
  return { default: forwardRef(function Svg({ children }: { children?: ReactNode }, ref) { useImperativeHandle(ref, () => ({ toDataURL: (callback: (value: string) => void) => callback('YWJj') })); return h('svg', null, children); }), Text: text, Line: text, Rect: text, Circle: text, Polyline: text };
});
vi.mock('../components/ui', async () => {
  const { createElement: h } = await import('react');
  const text = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return { Body: text, Heading: text, Card: text, Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => h('button', { onClick: onPress, disabled }, label), StateMessage: ({ title, body, action }: { title: string; body: string; action?: ReactNode }) => h('div', null, title, body, action) };
});
import { LiveChartMessage, SavedChartSlot, SavedPulseProvider, useSavedPulseChartCount, useSavedPulseCharts, useSavedPulseChartsStatus } from './SavedPulseCharts';
import { READ_DEADLINE_MS } from '../lib/readDeadline';
import { SavedChartGraphic, savedChartSourceText } from '../components/SavedChartGraphic';
import { QuarterlySurveyGate } from '../components/QuarterlySurveyGate';
const ID = '11111111-1111-4111-8111-111111111111';
const figures = { rows: [{ label: '2026-11', value: 27 }], countedFrom: 'Recorded sign-ups.', floor: 25, person: false, withheld: false, locked: false, unavailable: false };
const chart: SavedChart = { id: ID, title: 'Recorded action sign-ups', spec: { ...NEW_CHART, measure: 'published_actions' }, scope: 'chapter', pinned: false, home: false, owned: true, figures };
let host: HTMLDivElement, root: Root;
function content() { return createElement(SavedPulseProvider, null, createElement(SavedChartSlot, { position: 'pinned' }), createElement(SavedChartSlot, { position: 'catalogue' })); }
async function render(node: ReactNode = content()) { await act(async () => { root.render(node); }); }
async function click(label: string) { const node = Array.from(host.querySelectorAll('button')).find((item) => item.textContent === label || item.getAttribute('aria-label') === label); expect(node, label).toBeTruthy(); await act(async () => { node!.click(); }); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.resetAllMocks(); runtime.listeners.clear(); runtime.appearance = 'union-ground';
  runtime.memberLanguage = 'en';
  runtime.app.organizationID = 'org-a'; runtime.app.authorizedRoles = []; runtime.app.mode = 'authenticated'; runtime.app.sessionRestricted = false;
  runtime.app.dashboard.member.chapterID = 'chapter-a';
  runtime.list.mockResolvedValue([chart]); runtime.options.mockResolvedValue({ measures: ['my_actions', 'published_actions', 'meeting_turnout', 'visible_cases'], levels: ['chapter', 'local'], units: [{ id: ID, name: 'North', current: true }] }); runtime.preview.mockResolvedValue(figures); runtime.load.mockResolvedValue(chart); runtime.destinations.mockResolvedValue([{ id: ID, title: 'General', kind: 'chapter' }, { id: 'dm', title: 'Conversation', kind: 'message' }]);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('renders the quarterly survey check, lock and retry states in Spanish', async () => {
  runtime.memberLanguage = 'es';
  let finishCheck!: (answer: ReturnType<typeof classifyQuarterlyGate>) => void;
  runtime.gate.mockReturnValueOnce(new Promise((resolve) => { finishCheck = resolve; }));
  await render(createElement(QuarterlySurveyGate, null, 'Contenido de estadísticas'));
  expect(host.textContent).toContain('Comprobando la encuesta de este trimestre…');
  expect(host.textContent).not.toContain('Contenido de estadísticas');
  await act(async () => { finishCheck({ status: 'error', gate: null }); });
  expect(host.textContent).toContain('No se pudo comprobar la encuesta de este trimestre');
  runtime.gate.mockResolvedValueOnce({ status: 'locked', gate: { periodKey: '2026-Q4', surveyId: 'survey-a', required: true, completed: false, unlocked: false } });
  await click('Reintentar');
  expect(host.textContent).toContain('Desbloquea tus estadísticas y gráficos del T4 de 2026');
  expect(host.textContent).not.toContain('Contenido de estadísticas');
  await click('Responder la encuesta');
  expect(runtime.push).toHaveBeenCalledWith('/feature/voting');
});

it.each<[Partial<ChartFigures>, string]>([
  [{ locked: true }, 'Responde la encuesta trimestral para ver estos datos.'],
  [{ withheld: true }, 'Datos reservados: al menos un grupo tiene menos de 25 personas.'],
  [{ unavailable: true }, 'No se pudieron cargar los datos. Actualiza para volver a intentarlo.'],
  [{ rows: [] }, 'No hay datos registrados en este período.'],
])('renders the saved chart state %o in Spanish', async (change, message) => {
  runtime.memberLanguage = 'es';
  await render(createElement(SavedChartGraphic, { title: 'Mi gráfico', form: 'line', figures: { ...figures, ...change } }));
  expect(host.textContent).toContain(message);
  expect(host.textContent).not.toMatch(/No recorded figures|Complete the quarterly survey|Withheld:|Figures didn’t load/);
  if (change.rows) expect(host.querySelector('[aria-label^="Mi gráfico. Sin datos registrados."]')).not.toBeNull();
});

describe('native saved chart controls', () => {
  it('localizes the chart source caption in Spanish and preserves supplied source wording', async () => {
    runtime.memberLanguage = 'es';
    await render(createElement(SavedChartGraphic, { title: 'Inscripciones', form: 'line', figures }));
    expect(host.textContent).toContain('Fuente: Inscripciones registradas.');
    expect(host.textContent).not.toContain('Recorded sign-ups.');

    const writtenSource = 'Counts from the North team.';
    await render(createElement(SavedChartGraphic, { title: 'Inscripciones', form: 'line', figures: { ...figures, countedFrom: writtenSource } }));
    expect(host.textContent).toContain(`Fuente: ${writtenSource}`);
  });
  it.each([
    {
      measure: 'personal sign-ups',
      person: true,
      countedFrom: 'Your recorded collective-action sign-ups, grouped by Eastern calendar month. Other people and product analytics are excluded.',
    },
    {
      measure: 'published campaign sign-ups',
      countedFrom: 'Recorded sign-ups to published collective actions for this campaign. Private drafts, cancelled actions and product analytics are excluded.',
    },
    {
      measure: 'published local sign-ups',
      countedFrom: 'Recorded sign-ups to published collective actions for your local. Private drafts, cancelled actions and product analytics are excluded.',
    },
    {
      measure: 'campaign meetings',
      countedFrom: 'Recorded check-ins at non-cancelled campaign meetings that have started. RSVPs and unrecorded attendance are excluded.',
    },
    {
      measure: 'local meetings',
      countedFrom: 'Recorded check-ins at non-cancelled authorized meetings in your local that have started. RSVPs and unrecorded attendance are excluded.',
    },
  ])('renders the full Spanish source caption for $measure', async ({ countedFrom, person = false }) => {
    runtime.memberLanguage = 'es';
    await render(createElement(SavedChartGraphic, { title: 'Inscripciones', form: 'line', figures: { ...figures, person, countedFrom } }));
    const text = [...host.querySelectorAll('svg > g')].map((line) => line.textContent ?? '');
    const sourceStart = text.findIndex((line) => line.startsWith('Fuente: '));
    expect(sourceStart).toBeGreaterThanOrEqual(0);
    expect(text.slice(sourceStart).join(' ')).toBe(`Fuente: ${savedChartSourceText(countedFrom, 'es')}`);
  });
  it.each<[string, string | null]>([
    ['union-ground', 'chapter-a'], ['union-ground', null],
    ['union-ground-dark', 'chapter-a'], ['union-ground-dark', null],
  ])('keeps an empty platform-admin list honest in %s with campaign %s', async (appearance, chapterID) => {
    runtime.appearance = appearance;
    runtime.app.organizationID = 'platform-org'; runtime.app.authorizedRoles = ['admin'];
    runtime.app.dashboard.member.chapterID = chapterID;
    runtime.list.mockResolvedValue([]);
    runtime.options.mockRejectedValue(new Error('chart unavailable'));
    runtime.preview.mockRejectedValue(new Error('chart unavailable'));
    await render();
    expect(host.textContent).not.toContain('Saved charts could not load');
    expect(host.textContent).not.toContain('Add a chart');
    expect(host.querySelector('[role=dialog]')).toBeNull();
    expect(runtime.options).toHaveBeenCalledWith(expect.anything(), 'admin');
    await click('Refresh saved charts');
    expect(runtime.list).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain('Add a chart');
    expect(runtime.preview).not.toHaveBeenCalled(); expect(runtime.save).not.toHaveBeenCalled();
  });
  it('lets a verified union worker build and save from an empty list', async () => {
    runtime.list.mockResolvedValue([]);
    await render(); await click('Add a chart'); await click('Save chart');
    expect(runtime.save).toHaveBeenCalledWith(expect.anything(), 'member', expect.objectContaining({ spec: NEW_CHART }));
    expect(host.querySelector('[role=dialog]')).toBeNull();
  });
  it.each([
    ['en', 'Chart title (required, up to 100 characters)', 'Save chart', 'Give your chart a title.'],
    ['es', 'Título del gráfico (obligatorio, hasta 100 caracteres)', 'Guardar gráfico', 'Dale un título a tu gráfico.'],
  ])('names the chart title requirement when Save chart is blocked in %s', async (language, label, saveLabel, reason) => {
    runtime.memberLanguage = language;
    await render();
    await click('Add a chart');
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(label);
    const input = dialog.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    const status = dialog.querySelector('[aria-live="polite"]')!;
    expect(status.textContent).toBe('');
    const writeTitle = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };

    await writeTitle('   ');
    expect(status.textContent).toBe(reason);
    expect(runtime.queueAnnouncement).toHaveBeenCalledExactlyOnceWith(reason);
    const saveButton = [...dialog.querySelectorAll('button')].find((button) => button.textContent === saveLabel)!;
    expect(saveButton.disabled).toBe(true);
    await click(saveLabel);
    expect(runtime.save).not.toHaveBeenCalled();

    await writeTitle('My chart');
    expect(status.textContent).toBe('');
    expect(saveButton.disabled).toBe(false);
    await click(saveLabel);
    expect(runtime.save).toHaveBeenCalledWith(expect.anything(), 'member', expect.objectContaining({ title: 'My chart' }));
  });
  it('waits for chart capability and rejects a late capability result from another workspace', async () => {
    let resolve!: () => void;
    runtime.options.mockReturnValueOnce(new Promise<void>((done) => { resolve = done; }));
    await render();
    expect(host.textContent).toContain('Recorded action sign-ups');
    expect(host.textContent).not.toContain('Add a chart');
    expect(host.textContent).not.toContain('Edit Recorded action sign-ups');
    runtime.app.organizationID = 'platform-org'; runtime.app.authorizedRoles = ['admin'];
    runtime.list.mockResolvedValue([]); runtime.options.mockRejectedValue(new Error('chart unavailable'));
    await render(); await act(async () => { resolve(); });
    expect(host.textContent).not.toContain('Add a chart');
    expect(host.querySelector('[role=dialog]')).toBeNull();
    expect(runtime.preview).not.toHaveBeenCalled();
  });
  it('withdraws an open builder when the refreshed workspace cannot build charts', async () => {
    await render(); await click('Add a chart');
    expect(host.querySelector('[role=dialog]')).not.toBeNull();
    runtime.list.mockResolvedValue([]); runtime.options.mockRejectedValue(new Error('chart unavailable'));
    await act(async () => { for (const listener of runtime.listeners) listener('background'); });
    await act(async () => { for (const listener of [...runtime.listeners]) listener('active'); });
    expect(host.querySelector('[role=dialog]')).toBeNull();
    expect(host.textContent).not.toContain('Add a chart');
    expect(host.textContent).not.toContain('Saved charts could not load');
    expect(runtime.preview).toHaveBeenCalledTimes(1);
  });
  it('connects the worker catalogue filter to the verified saved-chart read', async () => {
    function Counter() { return createElement('span', null, useSavedPulseChartCount()); }
    await render(createElement(SavedPulseProvider, null, createElement(Counter)));
    expect(host.textContent).toBe('1');
  });
  it('builds from role choices, previews each change, and saves only the checked spec', async () => {
    await render(); await click('Add a chart');
    expect(host.textContent).toContain('Live preview'); expect(host.textContent).toContain('Counted from Recorded sign-ups.');
    await click('Measure: Campaign action sign-ups'); await click('Form: line'); await click('Period: 3m'); await click('Who may open it: campaign'); await click('Save chart');
    expect(runtime.save).toHaveBeenCalledWith(expect.anything(), 'member', expect.objectContaining({ spec: { ...NEW_CHART, measure: 'published_actions', form: 'line', period: '3m' }, scope: 'chapter' }));
    expect(host.querySelector('[role=dialog]')).toBeNull();
  });
  it('edits and removes exactly one chart with undo, and unpins both destinations', async () => {
    await render(); await click('Edit Recorded action sign-ups'); await click('Save chart');
    expect(runtime.save).toHaveBeenCalledWith(expect.anything(), 'member', expect.objectContaining({ id: ID }));
    await click('Pin Recorded action sign-ups'); expect(runtime.save).toHaveBeenLastCalledWith(expect.anything(), 'member', expect.objectContaining({ pinned: true, home: false }));
    await click('Remove Recorded action sign-ups'); expect(runtime.remove).toHaveBeenCalledWith(expect.anything(), ID); await click('Undo remove chart'); expect(runtime.remove).toHaveBeenLastCalledWith(expect.anything(), ID, true);
    runtime.list.mockResolvedValue([{ ...chart, pinned: true, home: true }]); await click('Refresh saved charts');
    await click('Remove Recorded action sign-ups from Home'); expect(runtime.save).toHaveBeenLastCalledWith(expect.anything(), 'member', expect.objectContaining({ home: false }));
    await click('Unpin Recorded action sign-ups'); expect(runtime.save).toHaveBeenLastCalledWith(expect.anything(), 'member', expect.objectContaining({ pinned: false, home: false }));
  });
  it('sends live references to existing campaign/DM destinations and exports the revalidated SVG', async () => {
    await render(); await click('Share Recorded action sign-ups'); await click('Send to campaign space: General'); expect(runtime.share).toHaveBeenCalledWith(expect.anything(), 'member', ID, 'chapter', ID);
    await click('Send to direct message: Conversation'); expect(runtime.share).toHaveBeenLastCalledWith(expect.anything(), 'member', ID, 'message', 'dm');
    await click('Export picture'); expect(runtime.picture).toHaveBeenCalledWith('YWJj', expect.any(Function));
    runtime.load.mockResolvedValue({ ...chart, figures: { ...figures, rows: [{ label: '2026-11', value: 30 }] } });
    await click('Export picture'); expect(host.textContent).toContain('Figures changed'); expect(runtime.picture).toHaveBeenCalledTimes(1);
    runtime.share.mockRejectedValue(new Error()); await click('Send to direct message: Conversation'); expect(host.textContent).toContain('could not be sent');
  });
  it('releases the chart buttons when a change settles while Pulse is in the background', async () => {
    let settle!: () => void;
    runtime.remove.mockImplementation(() => new Promise<void>((resolve) => { settle = resolve; }));
    await render(); await click('Remove Recorded action sign-ups');
    const remove = () => Array.from(host.querySelectorAll('button')).find((item) => item.textContent === 'Remove Recorded action sign-ups');
    expect(remove()?.disabled).toBe(true);
    await act(async () => { for (const listener of runtime.listeners) listener('background'); });
    await act(async () => { settle(); });
    await act(async () => { for (const listener of [...runtime.listeners]) listener('active'); });
    expect(remove()?.disabled).toBe(false);
    expect(host.textContent).not.toContain('Undo is available');
  });
  it('withdraws figures and sheets on background, rejects an old account result, and retries failures', async () => {
    await render(); await click('Share Recorded action sign-ups');
    await act(async () => { for (const listener of runtime.listeners) listener('background'); }); expect(host.textContent).not.toContain('Recorded action sign-ups'); expect(host.querySelector('[role=dialog]')).toBeNull();
    await act(async () => { for (const listener of [...runtime.listeners]) listener('active'); }); expect(host.textContent).toContain('Recorded action sign-ups');
    let resolve!: (value: SavedChart[]) => void; runtime.list.mockReturnValueOnce(new Promise<SavedChart[]>((done) => { resolve = done; }));
    await click('Close'); await click('Refresh saved charts'); runtime.app.organizationID = 'org-b'; runtime.list.mockResolvedValue([]); await render();
    await act(async () => { resolve([{ ...chart, title: 'Old account figures' }]); }); expect(host.textContent).not.toContain('Old account figures');
    runtime.list.mockRejectedValueOnce(new Error()); await click('Refresh saved charts'); expect(host.textContent).toContain('Saved charts could not load'); await click('Retry saved charts'); expect(host.textContent).toContain('Add a chart');
  });
  it('never offers Share for a person chart, handles unavailable/locked previews and server write failures', async () => {
    runtime.list.mockResolvedValue([{ ...chart, spec: NEW_CHART, figures: { ...figures, person: true } }]); await render();
    expect(host.textContent).not.toContain('Share Recorded action sign-ups'); await click('Add a chart');
    runtime.preview.mockRejectedValueOnce(new Error()); await click('Form: table'); expect(host.textContent).toContain('The preview didn’t load'); await click('Retry chart preview');
    runtime.save.mockRejectedValueOnce(new Error('Save refused')); await click('Save chart'); expect(host.textContent).toContain('Save refused');
    runtime.preview.mockResolvedValue({ ...figures, locked: true, rows: [] }); await click('Period: 6m'); expect(host.textContent).toContain('Complete the quarterly survey'); await click('Close');
    runtime.list.mockResolvedValue([{ ...chart, figures: { ...figures, unavailable: true } }]); await click('Refresh saved charts'); expect(host.textContent).toContain('Figures didn’t load');
  });
  it('opens a shared marker only under the viewer scope and refreshes it after a refusal', async () => {
    await render(createElement(LiveChartMessage, { body: `[pulse-chart:${ID}]` })); expect(runtime.load).toHaveBeenCalledWith(expect.anything(), 'member', ID); expect(host.textContent).toContain('Recorded sign-ups.');
    runtime.load.mockRejectedValueOnce(new Error()); await click('Refresh live chart'); expect(host.textContent).toContain('Chart unavailable for your current access');
    await click('Refresh live chart'); expect(host.textContent).toContain('Recorded action sign-ups');
    await render(createElement(LiveChartMessage, { body: 'ordinary message' })); expect(host.textContent).toBe('');
  });
  it('renders every form, whole-breakdown suppression and personal copy in both themes', async () => {
    for (const theme of ['union-ground', 'union-ground-dark']) { runtime.appearance = theme;
      for (const form of ['bars', 'line', 'stack', 'meter', 'table'] as const) { await render(createElement(SavedChartGraphic, { title: 'Chart', form, figures })); expect(host.textContent).toContain('27'); }
      for (const change of [{ withheld: true }, { locked: true }, { unavailable: true }, { person: true }]) { await render(createElement(SavedChartGraphic, { title: 'Chart', form: 'bars', figures: { ...figures, ...change } })); expect(host.textContent).toBeTruthy(); }
    }
    runtime.list.mockResolvedValue([{ ...chart, pinned: true, home: true }]); await render(createElement(SavedPulseProvider, null, createElement(SavedChartSlot, { position: 'home' }))); expect(host.textContent).toContain('Your pinned charts'); expect(host.textContent).not.toContain('Edit Recorded');
  });
  it('narrows authorized admin issues by unit/type and resets identity-sensitive choices when measures change', async () => {
    runtime.app.authorizedRoles = ['admin']; await render(); await click('Add a chart');
    await click('Measure: Issues your role may read'); await click('Population: local'); await click('Breakdown: unit'); await click('Unit: North'); await click('Issue type: Safety'); await click('Who may open it: organization');
    await click('Save chart'); expect(runtime.save).toHaveBeenLastCalledWith(expect.anything(), 'admin', expect.objectContaining({ scope: 'organization', spec: expect.objectContaining({ unitID: ID, caseType: 'Safety', breakdown: 'unit', level: 'local' }) }));
    await click('Add a chart'); await click('Measure: Issues your role may read'); await click('Unit: North'); await click('Unit: All units'); await click('Issue type: Safety'); await click('Issue type: all');
    await click('Measure: Meeting check-ins'); await click('Breakdown: meeting'); await click('Measure: Your action sign-ups'); await click('Save chart');
    expect(runtime.save).toHaveBeenLastCalledWith(expect.anything(), 'admin', expect.objectContaining({ scope: 'personal', spec: NEW_CHART }));
  });
  it('reports write/options/destination/export failures without success claims, and expires Undo', async () => {
    await render(); runtime.remove.mockRejectedValueOnce(new Error('Remove refused')); await click('Remove Recorded action sign-ups'); expect(host.textContent).toContain('Remove refused');
    await click('Remove Recorded action sign-ups'); const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31000); await click('Undo remove chart'); clock.mockRestore(); expect(host.textContent).toContain('Undo expired');
    runtime.options.mockRejectedValueOnce(new Error()); await click('Add a chart'); expect(host.textContent).toContain('choices could not load'); await click('Close');
    runtime.destinations.mockRejectedValueOnce(new Error()); await click('Share Recorded action sign-ups'); expect(host.textContent).toContain('This chart didn’t load'); await click('Close');
    runtime.destinations.mockResolvedValue([]); await click('Share Recorded action sign-ups'); expect(host.textContent).toContain('No existing share destination');
    runtime.picture.mockRejectedValueOnce(new Error('OS refused')); await click('Export picture'); expect(host.textContent).toContain('OS refused');
  });
  it('renders empty and truncated charts without inventing values, and clears live messages in the background', async () => {
    await render(createElement(SavedChartGraphic, { title: 'Empty', form: 'line', figures: { ...figures, rows: [] } })); expect(host.textContent).toContain('No recorded figures');
    await render(createElement(SavedChartGraphic, { title: 'Long', form: 'bars', figures: { ...figures, rows: Array.from({ length: 30 }, (_, index) => ({ label: `Month ${index}`, value: 27 })) } })); expect(host.textContent).toContain('Chart shows the first 24');
    await render(createElement(LiveChartMessage, { body: `[pulse-chart:${ID}]` }));
    await act(async () => { for (const listener of runtime.listeners) listener('background'); }); expect(host.textContent).not.toContain('Recorded action sign-ups');
    await act(async () => { for (const listener of [...runtime.listeners]) listener('active'); }); expect(host.textContent).toContain('Recorded action sign-ups');
    runtime.app.mode = 'preview'; await render(); expect(host.textContent).toBe('');
    runtime.app.mode = 'authenticated'; runtime.app.sessionRestricted = true; await render(); expect(host.textContent).toBe('');
  });
  it('places built charts in the saved Pulse layout order, hides those it leaves out, and leaves Home alone (#8927)', async () => {
    const second = { ...chart, id: '22222222-2222-4222-8222-222222222222', title: 'Second chart' }, third = { ...chart, id: '33333333-3333-4333-8333-333333333333', title: 'Third chart', pinned: true, home: true };
    runtime.list.mockResolvedValue([chart, second, third]);
    let seen: SavedChart[] | null = null;
    function Probe() { seen = useSavedPulseCharts(); return null; }
    const slots = (order: string[] | null) => createElement(SavedPulseProvider, null, createElement(Probe), createElement(SavedChartSlot, { position: 'pinned', order }), createElement(SavedChartSlot, { position: 'catalogue', order }), createElement(SavedChartSlot, { position: 'home' }));
    await render(slots([second.id, third.id]));
    expect(seen!.map((item: SavedChart) => item.id)).toEqual([ID, second.id, third.id]);
    expect(host.textContent).not.toContain('Recorded action sign-ups');
    expect(host.textContent!.indexOf('Third chart')).toBeLessThan(host.textContent!.indexOf('Second chart'));
    // Home is not part of the Pulse layout: its pinned chart still shows there.
    expect(host.textContent).toContain('Your pinned charts');
    await render(slots(null));
    expect(host.textContent!.indexOf('Recorded action sign-ups')).toBeLessThan(host.textContent!.indexOf('Second chart'));
    await render(slots([second.id, ID]));
    expect(host.textContent!.indexOf('Second chart')).toBeLessThan(host.textContent!.indexOf('Recorded action sign-ups'));
    // The builder and refresh controls stay, whatever the layout holds.
    await render(slots([])); expect(host.textContent).not.toContain('Second chart'); expect(host.textContent).toContain('Add a chart'); expect(host.textContent).toContain('Refresh saved charts');
  });
  it('a chart-list read that never answers reaches the failure state and its Retry at the read deadline, then recovers (#9394 r1s1)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const states: string[] = [];
      function Probe() { states.push(useSavedPulseChartsStatus()); return null; }
      await render(createElement(SavedPulseProvider, null, createElement(Probe), createElement(SavedChartSlot, { position: 'pinned' }), createElement(SavedChartSlot, { position: 'catalogue' })));
      expect(host.textContent).toContain('Recorded action sign-ups'); expect(states.at(-1)).toBe('known');
      runtime.list.mockReturnValueOnce(new Promise(() => {}));
      await click('Refresh saved charts'); expect(states.at(-1)).toBe('pending'); expect(host.textContent).not.toContain('Retry saved charts');
      await act(async () => { await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS); });
      expect(host.textContent).toContain('Saved charts could not load'); expect(states.at(-1)).toBe('failed');
      await click('Retry saved charts');
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(host.textContent).toContain('Recorded action sign-ups'); expect(states.at(-1)).toBe('known');
    } finally { vi.useRealTimers(); }
  });
});
