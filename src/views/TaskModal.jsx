import { EvidenceUpload } from "../components/EvidenceUpload.jsx";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BusyButton, BusyTextarea } from "../components/BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import {
  Check,
  Bell,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  ChevronsUpDown,
  Clock3,
  CopyPlus,
  Diamond,
  Hash,
  Link2,
  Minus,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  Send,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { dateTimeFormat, localeFor } from "../lib/i18n.js";
import { MemberApiError } from "../lib/memberApi.js";
import { rpcRefusalKey } from "../lib/rpcErrorText.js";
import { withObjectUrl } from "../lib/privateFileAccess.js";
import { useModalIsolation } from "../lib/useModalIsolation.js";
import { useTransitionPresence } from "../lib/useTransitionPresence.js";
import { TaskTemplatePanel, TaskTypeConversionPanel } from "./TaskTemplateDialog.jsx";
import { TaskCheckoffPanel } from "./TaskCheckoffPanel.jsx";
import {
  STATUS_IDS,
  TASK_TYPE_IDS,
  parseChecklist,
  statusCycle,
  taskDependencyLists,
  taskKey,
  toggleChecklistItem,
  workstreamColorIndex,
  wouldCreateDependencyCycle,
} from "../lib/kanban.js";
import { limitTaskTitle } from "../lib/taskTitle.js";

// Priority has no canonical order in the schema (it is a three-value enum), so
// the picker pins one here: the quick-pick digits 1/2/3 are positional, and a
// reshuffle would silently remap every muscle-memory keystroke.
const PRIORITY_IDS = ["high", "medium", "low"];
const PRIORITY_LABELS = { high: "tasks.priorityHigh", medium: "tasks.priorityMedium", low: "tasks.priorityLow" };
const PRIORITY_ICONS = { high: ChevronsUp, medium: Minus, low: ChevronsDown };

function initialsFor(person) {
  if (!person) return "—";
  return person.initials || person.fullName.slice(0, 2).toUpperCase();
}

function RetainedPopover({
  open,
  popoverRef,
  onExited,
  className = "",
  children,
  ...props
}) {
  const localRef = useRef(null);
  const [origin, setOrigin] = useState("top right");
  const presence = useTransitionPresence(open, { exitMs: 200, onExited });

  useLayoutEffect(() => {
    const node = localRef.current;
    if (!node || !open) return undefined;
    popoverRef.current = node;
    const rect = node.parentElement?.getBoundingClientRect();
    if (rect) setOrigin(rect.left + (rect.width / 2) < window.innerWidth / 2 ? "top left" : "top right");
    return () => {
      if (popoverRef.current === node) popoverRef.current = null;
    };
  }, [open, popoverRef, presence.mounted]);

  useEffect(() => {
    if (!open || !localRef.current) return;
    const options = [...localRef.current.querySelectorAll('[role="option"], [role="menuitem"]')];
    if (!options.length) return;
    const selected = Math.max(0, options.findIndex((option) => option.getAttribute("aria-selected") === "true"));
    options.forEach((option, index) => { option.tabIndex = index === selected ? 0 : -1; });
  }, [children, open, presence.phase]);

  useEffect(() => {
    if (!open || !presence.mounted || !localRef.current) return;
    const field = localRef.current.querySelector("input");
    (field || localRef.current.querySelector('[role="option"], [role="menuitem"]'))?.focus({ preventScroll: true });
  }, [open, presence.mounted]);

  if (!presence.mounted) return null;
  return (
    <div
      {...props}
      ref={localRef}
      className={className ? `kan-popover ${className}` : "kan-popover"}
      data-state={presence.phase}
      aria-hidden={presence.closing || undefined}
      inert={presence.closing ? true : undefined}
      style={{ transformOrigin: origin }}
      onTransitionEnd={presence.onTransitionEnd}
    >
      {children}
    </div>
  );
}

// The companion-phone instance mirrors modal editing state through device
// parity, and an autofocused control inside an IFRAME pulls focus from the
// parent document — which blurs the desktop's own editor and closes it a few
// milliseconds after it opened. The embed therefore never autofocuses.
const EMBEDDED_COMPANION = typeof window !== "undefined" && /[?&]embed=phone(?:&|$)/.test(window.location.search);

