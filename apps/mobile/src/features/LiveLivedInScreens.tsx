import { useBusinessDraftState } from '../lib/useBusinessDraftState';
import { useBusinessOperation } from '../lib/useBusinessWriter';
import { useBusinessRequests, useBusinessWriter, useBusinessState } from '../lib/useBusinessWriter';
import { useNativeUi } from "../lib/useNativeUi";
import { withReadDeadline } from '../lib/readDeadline';
import { defineRetainedSurface, useRetainedDraft, type Held } from '../lib/retainedDraft';
import { AskCompassButton } from '../components/AskCompassButton';
import type { NativeUiText } from '../lib/nativeUiCopy';
import { AppointmentHoursCard } from './AppointmentHoursCard';
import { ScheduleMeetingCard } from './ScheduleMeetingCard';
import { isAuthoritativeReadRefusal } from '../lib/readRefusal';
import { NativeUnitWorkloadEntry, NativeUnitSettingsEditor } from './NativeUnitSettings';
import { compareEventSchedule, eventRsvpClosedText, eventTypeText } from '../lib/eventModelShared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIsFocused, useNavigation } from 'expo-router';
import { Platform, Pressable, StyleSheet, View, type ScrollView } from 'react-native';
import { Text, TextInput } from '../components/Text';

import { Body, Button, Card, Heading, Notice, Screen, StateMessage } from '../components/ui';
import { WorkflowActions } from '../components/WorkflowActions';
import { connectedWorkflowApi } from '../lib/connectedWorkflows';
import { AttachmentPanel } from '../components/AttachmentPanel';
import { QuarterlySurveyGate } from '../components/QuarterlySurveyGate';
import { ContextualPulseCard, useNativeContextualPulse } from './ContextualPulseCard';
import { appointmentRangeLabel } from '../lib/appointmentBooking';
import { CONTRIBUTIONS_COPY, RECOGNITION_RUNGS, canOpenFeature } from '../lib/featureCatalog';
import type { FeatureKey, RecognitionRule, RecognitionRung } from '../lib/featureCatalog';
import {
  checkInMobileEvent,
  describeEventActionRefusal,
  loadMobileChapterDocument,
  loadMobileChapterHistory,
  loadMobileEventsHistory,
  loadMobileContributions,
  loadMobileRightsHistory,
  loadMobileTasksHistory,
  loadMobileWorkloadHistory,
  loadMobileStewardAppointmentsDesk,
  type LivedInStewardAppointment,
  type LivedInStewardAppointmentsDesk,
  markMobileBroadcastRead,
  prepareAuthorizedEventCalendarExport,
  requestMobileSteward,
  saveMobileRightsProgress,
  scanCheckinRefusalCopy,
  scanMobileEventCheckin,
  setMobileEventRsvp,
  type LivedInChapter,
  type LivedInChapterDocument,
  type LivedInEvent,
  type LivedInRights,
  type LivedInTask,
  type MobileEventScanResult,
} from '../services/livedIn';
import { useAccessibilityAnnouncementQueue } from '../lib/announce';
import { useScreenBackInterceptor } from '../lib/screenBack';
import { haptics } from '../services/haptics';
import { loadMobileMemberSurveys, saveMobileSurveySession, submitMobileSurveySession } from '../services/memberSurveys';
import {
  SURVEY_TEXT_LIMITS,
  missingRequiredQuestions,
  pruneHiddenAnswers,
  surveyChoices,
  surveyKicker,
  surveySessionStatus,
  toggleSelection,
  visibleQuestions,
  withAnswer,
  type MemberSurvey,
  type MemberSurveySnapshot,
  type SurveyAnswer,
  type SurveyAnswers,
  type SurveyQuestion,
} from '../lib/memberSurveysShared';
import {
  calendarExportWasSaved,
  exportToDeviceCalendar,
  isCalendarExportAvailable,
} from '../services/nativeCalendarExport';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { normalizeMemberReportCard } from '../lib/mi1AnalyticsShared';
import { compassSourceMatchesReaderRecord } from '../lib/compassSourceNavigation';
import { loadMobileMemberReportCard, type MobileStaffRole } from '../services/supabase';
import { offersEventCalendarExport } from '../lib/calendarExportOffer';
import { calendarExportFailureText } from '../lib/calendarExportFailure';
import { useApp } from '../state/AppProvider';
import { LearningContentManager } from './learning/LearningContentManager';
import { LearningLibrarySection } from './learning/LearningLibrarySection';
import { useTaskDocumentHandoff } from './TaskDocumentHandoffProvider';
import { NativeFeatureGuide } from './guideLayers/GuideLayers';
import { ContinueReadingCard, RightsReadingSections, rightsBookmarks, useRightsBookmark, useRightsReadingScope } from './RightsResumeReading';
import { rightsBookmarkFor, rightsReaderLesson, resumeRightsReading } from '../lib/rightsResumeReading';
import { WorkFilterButton, WorkFilterPresetsCard } from './WorkFilterPresetsCard';
import { filterCurrentWorkTasks, workFilterScopeKey } from '../services/workFilterPresets';
import { deviceCalendarDay, deviceDateTime, deviceDayRange, easternDateTime, evidenceUpdatedMeta } from '../lib/evidenceTimestamp';
import { monthBuckets } from '../lib/monthBuckets';
import { MY_REPORTS_SUMMARY, OWN_RETAINED_HISTORY } from '../lib/scopedMetrics';
import { eventCheckInClosed, eventWhenLabel, splitEventsByTime } from '../lib/eventWhen';
import { ChapterCaseRowTopicCard } from './CaseRowTopicCards';

import { typeface } from '../theme/typeface';
// `onOpenTask` comes from the routed screen; this module stays free of the
// router so its screens can be exercised without one.
export function LiveLivedInScreen({ featureKey, sourceID, onOpenTask }: { featureKey: FeatureKey; sourceID?: string; onOpenTask?: (taskID: string) => void }) {
  if (featureKey === 'events' || featureKey === 'events-desk') return featureKey === 'events-desk' ? <LiveEventsScreen staffDesk sourceID={sourceID} /> : <LiveEventsScreen sourceID={sourceID} />;
  if (featureKey === 'rewards') return <LiveRewardsScreen />;
  if (featureKey === 'workload') return <LiveWorkloadScreen />;
  if (featureKey === 'rights') return <LiveRightsScreen sourceID={sourceID} />;
  if (featureKey === 'chapter') return <LiveChapterScreen sourceID={sourceID} />;
  if (featureKey === 'tasks') return <LiveTasksScreen sourceID={sourceID} onOpenTask={onOpenTask} />;
  if (featureKey === 'numbers') return <LiveReportsScreen />;
  if (featureKey === 'steward-appointments') return <LiveStewardAppointmentsScreen />;
  return null;
}

// DEBT-UG-MOBILE-MEMBER-PULSES-AND-WEB-VOICE-SURVEYS-ARE-TWO-DISCONNECTED-DATA-MODELS-20260921
// ( THE NATIVE APP READS THE WEB SURVEYS): this section
// renders the surveys the web engagement studio authors (organization_surveys)
// from the same worker snapshot RPC the web Voice surface reads, and saves or
// submits answers through the same session RPCs, on the web's own answer
// model. The legacy single-question "pulse" reader and its writer are retired
// from the native app; that legacy table and its policies are untouched.
export function LiveSurveyHistory() {
  const theme = useTheme();
  const [snapshot, setSnapshot] = useState<MemberSurveySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    // A refresh after one card saves or submits keeps every card mounted, so
    // answers typed into another survey but not yet saved survive it (review
    // thread on); only the first load shows the loading state.
    if (reload === 0) setSnapshot(null);
    setError(null);
    void loadMobileMemberSurveys().then((value) => { if (current) setSnapshot(value); }).catch(() => { if (current) setError('Your surveys could not be refreshed.'); });
    return () => { current = false; };
  }, [reload]);
  const gate = snapshot?.quarterlyGate;
  // The gate RPC filters by organization, cadence, period and status only; the
  // surveys list also applies campaign scope and the open window. Show the
  // notice only when the worker can actually open the gated survey.
  const gateSurveyOpen = Boolean(gate?.surveyId && snapshot?.surveys.some((survey) => survey.id === gate.surveyId));
  return (
    <>
      <Heading level={2}>Your surveys</Heading>
      <Body muted>Surveys your campaign published, with your saved and submitted answers. The same surveys appear on the web.</Body>
      {error ? <Card><Body style={{ color: theme.destructive }}>{error}</Body><Button label="Try again" onPress={() => setReload((value) => value + 1)} /></Card> : null}
      {gate?.required && !gate.completed && gateSurveyOpen ? <Card>
        <MetaRow label="QUARTERLY" status="Required" />
        <Heading level={3}>Quarterly worker survey</Heading>
        <Body muted>Complete this quarter’s survey to finish the worker check-in.</Body>
      </Card> : null}
      {snapshot === null && !error ? <StateMessage title="Loading your surveys" body="Checking the surveys open to you and your saved answers." />
        : snapshot && snapshot.surveys.length === 0 ? <StateMessage title="No open surveys" body="Surveys your campaign publishes will appear here." />
        : snapshot?.surveys.map((survey) => <LiveSurveyCard key={survey.id} survey={survey} onUpdated={() => setReload((value) => value + 1)} />)}
    </>
  );
}

