import { PlatformAnnouncements, platformAnnouncementsShown } from "../features/platformAnnouncements/PlatformAnnouncements.jsx";
import { announcementCopy } from "../features/platformAnnouncements/copy.js";
import { applyMessageTombstone } from "../features/messaging/bodyLifecycle.js";
import { withSystemSenderLabels } from "../features/messaging/systemLabels.js";
import { NoticeGlowLabels, noticeGlowAttributes } from "../features/chapterNotices/NoticeGlow.jsx";
import { noticeChaptersFor, noticeTileGlow } from "../features/chapterNotices/noticeGlow.js";
import { AlarmClock, Bot, CalendarClock, Link2, Search, Star, Users } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BusyButton, BusyInput, BusyTextarea } from "../components/BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { createOperationKeys } from "../lib/operationKey.js";
import { Dialog } from "../components/Dialog.jsx";
import { MessageWorkflowPicker } from "../components/MessageWorkflowPicker.jsx";
import { SourceTaskAction } from "../components/SourceTaskAction.jsx";
import { MessageActions } from "../components/MessageActions.jsx";
import { Icon as AltIcon } from "../alt/icons.jsx";
import { countKey } from "../lib/i18n.js";
import { formatEasternTimestamp } from "../lib/easternTimestamp.js";
import { localDateTimeInputValue } from "../lib/localDateTime.js";
import { activeMentionQuery, completeMention, filterMentionCandidates } from "../lib/caseMentions.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { NoStewardNote } from "../components/NoStewardNote.jsx";
import { noStewardNamed } from "../lib/stewardConversations.js";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { engagementApi, requestMessageBriefing } from "../features/engagement/api.js";
import { countUnreadInboxItems, inboxUnreadCount, isInboxItemUnread, projectMessageBody } from "../features/messaging/index.js";
import { canOfferSourceTask, isDeliveredMessage } from "../features/messaging/sourceTask.js";
import { useLandOnMessage } from "../features/messaging/useLandOnMessage.js";
import { EARLIER_HISTORY_RECONCILE_MS, useEarlierHistory } from "../features/messaging/earlierHistory.js";
import { EarlierThreadHistory, usePrependAnchor, withCreatedAt } from "../features/messaging/EarlierThreadHistory.jsx";
import { applyTombstonesToLanded, isPermissionRefusal, isSourceGone, mergeLandedMessage, mergeLandedRows } from "../features/connectedWorkflows/landing.js";
import {
  MESSAGE_WORKFLOW_DEFAULT,
  findStewardConversation,
  groupMessageItems,
  limitMessageGroups,
  useMessageWorkflowOnboarding,
  useMessageWorkflowPreference,
} from "../lib/messageWorkflow.js";
import { rpcErrorKeyStrict, rpcErrorTextAtRender } from "../lib/rpcErrorText.js";
import { conversationAudience, conversationVisibility } from "../features/messaging/visibility.js";
import { sanitizePeerContactProjection } from "../lib/peerContactBridge.js";
import { contactableOfficers, mergeOfficerConversation } from "../features/messaging/officerContact.js";
import { leadershipRoleLine } from "../lib/chapterLeadership.js";
import { CrossChapterPeersSection } from "../features/messaging/CrossChapterPeersSection.jsx";
import { mergeCrossChapterConversations } from "../features/messaging/crossChapterPeers.js";
import { postBody } from "../lib/bilingualContent.js";
import { notePreview } from "../lib/notePreview.js";
import { Pager } from "../components/Pager.jsx";

function messageTime(value, lang) {
  return formatEasternTimestamp(value, lang, { daylightName: true })?.text || "";
}

// Desktop replaces each page; phone Show more keeps its incremental flow.
const INBOX_PAGE = 20;

