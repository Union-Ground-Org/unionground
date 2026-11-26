import { useBusinessRequests, useBusinessOperationCache, useBusinessRequestOwner } from '../lib/useBusinessWriter';
import { BUSINESS_SAVED_STALE, checkBusinessContinuation, settleBusinessWrite } from '../lib/businessWriteContinuation';
import { useBusinessDraftState } from '../lib/useBusinessDraftState';
import { useBusinessOperation, useBusinessWriter, useBusinessState, useBusinessSubjectState } from '../lib/useBusinessWriter';
import { useNativeUi } from '../lib/useNativeUi';
import { usePendingNoticeSend } from './noticePendingSend';
import { ReadDeadlineError, withReadDeadline } from '../lib/readDeadline';
import { defineRetainedSurface, useRetainedDraft, type Held } from '../lib/retainedDraft';
import { AskCompassButton } from '../components/AskCompassButton';
import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import { useIsFocused, useNavigation, useRouter } from 'expo-router';
import { nativeTaskRoute } from '../lib/connectedWorkflowRoutes';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Alert, Platform, Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../components/Text';

import {
  TransactionalButton,
  TransactionalConfirmation,
  TransactionalReveal,
  useTransactionalAction,
  type TransactionalAction,
} from '../components/TransactionalAction';
import { CaseRowPressable } from '../components/CaseRowPressable';
import { PressableScale } from '../components/PressableScale';
import { ChapterConnectionVerification } from '../components/ChapterVerificationControls';
import {
  chapterConnectionIsVerifiable,
  chapterConnectionProviderLine,
  enterpriseControlsCopy,
  isPlannedChapterCapability,
  verifiableConnectionChapter,
} from '../lib/chapterAdministration';
import { NumberFlow } from '../components/NumberFlow';
import { Body, Button, Card, Heading, Notice, Screen, StatValue, StateMessage, StatusPill } from '../components/ui';
import { LiveAppointmentsFeature } from './LiveAppointmentsFeature';
import { ContributionsSections, LiveLivedInScreen, LiveSurveyHistory } from './LiveLivedInScreens';
import { MemberSupportScreen } from './MemberSupportScreen';
import { ChapterMembershipsScreen } from './ChapterMembershipsScreen';
import { OrgStructureScreen } from './OrgStructureScreen';
import { PayToolsRoute } from './mi1/PayToolsScreen';
import { Mi1FeatureScreen } from './mi1/Mi1FeatureScreen';
import { Mi1AnalyticsScreen } from './mi1/Mi1AnalyticsScreen';
import { ConnectionSuggestionsPanel } from './mi1/ConnectionSuggestionsPanel';
import type { ConnectionHandshakeSubmission } from './mi1/ConnectionHandshakeRequest';
import { nativeConnectionCopy } from '../lib/connectionSuggestionsShared';
import { unionOrganizationSearchable } from '../lib/chapterLifecycle';
import { CollectiveActionsScreen, OrganizationIntelligenceScreen } from './mi1/OrganizationIntelligenceScreens';
import { Mi1QaFeatureScreen } from './mi1/Mi1QaFeatureScreen';
import { LearningContentManager } from './learning/LearningContentManager';
import { LearningLibrarySection } from './learning/LearningLibrarySection';
import { PREVIEW_CHAPTERS, PREVIEW_HATS, PREVIEW_HEALTH_PORTFOLIO, PREVIEW_KNOWLEDGE, appendPreviewEventDraft, isPreviewHatKey, previewBallotCardState, previewEventCheckInPresentation, previewWorkDayDiff, previewWorkIsOverdue, togglePreviewEventCheckIn, type PreviewBallot, type PreviewDesk, type PreviewEvent, type PreviewFieldNote, type PreviewHandshake, type PreviewHatKey, type PreviewTask, type PreviewTaskStatus } from '../data/preview';
import { CAMPAIGNS, CONTRIBUTIONS_COPY, FEATURE_TITLES, FORM_TEMPLATES, PREVIEW_RECOGNITION_RULES, canOpenFeature, formTemplateBlurb, isStaffDeskFeatureKey, isStewardDeskSectionKey, type FeatureKey } from '../lib/featureCatalog';
import { healthNoticeFor } from '../lib/formHealthNotice';
import { HEALTH_DRIVER_FIELDS, healthDriverRows, healthSnapshotOverwrite, healthSnapshotOverwriteMessage, mergePreviewHealthSnapshot, utcHealthDate, validHealthDate } from '../lib/chapterHealth';
import { chapterLifecycleCopy } from '../lib/chapterLifecycleCopy';
import { chapterMembershipRoleLabels } from '../lib/chapterAdministrationCopy';
import { LIVE_STAFF_ROLE_LABELS, STAFF_HAT_FUNCTIONS, explicitLiveStaffHat } from '../lib/hatFunctions';
import { StaffRolePicker } from '../components/StaffRolePicker';
import { SavedWorkCheckFailed } from '../components/SavedWorkCheckFailed';
import { isMi1FeatureKey } from '../lib/mi1Shared';
import { requestHatSwitcher } from '../lib/hatSwitcher';
import { memberCaseStep } from '../lib/caseStepLabels';
import { useAccessibilityAnnouncementQueue } from '../lib/announce';
import { compassSourceMatchesReaderRecord } from '../lib/compassSourceNavigation';
import { useScreenBackInterceptor } from '../lib/screenBack';
import { useFeaturePageView } from '../lib/useFeaturePageView';
import { removalOutcomeLabel, removalRoleLabel, type OfficerRemovalDetail } from '../lib/governanceShared';
import { loadMobileOfficerRemovalDetails } from '../services/governance';
import { useChannelStore } from '../data/useChannels';
import { caseDueLine, casesByDeadline, dashboardMetrics, reportsUnreadMessagesCard } from '../models/member';
import { haptics } from '../services/haptics';
import {
  addMobileHealthCoaching,
  closeMobileHandshake,
  countersignMobileHandshake,
  loadMobileBallots,
  loadMobileConnectionReadiness,
  loadMobileHandshakeTargets,
  loadMobileHandshakes,
  loadMobileChapterBinding,
  loadMobileHandshakeDocuments,
  loadMobileHealthPortfolio,
  recordMobileFeaturePageView,
  recordMobileHealthSnapshot,
  requestMobileConnectionSetup,
  requestMobileChapterBinding,
  requestMobileHandshake,
  respondMobileHandshake,
  searchMobileUnionOrganizations,
  shareMobileHandshakeDocument,
  submitMobileBallotVote,
  type MobileBallot,
  type MobileConnectionReadiness,
  type MobileHandshake,
  type MobileChapterBinding,
  type MobileHandshakeDocument,
  type MobileHandshakeTarget,
  type MobileUnionOrganization,
  type MobileHealthChapter,
  type MobileHealthDrivers,
} from '../services/supabase';
import { useApp } from '../state/AppProvider';
import { elevation } from '../theme/elevation';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { isSameDeskSection } from './deskJump';
import { presentSearchRow, pressSearchRow } from './searchRowPresentation';
import { gatePageViewRecorder, useProductAnalyticsEnabled } from '../services/analyticsPreference';
import { captureNativeScreen } from '../services/observability';
import { useScimReleased } from '../services/scimRelease';
import { useSsoReleased } from '../services/ssoRelease';
import { deviceCalendarDay, deviceDateTime, deviceDay, formatBallotClosingTime } from '../lib/evidenceTimestamp';
import { MY_REPORTS_SUMMARY, reportMetricScopeLabel } from '../lib/scopedMetrics';
import { BALLOT_FINAL_HINT, BALLOT_RECEIPT_SENTENCE, BALLOT_STORAGE_SENTENCE, ballotCastConfirmation } from '../lib/ballotDisclosure';
import { NativeFeatureGuide } from './guideLayers/GuideLayers';
import { StewardDeskSectionsScreen } from './StewardDeskSectionsScreen';
import { ChapterNoticesScreen } from './ChapterNoticesScreen';
import { ChapterInvitationsScreen } from './ChapterInvitationsScreen';
import { createHandshakeOperations } from './handshakeOperations';
import { LiveBeHeardScreen, LiveCampaignsScreen, LiveCaseQueueScreen, LiveCaseworkDeskScreen, LiveFormsScreen, LiveSearchScreen, type FormEdit, type FormOutcome } from './LiveFeatureScreens';
import { useKeptFormEditor } from './forms/keptFormEditor';
import { WriterSessionChanged } from '../../../../src/lib/sessionBoundWriter.js';
import { businessRpcProvenance } from '../services/businessWriters';

import { typeface } from '../theme/typeface';
// The member's Product analytics switch gates the request itself
// (REQ-UG-VISIBLE-ANALYTICS-OPT-OUT-20261016).
// The same gate covers the pseudonymous PostHog screen view .


export function FeatureScreen({ featureKey, sourceID }: { featureKey: FeatureKey; sourceID?: string }) {
  const { catalogLabel, t } = useNativeUi();
  const { dashboard, error, refreshing, refresh, mode, session, previewDesk, previewHat, authorizedRoles, staffRoleChoices, chosenStaffRole, chapterRoles, organizationRoles, organizationID, chapterMemberships, locked, assuranceUnavailable } = useApp();
  const writer = useBusinessWriter();
  const recordFeaturePageView = useMemo(() => gatePageViewRecorder((page, hat, signal) => {
    captureNativeScreen(page);
    return recordMobileFeaturePageView(writer, page, hat, signal);
  }), [writer]);
  const router = useRouter();
  // A task title in the task list opens that task on its own
  // (BUG-UG-NATIVE-CASE-ROWS-AND-TASK-TITLES-DO-NOT-OPEN-20261111).
  const openTask = (taskID: string) => { const href = nativeTaskRoute(taskID); if (href) router.push(href as never); };
  const partnerScope = JSON.stringify([mode, dashboard?.member.id, organizationID,
    chapterMemberships.find((entry) => entry.selected)?.chapterID ?? dashboard?.member.chapterID,
    previewHat, authorizedRoles, locked, assuranceUnavailable]);
  // The open Forms editor survives the gates below while a return to the
  // foreground re-checks the session: kept for
  // the signed-in member in the scope the app settles on, and dropped on
  // sign-out, a refused resume, another member or a real scope change.
  const formsEditor = useKeptFormEditor<FormEdit, FormOutcome>(session?.user.id ?? null, mode, mode === 'authenticated' && dashboard
    ? JSON.stringify([dashboard.member.id, organizationID,
      chapterMemberships.find((entry) => entry.selected)?.chapterID ?? dashboard.member.chapterID, authorizedRoles])
    : null);
  // Authenticated Page-View Producer: A live session
  // records one page view per feature screen focus; preview sessions record
  // nothing.
  // While Product analytics is off the hook stays idle, so turning it back on
  // records the screen in view instead of a skipped view blocking it a minute.
  const productAnalytics = useProductAnalyticsEnabled();
  useFeaturePageView(featureKey, mode === 'authenticated' && productAnalytics === true, recordFeaturePageView);
  const desk = previewDesk;
  const title = FEATURE_TITLES[featureKey];
  const noticeEntry = featureKey === 'chapter-notices' || featureKey === 'steward-broadcasts';
  const heldNotice = usePendingNoticeSend(noticeEntry && session?.user.id
    ? `${session.user.id}|${chapterMemberships.find(row => row.selected)?.chapterID ?? ''}` : '');

  if (!canOpenFeature(mode, featureKey, previewHat, chapterRoles, organizationRoles) && !(mode === 'authenticated' && noticeEntry && heldNotice)) {
    if (featureKey === 'integrations') {
      return (
        <AuthorizationGate
          title={`${title} is not open to your role`}
          body={mode === 'preview' ? 'Connected services are set up by organization administrators and the campaign chair.' : catalogLabel('Only organization administrators and the campaign chair set up connected services. This role cannot start a connection.')}
          qualifyingHats={['admin', 'vp']}
          switchHat={mode === 'preview'}
          rolePicker={mode !== 'preview' && staffRoleChoices.length > 1}
        />
      );
    }
    if (mode !== 'preview') {
      return (
        <AuthorizationGate
          title={`${title} is not open to your role`}
          body={staffRoleChoices.length > 1
            ? chosenStaffRole
              ? `Working as ${LIVE_STAFF_ROLE_LABELS[chosenStaffRole]} does not open this destination. Choose another role to continue.`
              : 'This account holds more than one staff role. Choose which one to work as to open staff work.'
            : 'Your current campaign role does not grant this destination. Ask a campaign administrator if your assignment changed.'}
          rolePicker={staffRoleChoices.length > 1}
        />
      );
    }
    // A staff desk qualifies exactly one hat — its own — and a staff tool
    // qualifies every hat but Worker (featureCatalog.canOpenFeature). Both sets
    // are handed to the gate so the sentence can name them instead of
    // describing them.
    if (featureKey === 'operations') {
      return (
        <AuthorizationGate
          title={`${title} opens under Admin`}
          body="Operations health belongs to an organization administrator after two-step."
          qualifyingHats={['admin']}
          switchHat
        />
      );
    }
    if (featureKey === 'chapter-memberships') {
      return (
        <AuthorizationGate
          title={`${title} opens under Admin`}
          body="A campaign administrator holds memberships in their own campaign; an organization administrator holds them anywhere in the organization."
          qualifyingHats={['admin']}
          switchHat
        />
      );
    }
    if (featureKey === 'chapter-health') {
      return (
        <AuthorizationGate
          title={`${title} opens under leadership`}
          body="Advisor, Admin, campaign lead, and organization Campaign chair roles can open it."
          qualifyingHats={['advisor', 'admin', 'vp']}
          switchHat
        />
      );
    }
    if (featureKey === 'steward-caseload' || featureKey === 'steward-requests' || featureKey === 'steward-forms' || featureKey === 'steward-broadcasts') {
      return (
        <AuthorizationGate
          title={`${title} opens under Committee`}
          body="This part of the committee member desk belongs to the committee member role. Choosing Committee opens it here."
          qualifyingHats={['steward']}
          switchHat
        />
      );
    }
    if (featureKey === 'steward-appointments') {
      return (
        <AuthorizationGate
          title={`${title} opens under Committee`}
          body="The one-on-one desk belongs to the Committee role. Choosing Committee opens it here."
          qualifyingHats={['steward']}
          switchHat
        />
      );
    }
    return isStaffDeskFeatureKey(featureKey)
      ? (
        <AuthorizationGate
          title={`${title} opens under another role`}
          body="This desk belongs to the role that owns it. Choosing that role opens it here."
          qualifyingHats={[featureKey]}
          switchHat
        />
      )
      : (
        <AuthorizationGate
          title={`${title} is an organizing tool`}
          body="Organizer, Committee, Campaign lead, Advisor, Admin, campaign lead, and organization Campaign chair roles can open it."
          qualifyingHats={STAFF_HAT_KEYS}
          switchHat
        />
      );
  }

  if (isMi1FeatureKey(featureKey)) {
    return <Mi1FeatureScreen featureKey={featureKey} />;
  }

  if (featureKey === 'analytics') {
    return <Mi1AnalyticsScreen />;
  }

  if (featureKey === 'organization-map') {
    return <OrganizationIntelligenceScreen />;
  }

  if (featureKey === 'actions') {
    return <CollectiveActionsScreen />;
  }

  if (featureKey === 'qa') {
    return <Mi1QaFeatureScreen />;
  }

  if (featureKey === 'member-support') {
    // REQ-UG-HOME-NUDGES-20261001: ?source=onboarding opens the checklist.
    return sourceID === 'onboarding' ? <MemberSupportScreen initialTab="onboarding" /> : <MemberSupportScreen />;
  }

  // Worker-facing, read-only, and handled before the dashboard gate because
  // the structure does not depend on the worker's own issue workspace.
  if (featureKey === 'org-structure') {
    return <OrgStructureScreen />;
  }

  if (featureKey === 'chapter-memberships') {
    return <ChapterMembershipsScreen />;
  }

  if (!dashboard) {
    // BUG-UG-LOADING-NEVER-ENDS-AND-NO-RETRY-20261122:
    // a failed workspace load used to leave every feature screen on its
    // loading copy for as long as it stayed open. AppProvider records the
    // failure in `error`; say so, offer Try again, and let pull-to-refresh
    // retry, as Messages and Activity do. Only a signed-in session passes the
    // role gate above, so refresh() always has a session to act on here.
    const retry = () => { void refresh('user-refresh'); };
    const name = catalogLabel(title);
    return (
      <Screen refreshing={refreshing} onRefresh={retry}>
        <StateMessage
          title={error ? t('{title} could not load', { title: name }) : t('{title} is loading', { title: name })}
          body={error ? catalogLabel(error) : t('Getting your latest information.')}
          action={error
            ? <Button label={t('Try again')} variant="secondary" disabled={refreshing} busy={refreshing} onPress={retry} />
            : null}
        />
      </Screen>
    );
  }

  if (featureKey === 'pay') {
    return <PayToolsRoute />;
  }

  // Live sessions never reuse the fictional preview's fixtures or local-success
  // mutations. Every live route refreshes a current RLS projection; the preview
  // components below serve only the fictional preview.
  if (mode !== 'preview') {
    if (featureKey === 'cases') return <CasesFeature />;
    if (featureKey === 'voting') return <LiveVotingFeature />;
    if (featureKey === 'appointments') return <LiveAppointmentsFeature />;
    if (featureKey === 'partners') return <LivePartnersFeature key={partnerScope} />;
    if (featureKey === 'chapter-health' || featureKey === 'advisor' || featureKey === 'vp') {
      return <LiveHealthFeature title={title} homeChapterFirst={featureKey !== 'chapter-health'} />;
    }
    if (featureKey === 'chapters') return <ChaptersFeature />;
    if (['events', 'events-desk', 'rewards', 'numbers', 'workload', 'rights', 'chapter', 'tasks', 'steward-appointments'].includes(featureKey)) return <LiveLivedInScreen key={partnerScope} featureKey={featureKey} sourceID={sourceID} onOpenTask={openTask} />;
    if (isStewardDeskSectionKey(featureKey)) return <StewardDeskSectionsScreen featureKey={featureKey} />;
    if (featureKey === 'admin') return <ChapterAdminScreen title={title} authorizedRoles={authorizedRoles} />;
    if (featureKey === 'chapter-notices') return <ChapterNoticesScreen key={partnerScope} title={title} />;
    if (featureKey === 'chapter-invitations') return <ChapterInvitationsScreen key={partnerScope} title={title} />;
    // Keyed by scope like the neighbouring live routes, so a chapter,
    // organization or account switch while one stays mounted reloads it
    // instead of mixing two scopes.
    if (featureKey === 'campaigns') return <LiveCampaignsScreen key={partnerScope} />;
    if (featureKey === 'voice') return <LiveBeHeardScreen key={partnerScope} />;
    if (featureKey === 'search') return <LiveSearchScreen key={partnerScope} />;
    if (featureKey === 'steward') return <LiveCaseworkDeskScreen key={partnerScope} />;
    if (featureKey === 'coordinator') return <LiveCaseQueueScreen key={partnerScope} />;
    if (featureKey === 'forms') return <LiveFormsScreen key={partnerScope} kept={formsEditor} />;
    // The organizing desk has no server read of its own yet; it opens the
    // shared desk screen, which the organizer role gates.
    if (featureKey === 'organizer') return <DeskFeature title={title} expectedHat="organizer" currentHat={null} authorizedRoles={authorizedRoles} mode={mode} />;
    return <UnbuiltFeatureScreen title={title} />;
  }

  if (featureKey === 'voting') return <VotingFeature />;
  if (featureKey === 'forms') return <FormsFeature />;
  if (featureKey === 'workload') return <WorkloadFeature />;
  if (featureKey === 'voice') return <VoiceFeature />;
  if (featureKey === 'search') return <SearchFeature />;
  if (featureKey === 'cases') return <CasesFeature />;
  if (featureKey === 'appointments') return <AppointmentsFeature />;
  if (featureKey === 'steward-appointments') return <StewardAppointmentsFeature />;
  if (featureKey === 'rights') return <RightsFeature sourceID={sourceID} />;
  if (featureKey === 'events' || featureKey === 'events-desk') return <EventsFeature deskTitle={featureKey === 'events-desk'} />;
  if (featureKey === 'rewards') return <RewardsFeature />;
  if (featureKey === 'numbers') return <ReportsFeature />;
  if (featureKey === 'chapter') return <ChapterFeature sourceID={sourceID} />;
  if (featureKey === 'campaigns') return <CampaignsFeature />;
  if (featureKey === 'tasks') return <ChapterWorkFeature />;
  if (featureKey === 'chapters') return <ChaptersFeature />;
  if (featureKey === 'chapter-health') return <LiveHealthFeature title={title} />;
  if (featureKey === 'partners') return <PartnersFeature key={partnerScope} />;
  if (featureKey === 'organizer' || featureKey === 'steward' || featureKey === 'coordinator' || featureKey === 'advisor' || featureKey === 'admin' || featureKey === 'vp') {
    return <DeskFeature title={title} expectedHat={featureKey === 'vp' ? 'vp' : featureKey} currentHat={previewHat} authorizedRoles={authorizedRoles} mode={mode} />;
  }
  if (isStewardDeskSectionKey(featureKey)) return <StewardDeskSectionsScreen featureKey={featureKey} />;

  return (
    <Screen>
      <Heading>{title}</Heading>
      <Body muted>{desk?.summary ?? 'Authorized campaign work for this destination.'}</Body>
    </Screen>
  );
}

// Staff tools open under any staff hat, which is every preview hat except
// Worker (featureCatalog: STAFF_TOOL_FEATURE_KEYS in canOpenFeature). Derived
// from the hat roster rather than retyped, so a new hat cannot be missing from
// a gate's sentence.
const STAFF_HAT_KEYS: PreviewHatKey[] = PREVIEW_HATS
  .filter((item) => item.key !== 'member')
  .map((item) => item.key);

/**
 * The authorization-gate template. Three parts, in this order, and no gate may
 * ship a fourth or drop one (IA-wave-A review; b06-17 filed the template):
 *
 * 1. **Destination title.** The specific thing the worker tried to open, named
 *    first — `${title} opens under another hat`, never a generic "Not
 *    authorized".
 * 2. **Qualifying-hats sentence.** Which hats open it, named. Where the caller
 *    knows the qualifying set *and* the preview store knows the hats this
 *    worker holds, the sentence narrows to the intersection of the two, so it
 *    lists routes the worker can actually take. Where held hats are unknowable
 *    — a live session has no hat switcher and no hat inventory (the
 *    demo-origin contract) — the caller's filed sentence ships unchanged.
 * 3. **Action button.** The real control, or nothing. A live gate states the
 *    human route in its sentence and shows no button, because the control it
 *    would describe does not exist there.
 */
