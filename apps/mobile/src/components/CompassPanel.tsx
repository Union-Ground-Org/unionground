import { captureSessionWriter, type MobileSessionWriter } from '../services/supabase';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { ActivityIndicator, Animated, Keyboard, LayoutAnimation, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
import { Text, TextInput } from './Text';

import { useAccessibilityAnnouncementQueue } from '../lib/announce';
import { CHROME_CLEARANCE, anchoredComposerLift } from '../lib/chrome';
import { previewCompassHistoryFor } from '../data/preview';
import { configureExpansion } from '../lib/expansion';
import { activateCompassSource } from '../lib/compassSourceNavigation';
import { useReduceMotion } from '../lib/reduceMotion';
import { useHeldScreenScope } from '../lib/heldScreenScope';
import { useRequestGeneration } from '../lib/useRequestGeneration';
import { isReadRefusal } from '../lib/readRefusal';
import { DisabledStateBoundary } from './DisabledStateBoundary';
import { PressableScale } from './PressableScale';
import type { CompassMessage, CompassSource } from '../models/member';
import { loadMobileCompassHistory, saveMobileCompassExchange } from '../services/livedIn';
import { loadCompassMemberNudges, loadCompassSwitchConfiguration } from '../services/compassSuggestions';
import { contextualNudgesEnabled, type CompassNudge } from '../lib/compassNudges';
import { BUILT_IN_COMPASS_SUGGESTIONS, scopedCompassValue, memberSuggestedQuestions } from '../lib/compassSuggestions';
import {
  COMPASS_QUESTION_WITHHELD_MESSAGE,
  compassRateLimitMessage,
  isCompassPausedError,
  isCompassQuestionWithheldError,
  isCompassRateLimitError,
} from '../services/supabase';
import { useApp } from '../state/AppProvider';
import { elevation } from '../theme/elevation';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { keyboardDismissModeFor } from './keyboardDismissGesture';
import { Button, Heading, StateMessage } from './ui';

import { typeface } from '../theme/typeface';
import { useNativeUi } from '../lib/useNativeUi';
const maxPersistedAnswerLength = 4000;

type CompassThread = { id: string; title: string; messages: CompassMessage[] };
type PendingCompassSave = {
  threadID: string | null;
  question: string;
  answer: string;
  sources: CompassSource[];
  transcript: CompassMessage[];
  previousMessages: CompassMessage[];
  writer: MobileSessionWriter;
  resumeSave?: boolean;
};

// IA-wave-A review: an answer citing six or seven documents turned the flat
// sources block into the longest object in the transcript, so the answer it
// belongs to scrolled away above it. Three rows show; the rest arrive in place
// behind one "More sources" row of the same anatomy.
//
//  follow-up 1 (a11y conformance) replaced the one-way expansion with a
// real toggle. The one-way version hardcoded `expanded: false` and then
// unmounted the row it had just been pressed on, so VoiceOver reported a state
// that was never true and then lost focus entirely — the reader was dropped
// back to the top of the transcript with no idea whether anything had happened.
// A control that says `expanded` has to answer for both values of it, so the
// row stays mounted, reports the live state, and collapses again on a second
// press.
const SOURCE_ROWS_VISIBLE = 3;
// REQ-UG-LOVABLE-AUDIT-NATIVE-FIXES-BALLOT-FIRST-20261103 (audit
// MOB-STEWARD-02, MOB-COORDINATOR-02, MOB-ADMIN-02, MOB-VP-02): an answer's
// sources say where it came from; this line says when to check it.
export const COMPASS_SOURCE_CAUTION = 'Rights and deadlines depend on your contract and its version. Open a source to check the clause, and ask the committee before a deadline passes.';
// A held source row showed no visible
// pressed state on the iPhone. Rows inside the flat sources block get a
// translucent foreground wash while pressed (12% alpha over the block's muted
// fill), on top of the shared compression and dim.
// The SAMPLE demo (App Store capture, Nov 7, 2026): every Compass question on
// the SAMPLE backend is refused before any answer is drafted, on the website
// as in the app, so a visitor saw a red "Compass is unavailable right now."
// under the question they had just sent. On the SAMPLE build that one generic
// refusal becomes a calm, honest card instead; the question goes back to the
// box, and a paused, rate-limited or withheld question keeps its own words.
export const COMPASS_DEMO_UNAVAILABLE_TITLE = "Guide can't answer in the demo right now";
export const COMPASS_DEMO_HEADER_BODY = 'Not answering in the demo right now';
export const COMPASS_DEMO_UNAVAILABLE_BODY = "In a union's own workspace, Guide answers questions like these from its contract and rights resources, with the sources it used. Your question is still in the box below.";

export function pressedRowFill(foreground: string): string {
  return `${foreground}1F`;
}

export function CompassPanel(props: {
  topPad?: number;
  bottomSafeArea?: number;
  onRouteOut?: () => void;
}) {
  const { mode, session, organizationID, dashboard, authorizedRoles, confirmedMembershipScope } = useApp();
  const scope = useHeldScreenScope(mode === 'booting', [session?.user.id], [mode, organizationID, dashboard?.member.chapterID, authorizedRoles, confirmedMembershipScope]);
  return <FullCompassPanel key={scope} {...props} scope={scope} />;
}

function FullCompassPanel({ topPad = 0, bottomSafeArea = 0, onRouteOut, scope }: {
  topPad?: number;
  bottomSafeArea?: number;
  onRouteOut?: () => void;
  scope: string;
}) {
  const { t, catalogLabel } = useNativeUi();
  const theme = useTheme();
  const router = useRouter();
  const reduceMotion = useReduceMotion();
  const { height: windowHeight } = useWindowDimensions();
  const { askCompass, mode, dashboard, session, previewHat, sampleHat, organizationID, liveSampleBackend, privacyCovered, locked } = useApp();
  // In the demo the role switcher already shows DEMO at the top of the screen;
  // a second filled status badge beside the heading read as a clash (live
  // audit, Nov 8, 2026), so there Compass's preview state is a quiet word. In
  // preview mode the pill itself says PREVIEW, so no second word is added.
  const demoChrome = mode === 'preview' ? Boolean(previewHat) : Boolean(sampleHat);
  const previewPill = mode === 'preview' && Boolean(previewHat);
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<CompassMessage[]>([]);
  const [threadID, setThreadID] = useState<string | null>(null);
  const [threads, setThreads] = useState<CompassThread[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [demoUnavailable, setDemoUnavailable] = useState(false);
  const [loadedMemberID, setLoadedMemberID] = useState<string | null>(null);
  const [loadedOrganizationID, setLoadedOrganizationID] = useState<string | null>(null);
  const [historyReload, setHistoryReload] = useState(0);
  const [pendingSave, setPendingSave] = useState<PendingCompassSave | null>(null);
  const [paused, setPaused] = useState(false);
  const [keyboardOverlap, setKeyboardOverlap] = useState(0);
  const [sceneBottomClearance, setSceneBottomClearance] = useState(0);
  // Per-message, because two answers in one transcript each own their own
  // sources block.
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});
  // REQ-UG-COMPASS-ROLE-SUGGESTED-QUESTIONS-20261001: the organization's
  // worker list once its switches load; preview and an unloaded or failed
  // read keep the built-in starters. An admin who turns suggestions off gets
  // no chips at all.
  const [loadedSuggestions, setSuggestions] = useState<readonly string[]>(BUILT_IN_COMPASS_SUGGESTIONS);
  // REQ-UG-COMPASS-CONTEXTUAL-NUDGES-20261001: the member's own attention nudges.
  const [loadedNudges, setNudges] = useState<CompassNudge[]>([]);
  const [loadedContentScope, setLoadedContentScope] = useState<string | null>(null);
  const authenticatedMemberID = mode === 'authenticated' ? session?.user.id ?? null : null;
  const contentScope = mode === 'preview' ? `preview:${previewHat ?? 'none'}:${organizationID ?? ''}` : scope;
  const requests = useRequestGeneration(contentScope);
  const currentScope = useRef(contentScope);
  currentScope.current = contentScope;
  useEffect(() => () => { currentScope.current = ''; }, []);
  // A history read that overlaps an answer must not replace the still-owned
  // exchange with an older server page, including after a foreground check.
  const exchangeVersion = useRef(0);
  const exchangeBusy = useRef(false);
  const pendingSaveRef = useRef(pendingSave);
  pendingSaveRef.current = pendingSave;
  const activeThread = useRef(threadID);
  activeThread.current = threadID;
  const suggestions = scopedCompassValue(loadedContentScope, contentScope, loadedSuggestions, BUILT_IN_COMPASS_SUGGESTIONS);
  const nudges = scopedCompassValue<CompassNudge[]>(loadedContentScope, contentScope, loadedNudges, []);
  const queueAnnouncement = useAccessibilityAnnouncementQueue(
    `compass:${contentScope}`,
  );
  const historyReady = mode === 'authenticated' && authenticatedMemberID !== null && loadedMemberID === authenticatedMemberID && loadedOrganizationID === (organizationID ?? null);
  const maySave = useRef(false);
  maySave.current = historyReady && !privacyCovered && !locked;
  const visibleMessages = historyReady ? messages : [];
  const visibleThreads = historyReady ? threads : [];
  // After the SAMPLE demo's refusal the header goes neutral with the card
  // below it instead of promising Ready (Nov 7, 2026); the composer
  // stays usable, so the next question is still sent.
  const compassReady = historyReady && !paused && pendingSave === null && !busy && !demoUnavailable;
  // c16 boundary label: read only while the composer is dimmed (the boundary
  // renders the input bare otherwise), so it names the reason the way the
  // Account biometric row does, and it is never the bare placeholder text
  // (voiceoverQ19: an iOS label identical to the placeholder is read twice).
  const composerUnavailableLabel = paused
    ? 'Ask the Guide, paused by an administrator'
    : pendingSave !== null
      ? 'Ask the Guide, unavailable until the unsaved answer is saved or discarded'
      : error
        ? 'Ask the Guide, unavailable — history could not load. Try again below.'
        : 'Ask the Guide, unavailable while your history loads';
  const availability = !historyReady
    ? error
      ? { label: 'UNAVAILABLE', body: 'History could not load. Try again below.', accessibilityLabel: 'Guide is unavailable' }
      : { label: 'LOADING', body: 'Loading your approved campaign sources', accessibilityLabel: 'Guide is loading' }
    : paused
      ? { label: 'PAUSED', body: 'Paused by an administrator', accessibilityLabel: 'Guide is paused' }
      : pendingSave
        ? { label: 'SAVE NEEDED', body: 'Resolve the unsaved answer below', accessibilityLabel: 'Guide needs a save decision' }
        : busy
          ? { label: 'WORKING', body: 'Searching your approved campaign sources', accessibilityLabel: 'Guide is working' }
          : demoUnavailable
            ? { label: 'DEMO', body: COMPASS_DEMO_HEADER_BODY, accessibilityLabel: 'Guide is not answering in the demo right now' }
            : { label: 'READY', body: 'Ready to search your approved campaign sources', accessibilityLabel: 'Guide is ready' };

  useEffect(() => {
    let current = true;
    const retireExchange = () => {
      requests.invalidate(); exchangeVersion.current += 1; exchangeBusy.current = false;
      setQuestion(''); setPendingSave(null); setBusy(false);
      setMessages([]); setThreadID(null); setThreads([]);
      activeThread.current = null;
    };
    setLoadedOrganizationID(null);
    setLoadedMemberID(null);
    if (mode === 'booting') return () => { current = false; };
    if (mode === 'preview' && previewHat) {
      const history = previewCompassHistoryFor(previewHat);
      setMessages(history.messages);
      setThreadID(history.threadID);
      setThreads(history.threads);
      setLoadedMemberID(null);
      setPendingSave(null);
      setPaused(false);
      setError(null);
      return () => { current = false; };
    }
    if (mode !== 'authenticated' || authenticatedMemberID === null) {
      setMessages([]);
      setThreadID(null);
      setThreads([]);
      setLoadedMemberID(null);
      setPendingSave(null);
      setPaused(false);
      return () => { current = false; };
    }
    setPaused(false);
    setError(null);
    setDemoUnavailable(false);
    const version = exchangeVersion.current;
    const exchangePending = exchangeBusy.current || pendingSaveRef.current !== null;
    void loadMobileCompassHistory().then((history) => {
      if (!current) return;
      const retired = activeThread.current !== null && !history.threads.some((thread) => thread.id === activeThread.current);
      if (retired) retireExchange();
      if (retired || (!exchangePending && !exchangeBusy.current && !pendingSaveRef.current && version === exchangeVersion.current)) {
        setMessages(history.messages);
        setThreadID(history.threadID);
        setThreads(history.threads);
      }
      setLoadedMemberID(authenticatedMemberID);
      setLoadedOrganizationID(organizationID ?? null);
    }).catch((error: unknown) => {
      if (!current) return;
      if (isReadRefusal(error)) retireExchange();
      setError('Guide history is unavailable right now.');
    });
    return () => { current = false; };
  }, [authenticatedMemberID, historyReload, mode, previewHat, organizationID, requests]);
  useEffect(() => {
    let current = true;
    setSuggestions(BUILT_IN_COMPASS_SUGGESTIONS);
    setNudges([]);
    setLoadedContentScope(contentScope);
    if (mode !== 'authenticated' || !session || authenticatedMemberID === null) return () => { current = false; };
    void loadCompassSwitchConfiguration(session).then(async (configuration) => {
      if (!current || !configuration) return;
      setSuggestions(memberSuggestedQuestions(configuration));
      if (!contextualNudgesEnabled(configuration)) return;
      const next = await loadCompassMemberNudges(session);
      if (current) setNudges(next);
    }).catch(() => { /* keep the built-in starters */ });
    return () => { current = false; };
    // Token refresh keeps this identity; tenant changes must reload its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticatedMemberID, mode, organizationID, contentScope]);
  // The composer is a growing multiline field, so its height is measured
  // rather than assumed; the transcript pads itself by that much so the last
  // reply's "Approved sources" rows can always be scrolled clear of it.
  const [composerHeight, setComposerHeight] = useState(minimumTouchTarget + spacing.sm);
  const threadRef = useRef<ScrollView>(null);
  // b06-2/b06-5: suggestion chips and unresolved legacy sources hand the
  // worker an editable draft, so both need the composer's own input to take
  // focus after they write into it. Resolved sources route to their reader.
  // Typed through ComponentRef rather than the element type: the preview-chrome
  // contract counts input elements by source text to prove each one pins the
  // light keyboard, and a ref annotation must not read as a second input.
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const sceneRef = useRef<ComponentRef<typeof View>>(null);
  const readyPulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion || !compassReady) {
      readyPulse.stopAnimation();
      readyPulse.setValue(0);
      return undefined;
    }
    // One calm readiness entrance, then fully still. An endless pulse made the
    // assistant feel needy and prevented Android accessibility tooling from
    // ever observing an idle screen.
    const animation = Animated.sequence([
      Animated.timing(readyPulse, { toValue: 1, duration: 1100, useNativeDriver: true }),
      Animated.timing(readyPulse, { toValue: 0, duration: 1100, useNativeDriver: true }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [compassReady, readyPulse, reduceMotion]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, (event) => {
      if (Platform.OS === 'ios') {
        LayoutAnimation.configureNext({
          duration: event.duration || 250,
          update: { type: LayoutAnimation.Types.keyboard },
        });
      }
      const overlap = Math.max(0, windowHeight - event.endCoordinates.screenY);
      setKeyboardOverlap(overlap);
    });
    const hide = Keyboard.addListener(hideEvent, (event) => {
      if (Platform.OS === 'ios') {
        LayoutAnimation.configureNext({
          duration: event.duration || 250,
          update: { type: LayoutAnimation.Types.keyboard },
        });
      }
      setKeyboardOverlap(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [windowHeight]);

  // A question just sent follows the transcript to its end. An answer lands
  // with its question at the top of the view and the keyboard down, so the
  // reader starts at the start of the turn rather than mid-answer behind the
  // keyboard (live audit N9, Nov 8, 2026). The question's offset comes from
  // its measured layout; before it is measured the transcript follows to the
  // end as before. Reduce Motion still needs the destination, so the jump
  // happens without the travel.
  const turnTops = useRef(new Map<string, number>());
  const lastMessageId = messages.slice(-1)[0]?.id;
  const lastRole = messages.slice(-1)[0]?.role;
  const answeredQuestionId = lastRole === 'assistant' ? messages.slice(-2)[0]?.id : undefined;
  useEffect(() => {
    if (!lastMessageId) return;
    if (answeredQuestionId) Keyboard.dismiss();
    const timer = setTimeout(() => {
      const top = answeredQuestionId ? turnTops.current.get(answeredQuestionId) : undefined;
      if (top === undefined) threadRef.current?.scrollToEnd({ animated: !reduceMotion });
      else threadRef.current?.scrollTo({ y: Math.max(0, top - spacing.md), animated: !reduceMotion });
    }, 0);
    return () => { clearTimeout(timer); };
  }, [lastMessageId, answeredQuestionId, reduceMotion]);

  // The composer lifts with the keyboard and takes its ramp with it, so the
  // last reply's "Approved sources" heading can end up inside the ramp at
  // reduced contrast (pass-4 watch item). Following the transcript to the end
  // on keyboard-up clears the heading past it.
  // composerHeight is a dependency because a growing multiline draft raises
  // the composer after the keyboard-open scroll already fired, re-covering
  // the sources heading unless the transcript follows.
  useEffect(() => {
    if (keyboardOverlap <= 0) return;
    const timer = setTimeout(() => { threadRef.current?.scrollToEnd({ animated: !reduceMotion }); }, 0);
    return () => { clearTimeout(timer); };
  }, [keyboardOverlap, composerHeight, reduceMotion]);

  async function submit(value = question) {
    const trimmed = value.trim();
    if (!trimmed || busy || !historyReady || paused || pendingSave) return;
    const writer = captureSessionWriter(session);
    const requestScope = contentScope;
    const ticket = requests.begin();
    exchangeVersion.current += 1;
    exchangeBusy.current = true;
    const userMessage: CompassMessage = { id: `${Date.now()}-user`, role: 'user', body: trimmed };
    const history = [...messages, userMessage];
    setMessages(history);
    setQuestion('');
    setError(null);
    setDemoUnavailable(false);
    setBusy(true);
    try {
      const reply = await askCompass(trimmed, messages, writer);
      if (!ticket.isCurrent()) return;
      if (currentScope.current !== requestScope) return;
      const answer = reply.answer.slice(0, maxPersistedAnswerLength);
      const assistantMessage: CompassMessage = {
        id: `${Date.now()}-assistant`,
        role: 'assistant',
        body: answer,
        sources: reply.sources,
      };
      const transcript = [...history, assistantMessage];
      setMessages(transcript);
      if (mode === 'authenticated') {
        // An answer may arrive under the privacy/session check. Keep it in
        // this owner, but start no follow-up write until this same scope has
        // fresh history access and the app reveals it. A new scope retires it.
        if (!maySave.current) {
          setPendingSave({ writer, threadID, question: trimmed, answer, sources: reply.sources, transcript, previousMessages: messages, resumeSave: true });
          return;
        }
        try {
          const savedThreadID = await saveMobileCompassExchange(writer, threadID, trimmed, answer, reply.sources);
          if (!ticket.isCurrent()) return;
          if (currentScope.current !== requestScope) return;
          recordSavedThread(savedThreadID, transcript, trimmed);
        } catch {
          if (!ticket.isCurrent()) return;
          if (currentScope.current !== requestScope) return;
          setPendingSave({ writer, threadID, question: trimmed, answer, sources: reply.sources, transcript, previousMessages: messages });
          setError('Answer received, but Guide history was not saved.');
        }
      }
    } catch (nextError) {
      if (!ticket.isCurrent()) return;
      if (currentScope.current !== requestScope) return;
      setMessages((current) => current.some((message) => message.id === userMessage.id) ? messages : current);
      setQuestion(trimmed);
      if (isCompassPausedError(nextError)) {
        setPaused(true);
        const pauseMessage = 'The Guide is paused by an administrator.';
        setError(pauseMessage);
        if (Platform.OS === 'ios') queueAnnouncement(catalogLabel(pauseMessage));
      } else if (isCompassRateLimitError(nextError)) {
        setPaused(false);
        const rateLimitMessage = compassRateLimitMessage(nextError.scope);
        setError(rateLimitMessage);
        if (Platform.OS === 'ios') queueAnnouncement(catalogLabel(rateLimitMessage));
      } else if (isCompassQuestionWithheldError(nextError)) {
        setPaused(false);
        setError(COMPASS_QUESTION_WITHHELD_MESSAGE);
        if (Platform.OS === 'ios') queueAnnouncement(catalogLabel(COMPASS_QUESTION_WITHHELD_MESSAGE));
      } else if (liveSampleBackend) {
        setDemoUnavailable(true);
        if (Platform.OS === 'ios') queueAnnouncement(catalogLabel(COMPASS_DEMO_UNAVAILABLE_TITLE));
      } else {
        setError('The Guide is unavailable right now.');
      }
    } finally {
      if (ticket.isCurrent() && currentScope.current === requestScope) { exchangeBusy.current = false; exchangeVersion.current += 1; setBusy(false); }
    }
  }

  // b06-2 (blocker): a suggestion chip used to fire the question straight at
  // the model, so the worker never saw the words they were about to ask and
  // could not amend them. A chip now populates the composer and hands over
  // focus; sending stays the send button's job. An approved source follows a
  // different contract: a resolved destination opens its native reader, while
  // an unresolved legacy source keeps this honest compose fallback. Neither
  // path fires a message.
  function populateComposer(draft: string) {
    if (!historyReady || paused || pendingSave || busy) return;
    setQuestion(draft);
    inputRef.current?.focus();
  }

  // Expands and collapses in place: the rows below the cap join the block where
  // they already belong, through the shared expansion primitive the legal jump
  // card also takes — one duration, one curve, and nothing at all under Reduce
  // Motion. Both directions run through the same call, so the toggle's motion
  // cannot differ from its label.
  function expandSources(messageID: string) {
    configureExpansion(reduceMotion);
    setExpandedSources((current) => ({ ...current, [messageID]: !current[messageID] }));
  }

  function recordSavedThread(savedThreadID: string, transcript: CompassMessage[], title: string) {
    setThreadID(savedThreadID);
    setThreads((current) => {
      const updated = current.map((thread) => thread.id === savedThreadID
        ? { ...thread, messages: transcript }
        : thread);
      const activeThread = updated.find((thread) => thread.id === savedThreadID);
      if (activeThread) return [activeThread, ...updated.filter((thread) => thread.id !== savedThreadID)];
      return [{ id: savedThreadID, title: title.slice(0, 120), messages: transcript }, ...updated];
    });
  }

  async function retryPendingSave() {
    if (!pendingSave || busy || !historyReady || !maySave.current || exchangeBusy.current) return;
    const requestScope = contentScope;
    const ticket = requests.begin();
    exchangeBusy.current = true; exchangeVersion.current += 1;
    setPendingSave({ ...pendingSave, resumeSave: false });
    setBusy(true);
    try {
      const savedThreadID = await saveMobileCompassExchange(
        pendingSave.writer, pendingSave.threadID,
        pendingSave.question,
        pendingSave.answer,
        pendingSave.sources,
      );
      if (!ticket.isCurrent()) return;
      if (currentScope.current !== requestScope) return;
      recordSavedThread(savedThreadID, pendingSave.transcript, pendingSave.question);
      setPendingSave(null);
      setError(null);
    } catch {
      if (ticket.isCurrent() && currentScope.current === requestScope) setError('Answer received, but Guide history was not saved.');
    } finally {
      if (ticket.isCurrent() && currentScope.current === requestScope) { exchangeBusy.current = false; exchangeVersion.current += 1; setBusy(false); }
    }
  }

  const resumeSave = useRef(retryPendingSave);
  resumeSave.current = retryPendingSave;
  useEffect(() => {
    if (pendingSave?.resumeSave && !busy && maySave.current) void resumeSave.current();
  }, [pendingSave, busy, historyReady, privacyCovered, locked]);

  function discardPendingSave() {
    if (!pendingSave || busy) return;
    setMessages(pendingSave.previousMessages);
    setPendingSave(null);
    setError(null);
  }

  // Keyboard frames are window-relative, but NativeTabs scenes already end
  // above the platform bar. Subtract the measured scene-to-window clearance
  // so iOS does not lift this composer by the keyboard *and* tab bar. The
  // quick-actions overlay spans the window, so it passes the unhosted safe-area
  // bottom explicitly and keeps the full keyboard overlap without double lift.
  const composerLift = anchoredComposerLift(
    keyboardOverlap,
    sceneBottomClearance,
    bottomSafeArea,
    spacing.md,
    spacing.sm,
  );

  if (!historyReady) return <View style={[styles.flex, { backgroundColor: theme.background, paddingTop: topPad }]}>
    <StateMessage title="Guide" body={error ? catalogLabel(error) : t('Loading your approved union sources')} />
    {error ? <Button label={t('Try again')} onPress={() => setHistoryReload((value) => value + 1)} /> : null}
  </View>;

  return (
    <View
      ref={sceneRef}
      onLayout={() => {
        if (keyboardOverlap > 0) return;
        sceneRef.current?.measureInWindow((_x, y, _width, height) => {
          const next = Math.max(0, windowHeight - y - height);
          setSceneBottomClearance((previous) => (Math.abs(previous - next) > 0.5 ? next : previous));
        });
      }}
      style={[styles.flex, { backgroundColor: theme.background, paddingTop: topPad }]}
    >
      <ScrollView
        ref={threadRef}
        style={styles.flex}
        contentContainerStyle={[styles.thread, { paddingBottom: composerHeight + CHROME_CLEARANCE }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={keyboardDismissModeFor(Platform.OS)}
      >
        <View style={styles.header}>
          <View style={[styles.headingRow, demoChrome ? styles.headingRowBaseline : null]}>
            <Heading>Guide</Heading>
            {/* Gold text needs a dark-gold or aubergine fill (brief §B), so the
                badge takes the compass fill and its own foreground token
                instead of painting gold letters onto porcelain.
                b06-7: the word is PREVIEW, not BETA — nothing about this build
                is in a beta programme, and PREVIEW is the word the rest of the
                app uses for the unreleased state (it is also the ramp's
                queued/preview label). The capsule's lavender recolour is the
                other half of b06-7 and belongs with the Compass palette pass;
                the fill here is a pinned P1-6 repair. */}
            {previewPill ? null : demoChrome ? (
              <Text maxFontSizeMultiplier={2} style={[styles.previewWord, { color: theme.mutedForeground }]}>{t('Preview')}</Text>
            ) : (
              <View style={[styles.aiPill, { backgroundColor: theme.compass, borderColor: theme.compass }]}>
                <Text style={[styles.aiPillText, { color: theme.compassForeground }]}>{t('PREVIEW')}</Text>
              </View>
            )}
          </View>
        </View>
        {visibleThreads.length > 0 ? (
          <View style={styles.suggestions} accessibilityRole="list" accessibilityLabel={t('Guide conversations')}>
            {visibleThreads.map((thread) => (
              <Pressable
                key={thread.id}
                accessibilityRole="button"
                accessibilityState={{ selected: thread.id === threadID, disabled: busy || pendingSave !== null }}
                disabled={busy || pendingSave !== null}
                onPress={() => { setThreadID(thread.id); setMessages(thread.messages); setDemoUnavailable(false); if (!paused) setError(null); }}
                style={({ pressed }) => [styles.chip, {
                  backgroundColor: thread.id === threadID ? theme.secondary : theme.card,
                  borderColor: thread.id === threadID ? theme.ring : theme.border,
                  opacity: busy || pendingSave !== null ? 0.6 : pressed ? 0.82 : 1,
                }]}
              >
                <Text style={[styles.chipText, { color: theme.secondaryForeground }]}>{thread.title}</Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: busy || pendingSave !== null }}
              disabled={busy || pendingSave !== null}
              onPress={() => { setThreadID(null); setMessages([]); setDemoUnavailable(false); if (!paused) setError(null); }}
              style={({ pressed }) => [styles.chip, { backgroundColor: theme.card, borderColor: theme.border, opacity: busy || pendingSave !== null ? 0.6 : pressed ? 0.82 : 1 }]}
            >
              <Text style={[styles.chipText, { color: theme.secondaryForeground }]}>{t('New conversation')}</Text>
            </Pressable>
          </View>
        ) : null}
        <Animated.View
          accessible
          accessibilityLabel={catalogLabel(availability.accessibilityLabel)}
          style={[
            styles.readyCard,
            { backgroundColor: theme.card, borderColor: theme.border },
            {
              opacity: readyPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.84] }),
              transform: [{ scale: readyPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.025] }) }],
            },
          ]}
        >
          <View style={[styles.readyIcon, { backgroundColor: compassReady ? theme.compass : theme.secondary }]}>
            <Ionicons name="sparkles" size={26} color={compassReady ? theme.compassForeground : theme.secondaryForeground} accessibilityElementsHidden />
          </View>
          <View style={styles.readyCopy}>
            <Text style={[styles.readyTitle, { color: theme.foreground }]}>{t('Guide')}</Text>
            <Text style={[styles.readyBody, { color: theme.mutedForeground }]}>{catalogLabel(availability.body)}</Text>
          </View>
          <View style={[styles.readyStatus, { borderColor: theme.border }]}>
            <View style={[styles.readyDot, { backgroundColor: compassReady ? theme.compass : paused || (!historyReady && error) ? theme.destructive : theme.mutedForeground }]} />
            <Text style={[styles.readyStatusText, { color: theme.foreground }]}>{catalogLabel(availability.label)}</Text>
          </View>
        </Animated.View>
        {visibleMessages.length === 0 ? (
          <View style={styles.empty}>
            <Heading>{dashboard?.member.firstName != null ? t('Hi {name}', { name: dashboard.member.firstName }) : t('Hi there')}</Heading>
            <Heading level={2}>{t('What can I help you find?')}</Heading>
            {/*  follow-up 7: `populateComposer` already refused while a
                question was in flight, but the chips did not say so — they
                stayed lit and fully enabled and simply did nothing when
                pressed, which reads as a broken control rather than a busy one.
                The guard set is now the same one the approved-source rows carry,
                so every populate-not-fire affordance goes inert together. */}
            {nudges.length > 0 && <View style={styles.suggestions} accessibilityLabel={t('Needs your attention')}>
              {nudges.map((nudge) => (
                <Pressable key={nudge.id} accessibilityRole="button" accessibilityLabel={t('{label}. Needs attention', { label: nudge.label })} accessibilityHint={t('Puts a question about it in the composer so you can edit it before sending')} accessibilityState={{ disabled: !historyReady || paused || pendingSave !== null || busy, busy }} disabled={!historyReady || paused || pendingSave !== null || busy} onPress={() => { populateComposer(nudge.prompt); }} style={({ pressed }) => [styles.chip, { backgroundColor: theme.secondary, borderColor: theme.destructive, borderWidth: 1, opacity: !historyReady || paused || pendingSave !== null || busy ? 0.6 : pressed ? 0.82 : 1 }]}>
                  <Text style={[styles.chipText, { color: theme.secondaryForeground }]}>{nudge.label}</Text>
                </Pressable>
              ))}
            </View>}
            {suggestions.length > 0 && <View style={styles.suggestions} accessibilityLabel={t('Suggested questions')}>
              {suggestions.map((suggestion) => (
                <Pressable key={suggestion} accessibilityRole="button" accessibilityHint={t('Puts this question in the composer so you can edit it before sending')} accessibilityState={{ disabled: !historyReady || paused || pendingSave !== null || busy, busy }} disabled={!historyReady || paused || pendingSave !== null || busy} onPress={() => { populateComposer(suggestion); }} style={({ pressed }) => [styles.chip, { backgroundColor: theme.secondary, opacity: !historyReady || paused || pendingSave !== null || busy ? 0.6 : pressed ? 0.82 : 1 }]}>
                  <Text style={[styles.chipText, { color: theme.secondaryForeground }]}>{suggestion}</Text>
                </Pressable>
              ))}
            </View>}
          </View>
        ) : visibleMessages.map((message) => {
          const allSources = message.sources ?? [];
          const sourcesExpanded = expandedSources[message.id] === true;
          const shownSources = sourcesExpanded ? allSources : allSources.slice(0, SOURCE_ROWS_VISIBLE);
          // How many the cap holds back, which is a property of the answer and
          // not of the toggle: it has to keep its value while the block is open
          // so the row can say what collapsing would hide again.
          const hiddenSources = Math.max(0, allSources.length - SOURCE_ROWS_VISIBLE);
          return (
            <View
              key={message.id}
              onLayout={message.role === 'user' ? (event: LayoutChangeEvent) => { turnTops.current.set(message.id, event.nativeEvent.layout.y); } : undefined}
              accessibilityLabel={message.role === 'user' ? t('You: {body}', { body: message.body }) : t('Guide: {body}', { body: message.body })}
              style={message.role === 'user' ? styles.userBubbleWrap : styles.assistantBlock}
            >
              {message.role === 'user' ? (
                // b06-4: the worker turn was a solid aubergine bubble, which
                // out-ranked the answer it asked for and put reversed white text
                // on the heaviest fill in the palette. It reads as the lavender
                // tint the brief specifies (§D) — `secondary` is the palette's
                // lavender-soft fill, i.e. the lavender laid over porcelain at
                // the filed low-alpha treatment — with the aubergine
                // `secondaryForeground` it is already audited against.
                <View style={[styles.bubble, styles.userBubble, { backgroundColor: theme.secondary, borderColor: theme.border }]}>
                  <Text style={[styles.bubbleText, { color: theme.secondaryForeground }]}>{message.body}</Text>
                </View>
              ) : (
                <>
                  <View style={styles.assistantLabelRow}>
                    <Ionicons name="sparkles" size={14} color={theme.compass} accessibilityElementsHidden />
                    <Text style={[styles.assistantLabel, { color: theme.mutedForeground }]}>Guide</Text>
                  </View>
                  {/* b06-3: the answer was a level-1 card, so every turn floated a
                      second surface over the canvas and the transcript read as a
                      stack of receipts. The assistant turn is now unbubbled page
                      text under the ✦ Guide attribution (brief §D); only the
                      structured result below keeps a container. */}
                  <View style={styles.assistantBody}>
                    <Text style={[styles.bubbleText, { color: theme.foreground }]}>{message.body}</Text>
                    {message.sources?.length ? (
                      // b06-5: the flat hairline block stays in place, but rows
                      // with a resolved destination now open their cited native
                      // reader. A legacy/unmapped source keeps the explicit
                      // compose affordance rather than pretending it can open.
                      <View style={[styles.sources, { backgroundColor: theme.muted, borderColor: theme.border }]}>
                        <Text style={[styles.sourcesHeading, { color: theme.foreground }]}>{t('Approved sources')}</Text>
                        {/* Codex IA-A: the rows gave opacity-only feedback, so a
                            source row felt flatter than every Button and Card
                            beside it. They take the shared press primitive —
                            compression plus the same 0.82 dim Button ships —
                            and stay level 0, because a row inside a flat
                            grouped block never floats. Reduce Motion is handled
                            inside the primitive. */}
                        {shownSources.map((source, index) => {
                          const sourceDisabled = !source.destination
                            && (!historyReady || paused || pendingSave !== null || busy);
                          return (
                            <PressableScale
                              key={source.id}
                              accessibilityRole="button"
                              accessibilityLabel={`${source.title}, ${source.ref}`}
                              accessibilityHint={source.destination
                                ? t('Opens this approved source')
                                : t('Puts a follow-up question about this source in the composer')}
                              accessibilityState={{ disabled: sourceDisabled }}
                              disabled={sourceDisabled}
                              onPress={() => {
                                activateCompassSource(
                                  source,
                                  (destination) => {
                                    onRouteOut?.();
                                    router.push(destination as never);
                                  },
                                  populateComposer,
                                );
                              }}
                              resting={elevation.level0}
                              pressedOpacity={0.82}
                              pressedFill={pressedRowFill(theme.foreground)}
                              style={[
                                styles.source,
                                elevation.level0,
                                index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border } : null,
                              ]}
                            >
                              <View style={styles.sourceCopy}>
                                <Text style={[styles.sourceTitle, { color: theme.foreground }]}>{source.title}</Text>
                                <Text style={[styles.sourceRef, { color: theme.mutedForeground }]}>{source.ref}</Text>
                              </View>
                              <Ionicons
                                name={source.destination ? 'open-outline' : 'create-outline'}
                                size={16}
                                color={theme.mutedForeground}
                                accessibilityElementsHidden
                              />
                            </PressableScale>
                          );
                        })}
                        {hiddenSources > 0 ? (
                          // Same 48px row anatomy as a source, so the block reads
                          // as one list: the second line stays provenance-only,
                          // and the count rides the title. The row never
                          // unmounts, so VoiceOver keeps focus on the control it
                          // just operated and hears the state it moved to.
                          <PressableScale
                            accessibilityRole="button"
                            accessibilityLabel={sourcesExpanded ? t('Fewer sources') : t('More sources, {count} more', { count: hiddenSources })}
                            accessibilityHint={sourcesExpanded ? t('Hides the extra approved sources') : t('Shows the remaining approved sources')}
                            accessibilityState={{ expanded: sourcesExpanded }}
                            onPress={() => { expandSources(message.id); }}
                            resting={elevation.level0}
                            pressedOpacity={0.82}
                            pressedFill={pressedRowFill(theme.foreground)}
                            style={[
                              styles.source,
                              elevation.level0,
                              { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
                            ]}
                          >
                            <View style={styles.sourceCopy}>
                              <Text style={[styles.sourceTitle, { color: theme.foreground }]}>
                                {sourcesExpanded ? t('Fewer sources') : t('More sources · {count}', { count: hiddenSources })}
                              </Text>
                            </View>
                            <Ionicons name={sourcesExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={theme.mutedForeground} accessibilityElementsHidden />
                          </PressableScale>
                        ) : null}
                        <Text style={[styles.sourceCaution, { color: theme.mutedForeground }]}>{t(COMPASS_SOURCE_CAUTION)}</Text>
                      </View>
                    ) : null}
                  </View>
                </>
              )}
            </View>
          );
        })}
        {busy ? <ActivityIndicator color={theme.compass} accessibilityLabel={t('The Guide is responding')} /> : null}
        {demoUnavailable && !error ? (
          <View accessible accessibilityLiveRegion="polite" accessibilityLabel={t("Guide can't answer in the demo right now. In a union's own workspace, Guide answers questions like these from its contract and rights resources, with the sources it used. Your question is still in the box below.")} style={[styles.demoNotice, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Ionicons name="sparkles-outline" size={20} color={theme.compass} accessibilityElementsHidden />
            <View style={styles.demoNoticeCopy}>
              <Text style={[styles.demoNoticeTitle, { color: theme.foreground }]}>{t(COMPASS_DEMO_UNAVAILABLE_TITLE)}</Text>
              <Text style={[styles.demoNoticeBody, { color: theme.mutedForeground }]}>{t(COMPASS_DEMO_UNAVAILABLE_BODY)}</Text>
            </View>
          </View>
        ) : null}
        {error ? <Text accessibilityLiveRegion="assertive" style={[styles.error, { color: theme.destructive }]}>{catalogLabel(error)}</Text> : null}
        {pendingSave ? <View style={styles.pendingActions}><Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} onPress={() => { void retryPendingSave(); }} style={[styles.retry, { borderColor: theme.border }]}><Text style={[styles.chipText, { color: theme.cardForeground }]}>{t('Try saving again')}</Text></Pressable><Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} onPress={discardPendingSave} style={[styles.retry, { borderColor: theme.border }]}><Text style={[styles.chipText, { color: theme.cardForeground }]}>{t('Discard unsaved answer')}</Text></Pressable></View> : null}
      </ScrollView>
      {/* The measured block is the composer itself. The Compass copy
          contract: "Do not repeat the preview privacy note below the
          composer." The sensitive-information sentence lives once, on the
          ai-disclosure legal surface, so nothing hangs under the input and the
          transcript's padding and the scrim measure the composer alone. */}
      <View
        onLayout={(event: LayoutChangeEvent) => {
          const next = event.nativeEvent.layout.height;
          setComposerHeight((previous) => (Math.abs(previous - next) > 0.5 ? next : previous));
        }}
        style={[styles.composerDock, { marginBottom: composerLift }]}
      >
        <View style={[styles.composer, { backgroundColor: theme.card, borderColor: theme.border }]}>
          {/* BUG-UG-MOBILE-IOS-COMPASS-QUESTION-FIELD-NOT-DIMMED-WHEN-PAUSED-20260918:
              editable={false} + accessibilityState.disabled land on the host
              view, not on the UITextView VoiceOver focuses. While the composer
              is unavailable (paused, history not ready, or a save pending) the
              boundary owns a label naming the reason, the current draft as its
              value and the disabled state, and hides the native input from the
              tree. The pause announcement and the "Guide is paused"
              availability group are untouched by this. */}
          <DisabledStateBoundary
            disabled={!historyReady || paused || pendingSave !== null}
            accessibilityLabel={catalogLabel(composerUnavailableLabel)}
            accessibilityValue={question ? { text: question } : undefined}
            fill
          >
            <TextInput
              ref={inputRef}
              accessibilityLabel={Platform.OS === 'ios' ? undefined : t('Ask the Guide')}
              multiline
              maxLength={1200}
              keyboardAppearance={theme.appearance}
              selectionColor={theme.primary}
              placeholder={t('Ask the Guide')}
              placeholderTextColor={theme.quietForeground}
              value={question}
              onChangeText={setQuestion}
              editable={historyReady && !paused && pendingSave === null}
              accessibilityState={{ disabled: !historyReady || paused || pendingSave !== null }}
              style={[styles.input, { color: theme.foreground }]}
            />
          </DisabledStateBoundary>
          <Pressable accessibilityRole="button" accessibilityLabel={t('Send question')} accessibilityState={{ disabled: busy || !historyReady || paused || pendingSave !== null || !question.trim() }} disabled={busy || !historyReady || paused || pendingSave !== null || !question.trim()} onPress={() => { void submit(); }} style={({ pressed }) => [styles.send, { backgroundColor: busy || !historyReady || paused || pendingSave !== null || !question.trim() ? theme.muted : theme.compass, opacity: pressed && !(busy || !historyReady || paused || pendingSave !== null || !question.trim()) ? 0.82 : 1 }]}>
            <Ionicons name="arrow-up" size={22} color={busy || !historyReady || paused || pendingSave !== null || !question.trim() ? theme.mutedForeground : theme.compassForeground} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { gap: spacing.xs, paddingBottom: spacing.sm },
  headingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  aiPill: { borderWidth: 1, borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  previewWord: { fontSize: 15, lineHeight: 20, ...typeface.control },
  // The quiet word shares the heading's baseline; the filled badge centres.
  headingRowBaseline: { alignItems: 'baseline', flexWrap: 'wrap' },
  aiPillText: { fontSize: 12, lineHeight: 16, ...typeface.controlStrong, letterSpacing: 0.6 },
  thread: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.md, flexGrow: 1 },
  empty: { alignItems: 'center', paddingVertical: spacing.lg, gap: spacing.lg },
  readyCard: { alignSelf: 'stretch', minHeight: 76, borderWidth: 1, borderRadius: radii.lg, padding: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  readyIcon: { width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
  readyCopy: { flex: 1, gap: 2 },
  readyTitle: { fontSize: 16, lineHeight: 21, ...typeface.heading },
  readyBody: { fontSize: 12, lineHeight: 17, ...typeface.bodyMedium },
  readyStatus: { minHeight: 28, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.pill, paddingHorizontal: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: 5 },
  readyDot: { width: 7, height: 7, borderRadius: 4 },
  readyStatusText: { fontSize: 9, lineHeight: 13, ...typeface.controlStrong, letterSpacing: 0.6 },
  suggestions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.sm },
  chip: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.pill, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, justifyContent: 'center' },
  chipText: { fontSize: 14, lineHeight: 19, ...typeface.control },
  // The secondary fill is 1.08:1 against the canvas, so the bubble's shape
  // is carried by the same audited level-1 hairline as the sources block.
  bubble: { borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth, padding: spacing.md },
  userBubbleWrap: { maxWidth: '88%', alignSelf: 'flex-end' },
  userBubble: { alignSelf: 'flex-end' },
  assistantBlock: { alignSelf: 'stretch', gap: spacing.xs },
  assistantLabelRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  assistantLabel: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  // Unbubbled canvas text (b06-3): no fill, no radius, no shadow — only the
  // rhythm the page already has.
  assistantBody: { gap: spacing.sm },
  bubbleText: { fontSize: 16, lineHeight: 23 },
  // The one container an assistant turn keeps: a flat, faintly tinted hairline
  // block for the structured result (brief §D).
  sources: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.md, marginTop: spacing.xs, paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  sourcesHeading: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong, paddingBottom: spacing.xs },
  source: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderRadius: radii.sm, marginHorizontal: -spacing.xs, paddingHorizontal: spacing.xs },
  sourceCopy: { flex: 1, gap: 2 },
  sourceTitle: { fontSize: 14, lineHeight: 20, ...typeface.control },
  sourceRef: { fontSize: 12, lineHeight: 17 },
  sourceCaution: { fontSize: 12, lineHeight: 17, paddingTop: spacing.xs },
  error: { fontSize: 14, lineHeight: 20, ...typeface.control },
  demoNotice: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.lg, padding: spacing.md },
  demoNoticeCopy: { flex: 1, gap: spacing.xs },
  demoNoticeTitle: { fontSize: 15, lineHeight: 21, ...typeface.heading },
  demoNoticeBody: { fontSize: 14, lineHeight: 20 },
  retry: { minHeight: minimumTouchTarget, alignSelf: 'flex-start', borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, justifyContent: 'center' },
  pendingActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  composerDock: { marginHorizontal: spacing.lg },
  composer: { flexDirection: 'row', alignItems: 'flex-end', borderRadius: radii.lg, borderWidth: 1, paddingHorizontal: spacing.sm, paddingVertical: 2, gap: spacing.sm },
  input: { flex: 1, minHeight: minimumTouchTarget, maxHeight: 88, paddingHorizontal: spacing.sm, paddingVertical: 6, fontSize: 16, lineHeight: 22 },
  send: { width: minimumTouchTarget, height: minimumTouchTarget, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
});