//  pull request D (design R-9240D): unsaved survey answers wait through a
// foreground session check on the shared draft hook (memory only), as the
// learning editor's do. The holder keys them to the person, every role set,
// the hat and the organization; the survey id names the item, and any
// confirmed chapter or organization change, sign-out, another account or MFA
// retires them. Nothing held shows until the provider's reads are back. Both
// writes replace the person's own session for this survey (a save) or close
// it once (a submit), so sending again never makes a second response: an
// answer lost on the way back is a definite failure, and the answers stay.
type SurveyKind = 'save' | 'submit';
const surveyAnswersSurface = defineRetainedSurface<Held<SurveyAnswers>>('survey-answers');
const SURVEY_FAILURE: Readonly<Record<SurveyKind, string>> = { save: 'Survey progress could not be saved.', submit: 'Survey could not be submitted.' };
const surveyFailureText = (key: string | null): string | null => (key === 'save' || key === 'submit' ? SURVEY_FAILURE[key] : null);

function LiveSurveyCard({ survey, onUpdated }: { survey: MemberSurvey; onUpdated: () => void }) {
  const { locale, t } = useNativeUi();
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer, survey.id);
  const theme = useTheme();
  // The answers the server holds, or the ones this card just saved until the
  // fresh snapshot carries them.
  const serverAnswers = survey.session?.answers ?? {};
  const serverBasis = JSON.stringify(serverAnswers);
  const [acknowledged, setAcknowledged] = useBusinessDraftState<{ basis: string; answers: SurveyAnswers } | null>(null, survey.id);
  const baseline = acknowledged && acknowledged.basis === serverBasis ? acknowledged.answers : serverAnswers;
  const held = useRetainedDraft<SurveyAnswers>({
    surface: surveyAnswersSurface, item: survey.id, empty: baseline, fresh: true, scope: 'organization', basis: JSON.stringify(baseline),
  });
  const answers = held.value;
  const [busy, setBusy] = useBusinessState<SurveyKind | null>(null);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, null);
  const [notice, setNotice] = useBusinessDraftState<{ text: string; error: boolean } | null>(null, survey.id);
  const [acceptedSubmit, setAcceptedSubmit] = useBusinessDraftState(false, survey.id);
  const submitted = acceptedSubmit || surveySessionStatus(survey) === 'submitted';
  const locked = busy !== null || held.pending !== false;
  const visible = useMemo(() => visibleQuestions(survey, answers) as SurveyQuestion[], [survey, answers]);
  const missing = missingRequiredQuestions(survey, answers) as SurveyQuestion[];
  // A response submitted elsewhere never takes the person's unsaved answers
  // with it: they stay on screen, locked, with a notice, until the person
  // discards them. The survey takes one response, so nothing is offered to
  // send them again. A send in flight from this person decides itself.
  const keptAfterSubmit = submitted && held.shown && held.pending !== 'sending' && JSON.stringify(answers) !== JSON.stringify(baseline);
  function setAnswer(questionID: string, value: SurveyAnswer | undefined) {
    held.set((current) => withAnswer(current, questionID, value) as SurveyAnswers);
    setNotice(null);
  }
  async function run(kind: SurveyKind) {
    await operate(kind, async () => {
    if (!held.shown || held.pending !== false || keptAfterSubmit) return;
    const current = requests.capture().isCurrent;
    // Unchanged answers (already saved) send without a held attempt.
    const attempt = held.begin();
    // Hidden descendants are pruned from exactly the answers this attempt holds.
    const answers = attempt ? attempt.value : baseline;
    const sent = pruneHiddenAnswers(survey, answers) as SurveyAnswers;
     setNotice(null);
    try {
      if (kind === 'save') {
        await withReadDeadline(saveMobileSurveySession(writer, survey.id, sent));
        attempt?.settle('done');
        setAcknowledged({ basis: serverBasis, answers: sent });
        setNotice({ text: 'Progress saved.', error: false });
      } else {
        await withReadDeadline(submitMobileSurveySession(writer, survey.id, sent));
        attempt?.settle('done');
        setAcceptedSubmit(true);
        setNotice({ text: 'Survey submitted.', error: false });
        if (await writer.isCurrent() && current()) void haptics.success();
      }
      if (await writer.isCurrent() && current()) await onUpdated();
    } catch {
      attempt?.settle({ failed: kind });
      setNotice({ text: SURVEY_FAILURE[kind], error: true });
    }

    });
  }
  // A failure line from this mount, or the one held with the answers.
  const heldFailure = surveyFailureText(held.failed);
  const line = notice ?? (heldFailure ? { text: heldFailure, error: true } : null);
  const closesAt = deviceDateTime(survey.closesAt, locale);
  return <Card>
    <MetaRow label={surveyKicker(survey).toUpperCase()} status={submitted ? 'Submitted' : survey.session ? 'In progress' : 'Open'} />
    <Heading level={3}>{survey.title}</Heading>
    {survey.description ? <Body muted>{survey.description}</Body> : null}
    {survey.closesAt ? <Body muted>{closesAt ? t('Closes {when}', { when: closesAt }) : t('Closing time unavailable')}</Body> : null}
    {submitted && !keptAfterSubmit ? <Body>Your response is complete.</Body> : !held.shown ? <Body muted>Loading your answers…</Body> : <>
      {visible.map((question, index) => <LiveSurveyQuestion
        key={question.id}
        question={question}
        value={answers[question.id]}
        disabled={locked || keptAfterSubmit}
        sectionTitle={question.sectionTitle && (index === 0 || visible[index - 1]?.sectionKey !== question.sectionKey) ? question.sectionTitle : null}
        onChange={(value) => setAnswer(question.id, value)}
      />)}
      {keptAfterSubmit ? <><Body accessibilityRole="alert">This survey was submitted elsewhere. Your unsaved answers are kept here until you discard them.</Body>
        <Button label="Discard my unsaved answers" variant="secondary" onPress={() => { held.discard(); setNotice(null); }} /></> : <>
      {held.stale ? <><Body>Your saved answers changed while you were away. Your unsaved answers are kept here.</Body>
        <Button label="Use my saved answers" variant="secondary" disabled={locked} onPress={() => { held.discard(); setNotice(null); }} /></> : null}
      {line ? <Body style={line.error ? { color: theme.destructive } : undefined}>{line.text}</Body> : null}
      <Button label={busy === 'save' ? 'Saving…' : 'Save for later'} variant="secondary" disabled={locked} onPress={() => { void run('save'); }} />
      <Button label={busy === 'submit' ? 'Submitting…' : 'Submit survey'} disabled={locked || missing.length > 0} onPress={() => { void run('submit'); }} />
      {missing.length > 0 ? <Body muted>{missing.length === 1
        ? t('1 required question still needs an answer.')
        : t('{count} required questions still need an answer.', { count: missing.length })}</Body> : null}
      </>}
    </>}
  </Card>;
}

function LiveSurveyQuestion({ question, value, disabled, sectionTitle, onChange }: {
  question: SurveyQuestion;
  value: SurveyAnswer | undefined;
  disabled: boolean;
  sectionTitle: string | null;
  onChange: (value: SurveyAnswer | undefined) => void;
}) {
  const theme = useTheme();
  const label = `${question.label}${question.required ? ' *' : ''}`;
  const header = <>
    {sectionTitle ? <Heading level={3}>{sectionTitle}</Heading> : null}
    <Body>{label}</Body>
  </>;
  if (question.type === 'text' || question.type === 'paragraph') {
    const paragraph = question.type === 'paragraph';
    return <View style={styles.surveyQuestion}>
      {header}
      <TextInput
        accessibilityLabel={label}
        editable={!disabled}
        multiline={paragraph}
        maxLength={paragraph ? SURVEY_TEXT_LIMITS.paragraph : SURVEY_TEXT_LIMITS.text}
        value={typeof value === 'string' ? value : ''}
        onChangeText={(text) => onChange(text === '' ? undefined : text)}
        placeholder={paragraph ? 'Your answer' : undefined}
        placeholderTextColor={theme.quietForeground}
        style={[styles.input, paragraph ? styles.surveyParagraph : null, { borderColor: theme.border, color: theme.cardForeground, backgroundColor: theme.card }]}
      />
    </View>;
  }
  const choices = surveyChoices(question) as { value: string | number; label: string }[];
  if (question.type === 'checkbox') {
    const selected = Array.isArray(value) ? value : [];
    return <View style={styles.surveyQuestion}>
      {header}
      {question.maxSelections ? <Body muted>Choose up to {question.maxSelections}.</Body> : null}
      {choices.map((choice) => {
        const checked = selected.some((item) => String(item) === String(choice.value));
        const atLimit = Boolean(question.maxSelections && selected.length >= question.maxSelections);
        return <Pressable
          key={String(choice.value)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked, disabled: disabled || (!checked && atLimit) }}
          disabled={disabled || (!checked && atLimit)}
          onPress={() => onChange(toggleSelection(question, selected, choice.value) as SurveyAnswer)}
          style={({ pressed }) => [styles.option, { borderColor: checked ? theme.ring : theme.border, backgroundColor: checked ? theme.secondary : theme.card, opacity: pressed ? 0.82 : 1 }]}
        ><Text style={[styles.optionText, { color: theme.cardForeground }]}>{choice.label}</Text></Pressable>;
      })}
    </View>;
  }
  return <View style={styles.surveyQuestion}>
    {header}
    {(question.type === 'scale' || question.type === 'rating') && (question.scaleMinLabel || question.scaleMaxLabel)
      ? <Body muted>{[question.scaleMinLabel, question.scaleMaxLabel].filter(Boolean).join(' → ')}</Body> : null}
    {choices.map((choice) => {
      const chosen = String(value ?? '') === String(choice.value);
      return <Pressable
        key={String(choice.value)}
        accessibilityRole="radio"
        accessibilityState={{ selected: chosen, disabled }}
        disabled={disabled}
        onPress={() => onChange(choice.value)}
        style={({ pressed }) => [styles.option, { borderColor: chosen ? theme.ring : theme.border, backgroundColor: chosen ? theme.secondary : theme.card, opacity: pressed ? 0.82 : 1 }]}
      ><Text style={[styles.optionText, { color: theme.cardForeground }]}>{choice.label}</Text></Pressable>;
    })}
  </View>;
}

