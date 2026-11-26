import { useFocusEffect } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { AppState, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { Text, TextInput } from '../components/Text';
import type Svg from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SavedChartGraphic } from '../components/SavedChartGraphic';
import { Body, Button, Card, Heading, StateMessage } from '../components/ui';
import { useAccessibilityAnnouncementQueue } from '../lib/announce';
import { explicitLiveStaffHat } from '../lib/hatFunctions';
import { withReadDeadline } from '../lib/readDeadline';
import { useReduceMotion } from '../lib/reduceMotion';
import { useNativeUi } from '../lib/useNativeUi';
import { CHART_FORMS, MEASURE_LABELS, NEW_CHART, chartReference, chartShareable, type ChartFigures, type ChartSpec, type SavedChart } from '../lib/savedPulseCharts';
import { chartDestinations, chartOptions, exportChartPNG, listCharts, loadChart, previewChart, pulseChartClient, removeChart, saveChart, shareChart, type ChartRpc } from '../services/savedPulseCharts';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

const CHART_TITLE_MAX = 100;

type ChartState = { charts: SavedChart[]; canBuild: boolean; client: ChartRpc; hat: string; refresh: () => void; valid: () => boolean };
const ChartContext = createContext<ChartState | null>(null);
export function useSavedPulseChartCount() { return useContext(ChartContext)?.charts.length ?? 0; }
// The verified built charts for the Customize sheet; null until verified.
export function useSavedPulseCharts(): SavedChart[] | null { return useContext(ChartContext)?.charts ?? null; }
// Where the chart-list read stands, so a sheet line can name the control that
// is really on screen: pending (bounded by the read deadline), failed (with
// Retry saved charts shown) or known.
export type SavedPulseChartsStatus = 'pending' | 'failed' | 'known';
const ChartStatusContext = createContext<SavedPulseChartsStatus>('pending');
export function useSavedPulseChartsStatus(): SavedPulseChartsStatus { return useContext(ChartStatusContext); }
export function usePulseChartActor() {
  const app = useApp();
  const hat = explicitLiveStaffHat(app.authorizedRoles ?? []) ?? 'member';
  return { app, hat, key: JSON.stringify([app.mode, app.session?.access_token, app.organizationID, app.dashboard?.member.chapterID, hat, app.authorizedRoles, app.sessionRestricted]) };
}
export function SavedPulseProvider({ children }: PropsWithChildren) {
  const { key } = usePulseChartActor();
  return <SavedPulseScope key={key}>{children}</SavedPulseScope>;
}
function SavedPulseScope({ children }: PropsWithChildren) {
  const { app, hat } = usePulseChartActor();
  const [charts, setCharts] = useState<SavedChart[]>([]);
  const [failed, setFailed] = useState(false);
  const [verified, setVerified] = useState(false);
  const [canBuild, setCanBuild] = useState(false);
  const [attempt, retry] = useState(0);
  const alive = useRef(false);
  const valid = useCallback(() => alive.current, []);
  const refresh = useCallback(() => retry((value) => value + 1), []);
  const client = useMemo(() => {
    if (!app.session?.access_token) return null;
    try { return pulseChartClient(app.session); } catch { return null; }
  }, [app.session]);
  // Stable captured-session port; a role/account/organization change remounts
  // this boundary. No async completion may paint into the successor scope.
  const clientRef = useRef(client);
  useFocusEffect(useCallback(() => {
    let current = true;
    alive.current = true;
    setCharts([]); setFailed(false); setVerified(false); setCanBuild(false);
    const captured = clientRef.current;
    if (app.mode === 'authenticated' && captured && !app.sessionRestricted) {
      // The existing read deadline: a list read that never answers reaches the
      // failure state and its Retry instead of holding Customize shut (#9394).
      void withReadDeadline(listCharts(captured, hat)).then((next) => {
        if (!current || !alive.current) return;
        setCharts(next); setVerified(true);
        // A platform workspace may list no charts without having a union
        // chart context. Only the server-checked options enable the builder.
        void chartOptions(captured, hat).then(() => { if (current && alive.current) setCanBuild(true); })
          .catch(() => { if (current && alive.current) setCanBuild(false); });
      })
        .catch(() => { if (current && alive.current) setFailed(true); });
    }
    const listener = AppState.addEventListener('change', (state) => {
      if (state !== 'active') { current = false; alive.current = false; setCharts([]); setVerified(false); setCanBuild(false); }
      else retry((value) => value + 1);
    });
    return () => { current = false; alive.current = false; setCharts([]); setVerified(false); setCanBuild(false); listener.remove(); };
  }, [app.mode, app.sessionRestricted, hat, attempt]));
  const shown = verified && clientRef.current && app.mode === 'authenticated' && !app.sessionRestricted;
  return <ChartStatusContext.Provider value={failed ? 'failed' : shown ? 'known' : 'pending'}><ChartContext.Provider value={shown ? { charts, canBuild, client: clientRef.current!, hat, refresh, valid } : null}>
    {failed ? <StateMessage title="Saved charts could not load" body="Saved charts didn’t load. Try again." action={<Button label="Retry saved charts" onPress={() => retry((value) => value + 1)} />} /> : null}
    {children}
  </ChartContext.Provider></ChartStatusContext.Provider>;
}

