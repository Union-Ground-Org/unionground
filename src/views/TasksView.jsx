import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BusyButton } from "../components/BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import {
  CalendarDays,
  ChartNoAxesGantt,
  ChartPie,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  List,
  Columns3,
  Columns3Cog,
  Flag,
  Funnel,
  Keyboard,
  LayoutTemplate,
  NotebookPen,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { rpcRefusalKey } from "../lib/rpcErrorText.js";
import { characterShortcutStorageKey, readCharacterShortcuts, writeCharacterShortcuts } from "../lib/taskCharacterShortcuts.js";
import { useKeyboardShortcutsEnabled } from "../lib/keyboardShortcuts.js";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { RoutedTabLink, useRoutedTab, useWorkspace } from "../components/WorkspacePages.jsx";
import { localTaskRowWins, mergeExistingRows } from "../lib/boardSync.js";
import {
  DESKTOP_TASK_VIEW_SHORTCUTS,
  isSharedTaskView,
  normalizeSharedTaskView,
  SHARED_TASK_VIEW_SHORTCUTS,
  taskViewIdsFor,
} from "../lib/taskViews.js";
import { PlaneHeader } from "../components/PlaneHeader.jsx";
import { Switch } from "../components/Surfaces.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { localeFor } from "../lib/i18n.js";
import {
  ORDER_MAX,
  STATUS_IDS,
  byBoardOrder,
  matchesTaskKey,
  orderBetween,
  statusCycle,
  taskKey,
} from "../lib/kanban.js";
import { STAFF_TOOL_ROLES } from "../lib/staffPlanes.js";
import { useModalIsolation } from "../lib/useModalIsolation.js";
import { registerEscapeLayer } from "../lib/escapeLayers.js";
import { DETAIL_SURFACE_EXIT_MS } from "../lib/useDetailSurface.js";
import { returnFocusAfterModal, useModalExit, useRetainedTransition, useTransitionPresence } from "../lib/useTransitionPresence.js";
import {
  addLocalDays as addDays,
  daysBetweenLocalDates as daysBetween,
  localDateKey as isoDate,
  parseLocalDateKey as localDate,
  taskDateSpan,
} from "../lib/taskSchedule.js";
import { KanbanBoard } from "./KanbanBoard.jsx";
import { KanbanList } from "./KanbanList.jsx";
import { KanbanCalendar } from "./KanbanCalendar.jsx";
import { TaskModal } from "./TaskModal.jsx";
import { TaskDeadlinesView } from "./TaskDeadlinesView.jsx";
import { TaskDesktopTimeline } from "./TaskDesktopTimeline.jsx";
import { TaskFieldNotesView } from "./TaskFieldNotesView.jsx";

const TITLED_VIEWS = new Set(["deadlines", "field_notes"]);
import { TaskTemplateDialog } from "./TaskTemplateDialog.jsx";
import { TasksReport } from "./TasksReport.jsx";
import { WorkstreamSettings } from "./WorkstreamSettings.jsx";

const SCOPE_IDS = ["mine", "all", "owned", "assigned"];
const PRIORITY_IDS = ["all", "high", "medium", "low"];
const DESKTOP_WORK_VIEW_MIN_PX = 44;
const DESKTOP_WORK_VIEW_MAX_PX = 156;
const DESKTOP_WORK_VIEW_RESERVE_PX = 88;

export function desktopWorkViewWidth(contentWidth) {
  const width = Number(contentWidth);
  if (!Number.isFinite(width)) return DESKTOP_WORK_VIEW_MIN_PX;
  return Math.min(
    DESKTOP_WORK_VIEW_MAX_PX,
    Math.max(DESKTOP_WORK_VIEW_MIN_PX, (Math.max(0, width) - DESKTOP_WORK_VIEW_RESERVE_PX) / 8),
  );
}

export function desktopWorkViewLabelsFit(measurements, expectedCount) {
  if (!Number.isInteger(expectedCount)
    || expectedCount <= 0
    || !Array.isArray(measurements)
    || measurements.length !== expectedCount) return false;
  return measurements.every((measurement) => {
    if (!measurement || typeof measurement !== "object") return false;
    const { allocatedWidth, labelWidth, chromeWidth } = measurement;
    const allocated = Number(allocatedWidth);
    const label = Number(labelWidth);
    const chrome = Number(chromeWidth);
    return Number.isFinite(allocated)
      && allocated > 0
      && Number.isFinite(label)
      && label > 0
      && Number.isFinite(chrome)
      && chrome >= 0
      && label + chrome <= allocated;
  });
}

// The t0ggles top bar names its views with line icons, not the old emoji
// glyphs: every pill still carries its translated name (visible when wide,
// aria-label always), so the icon itself stays decorative.
const VIEW_ICONS = {
  board: Columns3,
  calendar: CalendarDays,
  list: List,
  timeline: ChartNoAxesGantt,
  progress: ChartPie,
  report: ClipboardList,
  deadlines: Flag,
  field_notes: NotebookPen,
};

// Ctrl+Shift+letter view switching. No G — the Timeline is Union Ground-native, not
// t0ggles' Gantt, and the owner explicitly omitted Gantt from this program.
const VIEW_SHORTCUTS = SHARED_TASK_VIEW_SHORTCUTS;
const DESKTOP_VIEW_SHORTCUTS = DESKTOP_TASK_VIEW_SHORTCUTS;
const DESKTOP_VIEW_HELP_KEYS = ["B", "L", "T", "C", "D", "F", "P", "R"];

function isTaskOverdue(task, today = isoDate(new Date())) {
  return task.status !== "done" && Boolean(task.dueDate) && task.dueDate < today;
}

function formatShortDate(value, lang) {
  return new Intl.DateTimeFormat(localeFor(lang), { month: "short", day: "numeric" }).format(localDate(value));
}