function AuthorizationGate({ title, body, qualifyingHats, switchHat = false, rolePicker = false }: {
  title: string;
  body: string;
  /** Hats that open this destination; omitted where the caller cannot know. */
  qualifyingHats?: readonly PreviewHatKey[];
  switchHat?: boolean;
  /** Offers the live staff role choice to an account that holds several roles. */
  rolePicker?: boolean;
}) {
  const theme = useTheme();
  const { mode } = useApp();
  // The preview store is the only place that holds this worker's hats. In a
  // live session it supplies none, and the gate keeps the filed sentence.
  const heldHats = mode === 'preview' ? PREVIEW_HATS : [];
  const qualifying = qualifyingHats
    ? heldHats.filter((item) => qualifyingHats.includes(item.key))
    : [];
  const sentence = qualifying.length > 0 ? qualifyingSentence(qualifying.map((item) => item.label)) : body;
  return (
    <Screen>
      <StateMessage
        title={title}
        body={sentence}
        action={switchHat ? (
          <Button
            label="Switch role"
            variant="secondary"
            icon={<Ionicons name="swap-horizontal" size={18} color={theme.secondaryForeground} accessibilityElementsHidden />}
            onPress={requestHatSwitcher}
          />
        ) : rolePicker ? <StaffRolePicker /> : undefined}
      />
    </Screen>
  );
}

// Canonical hat nouns (b03a-3), spoken as one sentence. The action stays in the
// button: this line says who opens the destination, never how to get there.
function qualifyingSentence(labels: string[]): string {
  if (labels.length === 1) return `The ${labels[0]} role opens it.`;
  const last = labels[labels.length - 1];
  const list = labels.length === 2
    ? `${labels[0]} and ${last}`
    : `${labels.slice(0, -1).join(', ')}, and ${last}`;
  return `${list} roles open it.`;
}

function LiveVotingFeature() {
  const { catalogLabel } = useNativeUi();
  const writer = useBusinessWriter();
  const theme = useTheme();
  const { dashboard } = useApp();
  const chapterID = dashboard?.member.chapterID;
  const [ballots, setBallots] = useBusinessDraftState<MobileBallot[] | null>(null);
  // REQ-UG-OFFICER-REMOVAL-BALLOTS-20261001: campaign leader, reason and
  // recorded result of published removal votes; empty when unavailable.
  const [removalDetails, setRemovalDetails] = useBusinessState<Map<string, OfficerRemovalDetail>>(() => new Map());
  const [selected, setSelected] = useBusinessDraftState<Record<string, string>>({});
  const [busy, setBusy] = useBusinessState<string | null>(null);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, null);
  const [error, setError] = useBusinessDraftState<string | null>(null);
  const [reload, setReload] = useBusinessDraftState(0);

  useEffect(() => {
    let active = true;
    setBallots(null);
    setSelected({});
    setError(null);
    setRemovalDetails(new Map());
    void withReadDeadline(loadMobileBallots()).then((items) => {
      if (!active) return;
      setBallots(items);
      void loadMobileOfficerRemovalDetails(items.map((item) => item.id)).then((details) => { if (active) setRemovalDetails(details); });
    }).catch(() => {
      if (active) setError('Votes didn’t load. Try again.');
    });
    return () => { active = false; };
  }, [chapterID, reload, setBallots, setSelected, setError, setRemovalDetails]);

  async function castVote(ballot: MobileBallot) {
    await operate(ballot.id, async () => {
    const optionID = selected[ballot.id];
    if (!optionID || ballot.closed || ballot.receiptCode) return;

    setError(null);
    try {
      const receiptCode = await submitMobileBallotVote(writer, ballot.id, optionID);
      setSelected((current) => {
        const next = { ...current };
        delete next[ballot.id];
        return next;
      });
      setBallots((current) => current?.map((item) => item.id === ballot.id ? { ...item, receiptCode } : item) ?? null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'The vote was not confirmed.');
      // Rethrown so the primitive returns the button to idle with the warning
      // haptic: a vote that failed must not settle into a success state the
      // worker never earned. The message on screen is unchanged.
      throw nextError;
    }

    });
  }

  return (
    <Screen>
      <NativeFeatureGuide feature="ballots" />
      <Heading>{catalogLabel('Votes')}</Heading>
      <Body muted>{BALLOT_STORAGE_SENTENCE}</Body>
      {error ? <Card><Body style={{ color: theme.destructive }}>{error}</Body><Button label="Refresh votes" onPress={() => setReload((value) => value + 1)} /></Card> : null}
      {!error && ballots === null ? <StateMessage title="Loading votes" body="Checking campaign eligibility and your private receipt state." /> : ballots?.length === 0 ? <StateMessage title="No votes" body="Eligible open and retained closed votes will appear here." /> : ballots?.map((ballot) => (
        <LiveBallotCard
          key={ballot.id}
          ballot={ballot}
          removal={removalDetails.get(ballot.id) ?? null}
          choice={selected[ballot.id]}
          // One vote at a time across the screen, as before. The ballot being
          // cast is held inert by its own button's busy state, so it is only
          // the other ballots that this flag has to refuse.
          otherBusy={busy !== null && busy !== ballot.id}
          onChoose={(optionID) => setSelected((current) => ({ ...current, [ballot.id]: optionID }))}
          onCast={() => castVote(ballot)}
        />
      ))}
      <LiveSurveyHistory />
      <Card><Heading level={3}>Verify a receipt</Heading><Body muted>Use the public receipt checker on the Union Ground verify page. Verification never shows how the vote was cast.</Body></Card>
    </Screen>
  );
}

/**
 * The app's one real async write on the shared primitive (triage F2). A ballot
 * is one transactional control, so it is its own component: the hook holds the
 * busy state of the button that was pressed rather than a screen-wide flag,
 * the spinner lands inside that button instead of the label swapping to
 * "Casting final vote…", and the success haptic is the hook's alone.
 *
 * Nothing else moves: the same copy, the same receipt line, and the same
 * privacy boundary — the receipt is the only thing this screen ever shows.
 */
function LiveBallotCard({ ballot, removal, choice, otherBusy, onChoose, onCast }: {
  ballot: MobileBallot;
  removal: OfficerRemovalDetail | null;
  choice: string | undefined;
  otherBusy: boolean;
  onChoose: (optionID: string) => void;
  onCast: () => Promise<void>;
}) {
  const { language, t } = useNativeUi();
  const theme = useTheme();
  const cast = useTransactionalAction(onCast);
  // Votes are final, so the cast press asks first and names the choice on the
  // voter's own screen; only the confirmation starts the write.
  const confirmCast: TransactionalAction = {
    ...cast,
    perform: () => {
      const option = ballot.options.find((item) => item.id === choice);
      if (!option) return;
      const confirmation = ballotCastConfirmation(option.label);
      Alert.alert(confirmation.title, confirmation.body, [
        { text: confirmation.cancelLabel, style: 'cancel' },
        { text: confirmation.confirmLabel, onPress: cast.perform },
      ]);
    },
  };
  const voted = Boolean(ballot.receiptCode);
  const disabled = ballot.closed || voted;
  const closesAt = formatBallotClosingTime(ballot.closesAt, language);
  return (
    <Card>
      <View style={styles.workChipRow}>
        <Text style={[styles.eyebrow, { color: theme.primary }]}>COMMITTEE VOTE</Text>
        <View style={[styles.liveStatus, { backgroundColor: voted ? theme.secondary : theme.muted }]}><Text style={[styles.liveStatusText, { color: voted ? theme.secondaryForeground : theme.mutedForeground }]}>{voted ? 'Voted' : ballot.closed ? 'Closed' : 'Open'}</Text></View>
      </View>
      <Heading level={3}>{ballot.title}</Heading>
      {removal ? (
        <View testID="officer-removal-summary">
          <Text style={[styles.eyebrow, { color: theme.primary }]}>CAMPAIGN LEADER REMOVAL</Text>
          <Body>Campaign leader: {removal.targetName} ({removalRoleLabel(removal.targetRole, ballot.chapterId)})</Body>
          {removal.reason ? <Body muted>Reason: {removal.reason}</Body> : null}
          {removalOutcomeLabel(removal.outcome) ? <Body>{removalOutcomeLabel(removal.outcome)}</Body> : null}
        </View>
      ) : null}
      <Body muted>{closesAt
        ? t(ballot.closed ? 'Closed {when}' : 'Closes {when}', { when: closesAt })
        : t(ballot.closed ? 'Closed' : 'Closing time unavailable')}</Body>
      {voted ? (
        // The live ballot's receipt is the arrival for this write, so it lands
        // on the same primitive the preview flow uses: it animates only when
        // this session cast the vote, and it speaks only the receipt. The
        // selection is never in the announcement — a ballot read aloud is a
        // ballot no longer secret.
        <TransactionalReveal enabled={cast.done} announce={`Recorded. Receipt ${ballot.receiptCode}.`}>
          <Body>Receipt: {ballot.receiptCode}</Body>
          <Body muted>{BALLOT_RECEIPT_SENTENCE}</Body>
        </TransactionalReveal>
      ) : ballot.closed ? <Body muted>This vote is read-only.</Body> : (
        <View style={styles.optionStack} accessibilityRole="radiogroup" accessibilityLabel={`Options for ${ballot.title}`}>
          {ballot.options.map((option) => {
            const checked = choice === option.id;
            return (
              <Pressable
                key={option.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: checked }}
                accessibilityLabel={option.label}
                onPress={() => onChoose(option.id)}
                style={({ pressed }) => [styles.optionRow, { borderColor: checked ? theme.ring : theme.border, backgroundColor: checked ? theme.secondary : theme.card, opacity: pressed ? 0.82 : 1 }]}
              >
                <View style={[styles.optionDot, { borderColor: checked ? theme.primary : theme.mutedForeground }]}>{checked ? <View style={[styles.optionDotFill, { backgroundColor: theme.primary }]} /> : null}</View>
                <Text style={[styles.optionLabel, { color: theme.cardForeground }]}>{option.label}</Text>
              </Pressable>
            );
          })}
          <Body muted>{BALLOT_FINAL_HINT}</Body>
          <TransactionalButton label="Cast final vote" action={confirmCast} disabled={otherBusy || disabled || !choice} />
        </View>
      )}
    </Card>
  );
}

// The live fallback for a feature address with no phone screen of its own.
// The route table (featureRouteTable.test.ts) fails if any address the phone
// pushes reaches it; until  the generic evidence list stood here and
// seven addresses opened only that.
function UnbuiltFeatureScreen({ title }: { title: string }) {
  const { catalogLabel } = useNativeUi();
  return (
    <Screen>
      <Heading>{catalogLabel(title)}</Heading>
      <StateMessage title={`${title} is not on the phone yet`} body="Open it on the website." />
    </Screen>
  );
}

// Chapter admin is its optional connections and nothing else, so it lists no
// records above them (UX-UG-NATIVE-CHAPTER-ADMIN-SHOWS-RAW-CAPABILITY-KEYS-20261109).
// It was drawn by the generic evidence screen until
// BUG-UG-NATIVE-SEVEN-FEATURE-KEYS-OPEN-ONLY-THE-GENERIC-SCREEN-20261113
//  gave it this screen of its own. The readiness rows are the server's
// current chapter (their read policy), so they re-load on a chapter switch, and
// an organization administrator records a provider's outcome only against the
// row's own chapter while it is the one this phone shows. The generic screen
// had hidden that control since  scoped its chapter to casework.
const CHAPTER_ADMIN_CAPABILITIES: MobileConnectionReadiness['capability'][] = ['sms', 'calendar_google', 'calendar_microsoft', 'cba', 'notion', 'enterprise'];

function ChapterAdminScreen({ title, authorizedRoles }: { title: string; authorizedRoles: readonly string[] }) {
  const { catalogLabel, t } = useNativeUi();
  const writer = useBusinessWriter();
  const theme = useTheme();
  const { dashboard, refreshChapterMemberships } = useApp();
  const chapterID = dashboard?.member.chapterID;
  const [connections, setConnections] = useBusinessDraftState<MobileConnectionReadiness[] | null>(null);
  const [error, setError] = useBusinessDraftState<string | null>(null);
  const [reload, setReload] = useBusinessDraftState(0);
  const requests = useBusinessRequests(writer, chapterID);
  const [refreshingChapter, setRefreshingChapter] = useBusinessState(false);
  const [operateRefresh] = useBusinessOperation<boolean>(setRefreshingChapter, false);
  const [refreshFailures, setRefreshFailures] = useBusinessDraftState(0, chapterID ?? null);
  const [connectionBusy, setConnectionBusy] = useBusinessState<string | null>(null);
  const [operateConnection] = useBusinessOperation<typeof connectionBusy>(setConnectionBusy, null);
  const [connectionNotice, setConnectionNotice] = useBusinessDraftState<string | null>(null);
  // Enterprise controls names single sign-on and directory sync only once a
  // read says each is released.
  const ssoReleased = useSsoReleased();
  const scimReleased = useScimReleased();

  useEffect(() => {
    let active = true;
    setConnections(null);
    setError(null);
    void loadMobileConnectionReadiness().then((nextConnections) => {
      if (active) setConnections(nextConnections);
    }).catch(() => {
      if (active) setError('These connections didn’t load. Try again.');
    });
    return () => { active = false; };
  }, [chapterID, reload, setConnections, setError]);

  async function refreshChapter() {
    await operateRefresh(true, async () => {
      const current = requests.capture().isCurrent;
      if (!current()) return;
      try {
        await refreshChapterMemberships();
        if (!current()) return;
        // If the chapter changed, its effect owns the read. Otherwise reread
        // the connections here, even when the membership refresh did not reload.
        const nextConnections = await loadMobileConnectionReadiness();
        if (!current()) return;
        setConnections(nextConnections);
        setRefreshFailures(0);
      } catch {
        if (current()) setRefreshFailures((count) => count + 1);
      }
    });
  }

  // The request holds its control through the write and the reread, and
  // reads the connections again only on current session proof.
  async function requestSetup(capability: MobileConnectionReadiness['capability']) {
    await operateConnection(capability, async () => {
      const current = requests.capture().isCurrent;
      setConnectionNotice(null);
      try {
        await requestMobileConnectionSetup(writer, capability);
        const proof = await checkBusinessContinuation(writer, current);
        if (proof === 'changed') return;
        if (proof === 'current') {
          const nextConnections = await loadMobileConnectionReadiness();
          if (!current()) return;
          setConnections(nextConnections);
        }
        setConnectionNotice('Setup review requested. Activation still requires operator verification of the campaign-owned provider.');
      } catch (nextError) {
        if (current()) setConnectionNotice(nextError instanceof Error ? nextError.message : 'Setup review was not confirmed.');
      }
    });
  }

  return (
    <Screen>
      <Heading>{catalogLabel(title)}</Heading>
      <Body muted>Optional connections your campaign can set up, each with its status.</Body>
      {error ? (
        <Card><Heading level={3}>Connections unavailable</Heading><Body muted>{error}</Body><Button label="Try again" onPress={() => setReload((value) => value + 1)} /></Card>
      ) : connections === null ? (
        <StateMessage title={`Loading ${title.toLocaleLowerCase()}`} body="Getting the latest connection status." />
      ) : (
        <>
          <Heading level={2}>Optional connections</Heading>
          <Body muted>These capabilities ship unset. A real campaign chooses its provider and an operator verifies it; no credential enters the app.</Body>
          {connections.some((entry) => entry.chapterID !== chapterID) ? (
            <Card>
              <Body>These connections belong to the campaign selected in another session, not the one this phone shows. Refresh your campaign before recording a decision.</Body>
              <Button label={t('Refresh campaign')} variant="secondary" busy={refreshingChapter} onPress={() => { void refreshChapter(); }} />
              {!refreshingChapter && refreshFailures > 0 ? <Notice key={refreshFailures}>{t('Your campaign could not be refreshed. Try again.')}</Notice> : null}
            </Card>
          ) : null}
          {CHAPTER_ADMIN_CAPABILITIES.map((capability) => {
            const connection = connections.find((entry) => entry.capability === capability);
            const verifyChapter = verifiableConnectionChapter(connection?.chapterID, chapterID);
            const status = connection?.status ?? 'unset';
            const planned = isPlannedChapterCapability(capability);
            const canRequest = !planned && authorizedRoles.includes('admin') && !['configuring', 'active'].includes(status);
            return (
              <Card key={capability}>
                <View style={styles.workChipRow}>
                  <Heading level={3}>{connectionLabel(capability)}</Heading>
                  <View style={[styles.liveStatus, { backgroundColor: theme.muted }]}><Text style={[styles.liveStatusText, { color: theme.mutedForeground }]}>{status}</Text></View>
                </View>
                {/* While single sign-on or directory sync (SCIM) is held, the
                    Enterprise card keeps its own wording whatever the server
                    message says, so no server text can name a held feature
                    before its release (ledger 177, #9045; #9037). */}
                <Body muted>{capability === 'enterprise' && !(ssoReleased && scimReleased) ? enterpriseControlsCopy(ssoReleased, scimReleased) : connection?.publicMessage || connectionReadinessCopy(capability, ssoReleased, scimReleased)}</Body>
                {canRequest ? <Button label={connectionBusy === capability ? 'Requesting…' : 'Request operator review'} disabled={connectionBusy !== null} onPress={() => { void requestSetup(capability); }} /> : null}
                {connection && chapterConnectionIsVerifiable(capability, status) ? (
                  <Body>{chapterConnectionProviderLine(connection.providerLabel ?? '')}</Body>
                ) : null}
                {verifyChapter && chapterConnectionIsVerifiable(capability, status)
                  ? <ChapterConnectionVerification chapterID={verifyChapter} capability={capability} onRecorded={() => setReload((value) => value + 1)} />
                  : null}
              </Card>
            );
          })}
          {connectionNotice ? <Body>{connectionNotice}</Body> : null}
        </>
      )}
    </Screen>
  );
}

function connectionLabel(capability: MobileConnectionReadiness['capability']) {
  return ({ sms: 'SMS delivery', calendar_google: 'Google free/busy', calendar_microsoft: 'Microsoft free/busy', cba: 'Campaign reference library', notion: 'Notion sync · planned', enterprise: 'Enterprise controls · planned' })[capability];
}

function connectionReadinessCopy(capability: MobileConnectionReadiness['capability'], ssoReleased: boolean, scimReleased: boolean) {
  if (capability === 'cba') return 'No sanctioned agreement is loaded. Staff author and verify the first real campaign corpus only after customer onboarding.';
  if (capability === 'notion') return 'Planned and inactive. Native campaign notes remain the source of truth; there is no Sync control.';
  if (capability === 'enterprise') return enterpriseControlsCopy(ssoReleased, scimReleased);
  if (capability.startsWith('calendar')) return 'Unset until the campaign provisions its own OAuth application. Union Ground does not create provider identities.';
  return 'Unset until sender registration, test delivery, rollback, and data-handling checks are verified.';
}

// What a partners or health refresh did with its read.
type RefreshResult = 'loaded' | 'failed' | 'superseded';

//  pull request C (design R-9240D, row C): an unsent partnership request
// and the organization search text wait through a foreground session check on
// the shared draft hook (memory only), keyed to the person, every role set,
// the hat, the organization and the chapter; any confirmed chapter or
// organization change, sign-out, another account, MFA or an authoritative
// refusal of the partners read retires them, and nothing held shows until that
// read is back. The request keeps the partner it was written to: an
// unconfirmed request whose partner is no longer verified is not sent again.
// The request is deduplicated by its key, so the held attempt's key is the
// request's idempotency key: a send with no answer stays locked as unconfirmed,
// and a deliberate Send again carries the same key, so it cannot file a second
// request. Every send ends at the 20-second deadline. Search results are a
// fresh read and are never held.
type PartnershipDraft = { open: boolean; partnerOrgID: string; title: string; purpose: string; dataScope: MobileHandshake['dataScope'] };
const PARTNERSHIP_EMPTY: PartnershipDraft = { open: false, partnerOrgID: '', title: '', purpose: '', dataScope: 'docs_only' };
const partnershipSurface = defineRetainedSurface<Held<PartnershipDraft>>('partnership-request');
type PartnerSearchDraft = { query: string };
const PARTNER_SEARCH_EMPTY: PartnerSearchDraft = { query: '' };
const partnerSearchSurface = defineRetainedSurface<Held<PartnerSearchDraft>>('partner-organization-search');
// Only the WriterSessionChanged object the session writer itself
// throws before sending proves nothing was sent, never an answer that merely
// carries its 'writer_session_changed' marker.
const sessionRefused = (error: unknown) => error instanceof WriterSessionChanged && businessRpcProvenance(error) === null;