const MEETING_SCHEDULER_ROLES: readonly MobileStaffRole[] = ['steward', 'coordinator', 'advisor', 'vp', 'admin'];

function LiveEventsScreen({ staffDesk = false, sourceID }: { staffDesk?: boolean; sourceID?: string }) {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer, sourceID);
  const theme = useTheme();
  const { catalogLabel, locale, t } = useNativeUi();
  const { captureAuthenticatedSessionGuard, authorizedRoles, dashboard, mode, sampleHat, liveSampleBackend } = useApp();
  const [events, setEvents] = useBusinessDraftState<LivedInEvent[] | null>(null);
  const [eventsSource, setEventsSource] = useBusinessDraftState<string | undefined>(undefined);
  const [draftReadRefused, setDraftReadRefused] = useBusinessDraftState<{ sourceID: string | undefined } | null>(null);
  const [code, setCode] = useBusinessDraftState<Record<string, string>>({});
  const [busy, setBusy] = useBusinessState<string | null>(null);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, null);
  const [error, setError] = useBusinessDraftState<string | null>(null);
  const [scanResults, setScanResults] = useBusinessDraftState<Record<string, MobileEventScanResult>>({});
  const [reload, setReload] = useBusinessDraftState(0);
  // The scan outcome is spoken through the shared announcement queue, so each
  // scan is a distinct attempt that supersedes this desk's previous pending
  // line and is cancelled if the desk unmounts before VoiceOver reaches it.
  const queueScanAnnouncement = useAccessibilityAnnouncementQueue(staffDesk ? 'events-desk-scan' : 'events-scan');
  const queueCalendarAnnouncement = useAccessibilityAnnouncementQueue(staffDesk ? 'events-desk-calendar' : 'events-calendar');
  // The staff desk only offers the committee scan workflow when the loaded
  // staff scope proves a committee grant; any other route renders nothing and
  // issues no RPC. The server re-checks the grant inside scan_event_checkin.
  const stewardScanAllowed = staffDesk && authorizedRoles.includes('steward');
  //  part 1: the roles private.member_can_manage_events admits may
  // schedule a chapter meeting here; the RPC checks the role again.
  const meetingScheduleAllowed = staffDesk && MEETING_SCHEDULER_ROLES.some((role) => authorizedRoles.includes(role));
  // The feed also carries public and cross-agency meetings owned by other
  // campaigns, but scan_event_checkin only accepts meetings in the committee
  // member's own campaign. Offer the scan control only where a token can actually be taken.
  const stewardChapterID = dashboard?.member.chapterID ?? null;
  function stewardCanScan(event: LivedInEvent) {
    return stewardScanAllowed && stewardChapterID !== null && event.chapterID === stewardChapterID;
  }
  const eventReads = useRef(0);
  const refreshEvents = useCallback(async () => {
    const ticket = requests.capture();
    if (!ticket.isCurrent()) return false;
    const at = ++eventReads.current;
    const current = () => at === eventReads.current && ticket.isCurrent(); setEvents(null); setError(null);
    let missingSource = false;
    return await withReadDeadline((async () => {
      if (sourceID) {
        const source = await connectedWorkflowApi()?.context({ kind: 'event', id: sourceID });
        if (!source?.available) { missingSource = source?.available === false; throw new Error('Source unavailable'); }
      }
      if (!current()) return [];
      const value = await loadMobileEventsHistory();
      if (sourceID && !value.some((event) => event.id === sourceID)) { missingSource = true; throw new Error('Source unavailable'); }
      return value;
    })()).then((value) => {
      if (!current()) return false;
      setEventsSource(sourceID); setDraftReadRefused(null); setEvents(sourceID ? value.filter((event) => event.id === sourceID) : value);
      return true;
    }).catch((error: unknown) => { if (current()) { if (missingSource || isAuthoritativeReadRefusal(error)) setDraftReadRefused({ sourceID }); setError('Meetings could not be refreshed.'); } return false; });
  }, [sourceID, requests, setEventsSource, setDraftReadRefused, setEvents, setError]);
  useEffect(() => { void refreshEvents(); return () => { eventReads.current += 1; }; }, [reload, refreshEvents]);
  // A saved RSVP or check-in updates only that card. Bumping the reload key
  // would swap the list for "Loading meetings" and remount it at the oldest
  // meeting, far above the card the worker just acted on.
  function updateEvent(eventID: string, patch: Partial<LivedInEvent>) {
    setEvents((current) => current?.map((item) => item.id === eventID ? { ...item, ...patch } : item) ?? current);
  }
  async function changeRsvp(event: LivedInEvent, status: 'going' | 'not_going') {
    await operate(event.id, async () => {
     setError(null);
    try { await setMobileEventRsvp(writer, event.id, status); updateEvent(event.id, { rsvp: status }); if (await writer.isCurrent()) void haptics.success(); }
    catch (refusal) { setError(describeEventActionRefusal(refusal, 'rsvp')); }

    });
  }
  async function checkIn(event: LivedInEvent) {
    await operate(event.id, async () => {
     setError(null);
    try { await checkInMobileEvent(writer, event.id, code[event.id] ?? ''); updateEvent(event.id, { checkedInAt: new Date().toISOString() }); if (await writer.isCurrent()) void haptics.success(); }
    catch (refusal) { setError(describeEventActionRefusal(refusal, 'check-in')); }

    });
  }
  async function scanCheckIn(event: LivedInEvent) {
    await operate(event.id, async () => {
    if (!stewardCanScan(event)) return;
     setError(null);
    // A new attempt retires this event's prior confirmation so a rejected
    // token can never sit beside a stale success for the same event.
    setScanResults((current) => { const next = { ...current }; delete next[event.id]; return next; });
    try {
      const result = await scanMobileEventCheckin(writer, event.id, code[event.id] ?? '');
      const copy = scanResultCopy(result);
      setScanResults((current) => ({ ...current, [event.id]: result }));
      // The single-use token is consumed on success; clear it so the next
      // worker can be entered without resubmitting a guaranteed-invalid code.
      setCode((current) => { const next = { ...current }; delete next[event.id]; return next; });
      // The result line is a polite live region for TalkBack; VoiceOver
      // ignores that attribute, so the shared announcement path speaks the
      // outcome (and which worker it belongs to) there.
      if (Platform.OS === 'ios') queueScanAnnouncement(copy);
      if (await writer.isCurrent()) void haptics.success();
    } catch (error) {
      const copy = scanCheckinRefusalCopy(error);
      setError(copy);
      if (Platform.OS === 'ios') queueScanAnnouncement(copy);
    }


    });
  }
  const calendarReady = useMemo(() => isCalendarExportAvailable(), []);
  // Item 4 of the calendar-export record: SAMPLE/PREVIEW fixtures never offer
  // export into a real device calendar.
  const calendarOffer = useMemo(() => ({
    mode, sampleHat, liveSampleBackend, calendarReady,
  }), [calendarReady, liveSampleBackend, mode, sampleHat]);
  async function addToCalendar(event: LivedInEvent) {
    await operate(event.id, async () => {
     setError(null);
    try {
      const sessionStillCurrent = captureAuthenticatedSessionGuard();
      const payload = await prepareAuthorizedEventCalendarExport(event.id, Date.now());
      const result = await exportToDeviceCalendar(payload, sessionStillCurrent);
      if (result === 'unavailable') setError('No calendar app on this phone could take that meeting.');
      else if (calendarExportWasSaved(result)) void haptics.success();
    } catch (failure) {
      const copy = catalogLabel(calendarExportFailureText(failure, 'event'));
      setError(copy);
      // The error line is a polite live region for TalkBack; VoiceOver hears it here.
      if (Platform.OS === 'ios') queueCalendarAnnouncement(copy);
    }

    });
  }
  const range = deviceDayRange(events?.map((item) => item.eventDate ? `${item.eventDate}T12:00:00` : item.startsAt) ?? [], locale);
  const eventLanguage = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('es') ? 'es' : 'en';
  return <Screen>
    {staffDesk ? null : <NativeFeatureGuide feature="events" />}
    <Heading>{catalogLabel(staffDesk ? 'Meetings desk' : 'Meetings')}</Heading><Body muted>{events?.length ?? 0} meetings{range ? ` · ${range}` : ''}. {staffDesk ? 'Review the complete campaign calendar without changing a worker RSVP.' : 'RSVP and check-in state comes from your account.'}</Body>
    {meetingScheduleAllowed ? <ScheduleMeetingCard freshAccess={events !== null && error === null && eventsSource === sourceID} accessRetired={draftReadRefused !== null && draftReadRefused.sourceID === sourceID} resumeItemID={sourceID ?? 'new'} onScheduled={refreshEvents} /> : null}
    {error ? <Card><View accessibilityLiveRegion="polite"><Body style={{ color: theme.destructive }}>{error}</Body></View><Button label="Try again" onPress={() => setReload((value) => value + 1)} /></Card> : null}
    {events === null ? !error && <StateMessage title="Loading meetings" body="Reading the campaign calendar and your attendance history." /> : events.length === 0 ? <StateMessage title="No meetings" body="Published campaign meetings will appear here." /> : (() => {
      const split = splitEventsByTime(events);
      const upcomingEvents = split.upcoming;
      if (stewardChapterID !== null) {
        upcomingEvents.sort((a, b) => (
          Number(b.chapterID === stewardChapterID) - Number(a.chapterID === stewardChapterID)
          || compareEventSchedule(a, b)
        ));
      }
      const firstOtherEvent = stewardChapterID === null ? -1
        : upcomingEvents.findIndex((event) => event.chapterID !== stewardChapterID);
      const pastEvents = split.past;
      const renderEvent = (event: LivedInEvent) => {
      const eventTime = Date.parse(event.startsAt);
      const upcoming = (event.eventKind ?? 'meeting') === 'meeting' && eventTime > Date.now();
      const checkInOpen = event.checkInOffered && (event.eventKind ?? 'meeting') === 'meeting' && Date.now() >= eventTime - 2 * 60 * 60 * 1_000 && Date.now() <= eventTime + 4 * 60 * 60 * 1_000;
      const scanAllowedHere = stewardCanScan(event);
      return <Card key={event.id}>
      <MetaRow label="MEETING" status={event.cancelled ? 'Cancelled' : event.eventKind && event.eventKind !== 'meeting' ? eventTypeText(eventLanguage, event.eventKind) : event.checkedInAt ? 'Checked in' : event.rsvp ? event.rsvp.replace('_', ' ') : 'No RSVP'} />
      <Heading level={3}>{event.title}</Heading>
      <WorkflowActions kind="event" id={event.id} recordTitle={event.title} />
      <Body muted>{eventWhenLabel(event, eventLanguage)} · {event.location}</Body>{event.summary ? <Body>{event.summary}</Body> : null}{event.cancelled && event.cancellationReason ? <Body muted>Cancellation note: {event.cancellationReason}</Body> : null}
      {!event.checkInOffered ? <Body muted>No check-in</Body> : eventCheckInClosed(event) ? <Body muted>Check-in closed. This meeting has ended.</Body> : null}
      {!staffDesk && !event.cancelled && upcoming && event.rsvpOpen !== false ? <View accessibilityRole="radiogroup" accessibilityLabel={`RSVP for ${event.title}`} style={styles.actions}><Button label={event.rsvp === 'going' ? 'Going · Selected' : 'Going'} accessibilityLabel="Going" selected={event.rsvp === 'going'} variant={event.rsvp === 'going' ? 'primary' : 'secondary'} disabled={busy !== null} onPress={() => { void changeRsvp(event, 'going'); }} /><Button label={event.rsvp === 'not_going' ? "Can't go · Selected" : "Can't go"} accessibilityLabel="Can't go" selected={event.rsvp === 'not_going'} variant="secondary" disabled={busy !== null} onPress={() => { void changeRsvp(event, 'not_going'); }} /></View> : null}
      {/* Staff switched RSVP collection off: say so instead of offering a Going the server would refuse. A member who already said yes can still withdraw, as on web. */}
      {!staffDesk && !event.cancelled && upcoming && event.rsvpOpen === false ? <><Body muted>{eventRsvpClosedText(eventLanguage)}</Body>{event.rsvp === 'going' ? <View style={styles.actions}><Button label="Can't go" variant="secondary" disabled={busy !== null} onPress={() => { void changeRsvp(event, 'not_going'); }} /></View> : null}</> : null}
      {offersEventCalendarExport(calendarOffer, event, Date.now()) ? <View style={styles.actions}><Button label="Add to calendar" variant="secondary" disabled={busy !== null} onPress={() => { void addToCalendar(event); }} /></View> : null}
      {!staffDesk && !event.cancelled && checkInOpen && !event.checkedInAt ? <View style={styles.inline}><TextInput accessibilityLabel={`Check-in code for ${event.title}`} autoCapitalize="characters" maxLength={32} value={code[event.id] ?? ''} onChangeText={(value) => setCode((current) => ({ ...current, [event.id]: value }))} placeholder="Meeting code" placeholderTextColor={theme.quietForeground} style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} /><Button label="Check in" disabled={busy !== null || !(code[event.id] ?? '').trim()} onPress={() => { void checkIn(event); }} /></View> : null}
      {scanAllowedHere && !event.cancelled && checkInOpen ? <View style={styles.inline}><TextInput accessibilityLabel={`Worker check-in code for ${event.title}`} autoCapitalize="characters" maxLength={32} value={code[event.id] ?? ''} onChangeText={(value) => setCode((current) => ({ ...current, [event.id]: value }))} placeholder="Worker code" placeholderTextColor={theme.quietForeground} style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} /><Button label="Scan check-in" disabled={busy !== null || !(code[event.id] ?? '').trim()} onPress={() => { void scanCheckIn(event); }} /></View> : null}
      {scanAllowedHere && scanResults[event.id] ? <View accessibilityLiveRegion="polite"><Body>{scanResultCopy(scanResults[event.id]!)}</Body></View> : null}
    </Card>; };
      return <>
        <Heading level={2}>Upcoming · {upcomingEvents.length}</Heading>
        {upcomingEvents.length === 0 ? <Body muted>No upcoming meetings.</Body> : firstOtherEvent > 0 ? <>
          <Heading level={3}>{t('Meetings in this campaign')}</Heading>
          {upcomingEvents.slice(0, firstOtherEvent).map(renderEvent)}
          <Heading level={3}>{t('Other meetings')}</Heading>
          {upcomingEvents.slice(firstOtherEvent).map(renderEvent)}
        </> : upcomingEvents.map(renderEvent)}
        {pastEvents.length > 0 ? <><Heading level={2}>Past · {pastEvents.length}</Heading>{pastEvents.map(renderEvent)}</> : null}
      </>;
    })()}
  </Screen>;
}