function Choices<T extends string>({ label, values, value, onChange, labels }: { label: string; values: readonly T[]; value: T; onChange: (value: T) => void; labels?: Partial<Record<T, string>> }) {
  const theme = useTheme();
  return <View style={{ gap: spacing.sm }}><Heading level={3}>{label}</Heading><View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>{values.map((item) => <Pressable key={item} accessibilityRole="radio" accessibilityLabel={`${label}: ${labels?.[item] ?? item}`} accessibilityState={{ checked: value === item }} onPress={() => onChange(item)} style={{ minHeight: minimumTouchTarget, borderRadius: radii.sm, borderWidth: 1, borderColor: theme.foreground, padding: spacing.sm, justifyContent: 'center', backgroundColor: value === item ? theme.primary : theme.card }}><Text style={{ color: value === item ? theme.primaryForeground : theme.cardForeground }}>{labels?.[item] ?? item}</Text></Pressable>)}</View></View>;
}
export function Sheet({ children, title, onClose }: PropsWithChildren<{ title: string; onClose: () => void }>) {
  const theme = useTheme(), insets = useSafeAreaInsets(), reduce = useReduceMotion();
  return <Modal visible animationType={reduce ? 'none' : 'slide'} presentationStyle="pageSheet" onRequestClose={onClose} accessibilityViewIsModal><ScrollView style={{ backgroundColor: theme.card }} contentContainerStyle={{ gap: spacing.md, padding: spacing.lg, paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.lg }} keyboardShouldPersistTaps="handled"><Button label="Close" variant="secondary" onPress={onClose} /><Heading>{title}</Heading>{children}</ScrollView></Modal>;
}

// order: the person's saved Pulse layout (#8927), built-chart ids in its
// order. Without it (Home, or no saved layout) the slot is unchanged.
export function SavedChartSlot({ position, order = null }: { position: 'pinned' | 'catalogue' | 'home'; order?: readonly string[] | null }) {
  const context = useContext(ChartContext);
  const [editing, setEditing] = useState<SavedChart | 'new' | null>(null);
  const [sharing, setSharing] = useState<SavedChart | null>(null);
  const [undo, setUndo] = useState<{ id: string; until: number } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (!context) return null;
  const { charts, canBuild, client, hat, refresh, valid } = context;
  const placed = charts.filter((chart) => position === 'home' ? chart.home : position === 'pinned' ? chart.pinned : !chart.pinned);
  const shown = order && position !== 'home' ? order.flatMap((id) => placed.filter((chart) => chart.id === id)) : placed;
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await action(); if (valid()) refresh(); }
    catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : 'Chart change failed.'); }
    // The slot outlives a blur or background, so a change that settles then
    // must still release its buttons; only figures, errors and undo wait for valid().
    finally { setBusy(false); }
  };
  return <View style={{ gap: spacing.md }}>
    {shown.length ? <Heading level={2}>{position === 'home' ? 'Your pinned charts' : position === 'pinned' ? 'Pinned charts' : 'Your charts'}</Heading> : null}
    {shown.map((chart) => <Card key={chart.id}><Heading level={3}>★{charts.indexOf(chart) + 1} · {chart.title}</Heading><Body muted>{chart.spec.period.replace('m', ' months')} · {chart.spec.breakdown} · {chart.spec.measure === 'my_actions' ? 'Your figures' : chart.spec.level === 'local' ? 'Local' : 'Campaign'} · {chart.scope}</Body>
      <SavedChartGraphic figures={chart.figures} form={chart.spec.form} title={chart.title} period={chart.spec.period} level={chart.spec.level} arrivalKey={`saved-chart:${chart.id}`} />
      <Body muted>Counted from {chart.figures.countedFrom || 'currently unavailable records.'}</Body>
      <Body muted>{chart.figures.person ? 'Personal figures. Sharing is disabled.' : `Every viewer uses their own access. Groups under ${chart.figures.floor} are withheld.`}</Body>
      {position !== 'home' ? <>{canBuild ? <Button label={`Edit ${chart.title}`} variant="secondary" disabled={busy} onPress={() => setEditing(chart)} /> : null}
        <Button label={chart.pinned ? `Unpin ${chart.title}` : `Pin ${chart.title}`} variant="secondary" disabled={busy || chart.figures.unavailable} onPress={() => { void perform(() => saveChart(client, hat, { ...chart, pinned: !chart.pinned, home: false })); }} />
        {chart.pinned ? <Button label={chart.home ? `Remove ${chart.title} from Home` : `Also show ${chart.title} on Home`} variant="secondary" disabled={busy} onPress={() => { void perform(() => saveChart(client, hat, { ...chart, home: !chart.home })); }} /> : null}
        {chartShareable(chart) ? <Button label={`Share ${chart.title}`} variant="secondary" disabled={busy} onPress={() => setSharing(chart)} /> : null}
        <Button label={`Remove ${chart.title}`} variant="secondary" disabled={busy} onPress={() => { void perform(async () => { await removeChart(client, chart.id); if (valid()) setUndo({ id: chart.id, until: Date.now() + 30000 }); }); }} />
      </> : null}</Card>)}
    {error ? <Body>{error}</Body> : null}
    {undo ? <><Body>Chart removed. Undo is available for thirty seconds.</Body><Button label="Undo remove chart" disabled={busy} onPress={() => { const pending = undo; setUndo(null); if (Date.now() < pending.until) void perform(() => removeChart(client, pending.id, true)); else setError('Undo expired. You can add the chart again.'); }} /></> : null}
    {position === 'catalogue' ? <>{canBuild ? <Button label="Add a chart" onPress={() => setEditing('new')} /> : null}<Button label="Refresh saved charts" variant="secondary" onPress={refresh} /></> : null}
    {canBuild && editing ? <ChartBuilder key={editing === 'new' ? 'new' : editing.id} chart={editing === 'new' ? null : editing} context={context} onClose={() => setEditing(null)} /> : null}
    {sharing ? <ChartShare key={sharing.id} chart={sharing} context={context} onClose={() => setSharing(null)} /> : null}
  </View>;
}

