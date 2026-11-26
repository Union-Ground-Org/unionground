import { useNativeUi } from '../lib/useNativeUi';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, AppState, View } from 'react-native';
import { PulseCatalogCard, PulseExpandSheet } from '../components/PulseCatalog';
import { Body, Button, Card, Heading, Screen, StateMessage } from '../components/ui';
import { useNativeTabContentInset } from '../lib/chrome';
import { leadershipPulseForDisplay, type LeadershipHat, type LeadershipPulse } from '../lib/leadershipPulse';
import { PULSE_HEALTH_BANDS, pulseUpdated, type PulseCard } from '../lib/pulseCatalog';
import { CASEWORK_CHARTS, caseworkTitle, isCaseworkKey } from '../lib/pulseCasework';
import type { SavedChart } from '../lib/savedPulseCharts';
import { loadLeadershipPulse } from '../services/leadershipPulse';
import { ReadDeadlineError, withReadDeadline } from '../lib/readDeadline';
import { loadPulseCasework, pulseCaseworkClient } from '../services/pulseCasework';
import { arrangePulse, cardLayoutKey, createPulseLayoutSession, layoutKind, layoutWithout, moveLayoutEntry, pulseLayoutClient, savedLayoutKey, standardLayoutEntries, type PulseLayout, type PulseLayoutEntry, type PulseLayoutSession } from '../services/pulseLayout';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { pulsePalette } from '../theme/pulsePalette';
import { spacing } from '../theme/tokens';
import { usePulseOpening } from './PulseOpeningPreference';
import { SavedChartSlot, Sheet, useSavedPulseCharts, useSavedPulseChartsStatus, type SavedPulseChartsStatus } from './SavedPulseCharts';
import { usePulseHistory } from './usePulseHistory';

