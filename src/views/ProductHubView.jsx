import { useRoutedTab, RoutedTabLink } from "../components/WorkspacePages.jsx";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "../components/Button.jsx";
import { BusyButton, BusyInput } from "../components/BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { Bell, BellOff, BookOpen, Bot, Download, Handshake, Landmark, MessageSquareText, Pin, Plus, Scale, ShieldCheck, Trash2 } from "lucide-react";
import { Dialog } from "../components/Dialog.jsx";
import { MessageActions } from "../components/MessageActions.jsx";
import { EmptyState } from "../components/Primitives.jsx";
import { StaffAuthoringHint } from "../components/StaffAuthoringHint.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { EARLIER_HISTORY_RECONCILE_MS, useEarlierHistory } from "../features/messaging/earlierHistory.js";
import { EarlierThreadHistory, usePrependAnchor, withCreatedAt } from "../features/messaging/EarlierThreadHistory.jsx";
import { withLoadDeadline } from "../lib/loadDeadline.js";
import { countKey } from "../lib/i18n.js";
import { formatEasternTimestamp } from "../lib/easternTimestamp.js";
import { postBody, spaceDescription, spaceName, spanishSpaceEdit, spanishValue } from "../lib/bilingualContent.js";
import { rpcErrorKeyStrict, rpcErrorTextAtRender } from "../lib/rpcErrorText.js";
import { STAFF_TOOL_ROLES } from "../lib/staffPlanes.js";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { KnowledgeWorkspacePanel } from "../features/knowledge/KnowledgeWorkspacePanel.jsx";
import { useAccessibleKnowledgeArticles } from "../features/knowledge/useAccessibleKnowledgeArticles.js";
import { ChapterFinancePanel } from "../features/finance/ChapterFinancePanel.jsx";
import { ChapterBudgetPanel } from "../components/ChapterBudgetPanel.jsx";
import { OfficerMemberDirectory } from "../components/OfficerMemberDirectory.jsx";
import { InstitutionalRecordsPanel } from "../features/institutionalRecords/InstitutionalRecordsPanel.jsx";
import { ChapterAccessPanel } from "../features/chapterAccess/ChapterAccessPanel.jsx";
import { NoticeGlowControl } from "../features/chapterNotices/NoticeGlow.jsx";
import { ChapterOfficePanel } from "../features/chapterAccess/ChapterOfficePanel.jsx";
import { ChapterOfficeRoleChoice } from "../features/chapterAccess/ChapterOfficeRoleChoice.jsx";
import { selectedChapterOfficeRole } from "../lib/chapterOfficeRoles.js";
import { ChapterLeadershipRecoveryCard } from "../features/governance/ChapterLeadershipRecoveryCard.jsx";
import { localDateTimeInputToIso, localDateTimeInputValue } from "../lib/localDateTime.js";
import { ConnectionSuggestions } from "../features/connectionSuggestions/ConnectionSuggestions.jsx";
import { PartnerOffices } from "../features/connectionSuggestions/PartnerOffices.jsx";
import { createConnectionAdapter } from "../features/connectionSuggestions/adapter.js";
import { UnionNetworkNav } from "../features/unionCatalog/UnionNetworkNav.jsx";
import { unionNetworkCopy } from "../features/unionCatalog/unionNetworkCopy.js";
import { isDeliveredMessage } from "../features/messaging/sourceTask.js";
import { useLandOnMessage } from "../features/messaging/useLandOnMessage.js";
import { isPermissionRefusal, isSourceGone, mergeLandedMessage } from "../features/connectedWorkflows/landing.js";
import { ContextualPulseSlot } from "../features/engagement/ContextualPulseSlot.jsx";
import { PULSE_HUB_THREAD_KINDS } from "../features/engagement/contextualPulse.js";
import { parseRemindCommand } from "../features/messaging/remindCommand.js";
import { REMIND_HERE_SWITCH, remindHereRefusal } from "../features/messaging/remindHere.js";
import { isFeatureEnabled } from "../lib/featureSwitches.js";
import { formatDateTimeWithZone } from "../lib/i18n/zonedDates.js";
import { channelSettingFor, isMuteActive, mentionIdsForBody, appendMentionText, orderThreadsForChannel } from "../features/messaging/channelControls.js";
import { createChannelControlsApi, useChannelControls } from "../features/messaging/channelControlsApi.js";
import { ChannelPostBody, ChannelSettingsDialog, MentionPicker, MentionSearchPanel, PinToggle, channelHasAnyControl } from "../features/messaging/ChannelControls.jsx";
import { ChannelPollCard } from "../components/ChannelPollCard.jsx";
import AltChapterPage from "../alt/record/AltChapterPage.jsx";
import "../lib/i18n/features/bilingualContentStrings.js";
import "../lib/i18n/features/rightsQuestionsStrings.js";

const TAB_ICONS = {
  organize: MessageSquareText,
  voice: Scale,
  library: BookOpen,
  record: Landmark,
  partners: Handshake,
  connections: Handshake,
  governance: ShieldCheck,
};

// Derived, not restated. This was a hand-written Set of the same five role
// names staffPlanes.js already publishes — a second copy of the gate that
// decides who may see a staff affordance, in a file that has no other reason to
// know the role list. Two copies is one copy per way to drift.
const STAFF_ROLES = new Set(STAFF_TOOL_ROLES);
// The roles public.list_channel_mention_candidates treats as staff
// (member_has_role), so the empty picker describes the list the server sends.
const MENTION_STAFF_ROLES = new Set(["steward", "coordinator", "advisor", "admin", "vp"]);

// public.authorize_google_drive_operation refuses list/upload/download unless
// private.has_organization_role(selected org, these five) holds, and that reads
// organization_role_grants only. A chapter-hat steward is staff everywhere else
// in the library, so canStaff alone would offer three controls the server can
// only answer with 42501.
const DRIVE_OPERATION_ROLES = new Set(["steward", "coordinator", "advisor", "admin", "vp"]);

// Chapter tasks have to belong to a workstream on the chapter's OWN list.
// 20260728_..._chapter_tasks_soft_delete_and_workstreams gives chapter_tasks a
// workstream that the prepare trigger case-folds and asserts against
// chapter_workstreams, so a hardcoded "Organizing" is a refused insert for
// every chapter that renamed or never created that entry — and the member sees
// a generic write failure on a button that looked like it would work.
//
// data.workstreams is the chapter's list, name-ordered by the board read. The
// literal survives only as the fallback for a chapter whose list is empty,
// where nothing else can be true.
const FALLBACK_WORKSTREAM = "Organizing";

async function unavailableLifecycleAction() {
  throw new Error("account-lifecycle-unavailable");
}

// Status → chip tone. The prototype's minutes/threads pages carry exactly
// three chip colorways (green = settled, amber = in motion, terra = hot);
// hub statuses across intake/handshakes/governance collapse onto them, with
// a neutral tone for anything unrecognized rather than guessing.
const TONE_BY_STATUS = {
  approved: "green", active: "green", resolved: "green", closed: "green", granted: "green", published: "green", accepted: "green",
  draft: "amber", new: "amber", open: "amber", pending: "amber", proposed: "amber", triaged: "amber", in_review: "amber", requested: "amber",
  urgent: "terra", escalated: "terra", rejected: "terra", blocked: "terra", declined: "terra",
};

function chipTone(status) {
  return TONE_BY_STATUS[String(status || "").toLowerCase()] || "neutral";
}

// UX-UG-WEB-HUB-DIALOG-OPTIONS-AND-LIST-ENUMS-ENGLISH-ONLY-20260920: one
// enum→catalogue-key map per hub enum family. The SAME map renders the dialog
// <option> labels and the list-row echoes, so a given enum value reads
// identically on every surface that shows it (a row can never name a record
// type differently from its own dialog). recordType reuses the records.type.*
// keys the institutional records panel already renders, so the hub and that
// panel name the same record type the same way. An enum the client does not
// know falls back to the raw server value — never a printed catalogue key.
const HUB_ENUM_KEY = {
  visibility: {
    chapter: "hub.visibility.chapter",
    staff: "hub.visibility.staff",
    private: "hub.visibility.private",
    organization: "hub.visibility.organization",
  },
  threadKind: {
    topic: "hub.kind.topic",
    issue: "hub.kind.issue",
    decision: "hub.kind.decision",
  },
  threadStatus: {
    open: "mcases.openChip",
    resolved: "mcases.resolvedChip",
  },
  documentStatus: {
    draft: "records.status.draft",
    published: "records.status.published",
    archived: "records.status.archived",
  },
  intakeCategory: {
    workplace_issue: "hub.category.workplace_issue",
    safety: "hub.category.safety",
    question: "hub.category.question",
    app_feedback: "hub.category.app_feedback",
    other: "hub.category.other",
  },
  documentType: {
    contract: "hub.documentType.contract",
    policy: "hub.documentType.policy",
    minutes: "hub.documentType.minutes",
    training: "hub.documentType.training",
    template: "hub.documentType.template",
    other: "hub.documentType.other",
  },
  recordType: {
    minutes: "records.type.minutes",
    decision: "records.type.decision",
    milestone: "records.type.milestone",
    management_contact: "records.type.management_contact",
    member_contact: "records.type.member_contact",
  },
  dataScope: {
    docs_only: "hub.dataScope.docs_only",
    no_member_data: "hub.dataScope.no_member_data",
    aggregate_only: "hub.dataScope.aggregate_only",
  },
};

function hubEnumLabel(t, family, value) {
  const labelKey = HUB_ENUM_KEY[family]?.[value];
  return labelKey ? t(labelKey) : String(value ?? "");
}

function HubTimestamp({ value }) {
  const { lang } = useLang();
  const stamp = formatEasternTimestamp(value, lang);
  return stamp ? <time dateTime={stamp.dateTime}>{stamp.text}</time> : null;
}

// Renders one <option> per known enum value, in catalogue order, keeping the
// submitted value attribute byte-identical to the enum it always carried.
// `omit` hides values a dialog shows conditionally elsewhere on the same line
// (SpaceDialog's organization option, kept only for an existing org-wide row).
function HubEnumOptions({ t, family, omit = [] }) {
  const hidden = new Set(omit);
  return Object.entries(HUB_ENUM_KEY[family])
    .filter(([value]) => !hidden.has(value))
    .map(([value, labelKey]) => (
      <option value={value} key={value}>{t(labelKey)}</option>
    ));
}

function StatusChip({ status, label }) {
  return <span className={`hub2-chip hub2-chip--${chipTone(status)}`}>{label || status}</span>;
}

