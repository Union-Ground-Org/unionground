import { useBusinessDraftState } from '../../lib/useBusinessDraftState';
import { useBusinessOperation, useBusinessRequests, useBusinessState, useBusinessWriter } from '../../lib/useBusinessWriter';
import { useNativeUi } from '../../lib/useNativeUi';
// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP4-20261029 (native).
//
// Guide 2 for the staff hat worn, on the Work tab: the hat's feature guides
// in the shared engine's order with the ring of done guides, each opening in
// place as its guide card (can, never, who to ask, the real first action, Got
// it). Same rules and English lines as the web; progress is the person's own,
// on the server, so a guide finished on the web is finished here. Inline, never
// a modal; nothing moves focus.

import { useIsFocused, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../../components/Text';

import { roleSwitchStepId, staffFeatureGuides } from '../../../../../src/features/onboardingGuideEngine/staffGuides.js';
import { useLearningUndone } from '../../../../../src/features/learningPeriod/undoneSignal.js';
import { CHAPTER_SETUP_UNDO_KINDS } from '../../../../../src/lib/onboardingGuide.js';
import { Body, Button, Card, Heading, Notice } from '../../components/ui';
import { haptics } from '../../services/haptics';
import { useApp } from '../../state/AppProvider';
import { useTheme } from '../../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../../theme/tokens';
import { guideText, type GuideCopy } from './guideLayersData';
import { NATIVE_STAFF_FEATURE_NAMES, completeStaffOnboardingStep, liveStaffGuideHat, loadStaffOnboardingGuide, markStaffOnboardingStep } from './staffGuidesData';

import { typeface } from '../../theme/typeface';
type StaffGuideLine = { role: string; roleLabel: GuideCopy; canDo: GuideCopy[]; neverDo: GuideCopy[] };
type StaffGuidePart = { id: string; label: GuideCopy; done: boolean; status: GuideCopy };
type StaffGuideItem = {
  stepId: string; feature: string; nativeHref: string | null; title: GuideCopy; about: GuideCopy[]; parts: StaffGuidePart[] | null; roleChip: GuideCopy | null; countsForAll: boolean;
  lines: StaffGuideLine[]; askWho: GuideCopy; firstLabel: GuideCopy; doneOnPrimary: boolean; done: boolean; doneBeforeOpened: boolean;
};
type StaffGuidesView = {
  role: string; items: StaffGuideItem[]; done: StaffGuideItem[]; ring: GuideCopy; doneCount: number; total: number;
  note: GuideCopy | null; firstSwitch: boolean;
};

/**
 * The staff guide payload for the live session and selected chapter, re-read
 * whenever Work gains focus, the chapter changes, or an undo of a role, scope
 * or membership change lands. The units step's facts belong to the chapter,
 * so an answer read for another chapter or session is never shown
 * .
 */
export function useStaffGuidePayload(active: boolean) {
  const { session, dashboard } = useApp();
  const chapterId = dashboard?.member.chapterID ?? null;
  const focused = useIsFocused();
  // #9957 (carved from #9465): `failed` keeps a failed read apart from a
  // person with no guides, so the card can say it and offer Try again.
  const [state, setState] = useState<{ session: unknown; chapterId: string | null; payload: unknown; failed: boolean }>({ session: null, chapterId: null, payload: null, failed: false });
  const [undone, setUndone] = useState(0);
  // A Try again read in flight: the card stays, with a loading line.
  const [retrying, setRetrying] = useState(false);
  const scope = useRef({ session, chapterId });
  scope.current = { session, chapterId };
  useLearningUndone([...CHAPTER_SETUP_UNDO_KINDS], () => setUndone((count) => count + 1));
  useEffect(() => {
    if (!active || !session || !focused) return undefined;
    let live = true;
    loadStaffOnboardingGuide()
      .then((payload) => { if (live) setState({ session, chapterId, payload, failed: false }); })
      .catch(() => { if (live) setState({ session, chapterId, payload: null, failed: true }); })
      .finally(() => { if (live) setRetrying(false); });
    return () => { live = false; };
  }, [active, session, focused, chapterId, undone]);
  // A write answers with the guide after it; keep it only while the same
  // session and chapter are still the ones on screen.
  const run = useCallback(async (write: () => Promise<unknown>) => {
    const started = scope.current;
    const isCurrent = () => scope.current.session === started.session && scope.current.chapterId === started.chapterId;
    try {
      const payload = await write();
      setState((current) => (isCurrent() ? { ...started, payload, failed: false } : current));
      return isCurrent() ? 'saved' : 'superseded';
    } catch {
      // swallow-ok: Got it shows this refusal. Background guide marks keep the last payload.
      return isCurrent() ? 'failed' : 'superseded';
    }
  }, []);
  const current = active && state.session === session && state.chapterId === chapterId;
  // Try again replaces the failure with a loading line until the read ends.
  const retry = useCallback(() => {
    setRetrying(true);
    setState((previous) => ({ ...previous, failed: false }));
    setUndone((count) => count + 1);
  }, []);
  return { payload: current ? state.payload : null, failed: current && state.failed, retrying: current && retrying, chapterId, focused, run, retry };
}

function Group({ heading, lines }: { heading: string; lines: string[] }) {
  const theme = useTheme();
  if (!lines.length) return null;
  return (
    <View style={styles.group}>
      <Text accessibilityRole="header" style={[styles.groupHeading, { color: theme.cardForeground }]}>{heading}</Text>
      {lines.map((line) => <Body key={line} fitWords>{`• ${line}`}</Body>)}
    </View>
  );
}

function Chip({ label }: { label: string }) {
  const theme = useTheme();
  return <View style={[styles.chip, { backgroundColor: theme.secondary }]}><Text style={[styles.chipText, { color: theme.secondaryForeground }]}>{label}</Text></View>;
}

/**
 * "Your feature guides" for the staff hat worn. Shows nothing in PREVIEW,
 * without a staff hat, or when the organization turned feature guides off.
 */
export function NativeStaffGuides() {
  const writer = useBusinessWriter();
  const theme = useTheme();
  const router = useRouter();
  const app = useApp();
  const hat = liveStaffGuideHat(app);
  const { payload, failed, retrying, chapterId, focused, run, retry } = useStaffGuidePayload(hat !== null);
  const { t } = useNativeUi();
  const [open, setOpen] = useState<string | null>(null);
  const requests = useBusinessRequests(writer, JSON.stringify([hat, chapterId, open, focused]));
  const [saving, setSaving] = useBusinessState(false);
  const [operateSave] = useBusinessOperation<boolean>(setSaving, false);
  const [saveFailures, setSaveFailures] = useBusinessDraftState(0, open);
  const [showDone, setShowDone] = useState(false);
  const view = staffFeatureGuides({ payload, hat, chapterId }).view as StaffGuidesView | null;
  const firstSwitchRole = view?.firstSwitch ? view.role : null;
  useEffect(() => {
    if (!firstSwitchRole) return;
    void run(() => markStaffOnboardingStep(writer, roleSwitchStepId(firstSwitchRole), 'seen'));
  }, [firstSwitchRole, run, writer]);
  const noteText = view?.note && view.firstSwitch ? guideText(view.note) : '';
  useEffect(() => { if (noteText) AccessibilityInfo.announceForAccessibility?.(noteText); }, [noteText]);
  if (!view || view.total === 0) {
    // The card leaves only when a read ends with no guides.
    if (!failed && !retrying) return null;
    const unavailable = t('Your feature guides could not be loaded.');
    return (
      <Card>
        <Heading level={2}>{guideText({ key: 'guideEngine.sf.yourGuides' })}</Heading>
        {retrying ? <Body>{t('Loading your feature guides.')}</Body> : focused ? <Notice>{unavailable}</Notice> : <Body>{unavailable}</Body>}
        <Button variant="secondary" label={t('Try again')} busy={retrying} onPress={retry} />
      </Card>
    );
  }

  const all = [...view.items, ...view.done];
  const toggle = (item: StaffGuideItem) => {
    void haptics.select();
    setSaveFailures(0);
    if (open === item.stepId) { setOpen(null); return; }
    setOpen(item.stepId);
    // Opening a guide here is reaching it: the first time is "seen", later ones reopen it.
    void run(() => markStaffOnboardingStep(writer, item.stepId, item.done ? 'reopen' : 'seen'));
  };
  const gotIt = (item: StaffGuideItem) => {
    void operateSave(true, async () => {
      const current = requests.capture().isCurrent;
      if (!current()) return;
      void haptics.select();
      const outcome = await run(() => markStaffOnboardingStep(writer, item.stepId, 'got'));
      if (!current() || outcome === 'superseded') return;
      if (outcome === 'saved') {
        setSaveFailures(0);
        setOpen((stepId) => stepId === item.stepId ? null : stepId);
      } else {
        setSaveFailures((count) => count + 1);
      }
    });
  };
  const primary = (item: StaffGuideItem) => {
    void haptics.select();
    if (item.doneOnPrimary) void run(() => completeStaffOnboardingStep(writer, item.stepId));
    if (item.nativeHref) router.push(item.nativeHref as never);
  };
  const percent = view.total ? Math.round((view.doneCount / view.total) * 100) : 0;

  const row = (item: StaffGuideItem, index: number) => {
    const name = NATIVE_STAFF_FEATURE_NAMES[item.feature] ?? guideText(item.title);
    const expanded = open === item.stepId;
    const state = item.done
      ? guideText({ key: item.doneBeforeOpened ? 'guideEngine.fg.doneBeforeOpened' : 'guideEngine.row.done' })
      : guideText({ key: index === 0 ? 'guideEngine.sf.nextWord' : 'guideEngine.fg.notYet' });
    return (
      <View key={item.stepId} style={[styles.guide, { borderColor: theme.border }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={`${name}, ${state}`}
          onPress={() => toggle(item)}
          style={styles.guideRow}
        >
          <Text style={[styles.strong, { color: theme.cardForeground }]}>{name}</Text>
          {item.roleChip || item.countsForAll ? (
            <View style={styles.chips}>
              {item.roleChip ? <Chip label={guideText(item.roleChip)} /> : null}
              {item.countsForAll ? <Chip label={guideText({ key: 'guideEngine.sf.countsBoth' })} /> : null}
            </View>
          ) : null}
          <Body muted>{guideText(item.firstLabel)}</Body>
          <Text style={[styles.state, { color: theme.cardForeground }]}>{state}</Text>
        </Pressable>
        {expanded ? (
          <View style={styles.guideBody}>
            {item.lines.map((line) => (
              <View key={line.role} style={styles.group}>
                {item.lines.length > 1 ? <View style={styles.chips}><Chip label={guideText(line.roleLabel)} /></View> : null}
                <Group heading={guideText({ key: 'guideEngine.fg.youCan' })} lines={line.canDo.map(guideText)} />
                <Group heading={guideText({ key: 'guideEngine.fg.never' })} lines={line.neverDo.map(guideText)} />
              </View>
            ))}
            {item.about.length > 0 ? <Group heading={guideText({ key: 'guideEngine.sf.units.about' })} lines={item.about.map(guideText)} /> : null}
            {/* REQ-UG-MULTI-UNIT-SETUP-GUIDE-20261109: each part's state; its screens are on the web only. */}
            {item.parts ? (
              <>
                <Group heading={guideText(item.firstLabel)} lines={item.parts.map((part) => `${guideText(part.label)}: ${guideText(part.done ? { key: 'guideEngine.row.done' } : part.status)}`)} />
                <Body muted>{guideText({ key: 'guideEngine.sf.units.webOnly' })}</Body>
              </>
            ) : null}
            <Group heading={guideText({ key: 'guideEngine.fg.askHeading' })} lines={[guideText({ key: 'guideEngine.fg.askLine', params: { who: item.askWho } })]} />
            <View style={styles.actions}>
              {!item.done && item.nativeHref ? <Button variant="secondary" label={guideText(item.firstLabel)} onPress={() => primary(item)} /> : null}
              <Button variant="secondary" busy={saving} label={t('Got it')} onPress={() => gotIt(item)} />
              {focused && !saving && saveFailures > 0 ? <Notice key={saveFailures}>{t('That did not save. Try again.')}</Notice> : null}
            </View>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <Card>
      <Heading level={2}>{guideText({ key: 'guideEngine.sf.yourGuides' })}</Heading>
      {view.note ? <Body>{guideText(view.note)}</Body> : null}
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={guideText(view.ring)}
        accessibilityValue={{ min: 0, max: view.total, now: view.doneCount }}
        style={[styles.track, { backgroundColor: theme.muted }]}
      >
        <View style={[styles.fill, { width: `${percent}%`, backgroundColor: theme.primary }]} />
      </View>
      <Text style={[styles.strong, { color: theme.cardForeground }]}>{guideText(view.ring)}</Text>
      {view.items.length === 0 ? <Body muted>{guideText({ key: 'guideEngine.sf.cardAllDone' })}</Body> : null}
      {view.items.map(row)}
      {view.done.length > 0 ? (
        <Button
          variant="secondary"
          label={guideText({ key: 'guideEngine.fg.doneGroup', params: { n: view.done.length } })}
          onPress={() => { void haptics.select(); setShowDone((value) => !value); }}
        />
      ) : null}
      {showDone ? view.done.map((item) => row(item, all.length)) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  chip: { borderRadius: radii.md, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  chipText: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  group: { gap: 2 },
  groupHeading: { fontSize: 16, lineHeight: 22, ...typeface.heading },
  actions: { gap: spacing.sm },
  track: { height: 8, borderRadius: 4, overflow: 'hidden' },
  fill: { height: '100%' },
  strong: { fontSize: 16, lineHeight: 22, ...typeface.controlStrong },
  state: { fontSize: 15, lineHeight: 21, ...typeface.controlStrong },
  guide: { borderWidth: 1, borderRadius: radii.md },
  guideRow: { minHeight: minimumTouchTarget, padding: spacing.md, gap: 2 },
  guideBody: { gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.md },
});
