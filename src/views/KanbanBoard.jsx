import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BusyInput } from "../components/BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  Crosshair,
  Flag,
  MessageCircle,
  Paperclip,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { PracticeMarker } from "../features/learningPeriod/LearningPeriod.jsx";
import {
  STATUS_IDS,
  byBoardOrder,
  checklistBadge,
  groupBoardTasks,
  statusCycle,
  workstreamColorIndex,
} from "../lib/kanban.js";
import { localeFor } from "../lib/i18n.js";
import { localDateKey as isoDate, parseLocalDateKey as localDate } from "../lib/taskSchedule.js";
import { limitTaskTitle } from "../lib/taskTitle.js";

// The t0ggles inversion: columns are WORKSTREAMS, status is card color, and
// cards auto-group by status inside each column. The drag engine is pointer
// events, not HTML5 dnd — HTML5 drag never fires on touch, which is exactly
// why the old board had to fall back to a "Move to {status}" select. One
// engine now serves mouse, pen and touch.

// Lift thresholds. A mouse/pen drag starts after 6px of travel so a plain
// click never lifts; touch waits out a 250ms hold so column scrolling stays a
// scroll. Exported because the compact-board test pins the touch contract.
export const DRAG_LIFT_PX = 6;
export const TOUCH_HOLD_MS = 250;
// A touch that travels this far BEFORE the hold elapses is a scroll, not a
// drag — cancel the pending lift instead of fighting the pan.
const TOUCH_SLOP_PX = 10;
// Edge auto-scroll: nudge the board while the pointer rides within 48px of
// either edge. Rects are re-snapshotted after every real scroll step because
// the cached geometry is viewport-relative and just moved under the pointer.
const EDGE_SCROLL_PX = 48;
const EDGE_SCROLL_STEP = 14;
// A drop in the 32px gutter between columns should land in the nearest
// column, but a drop far outside the board is an abort, not a guess. Half a
// column pitch on either side is the widest forgiving reach.
const COLUMN_SNAP_SLACK = 160;
// Insert-line geometry: half the 16px card gap centers the line in a gap; an
// empty column draws it just under the top composer row.
const INSERT_GAP_HALF = 8;
const INSERT_EMPTY_OFFSET = 56;