export default function LeadershipPulseScreen({ hat }: { hat: LeadershipHat }) {
  const app = useApp();
  return <LeadershipPulseContent key={JSON.stringify([hat, app.mode, app.session?.access_token, app.organizationID, app.dashboard?.member.chapterID, app.sessionRestricted])} hat={hat} />;
}
function LeadershipPulseContent({ hat }: { hat: LeadershipHat }) {
  const { catalogLabel, language } = useNativeUi();
  const { mode, session, organizationID, dashboard, sessionRestricted } = useApp();
  const [readData, setData] = useState<LeadershipPulse | null>(null), [failed, setFailed] = useState(false), [busy, setBusy] = useState(false), [attempt, retry] = useState(0);
  const data = useMemo(() => leadershipPulseForDisplay(readData, language), [readData, language]);
  const [expanded, setExpanded] = useState<string | null>(null), [page, setPage] = useState(0), [showWeek, setShowWeek] = useState(false);
  const preference = usePulseOpening(), router = useRouter(), theme = useTheme(), inset = useNativeTabContentInset();
  const workspaceReady = Boolean(dashboard), chapterID = dashboard?.member.chapterID ?? null;
  // History is per chapter; a chapterless advisor reads none rather than a failure.
  const history = usePulseHistory(hat, attempt, Boolean(chapterID));
  const charts = useSavedPulseCharts();
  // Adding or removing a built chart changes the keys the server offers, so
  // the layout is read again (r1s2); a list still loading is no change.
  const layout = usePulseLayout(hat, attempt, charts ? charts.map((chart) => chart.id).sort().join(',') : null, useSavedPulseChartsStatus());
  useFocusEffect(useCallback(() => {
    // #9459 M3-2: a hung read ends at the shared deadline, as on the other Pulse screens (#8769).
    const controller = new AbortController(), read = new AbortController(); setData(null); setExpanded(null); setFailed(false); setPage(0); setShowWeek(false);
    const load = () => {
      if (mode !== 'authenticated' || !session || !organizationID || !workspaceReady || (hat !== 'advisor' && !chapterID) || sessionRestricted) return;
      setBusy(true);
      void withReadDeadline(loadLeadershipPulse(session, hat, organizationID, chapterID, read.signal))
        .then((value) => { if (!controller.signal.aborted) setData(value); })
        .catch((error: unknown) => { if (error instanceof ReadDeadlineError) read.abort(); if (!controller.signal.aborted) setFailed(true); })
        .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    };
    load();
    const listener = AppState.addEventListener('change', (state) => { if (state !== 'active') { controller.abort(); read.abort(); setData(null); setExpanded(null); setBusy(false); } else retry((value) => value + 1); });
    return () => { controller.abort(); read.abort(); listener.remove(); };
  }, [mode, session, organizationID, workspaceReady, chapterID, sessionRestricted, hat, attempt]));
  const ready = useCaseworkCharts(layout.current, attempt);
  const weekVisible = preference.failed || preference.value?.opening !== 'charts' || showWeek;
  const allCards = data ? [...data.cards, ...history.cards, ...ready] : [];
  const cards = data ? [...data.cards.map((item) => item.id === 'health' ? { ...item, rows: item.rows.slice(page * 20, page * 20 + 20) } : item), ...history.cards, ...ready] : [];
  const healthCount = data?.cards.find((item) => item.id === 'health')?.rows.length ?? 0;
  // Without a saved layout this is the standard Pulse, unchanged. A saved
  // layout orders the cards, pins some above This week and skips any card
  // the person cannot see now; numbers then follow what is drawn.
  // A ready-made chart the person added always draws its card, with its
  // withheld or unavailable note when there are no figures to show.
  const arranged = arrangePulse(layout.current, allCards.map((card) => ({ id: card.id, drawable: card.rows.length > 0 || card.id.startsWith('ready:') })), (charts ?? []).map((chart) => chart.id));
  const customized = Boolean(layout.current?.customized);
  const pick = (ids: string[], offset: number) => ids.flatMap((id) => cards.filter((card) => card.id === id)).map((card, index) => customized ? { ...card, number: String(offset + index + 1).padStart(2, '0') } : card);
  const pinnedCards = pick(arranged.pinned, 0), shownCards = pick(arranged.cards, pinnedCards.length), drawnCards = [...pinnedCards, ...shownCards];
  const nothingOn = customized && !drawnCards.length && !arranged.saved?.length;
  return <Screen tabRoot bottomInset={inset} refreshing={busy} onRefresh={() => retry((value) => value + 1)}>
    <Heading>{catalogLabel('Pulse')}</Heading><Body muted>{hat === 'vp' || hat === 'president' ? 'Campaign chair and VP' : `${hat[0]!.toUpperCase()}${hat.slice(1)}`} · {catalogLabel('Campaign and local totals')}</Body>
    {mode === 'preview' ? <StateMessage title="No preview records" body="Leadership Pulse uses recorded workspace aggregates. No roster or score is invented for this preview." /> : null}
    {mode === 'authenticated' && (!session || !organizationID || !dashboard) ? <StateMessage title="Leadership records are getting ready" body="Your current workspace must load before these figures can be checked." /> : null}
    {/* Every hat but the organization-wide advisor portfolio counts one selected chapter. */}
    {mode === 'authenticated' && session && organizationID && workspaceReady && !chapterID && hat !== 'advisor' ? <StateMessage title="Choose a campaign to see these figures" body="Leadership figures for this role are counted for one campaign. Select your campaign on Home, then return to Pulse." /> : null}
    {busy ? <Body muted>Checking your current role and reporting populations…</Body> : null}
    {failed ? <StateMessage title="Leadership Pulse could not load" body="Leadership figures didn’t load. Try again." action={<Button label="Retry leadership Pulse" onPress={() => retry((value) => value + 1)} />} /> : null}
    {data ? <>
      <SavedChartSlot position="pinned" order={arranged.saved} />
      {pinnedCards.length ? <><Heading level={2}>Pinned on your Pulse</Heading>{pinnedCards.map((item) => <PulseCatalogCard key={item.id} card={item} onOpen={() => setExpanded(item.id)} />)}</> : null}
      <Body muted>{pulseUpdated(data.updatedAt)}</Body>
      <LayoutNotices layout={layout} />
      {layout.current ? <Button label="Customize your Pulse" variant="secondary" onPress={() => layout.setOpen(true)} /> : null}
      {preference.failed ? <Body muted>Your opening choice could not be checked. This week is shown first.</Body> : null}
      {!preference.failed && preference.value?.opening === 'charts' ? <Button label={showWeek ? 'Hide This week' : 'Show This week'} variant="secondary" onPress={() => setShowWeek((value) => !value)} /> : null}
      {weekVisible ? <Card><Heading level={2}>This week</Heading><Heading level={3}>{data.week.title}</Heading><Body>{data.week.detail}</Body><Button label="Open your desk" onPress={() => router.push(data.week.href as never)} /></Card> : null}
      {hat === 'advisor' ? <View style={{ gap: spacing.sm }}>
        <Heading level={2}>{language === 'es' ? 'Niveles de salud' : 'Health bands'}</Heading>
        {PULSE_HEALTH_BANDS.map(({ min, max, label }, index) => <View key={min} style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
          <View accessibilityElementsHidden style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: pulsePalette(theme).tiers[index] }} />
          <Body>{label[language]} · {min}–{max}</Body>
        </View>)}
      </View> : null}
      {history.failed ? <Body muted>Weekly history didn’t load. Refresh to try again.</Body> : null}
      {nothingOn ? <Body muted>Your Pulse has no charts on it. Open Customize to add some.</Body> : null}
      {shownCards.map((item) => <PulseCatalogCard key={item.id} card={item} onOpen={() => setExpanded(item.id)} />)}
      {healthCount > 20 && drawnCards.some((item) => item.id === 'health') ? <View style={{ gap: spacing.sm }}><Body muted>Campaign page {page + 1} of {Math.ceil(healthCount / 20)}</Body><Button label="Previous campaigns" variant="secondary" disabled={page === 0} onPress={() => { setExpanded(null); setPage((value) => value - 1); }} /><Button label="Next campaigns" variant="secondary" disabled={(page + 1) * 20 >= healthCount} onPress={() => { setExpanded(null); setPage((value) => value + 1); }} /></View> : null}
      <PulseExpandSheet key={expanded ?? 'closed'} card={drawnCards.find((item) => item.id === expanded) ?? null} onClose={() => setExpanded(null)} />
      <SavedChartSlot position="catalogue" order={arranged.saved} />
      <Button label="Refresh leadership Pulse" variant="secondary" onPress={() => retry((value) => value + 1)} />
      {layout.open && layout.current ? <CustomizeSheet layout={layout} current={layout.current} cards={allCards} charts={charts} /> : null}
    </> : null}
  </Screen>;
}