function ChartBuilder({ chart, context, onClose }: { chart: SavedChart | null; context: ChartState; onClose: () => void }) {
  const theme = useTheme();
  const { t } = useNativeUi();
  const [title, setTitle] = useState(chart?.title ?? 'Your action sign-ups');
  const [spec, setSpec] = useState<ChartSpec>(chart?.spec ?? NEW_CHART);
  const [scope, setScope] = useState<SavedChart['scope']>(chart?.scope ?? 'personal');
  const [options, setOptions] = useState<Awaited<ReturnType<typeof chartOptions>> | null>(null);
  const [figures, setFigures] = useState<ChartFigures | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [attempt, retry] = useState(0);
  const { client, hat, valid, refresh } = context;
  const titleMissing = !title.trim();
  const titleLabel = t('Chart title (required, up to {count} characters)', { count: CHART_TITLE_MAX });
  const titleNeeded = t('Give your chart a title.');
  const announceTitle = useAccessibilityAnnouncementQueue(useId());
  useEffect(() => {
    if (titleMissing && Platform.OS === 'ios') return announceTitle(titleNeeded);
  }, [announceTitle, titleMissing, titleNeeded]);
  useEffect(() => { let active = true;
    void chartOptions(client, hat).then((value) => { if (active && valid()) setOptions(value); }).catch(() => { if (active && valid()) setError('Chart choices could not load. Close and retry.'); });
    return () => { active = false; };
  }, [client, hat, valid]);
  useEffect(() => { let active = true; setFigures(null); setError('');
    void previewChart(client, hat, spec).then((value) => { if (active && valid()) setFigures(value); }).catch(() => { if (active && valid()) setError('The preview didn’t load. Try again before saving.'); });
    return () => { active = false; };
  }, [client, hat, spec, attempt, valid]);
  async function save() {
    if (!figures || figures.unavailable || titleMissing || busy) return;
    setBusy(true); setError('');
    try { await saveChart(client, hat, { id: chart?.id, title, spec, scope, pinned: chart?.pinned ?? false, home: chart?.home ?? false }); if (valid()) { refresh(); onClose(); } }
    catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : 'Chart could not save.'); }
    finally { if (valid()) setBusy(false); }
  }
  const person = spec.measure === 'my_actions';
  const units = options?.units.filter((unit) => spec.level === 'local' || unit.current !== false) ?? [];
  return <Sheet title={chart ? 'Edit chart' : 'Add a chart'} onClose={onClose}>
    <Body>Choose a recorded measure. Preview and the counted-from line update before you save.</Body>
    <Body>{titleLabel}</Body>
    <TextInput accessibilityLabel={titleLabel} value={title} onChangeText={setTitle} maxLength={CHART_TITLE_MAX} keyboardAppearance={theme.appearance} selectionColor={theme.primary} placeholderTextColor={theme.quietForeground} style={{ color: theme.foreground, backgroundColor: theme.card, borderColor: theme.foreground, borderWidth: 1, borderRadius: radii.sm, minHeight: minimumTouchTarget, padding: spacing.sm }} />
    {options ? <>
      <Choices label="Measure" values={options.measures} labels={MEASURE_LABELS} value={spec.measure} onChange={(measure) => { setSpec({ version: 1, measure, breakdown: 'month', period: spec.period, form: spec.form }); setTitle(MEASURE_LABELS[measure]); if (measure === 'my_actions') setScope('personal'); }} />
      {!person ? <Choices label="Population" values={options.levels} value={spec.level ?? 'chapter'} onChange={(level) => { const next = { ...spec, level }; delete next.unitID; setSpec(next); }} /> : null}
      <Choices label="Breakdown" values={person ? ['month'] : spec.measure === 'meeting_turnout' ? ['month', 'meeting', ...(hat === 'admin' ? ['unit' as const] : [])] : ['month', ...(hat === 'admin' ? ['unit' as const] : [])]} value={spec.breakdown} onChange={(breakdown) => setSpec({ ...spec, breakdown })} />
      {!person && units.length ? <Choices label="Unit" values={['all', ...units.map((unit) => unit.id)]} labels={Object.fromEntries([['all', 'All units'], ...units.map((unit) => [unit.id, unit.name])])} value={spec.unitID ?? 'all'} onChange={(unit) => { const { unitID: _prior, ...rest } = spec; setSpec(unit === 'all' ? rest : { ...rest, unitID: unit }); }} /> : null}
      {spec.measure === 'visible_cases' ? <Choices label="Issue type" values={['all', 'Discipline', 'Scheduling', 'Telework', 'Safety', 'Pay', 'Other']} value={spec.caseType ?? 'all'} onChange={(kind) => { const { caseType: _prior, ...rest } = spec; setSpec(kind === 'all' ? rest : { ...rest, caseType: kind }); }} /> : null}
      <Choices label="Period" values={['3m', '6m', '12m']} value={spec.period} onChange={(period) => setSpec({ ...spec, period })} />
      <Choices label="Form" values={CHART_FORMS} value={spec.form} onChange={(form) => setSpec({ ...spec, form })} />
      <Choices label="Who may open it" values={person ? ['personal'] : hat === 'member' ? ['personal', 'chapter'] : ['personal', 'chapter', 'organization']} value={scope} onChange={setScope} labels={{ chapter: 'campaign' }} />
    </> : <Body>Loading authorized measures…</Body>}
    <Heading level={2}>Live preview</Heading>
    {figures ? <><SavedChartGraphic figures={figures} form={spec.form} title={title} period={spec.period} level={spec.level} arrivalKey={`saved-chart-preview:${chart?.id ?? 'new'}`} /><Body>Counted from {figures.countedFrom}</Body><Body muted>{person ? 'This measure describes you. It cannot be shared or exported.' : `Every count shown covers at least ${figures.floor} different people. If one part is smaller, the whole breakdown is hidden, including filtered forms.`}</Body></> : <Body>Checking current figures…</Body>}
    {error ? <><Body>{error}</Body><Button label="Retry chart preview" variant="secondary" onPress={() => retry((value) => value + 1)} /></> : null}
    <View accessibilityLiveRegion="polite">{titleMissing ? <Body>{titleNeeded}</Body> : null}</View>
    <Button label={t(busy ? 'Saving chart…' : 'Save chart')} disabled={busy || !options || !figures || figures.unavailable || titleMissing} onPress={() => { void save(); }} />
  </Sheet>;
}