function DisclosurePanel({ id, open, children }) {
  const presence = useTransitionPresence(open, { exitMs: 350, appear: false });
  if (!presence.mounted) return null;
  return (
    <div
      id={id}
      className="kan-disclosure-panel"
      data-state={presence.phase}
      aria-hidden={presence.closing || undefined}
      inert={presence.closing ? true : undefined}
      onTransitionEnd={presence.onTransitionEnd}
    >
      <div className="kan-disclosure-panel__inner">{children}</div>
    </div>
  );
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function TaskModal({
  task,
  automationLink = null,
  connectedActions = null,
  renderConnectedMessageActions = null,
  onOpenSourceRecord = null,
  chapterId,
  assignees = [],
  templateReviewers = [],
  documents = [],
  workstreamNames = [],
  t,
  lang,
  memberId,
  messages = [],
  comments = [],
  commentsUnavailable = false,
  commentsTruncated = false,
  attachments = [],
  files = [],
  activity = [],
  creatorName = "",
  onClose,
  onUpdate,
  getAuthoritativeTask = null,
  onWriteError = null,
  onSetAssignees = null,
  onDelete = null,
  onAddComment = null,
  onSendMessage = null,
  onAddAttachment = null,
  onRemoveAttachment = null,
  onAddFile = null,
  onRemoveFile = null,
  onOpenFile = null,
  onRecheckFile = null,
  onAssignFocus = false,
  // The spec's prop list has no board array, and the "TASK STATUS" popover
  // wants each status' count across the board. Rather than hand the modal a
  // second copy of every task, the parent may pass the four counts it has
  // already grouped; without them the popover simply renders no counts.
  statusCounts = null,
  presenceState = "open",
  onPresenceTransitionEnd = null,
  // Phase 2: the whole loaded board (for dependency mini-cards and the add
  // picker) plus the RESOLVABLE edge list — TasksView filters out edges whose
  // endpoint has aged past the board window, so every consumer of the list
  // agrees with what is actually on screen.
  tasks = [],
  dependencies = [],
  onAddDependency = null,
  onRemoveDependency = null,
  onOpenTask = null,
  onDuplicate = null,
  subtasks = [],
  watches = [],
  onCreateSubtask = null,
  onRemoveSubtask = null,
  onUpdateSubtask = null,
  onWatch = null,
  onUnwatch = null,
  onAnnounce = null,
  parentError = "",
  liveMessage = "",
  deleteBusy = false,
  template = null,
  templateDetails = null,
  onUpdateTemplateDetails = null,
  onUseTemplate = null,
  // The template catalog and the conversion write for changing a General task
  // to a specialized type in place (#8211); without them the editor explains
  // and offers a new task from a template instead.
  templates = [],
  onConvertType = null,
  // REQ-UG-COOP-CHECKOFF-LISTS-20261001: the live client for the member
  // check-off list; null (preview, signed out) renders no check-off surface.
  checkoffClient = null,
}) {
  const uid = useId();
  const backdropRef = useRef(null);
  const dialogRef = useRef(null);
  const popoverRef = useRef(null);
  const triggerRef = useRef(null);
  const pickerNameRef = useRef(null);
  const pickerGenerationRef = useRef(0);
  const pendingPickerFocusRef = useRef(null);
  const titleRef = useRef(null);
  const assigneePillRef = useRef(null);

  // One picker at a time: "status" | "priority" | "assignee" | "workstream".
  // Escape consults this BEFORE it closes the modal, so a mis-opened popover
  // costs one keystroke instead of the whole modal.
  const parityKey = `tasks.modal.${task.id}`;
  const [picker, setPicker] = useDeviceParityState(`${parityKey}.picker`, onAssignFocus ? "assignee" : null);
  pickerNameRef.current = picker;
  const [taskDetailsExpanded, setTaskDetailsExpanded] = useDeviceParityState(`${parityKey}.taskDetailsExpanded`, true);
  // A card with no description opens the panel so the "Add description"
  // action is visible — collapsed-by-default hid the only entry point behind
  // an unlabeled pencil.
  const [descriptionExpanded, setDescriptionExpanded] = useDeviceParityState(`${parityKey}.descriptionExpanded`, !(task.description || "").trim());
  const [dependenciesExpanded, setDependenciesExpanded] = useDeviceParityState(`${parityKey}.dependenciesExpanded`, false);
  const [subtasksExpanded, setSubtasksExpanded] = useDeviceParityState(`${parityKey}.subtasksExpanded`, false);
  const [documentsExpanded, setDocumentsExpanded] = useDeviceParityState(`${parityKey}.documentsExpanded`, false);
  const [commentsExpanded, setCommentsExpanded] = useDeviceParityState(`${parityKey}.commentsExpanded`, false);
  const [messagesExpanded, setMessagesExpanded] = useDeviceParityState(`${parityKey}.messagesExpanded`, false);
  const [title, setTitle] = useDeviceParityState(`${parityKey}.title`, task.title);
  // #9912 (W6-8 of #9463): a cleared title is put back, and the field says why.
  const [titleNeeded, setTitleNeeded] = useState(false);
  const titleNeededId = useId();
  const [dates, setDates] = useDeviceParityState(`${parityKey}.dates`, { startDate: task.startDate, dueDate: task.dueDate });
  const [dateError, setDateError] = useState("");
  // The specialized type a person picked on a General task: those types start
  // from a template, so the editor explains that in place instead of closing.
  const [templateTypeChoice, setTemplateTypeChoice] = useState(null);
  const templateTypePending = Boolean(templateTypeChoice) && (task.taskType || "general") === "general";
  const templateConversionShown = templateTypePending && Boolean(onConvertType) && templates.some((item) => item.key === templateTypeChoice);
  const templateTypeNoteShown = templateTypePending && !templateConversionShown;
  const [progress, setProgress] = useDeviceParityState(`${parityKey}.progress`, task.progress);
  const [assigneeFilter, setAssigneeFilter] = useDeviceParityState(`${parityKey}.assigneeFilter`, "");
  const [editingDescription, setEditingDescription] = useDeviceParityState(`${parityKey}.editingDescription`, false);
  const [descriptionDraft, setDescriptionDraft] = useDeviceParityState(`${parityKey}.descriptionDraft`, task.description || "");
  const [body, setBody] = useDeviceParityState(`${parityKey}.body`, "");
  const [messageBody, setMessageBody] = useDeviceParityState(`${parityKey}.messageBody`, "");
  const [messageBusy, setMessageBusy] = useState(false);
  const [messageError, setMessageError] = useState("");
  const [mentionIds, setMentionIds] = useDeviceParityState(`${parityKey}.mentionIds`, []);
  const mentionRecipients = useMemo(() => {
    const people = assignees.filter((person) => person.id !== memberId);
    const names = new Map();
    for (const person of people) names.set(person.fullName, (names.get(person.fullName) || 0) + 1);
    // The authorized roster exposes no role or contact details. Its existing
    // person id is a stable, unambiguous reference when full names also match.
    return people.map((person) => ({
      id: person.id,
      label: names.get(person.fullName) > 1 ? `${person.fullName} (${person.id})` : person.fullName,
    }));
  }, [assignees, memberId]);
  const [recordLabel, setRecordLabel] = useDeviceParityState(`${parityKey}.recordLabel`, "");
  const [recordUrl, setRecordUrl] = useDeviceParityState(`${parityKey}.recordUrl`, "");
  const [recordBusy, setRecordBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileError, setFileError] = useState("");
  // Beyond the boolean busy: `checking` (bytes up, verdict pending, nothing
  // attached), a permanent rejection, and a stale verdict one re-check fixes.
  const [filePhase, setFilePhase] = useState("");
  const [staleFileId, setStaleFileId] = useState("");
  const [recordError, setRecordError] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [busy, setBusy] = useState(false);
  // Synchronous write locks (#8435), one key per write family, so a second
  // activation is refused before React commits that family's busy flag.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState("");
  const [writeError, setWriteError] = useState("");
  const reportWriteError = onWriteError || setWriteError;
  // Record #9891 (audit W6-5): the visible answer to Copy task link / key.
  // { taskId, kind: "url" | "key", ok, value }; shown only for the task it
  // was made for, a success fades after a few seconds, a refusal stays.
  const [copyNotice, setCopyNotice] = useState(null);
  const copyTicketRef = useRef(0);
  useEffect(() => {
    if (!copyNotice?.ok) return undefined;
    const timer = setTimeout(() => setCopyNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [copyNotice]);
  // Another task in the same window: drop the notice and retire any copy
  // still in flight, so it neither shows nor announces a result here or on
  // a return to the first task.
  useEffect(() => {
    copyTicketRef.current += 1;
    setCopyNotice(null);
  }, [task.id]);
  const [assigneeBusy, setAssigneeBusy] = useState(false);
  const assigneeWriteRef = useRef(false);

  const closePicker = useCallback(() => {
    pickerGenerationRef.current += 1;
    const trigger = triggerRef.current || assigneePillRef.current;
    pendingPickerFocusRef.current = trigger;
    if (popoverRef.current?.contains(document.activeElement)) trigger?.focus?.();
    setPicker(null);
  }, [setPicker]);

  // `aria-modal` describes the contract; full-branch inerting and scroll
  // locking enforce it through the retained closing frame. The helper also
  // reference-counts the delete confirmation nested above this workspace.
  useModalIsolation(backdropRef);

  // Blur is the commit trigger for the title and description drafts, but the
  // close paths (Escape, the backdrop, the ✕ button) skip it, and unmounting
  // a focused field fires no blur at all — so each close path flushes the
  // drafts itself. The keydown listener below only re-binds when
  // busy/picker/onClose change and would close over stale drafts; the ref
  // always holds the current render's flush.
  const flushDraftsRef = useRef(() => {});
  useEffect(() => {
    flushDraftsRef.current = flushDrafts;
  });

  // The ✕ button blurs the field it is clicked from BEFORE the click lands,
  // so the blur commit and the close-path flush would both see the same dirty
  // draft; each commit remembers the last value it sent so the second pass is
  // a no-op instead of a duplicate write.
  const sentRef = useRef({ title: null, description: null });
  const draftEditsRef = useRef({ title: null, description: null });
  const pendingDraftWritesRef = useRef(new Set());
  const draftWriteTailRef = useRef(null);

  const key = taskKey(task, chapterId);
  const selectedAssigneeIds = useMemo(() => {
    const ids = Array.isArray(task.assigneeIds) && task.assigneeIds.length
      ? task.assigneeIds
      : task.assigneeId ? [task.assigneeId] : [];
    return [...new Set(ids.filter(Boolean))];
  }, [task.assigneeId, task.assigneeIds]);
  const selectedAssignees = useMemo(
    () => selectedAssigneeIds.map((id) => assignees.find((person) => person.id === id)).filter(Boolean),
    [assignees, selectedAssigneeIds],
  );
  const thread = useMemo(
    () => [...comments].sort((a, b) =>
      String(a.createdAt).localeCompare(String(b.createdAt))
      || String(a.id).localeCompare(String(b.id))),
    [comments],
  );
  const privateThread = useMemo(
    () => messages
      .filter((message) => message.taskId === task.id && [message.senderId, message.recipientId].includes(memberId))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
    [memberId, messages, task.id],
  );
  const messageRecipientId = memberId === task.assigneeId
    ? task.createdBy
    : memberId === task.createdBy ? task.assigneeId : null;
  const canMessage = Boolean(onSendMessage && messageRecipientId && messageRecipientId !== memberId);
  const checklist = useMemo(() => parseChecklist(task.description || ""), [task.description]);
  const descriptionLines = useMemo(() => (task.description || "").split("\n"), [task.description]);
  const checklistByLine = useMemo(
    () => new Map(checklist.items.map((item) => [item.index, item])),
    [checklist],
  );
  const visibleAssignees = assignees.filter((person) =>
    person.fullName.toLowerCase().includes(assigneeFilter.trim().toLowerCase()));

  // Phase 2 surfaces. depLists reads the parent's RESOLVABLE edges, so a row
  // never renders keyless against a card the window no longer holds.
  const [depFilter, setDepFilter] = useDeviceParityState(`${parityKey}.depFilter`, "");
  const [depError, setDepError] = useState("");
  const [depBusy, setDepBusy] = useState(false);
  const depLists = useMemo(() => taskDependencyLists(dependencies, task.id), [dependencies, task.id]);
  const [subtaskTitle, setSubtaskTitle] = useDeviceParityState(`${parityKey}.subtaskTitle`, "");
  const [subtaskError, setSubtaskError] = useState("");
  const [subtaskBusy, setSubtaskBusy] = useState(false);
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchError, setWatchError] = useState("");
  const taskById = useMemo(() => new Map(tasks.map((item) => [item.id, item])), [tasks]);
  const depCandidates = useMemo(() => {
    const needle = depFilter.trim().toLowerCase();
    const existing = new Set(depLists.dependsOn.map((edge) => edge.dependsOnId));
    // Self, existing edges and cycle-closers are EXCLUDED, not disabled: the
    // picker offers only edges the server would accept (its advisory-locked
    // walk still owns the concurrent-editor race).
    return tasks
      .filter((item) => item.id !== task.id
        && !existing.has(item.id)
        && !wouldCreateDependencyCycle(dependencies, task.id, item.id)
        && (!needle
          || item.title.toLowerCase().includes(needle)
          || String(taskKey(item, chapterId) || "").toLowerCase().includes(needle)))
      .slice(0, 30);
  }, [chapterId, depFilter, depLists, dependencies, task.id, tasks]);
  const childEdges = useMemo(() => subtasks.filter((edge) => edge.parentTaskId === task.id), [subtasks, task.id]);
  const parentEdge = useMemo(() => subtasks.find((edge) => edge.subtaskId === task.id) || null, [subtasks, task.id]);
  const isWatched = watches.some((watch) => watch.taskId === task.id);
  // Fixed list, so the rendered digits and the quick-pick handler can never
  // disagree about which action "2" is.
  const actionItems = useMemo(() => {
    const items = [{ id: "url", icon: Link2, label: "kanban.copyTaskUrl" }];
    if (taskKey(task, chapterId)) items.push({ id: "key", icon: Hash, label: "kanban.copyTaskKey" });
    if (onDuplicate) items.push({ id: "duplicate", icon: CopyPlus, label: "kanban.duplicateTask" });
    return items;
  }, [chapterId, onDuplicate, task]);

  // Preserve dirty text and its original base across realtime updates. A clean
  // field adopts the authoritative value even when focused, so focus alone
  // cannot turn previously confirmed text into a new write on close.
  useEffect(() => {
    if (draftEditsRef.current.title !== null) setTitle(draftEditsRef.current.title.value);
    else setTitle(task.title);
  }, [setTitle, task.title]);

  useEffect(() => {
    setDates({ startDate: task.startDate, dueDate: task.dueDate });
    setDateError("");
  }, [setDates, task.startDate, task.dueDate]);

  useEffect(() => {
    setProgress(task.progress);
  }, [setProgress, task.progress]);

  useEffect(() => {
    // Same rule as the title: an open but untyped editor is clean, so it
    // adopts a teammate's newer text instead of resubmitting the old one.
    if (draftEditsRef.current.description !== null) setDescriptionDraft(draftEditsRef.current.description.value);
    else setDescriptionDraft(task.description || "");
  }, [editingDescription, setDescriptionDraft, task.description]);

  // The trap, copied from the task message dialog it replaces: Tab and
  // Shift+Tab wrap inside the dialog so focus can never land on the dimmed
  // board behind it. The Escape branch is the one addition — an open picker
  // absorbs it first, and preventDefault tells TasksView's window-level
  // keyboard map that this Escape is already spoken for.
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.defaultPrevented) return;
      // Keys typed into a command palette opened above the task are its own.
      if (event.target instanceof Element && event.target.closest(".command-palette")) return;
      if (presenceState === "closing" || deleteBusy) {
        if (["Escape", "Tab", "Enter", " "].includes(event.key)) event.preventDefault();
        return;
      }
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        if (picker) {
          closePicker();
          return;
        }
        const saved = flushDraftsRef.current();
        if (saved && typeof saved.then === "function") saved.then((ok) => { if (ok) onClose(); });
        else if (saved !== false) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll(
        "button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
      ) || [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, closePicker, deleteBusy, onClose, picker, presenceState]);

  // Focus has to enter the dialog on mount or the trap above has nothing to
  // wrap and the first Tab escapes to the board. The first control is the
  // workstream pill in the floating bar; the assign-to-message path overrides
  // it by opening the assignee picker instead.
  useEffect(() => {
    if (onAssignFocus) return;
    const first = dialogRef.current?.querySelector("button:not([disabled])");
    first?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot on mount: re-running when the dialog re-renders would yank focus out of whatever control the member is using.
  }, []);

  useLayoutEffect(() => {
    if (onAssignFocus && assigneePillRef.current && !triggerRef.current) {
      triggerRef.current = assigneePillRef.current;
    }
  }, [onAssignFocus]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if ((presenceState === "closing" || deleteBusy) && dialog?.contains(document.activeElement)) dialog.focus({ preventScroll: true });
  }, [deleteBusy, presenceState]);

  // A picker opens with focus inside it (the filter field when it has one),
  // and hands focus back to its trigger when it closes. The history popover
  // has neither options nor a field — focus stays on its trigger, whose
  // aria-expanded narrates the state.
  useEffect(() => {
    if (!picker) return;
    const root = popoverRef.current;
    if (!root) return;
    const field = root.querySelector("input");
    (field || root.querySelector('[role="option"], [role="menuitem"]'))?.focus({ preventScroll: true });
  }, [picker]);

  useEffect(() => {
    if (!picker) return undefined;
    function onPointerDown(event) {
      const trigger = triggerRef.current;
      const anchor = trigger?.closest(".kan-pick");
      if (anchor && event.target instanceof Node && !anchor.contains(event.target)) closePicker();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [closePicker, picker]);

  // Auto-grow: the title is a textarea styled as the h1 so a long title wraps
  // instead of scrolling inside a one-line box. jsdom reports scrollHeight 0,
  // so the guard also keeps tests from collapsing the field to nothing.
  useEffect(() => {
    const node = titleRef.current;
    if (!node) return;
    node.style.height = "auto";
    if (node.scrollHeight > 0) node.style.height = `${node.scrollHeight}px`;
  }, [title]);

  function openPicker(name, event) {
    if (picker === name) {
      closePicker();
      return;
    }
    pendingPickerFocusRef.current = null;
    pickerGenerationRef.current += 1;
    triggerRef.current = event.currentTarget;
    setPicker(name);
  }

  function finishPickerExit() {
    if (pickerNameRef.current !== null) return;
    const trigger = pendingPickerFocusRef.current;
    pendingPickerFocusRef.current = null;
    const active = document.activeElement;
    if (active === document.body || active === document.documentElement) trigger?.focus?.();
  }

  // Every write is one field. The board's own renumber/undo machinery lives in
  // the parent, and a full-object patch from here would race it — the last
  // full write would resurrect whatever the parent had just changed.
  function commit(patch, contentVersion) {
    reportWriteError("");
    let result;
    try {
      result = contentVersion === undefined ? onUpdate(patch) : onUpdate(patch, contentVersion);
    } catch (cause) {
      result = Promise.reject(cause);
    }
    // Pickers commit without awaiting. Observe their rejection here while
    // returning the original result so title/description keep their drafts
    // and the close path still refuses to close after a failed save.
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch((cause) => reportWriteError(t(rpcRefusalKey(cause, "tasks.errorUpdate"))));
      // Checklist toggles also write description without using the text-draft
      // queue. Close must wait for those outcomes as well as queued drafts.
      if (Object.hasOwn(patch, "title") || Object.hasOwn(patch, "description")) {
        const settled = Promise.resolve(result).then(() => true, () => false);
        pendingDraftWritesRef.current.add(settled);
        settled.then(() => pendingDraftWritesRef.current.delete(settled));
      }
    }
    return result;
  }

  function chooseStatus(status) {
    closePicker();
    if (status !== task.status) commit({ status });
  }

  function choosePriority(priority) {
    closePicker();
    if (priority !== task.priority) commit({ priority });
  }

  function chooseAssignee(assigneeId) {
    return runBusyWrite(busyWriteRef, "assignee", () => chooseAssigneeNow(assigneeId));
  }

  async function chooseAssigneeNow(assigneeId) {
    if (assigneeWriteRef.current) return;
    if (!onSetAssignees) {
      closePicker();
      setAssigneeFilter("");
      // commit observes the rejection; this branch must not create another
      // rejected async result by returning that promise.
      if ((assigneeId || null) !== (task.assigneeId || null)) commit({ assigneeId: assigneeId || null });
      return;
    }
    const next = assigneeId
      ? (selectedAssigneeIds.includes(assigneeId)
        ? selectedAssigneeIds.filter((id) => id !== assigneeId)
        : [...selectedAssigneeIds, assigneeId])
      : [];
    assigneeWriteRef.current = true;
    setAssigneeBusy(true);
    reportWriteError("");
    try {
      await onSetAssignees(task.id, next);
      if (!assigneeId) setAssigneeFilter("");
    } catch (cause) {
      reportWriteError(t(rpcRefusalKey(cause, "tasks.errorUpdate")));
    } finally {
      assigneeWriteRef.current = false;
      setAssigneeBusy(false);
    }
  }

  function chooseWorkstream(name) {
    closePicker();
    if (name !== task.workstream) commit({ workstream: name });
  }

  // A clipboard write shows its result in the modal and announces success
  // through the parent's live region. A denied or missing clipboard never
  // claims "copied": it says so and puts the text in a read-only field the
  // person can select and copy by hand. Only the newest copy writes.
  async function copyToClipboard(text, kind) {
    const ticket = ++copyTicketRef.current;
    const taskId = task.id;
    try {
      await navigator.clipboard.writeText(text);
      if (ticket !== copyTicketRef.current) return;
      setCopyNotice({ taskId, kind, ok: true, value: text });
      onAnnounce?.(t(kind === "key" ? "kanban.copiedKey" : "kanban.copiedLink"));
    } catch {
      if (ticket !== copyTicketRef.current) return;
      setCopyNotice({ taskId, kind, ok: false, value: text });
    }
  }

  function runAction(actionId) {
    closePicker();
    if (actionId === "url") {
      // The deep link IS the current URL: writeTaskParam put ?task=<key>
      // there the moment this modal opened.
      copyToClipboard(window.location.href, "url");
    } else if (actionId === "key") {
      const currentKey = taskKey(task, chapterId);
      if (currentKey) copyToClipboard(currentKey, "key");
    } else if (actionId === "duplicate") {
      onDuplicate?.(task);
    }
  }

  function addDependency(dependsOnId) {
    return runBusyWrite(busyWriteRef, "dependency", () => addDependencyNow(dependsOnId));
  }

  async function addDependencyNow(dependsOnId) {
    if (!onAddDependency) return;
    const requestGeneration = pickerGenerationRef.current;
    setDepError("");
    setDepBusy(true);
    try {
      await onAddDependency(task.id, dependsOnId);
      setDepFilter("");
      if (pickerNameRef.current === "deps" && pickerGenerationRef.current === requestGeneration) closePicker();
    } catch (cause) {
      // 23505 = the edge already exists (raced another editor); 22023 = the
      // server's cycle/chapter/liveness guard refused it. Both are states the
      // picker's exclusions could not see at click time.
      setDepError(cause?.code === "23505"
        ? t("kanban.depExists")
        : cause?.code === "22023"
          ? t("kanban.depRefused")
          : t(rpcRefusalKey(cause, "tasks.errorSave")));
    } finally {
      setDepBusy(false);
    }
  }

  async function removeDependency(edge) {
    if (!onRemoveDependency) return;
    setDepError("");
    try {
      await onRemoveDependency(edge.id);
    } catch (cause) {
      setDepError(t(rpcRefusalKey(cause, "tasks.errorSave")));
    }
  }
  function submitSubtask(event) {
    return runBusyWrite(busyWriteRef, "subtask", () => submitSubtaskNow(event), event);
  }

  async function submitSubtaskNow(event) {
    event.preventDefault();
    if (!onCreateSubtask || !subtaskTitle.trim() || subtaskBusy) return;
    setSubtaskError("");
    setSubtaskBusy(true);
    try {
      await onCreateSubtask(task.id, subtaskTitle.trim());
      setSubtaskTitle("");
    } catch (cause) {
      setSubtaskError(t(rpcRefusalKey(cause, "tasks.errorSave")));
    } finally {
      setSubtaskBusy(false);
    }
  }

  async function toggleSubtask(child) {
    if (!onUpdateSubtask) return;
    setSubtaskError("");
    try {
      // A reopen goes where statusCycle sends every other reopened card
      // (to_do), not to a column of its own choosing.
      await onUpdateSubtask(child.id, { status: child.status === "done" ? statusCycle("done").to : "done" });
    } catch (cause) {
      setSubtaskError(t(rpcRefusalKey(cause, "tasks.errorSave")));
    }
  }

  async function removeSubtask(edge) {
    if (!onRemoveSubtask) return;
    setSubtaskError("");
    try {
      await onRemoveSubtask(edge.id);
    } catch (cause) {
      setSubtaskError(t(rpcRefusalKey(cause, "tasks.errorSave")));
    }
  }

  function toggleWatch() {
    return runBusyWrite(busyWriteRef, "watch", () => toggleWatchNow());
  }

  async function toggleWatchNow() {
    if (watchBusy || (!onWatch && !onUnwatch)) return;
    setWatchError("");
    setWatchBusy(true);
    try {
      if (isWatched) await onUnwatch?.(task.id);
      else await onWatch?.(task.id);
    } catch (cause) {
      setWatchError(t(rpcRefusalKey(cause, "tasks.errorSave")));
    } finally {
      setWatchBusy(false);
    }
  }


  function handlePickKeyDown(event) {
    if (!picker) return;
    const isTextInput = ["INPUT", "TEXTAREA"].includes(event.target.tagName);
    if (isTextInput && (event.key === "Home" || event.key === "End")) return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      const options = [...(popoverRef.current?.querySelectorAll('[role="option"], [role="menuitem"]') || [])];
      if (!options.length) return;
      event.preventDefault();
      const current = options.indexOf(document.activeElement);
      let next;
      if (event.key === "Home") next = 0;
      else if (event.key === "End") next = options.length - 1;
      else {
        const step = event.key === "ArrowDown" ? 1 : -1;
        next = current < 0 ? (step > 0 ? 0 : options.length - 1) : (current + step + options.length) % options.length;
      }
      options.forEach((option, index) => { option.tabIndex = index === next ? 0 : -1; });
      options[next].focus({ preventScroll: true });
      return;
    }
    if (!/^[0-9]$/.test(event.key)) return;
    // Quick-pick digits are t0ggles' picker idiom, but the assignee popover
    // owns a filter field where a digit is part of a name, not a choice.
    if (isTextInput) return;
    const digit = Number(event.key);
    if (picker === "status" && STATUS_IDS[digit - 1]) {
      event.preventDefault();
      chooseStatus(STATUS_IDS[digit - 1]);
    } else if (picker === "priority" && PRIORITY_IDS[digit - 1]) {
      event.preventDefault();
      choosePriority(PRIORITY_IDS[digit - 1]);
    } else if (picker === "assignee" && digit === 0) {
      event.preventDefault();
      chooseAssignee("");
    } else if (picker === "actions" && actionItems[digit - 1]) {
      event.preventDefault();
      runAction(actionItems[digit - 1].id);
    }
  }

  // Existing-file actions retain their read/recheck errors here. The shared
  // selection control owns preparation, naming, preview and upload recovery.
  // A rejection is a decision about these bytes, so it is reported as final and
  // no retry is offered; everything else stays an ordinary retryable failure.
  // A MemberApiError message is `${label}: ${driver text}` and never reaches
  // the member; copy the app authored itself (demo vault, etc.) still does.
  function reportFileError(error) {
    const code = error?.privateFileCode || "";
    if (code === "rejected") { setFilePhase("rejected"); setFileError(t("uploads.rejected")); return; }
    setFilePhase("");
    if (code === "rate-limited") { setFileError(t("uploads.rateLimited")); return; }
    if (code === "pending-check") { setFileError(t("uploads.pendingCheck")); return; }
    if (code === "unsupported-format") { setFileError(t("uploads.unsupportedFormat")); return; }
    setFileError(error instanceof MemberApiError ? t("tasks.errorUpdate") : (error?.message || t("tasks.errorUpdate")));
  }

  async function attachDeviceFile(file, options) {
    setFileError("");
    setFilePhase("");
    return onAddFile(file, options);
  }

  async function openDeviceFile(file) {
    if (!onOpenFile) return;
    setFileError("");
    setFilePhase("");
    setStaleFileId("");
    // Open on the tap, before any await: Safari and iOS spend the transient
    // user-activation window on the first await, and a post-await window.open
    // silently opens nothing there. `noopener` can make Safari return null even
    // when the tab did open, so the opener is severed by hand instead.
    const popup = window.open("", "_blank");
    if (!popup) { setFileError(t("uploads.popupBlocked")); return; }
    popup.opener = null;
    try {
      const blob = await onOpenFile(file);
      if (!blob) { popup.close(); return; }
      // withObjectUrl defers the revoke: the new tab has not fetched the
      // object URL yet when this returns.
      withObjectUrl(blob, (url) => { popup.location = url; });
    } catch (error) {
      popup.close();
      // Storage refusing an authorized read means the clean verdict aged out.
      if (error?.privateFileCode === "stale" && onRecheckFile) {
        setStaleFileId(file.id);
        setFileError(t("uploads.stale"));
        return;
      }
      reportFileError(error);
    }
  }

  function recheckDeviceFile(file) {
    return runBusyWrite(busyWriteRef, "file", () => recheckDeviceFileNow(file));
  }

  async function recheckDeviceFileNow(file) {
    if (!onRecheckFile || fileBusy) return;
    setFileError("");
    setFilePhase("checking");
    setFileBusy(true);
    try {
      await onRecheckFile(file);
      setStaleFileId("");
      setFilePhase("");
    } catch (error) {
      setFilePhase("");
      if (error?.privateFileCode === "rejected") {
        setStaleFileId("");
        setFileError(t("uploads.rejected"));
      } else {
        setFileError(t("uploads.recheckFailed"));
      }
    } finally {
      setFileBusy(false);
    }
  }

  function removeDeviceFile(file) {
    return runBusyWrite(busyWriteRef, "file", () => removeDeviceFileNow(file));
  }

  async function removeDeviceFileNow(file) {
    if (!onRemoveFile) return;
    setFileError("");
    setFilePhase("");
    setFileBusy(true);
    try {
      await onRemoveFile(file);
    } catch (error) {
      reportFileError(error);
    } finally {
      setFileBusy(false);
    }
  }

  function rememberDraft(field, value) {
    const previous = draftEditsRef.current[field];
    const source = getAuthoritativeTask ? getAuthoritativeTask() : task;
    // Edits made while a save is pending share its provenance. Only a confirmed
    // save advances that base; an optimistic row or a teammate update never does.
    draftEditsRef.current[field] = { value, base: previous?.base || { value: source?.[field] || "" } };
  }

  function saveDraftPatch(patch) {
    const fields = Object.keys(patch);
    const request = { patch, bases: {} };
    for (const field of fields) {
      if (!draftEditsRef.current[field]) rememberDraft(field, patch[field]);
      request.bases[field] = draftEditsRef.current[field].base;
      sentRef.current[field] = request;
    }
    const finish = (saved, result) => {
      request.settled = true;
      for (const field of fields) {
        const current = draftEditsRef.current[field];
        const latestRequest = sentRef.current[field] === request;
        if (saved) {
          const confirmed = result?.[field] ?? patch[field];
          request.bases[field].value = confirmed;
          const value = field === "title" ? current?.value.trim() : current?.value;
          if (current?.base === request.bases[field] && value === patch[field]) draftEditsRef.current[field] = null;
        }
        // Keep a successful echo until the parent catches up, including sync
        // handlers. New typing is dirty again and cannot reuse this no-op guard.
        if (latestRequest && !saved) sentRef.current[field] = null;
        const remaining = draftEditsRef.current[field];
        const source = getAuthoritativeTask ? getAuthoritativeTask() : saved ? { ...task, ...patch, ...result } : task;
        const value = remaining?.value ?? source?.[field] ?? patch[field];
        if (field === "title") setTitle(value);
        else {
          setDescriptionDraft(value);
          if (!saved && latestRequest) setEditingDescription(true);
        }
      }
      return saved;
    };
    const run = () => {
      const source = getAuthoritativeTask ? getAuthoritativeTask() : task;
      if (!source || fields.some((field) => (source[field] || "") !== request.bases[field].value)) {
        reportWriteError(t("rpcError.conflict"));
        return finish(false);
      }
      if (fields.every((field) => (source[field] || "") === patch[field])) return finish(true, source);
      // The board may still be finishing an earlier date or status write that
      // advances the token. Send the bases so it can re-check them at dispatch.
      const version = getAuthoritativeTask
        ? { updatedAt: source.updatedAt ?? null, bases: Object.fromEntries(fields.map((field) => [field, request.bases[field].value])) }
        : undefined;
      const result = commit(patch, version);
      return result && typeof result.then === "function"
        ? result.then((row) => finish(true, row), () => finish(false)) : finish(true, result);
    };
    // Settle provenance before dispatching the next content edit. B's failure
    // cannot mark C refused, and B's success advances C's own base before its CAS.
    const result = draftWriteTailRef.current ? draftWriteTailRef.current.then(run) : run();
    if (result && typeof result.then === "function") {
      draftWriteTailRef.current = result;
      pendingDraftWritesRef.current.add(result);
      result.then(() => {
        pendingDraftWritesRef.current.delete(result);
        if (draftWriteTailRef.current === result) draftWriteTailRef.current = null;
      });
    }
    return result;
  }

  function alreadySubmitted(field, value) {
    const sent = sentRef.current[field];
    return sent?.patch[field] === value && (!sent.settled || !draftEditsRef.current[field]);
  }

  function commitTitle() {
    const trimmed = title.trim();
    if (!trimmed) {
      draftEditsRef.current.title = null;
      setTitle(task.title);
      setTitleNeeded(true);
      return true;
    }
    if (alreadySubmitted("title", trimmed)) return true;
    if (trimmed === task.title && !draftEditsRef.current.title) return true;
    return saveDraftPatch({ title: trimmed });
  }

  // The guard is client-side only — nothing server-side rejects a due date
  // before its start, and the board must never render a negative-length bar.
  // The PAIR is validated and committed together: a refused value stays
  // visible in its field (with the error) so the member can see what they
  // typed, and the moment the other field makes the pair legal, BOTH drafts
  // commit in one patch. Committing only the field that just changed was the
  // phantom-date bug the modal test wave caught — the refused draft lingered
  // on screen, gated the sibling's validation, and was never saved.
  //
  // Clearing a field is intentional, not invalid: both columns are nullable,
  // so an emptied input commits null (the truthy-only patch used to drop the
  // clear and the stored date silently came back). A cleared side also skips
  // the pair guard — half a range is legal, only an inverted pair is not.
  function commitDates(next) {
    setDates(next);
    if (next.startDate && next.dueDate && next.dueDate < next.startDate) {
      setDateError(t("tasks.dateError"));
      return;
    }
    setDateError("");
    const patch = {};
    if ((next.startDate || null) !== (task.startDate || null)) patch.startDate = next.startDate || null;
    if ((next.dueDate || null) !== (task.dueDate || null)) patch.dueDate = next.dueDate || null;
    if (Object.keys(patch).length) commit(patch);
  }

  function commitStartDate(value) {
    commitDates({ ...dates, startDate: value });
  }

  function commitDueDate(value) {
    commitDates({ ...dates, dueDate: value });
  }

  // Range inputs fire change on every step of a drag. Committing on the END of
  // the gesture (pointer up, key up, blur) is one write per adjustment instead
  // of twenty.
  function commitProgress() {
    if (task.status === "done") return;
    if (Number(progress) !== Number(task.progress)) commit({ progress: Number(progress) });
  }

  function commitDescription(event = null) {
    // A blur caused by focus LEAVING THE DOCUMENT (the companion iframe's
    // mirrored editor grabbing it, or an OS window switch) is not the member
    // finishing an edit, so the editor stays open. The words are still saved
    // (REQ-UG-FIRST-CLICK-AND-DEAD-CONTROLS-20261030): the field no
    // longer has focus, so leaving the task afterwards fires no second blur
    // and an unsaved draft was lost with the page.
    const leftDocument = event?.type === "blur" && event.relatedTarget === null && !document.hasFocus();
    if (!leftDocument) setEditingDescription(false);
    if (alreadySubmitted("description", descriptionDraft)) return true;
    if (descriptionDraft === (task.description || "") && !draftEditsRef.current.description) return true;
    return saveDraftPatch({ description: descriptionDraft });
  }

  // Every path that closes the modal — Escape (via flushDraftsRef), the
  // backdrop and the ✕ button — flushes the two blur-committed drafts through
  // the SAME validation their blur handlers use, so a typed-but-not-blurred
  // edit is saved instead of silently discarded. Dates, progress and the
  // pickers commit as they change and need no flushing.
  //
  // Both drafts ride ONE patch: title and description are content writes
  // guarded by a single compare-and-swap token server-side, and flushing them
  // as two same-tick commits handed the second write a token the first had
  // already burned (SQLSTATE 40001) — the modal then refused to close and the
  // description looked unsavable.
  function flushDrafts() {
    // A blur may already have submitted the optimistic title. Wait for that
    // result before closing, including when there is no additional draft.
    const pending = [...pendingDraftWritesRef.current];
    if (pending.length) {
      return Promise.all(pending).then((outcomes) => outcomes.every(Boolean) ? flushDraftsRef.current() : false);
    }
    const patch = {};
    const trimmedTitle = title.trim();
    if (!trimmedTitle) { draftEditsRef.current.title = null; setTitle(task.title); }
    else if ((draftEditsRef.current.title || trimmedTitle !== task.title) && !alreadySubmitted("title", trimmedTitle)) patch.title = trimmedTitle;
    if (editingDescription && (draftEditsRef.current.description || descriptionDraft !== (task.description || "")) && !alreadySubmitted("description", descriptionDraft)) patch.description = descriptionDraft;
    if (editingDescription) setEditingDescription(false);
    if (!Object.keys(patch).length) return true;
    return saveDraftPatch(patch);
  }

  function closeModal() {
    if (presenceState === "closing" || deleteBusy) return;
    const saved = flushDrafts();
    if (saved && typeof saved.then === "function") saved.then((ok) => { if (ok) onClose(); });
    else if (saved) onClose();
  }

  function toggleChecklist(lineIndex) {
    const before = (getAuthoritativeTask ? getAuthoritativeTask() : task)?.description || "";
    const next = toggleChecklistItem(task.description || "", lineIndex);
    Promise.resolve(commit({ description: next })).then((row) => {
      // A description draft opened while this toggle was in flight took the
      // pre-toggle text as its base. This confirmed write is the member's
      // own, so advance that base; otherwise every later save and Close
      // would report a conflict with themselves.
      const draft = draftEditsRef.current.description;
      if (draft && draft.base.value === before) draft.base.value = row?.description ?? next;
    }).catch(() => {});
  }

  function submitComment(event) {
    return runBusyWrite(busyWriteRef, "comment", () => submitCommentNow(event), event);
  }

  async function submitCommentNow(event) {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || !onAddComment) return;
    setBusy(true);
    setError("");
    try {
      await onAddComment(task.id, trimmed, mentionIds);
      setBody("");
      setMentionIds([]);
    } catch (cause) {
      setError(t(rpcRefusalKey(cause, "tasks.errorComment")));
    } finally {
      setBusy(false);
    }
  }

  function submitPrivateMessage(event) {
    return runBusyWrite(busyWriteRef, "message", () => submitPrivateMessageNow(event), event);
  }

  async function submitPrivateMessageNow(event) {
    event.preventDefault();
    const trimmed = messageBody.trim();
    if (!trimmed || !canMessage || messageBusy) return;
    setMessageBusy(true);
    setMessageError("");
    try {
      await onSendMessage(task.id, trimmed);
      setMessageBody("");
    } catch (cause) {
      setMessageError(t(rpcRefusalKey(cause, "tasks.errorMessage")));
    } finally {
      setMessageBusy(false);
    }
  }

  function toggleMention(personId) {
    setMentionIds((current) => current.includes(personId)
      ? current.filter((id) => id !== personId)
      : [...current, personId]);
  }

  function submitAuthorizedRecord(event) {
    return runBusyWrite(busyWriteRef, "record", () => submitAuthorizedRecordNow(event), event);
  }

  async function submitAuthorizedRecordNow(event) {
    event.preventDefault();
    const label = recordLabel.trim();
    const url = recordUrl.trim();
    if (!onAddAttachment || !label || !url) return;
    if (!/^\/m(?:\/|$)/.test(url) || /\s/.test(url)) {
      setRecordError(t("tasks.recordUrlError"));
      return;
    }
    setRecordBusy(true);
    setRecordError("");
    try {
      await onAddAttachment(task.id, label, url);
      setRecordLabel("");
      setRecordUrl("");
    } catch (cause) {
      setRecordError(t(rpcRefusalKey(cause, "tasks.errorSave")));
    } finally {
      setRecordBusy(false);
    }
  }

  async function removeAuthorizedRecord(attachmentId) {
    if (!onRemoveAttachment) return;
    setRecordError("");
    try {
      await onRemoveAttachment(attachmentId);
    } catch (cause) {
      setRecordError(t(rpcRefusalKey(cause, "tasks.errorSave")));
    }
  }

  function attachSelectedDocument() {
    return runBusyWrite(busyWriteRef, "record", () => attachSelectedDocumentNow());
  }

  async function attachSelectedDocumentNow() {
    const document = documents.find((item) => item.id === documentId);
    if (!document || !onAddAttachment || recordBusy) return;
    setRecordBusy(true);
    setRecordError("");
    try {
      const params = new URLSearchParams({ document: document.id });
      // Demo is a route capability, not persisted task data. Preserve it in
      // the authorized link so following the record never falls through to
      // the signed-out shell during a review session.
      if (new URLSearchParams(window.location.search).get("demo") === "1") params.set("demo", "1");
      await onAddAttachment(task.id, document.title, `/m/organize?${params.toString()}`);
      setDocumentId("");
    } catch (cause) {
      setRecordError(t(rpcRefusalKey(cause, "tasks.errorSave")));
    } finally {
      setRecordBusy(false);
    }
  }

  const PriorityIcon = PRIORITY_ICONS[task.priority] || Minus;
  const statusLabel = t(`tasks.status.${task.status}`);
  const priorityLabel = t(PRIORITY_LABELS[task.priority] || "tasks.priorityMedium");
  const stampFormat = dateTimeFormat(lang, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const dueFormat = new Intl.DateTimeFormat(localeFor(lang), { month: "short", day: "numeric" });
  // updated_by is server-stamped on every write but absent from rows older
  // than its column read; the row renders its date always and its actor only
  // when there is one to name.
  const updatedByName = task.updatedBy
    ? (assignees.find((person) => person.id === task.updatedBy)?.fullName || t("tasks.chapterMember"))
    : null;
  const activityRows = [...activity]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 24);
  const depTotal = depLists.dependsOn.length + depLists.blocking.length;
  const interactionLocked = presenceState === "closing" || deleteBusy;

  return (
    <div
      ref={backdropRef}
      className="kan-modal-backdrop sg-detail-layer"
      role="presentation"
      data-state={presenceState}
      onTransitionEnd={onPresenceTransitionEnd || undefined}
      onMouseDown={(event) => event.target === event.currentTarget && !interactionLocked && !busy && closeModal()}
    >
      <section
        ref={dialogRef}
        className="kan-modal sg-detail-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby={key ? `${uid}-key` : undefined}
        aria-label={key ? undefined : task.title}
        aria-busy={deleteBusy || undefined}
        tabIndex={-1}
        onClickCapture={(event) => {
          if (!interactionLocked) return;
          event.preventDefault();
          event.stopPropagation();
        }}
        onKeyDownCapture={(event) => {
          if (!interactionLocked) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <p className="visually-hidden" role="status" aria-live="polite">{liveMessage}</p>
        <div className="kan-modal__contents" inert={deleteBusy ? true : undefined}>
        <div className="kan-modal__bar">
          <div className="kan-pick" onKeyDown={handlePickKeyDown}>
            <button
              type="button"
              className="kan-modal__pill kan-modal__ws"
              aria-haspopup="listbox"
              aria-expanded={picker === "workstream"}
              aria-controls={`${uid}-ws-popover`}
              onClick={(event) => openPicker("workstream", event)}
            >
              <i className={`kan-ws-icon kan-ws-${workstreamColorIndex(task.workstream || "")}`} aria-hidden="true">
                {(task.workstream || "").slice(0, 1).toUpperCase()}
              </i>
              <span>{task.workstream}</span>
            </button>
            <RetainedPopover id={`${uid}-ws-popover`} open={picker === "workstream"} popoverRef={popoverRef} onExited={finishPickerExit}>
                <p className="kan-popover__title" id={`${uid}-ws`}>{t("kanban.workstreamPicker")}</p>
                <div className="kan-popover__list" role="listbox" aria-labelledby={`${uid}-ws`}>
                  {workstreamNames.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className={name === task.workstream ? "kan-popover__opt kan-popover__opt--on" : "kan-popover__opt"}
                      role="option" aria-selected={name === task.workstream}
                      onClick={() => chooseWorkstream(name)}
                    >
                      <i className={`kan-ws-icon kan-ws-${workstreamColorIndex(name)}`} aria-hidden="true">
                        {name.slice(0, 1).toUpperCase()}
                      </i>
                      <span>{name}</span>
                    </button>
                  ))}
                </div>
            </RetainedPopover>
          </div>
          <span className="kan-modal__spacer" />
          <div className="kan-pick">
            <button
              type="button"
              className="kan-modal__round"
              aria-expanded={picker === "history"}
              aria-controls={`${uid}-history-popover`}
              aria-label={t("kanban.history")}
              onClick={(event) => openPicker("history", event)}
            >
              <Clock3 size={17} />
            </button>
            <RetainedPopover id={`${uid}-history-popover`} open={picker === "history"} popoverRef={popoverRef} onExited={finishPickerExit} className="kan-popover--history" role="group" aria-label={t("kanban.history")}>
                <p className="kan-popover__title" aria-hidden="true">{t("kanban.history")}</p>
                {activityRows.length > 0 ? activityRows.map((entry) => {
                  const actor = assignees.find((person) => person.id === entry.actorId)?.fullName || t("tasks.chapterMember");
                  return (
                    <div className="kan-histrow" key={entry.id}>
                      <span>{t(`kanban.activity.${entry.action}`)}</span>
                      <strong className="task-owned">{actor}</strong>
                      <time className="task-owned" dateTime={entry.createdAt}>{stampFormat.format(new Date(entry.createdAt))}</time>
                    </div>
                  );
                }) : task.createdAt && (
                  <div className="kan-histrow">
                    <span>{t("kanban.historyCreated")}</span>
                    <strong className="task-owned">{creatorName || t("tasks.chapterMember")}</strong>
                    <time className="task-owned" dateTime={task.createdAt}>{stampFormat.format(new Date(task.createdAt))}</time>
                  </div>
                )}
                {activityRows.length === 0 && task.updatedAt && (
                  <div className="kan-histrow">
                    <span>{t("kanban.historyUpdated")}</span>
                    {updatedByName && <strong className="task-owned">{updatedByName}</strong>}
                    <time className="task-owned" dateTime={task.updatedAt}>{stampFormat.format(new Date(task.updatedAt))}</time>
                  </div>
                )}
            </RetainedPopover>
          </div>
          <div className="kan-pick" onKeyDown={handlePickKeyDown}>
            <button
              type="button"
              className="kan-modal__round"
              aria-haspopup="menu"
              aria-expanded={picker === "actions"}
              aria-controls={`${uid}-actions-popover`}
              aria-label={t("kanban.actions")}
              onClick={(event) => openPicker("actions", event)}
            >
              <MoreHorizontal size={18} />
            </button>
            <RetainedPopover id={`${uid}-actions-popover`} open={picker === "actions"} popoverRef={popoverRef} onExited={finishPickerExit} className="kan-popover--actions">
                <p className="kan-popover__title" id={`${uid}-actions`} aria-hidden="true">{t("kanban.actions")}</p>
                <div className="kan-popover__list" role="menu" aria-labelledby={`${uid}-actions`}>
                  {actionItems.map((item, index) => {
                    const Icon = item.icon;
                    return (
                      <button key={item.id} type="button" className="kan-popover__opt" role="menuitem" onClick={() => runAction(item.id)}>
                        <Icon size={16} aria-hidden="true" />
                        <span>{t(item.label)}</span>
                        <em className="kan-kbd" aria-hidden="true">{index + 1}</em>
                      </button>
                    );
                  })}
                </div>
            </RetainedPopover>
          </div>
          {onDelete && (
            <BusyButton type="button" className="kan-modal__round kan-modal__round--danger" onClick={() => onDelete(task)} pending={busy || deleteBusy} aria-label={t("tasks.delete")}>
              <Trash2 size={17} />
            </BusyButton>
          )}
          <BusyButton type="button" className="kan-modal__round" onClick={closeModal} pending={busy} aria-label={t("tasks.close")}>
            <X size={18} />
          </BusyButton>
        </div>

        {automationLink}
        {connectedActions}
        {(onWriteError ? parentError : writeError || parentError) && <p className="tasks-error" role="alert">{onWriteError ? parentError : writeError || parentError}</p>}
        {copyNotice?.taskId === task.id && (copyNotice.ok
          // The parent's live region already announces a success; the
          // modal's own line speaks only when there is no parent to do it.
          ? <p className="kan-copy-notice" role={onAnnounce ? undefined : "status"}>
            {t(copyNotice.kind === "key" ? "kanban.copiedKey" : "kanban.copiedLink")}
          </p>
          : <div className="kan-copy-notice kan-copy-notice--failed">
            <p id={`${uid}-copy-failed`} role="alert">
              {t(copyNotice.kind === "key" ? "kanban.copyFailedKey" : "kanban.copyFailedLink")}
            </p>
            <input
              type="text"
              readOnly
              aria-labelledby={`${uid}-copy-failed`}
              value={copyNotice.value}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button type="button" className="kan-copy-notice__dismiss" onClick={() => setCopyNotice(null)}>
              {t("kanban.copyNoticeDismiss")}
            </button>
          </div>)}
        {(canMessage || privateThread.length > 0) && <article className="kan-modal__card">
          <header className="kan-modal__head">
            <h3 className="kan-disclosure-heading">
              <button
                type="button"
                className="kan-disclosure"
                aria-expanded={messagesExpanded}
                aria-controls={`${uid}-messages-panel`}
                onClick={() => setMessagesExpanded((current) => !current)}
              >
                <span>{t("tasks.privateMessages")}</span>
                {privateThread.length > 0 && <span className="kan-deps__count" aria-hidden="true">{privateThread.length}</span>}
                <ChevronDown className="kan-disclosure__icon" size={16} aria-hidden="true" />
              </button>
            </h3>
          </header>
          <DisclosurePanel id={`${uid}-messages-panel`} open={messagesExpanded}>
            {!canMessage && <p className="kan-records__hint">{t("tasks.messageHistoryOnly")}</p>}
            <div className="task-message-thread" aria-live="polite" aria-label={t("tasks.messageThread")}>
              {privateThread.length === 0 && <p className="task-message-thread__empty">{t("tasks.messageEmpty")}</p>}
              {privateThread.map((message) => {
                const mine = message.senderId === memberId;
                const sender = assignees.find((person) => person.id === message.senderId);
                return <article key={message.id} className={mine ? "task-message task-message--mine" : "task-message"}>
                  <strong>{mine ? t("tasks.you") : sender?.fullName || t("tasks.chapterMember")}</strong>
                  <p>{message.body}</p>
                  <time dateTime={message.createdAt}>{stampFormat.format(new Date(message.createdAt))}</time>
                  {renderConnectedMessageActions?.(message)}
                </article>;
              })}
            </div>
            {canMessage && <form className="task-message-composer" onSubmit={submitPrivateMessage}>
              <label>
                <span className="visually-hidden">{t("tasks.messagePlaceholder")}</span>
                <BusyTextarea value={messageBody} onChange={(event) => { setMessageBody(event.target.value); setMessageError(""); }} placeholder={t("tasks.messagePlaceholder")} maxLength={2000} pending={messageBusy} required />
              </label>
              <div>
                <small>{messageBody.length}/2000</small>
                <BusyButton type="submit" pending={messageBusy} disabled={!messageBody.trim()}><Send size={16} aria-hidden="true" /> {messageBusy ? t("tasks.sendingMessage") : t("tasks.sendMessage")}</BusyButton>
              </div>
              {messageError && <p className="tasks-error" role="alert">{messageError}</p>}
            </form>}
          </DisclosurePanel>
        </article>}

        <article className="kan-modal__card">
          <div className="kan-modal__keyline">
            <span className="kan-card__key" id={`${uid}-key`} title={key ? t("kanban.taskKey", { key }) : undefined}>
              {key || ""}
            </span>
            <div className="kan-modal__taskcontrols">
              <BusyButton
                ref={assigneePillRef}
                type="button"
                className="kan-watch"
                role="switch"
                aria-checked={isWatched}
                aria-describedby={`${uid}-watch-note`}
                aria-label={t("kanban.watchTask")}
                pending={watchBusy}
                onClick={toggleWatch}
              >
                <span className="kan-watch__track" aria-hidden="true">
                  <span className="kan-watch__fill" />
                  <span className="kan-watch__thumb">
                    <X className="kan-watch__cue kan-watch__cue--off" size={13} />
                    <Bell className="kan-watch__cue kan-watch__cue--on" size={13} />
                  </span>
                </span>
              </BusyButton>
            <div className="kan-pick kan-pick--end" onKeyDown={handlePickKeyDown}>
              <button
                type="button"
                className={`kan-status-pill kan-status-pill--${task.status}`}
                aria-haspopup="listbox"
                aria-expanded={picker === "status"}
                aria-controls={`${uid}-status-popover`}
                onClick={(event) => openPicker("status", event)}
              >
                <span>{statusLabel}</span>
                <ChevronsUpDown size={14} aria-hidden="true" />
              </button>
              <RetainedPopover id={`${uid}-status-popover`} open={picker === "status"} popoverRef={popoverRef} onExited={finishPickerExit}>
                  <p className="kan-popover__title" id={`${uid}-status`}>{t("kanban.statusPicker")}</p>
                  <div className="kan-popover__list" role="listbox" aria-labelledby={`${uid}-status`}>
                    {STATUS_IDS.map((status, index) => (
                      <button
                        key={status}
                        type="button"
                        className={status === task.status ? "kan-popover__opt kan-popover__opt--on" : "kan-popover__opt"}
                        role="option" aria-selected={status === task.status}
                        onClick={() => chooseStatus(status)}
                      >
                        <i className={`kan-dot kan-dot--${status}`} aria-hidden="true" />
                        <span>{t(`tasks.status.${status}`)}</span>
                        {statusCounts && <b>{statusCounts[status] ?? 0}</b>}
                        <em className="kan-kbd" aria-hidden="true">{index + 1}</em>
                      </button>
                    ))}
                  </div>
              </RetainedPopover>
            </div>
            </div>
            {watchError && <span className="tasks-error kan-watch__error" role="alert">{watchError}</span>}
            <span className="visually-hidden" id={`${uid}-watch-note`}>{t("kanban.watchPreferenceOnly")}</span>
          </div>

          <label className="kan-modal__titlefield">
            <span className="visually-hidden">{t("tasks.taskTitle")}</span>
            <textarea
              ref={titleRef}
              className="kan-title"
              rows={1}
              value={title}
              onChange={(event) => {
                const next = limitTaskTitle(event.target.value, title);
                rememberDraft("title", next);
                setTitle(next);
                setTitleNeeded(false);
              }}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                // The field is a textarea for wrapping, not for multi-line
                // titles — Enter means "done", the same as leaving it.
                event.preventDefault();
                event.currentTarget.blur();
              }}
              aria-describedby={titleNeeded ? titleNeededId : undefined}
            />
          </label>
          {titleNeeded && <p id={titleNeededId} className="tasks-error" role="alert">{t("tasks.titleRequired")}</p>}
          {creatorName && <p className="kan-modal__creator">{t("tasks.openedBy", { name: creatorName })}</p>}

          <details
            className="kan-advanced"
            open={taskDetailsExpanded}
            onToggle={(event) => setTaskDetailsExpanded(event.currentTarget.open)}
          >
            <summary>{t("kanban.taskDetails")}</summary>
            <div className="kan-modal__grid">
            {/* A11Y-UG-FOCUS-AND-ACCESSIBLE-NAME-GAPS-FROM-REVIEWS-20261117:
                the label holds only "Type" and the select, so the combobox's
                accessible name stays "Type". The locked note, the needs-a-
                template note with its button and the conversion panel sit
                beside it, and a note describes the select instead. */}
            <div className="kan-field kan-modal__wide">
              <label className="kan-field">
                <span>{t("kanban.taskType")}</span>
                <select
                  value={task.taskType || "general"}
                  disabled={(task.taskType || "general") !== "general"}
                  aria-describedby={(task.taskType || "general") !== "general"
                    ? `${uid}-template-locked`
                    : templateTypeNoteShown ? `${uid}-type-note` : undefined}
                  onChange={(event) => {
                    // BUG-UG-TASK-TYPE-CHANGE-OPENS-TEMPLATE-CHOOSER-20261111:
                    // picking a type closed this editor and opened the template
                    // chooser for a new task. The database does not convert an
                    // existing task's type, so the editor stays open, the task
                    // stays General, and a template is offered only on request.
                    if (event.target.value === "general") {
                      setTemplateTypeChoice(null);
                      commit({ taskType: "general" });
                    } else setTemplateTypeChoice(event.target.value);
                  }}
                >
                  {TASK_TYPE_IDS.map((type) => <option key={type} value={type}>{t(`tasks.type.${type}`)}</option>)}
                </select>
              </label>
              {(task.taskType || "general") !== "general" && <small id={`${uid}-template-locked`}>{t("taskTemplates.typeLocked")}</small>}
              {templateConversionShown ? (
                <TaskTypeConversionPanel
                  key={templateTypeChoice}
                  template={templates.find((item) => item.key === templateTypeChoice)}
                  templates={templates}
                  // The reviewer field offers staff only, the roster the
                  // converter accepts; the chapter roster includes members.
                  assignees={templateReviewers}
                  lang={lang}
                  t={t}
                  onConvert={async (conversion) => {
                    await onConvertType(conversion);
                    setTemplateTypeChoice(null);
                  }}
                  onCancel={() => setTemplateTypeChoice(null)}
                />
              ) : templateTypeNoteShown && (
                <span className="kan-type-note" role="status">
                  <small id={`${uid}-type-note`}>{t("taskTemplates.typeNeedsTemplate", { type: t(`tasks.type.${templateTypeChoice}`) })}</small>
                  {onUseTemplate && (
                    <button type="button" className="kan-pill task-template-open" onClick={() => onUseTemplate()}>
                      {t("taskTemplates.startFromTemplate")}
                    </button>
                  )}
                </span>
              )}
            </div>
            <div className="kan-field kan-pick" onKeyDown={handlePickKeyDown}>
              <span id={`${uid}-pri`}>{t("kanban.priorityPicker")}</span>
              <button
                type="button"
                className={`kan-modal__pill kan-pri kan-pri--${task.priority}`}
                aria-haspopup="listbox"
                aria-expanded={picker === "priority"}
                aria-controls={`${uid}-priority-popover`}
                aria-labelledby={`${uid}-pri ${uid}-pri-value`}
                onClick={(event) => openPicker("priority", event)}
              >
                <PriorityIcon size={16} aria-hidden="true" />
                <span id={`${uid}-pri-value`}>{priorityLabel}</span>
              </button>
              <RetainedPopover id={`${uid}-priority-popover`} open={picker === "priority"} popoverRef={popoverRef} onExited={finishPickerExit}>
                  <p className="kan-popover__title" id={`${uid}-pri-list`}>{t("kanban.priorityPicker")}</p>
                  <div className="kan-popover__list" role="listbox" aria-labelledby={`${uid}-pri-list`}>
                    {PRIORITY_IDS.map((priority, index) => {
                      const Icon = PRIORITY_ICONS[priority];
                      return (
                        <button
                          key={priority}
                          type="button"
                          className={priority === task.priority ? "kan-popover__opt kan-popover__opt--on" : "kan-popover__opt"}
                          role="option" aria-selected={priority === task.priority}
                          onClick={() => choosePriority(priority)}
                        >
                          <Icon className={`kan-pri kan-pri--${priority}`} size={16} aria-hidden="true" />
                          <span>{t(PRIORITY_LABELS[priority])}</span>
                          <em className="kan-kbd" aria-hidden="true">{index + 1}</em>
                        </button>
                      );
                    })}
                  </div>
              </RetainedPopover>
            </div>

            <div className="kan-field kan-pick" onKeyDown={handlePickKeyDown}>
              <span id={`${uid}-assignee`}>{t("kanban.assigneePicker")}</span>
              <button
                type="button"
                className="kan-modal__pill"
                aria-haspopup="listbox"
                aria-expanded={picker === "assignee"}
                aria-controls={`${uid}-assignee-popover`}
                aria-labelledby={`${uid}-assignee ${uid}-assignee-value`}
                onClick={(event) => openPicker("assignee", event)}
              >
                <span className="kan-assignee-stack" aria-hidden="true">
                  {(selectedAssignees.length ? selectedAssignees : [null]).slice(0, 3).map((person, index) => (
                    <i className="kan-av" key={person?.id || "none"} style={{ zIndex: 3 - index }}>{initialsFor(person)}</i>
                  ))}
                </span>
                <span id={`${uid}-assignee-value`}>
                  {selectedAssignees.length === 0
                    ? t("tasks.unassigned")
                    : selectedAssignees.length === 1
                      ? selectedAssignees[0].fullName
                      : t("kanban.assigneeCount", { count: selectedAssignees.length })}
                </span>
              </button>
              <RetainedPopover id={`${uid}-assignee-popover`} open={picker === "assignee"} popoverRef={popoverRef} onExited={finishPickerExit}>
                  <p className="kan-popover__title" id={`${uid}-assignee-list`}>{t("kanban.assigneePicker")}</p>
                  <input
                    type="search"
                    value={assigneeFilter}
                    onChange={(event) => setAssigneeFilter(event.target.value)}
                    placeholder={t("tasks.assigneeFilter")}
                    aria-label={t("tasks.assigneeFilter")}
                  />
                  <div className="task-assignee-options" role="listbox" aria-multiselectable="true" aria-labelledby={`${uid}-assignee-list`}>
                    <BusyButton type="button" role="option" pending={assigneeBusy} aria-selected={selectedAssigneeIds.length === 0} onClick={() => chooseAssignee("")}>
                      <i aria-hidden="true">—</i>
                      <span>{t("tasks.unassigned")}</span>
                      <em className="kan-kbd" aria-hidden="true">0</em>
                    </BusyButton>
                    {visibleAssignees.map((person) => (
                      <BusyButton
                        key={person.id}
                        type="button"
                        role="option" aria-selected={selectedAssigneeIds.includes(person.id)}
                        pending={assigneeBusy}
                        onClick={() => chooseAssignee(person.id)}
                      >
                        <i aria-hidden="true">{initialsFor(person)}</i>
                        <span>{person.fullName}</span>
                        {selectedAssigneeIds.includes(person.id) && <Check size={15} aria-hidden="true" />}
                      </BusyButton>
                    ))}
                  </div>
              </RetainedPopover>
            </div>

            <label className="kan-field">
              <span>{t("kanban.startDate")}</span>
              <input type="date" value={dates.startDate || ""} onChange={(event) => commitStartDate(event.target.value)} />
            </label>
            <label className="kan-field">
              <span>{t("kanban.dueDate")}</span>
              <input type="date" value={dates.dueDate || ""} onChange={(event) => commitDueDate(event.target.value)} />
            </label>
            {dateError && <p className="tasks-error kan-modal__wide" role="alert">{dateError}</p>}

            <label className="kan-field kan-modal__wide kan-progress-control">
              <span>
                {t("kanban.progress")} · {t("tasks.progressValue", { value: task.status === "done" ? 100 : progress })}
              </span>
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                value={task.status === "done" ? 100 : progress}
                aria-valuetext={t("tasks.progressValue", { value: task.status === "done" ? 100 : progress })}
                disabled={task.status === "done"}
                onChange={(event) => setProgress(Number(event.target.value))}
                onPointerUp={commitProgress}
                onKeyUp={commitProgress}
                onBlur={commitProgress}
              />
            </label>

            <div className="kan-toggles kan-modal__wide">
              <button
                type="button"
                className="kan-toggle-chip"
                aria-pressed={Boolean(task.blocked)}
                onClick={() => commit({ blocked: !task.blocked })}
              >
                <TriangleAlert size={15} aria-hidden="true" /> {t("tasks.blocked")}
              </button>
              <button
                type="button"
                className="kan-toggle-chip"
                aria-pressed={Boolean(task.milestone)}
                onClick={() => commit({ milestone: !task.milestone })}
              >
                <Diamond size={15} aria-hidden="true" /> {t("kanban.milestone")}
              </button>
            </div>
            </div>
            {template && onUpdateTemplateDetails && (
              templateDetails ? (
                <TaskTemplatePanel
                  task={task}
                  template={template}
                  details={templateDetails}
                  assignees={templateReviewers}
                  lang={lang}
                  t={t}
                  onUpdate={onUpdateTemplateDetails}
                />
              ) : <p className="task-template-panel task-template-panel--unavailable" role="status">{t("taskTemplates.detailsUnavailable")}</p>
            )}
          </details>
        </article>

        <article className="kan-modal__card task-description-card">
          <header className="kan-modal__head">
            <h3 className="kan-disclosure-heading">
              <button
                type="button"
                className="kan-disclosure"
                aria-expanded={descriptionExpanded}
                aria-controls={`${uid}-description-panel`}
                onClick={() => {
                  // Collapsing unmounts a focused textarea WITHOUT a blur
                  // event — commit the draft first or it is silently lost.
                  if (descriptionExpanded && editingDescription) commitDescription();
                  setDescriptionExpanded((current) => !current);
                }}
              >
                <span>{t("kanban.description")}</span>
                {checklist.total > 0 && (
                  <span className="kan-check">{t("kanban.checklistCount", { done: checklist.done, total: checklist.total })}</span>
                )}
                <ChevronDown className="kan-disclosure__icon" size={16} aria-hidden="true" />
              </button>
            </h3>
            <button
              type="button"
              className="kan-modal__edit"
              aria-pressed={editingDescription}
              aria-label={t("kanban.editDescription")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setDescriptionExpanded(true);
                if (editingDescription) commitDescription();
                else setEditingDescription(true);
              }}
            >
              <Pencil size={16} />
            </button>
          </header>
          <DisclosurePanel id={`${uid}-description-panel`} open={descriptionExpanded}>
            {editingDescription ? (
              <>
                <label className="kan-desc">
                  <span className="visually-hidden">{t("kanban.description")}</span>
                  <textarea className="task-owned"
                    autoFocus={!EMBEDDED_COMPANION}
                    value={descriptionDraft}
                    maxLength={2000}
                    placeholder={t("kanban.descriptionPlaceholder")}
                    onChange={(event) => {
                      rememberDraft("description", event.target.value);
                      setDescriptionDraft(event.target.value);
                    }}
                    onBlur={commitDescription}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                        event.preventDefault();
                        commitDescription();
                      }
                    }}
                  />
                </label>
                <p className="kan-hint">{t("kanban.checklistHint")}</p>
              </>
            ) : (
              <div className="kan-desc">
                {descriptionLines.map((line, index) => {
                  const item = checklistByLine.get(index);
                  if (item) {
                    return (
                      <div className="kan-checkrow" key={`line-${index}`}>
                        <button
                          type="button"
                          className="kan-checkrow__box"
                          aria-pressed={item.checked}
                          aria-label={t("kanban.checkItem", { text: item.text })}
                          onClick={() => toggleChecklist(item.index)}
                        >
                          {item.checked && <Check size={14} aria-hidden="true" />}
                        </button>
                        <span className={item.checked ? "kan-checkrow__text kan-checkrow__text--done" : "kan-checkrow__text"}>
                          {item.text}
                        </span>
                      </div>
                    );
                  }
                  if (!line.trim()) return null;
                  return <p className="task-owned" key={`line-${index}`}>{line}</p>;
                })}
                {/* An icon-only pencil was the sole entry point on an empty
                    card — no visible call to action. This names the action. */}
                {!(task.description || "").trim() && (
                  <button
                    type="button"
                    className="kan-desc__addbtn"
                    onClick={() => { setDescriptionExpanded(true); setEditingDescription(true); }}
                  >
                    <Plus size={15} aria-hidden="true" /> {t("kanban.addDescription")}
                  </button>
                )}
              </div>
            )}
          </DisclosurePanel>
        </article>

        <article className="kan-modal__card kan-deps">
          <header className="kan-modal__head">
            <h3 className="kan-disclosure-heading">
              <button
                type="button"
                className="kan-disclosure"
                aria-expanded={dependenciesExpanded}
                aria-controls={`${uid}-dependencies-panel`}
                onClick={() => setDependenciesExpanded((current) => !current)}
              >
                <span>{t("kanban.dependencies")}</span>
                {depTotal > 0 && <span className="kan-deps__count" aria-hidden="true">{depTotal}</span>}
                <ChevronDown className="kan-disclosure__icon" size={16} aria-hidden="true" />
              </button>
            </h3>
            {onAddDependency && (
              <div className="kan-pick kan-pick--end" onKeyDown={handlePickKeyDown}>
                <button
                  type="button"
                  className="kan-modal__edit"
                  aria-expanded={picker === "deps"}
                  aria-controls={`${uid}-deps-popover`}
                  aria-label={t("kanban.addDependency")}
                  onClick={(event) => {
                    setDependenciesExpanded(true);
                    openPicker("deps", event);
                  }}
                >
                  <Plus size={16} />
                </button>
                <RetainedPopover id={`${uid}-deps-popover`} open={picker === "deps"} popoverRef={popoverRef} onExited={finishPickerExit} className="kan-popover--deps">
                    <p className="kan-popover__title" id={`${uid}-dep-list`}>{t("kanban.addDependency")}</p>
                    <input
                      type="search"
                      value={depFilter}
                      onChange={(event) => setDepFilter(event.target.value)}
                      placeholder={t("kanban.dependencyFilter")}
                      aria-label={t("kanban.dependencyFilter")}
                    />
                    <div className="kan-popover__list" role="listbox" aria-labelledby={`${uid}-dep-list`}>
                      {depCandidates.length === 0 && <p className="kan-deps__none">{t("kanban.noDependencyCandidates")}</p>}
                      {depCandidates.map((candidate) => (
                        <BusyButton
                          key={candidate.id}
                          type="button"
                          className="kan-popover__opt"
                          role="option" aria-selected={false}
                          pending={depBusy}
                          onClick={() => addDependency(candidate.id)}
                        >
                          <i className={`kan-dot kan-dot--${candidate.status}`} aria-hidden="true" />
                          <span className="kan-card__key">{taskKey(candidate, chapterId) || ""}</span>
                          <span className="kan-deps__cand">{candidate.title}</span>
                        </BusyButton>
                      ))}
                    </div>
                </RetainedPopover>
              </div>
            )}
          </header>
          <DisclosurePanel id={`${uid}-dependencies-panel`} open={dependenciesExpanded}>
          {depError && <p className="tasks-error" role="alert">{depError}</p>}
          {depTotal === 0 ? (
            <p className="kan-deps__none">{t("kanban.noDependencies")}</p>
          ) : (
            <>
              {depLists.dependsOn.length > 0 && (
                <div className="kan-deps__group">
                  <h4>{t("kanban.dependsOn")}</h4>
                  {depLists.dependsOn.map((edge) => (
                    <DepRow
                      key={edge.id}
                      edge={edge}
                      other={taskById.get(edge.dependsOnId)}
                      chapterId={chapterId}
                      t={t}
                      dueFormat={dueFormat}
                      onOpen={onOpenTask}
                      onRemove={onRemoveDependency ? removeDependency : null}
                    />
                  ))}
                </div>
              )}
              {depLists.blocking.length > 0 && (
                <div className="kan-deps__group">
                  <h4>{t("kanban.blocking")}</h4>
                  {depLists.blocking.map((edge) => (
                    <DepRow
                      key={edge.id}
                      edge={edge}
                      other={taskById.get(edge.taskId)}
                      chapterId={chapterId}
                      t={t}
                      dueFormat={dueFormat}
                      onOpen={onOpenTask}
                      onRemove={onRemoveDependency ? removeDependency : null}
                    />
                  ))}
                </div>
              )}
            </>
          )}
          </DisclosurePanel>
        </article>
        {checkoffClient ? <TaskCheckoffPanel client={checkoffClient} taskId={task.id} memberId={memberId} /> : null}
        <article className="kan-modal__card kan-subtasks">
          <header className="kan-modal__head">
            <h3 className="kan-disclosure-heading">
              <button
                type="button"
                className="kan-disclosure"
                aria-expanded={subtasksExpanded}
                aria-controls={`${uid}-subtasks-panel`}
                onClick={() => setSubtasksExpanded((current) => !current)}
              >
                <span>{t("kanban.subtasks")}</span>
                {childEdges.length > 0 && <span className="kan-deps__count" aria-hidden="true">{childEdges.length}</span>}
                <ChevronDown className="kan-disclosure__icon" size={16} aria-hidden="true" />
              </button>
            </h3>
          </header>
          <DisclosurePanel id={`${uid}-subtasks-panel`} open={subtasksExpanded}>
          <p className="kan-subtasks__hint">{t("kanban.subtasksHint")}</p>
          {onCreateSubtask && (
            <form className="kan-subtasks__composer" onSubmit={submitSubtask}>
              <label>
                <span className="visually-hidden">{t("kanban.addSubtask")}</span>
                <input className="task-owned"
                  value={subtaskTitle}
                  onChange={(event) => setSubtaskTitle(limitTaskTitle(event.target.value, subtaskTitle))}
                  placeholder={t("kanban.addSubtask")}
                />
              </label>
              <BusyButton className="task-owned" type="submit" pending={subtaskBusy} disabled={!subtaskTitle.trim()}>
                <Plus size={15} aria-hidden="true" /> {t("tasks.add")}
              </BusyButton>
            </form>
          )}
          {subtaskError && <p className="tasks-error" role="alert">{subtaskError}</p>}
          {parentEdge && taskById.get(parentEdge.parentTaskId) && (
            <button type="button" className="kan-subtasks__parent" onClick={() => onOpenTask?.(taskById.get(parentEdge.parentTaskId))}>
              {t("kanban.parentTask")}: <span className="kan-card__key">{taskKey(taskById.get(parentEdge.parentTaskId), chapterId) || ""}</span> {taskById.get(parentEdge.parentTaskId).title}
            </button>
          )}
          {childEdges.length === 0 ? (
            <p className="kan-deps__none">{t("kanban.noSubtasks")}</p>
          ) : (
            <ul className="kan-subtasks__list">
              {childEdges.map((edge) => {
                const child = taskById.get(edge.subtaskId);
                if (!child) return null;
                return (
                  <li className="task-owned" key={edge.id}>
                    <button
                      type="button"
                      className={child.status === "done" ? "kan-subtasks__toggle is-done" : "kan-subtasks__toggle"}
                      aria-label={child.status === "done" ? t("kanban.reopenSubtask") : t("kanban.completeSubtask")}
                      onClick={() => toggleSubtask(child)}
                    >
                      {child.status === "done" && <Check size={14} aria-hidden="true" />}
                    </button>
                    <button type="button" className="kan-subtasks__open" onClick={() => onOpenTask?.(child)}>
                      <span className="kan-card__key">{taskKey(child, chapterId) || ""}</span>
                      <span>{child.title}</span>
                    </button>
                    {onRemoveSubtask && (
                      <button type="button" className="kan-subtasks__remove" aria-label={t("kanban.removeSubtask")} onClick={() => removeSubtask(edge)}>
                        <X size={15} aria-hidden="true" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          </DisclosurePanel>
        </article>
        <article className="kan-modal__card task-documents-card">
          <header className="kan-modal__head">
            <h3 className="kan-disclosure-heading">
              <button
                type="button"
                className="kan-disclosure"
                aria-expanded={documentsExpanded}
                aria-controls={`${uid}-documents-panel`}
                onClick={() => setDocumentsExpanded((current) => !current)}
              >
                <span>{t("kanban.authorizedRecords")}</span>
                {attachments.length > 0 && <span className="kan-deps__count" aria-hidden="true">{attachments.length}</span>}
                <ChevronDown className="kan-disclosure__icon" size={16} aria-hidden="true" />
              </button>
            </h3>
          </header>
          <DisclosurePanel id={`${uid}-documents-panel`} open={documentsExpanded}>
          <p className="kan-records__hint">{t("kanban.authorizedRecordsHint")}</p>
          {onAddAttachment && documents.length > 0 && (
            <div className="kan-document-picker">
              <label className="task-owned">
                <span>{t("kanban.chooseDocument")}</span>
                <select className="task-owned" value={documentId} onChange={(event) => setDocumentId(event.target.value)}>
                  <option value="">{t("kanban.chooseDocumentPlaceholder")}</option>
                  {documents.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}
                </select>
              </label>
              <BusyButton className="task-owned" type="button" pending={recordBusy} disabled={!documentId} onClick={attachSelectedDocument}>
                <Paperclip size={15} aria-hidden="true" /> {t("kanban.attachDocument")}
              </BusyButton>
            </div>
          )}
          {attachments.length === 0 ? <p className="kan-deps__none">{t("kanban.noAuthorizedRecords")}</p> : (
            <ul className="kan-records__list">
              {attachments.map((attachment) => (
                <li className="task-owned" key={attachment.id}>
                  <a className="task-owned" href={attachment.recordUrl} onClick={attachment.sourceKind && onOpenSourceRecord ? (event) => { event.preventDefault(); onOpenSourceRecord(attachment); } : undefined}><Link2 size={14} aria-hidden="true" />{attachment.label}</a>
                  {onRemoveAttachment && (
                    <button className="task-owned" type="button" onClick={() => removeAuthorizedRecord(attachment.id)} aria-label={t("kanban.removeAuthorizedRecord", { label: attachment.label })}>
                      <X size={14} aria-hidden="true" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {onAddAttachment && (
            <details className="kan-records__add">
              <summary>{t("kanban.addAuthorizedRecord")}</summary>
              <form className="task-owned" onSubmit={submitAuthorizedRecord}>
                <label className="task-owned"><span>{t("kanban.recordLabel")}</span><input className="task-owned" value={recordLabel} maxLength={120} onChange={(event) => setRecordLabel(event.target.value)} required /></label>
                <label className="task-owned"><span>{t("kanban.recordPath")}</span><input className="task-owned" value={recordUrl} maxLength={500} placeholder="/m/..." onChange={(event) => setRecordUrl(event.target.value)} required /></label>
                <BusyButton className="task-owned" type="submit" pending={recordBusy} disabled={!recordLabel.trim() || !recordUrl.trim()}>{t("tasks.add")}</BusyButton>
              </form>
            </details>
          )}
          {recordError && <p className="tasks-error" role="alert">{recordError}</p>}
          <div className="kan-files">
            <p className="kan-records__hint">{t("kanban.deviceFilesHint")}</p>
            {files.length === 0 ? <p className="kan-deps__none">{t("kanban.noDeviceFiles")}</p> : (
              <ul className="kan-records__list kan-files__list">
                {files.map((file) => (
                  <li className="task-owned" key={file.id}>
                    <button type="button" className="kan-files__open task-owned" onClick={() => openDeviceFile(file)}>
                      <Paperclip size={14} aria-hidden="true" />
                      <span className="kan-files__name">{file.filename}</span>
                      <small className="kan-files__size">{formatFileSize(file.sizeBytes)}</small>
                    </button>
                    {staleFileId === file.id && onRecheckFile && (
                      <BusyButton className="task-owned" type="button" pending={fileBusy} aria-label={`${fileBusy ? t("uploads.rechecking") : t("uploads.recheck")}: ${file.filename}`} onClick={() => recheckDeviceFile(file)}>
                        {fileBusy ? t("uploads.rechecking") : t("uploads.recheck")}
                      </BusyButton>
                    )}
                    {onRemoveFile && (
                      <BusyButton className="task-owned" type="button" pending={fileBusy} onClick={() => removeDeviceFile(file)} aria-label={t("kanban.removeDeviceFile", { name: file.filename })}>
                        <X size={14} aria-hidden="true" />
                      </BusyButton>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {onAddFile && (
              <EvidenceUpload
                scopeKey={task.id}
                label={t("kanban.attachDeviceFile")}
                disabled={fileBusy}
                onBusyChange={setFileBusy}
                onUpload={attachDeviceFile}
              />
            )}
            {filePhase === "checking" && <p className="case-files__checking" role="status" aria-live="polite">{t("uploads.checking")}</p>}
            {fileError && <p className="tasks-error" role="alert">{fileError}</p>}
          </div>
          </DisclosurePanel>
        </article>

        <article className="kan-modal__card">
          <header className="kan-modal__head">
            <h3 className="kan-disclosure-heading">
              <button
                type="button"
                className="kan-disclosure"
                aria-expanded={commentsExpanded}
                aria-controls={`${uid}-comments-panel`}
                onClick={() => setCommentsExpanded((current) => !current)}
              >
                <span>{t("kanban.comments")}</span>
                {thread.length > 0 && <span className="kan-deps__count" aria-hidden="true">{thread.length}</span>}
                <ChevronDown className="kan-disclosure__icon" size={16} aria-hidden="true" />
              </button>
            </h3>
          </header>
          <DisclosurePanel id={`${uid}-comments-panel`} open={commentsExpanded}>
          <p className="kan-records__hint">{t("kanban.commentsHint")}</p>
          {commentsUnavailable && <p className="tasks-error" role="alert">{t("tasks.commentUnavailable")}</p>}
          {commentsTruncated && <p className="kan-records__hint" role="status">{t("tasks.commentTruncated")}</p>}
          <div className="task-message-thread" aria-live="polite" aria-label={t("kanban.comments")}>
            {thread.length === 0 && !commentsUnavailable && (
              <p className="task-message-thread__empty">
                {commentsTruncated ? t("tasks.commentEmptyTruncated") : t("tasks.commentEmpty")}
              </p>
            )}
            {thread.map((comment) => {
              const mine = comment.authorId === memberId;
              const author = assignees.find((person) => person.id === comment.authorId);
              return (
                <article key={comment.id} className={mine ? "task-message task-message--mine" : "task-message"}>
                  <strong>{mine ? t("tasks.you") : author?.fullName || t("tasks.chapterMember")}</strong>
                  <p>{comment.body}</p>
                  <time dateTime={comment.createdAt}>{stampFormat.format(new Date(comment.createdAt))}</time>
                </article>
              );
            })}
          </div>
          {onAddComment && (
            <form className="task-message-composer" onSubmit={submitComment}>
              <label>
                <span className="visually-hidden">{t("tasks.commentPlaceholder")}</span>
                <BusyTextarea value={body} onChange={(event) => { setBody(event.target.value); setError(""); }} placeholder={t("tasks.commentPlaceholder")} maxLength={2000} pending={busy} required />
              </label>
              <div className="kan-comment-mentions" aria-label={t("kanban.notifyMentions")}>
                <span>{t("kanban.notifyMentions")}</span>
                {mentionRecipients.map((person) => (
                  <button className="task-owned" key={person.id} type="button" aria-pressed={mentionIds.includes(person.id)} onClick={() => toggleMention(person.id)}>@{person.label}</button>
                ))}
              </div>
              <div>
                <small>{body.length}/2000</small>
                <BusyButton type="submit" pending={busy} disabled={!body.trim()}><Send size={16} /> {busy ? t("tasks.sendingComment") : t("tasks.addComment")}</BusyButton>
              </div>
              {error && <p className="tasks-error" role="alert">{error}</p>}
            </form>
          )}
          </DisclosurePanel>
        </article>
        </div>
      </section>
    </div>
  );
}

// One dependency row, status-tinted like the board card it stands for. The
// whole row body is the open-that-task button (t0ggles' mini-cards navigate);
// the remove ✕ sits beside it, never inside it. `other` is the edge's far
// endpoint — already guaranteed loaded by the parent's resolvable-edge filter,
// but a null still renders nothing rather than a keyless husk.
function DepRow({ edge, other, chapterId, t, dueFormat, onOpen, onRemove }) {
  if (!other) return null;
  const key = taskKey(other, chapterId);
  const due = other.dueDate ? dueFormat.format(new Date(`${other.dueDate}T12:00:00`)) : null;
  return (
    <div className={`kan-deprow kan-deprow--${other.status}`}>
      <button
        type="button"
        className="kan-deprow__open"
        disabled={!onOpen || undefined}
        onClick={onOpen ? () => onOpen(other) : undefined}
      >
        <span className="kan-card__key">{key || ""}</span>
        <span className="kan-deprow__title">{other.title}</span>
        <span className="visually-hidden">{t(`tasks.status.${other.status}`)}</span>
        {due && <span className="kan-deprow__due">{due}</span>}
      </button>
      {onRemove && (
        <button
          type="button"
          className="kan-deprow__x"
          aria-label={t("kanban.removeDependency", { key: key || other.title })}
          onClick={() => onRemove(edge)}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