// Module-level so useLoader's effect sees one stable loader (an inline arrow
// would reload on every render). Rule labels follow the device language.
function loadDeviceContributions() {
  return loadMobileContributions(Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('es'));
}

function LiveRewardsScreen() {
  const { catalogLabel } = useNativeUi();
  const [data, error, retry] = useLoader(loadDeviceContributions);
  return <Screen><Heading>{catalogLabel('Contributions')}</Heading><Body muted>{CONTRIBUTIONS_COPY.eyebrow}</Body>
    {error ? <LoadError message="Contributions could not be refreshed." onRetry={retry} /> : data === null ? <Loading title="Loading contributions" /> : (
      <ContributionsSections
        currentRung={data.currentRung}
        totalVerified={data.totalVerified}
        recentVerified={data.recentVerified}
        rules={data.rules}
        acknowledgements={data.events.map((event) => ({ id: event.id, recognitionKind: event.recognitionKind, sourceLabel: event.sourceLabel, dateLabel: formatDay(event.occurredAt) }))}
      />
    )}</Screen>;
}

/**
 * The Contributions body shared by the preview desk and a live session,
 * matching the web's RewardsView: the recognition boundary, the participation
 * path, the eligible kinds, recent acknowledgements and what is never
 * recognized. There is no balance, rank, claim or spending history to show.
 */
export function ContributionsSections({ currentRung, totalVerified, recentVerified, rules, acknowledgements }: {
  currentRung: RecognitionRung;
  totalVerified: number;
  recentVerified: number;
  rules: readonly RecognitionRule[];
  acknowledgements: readonly { id: string; recognitionKind: string; sourceLabel: string; dateLabel: string }[];
}) {
  const theme = useTheme();
  return <>
    <Card>
      <Heading level={2}>{CONTRIBUTIONS_COPY.boundaryTitle}</Heading>
      <Body muted>{CONTRIBUTIONS_COPY.boundarySub}</Body>
      <Body>{CONTRIBUTIONS_COPY.noEffect}</Body>
    </Card>
    <Card>
      <MetaRow label={CONTRIBUTIONS_COPY.currentPath.toLocaleUpperCase()} status={`${totalVerified} ${CONTRIBUTIONS_COPY.verified}`} />
      {RECOGNITION_RUNGS.map((rung) => (
        <View key={rung.key} accessible accessibilityLabel={rung.key === currentRung ? `${rung.label}, ${CONTRIBUTIONS_COPY.currentPath}` : rung.label} style={styles.meta}>
          <Text style={[styles.eyebrow, { color: rung.key === currentRung ? theme.primary : theme.mutedForeground }]}>{rung.label}</Text>
          {rung.key === currentRung ? <Text style={[styles.eyebrow, { color: theme.primary }]}>{CONTRIBUTIONS_COPY.currentPath}</Text> : null}
        </View>
      ))}
    </Card>
    <Heading level={2}>{CONTRIBUTIONS_COPY.catalogTitle}</Heading>
    <Body muted>{CONTRIBUTIONS_COPY.catalogSub}</Body>
    {rules.length === 0 ? <Card><Body muted>{CONTRIBUTIONS_COPY.emptyRules}</Body></Card> : rules.map((rule) => (
      <Card key={rule.recognitionKind}><MetaRow label={rule.label} status={CONTRIBUTIONS_COPY.verified} /><Body muted>{rule.description}</Body></Card>
    ))}
    <Heading level={2}>{CONTRIBUTIONS_COPY.recentTitle} · {recentVerified}</Heading>
    <Body muted>{CONTRIBUTIONS_COPY.recentSub}</Body>
    {acknowledgements.length === 0 ? <Card><Body muted>{CONTRIBUTIONS_COPY.emptyAcknowledgements}</Body></Card> : acknowledgements.map((item) => (
      <Card key={item.id}><MetaRow label={item.dateLabel} status={CONTRIBUTIONS_COPY.verified} /><Heading level={3}>{rules.find((rule) => rule.recognitionKind === item.recognitionKind)?.label ?? item.recognitionKind.replaceAll('_', ' ')}</Heading>{item.sourceLabel ? <Body muted>{item.sourceLabel}</Body> : null}</Card>
    ))}
    <Card>
      <Heading level={3}>{CONTRIBUTIONS_COPY.notRecognizedTitle}</Heading>
      <Body muted>{CONTRIBUTIONS_COPY.notRecognizedSub}</Body>
      <Body>{CONTRIBUTIONS_COPY.notRecognizedList}</Body>
    </Card>
  </>;
}

