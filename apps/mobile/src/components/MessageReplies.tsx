import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Text } from './Text';
import { messageReplyCounts, messageReplyPage } from '../../../../src/features/messaging/replies.js';
import { NativeMessageActions } from './NativeMessageActions';
import { Body, Button } from './ui';
import { getSupabaseClient } from '../services/supabase';
import { useTheme } from '../theme/ThemeProvider';
import { radii, spacing } from '../theme/tokens';
import { CHIP_TEXT_CAP, chipHeight, chipTargetHeight } from './quietChip';
import { useReduceMotion } from '../lib/reduceMotion';
import { LiveChartMessage } from '../features/SavedPulseCharts';
import { chartReference } from '../lib/savedPulseCharts';
import { deviceDateTime } from '../lib/evidenceTimestamp';
import { nativeUiText, type NativeUiText } from '../lib/nativeUiCopy';
import { useNativeUi } from '../lib/useNativeUi';

import { typeface } from '../theme/typeface';
const english = nativeUiText('en');

type Reply = { id: string; body: string; author_name: string; created_at: string; parent_id: string | null; redacted_at?: string | null; edited_at?: string | null };
type Page = { parent: Reply; replies: Reply[]; count: number; hasMore: boolean };
type SourceKind = 'private' | 'channel';
const REPLY_LOAD_TIMEOUT_MS = 15000;

function isReplyAuthorizationError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === '42501');
}

async function withinReplyLoadTimeout<T>(controller: AbortController, request: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('Reply load timed out'));
        }, REPLY_LOAD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// "1 reply", "2 replies": the reply pill under a message and the replies
// header (App Store capture, Nov 7, 2026, read "1 replies").
export function replyCountLabel(count: number, t: NativeUiText = english): string {
  return count === 1 ? t('1 reply') : t('{n} replies', { n: count });
}

// The reply count under a message: a quiet secondary chip sized to its words
// on the message's leading edge, inside a full-height target, where a
// full-width filled primary button outweighed the message it belongs to (App
// Store capture, Nov 7, 2026). In a column (a private conversation) it takes
// its message's side (`end` under your own bubble); with no side it is a row
// item, centred in the channel's footer row a step apart from the reaction
// button (a reply count is not one more reaction).
// It follows the reaction chips beside it: its height, sides, gap, words and
// icons grow together up to their 2x text cap, and a press lays the
// add-reaction chip's muted fill under its words with a primary edge and,
// unless Reduce Motion is on, settles the chip a little (the muted fill differs
// from the secondary one in hue more than in lightness). A label that wraps keeps 4 pt clear
// above and below the chip. The chevron's own side bearing stands in for 2 pt
// of its side, so the words look evenly inset.
type ChipIcon = 'chatbubble-outline' | 'return-up-back-outline';
// A long label wraps inside the chip at large text, next to its icon, instead
// of running past its message; the chevron is left off where the leading icon
// already points.
function QuietChipControl({ icon, label, hint, onPress, align, chevron = true, beforeBody = false }: { icon: ChipIcon; label: string; hint: string; onPress: () => void; align?: 'start' | 'end'; chevron?: boolean; beforeBody?: boolean }) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const textScale = Math.min(fontScale, CHIP_TEXT_CAP);
  const reducedMotion = useReduceMotion();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
      style={[styles.replyCount, { minHeight: chipTargetHeight(textScale) }, align === 'end' ? styles.replyCountEnd : align === 'start' ? styles.replyCountStart : styles.replyCountInRow, beforeBody ? styles.chipBeforeBody : null]}
    >
      {({ pressed }) => <View style={[styles.replyCountChip, { minHeight: chipHeight(textScale), gap: Math.round(4 * textScale), paddingHorizontal: Math.round(8 * textScale), ...(chevron ? { paddingRight: Math.round(6 * textScale) } : null) }, { backgroundColor: pressed ? theme.muted : theme.secondary, borderColor: pressed ? theme.primary : theme.border }, pressed && !reducedMotion ? styles.chipPressed : null]}>
        <Ionicons name={icon} size={Math.round(16 * textScale)} color={theme.secondaryForeground} accessibilityElementsHidden />
        <Text maxFontSizeMultiplier={CHIP_TEXT_CAP} style={[styles.replyCountLabel, { color: theme.secondaryForeground }]}>{label}</Text>
        {chevron ? <Ionicons name="chevron-forward" size={Math.round(13 * textScale)} color={theme.secondaryForeground} style={styles.replyCountChevron} accessibilityElementsHidden /> : null}
      </View>}
    </Pressable>
  );
}