function ChartShare({ chart, context, onClose }: { chart: SavedChart; context: ChartState; onClose: () => void }) {
  const { client, hat, valid } = context;
  const [targets, setTargets] = useState<Awaited<ReturnType<typeof chartDestinations>>>([]);
  const [fresh, setFresh] = useState<SavedChart | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [sent, setSent] = useState(false);
  const svg = useRef<Svg | null>(null);
  useEffect(() => { let active = true;
    void Promise.all([loadChart(client, hat, chart.id, true), chartDestinations()]).then(([current, destinations]) => {
      if (active && valid()) { setFresh(current); setTargets(destinations); }
    }).catch(() => { if (active && valid()) setError('This chart didn’t load. Close it and try again.'); });
    return () => { active = false; };
  }, [client, hat, chart.id, valid]);
  async function send(kind: 'chapter' | 'message', id: string) {
    setBusy(true); setError('');
    try { await shareChart(client, hat, chart.id, kind, id); if (valid()) setSent(true); }
    catch { if (valid()) setError('The chart could not be sent. The destination must allow your message and the viewer must have chart access.'); }
    finally { if (valid()) setBusy(false); }
  }
  async function picture() {
    setBusy(true); setError('');
    try {
      const latest = await loadChart(client, hat, chart.id, true);
      if (!valid() || !chartShareable(latest) || latest.figures.withheld) throw new Error('Chart unavailable.');
      // Discard a changed snapshot instead of exporting old figures from the
      // mounted SVG. A second tap exports the newly rendered authorized read.
      if (JSON.stringify(latest) !== JSON.stringify(fresh)) { setFresh(latest); throw new Error('Figures changed. Review the updated chart, then export again.'); }
      const bytes = await new Promise<string>((resolve, reject) => { if (!svg.current) reject(new Error('Picture is not ready.')); else svg.current.toDataURL(resolve, { width: 1280, height: 1920 }); });
      if (!valid()) return;
      await exportChartPNG(bytes, valid);
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : 'Picture could not export.'); }
    finally { if (valid()) setBusy(false); }
  }
  return <Sheet title={`Share ${chart.title}`} onClose={onClose}><Body>The live chart links to your figures instead of copying them. Each viewer sees it through their own current role, the quarterly survey requirement and the privacy minimum.</Body>
    {sent ? <Body>Chart sent.</Body> : null}
    {fresh && chartShareable(fresh) ? <><SavedChartGraphic ref={svg} figures={fresh.figures} form={fresh.spec.form} title={fresh.title} period={fresh.spec.period} level={fresh.spec.level} picture />
      {targets.filter((target) => target.kind !== 'chapter' || fresh.scope === 'chapter').map((target) => <Button key={`${target.kind}:${target.id}`} label={`Send to ${target.kind === 'chapter' ? 'campaign space' : 'direct message'}: ${target.title}`} disabled={busy} variant="secondary" onPress={() => { void send(target.kind, target.id); }} />)}
      {!targets.length ? <Body>No existing share destination is available. Open a campaign space or a direct conversation in Messages first.</Body> : null}
      <Body muted>Exporting a picture shares the displayed figures with the app you choose. That copy cannot update or be withdrawn. Small groups and personal measures cannot be exported.</Body>
      <Button label="Export picture" disabled={busy || fresh.figures.withheld} onPress={() => { void picture(); }} />
    </> : null}{error ? <Body>{error}</Body> : null}
  </Sheet>;
}

