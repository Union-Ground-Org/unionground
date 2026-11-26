import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useRef, useState, type ComponentRef } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Text } from '../components/Text';

import { usePinnedHeaderChrome } from '../components/PinnedHeader';
import { PressableScale } from '../components/PressableScale';
import { Body, Button, Card, Heading, Notice, Screen, StateMessage } from '../components/ui';
import { CHROME_CLEARANCE } from '../lib/chrome';
import { configureExpansion } from '../lib/expansion';
import {
  LEGAL_INSTRUMENT_ANCHOR,
  LEGAL_INSTRUMENT_HEADING,
  LEGAL_PAGE_KEYS,
  legalDocument,
  legalInstrumentAnchor,
  legalJumpEntries,
  legalPlainText,
  legalSiteUrl,
  legalSummaryAnchor,
  type LegalJumpEntry,
  type LegalPageKey,
} from '../lib/legalDocuments';
import { legalReaderDocument } from '../lib/legalReaderDates';
import { openOutcome, shareOutcome, type LegalReaderOutcome } from '../lib/legalReaderOutcome';
import { useReduceMotion } from '../lib/reduceMotion';
import { useNativeUi } from '../lib/useNativeUi';
import { haptics } from '../services/haptics';
import { elevation } from '../theme/elevation';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
// b01-22: a document long enough to lose your place needs a way back to the
// top of a section. Above this many sections the reader gets a collapsed
// "On this page" card; below it, the document is short enough to scroll.
const JUMP_CARD_MIN_SECTIONS = 5;

// b01-30: the cross-link block had no canonical order and no second line, so
// the same six destinations arrived in a different order on every page and
// none of them said what they were for. The order is fixed here, each row
// carries one clause, and the page you are already reading stays in the list
// as a disabled "Current" row rather than vanishing from it.
const CROSS_LINK_ORDER: LegalPageKey[] = ['about', 'privacy', 'terms', 'ai-disclosure', 'retention', 'accessibility', 'accessibility-statement'];

// The Privacy section the Key actions card opens; mirror of the heading in
// src/lib/legalDocuments.ts.
const PRIVACY_CONTROL_HEADING = 'Your control';

const CROSS_LINK_CLAUSES: Record<LegalPageKey, string> = {
  about: 'What Union Ground is and who runs it',
  privacy: 'What is held, how it is used, and your control',
  terms: 'The rules for using the app',
  'ai-disclosure': 'How the Guide answers and what it never sees',
  retention: 'How long each record is kept',
  accessibility: 'Standards, known gaps, and how to report a barrier',
  'accessibility-statement': 'The conformance target, what falls short, and what is unevaluated',
};