function average(values) {
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function taskMessagesForMember(taskId, memberId, messages) {
  return messages.filter((message) =>
    message.taskId === taskId
    && [message.senderId, message.recipientId].includes(memberId));
}

function taskAssigneeIds(task) {
  return Array.isArray(task.assigneeIds) && task.assigneeIds.length
    ? task.assigneeIds
    : task.assigneeId ? [task.assigneeId] : [];
}

function assigneesFor(task, unassigned) {
  const ids = Array.isArray(task.assigneeIds) && task.assigneeIds.length
    ? task.assigneeIds.filter(Boolean)
    : (task.assigneeId ? [task.assigneeId] : []);
  const names = Array.isArray(task.assigneeNames) && task.assigneeNames.length
    ? task.assigneeNames
    : (task.assigneeName ? [task.assigneeName] : []);
  const count = Math.max(ids.length, names.length);
  if (count === 0) return [{ id: null, name: unassigned }];
  return Array.from({ length: count }, (_, index) => {
    const id = ids[index] || null;
    const raw = names[index];
    let name = unassigned;
    if (typeof raw === "string" && raw.trim()) name = raw.trim();
    else if (id && id === task.assigneeId && typeof task.assigneeName === "string" && task.assigneeName.trim()) {
      name = task.assigneeName.trim();
    }
    return { id: id || `name:${name}`, name };
  });
}

function taskInScope(task, scope, memberId) {
  if (scope === "all") return true;
  if (scope === "owned") return task.createdBy === memberId;
  if (scope === "assigned") return taskAssigneeIds(task).includes(memberId);
  return task.createdBy === memberId || taskAssigneeIds(task).includes(memberId);
}

function initialsOf(person) {
  return person.initials || person.fullName.slice(0, 2).toUpperCase();
}

function focusCandidate(element) {
  return element?.isConnected
    && !element.disabled
    && element.getAttribute?.("aria-disabled") !== "true"
    && !element.closest?.('[data-state="closing"]');
}

const FOCUS_RESTORE_TIMEOUT_MS = 350;

function focusClock() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function restoreFocusWhenInteractive(element, fallback = null, deadline = focusClock() + FOCUS_RESTORE_TIMEOUT_MS) {
  const schedule = typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame.bind(window)
    : (callback) => window.setTimeout(callback, 0);
  schedule(() => {
    const active = document.activeElement;
    if (active
        && active !== document.body
        && active !== document.documentElement
        && !active.closest("[inert]")
        && !active.closest('[data-state="closing"]')) return;
    const target = focusCandidate(element) ? element : fallback?.();
    if (target?.isConnected
        && !target.closest("[inert]")
        && !target.closest('[data-state="closing"]')) {
      target.focus();
      return;
    }
    if (focusClock() < deadline) restoreFocusWhenInteractive(element, fallback, deadline);
  });
}

// Anchored popover shell shared by Filter / View settings / member overflow.
// The outside-click test walks up to the WRAPPER (trigger + panel live in one
// .kan-pick): closing on a mousedown that lands on the trigger would race
// the trigger's own toggle click and reopen the panel it just closed.
// Escape is owned here only when another surface has not already handled it.
// Prevent default so the window keyboard map never also exits focus mode.
//
// The panel is position: FIXED, measured from its trigger wrapper: the topbar
// is a horizontal scroller (overflow-x: auto, deliberately — wrapping would
// move the board under a mid-drag pointer), and an absolutely positioned
// panel inside a scroll container is clipped to the bar's own ~60px height.
// Fixed escapes the clip on desktop AND on a phone whose scrolled strip has
// carried the trigger anywhere. A scroll while open — the bar's own or the
// page's, but never the panel's internal list — closes instead of chasing
// the anchor.
function Popover({ open, label, onClose, className = "", children }) {
  const ref = useRef(null);
  const openerRef = useRef(null);
  const [pos, setPos] = useState(null);
  const presence = useTransitionPresence(open, {
    exitMs: 200,
    onExited: () => {
      const active = document.activeElement;
      const focusWasLost = active === document.body || active === document.documentElement;
      if (focusWasLost || ref.current?.contains(active)) openerRef.current?.focus?.();
    },
  });

  useLayoutEffect(() => {
    const anchor = ref.current?.parentElement;
    if (!anchor) return;
    openerRef.current = anchor.querySelector(":scope > button");
    const rect = anchor.getBoundingClientRect();
    setPos({
      top: rect.bottom + 6,
      right: Math.max(12, window.innerWidth - rect.right),
      origin: rect.left + (rect.width / 2) < window.innerWidth / 2 ? "top left" : "top right",
    });
  }, [presence.mounted, open]);

  useLayoutEffect(() => {
    if (!open && ref.current?.contains(document.activeElement)) openerRef.current?.focus?.();
  }, [open]);

  useLayoutEffect(() => {
    // Arm dismissal after the two-frame mount commit. Browser automation and
    // narrow horizontal toolbars may scroll the trigger into view as part of
    // the activating click; treating that positioning scroll as an outside
    // dismissal makes the first click appear to do nothing.
    // Install in the open commit, before that DOM state can receive input;
    // a passive effect leaves a painted open panel without an Escape owner.
    if (!open || presence.phase !== "open") return undefined;
    function onDown(event) {
      const box = ref.current?.parentElement || ref.current;
      if (box && !box.contains(event.target)) onClose();
    }
    function onKey(event) {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    function onScroll(event) {
      if (ref.current && event.target instanceof Node && ref.current.contains(event.target)) return;
      onClose();
    }
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, open, presence.phase]);

  if (!presence.mounted) return null;
  return (
    <div
      ref={ref}
      className={className ? `kan-popover ${className}` : "kan-popover"}
      style={pos ? {
        position: "fixed",
        top: pos.top,
        right: pos.right,
        left: "auto",
        transformOrigin: pos.origin,
      } : undefined}
      role="group"
      aria-label={label}
      aria-hidden={presence.closing || undefined}
      data-state={presence.phase}
      inert={presence.closing ? true : undefined}
      onTransitionEnd={presence.onTransitionEnd}
    >
      <p className="kan-popover__title" aria-hidden="true">{label}</p>
      {children}
    </div>
  );
}


export function TasksView({
  data,
  unitSettingsApi = null,
  // The alternate shell's Work page draws its own find box in the work bar
  // and hides this tool's; it passes this so "/" focuses that box instead.
  onFocusSearch = null,
  renderAutomationLink = null,
  renderConnectedActions = null,
  renderConnectedMessageActions = null,
  onOpenSourceRecord = null,
  onCreateTask,
  onUpdateTask,
  onSetTaskAssignees = null,
  onMoveTask = null,
  onDeleteTask,
  onSendTaskMessage,
  onAddTaskComment = null,
  onAddTaskAttachment = null,
  onAddTaskFile = null,
  onRemoveTaskFile = null,
  onOpenTaskFile = null,
  onRecheckTaskFile = null,
  onRemoveTaskAttachment = null,
  onAddTaskDependency = null,
  onRemoveTaskDependency = null,
  onLoadReport = null,
  onAddWorkstream = null,
  onEnsureDefaultWorkstream = null,
  onCreateTaskSubtask = null,
  onRemoveTaskSubtask = null,
  onWatchTask = null,
  onUnwatchTask = null,
  onRenameWorkstream = null,
  onPreviewMergeWorkstreams = null,
  onMergeWorkstreams = null,
  onCreateTaskFromTemplate = null,
  onUpdateTaskTemplateDetails = null,
  onConvertTaskToTemplate = null,
  staffAccess = null,
  fieldNotesPacket = null,
  desktopShell = false,
  demo = false,
  checkoffClient = null,
}) {
  const { lang, t } = useLang();
  const [tasks, setTasks] = useState(data.tasks || []);
  const [taskMessages, setTaskMessages] = useState(data.taskMessages || []);
  const [sharedView, setSharedView] = useDeviceParityState("tasks.view", "board");
  const [sharedFocusedView, setSharedFocusedView] = useDeviceParityState("tasks.focusedView", "board");
  const normalizedSharedView = normalizeSharedTaskView(sharedView);
  const normalizedSharedFocus = normalizeSharedTaskView(sharedFocusedView);
  const [desktopView, setDesktopView] = useState(() => normalizedSharedView);
  const [desktopFocusedView, setDesktopFocusedView] = useState(() => normalizedSharedFocus);
  const lastSharedViewRef = useRef(sharedView);
  const lastSharedFocusRef = useRef(sharedFocusedView);
  const workspace = useWorkspace();
  const [routedView, setRoutedView] = useRoutedTab("tasks", desktopShell ? desktopView : normalizedSharedView);
  // The responsive web routes expose the same destinations. The standalone
  // companion retains its six-view preference contract.
  const viewIds = taskViewIdsFor(desktopShell || Boolean(workspace));
  const view = workspace ? routedView : desktopShell ? desktopView : normalizedSharedView;
  const focusedView = desktopShell ? desktopFocusedView : normalizedSharedFocus;
  useEffect(() => {
    if (!workspace) return;
    setDesktopFocusedView(view);
    if (isSharedTaskView(view)) setSharedFocusedView(view);
  }, [workspace, view, setSharedFocusedView]);
  // The Green desktop List and Timeline each own their honest empty state.
  // Non-desktop keeps the shared Purple guard and its existing copy/action.
  const desktopViewOwnsEmptyState = desktopShell && (view === "list" || view === "timeline");
  const [scope, setScope] = useDeviceParityState("tasks.scope", "mine");
  const [search, setSearch] = useDeviceParityState("tasks.search", "");
  const [priority, setPriority] = useDeviceParityState("tasks.priority", "all");
  const [workstream, setWorkstream] = useDeviceParityState("tasks.workstream", "all");
  const [assigneeFilter, setAssigneeFilter] = useDeviceParityState("tasks.assigneeFilter", null);
  const [doneVisible, setDoneVisible] = useDeviceParityState("tasks.doneVisible", true);
  const [focusWorkstream, setFocusWorkstream] = useDeviceParityState("tasks.focusWorkstream", null);
  const [openTaskId, setOpenTaskId] = useDeviceParityState("tasks.openTaskId", null);
  const [assignFocus, setAssignFocus] = useDeviceParityState("tasks.assignFocus", false);
  const [popover, setPopover] = useDeviceParityState("tasks.popover", null); // "filter" | "settings" | "members"
  const [shortcutsOpen, setShortcutsOpen] = useDeviceParityState("tasks.shortcutsOpen", false);
  const shortcutsOpenerRef = useRef(null);
  const settingsTriggerRef = useRef(null);
  // WCAG 2.1.4: the bare /, ? and c keys are an opt-in, per member and per
  // device (src/lib/taskCharacterShortcuts.js). A fixture visitor's choice
  // lives in session storage under a demo key, never under the shared fixture
  // member's persistent one; a refused write is remembered for this page load.
  const characterShortcutKey = characterShortcutStorageKey(data.member?.id, demo);
  const [characterShortcutPreference, setCharacterShortcutPreference] = useState(() => ({
    key: characterShortcutKey, enabled: readCharacterShortcuts(characterShortcutKey, demo),
  }));
  // A different member reads their own stored choice, never the previous
  // member's in-memory one.
  const characterShortcutsEnabled = characterShortcutPreference.key === characterShortcutKey
    ? characterShortcutPreference.enabled : readCharacterShortcuts(characterShortcutKey, demo);
  function setCharacterShortcuts(enabled) {
    setCharacterShortcutPreference({ key: characterShortcutKey, enabled });
    writeCharacterShortcuts(characterShortcutKey, demo, enabled);
  }
  // REQ-UG-KEYBOARD-SHORTCUTS-OFF-BY-DEFAULT-20261103: the member's
  // Keyboard shortcuts choice in Settings (src/lib/keyboardShortcuts.js) is
  // the one switch above this board's. While it is off no board chord or
  // character key fires and the board choice cannot be changed; while it is
  // on, the character keys still also need the board choice.
  const keyboardShortcutsOn = useKeyboardShortcutsEnabled();
  const characterKeysActive = keyboardShortcutsOn && characterShortcutsEnabled;
  function openShortcuts(opener = document.activeElement) {
    shortcutsOpenerRef.current = opener;
    setPopover(null);
    setShortcutsOpen(true);
  }
  const [error, setError] = useState("");
  const [liveMessage, setLiveMessage] = useState("");
  const [doneToast, setDoneToast] = useState(null);
  const [confirmTask, setConfirmTask] = useDeviceParityState("tasks.confirmTask", null);
  const [pendingDeleteTask, setPendingDeleteTask] = useDeviceParityState("tasks.pendingDeleteTask", null);
  const [workstreamsOpen, setWorkstreamsOpen] = useDeviceParityState("tasks.workstreamsOpen", false);
  const [mobileToolsOpen, setMobileToolsOpen] = useDeviceParityState("tasks.mobileToolsOpen", false);
  const [firstWorkstream, setFirstWorkstream] = useDeviceParityState("tasks.firstWorkstream", "");
  const [firstWorkstreamBusy, setFirstWorkstreamBusy] = useState(false);
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const taskTopbarRef = useRef(null);
  const searchRef = useRef(null);
  const viewButtonRefs = useRef([]);
  const deepLinkRef = useRef(null);
  const deepLinkMountGenerationRef = useRef(0);
  // Render-synced mirror of openTaskId for the unmount cleanup below, which
  // must know whether a card is open without re-registering per open/close.
  const openTaskRef = useRef(null);
  const modalTriggerRef = useRef(null);
  const confirmTriggerRef = useRef(null);
  const confirmBackdropRef = useRef(null);
  const shortcutsBackdropRef = useRef(null);
  const confirmDialogRef = useRef(null);
  const wsTriggerRef = useRef(null);
  const templateTriggerRef = useRef(null);
  const pendingBoardComposerRef = useRef(false);
  // The prop list is the authoritative realtime snapshot. A failed optimistic
  // delete may restore a row only while that source still contains it; a
  // concurrent remote removal must never be resurrected from a stale dialog.
  const sourceTasksRef = useRef(data.tasks || []);
  sourceTasksRef.current = data.tasks || [];
  // One write at a time per task. Every server write bumps updated_at, and
  // the content RPC carries a compare-and-swap token — so a title blur-commit
  // racing a close-flush (or a toggle racing a content save) handed the later
  // write a token the earlier one had already burned (SQLSTATE 40001). Each
  // task's writes queue in taskWriteChainRef, and a queued content write reads
  // its token from serverRowsRef — fed by server RESPONSES, cleared on resync.
  const taskWriteChainRef = useRef(new Map());
  const serverRowsRef = useRef(new Map());
  // Pending intent is separate from server rows: it survives a source refresh
  // or an earlier response, but must never supply a content CAS token.
  const pendingTaskPatchesRef = useRef(new Map());
  // The 1024px pin is the app's desktop threshold, and the desktop-threshold
  // test counts exactly these two usages. It used to swap the board to a
  // one-status compact layout; the kanban board scrolls horizontally at every
  // width now, so the pin gates TOP-BAR DENSITY only — below it the view
  // pills drop their text labels and keep icon + aria-label.
  const [wideBoard, setWideBoard] = useState(() => {
    try { return typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1024px)").matches; } catch { return false; }
  });
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    let mq;
    try { mq = window.matchMedia("(min-width: 1024px)"); } catch { return undefined; }
    const onChange = (event) => setWideBoard(event.matches);
    if (typeof mq.addEventListener === "function") { mq.addEventListener("change", onChange); return () => mq.removeEventListener("change", onChange); }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);
  const [desktopViewWidth, setDesktopViewWidth] = useState(DESKTOP_WORK_VIEW_MIN_PX);
  const [desktopViewLabelsVisible, setDesktopViewLabelsVisible] = useState(false);
  useLayoutEffect(() => {
    if (!desktopShell) return undefined;
    const topbar = taskTopbarRef.current;
    if (!topbar || typeof window === "undefined") return undefined;

    const measure = () => {
      const style = window.getComputedStyle(topbar);
      const horizontalPadding = (Number.parseFloat(style.paddingLeft) || 0)
        + (Number.parseFloat(style.paddingRight) || 0);
      const next = desktopWorkViewWidth(topbar.clientWidth - horizontalPadding);
      setDesktopViewWidth((current) => Math.abs(current - next) < 0.01 ? current : next);
    };

    measure();
    const observer = typeof globalThis.ResizeObserver === "function"
      ? new globalThis.ResizeObserver(measure)
      : null;
    observer?.observe(topbar);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [desktopShell]);
  useLayoutEffect(() => {
    if (!desktopShell || typeof window === "undefined") return undefined;

    const buttons = Array.from({ length: viewIds.length }, (_, index) => viewButtonRefs.current[index]);
    const measureLabelFit = () => {
      const labelMeasurements = buttons.map((button) => {
        if (!button) {
          return { allocatedWidth: Number.NaN, labelWidth: Number.NaN, chromeWidth: Number.NaN };
        }
        const buttonStyle = window.getComputedStyle(button);
        const icon = button.querySelector("svg");
        const measureLabel = button.querySelector(".kan-pill__measure");
        const iconWidth = icon?.getBoundingClientRect().width
          || Number.parseFloat(icon?.getAttribute("width"))
          || Number.NaN;
        const labelWidth = Math.max(
          measureLabel?.scrollWidth || 0,
          measureLabel?.getBoundingClientRect().width || 0,
        );
        const chromeWidth = (Number.parseFloat(buttonStyle.paddingLeft) || 0)
          + (Number.parseFloat(buttonStyle.paddingRight) || 0)
          + (Number.parseFloat(buttonStyle.columnGap) || Number.parseFloat(buttonStyle.gap) || 0)
          + iconWidth;
        return {
          allocatedWidth: button.getBoundingClientRect().width,
          labelWidth,
          chromeWidth,
        };
      });
      const labelsFit = desktopWorkViewLabelsFit(labelMeasurements, viewIds.length);
      setDesktopViewLabelsVisible((current) => current === labelsFit ? current : labelsFit);
    };

    measureLabelFit();
    const observer = typeof globalThis.ResizeObserver === "function"
      ? new globalThis.ResizeObserver(measureLabelFit)
      : null;
    for (const button of buttons) {
      if (!button) continue;
      observer?.observe(button);
      const probe = button.querySelector(".kan-pill__measure");
      if (probe) observer?.observe(probe);
    }
    window.addEventListener("resize", measureLabelFit);
    let cancelled = false;
    const fonts = document.fonts;
    fonts?.ready?.then(() => {
      if (!cancelled) measureLabelFit();
    });
    fonts?.addEventListener?.("loadingdone", measureLabelFit);
    return () => {
      cancelled = true;
      observer?.disconnect();
      window.removeEventListener("resize", measureLabelFit);
      fonts?.removeEventListener?.("loadingdone", measureLabelFit);
    };
  }, [desktopShell, desktopViewWidth, lang, viewIds]);
  const [compactToolbar, setCompactToolbar] = useState(() => {
    try { return typeof window !== "undefined" && window.innerWidth <= 720; } catch { return false; }
  });
  useEffect(() => {
    const onResize = () => setCompactToolbar(window.innerWidth <= 720);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Desktop owns two additional views that the paired phone/tablet tree does
  // not render. Common IDs still mirror through the existing parity keys;
  // desktop-only IDs stay local so they can never leave a companion with no
  // matching view. A stale pre-restoration snapshot is repaired to Board.
  useEffect(() => {
    const changed = lastSharedViewRef.current !== sharedView;
    lastSharedViewRef.current = sharedView;
    if (!isSharedTaskView(sharedView)) {
      if (!desktopShell) setSharedView("board");
      return;
    }
    if (changed) setDesktopView(sharedView);
  }, [desktopShell, setSharedView, sharedView]);

  useEffect(() => {
    const changed = lastSharedFocusRef.current !== sharedFocusedView;
    lastSharedFocusRef.current = sharedFocusedView;
    if (!isSharedTaskView(sharedFocusedView)) {
      if (!desktopShell) setSharedFocusedView("board");
      return;
    }
    if (changed) setDesktopFocusedView(sharedFocusedView);
  }, [desktopShell, setSharedFocusedView, sharedFocusedView]);

  useEffect(() => {
    setTasks((data.tasks || []).map(withPendingTaskPatches));
    // A source resync is authoritative: cached per-write server rows would
    // otherwise hand later content writes an OLDER CAS token than the source.
    serverRowsRef.current.clear();
  }, [data.tasks]);
  useEffect(() => setTaskMessages(data.taskMessages || []), [data.taskMessages]);

  // Staff capability: App passes the resolved answer (which knows about the
  // demo hats); a real data.roles check is the fallback for direct renders.
  const isStaff = staffAccess ?? (data.roles || []).some((role) => STAFF_TOOL_ROLES.includes(role));

  // Task keys ("WOR-42") are minted from the chapter id; a profile without one
  // (pre-migration fixtures) simply renders keyless cards.
  const chapterId = data.member.chapterId || "";

  // The chapter's workstream vocabulary. The per-chapter entity list is
  // authoritative; the strings on loaded cards are the rollout-safe fallback
  // for fixtures and for chapters the migration has not reached yet.
  const workstreamEntities = useMemo(() => {
    const byName = new Map();
    for (const entry of data.workstreams || []) byName.set(entry.name, entry);
    for (const task of tasks) {
      if (task.workstream && !byName.has(task.workstream)) {
        byName.set(task.workstream, { id: null, name: task.workstream });
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [data.workstreams, tasks]);
  const workstreamNames = useMemo(() => workstreamEntities.map((entry) => entry.name), [workstreamEntities]);
  // A chapter with no workstream could not file any task, and only staff can
  // add one (finding 57). Once the list has loaded empty, ask the server for
  // the chapter's default "General" workstream, once per mount.
  const ensuredWorkstreamRef = useRef(false);
  const workstreamListLoaded = Array.isArray(data.workstreams);
  useEffect(() => {
    if (!onEnsureDefaultWorkstream || !workstreamListLoaded || workstreamNames.length > 0 || ensuredWorkstreamRef.current) return;
    ensuredWorkstreamRef.current = true;
    Promise.resolve().then(onEnsureDefaultWorkstream).catch(() => {});
  }, [onEnsureDefaultWorkstream, workstreamListLoaded, workstreamNames.length]);

  const scopeCounts = useMemo(
    () => Object.fromEntries(SCOPE_IDS.map((id) => [id, tasks.filter((task) => taskInScope(task, id, data.member.id)).length])),
    [data.member.id, tasks],
  );

  const filteredTasks = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return tasks.filter((task) => {
      if (!taskInScope(task, scope, data.member.id)) return false;
      if (priority !== "all" && task.priority !== priority) return false;
      if (workstream !== "all" && task.workstream !== workstream) return false;
      if (assigneeFilter && !taskAssigneeIds(task).includes(assigneeFilter)) return false;
      if (!needle) return true;
      // A pasted "wor-42" finds its card before the free-text fields do.
      if (matchesTaskKey(task, chapterId, needle)) return true;
      return [task.title, task.description, task.assigneeName, ...(task.assigneeNames || []), task.workstream]
        .some((value) => String(value || "").toLowerCase().includes(needle));
    });
  }, [assigneeFilter, chapterId, data.member.id, priority, scope, search, tasks, workstream]);

  // The tile row is gone (t0ggles boards are clean); what survives of the old
  // summary is exactly what the chrome still prints — the header subline's
  // open count and the toolbar's done chip.
  const summary = useMemo(() => ({
    total: filteredTasks.length,
    done: filteredTasks.filter((task) => task.status === "done").length,
  }), [filteredTasks]);

  // The avatar quick-filter ranks by OPEN cards in the current view (same
  // filters as the board except assigneeFilter, so toggling a face cannot
  // empty the strip). Done cards would pin retired assignees into the top
  // three forever.
  const memberFilterList = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const counts = new Map();
    for (const task of tasks) {
      if (task.status === "done") continue;
      if (!taskInScope(task, scope, data.member.id)) continue;
      if (priority !== "all" && task.priority !== priority) continue;
      if (workstream !== "all" && task.workstream !== workstream) continue;
      if (needle) {
        const matchesKey = matchesTaskKey(task, chapterId, needle);
        const matchesText = [task.title, task.description, task.assigneeName, ...(task.assigneeNames || []), task.workstream]
          .some((value) => String(value || "").toLowerCase().includes(needle));
        if (!matchesKey && !matchesText) continue;
      }
      for (const assigneeId of taskAssigneeIds(task)) {
        counts.set(assigneeId, (counts.get(assigneeId) || 0) + 1);
      }
    }
    return (data.taskAssignees || [])
      .map((person) => ({ ...person, openCount: counts.get(person.id) || 0 }))
      .sort((a, b) => b.openCount - a.openCount || a.fullName.localeCompare(b.fullName));
  }, [chapterId, data.member.id, data.taskAssignees, priority, scope, search, tasks, workstream]);
  const topMembers = memberFilterList.filter((person) => person.openCount > 0).slice(0, 3);
  const overflowMembers = memberFilterList.filter((person) => person.openCount > 0 && !topMembers.some((top) => top.id === person.id));

  const liveModalTask = openTaskId ? tasks.find((task) => task.id === openTaskId) || null : null;
  // Optimistic delete removes the card from `tasks` before the RPC settles.
  // Keep the workspace backed by the exact deleted snapshot during that wait:
  // a slow failure can then restore the card without the modal disappearing
  // halfway through the request and taking the member's context with it.
  const requestedModalTask = liveModalTask
    || (pendingDeleteTask?.id === openTaskId ? pendingDeleteTask : null);
  const modalPresence = useRetainedTransition(requestedModalTask, {
    exitMs: DETAIL_SURFACE_EXIT_MS,
    onExited: finishTaskModalClose,
  });
  const modalTask = modalPresence.value;
  const confirmPresence = useRetainedTransition(confirmTask, {
    exitMs: 200,
    onExited: finishConfirmClose,
  });
  const presentedConfirmTask = confirmPresence.value;
  const nonReportChromePresence = useTransitionPresence(view !== "report", {
    exitMs: 200,
    appear: false,
  });
  useModalIsolation(confirmBackdropRef, { active: confirmPresence.mounted });
  // The template picker and the keyboard sheet mount open and close with the
  // prototype modal's 200 ms scrim fade.
  const templateExit = useModalExit(templateDialogOpen);
  const shortcutsExit = useModalExit(shortcutsOpen);
  const shortcutsClosingRef = useRef(false);
  shortcutsClosingRef.current = shortcutsExit.closing;
  useModalIsolation(shortcutsBackdropRef, { active: shortcutsExit.shown });
  openTaskRef.current = openTaskId;

  // Only RESOLVABLE edges leave this component: an edge whose endpoint has
  // aged past the board window (or was purged) would render keyless husks in
  // the modal and phantom counts on cards — filtering once here keeps every
  // consumer (modal lists, add-picker exclusions, card badges) in agreement.
  const relationTasks = useMemo(() => (
    pendingDeleteTask && !tasks.some((task) => task.id === pendingDeleteTask.id)
      ? [...tasks, pendingDeleteTask]
      : tasks
  ), [pendingDeleteTask, tasks]);
  const taskById = useMemo(() => new Map(relationTasks.map((task) => [task.id, task])), [relationTasks]);
  const liveDependencies = useMemo(
    () => (data.taskDependencies || []).filter((edge) => taskById.has(edge.taskId) && taskById.has(edge.dependsOnId)),
    [data.taskDependencies, taskById],
  );
  const depCounts = useMemo(() => {
    const counts = new Map();
    for (const edge of liveDependencies) {
      counts.set(edge.taskId, (counts.get(edge.taskId) || 0) + 1);
      counts.set(edge.dependsOnId, (counts.get(edge.dependsOnId) || 0) + 1);
    }
    return counts;
  }, [liveDependencies]);
  const liveSubtasks = useMemo(
    () => (data.taskSubtasks || []).filter((edge) => taskById.has(edge.parentTaskId) && taskById.has(edge.subtaskId)),
    [data.taskSubtasks, taskById],
  );
  const subtaskCounts = useMemo(() => {
    const counts = new Map();
    for (const edge of liveSubtasks) {
      const current = counts.get(edge.parentTaskId) || { done: 0, total: 0 };
      current.total += 1;
      if (taskById.get(edge.subtaskId)?.status === "done") current.done += 1;
      counts.set(edge.parentTaskId, current);
    }
    return counts;
  }, [liveSubtasks, taskById]);
  const commentCounts = useMemo(() => {
    const counts = new Map();
    for (const comment of data.taskComments || []) {
      counts.set(comment.taskId, (counts.get(comment.taskId) || 0) + 1);
    }
    return counts;
  }, [data.taskComments]);
  const attachmentCounts = useMemo(() => {
    const counts = new Map();
    for (const attachment of data.taskAttachments || []) {
      counts.set(attachment.taskId, (counts.get(attachment.taskId) || 0) + 1);
    }
    return counts;
  }, [data.taskAttachments]);
  const unfiltered = scope === "mine" && !search.trim() && priority === "all" && workstream === "all" && !assigneeFilter;

  // Deep links ride the query string with history.replaceState, NEVER
  // navigate(): pathname routing has no params here and navigate() resets
  // scroll, while demo/embed params must survive a share link round-trip.
  function writeTaskParam(value) {
    try {
      const params = new URLSearchParams(window.location.search);
      if (value) params.set("task", value);
      else params.delete("task");
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash || ""}`);
    } catch { /* environments without history (some test harnesses) lose only the shareable URL */ }
  }

  function openTaskModal(task, { focusAssignee = false } = {}) {
    // Navigation between task workspaces must not replace the original board
    // trigger with a control that will disappear when the old modal remounts.
    if (!openTaskRef.current) modalTriggerRef.current = document.activeElement;
    setAssignFocus(focusAssignee);
    setOpenTaskId(task.id);
    const key = taskKey(task, chapterId);
    if (key) writeTaskParam(key.toLowerCase());
  }

  function closeTaskModal() {
    setOpenTaskId(null);
    // The surface stays mounted for its 200ms visual exit, but the share URL
    // must describe the requested state immediately. A reload during that
    // short exit should not reopen a task the member has already closed.
    writeTaskParam(null);
    document.title = "Union Ground";
  }

  function finishTaskModalClose() {
    setOpenTaskId(null);
    setAssignFocus(false);
    writeTaskParam(null);
    document.title = "Union Ground";
    const trigger = modalTriggerRef.current;
    modalTriggerRef.current = null;
    restoreFocusWhenInteractive(
      trigger,
      () => document.querySelector(".kan-board button.kan-newtask"),
    );
  }

  function openDeleteConfirm(task) {
    confirmTriggerRef.current = document.activeElement;
    setConfirmTask(task);
  }

  function finishConfirmClose() {
    const trigger = confirmTriggerRef.current;
    confirmTriggerRef.current = null;
    restoreFocusWhenInteractive(
      trigger,
      () => document.querySelector('.kan-modal-backdrop:not([data-state="closing"]) .kan-modal')
        || document.querySelector(".kan-board button.kan-newtask"),
    );
  }

  // ?task=wor-42 opens the modal once per param value. A consumed key is only
  // skipped while its modal is actually open: React Strict Mode replays mount
  // effects before the first state update is committed, so the replay must be
  // allowed to request that same card a second time.
  useEffect(() => {
    let param;
    try { param = new URLSearchParams(window.location.search).get("task"); } catch { param = null; }
    if (!param || (deepLinkRef.current === param && openTaskRef.current)) return;
    if (!tasks.length) return; // don't declare a key unknown before the board has loaded
    deepLinkRef.current = param;
    const target = tasks.find((task) => task.id === param || matchesTaskKey(task, chapterId, param));
    if (target) {
      setAssignFocus(false);
      setOpenTaskId(target.id);
    } else {
      setLiveMessage(t("kanban.deepLinkMissing"));
    }
  }, [chapterId, setAssignFocus, setOpenTaskId, t, tasks]);

  // Leaving the Tasks view consumes the deep link. Companion navigation
  // preserves the whole search string, so an open card's ?task= would ride
  // along to unrelated views and re-open a stale modal on the next visit
  // (demo+embed share links inherit the same trip). Unmount-only cleanup is
  // deliberate: a full reload never runs it, so a key in the URL still
  // deep-links on cold load. The guard matters under StrictMode's rehearsal
  // unmount — a key the board never consumed (tasks not loaded yet) must
  // survive for the mount that will actually read it.
  useEffect(() => {
    const generation = ++deepLinkMountGenerationRef.current;
    return () => {
      // React Strict Mode immediately replays mount effects in development.
      // Defer the destructive URL cleanup one microtask so a replayed setup
      // can advance the generation and prove that this was not a real view
      // departure. A genuine unmount has no next setup and still consumes the
      // link before the browser can handle a later user interaction.
      queueMicrotask(() => {
        // The mutable value is intentionally read after cleanup: a replayed
        // setup advances it before this microtask runs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        if (deepLinkMountGenerationRef.current !== generation) return;
        let param;
        try { param = new URLSearchParams(window.location.search).get("task"); } catch { param = null; }
        if (!param) return;
        if (!openTaskRef.current && deepLinkRef.current !== param) return;
        writeTaskParam(null);
      });
    };
  }, []);

  // First title write in the codebase, kept contained to the modal's lifetime:
  // the cleanup restores the app title on close AND on unmount, so navigating
  // away with the modal open cannot leave a task key in the tab strip.
  useEffect(() => {
    if (!modalTask) return undefined;
    const key = taskKey(modalTask, chapterId);
    if (key) document.title = `${key} · Union Ground`;
    return () => { document.title = "Union Ground"; };
  }, [modalTask, chapterId]);

  function toggleFocusWorkstream(name) {
    const next = focusWorkstream === name ? null : name;
    activateView("board");
    setFocusWorkstream(next);
    setLiveMessage(next ? t("kanban.focusedOn", { name: next }) : t("kanban.exitFocus"));
  }

  function selectFocusedView(nextView) {
    if (desktopShell) setDesktopFocusedView(nextView);
    if (isSharedTaskView(nextView)) setSharedFocusedView(nextView);
  }

  function commitView(nextView) {
    if (desktopShell) setDesktopView(nextView);
    if (isSharedTaskView(nextView)) setSharedView(nextView);
    if (workspace) setRoutedView(nextView);
  }

  function activateView(nextView) {
    if (!viewIds.includes(nextView)) return;
    selectFocusedView(nextView);
    if (nextView === view) {
      if (workspace && workspace.page?.group !== "tasks") setRoutedView(nextView);
      return;
    }
    // Filter/member popovers do not exist in Report. Request their retained
    // 200ms close before the contextual toolbar leaves, so switching views
    // never hard-unmounts an open panel or resurrects it on return.
    if (nextView === "report" && (popover === "filter" || popover === "members")) {
      setPopover(null);
    }
    const update = () => commitView(nextView);
    let reduced = false;
    try {
      reduced = typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch { /* keep the immediate fallback */ }
    if (!reduced && typeof document.startViewTransition === "function") {
      const transition = document.startViewTransition(update);
      // Chromium rejects `ready` with AbortError when a newer view transition
      // supersedes this one. The view update is still valid; consume all three
      // lifecycle promises so rapid keyboard switching never emits an
      // unhandled rejection.
      transition?.ready?.catch?.(() => {});
      transition?.updateCallbackDone?.catch?.(() => {});
      transition?.finished?.catch?.(() => {});
    } else {
      update();
    }
  }

  function handleViewKeyDown(event, index) {
    let nextIndex = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % viewIds.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + viewIds.length) % viewIds.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = viewIds.length - 1;
      if (nextIndex !== null) {
        event.preventDefault();
        selectFocusedView(viewIds[nextIndex]);
        viewButtonRefs.current[nextIndex]?.focus();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateView(viewIds[index]);
    }
  }

  // KanbanBoard's prop contract is locked and carries no imperative handle, so
  // the header button and the `c` key reach the Standard Task composer by DOM
  // after the measured view switch has painted. In workstream focus, To do is
  // the quick-create default; a stage composer remains the explicit override.
  function openDefaultComposer() {
    const selector = focusWorkstream
      ? '.kan-col--status[data-status="to_do"] button.kan-newtask'
      : ".kan-board button.kan-newtask";
    if (view === "board") {
      document.querySelector(selector)?.click();
      return;
    }
    pendingBoardComposerRef.current = selector;
    activateView("board");
  }

  useLayoutEffect(() => {
    if (view !== "board" || !pendingBoardComposerRef.current) return;
    const selector = pendingBoardComposerRef.current;
    pendingBoardComposerRef.current = false;
    // The ghost row IS the button (NewTaskRow's closed state), not a wrapper
    // around one. Waiting for this committed board render also works when
    // Chromium schedules startViewTransition's update after the key event.
    document.querySelector(selector)?.click();
  }, [view]);

  // One window keydown map. Skip rules, in order: an overlay that already
  // handled the key (defaultPrevented), typing surfaces, and modified chords —
  // EXCEPT the two mapped combos (Ctrl+Shift+letter views, Ctrl+digit focus).
  // Escape reaches the map only when no overlay claimed it, which is exactly
  // when it may exit focus mode.
  useEffect(() => {
    function onKeyDown(event) {
      if (event.defaultPrevented) return;
      const target = event.target;
      const tag = target?.tagName || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      if (modalPresence.mounted || confirmPresence.mounted || popover || shortcutsExit.shown || workstreamsOpen) return;
      const chord = event.ctrlKey || event.metaKey;
      if (chord && !keyboardShortcutsOn) return;
      if (chord && event.shiftKey && !event.altKey) {
        const nextView = (desktopShell ? DESKTOP_VIEW_SHORTCUTS : VIEW_SHORTCUTS)[event.key.toLowerCase()];
        if (nextView) {
          event.preventDefault();
          activateView(nextView);
        }
        return;
      }
      if (chord && !event.shiftKey && !event.altKey) {
        const digit = Number(event.key);
        if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
          const name = workstreamNames[digit - 1];
          if (name) {
            event.preventDefault();
            toggleFocusWorkstream(name);
          }
        }
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (characterKeysActive && event.key === "/") {
        event.preventDefault();
        if (onFocusSearch) onFocusSearch();
        else searchRef.current?.focus();
        return;
      }
      if (characterKeysActive && event.key === "?") {
        event.preventDefault();
        openShortcuts();
        return;
      }
      if (characterKeysActive && event.key === "c") {
        event.preventDefault();
          openDefaultComposer();
        return;
      }
      if (event.key === "Escape") {
        if (focusWorkstream && !shortcutsExit.shown && !popover && !openTaskId && !confirmTask && !workstreamsOpen) {
          setFocusWorkstream(null);
          setLiveMessage(t("kanban.exitFocus"));
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // openDefaultComposer/toggleFocusWorkstream/openShortcuts are re-created every render; the
    // state they read is already in this list, so re-subscribing on them too
    // would just churn the listener on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterKeysActive, confirmPresence.mounted, confirmTask, desktopShell, focusWorkstream, modalPresence.mounted, onFocusSearch, openTaskId, popover, shortcutsExit.shown, t, view, workstreamNames, workstreamsOpen, keyboardShortcutsOn]);

  // The shortcuts dialog owns its Escape (modal, via the shared stack) so the
  // keymap above never sees the same press and the non-modal Compass panel
  // beneath it keeps its draft.
  useEffect(() => {
    if (!shortcutsExit.shown) return undefined;
    // Escape goes through the shared stack (modal), so it never also reaches
    // the keymap above or the non-modal Compass panel beneath the sheet. Tab
    // stays on a local listener: inert only drops the board from the tab
    // order, so the dialog still has to wrap its own first/last stops. Both
    // hold through the 200 ms close fade; a second Escape there is swallowed.
    const unregisterEscape = registerEscapeLayer(() => {
      if (!shortcutsClosingRef.current) setShortcutsOpen(false);
      return undefined;
    }, { modal: true });
    function onKey(event) {
      if (event.key !== "Tab") return;
      // A command palette opened above the sheet keeps its own Tab order.
      if (event.target instanceof Element && event.target.closest(".command-palette")) return;
      const dialog = shortcutsBackdropRef.current?.querySelector("[role='dialog']");
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const inside = dialog.contains(document.activeElement);
      if (event.shiftKey && (!inside || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      unregisterEscape();
      window.removeEventListener("keydown", onKey);
      // Once the sheet has gone, return focus to whatever opened it (the
      // help button or the element that had focus when ? was pressed).
      const opener = shortcutsOpenerRef.current;
      shortcutsOpenerRef.current = null;
      returnFocusAfterModal(opener);
    };
  }, [setShortcutsOpen, shortcutsExit.shown]);

  useEffect(() => {
    if (!confirmPresence.mounted) return undefined;
    function onKey(event) {
      const dialog = document.querySelector(".task-confirm");
      if (!dialog) return;
      // Capture runs before a command palette opened above this confirmation;
      // keys typed into the palette are the palette's own.
      if (event.target instanceof Element && event.target.closest(".command-palette")) return;
      if (confirmPresence.closing) {
        if (event.key === "Escape" || event.key === "Tab") event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setConfirmTask(null);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    // Capture runs before the task workspace's window listener. preventDefault
    // therefore marks Escape as consumed by this deeper confirmation layer.
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, [confirmPresence.closing, confirmPresence.mounted, setConfirmTask]);

  useLayoutEffect(() => {
    const dialog = confirmDialogRef.current;
    if (confirmPresence.closing && dialog?.contains(document.activeElement)) dialog.focus();
  }, [confirmPresence.closing]);

  function authoritativeTask(taskId) {
    const source = sourceTasksRef.current.find((task) => task.id === taskId);
    const confirmed = serverRowsRef.current.get(taskId);
    return confirmed && source && String(confirmed.updatedAt || "") >= String(source.updatedAt || "")
      ? confirmed : source;
  }

  function withPendingTaskPatches(task) {
    return (pendingTaskPatchesRef.current.get(task.id) || [])
      .reduce((current, entry) => ({ ...current, ...entry.patch }), task);
  }

  function settleTaskPatch(taskId, entry) {
    const remaining = (pendingTaskPatchesRef.current.get(taskId) || []).filter((pending) => pending !== entry);
    if (remaining.length) pendingTaskPatchesRef.current.set(taskId, remaining);
    else pendingTaskPatchesRef.current.delete(taskId);
  }

  async function writeTask(taskId, patch, run) {
    setError("");
    const pending = { patch };
    pendingTaskPatchesRef.current.set(taskId, [...(pendingTaskPatchesRef.current.get(taskId) || []), pending]);
    setTasks((current) => current.map((task) => (task.id === taskId ? { ...task, ...patch } : task)));
    const previousWrite = taskWriteChainRef.current.get(taskId) || Promise.resolve();
    const chained = previousWrite.then(run);
    // A refusal does not erase the last successful same-task receipt. The
    // caller still sees its error, while a queued move can use that CAS token.
    const checkpoint = chained.catch(() => previousWrite);
    taskWriteChainRef.current.set(taskId, checkpoint);
    try {
      const result = await chained;
      settleTaskPatch(taskId, pending);
      const rows = Array.isArray(result) ? result : result?.id ? [result] : [];
      if (rows.length) {
        for (const row of rows) serverRowsRef.current.set(row.id, row);
        const latest = new Map(rows.map((row) => [row.id, authoritativeTask(row.id)]));
        setTasks((current) => current.map((task) => latest.has(task.id)
          ? withPendingTaskPatches({ ...task, ...latest.get(task.id) }) : task));
      }
      return result;
    } catch (cause) {
      settleTaskPatch(taskId, pending);
      const sourceTask = sourceTasksRef.current.find((task) => task.id === taskId) || null;
      const confirmedTask = serverRowsRef.current.get(taskId);
      const restoredTask = sourceTask && confirmedTask
        && String(confirmedTask.updatedAt || "") >= String(sourceTask.updatedAt || "")
        ? confirmedTask : sourceTask;
      setTasks((current) => sourceTask
        ? current.map((task) => (task.id === taskId ? withPendingTaskPatches(restoredTask) : task))
        : current.filter((task) => task.id !== taskId));
      setError(t(rpcRefusalKey(cause, "tasks.errorUpdate")));
      // Rethrow the ORIGINAL error: the modal maps SQLSTATE codes to named
      // copy, and a synthetic wrapper here was exactly what erased them.
      throw cause;
    } finally {
      if (taskWriteChainRef.current.get(taskId) === checkpoint) taskWriteChainRef.current.delete(taskId);
    }
  }

  function updateTask(taskId, patch, contentVersion) {
    const contentWrite = Object.hasOwn(patch, "title") || Object.hasOwn(patch, "description");
    return writeTask(taskId, patch, () => {
      if (!contentWrite) return onUpdateTask(taskId, patch);
      if (contentVersion === undefined) return onUpdateTask(taskId, patch, authoritativeTask(taskId)?.updatedAt ?? null);
      if (!contentVersion || typeof contentVersion !== "object") return onUpdateTask(taskId, patch, contentVersion);
      // Modal drafts carry the content they were typed against. An earlier
      // write in this chain (a date, status or progress change) advances the
      // token without touching content, so take the current token when the
      // content still matches. A teammate's content change is never lent it:
      // that conflict is refused here without calling the content RPC.
      const current = authoritativeTask(taskId);
      if (!current || Object.entries(contentVersion.bases).some(([field, base]) => (current[field] || "") !== base)) {
        throw Object.assign(new Error("task content changed"), { code: "40001" });
      }
      return onUpdateTask(taskId, patch, current.updatedAt ?? null);
    });
  }

  // A board move changes STATUS ONLY. The server forces progress=100 on Done —
  // that is the one automatic write, it is announced, and Undo restores status
  // AND the old percentage, because once done_at is nulled the server cannot
  // give either back.
  async function moveTask(taskId, status) {
    const current = tasks.find((item) => item.id === taskId);
    const task = current && withPendingTaskPatches(current);
    if (!task || task.status === status) return;
    const wasDone = task.status === "done";
    try {
      await updateTask(taskId, { status });
      setLiveMessage(t("tasks.movedAnnounce", { status: t(`tasks.status.${status}`) }));
      if (status === "done") setDoneToast({ taskId, previous: task });
      else if (wasDone) setLiveMessage(t("tasks.reopened"));
    } catch {
      // The visible error and rollback are owned by updateTask.
    }
  }

  // The card circle: one click walks the t0ggles cycle. moveTask keeps the
  // done-toast/undo and announcement semantics the old board had.
  function cycleStatus(task) {
    moveTask(task.id, statusCycle(withPendingTaskPatches(task).status).to);
  }

  async function undoDone() {
    if (!doneToast) return;
    const { taskId, previous } = doneToast;
    setDoneToast(null);
    try {
      await updateTask(taskId, { status: previous.status, progress: previous.progress });
      setLiveMessage(t("tasks.reopened"));
    } catch {
      // updateTask rolled back and surfaced the error.
    }
  }

  // One write per drop. The columns are workstreams now and cards group by
  // status inside them, so the renumber partition is (workstream × status) —
  // renumbering a whole workstream would rewrite rows the drop never touched.
  // Same-group reorder sends {orderIndex}; a status hop adds {status}; a
  // cross-column drop adds {workstream} (plus {status} when the drop landed in
  // a different group of the target column).
  async function dropOnBoard(taskId, target = {}) {
    const currentTask = tasks.find((item) => item.id === taskId);
    const task = currentTask && withPendingTaskPatches(currentTask);
    if (!task) return;
    const nextWorkstream = target.workstream ?? task.workstream;
    const nextStatus = target.status ?? task.status;
    const beforeId = target.beforeId ?? null;
    const group = tasks
      .filter((item) => item.workstream === nextWorkstream && item.status === nextStatus && item.id !== taskId)
      .sort(byBoardOrder);
    const foundAt = beforeId ? group.findIndex((item) => item.id === beforeId) : -1;
    const at = beforeId && foundAt >= 0 ? foundAt : group.length;
    const prev = group[at - 1] || null;
    const next = group[at] || null;
    if (nextWorkstream === task.workstream && nextStatus === task.status) {
      // Dropping a card back beside itself must not write.
      const current = tasks
        .filter((item) => item.workstream === nextWorkstream && item.status === nextStatus)
        .sort(byBoardOrder);
      const currentIndex = current.findIndex((item) => item.id === taskId);
      if (current[currentIndex - 1]?.id === prev?.id && current[currentIndex + 1]?.id === next?.id) return;
    }
    const patch = {};
    if (nextStatus !== task.status) patch.status = nextStatus;
    if (nextWorkstream !== task.workstream) patch.workstream = nextWorkstream;
    const wasDone = task.status === "done";
    const orderIndex = orderBetween(prev, next);
    const collided = (prev && orderIndex <= prev.orderIndex)
      || (next && orderIndex >= next.orderIndex)
      || orderIndex < 0 || orderIndex > ORDER_MAX;
    if (onMoveTask) {
      const optimisticIndex = collided
        ? Math.min(Math.max((at + 1) * 1000, 0), ORDER_MAX)
        : orderIndex;
      await writeTask(taskId, { ...patch, orderIndex: optimisticIndex }, (previousResult) => {
        const previousRow = Array.isArray(previousResult)
          ? previousResult.find((row) => row.id === taskId) : previousResult;
        const current = authoritativeTask(taskId);
        // Advance the move's CAS token only from its own queue predecessor.
        // A newer teammate update must still refuse the captured move.
        const expectedVersion = previousRow?.id === taskId
          && String(previousRow.updatedAt || "") >= String(current?.updatedAt || "")
          ? previousRow.updatedAt : task.updatedAt;
        return onMoveTask(taskId, {
          workstream: nextWorkstream,
          status: nextStatus,
          beforeId,
          orderIndex: optimisticIndex,
        }, expectedVersion || null);
      });
      if (patch.status) {
        setLiveMessage(t("tasks.movedAnnounce", { status: t(`tasks.status.${nextStatus}`) }));
        if (nextStatus === "done") setDoneToast({ taskId, previous: task });
        else if (wasDone) setLiveMessage(t("tasks.reopened"));
      } else if (patch.workstream) {
        setLiveMessage(t("kanban.moved", { name: nextWorkstream }));
      }
      return;
    }
    try {
      if (!collided) {
        await updateTask(taskId, { ...patch, orderIndex });
      } else {
        // The midpoint gap has closed (~10 splits): renumber the target
        // group's partition by 1,000s, touching only rows whose index moves.
        const renumbered = [...group.slice(0, at), task, ...group.slice(at)];
        for (let index = 0; index < renumbered.length; index += 1) {
          const item = renumbered[index];
          const nextIndex = (index + 1) * 1000;
          if (item.id === taskId) await updateTask(item.id, { ...patch, orderIndex: nextIndex });
          else if (item.orderIndex !== nextIndex) await updateTask(item.id, { orderIndex: nextIndex });
        }
      }
      if (patch.status) {
        setLiveMessage(t("tasks.movedAnnounce", { status: t(`tasks.status.${nextStatus}`) }));
        if (nextStatus === "done") setDoneToast({ taskId, previous: task });
        else if (wasDone) setLiveMessage(t("tasks.reopened"));
      } else if (patch.workstream) {
        setLiveMessage(t("kanban.moved", { name: nextWorkstream }));
      }
    } catch {
      // updateTask owns rollback + error.
    }
  }

  // The keyboard (Alt+Arrow) reorder path — writes the same field the drag
  // writes, within the same (workstream × status) partition the card sits in.
  // It answers what it did — "moved", "atStart", "atEnd", or null when there is
  // no such card — because only the caller announces, and a refusal at either
  // end of the group must not be announced as a move.
  function reorderTask(taskId, direction) {
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return null;
    const group = tasks
      .filter((item) => item.workstream === task.workstream && item.status === task.status)
      .sort(byBoardOrder);
    const index = group.findIndex((item) => item.id === taskId);
    if (index < 0) return null;
    if (direction === "up") {
      if (index === 0) return "atStart";
      dropOnBoard(taskId, { beforeId: group[index - 1].id });
    } else {
      if (index >= group.length - 1) return "atEnd";
      dropOnBoard(taskId, { beforeId: group[index + 2]?.id ?? null });
    }
    return "moved";
  }

  // The composer is the ONLY create surface now — the full form is gone, and
  // details are added in the modal after the card exists. Standard Task
  // defaults stay explicit so the composer only needs a title.
  async function createStandardTask({ workstreamName, status, title, startDate = null, dueDate = null }) {
    const trimmed = title.trim();
    if (!trimmed) return null;
    setError("");
    const targetStatus = status || "to_do";
    const group = tasks
      .filter((item) => item.workstream === workstreamName && item.status === targetStatus)
      .sort(byBoardOrder);
    const last = group[group.length - 1] || null;
    try {
      const created = await onCreateTask({
        title: trimmed,
        description: "",
        status: targetStatus,
        priority: "medium",
        taskType: "general",
        workstream: workstreamName,
        assigneeId: null,
        startDate,
        dueDate,
        progress: 0,
        blocked: false,
        milestone: false,
        orderIndex: orderBetween(last, null),
      });
      if (created) setTasks((current) => [...current.filter((item) => item.id !== created.id), created]);
      return created;
    } catch (cause) {
      setError(t(rpcRefusalKey(cause, "tasks.errorSave")));
      // The composer keeps its text on failure; rethrow so it knows not to clear.
      throw cause;
    }
  }

  async function createFromTemplate(fields) {
    if (!onCreateTaskFromTemplate) return null;
    setError("");
    try {
      const result = await onCreateTaskFromTemplate(fields);
      if (result?.task) {
        setTasks((current) => [...current.filter((item) => item.id !== result.task.id), result.task]);
        setTemplateDialogOpen(false);
        setLiveMessage(t("taskTemplates.created", { title: result.task.title }));
        openTaskModal(result.task);
      }
      return result;
    } catch (cause) {
      setError(t(rpcRefusalKey(cause, "tasks.errorSave")));
      throw cause;
    }
  }

  async function updateTemplateDetails(fields) {
    if (!onUpdateTaskTemplateDetails) return null;
    setError("");
    try {
      const result = await onUpdateTaskTemplateDetails(fields);
      if (result?.task) setTasks((current) => mergeExistingRows(current, [result.task]));
      if (result?.details) setLiveMessage(t(fields.nextFlowStep ? "taskTemplates.flowUpdated" : "taskTemplates.fieldsUpdated"));
      return result;
    } catch (cause) {
      setError(t(rpcRefusalKey(cause, "tasks.errorUpdate")));
      throw cause;
    }
  }

  // #8211: an existing General task becomes a specialized type in place; the
  // editor stays open on the converted task.
  async function convertTaskType(taskId, conversion) {
    if (!onConvertTaskToTemplate) return null;
    setError("");
    try {
      const result = await onConvertTaskToTemplate({ taskId, ...conversion });
      if (result?.task) {
        // The receipt can be older than the row the board already holds.
        setTasks((current) => mergeExistingRows(current, [result.task], localTaskRowWins));
        setLiveMessage(t("taskTemplates.converted", { title: result.task.title }));
      }
      return result;
    } catch (cause) {
      setError(t(rpcRefusalKey(cause, "tasks.errorUpdate")));
      throw cause;
    }
  }

  async function createInline(workstreamName, status, title) {
    return createStandardTask({ workstreamName, status, title });
  }

  async function createCalendarItem(date, title) {
    const workstreamName = focusWorkstream || workstreamNames[0];
    // On every shell a missing workstream is named and a null result is a
    // failure, so the calendar keeps the title (#9469).
    if (!workstreamName) {
      setError(t("tasks.calendarNeedsWorkstream"));
      return null;
    }
    const created = await createStandardTask({
      workstreamName,
      status: "to_do",
      title,
      startDate: date,
      dueDate: date,
    });
    if (!created) setError(t("tasks.errorSave"));
    return created;
  }

  // Duplicate copies every client-writable field verbatim; the server mints
  // the new key and stamps identity. The copy lands at the bottom of the
  // original's own (workstream × status) group, and the modal follows it —
  // the point of duplicating is to edit the copy next.
  async function duplicateTask(task) {
    const group = tasks
      .filter((item) => item.workstream === task.workstream && item.status === task.status)
      .sort(byBoardOrder);
    const last = group[group.length - 1] || null;
    setError("");
    try {
      const created = await onCreateTask({
        title: task.title,
        description: task.description || "",
        status: task.status,
        priority: task.priority,
        taskType: task.taskType || "general",
        workstream: task.workstream,
        assigneeId: task.assigneeId || null,
        startDate: task.startDate,
        dueDate: task.dueDate,
        progress: task.progress,
        blocked: task.blocked,
        milestone: task.milestone,
        orderIndex: orderBetween(last, null),
      });
      if (created) {
        const assigneeIds = taskAssigneeIds(task);
        let duplicated = created;
        if (assigneeIds.length > 1 && onSetTaskAssignees) {
          const assigned = await onSetTaskAssignees(created.id, assigneeIds);
          if (assigned) {
            duplicated = {
              ...created,
              assigneeIds,
              assigneeNames: task.assigneeNames || [],
            };
          }
        }
        setTasks((current) => [...current.filter((item) => item.id !== duplicated.id), duplicated]);
        openTaskModal(duplicated);
      }
      return created;
    } catch (cause) {
      setError(t(rpcRefusalKey(cause, "tasks.errorSave")));
      return null;
    }
  }

  // Soft delete: optimistic removal, RPC server-side, Undo owned by the App
  // toast. The card must not linger while the server is asked.
  async function removeTask(task) {
    setError("");
    setPendingDeleteTask(task);
    setLiveMessage(t("tasks.deleting", { title: task.title }));
    setTasks((current) => current.filter((item) => item.id !== task.id));
    try {
      await onDeleteTask(task.id);
      if (openTaskRef.current === task.id) closeTaskModal();
      setLiveMessage(t("tasks.deleteRecoverable"));
    } catch (cause) {
      // Restore only the failed row. Replacing the whole pre-request array
      // would erase unrelated realtime or local changes that landed while the
      // delete RPC was pending. The realtime source must still contain the row:
      // if it disappeared remotely during the request, restoring this snapshot
      // would resurrect a task that no longer exists.
      const sourceTask = sourceTasksRef.current.find((item) => item.id === task.id) || null;
      if (sourceTask) {
        setTasks((current) => current.some((item) => item.id === task.id) ? current : [...current, sourceTask]);
      }
      setError(t(rpcRefusalKey(cause, "tasks.errorDelete")));
      throw cause;
    } finally {
      setPendingDeleteTask(null);
    }
  }

  async function confirmRemove() {
    if (confirmPresence.closing) return;
    const taskId = presentedConfirmTask?.id;
    // The retained confirm intentionally presents its opening snapshot through
    // the exit animation. Resolve the destructive request from the current row
    // so a realtime/rerender update cannot be overwritten on rollback.
    const task = taskId ? tasks.find((item) => item.id === taskId) || null : null;
    setConfirmTask(null);
    if (!task) return;
    try {
      await removeTask(task);
    } catch {
      // removeTask restored the board and surfaced the error.
    }
  }

  async function sendMessage(taskId, body) {
    const created = await onSendTaskMessage(taskId, body);
    if (created) {
      setTaskMessages((current) => [...current.filter((message) => message.id !== created.id), created]);
      setLiveMessage(t("toast.taskMessageSent"));
    }
    return created;
  }

  // A chapter created after the seed has zero workstreams, and the inline
  // composers need a column to live in — this is the one place the add flow
  // the old editor carried still matters, so the empty board offers it to
  // staff directly. Free text for members stays impossible on purpose: after
  // the migration the workstream assert rejects unknown names anyway.
  function addFirstWorkstream() {
    return runBusyWrite(busyWriteRef, "workstream", () => addFirstWorkstreamNow());
  }

  async function addFirstWorkstreamNow() {
    const name = firstWorkstream.trim();
    if (!name || !onAddWorkstream) return;
    setFirstWorkstreamBusy(true);
    setError("");
    try {
      await onAddWorkstream(name);
      setFirstWorkstream("");
    } catch (cause) {
      setError(cause?.code === "23505" ? t("tasks.workstreamExists", { name }) : t("tasks.errorSave"));
    } finally {
      setFirstWorkstreamBusy(false);
    }
  }

  // The five roles may remove any card; a member keeps delete on their own.
  // Everyone else simply never sees the control — the old RLS refusal surfaced
  // as "could not be deleted… restored", a false explanation of an unstated rule.
  function canDelete(task) {
    return isStaff || task.createdBy === data.member.id;
  }

  const deleteContext = useMemo(() => {
    if (!presentedConfirmTask) return null;
    const peerId = presentedConfirmTask.assigneeId && presentedConfirmTask.assigneeId !== data.member.id
      ? presentedConfirmTask.assigneeId
      : (presentedConfirmTask.createdBy !== data.member.id ? presentedConfirmTask.createdBy : null);
    const peer = peerId ? (data.taskAssignees || []).find((person) => person.id === peerId) : null;
    return {
      chapter: data.member.chapterName || t("tasks.chapter"),
      count: taskMessagesForMember(presentedConfirmTask.id, data.member.id, taskMessages).length,
      name: peer?.fullName || (peerId ? t("tasks.chapterMember") : null),
    };
  }, [data.member.chapterName, data.member.id, data.taskAssignees, presentedConfirmTask, t, taskMessages]);

  function toggleAssignee(personId) {
    setAssigneeFilter((current) => (current === personId ? null : personId));
  }

  // Chapter tasks the scope and filters keep off this view. The Report counts
  // every chapter task, so an empty list says these exist rather than that
  // there are none (REQ-UG-STALE-OR-CONTRADICTORY-STATE-AFTER-SAVE-20261030).
  const hiddenByFilters = tasks.length - filteredTasks.length;
  function showAllChapterTasks() {
    setScope("all");
    setPriority("all");
    setWorkstream("all");
    setAssigneeFilter(null);
    setSearch("");
  }
  const hiddenTasksNote = hiddenByFilters > 0 && filteredTasks.length === 0 ? <>
    <p>{hiddenByFilters === 1 ? t("tasks.emptyHiddenOne") : t("tasks.emptyHidden", { count: hiddenByFilters })}</p>
    <button type="button" onClick={showAllChapterTasks}>{t("tasks.showAllChapterTasks")}</button>
  </> : null;

  function clearFilters() {
    setScope("mine");
    setPriority("all");
    setWorkstream("all");
    setAssigneeFilter(null);
    setSearch("");
  }

  // The plane header's subline states only what is actually on screen: the
  // chapter, and the open count of the CURRENT filter. The report view runs
  // its own date window and its own totals, so the filter count is withheld
  // there rather than restated out of context.
  const chapterLabel = data.member.chapterName || t("tasks.chapter");
  const headerSub = desktopShell
    ? t("tasks.workSubtitle")
    : view === "report"
      ? chapterLabel
      : t("wtk.headerSub", { chapter: chapterLabel, count: summary.total - summary.done });

  return (
    <div
      className={desktopShell ? "screen tasks-screen tasks-screen--desktop-work" : "screen tasks-screen"}
      data-workspace-tasks={workspace ? "true" : undefined}
    >
      {/* Board moves, deletes and sends are announced here — the quick-action
          circle and the drag engine are pointer-first surfaces, and silence
          would be the only feedback a screen reader gets. */}
      <p className="visually-hidden" role="status" aria-live="polite">{liveMessage}</p>

      {/* Creation stays beside the work itself: each lane and every empty
          state owns a New task entrance, so the plane header carries no
          duplicate action. */}
      {/* Every mode draws a tab-level heading under the page heading; the two
          views with their own visible title supply it. */}
      <PlaneHeader title={workspace || desktopShell ? t("tasks.workTitle") : t("tasks.title")} sub={headerSub} />
      {!TITLED_VIEWS.has(view) ? <h2 className="visually-hidden">{t(`tasks.view.${view}`)}</h2> : null}

      {/* The t0ggles top bar: view pills, live search, member quick-filter,
          Filter and View-settings popovers. Desktop exposes the existing
          roving-focus/manual-activation keyboard model as a true tablist;
          the companion keeps its independent pressed-button group. */}
      <div ref={taskTopbarRef} className="kan-topbar">
        <div className="kan-topbar__primary">
          <div
            className="kan-views"
            role={desktopShell ? "tablist" : "group"}
            aria-label={t("tasks.views")}
            data-labels-visible={desktopShell ? String(desktopViewLabelsVisible) : undefined}
            style={{
              "--kan-view-index": viewIds.indexOf(view),
              // Eight desktop views must remain pointer-reachable beside the
              // dual rail at the 1024px desktop threshold. ResizeObserver
              // measures the toolbar's actual content box so classic scrollbar
              // gutters and either semantic rail width are already excluded,
              // without establishing containment around fixed popovers.
              "--kan-view-width": desktopShell
                ? `${desktopViewWidth}px`
                : wideBoard ? "100px" : "44px",
            }}
          >
            <i className="kan-views__indicator" aria-hidden="true" />
            {viewIds.map((id, index) => {
              const Icon = VIEW_ICONS[id];
              return (
                <RoutedTabLink group="tasks" value={id}
                  key={id}
                  type="button"
                  className="kan-pill"
                  ref={(node) => { viewButtonRefs.current[index] = node; }}
                  role={desktopShell ? "tab" : undefined}
                  aria-selected={desktopShell ? view === id : undefined}
                  aria-controls={desktopShell ? `tasks-panel-${id}` : undefined}
                  id={desktopShell ? `tasks-tab-${id}` : undefined}
                  aria-pressed={desktopShell ? undefined : view === id}
                  aria-label={t(`tasks.view.${id}`)}
                  tabIndex={focusedView === id ? 0 : -1}
                  onFocus={() => selectFocusedView(id)}
                  onKeyDown={(event) => handleViewKeyDown(event, index)}
                  onClick={() => activateView(id)}
                >
                  <Icon size={16} aria-hidden="true" />
                  {(desktopShell || wideBoard || workspace) && (
                    <span className="kan-pill__label">{t(`tasks.view.${id}`)}</span>
                  )}
                  {desktopShell && (
                    <span className="kan-pill__measure" aria-hidden="true">
                      {t(`tasks.view.${id}`)}
                    </span>
                  )}
                </RoutedTabLink>
              );
            })}
          </div>

          {nonReportChromePresence.mounted && (
            <div
              className="kan-topbar__context"
              data-state={nonReportChromePresence.phase}
              aria-hidden={nonReportChromePresence.closing || undefined}
              inert={nonReportChromePresence.closing ? true : undefined}
            >
            <label className="kan-search">
              <Search size={15} aria-hidden="true" />
              <span className="visually-hidden">{t("kanban.searchLabel")}</span>
              <input className="task-owned"
                ref={searchRef}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label={t("kanban.searchLabel")}
                placeholder={t("tasks.search")}
              />
              {characterKeysActive && <kbd className="kan-kbd" aria-hidden="true">/</kbd>}
            </label>
            </div>
          )}
        </div>

        <button
          type="button"
          className="kan-topbar__secondary-toggle"
          aria-expanded={mobileToolsOpen}
          aria-controls="tasks-secondary-tools"
          aria-label={mobileToolsOpen ? t("kanban.hideMoreTools") : t("kanban.showMoreTools")}
          onClick={() => setMobileToolsOpen((current) => !current)}
        >
          <ChevronDown size={18} aria-hidden="true" />
        </button>

        <div
          id="tasks-secondary-tools"
          className="kan-topbar__secondary"
          data-expanded={mobileToolsOpen}
          aria-hidden={compactToolbar && !mobileToolsOpen ? true : undefined}
          inert={compactToolbar && !mobileToolsOpen ? true : undefined}
        >
          {nonReportChromePresence.mounted && (
            <div
              className="kan-topbar__context"
              data-state={nonReportChromePresence.phase}
              aria-hidden={nonReportChromePresence.closing || undefined}
              inert={nonReportChromePresence.closing ? true : undefined}
            >

            {topMembers.length > 0 && (
              <div className="kan-avatars" role="group" aria-label={t("kanban.memberFilter")}>
                {/* The stylesheet's contract: the 44px hit target is the bare
                    button, the visible circle is the .kan-av inside it — the
                    pressed ring keys off that nesting. */}
                {topMembers.map((person) => (
                  <button
                    key={person.id}
                    type="button"
                    aria-pressed={assigneeFilter === person.id}
                    aria-label={person.fullName}
                    title={person.fullName}
                    onClick={() => toggleAssignee(person.id)}
                  >
                    <span className="kan-av" aria-hidden="true" data-glyph={initialsOf(person)} />
                  </button>
                ))}
                {overflowMembers.length > 0 && (
                  <div className="kan-pick">
                    <button
                      type="button"
                      aria-expanded={popover === "members"}
                      aria-label={t(overflowMembers.length === 1 ? "kanban.moreMembersOne" : "kanban.moreMembers", { count: overflowMembers.length })}
                      onClick={() => setPopover((current) => (current === "members" ? null : "members"))}
                    >
                      <span className="kan-av kan-more" aria-hidden="true">
                        {t("kanban.overflowMembers", { count: overflowMembers.length })}
                      </span>
                    </button>
                    <Popover open={popover === "members"} label={t("kanban.memberFilter")} className="kan-popover--members" onClose={() => setPopover(null)}>
                        <div className="kan-popover__members">
                          {memberFilterList.filter((person) => person.openCount > 0).map((person) => (
                            <button className="task-owned"
                              key={person.id}
                              type="button"
                              aria-pressed={assigneeFilter === person.id}
                              onClick={() => { toggleAssignee(person.id); setPopover(null); }}
                            >
                              <i className="kan-av" aria-hidden="true">{initialsOf(person)}</i>
                              <span className="task-owned">{person.fullName}</span>
                              <b className="task-owned">{person.openCount}</b>
                            </button>
                          ))}
                        </div>
                      </Popover>
                  </div>
                )}
              </div>
            )}

            <div className="kan-pick">
              <button
                type="button"
                className="kan-pill kan-pill--icon"
                aria-expanded={popover === "filter"}
                aria-label={t("kanban.filterTitle")}
                onClick={() => setPopover((current) => (current === "filter" ? null : "filter"))}
              >
                <Funnel size={16} aria-hidden="true" />
              </button>
              <Popover open={popover === "filter"} label={t("kanban.filterTitle")} className="kan-popover--filter" onClose={() => setPopover(null)}>
                  <div className="kan-popover__section">
                    <span className="kan-popover__label">{t("tasks.scope")}</span>
                    <div className="kan-chips" role="group" aria-label={t("tasks.scope")}>
                      {SCOPE_IDS.map((id) => (
                        <button className="task-owned" key={id} type="button" aria-pressed={scope === id} onClick={() => setScope(id)}>
                          {t(`tasks.scope.${id}`)} <b className="task-owned">{scopeCounts[id]}</b>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="kan-popover__section">
                    <span className="kan-popover__label">{t("tasks.priority")}</span>
                    <div className="kan-chips" role="group" aria-label={t("tasks.priority")}>
                      {PRIORITY_IDS.map((id) => (
                        <button className="task-owned" key={id} type="button" aria-pressed={priority === id} onClick={() => setPriority(id)}>
                          {id === "all" ? t("tasks.allPriorities") : t(`tasks.priority${id[0].toUpperCase()}${id.slice(1)}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="kan-popover__section">
                    <span className="kan-popover__label">{t("tasks.workstream")}</span>
                    <div className="kan-chips" role="group" aria-label={t("tasks.workstream")}>
                      <button className="task-owned" type="button" aria-pressed={workstream === "all"} onClick={() => setWorkstream("all")}>
                        {t("tasks.allWorkstreams")}
                      </button>
                      {workstreamNames.map((name) => (
                        <button className="task-owned" key={name} type="button" aria-pressed={workstream === name} onClick={() => setWorkstream(name)}>
                          {name}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button type="button" className="kan-popover__clear" onClick={clearFilters}>
                    {t("kanban.clearFilters")}
                  </button>
                </Popover>
            </div>
          </div>
          )}

          {/* Icon-sized like its Filter and View settings neighbours: a text
              pill here wraps the 1024px toolbar onto a second row that the
              trigger-anchored popovers then cover. */}
          {isStaff && onRenameWorkstream && (
            <button
              type="button"
              className="kan-pill kan-pill--icon"
              aria-label={t("tasks.workstreams")}
              title={t("tasks.workstreams")}
              onClick={(event) => {
                setPopover(null);
                wsTriggerRef.current = event.currentTarget;
                setWorkstreamsOpen(true);
              }}
            >
              <Columns3Cog size={16} aria-hidden="true" />
            </button>
          )}

          {isStaff && onCreateTaskFromTemplate && view !== "report" && (
            <button
              ref={templateTriggerRef}
              type="button"
              className="kan-pill task-template-open"
              onClick={() => { setPopover(null); setTemplateDialogOpen(true); }}
            >
              <LayoutTemplate size={16} aria-hidden="true" />
              <span>{t("taskTemplates.open")}</span>
            </button>
          )}

          <div className="kan-pick">
            <button
              ref={settingsTriggerRef}
              type="button"
              className="kan-pill kan-pill--icon"
              aria-expanded={popover === "settings"}
              aria-label={t("kanban.viewSettings")}
              onClick={() => setPopover((current) => (current === "settings" ? null : "settings"))}
            >
              <Settings2 size={16} aria-hidden="true" />
            </button>
            <Popover open={popover === "settings"} label={t("kanban.viewSettings")} className="kan-popover--settings" onClose={() => setPopover(null)}>
              <div className="kan-popover__row">
                <span>{t("kanban.displayDone")}</span>
                <Switch label={t("kanban.displayDone")} checked={doneVisible} onChange={setDoneVisible} />
              </div>
              <div className="kan-popover__row">
                <span>{t("kanban.characterShortcuts")}</span>
                <Switch label={t("kanban.characterShortcuts")} checked={characterKeysActive} disabled={!keyboardShortcutsOn} onChange={setCharacterShortcuts} />
              </div>
              {!keyboardShortcutsOn ? <p className="kan-popover__note">{t("keyboardShortcuts.offHint")}</p> : null}
              {/* Help stays reachable while the character keys are off. It
                  lives here, not in the toolbar, so the toolbar never wraps;
                  closing the sheet returns focus to the settings trigger. */}
              <div className="kan-popover__foot">
                <button type="button" className="kan-pill" onClick={() => openShortcuts(settingsTriggerRef.current)}>
                  <Keyboard size={16} aria-hidden="true" />
                  <span>{t("kanban.shortcutsTitle")}</span>
                </button>
              </div>
            </Popover>
          </div>
        </div>
      </div>

      {(view === "board" || view === "list") && (
        <p className="kan-swipe-hint"><ChevronRight size={15} aria-hidden="true" /> {t("kanban.swipeHint")}</p>
      )}

      {doneToast && (
        <div className="tasks-donetoast" role="status">
          <span>{t("tasks.doneToast")}</span>
          <button className="task-owned" type="button" onClick={undoDone}>{t("tasks.undo")}</button>
        </div>
      )}

      {error && <p className="tasks-error" role="alert">{error}</p>}

      <div
        key={view}
        className="kan-viewstage"
        data-view={view}
        id={desktopShell ? `tasks-panel-${view}` : undefined}
        role={desktopShell ? "tabpanel" : undefined}
        aria-labelledby={desktopShell ? `tasks-tab-${view}` : undefined}
        tabIndex={desktopShell ? 0 : undefined}
      >
      {view === "board" && workstreamNames.length > 0 && (
        <KanbanBoard
          tasks={filteredTasks}
          workstreamNames={workstreamNames}
          chapterId={chapterId}
          t={t}
          lang={lang}
          doneVisible={doneVisible}
          focusWorkstream={focusWorkstream}
          onFocusWorkstream={(name) => {
            setFocusWorkstream(name);
            setLiveMessage(name ? t("kanban.focusedOn", { name }) : t("kanban.exitFocus"));
          }}
          onOpenTask={(task) => openTaskModal(task)}
          onCycleStatus={cycleStatus}
          onDropTask={dropOnBoard}
          onCreateInline={createInline}
          onReorder={reorderTask}
          depCounts={depCounts}
          subtaskCounts={subtaskCounts}
          commentCounts={commentCounts}
          attachmentCounts={attachmentCounts}
          liveAnnounce={setLiveMessage}
        />
      )}
      {view === "board" && workstreamNames.length === 0 && (
        <div className="tasks-empty">
          <p>{unfiltered ? t("tasks.emptyMine") : t("tasks.empty")}</p>
          {isStaff && onAddWorkstream ? (
            <div className="kan-firstws">
              <label>
                <span className="visually-hidden">{t("tasks.workstreamName")}</span>
                <input className="task-owned"
                  value={firstWorkstream}
                  onChange={(event) => { setFirstWorkstream(event.target.value); setError(""); }}
                  placeholder={t("tasks.workstreamName")}
                  maxLength={60}
                />
              </label>
              <BusyButton className="task-owned" type="button" onClick={addFirstWorkstream} pending={firstWorkstreamBusy} disabled={!firstWorkstream.trim()}>
                {t("tasks.workstreamSave")}
              </BusyButton>
            </div>
          ) : (
            <button type="button" onClick={openDefaultComposer}>{t("tasks.new")}</button>
          )}
        </div>
      )}

      {!desktopViewOwnsEmptyState && view !== "report" && view !== "board" && view !== "calendar" && view !== "deadlines" && view !== "field_notes" && filteredTasks.length === 0 && (
        <div className="tasks-empty">
          <p>{unfiltered ? t("tasks.emptyMine") : t("tasks.empty")}</p>
          {hiddenTasksNote}
          <button type="button" onClick={openDefaultComposer}>{t("tasks.new")}</button>
        </div>
      )}
      {view === "list" && (desktopShell || filteredTasks.length > 0) && (
        <KanbanList
          tasks={filteredTasks}
          emptyNote={hiddenTasksNote}
          workstreamNames={workstreamNames}
          chapterId={chapterId}
          t={t}
          lang={lang}
          doneVisible={doneVisible}
          onOpenTask={(task) => openTaskModal(task)}
          onCycleStatus={cycleStatus}
          onCreateInline={createInline}
          onCreateDefault={desktopShell ? openDefaultComposer : undefined}
          depCounts={depCounts}
          subtaskCounts={subtaskCounts}
          desktopWork={desktopShell}
        />
      )}

      {view === "calendar" && (
        <KanbanCalendar
          tasks={filteredTasks}
          chapterId={chapterId}
          t={t}
          lang={lang}
          onOpenTask={(task) => openTaskModal(task)}
          onUpdate={updateTask}
          onCreateDate={createCalendarItem}
          liveAnnounce={setLiveMessage}
          desktopWork={desktopShell}
        />
      )}
      {view === "timeline" && desktopShell && (
        <TaskDesktopTimeline
          tasks={filteredTasks}
          chapterId={chapterId}
          t={t}
          lang={lang}
          onOpenTask={(task) => openTaskModal(task)}
          onUpdateTask={updateTask}
          onCreateDefault={openDefaultComposer}
        />
      )}
      {view === "timeline" && !desktopShell && filteredTasks.length > 0 && (
        <TimelineView
          tasks={filteredTasks}
          lang={lang}
          t={t}
          onEdit={(task) => openTaskModal(task)}
          onUpdate={updateTask}
        />
      )}
      {(desktopShell || workspace) && view === "deadlines" && (
        <TaskDeadlinesView
          tasks={filteredTasks}
          chapterId={chapterId}
          doneVisible={doneVisible}
          lang={lang}
          t={t}
          onOpen={(task) => openTaskModal(task)}
          onCreate={openDefaultComposer}
        />
      )}
      {(desktopShell || workspace) && view === "field_notes" && (
        <TaskFieldNotesView
          tasks={filteredTasks}
          comments={data.taskComments || []}
          commentsUnavailable={demo ? false : data.taskCommentsUnavailable !== false}
          commentsTruncated={demo ? false : data.taskCommentsTruncated === true}
          assignees={data.taskAssignees || []}
          memberId={data.member.id}
          chapterId={chapterId}
          doneVisible={doneVisible}
          demo={demo}
          lang={lang}
          t={t}
          onOpen={(task) => openTaskModal(task)}
          onCreate={openDefaultComposer}
          onAddComment={onAddTaskComment}
          packet={fieldNotesPacket}
        />
      )}
      {filteredTasks.length > 0 && view === "progress" && (
        <>
          <p className="tasks-window-label">{t("tasks.progressNote")}</p>
          <ProgressView tasks={filteredTasks} t={t} summary={progressSummary(filteredTasks)} />
        </>
      )}
      {view === "report" && (
        <TasksReport
          t={t}
          lang={lang}
          chapterName={data.member.chapterName || t("tasks.chapter")}
          onLoadReport={onLoadReport}
        />
      )}
      </div>

      {modalPresence.mounted && modalTask && (
        <TaskModal
          // Keyed by the task: navigating to another card (dependency rows,
          // duplicate) REMOUNTS the modal, so a typed-but-unsent comment can
          // never ride along and send against the wrong task, and focus
          // re-enters the dialog instead of dropping to <body>.
          key={modalTask.id}
          task={modalTask}
          automationLink={renderAutomationLink?.(modalTask.id)}
          connectedActions={renderConnectedActions?.(modalTask)}
          renderConnectedMessageActions={renderConnectedMessageActions}
          onOpenSourceRecord={onOpenSourceRecord}
          chapterId={chapterId}
          assignees={data.taskAssignees || []}
          templateReviewers={data.taskTemplateReviewers || []}
          documents={data.product?.documents || []}
          workstreamNames={workstreamNames}
          t={t}
          lang={lang}
          memberId={data.member.id}
          messages={taskMessages}
          comments={(data.taskComments || []).filter((comment) =>
            comment.taskId === modalTask.id && comment.chapterId === chapterId)}
          commentsUnavailable={!demo && data.taskCommentsUnavailable !== false}
          commentsTruncated={!demo && data.taskCommentsTruncated === true}
          attachments={(data.taskAttachments || []).filter((attachment) => attachment.taskId === modalTask.id)}
          files={(data.taskFiles || []).filter((file) => file.taskId === modalTask.id)}
          activity={(data.taskActivity || []).filter((entry) => entry.taskId === modalTask.id)}
          creatorName={(data.taskAssignees || []).find((person) => person.id === modalTask.createdBy)?.fullName || t("tasks.chapterMember")}
          onClose={closeTaskModal}
          onUpdate={(patch, contentVersion) => updateTask(modalTask.id, patch, contentVersion)}
          getAuthoritativeTask={() => authoritativeTask(modalTask.id)}
          onWriteError={setError}
          onSetAssignees={onSetTaskAssignees}
          onDelete={canDelete(modalTask) ? () => openDeleteConfirm(modalTask) : null}
          onSendMessage={sendMessage}
          onAddComment={onAddTaskComment}
          onAddAttachment={onAddTaskAttachment}
          onRemoveAttachment={onRemoveTaskAttachment}
          onAddFile={(file, options) => onAddTaskFile(modalTask.id, file, options)}
          onRemoveFile={onRemoveTaskFile}
          onOpenFile={onOpenTaskFile}
          onRecheckFile={onRecheckTaskFile}
          onAssignFocus={assignFocus}
          tasks={relationTasks}
          dependencies={liveDependencies}
          onAddDependency={onAddTaskDependency}
          onRemoveDependency={onRemoveTaskDependency}
          onOpenTask={(task) => openTaskModal(task)}
          onDuplicate={modalTask.taskType === "general" ? duplicateTask : null}
          subtasks={liveSubtasks}
          watches={data.taskWatches || []}
          onCreateSubtask={onCreateTaskSubtask}
          onRemoveSubtask={onRemoveTaskSubtask}
          onUpdateSubtask={(taskId, patch) => updateTask(taskId, patch)}
          onWatch={onWatchTask}
          onUnwatch={onUnwatchTask}
          onAnnounce={setLiveMessage}
          parentError={error}
          liveMessage={liveMessage}
          deleteBusy={pendingDeleteTask?.id === modalTask.id}
          template={(data.taskTemplates || []).find((item) => item.key === modalTask.taskType) || null}
          templateDetails={(data.taskTemplateDetails || []).find((item) => item.taskId === modalTask.id) || null}
          checkoffClient={demo ? null : checkoffClient}
          onUpdateTemplateDetails={onUpdateTaskTemplateDetails ? updateTemplateDetails : null}
          templates={data.taskTemplates || []}
          onConvertType={onConvertTaskToTemplate ? (conversion) => convertTaskType(modalTask.id, conversion) : null}
          onUseTemplate={onCreateTaskFromTemplate ? () => {
            closeTaskModal();
            window.setTimeout(() => setTemplateDialogOpen(true), DETAIL_SURFACE_EXIT_MS);
          } : null}
          presenceState={modalPresence.phase}
          onPresenceTransitionEnd={modalPresence.onTransitionEnd}
          // Whole-board counts, not the filtered view: the status picker's
          // numbers answer "how much work sits in each state", and a scoped
          // filter shrinking them would misread as work disappearing.
          statusCounts={Object.fromEntries(STATUS_IDS.map((status) => [status, tasks.filter((task) => task.status === status).length]))}
        />
      )}

      {templateExit.shown && (
        <TaskTemplateDialog
          unitSettingsApi={unitSettingsApi}
          unitSettingsMember={data.member}
          unitSettingsScope={`${data.member?.id}:${data.member?.chapterId}:${data.member?.organizationId}`}
          templates={data.taskTemplates || []}
          workstreams={workstreamNames}
          assignees={data.taskTemplateReviewers || []}
          lang={lang}
          t={t}
          onClose={() => setTemplateDialogOpen(false)}
          onCreate={createFromTemplate}
          returnFocusRef={templateTriggerRef}
          closing={templateExit.closing}
          onTransitionEnd={templateExit.onTransitionEnd}
        />
      )}

      {confirmPresence.mounted && presentedConfirmTask && deleteContext && (
        <div
          ref={confirmBackdropRef}
          className="task-editor-backdrop"
          role="presentation"
          data-state={confirmPresence.phase}
          onTransitionEnd={confirmPresence.onTransitionEnd}
          onMouseDown={(event) => event.target === event.currentTarget && !confirmPresence.closing && setConfirmTask(null)}
        >
          <section ref={confirmDialogRef} className="task-confirm" role="alertdialog" aria-modal="true" aria-labelledby="task-confirm-title" aria-describedby="task-confirm-body" tabIndex={-1}>
            <p className="visually-hidden" role="status" aria-live="polite">{liveMessage}</p>
            <h2 id="task-confirm-title">{t("tasks.deleteTitle", { title: presentedConfirmTask.title })}</h2>
            <div id="task-confirm-body">
              <p>{t("tasks.deleteScope", { chapter: deleteContext.chapter })}</p>
              {deleteContext.count > 0 && <p>{t("tasks.deleteMessagesKept", { count: deleteContext.count })}</p>}
              {deleteContext.name && <p>{t("tasks.deleteNotifies", { name: deleteContext.name })}</p>}
              <p>{t("tasks.deleteRecoverable")}</p>
            </div>
            <footer>
              {/* The safe path is first, and it is a decision, not a cancel. */}
              <button type="button" className="task-confirm__keep" autoFocus disabled={confirmPresence.closing} onClick={() => setConfirmTask(null)}>{t("tasks.deleteKeep")}</button>
              <button type="button" className="task-editor__delete" disabled={confirmPresence.closing} onClick={confirmRemove}><Trash2 size={16} /> {t("tasks.removeIt")}</button>
            </footer>
          </section>
        </div>
      )}

      {workstreamsOpen && (
        <WorkstreamSettings
          t={t}
          workstreams={workstreamEntities}
          tasks={tasks}
          onClose={() => {
            setWorkstreamsOpen(false);
            const trigger = wsTriggerRef.current;
            wsTriggerRef.current = null;
            window.setTimeout(() => trigger?.focus?.(), 0);
          }}
          onRename={onRenameWorkstream}
          onPreviewMerge={onPreviewMergeWorkstreams}
          onMerge={onMergeWorkstreams}
        />
      )}

      {shortcutsExit.shown && (
        // The sheet reuses .kan-modal-backdrop as its scrim (the stylesheet
        // and motion.css both count on ONE overlay class), and the panel is
        // the .kan-shortcuts card itself.
        <div
          ref={shortcutsBackdropRef}
          className="kan-modal-backdrop"
          role="presentation"
          data-state={shortcutsExit.state}
          onTransitionEnd={shortcutsExit.onTransitionEnd}
          onMouseDown={(event) => {
            if (event.target !== event.currentTarget) return;
            event.preventDefault();
            if (!shortcutsExit.closing) setShortcutsOpen(false);
          }}
        >
          <section className="kan-shortcuts" role="dialog" aria-modal="true" aria-labelledby="kan-shortcuts-title">
            <header className="task-owned">
              <h2 className="kan-shortcuts-title" id="kan-shortcuts-title">{t("kanban.shortcutsTitle")}</h2>
              <button type="button" className="kan-iconbtn" autoFocus onClick={() => { if (!shortcutsExit.closing) setShortcutsOpen(false); }} aria-label={t("tasks.close")}><X size={18} /></button>
            </header>
            <p>{t(!keyboardShortcutsOn ? "keyboardShortcuts.offHint" : characterShortcutsEnabled ? "kanban.characterShortcutsOn" : "kanban.characterShortcutsOff")}</p>
            {/* Key names inside the keycaps (Ctrl, Shift, Enter…) are keyboard
                identity, not copy — they stay literal in both languages. The
                board-wide keys are listed only while Keyboard shortcuts is on;
                the card keys below are the card's own keyboard operation. */}
            {keyboardShortcutsOn ? <dl className="task-owned">
              <div className="task-owned"><dt className="task-owned"><kbd className="kan-kbd">/</kbd></dt><dd className="task-owned">{t("kanban.shortcut.search")}</dd></div>
              <div className="task-owned"><dt className="task-owned"><kbd className="kan-kbd">c</kbd></dt><dd className="task-owned">{t("kanban.shortcut.create")}</dd></div>
              <div className="task-owned">
                <dt className="task-owned">
                  <kbd className="kan-kbd">Ctrl</kbd>+<kbd className="kan-kbd">Shift</kbd>+
                  {desktopShell
                    ? DESKTOP_VIEW_HELP_KEYS.map((key) => <kbd className="kan-kbd" key={key}>{key}</kbd>)
                    : <><kbd className="kan-kbd">B</kbd>…<kbd className="kan-kbd">R</kbd></>}
                </dt>
                <dd className="task-owned">{t("kanban.shortcut.views")}</dd>
              </div>
              <div className="task-owned"><dt className="task-owned"><kbd className="kan-kbd">Ctrl</kbd>+<kbd className="kan-kbd">1</kbd>–<kbd className="kan-kbd">9</kbd></dt><dd className="task-owned">{t("kanban.shortcut.focus")}</dd></div>
            </dl> : null}
            <h3 className="task-owned">{t("kanban.shortcut.card")}</h3>
            <dl className="task-owned">
              <div className="task-owned"><dt className="task-owned"><kbd className="kan-kbd">Enter</kbd>/<kbd className="kan-kbd">e</kbd></dt><dd className="task-owned">{t("kanban.shortcut.open")}</dd></div>
              <div className="task-owned"><dt className="task-owned"><kbd className="kan-kbd">x</kbd></dt><dd className="task-owned">{t("kanban.shortcut.done")}</dd></div>
              <div className="task-owned"><dt className="task-owned"><kbd className="kan-kbd">[</kbd>/<kbd className="kan-kbd">]</kbd></dt><dd className="task-owned">{t("kanban.shortcut.status")}</dd></div>
              <div className="task-owned"><dt className="task-owned"><kbd className="kan-kbd">Alt</kbd>+<kbd className="kan-kbd">↑</kbd>/<kbd className="kan-kbd">↓</kbd></dt><dd className="task-owned">{t("kanban.shortcut.reorder")}</dd></div>
              <div className="task-owned"><dt className="task-owned"><kbd className="kan-kbd">Alt</kbd>+<kbd className="kan-kbd">←</kbd>/<kbd className="kan-kbd">→</kbd></dt><dd className="task-owned">{t("kanban.shortcut.reschedule")}</dd></div>
            </dl>
          </section>
        </div>
      )}
    </div>
  );
}

// The Progress view still wants the old wide summary; it is computed here, on
// demand, instead of on every render of the board the tiles no longer sit on.
function progressSummary(filteredTasks) {
  const open = filteredTasks.filter((task) => task.status !== "done");
  return {
    total: filteredTasks.length,
    done: filteredTasks.filter((task) => task.status === "done").length,
    inProgress: filteredTasks.filter((task) => task.status === "in_progress").length,
    blocked: filteredTasks.filter((task) => task.blocked).length,
    overdue: filteredTasks.filter((task) => isTaskOverdue(task)).length,
    progress: average(open.length ? open.map((task) => task.progress) : filteredTasks.map((task) => task.progress)),
  };
}

function TimelineView({ tasks, lang, t, onEdit, onUpdate }) {
  const [windowStart, setWindowStart] = useDeviceParityState("tasks.timeline.windowStart", () => {
    const current = new Date();
    current.setHours(12, 0, 0, 0);
    current.setDate(current.getDate() - ((current.getDay() + 6) % 7));
    return isoDate(current);
  });
  const dayCount = 28;
  const dates = Array.from({ length: dayCount }, (_, index) => addDays(windowStart, index));
  // Task dates reach the strict helpers only through taskDateSpan, which fails
  // closed (null) on a malformed or inverted key instead of throwing and
  // unmounting the whole Tasks screen. TaskDesktopTimeline reads the same two
  // fields the same way, so an underivable row drops out of this layout exactly
  // as it already drops out of the desktop one.
  const scheduledTasks = tasks
    .map((task) => ({ task, span: taskDateSpan(task) }))
    .filter((row) => row.span !== null);

  async function shiftTask(task, span, amount) {
    try {
      const patch = {};
      if (task.startDate) patch.startDate = addDays(span.startDate, amount);
      if (task.dueDate) patch.dueDate = addDays(span.endDate, amount);
      await onUpdate(task.id, patch);
    } catch {
      // Parent owns rollback and error.
    }
  }

  return (
    <section className="tasks-timeline" aria-label={t("tasks.view.timeline")}>
      <header className="tasks-period-header">
        <button className="task-owned" type="button" onClick={() => setWindowStart(addDays(windowStart, -14))} aria-label={t("tasks.earlier")}><ChevronLeft size={18} /></button>
        <strong className="task-owned">{formatShortDate(windowStart, lang)} – {formatShortDate(addDays(windowStart, dayCount - 1), lang)}</strong>
        <button className="task-owned" type="button" onClick={() => setWindowStart(addDays(windowStart, 14))} aria-label={t("tasks.later")}><ChevronRight size={18} /></button>
      </header>
      <div className="tasks-timeline__scroll">
        <div className="tasks-timeline__canvas">
          <div className="timeline-header-row">
            <div>{t("tasks.task")}</div>
            <div className="timeline-days">
              {dates.map((date, index) => <span key={date} className={index % 7 === 0 ? "is-week" : ""}>{index % 7 === 0 ? formatShortDate(date, lang) : localDate(date).getDate()}</span>)}
            </div>
          </div>
          {scheduledTasks.map(({ task, span }) => {
            const taskStart = span.startDate;
            const taskEnd = span.endDate;
            const milestoneOffset = task.milestone && task.dueDate ? daysBetween(windowStart, span.endDate) : -1;
            const leftDays = daysBetween(windowStart, taskStart);
            const duration = Math.max(daysBetween(taskStart, taskEnd) + 1, 1);
            const visibleStart = Math.max(leftDays, 0);
            const visibleEnd = Math.min(leftDays + duration, dayCount);
            const visibleWidth = Math.max(visibleEnd - visibleStart, 0);
            return (
              <div className="timeline-row" key={task.id}>
                <div className="timeline-row__label">
                  <button type="button" onClick={() => onEdit(task)}><strong>{task.title}</strong>{task.unitName && <span>{task.unitName}</span>}<span>{task.assigneeName || t("tasks.unassigned")}</span></button>
                  <span className="timeline-row__shift">
                    <button type="button" onClick={() => shiftTask(task, span, -1)} aria-label={t("tasks.shiftEarlier", { task: task.title })}>−1</button>
                    <button type="button" onClick={() => shiftTask(task, span, 1)} aria-label={t("tasks.shiftLater", { task: task.title })}>+1</button>
                  </span>
                </div>
                <div className="timeline-track">
                  {/* Week and day rules are paint, not content. Unmarked they
                      entered the acceptance audit as visible elements and
                      collided with every bar crossing them. */}
                  {dates.map((date, index) => <i key={date} className={index % 7 === 0 ? "is-week" : ""} aria-hidden="true" />)}
                  {visibleWidth === 0 && (
                    <span className="timeline-outside">{t("tasks.outsideWindow", { date: formatShortDate(taskStart, lang) })}</span>
                  )}
                  {visibleWidth > 0 && (
                    <button
                      type="button"
                      className={`timeline-bar timeline-bar--${task.status}`}
                      style={{ "--timeline-start": `${(visibleStart / dayCount) * 100}%`, width: `${(visibleWidth / dayCount) * 100}%` }}
                      onClick={() => onEdit(task)}
                      title={`${task.title}: ${task.progress}%`}
                      aria-label={`${task.title}, ${t("tasks.progressValue", { value: task.progress })}`}
                    >
                      <span style={{ width: `${task.progress}%` }} />
                      <b>{task.progress}%</b>
                    </button>
                  )}
                  {milestoneOffset >= 0 && milestoneOffset < dayCount && (
                    <Flag className="timeline-milestone" size={16} style={{ left: `${((milestoneOffset + 0.5) / dayCount) * 100}%` }} aria-label={t("tasks.milestone")} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <p className="tasks-timeline__hint">{t("tasks.timelineHint")}</p>
    </section>
  );
}

function ProgressView({ tasks, t, summary }) {
  const unassigned = t("tasks.unassigned");
  const people = new Map();
  for (const task of tasks) {
    const active = task.status !== "done";
    for (const person of assigneesFor(task, unassigned)) {
      let row = people.get(person.id);
      if (!row) {
        row = { id: person.id, name: person.name, tasks: [] };
        people.set(person.id, row);
      }
      if (active && !row.tasks.includes(task)) row.tasks.push(task);
    }
  }
  const byAssignee = [...people.values()]
    .map((person) => ({
      id: person.id,
      name: person.name,
      count: person.tasks.length,
      blocked: person.tasks.filter((task) => task.blocked).length,
      progress: average(person.tasks.map((task) => task.progress)),
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)));
  const byWorkstream = [...new Set(tasks.map((task) => task.workstream))]
    .map((name) => {
      const rows = tasks.filter((task) => task.workstream === name);
      return { name, count: rows.length, done: rows.filter((task) => task.status === "done").length, progress: average(rows.map((task) => task.progress)) };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return (
    <section className="tasks-progress-view" aria-label={t("tasks.view.progress")}>
      <div className="tasks-progress-hero">
        <div
          className="tasks-progress-ring"
          role="progressbar"
          aria-label={t("tasks.overall")}
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={summary.progress}
          style={{ "--task-progress": `${summary.progress * 3.6}deg` }}
        >
          <i className="tasks-progress-ring__art" aria-hidden="true" />
          <span><strong className="task-owned">{summary.progress}%</strong><small className="task-owned">{t("tasks.overall")}</small></span>
        </div>
        <div>
          <span className="eyebrow">{t("tasks.deliveryHealth")} · {t("tasks.window60")}</span>
          <h3 className="task-owned">{summary.done} / {summary.total} {t("tasks.complete")}</h3>
          <p className="task-owned">{summary.overdue === 1 ? t("tasks.overdueOne") : summary.overdue > 1 ? t("tasks.overdueCount", { count: summary.overdue }) : t("tasks.onSchedule")}</p>
        </div>
      </div>

      <div className="tasks-progress-grid">
        <ProgressMetric label={t("tasks.status.done")} value={summary.done} total={summary.total} tone="done" />
        <ProgressMetric label={t("tasks.status.needs_review")} value={tasks.filter((task) => task.status === "needs_review").length} total={summary.total} tone="review" />
        <ProgressMetric label={t("tasks.metricBlocked")} value={summary.blocked} total={summary.total} tone="blocked" />
        <ProgressMetric label={t("tasks.metricOverdue")} value={summary.overdue} total={summary.total} tone="overdue" />
      </div>

      <section className="tasks-breakdown">
        <header><h4>{t("tasks.byWorkstream")}</h4><span>{t("tasks.progress")}</span></header>
        {byWorkstream.map((item) => (
          <div className="tasks-breakdown__row" key={item.name}>
            <span><strong>{item.name}</strong><small>{item.done}/{item.count} {t("tasks.complete")}</small></span>
            <i role="progressbar" aria-label={item.name} aria-valuemin="0" aria-valuemax="100" aria-valuenow={item.progress}><span style={{ width: `${item.progress}%` }} /></i>
            <b aria-hidden="true">{item.progress}%</b>
          </div>
        ))}
      </section>

      <section className="tasks-breakdown">
        <header><h4>{t("tasks.workload")}</h4><span>{t("tasks.active")}</span></header>
        {byAssignee.map((item) => (
          <div className="tasks-breakdown__row tasks-breakdown__row--person" key={item.id ?? "unassigned"}>
            <span className="tasks-person"><i>{item.name.slice(0, 2).toUpperCase()}</i><span><strong>{item.name}</strong><small>{item.progress}% {t("tasks.averageProgress")}</small></span></span>
            <b>{item.count}{item.blocked > 0 && <em title={t("tasks.blockedCount", { count: item.blocked })}>{item.blocked}!</em>}</b>
          </div>
        ))}
      </section>
    </section>
  );
}

function ProgressMetric({ label, value, total, tone }) {
  const percent = total ? Math.round((value / total) * 100) : 0;
  return (
    <article className={`tasks-progress-metric tasks-progress-metric--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <i role="progressbar" aria-label={label} aria-valuemin="0" aria-valuemax="100" aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></i>
    </article>
  );
}

// The historical export: orderBetween moved to the pure helper module with the
// board inversion, and callers (and old test imports) keep this path alive.
export { orderBetween } from "../lib/kanban.js";
