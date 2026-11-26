// REQ-UG-HOME-OVERRIDE-UNREAD-STEWARD-MESSAGE-20261001: the newest unread
// committee message and the newest unread broadcast sit at the top of the live
// Home until the worker opens or marks them read, as the old worker home's
// override slot did. The server decides what qualifies and enforces the
// organization switch (get_member_home_takeover); a refused or failed read
// renders nothing, so Home itself is never blocked by this card.

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../../components/Text';

import { Body, Button, Card, Heading } from '../../components/ui';
import { useWordFit } from '../../components/useWordFit';
import { easternShortDay } from '../../lib/evidenceTimestamp';
import type { HomeTakeover } from '../../lib/memberHomeShared';
import { haptics } from '../../services/haptics';
import { loadMemberHomeTakeover, markMemberBroadcastRead } from '../../services/memberHome';
import { markConversationRead } from '../../services/supabase';
import { captureSessionWriter } from '../../services/supabase';
import { useApp } from '../../state/AppProvider';
import { useTheme } from '../../theme/ThemeProvider';
import { radii, spacing } from '../../theme/tokens';

import { typeface } from '../../theme/typeface';
const EMPTY: HomeTakeover = { enabled: false, message: null, broadcast: null };

export function takeoverUnreadSignature(conversations: readonly { id: string; unreadCount: number }[]): string {
  return conversations.map((item) => `${item.id}:${item.unreadCount}`).sort().join('|');
}

function shortDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value));
}

// "ANNOUNCEMENT" split between letters at the largest iPhone text size
// (ledger 381): the label grows only while its longest word fits its line.
function Eyebrow({ children, color }: { children: string; color: string }) {
  const fit = useWordFit(true, children, styles.eyebrow, 'caps');
  return (
    <Text onLayout={fit.onLayout} allowFontScaling={fit.allowFontScaling} style={[styles.eyebrow, { color }, fit.style]}>
      {children}
    </Text>
  );
}

type HomeTakeoverSlots = {
  message: ReactElement | null;
  broadcast: ReactElement | null;
  broadcastID: string | null;
  isBroadcastDismissed: (id: string) => boolean;
};
type HomeTakeoverProps = {
  enabled?: boolean;
  render?: (updates: HomeTakeoverSlots) => ReactNode;
};

export function HomeTakeoverUpdates({ message, broadcast }: Pick<HomeTakeoverSlots, 'message' | 'broadcast'>) {
  return message || broadcast ? (
    <View style={styles.section} accessibilityLabel="Unread updates">
      {message}
      {broadcast}
    </View>
  ) : null;
}

export function HomeTakeoverCards(props: HomeTakeoverProps = {}) {
  const app = useApp();
  return <HomeTakeoverContent key={app.sharedDemoVisit?.key ?? app.session?.user.id ?? 'ordinary'} app={app} {...props} />;
}