export function LegalDocumentScreen({ page }: { page: string }) {
  const { locale, t } = useNativeUi();
  const theme = useTheme();
  const router = useRouter();
  const reduceMotion = useReduceMotion();
  const pinned = usePinnedHeaderChrome();
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const sectionTops = useRef<Record<string, number>>({});
  // BUG-UG-MOBILE-LEGAL-READER-SHARE-OPEN-FAILURES-20260920: the outcome
  // helper decides whether the platform confirmed the action, the worker
  // dismissed it, or it failed; this state carries only the failure notice.
  const [notice, setNotice] = useState<string | null>(null);

  function settle(outcome: LegalReaderOutcome) {
    if (outcome.status === 'completed') {
      void haptics.select();
      setNotice(null);
      return;
    }
    if (outcome.status === 'failed') {
      // The Notice surface owns the announcement: it carries the Android live
      // region and speaks the queued iOS utterance itself, so announcing here
      // as well would read the failure twice under VoiceOver.
      setNotice(outcome.notice);
      return;
    }
    setNotice(null);
  }
  const publishedDocument = legalDocument(page);

  if (!publishedDocument) {
    return <Screen><StateMessage fitWords title={t('Document not found')} body={t('That legal page is not part of Union Ground.')} /></Screen>;
  }
  const document = legalReaderDocument(publishedDocument, locale);
  const jumpEntries = legalJumpEntries(document);
  // Batch C legal layout: Privacy lifts the route to a copy of your data or to
  // deletion into a Key actions card at the top. It jumps to the document's
  // own "Your control" section, so the card adds no text the document lacks.
  const controlIndex = document.key === 'privacy' ? document.sections.findIndex((section) => section.heading === PRIVACY_CONTROL_HEADING) : -1;

  async function saveOrShare() {
    if (!document) return;
    // Clear the notice before the platform call so a retry is always visible
    // and re-announced, even when it fails with the same message.
    setNotice(null);
    let outcome: LegalReaderOutcome;
    try {
      const result = await Share.share({ title: document.title, message: legalPlainText(document) });
      outcome = shareOutcome({ ok: true, action: result.action });
    } catch (error) {
      outcome = shareOutcome({ ok: false, error });
    }
    settle(outcome);
  }

  // D-13: the summary links the instrument that governs it on native as well
  // as on the web, at the version the shared instrument source holds.
  async function openInstrument() {
    const url = document?.instrument?.url;
    if (!url) return;
    setNotice(null);
    let outcome: LegalReaderOutcome;
    try {
      await Linking.openURL(url);
      outcome = openOutcome({ ok: true });
    } catch (error) {
      outcome = openOutcome({ ok: false, url, error });
    }
    settle(outcome);
  }

  async function openOnSite() {
    if (!document) return;
    // The audited native-to-browser boundary pins this screen's explicit open
    // call through legalSiteUrl, so the call stays inline; `url` names that
    // same public address in the failure notice.
    const url = legalSiteUrl(document);
    if (!url) return;
    setNotice(null);
    let outcome: LegalReaderOutcome;
    try {
      await Linking.openURL(url);
      outcome = openOutcome({ ok: true });
    } catch (error) {
      outcome = openOutcome({ ok: false, url, error });
    }
    settle(outcome);
  }

  // Each rendered section records its own anchor, so a heading that repeats
  // between the summary and its instrument still lands on the card it names.
  function measure(id: string) {
    return (event: LayoutChangeEvent) => { sectionTops.current[id] = event.nativeEvent.layout.y; };
  }

  function jumpTo(id: string) {
    const top = sectionTops.current[id];
    if (top === undefined) return;
    void haptics.select();
    // The pinned bar floats over the page, so a raw section offset parks the
    // heading underneath it.
    const clearance = pinned ? pinned.contentInset : CHROME_CLEARANCE;
    scrollRef.current?.scrollTo({ y: Math.max(0, top - clearance), animated: !reduceMotion });
  }

  return (
    <Screen scrollRef={scrollRef}>
      {/* REQ-UG-LOVABLE-NATIVE-SCREENS-BATCH-C-PORT-20261103, layout
          only: the meta line under the title, the summary first in an In
          short card, then Key actions. Every sentence is the document's own. */}
      <Body muted>Union Ground · Public information</Body>
      <Heading>{document.title}</Heading>
      <Body muted>{document.notice}</Body>
      <Card style={{ backgroundColor: theme.muted }}>
        <Heading level={3}>In short</Heading>
        <Body>{document.intro}</Body>
      </Card>
      {controlIndex >= 0 ? (
        <Card>
          <Heading level={3}>Key actions</Heading>
          <Button label="Get a copy of your data or delete your account" onPress={() => jumpTo(legalSummaryAnchor(controlIndex))} />
        </Card>
      ) : null}
      {jumpEntries.length > JUMP_CARD_MIN_SECTIONS ? (
        <JumpCard sections={jumpEntries} onJump={jumpTo} />
      ) : null}
      {document.sections.map((section, index) => (
        <View key={legalSummaryAnchor(index)} onLayout={measure(legalSummaryAnchor(index))}>
          <Card>
            <Heading level={3}>{section.heading}</Heading>
            <Body>{section.body}</Body>
          </Card>
        </View>
      ))}
      {document.instrument ? (
        <View onLayout={measure(LEGAL_INSTRUMENT_ANCHOR)}>
          <Card>
            <Heading level={3}>{LEGAL_INSTRUMENT_HEADING}</Heading>
            <Body>{document.instrument.name}</Body>
            <Body muted>{document.instrument.status}</Body>
          </Card>
        </View>
      ) : null}
      {/* The instrument's full text, the same sections and order as its web
          route, so reading it never needs the website. */}
      {document.instrument?.sections.map((section, index) => (
        <View key={legalInstrumentAnchor(index)} onLayout={measure(legalInstrumentAnchor(index))}>
          <Card>
            <Heading level={3}>{section.heading}</Heading>
            <Body>{section.body}</Body>
          </Card>
        </View>
      ))}
      <Card>
        <Heading level={3}>{document.contactLabel}</Heading>
        <Body>{document.contactEmail || 'No support address is published yet. For account help, use the contact who provisioned your account.'}</Body>
      </Card>
      {notice ? <Notice>{notice}</Notice> : null}
      <Button label="Save or share this document" onPress={() => { void saveOrShare(); }} />
      {legalSiteUrl(document) ? (
        <Button label="Open on the website" variant="secondary" onPress={() => { void openOnSite(); }} />
      ) : null}
      {document.instrument ? (
        <Button label="Open the full instrument" variant="secondary" onPress={() => { void openInstrument(); }} />
      ) : null}
      <Body muted style={{ color: theme.mutedForeground }}>
        Reading stays in the app and sends nothing.
      </Body>
      <ViewLinks current={document.key} onOpen={(key) => router.push(`/legal/${key}` as never)} />
    </Screen>
  );
}