// #8927 slice 3: the Casework charts on this person's saved layout, read once
// per change of that set, refresh, focus or return to the app. Nothing is
// read for a chart that is not on the Pulse, and a chart arrives once, when
// its read has answered; the standard Pulse reads none.
function useCaseworkCharts(layout: PulseLayout | null, attempt: number): PulseCard[] {
  const { mode, session, organizationID, dashboard, sessionRestricted } = useApp();
  const { language } = useNativeUi();
  const chapterID = dashboard?.member.chapterID ?? null;
  const keys = layout?.customized ? layout.entries.map((entry) => entry.key).filter(isCaseworkKey).sort().join(',') : '';
  const [loaded, setLoaded] = useState<{ keys: string; cards: PulseCard[] } | null>(null);
  useFocusEffect(useCallback(() => {
    if (!keys || mode !== 'authenticated' || !session || !organizationID || !chapterID || sessionRestricted) return;
    const controller = new AbortController();
    let client: ReturnType<typeof pulseCaseworkClient>;
    try { client = pulseCaseworkClient(session); } catch { return; } // swallow-ok: no secure backend means no live chart; nothing is drawn
    void loadPulseCasework(client, keys.split(','), chapterID, controller.signal, language).then((cards) => { if (!controller.signal.aborted) setLoaded({ keys, cards }); });
    const listener = AppState.addEventListener('change', (state) => { if (state !== 'active') { controller.abort(); setLoaded(null); } });
    return () => { controller.abort(); listener.remove(); };
  }, [keys, attempt, mode, session, organizationID, chapterID, sessionRestricted, language]));
  const on = keys ? keys.split(',') : [];
  return loaded ? loaded.cards.filter((card) => on.includes(card.id)) : [];
}