function LiveWorkloadScreen() {
  const { catalogLabel, locale, t } = useNativeUi();
  const [data, error, retry] = useLoader(loadMobileWorkloadHistory);
  const months = useMemo(() => monthBuckets(data?.logs ?? [], (item) => item.loggedOn, (item) => item.pending + item.todos), [data]);
  return <Screen><Heading>{catalogLabel('Workplace log')}</Heading><Body muted>Your complete personal workload history and privacy-protected campaign benchmark.</Body>
    <NativeUnitWorkloadEntry onSaved={retry} />
    <QuarterlySurveyGate>
    {error ? <LoadError message="Workplace log could not be refreshed." onRetry={retry} /> : data === null ? <Loading title="Loading workplace log" /> : <>
      <Card><MetaRow label="HISTORY" status={workloadLogCount(data.logs.length, t)} /><Heading level={3}>{deviceDayRange(data.logs.map((item) => item.loggedOn), locale)}</Heading><Body muted>{data.stats.enoughData ? `${String(data.stats.submittersBand)} campaign submitters · ${String(data.stats.period)}` : `Campaign comparison hidden · minimum ${String(data.stats.minSubmitters ?? 25)} submitters`}</Body></Card>
      {months.map((month) => <Card key={month.key}><MetaRow label={month.label} status={workloadLogCount(month.count, t)} /><Heading level={3}>{month.total} tracked pending + to-do items</Heading></Card>)}
      {data.logs.map((log) => <Card key={log.id}><MetaRow label={deviceCalendarDay(log.loggedOn, locale) ?? t('Date unavailable')} status={`${log.priority} priority`} />{log.unitName ? <Body muted>{log.unitName}</Body> : null}<Body>{log.pending} pending · {log.todos} to do · {log.referrals} referrals · {log.assistanceRequests} assistance requests</Body>{log.note ? <Body muted>{log.note}</Body> : null}</Card>)}
    </>}
    </QuarterlySurveyGate></Screen>;
}

function LiveRightsScreen({ sourceID }: { sourceID?: string }) {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer);
  const { t, locale, catalogLabel } = useNativeUi();
  const theme = useTheme();
  const [data, setData] = useBusinessState<LivedInRights | null>(null);
  const [error, setError] = useBusinessState(false);
  const [busy, setBusy] = useBusinessState<string | null>(null);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, null);
  const [sourceDismissed, setSourceDismissed] = useBusinessDraftState(false);
  const [rightsReload, setRightsReload] = useBusinessDraftState(0);
  // REQ-UG-QUOTES-MINI-LESSONS-20260928: the learning-content manager
  // is a level inside this screen, opened from the mini-lesson section.
  const [managingLearning, setManagingLearning] = useBusinessDraftState(false);
  // REQ-UG-CONTEXTUAL-PULSE-PRODUCT-TRIGGERS-20261001: rights reading is a
  // quick-check screen (live sessions only; this screen never runs in preview).
  const pulse = useNativeContextualPulse('rights.page', !managingLearning);
  // REQ-UG-RIGHTS-RESUME-READING-20261029: one saved place, opened
  // only by Continue reading. It never marks progress; a Compass source wins.
  const readingScope = useRightsReadingScope();
  const place = useRightsBookmark(readingScope);
  const [openedLessonID, setOpenedLessonID] = useBusinessDraftState<string | null>(null);
  const [scrollAnchor, setScrollAnchor] = useBusinessDraftState<string | null>(null);
  const [placeBusy, setPlaceBusy] = useBusinessDraftState(false);
  const [placeStatus, setPlaceStatus] = useBusinessDraftState<{ text: string; warning: boolean } | null>(null);
  const [failedAnchor, setFailedAnchor] = useBusinessDraftState<string | null>(null);
  const announcePlace = useAccessibilityAnnouncementQueue('rights-resume');
  const scrollRef = useRef<ScrollView | null>(null);
  const scrollAnchorRef = useRef(scrollAnchor);
  scrollAnchorRef.current = scrollAnchor;
  useEffect(() => { let current = true; setData(null); setError(false); void loadMobileRightsHistory().then((value) => { if (current) setData(value); }).catch(() => { if (current) setError(true); }); return () => { current = false; }; }, [rightsReload, setData, setError]);
  async function complete(lesson: LivedInRights['lessons'][number]) {
    await operate(lesson.id, async () => {
    const scopeCurrent = requests.capture().isCurrent;
     setError(false);
    try {
      await saveMobileRightsProgress(writer, lesson.id, lesson.steps.map((_, index) => index));
      setData((current) => current ? { ...current, lessons: current.lessons.map((item) => item.id === lesson.id ? { ...item, completedSteps: lesson.steps.map((_, index) => index) } : item) } : current);
      if (await writer.check() !== 'current' || !scopeCurrent()) return;
      const next = await loadMobileRightsHistory();
      if (await writer.check() !== 'current' || !scopeCurrent()) return;
      setData(next);
      void haptics.success();
    }
    catch { if (scopeCurrent()) setError(true); }

    });
  }
  async function request(lessonID: string) {
    await operate(lessonID, async () => {
    const scopeCurrent = requests.capture().isCurrent;
     setError(false);
    try {
      await requestMobileSteward(writer, lessonID);
      setData((current) => current ? { ...current, lessons: current.lessons.map((item) => item.id === lessonID ? { ...item, requestStatus: 'requested' } : item) } : current);
      if (await writer.check() !== 'current' || !scopeCurrent()) return;
      const next = await loadMobileRightsHistory();
      if (await writer.check() !== 'current' || !scopeCurrent()) return;
      setData(next);
      void haptics.success();
    }
    catch { if (scopeCurrent()) setError(true); }

    });
  }
  function showPlaceStatus(text: string, warning: boolean) {
    setPlaceStatus({ text, warning });
    // A Notice announces itself; plain confirmations are announced here.
    if (!warning) announcePlace(text);
  }
  function openLesson(lessonID: string | null, anchor: string | null = null) {
    setOpenedLessonID(lessonID); setScrollAnchor(anchor); setPlaceStatus(null); setFailedAnchor(null);
  }
  async function continueReading() {
    setPlaceBusy(true); setPlaceStatus(null);
    try {
      const outcome = await resumeRightsReading(rightsBookmarks, readingScope, async () => { const fresh = await loadMobileRightsHistory(); setData(fresh); return fresh.lessons; });
      if (outcome.kind === 'open') { openLesson(outcome.lessonID, outcome.anchor); showPlaceStatus(catalogLabel(outcome.message), outcome.changed); return; }
      place.refresh();
      if (outcome.kind === 'unavailable') showPlaceStatus(catalogLabel(outcome.message), true);
    } catch { showPlaceStatus(t('Rights could not be reloaded, so your saved place was kept. Try again.'), true); }
    finally { setPlaceBusy(false); }
  }
  async function savePlace(lesson: LivedInRights['lessons'][number], anchor: string) {
    setPlaceBusy(true); setPlaceStatus(null); setFailedAnchor(null); setScrollAnchor(null);
    try { await place.save(rightsBookmarkFor(lesson, anchor)); announcePlace(t('Place saved. Continue reading from the rights list.')); if (await writer.isCurrent()) void haptics.success(); }
    catch { setFailedAnchor(anchor); if (await writer.isCurrent()) void haptics.warning(); }
    finally { setPlaceBusy(false); }
  }
  async function clearPlace() {
    setPlaceBusy(true); setPlaceStatus(null);
    try { await place.clear(); showPlaceStatus(t('Saved place cleared.'), false); }
    catch { showPlaceStatus(t('Your saved place could not be cleared on this device. Try again.'), true); }
    finally { setPlaceBusy(false); }
  }
  const sourceLesson = !sourceDismissed && sourceID && data
    ? data.lessons.find((lesson) => compassSourceMatchesReaderRecord(sourceID, 'rights', lesson.id)) ?? null
    : null;
  const selectedArticle = !sourceDismissed && sourceID && data
    ? data.articles.find((article) => compassSourceMatchesReaderRecord(sourceID, 'kb', article.slug)) ?? null
    : null;
  const missingSource = Boolean(sourceID && !sourceDismissed && data && !sourceLesson && !selectedArticle);
  const readerLessonID = rightsReaderLesson({ sourceLessonID: sourceLesson?.id ?? null, openedLessonID: sourceID && !sourceDismissed ? null : openedLessonID });
  const readerLesson = data?.lessons.find((lesson) => lesson.id === readerLessonID) ?? null;
  // Index and reader share one scroll surface; a resume target scrolls itself.
  useEffect(() => { if (scrollAnchorRef.current === null) scrollRef.current?.scrollTo({ y: 0, animated: false }); }, [readerLessonID]);
  const placeNotice = placeStatus ? placeStatus.warning ? <Notice>{placeStatus.text}</Notice> : <Body muted>{placeStatus.text}</Body> : null;

  if (managingLearning) {
    return <LearningContentManager onClose={() => setManagingLearning(false)} />;
  }
  if (readerLesson) {
    const fromSource = readerLesson === sourceLesson;
    return <Screen scrollRef={scrollRef} onScrollProgress={pulse.onScrollProgress}>
      <Button label={fromSource ? t("All rights sources") : t("All rights lessons")} variant="secondary" onPress={() => { if (fromSource) setSourceDismissed(true); openLesson(null); }} />
      <ContextualPulseCard pulse={pulse} /><Heading>{readerLesson.title}</Heading><Body muted>{readerLesson.description}</Body>
      {placeNotice}
      {place.available ? null : <Body muted>{t("Save my place works once a campaign is selected for this account.")}</Body>}
      <RightsReadingSections lesson={readerLesson} scrollRef={scrollRef} scrollAnchor={scrollAnchor} savedAnchor={place.bookmark?.lessonID === readerLesson.id ? place.bookmark.anchor : null} failedAnchor={failedAnchor} saving={placeBusy || !place.available} onSave={(anchor) => { void savePlace(readerLesson, anchor); }} />
    </Screen>;
  }
  if (selectedArticle) {
    return <Screen onScrollProgress={pulse.onScrollProgress}><Button label={t("All rights sources")} variant="secondary" onPress={() => setSourceDismissed(true)} /><ContextualPulseCard pulse={pulse} /><Heading>{selectedArticle.title}</Heading><Body muted>{selectedArticle.ref}</Body><Card><Body>{selectedArticle.body}</Body><Body muted>{evidenceUpdatedMeta(selectedArticle.updatedAt)}</Body></Card></Screen>;
  }
  if (missingSource) {
    return <Screen><StateMessage title={t("That approved source is unavailable")} body={t("It is no longer available.")} /><Button label={t("All rights sources")} variant="secondary" onPress={() => setSourceDismissed(true)} /></Screen>;
  }

  return <Screen scrollRef={scrollRef} onScrollProgress={pulse.onScrollProgress}><NativeFeatureGuide feature="rights" /><Heading>{t("Organizing rights")}</Heading><AskCompassButton /><Body muted>{t("Approved rights lessons, scripts, progress, committee worker support, and published campaign articles.")}</Body><ContextualPulseCard pulse={pulse} />
    <Body muted>{t('Campaign content is shown in its published language. Spanish learning guides are available below.')}</Body>
    <LearningLibrarySection onManage={() => setManagingLearning(true)} />
    {error ? <Card><Body style={{ color: theme.destructive }}>{t("Rights history or the requested change could not be confirmed.")}</Body><Button label={t("Try again")} onPress={() => setRightsReload((value) => value + 1)} /></Card> : null}
    {placeNotice}
    {place.readFailed ? <Notice>{t("Your saved place could not be read on this device.")}</Notice> : null}
    {place.bookmark ? <ContinueReadingCard title={data?.lessons.find((lesson) => lesson.id === place.bookmark?.lessonID)?.title ?? null} busy={placeBusy} onContinue={() => { void continueReading(); }} onClear={() => { void clearPlace(); }} /> : null}
    {data === null ? <Loading title={t("Loading rights")} /> : <>
      {data.lessons.map((lesson) => { const requestOpen = stewardRequestOpen(lesson.requestStatus); return <Card key={lesson.id}><MetaRow label={lesson.label.toLocaleUpperCase()} status={t(lesson.steps.length === 1 ? '{done}/{total} step' : '{done}/{total} steps', { done: lesson.completedSteps.length, total: lesson.steps.length })} /><Heading level={3}>{lesson.title}</Heading><Body muted>{lesson.description}</Body>{lesson.steps.map((step, index) => <Body key={step}>{lesson.completedSteps.includes(index) ? '✓' : '○'} {step}</Body>)}<Body>{lesson.script}</Body><View style={styles.actions}><Button label={t("Read lesson")} variant="secondary" onPress={() => openLesson(lesson.id)} /><Button label={busy === lesson.id ? t("Saving…") : t("Mark complete")} disabled={busy !== null || lesson.completedSteps.length === lesson.steps.length} onPress={() => { void complete(lesson); }} /><Button label={requestOpen ? stewardRequestLabel(lesson.requestStatus, catalogLabel) : t("Request a committee member")} variant="secondary" disabled={busy !== null || requestOpen} onPress={() => { void request(lesson.id); }} /></View></Card>; })}
      <Heading level={2}>{t("Verified articles")}</Heading>{data.articles.map((article) => <Card key={article.id}><MetaRow label={article.ref} status={chapterDate(article.updatedAt, locale, t)} preserveStatusCase /><Heading level={3}>{article.title}</Heading><Body>{article.body}</Body></Card>)}
    </>}
  </Screen>;
}