function HomeTakeoverContent({ app, enabled = true, render }: HomeTakeoverProps & { app: ReturnType<typeof useApp> }) {
  const router = useRouter();
  const theme = useTheme();
  const { mode, session, sampleHat, sharedDemoVisit, dashboard, refresh, captureAuthenticatedSessionGuard } = app;
  const [takeover, setTakeover] = useState<HomeTakeover>(EMPTY);
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const signature = takeoverUnreadSignature(dashboard?.conversations ?? []);

  useEffect(() => {
    if (!enabled || mode !== 'authenticated' || !session?.access_token) {
      setTakeover(EMPTY);
      return undefined;
    }
    let active = true;
    void loadMemberHomeTakeover(session)
      .then((next) => { if (active) setTakeover(next); })
      .catch(() => { if (active) setTakeover(EMPTY); });
    return () => { active = false; };
  }, [enabled, mode, session, signature, reload]);

  const visibleTakeover = enabled && mode === 'authenticated' ? takeover : EMPTY;
  const isDismissed = (key: string) => dismissed.includes(key) || (sharedDemoVisit?.dismissed.includes(key) ?? false);
  const message = visibleTakeover.message && !isDismissed(`m:${visibleTakeover.message.id}`) ? visibleTakeover.message : null;
  const broadcast = visibleTakeover.broadcast && !isDismissed(`b:${visibleTakeover.broadcast.id}`) ? visibleTakeover.broadcast : null;
  // The same Eastern day My chapter's briefing archive shows for this published_at.
  const broadcastDay = broadcast ? easternShortDay(broadcast.publishedAt) : null;

  async function markRead(key: string, write: (userID: string) => Promise<void>) {
    const userID = session?.user.id;
    if (!userID || busy) return;
    // A shared demo visitor can dismiss this card on this phone for this visit.
    if (sampleHat) {
      void haptics.success();
      sharedDemoVisit?.dismiss(key);
      return;
    }
    const current = captureAuthenticatedSessionGuard();
    setBusy(key);
    setFailed(null);
    try {
      await write(userID);
      if (!current()) return;
      void haptics.success();
      setDismissed((items) => [...items, key]);
      setReload((value) => value + 1);
      void refresh();
    } catch {
      if (current()) setFailed(key);
    } finally {
      if (current()) setBusy(null);
    }
  }

  const updates: HomeTakeoverSlots = {
    broadcastID: broadcast?.id ?? null,
    isBroadcastDismissed: (id) => isDismissed(`b:${id}`),
    message: message ? (
      <Card style={[styles.card, { borderLeftColor: theme.primary }]}>
        <View style={styles.head}>
          <Ionicons name="mail-outline" size={18} color={theme.primary} accessibilityElementsHidden />
          <Text style={[styles.eyebrow, { color: theme.mutedForeground }]}>MESSAGE FROM YOUR COMMITTEE · {shortDate(message.createdAt)}</Text>
        </View>
        <Heading level={2}>{message.senderName ? `${message.senderName} wrote to you` : 'Your committee wrote to you'}</Heading>
        <Body>{message.truncated ? `${message.body.trimEnd()}…` : message.body}</Body>
        <View style={styles.actions}>
          <Button
            label="Open conversation"
            onPress={() => { void haptics.select(); router.push(`/conversation/${message.conversationId}`); }}
          />
          <Button
            label="Mark read"
            variant="secondary"
            busy={busy === `m:${message.id}`}
            onPress={() => { void markRead(`m:${message.id}`, (userID) => markConversationRead(captureSessionWriter(session), userID, message.conversationId)); }}
          />
        </View>
        {failed === `m:${message.id}` ? <Body accessibilityRole="alert">That couldn’t be marked read. Try again.</Body> : null}
      </Card>
    ) : null,
    broadcast: broadcast ? (
      <Card style={[styles.card, { borderLeftColor: theme.accent }]}>
        <View style={styles.head}>
          <Ionicons name="megaphone-outline" size={18} color={theme.primary} accessibilityElementsHidden />
          <Eyebrow color={theme.mutedForeground}>
            {`${broadcast.audience === 'chapter' ? 'CAMPAIGN ANNOUNCEMENT' : 'ANNOUNCEMENT'}${broadcastDay ? ` · ${broadcastDay}` : ''}`}
          </Eyebrow>
        </View>
        <Heading level={2}>{broadcast.title}</Heading>
        {broadcast.sender ? <Body muted>{broadcast.sender}</Body> : null}
        {broadcast.body ? <Body>{broadcast.truncated ? `${broadcast.body.trimEnd()}…` : broadcast.body}</Body> : null}
        <View style={styles.actions}>
          <Button
            label="Mark read"
            variant="secondary"
            busy={busy === `b:${broadcast.id}`}
            onPress={() => { void markRead(`b:${broadcast.id}`, (userID) => markMemberBroadcastRead(userID, broadcast.id)); }}
          />
        </View>
        {failed === `b:${broadcast.id}` ? <Body accessibilityRole="alert">That couldn’t be marked read. Try again.</Body> : null}
      </Card>
    ) : null,
  };
  return render ? render(updates) : <HomeTakeoverUpdates {...updates} />;
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  card: { gap: spacing.sm, borderLeftWidth: 4, borderRadius: radii.md },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  eyebrow: { flex: 1, fontSize: 11, lineHeight: 15, ...typeface.controlStrong, letterSpacing: 0.8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
