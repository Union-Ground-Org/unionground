import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Star } from "lucide-react";
import { useLang } from "../lib/LanguageContext.jsx";
import { registerEscapeLayer } from "../lib/escapeLayers.js";
import { deviceParityValue } from "../lib/deviceParity.js";
import { readChapterRailExpandedByDefault, subscribeChapterRailExpandedByDefault } from "../lib/chapterRailPreference.js";

const DEMO_PINS_KEY = "sg:demo:chapter-rail:pins";
const CHAPTER_TOOLTIP_CLOSE_DELAY_MS = 150;

function availableStorage(kind) {
  try { return globalThis[kind] ?? null; } catch { return null; }
}

function readStoredIds(storage, key) {
  try {
    const value = JSON.parse(storage?.getItem(key) || "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function sanitizeIds(ids, chapters) {
  const allowed = new Set(chapters.map((chapter) => chapter.id));
  return [...new Set(ids)].filter((id) => allowed.has(id));
}

function sameIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function setStoredValue(storage, key, value) {
  try { storage?.setItem(key, value); } catch { /* Storage may be unavailable. */ }
}

function countLabel(chapter, t) {
  if (chapter.memberCount !== null && chapter.staffCount !== null) {
    return t("chapterRail.counts", { members: chapter.memberCount, staff: chapter.staffCount });
  }
  if (chapter.memberCount !== null) return t("chapterRail.membersOnly", { members: chapter.memberCount });
  if (chapter.staffCount !== null) return t("chapterRail.staffOnly", { staff: chapter.staffCount });
  return null;
}

// REQ-UG-NAV-LIGHT-IDENTITY-20261102 (first pass for the owner): with
// `flyout` the catalog is no longer a second permanent column. It opens from
// the desktop rail's chapter button (`triggerId`) as a panel beside that rail,
// always in its expanded form, and the parent owns `open`. Escape, the close
// button, a choice or a click outside closes it; Escape and the close button
// return focus to the rail button. The profile menu's "keep expanded" choice
// (#6989) now opens the flyout on load instead of widening a column.
export function ChapterRail({ chapters = [], selectedId = null, onSelect, memberId = null, demo = false, busy = false, flyout = false, open = false, onOpenChange = null, id = undefined, triggerId = null }) {
  const { t } = useLang();
  const tooltipId = useId();
  const demoStorage = availableStorage("sessionStorage");
  // Collapsed on every load unless the member keeps it expanded (profile
  // menu); the header button below changes this visit only.
  const [railCollapsed, setCollapsed] = useState(() => !flyout && !readChapterRailExpandedByDefault({ memberId, demo }));
  const collapsed = flyout ? false : railCollapsed;
  const navRef = useRef(null);
  const filterRef = useRef(null);
  const closeFlyout = (restoreFocus) => {
    setQuery("");
    onOpenChange?.(false);
    if (restoreFocus && triggerId) globalThis.document?.getElementById(triggerId)?.focus();
  };
  const [pinnedIds, setPinnedIds] = useState(() => demo
    ? sanitizeIds(readStoredIds(demoStorage, DEMO_PINS_KEY), chapters)
    : []);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = useMemo(() => chapters.filter((chapter) => (
    !normalizedQuery
    || chapter.name.toLocaleLowerCase().includes(normalizedQuery)
    || chapter.abbreviation.toLocaleLowerCase().includes(normalizedQuery)
  )), [chapters, normalizedQuery]);
  const visibleIds = useMemo(() => new Set(visible.map((chapter) => chapter.id)), [visible]);
  const pinned = useMemo(() => pinnedIds
    .map((id) => visible.find((chapter) => chapter.id === id))
    .filter(Boolean), [pinnedIds, visible]);
  const unpinned = useMemo(() => visible.filter((chapter) => !pinnedIds.includes(chapter.id)), [pinnedIds, visible]);
  const collapsedPinned = useMemo(() => pinnedIds
    .map((id) => chapters.find((chapter) => chapter.id === id))
    .filter(Boolean), [chapters, pinnedIds]);
  const collapsedUnpinned = useMemo(() => chapters.filter((chapter) => !pinnedIds.includes(chapter.id)), [chapters, pinnedIds]);
  const active = useMemo(() => chapters.find((chapter) => chapter.id === selectedId), [chapters, selectedId]);
  const collapsedOrdered = useMemo(() => [active, ...collapsedPinned, ...collapsedUnpinned]
    .filter(Boolean)
    .filter((chapter, index, all) => all.findIndex((candidate) => candidate.id === chapter.id) === index), [active, collapsedPinned, collapsedUnpinned]);
  const ordered = useMemo(() => collapsed ? collapsedOrdered : [...pinned, ...unpinned], [collapsed, collapsedOrdered, pinned, unpinned]);
  const initialRovingId = ordered.some((chapter) => chapter.id === selectedId) ? selectedId : ordered[0]?.id ?? null;
  const [rovingId, setRovingId] = useState(initialRovingId);
  const choiceRefs = useRef(new Map());
  const pinRefs = useRef(new Map());
  const collapseRef = useRef(null);
  const pendingCollapseFocusRef = useRef(false);
  const pendingPinFocusRef = useRef(null);
  // A collapsed chapter's tooltip sits over the desktop rail's icons, so the
  // popup itself is not hoverable (pointer-events none): the pointer passes
  // through it to Home, Voting and the rest. Only the transparent 2px
  // corridor beside the trigger shares hover ownership, and closing waits
  // briefly and re-checks that neither the pointer nor keyboard focus still
  // owns it. Escape hides it with focus in place until a fresh hover or
  // focus. The popup is fixed-positioned from its trigger because the
  // scrolling chapter list clips anything absolutely positioned beyond its
  // 44px column.
  const [visibleTooltip, setVisibleTooltip] = useState(null);
  const [tooltipPlacement, setTooltipPlacement] = useState(null);
  const hoveredTooltip = useRef(null);
  // The chapters whose tooltips Escape dismissed; focus restoration skips
  // each until it gets a fresh hover or focus.
  const dismissedTooltip = useRef(new Set());
  const tooltipCloseTimer = useRef(null);
  const cancelTooltipClose = () => {
    clearTimeout(tooltipCloseTimer.current);
    tooltipCloseTimer.current = null;
  };
  const placeTooltip = (id) => {
    const choice = choiceRefs.current.get(id);
    const rect = choice?.getBoundingClientRect();
    if (!rect) return;
    // A choice scrolled out of the list's visible box keeps ownership but
    // hides its popup, so it never floats beside the header or footer.
    const list = choice.closest(".chapter-rail__list")?.getBoundingClientRect();
    const hasGeometry = rect.width > 0 || rect.height > 0;
    const outside = hasGeometry && Boolean(list) && (rect.bottom <= list.top || rect.top >= list.bottom);
    const next = { id, left: rect.right + 2, top: rect.top + (rect.height / 2), outside };
    setTooltipPlacement((current) => current?.id === next.id && current.left === next.left
      && current.top === next.top && current.outside === next.outside ? current : next);
  };
  const showTooltip = (id) => {
    cancelTooltipClose();
    dismissedTooltip.current.delete(id);
    if (!collapsed) return;
    placeTooltip(id);
    setVisibleTooltip(id);
  };
  const leaveTooltip = (id) => {
    // Another chapter's leave or blur must not cancel the visible popup's
    // close. Leaving the chapter Escape dismissed still runs the check below,
    // so a different keyboard-focused chapter gets its tooltip back.
    if (visibleTooltip !== id && !(visibleTooltip === null && dismissedTooltip.current.has(id))) return;
    cancelTooltipClose();
    tooltipCloseTimer.current = setTimeout(() => {
      tooltipCloseTimer.current = null;
      if (hoveredTooltip.current === id || choiceRefs.current.get(id)?.matches(":focus-visible")) return;
      // A keyboard-focused chapter gets its own tooltip back once the pointer
      // leaves another chapter's.
      const [focusedId] = [...choiceRefs.current].find(([chapterId, node]) => (
        node === document.activeElement && node.matches(":focus-visible")
      ) && !dismissedTooltip.current.has(chapterId)) ?? [];
      // Otherwise a chapter the pointer still rests on keeps its tooltip.
      const hoveredId = hoveredTooltip.current;
      const nextId = focusedId ?? (hoveredId !== null && !dismissedTooltip.current.has(hoveredId) ? hoveredId : undefined);
      if (nextId !== undefined) {
        placeTooltip(nextId);
        setVisibleTooltip(nextId);
        return;
      }
      setVisibleTooltip((current) => current === id ? null : current);
    }, CHAPTER_TOOLTIP_CLOSE_DELAY_MS);
  };
  useEffect(() => () => clearTimeout(tooltipCloseTimer.current), []);
  const tooltipShown = visibleTooltip !== null
    && !(tooltipPlacement?.id === visibleTooltip && tooltipPlacement.outside);
  const dismissTooltip = () => {
    const id = visibleTooltip;
    cancelTooltipClose();
    dismissedTooltip.current.add(id);
    setVisibleTooltip(null);
    // A pointer that already left (its close was pending) sends no further
    // leave, so run the focused-chapter restore check now.
    if (hoveredTooltip.current !== id) leaveTooltip(id);
  };
  // Same Escape ownership as the desktop rail tooltip: the shown popup is the
  // newest non-modal Escape layer and declines a key already handled, or one
  // Tasks acts on through its own window listeners (focus mode, popovers).
  useEffect(() => {
    if (!tooltipShown) return undefined;
    // That keymap may run before this layer and clear the mode, so read it as
    // the press begins (window capture runs ahead of every bubble listener).
    // The keymap skips typing surfaces, and so does this decline. A mounted
    // Tasks board popover (filter, members, view settings) closes on Escape
    // from its own window listener whatever ran first, so its press is left
    // to it too.
    let tasksOwnsPress = false;
    const notePress = (event) => {
      if (event.key !== "Escape") return;
      const target = event.target;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName) || Boolean(target?.isContentEditable);
      tasksOwnsPress = Boolean(document.querySelector(".kan-popover"))
        || (!typing && Boolean(deviceParityValue("tasks.focusWorkstream")));
    };
    window.addEventListener("keydown", notePress, true);
    const unregister = registerEscapeLayer((event) => {
      if (event.defaultPrevented || event.isComposing || tasksOwnsPress) return false;
      dismissTooltip();
      return undefined;
    });
    return () => {
      window.removeEventListener("keydown", notePress, true);
      unregister();
    };
  }, [tooltipShown, visibleTooltip]); // eslint-disable-line react-hooks/exhaustive-deps -- dismissTooltip reads refs and visibleTooltip
  useEffect(() => {
    if (visibleTooltip === null) return undefined;
    const reposition = () => placeTooltip(visibleTooltip);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    // Collapse animates the rail's width; follow the trigger once it settles.
    window.addEventListener("transitionend", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("transitionend", reposition, true);
    };
  }, [visibleTooltip]);
  useEffect(() => {
    if (collapsed) return;
    clearTimeout(tooltipCloseTimer.current);
    tooltipCloseTimer.current = null;
    hoveredTooltip.current = null;
    setVisibleTooltip(null);
  }, [collapsed]);

  useEffect(() => {
    setPinnedIds((current) => {
      const sanitized = sanitizeIds(current, chapters);
      return sameIds(current, sanitized) ? current : sanitized;
    });
  }, [chapters]);

  useEffect(() => {
    if (demo) setStoredValue(demoStorage, DEMO_PINS_KEY, JSON.stringify(pinnedIds));
  }, [demo, demoStorage, pinnedIds]);

  useEffect(() => {
    if (rovingId && visibleIds.has(rovingId)) return;
    setRovingId(ordered.some((chapter) => chapter.id === selectedId) ? selectedId : ordered[0]?.id ?? null);
  }, [ordered, rovingId, selectedId, visibleIds]);

  useLayoutEffect(() => {
    if (!collapsed || !pendingCollapseFocusRef.current) return;
    pendingCollapseFocusRef.current = false;
    collapseRef.current?.focus();
  }, [collapsed]);

  useLayoutEffect(() => {
    const chapterId = pendingPinFocusRef.current;
    if (!chapterId) return;
    pendingPinFocusRef.current = null;
    pinRefs.current.get(chapterId)?.focus();
  }, [pinnedIds]);

  const changeCollapse = (next, restoreToggleFocus = false) => {
    if (flyout) {
      if (next) closeFlyout(restoreToggleFocus);
      return;
    }
    if (next) setQuery("");
    pendingCollapseFocusRef.current = next && restoreToggleFocus;
    setCollapsed(next);
  };

  // Turning the profile menu's switch applies the new default at once.
  useEffect(() => subscribeChapterRailExpandedByDefault({ memberId, demo }, (expanded) => {
    if (!expanded) setQuery("");
    if (flyout) onOpenChange?.(expanded);
    else setCollapsed(!expanded);
  }), [demo, memberId, flyout, onOpenChange]);

  // The kept-expanded choice opens the flyout once, on load.
  useEffect(() => {
    if (flyout && readChapterRailExpandedByDefault({ memberId, demo })) onOpenChange?.(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- a load-time default only

  const flyoutOpen = flyout && open;
  useLayoutEffect(() => {
    if (flyoutOpen) filterRef.current?.focus();
  }, [flyoutOpen]);
  useEffect(() => {
    if (!flyoutOpen) return undefined;
    // Non-modal, like the rail tooltips: the newest Escape owner while open.
    const unregister = registerEscapeLayer((event) => {
      if (event.defaultPrevented || event.isComposing) return false;
      closeFlyout(true);
      return undefined;
    });
    const onPointerDown = (event) => {
      const target = event.target;
      if (navRef.current?.contains(target)) return;
      if (triggerId && target?.closest?.(`#${CSS.escape(triggerId)}`)) return;
      closeFlyout(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      unregister();
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [flyoutOpen, triggerId]); // eslint-disable-line react-hooks/exhaustive-deps -- closeFlyout reads current props

  const togglePin = (chapter) => {
    pendingPinFocusRef.current = chapter.id;
    setPinnedIds((current) => current.includes(chapter.id)
      ? current.filter((id) => id !== chapter.id)
      : [...current, chapter.id]);
  };

  const moveChoiceFocus = (event, chapterId) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !ordered.length) return;
    event.preventDefault();
    const currentIndex = Math.max(0, ordered.findIndex((chapter) => chapter.id === chapterId));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? ordered.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1) % ordered.length
          : (currentIndex - 1 + ordered.length) % ordered.length;
    const nextId = ordered[nextIndex].id;
    setRovingId(nextId);
    choiceRefs.current.get(nextId)?.focus();
  };

  const renderChoice = (chapter) => {
    const isPinned = pinnedIds.includes(chapter.id);
    const counts = countLabel(chapter, t);
    // WCAG 2.5.3: the name and counts are the visible label, so the
    // accessible name carries both in that order after the verb. The
    // abbreviation badge is drawn (data-glyph), like an avatar image.
    const visibleLabel = [chapter.name, counts].filter(Boolean).join(", ");
    const openLabel = t("chapterRail.open", { name: visibleLabel });
    const tooltip = chapter.name;
    return (
      <div className="chapter-rail__row" key={chapter.id}>
        <button
          ref={(node) => {
            if (node) choiceRefs.current.set(chapter.id, node);
            else choiceRefs.current.delete(chapter.id);
          }}
          type="button"
          className="chapter-rail__choice"
          aria-pressed={chapter.id === selectedId ? "true" : "false"}
          aria-describedby={collapsed ? `${tooltipId}-${chapter.id}` : undefined}
          aria-label={openLabel}
          title={collapsed ? undefined : chapter.name}
          tabIndex={chapter.id === rovingId ? 0 : -1}
          onFocus={(event) => {
            setRovingId(chapter.id);
            if (event.currentTarget.matches(":focus-visible")) showTooltip(chapter.id);
          }}
          onBlur={() => leaveTooltip(chapter.id)}
          onMouseEnter={() => { hoveredTooltip.current = chapter.id; showTooltip(chapter.id); }}
          onMouseLeave={() => { hoveredTooltip.current = null; leaveTooltip(chapter.id); }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && tooltipShown && !event.defaultPrevented) {
              // The focused chapter's own Escape dismisses only the tooltip,
              // unless a capture listener already answered it.
              event.preventDefault();
              event.stopPropagation();
              dismissTooltip();
              return;
            }
            moveChoiceFocus(event, chapter.id);
          }}
          aria-disabled={busy ? "true" : undefined}
          onClick={(event) => {
            if (busy) return;
            onSelect?.(chapter, event.currentTarget);
            if (flyout) closeFlyout(false);
          }}
        >
          {/* The space after the name keeps it and the counts separate words
              for label matching; flex layout does not render it. */}
          <span className="chapter-rail__abbr" aria-hidden="true" data-glyph={chapter.abbreviation} data-glyph-long={chapter.abbreviation.length > 3 ? "true" : undefined} />
          <span className="chapter-rail__choice-copy">
            <span className="chapter-rail__name">{chapter.name}</span>{" "}
            {counts && (
              <span className="chapter-rail__sub">
                <span className="chapter-rail__meta">{counts}</span>
              </span>
            )}
          </span>
        </button>
        {!collapsed && (
          <button
            ref={(node) => {
              if (node) pinRefs.current.set(chapter.id, node);
              else pinRefs.current.delete(chapter.id);
            }}
            type="button"
            className="chapter-rail__pin"
            aria-label={t(isPinned ? "chapterRail.unpin" : "chapterRail.pin", { name: chapter.name })}
            aria-pressed={isPinned}
            onClick={() => togglePin(chapter)}
          >
            <Star aria-hidden="true" fill={isPinned ? "currentColor" : "none"} size={14} />
          </button>
        )}
        {collapsed && <span id={`${tooltipId}-${chapter.id}`} className="chapter-rail__tooltip" role="tooltip"
          data-visible={visibleTooltip === chapter.id && !(tooltipPlacement?.id === chapter.id && tooltipPlacement.outside) ? "true" : undefined}
          style={tooltipPlacement?.id === chapter.id ? { left: `${tooltipPlacement.left}px`, top: `${tooltipPlacement.top}px` } : undefined}
          onMouseEnter={() => {
            if (visibleTooltip !== chapter.id) return;
            hoveredTooltip.current = chapter.id;
            cancelTooltipClose();
          }}
          onMouseLeave={() => { hoveredTooltip.current = null; leaveTooltip(chapter.id); }}
        >{tooltip}</span>}
      </div>
    );
  };

  const categories = [...new Set(unpinned.map((chapter) => chapter.category || ""))];
  // The uncategorized (live) group is "Your chapters" whenever the member has
  // more than one, even while a filter or a pin leaves a single row visible.
  const uncategorizedHeading = t(chapters.filter((chapter) => !chapter.category).length > 1 ? "chapterRail.yours" : "chapterRail.current");

  if (flyout && !open) return null;

  const rail = (
    <nav
      ref={navRef}
      id={id}
      className={flyout ? "chapter-rail chapter-rail--flyout" : "chapter-rail"}
      aria-label={t("chapterRail.landmark")}
      data-collapsed={collapsed ? "true" : "false"}
      data-flyout={flyout ? "true" : undefined}
    >
      <div className="chapter-rail__header">
        {!collapsed && <strong>{t("chapterRail.title")}</strong>}
        <button
          ref={collapseRef}
          type="button"
          className="chapter-rail__collapse"
          aria-label={t(collapsed ? "chapterRail.expand" : "chapterRail.collapse")}
          title={t(collapsed ? "chapterRail.expand" : "chapterRail.collapse")}
          // The flyout's close button hands focus back to the rail button.
          onClick={() => changeCollapse(!collapsed, flyout)}
        >
          <span aria-hidden="true">{collapsed ? "›" : "‹"}</span>
        </button>
      </div>
      {!collapsed && (
        <label className="chapter-rail__filter">
          <span className="sr-only">{t("chapterRail.filterLabel")}</span>
          <input
            ref={filterRef}
            type="search"
            value={query}
            placeholder={t("chapterRail.filterLabel")}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              if (query) setQuery("");
              else changeCollapse(true, true);
            }}
          />
        </label>
      )}
      <div className="chapter-rail__list">
        {!collapsed && pinned.length > 0 && (
          <section className="chapter-rail__group" aria-labelledby={`${tooltipId}-pinned`}>
            <h2 id={`${tooltipId}-pinned`}>{t("chapterRail.pinned")}</h2>
            {pinned.map(renderChoice)}
          </section>
        )}
        {collapsed && ordered.map(renderChoice)}
        {!collapsed && categories.map((category) => {
          const rows = unpinned.filter((chapter) => (chapter.category || "") === category);
          if (!rows.length) return null;
          const groupId = `${tooltipId}-${category || "current"}`;
          return (
            <section className="chapter-rail__group" aria-labelledby={groupId} key={category || "current"}>
              <h2 id={groupId}>{category || uncategorizedHeading}</h2>
              {rows.map(renderChoice)}
            </section>
          );
        })}
        {!collapsed && !visible.length && (
          <p className="chapter-rail__empty">
            {normalizedQuery ? t("chapterRail.emptyFilter", { query: query.trim() }) : t("chapterRail.emptyLive")}
          </p>
        )}
      </div>
    </nav>
  );
  return flyout ? <><div className="chapter-rail__scrim" aria-hidden="true" />{rail}</> : rail;
}