function LiveChapterScreen({ sourceID }: { sourceID?: string }) {
  const { catalogLabel, locale, t } = useNativeUi();
  const theme = useTheme();
  const { dashboard, captureAuthenticatedSessionGuard } = useApp();
  const writer = useBusinessWriter();
  const [data, setData] = useBusinessDraftState<LivedInChapter | null>(null);
  const [error, setError] = useBusinessDraftState(false);
  const [busy, setBusy] = useBusinessState<string | null>(null);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, null);
  const [sourceDismissed, setSourceDismissed] = useState(false);
  const [sourceDocument, setSourceDocument] = useState<LivedInChapterDocument | null>(null);
  const [sourceDocumentError, setSourceDocumentError] = useState(false);
  const [chapterReload, setChapterReload] = useState(0);
  // A document opened from the list (not a linked source); its reader returns
  // to the same list (BUG-UG-NATIVE-CHAPTER-DOCUMENTS-HAVE-NO-OPEN-ACTION-20261111).
  const [openedDocumentID, setOpenedDocumentID] = useState<string | null>(null);
  const [documentReload, setDocumentReload] = useState(0);
  useEffect(() => { let current = true; setData(null); setError(false); void loadMobileChapterHistory().then((value) => { if (current) setData(value); }).catch(() => { if (current) setError(true); }); return () => { current = false; }; }, [chapterReload, setData, setError]);
  async function markRead(broadcastID: string) {
    await operate(broadcastID, async () => {
    const scopeCurrent = captureAuthenticatedSessionGuard();
     setError(false);
    try {
      await markMobileBroadcastRead(writer, broadcastID);
      if (!scopeCurrent()) return;
      setData((current) => current ? { ...current, broadcasts: current.broadcasts.map((item) => item.id === broadcastID ? { ...item, readAt: new Date().toISOString() } : item) } : current);
      if (!(await writer.isCurrent()) || !scopeCurrent()) return;
      const next = await loadMobileChapterHistory();
      if (!(await writer.isCurrent()) || !scopeCurrent()) return;
      setData(next);
      void haptics.success();
    }
    catch { setError(true); }

    });
  }
  const linkedDocument = !sourceDismissed && sourceID && data
    ? data.documents.find((document) => compassSourceMatchesReaderRecord(sourceID, 'doc', document.id)) ?? null
    : null;
  const openedDocument = openedDocumentID && data ? data.documents.find((document) => document.id === openedDocumentID) ?? null : null;
  const selectedDocument = linkedDocument ?? openedDocument;
  useEffect(() => {
    let current = true;
    setSourceDocument(null);
    setSourceDocumentError(false);
    if (selectedDocument) {
      void loadMobileChapterDocument(selectedDocument.id)
        .then((document) => { if (current) setSourceDocument(document); })
        .catch(() => { if (current) setSourceDocumentError(true); });
    }
    return () => { current = false; };
  }, [selectedDocument?.id, documentReload]);
  const missingSource = Boolean(sourceID && !sourceDismissed && data && !linkedDocument);
  // While a document opened from the list is showing, header Back and the
  // Android back button close it and return to the list instead of leaving
  // My chapter. Focus-gated: the interceptor slot is global (FeatureScreen).
  const isFocused = useIsFocused();
  const readerOwnsBack = openedDocumentID !== null && !linkedDocument;
  const closeOpenedDocument = useMemo(() => () => { setOpenedDocumentID(null); return true; }, []);
  useScreenBackInterceptor(isFocused && readerOwnsBack ? closeOpenedDocument : null);
  // The interceptor does not see iOS's left-edge swipe, a gesture on the stack
  // that would pop My chapter past the reader (RightsFeature, FeatureScreen).
  // It stands down only while a list-opened document is showing; the list and
  // a linked source keep the ordinary swipe off the feature.
  const navigation = useNavigation<{ setOptions: (options: { gestureEnabled: boolean }) => void }>();
  useEffect(() => {
    if (!readerOwnsBack) return undefined;
    navigation.setOptions({ gestureEnabled: false });
    return () => navigation.setOptions({ gestureEnabled: true });
  }, [navigation, readerOwnsBack]);
  const backToList = linkedDocument
    ? <Button label="All campaign sources" variant="secondary" onPress={() => setSourceDismissed(true)} />
    : <Button label="All campaign documents" variant="secondary" onPress={() => setOpenedDocumentID(null)} />;
  if (selectedDocument) {
    return <Screen>{backToList}<Heading>{selectedDocument.title}</Heading><Body muted>{selectedDocument.kind.toLocaleUpperCase()} · v{selectedDocument.version}</Body>{selectedDocument.summary ? <Body muted>{selectedDocument.summary}</Body> : null}{sourceDocumentError ? <><StateMessage title="That approved source is unavailable" body="It didn’t load. Try again." /><Button label="Try again" onPress={() => setDocumentReload((value) => value + 1)} /></> : sourceDocument === null ? <Loading title="Loading approved source" /> : <Card><Body>{sourceDocument.body}</Body><Body muted>{evidenceUpdatedMeta(sourceDocument.updatedAt)}</Body></Card>}</Screen>;
  }
  if (openedDocumentID && data && !openedDocument) {
    return <Screen><StateMessage title="That document is no longer available" body="It was removed or you can no longer read it." /><Button label="All campaign documents" variant="secondary" onPress={() => setOpenedDocumentID(null)} /></Screen>;
  }
  if (missingSource) {
    return <Screen><StateMessage title="That approved source is unavailable" body="It is no longer available." /><Button label="All campaign sources" variant="secondary" onPress={() => setSourceDismissed(true)} /></Screen>;
  }
  return <Screen><Heading>{catalogLabel('My campaign')}</Heading><Body muted>Published campaign documents and the complete worker briefing archive.</Body>
    <NativeUnitSettingsEditor />
    <ChapterCaseRowTopicCard chapterID={dashboard?.member.chapterID} />
    {error ? <Card><Body style={{ color: theme.destructive }}>Campaign history or the read receipt could not be confirmed.</Body><Button label="Try again" onPress={() => setChapterReload((value) => value + 1)} /></Card> : null}
    {data === null ? <Loading title="Loading campaign history" /> : <><Heading level={2}>Documents · {data.documents.length}</Heading>{data.documents.map((document) => <Card key={document.id}><MetaRow label={document.kind.toLocaleUpperCase()} status={`v${document.version}`} /><Heading level={3}>{document.title}</Heading><Body>{document.summary}</Body><Body muted>{evidenceUpdatedMeta(document.updatedAt)}</Body><Button label="Read" accessibilityLabel={`Read ${document.title}`} variant="secondary" onPress={() => setOpenedDocumentID(document.id)} /></Card>)}<Heading level={2}>Records · {data.records.length}</Heading>{data.records.map((item) => <Card key={item.id}><MetaRow label={item.kind.replaceAll('_', ' ').toLocaleUpperCase()} status={chapterDate(item.occurredAt, locale, t)} preserveStatusCase /><Heading level={3}>{item.title}</Heading><Body>{item.body}</Body></Card>)}<Heading level={2}>Briefings · {data.broadcasts.length}</Heading>{data.broadcasts.map((broadcast) => <Card key={broadcast.id}><MetaRow label={broadcast.sender} status={broadcast.readAt ? 'Read' : 'Unread'} /><Heading level={3}>{broadcast.title}</Heading><Body>{broadcast.body}</Body><Body muted>{chapterDate(broadcast.publishedAt, locale, t)}</Body>{!broadcast.readAt ? <Button label={busy === broadcast.id ? 'Marking read…' : 'Mark read'} disabled={busy !== null} variant="secondary" onPress={() => { void markRead(broadcast.id); }} /> : null}</Card>)}</>}
  </Screen>;
}