export function ReplyCountControl({ count, onPress, align }: { count: number; onPress: () => void; align?: 'start' | 'end' }) {
  const { t } = useNativeUi();
  return <QuietChipControl icon="chatbubble-outline" label={replyCountLabel(count, t)} hint={t('Opens the replies')} onPress={onPress} align={align} />;
}

// "View parent message" under a reply and in a reply thread's header: the same
// quiet chip, where a full-width filled primary button outweighed the reply.
// Above a channel reply's body (`beforeBody`) it takes back the column's gap and
// sets its target's spare height above the chip, lifting the target by that
// gap too, so it meets the line above without covering it: the chip sits 2 pt
// lower, the text about 6 pt closer under it, and its full touch target stays
// clear of the message's own.
// When the screen already holds the message replied to, the chip names its
// author ("Replying to Delia Torres"); otherwise it says "View parent message".
export function parentMessageLabel(author?: string | null, t: NativeUiText = english): string {
  const name = author?.trim();
  return name ? t('Replying to {name}', { name }) : t('View parent message');
}

export function ParentMessageControl({ onPress, align, beforeBody = false, author }: { onPress: () => void; align: 'start' | 'end'; beforeBody?: boolean; author?: string | null }) {
  const { t } = useNativeUi();
  return <QuietChipControl icon="return-up-back-outline" label={parentMessageLabel(author, t)} hint={t('Opens the message this replies to')} onPress={onPress} align={align} chevron={false} beforeBody={beforeBody} />;
}

export function useMessageReplyCounts(sourceKind: SourceKind, scopeKey: string, ids: string[], enabled: boolean) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const key = JSON.stringify(ids);
  useEffect(() => {
    let active = true;
    let version = 0;
    setCounts({});
    const load = async () => {
      const current = ++version;
      try {
        const next = await messageReplyCounts(getSupabaseClient(), sourceKind, JSON.parse(key) as string[]);
        if (active && current === version) setCounts(next);
      } catch (error) {
        if (active && current === version && isReplyAuthorizationError(error)) setCounts({});
      }
    };
    if (!enabled) return;
    void load();
    const timer = setInterval(() => { if (AppState.currentState === 'active') void load(); }, 30000);
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') void load(); });
    return () => { active = false; clearInterval(timer); subscription.remove(); };
  }, [sourceKind, scopeKey, key, enabled]);
  return counts;
}