export function LiveChartMessage({ body }: { body: string }) {
  const { key } = usePulseChartActor();
  const id = chartReference(body);
  return id ? <LiveChartReference key={`${key}:${id}`} id={id} /> : null;
}
function LiveChartReference({ id }: { id: string }) {
  const { app, hat } = usePulseChartActor();
  const [chart, setChart] = useState<SavedChart | null>(null), [failed, setFailed] = useState(false), [attempt, retry] = useState(0);
  useFocusEffect(useCallback(() => {
    let active = true; setChart(null); setFailed(false);
    if (!app.session || app.mode !== 'authenticated' || app.sessionRestricted) return;
    void loadChart(pulseChartClient(app.session), hat, id).then((next) => { if (active) setChart(next); }).catch(() => { if (active) setFailed(true); });
    const listener = AppState.addEventListener('change', (state) => { if (state !== 'active') { active = false; setChart(null); } else retry((value) => value + 1); });
    return () => { active = false; setChart(null); listener.remove(); };
  }, [app.session, app.mode, app.sessionRestricted, hat, id, attempt]));
  return <Card><Heading level={3}>{chart?.title ?? 'Live chart'}</Heading>{chart ? <><SavedChartGraphic figures={chart.figures} form={chart.spec.form} title={chart.title} period={chart.spec.period} level={chart.spec.level} arrivalKey={`saved-chart-live:${id}`} /><Body muted>Counted from {chart.figures.countedFrom}</Body></> : <Body>{failed ? 'Chart unavailable for your current access, or removed by its owner.' : 'Checking your current access…'}</Body>}<Button label="Refresh live chart" variant="secondary" onPress={() => retry((value) => value + 1)} /></Card>;
}