function LiveTasksScreen({ sourceID, onOpenTask }: { sourceID?: string; onOpenTask?: (taskID: string) => void }) {
  const { catalogLabel } = useNativeUi();
  // Like the optional native pickers, defer Expo configuration until this
  // screen is opened; event-only consumers need no native module initialization.
  const { mobileConfig } = require('../lib/config') as typeof import('../lib/config');
  const { session, mode, organizationID, chapterMemberships, sessionRestricted } = useApp();
  const membership = chapterMemberships.find((entry) => entry.selected);
  const presetScope = mode === 'authenticated' && !sessionRestricted && session?.user.id && organizationID
    && membership?.organizationID === organizationID && membership.chapterID && mobileConfig.supabaseUrl
    ? workFilterScopeKey({ backend: mobileConfig.supabaseUrl, account: session.user.id, organization: organizationID, chapter: membership.chapterID }) : null;
  const [tasks, setTasks] = useState<LivedInTask[] | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const retry = () => setRevision((value) => value + 1);
  useEffect(() => {
    let current = true; setTasks(null); setError(false);
    void (async () => {
      if (sourceID && !(await connectedWorkflowApi()?.context({ kind: 'task', id: sourceID }))?.available) throw new Error('Source unavailable');
      const rows = await loadMobileTasksHistory();
      if (sourceID && !rows.some((task) => task.id === sourceID)) throw new Error('Source unavailable');
      if (current) setTasks(sourceID ? rows.filter((task) => task.id === sourceID) : rows);
    })().catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [sourceID, revision]);
  const [localQuery, setLocalQuery] = useState('');
  const handoff = useTaskDocumentHandoff();
  const query = handoff.active ? handoff.query : localQuery;
  const setQuery = (value: string) => handoff.active ? handoff.store.setQuery(value) : setLocalQuery(value);
  useEffect(() => {
    if (handoff.active && (tasks !== null || error)) handoff.store.authorizeTasks((tasks ?? []).map((task) => task.id));
  }, [handoff.active, handoff.store, tasks, error]);
  const theme = useTheme();
  const visible = filterCurrentWorkTasks(tasks ?? [], query, sourceID);
  return <Screen><Heading>{catalogLabel('Campaign work')}</Heading><Body muted>Full task context across the selected campaign: ownership, dates, progress, status, and blockers.</Body>
    {handoff.discardedKind ? <Body>Your {handoff.discardedKind === 'scan' ? 'scan' : 'document'} was removed because access could not be confirmed. Choose it again after access is restored.</Body> : null}
    {error ? <LoadError message="Campaign work could not be refreshed." onRetry={retry} /> : tasks === null ? <Loading title="Loading campaign work" /> : <>
      {sourceID ? <Body muted>Showing the linked task. Saved filters do not hide this target.</Body> : <>
        <TextInput accessibilityLabel="Filter campaign work" value={query} onChangeText={setQuery} placeholder="Filter tasks" placeholderTextColor={theme.quietForeground} style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} />
        <WorkFilterButton label="Reset filter" onPress={() => setQuery('')} />
        {presetScope ? <WorkFilterPresetsCard key={presetScope} scope={presetScope} query={query} onQuery={setQuery} /> : null}
      </>}
      {visible.map((task) => <TaskCard key={task.id} task={task} onOpen={sourceID || !onOpenTask ? undefined : () => onOpenTask(task.id)} />)}{visible.length === 0 ? <StateMessage title="No matching tasks" body="Clear the filter to see every task." /> : null}
    </>}
  </Screen>;
}