// First letters of the first two words of a real sender string — derived
// presentation, never seeded. "Chapter Steward" -> "CS".
function initialsOf(name) {
  return String(name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");
}

export const MESSAGE_FILTERS = ["all", "unread", "direct", "channel", "task", "announcement", "saved", "reminder"];

// SEC-UG-MESSAGE-BODY-LIFECYCLE: a redacted message arrives with an empty
// body and a tombstone. Every direct-message renderer goes through here so the
// removed-content notice is rendered in the reader's language rather than as a
// server-authored string, and so no renderer can forget.
function MessageBody({ message }) {
  const { t } = useLang();
  const projected = projectMessageBody(message);
  if (!projected.redacted) return <p>{message.body}</p>;
  return <p className="inbox-msg__redacted" data-redacted="true"><em>{t(projected.noticeKey)}</em></p>;
}

function timestampOf(...values) {
  for (const value of values) {
    if (!value) continue;
    const timestamp = new Date(value).getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

// A first message waits here while the inbox route unmounts and remounts (a
// slow reload shows the loading screen in its place), so a failed or
// interrupted Start conversation never costs the member their text. Memory
// only: a grievance draft is not written to device storage, and the key names
// the member so a second account in the same tab never sees it.
const firstMessageDrafts = new Map();
// Officer drafts and their operation keys share the same member and recipient
// scope. Neither expires while an unchanged draft can still be retried.
const firstOfficerOperations = createOperationKeys(undefined, { maxAgeMs: Infinity });
// A Start conversation by the same key: { pending } while it runs, then
// { settled } until a form for that key applies it. A form mounted while it
// runs stays disabled and settles with it, so the member can neither edit
// text the request is about to clear nor start twice, and an outcome that
// lands while no form is mounted waits for the next one.
const firstMessageStarts = new Map();
// How many forms are mounted per key. A successful start that lands while no
// form for its key is mounted is taken by the Messages view instead, because
// once the inbox lists the new conversation the form that would apply it no
// longer renders (BUG-UG-FIRST-MESSAGE-START-NOT-SELECTED-AFTER-LEAVING-20261008).
const firstMessageForms = new Map();

// Hands onStarted the conversation a settled start for this member opened,
// when no form for its key is mounted to apply it; a start still running is
// checked again once it settles. Keys begin with the member id, so another
// account in the same tab never takes it.
function takeUnclaimedStarts(memberId, onStarted, live) {
  if (!memberId || !live()) return;
  for (const [key, entry] of firstMessageStarts) {
    if (!key.startsWith(`${memberId}:`)) continue;
    if (entry.pending) {
      // Runs after the submit handler has stored the outcome or handed it to
      // a mounted form.
      entry.pending.then(() => takeUnclaimedStarts(memberId, onStarted, live));
    } else if (entry.settled?.conversationId && !firstMessageForms.get(key)) {
      firstMessageStarts.delete(key);
      onStarted(entry.settled.conversationId, key);
    }
  }
}

// Only a returned conversation id is a started conversation. Anything else,
// such as a start superseded by a newer session, keeps the draft.
function firstMessageOutcome({ result, failure }) {
  if (result?.conversationId) return { conversationId: result.conversationId };
  return { failure: failure ?? new Error("The conversation was not started.") };
}

// `visibility` is the who-can-read sentence for this form's conversation (the
// steward statement unless the form addresses one person). `renderRefusal`
// offers a next step under a refusal the server explains; it gets the
// translated refusal key and the text still in the box.
function peerSendUnconfirmed(error) {
  return !error?.code && !["peer_session_changed", "officer_unavailable", "officer_contact_limit"].includes(error?.details);
}

function FirstConversationForm({ onStart, onStarted, t, draftKey = "", keyedOfficer = false, visibility = null, renderRefusal = null, unavailableKey = null, renderUnavailable = null }) {
  const formId = useId();
  const [draft, setDraftState] = useState(() => (draftKey && firstMessageDrafts.get(draftKey)) || "");
  function setDraft(value) {
    setDraftState(value);
    if (!draftKey) return;
    if (keyedOfficer && value.trim() !== draft.trim()) firstOfficerOperations.settle(draftKey);
    if (value) firstMessageDrafts.set(draftKey, value);
    else firstMessageDrafts.delete(draftKey);
  }
  const [busy, setBusy] = useState(() => Boolean(draftKey && firstMessageStarts.get(draftKey)?.pending));
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState(false);
  const mounted = useRef(false);
  const apply = useRef(null);
  apply.current = (outcome) => {
    setBusy(false);
    if (draftKey) setDraftState(firstMessageDrafts.get(draftKey) || "");
    else if (!outcome.failure) setDraftState("");
    // A refusal the server explains (such as no steward assigned yet) reads
    // as that explanation; anything else keeps the generic copy.
    if (outcome.failure) setError(keyedOfficer && peerSendUnconfirmed(outcome.failure)
      ? "inbox.peerMessageUnconfirmed"
      : rpcErrorKeyStrict(outcome.failure, "inbox.startConversationError"));
    else onStarted(outcome.conversationId);
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!draftKey) return undefined;
    firstMessageForms.set(draftKey, (firstMessageForms.get(draftKey) || 0) + 1);
    return () => {
      const count = (firstMessageForms.get(draftKey) || 1) - 1;
      if (count) firstMessageForms.set(draftKey, count);
      else firstMessageForms.delete(draftKey);
    };
  }, [draftKey]);
  // Apply an outcome left for this key, or follow a start still running.
  useEffect(() => {
    if (!draftKey) return undefined;
    let live = true;
    const take = () => {
      const entry = firstMessageStarts.get(draftKey);
      if (!live || !entry?.settled) return;
      firstMessageStarts.delete(draftKey);
      apply.current(entry.settled);
    };
    const entry = firstMessageStarts.get(draftKey);
    if (entry?.pending) entry.pending.then(take);
    else take();
    return () => { live = false; };
  }, [draftKey]);
  return (
    <form className="inbox-first" onSubmit={(event) => runBusyWrite(busyWriteRef, "start", async () => {
      event.preventDefault();
      if (busy) return;
      const body = draft.trim();
      if (!body) return;
      setBusy(true);
      setError(false);
      const pending = new Promise((resolve) => resolve(keyedOfficer
        ? onStart(body, firstOfficerOperations.keyFor(draftKey))
        : onStart(body)))
        .then((result) => ({ result }), (failure) => ({ failure }))
        .then(firstMessageOutcome);
      if (!draftKey) {
        const outcome = await pending;
        if (mounted.current) apply.current(outcome);
        return;
      }
      const entry = { pending };
      firstMessageStarts.set(draftKey, entry);
      const outcome = await pending;
      // Every form for this key was disabled while the request ran, so the
      // stored draft is still the submitted text: clear it only on success.
      if (!outcome.failure) {
        firstMessageDrafts.delete(draftKey);
        if (keyedOfficer) firstOfficerOperations.settle(draftKey);
      }
      if (firstMessageStarts.get(draftKey) !== entry) return;
      firstMessageStarts.set(draftKey, { settled: outcome });
      if (mounted.current) {
        firstMessageStarts.delete(draftKey);
        apply.current(outcome);
      }
    }, event)}>
      {/* #6876: said before the member writes when the server already knows
          nobody could read this message, with the same way out as a refusal. */}
      {unavailableKey && !error && (
        <div className="inbox-first__unavailable" role="status">
          <p id={`${formId}-unavailable`}>{t(unavailableKey)}</p>
          {renderUnavailable ? renderUnavailable(draft) : null}
        </div>
      )}
      <label htmlFor={`${formId}-message`}>{t("inbox.firstMessageLabel")}</label>
      {/* Said before the first word is stored, not only once a thread exists. */}
      <p id={`${formId}-visibility`} className="inbox-visibility">{visibility ?? conversationVisibility(t, { kind: "steward" })}</p>
      <BusyTextarea id={`${formId}-message`} aria-describedby={unavailableKey && !error ? `${formId}-unavailable ${formId}-visibility` : `${formId}-visibility`} maxLength="4000" required value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={t("inbox.firstMessagePlaceholder")} pending={busy} />
      <BusyButton type="submit" className="dialog-primary" pending={busy}>{busy ? t("inbox.startingConversation") : t("inbox.startConversation")}</BusyButton>
      {error && <p role="alert">{rpcErrorTextAtRender(t, error)}</p>}
      {error && renderRefusal ? renderRefusal(error, draft) : null}
    </form>
  );
}

export { localDateTimeInputValue } from "../lib/localDateTime.js";

// #9470 (W8-9): what a re-read two-person list says about the conversation a
// notice names. A list that failed to load asks to try again. The server sends
// at most the 50 most recently updated conversations, so a full list that lacks
// it proves nothing and the landing waits. Only a loaded, shorter list that
// lacks it says the conversation is gone.
const PEER_LIST_WINDOW = 50;
function peerLandingVerdict(list, id) {
  if (!list || list.unavailable === true || list.available !== true) return "failed";
  const conversations = list.conversations || [];
  if (conversations.some((item) => item.id === id)) return "found";
  return conversations.length >= PEER_LIST_WINDOW ? "wait" : "gone";
}

export function MessagesView({ announcementContext = null, alt = false, onOpenHome = null, data: sourceData, onMessageRedacted = () => {}, onProfile, onAssistant, onSendMessage, onSendTaskMessage, onStartConversation = null, onStartStewardConversation = null, stewardMessageAvailable = null, stewardPresence = null, onReadConversation, onReadBroadcast, onOpenTopics, onOpenTasks, onOpenCases, onRequestSteward = null, messagingApi, peerContactApi = null, onPeerContactChange = null, officerDirectoryApi = null, onStartOfficerConversation = null, crossChapterApi = null, onNotice = () => {}, onCreateTaskFromSource = null, onResolveSourceTask = null, renderConnectedActions = null, onOpenTask = null, engagementSession = null, engagementClient = null, focus = null, desktop = false, staffAccess = false, visitorMessageWorkflow = null, noticeDesk = null, personalReminders = null, notificationOpenIntent = null }) {
  const { t, lang } = useLang();
  // #9527: the page is named as the worn hat's rail names it (Inbox under a
  // staff hat, Messages for a member), so an organization's rename of either
  // reaches the heading and the tab too.
  const pageName = t(staffAccess ? "nav.inbox" : "nav.messages");
  const [tombstones, setTombstones] = useState([]);
  const [cancelledReminderIds, setCancelledReminderIds] = useState([]);
  const [pendingSteward, setPendingSteward] = useState(null);
  // REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030: the
  // officer the member chose to write to, before the first message exists.
  const [pendingOfficer, setPendingOfficer] = useState(null);
  const [officersOpen, setOfficersOpen] = useState(false);
  // REQ-UG-PEER-ROLE-CONTACT-ACROSS-CHAPTERS-20261109: the caller's
  // cross-chapter list, read once so the entry shows only to someone who
  // holds an enabled access level.
  const [crossChapter, setCrossChapter] = useState(null);
  const [crossChapterOpen, setCrossChapterOpen] = useState(false);
  // A link or search hit can name one exact message inside a conversation (or a
  // task conversation). It is a one-shot landing instruction, consumed by the
  // thread that shows it and dropped as soon as the member opens anything by hand.
  // { conversationId | taskId, messageId }
  const [landing, setLanding] = useState(null);
  // What the exact-source loader returned for a landing the loaded list could not
  // satisfy, and how that request stands: null | "loading" | "unavailable" | "failed".
  const [landed, setLanded] = useState(null);
  const [landingStatus, setLandingStatus] = useState(null);
  // The same for a task conversation (messagingApi.loadTaskLanding): the board's
  // window is not proof that a task or its message is absent.
  const [landedTask, setLandedTask] = useState(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const landingRun = useRef(0);
  const requestedLanding = useRef(null);
  const data = useMemo(() => tombstones.reduce(applyMessageTombstone, {
    ...sourceData,
    conversations: sourceData.conversations.map((row) => withSystemSenderLabels(row, t)),
    broadcasts: sourceData.broadcasts.map((row) => withSystemSenderLabels(row, t)),
  }), [tombstones, sourceData, t]);
  function reconcileMessage(message) {
    if (!message.redacted_at) return;
    setTombstones((current) => [...current.filter((row) => row.id !== message.id), message]);
    onMessageRedacted(message);
  }
  // onProfile/onAssistant stay in the signature (App passes them via {...shared});
  // the global mobile top bar owns those controls now, so this view renders no
  // top chrome of its own. Referenced here so the contract is explicit.
  void onProfile; void onAssistant;
  const [query, setQuery] = useDeviceParityState("messages.query", "");
  const [filter, setFilter] = useDeviceParityState("messages.filter", "all");
  const [conversationId, setConversationId] = useDeviceParityState("messages.conversationId", null);
  const [broadcastId, setBroadcastId] = useDeviceParityState("messages.broadcastId", null);
  // REQ-UG-CHAPTER-NOTICE-GLOW-COLOURS-20261113 (#8627): the chapter
  // and glow colour of each chapter notice, read the first time an
  // announcement is opened in a session (only its reading tile glows) and
  // again only for announcements that read did not cover, so the inbox list
  // and a return to Messages issue no reads. The fixture app has no client and
  // brings its own map. A failed read (an older database, a refused session)
  // leaves every tile without a glow.
  const [loadedNoticeChapters, setLoadedNoticeChapters] = useState(null);
  const broadcastIdList = sourceData.broadcasts.map((item) => item.id).join("\n");
  const readingBroadcast = Boolean(broadcastId) && sourceData.broadcasts.some((item) => item.id === broadcastId);
  useEffect(() => {
    if (!engagementClient || !readingBroadcast) return undefined;
    let active = true;
    const memberId = data.member?.id || null;
    noticeChaptersFor(engagementClient, broadcastIdList.split("\n"), memberId).then((value) => { if (active) setLoadedNoticeChapters({ memberId, value }); }, () => {});
    return () => { active = false; };
  }, [engagementClient, readingBroadcast, broadcastIdList, data.member?.id]);
  // Colours read for one member are never shown to
  // another; a changed member waits for their own read.
  const noticeChapters = (loadedNoticeChapters?.memberId === (data.member?.id || null) ? loadedNoticeChapters.value : null)
    ?? sourceData.noticeChapters ?? null;
  const [taskThreadId, setTaskThreadId] = useDeviceParityState("messages.taskThreadId", null);
  const [peerConversationId, setPeerConversationId] = useDeviceParityState("messages.peerConversationId", null);
  const [peerWorkspace, setPeerWorkspace] = useDeviceParityState("messages.peerWorkspace", () => data.peerContact || null);
  const [contactsOpen, setContactsOpen] = useState(false);
  // REQ-UG-MESSAGES-COMPOSER-LAYOUT-20261102: which Announcements
  // task the desktop reading pane shows while nothing is open in it.
  const [announcementTask, setAnnouncementTask] = useState(null);
  const memberId = data.member?.id || "";
  // Read-state changes do not change every other inbox timestamp. Cache the
  // rendered dates within this member/language's mounted inbox, keeping the
  // shared formatter's locale, clock and time-zone behavior intact.
  const inboxDate = useMemo(() => {
    const dates = new Map();
    return (value) => {
      if (!dates.has(value)) dates.set(value, messageTime(value, lang));
      return dates.get(value);
    };
  // Reset even when the next account happens to carry the same timestamps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId, lang]);
  const inboxTitleCompare = useMemo(() => new Intl.Collator(lang).compare, [lang]);
  const accountWorkflow = useMessageWorkflowPreference(visitorMessageWorkflow ? "" : memberId);
  const [workflow, setWorkflow] = visitorMessageWorkflow ?? accountWorkflow;
  // Below the desktop split the list has no bounded pane of its own, so it
  // shows a page at a time; a new filter, search or layout starts over.
  const [narrowWindow, setNarrowWindow] = useState({ key: null, count: INBOX_PAGE });
  const [desktopWindow, setDesktopWindow] = useState({ key: null, page: 1 });
  const inboxListRef = useRef(null);
  const focusPage = useRef(false);
  // A first conversation that started while its form was gone (the member
  // left Messages, or the new conversation already replaced the empty inbox)
  // is still the one to open.
  useEffect(() => {
    let live = true;
    // StrictMode cleans up and replays effects before microtasks run. Leave
    // the start for the live setup, after device-parity state is registered.
    const onStarted = (id, key = "") => {
      // Consume the start, but keep an explicit URL/search destination. Its
      // landing effect runs before this deferred claim (or a pending result).
      const params = new URLSearchParams(window.location.search);
      if (params.get("conversation") || params.get("broadcast") || params.get("taskThread") || params.get("task")
        || focus?.conversationId || focus?.broadcastId || focus?.startStewardUserId || focus?.startOfficerUserId) return;
      // An officer conversation is a two-person conversation, not a steward thread.
      if (key.includes(":officer:")) {
        setPeerConversationId(id);
        setConversationId(null);
        return;
      }
      setConversationId(id);
      setPeerConversationId(null);
    };
    queueMicrotask(() => takeUnclaimedStarts(memberId, onStarted, () => live));
    return () => { live = false; };
  }, [memberId, data.conversations, setConversationId, setPeerConversationId, focus]);
  const [onboarded, completeOnboarding] = useMessageWorkflowOnboarding(visitorMessageWorkflow ? "" : memberId);
  const [onboardingChoice, setOnboardingChoice] = useState(workflow);
  const [onboardingExpanded, setOnboardingExpanded] = useState(false);
  // The alternate shell's details pane (pages/ws-messages.js info-open).
  const [altInfoOpen, setAltInfoOpen] = useState(false);
  useEffect(() => {
    if (!alt || !altInfoOpen) return undefined;
    const close = (event) => {
      if (event.key !== "Escape" || document.querySelector("[role=dialog][aria-modal=true]")) return;
      setAltInfoOpen(false);
      document.querySelector(".ug-msg-info-btn")?.focus();
    };
    document.addEventListener("keydown", close);
    const timer = window.setTimeout(() => document.querySelector(".ug-msg-info-x")?.focus(), 30);
    return () => { document.removeEventListener("keydown", close); window.clearTimeout(timer); };
  }, [alt, altInfoOpen]);
  const [briefingExpanded, setBriefingExpanded] = useState(false);

  useEffect(() => setOnboardingChoice(workflow), [memberId, workflow]);

  // A real server refresh replaces the shared snapshot once. Both paired trees
  // run this effect, but the shared setter computes the same value and never
  // depends on the local peer state, so it cannot form a reset loop.
  useEffect(() => setPeerWorkspace(data.peerContact || null), [data.peerContact, setPeerWorkspace]);

  // Links are applied when the view mounts, and again when the address changes
  // underneath it: the app's navigate() does not remount a view that is already on
  // screen (a reminder's source link followed from Messages itself), and an address
  // that did not change is never applied twice unless a notice opens it again.
  const routeSearch = typeof window === "undefined" ? "" : window.location.search;
  // #9173 round 1: each notice opened into Messages is applied again even when
  // its address is the one already shown (a second notice for the same
  // conversation after the member chose another by hand).
  // An open of another screen leaves the last one in place.
  const openedIntoMessages = typeof notificationOpenIntent?.path === "string"
    && notificationOpenIntent.path.startsWith("/m/messages") ? notificationOpenIntent.id : null;
  const [messagesOpenIntent, setMessagesOpenIntent] = useState(openedIntoMessages);
  if (openedIntoMessages !== null && openedIntoMessages !== messagesOpenIntent) setMessagesOpenIntent(openedIntoMessages);
  const [pendingPeerLanding, setPendingPeerLanding] = useState(null);
  // #9470 (W8-9): the loader's two-person list when the notice was opened. A
  // list that arrives after it and lacks the conversation is judged by
  // peerLandingVerdict: a failed read offers Try again, a full window waits,
  // and only a loaded shorter list says the message is no longer available.
  const peerLandingBase = useRef(null);
  // The newest two-person list and pending landing, for a Try again read that
  // settles later: its answer counts only while both are still the ones it
  // started from.
  const latestPeerContact = useRef(data.peerContact);
  latestPeerContact.current = data.peerContact;
  const latestPendingPeer = useRef(pendingPeerLanding);
  latestPendingPeer.current = pendingPeerLanding;
  useEffect(() => {
    if (!pendingPeerLanding) return;
    // Something else chosen meanwhile wins over a landing still waiting.
    if (conversationId || broadcastId || taskThreadId) { setPendingPeerLanding(null); return; }
    if (!(peerWorkspace?.conversations || []).some((item) => item.id === pendingPeerLanding)) {
      const reread = data.peerContact;
      if (!reread || reread === peerLandingBase.current) return;
      // Each list that arrives is judged once.
      peerLandingBase.current = reread;
      const verdict = peerLandingVerdict(reread, pendingPeerLanding);
      if (verdict === "failed") setLandingStatus("failed");
      else if (verdict === "wait") setLandingStatus(null);
      else if (verdict === "gone") { setPendingPeerLanding(null); setLandingStatus("unavailable"); }
      return;
    }
    setPeerConversationId(pendingPeerLanding);
    setPendingPeerLanding(null);
    setLandingStatus(null);
  }, [pendingPeerLanding, peerWorkspace, data.peerContact, conversationId, broadcastId, taskThreadId, setPeerConversationId]);
  useEffect(() => {
    let params;
    try { params = new URLSearchParams(window.location.search); } catch { return; }
    const conversation = params.get("conversation");
    const broadcast = params.get("broadcast");
    // `taskThread` is the connected-workflow route; `task` remains its alias.
    const taskConversation = params.get("taskThread") || params.get("task");
    // #9173: a private two-person message notice opens its conversation.
    const peerConversation = params.get("peerConversation");
    const message = params.get("message");
    // A link applied to a view that is already showing something supersedes any
    // landing still in hand (and, with it, an answer still on its way).
    if (conversation || broadcast || taskConversation || peerConversation) cancelLanding();
    const known = conversation && data.conversations.some((item) => item.id === conversation);
    // A conversation this loader never carried is still opened when the surface
    // can hydrate it exactly (messagingApi.loadSourceLanding); without that the
    // unknown id leaves the ordinary surface intact, as before.
    if (known || (conversation && messagingApi?.loadSourceLanding)) {
      setFilter("all");
      setConversationId(conversation);
      // One selection at a time: a direct-conversation link closes an open
      // peer or task thread, so no surface pairs one recipient's header with
      // another's composer.
      setBroadcastId(null);
      setPeerConversationId(null);
      setTaskThreadId(null);
      if (message || !known) setLanding({ conversationId: conversation, messageId: message || null });
      if (known) Promise.resolve(onReadConversation(conversation)).catch(() => {});
    } else if (broadcast && data.broadcasts.some((item) => item.id === broadcast)) {
      setFilter("all");
      setBroadcastId(broadcast);
      setConversationId(null);
      setPeerConversationId(null);
      setTaskThreadId(null);
      Promise.resolve(onReadBroadcast(broadcast)).catch(() => {});
    } else if (taskConversation && ((data.tasks || []).some((item) => item.id === taskConversation) || messagingApi?.loadTaskLanding)) {
      // A task's own conversation. An id the board window does not carry is asked
      // of the server (loadTaskLanding), never assumed absent.
      const knownTask = (data.tasks || []).some((item) => item.id === taskConversation);
      setFilter("all");
      setConversationId(null);
      setBroadcastId(null);
      setPeerConversationId(null);
      setTaskThreadId(taskConversation);
      if (message || !knownTask) setLanding({ taskId: taskConversation, messageId: message || null });
    } else if (peerConversation) {
      // The member's own conversations only: the id is opened once the
      // two-person list (re-read when the notice arrived or was opened)
      // carries it; an id it never carries leaves the ordinary inbox.
      setFilter("all");
      setConversationId(null);
      setBroadcastId(null);
      setTaskThreadId(null);
      peerLandingBase.current = data.peerContact;
      setPendingPeerLanding(peerConversation);
    } else if (MESSAGE_FILTERS.includes(params.get("filter"))) {
      // REQ-UG-DEAD-IN-APP-LINKS-404-20261030: /m/announcements
      // redirects here with ?filter=announcement, so the typed address opens
      // the Announcements filter rather than the whole inbox.
      setFilter(params.get("filter"));
    }
    // Source links contain opaque ids and select only records already present
    // in this authorized loader; unknown ids leave the ordinary surface intact.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeSearch, messagesOpenIntent]);

  // Search deep-link: land on the item itself, mirroring a tap on it (the
  // open marks it read, like the click handlers below do). focus.tab remains
  // accepted for compatibility with older search results; the unified inbox
  // returns to All so the selected record is visible in context.
  useEffect(() => {
    if (!focus) return;
    if (focus.conversationId) {
      setFilter("all");
      setConversationId(focus.conversationId);
      setBroadcastId(null);
      setPeerConversationId(null);
      setTaskThreadId(null);
      if (focus.messageId) setLanding({ conversationId: focus.conversationId, messageId: focus.messageId });
      Promise.resolve(onReadConversation(focus.conversationId)).catch(() => {});
    }
    // Contact pressed on a steward card that has no thread yet. The composer
    // below is the only way a steward-bound conversation is created, so the
    // member writes the first message rather than landing in an empty shell.
    if (focus.startStewardUserId) {
      setFilter("all");
      setConversationId(null);
      setPendingSteward({ id: focus.startStewardUserId, name: focus.stewardName ?? null });
    }
    // Message pressed beside an officer under Who runs this chapter.
    if (focus.startOfficerUserId) {
      setFilter("all");
      setConversationId(null);
      setPeerConversationId(null);
      setBroadcastId(null);
      setTaskThreadId(null);
      setPendingSteward(null);
      setPendingOfficer({ id: focus.startOfficerUserId, name: focus.officerName ?? null });
    }
    if (focus.broadcastId) {
      setFilter("all");
      setBroadcastId(focus.broadcastId);
      Promise.resolve(onReadBroadcast(focus.broadcastId)).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the handlers are inline props re-created every App render; including them would re-fire the mark-read write for the same focus on every render.
  }, [focus]);

  // Cold links. A link can name a conversation the loader never carried, or a
  // message older than what a loaded thread holds. When the surface can hydrate
  // (messagingApi.loadSourceLanding) the exact source is read under the member's
  // own scope and merged into what is visible; without it the view keeps its old
  // behaviour. One attempt per instruction however often `data` refreshes; a new
  // instruction, a manual open or an unmount supersedes the attempt, and a
  // superseded answer is dropped.
  const landingKey = landing ? [landing.conversationId ?? "", landing.taskId ?? "", landing.messageId ?? ""].join("\u001f") : null;
  // Hydrated rows are private content fetched for one reader. When the signed-in
  // member changes, whatever is in flight is void and nothing hydrated for the
  // previous reader may be shown to the next.
  const readerRef = useRef(memberId);
  useEffect(() => {
    if (readerRef.current === memberId) return;
    readerRef.current = memberId;
    landingRun.current += 1;
    // The previous reader's instruction is void. Marking it as already asked keeps
    // the hydration effects below, which run in this same commit with the old
    // instruction still in hand, from asking for it again as the new reader.
    requestedLanding.current = landingKey;
    setLanding(null);
    setLanded(null);
    setLandedTask(null);
    setLandingStatus(null);
  }, [memberId, landingKey]);
  useEffect(() => {
    landingRun.current += 1;
    requestedLanding.current = null;
    setLandingStatus(null);
  }, [landingKey]);
  useEffect(() => () => { landingRun.current += 1; }, []);
  useEffect(() => {
    if (!landing?.conversationId || requestedLanding.current === landingKey) return;
    const loaded = data.conversations.find((item) => item.id === landing.conversationId);
    if (landing.messageId ? loaded?.messages?.some((item) => item.id === landing.messageId) : loaded) return;
    if (!messagingApi?.loadSourceLanding) return;
    requestedLanding.current = landingKey;
    const run = ++landingRun.current;
    const { conversationId: target, messageId } = landing;
    setLandingStatus("loading");
    messagingApi.loadSourceLanding({ conversationId: target, messageId: messageId ?? null }).then((result) => {
      if (run !== landingRun.current) return;
      if (!result?.message && !result?.conversation) {
        setLandingStatus("unavailable");
        setConversationId((current) => (current === target ? null : current));
        return;
      }
      setLanded({ conversationId: target, conversation: result.conversation ?? null, message: result.message ?? null });
      setLandingStatus(null);
    }).catch((error) => {
      if (run !== landingRun.current) return;
      const refused = isPermissionRefusal(error) || isSourceGone(error);
      setLandingStatus(refused ? "unavailable" : "failed");
      if (refused) setConversationId((current) => (current === target ? null : current));
    });
  }, [landing, landingKey, data.conversations, messagingApi, retryNonce, setConversationId]);
  useEffect(() => {
    if (!landing?.taskId || requestedLanding.current === landingKey) return;
    const { taskId, messageId } = landing;
    const loadedTask = (data.tasks || []).find((item) => item.id === taskId);
    const loadedMessages = (data.taskMessages || []).filter((item) => item.taskId === taskId && [item.senderId, item.recipientId].includes(memberId));
    if (messageId ? loadedMessages.some((item) => item.id === messageId) : loadedTask) return;
    if (!messagingApi?.loadTaskLanding) return;
    requestedLanding.current = landingKey;
    const run = ++landingRun.current;
    setLandingStatus("loading");
    messagingApi.loadTaskLanding({ taskId, messageId: messageId ?? null }).then((result) => {
      if (run !== landingRun.current) return;
      // Only this reader's own task messages, and only for the source asked for:
      // an answer for another task, or that omits the named message, is not this
      // link's source.
      const messages = (result?.messages || []).filter((item) => item.taskId === taskId && [item.senderId, item.recipientId].includes(memberId));
      if (result?.task?.id !== taskId || (messageId && !messages.some((item) => item.id === messageId))) {
        setLandingStatus("unavailable");
        setTaskThreadId((current) => (current === taskId ? null : current));
        return;
      }
      setLandedTask({ taskId, task: result.task, messages });
      setLandingStatus(null);
    }).catch((error) => {
      if (run !== landingRun.current) return;
      const refused = isPermissionRefusal(error) || isSourceGone(error);
      setLandingStatus(refused ? "unavailable" : "failed");
      if (refused) setTaskThreadId((current) => (current === taskId ? null : current));
    });
  }, [landing, landingKey, data.tasks, data.taskMessages, memberId, messagingApi, retryNonce, setTaskThreadId]);

  // Try again on a two-person notice whose list failed: read the list once more
  // and judge it the same way as a list the loader brings.
  function retryPeerLanding() {
    const target = latestPendingPeer.current;
    if (!target) return;
    const startedWith = latestPeerContact.current;
    const run = ++landingRun.current;
    // Dismissed, superseded, or overtaken by a newer list: drop the answer.
    const current = () => run === landingRun.current && latestPendingPeer.current === target && latestPeerContact.current === startedWith;
    const dropped = {};
    setLandingStatus("loading");
    Promise.resolve().then(() => (current() ? peerContactApi.list() : dropped)).then((value) => {
      if (value === dropped || !current()) return;
      const next = sanitizePeerContactProjection(value);
      const verdict = peerLandingVerdict(next, target);
      if (verdict === "failed") { setLandingStatus("failed"); return; }
      updatePeerWorkspace(next);
      if (verdict === "gone") { setPendingPeerLanding(null); setLandingStatus("unavailable"); }
      else setLandingStatus(null);
    }, () => { if (current()) setLandingStatus("failed"); });
  }

  function cancelLanding() {
    landingRun.current += 1;
    setLanding(null);
    // A two-person conversation still waiting to open from a notice yields too.
    setPendingPeerLanding(null);
    setLandingStatus(null);
  }

  const lowered = query.trim().toLowerCase();
  const loadedConversation = data.conversations.find((item) => item.id === conversationId);
  // Confirmed removals reach the hydrated copy too: the tombstone pass over
  // `data` never sees it, and a re-merge must not restore a removed body.
  const landedFor = useMemo(
    () => (landed?.conversationId === conversationId ? applyTombstonesToLanded(landed, tombstones) : null),
    [landed, conversationId, tombstones],
  );
  // The selected thread, with the exact message a link named merged into its
  // visible history in chronological position (a conversation the loader never
  // carried arrives whole from the hydration). Same object when nothing merges.
  const conversation = useMemo(() => {
    const base = loadedConversation ?? landedFor?.conversation ?? undefined;
    if (!base) return undefined;
    const messages = mergeLandedMessage(base.messages, landedFor?.message);
    return withSystemSenderLabels(messages === base.messages ? base : { ...base, messages }, t);
  }, [loadedConversation, landedFor, t]);
  const broadcast = data.broadcasts.find((item) => item.id === broadcastId);
  const broadcastChapter = broadcast ? noticeChapters?.[broadcast.id] ?? null : null;
  const broadcastGlow = broadcast ? noticeTileGlow(broadcast, broadcastChapter) : null;
  const stewardConversation = findStewardConversation(data.conversations);
  const taskThreads = useMemo(() => (data.tasks || []).map((task) => ({
    task,
    messages: (data.taskMessages || []).filter((message) =>
      message.taskId === task.id && [message.senderId, message.recipientId].includes(memberId)),
  })).filter((item) => item.messages.length > 0), [data.tasks, data.taskMessages, memberId]);
  const loadedTaskThread = taskThreads.find((item) => item.task.id === taskThreadId)
    || ((data.tasks || []).find((task) => task.id === taskThreadId) ? {
      task: data.tasks.find((task) => task.id === taskThreadId),
      messages: (data.taskMessages || []).filter((message) => message.taskId === taskThreadId && [message.senderId, message.recipientId].includes(memberId)),
    } : null);
  // The board's window may not carry the task or the message a link named; the
  // hydrated copy fills exactly that in, in chronological position.
  const landedTaskFor = landedTask?.taskId === taskThreadId ? landedTask : null;
  const taskThreadBase = loadedTaskThread ?? (landedTaskFor ? { task: landedTaskFor.task, messages: [] } : null);
  const taskThreadMessages = taskThreadBase ? mergeLandedRows(taskThreadBase.messages, landedTaskFor?.messages, { timeKey: "createdAt" }) : null;
  const taskThread = taskThreadBase && (taskThreadMessages === taskThreadBase.messages ? taskThreadBase : { ...taskThreadBase, messages: taskThreadMessages });
  const peerConversation = (peerWorkspace?.conversations || []).find((item) => item.id === peerConversationId) || null;
  const selectedFilter = MESSAGE_FILTERS.includes(filter) ? filter : "all";

  // Selecting a thread changes the reading pane, not the source inbox. Keep
  // its full derivation out of that interaction; server and language changes
  // still rebuild the searchable result and every unread count.
  const inboxItems = useMemo(() => {
    const topics = (data.product?.spaces || []).flatMap((space) => space.threads || []);
    const savedMessages = data.savedMessages || [];
    const messageReminders = (data.messageReminders || []).filter((item) => !cancelledReminderIds.includes(item.id));
    // REQ-UG-REMIND-HERE-20261001: channel staff reminders from boot data;
    // the server re-checks access per read.
    const channelReminders = data.channelReminders || [];
    return [
    ...data.conversations.map((item) => ({
      key: `direct-${item.id}`,
      type: "direct",
      sourceType: "conversation",
      source: item,
      title: item.sender,
      preview: item.preview,
      meta: t("inbox.privateConversation"),
      time: inboxDate(item.updatedAt || item.messages?.at(-1)?.createdAt || item.messages?.at(-1)?.created_at) || item.dateLabel,
      timestamp: timestampOf(item.updatedAt, item.messages?.at(-1)?.createdAt, item.messages?.at(-1)?.created_at),
      unread: inboxUnreadCount("direct", item.unread),
      initials: item.initials || initialsOf(item.sender),
    })),
    ...(peerWorkspace?.conversations || []).map((item) => ({
      key: `peer-${item.id}`,
      type: "direct",
      sourceType: "peer",
      source: item,
      title: item.peerName,
      preview: item.messages?.at(-1)?.body || t("inbox.peerConversationEmpty"),
      meta: t("inbox.peerPrivate"),
      time: item.updatedAt ? inboxDate(item.updatedAt) : "",
      timestamp: timestampOf(item.updatedAt, item.messages?.at(-1)?.createdAt, item.messages?.at(-1)?.created_at),
      unread: inboxUnreadCount("direct", item.unreadCount ?? item.unread),
      initials: item.peerInitials || initialsOf(item.peerName),
    })),
    ...topics.map((item) => ({
      key: `channel-${item.id}`,
      type: "channel",
      sourceType: "channel",
      source: item,
      title: `# ${item.title}`,
      preview: postBody(item.posts?.at(-1), lang) || t(countKey("inbox.replies", item.posts?.length), { kind: item.kind, n: item.posts?.length || 0 }),
      meta: t("inbox.channels"),
      time: item.posts?.at(-1)?.createdAt || item.posts?.at(-1)?.created_at
        ? inboxDate(item.posts.at(-1).createdAt || item.posts.at(-1).created_at)
        : "",
      timestamp: timestampOf(item.updatedAt, item.posts?.at(-1)?.createdAt, item.posts?.at(-1)?.created_at),
      unread: inboxUnreadCount("channel", item.unreadCount ?? item.unread),
    })),
    ...taskThreads.map(({ task, messages }) => ({
      key: `task-${task.id}`,
      type: "task",
      sourceType: "task",
      source: { task, messages },
      title: task.title,
      preview: messages.at(-1)?.body || t("inbox.taskReplies", { n: messages.length }),
      meta: t("inbox.taskConversation"),
      time: messages.at(-1)?.createdAt || messages.at(-1)?.created_at
        ? inboxDate(messages.at(-1).createdAt || messages.at(-1).created_at)
        : "",
      timestamp: timestampOf(task.updatedAt, messages.at(-1)?.createdAt, messages.at(-1)?.created_at),
      unread: inboxUnreadCount("task", task.unreadCount),
    })),
    ...data.broadcasts.map((item) => ({
      key: `announcement-${item.id}`,
      type: "announcement",
      sourceType: "broadcast",
      source: item,
      title: item.title,
      preview: item.body,
      meta: item.sender,
      time: item.publishedAt ? inboxDate(item.publishedAt) : "",
      timestamp: timestampOf(item.publishedAt),
      unread: inboxUnreadCount("announcement", item.unread),
      initials: initialsOf(item.sender),
      languageLabel: item.locale && item.locale !== lang ? t(item.locale === "en" ? "inbox.inEnglish" : "inbox.inSpanish") : null,
    })),
    ...savedMessages.map((item) => ({
      key: `saved-${item.id}`,
      type: "saved",
      sourceType: "activity",
      source: item,
      title: item.available
        ? (item.redacted ? t(item.noticeKey || "inbox.redacted.short") : (item.preview || t("inbox.savedMessage")))
        : t("inbox.sourceUnavailable"),
      preview: t(`inbox.source.${item.sourceKind}`),
      meta: t("inbox.savedMessages"),
      time: item.savedAt ? inboxDate(item.savedAt) : "",
      timestamp: timestampOf(item.savedAt),
      unread: inboxUnreadCount("saved", item.unread),
      disabled: !item.available,
    })),
    ...messageReminders.map((item) => ({
      key: `reminder-${item.id}`,
      type: "reminder",
      sourceType: "activity",
      source: item,
      title: item.available
        ? (item.redacted ? t(item.noticeKey || "inbox.redacted.short") : (item.preview || t("inbox.messageReminder")))
        : t("inbox.sourceUnavailable"),
      preview: t(`inbox.source.${item.sourceKind}`),
      meta: t("inbox.reminders"),
      time: item.remindAt ? inboxDate(item.remindAt) : "",
      timestamp: timestampOf(item.remindAt),
      unread: inboxUnreadCount("reminder", item.unread),
      disabled: !item.available,
    })),
    ...channelReminders.map((item) => ({
      key: `channel-reminder-${item.id}`,
      type: "reminder",
      sourceType: "channelReminder",
      source: item,
      title: item.mine
        ? t("remindHere.inboxMine", { channel: item.spaceName })
        : t("remindHere.inboxTitle", { name: item.authorName, channel: item.spaceName }),
      preview: item.note,
      meta: t("remindHere.inboxMeta"),
      time: item.deliveredAt ? inboxDate(item.deliveredAt) : "",
      timestamp: timestampOf(item.deliveredAt),
      unread: 0,
    })),
  ].sort((a, b) => b.timestamp - a.timestamp || inboxTitleCompare(a.title, b.title));
  }, [data, taskThreads, peerWorkspace, cancelledReminderIds, inboxDate, inboxTitleCompare, lang, t]);

  const filterCounts = useMemo(() => Object.fromEntries(MESSAGE_FILTERS.map((key) => [key, key === "all"
    ? inboxItems.length
    : key === "unread"
      ? countUnreadInboxItems(inboxItems)
      : inboxItems.filter((item) => item.type === key).length])), [inboxItems]);
  const visibleItems = useMemo(() => inboxItems.filter((item) => {
    if (selectedFilter === "unread" && !isInboxItemUnread(item)) return false;
    if (!["all", "unread"].includes(selectedFilter) && item.type !== selectedFilter) return false;
    if (!lowered) return true;
    return `${item.title} ${item.preview} ${item.meta}`.toLowerCase().includes(lowered);
  }), [inboxItems, selectedFilter, lowered]);
  const workflowGroups = useMemo(() => groupMessageItems(visibleItems, workflow), [visibleItems, workflow]);
  const narrowWindowKey = `${selectedFilter}\n${lowered}\n${workflow}`;
  const narrowCount = narrowWindow.key === narrowWindowKey ? narrowWindow.count : INBOX_PAGE;
  const narrowGroups = limitMessageGroups(workflowGroups, narrowCount);
  const showMoreNarrow = () => setNarrowWindow({ key: narrowWindowKey, count: narrowCount + INBOX_PAGE });
  const desktopPage = Math.min(desktopWindow.key === narrowWindowKey ? desktopWindow.page : 1, Math.max(1, Math.ceil(visibleItems.length / INBOX_PAGE)));
  const desktopGroups = limitMessageGroups(workflowGroups, INBOX_PAGE, (desktopPage - 1) * INBOX_PAGE);
  useLayoutEffect(() => {
    if (!focusPage.current) return;
    focusPage.current = false;
    const first = inboxListRef.current?.querySelector('.inbox-row:not(:disabled), .ug-msg-item:not(:disabled)');
    first?.focus();
    first?.scrollIntoView?.({ block: 'nearest' });
  }, [desktopPage]);
  const desktopPager = desktop && visibleItems.length > INBOX_PAGE ? <Pager className="inbox-pager" total={visibleItems.length} page={desktopPage} pageSize={INBOX_PAGE} onPageChange={(page) => {
    focusPage.current = true;
    setDesktopWindow({ key: narrowWindowKey, page });
  }} /> : null;
  const unreadBriefingCount = countUnreadInboxItems(inboxItems);
  const waitingBriefingCount = inboxItems.filter((item) => !isInboxItemUnread(item) && ["direct", "task"].includes(item.type)).length;
  const selectedKey = conversation ? `direct-${conversation.id}`
    : peerConversation ? `peer-${peerConversation.id}`
      : broadcast ? `announcement-${broadcast.id}`
        : taskThread ? `task-${taskThread.task.id}`
          : null;

  function openActivity(item) {
    if (!item.available) return;
    if (item.sourceKind === "private") openConversation(item.targetId);
    else if (item.sourceKind === "channel") onOpenTopics(item.targetId);
    else if (item.sourceKind === "task") openTaskThread(item.targetId);
  }

  async function cancelReminder(reminder) {
    if (!messagingApi?.cancelReminder || !reminder?.id) return;
    try {
      await messagingApi.cancelReminder(reminder.id);
      setCancelledReminderIds((current) => current.includes(reminder.id) ? current : [...current, reminder.id]);
      onNotice(t("inbox.reminderCancelled"));
    } catch {
      onNotice(t("inbox.actionFailed"));
    }
  }

  // One detail surface at a time: on desktop the split pane shows whichever
  // was opened last, so each opener clears the other kind's selection. The
  // phone dialogs never showed two at once either — this just makes it a rule.
  function openConversation(id) {
    cancelLanding();
    setConversationId(id);
    setBroadcastId(null);
    setPeerConversationId(null);
    setTaskThreadId(null);
    // Let the thread paint before the read acknowledgment refreshes the shell.
    // A transition around this async handler loses its priority after await.
    const read = () => { Promise.resolve(onReadConversation(id)).catch(() => {}); };
    window.requestAnimationFrame(() => { window.setTimeout(read, 0); });
  }

  function openBroadcast(id) {
    cancelLanding();
    setBroadcastId(id);
    setConversationId(null);
    setPeerConversationId(null);
    setTaskThreadId(null);
    Promise.resolve(onReadBroadcast(id)).catch(() => {});
  }

  function openPeerConversation(id) {
    cancelLanding();
    setPeerConversationId(id);
    setConversationId(null);
    setBroadcastId(null);
    setTaskThreadId(null);
  }

  function openTaskThread(id) {
    cancelLanding();
    setTaskThreadId(id);
    setConversationId(null);
    setBroadcastId(null);
    setPeerConversationId(null);
  }

  function openInboxItem(item) {
    if (item.disabled) return;
    if (item.sourceType === "conversation") openConversation(item.source.id);
    else if (item.sourceType === "peer") openPeerConversation(item.source.id);
    else if (item.sourceType === "broadcast") openBroadcast(item.source.id);
    else if (item.sourceType === "channel") onOpenTopics(item.source.id);
    else if (item.sourceType === "task") openTaskThread(item.source.task.id);
    else if (item.sourceType === "activity") openActivity(item.source);
    else if (item.sourceType === "channelReminder") onOpenTopics();
  }

  function updatePeerConversation(conversationIdValue, message) {
    updatePeerWorkspace((current) => current ? {
      ...current,
      conversations: (current.conversations || []).map((item) => {
        if (item.id !== conversationIdValue || item.messages?.some((existing) => existing.id === message.id)) return item;
        const messages = [...(item.messages || []), message].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
        return { ...item, updatedAt: messages.at(-1)?.createdAt || item.updatedAt, messages };
      }),
    } : current);
  }

  // A send refused as closed never replaces the viewer's own block: a slow
  // send can come back after the viewer blocked (#9189 round 1).
  function updatePeerConversationState(conversationIdValue, state, { keepOwnBlock = false } = {}) {
    updatePeerWorkspace((current) => current ? {
      ...current,
      conversations: (current.conversations || []).map((item) => item.id === conversationIdValue
        && !(keepOwnBlock && item.state === "blocked_by_viewer") ? { ...item, state } : item),
    } : current);
  }

  // Mutations update the paired surfaces immediately and hand the same
  // authoritative projection to App. App owns it across lazy route unmounts;
  // a later server refresh can still replace it through the effect above.
  function updatePeerWorkspace(nextValue) {
    setPeerWorkspace((current) => {
      const next = typeof nextValue === "function" ? nextValue(current) : nextValue;
      onPeerContactChange?.(next);
      return next;
    });
  }

  // The officer route: the server's leadership list says who the member may
  // write to, and start_officer_conversation opens a two-person conversation.
  const canWriteOfficer = Boolean(officerDirectoryApi?.load && onStartOfficerConversation);

  useEffect(() => {
    if (!crossChapterApi?.load) { setCrossChapter(null); return undefined; }
    let live = true;
    Promise.resolve().then(() => crossChapterApi.load())
      .then((loaded) => { if (live) setCrossChapter(loaded?.available ? loaded : null); })
      .catch(() => { if (live) setCrossChapter(null); });
    return () => { live = false; };
  }, [crossChapterApi]);

  // A refused steward message carries its text over to the officer form.
  function pickOfficer(person, draft = "") {
    const key = `${memberId}:officer:${person.id}`;
    if (draft.trim() && !firstMessageDrafts.get(key)) firstMessageDrafts.set(key, draft);
    setOfficersOpen(false);
    setPendingSteward(null);
    // The form lives in the list pane, which the narrow alternate shell hides
    // while a thread is open: close every open thread so the form shows.
    cancelLanding();
    setConversationId(null);
    setPeerConversationId(null);
    setBroadcastId(null);
    setTaskThreadId(null);
    setPendingOfficer({ id: person.id, name: person.name ?? null });
  }

  async function startOfficerConversation(officerId, body, operationId) {
    // App runs this under the member session guard: a response superseded by
    // an account change resolves to nothing and is never merged.
    const result = await onStartOfficerConversation(officerId, body, operationId);
    if (!result?.conversation?.id || !result?.message?.id) throw new Error("Message not confirmed.");
    updatePeerWorkspace((current) => mergeOfficerConversation(current, result));
    return { conversationId: result.conversation.id };
  }

  // "Your chapter has no steward assigned yet": the message was not sent, so
  // offer the chapter's officers instead of a dead end.
  const officerFallback = canWriteOfficer
    ? (errorKey, draft) => errorKey === "rpcError.no_steward_assigned"
      ? <OfficerContactSection api={officerDirectoryApi} title={t("officerContact.noStewardTitle")} body={t("officerContact.noStewardBody")} onPick={(person) => pickOfficer(person, draft)} />
      : null
    : null;

  // The chapter steward form's message is refused (no_steward_assigned). A
  // named steward's is stored in a conversation bound to them, which no
  // steward can open until one can read again, so it waits unread.
  const stewardUnavailableKey = stewardMessageAvailable === false ? "inbox.stewardUnavailable" : null;
  const namedStewardUnavailableKey = stewardMessageAvailable === false ? "inbox.stewardUnavailableNamed" : null;
  // The same officers, offered before anything is sent: the notice above
  // already says why, so no refusal heading.
  const officerUpfront = canWriteOfficer
    ? (draft) => <OfficerContactSection api={officerDirectoryApi} onPick={(person) => pickOfficer(person, draft)} />
    : null;

  // #9595: with no steward named for the reader (stewardPresence), the empty
  // Direct list opens no first-message box to a steward and offers no steward
  // appointment; it says who can name one and offers the officers instead.
  const noSteward = noStewardNamed(stewardPresence);

  // Shared between the classic inbox and the alternate shell's three-pane
  // layout (REQ-UG-ALT-PORT-MESSAGES-20261030): one copy of each block.
  const headActions = (
    <div className="inbox-head__actions">
      {peerWorkspace && (
        <button
          type="button"
          className="inbox-head__action"
          onClick={() => setContactsOpen(true)}
        >
          <Users size={15} aria-hidden="true" />
          <span>{(peerWorkspace.incoming || []).length > 0
            ? t("inbox.contactsWithRequests", { n: peerWorkspace.incoming.length })
            : t("inbox.contacts")}</span>
        </button>
      )}
      {canWriteOfficer && (
        <button type="button" className="inbox-head__action" onClick={() => setOfficersOpen(true)}>
          <span>{t("officerContact.title")}</span>
        </button>
      )}
      {crossChapter && (
        <button type="button" className="inbox-head__action" onClick={() => setCrossChapterOpen(true)}>
          <span>{t("crossChapter.button")}</span>
        </button>
      )}
      {stewardConversation && (
        <button type="button" className="inbox-head__action inbox-head__action--primary" onClick={() => openConversation(stewardConversation.id)}>{t("inbox.messageSteward")}</button>
      )}
    </div>
  );
  const onboardingBlock = visitorMessageWorkflow || onboarded ? null : (
  <section className={`message-workflow-onboarding${desktop ? "" : " message-workflow-onboarding--phone"}`} aria-labelledby="message-workflow-onboarding-title">
    {desktop ? (
      <>
        <span className="message-workflow-onboarding__eyebrow">{t("inbox.workflow.onboardingEyebrow")}</span>
        <h2 id="message-workflow-onboarding-title">{t("inbox.workflow.onboardingTitle")}</h2>
        <p>{t("inbox.workflow.onboardingBody")}</p>
        <MessageWorkflowPicker value={onboardingChoice} onChange={setOnboardingChoice} legendId="message-workflow-onboarding-title" />
      </>
    ) : (
      <>
        <button
          type="button"
          className="message-workflow-onboarding__toggle"
          aria-expanded={onboardingExpanded}
          aria-controls="message-workflow-onboarding-body"
          onClick={() => setOnboardingExpanded((value) => !value)}
        >
          <span>
            <span className="message-workflow-onboarding__eyebrow">{t("inbox.workflow.onboardingEyebrow")}</span>
            <strong id="message-workflow-onboarding-title">{t("inbox.workflow.onboardingTitle")}</strong>
          </span>
          <span aria-hidden="true">{onboardingExpanded ? "−" : "+"}</span>
          <span className="visually-hidden">{t(onboardingExpanded ? "inbox.workflow.collapseOnboarding" : "inbox.workflow.expandOnboarding")}</span>
        </button>
        {onboardingExpanded && (
          <div id="message-workflow-onboarding-body">
            <p>{t("inbox.workflow.onboardingBody")}</p>
            <MessageWorkflowPicker compact value={onboardingChoice} onChange={setOnboardingChoice} legendId="message-workflow-onboarding-title" />
          </div>
        )}
      </>
    )}
    <div className="message-workflow-onboarding__actions">
      <button type="button" className="dialog-primary" onClick={() => { setWorkflow(onboardingChoice); completeOnboarding(); }}>{t("inbox.workflow.useChoice")}</button>
      <button type="button" className="dialog-secondary" onClick={() => { setWorkflow(MESSAGE_WORKFLOW_DEFAULT); completeOnboarding(); }}>{t("inbox.workflow.skip")}</button>
    </div>
  </section>
  );
  const filtersBar = (
    <div className="inbox-filters" role="toolbar" aria-label={t("inbox.filterLabel")}>
      {MESSAGE_FILTERS.map((key) => (
        <button type="button" key={key} aria-pressed={selectedFilter === key} onClick={() => setFilter(key)}>
          <span>{t(`inbox.filter.${key}`)}</span>
          <b aria-hidden="true">{filterCounts[key]}</b>
        </button>
      ))}
    </div>
  );
  const announcementTab = selectedFilter === "announcement" && !lowered;
  const detailOpen = Boolean(peerConversation || conversation || broadcast);
  // Only the classic desktop split has a reading pane for them; the alternate
  // shell keeps its own layout.
  const announcementPane = desktop && !alt;
  // The pane's Announcements task: the one picked, else the composer for an
  // officer who has one, else the product updates.
  const updatesShown = platformAnnouncementsShown(announcementContext, lang);
  const paneTasks = [noticeDesk ? "notice" : null, updatesShown ? "updates" : null].filter(Boolean);
  const paneTask = announcementPane && announcementTab && !detailOpen
    ? (paneTasks.includes(announcementTask) ? announcementTask : paneTasks[0] ?? null)
    : null;
  const openAnnouncementTask = (task) => {
    setConversationId(null);
    setBroadcastId(null);
    setPeerConversationId(null);
    setAnnouncementTask(task);
  };
  const listPreamble = (
    <>
    {/* A link that names a message this view cannot show says so, instead of
        leaving the ordinary inbox up as if the link had worked. */}
    {landingStatus && (
      <section className="inbox-empty inbox-empty--results" role={landingStatus === "loading" ? "status" : "alert"}>
        <strong>{t(`${landing?.taskId ? "linkedSource" : "linkedMessage"}.${landingStatus}`)}</strong>
        {landingStatus !== "loading" && (
          <div className="inbox-empty__alternatives">
            {landingStatus === "failed" && (pendingPeerLanding ? peerContactApi?.list : true) && <button type="button" className="dialog-secondary" onClick={pendingPeerLanding ? retryPeerLanding : () => { requestedLanding.current = null; setLandingStatus(null); setRetryNonce((value) => value + 1); }}>{t("linkedMessage.retry")}</button>}
            <button type="button" className="dialog-secondary" onClick={cancelLanding}>{t("linkedMessage.dismiss")}</button>
          </div>
        )}
      </section>
    )}
    {staffAccess && (
      <section className="compass-briefing" aria-labelledby="compass-briefing-title">
        <button
          type="button"
          className="compass-briefing__toggle"
          aria-expanded={briefingExpanded}
          aria-controls="compass-briefing-body"
          onClick={() => setBriefingExpanded((value) => !value)}
        >
          <span><strong id="compass-briefing-title">{t("inbox.compassBriefing.title")}</strong><small>{t("inbox.compassBriefing.body")}</small></span>
          <span aria-hidden="true">{briefingExpanded ? "−" : "+"}</span>
          <span className="sr-only">{t(briefingExpanded ? "inbox.compassBriefing.collapse" : "inbox.compassBriefing.expand")}</span>
        </button>
        {briefingExpanded && <div id="compass-briefing-body" className="compass-briefing__body">
          <div><strong>{t("inbox.compassBriefing.changed")}</strong><p>{t("inbox.compassBriefing.changedValue", { n: inboxItems.length })}</p></div>
          <div><strong>{t("inbox.compassBriefing.needsYou")}</strong><p>{t("inbox.compassBriefing.needsYouValue", { n: unreadBriefingCount })}</p></div>
          <div><strong>{t("inbox.compassBriefing.waiting")}</strong><p>{t("inbox.compassBriefing.waitingValue", { n: waitingBriefingCount })}</p></div>
          <div><strong>{t("inbox.compassBriefing.delivery")}</strong><p>{t("inbox.compassBriefing.deliveryValue")}</p></div>
        </div>}
      </section>
    )}
    {pendingSteward && onStartStewardConversation && (
      <section className="inbox-empty inbox-empty--start" aria-labelledby="inbox-start-steward">
        <h2 id="inbox-start-steward">
          {t("inbox.startWithSteward", { name: pendingSteward.name ?? t("inbox.chapterSteward") })}
        </h2>
        <FirstConversationForm
          key={`${memberId}:steward:${pendingSteward.id}`}
          onStart={(body) => onStartStewardConversation(pendingSteward.id, body)}
          onStarted={(id) => { setPendingSteward(null); setConversationId(id); }}
          t={t}
          draftKey={`${memberId}:steward:${pendingSteward.id}`}
          renderRefusal={officerFallback}
          unavailableKey={namedStewardUnavailableKey}
          renderUnavailable={officerUpfront}
        />
        <div className="inbox-empty__alternatives">
          <button type="button" className="dialog-secondary" onClick={() => setPendingSteward(null)}>
            {t("inbox.startWithStewardCancel")}
          </button>
        </div>
      </section>
    )}
    {pendingOfficer && canWriteOfficer && (
      <section className="inbox-empty inbox-empty--start" aria-labelledby="inbox-start-officer">
        <h2 id="inbox-start-officer">
          {t("officerContact.startTitle", { name: pendingOfficer.name ?? t("visibility.otherPerson") })}
        </h2>
        <FirstConversationForm
          key={`${memberId}:officer:${pendingOfficer.id}`}
          onStart={(body, operationId) => startOfficerConversation(pendingOfficer.id, body, operationId)}
          onStarted={(id) => { setPendingOfficer(null); openPeerConversation(id); }}
          t={t}
          draftKey={`${memberId}:officer:${pendingOfficer.id}`}
          keyedOfficer
          visibility={conversationVisibility(t, { kind: "personal", name: pendingOfficer.name })}
        />
        <div className="inbox-empty__alternatives">
          <button type="button" className="dialog-secondary" onClick={() => { setPendingOfficer(null); setOfficersOpen(true); }}>
            {t("officerContact.cancel")}
          </button>
        </div>
      </section>
    )}
    <div className="inbox-feed__head">
      <div>
        <h2>{t("inbox.feedTitle")}</h2>
        <p>{t("inbox.sortedRecent")}</p>
      </div>
      <span aria-live="polite">{t("inbox.resultCount", { n: visibleItems.length })}</span>
    </div>
    {!data.conversations.length && ["all", "direct"].includes(selectedFilter) && !lowered && visibleItems.length === 0 && !staffAccess && (
      <div className="inbox-empty inbox-empty--start">
        {noSteward ? <NoStewardNote presence={stewardPresence} /> : <p>{t("inbox.directEmpty")}</p>}
        {noSteward ? officerUpfront?.("") : onStartConversation && <FirstConversationForm key={`${memberId}:chapter`} onStart={onStartConversation} onStarted={setConversationId} t={t} draftKey={`${memberId}:chapter`} renderRefusal={officerFallback} unavailableKey={stewardUnavailableKey} renderUnavailable={officerUpfront} />}
        <div className="inbox-empty__alternatives">
          {onOpenCases && <button type="button" className="dialog-secondary" onClick={onOpenCases}>{t("inbox.directEmptyCases")}</button>}
          {/* REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030 (finding 64):
              opens the steward appointment request, not the mid-meeting alert
              on Know your rights. */}
          {onRequestSteward && !noSteward && <button type="button" className="dialog-secondary" onClick={onRequestSteward}>{t("inbox.directEmptyRights")}</button>}
        </div>
      </div>
    )}
    {/* REQ-UG-OFFICER-NOTICES-WITH-READ-RECEIPTS-20261030: the
        officer's notice composer (or the offer to act in a role that posts)
        sits on the tab members read notices in. */}
    {/* Hidden, not unmounted, while another filter or a search is showing,
        so an unsent notice survives them. */}
    {/* On the desktop split both open in the reading pane instead, from
        these entry points (REQ-UG-MESSAGES-COMPOSER-LAYOUT-20261102). */}
    {announcementPane && announcementTab && paneTasks.length ? <div className="inbox-pane-tasks" role="group" aria-label={t("inbox.announcementTasks")}>
      {noticeDesk ? <button type="button" className="inbox-head__action" aria-pressed={paneTask === "notice"} onClick={() => openAnnouncementTask("notice")}>{t("notices.title")}</button> : null}
      {updatesShown ? <button type="button" className="inbox-head__action" aria-pressed={paneTask === "updates"} onClick={() => openAnnouncementTask("updates")}>{announcementCopy(lang).title}</button> : null}
    </div> : null}
    {noticeDesk && !announcementPane ? <div hidden={!announcementTab}>{noticeDesk}</div> : null}
    {announcementTab && !announcementPane ? <PlatformAnnouncements context={announcementContext} locale={lang} /> : null}
    {/* REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: the
        member's own one-off and repeating reminders. */}
    {selectedFilter === "reminder" && !lowered ? personalReminders : null}
    </>
  );
  // #9596 (D1-12): with nothing listed to open, the reading pane does not ask
  // the reader to select something: under a search with no match it says what
  // to search for instead, otherwise what will open there.
  const detailEmptyBodyKey = visibleItems.length > 0 ? "inbox.detailEmptyBody"
    : lowered ? "inbox.noSearchResultsBody" : "inbox.detailNothingBody";
  const emptyResults = visibleItems.length === 0 && (data.conversations.length > 0 || !["all", "direct"].includes(selectedFilter) || lowered || staffAccess) ? (
    <div className="inbox-empty inbox-empty--results">
      <strong>{lowered ? t("inbox.noSearchResults") : t(`inbox.noFilterResults.${selectedFilter}`)}</strong>
      <p>{lowered ? t("inbox.noSearchResultsBody") : t("inbox.noFilterResultsBody")}</p>
      {(selectedFilter !== "all" || lowered) && <button type="button" className="dialog-secondary" onClick={() => { setFilter("all"); setQuery(""); }}>{t("inbox.showAllMessages")}</button>}
    </div>
  ) : null;
  const contactsDialog = contactsOpen && peerWorkspace ? (
      // On a phone the panel is a full-height sheet: a short dialog left the
      // message box showing beneath it, and a tap there only closed the panel.
      <Dialog eyebrow={pageName} title={t("inbox.peerTitle")} onClose={() => setContactsOpen(false)} size={desktop ? "default" : "detail"}>
        {peerWorkspace.available ? (
          <PeerContactSection workspace={peerWorkspace} api={peerContactApi} onChange={updatePeerWorkspace} onOpen={(id) => { setContactsOpen(false); openPeerConversation(id); }} showHeading={false} />
        ) : <p className="peer-contact__load-error" role="status">{t("inbox.peerLoadUnavailable")}</p>}
      </Dialog>
  ) : null;
  const officersDialog = officersOpen && canWriteOfficer ? (
      <Dialog eyebrow={pageName} title={t("officerContact.title")} onClose={() => setOfficersOpen(false)} size={desktop ? "default" : "detail"}>
        <OfficerContactSection api={officerDirectoryApi} body={t("officerContact.body")} onPick={(person) => pickOfficer(person)} />
      </Dialog>
  ) : null;
  const crossChapterDialog = crossChapterOpen && crossChapter ? (
      <Dialog eyebrow={pageName} title={t("crossChapter.title")} onClose={() => setCrossChapterOpen(false)} size={desktop ? "default" : "detail"}>
        <CrossChapterPeersSection
          api={crossChapterApi}
          onSent={(result) => updatePeerWorkspace((current) => mergeCrossChapterConversations(current, result))}
          onOpen={(id) => { setCrossChapterOpen(false); openPeerConversation(id); }}
        />
      </Dialog>
  ) : null;
  const taskDialog = taskThread ? <TaskConversationDialog item={taskThread} memberId={memberId} messagingApi={messagingApi} engagementSession={engagementSession} staffAccess={staffAccess} onNotice={onNotice} onClose={() => setTaskThreadId(null)} onOpenTasks={onOpenTasks} onSend={onSendTaskMessage} renderConnectedActions={renderConnectedActions} focusMessageId={landing?.taskId === taskThread.task.id ? landing.messageId : null} /> : null;

  // REQ-UG-ALT-PORT-MESSAGES-20261030: the alternate shell's Messages,
  // the prototype's three panes (pages/ws-messages.js): the conversation list,
  // the open thread and its details. Same state, items, readers and server
  // actions as the classic inbox above; only the markup is the design's. The
  // threads themselves are the production thread components (send, schedule,
  // share, reactions, save, remind, redaction), drawn as the design's bubbles
  // by src/alt/styles/messages.css.
  if (alt) {
    const selectedItem = selectedKey ? inboxItems.find((item) => item.key === selectedKey) ?? null : null;
    const threadKind = peerConversation ? "peer" : conversation ? "direct" : broadcast ? "announcement" : null;
    const threadTitle = peerConversation ? peerConversation.peerName : conversation ? conversation.sender : broadcast ? broadcast.title : "";
    const threadSub = peerConversation ? t("inbox.peerPrivate") : conversation ? t("inbox.privateConversation") : broadcast ? broadcast.sender : "";
    const threadMessages = peerConversation ? peerConversation.messages || [] : conversation ? conversation.messages || [] : [];
    // The people in the open conversation other than the member: its title
    // (the steward) and every named sender.
    const identitiesByName = new Map();
    for (const [name, id] of [
      [conversation?.sender, conversation?.stewardUserId],
      ...threadMessages.filter((message) => message.sender_kind !== "member" && message.sender_name).map((message) => [message.sender_name, message.sender_id]),
    ]) {
      if (!name || !id) continue;
      const ids = identitiesByName.get(name) || new Set();
      ids.add(id);
      identitiesByName.set(name, ids);
    }
    const namesake = (name) => identitiesByName.get(name)?.size > 1;
    // Keep the original name-based choices unless distinct known identities
    // collide. An unbound title is no extra person in an ambiguous roster.
    const mentionPeople = !peerConversation && conversation ? [...new Map([
      [namesake(conversation.sender) ? conversation.stewardUserId : conversation.sender, { id: conversation.stewardUserId || `title-${conversation.id}`, fullName: conversation.sender, sub: t("inbox.privateConversation") }],
      ...threadMessages.filter((message) => message.sender_kind !== "member" && message.sender_name).map((message) => [namesake(message.sender_name) ? message.sender_id : message.sender_name, { id: message.sender_id || `sender-${message.sender_name}`, fullName: message.sender_name, sub: "" }]),
    ].filter(([key]) => Boolean(key))).values()] : [];
    const lastDelivered = !peerConversation && conversation ? [...threadMessages].reverse().find((message) => isDeliveredMessage(message) && canOfferSourceTask(message)) ?? null : null;
    const closeThread = () => {
      setConversationId(null);
      setBroadcastId(null);
      setPeerConversationId(null);
      setAltInfoOpen(false);
    };
    const tile = (item) => item.type === "direct" || item.type === "announcement"
      ? <span className={`ug-person${item.type === "announcement" ? " ug-person-org" : ""}`} aria-hidden="true">{item.initials || initialsOf(item.title)}</span>
      : <span className="ug-ch-tile" aria-hidden="true">{item.type === "channel" ? "#" : item.type === "task" ? <AltIcon name="check" /> : item.type === "saved" ? <Star size={16} /> : item.type === "reminder" ? <AlarmClock size={16} /> : <AltIcon name="megaphone" />}</span>;
    return (
      <div className="ug-msg-page">
        <section className="ug-page-hero ug-ws-hero">
          <div className="ug-wrap">
            <nav className="ug-crumbs" aria-label={t("altShell.crumbs")}>
              {onOpenHome ? <a href="/m" onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onOpenHome(); }}>{t("altShell.now")}</a> : <span>{t("altShell.now")}</span>}
              <AltIcon name="right" /><span aria-current="page">{pageName}</span>
            </nav>
            <div className="ug-ws-top">
              <div>
                <h1>{pageName}</h1>
                <p className="ug-ws-lede">{t(staffAccess ? "altShell.msgLedeStaff" : "altShell.msgLede")}</p>
              </div>
              <div className="ug-ws-tools">
                <span className="ug-ws-private"><AltIcon name="lock" />{t("altShell.privateTag")}</span>
                {headActions}
              </div>
            </div>
          </div>
        </section>
        <section className="ug-wrap ug-msg-wrap">
          {onboardingBlock}
          <div className={`ug-msg-app${altInfoOpen ? " ug-info-open" : ""}`} data-view={threadKind ? "thread" : "list"}>
            <div className="ug-msg-list" ref={inboxListRef}>
              <div className="ug-msg-list-top">
                <label className="ug-msg-find">
                  <AltIcon name="search" /><span className="ug-sr">{t("inbox.searchPlaceholder")}</span>
                  <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("inbox.searchPlaceholder")} autoComplete="off" />
                </label>
                {stewardConversation ? (
                  <button className="ug-icon-btn ug-msg-new" type="button" aria-label={t("inbox.messageSteward")} title={t("inbox.messageSteward")} onClick={() => openConversation(stewardConversation.id)}><AltIcon name="edit" /></button>
                ) : null}
              </div>
              <div className="ug-msg-filters">{filtersBar}</div>
              <nav className="ug-msg-groups" aria-label={t("altShell.msgConversations")}>
                {listPreamble}
                {(desktop ? desktopGroups : workflowGroups).map((group) => (
                  <div key={group.key} role="group" aria-labelledby={`ug-msg-group-${group.key}`}>
                    <h3 className="ug-msg-label" id={`ug-msg-group-${group.key}`}>{t(`inbox.workflow.group.${group.key}`)}</h3>
                    {group.items.map((item) => (
                      <div className="ug-msg-row" key={item.key}>
                        <button
                          type="button"
                          className={`ug-msg-item${item.type === "channel" ? " ug-topic" : ""}${isInboxItemUnread(item) ? " ug-unread" : ""}`}
                          disabled={item.disabled}
                          aria-current={selectedKey === item.key ? "true" : undefined}
                          onClick={() => { setAltInfoOpen(false); openInboxItem(item); }}
                        >
                          {tile(item)}
                          <span className="ug-mi-main">
                            <span className="ug-mi-top"><b>{item.title}</b>{item.languageLabel ? <span className="ug-mi-lang">{item.languageLabel}</span> : null}<time>{item.time}</time></span>
                            <span className="ug-mi-prev">{notePreview(item.preview)}</span>
                          </span>
                          {isInboxItemUnread(item) ? (item.type === "announcement"
                            ? <span className="ug-mi-n ug-mi-dot" aria-label={t("inbox.unread")} />
                            : <span className="ug-mi-n" aria-label={t("inbox.unreadCount", { n: item.unread })}>{item.unread}</span>) : null}
                        </button>
                        {item.type === "reminder" && item.sourceType === "activity" && !item.disabled && messagingApi?.cancelReminder ? (
                          <button type="button" className="ug-link-btn ug-msg-cancel" onClick={() => cancelReminder(item.source)}>{t("inbox.cancelReminder")}</button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ))}
                {desktopPager}
                {emptyResults}
              </nav>
            </div>
            <section className="ug-msg-thread" aria-labelledby={threadKind ? "ug-msg-title" : undefined} aria-label={threadKind ? undefined : t("inbox.detailRegion")}>
              {threadKind ? (
                <>
                  <div className="ug-msg-head">
                    <button className="ug-icon-btn ug-msg-back" type="button" aria-label={t("altShell.msgBack")} onClick={closeThread}><AltIcon name="left" /></button>
                    {selectedItem ? tile(selectedItem) : null}
                    <div className="ug-msg-who"><h2 id="ug-msg-title" tabIndex={-1}>{threadTitle}</h2><p>{threadSub}</p></div>
                    <button className="ug-btn ug-btn-soft ug-btn-xs ug-msg-info-btn" type="button" aria-expanded={altInfoOpen} aria-controls="ug-msg-info" onClick={() => setAltInfoOpen((open) => !open)}><AltIcon name="info" />{t("altShell.msgDetails")}</button>
                  </div>
                  {/* One precedence for header, body and send handler: the peer
                      thread first, as the header above and the classic desktop
                      pane choose. */}
                  {peerConversation ? (
                    <div className="ug-msg-host">
                      <PeerConversationThread key={`${memberId}:${peerConversation.id}`} conversation={peerConversation} api={peerContactApi} onMessage={updatePeerConversation} onState={updatePeerConversationState} />
                    </div>
                  ) : conversation ? (
                    <div className="ug-msg-host">
                      <ConversationThread key={conversation.id} mentionCandidates={mentionPeople} conversation={conversation} onMessageChange={reconcileMessage} memberId={memberId} documents={data.product?.documents || []} messagingApi={messagingApi} engagementSession={engagementSession} engagementClient={engagementClient} staffAccess={staffAccess} onNotice={onNotice} onSend={onSendMessage} onCreateTaskFromSource={onCreateTaskFromSource} onResolveSourceTask={onResolveSourceTask} renderConnectedActions={renderConnectedActions} onOpenTask={onOpenTask} focusMessageId={landing?.conversationId === conversation.id ? landing.messageId : null} />
                    </div>
                  ) : (
                    <>
                      <div className="ug-msg-body" role="log" aria-label={broadcast.title} tabIndex={0}>
                        <div className="ug-msg-day"><span>{messageTime(broadcast.publishedAt, lang)}</span></div>
                        <div className={`ug-bub${broadcastGlow ? " notice-glow" : ""}`} {...noticeGlowAttributes(broadcastGlow)}><NoticeGlowLabels notice={broadcast} chapter={broadcastChapter} /><b className="ug-bub-by">{broadcast.sender}</b><p>{broadcast.body}</p></div>
                        {onCreateTaskFromSource ? <SourceTaskAction sourceKind="broadcast" sourceId={broadcast.id} onCreate={onCreateTaskFromSource} onResolve={onResolveSourceTask} onOpenTask={onOpenTask} /> : null}
                      </div>
                      <p className="ug-msg-ro"><AltIcon name="lock" />{t("altShell.msgReadOnly")}</p>
                    </>
                  )}
                </>
              ) : (
                <p className="ug-msg-empty"><AltIcon name="msg" /><b>{t("inbox.detailEmptyTitle")}</b>{t(detailEmptyBodyKey)}</p>
              )}
            </section>
            <aside className="ug-msg-info" id="ug-msg-info" aria-label={t("altShell.msgAbout")}>
              {threadKind ? (
                <>
                  <div className="ug-msg-info-head">
                    <h3>{t("altShell.msgAbout")}</h3>
                    <button className="ug-icon-btn ug-msg-info-x" type="button" aria-label={t("altShell.msgCloseDetails")} onClick={() => setAltInfoOpen(false)}><AltIcon name="x" /></button>
                  </div>
                  <dl className="ug-dl">
                    {threadMessages.length ? <><dt>{t("altShell.msgStarted")}</dt><dd>{messageTime(threadMessages[0].created_at ?? threadMessages[0].createdAt, lang)}</dd></> : null}
                    <dt>{t("altShell.msgCount")}</dt><dd>{threadKind === "announcement" ? 1 : threadMessages.length}</dd>
                    <dt>{t("altShell.msgAlerts")}</dt><dd>{t("altShell.msgAlertsOn")}</dd>
                  </dl>
                  <div className="ug-msg-info-acts">
                    {/* No mute or resolve exists for a direct conversation or an
                        announcement (channel mute lives in My chapter); the controls
                        stay, disabled with the reason, until #6527 adds them. */}
                    <button className="ug-btn ug-btn-white ug-btn-sm" type="button" disabled aria-describedby="ug-msg-mute-why"><AltIcon name="bell" />{t("altShell.msgMute")}</button>
                    {lastDelivered && onCreateTaskFromSource ? (
                      <SourceTaskAction variant="message" sourceKind="message" sourceId={lastDelivered.id} onCreate={onCreateTaskFromSource} onResolve={onResolveSourceTask} onOpenTask={onOpenTask ? (task) => onOpenTask(task, { sourceKind: "message", sourceId: lastDelivered.id, conversationId: conversation.id }) : null} />
                    ) : null}
                  </div>
                  <p className="ug-msg-muted-note" id="ug-msg-mute-why"><AltIcon name="info" /><span>{t("altShell.msgMuteUnavailable")}</span></p>
                  <p className="ug-msg-private"><AltIcon name="lock" /><span>{threadKind === "direct" ? conversationAudience(t, { kind: "steward" }) : threadKind === "peer" ? conversationAudience(t, { kind: "personal", name: peerConversation?.peerName }) : t("altShell.msgAnnouncementAudience")}</span></p>
                </>
              ) : null}
            </aside>
          </div>
        </section>
        {contactsDialog}
        {officersDialog}
        {crossChapterDialog}
        {taskDialog}
      </div>
    );
  }


  return (
    <>
    <div className={`screen inbox-screen${desktop ? " inbox-screen--split" : ""}`}>
      <div className="inbox-panel">
        <header className="inbox-head">
          <div className="inbox-head__row">
            <h1 className="inbox-title">{pageName}</h1>
            {headActions}
          </div>
          {onboardingBlock}
          <label className="inbox-search">
            <Search size={15} aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("inbox.searchPlaceholder")} aria-label={t("inbox.searchPlaceholder")} />
          </label>
          {filtersBar}
          <p className="message-workflow-current">{t(`inbox.workflow.${workflow === "people-spaces-work" ? "people" : workflow}.title`)} · {t("inbox.workflow.settingsHint")}</p>
        </header>
        <div className="inbox-scroll" ref={inboxListRef}>
          {listPreamble}
          {(desktop ? desktopGroups : narrowGroups).map((group) => (
            <section className="message-workflow-group" aria-labelledby={`message-workflow-group-${group.key}`} key={group.key}>
              <h3 id={`message-workflow-group-${group.key}`}>{t(`inbox.workflow.group.${group.key}`)}</h3>
              {group.items.map((item) => (
                <div className="inbox-row-cluster" key={item.key}>
                <button
                  type="button"
                  className={`inbox-row${selectedKey === item.key ? " inbox-row--selected" : ""}`}
                  disabled={item.disabled}
                  aria-pressed={selectedKey === item.key}
                  onClick={() => openInboxItem(item)}
                >
                  <span className={`inbox-chip${["channel", "task", "saved", "reminder"].includes(item.type) ? " inbox-chip--topic" : item.type === "announcement" ? " inbox-chip--org" : " inbox-chip--person"}`} aria-hidden="true">
                    {item.type === "channel" ? "#" : item.type === "task" ? "✓" : item.type === "saved" ? <Star size={16} /> : item.type === "reminder" ? <AlarmClock size={16} /> : item.initials}
                  </span>
                  <span className="inbox-row__main">
                    <span className="inbox-row__top">
                      <strong className="inbox-row__name">{item.title}</strong>
                      {item.languageLabel && <span className="inbox-lang-chip">{item.languageLabel}</span>}
                      {item.time && <time className="inbox-row__time">{item.time}</time>}
                    </span>
                    <span className="inbox-row__sub">{item.meta}</span>
                    <span className="inbox-row__line">
                      <span className={`inbox-row__preview${item.unread > 0 ? " inbox-row__preview--unread" : ""}`}>{notePreview(item.preview)}</span>
                      {isInboxItemUnread(item) && (item.type === "announcement"
                        // aria-label on a role-less <i> is dropped by the
                        // accessibility tree, so the dot announced nothing;
                        // role="img" gives the label something to name.
                        ? <i className="inbox-dot" role="img" aria-label={t("inbox.unread")} />
                        : <b className="inbox-count" aria-label={t("inbox.unreadCount", { n: item.unread })}>{item.unread}</b>)}
                    </span>
                  </span>
                </button>
                {item.type === "reminder" && item.sourceType === "activity" && !item.disabled && messagingApi?.cancelReminder && (
                  <button
                    type="button"
                    className="inbox-row__cancel"
                    onClick={() => cancelReminder(item.source)}
                  >
                    {t("inbox.cancelReminder")}
                  </button>
                )}
                </div>
              ))}
            </section>
          ))}
          {!desktop && visibleItems.length > INBOX_PAGE && (
            <Pager className="inbox-pager" total={visibleItems.length} shown={Math.min(narrowCount, visibleItems.length)} onShowMore={showMoreNarrow} />
          )}
          {desktopPager}
          {emptyResults}
        </div>
      </div>
      {/* Desktop split (owner direction, 2026-07-31): the opened item reads in
          a pane beside the list — the classic two-pane messenger — instead of
          a modal over it. Same components, same handlers; only the surface
          changes, so the phone dialogs below stay untouched. */}
      {desktop && (
        <section className="inbox-detail" aria-label={t("inbox.detailRegion")}>
          {/* Hidden, not unmounted, while anything else fills the pane, so an
              unsent notice survives opening a message or another filter. */}
          {noticeDesk ? <div className="inbox-detail__task" hidden={paneTask !== "notice"}>{noticeDesk}</div> : null}
          {peerConversation ? (
            <>
              <header className="inbox-detail__head">
                <span className="inbox-chip inbox-chip--person" aria-hidden="true">{peerConversation.peerInitials}</span>
                <div className="inbox-detail__head-text">
                  <strong className="inbox-detail__head-name">{peerConversation.peerName}</strong>
                  <span className="inbox-detail__head-sub">{t("inbox.peerPrivate")}</span>
                  <span className="inbox-detail__head-audience">{conversationAudience(t, { kind: "personal", name: peerConversation.peerName })}</span>
                </div>
              </header>
              <div className="inbox-detail__body">
                <PeerConversationThread key={`${memberId}:${peerConversation.id}`} conversation={peerConversation} api={peerContactApi} onMessage={updatePeerConversation} onState={updatePeerConversationState} />
              </div>
            </>
          ) : conversation ? (
            <>
              <header className="inbox-detail__head">
                <span className="inbox-chip inbox-chip--person" aria-hidden="true">{conversation.initials}</span>
                <div className="inbox-detail__head-text">
                  <strong className="inbox-detail__head-name">{conversation.sender}</strong>
                  <span className="inbox-detail__head-sub">{t("inbox.privateConversation")}</span>
                  <span className="inbox-detail__head-audience">{conversationAudience(t, { kind: "steward" })}</span>
                </div>
              </header>
              {/* Keyed by thread: switching conversations must not carry a
                  half-typed draft into the other steward's thread. */}
              <div className="inbox-detail__body">
                <ConversationThread key={conversation.id} conversation={conversation} onMessageChange={reconcileMessage} memberId={memberId} documents={data.product?.documents || []} messagingApi={messagingApi} engagementSession={engagementSession} engagementClient={engagementClient} staffAccess={staffAccess} onNotice={onNotice} onSend={onSendMessage} onCreateTaskFromSource={onCreateTaskFromSource} onResolveSourceTask={onResolveSourceTask} renderConnectedActions={renderConnectedActions} onOpenTask={onOpenTask} focusMessageId={landing?.conversationId === conversation.id ? landing.messageId : null} />
              </div>
            </>
          ) : broadcast ? (
            <>
              <header className="inbox-detail__head">
                <span className="inbox-chip inbox-chip--org" aria-hidden="true">{initialsOf(broadcast.sender)}</span>
                <div className="inbox-detail__head-text">
                  <strong className="inbox-detail__head-name">{broadcast.title}</strong>
                  <span className="inbox-detail__head-sub">{broadcast.sender}{broadcast.locale && broadcast.locale !== lang && <> · {t(broadcast.locale === "en" ? "inbox.inEnglish" : "inbox.inSpanish")}</>}</span>
                </div>
              </header>
              <article className={`broadcast-detail inbox-detail__broadcast${broadcastGlow ? " notice-glow" : ""}`} {...noticeGlowAttributes(broadcastGlow)}>
                <NoticeGlowLabels notice={broadcast} chapter={broadcastChapter} />
                <p>{broadcast.body}</p>
                <time>{messageTime(broadcast.publishedAt, lang)}</time>
                {onCreateTaskFromSource && <SourceTaskAction sourceKind="broadcast" sourceId={broadcast.id} onCreate={onCreateTaskFromSource} onResolve={onResolveSourceTask} onOpenTask={onOpenTask} />}
              </article>
            </>
          ) : paneTask === "updates" ? (
            <div className="inbox-detail__task"><PlatformAnnouncements context={announcementContext} locale={lang} /></div>
          ) : paneTask === "notice" ? null : (
            <div className="inbox-detail__empty">
              <span className="inbox-detail__empty-icon" aria-hidden="true">✉</span>
              <strong>{t("inbox.detailEmptyTitle")}</strong>
              <p>{t(detailEmptyBodyKey)}</p>
            </div>
          )}
        </section>
      )}
    </div>
      {/* Fixed dialogs share the workspace with the list instead of forcing
          its flex layout to resolve their position when focus enters. */}
      {peerConversation && !desktop && (
        <Dialog eyebrow={t("inbox.peerPrivate")} title={peerConversation.peerName} onClose={() => setPeerConversationId(null)}>
          <PeerConversationThread key={`${memberId}:${peerConversation.id}`} conversation={peerConversation} api={peerContactApi} onMessage={updatePeerConversation} onState={updatePeerConversationState} />
        </Dialog>
      )}
      {contactsDialog}
      {officersDialog}
      {crossChapterDialog}
      {conversation && !desktop && <ConversationDialog conversation={conversation} onMessageChange={reconcileMessage} memberId={memberId} documents={data.product?.documents || []} messagingApi={messagingApi} engagementSession={engagementSession} engagementClient={engagementClient} staffAccess={staffAccess} onNotice={onNotice} onClose={() => setConversationId(null)} onSend={onSendMessage} onCreateTaskFromSource={onCreateTaskFromSource} onResolveSourceTask={onResolveSourceTask} renderConnectedActions={renderConnectedActions} onOpenTask={onOpenTask} focusMessageId={landing?.conversationId === conversation.id ? landing.messageId : null} />}
      {taskDialog}
      {broadcast && !desktop && <Dialog eyebrow={broadcast.locale && broadcast.locale !== lang ? `${broadcast.sender} · ${t(broadcast.locale === "en" ? "inbox.inEnglish" : "inbox.inSpanish")}` : broadcast.sender} title={broadcast.title} onClose={() => setBroadcastId(null)}><article className={`broadcast-detail${broadcastGlow ? " notice-glow" : ""}`} {...noticeGlowAttributes(broadcastGlow)}><NoticeGlowLabels notice={broadcast} chapter={broadcastChapter} /><p>{broadcast.body}</p><time>{messageTime(broadcast.publishedAt, lang)}</time>{onCreateTaskFromSource && <SourceTaskAction sourceKind="broadcast" sourceId={broadcast.id} onCreate={onCreateTaskFromSource} onResolve={onResolveSourceTask} onOpenTask={onOpenTask} />}</article></Dialog>}
    </>
  );
}

// REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030: the
// officers and administrators of the member's chapter the server says they
// may write to (get_chapter_leadership canMessage). Picking one opens the
// first-message form addressed to that person.
function OfficerContactSection({ api, title = null, body = null, onPick }) {
  const { t } = useLang();
  const headingId = useId();
  const [state, setState] = useState({ phase: "loading", people: [] });
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.load())
      .then((loaded) => { if (live) setState({ phase: "ready", people: contactableOfficers(loaded?.people) }); })
      .catch(() => { if (live) setState({ phase: "error", people: [] }); });
    return () => { live = false; };
  }, [api]);
  return (
    <section className="officer-contact" aria-labelledby={title ? headingId : undefined} aria-label={title ? undefined : t("officerContact.title")}>
      {title && <h3 id={headingId}>{title}</h3>}
      {body && <p className="peer-contact__privacy">{body}</p>}
      {state.phase === "loading" && <p role="status">{t("officerContact.loading")}</p>}
      {state.phase === "error" && <p role="alert">{t("officerContact.error")}</p>}
      {state.phase === "ready" && state.people.length === 0 && <p className="peer-contact__quiet">{t("officerContact.empty")}</p>}
      {state.phase === "ready" && state.people.length > 0 && (
        <ul className="officer-contact__list" aria-label={t("officerContact.pick")}>
          {state.people.map((person) => (
            <li key={person.id}>
              <button type="button" className="peer-contact__conversation" aria-label={t("officerContact.write", { name: person.name })} onClick={() => onPick(person)}>
                <span className="inbox-chip inbox-chip--person" aria-hidden="true">{initialsOf(person.name)}</span>
                <span><strong>{person.name}</strong><small>{leadershipRoleLine(person, t)}</small></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PeerContactSection({ workspace, api, onChange, onOpen, showHeading = true }) {
  const { t, lang } = useLang();
  const instanceId = useId();
  const titleId = `${instanceId}-peer-contact-title`;
  const ownCodeId = `${instanceId}-peer-own-code`;
  const requestCodeId = `${instanceId}-peer-contact-code`;
  const [code, setCode] = useState("");
  // Record 8435 (slice 9 review): a request and an answer are independent
  // writes, each with its own lock and pending mark, so a slow answer to one
  // member never holds back a request to another.
  const [requesting, setRequesting] = useState(false);
  const [answering, setAnswering] = useState(null);
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  // The request (and copy) and the answers each keep their own
  // notice, so one never replaces the other's alert.
  const [notice, setNotice] = useState(null);
  const [answerNotice, setAnswerNotice] = useState(null);
  const submitting = useRef(false);

  function requestContact(event) {
    event.preventDefault();
    return runBusyWrite(busyWriteRef, "request", (unlock) => requestContactNow(unlock), event);
  }

  async function requestContactNow(unlock) {
    if (submitting.current || !api?.request) return;
    submitting.current = true;
    setRequesting(true);
    setNotice(null);
    try {
      const result = await api.request(code);
      if (!result?.requested) throw new Error("unavailable");
      onChange((current) => ({
        ...current,
        outgoing: [{ id: result.id, status: "pending", createdAt: result.createdAt }, ...(current.outgoing || [])],
      }));
      setCode("");
      setNotice({ kind: "status", text: t("inbox.peerRequestSent") });
    } catch {
      setNotice({ kind: "alert", text: t("inbox.peerUnavailable") });
    } finally {
      submitting.current = false;
      setRequesting(false);
      unlock();
    }
  }

  function respond(request, accept) {
    return runBusyWrite(busyWriteRef, "answer", (unlock) => respondNow(request, accept, unlock));
  }

  async function respondNow(request, accept, unlock) {
    if (answering || !api?.respond) return;
    setAnswering(request.id);
    setAnswerNotice(null);
    // W8-7 (#9462): say only what is known. `saved` turns true once the server
    // confirmed this answer, so a later throw is not told as a failed answer.
    let saved = false;
    try {
      const result = await api.respond(request.id, accept);
      // The server returned a refusal and wrote nothing. Its one reason
      // ("unavailable") covers an expired request and a pair that may still
      // decline, so the line says only that this answer was not saved.
      if (accept ? !result?.accepted : !result?.declined) {
        setAnswerNotice({ kind: "alert", text: t("inbox.peerAnswerRefused") });
        return;
      }
      saved = true;
      onChange((current) => ({
        ...current,
        incoming: (current.incoming || []).filter((item) => item.id !== request.id),
        conversations: result?.conversation
          ? [result.conversation, ...(current.conversations || []).filter((item) => item.id !== result.conversation.id)]
          : (current.conversations || []),
      }));
      if (result?.conversation) onOpen(result.conversation.id);
    } catch (error) {
      // A server error with a SQLSTATE did not commit; a throw with no code
      // (a lost reply) may have, so it is told as unconfirmed.
      const key = saved ? "inbox.peerAnswerSavedNotShown" : error?.code ? "inbox.peerAnswerFailed" : "inbox.peerAnswerUnconfirmed";
      setAnswerNotice({ kind: "alert", text: t(key) });
    } finally {
      setAnswering(null);
      unlock();
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(workspace.code);
      setNotice({ kind: "status", text: t("inbox.peerCopied") });
    } catch {
      setNotice({ kind: "status", text: t("inbox.peerCopyFallback") });
    }
  }

  return (
    <section className="peer-contact" aria-labelledby={showHeading ? titleId : undefined} aria-label={showHeading ? undefined : t("inbox.peerTitle")}>
      {showHeading && <div className="inbox-sect">
        <h2 id={titleId} className="inbox-sect__label">{t("inbox.peerTitle")}</h2>
      </div>}
      <div className="peer-contact__body">
        <p className="peer-contact__privacy">{t("inbox.peerPrivacy")}</p>
        <div className="peer-contact__code-row">
          <label htmlFor={ownCodeId}>{t("inbox.peerYourCode")}</label>
          <div>
            <input id={ownCodeId} value={workspace.code || ""} readOnly />
            <button type="button" className="peer-contact__action peer-contact__action--secondary" onClick={copyCode}>{t("inbox.peerCopy")}</button>
          </div>
        </div>
        {workspace.canRequest ? (
          <form className="peer-contact__request" onSubmit={requestContact}>
            <label htmlFor={requestCodeId}>{t("inbox.peerOtherCode")}</label>
            <BusyInput id={requestCodeId} value={code} onChange={(event) => setCode(event.target.value)} maxLength={23} autoCapitalize="characters" autoComplete="off" spellCheck="false" placeholder="UG-…" pending={requesting} required />
            <BusyButton type="submit" className="peer-contact__action" pending={requesting}>{requesting ? t("inbox.peerSending") : t("inbox.peerSendRequest")}</BusyButton>
          </form>
        ) : <p className="peer-contact__quiet">{t("inbox.peerLocked")}</p>}
        {notice && <p role={notice.kind} className={`peer-contact__notice peer-contact__notice--${notice.kind}`}>{notice.text}</p>}
        {answerNotice && <p role={answerNotice.kind} className={`peer-contact__notice peer-contact__notice--${answerNotice.kind}`}>{answerNotice.text}</p>}

        <h3>{t("inbox.peerIncoming")}</h3>
        {(workspace.incoming || []).map((request) => (
          <div className="peer-contact__request-row" role="group" aria-label={t("inbox.peerRequestFrom", { name: request.requesterName })} key={request.id}>
            <span className="inbox-chip inbox-chip--person" aria-hidden="true">{request.requesterInitials}</span>
            <span><strong>{request.requesterName}</strong><small>{messageTime(request.createdAt, lang)}</small></span>
            <div>
              <BusyButton type="button" className="peer-contact__action" pending={answering !== null} onClick={() => respond(request, true)}>{t("inbox.peerAccept")}</BusyButton>
              <BusyButton type="button" className="peer-contact__action peer-contact__action--secondary" pending={answering !== null} onClick={() => respond(request, false)}>{t("inbox.peerDecline")}</BusyButton>
            </div>
          </div>
        ))}
        {(workspace.incoming || []).length === 0 && <p className="peer-contact__quiet">{t("inbox.peerIncomingEmpty")}</p>}

        <h3>{t("inbox.peerConversations")}</h3>
        {(workspace.conversations || []).map((conversation) => (
          <button type="button" className="peer-contact__conversation" key={conversation.id} onClick={() => onOpen(conversation.id)}>
            <span className="inbox-chip inbox-chip--person" aria-hidden="true">{conversation.peerInitials}</span>
            <span><strong>{conversation.peerName}</strong><small>{conversation.messages?.at(-1)?.body || t("inbox.peerConversationEmpty")}</small></span>
          </button>
        ))}
        {(workspace.conversations || []).length === 0 && <p className="peer-contact__quiet">{t("inbox.peerConversationsEmpty")}</p>}

        {(workspace.outgoing || []).length > 0 && <>
          <h3>{t("inbox.peerOutgoing")}</h3>
          {(workspace.outgoing || []).map((request) => <p className="peer-contact__outgoing" key={request.id}>{t(`inbox.peerStatus.${request.status}`)} · {messageTime(request.createdAt, lang)}</p>)}
        </>}
      </div>
    </section>
  );
}

// BUG-UG-TWO-PERSON-CONVERSATIONS-HAVE-NO-LEAVE-OR-BLOCK-RULE-20261118
// (#9189): the server says whether either person may still write. "closed"
// (a person left, or the other person blocked) never says which; the person
// who blocked sees their own block and can lift it. An older server sends no
// state, which means open.
function PeerConversationThread({ conversation, api, onMessage, onState = () => {} }) {
  const { t, lang } = useLang();
  const visibilityId = useId();
  const [draft, setDraft] = useState("");
  const [operations] = useState(() => createOperationKeys(undefined, { maxAgeMs: Infinity }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [blockError, setBlockError] = useState(false);
  const submitting = useRef(false);
  const state = conversation.state || "open";

  async function submit(event) {
    event.preventDefault();
    if (submitting.current || !api?.send || state !== "open") return;
    const body = draft.trim();
    if (!body) return;
    submitting.current = true;
    setBusy(true);
    setError(false);
    try {
      const result = await api.send(conversation.id, body, operations.keyFor(body));
      if (!result?.message?.id) throw new Error("Message not confirmed.");
      operations.settle(body);
      onMessage(conversation.id, result.message);
      setDraft("");
    } catch (failure) {
      // Closed while the page was open: show it closed, not a send failure.
      if (failure?.details === "peer_conversation_closed") onState(conversation.id, "closed", { keepOwnBlock: true });
      else setError(peerSendUnconfirmed(failure) ? "inbox.peerMessageUnconfirmed" : "inbox.peerMessageError");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function setBlock(blocked) {
    if (blocking || !api?.setBlock) return;
    setBlocking(true);
    setBlockError(false);
    try {
      const result = await api.setBlock(conversation.id, blocked);
      if (!result?.state) throw new Error("unavailable");
      onState(conversation.id, result.state);
      setConfirmBlock(false);
    } catch {
      setBlockError(true);
    } finally {
      setBlocking(false);
    }
  }

  return <div className="peer-thread">
    <div className="inbox-thread" aria-live="polite">
      {(conversation.messages || []).map((message) => <article key={message.id} className={`inbox-msg inbox-msg--${message.sentByMe ? "out" : "in"}`}><p>{message.body}</p><time>{messageTime(message.createdAt, lang)}</time></article>)}
      {(conversation.messages || []).length === 0 && state === "open" && <p className="peer-contact__quiet">{t("inbox.peerConversationEmpty")}</p>}
    </div>
    <p id={visibilityId} className="inbox-visibility">{conversationVisibility(t, { kind: "personal", name: conversation.peerName })}</p>
    {state === "open" && <form className="inbox-composer" onSubmit={submit}>
      <BusyInput value={draft} onChange={(event) => {
        if (event.target.value.trim() !== draft.trim()) operations.clear();
        setDraft(event.target.value);
      }} aria-label={t("inbox.peerComposer")} aria-describedby={visibilityId} placeholder={t("inbox.peerComposer")} maxLength="4000" autoComplete="off" pending={busy} />
      <BusyButton type="submit" className="inbox-send" pending={busy} disabled={!draft.trim()}>{busy ? t("inbox.sending") : t("inbox.send")}</BusyButton>
    </form>}
    {state === "closed" && <p role="status" className="peer-contact__notice">{t("inbox.peerClosed")}</p>}
    {state === "blocked_by_viewer" && <div className="peer-thread__safety">
      <p role="status" className="peer-contact__notice">{t("inbox.peerBlockedByYou", { name: conversation.peerName })}</p>
      {api?.setBlock && <BusyButton type="button" className="peer-contact__action peer-contact__action--secondary" pending={blocking} onClick={() => setBlock(false)}>{t("inbox.peerUnblock")}</BusyButton>}
    </div>}
    {state !== "blocked_by_viewer" && api?.setBlock && (confirmBlock
      ? <div className="peer-thread__safety" role="group" aria-label={t("inbox.peerBlock", { name: conversation.peerName })}>
        <p className="peer-contact__notice">{t("inbox.peerBlockConfirm", { name: conversation.peerName })}</p>
        <BusyButton type="button" className="peer-contact__action" pending={blocking} onClick={() => setBlock(true)}>{t("inbox.peerBlockYes")}</BusyButton>
        <button type="button" className="peer-contact__action peer-contact__action--secondary" disabled={blocking} onClick={() => setConfirmBlock(false)}>{t("inbox.peerBlockCancel")}</button>
      </div>
      : <div className="peer-thread__safety">
        <button type="button" className="peer-contact__action peer-contact__action--secondary" onClick={() => setConfirmBlock(true)}>{t("inbox.peerBlock", { name: conversation.peerName })}</button>
      </div>)}
    {error && <p role="alert" className="peer-contact__notice peer-contact__notice--alert">{t(error)}</p>}
    {blockError && <p role="alert" className="peer-contact__notice peer-contact__notice--alert">{t("inbox.peerBlockError")}</p>}
  </div>;
}

// /api/guide refuses a briefing in classes it already names with a code, and
// src/features/engagement/api.js carries that code (plus the HTTP status for
// the three branches that predate the codes) on the thrown error. The English
// sentence the endpoint sends is server copy, so the notice is looked up here
// instead: a Spanish steward reads a Spanish refusal, and the class stays
// visible rather than collapsing into one generic failure.
const BRIEFING_FAILURE_KEY_BY_CODE = {
  session_expired: "inbox.compassBriefFailure.signedOut",
  unauthorized: "inbox.compassBriefFailure.staffRole",
  shared_rate_limit: "inbox.compassBriefFailure.sharedLimit",
  role_rate_limit: "inbox.compassBriefFailure.roleLimit",
  compass_paused: "inbox.compassBriefFailure.paused",
  compass_privacy_unavailable: "inbox.compassBriefFailure.privacy",
  invalid_ai_result: "inbox.compassBriefFailure.invalidResult",
  persistence_unavailable: "inbox.compassBriefFailure.notSaved",
  governance_unavailable: "inbox.compassBriefFailure.unavailable",
  gateway_unavailable: "inbox.compassBriefFailure.unavailable",
  gateway_timeout: "inbox.compassBriefFailure.unavailable",
  retrieval_unavailable: "inbox.compassBriefFailure.unavailable",
};
const BRIEFING_FAILURE_KEY_BY_STATUS = {
  400: "inbox.compassBriefFailure.invalidThread",
  401: "inbox.compassBriefFailure.signedOut",
  403: "inbox.compassBriefFailure.staffRole",
  404: "inbox.compassBriefFailure.threadUnavailable",
};

export function briefingFailureKey(error) {
  return BRIEFING_FAILURE_KEY_BY_CODE[error?.code]
    || BRIEFING_FAILURE_KEY_BY_STATUS[error?.status]
    || "inbox.compassBriefFailed";
}

// The thread + composer, shared by the phone dialog and the desktop detail
// pane — one send path, one pending-bubble contract, whichever surface hosts
// it.
function MessageBriefingAction({ session, client = null, actionSourceId = null, sourceKind, targetId, onNotice }) {
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [deciding, setDeciding] = useState(false);
  const decidingRef = useRef(false);
  const [briefing, setBriefing] = useState(null);
  const [action, setAction] = useState(null);
  const [failure, setFailure] = useState("");
  if (!session?.access_token || !targetId) return null;
  const stateLine = action?.state === "confirmed" ? t("inbox.compassStateConfirmed") : action?.state === "rejected" ? t("inbox.compassStateRejected") : t("inbox.compassStateUnknown");
  async function decide(verdict) {
    if (decidingRef.current) return;
    decidingRef.current = true;
    setDeciding(true);
    setFailure("");
    try {
      const decided = await engagementApi.decideAction(client, action.id, verdict);
      setAction(decided);
      if (verdict === "confirm") onNotice(decided.state === "confirmed" ? t("inbox.compassTaskCreated") : t("inbox.compassTaskNotCreated"));
      else onNotice(t("inbox.compassTaskDismissed"));
    } catch {
      onNotice(t("inbox.compassDecisionFailed"));
      setFailure("inbox.compassDecisionFailed");
    } finally {
      decidingRef.current = false;
      setDeciding(false);
    }
  }
  return <section className="inbox-briefing" aria-label={t("inbox.compassBriefing")}>
    <BusyButton type="button" className="outline-pill" pending={busy} onClick={() => runBusyWrite(busyWriteRef, "briefing", async (unlock) => {
      setBusy(true);
      setFailure("");
      try {
        const result = await requestMessageBriefing(session, sourceKind, targetId);
        setBriefing(result.briefing);
        onNotice(t("inbox.compassBriefSaved"));
      } catch (error) { onNotice(t(briefingFailureKey(error))); setFailure(briefingFailureKey(error)); }
      finally { setBusy(false); unlock(); }
    })}><Bot size={15} aria-hidden="true" /> {busy ? t("inbox.compassBriefBusy") : t("inbox.compassBriefIdle")}</BusyButton>
    {briefing && <article className="inbox-briefing__result"><strong>{t("inbox.compassBriefing")}</strong><p>{briefing.summary}</p>{briefing.actionItems?.length > 0 && <ul>{briefing.actionItems.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>}{client && actionSourceId && !action && briefing.actionItems?.[0] && <button type="button" className="outline-pill" onClick={async () => { setFailure(""); try { setAction(await engagementApi.proposeAction(client, "message", actionSourceId, briefing.actionItems[0])); onNotice(t("inbox.compassTaskPrepared")); } catch { onNotice(t("inbox.compassTaskPrepareFailed")); setFailure("inbox.compassTaskPrepareFailed"); } }}>{t("inbox.compassPrepareTask")}</button>}{action?.state === "proposed" && <div className="inbox-briefing__decision"><p><strong>{t("inbox.compassDecisionPrompt")}</strong> {action.title}</p><BusyButton type="button" className="outline-pill" pending={deciding} onClick={() => decide("confirm")}>{t("inbox.compassCreateTask")}</BusyButton><BusyButton type="button" className="outline-pill" pending={deciding} onClick={() => decide("reject")}>{t("inbox.compassDismiss")}</BusyButton></div>}{action && action.state !== "proposed" && <p role="status">{stateLine}</p>}</article>}
    {failure && <p role="alert" className="composer-not-sent">{t(failure)}</p>}
  </section>;
}

function pendingScheduledRows(rows) {
  return (rows || []).filter((row) => row.status === "pending" && !row.redacted_at && row.body?.trim());
}

function ConversationThread({ mentionCandidates = null, conversation, onMessageChange = () => {}, memberId, documents, messagingApi, engagementSession, engagementClient = null, staffAccess = false, onNotice, onSend, onCreateTaskFromSource = null, onResolveSourceTask = null, renderConnectedActions = null, onOpenTask = null, focusMessageId = null }) {
  const { t, lang } = useLang();
  const threadDomId = useId();
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [draft, setDraft] = useDeviceParityState(`messages.${conversation.id}.draft`, "");
  const [messageState, setMessageState] = useState(() => conversation.messages || []);
  const [scheduled, setScheduled] = useState(() => pendingScheduledRows(conversation.scheduled));
  const [scheduleFor, setScheduleFor] = useState("");
  const [resourceId, setResourceId] = useState("");
  const inputRef = useRef(null);
  const formRef = useRef(null);
  // A send that failed says so beside the composer until the next attempt; a
  // toast alone vanished and left the member unsure the message went through.
  const [notSent, setNotSent] = useState(false);
  // #9466: a phone-width thread is a dialog over the page notice; failures say so here.
  const [sendFailure, setSendFailure] = useState("");
  const [cancelFailure, setCancelFailure] = useState(null);
  // REQ-UG-ALT-PORT-MESSAGES-20261030: the alternate shell's @mention
  // picker (pages/ws-messages.js), a keyboard listbox over the thread's people
  // built on the case-note mention rules (src/lib/caseMentions.js). The name
  // goes into the message text; a private message carries no mention record or
  // reminder today (#6527).
  const [mention, setMention] = useState({ open: false, sel: 0, hits: [] });
  const scanMention = (value, caret) => {
    if (!mentionCandidates?.length) return;
    const active = activeMentionQuery(value, caret);
    const hits = active ? filterMentionCandidates(mentionCandidates, active.query).slice(0, 6) : [];
    setMention((current) => ({ open: hits.length > 0, hits, sel: Math.min(current.sel, Math.max(0, hits.length - 1)) }));
  };
  const pickMention = (index) => {
    const person = mention.hits[index];
    const input = inputRef.current;
    if (!person || !input) return;
    const next = completeMention(draft, input.selectionStart ?? draft.length, person.fullName);
    setDraft(next.body);
    setMention({ open: false, sel: 0, hits: [] });
    window.requestAnimationFrame(() => { input.focus(); input.setSelectionRange?.(next.caret, next.caret); });
  };
  const mentionKeyDown = (event) => {
    if (!mention.open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setMention((current) => ({ ...current, sel: (current.sel + step + current.hits.length) % current.hits.length }));
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      pickMention(mention.sel);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setMention({ open: false, sel: 0, hits: [] });
    }
  };
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const scheduledRevision = useRef(0);
  // Anchor for the Compass briefing's proposed task only. The briefing is a
  // thread-level aid with its own explicit approval step; a task shortcut on a
  // message is per exact message (SourceTaskAction on each row below) and never
  // guesses a "latest" one.
  const briefingAnchorMessage = [...conversation.messages].reverse().find((message) => message.sender_kind === "member" && !message.pending);
  const shareableDocuments = (documents || []).filter((document) => document.status === "published");
  useEffect(() => setMessageState(conversation.messages || []), [conversation.messages]);
  useLandOnMessage(focusMessageId, threadDomId, messageState);
  // #9526: when the member load's window cut older messages off, the
  // conversation carries an earlier cursor and its earlier messages open above
  // the loaded ones, as a channel thread's do (ProductHubView.jsx).
  const loadEarlierMessages = messagingApi?.loadEarlierPrivateMessages;
  const loadEarlierRef = useRef(loadEarlierMessages);
  loadEarlierRef.current = loadEarlierMessages;
  const newestPage = useMemo(() => (conversation.earlierCursor && loadEarlierMessages
    ? { messages: messageState.map(withCreatedAt), earlierCursor: conversation.earlierCursor }
    : null), [conversation.earlierCursor, loadEarlierMessages, messageState]);
  const history = useEarlierHistory({
    scopeKey: JSON.stringify([conversation.id, memberId]),
    thread: newestPage,
    load: async (before) => {
      const page = await loadEarlierRef.current({ conversationId: conversation.id, before });
      return { messages: page.messages.map(withCreatedAt), earlierCursor: page.earlierCursor };
    },
    revalidateMs: EARLIER_HISTORY_RECONCILE_MS,
  });
  const shownMessages = newestPage && history.started ? history.messages : messageState;
  const threadListRef = useRef(null);
  const showEarlier = usePrependAnchor(threadListRef, shownMessages, history);
  useEffect(() => {
    scheduledRevision.current += 1;
    // The loader snapshot replaces local acknowledgements, including absent,
    // empty-body and no-longer-pending drafts. Never merge old body copies back.
    setScheduled(pendingScheduledRows(conversation.scheduled));
  }, [conversation.scheduled]);
  function submit(event) {
    return runBusyWrite(busyWriteRef, "reply", (unlock) => submitNow(event, unlock), event);
  }

  async function submitNow(event, unlock) {
    event.preventDefault();
    // The Enter key fires submit while the button is still enabled on the
    // frame the await starts, so `disabled={busy}` alone lets a fast second
    // Enter post the same reply twice.
    if (busy) return;
    const body = draft.trim();
    if (!body && !resourceId) return;
    setBusy(true);
    setNotSent(false);
    setSendFailure("");
    const revision = scheduledRevision.current;
    const scheduling = Boolean(scheduleFor);
    // Clear as soon as the pending bubble carries the text; a failure puts
    // the draft back (mutate() already toasted it) — but only into an idle
    // composer. If the member typed a newer draft while the send was failing,
    // the failure must not eat it.
    setDraft("");
    try {
      if (scheduleFor) {
        const result = await messagingApi.schedule(conversation.id, body, new Date(scheduleFor).toISOString());
        if (revision === scheduledRevision.current) {
          setScheduled((current) => [...current, { id: result?.id || `local-schedule-${Date.now()}`, conversation_id: conversation.id, body, scheduled_for: new Date(scheduleFor).toISOString(), status: "pending" }]);
        }
        setScheduleFor("");
        onNotice(t("inbox.scheduled"));
      } else if (resourceId) {
        const document = shareableDocuments.find((item) => item.id === resourceId);
        const result = await messagingApi.sendResource(conversation.id, resourceId, body);
        // The App confirms a real share into the conversation itself; this
        // local copy covers an api that does not, and never doubles it.
        setMessageState((current) => current.some((message) => result?.messageId && message.id === result.messageId) ? current : [...current, {
          id: result?.messageId || `local-resource-${Date.now()}`,
          conversation_id: conversation.id,
          sender_kind: "member",
          sender_name: "Member",
          body: body || t("inbox.sharedResource"),
          created_at: new Date().toISOString(),
          reactions: [], saved: false,
          resource: { documentId: resourceId, title: document?.title || "", documentType: document?.document_type || "document" },
        }]);
        setResourceId("");
        onNotice(t("inbox.resourceShared"));
      } else {
        await onSend(conversation.id, body);
      }
    } catch (failure) {
      // "Your text is still in the box" is said only when the failed text is
      // what the box now holds; a newer draft or a superseded schedule keeps
      // the box as it is and the App's failure notice stands alone.
      const restore = Boolean(body) && (!scheduling || revision === scheduledRevision.current) && !draftRef.current;
      if (restore) setDraft(body);
      setNotSent(restore);
      // A text send already toasted through the App; a schedule or a resource
      // share calls the api directly, so a refusal the app can explain (no
      // steward assigned, say) is said here.
      const refusalKey = scheduling || resourceId ? rpcErrorKeyStrict(failure, "") : "";
      if (refusalKey) onNotice(t(refusalKey));
      setSendFailure(refusalKey || (restore ? "" : "inbox.actionFailed"));
    } finally { setBusy(false); unlock(); }
  }
  return (
    <>
      {/* #9526: a conversation the newest 1,000 messages cut opens its earlier ones here; with no earlier read it says older ones may not show. */}
      {newestPage ? <EarlierThreadHistory t={t} history={history} onShowEarlier={showEarlier} /> : conversation.earlierCursor && <p className="inbox-visibility">{t("inbox.olderNotShown")}</p>}
      <div ref={threadListRef} className="inbox-thread">{shownMessages.map((message) => {
        // The common connected-workflow control for THIS exact row. A callback
        // that returns nothing for it leaves the row on its standalone controls.
        const connected = renderConnectedActions && isDeliveredMessage(message) ? renderConnectedActions("private_message", message) : null;
        return (
        <article key={message.id} id={`${threadDomId}-message-${message.id}`} tabIndex={message.id === focusMessageId ? -1 : undefined} className={`inbox-msg inbox-msg--${message.sender_kind === "member" ? "out" : "in"}${message.pending ? " inbox-msg--pending" : ""}`}>
          {message.sender_kind !== "member" && <strong className="inbox-msg__who">{message.sender_name}</strong>}
          <MessageBody message={message} />
          {message.resource && <a className="inbox-resource" href={`/m/organize?document=${encodeURIComponent(message.resource.documentId)}`}><Link2 size={14} aria-hidden="true" /><span><strong>{message.resource.title}</strong><small>{message.resource.documentType}</small></span></a>}
          <time id={`${threadDomId}-sent-${message.id}`}>{message.pending ? t("inbox.sending") : messageTime(message.created_at, lang)}</time>
          {!message.pending && <MessageActions sourceKind="private" message={message} onReply={(reply) => setMessageState((rows) => [...rows.filter((row) => row.id !== reply.id), reply].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)))} onMessageChange={(next) => { setMessageState((rows) => rows.map((row) => row.id === next.id ? next : row)); if (next.redacted_at) { scheduledRevision.current += 1; setScheduled([]); } onMessageChange(next); }} actorId={memberId} api={messagingApi} onNotice={onNotice} connectedActions={connected} />}
          {/* The task belongs to this exact message, not to whichever one is newest.
              The parent withholds onCreateTaskFromSource from a Member hat, so
              this renders for an authorized staff hat only, and only while no
              common connected control (which carries the task shortcut) is offered. */}
          {!connected && onCreateTaskFromSource && canOfferSourceTask(message) && (
            <SourceTaskAction
              variant="message"
              sourceKind="message"
              sourceId={message.id}
              describedBy={`${threadDomId}-sent-${message.id}`}
              onCreate={onCreateTaskFromSource}
              onResolve={onResolveSourceTask}
              onOpenTask={onOpenTask ? (task) => onOpenTask(task, { sourceKind: "message", sourceId: message.id, conversationId: conversation.id }) : null}
            />
          )}
        </article>
        );
      })}</div>
      {scheduled.length > 0 && <section className="inbox-scheduled" aria-label={t("inbox.scheduledMessages")}><CalendarClock size={15} aria-hidden="true" /><div><strong>{t("inbox.scheduledMessages")}</strong>{scheduled.map((item) => (
        <div className="inbox-scheduled__row" key={item.id}>
          <p>{messageTime(item.scheduled_for, lang)} · {item.body}</p>
          {messagingApi?.cancelScheduled && (
            <BusyButton
              type="button"
              className="inbox-scheduled__cancel"
              pending={busy}
              onClick={() => runBusyWrite(busyWriteRef, "reply", async (unlock) => {
                if (busy) return;
                setBusy(true);
                setCancelFailure(null);
                try {
                  await messagingApi.cancelScheduled(item.id);
                  setScheduled((current) => current.filter((row) => row.id !== item.id));
                  onNotice(t("inbox.scheduledCancelled"));
                } catch {
                  onNotice(t("inbox.actionFailed"));
                  setCancelFailure(item.id);
                } finally {
                  setBusy(false);
                  unlock();
                }
              })}
            >
              {t("inbox.cancelScheduled")}
            </BusyButton>
          )}
          {cancelFailure === item.id && <p role="alert" className="composer-not-sent">{t("inbox.actionFailed")}</p>}
        </div>
      ))}</div></section>}
      {/* Quick replies (owner Rev 2 sign-off, 2026-08-08): the Compass chip
          contract — tapping FILLS the draft, never sends, so the member
          always confirms with the send button. Focus moves into the composer
          so the change of context is announced and typing continues where
          the filled text landed (sol LOW on 7f558d177). */}
      <div className="inbox-quick" role="group" aria-label={t("inbox.quickLabel")}>
        {["inbox.quickOnMyWay", "inbox.quickReschedule", "inbox.quickThanks"].map((key) => (
          <button key={key} type="button" className="inbox-quick__chip" onClick={() => { setDraft(t(key)); setNotSent(false); inputRef.current?.focus(); }}>{t(key)}</button>
        ))}
      </div>
      {staffAccess && <MessageBriefingAction key={`${conversation.id}:${(conversation.messages || []).map(message => `${message.id}:${message.redacted_at || message.redactedAt || ""}`).join(",")}`} session={engagementSession} client={engagementClient} actionSourceId={briefingAnchorMessage?.id || null} sourceKind="private" targetId={conversation.id} onNotice={onNotice} />}
      {/* Who else reads a "private" conversation, said where the member
          writes, in the words the Privacy page uses (features/messaging/visibility.js). */}
      <p id={`${threadDomId}-visibility`} className="inbox-visibility">{conversationVisibility(t, { kind: "steward" })}</p>
      <form ref={formRef} className="inbox-composer" onSubmit={submit}>
        <div className="inbox-composer__fields">
          {mention.open ? (
            <div className="ug-mention-pop" role="listbox" id={`${threadDomId}-mentions`} aria-label={t("altShell.msgMentionList")}>
              {mention.hits.map((person, index) => (
                <div key={person.id} role="option" id={`${threadDomId}-mention-${index}`} aria-selected={index === mention.sel} onMouseDown={(event) => { event.preventDefault(); pickMention(index); }}>
                  <span className="ug-person ug-person-xs" aria-hidden="true">{initialsOf(person.fullName)}</span><span><b>{person.fullName}{mentionCandidates.some((other) => other.id !== person.id && other.fullName === person.fullName) ? ` (${person.id})` : ""}</b>{person.sub ? <small>{person.sub}</small> : null}</span>
                </div>
              ))}
            </div>
          ) : null}
          <input ref={inputRef} name="message" placeholder={t("inbox.composerPlaceholder")} aria-label={t("inbox.composerPlaceholder")} aria-describedby={`${threadDomId}-visibility`} maxLength="4000" autoComplete="off" value={draft} onChange={(event) => { setDraft(event.target.value); scanMention(event.target.value, event.target.selectionStart); }} {...(mentionCandidates ? { role: "combobox", "aria-autocomplete": "list", "aria-expanded": mention.open, "aria-controls": mention.open ? `${threadDomId}-mentions` : undefined, "aria-activedescendant": mention.open ? `${threadDomId}-mention-${mention.sel}` : undefined, onKeyDown: mentionKeyDown, onClick: (event) => scanMention(event.target.value, event.target.selectionStart) } : {})} />
          {messagingApi && <div className="inbox-composer-tools">
            <label><Link2 size={14} aria-hidden="true" /><span>{t("inbox.shareResource")}</span><select value={resourceId} onChange={(event) => setResourceId(event.target.value)} disabled={Boolean(scheduleFor)} aria-label={t("inbox.shareResource")}><option value="">{t("inbox.none")}</option>{shareableDocuments.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}</select></label>
            <label><CalendarClock size={14} aria-hidden="true" /><span>{t("inbox.scheduleFor")}</span><input type="datetime-local" value={scheduleFor} onChange={(event) => setScheduleFor(event.target.value)} disabled={Boolean(resourceId)} min={localDateTimeInputValue(Date.now() + 60_000)} /></label>
            {/* #9460 W4-8: why the other tool is dimmed. */}
            {(resourceId || scheduleFor) && <p role="status" style={{ flexBasis: "100%", margin: 0, fontSize: 12, color: "var(--muted-foreground)" }}>{t(resourceId ? "inbox.resourceSendsNow" : "inbox.scheduledNoResource")}</p>}
          </div>}
        </div>
        <BusyButton className="inbox-send" pending={busy}>{busy ? t("inbox.sending") : t("inbox.send")}</BusyButton>
      </form>
      {/* The alert says the text is still in the box, so it is never shown over an empty one. */}
      {notSent && !busy && draft.trim() && <p role="alert" className="composer-not-sent">{sendFailure && <>{t(sendFailure)} </>}{t("inbox.notSent")} <button type="button" className="composer-not-sent__retry" onClick={() => formRef.current?.requestSubmit()}>{t("inbox.notSentRetry")}</button></p>}
      {!(notSent && draft.trim()) && !busy && sendFailure && <p role="alert" className="composer-not-sent">{t(sendFailure)}</p>}
    </>
  );
}

function ConversationDialog({ conversation, onMessageChange, memberId, documents, messagingApi, engagementSession, engagementClient = null, staffAccess = false, onNotice, onClose, onSend, onCreateTaskFromSource = null, onResolveSourceTask = null, renderConnectedActions = null, onOpenTask = null, focusMessageId = null }) {
  const { t } = useLang();
  return (
    <Dialog eyebrow={t("inbox.privateConversation")} title={conversation.sender} onClose={onClose} wide>
      <p className="inbox-detail__head-audience inbox-dialog-audience">{conversationAudience(t, { kind: "steward" })}</p>
      <ConversationThread key={conversation.id} conversation={conversation} onMessageChange={onMessageChange} memberId={memberId} documents={documents} messagingApi={messagingApi} engagementSession={engagementSession} engagementClient={engagementClient} staffAccess={staffAccess} onNotice={onNotice} onSend={onSend} onCreateTaskFromSource={onCreateTaskFromSource} onResolveSourceTask={onResolveSourceTask} renderConnectedActions={renderConnectedActions} onOpenTask={onOpenTask} focusMessageId={focusMessageId} />
    </Dialog>
  );
}

function TaskConversationDialog({ item, memberId, messagingApi, engagementSession, staffAccess = false, onNotice, onClose, onOpenTasks, onSend, renderConnectedActions = null, focusMessageId = null }) {
  const { t, lang } = useLang();
  const threadDomId = useId();
  const [messages, setMessages] = useState(item.messages || []);
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState(false);
  useEffect(() => setMessages(item.messages || []), [item.messages]);
  useLandOnMessage(focusMessageId, threadDomId, messages);

  function submit(event) {
    return runBusyWrite(busyWriteRef, "taskMessage", (unlock) => submitNow(event, unlock), event);
  }

  async function submitNow(event, unlock) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = String(new FormData(form).get("body") || "").trim();
    if (!body || busy || !onSend) return;
    setBusy(true);
    setError(false);
    try {
      const created = await onSend(item.task.id, body);
      if (created?.id) setMessages((current) => current.some((message) => message.id === created.id) ? current : [...current, created]);
      form.reset();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
      unlock();
    }
  }

  return <Dialog eyebrow={t("inbox.taskConversation")} title={item.task.title} onClose={onClose} wide>
    <p className="inbox-task-bridge">{t("inbox.taskConversationSub")}</p>
    <div className="thread-list">{messages.map((message) => <article key={message.id} id={`${threadDomId}-message-${message.id}`} tabIndex={message.id === focusMessageId ? -1 : undefined} className={`thread-message thread-message--${message.senderId === memberId ? "member" : "steward"}`}><p>{message.body}</p><time>{messageTime(message.createdAt, lang)}</time><MessageActions sourceKind="task" message={message} actorId={memberId} api={messagingApi} onNotice={onNotice} connectedActions={renderConnectedActions && isDeliveredMessage(message) ? renderConnectedActions("task_message", message) : null} /></article>)}</div>
    {staffAccess && <MessageBriefingAction session={engagementSession} sourceKind="task" targetId={item.task.id} onNotice={onNotice} />}
    <form className="thread-composer" onSubmit={submit}><textarea name="body" maxLength="2000" placeholder={t("inbox.taskComposer")} required /><BusyButton className="dialog-primary" pending={busy} disabled={!onSend}>{busy ? t("inbox.sending") : t("inbox.send")}</BusyButton></form>
    {error && <p role="alert">{t("inbox.peerMessageError")}</p>}
    {onOpenTasks && <button type="button" className="outline-pill" onClick={() => onOpenTasks(item.task.id)}>{t("inbox.openTaskBoard")}</button>}
  </Dialog>;
}