export function MessageReplies({ sourceKind, targetID, parentID, onClose, onCompose, onOpenParent }: {
  sourceKind: SourceKind; targetID: string; parentID: string; onClose: () => void;
  onOpenParent?: (id: string) => void;
  onCompose: (kind: 'reply' | 'edit', row: Reply) => void;
}) {
  const theme = useTheme();
  const { locale, t } = useNativeUi();
  const [page, setPage] = useState<Page | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const working = useRef<number | null>(null);
  const read = useRef(0);
  const inflight = useRef<AbortController | null>(null);
  async function load(more = false) {
    if (working.current !== null) return;
    const scope = generation.current;
    const version = ++read.current;
    const controller = new AbortController();
    inflight.current = controller;
    working.current = version; setBusy(true); setError(false);
    const cursor = more ? page?.replies.at(-1) ?? null : null;
    try {
      const next = await withinReplyLoadTimeout(
        controller,
        messageReplyPage(getSupabaseClient(), sourceKind, parentID, targetID, cursor, controller.signal) as Promise<Page>,
      );
      if (scope !== generation.current || version !== read.current) return;
      setPage((current) => ({ ...next, replies: more && current
        ? [...current.replies, ...next.replies.filter((row) => !current.replies.some((old) => old.id === row.id))] : next.replies }));
    } catch (error) {
      if (scope === generation.current && version === read.current) {
        if (isReplyAuthorizationError(error)) setPage(null);
        setError(true);
      }
    } finally {
      if (inflight.current === controller) inflight.current = null;
      if (working.current === version) working.current = null;
      if (scope === generation.current && version === read.current) setBusy(false);
    }
  }
  useEffect(() => {
    generation.current += 1; working.current = null; inflight.current?.abort(); inflight.current = null; setPage(null);
    void load();
    const timer = setInterval(() => { if (AppState.currentState === 'active') void load(); }, 30000);
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') void load(); });
    return () => { generation.current += 1; working.current = null; inflight.current?.abort(); inflight.current = null; clearInterval(timer); subscription.remove(); };
  }, [sourceKind, targetID, parentID]);

  return <View style={{ gap: spacing.sm }}>
    <Button label={t('All messages')} onPress={onClose} />
    {busy ? <Text accessibilityLiveRegion="polite" style={{ color: theme.foreground }}>{t('Loading replies…')}</Text> : null}
    {error ? <><Text accessibilityRole="alert" style={{ color: theme.destructive }}>{t('Replies unavailable.')}</Text><Button label={t('Try replies again')} onPress={() => { void load(); }} /></> : null}
    {page ? <>
      <Text accessibilityRole="header" style={{ color: theme.foreground }}>{replyCountLabel(page.count, t)}</Text>
      {page.parent.parent_id && onOpenParent ? <ParentMessageControl align="start" onPress={() => onOpenParent(page.parent.parent_id!)} /> : null}
      {/* A11Y-UG-MOBILE-CHANNEL-AND-REPLY-ROW-NAMES-OMIT-SENDER-20260915:
          the reply control was named by its body alone with the author in the
          metadata line beside it, so VoiceOver read a reply with no writer. The
          control now carries `sender: body`, the name the conversation screen
          composes. The metadata line keeps its visible author for sighted
          readers but announces only the time and the edited state — the author
          and the timestamp share one Text node, so naming that node is how the
          sender stops being said twice without losing the time. */}
      {[page.parent, ...page.replies].map((row) => {
        const bodyText = row.redacted_at ? t('Message removed.') : row.body;
        const meta = `${deviceDateTime(row.created_at, locale) ?? t('Time unavailable')}${row.edited_at ? ` · ${t('Edited')}` : ''}`;
        return <View key={row.id} style={{ gap: spacing.xs }}>
          <Text accessibilityLabel={meta} style={{ color: theme.mutedForeground }}>{row.author_name} · {meta}</Text>
          <NativeMessageActions sourceKind={sourceKind} messageID={row.id} enabled={!row.redacted_at}
            accessibilityLabel={`${row.author_name}: ${bodyText}`}
            onCompose={(kind) => onCompose(kind, row)}>
            {!row.redacted_at && chartReference(row.body) ? <LiveChartMessage body={row.body} /> : <Body>{bodyText}</Body>}
          </NativeMessageActions>
          {row.id !== parentID && onOpenParent ? <Button label={t('View replies')} onPress={() => onOpenParent(row.id)} /> : null}
        </View>;
      })}
      {page.hasMore ? <Button label={t('Load more replies')} disabled={busy} onPress={() => { void load(true); }} /> : null}
    </> : null}
  </View>;
}

const styles = StyleSheet.create({
  replyCount: { maxWidth: '100%', justifyContent: 'center', paddingVertical: spacing.xs },
  replyCountStart: { alignSelf: 'flex-start' },
  replyCountEnd: { alignSelf: 'flex-end' },
  // The footer row's own column gap spaces it from the chip before it.
  replyCountInRow: { marginLeft: 0 },
  chipBeforeBody: { justifyContent: 'flex-end', paddingBottom: 0, marginTop: -spacing.xs, marginBottom: -spacing.xs },
  chipPressed: { transform: [{ scale: 0.96 }] },
  replyCountChevron: { opacity: 0.7 },
  replyCountChip: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.xs, borderRadius: radii.pill, borderWidth: StyleSheet.hairlineWidth },
  replyCountLabel: { flexShrink: 1, fontSize: 14, lineHeight: 19, ...typeface.control },
});
