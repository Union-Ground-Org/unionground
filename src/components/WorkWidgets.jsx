import { useEffect, useId, useRef, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { WORK_WIDGET_KEYS } from "../lib/mobileNav.js";

// The member Work card's widget panels (owner spec, 2026-08-07): live
// preview cards instead of a static link list. Every widget is a real
// backed destination — the header opens the same route the retired list
// row did, and the preview rows come straight from the loaded data the
// destination itself renders, so the card never claims something the
// screen behind it cannot show.

const WIDGET_META = {
  messages: { labelKey: "nav.messages", icon: "✉", viewKey: "messages", path: "/m/messages", wide: true },
  appointments: { labelKey: "nav.appointments", icon: "📅", viewKey: "appointments", path: "/m/appointments" },
  cases: { labelKey: "nav.myCases", icon: "🗂", viewKey: "cases", path: "/m/cases" },
  forms: { labelKey: "nav.forms", icon: "🖊", viewKey: "forms", path: "/m/forms" },
  workload: { labelKey: "nav.workload", icon: "⏲", viewKey: "workload", path: "/m/workload" },
  numbers: { labelKey: "nav.myReports", icon: "📈", viewKey: "numbers", path: "/m/numbers" },
};

const FORM_STATUS_KEYS = {
  draft: "forms.statusDraft",
  submitted: "forms.statusSubmitted",
  in_review: "forms.statusInReview",
  approved: "forms.statusApproved",
  returned: "forms.statusReturned",
};

// Contract pin: AppointmentsView.jsx:57 uses status === "confirmed" &&
// new Date(endsAt).getTime() > now. Keep this helper the Work card's only
// upcoming predicate — parse endsAt only, same as the destination view.
function isUpcomingAppointment(appt, now) {
  return appt.status === "confirmed" && new Date(appt.endsAt).getTime() > now;
}

// Preview rows per widget, from the same data object the destination views
// read. Each row is a TAP TARGET (owner Rev 5 sign-off, 2026-08-08): where
// the destination accepts a focus deep-link (messages, cases, forms — the
// same contract the search results use) the row carries one and opens its
// exact item; the other widgets' rows open the area, same as the header.
function widgetPreview(key, data, t) {
  if (key === "messages") {
    const rows = (data.conversations ?? []).slice(0, 5).map((thread) => ({
      id: thread.id,
      primary: thread.sender,
      secondary: thread.preview,
      meta: thread.dateLabel,
      dot: (thread.unread ?? 0) > 0,
      focus: { view: "messages", conversationId: thread.id },
    }));
    const unread = (data.conversations ?? []).reduce((sum, thread) => sum + (thread.unread ?? 0), 0);
    return { rows, badge: unread > 0 ? t("workwidgets.unread", { count: unread }) : null };
  }
  if (key === "appointments") {
    const now = Date.now();
    // Same upcoming set as AppointmentsView: confirmed bookings whose end is
    // still ahead. member_appointments.status is British "cancelled"; never
    // compare against American "canceled". Missing endsAt is not upcoming
    // here or on Appointments (new Date(null).getTime() is not > now).
    const upcoming = (data.appointments ?? [])
      .filter((appt) => isUpcomingAppointment(appt, now))
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
      .slice(0, 3);
    return {
      rows: upcoming.map((appt) => ({
        id: appt.id,
        primary: `${appt.dateLabel} · ${appt.timeLabel}`,
        secondary: appt.stewardName,
      })),
    };
  }
  if (key === "cases") {
    const open = (data.cases ?? []).filter((item) => item.status === "active");
    return {
      rows: open.slice(0, 3).map((item) => ({ id: item.id, primary: item.title, secondary: item.type, focus: { view: "cases", caseId: item.id } })),
      badge: open.length > 0 ? t("workwidgets.open", { count: open.length }) : null,
    };
  }
  if (key === "forms") {
    return {
      rows: (data.forms ?? []).slice(0, 3).map((form) => ({
        id: form.id,
        primary: form.answers?.summary ?? form.answers?.requested ?? t("nav.forms"),
        secondary: t(FORM_STATUS_KEYS[form.status] ?? "forms.statusDraft"),
        // FormsView's deep-link contract keys on templateKey (formId alone is
        // ignored — sol MAJ on 7f558d177): the editor resumes the row when it
        // is still in progress, and a submitted row lands on the hub, which
        // is the only reader submitted forms have.
        focus: { view: "forms", templateKey: form.templateKey, formId: form.id },
      })),
    };
  }
  if (key === "workload") {
    return {
      rows: (data.workload?.entries ?? []).slice(0, 3).map((entry) => ({
        id: entry.id,
        primary: entry.dateLabel,
        secondary: entry.meta,
      })),
    };
  }
  if (key === "numbers") {
    // No points or tier row: Union Ground has no points economy, so the
    // widget shows only the member's own action count when one is loaded.
    const actionsYtd = data.rewards?.actionsYtd;
    return { rows: actionsYtd != null ? [{ id: "actions", primary: String(actionsYtd), secondary: t("today.actionsYtd") }] : [] };
  }
  return { rows: [] };
}

export function WorkWidgets({ data, order = WORK_WIDGET_KEYS, onOrderChange, onNavigate }) {
  const { t } = useLang();
  const gridRef = useRef(null);
  const [dragKey, setDragKey] = useState(null);
  const [dragOrder, setDragOrder] = useState(null);
  const dragOrderRef = useRef(null);
  const displayedOrder = dragOrder ?? order;
  // A polite live region tells screen-reader users what an arrow-key (or
  // drag) reorder actually did — the grid re-rendering says nothing aloud
  // (sol LOW on 369c8710e).
  const [announcement, setAnnouncement] = useState("");
  // The handle only ever answers the arrow keys, so a name alone strands a
  // keyboard or switch user who focuses it and presses Enter or Space. One
  // shared description says which keys work; it sits outside the live region
  // above so the polite move announcement is never disturbed.
  const reorderHintId = `workwidgets-reorder-hint-${useId()}`;

  const commit = (next) => {
    onOrderChange?.(next);
  };

  const announceMove = (key, next) => {
    const meta = WIDGET_META[key];
    if (!meta) return;
    setAnnouncement(t("workwidgets.moved", { title: t(meta.labelKey), position: next.indexOf(key) + 1, count: next.length }));
  };

  const move = (key, delta) => {
    const from = displayedOrder.indexOf(key);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= displayedOrder.length) return;
    const next = [...displayedOrder];
    next.splice(from, 1);
    next.splice(to, 0, key);
    commit(next);
    announceMove(key, next);
  };

  // Drag lives on the handle, not the card: the card is a navigation button
  // and the grid sits inside the horizontally scroll-snapping rail, so an
  // accidental card-body drag must stay a scroll.
  // Drag owns a temporary visual order. The parent receives one complete
  // snapshot only on release; persistence never runs inside a state updater.

  // The move/up stream rides WINDOW listeners, never pointer capture on the
  // handle: the first reorder moves the handle's DOM node (insertBefore =
  // remove + insert), which clears any element capture and would strand the
  // drag mid-gesture with the release lost (found live in the Browserbase
  // preview sweep on 69d86613c).
  // One drag at a time, keyed to its pointerId: a second touch must neither
  // start a rival listener set nor steal the live gesture, and without
  // capture a mouse released outside the window never sends pointerup — the
  // window blur is the only signal left, so it cancels too (sol MAJ x2 on
  // 97dd222c4). The teardown ref lets unmount drop the window listeners.
  const dragTeardownRef = useRef(null);
  useEffect(() => () => { dragTeardownRef.current?.(); }, []);
  const dragFrom = (key) => (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (dragTeardownRef.current) return;
    event.preventDefault();
    const pointerId = event.pointerId;
    dragOrderRef.current = [...order];
    setDragOrder(dragOrderRef.current);
    setDragKey(key);
    const onMove = (ev) => {
      if (ev.pointerId !== pointerId) return;
      const grid = gridRef.current;
      if (!grid) return;
      // Identify the hovered widget by KEY, not index: the DOM reflects the
      // last committed order, while the functional updater may run against a
      // newer state after batched pointer moves — indices drift, identities
      // do not (sol MED on 369c8710e).
      let targetKey = null;
      grid.querySelectorAll(".workwidget").forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (ev.clientY >= rect.top && ev.clientY <= rect.bottom && ev.clientX >= rect.left && ev.clientX <= rect.right) targetKey = el.dataset.widget;
      });
      if (!targetKey || targetKey === key) return;
      setDragOrder((current) => {
        current = current ?? order;
        const from = current.indexOf(key);
        const to = current.indexOf(targetKey);
        if (from === -1 || to === -1 || from === to) return current;
        const next = [...current];
        next.splice(from, 1);
        next.splice(to, 0, key);
        dragOrderRef.current = next;
        return next;
      });
    };
    const endDrag = (shouldCommit) => {
      const next = dragOrderRef.current;
      dragTeardownRef.current?.();
      setDragKey(null);
      setDragOrder(null);
      dragOrderRef.current = null;
      if (shouldCommit && next && next.some((item, index) => item !== order[index])) {
        commit(next);
        announceMove(key, next);
      }
    };
    const onUp = (ev) => {
      if (ev.pointerId !== pointerId) return;
      endDrag(true);
    };
    const onCancel = (ev) => {
      if (ev.pointerId !== pointerId) return;
      endDrag(false);
    };
    const onBlur = () => endDrag(false);
    dragTeardownRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onBlur);
      dragTeardownRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onBlur);
  };

  const onHandleKey = (key) => (event) => {
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      move(key, -1);
    } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      move(key, 1);
    }
  };

  return (
    <div className="workwidgets" ref={gridRef} role="group" aria-label={t("workwidgets.label")}>
      <p className="visually-hidden" aria-live="polite">{announcement}</p>
      <p className="visually-hidden" id={reorderHintId}>{t("workwidgets.reorderHint")}</p>
      {displayedOrder.map((key) => {
        const meta = WIDGET_META[key];
        if (!meta) return null;
        const title = t(meta.labelKey);
        const { rows, badge } = widgetPreview(key, data, t);
        return (
          <article
            key={key}
            data-widget={key}
            className={`workwidget${meta.wide ? " workwidget--wide" : ""}${dragKey === key ? " workwidget--drag" : ""}`}
          >
            <header className="workwidget__head">
              <button
                type="button"
                className="workwidget__open"
                onClick={() => onNavigate(meta.viewKey, meta.path)}
              >
                <span className="workwidget__icon" aria-hidden="true">{meta.icon}</span>
                <span className="workwidget__title">{title}</span>
                {badge && <span className="workwidget__badge">{badge}</span>}
                <span className="workwidget__chev" aria-hidden="true">›</span>
              </button>
              <button
                type="button"
                className="workwidget__handle"
                aria-label={t("workwidgets.reorder", { title })}
                aria-describedby={reorderHintId}
                aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
                onPointerDown={dragFrom(key)}
                onKeyDown={onHandleKey(key)}
              >
                <span aria-hidden="true">⠿</span>
              </button>
            </header>
            {rows.length ? (
              <ul className="workwidget__rows">
                {rows.map((row) => (
                  <li key={row.id} className="workwidget__row">
                    <button
                      type="button"
                      className="workwidget__rowbtn"
                      onClick={() => onNavigate(meta.viewKey, meta.path, "", row.focus ?? null)}
                    >
                      {row.dot && <span className="workwidget__dot" aria-hidden="true" />}
                      <span className="workwidget__primary">{row.primary}</span>
                      {row.secondary && <span className="workwidget__secondary">{row.secondary}</span>}
                      {row.meta && <span className="workwidget__meta">{row.meta}</span>}
                      <span className="workwidget__rowchev" aria-hidden="true">›</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="workwidget__empty">{t("workwidgets.empty")}</p>
            )}
          </article>
        );
      })}
    </div>
  );
}