// A task title opens that task on its own (the focused /feature/tasks?source=
// view); on that view the title is plain text
// (BUG-UG-NATIVE-CASE-ROWS-AND-TASK-TITLES-DO-NOT-OPEN-20261111).
export function TaskCard({ task, onOpen }: { task: LivedInTask; onOpen?: () => void }) {
  const [localOpen, setLocalOpen] = useState(false);
  const handoff = useTaskDocumentHandoff();
  const attachmentsOpen = handoff.active ? handoff.openTaskIDs.includes(task.id) : localOpen;
  const setAttachmentsOpen = (open: boolean) => handoff.active ? handoff.store.setOpen(task.id, open) : setLocalOpen(open);
  const pending = handoff.pending?.taskID === task.id ? handoff.pending : null;
  const { locale, t } = useNativeUi();
  const start = deviceCalendarDay(task.startDate, locale);
  const end = deviceCalendarDay(task.dueDate, locale);
  const schedule = task.startDate || task.dueDate
    ? `${start ?? t('No start date')} → ${end ?? t('No due date')}`
    : t('Dates not set');
  return (
    <View style={styles.taskGroup}>
      <Card>
        <MetaRow label={task.identifier} status={task.blocked ? 'Blocked' : task.status.replaceAll('_', ' ')} />
        {onOpen ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${task.title}, ${task.identifier}`}
            accessibilityHint="Opens this task."
            onPress={onOpen}
            style={({ pressed }) => [styles.taskTitle, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Heading level={3}>{task.title}</Heading>
          </Pressable>
        ) : <Heading level={3}>{task.title}</Heading>}
        {'unitName' in task && task.unitName ? <Body>{task.unitName}</Body> : null}
        <WorkflowActions kind="task" id={task.id} recordTitle={task.title} />
        {task.description ? <Body>{task.description}</Body> : null}
        <Body muted>{task.workstream} · {task.priority.charAt(0).toLocaleUpperCase()}{task.priority.slice(1)} · {task.assignee}</Body>
        <Body muted>{schedule} · {task.progress}%{task.milestone ? ' · milestone' : ''}</Body>
        <Button
          label={attachmentsOpen ? 'Hide attachments' : 'Open attachments'}
          variant="secondary"
          onPress={() => setAttachmentsOpen(!attachmentsOpen)}
        />
      </Card>
      {attachmentsOpen ? <AttachmentPanel target={{ kind: 'task', id: task.id }} canWrite
        documentHandoff={handoff.active ? {
          picking: pending !== null,
          kind: pending?.kind ?? 'document',
          producerPhase: pending?.producerPhase ?? null,
          failure: handoff.failure?.taskID === task.id ? handoff.failure : null,
          scan: () => handoff.scan(task.id),
          candidate: pending?.candidate ?? null,
          converted: pending?.converted ?? false,
          choose: () => handoff.choose(task.id),
          take: (candidate) => handoff.store.take(task.id, candidate),
          discard: () => handoff.store.discard(task.id),
        } : undefined}
      /> : null}
    </View>
  );
}

function LiveReportsScreen() {
  const { catalogLabel, locale, t } = useNativeUi();
  const [rewards, rewardsError, retryRewards] = useLoader(loadDeviceContributions);
  const [workload, workloadError, retryWorkload] = useLoader(loadMobileWorkloadHistory);
  const [rawReportCard, reportError, retryReport] = useLoader(loadMobileMemberReportCard);
  const language = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('es') ? 'es' : 'en';
  const copy = REPORT_CARD_COPY[language];
  const report = normalizeMemberReportCard(reportError ? null : rawReportCard);
  const reportLoading = rawReportCard === null && !reportError;
  return (
    <Screen>
      <Heading>{catalogLabel('My reports')}</Heading>
      <Body muted>{MY_REPORTS_SUMMARY}</Body>
      <QuarterlySurveyGate>
      {rewardsError || workloadError ? (
        <LoadError message="Reports could not be refreshed." onRetry={() => { retryRewards(); retryWorkload(); }} />
      ) : rewards === null || workload === null || reportLoading ? (
        <Loading title="Loading reports" />
      ) : <>
        <Card>
          <MetaRow label={copy.eyebrow} status={reportError ? copy.unavailable : report.state === 'ready' ? `${report.overall}/100` : copy.notReady} />
          <Heading level={3}>{reportError ? copy.unavailableTitle : report.state === 'ready' ? copy.title : copy.emptyTitle}</Heading>
          <Body muted>{copy.boundary}</Body>
          {reportError ? <Button label={copy.retry} variant="secondary" onPress={retryReport} /> : report.components.map((component: { id: string; score: number | null }) => (
            <Body key={component.id}>{copy.componentLabels[component.id as keyof typeof copy.componentLabels]}: {component.score ?? '—'}</Body>
          ))}
        </Card>
        <Card><MetaRow label="CONTRIBUTIONS" status={`${rewards.recentVerified} in 90 days`} /><Heading level={3}>{rewards.totalVerified} verified contributions</Heading><Body muted>{OWN_RETAINED_HISTORY}</Body><Body muted>{deviceDayRange(rewards.events.map((item) => item.occurredAt), locale)}</Body></Card>
        <Card><MetaRow label="WORKPLACE LOG" status={`${workload.logs.length} logs`} /><Heading level={3}>{workload.logs.reduce((sum, log) => sum + log.pending + log.todos, 0)} tracked pending + to-do items</Heading><Body muted>{OWN_RETAINED_HISTORY}</Body><Body muted>{deviceDayRange(workload.logs.map((item) => item.loggedOn), locale)}</Body></Card>
      </>}
      </QuarterlySurveyGate>
    </Screen>
  );
}

const REPORT_CARD_COPY = {
  en: {
    eyebrow: 'REPORT CARD', notReady: 'Not ready', unavailable: 'Unavailable',
    title: 'Participation report card', emptyTitle: 'Your report card is warming up',
    unavailableTitle: 'Participation report card could not be refreshed',
    boundary: 'Your own activity only. Issue volume never lowers this score.', retry: 'Try again',
    componentLabels: { participation: 'Participation', profileReadiness: 'Profile readiness', followThrough: 'Follow-through' },
  },
  es: {
    eyebrow: 'REPORTE', notReady: 'No listo', unavailable: 'No disponible',
    title: 'Reporte de participación', emptyTitle: 'Su reporte se está preparando',
    unavailableTitle: 'No se pudo actualizar el reporte de participación',
    boundary: 'Solo su propia actividad. La cantidad de asuntos nunca reduce esta puntuación.', retry: 'Intentar de nuevo',
    componentLabels: { participation: 'Participación', profileReadiness: 'Preparación del perfil', followThrough: 'Seguimiento' },
  },
} as const;

function LiveStewardAppointmentsScreen() {
  const { catalogLabel } = useNativeUi();
  const theme = useTheme();
  const { t } = useNativeUi();
  const { chapterRoles, organizationRoles } = useApp();
  // The desk loads the committee member's own one-on-ones, outcomes, availability and
  // calendar connections. An unauthorized session gets the standard refusal
  // and never reaches the RPCs — the same gate FeatureScreen applies before
  // this screen can mount.
  const stewardAppointmentsAuthorized = canOpenFeature('authenticated', 'steward-appointments', null, chapterRoles, organizationRoles);
  const [desk, setDesk] = useState<LivedInStewardAppointmentsDesk | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!stewardAppointmentsAuthorized) return;
    let current = true; setDesk(null); setError(false);
    void loadMobileStewardAppointmentsDesk().then((value) => { if (current) setDesk(value); }).catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [stewardAppointmentsAuthorized, reload]);
  if (!stewardAppointmentsAuthorized) {
    return <Screen><StateMessage title="One-on-one desk is not open to your role" body="Your current campaign role does not grant the committee one-on-one desk. Ask a campaign administrator if your assignment changed." /></Screen>;
  }
  return <Screen>
    <Heading>{catalogLabel('One-on-one desk')}</Heading>
    <Body muted>Upcoming and recent worker one-on-ones, their outcomes, your availability, and connected calendars.</Body>
    {error ? <Card><Body style={{ color: theme.destructive }}>The committee member one-on-one desk could not be refreshed through your current campaign authorization.</Body><Button label="Try again" onPress={() => setReload((value) => value + 1)} /></Card> : desk === null ? <Loading title="Loading committee member one-on-ones" /> : <>
      <Heading level={2}>Upcoming · {desk.upcoming.length}</Heading>
      {desk.upcoming.length === 0 ? <StateMessage title="No upcoming one-on-ones" body="Booked worker one-on-ones will appear here." /> : desk.upcoming.map((appointment) => <StewardAppointmentCard key={appointment.id} appointment={appointment} />)}
      <Heading level={2}>Recent · {desk.recent.length}</Heading>
      {desk.recent.length === 0 ? <StateMessage title="No recent one-on-ones" body="Completed and missed one-on-ones will appear here." /> : desk.recent.map((appointment) => <StewardAppointmentCard key={appointment.id} appointment={appointment} />)}
      <Heading level={2}>Outcomes</Heading>
      <Card>
        <MetaRow label="OUTCOMES · 30 DAYS" status={desk.outcomes.completed30d != null ? `${desk.outcomes.completed30d} completed` : 'Not available'} />
        <Body>No-shows (30 days): {desk.outcomes.noShows30d ?? '—'}</Body>
      </Card>
      <Heading level={2}>Availability</Heading>
      {/*: the same booking-hours editor as Appointments, so a
          steward on this desk can add, change and remove weekly windows and
          turn bookings on; both screens save and read the same windows. */}
      <AppointmentHoursCard t={t} initial={desk.availability} />
      {desk.availability.minNoticeMinutes != null || desk.availability.blackouts.length > 0 ? <Card>
        {desk.availability.minNoticeMinutes != null ? <Body muted>{desk.availability.minNoticeMinutes} min notice</Body> : null}
        {desk.availability.blackouts.map((blackout) => <Body key={blackout.id} muted>Blackout · {blackout.startDate} → {blackout.endDate}</Body>)}
      </Card> : null}
      <Heading level={2}>Calendar connections</Heading>
      {desk.connections.length === 0 ? <StateMessage title="No calendar connections" body="The campaign connects its own Google or Microsoft calendar before free/busy sync activates." /> : desk.connections.map((connection) => <Card key={connection.id}>
        <MetaRow label={connection.provider.toLocaleUpperCase()} status={connection.status} />
        <Body muted>{connection.accountLabel ?? 'Campaign-owned provider account'}</Body>
      </Card>)}
    </>}
  </Screen>;
}

function StewardAppointmentCard({ appointment }: { appointment: LivedInStewardAppointment }) {
  const { locale, t } = useNativeUi();
  const scheduleLabel = appointmentRangeLabel(appointment.startsAt, appointment.endsAt, locale) ?? t('Time unavailable');
  return <Card>
    <MetaRow label={appointment.type.replaceAll('_', ' ').toLocaleUpperCase() || 'ONE-ON-ONE'} status={appointment.status.replaceAll('_', ' ')} />
    <Heading level={3}>{appointment.memberName}</Heading>
    <Body muted>{scheduleLabel}{appointment.place ? ` · ${appointment.place}` : ''}</Body>
    {appointment.reasonCategory ? <Body muted>Reason: {appointment.reasonCategory.replaceAll('_', ' ')}</Body> : null}
  </Card>;
}

function MetaRow({ label, status, preserveStatusCase = false }: { label: string; status: string; preserveStatusCase?: boolean }) {
  const theme = useTheme();
  const { t } = useNativeUi();
  const displayStatus = status === 'No RSVP' ? t('No RSVP') : status;
  const keepCase = preserveStatusCase || status === 'No RSVP';
  return <View style={styles.meta}><Text style={[styles.eyebrow, { color: theme.primary }]}>{label}</Text><View style={[styles.pill, { backgroundColor: theme.secondary }]}><Text style={[styles.pillText, keepCase && styles.pillSuppliedCase, { color: theme.secondaryForeground }]}>{displayStatus}</Text></View></View>;
}

function Loading({ title }: { title: string }) { return <StateMessage title={title} body="Getting your latest history." />; }
function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) { const theme = useTheme(); return <Card><Body style={{ color: theme.destructive }}>{message}</Body><Button label="Try again" onPress={onRetry} /></Card>; }

function useLoader<T>(loader: () => Promise<T>): [T | null, boolean, () => void] {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => { let current = true; setData(null); setError(false); void withReadDeadline(loader()).then((value) => { if (current) setData(value); }).catch(() => { if (current) setError(true); }); return () => { current = false; }; }, [loader, reload]);
  return [data, error, () => setReload((value) => value + 1)];
}

function chapterDate(value: string, locale: 'en-US' | 'es-US', t: NativeUiText) {
  return easternDateTime(value, locale) ?? t('Time unavailable');
}

function workloadLogCount(count: number, t: NativeUiText) {
  return t(count === 1 ? '{count} log' : '{count} logs', { count });
}

function formatDay(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(); }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); }
function stewardRequestOpen(status: string | null) { return status === 'requested' || status === 'acknowledged'; }
// The open request's state in the saved language ("Steward requested" and
// "Steward acknowledged" are catalogue keys); an unknown state keeps its words.
function stewardRequestLabel(status: string | null, catalogLabel: (label: string) => string) { return catalogLabel(`Committee ${status}`); }
function scanResultCopy(result: MobileEventScanResult): string {
  const name = result.memberName.trim() || 'That worker';
  return result.alreadyCheckedIn
    ? `${name} already has a check-in on file for this meeting.`
    : `${name} is checked in.`;
}

const styles = StyleSheet.create({
  meta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  eyebrow: { flexShrink: 1, fontSize: 12, lineHeight: 17, ...typeface.controlStrong, letterSpacing: 0.5 },
  pill: { borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  pillText: { fontSize: 12, lineHeight: 17, ...typeface.controlStrong, textTransform: 'capitalize' },
  pillSuppliedCase: { textTransform: 'none' },
  option: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, justifyContent: 'center', paddingHorizontal: spacing.md, marginTop: spacing.sm },
  optionText: { fontSize: 15, lineHeight: 21, ...typeface.control },
  surveyQuestion: { marginTop: spacing.md, gap: spacing.xs },
  surveyParagraph: { minHeight: minimumTouchTarget * 2, paddingTop: spacing.sm, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  inline: { gap: spacing.sm },
  taskGroup: { gap: spacing.sm },
  taskTitle: { minHeight: 48, justifyContent: 'center' },
  input: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, fontSize: 16, lineHeight: 22 },
});