export function LivePartnersFeature() {
  const { t } = useNativeUi();
  const writer = useBusinessWriter();
  const theme = useTheme();
  const { dashboard, authorizedRoles, chapterMemberships, organizationID } = useApp();
  const chapterID = chapterMemberships.find((entry) => entry.selected)?.chapterID ?? dashboard?.member.chapterID;
  const copy = chapterLifecycleCopy[dashboard?.member.language === 'es' ? 'es' : 'en'];
  const connectionTr = nativeConnectionCopy(dashboard?.member.language === 'es' ? 'es' : 'en');
  const [showConnections, setShowConnections] = useBusinessDraftState(false);
  const [items, setItems] = useBusinessDraftState<MobileHandshake[] | null>(null);
  const [targets, setTargets] = useBusinessDraftState<MobileHandshakeTarget[] | null>(null);
  const [binding, setBinding] = useBusinessDraftState<MobileChapterBinding | null>(null);
  //  (carved from, M1-6): a search that matched nothing and a
  // search that failed each say so beside the search, not nothing and not the
  // binding request's error. An outcome belongs to the chapter and query that
  // produced it (`id` counts completed searches, for one announcement each).
  const [searchOutcome, setSearchOutcome] = useBusinessDraftState<{ chapterID: string | null; query: string; state: 'empty' | 'failed'; id: number } | null>(null);
  const searchCount = useRef(0);
  const [documents, setDocuments] = useBusinessDraftState<MobileHandshakeDocument[]>([]);
  const [selectedDocumentID, setSelectedDocumentID] = useBusinessDraftState('');
  const [organizationResults, setOrganizationResults] = useBusinessDraftState<MobileUnionOrganization[]>([]);
  const [selectedOrganizationID, setSelectedOrganizationID] = useBusinessDraftState('');
  const [unconfirmedWrite, setUnconfirmedWrite] = useBusinessSubjectState(JSON.stringify([organizationID, chapterID]), false);
  const [notice, setNotice] = useBusinessDraftState<string | null>(null);
  const [error, setError] = useBusinessDraftState<string | null>(null);
  const requests = useBusinessRequests(writer);
  const [busy, setBusy] = useBusinessState<string | null>(null);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, null);
  const [confirming, setConfirming] = useBusinessDraftState<{ item: MobileHandshake; action: 'decline' | 'close' } | null>(null);
  const partnership = useRetainedDraft<PartnershipDraft>({ surface: partnershipSurface, item: chapterID ?? 'none', empty: PARTNERSHIP_EMPTY, fresh: targets !== null });
  const organizationSearch = useRetainedDraft<PartnerSearchDraft>({ surface: partnerSearchSurface, item: chapterID ?? 'none', empty: PARTNER_SEARCH_EMPTY, fresh: items !== null });
  const refusedDrafts = useRef((error: unknown) => { partnership.refused(error); organizationSearch.refused(error); });
  refusedDrafts.current = (error: unknown) => { partnership.refused(error); organizationSearch.refused(error); };
  const { title, purpose, dataScope } = partnership.value;
  const composing = partnership.shown && partnership.value.open;
  // The partner the request was written to while it is still verified; an
  // untouched request starts on the first verified partner, as before.
  const heldPartnerVerified = (targets ?? []).some((target) => target.id === partnership.value.partnerOrgID);
  const partnerOrgID = heldPartnerVerified ? partnership.value.partnerOrgID : partnership.value.partnerOrgID && partnership.pending !== false ? '' : targets?.[0]?.id ?? '';
  const requestUncertain = partnership.pending === 'uncertain';
  const requestLocked = busy !== null || partnership.pending !== false;
  const organizationQuery = organizationSearch.value.query;
  // The chapter and query on screen now, read by a search when its answer lands.
  const searchSubject = useRef({ chapterID: chapterID ?? null, query: organizationQuery });
  searchSubject.current = { chapterID: chapterID ?? null, query: organizationQuery };
  const shownSearchOutcome = searchOutcome && searchOutcome.chapterID === (chapterID ?? null) && searchOutcome.query === organizationQuery ? searchOutcome : null;
  // The no-match line is announced politely once per completed search, as the
  // shared Notice announces its message: a polite live region, and on iOS the
  // shared announcement queue, here through its owner hook (one attempt per call).
  const emptySearchId = shownSearchOutcome?.state === 'empty' ? shownSearchOutcome.id : null;
  const announceSearch = useAccessibilityAnnouncementQueue(`partner-search:${chapterID ?? ''}`);
  useEffect(() => {
    if (emptySearchId === null || Platform.OS !== 'ios') return undefined;
    return announceSearch(copy.bindingSearchEmpty);
  }, [emptySearchId, copy.bindingSearchEmpty, announceSearch]);
  const queueAnnouncement = useAccessibilityAnnouncementQueue(`partners:${chapterID ?? 'none'}`);
  const staff = explicitLiveStaffHat(authorizedRoles) !== null;
  const admin = authorizedRoles.includes('admin');
  const savedWorkCheckFailed = (admin && binding?.status !== 'verified' && organizationSearch.checkFailed)
    || (staff && Boolean(targets?.length) && partnership.checkFailed);
  // Returning to a confirmed workspace reuses its unresolved retry keys.
  const operationOwner = useBusinessRequestOwner();
  const handshakes = useBusinessOperationCache(operationOwner.workspace, () => createHandshakeOperations({
    request: (...args) => requestMobileHandshake(writer, ...args), respond: (...args) => respondMobileHandshake(writer, ...args), countersign: (...args) => countersignMobileHandshake(writer, ...args),
    close: (...args) => closeMobileHandshake(writer, ...args), shareDocument: (...args) => shareMobileHandshakeDocument(writer, ...args),
  }, Crypto.randomUUID));
  const readSequence = useRef(0);
  // A refresh says whether its read loaded, failed or was superseded, so a
  // write's follow-up can tell a failed reread from a good one.
  async function refresh(confirmAccepted = false): Promise<RefreshResult> {
    const ticket = requests.capture();
    if (!ticket.isCurrent()) return 'superseded';
    const at = ++readSequence.current;
    const current = () => at === readSequence.current && ticket.isCurrent();
    if (!chapterID) {
      setError(null);
      setItems([]);
      setTargets([]);
      setBinding(null);
      setDocuments([]);
      return 'loaded';
    }
    setError(null);
    try {
      const [nextItems, nextTargets, nextBinding, nextDocuments] = await Promise.all([
        loadMobileHandshakes(chapterID), loadMobileHandshakeTargets(chapterID),
        loadMobileChapterBinding(chapterID), loadMobileHandshakeDocuments(chapterID),
      ]);
      if (!current()) return 'superseded';
      setItems(nextItems);
      setTargets(nextTargets);
      setBinding(nextBinding);
      setDocuments(nextDocuments);
      setSelectedDocumentID((current) => nextDocuments.some((document) => document.id === current) ? current : nextDocuments[0]?.id || '');
      if (confirmAccepted) {
        setUnconfirmedWrite(false);
        setNotice(previous => previous === BUSINESS_SAVED_STALE ? null : previous);
      }
      return 'loaded';
    } catch (error) {
      if (!current()) return 'superseded';
      setError(copy.refreshError);
      refusedDrafts.current(error);
      return 'failed';
    }
  }
  async function refreshView() {
    await operate('refresh', async () => {
      const current = requests.capture().isCurrent;
      if (await checkBusinessContinuation(writer, current) === 'current') await refresh(true);
    });
  }

  useEffect(() => { void refresh(); /* the composing person and chapter own this load */ // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { readSequence.current += 1; };
  }, [chapterID, writer, requests]);
  async function transition(item: MobileHandshake, action: 'accept' | 'decline' | 'countersign' | 'close') {
    if (unconfirmedWrite) return;
    await operate(`${item.id}:${action}`, async () => {
    const current = requests.capture().isCurrent;

    setError(null);
    try {
      await handshakes.transition(item.id, action);
      setUnconfirmedWrite(true);
      setConfirming(null);
      await settleBusinessWrite(writer, { current,
        accepted: () => setNotice('The change was saved.'),
        stale: () => setNotice(BUSINESS_SAVED_STALE),
        refresh: async () => {
          const result = await refresh(true);
          if (result === 'loaded' && await checkBusinessContinuation(writer, current) === 'current') void haptics.success();
          return result !== 'failed';
        },
      });
    } catch { setError(copy.transitionError); }


    });
  }
  async function sendRequest() {
    if (unconfirmedWrite) return;
    await operate('request', async () => {
    const current = requests.capture().isCurrent;
    if (!partnership.shown || partnership.pending === 'sending' || !partnerOrgID || !title.trim() || !purpose.trim()) return;
    // An untouched partner choice is the one shown; a retry keeps its own.
    if (!requestUncertain && partnership.value.partnerOrgID !== partnerOrgID) partnership.set({ partnerOrgID });
    // One attempt at a time, held through an unmount and settled after it.
    const attempt = partnership.begin();
    if (!attempt) return;

    setError(null);
    try {
      await withReadDeadline(requestMobileHandshake(writer, {
        partnerOrgID: attempt.value.partnerOrgID, title: attempt.value.title, purpose: attempt.value.purpose, dataScope: attempt.value.dataScope, idempotencyKey: attempt.key,
      }));
      attempt.settle('done');
      setUnconfirmedWrite(true);
      await settleBusinessWrite(writer, { current,
        accepted: () => setNotice('The change was saved.'),
        stale: () => setNotice(BUSINESS_SAVED_STALE),
        refresh: async () => {
          const result = await refresh(true);
          if (result === 'loaded' && await checkBusinessContinuation(writer, current) === 'current') void haptics.success();
          return result !== 'failed';
        },
      });
    } catch (nextError) {
      // Only a refusal before sending is definite; anything else may have
      // landed, and its key makes a deliberate retry safe.
      const definite = sessionRefused(nextError);
      attempt.settle(definite ? { failed: 'request' } : 'uncertain');
      if (definite) setError(copy.requestError);
    }


    });
  }
  async function searchOrganizations() {
    await operate('organization-search', async () => {
    if (!unionOrganizationSearchable(organizationQuery)) return;
     setError(null); setNotice(null); setSearchOutcome(null);
    const started = { chapterID: chapterID ?? null, query: organizationQuery };
    const id = ++searchCount.current;
    // A late answer for another chapter or an edited query says nothing.
    const stillAsked = () => searchSubject.current.chapterID === started.chapterID && searchSubject.current.query === started.query;
    try {
      const result = await searchMobileUnionOrganizations(organizationQuery);
      setOrganizationResults(result);
      setSelectedOrganizationID((current) => result.some((organization) => organization.id === current) ? current : '');
      if (stillAsked()) setSearchOutcome(result.length ? null : { ...started, state: 'empty', id });
    } catch {
      if (stillAsked()) { setOrganizationResults([]); setSelectedOrganizationID(''); setSearchOutcome({ ...started, state: 'failed', id }); }
    }


    });
  }
  async function requestBinding() {
    if (unconfirmedWrite) return;
    await operate('binding-request', async () => {
    const current = requests.capture().isCurrent;
    if (!selectedOrganizationID) return;
     setError(null); setNotice(null);
    try {
      await requestMobileChapterBinding(writer, selectedOrganizationID);
      setUnconfirmedWrite(true);
      setNotice(copy.bindingRequested);
      await settleBusinessWrite(writer, { current,
        accepted: () => setNotice('The change was saved.'),
        stale: () => setNotice(BUSINESS_SAVED_STALE),
        refresh: async () => {
          const result = await refresh(true);
          if (result === 'loaded' && await checkBusinessContinuation(writer, current) === 'current') void haptics.success();
          return result !== 'failed';
        },
      });
    } catch { setError(copy.bindingRequestError); }


    });
  }
  async function shareDocument(handshakeID: string) {
    if (unconfirmedWrite) return;
    await operate(`document:${handshakeID}`, async () => {
    const current = requests.capture().isCurrent;
    if (!selectedDocumentID) return;
     setError(null); setNotice(null);
    try {
      await handshakes.shareDocument(handshakeID, selectedDocumentID);
      setUnconfirmedWrite(true);
      setNotice(copy.documentShared);
      await settleBusinessWrite(writer, { current,
        accepted: () => setNotice('The change was saved.'),
        stale: () => setNotice(BUSINESS_SAVED_STALE),
        refresh: async () => {
          const result = await refresh(true);
          if (result === 'loaded' && await checkBusinessContinuation(writer, current) === 'current') void haptics.success();
          return result !== 'failed';
        },
      });
    } catch { setError(copy.documentError); }


    });
  }
  function requestConfirmation(item: MobileHandshake, action: 'decline' | 'close') {
    setConfirming({ item, action });
    queueAnnouncement(copy.confirmAnnouncement(action, item.title));
  }
  // The connections panel calls back after its own request settles. The
  // ticket is the one captured with the render that handed the panel this
  // callback, before that request, so a retired workspace changes nothing
  // here.
  const handshakeTicket = requests.capture();
  function handshakeReturned({ noticeKey }: ConnectionHandshakeSubmission) {
    if (!handshakeTicket.isCurrent()) return;
    setNotice(connectionTr(noticeKey)); queueAnnouncement(connectionTr(noticeKey));
    setShowConnections(false); void refresh();
  }
  if (showConnections) return <Screen>
    <Button label={connectionTr('closeConnections')} variant="secondary" onPress={() => setShowConnections(false)} />
    <ConnectionSuggestionsPanel onHandshakeRequested={handshakeReturned} />
  </Screen>;
  return (
    <Screen>
      <Heading>{copy.title}</Heading>
      {unconfirmedWrite ? <Button label={t('Refresh')} variant="secondary" disabled={busy !== null} onPress={() => void refreshView()} /> : null}
      {unconfirmedWrite && !notice ? <Body>{t(BUSINESS_SAVED_STALE)}</Body> : null}
      <Body muted>{copy.subtitle}</Body>
      {staff && <Button label={connectionTr('browseConnections')} variant="secondary" disabled={busy !== null || unconfirmedWrite} onPress={() => setShowConnections(true)} />}
      {error ? <Card><Body style={{ color: theme.destructive }}>{error}{items !== null ? copy.staleSuffix : ''}</Body><Button label={copy.refresh} onPress={() => { void refreshView(); }} /></Card> : null}
      {notice ? <Card><Body>{notice === BUSINESS_SAVED_STALE ? t(BUSINESS_SAVED_STALE) : notice === 'The change was saved.' ? t('The change was saved.') : notice}</Body></Card> : null}
      {admin ? <Card>
        <View style={styles.workChipRow}><Heading level={3}>{copy.bindingTitle}</Heading>{binding ? <StatusPill label={copy.status[binding.status]} state={binding.status === 'verified' ? 'done' : binding.status === 'rejected' ? 'attention' : 'queued'} /> : null}</View>
        <Body muted>{copy.bindingBody}</Body>
        {binding ? <Body>{binding.organizationName}{binding.publicNote ? ` · ${binding.publicNote}` : ''}</Body> : <Body muted>{copy.bindingEmpty}</Body>}
        {binding?.status !== 'verified' ? <>
          <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{copy.bindingSearchLabel}</Text>
          {organizationSearch.shown ? <>
          <TextInput accessibilityLabel={copy.bindingSearchLabel} keyboardAppearance={theme.appearance} editable={busy === null} value={organizationQuery} onChangeText={(value) => { organizationSearch.set({ query: value }); setOrganizationResults([]); setSelectedOrganizationID(''); setSearchOutcome(null); }} placeholder={copy.bindingSearchPlaceholder} placeholderTextColor={theme.quietForeground} style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} />
          <Button label={busy === 'organization-search' ? copy.bindingSearching : copy.bindingSearch} variant="secondary" disabled={busy !== null || !unionOrganizationSearchable(organizationQuery)} onPress={() => { void searchOrganizations(); }} />
          {shownSearchOutcome?.state === 'empty' ? <View accessibilityLiveRegion="polite"><Body muted>{copy.bindingSearchEmpty}</Body></View> : null}
          {shownSearchOutcome?.state === 'failed' ? <Notice>{copy.bindingSearchFailed}</Notice> : null}
          </> : null}
          {organizationResults.length ? <><Text style={[styles.fieldLabel, { color: theme.foreground }]}>{copy.bindingResults}</Text><View style={styles.wrap}>{organizationResults.map((organization) => <Pressable key={organization.id} accessibilityRole="radio" accessibilityState={{ selected: selectedOrganizationID === organization.id }} onPress={() => setSelectedOrganizationID(organization.id)} style={({ pressed }) => [styles.chip, { backgroundColor: selectedOrganizationID === organization.id ? theme.primary : theme.secondary, opacity: pressed ? 0.82 : 1 }]}><Text style={[styles.chipText, { color: selectedOrganizationID === organization.id ? theme.primaryForeground : theme.secondaryForeground }]}>{organization.name}{organization.location ? ` · ${organization.location}` : ''}</Text></Pressable>)}</View></> : null}
          <Button label={busy === 'binding-request' ? copy.bindingRequesting : copy.bindingRequest} disabled={busy !== null || !selectedOrganizationID} onPress={() => { void requestBinding(); }} />
        </> : null}
      </Card> : null}
      {savedWorkCheckFailed ? <SavedWorkCheckFailed fitWords /> : null}
      {staff && targets !== null && partnership.shown ? (
        targets.length > 0 ? <Button label={composing ? copy.cancelRequest : copy.startRequest} variant={composing ? 'secondary' : 'primary'} disabled={partnership.pending !== false} onPress={() => partnership.set((value) => ({ ...value, open: !value.open }))} />
          : <Card><Heading level={3}>{copy.noPartnersTitle}</Heading><Body muted>{copy.noPartnersBody}</Body></Card>
      ) : null}
      {staff && composing ? (
        <Card>
          <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{copy.partnerLabel}</Text>
          <View style={styles.wrap}>{(targets ?? []).map((target) => <Pressable key={target.id} accessibilityRole="button" accessibilityState={{ selected: partnerOrgID === target.id }} onPress={() => partnership.set({ partnerOrgID: target.id })} style={({ pressed }) => [styles.chip, { backgroundColor: partnerOrgID === target.id ? theme.primary : theme.secondary, opacity: pressed ? 0.82 : 1 }]}><Text style={[styles.chipText, { color: partnerOrgID === target.id ? theme.primaryForeground : theme.secondaryForeground }]}>{target.name}{target.location ? ` · ${target.location}` : ''}</Text></Pressable>)}</View>
          <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{copy.requestTitleLabel}</Text>
          <TextInput accessibilityLabel={copy.requestTitleA11y} keyboardAppearance={theme.appearance} maxLength={160} value={title} editable={!requestLocked} onChangeText={(value) => partnership.set({ title: value })} placeholder={copy.requestTitlePlaceholder} placeholderTextColor={theme.quietForeground} style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} />
          <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{copy.purposeLabel}</Text>
          <TextInput accessibilityLabel={copy.purposeA11y} keyboardAppearance={theme.appearance} multiline maxLength={4000} value={purpose} editable={!requestLocked} onChangeText={(value) => partnership.set({ purpose: value })} placeholder={copy.purposePlaceholder} placeholderTextColor={theme.quietForeground} style={[styles.input, styles.multiline, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} />
          <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{copy.dataBoundary}</Text>
          <View style={styles.wrap}>{(Object.keys(copy.scopes) as MobileHandshake['dataScope'][]).map((scope) => <Pressable key={scope} accessibilityRole="radio" accessibilityState={{ selected: dataScope === scope }} onPress={() => partnership.set({ dataScope: scope })} style={({ pressed }) => [styles.chip, { backgroundColor: dataScope === scope ? theme.primary : theme.secondary, opacity: pressed ? 0.82 : 1 }]}><Text style={[styles.chipText, { color: dataScope === scope ? theme.primaryForeground : theme.secondaryForeground }]}>{copy.scopes[scope]}</Text></Pressable>)}</View>
          {requestUncertain ? <Body accessibilityRole="alert">{t('We could not confirm this request was sent. Sending it again will not make a second request.')}</Body> : null}
          {partnership.failed === 'request' && !error ? <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{copy.requestError}</Body> : null}
          <Button label={busy === 'request' || partnership.pending === 'sending' ? copy.sending : requestUncertain ? t('Send again') : copy.send} disabled={busy !== null || partnership.pending === 'sending' || !partnerOrgID || !title.trim() || !purpose.trim()} onPress={() => { void sendRequest(); }} />
          {requestUncertain ? <Button label={t('Discard this request')} variant="secondary" disabled={busy !== null} onPress={() => partnership.discard()} /> : null}
        </Card>
      ) : null}
      {documents.length > 0 ? <Card><Heading level={3}>{copy.documentTitle}</Heading><Body muted>{copy.documentBody}</Body><View style={styles.wrap}>{documents.map((document) => <Pressable key={document.id} accessibilityRole="radio" accessibilityState={{ selected: selectedDocumentID === document.id }} onPress={() => setSelectedDocumentID(document.id)} style={({ pressed }) => [styles.chip, { backgroundColor: selectedDocumentID === document.id ? theme.primary : theme.secondary, opacity: pressed ? 0.82 : 1 }]}><Text style={[styles.chipText, { color: selectedDocumentID === document.id ? theme.primaryForeground : theme.secondaryForeground }]}>{document.title}</Text></Pressable>)}</View>{selectedDocumentID ? <Body muted>{copy.documentSelected(documents.find((document) => document.id === selectedDocumentID)?.title || '')}</Body> : null}</Card> : staff ? <Card><Heading level={3}>{copy.documentTitle}</Heading><Body muted>{copy.documentEmpty}</Body></Card> : null}
      {items === null && !error ? <StateMessage title={copy.loadingTitle} body={copy.loadingBody} /> : items !== null && items.length === 0 ? <StateMessage title={copy.emptyTitle} body={copy.emptyBody} /> : (items ?? []).map((item) => (
        <Card key={item.id}>
          <View style={styles.workChipRow}><Text style={[styles.eyebrow, { color: theme.primary }]}>{copy.directions[item.direction] ?? t('Unknown direction')}</Text><View style={[styles.liveStatus, { backgroundColor: theme.secondary }]}><Text style={[styles.liveStatusText, { color: theme.secondaryForeground }]}>{copy.agreementStates[item.status] ?? t('Unknown status')}</Text></View></View>
          <Heading level={3}>{item.title}</Heading><Body muted>{item.partnerName} · {copy.scopes[item.dataScope] ?? t('Unknown scope')}</Body><Body>{item.purpose}</Body>
          {confirming?.item.id === item.id ? (
            <View accessibilityRole="alert" accessibilityLiveRegion="assertive">
              <Heading level={3}>{confirming.action === 'decline' ? copy.confirmDeclineTitle(item.title) : copy.confirmCloseTitle(item.title)}</Heading>
              <Body muted>{confirming.action === 'decline' ? copy.confirmDeclineBody : copy.confirmCloseBody}</Body>
              <View style={styles.buttonPair}>
                <Button label={busy ? copy.working : confirming.action === 'decline' ? copy.confirmDecline : copy.confirmClose} variant="danger" disabled={busy !== null || unconfirmedWrite} onPress={() => { void transition(item, confirming.action); }} />
                <Button label={copy.cancel} variant="secondary" disabled={busy !== null || unconfirmedWrite} onPress={() => setConfirming(null)} />
              </View>
            </View>
          ) : (
            <>
              {staff && item.direction === 'incoming' && item.status === 'requested' ? <View style={styles.buttonPair}><Button label={busy ? copy.working : copy.accept} disabled={busy !== null || unconfirmedWrite} onPress={() => { void transition(item, 'accept'); }} /><Button label={copy.decline} variant="secondary" disabled={busy !== null || unconfirmedWrite} onPress={() => requestConfirmation(item, 'decline')} /></View> : null}
              {staff && item.direction === 'outgoing' && item.status === 'accepted' ? <Button label={busy ? copy.working : copy.activate} disabled={busy !== null || unconfirmedWrite} onPress={() => { void transition(item, 'countersign'); }} /> : null}
              {staff && item.status === 'active' && item.dataScope === 'docs_only' && selectedDocumentID ? <Button label={busy === `document:${item.id}` ? copy.sharingDocument : copy.shareDocument} disabled={busy !== null || unconfirmedWrite} onPress={() => { void shareDocument(item.id); }} /> : null}
              {staff && ['requested', 'accepted', 'active'].includes(item.status) ? <Button label={copy.close} variant="secondary" disabled={busy !== null || unconfirmedWrite} onPress={() => requestConfirmation(item, 'close')} /> : null}
            </>
          )}
        </Card>
      ))}
    </Screen>
  );
}

type HealthDriverDraft = Record<keyof MobileHealthDrivers, string>;

function emptyHealthDriverDraft(): HealthDriverDraft {
  return {
    participation: '',
    caseTimeliness: '',
    stewardCapacity: '',
    trainingCoverage: '',
    communicationReach: '',
    governanceReadiness: '',
  };
}

function healthDriverDraftFor(chapter: MobileHealthChapter, correction: boolean): HealthDriverDraft {
  if (!correction || !chapter.drivers) return emptyHealthDriverDraft();
  return Object.fromEntries(HEALTH_DRIVER_FIELDS.map(({ key }) => [key, String(chapter.drivers?.[key] ?? '')])) as HealthDriverDraft;
}

function healthDriversFromDraft(draft: HealthDriverDraft): MobileHealthDrivers | null {
  const entries = HEALTH_DRIVER_FIELDS.map(({ key }) => {
    const raw = draft[key].trim();
    const value = Number(raw);
    return [key, raw && Number.isInteger(value) && value >= 0 && value <= 100 ? value : null] as const;
  });
  return entries.some(([, value]) => value === null)
    ? null
    : Object.fromEntries(entries) as MobileHealthDrivers;
}

// Moves screen-reader focus once the target's native view exists.
function moveAccessibilityFocus(node: View | TextInput | null | undefined) {
  if (!node) return;
  requestAnimationFrame(() => AccessibilityInfo.sendAccessibilityEvent(node, 'focus'));
}

const COACHING_SUMMARY_MIN = 8;

