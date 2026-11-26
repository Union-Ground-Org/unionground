import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Animated, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text, TextInput } from './Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { channelStore } from '../data/demoChannels';
import { NO_CHAPTER_SUBTITLE } from '../lib/chapterIdentity';
import { useReduceMotion } from '../lib/reduceMotion';
import { haptics } from '../services/haptics';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget } from '../theme/tokens';
import { SwipeDownKeyboardDismiss } from './SwipeDownKeyboardDismiss';

import { typeface } from '../theme/typeface';
// The redesign's Discord-style campaign switcher: an organizer may support
// several campaigns, shown as rounded-square rail tiles, then a white panel
// with who's online and channel shortcuts. Seeded demo data, like
// src/data/demoChannels.ts: the codes follow PREVIEW_CHAPTERS in
// src/data/preview.ts, and every campaign is fictional.
const RAIL_WIDTH = 330;

const CHAPTERS = [
  { key: 'hbv', label: 'HBV', selected: true },
  { key: 'nct', label: 'NCT' },
  { key: 'mdc', label: 'MDC' },
];

const PEOPLE = [
  { init: 'MR', name: 'Maria', on: true },
  { init: 'DW', name: 'Dana', on: true },
  { init: 'AC', name: 'Aisha', on: true },
  { init: 'JB', name: 'Jerome', on: false },
];

const PREVIEW_SWATCHES = [
  ['primary', 'primaryForeground'],
  ['compass', 'compassForeground'],
  ['accent', 'accentForeground'],
  ['secondary', 'secondaryForeground'],
] as const;