type Undo = { message: string; label: string; expired: string; entries: PulseLayoutEntry[] | null; focus: string; expiredFocus: string; until: number };
type LayoutControl = ReturnType<typeof usePulseLayout>;
// A sheet line a remount would lose (a token refresh, a
// hat, chapter or organization change, a restriction) waits here for the next
// mount of the same person, organization, chapter and hat, and is cleared by
// a mount for anyone else or for no one. It holds only which line is owed and
// the withdrawn layout's keys, never figures. refused is the layout a
// didn't-save line is about, so a read showing the server holds it clears it.
// settling: per owner, the writes still out from screens that unmounted. No
// read may decide a carried line while it is above zero (#9405 final r3s1,
// R-9405S): every unmounted screen of the layout must have settled. Every
// call ends under the read deadline, so it always returns to zero, and it is
// keyed by the owner, so it never reaches another person or layout.
// #9409 r2s1: newest is the outcome of the newest edit an old screen
// reported, by editOrder (it grows with every edit on every screen), never by
// arrival: failed means its didn't-save line is owed, about refused (null for
// the existing failed-save case); a saved or pause-covered newest edit owes
// none, and any older edit's outcome is then moot.
type Outcome = { order: number; failed: boolean; refused: string | null };
type OwedLine = { person: string; newest: Outcome | null; maybe: string | null };
const owedLines = new Map<string, OwedLine>(), owedListeners = new Set<() => void>(), settling = new Map<string, number>();
let editOrder = 0;
const unsettled = (owner: string) => (settling.get(owner) ?? 0) > 0;
const newer = (a: Outcome | null | undefined, b: Outcome | null | undefined) => (!a || (b && b.order > a.order) ? b ?? null : a);
function oweLine(owner: string, line: OwedLine) {
  const before = owedLines.get(owner);
  owedLines.set(owner, { person: line.person, newest: newer(before?.newest, line.newest), maybe: line.maybe ?? before?.maybe ?? null });
  owedListeners.forEach((listener) => listener());
}
// #8927 slice 3: this person's Pulse layout for the selected chapter and the
// held hat. The session lives as long as this mount, and the screen remounts
// for another person, organization, chapter, hat or session state, so a layout
// is never shown or saved across them. A change shows at once and is written
// in order; a write that fails or runs out of time puts back the last saved
// layout and reads the server again before anything else is written.
function usePulseLayout(hat: LeadershipHat, attempt: number, chartIDs: string | null, chartStatus: SavedPulseChartsStatus) {
  const { mode, session, organizationID, dashboard, sessionRestricted } = useApp();
  const person = mode === 'authenticated' ? session?.user?.id ?? '' : '';
  const owner = JSON.stringify([person, organizationID, dashboard?.member.chapterID ?? null, hat]);
  const [store] = useState<PulseLayoutSession | null>(() => {
    const chapterID = dashboard?.member.chapterID;
    if (mode !== 'authenticated' || !session || !chapterID || sessionRestricted) return null;
    try { return createPulseLayoutSession(pulseLayoutClient(session), chapterID, hat); } catch { return null; } // swallow-ok: no secure backend means no layout; the standard Pulse shows
  });
  const [saved, setSaved] = useState<PulseLayout | null>(null);
  const [draft, setDraft] = useState<PulseLayoutEntry[] | null | undefined>(undefined);
  const [readFailed, setReadFailed] = useState(false), [saveFailed, setSaveFailed] = useState(false), [reads, reread] = useState(0), [reading, setReading] = useState(false);
  const [undo, setUndo] = useState<Undo | null>(null), [expired, setExpired] = useState(''), [open, setOpen] = useState(false), [focus, setFocus] = useState<string | null>(null);
  const changes = useRef(0), ignoreBelow = useRef(0), live = useRef(false), targets = useRef(new Map<string, View>());
  useEffect(() => { live.current = true; return () => { live.current = false; store?.pause(); }; }, [store]);
  // r3s1: builtOn is the built-chart set the newest landed read was built on.
  // From the first known set on, Customize is editable only while the chart
  // list is known and equal to it. A list that is reloading or failed (null)
  // or changed withdraws the controls in that same render, and a known,
  // different set is read again before they return. Never known and read on
  // nothing (both null) is equal: the entries then hold only the server's keys.
  const latestCharts = useRef<string | null>(null), currentCharts = useRef<string | null>(null), wasUnsettled = useRef(false);
  const [builtOn, setBuiltOn] = useState<string | null>(null), [owed, setOwed] = useState(false), [maybeUnsaved, setMaybeUnsaved] = useState(false);
  const withdrawn = useRef<string | null>(null), coveredBelow = useRef(0), lines = useRef({ failed: false, maybe: false });
  // refused: the layout this mount's didn't-save line is about (null when the
  // line is the existing failed-save case). carried: the line came from an
  // earlier mount; once this mount has drawn its notices (drawn) it is not
  // carried again.
  const refused = useRef<string | null>(null), carried = useRef(false), drawn = useRef(false);
  // #9405 final r3s1: a carried line is decided only by a read that started
  // after every unmounted screen of this layout had no write out (readSeq
  // above verifyAfter, settling at zero). Until then a carried didn't-save waits in
  // pendingFail and a carried may-not-have-saved line is not cleared.
  // outstanding: this mount's writes still waiting for their answer.
  // pendingFail: the newest carried outcome that owes a line, still to be
  // decided; seen: the order of the newest carried outcome this mount took;
  // lineOrder: the edit a shown didn't-save line is about; mine: the outcome
  // of this mount's own latest edit once it settled (null while it is out).
  const outstanding = useRef(0), readSeq = useRef(0), verifyAfter = useRef(0), carriedMaybe = useRef(false), pendingFail = useRef<Outcome | undefined>(undefined);
  const seen = useRef(0), lineOrder = useRef(0), mine = useRef<Outcome | null>(null);
  const chartsUnsettled = chartIDs !== builtOn;
  // What this mount shows, so a remount can carry it; and the
  // line a remount left for this person, organization, chapter and hat. Any
  // other person's (or a signed-out) mount clears every line left for others.
  useLayoutEffect(() => { lines.current = { failed: saveFailed, maybe: maybeUnsaved }; });
  useEffect(() => {
    const take = () => {
      for (const [key, line] of owedLines) if (!person || line.person !== person) owedLines.delete(key);
      const line = store && live.current ? owedLines.get(owner) : undefined;
      if (!line) return;
      owedLines.delete(owner);
      // A change made on this mount is newer than the one the line is about.
      if (changes.current > 0) return;
      // Only an outcome newer than any this mount took counts. A newest edit
      // that saved, or that a pause line names, owes no didn't-save line.
      const outcome = line.newest;
      if (outcome && outcome.order > seen.current) {
        seen.current = outcome.order;
        if (outcome.failed) { pendingFail.current = outcome; carried.current = true; drawn.current = false; }
        else { pendingFail.current = undefined; refused.current = null; setSaveFailed(false); }
      }
      if (line.maybe !== null) { carried.current = true; drawn.current = false; withdrawn.current = line.maybe; carriedMaybe.current = true; setMaybeUnsaved(true); }
      // Every write of the screen that left it has settled: read again (unless the first read is still to start) and decide then.
      if (!unsettled(owner) && (pendingFail.current !== undefined || carriedMaybe.current)) { verifyAfter.current = readSeq.current; if (readSeq.current > 0) reread((value) => value + 1); }
    };
    take(); owedListeners.add(take);
    return () => {
      owedListeners.delete(take);
      if (store && outstanding.current > 0) settling.set(owner, (settling.get(owner) ?? 0) + outstanding.current);
      // The newest outcome this mount knows: its own latest edit's (none while
      // that edit is still out: its settle reports it), or else a carried one
      // still undecided, a carried line not yet drawn, or the order it took.
      const again = !(carried.current && drawn.current);
      const newest = changes.current > 0 ? mine.current
        : pendingFail.current ?? (lines.current.failed && again ? { order: lineOrder.current, failed: true, refused: refused.current } : seen.current > 0 ? { order: seen.current, failed: false, refused: null } : null);
      const maybe = lines.current.maybe && again ? withdrawn.current : null;
      if (store && (newest || maybe !== null)) oweLine(owner, { person, newest, maybe });
    };
  }, [store, owner, person]);
  // #9394 r1s3: the moment a landed layout's chart set becomes unknown or
  // changes, writes still queued are dropped (pause), the draft and Undo are
  // withdrawn, and a read is owed before editing returns, even if the same set
  // comes back. A write already sent may still land, so an unconfirmed change
  // gets a line that is true either way, cleared if the owed read shows it
  // landed. A layout effect, so no queued write goes out before the pause.
  useLayoutEffect(() => {
    const now = chartsUnsettled && saved !== null;
    if (now && !wasUnsettled.current && store) {
      store.pause(); ignoreBelow.current = changes.current + 1; setOwed(true);
      // The writes this pause drops are named by that line (coveredBelow).
      if (draft !== undefined) { withdrawn.current = JSON.stringify(draft); setMaybeUnsaved(true); coveredBelow.current = ignoreBelow.current; carried.current = false; }
      setDraft(undefined); setUndo(null);
    }
    wasUnsettled.current = now;
  }, [chartsUnsettled, saved, store, draft]);
  useEffect(() => {
    currentCharts.current = chartIDs;
    if (chartIDs !== null) latestCharts.current = chartIDs;
    if (saved && !reading && !readFailed && chartIDs !== null && (chartIDs !== builtOn || owed)) { setReading(true); reread((value) => value + 1); }
  }, [chartIDs, builtOn, saved, reading, readFailed, owed]);
  useFocusEffect(useCallback(() => {
    if (!store) return;
    let current = true;
    // A read starts a new generation (r1s1): Undo, unsaved changes and every
    // Customize control are withdrawn until it lands, and the session refuses
    // any write meanwhile, so nothing built on an older read is written.
    ignoreBelow.current = changes.current + 1; setReading(true); setDraft(undefined); setUndo(null); setExpired('');
    // A read that starts while the chart list is unknown does not settle a read owed for it.
    const basis = latestCharts.current, listKnown = currentCharts.current !== null, mine = ++readSeq.current;
    const deciding = () => mine > verifyAfter.current && !unsettled(owner);
    void store.load().then((value) => {
      if (!current) return;
      setSaved(value); setBuiltOn(basis); if (listKnown) setOwed(false);
      const held = JSON.stringify(value.customized ? value.entries : null), decides = deciding();
      if (decides && pendingFail.current !== undefined) {
        const outcome = pendingFail.current; pendingFail.current = undefined;
        if (outcome.refused === null || outcome.refused !== held) { refused.current = outcome.refused; lineOrder.current = outcome.order; drawn.current = false; setSaveFailed(true); }
      }
      if (withdrawn.current === held && (decides || !carriedMaybe.current)) setMaybeUnsaved(false);
      if (decides) carriedMaybe.current = false;
      if (refused.current === held) { refused.current = null; setSaveFailed(false); }
      setReadFailed(false); setReading(false);
    }).catch(() => {
      if (!current) return;
      // A carried line that no read could check is shown.
      if (deciding() && pendingFail.current !== undefined) { refused.current = pendingFail.current.refused; lineOrder.current = pendingFail.current.order; drawn.current = false; pendingFail.current = undefined; setSaveFailed(true); }
      setReadFailed(true); setReading(false);
    });
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') return;
      // Queued writes are dropped; the read on return waits for any write already sent.
      current = false; store.pause(); ignoreBelow.current = changes.current + 1; setDraft(undefined); setUndo(null); setOpen(false);
    });
    return () => { current = false; listener.remove(); };
  }, [store, attempt, reads]));
  const current = saved && draft !== undefined ? { ...saved, customized: draft !== null, entries: draft ?? [] } : saved;
  useEffect(() => {
    const node = focus ? targets.current.get(focus) : undefined;
    if (!focus) return;
    setFocus(null);
    if (node) requestAnimationFrame(() => AccessibilityInfo.sendAccessibilityEvent(node, 'focus'));
  }, [focus, current]);
  // After unmount: one write of this screen settled; the owner's count left.
  function settle() { const left = (settling.get(owner) ?? 1) - 1; if (left > 0) settling.set(owner, left); else settling.delete(owner); return left; }
  function change(next: PulseLayoutEntry[] | null, focusTo: string, offer?: Omit<Undo, 'until'>) {
    if (!store || reading || chartsUnsettled || owed || readFailed) return;
    const id = ++changes.current, order = ++editOrder;
    mine.current = null; refused.current = null; pendingFail.current = undefined; carriedMaybe.current = false; outstanding.current += 1; setDraft(next); setSaveFailed(false); setMaybeUnsaved(false); setExpired(''); setFocus(focusTo);
    setUndo(offer ? { ...offer, until: Date.now() + 30_000 } : null);
    void store.save(next).then(() => {
      outstanding.current -= 1;
      // #9405 final r3s1: the next screen for this layout waits for this.
      // #9409 r2s1: this mount's latest edit saved, so no older edit's line is owed.
      const latest = id === changes.current;
      if (latest) mine.current = { order, failed: false, refused: null };
      if (!live.current) { if (settle() === 0 || latest) oweLine(owner, { person, newest: latest ? mine.current : null, maybe: null }); return; }
      if (id < ignoreBelow.current) return;
      setSaved((value) => value && { ...value, customized: next !== null, entries: next ?? [] });
      if (id === changes.current) setDraft(undefined);
    }).catch(() => {
      outstanding.current -= 1;
      // A change a fresh read, a pause or a remount
      // withdrew is refused by the session before it is sent, or its write
      // failed or ran out of time. It gets the existing line here, or on the
      // next mount for the same layout, unless the chart-list pause's line
      // already names it. The read that withdrew it waits behind the writes,
      // so this lands before that read does; a write that ran out of time may
      // still have landed, so a read that shows this layout clears the line.
      // #9402 r1s2: the pause's line (carried with the mount) already names it.
      // Withdrawn edits owe at most one line, for the latest edit
      // of this mount. Queued edits coalesce into one write and an older
      // edit's refusal can arrive first, so an older edit owes nothing: if the
      // latest edit saved, every older one did too, and if it did not, its
      // own refusal names the layout the line is about.
      const owes = id >= coveredBelow.current && id === changes.current;
      // #9409 r2s1: the latest edit's outcome, in edit order; one a pause line names owes no didn't-save.
      if (id === changes.current) mine.current = { order, failed: owes, refused: owes ? JSON.stringify(next) : null };
      if (!live.current) {
        // #9405 final r3s1: an unmounted screen also says when its last write
        // settled, so the next screen decides its line on a read after that.
        const left = settle();
        if (id === changes.current || left === 0) oweLine(owner, { person, newest: id === changes.current ? mine.current : null, maybe: null });
        return;
      }
      if (id < coveredBelow.current || (id < ignoreBelow.current && !owes)) return;
      if (id < ignoreBelow.current) { refused.current = JSON.stringify(next); lineOrder.current = order; carried.current = false; setSaveFailed(true); return; }
      ignoreBelow.current = changes.current + 1;
      refused.current = null; lineOrder.current = order; carried.current = false;
      if (id === changes.current) mine.current = { order, failed: true, refused: null };
      setDraft(undefined); setUndo(null); setSaveFailed(true); reread((value) => value + 1);
    });
  }
  function undoLast() {
    const offer = undo;
    if (!offer) return;
    setUndo(null);
    if (Date.now() >= offer.until) { setExpired(offer.expired); setFocus(offer.expiredFocus); }
    else change(offer.entries, offer.focus);
  }
  const target = (name: string) => (node: View | null) => { if (node) targets.current.set(name, node); else targets.current.delete(name); };
  // The sheet's line while the chart list is not known names only what is on
  // screen: pending is bounded by the list's read deadline; failed shows Retry.
  const chartsLine = chartIDs === null && builtOn !== null ? chartStatus === 'failed' ? 'Your built charts didn’t load. Close this and choose Retry saved charts.' : 'Checking your built charts…' : null;
  return { current, reading: reading || chartsUnsettled || owed, chartsLine, drew: () => { drawn.current = true; }, readFailed, saveFailed, maybeUnsaved, undo, expired, open, setOpen, change, undoLast, target, retry: () => reread((value) => value + 1) };
}