//  pull request C (design R-9240D, row C): an open coaching entry and an
// open health measurement wait through a foreground session check on the
// shared draft hook (memory only), each with the chapter it was typed for.
// The organization kind keys them to the person, every role set, the hat and
// the organization, so an organization-wide leader with no chapter keeps them
// too; any confirmed chapter or organization change, sign-out, another
// account, MFA or an authoritative refusal of the portfolio read retires them,
// and nothing held shows until that read is back. A coaching entry inserts a
// new row with no key, so a save with no answer stays locked as unconfirmed
// (Save again, Cancel) until a deliberate tap. A measurement or correction
// save that may have committed (no answer, the deadline, or any error that
// does not prove it was refused before sending) is locked the same way, with
// Save again and Discard, and is never sent again on its own; only the
// writer's session refusal returns it editable ( round 1). A
// correction is typed against the latest snapshot: when that snapshot changed
// meanwhile, the measures stay, the form says so, and nothing is saved over
// it. Every save ends at the 20-second deadline.
type CoachingDraft = { chapter: string | null; summary: string; nextAction: string; attentionLevel: string };
const COACHING_EMPTY: CoachingDraft = { chapter: null, summary: '', nextAction: '', attentionLevel: 'support' };
const coachingSurface = defineRetainedSurface<Held<CoachingDraft>>('health-coaching');
type SnapshotDraft = { chapter: string | null; mode: 'new' | 'correct'; measuredOn: string; drivers: HealthDriverDraft; basis: string | null };
const SNAPSHOT_EMPTY: SnapshotDraft = { chapter: null, mode: 'new', measuredOn: '', drivers: emptyHealthDriverDraft(), basis: null };
const snapshotSurface = defineRetainedSurface<Held<SnapshotDraft>>('health-snapshot');
const snapshotBasis = (chapter: MobileHealthChapter) => JSON.stringify([chapter.measuredOn, chapter.revisedAt ?? chapter.recordedAt ?? null]);
const SNAPSHOT_FAILED = 'The health snapshot was not confirmed. Check the date, measures, and your leadership access.';
const COACHING_FAILED = 'The coaching note was not confirmed.';

export function LiveHealthFeature({ title, homeChapterFirst = false }: { title: string; homeChapterFirst?: boolean }) {
  const { catalogLabel, locale, t } = useNativeUi();
  const writer = useBusinessWriter();
  const theme = useTheme();
  const { dashboard, mode } = useApp();
  const chapterID = dashboard?.member.chapterID;
  const requests = useBusinessRequests(writer);
  const [chapters, setChapters] = useBusinessDraftState<MobileHealthChapter[] | null>(null);
  const [error, setError] = useBusinessDraftState<string | null>(null);
  const [notice, setNotice] = useBusinessDraftState<string | null>(null);
  const coaching = useRetainedDraft<CoachingDraft>({ surface: coachingSurface, item: 'coaching', empty: COACHING_EMPTY, fresh: chapters !== null, scope: 'organization' });
  const snapshot = useRetainedDraft<SnapshotDraft>({ surface: snapshotSurface, item: 'snapshot', empty: SNAPSHOT_EMPTY, fresh: chapters !== null, scope: 'organization' });
  const savedWorkCheckFailed = Boolean(chapters?.length) && (coaching.checkFailed || snapshot.checkFailed);
  const refusedDrafts = useRef((error: unknown) => { coaching.refused(error); snapshot.refused(error); });
  refusedDrafts.current = (error: unknown) => { coaching.refused(error); snapshot.refused(error); };
  // Nothing held shows while the session check or the portfolio read is out.
  const coachingChapter = coaching.shown ? coaching.value.chapter : null;
  const { summary, nextAction, attentionLevel } = coaching.value;
  const snapshotChapter = snapshot.shown ? snapshot.value.chapter : null;
  const snapshotMode = snapshot.value.mode;
  const measuredOn = snapshot.value.measuredOn;
  const driverDraft = snapshot.value.drivers;
  const coachingUncertain = coaching.pending === 'uncertain';
  const coachingLocked = coaching.pending !== false;
  const snapshotUncertain = snapshot.pending === 'uncertain';
  const healthHeld = coaching.pending !== false || snapshot.pending !== false;
  const setSummary = (value: string) => coaching.set({ summary: value });
  const setNextAction = (value: string) => coaching.set({ nextAction: value });
  const setAttentionLevel = (value: string) => coaching.set({ attentionLevel: value });
  const setMeasuredOn = (value: string) => snapshot.set({ measuredOn: value });
  const setDriverDraft = (update: (current: HealthDriverDraft) => HealthDriverDraft) => snapshot.set((current) => ({ ...current, drivers: update(current.drivers) }));
  // A correction typed against a snapshot that changed meanwhile.
  const snapshotTarget = chapters?.find((item) => item.chapterId === snapshotChapter);
  const snapshotStale = snapshotMode === 'correct' && snapshotTarget !== undefined && snapshot.value.basis !== snapshotBasis(snapshotTarget);
  const [busy, setBusy] = useBusinessState(false);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, false);
  const [refreshing, setRefreshing] = useBusinessState(false);
  // UX-UG-NATIVE-CHAPTER-HEALTH-COACHING-FORM-OPENS-OFF-SCREEN-UNLABELLED-20261109:
  // the coaching form opens under the chapter's actions with focus on its
  // first field, and Cancel hands focus back to Add coaching entry.
  const coachingSummaryRef = useRef<null | TextInput>(null);
  const coachingButtonRefs = useRef(new Map<string, View>());
  const coachingFocusReturn = useRef<string | null>(null);
  useEffect(() => {
    if (coachingChapter) {
      moveAccessibilityFocus(coachingSummaryRef.current);
      return;
    }
    const returnTo = coachingFocusReturn.current;
    coachingFocusReturn.current = null;
    if (returnTo) moveAccessibilityFocus(coachingButtonRefs.current.get(returnTo));
  }, [coachingChapter]);
  const readSequence = useRef(0);
  // A refresh says whether its read loaded, failed or was superseded; a failed
  // portfolio read no longer reads as a good one to a write's follow-up
  async function refresh(): Promise<RefreshResult> {
    const ticket = requests.capture();
    if (!ticket.isCurrent()) return 'superseded';
    const at = ++readSequence.current;
    const current = () => at === readSequence.current && ticket.isCurrent();
    setError(null);
    try {
      const next = await loadMobileHealthPortfolio();
      if (!current()) return 'superseded';
      setChapters(next); setNotice(previous => previous === BUSINESS_SAVED_STALE ? null : previous);
      return 'loaded';
    } catch (error) {
      if (!current()) return 'superseded';
      setError('Campaign health could not be refreshed through your leadership scope.');
      refusedDrafts.current(error);
      return 'failed';
    }
  }
  async function refreshView() {
    await operate(true, async () => {
      setRefreshing(true);
      try { const current = requests.capture().isCurrent;
      if (await checkBusinessContinuation(writer, current) === 'current') await refresh(); } finally { setRefreshing(false); }
    });
  }

  useEffect(() => { void refresh(); // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { readSequence.current += 1; };
  }, [chapterID, writer, requests]);
  function closeCoaching() {
    coaching.discard();
  }
  function cancelCoaching() {
    coachingFocusReturn.current = coachingChapter;
    closeCoaching();
  }
  // A health form whose save is in flight or unconfirmed keeps its text and
  // its lock: opening the other form is refused while it does, so a switch
  // never discards held work; only that form's own Discard (or a confirmed
  // save) releases it ( round 1).
  function openCoaching(nextChapterID: string) {
    if (healthHeld) return;
    snapshot.discard();
    coaching.set(() => ({ ...COACHING_EMPTY, chapter: nextChapterID }));
  }
  function openSnapshot(chapter: MobileHealthChapter, nextMode: 'new' | 'correct') {
    if (healthHeld) return;
    snapshot.set(() => ({
      chapter: chapter.chapterId, mode: nextMode,
      measuredOn: nextMode === 'correct' && chapter.measuredOn ? chapter.measuredOn : chapter.databaseDate,
      drivers: healthDriverDraftFor(chapter, nextMode === 'correct'), basis: snapshotBasis(chapter),
    }));
    closeCoaching();
  }
  function closeSnapshot() {
    snapshot.discard();
  }
  // A save that lands on a date already holding a snapshot replaces measures
  // other staff read, so it states its effect and confirms first, in either
  // form mode (audit MOB-ADVISOR-10, MOB-VP-10;  gate round 1).
  function confirmSaveSnapshot() {
    if (snapshotStale) return;
    const chapter = chapters?.find((item) => item.chapterId === snapshotChapter);
    const snapshotDate = snapshotMode === 'correct' ? chapter?.measuredOn : measuredOn;
    const overwrite = chapter && snapshotDate ? healthSnapshotOverwrite(chapter, snapshotDate) : null;
    if (!overwrite || !snapshotDate) { void saveSnapshot(); return; }
    Alert.alert(
      overwrite === 'replaces' ? 'Replace this snapshot?' : 'Save this back-dated snapshot?',
      healthSnapshotOverwriteMessage(overwrite, snapshotDate),
      [{ text: 'Keep editing', style: 'cancel' }, { text: snapshotMode === 'correct' ? 'Save correction' : 'Save snapshot', onPress: () => { void saveSnapshot(); } }],
    );
  }
  async function saveSnapshot() {
    await operate(true, async () => {
    const current = requests.capture().isCurrent;
    const selectedChapterID = snapshotChapter;
    if (!selectedChapterID || snapshotStale) return;
    const chapter = chapters?.find((item) => item.chapterId === selectedChapterID);
    const snapshotDate = snapshotMode === 'correct' ? chapter?.measuredOn : measuredOn;
    if (!chapter || !snapshotDate || !validHealthDate(snapshotDate, chapter.databaseDate)) return;
    if (!healthDriversFromDraft(driverDraft)) return;
    // Save again on an unconfirmed save: the first write is still unresolved.
    const retrying = snapshot.pending === 'uncertain';
    // One attempt at a time, held through an unmount and settled after it.
    const attempt = snapshot.begin();
    const drivers = attempt ? healthDriversFromDraft(attempt.value.drivers) : null;
    if (!attempt || !drivers) return;
     setError(null);
    try {
      await withReadDeadline(recordMobileHealthSnapshot(writer, selectedChapterID, snapshotDate, drivers));
      attempt.settle('done');
      await settleBusinessWrite(writer, { current,
        accepted: () => setNotice('The change was saved.'),
        stale: () => setNotice(BUSINESS_SAVED_STALE),
        refresh: async () => {
          const result = await refresh();
          if (result === 'loaded' && await checkBusinessContinuation(writer, current) === 'current') void haptics.success();
          return result !== 'failed';
        },
      });
    } catch (nextError) {
      // Only a refusal before sending is definite; anything else (no answer,
      // the deadline, a server error the service cannot tell apart) may have
      // saved, so the measures stay locked until a deliberate Save again or
      // Discard.
      const definite = sessionRefused(nextError);
      if (retrying) {
        // A refusal of Save again, even one made before sending, says nothing
        // about the first write, so the lock stays: only a confirmed save or
        // Discard releases it. The held attempt stays unknown (the shared
        // hook never turns an unknown outcome into a definite one), and the
        // refusal shows beside Save again and Discard ( final).
        attempt.settle(definite ? { failed: 'retry-refused' } : 'uncertain');
        return;
      }
      attempt.settle(definite ? { failed: 'snapshot' } : 'uncertain');
      if (definite) setError(nextError instanceof Error && !(nextError instanceof ReadDeadlineError) ? nextError.message : SNAPSHOT_FAILED);
    }

    });
  }
  async function saveCoaching() {
    await operate(true, async () => {
    const current = requests.capture().isCurrent;
    if (!coachingChapter || coaching.pending === 'sending') return;
    // One attempt at a time, held through an unmount and settled after it.
    const attempt = coaching.begin();
    const entry = attempt?.value;
    if (!attempt || !entry?.chapter) return;
     setError(null);
    try {
      await withReadDeadline(addMobileHealthCoaching(writer, entry.chapter, entry.summary, entry.nextAction, entry.attentionLevel));
      attempt.settle('done');
      await settleBusinessWrite(writer, { current,
        accepted: () => setNotice('The change was saved.'),
        stale: () => setNotice(BUSINESS_SAVED_STALE),
        refresh: async () => {
          const result = await refresh();
          if (result === 'loaded' && await checkBusinessContinuation(writer, current) === 'current') void haptics.success();
          return result !== 'failed';
        },
      });
    }
    catch (nextError) {
      // Only a refusal before sending is definite; anything else may have
      // added the entry, so it stays locked until a deliberate tap.
      const definite = sessionRefused(nextError);
      attempt.settle(definite ? { failed: 'coaching' } : 'uncertain');
      if (definite) setError(nextError instanceof Error ? nextError.message : COACHING_FAILED);
    }


    });
  }
  const portfolio = chapters ?? [];
  const homeChapter = homeChapterFirst && chapterID ? portfolio.find((chapter) => chapter.chapterId === chapterID) : undefined;
  const orderedPortfolio = homeChapter ? [homeChapter, ...portfolio.filter((chapter) => chapter !== homeChapter)] : portfolio;
  return (
    <Screen>
      <Heading>{catalogLabel(title)}</Heading>
      {notice ? <View accessibilityLiveRegion="polite"><Body>{t(notice === BUSINESS_SAVED_STALE ? BUSINESS_SAVED_STALE : 'The change was saved.')}</Body>{notice === BUSINESS_SAVED_STALE ? <Button label={t('Refresh')} disabled={busy} variant="secondary" onPress={() => void refreshView()} /> : null}</View> : null}
      <Body muted>Six observed measures describe how the campaign is doing, not what will happen next. Scores and comparisons stay hidden when a group does not meet the organization's privacy minimum.</Body>
      {error ? <Card><Body style={{ color: theme.destructive }}>{error}{chapters !== null ? ' Showing the last confirmed portfolio.' : ''}</Body><Button label="Try again" onPress={() => { void refreshView(); }} /></Card> : null}
      {savedWorkCheckFailed ? <SavedWorkCheckFailed fitWords retryLabel={error ? t('Check saved work again') : undefined} /> : null}
      {chapters === null && !error ? <StateMessage title="Loading campaign health" body="Loading campaign health for your role." /> : chapters !== null && chapters.length === 0 ? <StateMessage title="No campaign health to show" body="Campaign health is for advisors, admins, campaign leads, and organization Presidents. A campaign with no measures yet shows no score." /> : orderedPortfolio.map((chapter) => (
        <Card key={chapter.chapterId}>
          {/* A11Y-UG-NATIVE-CHAPTER-HEALTH-SCORE-CLIPPED-AT-LARGEST-TEXT-20261109:
              the score wraps below the chapter name when the two do not fit
              side by side, never past the card edge. */}
          <View style={styles.healthSummaryRow}><View style={styles.healthSummaryTitle}><Text style={[styles.eyebrow, { color: theme.primary }]}>SUMMARY · {deviceCalendarDay(chapter.measuredOn, locale) ?? t(chapter.measuredOn == null ? 'No measurement recorded' : 'Date unavailable')}</Text><Heading level={3}>{chapter.chapterName}</Heading></View>{chapter.score === null ? <View style={[styles.liveStatus, { backgroundColor: theme.muted }]}><Text style={[styles.liveStatusText, { color: theme.mutedForeground }]}>{chapter.measuredOn ? 'Hidden for a small group' : 'No measurement recorded'}</Text></View> : <View accessible accessibilityLabel={`Overall score ${chapter.score} out of 100`}><Text style={[styles.healthScore, { color: theme.primary }]}>{chapter.score}</Text><Text style={[styles.sparkDate, { color: theme.mutedForeground }]}>out of 100</Text></View>}</View>
          {/* A score with no scale could not be read (audit MOB-ADVISOR-10). */}
          {chapter.score !== null ? <Body muted>Overall score out of 100, summarizing the six measures below.</Body> : null}
          {chapter.recordedAt ? <Body muted>Recorded by {chapter.recordedBy ?? 'Former staff member'} · {deviceDateTime(chapter.recordedAt, locale) ?? t('time unavailable')}</Body> : null}
          {chapter.revisedAt ? <Body muted>Last revised by {chapter.revisedBy ?? 'Former staff member'} · {deviceDateTime(chapter.revisedAt, locale) ?? t('time unavailable')}</Body> : null}
          {chapter.drivers ? healthDriverRows(chapter.drivers).map(({ key, label, value }) => <View key={key} style={styles.driverRow}><Text style={[styles.driverLabel, { color: theme.foreground }]}>{label}</Text><View style={styles.driverMeter}><View style={[styles.driverTrack, { backgroundColor: theme.muted }]}><View style={[styles.driverFill, { width: `${Math.max(3, Math.min(100, value))}%`, backgroundColor: theme.primary }]} /></View><Text style={[styles.driverValue, { color: theme.mutedForeground }]}>{value}</Text></View></View>) : <Body muted>{chapter.measuredOn ? "Scores are hidden because this group does not meet the organization's privacy minimum." : 'No measurement has been recorded. Record a snapshot when observed measures are available; no score is assumed.'}</Body>}
          {chapter.trend.length ? <View><Heading level={3}>Score over time</Heading><ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator accessibilityLabel="Campaign health score history" contentContainerStyle={styles.sparkRow}>{chapter.trend.map((point) => {
            const day = deviceDay(point.measuredOn);
            const label = deviceCalendarDay(point.measuredOn, locale) ?? t('Date unavailable');
            const month = day ? day.toLocaleDateString(locale, { month: 'short', year: '2-digit' }) : label;
            return <View key={point.measuredOn} style={styles.sparkPoint} accessible accessibilityLabel={t('{date}, score {score}', { date: label, score: point.score })}><View style={[styles.sparkBar, { height: Math.max(10, point.score), backgroundColor: theme.primary }]} /><Text style={[styles.sparkDate, { color: theme.mutedForeground }]}>{month}</Text></View>;
          })}</ScrollView></View> : null}
          {snapshotChapter === chapter.chapterId ? <View style={styles.coachingForm}>
            <Heading level={3}>{snapshotMode === 'correct' ? 'Correct latest snapshot' : 'Record snapshot'}</Heading>
            <Body muted>{snapshotMode === 'correct' ? 'The latest snapshot date stays fixed. Update its six observed measures from 0 to 100.' : 'Enter six observed measures from 0 to 100. Saving a date already shown records an attributed correction.'}</Body>
            <Text style={[styles.fieldLabel, { color: theme.foreground }]}>Measured date</Text>
            <TextInput accessibilityLabel={snapshotMode === 'correct' ? 'Latest measured date, read only' : 'Measured date, year month day'} accessibilityState={{ disabled: snapshotMode === 'correct' }} editable={snapshotMode !== 'correct'} keyboardAppearance={theme.appearance} autoCapitalize="none" maxLength={10} value={measuredOn} onChangeText={setMeasuredOn} placeholder="YYYY-MM-DD" placeholderTextColor={theme.quietForeground} style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} />
            {HEALTH_DRIVER_FIELDS.map((field) => <View key={field.key} style={styles.healthDriverInputRow}>
              <Text style={[styles.healthDriverInputLabel, { color: theme.foreground }]}>{field.label}</Text>
              <TextInput accessibilityLabel={`${field.label}, 0 to 100`} keyboardAppearance={theme.appearance} keyboardType="number-pad" inputMode="numeric" maxLength={3} selectTextOnFocus editable={snapshot.pending === false} value={driverDraft[field.key]} onChangeText={(value) => setDriverDraft((current) => ({ ...current, [field.key]: value.replace(/[^0-9]/g, '').slice(0, 3) }))} placeholder="0–100" placeholderTextColor={theme.quietForeground} style={[styles.healthDriverInput, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} />
            </View>)}
            <Body muted>Use a real date no later than {chapter.databaseDate} and whole-number measures.</Body>
            {snapshotStale ? <Body accessibilityRole="alert">{t('This snapshot changed while you were away. Your measures are kept here; cancel to start from the new snapshot.')}</Body> : null}
            {snapshotUncertain ? <Body accessibilityRole="alert">{t('We could not confirm these measures were saved. Check the campaign’s latest snapshot first: saving again replaces the snapshot for that date.')}</Body> : null}
            {snapshotUncertain && snapshot.failed === 'retry-refused' ? <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{t('Save again was refused before it was sent. The first save is still unconfirmed, so the measures stay locked.')}</Body> : null}
            {snapshot.failed === 'snapshot' && !error ? <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{SNAPSHOT_FAILED}</Body> : null}
            <Button label={busy || snapshot.pending === 'sending' ? 'Saving…' : snapshotUncertain ? t('Save again') : snapshotMode === 'correct' ? 'Save correction' : 'Save snapshot'} disabled={busy || snapshotStale || snapshot.pending === 'sending' || !validHealthDate(snapshotMode === 'correct' ? chapter.measuredOn ?? '' : measuredOn, chapter.databaseDate) || !healthDriversFromDraft(driverDraft)} onPress={confirmSaveSnapshot} />
            <Button label={snapshotUncertain ? t('Discard') : 'Cancel'} variant="secondary" disabled={busy || snapshot.pending === 'sending'} onPress={closeSnapshot} />
          </View> : savedWorkCheckFailed ? null : <View style={styles.buttonPair}>
            <Button label="Record snapshot" disabled={busy || healthHeld} onPress={() => openSnapshot(chapter, 'new')} />
            {chapter.measuredOn ? <Button label="Correct latest snapshot" variant="secondary" disabled={busy || healthHeld} onPress={() => openSnapshot(chapter, 'correct')} /> : null}
            <Button label="Add coaching entry" variant="secondary" disabled={busy || healthHeld} focusRef={(node) => { if (node) coachingButtonRefs.current.set(chapter.chapterId, node); else coachingButtonRefs.current.delete(chapter.chapterId); }} onPress={() => openCoaching(chapter.chapterId)} />
          </View>}
          {coachingChapter === chapter.chapterId ? <View style={styles.coachingForm}>
            <Heading level={3}>Add coaching entry</Heading>
            <Text style={[styles.fieldLabel, { color: theme.foreground }]}>Coaching summary</Text>
            <Body muted>Non-sensitive support context, at least {COACHING_SUMMARY_MIN} characters.</Body>
            <TextInput ref={coachingSummaryRef} accessibilityLabel="Coaching summary" accessibilityHint={`Non-sensitive support context, at least ${COACHING_SUMMARY_MIN} characters.`} keyboardAppearance={theme.appearance} multiline maxLength={1000} editable={!coachingLocked} value={summary} onChangeText={setSummary} style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} />
            <Text style={[styles.fieldLabel, { color: theme.foreground }]}>Next authorized action (optional)</Text>
            <TextInput accessibilityLabel="Next authorized action, optional" keyboardAppearance={theme.appearance} maxLength={500} editable={!coachingLocked} value={nextAction} onChangeText={setNextAction} style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]} />
            <Text style={[styles.fieldLabel, { color: theme.foreground }]}>Attention level</Text>
            <View style={styles.wrap} accessibilityRole="radiogroup">{['watch', 'support', 'urgent', 'resolved'].map((level) => <Pressable key={level} accessibilityRole="radio" accessibilityState={{ selected: attentionLevel === level }} onPress={() => setAttentionLevel(level)} style={({ pressed }) => [styles.chip, { backgroundColor: attentionLevel === level ? theme.primary : theme.secondary, opacity: pressed ? 0.82 : 1 }]}><Text style={[styles.chipText, { color: attentionLevel === level ? theme.primaryForeground : theme.secondaryForeground }]}>{level}</Text></Pressable>)}</View>
            {coachingUncertain ? <Body accessibilityRole="alert">{t('We could not confirm this coaching entry was saved. Check the campaign’s coaching notes first: saving it again may add it twice.')}</Body> : null}
            {coaching.failed === 'coaching' && !error ? <Body accessibilityRole="alert" style={{ color: theme.destructive }}>{COACHING_FAILED}</Body> : null}
            <Button label={busy || coaching.pending === 'sending' ? 'Saving…' : coachingUncertain ? t('Save again') : 'Save coaching entry'} disabled={busy || coaching.pending === 'sending' || summary.trim().length < COACHING_SUMMARY_MIN} onPress={() => { void saveCoaching(); }} />
            <Button label="Cancel" variant="secondary" disabled={busy || coaching.pending === 'sending'} onPress={cancelCoaching} />
          </View> : null}
          {chapter.coaching.map((note) => <View key={note.id} style={[styles.coachingNote, { borderColor: theme.border }]}><Text style={[styles.timelineAction, { color: theme.foreground }]}>{note.attentionLevel}</Text><Body>{note.summary}</Body>{note.nextAction ? <Body muted>Next: {note.nextAction}</Body> : null}<Body muted>{note.authorName ? `${note.authorName} · ` : ''}{deviceDateTime(note.createdAt, locale) ?? t('time unavailable')}</Body></View>)}
        </Card>
      ))}
    </Screen>
  );
}