export function ChapterRail({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const theme = useTheme();
  const reduceMotion = useReduceMotion();
  const { chapterMemberships, mode, previewHat, refreshChapterMemberships, setChapterPinned, switchChapter } = useApp();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [busyChapter, setBusyChapter] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  useSyncExternalStore(channelStore.subscribe, channelStore.getVersion);
  const shift = useRef(new Animated.Value(-RAIL_WIDTH)).current;
  const scrim = useRef(new Animated.Value(0)).current;
  const refreshMembershipsRef = useRef(refreshChapterMemberships);

  useEffect(() => {
    refreshMembershipsRef.current = refreshChapterMemberships;
  }, [refreshChapterMemberships]);

  useEffect(() => {
    // Opening the rail re-reads the active memberships: a campaign revoked
    // since the last dashboard load must not appear as switchable or pinnable.
    // Publishing that read changes the provider callback; keep the opening
    // keyed on visibility and mode so its own result cannot start another read.
    if (!open || mode !== 'authenticated') return;
    refreshMembershipsRef.current().catch(() => undefined);
  }, [mode, open]);

  useEffect(() => {
    const destination = open ? 0 : -RAIL_WIDTH;
    if (reduceMotion) {
      shift.setValue(destination);
      scrim.setValue(open ? 1 : 0);
      return;
    }
    Animated.parallel([
      Animated.timing(shift, { toValue: destination, duration: 260, useNativeDriver: true }),
      Animated.timing(scrim, { toValue: open ? 1 : 0, duration: 240, useNativeDriver: true }),
    ]).start();
  }, [open, reduceMotion, scrim, shift]);

  const visibleChannels = channelStore.channels()
    .filter((channel) => previewHat !== 'member' || !channel.locked)
    .filter((channel) => channel.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const unreadChannels = visibleChannels.filter((channel) => channel.unread > 0).length;
  const live = mode === 'authenticated';
  const liveChapters = chapterMemberships.filter((chapter) => (
    chapter.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
    || (chapter.region ?? '').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  ));
  const previewChapters = CHAPTERS.map((chapter, index) => {
    const [backgroundToken, foregroundToken] = PREVIEW_SWATCHES[index]!;
    return {
      ...chapter,
      background: theme[backgroundToken],
      foreground: theme[foregroundToken],
    };
  });
  const previewPeople = PEOPLE.map((person, index) => {
    const [backgroundToken, foregroundToken] = PREVIEW_SWATCHES[index]!;
    return {
      ...person,
      background: theme[backgroundToken],
      foreground: theme[foregroundToken],
    };
  });
  const railChapters = live
    ? chapterMemberships.map((chapter) => ({
      key: chapter.chapterID,
      label: chapter.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase().slice(0, 3) || 'PSG',
      background: chapter.selected ? theme.primary : theme.secondary,
      foreground: chapter.selected ? theme.primaryForeground : theme.secondaryForeground,
      selected: chapter.selected,
    }))
    : previewChapters;

  async function chooseChapter(chapterID: string) {
    setBusyChapter(chapterID);
    setActionError(null);
    try {
      await switchChapter(chapterID);
      onClose();
    } catch (nextError) {
      // A refusal usually means the membership is no longer active (revoked
      // mid-session). Re-read the authorized list so the stale row leaves the
      // rail now instead of at the next cold start.
      refreshChapterMemberships().catch(() => undefined);
      setActionError(nextError instanceof Error
        ? nextError.message
        : 'That campaign could not be selected. Refresh your campaign list and try again.');
    } finally {
      setBusyChapter(null);
    }
  }

  async function togglePin(chapterID: string, pinned: boolean) {
    setBusyChapter(chapterID);
    setActionError(null);
    try {
      await setChapterPinned(chapterID, !pinned);
    } catch {
      // A refused pin means the membership is no longer active; re-read the
      // list so the row leaves the rail like a refused switch does.
      refreshChapterMemberships().catch(() => undefined);
      setActionError('The campaign pin could not be changed. Refresh and try again.');
    } finally {
      setBusyChapter(null);
    }
  }

  return (
    <Modal visible={open} transparent animationType="none" onRequestClose={onClose}>
      <SwipeDownKeyboardDismiss>
        {/* A11Y-UG-NATIVE-CHAPTER-RAIL-CLOSE-IGNORES-ASSISTIVE-PRESS-20261111:
            the only close control used to be the full-screen dimmed backdrop.
            VoiceOver and TalkBack activate an element at its centre, which
            the rail panel covers, so an assistive press never reached it.
            The backdrop is now touch-only; the visible Close button in the
            panel is the accessible way out, the iPhone escape gesture closes
            the rail, and Android Back still does (onRequestClose). */}
        <View style={styles.overlay} accessibilityViewIsModal onAccessibilityEscape={onClose}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: scrim }]}>
          <Pressable accessible={false} importantForAccessibility="no" style={[StyleSheet.absoluteFill, styles.scrim]} onPress={onClose} />
        </Animated.View>
        <Animated.View style={[styles.railwrap, { transform: [{ translateX: shift }] }]}>
          <View style={[styles.rail, { paddingTop: insets.top + 10, backgroundColor: theme.muted }]}>
            {railChapters.map((chapter) => {
              // Preview tiles are seeded demo campaigns: switching needs a signed-in
              // session, so they are disabled (not inert buttons) and a
              // non-current one says so, with a dashed frame as the visual cue.
              const previewOnly = !live && !chapter.selected;
              const inert = !live || chapter.selected === true || busyChapter !== null;
              return (
                <Pressable
                  key={chapter.key}
                  accessibilityRole="button"
                  accessibilityLabel={`${chapter.label} campaign${chapter.selected ? ', current' : previewOnly ? ', preview only. Sign in to switch campaigns' : ''}`}
                  accessibilityState={{ disabled: inert, selected: chapter.selected === true }}
                  disabled={inert}
                  onPress={() => { if (live) void chooseChapter(chapter.key); }}
                  style={[styles.ritemFrame, chapter.selected ? { borderColor: theme.primary } : previewOnly ? { borderColor: theme.border, borderStyle: 'dashed' } : null]}
                >
                  <View style={[styles.ritem, { backgroundColor: chapter.background, borderColor: theme.primary }]}>
                    <Text style={[styles.ritemText, { color: chapter.foreground }]}>{chapter.label}</Text>
                    {chapter.selected && unreadChannels > 0 ? (
                      <View style={[styles.rbadge, { backgroundColor: theme.destructive, borderColor: theme.muted }]}><Text style={[styles.rbadgeText, { color: theme.destructiveForeground }]}>{unreadChannels}</Text></View>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
            {!live ? (
              <View accessible accessibilityLabel="Additional fictional campaigns appear after onboarding" style={[styles.radd, { backgroundColor: theme.card }]}>
                <Ionicons name="business-outline" size={19} color={theme.primary} />
              </View>
            ) : null}
          </View>
          <View style={[styles.panel, { backgroundColor: theme.card }]}>
            <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 20 }} showsVerticalScrollIndicator={false}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close campaign rail"
                onPress={onClose}
                style={styles.closeButton}
              >
                <Ionicons name="close" size={22} color={theme.cardForeground} />
              </Pressable>
              {live ? (
                <>
                  <View style={styles.panelTitleRow}>
                    <View>
                      <Text style={[styles.panelTitle, { color: theme.cardForeground }]}>Your campaigns</Text>
                      <Text style={[styles.liveSub, { color: theme.mutedForeground }]}>Switching refreshes every role and record for that campaign.</Text>
                    </View>
                  </View>
                  {chapterMemberships.length > 1 ? (
                    <View style={[styles.search, { backgroundColor: theme.secondary }]}>
                      <Ionicons name="search" size={15} color={theme.mutedForeground} />
                      <TextInput
                        accessibilityLabel="Search your campaigns"
                        keyboardAppearance={theme.appearance}
                        placeholder="Search campaigns"
                        placeholderTextColor={theme.quietForeground}
                        value={query}
                        onChangeText={setQuery}
                        style={[styles.searchInput, { color: theme.foreground }]}
                      />
                    </View>
                  ) : null}
                  {actionError ? <Text accessibilityRole="alert" style={[styles.error, { color: theme.destructiveForeground, backgroundColor: theme.destructive }]}>{actionError}</Text> : null}
                  {chapterMemberships.length === 0 ? (
                    <View style={[styles.liveEmpty, { backgroundColor: theme.secondary }]}>
                      <Ionicons name="shield-outline" size={24} color={theme.mutedForeground} />
                      <Text style={[styles.liveEmptyTitle, { color: theme.foreground }]}>No active campaign membership</Text>
                      <Text style={[styles.liveSub, { color: theme.mutedForeground }]}>{NO_CHAPTER_SUBTITLE}</Text>
                    </View>
                  ) : liveChapters.length === 0 ? (
                    <View style={[styles.liveEmpty, { backgroundColor: theme.secondary }]}>
                      <Text style={[styles.liveEmptyTitle, { color: theme.foreground }]}>No matching campaign</Text>
                      <Text style={[styles.liveSub, { color: theme.mutedForeground }]}>Only active memberships are searchable here.</Text>
                    </View>
                  ) : (
                    liveChapters.map((chapter) => (
                      <View key={chapter.chapterID} style={[styles.liveChapter, { borderBottomColor: theme.border }, chapter.selected ? [styles.liveChapterSelected, { backgroundColor: theme.secondary }] : null]}>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`${chapter.name}${chapter.selected ? ', current campaign' : ', switch campaign'}`}
                          disabled={chapter.selected || busyChapter !== null}
                          onPress={() => void chooseChapter(chapter.chapterID)}
                          style={styles.liveChapterMain}
                        >
                          <View style={[styles.liveMark, { backgroundColor: chapter.selected ? theme.primary : theme.muted }]}>
                            <Text style={[styles.liveMarkText, { color: chapter.selected ? theme.primaryForeground : theme.mutedForeground }]}>
                              {chapter.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase().slice(0, 3) || 'PSG'}
                            </Text>
                          </View>
                          <View style={styles.liveChapterCopy}>
                            <Text style={[styles.liveChapterName, { color: theme.foreground }]}>{chapter.name}</Text>
                            <Text style={[styles.liveSub, { color: theme.mutedForeground }]} numberOfLines={2}>
                              {chapter.selected ? 'Current campaign' : chapter.lastSelectedAt ? 'Recent campaign' : 'Your campaign'}
                              {chapter.region ? ` · ${chapter.region}` : ''}
                            </Text>
                            {chapter.roles.length ? <Text style={[styles.roleLine, { color: theme.primary }]}>{chapter.roles.join(' · ')}</Text> : <Text style={[styles.roleLine, { color: theme.primary }]}>Worker</Text>}
                          </View>
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`${chapter.pinned ? 'Unpin' : 'Pin'} ${chapter.name}`}
                          disabled={busyChapter !== null}
                          hitSlop={8}
                          onPress={() => void togglePin(chapter.chapterID, chapter.pinned)}
                          style={styles.pinButton}
                        >
                          <Ionicons name={chapter.pinned ? 'star' : 'star-outline'} size={20} color={chapter.pinned ? theme.primary : theme.mutedForeground} />
                        </Pressable>
                      </View>
                    ))
                  )}
                  {chapterMemberships.length === 1 ? (
                    <Text style={[styles.singleNote, { color: theme.mutedForeground }]}>This account currently belongs to one campaign. Additional active campaign memberships will appear here automatically.</Text>
                  ) : null}
                </>
              ) : (
                <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open Harborview Care United campaign"
                onPress={() => { void haptics.select(); onClose(); router.push('/campaign'); }}
                style={styles.panelTitleRow}
              >
                <Text style={[styles.panelTitle, { color: theme.cardForeground }]}>Harborview Care United</Text>
                <Ionicons name="chevron-forward" size={16} color={theme.mutedForeground} />
              </Pressable>
              <View style={[styles.search, { backgroundColor: theme.secondary }]}>
                <Ionicons name="search" size={15} color={theme.mutedForeground} />
                <TextInput
                  accessibilityLabel="Search campaign channels"
                  keyboardAppearance={theme.appearance}
                  placeholder="Jump to a channel…"
                  placeholderTextColor={theme.quietForeground}
                  value={query}
                  onChangeText={setQuery}
                  style={[styles.searchInput, { color: theme.foreground }]}
                />
              </View>
              <Text style={[styles.sectionLabel, { color: theme.mutedForeground }]}>ONLINE NOW</Text>
              <View style={styles.people}>
                {previewPeople.filter((person) => person.on).map((person) => (
                  <View key={person.init} style={styles.person}>
                    <View style={[styles.personAv, { backgroundColor: person.background, borderColor: theme.primary }]}>
                      <Text style={[styles.personInit, { color: person.foreground }]}>{person.init}</Text>
                      <View style={[styles.presence, { backgroundColor: theme.compass, borderColor: theme.card }]} />
                    </View>
                    <Text style={[styles.personName, { color: theme.mutedForeground }]}>{person.name}</Text>
                  </View>
                ))}
              </View>
              <Text style={[styles.sectionLabel, { color: theme.mutedForeground }]}>CHANNELS</Text>
              {visibleChannels.map((channel) => (
                <Pressable
                  key={channel.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Open #${channel.name}${channel.unread ? `, ${channel.unread} unread` : ''}`}
                  onPress={() => { void haptics.select(); onClose(); router.push(`/channel/${channel.id}` as never); }}
                  style={({ pressed }) => [styles.channelRow, pressed ? { backgroundColor: theme.secondary } : null]}
                >
                  <View style={[styles.hash, { backgroundColor: theme.secondary }]}>
                    {channel.locked ? <Ionicons name="lock-closed" size={13} color={theme.mutedForeground} /> : <Text style={[styles.hashText, { color: theme.mutedForeground }]}>#</Text>}
                  </View>
                  <Text style={[styles.channelName, { color: theme.foreground }, channel.unread ? { ...typeface.controlStrong } : null]} numberOfLines={1}>{channel.name}</Text>
                  {channel.unread ? <View style={[styles.cnt, { backgroundColor: theme.primary }]}><Text style={[styles.cntText, { color: theme.primaryForeground }]}>{channel.unread}</Text></View> : null}
                </Pressable>
              ))}
              {/* B02a blocker: a query that matched nothing removed the whole
                  channel list and put nothing in its place, so the rail read
                  as broken rather than as empty. The sibling feature search
                  already answers this way; the rail now says the same thing in
                  the same grammar. */}
              {visibleChannels.length === 0 ? (
                <View style={[styles.liveEmpty, { backgroundColor: theme.secondary }]}>
                  <Text style={[styles.liveEmptyTitle, { color: theme.foreground }]}>No channels match that search</Text>
                  <Text style={[styles.liveSub, { color: theme.mutedForeground }]}>Clear the search to see every channel your role can open.</Text>
                </View>
              ) : null}
              <View accessible accessibilityLabel="Coworker invitations are managed by campaign administrators" style={styles.channelRow}>
                <View style={[styles.hash, { backgroundColor: theme.secondary }]}><Ionicons name="person-add-outline" size={15} color={theme.primary} /></View>
                <Text style={[styles.channelName, { color: theme.primary, ...typeface.control }]}>Invites are managed by campaign administrators</Text>
              </View>
                </>
              )}
            </ScrollView>
          </View>
        </Animated.View>
        </View>
      </SwipeDownKeyboardDismiss>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1 },
  scrim: { backgroundColor: 'rgba(10,6,14,0.45)' },
  railwrap: { position: 'absolute', top: 0, bottom: 0, left: 0, width: RAIL_WIDTH, flexDirection: 'row' },
  rail: { width: 76, alignItems: 'center', gap: 14, paddingBottom: 20 },
  ritemFrame: { borderRadius: 20, padding: 2, borderWidth: 3, borderColor: 'transparent' },
  ritem: { width: 52, height: 52, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  ritemText: { ...typeface.controlStrong, fontSize: 14 },
  rbadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 99,
    borderWidth: 2.5,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  rbadgeText: { fontSize: 10, ...typeface.controlStrong },
  radd: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  panel: { flex: 1, borderTopRightRadius: 24, borderBottomRightRadius: 24, marginVertical: 8, overflow: 'hidden', paddingHorizontal: 18 },
  closeButton: { alignSelf: 'flex-end', width: minimumTouchTarget, height: minimumTouchTarget, alignItems: 'center', justifyContent: 'center' },
  panelTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: minimumTouchTarget, marginBottom: 4 },
  panelTitle: { fontSize: 22, ...typeface.heading },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 99, minHeight: minimumTouchTarget, paddingHorizontal: 14, marginBottom: 16 },
  searchInput: { flex: 1, minHeight: minimumTouchTarget, fontSize: 13.5, ...typeface.control, paddingVertical: 0 },
  sectionLabel: { fontSize: 11, ...typeface.controlStrong, letterSpacing: 1.5, marginBottom: 9, marginTop: 6 },
  people: { flexDirection: 'row', gap: 14, marginBottom: 18 },
  person: { alignItems: 'center', gap: 6 },
  personAv: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  personInit: { ...typeface.controlStrong, fontSize: 15 },
  presence: { position: 'absolute', right: -2, bottom: -2, width: 12, height: 12, borderRadius: 6, borderWidth: 2.5 },
  personName: { fontSize: 10.5, ...typeface.control },
  channelRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 10, paddingHorizontal: 6, borderRadius: 12, minHeight: minimumTouchTarget },
  hash: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  hashText: { ...typeface.controlStrong, fontSize: 14 },
  channelName: { flex: 1, fontSize: 14.5, ...typeface.body },
  cnt: { borderRadius: 99, paddingHorizontal: 8, paddingVertical: 2 },
  cntText: { fontSize: 11, ...typeface.controlStrong },
  liveSub: { fontSize: 12.5, lineHeight: 18, ...typeface.bodyMedium, maxWidth: 205 },
  error: { borderRadius: 12, padding: 12, fontSize: 12.5, lineHeight: 18, ...typeface.control, marginBottom: 12 },
  liveEmpty: { alignItems: 'center', gap: 7, borderRadius: 16, padding: 22, marginTop: 8 },
  liveEmptyTitle: { fontSize: 15, lineHeight: 20, ...typeface.heading, textAlign: 'center' },
  liveChapter: { minHeight: 82, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center' },
  liveChapterSelected: { borderRadius: 16, borderBottomColor: 'transparent', paddingHorizontal: 8, marginBottom: 6 },
  liveChapterMain: { flex: 1, minHeight: 82, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  liveMark: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  liveMarkText: { fontSize: 12, ...typeface.controlStrong },
  liveChapterCopy: { flex: 1, gap: 1 },
  liveChapterName: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  roleLine: { fontSize: 11.5, lineHeight: 16, ...typeface.controlStrong, textTransform: 'capitalize' },
  pinButton: { width: minimumTouchTarget, height: minimumTouchTarget, alignItems: 'center', justifyContent: 'center' },
  singleNote: { fontSize: 12, lineHeight: 18, marginTop: 14 },
});