// Wave 2c: rebuilt to the prototype's minutes + threads visual language
// (pg.minutes 4230–4253, pg.threads 4256–4275 of the design package): an
// in-page `.ph` header (title + one-line sub over a hairline), flush list
// cards with a bold card head and divider rows, standalone thread cards with
// chip + title + meta rows, and the dot-and-connector timeline. The global
// MobileTopBar is mounted by the shell; this view renders no top chrome of
// its own and the Wave-2b `.strip-head` placeholder is gone. onProfile is the
// top bar's avatar and is no longer read here.
// `alt` (REQ-UG-ALT-PORT-MEMBER-PAGES-20261030): under the alternate
// shell the hub draws the prototype's chapter page
// (src/alt/record/AltChapterPage.jsx) around the same sections, staff
// controls and dialogs; the classic page is unchanged.
export function ProductHubView({
  alt = false,
  onOpenHome = null,
  data,
  chapterSwitch = null,
  onAssistant,
  onCreateSpace,
  onCreateThread,
  onSendPost,
  onReadSpace = null,
  onCreateIntake,
  onTriageIntake,
  onConvertIntake,
  onCreateDocument,
  onSaveKnowledge,
  onRetireKnowledge,
  onCreateRecord,
  onUpdateSpace,
  onUpdateDocument,
  onUpdateRecord,
  onCreateHandshake,
  onUpdateHandshake = null,
  onCreateGovernance,
  onRetryGovernance = null,
  onGenerateDataExport = unavailableLifecycleAction,
  onDeleteAccount = unavailableLifecycleAction,
  onDeleteIndeterminateClose = () => {},
  deletionPasswordReauth = false,
  onCreateTask,
  onListSpaceMembers,
  onSearchSpaceMembers,
  onSetSpaceMember,
  messagingApi = null,
  renderConnectedActions = null,
  onNotice = () => {},
  notificationOpenIntent = null,
  staffAccess,
  triageAccess,
  knowledgeClient = null,
  knowledgeAdminAccess = false,
  knowledgeHealthAccess = false,
  // REQ-UG-ROLE-WORKSPACE-REFUSALS-20261030: the library's staff
  // reads need an organization-wide grant; App says whether the worn role has
  // one. Absent, the library follows the page's staff access as before.
  knowledgeStaffAccess = null,
  onKnowledgeChanged = null,
  institutionalClient = null,
  leadershipApi = null,
  onOpenSettings = null,
  connectionClient = null,
  connectionActor = null,
  connectionPreview = false,
  onSelectOfficeRole = null,
  preview = false,
  focus = null,
  // REQ-UG-CONTEXTUAL-PULSE-PRODUCT-TRIGGERS-20261001: { client,
  // configuration } for the quick check on topic, issue and decision threads.
  pulse = null,
  channelControlsClient = null,
}) {
  const { t, lang } = useLang();
  const network = unionNetworkCopy(lang);
  const [tab, setTab] = useRoutedTab("hub", "organize");
  const [knowledgeRefreshEpoch, setKnowledgeRefreshEpoch] = useState(0);
  const [knowledgeReviewScope, setKnowledgeReviewScope] = useState({ scopeKey: "", chapterId: "" });
  // Destructive-operation lock. While this tree's account-deletion request is
  // unresolved (in flight, or returned indeterminate), nothing above the
  // dialog may replace the dialog value: not a deep-link effect refiring on a
  // product object-identity refresh, and not a paired-device hub.dialog
  // application. The dialog's own beforeClose guard covers member-triggered
  // dismissal; this lock covers the parent. A ref, not state — the guard and
  // the effects need the current interval synchronously, and releasing the
  // lock must not re-run the deep-link effects with a dropped replacement.
  const destructiveDialogLockRef = useRef(false);
  // The session-wide face of the lock. The ref protects THIS tree's dialog
  // value synchronously; session.destructiveHold mirrors the same interval
  // through the device-parity bridge so the paired pane's shell can pin its
  // hub view and its mirrored dialog can disarm a duplicate submit
  // (BUG-UG-ACCOUNT-DELETION-SESSION-SCOPE-20260814).
  const [sessionHold, setSessionHold] = useDeviceParityState("session.destructiveHold", false, {
    // A peer that loses a near-simultaneous server race may publish false
    // while THIS tree still owns the request. Keep the shared hold true and
    // reconcile the peer until the local unresolved interval actually ends.
    acceptApplied: (incoming) => !destructiveDialogLockRef.current || incoming === true,
  });
  const setDestructiveDialogLock = useCallback((locked) => {
    if (destructiveDialogLockRef.current === locked) return;
    destructiveDialogLockRef.current = locked;
    setSessionHold(locked);
  }, [setSessionHold]);
  const [dialog, setDialog] = useDeviceParityState("hub.dialog", null, {
    // Local sets pass through (the setter records before dispatching, so
    // incoming === current); foreign values are refused while locked.
    acceptApplied: (incoming, current) => !destructiveDialogLockRef.current || Object.is(incoming, current),
  });
  // Every panel-driven open funnels through this guard, so a future opener
  // cannot bypass the lock by construction. The dialogs' own onClose handlers
  // keep the raw setter: while the lock is held the only mounted dialog is
  // the deletion dialog itself, and its close paths are governed by
  // beforeClose plus the lock's release.
  // A link (`?thread=<id>&post=<id>`, or a search hit naming a post) can name a
  // channel thread or post the boot snapshot never loaded: it holds the newest 200
  // threads and 1,000 posts overall, so absence from it proves nothing. When the
  // surface can hydrate (messagingApi.loadChannelLanding) the exact source is read
  // under the member's own row security. `landing` is the one-shot instruction for
  // the open thread dialog, `landed` the hydrated { threadId, thread, post } (kept
  // here, never in the shared dialog value, so no post text enters the parity
  // store), and `landingStatus` how the request stands: null | "loading" |
  // "unavailable" | "failed". A superseded answer (a newer instruction, a manual
  // open, another tab, a different reader, an unmount) is dropped by run number.
  const [landing, setLanding] = useState(null);
  const [landed, setLanded] = useState(null);
  const [landingStatus, setLandingStatus] = useState(null);
  const landingRun = useRef(0);
  const landingTarget = useRef(null);
  const linkedThreadHandled = useRef(null);
  const cancelLanding = useCallback(() => {
    landingRun.current += 1;
    setLanding(null);
    setLandingStatus(null);
  }, []);
  const openDialog = useCallback((next) => {
    if (destructiveDialogLockRef.current) return;
    cancelLanding();
    setDialog(next);
  }, [cancelLanding, setDialog]);
  // REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001: per-channel notification
  // choices, pinning, mentions and mention search. No client (preview, or no
  // organization) means no control is offered at all.
  const channelApi = useMemo(() => createChannelControlsApi(channelControlsClient), [channelControlsClient]);
  const channelScope = `${data.member?.id || ""}:${data.member?.organizationId || ""}:${data.member?.chapterId || ""}`;
  const { controls: channelControls, applySetting: applyChannelSetting } = useChannelControls(channelApi, channelScope);
  // Server-confirmed pin changes, applied over the loaded snapshot until the
  // next refresh carries them.
  const [pinOverrides, setPinOverrides] = useState({});
  const [pinBusy, setPinBusy] = useState(false);
  const sourceProduct = data.product;
  const product = useMemo(() => {
    if (!sourceProduct) return {};
    if (Object.keys(pinOverrides).length === 0) return sourceProduct;
    return {
      ...sourceProduct,
      spaces: (sourceProduct.spaces || []).map((space) => ({
        ...space,
        threads: (space.threads || []).map((thread) => Object.prototype.hasOwnProperty.call(pinOverrides, thread.id)
          ? { ...thread, pinned_at: pinOverrides[thread.id] }
          : thread),
      })),
    };
  }, [pinOverrides, sourceProduct]);
  const toggleThreadPin = useCallback(async (thread, pinned) => {
    if (!channelApi || pinBusy) return;
    setPinBusy(true);
    try {
      const result = await channelApi.setPinned(thread.id, pinned);
      setPinOverrides((current) => ({ ...current, [thread.id]: result?.pinnedAt ?? null }));
      onNotice(t(pinned ? "channelControls.pinned" : "channelControls.unpinned"));
    } catch {
      onNotice(t("channelControls.pinFailed"));
    } finally {
      setPinBusy(false);
    }
  }, [channelApi, onNotice, pinBusy, t]);
  const loadedThreads = useMemo(() => (product.spaces || []).flatMap((space) => space.threads || []), [product.spaces]);
  const selectedThread = dialog?.type === "threadDetail"
    ? loadedThreads.find((thread) => thread.id === dialog.thread.id)
      || (landed?.threadId === dialog.thread.id ? landed.thread : null)
      || dialog.thread
    : null;
  const readSpaceId = selectedThread?.space_id;
  useEffect(() => {
    if (readSpaceId && onReadSpace) Promise.resolve(onReadSpace(readSpaceId)).catch(() => {});
    // A changing refresh callback must not write another cursor on each load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readSpaceId]);

  const selectedIntake = dialog?.type === "intakeTriage"
    ? (product.intake || []).find((item) => item.id === dialog.reportId) || dialog.report
    : null;
  const canStaff = staffAccess ?? (data.roles || []).some((role) => STAFF_ROLES.has(role));
  const knowledgeDriveOperationAccess = canStaff
    && (data.member?.organizationRoles || []).some((role) => DRIVE_OPERATION_ROLES.has(role));
  const knowledgeStaff = knowledgeStaffAccess ?? canStaff;
  const knowledgeIdentityScope = `${data.member?.id || ""}:${data.member?.organizationId || ""}:${data.member?.chapterId || ""}:${knowledgeStaff ? "staff" : "member"}`;
  const selectedKnowledgeChapterId = knowledgeReviewScope.scopeKey === knowledgeIdentityScope
    ? knowledgeReviewScope.chapterId
    : "";
  const knowledgeChapterId = knowledgeStaff
    ? selectedKnowledgeChapterId || data.member?.chapterId || ""
    : "";
  const knowledgeScope = `${knowledgeIdentityScope}:${knowledgeChapterId}:${knowledgeRefreshEpoch}`;
  const {
    articles: knowledgeArticles,
    phase: knowledgePhase,
  } = useAccessibleKnowledgeArticles({
    client: knowledgeClient,
    enabled: tab === "library",
    fallbackArticles: product.compassKnowledge,
    publishedOnly: !canStaff,
    chapterId: knowledgeChapterId || null,
    scopeKey: knowledgeScope,
  });
  const invalidateKnowledgeSnapshot = useCallback(() => {
    setKnowledgeRefreshEpoch((current) => current + 1);
  }, []);
  const selectKnowledgeReviewChapter = useCallback((chapterId) => {
    setKnowledgeReviewScope({ scopeKey: knowledgeIdentityScope, chapterId: chapterId || "" });
  }, [knowledgeIdentityScope]);
  const refreshKnowledgeSurfaces = useCallback(async () => {
    // The workspace owns ingestion and revision actions, while this parent
    // owns the complete canonical corpus hook. Advance its request identity
    // as soon as a mutation completes, then refresh the boot snapshot too.
    invalidateKnowledgeSnapshot();
    if (onKnowledgeChanged) await onKnowledgeChanged();
  }, [invalidateKnowledgeSnapshot, onKnowledgeChanged]);
  const libraryProduct = knowledgeArticles === product.compassKnowledge
    ? product
    : { ...product, compassKnowledge: knowledgeArticles };
  const canTriageIntake = triageAccess ?? (data.roles || []).some((role) => ["steward", "coordinator"].includes(role));
  const focusDeepLinkHandled = useRef(null);
  const documentDeepLinkHandled = useRef(null);
  const intakeDeepLinkHandled = useRef(null);
  const driveCallbackHandled = useRef(false);
  const [driveOutcome, setDriveOutcome] = useState("");
  const tabs = ["organize", "voice", "library", "record", "partners", ...(canStaff && connectionActor ? ["connections"] : []), "governance"];
  // The handshake screen also lists catalogue offices with no chapter yet.
  const partnerChapterId = connectionActor?.chapterId || null;
  const partnerAdapter = useMemo(() => connectionClient ? createConnectionAdapter(connectionClient, connectionActor?.selectedHat) : null,
    [connectionClient, connectionActor?.selectedHat]);

  // Each deep link applies once per target id. Without the handled refs these
  // effects refired on every product object-identity refresh and replaced
  // whatever dialog was open — including a pending account deletion. A deep
  // link that arrives while the destructive lock is held is consumed and
  // dropped, never deferred: surfacing it after deletion resolves would be a
  // navigation the member no longer expects.
  //
  // BUG-UG-WEB-CHANNEL-FROM-MESSAGES-DOES-NOT-OPEN-THREAD-RECURRENCE-20261009:
  // the handed-over focus is LATCHED here and resolved below, because taking it
  // is what destroys it. The hub normalises its own address to the Topics tab
  // the moment it takes a focus, and App's navigate clears the focus with that
  // move, so a thread the loaded spaces do not carry yet got exactly one look:
  // this effect returned early and the intent was gone for good. A latched
  // intent survives the clear and is resolved by whichever comes first — the
  // snapshot that carries the thread, or the loader asked for that one thread.
  const [pendingFocus, setPendingFocus] = useState(null);
  useEffect(() => {
    if (!focus?.threadId) return;
    // The intent key carries the search nonce when one exists, so picking the
    // same result again is a NEW intent that applies (App's openSearchResult
    // contract: "The nonce lets the same result fire twice in a row"), while
    // a product refresh that only changes object identity is the SAME intent
    // and is skipped.
    const intent = focus.nonce ? `${focus.nonce}:${focus.threadId}` : focus.threadId;
    if (focusDeepLinkHandled.current === intent) return;
    // The latch remembers whose handoff it is and what was open when it came,
    // so a later reader, or a dialog or tab the member then chose by hand,
    // voids it instead of being replaced by it.
    const reader = data.member?.id ?? null;
    setPendingFocus((current) => current?.intent === intent
      ? current
      : { intent, threadId: focus.threadId, postId: focus.postId ?? null, reader, dialog: selectionRef.current.dialog, tab: selectionRef.current.tab });
  }, [data.member?.id, focus]);

  // What is open right now, readable from an async answer: a dialog opened, or a
  // tab chosen, by hand while a hydration was in flight supersedes it.
  const selectionRef = useRef({});
  selectionRef.current = { dialog, tab };
  const landedRef = useRef(null);
  landedRef.current = landed;
  useEffect(() => () => { landingRun.current += 1; }, []);
  // Hydrated rows are read under one reader's row security. When the signed-in
  // member changes, whatever is in flight is void, and nothing hydrated for the
  // previous reader may be shown to the next: not the rows, and not the thread
  // dialog that was opened from them.
  const readerId = data.member?.id ?? null;
  const readerRef = useRef(readerId);
  useEffect(() => {
    if (readerRef.current === readerId) return;
    readerRef.current = readerId;
    landingRun.current += 1;
    const open = selectionRef.current.dialog;
    if (open?.type === "threadDetail" && landedRef.current?.threadId === open.thread?.id) setDialog(null);
    setLanding(null);
    setLanded(null);
    setLandingStatus(null);
    // A handoff latched for the previous reader is void with everything else
    // that was read under her row security.
    setPendingFocus(null);
  }, [readerId, setDialog]);
  const hydrateThread = useCallback((threadTarget, postTarget) => {
    landingTarget.current = { threadId: threadTarget, postId: postTarget };
    const run = ++landingRun.current;
    const startedWith = selectionRef.current;
    setLandingStatus("loading");
    messagingApi.loadChannelLanding({ threadId: threadTarget, postId: postTarget ?? null }).then((result) => {
      if (run !== landingRun.current) return;
      const now = selectionRef.current;
      if (now.dialog !== startedWith.dialog || now.tab !== startedWith.tab) {
        setLandingStatus(null);
        return;
      }
      // Only the source the link named: an answer for another thread, or one that
      // omits the named post, is not this link's source.
      const thread = result?.thread;
      if (!thread || (threadTarget && thread.id !== threadTarget) || (postTarget && result.post?.id !== postTarget)) {
        setLandingStatus("unavailable");
        return;
      }
      if (destructiveDialogLockRef.current) {
        setLandingStatus(null);
        return;
      }
      setLanded({ threadId: thread.id, thread, post: result.post ?? null });
      setLandingStatus(null);
      setTab("organize");
      // The shared dialog value carries only the thread's frame, never its posts.
      setDialog({ type: "threadDetail", thread: { id: thread.id, space_id: thread.space_id, title: thread.title, kind: thread.kind, status: thread.status } });
      if (postTarget) setLanding({ threadId: thread.id, postId: postTarget });
    }).catch((error) => {
      if (run !== landingRun.current) return;
      setLandingStatus(isPermissionRefusal(error) || isSourceGone(error) ? "unavailable" : "failed");
    });
  }, [messagingApi, setDialog, setTab]);
  const retryLanding = useCallback(() => {
    const target = landingTarget.current;
    if (target && messagingApi?.loadChannelLanding) hydrateThread(target.threadId, target.postId);
  }, [hydrateThread, messagingApi]);
  // The latched handoff, resolved. The snapshot wins when it carries the thread;
  // otherwise the hub asks the server for that one thread, exactly as the
  // `?thread=` link does. With neither — no match and no loader — the intent
  // stays latched for the next snapshot rather than being dropped.
  useEffect(() => {
    if (!pendingFocus) return;
    // A newer handoff arriving in this same render replaces this one first.
    const incoming = focus?.threadId ? (focus.nonce ? `${focus.nonce}:${focus.threadId}` : focus.threadId) : null;
    if (incoming && incoming !== pendingFocus.intent && focusDeepLinkHandled.current !== incoming) return;
    // Another reader's handoff, a lock-time handoff, or one the member has
    // since moved past by hand is consumed and dropped, never deferred. The
    // hub's own move to the Topics tab is not a choice by hand. Re-run on every
    // dialog and tab change, so opening and closing a thread still voids it.
    const now = selectionRef.current;
    const superseded = pendingFocus.reader !== readerId
      || now.dialog !== pendingFocus.dialog
      || (now.tab !== pendingFocus.tab && now.tab !== "organize");
    if (superseded || destructiveDialogLockRef.current) {
      focusDeepLinkHandled.current = pendingFocus.intent;
      setPendingFocus(null);
      return;
    }
    const known = loadedThreads.find((thread) => thread.id === pendingFocus.threadId);
    if (!known && !messagingApi?.loadChannelLanding) return;
    focusDeepLinkHandled.current = pendingFocus.intent;
    setPendingFocus(null);
    if (!known) {
      hydrateThread(pendingFocus.threadId, pendingFocus.postId);
      return;
    }
    // This opening supersedes any link still being hydrated.
    cancelLanding();
    setTab("organize");
    setDialog({ type: "threadDetail", thread: known });
    setLanding(pendingFocus.postId ? { threadId: known.id, postId: pendingFocus.postId } : null);
  }, [cancelLanding, dialog, focus, hydrateThread, loadedThreads, messagingApi, pendingFocus, readerId, setDialog, setTab, tab]);
  // `?thread=<id>&post=<id>` (the channel-post source link) opens that exact
  // thread, hydrating it when the snapshot never carried it. Applied once per
  // intent; a link that arrives while the destructive lock is held is consumed
  // and dropped, like the other deep links; no hat is ever switched.
  // Applied when the hub mounts, and again when the address changes underneath it:
  // the app's navigate() does not remount a view that is already on screen.
  const routeSearch = typeof window === "undefined" ? "" : window.location.search;
  // #9524: React's development check (main.jsx renders under StrictMode)
  // unmounts and remounts the hub in one commit, and that unmount empties the
  // shared hub.dialog value the link just opened. Forget the applied intent on
  // unmount so the remount opens the link again.
  useEffect(() => () => { linkedThreadHandled.current = null; }, []);
  useEffect(() => {
    let params;
    try { params = new URLSearchParams(window.location.search); } catch { return; }
    const threadParam = params.get("thread");
    const postParam = params.get("post");
    if (!threadParam && !postParam) return;
    const intent = `${threadParam || ""}\u001f${postParam || ""}`;
    if (linkedThreadHandled.current === intent) return;
    const known = threadParam ? loadedThreads.find((thread) => thread.id === threadParam) : null;
    if (known) {
      linkedThreadHandled.current = intent;
      if (destructiveDialogLockRef.current) return;
      cancelLanding();
      // Already on Topics: moving the tab would push a new address without
      // the link's thread and post.
      if (selectionRef.current.tab !== "organize") setTab("organize");
      setDialog({ type: "threadDetail", thread: known });
      setLanding(postParam ? { threadId: known.id, postId: postParam } : null);
      return;
    }
    // Unknown here and no way to ask the server: leave the ordinary surface up and
    // wait for a later refresh, as the other deep links do.
    if (!messagingApi?.loadChannelLanding) return;
    linkedThreadHandled.current = intent;
    if (destructiveDialogLockRef.current) return;
    hydrateThread(threadParam, postParam);
  }, [cancelLanding, hydrateThread, loadedThreads, messagingApi, routeSearch, setDialog, setTab]);

  useEffect(() => {
    const documentId = new URLSearchParams(window.location.search).get("document");
    if (!documentId || documentDeepLinkHandled.current === documentId) return;
    const document = (product.documents || []).find((item) => item.id === documentId);
    if (!document) return;
    documentDeepLinkHandled.current = documentId;
    if (destructiveDialogLockRef.current) return;
    setTab("library");
    setDialog({ type: "documentDetail", document });
  }, [product.documents, setDialog, setTab]);

  useEffect(() => {
    const reportId = new URLSearchParams(window.location.search).get("intake");
    if (!reportId || intakeDeepLinkHandled.current === reportId) return;
    const report = (product.intake || []).find((item) => item.id === reportId);
    if (!report) return;
    intakeDeepLinkHandled.current = reportId;
    if (destructiveDialogLockRef.current) return;
    setTab("voice");
    if (canTriageIntake) setDialog({ type: "intakeTriage", reportId, report });
  }, [canTriageIntake, product.intake, setDialog, setTab]);

  useEffect(() => {
    if (driveCallbackHandled.current) return;
    try {
      const url = new URL(window.location.href);
      const outcome = url.searchParams.get("drive");
      if (outcome !== "connected" && outcome !== "failed") return;
      driveCallbackHandled.current = true;
      setDriveOutcome(outcome);
      setTab("library");
      url.searchParams.delete("drive");
      const search = url.searchParams.toString();
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${search ? `?${search}` : ""}${url.hash}`,
      );
    } catch {
      // A malformed callback URL leaves the ordinary persisted hub tab intact.
    }
  }, [setTab]);

  const sectionTabs = (
    <>
      {/* aria-pressed, not a tab role — see AuthScreen.jsx. Six section
          switches over one region, with no arrow-key model behind them. */}
      <div className="hub2-tabs" role="group" aria-label={t("hub.sections")}>
        {tabs.map((id) => {
          const Icon = TAB_ICONS[id];
          return <RoutedTabLink group="hub" value={id} type="button" className="hub2-tab" aria-pressed={tab === id} key={id} onClick={() => setTab(id)}><Icon size={15} />{id === "connections" ? network("connections") : t(`hub.tab.${id}`)}</RoutedTabLink>;
        })}
      </div>
    </>
  );
  const sections = (
    <>
      {/* A link that names a thread or post this hub cannot show says so, instead
          of leaving the ordinary hub up as if the link had worked. */}
      {landingStatus && (
        <div className="hub2-landing-notice" role={landingStatus === "loading" ? "status" : "alert"}>
          <strong>{t(`linkedSource.${landingStatus}`)}</strong>
          {landingStatus !== "loading" && (
            <div className="hub2-landing-notice__actions">
              {landingStatus === "failed" && <button type="button" className="hub2-btn hub2-btn--ghost" onClick={retryLanding}>{t("linkedMessage.retry")}</button>}
              <button type="button" className="hub2-btn hub2-btn--ghost" onClick={cancelLanding}>{t("linkedMessage.dismiss")}</button>
            </div>
          )}
        </div>
      )}

      <div className="hub2-body">
        {tab === "organize" && channelApi && channelControls.switches.mentionSearch && (
          <MentionSearchPanel t={t} lang={lang} api={channelApi}
            onRemind={messagingApi?.remind ? (hit, remindAt) => messagingApi.remind("channel", hit.postId, remindAt) : null}
            onOpenPost={(hit) => {
            const known = loadedThreads.find((thread) => thread.id === hit.threadId);
            if (known) {
              openDialog({ type: "threadDetail", thread: known });
              setLanding({ threadId: known.id, postId: hit.postId });
            } else if (messagingApi?.loadChannelLanding) {
              hydrateThread(hit.threadId, hit.postId);
            }
          }} />
        )}
        {tab === "organize" && <>{leadershipApi && <ChapterLeadershipRecoveryCard api={leadershipApi} onOpenSettings={onOpenSettings} />}<OrganizePanel product={product} canStaff={canStaff} canCreateThread={canStaff} t={t} onOpen={openDialog} channelControls={channelApi ? channelControls : null} /></>}
        {tab === "voice" && <VoicePanel product={product} canTriage={canTriageIntake} t={t} onOpen={openDialog} />}
        {tab === "library" && <>
          <UnionNetworkNav current="resources" staff={canStaff} admin={connectionActor?.selectedHat === "admin"} />
          <LibraryPanel product={libraryProduct} canStaff={canStaff} knowledgePhase={knowledgePhase} t={t} onOpen={openDialog} />
          {(knowledgeClient || preview) && <KnowledgeWorkspacePanel
            key={`knowledge-workspace:${knowledgeIdentityScope}`}
            client={knowledgeClient}
            organizationId={data.member?.organizationId || null}
            canStaff={knowledgeStaff}
            canAdmin={knowledgeAdminAccess}
            canDriveOperate={knowledgeDriveOperationAccess}
            canHealth={knowledgeHealthAccess}
            articles={knowledgeArticles}
            driveOutcome={driveOutcome}
            onKnowledgeChanged={refreshKnowledgeSurfaces}
            collectionChapterId={knowledgeChapterId}
            reviewChapterId={selectedKnowledgeChapterId}
            onReviewChapterChange={selectKnowledgeReviewChapter}
          />}
        </>}
        {tab === "record" && (institutionalClient
          ? <>
              <InstitutionalRecordsPanel key={`records:${data.member?.id}:${channelScope}:${connectionActor?.selectedHat}`} client={institutionalClient} fallbackRecords={product.records || []} canStaff={canStaff || ["secretary", "records"].includes(selectedChapterOfficeRole(data.roles, connectionActor?.selectedHat))} onNotice={onNotice} openIntent={notificationOpenIntent} />
              {["admin", "vp"].includes(connectionActor?.selectedHat) && <ChapterAccessPanel key={`access:${data.member?.id}:${channelScope}`} client={institutionalClient} chapterId={data.member?.chapterId} />}
              <ChapterOfficeRoleChoice roles={data.roles} selectedHat={connectionActor?.selectedHat} onSelect={onSelectOfficeRole} />
              {/* REQ-UG-CHAPTER-NOTICE-GLOW-COLOURS-20261113 (#8627): the chapter's notice colour, offered
                  only when the server says this person can publish the chapter's announcements. */}
              {(canStaff || ["secretary", "records"].includes(selectedChapterOfficeRole(data.roles, connectionActor?.selectedHat))) && <NoticeGlowControl key={`notice-glow:${data.member?.id}:${channelScope}:${connectionActor?.selectedHat}`} client={institutionalClient} chapterId={data.member?.chapterId} />}
              {(canStaff || ["secretary", "records"].includes(selectedChapterOfficeRole(data.roles, connectionActor?.selectedHat))) && <ChapterOfficePanel key={`office:${data.member?.id}:${channelScope}:${connectionActor?.selectedHat}`} client={institutionalClient} chapterId={data.member?.chapterId} role={selectedChapterOfficeRole(data.roles, connectionActor?.selectedHat)} onNotice={onNotice} />}
              <ChapterFinancePanel key={`finance:${data.member?.id}:${channelScope}:${connectionActor?.selectedHat}`} client={institutionalClient}
                scope={{ organizationId: data.member?.organizationId, chapterId: data.member?.chapterId }} memberId={data.member?.id}
                canAuthor={["admin", "treasurer"].includes(connectionActor?.selectedHat)} />
              <ChapterBudgetPanel key={`budget:${channelScope}:${connectionActor?.selectedHat}`} client={institutionalClient}
                canAuthor={["admin", "vp", "treasurer"].includes(connectionActor?.selectedHat)}
                scope={{ organizationId: data.member?.organizationId, chapterId: data.member?.chapterId }} />
              {/* Secretary-Treasurers hold no staff hat: their member directory
                  and export sit beside the budget their office opens. Renders
                  nothing unless the database grants the read. */}
              <OfficerMemberDirectory key={`directory:${channelScope}`} client={institutionalClient} />
            </>
          : <RecordPanel product={product} canStaff={canStaff} t={t} onOpen={openDialog} />)}
        {tab === "partners" && <><UnionNetworkNav current="handshakes" staff={canStaff} admin={connectionActor?.selectedHat === "admin"} /><PartnersPanel product={product} canStaff={canStaff} currentChapterId={data.member?.chapterId} preview={preview} t={t} onOpen={openDialog} onUpdateHandshake={onUpdateHandshake} />
          {canStaff && partnerChapterId && (partnerAdapter || connectionPreview) && <PartnerOffices key={partnerChapterId} adapter={partnerAdapter} chapterId={partnerChapterId} selectedHat={connectionActor?.selectedHat} lang={lang} preview={connectionPreview} />}</>}
        {tab === "connections" && canStaff && connectionActor && <ConnectionSuggestions client={connectionClient} actor={connectionActor} preview={connectionPreview} lang={lang} organizationConfiguration={data?.organizationConfiguration ?? null} />}
        {tab === "governance" && <GovernancePanel product={product} t={t} onOpen={openDialog} onGenerateDataExport={onGenerateDataExport} onRetry={onRetryGovernance} />}
      </div>
    </>
  );
  const dialogs = (
    <>
      {dialog?.type === "channelSettings" && channelApi && (
        <ChannelSettingsDialog t={t} lang={lang} space={dialog.space} controls={channelControls} api={channelApi} onSaved={applyChannelSetting} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === "space" && <SpaceDialog t={t} onClose={() => setDialog(null)} onSave={onCreateSpace} />}
      {dialog?.type === "spaceEdit" && <SpaceDialog t={t} item={dialog.item} onClose={() => setDialog(null)} onSave={(fields) => onUpdateSpace(dialog.item.id, spanishSpaceEdit(fields, dialog.item), false)} onArchive={() => onUpdateSpace(dialog.item.id, dialog.item, true)} />}
      {dialog?.type === "spaceMembers" && <SpaceMembersOpen t={t} space={dialog.space} onClose={() => setDialog(null)} onList={onListSpaceMembers} onSearch={onSearchSpaceMembers} onSet={onSetSpaceMember} />}
      {dialog?.type === "thread" && <ThreadDialog t={t} spaces={product.spaces || []} initialSpaceId={dialog.spaceId} onClose={() => setDialog(null)} onSave={onCreateThread} />}
      {/* onCreateTask is passed only to staff. Chapter tasks are a staff-only
          surface (owner decision, 2026-07-27) and the insert policy behind it
          is staff-only too, so an ungated button offered every member an action
          the database would refuse — and refused it AFTER they had written a
          thread reply and pressed it. Gating at the prop rather than inside the
          dialog keeps the check in one place with the other five. */}
      {dialog?.type === "threadDetail" && (
        <ThreadDetail
          key={selectedThread?.id}
          t={t}
          thread={selectedThread}
          currentUserId={data.member?.id}
          onClose={() => setDialog(null)}
          onSend={onSendPost}
          onCreateTask={canStaff ? onCreateTask : null}
          workstream={(data.workstreams || [])[0]?.name || FALLBACK_WORKSTREAM}
          messagingApi={messagingApi}
          renderConnectedActions={renderConnectedActions}
          focusPostId={landing?.threadId === selectedThread?.id ? landing.postId : null}
          landedPost={landed?.threadId === selectedThread?.id ? landed.post : null}
          onNotice={onNotice}
          actorId={data.member?.id}
          pulse={preview ? null : pulse}
          remindHereHint={canStaff && Boolean(messagingApi?.remindHere) && isFeatureEnabled(data?.organizationConfiguration, REMIND_HERE_SWITCH, true)}
          channelApi={channelApi}
          channelControls={channelControls}
          onTogglePin={channelApi && channelControls.canPin ? toggleThreadPin : null}
          pinBusy={pinBusy}
          mentionStaffScope={(data.roles || []).some((role) => MENTION_STAFF_ROLES.has(role))}
          membersSpace={canStaff ? (product.spaces || []).find((space) => space.id === selectedThread?.space_id && space.visibility === "private") || null : null}
          onListSpaceMembers={onListSpaceMembers}
          onSearchSpaceMembers={onSearchSpaceMembers}
          onSetSpaceMember={onSetSpaceMember}
        />
      )}
      {dialog?.type === "intake" && <IntakeDialog t={t} onClose={() => setDialog(null)} onSave={onCreateIntake} />}
      {dialog?.type === "intakeTriage" && selectedIntake && (
        <IntakeTriageDialog
          report={selectedIntake}
          owners={data.intakeOwners || []}
          spaces={product.spaces || []}
          t={t}
          onClose={() => setDialog(null)}
          onTriage={onTriageIntake}
          onConvert={onConvertIntake}
        />
      )}
      {dialog?.type === "document" && <DocumentDialog t={t} onClose={() => setDialog(null)} onSave={onCreateDocument} />}
      {dialog?.type === "documentDetail" && <DocumentDetail document={dialog.document} t={t} canStaff={canStaff} onEdit={() => setDialog({ type: "documentEdit", item: dialog.document })} onClose={() => setDialog(null)} />}
      {dialog?.type === "documentEdit" && <DocumentDialog t={t} item={dialog.item} onClose={() => setDialog(null)} onSave={(fields) => onUpdateDocument(dialog.item.id, fields, "save")} onRepublish={(fields) => onUpdateDocument(dialog.item.id, fields, "republish")} onArchive={(fields) => onUpdateDocument(dialog.item.id, fields, "archive")} />}
      {dialog?.type === "knowledge" && <KnowledgeDialog
        article={dialog.article || null}
        chapterId={dialog.article?.chapterId || knowledgeChapterId || null}
        preview={preview}
        t={t}
        onClose={() => setDialog(null)}
        onSave={async (fields) => {
          const saved = await onSaveKnowledge(fields);
          invalidateKnowledgeSnapshot();
          return saved;
        }}
        onRetire={async (articleId, chapterId) => {
          const retired = await onRetireKnowledge(articleId, chapterId);
          invalidateKnowledgeSnapshot();
          return retired;
        }}
      />}
      {dialog?.type === "record" && <RecordDialog t={t} onClose={() => setDialog(null)} onSave={onCreateRecord} />}
      {dialog?.type === "recordEdit" && <RecordDialog t={t} item={dialog.item} onClose={() => setDialog(null)} onSave={(fields) => onUpdateRecord(dialog.item.id, fields, false)} onArchive={() => onUpdateRecord(dialog.item.id, { recordType: dialog.item.record_type, title: dialog.item.title, body: dialog.item.body, occurredAt: dialog.item.occurred_at }, true)} />}
      {dialog?.type === "handshake" && <HandshakeDialog t={t} orgs={product.partnerOrgs || []} onClose={() => setDialog(null)} onSave={onCreateHandshake} />}
      {dialog?.type === "governance" && <GovernanceDialog t={t} onClose={() => setDialog(null)} onSave={onCreateGovernance} />}
      {dialog?.type === "deleteAccount" && <DeleteAccountDialog t={t} onClose={() => setDialog(null)} onDelete={onDeleteAccount} passwordReauth={deletionPasswordReauth} onIndeterminateClose={onDeleteIndeterminateClose} onDestructiveLockChange={setDestructiveDialogLock} sessionHold={sessionHold} />}
    </>
  );

  if (alt) {
    return (
      <>
        <AltChapterPage
          data={data}
          product={product}
          chapterSwitch={chapterSwitch}
          onOpenThread={(thread) => openDialog({ type: "threadDetail", thread })}
          onOpenDocument={(document) => openDialog({ type: "documentDetail", document })}
          onAssistant={onAssistant}
          onOpenHome={onOpenHome}
          workspace={<div className="hub2 ug-rec-hub">{sectionTabs}{sections}</div>}
        />
        <div className="ug-legacy">{dialogs}</div>
      </>
    );
  }

  return (
    <div className="screen hub2">
      <header className="hub2-ph">
        <div className="hub2-ph__copy">
          {/* #9527: named as the worn hat's rail names it: Organize under a staff
              hat, My chapter (the name an organization can rename) for Member. */}
          <h1 className="hub2-ph__title">{t(staffAccess ? "hub.title" : "nav.myChapter")}</h1>
          <p className="hub2-ph__sub">{t("hub2.sub")}</p>
        </div>
        {onAssistant && (
          <button type="button" className="hub2-ph__assist" aria-label={t("header.assistant")} onClick={onAssistant}>
            <Bot size={18} />
          </button>
        )}
      </header>
      {chapterSwitch}
      {sectionTabs}
      {sections}
      {dialogs}
    </div>
  );
}

function PanelHead({ title, sub, action, onAction }) {
  return (
    <div className="hub2-panel-head">
      <div className="hub2-panel-head__copy">
        <h2 className="hub2-panel-head__title">{title}</h2>
        <p className="hub2-panel-head__sub">{sub}</p>
      </div>
      {onAction && <button type="button" className="hub2-btn hub2-btn--primary" onClick={onAction}><Plus size={15} />{action}</button>}
    </div>
  );
}

function OrganizePanel({ product, canStaff, canCreateThread, t, onOpen, channelControls = null }) {
  const { lang } = useLang();
  const pinningOn = Boolean(channelControls?.switches.channelPinning);
  return <section className="hub2-panel">
    <PanelHead title={t("hub.organize.title")} sub={t("hub.organize.sub")} action={t("hub.newSpace")} onAction={canStaff ? () => onOpen({ type: "space" }) : null} />
    {/* REQ-UG-FIRST-CLICK-AND-DEAD-CONTROLS-20261030: an officer
        acting as Member saw New space and New thread vanish once spaces
        existed, with no way back; the switch stays offered above the list. */}
    {(product.spaces || []).length > 0 && !canStaff && <StaffAuthoringHint item="spaces" buttonClassName="hub2-btn hub2-btn--ghost" wearableOnly />}
    {(product.spaces || []).length === 0 ? <EmptyState><strong>{t("hub.emptySpaces")}</strong><p>{t("hub.emptySpacesBody")}</p>{!canStaff && <StaffAuthoringHint item="spaces" buttonClassName="hub2-btn hub2-btn--ghost" />}</EmptyState> :
      product.spaces.map((space) => <article className="hub2-card hub2-card--flush" key={space.id}>
        <div className="hub2-card__head">
          <span className="hub2-card__headtitle">{spaceName(space, lang)}</span>
          <span className="hub2-chip hub2-chip--neutral">{hubEnumLabel(t, "visibility", space.visibility)}</span>
          {channelControls && isMuteActive(channelSettingFor(channelControls, space.id)) && <span className="hub2-chip hub2-chip--neutral"><BellOff size={12} aria-hidden="true" />{t("channelControls.mutedChip")}</span>}
          <span className="hub2-card__headmeta">{t(countKey("hub2.threads", space.threads?.length || 0), { n: space.threads?.length || 0 })}</span>
        </div>
        {spaceDescription(space, lang) && <p className="hub2-card__desc">{spaceDescription(space, lang)}</p>}
        {/* A space opens through its threads; an empty one says so instead
            of looking like a card that ignores clicks. */}
        {!(space.threads || []).length && <p className="hub2-card__desc">{t("hub.spaceNoThreads")}</p>}
        {orderThreadsForChannel(space.threads || [], pinningOn).map((thread) =>
          <button type="button" className="hub2-rowbtn" key={thread.id} onClick={() => onOpen({ type: "threadDetail", thread })}>
            <span className="hub2-rowbtn__main">
              <span className="hub2-rowbtn__title">{pinningOn && thread.pinned_at && <span className="hub2-chip hub2-chip--amber"><Pin size={11} aria-hidden="true" />{t("channelControls.pinnedChip")}</span>}{thread.title}</span>
              <span className="hub2-rowbtn__meta">{hubEnumLabel(t, "threadKind", thread.kind)} · {hubEnumLabel(t, "threadStatus", thread.status)}</span>
            </span>
            <b className="hub2-rowbtn__count">{thread.posts?.length || 0}</b>
          </button>)}
        <div className="hub2-card__foot">
          {canCreateThread && <button type="button" className="hub2-btn hub2-btn--ghost" onClick={() => onOpen({ type: "thread", spaceId: space.id })}>{t("hub.newThread")}</button>}
          {channelHasAnyControl(channelControls) && <button type="button" className="hub2-btn hub2-btn--ghost" aria-label={t("channelControls.openFor", { name: spaceName(space, lang) })} onClick={() => onOpen({ type: "channelSettings", space: { id: space.id, name: space.name } })}><Bell size={14} aria-hidden="true" />{t("channelControls.open")}</button>}
          {canStaff && <button type="button" className="hub2-btn hub2-btn--ghost" onClick={() => onOpen({ type: "spaceEdit", item: space })}>{t("hub.edit")}</button>}
          {canStaff && space.visibility === "private" && <button type="button" className="hub2-btn hub2-btn--ghost" onClick={() => onOpen({ type: "spaceMembers", space })}>{t("hub.manageMembers")}</button>}
        </div>
      </article>)}
  </section>;
}

function intakeOutcome(item, t) {
  if (item.case_id) return t("hub.intake.outcome.case");
  if (item.task_id) return t("hub.intake.outcome.task");
  if (item.thread_id) return t("hub.intake.outcome.thread");
  return "";
}

function VoicePanel({ product, canTriage, t, onOpen }) {
  return <section className="hub2-panel">
    <PanelHead title={t("hub.voice.title")} sub={t("hub.voice.sub")} action={t("hub.report")} onAction={() => onOpen({ type: "intake" })} />
    {(product.intake || []).map((item) => <article className={`hub2-thread${chipTone(item.status) === "terra" ? " hub2-thread--hot" : ""}`} key={item.id}>
      <div className="hub2-thread__top">
        <span className={`hub2-chip hub2-chip--${chipTone(item.status)}`}>{t(`hub.intake.status.${item.status}`)}</span>
        <span className="hub2-thread__title">{item.title}</span>
        <span className="hub2-thread__spacer" />
        <span className="hub2-thread__meta">{hubEnumLabel(t, "intakeCategory", item.category)} · <HubTimestamp value={item.created_at} /></span>
      </div>
      <p className="hub2-thread__body">{item.details}</p>
      {(canTriage || intakeOutcome(item, t)) && <div className="hub2-intake__actions">
        {intakeOutcome(item, t) && <span className="hub2-intake__outcome">{intakeOutcome(item, t)}</span>}
        {canTriage && <button type="button" className="hub2-btn hub2-btn--ghost" onClick={() => onOpen({ type: "intakeTriage", reportId: item.id, report: item })}>{t("hub.intake.triage")}</button>}
      </div>}
    </article>)}
    {(product.intake || []).length === 0 && <EmptyState><strong>{t("hub.emptyIntake")}</strong><p>{t("hub.emptyIntakeBody")}</p></EmptyState>}
  </section>;
}

function IntakeTriageDialog({ report, owners, spaces, t, onClose, onTriage, onConvert }) {
  const [status, setStatus] = useState(report.status || "new");
  const [assignedTo, setAssignedTo] = useState(report.assigned_to || "");
  const [spaceId, setSpaceId] = useState(spaces[0]?.id || "");
  const [busy, setBusy] = useState("");
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState("");
  const outcome = intakeOutcome(report, t);

  useEffect(() => {
    setStatus(report.status || "new");
    setAssignedTo(report.assigned_to || "");
  }, [report.assigned_to, report.status]);

  function save(event) {
    return runBusyWrite(busyWriteRef, "triage", (unlock) => saveNow(event, unlock), event);
  }

  async function saveNow(event, unlock) {
    event.preventDefault();
    setBusy("triage");
    setError("");
    try {
      await onTriage(report.id, { status, assignedTo: assignedTo || null });
    } catch (nextError) {
      setError(rpcErrorKeyStrict(nextError, "hub.intake.error"));
    } finally {
      setBusy("");
      unlock();
    }
  }

  function convert(target) {
    return runBusyWrite(busyWriteRef, "triage", (unlock) => convertNow(target, unlock));
  }

  async function convertNow(target, unlock) {
    setBusy(target);
    setError("");
    try {
      await onConvert(report.id, target, target === "thread" ? spaceId : null);
      onClose();
    } catch (nextError) {
      setError(rpcErrorKeyStrict(nextError, "hub.intake.error"));
    } finally {
      setBusy("");
      unlock();
    }
  }

  return <Dialog eyebrow={t("hub.intake.eyebrow")} title={report.title} onClose={onClose} wide>
    <p className="hub2-intake__detail">{report.details}</p>
    <form className="stack-form hub2-intake__triage" onSubmit={save}>
      <label>{t("hub.intake.status")}
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          {['new', 'triaged', 'in_progress', 'closed'].map((value) => <option value={value} key={value}>{t(`hub.intake.status.${value}`)}</option>)}
        </select>
      </label>
      <label>{t("hub.intake.owner")}
        <select value={assignedTo} onChange={(event) => setAssignedTo(event.target.value)}>
          <option value="">{t("hub.intake.unassigned")}</option>
          {owners.map((owner) => <option value={owner.id} key={owner.id}>{owner.fullName}</option>)}
        </select>
      </label>
      <BusyButton className="dialog-primary" pending={Boolean(busy)}>{busy === "triage" ? t("hub.intake.saving") : t("hub.intake.saveTriage")}</BusyButton>
    </form>
    <section className="hub2-intake__convert" aria-labelledby="intake-convert-title">
      <h3 id="intake-convert-title">{t("hub.intake.convert")}</h3>
      {outcome ? <p className="hub2-intake__outcome">{outcome}</p> : <>
        <p>{t("hub.intake.convertHelp")}</p>
        <div className="hub2-intake__convert-grid">
          <BusyButton type="button" className="hub2-btn hub2-btn--primary" pending={Boolean(busy)} onClick={() => convert("case")}>{busy === "case" ? t("hub.intake.converting") : t("hub.intake.toCase")}</BusyButton>
          <BusyButton type="button" className="hub2-btn hub2-btn--primary" pending={Boolean(busy)} onClick={() => convert("task")}>{busy === "task" ? t("hub.intake.converting") : t("hub.intake.toTask")}</BusyButton>
        </div>
        <label className="hub2-intake__space">{t("hub.intake.threadSpace")}
          <select value={spaceId} onChange={(event) => setSpaceId(event.target.value)}>
            {spaces.map((space) => <option value={space.id} key={space.id}>{space.name}</option>)}
          </select>
        </label>
        <BusyButton type="button" className="hub2-btn hub2-btn--primary" pending={Boolean(busy)} disabled={!spaceId} onClick={() => convert("thread")}>{busy === "thread" ? t("hub.intake.converting") : t("hub.intake.toThread")}</BusyButton>
        {!spaces.length && <p className="hub2-intake__hint">{t("hub.intake.noSpaces")}</p>}
      </>}
    </section>
    {error && <p className="form-error" role="alert">{rpcErrorTextAtRender(t, error)}</p>}
  </Dialog>;
}

function LibraryPanel({ product, canStaff, knowledgePhase = "fallback", t, onOpen }) {
  const groups = useMemo(() => (product.documents || []).reduce((result, item) => {
    (result[item.document_type] ||= []).push(item);
    return result;
  }, {}), [product.documents]);
  const knowledge = product.compassKnowledge || [];
  const publishedCount = knowledge.filter((article) => article.status === "published" && !article.isSample).length;
  return <section className="hub2-panel">
    <PanelHead title={t("hub.library.title")} sub={t("hub.library.sub")} action={t("hub.newDocument")} onAction={canStaff ? () => onOpen({ type: "document" }) : null} />
    {Object.entries(groups).map(([type, docs]) => <article className="hub2-card hub2-card--flush" key={type}>
      <div className="hub2-card__head"><span className="hub2-card__headtitle hub2-cap">{hubEnumLabel(t, "documentType", type)}</span></div>
      {docs.map((document) =>
        <button type="button" className="hub2-rowbtn" key={document.id} onClick={() => onOpen({ type: "documentDetail", document })}>
          <span className="hub2-rowbtn__main">
            <span className="hub2-rowbtn__title">{document.title}</span>
            <span className="hub2-rowbtn__meta">v{document.version} · {hubEnumLabel(t, "documentStatus", document.status)}</span>
            {document.summary && <span className="hub2-rowbtn__sum">{document.summary}</span>}
          </span>
        </button>)}
    </article>)}
    {(product.documents || []).length === 0 && <EmptyState><strong>{t("hub.emptyLibrary")}</strong><p>{t("hub.emptyLibraryBody")}</p>{!canStaff && <StaffAuthoringHint item="library" buttonClassName="hub2-btn hub2-btn--ghost" />}</EmptyState>}
    <div className="hub2-panel-head hub2-knowledge-head">
      <div className="hub2-panel-head__copy">
        <h2 className="hub2-panel-head__title">{t("hub.knowledge.title")}</h2>
        <p className="hub2-panel-head__sub">{t("hub.knowledge.sub")}</p>
      </div>
      {canStaff && <button type="button" className="hub2-btn hub2-btn--primary hub2-knowledge-action" onClick={() => onOpen({ type: "knowledge" })}><Plus size={15} />{t("hub.knowledge.add")}</button>}
    </div>
    {knowledgePhase === "loading" && <p className="hub2-panel-head__sub" role="status">{t("hub.knowledge.loading")}</p>}
    {knowledgePhase === "error" && <p className="form-error" role="alert">{t("hub.knowledge.loadError")}</p>}
    {knowledge.length > 0 && <article className="hub2-card hub2-card--flush">
      <div className="hub2-card__head">
        <span className="hub2-card__headtitle">{t("hub.knowledge.sources")}</span>
        <span className="hub2-card__headmeta">{t("hub.knowledge.publishedCount", { n: publishedCount })}</span>
      </div>
      {knowledge.map((article) => {
        const content = <>
          <span className="hub2-rowbtn__main">
            <span className="hub2-rowbtn__title">{article.title}</span>
            <span className="hub2-rowbtn__meta">{article.ref} · {t("hub.version", { n: article.version })}</span>
          </span>
          {article.isSample && <span className="hub2-chip hub2-chip--neutral">{t("hub.knowledge.sample")}</span>}
          <StatusChip status={article.status} />
        </>;
        return canStaff
          ? <button type="button" className="hub2-rowbtn" key={article.id} onClick={() => onOpen({ type: "knowledge", article })}>{content}</button>
          : <div className="hub2-rowbtn hub2-rowbtn--static" key={article.id}>{content}</div>;
      })}
    </article>}
    {knowledge.length === 0 && knowledgePhase !== "loading" && knowledgePhase !== "error" && <EmptyState><strong>{t("hub.knowledge.empty")}</strong><p>{t(canStaff ? "hub.knowledge.emptyStaff" : "hub.knowledge.emptyMember")}</p></EmptyState>}
  </section>;
}

const HANDSHAKE_ACTIONS = {
  draft: [{ status: "requested", labelKey: "hub.handshake.send" }],
  requested: [
    { status: "accepted", labelKey: "hub.handshake.accept" },
    { status: "declined", labelKey: "hub.handshake.decline", ghost: true },
  ],
  accepted: [{ status: "active", labelKey: "hub.handshake.activate" }],
  active: [{ status: "closed", labelKey: "hub.handshake.close", ghost: true }],
};

function liveHandshakeActions(item, currentChapterId) {
  if (!currentChapterId) return [];
  if (item.status === "requested" && item.receiving_chapter_id === currentChapterId) {
    return HANDSHAKE_ACTIONS.requested;
  }
  if (item.status === "accepted" && item.chapter_id === currentChapterId) {
    return HANDSHAKE_ACTIONS.accepted;
  }
  if (item.status === "active" && [item.chapter_id, item.receiving_chapter_id].includes(currentChapterId)) {
    return HANDSHAKE_ACTIONS.active;
  }
  return [];
}

// UX-UG-WEB-HANDSHAKE-RECEIVING-CHAPTER-SEES-SENDER-WAITING-LINE-20260920:
// the line under a requested handshake is viewer-relative. The chapter whose id
// is receiving_chapter_id is the one liveHandshakeActions hands Accept and
// Decline to, so it must not read that it is waiting on the partner. A preview
// fixture and a session with no chapter of its own keep the sender's line,
// which is what the row's own status says.
function requestedHandshakeLineKey(item, currentChapterId, preview) {
  return !preview && currentChapterId && item.receiving_chapter_id === currentChapterId
    ? "hub.handshake.countersign"
    : "hub.handshake.waiting";
}

// The legacy callback seam remains for preview fixtures and isolated component
// consumers. Live JWT-backed sessions use InstitutionalRecordsPanel above, so
// lifecycle/version/dispatch/contact/export writes cannot bypass its RPCs.
function RecordPanel({ product, canStaff, t, onOpen }) {
  const records = product.records || [];
  return <section className="hub2-panel">
    <PanelHead title={t("hub.record.title")} sub={t("hub.record.sub")} action={t("hub.newRecord")} onAction={canStaff ? () => onOpen({ type: "record" }) : null} />
    {records.length > 0 && <article className="hub2-card">
      <div className="hub2-tl">
        {records.map((item, index) => <div className="hub2-tl__row" key={item.id}>
          <div className="hub2-tl__rail">
            <span className={`hub2-tl__dot${index === 0 ? " hub2-tl__dot--latest" : ""}`} aria-hidden="true" />
            {index < records.length - 1 && <span className="hub2-tl__line" aria-hidden="true" />}
          </div>
          <div className="hub2-tl__cell">
            <div className="hub2-tl__title"><HubTimestamp value={item.occurred_at} /> · {item.title}</div>
            <div className="hub2-tl__type">{hubEnumLabel(t, "recordType", item.record_type)}</div>
            {item.body && <p className="hub2-tl__body">{item.body}</p>}
            {canStaff && <button type="button" className="hub2-btn hub2-btn--ghost" onClick={() => onOpen({ type: "recordEdit", item })}>{t("hub.edit")}</button>}
          </div>
        </div>)}
      </div>
    </article>}
    {records.length === 0 && <EmptyState><strong>{t("hub.emptyRecord")}</strong><p>{t("hub.emptyRecordBody")}</p></EmptyState>}
  </section>;
}

function PartnersPanel({ product, canStaff, currentChapterId, preview, t, onOpen, onUpdateHandshake }) {
  const [busyId, setBusyId] = useState(null);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  function applyStatus(item, status) {
    return runBusyWrite(busyWriteRef, "partner", (unlock) => applyStatusNow(item, status, unlock));
  }

  async function applyStatusNow(item, status, unlock) {
    if (!onUpdateHandshake || busyId) return;
    setBusyId(item.id);
    try {
      await onUpdateHandshake(item.id, status, item.status);
    } catch {
      // Parent mutate() already toasted the failure; swallow so the click
      // handler does not emit an unhandledrejection on the Partners flow.
    } finally {
      setBusyId(null);
      unlock();
    }
  }
  return <section className="hub2-panel">
    <PanelHead title={t("hub.partners.title")} sub={t("hub.partners.sub")} action={t("hub.newHandshake")} onAction={canStaff ? () => onOpen({ type: "handshake" }) : null} />
    {(product.handshakes || []).map((item) => {
      const actions = canStaff && onUpdateHandshake
        ? preview ? (HANDSHAKE_ACTIONS[item.status] || []) : liveHandshakeActions(item, currentChapterId)
        : [];
      return <article className="hub2-thread" key={item.id}>
      <div className="hub2-thread__top">
        <StatusChip status={item.status} label={t(`hub.handshake.status.${item.status}`)} />
        <span className="hub2-thread__title">{item.title}</span>
        <span className="hub2-thread__spacer" />
        <span className="hub2-thread__meta">{item.union_orgs?.name || item.partner_org_id} · {hubEnumLabel(t, "dataScope", item.data_scope)}</span>
      </div>
      <p className="hub2-thread__body">{item.purpose}</p>
      {item.status === "requested" && <p className="hub2-thread__meta">{t(requestedHandshakeLineKey(item, currentChapterId, preview))}</p>}
      {item.status === "draft" && <p className="hub2-thread__meta">{t("hub.handshake.draftHint")}</p>}
      {actions.length > 0 && <div className="hub2-thread__actions">
        {actions.map((action) => (
          <BusyButton
            type="button"
            key={action.status}
            className={action.ghost ? "hub2-btn hub2-btn--ghost" : "hub2-btn hub2-btn--primary"}
            pending={busyId !== null}
            onClick={() => applyStatus(item, action.status)}
          >{t(action.labelKey)}</BusyButton>
        ))}
      </div>}
    </article>;
    })}
    {(product.handshakes || []).length === 0 && <EmptyState><strong>{t("hub.emptyPartners")}</strong><p>{t("hub.emptyPartnersBody")}</p></EmptyState>}
  </section>;
}

function GovernancePanel({ product, t, onOpen, onGenerateDataExport, onRetry }) {
  const [retrying, setRetrying] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Record 8435: a synchronous lock for the export, refused before React
  // commits busy. It ends in the same finally as exporting, so a callback that
  // throws at once leaves a ready button that sends.
  const exportWriteRef = useRef(new Set());
  const [exportError, setExportError] = useState("");
  function generateExport() {
    return runBusyWrite(exportWriteRef, "export", (unlock) => generateExportNow(unlock));
  }
  async function generateExportNow(unlock) {
    if (exporting) return;
    setExporting(true);
    setExportError("");
    try { await onGenerateDataExport(); } catch { setExportError(t("hub.lifecycle.exportFailed")); } finally { setExporting(false); unlock(); }
  }
  return <section className="hub2-panel">
    <PanelHead title={t("hub.governance.title")} sub={t("hub.governance.sub")} action={t("hub.newDataRequest")} onAction={() => onOpen({ type: "governance" })} />
    <div className="hub2-lifecycle" aria-label={t("hub.lifecycle.actions")}>
      <article className="hub2-lifecycle__card">
        <Download aria-hidden="true" size={20} />
        <div><h3>{t("hub.lifecycle.exportTitle")}</h3><p>{t("hub.lifecycle.exportBody")}</p></div>
        <BusyButton type="button" className="hub2-btn hub2-btn--primary" pending={exporting} onClick={generateExport}>{exporting ? t("hub.lifecycle.exporting") : t("hub.lifecycle.export")}</BusyButton>
      </article>
      <article className="hub2-lifecycle__card hub2-lifecycle__card--danger">
        <Trash2 aria-hidden="true" size={20} />
        <div><h3>{t("hub.lifecycle.deleteTitle")}</h3><p>{t("hub.lifecycle.deleteBody")}</p></div>
        <button type="button" className="hub2-btn hub2-btn--danger" onClick={() => onOpen({ type: "deleteAccount" })}>{t("hub.lifecycle.delete")}</button>
      </article>
    </div>
    {exportError && <p className="hub2-lifecycle__error" role="alert">{exportError}</p>}
    {product.governanceUnavailable && <div className="view-error" role="alert">
      <p>{t("app.loadFailed")}</p>
      {onRetry && <BusyButton type="button" className="dialog-primary" pending={retrying} onClick={async () => {
        if (retrying) return;
        setRetrying(true);
        try { await onRetry(); } catch { /* The read's failure state remains visible. */ }
        finally { setRetrying(false); }
      }}>{t(retrying ? "app.loading" : "app.tryAgain")}</BusyButton>}
    </div>}
    {(product.governance || []).map((item) => <article className="hub2-thread" key={item.id}>
      <div className="hub2-thread__top">
        <StatusChip status={item.status} />
        <span className="hub2-thread__title">{item.request_type}</span>
        <span className="hub2-thread__spacer" />
      </div>
      <p className="hub2-thread__body">{item.details}</p>
      {item.response && <blockquote className="hub2-quote">{item.response}</blockquote>}
    </article>)}
    {/* External-in-effect anchors: inside the desktop companion iframe a bare
        same-frame navigation joins TOP-LEVEL browser history, so these open a
        new tab instead. */}
    <div className="hub2-legal">
      <a href="/privacy" target="_blank" rel="noopener">{t("hub.privacy")}</a>
      <a href="/terms" target="_blank" rel="noopener">{t("hub.terms")}</a>
      <a href="/accessibility" target="_blank" rel="noopener">{t("hub.accessibility")}</a>
      <a href="/retention" target="_blank" rel="noopener">{t("hub.retention")}</a>
    </div>
  </section>;
}

function FormDialog({ t, eyebrow, title, onClose, onSave, children, submitLabel }) {
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState("");
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  function submit(event) {
    return runBusyWrite(busyWriteRef, "form", (unlock) => submitNow(event, unlock), event);
  }

  async function submitNow(event, unlock) {
    event.preventDefault();
    // A null onSave/submitLabel means the dialog carries no plain-save action at
    // all (SOL-20260813-03: a published document). The primary button is then
    // not rendered, but a form can still submit implicitly, so the handler
    // refuses as well instead of trusting the absent button.
    if (busy || !onSave) return;
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    setBusy(true);
    setError("");
    try {
      await onSave(values);
      // A departed form's close callback still writes shared hub parity state.
      // Do not let its late completion dismiss a newer mounted hub's dialog.
      if (mounted.current) onClose();
    } catch (cause) {
      if (!mounted.current) return;
      // SOL-20260813-03: DocumentDialog remaps a 55000 refusal to this exact
      // catalogue sentence before rethrowing. Preserve that explanation by
      // matching the remapped message only — do not treat every 55000 from
      // other FormDialog callers as a published-document lock.
      setError(cause?.message === t("hub.publishedSaveBlocked")
        ? "hub.publishedSaveBlocked"
        : rpcErrorKeyStrict(cause, "hub.saveFailed"));
    } finally { if (mounted.current) setBusy(false); unlock(); }
  }
  return <Dialog eyebrow={eyebrow} title={title} onClose={onClose} wide><form className="stack-form" onSubmit={submit}>{children}{error&&<p className="tasks-error" role="alert">{rpcErrorTextAtRender(t, error)}</p>}{submitLabel&&<BusyButton className="dialog-primary" pending={busy}>{busy ? t("dialogs.saving") : submitLabel}</BusyButton>}</form></Dialog>;
}

function ArchiveButton({ t, onArchive, onDone }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  return <><button type="button" className="outline-pill" onClick={async (event) => {
    if (!confirming) { setConfirming(true); return; }
    setError("");
    try { await onArchive(event); onDone(); } catch (cause) { setError(rpcErrorKeyStrict(cause, "hub.saveFailed")); }
  }}>{t(confirming ? "hub.confirmArchive" : "hub.archive")}</button>{error&&<span role="alert">{rpcErrorTextAtRender(t, error)}</span>}</>;
}

function RepublishButton({ t, onRepublish, onDone }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  return <><BusyButton type="button" pending={busy} onClick={(event)=>runBusyWrite(busyWriteRef,"republish",async(unlock)=>{setBusy(true);setError("");try{await onRepublish(event);onDone();}catch(cause){setError(rpcErrorKeyStrict(cause, "hub.saveFailed"));}finally{setBusy(false);unlock();}})}>{t("hub.republish")}</BusyButton>{error&&<span role="alert">{rpcErrorTextAtRender(t, error)}</span>}</>;
}

function SpaceDialog({ t, onClose, onSave, onArchive=null, item=null }) {
  return <FormDialog t={t} eyebrow={t("hub.organize.title")} title={item?t("hub.editSpace"):t("hub.newSpace")} onClose={onClose} onSave={onSave} submitLabel={t("hub.save")}><label>{t("hub.name")}<input name="name" defaultValue={item?.name} maxLength="80" required /></label><label>{t("hub.description")}<textarea name="description" defaultValue={item?.description} maxLength="1000" /></label><fieldset className="hub2-spanish"><legend>{t("bilingualContent.spaceSpanishHint")}</legend><label>{t("bilingualContent.spaceNameEs")}<input name="nameEs" lang="es" defaultValue={item?.name_es ?? ""} maxLength="80" /></label><label>{t("bilingualContent.spaceDescriptionEs")}<textarea name="descriptionEs" lang="es" defaultValue={item?.description_es ?? ""} maxLength="1000" /></label></fieldset><label>{t("hub.visibility")}<select name="visibility" defaultValue={item?.visibility||"chapter"}><HubEnumOptions t={t} family="visibility" omit={["organization"]} />{item?.visibility === "organization" && <option value="organization">{t(HUB_ENUM_KEY.visibility.organization)}</option>}</select></label>{onArchive&&<ArchiveButton t={t} onArchive={onArchive} onDone={onClose}/>}</FormDialog>;
}

// Record 8435 (slice 10 review): the paired desktop and phone screens can
// replace the open members dialog's space in one update. The dialog is keyed
// by space, so its locks, pending marks, query and change history never carry
// over to another space. This wrapper sits above the key and mounts once per
// open, so it keeps the opener the person pressed (captured as the dialog
// itself does) and focus returns there when the dialog closes, even after the
// paired screen replaced the space. Opened from the paired screen, it keeps
// what was focused here then, as the dialog alone would.
function SpaceMembersOpen({ space, ...props }) {
  const opener = useRef(typeof document === "undefined" ? null : document.activeElement);
  return <SpaceMembersDialog key={space.id} space={space} returnFocusRef={opener} {...props} />;
}

function SpaceMembersDialog({ t, space, onClose, onList, onSearch, onSet, returnFocusRef = null }) {
  const [members,setMembers]=useState([]); const [searched,setSearched]=useState({rows:[],since:0,query:""}); const [query,setQuery]=useState(""); const [searching,setSearching]=useState(false); const [changing,setChanging]=useState(false); const [error,setError]=useState(""); const [searchError,setSearchError]=useState("");
  // Ledger 424: this dialog's own successful membership changes, in order.
  // The shown results are the last search's server rows, less anyone whose
  // latest change here since that search began is an Add. They are worked out
  // again on every render, so a change after the answer offers or hides that
  // person too. The dialog's member list (which can be stale) is never read.
  const changes = useRef([]);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  useEffect(()=>{let live=true;onList(space.id).then(rows=>live&&setMembers(rows||[])).catch(cause=>live&&setError(rpcErrorKeyStrict(cause, "hub.membersError")));return()=>{live=false;};},[onList,space.id,t]);
  // Record 8435 (slice 9 review): the search is a read and a change is a
  // write, each with its own lock and pending mark, so a slow search never
  // holds back a change and each settles only its own control.
  function search(event){event.preventDefault();return runBusyWrite(busyWriteRef,"search",(unlock)=>searchNow(unlock),event);}
  async function searchNow(unlock){if(query.trim().length<2||searching)return;setSearching(true);setSearchError("");setSearched(current=>({...current,query:""}));const since=changes.current.length;try{const rows=await onSearch(space.id,query)||[];setSearched({rows,since,query:query.trim()});}catch(cause){setSearchError(rpcErrorKeyStrict(cause, "hub.membersError"));}finally{setSearching(false);unlock();}}
  function change(person,add){return runBusyWrite(busyWriteRef,"members",(unlock)=>changeNow(person,add,unlock));}
  async function changeNow(person,add,unlock){if(changing)return;setChanging(true);setError("");try{await onSet(space.id,person.userId,add);changes.current.push({userId:person.userId,add});if(add){setMembers(current=>[...current.filter(row=>row.userId!==person.userId), {...person,role:"member"}]);}else setMembers(current=>current.filter(row=>row.userId!==person.userId));}catch(cause){setError(rpcErrorKeyStrict(cause, "hub.membersError"));}finally{setChanging(false);unlock();}}
  const latestChange=new Map(changes.current.slice(searched.since).map(change=>[change.userId,change.add]));
  const results=searched.rows.filter(row=>latestChange.get(row.userId)!==true);
  return <Dialog eyebrow={t("hub.privateSpace")} title={space.name} onClose={onClose} wide returnFocusRef={returnFocusRef}><div className="stack-form"><h3>{t("hub.currentMembers")}</h3>{members.length===0&&<p>{t("hub.membersEmpty")}</p>}{members.map(person=><div className="hub2-rowbtn" key={`member:${person.userId}`}><span>{person.fullName} · {person.role}</span>{person.role!=="creator"&&<BusyButton type="button" pending={changing} onClick={()=>change(person,false)}>{t("hub.removeMember")}</BusyButton>}</div>)}<form onSubmit={search}><label>{t("hub.findMember")}<input value={query} onChange={event=>setQuery(event.target.value)} minLength={2} required /></label><BusyButton type="submit" pending={searching} disabled={query.trim().length<2} disabledReason={t("hub.searchMinCharacters")}>{t("hub.searchMembers")}</BusyButton></form>{/* #9923: a search that found no one to add says so (the search leaves out people already in the space), in a status region present before it fills. */}<p className="hub2-search-status" role="status">{searched.query&&searched.rows.length===0?t("hub.membersNoMatch",{query:searched.query}):""}</p>{results.map(person=><div className="hub2-rowbtn" key={`result:${person.userId}`}><span>{person.fullName}</span><BusyButton type="button" pending={changing} onClick={()=>change(person,true)}>{t("hub.addMember")}</BusyButton></div>)}{error&&<p role="alert">{rpcErrorTextAtRender(t, error)}</p>}{searchError&&<p role="alert">{rpcErrorTextAtRender(t, searchError)}</p>}</div></Dialog>;
}

function ThreadDialog({ t, spaces, initialSpaceId, onClose, onSave }) {
  return <FormDialog t={t} eyebrow={t("hub.organize.title")} title={t("hub.newThread")} onClose={onClose} onSave={(v) => onSave({ ...v, spaceId: v.spaceId })} submitLabel={t("hub.create")}><label>{t("hub.space")}<select name="spaceId" defaultValue={initialSpaceId} required>{spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}</select></label><label>{t("hub.titleField")}<input name="title" maxLength="160" required /></label><label>{t("hub.kind")}<select name="kind"><HubEnumOptions t={t} family="threadKind" /></select></label></FormDialog>;
}

// renderConnectedActions(kind, record) gives each post the common connected control
// for that exact row; focusPostId / landedPost are the exact post a link named and,
// when the hub already hydrated it, its row. A post older than the posts the hub
// loaded is asked of the server (messagingApi.loadChannelLanding), once.
function ThreadDetail({ t, thread, currentUserId, mentionStaffScope = false, onClose, onSend, onCreateTask, workstream, messagingApi, onNotice, actorId, renderConnectedActions = null, focusPostId = null, landedPost: hydratedPost = null, pulse = null, remindHereHint = false, channelApi = null, channelControls = null, onTogglePin = null, pinBusy = false, membersSpace = null, onListSpaceMembers = null, onSearchSpaceMembers = null, onSetSpaceMember = null }) {
  // The same gate as the space card's Manage members button (staff, private
  // space). The members dialog opens over the thread, so a typed reply stays.
  const [membersOpen, setMembersOpen] = useState(false);
  const canAddPeople = Boolean(membersSpace && onListSpaceMembers && onSearchSpaceMembers && onSetSpaceMember);
  // Closing the members dialog returns the caret to the reply being written.
  const replyBoxRef = useRef(null);
  const { lang } = useLang();
  const threadDomId = useId();
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  // The text of the reply that failed. The notice says that text is still in
  // the box, so it shows only while the box holds exactly that text.
  const [replyNotSent, setReplyNotSent] = useState("");
  const replyFormRef = useRef(null);
  const [remindFeedback, setRemindFeedback] = useState("");
  const [draft, setDraft] = useState("");
  // The optional Spanish version stays closed until asked for. Closing it
  // keeps what was typed but sends nothing; a sent reply clears and closes it.
  const [draftEs, setDraftEs] = useState("");
  const [spanishOpen, setSpanishOpen] = useState(false);
  const [picked, setPicked] = useState([]);
  const switches = channelControls?.switches || {};
  const highlightKeywords = channelApi && switches.keywordAlerts ? channelSettingFor(channelControls, thread.space_id).keywords : [];
  const highlightHere = Boolean(channelApi && switches.hereMentions);
  const [creatingTask, setCreatingTask] = useState(false);
  const creatingTaskRef = useRef(false);
  // BUG-UG-CREATE-TASK-FROM-THREAD-SKIPS-REVIEW-20261006: the control
  // opens a prefilled draft; nothing exists until the person confirms it.
  const [taskDraft, setTaskDraft] = useState(null);
  const taskTitleRef = useRef(null);
  const taskOpenRef = useRef(null);
  const taskDraftOpen = Boolean(taskDraft);
  const taskDraftWasOpen = useRef(false);
  // Opening the draft unmounts the control that had focus, and closing it
  // unmounts the draft. A failed create re-enables the title, so restore focus
  // then as well; disabled fields cannot receive focus during the request.
  useEffect(() => {
    if (creatingTask) return;
    if (taskDraftOpen) taskTitleRef.current?.focus();
    else if (taskDraftWasOpen.current) taskOpenRef.current?.focus();
    taskDraftWasOpen.current = taskDraftOpen;
  }, [taskDraftOpen, creatingTask]);
  const [posts, setPosts] = useState(thread.posts || []);
  useEffect(() => setPosts(thread.posts || []), [thread.posts]);
  // BUG-UG-WEB-CHANNEL-HIDES-POSTS-PAST-NEWEST-1000-20261110: when the
  // member load's window cut older posts off, the thread carries an earlier
  // cursor and its earlier posts open above the loaded ones, under the native
  // app's rules (features/messaging/earlierHistory.js). This dialog has no
  // reconcile, so opened history is read again every 30 s.
  const loadEarlierPosts = messagingApi?.loadEarlierChannelPosts;
  const loadEarlierRef = useRef(loadEarlierPosts);
  loadEarlierRef.current = loadEarlierPosts;
  const newestPage = useMemo(() => (thread.earlierCursor && loadEarlierPosts
    ? { messages: posts.map(withCreatedAt), earlierCursor: thread.earlierCursor }
    : null), [loadEarlierPosts, posts, thread.earlierCursor]);
  const history = useEarlierHistory({
    scopeKey: JSON.stringify([thread.id, actorId]),
    thread: newestPage,
    load: async (before) => {
      const page = await loadEarlierRef.current({ threadId: thread.id, before });
      return { messages: page.posts.map(withCreatedAt), earlierCursor: page.earlierCursor };
    },
    revalidateMs: EARLIER_HISTORY_RECONCILE_MS,
  });
  // An action on a post shown only from earlier history shows through its own
  // MessageActions copy of the row, like any other; a re-read brings the
  // server's copy.
  const shownPosts = newestPage && history.started ? history.messages : posts;
  const threadListRef = useRef(null);
  const showEarlier = usePrependAnchor(threadListRef, shownPosts, history);
  const [fetchedPost, setFetchedPost] = useState(null);
  const [postLanding, setPostLanding] = useState(null);
  const [postRetry, setPostRetry] = useState(0);
  const postRun = useRef(0);
  const requestedPost = useRef(null);
  const landedPost = fetchedPost ?? hydratedPost;
  // The posts on screen: the loaded ones plus the exact post, in chronological
  // position. Same array when the post is already among them.
  const visiblePosts = useMemo(() => mergeLandedMessage(shownPosts, landedPost), [shownPosts, landedPost]);
  useEffect(() => () => { postRun.current += 1; }, []);
  // The hydrated copy belongs to the reader it was fetched for.
  const dialogReader = useRef(actorId);
  useEffect(() => {
    if (dialogReader.current === actorId) return;
    dialogReader.current = actorId;
    postRun.current += 1;
    // The previous reader's instruction is void: mark it asked, so the effect
    // below (which runs in this same commit, often with the new reader's api)
    // does not ask for it again as the new reader.
    requestedPost.current = focusPostId;
    setFetchedPost(null);
    setPostLanding(null);
  }, [actorId, focusPostId]);
  useEffect(() => {
    if (!focusPostId || requestedPost.current === focusPostId) return;
    if (visiblePosts.some((post) => post.id === focusPostId)) return;
    if (!messagingApi?.loadChannelLanding) return;
    requestedPost.current = focusPostId;
    const run = ++postRun.current;
    setPostLanding("loading");
    messagingApi.loadChannelLanding({ threadId: thread.id, postId: focusPostId, window: 0 }).then((result) => {
      if (run !== postRun.current) return;
      if (result?.post?.id !== focusPostId || result.thread?.id !== thread.id) {
        setPostLanding("unavailable");
        return;
      }
      setFetchedPost(result.post);
      setPostLanding(null);
    }).catch((error) => {
      if (run !== postRun.current) return;
      setPostLanding(isPermissionRefusal(error) || isSourceGone(error) ? "unavailable" : "failed");
    });
  }, [focusPostId, messagingApi, postRetry, thread.id, visiblePosts]);
  useLandOnMessage(focusPostId, threadDomId, visiblePosts);
  // Keep known ballots during a same-scope refresh. The signed-in scope
  // includes the session generation, so even a new login as the same member
  // starts without a previous session's tally or selected option.
  const [pollRead, setPollRead] = useState(null);
  const [pollRetry, setPollRetry] = useState(0);
  const pollPostKey = visiblePosts.map((post) => post.id).join(",");
  const loadThreadPolls = messagingApi?.loadThreadPolls;
  const loadThreadPollsRef = useRef(loadThreadPolls);
  loadThreadPollsRef.current = loadThreadPolls;
  // App supplies an explicit scope, including null during sign-out. Callers
  // with no session metadata still scope the read to their current member.
  const { pollScope: pollActorScope = currentUserId } = messagingApi ?? {};
  const pollScope = pollActorScope && thread.space_id
    ? JSON.stringify([pollActorScope, thread.id, thread.space_id])
    : null;
  const canLoadPolls = Boolean(loadThreadPolls && pollScope && pollPostKey);
  const pollRequest = JSON.stringify([pollPostKey, pollRetry]);
  const currentPollRead = canLoadPolls && pollRead?.scope === pollScope ? pollRead : null;
  const polls = currentPollRead?.items ?? [];
  const pollPhase = canLoadPolls && (currentPollRead?.request === pollRequest ? currentPollRead.phase : "loading");
  useEffect(() => {
    if (!canLoadPolls) { setPollRead(null); return undefined; }
    let live = true;
    const load = loadThreadPollsRef.current;
    const read = Promise.resolve().then(() => load({ spaceId: thread.space_id, postIds: pollPostKey.split(",") }));
    void withLoadDeadline(read)
      .then((items) => { if (live) setPollRead({ scope: pollScope, request: pollRequest, phase: "ready", items: Array.isArray(items) ? items : [] }); })
      .catch(() => { if (live) setPollRead({ scope: pollScope, request: pollRequest, phase: "failed" }); });
    return () => { live = false; };
  }, [canLoadPolls, pollScope, pollRequest, thread.space_id, pollPostKey]);
  // REQ-UG-REMIND-HERE-20261001: a draft that starts with /remind is a
  // command, never a chat post. The server decides who may remind the
  // channel staff; this only parses the time on the member's own clock.
  // Called only from reply(), whose lock already covers it (record 8435).
  async function remind(body, unlock) {
    const parsed = parseRemindCommand(body, new Date());
    if (parsed.kind === "help") { setRemindFeedback(t("remindHere.usage")); return; }
    if (parsed.kind === "error") { setRemindFeedback(t(`remindHere.error.${parsed.code}`, { detail: parsed.detail || "" })); return; }
    if (parsed.target !== "here") { setRemindFeedback(t("remindHere.error.me_not_here")); return; }
    if (!messagingApi?.remindHere || !thread.space_id) { setRemindFeedback(t("remindHere.refusal.unavailable")); return; }
    setBusy(true);
    try {
      await messagingApi.remindHere(thread.space_id, parsed.remindAt.toISOString(), parsed.note);
      setRemindFeedback("");
      setDraft("");
      setPicked([]);
      onNotice?.(t("remindHere.set", { when: formatDateTimeWithZone(parsed.remindAt.toISOString(), lang), note: parsed.note }));
    } catch (error) {
      setRemindFeedback(t(`remindHere.refusal.${remindHereRefusal(error)}`));
    } finally {
      setBusy(false);
      unlock();
    }
  }
  function reply(event) {
    return runBusyWrite(busyWriteRef, "thread", (unlock) => replyNow(event, unlock), event);
  }

  async function replyNow(event, unlock) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    // Any new attempt, a /remind command included, replaces the old failure.
    setReplyNotSent("");
    if (parseRemindCommand(body)) { await remind(body, unlock); return; }
    setRemindFeedback("");
    setBusy(true);
    try {
      const mentionIds = channelApi && switches.mentions ? mentionIdsForBody(body, picked) : [];
      const created = await onSend(thread.id, body, mentionIds, spanishOpen ? spanishValue(draftEs) : null);
      if (created) setPosts((current) => current.some((post) => post.id === created.id) ? current : [...current, created]);
      setDraft("");
      setDraftEs("");
      setSpanishOpen(false);
      setPicked([]);
    } catch {
      // The app already toasted the reason; the reply stays in the box and
      // the composer says it was not posted until the next attempt.
      setReplyNotSent(body);
    } finally {
      setBusy(false);
      unlock();
    }
  }
  // Standard Task quick creation: a title, unassigned, blank dates unless the
  // person picks a due date in the draft. The date input already yields the
  // local calendar day, so no clock arithmetic happens here.
  async function task(event) {
    event.preventDefault();
    if (creatingTaskRef.current || !taskDraft) return;
    const title = taskDraft.title.trim();
    if (!title) return;
    creatingTaskRef.current = true;
    setCreatingTask(true);
    setTaskDraft((current) => ({ ...current, error: "" }));
    try {
      await onCreateTask({ title, description: `Created from organizing thread ${thread.id}`, status: "backlog", priority: "medium", workstream, assigneeId: null, startDate: null, dueDate: taskDraft.dueDate || null, progress: 0, blocked: false, milestone: false });
      setTaskDraft(null);
    } catch (error) {
      // The shell toast sits behind this dialog, so the draft says why itself
      // and keeps the person's entries for another try or Cancel.
      setTaskDraft((current) => current && ({ ...current, error: rpcErrorKeyStrict(error, "hub.taskDraftFailed") }));
    } finally {
      creatingTaskRef.current = false;
      setCreatingTask(false);
    }
  }
  return <><Dialog eyebrow={hubEnumLabel(t, "threadKind", thread.kind)} title={thread.title} onClose={onClose} wide>
    {/* Case and intake threads carry casework and reports: never a quick check. */}
    <ContextualPulseSlot pulse={pulse} contextKey="issue-thread.detail" active={PULSE_HUB_THREAD_KINDS.includes(thread.kind)} />
    {(onTogglePin || (switches.channelPinning && thread.pinned_at)) && (
      <div className="thread-pin-bar">
        {switches.channelPinning && thread.pinned_at && <span className="hub2-chip hub2-chip--amber"><Pin size={11} aria-hidden="true" />{t("channelControls.pinnedChip")}</span>}
        {onTogglePin && <PinToggle t={t} thread={thread} busy={pinBusy} onToggle={onTogglePin} />}
      </div>
    )}
    {postLanding && (
      <p className="hub2-panel-head__sub" role={postLanding === "loading" ? "status" : "alert"}>
        {t(`linkedMessage.${postLanding}`)}
        {postLanding === "failed" && <>{" "}<button type="button" className="hub2-btn hub2-btn--ghost" onClick={() => { requestedPost.current = null; setPostLanding(null); setPostRetry((value) => value + 1); }}>{t("linkedMessage.retry")}</button></>}
      </p>
    )}
    {newestPage && <EarlierThreadHistory t={t} history={history} onShowEarlier={showEarlier} />}
    <div aria-live="polite" aria-atomic="true">
      {pollPhase === "loading" && <p className="hub2-panel-head__sub">{t("channelPoll.loading")}</p>}
      {pollPhase === "failed" && <p className="hub2-panel-head__sub">{t("channelPoll.loadFailed")}</p>}
    </div>
    {pollPhase === "failed" && <Button variant="secondary" size="small" onClick={() => setPollRetry((value) => value + 1)}>{t("app.tryAgain")}</Button>}
    <div className="thread-list" ref={threadListRef}>{visiblePosts.map((post) => {
      // The common connected-workflow control for THIS exact post. A callback that
      // returns nothing for it leaves the post on its standalone controls.
      const connected = renderConnectedActions && isDeliveredMessage(post) ? renderConnectedActions("channel_post", post) : null;
      const mentionsMe = Boolean(currentUserId && Array.isArray(post.mentioned_user_ids) && post.mentioned_user_ids.includes(currentUserId));
      return <article id={`${threadDomId}-message-${post.id}`} tabIndex={post.id === focusPostId ? -1 : undefined} className={`thread-message${currentUserId && post.author_id === currentUserId ? " thread-message--member" : ""}${mentionsMe ? " thread-message--mentioned" : ""}`} key={post.id}><ChannelPostBody t={t} body={postBody(post, lang)} keywords={highlightKeywords} here={highlightHere} mentionsMe={mentionsMe} /><HubTimestamp value={post.created_at} /><MessageActions sourceKind="channel" message={post} actorId={actorId} api={messagingApi} onNotice={onNotice} connectedActions={connected} onMessageChange={(next) => {
        setPosts((rows) => rows.map((row) => row.id === next.id ? next : row));
        // A hydrated post lives outside the loaded posts: keep its own copy current too.
        if (next.id === landedPost?.id) setFetchedPost(next);
      }} onReply={(reply) => setPosts((rows) => [...rows.filter((row) => row.id !== reply.id), reply].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)))} />{messagingApi?.voteChannelPoll && polls.filter((poll) => poll.postId === post.id).map((poll) => <ChannelPollCard key={poll.pollId} poll={poll} onVote={messagingApi.voteChannelPoll} />)}</article>;
    })}</div><form ref={replyFormRef} className="thread-composer" onSubmit={reply}><textarea ref={replyBoxRef} name="body" aria-label={t("hub.reply")} maxLength="8000" required value={draft} onChange={(event) => setDraft(event.target.value)} aria-describedby={remindHereHint || remindFeedback ? `${threadDomId}-remind` : undefined} />{channelApi && switches.mentions && <MentionPicker t={t} api={channelApi} spaceId={thread.space_id} pending={busy} staffScope={mentionStaffScope} onAddPeople={canAddPeople ? () => setMembersOpen(true) : null} onPick={(person) => {
      setPicked((current) => current.some((item) => item.id === person.id) ? current : [...current, person]);
      setDraft((current) => appendMentionText(current, person));
    }} />}<button type="button" className="outline-pill" aria-expanded={spanishOpen} aria-controls={`${threadDomId}-spanish`} onClick={() => setSpanishOpen((open) => !open)}>{t("bilingualContent.postSpanishToggle")}</button>{spanishOpen && <div id={`${threadDomId}-spanish`} className="thread-composer__spanish"><label>{t("bilingualContent.postBodyEs")}<textarea name="bodyEs" lang="es" maxLength="8000" value={draftEs} onChange={(event) => setDraftEs(event.target.value)} aria-describedby={`${threadDomId}-spanish-hint`} /></label><p id={`${threadDomId}-spanish-hint`} className="hub2-panel-head__sub">{t("bilingualContent.postSpanishHint")}</p></div>}<BusyButton className="dialog-primary" pending={busy}>{t("hub.reply")}</BusyButton></form>{replyNotSent && !busy && draft.trim() === replyNotSent && <p role="alert" className="composer-not-sent">{t("inbox.notSent")} <button type="button" className="composer-not-sent__retry" onClick={() => replyFormRef.current?.requestSubmit()}>{t("inbox.notSentRetry")}</button></p>}{(remindHereHint || remindFeedback) && <p id={`${threadDomId}-remind`} className="hub2-panel-head__sub" role={remindFeedback ? "alert" : undefined}>{remindFeedback || t("remindHere.hint")}</p>}{onCreateTask && !taskDraft && <button ref={taskOpenRef} type="button" className="outline-pill" onClick={() => setTaskDraft({ title: [...String(thread.title || "")].slice(0, 160).join(""), dueDate: "", error: "" })}>{t("hub.createTask")}</button>}{onCreateTask && taskDraft && <form className="stack-form" aria-labelledby={`${threadDomId}-task-draft`} onSubmit={task}><h3 id={`${threadDomId}-task-draft`}>{t("hub.taskDraftHeading")}</h3><p className="hub2-panel-head__sub">{t("hub.taskDraftHelp")}</p><label>{t("hub.taskDraftTitle")}<BusyInput ref={taskTitleRef} value={taskDraft.title} required pending={creatingTask} onChange={(event) => setTaskDraft((current) => ({ ...current, title: [...event.target.value].slice(0, 160).join("") }))} /></label><label>{t("hub.taskDraftDue")}<BusyInput type="date" value={taskDraft.dueDate} pending={creatingTask} onChange={(event) => setTaskDraft((current) => ({ ...current, dueDate: event.target.value }))} /></label>{taskDraft.error && <p className="hub2-panel-head__sub" role="alert">{rpcErrorTextAtRender(t, taskDraft.error)}</p>}<BusyButton className="dialog-primary" pending={creatingTask} disabled={!taskDraft.title.trim()}>{creatingTask ? t("hub.taskDraftCreating") : t("hub.taskDraftCreate")}</BusyButton><BusyButton type="button" className="dialog-secondary" pending={creatingTask} onClick={() => setTaskDraft(null)}>{t("hub.taskDraftCancel")}</BusyButton></form>}</Dialog>
    {membersOpen && canAddPeople && <SpaceMembersDialog key={membersSpace.id} t={t} space={membersSpace} returnFocusRef={replyBoxRef} onClose={() => setMembersOpen(false)} onList={onListSpaceMembers} onSearch={onSearchSpaceMembers} onSet={onSetSpaceMember} />}</>;
}

function IntakeDialog({ t, onClose, onSave }) {
  return <FormDialog t={t} eyebrow={t("hub.voice.title")} title={t("hub.report")} onClose={onClose} onSave={onSave} submitLabel={t("hub.submit")}><label>{t("hub.category")}<select name="category"><HubEnumOptions t={t} family="intakeCategory" /></select></label><label>{t("hub.titleField")}<input name="title" maxLength="160" required /></label><label>{t("hub.details")}<textarea name="details" maxLength="10000" required /></label></FormDialog>;
}

// SOL-20260813-03: a document with status 'published' is the copy members read
// right now, under its printed version number and publication date. Plain save
// would change that text without moving either field, so the editor for a
// published document offers only the two honest exits — publish a new version,
// or archive — and says why. Drafts and archived documents keep plain save.
export function DocumentDialog({ t, onClose, onSave, onRepublish=null, onArchive=null, item=null }) {
  const published=item?.status==="published";
  // The tab that opened this dialog can be older than the row. If the document
  // was published elsewhere since, `published` is stale, Save is still on
  // screen, and the RPC is what stops the write — raising 55000. Translate that
  // one code so the member-facing surface never shows raw Postgres English.
  const save=published?null:async(values)=>{
    try { return await onSave(values); }
    catch (cause) { throw cause?.code==="55000" ? new Error(t("hub.publishedSaveBlocked")) : cause; }
  };
  const fields=<><label>{t("hub.titleField")}<input name="title" defaultValue={item?.title} maxLength="200" required /></label><label>{t("hub.documentType")}<select name="documentType" defaultValue={item?.document_type||"contract"}><HubEnumOptions t={t} family="documentType" /></select></label><label>{t("hub.summary")}<textarea name="summary" defaultValue={item?.summary} maxLength="1000" /></label><label>{t("hub.body")}<textarea name="body" defaultValue={item?.body} maxLength="100000" required /></label><label>{t("rightsQuestions.documentVisibility")}<select name="visibility" defaultValue={item?.visibility||"chapter"}><option value="chapter">{t("hub.visibility.chapter")}</option><option value="staff">{t("hub.visibility.staff")}</option></select></label><p className="hub2-published-note">{t("rightsQuestions.documentVisibilityHelp")}</p></>;
  return <FormDialog t={t} eyebrow={t("hub.library.title")} title={item?t("hub.editDocument"):t("hub.newDocument")} onClose={onClose} onSave={save} submitLabel={published?null:t("hub.save")}>{fields}{published&&<p className="hub2-published-note">{t("hub.publishedEditNote")}</p>}{item&&<div className="xus-btnrow"><RepublishButton t={t} onDone={onClose} onRepublish={(event)=>onRepublish?.(Object.fromEntries(new FormData(event.currentTarget.closest("form"))))}/><ArchiveButton t={t} onDone={onClose} onArchive={(event)=>onArchive?.(Object.fromEntries(new FormData(event.currentTarget.closest("form"))))}/></div>}</FormDialog>;
}

// REQ-UG-RIGHTS-CONTRACT-AND-LIBRARY-CONTENT-20261030: the body keeps
// its paragraph breaks, and a draft (readable by the chapter's stewards,
// coordinators, advisors, admins and presidents under chapter_documents_read)
// offers its ?document= link to share with the committee.
export function documentShareLink(documentId, origin = globalThis.location?.origin ?? "") {
  return `${origin}/m/organize?document=${encodeURIComponent(documentId)}`;
}

export function DocumentDetail({ document, t, onClose, canStaff, onEdit }) {
  const [shared, setShared] = useState(null);
  const draft = document.status === "draft";
  async function share() {
    try {
      await globalThis.navigator.clipboard.writeText(documentShareLink(document.id));
      setShared("ok");
    } catch {
      setShared("failed");
    }
  }
  return <Dialog eyebrow={hubEnumLabel(t, "documentType", document.document_type)} title={document.title} onClose={onClose} wide><article className="hub-document">{draft&&canStaff&&<p className="hub2-published-note">{t("rightsQuestions.documentDraftNote")}</p>}<p style={{ whiteSpace: "pre-wrap" }}>{document.summary}</p><div style={{ whiteSpace: "pre-wrap" }}>{document.body}</div><small>{t("hub.version", { n: document.version })}</small>{canStaff&&<button type="button" className="outline-pill" onClick={onEdit}>{t("hub.edit")}</button>}{draft&&canStaff&&<button type="button" className="outline-pill" onClick={share}>{t("rightsQuestions.documentShare")}</button>}{shared&&<p role="status">{t(shared==="ok"?"rightsQuestions.documentShared":"rightsQuestions.documentShareFailed")}</p>}</article></Dialog>;
}

function KnowledgeDialog({ article, chapterId, preview, t, onClose, onSave, onRetire }) {
  const [status, setStatus] = useState(article?.status === "published" ? "published" : "draft");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState(false);

  function submit(event) {
    return runBusyWrite(busyWriteRef, "knowledge", () => submitNow(event), event);
  }

  async function submitNow(event) {
    event.preventDefault();
    if (busy || (status === "published" && !confirmed)) return;
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError(false);
    try {
      await onSave({
        articleId: article?.id || null,
        chapterId: chapterId || null,
        kind: values.kind,
        title: values.title,
        articleRef: values.articleRef,
        body: values.body,
        keywords: String(values.keywords || "").split(",").map((keyword) => keyword.trim()).filter(Boolean),
        status,
        confirmVerified: status === "published" && confirmed,
      });
      onClose();
    } catch (saveError) {
      setError(rpcErrorKeyStrict(saveError, "hub.knowledge.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  function retire() {
    return runBusyWrite(busyWriteRef, "knowledge", () => retireNow());
  }

  async function retireNow() {
    if (busy || !article || !window.confirm(t("hub.knowledge.retireConfirm"))) return;
    setBusy(true);
    setError("");
    try {
      await onRetire(article.id, article.chapterId || chapterId || null);
      onClose();
    } catch (retireError) {
      setError(rpcErrorKeyStrict(retireError, "hub.knowledge.retireFailed"));
    } finally {
      setBusy(false);
    }
  }

  const publishBlocked = status === "published" && !confirmed;
  return <Dialog eyebrow={t("hub.knowledge.title")} title={article ? t("hub.knowledge.edit") : t("hub.knowledge.add")} onClose={onClose} wide>
    <form className="stack-form" onSubmit={submit}>
      <label>{t("hub.knowledge.kind")}<select name="kind" defaultValue={article?.kind || "contract"}><option value="contract">{t("hub.knowledge.kindContract")}</option><option value="rights">{t("hub.knowledge.kindRights")}</option><option value="faq">{t("hub.knowledge.kindFaq")}</option></select></label>
      <label>{t("hub.titleField")}<input name="title" maxLength="200" defaultValue={article?.title || ""} required /></label>
      <label>{t("hub.knowledge.ref")}<input name="articleRef" maxLength="120" defaultValue={article?.ref || ""} required /></label>
      <label>{t("hub.knowledge.body")}<textarea name="body" maxLength="100000" defaultValue={article?.body || ""} required /></label>
      <label>{t("hub.knowledge.keywords")}<input name="keywords" maxLength="1000" defaultValue={(article?.keywords || []).join(", ")} /></label>
      <label>{t("hub.knowledge.status")}<select name="status" value={status} onChange={(event) => { setStatus(event.target.value); setConfirmed(false); }}><option value="draft">{t("hub.knowledge.draft")}</option><option value="published">{t("hub.knowledge.published")}</option></select></label>
      {status === "published" && <label className="hub2-knowledge-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{t(preview ? "hub.knowledge.confirmPreview" : "hub.knowledge.confirm")}</label>}
      {error && <p className="hub2-knowledge-error" role="alert">{rpcErrorTextAtRender(t, error)}</p>}
      <div className="hub2-knowledge-dialog-actions">
        {article && article.status !== "retired" && <BusyButton type="button" className="outline-pill" pending={busy} onClick={retire}>{t("hub.knowledge.retire")}</BusyButton>}
        <BusyButton className="dialog-primary" pending={busy} disabled={publishBlocked}>{busy ? t("hub.knowledge.saving") : status === "published" ? t("hub.knowledge.publish") : t("hub.knowledge.saveDraft")}</BusyButton>
      </div>
    </form>
  </Dialog>;
}

function RecordDialog({ t, onClose, onSave, onArchive=null, item=null }) {
  return <FormDialog t={t} eyebrow={t("hub.record.title")} title={item?t("hub.editRecord"):t("hub.newRecord")} onClose={onClose} onSave={(values) => onSave({ ...values, occurredAt: localDateTimeInputToIso(values.occurredAt) })} submitLabel={t("hub.save")}><label>{t("hub.recordType")}<select name="recordType" defaultValue={item?.record_type||"minutes"}><HubEnumOptions t={t} family="recordType" /></select></label><label>{t("hub.titleField")}<input name="title" defaultValue={item?.title} maxLength="200" required /></label><label>{t("hub.body")}<textarea name="body" defaultValue={item?.body} maxLength="20000" required /></label><label>{t("hub.date")}<input type="datetime-local" name="occurredAt" defaultValue={item?.occurred_at ? localDateTimeInputValue(item.occurred_at) : ""} required /></label>{onArchive&&<ArchiveButton t={t} onArchive={onArchive} onDone={onClose}/>}</FormDialog>;
}

function HandshakeDialog({ t, orgs, onClose, onSave }) {
  return <FormDialog t={t} eyebrow={t("hub.partners.title")} title={t("hub.newHandshake")} onClose={onClose} onSave={onSave} submitLabel={t("hub.sendRequest")}><label>{t("hub.partner")}<select name="partnerOrgId" required><option value="">{t("hub.selectOrganization")}</option>{orgs.map((org) => <option key={org.id} value={org.id}>{org.name} · {org.city}, {org.state}</option>)}</select></label><label>{t("hub.titleField")}<input name="title" maxLength="160" required /></label><label>{t("hub.purpose")}<textarea name="purpose" maxLength="4000" required /></label><label>{t("hub.dataScope")}<select name="dataScope"><HubEnumOptions t={t} family="dataScope" /></select></label></FormDialog>;
}

function GovernanceDialog({ t, onClose, onSave }) {
  return <FormDialog t={t} eyebrow={t("hub.governance.title")} title={t("hub.newDataRequest")} onClose={onClose} onSave={onSave} submitLabel={t("hub.submit")}><label>{t("hub.requestType")}<select name="requestType"><option value="access">{t("hub.request.access")}</option><option value="correction">{t("hub.request.correction")}</option><option value="retention_question">{t("hub.request.retention")}</option></select></label><label>{t("hub.details")}<textarea name="details" maxLength="10000" required /></label></FormDialog>;
}

// BUG-UG-ACCOUNT-DELETION-REQUIRES-TWO-STEP-20261016: a member with
// no second factor confirms it is them with their password here; the route
// turns that into the fresh sign-in the database requires. A member with a
// factor keeps the recent two-step rule.
const DELETE_ERROR_KEYS = {
  indeterminate: ["hub.lifecycle.deleteIndeterminate", "hub.lifecycle.deleteIndeterminate"],
  "not-permitted": ["hub.lifecycle.deleteNotPermitted", "hub.lifecycle.deleteNotPermittedPassword"],
  "reauth-failed": ["hub.lifecycle.deleteReauthFailed", "hub.lifecycle.deleteReauthFailed"],
  "try-later": ["hub.lifecycle.deleteTryLater", "hub.lifecycle.deleteTryLater"],
  failed: ["hub.lifecycle.deleteFailed", "hub.lifecycle.deleteFailedPassword"],
};

export function DeleteAccountDialog({ t, onClose, onDelete, onIndeterminateClose, onDestructiveLockChange, sessionHold = false, passwordReauth = false }) {
  const [confirmation, setConfirmation] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState("");
  const [closeError, setCloseError] = useState(false);
  const confirmed = confirmation === "DELETE MY ACCOUNT";
  const retryBlocked = error === "indeterminate";
  // The protected interval: the irreversible request is unresolved while it
  // is in flight or while its outcome is indeterminate. A definitive failure
  // or a confirmed success resolves it, and the parent may replace or close
  // the dialog normally again. The cleanup releases the lock on unmount so a
  // successful close cannot strand the parent in a locked state.
  const unresolved = busy || retryBlocked;
  useEffect(() => {
    onDestructiveLockChange?.(unresolved);
    return () => onDestructiveLockChange?.(false);
  }, [onDestructiveLockChange, unresolved]);
  // The session already holds an unresolved deletion this dialog did not
  // initiate — the paired pane's mirrored copy of the same surface. One
  // irreversible request per session: this copy disarms instead of racing it.
  const holdElsewhere = sessionHold && !unresolved;
  const errorMessageKey = (DELETE_ERROR_KEYS[error] || DELETE_ERROR_KEYS.failed)[passwordReauth ? 1 : 0];
  function submit(event) {
    return runBusyWrite(busyWriteRef, "delete", () => submitNow(event), event);
  }

  async function submitNow(event) {
    event.preventDefault();
    if (!confirmed || busy || retryBlocked || holdElsewhere) return;
    // Arm the parent's lock synchronously, before the irreversible request is
    // dispatched. The passive effect below re-affirms it after commit, but a
    // parity message already queued behind this click could otherwise apply
    // in the window before the effect flushes and unmount this dialog with
    // the request in flight.
    onDestructiveLockChange?.(true);
    setBusy(true);
    setError("");
    try {
      if (passwordReauth && password) await onDelete(confirmation, { password });
      else await onDelete(confirmation);
      onClose();
    } catch (deleteError) {
      const code = deleteError?.code;
      setError(code === "account-delete-indeterminate"
        ? "indeterminate"
        : code === "not-permitted" || code === "reauth-failed" || code === "try-later"
          ? code
          : "failed");
      if (code === "reauth-failed") setPassword("");
      setBusy(false);
    }
  }
  async function beforeClose() {
    if (busy) return false;
    if (error !== "indeterminate") return true;
    setCloseError(false);
    try {
      await onIndeterminateClose();
      return true;
    } catch {
      setCloseError(true);
      return false;
    }
  }
  return <Dialog eyebrow={t("hub.governance.title")} title={t("hub.lifecycle.deleteDialogTitle")} onClose={onClose} beforeClose={beforeClose} closeBlocked={unresolved} wide>
    <form className="stack-form" onSubmit={submit} aria-busy={busy || undefined}>
      <p className="hub2-lifecycle__warning">{t("hub.lifecycle.deleteWarning")}</p>
      <p>{t("hub.lifecycle.deleteRetained")}</p>
      <p>{t(passwordReauth ? "hub.lifecycle.deletePasswordIntro" : "hub.lifecycle.deleteMfa")}</p>
      {passwordReauth && <label>{t("hub.lifecycle.deletePassword")}<BusyInput type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" maxLength={256} pending={busy} disabled={retryBlocked} /></label>}
      <label>{t("hub.lifecycle.deleteConfirmation")}<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck="false" /></label>
      {error && <p className="hub2-lifecycle__error" role="alert">{t(errorMessageKey)}</p>}
      {closeError && <p className="hub2-lifecycle__error" role="alert">{t("toast.signOutCleanupFailed")}</p>}
      {holdElsewhere && <p className="hub2-lifecycle__error" role="alert">{t("hub.lifecycle.deleteHoldElsewhere")}</p>}
      <p className="visually-hidden" role="status" aria-live="polite">{busy ? t("hub.lifecycle.deleting") : ""}</p>
      <BusyButton className="dialog-primary hub2-lifecycle__delete-confirm" pending={busy} disabled={!confirmed || retryBlocked || holdElsewhere}
        disabledReason={confirmed ? null : t(confirmation ? "hub.lifecycle.deletePhraseMismatch" : "hub.lifecycle.deletePhraseEmpty")}>{busy ? t("hub.lifecycle.deleting") : t("hub.lifecycle.deletePermanent")}</BusyButton>
    </form>
  </Dialog>;
}