function previewHealthPortfolio(): MobileHealthChapter[] {
  return PREVIEW_HEALTH_PORTFOLIO.map((chapter) => ({
    ...chapter,
    databaseDate: utcHealthDate(),
    drivers: chapter.drivers ? { ...chapter.drivers } : null,
    trend: chapter.trend.map((point) => ({ ...point })),
    coaching: chapter.coaching.map((note) => ({ ...note })),
  }));
}

function VotingFeature() {
  const theme = useTheme();
  const { previewDesk } = useApp();
  const [receipts, setReceipts] = useState<Record<string, string>>({});
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [verifyCode, setVerifyCode] = useState('');
  const [verifyResult, setVerifyResult] = useState<{ code: string; ballotTitle: string | null } | null>(null);
  const ballots = previewDesk?.ballots ?? [];

  function cast(id: string) {
    const selected = choice[id];
    if (!selected) return;
    // A receipt proves inclusion only. Its value must carry no ballot or
    // selection-derived fragment that could disclose how the worker voted.
    setReceipts((current) => ({ ...current, [id]: `PSG-${Crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}` }));
  }

  function verifyReceipt() {
    const code = verifyCode.trim().toUpperCase();
    if (!code) return;
    // A ballot's meta line carries its published receipt (e.g. "receipt K7TQ2MRX");
    // session receipts cover ballots cast on this device.
    const known: { code: string; ballotTitle: string | null }[] = [
      ...Object.entries(receipts).map(([id, value]) => ({ code: value.toUpperCase(), ballotTitle: ballots.find((ballot) => ballot.id === id)?.title ?? null })),
      ...ballots.flatMap((ballot) => {
        const published = /receipt ([A-Z0-9-]{6,})/i.exec(ballot.meta)?.[1];
        return published ? [{ code: published.toUpperCase(), ballotTitle: ballot.title }] : [];
      }),
    ];
    const match = known.find((entry) => entry.code === code);
    setVerifyResult(match ?? { code, ballotTitle: null });
    void (match ? haptics.success() : haptics.warning());
  }

  return (
    <Screen>
      <NativeFeatureGuide feature="ballots" />
      <Heading>Votes</Heading>
      <Body muted>{BALLOT_STORAGE_SENTENCE}</Body>
      {ballots.length === 0 ? <StateMessage title="No votes" body="Open campaign votes will appear here." /> : ballots.map((ballot) => (
        <BallotCard
          key={ballot.id}
          ballot={ballot}
          receipt={receipts[ballot.id]}
          choice={choice[ballot.id]}
          onChoose={(option) => setChoice((current) => ({ ...current, [ballot.id]: option }))}
          onCast={() => cast(ballot.id)}
        />
      ))}
      <Card>
        <Heading level={3}>Verify a receipt</Heading>
        <Body muted>Confirm a vote receipt code. Verification never shows how the vote was cast.</Body>
        <TextInput
          accessibilityLabel="Receipt code"
          autoCapitalize="characters"
          autoCorrect={false}
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={verifyCode}
          onChangeText={(value) => { setVerifyCode(value); setVerifyResult(null); }}
          placeholder="K7TQ2MRX"
          placeholderTextColor={theme.mutedForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        <Button label="Verify receipt" disabled={!verifyCode.trim()} onPress={verifyReceipt} />
        {verifyResult ? (
          verifyResult.ballotTitle ? (
            <Body>Receipt {verifyResult.code} is valid for “{verifyResult.ballotTitle}”. The vote itself stays secret.</Body>
          ) : (
            <Body muted>No vote on this device matches {verifyResult.code}. Check the code and try again.</Body>
          )
        ) : null}
      </Card>
    </Screen>
  );
}

// One ballot is one transactional control, so the card is its own component:
// the shared primitive holds the busy state of the button that was pressed,
// not of every ballot on the screen.
function BallotCard({ ballot, receipt, choice, onChoose, onCast }: {
  ballot: PreviewBallot;
  receipt: string | undefined;
  choice: string | undefined;
  onChoose: (option: string) => void;
  onCast: () => void;
}) {
  const theme = useTheme();
  const cast = useTransactionalAction(onCast);
  const { open, label, options, canCast } = previewBallotCardState(ballot);
  return (
    <Card>
      <Text style={[styles.eyebrow, { color: theme.primary }]}>{label}</Text>
      <Heading level={3}>{ballot.title}</Heading>
      <Body muted>{ballot.meta}</Body>
      {receipt ? (
        // Same receipt sentence as before; the primitive only standardises how
        // it arrives — and a receipt already on the record at mount is not an
        // arrival, so it renders without motion.
        <TransactionalConfirmation
          enabled={cast.done}
          message={`Recorded. Receipt ${receipt}. ${BALLOT_RECEIPT_SENTENCE}`}
        />
      ) : options.map((option) => (
        <Pressable
          key={option}
          accessibilityRole="radio"
          accessibilityState={{ selected: choice === option }}
          onPress={() => onChoose(option)}
          style={({ pressed }) => [styles.choice, {
            borderColor: choice === option ? theme.primary : theme.muted,
            backgroundColor: choice === option ? theme.secondary : theme.muted,
            opacity: pressed ? 0.82 : 1,
          }]}
        >
          <Text style={[styles.choiceLabel, { color: theme.cardForeground }]}>{option}</Text>
        </Pressable>
      ))}
      {!receipt && canCast
        ? <TransactionalButton label="Cast secret vote" action={cast} disabled={!choice} />
        : null}
    </Card>
  );
}

function FormsFeature() {
  const theme = useTheme();
  const { previewDesk, duesContext } = useApp();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const [submitted, setSubmitted] = useState<string[]>([]);
  const [lastSubmitted, setLastSubmitted] = useState<string | null>(null);
  const template = FORM_TEMPLATES.find((item) => item.key === openKey);
  const submit = useTransactionalAction(() => {
    if (!template) return;
    setSubmitted((current) => [template.title, ...current]);
    setLastSubmitted(template.title);
    setSummary('');
    setOpenKey(null);
  });

  if (template) {
    return (
      <Screen>
        <Heading>{template.title}</Heading>
        <Body muted>{formTemplateBlurb(template, duesContext?.runsDues)} Drafts stay in this app. Do not put medical diagnoses or Social Security numbers in the summary.</Body>
        {healthNoticeFor(template.key).map((text) => (
          <Body key={text}>{text}</Body>
        ))}
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>What happened</Text>
        <TextInput
          accessibilityLabel="What happened"
          value={summary}
          onChangeText={setSummary}
          multiline
          maxLength={400}
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          placeholder="Short authorized summary"
          placeholderTextColor={theme.mutedForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        <TransactionalButton label="Submit for committee review" action={submit} disabled={summary.trim().length < 8} />
        <Button label="Back to forms" variant="secondary" onPress={() => setOpenKey(null)} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Heading>Forms</Heading>
      <Body muted>Choose from seven campaign templates. Start or resume them here.</Body>
      {(previewDesk?.forms ?? []).map((item) => (
        <Card key={item.id}>
          <Heading level={3}>{item.title}</Heading>
          <Body muted>{item.status} · updated {item.updated}</Body>
        </Card>
      ))}
      {/* The submitted card is unchanged; the newest one animates in with the
          shared entrance instead of appearing between two frames, and speaks
          its own three lines once so VoiceOver hears the arrival it cannot
          see. The words are the card's, not new copy. */}
      {submitted.map((title) => (
        <TransactionalReveal
          key={title}
          enabled={title === lastSubmitted}
          announce={`Submitted. ${title}. In review with the committee.`}
        >
          <Card>
            <Text style={[styles.eyebrow, { color: theme.primary }]}>Submitted</Text>
            <Heading level={3}>{title}</Heading>
            <Body muted>In review with the committee.</Body>
          </Card>
        </TransactionalReveal>
      ))}
      <Heading level={2}>Start a form</Heading>
      {FORM_TEMPLATES.map((item) => (
        <Pressable key={item.key} accessibilityRole="button" accessibilityLabel={item.title} onPress={() => { void haptics.select(); setOpenKey(item.key); }}>
          {({ pressed }) => (
            <Card style={{ opacity: pressed ? 0.82 : 1 }}>
              <Heading level={3}>{item.title}</Heading>
              <Body muted>{formTemplateBlurb(item, duesContext?.runsDues)}</Body>
            </Card>
          )}
        </Pressable>
      ))}
    </Screen>
  );
}

function WorkloadFeature() {
  const theme = useTheme();
  const { previewDesk } = useApp();
  const [hours, setHours] = useState('8');
  const [note, setNote] = useState('');
  const [entries, setEntries] = useState(previewDesk?.workload ?? []);
  const [loggedID, setLoggedID] = useState<string | null>(null);
  const log = useTransactionalAction(() => {
    const id = `wl-${Date.now()}`;
    setEntries((current) => [{
      id,
      dateLabel: 'Today',
      meta: `${hours.trim()} hrs · ${note.trim() || 'shift logged'}`,
    }, ...current]);
    setLoggedID(id);
    setNote('');
  });

  return (
    <Screen>
      <Heading>Workplace log</Heading>
      <Body muted>A short self-report. Individual entries stay on your record. Collective stats only appear when enough coworkers have logged.</Body>
      <Text style={[styles.fieldLabel, { color: theme.foreground }]}>Hours today</Text>
      <TextInput accessibilityLabel="Hours today" keyboardType="decimal-pad" keyboardAppearance={theme.appearance} selectionColor={theme.primary} value={hours} onChangeText={setHours} style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]} />
      <Text style={[styles.fieldLabel, { color: theme.foreground }]}>What drove the load</Text>
      <TextInput accessibilityLabel="What drove the load" keyboardAppearance={theme.appearance} selectionColor={theme.primary} value={note} onChangeText={setNote} placeholder="Overnight ward, one mandate" placeholderTextColor={theme.mutedForeground} style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]} />
      {/* Batch C copy register 28: guidance under the field. The register's
          visibility sentence is left out: this log is not stored by the
          service, so who can read entries cannot be confirmed. */}
      <Body muted>Describe the work, not the people. Leave out names and health details.</Body>
      <TransactionalButton label="Log this shift" action={log} disabled={!hours.trim()} />
      <Heading level={2}>Your history</Heading>
      {/* The prepended Today row is the confirmation for this flow, so it is
          the figure that animates in. Rows already in the history do not. */}
      {entries.map((item) => (
        <TransactionalReveal
          key={item.id}
          enabled={item.id === loggedID}
          // The row's own words, with the interpunct spoken as the pause it
          // draws: VoiceOver reads "·" as nothing at all on some voices and as
          // "middle dot" on others, so the announcement takes a comma while
          // the printed row keeps the separator.
          announce={`${item.dateLabel}. ${item.meta.split(' · ').join(', ')}`}
        >
          <Card>
            <Heading level={3}>{item.dateLabel}</Heading>
            <Body muted>{item.meta}</Body>
          </Card>
        </TransactionalReveal>
      ))}
      <Card>
        <Heading level={3}>Campaign stats</Heading>
        <Body muted>Enough coworkers have logged this week to show a privacy-safe summary: typical shift 8.0 hrs, 90th-percentile shift 12.0 hrs. Exact contributor counts are not shown.</Body>
      </Card>
    </Screen>
  );
}

// iaa-16's sentence, named once so the visible line and the iOS announcement
// can never drift into two different explanations of the same rule.
const BE_HEARD_CONDITION = 'Choose a topic and add a few words to send.';