export function ChapterCatalogWorkspace({ chapter, onClose }) {
  const { t } = useLang();
  const [expandedChapter, setExpandedChapter] = useState(null);
  const activityId = useId();
  const headingRef = useRef(null);
  useLayoutEffect(() => {
    if (chapter) headingRef.current?.focus();
  }, [chapter]);
  if (!chapter) return null;
  const landing = chapter.landing ?? {};
  const summary = landing.activitySummary ?? {};
  const activity = [...(Array.isArray(landing.activity) ? landing.activity : [])]
    .sort((a, b) => (Date.parse(b.occurredAt) || 0) - (Date.parse(a.occurredAt) || 0));
  const showAllActivity = expandedChapter === chapter.id;
  const resources = Array.isArray(landing.sharedResources) ? landing.sharedResources : [];
  return (
    <section className="preview-chapter-landing" aria-labelledby="chapter-catalog-title">
      <span className="preview-chapter-landing__eyebrow">{t("chapterRail.workspaceEyebrow")}</span>
      <h1 ref={headingRef} id="chapter-catalog-title" tabIndex={-1}>{chapter.name}</h1>
      <p className="preview-chapter-landing__note">{landing.summary || t("chapterRail.workspaceNote")}</p>
      <dl className="preview-chapter-landing__facts">
        {chapter.category && <div><dt>{t("chapterRail.region")}</dt><dd>{chapter.category}</dd></div>}
        {chapter.memberCount !== null && <div><dt>{t("chapterRail.members")}</dt><dd>{chapter.memberCount}</dd></div>}
        {chapter.staffCount !== null && <div><dt>{t("chapterRail.staff")}</dt><dd>{chapter.staffCount}</dd></div>}
        {Number.isFinite(summary.openCases) && <div><dt>{t("chapterRail.openCases")}</dt><dd>{summary.openCases}</dd></div>}
        {Number.isFinite(summary.upcomingEvents) && <div><dt>{t("chapterRail.upcomingEvents")}</dt><dd>{summary.upcomingEvents}</dd></div>}
        {Number.isFinite(summary.turnoutPercent) && <div><dt>{t("chapterRail.turnout")}</dt><dd>{summary.turnoutPercent}%</dd></div>}
      </dl>
      {(activity.length > 0 || resources.length > 0) && <div className="preview-chapter-landing__columns">
        <section aria-labelledby="chapter-catalog-activity-title">
          <h2 id="chapter-catalog-activity-title">{t("chapterRail.activityTitle")}</h2>
          <p>{t("chapterRail.activityNote")}</p>
          <div className="preview-chapter-landing__list" id={activityId}>
            {(showAllActivity ? activity : activity.slice(0, 20)).map((item) => (
              <article key={item.id}>
                <div><strong>{item.title}</strong><span>{item.dateLabel}</span></div>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
          {activity.length > 20 && <button type="button" className="dialog-secondary"
            aria-expanded={showAllActivity} aria-controls={activityId}
            onClick={() => setExpandedChapter(showAllActivity ? null : chapter.id)}>
            {showAllActivity ? t("today.feedShowRecent") : t("today.feedShowAll", { count: activity.length })}
          </button>}
        </section>
        <section aria-labelledby="chapter-catalog-shared-title">
          <h2 id="chapter-catalog-shared-title">{t("chapterRail.sharedTitle")}</h2>
          <p>{t("chapterRail.sharedNote")}</p>
          <div className="preview-chapter-landing__resources">
            {resources.map((item) => (
              <article key={item.id}>
                <strong>{item.title}</strong>
                <p>{item.description}</p>
                <span>{t("chapterRail.sharedAcrossOrganization")} · {item.updatedLabel}</span>
              </article>
            ))}
          </div>
        </section>
      </div>}
      <button type="button" onClick={onClose}>{t("chapterRail.return")}</button>
    </section>
  );
}