// b01-22: collapsed by default — a table of contents that is open on arrival is
// just a second hero — and no sticky overlay: it scrolls away with the rest of
// the document once the reader has used it.
//
// IA-wave-A review: on the white card fill the collapsed card read as one more
// section card in the stack, so the one interactive object on the page looked
// like reading matter. It now sits on the interactive rung — the lavender
// `secondary` tint over the same level-1 hairline, the treatment the Compass
// approved-sources block already uses for a flat tinted block — and the header
// states the count, so the reader knows the size of the document before
// opening it. Collapsed-by-default and the anchors are unchanged.
function JumpCard({ sections, onJump }: { sections: LegalJumpEntry[]; onJump: (id: string) => void }) {
  const theme = useTheme();
  const reduceMotion = useReduceMotion();
  const [expanded, setExpanded] = useState(false);

  // The shared expansion primitive: same 280ms easeOut the Compass sources
  // block grows with, and nothing at all under Reduce Motion.
  function toggle() {
    void haptics.select();
    configureExpansion(reduceMotion);
    setExpanded((current) => !current);
  }

  // Codex IA-A: the header and the section rows gave opacity-only feedback on
  // the one interactive object on the page. They take the shared press
  // primitive — compression plus the same 0.82 dim Button ships — at level 0,
  // because rows inside the card never float above it. Reduce Motion is
  // handled inside the primitive.
  return (
    <Card style={[styles.jumpCard, { backgroundColor: theme.secondary }]}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`On this page, ${sections.length} sections`}
        accessibilityHint={expanded ? 'Hides the section links' : 'Shows a link to each section'}
        accessibilityState={{ expanded }}
        onPress={toggle}
        resting={elevation.level0}
        pressedOpacity={0.82}
        style={[styles.jumpHeader, elevation.level0]}
      >
        <Body style={[styles.jumpLabel, { color: theme.secondaryForeground }]}>On this page · {sections.length} sections</Body>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={theme.secondaryForeground} accessibilityElementsHidden />
      </PressableScale>
      {expanded ? sections.map((entry) => (
        <PressableScale
          key={entry.id}
          accessibilityRole="link"
          accessibilityLabel={entry.accessibilityLabel}
          accessibilityHint="Jumps to this section"
          onPress={() => onJump(entry.id)}
          resting={elevation.level0}
          pressedOpacity={0.82}
          style={[
            styles.jumpRow,
            elevation.level0,
            { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
          ]}
        >
          <Body style={[styles.linkLabel, { color: theme.secondaryForeground }]}>{entry.heading}</Body>
          <Ionicons name="arrow-down" size={16} color={theme.secondaryForeground} accessibilityElementsHidden />
        </PressableScale>
      )) : null}
    </Card>
  );
}