// Checked at lift time, in this file by design: the clone's scale-up is a
// motion flourish, and matchMedia is the only signal jsdom can fake cheaply.
function prefersReducedMotion() {
  try {
    return typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function plainRect(rect) {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

// ALL DOM measurement lives here; everything downstream works on the plain
// snapshot. jsdom reports every rect as 0×0, so the hit-test itself must
// never touch the DOM — tests feed computeDropTarget fixture rects instead.
// Cards carry data-status, so status groups are recovered as consecutive
// same-status runs; the dragged card is excluded because the ghost holds its
// space but must never be its own drop anchor.
function collectRects(boardEl, draggedId) {
  const columns = [];
  if (!boardEl) return { draggedId, columns };
  for (const colEl of boardEl.querySelectorAll(".kan-col")) {
    const workstream = colEl.dataset.workstream || null;
    const status = colEl.dataset.status || null;
    const listEl = colEl.querySelector(".kan-col__list");
    const groups = [];
    for (const cardEl of colEl.querySelectorAll("[data-task-id]")) {
      if (cardEl.dataset.taskId === draggedId) continue;
      const card = { id: cardEl.dataset.taskId, rect: plainRect(cardEl.getBoundingClientRect()) };
      const cardStatus = cardEl.dataset.status || status;
      const last = groups[groups.length - 1];
      if (last && last.status === cardStatus) {
        last.cards.push(card);
        last.rect.top = Math.min(last.rect.top, card.rect.top);
        last.rect.bottom = Math.max(last.rect.bottom, card.rect.bottom);
      } else {
        groups.push({ status: cardStatus, cards: [card], rect: { ...card.rect } });
      }
    }
    columns.push({
      key: workstream ?? `status:${status}`,
      workstream,
      status,
      rect: plainRect(colEl.getBoundingClientRect()),
      listRect: listEl ? plainRect(listEl.getBoundingClientRect()) : plainRect(colEl.getBoundingClientRect()),
      groups,
    });
  }
  return { draggedId, columns };
}

// The pure hit-test. Column by horizontal nearness (gutter drops snap to the
// closest column, far-outside drops return null = abort); group by vertical
// containment — a drop in a different status GROUP adopts that group's
// status, which is how board-mode drag changes status (reference §12.1). A
// column with no cards yields status null in board mode, meaning "keep the
// card's own status": there is no group region to adopt from. `beforeId` is
// the card the drop lands above, null for end-of-group.
export function computeDropTarget(rects, point) {
  const columns = rects?.columns || [];
  if (!columns.length || !point) return null;
  let col = null;
  let best = Infinity;
  for (const candidate of columns) {
    const distance = Math.max(candidate.rect.left - point.x, point.x - candidate.rect.right, 0);
    if (distance < best) {
      best = distance;
      col = candidate;
    }
  }
  if (!col || best > COLUMN_SNAP_SLACK) return null;
  let group = null;
  for (const candidate of col.groups) {
    if (point.y <= candidate.rect.bottom) {
      group = candidate;
      break;
    }
  }
  if (!group) group = col.groups[col.groups.length - 1] || null;
  const cards = group ? group.cards : [];
  let index = 0;
  for (const card of cards) {
    if (point.y > (card.rect.top + card.rect.bottom) / 2) index += 1;
    else break;
  }
  return {
    colKey: col.key,
    workstream: col.workstream,
    status: group ? group.status : col.status,
    index,
    beforeId: cards[index]?.id ?? null,
  };
}

// Where the lime line goes, in column-list coordinates — pure, same snapshot.
function computeInsertLine(rects, target) {
  if (!rects || !target) return null;
  const col = (rects.columns || []).find((candidate) => candidate.key === target.colKey);
  if (!col) return null;
  const group = col.groups.find((candidate) => candidate.status === target.status) || null;
  let y;
  if (group && group.cards.length) {
    y = target.index < group.cards.length
      ? group.cards[target.index].rect.top - INSERT_GAP_HALF
      : group.cards[group.cards.length - 1].rect.bottom + INSERT_GAP_HALF;
  } else {
    y = col.listRect.top + INSERT_EMPTY_OFFSET;
  }
  return { colKey: col.key, top: y - col.listRect.top };
}

export function KanbanBoard({
  tasks,
  workstreamNames,
  chapterId,
  t,
  lang,
  doneVisible,
  focusWorkstream,
  onFocusWorkstream,
  onOpenTask,
  onCycleStatus,
  onDropTask,
  onCreateInline,
  onReorder,
  depCounts = null,
  subtaskCounts = null,
  commentCounts = null,
  attachmentCounts = null,
  liveAnnounce,
}) {
  const boardRef = useRef(null);
  const sessionRef = useRef(null);
  const cloneRef = useRef(null);
  const clonePosRef = useRef({ x: 0, y: 0 });
  // Only an explicit hidden-done click arms this. Initial mount and a
  // doneVisible settings change must not move keyboard focus.
  const pendingRevealFocusRef = useRef(null);
  // Column lists by column key, held in refs rather than a DOM attribute so
  // the reveal-focus lookup adds nothing to the board's markup.
  const listRefs = useRef(new Map());
  const listRef = (colKey) => (node) => {
    if (node) listRefs.current.set(colKey, node);
    else listRefs.current.delete(colKey);
  };
  const [drag, setDrag] = useState(null);
  const [insert, setInsert] = useState(null);
  // "N done hidden" reveals are per-column and per-visit: the set clears when
  // the view setting turns done cards back on, so the next hide starts clean.
  const [revealed, setRevealed] = useDeviceParityState("tasks.board.revealedDone", () => new Set());
  useEffect(() => {
    if (doneVisible) setRevealed(new Set());
  }, [doneVisible, setRevealed]);

  // The hidden-done button unmounts as soon as the group appears, which would
  // drop focus onto document.body. Restore it onto the first revealed card
  // before paint so the caret never lands on the page.
  useLayoutEffect(() => {
    const colKey = pendingRevealFocusRef.current;
    if (!colKey) return;
    pendingRevealFocusRef.current = null;
    const listEl = listRefs.current.get(colKey);
    const firstRevealed = listEl?.querySelector("[data-task-id][data-status='done']")
      || listEl?.querySelector("[data-task-id]");
    firstRevealed?.focus?.();
  }, [revealed]);

  // A drag that outlives the component (view switch mid-drag) must not leave
  // window listeners or the body's kan-dragging class behind.
  useEffect(() => () => sessionRef.current?.cleanup?.(), []);

  const boardColumns = useMemo(
    () => (focusWorkstream ? null : groupBoardTasks(tasks, workstreamNames)),
    [focusWorkstream, tasks, workstreamNames],
  );
  const focusColumns = useMemo(() => {
    if (!focusWorkstream) return null;
    const scoped = tasks.filter((task) => task.workstream === focusWorkstream);
    return STATUS_IDS.map((status) => ({
      status,
      tasks: scoped.filter((task) => task.status === status).sort(byBoardOrder),
    }));
  }, [focusWorkstream, tasks]);

  function reveal(colKey) {
    pendingRevealFocusRef.current = colKey;
    setRevealed((current) => {
      const next = new Set(current);
      next.add(colKey);
      return next;
    });
  }

  function positionClone(session) {
    clonePosRef.current = { x: session.last.x - session.dx, y: session.last.y - session.dy };
    if (cloneRef.current) {
      cloneRef.current.style.transform = `translate(${clonePosRef.current.x}px, ${clonePosRef.current.y}px)`;
    }
  }

  function retarget(session) {
    const target = computeDropTarget(session.rects, session.last);
    session.target = target;
    const line = computeInsertLine(session.rects, target);
    const previous = session.insert;
    if (line?.colKey !== previous?.colKey || line?.top !== previous?.top) {
      session.insert = line;
      setInsert(line);
    }
  }

  function autoScroll(session) {
    const boardEl = boardRef.current;
    if (!boardEl || !session.lifted) return;
    const rect = boardEl.getBoundingClientRect();
    let step = 0;
    if (session.last.x < rect.left + EDGE_SCROLL_PX) step = -EDGE_SCROLL_STEP;
    else if (session.last.x > rect.right - EDGE_SCROLL_PX) step = EDGE_SCROLL_STEP;
    if (!step) return;
    const before = boardEl.scrollLeft;
    boardEl.scrollLeft = before + step;
    if (boardEl.scrollLeft === before) return;
    session.rects = collectRects(boardEl, session.task.id);
    retarget(session);
  }

  function finishDrop(session) {
    const { lifted, target, task } = session;
    session.cleanup();
    // Never lifted: it was a card-body click/tap. Nested controls never start
    // a pointer session, so the whole remaining card safely opens the task.
    if (!lifted) {
      onOpenTask(task);
      return;
    }
    if (!target) {
      liveAnnounce(t("kanban.dragCancelled"));
      return;
    }
    // One payload, keys omitted when unchanged — the parent turns this into a
    // single updateTask write and computes orderIndex from beforeId.
    const patch = { beforeId: target.beforeId };
    if (target.workstream && target.workstream !== task.workstream) patch.workstream = target.workstream;
    if (target.status && target.status !== task.status) patch.status = target.status;
    onDropTask(task.id, patch);
    if (patch.workstream) liveAnnounce(t("kanban.moved", { name: patch.workstream }));
    else if (patch.status) liveAnnounce(t("kanban.movedStatus", { status: t(`tasks.status.${patch.status}`) }));
    // Neither key travelled: the card stayed in its own workstream and status
    // and only changed places, so the announcement must say that rather than
    // claim a transfer into the column it never left.
    else liveAnnounce(t("kanban.reordered", { name: task.workstream }));
  }

  function abortDrag(session) {
    const wasLifted = session.lifted;
    session.cleanup();
    if (wasLifted) liveAnnounce(t("kanban.dragCancelled"));
  }

  function startPointerSession(event, task) {
    if (sessionRef.current || event.button !== 0) return;
    // Buttons, links and inputs on the card keep their own gestures; only the
    // card body starts a drag.
    if (event.target.closest("button, a, input, textarea, select")) return;
    const el = event.currentTarget;
    const session = {
      task,
      el,
      pointerId: event.pointerId,
      pointerType: event.pointerType || "mouse",
      startX: event.clientX,
      startY: event.clientY,
      last: { x: event.clientX, y: event.clientY },
      lifted: false,
      held: false,
      dx: 0,
      dy: 0,
      rects: null,
      target: null,
      insert: null,
      holdTimer: 0,
      raf: 0,
    };
    sessionRef.current = session;

    // Pointer events cannot suppress native panning after the fact, so a
    // non-passive touchmove blocker rides along for the lifted phase only.
    const blockTouchScroll = (touchEvent) => {
      if (session.lifted) touchEvent.preventDefault();
    };

    const lift = () => {
      if (session.lifted) return;
      session.lifted = true;
      try {
        session.el.setPointerCapture(session.pointerId);
      } catch {
        // jsdom has no pointer capture; window listeners track the drag anyway.
      }
      const rect = session.el.getBoundingClientRect();
      session.dx = session.startX - rect.left;
      session.dy = session.startY - rect.top;
      session.rects = collectRects(boardRef.current, session.task.id);
      document.body.classList.add("kan-dragging");
      window.addEventListener("touchmove", blockTouchScroll, { passive: false });
      session.removeTouchBlock = () => window.removeEventListener("touchmove", blockTouchScroll);
      clonePosRef.current = { x: session.last.x - session.dx, y: session.last.y - session.dy };
      setDrag({ task: session.task, reduced: prefersReducedMotion() });
      retarget(session);
      session.raf = window.requestAnimationFrame(function tick() {
        autoScroll(session);
        session.raf = window.requestAnimationFrame(tick);
      });
    };

    const onMove = (moveEvent) => {
      // A second finger is its own pointer, not a steering wheel for this one.
      if (moveEvent.pointerId !== session.pointerId) return;
      session.last = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (!session.lifted) {
        const travelled = Math.hypot(moveEvent.clientX - session.startX, moveEvent.clientY - session.startY);
        if (session.pointerType === "touch") {
          if (!session.held && travelled > TOUCH_SLOP_PX) {
            session.cleanup();
            return;
          }
        } else if (travelled > DRAG_LIFT_PX) {
          lift();
        }
        if (!session.lifted) return;
      }
      positionClone(session);
      retarget(session);
    };

    // Only the pointer that started the session may finish or cancel it —
    // a second finger lifting must not drop (or abort) the first finger's drag.
    const onUp = (upEvent) => {
      if (upEvent.pointerId === session.pointerId) finishDrop(session);
    };
    const onCancel = (cancelEvent) => {
      if (cancelEvent.pointerId === session.pointerId) abortDrag(session);
    };
    // Capture phase so Esc aborts the drag BEFORE any overlay/focus-mode map
    // sees it — the abort must never double as an exit. A touch session that
    // has not lifted yet counts too: its hold timer must never lift the card
    // AFTER the member pressed Escape.
    const onKey = (keyEvent) => {
      if (keyEvent.key !== "Escape") return;
      if (!session.lifted && session.pointerType !== "touch") return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      abortDrag(session);
    };

    session.cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      session.removeTouchBlock?.();
      window.clearTimeout(session.holdTimer);
      window.cancelAnimationFrame(session.raf);
      document.body.classList.remove("kan-dragging");
      try {
        session.el.releasePointerCapture(session.pointerId);
      } catch {
        // Capture may never have been taken; nothing to release.
      }
      sessionRef.current = null;
      setDrag(null);
      setInsert(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    if (session.pointerType === "touch") {
      session.holdTimer = window.setTimeout(() => {
        session.held = true;
        lift();
      }, TOUCH_HOLD_MS);
    }
  }

  // Keyboard status moves ride the SAME drop handler as the pointer path —
  // beforeId null appends to the end of the target group, exactly like a drop
  // past the last card.
  function moveByKeyboard(task, to) {
    if (task.status === to) return;
    onDropTask(task.id, { status: to, beforeId: null });
    liveAnnounce(t("kanban.movedStatus", { status: t(`tasks.status.${to}`) }));
  }

  function onCardKeyDown(event, task) {
    // Only keys aimed at the card itself; the title button and circle have
    // their own Enter/Space behavior and must not double-fire.
    if (event.target !== event.currentTarget || event.defaultPrevented) return;
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    if (plain && (event.key === "Enter" || event.key === "e")) {
      event.preventDefault();
      onOpenTask(task);
      return;
    }
    if (plain && event.key === "x") {
      event.preventDefault();
      moveByKeyboard(task, "done");
      return;
    }
    if (plain && (event.key === "[" || event.key === "]")) {
      event.preventDefault();
      const at = STATUS_IDS.indexOf(task.status);
      const to = STATUS_IDS[Math.min(Math.max(at + (event.key === "]" ? 1 : -1), 0), STATUS_IDS.length - 1)];
      moveByKeyboard(task, to);
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      // The parent answers with what it actually did: a reorder stays in the
      // card's own workstream, and at either end of the group it refuses. Only
      // a real move is announced, and never as a transfer; a refusal is silent.
      const outcome = onReorder(task.id, event.key === "ArrowUp" ? "up" : "down");
      if (outcome === "moved") liveAnnounce(t("kanban.reordered", { name: task.workstream }));
    }
  }

  function focusOn(name) {
    onFocusWorkstream(name);
    liveAnnounce(t("kanban.focusedOn", { name }));
  }

  const cardHandlers = {
    chapterId,
    t,
    lang,
    depCounts,
    subtaskCounts,
    commentCounts,
    attachmentCounts,
    onOpenTask,
    onCycleStatus,
    onKeyDown: onCardKeyDown,
    onPointerDown: startPointerSession,
  };

  return (
    <>
      {/* The bar lives BESIDE the board section, not in it: .kan-board is a
          horizontally scrolling flex ROW, and as a flex item the bar would be
          squeezed into a column slot and clipped to a sliver. Out here it is
          the full-width strip its stylesheet rule lays out. */}
      {focusWorkstream && (
        <div className="kan-focus-bar" role="group" aria-label={t("kanban.focusedOn", { name: focusWorkstream })}>
          <span className="kan-focus-bar__current">
            <span className={`kan-ws-icon kan-ws-${workstreamColorIndex(focusWorkstream)}`} aria-hidden="true">
              {(focusWorkstream[0] || "").toUpperCase()}
            </span>
            <strong>{focusWorkstream}</strong>
          </span>
          {workstreamNames.filter((name) => name !== focusWorkstream).map((name) => (
            <button
              key={name}
              type="button"
              className="kan-focus-bar__chip"
              aria-label={t("kanban.focusOn", { name })}
              onClick={() => focusOn(name)}
            >
              <span className={`kan-ws-icon kan-ws-${workstreamColorIndex(name)}`} aria-hidden="true">
                {(name[0] || "").toUpperCase()}
              </span>
            </button>
          ))}
          <button type="button" className="kan-focus-bar__exit" onClick={() => onFocusWorkstream(null)}>
            <X size={14} aria-hidden="true" /> {t("kanban.exitFocus")}
          </button>
        </div>
      )}

    <section className="kan-board" ref={boardRef} aria-label={t("tasks.view.board")}>
      {!focusWorkstream && boardColumns.map(({ workstream, groups }) => {
        return (
          <div className="kan-col" data-workstream={workstream} key={workstream}>
            <header className="kan-ws-head">
              <span className="kan-ws-head__label">
                <h3 className="kan-ws-head__name">{workstream}</h3>
              </span>
              <button
                type="button"
                className="kan-ws-head__focus"
                aria-label={t("kanban.focusOn", { name: workstream })}
                onClick={() => focusOn(workstream)}
              >
                <Crosshair size={15} aria-hidden="true" />
              </button>
            </header>
            <div className="kan-col__list" ref={listRef(workstream)}>
              <NewTaskRow parityKey={`workstream.${encodeURIComponent(workstream)}.top`} t={t} label={t("kanban.newTask")} onCreate={(title) => onCreateInline(workstream, "to_do", title)} />
              {groups.map((group) => {
                if (!group.tasks.length) return null;
                if (group.status === "done" && !doneVisible && !revealed.has(workstream)) {
                  return (
                    <button key="done-hidden" type="button" className="kan-donehidden" onClick={() => reveal(workstream)}>
                      {t("kanban.hiddenDone", { count: group.tasks.length })}
                    </button>
                  );
                }
                return group.tasks.map((task) => (
                  <KanCard key={task.id} task={task} ghost={drag?.task.id === task.id} {...cardHandlers} />
                ));
              })}
              {/* #9514: a column that draws no card keeps only the top New
                  task, unless its bottom box is open or holds a draft. */}
              <NewTaskRow
                parityKey={`workstream.${encodeURIComponent(workstream)}.bottom`}
                t={t}
                label={t("kanban.newTask")}
                onCreate={(title) => onCreateInline(workstream, "to_do", title)}
                hideWhenIdle={!groups.some((group) => group.tasks.length > 0
                  && !(group.status === "done" && !doneVisible && !revealed.has(workstream)))}
              />
              {insert?.colKey === workstream && (
                <span className="kan-insert" style={{ top: insert.top }} aria-hidden="true" />
              )}
            </div>
          </div>
        );
      })}

      {focusWorkstream && focusColumns.map(({ status, tasks: columnTasks }) => {
        const colKey = `status:${status}`;
        const hideDone = status === "done" && !doneVisible && !revealed.has(colKey) && columnTasks.length > 0;
        return (
          <div className="kan-col kan-col--status" data-workstream={focusWorkstream} data-status={status} key={status}>
            <header className="kan-ws-head">
              <span className={`kan-dot kan-dot--${status}`} aria-hidden="true" />
              <span className="kan-ws-head__label">
                <h3 className="kan-ws-head__name">{t(`tasks.status.${status}`)}</h3>
              </span>
            </header>
            <div className="kan-col__list" ref={listRef(colKey)}>
              <NewTaskRow
                parityKey={`status.${encodeURIComponent(focusWorkstream)}.${status}.top`}
                t={t}
                label={t("kanban.addStatusTask", { status: t(`tasks.status.${status}`) })}
                onCreate={(title) => onCreateInline(focusWorkstream, status, title)}
              />
              {hideDone ? (
                <button type="button" className="kan-donehidden" onClick={() => reveal(colKey)}>
                  {t("kanban.hiddenDone", { count: columnTasks.length })}
                </button>
              ) : (
                columnTasks.map((task) => (
                  <KanCard key={task.id} task={task} ghost={drag?.task.id === task.id} {...cardHandlers} />
                ))
              )}
              <NewTaskRow
                parityKey={`status.${encodeURIComponent(focusWorkstream)}.${status}.bottom`}
                t={t}
                label={t("kanban.addStatusTask", { status: t(`tasks.status.${status}`) })}
                onCreate={(title) => onCreateInline(focusWorkstream, status, title)}
                hideWhenIdle={hideDone || columnTasks.length === 0}
              />
              {insert?.colKey === colKey && (
                <span className="kan-insert" style={{ top: insert.top }} aria-hidden="true" />
              )}
            </div>
          </div>
        );
      })}

      {drag && (
        <div
          // The ref callback re-applies the live transform on mount so a
          // mid-drag re-render (insert line moved) never snaps the clone back
          // to its lift position.
          ref={(node) => {
            cloneRef.current = node;
            if (node) node.style.transform = `translate(${clonePosRef.current.x}px, ${clonePosRef.current.y}px)`;
          }}
          className={`kan-dragclone${drag.reduced ? "" : " kan-dragclone--lift"}`}
          style={{ position: "fixed", left: 0, top: 0, width: 256 }}
          aria-hidden="true"
        >
          <KanCard task={drag.task} chapterId={chapterId} t={t} lang={lang} commentCounts={commentCounts} attachmentCounts={attachmentCounts} clone />
        </div>
      )}
    </section>
    </>
  );
}

// One card, three roles: grid card, drag ghost (class only), and clone body.
// The clone renders inert — its wrapper is aria-hidden and it carries no
// data-task-id, so the rect snapshot can never hit-test the floating copy.
function KanCard({
  task,
  t,
  lang,
  commentCounts = null,
  attachmentCounts = null,
  ghost = false,
  clone = false,
  onOpenTask,
  onCycleStatus,
  onKeyDown,
  onPointerDown,
}) {
  const cycle = statusCycle(task.status);
  const badge = checklistBadge(task.description);
  const commentCount = commentCounts?.get?.(task.id) || 0;
  const attachmentCount = attachmentCounts?.get?.(task.id) || 0;
  const overdue = task.status !== "done" && task.dueDate && task.dueDate < isoDate(new Date());
  const dueLabel = task.dueDate
    ? new Intl.DateTimeFormat(localeFor(lang), { month: "short", day: "numeric" }).format(localDate(task.dueDate))
    : null;
  const circleLabel = cycle.action === "advance"
    ? t("kanban.advanceTo", { status: t(`tasks.status.${cycle.to}`) })
    : cycle.action === "complete"
      ? t("kanban.complete")
      : t("kanban.reopen");
  const CircleIcon = cycle.action === "advance" ? ArrowUp : cycle.action === "complete" ? Check : RotateCcw;
  const assigneeNames = Array.isArray(task.assigneeNames) && task.assigneeNames.length
    ? task.assigneeNames
    : task.assigneeName ? [task.assigneeName] : [];
  const initials = String(assigneeNames[0] || "")
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] || "")
    .join("")
    .toUpperCase();
  // The article's name is the title; everything a sighted reader takes from
  // the card face travels in its description, so the focus stop carries the
  // status, assignee and due state even where no status heading is rendered.
  const summaryId = useId();
  const summary = [
    t("kanban.cardStatus", { status: t(`tasks.status.${task.status}`) }),
    assigneeNames.length ? t("kanban.cardAssignees", { names: assigneeNames.join(", ") }) : t("tasks.unassigned"),
    dueLabel ? t("kanban.cardDue", { date: dueLabel }) : t("kanban.cardNoDue"),
    overdue ? t("tasks.overdue") : null,
    task.blocked ? t("tasks.blocked") : null,
  ].filter(Boolean).join(". ");

  return (
    <article
      className={`kan-card kan-card--${task.status}${ghost ? " kan-card--ghost" : ""}`}
      data-task-id={clone ? undefined : task.id}
      data-status={task.status}
      tabIndex={clone ? undefined : 0}
      aria-label={task.title}
      aria-describedby={clone ? undefined : summaryId}
      onKeyDown={clone ? undefined : (event) => onKeyDown(event, task)}
      onPointerDown={clone ? undefined : (event) => onPointerDown(event, task)}
    >
      {!clone && <span id={summaryId} hidden>{summary}</span>}
      <div className="kan-card__top">
        <button
          type="button"
          className="kan-card__circle"
          aria-label={circleLabel}
          disabled={clone || undefined}
          onClick={clone ? undefined : () => onCycleStatus(task)}
        >
          <CircleIcon size={13} aria-hidden="true" />
        </button>
        <span className={`kan-type kan-type--${task.taskType || "general"}`}>
          {t(`tasks.type.${task.taskType || "general"}`)}
        </span>
        {!clone && <PracticeMarker table="public.chapter_tasks" id={task.id} />}
        <span className="kan-card__spacer" />
      </div>

      <button
        type="button"
        className="kan-card__title"
        disabled={clone || undefined}
        onClick={clone ? undefined : () => onOpenTask(task)}
      >
        {task.title}
      </button>
      {task.unitName && <span>{task.unitName}</span>}

      <div className="kan-card__who">
        <span className="kan-av" aria-hidden="true">{initials || "—"}</span>
        <span>{assigneeNames.length ? assigneeNames[0].split(" ")[0] : t("tasks.unassigned")}</span>
        {assigneeNames.length > 1 && <span className="kan-card__assignee-more">+{assigneeNames.length - 1}</span>}
      </div>
      {(task.dueDate || task.blocked) && (
        <div className={`kan-card__due${overdue ? " kan-card__due--overdue" : ""}`}>
          {task.dueDate && (
            <>
              <Flag size={12} aria-hidden="true" />
              <span>{dueLabel}</span>
              {overdue && <span className="visually-hidden">{t("tasks.overdue")}</span>}
            </>
          )}
          {task.blocked && (
            <span className="kan-card__blocked">
              <AlertTriangle size={12} aria-hidden="true" /> {t("tasks.blocked")}
            </span>
          )}
        </div>
      )}

      {(badge || commentCount > 0 || attachmentCount > 0) && (
        <footer className="kan-card__foot">
          {badge && (
            <span className="kan-check" role="img" aria-label={t("kanban.checklistCount", { done: badge.done, total: badge.total })}>
              <span aria-hidden="true">{badge.done}/{badge.total}</span>
            </span>
          )}
          {commentCount > 0 && (
            <span className="kan-count" role="img" aria-label={t("kanban.commentCount", { count: commentCount })}>
              <MessageCircle size={12} aria-hidden="true" /><span aria-hidden="true">{commentCount}</span>
            </span>
          )}
          {attachmentCount > 0 && (
            <span className="kan-count" role="img" aria-label={t("kanban.attachmentCount", { count: attachmentCount })}>
              <Paperclip size={12} aria-hidden="true" /><span aria-hidden="true">{attachmentCount}</span>
            </span>
          )}
        </footer>
      )}
    </article>
  );
}

// The t0ggles inline composer: a ghost row that becomes a bare title input.
// Enter creates and KEEPS the composer open (cleared) for rapid entry; Esc
// closes it. The Esc stops propagating because the window keyboard map would
// otherwise read the same press as "exit focus mode".
// hideWhenIdle (#9514): the row draws nothing while it is closed and empty,
// so a column with no card shows one New task. It stays mounted, so a box a
// person is typing in keeps its text and focus when the last card leaves.
function NewTaskRow({ parityKey, t, label, onCreate, hideWhenIdle = false }) {
  const [open, setOpen] = useDeviceParityState(`tasks.board.composer.${parityKey}.open`, false);
  const [title, setTitle] = useDeviceParityState(`tasks.board.composer.${parityKey}.title`, "");
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const inputRef = useRef(null);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  function submit() {
    return runBusyWrite(busyWriteRef, "create", () => submitNow());
  }

  async function submitNow() {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onCreate(trimmed);
      setTitle("");
    } catch {
      // The parent surfaces create errors; the draft stays for a retry.
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  if (hideWhenIdle && !open && !title) return null;
  if (!open) {
    return (
      <button type="button" className="kan-newtask" onClick={() => setOpen(true)}>
        <Plus size={16} aria-hidden="true" /> {label}
      </button>
    );
  }
  return (
    <div className="kan-newtask kan-newtask--open">
      <label>
        <span className="visually-hidden">{label}</span>
        <BusyInput
          ref={inputRef}
          value={title}
          placeholder={t("kanban.composerPlaceholder")}
          pending={busy}
          onChange={(event) => setTitle(limitTaskTitle(event.target.value, title))}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              event.stopPropagation();
              // A create in flight keeps its composer and title: if it fails,
              // the draft is still there to retry.
              if (busy) return;
              setOpen(false);
              setTitle("");
            }
          }}
        />
      </label>
    </div>
  );
}
