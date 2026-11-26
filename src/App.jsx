import { createMemberOutboxExecutors } from "./lib/memberOutboxExecutors.js";
import { createAccountSessionClient } from "./lib/accountSessionClient.js";
import { createSessionBoundWriter } from "./lib/sessionBoundWriter.js";
import { createSessionBoundDataClient } from "./lib/sessionBoundDataClient.js";
import { BusyButton } from "./components/BusyControls.jsx";
import { createDemoMessageReactionToggle } from "./lib/demoMessageReactions.js";
import { createChapterAccessApi, createGrievancePrivacyApi } from "./lib/chapterAccessApi.js";
import { createUnitSettingsApi } from "./lib/unitSettings.js";
import { loadNoticeAudiences, publishNoticeForAudience } from "./lib/noticeAudience.js";
import { StewardSharedAccessPanel } from "./features/chapterAccess/StewardSharedAccessPanel.jsx";
import { useFreeCosmetics } from "./lib/useFreeCosmetics.js";
import { cosmeticCopy, selectedCosmetic } from "./lib/freeCosmetics.js";
import { createDemoCaseworkApi } from "./lib/demoCaseworkApi.js";
import { applyMessageTombstone } from "./features/messaging/bodyLifecycle.js";
import { messageActionRequest } from "./features/messaging/actions.js";
import { castChannelPollVote, loadThreadChannelPolls } from "./features/messaging/channelPollsApi.js";
import { refreshMessageActivityAfter } from "./features/messaging/messageActivityRefresh.js";
import { shareAndConfirmResource } from "./features/messaging/sharedResourceConfirm.js";
import { confirmReportPreferences } from "./lib/reportPreferencesCache.js";
import { createChannelHereReminder } from "./features/messaging/remindHere.js";
import { exactMessageHref, withWorkflowReturn, workflowDestination, safeWorkflowReturn, workflowReferenceFromHref, workspaceRouteWithTransport } from "./features/connectedWorkflows/navigation.js";
import { createConnectedWorkflowApi } from "./features/connectedWorkflows/api.js";
import { isPermissionRefusal, isSourceGone, loadPrivateMessageLanding, loadTaskConversationLanding, loadChannelThreadLanding } from "./features/connectedWorkflows/landing.js";
import { channelHistoryApi } from "./features/messaging/channelHistory.js";
import { privateHistoryApi } from "./features/messaging/privateHistory.js";
import { createDemoConnectedWorkflowApi } from "./features/connectedWorkflows/demoApi.js";
import { ConnectedRecordActions } from "./features/connectedWorkflows/ConnectedRecordActions.jsx";
import { ConnectedEventLanding } from "./features/connectedWorkflows/ConnectedEventLanding.jsx";
import { ConnectedTaskLanding } from "./features/connectedWorkflows/ConnectedTaskLanding.jsx";
import { ConnectedReminders } from "./features/connectedWorkflows/ConnectedReminders.jsx";
import { markChapterSpaceRead, orderGuideMessages } from "./lib/memberApi.js";
import { liveOrganizationLabelApi, memberSwitchesFromSettings, organizationConfigurationWithSetting, validValue as validSettingValue } from "./lib/organizationSettingsAdmin.js";
import { customNavLinks } from "./lib/customNavLinks.js";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import { useBusyScope } from "./lib/busyWrite.js";
import { StaffRouteRefusal } from "./components/StaffRouteRefusal.jsx";
import { AppNotFound } from "./components/AppNotFound.jsx";
import { captureDemoAction, captureProductAction, captureSanitizedDiagnostic, isDemoAnalyticsEnabled, productAnalyticsSignal, startObservability, syncObservabilityContext } from "./lib/deferredObservability.js";
import { useMemberFeatureFlag } from "./lib/useMemberFeatureFlag.js";
import { useToastLifetime } from "./lib/useToastLifetime.js";
import { useModalExit } from "./lib/useTransitionPresence.js";
import { applyPageMetadata } from "./lib/pageMetadata.js";
import { useWorkspaceDocumentTitle } from "./lib/workspaceTitle.js";
import { useSignInPathMetadata } from "./lib/signInPathMetadata.js";
import { inviteMember as sendMemberInvitation, memberSentInvitationsEnabled, resendMemberInvitation, revokeMemberInvitation } from "./lib/adminInvitationApi.js";
import { recoverMemberSigninAddress, reissueMemberPassword } from "./lib/adminSigninRecoveryApi.js";
import { loadCalendarOAuthStatus, startCalendarOAuth } from "./lib/calendarOAuthClient.js";
import { addCaseworkBargainingEvent, addCaseworkBargainingProposal, addCaseworkManagementAddendum, acknowledgeCaseworkAlert, bulkUpdateCaseworkCases, listCaseworkMacros, saveCaseworkMacro, applyCaseworkMacro, recordCaseworkCaseExport, listCaseNoteMentionCandidates, addCaseworkCaseNote, createCaseworkAlert, createCaseworkBargainingWorkspace, createCaseworkDeadline, renameCaseworkCase, listStewardPrivateReminders, saveStewardPrivateReminder, attachStewardPrivateReminder, deleteStewardPrivateReminder, createCaseworkReminder, decideCaseworkDeadlineExtension, grantCaseworkAccess, loadCaseDashboards, loadCaseworkCase, loadCaseworkManagementWindow, loadCaseworkHistory, loadCaseHistory, loadCaseStewardEmails, loadCaseworkHub, loadMemberRetaliationReports, loadMyCaseOutcome, getMyCaseManaged, linkCaseworkCases, logCaseworkManagementBehavior, requestCaseworkDeadlineExtension, revokeCaseworkAccess, reviewCaseworkRetaliationPattern, saveCaseworkIntakeDraft, scanCaseworkRetaliationPatterns, scoreCaseworkCase, setCaseworkBargainingStatus, setCaseworkReminderStatus, setCaseworkRestriction, submitCaseworkRetaliationReport, transitionCaseworkBargainingProposal, withdrawCaseworkRetaliationReport, listOpenCaseworkDeadlines, setCaseworkDeadlineStatus } from "./lib/caseworkApi.js";
import { createCaseDeskApi } from "./lib/caseDeskApi.js";
import { applyDeviceParitySnapshot, applyDeviceParityState, clearDeviceParityState, deviceParitySnapshot, deviceParityValue, subscribeDeviceParityChanges, useDeviceParityState } from "./lib/deviceParity.js";
import { createSessionPeerContactApi } from "./lib/peerContactSession.js";
import { PEER_CONTACT_DOWN, PEER_CONTACT_UP, sanitizePeerContactProjection } from "./lib/peerContactBridge.js";
import { AuthScreen } from "./components/AuthScreen.jsx";
import { IdentityThemeScope } from "./components/IdentityThemeScope.jsx";
import { BrandMark } from "./components/BrandMark.jsx";
import { CreateOrganizationGate } from "./features/openSignup/CreateOrganizationGate.jsx";
import { createdOrganizationNextHref } from "./lib/openSignup.js";
import { loadOrganizationName, OrganizationNameProvider } from "./lib/organizationName.js";
import { StewardPresenceProvider } from "./components/NoStewardNote.jsx";
// No PublicLanding is mounted: Union Ground's front door is LearnView at "/"
// (see standaloneViews).
import { STAFF_WORK_RAIL_ITEM } from "./components/BottomNav.jsx";
import { DesktopRail } from "./components/DesktopRail.jsx";
import { DemoHatSelector } from "./components/DemoHatSelector.jsx";
import { CommandPalette } from "./components/CommandPalette.jsx";
import { railIconName } from "./components/RailIcons.jsx";
import { MobileCardNav } from "./components/MobileCardNav.jsx";
import { MobileTopBar } from "./components/MobileTopBar.jsx";
import { ChapterSheet } from "./components/ChapterSheet.jsx";
import { ChapterCatalogWorkspace, ChapterRail } from "./components/ChapterRail.jsx";
import { ChunkBoundary, ChunkReady } from "./components/ChunkBoundary.jsx";
import { cloneDemoFormTemplates, demoData, loadDemoData } from "./data/demoData.js";
import { createLiveChapterSelector, normalizeDemoChapters, normalizeLiveChapters, normalizeSampleChapters } from "./lib/chapterRail.js";
import { ChapterMembershipSwitch } from "./components/ChapterMembershipSwitch.jsx";
import { grantMemberChapterMembership, loadMemberChapterMemberships, requestChapterConnectionSetup, requestChapterUnionOrgBinding, revokeMemberChapterMembership, searchUnionOrganizations, setMemberChapterRole, shareChapterHandshakeDocument, switchMyChapter, verifyChapterConnectionSetup } from "./lib/chapterLifecycleApi.js";
import { chapterLeadershipApiFor } from "./lib/chapterLeadershipApi.js";
import { clearOrganizationCatalogPlacement, getOrganizationCatalogPlacement, importOrganizationStructure, setOrganizationCatalogPlacement } from "./features/orgSetup/setupApi.js";
import { requestIntakeReview } from "./features/intakeQueue/intakeApi.js";
import { requestTopicSend } from "./features/intakeQueue/topicSendApi.js";
import { boundedSampleFetch } from "./lib/sampleRequest.js";
import { addStewardCaseNote, listStewardCaseDeadlines } from "./features/caseNotes/api.js";
import { claimMemberCase, listUnassignedChapterCases, loadMemberCaseDetails, openMemberCase, searchCaseMembers } from "./features/caseIntake/api.js";
import { addCaseUpdate, addChapterTaskAttachment, addChapterTaskComment, adminSearchRecoveryMembers, adminSearchMembers, checkInToEvent, approveAndOpenFormCase, approveForm, cancelAdminEvent, loadMemberEventQuorum, setMemberEventQuorum, createAdminEvent, createChapterTask, createChapterTaskFromTemplate, convertChapterTaskToTemplate, createChapterTaskFromSource, loadAuthorizedChapterTask, createChapterDocument, createChapterHandshake, recordWorkspacePageView, updateChapterHandshakeStatus, createChapterRecord, createChapterSpace, createChapterThread, updateChapterSpaceContent, updateChapterDocumentContent, updateChapterRecordContent, createGovernanceRequest, createMemberIntake, triageMemberIntake, convertMemberIntake, createMemberCase, addAppointmentBlackout, closeAdminGovernanceRequest, bookAppointment, cancelAppointment, getAppointmentSlots, getStewardRescheduleSlots, getBookableStewards, generateMemberDataExport, grantMemberRole, createAdminChapter, loadAdminMemberDirectory, loadMfaRecoveryCodeStatus, exportMemberDirectoryCsv, updateAdminChapter, loadStewardAppointments, loadStewardAppointmentsPage, loadCalendarImportStatus, loadChapterAppointments, loadChapterAppointmentCandidates, reassignChapterAppointment, listChapterSpaceMembers, markAppointmentOutcome, removeAppointmentBlackout, removeChapterTaskAttachment, searchChapterSpaceMembers, setChapterSpaceMember, removeCalendarConnection, requestCalendarConnection, rescheduleAppointment, saveMyReportPreferences, listMemberSavedViews, saveMemberSavedView, deleteMemberSavedView, submitWeeklyQuestion, boostWeeklyQuestion, promoteWeeklyQuestion, setAppointmentSchedule, setAppointmentWindows, insertChapterWorkstream, ensureChapterDefaultWorkstream, inviteCosigner, chapterTaskFromRow, chapterTaskDependencyFromRow, chapterTaskSubtaskFromRow, chapterTaskAssignmentFromRow, withTaskAssignees, createChapterTaskSubtask, deleteChapterTaskSubtask, watchChapterTask, unwatchChapterTask, createChapterTaskDependency, deleteChapterTaskDependency, loadChapterTaskReport, loadAdminDesk, loadAdminEvents, loadMemberInvitations, setMemberChapterDisplayTitle, loadFailedLoginInbox, dispositionFailedLoginAttempt, loadAdministrativeEvidence, addFieldNoteEvidence, draftFieldNotePacket, executeAdministrativeObjectAction, updateOrganizationLabel, loadOrganizationWorkloadCategories, saveOrganizationWorkloadCategories, loadOrganizationWorkloadConfiguration, saveOrganizationWorkloadConfiguration, updateOrganizationSetting, setOrganizationSetting, resetOrganizationSetting, loadOrganizationConfigurationAudit, saveOrganizationRetentionPolicy, previewOrganizationRetentionRun, authorizeOrganizationRetentionRun, executeOrganizationRetentionRun, loadAdminFormTemplates, loadAdvisorDesk, assignMemberCase, ASSIGN_LEAVE_UNCHANGED, loadCaseAssignmentCandidates, loadStaffCandidates, loadCoordinatorCases, loadCoordinatorDesk, coordinatorUpdateCase, coordinatorAddCaseNote, coordinatorLogCaseContact, coordinatorRecordCaseOutcome, filterCoordinatorFocus, loadSampleChapterCatalog, TASK_COMMENT_LIMIT, loadStewardDesk, loadStewardRequests, loadStewardThreads, loadStewardForms, loadStewardBroadcasts, getBroadcastReadCounts, loadStewardThreadMessages, loadConversationLegalHold, placeConversationLegalHold, releaseConversationLegalHold, listOrganizationLegalHolds, listLegalHoldConversations, loadVpOverview, markVpCaseReviewed, listMemberSessions, revokeMemberSession, hasPushSubscription, mergeChapterWorkstreams, moveChapterTask, previewChapterWorkstreamMerge, renameChapterWorkstream, restoreChapterTask, revokeMemberRole, softDeleteChapterTask, deleteAdminEvent, loadEventsDesk, loadAuthorizedCalendarEvent, restoreAdminEvent, updateAdminEvent, setAdminEventAgenda, setAdminEventRsvpOpen, listAdminEventDrafts, saveAdminEventDraft, deleteAdminEventDraft, upsertFormTemplate, deactivateFormTemplate, reactivateFormTemplate, updateChapterTask, updateChapterTaskTemplateDetails, setChapterTaskAssignees, respondToCosign, markBroadcastRead, sendChapterTaskMessage, sendChapterThreadPost, conversationDateLabel, markConversationRead, markNotificationsRead, publishMemberBroadcast, requestEventCheckinToken, requestSteward, retractMemberBroadcast, listAnnouncementDrafts, submitMemberRequest, listMyMemberRequests, listMemberRequests, decideMemberRequest, listMyMemberNotices, getMemberNoticeReceipts, resolveAnnouncementDraft, retireChapterKnowledgeArticle, returnForm, getCalendarFeedStatus, revokeCalendarFeedToken, rotateCalendarFeedToken, addMemberFormFile, getFormFilingStatus, memberFormFileBlob, removeMemberFormFile, readStoredFormDraft, saveFormDraft, saveGuideExchange, saveChapterKnowledgeArticle, saveRightsProgress, scanEventCheckin, sendMemberMessage, startMemberConversation, startMemberStewardConversation, getMyStewardContactVisibility, setMyStewardContactVisibility, listCrossChapterPeers, setCrossChapterPeerMute, getMyProfileDetails, setMyProfileDetails, toggleMemberMessageReaction, toggleMemberSavedMessage, scheduleMemberMessage, cancelScheduledMemberMessage, createMemberMessageReminder, cancelMemberMessageReminder, redactMemberMessage, sendMemberResource, sendStewardResource, sendStewardReply, listScheduledMemberMessages, listMemberContactNotes, createMemberContactNote, listStewardEmailIntakes, reviewStewardEmailIntake, createEventFromMemberMessage, setStaffMfaPolicy, setMemberMfaPolicy, setCompassAiEnabled, setCompassAiRoleLimit, attestCompassAiProvider, stewardStartFormReview, subscribeToChapterTaskBoard, subscribeToNotificationInserts, subscribeToPush, unsubscribeFromPush, urlBase64ToUint8Array, submitBallot, submitEventRsvp, submitForm, submitWorkloadLog, setWorkloadReminderPreferences, submitSurvey, signMemberForm, isFormChangedSinceReview, isFormNotEditable, isCosignChangedSincePreview, isFormSavedElsewhere, triageStewardRequest, updateMemberCase, updateMemberProfile, updateMemberSettings, withdrawCosign, addChapterTaskFile, removeChapterTaskFile, chapterTaskFileBlob, deadlineLabel, getMemberOrganizationStructure, addMemberCaseFile, removeMemberCaseFile, memberCaseFileBlob, recheckPrivateFile, prepareMemberSignOut, getMemberStewardMessageAvailable, discardFormDraft, memberFormStillExists } from "./lib/memberApi.js";
import { createMemberSessionLoader, notificationRefreshResources, MEMBER_GUIDE_RESOURCES, MEMBER_GUIDE_HISTORY_RESOURCES, learningUndoMemberResources, memberMutationResources, memberResourcesForRoute, MEMBER_SEARCH_PROJECTION_KEYS } from "./lib/memberSessionLoader.js";
import { checklistDescription, nextTemplateSteps, recommendedStatusForStep, taskTemplateDetailsFromValues, taskTemplateValuesFromDetails, templateFieldsToPayload, validateTaskTemplateValues } from "./lib/taskTemplates.js";
import { signOutSafely } from "./lib/sessionManagement.js";
import { sessionRevocationWatchApplies, watchSessionRevocation } from "./lib/sessionRevocationWatch.js";
import { withLoadDeadline } from "./lib/loadDeadline.js";
import AccountDeletionCompletion from "./components/AccountDeletionCompletion.jsx";
import { deletionCompletion } from "./lib/accountDeletionCompletion.js";
import { downloadMemberDataExport, requestAccountDeletion } from "./lib/accountLifecycleApi.js";
import { canShareFormFiling, downloadFormFiling, shareFormFiling, triggerFormFilingDownload } from "./lib/formFilingClient.js";
import { renderFormFilingPdf } from "./lib/formFilingPdf.js";
import { confirmedTaskProjection, createBoardRefetchQueue, localTaskRowWins, mergeExistingRows, pruneExpiredDoneTasks, scheduleDoneTaskExpiry } from "./lib/boardSync.js";
import { setDemoFormTemplateActive, upsertDemoFormTemplate } from "./lib/demoFormTemplateRegistry.js";
import { closeCampaign, deleteCampaignDraft, loadCampaigns, publishCampaign, saveCampaignDraft } from "./lib/campaignApi.js";
import { loadAppointmentNotes, loadScheduleDetails, saveAppointmentNote, saveScheduleDetails } from "./lib/appointmentDetailsApi.js";
import { PersonalReminders } from "./features/personalReminders/PersonalReminders.jsx";
import { claimChapterLeadership, listChapterLeadershipClaims, listOfficerRemovalTargets, loadChapterLeadershipRecovery, loadOfficerRemovalDetails, recordOfficerRemovalOutcome, rejectChapterLeadershipClaim, saveOfficerRemovalDraft, withdrawChapterLeadershipClaim } from "./lib/governanceApi.js";
import { createDemoCampaignApi } from "./lib/demoCampaigns.js";
import { createSessionGuard, isAssuranceDowngrade, sortNewestFirst, sortOldestFirst, unreadCount } from "./lib/sessionGuard.js";
import { clearMemberHomeSlice } from "./lib/memberHomeSlice.js";
import { endFormDraftSession, replayFormDraft } from "./lib/formDraftSessions.js";
import { createOutboxStore, forgetDepartedMemberDevice, deleteSnapshot, enqueueWrite, holdQueuedEntryWhile, isOfflineError, isRequestTimeoutError, pendingCount, purgeSensitiveEntries, replayNotice, replayQueue, sessionStamp } from "./lib/outbox.js";
import { requestCaseHelp, requestFieldNotesPacket, requestGuideReply } from "./lib/guideApi.js";
import { demoCompassAnswer } from "./lib/demoCompass.js";
import { IDENTITY_WORKSPACE_THEME, resolveRenderedWorkspaceTheme } from "./lib/workspaceTheme.js";
import { demoBoardSlice, mergeDemoSlice } from "./lib/demoBridge.js";
import { pageStewardAppointments, pageStewardBroadcasts, pageStewardForms, pageStewardRequests, pageStewardThreadMessages, pageStewardThreads } from "./lib/stewardDeskPaging.js";
import { resetMemberMfa } from "./lib/adminMfaApi.js";
import {
  createOrganizingBargainingProposal,
  createOrganizingCampaign,
  correctOrganizingRatification,
  loadUnionLifecycleWorkspace,
  openOrganizingBargainingCycle,
  recordOrganizingBargainingSessionOutcome,
  recordOrganizingFirstContract,
  recordOrganizingRatification,
  recordResistanceIncident,
  resolveRatificationIntegrityHold,
  scheduleOrganizingBargainingSession,
  setOrganizingCampaignStatus,
  transitionOrganizingBargainingCycle,
  transitionOrganizingBargainingProposal,
  transitionOrganizingCampaign,
} from "./lib/lifecycleApi.js";
import { readAuthStorageSessionLineage, sameAuthSessionLineage, sessionIDFromAccessToken, storageEventClosesAuthSession, storageEventExplicitlySignsOutSession } from "./lib/exactSessionStorage.js";
import { appBackendIsSampleProject, appBackendKind, appAuthStorageKey, appAuthStorageUnavailable, appAuthSessionIsClosed, authStorageAdapter, clearCapturedAppSessionLocally, clearRefusedAppSessionLocally, createCapturedAppAccountClient, createCapturedAppSessionRpcClient, verifyCapturedAppSession, hasAppBackend, appSupabase as supabase } from "./lib/supabase.js";
import { createOrganizationFormDocumentsApi } from "./lib/organizationFormDocumentsApi.js";
import { createFormAutofillApi } from "./lib/formAutofill.js";
import { requiresBackendConfig } from "./lib/appMode.js";
import { allowsAnonymousDemoEntry, hasDemoQuery, sampleTourHref, shouldEnterDemo, withDemoRider } from "./lib/demoOrigin.js";
import { appViewForPath, memberCoordinationAliasPath, normalizeAppPath, unknownAppPath } from "./lib/appRoutes.js";
import { abortableRpcClient, createWorkspacePageViewRecorder } from "./lib/workspacePageViews.js";
import { DEFAULT_SAMPLE_HAT, defaultSamplePersona, isSamplePersonaEmail, retireRefusedSession, retiredHostRefusesSession, samplePersonaForHat, samplePersonas } from "./lib/sampleBackend.js";
import { beginSampleHatChoice, createSampleHatTransitionQueue, resolveSampleHatRollback } from "./lib/sampleHatTransition.js";
import { lazyView } from "./lib/lazyView.js";
import { workTab } from "./alt/tabbar.js";
import { ALT_SHELL, CLASSIC_SHELL, MEMBER_SHELL_FLAG, SHELL_QUERY_PARAM, explicitShellChoice, memberShellExperimentEligible, readMemberShellPreference, resolveMemberShell, tasksBoardHref, withShellParam, writeMemberShellPreference } from "./alt/altShell.js";
import DotGrid from "./alt/DotGrid.jsx";
import { memberPageTitle } from "./alt/nav.js";
import { recordItems, recordTarget } from "./alt/recordIndex.js";
import { ORGANIZE_ROLES, STAFF_PLANES, STAFF_TOOLS, STAFF_TOOL_ROLES, STAFF_VIEWS, planeRoles, staffToolAllowsHat } from "./lib/staffPlanes.js";
import { CHAPTER_OFFICE_ROLES, selectedChapterOfficeRole, canSelectChapterOfficeRole } from "./lib/chapterOfficeRoles.js";
import { clearActingHat, entryHatForView, readActingHat, writeActingHat } from "./lib/actingHat.js";
import { forgetNoticeChapters } from "./features/chapterNotices/noticeGlow.js";
import { ORGANIZATION_GRANT_AUTHORING_VIEWS, StaffAuthoringContext } from "./components/StaffAuthoringHint.jsx";
import { MemberRequestsPanel } from "./features/requests/MemberRequestsPanel.jsx";
import { NOTICE_COMPOSER_PATH, NOTICE_HATS, OfficerNoticeDesk, OfficerNoticeHint } from "./features/notices/OfficerNoticeDesk.jsx";
import { fencedChapterWrite } from "./lib/chapterWriteFence.js";
import { OrganizationRoleRefusal } from "./components/OrganizationRoleRefusal.jsx";
import { organizationWorkspaceAccess } from "./lib/organizationWorkspaceAccess.js";
import { buildQaActor } from "./lib/mi1QaWiring.js";
import { createInMemoryQaStore, createQaStoreAdapter } from "./features/qa/index.js";
import { withObjectUrl } from "./lib/privateFileAccess.js";
import { rpcRefusalKey, rpcErrorKeyStrict, rpcErrorTextAtRender } from "./lib/rpcErrorText.js";
import { focusStaffSection, STAFF_ROLE_NAVIGATION, STAFF_ROLE_SECTION_IDS, staffTabPagesFor, visibleStaffNavigation } from "./lib/staffNavigation.js";
import { canLead } from "./lib/payLeaders.js";
import { canManageMemberSupport } from "./features/memberSupport/authorization.js";
import { canManageCoordination } from "./features/coordination/authorization.js";
import { WorkspacePages } from "./components/WorkspacePages.jsx";
import { TAB_PAGE_GROUPS, isStaffOnlyWorkspaceTabPath, workspacePageForLocation } from "./lib/workspacePages.js";
import { advisorOverviewOnly, coordinatorKpisOnly, useDeskPrefetchStore, useDeskPrefetchVisit, workspaceSectionAt } from "./lib/deskPrefetch.js";
import { allowWorkspaceNavigation } from "./lib/navigationGuard.js";
import { AutomationWorkflowLink } from "./features/automation/AutomationWorkflowLink.jsx";
import { MEMBER_WORK_ITEMS } from "./lib/mobileNav.js";
import { featureActorIdentityKey } from "./lib/featureActorIdentity.js";
import { buildMi1FeatureActor } from "./lib/mi1FeatureWiring.js";
import { buildMi1AnalyticsActor } from "./lib/mi1AnalyticsWiring.js";
import { buildOrganizationIntelligenceActor } from "./lib/organizationIntelligenceWiring.js";
import { buildCoordinationActor } from "./lib/mi1CoordinationWiring.js";
import { buildPayActor, payRolesForSelectedHat } from "./lib/mi1PayWiring.js";
import { buildAccessActor, accessRolesForSelectedHat } from "./lib/mi1AccessHistoryWiring.js";
import { createAccessRpcAdapter } from "./features/accessHistory/index.js";
import { createNavigationPreferenceSaveQueue, loadDemoNavigationPreferences, normalizeShortcutKeys, normalizeWidgetOrder, saveDemoNavigationPreferences, SHORTCUT_CATALOG } from "./lib/navigationPreferences.js";
import { findStewardConversation, MESSAGE_WORKFLOW_DEFAULT } from "./lib/messageWorkflow.js";
import { isEditableShortcutTarget } from "./lib/commandPalette.js";
import { keyboardShortcutsEnabled, setKeyboardShortcutsScope, useKeyboardShortcutsEnabled } from "./lib/keyboardShortcuts.js";
import { buildSearchIndex, memberOpenableCaseEntries, searchEntries } from "./lib/searchIndex.js";
import { CASE_SEARCH_MAX_LIMIT, searchMemberCases } from "./features/cases/caseSearchApi.js";
import { dateTimeFormat, languageLoaded, loadLanguage, localeFor, t as translate } from "./lib/i18n.js";
import { bootLanguage } from "./lib/bootLanguage.js";
import { accountLanguage, rememberAccountLanguage } from "./lib/accountLanguage.js";
import { carriesSpanishEdit, spanishValue } from "./lib/bilingualContent.js";
import { useLoadedLanguage } from "./lib/useLoadedLanguage.js";
import { LanguageProvider, organizationTranslator, TERM_LABEL_KEYS, useLang } from "./lib/LanguageContext.jsx";
import { WORKLOAD_CATEGORY_LABEL_KEYS, liveWorkloadCategoriesApi, sampleWorkloadCategoriesApi } from "./lib/workloadCategories.js";
import { liveWorkloadConfigurationApi } from "./lib/workloadConfiguration.js";
import { NativeAppNudge } from "./components/NativeAppNudge.jsx";
import { LearningPeriodBanner, LearningPeriodProvider, learningToastAction, useLearningPeriodController } from "./features/learningPeriod/LearningPeriod.jsx";
import { createLearningPeriodApi, withoutOrganizationControls } from "./features/learningPeriod/api.js";
import { useLearningUndone } from "./features/learningPeriod/undoneSignal.js";
import { LegalChangeNotice } from "./components/LegalChangeNotice.jsx";
import { choosePasswordFor } from "./features/memberHome/ChoosePasswordCard.jsx";
import { LegalAcceptancePrompt } from "./components/LegalAcceptancePrompt.jsx";
import { legalAcceptanceReadNeeded, legalAcceptanceRequirement, loadLegalAcceptanceState, recordedLegalAcceptances } from "./lib/legalAcceptance.js";
import { QuarterlySurveyGate } from "./features/engagement/QuarterlySurveyGate.jsx";
import { OnboardingHud } from "./components/OnboardingHud.jsx";
import { CHAPTER_SETUP_CHANGED_EVENT, CHAPTER_SETUP_UNDO_KINDS, ONBOARDING_GUIDE_ACTION_EVENT, announceChapterSetupAfter, memberOnlyAccount, onboardingGuideSwitchesOn, readGuideCompleteDismissed } from "./lib/onboardingGuide.js";
import { useMemberOnboardingGuide } from "./lib/useMemberOnboardingGuide.js";
import { plan as planMemberGuide } from "./features/onboardingGuideEngine/engine.js";
import { proposedSwitchOn } from "./features/onboardingGuideEngine/memberLayers.js";
import { COACH_MARK_ID, MemberCoachMark, countGuideAction, MemberFeatureGuide, MemberGuideList, noteGuideNavigation, useCoachMarkFacts, useMemberGuideLayers } from "./features/onboardingGuideEngine/MemberGuideLayers.jsx";
import { deleteChapterUnit, listChapterUnits, loadLocalProfile, saveChapterUnit, saveLocalProfile } from "./features/orgSetup/unitsApi.js";
import { createSeniorityApi } from "./features/seniority/api.js";
import { guideSteward, stewardPresence, stewardsForViewer } from "./lib/stewardConversations.js";
import { useStewardMessageAvailability } from "./lib/useStewardMessageAvailability.js";
import { ORG_START_SWITCH } from "./features/onboardingGuideEngine/orgStart.js";
import { useOrganizationStartGuide } from "./features/onboardingGuideEngine/orgStartAdapter.js";
import { DeferredOrgStartGuide } from "./features/onboardingGuideEngine/DeferredOrgStartGuide.jsx";
import { StaffFeatureGuide, StaffGuideList } from "./features/onboardingGuideEngine/StaffGuides.jsx";
import { roleSwitchStepId, staffGuideFor, withStaffGuideActions } from "./features/onboardingGuideEngine/staffGuides.js";
import { useStaffOnboardingGuide } from "./features/onboardingGuideEngine/staffGuideAdapter.js";
import { siteGuideEnabled } from "./lib/siteGuide.js";
import { withoutDuesNav } from "./lib/duesNavigation.js";
import { useOrganizationRunsDues } from "./lib/useOrganizationRunsDues.js";
import { suggestedQuestionsFor } from "./features/compass/suggestedQuestions.js";
import { staffDataAnswersEnabled } from "./features/compass/dataTopics.js";
import { COMPASS_PAGE_KEYS, caseHelpEnabled, caseHelpIncludesNarrative, pageAwareHelpEnabled } from "./features/compass/pageHelp.js";
import { fieldNotesPacketEnabled, fieldNotesPacketNoteLimit } from "./features/compass/fieldNotesPacket.js";
import { useCompassHomeContent } from "./features/compass/useCompassHomeContent.js";
import { actionOffersEnabled, compassAssistantEnabled, contextualNudgesEnabled, presentNudges, setCompassAnswerPinned } from "./features/compass/actionOffers.js";
import { CompassPinnedAnswers } from "./features/compass/CompassPinnedAnswers.jsx";
import { templateByKey } from "./lib/formTemplates.js";
import { highestOfficeKey } from "./lib/staffPlaneStyles.js";
import { TodayView } from "./views/TodayView.jsx";
import { clearNavPinsForUser, clearNavUsageForUser, navUsageEnabled, useNavUsage } from "./features/memberHome/useNavUsage.js";
import { learningSectionFromLocation, learningSectionPath } from "./features/learningContent/routes.js";
import { ISSUE_DESTINATIONS } from "./features/issueIntelligence/model.js";
import { ATTENTION_SHORTCUTS, attentionShortcutsEnabled, readNextActions } from "./features/caseSignals/model.js";
import { VIEW_SUPPORT_EMAIL, AppLoadingScreen, pathViews, staffToolByPath, useOpenSignupAvailable } from "./MemberShellShared.jsx";
// Union Ground surfaces: the organizing lifecycle (Organize plane), the
// worker Work list, and the public front door (Learn, Connect, retired legacy
// addresses). OrganizeView is lazy like the other planes; the public pages are
// static because they are a signed-out stranger's first paint.


const SETTINGS_APPEARANCE_HIDDEN = Object.freeze(["settings-appearance"]);

const SETTINGS_REQUESTS_HIDDEN = Object.freeze(["settings-requests"]);

// How long the route-chunk warm-up waits after a member's data resolves before
// it asks for idle time (see the warm-up effect in MemberApp).
const WARM_UP_DELAY_MS = 3000;

// A route waiting on an unknown role projection re-reads it after 2, 4 and 8 s
// before leaving the member with Try again.
const ROLE_REREAD_DELAY_MS = 2000;

const ROLE_REREAD_ATTEMPTS = 3;

// REQ-UG-STEWARD-MESSAGES-LOADING-FOLLOWUP-20261102: one status group
// for every in-shell wait. The logo, the words and an optional retry sit
// together; only the words are the polite live region, so a screen reader hears
// the wait once and the retry stays an ordinary button after it. No aria-busy:
// the group only unmounts, and a busy ancestor can hold back that announcement.
function ViewLoading({ label, action = null, ...rest }) {
  return (
    <div className="view-loading" {...rest}>
      <span className="loading-screen__brand" aria-hidden="true"><BrandMark size={48} /></span>
      <p role="status" aria-live="polite" aria-atomic="true">{label}</p>
      {action}
    </div>
  );
}

// Draws nothing. Its effect runs only when the Suspense boundary around it
// commits, so beside a page it fires once that page has really drawn, not
// while its chunk is still loading behind the boundary's fallback.
// A demo role switch's focus request survives only its own navigation: any
// navigation to another view drops it, so it never fires later .
export function sampleHatFocusAfterNavigation(pending, nextView) {
  return pending === nextView ? pending : null;
}

// The route gate's redirects use setView. While the switch's wait is up they
// are the interim /m on the way; after it, one to another view drops it too.
export function sampleHatFocusAfterGate(pending, targetView, transitioning) {
  return transitioning ? pending : sampleHatFocusAfterNavigation(pending, targetView);
}

export function AfterPageCommit({ onCommit }) {
  useEffect(() => { onCommit(); }, [onCommit]);
  return null;
}

// TodayView stays a static import on purpose: it is the boot view for "/" and
// "/m", so lazying it would buy nothing and cost every member a Suspense flash
// on the one screen they always see first.

// Every other route is its own chunk. The loaders live in a table rather than
// inline in each lazyView() call so the warm-up effect can prefetch a view by
// key without repeating the specifiers — Rollup only emits a chunk per literal
// import() it can statically see, so these have to be written out; a template
// string would silently produce nothing.
const viewLoaders = {
  appointments: () => import("./views/AppointmentsView.jsx"),
  cases: () => import("./views/CasesView.jsx"),
  messages: () => import("./views/MessagesView.jsx"),
  numbers: () => import("./views/NumbersView.jsx"),
  pulse: () => import("./views/PulseView.jsx"),
  voting: () => import("./views/VotingView.jsx"),
  voice: () => import("./views/VoiceView.jsx"),
  qa: () => import("./views/MemberQaView.jsx"),
  qaQueue: () => import("./views/OfficerQaView.jsx"),
  pay: () => import("./views/PayToolsView.jsx"),
  events: () => import("./views/EventsView.jsx"),
  rights: () => import("./views/RightsView.jsx"),
  memberSupport: () => import("./views/MemberSupportView.jsx"),
  siteGuide: () => import("./views/SiteGuideView.jsx"),
  settings: () => import("./views/SettingsView.jsx"),
  accessHistory: () => import("./views/AccessHistoryView.jsx"),
  workload: () => import("./views/WorkloadView.jsx"),
  forms: () => import("./views/FormsView.jsx"),
  rewards: () => import("./views/RewardsView.jsx"),
  search: () => import("./views/SearchView.jsx"),
  tasks: () => import("./views/TasksView.jsx"),
  eventsDesk: () => import("./views/EventsDeskView.jsx"),
  campaigns: () => import("./views/CampaignsView.jsx"),
  analytics: () => import("./views/AnalyticsCoreView.jsx"),
  organizationMap: () => import("./views/OrganizationIntelligenceView.jsx"),
  orgStructure: () => import("./views/OrgStructureView.jsx"),
  actions: () => import("./views/CollectiveActionsView.jsx"),
  coordination: () => import("./views/OrganizationCoordinationView.jsx"),
  integrations: () => import("./views/IntegrationsView.jsx"),
  operationsHealth: () => import("./views/OperationsHealthView.jsx"),
  automationControl: () => import("./views/AutomationControlRoomView.jsx"),
  hub: () => import("./views/ProductHubView.jsx"),
  steward: () => import("./views/StewardView.jsx"),
  coordinator: () => import("./views/CoordinatorView.jsx"),
  advisor: () => import("./views/AdvisorView.jsx"),
  admin: () => import("./views/AdminView.jsx"),
  vp: () => import("./views/VpView.jsx"),
  // Union Ground: the worker Work list and the organizing lifecycle plane.
  work: () => import("./views/WorkView.jsx"),
  organize: () => import("./views/OrganizeView.jsx"),
};

const AppointmentsView = lazyView(() => viewLoaders.appointments().then((m) => ({ default: m.AppointmentsView })));

const CasesView = lazyView(() => viewLoaders.cases().then((m) => ({ default: m.CasesView })));

const MessagesView = lazyView(() => viewLoaders.messages().then((m) => ({ default: m.MessagesView })));

// The alternate web shell (REQ-UG-ALT-SHELL-FOUNDATION-20261015): its
// chrome, Now page and sign-in wrapper load only when ?shell=alt (or the saved
// choice, or VITE_UG_DEFAULT_SHELL) selects them; the classic bundle is unchanged.
const AltShell = lazyView(() => import("./alt/AltShell.jsx"));

const AltWorkHero = lazyView(() => import("./alt/AltWorkHero.jsx"));


const AltPageHero = lazyView(() => import("./alt/AltPageHero.jsx"));

const AltPageKpis = lazyView(() => import("./alt/AltPageKpis.jsx"));

const AltUpdatesPage = lazyView(() => import("./alt/AltUpdatesPage.jsx"));

// Member views that draw the prototype's own page under the alternate shell.
// The alternate shell's Work page carries the find box in its work bar and
// hides the Tasks tool's own, so the tool's "/" shortcut focuses this one.
function focusWorkFind() {
  document.querySelector(".ugalt .ug-work-find input")?.focus();
}

const ALT_BODY_VIEWS = new Set(["voting", "numbers", "actions", "hub", "pay", "clauses", "memberSupport", "rights", "settings"]);

// Views whose page h1 names a sub-page the hero does not repeat (Civic's
// hero says "Civic"; its h1 is the officials, address or campaign title), so
// the hero must not hide it.
const HERO_KEEPS_PAGE_H1 = new Set(["civic"]);

const AltCalendar = lazyView(() => import("./alt/AltCalendar.jsx"));

const AltNowPage = lazyView(() => import("./alt/AltNowPage.jsx"));

const AltSignedOut = lazyView(() => import("./alt/AltSignedOut.jsx"));

const NumbersView = lazyView(() => viewLoaders.numbers().then((m) => ({ default: m.NumbersView })));

const VotingView = lazyView(() => viewLoaders.voting().then((m) => ({ default: m.VotingView })));

const VoiceView = lazyView(() => viewLoaders.voice().then((m) => ({ default: m.VoiceView })));

const MemberQaView = lazyView(() => viewLoaders.qa().then((m) => ({ default: m.MemberQaView })));

const OfficerQaView = lazyView(() => viewLoaders.qaQueue().then((m) => ({ default: m.OfficerQaView })));

const PayToolsView = lazyView(() => viewLoaders.pay().then((m) => ({ default: m.PayToolsView })));





const EventsView = lazyView(() => viewLoaders.events().then((m) => ({ default: m.EventsView })));

const EventsDeskView = lazyView(() => viewLoaders.eventsDesk().then((m) => ({ default: m.EventsDeskView })));

const RightsView = lazyView(() => viewLoaders.rights().then((m) => ({ default: m.RightsView })));

const MemberSupportView = lazyView(() => viewLoaders.memberSupport().then((m) => ({ default: m.MemberSupportView })));

const SettingsView = lazyView(() => viewLoaders.settings().then((m) => ({ default: m.SettingsView })));

const AccessHistoryView = lazyView(() => viewLoaders.accessHistory().then((m) => ({ default: m.AccessHistoryView })));

const WorkloadView = lazyView(() => viewLoaders.workload().then((m) => ({ default: m.WorkloadView })));

const FormsView = lazyView(() => viewLoaders.forms().then((m) => ({ default: m.FormsView })));

const RewardsView = lazyView(() => viewLoaders.rewards().then((m) => ({ default: m.RewardsView })));

const SearchView = lazyView(() => viewLoaders.search().then((m) => ({ default: m.SearchView })));

const TasksView = lazyView(() => viewLoaders.tasks().then((m) => ({ default: m.TasksView })));

const CampaignsView = lazyView(() => viewLoaders.campaigns().then((m) => ({ default: m.CampaignsView })));

const AnalyticsCoreView = lazyView(() => viewLoaders.analytics().then((m) => ({ default: m.AnalyticsCoreView })));

const PulseView = lazyView(() => viewLoaders.pulse().then((m) => ({ default: m.PulseView })));

const OrganizationIntelligenceView = lazyView(() => viewLoaders.organizationMap().then((m) => ({ default: m.OrganizationIntelligenceView })));

const OrgStructureView = lazyView(() => viewLoaders.orgStructure().then((m) => ({ default: m.OrgStructureView })));

const SiteGuideView = lazyView(() => viewLoaders.siteGuide().then((m) => ({ default: m.SiteGuideView })));

const CollectiveActionsView = lazyView(() => viewLoaders.actions().then((m) => ({ default: m.CollectiveActionsView })));

const OrganizationCoordinationView = lazyView(() => viewLoaders.coordination().then((m) => ({ default: m.OrganizationCoordinationView })));

const IntegrationsView = lazyView(() => viewLoaders.integrations().then((m) => ({ default: m.IntegrationsView })));

const OperationsHealthView = lazyView(() => viewLoaders.operationsHealth().then((m) => ({ default: m.OperationsHealthView })));

const AutomationControlRoomView = lazyView(() => viewLoaders.automationControl().then((m) => ({ default: m.AutomationControlRoomView })));

const ProductHubView = lazyView(() => viewLoaders.hub().then((m) => ({ default: m.ProductHubView })));

const StewardView = lazyView(() => viewLoaders.steward().then((m) => ({ default: m.StewardView })));

const CoordinatorView = lazyView(() => viewLoaders.coordinator().then((m) => ({ default: m.CoordinatorView })));

const AdvisorView = lazyView(() => viewLoaders.advisor().then((m) => ({ default: m.AdvisorView })));

const AdminView = lazyView(() => viewLoaders.admin().then((m) => ({ default: m.AdminView })));
// Dues, contract-clause and civic-action views are not part of Union Ground:
// dues and contract articles need a union that already exists, and civic
// action is deferred (owner decision).
const WorkView = lazyView(() => viewLoaders.work().then((m) => ({ default: m.WorkView })));
const OrganizeView = lazyView(() => viewLoaders.organize().then((m) => ({ default: m.OrganizeView })));

const VpView = lazyView(() => viewLoaders.vp().then((m) => ({ default: m.VpView })));

// Overlays are lazy for the same reason the routes are, and the payoff is
// larger: the Compass assistant, the guided tour and the preview guide are
// substantial components that most sessions never open at all, and MfaChallenge
// is reached only by the members who hold a second factor.
const MfaChallenge = lazyView(() => import("./components/MfaSettings.jsx").then((m) => ({ default: m.MfaChallenge })));

const MfaEnrollment = lazyView(() => import("./components/MfaSettings.jsx").then((m) => ({ default: m.MfaEnrollment })));

const ChoiceDialog = lazyView(() => import("./components/Dialogs.jsx").then((m) => ({ default: m.ChoiceDialog })));

const NotificationsDialog = lazyView(() => import("./components/Dialogs.jsx").then((m) => ({ default: m.NotificationsDialog })));

const ProfileDialog = lazyView(() => import("./components/Dialogs.jsx").then((m) => ({ default: m.ProfileDialog })));

const Assistant = lazyView(() => import("./components/FloatingControls.jsx").then((m) => ({ default: m.Assistant })));

const DemoWelcome = lazyView(() => import("./components/FloatingControls.jsx").then((m) => ({ default: m.DemoWelcome })));

const GuidedTour = lazyView(() => import("./components/FloatingControls.jsx").then((m) => ({ default: m.GuidedTour })));

const PreviewGuide = lazyView(() => import("./components/FloatingControls.jsx").then((m) => ({ default: m.PreviewGuide })));

// While the session holds an unresolved account deletion (published as
// session.destructiveHold by the pane that owns the pending dialog), the hub
// must not be navigated AWAY from: switching views unmounts ProductHubView
// and the pending deletion dialog with it, releasing the per-tree lock
// through its own cleanup. Arriving at or staying on the hub is never
// blocked. Reads the pathname, not React state, because the sg-nav mirror
// handlers run in effects whose closures would hold a stale view.
function destructiveHoldPinsHub(nextView) {
  if (nextView === "hub") return false;
  if (deviceParityValue("session.destructiveHold") !== true) return false;
  return pathViews[normalizeAppPath(window.location.pathname)] === "hub";
}

const STAFF_TOOL_VIEWS = STAFF_TOOLS.map((tool) => tool.view);

// The Site Guide (REQ-UG-SITE-GUIDE-FOR-REAL-ACCOUNTS-20261001) is an
// account-level page too: its desk sections are the wearer's own. Pulse
// (REQ-UG-PULSE-WEB-EXPLORER-AND-STUDIO-20261031) reads under the
// selected hat, and the server authorizes that hat on every card, so staff
// reach it from the analytics desk without switching to Member.
const STAFF_SHARED_ACCOUNT_VIEWS = new Set(["settings", "accessHistory", "appointments", "siteGuide", "pulse"]);

// Exported as the one canonical answer to "may the selected hat open this
// view?". Surfaces that OFFER a destination (the More hub's rows) bind it to
// the selected hat and hide what it refuses, so no screen advertises a
// control this guard will bounce.
// Does this account hold the hat? A plane key is a role name for every Union
// Ground plane; Union Ground's organize plane is held through any of its
// roles (organizer and the staff roles that supervise organizers).
export function holdsHat(roles = [], hat) {
  const plane = STAFF_PLANES.find((entry) => entry.key === hat);
  return plane ? planeRoles(plane).some((role) => roles.includes(role)) : roles.includes(hat);
}

export function explicitHatAllowsView(hat, nextView, demo, roles = [], allowStaffHome = false, path = null) {
  const authorizedStaffHat = hat !== "member" && (demo || holdsHat(roles, hat));
  if (CHAPTER_OFFICE_ROLES.includes(hat)) return authorizedStaffHat && ((nextView === "hub" && !isStaffOnlyWorkspaceTabPath(path?.split(/[?#]/, 1)[0])) || STAFF_SHARED_ACCOUNT_VIEWS.has(nextView));
  // A staff-only TAB inside an otherwise member workspace (the contract's
  // staffOnly flag, read through lib/workspacePages.js) is a staff
  // destination in its own right. Members keep the workspace and its other
  // tabs; only the staff tab's path is refused, exactly as a staff plane
  // path is, so the URL never survives on a surface that will not render it.
  if (!authorizedStaffHat && isStaffOnlyWorkspaceTabPath(path?.split(/[?#]/, 1)[0])) return false;
  // Coordination is the one staff tool members may open: /m/network is the
  // member-safe alias, and its canonical tab lives under /m/coordination.
  if (!authorizedStaffHat) return nextView === "coordination" || !STAFF_VIEWS.includes(nextView);
  // Shared staff tools belong to the selected authorized hat even when a
  // role's rail omits a duplicate entrance (Admin already has events in its
  // own desk). A staff hat never falls through to Member Today.
  const staffTool = STAFF_TOOLS.find((tool) => tool.view === nextView);
  if (staffTool) return staffToolAllowsHat(nextView, hat);
  // Phone Home is a card-navigation shell, not Member Today: its center card
  // renders the selected staff plane below. Rail layouts route Home straight
  // to the plane and therefore never admit /m under a staff hat.
  if (nextView === "today") return allowStaffHome;
  // Account-level member views (settings, access history, member appointments)
  // are not staff-plane destinations. An authorized staff hat keeps them
  // without switching to Member and without adding them to STAFF_VIEWS.
  if (STAFF_SHARED_ACCOUNT_VIEWS.has(nextView)) return true;
  // A record link opens the authorized calendar source while preserving the
  // selected staff identity. Arrival performs a fresh RLS read; the link grants
  // no event-management permission and does not add a general Member entrance.
  if (nextView === "events" && workflowReferenceFromHref(path)?.kind === "event") return true;
  // A plane always admits its own hat, including the organize plane, which has
  // no role navigation of its own.
  if (STAFF_PLANES.some((plane) => plane.key === hat && plane.view === nextView)) return true;
  return (STAFF_ROLE_NAVIGATION[hat] || []).some((item) => (item.viewKey ?? item.key) === nextView);
}

// The staff hats an account holds that may open `view` in place: what an
// empty authoring page offers to wear (StaffAuthoringHint). Coordination and
// collective-action writers authorize against organization_role_grants
// only (has_organization_role, canManageCoordination, canManageCollectiveActions
// over organizationRoles), so a chapter-only staff hat is not offered there: it
// would open the page and still show no writer. Hub authoring accepts chapter
// roles, so it offers every held hat. The hint shares the view list so its
// note says those views need an organization-wide role.

export function heldAuthoringHats(roles = [], view, organizationRoles = roles) {
  const grants = ORGANIZATION_GRANT_AUTHORING_VIEWS.has(view) ? organizationRoles : roles;
  return STAFF_TOOL_ROLES.filter((hat) => roles.includes(hat) && grants.includes(hat) && explicitHatAllowsView(hat, view, false, roles));
}

const BOOT_RETRY_DELAYS_MS = Object.freeze([5_000, 15_000, 45_000, 90_000]);

// Plain words for a failed boot read: never the bare "Load failed". No saved
// copy stands in for fresh data, so a device that reports itself offline is
// told Home needs a connection; a server that did not answer keeps the general
// text, which does not blame the member's connection for it.
function translatedShellLoadError(error, tr) {
  if (isRequestTimeoutError(error)) return tr("error.requestTimedOut");
  if (isOfflineError(error) && typeof navigator !== "undefined" && navigator.onLine === false) return tr("app.homeNeedsConnection");
  return tr("app.viewLoadFailedBody");
}

function viewFromPath() {
  return appViewForPath(window.location.pathname);
}

// A pasted or refreshed MEMBER deep link is itself an explicit request to
// wear Member. It may replace a stale SAMPLE staff hat, but it never infers a
// staff identity from a staff-looking URL. The SAMPLE root remains the one
// owner-approved exception that opens as Steward. On the live product a
// typed address or a reload starts in the hat this tab last wore; the route
// guard then confirms it against the live roles and the address
// (REQ-UG-TYPED-ADDRESS-ROLE-DESK-BOUNCE-20261030).
function initialHatFromPath(demo) {
  if (!demo) return readActingHat()?.hat ?? "member";
  const initialView = viewFromPath();
  if (memberCoordinationAliasPath()) return "member";
  const memberDeepLink = initialView
    && initialView !== "today"
    && !STAFF_VIEWS.includes(initialView)
    && !STAFF_TOOL_VIEWS.includes(initialView)
    // A staff-only workspace tab is a staff destination even though its
    // workspace is a member view: SAMPLE opens it as the default staff hat
    // rather than entering as Member and immediately refusing the URL.
    && !isStaffOnlyWorkspaceTabPath(window.location.pathname);
  return memberDeepLink ? "member" : DEFAULT_SAMPLE_HAT;
}

function staffDeepLinkFallsBackToSteward(demo) {
  if (!demo) return false;
  if (memberCoordinationAliasPath()) return false;
  const initialView = viewFromPath();
  return Boolean(initialView && STAFF_VIEWS.includes(initialView) && initialView !== DEFAULT_SAMPLE_HAT);
}

// A refused route repairs the URL in place. The rider it lands with is the
// visitor's OWN query string, never a synthesized `?demo=1`: on the SAMPLE
// origin demo mode is host-derived, so hard-coding the rider invented a query
// the visitor never typed and turned an in-place repair into a URL change that
// acceptance runners read as a redirect. Harness visits already carry
// `?demo=1`, so they are byte-identical to the old behaviour.
function refusedRouteHref(targetPath, demo) {
  if (!demo) return targetPath;
  const search = typeof window === "undefined" ? "" : window.location.search;
  return search ? `${targetPath}${search}` : targetPath;
}

function hatRouteRefusedDestinationKey(targetPath) {
  const destPlane = STAFF_PLANES.find((plane) => plane.path === targetPath);
  if (!destPlane) return "nav.home";
  const destNav = (STAFF_ROLE_NAVIGATION[destPlane.key] || [])
    .find((item) => (item.viewKey ?? item.key) === destPlane.view);
  return destNav?.labelKey || destPlane.labelKey || "nav.home";
}

// UX-UG-STAFF-LINKS-FROM-WRONG-DESK-LAND-ON-HOME-OR-OVERVIEW-20261111:
// a refused address is remembered with the desk that opens it, so switching to
// that desk opens the address itself rather than the desk overview. Only a desk
// the account may wear qualifies (any hat in the fixture demo), and the memory
// is short-lived: a later, unrelated switch must not jump to an old page.
export const PENDING_DESK_ROUTE_MS = 5 * 60 * 1000;

export function deskForRefusedRoute(view, roles = [], demo = false, path = null) {
  return STAFF_PLANES.find((plane) => (demo || roles.includes(plane.key))
    && explicitHatAllowsView(plane.key, view, demo, roles, false, path))?.key ?? null;
}

export function pendingDeskRouteFor(pending, hat, now = Date.now()) {
  return pending && pending.hat === hat && now - pending.at < PENDING_DESK_ROUTE_MS ? pending : null;
}

function shouldAnnounceHatRouteRefusal(refusedView) {
  // Rail Home under a staff hat remaps onto that hat's own plane. SAMPLE
  // first entry and an ordinary /m load are that remap, not a refused URL.
  return refusedView !== "today";
}

function hatRouteRefusedNotice(tr, hat, targetPath, staffFallback, bannerExplains = false, refused = null) {
  // Steward-fallback copy is only for SAMPLE's default Steward identity.
  // A coordinator (or other hat) that cannot open a staff URL must name
  // the worn hat and the real destination, never Steward. On a rail shell the
  // demo bar already carries that sentence as a status region, so the toast
  // would announce it twice; the phone chip does not, so the toast stays there.
  // Union Ground's SAMPLE default is the Worker hat, which is no staff
  // fallback at all: a Worker refused at a staff URL hears the ordinary
  // sentence naming that hat, never that the link "starts as" a staff desk.
  if (staffFallback && hat === DEFAULT_SAMPLE_HAT && DEFAULT_SAMPLE_HAT !== "member") return bannerExplains ? null : tr("demo.staffLinkFallback");
  // BUG-UG-M-ROUTES-REDIRECT-TO-HOME-20261003. A staff page opened
  // under the Member hat still fails closed, but on the live product it now
  // says which page it was and what opens it: the account's own desk when one
  // of its roles may open the page, otherwise that the page is for staff.
  // A staff-only tab inside a member workspace opens under any staff hat.
  if (refused && !refused.demo && hat === "member" && isStaffOnlyWorkspaceTabPath(refused.path?.split(/[?#]/, 1)[0])) {
    const desk = STAFF_PLANES.find((plane) => holdsHat(refused.roles || [], plane.key));
    return desk ? tr("demo.hatRouteTabNeedsDesk", { desk: tr(desk.labelKey) }) : tr("demo.hatRouteTabStaffOnly");
  }
  const staffPage = refused && !refused.demo && hat === "member"
    ? STAFF_TOOLS.find((entry) => entry.view === refused.view) ?? STAFF_PLANES.find((entry) => entry.view === refused.view)
    : null;
  if (staffPage) {
    const page = tr(staffPage.labelKey);
    if (!STAFF_TOOLS.includes(staffPage)) return tr("demo.hatRoutePlaneRefused", { page });
    const desk = STAFF_PLANES.find((plane) => holdsHat(refused.roles || [], plane.key) && staffToolAllowsHat(refused.view, plane.key));
    return desk ? tr("demo.hatRouteNeedsDesk", { page, desk: tr(desk.labelKey) }) : tr("demo.hatRouteStaffOnly", { page });
  }
  const hatName = tr(hat === "member"
    ? "demo.hatMember"
    : (STAFF_PLANES.find((plane) => plane.key === hat)?.labelKey || "demo.hatMember"));
  const destination = tr(hatRouteRefusedDestinationKey(targetPath));
  return tr("demo.hatRouteRefused", { hat: hatName, destination });
}

// Which routes the desktop<->phone mirror may follow. Member routes always;
// staff planes and tools only when the demo owns every hat, or when the
// signed-in member actually holds the plane's role (staff plane keys ARE role
// names) — otherwise a mirrored staff path would park a role-less member's
// URL on /m/admin while the redirect-gated member content renders under it.
function mirrorAllowsStaff(nextView, demo, roles) {
  if (!STAFF_VIEWS.includes(nextView) && !STAFF_TOOL_VIEWS.includes(nextView)) return true;
  if (demo) return true;
  if (STAFF_TOOL_VIEWS.includes(nextView)) return roles.some((role) => STAFF_TOOL_ROLES.includes(role));
  return STAFF_PLANES.some((plane) => plane.view === nextView && holdsHat(roles, plane.key));
}

// The demo lets a prospect switch "hats" freely. Member keeps the full member
// shell (bottom nav + its sub-screens); the staff hats are single-page
// dashboards on seeded data, reached only through the switcher. The active hat
// is derived from the route so the toggle, back/forward, and deep links agree.
// The staff half is the shared table (lib/staffPlanes.js) — the member hat is
// the only entry the demo adds, and it belongs to the demo alone.
const DEMO_HATS = [
  { key: "member", labelKey: "demo.hatMember", view: "today", path: "/m" },
  ...STAFF_PLANES,
];

// SAMPLE-live persona sessions arrive through the production auth machinery
// (UB-UG-DEMO-STRAIGHT-IN-ENTRY-RESTORED-20261107): /api/demo-session
// (demo host only) signs the hat's fictional Tamarack persona account in
// server-side, including a staff persona's two-step step, and returns that
// session for this client to adopt. No demo credential reaches the bundle.
async function mintSamplePersonaSession(client, hat, { attemptsLeft = 1, stillWanted = () => true } = {}) {
  const persona = samplePersonaForHat(hat) ?? defaultSamplePersona();
  const response = await boundedSampleFetch("/api/demo-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hat: persona.hat }),
  });
  if (!response.ok) {
    // Every visitor shares the persona accounts, so a concurrent entry can
    // spend this one's single-use link between mint and verify (a 503). One
    // fresh attempt closes that benign race; a persistent failure surfaces.
    if (response.status === 503 && attemptsLeft > 0 && stillWanted()) {
      return mintSamplePersonaSession(client, hat, { attemptsLeft: attemptsLeft - 1, stillWanted });
    }
    throw new Error(`demo-session ${response.status}`);
  }
  const { accessToken, refreshToken } = await response.json();
  // A slower sign-in the visitor has already abandoned (they switched hats
  // again) must not establish its session over the newer one: check after
  // the network hop, immediately before the call that would set it.
  if (!stillWanted()) return;
  const { error } = await client.auth.setSession({ access_token: String(accessToken || ""), refresh_token: String(refreshToken || "") });
  if (error) throw error;
}

// Only unit tests inject historical fixtures through data/demoData.js.
export function demoSessionFor(fixtures) {
  return { user: { id: fixtures.member.id, email: "demo@unionground.invalid" } };
}

// Union Ground's organizing-lifecycle fixtures (campaigns, cards,
// recognition and first-contract records) ride their own dynamic chunk for the
// same reason the tour fixtures do: only the demo ever reads them. Cached at
// module scope so re-entering the demo does not re-fetch.
let lifecycleFixturesPromise = null;
function loadLifecycleFixtures() {
  lifecycleFixturesPromise ||= import("./data/lifecycleFallback.js").then((m) => m.lifecycleFallback);
  return lifecycleFixturesPromise;
}

// Module-stable like the other demo planes' read-only apis: every load is a
// deep copy, so OrganizeView can never mutate the shared fixture.
const demoOrganizeApi = {
  loadWorkspace: async () => JSON.parse(JSON.stringify(await loadLifecycleFixtures())),
};

function demoSignatureRows(forms = []) {
  return new Map(forms
    .filter((form) => form.demoSignature)
    .map((form) => [form.id, form.demoSignature]));
}

export async function demoFilingTemplate(templateKey, version, registryTemplate, lang = "en") {
  // PDF schemas are bilingual even when the current screen is English.
  // Never snapshot t("es") while it still resolves to the English fallback.
  if (lang === "es" && !await loadLanguage("es")) throw new Error("Demo language bundle unavailable");
  const spanish = (key) => languageLoaded("es") ? translate("es", key) : "";
  if (registryTemplate?.field_schema) {
    return {
      label_en: registryTemplate.label_en || templateKey,
      label_es: registryTemplate.label_es || registryTemplate.label_en || templateKey,
      field_schema: registryTemplate.field_schema,
    };
  }
  const template = templateByKey(templateKey);
  if (!template) return { label_en: templateKey, label_es: templateKey, field_schema: { steps: [] } };
  return {
    label_en: translate("en", template.titleKey),
    label_es: spanish(template.titleKey),
    version,
    field_schema: {
      steps: template.steps.map((step) => ({
        title: { en: translate("en", step.titleKey), es: spanish(step.titleKey) },
        fields: step.fields.map((field) => ({
          key: field.key,
          type: field.type,
          label: { en: translate("en", field.labelKey), es: spanish(field.labelKey) },
          ...(field.options ? {
            options: field.options.map((option) => ({
              value: option.value,
              label: { en: translate("en", option.labelKey), es: spanish(option.labelKey) },
            })),
          } : {}),
        })),
      })),
    },
  };
}

// Union Ground has no named public SAMPLE origin. A SaaS portal host,
// ordinary localhost, and ordinary Vercel previews never enter SAMPLE mode.
// Only an explicitly configured test/visual harness may use the ?demo=1
// fixture seam; live SAMPLE traffic uses the SAMPLE backend.
// Union Ground: the fixture tour is reachable from a ?demo=1 link on its
// own deployment (README "Demo mode"), not only from a named SAMPLE host.
function demoFromUrl() {
  try {
    return hasDemoQuery(window.location.search) || shouldEnterDemo({
      hostname: window.location.hostname,
      search: window.location.search,
    });
  } catch {
    return false;
  }
}

// UB-UG-DEMO-STAFF-HATS-OPEN-ON-DESK-20261107: a staff page and its
// onboarding guides. Real staff see the guides first; on the shared demo
// personas the desk leads and the guides follow it.
export function deskWithGuides(desk, guides, deskFirst) {
  return deskFirst ? <>{desk}{guides}</> : <>{guides}{desk}</>;
}

// Keep the receiver explicit: the production browser transform can lower
// `performance?.now?.()` in a default parameter to an out-of-scope receiver.
function focusClockNow() {
  const clock = globalThis.performance;
  return clock && typeof clock.now === "function" ? clock.now() : Date.now();
}

export function focusWhenAvailable(
  resolve,
  deadline = focusClockNow() + 750,
  { allowActive = null, preventScroll = false } = {},
) {
  const active = typeof document !== "undefined" ? document.activeElement : null;
  if (active?.isConnected
      && active !== document.body
      && active !== document.documentElement
      && !allowActive?.(active)) return;
  const target = resolve?.();
  if (target?.isConnected) {
    if (preventScroll) target.focus({ preventScroll: true });
    else target.focus();
    return;
  }
  if (focusClockNow() >= deadline) return;
  const schedule = typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame.bind(window)
    : (callback) => window.setTimeout(callback, 0);
  schedule(() => focusWhenAvailable(resolve, deadline, { allowActive, preventScroll }));
}

// Status feedback normally lives at the authenticated shell's tail. Account
// deletion is the one transition that intentionally removes that shell before
// its final audit result can be shown, so the signed-out branch reuses this
// small surface instead of dropping an honest audited:false outcome.
export function AppStatusNotice({ message }) {
  if (!message) return null;
  return (
    <div className="toast" role="status">
      <span>{message}</span>
    </div>
  );
}

export function useActionNotice() {
  const [state, setState] = useState({ notice: "", noticeAction: null, noticeId: 0 });
  // Keep the caller's string/action API, but treat each call as a new event,
  // including identical confirmations and clearing a previous Undo action.
  const setNotice = useCallback((message, action = null) => {
    setState((previous) => ({ notice: message, noticeAction: action, noticeId: previous.noticeId + 1 }));
  }, []);
  return { ...state, setNotice };
}

export function ActionToast({ notice, noticeId = notice, action = null, onDismiss, onAction }) {
  const { t } = useLang();
  const toastRef = useRef(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const hasAction = Boolean(action);
  // Match voiceLiveNotice: a changed text node alone is not a changed live
  // region message. Alternate non-whitespace marks in the accessibility tree.
  const announcementMark = typeof noticeId === "number" ? (noticeId % 2 ? "\u200B" : "\u200C") : "";

  useEffect(() => { setHovered(false); setFocused(false); }, [notice]);

  // The prototype's toast clock (core.js UG.toast): 4.2 s, then a .3s fade
  // and removal at 320 ms. An action toast holds while the pointer or focus
  // is on it, and a timed-out one that held focus hands it to the main
  // landmark instead of dropping it on the body.
  const { leaving } = useToastLifetime({
    notice,
    noticeId,
    paused: hasAction && paused,
    onExpire: () => {
      const hadFocus = hasAction && Boolean(toastRef.current?.contains(document.activeElement));
      onDismiss();
      if (hadFocus) {
        focusWhenAvailable(
          () => document.getElementById("main-content"),
          undefined,
          { allowActive: (active) => toastRef.current?.contains(active) },
        );
      }
    },
  });

  if (!notice) return null;
  const leaves = (event) => {
    const next = event.relatedTarget;
    return !(next instanceof Node && event.currentTarget.contains(next));
  };
  return (
    <div ref={toastRef} className="toast" role="status" data-leaving={leaving || undefined} onMouseEnter={() => hasAction && setHovered(true)} onMouseLeave={(event) => hasAction && leaves(event) && setHovered(false)} onFocusCapture={() => hasAction && setFocused(true)} onBlurCapture={(event) => hasAction && leaves(event) && setFocused(false)}>
      <span key={noticeId}>{rpcErrorTextAtRender(t, notice)}</span>
      {announcementMark && <span className="sr-only">{announcementMark}</span>}
      {action && <button type="button" onClick={onAction}>{action.label}</button>}
    </div>
  );
}

export function useDeletionAuditPendingNotice() {
  const [message, setMessage] = useState("");
  const clearForSession = useCallback((nextUserId) => {
    // Preserve the outcome through the deletion's own null-session teardown,
    // then clear it before any later authenticated identity can render it.
    if (nextUserId) setMessage("");
  }, []);
  return {
    deletionAuditPendingNotice: message,
    setDeletionAuditPendingNotice: setMessage,
    clearDeletionAuditPendingNoticeForSession: clearForSession,
  };
}

// Only the demo's front door gets the welcome takeover. A shared link into a
// case, task or staff plane should preserve that exact destination, and the
// companion iframe must never place a second welcome dialog inside the phone.
function demoEntryFromUrl() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  return demoFromUrl() && (path === "/m" || path === "/") && !embedPhoneFromUrl();
}

// The companion phone on the desktop shell is this same app booted a second
// time inside an iframe with ?embed=phone. The flag is read once, at boot:
// an embedded instance renders the bare phone experience (no rail, no demo
// bar, and never a companion of its own — that would recurse) and follows the
// outer shell's member-route navigation via postMessage.
//
// The flag is only honored inside a real frame (the same check the
// sg-embed-ready handshake uses). The embed carries no demo marker of its
// own since 2026-07-31, so a top-level visit to the embed URL — the iframe
// opened in a new tab, a shared link — must NOT strip the demo chrome:
// un-framed, the query is ignored and the page boots as the ordinary shell,
// whose own demo bar keeps the tab honestly marked.
function embedPhoneFromUrl() {
  try {
    return new URLSearchParams(window.location.search).get("embed") === "phone" && window.parent !== window;
  } catch {
    return false;
  }
}

// The shell a width gets, from the desktop (1024px and up) and tablet
// (768 to 1023px) media query lists: the desktop shell wins, as it always
// has.
function shellScreenOf(wide, tablet) {
  if (wide.matches) return "desktop";
  return tablet.matches ? "tablet" : "phone";
}

// A PushSubscription is bound to the applicationServerKey it was minted with.
// After a VAPID rotation the old subscription still exists and still looks
// healthy, but every send signed with the new key fails, and calling subscribe()
// again rejects while it is there. Comparing the raw key bytes is the only way
// to tell — options.applicationServerKey is an ArrayBuffer, not the string.
//
// Fails CLOSED. If the key cannot be read or compared, the honest answer is
// "unknown", and treating unknown as a match is the expensive direction: the UI
// would report push as working while every send signed with the new key fails
// silently, and nothing would ever prompt a repair. Treating unknown as a
// mismatch costs one re-subscribe, which is invisible when permission is
// already granted.
function subscriptionMatchesKey(subscription, vapidPublicKey) {
  try {
    const current = subscription?.options?.applicationServerKey;
    if (!current) return false;
    const a = new Uint8Array(current);
    const b = urlBase64ToUint8Array(vapidPublicKey);
    if (!b.length || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
  } catch {
    return false;
  }
}

// Kept as a named answer (tests/App.test.jsx pins it); the rule itself is
// requiresBackendConfig.
export function shouldShowConfigurationGate(configured, demoActive, testPreview) {
  return requiresBackendConfig({ hasConfig: configured, demoActive, testPreview });
}

// One stable API group per composing person; every writer uses the checked client.
function createLiveSessionApis(supabase) {
  const accessHistoryRpcApi = createAccessRpcAdapter(supabase);

  const chapterAccessApi = createChapterAccessApi(supabase);

  const unitSettingsApi = createUnitSettingsApi(supabase);

  // REQ-UG-ORG-RESOURCE-HTML-FORMS-20261030: the organization's own HTML forms.
  const organizationFormDocumentsApi = createOrganizationFormDocumentsApi(supabase);

  // REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030: the member's own
  // shared workplace details for forms, and their ask/always/never answer.
  const formAutofillApi = supabase ? createFormAutofillApi(supabase) : null;

  const loadEventQuorum = (eventIds) => loadMemberEventQuorum(supabase, eventIds);

  const caseDeskApi = createCaseDeskApi(supabase);

  const loadLiveCaseDetails = (caseId) => loadMemberCaseDetails(supabase, caseId);

  const stewardApi = {
    updateCase: (caseId, fields) => coordinatorUpdateCase(supabase, caseId, fields),
    ...createGrievancePrivacyApi(supabase),
    loadDesk: (options) => loadStewardDesk(supabase, options),
    openCaseForMember: (fields) => openMemberCase(supabase, fields),
    searchCaseMembers: (query) => searchCaseMembers(supabase, query),
    listUnassignedCases: () => listUnassignedChapterCases(supabase),
    claimCase: (caseId) => claimMemberCase(supabase, caseId),
    loadCaseDetails: loadLiveCaseDetails,
    listSavedViews: (plane) => listMemberSavedViews(supabase, plane),
    saveSavedView: (view) => saveMemberSavedView(supabase, view),
    deleteSavedView: (id) => deleteMemberSavedView(supabase, id),
    loadCaseworkCase: (caseId) => loadCaseworkCase(supabase, caseId),
    scoreCase: (caseId, inputs) => scoreCaseworkCase(supabase, caseId, inputs),
    setCaseRestriction: (caseId, restricted, reason) => setCaseworkRestriction(supabase, caseId, restricted, reason),
    loadAccessCandidates: (caseId) => loadCaseAssignmentCandidates(supabase, caseId),
    grantCaseAccess: (caseId, userId, reason) => grantCaseworkAccess(supabase, caseId, userId, reason),
    revokeCaseAccess: (grantId) => revokeCaseworkAccess(supabase, grantId),
    createCaseDeadline: (scope, fields) => createCaseworkDeadline(supabase, scope, fields),
    renameCase: (caseId, title, reason) => renameCaseworkCase(supabase, caseId, title, reason),
    // Owner answer 11=A: the steward's own reminders, before or after a case exists.
    listPrivateReminders: () => listStewardPrivateReminders(supabase),
    savePrivateReminder: (fields) => saveStewardPrivateReminder(supabase, fields),
    attachPrivateReminder: (reminderId, caseId) => attachStewardPrivateReminder(supabase, reminderId, caseId),
    deletePrivateReminder: (reminderId) => deleteStewardPrivateReminder(supabase, reminderId),
    requestDeadlineExtension: (deadlineId, dueAt, reason) => requestCaseworkDeadlineExtension(supabase, deadlineId, dueAt, reason),
    decideDeadlineExtension: (extensionId, decision, note) => decideCaseworkDeadlineExtension(supabase, extensionId, decision, note),
    setDeadlineStatus: (deadlineId, status) => setCaseworkDeadlineStatus(supabase, deadlineId, status),
    createCaseAlert: (scope, fields) => createCaseworkAlert(supabase, scope, fields),
    acknowledgeCaseAlert: (alertId, note) => acknowledgeCaseworkAlert(supabase, alertId, note),
    acknowledgeAlert: (alertId, note) => acknowledgeCaseworkAlert(supabase, alertId, note),
    createCaseReminder: (scope, fields) => createCaseworkReminder(supabase, scope, fields),
    logManagementBehavior: (caseId, fields) => logCaseworkManagementBehavior(supabase, caseId, fields),
    loadManagementWindow: (personIds, days) => loadCaseworkManagementWindow(supabase, personIds, days),
    addManagementAddendum: (entryId, body) => addCaseworkManagementAddendum(supabase, entryId, body),
    linkCases: (sourceCaseId, targetCaseId, relationship, note) => linkCaseworkCases(supabase, sourceCaseId, targetCaseId, relationship, note),
    setReminderStatus: (reminderId, action, remindAt) => setCaseworkReminderStatus(supabase, reminderId, action, remindAt),
    // REQ-UG-ULP-FILING-DEADLINE-20261001: retaliation flags and their ULP
    // filing deadlines, case view and deadline view.
    loadCaseworkHub: (chapterId) => loadCaseworkHub(supabase, chapterId),
    // Five server-side aggregates behind the case dashboards. The same reader
    // serves both staff planes: the RPCs scope themselves to the caller, so the
    // steward's tiles are the steward's own assigned caseload (UB-CASE-05) and
    // the coordinator's are the chapter, without either plane passing a scope.
    loadCaseDashboards: () => loadCaseDashboards(supabase),
    loadCaseHistory: (caseId, options) => loadCaseHistory(supabase, caseId, options),
    loadCaseStewardEmails: (caseId) => loadCaseStewardEmails(supabase, caseId),
    loadCaseworkHistory: (options) => loadCaseworkHistory(supabase, options),
    createBargainingWorkspace: (chapterId, title, startsAt) => createCaseworkBargainingWorkspace(supabase, chapterId, title, startsAt),
    addBargainingProposal: (workspaceId, fields) => addCaseworkBargainingProposal(supabase, workspaceId, fields),
    transitionBargainingProposal: (proposalId, expectedStatus, nextStatus, responseDueAt) => transitionCaseworkBargainingProposal(supabase, proposalId, expectedStatus, nextStatus, responseDueAt),
    addBargainingEvent: (workspaceId, eventType, body, pulse) => addCaseworkBargainingEvent(supabase, workspaceId, eventType, body, pulse),
    setBargainingStatus: (workspaceId, expectedStatus, nextStatus) => setCaseworkBargainingStatus(supabase, workspaceId, expectedStatus, nextStatus),
    saveIntakeDraft: (fields) => saveCaseworkIntakeDraft(supabase, fields),
    scanRetaliationPatterns: (chapterId) => scanCaseworkRetaliationPatterns(supabase, chapterId),
    reviewRetaliationPattern: (patternId, status, disposition, note) => reviewCaseworkRetaliationPattern(supabase, patternId, status, disposition, note),
    bulkUpdateCases: (caseIds, expectedStatus, fields) => bulkUpdateCaseworkCases(supabase, caseIds, expectedStatus, fields),
    listMacros: () => listCaseworkMacros(supabase),
    saveMacro: (macro) => saveCaseworkMacro(supabase, macro),
    applyMacro: (macroId, caseIds, idempotencyKey) => applyCaseworkMacro(supabase, macroId, caseIds, idempotencyKey),
    // Written before the CSV leaves the browser; a rejection here cancels the
    // download (SEC-UG-CASE-CSV-EXPORT-UNAUDITED-UNBOUNDED-20260917).
    recordCaseExport: (caseIds, scope, filterKeys) => recordCaseworkCaseExport(supabase, caseIds, scope, filterKeys),
    loadMentionCandidates: (caseId) => listCaseNoteMentionCandidates(supabase, caseId),
    addCaseNoteWithMentions: (caseId, body, mentionIds) => addCaseworkCaseNote(supabase, caseId, body, mentionIds),
    // REQ-UG-STEWARD-CASE-NOTES-AND-STEP-DEADLINES-20261030: dated notes
    // on the steward's own cases and one list of their open deadlines.
    addStewardCaseNote: (caseId, body, occurredOn) => addStewardCaseNote(supabase, caseId, body, occurredOn),
    listCaseDeadlines: () => listStewardCaseDeadlines(supabase),
    // UB-DESK-01 pagers: server-side keyset pages with search/filter/sort for
    // the desk's four queues, plus the per-thread message walk.
    loadRequests: (opts) => loadStewardRequests(supabase, opts),
    loadThreads: (opts) => loadStewardThreads(supabase, opts),
    loadForms: (opts) => loadStewardForms(supabase, opts),
    loadBroadcasts: (opts) => loadStewardBroadcasts(supabase, opts),
    getBroadcastReadCounts: () => getBroadcastReadCounts(supabase),
    loadThreadMessages: (conversationId, opts) => loadStewardThreadMessages(supabase, conversationId, opts),
    loadSourceLanding: (reference) => loadPrivateMessageLanding(supabase, reference, { staff: true }),
    triage: (requestId, action) => triageStewardRequest(supabase, requestId, action),
    reply: (conversationId, body) => sendStewardReply(supabase, conversationId, body),
    messageAction: (sourceKind, messageId, action, value) => messageActionRequest(supabase, sourceKind, messageId, action, value),
    toggleReaction: (sourceKind, messageId, reaction) => toggleMemberMessageReaction(supabase, sourceKind, messageId, reaction),
    toggleSaved: (sourceKind, messageId) => toggleMemberSavedMessage(supabase, sourceKind, messageId),
    remind: (sourceKind, messageId, remindAt) => createMemberMessageReminder(supabase, sourceKind, messageId, remindAt),
    schedule: (conversationId, body, scheduledFor) => scheduleMemberMessage(supabase, conversationId, body, scheduledFor),
    cancelScheduled: (scheduledMessageId) => cancelScheduledMemberMessage(supabase, scheduledMessageId),
    sendResource: (conversationId, documentId, body) => sendStewardResource(supabase, conversationId, documentId, body),
    listScheduled: (conversationId) => listScheduledMemberMessages(supabase, conversationId),
    cancelReminder: (reminderId) => cancelMemberMessageReminder(supabase, reminderId),
    listContactNotes: (conversationId) => listMemberContactNotes(supabase, conversationId),
    createContactNote: (conversationId, note, messageId) => createMemberContactNote(supabase, conversationId, note, messageId),
    // Preservation orders: status for anyone who can see the thread, place and
    // release for an organization admin (the server decides both).
    loadLegalHold: (conversationId) => loadConversationLegalHold(supabase, conversationId),
    placeLegalHold: (conversationId, reasonCode) => placeConversationLegalHold(supabase, conversationId, reasonCode),
    releaseLegalHold: (conversationId) => releaseConversationLegalHold(supabase, conversationId),
    listEmailIntakes: (status) => listStewardEmailIntakes(supabase, status),
    reviewEmailIntake: (intakeId, action) => reviewStewardEmailIntake(supabase, intakeId, action),
    createEventFromMessage: (messageId, fields) => createEventFromMemberMessage(supabase, messageId, fields),
    publish: (title, body, locale, audienceScope, operationKey) => publishMemberBroadcast(supabase, title, body, locale, audienceScope, operationKey),
    retract: (broadcastId) => retractMemberBroadcast(supabase, broadcastId),
    listDrafts: () => listAnnouncementDrafts(supabase, { chapterNotices: true }),
    resolveDraft: (draftId, state) => resolveAnnouncementDraft(supabase, draftId, state),
    startFormReview: (formId) => stewardStartFormReview(supabase, formId),
    approveForm: (formId, note, review) => approveForm(supabase, formId, note, review),
    returnForm: (formId, note) => returnForm(supabase, formId, note),
    approveAndOpenCase: (formId, note, review) => approveAndOpenFormCase(supabase, formId, note, review),
    formFilingStatus: (formId) => getFormFilingStatus(supabase, formId),
    // A submitted form's attachments can outlive their 24-hour clean verdict
    // before a reviewer reaches them, and the filer can no longer edit the form.
    // The reviewer renews the verdict through the ordinary authorized inspection
    // — `{kind: "form", fileId}` and nothing else — using the read authorization
    // a steward already holds for a submitted form's confirmed attachments.
    recheckFormFile: (fileId) => recheckPrivateFile(supabase, "form", fileId),
    scan: (eventId, token) => scanEventCheckin(supabase, eventId, token),
    // Appointments desk (REQ-UG-STEWARD-APPOINTMENTS-20260801).
    loadAppointments: () => loadStewardAppointments(supabase),
    loadAppointmentsPage: (opts) => loadStewardAppointmentsPage(supabase, opts),
    markOutcome: (appointmentId, outcome) => markAppointmentOutcome(supabase, appointmentId, outcome),
    cancelAppointment: (appointmentId) => cancelAppointment(supabase, appointmentId),
    slots: (args) => getStewardRescheduleSlots(supabase, args),
    rescheduleAppointment: (appointmentId, startsAt) => rescheduleAppointment(supabase, appointmentId, startsAt),
    setSchedule: (fields) => setAppointmentSchedule(supabase, fields),
    setWindows: (windows) => setAppointmentWindows(supabase, windows),
    // REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030.
    loadScheduleDetails: async () => (await loadScheduleDetails(supabase, null))[0] ?? null,
    setScheduleDetails: (fields) => saveScheduleDetails(supabase, fields),
    loadNotes: (ids) => loadAppointmentNotes(supabase, ids),
    setNote: (appointmentId, note) => saveAppointmentNote(supabase, appointmentId, note),
    addBlackout: (startDate, endDate) => addAppointmentBlackout(supabase, startDate, endDate),
    removeBlackout: (blackoutId) => removeAppointmentBlackout(supabase, blackoutId),
    requestConnection: (provider) => requestCalendarConnection(supabase, provider),
    removeConnection: (provider) => removeCalendarConnection(supabase, provider),
    loadOAuthStatus: () => loadCalendarOAuthStatus(supabase),
    loadImportStatus: () => loadCalendarImportStatus(supabase),
    startOAuth: (provider) => startCalendarOAuth(supabase, provider),
    recordAccess: (actor, record) => accessHistoryRpcApi.record(actor, record),
  };

  const memberCaseworkApi = {
    getMyCaseManaged: (caseId) => getMyCaseManaged(supabase, caseId),
    loadCaseHistory: (caseId, options) => loadCaseHistory(supabase, caseId, options),
    loadCaseOutcome: loadMyCaseOutcome.bind(null, supabase),
    loadRetaliationReports: (caseId) => loadMemberRetaliationReports(supabase, caseId),
    submitRetaliationReport: (fields) => submitCaseworkRetaliationReport(supabase, fields),
    withdrawRetaliationReport: (reportId, reason) => withdrawCaseworkRetaliationReport(supabase, reportId, reason),
  };

  const connectedWorkflowApi = createConnectedWorkflowApi(supabase);

  const messagingApi = {
    messageAction: (sourceKind, messageId, action, value) => messageActionRequest(supabase, sourceKind, messageId, action, value),
    toggleReaction: (sourceKind, messageId, reaction) => toggleMemberMessageReaction(supabase, sourceKind, messageId, reaction),
    toggleSaved: (sourceKind, messageId) => toggleMemberSavedMessage(supabase, sourceKind, messageId),
    schedule: (conversationId, body, scheduledFor) => scheduleMemberMessage(supabase, conversationId, body, scheduledFor),
    cancelScheduled: (scheduledMessageId) => cancelScheduledMemberMessage(supabase, scheduledMessageId),
    remind: (sourceKind, messageId, remindAt) => createMemberMessageReminder(supabase, sourceKind, messageId, remindAt),
    cancelReminder: (reminderId) => cancelMemberMessageReminder(supabase, reminderId),
    sendResource: (conversationId, documentId, body) => sendMemberResource(supabase, conversationId, documentId, body),
    // SEC-UG-MESSAGE-BODY-LIFECYCLE: the server decides who may remove what.
    redactMessage: (messageId) => redactMemberMessage(supabase, messageId),
    // REQ-UG-REMIND-HERE-20261001: /remind here and the reminders it delivered.
    remindHere: (spaceId, remindAt, note) => createChannelHereReminder(supabase, { spaceId, remindAt, note }),
    // Chapter channel polls in the thread dialog, the native pair.
    loadThreadPolls: (reference) => loadThreadChannelPolls(supabase, reference),
    voteChannelPoll: (pollId, optionId) => castChannelPollVote(supabase, pollId, optionId),
  };

  const appointmentsApi = {
    stewards: () => getBookableStewards(supabase),
    slots: (args) => getAppointmentSlots(supabase, args),
    stewardDetails: (ids) => loadScheduleDetails(supabase, ids),
  };

  const chapterAppointmentSupervisionApi = {
    loadChapterAppointments: (opts) => loadChapterAppointments(supabase, opts),
    loadChapterAppointmentCandidates: (appointmentId) => loadChapterAppointmentCandidates(supabase, appointmentId),
    reassignChapterAppointment: (appointmentId, stewardId) => reassignChapterAppointment(supabase, appointmentId, stewardId),
  };

  const vpApi = {
    loadDesk: () => loadVpOverview(supabase),
    markReviewed: (caseId) => markVpCaseReviewed(supabase, caseId),
  };

  const advisorApi = {
    loadDesk: (options) => loadAdvisorDesk(supabase, options),
    ...chapterAppointmentSupervisionApi,
  };

  const noticeReadApi = {
    listMine: (before) => listMyMemberNotices(supabase, before),
    receipts: (broadcastId) => getMemberNoticeReceipts(supabase, broadcastId),
    listDrafts: () => listAnnouncementDrafts(supabase, { chapterNotices: true }),
    resolveDraft: (draftId, state) => resolveAnnouncementDraft(supabase, draftId, state),
  };
  return { accessHistoryRpcApi, chapterAccessApi, unitSettingsApi, organizationFormDocumentsApi, formAutofillApi, loadEventQuorum, caseDeskApi, loadLiveCaseDetails, stewardApi, memberCaseworkApi, connectedWorkflowApi, messagingApi, appointmentsApi, chapterAppointmentSupervisionApi, vpApi, advisorApi, noticeReadApi };
}

const demoMessagingDefaults = {
  toggleSaved: async () => ({ saved: true, samplePreview: true }),
  remind: async () => ({ id: `sample-reminder-${Date.now()}`, status: "pending", samplePreview: true }),
  cancelReminder: async () => ({ cancelled: true, samplePreview: true }),
  sendResource: async (_conversationId, documentId) => ({ messageId: `sample-resource-${Date.now()}`, documentId, samplePreview: true }),
  redactMessage: async () => ({ redacted: true, reasonCode: "sender_removed", samplePreview: true }),
};

const demoPeerContactApi = {
  list: async () => ({ available: true, canRequest: true, code: "PSG-DE40C0DE00DE40C0DE00", incoming: [], outgoing: [], conversations: [], samplePreview: true }),
  request: async () => ({ requested: true, id: `sample-contact-${Date.now()}`, status: "pending", createdAt: new Date().toISOString(), samplePreview: true }),
  respond: async (_requestId, accept) => accept
    ? { accepted: true, conversation: { id: `sample-peer-${Date.now()}`, peerName: "Marisol Vega", peerInitials: "MV", updatedAt: new Date().toISOString(), state: "open", messages: [] }, samplePreview: true }
    : { accepted: false, declined: true, samplePreview: true },
  send: async (_conversationId, body) => ({ message: { id: `sample-peer-message-${Date.now()}`, sentByMe: true, body: body.trim(), createdAt: new Date().toISOString() }, samplePreview: true }),
  // The fixture twin of set_peer_conversation_block: a block shows as
  // the viewer's own, an unblock reopens it.
  setBlock: async (conversationId, blocked) => ({ id: conversationId, state: blocked ? "blocked_by_viewer" : "open", samplePreview: true }),
  // REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030: the
  // fixture twin of start_officer_conversation (handleStartOfficerConversation).
  startOfficer: async (officerUserId, body) => {
    const createdAt = new Date().toISOString();
    return {
      created: true,
      message: { id: `sample-peer-message-${Date.now()}`, sentByMe: true, body: body.trim(), createdAt },
      conversation: { id: `sample-officer-${officerUserId}`, peerName: "Chapter officer", peerInitials: "CO", updatedAt: createdAt },
      samplePreview: true,
    };
  },
};

function safeDemoChapterAppointment(row) {
  return {
    id: row.id,
    memberName: row.memberName,
    appointmentType: row.appointmentType,
    durationMinutes: row.durationMinutes,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: row.status,
    stewardId: row.stewardId,
    stewardName: row.stewardName,
  };
}

// Exported for a behavioral parity test. MemberApp passes one ref to this
// factory and spreads the returned object into all three demo desks, so a
// reassignment made under one hat is immediately observable under another.
export function createDemoChapterAppointmentSupervisionApi(stateRef, seed) {
  const state = () => {
    if (!stateRef.current) {
      const availableSeed = typeof seed === "function" ? seed() : seed;
      if (!availableSeed) throw new Error("Demo appointment fixtures unavailable");
      stateRef.current = JSON.parse(JSON.stringify(availableSeed));
    }
    return stateRef.current;
  };
  const sortedRows = () => [...state().rows].sort((left, right) => (
    right.startsAt.localeCompare(left.startsAt) || right.id.localeCompare(left.id)
  ));
  const eligibleAppointment = (appointmentId) => {
    const appointment = state().rows.find((row) => row.id === appointmentId);
    if (!appointment || appointment.status !== "confirmed" || Date.parse(appointment.startsAt) <= Date.now()) {
      throw new Error("Appointment unavailable");
    }
    return appointment;
  };
  return {
    loadChapterAppointments: async ({ cursor = null } = {}) => {
      const all = sortedRows();
      const afterCursor = cursor
        ? all.filter((row) => row.startsAt < cursor.startsAt || (row.startsAt === cursor.startsAt && row.id < cursor.id))
        : all;
      const page = afterCursor.slice(0, 2);
      const last = page.at(-1);
      return {
        rows: page.map((row) => safeDemoChapterAppointment(row)),
        nextCursor: page.length === 2 && afterCursor.length > 2
          ? { startsAt: last.startsAt, id: last.id }
          : null,
        total: all.length,
      };
    },
    loadChapterAppointmentCandidates: async (appointmentId) => {
      const appointment = eligibleAppointment(appointmentId);
      return state().candidates
        .filter((candidate) => candidate.id !== appointment.stewardId)
        .map((candidate) => ({ id: candidate.id, name: candidate.name }));
    },
    reassignChapterAppointment: async (appointmentId, stewardId) => {
      const appointment = eligibleAppointment(appointmentId);
      const target = state().candidates.find((candidate) => candidate.id === stewardId);
      if (!target || target.id === appointment.stewardId) throw new Error("Appointment unavailable");
      appointment.stewardId = target.id;
      appointment.stewardName = target.name;
      return safeDemoChapterAppointment(appointment);
    },
  };
}

// VP plane is lang-free (dates format client-side), so it can be module-stable
// like the steward desk. The coordinator api lives in the component because
// its loader localizes date labels with the member's language.


// Advisor plane is lang-free too (aggregates, roster, locale-neutral period
// labels like "2026-Q2"), so it is module-stable like the VP plane.
const organizeApi = {
  loadWorkspace: () => loadUnionLifecycleWorkspace(supabase),
  createCampaign: (fields) => createOrganizingCampaign(supabase, fields),
  transitionCampaign: (fields) => transitionOrganizingCampaign(supabase, fields),
  setCampaignStatus: (fields) => setOrganizingCampaignStatus(supabase, fields),
  recordResistance: (fields) => recordResistanceIncident(supabase, fields),
  openBargainingCycle: (fields) => openOrganizingBargainingCycle(supabase, fields),
  transitionBargainingCycle: (fields) => transitionOrganizingBargainingCycle(supabase, fields),
  createBargainingProposal: (fields) => createOrganizingBargainingProposal(supabase, fields),
  transitionBargainingProposal: (fields) => transitionOrganizingBargainingProposal(supabase, fields),
  scheduleBargainingSession: (fields) => scheduleOrganizingBargainingSession(supabase, fields),
  recordBargainingSessionOutcome: (fields) => recordOrganizingBargainingSessionOutcome(supabase, fields),
  recordRatification: (fields) => recordOrganizingRatification(supabase, fields),
  correctRatification: (fields) => correctOrganizingRatification(supabase, fields),
  // The governed exit from a ratification integrity hold. Without this wiring the
  // hold is only clearable by a service-role call, and OrganizeView hides its
  // control (it gates on `typeof api.resolveRatificationIntegrityHold`).
  resolveRatificationIntegrityHold: (fields) => resolveRatificationIntegrityHold(supabase, fields),
  recordFirstContract: (fields) => recordOrganizingFirstContract(supabase, fields),
};


// A verified TOTP factor keeps account deletion on the recent two-step rule;
// without one the deletion dialog asks for the member's password instead. TOTP
// only, as in owesASecondFactor below and authorize_member_account_deletion: a
// phone or WebAuthn factor is one this app cannot challenge, so counting it
// would hide the password field from a member who can never reach aal2.
export function hasVerifiedSecondFactor(user) {
  return Array.isArray(user?.factors)
    && user.factors.some((factor) => factor?.status === "verified" && factor?.factor_type === "totp");
}

// Does this member owe a second factor THIS APP CAN ASK FOR?
//
// Exported, and pure, so the decision can be TESTED rather than pinned as a
// string. That distinction is not academic: an adversarial review appended
// `|| true` to the inline expression this replaces and every text pin in the
// suite still passed, because a pin sees spelling and not meaning.
//
// `nextLevel` alone is the wrong question — it is factor-type-AGNOSTIC. auth-js
// computes it as `user.factors.filter(f => f.status === 'verified')` with no type
// test at all (GoTrueClient.js, 2.110.7). The server's boundary is not agnostic:
// private.mfa_satisfied() counts `f.factor_type = 'totp'` only, deliberately,
// because TOTP is the one type MfaChallenge can verify.
//
// Unmatched, those scopes disagree in the one direction that has no exit. A
// member holding only a verified phone or WebAuthn factor is SATISFIED by RLS,
// so every table answers them — while this gate demanded a code and
// MfaChallenge, filtering to TOTP as well, answered every code with "no
// authenticator is set up for this account". The only other control on that
// screen is sign out, which returns to it. A permanent lockout of a member the
// database was willing to admit, clearable only by an admin reset.
// 20260724034000 fixed the server side and its own test describes the trap; the
// client side kept the defect.
//
// `user.factors` is read straight off the session — the SAME in-memory field
// auth-js derives nextLevel from — never via mfa.listFactors(), which is a
// getUser() round-trip and would put a network call on the boot path of an
// offline-first app that must render from cache when the network is gone.
//
// The scope term is an added conjunct, not a replacement for nextLevel, which
// makes this a pure NARROWING: it can only ever challenge a subset of the
// members it challenges today, so it cannot invent a lockout of its own. The
// subset it drops is exactly the set that could not have passed the challenge.
export function owesASecondFactor(assurance, user) {
  // Array.isArray, not `?? []`: a non-array truthy `factors` (corrupt storage)
  // would throw inside the effect and freeze mfaRequired at null, which renders
  // an eternal loading screen — the same class of dead end this function exists
  // to remove.
  const canBeChallenged = Array.isArray(user?.factors)
    && user.factors.some((factor) => factor.status === "verified" && factor.factor_type === "totp");
  return Boolean(
    assurance && canBeChallenged
    && assurance.nextLevel === "aal2" && assurance.currentLevel !== "aal2",
  );
}

// The last-write-wins rule for task rows lives in boardSync.js, shared with
// TasksView; re-exported here for the callers and tests that read it from App.
export { localTaskRowWins };

//: what a General -> specialized conversion receipt does to the board.
// Pure and exported for the same reason as applyBoardEvent. The RPC answers
// with the bare task row, without the co-assignee projection every other path
// carries, so the receipt is decorated from the current assignments first (an
// editor holding only the primary assignee would drop the others on its next
// assignee change). And the receipt can land after a newer copy of the row,
// from the follow-up refresh or another staff member's write: the same
// last-write-wins rule as every other path keeps the newer row.
export function applyTaskConversionResult(prev, result) {
  const task = withTaskAssignees(result.task, prev.taskAssignments || [], prev.taskAssignees || []);
  const details = prev.taskTemplateDetails || [];
  const existingDetails = details.find((detail) => detail.taskId === result.details.taskId);
  return {
    ...prev,
    tasks: (prev.tasks || []).map((item) => (item.id === task.id && !localTaskRowWins(item, task) ? task : item)),
    taskTemplateDetails: localTaskRowWins(existingDetails, result.details)
      ? details
      : [...details.filter((detail) => detail.taskId !== result.details.taskId), result.details],
  };
}

// A network failure on a write that was not kept on the device says the save
// could not be confirmed, in the member's language, instead of the browser's
// "Failed to fetch" . Once the write was started the request may have
// left and been saved, whatever the browser's offline flag said, so it never
// claims "not saved" and asks the person to check before sending again. It
// takes the network failure itself: an answer that came back keeps its own
// sentence, and so does a timeout.
export function isUnconfirmedWrite(error) {
  return !isRequestTimeoutError(error) && isOfflineError(error, null);
}

const FORM_SUBMISSION_REFUSALS = new Map([
  ["wait for every attachment inspection to finish", "forms.submitInspectionPending"],
  ["wait for attachment deletion to finish", "forms.submitDeletionPending"],
  ["wait for every attachment upload to finish", "forms.submitUploadsPending"],
  ["draw and save a current signature before submitting", "forms.submitSignatureRequired"],
]);

export function mutationFailureNotice(t, error, failureNoticeKey) {
  if (error?.code === "compass_paused") return t("compass.pausedNotice");
  if (error?.code === "question_withheld") return t("guide.errorQuestionWithheld");
  if (isUnconfirmedWrite(error)) return t("offline.unconfirmed");
  const message = typeof error?.message === "string" ? error.message : "";
  if (error?.code === "22023" && error.label === "Form" && message.startsWith("Form: ")) {
    const reason = message.slice("Form: ".length);
    if (reason.startsWith("form incomplete: ")) return t("forms.submitRequiredAnswer");
    const key = FORM_SUBMISSION_REFUSALS.get(reason);
    if (key) return t(key);
  }
  return t(rpcRefusalKey(error, failureNoticeKey || "toast.saveFailed"));
}

// One live board event against one board snapshot. Pure, and exported for the
// same reason owesASecondFactor is: the merge decisions are the contract the
// tests have to hold, not the spelling of the effect around them. The board
// subscription applies events through this as they arrive, and the SUBSCRIBED
// gap refetch REPLAYS its buffered events through it on top of the refetched
// snapshot — that snapshot was read before those events arrived, and without
// the replay it would erase them; broadcasts are fire-and-forget, so the row
// would then stay stale until the next unrelated event.
export function applyBoardEvent(prev, event) {
  if (!prev) return prev;
  const row = event.record || event.oldRecord;
  if (!row?.id) return prev;
  if (event.table === "chapter_workstreams") {
    const list = prev.workstreams || [];
    if (event.operation === "DELETE") {
      if (!list.some((item) => item.id === row.id)) return prev;
      return { ...prev, workstreams: list.filter((item) => item.id !== row.id) };
    }
    const entry = { id: row.id, name: row.name };
    const next = list.some((item) => item.id === row.id)
      ? list.map((item) => (item.id === row.id ? entry : item))
      : [...list, entry];
    // Name order, the same order the boot read asks the server for —
    // a renamed workstream must not jump to the end of the picker.
    return { ...prev, workstreams: next.sort((a, b) => a.name.localeCompare(b.name)) };
  }
  if (event.table === "chapter_task_dependencies") {
    const list = prev.taskDependencies || [];
    if (event.operation === "DELETE") {
      if (!list.some((item) => item.id === row.id)) return prev;
      return { ...prev, taskDependencies: list.filter((item) => item.id !== row.id) };
    }
    // Edges are immutable rows, so INSERT/UPDATE both reduce to upsert-by-id;
    // there is no updated_at to arbitrate because nothing ever rewrites one.
    const edge = chapterTaskDependencyFromRow(row);
    if (list.some((item) => item.id === edge.id)) return prev;
    return { ...prev, taskDependencies: [...list, edge] };
  }
  if (event.table === "chapter_task_subtasks") {
    const list = prev.taskSubtasks || [];
    if (event.operation === "DELETE") {
      if (!list.some((item) => item.id === row.id)) return prev;
      return { ...prev, taskSubtasks: list.filter((item) => item.id !== row.id) };
    }
    const edge = chapterTaskSubtaskFromRow(row);
    if (list.some((item) => item.id === edge.id)) return prev;
    return { ...prev, taskSubtasks: [...list, edge] };
  }
  if (event.table === "chapter_task_assignments") {
    const list = prev.taskAssignments || [];
    const assignment = chapterTaskAssignmentFromRow(row);
    const nextAssignments = event.operation === "DELETE"
      ? list.filter((item) => item.id !== assignment.id)
      : list.some((item) => item.id === assignment.id)
        ? list.map((item) => (item.id === assignment.id ? assignment : item))
        : [...list, assignment];
    const tasks = (prev.tasks || []).map((task) => task.id === assignment.taskId
      ? withTaskAssignees(task, nextAssignments, prev.taskAssignees || [])
      : task);
    return { ...prev, taskAssignments: nextAssignments, tasks };
  }

  if (event.table !== "chapter_tasks") return prev;
  const task = withTaskAssignees(
    chapterTaskFromRow(row),
    prev.taskAssignments || [],
    prev.taskAssignees || [],
  );
  const list = prev.tasks || [];
  const existing = list.find((item) => item.id === task.id);
  // A delayed soft delete or expired-done UPDATE must lose to a newer
  // restore/reopen, just like any other stale update. A physical DELETE
  // can carry only the old row's id and still removes that row.
  if (event.operation !== "DELETE") {
    if (localTaskRowWins(existing, task)) return prev;
  }
  // Off this board rather than changed: purged, soft-deleted (the delete
  // path is an UPDATE that stamps deleted_at), or a done card that has
  // aged past the same 60-day window the boot read uses. Without the
  // last one a long-lived tab accumulates cards a reload would not show.
  const windowFloor = new Date(Date.now() - 60 * 86400000).toISOString();
  const gone = event.operation === "DELETE"
    || Boolean(row.deleted_at)
    || (task.status === "done" && Boolean(task.doneAt) && task.doneAt < windowFloor);
  if (gone) return existing ? { ...prev, tasks: list.filter((item) => item.id !== task.id) } : prev;
  return {
    ...prev,
    tasks: existing ? list.map((item) => (item.id === task.id ? task : item)) : [...list, task],
  };
}

// Does the browser still hold an auth tuple under this key?
//
// A getSession() error is two different failures wearing one shape. auth-js
// rejects an expired or revoked refresh token by calling _removeSession first
// and then returning BOTH a null session and the error, so the slot is empty
// and the member really has departed. An unreadable storage realm returns the
// same shape with the session possibly still live and merely invisible. Read
// the RAW slot rather than the exact-session adapter: the question is only
// whether auth-js's own teardown emptied it, and a realm that refuses the read
// must answer "cannot tell" (false), never "empty".
function appAuthStorageSlotIsEmpty(authStorageKey) {
  if (!authStorageKey) return false;
  try {
    const storage = globalThis.localStorage;
    if (!storage?.getItem) return false;
    return storage.getItem(authStorageKey) === null;
  } catch {
    return false;
  }
}

function appAuthStorageSessionLineage(authStorageKey) {
  try {
    return readAuthStorageSessionLineage(authStorageAdapter(), authStorageKey);
  } catch {
    return undefined;
  }
}

const EXPLICIT_SIGN_OUT_VISIT_KEY = `${appAuthStorageKey}.explicit-sign-out-visit`;

// Error monitoring and analytics load once the authenticated shell has
// committed, off its first paint (src/lib/deferredObservability.js).
function ObservabilityStart() {
  useEffect(() => { startObservability(); }, []);
  return null;
}

// REQ-UG-OFFICER-NOTICES-WITH-READ-RECEIPTS-20261030: the officer
// notice desk's reads on the Announcements tab; publishing is added inside
// MemberApp behind the chapter-switch fence. The server authorizes each call.


// The notice a failed sign-out shows, as a key so an open dialog can show the
// same words inline: the shell notice sits behind modal isolation.
function signOutNoticeKey(error) {
  if (error?.code === "SIGN_OUT_OTHER_DEVICES_UNVERIFIED") return "toast.signOutOtherDevicesUnverified";
  if (error?.code === "SIGN_OUT_PUSH_PAUSED") return "toast.signOutPushPaused";
  return "toast.signOutCleanupFailed";
}

export function MemberApp() {
  const testPreview = import.meta.env.MODE === "test" && Boolean(import.meta.env.VITEST);
  // The sign-in screen always offers the fixture tour in Union Ground; there
  // is no separate SAMPLE origin to send a visitor to.
  const allowDemoCta = appBackendKind !== "sample" || allowsAnonymousDemoEntry();
  const [demo, setDemo] = useState(demoFromUrl);
  // Production parity: on the SAMPLE origin the
  // demo IS the product — the resolved backend is the SAMPLE Supabase project
  // and every read and write below runs the same code paths production runs,
  // under a real seeded-persona session and RLS. In-memory fixtures remain
  // only for the vitest, e2e, and visual-audit harnesses; a SAMPLE origin
  // without SAMPLE keys fails closed to the configuration screen instead of
  // booting fiction.
  const sampleLive = demo && appBackendKind === "sample";
  // Union Ground has no SAMPLE project (config/sample-backend.json is empty),
  // so its public demo is the in-memory fixture tour on its own deployment:
  // ?demo=1 enters fixtures on any host. If a dedicated SAMPLE backend is ever
  // approved, sampleLive takes over.
  const demoActive = (testPreview || demo) && !sampleLive;
  // Fixture-shaped concerns only: data adapters, stubbed staff APIs, and the
  // companion fixture-slice bridge key off this, never off `demo` alone, so
  // the SAMPLE origin keeps live shapes while harness ?demo=1 keeps fixtures.
  const fixtureDemo = demo && demoActive;
  const demoNavigation = fixtureDemo || sampleLive;
  // Which shell this visit renders starts from the visit's explicit choice
  // (`?shell=alt|classic`, then the saved choice); the member's own switch, the
  // member-default-view experiment and VITE_UG_DEFAULT_SHELL resolve the rest
  // below. Presentation only, never an authorization input.
  const [explicitShell, setExplicitShell] = useState(() => explicitShellChoice());
  // Already-resolved fixtures (a harness primed the cache, or the chunk landed
  // on an earlier mount) let a ?demo=1 boot paint on the first render exactly
  // as the old static import did; otherwise the effect below fills them in.
  const bootFixtures = demoActive ? demoData() : null;
  const [session, setSession] = useState(bootFixtures ? demoSessionFor(bootFixtures) : null);
  // BUG-UG-DEMO-HOST-SIGNED-OUT-DEAD-END-20261106: persona routing and
  // the retired demo chrome belong to the fixture build and the six seeded
  // persona sessions. A signed-in SAMPLE organization account on the demo host
  // routes by its own held roles (desk entrances, held-role adoption, its hat
  // remembered and switchable), exactly as on the SaaS origin.
  const personaRouting = demo && (!sampleLive || isSamplePersonaEmail(session?.user?.email));
  // The credentials-free entry on the SAMPLE sign-in screen
  // (UB-UG-DEMO-STRAIGHT-IN-ENTRY-RESTORED-20261107): one mint at a
  // time, and a failure the visitor can read on that screen.
  // Every visitor shares a persona account, so its account-level controls
  // (password, two-step, passkey, other devices' sessions) stay closed.
  const sharedPersonaSession = sampleLive && personaRouting;
  const sampleEntryBusyRef = useRef(false);
  const [sampleEntryError, setSampleEntryError] = useState("");
  const [deletionOutcome, setDeletionOutcome] = useState(null);
  // The member's language when the deletion completed. Sign-out drops the
  // account's language preference, so the completion would otherwise fall
  // back to the device's boot language
  // (BUG-UG-KEEP-WEB-ACCOUNT-DELETION-CONFIRMATION-MEMBER-S-OWN-20261013).
  const [deletionLang, setDeletionLang] = useState(null);
  const [deletionCleanup, setDeletionCleanup] = useState("pending");
  const [deletionHold, setDeletionHold] = useState(false);
  const deletionSessionRef = useRef(null);
  const deletionAccountRef = useRef(null);
  const deletionLineageRef = useRef(null);
  const deletionReceiptRef = useRef(null);
  const deletionCleanupRef = useRef(null);
  // Mirror of `session` for callbacks that must read the CURRENT token without
  // being rebuilt every time it refreshes. Rebuilding adminApi on each refresh
  // would remount the admin desk and throw away whatever the admin was typing.
  const sessionRef = useRef(session);
  // Auth may still be restoring when another tab signs this session out.
  // Capture only this document's initial lineage, never a historical marker.
  const [initialSessionLineage] = useState(() => appAuthStorageSessionLineage(appAuthStorageKey));
  const departedSessionIDRef = useRef(initialSessionLineage);
  // One sign-out at a time (REQ-UG-FIRST-CLICK-AND-DEAD-CONTROLS-20261030):
  // the server cleanup and revocation take two round trips before the page
  // changes, so the controls show that it is underway and a repeat click
  // joins the running sign-out instead of starting a second one.
  const signOutFlightRef = useRef(null);
  const [signingOut, setSigningOut] = useState(false);
  const explicitSignOutRef = useRef(null);
  if (explicitSignOutRef.current === null) {
    // Keep the decision across reloads in this tab, independently of the
    // shared closed-session tombstones used for expiry and revocation too.
    try {
      explicitSignOutRef.current = window.sessionStorage.getItem(EXPLICIT_SIGN_OUT_VISIT_KEY) === "1";
    } catch {
      explicitSignOutRef.current = false;
    }
  }
  const guardRef = useRef(null);
  if (!guardRef.current) {
    guardRef.current = createSessionGuard();
    if (bootFixtures) guardRef.current.beginSession(bootFixtures.member.id);
  }
  const sessionGeneration = guardRef.current.generation;
  const memberSessionLineage = sessionIDFromAccessToken(session?.access_token);
  const memberOperation = useMemo(() => ({
    ...guardRef.current.captureOperation(session?.user?.id ?? null, sessionGeneration),
    sessionLineage: memberSessionLineage,
  }), [memberSessionLineage, session?.user?.id, sessionGeneration]);
  //: every private two-person write (a reply, a contact request or
  // answer, a first message to an officer, a cross-chapter message) carries
  // this session's own token and is refused if another account is signed in
  // by the time it leaves (src/lib/peerContactSession.js).
  // The binder captures the person; same-person token refresh is checked at dispatch.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a token refresh must not replace a composing-person owner
  const composingWriter = useMemo(() => createSessionBoundWriter({ session, sharedClient: supabase, createSessionClient: (current) => createCapturedAppSessionRpcClient(current, { boundedTransport: true }) }), [session?.user?.id]);
  const sessionDataClient = useMemo(() => createSessionBoundDataClient(composingWriter, supabase, { verifySession: verifyCapturedAppSession }), [composingWriter]);
  // Security forms retain their mounted state through a same-lineage refresh;
  // each dispatch still checks the newest token against the captured lineage.
  const sessionAccountClient = useMemo(() => ({
    ...sessionDataClient,
    auth: createAccountSessionClient({ writer: composingWriter, session, sharedClient: supabase, createAccountClient: (current, options) => createCapturedAppAccountClient(current, options), clearCapturedSession: clearCapturedAppSessionLocally }),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- lineage, rather than token object identity, owns the proof
  }), [composingWriter, memberSessionLineage, sessionDataClient]);
  const { accessHistoryRpcApi, chapterAccessApi, unitSettingsApi, organizationFormDocumentsApi, formAutofillApi, loadEventQuorum, loadLiveCaseDetails, stewardApi, memberCaseworkApi, connectedWorkflowApi, messagingApi, appointmentsApi, chapterAppointmentSupervisionApi, vpApi, advisorApi, noticeReadApi } = useMemo(() => createLiveSessionApis(supabase ? sessionDataClient : null), [sessionDataClient]);
  const peerContactApi = useMemo(() => createSessionPeerContactApi({
    sharedClient: supabase,
    session,
    // The shared client's request deadline on every backend ( r2s2).
    createSessionClient: (current) => createCapturedAppSessionRpcClient(current, { boundedTransport: true }),
  }), [session]);
  // Long-lived apis (the cross-chapter list keeps its first page) read the
  // current session's writer at the press, so a token refresh does not rebuild
  // them.
  const peerContactApiRef = useRef(peerContactApi);
  peerContactApiRef.current = peerContactApi;
  const authRevisionRef = useRef(0);
  const [data, setData] = useState(bootFixtures);
  // Record 8435, a review note: an organization setup create that settles later
  // announces and reloads only while the same member and organization are
  // shown. This owner stays mounted across views and hats, so leaving the
  // setup page or switching hat does not drop that completion.
  const setupCompletionScope = useBusyScope(JSON.stringify([data?.member?.id, data?.member?.organizationId]));
  const memberLoaderRef = useRef(null);
  const guideLocalPendingRef = useRef(false);
  const sampleChapterCatalogRef = useRef([]);
  // This clock orders projection commits only. Resource epochs and readiness
  // belong to the loader; navigation cannot leave a separate marker behind.
  const projectionEpochRef = useRef(0);
  const [resourceRevision, setResourceRevision] = useState(0);
  const [memberScopeRevision, setMemberScopeRevision] = useState(0);
  const qaDemoStoreRef = useRef(null);
  if (!qaDemoStoreRef.current) qaDemoStoreRef.current = createInMemoryQaStore();
  const dataRef = useRef(data);
  const mfaClearedRef = useRef(0);
  const mi1ActorRef = useRef(null);
  const mi1ActorKeyRef = useRef("");
  dataRef.current = data;
  const demoMessagingApi = useMemo(() => ({
    ...demoMessagingDefaults,
    // Layout changes remount the conversation. Keep its pending rows in the
    // mounted preview's projection, without mutating the shared fixture.
    schedule: async (conversationId, body, scheduledFor) => {
      const row = { id: `sample-scheduled-${Date.now()}`, conversation_id: conversationId, sender_kind: "member", body, scheduled_for: scheduledFor, status: "pending", samplePreview: true };
      setData((current) => ({
        ...current,
        conversations: (current.conversations || []).map((conversation) => conversation.id === conversationId
          ? { ...conversation, scheduled: [...(conversation.scheduled || []), row] }
          : conversation),
      }));
      return row;
    },
    cancelScheduled: async (scheduledMessageId) => {
      setData((current) => ({
        ...current,
        conversations: (current.conversations || []).map((conversation) => ({
          ...conversation, scheduled: (conversation.scheduled || []).filter((row) => row.id !== scheduledMessageId),
        })),
      }));
      return { cancelled: true, samplePreview: true };
    },
    toggleReaction: createDemoMessageReactionToggle({
      getActorId: () => dataRef.current?.member?.id,
      getData: () => dataRef.current || {},
      updateData: setData,
    }),
  }), []);
  // Demo writes do not have the database's advisory lock/unique index. Cache
  // the first synchronous outcome so two source surfaces clicked before the
  // React state flush still converge on the same typed provenance row.
  const demoSourceTaskOutcomesRef = useRef(new Map());
  const [loading, setLoading] = useState(demoActive ? !bootFixtures : hasAppBackend);
  const [authRestorePending, setAuthRestorePending] = useState(hasAppBackend && !demoActive);
  const [authStorageUnavailable, setAuthStorageUnavailable] = useState(appAuthStorageUnavailable);
  // One straight-in attempt per signed-out interval on the SAMPLE origin; a
  // failed persona sign-in surfaces the honest error screen with a retry
  // rather than looping or falling back to fixtures. The attempt counter is
  // what the retry button bumps — the effect's other dependencies do not
  // change on a click, so without it "Try again" would never re-attempt.
  // Persona mints can overlap (rapid hat switches, a switch racing entry).
  // Every mint takes a sequence number and only the latest one may set or
  // revert hat state — a stale failure must not yank a newer hat back.
  const hatMintSeqRef = useRef(0);
  const hatTransitionQueueRef = useRef(null);
  if (!hatTransitionQueueRef.current) hatTransitionQueueRef.current = createSampleHatTransitionQueue();
  const sampleHatDesiredEmailRef = useRef(null);
  const sampleHatDesiredSequenceRef = useRef(0);
  // The view a SAMPLE switch opens, until that page has drawn and has focus.
  const [sampleHatFocusView, setSampleHatFocusView] = useState(null);
  // Event handlers can run twice before React publishes the first loading
  // render. Keep a synchronous mirror so a rapid return to the authenticated
  // persona still queues the repair behind an in-flight verifyOtp, while a
  // settled same-hat selection remains a true no-op.
  const sampleHatTransitioningRef = useRef(false);
  const [sampleHatTransitioning, setSampleHatTransitioning] = useState(false);
  // The hat a SAMPLE switch is opening, named in its wait. The selected hat
  // itself can fall back to Member while the previous persona's roles are
  // still loaded, so the wait reads the requested hat instead.
  const [sampleHatOpening, setSampleHatOpening] = useState(null);
  const clearSampleHatOpening = useCallback(() => setSampleHatOpening(null), []);
  const [sampleHatSettledSequence, setSampleHatSettledSequence] = useState(0);
  const [dataError, setDataError] = useState("");
  // Counts committed member-data loads: refresh signals for reads outside the
  // member loader, such as steward-message availability .
  const [memberDataCommits, setMemberDataCommits] = useState(0);
  const { notice, noticeAction, noticeId, setNotice } = useActionNotice();
  const [hatRouteRefusal, setHatRouteRefusal] = useState(null);
  // BUG-UG-ACCOUNT-DELETION-FINALIZATION-20260831. Ordinary notices are
  // toasts and self-clear after a few seconds, which is the right shape for a
  // save confirmation and the wrong shape for the terminal outcome of an
  // irreversible account deletion. This one message is held separately so it
  // survives the session teardown that immediately follows it and stays on the
  // signed-out surface instead of vanishing while the shell is still unmounting.
  const {
    deletionAuditPendingNotice,
    setDeletionAuditPendingNotice,
    clearDeletionAuditPendingNoticeForSession,
  } = useDeletionAuditPendingNotice();
  const [view, setView] = useState(viewFromPath);
  const [mobileHomePanel, setMobileHomePanel] = useState("home");
  const consumeMobileHomePanel = useCallback(() => setMobileHomePanel("home"), []);
  const [routeLocation, setRouteLocation] = useState(() => window.location.pathname + window.location.search + window.location.hash);
  const currentRouteHref = useRef(window.location.href);
  currentRouteHref.current = window.location.href;
  const viewRef = useRef(view);
  viewRef.current = view;

  // Role links are real deep links, including from Chapter work back into a
  // dashboard. Staff data arrives asynchronously, so wait for the target
  // region to enter the DOM before scrolling and moving focus. This also makes
  // pasted / back-forward #section URLs reliable instead of timing-dependent.
  useEffect(() => {
    let sectionId;
    try {
      sectionId = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    } catch {
      return undefined;
    }
    if (!STAFF_ROLE_SECTION_IDS.has(sectionId)) return undefined;
    if (focusStaffSection(sectionId)) return undefined;
    const root = document.getElementById("main-content") || document.body;
    const observer = new MutationObserver(() => {
      if (focusStaffSection(sectionId)) observer.disconnect();
    });
    observer.observe(root, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => observer.disconnect(), 5000);
    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
    };
  }, [view]);
  const [guideOpen, setGuideOpen] = useDeviceParityState("app.guideOpen", false);
  const noteGuideNavigationOnce = useRef(0);
  const [tourOpen, setTourOpen] = useDeviceParityState("app.tourOpen", false);
  // REQ-UG-PROGRESSIVE-DISCLOSURE-AND-FEATURE-DRIP-20261001: the member
  // onboarding guide. Read only for a live session whose organization turned
  // a guide switch on, so the default boot makes no extra request.
  const {
    payload: onboardingGuidePayload,
    loadFailed: onboardingGuideLoadFailed,
    retry: retryOnboardingGuide,
    showAll: onboardingGuideShowAll,
    setShowAll: setOnboardingGuideShowAll,
  } = useMemberOnboardingGuide({
    client: demoActive ? null : sessionDataClient,
    enabled: !demoActive && Boolean(session) && onboardingGuideSwitchesOn(data?.organizationConfiguration),
    memberId: data?.member?.id ?? null,
    organizationId: data?.member?.organizationId ?? null,
    chapterId: data?.member?.chapterId ?? null,
    refreshKey: view,
    // The sample site's seeded personas start on the full navigation.
    showAllByDefault: sampleLive && samplePersonas().some((persona) => persona.email === session?.user?.email),
  });
  // REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP2-20261023: the guide
  // engine's member layers, each behind its own switch. Port step 3 defined
  // both on the server, on by default; an organization that turns one off
  // stops its layer, and these hooks then read and write nothing.
  const guideLayerSwitches = !demoActive && session ? data?.organizationConfiguration?.switches ?? null : null;
  const featureGuidesOn = proposedSwitchOn(guideLayerSwitches, "featureGuides");
  //: member-coach-mark is the experiment-ready PostHog flag; "test"
  // withholds the coach mark, and its default "control" keeps it.
  const coachMarksSwitchOn = proposedSwitchOn(guideLayerSwitches, "coachMarks");
  const coachMarkVariant = useMemberFeatureFlag("member-coach-mark", { exposed: coachMarksSwitchOn });
  const coachMarksOn = coachMarksSwitchOn && coachMarkVariant !== "test";
  // REQ-UG-AB-MEMBER-DEFAULT-ALT-VIEW-20261030: the alternate shell as
  // an A/B member default view (src/alt/altShell.js has the precedence). The
  // member-default-view flag decides only for a signed-in member with no staff,
  // organization or chapter role and no switch or query choice of their own,
  // and only then is its exposure recorded.
  const shellUserId = session?.user?.id ?? null;
  const [shellPreferenceOverride, setShellPreferenceOverride] = useState(null);
  // Keep the demo visitor's layout for this tab across demo role switches.
  const demoMessageWorkflow = useState(MESSAGE_WORKFLOW_DEFAULT);
  const visitorMessageWorkflow = sharedPersonaSession ? demoMessageWorkflow : null;
  const storedShellPreference = useMemo(() => readMemberShellPreference(shellUserId), [shellUserId]);
  const shellPreference = shellPreferenceOverride?.userId === shellUserId ? shellPreferenceOverride.shell : storedShellPreference;
  const shellInputs = { explicit: explicitShell, preference: shellPreference, eligible: memberShellExperimentEligible({ signedIn: Boolean(session), demo: Boolean(demo), data }) };
  const memberShellVariant = useMemberFeatureFlag(MEMBER_SHELL_FLAG, { exposed: resolveMemberShell(shellInputs).flagDecides });
  const altShell = resolveMemberShell({ ...shellInputs, flagValue: memberShellVariant }).shell === ALT_SHELL;
  const switchShell = useCallback((next) => {
    if (!shellUserId) return;
    writeMemberShellPreference(shellUserId, next);
    setShellPreferenceOverride({ userId: shellUserId, shell: next });
    setExplicitShell(null);
    // A `shell` query on this address would outrank the member's own switch.
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has(SHELL_QUERY_PARAM)) {
        url.searchParams.delete(SHELL_QUERY_PARAM);
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
    } catch { /* the choice still holds for this page */ }
  }, [shellUserId]);
  const shellSwitchAvailable = Boolean(shellUserId) && !fixtureDemo;
  const guideLayers = useMemberGuideLayers({ memberId: data?.member?.id ?? null, featureGuidesOn, coachMarksOn });
  const coachFacts = useCoachMarkFacts({ active: coachMarksOn && view === "memberSupport", screenKey: view });
  const { markFeature: markGuideFeature } = guideLayers;
  const markFeatureGuideSeen = useCallback((feature) => markGuideFeature("seen", feature), [markGuideFeature]);
  useEffect(() => { noteGuideNavigationOnce.current += 1; if (noteGuideNavigationOnce.current > 1) noteGuideNavigation(); }, [view]);
  // The hat the account last wore explicitly. Routes are never allowed to
  // infer or replace identity: selecting a staff-looking destination while
  // wearing Member must not silently turn the member into Coordinator or
  // Steward. SAMPLE first entry is the one owner exception: Steward.
  const [selectedStaffHat, setSelectedStaffHat] = useDeviceParityState(
    "app.selectedStaffHat",
    () => initialHatFromPath(demo),
  );
  // A staff-looking SAMPLE URL never changes identity. Preserve that boundary,
  // but explain the intentional Steward fallback instead of silently replacing
  // an Admin, Advisor, Coordinator, or President deep link.
  // Union Ground's fresh visit wears Worker, so the "this link starts as"
  // explanation is true only while the visitor still wears that default; a
  // remembered staff hat keeps its own refusal copy instead.
  const [staffDeepLinkFallback, setStaffDeepLinkFallback] = useState(() => staffDeepLinkFallsBackToSteward(demo) && selectedStaffHat === DEFAULT_SAMPLE_HAT);
  // The banner may keep explaining a cold SAMPLE staff URL for the mount, but
  // the refusal toast uses that copy only for the first redirect. Later hat
  // refusals name the worn hat and destination.
  const staffDeepLinkFallbackNoticeRef = useRef(staffDeepLinkFallback);
  // The last refused address and the desk that opens it (deskForRefusedRoute).
  const pendingDeskRouteRef = useRef(null);
  // switchHat publishes the new hat before its destination view lands. That
  // transient mismatch is not a refused URL — skip the toast for it.
  const lastGatedStaffHatRef = useRef(selectedStaffHat);
  // Browser traversal can race React's deferred staff-plane repaint. Keep the
  // acknowledged hat available synchronously so Back cannot leave a Member
  // URL paired with staff content (or vice versa) for an entire render.
  const selectedStaffHatRef = useRef(selectedStaffHat);
  const connectedDemoStateRef = useRef({ scope: null, tasks: new Map(), sources: new Map(), reminders: new Map(), sends: new Map() });
  useEffect(() => { selectedStaffHatRef.current = selectedStaffHat; }, [selectedStaffHat]);
  // REQ-UG-TYPED-ADDRESS-ROLE-DESK-BOUNCE-20261030: the account that
  // chose the restored hat, until the session confirms it is the same one,
  // and the address this page load arrived on. A typed or reloaded address is
  // decided once, when the roles first arrive.
  const actingHatOwnerRef = useRef(demo ? null : readActingHat()?.userId ?? null);
  // The address this visit arrived on, for held-role adoption. A fixture
  // demo has no held roles to adopt; on SAMPLE the route gate itself limits
  // adoption to organization accounts (personaRouting), so keep it there.
  const entryRouteRef = useRef(demo && !sampleLive ? null : normalizeAppPath(window.location.pathname));
  // Vitest forces demo fixtures for every App render; treating that harness as
  // a real entry would hide every existing screen assertion behind the modal.
  // Production direct entries and the explicit enterDemo action still open it.
  // A signed-in SAMPLE account on the demo host never sees it: its copy
  // describes the retired shared workspace ("entering as Darnell Foster", "no
  // account is needed", "reset periodically"), none of which is true for the
  // fictional organization accounts (BUG-UG-DEMO-HOST-SIGNED-OUT-DEAD-END-20261106).
  const [demoWelcomeOpen, setDemoWelcomeOpen] = useState(() => !testPreview && !sampleLive && demoEntryFromUrl());
  // The welcome, the preview guide and the tour close with the prototype
  // modal's 200 ms fade, however they are dismissed.
  const demoWelcomeExit = useModalExit(demoWelcomeOpen);
  const guideExit = useModalExit(guideOpen);
  const tourExit = useModalExit(tourOpen);
  const [assistantOpen, setAssistantOpen] = useDeviceParityState("app.assistantOpen", false);
  const [assistantDraft, setAssistantDraft] = useDeviceParityState("app.assistantDraft", "");
  const [assistantSearchTarget, setAssistantSearchTarget] = useState(null);
  // One identity (design Step 2): the selectable app palettes are retired, so
  // a palette saved under "sg-app-theme" is never read again (it is left in
  // place, unread, rather than deleted). The site renders light only
  // (REQ-UG-DISABLE-DARK-MODE-WEB-AND-MOBILE-20261105): the system colour
  // scheme is never read.
  // PR8: connection state, the queued-writes badge, and the search deep-link
  // payload the target view consumes to land on the item itself.
  // BUG-UG-WEB-HOME-REPAINTS-PREVIOUS-CHAPTER-AFTER-SWITCH-20261111:
  // member data is painted only from fresh authenticated reads. No saved copy
  // (session-storage Home slice or IndexedDB snapshot) is ever a render source,
  // so a chapter switch can never be followed by the previous chapter's data.
  const [offline, setOffline] = useState(typeof navigator !== "undefined" && navigator.onLine === false);
  const [pendingSync, setPendingSync] = useState(0);
  const [searchFocus, setSearchFocus] = useDeviceParityState("app.searchFocus", null);
  const [profileOpen, setProfileOpen] = useDeviceParityState("app.profileOpen", false);
  const [notificationsOpen, setNotificationsOpen] = useDeviceParityState("app.notificationsOpen", false);
  // MINUTES-NOTIFICATION-REFRESH-OPEN-CHAPTER-RECORD: opening a notice's
  // destination is an explicit intent, with a fresh id each time, so a panel
  // that is already mounted on that route can reload instead of keeping its old
  // list. In memory only; it never reaches storage.
  const [notificationOpenIntent, setNotificationOpenIntent] = useState(null);
  const notificationOpenCounter = useRef(0);
  // Union Ground has no member PIN sign-in, so no session is ever a restricted
  // PIN session: the upstream step-up state is constant here, and its
  // setter is a no-op for the code paths that would mark a session restricted.
  const sessionRestricted = false;
  // At the first sign-in after a material change to a
  // published instrument, the person is asked once to accept the current
  // version, and the database records that acceptance with its version, the
  // time, the person and the organization. The read answers only for the
  // caller; while it is unknown (no session, a demo surface, a failed read)
  // nothing is claimed about this reader and nothing is shown.
  // undefined means the first read has not answered yet (the cold-boot window);
  // null means unknown for good (no session, a demo surface, a failed read).
  const [legalAcceptance, setLegalAcceptance] = useState(undefined);
  // Only a published material change makes the read worth a cold-boot call;
  // terms of use 0.2.0 (adults-only, October 12, 2026) is the first.
  // Owner ruling, October 29, 2026: "NO TERMS FOR SAMPLE. SAMPLE HAS NO REAL
  // USERS". Decided by the project the active client connects to, so a main
  // client pointed at SAMPLE is never asked and nothing is recorded there.
  const legalAcceptanceToken = demoActive || appBackendIsSampleProject || !legalAcceptanceReadNeeded()
    ? null
    : session?.access_token ?? null;
  // A refresh answers for the session that started it: after a sign-out or an
  // account switch its late result is dropped, so one account's acceptance
  // never hides the next account's prompt.
  const legalAcceptanceTokenRef = useRef(legalAcceptanceToken);
  legalAcceptanceTokenRef.current = legalAcceptanceToken;
  const refreshLegalAcceptance = useCallback(() => {
    if (!legalAcceptanceToken) return Promise.resolve(null);
    return loadLegalAcceptanceState(supabase).then((state) => {
      if (legalAcceptanceTokenRef.current !== legalAcceptanceToken) return null;
      setLegalAcceptance(state);
      return state;
    });
  }, [legalAcceptanceToken]);
  useEffect(() => {
    if (!legalAcceptanceToken) {
      setLegalAcceptance(undefined);
      return undefined;
    }
    let active = true;
    loadLegalAcceptanceState(supabase).then((state) => { if (active) setLegalAcceptance(state); });
    return () => { active = false; };
  }, [legalAcceptanceToken]);
  const legalReacceptance = legalAcceptanceRequirement(legalAcceptance);
  // BUG-UG-TERMS-REACCEPTANCE-GATE-LOCKOUT-20261030: the account
  // whose acceptance the database refused because it does not hold the
  // versions this site shows (src/lib/legalAcceptance.js
  // recordLegalAcceptanceOutcome). Keyed on the account, not the token, so a
  // token refresh keeps it and a different account starts gated again.
  const legalAcceptanceUserId = legalAcceptanceToken ? session?.user?.id ?? null : null;
  const [legalPackUnavailableFor, setLegalPackUnavailableFor] = useState(null);
  const legalPackUnavailable = Boolean(legalAcceptanceUserId) && legalPackUnavailableFor === legalAcceptanceUserId;
  const markLegalPackUnavailable = useCallback(() => setLegalPackUnavailableFor(legalAcceptanceUserId), [legalAcceptanceUserId]);
  // Protected views wait for the first answer, so a slow read cannot expose
  // them, and they stay withheld while an acceptance is outstanding. A read
  // that fails settles to null and opens them (unknown is never a claim).
  // A deployment whose database cannot record the versions it shows opens them
  // too, with the card still in front: the 1.0.0 pack (supabase/migrations/
  // 20261016230000_legal_pack_operative_1_0_0.sql) set that a prompt which
  // cannot record "never blocks sign-in".
  const legalBlocked = (legalReacceptance.reacceptanceRequired && !legalPackUnavailable)
    || (legalAcceptanceToken && legalAcceptance === undefined);
  useEffect(() => {
    let notificationId;
    try { notificationId = new URLSearchParams(window.location.search).get("notification"); } catch { notificationId = null; }
    if (notificationId && (data?.notifications || []).some((item) => item.id === notificationId)) setNotificationsOpen(true);
  }, [data?.notifications, setNotificationsOpen]);
  const [activePlan, setActivePlan] = useDeviceParityState("app.activePlan", null);
  // The chapter sheet (2026-08-05 card-nav wave) rides parity state so the
  // desktop/companion pair shows one truth.
  const [chapterSheetOpen, setChapterSheetOpen] = useDeviceParityState("app.chapterSheetOpen", false);
  // One live chapter switch at a time (rail on desktop, My chapter elsewhere);
  // the options are refreshed every render and read when a choice is made.
  const [chapterSwitching, setChapterSwitching] = useState(false);
  const [chapterTransition, setChapterTransition] = useState(null);
  const chapterTransitionRef = useRef(null);
  const pendingEventCreatesRef = useRef(new Set());
  const chapterSelectOptionsRef = useRef(null);
  const selectMemberChapterRef = useRef(null);
  if (!selectMemberChapterRef.current) selectMemberChapterRef.current = createLiveChapterSelector(() => chapterSelectOptionsRef.current);
  // Desktop's second rail is navigation context, not identity. A demo choice
  // therefore lives only in this mounted App and never rewrites the member,
  // session, URL, or any backing store.
  const [demoChapterSelection, setDemoChapterSelection] = useState(null);
  const demoChapterTriggerRef = useRef(null);
  const restoreDemoChapterFocusRef = useRef(false);
  const clearDemoChapterSelection = useCallback((restoreFocus = false) => {
    restoreDemoChapterFocusRef.current = restoreFocus;
    setDemoChapterSelection(null);
  }, []);
  useEffect(() => {
    if (demoChapterSelection || !restoreDemoChapterFocusRef.current) return;
    restoreDemoChapterFocusRef.current = false;
    demoChapterTriggerRef.current?.focus();
  }, [demoChapterSelection]);
  const [bootLang, setBootLang] = useState(bootLanguage);
  // REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030 (finding 93): a
  // tab whose visit ended with an explicit sign-out reopens on the sign-in
  // card after a reload, not on the public landing page.
  const [showSignIn] = useState(() => normalizeAppPath(window.location.pathname) !== "/" || explicitSignOutRef.current === true);
  const openSignupOffered = useOpenSignupAvailable() === true;
  // Push capability on THIS device/browser. supported requires the platform
  // APIs, a registered service worker, and a configured VAPID public key —
  // absent any of those the settings screen shows the unsupported note.
  // null = not yet known. Distinct from false so the shell is not rendered for
  // the moment before the assurance answer arrives — a member who owes a code
  // would otherwise see their dashboard flash up and then, now that RLS
  // enforces the boundary, repaint itself empty before the challenge appears.
  const [mfaRequired, setMfaRequired] = useState(demoActive ? false : null);
  const [pushState, setPushState] = useState({ supported: false, subscribed: false, denied: false });
  // Switching planes now costs a chunk fetch. Marking those navigations as a
  // transition lets React hold the CURRENT plane on screen while the next one
  // arrives — dimmed, via .is-switching — instead of tearing it down to a bare
  // Suspense fallback the moment the button is pressed. Member navigation is
  // deliberately left urgent: those chunks are warmed on boot, so a transition
  // would only add latency to a switch that is already instant.
  const [isSwitching, startViewTransition] = useTransition();

  // Desktop shell (PR A of the design build-out). The gate is JS, not CSS:
  // jsdom answers matches:false to every width query, so tests and narrow
  // viewports render the phone shell untouched, and exactly one nav is ever
  // in the DOM — a CSS-hidden rail would leave two "Today" links for
  // getByRole and for screen readers. Guarded because older jsdom lacks
  // matchMedia entirely.
  //
  // UB-NAV-04 owns the band between the phone and desktop contracts. Keep the
  // tablet query exclusive so a resize can never mount the phone cards and
  // rail at the same time, and keep it separate from the desktop query so
  // tablet views retain touch-friendly responsive anatomy instead of opting
  // into desktop density.
  //
  // Both queries feed ONE shell state, read from both lists at once, so a
  // resize changes the shell in one commit. With a
  // state per query, the desktop query's change event committed before the
  // tablet query's: for one commit neither held, so going from desktop down
  // to tablet mounted the phone shell and replaced the rail, losing its
  // focus, open tooltip and scroll.
  const [shellScreen, setShellScreen] = useState(() => {
    try {
      return typeof window.matchMedia === "function"
        ? shellScreenOf(window.matchMedia("(min-width: 1024px)"), window.matchMedia("(min-width: 768px) and (max-width: 1023px)"))
        : "phone";
    } catch { return "phone"; }
  });
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const wide = window.matchMedia("(min-width: 1024px)");
    const tablet = window.matchMedia("(min-width: 768px) and (max-width: 1023px)");
    // Either list's change re-reads both, so the first event of a resize
    // already lands on the final shell and the second changes nothing.
    const onChange = () => setShellScreen(shellScreenOf(wide, tablet));
    const lists = [wide, tablet];
    for (const mq of lists) {
      if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
      else mq.addListener(onChange);
    }
    // A resize between the first read and the
    // subscription fires no event, so read both lists once more now.
    onChange();
    return () => {
      for (const mq of lists) {
        if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", onChange);
        else mq.removeListener(onChange);
      }
    };
  }, []);
  const wideScreen = shellScreen === "desktop";
  const tabletScreen = shellScreen === "tablet";
  // Embedded companion instance? Read once — the query never changes without
  // a full page load, and the outer shell always mints the iframe URL.
  const [embedPhone] = useState(embedPhoneFromUrl);
  const desktopShell = wideScreen && !embedPhone;
  const tabletShell = tabletScreen && !wideScreen && !embedPhone;
  const railShell = desktopShell || tabletShell;
  // Where a SAMPLE chapter choice opens the chapter catalog page: the desktop
  // shell, and the classic tablet shell since its rail gained the Chapters
  // button . The alternate shell keeps it desktop-only.
  const demoChapterLanding = desktopShell || (tabletShell && !altShell);
  useEffect(() => {
    if (demoChapterLanding && demo === true) return;
    clearDemoChapterSelection(false);
  }, [clearDemoChapterSelection, demo, demoChapterLanding]);
  // The companion iframe, so navigate() can mirror member-route changes into
  // the phone. Null on narrow screens, staff hats, and inside the embed.
  const companionRef = useRef(null);
  // Unlike a selected tab, this projection must survive both Messages routes
  // unmounting. Each App owns a durable copy and only explicit local peer
  // mutations cross this dedicated, allow-listed channel.
  const peerContactDataRef = useRef(null);
  peerContactDataRef.current = sanitizePeerContactProjection(data?.peerContact);
  // One parity store belongs to one mounted app/document. Clearing only at
  // final unmount prevents a later test or signed-out tree inheriting stale
  // disclosures while preserving state across lazy view mounts.
  useEffect(() => () => clearDeviceParityState(), []);
  // Roles read through a ref so the two mirror listeners don't re-subscribe
  // on every data refresh; they only gate which staff paths the mirror follows.
  const mirrorRolesRef = useRef([]);
  mirrorRolesRef.current = data?.roles || [];
  const companionAuthorizationReady = Boolean(data && !data.rolesUnknown);

  // In fixture demo the seeded data.member.language is fixed, so the
  // client-side language toggle drives off bootLang instead; real sessions —
  // including SAMPLE-live personas — use the member's saved language.
  // The requested language renders only once its catalogue has loaded
  // (src/lib/useLoadedLanguage.js); until then the shell keeps the language
  // already on screen, and the pre-auth surfaces do the same off bootLang.
  // Before a real session's settings load (the verification-code page), the
  // language this account last used on this device; never another account's
  // (src/lib/accountLanguage.js).
  //: the six demo people are shared accounts, so on the demo their
  // saved language is nobody's in particular. There the visitor's own choice
  // (the device's sg-lang) shows and carries across every role switch.
  const visitorLanguage = fixtureDemo || sharedPersonaSession;
  const languageUserId = session?.user?.id ?? null;
  const signedInLang = useMemo(() => (visitorLanguage ? null : accountLanguage(languageUserId)), [visitorLanguage, languageUserId]);
  const requestedLang = visitorLanguage ? bootLang : (data?.member?.language ?? signedInLang ?? bootLang);
  // Advanced by every language selection, so choosing a language whose
  // catalogue failed to load tries the fetch again.
  const [languageAttempt, setLanguageAttempt] = useState(0);
  const { lang, pending: languagePending } = useLoadedLanguage(requestedLang, loadLanguage, languageAttempt);
  const { lang: shownBootLang } = useLoadedLanguage(bootLang, loadLanguage, languageAttempt);
  // A member whose saved language this device has never loaded would otherwise
  // see the first shell paint in English for the length of the fetch; until the
  // shell has painted once, that wait stays on the loading screen instead.
  const shellPaintedRef = useRef(false);
  useEffect(() => {
    if (data && !languagePending) shellPaintedRef.current = true;
  });
  const organizationLabelOverrides = data?.organizationConfiguration?.labelOverrides
    ?? (fixtureDemo ? demoData()?.adminDesk?.configuration?.labelOverrides : undefined);
  // The shell's organization line and the member card name the member's own
  // organization, never a hard-coded one. Fixture demo uses its seeded name;
  // live and SAMPLE sessions read their own organization row once per id.
  const currentOrganizationId = fixtureDemo ? null : data?.member?.organizationId ?? null;
  const cosmeticClient = useMemo(() => {
    if (fixtureDemo || !session?.access_token || !currentOrganizationId) return null;
    // Cosmetics are optional. An unavailable captured client must leave this
    // surface unavailable, rather than breaking the authenticated app shell.
    try { return createCapturedAppSessionRpcClient(session); }
    catch { return null; }
  }, [fixtureDemo, session, currentOrganizationId]);
  const freeCosmetics = useFreeCosmetics(cosmeticClient, session?.user?.id ?? null, currentOrganizationId);
  // BUG-UG-DUES-NAV-SHOWN-WITHOUT-DUES-20261108: the same captured,
  // optional reader answers whether this organization runs dues; only a
  // definite "no" takes Dues out of the menus (duesNavigation.js).
  const runsDues = useOrganizationRunsDues(cosmeticClient, session?.user?.id ?? null, currentOrganizationId);
  const duesNav = runsDues !== false;
  const [organizationNameState, setOrganizationNameState] = useState({ id: null, name: null });
  useEffect(() => {
    if (!currentOrganizationId || !supabase) return undefined;
    let cancelled = false;
    loadOrganizationName(supabase, currentOrganizationId).then((name) => {
      if (!cancelled) setOrganizationNameState({ id: currentOrganizationId, name });
    });
    return () => { cancelled = true; };
  }, [currentOrganizationId]);
  const currentOrganizationName = fixtureDemo
    ? demoData()?.adminDesk?.organization?.name ?? null
    : organizationNameState.id === currentOrganizationId ? organizationNameState.name : null;
  const tr = useMemo(() => organizationTranslator(lang, organizationLabelOverrides), [lang, organizationLabelOverrides]);

  const changeBootLanguage = useCallback((next) => {
    setBootLang(next);
    setLanguageAttempt((attempt) => attempt + 1);
    // Union Ground keeps its own key so a browser that also used the sibling
    // product never carries that product's choice across; the legacy sg-lang
    // value is read once at boot (bootLanguage) and then dropped here.
    try {
      window.localStorage.setItem("unionground-lang", next);
      window.localStorage.removeItem("sg-lang");
    } catch { /* ignore */ }
  }, []);
  // A real session's saved language belongs to that account's slot, never to
  // the device's sg-lang, so the signed-out pages keep the device's own choice
  // after sign-out instead of the departing member's.
  useEffect(() => {
    const saved = data?.member?.language;
    if (!visitorLanguage && languageUserId && data?.member?.id === languageUserId) rememberAccountLanguage(languageUserId, saved);
  }, [visitorLanguage, languageUserId, data?.member?.id, data?.member?.language]);

  // A fully client-side steward desk for the demo: it mutates an in-memory
  // clone of the seed so triage/reply/publish/retract feel real, and touches
  // no backend. loadDesk returns a fresh deep copy so React re-renders.
  const demoDeskRef = useRef(null);
  // The demo steward's appointments desk, same cached-clone contract as the
  // request queue: mutations must land in the copy loadAppointments re-serves.
  const demoApptDeskRef = useRef(null);
  // One report store belongs to all three authorized supervisor hats; changing
  // hats never resets or forks an appointment reassignment.
  const demoChapterAppointmentSupervisionRef = useRef(null);
  // Freshest demo draft row per form id — written by handleSaveDraft's twin,
  // read by handleSubmitForm's twin, because the submit closure's `data`
  // predates the persist that just flushed the final answers.
  const demoDraftRowsRef = useRef(new Map());
  const demoSpaceMembersRef = useRef(new Map());
  // Signature strokes and File objects are intentionally session-memory only
  // in demo. The filing UI labels that boundary; no sample action implies a
  // persisted legal filing or sends data to Storage.
  const demoFormSignaturesRef = useRef(demoSignatureRows(bootFixtures?.forms));
  const demoFormFilesRef = useRef(new Map());
  const demoStewardApi = useMemo(() => {
    const desk = () => {
      if (!demoDeskRef.current) demoDeskRef.current = JSON.parse(JSON.stringify(demoData().stewardDesk));
      return demoDeskRef.current;
    };
    const clone = () => JSON.parse(JSON.stringify(desk()));
    const casework = createDemoCaseworkApi(async () => ({ cases: desk().caseload || [] }));
    // Deliberately tiny demo pages (UB-DESK-01): the seeded desk holds a
    // handful of rows, and the point of the demo is to SHOW the paging — a
    // 100-row production page would swallow the whole seed and hide the
    // control a visitor came to see. Same pager semantics as SQL, via the
    // stewardDeskPaging twins. Forms page stays wide enough for the seeds
    // PLUS a fresh member filing: the inbox sorts oldest-first, so a tiny
    // page would hide the demo's own "your form arrived" moment on page two.
    const DEMO_PAGE = { queue: 2, threads: 2, forms: 5, broadcasts: 2, appointments: 2 };
    const snapshot = async () => {
      const full = clone();
      const queuePage = pageStewardRequests(full.queue, { limit: DEMO_PAGE.queue });
      const threadPage = pageStewardThreads(full.threads, { limit: DEMO_PAGE.threads });
      const formPage = pageStewardForms(full.formsInbox || [], { limit: DEMO_PAGE.forms });
      const broadcastPage = pageStewardBroadcasts(full.broadcasts, { limit: DEMO_PAGE.broadcasts });
      return {
        ...full,
        queue: queuePage.rows,
        queueCursor: queuePage.nextCursor,
        queueTotal: queuePage.total,
        threads: threadPage.rows,
        threadsCursor: threadPage.nextCursor,
        threadsTotal: threadPage.total,
        formsInbox: formPage.rows,
        formsCursor: formPage.nextCursor,
        formsTotal: formPage.total,
        broadcasts: broadcastPage.rows,
        broadcastsCursor: broadcastPage.nextCursor,
        broadcastsTotal: broadcastPage.total,
      };
    };
    const approveDemoForm = async (formId, note = "") => {
      const d = desk();
      const item = (d.formsInbox || []).find((entry) => entry.id === formId);
      if (!item) return true;
      const approvedAt = new Date().toISOString();
      const artifactDigest = `demo-artifact-${formId}-${Date.now()}`;
      d.formsInbox = (d.formsInbox || []).filter((entry) => entry.id !== formId);
      setData((current) => ({
        ...current,
        forms: (current.forms || []).map((form) => (form.id === formId ? {
          ...form,
          status: "approved",
          reviewNote: note,
          artifactApprovedAt: approvedAt,
          artifactApprovedBy: "demo-steward",
          artifactDigest,
        } : form)),
      }));
      return { approvedAt, artifactDigest };
    };
    const contactNotes = new Map();
    const scheduledMessages = new Map();
    const emailIntakes = [{
      id: "sample-email-intake-1",
      chapterId: "wor",
      from: "night-shift-member@example.invalid",
      subject: "Overnight schedule question",
      text: "Could a steward follow up about the posted overnight schedule?",
      receivedAt: "2026-08-12T12:00:00.000Z",
      status: "pending",
    }];
    return {
      loadDesk: snapshot,
      loadCaseHistory: casework.loadCaseHistory,
      updateCase: casework.updateCase,
      loadRequests: async (opts = {}) => pageStewardRequests(clone().queue, { ...opts, limit: opts.limit ?? DEMO_PAGE.queue }),
      loadThreads: async (opts = {}) => pageStewardThreads(clone().threads, { ...opts, limit: opts.limit ?? DEMO_PAGE.threads }),
      loadForms: async (opts = {}) => pageStewardForms(clone().formsInbox || [], { ...opts, limit: opts.limit ?? DEMO_PAGE.forms }),
      loadBroadcasts: async (opts = {}) => pageStewardBroadcasts(clone().broadcasts, { ...opts, limit: opts.limit ?? DEMO_PAGE.broadcasts }),
      loadThreadMessages: async (conversationId, opts = {}) => {
        const row = clone().threads.find((item) => item.id === conversationId);
        return pageStewardThreadMessages(row?.messages || [], opts);
      },
      triage: async (requestId, action) => {
        const d = desk();
        const item = d.queue.find((q) => q.id === requestId);
        if (item) item.status = action === "close" ? "closed" : "acknowledged";
        d.kpis.openRequests = d.queue.filter((q) => q.status !== "closed").length;
        return true;
      },
      reply: async (conversationId, body) => {
        const d = desk();
        const thread = d.threads.find((t) => t.id === conversationId);
        if (thread) {
          thread.messages.push({ id: `demo-reply-${thread.messages.length + 1}`, sender_kind: "steward", sender_name: "Committee", body, created_at: new Date().toISOString() });
          thread.awaitingReply = false;
          thread.preview = body.slice(0, 80);
          thread.updatedAt = new Date().toISOString();
        }
        d.kpis.awaitingReply = d.threads.filter((t) => t.awaitingReply).length;
        return true;
      },
      toggleReaction: createDemoMessageReactionToggle({
        getActorId: () => dataRef.current?.member?.id,
        getData: desk,
        updateData: (update) => { demoDeskRef.current = update(desk()); },
      }),
      toggleSaved: async () => ({ saved: true, samplePreview: true }),
      remind: async () => ({ id: `sample-reminder-${Date.now()}`, status: "pending", samplePreview: true }),
      schedule: async (conversationId, body, scheduledFor) => {
        const row = { id: `sample-scheduled-${Date.now()}`, conversation_id: conversationId, sender_kind: "steward", body, scheduled_for: scheduledFor, status: "pending", samplePreview: true };
        scheduledMessages.set(conversationId, [...(scheduledMessages.get(conversationId) || []), row]);
        return row;
      },
      listScheduled: async (conversationId) => JSON.parse(JSON.stringify(scheduledMessages.get(conversationId) || [])),
      cancelScheduled: async (scheduledMessageId) => {
        for (const [conversationId, rows] of scheduledMessages) {
          scheduledMessages.set(conversationId, rows.filter((row) => row.id !== scheduledMessageId));
        }
        return { cancelled: true, samplePreview: true };
      },
      cancelReminder: async () => ({ cancelled: true, samplePreview: true }),
      getBroadcastReadCounts: async () => desk().broadcasts.map((item) => ({
        broadcastId: item.id,
        readCount: item.readCount ?? 0,
      })),
      sendResource: async (conversationId, documentId, body) => {
        const d = desk();
        const thread = d.threads.find((item) => item.id === conversationId);
        const document = (demoData().product?.documents || []).find((item) => item.id === documentId);
        const row = { id: `sample-resource-${Date.now()}`, sender_kind: "steward", sender_name: "Organizing committee", body: body || "Shared resource", created_at: new Date().toISOString(), reactions: [], saved: false, resource: { documentId, title: document?.title || "", documentType: document?.document_type || "document" } };
        if (thread) thread.messages.push(row);
        return { messageId: row.id, documentId, samplePreview: true };
      },
      listContactNotes: async (conversationId) => contactNotes.get(conversationId) || [],
      // The SAMPLE fixture carries no preservation orders and grants no admin
      // capability to place one: status reads "not held, cannot manage" so
      // the dialog renders neither a marker nor a control it could not honour.
      loadLegalHold: async () => ({ held: false, reasonCode: null, placedAt: null, canManage: false }),
      createContactNote: async (conversationId, note, sourceMessageId) => {
        const row = { id: `sample-note-${Date.now()}`, conversationId, note, sourceMessageId, authorId: "sample-steward", createdAt: new Date().toISOString() };
        contactNotes.set(conversationId, [row, ...(contactNotes.get(conversationId) || [])]);
        return { id: row.id, created: true, samplePreview: true };
      },
      listEmailIntakes: async (status = "pending") => JSON.parse(JSON.stringify(emailIntakes.filter((item) => item.status === status))),
      reviewEmailIntake: async (intakeId, action) => {
        const item = emailIntakes.find((row) => row.id === intakeId);
        const next = action === "claim" && item?.status === "pending" ? "reviewing"
          : ["accept", "reject"].includes(action) && item?.status === "reviewing" ? `${action}ed`
            : action === "reopen" && ["accepted", "rejected"].includes(item?.status) ? "reviewing"
              : null;
        if (!item || !next) throw new Error("Preview review state changed. Refresh and try again.");
        item.status = next;
        return { reviewed: true, status: next, samplePreview: true };
      },
      createEventFromMessage: async (_messageId, fields) => ({ id: fields.id, created: true, samplePreview: true }),
      publish: async (title, body, locale = "en") => {
        const d = desk();
        d.broadcasts.unshift({ id: `demo-bc-${d.broadcasts.length + 1}`, publishedAt: new Date().toISOString(), retracted: false, readCount: 0, title, body, locale });
        d.kpis.broadcasts30d += 1;
        return true;
      },
      retract: async (broadcastId) => {
        const d = desk();
        const item = d.broadcasts.find((b) => b.id === broadcastId);
        if (item) item.retracted = true;
        return true;
      },
      startFormReview: async (formId) => {
        const d = desk();
        const item = (d.formsInbox || []).find((entry) => entry.id === formId);
        if (item) item.status = "in_review";
        return true;
      },
      approveForm: approveDemoForm,
      returnForm: async (formId) => {
        const d = desk();
        d.formsInbox = (d.formsInbox || []).filter((entry) => entry.id !== formId);
        return true;
      },
      approveAndOpenCase: approveDemoForm,
      // The demo caseload exports through the same audited path as the real
      // desk, including the caps, so the demo never shows an unaudited export.
      recordCaseExport: async (caseIds, scope) => {
        const limit = scope === "selection" ? 100 : 500;
        if (caseIds.length > limit) throw new Error(`an export is limited to ${limit} cases`);
        return { exportId: `demo-case-export-${Date.now()}`, scope, rowCount: caseIds.length, limit: 500, selectionLimit: 100 };
      },
      formFilingStatus: async (formId) => {
        const item = (desk().formsInbox || []).find((entry) => entry.id === formId);
        return {
          formId,
          filerSigned: Boolean(item?.filerSignatureDigest),
          filerSignedAt: item?.filerSignedAt || null,
          attachments: item?.files || [],
        };
      },
      // No backend in the demo: a canned success payload in the RPC's shape.
      scan: async () => ({ memberUserId: "demo-member-2", checkedIn: true, alreadyCheckedIn: false }),
      // The member side's "Request a steward now" lands here so the demo's
      // Steward hat shows the request arriving — the toast is only honest if
      // the request actually exists somewhere a visitor can see. Idempotent
      // like a queue a steward actually works: mashing the button must not
      // stack N identical open rows or re-bump the KPI.
      enqueueRequest: ({ memberInitials, memberName, lessonLabel }) => {
        const d = desk();
        const open = d.queue.find((q) => q.status !== "closed" && q.memberName === memberName && q.lessonLabel === lessonLabel);
        if (open) return true;
        d.queue.unshift({ id: `req-demo-${Date.now()}`, memberInitials, memberName, lessonLabel, createdAt: new Date().toISOString(), status: "requested" });
        d.kpis.openRequests = d.queue.filter((q) => q.status !== "closed").length;
        return true;
      },
      // The member side's form submit lands here so the demo Steward hat's
      // review inbox shows the filing arriving. Must go through the cached
      // desk() ref — a row pushed onto a fresh clone would vanish on the next
      // loadDesk — and carries the live loader's row shape (memberApi
      // loadStewardDesk formsInbox).
      enqueueForm: (row) => {
        const d = desk();
        if ((d.formsInbox || []).some((entry) => entry.id === row.id)) return true;
        d.formsInbox = [{ status: "submitted", answers: {}, cosigners: [], ...row }, ...(d.formsInbox || [])];
        return true;
      },
      // Appointments desk twins. Same cached-clone rule as desk(): the panel
      // reloads after every action, so outcomes must land in the served copy.
      loadAppointments: async () => {
        if (!demoApptDeskRef.current) demoApptDeskRef.current = JSON.parse(JSON.stringify(demoData().stewardApptDesk));
        const full = JSON.parse(JSON.stringify(demoApptDeskRef.current));
        // Page one of each list plus cursor and TRUE total, the same payload
        // shape the live loader hands the panel (sol  F9).
        const upcomingPage = pageStewardAppointments(full.upcoming || [], { scope: "upcoming", limit: DEMO_PAGE.appointments });
        const recentPage = pageStewardAppointments(full.recent || [], { scope: "recent", limit: DEMO_PAGE.appointments });
        return {
          ...full,
          upcoming: upcomingPage.rows,
          upcomingCursor: upcomingPage.nextCursor,
          upcomingTotal: upcomingPage.total,
          recent: recentPage.rows,
          recentCursor: recentPage.nextCursor,
          recentTotal: recentPage.total,
        };
      },
      loadAppointmentsPage: async ({ scope = "upcoming", cursor = null, limit } = {}) => {
        if (!demoApptDeskRef.current) demoApptDeskRef.current = JSON.parse(JSON.stringify(demoData().stewardApptDesk));
        const full = JSON.parse(JSON.stringify(demoApptDeskRef.current));
        const rows = scope === "recent" ? full.recent || [] : full.upcoming || [];
        return pageStewardAppointments(rows, { scope, cursor, limit: limit ?? DEMO_PAGE.appointments });
      },
      markOutcome: async (appointmentId, outcome) => {
        const d = demoApptDeskRef.current;
        if (!d) return true;
        const item = (d.upcoming || []).find((row) => row.id === appointmentId);
        if (item) {
          d.upcoming = d.upcoming.filter((row) => row.id !== appointmentId);
          d.recent = [{ ...item, status: outcome }, ...(d.recent || [])];
          if (outcome === "no_show") d.stats.noShows30d += 1;
          if (outcome === "completed") d.stats.completed30d += 1;
        }
        return true;
      },
      cancelAppointment: async (appointmentId) => {
        const d = demoApptDeskRef.current;
        if (!d) return true;
        const item = (d.upcoming || []).find((row) => row.id === appointmentId);
        if (item) {
          d.upcoming = d.upcoming.filter((row) => row.id !== appointmentId);
          d.recent = [{ ...item, status: "cancelled" }, ...(d.recent || [])];
        }
        return true;
      },
      slots: async () => ({ slots: [{ startsAt: "2026-08-13T14:00:00Z" }, { startsAt: "2026-08-13T15:00:00Z" }] }),
      rescheduleAppointment: async (appointmentId, startsAt) => {
        const d = demoApptDeskRef.current;
        const item = (d?.upcoming || []).find((row) => row.id === appointmentId);
        if (item) {
          const duration = item.durationMinutes || 30;
          item.startsAt = startsAt;
          item.endsAt = new Date(new Date(startsAt).getTime() + duration * 60_000).toISOString();
        }
        return true;
      },
      setSchedule: async (fields) => {
        const d = demoApptDeskRef.current;
        if (d) d.schedule = { ...d.schedule, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null)) };
        return true;
      },
      setWindows: async (windows) => {
        const d = demoApptDeskRef.current;
        if (d) d.windows = windows.map((w, index) => ({ id: `demo-win-${index}`, ...w }));
        return true;
      },
      addBlackout: async (startDate, endDate) => {
        const d = demoApptDeskRef.current;
        if (d) d.blackouts = [...(d.blackouts || []), { id: `demo-blk-${Date.now()}`, startDate, endDate }];
        return true;
      },
      removeBlackout: async (blackoutId) => {
        const d = demoApptDeskRef.current;
        if (d) d.blackouts = (d.blackouts || []).filter((row) => row.id !== blackoutId);
        return true;
      },
      requestConnection: async (provider) => {
        const d = demoApptDeskRef.current;
        if (d && !(d.connections || []).some((row) => row.provider === provider)) {
          d.connections = [...(d.connections || []), { id: `demo-conn-${provider}`, provider, status: "pending" }];
        }
        return true;
      },
      loadOAuthStatus: async () => ({
        ok: true,
        providers: { google: { configured: false }, microsoft: { configured: false } },
      }),
      startOAuth: async (provider) => ({ ok: false, error: "activation_unset", provider }),
      removeConnection: async (provider) => {
        const d = demoApptDeskRef.current;
        if (d) d.connections = (d.connections || []).filter((row) => row.provider !== provider);
        return true;
      },
    };
  }, []);

  // Demo booking reads: seeded stewards, synthetic weekday slots computed at
  // call time so the demo calendar is always "next two weeks", never stale
  // fixture dates. Writes go through mutate()'s demoApply twins.
  const demoAppointmentsApi = useMemo(() => ({
    stewards: async () => JSON.parse(JSON.stringify((await loadDemoData()).apptStewards)),
    slots: async ({ duration, stewardId }) => {
      const slots = [];
      const grid = new Date();
      grid.setHours(0, 0, 0, 0);
      for (let day = 1; day <= 13 && slots.length < 60; day += 1) {
        const date = new Date(grid);
        date.setDate(date.getDate() + day);
        const weekday = date.getDay();
        if (weekday === 0 || weekday === 6) continue;
        for (const startMinute of [540, 600, 660, 810, 870]) {
          const startsAt = new Date(date);
          startsAt.setMinutes(startMinute);
          if (startMinute + duration <= 960) {
            slots.push({ startsAt: startsAt.toISOString(), stewardCount: stewardId ? 1 : 2 });
          }
        }
      }
      return { slots };
    },
  }), []);
  const demoChapterAppointmentSupervisionApi = useMemo(() => (
    createDemoChapterAppointmentSupervisionApi(
      demoChapterAppointmentSupervisionRef,
      () => demoData()?.chapterAppointmentSupervision,
    )
  ), []);

  // PERF-UG-DEMO-ROLE-SWITCH-STAFF-DESK-READS-START-LATE-20261124
  //: desk reads started before the desk mounts (see the effect beside
  // selectedStaffHatAuthorized), taken once by the desk of the same visit for
  // the same account, organization and chapter (src/lib/deskPrefetch.js).
  const deskPrefetchRef = useDeskPrefetchStore();
  const deskScope = `${session?.user?.id || ""}:${data?.member?.organizationId || ""}:${data?.member?.chapterId || ""}`;
  const deskScopeRef = useRef("");
  deskScopeRef.current = deskScope;
  const demoCaseworkLangRef = useRef(lang);
  useEffect(() => { demoCaseworkLangRef.current = lang; }, [lang]);
  const coordinatorLangRef = useRef(lang);
  useLayoutEffect(() => { coordinatorLangRef.current = lang; }, [lang]);

  // Locale changes affect loader labels, not the coordinator's data scope.
  // Keep its API identity stable so unsent hub fields and saves survive.
  const coordinatorApi = useMemo(() => ({
    ...chapterAppointmentSupervisionApi,
    ...createGrievancePrivacyApi(sessionDataClient),
    loadCaseworkCase: (caseId) => loadCaseworkCase(supabase, caseId),
    scoreCase: (caseId, inputs) => scoreCaseworkCase(sessionDataClient, caseId, inputs),
    setCaseRestriction: (caseId, restricted, reason) => setCaseworkRestriction(sessionDataClient, caseId, restricted, reason),
    loadAccessCandidates: (caseId) => loadCaseAssignmentCandidates(supabase, caseId),
    grantCaseAccess: (caseId, userId, reason) => grantCaseworkAccess(sessionDataClient, caseId, userId, reason),
    revokeCaseAccess: (grantId) => revokeCaseworkAccess(sessionDataClient, grantId),
    createCaseDeadline: (scope, fields) => createCaseworkDeadline(sessionDataClient, scope, fields),
    renameCase: (caseId, title, reason) => renameCaseworkCase(sessionDataClient, caseId, title, reason),
    requestDeadlineExtension: (deadlineId, dueAt, reason) => requestCaseworkDeadlineExtension(sessionDataClient, deadlineId, dueAt, reason),
    decideDeadlineExtension: (extensionId, decision, note) => decideCaseworkDeadlineExtension(sessionDataClient, extensionId, decision, note),
    setDeadlineStatus: (deadlineId, status) => setCaseworkDeadlineStatus(sessionDataClient, deadlineId, status),
    createCaseAlert: (scope, fields) => createCaseworkAlert(sessionDataClient, scope, fields),
    acknowledgeCaseAlert: (alertId, note) => acknowledgeCaseworkAlert(sessionDataClient, alertId, note),
    acknowledgeAlert: (alertId, note) => acknowledgeCaseworkAlert(sessionDataClient, alertId, note),
    createCaseReminder: (scope, fields) => createCaseworkReminder(sessionDataClient, scope, fields),
    logManagementBehavior: (caseId, fields) => logCaseworkManagementBehavior(sessionDataClient, caseId, fields),
    loadManagementWindow: (personIds, days) => loadCaseworkManagementWindow(supabase, personIds, days),
    addManagementAddendum: (entryId, body) => addCaseworkManagementAddendum(sessionDataClient, entryId, body),
    linkCases: (sourceCaseId, targetCaseId, relationship, note) => linkCaseworkCases(sessionDataClient, sourceCaseId, targetCaseId, relationship, note),
    setReminderStatus: (reminderId, action, remindAt) => setCaseworkReminderStatus(sessionDataClient, reminderId, action, remindAt),
    listOpenCaseDeadlines: (caseIds) => listOpenCaseworkDeadlines(supabase, caseIds),
    loadCaseworkHub: (chapterId) => loadCaseworkHub(supabase, chapterId),
    createBargainingWorkspace: (chapterId, title, startsAt) => createCaseworkBargainingWorkspace(sessionDataClient, chapterId, title, startsAt),
    addBargainingProposal: (workspaceId, fields) => addCaseworkBargainingProposal(sessionDataClient, workspaceId, fields),
    transitionBargainingProposal: (proposalId, expectedStatus, nextStatus, responseDueAt) => transitionCaseworkBargainingProposal(sessionDataClient, proposalId, expectedStatus, nextStatus, responseDueAt),
    addBargainingEvent: (workspaceId, eventType, body, pulse) => addCaseworkBargainingEvent(sessionDataClient, workspaceId, eventType, body, pulse),
    setBargainingStatus: (workspaceId, expectedStatus, nextStatus) => setCaseworkBargainingStatus(sessionDataClient, workspaceId, expectedStatus, nextStatus),
    saveIntakeDraft: (fields) => saveCaseworkIntakeDraft(sessionDataClient, fields),
    scanRetaliationPatterns: (chapterId) => scanCaseworkRetaliationPatterns(sessionDataClient, chapterId),
    reviewRetaliationPattern: (patternId, status, disposition, note) => reviewCaseworkRetaliationPattern(sessionDataClient, patternId, status, disposition, note),
    bulkUpdateCases: (caseIds, expectedStatus, fields) => bulkUpdateCaseworkCases(sessionDataClient, caseIds, expectedStatus, fields),
    loadDesk: (...options) => deskPrefetchRef.current.take(`coordinator:${options[0]?.kpisOnly ? "kpis" : "full"}:${deskScopeRef.current}:${coordinatorLangRef.current}`,
      () => loadCoordinatorDesk(supabase, coordinatorLangRef.current, ...options)),
    loadCases: (opts) => loadCoordinatorCases(supabase, opts, coordinatorLangRef.current),
    listSavedViews: (plane) => listMemberSavedViews(supabase, plane),
    saveSavedView: (view) => saveMemberSavedView(sessionDataClient, view),
    deleteSavedView: (id) => deleteMemberSavedView(sessionDataClient, id),
    loadAssignmentCandidates: (caseId) => loadCaseAssignmentCandidates(supabase, caseId),
    assignCase: (caseId, assignment) => assignMemberCase(sessionDataClient, caseId, assignment),
    updateCase: (caseId, fields) => coordinatorUpdateCase(sessionDataClient, caseId, fields),
    addCaseNote: (caseId, body) => coordinatorAddCaseNote(sessionDataClient, caseId, body),
    // The mention-aware note RPC is a sibling of the plain one, not a
    // replacement: CaseBulkActions adds the same note to many cases at once
    // and has no mention audience to resolve.
    addCaseNoteWithMentions: (caseId, body, mentionIds) => addCaseworkCaseNote(sessionDataClient, caseId, body, mentionIds),
    loadMentionCandidates: (caseId) => listCaseNoteMentionCandidates(supabase, caseId),
    listMacros: () => listCaseworkMacros(supabase),
    saveMacro: (macro) => saveCaseworkMacro(sessionDataClient, macro),
    // The macro editor's assignee pickers: organization-scoped, because a
    // macro is organization property and has no case to scope a read with.
    loadStaffCandidates: () => loadStaffCandidates(supabase),
    applyMacro: (macroId, caseIds, idempotencyKey) => applyCaseworkMacro(sessionDataClient, macroId, caseIds, idempotencyKey),
    recordCaseExport: (caseIds, scope, filterKeys) => recordCaseworkCaseExport(sessionDataClient, caseIds, scope, filterKeys),
    logCaseContact: (caseId, fields) => coordinatorLogCaseContact(sessionDataClient, caseId, fields),
    recordCaseOutcome: (caseId, fields) => coordinatorRecordCaseOutcome(sessionDataClient, caseId, fields),
    addCaseFile: (caseId, file, options) => addMemberCaseFile(sessionDataClient, caseId, file, options),
    removeCaseFile: (file) => removeMemberCaseFile(sessionDataClient, file),
    // Bytes, not a URL: the view mints (and revokes) its own object URL, and
    // the same blob is what a packet export reads.
    openCaseFile: (file) => memberCaseFileBlob(sessionDataClient, file),
    recheckCaseFile: (file) => recheckPrivateFile(sessionDataClient, "case", file.id),
    loadCaseHistory: (caseId, options) => loadCaseHistory(supabase, caseId, options),
    loadCaseStewardEmails: (caseId) => loadCaseStewardEmails(supabase, caseId),
    recordAccess: (actor, record) => accessHistoryRpcApi.record(actor, record),
    loadCaseDashboards: () => loadCaseDashboards(supabase),
  }), [accessHistoryRpcApi, chapterAppointmentSupervisionApi, deskPrefetchRef, sessionDataClient]);
  const demoCoordinatorApi = useMemo(() => {
    let desk = null;
    const current = async () => {
      if (!desk) desk = JSON.parse(JSON.stringify((await loadDemoData()).coordinatorDesk));
      return desk;
    };
    const findCase = async (caseId) => (await current()).cases.find((item) => item.id === caseId);
    return {
      ...demoChapterAppointmentSupervisionApi,
      ...createDemoCaseworkApi(current, { lang: () => demoCaseworkLangRef.current }),
      loadDesk: async () => JSON.parse(JSON.stringify(await current())),
      // Demo drilldowns mirror the server focus predicates over the seeded desk.
      loadCases: async ({ focus = "all" } = {}) => ({ cases: filterCoordinatorFocus(JSON.parse(JSON.stringify((await current()).cases)), focus), nextCursor: null }),
      loadAssignmentCandidates: async () => JSON.parse(JSON.stringify((await loadDemoData()).vpOverview.roster.filter((person) => person.roles.some((role) => role === "steward" || role === "coordinator")))),
      // Demo mirror of the live path: a role the coordinator never named
      // travels as the leave-unchanged sentinel and the case keeps whoever
      // currently holds it; only an explicit null clears (same contract as
      // assign_member_case, BUG-UG-CASE-BULK-ASSIGN-CLEARS-UNTOUCHED-ROLE).
      assignCase: async (caseId, { stewardId, coordinatorId }) => {
        const item = await findCase(caseId);
        if (!item) throw new Error("Case not found");
        const leaveSteward = stewardId === ASSIGN_LEAVE_UNCHANGED;
        const leaveCoordinator = coordinatorId === ASSIGN_LEAVE_UNCHANGED;
        const roster = (await loadDemoData()).vpOverview.roster;
        const steward = leaveSteward ? null : roster.find((person) => person.userId === stewardId);
        const coordinator = leaveCoordinator ? null : roster.find((person) => person.userId === coordinatorId);
        const next = {};
        if (!leaveSteward) Object.assign(next, {
          stewardUserId: steward?.userId || "",
          stewardName: steward?.fullName || "",
        });
        if (!leaveCoordinator) Object.assign(next, {
          coordinatorUserId: coordinator?.userId || "",
          coordinatorName: coordinator?.fullName || "",
        });
        if (!leaveSteward || !leaveCoordinator) {
          const stewardKept = leaveSteward ? item.stewardUserId : (steward?.userId || "");
          const coordinatorKept = leaveCoordinator ? item.coordinatorUserId : (coordinator?.userId || "");
          next.assignedAt = stewardKept || coordinatorKept ? new Date().toISOString() : "";
        }
        Object.assign(item, next);
        return item;
      },
      addCaseNote: async (caseId, body) => {
        const item = await findCase(caseId); const now = new Date().toISOString();
        const row = { id: `demo-case-note-${Date.now()}`, body, createdAt: now, createdAtValue: now, mentions: [] };
        item.updates = [...(item.updates || []), row]; item.totalUpdates = item.updates.length; return row;
      },
      // The demo plane has no server, so mentions resolve against the same
      // seeded roster the assignment picker uses and the note keeps them.
      loadMentionCandidates: async () => JSON.parse(JSON.stringify((await loadDemoData()).vpOverview.roster.filter((person) => person.roles.some((role) => role === "steward" || role === "coordinator")))),
      addCaseNoteWithMentions: async (caseId, body, mentionIds = []) => {
        const item = await findCase(caseId); const now = new Date().toISOString();
        const roster = (await loadDemoData()).vpOverview.roster;
        const mentions = (mentionIds || [])
          .map((userId) => roster.find((person) => person.userId === userId))
          .filter(Boolean)
          .map((person) => ({ userId: person.userId, fullName: person.fullName }));
        const row = { id: `demo-case-note-${Date.now()}`, body, createdAt: now, createdAtValue: now, mentions };
        item.updates = [...(item.updates || []), row]; item.totalUpdates = item.updates.length; return row;
      },
      bulkUpdateCases: async (caseIds, expectedStatus, fields) => {
        const cases = (await current()).cases.filter((row) => caseIds.includes(row.id));
        for (const row of cases) Object.assign(row, fields.status ? { status: fields.status } : {});
        return { updated: cases.length, expectedStatus };
      },
      listMacros: async () => [],
      saveMacro: async (macro) => ({ ...macro, id: `demo-macro-${Date.now()}` }),
      loadStaffCandidates: async () => JSON.parse(JSON.stringify((await loadDemoData()).vpOverview.roster)),
      applyMacro: async (macroId, caseIds) => ({ macroId, caseCount: caseIds.length, actionsApplied: 0, actionsSkipped: 0 }),
      // The demo desk keeps the same shape, including the caps, so a demo
      // export refuses exactly where the real one does.
      recordCaseExport: async (caseIds, scope) => {
        const limit = scope === "selection" ? 100 : 500;
        if (caseIds.length > limit) throw new Error(`an export is limited to ${limit} cases`);
        return { exportId: `demo-case-export-${Date.now()}`, scope, rowCount: caseIds.length, limit: 500, selectionLimit: 100 };
      },
      logCaseContact: async (caseId, fields) => {
        const item = await findCase(caseId);
        const row = { id: `demo-case-contact-${Date.now()}`, ...fields, contactedAtValue: fields.contactedAt, contactedAt: fields.contactedAt };
        item.contacts = [row, ...(item.contacts || [])]; return row;
      },
      recordCaseOutcome: async (caseId, fields) => {
        const item = await findCase(caseId); const now = new Date().toISOString();
        item.status = "resolved"; item.outcome = { kind: fields.outcome, summary: fields.summary, recordedAt: now, recordedAtValue: now, updatedAtValue: now }; return item.outcome;
      },
    };
  }, [demoChapterAppointmentSupervisionApi]);
  const demoVpApi = useMemo(() => {
    const reviews = [];
    return {
      loadDesk: async () => ({ ...JSON.parse(JSON.stringify((await loadDemoData()).vpOverview)), reviews: [...reviews] }),
      markReviewed: async (caseId) => {
        const existing = reviews.find((item) => item.caseId === caseId);
        if (existing) return existing;
        const review = { caseId, reviewedAt: new Date().toISOString(), reviewerName: "Taylor Morgan" };
        reviews.push(review);
        return review;
      },
    };
  }, []);
  const demoAdvisorApi = useMemo(() => ({
    ...demoChapterAppointmentSupervisionApi,
    loadDesk: async () => JSON.parse(JSON.stringify((await loadDemoData()).advisorDesk)),
  }), [demoChapterAppointmentSupervisionApi]);
  const campaignApi = useMemo(() => ({
    load: () => loadCampaigns(supabase),
    saveDraft: (fields) => saveCampaignDraft(sessionDataClient, fields),
    publish: (kind, id) => publishCampaign(sessionDataClient, kind, id),
    close: (kind, id) => closeCampaign(sessionDataClient, kind, id),
    delete: (kind, id) => deleteCampaignDraft(sessionDataClient, kind, id),
    // REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030.
    nominationsClient: sessionDataClient,
    removalDetails: (ballotIds) => loadOfficerRemovalDetails(supabase, ballotIds),
    removalTargets: (scope) => listOfficerRemovalTargets(supabase, scope),
    saveRemovalDraft: (fields) => saveOfficerRemovalDraft(sessionDataClient, fields),
    recordRemovalOutcome: (id, outcome) => recordOfficerRemovalOutcome(sessionDataClient, id, outcome),
  }), [sessionDataClient]);
  // REQ-UG-CHAPTER-LEADERSHIP-RECOVERY-20261001: the member's claim card on
  // My chapter. Every decision is the server's.
  const leadershipApi = useMemo(() => ({
    load: () => loadChapterLeadershipRecovery(supabase),
    claim: (chapterId) => claimChapterLeadership(sessionDataClient, chapterId),
    withdraw: (claimId) => withdrawChapterLeadershipClaim(sessionDataClient, claimId),
  }), [sessionDataClient]);
  const demoCampaignApi = useMemo(() => createDemoCampaignApi(), []);

  // Event creation is bound by the server to the selected chapter. Hold a
  // local chapter switch until every already-submitted create has settled,
  // and refuse new creates once that switch has retired the current tools.
  const createChapterEvent = useCallback((fields) => fencedChapterWrite(chapterTransitionRef, pendingEventCreatesRef, () => createAdminEvent(sessionDataClient, fields)), [sessionDataClient]);
  // A staff-only draft is filed under the chapter selected when its save
  // executes, so it takes the same fence as a create.
  const saveChapterEventDraft = useCallback((draftId, fields) => fencedChapterWrite(chapterTransitionRef, pendingEventCreatesRef, () => saveAdminEventDraft(sessionDataClient, draftId, fields)), [sessionDataClient]);
  // A notice's chapter audience is also the selected chapter at execution
  // time (REQ-UG-OFFICER-NOTICES-WITH-READ-RECEIPTS-20261030), so it
  // takes the same fence: refused during a switch, and waited for by one.
  const noticeCanPostOrganization = ["admin", "vp"].includes(selectedStaffHat)
    && (data?.member?.organizationRoles || []).includes(selectedStaffHat);
  const noticeApi = useMemo(() => {
    const role = selectedStaffHat;
    const chapterId = data?.member?.chapterId;
    const actorId = session?.user?.id;
    const context = () => {
      const operation = guardRef.current.captureOperation();
      return {
        role, chapterId, canPostOrganization: noticeCanPostOrganization,
        isCurrent: () => operation.isCurrent() && sessionRef.current?.user?.id === actorId
          && selectedStaffHatRef.current === role && dataRef.current?.member?.chapterId === chapterId,
      };
    };
    return {
      ...noticeReadApi,
      loadAudiences: () => loadNoticeAudiences(supabase, context()),
      // operationKey: the composer's draft key .
      publish: async (title, body, locale, audienceScope, operationKey) => {
        const publishing = context();
        const result = await fencedChapterWrite(chapterTransitionRef, pendingEventCreatesRef, () => publishNoticeForAudience(sessionDataClient, title, body, locale, audienceScope, publishing, operationKey));
        if (publishing.isCurrent()) refreshRef.current(sessionRef.current, memberMutationResources("publishMemberBroadcast")).catch(() => {});
        return result;
      },
    };
  }, [selectedStaffHat, data?.member?.chapterId, session?.user?.id, noticeCanPostOrganization, noticeReadApi, sessionDataClient]);
  const scopedStewardApi = useMemo(() => ({ ...stewardApi, publish: noticeApi.publish }), [noticeApi, stewardApi]);

  // REQ-UG-INVITATION-SUGGESTIONS-AND-ACCESS-REQUESTS-20261030: a
  // member's suggestions and role requests, and the deciders' Approve and
  // Decline. An approved suggestion goes through the existing invitation
  // route under the decider's own session, which approves it and creates the
  // invitation in one server transaction.
  const memberRequestsApi = useMemo(() => ({
    submit: (fields) => submitMemberRequest(sessionDataClient, fields),
    listMine: (before) => listMyMemberRequests(supabase, before),
    listToDecide: (status, before) => listMemberRequests(supabase, status, before),
    decide: (requestId, decision, unitId) => decideMemberRequest(sessionDataClient, requestId, decision, unitId),
    invite: (fields) => sendMemberInvitation(sessionRef.current, fields),
    listChapterUnits: listChapterUnits.bind(null, supabase),
  }), [sessionDataClient]);

  // Admin loader localizes audit/event date labels, so its api tracks the
  // language like the coordinator's.
  // A chapter President's own-chapter invitation desk on the President plane
  // (BUG-UG-CHAPTER-PRESIDENT-CANNOT-INVITE-20261003). The fixture
  // demo and SAMPLE have no invitation sending, as on the admin desk. SAMPLE
  // still reads the chapter's invitations and says the demo does not send
  // them, as Admin does, instead of a page with only its heading
  // (BUG-UG-DEMO-PRESIDENT-INVITE-PAGE-BLANK-20261124). The fixture
  // tour shows the same: the fixture chapter's plain-member invitations.
  const presidentInvitationApi = useMemo(() => (fixtureDemo ? {
    load: async () => {
      const invitations = demoData()?.adminDesk?.invitations ?? {};
      return {
        chapter: invitations.chapter ?? null,
        chapters: invitations.chapter ? [invitations.chapter] : [],
        items: (invitations.items ?? []).filter((item) => !item.initialRole),
      };
    },
    sendingUnavailable: true,
  } : sampleLive ? {
    load: () => loadMemberInvitations(supabase, lang),
    sendingUnavailable: true,
  } : {
    load: () => loadMemberInvitations(supabase, lang),
    inviteMember: (fields) => sendMemberInvitation(sessionRef.current, fields),
    resendInvitation: (invitationId) => resendMemberInvitation(sessionRef.current, invitationId),
    revokeInvitation: (invitationId) => revokeMemberInvitation(sessionRef.current, invitationId),
  }), [fixtureDemo, sampleLive, lang]);
  // Retire chapter tools before the server changes scope, not after the
  // profile refresh finally paints. An ambiguous/failed refresh stays fenced
  // until an explicit retry reads and commits the authenticated scope.
  // The committed scope, not the refresh's own outcome, lifts the fence: an
  // optional read (MFA standing, chapter tasks) can fail after the profile
  // committed, and that section degrades on its own. A required read failure
  // never commits, so it stays fenced.
  const refreshChapterScope = useCallback(async () => {
    const transition = chapterTransitionRef.current;
    if (!transition?.operation.isCurrent()) return;
    transition.status = "loading";
    setChapterTransition({ ...transition, status: "loading" });
    try {
      const previous = dataRef.current;
      let refreshFailure = null;
      await transition.operation.wait(refreshRef.current(transition.session, null, { resetScope: true })
        .catch(error => { refreshFailure = error; }));
      if (chapterTransitionRef.current !== transition) return;
      const member = dataRef.current?.member;
      if (dataRef.current === previous || member?.id !== transition.session.user.id
          || !member?.chapterId || (transition.chapterId && member.chapterId !== transition.chapterId)) {
        throw refreshFailure ?? new Error("Chapter refresh did not commit the selected scope");
      }
      chapterTransitionRef.current = null;
      setChapterTransition(null);
    } catch (error) {
      if (chapterTransitionRef.current === transition && transition.operation.isCurrent()) {
        transition.status = "error";
        setChapterTransition({ ...transition });
      }
      throw error;
    }
  }, []);
  const switchChapterScope = useCallback(async (chapterId) => {
    const previous = chapterTransitionRef.current;
    if (previous?.operation.isCurrent() && previous.status === "loading") throw new Error("Chapter switch in progress");
    const activeSession = sessionRef.current;
    const operation = guardRef.current.captureOperation(activeSession?.user?.id);
    const transition = { session: activeSession, operation, status: "loading", chapterId: null };
    chapterTransitionRef.current = transition;
    setChapterTransition({ ...transition });
    try {
      await operation.wait(Promise.allSettled([...pendingEventCreatesRef.current]));
      const result = await operation.wait(switchMyChapter(sessionDataClient, chapterId));
      // This is the server's result, never a URL or client-picked identity.
      transition.chapterId = result.chapterId;
      return result;
    } catch (error) {
      if (chapterTransitionRef.current === transition && operation.isCurrent()) {
        // These are explicit transaction refusals: the server did not switch.
        // A lost response may follow a committed switch, so it must remain
        // fenced until an authenticated profile read resolves the uncertainty.
        if (["42501", "22023"].includes(error.code) && error.status !== 401) {
          chapterTransitionRef.current = null;
          setChapterTransition(null);
          setNotice(tr("chapterRail.switchRefused"));
        } else {
          transition.status = "error";
          setChapterTransition({ ...transition });
        }
      }
      throw error;
    }
  }, [setNotice, tr, sessionDataClient]);
  const adminApi = useMemo(() => ({
    ...chapterAppointmentSupervisionApi,
    loadDesk: () => loadAdminDesk(supabase, lang),
    // REQ-UG-CHAPTER-UNITS-WORKSITES-AND-LOCAL-PROFILE-20261030.
    listChapterUnits: () => listChapterUnits(supabase),
    saveChapterUnit: (fields) => saveChapterUnit(sessionDataClient, fields),
    deleteChapterUnit: (unitId) => deleteChapterUnit(sessionDataClient, unitId),
    loadLocalProfile: () => loadLocalProfile(supabase),
    saveLocalProfile: (fields) => saveLocalProfile(sessionDataClient, fields),
    loadEvents: () => loadAdminEvents(supabase, lang),
    // Every role and membership write below can change a chapter's stewards,
    // so each announces a chapter setup change once it has succeeded and the
    // staff guide's units step reads its facts again .
    grantRole: announceChapterSetupAfter((userId, role, chapterId) => grantMemberRole(sessionDataClient, userId, role, chapterId)),
    revokeRole: announceChapterSetupAfter((userId, role) => revokeMemberRole(sessionDataClient, userId, role)),
    listLeadershipClaims: () => listChapterLeadershipClaims(supabase),
    rejectLeadershipClaim: (claimId, note) => rejectChapterLeadershipClaim(sessionDataClient, claimId, note),
    searchMembers: (query) => adminSearchMembers(sessionDataClient, query),
    loadMemberDirectory: (query, after) => loadAdminMemberDirectory(supabase, { query, after, limit: 25 }),
    // Read lazily by the admin's own two-step row
    // (BUG-UG-SOLE-ADMIN-TWO-STEP-RESET-DEAD-END-20261103). Whether
    // recovery codes are on is read live from the current data at render, so
    // AdminView reads no extra boot data and follows a toggle.
    loadMfaRecoveryStatus: () => loadMfaRecoveryCodeStatus(supabase),
    recoveryCodeEnrollmentEnabled: () => dataRef.current?.organizationConfiguration?.recoveryCodeEnrollmentEnabled !== false,
    exportMemberDirectory: (context, locale) => exportMemberDirectoryCsv(sessionDataClient, context, locale),
    createChapter: (fields) => createAdminChapter(sessionDataClient, fields),
    updateChapter: (chapterId, fields) => updateAdminChapter(sessionDataClient, chapterId, fields),
    searchUnionOrganizations: (query) => searchUnionOrganizations(supabase, query),
    importOrganizationStructure: (hat, payload, dryRun) => importOrganizationStructure(sessionDataClient, hat, payload, dryRun),
    getOrganizationCatalogPlacement: (organizationId) => getOrganizationCatalogPlacement(supabase, organizationId),
    setOrganizationCatalogPlacement: (organizationId, fields, idempotencyKey) => setOrganizationCatalogPlacement(sessionDataClient, organizationId, fields, idempotencyKey),
    clearOrganizationCatalogPlacement: (organizationId, idempotencyKey) => clearOrganizationCatalogPlacement(sessionDataClient, organizationId, idempotencyKey),
    // Lane uc-3a-web: organization verification. The two POSTs read the
    // session at call time so a refreshed token is the one sent.
    requestIntakeReview: (action, payload) => requestIntakeReview({ fetchImpl: fetch, accessToken: sessionRef.current?.access_token, action, payload }),
    requestTopicSend: (action, payload) => requestTopicSend({ fetchImpl: fetch, accessToken: sessionRef.current?.access_token, action, payload }),
    requestChapterBinding: (unionOrgId) => requestChapterUnionOrgBinding(sessionDataClient, unionOrgId),
    requestConnectionSetup: (capability, providerLabel) => requestChapterConnectionSetup(sessionDataClient, capability, providerLabel),
    verifyConnectionSetup: (fields) => verifyChapterConnectionSetup(sessionRef.current, fields),
    shareHandshakeDocument: (handshakeId, documentId, idempotencyKey) => shareChapterHandshakeDocument(sessionDataClient, handshakeId, documentId, idempotencyKey),
    // Chapter selection changes the scope of argument-free RPCs too. Retire
    // every old snapshot before projecting the newly authorized chapter.
    switchMyChapter: async (chapterId) => {
      const result = await switchChapterScope(chapterId);
      await refreshChapterScope();
      return result;
    },
    grantChapterMembership: announceChapterSetupAfter((userId, chapterId) => grantMemberChapterMembership(sessionDataClient, userId, chapterId)),
    revokeChapterMembership: announceChapterSetupAfter((userId, chapterId) => revokeMemberChapterMembership(sessionDataClient, userId, chapterId)),
    setChapterRole: announceChapterSetupAfter((userId, chapterId, role, enabled) => setMemberChapterRole(sessionDataClient, userId, chapterId, role, enabled)),
    loadMemberChapterMemberships: (userId) => loadMemberChapterMemberships(supabase, userId),
    searchRecoveryMembers: (query) => adminSearchRecoveryMembers(sessionDataClient, query),
    createEvent: createChapterEvent,
    updateEvent: (eventId, fields) => updateAdminEvent(sessionDataClient, eventId, fields),
    setEventAgenda: (eventId, agenda, expectedVersion) => setAdminEventAgenda(sessionDataClient, eventId, agenda, expectedVersion),
    setEventRsvpOpen: (eventId, open, expectedVersion) => setAdminEventRsvpOpen(sessionDataClient, eventId, open, expectedVersion),
    listEventDrafts: () => listAdminEventDrafts(supabase),
    saveEventDraft: saveChapterEventDraft,
    deleteEventDraft: (draftId) => deleteAdminEventDraft(sessionDataClient, draftId),
    cancelEvent: (eventId, reason) => cancelAdminEvent(sessionDataClient, eventId, reason),
    setEventQuorum: (eventId, quorum) => setMemberEventQuorum(sessionDataClient, eventId, quorum),
    loadEventQuorum,
    restoreEvent: (eventId) => restoreAdminEvent(sessionDataClient, eventId),
    deleteEvent: (eventId) => deleteAdminEvent(sessionDataClient, eventId),
    loadAdministrativeEvidence: (page = 0) => loadAdministrativeEvidence(supabase, page),
    addFieldNoteEvidence: (fields) => addFieldNoteEvidence(sessionDataClient, fields),
    draftFieldNotePacket: (issueKey, title) => draftFieldNotePacket(sessionDataClient, issueKey, title),
    executeAdministrativeObjectAction: (fields) => executeAdministrativeObjectAction(sessionDataClient, fields),
    // Reads `session` at call time rather than closing over it, so a token
    // refresh between render and click does not send a stale bearer.
    resetMfa: (userId) => resetMemberMfa(sessionRef.current, userId),
    listLegalHolds: () => listOrganizationLegalHolds(supabase),
    loadHoldConversations: (options) => listLegalHoldConversations(supabase, options),
    loadLegalHold: (conversationId) => loadConversationLegalHold(supabase, conversationId),
    placeLegalHold: (conversationId, reasonCode) => placeConversationLegalHold(sessionDataClient, conversationId, reasonCode),
    releaseLegalHold: (conversationId) => releaseConversationLegalHold(sessionDataClient, conversationId),
    setStaffMfaPolicy: (required) => setStaffMfaPolicy(sessionDataClient, required),
    setMemberMfaPolicy: (required) => setMemberMfaPolicy(sessionDataClient, required),
    setCompassAiEnabled: (enabled) => setCompassAiEnabled(sessionDataClient, enabled),
    setCompassAiRoleLimit: (role, hourlyLimit) => setCompassAiRoleLimit(sessionDataClient, role, hourlyLimit),
    attestCompassAiProvider: (fields) => attestCompassAiProvider(sessionDataClient, fields),
    saveRetentionPolicy: (fields) => saveOrganizationRetentionPolicy(sessionDataClient, fields),
    previewRetentionRun: (dataClass) => previewOrganizationRetentionRun(supabase, dataClass),
    authorizeRetentionRun: (runId, confirmation) => authorizeOrganizationRetentionRun(sessionDataClient, runId, confirmation),
    executeRetentionRun: (runId) => executeOrganizationRetentionRun(sessionDataClient, runId),
    closeGovernance: (requestId, status, response) => closeAdminGovernanceRequest(sessionDataClient, requestId, status, response),
    loadFormTemplates: () => loadAdminFormTemplates(supabase),
    upsertFormTemplate: (fields) => upsertFormTemplate(sessionDataClient, fields),
    deactivateFormTemplate: (key) => deactivateFormTemplate(sessionDataClient, key),
    reactivateFormTemplate: (key) => reactivateFormTemplate(sessionDataClient, key),
    ...(organizationFormDocumentsApi || {}),
    loadInvitations: () => loadMemberInvitations(supabase, lang, { limit: 100 }),
    inviteMember: (fields) => sendMemberInvitation(sessionRef.current, fields),
    resendInvitation: (invitationId) => resendMemberInvitation(sessionRef.current, invitationId),
    revokeInvitation: (invitationId) => revokeMemberInvitation(sessionRef.current, invitationId),
    setMemberDisplayTitle: (userId, chapterId, title) => setMemberChapterDisplayTitle(sessionDataClient, userId, chapterId, title),
    recoverSigninAddress: (fields) => recoverMemberSigninAddress(sessionRef.current, fields),
    reissuePassword: (fields) => reissueMemberPassword(sessionRef.current, fields),
    updateOrganizationSetting: async (key, value) => {
      const operation = guardRef.current.captureOperation();
      const result = await updateOrganizationSetting(sessionDataClient, key, value);
      if (!operation.isCurrent()) return;
      setData((current) => current ? ({
        ...current,
        organizationConfiguration: organizationConfigurationWithSetting(current.organizationConfiguration, key, result?.value ?? value),
      }) : current);
      return result;
    },
    // Feature switches & limits page: version-checked save and reset. The
    // session's member-safe switches follow the saved value generically.
    setOrganizationSetting: async (key, value, expectedUpdatedAt) => {
      const operation = guardRef.current.captureOperation();
      const result = await setOrganizationSetting(sessionDataClient, key, value, expectedUpdatedAt);
      if (!operation.isCurrent()) return;
      setData((current) => current ? ({
        ...current,
        organizationConfiguration: organizationConfigurationWithSetting(current.organizationConfiguration, key, result?.value ?? value),
      }) : current);
      return result;
    },
    resetOrganizationSetting: async (key, expectedUpdatedAt) => {
      const operation = guardRef.current.captureOperation();
      const result = await resetOrganizationSetting(sessionDataClient, key, expectedUpdatedAt);
      if (!operation.isCurrent()) return;
      setData((current) => current ? ({
        ...current,
        organizationConfiguration: organizationConfigurationWithSetting(current.organizationConfiguration, key, result?.value),
      }) : current);
      return result;
    },
    loadConfigurationAudit: (key, limit) => loadOrganizationConfigurationAudit(supabase, key, limit),
    ...liveOrganizationLabelApi({ save: updateOrganizationLabel.bind(null, sessionDataClient), guardRef, loaderRef: memberLoaderRef, setData }),
    // REQ-UG-WORKLOAD-CATEGORY-LABELS-VISIBILITY-ORDER-20261103: the
    // admin's own Workload log follows the saved order and visibility.
    ...liveWorkloadCategoriesApi({ load: loadOrganizationWorkloadCategories.bind(null, supabase), save: saveOrganizationWorkloadCategories.bind(null, sessionDataClient), guardRef, loaderRef: memberLoaderRef, setData }),
    ...liveWorkloadConfigurationApi({ load: loadOrganizationWorkloadConfiguration.bind(null, supabase), save: saveOrganizationWorkloadConfiguration.bind(null, sessionDataClient), guardRef, loaderRef: memberLoaderRef, setData }),
    loadFailedLoginInbox: (status) => loadFailedLoginInbox(supabase, status),
    dispositionFailedLoginAttempt: (attemptId, status, note) => dispositionFailedLoginAttempt(sessionDataClient, attemptId, status, note),
  }), [lang, refreshChapterScope, switchChapterScope, createChapterEvent, saveChapterEventDraft, chapterAppointmentSupervisionApi, loadEventQuorum, organizationFormDocumentsApi, sessionDataClient]);

  // UB-EVT-06: the same six verbs the admin plane has, minus every RPC a
  // non-admin hat cannot call. loadDesk is the narrow reader, so a steward
  // opening this tool never touches get_staff_roster / get_admin_audit.
  const eventsDeskApi = useMemo(() => ({
    loadDesk: () => loadEventsDesk(supabase, lang),
    createEvent: createChapterEvent,
    updateEvent: (eventId, fields) => updateAdminEvent(sessionDataClient, eventId, fields),
    setEventAgenda: (eventId, agenda, expectedVersion) => setAdminEventAgenda(sessionDataClient, eventId, agenda, expectedVersion),
    setEventRsvpOpen: (eventId, open, expectedVersion) => setAdminEventRsvpOpen(sessionDataClient, eventId, open, expectedVersion),
    listEventDrafts: () => listAdminEventDrafts(supabase),
    saveEventDraft: saveChapterEventDraft,
    deleteEventDraft: (draftId) => deleteAdminEventDraft(sessionDataClient, draftId),
    cancelEvent: (eventId, reason) => cancelAdminEvent(sessionDataClient, eventId, reason),
    setEventQuorum: (eventId, quorum) => setMemberEventQuorum(sessionDataClient, eventId, quorum),
    loadEventQuorum,
    restoreEvent: (eventId) => restoreAdminEvent(sessionDataClient, eventId),
    deleteEvent: (eventId) => deleteAdminEvent(sessionDataClient, eventId),
  }), [lang, createChapterEvent, saveChapterEventDraft, loadEventQuorum, sessionDataClient]);

  // A fully client-side admin desk for the demo (the steward-demo pattern):
  // grants/revokes/events mutate an in-memory clone so the flow feels real
  // and touches no backend.
  const demoAdminRef = useRef(null);
  const demoAdminApi = useMemo(() => {
    let auditSeq = 0;
    let invitationSeq = 0;
    const nowLabel = () => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date());
    // A rendered time is the member's clock, never the
    // host's. nowLabel above prints no time and stays registered with the
    // other host-locale date stamps in .lane/FINDINGS.md.
    const momentLabel = (date) => dateTimeFormat(lang, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
    const countOpenFailedLoginsLast24Hours = (items = []) => {
      const cutoff = Date.now() - (24 * 60 * 60 * 1000);
      return items.filter((item) => item.status === "open" && Date.parse(item.occurredAt) >= cutoff).length;
    };
    const desk = () => {
      if (!demoAdminRef.current) {
        demoAdminRef.current = JSON.parse(JSON.stringify(demoData().adminDesk));
        demoAdminRef.current.formTemplates = cloneDemoFormTemplates(demoData().adminDesk.formTemplates);
        // Each event carries a version, as get_admin_events returns, so the
        // agenda form (which refuses to save without one) works in the demo.
        for (const item of demoAdminRef.current.events || []) item.version ??= 1;
      }
      if (demoAdminRef.current.failedLoginInbox) {
        demoAdminRef.current.failedLoginInbox.openLast24Hours = countOpenFailedLoginsLast24Hours(
          demoAdminRef.current.failedLoginInbox.items,
        );
        const alertThreshold = demoAdminRef.current.configuration?.settings
          ?.find((item) => item.key === "security.failed_login_alert_threshold")?.value;
        if (Number.isSafeInteger(alertThreshold)) {
          demoAdminRef.current.failedLoginInbox.attentionThreshold = alertThreshold;
        }
      }
      return demoAdminRef.current;
    };
    const record = (d, action, targetName, detail) => {
      auditSeq += 1;
      d.audit.unshift({ id: `demo-audit-live-${auditSeq}`, action, actorName: "Alex Rivera", targetName, detail, createdLabel: nowLabel() });
    };
    const writeDemoSetting = (key, value, { reset = false, checkVersion = false, expectedUpdatedAt = null } = {}) => {
      const d = desk();
      const item = d.configuration?.settings?.find((row) => row.key === key);
      if (!item) throw new Error("setting-unavailable");
      if (item.organizationEditable === false) throw Object.assign(new Error("setting-platform-only"), { code: "42501" });
      if (checkVersion && (item.overridden ? item.updatedAt ?? null : null) !== (expectedUpdatedAt ?? null)) {
        throw Object.assign(new Error("setting-changed"), { code: "40001" });
      }
      if (!reset && !validSettingValue(item, value)) throw new Error("setting-invalid");
      const next = reset ? item.defaultValue : value;
      const previous = item.value;
      const at = new Date().toISOString();
      const action = reset ? "setting_reset" : "setting_updated";
      item.value = next;
      item.overridden = !reset;
      item.updatedAt = reset ? null : at;
      item.lastChange = { action, at, actorName: "Alex Rivera" };
      auditSeq += 1;
      d.configurationAudit = [
        { id: `demo-config-audit-${auditSeq}`, action, key, previousValue: previous, newValue: next, actorName: "Alex Rivera", createdAt: at },
        ...(d.configurationAudit ?? []),
      ].slice(0, 100);
      setData((current) => current ? ({
        ...current,
        organizationConfiguration: organizationConfigurationWithSetting(current.organizationConfiguration, key, next),
      }) : current);
      record(d, action, null, { key });
      return { key, value: next, overridden: !reset, updatedAt: item.updatedAt, updated: true };
    };
    const evidenceDesk = () => {
      const d = desk();
      if (!d.administrativeEvidence) d.administrativeEvidence = {
        fieldNoteBlocks: [
          { id: "sample-note-1", sourceId: "sample-source-1", sourceTitle: "Member interview", sourceType: "interview", provenance: "Recorded with consent", issueKey: "accommodation", body: "Schedule changes interrupted the approved accommodation.", annotation: "Confirm dates against the attendance record.", packetState: "included" },
          { id: "sample-note-2", sourceId: "sample-source-2", sourceTitle: "Supervisor memorandum", sourceType: "document", provenance: "Member-provided copy", issueKey: "accommodation", body: "The memorandum documents the changed reporting time.", annotation: "", packetState: "draft" },
        ],
        packets: [{ id: "sample-packet-1", issueKey: "accommodation", title: "Accommodation evidence packet", body: "Member interview and memorandum", status: "draft" }],
        actions: [
          { targetKind: "field_note_block", actionKey: "include", label: "Include evidence in packet" },
          { targetKind: "field_note_block", actionKey: "exclude", label: "Exclude evidence from packet" },
          { targetKind: "field_note_packet", actionKey: "mark_review_ready", label: "Mark packet review ready" },
          { targetKind: "member_case", actionKey: "case_record_review", label: "Record case review" },
          { targetKind: "chapter_task", actionKey: "task_record_review", label: "Record task review" },
          { targetKind: "member_profile", actionKey: "member_record_review", label: "Record member review" },
        ],
        actionTargets: [
          { targetKind: "member_case", id: "9c115483-b1af-4d1c-81d6-c34d866df51a", label: "ISS-204 · Accommodation schedule" },
          { targetKind: "chapter_task", id: "6af712e2-9262-4447-bb0b-305e9491e63a", label: "Review workplace safety log" },
          { targetKind: "member_profile", id: "3320f105-6825-45f0-b101-4031648b4940", label: "Morgan Lee" },
        ],
        history: [],
      };
      return d.administrativeEvidence;
    };
    return {
      ...demoChapterAppointmentSupervisionApi,
      loadDesk: async () => JSON.parse(JSON.stringify(desk())),
      loadInvitations: async () => JSON.parse(JSON.stringify(desk().invitations)),
      loadEvents: async () => JSON.parse(JSON.stringify(desk().events)),
      loadAdministrativeEvidence: async (page = 0) => {
        const source = evidenceDesk();
        const offset = page * 25;
        const slice = (rows) => rows.slice(offset, offset + 25);
        return JSON.parse(JSON.stringify({
          ...source,
          fieldNoteBlocks: slice(source.fieldNoteBlocks),
          packets: slice(source.packets),
          history: slice(source.history),
          page,
          pageSize: 25,
          hasNext: {
            notes: Math.max(source.fieldNoteBlocks.length, source.packets.length) > offset + 25,
            actions: source.history.length > offset + 25,
          },
        }));
      },
      addFieldNoteEvidence: async (fields) => {
        const item = { id: `sample-note-${Date.now()}`, sourceId: `sample-source-${Date.now()}`, ...fields, packetState: "draft" };
        evidenceDesk().fieldNoteBlocks.unshift(item); return item;
      },
      draftFieldNotePacket: async (issueKey, title) => {
        const included = evidenceDesk().fieldNoteBlocks.filter((row) => row.issueKey === issueKey && row.packetState === "included");
        if (!included.length) throw new Error("included-evidence-required");
        const item = { id: `sample-packet-${Date.now()}`, issueKey, title, body: included.map((row) => row.body).join("\n\n"), status: "draft" };
        evidenceDesk().packets.unshift(item); return item;
      },
      executeAdministrativeObjectAction: async (fields) => {
        const e = evidenceDesk();
        const rows = fields.targetKind === "field_note_block" ? e.fieldNoteBlocks : fields.targetKind === "field_note_packet" ? e.packets : e.actionTargets;
        const target = rows.find((row) => row.id === fields.targetId);
        if (!target) throw new Error("target-unavailable");
        const previousState = fields.targetKind === "field_note_block" ? { packetState: target.packetState } : { status: target.status ?? "active" };
        if ((fields.actionKey === "include" && target.packetState === "included") || (fields.actionKey === "exclude" && target.packetState === "excluded")) throw new Error("state-unchanged");
        if (fields.actionKey === "include") target.packetState = "included";
        if (fields.actionKey === "exclude") target.packetState = "excluded";
        if (fields.actionKey === "mark_review_ready") {
          if (target.status !== "draft") throw new Error("packet-already-ready");
          target.status = "review_ready";
        }
        const resultingState = fields.actionKey.endsWith("record_review") ? { ...previousState, reviewRecorded: true } : fields.targetKind === "field_note_block" ? { packetState: target.packetState } : { status: target.status };
        const item = { id: `sample-action-${Date.now()}`, ...fields, targetLabel: target.label ?? target.title ?? target.sourceTitle ?? target.id, actorLabel: "Alex Rivera", previousState, resultingState, createdAt: new Date().toISOString() };
        e.history.unshift(item); return item;
      },
      inviteMember: async (fields) => {
        const d = desk();
        const normalizedEmail = fields.email.trim().toLowerCase();
        const duplicate = d.invitations.items.some((row) => row.normalizedEmail === normalizedEmail && ["pending", "accepting", "accepted"].includes(row.status));
        if (!duplicate) {
          invitationSeq += 1;
          const now = new Date();
          d.invitations.items.unshift({
            id: `demo-invite-live-${invitationSeq}`,
            kind: fields.formerMember ? "reactivation" : "provision",
            normalizedEmail,
            fullName: String(fields.fullName || "").trim() || normalizedEmail,
            chapterId: d.invitations.chapter.id,
            initialRole: fields.formerMember ? null : (fields.initialRole || null),
            locale: fields.locale === "es" ? "es" : "en",
            status: "pending",
            deliveryVersion: 1,
            createdLabel: momentLabel(now),
            expiresLabel: momentLabel(new Date(now.getTime() + 15 * 60 * 1000)),
          });
        }
        return { accepted: true };
      },
      resendInvitation: async (invitationId) => {
        const d = desk();
        const old = d.invitations.items.find((row) => row.id === invitationId);
        if (old && ["pending", "delivery_failed", "expired"].includes(old.status)) {
          invitationSeq += 1;
          const now = new Date();
          const replacement = {
            ...old,
            id: `demo-invite-live-${invitationSeq}`,
            status: "pending",
            deliveryVersion: old.deliveryVersion + 1,
            createdLabel: momentLabel(now),
            expiresLabel: momentLabel(new Date(now.getTime() + 15 * 60 * 1000)),
          };
          d.invitations.items = [replacement, ...d.invitations.items.filter((row) => row.id !== invitationId)];
        }
        return { accepted: true };
      },
      revokeInvitation: async (invitationId) => {
        const row = desk().invitations.items.find((item) => item.id === invitationId);
        if (row && ["pending", "delivery_failed", "expired"].includes(row.status)) row.status = "revoked";
        return { accepted: true };
      },
      loadMemberDirectory: async (query, after = null) => {
        const needle = query.trim().toLocaleLowerCase();
        const rows = demoData().adminSearchPool
          .filter((person) => !needle || person.fullName.toLocaleLowerCase().includes(needle))
          .map((person) => ({ ...person, chapterId: "ma-dcf", chapterName: "North County Transit Workers" }))
          .sort((a, b) => a.fullName.localeCompare(b.fullName) || a.userId.localeCompare(b.userId));
        const start = after ? rows.findIndex((row) => row.fullName === after.name && row.userId === after.id) + 1 : 0;
        return { items: rows.slice(Math.max(0, start), Math.max(0, start) + 25), nextCursor: null };
      },
      // Every demo directory row lives in the DCF chapter only.
      loadMemberChapterMemberships: async (userId) => ({
        userId,
        complete: true,
        chapters: [{ chapterId: "ma-dcf", home: true, lastChapter: true, roles: [] }],
      }),
      // The demo admin has generated no recovery codes yet.
      loadMfaRecoveryStatus: async () => ({ generation: 0, unusedCount: 0 }),
      recoveryCodeEnrollmentEnabled: () => dataRef.current?.organizationConfiguration?.recoveryCodeEnrollmentEnabled !== false,
      createChapter: async (fields) => {
        const d = desk();
        const row = { ...fields, isDefault: false, memberCount: 0, staffCount: 0 };
        d.organization.chapters.push(row);
        d.organization.chapters.sort((a, b) => a.orderIndex - b.orderIndex || a.name.localeCompare(b.name));
        record(d, "create_chapter", null, { chapterId: row.id, fields: ["name", "region", "orderIndex"] });
        return { ...row, created: true };
      },
      updateChapter: async (chapterId, fields) => {
        const d = desk();
        const row = d.organization.chapters.find((chapter) => chapter.id === chapterId);
        if (!row) throw new Error("chapter-unavailable");
        Object.assign(row, fields);
        d.organization.chapters.sort((a, b) => a.orderIndex - b.orderIndex || a.name.localeCompare(b.name));
        record(d, "update_chapter", null, { chapterId, fields: ["name", "region", "orderIndex"] });
        return { ...row, updated: true };
      },
      saveRetentionPolicy: async (fields) => {
        const d = desk();
        const policy = d.retentionEngine.policies.find((row) => row.dataClass === fields.dataClass);
        if (!policy) throw new Error("retention-policy-unavailable");
        Object.assign(policy, {
          retentionDays: fields.retentionDays,
          executionEnabled: fields.executionEnabled === true,
          configured: true,
          updatedAt: new Date().toISOString(),
        });
        return JSON.parse(JSON.stringify(d.retentionEngine));
      },
      previewRetentionRun: async (dataClass) => {
        const d = desk();
        const policy = d.retentionEngine.policies.find((row) => row.dataClass === dataClass);
        if (!policy?.configured) throw new Error("retention-policy-unavailable");
        const eligibleCount = dataClass === "organization_page_views" ? 18 : dataClass === "public_event_rsvps" ? 4 : 0;
        const run = {
          id: `retention-run-live-${Date.now()}`,
          dataClass,
          retentionDays: policy.retentionDays,
          mode: "dry_run",
          status: "previewed",
          eligibleCount,
          deletedCount: 0,
          remainingCount: 0,
          confirmationPhrase: `AUTHORIZE ${dataClass}`,
          createdAt: new Date().toISOString(),
        };
        d.retentionEngine.runs.unshift(run);
        return JSON.parse(JSON.stringify(run));
      },
      authorizeRetentionRun: async (runId, confirmation) => {
        const run = desk().retentionEngine.runs.find((row) => row.id === runId);
        if (!run || confirmation !== `AUTHORIZE ${run.dataClass}`) throw new Error("retention-authorization-denied");
        Object.assign(run, {
          mode: "manual",
          status: "authorized",
          authorizationExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        });
        return JSON.parse(JSON.stringify(run));
      },
      executeRetentionRun: async (runId) => {
        const run = desk().retentionEngine.runs.find((row) => row.id === runId);
        if (!run || run.status !== "authorized") throw new Error("retention-run-unavailable");
        Object.assign(run, {
          status: "completed",
          deletedCount: Math.min(run.eligibleCount, 5000),
          remainingCount: Math.max(0, run.eligibleCount - 5000),
          completedAt: new Date().toISOString(),
        });
        return JSON.parse(JSON.stringify(run));
      },
      grantRole: async (userId, role) => {
        const d = desk();
        let person = d.roster.find((p) => p.userId === userId);
        if (!person) {
          const source = demoData().adminSearchPool.find((p) => p.userId === userId);
          person = { userId, fullName: source?.fullName || "Member", initials: source?.initials || "M", memberSince: source?.memberSince ?? 2026, roles: [] };
          d.roster.push(person);
          d.roster.sort((a, b) => a.fullName.localeCompare(b.fullName));
        }
        if (!person.roles.includes(role)) person.roles = [...person.roles, role].sort();
        record(d, "grant_role", person.fullName, { role });
        return { userId, role, granted: true };
      },
      revokeRole: async (userId, role) => {
        const d = desk();
        const person = d.roster.find((p) => p.userId === userId);
        if (person) {
          person.roles = person.roles.filter((item) => item !== role);
          if (person.roles.length === 0) d.roster = d.roster.filter((p) => p.userId !== userId);
          record(d, "revoke_role", person.fullName, { role });
        }
        return { userId, role, revoked: true };
      },
      // The demo must not reach the real endpoint — it would 401 on the fake
      // session and, worse, a demo click must never be able to strip a real
      // member's second factor. Audited in-memory so the flow still reads true.
      resetMfa: async (userId) => {
        const d = desk();
        const person = demoData().adminSearchPool.find((p) => p.userId === userId)
          || d.roster.find((p) => p.userId === userId);
        record(d, "reset_mfa", person?.fullName || "Member", { factorsRemoved: 1 });
        return { removed: 1, audited: true, notified: true };
      },
      // No preservation orders exist in the fixture, and none can be placed
      // from it; the card reads honestly empty.
      listLegalHolds: async () => [],
      setStaffMfaPolicy: async (required) => {
        const d = desk();
        const next = Boolean(required);
        const changed = d.mfaPolicy.requireStaffMfa !== next;
        d.mfaPolicy.requireStaffMfa = next;
        if (changed) record(d, "set_staff_mfa_policy", null, { requireStaffMfa: next });
        return { requireStaffMfa: next, changed };
      },
      setMemberMfaPolicy: async (required) => {
        const d = desk();
        const next = Boolean(required);
        const changed = d.mfaPolicy.requireMemberMfa !== next;
        d.mfaPolicy.requireMemberMfa = next;
        if (changed) record(d, "set_staff_mfa_policy", null, { requireStaffMfa: true, requireMemberMfa: next });
        return { requireMemberMfa: next, changed };
      },
      setCompassAiEnabled: async (enabled) => {
        const d = desk();
        const next = Boolean(enabled);
        if (next && !d.compassAiGovernance.attestationReady) throw new Error("A current PREVIEW attestation is required.");
        const changed = d.compassAiGovernance.enabled !== next;
        d.compassAiGovernance.enabled = next;
        if (changed) record(d, "set_compass_ai_enabled", null, { enabled: next });
        return { enabled: next, changed };
      },
      setCompassAiRoleLimit: async (role, hourlyLimit) => {
        const d = desk();
        const row = d.compassAiGovernance.roleLimits.find((item) => item.role === role);
        const next = Number(hourlyLimit);
        if (!row || !Number.isSafeInteger(next) || next < 0 || next > 200) throw new Error("Invalid PREVIEW role limit.");
        row.hourlyLimit = next;
        record(d, "set_compass_ai_role_limit", null, { role, hourlyLimit: next });
        return { role, hourlyLimit: next, changed: true };
      },
      attestCompassAiProvider: async (fields) => {
        const d = desk();
        const status = fields.status === "revoked" ? "revoked" : "verified";
        const row = {
          id: `sample-preview-attestation-${Date.now()}`,
          status,
          gateway: d.compassAiGovernance.gateway,
          model: d.compassAiGovernance.model,
          evidenceRef: `PREVIEW — ${fields.evidenceRef}`,
          expiresAt: fields.expiresAt || null,
          expiresLabel: fields.expiresAt ? nowLabel() : "",
          attestedBy: "sample-preview-admin",
          actorName: "Alex Rivera (PREVIEW)",
          createdAt: new Date().toISOString(),
          createdLabel: nowLabel(),
        };
        d.compassAiGovernance.attestations.unshift(row);
        d.compassAiGovernance.latestAttestation = row;
        d.compassAiGovernance.attestationReady = status === "verified";
        if (status === "revoked") d.compassAiGovernance.enabled = false;
        record(d, "attest_compass_ai_provider", null, { status });
        return { id: row.id, status, samplePreview: true };
      },
      searchMembers: async (query) => {
        const d = desk();
        const needle = query.trim().toLowerCase();
        return demoData().adminSearchPool
          .filter((p) => p.fullName.toLowerCase().includes(needle))
          .map((p) => {
            const granted = d.roster.find((r) => r.userId === p.userId);
            return { ...p, roles: granted ? [...granted.roles] : [...p.roles] };
          });
      },
      searchRecoveryMembers: async (query) => {
        const needle = query.trim().toLowerCase();
        return demoData().adminSearchPool
          .filter((person) => person.userId !== "staff-ar" && person.fullName.toLowerCase().includes(needle))
          .map((person) => ({ ...person, roles: [...person.roles] }));
      },
      // Demo recovery never calls the server or retains the entered address.
      // It records only the same closed, address-free audit detail as live.
      recoverSigninAddress: async ({ userId, reason, identityVerified }) => {
        if (!identityVerified || !["lost_inbox", "address_retired"].includes(reason)) throw new Error("recovery-unavailable");
        const person = demoData().adminSearchPool.find((row) => row.userId === userId);
        if (!person) throw new Error("recovery-unavailable");
        const d = desk();
        record(d, "recover_signin_address", person.fullName, {
          operationId: `demo-recovery-${auditSeq + 1}`,
          reason,
          sessionsRevoked: true,
        });
        return { completed: true };
      },
      reissuePassword: async ({ userId, identityVerified }) => {
        if (!identityVerified || !demoData().adminSearchPool.some((row) => row.userId === userId)) {
          throw new Error("reissue-unavailable");
        }
        // SAMPLE never sends mail or creates credentials. This session-only
        // success keeps the invited demo control clickable without implying a
        // real provider delivery.
        return { completed: true, sample: true };
      },
      // The SAMPLE desk mirrors the registry generically: the same validation
      // as private.setting_value_valid, the version check, reset, and a value
      // audit, for any setting the fixture carries.
      updateOrganizationSetting: async (key, value) => {
        const result = writeDemoSetting(key, value, { checkVersion: false });
        return { key: result.key, value: result.value, updated: true };
      },
      setOrganizationSetting: async (key, value, expectedUpdatedAt) => writeDemoSetting(key, value, { checkVersion: true, expectedUpdatedAt }),
      resetOrganizationSetting: async (key, expectedUpdatedAt) => writeDemoSetting(key, null, { reset: true, checkVersion: true, expectedUpdatedAt }),
      loadConfigurationAudit: async (key = null, limit = 50) => JSON.parse(JSON.stringify(
        (desk().configurationAudit ?? []).filter((entry) => !key || entry.key === key).slice(0, limit),
      )),
      updateOrganizationLabel: async (key, value) => {
        const d = desk();
        if (!d.configuration?.labelKeys?.includes(key) && !TERM_LABEL_KEYS.includes(key) && !WORKLOAD_CATEGORY_LABEL_KEYS.includes(key)) throw new Error("label-unavailable");
        const clean = String(value ?? "").trim().replace(/\s+/gu, " ");
        if (clean.length > 40 || /[<>\p{Cc}]/u.test(clean)) throw new Error("label-invalid");
        if (clean) d.configuration.labelOverrides[key] = clean;
        else delete d.configuration.labelOverrides[key];
        setData((current) => {
          if (!current) return current;
          return {
            ...current,
            organizationConfiguration: {
              ...(current.organizationConfiguration ?? {}),
              labelOverrides: { ...(d.configuration?.labelOverrides ?? {}) },
            },
          };
        });
        record(d, clean ? "label_updated" : "label_removed", null, { key });
        return clean
          ? { key, value: clean, updated: true }
          : { key, value: null, removed: true };
      },
      ...sampleWorkloadCategoriesApi({ desk, setData }),
      loadFailedLoginInbox: async (status = null) => {
        const d = desk();
        if (status && !["open", "reviewed", "dismissed"].includes(status)) throw new Error("status-invalid");
        const allItems = d.failedLoginInbox?.items ?? [];
        const threshold = d.configuration?.settings
          ?.find((item) => item.key === "security.failed_login_alert_threshold")?.value
          ?? d.failedLoginInbox?.attentionThreshold
          ?? 5;
        return JSON.parse(JSON.stringify({
          openLast24Hours: countOpenFailedLoginsLast24Hours(allItems),
          attentionThreshold: threshold,
          items: status ? allItems.filter((item) => item.status === status) : allItems,
        }));
      },
      dispositionFailedLoginAttempt: async (attemptId, status, note) => {
        const d = desk();
        const clean = String(note ?? "").trim();
        if (!["reviewed", "dismissed"].includes(status) || clean.length < 2 || clean.length > 240 || /\p{Cc}/u.test(clean)) {
          throw new Error("disposition-invalid");
        }
        const item = d.failedLoginInbox?.items?.find((row) => row.id === attemptId && row.status === "open");
        if (!item) throw new Error("attempt-unavailable");
        item.status = status;
        item.dispositionNote = clean;
        item.reviewedAt = new Date().toISOString();
        d.failedLoginInbox.openLast24Hours = countOpenFailedLoginsLast24Hours(d.failedLoginInbox.items);
        return { id: attemptId, status, updated: true };
      },
      createEvent: async (fields) => {
        const d = desk();
        d.events.push({
          id: fields.id, title: fields.title, startsAt: fields.startsAt,
          startsLabel: nowLabel(), location: fields.location, summary: fields.summary,
          checkInCode: fields.checkInCode ? fields.checkInCode.toUpperCase() : null, orderIndex: d.events.length + 1,
          chapterId: "wor", chapterName: "Harborview Care United",
          isPublic: fields.isPublic === true,
          isPublicAcrossAgencies: fields.isPublicAcrossAgencies === true,
          rsvpOpen: fields.rsvpOpen !== false,
          rsvpCount: 0, checkinCount: 0, version: 1,
        });
        record(d, "create_event", null, { eventId: fields.id, title: fields.title });
        return { id: fields.id, created: true };
      },
      closeGovernance: async (requestId, status, response) => {
        const d = desk();
        const row = (d.governance || []).find((entry) => entry.id === requestId);
        if (row) { row.status = status; row.response = response; row.updatedAt = new Date().toISOString(); }
        return { id: requestId, status, response };
      },
      updateEvent: async (eventId, fields) => {
        const d = desk();
        const item = d.events.find((e) => e.id === eventId);
        if (item) {
          if (fields.title) item.title = fields.title;
          if (fields.startsAt) item.startsAt = fields.startsAt;
          if (fields.location) item.location = fields.location;
          if (fields.summary) item.summary = fields.summary;
          if (fields.checkInCode) item.checkInCode = fields.checkInCode.toUpperCase();
          if (fields.removeCheckInCode === true) item.checkInCode = null;
          if (typeof fields.isPublic === "boolean") item.isPublic = fields.isPublic;
          if (typeof fields.isPublicAcrossAgencies === "boolean") item.isPublicAcrossAgencies = fields.isPublicAcrossAgencies;
          item.version = (item.version ?? 1) + 1;
          record(d, "update_event", null, { eventId, title: item.title });
        }
        return { id: eventId, updated: true, version: item?.version };
      },
      setEventAgenda: async (eventId, agenda) => {
        const d = desk();
        const item = d.events.find((e) => e.id === eventId);
        const clean = agenda?.trim() || null;
        if (item) {
          item.agenda = clean;
          item.version = (item.version ?? 1) + 1;
          record(d, "update_event", null, { eventId, title: item.title, fields: ["agenda"] });
        }
        return { updated: Boolean(item), agenda: clean, version: item?.version };
      },
      setEventRsvpOpen: async (eventId, open) => {
        const d = desk();
        const item = d.events.find((e) => e.id === eventId);
        const updated = Boolean(item) && (item.rsvpOpen !== false) !== (open === true);
        if (updated) {
          item.rsvpOpen = open === true;
          item.version = (item.version ?? 1) + 1;
          record(d, "update_event", null, { eventId, title: item.title, fields: ["rsvp_open"] });
        }
        return { updated, rsvpOpen: open === true, version: item?.version };
      },
      // Staff-only drafts stay on the cloned desk, apart from its events.
      listEventDrafts: async () => JSON.parse(JSON.stringify(desk().eventDrafts || [])),
      saveEventDraft: async (draftId, fields) => {
        const d = desk();
        d.eventDrafts ||= [];
        const now = new Date().toISOString();
        const existing = draftId ? d.eventDrafts.find((row) => row.id === draftId) : null;
        if (draftId && !existing) throw new Error("unknown event draft");
        // A monotonic counter: an id is never reused after a delete.
        d.eventDraftSeq = (d.eventDraftSeq || 0) + 1;
        const row = existing || { id: `demo-draft-${d.eventDraftSeq}`, createdAt: now };
        Object.assign(row, { fields: { ...fields }, updatedAt: now });
        if (!existing) d.eventDrafts.unshift(row);
        return JSON.parse(JSON.stringify(row));
      },
      deleteEventDraft: async (draftId) => {
        const d = desk();
        const before = (d.eventDrafts || []).length;
        d.eventDrafts = (d.eventDrafts || []).filter((row) => row.id !== draftId);
        return { id: draftId, deleted: d.eventDrafts.length < before };
      },
      loadFormTemplates: async () => {
        await loadLanguage("es");
        return JSON.parse(JSON.stringify(desk().formTemplates || []));
      },
      upsertFormTemplate: async (fields) => {
        const d = desk();
        const update = upsertDemoFormTemplate(d.formTemplates, fields);
        d.formTemplates = update.rows;
        return update.result;
      },
      deactivateFormTemplate: async (key) => {
        const d = desk();
        const update = setDemoFormTemplateActive(d.formTemplates, key, false);
        d.formTemplates = update.rows;
        return update.result;
      },
      reactivateFormTemplate: async (key) => {
        const d = desk();
        const update = setDemoFormTemplateActive(d.formTemplates, key, true);
        d.formTemplates = update.rows;
        return update.result;
      },
    };
  // `lang` joins the list because momentLabel now renders the member's clock
  // rather than the host's.
  }, [demoChapterAppointmentSupervisionApi, lang]);

  // Every in-flight async read is tagged with the session generation that
  // started it. Sign-out, a user switch and demo entry all bump the counter,
  // so a slow response that lands afterwards is dropped instead of painting
  // one member's cases, messages and notifications under another's session.
  // All the identity/ordering/gap logic lives in src/lib/sessionGuard.js so it
  // can be tested directly — App forces demo mode under vitest, so anything
  // written as an inline closure here is unreachable from a test.
  const navigationSaveRef = useRef(null);
  const navigationLoadedRef = useRef(null);

  useEffect(() => {
    if (!data?.member?.id) return;
    const identityKey = `${demoActive ? "demo" : "live"}:${data.member.id}`;
    if (navigationLoadedRef.current === identityKey) return;
    navigationLoadedRef.current = identityKey;
    navigationSaveRef.current = null;
    if (demoActive) {
      const saved = loadDemoNavigationPreferences(data.member.id, true);
      if (saved) setData((current) => current ? { ...current, member: { ...current.member, ...saved } } : current);
      return;
    }
    if (Array.isArray(data.member.shortcutKeys) && Array.isArray(data.member.workWidgetOrder)) {
      try { window.localStorage.removeItem("sg-work-widgets"); } catch { /* preference data is already account-backed */ }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- preferences are loaded once per identity; later edits must not re-apply the stored boot snapshot.
  }, [data?.member?.id, demoActive]);

  useEffect(() => {
    if (!demo) return;
    const path = window.location.pathname.replace(/\/+$/, "") || "/";
    if (path === "/" && !embedPhoneFromUrl()) {
      window.history.replaceState({}, "", "/m?demo=1");
    }
  }, [demo]);

  useEffect(() => {
    if (demo || !hasDemoQuery(window.location.search)) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("demo");
    const search = url.searchParams.toString();
    window.history.replaceState({}, "", `${url.pathname}${search ? `?${search}` : ""}${url.hash}`);
  }, [demo]);

  // Cold SAMPLE boot: the fixtures live in their own chunk, so paint once it
  // lands. Fires at most once, on mount, and only when demo was already active
  // with nothing cached — a real sign-in must never be undone by a late re-run, and a
  // real signed-in session must never see this path at all.
  useEffect(() => {
    if (!demoActive || bootFixtures) return undefined;
    let cancelled = false;
    const operation = guardRef.current.captureOperation();
    loadDemoData().then((fixtures) => {
      if (cancelled || !operation.isCurrent()) return;
      guardRef.current.beginSession(fixtures.member.id);
      demoFormSignaturesRef.current = demoSignatureRows(fixtures.forms);
      const nextSession = demoSessionFor(fixtures);
      sessionRef.current = nextSession;
      setSession(nextSession);
      setData(pendingDemoSliceRef.current ? mergeDemoSlice(fixtures, pendingDemoSliceRef.current) : fixtures);
      pendingDemoSliceRef.current = null;
      setLoading(false);
    }).catch(() => {
      // The fixture chunk did not arrive (offline, or a deploy rotated its
      // hashed filename out from under this tab). Without this the promise
      // rejects into nothing and `loading` stays true forever — a permanent
      // "Loading Union Ground…" with no explanation and no way out. Dropping
      // the flag falls through to the sign-in screen, which is at least a
      // screen the visitor can act on.
      if (!cancelled && operation.isCurrent()) {
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
    // `bootFixtures` becomes truthy after loadDemoData fills its module cache.
    // Keeping the effect declarative also lets React Strict Mode's second
    // setup own the promise after its first setup deliberately cancels.
  }, [bootFixtures, demoActive]);

  // Offline outbox + snapshot store (PR8). IndexedDB when available, an
  // in-memory twin otherwise — either way storage failure is best-effort and
  // never adds a new way for a write to fail.
  const outboxStoreRef = useRef(null);
  // A replayed form-draft save still in flight, by template, so discarding
  // that draft waits for it instead of letting it land after the delete.
  const replayingFormDraftsRef = useRef(new Map());
  if (!outboxStoreRef.current) outboxStoreRef.current = createOutboxStore();
  // Replay executors for the queueable (strictly idempotent) writes. args were
  // frozen at enqueue time; userId inside them is the member who queued the
  // write, and replay only runs while that same member is signed in.
  const outboxExecutors = useMemo(() => ({
    ...createMemberOutboxExecutors(supabase, () => sessionRef.current),
    // A replayed save stored its answers: the open editor's next save names
    // them as its base (gate final on). A discard of that draft waits
    // for a replay still in flight ( gate round 1).
    formDraft: (args) => {
      const templateKey = args.fields?.templateKey;
      // The member this replay is sent for and the session-guard operation it
      // belongs to, taken before anything is awaited: a reply that arrives
      // after another account signed in fills no lane of theirs ( final,
      // the await audit; a review note).
      const acting = sessionRef.current;
      const operation = guardRef.current.captureOperation(acting?.user?.id ?? null);
      // Its requests, the recovery read included, are bound to that member
      // too: they send nothing unless they are still signed in, and go out
      // with their token ( held-commit review;  r1s1 and r2s1).
      const asUser = { userId: acting?.user?.id ?? null, accessToken: acting?.access_token ?? null };
      const save = replayFormDraft({
        memberId: operation.userId, fields: args.fields, isCurrent: operation.isCurrent,
        save: (fields) => saveFormDraft(supabase, fields, { asUser }),
        readStored: (fields) => readStoredFormDraft(supabase, { userId: operation.userId, templateKey: fields.templateKey, formId: fields.formId ?? null }, { asUser }),
      });
      if (templateKey) {
        const replaying = replayingFormDraftsRef.current;
        replaying.set(templateKey, save);
        save.finally(() => { if (replaying.get(templateKey) === save) replaying.delete(templateKey); }).catch(() => {}); // swallow-ok: bookkeeping only; the caller receives save and its failure
      }
      return save;
    },
  }), []);

  // The command palette's officer chart, held beside the snapshot (see
  // loadSearchPrerequisites). It is member-scoped data and is dropped with the
  // snapshot at every session generation and scope reset below.
  const [paletteStructure, setPaletteStructure] = useState(null);
  const paletteStructureRef = useRef(null);
  const dropPaletteStructure = useCallback(() => {
    paletteStructureRef.current = null;
    setPaletteStructure(null);
  }, []);
  // Member-scoped state that must not outlive the security context it was read
  // under (Union Ground's assurance-downgrade path below the auth listener).
  function clearSessionScopedState() {
    setData(null);
    dataRef.current = null;
    setActivePlan(null);
    setProfileOpen(false);
    setNotificationsOpen(false);
    setDataError("");
    setPendingSync(0);
    setSearchFocus(null);
    dropPaletteStructure();
  }
  // Read through a ref by the mount-scoped auth listener, like refreshRef.
  const clearSessionScopedStateRef = useRef(clearSessionScopedState);
  clearSessionScopedStateRef.current = clearSessionScopedState;

  const beginSessionGeneration = useCallback((nextUserId, options) => {
    if (nextUserId) {
      departedSessionIDRef.current = null;
      explicitSignOutRef.current = false;
      try {
        window.sessionStorage.removeItem(EXPLICIT_SIGN_OUT_VISIT_KEY);
      } catch { /* Storage is best-effort; this document still starts a new visit. */ }
    }
    if (guardRef.current.beginSession(nextUserId, options)) {
      // A refused address belongs to the person who was refused it: sign-out,
      // a new sign-in and the next account in this tab never open it (G7 P2
      // on). A token refresh for the same person keeps it.
      pendingDeskRouteRef.current = null;
      // Retained form-draft answers belong to the departing session; a later
      // sign-in, even as the same member, must never resume or replay them.
      endFormDraftSession();
      clearDeletionAuditPendingNoticeForSession(nextUserId);
      memberLoaderRef.current?.dispose();
      memberLoaderRef.current = null;
      guideLocalPendingRef.current = false;
      sampleChapterCatalogRef.current = [];
      projectionEpochRef.current += 1;
      setResourceRevision((value) => value + 1);
      setData(null);
      dataRef.current = null;
      // BUG-UG-DROP-COMMAND-PALETTE-S-HELD-OFFICER-CHART-SIGN-20261013:
      // the palette's officer chart is held beside the snapshot, so clearing
      // `data` did not clear it. Its member-id check let the same member's
      // next sign-in reuse the previous visit's chart, so a removed or renamed
      // officer stayed listed until the chapter or organization changed.
      dropPaletteStructure();
      if (nextUserId) setLoading(true);
      // Clearing `data` alone was not enough. Member-scoped UI state outlives
      // it, and the ballot dialog is the sharp edge: A opens a ballot and picks
      // an option, the browser's identity changes to B (another tab completes a
      // magic link, or a recovery lands), and the dialog is STILL OPEN with A's
      // preselection — but the ballot RPC derives the voter from the server's
      // auth.uid(), so B's submission records A's preselected option under B's
      // identity. On a secret ballot that is
      // not a glitch, it is a spoiled vote nobody can trace — and since votes
      // became final (20260808230000) there is no re-vote to correct it with,
      // so clearing the dialog here is the only defense.
      setActivePlan(null);
      setProfileOpen(false);
      setNotificationsOpen(false);
      // The chapter sheet names the previous member's chapter; the next
      // identity must not open onto it.
      setChapterSheetOpen(false);
      setDataError("");
      setNotice("");
      // The Compass composer is the same edge with worse contents: the draft is
      // free text the member wrote about their own discipline or grievance, and
      // it survives an identity change because nothing else clears it. B's
      // composer would reopen pre-filled with A's question — a disclosure on a
      // shared device, not a stale-state glitch. The search deep-link payload
      // is member-scoped for the same reason (it names A's case or thread), and
      // the guide/tour overlays are cleared so the next identity starts on the
      // shell rather than inside A's half-finished walkthrough.
      setAssistantOpen(false);
      setAssistantDraft("");
      setSearchFocus(null);
      setGuideOpen(false);
      setTourOpen(false);
      // The selected hat is member-scoped identity state: the next account on
      // a shared device starts as Member, never wearing the previous
      // account's staff hat inside shared tools. On the SAMPLE origin the
      // hat switcher owns this state instead — a persona swap is an identity
      // change the switcher initiated, and resetting here would race the
      // swap back to Member. The hat this same account chose earlier in the
      // tab survives its own cold sign-in on a reload; the route guard checks
      // it against the live roles once they arrive
      // (REQ-UG-TYPED-ADDRESS-ROLE-DESK-BOUNCE-20261030).
      if (!demo) {
        const restored = readActingHat();
        const nextHat = nextUserId && restored?.userId === nextUserId ? restored.hat : "member";
        // An identity reset is not a hat switch: a refused address after it
        // is still explained.
        lastGatedStaffHatRef.current = nextHat;
        selectedStaffHatRef.current = nextHat;
        setSelectedStaffHat(nextHat);
      }
      // Offline state is member-scoped too: the previous member's pending
      // count must not render in the next member's banner.
      setPendingSync(0);
      demoDraftRowsRef.current.clear();
      demoFormSignaturesRef.current.clear();
      demoFormFilesRef.current.clear();
    }
    return guardRef.current.generation;
  }, [
    clearDeletionAuditPendingNoticeForSession,
    demo,
    dropPaletteStructure,
    setActivePlan,
    setAssistantDraft,
    setAssistantOpen,
    setChapterSheetOpen,
    setGuideOpen,
    setNotificationsOpen,
    setNotice,
    setProfileOpen,
    setSearchFocus,
    setSelectedStaffHat,
    setTourOpen,
  ]);

  // An explicit sign-out ends the visit: land on the sign-in page at / with
  // no return-to intent, so the next sign-in on this device does not reopen
  // the last member's page. Other tabs land here only for the dedicated
  // explicit-sign-out signal; plain expiry/revocation tombstones preserve
  // requested-page resume. SAMPLE re-enters its persona straight away and
  // keeps its address.
  const landSignedOutAtRoot = useCallback(() => {
    if (sampleLive) return;
    explicitSignOutRef.current = true;
    try {
      window.sessionStorage.setItem(EXPLICIT_SIGN_OUT_VISIT_KEY, "1");
    } catch { /* Keep same-document protection even when tab storage is unavailable. */ }
    window.history.replaceState({}, "", "/");
    applyPageMetadata("/");
    setView(viewFromPath());
    setRouteLocation(window.location.pathname + window.location.search + window.location.hash);
  }, [sampleLive]);

  useEffect(() => {
    // A cross-document Back navigation can dispatch popstate before this App
    // mounts. Normalize the restored URL after Auth proves the visit ended;
    // never redirect an in-flight restore or a newly persisted login.
    if (loading || session || !explicitSignOutRef.current
      || appAuthStorageSessionLineage(appAuthStorageKey) !== null) return;
    const path = window.location.pathname;
    if (path === "/m" || path.startsWith("/m/")) landSignedOutAtRoot();
  }, [loading, session, landSignedOutAtRoot]);

  // Explicit sign-out leaves the device clean: purge this member's saved-copy
  // snapshot AND the two queue kinds that carry their own words — form drafts
  // and profile fields — before dropping the session. The rest of the queue
  // stays; those writes replay when their owner signs back in. The purge is
  // awaited (the snapshot delete is not) so the sensitive payloads are gone
  // before the session teardown that a shared-device user is waiting on;
  // storage failure stays best-effort and never blocks the sign-out itself.
  // `provenAbsentSession`: a session the revocation watcher proved gone with
  // an explicit provider absence . A revoked session id never comes
  // back, so sign-out goes straight to the local cleanup for that lineage
  // instead of the unbounded prepare and verify calls.
  async function signOutAndForget(scope = "local", bubbleError = false, { provenAbsentSession = null } = {}) {
    clearActingHat();
    // The chapter-notice colours read for this member.
    forgetNoticeChapters();
    clearNavUsageForUser(sessionRef.current?.user?.id ?? null);
    clearNavPinsForUser(sessionRef.current?.user?.id ?? null);
    const capturedSession = sessionRef.current;
    const operation = guardRef.current.captureOperation(capturedSession?.user?.id ?? null);
    const userId = capturedSession?.user?.id;
    if (userId) {
      deleteSnapshot(outboxStoreRef.current, userId).catch(() => {});
      await purgeSensitiveEntries(outboxStoreRef.current, userId).catch(() => {});
    }
    if (!operation.isCurrent()) return;
    if (bubbleError) setNotice("");
    try {
      await signOutSafely(supabase, {
        serviceWorker: typeof navigator !== "undefined" ? navigator.serviceWorker : null,
        scope,
        expectedUserID: userId,
        capturedSession,
        capturedRpcClientForSession: createCapturedAppSessionRpcClient,
        verifyCapturedSession: verifyCapturedAppSession,
        provenAbsentSession,
        getCurrentSession: () => sessionRef.current,
        compareAndClearLocalSession: (captured) => clearCapturedAppSessionLocally(captured, { explicitSignOut: true }),
        onLocalSessionCleared: async () => {
          const current = sessionRef.current;
          if (!operation.isCurrent() || !sameAuthSessionLineage(current, capturedSession)) return;
          departedSessionIDRef.current = sessionIDFromAccessToken(current?.access_token);
          sessionRef.current = null;
          beginSessionGeneration(null);
          setSession(null);
          setLoading(false);
          setAuthRestorePending(false);
          landSignedOutAtRoot();
          void supabase.realtime.setAuth();
          // A projection write that started before this generation changed
          // checks its captured operation after IndexedDB resolves and erases
          // itself. This second idempotent purge closes the complementary
          // ordering: a write already committed before the local clear cannot
          // survive the departure either.
          await deleteSnapshot(outboxStoreRef.current, userId).catch(() => {});
          await purgeSensitiveEntries(outboxStoreRef.current, userId).catch(() => {});
        },
        isCurrent: () => {
          const current = sessionRef.current;
          return operation.isCurrent() && sameAuthSessionLineage(current, capturedSession);
        },
      });
    } catch (error) {
      if (!operation.isCurrent()) return;
      setNotice(tr(signOutNoticeKey(error)));
      if (bubbleError) throw error;
    }
  }
  // One sign-out at a time for the visible Sign out controls: a repeat click
  // joins the running sign-out, and `signingOut` lets each control say that it
  // is underway. The rejection reaches only callers that asked for it.
  function signOutOnce(scope = "local", bubbleError = false, options = {}) {
    const running = signOutFlightRef.current;
    if (running?.scope === scope) return bubbleError ? running.promise : running.promise.catch(() => {});
    const flight = { scope, promise: null };
    flight.promise = signOutAndForget(scope, true, options).finally(() => {
      if (signOutFlightRef.current !== flight) return;
      signOutFlightRef.current = null;
      setSigningOut(false);
    });
    signOutFlightRef.current = flight;
    setSigningOut(true);
    return bubbleError ? flight.promise : flight.promise.catch(() => {});
  }
  // A session revoked from another device (Sign out everywhere) ends here the
  // way this device's own Sign out does, then the sign-in screen says why
  // . The watcher proves the revocation before this runs. SAMPLE
  // sessions are real and watched too; only the fixture client is exempt.
  const endRevokedSessionRef = useRef(null);
  endRevokedSessionRef.current = async (revoked) => {
    if (!sameAuthSessionLineage(sessionRef.current, revoked)) return;
    await signOutOnce("local", false, { provenAbsentSession: revoked });
    if (!sessionRef.current) setDeletionAuditPendingNotice(tr("auth.signedOutOnThisDevice"));
  };
  const sessionRevocationCheckRef = useRef(null);
  const watchedSessionUserId = session?.user?.id ?? null;
  const sessionWatched = sessionRevocationWatchApplies({ fixtureClient: demoActive, session });
  useEffect(() => {
    if (!sessionWatched || !watchedSessionUserId) return undefined;
    const watch = watchSessionRevocation({
      getSession: () => sessionRef.current,
      verify: verifyCapturedAppSession,
      onRevoked: (revoked) => endRevokedSessionRef.current(revoked),
    });
    sessionRevocationCheckRef.current = watch.check;
    return () => {
      watch.stop();
      sessionRevocationCheckRef.current = null;
    };
  }, [sessionWatched, watchedSessionUserId]);
  useEffect(() => {
    if (dataError) void sessionRevocationCheckRef.current?.({ defer: true });
  }, [dataError]);
  const loadSessions = useCallback(() => listMemberSessions(supabase), []);
  const revokeSession = useCallback((sessionHandle) => revokeMemberSession(sessionDataClient, sessionHandle), [sessionDataClient]);

  // `activeSession` may be an object captured under a PREVIOUS identity: a slow
  // mutation keeps its own binding alive across a sign-in. Reading the current
  // generation at call time would then stamp the new member's generation onto
  // the old member's fetch and sail through the guard, painting one member's
  // profile, cases and messages into another's shell — and the staff read
  // policies make that fetch succeed rather than fail. So bind to the identity
  // this call is FOR, and re-check it after the await.
  const loaderFor = useCallback((activeSession) => {
    if (memberLoaderRef.current?.userId !== activeSession.user.id) {
      const operation = guardRef.current.captureOperation(activeSession.user.id);
      memberLoaderRef.current = createMemberSessionLoader(supabase, activeSession.user, { isCurrent: operation.isCurrent });
    }
    return memberLoaderRef.current;
  }, []);

  const commitMemberData = useCallback((ticket, nextData, {
    epoch = null,
  } = {}) => {
    if (!nextData) return false;
    if (epoch !== null && projectionEpochRef.current !== epoch) return false;
    if (!guardRef.current.canCommit(ticket)) return;
    const notifications = sortNewestFirst(nextData?.notifications ?? []);
    const taskMessages = sortOldestFirst(nextData?.taskMessages ?? []);
    let committed = {
      ...nextData,
      sampleChapterCatalog: sampleChapterCatalogRef.current,
      notifications,
      taskMessages,
      member: { ...nextData.member, notificationCount: unreadCount(notifications) },
    };
    // A board broadcast can arrive after this request's snapshot but before
    // its response. Replay every such event before this slice commits.
    for (const event of guardRef.current.boardEventsSince(ticket)) {
      committed = applyBoardEvent(committed, event);
    }
    const next = {
      ...committed,
      // A failed history refresh must not erase a successfully saved local
      // exchange when an unrelated route/realtime projection commits.
      ...((guideLocalPendingRef.current || memberLoaderRef.current?.failuresForResources(MEMBER_GUIDE_HISTORY_RESOURCES).length)
        && dataRef.current?.member?.id === committed.member?.id
        ? { guideThreads: dataRef.current.guideThreads } : {}),
    };
    dataRef.current = next;
    setData(next);
    setDataError("");
    setMemberDataCommits((count) => count + 1);
    return true;
  }, []);

  const loadShell = useCallback(async (activeSession = session) => {
    if (!supabase || !activeSession?.user) return;
    const operation = guardRef.current.captureOperation(activeSession.user.id);
    if (!operation.isCurrent()) return;
    const ticket = guardRef.current.beginRequest(activeSession.user.id);
    if (!ticket) return;
    const [nextData, sampleChapterCatalog] = await Promise.all([
      loaderFor(activeSession).loadShell(),
      sampleLive ? loadSampleChapterCatalog(supabase) : Promise.resolve([]),
    ]);
    if (!operation.isCurrent()) return;
    if (!nextData) return;
    sampleChapterCatalogRef.current = sampleChapterCatalog;
    commitMemberData(ticket, nextData);
  }, [commitMemberData, loaderFor, sampleLive, session]);

  const projectRoute = useCallback(async (activeSession, routeView) => {
    const operation = guardRef.current.captureOperation(activeSession.user.id);
    if (!operation.isCurrent()) return;
    const ticket = guardRef.current.beginRequest(activeSession.user.id);
    if (!ticket) return;
    const epoch = ++projectionEpochRef.current;
    const nextData = await loaderFor(activeSession).loadRoute(routeView);
    if (!operation.isCurrent() || viewRef.current !== routeView) return;
    commitMemberData(ticket, nextData, { epoch });
  }, [commitMemberData, loaderFor]);

  // BUG-UG-OPEN-SURVEY-UNREACHABLE-FROM-HOME-AND-PHONE-20261111: Home,
  // Voting and VP count and rank the organization surveys in the member
  // engagement snapshot. A member's answer in Voice and a staff publish, close
  // or reopen in Campaigns change that list, so both drop the cached copy.
  const invalidateEngagementSnapshot = useCallback(() => {
    memberLoaderRef.current?.invalidateResources(["rpc:get_member_engagement_snapshot"]);
  }, []);
  const refresh = useCallback(async (activeSession = sessionRef.current, affectedResources = null, { resetScope = false } = {}) => {
    if (!supabase || !activeSession?.user) return;
    if (guardRef.current.currentUserId !== activeSession.user.id) return;
    if (resetScope) {
      memberLoaderRef.current?.dispose();
      memberLoaderRef.current = null;
      guideLocalPendingRef.current = false;
      projectionEpochRef.current += 1;
      // A scope reset re-reads every member-scoped resource; the held chart
      // is one, so the next palette open fetches it again.
      dropPaletteStructure();
    }
    const loader = loaderFor(activeSession);
    const currentResources = affectedResources ?? loader.resourcesForRoute(viewRef.current);
    // Explicit Retry refreshes its plan; mutation callers supply their own
    // declared resources, bound before the write starts.
    loader.invalidateResources(currentResources);
    try {
      await projectRoute(activeSession, viewRef.current);
      const failures = loader.failuresForResources(currentResources);
      if (failures.length) throw failures[0].failure;
    } finally {
      // Reattach resource readiness notifications to the replacement loader.
      if (resetScope && memberLoaderRef.current === loader) setMemberScopeRevision(value => value + 1);
    }
  }, [dropPaletteStructure, loaderFor, projectRoute]);

  useEffect(() => {
    // BUG-UG-SELF-DELETION-ERROR-BOUNDARY-20261016: passive effects
    // flush after the render that scheduled them, so a departure (account
    // deletion clears sessionRef before setSession(null) renders) can null the
    // ref first. Subscribe only while the ref still names the rendered member;
    // the next render's session change re-runs this effect.
    const activeSession = sessionRef.current;
    if (!session?.user?.id || demoActive || activeSession?.user?.id !== session.user.id) return undefined;
    const loader = loaderFor(activeSession);
    const operation = guardRef.current.captureOperation(session.user.id, sessionGeneration);
    return loader.subscribe(() => { if (operation.isCurrent()) setResourceRevision((value) => value + 1); });
  }, [demoActive, loaderFor, memberScopeRevision, session?.user?.id, sessionGeneration]);

  // Compass is an overlay, not a route. Its history must therefore be loaded
  // independently of the page underneath it, and a successful save must
  // refresh that same slice even when Home/Rights/etc. refresh successfully.
  const loadCompassPrerequisites = useCallback(async ({ force = false } = {}) => {
    const activeSession = sessionRef.current;
    if (!supabase || !activeSession?.user) return null;
    const userId = activeSession.user.id;
    const operation = guardRef.current.captureOperation(userId);
    const loader = loaderFor(activeSession);
    if (force) loader.invalidateResources(MEMBER_GUIDE_RESOURCES);
    const nextData = await loader.loadRoute("voice");
    if (!operation.isCurrent() || !nextData || memberLoaderRef.current !== loader) return null;
    const failed = loader.failuresForResources(MEMBER_GUIDE_HISTORY_RESOURCES);
    if (failed.length) throw failed[0].failure;
    guideLocalPendingRef.current = false;
    setData((current) => {
      if (!current || current.member?.id !== userId) return current;
      return {
        ...current,
        guideThreads: nextData.guideThreads,
        weeklyQuestions: nextData.weeklyQuestions,
      };
    });
    return nextData;
  }, [loaderFor]);

  // The command palette is global shell UI, so opening it must hydrate the
  // transitive buildSearchIndex inputs without replacing the active route's
  // projection. Repeated opens are transport-cache hits within the session.
  const loadSearchPrerequisites = useCallback(async () => {
    const activeSession = sessionRef.current;
    if (!supabase || !activeSession?.user) return null;
    const userId = activeSession.user.id;
    const operation = guardRef.current.captureOperation(userId);
    const loader = loaderFor(activeSession);
    const resources = memberResourcesForRoute("search");
    loader.retryFailedResources(resources);
    const nextData = await loader.loadRoute("search");
    if (!operation.isCurrent() || !nextData || memberLoaderRef.current !== loader) return null;
    const failed = loader.failuresForResources(resources);
    if (failed.length) throw failed[0].failure;
    // Commit the snapshot before the chart call below: anything published
    // while that call is in flight is newer and must not be overwritten.
    setData((current) => {
      if (!current || current.member?.id !== userId) return current;
      const projection = {};
      for (const key of MEMBER_SEARCH_PROJECTION_KEYS) {
        if (key !== "guideThreads" || !guideLocalPendingRef.current) projection[key] = nextData[key];
      }
      return { ...current, ...projection };
    });
    // Officers on the member's union chart are search data too. SearchView
    // fetches its own copy; the palette has only this snapshot, so it reads
    // the same member-safe projection once per member scope. A failure keeps
    // the local results: the palette's other commands stay correct.
    // Held beside the snapshot, not in it: route loads replace the snapshot.
    const member = nextData.member;
    const held = paletteStructureRef.current;
    const heldInScope = held?.memberId === userId && held.structure.organizationId === member?.organizationId
      && held.structure.chapterId === member?.chapterId;
    if (member?.organizationId && !heldInScope) {
      const structure = await getMemberOrganizationStructure(supabase).catch(() => null);
      if (!operation.isCurrent() || memberLoaderRef.current !== loader) return null;
      if (structure) {
        paletteStructureRef.current = { memberId: userId, structure };
        setPaletteStructure(paletteStructureRef.current);
      }
    }
    return nextData;
  }, [loaderFor]);

  const loadShellRef = useRef(loadShell);
  loadShellRef.current = loadShell;

  // The realtime effect must not list `refresh` as a dependency: refresh is
  // rebuilt on every session object identity change (including hourly token
  // refreshes), which would tear down and rebuild the channel each time.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Message UPDATEs are deliberately absent from the INSERT-only publication.
  // Revalidate active readers and returning devices through their RLS loader.
  useEffect(() => {
    if (!session?.user?.id || fixtureDemo || !["messages", "steward"].includes(view)) return undefined;
    const reconcile = () => {
      if (document.visibilityState === "visible") void refreshRef.current().catch(() => {});
    };
    const timer = window.setInterval(reconcile, 30000);
    window.addEventListener("focus", reconcile);
    window.addEventListener("online", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", reconcile);
      window.removeEventListener("online", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
    };
  }, [session?.user?.id, fixtureDemo, view]);

  // A successful MFA verify can replace the session token (aal1 -> aal2).
  // Read that fresh session before reloading member data; using the render's
  // captured token can race the auth listener and hit the assurance boundary
  // with the now-stale aal1 credential.
  const handleMfaStandingChanged = useCallback(async () => {
    const expectedSession = session;
    if (!sameAuthSessionLineage(sessionRef.current, expectedSession)) return;
    const expectedRevision = authRevisionRef.current;
    const operation = guardRef.current.captureOperation();
    const { data: authData, error } = await supabase.auth.getSession();
    if (!operation.isCurrent()) return;
    if (error) throw error;
    if (!authData.session?.user) return;
    if (authRevisionRef.current !== expectedRevision
      || !sameAuthSessionLineage(sessionRef.current, expectedSession)
      || !sameAuthSessionLineage(authData.session, expectedSession)) return;
    sessionRef.current = authData.session;
    setSession(authData.session);
    await refreshRef.current(authData.session);
  }, [session]);

  // Same pattern, same reason, for the outbox-replay effect: `tr` is rebuilt on
  // every language change but is used there only to WORD two toasts. Listing it
  // as a dependency made switching language tear down and re-run a whole replay
  // pass — another replayQueue round trip, and a full member reload whenever the
  // saved copy was stale — for a change that alters nothing about the queue.
  const trRef = useRef(tr);
  trRef.current = tr;

  useEffect(() => {
    if (!hasAppBackend || demoActive) return undefined;
    if (appAuthStorageUnavailable) {
      setAuthRestorePending(false);
      setLoading(false);
      return undefined;
    }
    let mounted = true;
    let initialSessionSettled = false;
    const restoreRevision = authRevisionRef.current;
    const restoreOperation = guardRef.current.captureOperation();
    // Refuse a non-persona session on the retired preview host: React state
    // is torn down first, so a storage failure can never strand the loading
    // screen; then the session is retired the way an explicit sign-out
    // retires one (server push teardown and revocation bound to the refused
    // bearer, then the lineage compare-and-swap clear, or the exact-tuple
    // removal for a token with no lineage to fence, never the mutable client
    // sign-out that reads whatever session occupies storage by then),
    // and the same device-residue cleanup a departed session gets runs for
    // its account, lineage-aware so a newer login's data survives. The
    // storage work runs inside promise callbacks, so a synchronous throw is
    // caught there.
    const refuseRetiredHostSession = (refused) => {
      sessionRef.current = null;
      beginSessionGeneration(null);
      setSession(null);
      setAuthRestorePending(false);
      setLoading(false);
      const refusedGeneration = guardRef.current.generation;
      void retireRefusedSession(refused, {
        prepareSignOut: (captured) => prepareMemberSignOut(createCapturedAppSessionRpcClient(captured), "local", captured.user?.id),
        revokeToken: (accessToken) => supabase.auth.admin.signOut(accessToken, "local"),
        clearLocally: (captured) => clearRefusedAppSessionLocally(captured, { explicitSignOut: true }),
        afterCleared: () => {
          return forgetDepartedMemberDevice(outboxStoreRef.current, refused.user?.id ?? null, {
            sessionGeneration: refusedGeneration,
            sessionLineage: sessionIDFromAccessToken(refused.access_token),
            readActiveSessionLineage: () => appAuthStorageSessionLineage(appAuthStorageKey),
          });
        },
      }).catch(() => undefined);
    };
    supabase.auth.getSession().then(async ({ data: authData, error }) => {
      if (!mounted || !restoreOperation.isCurrent()
        || authRevisionRef.current !== restoreRevision) return;
      initialSessionSettled = true;
      setAuthRestorePending(false);
      if (error) {
        setAuthStorageUnavailable(true);
        setLoading(false);
        // The boot the residue record is actually about: the stored refresh
        // token was expired or revoked, auth-js emptied the auth slot on its
        // way out, and this error is all that is left of a member who is gone.
        // Nobody can be signed in on an empty slot, so the device is cleaned
        // even though the recovery screen is what the visitor sees. An
        // unreadable slot answers "cannot tell" and is left alone: that member
        // may still be signed in, and their offline work is not ours to burn.
        if (appAuthStorageSlotIsEmpty(appAuthStorageKey)) {
          void forgetDepartedMemberDevice(outboxStoreRef.current, null, {
            allOwners: true,
            sessionGeneration: guardRef.current.generation,
            readActiveSessionLineage: () => appAuthStorageSessionLineage(appAuthStorageKey),
          });
        }
        return;
      }
      // The retired preview host adopts only a seeded persona. Any other
      // restored session is cleared from this browser and never published,
      // so the retirement screen shows and no session-keyed effect runs
      // (BUG-UG-REMOVE-RETIRED-PREVIEW-INVITATION-20261020).
      if (demo && retiredHostRefusesSession(authData.session, window.location.hostname)) {
        refuseRetiredHostSession(authData.session);
        return;
      }
      sessionRef.current = authData.session;
      beginSessionGeneration(authData.session?.user?.id ?? null);
      setSession(authData.session);
      if (!authData.session) setLoading(false);
      // A readable auth store gives the sweep an authoritative active lineage,
      // including on a successful restore. Remove residue from sessions that
      // departed while the app was closed, while the lineage predicate keeps
      // the restored session's own offline work. Publish the current identity
      // first so a racing login is protected by both lineage and generation.
      void forgetDepartedMemberDevice(outboxStoreRef.current, null, {
        allOwners: true,
        ...(authData.session ? {} : { sessionGeneration: guardRef.current.generation }),
        readActiveSessionLineage: () => appAuthStorageSessionLineage(appAuthStorageKey),
      });
    }).catch(() => {
      if (!mounted || !restoreOperation.isCurrent()
        || authRevisionRef.current !== restoreRevision) return;
      initialSessionSettled = true;
      setAuthRestorePending(false);
      setAuthStorageUnavailable(true);
      setLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!mounted) return;
      // A late refresh for the deleted identity cannot restore protected data.
      if (nextSession && deletionReceiptRef.current) {
        const nextLineage = sessionIDFromAccessToken(nextSession.access_token);
        const replacementLineage = nextLineage && deletionLineageRef.current
          && nextLineage !== deletionLineageRef.current;
        if (nextSession.user.id === deletionAccountRef.current
          && (!deletionReceiptRef.current.uncertain || !replacementLineage)) return;
        deletionReceiptRef.current = null;
        deletionSessionRef.current = null;
        deletionAccountRef.current = null;
        deletionLineageRef.current = null;
        deletionCleanupRef.current = null;
        setDeletionOutcome(null);
        setDeletionHold(false);
      }
      // Auth-js converts an initial storage read failure into
      // INITIAL_SESSION/null. Wait for the explicit getSession result so that
      // failure reaches the recovery screen instead of the signed-out door.
      if (event === "INITIAL_SESSION" && !nextSession && !initialSessionSettled) return;
      authRevisionRef.current += 1;
      if (nextSession && appAuthSessionIsClosed(nextSession)) {
        // Auth-js forwards cross-tab BroadcastChannel payloads directly to
        // listeners. A refresh queued before another tab's exact sign-out can
        // therefore arrive after the durable tombstone. Never republish that
        // closed lineage; preserve a distinct newer login if one is current.
        const current = sessionRef.current;
        if (!current || sameAuthSessionLineage(current, nextSession)) {
          void forgetDepartedMemberDevice(
            outboxStoreRef.current,
            current?.user?.id ?? nextSession?.user?.id ?? null,
            {
              sessionGeneration: guardRef.current.generation,
              sessionLineage: sessionIDFromAccessToken((current || nextSession)?.access_token),
              readActiveSessionLineage: () => appAuthStorageSessionLineage(appAuthStorageKey),
            },
          );
          departedSessionIDRef.current = sessionIDFromAccessToken((current || nextSession)?.access_token);
          sessionRef.current = null;
          beginSessionGeneration(null);
          setSession(null);
          setAuthRestorePending(false);
          setLoading(false);
          void supabase.realtime.setAuth();
        }
        return;
      }
      // Same refusal for a session that arrives through the listener (a late
      // INITIAL_SESSION, a refresh, a cross-tab login) on the retired host.
      if (nextSession && demo && retiredHostRefusesSession(nextSession, window.location.hostname)) {
        refuseRetiredHostSession(nextSession);
        return;
      }
      // Publish synchronously. React's state effect runs later, leaving a gap
      // where a sign-out callback could otherwise mistake A for current after
      // Supabase had already persisted B.
      const previousSession = sessionRef.current;
      if (!nextSession && previousSession) departedSessionIDRef.current = sessionIDFromAccessToken(previousSession.access_token);
      const newSignIn = event === "SIGNED_IN" && Boolean(previousSession && nextSession)
        && previousSession.user.id === nextSession.user.id
        && previousSession.access_token !== nextSession.access_token
        && !sameAuthSessionLineage(previousSession, nextSession);
      // A token refresh and a repeat notification of the same login keep the
      // same lineage; a real departure includes a distinct same-user login.
      if (previousSession?.user?.id
        && (previousSession.user.id !== nextSession?.user?.id || newSignIn)) {
        void forgetDepartedMemberDevice(outboxStoreRef.current, previousSession.user.id, {
          sessionGeneration: guardRef.current.generation,
          sessionLineage: sessionIDFromAccessToken(previousSession.access_token),
          readActiveSessionLineage: () => appAuthStorageSessionLineage(appAuthStorageKey),
        });
      }
      // Union Ground: the same member's token dropping from aal2 to aal1 (a
      // factor removed on another device, a downgraded refresh) closes the
      // shell in THIS batch and drops every cached read. The assurance effect
      // runs after paint, which is too late for a downgrade: the old aal2 data
      // would stay on screen for a session RLS no longer admits to it.
      if (isAssuranceDowngrade(previousSession, nextSession)) {
        setMfaRequired(null);
        guardRef.current.invalidateSecurityContext(nextSession.user.id);
        clearSessionScopedStateRef.current();
      }
      sessionRef.current = nextSession;
      // A distinct login by the same user gets a new generation too. Ordinary
      // token refreshes and repeated notifications of the same login retain it.
      beginSessionGeneration(nextSession?.user?.id ?? null, { newSignIn });
      setSession(nextSession);
      setAuthRestorePending(false);
      if (!nextSession) setLoading(false);
    });
    const onStorage = (event) => {
      const current = sessionRef.current;
      const departed = sessionIDFromAccessToken(current?.access_token) || departedSessionIDRef.current;
      const explicit = storageEventExplicitlySignsOutSession(event, appAuthStorageKey, departed);
      // A late signal must never erase a newer login, including one persisted
      // before its auth callback reaches this tab. Unreadable storage is not
      // proof of closure. The publisher commits the fence before the signal.
      if (explicit && appAuthStorageSessionLineage(appAuthStorageKey) !== null) return;
      if (!appAuthStorageKey
        || (!explicit && !storageEventClosesAuthSession(event, appAuthStorageKey, current))) return;
      if (!current) {
        if (explicit) {
          // A pending restore must not revive the session after this signal.
          authRevisionRef.current += 1;
          setAuthRestorePending(false);
          setLoading(false);
          landSignedOutAtRoot();
        }
        return;
      }
      authRevisionRef.current += 1;
      void forgetDepartedMemberDevice(outboxStoreRef.current, current?.user?.id ?? null, {
        sessionGeneration: guardRef.current.generation,
        sessionLineage: sessionIDFromAccessToken(current?.access_token),
        readActiveSessionLineage: () => appAuthStorageSessionLineage(appAuthStorageKey),
      });
      departedSessionIDRef.current = sessionIDFromAccessToken(current?.access_token);
      sessionRef.current = null;
      beginSessionGeneration(null);
      setSession(null);
      setAuthRestorePending(false);
      setLoading(false);
      if (explicit) landSignedOutAtRoot();
      void supabase.realtime.setAuth();
    };
    globalThis.addEventListener?.("storage", onStorage);
    return () => {
      mounted = false;
      globalThis.removeEventListener?.("storage", onStorage);
      listener.subscription.unsubscribe();
    };
  }, [beginSessionGeneration, demoActive, landSignedOutAtRoot]);

  // Retain a restored account's current hat; a signed-out visit never mints
  // a replacement shared session. It lands on the sign-in screen
  // (BUG-UG-DEMO-HOST-SIGNED-OUT-DEAD-END-20261106), so no
  // retirement error is staged for the next account to inherit.
  useEffect(() => {
    if (!sampleLive || deletionHold || authRestorePending) return;
    if (!session) {
      setLoading(false);
      return;
    }
    if (sampleHatTransitioning) return;
    const restored = samplePersonas().find((persona) => persona.email === session.user?.email);
    if (restored && restored.hat !== selectedStaffHatRef.current) setSelectedStaffHat(restored.hat);
  }, [sampleLive, session, sampleHatTransitioning, deletionHold, setSelectedStaffHat, authRestorePending]);

  useEffect(() => {
    // The SAMPLE origin reports as demo context too: seeded persona ids are
    // fictional and telemetry must never read them as member activity.
    // On the public site members are counted only under one-way hashes of
    // these identifiers; public page views wait for session restore.
    syncObservabilityContext({
      demoActive: demoActive || demo,
      userId: demoActive || demo ? null : session?.user?.id,
      organizationId: demoActive || demo ? null : data?.member?.organizationId,
      authPending: authRestorePending,
      view,
    });
  }, [demo, demoActive, session?.user?.id, data?.member?.organizationId, authRestorePending, view]);

  // Saved copies are no longer written or painted. Remove what an older build
  // left on this device: the session-storage Home slice and this member's
  // IndexedDB snapshot. Best-effort; nothing reads either one.
  useEffect(() => {
    if (authRestorePending) return;
    clearMemberHomeSlice();
    const userId = session?.user?.id ?? null;
    if (userId && outboxStoreRef.current) deleteSnapshot(outboxStoreRef.current, userId).catch(() => {});
  }, [authRestorePending, session?.user?.id]);

  // Boot load for a signed-in member. It must fire on a change of IDENTITY and
  // on nothing else.
  //
  // It used to depend on `refresh`, which is rebuilt on every session object
  // identity change — including the token refresh supabase-js performs roughly
  // hourly. So once an hour this effect re-ran: setLoading(true) replaced the
  // whole rendered tree with the loading screen and loadMemberApp re-issued its
  // ~30 queries. Everything below App unmounted, and everything the member had
  // typed but not yet saved went with it — a half-written case note, a form
  // wizard's answers, a Compass draft, the bargaining writer's evidence. The
  // realtime effect below already carried exactly this warning; this one had
  // simply never been given the same treatment.
  //
  // refreshRef always holds the newest closure, so reading it here loses
  // nothing, and setLoading is gated on there being nothing painted yet so that
  // any future re-entry cannot blank a shell the member is already using.
  useEffect(() => {
    if (!session?.user || demoActive) return;
    const userId = session.user.id;
    const operation = guardRef.current.captureOperation(userId);
    if (!operation.isCurrent()) return;
    // A boot load that started before the two-step check was answered runs
    // at aal1 and fails; once the check clears, the post-challenge refresh owns
    // the outcome, so that stale failure must not paint the data-error screen.
    const challengeAtStart = mfaClearedRef.current;
    const superseded = () => mfaClearedRef.current !== challengeAtStart;
    setLoading(true);
    // UB-UG-DEMO-HAT-SWITCH-FASTER-ONE-WAIT-20261107: a SAMPLE hat
    // switch already knows its destination, so the destination's reads start
    // with the shell's instead of after it. The loader shares in-flight reads,
    // so the route projection that follows joins them; ordinary sign-ins keep
    // the shell-first order.
    if (sampleLive && sampleHatTransitioningRef.current) {
      loaderFor(session).loadRoute(viewRef.current).catch(() => {});
    }
    loadShellRef.current(session)
      .catch((error) => {
        // A failed boot shows the unavailable-data screen, never a saved copy:
        // a stored payload may belong to a chapter the member has since left
        // (BUG-UG-WEB-HOME-REPAINTS-PREVIOUS-CHAPTER-AFTER-SWITCH-20261111).
        // The reconnect path and the boot retries below load fresh data.
        if (!operation.isCurrent() || superseded()) return;
        setDataError(translatedShellLoadError(error, trRef.current));
      })
      .finally(() => {
        if (!operation.isCurrent()) return;
        // This operation still owns its loading flag after MFA clears. Only
        // its stale failure is superseded by the post-challenge refresh.
        setLoading(false);
        if (!dataRef.current && !superseded()) setDataError((current) => current || trRef.current("app.viewLoadFailedBody"));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on member identity, not the session object: a token refresh must not re-run the boot load and blank the screen.
  }, [session?.user?.id, demoActive, sessionGeneration]);

  // BUG-UG-LANDING-MEMBER-DATA-LOAD-FAILED-20261003. A boot load that
  // failed on a busy server left the member on "Member data is unavailable"
  // until they pressed Try again at the right moment or signed out and in.
  // While that card is up the app now retries on its own a few times, spaced
  // out, so the page recovers without a new sign-in once the server answers.
  const [bootRetry, setBootRetry] = useState({ attempt: 0, tick: 0 });
  useEffect(() => {
    if (data) {
      setBootRetry((current) => (current.attempt ? { attempt: 0, tick: current.tick } : current));
      return undefined;
    }
    if (!dataError || !session?.user?.id || demoActive) return undefined;
    // Offline attempts cannot succeed; keep the budget and resume on reconnect.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      const resume = () => setBootRetry((current) => ({ ...current, tick: current.tick + 1 }));
      window.addEventListener("online", resume);
      return () => window.removeEventListener("online", resume);
    }
    const delay = BOOT_RETRY_DELAYS_MS[bootRetry.attempt];
    if (delay === undefined) return undefined;
    const timer = setTimeout(() => {
      setBootRetry((current) => ({ ...current, attempt: current.attempt + 1 }));
      // Arm the next attempt whether this one failed or settled without data.
      refresh().catch(() => {}).finally(() => setBootRetry((current) => ({ ...current, tick: current.tick + 1 })));
    }, delay);
    return () => clearTimeout(timer);
  }, [bootRetry.attempt, bootRetry.tick, data, dataError, demoActive, refresh, session?.user?.id]);
  //  (W2-5): Try again on that card shows it is working, and a try that
  // still finds no data says so with its count, so a repeat failure reads as new.
  const [bootManualRetry, setBootManualRetry] = useState({ pending: false, failures: 0 });
  function retryBootLoad() {
    // A try that outlives a sign-in change writes nothing on the next one's card.
    const operation = guardRef.current.captureOperation();
    setBootManualRetry((current) => ({ ...current, pending: true }));
    const settle = () => { if (operation.isCurrent()) setBootManualRetry((current) => ({ pending: false, failures: dataRef.current ? 0 : current.failures + 1 })); };
    refresh().then(settle, (error) => {
      if (operation.isCurrent() && !dataRef.current) setDataError(translatedShellLoadError(error, trRef.current));
      settle();
    });
  }
  // Every identity or new sign-in starts with the full retry budget.
  useEffect(() => {
    setBootRetry((current) => (current.attempt ? { attempt: 0, tick: current.tick } : current));
    setBootManualRetry({ pending: false, failures: 0 });
  }, [session?.user?.id, sessionGeneration]);

  useEffect(() => {
    if (!session?.user?.id || demoActive || data?.member?.id !== session?.user?.id) return;
    projectRoute(sessionRef.current, view).catch(() => {
      // Resource errors are settled in the registry and rendered by the
      // derived route state. A render/projection never retries them.
    });
  }, [data?.member?.id, demoActive, projectRoute, resourceRevision, session?.user?.id, view]);

  // A new open is one explicit recovery attempt. Registry revisions below
  // project settled data/errors but never invalidate failed resources.
  useEffect(() => {
    const activeSession = sessionRef.current;
    if (assistantOpen && !sessionRestricted && !demoActive && session?.user?.id
      && activeSession?.user?.id === session.user.id) {
      loaderFor(activeSession).retryFailedResources(MEMBER_GUIDE_RESOURCES);
    }
  }, [assistantOpen, demoActive, loaderFor, session?.user?.id]);

  useEffect(() => {
    if (!assistantOpen || demoActive || !session?.user?.id || data?.member?.id !== session?.user?.id) return;
    loadCompassPrerequisites().catch(() => {
      // The overlay shares the resource registry: errors remain settled, and
      // successful mutations/realtime invalidations reschedule it while open.
    });
  }, [assistantOpen, data?.member?.id, demoActive, loadCompassPrerequisites, resourceRevision, session?.user?.id]);

  useEffect(() => {
    if (!sampleLive || !sampleHatTransitioning || loading) return;
    const desiredEmail = sampleHatDesiredEmailRef.current;
    if (sampleHatSettledSequence !== sampleHatDesiredSequenceRef.current) return;
    if (!desiredEmail || session?.user?.email !== desiredEmail) return;
    // Keep the independent transition gate raised until this exact account's
    // data has replaced the previous persona's rows. A load failure may clear
    // the gate too, so the existing translated error screen remains reachable.
    if (!dataError && data?.member?.id !== session.user.id) return;
    sampleHatDesiredEmailRef.current = null;
    sampleHatTransitioningRef.current = false;
    setSampleHatTransitioning(false);
  }, [data?.member?.id, dataError, loading, sampleHatSettledSequence, sampleHatTransitioning, sampleLive, session?.user?.email, session?.user?.id]);

  // The switch unmounts every hat control; once the page it opened has drawn
  // (an AfterPageCommit beside it calls this), focus the new workspace. An
  // effect on the loading gates ran too early and never again . No
  // scroll keeps the demo bar in view .
  const restoreSampleHatFocus = useCallback(() => {
    setSampleHatFocusView(null);
    focusWhenAvailable(() => document.getElementById("main-content"), undefined, { preventScroll: true });
  }, []);

  // Connection state drives the offline banner and gates outbox replay.
  useEffect(() => {
    const onOnline = () => setOffline(false);
    const onOffline = () => setOffline(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  // Outbox replay (PR8). Runs when a signed-in, MFA-cleared session is (back)
  // online: replays this member's queued writes oldest-first, then does ONE
  // refresh — not one per write — and reports what synced or terminally
  // failed. Identity is re-checked against the session guard before anything
  // is committed or toasted, so writes queued by a previous member can never
  // replay into (or toast at) a different member's session; their entries
  // stay stored until their owner signs back in.
  const replayBusyRef = useRef(false);
  // Deterministic re-arm. React bails out of same-value setPendingSync calls,
  // and on a link where fetches fail while navigator.onLine stays true no
  // 'online' event will ever arrive — so a halted pass (or one skipped while
  // busy) schedules its own retry instead of hoping a dependency changes.
  const [replayTick, setReplayTick] = useState(0);
  const hasData = Boolean(data);
  useEffect(() => {
    // The companion embed never replays: the outer instance owns the queue.
    // Two instances share one IndexedDB outbox, and although every kind is
    // idempotent, a concurrent pass in each frame can execute the same entry
    // twice before either deletes it.
    if (embedPhone || demoActive || offline || !hasData || mfaRequired !== false || !session?.user) return undefined;
    let rearmTimer = null;
    let disposed = false;
    const rearm = () => {
      if (rearmTimer || disposed) return;
      rearmTimer = window.setTimeout(() => setReplayTick((tick) => tick + 1), 30000);
    };
    const dispose = () => {
      disposed = true;
      if (rearmTimer) window.clearTimeout(rearmTimer);
    };
    if (replayBusyRef.current) {
      // A pass is in flight; check back after it — an entry enqueued mid-pass
      // must not wait for an unrelated dependency to change.
      rearm();
      return dispose;
    }
    replayBusyRef.current = true;
    const userId = session.user.id;
    const operation = guardRef.current.captureOperation(userId);
    const activeSession = session;
    const stillActing = operation.isCurrent;
    (async () => {
      // stillActing is enforced per entry inside the pass: an identity change
      // mid-round-trip halts without deleting, so nothing executes (or is
      // dropped) under the next member's token.
      const result = await replayQueue(outboxStoreRef.current, userId, outboxExecutors, {
        stillActing,
        activeSessionLineage: sessionIDFromAccessToken(activeSession.access_token),
      });
      if (!stillActing()) return;
      const remaining = await pendingCount(outboxStoreRef.current, userId).catch(() => 0);
      if (!stillActing()) return;
      setPendingSync(remaining);
      if (remaining > 0) rearm();
      if (result.replayed > 0) {
        try { await refreshRef.current(activeSession, memberMutationResources("submitEventRsvp", "saveRightsProgress", "markBroadcastRead", "markConversationRead", "markNotificationsRead", "updateMemberSettings", "updateMemberProfile", "saveFormDraft")); } catch { rearm(); /* the refresh receives a bounded recovery attempt */ }
      } else if (result.failed.some((failure) => failure.kind === "formDraft")) {
        // A refused form replay wrote nothing; Your forms is read again so the
        // editor opens on what is stored now .
        try { await refreshRef.current(activeSession, memberMutationResources("saveFormDraft")); } catch { rearm(); /* the refresh receives a bounded recovery attempt */ }
      }
      if (!stillActing()) return;
      // Precedence lives in replayNotice (src/lib/outbox.js), where it can be
      // tested without a session and a render. It reports discarded work ahead
      // of applied work, and never reports `halted` — see the comment there.
      const passNotice = replayNotice(result);
      if (passNotice) setNotice(trRef.current(...passNotice));
    })().catch(() => { /* replay is best-effort; the queue is still intact */ })
      .finally(() => { replayBusyRef.current = false; });
    return dispose;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the session is captured per pass and re-validated by the generation guard; keying on the object would restart replay on every token refresh, and `tr` is read from trRef so a language change does not restart it either.
  }, [demoActive, offline, hasData, mfaRequired, session?.user?.id, pendingSync, replayTick, outboxExecutors]);

  // Compass back-to-close, half one: the sentinel flag. Declared before the
  // popstate listener that consumes it; the pairing effect below owns pushing
  // and unwinding the history entry.
  const compassSentinelRef = useRef(false);
  // Phone: opening a citation closes the takeover, and the next Back
  // reopens Compass on the same conversation .
  const compassResumeRef = useRef(false);
  useEffect(() => {
    const onPopState = () => {
      // Union Ground's fixture demo lives in the ?demo=1 query, so Back or
      // Forward across that boundary changes which world the URL names. Reload
      // into it rather than mixing fixture and live state in one mounted shell.
      if (!testPreview && !embedPhone && demoFromUrl() !== demo) {
        window.location.reload();
        return;
      }
      // Back dismisses whatever App-level dialog is on top; otherwise the
      // ballot, profile, notifications, guide or tour stayed open while the page
      // swapped underneath it, and the next Back press moved history again.
      setActivePlan(null);
      setProfileOpen(false);
      setNotificationsOpen(false);
      setGuideOpen(false);
      setTourOpen(false);
      setSampleHatFocusView(null);
      const path = normalizeAppPath(window.location.pathname);
      // Explicit sign-out ends this visit, including its earlier SPA entries.
      // Expiry never sets this flag: its requested-page resume stays available.
      if (explicitSignOutRef.current && !sessionRef.current && (path === "/m" || path.startsWith("/m/"))) {
        landSignedOutAtRoot();
        return;
      }
      if (!allowWorkspaceNavigation(window.location.pathname + window.location.search + window.location.hash)) {
        // Like the existing destructive-operation hold below, cancel traversal
        // before React unmounts the editor, restoring its current history entry.
        window.history.pushState({}, "", currentRouteHref.current);
        return;
      }
      const nextView = viewFromPath();
      if (nextView !== "hub" && deviceParityValue("session.destructiveHold") === true) {
        // popstate fires after the browser has already traversed. Restore the
        // held hub as a new current entry before React can unmount it; pushing
        // also replaces the just-abandoned forward branch, so Back can leave
        // normally once the destructive interval resolves.
        const params = new URLSearchParams();
        if (demo) params.set("demo", "1");
        if (embedPhone) params.set("embed", "phone");
        const search = params.toString();
        // Union Ground's bare /m/organize is the Organize plane; the hub
        // (campaign workspace) is its first tab.
        window.history.pushState({}, "", `/m/organize/organize${search ? `?${search}` : ""}`);
        return;
      }
      const currentData = dataRef.current;
      let currentHat = selectedStaffHatRef.current;
      // Back or Forward onto a plane the account holds is its entrance, the
      // same owner ruling (2026-09-25) the gate effect applies to a direct
      // open: wear that hat instead of refusing it under the Member hat.
      if (currentData && !currentData.rolesUnknown && !demo && currentHat === "member") {
        const roleDesk = STAFF_PLANES.find((plane) => plane.view === nextView && holdsHat(currentData.roles || [], plane.key));
        if (roleDesk) {
          selectedStaffHatRef.current = roleDesk.key;
          setSelectedStaffHat(roleDesk.key);
          currentHat = roleDesk.key;
        }
      }
      if (
        currentData
        && !currentData.rolesUnknown
        && !explicitHatAllowsView(currentHat, nextView, fixtureDemo, currentData.roles || [], !railShell, window.location.pathname + window.location.search)
      ) {
        const staffHatAuthorized = currentHat !== "member"
          && (fixtureDemo || (currentData.roles || []).includes(currentHat));
        const selectedPlane = staffHatAuthorized
          ? STAFF_PLANES.find((plane) => plane.key === currentHat)
          : null;
        const targetView = selectedPlane?.view ?? "today";
        const targetPath = selectedPlane?.path ?? "/m";
        const refusedPath = window.location.pathname;
        const refusedDesk = deskForRefusedRoute(nextView, currentData.roles || [], fixtureDemo, refusedPath);
        pendingDeskRouteRef.current = refusedDesk && nextView !== "today"
          ? { hat: refusedDesk, view: nextView, href: refusedPath + window.location.search + window.location.hash, at: Date.now() }
          : null;
        window.history.replaceState({}, "", refusedRouteHref(targetPath, demo));
        clearDemoChapterSelection(false);
        const staffFallbackNotice = staffDeepLinkFallbackNoticeRef.current;
        staffDeepLinkFallbackNoticeRef.current = false;
        if (shouldAnnounceHatRouteRefusal(nextView)) {
          const refusedNotice = hatRouteRefusedNotice(trRef.current, currentHat, targetPath, staffFallbackNotice, railShell, { view: nextView, roles: currentData.roles || [], demo, path: refusedPath });
          if (refusedNotice) {
            if (demo) setNotice(refusedNotice);
            else setHatRouteRefusal({ path: targetPath, hat: staffHatAuthorized ? currentHat : "member", userId: currentData.member?.id, organizationId: currentData.member?.organizationId, refused: { view: nextView, demo, path: refusedPath, roles: currentData.roles || [] } });
          }
        }
        setView(targetView);        setRouteLocation(window.location.pathname + window.location.search + window.location.hash);
        setSearchFocus(null);
        const companion = companionRef.current?.contentWindow;
        if (companion) companion.postMessage({ type: "sg-nav", path: targetPath }, window.location.origin);
        return;
      }
      // A back gesture with the Compass sheet up closes the sheet — the pop
      // consumed the sentinel entry the sheet pushed on open. The view sync
      // below still runs: in the clean case the sentinel duplicated the
      // current URL so setView is a no-op, but if something navigated while
      // the sheet was open (demo hat switch, a header action), the pop lands
      // on the pre-navigation URL and the view must follow it — an early
      // return here would strand the view on the newer screen while the URL
      // shows the older one.
      if (compassResumeRef.current && !compassSentinelRef.current) {
        compassResumeRef.current = false;
        setAssistantOpen(true);
      } else if (compassSentinelRef.current) {
        compassSentinelRef.current = false;
        setAssistantOpen(false);
        setAssistantDraft("");
      }
      clearDemoChapterSelection(false);
      setView(nextView);      setRouteLocation(window.location.pathname + window.location.search + window.location.hash);
      // Back/forward must not re-consume a search deep-link: without this, a
      // Forward return to the target view remounts it with the old payload
      // and re-opens the item (and re-fires its mark-read).
      setSearchFocus(null);
      // Back/forward moves the companion phone too — the mirror otherwise
      // covers only explicit navigate() calls, and a back gesture would
      // strand the phone on the abandoned screen. (Null ref inside the embed
      // and on narrow shells, where there is no companion to move.)
      const companion = companionRef.current?.contentWindow;
      if (companion) companion.postMessage({ type: "sg-nav", path: window.location.pathname + window.location.search + window.location.hash }, window.location.origin);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [clearDemoChapterSelection, demo, fixtureDemo, embedPhone, landSignedOutAtRoot, railShell, setAssistantDraft, setAssistantOpen, setNotice, setSearchFocus, setSelectedStaffHat]);

  // Compass back-to-close, half two: on phone-sized screens the sheet owns
  // the whole viewport, so opening it pushes one history sentinel; the
  // popstate branch above turns the next back gesture into "close the sheet".
  // Closing through the sheet's own controls MARKS the sentinel spent with
  // replaceState instead of consuming it with history.back(): back() is
  // asynchronous, and its queued traversal can rewind a navigation (or, in
  // tests, the next mounted app) that raced in behind it. A spent sentinel
  // costs one inert back press later — same URL, same view — and is reused
  // by the next open, so entries never accumulate. Rail shells skip all of
  // it: the Compass panel sits beside the page there, and in-page navigation
  // while it stays open would strand a sentinel mid-stack.
  useEffect(() => {
    // The embed skips the sentinel entirely: an iframe's pushState lands in
    // the TOP-LEVEL browser history, so a framed phone Compass would turn
    // the outer page's back button into "close the phone's sheet".
    if (assistantOpen && !compassSentinelRef.current && !railShell && !embedPhone) {
      compassSentinelRef.current = true;
      if (window.history.state?.sgCompassSpent) {
        window.history.replaceState({ sgCompass: true }, "", window.location.href);
      } else if (!window.history.state?.sgCompass) {
        window.history.pushState({ sgCompass: true }, "", window.location.href);
      }
    }
    if (!assistantOpen && compassSentinelRef.current) {
      compassSentinelRef.current = false;
      if (window.history.state?.sgCompass) {
        window.history.replaceState({ sgCompassSpent: true }, "", window.location.href);
      }
    }
  }, [assistantOpen, railShell, embedPhone]);

  // Embedded companion: follow the outer desktop shell's navigation — every
  // routed screen, staff planes and the Tasks tool included, so the phone
  // always shows how the CURRENT page renders at phone width (the owner's
  // 2026-07-31 call; the old member-only mirror left the phone frozen on a
  // stale screen whenever the desktop went staff-side). The staff-tool gate
  // still applies inside this instance — it shares the outer session's roles,
  // and a role-less member mirrors to /m instead. Same-origin messages only.
  // The query is stripped before lookup (staff paths travel with ?demo=1) and
  // this instance's own search is re-appended, preserving ?embed=phone(&demo=1)
  // so a session restore reloads it as the companion. replaceState, never
  // pushState: an iframe's pushState lands in the top-level browser history,
  // and each mirrored hop would add a back-button entry that rewinds the phone
  // instead of the page. On mount the embed announces itself, and the outer
  // shell replays the current path — mirrors sent while the embed's chunks
  // were still loading would otherwise be dropped.
  useEffect(() => {
    if (!embedPhone) return undefined;
    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      // Only the outer shell may steer this instance: same origin is
      // necessary but not sufficient — any same-origin sibling frame could
      // post, and the parent is the one window the embed belongs to.
      if (event.source !== window.parent) return;
      if (event.data?.type === "sg-ui-state") {
        // Navigation messages from the same parent are delivered in order,
        // but React does not have to commit the parity state between those
        // message tasks. Keep the synchronous route guard on the acknowledged
        // hat before a following sg-nav is evaluated.
        if (event.data.key === "app.selectedStaffHat" && typeof event.data.value === "string") {
          selectedStaffHatRef.current = event.data.value;
        }
        applyDeviceParityState(event.data.key, event.data.value);
        return;
      }
      if (event.data?.type === "sg-ui-snapshot") {
        const selectedHatEntry = Array.isArray(event.data.entries)
          ? event.data.entries.find((entry) => entry?.key === "app.selectedStaffHat" && typeof entry.value === "string")
          : null;
        if (selectedHatEntry) selectedStaffHatRef.current = selectedHatEntry.value;
        applyDeviceParitySnapshot(event.data.entries);
        return;
      }
      if (event.data?.type === PEER_CONTACT_DOWN) {
        const peerContact = sanitizePeerContactProjection(event.data.peerContact);
        if (!peerContact) return;
        setData((current) => current ? { ...current, peerContact } : current);
        applyDeviceParityState("messages.peerWorkspace", peerContact);
        return;
      }
      if (event.data?.type === "sg-demo-data") {
        // Fixture slices may only ever replace fixture state: a real session
        // (production or SAMPLE-live) ignores board slices outright,
        // whatever document the frame now hosts.
        if (!fixtureDemo) return;
        const slice = event.data.slice;
        if (!slice || typeof slice !== "object") return;
        setData((current) => {
          if (!current) {
            // The fixture chunk has not landed yet; the boot .then merges this.
            pendingDemoSliceRef.current = slice;
            return current;
          }
          // The signature must be of the MERGED board — that is what the
          // broadcaster will hash — so it is recorded here, where the merge
          // result exists. Idempotent under StrictMode double-invoke.
          const next = mergeDemoSlice(current, slice);
          demoSliceSigRef.current = JSON.stringify(demoBoardSlice(next));
          return next;
        });
        return;
      }
      const raw = event.data && event.data.type === "sg-nav" ? event.data.path : null;
      if (typeof raw !== "string") return;
      const target = workspaceRouteWithTransport(raw, { demo, embedPhone });
      if (!target) return;
      const path = target.split(/[?#]/)[0];
      const nextView = pathViews[path] ?? staffToolByPath[path];
      if (!nextView) return;
      if (!mirrorAllowsStaff(nextView, demo, mirrorRolesRef.current)) return;
      if (!explicitHatAllowsView(selectedStaffHatRef.current, nextView, fixtureDemo, dataRef.current?.roles || [], !railShell, target)) return;
      if (destructiveHoldPinsHub(nextView)) return;
      window.history.replaceState({}, "", target);
      clearDemoChapterSelection(false);
      setView(nextView);      setRouteLocation(window.location.pathname + window.location.search + window.location.hash);
      setSearchFocus(null);
      window.scrollTo({ top: 0, behavior: "instant" });
    };
    window.addEventListener("message", onMessage);
    const stopParityMirror = subscribeDeviceParityChanges(({ key, value }) => {
      if (window.parent === window) return;
      try {
        window.parent.postMessage({ type: "sg-ui-state-up", key, value }, window.location.origin);
      } catch {
        // Only structured-clone-safe UI selections participate in parity.
      }
    });
    return () => {
      window.removeEventListener("message", onMessage);
      stopParityMirror();
    };
  }, [clearDemoChapterSelection, embedPhone, demo, fixtureDemo, railShell, setSearchFocus]);

  // Attach the listener for the entire embed lifetime, including degraded
  // role refreshes. Only the READY announcement waits for a settled role
  // projection: tearing down the listener when roles became unknown left the
  // parent believing a now-deaf companion was still ready.
  useEffect(() => {
    if (!embedPhone || !companionAuthorizationReady || window.parent === window) return;
    window.parent.postMessage({ type: "sg-embed-ready" }, window.location.origin);
  }, [companionAuthorizationReady, embedPhone]);

  // Outer half of the ready handshake, plus the reverse mirror: when the
  // companion finishes booting, hand it the path the desktop plane is already
  // on; when a tap INSIDE the companion navigates, follow it out here so the
  // desktop pane moves with the phone. Both halves accept messages only from
  // the companion iframe itself (same origin is necessary but not sufficient —
  // any same-origin frame could post). The applied path is rebuilt from the
  // route table, never trusted verbatim, and staff routes re-attach ?demo=1 in
  // demo so a restore on a staff path reboots into the demo. Applying directly
  // (history + setView) rather than through navigate() is what breaks the
  // echo: navigate() would post the same hop straight back down.
  useEffect(() => {
    if (embedPhone) return undefined;
    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== companionRef.current?.contentWindow) return;
      if (event.data?.type === "sg-embed-ready") {
        // Identity precedes destination. A companion boots as Member at /m;
        // give it the explicit selected hat before asking it to accept a staff
        // route, otherwise its synchronous route guard correctly rejects the
        // route and leaves the paired phone stranded on Member Home.
        event.source.postMessage({ type: "sg-ui-snapshot", entries: deviceParitySnapshot() }, window.location.origin);
        event.source.postMessage({ type: "sg-nav", path: window.location.pathname + window.location.search + window.location.hash }, window.location.origin);
        const peerContact = peerContactDataRef.current;
        if (peerContact) event.source.postMessage({ type: PEER_CONTACT_DOWN, peerContact }, window.location.origin);
        // A phone booting into an already-mutated fixture board catches up here.
        if (fixtureDemo && demoDataRef.current) event.source.postMessage({ type: "sg-demo-data", slice: demoBoardSlice(demoDataRef.current) }, window.location.origin);
        return;
      }
      if (event.data?.type === "sg-demo-data-up") {
        if (!fixtureDemo) return;
        const slice = event.data.slice;
        if (!slice || typeof slice !== "object") return;
        setData((current) => {
          if (!current) return current;
          // Hash the merged board, not the incoming slice — the broadcaster
          // compares against the merge result. Idempotent under StrictMode.
          const next = mergeDemoSlice(current, slice);
          demoSliceSigRef.current = JSON.stringify(demoBoardSlice(next));
          return next;
        });
        return;
      }
      if (event.data?.type === "sg-ui-state-up") {
        // The companion sends the selected-hat parity write immediately
        // before its route. Keep the synchronous guard in step with that
        // acknowledged identity; React may not commit between message tasks.
        if (event.data.key === "app.selectedStaffHat" && typeof event.data.value === "string") {
          selectedStaffHatRef.current = event.data.value;
        }
        applyDeviceParityState(event.data.key, event.data.value);
        return;
      }
      if (event.data?.type === PEER_CONTACT_UP) {
        const peerContact = sanitizePeerContactProjection(event.data.peerContact);
        if (!peerContact) return;
        setData((current) => current ? { ...current, peerContact } : current);
        applyDeviceParityState("messages.peerWorkspace", peerContact);
        return;
      }
      if (event.data?.type !== "sg-nav-up") return;
      const raw = event.data.path;
      if (typeof raw !== "string") return;
      const target = workspaceRouteWithTransport(raw, { demo, embedPhone });
      if (!target) return;
      const path = target.split(/[?#]/)[0];
      const nextView = pathViews[path] ?? staffToolByPath[path];
      if (!nextView) return;
      if (!mirrorAllowsStaff(nextView, demo, mirrorRolesRef.current)) return;
      if (!explicitHatAllowsView(selectedStaffHatRef.current, nextView, fixtureDemo, dataRef.current?.roles || [], !railShell, target)) return;
      if (destructiveHoldPinsHub(nextView)) return;
      // Re-tapping the phone tab the pair is already on must not stack
      // identical history entries — Back would turn inert.
      if (window.location.pathname + window.location.search + window.location.hash === target) {
        clearDemoChapterSelection(false);
        return;
      }
      // The same demo rider navigate() applies: a MEMBER tap inside the
      // companion phone must not strip ?demo=1 from the outer URL either
      // (sol F6 on 89660c497) — staff routes carried it, member routes
      // pushed bare, and a copy/reload of the outer tab then left the demo.
      window.history.pushState({}, "", target);
      clearDemoChapterSelection(false);
      setView(nextView);      setRouteLocation(window.location.pathname + window.location.search + window.location.hash);
      setSearchFocus(null);
      setGuideOpen(false);
      window.scrollTo({ top: 0, behavior: "instant" });
    };
    window.addEventListener("message", onMessage);
    const stopParityMirror = subscribeDeviceParityChanges(({ key, value }) => {
      const companion = companionRef.current?.contentWindow;
      if (!companion) return;
      try {
        companion.postMessage({ type: "sg-ui-state", key, value }, window.location.origin);
      } catch {
        // Only structured-clone-safe UI selections participate in parity.
      }
    });
    return () => {
      window.removeEventListener("message", onMessage);
      stopParityMirror();
    };
  }, [clearDemoChapterSelection, embedPhone, demo, fixtureDemo, railShell, setGuideOpen, setSearchFocus]);

  // Demo board DATA rides the same frame bridge as deviceParity: the two
  // instances hold separate React state, so without this a task created on
  // one board never reached the other. Render-path signature (the prototype's
  // _upSig idiom): every applied slice records its signature before setData,
  // so the broadcaster skips exactly the change that just arrived and the
  // pair cannot echo. The first non-null data seeds the signature silently —
  // boot fixtures are identical on both sides and must not broadcast.
  const demoSliceSigRef = useRef(null);
  const pendingDemoSliceRef = useRef(null);
  const demoDataRef = useRef(null);
  useEffect(() => { demoDataRef.current = demoActive ? data : null; }, [demoActive, data]);
  useEffect(() => {
    if (!demoActive || !data) return;
    const sig = JSON.stringify(demoBoardSlice(data));
    if (demoSliceSigRef.current === sig) return;
    const seeding = demoSliceSigRef.current === null;
    demoSliceSigRef.current = sig;
    if (seeding) return;
    const target = embedPhone
      ? (window.parent !== window ? window.parent : null)
      : companionRef.current?.contentWindow;
    if (!target) return;
    try {
      target.postMessage({ type: embedPhone ? "sg-demo-data-up" : "sg-demo-data", slice: demoBoardSlice(data) }, window.location.origin);
    } catch {
      // Only structured-clone-safe demo rows participate.
    }
  }, [demoActive, data, embedPhone]);

  const handlePeerContactChange = useCallback((value) => {
    const peerContact = sanitizePeerContactProjection(value);
    if (!peerContact) return;
    setData((current) => current ? { ...current, peerContact } : current);
    peerContactDataRef.current = peerContact;
    const target = embedPhone
      ? (window.parent !== window ? window.parent : null)
      : companionRef.current?.contentWindow;
    if (!target) return;
    try {
      target.postMessage({ type: embedPhone ? PEER_CONTACT_UP : PEER_CONTACT_DOWN, peerContact }, window.location.origin);
    } catch {
      // The validator guarantees a bounded structured-clone-safe projection.
    }
  }, [embedPhone]);

  // Staff route gate (: work coordination is a
  // staff surface). A demo hat has no real role, so the demo keeps the screen
  // its tour narrates; everyone else needs the right entry in data.roles.
  // Planes and tools share the redirect: plane keys ARE role names, so the
  // plane gate is roles.includes(view), while the tools stay any-of-five —
  // the same answers mirrorAllowsStaff gives the companion mirror. Without
  // the plane half, a role-less member on /m/admin got the member Today
  // screen rendered UNDER the staff URL — URL and content disagreeing on a
  // route whose whole point is that it is not theirs. The redirect REPLACES
  // the history entry deliberately: a member landing on a stale staff link
  // must not be able to press Back into a route that only redirects again.
  const canUseStaffTools = fixtureDemo || (data?.roles || []).some((role) => STAFF_TOOL_ROLES.includes(role));
  const selectedStaffHatAuthorized = selectedStaffHat !== "member"
    && (fixtureDemo || (data?.roles || []).includes(selectedStaffHat));
  // REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP3-20261029: guide 1,
  // "Getting the organization started", read while a real staff hat is worn
  // and the organization's switch is on. The server decides who sees it (an
  // organization-wide role with sign-in requirements met) and every fact.
  const orgStartGuideState = useOrganizationStartGuide({
    client: demoActive ? null : sessionDataClient,
    // Also read for an administrator on Home in the Member hat, so What matters
    // now names unfinished setup with the guide's own count instead of "caught
    // up" (REQ-UG-ADMIN-OVERVIEW-GOALS-AND-ACTIVITY-LOG-20261030).
    enabled: !demoActive && Boolean(session) && (selectedStaffHatAuthorized || (data?.roles || []).includes("admin")) && data?.organizationConfiguration?.switches?.[ORG_START_SWITCH] === true,
    scope: `${session?.user?.id ?? ""}:${data?.member?.organizationId ?? ""}`,
    refreshKey: view,
  });
  // REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP4-20261029: guide 2 for
  // the staff hat worn, read while a real staff hat is worn and feature guides
  // are on. The server confirms the role (organization or chapter scope) and
  // keeps each person's progress apart from the member checklist.
  // The units step's facts belong to the selected chapter, so the chapter is
  // part of the scope: a chapter switch drops the cached answer and reads again.
  const staffGuideScope = `${session?.user?.id ?? ""}:${data?.member?.organizationId ?? ""}:${data?.member?.chapterId ?? ""}`;
  const staffGuideState = useStaffOnboardingGuide({
    client: demoActive ? null : sessionDataClient,
    enabled: !demoActive && Boolean(session) && selectedStaffHatAuthorized && featureGuidesOn,
    scope: staffGuideScope,
    refreshKey: `${view}:${selectedStaffHat}`,
  });
  const staffGuideScopeRef = useRef(staffGuideScope);
  staffGuideScopeRef.current = staffGuideScope;
  const staffGuideStateRef = useRef(staffGuideState);
  staffGuideStateRef.current = staffGuideState;
  // A unit saved or removed, or a steward placed, changes the units step's
  // facts: read the guide again once the write has landed.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onChange = () => { void staffGuideStateRef.current.reload(); };
    window.addEventListener(CHAPTER_SETUP_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(CHAPTER_SETUP_CHANGED_EVENT, onChange);
  }, []);
  // A learning-period undo of a role, scope or membership change can move a
  // steward back or remove one: read the guide again.
  useLearningUndone(CHAPTER_SETUP_UNDO_KINDS, () => { void staffGuideStateRef.current.reload(); });
  // The real first action finishes its guide even when the guide was never
  // opened: each staff desk's write, once it has landed, for the hat that
  // started it and only while the same person is still signed in.
  const staffGuideHooks = useMemo(() => ({
    scope: () => staffGuideScopeRef.current,
    finish: (hat, feature) => {
      const entry = staffGuideFor(hat, feature);
      if (entry && staffGuideStateRef.current.payload?.state === "active") void staffGuideStateRef.current.complete(entry.stepId);
    },
  }), []);
  const stewardGuideApi = useMemo(() => withStaffGuideActions(scopedStewardApi, "steward", staffGuideHooks), [staffGuideHooks, scopedStewardApi]);
  const coordinatorGuideApi = useMemo(() => withStaffGuideActions(coordinatorApi, "coordinator", staffGuideHooks), [coordinatorApi, staffGuideHooks]);
  const advisorDeskApi = useMemo(() => ({
    ...advisorApi,
    loadDesk: (options) => deskPrefetchRef.current.take(`advisor:${options?.overviewOnly ? "overview" : "full"}:${deskScopeRef.current}`,
      () => advisorApi.loadDesk(options)),
  }), [advisorApi, deskPrefetchRef]);
  const takeNextActions = useCallback((hat, read) => deskPrefetchRef.current.take(`next:${hat}:${deskScopeRef.current}`, read), [deskPrefetchRef]);
  // A started read belongs to the visit that started it: any
  // change of page, worn hat, its authorization, account or scope empties the
  // store before the effect below can start a new one.
  useDeskPrefetchVisit(deskPrefetchRef, { view, location: routeLocation, hat: selectedStaffHat, authorized: selectedStaffHatAuthorized, userId: session?.user?.id ?? null, scope: deskScope });
  //: on the demo a role switch signs in as that role's account, and the
  // shell mounts the desk only after the member route reads and their render
  // (about 3 s with nothing in flight on the hosted demo). Once the switched
  // account's own data has loaded and the worn hat is one it holds, start the
  // desk's own reads (and the Coordinator's next actions) at once; the desk
  // takes them when it mounts. Nothing is started once the route has loaded
  // (the desk reads for itself), for a hat the account does not hold, or on
  // the fixture demo.
  useEffect(() => {
    const prefetch = deskPrefetchRef.current;
    if (fixtureDemo || !supabase || sampleHatTransitioning) return;
    const activeSession = sessionRef.current;
    if (!activeSession?.user?.id || data?.member?.id !== activeSession.user.id) return;
    if ((view !== "coordinator" && view !== "advisor") || selectedStaffHat !== view || !selectedStaffHatAuthorized) return;
    if (memberLoaderRef.current?.stateForRoute(view)?.status !== "loading") return;
    const section = workspaceSectionAt(window.location.pathname, window.location.hash);
    const scope = deskScopeRef.current;
    if (view === "coordinator") {
      const kpisOnly = coordinatorKpisOnly(section, window.location.search);
      const deskLang = coordinatorLangRef.current;
      prefetch.start(`coordinator:${kpisOnly ? "kpis" : "full"}:${scope}:${deskLang}`, () => (kpisOnly
        ? loadCoordinatorDesk(supabase, deskLang, { kpisOnly: true })
        : loadCoordinatorDesk(supabase, deskLang)));
      if (section === "overview" && activeSession.access_token) {
        prefetch.start(`next:coordinator:${scope}`, () => readNextActions(createCapturedAppSessionRpcClient({ access_token: activeSession.access_token }), "coordinator"));
      }
      return;
    }
    const overviewOnly = advisorOverviewOnly(section);
    prefetch.start(`advisor:${overviewOnly ? "overview" : "full"}:${scope}`, () => advisorApi.loadDesk(overviewOnly ? { overviewOnly: true } : undefined));
  }, [advisorApi, data?.member?.id, deskPrefetchRef, fixtureDemo, resourceRevision, sampleHatTransitioning, selectedStaffHat, selectedStaffHatAuthorized, session?.user?.id, view]);
  const adminGuideApi = useMemo(() => withStaffGuideActions(adminApi, "admin", staffGuideHooks), [adminApi, staffGuideHooks]);
  const vpGuideApi = useMemo(() => withStaffGuideActions(vpApi, "vp", staffGuideHooks), [staffGuideHooks, vpApi]);
  const staffGuideHat = selectedStaffHatAuthorized ? selectedStaffHat : null;
  // Saving notification choices finishes the worn hat's Settings guide, from
  // the same committed-write signal the member layer uses.
  useEffect(() => {
    if (!staffGuideHat || !featureGuidesOn || typeof window === "undefined") return undefined;
    const onAction = (event) => {
      if (event?.detail?.feature === "settings") staffGuideHooks.finish(staffGuideHat, "settings");
    };
    window.addEventListener(ONBOARDING_GUIDE_ACTION_EVENT, onAction);
    return () => window.removeEventListener(ONBOARDING_GUIDE_ACTION_EVENT, onAction);
  }, [staffGuideHat, featureGuidesOn, staffGuideHooks]);
  // Every route is checked against the hat the user explicitly selected.
  // Staff hats return to their own plane rather than rendering Member Today.
  // An unknown /m address is no hat's refused route: every hat keeps it and
  // sees the shell's not-found page, whose way back is that hat's home.
  // A Compass citation is an explicit open of a record this person already
  // holds. Know your rights stays off the staff desk list (typed addresses
  // still follow the hat gate); the citation itself is allowed to show it
  // without dropping the worn hat .
  const compassCitationOpen = Boolean(
    searchFocus?.compassSource
    && searchFocus.view === view
    && (view === "rights" || view === "clauses"),
  );
  const selectedHatAllowsView = compassCitationOpen
    || (!view && unknownAppPath(window.location.pathname))
    || explicitHatAllowsView(selectedStaffHat, view, fixtureDemo, data?.roles || [], !railShell, routeLocation);
  // Keep a refused direct address explained until dismissal or navigation.
  // Bind the notice to its landing page and wearer so it cannot follow a
  // different hat or account into another workspace.
  const showHatRouteRefusal = hatRouteRefusal
    && hatRouteRefusal.path === normalizeAppPath(routeLocation.split(/[?#]/, 1)[0])
    && hatRouteRefusal.hat === selectedStaffHat
    && hatRouteRefusal.userId === data?.member?.id
    && hatRouteRefusal.organizationId === data?.member?.organizationId;
  // The sentence follows the live role projection so a real revocation
  // updates it, but a shell refresh that soft-fails the role read publishes
  // `rolesUnknown` with no roles at all; that is not a projection, so the
  // roles captured at refusal time keep the sentence until roles are read
  // again (UX-UG-BRIEF-ROLE-READ-FAILURE-REWRITES-CORRECT-OPENS-ADMIN-20261013).
  const hatRouteRefusalText = showHatRouteRefusal
    ? hatRouteRefusedNotice(tr, hatRouteRefusal.hat, hatRouteRefusal.path, false, railShell, { ...hatRouteRefusal.refused, roles: data.rolesUnknown ? hatRouteRefusal.refused.roles : data.roles || [] })
    : null;
  useEffect(() => {
    if (hatRouteRefusal && !showHatRouteRefusal) setHatRouteRefusal(null);
  }, [hatRouteRefusal, showHatRouteRefusal]);

  // BUG-UG-STAFF-CAN-ADD-EMPTY-STATES-WITHOUT-CONTROL-20261006: the
  // live product has no hat picker on member pages, so an admin or president
  // reading an empty authoring page in Member had no way to reach its writer.
  // Offer the held hats that may open this same view; wearing one keeps the
  // page, exactly as a desk entrance wears its hat. SAMPLE hats are separate
  // accounts and keep their own switcher.
  const authoringHatsKey = !demo && selectedStaffHat === "member" && data && !data.rolesUnknown
    ? heldAuthoringHats(data.roles || [], view, data.member?.organizationRoles || data.roles || []).join(" ")
    : "";
  const staffAuthoring = useMemo(() => {
    const hats = authoringHatsKey ? authoringHatsKey.split(" ") : [];
    return {
      hats,
      wearHat: hats.length ? (hat) => {
        if (!hats.includes(hat)) return;
        selectedStaffHatRef.current = hat;
        setSelectedStaffHat(hat);
      } : null,
    };
  }, [authoringHatsKey, setSelectedStaffHat]);
  // REQ-UG-OFFICER-NOTICES-WITH-READ-RECEIPTS-20261030: a steward,
  // admin or president hat posts notices from the Announcements tab; under
  // Member, an account holding one of those roles is offered to act in it.
  const noticeHatWorn = !fixtureDemo && Boolean(session && data) && selectedStaffHatAuthorized && NOTICE_HATS.includes(selectedStaffHat);
  const noticeHatsHeld = !demo && selectedStaffHat === "member" ? staffAuthoring.hats.filter((hat) => NOTICE_HATS.includes(hat)) : [];
  const noticeDesk = noticeHatWorn
    ? <OfficerNoticeDesk key={`${session.user.id}:${selectedStaffHat}:${data.member?.chapterId}`} api={noticeApi} canPostOrganization={noticeCanPostOrganization} onNotice={setNotice} />
    : noticeHatsHeld.length ? <OfficerNoticeHint hats={noticeHatsHeld} onWear={staffAuthoring.wearHat} /> : null;

  // OPS-UG-ANALYTICS-READ-SIDE-SHIPPED-BUT-NOTHING-IN-PRODUCTION-WRITES-ORGANIZATION-ENGAGEMENT-EVENTS-20260921
  // ( AUTHENTICATED PAGE-VIEW PRODUCER): every
  // workspace page change on a live, active membership records one
  // authenticated page view so the Usage tiles (Views / Daily actors / Weekly
  // actors) read real numbers. Authenticated SAMPLE traffic uses its isolated
  // backend; static demos and test previews record nothing. The recorder
  // sends a normalized /m path only, never a query or fragment, and the RPC
  // enforces the organization, the hat and the per-minute bound.
  const pageViewRecorder = useMemo(() => createWorkspacePageViewRecorder({
    // The Product analytics switch gates each view, and turning it off aborts
    // a view still waiting on authentication before it reaches the network.
    record: (page, context) => recordWorkspacePageView(abortableRpcClient(sessionDataClient, productAnalyticsSignal, isDemoAnalyticsEnabled), page, context.hat, context.organizationId),
    enabled: () => isDemoAnalyticsEnabled(),
  }), [sessionDataClient]);
  useEffect(() => {
    if (demoActive || (demo && !sampleLive) || !session || !data?.member?.organizationId || data.member.membershipStatus !== "active") return;
    pageViewRecorder.view(routeLocation, { hat: selectedStaffHat, organizationId: data.member.organizationId });
  }, [data?.member?.organizationId, data?.member?.membershipStatus, demo, demoActive, sampleLive, pageViewRecorder, routeLocation, selectedStaffHat, session]);

  // BUG-UG-SAMPLE-COORDINATOR-SURVEY-NAVIGATION-LANDS-ON-HOME-20261019:
  // Only fixture demos bypass role checks; SAMPLE uses its live role projection.
  // A degraded roles read publishes `rolesUnknown` with no roles, so the worn
  // hat cannot be confirmed for this route. The gates below hold the URL and
  // the hat on unknown roles; the view region holds too (it used to render
  // Member Home under the staff URL, with no refusal and no desks) and these
  // bounded re-reads settle it. Nothing staff-only renders while it is pending.
  const rolesPendingForView = !fixtureDemo && Boolean(data?.rolesUnknown) && !selectedHatAllowsView;
  useEffect(() => {
    if (!rolesPendingForView) return undefined;
    let cancelled = false;
    let attempt = 0;
    let timer = null;
    const schedule = () => {
      timer = window.setTimeout(() => {
        attempt += 1;
        refresh().catch(() => {}).finally(() => {
          if (!cancelled && attempt < ROLE_REREAD_ATTEMPTS) schedule();
        });
      }, ROLE_REREAD_DELAY_MS * 2 ** attempt);
    };
    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [refresh, rolesPendingForView]);

  // Live authorization can remove a hat while it is selected. Fail closed to
  // Member only after the role projection is known; an unavailable role read
  // remains unknown and never becomes proof that the role was revoked.
  useEffect(() => {
    if (selectedStaffHat === "member" || fixtureDemo || !data || data.rolesUnknown) return;
    if (holdsHat(data.roles || [], selectedStaffHat)) return;
    setSelectedStaffHat("member");
  }, [data, fixtureDemo, selectedStaffHat, setSelectedStaffHat]);

  useEffect(() => {
    if (!data) return; // roles are unknown until the snapshot lands
    // A degraded roles READ is not a role-less member:
    // the per-role render gates already keep the protected content unmounted,
    // so on a transient failure hold the URL rather than bounce a steward off
    // their desk. The next successful refresh settles it either way.
    if (data.rolesUnknown) return;
    // A hat restored from another account's visit in this tab is dropped
    // before any route is decided with it.
    const restoredHatOwner = actingHatOwnerRef.current;
    const liveUserId = sessionRef.current?.user?.id ?? null;
    if (restoredHatOwner && liveUserId) {
      actingHatOwnerRef.current = null;
      if (restoredHatOwner !== liveUserId && selectedStaffHat !== "member") {
        selectedStaffHatRef.current = "member";
        setSelectedStaffHat("member");
        return;
      }
    }
    const entryRoute = entryRouteRef.current;
    entryRouteRef.current = null;
    if (selectedHatAllowsView) {
      lastGatedStaffHatRef.current = selectedStaffHat;
      return;
    }
    if (!personaRouting) {
      // A typed or reloaded address (the route this page load arrived on)
      // that the worn hat cannot open: a member page opens as Member, and a
      // desk plane opens in its own held role. Shared staff tools are not
      // entered this way (AGENTS.md, desktop rail contract): they open under
      // the explicitly worn hat, which now persists across reloads. Later
      // navigation under a hat that cannot open a page is refused and
      // explained.
      const roles = data.roles || [];
      const currentPath = window.location.pathname + window.location.search + window.location.hash;
      if (entryRoute !== null && entryRoute === normalizeAppPath(window.location.pathname)) {
        const entryHat = entryHatForView(roles, view, (hat) => explicitHatAllowsView(hat, view, false, roles, !railShell, currentPath));
        if (entryHat && entryHat !== selectedStaffHat) {
          selectedStaffHatRef.current = entryHat;
          setSelectedStaffHat(entryHat);
          return;
        }
      }
      // On the SaaS origin a plane route the account
      // holds the role for is its own entrance. Wear that hat instead of
      // bouncing; a plane for a role the account lacks still fails closed.
      if (selectedStaffHat === "member") {
        const roleDesk = STAFF_PLANES.find((plane) => plane.view === view && roles.includes(plane.key));
        if (roleDesk) {
          selectedStaffHatRef.current = roleDesk.key;
          setSelectedStaffHat(roleDesk.key);
          return;
        }
      }
    }
    const selectedPlane = selectedStaffHatAuthorized
      ? STAFF_PLANES.find((plane) => plane.key === selectedStaffHat)
      : null;
    const officeRole = selectedChapterOfficeRole(data.roles, selectedStaffHat);
    const targetView = selectedPlane?.view ?? (officeRole ? "hub" : "today");
    const targetPath = selectedPlane?.path ?? (officeRole ? "/m/organize/record" : "/m");
    const hatChanged = lastGatedStaffHatRef.current !== selectedStaffHat;
    lastGatedStaffHatRef.current = selectedStaffHat;
    const refusedPath = window.location.pathname;
    const refusedDesk = deskForRefusedRoute(view, data.roles || [], fixtureDemo, refusedPath);
    pendingDeskRouteRef.current = refusedDesk && view !== "today"
      ? { hat: refusedDesk, view, href: refusedPath + window.location.search + window.location.hash, at: Date.now() }
      : null;
    window.history.replaceState({}, "", refusedRouteHref(targetPath, demo));
    const staffFallbackNotice = staffDeepLinkFallbackNoticeRef.current;
    staffDeepLinkFallbackNoticeRef.current = false;
    if (shouldAnnounceHatRouteRefusal(view) && !hatChanged) {
      const refusedNotice = hatRouteRefusedNotice(tr, selectedStaffHat, targetPath, staffFallbackNotice, railShell, { view, roles: data.roles || [], demo, path: refusedPath });
      if (refusedNotice) {
        if (demo) setNotice(refusedNotice);
        // A revoked hat becomes Member in the same update. Bind the notice
        // to that resulting wearer, while retaining the refused route so the
        // explanation can follow the current language and role projection.
        else setHatRouteRefusal({ path: targetPath, hat: selectedStaffHatAuthorized ? selectedStaffHat : "member", userId: data.member?.id, organizationId: data.member?.organizationId, refused: { view, demo, path: refusedPath, roles: data.roles || [] } });
      }
    }
    const switchWaiting = sampleHatTransitioningRef.current;
    setSampleHatFocusView((pending) => sampleHatFocusAfterGate(pending, targetView, switchWaiting));
    setView(targetView);    setRouteLocation(window.location.pathname + window.location.search + window.location.hash);
  }, [view, data, demo, fixtureDemo, personaRouting, railShell, selectedHatAllowsView, selectedStaffHat, selectedStaffHatAuthorized, setNotice, setSelectedStaffHat, tr]);

  // Keep the worn hat for this tab's session once the live roles confirm it,
  // so the next typed address or reload starts in it. A revoked or unknown
  // role is never written, and a hat restored from another account waits for
  // the guard above to drop it.
  const sessionUserId = session?.user?.id ?? null;
  useEffect(() => {
    if (personaRouting || !sessionUserId || !data || data.rolesUnknown || actingHatOwnerRef.current) return;
    if (selectedStaffHat !== "member" && !(data.roles || []).includes(selectedStaffHat)) return;
    writeActingHat(sessionUserId, selectedStaffHat);
  }, [data, personaRouting, selectedStaffHat, sessionUserId]);

  // Whether anyone could read this member's Chapter steward message,
  // per member, chapter and organization. Read only when the guide could name
  // a steward, Home's Find my steward card lists one  or Messages is
  // open, so it stays out of the cold boot.
  const liveStewardMessageAvailable = useStewardMessageAvailability({
    skip: demoActive,
    needed: view === "messages"
      || (view === "today" && stewardsForViewer(data?.chapterStewards, data?.member?.id ?? null).others.length > 0)
      || guideSteward(data?.chapterStewards, data?.member?.id ?? null) !== null,
    refreshKey: memberDataCommits,
    assuranceKey: session?.access_token ?? null,
    sessionUserId,
    memberId: data?.member?.id ?? null,
    chapterId: data?.member?.chapterId ?? null,
    organizationId: data?.member?.organizationId ?? null,
    read: () => getMemberStewardMessageAvailable(supabase),
    capture: (userId) => guardRef.current.captureOperation(userId),
  });
  // The fixture demo has no server to ask. A fixture may carry the answer
  // (the  proof); otherwise it stays unknown.
  const stewardMessageAvailable = demoActive
    ? (typeof data?.stewardMessageAvailable === "boolean" ? data.stewardMessageAvailable : null)
    : liveStewardMessageAvailable;

  // Assurance level (PR6). A member with a verified TOTP factor signs in at
  // aal1; the second factor raises them to aal2. Which members that applies to
  // is owesASecondFactor()'s question — see the note on it, which is where the
  // client/server factor-type boundary is explained.
  const mfaAnswerLoginRef = useRef(null);
  useEffect(() => {
    if (demoActive || !supabase || !session?.user) {
      mfaAnswerLoginRef.current = null;
      setMfaRequired(false);
      return undefined;
    }
    let mounted = true;
    const operation = guardRef.current.captureOperation(session.user.id, sessionGeneration);
    // BUG-UG-TERMS-REACCEPTANCE-GATE-LOCKOUT-20261030: "not yet
    // known" replaces the whole shell with the loading screen, which unmounts
    // every open form. A new login (another account, or a distinct sign-in by
    // the same one) has no answer yet; a token refresh of the same login keeps
    // its answer on screen while the new token is checked below. Otherwise each
    // refresh blanked the app and cleared a half-filled terms card (finding 28,
    // f/01). The database enforces the assurance level either way.
    const login = `${session.user.id}:${sessionGeneration}`;
    if (mfaAnswerLoginRef.current !== login) {
      mfaAnswerLoginRef.current = login;
      setMfaRequired(null);
    }

    // The decision itself is owesASecondFactor(), module-level and pure so it can
    // be tested as behaviour. This function is only the retry: one dropped
    // metadata request should not decide anything, so back off before giving up.
    async function owesACode() {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (!operation.isCurrent() || !mounted) return false;
        if (!error) {
          const owes = owesASecondFactor(data, session.user);
          if (owes || data?.currentLevel === "aal2") return owes;
          // The database refuses all member data when an active organization
          // requires enrollment. This self-only read remains reachable to
          // explain that refusal before the member has an authenticator.
          try {
            const requirement = await withLoadDeadline(supabase.rpc("get_my_mfa_requirement"));
            if (!requirement.error && requirement.data?.required) {
              return requirement.data.enrolled ? true : "enroll";
            }
          } catch { /* RLS still enforces the policy if this explanation cannot load. */ }
          return false;
        }
        if (!mounted) return false;
        await new Promise((resolve) => { window.setTimeout(resolve, 400 * 2 ** attempt); });
        if (!operation.isCurrent() || !mounted) return false;
      }
      return false;
    }

    // Fail OPEN, and this is now a safe choice rather than a hopeful one.
    //
    // It used to be neither: before the assurance boundary landed, this gate was
    // the ONLY thing standing between an aal1 token and the data, so failing open
    // handed the whole portal to anyone whose metadata call happened to fail —
    // or who simply called PostgREST directly and never asked this question at
    // all. Now private.mfa_satisfied() is enforced by a restrictive policy on
    // every table, so a member who owes a code gets nothing from the API no
    // matter what this component believes. The gate's only remaining job is to
    // explain that in the UI instead of showing an inexplicably empty screen.
    //
    // Which is also why it must not fail CLOSED: the members it would trap are
    // the ones with no second factor at all, whom RLS would have admitted
    // perfectly well. Blocking them to protect data that is already protected
    // trades a real lockout for an imaginary gain.
    owesACode()
      .then((owes) => { if (mounted && operation.isCurrent()) setMfaRequired(owes); })
      .catch(() => { if (mounted && operation.isCurrent()) setMfaRequired(false); });
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the access token IS the assurance-level input; session?.user is only a guard and adding it would re-check on every session object identity change.
  }, [demoActive, session?.user?.id, session?.access_token, sessionGeneration]);

  // Live in-app feed (PR5): new notification rows stream in over Realtime and
  // merge locally — a full loadMemberApp per insert would be disproportionate.
  // RLS scopes the stream server-side; the id-dedup guard covers duplicates.
  //
  // The initial query and the subscription do not meet: a row inserted after
  // the query snapshot but before the channel reaches SUBSCRIBED is in neither
  // source and would stay invisible until a manual refresh. One refetch at
  // SUBSCRIBED closes that window deterministically.
  useEffect(() => {
    if (!supabase || demoActive || !session?.user) return undefined;
    const guard = guardRef.current;
    const operation = guard.captureOperation(session.user.id);
    const activeSession = session;
    return subscribeToNotificationInserts(
      supabase,
      session.user.id,
      (row) => {
        if (!operation.isCurrent()) return;
        if (!memberLoaderRef.current?.noteLive("table:member_notifications", row)) return;
        // The resource registry buffers events against request-start ordering,
        // including inserts received before the shell has a snapshot.
        setData((prev) => {
          if (!prev) return prev;
          const notifications = sortNewestFirst([row, ...prev.notifications.filter((item) => item.id !== row.id)]);
          return {
            ...prev,
            notifications,
            member: { ...prev.member, notificationCount: unreadCount(notifications) },
          };
        });
      },
      () => {
        if (!operation.isCurrent()) return;
        // Reconcile only the two resources this channel owns. A full route
        // refresh here doubled authenticated startup and could discard open
        // Compass history or another route's already-loaded projection.
        loaderFor(activeSession).reconcileRealtime().catch(() => {
          // Failed reads keep the last successful registry snapshot. Its
          // subscription schedules the visible projection, including live
          // rows that arrived while another reconciliation read was pending.
        });
      },
      (row) => {
        if (!operation.isCurrent()) return;
        if (!memberLoaderRef.current?.noteLive("table:chapter_task_messages", row)) return;
        setData((prev) => {
          if (!prev || (prev.taskMessages || []).some((item) => item.id === row.id)) return prev;
          return {
            ...prev,
            taskMessages: sortOldestFirst([...(prev.taskMessages || []), row]),
          };
        });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the subscription belongs to the member, not the token: re-running on every session refresh would tear down and re-open the realtime channel hourly.
  }, [demoActive, session?.user?.id, sessionGeneration]);

  // Live board sync (REQ-UG-KANBAN-PHASE1-20260801). The tasks board is
  // the one surface where several people move the SAME cards at once, so a
  // remote move has to land without a refresh. It cannot ride the feed above:
  // moves and reorders are UPDATEs, and the supabase_realtime publication is
  // deliberately INSERT-only. The private per-chapter broadcast channel
  // (migration 20260801170000) carries them instead.
  //
  // Deliberately the narrowest subscription in the app — staff-only, only
  // while the board is the visible view, never inside the companion embed
  // (the outer instance owns the socket), never in demo, where there is no
  // server to hear from. A board nobody is looking at is not worth a channel.
  useEffect(() => {
    const chapterId = data?.member?.chapterId;
    if (!supabase || demoActive || embedPhone || !session?.user || !canUseStaffTools) return undefined;
    if (view !== "tasks" || !chapterId) return undefined;
    const guard = guardRef.current;
    const operation = guard.captureOperation(session.user.id);
    const userId = session.user.id;
    const refetchQueue = createBoardRefetchQueue({
      load: async () => {
        if (!operation.isCurrent()) return null;
        const ticket = guard.beginRequest(userId);
        if (!ticket) return null;
        const board = await loaderFor(session).reconcileBoard();
        if (!operation.isCurrent()) return null;
        return { ticket, board };
      },
      commit: (loaded, buffered) => {
        if (!operation.isCurrent() || !loaded || !guard.canCommit(loaded.ticket)) return null;
        setData((prev) => {
          if (!prev) return prev;
          const taskAssignments = loaded.board.taskAssignments ?? prev.taskAssignments;
          const boardTasks = (loaded.board.tasks ?? prev.tasks).map((task) =>
            withTaskAssignees(task, taskAssignments || [], prev.taskAssignees || []));
          let next = {
            ...prev,
            tasks: boardTasks,
            workstreams: loaded.board.workstreams ?? prev.workstreams,
            taskDependencies: loaded.board.taskDependencies ?? prev.taskDependencies,
            taskSubtasks: loaded.board.taskSubtasks ?? prev.taskSubtasks,
            taskWatches: loaded.board.taskWatches ?? prev.taskWatches,
            taskAssignments,
          };
          for (const event of buffered) next = applyBoardEvent(next, event);
          return next;
        });
        return loaded.board;
      },
    });
    const unsubscribe = subscribeToChapterTaskBoard(
      supabase,
      chapterId,
      (event) => {
        if (!operation.isCurrent()) return;
        const resource = event.table === "chapter_task_dependencies"
          ? "rpc:list_chapter_task_dependencies" : `table:${event.table}`;
        memberLoaderRef.current?.noteLive(resource, event.record || event.oldRecord, {
          deleted: event.operation === "DELETE" || Boolean(event.record?.deleted_at),
          authoritative: true,
        });
        guard.noteRealtimeBoardEvent(event);
        refetchQueue.note(event);
        // Last write wins by updated_at, never by arrival order — the shared
        // reducer above MemberApp carries the full merge contract.
        setData((prev) => applyBoardEvent(prev, event));
      },
      () => {
        if (!operation.isCurrent()) return;
        refetchQueue.refetch().catch(() => { /* the live channel still works without the gap fill */ });
      },
      session.access_token,
    );
    return () => {
      refetchQueue.close();
      unsubscribe?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `data` is read for the chapter id only, and that id is in the deps: subscribing on every data identity would re-open the channel on each keystroke-driven state commit.
  }, [demoActive, session?.user?.id, sessionGeneration, canUseStaffTools, view, embedPhone, data?.member?.chapterId]);

  // The query window is time-based, so a long-lived tab needs its own clock:
  // the 60-day boundary can pass with no broadcast at all.
  useEffect(() => scheduleDoneTaskExpiry(data?.tasks, () => {
    setData((current) => {
      if (!current) return current;
      const tasks = pruneExpiredDoneTasks(current.tasks);
      return tasks.length === (current.tasks || []).length ? current : { ...current, tasks };
    });
  }), [data?.tasks]);

  // Push capability + ownership for THIS device and THIS member. The
  // companion embed reports unsupported and never probes: the outer instance
  // owns the device's one push subscription, and a second healing pass in the
  // iframe could race it.
  useEffect(() => {
    if (embedPhone || demoActive || !supabase || !session?.user) {
      setPushState({ supported: false, subscribed: false, denied: false });
      return undefined;
    }
    let mounted = true;
    const userId = session.user.id;
    const operation = guardRef.current.captureOperation(userId);
    const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
    (async () => {
      if (!vapidKey || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
      // main.jsx registers on window.load, so on a first visit getRegistration()
      // resolves to undefined and the screen would say "unsupported" for the
      // rest of the session. ready resolves once a worker is active.
      const registration = await navigator.serviceWorker.ready;
      if (!mounted || !operation.isCurrent()) return;
      const denied = Notification.permission === "denied";
      let subscription;
      try { subscription = await registration.pushManager.getSubscription(); } catch { subscription = null; }
      if (!mounted || !operation.isCurrent()) return;
      if (!subscription) {
        setPushState({ supported: true, subscribed: false, denied });
        return;
      }
      // A subscription minted against a different VAPID key can never receive
      // anything signed with the current one, and re-subscribing would reject
      // while it exists. Drop it so Enable can mint a working one.
      if (!subscriptionMatchesKey(subscription, vapidKey)) {
        try { await subscription.unsubscribe(); } catch { /* already gone */ }
        if (!mounted || !operation.isCurrent()) return;
        try { await unsubscribeFromPush(sessionDataClient, userId, subscription.endpoint); } catch { /* best effort */ }
        if (mounted && operation.isCurrent()) setPushState({ supported: true, subscribed: false, denied });
        return;
      }
      // "Subscribed" has to mean this member owns the registry row, not merely
      // that the browser holds a subscription. On a shared device the second
      // member would otherwise see push as on while every send went to the
      // first member's row.
      //
      // Three-state on purpose. `false` means the lookup succeeded and the row
      // is someone else's; `null` means we could not tell (network, RLS error).
      // Only a confirmed `false` may destroy anything — tearing down a live
      // subscription because one request blipped would silently switch push off
      // for a member who never asked.
      let owned;
      try { owned = await hasPushSubscription(sessionDataClient, userId, subscription.endpoint); } catch { owned = null; }
      if (!mounted || !operation.isCurrent()) return;
      if (owned === false) {
        // Showing "off" is not enough: the endpoint stays live and the previous
        // member's case, deadline and form alerts keep arriving on a device they
        // have signed out of. Unsubscribing invalidates the endpoint, and the
        // dispatcher's 404/410 prune then retires their registry row — which is
        // theirs to lose, not ours to delete from under this session.
        try { await subscription.unsubscribe(); } catch { /* already gone */ }
        if (mounted && operation.isCurrent()) setPushState({ supported: true, subscribed: false, denied });
        return;
      }
      // Observing an owned endpoint must not renew its registration or move
      // it to another login. Enable and Refresh are explicit binding actions.
      // Token refresh keeps the same session lineage; existing rows continue
      // delivering until disabled or revoked, including legacy unbound rows.
      setPushState({ supported: true, subscribed: owned === true, denied });
    })().catch(() => { /* detection is best-effort; the screen keeps the unsupported note */ });
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- push ownership is per member and per device, not per token; re-running on session object identity would re-probe (and possibly unsubscribe) on every refresh.
  }, [demoActive, session?.user?.id, sessionGeneration, sessionDataClient]);

  // Warm-up. Splitting the routes trades one big download for a round-trip the
  // first time each screen is opened, and offline that round-trip has no
  // answer: sw.js caches what has actually been fetched, so a screen the member
  // has never visited would be missing precisely when they most need it. So
  // once their data has resolved, quietly pull the chunks they can genuinely
  // reach — the five bottom-nav destinations plus whichever staff planes their
  // roles grant, or every hat in the demo, where the switcher exposes them all.
  //
  // Idle-time only (a 4s timeout keeps it from being starved on a busy tab),
  // cancelled on unmount, and every failure swallowed: this is warming a cache,
  // not loading a screen, and nothing here may surface an error to the member.
  // It also waits WARM_UP_DELAY_MS first: once the entry chunk shrank
  // (PERF-UG-WEB-SHELL-AND-PER-LANGUAGE-BUNDLES-20261011) the first
  // idle moment came before the largest paint, and dozens of chunk downloads
  // started competing with it (Lighthouse SAMPLE member route, slow 4G: 9.8 s
  // largest paint with the warm-up at first idle, 6.3 s with it held back).
  const warmRoles = hasData ? (data.roles ?? []).join(",") : null;
  useEffect(() => {
    if (warmRoles === null) return undefined;
    const keys = demoActive
      ? Object.keys(viewLoaders)
      : [...new Set([
        ...warmRoles.split(",").filter((role) => Object.hasOwn(viewLoaders, role)),
        "messages", "numbers", "cases", "rights", "search",
      ])];
    const warm = () => { for (const key of keys) viewLoaders[key]().catch(() => {}); };
    let idle = null;
    const timer = window.setTimeout(() => {
      if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(warm, { timeout: 4000 });
      else warm();
    }, WARM_UP_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      if (idle !== null) window.cancelIdleCallback(idle);
    };
  }, [warmRoles, demoActive]);

  // Chapter work is a shared staff tool: remember the last hat worn outside it
  // so the workspace theme keeps that hat's shell instead of snapping to the
  // coordinator's. Capability derivation (activeHat) is untouched by this.
  const lastNonTasksHatRef = useRef(null);
  useEffect(() => {
    if (!STAFF_TOOL_VIEWS.includes(view)) lastNonTasksHatRef.current = selectedStaffHatAuthorized ? selectedStaffHat : "member";
  }, [selectedStaffHat, selectedStaffHatAuthorized, view]);

  function navigate(nextView, path, focus = null, { replace = false, homePanel = "home", guarded = false } = {}) {
    // The bare /m/organize address is the Organize plane, so
    // a caller asking for the campaign workspace (the chapter hub) at
    // that address lands on the workspace's first tab instead.
    if (nextView === "hub" && path.split(/[?#]/, 1)[0] === "/m/organize") path = `/m/organize/organize${path.slice("/m/organize".length)}`;
    if (destructiveHoldPinsHub(nextView)) return;
    // `guarded`: the caller already ran the unsaved-work guard for this move.
    if (!guarded && !allowWorkspaceNavigation(path)) return;
    setSampleHatFocusView((pending) => sampleHatFocusAfterNavigation(pending, nextView));
    clearDemoChapterSelection(false);
    // The embed replaces rather than pushes: an iframe's pushState joins the
    // TOP-LEVEL history, so every tap inside the companion phone would add a
    // back-button entry that rewinds the phone instead of the page. The query
    // survives so a session restore reboots this instance as the companion.
    if (embedPhone) {
      // Staff callers hand their path a ?demo=1 rider, but this instance's
      // own search already carries it (plus embed=phone) — append without
      // stripping and "/m/tasks?demo=1?demo=1&embed=phone" breaks BOTH flags
      // on the next session restore.
      const target = workspaceRouteWithTransport(path, { demo, embedPhone: true });
      if (!target) return;
      window.history.replaceState({}, "", target);
      // Mirror UP: a tap inside the companion phone moves the desktop plane
      // too, so the two panes never show different screens. A distinct
      // message type keeps the two directions from ever re-triggering each
      // other — the outer shell applies "sg-nav-up" without posting back.
      if (window.parent !== window) window.parent.postMessage({ type: "sg-nav-up", path: target }, window.location.origin);
    } else {
      // Demo mode lives only in the URL — there is no storage behind it — so
      // a member-route push that drops ?demo=1 silently exits the demo on the
      // next reload or share (staff callers already hand their paths the
      // rider). Preserve the flag on app paths while the demo is active;
      // non-app paths (the public front door) stay bare on purpose.
      const demoTarget = demo && path.startsWith("/m") ? withDemoRider(path) : path;
      // An explicit ?shell= choice (alternate or classic) rides on app paths
      // the same way, so a copied URL opens the shell the visitor chose.
      const target = demoTarget.startsWith("/m") ? withShellParam(demoTarget, window.location.search) : demoTarget;
      if (replace) window.history.replaceState({}, "", target);
      else window.history.pushState({}, "", target);
    }
    setMobileHomePanel(homePanel);
    setView(nextView);    setRouteLocation(window.location.pathname + window.location.search + window.location.hash);
    setGuideOpen(false);
    // A search result carries its deep-link payload; every other navigation
    // clears it so an old target does not re-open when the view remounts.
    setSearchFocus(focus);
    window.scrollTo({ top: 0, behavior: "instant" });
    // Mirror member-route navigation into the companion phone. The embed
    // filters to member routes itself, so staff paths are simply ignored.
    const companion = companionRef.current?.contentWindow;
    if (companion) companion.postMessage({ type: "sg-nav", path }, window.location.origin);
  }

  // The member whose Keyboard shortcuts choice every shortcut reads (off
  // until they turn it on in Settings); the fixture demo keeps its own
  // session-only choice, never the shared fixture member's.
  const keyboardShortcutsOn = useKeyboardShortcutsEnabled();
  const keyboardShortcutsMemberId = data?.member?.id ?? null;
  useLayoutEffect(() => {
    setKeyboardShortcutsScope(keyboardShortcutsMemberId, fixtureDemo);
  }, [fixtureDemo, keyboardShortcutsMemberId]);

  // Historical keyboard entry into the full Search screen. Slash is reserved
  // only from neutral shell focus: editors keep their character, and an open
  // modal keeps ownership of its own keyboard model.
  useEffect(() => {
    function enterSearch(event) {
      if (event.defaultPrevented || event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!keyboardShortcutsEnabled()) return;
      if (isEditableShortcutTarget(event.target) || document.querySelector('[role="dialog"], [aria-modal="true"]')) return;
      if (!explicitHatAllowsView(selectedStaffHatRef.current, "search", demo, dataRef.current?.roles || [], !railShell, "/m/search")) return;
      event.preventDefault();
      navigate("search", "/m/search");
    }
    window.addEventListener("keydown", enterSearch);
    return () => window.removeEventListener("keydown", enterSearch);
  });

  // Staff/hat navigation only. The history entry and the scroll reset still
  // happen synchronously (they are side effects, not state), so back/forward
  // and deep links behave exactly as before; only the repaint is deferred.
  // The explicit "open the task board" entrances (alt/altShell.js tasksBoardHref).
  function tasksBoardPath() {
    return tasksBoardHref({ demo, alt: altShell });
  }

  function openCompassSource(target) {
    const phoneSheet = !railShell && !embedPhone;
    if (phoneSheet) compassResumeRef.current = true;
    navigate(target.view, target.path, target.focus || null);
    if (phoneSheet) setAssistantOpen(false);
  }

  function navigateStaff(nextView, path) {
    startViewTransition(() => navigate(nextView, path));
  }

  // A search hit either navigates with a focus payload the view consumes, or
  // opens the matching App-level surface (ballot/pulse dialog, notifications,
  // Compass) directly. The nonce lets the same result fire twice in a row.
  function openSearchResult(focus) {
    if (focus.planId) {
      const planItem = data.planItems.find((item) => item.id === focus.planId);
      // Route through handlePlanAction, never setActivePlan directly: it owns
      // the closed guard, and a second entry point that skips it re-opens the
      // vote dialog on a closed ballot straight from search. Closed rows stay
      // searchable on purpose (receipt lookup) — they just land read-only.
      if (planItem) handlePlanAction(planItem);
      return;
    }
    if (focus.notifications) { setNotificationsOpen(true); return; }
    if (focus.assistant) {
      setAssistantSearchTarget(focus.guideThreadId ? { ...focus } : null);
      setAssistantOpen(true);
      return;
    }
    if (focus.staffView) {
      // switchHat would land on the desk's root inside a transition, and the
      // route gate would see the new hat with the old view first. On the live
      // product a hat is only a selection, so wear it and open the named page
      // in the same urgent update.
      const desk = !demo ? roleDeskPlanes.find((plane) => plane.view === focus.staffView) : null;
      if (desk && selectedStaffHat !== desk.key) {
        if (destructiveHoldPinsHub(desk.view)) return;
        selectedStaffHatRef.current = desk.key;
        setSelectedStaffHat(desk.key);
        navigate(focus.staffView, staffDestinationPath(focus.path));
        return;
      }
      railNavigate(focus.staffView, focus.path, focus.sectionId ?? "");
      return;
    }
    navigate(focus.view, focus.path, { ...focus, nonce: Date.now() });
  }

  function openCompassWithDraft(question) {
    setAssistantDraft(question);
    setAssistantOpen(true);
  }

  // REQ-UG-COMPASS-ACTION-OFFERS-20261001 and
  // REQ-UG-COMPASS-CONTEXTUAL-NUDGES-20261001. Both read only while the
  // organization switch is on (the server enforces it again), and never in the
  // demo. Pins come from their own RPC, never the shared boot select.
  const compassConfiguration = data?.organizationConfiguration ?? null;
  // REQ-UG-COMPASS-REFUSES-GENERAL-HOW-TO-QUESTIONS-20261030: the
  // organization's Compass switch removes every Compass opener, not only the
  // answers behind them.
  const compassOn = compassAssistantEnabled(compassConfiguration);
  const compassUserId = session?.user?.id ?? null;
  const compassScopeKey = !demoActive && compassUserId && data?.member?.id === compassUserId
    ? `${compassUserId}:${data.member.organizationId}:${session.access_token}` : null;
  const compassOffersOn = Boolean(compassScopeKey) && actionOffersEnabled(compassConfiguration);
  const compassNudgesOn = Boolean(compassScopeKey) && contextualNudgesEnabled(compassConfiguration);
  const { pins: compassPins, pinsFailed: compassPinsFailed, nudges: compassNudges, refreshPins: refreshCompassPins } = useCompassHomeContent({
    client: sessionDataClient, scopeKey: compassScopeKey, offersOn: compassOffersOn, nudgesOn: compassNudgesOn,
  });
  const visibleCompassNudges = useMemo(() => presentNudges(selectedStaffHatAuthorized ? compassNudges.staff : compassNudges.member, tr), [compassNudges, selectedStaffHatAuthorized, tr]);
  // An urgent signal opens Compass once per browser session per account
  // (old lib/claude/contextual-nudges.ts urgent flag).
  useEffect(() => {
    if (!compassUserId || !visibleCompassNudges.some((nudge) => nudge.urgent)) return;
    const key = `compass.nudges.opened.${compassUserId}`;
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
    } catch { return; }
    setAssistantOpen(true);
  }, [compassUserId, visibleCompassNudges, setAssistantOpen]);
  const compassTasksAllowed = selectedStaffHatAuthorized && explicitHatAllowsView(selectedStaffHat, "tasks", fixtureDemo, data?.roles || [], !railShell, "/m/tasks");
  // REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: Voting's way
  // to the ballot tools. Campaigns opens only under a worn staff hat that
  // allows it; from Member it offers the switch to a held hat that does.
  const campaignsAllowed = !fixtureDemo && selectedStaffHatAuthorized
    && explicitHatAllowsView(selectedStaffHat, "campaigns", fixtureDemo, data?.roles || [], !railShell, "/m/campaigns");
  const campaignsHat = !fixtureDemo && !campaignsAllowed
    ? STAFF_PLANES.find((plane) => (data?.roles || []).includes(plane.key)
      && explicitHatAllowsView(plane.key, "campaigns", fixtureDemo, data?.roles || [], !railShell, "/m/campaigns")) ?? null
    : null;
  // REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: the
  // member's own reminders and private dates, offered where members looked.
  const personalRemindersNode = !fixtureDemo && !sessionRestricted && data?.member?.id ? <PersonalReminders key={session?.user?.id} client={sessionDataClient} /> : null;
  const compassAnswerActions = compassOffersOn ? {
    pin: async (messageId, pinned) => { await setCompassAnswerPinned(sessionDataClient, messageId, pinned); await refreshCompassPins(); },
    pinnedIds: new Set(compassPins.map((pin) => pin.id)),
    forwardTargets: compassTasksAllowed ? ["message", "task", "event"] : ["message", "event"],
    forward: async (target, text) => {
      let copied = true;
      try { await navigator.clipboard.writeText(text); } catch { copied = false; }
      setAssistantOpen(false);
      if (target === "task" && compassTasksAllowed) navigate("tasks", "/m/tasks");
      else if (target === "event") navigate("events", "/m/events");
      else navigate("messages", "/m/messages");
      if (!copied) setNotice(tr("compass.actions.copyFailed"));
    },
    createTask: compassTasksAllowed ? async (fields) => {
      const created = await handleCreateTask(fields);
      if (!created) throw new Error("task_failed");
    } : null,
    publishBroadcast: selectedStaffHatAuthorized && NOTICE_HATS.includes(selectedStaffHat) ? async ({ title, body, operationKey }) => {
      await noticeApi.publish(title, body, lang, "chapter", operationKey);
    } : null,
  } : null;

  async function enterDemo() {
    const operation = guardRef.current.captureOperation();
    // Fetch the demo-only chunk before painting anything: the fixtures are not
    // in the member bundle.
    //
    // AuthScreen wires this straight to onClick, so a rejection here escapes as
    // an unhandled promise rejection rather than anything the visitor can see.
    // Catching leaves them on the sign-in screen with the tour simply not
    // starting, which is the honest outcome when the chunk cannot be fetched.
    let fixtures;
    try {
      fixtures = await loadDemoData();
      if (!operation.isCurrent()) return;
    } catch {
      if (!operation.isCurrent()) return;
      setNotice(tr("app.loadFailed"));
      return;
    }
    // Bump before painting fixture data: a real read still in flight would
    // otherwise land on top of the demo and show live member data here. Routed
    // through beginSessionGeneration, not guard.beginSession directly —
    // entering and leaving the demo are identity transitions like any other, so
    // they owe the same member-scoped clear-down (the setData below simply wins
    // over the null it sets, in the same batch).
    beginSessionGeneration(fixtures.member.id);
    demoFormSignaturesRef.current = demoSignatureRows(fixtures.forms);
    // Keep every in-memory harness tour entry on the Steward persona (the live
    // SAMPLE entry is enterSampleDemo below, which wears Member). Without this explicit assignment the public landing enters while `demo`
    // is still false, so beginSessionGeneration correctly clears the previous
    // account to Member and the guided-tour CTA diverges from a cold /m visit.
    selectedStaffHatRef.current = DEFAULT_SAMPLE_HAT;
    setSelectedStaffHat(DEFAULT_SAMPLE_HAT);
    setDemo(true);
    const nextSession = demoSessionFor(fixtures);
    sessionRef.current = nextSession;
    setSession(nextSession);
    const demoConfiguration = fixtures.adminDesk?.configuration ?? null;
    const demoSetting = (key, fallback) => demoConfiguration?.settings
      ?.find((item) => item.key === key)?.value ?? fallback;
    setData({
      ...fixtures,
      organizationConfiguration: demoConfiguration
        ? {
          available: true,
          organizationId: demoConfiguration.organizationId ?? null,
          recoveryCodeEnrollmentEnabled: demoSetting("features.mfa_recovery_code_enrollment", true),
          labelOverrides: { ...(demoConfiguration.labelOverrides ?? {}) },
          switches: memberSwitchesFromSettings(demoConfiguration.settings),
        }
        : null,
    });
    setDataError("");
    setLoading(false);
    setDemoWelcomeOpen(true);
    navigate("today", "/m?demo=1");
  }

  // Enter the live SAMPLE demo as the Member hat's persona account, without
  // credentials; the hat switcher then offers every seeded role. The auth
  // listener adopts the returned session like any sign-in.
  async function enterSampleDemo() {
    if (sampleEntryBusyRef.current) return;
    sampleEntryBusyRef.current = true;
    setSampleEntryError("");
    selectedStaffHatRef.current = "member";
    setSelectedStaffHat("member");
    try {
      // A password sign-in that completes while this entry is in flight wins:
      // the late persona session is never adopted over it (gate r2s4 on).
      await mintSamplePersonaSession(supabase, "member", { stillWanted: () => !sessionRef.current });
    } catch {
      setSampleEntryError(tr("demo.entryFailed"));
    } finally {
      sampleEntryBusyRef.current = false;
    }
  }

  function switchHat(hat, acknowledge = null) {
    // On SAMPLE a persona session switches hats by signing in as that hat's
    // Tamarack persona account (UB-UNIONGROUND-DEMO-STRAIGHT-IN-ENTRY-RESTORED-
    // 20261107). An organization account switches among its own held roles
    // like any account and never swaps identity.
    const personaSwap = sampleLive && personaRouting;
    const entry = DEMO_HATS.find((item) => item.key === hat)
      || DEMO_HATS[0];
    if (destructiveHoldPinsHub(entry.view)) return false;
    // Switching to the desk a refused address named opens that address.
    const resume = pendingDeskRouteFor(pendingDeskRouteRef.current, entry.key);
    pendingDeskRouteRef.current = null;
    const destinationView = resume?.view ?? entry.view;
    const path = resume ? resume.href : demo ? `${entry.path}?demo=1` : entry.path;
    // The unsaved-work guard runs before any side effect: a cancelled switch
    // must leave the worn hat, the loading gate and the signed-in persona
    // exactly as they were (gate r1s1/r2s1 on). The navigation below
    // reuses this approval.
    if (!allowWorkspaceNavigation(path)) return false;
    const currentEmail = sessionRef.current?.user?.email;
    // Two change events can land before React paints the loading boundary. In
    // that overlap, the selected ref may already name the first destination
    // while the session still belongs to the original persona. Rollback must
    // follow the authenticated identity, never that optimistic selection.
    const { previousHat, previousView, previousPath } = resolveSampleHatRollback({
      selectedHat: selectedStaffHatRef.current,
      currentEmail,
      currentView: view,
      currentPath: `${window.location.pathname}${window.location.search}${window.location.hash}`,
      demo,
      personas: personaSwap ? samplePersonas() : [],
      hats: DEMO_HATS,
    });
    const samplePersona = personaSwap ? samplePersonaForHat(entry.key) : null;
    if (personaSwap && !samplePersona) {
      setNotice(tr("demo.hatSwitchFailed"));
      return false;
    }
    // Every SAMPLE choice supersedes an older mint, including a rapid return
    // to the persona that is still authenticated. Without this unconditional
    // bump, that abandoned mint can verify later and override the last choice.
    const choice = personaSwap ? beginSampleHatChoice(hatMintSeqRef) : null;
    const needsSampleIdentityTransition = Boolean(
      personaSwap
      && samplePersona
      && (sampleHatTransitioningRef.current || currentEmail !== samplePersona.email),
    );
    // A SAMPLE hat is a real seeded account, not a client-only view toggle.
    // Keep a gate independent of ordinary data loading before publishing the
    // destination. An intermediate auth event may clear `loading`, but it must
    // never mount a desk until the latest queued verification and its matching
    // data load both settle.
    if (needsSampleIdentityTransition) {
      sampleHatDesiredEmailRef.current = samplePersona.email;
      sampleHatDesiredSequenceRef.current = choice.sequence;
      setSampleHatFocusView(destinationView);
      sampleHatTransitioningRef.current = true;
      setSampleHatOpening(entry.key);
      setSampleHatTransitioning(true);
      // BUG-UG-DEMO-HAT-SWITCH-WAIT-GENERIC-WHILE-DESK-CHUNK-LOADS-20261108:
      // the warm-up only pulls the persona's own planes, so the destination
      // desk's chunk would start only once its data had loaded. Fetch it now,
      // alongside the persona's sign-in and reads.
      viewLoaders[entry.view]?.().catch(() => {});
    }
    selectedStaffHatRef.current = entry.key;
    setSelectedStaffHat(entry.key);
    // A chosen role ends the cold-link explanation (BUG-UG-DEMO-STAFF-SWITCH-STUCK-WITH-COLD-LINK-NOTICE-20261108).
    setStaffDeepLinkFallback(false);
    // On the SAMPLE origin a hat is a PERSONA: switching signs in as that
    // hat's seeded account, so the desk that renders is the real product
    // reading that persona's rows under RLS — not a bypassed view over
    // someone else's data. The session swap is a genuine identity change;
    // the auth listener clears member-scoped state exactly as production
    // does, and the hat survives because beginSessionGeneration leaves hat
    // state to this switcher on the demo surface.
    if (needsSampleIdentityTransition) {
      // verifyOtp changes one shared browser session and cannot be cancelled
      // after it starts. Serialize those side effects: if an old verification
      // completes after a newer choice, the newer queued task observes that
      // exact session and restores the latest explicitly requested persona.
      // The switch is fenced to the persona lineage as well as to this choice
      // (gate r3s3/r4s3 on): once this tab's session, or the session
      // the shared storage now holds, has signed out or belongs to any
      // non-persona account (another tab signed in), the switch is abandoned
      // and never adopted over that newer session.
      let departed = false;
      const personaLineage = (candidate) => {
        if (isSamplePersonaEmail(sessionRef.current?.user?.email) && (candidate === undefined || isSamplePersonaEmail(candidate?.user?.email))) return true;
        departed = true;
        return false;
      };
      const adoptable = () => choice.stillWanted() && personaLineage();
      hatTransitionQueueRef.current.enqueue(async () => {
        if (!adoptable()) return;
        const { data: currentAuth, error: currentAuthError } = await supabase.auth.getSession();
        if (currentAuthError) throw currentAuthError;
        if (!choice.stillWanted() || !personaLineage(currentAuth.session)) return;
        if (currentAuth.session?.user?.email !== samplePersona.email) {
          await mintSamplePersonaSession(supabase, entry.key, { stillWanted: adoptable });
        }
        if (!choice.stillWanted() || departed) return;
        const { data: settledAuth, error: settledAuthError } = await supabase.auth.getSession();
        if (settledAuthError) throw settledAuthError;
        if (settledAuth.session?.user?.email !== samplePersona.email) {
          throw new Error("Persona session did not settle on the requested identity");
        }
      }).then(() => {
        if (departed) {
          // Lower only this switch's own gate; the newer session stays.
          if (choice.stillWanted()) {
            sampleHatDesiredEmailRef.current = null;
            sampleHatDesiredSequenceRef.current = 0;
            setSampleHatFocusView(null);
            sampleHatTransitioningRef.current = false;
            setSampleHatTransitioning(false);
          }
          return;
        }
        if (choice.stillWanted()) setSampleHatSettledSequence(choice.sequence);
      }, async () => {
        if (!choice.stillWanted()) return;
        let rollback = { previousHat, previousView, previousPath };
        try {
          const { data: activeAuth, error: activeAuthError } = await supabase.auth.getSession();
          if (!activeAuthError && activeAuth.session?.user?.email) {
            rollback = resolveSampleHatRollback({
              selectedHat: entry.key,
              currentEmail: activeAuth.session.user.email,
              currentView: entry.view,
              currentPath: path,
              demo,
              personas: samplePersonas(),
              hats: DEMO_HATS,
            });
          }
        } catch { /* retain the authenticated snapshot captured before the choice */ }
        if (!choice.stillWanted()) return;
        selectedStaffHatRef.current = rollback.previousHat;
        setSelectedStaffHat(rollback.previousHat);
        sampleHatDesiredEmailRef.current = null;
        sampleHatDesiredSequenceRef.current = 0;
        // Replace the optimistic destination with the identity that is still
        // authenticated so refresh/back cannot reopen a mismatched staff desk.
        navigate(rollback.previousView, rollback.previousPath, null, { replace: true });
        setSampleHatFocusView(rollback.previousView);
        sampleHatTransitioningRef.current = false;
        setSampleHatTransitioning(false);
        setNotice(tr("demo.hatSwitchFailed"));
      });
    }
    if (demo) captureDemoAction("switch_role", entry.view);
    // A resumed address navigates in the same urgent update as the hat, as
    // a search result does: inside the transition the gate would see the new
    // hat on the old view and send a rail shell to the desk overview.
    if (entry.key === "member" || resume) navigate(destinationView, path, null, { guarded: true });
    else startViewTransition(() => navigate(destinationView, path, null, { guarded: true }));
    // The desktop rail uses an explicit request/ack boundary while App's
    // deferred staff render catches up. Phone/demo selects call switchHat with
    // only the key and safely ignore both this optional callback and the
    // boolean result.
    if (typeof acknowledge === "function") acknowledge();
    return true;
  }

  function dismissDemoWelcome() {
    setDemoWelcomeOpen(false);
  }

  // Queue a failed idempotent write for replay, on behalf of the member who
  // STARTED it. The entry is refused if the tab's identity changed while the
  // request was failing — args were frozen under the initiating member, and
  // kinds whose executor derives the user from auth.uid() (rsvp, formDraft)
  // would otherwise replay one member's write under another's account.
  // Best-effort: any storage trouble reports "not queued" and the original
  // error surfaces as before.
  async function enqueueOffline(queueable, actingUserId) {
    return memberOperation.run(async () => {
    try {
      if (!actingUserId || sessionRef.current?.user?.id !== actingUserId) return false;
      // Stamped with the generation this operation BEGAN under, not with
      // whatever is live by the time a failed request gets here: a write the
      // departing member started is the departing member's residue.
      const queued = await memberOperation.wait(enqueueWrite(
        outboxStoreRef.current,
        actingUserId,
        queueable,
        Date.now(),
        sessionStamp(memberOperation.generation, undefined, memberOperation.sessionLineage),
        memberOperation.isCurrent,
        () => appAuthStorageSessionLineage(appAuthStorageKey),
      ));
      if (queued) {
        const remaining = await memberOperation.wait(pendingCount(outboxStoreRef.current, actingUserId));
        setPendingSync(remaining);
      }
      return queued;
    } catch { memberOperation.assertCurrent();
      return false;
    }
      });
  }

  // `queueable` marks the write as replay-safe: {kind, key, args} with args
  // frozen now. Only network-shaped failures queue — a server rejection still
  // throws so the member sees the real answer.
  // demoApply: the write's demo twin. In demo mode the network write never
  // runs, so a caller that wants its result VISIBLE hands mutate a local
  // updater (usually a setData over the fixtures) and gets its return value
  // back, with the real success toast — the change on screen is now true.
  // Callers without one get an honest "nothing was saved" toast instead of
  // the old success lie that made every demo control look broken.
  // onRefreshFailed: the write LANDED but the follow-up reload did not, so
  // `data` still predates it. A caller that can make its committed row
  // visible from local state does so here — without it, a saved Compass
  // exchange selected by its returned thread id renders a blank sheet.
  async function mutate(...args) {
    return (await mutateWithOutcome(...args))?.value;
  }

  // Guide handlers need the outcome of their own invocation. Ordinary callers
  // keep mutate's raw return value, including null for an offline queue entry.
  async function mutateWithOutcome(affectedResources, work, success, queueable = null, demoApply = null, onRefreshFailed = null, failureNoticeKey = null) {
    return memberOperation.run(async () => {
    if (demoActive) {
      if (!demoApply) { setNotice(tr("toast.demoNoWrite")); return { status: "not_saved", value: null }; }
      const applied = demoApply();
      captureDemoAction("demo_mutation", view);
      setNotice(success);
      return { status: "committed", value: applied };
    }
    // Identity is bound when the write STARTS, not when it fails: a slow
    // request can outlive a session switch, and the failure-time session is
    // then the wrong member to file the entry under.
    const actingSession = sessionRef.current;
    const actingUserId = actingSession?.user?.id;
    // When the write began: a confirmed discard voids a form save begun
    // before it, however late that save fails ( final r6s1).
    const startedAt = Date.now();
    let result;
    try {
      result = await memberOperation.wait(work());
    } catch (error) { memberOperation.assertCurrent();
      if (queueable && isOfflineError(error) && (await memberOperation.wait(enqueueOffline({ ...queueable, startedAt }, actingUserId)))) {
        setNotice(tr("offline.queued"));
        captureProductAction("queued_offline");
        return { status: "queued", value: null };
      }
      // Keep the original refusal for the caller. The toast uses catalogue copy.
      setNotice(mutationFailureNotice(tr, error, failureNoticeKey));
      throw error;
    }
    try {
      await memberOperation.wait(refresh(actingSession, affectedResources));
    } catch (error) { memberOperation.assertCurrent();
      // The write LANDED and only the follow-up read did not, so the member is
      // owed the reason in their own language — not the driver's sentence. The
      // raw failure goes to the sanitized diagnostic channel  added for
      // the authenticated shell load, which carries the code and the error name
      // and never the message text.
      captureSanitizedDiagnostic({ kind: "member_mutation_refresh_failure", code: error?.code, name: error?.name });
      setDataError(isRequestTimeoutError(error) ? tr("error.requestTimedOut") : tr("toast.reloadFailed"));
      setNotice(tr("toast.refreshHint", { message: success }));
      // The fallback is cosmetic (the write is committed either way), so its
      // own failure must not turn a successful save into a thrown error.
      if (onRefreshFailed) { try { onRefreshFailed(result); } catch { memberOperation.assertCurrent(); /* noop */ } }
      return { status: "committed", value: result };
    }
    setNotice(success, learningToastAction(learningPeriod, tr));
    captureProductAction("save");
    return { status: "committed", value: result };
      });
  }

  function handlePlanAction(item) {
    // Belt to TodayView's disabled braces: a closed ballot/pulse never opens
    // the choice dialog, no matter how the click arrives. The server would
    // refuse the write anyway — this just keeps the refusal out of the UX.
    if (item.closed) return;
    if (item.kind === "lesson") navigate("rights", "/m/rights");
    // An organization survey is answered in Voice, the same route the
    // quarterly survey banner opens.
    else if (item.kind === "organization_survey") navigate("voice", `/m/voice?survey=${encodeURIComponent(item.id)}`);
    else setActivePlan(item);
  }

  // Demo twin bookkeeping for a counted action. Union Ground has no points
  // economy, so an action only advances the "actions this year" count the
  // reports and the Work widget read; the server recomputes it on refresh.
  function countDemoAction(rewards) {
    if (!rewards || rewards.actionsYtd == null) return rewards;
    return { ...rewards, actionsYtd: rewards.actionsYtd + 1 };
  }

  // The demo steward desk's cached clone, initialised on first touch from
  // whichever side reaches it first — the panel's loadAppointments or a
  // member-side booking twin. One copy, or hat-switching shows two truths
  // (the sol-review divergence finding).
  function demoApptDesk() {
    if (!demoApptDeskRef.current && demoData()) {
      demoApptDeskRef.current = JSON.parse(JSON.stringify(demoData().stewardApptDesk));
    }
    return demoApptDeskRef.current;
  }

  // Demo label twin for an appointment row: the live labels come from
  // loadMemberApp's cached formatters, the demo computes the same shapes
  // locally so a booked row renders identically.
  function demoAppointmentLabels(startsAt, endsAt) {
    const locale = localeFor(lang);
    return {
      dateLabel: new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric" }).format(new Date(startsAt)),
      timeLabel: dateTimeFormat(lang, { hour: "numeric", minute: "2-digit" }).format(new Date(startsAt)),
      endTimeLabel: dateTimeFormat(lang, { hour: "numeric", minute: "2-digit" }).format(new Date(endsAt)),
    };
  }

  async function handleBookAppointment(fields) {
    return memberOperation.run(async () => {
    // Not queueable on purpose (like ballots): replaying a stale booking after
    // hours offline could land on a slot the member no longer wants.
    return mutate(
      memberMutationResources("bookAppointment"), () => bookAppointment(sessionDataClient, fields),
      tr("toast.apptBooked"),
      null,
      () => {
        const startsAt = fields.startsAt;
        const endsAt = new Date(new Date(startsAt).getTime() + fields.duration * 60000).toISOString();
        const stewards = data.apptStewards || [];
        const chosen = fields.stewardId ? stewards.find((row) => row.id === fields.stewardId) : stewards[0];
        const booked = {
          id: `demo-appt-${Date.now()}`,
          stewardId: chosen?.id || "demo-steward",
          stewardName: chosen?.name || "Sam Okafor",
          type: fields.type,
          durationMinutes: fields.duration,
          startsAt,
          endsAt,
          status: "confirmed",
          reasonCategory: fields.reason,
          routedVia: fields.stewardId ? "steward" : "chapter",
          ...demoAppointmentLabels(startsAt, endsAt),
        };
        setData((current) => ({ ...current, appointments: [booked, ...(current.appointments || [])] }));
        // Mirror onto the demo steward desk so switching hats shows the
        // booking arriving — the toast is only honest if the appointment
        // exists somewhere a visitor can see it land.
        const desk = demoApptDesk();
        if (desk) {
          desk.upcoming = [...(desk.upcoming || []), {
            id: booked.id,
            memberName: data.member?.fullName || "Demo member",
            type: booked.type,
            durationMinutes: booked.durationMinutes,
            startsAt: booked.startsAt,
            endsAt: booked.endsAt,
            status: "confirmed",
            reasonCategory: booked.reasonCategory,
            routedVia: booked.routedVia,
          }].sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
        }
        return booked;
      },
    );
      });
  }

  async function handleCancelAppointment(appointmentId) {
    return memberOperation.run(async () => {
    return mutate(
      memberMutationResources("cancelAppointment"), () => cancelAppointment(sessionDataClient, appointmentId),
      tr("toast.apptCancelled"),
      null,
      () => {
        setData((current) => ({
          ...current,
          appointments: (current.appointments || []).map((item) =>
            item.id === appointmentId ? { ...item, status: "cancelled" } : item),
        }));
        const desk = demoApptDesk();
        const mirrored = desk && (desk.upcoming || []).find((row) => row.id === appointmentId);
        if (mirrored) {
          desk.upcoming = desk.upcoming.filter((row) => row.id !== appointmentId);
          desk.recent = [{ ...mirrored, status: "cancelled" }, ...(desk.recent || [])];
        }
        return { id: appointmentId, status: "cancelled" };
      },
    );
      });
  }

  async function handleRescheduleAppointment(appointmentId, startsAt) {
    return memberOperation.run(async () => {
    return mutate(
      memberMutationResources("rescheduleAppointment"), () => rescheduleAppointment(sessionDataClient, appointmentId, startsAt),
      tr("toast.apptRescheduled"),
      null,
      () => {
        let moved = null;
        setData((current) => ({
          ...current,
          appointments: (current.appointments || []).map((item) => {
            if (item.id !== appointmentId) return item;
            const endsAt = new Date(new Date(startsAt).getTime() + item.durationMinutes * 60000).toISOString();
            moved = { ...item, startsAt, endsAt, ...demoAppointmentLabels(startsAt, endsAt) };
            return moved;
          }),
        }));
        const desk = demoApptDesk();
        if (desk && moved) {
          desk.upcoming = (desk.upcoming || []).map((row) =>
            row.id === appointmentId ? { ...row, startsAt: moved.startsAt, endsAt: moved.endsAt } : row)
            .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
        }
        return moved;
      },
    );
      });
  }

  async function handleRsvp(eventId, status) {
    return memberOperation.run(async () => {
    const base = status === "going" ? tr("toast.rsvpSaved") : tr("toast.rsvpUpdated");
    // Queueable: rsvp_to_event upserts and dedupes its action log
    // server-side (on-conflict-do-nothing), so a replay that raced a landed
    // original is a no-op. The demo twin counts a first "going" once, the
    // same way.
    const alreadyGoing = (data.events || []).find((item) => item.id === eventId)?.rsvpStatus === "going";
    const counted = status === "going" && !alreadyGoing;
    const outcome = await memberOperation.wait(mutateWithOutcome(
      memberMutationResources("submitEventRsvp"), () => submitEventRsvp(sessionDataClient, eventId, status),
      base,
      { kind: "rsvp", key: eventId, args: { eventId, status } },
      () => {
        setData((current) => ({
          ...current,
          events: (current.events || []).map((item) => item.id === eventId ? { ...item, rsvpStatus: status } : item),
          rewards: counted ? countDemoAction(current.rewards) : current.rewards,
        }));
        return { demo: true };
      },
    ));
    return outcome;
      });
  }

  async function handleCheckIn(eventId, code) {
    return memberOperation.run(async () => {
    // Demo twin: any code checks in (the demo mints its own), counting the
    // action once, like the server's on-conflict dedupe.
    const alreadyIn = (data.events || []).find((item) => item.id === eventId)?.checkedIn;
    const result = await memberOperation.wait(mutate(
      memberMutationResources("checkInToEvent"), () => checkInToEvent(sessionDataClient, eventId, code),
      tr("toast.checkedIn"),
      null,
      () => {
        if (alreadyIn) return { alreadyCheckedIn: true };
        setData((current) => ({
          ...current,
          events: (current.events || []).map((item) => item.id === eventId ? { ...item, checkedIn: true } : item),
          rewards: countDemoAction(current.rewards),
        }));
        return { checkedIn: true };
      },
      null,
      "toast.saveFailed",
    ));
    if (result?.alreadyCheckedIn) setNotice(tr("toast.alreadyCheckedIn"));
    return result;
      });
  }

  // Signed check-in code: a pure RPC read, not a mutate() write — the minted
  // token is never part of the member-data snapshot, so there is nothing to
  // refresh and the plaintext must flow straight back to the code tile.
  async function handleRequestCheckinCode(eventId) {
    return memberOperation.run(async () => {
    if (demoActive) {
      return { token: "DEM0246", expiresAt: new Date(Date.now() + 90000).toISOString(), ttlSeconds: 90 };
    }
    try {
      return await memberOperation.wait(requestEventCheckinToken(sessionDataClient, eventId));
    } catch (error) { memberOperation.assertCurrent();
      setNotice(rpcErrorKeyStrict(error, "toast.saveFailed"));
      return null;
    }
      });
  }
  // Calendar feed link: status is checked without reading the bearer token.
  const demoCalendarFeed = useRef(null);
  const loadCalendarFeedStatus = useCallback(() => memberOperation.run(async () => {
    if (demoActive) return demoCalendarFeed.current === memberOperation;
    try {
      return await memberOperation.wait(getCalendarFeedStatus(sessionDataClient));
    } catch (error) {
      memberOperation.assertCurrent();
      throw error;
    }
  }), [demoActive, memberOperation, sessionDataClient, sharedPersonaSession]);
  const calendarFeedScope = JSON.stringify([memberOperation.userId, memberSessionLineage, sessionGeneration, sessionRestricted, demoActive]);

  // Mint is the only response that supplies the bearer token.
  async function handleCalendarRotate() {
    return memberOperation.run(async () => {
    if (demoActive) {
      demoCalendarFeed.current = memberOperation;
      setNotice(tr("toast.calendarLinkCreated"));
      return { token: "demo".repeat(12) };
    }
    return mutate(memberMutationResources("rotateCalendarFeedToken"), () => rotateCalendarFeedToken(sessionDataClient), tr("toast.calendarLinkCreated"));
      });
  }

  async function handleCalendarRevoke() {
    return memberOperation.run(async () => {
    if (demoActive) {
      demoCalendarFeed.current = null;
      setNotice(tr("toast.calendarLinkRevoked"));
      return { revoked: true };
    }
    return mutate(memberMutationResources("revokeCalendarFeedToken"), () => revokeCalendarFeedToken(sessionDataClient), tr("toast.calendarLinkRevoked"));
      });
  }
  async function handleSubmitWeeklyQuestion(body, options) {
    const cleanedOptions = Array.isArray(options)
      ? options.map((option) => String(option || "").trim()).filter(Boolean)
      : [];
    return memberOperation.run(async () => {
    return mutateWithOutcome(
      memberMutationResources("submitWeeklyQuestion"),
      // submit_weekly_question(text) has had execute revoked from every role
      // since 20260828220000; submit_weekly_poll_question is the only live
      // submit and it requires two to eight options.
      () => submitWeeklyQuestion(sessionDataClient, body, cleanedOptions),
      tr("toast.weeklyQuestionSubmitted"),
      null,
      () => {
        const created = {
          id: `demo-weekly-question-${Date.now()}`,
          body,
          options: cleanedOptions,
          editorialState: "submitted",
          submittedByMe: true,
          boostedByMe: false,
          priority: false,
          score: 0,
          createdAt: new Date().toISOString(),
        };
        setData((current) => ({ ...current, weeklyQuestions: [created, ...(current.weeklyQuestions || [])] }));
        return { id: created.id, created: true };
      },
      null,
      // submit_weekly_poll_question does not tokenise its length/option
      // refusals, so without this the toast beside the form's translated
      // alert would still read the English "Submit weekly question: ..." line.
      "bevoice.weeklySubmitFailed",
    );
      });
  }

  async function handleBoostWeeklyQuestion(questionId) {
    return memberOperation.run(async () => {
    return mutate(
      memberMutationResources("boostWeeklyQuestion"), () => boostWeeklyQuestion(sessionDataClient, questionId),
      tr("toast.weeklyQuestionBoosted"),
      null,
      () => {
        const weight = 1;
        setData((current) => ({
          ...current,
          weeklyQuestions: (current.weeklyQuestions || []).map((question) => question.id === questionId
            ? { ...question, boostedByMe: true, score: question.score + weight }
            : question),
        }));
        return { questionId, created: true, weight };
      },
    );
      });
  }

  async function handlePromoteWeeklyQuestion(questionId) {
    return memberOperation.run(async () => {
    return mutate(
      memberMutationResources("promoteWeeklyQuestion"), () => promoteWeeklyQuestion(sessionDataClient, questionId),
      tr("toast.weeklyQuestionPromoted"),
      null,
      () => {
        setData((current) => ({
          ...current,
          weeklyQuestions: (current.weeklyQuestions || []).map((question) => question.id === questionId
            ? { ...question, priority: true, promotedByMe: true, promotionAvailable: false }
            : { ...question, promotionAvailable: false }),
        }));
        return { questionId, promoted: true, promotionCredits: 0 };
      },
    );
      });
  }


  async function handleReportPreferences(config) {
    return memberOperation.run(async () => {
    if (!demoActive) {
      await memberOperation.wait(saveMyReportPreferences(sessionDataClient, config));
      confirmReportPreferences(memberLoaderRef.current, config);
    }
    setData((current) => ({ ...current, reportPreferences: config }));
    return config;
      });
  }

  async function handleLogWork(fields) {
    return memberOperation.run(async () => {
    // Demo twin: count the action so the result card's "Workload logged" and
    // the toast agree instead of contradicting each other ("nothing was
    // saved" next to a success card). No receipt code is
    // minted — WorkloadView's demo branch suppresses the receipt/remaining
    // lines, and demo receipts must never look verifiable. The server's
    // 3-a-day cap is not mirrored; a tour never hits it.
    let result;
    try {
      result = await memberOperation.wait(mutate(
        memberMutationResources("submitWorkloadLog"), () => submitWorkloadLog(sessionDataClient, fields),
        tr("toast.workLogged"),
        null,
        () => {
        setData((current) => ({ ...current, rewards: countDemoAction(current.rewards) }));
        return { demo: true };
        },
      ));
    } catch (error) {
      // REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: the
      // server counts only entries it saved, so a failure re-reads History
      // and today's count rather than leaving them stale.
      if (!demoActive) await refresh(sessionRef.current, memberMutationResources("submitWorkloadLog")).catch(() => {});
      throw error;
    }
    return result;
      });
  }

  async function handleSaveWorkloadReminder(fields) {
    return memberOperation.run(async () => {
    return mutate(
      memberMutationResources("setWorkloadReminderPreferences"), () => setWorkloadReminderPreferences(sessionDataClient, fields),
      tr("workload.remindersSaved"),
      null,
      () => {
        const current = data.workload?.reminders || {};
        const nextDueAt = fields.enabled
          ? (current.nextDueAt || new Date(Date.now() + 7 * 86400000).toISOString())
          : null;
        const saved = { ...current, ...fields, available: true, sample: true, nextDueAt };
        setData((snapshot) => ({
          ...snapshot,
          workload: { ...snapshot.workload, reminders: saved },
        }));
        return saved;
      },
    );
      });
  }

  // TASKS MINT NO POINTS — deliberately, not by omission. Events (+50/+15),
  // forms and workload logs sit right above this handler and each award
  // engagement points; chapter work does not, because Tasks is a staff-only
  // tool and staff actions never mint member points anywhere in this product
  // (open_form_as_case states the same rule server-side). Do not "fix" the
  // asymmetry by adding an award here.
  async function confirmTaskWrite(work, deletedId = null, insert = false) {
    const result = await memberOperation.wait(work());
    const rows = deletedId ? [] : (Array.isArray(result) ? result : [result?.task ?? result]).filter(row => row?.id);
    if (result) memberLoaderRef.current?.confirmProjection(`task-${deletedId ?? rows.map(row => row.id).join("-")}`,
      ["table:chapter_tasks"], current => confirmedTaskProjection(current, rows, { deletedId, insert }));
    return result;
  }

  async function handleCreateTask(fields) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const now = new Date().toISOString();
      const assignee = (data.taskAssignees || []).find((person) => person.id === fields.assigneeId);
      const created = {
        ...fields,
        taskType: fields.taskType || "general",
        assigneeName: assignee?.fullName || "",
        id: globalThis.crypto?.randomUUID?.() || `demo-task-${Date.now()}`,
        chapterId: data.member.chapterId,
        // The server allocates task_number as max()+1 per chapter under an
        // advisory lock; the demo twin mints the same shape so a card created
        // on the tour carries a real key (WOR-9) instead of a blank one — the
        // key is what the board renders and what deep links resolve.
        taskNumber: Math.max(0, ...(data.tasks || []).map((task) => task.taskNumber || 0)) + 1,
        createdBy: data.member.id,
        doneAt: fields.status === "done" ? now : null,
        createdAt: now,
        updatedAt: now,
      };
      setData((current) => ({
        ...current,
        tasks: [...(current.tasks || []), created],
        taskActivity: [...(current.taskActivity || []), {
          id: `demo-activity-${Date.now()}`,
          taskId: created.id,
          chapterId: created.chapterId,
          actorId: data.member.id,
          action: "created",
          fromValue: null,
          toValue: "to_do",
          createdAt: now,
        }],
      }));
      setNotice(tr("toast.taskCreated"));
      return created;
    }
    const created = await memberOperation.wait(mutate(memberMutationResources("createChapterTask"), () => confirmTaskWrite(() => createChapterTask(sessionDataClient, fields), null, true), tr("toast.taskCreated")));
    if (created) {
      setData((current) => {
        const list = current.tasks || [];
        const existing = list.find((task) => task.id === created.id);
        // The INSERT broadcast can outrun this response, and a follow-up move
        // can already have landed on top of it: same last-write-wins rule as
        // the live board events, or the response snaps the new card back to
        // its creation state.
        if (localTaskRowWins(existing, created)) return current;
        return {
          ...current,
          tasks: existing ? list.map((task) => (task.id === created.id ? created : task)) : [...list, created],
        };
      });
    }
    return created;
      });
  }

  //: a live General task becomes a specialized type in place. Preview
  // and demo sessions keep the explain-and-offer path (no handler).
  async function handleConvertTaskToTemplate(conversion) {
    return memberOperation.run(async () => {
      const result = await memberOperation.wait(mutate(
        memberMutationResources("convertChapterTaskToTemplate"), () => confirmTaskWrite(() => convertChapterTaskToTemplate(sessionDataClient, conversion), null, true),
        tr("toast.taskUpdated"),
      ));
      if (!result?.task || !result?.details) return result;
      setData((current) => applyTaskConversionResult(current, result));
      // The editor reads the returned task too: same assignee projection.
      const current = dataRef.current || {};
      return { ...result, task: withTaskAssignees(result.task, current.taskAssignments || [], current.taskAssignees || []) };
    });
  }

  async function handleCreateTaskFromTemplate(fields) {
    return memberOperation.run(async () => {
    if (!demoActive) {
      const result = await memberOperation.wait(mutate(
        memberMutationResources("createChapterTaskFromTemplate"), () => confirmTaskWrite(() => createChapterTaskFromTemplate(sessionDataClient, fields), null, true),
        tr("toast.taskCreated"),
      ));
      if (result?.task && result?.details) {
        setData((current) => ({
          ...current,
          tasks: [...(current.tasks || []).filter((task) => task.id !== result.task.id), result.task],
          taskTemplateDetails: [
            ...(current.taskTemplateDetails || []).filter((detail) => detail.taskId !== result.details.taskId),
            result.details,
          ],
        }));
      }
      return result;
    }

    const current = dataRef.current;
    const template = (current.taskTemplates || []).find((item) => item.key === fields.templateKey);
    const values = templateFieldsToPayload(template, fields.fields || {}, current.taskTemplates || []);
    const validation = validateTaskTemplateValues(template, values, current.taskTemplates || []);
    if (!template || !validation.valid) throw new Error("Template fields invalid");
    const now = new Date().toISOString();
    const id = globalThis.crypto?.randomUUID?.() || `demo-template-task-${Date.now()}`;
    const scheduledOn = values.scheduled_on || null;
    const followUpOn = values.follow_up_on || null;
    const occurredOn = values.occurred_on || null;
    const initialStep = template.flow[0]?.key;
    const created = {
      id,
      chapterId: current.member.chapterId,
      taskNumber: Math.max(0, ...(current.tasks || []).map((task) => task.taskNumber || 0)) + 1,
      title: fields.title.trim(),
      description: checklistDescription(template, "en"),
      status: template.defaultStatus,
      priority: template.defaultPriority,
      taskType: template.key,
      workstream: fields.workstream,
      assigneeId: null,
      assigneeName: "",
      startDate: template.key === "meeting_event" ? scheduledOn : template.key === "issue_incident" ? occurredOn : null,
      dueDate: template.key === "meeting_event" ? scheduledOn : template.key === "member_follow_up" ? followUpOn : null,
      progress: 0,
      blocked: false,
      milestone: false,
      orderIndex: Math.max(0, ...(current.tasks || []).filter((task) =>
        task.workstream === fields.workstream && task.status === template.defaultStatus).map((task) => task.orderIndex || 0)) + 1000,
      createdBy: current.member.id,
      updatedBy: current.member.id,
      doneAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const details = {
      ...taskTemplateDetailsFromValues(template.key, values),
      taskId: id,
      chapterId: current.member.chapterId,
      flowStep: initialStep,
      createdBy: current.member.id,
      updatedBy: current.member.id,
      createdAt: now,
      updatedAt: now,
    };
    setData((snapshot) => ({
      ...snapshot,
      tasks: [...(snapshot.tasks || []), created],
      taskTemplateDetails: [...(snapshot.taskTemplateDetails || []), details],
      taskActivity: [...(snapshot.taskActivity || []), {
        id: `demo-template-activity-${Date.now()}`,
        taskId: id,
        chapterId: current.member.chapterId,
        actorId: current.member.id,
        action: "created",
        fromValue: null,
        toValue: template.defaultStatus,
        createdAt: now,
      }],
    }));
    setNotice(tr("toast.taskCreated"));
    return { task: created, details };
      });
  }

  async function handleUpdateTaskTemplateDetails(fields) {
    return memberOperation.run(async () => {
    if (!demoActive) {
      const result = await memberOperation.wait(mutate(
        memberMutationResources("updateChapterTaskTemplateDetails"), () => confirmTaskWrite(() => updateChapterTaskTemplateDetails(sessionDataClient, fields)),
        tr("toast.taskUpdated"),
      ));
      if (result?.task && result?.details) {
        setData((current) => ({
          ...current,
          tasks: (current.tasks || []).map((task) => task.id === result.task.id ? result.task : task),
          taskTemplateDetails: (current.taskTemplateDetails || []).map((detail) =>
            detail.taskId === result.details.taskId ? result.details : detail),
        }));
      }
      return result;
    }

    const current = dataRef.current;
    const task = (current.tasks || []).find((item) => item.id === fields.taskId);
    const oldDetails = (current.taskTemplateDetails || []).find((item) => item.taskId === fields.taskId);
    const template = (current.taskTemplates || []).find((item) => item.key === oldDetails?.templateKey);
    if (!task || !oldDetails || !template) throw new Error("Template unavailable");
    const values = {
      ...taskTemplateValuesFromDetails(oldDetails),
      ...(fields.fields || {}),
    };
    const payload = templateFieldsToPayload(template, values, current.taskTemplates || []);
    const validation = validateTaskTemplateValues(template, payload, current.taskTemplates || []);
    if (!validation.valid) throw new Error("Template fields invalid");
    const nextStep = fields.nextFlowStep || oldDetails.flowStep;
    if (nextStep !== oldDetails.flowStep
        && !nextTemplateSteps(template, oldDetails.flowStep).some((step) => step.key === nextStep)) {
      throw new Error("Template flow transition invalid");
    }
    const now = new Date().toISOString();
    const recommendedStatus = recommendedStatusForStep(template, nextStep);
    const nextTask = {
      ...task,
      status: fields.applyRecommendedStatus && nextStep !== oldDetails.flowStep ? recommendedStatus : task.status,
      startDate: template.key === "meeting_event" ? payload.scheduled_on
        : template.key === "issue_incident" ? payload.occurred_on : null,
      dueDate: template.key === "meeting_event" ? payload.scheduled_on
        : template.key === "member_follow_up" ? payload.follow_up_on : null,
      updatedBy: current.member.id,
      updatedAt: now,
    };
    const nextDetails = {
      ...oldDetails,
      ...taskTemplateDetailsFromValues(template.key, payload),
      flowStep: nextStep,
      updatedBy: current.member.id,
      updatedAt: now,
    };
    const flowChanged = nextStep !== oldDetails.flowStep;
    setData((snapshot) => ({
      ...snapshot,
      tasks: (snapshot.tasks || []).map((item) => item.id === task.id ? nextTask : item),
      taskTemplateDetails: (snapshot.taskTemplateDetails || []).map((item) => item.taskId === task.id ? nextDetails : item),
      taskActivity: flowChanged ? [...(snapshot.taskActivity || []), {
        id: `demo-template-flow-${Date.now()}`,
        taskId: task.id,
        chapterId: task.chapterId,
        actorId: current.member.id,
        action: "template_flow_changed",
        fromValue: oldDetails.flowStep,
        toValue: nextStep,
        createdAt: now,
      }] : (snapshot.taskActivity || []),
    }));
    setNotice(tr("toast.taskUpdated"));
    return { task: nextTask, details: nextDetails };
      });
  }

  async function handleCreateTaskFromSource(sourceKind, sourceId) {
    return memberOperation.run(async () => {
    if (!explicitHatAllowsView(selectedStaffHatRef.current, "tasks", demo, dataRef.current?.roles || [], !railShell, "/m/tasks")) {
      throw new Error("Task creation unavailable for the selected identity");
    }
    if (!demoActive) {
      const reference = sourceKind === "message" ? { kind: "private_message", id: sourceId, chapterId: dataRef.current?.member?.chapterId } : null;
      const result = await mutate(
        memberMutationResources("createChapterTaskFromSource"), () => confirmTaskWrite(() => reference ? connectedWorkflowApi.createTask(reference) : createChapterTaskFromSource(sessionDataClient, sourceKind, sourceId), null, true),
        tr("toast.taskCreated"),
      );
      return result?.task ? { ...result, task: { ...result.task, workflowSource: reference, workflowReturnHref: result.attachment?.recordUrl } } : result;
    }

    const requestKey = `${sourceKind}\u001f${sourceId}`;
    const cachedOutcome = demoSourceTaskOutcomesRef.current.get(requestKey);
    if (cachedOutcome) return { ...cachedOutcome, created: false };
    const current = dataRef.current;
    const existingAttachment = (current.taskAttachments || []).find((item) =>
      item.sourceKind === sourceKind && item.sourceId === sourceId);
    if (existingAttachment) {
      return {
        task: (current.tasks || []).find((item) => item.id === existingAttachment.taskId),
        attachment: existingAttachment,
        created: false,
      };
    }
    const titles = {
      message: "Follow up on member message",
      broadcast: "Review chapter broadcast",
      notification: "Review notification",
      survey: "Follow up on survey",
      case: "Follow up on grievance",
      event: "Follow up on event",
      channel_post: "Follow up on channel post",
    };
    const labels = {
      message: "Authorized member message",
      broadcast: "Authorized chapter broadcast",
      notification: "Authorized notification",
      survey: "Authorized survey",
      case: "Authorized grievance",
      event: "Authorized calendar event",
      channel_post: "Authorized channel post",
    };
    const routes = {
      message: exactMessageHref({ conversationId: (current.conversations || []).find((conversation) =>
        (conversation.messages || []).some((message) => message.id === sourceId))?.id || new URLSearchParams(window.location.search).get("thread"),
      messageId: sourceId, chapterId: current.member.chapterId, organizationId: current.member.organizationId, staff: window.location.pathname === "/m/steward" }),
      broadcast: `/m/messages?broadcast=${sourceId}`,
      notification: `/m/messages?notification=${sourceId}`,
      survey: `/m/voting?survey=${sourceId}`,
      case: `/m/cases?case=${sourceId}`,
      event: `/m/events?event=${encodeURIComponent(sourceId)}`,
      channel_post: `/m/messages?channel=${encodeURIComponent((current.product?.spaces || []).flatMap((space) => space.threads || []).find((thread) => thread.posts?.some((post) => post.id === sourceId))?.id || "")}&post=${encodeURIComponent(sourceId)}`,
    };
    const availableWorkstreams = (current.workstreams || []).length
      ? current.workstreams
      : [...new Set((current.tasks || []).map((item) => item.workstream).filter(Boolean))]
        .map((name) => ({ id: name, name }));
    const workstream = [...availableWorkstreams]
      .sort((a, b) => Number(b.name.trim().toLowerCase() === "general") - Number(a.name.trim().toLowerCase() === "general")
        || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0];
    if (!workstream || !titles[sourceKind]) throw new Error("Task source unavailable");
    const now = new Date().toISOString();
    const nonce = globalThis.crypto?.randomUUID?.() || `${Date.now()}`;
    const task = {
      id: `demo-source-task-${nonce}`,
      chapterId: current.member.chapterId,
      taskNumber: Math.max(0, ...(current.tasks || []).map((item) => item.taskNumber || 0)) + 1,
      title: titles[sourceKind], description: "", status: "to_do", priority: "medium",
      taskType: "general", workstream: workstream.name, assigneeId: null, assigneeName: "",
      startDate: null, dueDate: null, progress: 0, blocked: false, milestone: false,
      orderIndex: 0, createdBy: current.member.id, updatedBy: current.member.id,
      doneAt: null, createdAt: now, updatedAt: now,
      workflowReturnHref: routes[sourceKind],
    };
    const attachment = {
      id: `demo-source-attachment-${nonce}`, taskId: task.id, chapterId: task.chapterId,
      label: labels[sourceKind], recordUrl: routes[sourceKind], createdBy: current.member.id,
      sourceKind, sourceId, createdAt: now, updatedAt: now,
    };
    setData((latest) => ({
      ...latest,
      tasks: [...(latest.tasks || []), task],
      taskAttachments: [...(latest.taskAttachments || []), attachment],
      taskActivity: [
        { id: `demo-source-created-${nonce}`, taskId: task.id, chapterId: task.chapterId, actorId: current.member.id, action: "created", fromValue: null, toValue: "to_do", createdAt: now },
        { id: `demo-source-linked-${nonce}`, taskId: task.id, chapterId: task.chapterId, actorId: current.member.id, action: "attachment_added", fromValue: null, toValue: attachment.id, createdAt: now },
        ...(latest.taskActivity || []),
      ],
    }));
    demoSourceTaskOutcomesRef.current.set(requestKey, { task, attachment });
    setNotice(tr("toast.taskCreated"));
    return { task, attachment, created: true };
      });
  }

  async function handleOpenSourceTask(task, source = null) {
    return memberOperation.run(async () => {
      const startingHat = selectedStaffHatRef.current;
      if (!explicitHatAllowsView(startingHat, "tasks", demo, dataRef.current?.roles || [], !railShell, "/m/tasks")) return;
      if (!demoActive && task?.workflowSource) {
        const source = await memberOperation.wait(connectedWorkflowApi.context(task.workflowSource));
        if (!source.available || source.linkedTask?.id !== task.id) throw new Error("Source unavailable");
      }
      const current = demoActive
        ? dataRef.current?.tasks?.find((row) => row.id === task?.id)
        : await memberOperation.wait(loadAuthorizedChapterTask(supabase, task?.id));
      if (!memberOperation.isCurrent() || selectedStaffHatRef.current !== startingHat) return;
      //: a task that was deleted or is in another chapter is reported to
      // the opener, never a silent return, so every caller can say so.
      if (!current || current.chapterId !== dataRef.current?.member?.chapterId) throw Object.assign(new Error("Task unavailable"), { code: "task_unavailable" });
      if (!explicitHatAllowsView(startingHat, "tasks", demo, dataRef.current?.roles || [], !railShell, "/m/tasks")) return;
      setData((snapshot) => ({ ...snapshot, tasks: [...(snapshot.tasks || []).filter((row) => row.id !== current.id), current] }));
      const href = `/m/tasks?task=${encodeURIComponent(current.id)}`;
      const messageReturn = source?.sourceKind === "message" ? exactMessageHref({
        conversationId: source.conversationId, messageId: source.sourceId,
        chapterId: dataRef.current?.member?.chapterId, organizationId: dataRef.current?.member?.organizationId,
        staff: window.location.pathname === "/m/steward",
      }) : null;
      navigateStaff("tasks", withWorkflowReturn(href, messageReturn || task.workflowReturnHref || window.location.pathname + window.location.search));
    });
  }

  async function handleUpdateTask(taskId, fields, expectedUpdatedAt = null) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const now = new Date().toISOString();
      const assignee = Object.hasOwn(fields, "assigneeId")
        ? (data.taskAssignees || []).find((person) => person.id === fields.assigneeId)
        : null;
      let updated = null;
      setData((current) => {
        const activity = [];
        const tasks = (current.tasks || []).map((task) => {
          if (task.id !== taskId) return task;
          updated = {
            ...task,
            ...fields,
            ...(Object.hasOwn(fields, "assigneeId") ? { assigneeName: assignee?.fullName || "" } : {}),
            progress: fields.status === "done" ? 100 : (fields.progress ?? task.progress),
            doneAt: fields.status === "done" ? (task.doneAt || now) : fields.status ? null : task.doneAt,
            updatedAt: now,
          };
          const tracked = [
            ["status", "status_changed"],
            ["assigneeId", "assignee_changed"],
            ["taskType", "type_changed"],
            ["workstream", "board_changed"],
          ];
          for (const [field, action] of tracked) {
            if (Object.hasOwn(fields, field) && fields[field] !== task[field]) {
              activity.push({
                id: `demo-activity-${action}-${Date.now()}-${activity.length}`,
                taskId,
                chapterId: task.chapterId,
                actorId: data.member.id,
                action,
                fromValue: task[field] == null ? null : String(task[field]),
                toValue: fields[field] == null ? null : String(fields[field]),
                createdAt: now,
              });
            }
          }
          if (Object.hasOwn(fields, "blocked") && fields.blocked !== task.blocked) {
            activity.push({
              id: `demo-activity-blocked-${Date.now()}`,
              taskId,
              chapterId: task.chapterId,
              actorId: data.member.id,
              action: fields.blocked ? "blocked" : "unblocked",
              fromValue: null,
              toValue: null,
              createdAt: now,
            });
          }
          return updated;
        });
        return { ...current, tasks, taskActivity: [...activity, ...(current.taskActivity || [])] };
      });
      setNotice(tr("toast.taskUpdated"));
      return updated;
    }
    const updated = await memberOperation.wait(mutate(
      memberMutationResources("updateChapterTask"), () => confirmTaskWrite(() => updateChapterTask(sessionDataClient, taskId, fields, expectedUpdatedAt)),
      tr("toast.taskUpdated"),
    ));
    if (updated) {
      setData((current) => ({
        ...current,
        // NOT unconditional: two rapid writes can commit A then B server-side
        // yet deliver their responses B then A, and both broadcasts may have
        // landed already — the stale A response must not overwrite B. Same
        // last-write-wins comparison as the live board events; a row a delete
        // broadcast removed mid-flight stays gone (map, never re-add).
        tasks: (current.tasks || []).map((task) =>
          (task.id === taskId && !localTaskRowWins(task, updated) ? updated : task)),
      }));
    }
    return updated;
      });
  }

  async function handleSetTaskAssignees(taskId, assigneeIds) {
    return memberOperation.run(async () => {
    const ids = [...new Set((assigneeIds || []).filter(Boolean))].slice(0, 12);
    const applySelection = (current, replaceAssignments) => {
      const now = new Date().toISOString();
      const names = ids
        .map((id) => (current.taskAssignees || []).find((person) => person.id === id)?.fullName || "")
        .filter(Boolean);
      const taskAssignments = replaceAssignments ? [
          ...(current.taskAssignments || []).filter((assignment) => assignment.taskId !== taskId),
          ...ids.map((assigneeId, position) => ({
            id: `local-assignment-${taskId}-${assigneeId}`,
            taskId,
            chapterId: current.member.chapterId,
            assigneeId,
            position,
            assignedAt: now,
          })),
        ] : (current.taskAssignments || []);
      return {
        ...current,
        taskAssignments,
        tasks: (current.tasks || []).map((task) => task.id === taskId ? {
          ...task,
          assigneeIds: ids,
          assigneeNames: names,
          assigneeId: ids[0] || null,
          assigneeName: names[0] || "",
          updatedAt: demoActive ? now : task.updatedAt,
        } : task),
      };
    };

    if (demoActive) {
      setData((current) => applySelection(current, true));
      setNotice(tr("toast.taskUpdated"));
      return { taskId, assigneeIds: ids };
    }

    const result = await memberOperation.wait(mutate(
      memberMutationResources("setChapterTaskAssignees"), async () => {
        const saved = await memberOperation.wait(setChapterTaskAssignees(sessionDataClient, taskId, ids));
        memberLoaderRef.current?.confirmProjection(`task-assignees-${taskId}`,
          ["table:chapter_task_assignments", "table:chapter_tasks"], current => applySelection(current, true));
        return saved;
      },
      tr("toast.taskUpdated"),
    ));
    // The provider broadcasts authoritative assignment rows. Preserve any
    // rows already delivered while the RPC was in flight; synthetic local
    // IDs would otherwise survive beside the provider IDs as duplicates.
    if (result) setData((current) => applySelection(current, false));
    return result;
      });
  }

  async function handleMoveTask(taskId, target, expectedUpdatedAt = null) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const updated = await memberOperation.wait(handleUpdateTask(taskId, {
        workstream: target.workstream,
        status: target.status,
        orderIndex: target.orderIndex,
      }, expectedUpdatedAt));
      return updated ? [updated] : [];
    }
    const rows = await memberOperation.wait(mutate(
      memberMutationResources("moveChapterTask"), () => confirmTaskWrite(() => moveChapterTask(sessionDataClient, taskId, target, expectedUpdatedAt)),
      tr("toast.taskUpdated"),
    ));
    if (rows?.length) {
      setData((current) => ({
        ...current,
        // A delete broadcast may remove the moved row while the RPC response
        // is in flight. Mapping existing rows only prevents resurrection.
        tasks: mergeExistingRows(current.tasks, rows, localTaskRowWins),
      }));
    }
    return rows || [];
      });
  }

  // Delete is SOFT (the client's DELETE grant is revoked): the RPC stamps
  // deleted_at/by, the other participant is notified server-side, and the
  // toast carries the Undo the soft delete exists to make possible. The 90-day
  // purge is server-side.
  async function handleDeleteTask(taskId) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const removed = (data.tasks || []).find((task) => task.id === taskId) || null;
      setData((current) => ({ ...current, tasks: (current.tasks || []).filter((task) => task.id !== taskId) }));
      setNotice(tr("tasks.deleteRecoverable"), removed ? {
        label: tr("tasks.undo"),
        focusTarget: () => Array.from(document.querySelectorAll("[data-task-id]"))
          .find((element) => element.dataset.taskId === taskId),
        run: () => {
          setData((current) => ({ ...current, tasks: [...(current.tasks || []), removed] }));
          setNotice(tr("tasks.restored"));
        },
      } : null);
      return { deleted: true };
    }
    const removed = (data.tasks || []).find(task => task.id === taskId);
    const result = await memberOperation.wait(mutate(memberMutationResources("softDeleteChapterTask"), () => confirmTaskWrite(() => softDeleteChapterTask(sessionDataClient, taskId), taskId), tr("tasks.deleteRecoverable")));
    setData((current) => ({
      ...current,
      tasks: (current.tasks || []).filter((task) => task.id !== taskId),
    }));
    if (result) {
      setNotice(tr("tasks.deleteRecoverable"), {
        label: tr("tasks.undo"),
        focusTarget: () => Array.from(document.querySelectorAll("[data-task-id]"))
          .find((element) => element.dataset.taskId === taskId),
        run: () => mutate(memberMutationResources("restoreChapterTask"), () => confirmTaskWrite(async () => {
          const restored = await memberOperation.wait(restoreChapterTask(sessionDataClient, taskId));
          return restored ? removed : null;
        }, null, true), tr("tasks.restored")).catch(() => {
            // mutate() already toasted the failure; the card stays deleted and
            // remains restorable server-side for 90 days.
          }),
      });
    }
    return result;
      });
  }

  // Dependency edges. The server owns the real guards (chapter scope, live
  // endpoints, cycle rejection under the per-chapter advisory lock); the demo
  // twin mirrors only what the modal cannot already see, so the tour behaves
  // like production without a backend.
  async function handleAddTaskDependency(taskId, dependsOnId) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const edges = data.taskDependencies || [];
      if (taskId === dependsOnId || edges.some((edge) => edge.taskId === taskId && edge.dependsOnId === dependsOnId)) return null;
      const edge = {
        id: globalThis.crypto?.randomUUID?.() || `demo-dep-${Date.now()}`,
        chapterId: data.member.chapterId,
        taskId,
        dependsOnId,
        createdAt: new Date().toISOString(),
      };
      setData((current) => ({ ...current, taskDependencies: [...(current.taskDependencies || []), edge] }));
      setNotice(tr("toast.taskDependencyAdded"));
      return edge;
    }
    const created = await memberOperation.wait(mutate(memberMutationResources("createChapterTaskDependency"), () => createChapterTaskDependency(sessionDataClient, taskId, dependsOnId), tr("toast.taskDependencyAdded")));
    if (created) {
      // The INSERT broadcast can outrun this response: dedupe by id, exactly
      // like the reducer, so the echo and the response land as one edge. A
      // null snapshot (session switched mid-flight) applies nothing.
      setData((current) => {
        if (!current) return current;
        const list = current.taskDependencies || [];
        if (list.some((edge) => edge.id === created.id)) return current;
        return { ...current, taskDependencies: [...list, created] };
      });
    }
    return created;
      });
  }

  async function handleRemoveTaskDependency(dependencyId) {
    return memberOperation.run(async () => {
    if (demoActive) {
      setData((current) => ({ ...current, taskDependencies: (current.taskDependencies || []).filter((edge) => edge.id !== dependencyId) }));
      setNotice(tr("toast.taskDependencyRemoved"));
      return { deleted: true };
    }
    const result = await memberOperation.wait(mutate(memberMutationResources("deleteChapterTaskDependency"), () => deleteChapterTaskDependency(sessionDataClient, dependencyId), tr("toast.taskDependencyRemoved")));
    setData((current) => (current ? { ...current, taskDependencies: (current.taskDependencies || []).filter((edge) => edge.id !== dependencyId) } : current));
    return result;
      });
  }
  async function handleCreateTaskSubtask(parentTaskId, title) {
    return memberOperation.run(async () => {
    const parent = (data.tasks || []).find((task) => task.id === parentTaskId);
    if (!parent || !title.trim()) return null;
    const fields = {
      title: title.trim(),
      description: "",
      status: "to_do",
      priority: "medium",
      taskType: "general",
      workstream: parent.workstream,
      assigneeId: null,
      startDate: null,
      dueDate: null,
      progress: 0,
      blocked: false,
      milestone: false,
      orderIndex: 1000000,
    };

    if (demoActive) {
      const task = {
        ...fields,
        id: globalThis.crypto?.randomUUID?.() || `demo-subtask-${Date.now()}`,
        chapterId: data.member.chapterId,
        taskNumber: Math.max(0, ...(data.tasks || []).map((item) => item.taskNumber || 0)) + 1,
        assigneeName: "",
        createdBy: data.member.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const edge = {
        id: globalThis.crypto?.randomUUID?.() || `demo-subtask-edge-${Date.now()}`,
        chapterId: data.member.chapterId,
        parentTaskId,
        subtaskId: task.id,
        createdAt: new Date().toISOString(),
      };
      setData((current) => ({
        ...current,
        tasks: [...(current.tasks || []), task],
        taskSubtasks: [...(current.taskSubtasks || []), edge],
      }));
      setNotice(tr("toast.taskSubtaskAdded"));
      return { task, edge };
    }

    const created = await memberOperation.wait(mutate(memberMutationResources("createChapterTask", "createChapterTaskSubtask", "softDeleteChapterTask"), async () => {
    return memberOperation.run(async () => {
      let task = null;
      try {
        task = await memberOperation.wait(createChapterTask(sessionDataClient, fields));
        const edge = await memberOperation.wait(createChapterTaskSubtask(sessionDataClient, parentTaskId, task.id));
        return { task, edge };
      } catch (error) { memberOperation.assertCurrent();
        if (task?.id) {
          try { await memberOperation.wait(softDeleteChapterTask(sessionDataClient, task.id)); } catch { memberOperation.assertCurrent(); /* preserve the original edge failure */ }
        }
        throw error;
      }
        });
  }, tr("toast.taskSubtaskAdded")));

    if (created) {
      setData((current) => {
        if (!current) return current;
        const tasks = (current.tasks || []).some((item) => item.id === created.task.id)
          ? current.tasks
          : [...(current.tasks || []), created.task];
        const taskSubtasks = (current.taskSubtasks || []).some((item) => item.id === created.edge.id)
          ? current.taskSubtasks
          : [...(current.taskSubtasks || []), created.edge];
        return { ...current, tasks, taskSubtasks };
      });
    }
    return created;
      });
  }

  async function handleRemoveTaskSubtask(linkId) {
    return memberOperation.run(async () => {
    if (demoActive) {
      setData((current) => ({ ...current, taskSubtasks: (current.taskSubtasks || []).filter((edge) => edge.id !== linkId) }));
      setNotice(tr("toast.taskSubtaskRemoved"));
      return { deleted: true };
    }
    const result = await memberOperation.wait(mutate(memberMutationResources("deleteChapterTaskSubtask"), () => deleteChapterTaskSubtask(sessionDataClient, linkId), tr("toast.taskSubtaskRemoved")));
    setData((current) => (current ? { ...current, taskSubtasks: (current.taskSubtasks || []).filter((edge) => edge.id !== linkId) } : current));
    return result;
      });
  }

  async function handleWatchTask(taskId) {
    return memberOperation.run(async () => {
    if (demoActive) {
      setData((current) => ({ ...current, taskWatches: [...(current.taskWatches || []).filter((watch) => watch.taskId !== taskId), { taskId }] }));
      setNotice(tr("toast.taskWatchSaved"));
      return { taskId };
    }
    const watch = await memberOperation.wait(mutate(memberMutationResources("watchChapterTask"), () => watchChapterTask(sessionDataClient, taskId), tr("toast.taskWatchSaved")));
    if (watch) {
      setData((current) => current ? {
        ...current,
        taskWatches: [...(current.taskWatches || []).filter((item) => item.taskId !== taskId), watch],
      } : current);
    }
    return watch;
      });
  }

  async function handleUnwatchTask(taskId) {
    return memberOperation.run(async () => {
    if (demoActive) {
      setData((current) => ({ ...current, taskWatches: (current.taskWatches || []).filter((watch) => watch.taskId !== taskId) }));
      setNotice(tr("toast.taskWatchRemoved"));
      return { taskId };
    }
    const result = await memberOperation.wait(mutate(memberMutationResources("unwatchChapterTask"), () => unwatchChapterTask(sessionDataClient, taskId), tr("toast.taskWatchRemoved")));
    setData((current) => current ? { ...current, taskWatches: (current.taskWatches || []).filter((watch) => watch.taskId !== taskId) } : current);
    return result;
      });
  }


  // The report never joins the app-load path: it is fetched when the Report
  // view asks, and the demo computes the same shape from its fixtures so the
  // tour can narrate the screen without a backend.
  async function handleLoadTaskReport(from = null, to = null) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const rangeFrom = from || "2000-01-01";
      const rangeTo = to || new Date().toISOString().slice(0, 10);
      const scoped = (data.tasks || []).filter((task) =>
        String(task.createdAt || "").slice(0, 10) <= rangeTo
        && (!task.doneAt || String(task.doneAt).slice(0, 10) >= rangeFrom)
        && task.dueDate >= rangeFrom);
      const doneRows = scoped.filter((task) => task.status === "done" && task.doneAt);
      const today = new Date().toISOString().slice(0, 10);
      const cycleDays = doneRows
        .map((task) => (new Date(task.doneAt) - new Date(task.createdAt)) / 86400000)
        .sort((a, b) => a - b);
      const median = cycleDays.length
        ? (cycleDays.length % 2
          ? cycleDays[(cycleDays.length - 1) / 2]
          : (cycleDays[cycleDays.length / 2 - 1] + cycleDays[cycleDays.length / 2]) / 2)
        : null;
      const group = (keyFor) => {
        const byKey = new Map();
        for (const task of scoped) {
          const key = keyFor(task);
          const entry = byKey.get(key) || { total: 0, done: 0, blocked: 0, overdue: 0 };
          entry.total += 1;
          if (task.status === "done") entry.done += 1;
          if (task.blocked) entry.blocked += 1;
          if (task.status !== "done" && task.dueDate < today) entry.overdue += 1;
          byKey.set(key, entry);
        }
        return [...byKey.entries()].map(([name, counts]) => ({ name, ...counts }))
          .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
      };
      const byMonth = [...doneRows.reduce((acc, task) => {
        const month = String(task.doneAt).slice(0, 7);
        acc.set(month, (acc.get(month) || 0) + 1);
        return acc;
      }, new Map()).entries()].map(([month, done]) => ({ month, done })).sort((a, b) => a.month.localeCompare(b.month));
      return {
        chapterId: data.member.chapterId,
        from: rangeFrom,
        to: rangeTo,
        generatedAt: new Date().toISOString(),
        totals: {
          total: scoped.length,
          done: doneRows.length,
          open: scoped.length - doneRows.length,
          blocked: scoped.filter((task) => task.blocked).length,
          overdue: scoped.filter((task) => task.status !== "done" && task.dueDate < today).length,
          milestones: scoped.filter((task) => task.milestone).length,
          median_days_to_done: median,
          done_late: doneRows.filter((task) => String(task.doneAt).slice(0, 10) > task.dueDate).length,
        },
        deletedCount: 0,
        byMonth,
        byWorkstream: group((task) => task.workstream).map(({ name, total, done, blocked }) => ({ name, total, done, blocked })),
        byPerson: group((task) => task.assigneeName || "—").map(({ name, total, done, overdue }) => ({ name, total, done, overdue })),
      };
    }
    return loadChapterTaskReport(supabase, from, to);
      });
  }

  // The Tasks board found the chapter with no workstream: have the server give
  // it "General" so the first task can be filed. Quiet on purpose; the board's
  // own empty state still stands if this fails. Bound to the member operation
  // like every write, and the answer reaches the board through the session
  // loader's own tasks read, so its cache never holds the empty list again
  // and a switched session or chapter never receives another one's list
  async function handleEnsureDefaultWorkstream() {
    if (demoActive) return null;
    return memberOperation.run(async () => {
      const actingSession = sessionRef.current;
      const rows = await memberOperation.wait(ensureChapterDefaultWorkstream(sessionDataClient));
      if (rows.length) await memberOperation.wait(refresh(actingSession, memberMutationResources("insertChapterWorkstream")));
      return rows;
    });
  }

  async function handleAddWorkstream(name) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const created = { id: `demo-ws-${Date.now()}`, name: name.trim() };
      setData((current) => ({ ...current, workstreams: [...(current.workstreams || []), created] }));
      // Same shape as the hub's create toasts: name the surface that changed.
      setNotice(tr("tasks.workstreams"));
      return created;
    }
    return mutate(memberMutationResources("insertChapterWorkstream"), () => insertChapterWorkstream(sessionDataClient, data.member.chapterId, name), tr("tasks.workstreams"));
      });
  }

  // Rename/merge bypass mutate()'s failure toast on purpose: a 23505 collision
  // is the merge OFFER, not an error, and a 40001 stale preview re-reads —
  // both belong to the panel's designed copy, not to a raw English toast.
  async function handleRenameWorkstream(workstreamId, name) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const entry = (data.workstreams || []).find((item) => item.id === workstreamId);
      const clean = name.trim();
      if ((data.workstreams || []).some((item) => item.id !== workstreamId && item.name === clean)) {
        const collision = new Error("that name is already in use in this chapter");
        collision.code = "23505";
        throw collision;
      }
      let moved = 0;
      setData((current) => ({
        ...current,
        workstreams: (current.workstreams || []).map((item) => (item.id === workstreamId ? { ...item, name: clean } : item)),
        tasks: (current.tasks || []).map((task) => {
          if (entry && task.workstream === entry.name) { moved += 1; return { ...task, workstream: clean }; }
          return task;
        }),
      }));
      setNotice(tr("tasks.workstreamRenamed", { count: moved }));
      return { id: workstreamId, name: clean, movedTasks: moved };
    }
    const result = await memberOperation.wait(renameChapterWorkstream(sessionDataClient, workstreamId, name));
    try {
      await memberOperation.wait(refresh(session, memberMutationResources("insertChapterWorkstream")));
    } catch { memberOperation.assertCurrent();
      // The rename landed; the next refresh reconciles the board.
    }
    setNotice(tr("tasks.workstreamRenamed", { count: result?.movedTasks ?? 0 }));
    return result;
      });
  }

  async function handlePreviewMergeWorkstreams(sourceId, targetId) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const source = (data.workstreams || []).find((item) => item.id === sourceId);
      const target = (data.workstreams || []).find((item) => item.id === targetId);
      const moving = (data.tasks || []).filter((task) => task.workstream === source?.name);
      return {
        sourceName: source?.name || "",
        targetName: target?.name || "",
        movingTasks: moving.length,
        movingDoneTasks: moving.filter((task) => task.status === "done").length,
        targetExistingTasks: (data.tasks || []).filter((task) => task.workstream === target?.name).length,
      };
    }
    return previewChapterWorkstreamMerge(supabase, sourceId, targetId);
      });
  }

  async function handleMergeWorkstreams(sourceId, targetId, expectedMoving = null) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const source = (data.workstreams || []).find((item) => item.id === sourceId);
      const target = (data.workstreams || []).find((item) => item.id === targetId);
      let moved = 0;
      setData((current) => ({
        ...current,
        workstreams: (current.workstreams || []).filter((item) => item.id !== sourceId),
        tasks: (current.tasks || []).map((task) => {
          if (source && task.workstream === source.name) { moved += 1; return { ...task, workstream: target?.name || task.workstream }; }
          return task;
        }),
      }));
      setNotice(tr("tasks.merged", { count: moved, target: target?.name || "" }));
      return { targetId, targetName: target?.name || "", removedName: source?.name || "", movedTasks: moved };
    }
    const result = await memberOperation.wait(mergeChapterWorkstreams(sessionDataClient, sourceId, targetId, expectedMoving));
    try {
      await memberOperation.wait(refresh(session, memberMutationResources("insertChapterWorkstream")));
    } catch { memberOperation.assertCurrent();
      // The merge landed; the next refresh reconciles the board.
    }
    setNotice(tr("tasks.merged", { count: result?.movedTasks ?? 0, target: result?.targetName ?? "" }));
    return result;
      });
  }

  async function handleSendTaskMessage(taskId, body) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const task = (data.tasks || []).find((item) => item.id === taskId);
      const senderId = data.member.id;
      const recipientId = task?.assigneeId === senderId ? task?.createdBy : task?.assigneeId;
      if (!task || !recipientId || recipientId === senderId) {
        throw new Error("task has no message recipient");
      }
      const created = {
        id: globalThis.crypto?.randomUUID?.() || `demo-task-message-${Date.now()}`,
        taskId,
        chapterId: task.chapterId,
        senderId,
        recipientId,
        body: body.trim(),
        createdAt: new Date().toISOString(),
      };
      setData((current) => ({
        ...current,
        taskMessages: [...(current.taskMessages || []), created],
      }));
      setNotice(tr("toast.taskMessageSent"));
      return created;
    }
    const created = await memberOperation.wait(mutate(
      memberMutationResources("sendChapterTaskMessage"), async () => {
        const saved = await memberOperation.wait(sendChapterTaskMessage(sessionDataClient, taskId, body));
        memberLoaderRef.current?.confirmProjection(`task-message-${saved.id}`, ["table:chapter_task_messages"], current => ({
          ...current, taskMessages: [...(current.taskMessages || []).filter(message => message.id !== saved.id), saved],
        }));
        return saved;
      },
      tr("toast.taskMessageSent"),
    ));
    if (created) {
      setData((current) => ({
        ...current,
        taskMessages: [...(current.taskMessages || []).filter((message) => message.id !== created.id), created],
      }));
    }
    return created;
      });
  }

  async function handleAddTaskComment(taskId, body, mentionIds = []) {
    return memberOperation.run(async () => {
    const text = body.trim();
    if (!text) return null;
    if (demoActive) {
      const created = {
        id: globalThis.crypto?.randomUUID?.() || `demo-task-comment-${Date.now()}`,
        taskId,
        chapterId: data.member.chapterId,
        authorId: data.member.id,
        body: text,
        mentionedUserIds: mentionIds,
        createdAt: new Date().toISOString(),
      };
      setData((current) => {
        const merged = [...(current.taskComments || []).filter((comment) => comment.id !== created.id), created]
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))
            || String(b.id).localeCompare(String(a.id)));
        return {
          ...current,
          taskComments: merged.slice(0, TASK_COMMENT_LIMIT),
          taskCommentsUnavailable: false,
          taskCommentsTruncated: merged.length > TASK_COMMENT_LIMIT,
        };
      });
      setNotice(tr("toast.taskCommentAdded"));
      return created;
    }
    const created = await memberOperation.wait(mutate(
      memberMutationResources("addChapterTaskComment"), () => addChapterTaskComment(sessionDataClient, taskId, text, mentionIds),
      tr("toast.taskCommentAdded"),
    ));
    if (created) {
      setData((current) => {
        const merged = [...(current.taskComments || []).filter((comment) => comment.id !== created.id), created]
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))
            || String(b.id).localeCompare(String(a.id)));
        return {
          ...current,
          taskComments: merged.slice(0, TASK_COMMENT_LIMIT),
          taskCommentsUnavailable: current.taskCommentsUnavailable !== false,
          taskCommentsTruncated: current.taskCommentsTruncated === true || merged.length > TASK_COMMENT_LIMIT,
        };
      });
    }
    return created;
      });
  }

  // Demo device-files keep their bytes in this session-only map so "open"
  // works without a bucket; the rows themselves ride the shared demo state.
  const demoFileBlobsRef = useRef(new Map());
  async function handleAddCaseFile(caseId, file, options) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const id = globalThis.crypto?.randomUUID?.() || `demo-case-file-${Date.now()}`;
      const created = {
        id,
        caseId,
        userId: session.user.id,
        bucketId: "case-files",
        objectName: `${session.user.id}/${caseId}/${id}/${file.name}`,
        filename: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        uploadedBy: session.user.id,
        createdAt: new Date().toISOString(),
      };
      demoFileBlobsRef.current.set(id, file);
      setData((current) => ({
        ...current,
        cases: current.cases.map((item) => item.id === caseId
          ? { ...item, files: [created, ...(item.files || [])] }
          : item),
      }));
      setNotice(tr("toast.caseFileAdded"), null, null, null, "toast.saveFailed");
      return created;
    }
    const created = await memberOperation.wait(mutate(memberMutationResources("addMemberCaseFile"), () => addMemberCaseFile(sessionDataClient, caseId, file, options), tr("toast.caseFileAdded"), null, null, null, "toast.saveFailed"));
    if (created) setData((current) => ({
      ...current,
      cases: current.cases.map((item) => item.id === caseId
        ? { ...item, files: [created, ...(item.files || [])] }
        : item),
    }));
    return created;
      });
  }

  async function handleRemoveCaseFile(caseId, file) {
    return memberOperation.run(async () => {
    if (demoActive) {
      demoFileBlobsRef.current.delete(file.id);
      setData((current) => ({
        ...current,
        cases: current.cases.map((item) => item.id === caseId
          ? { ...item, files: (item.files || []).filter((entry) => entry.id !== file.id) }
          : item),
      }));
      setNotice(tr("toast.caseFileRemoved"), null, null, null, "toast.saveFailed");
      return { deleted: true };
    }
    const result = await memberOperation.wait(mutate(memberMutationResources("removeMemberCaseFile"), () => removeMemberCaseFile(sessionDataClient, file), tr("toast.caseFileRemoved"), null, null, null, "toast.saveFailed"));
    if (result) setData((current) => ({
      ...current,
      cases: current.cases.map((item) => item.id === caseId
        ? { ...item, files: (item.files || []).filter((entry) => entry.id !== file.id) }
        : item),
    }));
    return result;
      });
  }

  // Returns the bytes, not a link. The view opens its tab synchronously on the
  // tap and mints the object URL once the blob arrives; a signed URL would
  // outlive a later quarantine, which is the whole reason it is gone.
  async function handleOpenCaseFile(file) {
    return memberOperation.run(async () => {
    if (!demoActive) return memberCaseFileBlob(sessionDataClient, file);
    const blob = demoFileBlobsRef.current.get(file.id);
    if (!blob) throw new Error(tr("cases.fileUnavailable"));
    return blob;
      });
  }

  function handleRecheckCaseFile(file) {
    return recheckPrivateFile(sessionDataClient, "case", file.id);
  }

  async function handleAddTaskFile(taskId, file, options) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const now = new Date().toISOString();
      const id = globalThis.crypto?.randomUUID?.() || `demo-task-file-${Date.now()}`;
      const created = {
        id,
        taskId,
        chapterId: data.member.chapterId,
        bucketId: "chapter-task-files",
        objectName: `${data.member.chapterId}/${taskId}/${id}/${file.name}`,
        filename: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        uploadedBy: data.member.id,
        createdAt: now,
      };
      demoFileBlobsRef.current.set(id, file);
      setData((current) => ({
        ...current,
        taskFiles: [...(current.taskFiles || []), created],
        taskActivity: [{
          id: `demo-activity-file-added-${Date.now()}`,
          taskId,
          chapterId: data.member.chapterId,
          actorId: data.member.id,
          action: "file_added",
          fromValue: null,
          toValue: created.id,
          createdAt: now,
        }, ...(current.taskActivity || [])],
      }));
      setNotice(tr("toast.taskFileAdded"));
      return created;
    }
    const created = await memberOperation.wait(mutate(
      memberMutationResources("addChapterTaskFile"), () => addChapterTaskFile(sessionDataClient, taskId, file, options),
      tr("toast.taskFileAdded"),
    ));
    if (created) {
      setData((current) => ((current.taskFiles || []).some((row) => row.id === created.id)
        ? current
        : { ...current, taskFiles: [...(current.taskFiles || []), created] }));
    }
    return created;
      });
  }

  async function handleRemoveTaskFile(file) {
    return memberOperation.run(async () => {
    const fileId = file?.id ?? file;
    if (demoActive) {
      demoFileBlobsRef.current.delete(fileId);
      setData((current) => {
        const removed = (current.taskFiles || []).find((file) => file.id === fileId);
        return {
          ...current,
          taskFiles: (current.taskFiles || []).filter((file) => file.id !== fileId),
          taskActivity: removed ? [{
            id: `demo-activity-file-removed-${Date.now()}`,
            taskId: removed.taskId,
            chapterId: removed.chapterId,
            actorId: data.member.id,
            action: "file_removed",
            fromValue: removed.filename,
            toValue: null,
            createdAt: new Date().toISOString(),
          }, ...(current.taskActivity || [])] : (current.taskActivity || []),
        };
      });
      setNotice(tr("toast.taskFileRemoved"));
      return { deleted: true };
    }
    const result = await memberOperation.wait(mutate(
      memberMutationResources("removeChapterTaskFile"), () => removeChapterTaskFile(sessionDataClient, file),
      tr("toast.taskFileRemoved"),
    ));
    if (result) {
      setData((current) => ({
        ...current,
        taskFiles: (current.taskFiles || []).filter((file) => file.id !== fileId),
      }));
    }
    return result;
      });
  }

  async function handleOpenTaskFile(fileRow) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const blob = demoFileBlobsRef.current.get(fileRow.id);
      // A demo row from the OTHER instance (or a seeded one) has no bytes on
      // this side; an honest notice beats a dead click.
      if (!blob) { setNotice(tr("toast.taskFileDemoUnavailable")); return null; }
      return blob;
    }
    return chapterTaskFileBlob(sessionDataClient, fileRow);
      });
  }

  function handleRecheckTaskFile(fileRow) {
    return recheckPrivateFile(sessionDataClient, "task", fileRow.id);
  }

  async function handleAddTaskAttachment(taskId, label, recordUrl) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const now = new Date().toISOString();
      const created = {
        id: globalThis.crypto?.randomUUID?.() || `demo-task-attachment-${Date.now()}`,
        taskId,
        chapterId: data.member.chapterId,
        label: label.trim(),
        recordUrl: recordUrl.trim(),
        createdBy: data.member.id,
        createdAt: now,
        updatedAt: now,
      };
      setData((current) => ({
        ...current,
        taskAttachments: [...(current.taskAttachments || []), created],
        taskActivity: [{
          id: `demo-activity-attachment-added-${Date.now()}`,
          taskId,
          chapterId: data.member.chapterId,
          actorId: data.member.id,
          action: "attachment_added",
          fromValue: null,
          toValue: created.id,
          createdAt: now,
        }, ...(current.taskActivity || [])],
      }));
      setNotice(tr("toast.taskAttachmentAdded"));
      return created;
    }
    const created = await memberOperation.wait(mutate(
      memberMutationResources("addChapterTaskAttachment"), () => addChapterTaskAttachment(sessionDataClient, taskId, label, recordUrl),
      tr("toast.taskAttachmentAdded"),
    ));
    if (created) setData((current) => ({ ...current, taskAttachments: [...(current.taskAttachments || []), created] }));
    return created;
      });
  }

  async function handleRemoveTaskAttachment(attachmentId) {
    return memberOperation.run(async () => {
    if (demoActive) {
      setData((current) => {
        const removed = (current.taskAttachments || []).find((attachment) => attachment.id === attachmentId);
        return {
          ...current,
          taskAttachments: (current.taskAttachments || []).filter((attachment) => attachment.id !== attachmentId),
          taskActivity: removed ? [{
            id: `demo-activity-attachment-removed-${Date.now()}`,
            taskId: removed.taskId,
            chapterId: removed.chapterId,
            actorId: data.member.id,
            action: "attachment_removed",
            fromValue: removed.id,
            toValue: null,
            createdAt: new Date().toISOString(),
          }, ...(current.taskActivity || [])] : (current.taskActivity || []),
        };
      });
      setNotice(tr("toast.taskAttachmentRemoved"));
      return { deleted: true };
    }
    const result = await memberOperation.wait(mutate(
      memberMutationResources("removeChapterTaskAttachment"), () => removeChapterTaskAttachment(sessionDataClient, attachmentId),
      tr("toast.taskAttachmentRemoved"),
    ));
    if (result) {
      setData((current) => ({
        ...current,
        taskAttachments: (current.taskAttachments || []).filter((attachment) => attachment.id !== attachmentId),
      }));
    }
    return result;
      });
  }

  // The conversation dialog renders straight from data.conversations, so both
  // the demo write and the real-account pending echo land by patching that row.
  function patchConversation(conversationId, fn) {
    setData((current) => current ? {
      ...current,
      conversations: (current.conversations || []).map((item) => item.id === conversationId ? fn(item) : item),
    } : current);
  }

  // REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: a poll
  // suggestion goes to the member's one direct steward conversation (unique
  // per member), opening it only when there is none yet.
  function handlePollSuggestion(text) {
    const direct = (data.conversations || []).find((item) => item.counterpartRole === "steward" && !item.stewardUserId);
    return direct ? handleSendMemberMessage(direct.id, text) : handleStartMemberConversation(text);
  }

  async function handleSendMemberMessage(conversationId, body) {
    return memberOperation.run(async () => {
    const text = body.trim();
    const messageRow = (id, extra = {}) => ({
      id,
      conversation_id: conversationId,
      user_id: session.user.id,
      sender_kind: "member",
      sender_name: data.member.fullName || "Member",
      body: text,
      created_at: new Date().toISOString(),
      read_at: null,
      ...extra,
    });
    if (demoActive) {
      const created = messageRow(globalThis.crypto?.randomUUID?.() || `demo-message-${Date.now()}`);
      patchConversation(conversationId, (item) => ({
        ...item,
        preview: created.body,
        dateLabel: conversationDateLabel(created.created_at, lang),
        messages: [...(item.messages || []), created],
      }));
      setNotice(tr("toast.messageSent"));
      return created;
    }
    // Optimistic echo: the write plus mutate()'s full refresh can take
    // seconds; the member sees their bubble immediately — and the row
    // preview/date move with it, so the inbox list agrees with the open
    // thread even when the reload later fails. The server row id replaces
    // the pending one explicitly. The confirmed row also enters the session
    // registry before refresh, so a retained snapshot cannot erase the saved
    // bubble during unrelated projections or a failed post-send read.
    const pendingId = `pending-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
    patchConversation(conversationId, (item) => ({
      ...item,
      preview: text,
      dateLabel: conversationDateLabel(new Date().toISOString(), lang),
      messages: [...(item.messages || []), messageRow(pendingId, { pending: true })],
    }));
    let result;
    try {
      result = await memberOperation.wait(mutate(memberMutationResources("sendMemberMessage"), async () => {
        const saved = await memberOperation.wait(sendMemberMessage(sessionDataClient, conversationId, text));
        if (saved?.messageId) memberLoaderRef.current?.confirmRows("table:member_messages", rows => [
          ...rows.filter(row => row.id !== saved.messageId), messageRow(saved.messageId),
        ]);
        return saved;
      }, tr("toast.messageSent")));
    } catch (error) { memberOperation.assertCurrent();
      // Drop the pending bubble and put the preview back on the last real
      // message so the list does not advertise a reply nobody confirmed.
      patchConversation(conversationId, (item) => {
        const messages = (item.messages || []).filter((message) => message.id !== pendingId);
        const last = messages[messages.length - 1];
        return {
          ...item,
          preview: last ? last.body : item.preview,
          dateLabel: last ? conversationDateLabel(last.created_at, lang) : item.dateLabel,
          messages,
        };
      });
      // A lost answer is not proof the reply failed: the person is
      // told to check, so reload the thread first and it shows the reply if
      // it was stored. Still offline, the reload fails and nothing else moves.
      if (isUnconfirmedWrite(error)) await reloadAfterUnconfirmedWrite("sendMemberMessage");
      throw error; // the dialog keeps the draft
    }
    if (result?.messageId) {
      patchConversation(conversationId, (item) => ({ ...item, messages: (item.messages || []).map((message) => message.id === pendingId ? { ...message, id: result.messageId, pending: false } : message) }));
    }
    return result;
      });
  }

  async function handleStartMemberConversation(body) {
    return memberOperation.run(async () => {
    const text = body.trim();
    if (demoActive) {
      const now = new Date().toISOString();
      const conversationId = globalThis.crypto?.randomUUID?.() || `demo-conversation-${Date.now()}`;
      const messageId = globalThis.crypto?.randomUUID?.() || `demo-message-${Date.now()}`;
      const created = {
        id: conversationId,
        counterpartRole: "steward",
        sender: tr("inbox.chapterSteward"),
        senderLabelKey: "inbox.chapterSteward",
        initials: "CS",
        preview: text,
        dateLabel: conversationDateLabel(now, lang),
        unread: 0,
        messages: [{ id: messageId, conversation_id: conversationId, user_id: session.user.id, sender_kind: "member", sender_name: data.member.fullName || "Member", body: text, created_at: now, read_at: null }],
      };
      setData((current) => ({ ...current, conversations: [created, ...(current.conversations || [])] }));
      setNotice(tr("toast.messageSent"));
      return { conversationId, messageId };
    }
    try {
      return await memberOperation.wait(mutate(memberMutationResources("startMemberConversation"), () => startMemberConversation(sessionDataClient, text), tr("toast.messageSent")));
    } catch (error) { memberOperation.assertCurrent();
      // As for a reply: reload the inbox so a stored conversation shows .
      if (isUnconfirmedWrite(error)) await reloadAfterUnconfirmedWrite("startMemberConversation");
      throw error;
    }
      });
  }

  // After a write whose answer was lost: one reload of what it would
  // have changed, so the person can see whether it was stored before sending
  // again. Best effort; a failed reload leaves the page as it was.
  async function reloadAfterUnconfirmedWrite(kind) {
    try { await memberOperation.wait(refresh(sessionRef.current, memberMutationResources(kind))); }
    catch { /* swallow-ok: still offline; the notice already says to check */ }
    memberOperation.assertCurrent();
  }

  const demoStewardContactRef = useRef({ shareEmail: false, sharePhone: false, contactEmail: null, contactPhone: null });
  const demoProfileDetailsRef = useRef({ pronouns: null, jobTitle: null, worksite: null, phone: null, detailsVisibility: "only_me", phoneVisibility: "only_me" });

  // Contact pressed on a steward card. The record's rule: reach THAT steward's
  // conversation, never a shared generic thread. So the bound thread is
  // resolved by steward id and opened directly; when the member has never
  // written to this steward, the inbox opens a composer addressed to them and
  // the send mints the bound conversation in one transaction.
  function handleContactSteward(steward) {
    if (!steward?.id) return;
    const bound = findStewardConversation(data.conversations || [], steward.id);
    navigate("messages", "/m/messages", bound
      ? { view: "messages", conversationId: bound.id }
      : { view: "messages", startStewardUserId: steward.id, stewardName: steward.name ?? null });
  }

  // Message pressed beside an officer under Who runs this chapter: Messages
  // opens the first-message form addressed to them (start_officer_conversation
  // reuses the pair's conversation when one exists).
  function handleMessageOfficer(person) {
    if (!person?.id) return;
    navigate("messages", "/m/messages", { view: "messages", startOfficerUserId: person.id, officerName: person.name ?? null });
  }

  // No code or reward; the server accepts only an officer the member may write
  // to. Run under the member session guard: a response that lands after the
  // account changed resolves to nothing, so Messages never folds one member's
  // conversation into another member's data.
  function handleStartOfficerConversation(officerUserId, body, operationId) {
    return memberOperation.run(() => (demoActive
      ? demoPeerContactApi.startOfficer(officerUserId, body)
      : peerContactApi.startOfficer(officerUserId, body, operationId)));
  }

  async function handleStartStewardConversation(stewardUserId, body) {
    return memberOperation.run(async () => {
      const text = body.trim();
      if (demoActive) {
        const now = new Date().toISOString();
        const conversationId = globalThis.crypto?.randomUUID?.() || `demo-conversation-${Date.now()}`;
        const messageId = globalThis.crypto?.randomUUID?.() || `demo-message-${Date.now()}`;
        const steward = (data.chapterStewards || []).find((row) => row.id === stewardUserId) || null;
        const created = {
          id: conversationId,
          counterpartRole: "steward",
          stewardUserId,
          sender: steward?.name ?? tr("inbox.chapterSteward"),
          ...(!steward?.name ? { senderLabelKey: "inbox.chapterSteward" } : {}),
          initials: "CS",
          preview: text,
          dateLabel: conversationDateLabel(now, lang),
          unread: 0,
          messages: [{ id: messageId, conversation_id: conversationId, user_id: session.user.id, sender_kind: "member", sender_name: data.member.fullName || "Member", body: text, created_at: now, read_at: null }],
        };
        setData((current) => ({ ...current, conversations: [created, ...(current.conversations || [])] }));
        setNotice(tr("toast.messageSent"));
        return { status: "committed", value: { conversationId, messageId } };
      }
      return mutateWithOutcome(
        memberMutationResources("startMemberConversation"),
        () => startMemberStewardConversation(sessionDataClient, stewardUserId, text),
        tr("toast.messageSent"),
      );
    });
  }

  // The steward's own contact-visibility row. Read and write are both
  // self-scoped server-side: neither RPC takes a steward id. Demo sessions keep
  // it in tab memory so the preview can exercise the card without a backend.
  const stewardContactApi = useMemo(() => {
    if (demoActive) {
      return {
        load: async () => demoStewardContactRef.current,
        save: async (next) => {
          demoStewardContactRef.current = {
            shareEmail: Boolean(next.shareEmail),
            sharePhone: Boolean(next.sharePhone),
            contactEmail: next.contactEmail || null,
            contactPhone: next.contactPhone || null,
          };
          return demoStewardContactRef.current;
        },
      };
    }
    if (!supabase) return null;
    return {
      load: () => getMyStewardContactVisibility(supabase),
      save: (next) => setMyStewardContactVisibility(sessionDataClient, next),
    };
  }, [demoActive, sessionDataClient]);

  // REQ-UG-PROFILE-WORKPLACE-JOB-PHONE-AND-PRONOUNS-20261006: the
  // member's own profile details. Both RPCs are self-scoped server-side; demo
  // sessions keep the row in tab memory like the steward contact card.
  const profileDetailsApi = useMemo(() => {
    if (demoActive) {
      return {
        load: async () => demoProfileDetailsRef.current,
        save: async (next) => {
          demoProfileDetailsRef.current = { ...next };
          return demoProfileDetailsRef.current;
        },
      };
    }
    if (!supabase) return null;
    return {
      load: () => getMyProfileDetails(supabase),
      save: (next) => setMyProfileDetails(sessionDataClient, next),
    };
  }, [demoActive, sessionDataClient]);

  // REQ-UG-WHO-RUNS-THIS-CHAPTER-AND-ONE-WORD-FOR-STAFF-20261006: the
  // member's own chapter leadership for the profile page. The RPC takes no
  // chapter id; fixture previews have no backend, so the card is not offered.
  // REQ-UG-STEWARD-SENIORITY-LIST-AND-BID-TRACKER-20261030: the
  // chapter seniority list and bids; fixture previews have no backend.
  const seniorityApi = useMemo(() => (demoActive || !supabase ? null : createSeniorityApi(sessionDataClient)), [demoActive, sessionDataClient]);

  const chapterLeadershipApi = useMemo(() => {
    if (demoActive || !supabase) return null;
    return chapterLeadershipApiFor(sessionDataClient, sessionRef);
  }, [demoActive, sessionDataClient]);

  // REQ-UG-PEER-ROLE-CONTACT-ACROSS-CHAPTERS-20261109: the same
  // access level in the organization's other chapters. The send runs under the
  // member session guard, so a response that lands after the account changed
  // is never folded into another member's conversations.
  // Only a holder of a level an organization can enable (chapter lead or
  // steward) is ever offered Other chapters, so nobody else sends the read.
  // The server still decides who is listed.
  const crossChapterCandidate = Boolean(data && !data.rolesUnknown
    && (data.roles || []).some((role) => role === "vp" || role === "steward"));
  const crossChapterId = data?.member?.chapterId ?? null;
  const crossChapterRoles = (data?.roles ?? []).filter((role) => role === "vp" || role === "steward").sort().join("|");
  const crossChapterApi = useMemo(() => {
    if (demoActive || !supabase || !crossChapterCandidate) return null;
    // The first, unsearched page is read once per api: returning to Messages
    // reuses it (member-boot-round1 counts every read). A search, a later
    // page, a new session, chapter or eligible-role change reads again; a
    // failed read is not kept.
    let firstPage = null;
    const load = (page) => {
      const query = typeof page?.query === "string" ? page.query.trim() : "";
      if (query || (page?.offset ?? 0) > 0) return listCrossChapterPeers(supabase, page);
      firstPage ??= listCrossChapterPeers(supabase, page).catch((error) => { firstPage = null; throw error; });
      return firstPage;
    };
    return {
      load,
      send: (recipientIds, body) => memberOperation.run(() => peerContactApiRef.current.sendCrossChapter(recipientIds, body)),
      setMute: async (muted) => {
        const result = await setCrossChapterPeerMute(sessionDataClient, muted);
        if (firstPage) firstPage = firstPage.then((list) => ({ ...list, muted: result?.muted === true }));
        return result;
      },
    };
    // memberOperation is the current session's guard: a memo kept from before
    // sign-in would refuse every send as stale (Sol early read B1 on).
    // Chapter and roles own the cache's lifetime even when eligibility stays true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoActive, memberOperation, crossChapterCandidate, crossChapterId, crossChapterRoles, sessionDataClient]);

  function handleReadConversation(conversationId) {
    return mutateWithOutcome(
      memberMutationResources("markConversationRead"), () => markConversationRead(sessionDataClient, session.user.id, conversationId),
      tr("toast.conversationOpened"),
      { kind: "conversationRead", key: conversationId, args: { userId: session.user.id, conversationId } },
      () => patchConversation(conversationId, (item) => ({
        ...item,
        unread: 0,
        messages: (item.messages || []).map((message) => message.read_at || message.sender_kind === "member" ? message : { ...message, read_at: new Date().toISOString() }),
      })),
    );
  }

  function handleReadBroadcast(broadcastId) {
    return mutateWithOutcome(
      memberMutationResources("markBroadcastRead"), () => markBroadcastRead(sessionDataClient, session.user.id, broadcastId),
      tr("toast.broadcastOpened"),
      { kind: "broadcastRead", key: broadcastId, args: { userId: session.user.id, broadcastId } },
      () => setData((current) => ({ ...current, broadcasts: (current.broadcasts || []).map((item) => item.id === broadcastId ? { ...item, unread: false } : item) })),
    );
  }

  // A Compass exchange landed in data.guideThreads from local state, in the
  // loader's shape (memberApi guideThreads: thread + messages[]) so the
  // sheet, Be heard's asks list and Search all read it unchanged. Two
  // consumers: the demo twin below, and the real path's refresh-failure
  // fallback — the RPC committed and returned the thread id, and without
  // this the sheet would select a thread the stale data does not contain.
  // Immutable: the fixture object is shared (data/demoData.js caches it) and
  // an in-place push would outlive the tab's demo session.
  // One retained exchange, shaped once: the same rows go into this tab's data
  // and into the loader confirmation that replays them into later projections,
  // so both copies carry identical ids.
  // The persisted rows of a saved exchange, read back from the guide MESSAGE
  // resource — but only when that read is evidence of THIS save. Message
  // authority is independent of thread authority: the post-save read can
  // succeed for the messages and fail for the thread list, and a message read
  // that never re-ran (or failed) still holds the pre-save rows, which carry
  // no answer to retain. "New to this send" is decided on row ids captured
  // before the write, never on the answer text: two sends may answer alike.
  function persistedGuideRows(threadId, priorMessageIds) {
    const entry = memberLoaderRef.current?.inspect().get("table:member_guide_messages");
    if (!entry || entry.failure || entry.status !== "loaded") return null;
    // loadMemberApp orders these rows with orderGuideMessages; match that order
    // so a retained list and a projected one are the same conversation.
    const rows = orderGuideMessages([...entry.snapshot.values()]
      .flatMap((result) => (Array.isArray(result.data) ? result.data : [])))
      .filter((row) => row.thread_id === threadId);
    return rows.some((row) => !priorMessageIds.has(row.id)) ? rows : null;
  }

  function guideExchangeRows(question, threadId, answer, sources, persistedRowsFor = null) {
    const now = new Date().toISOString();
    const newId = (suffix) =>
      globalThis.crypto?.randomUUID?.() || `demo-guide-${suffix}-${Date.now()}`;
    const targetId = threadId || newId("thread");
    const pair = [
      { id: newId("q"), thread_id: targetId, role: "user", body: question, sources: null, created_at: now },
      { id: newId("a"), thread_id: targetId, role: "assistant", body: answer, sources, created_at: now },
    ];
    const apply = (guideThreads) => {
      const threads = guideThreads || [];
      const existing = threads.find((thread) => thread.id === targetId);
      // Retain the database rows whenever the message read has authority for
      // this thread. The loader replays this write into every projection until
      // BOTH history resources read successfully again, so a projection that
      // already carries the persisted exchange would otherwise show — and
      // commit into the last-good offline snapshot — the same exchange twice.
      const rows = persistedRowsFor?.(targetId) ?? pair;
      const rowIds = new Set(rows.map((row) => row.id));
      // Idempotent by row id: these exact rows must never land twice. Two sends
      // that happen to share an answer are still two exchanges.
      if (rows.every((row) => existing?.messages?.some((message) => message.id === row.id))) return threads;
      // Rows the read could not carry (older than its window) stay in front of
      // the ones it did; a replayed row is replaced, never duplicated.
      const messages = [...(existing?.messages || []).filter((message) => !rowIds.has(message.id)), ...rows];
      // left(question, 120) — the same title the live RPC writes.
      const thread = existing
        ? { ...existing, updated_at: now, messages }
        : { id: targetId, title: question.slice(0, 120), created_at: now, updated_at: now, messages };
      // updated_at DESC, like the loader's order().
      return [thread, ...threads.filter((item) => item.id !== targetId)];
    };
    return { targetId, apply };
  }

  function appendGuideExchangeLocal(question, threadId, answer, sources) {
    return commitGuideExchangeLocal(guideExchangeRows(question, threadId, answer, sources));
  }

  function commitGuideExchangeLocal({ targetId, apply }) {
    // Write the retained exchange THROUGH dataRef, not with a setData updater
    // alone. Every projection commit rebuilds `data` from dataRef.current, and
    // React only refreshes that ref on render: a route/realtime projection that
    // resolves before this append has rendered would otherwise commit the
    // guideThreads that predate it, and since the history refresh keeps
    // failing nothing ever appends it again — the saved answer would be gone
    // for good. That render loses the race whenever the runner is starved,
    // which is exactly what a loaded CI worker does.
    const current = dataRef.current;
    if (!current) return targetId;
    const next = { ...current, guideThreads: apply(current.guideThreads) };
    dataRef.current = next;
    // Functional form: a functional update queued earlier in the same React
    // batch (a realtime notification, a task change) must not be replaced by
    // this value. `apply` is idempotent by row id, so applying it again to
    // React's pending state is safe whichever order the updates run in.
    setData((pending) => (pending ? { ...pending, guideThreads: apply(pending.guideThreads) } : next));
    return targetId;
  }

  // The demo twin: mutate() drops every demo write, so without this the
  // member's question vanished, the sheet re-rendered empty, and a toast
  // claimed a reply had been saved. The answer comes from the seeded
  // knowledge base.
  function appendDemoGuideExchange(question, threadId) {
    const { answer, sources } = demoCompassAnswer(question, data, lang);
    return appendGuideExchangeLocal(question, threadId, answer, sources);
  }

  function demoProductInsert(bucket, row) {
    const created = { id: globalThis.crypto?.randomUUID?.() || `demo-${bucket}-${Date.now()}`, ...row };
    setData((current) => ({
      ...current,
      product: { ...(current.product || {}), [bucket]: [created, ...(current.product?.[bucket] || [])] },
    }));
    return created;
  }

  function demoProductUpdate(bucket, id, patch) {
    const updated = { ...patch, id };
    setData((current) => ({ ...current, product: { ...current.product, [bucket]: (current.product?.[bucket] || []).map((row) => row.id === id ? { ...row, ...patch } : row) } }));
    return updated;
  }

  async function handleCreateSpace(fields) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const { nameEs, descriptionEs, ...rest } = fields;
      return demoProductInsert("spaces", { ...rest, name_es: spanishValue(nameEs), description_es: spanishValue(descriptionEs), threads: [], updated_at: new Date().toISOString() });
    }
    return mutate(memberMutationResources("createChapterSpace"), () => createChapterSpace(sessionDataClient, fields), tr("hub.done.spaceCreated"));
      });
  }
  async function handleUpdateSpace(id, fields, archive) {
    return memberOperation.run(async () => {
    // A Spanish edit (bilingualContent.js spanishSpaceEdit) is saved with the
    // space in the same call; an archive or an edit that leaves the Spanish
    // version alone writes only the space itself.
    const spanish = !archive && carriesSpanishEdit(fields);
    if (demoActive) return demoProductUpdate("spaces", id, { name: fields.name, description: fields.description, visibility: fields.visibility, archived_at: archive ? new Date().toISOString() : null,
      ...(spanish ? { name_es: spanishValue(fields.nameEs), description_es: spanishValue(fields.descriptionEs) } : {}) });
    return mutate(memberMutationResources("updateChapterSpaceContent"), () => updateChapterSpaceContent(sessionDataClient, id, fields, archive), tr("hub.saved"));
      });
  }

  async function handleListSpaceMembers(spaceId) {
    return memberOperation.run(async () => {
    if (!demoActive) return listChapterSpaceMembers(supabase, spaceId);
    if (!demoSpaceMembersRef.current.has(spaceId)) demoSpaceMembersRef.current.set(spaceId,[{userId:data.member.id,fullName:data.member.fullName,initials:data.member.initials,role:"creator"}]);
    return [...demoSpaceMembersRef.current.get(spaceId)];
      });
  }
  async function handleSearchSpaceMembers(spaceId, query) {
    return memberOperation.run(async () => {
    if (!demoActive) return searchChapterSpaceMembers(supabase, spaceId, query);
    const existing=new Set((await memberOperation.wait(handleListSpaceMembers(spaceId))).map(row=>row.userId));const needle=query.trim().toLowerCase();
    return (demoData().adminSearchPool||[]).filter(row=>!existing.has(row.userId)&&row.fullName.toLowerCase().includes(needle));
      });
  }
  async function handleSetSpaceMember(spaceId,userId,add) {
    return memberOperation.run(async () => {
    if (!demoActive) return setChapterSpaceMember(sessionDataClient,spaceId,userId,add);
    const current=await memberOperation.wait(handleListSpaceMembers(spaceId));if(!add&&current.find(row=>row.userId===userId)?.role==="creator")throw new Error(tr("hub.membersError"));
    const person=(demoData().adminSearchPool||[]).find(row=>row.userId===userId);
    demoSpaceMembersRef.current.set(spaceId,add?[...current.filter(row=>row.userId!==userId),{...person,userId,role:"member"}]:current.filter(row=>row.userId!==userId));return{changed:true};
      });
  }

  async function handleCreateThread(fields) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const created = { id: `demo-thread-${Date.now()}`, space_id: fields.spaceId, title: fields.title, kind: fields.kind, status: "open", posts: [] };
      setData((current) => ({ ...current, product: { ...current.product, spaces: (current.product?.spaces || []).map((space) => space.id === fields.spaceId ? { ...space, threads: [created, ...(space.threads || [])] } : space) } }));
      return created;
    }
    return mutate(memberMutationResources("createChapterThread"), () => createChapterThread(sessionDataClient, fields), tr("hub.done.threadStarted"));
      });
  }

  async function handleSendThreadPost(threadId, body, mentionIds = [], bodyEs = null) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const created = { id: `demo-post-${Date.now()}`, thread_id: threadId, author_id: data.member?.id, body, body_es: spanishValue(bodyEs), created_at: new Date().toISOString() };
      setData((current) => ({
        ...current,
        product: {
          ...current.product,
          spaces: (current.product?.spaces || []).map((space) => ({
            ...space,
            threads: (space.threads || []).map((thread) => thread.id === threadId
              ? { ...thread, posts: [...(thread.posts || []), created], updated_at: created.created_at }
              : thread),
          })),
        },
      }));
      return created;
    }
    return mutate(memberMutationResources("sendChapterThreadPost"), () => sendChapterThreadPost(sessionDataClient, threadId, body, mentionIds, bodyEs), tr("hub.done.replyPosted"));
      });
  }

  async function handleCreateIntake(fields) {
    return memberOperation.run(async () => {
    if (demoActive) return demoProductInsert("intake", { ...fields, status: "new", created_at: new Date().toISOString() });
    return mutate(memberMutationResources("createMemberIntake"), () => createMemberIntake(sessionDataClient, fields), tr("hub.done.reportSent"));
      });
  }

  async function handleTriageIntake(reportId, fields) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const updatedAt = new Date().toISOString();
      let updated = null;
      setData((current) => ({
        ...current,
        product: {
          ...current.product,
          intake: (current.product?.intake || []).map((item) => {
            if (item.id !== reportId) return item;
            updated = { ...item, status: fields.status, assigned_to: fields.assignedTo || null, updated_at: updatedAt };
            return updated;
          }),
        },
      }));
      setNotice(tr("hub.intake.saved"));
      return updated;
    }
    return mutate(
      memberMutationResources("triageMemberIntake"), () => triageMemberIntake(sessionDataClient, reportId, fields),
      tr("hub.intake.saved"),
    );
      });
  }

  async function handleConvertIntake(reportId, target, spaceId = null) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const demoSnapshot = dataRef.current;
      const demoWorkstreams = [...new Set([
        ...(demoSnapshot?.workstreams || []).map((item) => item.name),
        ...(demoSnapshot?.tasks || []).map((item) => item.workstream),
      ].filter(Boolean))].sort((a, b) => a.localeCompare(b));
      const demoTaskWorkstream = demoWorkstreams.includes("General") ? "General" : demoWorkstreams[0] || null;
      if (target === "task" && !demoTaskWorkstream) throw new Error(tr("tasks.errorWorkstream"));
      const targetId = globalThis.crypto?.randomUUID?.() || `demo-intake-${target}-${Date.now()}`;
      const now = new Date().toISOString();
      setData((current) => {
        const report = (current.product?.intake || []).find((item) => item.id === reportId);
        const linkField = `${target}_id`;
        const next = {
          ...current,
          product: {
            ...current.product,
            intake: (current.product?.intake || []).map((item) => item.id === reportId
              ? { ...item, status: "in_progress", assigned_to: item.assigned_to || current.member?.id, [linkField]: targetId, updated_at: now }
              : item),
          },
        };
        if (target === "case") {
          next.cases = [{
            id: targetId,
            reference: `GR-DEMO-${String(Date.now()).slice(-5)}`,
            title: `Intake follow-up: ${report?.title || "Member report"}`,
            deadline: "",
            deadlineValue: "",
            type: report?.category === "safety" ? "Safety" : "Other",
            articles: "",
            step: "Intake",
            status: "active",
            overdue: false,
            stewardName: "",
            coordinatorName: "",
            updates: [],
          }, ...(current.cases || [])];
        } else if (target === "task") {
          next.tasks = [{
            id: targetId,
            chapterId: current.member?.chapterId,
            taskNumber: Math.max(0, ...(current.tasks || []).map((task) => task.taskNumber || 0)) + 1,
            title: "Follow up on intake report",
            description: "",
            status: "to_do",
            priority: "medium",
            taskType: "general",
            workstream: demoTaskWorkstream,
            assigneeId: null,
            assigneeName: "",
            startDate: null,
            dueDate: null,
            progress: 0,
            blocked: false,
            milestone: false,
            orderIndex: 0,
            createdBy: current.member?.id,
            createdAt: now,
            updatedAt: now,
          }, ...(current.tasks || [])];
          next.taskAttachments = [{
            id: `demo-intake-link-${targetId}`,
            taskId: targetId,
            chapterId: current.member?.chapterId,
            label: "Authorized intake report",
            recordUrl: `/m/organize?intake=${reportId}`,
            createdBy: current.member?.id,
            createdAt: now,
            updatedAt: now,
          }, ...(current.taskAttachments || [])];
        } else if (target === "thread") {
          next.product.spaces = (current.product?.spaces || []).map((space) => space.id === spaceId
            ? { ...space, threads: [{ id: targetId, space_id: spaceId, title: "Intake follow-up", kind: "intake", status: "open", posts: [] }, ...(space.threads || [])] }
            : space);
        }
        return next;
      });
      setNotice(tr(`hub.intake.converted.${target}`));
      return { target, targetId };
    }
    return mutate(
      memberMutationResources("convertMemberIntake"), () => convertMemberIntake(sessionDataClient, reportId, target, spaceId),
      tr(`hub.intake.converted.${target}`),
    );
      });
  }

  async function handleCreateDocument(fields) {
    return memberOperation.run(async () => {
    if (demoActive) return demoProductInsert("documents", { title: fields.title, document_type: fields.documentType, summary: fields.summary, body: fields.body, version: 1, status: fields.status, updated_at: new Date().toISOString() });
    return mutate(memberMutationResources("createChapterDocument"), () => createChapterDocument(sessionDataClient, fields), tr("hub.done.documentSaved"));
      });
  }
  async function handleUpdateDocument(id, fields, action) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const current = data.product?.documents?.find((row) => row.id === id);
      return demoProductUpdate("documents", id, { title: fields.title, document_type: fields.documentType, summary: fields.summary, body: fields.body, visibility: fields.visibility, status: action === "archive" ? "archived" : action === "republish" ? "published" : current?.status, version: action === "republish" ? (current?.version || 1) + 1 : current?.version, published_at: action === "republish" ? new Date().toISOString() : current?.published_at });
    }
    return mutate(memberMutationResources("updateChapterDocumentContent"), () => updateChapterDocumentContent(sessionDataClient, id, fields, action), tr("hub.saved"));
      });
  }

  async function handleSaveKnowledge(fields) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const now = new Date().toISOString();
      const previous = (data.product?.compassKnowledge || []).find((article) => article.id === fields.articleId);
      const created = {
        id: fields.articleId || `demo-kb-${Date.now()}`,
        chapterId: fields.chapterId || data.member?.chapterId || "demo-chapter",
        kind: fields.kind,
        title: fields.title.trim(),
        ref: fields.articleRef.trim(),
        body: fields.body.trim(),
        keywords: fields.keywords,
        status: fields.status,
        isSample: true,
        version: (previous?.version || 0) + 1,
        verifiedBy: fields.status === "published" ? "sample-preview" : null,
        verifiedAt: fields.status === "published" ? now : null,
        updatedAt: now,
      };
      setData((current) => ({
        ...current,
        product: {
          ...(current.product || {}),
          compassKnowledge: [created, ...(current.product?.compassKnowledge || []).filter((article) => article.id !== created.id)],
        },
      }));
      setNotice(tr("hub.knowledge.saved"));
      return created;
    }
    return mutate(memberMutationResources("saveChapterKnowledgeArticle"), () => saveChapterKnowledgeArticle(sessionDataClient, fields), tr("hub.knowledge.saved"));
      });
  }

  async function handleRetireKnowledge(articleId, chapterId = null) {
    return memberOperation.run(async () => {
    if (demoActive) {
      const currentArticle = (data.product?.compassKnowledge || []).find((article) => article.id === articleId);
      if (!currentArticle) return null;
      const retired = {
        ...currentArticle,
        status: "retired",
        version: currentArticle.version + 1,
        verifiedBy: null,
        verifiedAt: null,
        updatedAt: new Date().toISOString(),
      };
      setData((current) => ({
        ...current,
        product: {
          ...(current.product || {}),
          compassKnowledge: (current.product?.compassKnowledge || []).map((article) => article.id === articleId ? retired : article),
        },
      }));
      setNotice(tr("hub.knowledge.retired"));
      return retired;
    }
    return mutate(
      memberMutationResources("retireChapterKnowledgeArticle"), () => retireChapterKnowledgeArticle(sessionDataClient, articleId, chapterId),
      tr("hub.knowledge.retired"),
    );
      });
  }

  async function handleCreateRecord(fields) {
    return memberOperation.run(async () => {
    if (demoActive) return demoProductInsert("records", { title: fields.title, record_type: fields.recordType, body: fields.body, occurred_at: fields.occurredAt });
    return mutate(memberMutationResources("createChapterRecord"), () => createChapterRecord(sessionDataClient, fields), tr("hub.done.recordSaved"));
      });
  }
  async function handleUpdateRecord(id, fields, archive) {
    return memberOperation.run(async () => {
    if (demoActive) return demoProductUpdate("records", id, { title: fields.title, record_type: fields.recordType, body: fields.body, occurred_at: fields.occurredAt, archived_at: archive ? new Date().toISOString() : null });
    return mutate(memberMutationResources("updateChapterRecordContent"), () => updateChapterRecordContent(sessionDataClient, id, fields, archive), tr("hub.saved"));
      });
  }

  async function handleCreateHandshake(fields) {
    return memberOperation.run(async () => {
    if (demoActive) return demoProductInsert("handshakes", { title: fields.title, purpose: fields.purpose, data_scope: fields.dataScope, status: "requested", partner_org_id: fields.partnerOrgId });
    return mutate(memberMutationResources("createChapterHandshake"), () => createChapterHandshake(sessionDataClient, fields), tr("hub.done.partnerRequestSent"));
      });
  }

  async function handleUpdateHandshake(id, status) {
    return memberOperation.run(async () => {
    const patch = { status };
    if (status === "requested") patch.requested_at = new Date().toISOString();
    if (status === "accepted") patch.countersigned_at = new Date().toISOString();
    if (demoActive) return demoProductUpdate("handshakes", id, patch);
    return mutate(memberMutationResources("updateChapterHandshakeStatus"), () => updateChapterHandshakeStatus(sessionDataClient, id, status), tr("hub.saved"));
      });
  }

  async function handleCreateGovernance(fields) {
    return memberOperation.run(async () => {
    if (demoActive) return demoProductInsert("governance", { request_type: fields.requestType, details: fields.details, status: "submitted", created_at: new Date().toISOString() });
    return mutate(memberMutationResources("createGovernanceRequest"), () => createGovernanceRequest(sessionDataClient, fields), tr("hub.done.governanceRequestSubmitted"));
      });
  }

  async function handleGenerateDataExport() {
    return memberOperation.run(async () => {
    const exported = demoActive
      ? {
        schemaVersion: 1,
        samplePreview: true,
        generatedAt: new Date().toISOString(),
        account: { profile: dataRef.current?.member || null },
        notice: "PREVIEW export — no production account data was requested.",
      }
      : await memberOperation.wait(generateMemberDataExport(sessionDataClient));
    downloadMemberDataExport(exported);
    setNotice(tr(demoActive ? "hub.lifecycle.demoExported" : "hub.lifecycle.exported"));
    return { downloaded: true, samplePreview: demoActive };
      });
  }

  async function handleDeleteAccount(confirmation, reauth) {
    if (demoActive) {
      setNotice(tr("hub.lifecycle.demoDelete"));
      return { deleted: false, simulated: true };
    }
    if (deletionSessionRef.current) throw new Error("deletion-in-progress");
    const captured = sessionRef.current;
    if (!captured) throw new Error("unauthenticated");
    deletionSessionRef.current = captured;
    setDeletionHold(true);
    let result;
    let uncertain = false;
    try {
      result = reauth?.password
        ? await requestAccountDeletion(captured, confirmation, undefined, undefined, { password: reauth.password })
        : await requestAccountDeletion(captured, confirmation);
    } catch (error) {
      if (error?.code !== "account-delete-indeterminate") {
        deletionSessionRef.current = null;
        setDeletionHold(false);
        throw error;
      }
      uncertain = true;
    }
    // SIGNED_OUT may arrive before the HTTP response. Null is a legitimate
    // departure, but a different login must never be cleared by this request.
    const current = sessionRef.current;
    if (current && !sameAuthSessionLineage(current, captured)) {
      deletionSessionRef.current = null;
      setDeletionHold(false);
      return result;
    }
    const outcome = uncertain ? { uncertain: true } : deletionCompletion(result);
    deletionAccountRef.current = captured.user.id;
    deletionLineageRef.current = sessionIDFromAccessToken(captured.access_token);
    deletionReceiptRef.current = outcome;
    setDeletionOutcome(outcome);
    setDeletionCleanup("pending");
    setDeletionLang(lang);
    beginSessionGeneration(null);
    setLoading(false);
    // Start credential and personal-cache removal immediately, independently
    // of acknowledgement. Retry is local only: never repeat the deletion POST.
    const userId = captured.user.id;
    let cleanupSession = current || captured;
    deletionCleanupRef.current = async () => {
      if (deletionReceiptRef.current !== outcome) return;
      setDeletionCleanup("pending");
      try {
        // Remove queued personal text before credential teardown, including
        // retries after a storage failure. The completion view already hides
        // protected content while the device cleanup is pending.
        await purgeSensitiveEntries(outboxStoreRef.current, userId);
        if (deletionReceiptRef.current !== outcome) return;
        const active = sessionRef.current;
        if (active && !sameAuthSessionLineage(active, captured)) {
          // Preserve a replacement account (or a fresh login after an
          // uncertain response) without leaving an unfinishable receipt.
          if (active.user.id !== userId || uncertain) {
            deletionReceiptRef.current = null;
            deletionSessionRef.current = null;
            deletionAccountRef.current = null;
            deletionLineageRef.current = null;
            deletionCleanupRef.current = null;
            setDeletionOutcome(null);
            setDeletionHold(false);
            return;
          }
          // A confirmed deletion still owns this account's late auth write.
          // Clear that exact tuple rather than retrying the original token.
          cleanupSession = active;
          beginSessionGeneration(null);
        }
        sessionRef.current = null;
        setSession(null);
        if (result?.audited === false) {
          setDeletionAuditPendingNotice(tr("hub.lifecycle.deletedPendingAudit"));
        }
        if (cleanupSession) {
          // This replaces supabase.auth.signOut({ scope: "local" }): the
          // captured-lineage compare-and-clear must preserve a newer login.
          const cleared = await clearCapturedAppSessionLocally(cleanupSession, { explicitSignOut: true });
          if (deletionReceiptRef.current !== outcome) return;
          if (!cleared && appAuthStorageSessionLineage(appAuthStorageKey) !== null) throw new Error("cleanup-pending");
          cleanupSession = null;
          deletionSessionRef.current = null;
        }
        await Promise.all([
          deleteSnapshot(outboxStoreRef.current, userId),
          supabase.realtime.setAuth(),
        ]);
        if (deletionReceiptRef.current !== outcome) return;
        setDeletionCleanup("done");
        deletionCleanupRef.current = null;
      } catch { if (deletionReceiptRef.current === outcome) setDeletionCleanup("failed"); }
    };
    await deletionCleanupRef.current();
    return result || { deleted: false, indeterminate: true };
  }

  async function handleSaveDraft(fields) {
    return memberOperation.run(async () => {
    // Queueable: save_form_draft upserts the caller's single draft per
    // template; coalescing by template key replays only the newest answers.
    // Demo twin: the same one-in-progress-row-per-template upsert into
    // data.forms, returning the row id so FormsView pins formIdRef and the
    // draft survives close/reopen — the RPC's contract, kept locally. The id
    // must return SYNCHRONOUSLY, and setData updaters do not run during the
    // dispatch, so the row is computed here from `fields` (always fresh) and
    // the render-scope forms list, then stashed in demoDraftRowsRef — the
    // freshest copy for the same-event submit that follows a persist, whose
    // onSubmit prop still closes over the pre-save render. The prepend path
    // filters any OTHER in-progress row of the template inside the updater,
    // so back-to-back saves racing a render can never fork two draft rows.
    // No templateVersion, like the seeded fixture rows: FormsView's
    // pinnedTemplate falls back to the active template by key.
    // Outbox args are plain JSON (IndexedDB structured clone), so the
    // lane's onFormId callback stays out of them ( round 2). A form id
    // the save learns before it fails is kept, so a replay names the same
    // form .
    const outboxFields = { ...fields, onFormId: undefined };
    const learnFormId = typeof fields.onFormId === "function"
      ? (formId) => { outboxFields.formId = formId; fields.onFormId(formId); } : undefined;
    try {
    return await mutate(
      // Bound, in the same turn as mutate's actor check, to the member signed
      // in now ( held-commit review).
      memberMutationResources("saveFormDraft"), () => saveFormDraft(sessionDataClient, learnFormId ? { ...fields, onFormId: learnFormId } : fields,
        { asUser: { userId: sessionRef.current?.user?.id ?? null, accessToken: sessionRef.current?.access_token ?? null } }),
      tr("toast.formSaved"),
      { kind: "formDraft", key: fields.templateKey, args: { fields: outboxFields } },
      () => {
        const forms = data.forms || [];
        const existing = forms.find((row) => row.templateKey === fields.templateKey && (row.status === "draft" || row.status === "returned"));
        const id = existing?.id || `form-demo-${Date.now()}`;
        const row = {
          ...(existing || { id, templateKey: fields.templateKey, reviewNote: "", submittedAt: null, cosigners: [] }),
          id,
          status: "draft",
          step: fields.step ?? 0,
          answers: { ...(fields.answers || {}) },
        };
        demoDraftRowsRef.current.set(id, row);
        setData((current) => {
          const list = current.forms || [];
          if (list.some((r) => r.id === id)) return { ...current, forms: list.map((r) => (r.id === id ? row : r)) };
          const inProgressTwin = (r) => r.templateKey === fields.templateKey && (r.status === "draft" || r.status === "returned") && r.id !== id;
          return { ...current, forms: [row, ...list.filter((r) => !inProgressTwin(r))] };
        });
        return id;
      },
    );
    } catch (error) {
      // The form this save names was submitted or closed elsewhere:
      // re-read the forms so Your forms shows where it stands.
      if (isFormNotEditable(error) || isFormSavedElsewhere(error)) {
        await refresh(sessionRef.current, memberMutationResources("saveFormDraft"))
          .catch(() => { /* swallow-ok: the refusal below is the answer; the list refreshes on its next read */ });
      }
      throw error;
    }
      });
  }

  async function handleSubmitForm(formId, review) {
    return memberOperation.run(async () => {
    // Demo twin: flip the SAME draft row to submitted (never a second row),
    // pay the 15-point form rule, and hand the filing to the demo Steward
    // hat's review inbox so the toast's claim is visible somewhere. The row
    // comes from demoDraftRowsRef first: the onSubmit prop FormsView calls
    // closes over an older render's `data`, which predates the persist()
    // flush that just saved the final answers — the ref carries that fresh
    // copy (and is the ONLY place a first-session form exists before the
    // re-render). The render-scope list is the fallback for a resumed draft
    // submitted without new edits. The updater's map by id still lands on
    // the queued row even when it has not rendered yet.
    let result;
    try {
    result = await memberOperation.wait(mutate(
      memberMutationResources("submitForm"), () => submitForm(sessionDataClient, formId, review),
      tr("toast.formSubmitted"),
      null,
      () => {
        const row = demoDraftRowsRef.current.get(formId) || (data.forms || []).find((r) => r.id === formId);
        if (!row) return null;
        const submittedAt = new Date().toISOString();
        setData((current) => ({
          ...current,
          forms: (current.forms || []).map((r) => (r.id === formId ? { ...r, ...row, status: "submitted", submittedAt } : r)),
          rewards: countDemoAction(current.rewards),
        }));
        demoDraftRowsRef.current.delete(formId);
        demoStewardApi.enqueueForm({
          id: formId,
          userId: data.member?.id,
          memberName: data.member?.fullName,
          memberInitials: data.member?.initials,
          templateKey: row.templateKey,
          answers: { ...(row.answers || {}) },
          submittedAt,
          cosigners: row.cosigners || [],
          filerSignedAt: row.filerSignedAt || null,
          filerSignatureDigest: row.filerSignatureDigest || null,
          contentDigest: row.contentDigest || null,
          files: row.files || [],
        });
        return { demo: true };
      },
    ));
    } catch (error) {
      // Another session changed or re-signed the form after review and nothing
      // was filed: re-read the forms before the editor shows them.
      if (isFormChangedSinceReview(error)) {
        await refresh(sessionRef.current, memberMutationResources("submitForm"))
          .catch(() => { /* swallow-ok: the refusal below is the answer; a failed re-read leaves the old answers, which submit_form refuses again */ });
      }
      throw error;
    }
    return result;
      });
  }

  // REQ-UG-FORMS-DISCARD-DRAFT-AND-TEMPLATE-SIGNATURE-20261111: the
  // member discards their own unsubmitted draft. A queued offline save for the
  // same template is dropped first: a replay pass that already listed it skips
  // it, and one already sending it is waited for before the delete, so no
  // replay brings the draft back ( gate round 1).
  async function handleDiscardFormDraft(formId, templateKey) {
    return memberOperation.run(async () => {
      const actingUserId = sessionRef.current?.user?.id;
      const key = actingUserId && templateKey ? `${actingUserId}|formDraft|${templateKey}` : null;
      // The queued offline save is held while the delete runs, so no replay in
      // any tab sends it into the draft being discarded; only a discard the
      // server confirmed removes it for good ( r1s1/r2s2, final r3s2).
      return holdQueuedEntryWhile(outboxStoreRef.current, key, async () => {
        if (templateKey) await replayingFormDraftsRef.current.get(templateKey)?.catch(() => {}); // swallow-ok: waits only for an in-flight replay to settle; the replay reports its own failure
        return memberOperation.wait(mutate(
          memberMutationResources("discardFormDraft"), () => discardFormDraft(supabase, formId,
            { asUser: { userId: sessionRef.current?.user?.id ?? null, accessToken: sessionRef.current?.access_token ?? null } }),
          tr("toast.formDiscarded"),
          null,
          () => {
            demoDraftRowsRef.current.delete(formId);
            setData((current) => ({ ...current, forms: (current.forms || []).filter((row) => row.id !== formId) }));
            return { formId, discarded: true };
          },
        ));
      }, { fence: key ? { userId: actingUserId, templateKey } : null });
    });
  }

  function patchDemoForm(formId, updater) {
    const current = demoDraftRowsRef.current.get(formId)
      || (data.forms || []).find((row) => row.id === formId);
    if (!current) return null;
    const next = updater(current);
    demoDraftRowsRef.current.set(formId, next);
    setData((snapshot) => ({
      ...snapshot,
      forms: (snapshot.forms || []).map((row) => (row.id === formId ? next : row)),
    }));
    return next;
  }

  async function handleSignForm(formId, strokes, consent, review) {
    try {
      return await signFormWrite(formId, strokes, consent, review);
    } catch (error) {
      // Another session saved after review and nothing was signed: re-read the
      // stored form before the editor shows it for a fresh review.
      if (isFormChangedSinceReview(error)) {
        await refresh(sessionRef.current, memberMutationResources("signMemberForm"))
          .catch(() => { /* swallow-ok: the refusal below is the answer; a failed re-read leaves the old answers, which sign_member_form refuses again */ });
      }
      throw error;
    }
  }

  function signFormWrite(formId, strokes, consent, review) {
    return mutate(
      memberMutationResources("signMemberForm"), () => signMemberForm(sessionDataClient, formId, strokes, consent, review),
      tr("toast.formSignatureSaved"),
      null,
      () => {
        const signedAt = new Date().toISOString();
        const signatureDigest = `demo-signature-${formId}-${Date.now()}`;
        demoFormSignaturesRef.current.set(formId, { strokes, signedAt, signatureDigest });
        patchDemoForm(formId, (row) => ({
          ...row,
          filerSignedAt: signedAt,
          filerSignatureDigest: signatureDigest,
          contentDigest: `demo-content-${formId}`,
        }));
        return { formId, signedAt, signatureDigest };
      },
    );
  }

  function handleAddFormFile(formId, file, options) {
    return mutate(
      memberMutationResources("addMemberFormFile"), () => addMemberFormFile(sessionDataClient, formId, file, options),
      tr("toast.formFileAdded"),
      null,
      () => {
        const id = globalThis.crypto?.randomUUID?.() || `demo-form-file-${Date.now()}`;
        const row = {
          id,
          formId,
          bucketId: "demo-session",
          objectName: `${formId}/${id}/${file.name}`,
          filename: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          confirmedAt: new Date().toISOString(),
        };
        demoFormFilesRef.current.set(id, file);
        demoFormSignaturesRef.current.delete(formId);
        patchDemoForm(formId, (form) => ({
          ...form,
          files: [...(form.files || []).filter((item) => item.id !== id), row],
          filerSignedAt: null,
          filerSignatureDigest: null,
          contentDigest: null,
        }));
        return row;
      },
    );
  }

  // The tab is opened on the tap, before any await: Safari and iOS spend the
  // transient user-activation window on the first await, so a post-await
  // window.open silently opens nothing there. `noopener` can make Safari
  // return null even when it did open the tab, so the opener is severed by
  // hand instead. The revoke is deferred because the new tab has not fetched
  // the object URL yet when this function returns.
  async function handleOpenFormFile(row) {
    return memberOperation.run(async () => {
    const popup = window.open("", "_blank");
    if (!popup) throw new Error(tr("uploads.popupBlocked"));
    popup.opener = null;
    try {
      const demoFile = demoFormFilesRef.current.get(row.id);
      const blob = demoFile || await memberOperation.wait(memberFormFileBlob(sessionDataClient, row));
      withObjectUrl(blob, (url) => { popup.location = url; });
    } catch (error) { memberOperation.assertCurrent();
      popup.close();
      throw error;
    }
      });
  }

  function handleRecheckFormFile(row) {
    return recheckPrivateFile(sessionDataClient, "form", row.id);
  }

  function handleRemoveFormFile(row) {
    return mutate(
      memberMutationResources("removeMemberFormFile"), () => removeMemberFormFile(sessionDataClient, row),
      tr("toast.formFileRemoved"),
      null,
      () => {
        demoFormFilesRef.current.delete(row.id);
        demoFormSignaturesRef.current.delete(row.formId);
        patchDemoForm(row.formId, (form) => ({
          ...form,
          files: (form.files || []).filter((item) => item.id !== row.id),
          filerSignedAt: null,
          filerSignatureDigest: null,
          contentDigest: null,
        }));
        return { removed: true };
      },
      null,
      "toast.formFileRemoveFailed",
    );
  }

  async function handleDownloadForm(formId) {
    return memberOperation.run(async () => {
    let file;
    if (demoActive) {
      const form = (data.forms || []).find((row) => row.id === formId);
      if (!form) throw new Error(tr("forms.filing.downloadError"));
      const template = (data.formTemplateVersions || []).find(
        (row) => row.key === form.templateKey && row.version === form.templateVersion,
      ) || (data.formTemplates || []).find((row) => row.key === form.templateKey);
      const signature = demoFormSignaturesRef.current.get(formId);
      const bytes = renderFormFilingPdf({
        demo: true,
        form: {
          id: form.id,
          template_key: form.templateKey,
          template_version: form.templateVersion || 1,
          status: "approved",
          answers: form.answers || {},
        },
        template: await demoFilingTemplate(form.templateKey, form.templateVersion || 1, template, lang),
        filer: { id: data.member?.id, name: data.member?.fullName },
        filerSignature: signature || null,
        cosigners: (form.cosigners || []).map((row) => ({ ...row, strokes: null })),
        attachments: form.files || [],
        approval: {
          approvedBy: "demo-steward",
          approvedAt: form.artifactApprovedAt || form.submittedAt,
          reviewerName: lang === "es" ? "Comité de demostración" : "Demo committee",
          note: form.reviewNote || null,
          artifactDigest: form.artifactDigest || "demo-preview-not-an-official-record",
        },
      }, lang);
      file = new File([bytes], `unionground-demo-filing-${formId}.pdf`, { type: "application/pdf" });
    } else {
      file = await memberOperation.wait(downloadFormFiling(sessionDataClient, formId, lang));
    }
    triggerFormFilingDownload(file);
    return file;
      });
  }

  // Alliance co-signers: the filer invites by email; an invitee accepts/declines
  // (or re-affirms) an incoming request; an accepted co-signer withdraws. Each
  // routes through mutate so the app refreshes and toasts uniformly.
  function handleInviteCosigner(formId, email) {
    return mutate(
      memberMutationResources("inviteCosigner"), () => inviteCosigner(sessionDataClient, formId, email),
      tr("toast.cosignInvited"),
      null,
      () => {
        const invited = { id: `demo-cosigner-${Date.now()}`, email, status: "invited", invitedAt: new Date().toISOString() };
        patchDemoForm(formId, (form) => ({ ...form, cosigners: [...(form.cosigners || []).filter((row) => row.email !== email), invited] }));
        return { status: "invited" };
      },
    );
  }

  async function handleRespondCosign(formId, accept, strokes = null, consent = false, reviewDigest = null) {
    try {
      return await respondCosignWrite(formId, accept, strokes, consent, reviewDigest);
    } catch (error) {
      // The filer changed the grievance after this preview and nothing was
      // co-signed: re-read the requests so the current preview shows.
      if (isCosignChangedSincePreview(error)) {
        await refresh(sessionRef.current, memberMutationResources("respondToCosign"))
          .catch(() => { /* swallow-ok: the refusal below is the answer; a failed re-read keeps the old preview, which respond_to_cosign refuses again */ });
      }
      throw error;
    }
  }

  function respondCosignWrite(formId, accept, strokes, consent, reviewDigest) {
    return mutate(
      memberMutationResources("respondToCosign"), () => respondToCosign(sessionDataClient, formId, accept, strokes, consent, reviewDigest),
      accept ? tr("toast.cosignAccepted") : tr("toast.cosignDeclined"),
      null,
      () => {
        setData((snapshot) => ({
          ...snapshot,
          cosignRequests: accept
            ? (snapshot.cosignRequests || []).map((row) => (row.formId === formId ? { ...row, status: "accepted" } : row))
            : (snapshot.cosignRequests || []).filter((row) => row.formId !== formId),
        }));
        return { status: accept ? "accepted" : "declined" };
      },
    );
  }

  function handleWithdrawCosign(formId) {
    return mutate(
      memberMutationResources("withdrawCosign"), () => withdrawCosign(sessionDataClient, formId),
      tr("toast.cosignWithdrawn"),
      null,
      () => {
        setData((snapshot) => ({
          ...snapshot,
          cosignRequests: (snapshot.cosignRequests || []).filter((row) => row.formId !== formId),
        }));
        return { status: "withdrawn" };
      },
    );
  }

  async function handleLanguage(next) {
    //: a shared demo person's language is the visitor's, kept on this
    // device; it is never saved on the shared account for the next visitor.
    if (sharedPersonaSession) {
      changeBootLanguage(next);
      setNotice(tr("toast.languageUpdated"));
      return undefined;
    }
    return memberOperation.run(async () => {
    const previous = fixtureDemo ? bootLang : (data?.member?.language ?? bootLang);
    // Fixture demo has no saved settings, so its choice is the device's; a
    // real session's choice is the member's (the account slot above).
    const showLanguage = fixtureDemo ? changeBootLanguage : () => setLanguageAttempt((attempt) => attempt + 1);
    showLanguage(next);
    // Optimistic for real sessions: `lang` reads data.member.language, so an
    // offline (queued) save would otherwise leave the UI in the old language
    // until the sync lands. A later successful refresh confirms it.
    setData((prev) => (prev ? { ...prev, member: { ...prev.member, language: next } } : prev));
    try {
      await memberOperation.wait(mutate(
        memberMutationResources("updateMemberSettings"), () => updateMemberSettings(sessionDataClient, session.user.id, { language: next }),
        tr("toast.languageUpdated"),
        { kind: "settings", key: "language", args: { userId: session.user.id, fields: { language: next } } },
      ));
    } catch { memberOperation.assertCurrent();
      // Server said no (a real rejection, not offline — that path queues and
      // resolves). Leaving the optimistic flip would show a language the
      // server will overwrite on the next refresh, and remember the wrong
      // language for this account. mutate already toasted the failure.
      showLanguage(previous);
      setData((prev) => (prev ? { ...prev, member: { ...prev.member, language: previous } } : prev));
    }
      });
  }

  // Topic prefs gate OUTBOUND delivery only (email/push); the in-app feed is
  // always on — the queue trigger reads these values server-side.
  function handleNotificationPrefs(nextPrefs) {
    return mutateWithOutcome(
      memberMutationResources("updateMemberSettings"), () => updateMemberSettings(sessionDataClient, session.user.id, { notificationPrefs: nextPrefs }),
      tr("toast.notificationPrefsSaved"),
      { kind: "settings", key: "prefs", args: { userId: session.user.id, fields: { notificationPrefs: nextPrefs } } },
    );
  }

  function handleFocusSettings(fields) {
    if (demoActive) {
      setData((current) => current ? { ...current, member: { ...current.member, ...fields } } : current);
      setNotice(tr("settings.focusSaved"));
      return Promise.resolve(null);
    }
    return mutate(
      memberMutationResources("updateMemberSettings"), () => updateMemberSettings(sessionDataClient, session.user.id, fields),
      tr("settings.focusSaved"),
    );
  }

  async function handlePushSubscribe(refreshExisting = false) {
    if (demoActive) { setNotice(tr("toast.pushSubscribed")); return; }
    const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
    // A permission prompt can sit open indefinitely, so this function outlives
    // sessions. Bind to the identity that started it: if it changes, the row
    // belongs to the previous member and this UI must not claim it.
    const actingUserId = session.user.id;
    const operation = guardRef.current.captureOperation(actingUserId);
    const stillActing = operation.isCurrent;
    let created = null;
    let retainedRegistration = pushState.subscribed;
    try {
      const permission = await Notification.requestPermission();
      if (!stillActing()) return;
      if (permission !== "granted") {
        setPushState((prev) => ({ ...prev, denied: permission === "denied" }));
        //  (W2-12): trying again cannot help here; say why push stayed off.
        setNotice(tr(permission === "denied" ? "settings.pushBlocked" : "toast.pushPromptClosed"));
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      if (!stillActing()) return;
      let subscription = await registration.pushManager.getSubscription();
      if (!stillActing()) return;
      // subscribe() rejects outright if a subscription already exists under a
      // different key, so a stale one has to go first.
      if (subscription && !subscriptionMatchesKey(subscription, vapidKey)) {
        retainedRegistration = false;
        try { await subscription.unsubscribe(); } catch { /* already gone */ }
        if (!stillActing()) return;
        subscription = null;
      }
      if (!subscription) {
        retainedRegistration = false;
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey),
        });
        created = subscription;
      }
      if (!stillActing()) {
        // Identity changed while we were minting. The endpoint would be
        // registered to the wrong member, so undo rather than persist.
        if (created) { try { await created.unsubscribe(); } catch { /* nothing more to do */ } }
        return;
      }
      await subscribeToPush(sessionDataClient, subscription.toJSON());
      if (!stillActing()) {
        if (created) { try { await created.unsubscribe(); } catch { /* nothing more to do */ } }
        return;
      }
      setPushState((prev) => ({ ...prev, subscribed: true, denied: false }));
      setNotice(tr(refreshExisting ? "toast.pushRefreshed" : "toast.pushSubscribed"));
    } catch {
      // Roll back a newly minted endpoint after a failed registration. A
      // failed refresh of an already-owned endpoint does not remove its
      // existing registration: keep it enabled and leave refresh available.
      if (created) {
        try { await created.unsubscribe(); } catch { /* nothing more to do */ }
      }
      if (!stillActing()) return;
      setPushState((prev) => ({ ...prev, subscribed: retainedRegistration && prev.subscribed }));
      setNotice(tr("toast.pushFailed"));
    }
  }

  async function handlePushUnsubscribe() {
    return memberOperation.run(async () => {
    if (demoActive) { setNotice(tr("toast.pushUnsubscribed")); return; }
    try {
      const registration = await memberOperation.wait(navigator.serviceWorker.ready);
      const subscription = registration ? await memberOperation.wait(registration.pushManager.getSubscription()) : null;
      if (subscription) {
        const endpoint = subscription.endpoint;
        // Browser first, then the registry row: a dangling DB row is pruned by
        // the dispatcher on its next 404/410, but a dangling browser
        // subscription would keep delivering after "off".
        await memberOperation.wait(subscription.unsubscribe());
        await memberOperation.wait(unsubscribeFromPush(sessionDataClient, session.user.id, endpoint));
      }
      setPushState((prev) => ({ ...prev, subscribed: false }));
      setNotice(tr("toast.pushUnsubscribed"));
    } catch { memberOperation.assertCurrent();
      setNotice(tr("toast.pushFailed"));
    }
      });
  }

  async function submitChoice(optionId) {
    return memberOperation.run(async () => {
    // Demo twin: mark the plan item voted so VotingView's voted seal, receipt
    // strip, and quorum bar move the way the live vote moves them. The demo
    // receipt is minted locally; nothing external verifies it. The updater is
    // pure — result and any minted code are computed from the CURRENT data
    // snapshot before dispatch, so a double-invoked updater commits the same
    // value the toast reports.
    const applyDemoChoice = (updater) => () => {
      const item = (data.planItems || []).find((entry) => entry.id === activePlan.id);
      if (!item) return null;
      const updated = updater(item);
      setData((current) => ({
        ...current,
        planItems: (current.planItems || []).map((entry) => (entry.id === activePlan.id ? updated.item : entry)),
      }));
      return updated.result;
    };
    try {
      if (activePlan.kind === "ballot") {
        const receiptCode = await memberOperation.wait(mutate(
          memberMutationResources("submitBallot"), () => submitBallot(sessionDataClient, activePlan.id, optionId),
          tr("toast.voteSaved"),
          null,
          applyDemoChoice((item) => {
            // Demo twin of the server's final-vote guard (20260808230000): a
            // ballot that already holds a receipt refuses a second submission
            // with the server's exact message, so the shared catch below
            // translates demo and live refusals identically. The chosen option
            // is deliberately NOT stored on the item — live votes are
            // unlinkable, and the demo must not model state the product no
            // longer has.
            if (item.receiptCode) throw new Error("your vote is already recorded");
            const code = (globalThis.crypto?.randomUUID?.() || `${Date.now()}`).replaceAll("-", "").slice(0, 8).toUpperCase();
            return {
              result: code,
              item: {
                ...item,
                receiptCode: code,
                quorum: item.quorum
                  ? { ...item.quorum, totalVotes: (item.quorum.totalVotes || 0) + 1 }
                  : item.quorum,
              },
            };
          }),
        ));
        // Demo receipts are minted locally and verify nowhere — the toast
        // says "sample" so the code never reads as a verifiable SG receipt.
        if (receiptCode) setNotice(tr(demoActive ? "toast.voteSavedReceiptDemo" : "toast.voteSavedReceipt", { code: receiptCode }));
        // mutate() throws on a failed write, so reaching here means the vote
        // landed; a missing receipt string is still a saved vote.
        return receiptCode || true;
      }
      return await memberOperation.wait(mutate(
        memberMutationResources("submitSurvey"), () => submitSurvey(sessionDataClient, activePlan.id, optionId),
        tr("toast.answerSaved"),
        null,
        applyDemoChoice((item) => ({ result: optionId, item: { ...item, selectedOption: optionId } })),
      ));
    } catch (error) { memberOperation.assertCurrent();
      // A tab left open across the close boundary still offers "Vote" (closed
      // is derived at load time), so the server's refusal is a reachable path,
      // not an anomaly. Translate it — mutate() surfaced the raw English RPC
      // message — and refresh so the row flips to its Closed/disabled state.
      // "Not found" covers both staff closure and a chapter/eligibility miss.
      // Ask the same RLS-bound client for the exact campaign's server state;
      // an absent row, failed read or client-clock deadline proves no closure.
      const lookupMiss = /(ballot|pulse) not found/i.test(error?.message || "");
      let confirmedClosed = /(ballot|pulse) is closed/i.test(error?.message || "");
      if (lookupMiss) {
        // Publish the localized retry notice before the lookup below: mutate()
        // already left its raw English message in the shell toast, and the
        // dialog can be dismissed while this read is still pending. A
        // confirmed closure replaces the notice once the read settles.
        setNotice(tr("dialogs.choiceUnconfirmed"));
        try {
          const { data: campaign, error: readError } = await memberOperation.wait(supabase
            .from(activePlan.kind === "ballot" ? "member_ballots" : "member_surveys")
            .select("id,campaign_state").eq("id", activePlan.id).maybeSingle());
          confirmedClosed = !readError && campaign?.id === activePlan.id && campaign.campaign_state === "closed";
        } catch { memberOperation.assertCurrent(); }
      }
      if (confirmedClosed) {
        setNotice(tr("toast.itemClosed"));
        refresh(session, memberMutationResources("submitBallot", "submitSurvey")).catch(() => undefined);
        // A tagged refusal, not "": the dialog states this final outcome
        // itself, because the page notice sits behind its backdrop.
        return { refused: "closed" };
      }
      // The ambiguous miss stays retryable, so the shell toast says what the
      // dialog says instead of the raw English "not found" mutate() left
      // there; dismissing the dialog early would otherwise expose it
      // (BUG-UG-SPANISH-VOTE-RETRY-TOAST-20261023).
      if (lookupMiss) {
        refresh(session, memberMutationResources("submitBallot", "submitSurvey")).catch(() => undefined);
      }
      // Votes are FINAL (20260808230000): the same tab-drift can offer "Vote"
      // on a ballot this member already cast elsewhere. Same treatment as the
      // closed refusal — translate the server's exact message and refresh so
      // the row picks up its receipt-derived Voted state.
      if (/your vote is already recorded/i.test(error?.message || "")) {
        setNotice(tr("toast.voteAlreadyRecorded"));
        refresh(session, memberMutationResources("submitBallot", "submitSurvey")).catch(() => undefined);
        return { refused: "already-recorded" };
      }
      throw error;
    }
      });
  }

  // REQ-UG-USAGE-BASED-NAVIGATION-20261001: member destinations are
  // counted and ranked in this browser only; no visit ever reaches the server.
  const navUsage = useNavUsage({
    userId: data?.member?.id ?? null,
    organizationId: data?.member?.organizationId ?? null,
    configuration: data?.organizationConfiguration ?? null,
    view,
    tracking: Boolean(data) && !selectedStaffHatAuthorized,
    persist: !demoActive && demo !== true,
  });
  // Union Ground's lifecycle fixtures for the demo Home campaign card. A
  // hook, so it sits above every early return in this component.
  const [lifecycleFixtures, setLifecycleFixtures] = useState(null);
  useEffect(() => {
    if (!fixtureDemo) return undefined;
    let live = true;
    loadLifecycleFixtures()
      .then((loaded) => { if (live) setLifecycleFixtures(loaded); })
      .catch(() => { /* the card simply stays hidden */ });
    return () => { live = false; };
  }, [fixtureDemo]);

  // REQ-UG-LEARNING-PERIOD-BANNER-HISTORY-UNDO-UI-20261103:
  // the organization's learning period, read once per session and
  // organization; a restricted session reads nothing. The demo organization,
  // shared by every visitor on SAMPLE, reads its period without the
  // administrator's start and end controls
  // (UX-UG-DEMO-ADMIN-OPENS-ON-ONE-TIME-LEARNING-PERIOD-20261108).
  // The learning period is held until its release day
  // (REQ-UG-HOLD-LEARNING-PERIOD-OFFER-UNTIL-RELEASE-20261112,).
  // The fixtures have no server to read the hold from, so they draw no period.
  const learningOrganizationId = data?.member?.organizationId ?? null;
  const learningPeriodSource = useMemo(() => {
    if (fixtureDemo) return { api: null, flags: null };
    if (!session?.access_token || !learningOrganizationId || sessionRestricted) return { api: null, flags: null };
    try {
      const api = createLearningPeriodApi(createCapturedAppSessionRpcClient(session));
      return { api: sharedPersonaSession ? withoutOrganizationControls(api) : api, flags: null };
    } catch {
      return { api: null, flags: null };
    }
  }, [fixtureDemo, session, learningOrganizationId, sessionRestricted, sharedPersonaSession]);
  const learningPeriod = useLearningPeriodController({
    ...learningPeriodSource,
    scope: learningPeriodSource.api ? `${sessionGeneration}:${learningOrganizationId}` : null,
  });
  //: an undo of your own My Reports layout or workload reminder changed
  // the database under the member data; re-read both so the page shows, and
  // the next save sends, the restored choice.
  useLearningUndone(["own_report_preferences", "own_workload_reminder"], (kinds) => {
    if (!fixtureDemo) void refresh(sessionRef.current, learningUndoMemberResources(kinds)).catch(() => {});
  });
  // REQ-UG-NAV-LIGHT-IDENTITY-20261102: the browser tab names the
  // page and the worn role, and the desktop chapter catalog is a flyout from
  // the one rail (closed until its rail button opens it).
  const titleHatKey = selectedStaffHatAuthorized ? selectedStaffHat : "member";
  useWorkspaceDocumentTitle(tr(titleHatKey === "member" ? "demo.hatMember" : STAFF_PLANES.find((plane) => plane.key === titleHatKey)?.labelKey ?? "demo.hatMember"));
  // The tab title names the screen shown below, which the session decides,
  // not the address (signInPathMetadata.js); the demo host always shows sign-in
  // while signed out. null leaves the head alone while a session settles.
  const headScreen = deletionOutcome || authStorageUnavailable || authRestorePending || loading || sampleHatTransitioning
    || requiresBackendConfig({ hasConfig: hasAppBackend, testPreview, demoActive })
    ? null
    : session ? "workspace" : showSignIn || demo ? "sign-in" : "landing";
  useSignInPathMetadata(headScreen);
  const [chapterFlyoutOpen, setChapterFlyoutOpen] = useState(false);
  // The flyout belongs to the rail: when the phone shell replaces the rail it
  // closes, so widening again never brings it back open by itself .
  useEffect(() => { if (!railShell) setChapterFlyoutOpen(false); }, [railShell]);

  const completionLang = deletionLang || lang;
  if (deletionOutcome) return <LanguageProvider lang={completionLang}><div className="sg-app" data-workspace-theme="union-ground"><main className="app-column"><AccountDeletionCompletion
    outcome={deletionOutcome} lang={completionLang} cleanup={deletionCleanup} sample={sampleLive}
    onRetry={() => { void deletionCleanupRef.current?.(); }}
    onContinue={() => {
      if (deletionCleanup !== "done") return;
      deletionReceiptRef.current = null;
      deletionSessionRef.current = null;
      deletionLineageRef.current = null;
      setDeletionOutcome(null);
      setDeletionHold(false);
      if (!sampleLive) landSignedOutAtRoot();
    }}
  /></main></div></LanguageProvider>;

  if (requiresBackendConfig({ hasConfig: hasAppBackend, testPreview, demoActive })) {
    return <LanguageProvider lang={lang}><div className="sg-app"><main className="app-column data-error" aria-live="polite"><span className="eyebrow">{tr("app.configEyebrow")}</span><h1>{tr("app.configTitle")}</h1><p>{tr("app.configBody")}</p><button className="auth-demo" type="button" onClick={enterDemo}>{tr("auth.demo")}</button></main></div></LanguageProvider>;
  }

  if (authStorageUnavailable) {
    return <LanguageProvider lang={lang}><div className="sg-app"><main className="app-column data-error" aria-live="assertive"><span className="eyebrow">{tr("app.authStorageEyebrow")}</span><h1>{tr("app.authStorageTitle")}</h1><p>{tr("app.authStorageBody")}</p><div className="error-actions"><button className="dialog-primary" type="button" onClick={() => globalThis.location?.reload?.()}>{tr("app.tryAgain")}</button></div></main></div></LanguageProvider>;
  }
  // The hat-switch wait names the hat being opened, not a generic reload.
  const openingHat = sampleHatTransitioning ? DEMO_HATS.find((hat) => hat.key === sampleHatOpening) : null;
  if (authRestorePending || loading || sampleHatTransitioning) return <LanguageProvider lang={lang}><AppLoadingScreen label={openingHat ? tr("demo.hatOpening", { hat: tr(openingHat.labelKey) }) : tr("app.loading")} /></LanguageProvider>;
  if (!session) {
    const authScreen = <AuthScreen client={supabase} lang={shownBootLang} onLanguageChange={changeBootLanguage} onDemo={sampleLive ? enterSampleDemo : allowDemoCta ? enterDemo : undefined} demoOriginHref={demo || allowDemoCta ? undefined : sampleTourHref()} onBackToLanding={() => window.location.assign("/")} returnToRequestedPage={!explicitSignOutRef.current && normalizeAppPath(window.location.pathname).startsWith("/m/")} signupAvailable={openSignupOffered} />;
    // returnToRequestedPage: an explicit sign-out ends the visit and its
    // requested page; only an expired or absent session offers a return.
    //
    // Both surfaces take bootLang (as loaded: shownBootLang) +
    // changeBootLanguage, NOT lang: the pre-auth toggle writes bootLang, and
    // passing lang would leave the toggle showing a pressed state the page
    // does not actually render in.
    return (
      <LanguageProvider lang={lang}>
        <>
          {/* Union Ground's front door is the public Learn page at "/",
              rendered before this shell mounts, so a signed-out visitor here
              always gets the sign-in card and "back" returns to that page. */}
          {altShell
            ? <Suspense fallback={<AppLoadingScreen label={tr("app.loading")} />}><AltSignedOut onBackToLanding={() => window.location.assign("/")}>{authScreen}</AltSignedOut></Suspense>
            : <IdentityThemeScope>{authScreen}</IdentityThemeScope>}
          {/* Only the pending-audit outcome, and a session revoked from
              another device (#6885), are surfaced here. The ordinary
              `notice` toast belongs to the authenticated shell and is not
              cleared on sign-out, so rendering it too would flash a stale
              member toast over AuthScreen after an ordinary
              sign-out. The audited:true path stays byte-for-byte unchanged. */}
          <AppStatusNotice message={deletionAuditPendingNotice} />
          {sampleLive && <AppStatusNotice message={sampleEntryError} />}
        </>
      </LanguageProvider>
    );
  }
  // Authenticated but not yet assured: the member has a verified second factor
  // and this session has not cleared it. Hold the shell closed until they do.
  // Still asking: hold the existing loading screen rather than guessing.
  if (mfaRequired === null) {
    return <LanguageProvider lang={lang}><AppLoadingScreen label={tr("app.loading")} /></LanguageProvider>;
  }
  if (mfaRequired) {
    return (
      <LanguageProvider lang={lang}>
        {/* The challenge is its own chunk now, and it is the only thing on
            screen while it loads — so its fallback is the loading screen the
            member was already looking at, not a blank frame. */}
        <Suspense fallback={<AppLoadingScreen label={tr("app.loading")} />}>
          {mfaRequired === "enroll" ? <MfaEnrollment key={session?.user?.id} client={sessionAccountClient}
            onCleared={async () => {
              const active = sessionRef.current;
              if (!active || !sameAuthSessionLineage(active, session)) return;
              const operation = guardRef.current.captureOperation(active.user.id);
              mfaClearedRef.current += 1;
              setDataError("");
              setMfaRequired(false);
              try { await refresh(active); }
              catch (error) {
                if (operation.isCurrent() && !dataRef.current) setDataError(translatedShellLoadError(error, trRef.current));
              }
            }}
            onSignOut={() => { if (sameAuthSessionLineage(sessionRef.current, session)) return signOutAndForget(); }}
          /> : <MfaChallenge key={session?.user?.id}
            client={sessionAccountClient}
            onCleared={() => {
              if (!sameAuthSessionLineage(sessionRef.current, session)) return;
              // Straight from the challenge to loading to the app: the aal1
              // boot failure is cleared here, and only a failure of this
              // refresh may show the data-error screen.
              const operation = guardRef.current.captureOperation(session.user.id);
              mfaClearedRef.current += 1;
              setDataError("");
              setMfaRequired(false);
              refresh(session).catch((error) => { if (operation.isCurrent() && !dataRef.current) setDataError(translatedShellLoadError(error, trRef.current)); });
            }}
            onSignOut={() => { if (sameAuthSessionLineage(sessionRef.current, session)) return signOutAndForget(); }}
          />}
        </Suspense>
      </LanguageProvider>
    );
  }
  if (dataError && !data) return <LanguageProvider lang={lang}><div className="sg-app"><main className="app-column data-error data-error--boot" aria-live="polite"><span className="loading-screen__brand" aria-hidden="true"><BrandMark size={48} /></span><span className="eyebrow">{tr("app.dataEyebrow")}</span><h1>{tr("app.dataTitle")}</h1><p>{dataError}</p>{bootRetry.attempt < BOOT_RETRY_DELAYS_MS.length && <p className="data-error__retry">{tr("app.dataAutoRetry")}</p>}{bootManualRetry.failures > 0 && !bootManualRetry.pending && <p className="data-error__retry">{tr("app.tryAgainStillUnavailable", { count: bootManualRetry.failures })}</p>}<div className="error-actions"><BusyButton className="dialog-primary" type="button" pending={bootManualRetry.pending} onClick={retryBootLoad}>{bootManualRetry.pending ? tr("app.tryingAgain") : tr("app.tryAgain")}</BusyButton><BusyButton className="dialog-secondary" type="button" pending={signingOut} aria-busy={signingOut || undefined} onClick={() => signOutOnce()}>{signingOut ? tr("app.signingOut") : tr("app.signOut")}</BusyButton></div></main></div></LanguageProvider>;
  if (!data || (languagePending && !shellPaintedRef.current)) return <LanguageProvider lang={lang}><AppLoadingScreen label={tr("app.loading")} /></LanguageProvider>;
  // First run for a self-serve account (D2e): a signed-in user on the SaaS host
  // with no organization creates one instead of landing in an empty member
  // shell, but only while the owner's switch offers signup. Demo and SAMPLE
  // keep their unchanged no-organization shell.
  if (!fixtureDemo && !sampleLive && !data.member?.organizationId && data.member?.membershipStatus !== "active"
      && openSignupOffered) {
    return (
      <LanguageProvider lang={lang}>
        <CreateOrganizationGate
          client={sessionAccountClient}
          // UX-UG-ADMIN-NOT-TOLD-ONBOARDING-NEEDS-CHECKLIST-20261018:
          // Settings offers Admin > Start setup once two-step sign-in is on.
          onCreated={(_result, placement) => { window.location.assign(createdOrganizationNextHref(placement)); }}
          onSignOut={() => signOutAndForget()}
        />
      </LanguageProvider>
    );
  }

  // SaaS stays member-scoped. Fixture demo uses its isolated organizations;
  // SAMPLE-live uses the ledger-gated catalog RPC, which returns no rows for a
  // real tenant even if a caller tries to invoke it directly.
  const chapterRailChapters = fixtureDemo
    ? normalizeDemoChapters(data.adminDesk?.organization?.chapters)
    : sampleLive
      ? normalizeSampleChapters(data.sampleChapterCatalog, data.member)
      : normalizeLiveChapters(data.member);
  const homeChapterInCatalog = chapterRailChapters.some((chapter) => chapter.id === data.member?.chapterId)
    ? data.member.chapterId
    : chapterRailChapters[0]?.id ?? null;
  const chapterRailSelectedId = demoChapterSelection?.id ?? homeChapterInCatalog;
  // Live chapter choices (desktop rail, My chapter on tablet and phone). The
  // unsaved-work guard runs before the scope changes; the switch and the
  // re-read are separate so a failed refresh after a committed switch is
  // reported honestly instead of as "nothing changed".
  chapterSelectOptionsRef.current = {
    currentChapterId: data.member?.chapterId,
    guard: () => allowWorkspaceNavigation("/m/organize"),
    switchChapter: switchChapterScope,
    reload: refreshChapterScope,
    open: () => navigate("hub", "/m/organize", null, { guarded: true }),
    // An explicit refusal clears the transition: nothing changed. Any other
    // failure keeps it fenced, since the switch may have committed, so the
    // member is told it could not be confirmed; it
    // said "before using admin tools" to every member).
    onRefused: () => setNotice(tr(chapterTransitionRef.current ? "chapterRail.switchUnconfirmed" : "chapterRail.switchRefused")),
    onReloadFailed: (_error, chapter) => setNotice(tr("chapterRail.switchedReloadFailed", { chapter: chapter?.name || "" })),
    onBusy: setChapterSwitching,
  };

  // Real accounts get the steward hat from their roles; the demo exposes every
  // hat through the switcher. The active hat is derived from the route so the
  // toggle, back/forward, and deep links stay in sync. Staff hats are
  // single-page dashboards, so the member bottom nav is hidden on them.
  const realSteward = !fixtureDemo && Boolean(data.roles?.includes("steward"));
  const realRoles = fixtureDemo ? [] : data.roles ?? [];
  const hasShortcutStewardRole = fixtureDemo || realSteward;
  const saveNavigationPreferences = (changes) => {
    const currentMember = dataRef.current?.member;
    if (!currentMember?.id) return Promise.resolve(null);
    const normalizedShortcuts = normalizeShortcutKeys(
      changes.shortcutKeys ?? currentMember.shortcutKeys,
      hasShortcutStewardRole,
    );
    const normalizedWidgets = normalizeWidgetOrder(
      changes.workWidgetOrder ?? currentMember.workWidgetOrder,
    );
    const snapshot = {
      shortcutKeys: normalizedShortcuts,
      workWidgetOrder: normalizedWidgets,
    };
    const context = {
      userId: currentMember.id,
      generation: guardRef.current.generation,
      demo: demoActive,
    };
    setData((current) => current ? { ...current, member: { ...current.member, ...snapshot } } : current);

    const queueIdentity = `${context.demo ? "demo" : "live"}:${context.userId}:${context.generation}`;
    if (navigationSaveRef.current?.identity !== queueIdentity) {
      const initial = {
        shortcutKeys: normalizeShortcutKeys(currentMember.shortcutKeys, hasShortcutStewardRole),
        workWidgetOrder: normalizeWidgetOrder(currentMember.workWidgetOrder),
      };
      const queue = createNavigationPreferenceSaveQueue({
        initial,
        canCommit: (acting) => guardRef.current.generation === acting.generation
          && guardRef.current.currentUserId === acting.userId,
        persist: async (nextSnapshot, acting) => {
    return memberOperation.run(async () => {
          if (acting.demo) {
            saveDemoNavigationPreferences(acting.userId, nextSnapshot, hasShortcutStewardRole);
            return;
          }
          await memberOperation.wait(mutate(
            memberMutationResources("updateMemberSettings"), () => updateMemberSettings(sessionDataClient, acting.userId, nextSnapshot),
            tr("toast.navigationPreferencesSaved"),
            { kind: "settings", key: "navigation", args: { userId: acting.userId, fields: nextSnapshot } },
          ));
            });
  },
        onRollback: (confirmed) => setData((latest) => latest ? {
          ...latest,
          member: { ...latest.member, ...confirmed },
        } : latest),
      });
      navigationSaveRef.current = { identity: queueIdentity, queue };
    }
    return navigationSaveRef.current.queue.enqueue(snapshot, context).catch(() => null);
  };
  // Chapter work is a shared TOOL, not a hat: while it is open the wearer
  // keeps the hat they explicitly chose, so an Advisor opening the board never
  // silently becomes Coordinator. Cold deep links fail closed to Member (or
  // the already-selected authorized hat); route shape is never identity.
  const selectedTaskHat = selectedStaffHatAuthorized ? selectedStaffHat : null;
  const activeHat = selectedTaskHat ?? "member";
  // Every hat renders the one identity except the steward exception
  // (src/lib/workspaceTheme.js). Cold tasks deep link: the companion phone boots at /m and records the
  // member hat before mirroring to /m/tasks, so the demo desktop must make
  // the same choice or the pair renders two different shells side by side.
  //
  // Union Ground ships ONE theme: its cream, forest-green and gold identity
  // (the --sg-light-* roles restated in styles.css), for every hat, light only
  // (surfaces default to the light cream canvas). The
  // steward exception and system-dark form stay in lib/workspaceTheme.js,
  // inert, rather than being cut out of the shell.
  const workspaceTheme = IDENTITY_WORKSPACE_THEME;
  const renderedWorkspaceTheme = resolveRenderedWorkspaceTheme(workspaceTheme, false);
  const shared = { data, onProfile: () => setProfileOpen(true), onAssistant: compassOn ? () => setAssistantOpen(true) : null };
  // REQ-UG-HOME-NUDGES-20261001: the Home nudge slot's actions. The
  // server silences it during the guided first run; the SAMPLE welcome banner
  // is the client-side welcome tour.
  const homeNudgeActions = {
    authClient: fixtureDemo ? null : sessionAccountClient,
    welcomeTourActive: Boolean(demoWelcomeOpen),
    onOpenOnboarding: () => navigate("memberSupport", "/m/support/onboarding"),
  };
  // REQ-UG-TEMPORARY-PASSWORD-CHANGE-PROMPT-20261018: the emailed
  // password's issue stamp, cleared by the member's own password change.
  const choosePassword = choosePasswordFor(session, fixtureDemo, navigate);
  const qaActor = buildQaActor({
    userId: session?.user?.id || data.member?.id || null,
    organizationId: data.member?.organizationId || (fixtureDemo ? "preview-qa-organization" : null),
    chapterId: data.member?.chapterId || null,
    roles: data.roles || [],
    organizationRoles: fixtureDemo ? [] : (data.member?.organizationRoles || []),
    chapterRoles: fixtureDemo && activeHat !== "member" ? [activeHat] : (data.member?.chapterRoles || []),
    membershipStatus: data.member?.membershipStatus || (data.member?.id || session?.user?.id ? "active" : null),
    mfaSatisfied: fixtureDemo || mfaRequired === false,
    selectedHat: activeHat,
  });
  const qaDemoApi = fixtureDemo ? createQaStoreAdapter(qaDemoStoreRef.current, qaActor) : null;
  const mi1ActorSource = {
    userId: session?.user?.id || data.member?.id || null,
    organizationId: data.member?.organizationId || null,
    chapterId: data.member?.chapterId || null,
    roles: data.roles || [],
    organizationRoles: data.member?.organizationRoles || [],
    chapterRoles: data.member?.chapterRoles || [],
    membershipStatus: data.member?.membershipStatus || (data.member?.id || session?.user?.id ? "active" : null),
    mfaSatisfied: fixtureDemo || mfaRequired === false,
    selectedHat: activeHat,
  };
  const mi1ActorKey = featureActorIdentityKey(mi1ActorSource);
  if (mi1ActorKeyRef.current !== mi1ActorKey) {
    mi1ActorKeyRef.current = mi1ActorKey;
    mi1ActorRef.current = buildMi1FeatureActor(mi1ActorSource);
  }
  const mi1Actor = mi1ActorRef.current;
  const workflowLink = (sourceKind) => (sourceId) => <AutomationWorkflowLink session={mi1Actor} sourceKind={sourceKind} sourceId={sourceId} navigate={navigate} />;
  const mi1AnalyticsActor = buildMi1AnalyticsActor({
    userId: session?.user?.id || data.member?.id || null,
    organizationId: data.member?.organizationId || (fixtureDemo ? "preview-analytics-org" : null),
    chapterId: data.member?.chapterId || null,
    roles: data.roles || [],
    organizationRoles: fixtureDemo && activeHat !== "member" ? [activeHat] : (data.member?.organizationRoles || []),
    chapterRoles: data.member?.chapterRoles || [],
    membershipStatus: data.member?.membershipStatus || (data.member?.id || session?.user?.id ? "active" : null),
    mfaSatisfied: fixtureDemo || mfaRequired === false,
    selectedHat: activeHat,
  });
  const organizationIntelligenceActor = buildOrganizationIntelligenceActor({
    userId: session?.user?.id || data.member?.id || null,
    organizationId: data.member?.organizationId || (fixtureDemo ? "preview-organization-intelligence" : null),
    chapterId: data.member?.chapterId || null,
    roles: data.roles || [],
    organizationRoles: fixtureDemo && activeHat !== "member" ? [activeHat] : (data.member?.organizationRoles || data.roles || []),
    chapterRoles: data.member?.chapterRoles || [],
    membershipStatus: data.member?.membershipStatus || (data.member?.id || session?.user?.id ? "active" : null),
    mfaSatisfied: fixtureDemo || mfaRequired === false,
    selectedHat: activeHat,
  });
  const coordinationActor = buildCoordinationActor({
    userId: session?.user?.id || data.member?.id || null,
    organizationId: data.member?.organizationId || null,
    chapterId: data.member?.chapterId || null,
    organizationRoles: data.member?.organizationRoles || data.roles || [],
    chapterRoles: data.member?.chapterRoles || [],
    membershipStatus: data.member?.membershipStatus || (data.member?.id || session?.user?.id ? "active" : null),
    mfaSatisfied: fixtureDemo || mfaRequired === false,
    selectedHat: activeHat,
  });
  const payActor = buildPayActor({
    userId: session?.user?.id || data.member?.id || null,
    // The credential-free visual-audit fixture needs an active scope to prove
    // explicit-rate calculations. Authenticated SAMPLE/SaaS paths never use
    // this synthetic id; their organization comes from the server projection.
    organizationId: data.member?.organizationId || (fixtureDemo ? "preview-pay-organization" : null),
    chapterId: data.member?.chapterId || null,
    roles: payRolesForSelectedHat({ selectedHat: activeHat, availableRoles: data.roles || [], sample: demo }),
    organizationRoles: data.roles || [],
    chapterRoles: data.member?.chapterRoles || [],
    membershipStatus: data.member?.membershipStatus || (data.member?.id || session?.user?.id ? "active" : null),
    mfaSatisfied: mfaRequired === false,
    selectedHat: activeHat,
  });
  const accessActor = buildAccessActor({
    userId: session?.user?.id || data.member?.id || null,
    organizationId: data.member?.organizationId || (fixtureDemo ? "preview-access-organization" : null),
    chapterId: data.member?.chapterId || null,
    roles: accessRolesForSelectedHat({ selectedHat: activeHat, availableRoles: data.roles || [], sample: demo }),
    organizationRoles: data.roles || [],
    chapterRoles: data.member?.chapterRoles || [],
    membershipStatus: data.member?.membershipStatus || (data.member?.id || session?.user?.id ? "active" : null),
    mfaSatisfied: mfaRequired === false,
    selectedHat: activeHat,
  });
  function handleMessageRedacted(message) {
    if (!message?.id || !message.redacted_at) return;
    // Retain only tombstone fields so later reaction reads remain authoritative.
    const tombstone = { id: message.id, body: "", redacted_at: message.redacted_at, redaction_reason: message.redaction_reason };
    if (!demoActive) memberLoaderRef.current?.confirmProjection(
      `message-redaction:${message.id}`, ["table:member_messages"],
      current => applyMessageTombstone(current, tombstone),
    );
    setData(current => applyMessageTombstone(current, tombstone));
  }
  const sessionMessagingApi = {
    ...messagingApi,
    pollScope: session?.user?.id
      ? JSON.stringify([session.user.id, sessionGeneration, data.member?.organizationId, data.member?.chapterId])
      : null,
    sendResource: (conversationId, documentId, body) => memberOperation.run(() => shareAndConfirmResource({
      send: (...args) => memberOperation.wait(messagingApi.sendResource(...args)),
      loader: memberLoaderRef.current,
      patchConversation,
      userId: session.user.id,
      senderName: data.member?.fullName,
      documents: data.product?.documents,
      formatDate: (value) => conversationDateLabel(value, lang),
    }, conversationId, documentId, body)),
    // Task-message rows save and remind through these direct methods, and the
    // inbox cancels a reminder with cancelReminder; each changes the rows the
    // Saved and Reminders filters read, so each refreshes them like messageAction.
    toggleSaved: (sourceKind, messageId) => memberOperation.run(async () => {
      const result = await memberOperation.wait(messagingApi.toggleSaved(sourceKind, messageId));
      refreshMessageActivityAfter(memberLoaderRef.current, "save");
      return result;
    }),
    remind: (sourceKind, messageId, remindAt) => memberOperation.run(async () => {
      const result = await memberOperation.wait(messagingApi.remind(sourceKind, messageId, remindAt));
      refreshMessageActivityAfter(memberLoaderRef.current, "remind");
      return result;
    }),
    cancelReminder: (reminderId) => memberOperation.run(async () => {
      const result = await memberOperation.wait(messagingApi.cancelReminder(reminderId));
      refreshMessageActivityAfter(memberLoaderRef.current, "unremind");
      return result;
    }),

    loadTaskLanding: (reference) => memberOperation.run(() => memberOperation.wait(loadTaskConversationLanding(supabase, reference, { userId: session?.user?.id }))),
    loadChannelLanding: (reference) => memberOperation.run(() => memberOperation.wait(loadChannelThreadLanding(supabase, reference, { userId: session?.user?.id }))),
    // One bounded page of a channel thread's posts before a cursor .
    ...channelHistoryApi(sessionDataClient, memberOperation, session?.user?.id),
    // One bounded page of a private conversation before a cursor .
    ...privateHistoryApi(sessionDataClient, memberOperation, session?.user?.id),
    loadSourceLanding: (reference) => memberOperation.run(() => memberOperation.wait(loadPrivateMessageLanding(supabase, reference, { userId: session?.user?.id, lang }))),
    messageAction: (sourceKind, messageId, action, value) => memberOperation.run(async () => {
      const result = await memberOperation.wait(messagingApi.messageAction(sourceKind, messageId, action, value));
      const loader = memberLoaderRef.current;
      if (action === "react") {
        const field = sourceKind === "private" ? "private_message_id" : "channel_post_id";
        loader?.confirmRows("rpc:list_member_message_reactions", rows => [
          ...rows.filter(row => row.actor_id !== session.user.id || row[field] !== messageId),
          ...result.state.reactions.map(reaction => ({
            id: `confirmed-${sourceKind}-${messageId}-${reaction}`,
            actor_id: session.user.id, source_kind: sourceKind, [field]: messageId, reaction,
          })),
        ]);
      } else if (action === "edit" || action === "reply") {
        const resource = sourceKind === "private" ? "table:member_messages" : "table:chapter_thread_posts";
        loader?.confirmRows(resource, rows => action === "edit"
          ? rows.map(row => row.id === result.id ? { ...row, ...result } : row)
          : [...rows.filter(row => row.id !== result.id), result]);
      } else {
        refreshMessageActivityAfter(loader, action);
      }
      return result;
    }),
    toggleReaction: (sourceKind, messageId, reaction) => memberOperation.run(async () => {
      const result = await memberOperation.wait(messagingApi.toggleReaction(sourceKind, messageId, reaction));
      const field = sourceKind === "private" ? "private_message_id" : sourceKind === "channel" ? "channel_post_id" : "task_message_id";
      memberLoaderRef.current?.confirmRows("rpc:list_member_message_reactions", rows => {
        const mine = row => row.actor_id === session.user.id && row[field] === messageId && row.reaction === reaction;
        const others = rows.filter(row => !mine(row));
        return result?.reacted === false ? others : [...others, {
          id: result?.id ?? `confirmed-${sourceKind}-${messageId}-${reaction}`,
          actor_id: session.user.id, source_kind: sourceKind, [field]: messageId, reaction,
        }];
      });
      return result;
    }),
  };
  // Cases are the one palette/search surface whose corpus outgrows the boot
  // snapshot, so both ask Postgres (REQ-...-57-CASE-SEARCH-20260917). Same
  // client gate as the knowledge snapshot: fixtures and org-less sessions have
  // nothing to ask. Declared before `views` so SearchView can close over it.
  const caseSearchClient = fixtureDemo || !data.member?.organizationId ? null : supabase;
  const connectedDataScope = [data.member?.id, data.member?.organizationId, data.member?.chapterId].join(":");
  const connectedScope = `${connectedDataScope}:${selectedStaffHat}`;
  const announcementContext = { session: fixtureDemo ? null : session, organizationId: data.member?.organizationId ?? null,
    chapterId: data.member?.chapterId ?? null, hat: selectedStaffHat, createClient: createCapturedAppSessionRpcClient,
    preview: fixtureDemo, restricted: sessionRestricted };
  if (connectedDemoStateRef.current.scope !== connectedDataScope) {
    connectedDemoStateRef.current = { scope: connectedDataScope, tasks: new Map(), sources: new Map(), reminders: new Map(), sends: new Map() };
  }
  const rawConnectedApi = demoActive ? createDemoConnectedWorkflowApi({
    getData: () => dataRef.current, getStaffData: () => demoDeskRef.current, state: connectedDemoStateRef.current,
    isStaff: () => explicitHatAllowsView(selectedStaffHatRef.current, "tasks", demo, dataRef.current?.roles || [], !railShell, "/m/tasks"),
    createTask: handleCreateTaskFromSource, sendTaskMessage: handleSendTaskMessage,
  }) : connectedWorkflowApi;
  const sessionConnectedApi = Object.fromEntries(Object.entries(rawConnectedApi).map(([name, method]) => [name, (...args) => memberOperation.run(async () => {
    const startingHat = selectedStaffHatRef.current;
    if (name === "createTask" && !explicitHatAllowsView(startingHat, "tasks", demo, dataRef.current?.roles || [], !railShell, "/m/tasks")) throw new Error("Task creation unavailable");
    const result = await memberOperation.wait(method(...args));
    if (selectedStaffHatRef.current !== startingHat) throw new Error("Selected identity changed");
    return result;
  })]));
  const connectedDemoMessagingApi = {
    ...demoMessagingApi,
    remind: async (sourceKind, id, remindAt) => {
      const kind = { private: "private_message", channel: "channel_post", task: "task_message" }[sourceKind];
      const result = await sessionConnectedApi.remind({ kind, id }, remindAt);
      return result.reminder;
    },
  };
  async function navigateConnected(href) {
    const reference = workflowReferenceFromHref(href);
    if (reference) {
      const current = await sessionConnectedApi.context(reference);
      if (!current.available) throw new Error("Source unavailable");
    }
    const destination = workflowDestination(href, { selectedHat: selectedStaffHatRef.current, staffAccess: selectedStaffHatAuthorized });
    if (!destination || !explicitHatAllowsView(selectedStaffHatRef.current, destination.view, demo, dataRef.current?.roles || [], !railShell, destination.href)) {
      setNotice(lang === "es" ? "Este elemento no está disponible con la identidad seleccionada." : "This item is unavailable for the selected identity.");
      return;
    }
    if (destination.view === "tasks") {
      const id = new URL(destination.href, window.location.origin).searchParams.get("task");
      if (id) await handleOpenSourceTask({ id });
      else navigate(destination.view, destination.href);
    } else navigate(destination.view, withWorkflowReturn(destination.href, window.location.pathname + window.location.search));
  }
  const connectedActions = (kind) => (record) => <ConnectedRecordActions
    reference={{ kind, id: record.id, chapterId: record.chapterId || (kind === "task" ? data.member?.chapterId : undefined), organizationId: record.organizationId || undefined }}
    scopeKey={connectedScope} api={sessionConnectedApi} staffAccess={selectedStaffHatAuthorized}
    onNavigate={navigateConnected} onOpenTask={async (task, source) => {
      const current = await sessionConnectedApi.context(source);
      if (!current.available || current.linkedTask?.id !== task.id) throw new Error("Source unavailable");
      await handleOpenSourceTask({ ...task, workflowReturnHref: current.href });
    }} onNotice={setNotice} />;
  const workflowReturn = safeWorkflowReturn(new URLSearchParams(window.location.search).get("returnTo"));

  // REQ-UG-REACTIVATION-WELCOME-BACK-20261001: the welcome-back screen's
  // next steps that TodayView has no handler for yet.
  const welcomeBackActions = {
    onOpenUpdates: () => navigate("messages", "/m/messages"),
    onOpenRights: () => navigate("rights", "/m/rights"),
  };
  // Governed quotes and mini-lessons get the member's session, a factory for a
  // client captured to that session's token (a late request can never ride a
  // later user's session), the selected organization and chapter, and the
  // language. Fixture harnesses run the feature's in-tab fiction instead.
  const learningContent = {
    createSessionClient: fixtureDemo ? null : createCapturedAppSessionRpcClient,
    session,
    preview: fixtureDemo,
    // The sample site's seeded personas, by the signed-in session's own email.
    sharedDemoPersona: sampleLive && samplePersonas().some((persona) => persona.email === session?.user?.email),
    organizationId: data.member?.organizationId || (fixtureDemo ? "preview-learning-organization" : null),
    chapterId: data.member?.chapterId || (fixtureDemo ? "preview-learning-chapter" : null),
    locale: lang,
    memberHat: activeHat === "member",
  };
  // REQ-UG-CONTEXTUAL-PULSE-PRODUCT-TRIGGERS-20261001 (CR-014): reading
  // screens ask staff-written quick checks through the member's own session.
  // Fixture previews and accounts without an organization never ask.
  const pulse = {
    client: fixtureDemo || !data.member?.organizationId ? null : sessionDataClient,
    configuration: data.organizationConfiguration ?? null,
  };
  // REQ-UG-QUARTERLY-SURVEY-GATE-ENFORCED-20261001 ("give to view", CR-002):
  // reports/charts, workload and the analytics desk dim until the member
  // completes this quarter's open survey. The server gate applies the
  // organization switch and the admin exemption and fails open; fixture
  // previews never gate.
  // REQ-UG-ROLE-WORKSPACE-REFUSALS-20261030: integrations, the
  // organization map and organization analytics open only with an
  // organization-wide grant (the server's has_organization_role). Under a role
  // that cannot open one, the page says which organization-wide role does and
  // offers to act in a held role that does, instead of loading into a refusal
  // whose "Try again" could never succeed. Demo hats keep their own wiring.
  const organizationRolesHeld = data.member?.organizationRoles || [];
  const organizationWorkspace = (view, pageKey, render) => {
    if (demo) return render();
    const access = organizationWorkspaceAccess(view, { hat: selectedStaffHat, roles: data.roles || [], organizationRoles: organizationRolesHeld });
    if (access.status === "open") return render();
    return <OrganizationRoleRefusal pageKey={pageKey} access={access} onWear={(hat) => {
      selectedStaffHatRef.current = hat;
      setSelectedStaffHat(hat);
    }} />;
  };
  // The library's staff reads (collections, staff files, upload chapters,
  // ingest health) are organization-grant reads too: a chapter-only role keeps
  // the member library rather than a "not authorized" box after every save.
  const knowledgeStaffAccess = selectedStaffHatAuthorized && (demo || organizationRolesHeld.includes(selectedStaffHat));
  const quarterlySurveyGate = (content) => <QuarterlySurveyGate
    client={fixtureDemo ? null : sessionDataClient}
    organizationId={data.member?.organizationId || null}
    sessionKey={session?.user?.id ?? null}
    onTakeSurvey={(surveyId) => navigate("voice", surveyId ? `/m/voice?survey=${encodeURIComponent(surveyId)}` : "/m/voice")}
  >{content}</QuarterlySurveyGate>;
  // REQ-UG-HOME-OVERRIDE-UNREAD-STEWARD-MESSAGE-20261001: the Home
  // takeover opens or marks read through the same handlers Messages uses.
  const homeTakeover = {
    onOpenConversation: (conversationId) => navigate("messages", "/m/messages", { view: "messages", conversationId }),
    onOpenBroadcast: (broadcastId) => navigate("messages", "/m/messages", { view: "messages", broadcastId }),
    onMarkConversationRead: async (...args) => (await handleReadConversation(...args))?.value,
    onMarkBroadcastRead: async (...args) => (await handleReadBroadcast(...args))?.value,
  };
  // Issue intelligence (REQ-UG-ISSUE-INTELLIGENCE-SIGNALS-20261001): the
  // banner and staff panel read get_issue_intelligence_signals themselves
  // through a client captured to this session (as the learning card does);
  // the server derives the organization and enforces switch, hat and privacy
  // floor. Fixture harnesses have no backend and render nothing.
  const openIssueDestination = (destination, href = null) => {
    const target = ISSUE_DESTINATIONS[destination];
    if (!target) return;
    const path = href && href.startsWith(`${target.path}?`) ? href : target.path;
    if (!explicitHatAllowsView(selectedStaffHatRef.current, target.view, demo, data?.roles || [], !railShell, path)) {
      setNotice(lang === "es" ? "Este elemento no está disponible con la identidad seleccionada." : "This item is unavailable for the selected identity.");
      return;
    }
    if (target.staff) navigateStaff(target.view, path);
    else navigate(target.view, path);
  };
  const issueSignals = fixtureDemo ? null : {
    createSessionClient: createCapturedAppSessionRpcClient,
    session,
    scopeKey: `${session?.user?.id || ""}:${data.member?.organizationId || ""}:${data.member?.chapterId || ""}`,
    onNavigate: openIssueDestination,
  };
  // Case queue next actions and the steward attention queue
  // (REQ-UG-CASE-QUEUE-SIGNALS-AND-NEXT-ACTION-20261001,
  // REQ-UG-STEWARD-ATTENTION-TREND-20261001): the panels read their own
  // projections through a client captured to this session; fixture
  // harnesses render nothing.
  const caseSignals = fixtureDemo ? null : {
    createSessionClient: createCapturedAppSessionRpcClient,
    takeNextActions,
    session,
    scopeKey: `${session?.user?.id || ""}:${data.member?.organizationId || ""}:${data.member?.chapterId || ""}`,
  };
  // REQ-UG-COMPASS-PAGE-AND-CASE-AWARE-HELP-20261001: "Ask Compass about
  // this case" on the member's own case, offered only while the organization
  // allows it (the server enforces the same switches and re-reads the case).
  // REQ-UG-FIELD-NOTES-AI-PACKET-20261001: "Draft a packet" on the field
  // notes view, offered only while the organization allows it. The server
  // enforces the switches, the note limit and the caller's own chapter scope.
  const fieldNotesPacket = Boolean(compassScopeKey) && fieldNotesPacketEnabled(data.organizationConfiguration)
    ? {
      noteLimit: fieldNotesPacketNoteLimit(data.organizationConfiguration),
      draft: (taskId, noteIds) => requestFieldNotesPacket(session, taskId, noteIds),
    }
    : null;
  const compassCaseHelp = Boolean(compassScopeKey) && caseHelpEnabled(data.organizationConfiguration)
    ? {
      ask: (caseId, questionKey) => requestCaseHelp(session, caseId, questionKey),
      includesNarrative: caseHelpIncludesNarrative(data.organizationConfiguration),
      // REQ-UG-COMPASS-ACTION-OFFERS-20261001: keep an answer as a case
      // note only after confirmation, through the member's own case-note path.
      addNote: compassOffersOn ? async (caseId, body) => {
        // mutate() throws on a refused write; a resolved call is a saved note.
        await mutate(memberMutationResources("addCaseUpdate"), () => addCaseUpdate(sessionDataClient, session.user.id, caseId, body.slice(0, 4000)), tr("toast.caseNoteSaved"), null, null, null, "toast.saveFailed");
      } : null,
    }
    : null;
  // The campaign card on Home names the fixture campaign in the demo; a live
  // session has no lifecycle read on Home yet, so the card stays hidden.
  const workerCampaign = fixtureDemo ? (lifecycleFixtures?.campaigns ?? [])[0] || null : null;
  // The alternate shell's chapter switch: the same two paths the ChapterRail
  // and the chapter cards take (SAMPLE catalog selection; SaaS member scope).
  // The demo's chapter catalog workspace mounts only on the desktop layout, so
  // below it the alternate chrome offers no chapter switching (the classic
  // chapter rail is desktop-only for the same reason).
  const altSelectChapter = (chapter, trigger) => {
    if (demo) {
      // The catalog workspace replaces the Now page, and a closed rail is
      // inert, so the clicked control may be gone or unfocusable when the
      // workspace closes: the side nav's Switch chapter control (or the
      // current chapter's row) takes the focus instead.
      demoChapterTriggerRef.current = {
        focus: () => {
          const usable = trigger instanceof HTMLElement && trigger.isConnected && !trigger.closest("[inert]");
          (usable ? trigger : document.querySelector("#ug-side [data-ug-rail-opener], #ug-side .ug-side-chs [aria-current]"))?.focus();
        },
      };
      restoreDemoChapterFocusRef.current = false;
      setDemoChapterSelection(chapter);
    } else selectMemberChapterRef.current(chapter);
  };
  // The demo's chapter catalog workspace mounts only on the desktop layout, so
  // below it the alternate chrome offers no chapter switching (the classic
  // chapter rail is desktop-only for the same reason).
  const altChapterSelector = demo && !desktopShell ? null : altSelectChapter;
  // REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP2-20261023: the member
  // guide's one decision point. The card, the navigation's guide and spotlight
  // and the proposed layers all come from this plan() view in "The product
  // today" mode; each surface keeps its own hat and placement rules.
  const orgStartNavigation = selectedStaffHatAuthorized ? STAFF_ROLE_NAVIGATION[selectedStaffHat] ?? [] : [];
  // A guide screen is the hat's own navigation line, or a tab page under one
  // (the knowledge editor is Organize's Library tab, /m/organize/library):
  // BUG-UG-ORG-START-GUIDE-KNOWLEDGE-TARGET-AND-PICKER-CAP-20261102.
  const orgStartEntry = (path) => {
    const bare = path.split("?", 1)[0];
    const direct = orgStartNavigation.find((item) => item.path === bare);
    if (direct) return direct;
    const page = workspacePageForLocation(bare);
    const base = page?.tab && !isStaffOnlyWorkspaceTabPath(bare) ? TAB_PAGE_GROUPS[page.group]?.base : null;
    return base ? orgStartNavigation.find((item) => item.path === base) ?? null : null;
  };
  // The guide's "your steward" is never the viewer, nor a steward nobody
  // could message .
  const guideNamedSteward = guideSteward(data.chapterStewards, data.member?.id ?? null, stewardMessageAvailable);
  //: whether a steward is named for this reader, read by every member
  // page that would otherwise promise one.
  const memberStewardPresence = stewardPresence({
    stewards: data.chapterStewards,
    viewerId: data.member?.id ?? null,
    messageAvailable: stewardMessageAvailable,
    rosterLoaded: data.chapterStewardsLoaded,
    chapterId: data.member?.chapterId ?? null,
  });
  const guideView = planMemberGuide({
    now: Date.now(),
    hat: "member",
    switches: data.organizationConfiguration?.switches ?? null,
    guide: onboardingGuidePayload,
    guideFailed: onboardingGuideLoadFailed,
    who: { memberOnlyAccount: memberOnlyAccount(data), accountCreatedAt: demoActive ? null : session?.user?.created_at ?? null },
    prefs: { showAll: onboardingGuideShowAll, completeDismissed: readGuideCompleteDismissed(data.member?.id ?? null) },
    screen: { view: activeHat === "member" ? view : null },
    stewardName: guideNamedSteward?.name ?? null,
    layers: { featureMarks: guideLayers.featureMarks, coach: { ...coachFacts, shownThisSession: guideLayers.coachSession, seen: guideLayers.coachSeen } },
    // The notice composer on the inbox opens only for a role that posts
    // notices (REQ-UG-OFFICER-NOTICES-WITH-READ-RECEIPTS-20261030).
    orgStart: { payload: orgStartGuideState.payload, reachable: (path) => Boolean(orgStartEntry(path)) && (path !== NOTICE_COMPOSER_PATH || NOTICE_HATS.includes(selectedStaffHat)) },
    staff: {
      payload: staffGuideState.payload,
      hat: staffGuideHat,
      path: normalizeAppPath(routeLocation.split(/[?#]/, 1)[0]),
      memberPlan: onboardingGuidePayload?.enrolled === true ? { completed: onboardingGuidePayload.completedSteps, total: onboardingGuidePayload.totalSteps } : null,
      chapterId: data?.member?.chapterId ?? null,
    },
  });
  // The navigation's guide: the organization's own, or the guided core
  // navigation for a member's first 14 days when the organization has none
  // (UX-UG-WEB-NAVIGATION-TOO-MANY-DESTINATIONS-20261018).
  const navGuide = guideView.nav.guide;
  // Only the enabled layer observes outcomes; page callbacks always receive
  // the mutation's raw value, as they did before guide completion tracking.
  const guideActionAfter = (feature, handler) => (featureGuidesOn ? countGuideAction(feature, handler, globalThis, memberOperation) : async (...args) => (await handler(...args))?.value);
  const memberGuides = activeHat === "member" ? guideView.featureGuides : null;
  // Opens a guide's page: a navigation line of the worn hat, or a tab page
  // under one. Guide 1's pages and the units step's parts both use it.
  const openGuidePage = (target) => {
    const item = orgStartEntry(target.path);
    if (item) navigateStaff(item.viewKey ?? item.key, target.path);
  };
  // Guide 1 sits at the top of the hat's own home page, never on its sub-pages.
  const orgStartSlot = guideView.orgStart && STAFF_PLANES.some((plane) => plane.key === selectedStaffHat && normalizeAppPath(routeLocation.split(/[?#]/, 1)[0]) === plane.path)
    ? <DeferredOrgStartGuide
      guide={{ view: guideView.orgStart }}
      onOpen={openGuidePage}
      onReviewSwitches={orgStartGuideState.reviewSwitches}
      onSaveContacts={orgStartGuideState.saveContacts}
      onCelebrated={orgStartGuideState.celebrate}
      celebrationKey={`${session?.user?.id ?? ""}:${data?.member?.organizationId ?? ""}`}
    />
    : null;
  // REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP4-20261029: the worn
  // staff hat's feature guides. Its list sits under guide 1 on the hat's home;
  // a guide's card sits at the top of its own page until Got it. Staff who
  // hold a member plan also see their member steps as their own group.
  const staffGuidePath = normalizeAppPath(routeLocation.split(/[?#]/, 1)[0]);
  const staffGuides = guideView.staffGuides;
  // A guide page is the hat's own navigation line or a tab page under one, as
  // for guide 1; the units step's chapter access part is Organize's Record tab.
  const openStaffGuide = (item) => {
    void staffGuideState.mark(item.stepId, "reopen");
    const entry = orgStartEntry(item.path);
    if (entry) navigateStaff(entry.viewKey ?? entry.key, item.path);
    else if (item.feature === "settings") navigate("settings", "/m/settings");
    else if (item.feature === "messages") navigate("messages", "/m/messages");
  };
  const closeStaffGuide = (item) => {
    void staffGuideState.mark(item.stepId, "got");
    globalThis.requestAnimationFrame?.(() => document.getElementById("main-content")?.focus());
  };
  // A looking action is done by the guide's own button; any other first action
  // is on the page the card sits on, so the button closes the card onto it.
  const staffGuidePrimary = (item) => {
    if (item.doneOnPrimary) void staffGuideState.complete(item.stepId);
    closeStaffGuide(item);
  };
  const staffGuideList = staffGuides && STAFF_PLANES.some((plane) => plane.key === selectedStaffHat && staffGuidePath === plane.path)
    ? <StaffGuideList guides={staffGuides} onOpen={openStaffGuide} onFirstSwitch={(role) => { void staffGuideState.mark(roleSwitchStepId(role), "seen"); }} />
    : null;
  // A message a staff hat sends finishes that hat's Messages guide once the
  // server has saved it, for the person who sent it.
  const staffMessageSent = async (...args) => {
    const hat = staffGuideHat;
    const started = staffGuideScopeRef.current;
    const result = await handleSendMemberMessage(...args);
    if (result?.messageId && staffGuideScopeRef.current === started) staffGuideHooks.finish(hat, "messages");
    return result;
  };
  // Guide 1, then the hat's feature guides, at the top of a staff hat's home.
  // UB-UG-DEMO-STAFF-HATS-OPEN-ON-DESK-20261107: on the shared demo
  // personas the visitor came to see the desk, so the guides follow it.
  const planeGuideSlot = orgStartSlot || staffGuideList ? <>{orgStartSlot}{staffGuideList}</> : null;
  const withPlaneGuides = (desk) => deskWithGuides(desk, planeGuideSlot, sharedPersonaSession);
  const openGuideFeature = (item) => { guideLayers.markFeature("reopen", item.feature); navigate(item.view, item.path); };
  // Either button closes the card; on the feature's own page the person's
  // activation then lands focus on the page content (the skip-link target),
  // never on the removed button.
  const closeFeatureGuide = (item) => {
    guideLayers.markFeature("got", item.feature);
    globalThis.requestAnimationFrame?.(() => document.getElementById("main-content")?.focus());
  };
  const featureGuidePrimary = (item) => {
    if (item.doneOnPrimary) guideLayers.markFeature("acted", item.feature);
    if (item.feature === "home") {
      const target = guideView.card?.target ?? { view: "events", path: "/m/events" };
      navigate(target.view, target.path);
    } else if (item.feature === "member-support" && guideNamedSteward) {
      handleContactSteward(guideNamedSteward);
    } else {
      closeFeatureGuide(item);
    }
  };
  const featureGuideCard = (onView) => memberGuides?.showing?.view === onView
    ? <MemberFeatureGuide key={memberGuides.showing.feature} guides={memberGuides} onPrimary={featureGuidePrimary} onGotIt={closeFeatureGuide} onSeen={markFeatureGuideSeen} />
    : null;
  const coachMark = activeHat === "member" && guideView.coachMark
    ? { anchor: guideView.coachMark.anchor, describedBy: COACH_MARK_ID, element: <MemberCoachMark mark={guideView.coachMark} onShown={guideLayers.markCoachShown} onClose={guideLayers.markCoachSeen} /> }
    : null;
  // One builder for the onboarding guide card so the column-level copy and
  // the phone Home slot can never drift apart. Member hat only; null otherwise.
  // Home's guidance slot (BUG-UG-PASSWORD-PROMPT-OVERLAPS-ONBOARDING-20261020)
  // clones Home's copy with the ordinary nudge as the card's fallback, so a
  // member reads one prompt: the password reminder, then the guide, then the
  // nudge. On other pages the feature guide is the fallback, so only one
  // guide mounts above the working content at a time.
  const onboardingHudCard = (className = "", children = null, { hideComplete = false } = {}) => activeHat === "member"
    ? <OnboardingHud card={guideView.card} navigationGuide={navGuide} showAll={onboardingGuideShowAll} memberId={data.member?.id ?? null} onNavigate={(key, path) => navigate(key, path)} loadFailed={onboardingGuideLoadFailed} onRetry={retryOnboardingGuide} className={className} hideComplete={hideComplete}>{children}</OnboardingHud>
    : null;
  const homeGuides = activeHat === "member"
    ? <>{featureGuideCard("today")}<MemberGuideList guides={memberGuides} onOpen={openGuideFeature} /></>
    : null;
  // The calendar's records open where the classic app opens them.
  const openAltRecord = (item) => {
    const target = recordTarget(item);
    if (target.broadcastId) homeTakeover.onOpenBroadcast(target.broadcastId);
    else if (target.planItem) handlePlanAction(target.planItem);
    else navigate(...target.navigate);
  };
  // REQ-UG-ALT-PORT-MEMBER-PAGES-20261030 (E2): under the alternate
  // shell these views draw the prototype's own page (its pages directory), hero
  // included, around their production content.
  const altPageProps = altShell ? { alt: true, onOpenHome: () => navigate("today", "/m") } : {};
  // Signed-in accounts, SAMPLE included: SAMPLE sessions are real accounts
  // (demo is true on that origin), and the invitation route keeps its SAMPLE
  // recipient allowlist. Only the test-only fixture demo has no server.
  const requestsPanel = fixtureDemo || !session?.user?.id ? null : <MemberRequestsPanel
    key={session.user.id}
    api={memberRequestsApi}
    refreshKey={notificationOpenIntent?.path === "/m/settings/requests" ? notificationOpenIntent.id : 0}
    canDecide={[...(data.roles || []), ...(data.member?.organizationRoles || [])].some((role) => role === "admin" || role === "vp")}
    memberSendEnabled={memberSentInvitationsEnabled(data)}
    lang={lang}
    onNotice={setNotice}
  />;
  // The live chapter transition fences the labels until the authenticated
  // profile commits. The chart must independently return the same scope.
  const fixtureOrgStructure = fixtureDemo ? data.memberOrgStructure ?? null : null;
  const chartOrganizationId = fixtureDemo ? fixtureOrgStructure?.organizationId : currentOrganizationId;
  const chartChapterId = data.member?.chapterId ?? null;
  const chartChapterName = data.member?.chapterName?.trim();
  const chartScopeLabels = chartOrganizationId && !sessionRestricted
    && (fixtureDemo || (data.member?.id === session?.user?.id && !chapterTransition?.operation.isCurrent()))
    ? {
        organizationId: chartOrganizationId,
        chapterId: chartChapterId,
        organizationName: currentOrganizationName?.trim(),
        chapterName: chartChapterId && chartChapterName !== chartChapterId ? chartChapterName : null,
      }
    : null;
  const homeCompassPins = compassOffersOn
    ? <CompassPinnedAnswers pins={compassPins} loadFailed={compassPinsFailed} onRetry={refreshCompassPins}
        onUnpin={(messageId) => compassAnswerActions.pin(messageId, false)} onAsk={(question) => openCompassWithDraft(question || "")} />
    : null;
  const homeOrgSetup = guideView.orgStart?.kind === "guide"
    ? { done: guideView.orgStart.ring.done, total: guideView.orgStart.ring.total, nextKey: guideView.orgStart.next?.title?.key ?? null }
    : { phase: orgStartGuideState.phase, retry: orgStartGuideState.reload };
  const views = {
    today: altShell
      ? <AltNowPage {...shared} orgSetup={homeOrgSetup} dues={duesNav} stewardMessageAvailable={stewardMessageAvailable} sessionRestricted={sessionRestricted} desktop={railShell} onboardingHud={onboardingHudCard("onboarding-hud--home")} homeGuides={homeGuides} compassPins={homeCompassPins} onPlanAction={handlePlanAction} onRewards={() => navigate("rewards", "/m/rewards")} onOpenReports={() => navigate("numbers", "/m/numbers")} onOpenSearch={() => navigate("search", "/m/search")} onOpenEvents={(event) => navigate("events", event?.id ? `/m/events?event=${encodeURIComponent(event.id)}` : "/m/events")} onOpenBroadcast={(broadcast) => homeTakeover.onOpenBroadcast(broadcast.id)} onDemoTour={personaRouting && !embedPhone && !railShell ? () => { captureDemoAction("open_guide", view); setGuideOpen(true); } : null} onOpenWorkload={() => navigate("workload", "/m/workload")} onOpenCases={(caseId) => navigate("cases", "/m/cases", typeof caseId === "string" ? { view: "cases", caseId } : null)} onOpenMessages={() => navigate("messages", "/m/messages")} onOpenUpdates={() => navigate("updates", "/m/updates")} onContactSteward={handleContactSteward} onOpenOrgStructure={() => navigate("orgStructure", "/m/org-structure")} learningContent={learningContent} homeTakeover={homeTakeover} welcomeBack={welcomeBackActions} homeNudges={homeNudgeActions} choosePassword={choosePassword} issueSignals={issueSignals} onNavigate={(key, path, sectionId) => railNavigate(key, path, sectionId)} onSwitchHat={switchHat} chapters={chapterRailChapters} selectedChapterId={chapterRailSelectedId} onSelectChapter={altChapterSelector} />
      : <TodayView {...shared} stewardMessageAvailable={stewardMessageAvailable} orgSetup={homeOrgSetup} sessionRestricted={sessionRestricted} desktop={railShell} onboardingHud={onboardingHudCard("onboarding-hud--home")} homeGuides={homeGuides} onSwitchHat={switchHat} compassPins={homeCompassPins} onPlanAction={handlePlanAction} onRewards={() => navigate("rewards", "/m/rewards")} onOpenReports={() => navigate("numbers", "/m/numbers")} onOpenSearch={() => navigate("search", "/m/search")} onOpenEvents={() => navigate("events", "/m/events")} onOpenWorkload={() => navigate("workload", "/m/workload")} onOpenCases={(caseId) => navigate("cases", "/m/cases", typeof caseId === "string" ? { view: "cases", caseId } : null)} onOpenMessages={() => navigate("messages", "/m/messages")} onContactSteward={handleContactSteward} onOpenOrgStructure={() => navigate("orgStructure", "/m/org-structure")} learningContent={learningContent} homeTakeover={homeTakeover} welcomeBack={welcomeBackActions} homeNudges={homeNudgeActions} choosePassword={choosePassword} issueSignals={issueSignals} campaign={workerCampaign} onOpenCampaign={() => navigate("organize", demo ? "/m/organize?demo=1" : "/m/organize")} />,
    // Union Ground: the worker Work list (organizing tasks assigned to the
    // worker), first-class beside Home in the rail and the native dock.
    work: <WorkView {...shared} />,
    orgStructure: <OrgStructureView
      key={JSON.stringify([data.member?.id, chartOrganizationId, chartChapterId])}
      scopeLabels={chartScopeLabels}
      desktop={railShell}
      client={fixtureDemo ? null : sessionDataClient}
      structure={fixtureOrgStructure}
      focus={searchFocus?.view === "orgStructure" ? searchFocus : null}
    />,
    voting: <VotingView {...altPageProps} {...shared} stewardPresence={memberStewardPresence} demo={demoActive} desktop={wideScreen && !embedPhone} onPlanAction={handlePlanAction} onMessageSteward={() => navigate("messages", "/m/messages")} onSuggestPoll={(text, scope) => handlePollSuggestion(tr(scope === "local" ? "voting.suggestDraftLocal" : "voting.suggestDraftChapter", { text }))} nominationsClient={fixtureDemo || !data.member?.organizationId ? null : sessionDataClient} onOpenCampaigns={campaignsAllowed ? () => navigateStaff("campaigns", "/m/campaigns") : null} campaignsSwitch={campaignsHat ? { label: tr(campaignsHat.labelKey), onSwitch: () => switchHat(campaignsHat.key) } : null} />,
    voice: <VoiceView {...shared} onEngagementChanged={invalidateEngagementSnapshot} demo={demo} fixtureDemo={fixtureDemo} desktop={wideScreen && !embedPhone} threads={data.guideThreads} weeklyQuestions={data.weeklyQuestions || []} onSubmitWeeklyQuestion={guideActionAfter("pulse", handleSubmitWeeklyQuestion)} onBoostWeeklyQuestion={handleBoostWeeklyQuestion} onPromoteWeeklyQuestion={handlePromoteWeeklyQuestion} onSuggest={compassOn ? (text, scope) => openCompassWithDraft(tr(scope === "local" ? "bevoice.suggestDraftLocal" : "bevoice.suggestDraftChapter", { text })) : null} onMessageSteward={() => navigate("messages", "/m/messages")} onOpenQa={() => navigate("qa", "/m/qa")} engagementClient={fixtureDemo ? null : sessionDataClient} engagementOrganizationId={data.member?.organizationId || null} onNotice={setNotice} />,
    qa: <MemberQaView lang={lang} actor={qaActor} client={fixtureDemo ? null : sessionDataClient} api={qaDemoApi} pulse={pulse} />,
    pay: <PayToolsView {...altPageProps} lang={lang} actor={payActor} client={fixtureDemo ? null : sessionDataClient} />,
    // REQ-UG-ALT-PORT-MEMBER-PAGES-20261030: the prototype's All
    // updates page exists only under the alternate shell.
    updates: altShell ? <AltUpdatesPage items={recordItems(data)} chapters={data.chapterDirectory ?? null} client={fixtureDemo ? null : sessionDataClient} memberId={data.member?.id ?? null} onOpenItem={openAltRecord} onOpenHome={() => navigate("today", "/m")} /> : undefined,
    messages: <><MessagesView {...shared} personalReminders={personalRemindersNode} visitorMessageWorkflow={visitorMessageWorkflow} stewardPresence={memberStewardPresence} announcementContext={announcementContext} alt={altShell} onOpenHome={altShell ? () => navigate("today", "/m") : null} renderConnectedActions={(kind, record) => connectedActions(kind)(record)} onMessageRedacted={handleMessageRedacted} desktop={wideScreen && !embedPhone} staffAccess={selectedStaffHatAuthorized} focus={searchFocus?.view === "messages" ? searchFocus : null} onOpenTopics={(threadId) => navigate("hub", "/m/organize", threadId ? { view: "hub", threadId } : null)} onOpenTasks={selectedStaffHatAuthorized ? () => navigateStaff("tasks", tasksBoardPath()) : null} onOpenCases={() => navigate("cases", "/m/cases")} onRequestSteward={() => navigate("appointments", "/m/appointments", { view: "appointments", request: true })} messagingApi={demoActive ? connectedDemoMessagingApi : sessionMessagingApi} peerContactApi={demoActive ? demoPeerContactApi : peerContactApi} onPeerContactChange={handlePeerContactChange} officerDirectoryApi={chapterLeadershipApi} onStartOfficerConversation={handleStartOfficerConversation} crossChapterApi={crossChapterApi} onNotice={setNotice} onSendMessage={staffGuideHat ? staffMessageSent : handleSendMemberMessage} onSendTaskMessage={handleSendTaskMessage} onStartConversation={handleStartMemberConversation} onStartStewardConversation={guideActionAfter("member-support", handleStartStewardConversation)} stewardMessageAvailable={stewardMessageAvailable} onReadConversation={guideActionAfter("messages", handleReadConversation)} onReadBroadcast={guideActionAfter("messages", handleReadBroadcast)} onCreateTaskFromSource={selectedStaffHatAuthorized ? handleCreateTaskFromSource : null} onOpenTask={selectedStaffHatAuthorized ? handleOpenSourceTask : null} engagementSession={fixtureDemo ? null : session} engagementClient={fixtureDemo ? null : sessionDataClient} noticeDesk={noticeDesk} notificationOpenIntent={notificationOpenIntent} />{(() => {
      const reminders = <details className="connected-actions connected-reminders-disclosure"><summary>{lang === "es" ? "Todos los recordatorios" : "All reminders"}</summary><ConnectedReminders api={sessionConnectedApi} scopeKey={connectedScope} onNavigate={navigateConnected} onNotice={setNotice} /></details>;
      // The alternate shell's Messages is design markup (REQ-UG-ALT-PORT-MESSAGES-20261030);
      // the production reminders under it keep the legacy adapter's look.
      return altShell ? <div className="ug-wrap ug-legacy">{reminders}</div> : reminders;
    })()}</>,
    numbers: quarterlySurveyGate(<NumbersView {...altPageProps} {...shared} onSavePreferences={handleReportPreferences} statsClient={altShell && !fixtureDemo ? sessionDataClient : null} />),
    // REQ-UG-PULSE-WEB-EXPLORER-AND-STUDIO-20261031: the website Pulse
    // explorer, beside My reports. The server applies the survey gate per card.
    pulse: <PulseView client={fixtureDemo ? null : sessionDataClient} preview={fixtureDemo} hat={activeHat} />,
    cases: <CasesView {...shared} stewardPresence={memberStewardPresence} renderAutomationLink={workflowLink("case")} caseHelp={compassCaseHelp} loadCaseDetails={demoActive ? null : loadLiveCaseDetails} desktop={wideScreen && !embedPhone} focus={searchFocus?.view === "cases" ? searchFocus : null} caseIntakeAvailable={Boolean(data.member?.chapterId)} caseworkApi={demoActive ? null : memberCaseworkApi} onNotice={setNotice} onMessages={() => navigate("messages", "/m/messages")} onCreateCase={(fields) => mutate(memberMutationResources("createMemberCase"), () => createMemberCase(sessionDataClient, fields), tr("toast.caseCreated"), null, null, null, "toast.saveFailed")} onUpdateCase={(caseId, fields) => mutate(memberMutationResources("updateMemberCase"), () => updateMemberCase(sessionDataClient, session.user.id, caseId, fields), tr("toast.caseUpdated"), null, null, null, "toast.saveFailed")} onAddCaseUpdate={(caseId, body, occurredOn) => mutate(memberMutationResources("addCaseUpdate"), () => addCaseUpdate(sessionDataClient, session.user.id, caseId, body, occurredOn), tr("toast.caseNoteSaved"), null, null, null, "toast.saveFailed")} onAddCaseFile={handleAddCaseFile} onRemoveCaseFile={handleRemoveCaseFile} onOpenCaseFile={handleOpenCaseFile} onRecheckCaseFile={handleRecheckCaseFile} />,
    rights: <RightsView {...altPageProps} {...shared} stewardPresence={memberStewardPresence} desktop={wideScreen && !embedPhone} focus={searchFocus?.view === "rights" ? searchFocus : null} onMessageSteward={() => navigate("messages", "/m/messages")} learningContent={learningContent} learningSection={learningSectionFromLocation(routeLocation, "rights")} onLearningSection={(section) => navigate("rights", learningSectionPath(section, "rights"))} stewardRequests={data.stewardRequests || []} onSaveProgress={guideActionAfter("rights", (lessonId, completedSteps) => mutateWithOutcome(memberMutationResources("saveRightsProgress"), async () => {
    return memberOperation.run(async () => {
      await memberOperation.wait(saveRightsProgress(sessionDataClient, session.user.id, lessonId, completedSteps));
      if (!memberOperation.isCurrent()) return;
      memberLoaderRef.current?.confirmRightsProgress(lessonId, completedSteps);
        });
  }, tr("toast.progressSaved"), { kind: "rightsProgress", key: lessonId, args: { userId: session.user.id, lessonId, completedSteps } }, () => setData((current) => ({ ...current, rights: { ...current.rights, lessonRecords: (current.rights?.lessonRecords || []).map((item) => item.id === lessonId ? { ...item, completedSteps } : item) } }))))} onRequestSteward={(lessonId) => mutate(memberMutationResources("requestSteward"), () => requestSteward(sessionDataClient, session.user.id, lessonId), tr("toast.stewardRequestSent"), null, () => demoStewardApi.enqueueRequest({ memberInitials: data.member.initials, memberName: data.member.fullName, lessonLabel: data.rights?.lessonRecords?.find((item) => item.id === lessonId)?.label || "" }))} />,
    // The desk's bounded states take a worn staff hat off through switchHat
    // (the rail's own Home-from-a-staff-hat path) before going back to Member,
    // and recover a two-step denial through the same sign-out the Settings
    // page uses; the desk renders Sign in again only with a real client.
    memberSupport: <MemberSupportView {...altPageProps} actor={mi1Actor} client={fixtureDemo ? null : sessionDataClient} onNavigate={navigate} onSwitchHat={switchHat} onSignOut={signOutAndForget} coachMark={coachMark} guideSwitches={data.organizationConfiguration?.switches ?? null} />,
    // REQ-UG-SITE-GUIDE-FOR-REAL-ACCOUNTS-20261001. The click handler reads
    // railNavigate when a destination is chosen, after this render finished.
    siteGuide: <SiteGuideView demoNavigation={demoNavigation} client={fixtureDemo ? null : sessionDataClient} configuration={data.organizationConfiguration ?? null} roles={realRoles} pausedRoles={fixtureDemo ? undefined : data.staffMfa?.suspendedRoles} onNavigate={(key, path, sectionId) => railNavigate(key, path, sectionId)} />,
    events: <ConnectedEventLanding data={data} selectedOnly={!explicitHatAllowsView(selectedStaffHat, "events", demo, data?.roles || [], !railShell, "/m/events")} requestedId={new URLSearchParams(window.location.search).get("event")} scopeKey={connectedScope} loadEvent={(id) => memberOperation.run(() => demoActive ? dataRef.current.events.find((row) => row.id === id) : memberOperation.wait(loadAuthorizedCalendarEvent(supabase, id, session?.user?.id, lang)))}>{(authorizedData) => <EventsView {...shared} data={authorizedData} renderAutomationLink={workflowLink("event")} renderConnectedActions={connectedActions("event")} onRsvp={guideActionAfter("events", handleRsvp)} onCheckIn={handleCheckIn} onRequestCheckinCode={handleRequestCheckinCode} checkinWindowEnforced={!demoActive} calendarFeedScope={calendarFeedScope} sessionRestricted={sessionRestricted} loadCalendarFeedStatus={loadCalendarFeedStatus} onCalendarRotate={handleCalendarRotate} onCalendarRevoke={handleCalendarRevoke} loadEventQuorum={demoActive ? null : loadEventQuorum} />}</ConnectedEventLanding>,
    appointments: <AppointmentsView {...shared} stewardPresence={memberStewardPresence} focus={searchFocus?.view === "appointments" ? searchFocus : null} renderAutomationLink={workflowLink("appointment")} api={demoActive ? demoAppointmentsApi : appointmentsApi} onBook={handleBookAppointment} onCancel={handleCancelAppointment} onReschedule={handleRescheduleAppointment} />,
    accessHistory: <AccessHistoryView lang={lang} actor={accessActor} client={fixtureDemo ? null : sessionDataClient} />,
    actions: <CollectiveActionsView {...altPageProps} lang={lang} actor={organizationIntelligenceActor} client={fixtureDemo ? null : sessionDataClient} preview={fixtureDemo} />,
    settings: <SettingsView {...altPageProps} {...shared} personalReminders={personalRemindersNode} visitorMessageWorkflow={visitorMessageWorkflow} stewardPresence={memberStewardPresence} keyboardShortcutsOffered={railShell} navPins={{ persist: !demoActive && demo !== true, offered: railShell && !altShell }} announcementContext={announcementContext} lang={lang} onLanguage={handleLanguage} siteView={shellSwitchAvailable ? { alt: altShell, onChange: (alt) => switchShell(alt ? ALT_SHELL : CLASSIC_SHELL) } : null} onNotificationPrefs={guideActionAfter("settings", handleNotificationPrefs)} onFocusSettings={handleFocusSettings} push={pushState} onPushSubscribe={handlePushSubscribe} onPushRefresh={() => handlePushSubscribe(true)} onPushUnsubscribe={handlePushUnsubscribe} calendarFeedScope={calendarFeedScope} loadCalendarFeedStatus={loadCalendarFeedStatus} onCalendarRotate={handleCalendarRotate} onCalendarRevoke={handleCalendarRevoke} authClient={fixtureDemo ? null : sessionAccountClient} sessionRestricted={sessionRestricted} onMfaChanged={handleMfaStandingChanged} onNavigate={navigate} canNavigateView={(nextView, path) => explicitHatAllowsView(selectedStaffHat, nextView, demo, data?.roles || [], !railShell, path)} memberHatOpensHeldPlanes={!demo && selectedStaffHat === "member" && Boolean(data) && !data.rolesUnknown} onSignOut={fixtureDemo ? null : () => signOutOnce("local", true)} signingOut={signingOut} onLoadSessions={fixtureDemo || sharedPersonaSession ? null : loadSessions} onRevokeSession={fixtureDemo || sharedPersonaSession ? null : revokeSession} onSignOutEverywhere={fixtureDemo || sharedPersonaSession ? null : () => signOutAndForget("global", true)} sessionDemo={fixtureDemo} sharedAccount={sharedPersonaSession} stewardContactApi={stewardContactApi} chapterLeadershipApi={chapterLeadershipApi} adminHatWorn={selectedStaffHat === "admin"} seniorityApi={seniorityApi} onMessageOfficer={handleMessageOfficer} profileDetailsApi={profileDetailsApi} formAutofillApi={demoActive ? null : formAutofillApi} learningContent={learningContent} learningSection={learningSectionFromLocation(routeLocation, "settings")} onLearningSection={(section) => navigate("settings", learningSectionPath(section, "settings"))} requestsPanel={requestsPanel} unitSettingsApi={fixtureDemo ? null : unitSettingsApi} />,
    workload: <WorkloadView unitSettingsApi={fixtureDemo ? null : unitSettingsApi} {...shared} onLogWork={handleLogWork} onSaveReminder={handleSaveWorkloadReminder} personalReminders={personalRemindersNode} statsGate={quarterlySurveyGate} />,
    forms: <FormsView
      unitSettingsApi={fixtureDemo ? null : unitSettingsApi}
      chapterAvailable={Boolean(data.member?.chapterId)}
      onFormFilingStatus={fixtureDemo ? null : (formId) => getFormFilingStatus(supabase, formId)}
      {...shared}
      dues={duesNav}
      draftSharingApi={fixtureDemo ? null : chapterAccessApi}
      demo={demoActive}
      desktop={wideScreen && !embedPhone}
      focus={searchFocus?.view === "forms" ? searchFocus : null}
      onSaveDraft={handleSaveDraft}
      onSubmit={handleSubmitForm}
      onDiscardDraft={handleDiscardFormDraft}
      onCheckDraft={fixtureDemo ? null : (formId, memberId) => memberFormStillExists(supabase, formId, memberId)}
      onInviteCosigner={handleInviteCosigner}
      onRespondCosign={handleRespondCosign}
      onWithdrawCosign={handleWithdrawCosign}
      onSignForm={handleSignForm}
      onAddFormFile={handleAddFormFile}
      onOpenFormFile={handleOpenFormFile}
      onRecheckFormFile={handleRecheckFormFile}
      onRemoveFormFile={handleRemoveFormFile}
      onDownloadForm={handleDownloadForm}
      canShareForm={canShareFormFiling}
      onShareForm={shareFormFiling}
      organizationFormsApi={demoActive ? null : organizationFormDocumentsApi}
      formAutofillApi={demoActive ? null : formAutofillApi}
    />,
    rewards: <RewardsView {...shared} stewardPresence={memberStewardPresence} freeCosmetics={freeCosmetics} />,
    search: <SearchView
      {...shared}
      memberRequestsAvailable={Boolean(requestsPanel) && !sessionRestricted}
      dues={duesNav}
      knowledgeClient={fixtureDemo || !data.member?.organizationId ? null : sessionDataClient}
      caseSearchClient={caseSearchClient}
      chapterLeadershipClient={caseSearchClient}
      onOpenResult={openSearchResult}
      onAskCompass={compassOn ? openCompassWithDraft : null}
    />,
    hub: <ProductHubView
      {...altPageProps}
      notificationOpenIntent={notificationOpenIntent}
      chapterSwitch={demo ? null : <ChapterMembershipSwitch chapters={chapterRailChapters} selectedId={chapterRailSelectedId} onSelect={(chapter) => selectMemberChapterRef.current(chapter)} busy={chapterSwitching} />}
      renderConnectedActions={(kind, record) => connectedActions(kind)(record)}
      {...shared}
      pulse={pulse}
      connectionActor={organizationIntelligenceActor}
      onSelectOfficeRole={(role) => {
        if (!canSelectChapterOfficeRole(data.roles, data.rolesUnknown, role)) return;
        selectedStaffHatRef.current = role;
        setSelectedStaffHat(role);
        navigate("hub", "/m/organize/record", null, { guarded: true });
      }}
      connectionClient={fixtureDemo ? null : sessionDataClient}
      connectionPreview={fixtureDemo}
      staffAccess={selectedStaffHatAuthorized && STAFF_TOOL_ROLES.includes(selectedStaffHat)}
      triageAccess={selectedStaffHatAuthorized && ["steward", "coordinator"].includes(selectedStaffHat)}
      knowledgeClient={fixtureDemo || !data.member?.organizationId ? null : sessionDataClient}
      knowledgeStaffAccess={knowledgeStaffAccess}
      knowledgeAdminAccess={knowledgeStaffAccess && ["admin", "vp"].includes(selectedStaffHat)}
      knowledgeHealthAccess={knowledgeStaffAccess && ["advisor", "admin", "vp"].includes(selectedStaffHat)}
      onKnowledgeChanged={() => refresh(session, memberMutationResources("saveChapterKnowledgeArticle"))}
      institutionalClient={fixtureDemo || !data.member?.organizationId ? null : sessionDataClient}
      leadershipApi={fixtureDemo || !data.member?.organizationId ? null : leadershipApi}
      onOpenSettings={() => navigate("settings", "/m/settings")}
      preview={demoActive}
      focus={searchFocus?.view === "hub" ? searchFocus : null}
      onCreateSpace={handleCreateSpace}
      onCreateThread={handleCreateThread}
      onReadSpace={async (spaceId) => { if (!fixtureDemo) { await markChapterSpaceRead(sessionDataClient, spaceId); await refresh(); } }}
      onSendPost={handleSendThreadPost}
      onCreateIntake={handleCreateIntake}
      onTriageIntake={handleTriageIntake}
      onConvertIntake={handleConvertIntake}
      onCreateDocument={handleCreateDocument}
      onSaveKnowledge={handleSaveKnowledge}
      onRetireKnowledge={handleRetireKnowledge}
      onCreateRecord={handleCreateRecord}
      onUpdateSpace={handleUpdateSpace}
      onUpdateDocument={handleUpdateDocument}
      onUpdateRecord={handleUpdateRecord}
      onCreateHandshake={handleCreateHandshake}
      onUpdateHandshake={handleUpdateHandshake}
      onCreateGovernance={handleCreateGovernance}
      onRetryGovernance={() => refresh(sessionRef.current, ["table:chapter_governance_requests"])}
      onGenerateDataExport={handleGenerateDataExport}
      onDeleteAccount={handleDeleteAccount}
      deletionPasswordReauth={!hasVerifiedSecondFactor(session?.user)}
      onDeleteIndeterminateClose={() => signOutAndForget("local", true)}
      onCreateTask={handleCreateTask}
      onListSpaceMembers={handleListSpaceMembers}
      onSearchSpaceMembers={handleSearchSpaceMembers}
      onSetSpaceMember={handleSetSpaceMember}
      messagingApi={demoActive ? connectedDemoMessagingApi : sessionMessagingApi}
      channelControlsClient={fixtureDemo || demoActive || !data.member?.organizationId ? null : sessionDataClient}
      onNotice={setNotice}
    />,
    coordination: <OrganizationCoordinationView actor={coordinationActor} client={fixtureDemo ? null : sessionDataClient} />,
  };
  // The chapter-work staff TOOL (not a plane: no hat, no role of its own).
  // Rendered only when the route gate would admit it, so `views[view] ??
  // views.today` and onStaffHat both read the same answer the redirect
  // enforces. A Member hat never mounts the view, even when the account owns
  // staff roles and before the redirect effect lands.
  if (selectedStaffHatAuthorized) {
    views.automations = <AutomationControlRoomView session={mi1Actor} accessToken={session?.access_token || null} client={fixtureDemo ? null : sessionDataClient} onNotice={setNotice} />;
    const requestedTaskId = new URLSearchParams(window.location.search).get("task");
    const linkedTaskId = requestedTaskId && (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(requestedTaskId) || (demoActive && data.tasks?.some((task) => task.id === requestedTaskId))) ? requestedTaskId : null;
    views.tasks = <ConnectedTaskLanding data={data} requestedId={linkedTaskId} scopeKey={connectedScope} loadTask={(id) => memberOperation.run(async () => {
      if (!explicitHatAllowsView(selectedStaffHatRef.current, "tasks", demo, dataRef.current?.roles || [], !railShell, "/m/tasks")) throw new Error("Task unavailable");
      const task = demoActive ? dataRef.current?.tasks?.find((row) => row.id === id) : await memberOperation.wait(loadAuthorizedChapterTask(supabase, id));
      if (!task || task.chapterId !== dataRef.current?.member?.chapterId) throw new Error("Task unavailable");
      return task;
    })}>{(linkedData) => <TasksView
      unitSettingsApi={fixtureDemo ? null : unitSettingsApi}
      onFocusSearch={altShell ? focusWorkFind : null}
      {...shared}
      data={linkedData}
      renderAutomationLink={workflowLink("task")}
      renderConnectedActions={connectedActions("task")}
      renderConnectedMessageActions={connectedActions("task_message")}
      onOpenSourceRecord={async (attachment) => {
        try {
          const kind = { message: "private_message", channel_post: "channel_post", event: "event" }[attachment.sourceKind];
          if (kind) {
            const current = await sessionConnectedApi.context({ kind, id: attachment.sourceId });
            if (!current.available) throw new Error("Source unavailable");
            await navigateConnected(current.href);
          } else await navigateConnected(attachment.recordUrl);
        } catch { setNotice(lang === "es" ? "El elemento original ya no está disponible." : "The original item is no longer available."); }
      }}
      desktopShell={desktopShell}
      demo={fixtureDemo}
      staffAccess
      fieldNotesPacket={fieldNotesPacket}
      onCreateTask={handleCreateTask}
      onCreateTaskFromTemplate={handleCreateTaskFromTemplate}
      onConvertTaskToTemplate={demoActive ? null : handleConvertTaskToTemplate}
      onUpdateTaskTemplateDetails={handleUpdateTaskTemplateDetails}
      checkoffClient={fixtureDemo ? null : sessionDataClient}
      onUpdateTask={handleUpdateTask}
      onSetTaskAssignees={handleSetTaskAssignees}
      onMoveTask={handleMoveTask}
      onDeleteTask={handleDeleteTask}
      onSendTaskMessage={handleSendTaskMessage}
      onAddTaskComment={handleAddTaskComment}
      onAddTaskAttachment={handleAddTaskAttachment}
      onAddTaskFile={handleAddTaskFile}
      onRemoveTaskFile={handleRemoveTaskFile}
      onOpenTaskFile={handleOpenTaskFile}
      onRecheckTaskFile={handleRecheckTaskFile}
      onRemoveTaskAttachment={handleRemoveTaskAttachment}
      onAddTaskDependency={handleAddTaskDependency}
      onRemoveTaskDependency={handleRemoveTaskDependency}
      onCreateTaskSubtask={handleCreateTaskSubtask}
      onRemoveTaskSubtask={handleRemoveTaskSubtask}
      onWatchTask={handleWatchTask}
      onUnwatchTask={handleUnwatchTask}
      onLoadReport={handleLoadTaskReport}
      onAddWorkstream={handleAddWorkstream}
      onEnsureDefaultWorkstream={handleEnsureDefaultWorkstream}
      onRenameWorkstream={handleRenameWorkstream}
      onPreviewMergeWorkstreams={handlePreviewMergeWorkstreams}
      onMergeWorkstreams={handleMergeWorkstreams}
    />}</ConnectedTaskLanding>;
    // UB-EVT-06: the events desk rides the SAME gate as the tasks tool, so all
    // five staff hats reach the authoring surface that used to live only
    // inside the admin plane.
    views.eventsDesk = <EventsDeskView
      scope={`${data.member?.id ?? ""}:${data.member?.organizationId ?? ""}:${data.member?.chapterId ?? ""}`}
      chapterTransition={chapterTransition?.operation.isCurrent() ? chapterTransition.status : null}
      onRetryChapter={() => { void refreshChapterScope().catch(() => {}); }}
      renderConnectedActions={connectedActions("event")}
      api={fixtureDemo ? demoAdminApi : eventsDeskApi}
      onNotice={setNotice}
      chapterName={data.member?.chapterName || ""}
    />;
    views.campaigns = <CampaignsView
      onEngagementChanged={invalidateEngagementSnapshot}
      {...shared}
      demo={fixtureDemo}
      sampleStudio={fixtureDemo}
      api={fixtureDemo ? demoCampaignApi : campaignApi}
      engagementClient={fixtureDemo ? null : sessionDataClient}
      engagementSession={session}
      onAppNotice={setNotice}
    />;
    views.analytics = organizationWorkspace("analytics", "nav.analytics", () => quarterlySurveyGate(<AnalyticsCoreView viewer={mi1AnalyticsActor} client={fixtureDemo ? null : sessionDataClient} preview={fixtureDemo} session={fixtureDemo ? null : session} onOpenPulse={() => navigate("pulse", "/m/pulse")} />));
    views.organizationMap = organizationWorkspace("organizationMap", "nav.organizationMap", () => <OrganizationIntelligenceView lang={lang} actor={organizationIntelligenceActor} client={fixtureDemo ? null : sessionDataClient} preview={fixtureDemo} organizationConfiguration={data?.organizationConfiguration ?? null} />);
    views.qaQueue = <OfficerQaView lang={lang} actor={qaActor} client={fixtureDemo ? null : sessionDataClient} api={qaDemoApi} />;
    if (activeHat === "admin" || activeHat === "vp") {
      views.integrations = organizationWorkspace("integrations", "nav.integrations", () => <IntegrationsView actor={mi1Actor} client={fixtureDemo ? null : sessionDataClient} />);
    }
  }
  // Staff planes manage their own data/refresh cycles. Each is available to
  // real accounts holding its role and, on seeded demo data, to any demo
  // visitor via the hat switcher.
  // The coordinator and steward planes — the two that run chapter work — are
  // the way IN to the tasks tool now that the tab bar is not one, so the
  // entrance is a first-class row on each, never an overflow item.
  const openTasksTool = () => navigateStaff("tasks", tasksBoardPath());
  if ((realSteward || demo) && selectedStaffHat === "steward") {
    views.steward = withPlaneGuides(<>{!fixtureDemo && chapterAccessApi && <StewardSharedAccessPanel key={`shared:${data.member?.id}:${data.member?.organizationId}:${data.member?.chapterId}`} api={chapterAccessApi} />}<StewardView seniorityApi={seniorityApi} issueSignals={issueSignals} renderConnectedActions={(kind, record) => connectedActions(kind)(record)} {...shared} accessActor={accessActor} onNotice={setNotice} api={fixtureDemo ? demoStewardApi : stewardGuideApi} onOpenTasks={openTasksTool} onCreateTaskFromSource={handleCreateTaskFromSource} onOpenTask={handleOpenSourceTask} canCreateMessageEvent={fixtureDemo || (data.roles || []).includes("admin")} learningContent={learningContent} officerQa={<OfficerQaView lang={lang} actor={qaActor} client={fixtureDemo ? null : sessionDataClient} api={qaDemoApi} embedded onOpenQuestion={() => navigateStaff("qaQueue", "/m/qa-queue")} />} caseSignals={caseSignals} /></>);
  }
  if ((demo || realRoles.includes("coordinator")) && selectedStaffHat === "coordinator") {
    views.coordinator = withPlaneGuides(<><CoordinatorView seniorityApi={seniorityApi} {...shared} caseSignals={caseSignals} accessActor={accessActor} onNotice={setNotice} api={fixtureDemo ? demoCoordinatorApi : coordinatorGuideApi} onOpenTasks={openTasksTool} onCreateTaskFromSource={handleCreateTaskFromSource} onOpenTask={handleOpenSourceTask} /></>);
  }
  if ((demo || realRoles.includes("vp")) && selectedStaffHat === "vp") {
    views.vp = withPlaneGuides(<><VpView
      {...shared}
      api={fixtureDemo ? demoVpApi : vpGuideApi}
      invitationApi={presidentInvitationApi}
      directoryClient={fixtureDemo ? null : sessionDataClient}
    /></>);
  }
  if ((demo || realRoles.includes("advisor")) && selectedStaffHat === "advisor") {
    views.advisor = withPlaneGuides(<><AdvisorView {...shared} onNotice={setNotice} api={fixtureDemo ? demoAdvisorApi : advisorDeskApi} /></>);
  }
  if ((demo || realRoles.includes("admin")) && selectedStaffHat === "admin") {
    views.admin = withPlaneGuides(<><AdminView
      renderConnectedEventActions={connectedActions("event")}
      setupCompletionGuard={setupCompletionScope.guard}
      {...shared}
      demo={fixtureDemo}
      sampleLive={sampleLive}
      railChapter={desktopShell ? chapterRailChapters.find((chapter) => chapter.id === chapterRailSelectedId) ?? null : null}
      onNotice={setNotice}
      api={fixtureDemo ? demoAdminApi : adminGuideApi}
      chapterTransition={chapterTransition?.operation.isCurrent() ? chapterTransition.status : null}
      onRetryChapter={() => { void refreshChapterScope().catch(() => {}); }}
      memberOperationsActor={mi1Actor}
      memberOperationsClient={fixtureDemo ? null : sessionDataClient}
      memberOperationsSession={fixtureDemo ? null : session}
      operationsHealth={<OperationsHealthView session={mi1Actor} client={fixtureDemo ? null : sessionDataClient} embedded />}
      issueSignals={issueSignals}
    /></>);
  }
  // The worn hat's feature guide card, at the top of the page it belongs to
  // (staffFeatureGuides shows a card only on that page).
  // The page is held apart so it still renders only through WorkspacePages.
  const staffGuidePage = staffGuides?.showing ? views[view] : null;
  if (staffGuidePage) {
    const staffGuideCard = <StaffFeatureGuide key={staffGuides.showing.stepId} guides={staffGuides} onPrimary={staffGuidePrimary} onOpenPart={openGuidePage} onGotIt={closeStaffGuide} onSeen={(stepId) => { void staffGuideState.mark(stepId, "seen"); }} />;
    views[view] = deskWithGuides(staffGuidePage, staffGuideCard, sharedPersonaSession);
  }
  // Union Ground's Organize plane: the organizing lifecycle (committee,
  // cards, election or voluntary recognition, first contract). Organizers and
  // the staff roles that supervise them open it; the demo opens it for every hat.
  if (demo || realRoles.some((role) => ORGANIZE_ROLES.has(role))) {
    views.organize = <OrganizeView {...shared} api={fixtureDemo ? demoOrganizeApi : organizeApi} />;
  }
  // Every role dashboard is a staff hat, including Steward. The old special
  // case treated a real steward as a member here, which silently swapped the
  // role's work navigation for the member tab set on phones.
  const onStaffHat = selectedStaffHatAuthorized && STAFF_VIEWS.includes(view) && (demo || Boolean(views[view]));

  // Chapter work is shared by all five roles. While it is open, keep the
  // current authorized hat's identity instead of coercing every account to
  // Coordinator (which erased the hat entirely for Steward/Advisor/Admin/VP).
  const staffPlaneKey = STAFF_TOOL_VIEWS.includes(view) ? activeHat : view;
  const staffPlane = STAFF_PLANES.find((plane) => plane.key === staffPlaneKey) ?? null;
  const sharedStaffViewLabel = selectedStaffHatAuthorized && view === "messages" ? tr("nav.inbox") : null;
  const officeHatLabel = selectedChapterOfficeRole(data.roles, activeHat) ? tr(`access.role.${activeHat}`) : null;
  const planeWide = onStaffHat && (STAFF_PLANES.some((plane) => plane.view === view) || view === "campaigns" || view === "coordination" || view === "analytics" || view === "organizationMap" || view === "integrations");

  // Which shell wraps the experience. Desktop and tablet both keep one rail
  // for every hat, while tablet retains touch-first view density and its own
  // 220px geometry. Phones keep the bare card experience and staff phone
  // chrome; an embedded companion instance always renders that phone shell.
  // Switch hat is SAMPLE-only. The empty SaaS origin never mounts a hat
  // picker — not the all-hats tour switcher, and not Member plus authorized
  // staff hats after sign-in. Backed work destinations still render inside
  // DesktopRail for the currently selected hat.
  // Role-Derived Desk Entrance: On the SaaS origin
  // a staff account gets each role's desk entry in navigation automatically,
  // derived from data.roles. No hat switcher is mounted (the switcher stays
  // SAMPLE-only); the entries are plain destinations the rail and the phone
  // home chrome render, and entering one wears that role's hat. A degraded
  // roles read derives nothing: unknown is not role-less.
  // Persona sessions see every plane through the demo chrome; an organization
  // account on SAMPLE gets exactly the desks its own roles hold, as on SaaS.
  const roleDeskPlanes = personaRouting || !data || data.rolesUnknown
    ? []
    : STAFF_PLANES.filter((plane) => holdsHat(data.roles || [], plane.key));
  const railStaffPlanes = personaRouting ? STAFF_PLANES : roleDeskPlanes;
  const mobileHatOptions = demo
    ? [
        { key: "member", label: tr("demo.hatMember") },
        ...railStaffPlanes.map((plane) => ({ key: plane.key, label: tr(plane.labelKey) })),
      ]
    : [];
  // Rail navigation is route-aware: staff planes go through navigateStaff so
  // the demo query and the staff view transition ride along (the same call
  // the demo-bar select makes); member rows use the member path.
  // The rider joins with "&" when the path already carries a query (such as
  // an explicit ?shell= choice), so both flags stay parseable.
  const staffDestinationPath = (path) => (demo ? withDemoRider(path) : path);
  // The optional focus rider is the widget rows' deep-link (owner Rev 5,
  // 2026-08-08): the same payload shape the search results hand navigate(),
  // so a Messages row lands on its thread, a Cases row on its case, a Forms
  // row on its form. Staff-desk destinations ignore it.
  const railNavigate = (key, path, sectionId = "", focus = null) => {
    // Organization accounts on SAMPLE get the role-derived desk entrances too
    // (BUG-UG-DEMO-HOST-SIGNED-OUT-DEAD-END-20261106), so they wear a
    // desk's hat the same way; persona sessions keep the persona chrome.
    if (!personaRouting) {
      // A role-derived desk entry is worn, not merely visited: the plane
      // gate is roles.includes(hat), so the hat changes with the route.
      // Home from a worn staff hat returns to Member the same way.
      const desk = roleDeskPlanes.find((plane) => plane.view === key);
      // A link to one page of another desk (a Site guide entry, a search
      // result) opens that page once the desk is worn, not the desk overview
      // (UX-UG-STAFF-LINKS-FROM-WRONG-DESK-LAND-ON-HOME-OR-OVERVIEW-20261111).
      if (desk && selectedStaffHat !== desk.key) {
        // A click on the desk itself (the desktop rail's desk row) keeps a
        // refused address that desk opens; only a deeper link replaces it.
        if (path && path !== desk.path) pendingDeskRouteRef.current = { hat: desk.key, view: key, href: staffDestinationPath(path), at: Date.now() };
        return switchHat(desk.key);
      }
      if (key === "today" && selectedStaffHat !== "member") return switchHat("member");
      // A member page the worn staff hat cannot open (the membership card from
      // the Site guide) opens under Member, which can, rather than bouncing to
      // the staff desk.
      if (selectedStaffHat !== "member" && path && !STAFF_VIEWS.includes(key)
        && !explicitHatAllowsView(selectedStaffHat, key, fixtureDemo, data?.roles || [], !railShell, path)
        && explicitHatAllowsView("member", key, fixtureDemo, data?.roles || [], !railShell, path)) {
        pendingDeskRouteRef.current = { hat: "member", view: key, href: demo ? withDemoRider(path) : path, at: Date.now() };
        return switchHat("member");
      }
    }
    return STAFF_VIEWS.includes(key)
      ? navigateStaff(key, staffDestinationPath(path, sectionId))
      : navigate(key, path, focus);
  };

  // The Work card follows the hat the wearer last chose, not the route: the
  // home space is always a member route, so the route-derived activeHat would
  // pin the card to Member forever. Here "member" means member — hat
  // isolation (owner rule, 2026-08-05) keeps every staff desk behind its own
  // hat, so a steward who takes the Steward hat off sees member work
  // surfaces until they put it back on through the switcher or a plane.
  const workHatKey = selectedStaffHat !== "member" && (demo || holdsHat(realRoles, selectedStaffHat))
    ? selectedStaffHat
    : null;
  const workPlane = STAFF_PLANES.find((plane) => plane.key === workHatKey) ?? null;
  const workItems = withoutDuesNav(visibleStaffNavigation(workHatKey ? STAFF_ROLE_NAVIGATION[workHatKey] ?? MEMBER_WORK_ITEMS : MEMBER_WORK_ITEMS, demoNavigation), runsDues);
  // Unknown or role-gated-away views fall back to the home space, cards
  // included — the same answer `views[view] ?? views.today` used to give.
  const selectedFallbackView = selectedStaffHatAuthorized && views[selectedStaffHat]
    ? selectedStaffHat
    : "today";
  // UB-UG-UNKNOWN-APP-ADDRESS-LEAVES-SHELL-20261106: an unknown /m
  // address keeps the shell and shows its own not-found page, whose way back
  // is the home space above (the worn plane, else Home).
  const unknownAppAddress = !view && unknownAppPath(window.location.pathname);
  if (unknownAppAddress) {
    const homePath = STAFF_PLANES.find((plane) => plane.key === selectedFallbackView)?.path ?? "/m";
    views.notFound = <AppNotFound homeLabel={tr(hatRouteRefusedDestinationKey(homePath))} onHome={() => navigate(selectedFallbackView, homePath)} />;
  }
  const resolvedView = unknownAppAddress ? "notFound" : views[view] && selectedHatAllowsView ? view : selectedFallbackView;
  // The alternate shell keeps the phone Home rule: under a worn staff hat,
  // Home shows the selected plane (the classic card layer renders it in its
  // center card), never Member Now with destinations the hat refuses.
  const altView = altShell && resolvedView === "today" && selectedStaffHatAuthorized && views[selectedStaffHat] ? selectedStaffHat : resolvedView;
  // REQ-UG-ALT-PORT-MEMBER-PAGES-20261030: member pages under the
  // alternate shell open with the prototype's page hero.
  const altPageTitle = altShell && activeHat === "member" && !["today", "messages", "tasks", "updates"].includes(altView) && !ALT_BODY_VIEWS.has(altView) ? memberPageTitle(tr, altView) : null;
  // The full-screen hat-switch wait and the in-shell page wait say the same
  // "Opening the … view" until the switched hat's page has loaded.
  const routeOpeningHat = sampleHatOpening ? DEMO_HATS.find((hat) => hat.key === sampleHatOpening) : null;
  const routeOpeningLabel = routeOpeningHat ? tr("demo.hatOpening", { hat: tr(routeOpeningHat.labelKey) }) : tr("app.loading");
  const routeLoad = demoActive
    ? { status: "loaded", error: "" }
    : memberLoaderRef.current?.stateForRoute(view) ?? { status: "loading", error: "" };
  // Settings, Most used places holds only NavUsageSettingsCard, which renders
  // nothing without a member or with the organization's ranking switched off.
  // Requests has no page where its panel is not drawn (the fixture demo,
  // SAMPLE, a restricted session), so neither Settings nor Search offers it.
  const requestsAvailable = Boolean(requestsPanel) && !sessionRestricted;
  const settingsHiddenPages = [
    ...(!data?.member?.id || !navUsageEnabled(data?.organizationConfiguration) ? SETTINGS_APPEARANCE_HIDDEN : []),
    ...(requestsAvailable ? [] : SETTINGS_REQUESTS_HIDDEN),
  ];
  const paletteIndex = buildSearchIndex(paletteStructure && paletteStructure.memberId === data.member?.id
    ? { ...data, memberOrgStructure: paletteStructure.structure }
    : data, tr, { memberRequests: requestsAvailable, dues: duesNav });
  const paletteStaffItems = withoutDuesNav(visibleStaffNavigation(activeHat === "member" ? [] : STAFF_ROLE_NAVIGATION[activeHat] ?? [], demoNavigation), runsDues);
  // Staff tab pages by name, each under the rule its own page applies to the
  // worn hat (UX-UG-STAFF-PAGES-WITH-NO-MENU-OR-SEARCH-ENTRY-20261111).
  const paletteTabItems = staffTabPagesFor(paletteStaffItems, {
    // The Pay page decides on organization grants only (its scoped actor),
    // so a chapter-only leader is not offered a tab it would refuse.
    "pay-bargaining": canLead({ ...payActor, organizationRoles: data.member?.organizationRoles || [] }),
    "support-handoffs": canManageMemberSupport(mi1Actor),
    "coordination-mobilize": canManageCoordination(coordinationActor),
  });
  // No membership card entry: the worker card needs a union that exists.
  const paletteShellItems = activeHat === "member" ? SHORTCUT_CATALOG.filter((item) => compassOn || item.action !== "assistant") : [];
  const paletteCommands = [
    ...paletteShellItems.map((item) => ({
      id: `page:${item.key}`,
      label: tr(item.labelKey),
      iconName: railIconName(item.key),
      keywords: [item.key],
      onSelect: item.action === "assistant"
        ? () => setAssistantOpen(true)
        : () => railNavigate(item.key, item.path),
    })),
    ...paletteStaffItems.map((item) => ({
      id: `staff:${activeHat}:${item.key}:${item.sectionId ?? "root"}`,
      label: tr(item.labelKey),
      iconName: railIconName(item.key),
      keywords: [activeHat, item.key],
      onSelect: () => railNavigate(item.viewKey ?? item.key, item.path, item.sectionId ?? ""),
    })),
    ...paletteTabItems.map((item) => ({
      id: `staff-tab:${activeHat}:${item.key}`,
      label: tr(item.labelKey),
      iconName: railIconName(item.key),
      keywords: [activeHat, ...item.keywords],
      onSelect: () => railNavigate(item.viewKey, item.path),
    })),
    // Old attention-first command palette shortcuts (cmdk-resolver.ts:37-72),
    // shown only with the organization's attention navigation switch on and
    // the member's own Keyboard shortcuts choice on.
    ...(keyboardShortcutsOn && attentionShortcutsEnabled(data?.organizationConfiguration, activeHat) ? ATTENTION_SHORTCUTS.map((item) => ({
      id: `attention:${item.id}`,
      label: tr(item.labelKey),
      iconName: railIconName(`attention:${item.id}`),
      keywords: item.keywords,
      onSelect: () => railNavigate("steward", "/m/steward"),
    })) : []),
  ].filter((item, index, all) => all.findIndex((candidate) => candidate.label === item.label) === index);
  // Server-ranked case rows, in the same command shape the local results use.
  // A staff hat does not advertise the Member cases route, exactly as the
  // local filter below decides, and a failure here is the palette's to
  // swallow: the local commands and the offline index remain correct.
  const resolvePaletteCaseResults = async (query, { signal } = {}) => {
    const entries = await searchMemberCases(caseSearchClient, query, {
      signal,
      limit: CASE_SEARCH_MAX_LIMIT,
      formatDeadline: (value) => deadlineLabel(value, lang),
      t: tr,
    });
    return memberOpenableCaseEntries(entries, data.cases).slice(0, 5).map((item) => ({
      id: `result:${item.id}`,
      label: item.title,
      keywords: [item.snippet, item.meta],
      onSelect: () => openSearchResult(item.focus),
    }));
  };
  const resolvePaletteSearchResults = (query) => searchEntries(paletteIndex, query, { limitPerType: 2 })
    .flatMap((group) => group.items)
    .filter((item) => item.focus?.view || item.focus?.staffView || item.focus?.planId || item.focus?.notifications || item.focus?.assistant)
    // Search results are member functions. A staff hat keeps its backed desk
    // commands, staff tool results and the shared Notifications action, but
    // does not advertise Member routes, ballots, or Compass only to bounce
    // them at the guard.
    .filter((item) => !selectedStaffHatAuthorized || item.focus?.notifications || item.focus?.staffView)
    .slice(0, 10)
    .map((item) => ({
      id: `result:${item.id}`,
      label: item.title,
      keywords: [item.snippet, item.meta],
      onSelect: () => openSearchResult(item.focus),
    }));

  const noticeToast = {
    notice,
    noticeId,
    action: noticeAction,
    onDismiss: () => setNotice(""),
    onAction: () => {
      const { run, focusTarget } = noticeAction;
      const actionStartedAt = globalThis.performance?.now?.() ?? Date.now();
      setNotice("");
      Promise.resolve(run()).then(() => memberOperation.isCurrent() && focusWhenAvailable(focusTarget, undefined, {
        allowActive: (active) => (
          (globalThis.performance?.now?.() ?? Date.now()) - actionStartedAt <= 350
          && active === document.querySelector(".kan-board button.kan-newtask")
        ),
      }));
    },
  };

  // SAMPLE hats are distinct fictional people. Keep the persistent rail
  // identity aligned with the welcome dialog and the explicitly worn hat;
  // member data inside the backed screens remains untouched. The phone top
  // bar's avatar reads the same identity, so a demo Steward is Sam Okafor at
  // every width (BUG-UG-PHONE-AVATAR-WRONG-PERSONA-20261106). A
  // signed-in SAMPLE organization account is its own person, so the rail and
  // the avatar name that account, never a seeded persona
  // (BUG-UG-DEMO-HOST-SIGNED-OUT-DEAD-END-20261106).
  const personaDemoChrome = personaRouting;
  // A demo role switch lands focus on main, so main names the role shown.
  const shownDemoHat = personaRouting && !embedPhone ? DEMO_HATS.find((hat) => hat.key === activeHat) : null;
  const mainWorkspaceLabel = shownDemoHat
    ? `${tr("app.mainWorkspaceLabel")}: ${tr(shownDemoHat.labelKey)}`
    : tr(embedPhone ? "app.mainCompanionLabel" : "app.mainWorkspaceLabel");
  const railPersona = personaDemoChrome
    ? (samplePersonaForHat(selectedStaffHat) ?? defaultSamplePersona() ?? data.member)
    : data.member;
  const railInitials = railPersona?.initials ?? (railPersona?.fullName ? railPersona.fullName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() : null);

  // Everything the member sees, independent of which shell wraps it —
  // extracted so the phone-framed branch wraps ONE tree instead of
  // duplicating it. The overlays live inside on purpose: with the frame as
  // their fixed-position containing block, dialogs open inside the phone.
  const shellBody = (
    <LearningPeriodProvider value={learningPeriod} onNotice={setNotice}>
      {!fixtureDemo && (offline || pendingSync > 0) && (
        <div className="offline-banner" role="status">
          <span>{offline ? tr("offline.banner") : tr("offline.pendingBanner")}</span>
          {pendingSync > 0 && <b>{tr("offline.pending", { count: pendingSync })}</b>}
        </div>
      )}
      {/* Rail-shell demo chrome (UB-DEMO-02/03/UB-NAV-04): render-gated rather
          than CSS-hidden. Tablet keeps the compact banner and Guide entrance;
          its hat switcher already lives in the rail. Phones use the chip. */}
      {/* The demo bar, its Guide (persona rows and the guided tour) and the
          phone chip belong to the retired shared demo; a signed-in SAMPLE
          organization account never sees them
          (BUG-UG-DEMO-HOST-SIGNED-OUT-DEAD-END-20261106). */}
      {personaDemoChrome && railShell && (
        <div className={`demo-bar${tabletShell ? " demo-bar--tablet" : ""}`} role="status">
          <span>
            {tr(fixtureDemo ? "demo.previewBanner" : "demo.banner")}
            {/* BUG-UG-DEMO-STAFF-SWITCH-STUCK-WITH-COLD-LINK-NOTICE-20261108:
                only while the visitor really wears the Steward fallback. A
                reload at a staff URL (including the automatic one after a
                deploy) restores that role's persona, which is not a fallback. */}
            {staffDeepLinkFallback && selectedStaffHat === DEFAULT_SAMPLE_HAT ? ` ${tr("demo.staffLinkFallback")}` : ""}
          </span>
          {/* SAMPLE desktop owns one explicit top-rail hat selector. Staff
              TOOLS (the Tasks desk) are views without a hat of their own, so
              represent that desk through its explicitly selected hat. */}
          {/* The persona/preview guide lives in the demo chrome now — the
              prototype's own demo panel is where its tour + persona rows sit,
              and Wave 2a's Home no longer carries the old grid-More entry. */}
          <button type="button" className="demo-bar__guide" onClick={() => { captureDemoAction("open_guide", view); setGuideOpen(true); }}>{tr("demo.guide")}</button>
          {!tabletShell && personaRouting && (
            <DemoHatSelector
              options={DEMO_HATS}
              active={DEMO_HATS.some((hat) => hat.key === activeHat) ? activeHat : DEFAULT_SAMPLE_HAT}
              onChange={switchHat}
              introduce={desktopShell && !demoWelcomeExit.shown}
              introReady={routeLoad.status === "loaded" && !rolesPendingForView}
              pageKey={routeLocation}
            />
          )}
          {/* Union Ground's fixture tour runs on the product's own
              deployment, so the rail shell keeps a way back out to the public
              front door (tests/desktop-shell.test.jsx). */}
          {fixtureDemo && <button type="button" className="demo-exit" onClick={() => window.location.assign("/")}>{tr("demo.exit")}</button>}
        </div>
      )}
      {/* The phone's demo chrome (UB-DEMO-02/03): a normal-flow marker row
          keeps the preview marked as sample data on every phone
          screen — the rail-shell bar never renders below 768px and the welcome
          banner is dismissed on the first tap — and it is the phone-reachable
          door to the preview guide, where the six-step tour lives. Top-left
          inside the safe-area inset (owner call 2026-08-09, sol F3/F4 on
          89660c497: bottom-left collided with the Features-card avatar and
          hid behind the phone keyboard; the 2026-07-31 status-bar collision
          was the full-width strip, not a small inset-aware pill). The row now
          reserves space before all phone content instead of overlaying it. */}
      {personaDemoChrome && !embedPhone && !railShell && resolvedView !== "today" && (
        <div className="demo-chip-row">
          <button type="button" className="demo-chip" aria-label={tr("demo.chipLabel")} onClick={() => { captureDemoAction("open_guide", view); setGuideOpen(true); }}>
            <span className="demo-chip__dot" aria-hidden="true" />
            {tr("demo.chip")}
          </button>
        </div>
      )}
      {/* The embedded companion phone carries no demo strip — and no demo
          chip — of its own (owner call, 2026-07-31): the bezel exists to
          preview the product, and a yellow line inside it read as product
          chrome rather than demo context. The outer shell's demo bar sits
          beside the bezel and keeps the tab honestly marked. */}
      {/* The prototype's global mobile top bar (.mtop): mounted on every
          non-Home phone screen — member routes, staff planes, real narrow
          viewports and the embedded companion alike. Home keeps the card
          layer's ephemeral hat pill instead of duplicating chrome.
          The SAMPLE bar's hat select carries the COMPLETE hat set (member
          plus every wearable plane). SaaS mounts no hat select. */}
      {/* The same top bar covers every staff plane and Chapter work at phone
          widths. SAMPLE keeps the complete hat select; SaaS does not. */}
      {!railShell && !altShell && resolvedView !== "today" && (
        <MobileTopBar
          onHome={() => navigate("today", "/m")}
          onFeatures={() => navigate("today", "/m", null, { homePanel: "features" })}
          roleLabel={officeHatLabel || sharedStaffViewLabel || (STAFF_TOOL_VIEWS.includes(view) ? tr(STAFF_TOOLS.find((tool) => tool.view === view)?.labelKey) : staffPlane ? tr(staffPlane.labelKey) : undefined)}
          officeLabel={highestOfficeKey(data.member, data.roles) ? tr(highestOfficeKey(data.member, data.roles)) : null}
          hatOptions={personaRouting ? mobileHatOptions : null}
          activeHat={activeHat}
          onHatChange={personaRouting ? switchHat : null}
          onNotifications={() => setNotificationsOpen(true)}
          notifDot={(data.member?.notificationCount ?? 0) > 0}
          notifCount={data.member?.notificationCount ?? 0}
          initials={railInitials}
          onProfile={() => setProfileOpen(true)}
        />
      )}
      {/* Home alone keeps the ephemeral glass hat pill inside MobileCardNav;
          inner routes carry the full bar so switching hats and notifications
          no longer require a round trip through the feed. */}
      <main
        id="main-content"
        tabIndex={-1}
        aria-label={mainWorkspaceLabel}
        data-view={resolvedView}
        className={`app-column${view === "tasks" ? " app-column--coordination" : ""}${view === "organize" ? " app-column--organize" : ""}${planeWide ? " app-column--plane" : ""}${isSwitching ? " is-switching" : ""}`}
      >
        {/*: in the classic shell this is the first thing in main, so the
            confirmation takes space instead of covering the form. */}
        {altShell ? null : <ActionToast {...noticeToast} />}
        {workflowReturn && <div className="connected-actions connected-workflow-return"><button type="button" onClick={() => void navigateConnected(workflowReturn).catch(() => setNotice(lang === "es" ? "El elemento original ya no está disponible." : "The original item is no longer available."))}>{lang === "es" ? "Volver al elemento original" : "Back to original item"}</button></div>}
        <NativeAppNudge enabled={!demo} selectedHat={selectedStaffHat} pathname={window.location.pathname} search={window.location.search} hash={window.location.hash} />
        {/* D-14 announces the material change; D-08 takes the acceptance. While
            an acceptance is outstanding the prompt supersedes the notice, so a
            reader is told once and asked once. */}
        {legalReacceptance.reacceptanceRequired
          ? <LegalAcceptancePrompt
            instruments={legalReacceptance.instruments}
            client={sessionDataClient}
            onAccepted={refreshLegalAcceptance}
            onUnavailable={markLegalPackUnavailable}
            onProfile={shared.onProfile}
            userId={session?.user?.id ?? null}
          />
          : <LegalChangeNotice accepted={recordedLegalAcceptances(legalAcceptance)} />}
        <LearningPeriodBanner onNotice={setNotice} />
        {/* The card above says the person must accept to go on, so until the
            acceptance is recorded no protected view renders: only the card,
            the rail or top bar (sign-out and the profile sheet) and the legal
            documents the card links to stay reachable. The one exception is a
            database that cannot record the versions shown (legalBlocked). */}
        {!legalBlocked && (<>
        {showHatRouteRefusal && <StaffRouteRefusal
          refusal={hatRouteRefusal}
          message={hatRouteRefusalText}
          homeClearance={!railShell && resolvedView === "today" && roleDeskPlanes.length > 0}
          dismissLabel={tr("demo.hatRouteDismiss")}
          onDismiss={() => { setHatRouteRefusal(null); document.getElementById("main-content")?.focus(); }}
        />}
        {/* The onboarding guide card (old dashboard top chrome). Member hat
            only. Home is the one place it is NOT rendered here: every Home
            layout places the same card in its own guidance slot, after the
            password prompt and before the ordinary nudge
            (BUG-UG-PASSWORD-PROMPT-OVERLAPS-ONBOARDING-20261020), so
            a guided member sees exactly one prompt on every width. */}
        {/*  (B-39) and: a finished card stays on Home only, on every
            shell; a card still in progress keeps guiding on every page. */}
        {resolvedView !== "today" && onboardingHudCard("", featureGuideCard(resolvedView), { hideComplete: true })}
        <StaffAuthoringContext.Provider value={staffAuthoring}>
        {/* Keyed on the view so navigating away clears a failed boundary: a
            chunk that 404'd once must not poison the screen for the session. */}
        <ChunkBoundary
          key={view}
          fallback={(dismiss, kind) => (
            <div className="view-error" role="alert">
              <h1>{tr(kind === "chunk" ? "app.viewLoadFailedTitle" : "app.viewCrashTitle")}</h1>
              {offline ? <p>{tr("offline.banner")}</p> : kind === "chunk" ? <p>{tr("app.viewLoadFailedBody")}</p> : null}
                {kind === "chunk" ? null : <p>{tr("app.viewCrashSupport")}{VIEW_SUPPORT_EMAIL ? <> <a href={`mailto:${VIEW_SUPPORT_EMAIL}`}>{VIEW_SUPPORT_EMAIL}</a></> : null}</p>}
              {/* Offline, a reload would only lose the shell they still have,
                  so retry in place; online, the shell itself may be the stale
                  half and a reload is what actually fixes it. */}
              <button className="dialog-primary" type="button" onClick={() => { dismiss(); if (!offline) window.location.reload(); }}>{tr("app.tryAgain")}</button>
            </div>
          )}
        >
          <Suspense key={sessionGeneration} fallback={<ViewLoading label={routeOpeningLabel} />}>
            {/* BUG-UG-DEMO-HAT-SWITCH-WAIT-GENERIC-WHILE-DESK-CHUNK-LOADS-20261108:
                the switched hat's page has settled only once it has drawn
                (loaded or failed): a first open of a desk suspends on its
                chunk and this boundary's fallback must still name the hat.
                Later page loads say the generic wait. */}
            {routeOpeningHat && !sampleHatTransitioning && routeLoad.status !== "loading" ? <AfterPageCommit onCommit={clearSampleHatOpening} /> : null}
            {/* The switched hat's page, not the interim /m on the way. */}
            {sampleHatFocusView === view && !sampleHatTransitioning ? <AfterPageCommit onCommit={restoreSampleHatFocus} /> : null}
            {/* On phones the home space is the three-card layer (owner voice
                spec, 2026-08-05): All Features · the feed · Work. Desktop
                keeps the plain dashboard — the rail already IS its feature
                directory. Every other view stays a full screen. */}
            {routeLoad.refreshError && (
              <div className="view-error" role="alert">
                <p>{tr("toast.reloadFailed")}</p>
                <button className="dialog-primary" type="button" onClick={() => refresh().catch(() => {})}>{tr("app.tryAgain")}</button>
              </div>
            )}
            {routeLoad.status === "error" ? (
              <div className="view-error" role="alert">
                <span className="eyebrow">{tr("app.dataEyebrow")}</span>
                <h1>{tr("app.viewLoadFailedTitle")}</h1>
                <p>{tr("app.viewLoadFailedBody")}</p>
                <button className="dialog-primary" type="button" onClick={() => refresh().catch(() => {})}>{tr("app.tryAgain")}</button>
              </div>
            ) : routeLoad.status !== "loaded" ? (
              <ViewLoading label={routeOpeningLabel} />
            ) : rolesPendingForView ? (
              <ViewLoading
                data-roles-pending="true"
                label={tr("app.loading")}
                action={<button className="dialog-primary" type="button" onClick={() => refresh().catch(() => {})}>{tr("app.tryAgain")}</button>}
              />
            ) : demoChapterLanding && demo && demoChapterSelection ? (
              altShell
                ? <div className="ug-legacy-page"><DotGrid /><div className="ug-wrap ug-legacy"><ChapterCatalogWorkspace chapter={demoChapterSelection} onClose={() => clearDemoChapterSelection(true)} /></div></div>
                : <ChapterCatalogWorkspace chapter={demoChapterSelection} onClose={() => clearDemoChapterSelection(true)} />
            ) : resolvedView === "today" && !railShell && !altShell ? (
              <>
              <MobileCardNav
                initialPanel={mobileHomePanel}
                onInitialPanelConsumed={consumeMobileHomePanel}
                onNavigate={railNavigate}
                onAsk={compassOn ? () => setAssistantOpen(true) : null}
                workItems={workItems}
                workLabel={workPlane ? tr(workPlane.labelKey) : null}
                workData={data}
                workWidgetOrder={normalizeWidgetOrder(data.member?.workWidgetOrder)}
                onWorkWidgetOrderChange={(next) => saveNavigationPreferences({ workWidgetOrder: next })}
                shortcutKeys={normalizeShortcutKeys(data.member?.shortcutKeys, hasShortcutStewardRole)}
                hasStewardRole={hasShortcutStewardRole}
                onShortcutKeysChange={(next) => saveNavigationPreferences({ shortcutKeys: next })}
                navUsageWeights={navUsage.weights}
                chapterName={data.member?.chapterName ?? null}
                onOpenChapter={() => setChapterSheetOpen(true)}
                customLinks={customNavLinks(data?.organizationConfiguration)}
                topChrome={{
                  hatOptions: personaRouting ? mobileHatOptions : null,
                  // SaaS role holders get desk entries instead of a hat select
                  // Member is the way back.
                  deskEntrances: !demo && roleDeskPlanes.length > 0
                    ? [{ key: "member", label: tr("demo.hatMember") }, ...roleDeskPlanes.map((plane) => ({ key: plane.key, label: tr(plane.labelKey) }))]
                    : null,
                  onEnterDesk: demo ? null : switchHat,
                  // The worn hat, not the view-derived activeHat: on the home
                  // route the latter is always "member", and the select must
                  // agree with the hat whose desk the Work card is showing.
                  activeHat: workHatKey ?? "member",
                  onHatChange: personaRouting ? switchHat : null,
                  demoMarker: personaDemoChrome && !embedPhone && !railShell ? (
                    <div className="demo-chip-row">
                      <button type="button" className="demo-chip" aria-label={tr("demo.chipLabel")} onClick={() => { captureDemoAction("open_guide", view); setGuideOpen(true); }}>
                        <span className="demo-chip__dot" aria-hidden="true" />
                        {tr("demo.chip")}
                      </button>
                    </div>
                  ) : null,
                }}
                onNotifications={() => setNotificationsOpen(true)}
                onProfile={() => setProfileOpen(true)}
                notifDot={(data.member?.notificationCount ?? 0) > 0}
                notifCount={data.member?.notificationCount ?? 0}
                memberName={railPersona?.fullName ?? null}
                memberFeaturesAvailable={!(selectedStaffHatAuthorized && views[selectedStaffHat])}
                guide={navGuide}
                guideShowAll={onboardingGuideShowAll}
                onGuideShowAllChange={setOnboardingGuideShowAll}
                siteGuide={siteGuideEnabled(data.organizationConfiguration)}
                dues={duesNav}
              >
                {selectedStaffHatAuthorized && views[selectedStaffHat]
                  ? <WorkspacePages demoNavigation={demoNavigation} dues={duesNav} view={selectedStaffHat} hat={selectedStaffHat} location={routeLocation} navigate={navigate}>{views[selectedStaffHat]}</WorkspacePages>
                  : views.today}
              </MobileCardNav>
              </>
            ) : (
              <>
                {altShell && altView === "tasks"
                  ? <div key={altView} className="ug-alt-page ug-work-page"><DotGrid /><AltWorkHero onOpenHome={() => navigate("today", "/m")} /><WorkspacePages demoNavigation={demoNavigation} dues={duesNav} view={altView} hat={selectedStaffHat} location={routeLocation} navigate={navigate} hiddenPageKeys={settingsHiddenPages}>{views[altView]}</WorkspacePages></div>
                  : altShell && ALT_BODY_VIEWS.has(altView)
                  ? <div key={altView} className="ug-alt-page ug-alt-body"><DotGrid /><WorkspacePages demoNavigation={demoNavigation} dues={duesNav} view={altView} hat={selectedStaffHat} location={routeLocation} navigate={navigate} hiddenPageKeys={settingsHiddenPages} menu={false}>{views[altView]}</WorkspacePages></div>
                  : altShell && altView === "updates"
                  ? <div key={altView} className="ug-alt-page"><DotGrid />{views.updates}</div>
                  : altShell && altView === "messages"
                  ? <div key={altView} className="ug-alt-page"><DotGrid /><WorkspacePages demoNavigation={demoNavigation} dues={duesNav} view={altView} hat={selectedStaffHat} location={routeLocation} navigate={navigate} hiddenPageKeys={settingsHiddenPages}>{views[altView]}</WorkspacePages></div>
                  : altShell && altView !== "today"
                  ? <div key={altView} className={`ug-legacy-page${altPageTitle ? " ug-with-hero" : ""}${HERO_KEEPS_PAGE_H1.has(altView) ? " ug-keep-h1" : ""}`}><DotGrid />{altPageTitle ? <AltPageHero title={altPageTitle} view={altView} onOpenHome={() => navigate("today", "/m")} /> : null}{altPageTitle ? <AltPageKpis view={altView} data={data} /> : null}{altPageTitle && altView === "events" ? <div className="ug-wrap ug-alt-page-calendar"><AltCalendar items={recordItems(data)} onOpenItem={openAltRecord} idPrefix="ug-events-cal" /></div> : null}<div className="ug-wrap ug-legacy"><WorkspacePages demoNavigation={demoNavigation} dues={duesNav} view={altView} hat={selectedStaffHat} location={routeLocation} navigate={navigate} hiddenPageKeys={settingsHiddenPages}>{views[altView]}</WorkspacePages></div></div>
                  : <WorkspacePages demoNavigation={demoNavigation} dues={duesNav} view={resolvedView} hat={selectedStaffHat} location={routeLocation} navigate={navigate} hiddenPageKeys={settingsHiddenPages}>{views[resolvedView]}</WorkspacePages>}
              </>
            )}
            <ChunkReady ready={routeLoad.status === "loaded"} />
          </Suspense>
        </ChunkBoundary>
        </StaffAuthoringContext.Provider>
        </>)}
      </main>
      {/* The shortcut bubble is retired (owner spec, 2026-08-07). On inner
          phone screens the persistent Home orb now docks in MobileTopBar's
          reserved chrome instead of floating over live content; the home
          route still mounts its own orb inside MobileCardNav for side cards. */}
      {/* Overlays share one boundary-free Suspense with a null fallback: each
          is opened by an explicit gesture and appears when its chunk lands, so
          a spinner over the shell would be noise rather than information. */}
      <Suspense fallback={null}>
        {demoWelcomeExit.shown && (
          <DemoWelcome
            memberName={(samplePersonaForHat(selectedStaffHat) ?? defaultSamplePersona())?.fullName || data.member.fullName}
            roleName={tr(DEMO_HATS.find((entry) => entry.key === selectedStaffHat)?.labelKey ?? "demo.hatMember")}
            inSession={fixtureDemo}
            onExplore={dismissDemoWelcome}
            closing={demoWelcomeExit.closing}
            onTransitionEnd={demoWelcomeExit.onTransitionEnd}
          />
        )}
        {guideExit.shown && <PreviewGuide closing={guideExit.closing} onTransitionEnd={guideExit.onTransitionEnd} castNames={sampleLive ? Object.fromEntries(samplePersonas().map((persona) => [persona.hat, persona.fullName])) : null} onClose={() => setGuideOpen(false)} onNavigate={(key, path) => navigate(key, `${path}?demo=1`)} onStartTour={() => { setGuideOpen(false); setTourOpen(true); navigate("today", "/m?demo=1"); }} />}
        {tourExit.shown && <GuidedTour closing={tourExit.closing} onTransitionEnd={tourExit.onTransitionEnd} onClose={() => setTourOpen(false)} onNavigate={(key, path) => navigate(key, `${path}?demo=1`)} />}
        {assistantOpen && compassOn && !sessionRestricted && !legalBlocked && <Assistant sessionOperation={memberOperation} demo={demoActive} searchTarget={assistantSearchTarget}
          suggestions={demoActive ? null : suggestedQuestionsFor(data.organizationConfiguration, selectedStaffHatAuthorized ? selectedStaffHat : "member", tr)}
          hat={selectedStaffHatAuthorized ? selectedStaffHat : "member"}
          staffDataAvailable={!demoActive && selectedStaffHatAuthorized && staffDataAnswersEnabled(data.organizationConfiguration)}
          pageHelp={!demoActive && pageAwareHelpEnabled(data.organizationConfiguration) && COMPASS_PAGE_KEYS.includes(resolvedView) ? { key: resolvedView, label: tr(`compass.page.${resolvedView}`) } : null}
          answerActions={compassAnswerActions}
          nudges={visibleCompassNudges}
          historyError={!demoActive && Boolean(memberLoaderRef.current?.failuresForResources(MEMBER_GUIDE_HISTORY_RESOURCES).length)}
          historyLoading={!demoActive && MEMBER_GUIDE_HISTORY_RESOURCES.some((resource) => ["idle", "loading"].includes(memberLoaderRef.current?.inspect().get(resource)?.status ?? "idle"))}
          onRetryHistory={() => {
            memberLoaderRef.current?.retryFailedResources(MEMBER_GUIDE_RESOURCES);
            loadCompassPrerequisites().catch(() => {});
          }} threads={data.guideThreads} sourceArticles={data.kbArticles || []} onOpenSource={openCompassSource} initialDraft={assistantDraft} onClose={() => { setAssistantOpen(false); setAssistantDraft(""); setAssistantSearchTarget(null); }} onSend={async (question, threadId, messages, options) => {
    return memberOperation.run(async () => {
          // No toast in demo: the answer appearing IS the feedback, and the
          // demo has nothing truthful to say about saving.
          if (demoActive) return appendDemoGuideExchange(question, threadId);
          // The reply is hoisted out of mutate() for the refresh-failure
          // fallback: the RPC commits and returns the (possibly new) thread
          // id, and the sheet selects that id — so on a failed reload the
          // exchange must land in local state or a saved answer renders as a
          // blank conversation.
          let reply = null;
          // Captured BEFORE the write: the ids this send started from are how
          // the fallback below tells a post-save message read (which carries
          // the committed exchange) from a stale one (which does not).
          const priorMessageIds = new Set((dataRef.current?.guideThreads
            ?.find((thread) => thread.id === threadId)?.messages ?? []).map((message) => message.id));
          const savedThreadId = await memberOperation.wait(mutate(memberMutationResources("saveGuideExchange"), async () => {
            reply = await memberOperation.wait(requestGuideReply(session, question, { ...options, lang }));
            if (!memberOperation.isCurrent()) return;
            // Search-only degraded reply: there is no answer to save. Leave
            // mutate() through its failure path so the toast reads this
            // catalogue sentence (the message IS the translated copy) and the
            // sheet renders the verified sources from the tagged error.
            if (reply?.degraded) {
              throw Object.assign(new Error(tr("guide.degradedToast")), { code: "compass_degraded", degraded: reply.degraded, sources: reply.sources, scopeNotices: reply.scopeNotices });
            }
            return saveGuideExchange(sessionDataClient, session.user.id, threadId, question, reply.answer, reply.sources);
          }, tr("toast.guideReplySaved"), null, null, null, "guide.errorAnswer"));
          // mutate() refreshes the underlying route. That can succeed while
          // omitting guide rows (Home, Rights, Messages, ...), so success is
          // not evidence that this overlay's saved exchange is present.
          try {
            await memberOperation.wait(loadCompassPrerequisites());
          } catch { memberOperation.assertCurrent();
            guideLocalPendingRef.current = true;
            const retained = guideExchangeRows(question, savedThreadId, reply.answer, reply.sources,
              (targetId) => persistedGuideRows(targetId, priorMessageIds));
            // The write committed; only the read back failed. Retain it in the
            // loader too, so every later projection — this route's, realtime's,
            // Search's — carries the saved exchange until an authoritative
            // guide read does.
            memberLoaderRef.current?.confirmProjection(
              `guide-exchange-${retained.targetId}`,
              MEMBER_GUIDE_HISTORY_RESOURCES,
              (projection) => ({ ...projection, guideThreads: retained.apply(projection.guideThreads) }),
            );
            commitGuideExchangeLocal(retained);
          }
          return savedThreadId;
            });
  }} />}
        {profileOpen && <ProfileDialog member={data.member} cosmeticBadge={selectedCosmetic(freeCosmetics.workspace, 'badge') ? cosmeticCopy[lang === 'es' ? 'es' : 'en'].badge : null} onClose={() => setProfileOpen(false)} onSave={(fields) => mutate(memberMutationResources("updateMemberProfile"), () => updateMemberProfile(sessionDataClient, session.user.id, fields), tr("toast.memberCardUpdated"), { kind: "profile", key: "profile", args: { userId: session.user.id, fields } }, () => setData((current) => ({ ...current, member: { ...current.member, ...fields } })), null, "toast.saveFailed")} onSignOut={fixtureDemo ? null : () => signOutOnce("local", true).catch((error) => { throw Object.assign(new Error("Sign-out failed"), { noticeKey: signOutNoticeKey(error) }); })} signingOut={signingOut} onLanguage={activeHat === "member" ? null : handleLanguage} onSettings={() => { setProfileOpen(false); navigate("settings", "/m/settings"); }} chapterRailOwner={!altShell && desktopShell ? { memberId: demo ? null : data.member?.id ?? null, demo } : null} />}
        {notificationsOpen && !legalBlocked && <NotificationsDialog notifications={data.notifications} onClose={() => setNotificationsOpen(false)} onReadAll={() => mutateWithOutcome(memberMutationResources("markNotificationsRead"), () => markNotificationsRead(sessionDataClient, session.user.id), tr("toast.notificationsRead"), { kind: "notificationsRead", key: "all", args: { userId: session.user.id } }, () => setData((current) => ({ ...current, member: { ...current.member, notificationCount: 0 }, notifications: (current.notifications || []).map((item) => item.read_at ? item : { ...item, read_at: new Date().toISOString() }) })))} onCreateTaskFromSource={selectedStaffHatAuthorized ? handleCreateTaskFromSource : null} onOpenTask={selectedStaffHatAuthorized ? (task) => { setNotificationsOpen(false); return handleOpenSourceTask(task).catch((error) => setNotice(tr(isSourceGone(error) || isPermissionRefusal(error) ? "sourceTask.unavailable" : "sourceTask.openError"))); } : null} onOpenDestination={(destination, item) => { setNotificationsOpen(false); const staleResources = notificationRefreshResources(item); if (staleResources.length) memberLoaderRef.current?.invalidateResources(staleResources); notificationOpenCounter.current += 1; setNotificationOpenIntent({ id: notificationOpenCounter.current, path: destination.path }); navigate(destination.view, destination.path); }} chapterId={data.member?.chapterId ?? null} />}
        {activePlan && <ChoiceDialog item={activePlan} onClose={() => setActivePlan(null)} onSubmit={submitChoice} />}
        {/* Phone-shell surface only: the open flag rides device parity so the
            companion pair stays in step, but rail workspaces keep their rail.
            Mirroring the flag must never conjure a duplicate tablet/desktop
            chapter modal. */}
        {chapterSheetOpen && !railShell && (
          <ChapterSheet
            chapterName={data.member?.chapterName || tr("nav.myChapter")}
            memberTools={!selectedStaffHatAuthorized}
            dues={duesNav}
            tools={selectedStaffHatAuthorized ? [STAFF_WORK_RAIL_ITEM] : null}
            onNavigate={railNavigate}
            onClose={() => setChapterSheetOpen(false)}
          />
        )}
      </Suspense>
    </LearningPeriodProvider>
  );

  return (
   <LanguageProvider lang={lang} labelOverrides={organizationLabelOverrides}>
    <OrganizationNameProvider value={currentOrganizationName}>
    <StewardPresenceProvider value={memberStewardPresence}>
    <div
      data-workspace-theme={renderedWorkspaceTheme || undefined}
      data-shell={altShell ? "alt" : undefined}
      className={`${altShell ? "ugalt " : ""}sg-app${desktopShell ? " sg-app--desktop" : ""}${tabletShell ? " sg-app--tablet" : ""}${view === "tasks" ? " sg-app--tasks" : ""}${desktopShell && assistantOpen ? " sg-app--compass-wide" : ""}`}
    >
      {altShell ? null : <a className="skip-link" href="#main-content">{tr("app.skip")}</a>}
      <ObservabilityStart />
      <CommandPalette key={sessionGeneration} sessionOperation={memberOperation}
        commands={paletteCommands}
        resolveSearchResults={resolvePaletteSearchResults}
        resolveRemoteResults={demoActive || selectedStaffHatAuthorized || !caseSearchClient ? null : resolvePaletteCaseResults}
        onOpen={demoActive ? null : loadSearchPrerequisites}
      />
      {/* The bell is deliberately every-hat (role-map UB-NAV-06): on rail
          shells the rail is the identity chrome, so a member-hat route with a
          staff-gated bell had no notifications entry point at all. Nothing
          else in the rail-shell tree draws one — TodayView's own bell went in
          c1f8268bd, so the old "the Today header keeps the bell" rationale
          for the gate stopped being true and there is no duplication to
          avoid. The Green desktop rail and the tablet rail both expose the
          member profile because neither workspace has the phone drawer;
          plane-strip duplicates hide under the matching shell scope.
          The chapter flyout opens from both rails: tablets had no way to
          switch chapter at all (#9543, A-38/B-51). */}
      {!altShell && railShell && (
        <ChapterRail
          flyout
          id="chapter-flyout"
          triggerId="chapter-flyout-trigger"
          open={chapterFlyoutOpen}
          onOpenChange={setChapterFlyoutOpen}
          chapters={chapterRailChapters}
          selectedId={chapterRailSelectedId}
          busy={chapterSwitching}
          memberId={demo ? null : data.member?.id ?? null}
          demo={demo}
          onSelect={(chapter, trigger) => {
            // SAMPLE uses one backed, cross-chapter catalog while retaining
            // the current persona and authorization. SaaS keeps the existing
            // member-scoped chapter navigation.
            if (demo) {
              // The flyout closes on a choice, so focus comes back to the
              // rail's chapter button rather than the unmounted choice.
              demoChapterTriggerRef.current = document.getElementById("chapter-flyout-trigger") ?? trigger;
              restoreDemoChapterFocusRef.current = false;
              setDemoChapterSelection(chapter);
            }
            else {
              //: the live path closes the flyout too, and the focused
              // choice unmounts with it. Once the switch settles (or fails,
              // with its notice announced) focus goes back to the rail's
              // chapter button, unless the member already moved it.
              void Promise.resolve(selectMemberChapterRef.current(chapter)).finally(() => {
                focusWhenAvailable(() => document.getElementById("chapter-flyout-trigger"));
              });
            }
          }}
        />
      )}
      {!altShell && railShell && <DesktopRail renderMode={desktopShell ? "desktop" : "tablet"} memberId={personaRouting ? null : data.member?.id ?? null} demo={personaRouting} demoNavigation={demoNavigation} navUsageWeights={navUsage.weights} navUsagePins={navUsage.pins} staffRolesPaused={data.staffMfa?.blocked === true && data.staffMfa?.holdsStaffRole === true} active={view} activeHat={activeHat} workspaceTheme={renderedWorkspaceTheme} onSwitchHat={personaRouting && tabletShell ? switchHat : null} onNavigate={railNavigate} onAsk={compassOn ? () => setAssistantOpen(true) : null} steward={realSteward} staffPlanes={railStaffPlanes} deskEntrances={personaRouting ? [] : roleDeskPlanes} stewardBadges={data.stewardBadges ?? null} badges={{ cases: (data.cases ?? []).filter((item) => item.status === "active").length || null, forms: (data.forms ?? []).filter((item) => item.status === "draft").length || null }} roleLabel={officeHatLabel || sharedStaffViewLabel || (onStaffHat ? (STAFF_TOOL_VIEWS.includes(view) ? tr(STAFF_TOOLS.find((tool) => tool.view === view)?.labelKey) : staffPlane ? tr(staffPlane.labelKey) : null) : null)} onNotifications={() => setNotificationsOpen(true)} notifDot={(data.member?.notificationCount ?? 0) > 0} notifCount={data.member?.notificationCount ?? 0} guide={navGuide} guideShowAll={onboardingGuideShowAll} onGuideShowAllChange={setOnboardingGuideShowAll} siteGuide={siteGuideEnabled(data.organizationConfiguration)} dues={duesNav} user={{ name: railPersona.fullName, initials: railInitials, onProfile: () => setProfileOpen(true) }} customLinks={customNavLinks(data?.organizationConfiguration)} chapterFlyout={railShell ? { open: chapterFlyoutOpen, onToggle: () => setChapterFlyoutOpen((current) => !current), controlsId: "chapter-flyout", triggerId: "chapter-flyout-trigger", current: chapterRailChapters.find((chapter) => chapter.id === chapterRailSelectedId) ?? null } : null} />}
      {altShell ? (
        <Suspense fallback={<AppLoadingScreen label={tr("app.loading")} />}>
          <AltShell
            active={altView}
            activePath={routeLocation}
            onNavigate={railNavigate}
            onSwitchShell={shellSwitchAvailable ? () => switchShell(CLASSIC_SHELL) : null}
            // Work is offered only while an authorized staff hat is worn, as the
            // rail does: under Member the Tasks route refuses (explicitHatAllowsView).
            tabWork={selectedStaffHatAuthorized ? workTab({ roles: [selectedStaffHat], tasks: data.tasks, memberId: data.member?.id ?? null }) : null}
            onSearch={() => navigate("search", "/m/search")}
            onAsk={shared.onAssistant}
            onNotifications={() => setNotificationsOpen(true)}
            notifCount={data.member?.notificationCount ?? 0}
            user={{ name: railPersona.fullName, initials: railInitials, onProfile: () => setProfileOpen(true) }}
            activeHat={selectedStaffHatAuthorized ? selectedStaffHat : "member"}
            hatOptions={personaRouting ? mobileHatOptions : roleDeskPlanes.length > 0 ? [{ key: "member", label: tr("demo.hatMember") }, ...roleDeskPlanes.map((plane) => ({ key: plane.key, label: tr(plane.labelKey) }))] : []}
            onSwitchHat={switchHat}
            chapters={chapterRailChapters}
            selectedChapterId={chapterRailSelectedId}
            chapterBusy={chapterSwitching}
            onSelectChapter={altChapterSelector}
            badges={{
              messages: (data.conversations ?? []).reduce((sum, row) => sum + (Number(row.unread) || 0), 0) || null,
              voting: (data.planItems ?? []).filter((item) => item.kind === "ballot" && !item.closed && !item.receiptCode).length || null,
              cases: (data.cases ?? []).filter((item) => item.status === "active").length || null,
              forms: (data.forms ?? []).filter((item) => item.status === "draft").length || null,
            }}
            customLinks={customNavLinks(data?.organizationConfiguration)}
            navUsageWeights={navUsage.weights}
            siteGuide={siteGuideEnabled(data.organizationConfiguration)}
            dues={duesNav}
            demoNavigation={demoNavigation}
            toast={noticeToast}
          >
            {shellBody}
          </AltShell>
        </Suspense>
      ) : <div className="sg-shell-body">{shellBody}</div>}
    </div>
    </StewardPresenceProvider>
    </OrganizationNameProvider>
   </LanguageProvider>
  );
}

// Member integration consumers keep their component name. The browser entry
// imports AppRouter directly, so this module never imports back into bootstrap.
export const App = MemberApp;