function ViewLinks({ current, onOpen }: { current: LegalPageKey; onOpen: (key: LegalPageKey) => void }) {
  const theme = useTheme();
  // Fixed canonical order, and the current page keeps its place in it. Any key
  // the order forgets still appears, so a new document cannot silently vanish
  // from the cross-link block.
  const ordered = [...CROSS_LINK_ORDER, ...LEGAL_PAGE_KEYS.filter((key) => !CROSS_LINK_ORDER.includes(key))];
  // #1021 follow-up 8: the divider rode the *ordered* index, so a key the order
  // names but the document set no longer ships (a page retired, a key renamed)
  // dropped its row and left the next one carrying a top hairline against the
  // card's own edge — a 1px scar under the card's rounded corner. Resolving the
  // documents first means the divider counts rows that actually render.
  const rows = ordered
    .map((key) => ({ key, item: legalDocument(key) }))
    .filter((entry): entry is { key: LegalPageKey; item: NonNullable<ReturnType<typeof legalDocument>> } => entry.item != null);
  return (
    <>
      <Heading level={2}>More legal pages</Heading>
      <Card style={styles.linkCard}>
        {rows.map(({ key, item }, index) => {
          const isCurrent = key === current;
          const divider = index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.muted } : null;
          const copy = (
            <View style={styles.linkCopy}>
              <Body style={styles.linkLabel}>{item.title}</Body>
              <Text style={[styles.linkClause, { color: theme.mutedForeground }]}>{CROSS_LINK_CLAUSES[key]}</Text>
            </View>
          );
          if (isCurrent) {
            // Disabled, not removed: the reader can see where this page sits in
            // the set, which is the whole point of a fixed order.
            return (
              <View
                key={key}
                accessible
                accessibilityLabel={`${item.title}, current page`}
                accessibilityState={{ disabled: true }}
                style={[styles.linkRow, divider]}
              >
                {copy}
                <View style={[styles.currentChip, { backgroundColor: theme.muted }]}>
                  <Text style={[styles.currentChipText, { color: theme.mutedForeground }]}>Current</Text>
                </View>
              </View>
            );
          }
          return (
            <Pressable
              key={key}
              accessibilityRole="link"
              accessibilityLabel={item.title}
              accessibilityHint={CROSS_LINK_CLAUSES[key]}
              onPress={() => { void haptics.select(); onOpen(key); }}
              style={({ pressed }) => [
                styles.linkRow,
                divider,
                pressed ? { backgroundColor: theme.muted } : null,
              ]}
            >
              {copy}
              <Ionicons name="chevron-forward" size={16} color={theme.mutedForeground} accessibilityElementsHidden />
            </Pressable>
          );
        })}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  linkCard: { paddingVertical: 0, paddingHorizontal: 0, gap: 0 },
  linkRow: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  linkCopy: { flex: 1, gap: 2 },
  linkLabel: { flex: 1 },
  linkClause: { fontSize: 13, lineHeight: 18 },
  currentChip: { borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  currentChipText: { fontSize: 12, lineHeight: 16, ...typeface.controlStrong },
  jumpCard: { paddingVertical: 0, paddingHorizontal: 0, gap: 0 },
  jumpHeader: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg },
  jumpLabel: { flex: 1, ...typeface.controlStrong },
  jumpRow: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg },
});