function VoiceFeature() {
  const theme = useTheme();
  const queueAnnouncement = useAccessibilityAnnouncementQueue('voice-feedback');
  // b04b: the topic row was five buttons with one pre-filled — the worker's
  // report was filed under "App feedback" unless they noticed and changed it.
  // It is a radiogroup now, it starts with nothing chosen, and sending waits
  // for a real choice as well as the existing length rule.
  const [topic, setTopic] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [sent, setSent] = useState<string[]>([]);
  const topics = ['App feedback', 'Committee request', 'Safety', 'Access barrier', 'Other'];
  const unmet = topic === null || body.trim().length < 8;

  //  follow-up 5. `accessibilityLiveRegion` is Android-only, so the
  // iaa-16 condition line was visible on iOS and inaudible there — a worker on
  // VoiceOver pressed an inert Send and was told nothing about why. It speaks
  // through the shared announcement path the transactional receipts use.
  //
  // iab F9: reacting to the `unmet` state fired on *every* re-entry into it,
  // so a worker backspacing across the 8-character boundary heard the sentence
  // spoken over VoiceOver's own echo of the character they had just deleted.
  // The transition this always meant is the one the send performs — the form
  // resets and the control goes inert again under the worker's finger, with
  // nothing else on screen to report it — so the announcement is issued from
  // the send handler below, exactly once. The visible line stays reactive.

  return (
    <Screen>
      <Heading>Be heard</Heading>
      <Body muted>Send campaign feedback, a committee request, or an access barrier report without leaving the app.</Body>
      {/* iaa-17: a visible group label so five single-select chips cannot read
          as filters; VoiceOver already had the group name, sighted workers
          did not. */}
      <Text style={[styles.fieldLabel, { color: theme.foreground }]}>Choose one topic</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="Topic" style={styles.wrap}>
        {topics.map((item) => (
          <Pressable
            key={item}
            accessibilityRole="radio"
            accessibilityLabel={item}
            accessibilityState={{ selected: topic === item, checked: topic === item }}
            onPress={() => setTopic(item)}
            style={({ pressed }) => [styles.chip, {
              backgroundColor: topic === item ? theme.primary : theme.secondary,
              opacity: pressed ? 0.82 : 1,
            }]}
          >
            <Text style={[styles.chipText, { color: topic === item ? theme.primaryForeground : theme.secondaryForeground }]}>{item}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        accessibilityLabel="Your message"
        multiline
        maxLength={800}
        keyboardAppearance={theme.appearance}
        selectionColor={theme.primary}
        value={body}
        onChangeText={setBody}
        placeholder="What should the campaign know?"
        placeholderTextColor={theme.mutedForeground}
        style={[styles.input, styles.multiline, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
      />
      <Button
        label="Send to the campaign"
        disabled={unmet}
        onPress={() => {
          if (topic === null) return;
          setSent((current) => [`${topic}: ${body.trim()}`, ...current]);
          setBody('');
          // The previous topic must not become the next report's silent
          // default — that is b04b's filed defect wearing a worker-chosen
          // hat instead of a vendor-chosen one.
          setTopic(null);
          void haptics.success();
          // The one transition worth speaking: the control the worker's finger
          // is still on has just gone inert again, and on iOS the live region
          // below does nothing at all.
          queueAnnouncement(BE_HEARD_CONDITION);
        }}
      />
      {/* iaa-16: the inert control must say why it is inert — on screen, not
          behind a tap. The line clears the moment both conditions are met.
          The Android live region stays; iOS is served by the announcement
          above, because the attribute does nothing at all there. */}
      {unmet ? (
        <View accessibilityLiveRegion="polite">
          <Body muted>{BE_HEARD_CONDITION}</Body>
        </View>
      ) : null}
      {/* b04b: "Received" claimed an act the campaign had not performed — the
          app only knows the message left this device. The state word is now
          "Sent", and the reply expectation is set once, here, rather than
          implied by an echo card. */}
      <Body muted>Sent messages reach the campaign inbox. A committee member reads them; a reply is not guaranteed.</Body>
      {sent.map((item) => (
        <Card key={item}>
          <Text style={[styles.eyebrow, { color: theme.primary }]}>Sent</Text>
          <Body>{item}</Body>
        </Card>
      ))}
    </Screen>
  );
}

// b04b: the pre-query screen dumped eight arbitrary rows and called them
// nothing, so the empty state read as a result set. The haystack is scoped
// instead — one scope chip row over the same authorized rows, the pre-query
// list capped at three and labelled as recents, and a count header once a
// query is running.
const SEARCH_SCOPES = [
  { key: 'all', label: 'All' },
  { key: 'cases', label: 'Issues' },
  { key: 'forms', label: 'Forms' },
  { key: 'events', label: 'Meetings' },
  { key: 'rights', label: 'Rights' },
  { key: 'ballots', label: 'Votes' },
] as const;
type SearchScope = (typeof SEARCH_SCOPES)[number]['key'];
const SEARCH_RECENTS_CAP = 3;

function SearchFeature() {
  const theme = useTheme();
  const router = useRouter();
  const { dashboard, previewDesk } = useApp();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<SearchScope>('all');
  const haystack = useMemo(() => {
    const rows: { id: string; scope: Exclude<SearchScope, 'all'>; title: string; body: string; href?: string }[] = [];
    for (const item of dashboard?.cases ?? []) rows.push({ id: item.id, scope: 'cases', title: `${item.reference} · ${item.title}`, body: `${item.caseType} · ${memberCaseStep(item)}`, href: `/issue/${item.id}` });
    for (const item of previewDesk?.events ?? []) rows.push({ id: item.id, scope: 'events', title: item.title, body: `${item.when} · ${item.place}` });
    for (const item of previewDesk?.forms ?? []) rows.push({ id: item.id, scope: 'forms', title: item.title, body: item.status });
    for (const item of previewDesk?.lessons ?? []) rows.push({ id: item.id, scope: 'rights', title: item.title, body: item.summary });
    for (const item of previewDesk?.ballots ?? []) rows.push({ id: item.id, scope: 'ballots', title: item.title, body: item.meta });
    return rows;
  }, [dashboard, previewDesk]);
  const needle = query.trim().toLowerCase();
  const scoped = scope === 'all' ? haystack : haystack.filter((item) => item.scope === scope);
  const results = needle
    ? scoped.filter((item) => `${item.title} ${item.body}`.toLowerCase().includes(needle))
    : scoped.slice(0, SEARCH_RECENTS_CAP);

  return (
    <Screen>
      <Heading>Search</Heading>
      <Body muted>Search your authorized issues, forms, meetings, rights lessons, and votes in this app.</Body>
      <TextInput
        accessibilityLabel="Search"
        keyboardAppearance={theme.appearance}
        selectionColor={theme.primary}
        returnKeyType="search"
        value={query}
        onChangeText={setQuery}
        placeholder="Overtime, HCU-104, vote…"
        placeholderTextColor={theme.mutedForeground}
        style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
      />
      <View accessibilityRole="radiogroup" accessibilityLabel="Search scope" style={styles.wrap}>
        {SEARCH_SCOPES.map((item) => (
          <Pressable
            key={item.key}
            accessibilityRole="radio"
            accessibilityLabel={item.label}
            accessibilityState={{ selected: scope === item.key, checked: scope === item.key }}
            onPress={() => { void haptics.select(); setScope(item.key); }}
            style={({ pressed }) => [styles.chip, {
              backgroundColor: scope === item.key ? theme.primary : theme.secondary,
              opacity: pressed ? 0.82 : 1,
            }]}
          >
            <Text style={[styles.chipText, { color: scope === item.key ? theme.primaryForeground : theme.secondaryForeground }]}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
      {/*  follow-up 3: the pre-query list is capped, so on a scope holding
          more than the cap the header said "In this scope" over a list that was
          silently three of nine — the worker had no way to know the rest
          existed, or that typing would reach them. The header states the
          truncation whenever it is truncating, and stays the plain scope label
          when the whole scope is on screen. */}
      <Text accessibilityRole="header" style={[styles.eyebrow, { color: theme.mutedForeground }]}>
        {needle
          ? `${results.length} ${results.length === 1 ? 'result' : 'results'}`
          : results.length < scoped.length
            ? `Showing ${results.length} of ${scoped.length}`
            : 'In this scope'}
      </Text>
      {results.length === 0 ? <StateMessage title="No authorized matches" body="Try another word from an issue, form, or rights lesson you can already see." /> : results.map((item) => {
        const row = presentSearchRow(item);
        if (row.kind === 'pressable') {
          return (
            <Pressable
              key={item.id}
              accessibilityRole={row.accessibilityRole}
              accessibilityLabel={row.accessibilityLabel}
              onPress={() => { void haptics.select(); pressSearchRow(row, (href) => { router.push(href as never); }); }}
            >
              {({ pressed }) => (
                <Card style={{ opacity: pressed ? 0.82 : 1 }}>
                  <Heading level={3}>{item.title}</Heading>
                  <Body muted>{item.body}</Body>
                </Card>
              )}
            </Pressable>
          );
        }
        return (
          <View key={item.id} accessible accessibilityRole={row.accessibilityRole} accessibilityLabel={row.accessibilityLabel}>
            <Card>
              <Heading level={3}>{item.title}</Heading>
              <Body muted>{item.body}</Body>
            </Card>
          </View>
        );
      })}
    </Screen>
  );
}

function CasesFeature() {
  const { catalogLabel } = useNativeUi();
  const router = useRouter();
  const theme = useTheme();
  const { dashboard } = useApp();
  const cases = casesByDeadline(dashboard?.cases ?? []);
  return (
    <Screen>
      <Heading>{catalogLabel('My issues')}</Heading>
      <Body muted>The workplace issues you can open.</Body>
      {cases.length === 0 ? <StateMessage title="No issues" body="Active issues will appear here." /> : cases.map((item) => {
        const due = caseDueLine(item, new Date());
        const line = `${item.caseType} · ${memberCaseStep(item)}${due ? ` · ${due}` : ''}`;
        return (
          <CaseRowPressable key={item.id} reference={item.reference} visible={[item.title, line]} onPress={() => { void haptics.select(); router.push(`/issue/${item.id}`); }}>
            {({ pressed }) => (
              <Card style={{ opacity: pressed ? 0.82 : 1 }}>
                <Text style={[styles.eyebrow, { color: theme.primary }]}>{item.reference}</Text>
                <Heading level={3}>{item.title}</Heading>
                <Body muted>{line}</Body>
              </Card>
            )}
          </CaseRowPressable>
        );
      })}
    </Screen>
  );
}

function AppointmentsFeature() {
  const theme = useTheme();
  const { previewDesk } = useApp();
  const [requested, setRequested] = useState(false);
  return (
    <Screen>
      <Heading>One-on-ones</Heading>
      <Body muted>Office hours and one-on-ones with the committee stay on this calendar.</Body>
      {(previewDesk?.appointments ?? []).map((item) => (
        <Card key={item.id}>
          <Text style={[styles.eyebrow, { color: theme.primary }]}>{item.type}</Text>
          <Heading level={3}>{item.withName}</Heading>
          <Body muted>{item.when} · {item.place}</Body>
          <Body>{item.status}</Body>
        </Card>
      ))}
      {requested ? (
        <Card>
          <Heading level={3}>Office hours requested</Heading>
          <Body muted>Thursday · next open committee slot. Sam Okafor will confirm in Messages.</Body>
        </Card>
      ) : (
        <Button label="Request office hours" onPress={() => { setRequested(true); void haptics.success(); }} />
      )}
    </Screen>
  );
}

function StewardAppointmentsFeature() {
  const theme = useTheme();
  const { previewDesk } = useApp();
  const appointments = previewDesk?.appointments ?? [];
  return (
    <Screen>
      <Heading>One-on-one desk</Heading>
      <Body muted>The committee-side one-on-one desk — the same records the One-on-ones work row counts — separate from your own worker list.</Body>
      {appointments.length === 0 ? (
        <StateMessage title="No one-on-ones" body="Booked worker one-on-ones will appear here." />
      ) : appointments.map((item) => (
        <Card key={item.id}>
          <Text style={[styles.eyebrow, { color: theme.primary }]}>{item.type}</Text>
          <Heading level={3}>{item.withName}</Heading>
          <Body muted>{item.when} · {item.place}</Body>
          <Body>{item.status}</Body>
        </Card>
      ))}
    </Screen>
  );
}

// b04b: Rights shipped as five stacked cards, so the script a worker needs on
// the floor was always somewhere in the middle of a scroll. It is a reading
// list now — 64px index rows open one lesson at a time — and the reading view
// sets the script at reading measure with the two affordances the floor
// actually needs: take it with you, or make it bigger.
const RIGHTS_SCRIPT_SIZE = 17;
const RIGHTS_SCRIPT_LARGE_SIZE = 22;
//  follow-up 6. "Read large" is a manual 22/17 step, and Dynamic Type
// applies its own multiplier on top of it, so at an accessibility step the
// script scaled twice and a 17px reading measure arrived past 60px — one or two
// words a line on the exact screen a worker is holding on the shop floor. The
// two multipliers are capped to the same ceiling instead: at the cap the script
// reads at 34px whether the worker got there through the system or through the
// button, so the button is a shortcut to the ceiling and never a doubling of it.
const RIGHTS_SCRIPT_MAX_SCALE = 2;
const RIGHTS_SCRIPT_LARGE_MAX_SCALE = (RIGHTS_SCRIPT_MAX_SCALE * RIGHTS_SCRIPT_SIZE) / RIGHTS_SCRIPT_LARGE_SIZE;

function RightsFeature({ sourceID }: { sourceID?: string }) {
  const { t, locale } = useNativeUi();
  const theme = useTheme();
  const { previewDesk } = useApp();
  const lessons = previewDesk?.lessons ?? [];
  const initialLesson = lessons.find((item) => compassSourceMatchesReaderRecord(sourceID, 'rights', item.id));
  const [openID, setOpenID] = useState<string | null>(initialLesson?.id ?? null);
  const [sourceDismissed, setSourceDismissed] = useState(false);
  const [readLarge, setReadLarge] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  // REQ-UG-QUOTES-MINI-LESSONS-20260928: the learning-content manager
  // is a level inside this screen, opened from the mini-lesson section.
  const [managingLearning, setManagingLearning] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const lesson = lessons.find((item) => item.id === openID) ?? null;
  const routedLessonOpen = Boolean(sourceID && !sourceDismissed && lesson);
  const article = sourceDismissed
    ? null
    : PREVIEW_KNOWLEDGE.find((item) => compassSourceMatchesReaderRecord(sourceID, 'kb', item.id)) ?? null;

  const closeLesson = useCallback(() => {
    setOpenID(null);
    setSourceDismissed(true);
    setReadLarge(false);
    setShareError(null);
  }, []);

  //  follow-up 2: while a lesson is open, Back belongs to the reading view.
  const interceptBack = useCallback(() => {
    if (openID === null) return false;
    closeLesson();
    return true;
  }, [closeLesson, openID]);
  // iab F4: the slot is a single global one, so registration is gated on
  // *focus* and not merely on mount. A screen pushed over an open lesson — the
  // drawer opening a conversation on top of a rights lesson — leaves this component
  // mounted underneath, and a mount-keyed registration would let the covered
  // lesson swallow the first Back press meant for the screen actually on top.
  const isFocused = useIsFocused();
  useScreenBackInterceptor(isFocused && openID !== null && !routedLessonOpen ? interceptBack : null);

  // iab F5: the interceptor covers the header chevron and the Android hardware
  // button, but iOS's left-edge swipe is a gesture on the stack itself and pops
  // the whole feature straight past it — the same wrong level Back used to land
  // on. The gesture stands down for exactly as long as a lesson is open, and is
  // restored the moment the reader returns to the index, so the ordinary
  // swipe-back off the feature is untouched. A lesson routed from the Guide is
  // already the route's top level, so its swipe and Back action return to
  // the Guide instead of stopping at an index the worker never visited.
  const navigation = useNavigation<{ setOptions: (options: { gestureEnabled: boolean }) => void }>();
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: openID === null || routedLessonOpen });
  }, [navigation, openID, routedLessonOpen]);

  // The other half of the same follow-up: the index and the reading view share
  // one scroll surface, so without this the reader arrives in the middle of a
  // script — or back on the index at the offset the script left behind.
  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [openID]);

  //  follow-up 4: the old handler cheered on dismissal and swallowed real
  // failures. The result says which happened — a completed share earns the
  // success haptic, a dismissed sheet earns nothing at all because the worker
  // changed their mind — and a thrown error becomes a Notice instead of a
  // silent no-op the worker reads as a broken button.
  async function shareScript() {
    if (!lesson) return;
    setShareError(null);
    try {
      const result = await Share.share({ title: lesson.title, message: `${lesson.title}\n\n${lesson.script}` });
      if (result.action === Share.sharedAction) {
        void haptics.success();
      }
    } catch {
      setShareError(t("That script could not be shared. It is still on this screen to copy by hand."));
      void haptics.warning();
    }
  }

  if (managingLearning) {
    return <LearningContentManager onClose={() => setManagingLearning(false)} />;
  }

  if (article) {
    return (
      <Screen scrollRef={scrollRef}>
        <Button
          label={t("All rights sources")}
          variant="secondary"
          icon={<Ionicons name="chevron-back" size={18} color={theme.secondaryForeground} accessibilityElementsHidden />}
          onPress={() => setSourceDismissed(true)}
        />
        <Heading>{article.title}</Heading>
        <Body muted>{article.ref}</Body>
        <Card><Body>{article.body}</Body></Card>
      </Screen>
    );
  }

  if (sourceID && !sourceDismissed && !lesson) {
    return (
      <Screen scrollRef={scrollRef}>
        <StateMessage title={t("That approved source is unavailable")} body={t("It is no longer available.")} />
        <Button label={t("All rights sources")} variant="secondary" onPress={() => setSourceDismissed(true)} />
      </Screen>
    );
  }

  if (lesson) {
    return (
      <Screen scrollRef={scrollRef}>
        <Button
          label={t("All rights lessons")}
          variant="secondary"
          icon={<Ionicons name="chevron-back" size={18} color={theme.secondaryForeground} accessibilityElementsHidden />}
          onPress={closeLesson}
        />
        <Heading>{lesson.title}</Heading>
        <Body muted>{lesson.summary}</Body>
        <Card>
          <Text style={[styles.eyebrow, { color: theme.primary }]}>{t("Say this")}</Text>
          <Text
            maxFontSizeMultiplier={readLarge ? RIGHTS_SCRIPT_LARGE_MAX_SCALE : RIGHTS_SCRIPT_MAX_SCALE}
            style={[
              styles.rightsScript,
              readLarge
                ? { fontSize: RIGHTS_SCRIPT_LARGE_SIZE, lineHeight: Math.round(RIGHTS_SCRIPT_LARGE_SIZE * 1.55) }
                : null,
              { color: theme.cardForeground },
            ]}
          >
            {lesson.script}
          </Text>
        </Card>
        {shareError ? <Notice>{shareError}</Notice> : null}
        <Button label={t("Copy or share this script")} variant="secondary" onPress={() => { void shareScript(); }} />
        <Button
          label={readLarge ? t("Back to reading size") : t("Read large")}
          variant="secondary"
          onPress={() => { void haptics.select(); setReadLarge((current) => !current); }}
        />
      </Screen>
    );
  }

  return (
    <Screen scrollRef={scrollRef}>
      <Heading>{t("Organizing rights")}</Heading>
      <AskCompassButton />
      <Body muted>{t("Approved scripts you can use on the floor. The Guide can also ground answers in these same lessons.")}</Body>
      <Body muted>{t('Campaign content is shown in its published language. Spanish learning guides are available below.')}</Body>
      <LearningLibrarySection onManage={() => setManagingLearning(true)} />
      {lessons.length === 0 ? (
        <StateMessage title={t("No rights lessons yet")} body={t("Approved scripts appear here once your campaign publishes them.")} />
      ) : (
        <Card style={styles.rightsIndexCard}>
          {lessons.map((item, index) => (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityLabel={item.title}
              accessibilityHint={t("Opens the full script")}
              onPress={() => { void haptics.select(); setOpenID(item.id); }}
              style={({ pressed }) => [
                styles.rightsIndexRow,
                // iaa-19: muted on white measured 1.14:1 — five destinations
                // read as one block. The audited border token is the app's one
                // hairline value.
                index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border } : null,
                pressed ? { backgroundColor: theme.muted } : null,
              ]}
            >
              <View style={styles.workListCopy}>
                <Text style={[styles.workCardTitle, { color: theme.cardForeground }]}>{item.title}</Text>
                <Text numberOfLines={2} style={[styles.workCardMeta, { color: theme.mutedForeground }]}>{item.summary}</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={theme.mutedForeground} accessibilityElementsHidden />
            </Pressable>
          ))}
        </Card>
      )}
    </Screen>
  );
}

function EventsFeature({ deskTitle }: { deskTitle: boolean }) {
  const theme = useTheme();
  const { previewDesk } = useApp();
  const [draftTitle, setDraftTitle] = useState('');
  const [draftPlace, setDraftPlace] = useState('');
  const [authored, setAuthored] = useState<PreviewEvent[]>([]);
  const [checkedInIds, setCheckedInIds] = useState<string[]>([]);
  const events = [...authored, ...(previewDesk?.events ?? [])];

  return (
    <Screen>
      <Heading>{deskTitle ? 'Meetings desk' : 'Meetings'}</Heading>
      <Body muted>{deskTitle ? 'Author a preview-session draft and mark a meeting as checked in. Codes stay in the app.' : 'Campaign meetings and actions you can attend.'}</Body>
      {deskTitle ? (
        <Card>
          <Heading level={3}>Author meeting</Heading>
          <Body muted>Drafts stay on this device for the preview session.</Body>
          <Text style={[styles.fieldLabel, { color: theme.foreground }]}>Title</Text>
          <TextInput
            accessibilityLabel="Meeting title"
            value={draftTitle}
            onChangeText={setDraftTitle}
            maxLength={80}
            keyboardAppearance={theme.appearance}
            selectionColor={theme.primary}
            placeholder="Committee meeting"
            placeholderTextColor={theme.mutedForeground}
            style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
          />
          <Text style={[styles.fieldLabel, { color: theme.foreground }]}>Place</Text>
          <TextInput
            accessibilityLabel="Meeting place"
            value={draftPlace}
            onChangeText={setDraftPlace}
            maxLength={80}
            keyboardAppearance={theme.appearance}
            selectionColor={theme.primary}
            placeholder="Library meeting room + Zoom"
            placeholderTextColor={theme.mutedForeground}
            style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
          />
          <Button label="Save draft meeting" disabled={!draftTitle.trim() || !draftPlace.trim()} onPress={() => setAuthored(appendPreviewEventDraft(authored, { title: draftTitle, place: draftPlace }))} />
        </Card>
      ) : null}
      {events.map((item) => {
        const checkIn = previewEventCheckInPresentation(item.startsAt, checkedInIds.includes(item.id));
        return (
          <Card key={item.id}>
            <Heading level={3}>{item.title}</Heading>
            <Body muted>{item.when} · {item.place}</Body>
            <Body>{item.summary}</Body>
            {deskTitle ? (
              checkIn.checkedIn ? (
                <Text style={[styles.eyebrow, { color: theme.primary }]}>{checkIn.statusLabel}</Text>
              ) : (
                <Button
                  label={checkIn.actionLabel}
                  variant="secondary"
                  onPress={() => setCheckedInIds((current) => togglePreviewEventCheckIn(current, item.id))}
                />
              )
            ) : null}
          </Card>
        );
      })}
    </Screen>
  );
}

// Union Ground acknowledges contributions without points: no balance,
// tiers, catalog to redeem from, or ledger. The preview renders the same
// sections a live session does, from the preview desk's acknowledgements.
function RewardsFeature() {
  const { previewDesk } = useApp();
  const rewards = previewDesk?.rewards;

  return (
    <Screen>
      <Heading>{CONTRIBUTIONS_COPY.title}</Heading>
      <Body muted>{CONTRIBUTIONS_COPY.eyebrow}</Body>
      <ContributionsSections
        currentRung={rewards?.currentRung ?? 'learn'}
        totalVerified={rewards?.totalVerified ?? 0}
        recentVerified={rewards?.recentVerified ?? 0}
        rules={PREVIEW_RECOGNITION_RULES}
        acknowledgements={rewards?.acknowledgements ?? []}
      />
    </Screen>
  );
}

function ReportsFeature() {
  const { dashboard, previewDesk, mode, previewHat } = useApp();
  const channelStore = useChannelStore();
  useSyncExternalStore(channelStore.subscribe, channelStore.getVersion);
  const inboxChannels = channelStore.channels().filter((channel) => (
    mode !== 'preview' || previewHat !== 'member' || !channel.locked
  ));
  const metrics = dashboard ? dashboardMetrics(dashboard, inboxChannels) : null;
  // b04b-1: this screen drew the same metric from two sources — the counts
  // computed from the worker's own records, and the desk's typed KPI band —
  // and printed both, so "Unread updates" appeared twice with different
  // numbers. The computed count is the one that can never be stale, so it
  // wins the label; a desk number only earns a card when nothing above
  // already reports it.
  // BUG-UG-MOBILE-WORK-WIDGET-UNREAD-DISAGREES-WITH-HOME-METRIC-20260918:
  // "Unread messages" is the same inbox item count Home's Messages metric
  // publishes, not the direct-thread unread sum.
  const computed = metrics && dashboard ? [
    { label: 'Open issues', value: String(metrics.openCases) },
    reportsUnreadMessagesCard(dashboard, inboxChannels),
    { label: 'Unread updates', value: String(metrics.unreadNotifications) },
    { label: 'Finished this week', value: String(metrics.completedThisWeek) },
  ] : [];
  const reported = new Set(computed.map((item) => item.label));
  const deskOnly = (previewDesk?.kpis ?? []).filter((item) => !reported.has(item.label));
  // The computed counts read the member's own records; a desk KPI is a chapter
  // figure, so each card names its own scope and period.
  const scoped = [
    ...computed.map((item) => ({ ...item, scope: reportMetricScopeLabel('own', item.label === 'Finished this week' ? 'this week' : 'right now') })),
    ...deskOnly.map((item) => ({ ...item, scope: reportMetricScopeLabel('chapter', 'current desk') })),
  ];
  return (
    <Screen>
      <Heading>My reports</Heading>
      <Body muted>{MY_REPORTS_SUMMARY}</Body>
      {scoped.map((item) => (
        <Card key={item.label}><StatValue value={String(item.value)} /><Body muted>{item.label}</Body><Body muted>{item.scope}</Body></Card>
      ))}
    </Screen>
  );
}

function ChapterFeature({ sourceID }: { sourceID?: string }) {
  const { previewDesk, previewHat } = useApp();
  const router = useRouter();
  const [sourceDismissed, setSourceDismissed] = useState(false);
  const staff = previewHat != null && previewHat !== 'member';
  if (sourceID && !sourceDismissed) {
    return (
      <Screen>
        <StateMessage title="That approved source is unavailable" body="It is no longer available." />
        <Button label="All campaign sources" variant="secondary" onPress={() => setSourceDismissed(true)} />
      </Screen>
    );
  }
  return (
    <Screen>
      <Heading>My campaign</Heading>
      <Body muted>{previewDesk?.chapterName ?? 'Your campaign'}: organize, meetings, and campaign actions without leaving the app.</Body>
      {previewDesk ? (
        <Card>
          <Heading level={2}>{previewDesk.chapterName}</Heading>
          <Body>{previewDesk.summary}</Body>
        </Card>
      ) : null}
      <Button label="Meetings" variant="secondary" onPress={() => router.push('/feature/events' as never)} />
      {staff ? <Button label="Issue campaigns" variant="secondary" onPress={() => router.push('/feature/campaigns' as never)} /> : null}
      <Button label="Votes" variant="secondary" onPress={() => router.push('/feature/voting' as never)} />
      <Button label="Be heard" variant="secondary" onPress={() => router.push('/feature/voice' as never)} />
      <Button label="Campaigns" variant="secondary" onPress={() => router.push('/feature/chapters' as never)} />
      {staff ? <Button label="Campaign handshakes" variant="secondary" onPress={() => router.push('/feature/partners' as never)} /> : null}
    </Screen>
  );
}

function CampaignsFeature() {
  const theme = useTheme();
  return (
    <Screen>
      <Heading>Issue campaigns</Heading>
      <Body muted>Campaign priorities and worker actions.</Body>
      {CAMPAIGNS.map((item) => (
        <Card key={item.id}>
          <Text style={[styles.eyebrow, { color: theme.primary }]}>{item.status}</Text>
          <Heading level={3}>{item.title}</Heading>
          <Body>{item.summary}</Body>
        </Card>
      ))}
    </Screen>
  );
}

const WORK_STATUS_IDS: PreviewTaskStatus[] = ['backlog', 'to_do', 'in_progress', 'needs_review', 'done'];
const WORK_STATUS_LABELS: Record<PreviewTaskStatus, string> = {
  backlog: 'Backlog',
  to_do: 'To do',
  in_progress: 'In progress',
  needs_review: 'Review',
  done: 'Done',
};
// Board grouping is attention-first; Done sits last, like the desktop board.
const WORK_BOARD_GROUP_ORDER: PreviewTaskStatus[] = ['to_do', 'in_progress', 'needs_review', 'backlog', 'done'];
const WORK_TYPE_LABELS: Record<PreviewTask['taskType'], string> = {
  general: 'General',
  meeting_event: 'Meeting or Action',
  review_approval: 'Review or Approval',
  member_follow_up: 'Worker Follow-up',
  document_request: 'Document Request',
  issue_incident: 'Issue or Incident',
};
const WORK_PRIORITY_ICONS: Record<PreviewTask['priority'], keyof typeof Ionicons.glyphMap> = {
  high: 'chevron-up',
  medium: 'remove',
  low: 'chevron-down',
};
type WorkViewId = 'board' | 'list' | 'timeline' | 'calendar' | 'deadlines' | 'field_notes' | 'progress' | 'report';
const WORK_VIEWS: { id: WorkViewId; label: string }[] = [
  { id: 'board', label: 'Board' },
  { id: 'list', label: 'List' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'deadlines', label: 'Deadlines' },
  { id: 'field_notes', label: 'Field notes' },
  { id: 'progress', label: 'Progress' },
  { id: 'report', label: 'Report' },
];

function workShortDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(`${value}T12:00:00`));
}

function workDayLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${value}T12:00:00`));
}

function workMonthLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(`${value}T12:00:00`));
}

function WorkStatusChip({ status }: { status: PreviewTaskStatus }) {
  const theme = useTheme();
  const done = status === 'done';
  return (
    <View style={[styles.workChip, { backgroundColor: done ? theme.muted : theme.secondary }]}>
      <Text style={[styles.workChipText, { color: done ? theme.mutedForeground : theme.secondaryForeground }]}>{WORK_STATUS_LABELS[status]}</Text>
    </View>
  );
}

function WorkTaskCard({ task }: { task: PreviewTask }) {
  const theme = useTheme();
  const overdue = previewWorkIsOverdue(task);
  return (
    <View
      accessible
      accessibilityLabel={`${task.taskKey}, ${task.title}, ${WORK_STATUS_LABELS[task.status]}${task.blocked ? ', blocked' : ''}${overdue ? ', overdue' : ''}`}
      style={[styles.workCard, { backgroundColor: theme.card, borderColor: theme.border }]}
    >
      <View style={styles.workChipRow}>
        <WorkStatusChip status={task.status} />
        {task.blocked ? (
          <View style={styles.workFlagRow}>
            <Ionicons name="warning-outline" size={14} color={theme.destructive} />
            <Text style={[styles.workFlagText, { color: theme.destructive }]}>Blocked</Text>
          </View>
        ) : null}
        {task.milestone ? <Ionicons name="flag" size={14} color={theme.primary} /> : null}
      </View>
      <Text style={[styles.workCardTitle, { color: theme.cardForeground }]}>{task.title}</Text>
      <Text style={[styles.workCardMeta, { color: theme.mutedForeground }]}>{task.taskKey} · {WORK_TYPE_LABELS[task.taskType]}</Text>
      <View style={styles.workCardFoot}>
        <Text style={[styles.workCardMeta, { color: theme.mutedForeground }]}>{task.assignee ?? 'Unassigned'}</Text>
        {task.dueDate ? (
          <Text style={[styles.workCardMeta, { color: overdue ? theme.destructive : theme.mutedForeground }]}>
            {workShortDate(task.dueDate)}{overdue ? ' · Overdue' : ''}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function WorkProgressTrack({ value }: { value: number }) {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: value }}
      // iab review, corrected: darkening the track to the border token
      // backfired — `border` is the app's darker-neutral *hairline* step, and
      // filling a 6pt bar with it reads as a bar that is already part-full at
      // 0%. The track goes back to the muted canvas step; separation is the
      // fill's job, and aubergine `primary` on `muted` computes 11.76:1 here.
      style={[styles.workTrack, { backgroundColor: theme.muted, borderColor: theme.border }]}
    >
      <View style={[styles.workFill, { width: `${Math.max(0, Math.min(100, value))}%`, backgroundColor: theme.primary }]} />
    </View>
  );
}

function ChapterWorkFeature() {
  const theme = useTheme();
  const { previewDesk } = useApp();
  const work = previewDesk?.chapterWork ?? null;
  const [view, setView] = useState<WorkViewId>('board');
  const [sessionNotes, setSessionNotes] = useState<PreviewFieldNote[]>([]);
  const [noteTaskId, setNoteTaskId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');

  if (!work) {
    return <Screen><StateMessage title="Campaign work unavailable" body="Switch to a staff role to open the campaign board." /></Screen>;
  }

  const tasks = work.tasks;
  const notes = [...work.fieldNotes, ...sessionNotes];
  const workstreams = [...new Set(tasks.map((task) => task.workstream))].sort();
  const dated = tasks.filter((task) => task.dueDate != null);
  const doneTasks = tasks.filter((task) => task.status === 'done');
  const openTasks = tasks.filter((task) => task.status !== 'done');
  const overdueTasks = tasks.filter((task) => previewWorkIsOverdue(task));
  const blockedTasks = tasks.filter((task) => task.blocked);
  const reviewTasks = tasks.filter((task) => task.status === 'needs_review');

  function addNote() {
    const body = noteDraft.trim();
    if (!body || !noteTaskId) return;
    setSessionNotes((current) => [...current, {
      id: `note-session-${current.length + 1}`,
      taskId: noteTaskId,
      author: 'You',
      when: 'Just now',
      body,
    }]);
    setNoteDraft('');
    void haptics.success();
  }

  return (
    <Screen>
      <Heading>Campaign work</Heading>
      <Body muted>Board, lists, task schedules, deadlines, field notes, progress and reports. Status is Backlog, To do, In progress, Review, or Done; Blocked is a flag, not a column.</Body>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.workRail}
        contentContainerStyle={styles.workRailContent}
        accessibilityLabel="Task views"
      >
        {WORK_VIEWS.map((item) => {
          const selected = view === item.id;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={item.label}
              onPress={() => { void haptics.select(); setView(item.id); }}
              style={[styles.workViewChip, { backgroundColor: selected ? theme.primary : theme.secondary }]}
            >
              <Text style={[styles.chipText, { color: selected ? theme.primaryForeground : theme.secondaryForeground }]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {view === 'board' ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.workRail}
          contentContainerStyle={styles.workRailContent}
          accessibilityLabel="Board columns by workstream"
        >
          {workstreams.map((workstream) => {
            const columnTasks = WORK_BOARD_GROUP_ORDER.flatMap((status) =>
              tasks.filter((task) => task.workstream === workstream && task.status === status));
            return (
              <View key={workstream} style={styles.workColumn}>
                <Text style={[styles.workColumnHead, { color: theme.foreground }]}>{workstream} · {columnTasks.length}</Text>
                {columnTasks.map((task) => <WorkTaskCard key={task.id} task={task} />)}
              </View>
            );
          })}
        </ScrollView>
      ) : null}

      {view === 'list' ? WORK_STATUS_IDS.map((status) => {
        const rows = tasks.filter((task) => task.status === status);
        if (!rows.length) return null;
        return (
          <View key={status} style={styles.workSection}>
            <Heading level={3}>{WORK_STATUS_LABELS[status]} · {rows.length}</Heading>
            <Card style={styles.workListCard}>
              {rows.map((task, index) => (
                <View key={task.id} style={[styles.workListRow, index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.muted } : null]}>
                  <Ionicons name={WORK_PRIORITY_ICONS[task.priority]} size={16} color={theme.mutedForeground} />
                  <View style={styles.workListCopy}>
                    <Text style={[styles.workCardTitle, { color: theme.cardForeground }]}>{task.title}</Text>
                    <Text style={[styles.workCardMeta, { color: theme.mutedForeground }]}>{task.taskKey} · {task.workstream} · {task.assignee ?? 'Unassigned'}</Text>
                  </View>
                  {task.dueDate ? <Text style={[styles.workCardMeta, { color: previewWorkIsOverdue(task) ? theme.destructive : theme.mutedForeground }]}>{workShortDate(task.dueDate)}</Text> : null}
                </View>
              ))}
            </Card>
          </View>
        );
      }) : null}

      {view === 'timeline' ? (() => {
        const scheduled = tasks
          .filter((task) => task.startDate != null || task.dueDate != null)
          .sort((a, b) => (a.startDate ?? a.dueDate ?? '').localeCompare(b.startDate ?? b.dueDate ?? ''));
        const months = [...new Set(scheduled.map((task) => workMonthLabel(task.startDate ?? task.dueDate!)))];
        return (
          <>
            {months.map((month) => (
              <View key={month} style={styles.workSection}>
                <Heading level={3}>{month}</Heading>
                {scheduled.filter((task) => workMonthLabel(task.startDate ?? task.dueDate!) === month).map((task) => (
                  <Card key={task.id}>
                    <View style={styles.workChipRow}>
                      <Text style={[styles.workCardMeta, { color: theme.mutedForeground }]}>
                        {task.startDate ? workShortDate(task.startDate) : '·'} → {task.dueDate ? workShortDate(task.dueDate) : 'open'}
                      </Text>
                      {task.milestone ? <Ionicons name="flag" size={14} color={theme.primary} /> : null}
                    </View>
                    <Heading level={3}>{task.title}</Heading>
                    <Body muted>{task.workstream} · {WORK_STATUS_LABELS[task.status]}</Body>
                    <WorkProgressTrack value={task.progress} />
                  </Card>
                ))}
              </View>
            ))}
            {scheduled.length < tasks.length ? (
              <Body muted>
                {tasks.length - scheduled.length === 1
                  ? '1 undated task appears on Board and List only.'
                  : `${tasks.length - scheduled.length} undated tasks appear on Board and List only.`}
              </Body>
            ) : null}
          </>
        );
      })() : null}

      {view === 'calendar' ? (() => {
        const byDay = [...new Set(dated.map((task) => task.dueDate!))].sort();
        return (
          <>
            {byDay.map((day) => (
              <View key={day} style={styles.workSection}>
                <Heading level={3}>{workDayLabel(day)}</Heading>
                <Card style={styles.workListCard}>
                  {dated.filter((task) => task.dueDate === day).map((task, index) => (
                    <View key={task.id} style={[styles.workListRow, index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.muted } : null]}>
                      <View style={styles.workListCopy}>
                        <Text style={[styles.workCardTitle, { color: theme.cardForeground }]}>{task.title}</Text>
                        <Text style={[styles.workCardMeta, { color: theme.mutedForeground }]}>{task.workstream} · {WORK_STATUS_LABELS[task.status]}</Text>
                      </View>
                      {task.milestone ? <Ionicons name="flag" size={14} color={theme.primary} /> : null}
                    </View>
                  ))}
                </Card>
              </View>
            ))}
            {dated.length < tasks.length ? (
              <Body muted>
                {tasks.length - dated.length === 1
                  ? '1 undated task appears on Board and List only.'
                  : `${tasks.length - dated.length} undated tasks appear on Board and List only.`}
              </Body>
            ) : null}
          </>
        );
      })() : null}

      {view === 'deadlines' ? (() => {
        const buckets: { label: string; rows: PreviewTask[] }[] = [
          { label: 'Overdue', rows: dated.filter((task) => task.status !== 'done' && previewWorkDayDiff(task.dueDate!) < 0) },
          { label: 'Due today', rows: dated.filter((task) => task.status !== 'done' && previewWorkDayDiff(task.dueDate!) === 0) },
          { label: 'Next 7 days', rows: dated.filter((task) => task.status !== 'done' && previewWorkDayDiff(task.dueDate!) > 0 && previewWorkDayDiff(task.dueDate!) <= 7) },
          { label: 'Later', rows: dated.filter((task) => task.status !== 'done' && previewWorkDayDiff(task.dueDate!) > 7) },
          { label: 'Completed', rows: dated.filter((task) => task.status === 'done') },
        ];
        return (
          <>
            <Body muted>Due work from the same task model used by Board, List and Calendar. {dated.length} dated tasks.</Body>
            {buckets.filter((bucket) => bucket.rows.length).map((bucket) => (
              <View key={bucket.label} style={styles.workSection}>
                <Heading level={3}>{bucket.label} · {bucket.rows.length}</Heading>
                <Card style={styles.workListCard}>
                  {bucket.rows.sort((a, b) => a.dueDate!.localeCompare(b.dueDate!)).map((task, index) => (
                    <View key={task.id} style={[styles.workListRow, index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.muted } : null]}>
                      <Text style={[styles.workCardMeta, { color: bucket.label === 'Overdue' ? theme.destructive : theme.mutedForeground }]}>{workShortDate(task.dueDate!)}</Text>
                      <View style={styles.workListCopy}>
                        <Text style={[styles.workCardTitle, { color: theme.cardForeground }]}>{task.title}</Text>
                        <Text style={[styles.workCardMeta, { color: theme.mutedForeground }]}>{task.taskKey} · {task.workstream} · {task.assignee ?? 'Unassigned'}</Text>
                      </View>
                    </View>
                  ))}
                </Card>
              </View>
            ))}
          </>
        );
      })() : null}

      {view === 'field_notes' ? (
        <>
          <View style={styles.workChipRow}>
            <Heading level={2}>Field notes</Heading>
            <View style={[styles.workChip, { backgroundColor: theme.accent }]}>
              <Text style={[styles.workChipText, { color: theme.accentForeground }]}>PREVIEW · session-only</Text>
            </View>
          </View>
          <Body muted>Everyone authorized for a task can read its field notes. Corrections are added as new notes.</Body>
          {tasks.filter((task) => notes.some((note) => note.taskId === task.id)).map((task) => (
            <Card key={task.id}>
              <Text style={[styles.eyebrow, { color: theme.primary }]}>{task.taskKey} · {task.workstream}</Text>
              <Heading level={3}>{task.title}</Heading>
              {notes.filter((note) => note.taskId === task.id).map((note) => (
                <View key={note.id} style={styles.workNote}>
                  <Text style={[styles.workCardMeta, { color: theme.mutedForeground }]}>{note.author} · {note.when}</Text>
                  <Body>{note.body}</Body>
                </View>
              ))}
            </Card>
          ))}
          <Card>
            <Heading level={3}>New note</Heading>
            <View style={styles.wrap}>
              {tasks.map((task) => (
                <Pressable
                  key={task.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: noteTaskId === task.id }}
                  accessibilityLabel={`${task.taskKey} ${task.title}`}
                  onPress={() => setNoteTaskId(task.id)}
                  style={({ pressed }) => [styles.chip, {
                    backgroundColor: noteTaskId === task.id ? theme.primary : theme.secondary,
                    opacity: pressed ? 0.82 : 1,
                  }]}
                >
                  <Text style={[styles.chipText, { color: noteTaskId === task.id ? theme.primaryForeground : theme.secondaryForeground }]}>{task.taskKey}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              accessibilityLabel="Add a field note"
              multiline
              maxLength={2000}
              keyboardAppearance={theme.appearance}
              selectionColor={theme.primary}
              placeholder="Add a field note…"
              placeholderTextColor={theme.mutedForeground}
              value={noteDraft}
              onChangeText={setNoteDraft}
              style={[styles.input, styles.multiline, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
            />
            <Text style={[styles.workCardMeta, { color: theme.mutedForeground, textAlign: 'right' }]}>{noteDraft.length}/2000</Text>
            <Button label="Add note" disabled={!noteDraft.trim() || !noteTaskId} onPress={addNote} />
          </Card>
        </>
      ) : null}

      {view === 'progress' ? (() => {
        const meanSource = openTasks.length ? openTasks : tasks;
        const overall = Math.round(meanSource.reduce((sum, task) => sum + task.progress, 0) / Math.max(1, meanSource.length));
        const tiles = [
          { label: 'Done', value: doneTasks.length },
          { label: 'Review', value: reviewTasks.length },
          { label: 'Blocked', value: blockedTasks.length },
          { label: 'Overdue', value: overdueTasks.length },
        ];
        return (
          <>
            <Body muted>The last 60 days. What is moving right now.</Body>
            <Card>
              <Text style={[styles.eyebrow, { color: theme.primary }]}>Delivery health</Text>
              <Heading level={2}>{doneTasks.length} / {tasks.length} complete</Heading>
              <Body muted>
                {overdueTasks.length === 0
                  ? 'No overdue work in this view.'
                  : overdueTasks.length === 1
                    ? '1 overdue task needs attention.'
                    : `${overdueTasks.length} overdue tasks need attention.`}
              </Body>
              <Body muted>Overall progress of open work: {overall}%</Body>
              <WorkProgressTrack value={overall} />
            </Card>
            <View style={styles.workTileGrid}>
              {tiles.map((tile) => (
                <View key={tile.label} style={[styles.workTile, { backgroundColor: theme.muted, borderColor: theme.border }]}>
                  <NumberFlow value={String(tile.value)} style={[styles.workTileValue, { color: theme.foreground }]} />
                  <Text style={[styles.workCardMeta, { color: theme.mutedForeground }]}>{tile.label}</Text>
                </View>
              ))}
            </View>
            <Heading level={3}>By workstream</Heading>
            {workstreams.map((workstream) => {
              const rows = tasks.filter((task) => task.workstream === workstream);
              const rowDone = rows.filter((task) => task.status === 'done').length;
              const mean = Math.round(rows.reduce((sum, task) => sum + task.progress, 0) / rows.length);
              return (
                <Card key={workstream}>
                  <View style={styles.workChipRow}>
                    <Heading level={3}>{workstream}</Heading>
                    <Text style={[styles.workCardMeta, { color: theme.mutedForeground }]}>{rowDone}/{rows.length} complete · {mean}%</Text>
                  </View>
                  <WorkProgressTrack value={mean} />
                </Card>
              );
            })}
          </>
        );
      })() : null}

      {view === 'report' ? (() => {
        const late = doneTasks.filter((task) => task.doneAt != null && task.dueDate != null && task.doneAt > task.dueDate).length;
        const daysToDone = doneTasks
          .filter((task) => task.doneAt != null && task.startDate != null)
          .map((task) => Math.round((new Date(`${task.doneAt}T12:00:00`).getTime() - new Date(`${task.startDate}T12:00:00`).getTime()) / 86_400_000))
          .sort((a, b) => a - b);
        const medianDays = daysToDone.length ? daysToDone[Math.floor(daysToDone.length / 2)]! : 0;
        const tiles = [
          { label: 'Finished', value: String(doneTasks.length) },
          { label: 'Still open', value: String(openTasks.length) },
          { label: 'Finished late', value: String(late) },
        ];
        return (
          <>
            <Body muted>All time · what finished, and how long it took.</Body>
            <View style={styles.workTileGrid}>
              {tiles.map((tile) => (
                <View key={tile.label} style={[styles.workTile, { backgroundColor: theme.muted, borderColor: theme.border }]}>
                  <NumberFlow value={String(tile.value)} style={[styles.workTileValue, { color: theme.foreground }]} />
                  <Text style={[styles.workCardMeta, { color: theme.mutedForeground }]}>{tile.label}</Text>
                </View>
              ))}
            </View>
            <Card>
              <Heading level={3}>Median days to done</Heading>
              <Body muted>{doneTasks.length < 5 ? 'Too few finished tasks to time.' : `${medianDays} days`}</Body>
            </Card>
            <Heading level={3}>By workstream</Heading>
            <Card style={styles.workListCard}>
              {workstreams.map((workstream, index) => {
                const rows = tasks.filter((task) => task.workstream === workstream);
                const rowDone = rows.filter((task) => task.status === 'done').length;
                return (
                  <View key={workstream} style={[styles.workListRow, index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.muted } : null]}>
                    <View style={styles.workListCopy}>
                      <Text style={[styles.workCardTitle, { color: theme.cardForeground }]}>{workstream}</Text>
                    </View>
                    <Text style={[styles.workCardMeta, { color: theme.mutedForeground }]}>{rowDone}/{rows.length} complete</Text>
                  </View>
                );
              })}
            </Card>
            <Body muted>Counts only. Private task conversations, titles and descriptions stay in the app.</Body>
          </>
        );
      })() : null}
    </Screen>
  );
}

function ChaptersFeature() {
  const theme = useTheme();
  const { catalogLabel } = useNativeUi();
  const { mode, previewHat, chapterMemberships } = useApp();
  if (mode === 'authenticated') {
    return (
      <Screen>
        <Heading>{catalogLabel('Campaigns')}</Heading>
        <Body muted>Campaigns connected to your membership.</Body>
        {chapterMemberships.length === 0 ? (
          <StateMessage title="No campaigns yet" body="A campaign administrator can add your first campaign membership." />
        ) : chapterMemberships.map((entry) => (
          <Card key={entry.chapterID}>
            <View style={styles.workChipRow}>
              <Heading level={3}>{entry.name}</Heading>
              {entry.selected ? <StatusPill label="Current" /> : null}
            </View>
            {entry.region ? <Body muted>{entry.region}</Body> : null}
            <Body muted>{entry.roles.length > 0 ? chapterMembershipRoleLabels(entry).join(' · ') : 'Worker'}</Body>
          </Card>
        ))}
      </Screen>
    );
  }
  return (
    <Screen>
      <Heading>{catalogLabel('Campaigns')}</Heading>
      <Body muted>Preview context only. Your worker account and authorization have not changed.</Body>
      {PREVIEW_CHAPTERS.map((entry) => (
        <Card key={entry.id}>
          <View style={styles.workChipRow}>
            <Heading level={3}>{entry.name}</Heading>
            {/* b04b: the per-card amber PREVIEW pill restated a boundary the hat
                pill already carries for the whole session, spent the gold token
                on a repeated label, and measured ~2.3:1 doing it. The boundary
                is the hat pill plus the sentence under this list; only the
                worker's own campaign still takes a chip, because that one says
                something the sentence does not. */}
            {entry.current ? (
              <View style={[styles.workChip, { backgroundColor: theme.secondary }]}>
                <Text style={[styles.workChipText, { color: theme.secondaryForeground }]}>Your campaign</Text>
              </View>
            ) : null}
          </View>
          <Body muted>{entry.region}</Body>
          <Body muted>
            {/* One grammar for every card (p2w2 partial): the hat pill is the
                PREVIEW marker, so the prose never restates it — and no card may
                imply it is more real than its neighbours. */}
            {`Workers ${entry.memberCount} · Staff roles ${entry.staffCount}`}
          </Body>
          {previewHat === 'admin' ? <Text style={[styles.workCardMeta, { color: theme.mutedForeground }]}>{entry.roleLine}</Text> : null}
          {entry.activity.slice(0, 3).map((item) => (
            <Text key={item.id} style={[styles.workCardMeta, { color: theme.mutedForeground }]}>{item.dateLabel} · {item.title}</Text>
          ))}
          {entry.sharedResources.slice(0, 2).map((item) => (
            <Text key={item.id} style={[styles.workCardMeta, { color: theme.mutedForeground }]}>Shared · {item.title}</Text>
          ))}
        </Card>
      ))}
      {previewHat === 'admin' ? (
        <Body muted>Organization-wide admin access. Live worker and staff counts come from the organization database on the desktop site.</Body>
      ) : null}
    </Screen>
  );
}

const HANDSHAKE_SCOPES: { value: PreviewHandshake['dataScope']; label: string }[] = [
  { value: 'docs_only', label: 'Documents only' },
  { value: 'no_member_data', label: 'No worker data' },
  { value: 'aggregate_only', label: 'Aggregate data only' },
];
const HANDSHAKE_SCOPE_LABELS: Record<PreviewHandshake['dataScope'], string> = {
  docs_only: 'Documents only',
  no_member_data: 'No worker data',
  aggregate_only: 'Aggregate data only',
};

function PartnersFeature() {
  const theme = useTheme();
  const { previewDesk, previewHat } = useApp();
  const orgs = previewDesk?.partnerOrgs ?? [];
  const seeded = previewDesk?.handshakes ?? [];
  const staff = previewHat != null && previewHat !== 'member';
  const [created, setCreated] = useState<PreviewHandshake[]>([]);
  const [showConnections, setShowConnections] = useState(false);
  const [composing, setComposing] = useState(false);
  const [partnerOrgId, setPartnerOrgId] = useState(orgs[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [dataScope, setDataScope] = useState<PreviewHandshake['dataScope']>('docs_only');
  const handshakes = [...created, ...seeded];
  const scopes = HANDSHAKE_SCOPES;

  function sendRequest() {
    const org = orgs.find((entry) => entry.id === partnerOrgId);
    if (!org || !title.trim() || !purpose.trim()) return;
    setCreated((current) => [{
      id: `handshake-session-${current.length + 1}`,
      partnerOrgId: org.id,
      title: title.trim(),
      purpose: purpose.trim(),
      dataScope,
      status: 'requested',
      orgName: org.name,
      orgCity: org.city,
      orgState: org.state,
      orgAffiliation: org.affiliation,
    }, ...current]);
    setTitle('');
    setPurpose('');
    setDataScope('docs_only');
    setComposing(false);
    void haptics.success();
  }

  if (showConnections) return <Screen>
    <Button label="Back to campaign handshakes" variant="secondary" onPress={() => setShowConnections(false)} />
    <ConnectionSuggestionsPanel onHandshakeRequested={({ target, fields }) => {
      setCreated((current) => [{ id: fields.idempotencyKey, partnerOrgId: target.id, title: fields.title,
        purpose: fields.purpose, dataScope: fields.dataScope, status: 'requested', orgName: target.displayName,
        orgCity: target.location.metro ?? '', orgState: target.location.state ?? '', orgAffiliation: '', }, ...current]);
      setShowConnections(false);
    }} />
  </Screen>;
  return (
    <Screen>
      <Heading>Campaign handshakes</Heading>
      <Body muted>Coordinate with sister campaigns without sharing worker data.</Body>
      {staff && <Button label="Find campaign connections" variant="secondary" onPress={() => setShowConnections(true)} />}
      {staff ? (
        <Button
          label={composing ? 'Close' : 'Start an agreement'}
          variant={composing ? 'secondary' : 'primary'}
          onPress={() => { void haptics.select(); setComposing((value) => !value); }}
        />
      ) : null}
      {staff && composing ? (
        <Card>
          <Text style={[styles.fieldLabel, { color: theme.foreground }]}>Partner organization</Text>
          <View style={styles.wrap}>
            {orgs.map((org) => (
              <Pressable
                key={org.id}
                accessibilityRole="button"
                accessibilityState={{ selected: partnerOrgId === org.id }}
                onPress={() => setPartnerOrgId(org.id)}
                style={({ pressed }) => [styles.chip, {
                  backgroundColor: partnerOrgId === org.id ? theme.primary : theme.secondary,
                  opacity: pressed ? 0.82 : 1,
                }]}
              >
                <Text style={[styles.chipText, { color: partnerOrgId === org.id ? theme.primaryForeground : theme.secondaryForeground }]}>{org.name} · {org.city}, {org.state}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={[styles.fieldLabel, { color: theme.foreground }]}>Title</Text>
          <TextInput
            accessibilityLabel="Agreement title"
            maxLength={160}
            keyboardAppearance={theme.appearance}
            selectionColor={theme.primary}
            value={title}
            onChangeText={setTitle}
            placeholder="Shared training library"
            placeholderTextColor={theme.mutedForeground}
            style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
          />
          <Text style={[styles.fieldLabel, { color: theme.foreground }]}>Purpose</Text>
          <TextInput
            accessibilityLabel="Agreement purpose"
            multiline
            maxLength={4000}
            keyboardAppearance={theme.appearance}
            selectionColor={theme.primary}
            value={purpose}
            onChangeText={setPurpose}
            placeholder="What the campaigns will work on together"
            placeholderTextColor={theme.mutedForeground}
            style={[styles.input, styles.multiline, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
          />
          <Text style={[styles.fieldLabel, { color: theme.foreground }]}>Data boundary</Text>
          <View style={styles.wrap}>
            {scopes.map((scope) => (
              <Pressable
                key={scope.value}
                accessibilityRole="button"
                accessibilityState={{ selected: dataScope === scope.value }}
                onPress={() => setDataScope(scope.value)}
                style={({ pressed }) => [styles.chip, {
                  backgroundColor: dataScope === scope.value ? theme.primary : theme.secondary,
                  opacity: pressed ? 0.82 : 1,
                }]}
              >
                <Text style={[styles.chipText, { color: dataScope === scope.value ? theme.primaryForeground : theme.secondaryForeground }]}>{scope.label}</Text>
              </Pressable>
            ))}
          </View>
          <Button label="Send request" disabled={!title.trim() || !purpose.trim() || !partnerOrgId} onPress={sendRequest} />
          <Body muted>Requests stay in this preview session. No live organization is contacted.</Body>
        </Card>
      ) : null}
      {handshakes.length === 0 ? (
        <StateMessage title="No campaign handshakes" body="Staff can request a privacy-bounded partnership." />
      ) : handshakes.map((item) => (
        <Card key={item.id}>
          <View style={styles.workChipRow}>
            <View style={[styles.workChip, { backgroundColor: theme.secondary }]}>
              <Text style={[styles.workChipText, styles.capitalize, { color: theme.secondaryForeground }]}>{item.status}</Text>
            </View>
            <Text style={[styles.workCardMeta, styles.handshakeMeta, { color: theme.mutedForeground }]}>{item.orgName} · {HANDSHAKE_SCOPE_LABELS[item.dataScope]}</Text>
          </View>
          <Heading level={3}>{item.title}</Heading>
          <Body>{item.purpose}</Body>
        </Card>
      ))}
      {!staff ? <Body muted>Staff roles can start a new agreement from this screen.</Body> : null}
    </Screen>
  );
}

/**
 * The shared staff-desk template (b03b, specified against all five desks).
 *
 * Every desk used to be the same anonymous stack — an h1, a sentence, three
 * identical KPI cards, then whatever the fixture happened to hold — so the five
 * desks were distinguishable only by their numbers and none of them said which
 * number was the one to read. The template is one shape with a per-desk
 * identity:
 *
 * 1. **Header.** An 11px role eyebrow over the work-noun h1 (b03a-3, the half
 *    deferred from), then the desk's verbatim one-sentence status line.
 * 2. **Hero-plus-two KPI band.** Each desk names the KPI it leads with below;
 *    that one takes the hero pass and the display size, the other two sit
 *    beside it on the contact pass. A hero whose value is a ratio draws the
 *    one gold progress bar in the app (b03b-11's other half — the campaign chair's
 *    213/300 got its denominator named in  and its bar here).
 * 3. **Section index.** 48px rows with count badges, chevron only on the rows
 *    that actually push. Same-desk rows stay static readings — preview has no
 *    real section target behind them — so they do not look tappable.
 * 4. **Records.** The queue and the worker's own issues, unchanged.
 */
const DESK_HERO_KPI: Record<string, string> = {
  // The b03b names, resolved against the KPI each desk actually ships:
  // Committee → the desk's Open requests; Campaign lead → Open issues; admin
  // "Open grants"; Campaign chair → the card count toward a majority.
  steward: 'Open requests',
  coordinator: 'Open issues',
  // b03b named the advisor hero "At-risk signals". The advisor desk holds no
  // such number and inventing one would be a fabricated record, so the hero is
  // the closest shipped measure of campaign risk — see the wave flag.
  advisor: 'Campaign health',
  admin: 'Open grants',
  vp: 'Cards signed',
};

/** Splits a "213/300" hero value into a progress fraction, or null. */
function deskHeroProgress(value: string): { done: number; total: number } | null {
  const match = /^\s*([\d,]+)\s*\/\s*([\d,]+)\s*$/.exec(value);
  if (!match) return null;
  const done = Number(match[1]!.replace(/,/g, ''));
  const total = Number(match[2]!.replace(/,/g, ''));
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
  return { done, total };
}

/**
 * How many records a desk section actually holds, for its count badge.
 *
 * The map is explicit per section key rather than derived from the widget
 * data-source table, because those two questions are not the same one. A
 * widget source answers "what does this row open?"; a badge has to answer "how
 * many of *this row's own noun* are there?" — and routed through
 * `widgetSourceFor` they diverged into numbers that contradicted the desk they
 * sat on. The admin "Form templates" row wore a 3 (the fixture's form records)
 * directly under a "7 active templates" KPI; the coordinator "Active issues"
 * row wore a 5 — every issue, including the resolved one — beside an "Open
 * issues 4" hero; a trend row counted votes and a grouping row counted forms. Every number below is cross-checked against the same desk's
 * KPI band and its verbatim status sentence, so a badge can only restate a
 * number the worker is already reading on that screen.
 *
 * A section returns null when the workspace holds no countable collection of
 * that row's noun: a trend line, an escalation funnel, a two-step status page,
 * a roster nothing enumerates. Zero is not that case. The board ruled that a
 * countable collection renders its number *including* 0 — "Latest vote turnout
 * 0" tells a worker this desk has no vote yet, whereas a missing badge tells
 * them the row is a view rather than a queue, and those are different facts.
 */
function deskSectionCount(sectionKey: string, desk: PreviewDesk | null, openCases: number, unreadThreads: number): number | null {
  switch (sectionKey) {
    // Committee. "Issues you follow" is the open half of the issue list this desk
    // renders below it; "Worker requests" is the queue the desk's own "Open
    // requests" KPI counts — not the thread list, which is 4 and contradicted
    // both that KPI and the "two unread threads" sentence.
    case 'steward-caseload': return openCases;
    case 'steward-requests': return desk?.queue.length ?? null;
    case 'steward-appointments': return desk?.appointments.length ?? null;
    // The row's noun is its blurb's: *submitted* forms waiting for review.
    // Counting the whole inbox reads 3 under a status sentence that says "two
    // submitted forms waiting on your review".
    case 'steward-forms': return desk ? desk.forms.filter((form) => form.status === 'submitted').length : null;
    // A number on a messages row means unread, which is this desk's "Awaiting
    // reply" KPI and its "two unread threads" sentence — not four threads.
    case 'steward-messages': return unreadThreads;
    // Check-ins are scanned and broadcasts are sent; the workspace enumerates
    // neither, so neither carries a number.
    case 'steward-checkins': return null;
    case 'steward-broadcasts': return null;

    // Campaign lead. "Active issues" is the active half of the issue list, which
    // is the hero's own "Open issues 4" and the summary's "Four active issues".
    // The whole list is 5 and includes a resolved issue this row does not claim.
    case 'coordinator-cases': return openCases;
    // A deadline slice, a funnel and a topic grouping are three views over
    // the same queue, not queues of their own. The fixture holds no funnel
    // stages or grouped topics to count, and the deadline slice the Work widget
    // lists is already the desk's "Due this week" KPI, so a number here would
    // restate it. The forms count this row used to wear had nothing to do with
    // any of them.
    case 'coordinator-deadlines': return null;
    case 'coordinator-funnel': return null;
    case 'coordinator-articles': return null;

    // Advisor. Turnout counts votes and this desk holds none — the ruled
    // informative zero, not a missing badge.
    case 'advisor-turnout': return desk?.ballots.length ?? null;
    // An aggregate workplace-log reading, the risk panel the wave flag already
    // records as unbacked by any number, and a roster nothing enumerates.
    case 'advisor-workload': return null;
    case 'advisor-risks': return null;
    case 'advisor-leadership': return null;

    // Admin. Meetings are real records on this desk; Roles & access opens the
    // memberships screen and is a view, not a queue, so it carries no badge.
    case 'admin-events': return desk?.events.length ?? null;
    case 'admin-access': return null;

    // Campaign chair. The attention list is this desk's queue; priorities are
    // the shipped campaign catalog; meetings are the desk's own agenda.
    case 'vp-attention': return desk?.queue.length ?? null;
    case 'vp-priorities': return CAMPAIGNS.length;
    case 'vp-events': return desk?.events.length ?? null;
    // A trend line is a chart and the roster is not enumerated. The trend row
    // used to wear the vote count, which measured neither.
    case 'vp-trend': return null;
    case 'vp-leadership': return null;

    default: return null;
  }
}

function DeskFeature({ title, expectedHat, currentHat, authorizedRoles, mode }: { title: string; expectedHat: string; currentHat: string | null; authorizedRoles: readonly string[]; mode: string }) {
  const theme = useTheme();
  const router = useRouter();
  const { previewDesk, dashboard } = useApp();
  if ((mode === 'preview' && currentHat !== expectedHat)
      || (mode === 'authenticated' && !authorizedRoles.includes(expectedHat))) {
    return mode === 'preview'
      ? (
        <AuthorizationGate
          title={`${title} opens under another hat`}
          body="This desk belongs to the hat that owns it. Choosing that hat opens it here."
          qualifyingHats={isPreviewHatKey(expectedHat) ? [expectedHat as PreviewHatKey] : undefined}
          switchHat
        />
      )
      : (
        <AuthorizationGate
          title={`${title} is not open to your role`}
          body="Your current campaign role does not grant this desk. Ask a campaign administrator if your assignment changed."
        />
      );
  }
  const kpis = previewDesk?.kpis ?? [];
  const queue = previewDesk?.queue ?? [];
  const cases = dashboard?.cases ?? [];
  // The two badge inputs the desk fixture cannot supply on its own. Both are
  // measures the desks' KPI bands already name — "Open issues" / "Open
  // requests", and "Awaiting reply" — so a badge built from them restates a
  // number on the screen rather than introducing a second one beside it.
  const openCases = cases.filter((item) => item.status === 'active').length;
  const unreadThreads = (dashboard?.conversations ?? []).filter((item) => item.unreadCount > 0).length;
  const eyebrow = isPreviewHatKey(expectedHat)
    ? `${(PREVIEW_HATS.find((item) => item.key === expectedHat)?.label ?? expectedHat).toUpperCase()} DESK`
    : 'STAFF DESK';
  // The desk's own hash-target sections, like the site rail: entries scoped to
  // this hat, minus the desk-home row and any shared staff tools.
  const sections = STAFF_HAT_FUNCTIONS[expectedHat as keyof typeof STAFF_HAT_FUNCTIONS]
    .filter((item) => item.key !== expectedHat && item.key.startsWith(`${expectedHat}-`));
  // Hero-plus-two: the desk's named lead KPI first, then the rest in fixture
  // order. A desk whose named hero is missing leads with whatever it does have,
  // so a fixture edit degrades to the old ordering rather than to no band.
  const heroLabel = DESK_HERO_KPI[expectedHat];
  const hero = kpis.find((item) => item.label === heroLabel) ?? kpis[0] ?? null;
  const supporting = kpis.filter((item) => item !== hero);
  const heroProgress = hero ? deskHeroProgress(hero.value) : null;
  return (
    <Screen>
      <View style={styles.deskHeader}>
        <Text style={[styles.roleEyebrow, { color: theme.primary }]}>{eyebrow}</Text>
        <Heading>{title}</Heading>
        {/* Verbatim: the one-sentence status line is the desk's own copy and no
            template may reword it. */}
        <Body muted>{previewDesk?.summary ?? 'Authorized desk work for this role.'}</Body>
      </View>
      {kpis.length === 0 && queue.length === 0 && cases.length === 0 ? (
        <StateMessage title="Nothing queued yet" body="Desk numbers, queue items, and issues will appear here." />
      ) : null}
      {hero ? (
        <Card hero>
          <Text style={[styles.roleEyebrow, { color: theme.primary }]}>{hero.label}</Text>
          {/* iab F10: the same shrink-to-fit Home's stat value already takes.
              A 40px display value and a ratio like "213/300" cannot both be
              assumed to fit one line at every text size. */}
          <Text adjustsFontSizeToFit numberOfLines={1} style={[styles.deskHeroValue, { color: theme.cardForeground }]}>{hero.value}</Text>
          {/* b03b-11: the app's one gold-family progress bar. Gold is a fill
              role here (brief §B) and the ratio it draws is the labelled
              denominator, so the bar restates the number rather than
              introducing a second one. A desk whose hero is a plain count
              draws no bar at all. */}
          {heroProgress ? (
            <View
              accessibilityRole="progressbar"
              accessibilityValue={{ min: 0, max: heroProgress.total, now: heroProgress.done }}
              accessibilityLabel={`${hero.label}, ${heroProgress.done} of ${heroProgress.total}`}
              // iab review, corrected: the repair belongs to the fill, not the
              // track. Raw `accent` gold computed 1.83:1 on the muted track,
              // and darkening the track to `border` only pushed the whole bar
              // toward one ink — a bar that reads as part-full at 0%. The fill
              // moves one step down the same family instead, to the ramp's
              // attention copper, which the contrast audit already holds at
              // 4.37:1 on `muted`; the track stays the muted canvas step.
              style={[styles.workTrack, { backgroundColor: theme.muted, borderColor: theme.border }]}
            >
              <View style={[styles.workFill, { width: `${Math.min(100, Math.round((heroProgress.done / heroProgress.total) * 100))}%`, backgroundColor: theme.statusAttention }]} />
            </View>
          ) : null}
        </Card>
      ) : null}
      {supporting.length ? (
        <View style={styles.deskKpiRow}>
          {supporting.map((item) => (
            <View key={item.label} style={styles.flex}>
              <Card><StatValue value={String(item.value)} /><Body muted>{item.label}</Body></Card>
            </View>
          ))}
        </View>
      ) : null}
      {sections.length ? <Heading level={2}>Desk sections</Heading> : null}
      {sections.length ? (
        <Card style={styles.workListCard}>
          {sections.map((section, index) => {
            const sameDesk = isSameDeskSection(section, expectedHat);
            const count = deskSectionCount(section.key, previewDesk, openCases, unreadThreads);
            const divider = index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border } : null;
            const body = (
              <>
                <View style={styles.workListCopy}>
                  <Text style={[styles.workCardTitle, { color: theme.cardForeground }]}>{section.label}</Text>
                  {section.blurb ? <Text numberOfLines={2} style={[styles.workCardMeta, { color: theme.mutedForeground }]}>{section.blurb}</Text> : null}
                </View>
                {count != null ? (
                  <View style={[styles.countBadge, { backgroundColor: theme.muted }]}>
                    <Text style={[styles.countBadgeText, { color: theme.foreground }]}>{count}</Text>
                  </View>
                ) : null}
                {/* The chevron rides the row that pushes. Same-desk rows have
                    no in-screen section to open, so they stay a static reading. */}
                {sameDesk ? null : <Ionicons name="chevron-forward" size={16} color={theme.mutedForeground} accessibilityElementsHidden />}
              </>
            );
            if (sameDesk) {
              return (
                <View
                  key={section.key}
                  accessible
                  accessibilityLabel={count != null ? `${section.label}, ${count}` : section.label}
                  style={[styles.deskSectionRow, divider]}
                >
                  {body}
                </View>
              );
            }
            return (
              <PressableScale
                key={section.key}
                accessibilityRole="button"
                accessibilityLabel={count != null ? `${section.label}, ${count}` : section.label}
                accessibilityHint={section.blurb}
                onPress={() => { void haptics.select(); router.push(section.href as never); }}
                resting={elevation.level0}
                pressedOpacity={0.82}
                style={[styles.deskSectionRow, elevation.level0, divider]}
              >
                {body}
              </PressableScale>
            );
          })}
        </Card>
      ) : null}
      {queue.length ? <Heading level={2}>Queue</Heading> : null}
      {queue.map((item) => (
        <Pressable key={item.id} accessibilityRole="button" onPress={() => { if (item.href) { void haptics.select(); router.push(item.href as never); } }}>
          {({ pressed }) => (
            <Card style={{ opacity: pressed ? 0.82 : 1 }}>
              <Heading level={3}>{item.title}</Heading>
              <Body muted>{item.subtitle}</Body>
              <Text style={[styles.eyebrow, { color: theme.primary }]}>{item.status}</Text>
            </Card>
          )}
        </Pressable>
      ))}
      {cases.length ? <Heading level={2}>Your issues</Heading> : null}
      {cases.map((item) => (
        <CaseRowPressable key={item.id} reference={item.reference} visible={[item.title, `${item.caseType} · ${memberCaseStep(item)}`]} onPress={() => { void haptics.select(); router.push(`/issue/${item.id}`); }}>
          {({ pressed }) => (
            <Card style={{ opacity: pressed ? 0.82 : 1 }}>
              <Text style={[styles.eyebrow, { color: theme.primary }]}>{item.reference}</Text>
              <Heading level={3}>{item.title}</Heading>
              <Body muted>{item.caseType} · {memberCaseStep(item)}</Body>
            </Card>
          )}
        </CaseRowPressable>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  eyebrow: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  fieldLabel: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  // The shared desk template (b03b): 11px uppercase role eyebrow (brief §B),
  // the display hero value, the hero-plus-two band, and the 48px section index.
  deskHeader: { gap: spacing.xs },
  roleEyebrow: { fontSize: 11, lineHeight: 15, ...typeface.heading, letterSpacing: 0.9, textTransform: 'uppercase' },
  deskHeroValue: { fontSize: 40, lineHeight: 46, ...typeface.controlStrong, letterSpacing: -1 },
  deskKpiRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'stretch' },
  deskSectionRow: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  countBadge: { minWidth: 24, borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 2, alignItems: 'center' },
  countBadgeText: { fontSize: 12, lineHeight: 16, ...typeface.heading, fontVariant: ['tabular-nums'] },
  choice: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, justifyContent: 'center' },
  choiceLabel: { fontSize: 16, lineHeight: 22, ...typeface.controlStrong },
  input: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 16, lineHeight: 22 },
  multiline: { minHeight: 120, textAlignVertical: 'top' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { minHeight: minimumTouchTarget, borderRadius: radii.pill, paddingHorizontal: spacing.md, justifyContent: 'center' },
  chipText: { fontSize: 14, lineHeight: 18, ...typeface.controlStrong },
  workRail: { marginHorizontal: -spacing.lg },
  workRailContent: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  workViewChip: { minHeight: minimumTouchTarget, borderRadius: radii.pill, paddingHorizontal: spacing.lg, justifyContent: 'center' },
  workColumn: { width: 252, gap: spacing.sm },
  workColumnHead: { fontSize: 14, lineHeight: 19, ...typeface.heading, letterSpacing: 0.2 },
  workCard: { borderRadius: radii.md, borderWidth: StyleSheet.hairlineWidth, padding: spacing.md, gap: spacing.xs },
  workChipRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, justifyContent: 'space-between' },
  workChip: { borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  workChipText: { fontSize: 12, lineHeight: 16, ...typeface.heading },
  workFlagRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flexGrow: 1 },
  workFlagText: { fontSize: 12, lineHeight: 16, ...typeface.controlStrong },
  workCardTitle: { fontSize: 15, lineHeight: 20, ...typeface.control },
  workCardMeta: { fontSize: 13, lineHeight: 18, ...typeface.bodyMedium },
  workCardFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  workSection: { gap: spacing.sm },
  workListCard: { paddingVertical: 0, paddingHorizontal: 0, gap: 0 },
  // b04b rights reading list: 64px index rows, and the script at reading
  // measure (17px/1.55) in the reading view.
  rightsIndexCard: { paddingVertical: 0, paddingHorizontal: 0, gap: 0 },
  rightsIndexRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  rightsScript: { fontSize: RIGHTS_SCRIPT_SIZE, lineHeight: Math.round(RIGHTS_SCRIPT_SIZE * 1.55) },
  workListRow: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  workListCopy: { flex: 1, gap: 2 },
  workNote: { gap: 2 },
  workTrack: { height: 6, borderRadius: radii.pill, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  workFill: { height: '100%', borderRadius: radii.pill },
  workTileGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  workTile: { flexGrow: 1, flexBasis: '22%', borderRadius: radii.md, borderWidth: StyleSheet.hairlineWidth, padding: spacing.md, gap: 2 },
  workTileValue: { fontSize: 20, lineHeight: 24, ...typeface.heading },
  capitalize: { textTransform: 'capitalize' },
  handshakeMeta: { flex: 1, textAlign: 'right' },
  flex: { flex: 1 },
  liveStatus: { borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 4 },
  liveStatusText: { fontSize: 11, lineHeight: 15, ...typeface.controlStrong, textTransform: 'capitalize' },
  optionStack: { gap: spacing.sm },
  optionRow: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  optionDot: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  optionDotFill: { width: 10, height: 10, borderRadius: 5 },
  optionLabel: { flex: 1, fontSize: 16, lineHeight: 22, ...typeface.controlStrong },
  buttonPair: { gap: spacing.sm },
  timelineRow: { minHeight: 58, flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  timelineDot: { width: 10, height: 10, borderRadius: 5, marginTop: 5 },
  timelineLine: { position: 'absolute', left: -17, top: 23, bottom: -15, width: StyleSheet.hairlineWidth },
  timelineAction: { fontSize: 14, lineHeight: 19, ...typeface.controlStrong, textTransform: 'capitalize' },
  healthScore: { fontSize: 44, lineHeight: 48, ...typeface.controlStrong, letterSpacing: -2 },
  healthSummaryRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: spacing.sm, rowGap: spacing.xs },
  healthSummaryTitle: { flexShrink: 1 },
  // The measure name keeps its natural width (never a fixed column that
  // breaks it inside a word); the meter moves below it when both do not fit.
  driverRow: { minHeight: 34, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: spacing.sm, rowGap: 4 },
  driverLabel: { minWidth: 126, maxWidth: '100%', fontSize: 12, lineHeight: 16, ...typeface.control, textTransform: 'capitalize' },
  driverMeter: { flexGrow: 1, flexBasis: 120, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  driverTrack: { flex: 1, height: 8, borderRadius: radii.pill, overflow: 'hidden' },
  driverFill: { height: '100%', borderRadius: radii.pill },
  driverValue: { minWidth: 28, fontSize: 12, lineHeight: 16, textAlign: 'right', fontVariant: ['tabular-nums'] },
  healthDriverInputRow: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  healthDriverInputLabel: { flex: 1, fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  healthDriverInput: { width: 96, minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, fontSize: 16, lineHeight: 22, textAlign: 'right', fontVariant: ['tabular-nums'] },
  sparkRow: { minHeight: 108, flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, paddingTop: spacing.md },
  sparkPoint: { flex: 1, minWidth: 32, alignItems: 'center', justifyContent: 'flex-end', gap: spacing.xs },
  sparkBar: { width: 18, borderTopLeftRadius: 5, borderTopRightRadius: 5, opacity: 0.86 },
  sparkDate: { fontSize: 11, lineHeight: 15, ...typeface.controlStrong },
  coachingNote: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.md, gap: 3 },
  coachingForm: { gap: spacing.sm },
});