function LayoutNotices({ layout }: { layout: LayoutControl }) {
  // #9402 r1s3: a carried line counts as shown only once it has been drawn.
  useLayoutEffect(() => { layout.drew(); });
  return <>
    {layout.readFailed ? <><Body muted>{`Your Pulse layout didn’t load. ${layout.current ? 'Your last saved layout is shown.' : 'The standard Pulse is shown.'}`}</Body><Button label="Retry your Pulse layout" variant="secondary" onPress={layout.retry} /></> : null}
    {layout.saveFailed ? <Body>Your change didn’t save. Your last saved layout is shown.</Body> : null}
    {layout.maybeUnsaved ? <Body>Your built charts were being checked, so your last change may not have saved. Your saved layout is shown.</Body> : null}
  </>;
}

// Customize lists what is on the Pulse and what can be added, over the cards
// this screen already draws and the person's built charts, limited to the keys
// the server offers. Each change is one control (no drag), and focus returns
// to the control that follows it.
function CustomizeSheet({ layout, current, cards, charts }: { layout: LayoutControl; current: PulseLayout; cards: PulseCard[]; charts: SavedChart[] | null }) {
  const offered = (key: string) => current.options.includes(key);
  const { language } = useNativeUi();
  const titles = new Map([...cards.filter((card) => !card.id.startsWith('ready:')).map((card): [string, string] => [cardLayoutKey(card.id), card.title]), ...CASEWORK_CHARTS.map((chart): [string, string] => [chart.key, caseworkTitle(chart.key, language)!]), ...(charts ?? []).map((chart): [string, string] => [savedLayoutKey(chart.id), chart.title])].filter(([key]) => offered(key)));
  const drawable = new Set([...cards.filter((card) => card.rows.length > 0).map((card) => cardLayoutKey(card.id)), ...CASEWORK_CHARTS.map((chart) => chart.key)]);
  // Built charts are always on (see arrangePulse); one the layout does not
  // list yet follows the listed ones, so moving it writes it into place.
  const entries = current.customized
    ? [...current.entries, ...(charts ?? []).map((chart) => ({ key: savedLayoutKey(chart.id), pinned: false })).filter((entry) => offered(entry.key) && !current.entries.some((item) => item.key === entry.key))]
    : standardLayoutEntries(cards.map((card) => card.id), (charts ?? []).map((chart) => chart.id), current.options);
  const visible = new Set(entries.filter((entry) => titles.has(entry.key)).map((entry) => entry.key));
  const listed = (kind: 'card' | 'saved') => entries.filter((entry) => visible.has(entry.key) && layoutKind(entry.key) === kind);
  const addable = [...titles.keys()].filter((key) => key.startsWith('fixed:') && !entries.some((entry) => entry.key === key));
  const addableCasework = [...titles.keys()].filter((key) => isCaseworkKey(key) && !entries.some((entry) => entry.key === key));
  function move(key: string, direction: -1 | 1) {
    const next = moveLayoutEntry(entries, key, direction, visible);
    if (next === entries) return;
    const group = next.filter((entry) => visible.has(entry.key) && layoutKind(entry.key) === layoutKind(key));
    const index = group.findIndex((entry) => entry.key === key);
    const stays = direction === -1 ? index > 0 : index < group.length - 1;
    layout.change(next, `${key}:${(direction === -1) === stays ? 'up' : 'down'}`);
  }
  function row(entry: PulseLayoutEntry, index: number, count: number) {
    const title = titles.get(entry.key)!, fixed = layoutKind(entry.key) === 'card';
    return <Card key={entry.key}>
      <Heading level={3}>{title}</Heading>
      {entry.pinned && fixed ? <Body muted>Pinned above This week.</Body> : null}
      {fixed && !drawable.has(entry.key) ? <Body muted>It is not on your Pulse right now: there are no figures you may see.</Body> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
        <Button label="Move up" accessibilityLabel={`Move ${title} up`} variant="secondary" disabled={index === 0} focusRef={layout.target(`${entry.key}:up`)} onPress={() => move(entry.key, -1)} />
        <Button label="Move down" accessibilityLabel={`Move ${title} down`} variant="secondary" disabled={index === count - 1} focusRef={layout.target(`${entry.key}:down`)} onPress={() => move(entry.key, 1)} />
        {fixed ? <Button label={entry.pinned ? 'Unpin' : 'Pin'} accessibilityLabel={entry.pinned ? `Unpin ${title}` : `Pin ${title} above This week`} variant="secondary" focusRef={layout.target(`${entry.key}:pin`)} onPress={() => layout.change(entries.map((item) => item.key === entry.key ? { ...item, pinned: !item.pinned } : item), `${entry.key}:pin`)} /> : null}
        {fixed ? <Button label="Take off" accessibilityLabel={`Take ${title} off your Pulse`} variant="secondary" focusRef={layout.target(`${entry.key}:off`)} onPress={() => layout.change(layoutWithout(entries, entry.key), 'undo', { message: `${title} is off your Pulse. Undo is available for thirty seconds.`, label: `Put ${title} back`, expired: 'Undo expired. You can add the chart again.', entries: current.customized ? entries : null, focus: `${entry.key}:off`, expiredFocus: `${entry.key}:add` })} /> : null}
      </View>
    </Card>;
  }
  const today = listed('card'), built = listed('saved');
  const addCard = (key: string) => <Card key={key}><Heading level={3}>{titles.get(key) ?? caseworkTitle(key, language)}</Heading><Button label="Add" accessibilityLabel={`Add ${titles.get(key)!} to your Pulse`} variant="secondary" focusRef={layout.target(`${key}:add`)} onPress={() => layout.change([...entries, { key, pinned: false }], `${key}:off`)} /></Card>;
  // After the standard set, the first of today's cards is where an expired Undo leaves focus.
  const standardFirst = `${standardLayoutEntries(cards.map((card) => card.id), [], current.options).find((entry) => titles.has(entry.key))?.key ?? ''}:pin`;
  return <Sheet title="Customize your Pulse" onClose={() => layout.setOpen(false)}>
    <Body>Choose which charts are on your Pulse and in what order. Only you see this layout.</Body>
    <LayoutNotices layout={layout} />
    {layout.reading && !layout.readFailed ? <Body muted>{layout.chartsLine ?? 'Checking your Pulse layout…'}</Body> : null}
    {layout.reading || layout.readFailed ? null : <>
    {layout.undo ? <><Body>{layout.undo.message}</Body><Button label="Undo" accessibilityLabel={layout.undo.label} focusRef={layout.target('undo')} onPress={layout.undoLast} /></> : null}
    {layout.expired ? <Body>{layout.expired}</Body> : null}
    <Heading level={2}>On your Pulse</Heading>
    {today.length ? <><Heading level={3}>Today’s charts</Heading>{today.map((entry, index) => row(entry, index, today.length))}</> : null}
    {built.length ? <><Heading level={3}>Your built charts</Heading><Body muted>Built charts stay on your Pulse. Pin, show on Home or remove one from its own card.</Body>{built.map((entry, index) => row(entry, index, built.length))}</> : null}
    {!today.length && !built.length ? <Body muted>No charts are on your Pulse.</Body> : null}
    <Heading level={2}>Add to your Pulse</Heading>
    {addable.length ? addable.map(addCard) : null}
    {addableCasework.length ? <><Heading level={3}>{caseworkTitle('ready:casework', language)}</Heading>{addableCasework.map(addCard)}</> : null}
    {addable.length || addableCasework.length ? null : <Body muted>Everything you can add is on your Pulse.</Body>}
    {current.customized ? <Button label="Back to the standard set" variant="secondary" focusRef={layout.target('standard')} onPress={() => layout.change(null, 'undo', { message: 'Your Pulse is back to the standard set. Undo is available for thirty seconds.', label: 'Put your layout back', expired: 'Undo expired. Customize your Pulse again to change it.', entries, focus: 'standard', expiredFocus: standardFirst })} /> : null}
    </>}
  </Sheet>;
}
