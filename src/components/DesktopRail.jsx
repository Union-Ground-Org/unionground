import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RAIL_EXTRA_ITEMS } from "./BottomNav.jsx";
import { BrandMark } from "./BrandMark.jsx";
import { ORGANIZER_RAIL_ITEMS, PRODUCT_NAME } from "../lib/productIdentity.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { useKnownOrganizationName, useOrganizationName } from "../lib/organizationName.js";
import { currentStaffSection, staffItemHref, staffRailGroups, STAFF_ROLE_NAVIGATION, visibleStaffNavigation } from "../lib/staffNavigation.js";
import { isEditableShortcutTarget, openCommandPalette, railShortcutIndex, shortcutModifierLabel } from "../lib/commandPalette.js";
import { keyboardShortcutsEnabled, useKeyboardShortcutsEnabled } from "../lib/keyboardShortcuts.js";
import { hasOpenModalLayer, registerEscapeLayer } from "../lib/escapeLayers.js";
import { deviceParityValue } from "../lib/deviceParity.js";
import { useMenuPresence } from "../lib/useTransitionPresence.js";
import { RailIcon, railIconName } from "./RailIcons.jsx";
import { GuidedNavToggle, SpotlightMarker } from "./OnboardingHud.jsx";
import { guidedNavItems, hiddenGuidedNavCount, isSpotlit, spotlightNavItem } from "../lib/onboardingGuide.js";
import { personalizeNavGroups, pinnedNavItems } from "../features/memberHome/navUsage.js";
import { FEATURE_GROUPS, NAV_HINT_KEYS, navHintKey } from "../lib/mobileNav.js";
import { useStewardPresence } from "./NoStewardNote.jsx";
import { Activity, Bell, Building2, CalendarDays, ChartNoAxesColumnIncreasing, CheckSquare2, ChevronLeft, ChevronRight, Circle, CircleHelp, Clock3, Compass, ExternalLink, Eye, FileText, FolderKanban, Gift, House, Mail, Megaphone, MessageSquare, Network, Search, Settings, ShieldCheck, Target, Users, Vote } from "lucide-react";

const DEMO_DESKTOP_RAIL_COLLAPSE_KEY = "sg:demo:desktop-main-rail:collapsed";
// The fades src/styles.css paints over the scrolling list's edges: the sticky
// `.desktop-rail__items::before` (10px) and the Command palette strip's
// `box-shadow: 0 -12px 12px` (24px). tests/desktop-rail-reveal-open-row.test.jsx
// reads both from the stylesheet.
const RAIL_LIST_TOP_FADE_PX = 10;
const RAIL_LIST_BOTTOM_FADE_PX = 24;

function availableStorage(kind) {
  try { return globalThis[kind] ?? null; } catch { return null; }
}

function readStoredCollapse(storage, key) {
  try { return Boolean(key) && storage?.getItem(key) === "true"; } catch { return false; }
}

function storeCollapse(storage, key, collapsed) {
  if (!key) return;
  try { storage?.setItem(key, String(collapsed)); } catch { /* Storage may be unavailable. */ }
}

const RAIL_TOOLTIP_CLOSE_DELAY_MS = 150;

// `suppressed` hides the popup while its trigger owns an open menu.
function useCompactRailTooltip(compact, label, suppliedControlRef = null, suppressed = false) {
  const tooltipId = useId();
  const internalControlRef = useRef(null);
  const controlRef = suppliedControlRef ?? internalControlRef;
  const [placement, setPlacement] = useState(null);
  // WCAG 1.4.13: the trigger and its popup share hover ownership, so the
  // pointer can cross the 12px gap (bridged by a transparent corridor) into
  // the tooltip. Closing waits briefly and re-checks that neither the pointer
  // nor keyboard focus still owns it. Escape hides the popup while focus
  // stays put; only a fresh hover or focus reveals it again.
  const [dismissed, setDismissed] = useState(false);
  const hoveredRef = useRef(false);
  const closeTimer = useRef(null);
  const cancelClose = useCallback(() => {
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const leave = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      if (!hoveredRef.current && !controlRef.current?.matches(":focus-visible")) setPlacement(null);
    }, RAIL_TOOLTIP_CLOSE_DELAY_MS);
  }, [cancelClose, controlRef]);
  useEffect(() => cancelClose, [cancelClose]);
  useEffect(() => {
    if (compact) return;
    cancelClose();
    hoveredRef.current = false;
    setDismissed(false);
  }, [cancelClose, compact]);

  const measure = useCallback((control = controlRef.current) => {
    if (!compact || !control?.isConnected) {
      setPlacement(null);
      return;
    }
    const rect = control.getBoundingClientRect();
    const hasGeometry = rect.width > 0 || rect.height > 0;
    const outsideViewport = hasGeometry && (
      rect.bottom <= 0
      || rect.top >= globalThis.innerHeight
      || rect.right <= 0
      || rect.left >= globalThis.innerWidth
    );
    if (outsideViewport) {
      // `false` means the control still owns an active tooltip, but its visual
      // placement is hidden. Keeping that distinct from `null` leaves the
      // scroll/resize tracking attached so focus can reveal it again.
      setPlacement(false);
      return;
    }
    const next = {
      left: rect.right + 12,
      top: Math.min(globalThis.innerHeight - 24, Math.max(24, rect.top + (rect.height / 2))),
    };
    setPlacement((current) => current?.left === next.left && current?.top === next.top ? current : next);
  }, [compact, controlRef]);

  useLayoutEffect(() => {
    if (!compact) {
      setPlacement(null);
      return;
    }
    if (globalThis.document?.activeElement !== controlRef.current) return;
    measure();
    // Collapsing the rail retains focus on this same control while replacing
    // its geometry. The first layout effect can still observe the expanded
    // position; measure once more after the compact layout has painted so the
    // visible keyboard tooltip follows the retained focus.
    const frame = globalThis.requestAnimationFrame?.(() => {
      if (globalThis.document?.activeElement === controlRef.current) measure();
    });
    return () => {
      if (frame !== undefined) globalThis.cancelAnimationFrame?.(frame);
    };
  }, [compact, controlRef, measure]);

  useEffect(() => {
    if (!compact || placement === null) return undefined;
    const dismissPointerTooltip = () => {
      if (globalThis.document?.activeElement === controlRef.current) measure();
      else setPlacement(null);
    };
    const reposition = () => measure();
    window.addEventListener("resize", dismissPointerTooltip);
    window.addEventListener("scroll", reposition, true);
    // Collapse animates the rail's width; follow the trigger once it settles.
    window.addEventListener("transitionend", reposition, true);
    globalThis.visualViewport?.addEventListener("resize", dismissPointerTooltip);
    globalThis.visualViewport?.addEventListener("scroll", reposition);
    return () => {
      window.removeEventListener("resize", dismissPointerTooltip);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("transitionend", reposition, true);
      globalThis.visualViewport?.removeEventListener("resize", dismissPointerTooltip);
      globalThis.visualViewport?.removeEventListener("scroll", reposition);
    };
  }, [compact, controlRef, measure, placement]);

  const shown = Boolean(placement) && !dismissed && !suppressed;
  // A visible tooltip is the newest non-modal Escape layer, so a hovered
  // popup is dismissible wherever focus is (a panel registered earlier keeps
  // its own turn). It declines a key another surface already handled — a
  // menu, a popover's capture listener — and modals outrank it. It also
  // declines a press Tasks will act on (exiting focus mode, closing a board
  // popover) from its own window listeners: one Escape answers one surface.
  useEffect(() => {
    if (!shown) return undefined;
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
      cancelClose();
      setDismissed(true);
      return undefined;
    });
    return () => {
      window.removeEventListener("keydown", notePress, true);
      unregister();
    };
  }, [cancelClose, shown]);
  const controlProps = {
    ref: controlRef,
    ...(compact ? {
      "aria-describedby": tooltipId,
      onFocus: (event) => {
        cancelClose();
        setDismissed(false);
        measure(event.currentTarget);
      },
      onBlur: () => {
        cancelClose();
        if (!hoveredRef.current) setPlacement(null);
      },
      onMouseEnter: (event) => {
        hoveredRef.current = true;
        cancelClose();
        setDismissed(false);
        measure(event.currentTarget);
      },
      onMouseLeave: () => {
        hoveredRef.current = false;
        leave();
      },
      onKeyDown: (event) => {
        if (event.key !== "Escape" || !shown || event.defaultPrevented) return;
        // The focused trigger's own Escape dismisses only its tooltip, unless
        // a capture listener (a calendar popover) already answered it.
        event.preventDefault();
        event.stopPropagation();
        cancelClose();
        setDismissed(true);
      },
    } : {}),
  };
  const tooltip = compact && globalThis.document?.body
    ? createPortal(
      <span
        id={tooltipId}
        role="tooltip"
        className="desktop-rail__tooltip"
        data-visible={shown ? "true" : undefined}
        onMouseEnter={() => {
          if (!shown) return;
          hoveredRef.current = true;
          cancelClose();
        }}
        onMouseLeave={(event) => {
          // The popup is portaled but remains the trigger's React child, so
          // returning to the trigger fires no new trigger mouseenter.
          if (event.relatedTarget instanceof Node && controlRef.current?.contains(event.relatedTarget)) return;
          hoveredRef.current = false;
          leave();
        }}
        // The popup describes its trigger; it never activates it.
        onClick={(event) => event.stopPropagation()}
        style={placement ? { left: `${placement.left}px`, top: `${placement.top}px` } : undefined}
      >
        {label}
      </span>,
      globalThis.document.body,
    )
    : null;
  return { controlProps, tooltip };
}

// The Purple capability map inside this rail remains the source of truth for
// routes, icons, shortcuts and counts. `renderMode` changes only the shell:
// the top-level desktop gets the Green guide's 248px/72px anatomy, while the
// shared tablet surface retains its established presentation.
//
// The prototype member sidebar groups: Me → [Steward] → Union → Other →
// Account. Only destinations with a real backing screen render — the
// prototype rows with no live route (My actions, Bargaining, Contract, …)
// are deliberately absent rather than dead links; their group slots stay so
// they land here as their screens ship. Role destinations and
// their shared work tool remain distinct: roles are identities a member can
// switch into, while Chapter work is a tool those roles can open.
//
// Exactly one of BottomNav/DesktopRail renders at a time (App gates on
// matchMedia), which keeps every accessible link name unique.

// Me — prototype order: Home, Voting, Rewards, [Compass], My cases, Forms,
// Be heard, Workload log, My reports, Messages. Compass is injected between
// the two halves as a button (overlay, not a route).
const ME_TOP_ITEMS = [
  { key: "today", labelKey: "nav.home", path: "/m", icon: "▦" },
  // Union Ground: the worker Work list sits beside Home.
  { key: "work", labelKey: "nav.work", path: "/m/work", icon: "☑" },
  { key: "voting", labelKey: "nav.voting", path: "/m/voting", icon: "🗳" },
  RAIL_EXTRA_ITEMS.find((item) => item.key === "rewards"),
];
const ME_REST_ITEMS = [
  { key: "cases", labelKey: "nav.issues", path: "/m/cases", icon: "🗂" },
  RAIL_EXTRA_ITEMS.find((item) => item.key === "forms"),
  { key: "voice", labelKey: "morehub.beHeard", path: "/m/voice", icon: "📣" },
  RAIL_EXTRA_ITEMS.find((item) => item.key === "workload"),
  { key: "numbers", labelKey: "nav.myReports", path: "/m/numbers", icon: "📈" },
  { key: "messages", labelKey: "nav.messages", path: "/m/messages", icon: "✉" },
  // REQ-UG-PULSE-WEB-EXPLORER-AND-STUDIO-20261031: Pulse sits with My
  // reports in the Me group, after Messages so the Control+1..0 shortcuts keep
  // their destinations.
  { key: "pulse", labelKey: "nav.pulse", path: "/m/pulse", icon: "📊" },
];
// Union Ground's campaign group. Dues, contract clauses and civic action
// are left out (no union, contract or civic programme exists yet), and the
// campaign workspace opens on its first tab because the bare /m/organize
// address is the Organize plane.
const UNION_ITEMS = [
  { key: "events", labelKey: "nav.meetings", path: "/m/events", icon: "▣" },
  { key: "rights", labelKey: "nav.rights", path: "/m/rights", icon: "⚖" },
  // The view this item mounts is named, exactly as  named it for the
  // phone nav: railNavigate("member-support") resolves no view, so the URL
  // changed and Home stayed mounted at 768 and 1440.
  { key: "member-support", viewKey: "memberSupport", labelKey: "nav.memberSupport", path: "/m/support", icon: "🤝" },
  { key: "org-structure", viewKey: "orgStructure", labelKey: "nav.orgStructure", path: "/m/org-structure", icon: "◍" },
  { key: "hub", labelKey: "nav.myChapter", path: "/m/organize/organize", icon: "⌂" },
  { key: "network", viewKey: "coordination", labelKey: "nav.network", path: "/m/network", icon: "◎" },
  { key: "pay", labelKey: "nav.pay", path: "/m/pay", icon: "💲" },
  { key: "search", labelKey: "nav.search", path: "/m/search", icon: "🔍" },
];
const ACCOUNT_ITEMS = [
  // REQ-UG-SITE-GUIDE-FOR-REAL-ACCOUNTS-20261001 ("How to use this site"),
  // first in Account (UX-UG-WEB-NAVIGATION-TOO-MANY-DESTINATIONS-20261018).
  { key: "site-guide", viewKey: "siteGuide", labelKey: "nav.siteGuide", path: "/m/guide", icon: "?" },
  { key: "accessHistory", labelKey: "nav.accessHistory", path: "/m/access-history", icon: "👁" },
  { key: "settings", labelKey: "nav.settings", path: "/m/settings", icon: "⚙" },
];

const DESKTOP_ICON_BY_KEY = {
  today: House,
  work: CheckSquare2,
  events: CalendarDays,
  organize: Target,
  voting: Vote,
  rewards: Gift,
  cases: FolderKanban,
  forms: FileText,
  voice: Megaphone,
  pay: ChartNoAxesColumnIncreasing,
  workload: Clock3,
  numbers: ChartNoAxesColumnIncreasing,
  pulse: Activity,
  messages: Mail,
  rights: ShieldCheck,
  "member-support": Users,
  hub: Building2,
  search: Search,
  accessHistory: Eye,
  settings: Settings,
  "site-guide": CircleHelp,
  tasks: CheckSquare2,
  "events-desk": CalendarDays,
  campaigns: Megaphone,
  analytics: ChartNoAxesColumnIncreasing,
  "qa-queue": MessageSquare,
  integrations: Settings,
  steward: FolderKanban,
  coordinator: CheckSquare2,
  advisor: Compass,
  admin: ShieldCheck,
  vp: Building2,
  "org-structure": Network,
};

// UX-UG-FOLDED-RAIL-AND-COMMAND-PALETTE-ICONS-REPEAT-20261122 (,
// the owner's "rail icons A"): every rail row draws its own icon from the theme
// package (RailIcons.jsx). DESKTOP_ICON_BY_KEY stays only as the guard for a row
// added without one, before the Circle (tests/desktop-rail-distinct-icons.test.jsx
// fails on either); its source is hashed by the telemetry key-constructor pin
// (its name contains KEY), so icon work leaves it as it is.
function DesktopRailIcon({ item }) {
  const name = railIconName(item.key);
  if (name) return <RailIcon name={name} />;
  const Icon = DESKTOP_ICON_BY_KEY[item.key];
  if (Icon) return <Icon size={17} strokeWidth={2} />;
  return <Circle size={14} strokeWidth={2} />;
}

function shortcutItemsForHat(hat, onAsk, dues, demoNavigation = false) {
  const items = hat === "member"
    ? [...ME_TOP_ITEMS, ...(onAsk ? [{ key: "compass", action: onAsk }] : []), ...ME_REST_ITEMS, ...UNION_ITEMS, ...ACCOUNT_ITEMS]
    : visibleStaffNavigation(STAFF_ROLE_NAVIGATION[hat] ?? [], demoNavigation);
  return dues ? items : items.filter((item) => item.key !== "dues");
}

// The keyboard hint is supplementary, not part of the control's label: its
// keys are announced through aria-keyshortcuts, and the hint is drawn as
// generated content so it is not text a speech user must say (WCAG 2.5.3).
function ShortcutHint({ keys }) {
  return <kbd className="desktop-rail__shortcut" aria-hidden="true" data-keys={keys} />;
}

// Counts that ask for attention (the guide's "unread, yours to act on"): the
// pill counts (tasks and the worn desk's queue) and draft forms. Folded, they
// turn gold; every other count stays green.
const ATTENTION_COUNTS = new Set(["forms"]);

function RailLink({ item, active, activeSection, onSection, onNavigate, badge = null, badgeDetail = null, pill = false, shortcutNumber = null, shortcutModifier = "Ctrl", compact = false, spotlit = false }) {
  const { t } = useLang();
  // A spotlit row links to the onboarding step itself.
  const target = spotlit ? spotlightNavItem(item) : item;
  const { key, viewKey = key, labelKey, path, sectionId } = target;
  const selected = sectionId ? active === viewKey && activeSection === sectionId : active === viewKey && !activeSection;
  const label = t(labelKey);
  const countedLabel = badge > 0 ? `${label} ${badge}` : label;
  // The onboarding spotlight is announced, not only drawn.
  const accessibleLabel = spotlit ? `${countedLabel}, ${t("onboardingGuide.spotlight")}` : countedLabel;
  const compactTooltip = useCompactRailTooltip(compact, accessibleLabel);
  // REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030 (findings 85, 99):
  // the entries members could not tell apart carry a one-line explanation, as
  // the row's description and in its hover title.
  const hintId = useId();
  const hintKey = navHintKey(item.key, useStewardPresence());
  const hint = hintKey ? t(hintKey) : null;
  // A count that sums several queues says which (the Steward entry's count is
  // open requests plus forms to review, not the desk's open requests alone).
  const detailId = useId();
  const detail = badge > 0 && badgeDetail ? badgeDetail : null;
  const titleParts = compact ? [] : [
    hint ? `${label}: ${hint}` : shortcutNumber !== null || detail ? label : null,
    detail,
    shortcutNumber !== null ? `Ctrl/⌘+${shortcutNumber}` : null,
  ].filter(Boolean);
  const describedBy = [hint && !compact ? hintId : null, detail ? detailId : null].filter(Boolean).join(" ");
  return (
    <a
      href={staffItemHref(target)}
      className={["desktop-rail__row", selected ? "active" : "", spotlit ? "is-spotlit" : ""].filter(Boolean).join(" ")}
      aria-label={accessibleLabel}
      {...compactTooltip.controlProps}
      aria-current={selected ? "page" : undefined}
      aria-keyshortcuts={shortcutNumber === null ? undefined : `Control+${shortcutNumber} Meta+${shortcutNumber}`}
      {...(describedBy ? { "aria-describedby": describedBy } : {})}
      title={titleParts.length ? titleParts.join(" · ") : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onSection(sectionId || "");
        onNavigate(viewKey, path, sectionId);
      }}
    >
      <span className="desktop-rail__ic" aria-hidden="true">
        <DesktopRailIcon item={item} />
      </span>
      {/* The spaces keep the label and count separate words for speech
          matching; the row's grid layout does not render them. */}
      <span className="desktop-rail__label">{label}</span>{" "}
      {hint && !compact && <span id={hintId} className="sr-only">{hint}</span>}
      {detail && <span id={detailId} className="sr-only">{detail}</span>}
      {spotlit && !compact && <><SpotlightMarker />{" "}</>}
      {shortcutNumber !== null && <ShortcutHint keys={`${shortcutModifier}+${shortcutNumber}`} />}
      {badge > 0 && <span className={pill ? "rail-badge" : ATTENTION_COUNTS.has(key) ? "rail-count is-alert" : "rail-count"}>{badge}</span>}
      {compactTooltip.tooltip}
    </a>
  );
}

// REQ-UG-CUSTOM-NAV-LINKS-20261001: an organization's admin-set link. It
// leaves the app, so it opens a new tab without an opener and says so in its
// accessible name; customNavLinks() has already refused any non-https address.
function CustomRailLink({ link, compact = false }) {
  const { t } = useLang();
  const compactTooltip = useCompactRailTooltip(compact, link.label);
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t("nav.customLinkOpens", { label: link.label })}
      className="desktop-rail__row"
      data-custom-link={link.key}
      {...compactTooltip.controlProps}
    >
      <span className="desktop-rail__ic" aria-hidden="true"><ExternalLink size={17} strokeWidth={2} /></span>
      <span className="desktop-rail__label">{link.label}</span>
      {compactTooltip.tooltip}
    </a>
  );
}

function HatButton({ item, active, onSwitch }) {
  const { t } = useLang();
  const selected = active === item.key || (item.key === "member" && (active === "member" || active === "worker" || !active));
  return (
    <button
      type="button"
      className="desktop-rail__hat-option"
      aria-pressed={selected}
      onClick={() => onSwitch(item.key)}
    >
      <span className={`desktop-rail__hat-dot desktop-rail__hat-dot--${item.key}`} aria-hidden="true" />
      <span className="desktop-rail__label">{t(item.labelKey)}</span>
    </button>
  );
}

function useFocusedUnmount(onFocusedUnmount) {
  const boundaryRef = useRef(null);
  useLayoutEffect(() => () => {
    const activeElement = globalThis.document?.activeElement;
    if (activeElement && boundaryRef.current?.contains(activeElement)) onFocusedUnmount?.();
  }, [onFocusedUnmount]);
  return boundaryRef;
}

function ExpandedHatSwitcher({ items, active, onSwitch, onFocusedUnmount = null }) {
  const { t } = useLang();
  const boundaryRef = useFocusedUnmount(onFocusedUnmount);
  return (
    <div ref={boundaryRef} className="desktop-rail__hat-switcher" role="group" aria-label={t("demo.hatsLabel")}>
      <span className="desktop-rail__grouplabel">{t("demo.hatsLabel")}</span>
      <div className="desktop-rail__hat-options">
        {items.map((item) => (
          <HatButton key={item.key} item={item} active={active} onSwitch={onSwitch} />
        ))}
      </div>
    </div>
  );
}

function CompactHatChooser({ items, active, onSwitch, dismissVersion = 0, onFocusedUnmount = null }) {
  const { t } = useLang();
  const menuId = useId();
  const boundaryRef = useFocusedUnmount(onFocusedUnmount);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const itemRefs = useRef([]);
  const focusOnOpenRef = useRef(0);
  const restoreFocusRef = useRef(false);
  const activeIndex = Math.max(0, items.findIndex((item) => item.key === active));
  const [open, setOpen] = useState(false);
  const [rovingIndex, setRovingIndex] = useState(activeIndex);
  const [menuPlacement, setMenuPlacement] = useState(null);
  const itemsSignature = JSON.stringify(items.map(({ key, labelKey, path }) => [key, labelKey, path]));
  const chooserContextRef = useRef({ active, dismissVersion, itemsSignature });

  const openMenu = (index) => {
    const nextIndex = Math.max(0, Math.min(items.length - 1, index));
    focusOnOpenRef.current = nextIndex;
    setRovingIndex(nextIndex);
    setOpen(true);
  };

  const closeMenu = (restoreFocus = true) => {
    restoreFocusRef.current = restoreFocus;
    setOpen(false);
  };

  useLayoutEffect(() => {
    const previous = chooserContextRef.current;
    const contextChanged = previous.active !== active
      || previous.dismissVersion !== dismissVersion
      || previous.itemsSignature !== itemsSignature;
    chooserContextRef.current = { active, dismissVersion, itemsSignature };
    if (!open || !contextChanged) return;
    // Authorization/active-hat changes can remove the roving item entirely,
    // and a global shortcut has already chosen a destination outside this
    // popup. Close the stale menu and return to its surviving trigger.
    restoreFocusRef.current = true;
    setOpen(false);
  }, [active, dismissVersion, itemsSignature, open]);

  const placeMenu = () => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const triggerRect = trigger.getBoundingClientRect();
    const viewportHeight = document.documentElement.clientHeight;
    const gutter = 8;
    const availableHeight = Math.max(44, viewportHeight - (gutter * 2));
    const menuHeight = Math.min(menu.scrollHeight, availableHeight);
    const preferredTop = triggerRect.bottom - menuHeight;
    setMenuPlacement({
      left: triggerRect.right + 12,
      top: Math.max(gutter, Math.min(preferredTop, viewportHeight - gutter - menuHeight)),
    });
  };

  useLayoutEffect(() => {
    if (open) {
      placeMenu();
      itemRefs.current[focusOnOpenRef.current]?.focus();
      return;
    }
    // The placement stays while the closed menu fades out where it stood.
    if (!restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const reposition = () => placeMenu();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const dismissOutside = (event) => {
      if (triggerRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return;
      closeMenu(false);
    };
    document.addEventListener("mousedown", dismissOutside);
    document.addEventListener("touchstart", dismissOutside);
    const dismissOnEscape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu(true);
    };
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("mousedown", dismissOutside);
      document.removeEventListener("touchstart", dismissOutside);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [open]);

  const moveFocus = (index) => {
    setRovingIndex(index);
    itemRefs.current[index]?.focus();
  };

  const choose = (item) => {
    closeMenu(true);
    onSwitch(item.key);
  };

  const onItemKeyDown = (event, index, item) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      choose(item);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (index + 1) % items.length
          : (index - 1 + items.length) % items.length;
    moveFocus(nextIndex);
  };

  const activeItem = items[activeIndex];
  const chooserLabel = t("desktopRail.switchHatCurrent", { hat: t(activeItem.labelKey) });
  const compactTooltip = useCompactRailTooltip(true, chooserLabel, triggerRef, open);
  // The prototype's menu motion: it drops in and fades out over .18s, taking
  // no input while it fades.
  const menu = useMenuPresence(open);
  return (
    <div
      ref={boundaryRef}
      className="desktop-rail__hat-switcher desktop-rail__hat-switcher--compact"
      onBlur={(event) => {
        if (!open || event.currentTarget.contains(event.relatedTarget) || menuRef.current?.contains(event.relatedTarget)) return;
        closeMenu(false);
      }}
    >
      <button
        type="button"
        className="desktop-rail__hat-menu-trigger"
        aria-label={chooserLabel}
        {...compactTooltip.controlProps}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => open ? closeMenu(true) : openMenu(activeIndex)}
        onKeyDown={(event) => {
          compactTooltip.controlProps.onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          openMenu(event.key === "ArrowUp" ? items.length - 1 : activeIndex);
        }}
      >
        <span className={`desktop-rail__hat-dot desktop-rail__hat-dot--${activeItem.key}`} aria-hidden="true" />
        <span className="desktop-rail__hat-trigger-caret" aria-hidden="true">›</span>
        {compactTooltip.tooltip}
      </button>
      {menu.shown && (
        <div
          ref={menuRef}
          id={menuId}
          className="desktop-rail__hat-menu"
          data-state={menu.state}
          aria-hidden={menu.closing || undefined}
          inert={menu.closing ? true : undefined}
          onTransitionEnd={menu.onTransitionEnd}
          role="menu"
          aria-label={t("demo.hatsLabel")}
          style={menuPlacement ? { left: `${menuPlacement.left}px`, top: `${menuPlacement.top}px` } : undefined}
          onBlur={(event) => {
            if (event.currentTarget.contains(event.relatedTarget)) return;
            closeMenu(false);
          }}
        >
          {items.map((item, index) => (
            <button
              ref={(node) => { itemRefs.current[index] = node; }}
              key={item.key}
              type="button"
              className="desktop-rail__hat-menuitem"
              role="menuitemradio"
              aria-checked={item.key === active}
              tabIndex={index === rovingIndex ? 0 : -1}
              onClick={() => choose(item)}
              onKeyDown={(event) => onItemKeyDown(event, index, item)}
            >
              <span className={`desktop-rail__hat-dot desktop-rail__hat-dot--${item.key}`} aria-hidden="true" />
              <span>{t(item.labelKey)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function DesktopRail({
  active,
  onNavigate,
  onAsk,
  steward = false,
  staffPlanes = [], // STAFF_PLANES rows for the hats this account can wear
  // Role-derived desk entries: on the SaaS origin
  // the planes above render as plain destinations in a Desks group instead
  // of a hat switcher; the staff rail adds Member as the way back.
  deskEntrances = [],
  activeHat = "member",
  onSwitchHat = null,
  stewardBadges = null,
  badges = null,
  onNotifications = null, // bell in the brand row; renders only when wired
  notifDot = false,
  notifCount = 0, // unread count folded into the bell's accessible name, as on the phone surfaces
  roleLabel = null, // uppercase line under the wordmark; defaults to org line
  user = null, // { name, initials, subtitle } → prototype's footer user card
  workspaceTheme = null, // role-owned shell theme supplied by MemberApp
  renderMode,
  memberId = null,
  demo = false,
  demoNavigation = false,
  // REQ-UG-PROGRESSIVE-DISCLOSURE-AND-FEATURE-DRIP-20261001: the
  // normalized onboarding guide and the member's own "Show everything" choice.
  guide = null,
  guideShowAll = false,
  onGuideShowAllChange = null,
  // REQ-UG-SITE-GUIDE-FOR-REAL-ACCOUNTS-20261001: false only when the
  // organization turned the Site Guide off.
  siteGuide = true,
  // BUG-UG-DUES-NAV-SHOWN-WITHOUT-DUES-20261108: false only when the
  // organization runs no dues (duesNavigation.js); every Dues entry goes.
  dues = true,
  // REQ-UG-USAGE-BASED-NAVIGATION-20261001: device-only usage weights
  // ([{ key, weight }], highest first). Empty keeps the designed order.
  navUsageWeights = null,
  // REQ-UG-NAVIGATION-PINNED-SHORTCUTS-20261030 (finding 89): the
  // member's device-only pins (destination keys, pin order). Pinned places
  // lead the member rail and never join Most used.
  navUsagePins = null,
  // REQ-UG-STAFF-ROLE-PAUSE-AND-RESTORE-CLARITY-20261030 (finding 2):
  // staff roles held but paused for two-step sign-in; the role area says so
  // and links to the Security setup instead of showing nothing.
  staffRolesPaused = false,
  customLinks = [], // REQ-UG-CUSTOM-NAV-LINKS-20261001: [{ key, label, url }]
  // REQ-UG-NAV-LIGHT-IDENTITY-20261102: { open, onToggle, controlsId,
  // triggerId, current: { name, abbreviation } } opens the chapter flyout
  // from this rail, the one desktop rail.
  chapterFlyout = null,
}) {
  const { t } = useLang();
  // The worn identity, always named under the organization so a steward task
  // never reads as Member.
  const roleLabelKey = activeHat === "member"
    ? "demo.hatMember"
    : [...staffPlanes, ...deskEntrances].find((plane) => plane.key === activeHat)?.labelKey ?? null;
  const organizationName = useOrganizationName();
  const knownOrganizationName = useKnownOrganizationName();
  // No parent-union logo: Union Ground ships no union trademarks.
  const orgLine = (text) => <span className="desktop-rail__org">{text}</span>;
  const desktopMode = renderMode === "desktop";
  const liveCollapseKey = memberId ? `sg:member:${memberId}:desktop-main-rail:collapsed` : null;
  const collapseStorage = demo ? availableStorage("sessionStorage") : availableStorage("localStorage");
  const collapseKey = demo ? DEMO_DESKTOP_RAIL_COLLAPSE_KEY : liveCollapseKey;
  const [collapsed, setCollapsed] = useState(() => readStoredCollapse(collapseStorage, collapseKey));
  const compact = desktopMode && collapsed;
  const [, setActiveSection] = useState(currentStaffSection);
  const activeSection = currentStaffSection();
  const homeLabel = t("nav.home");
  const notificationLabel = typeof notifCount === "number"
    ? t("header.notifications", { count: notifCount })
    : t("topbar.notifications");
  const compassLabel = t("nav.compass");
  const compassHint = t(NAV_HINT_KEYS.compass);
  // REQ-UG-NAV-LIGHT-IDENTITY-20261102: the row no longer paints the
  // AI badge, but its accessible name still says it is the AI assistant. The
  // name starts with the visible "Compass", so WCAG 2.5.3 still holds.
  const compassName = `${compassLabel} ${t("shell.compassBadge")}`;
  const compassHintId = useId();
  // REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030 (finding 84): on
  // the member rail the Home link sits right below the logo, so the logo is
  // named for the product instead of a second "Home". A staff desk has no Home
  // link; there the logo stays "Home" (the desk's own start page). The
  // collapsed (compact) rail shows icons only, and its logo button is the
  // Home control its tooltip, keyboard and pointer contracts name, so it keeps
  // "Home" there.
  const brandLabel = activeHat === "member" && !compact ? "Union Ground" : homeLabel;
  // WCAG 2.5.3: each name below starts with the text the control shows, so a
  // speech user can say what they see: the member's name on the expanded
  // profile card and the short collapse label. The UG mark and the avatar
  // initials are drawn (data-glyph), like a logo or photo.
  const profileLabel = t("header.profile");
  const profileName = user && !compact
    ? `${[user.name, user.subtitle].filter(Boolean).join(" ")}, ${profileLabel}`
    : profileLabel;
  const collapseLabel = t(collapsed ? "desktopRail.expand" : "desktopRail.collapse");
  const collapseName = t(collapsed ? "desktopRail.expandShort" : "desktopRail.collapseShort");
  const homeControlRef = useRef(null);
  const itemsListRef = useRef(null);
  // BUG-UG-STAFF-RAIL-LAST-GROUP-HIDDEN-UNDER-FOOTER-20261106: a page
  // opened from elsewhere (a link, a deep address) whose row sits past the
  // fold of the scrolling list was highlighted out of sight. Only the list
  // scrolls, by the least amount, so that row is inside it; while the desk's
  // rows are still arriving it re-checks for a few seconds, and stops at the
  // viewer's first scroll or press in the rail so it never fights them.
  useLayoutEffect(() => {
    const list = itemsListRef.current;
    if (!desktopMode || !list) return undefined;
    //  A-40: the row must also clear the fades painted over the list's
    // edges, the 10px sticky fade at its top and the Command palette strip's
    // shadow (0 -12px 12px, 24px) at its bottom, or it is revealed half under
    // them. Same least-amount scroll, plus the old 8px margin past each fade.
    // A list too short to hold the row and both margins between the fades
    // keeps the list's own edges, as before: aiming past both fades there
    // would push the row from one into the other on every call.
    const reveal = () => {
      const row = list.querySelector('[aria-current="page"]');
      if (!row) return;
      const listBox = list.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      const fitsBetweenFades = rowBox.bottom - rowBox.top + 16
        <= listBox.bottom - listBox.top - RAIL_LIST_TOP_FADE_PX - RAIL_LIST_BOTTOM_FADE_PX;
      const clearBottom = listBox.bottom - (fitsBetweenFades ? RAIL_LIST_BOTTOM_FADE_PX : 0);
      const clearTop = listBox.top + (fitsBetweenFades ? RAIL_LIST_TOP_FADE_PX : 0);
      if (rowBox.bottom > clearBottom) list.scrollTop += rowBox.bottom - clearBottom + 8;
      else if (rowBox.top < clearTop) list.scrollTop -= clearTop - rowBox.top + 8;
    };
    reveal();
    // Rows arrive late (desk data), and the header above grows once the
    // organization's name loads, which shortens the list: either can push the
    // open page's row back out of view.
    const observers = [];
    if (typeof MutationObserver === "function") {
      const mutations = new MutationObserver(reveal);
      mutations.observe(list, { childList: true, subtree: true });
      observers.push(mutations);
    }
    if (typeof ResizeObserver === "function") {
      const resizes = new ResizeObserver(reveal);
      resizes.observe(list);
      observers.push(resizes);
    }
    const stop = () => { for (const observer of observers) observer.disconnect(); };
    const timer = setTimeout(stop, 8000);
    const interactions = ["wheel", "touchstart", "pointerdown", "keydown"];
    for (const name of interactions) list.addEventListener(name, stop, { passive: true });
    return () => {
      stop();
      clearTimeout(timer);
      for (const name of interactions) list.removeEventListener(name, stop);
    };
  }, [active, activeSection, desktopMode]);
  const profileControlRef = useRef(null);
  const collapseControlRef = useRef(null);
  const hatSwitcherFocusedUnmountRef = useRef(false);
  const requestHatSwitcherFocusHandoff = useCallback(() => {
    hatSwitcherFocusedUnmountRef.current = true;
  }, []);
  const homeTooltip = useCompactRailTooltip(compact, brandLabel, homeControlRef);
  const notificationTooltip = useCompactRailTooltip(compact, notificationLabel);
  const compassTooltip = useCompactRailTooltip(compact, compassName);
  const paletteLabel = t("command.title");
  const paletteTooltip = useCompactRailTooltip(compact, paletteLabel);
  const profileTooltip = useCompactRailTooltip(compact, profileLabel, profileControlRef);
  const collapseTooltip = useCompactRailTooltip(compact, collapseName, collapseControlRef);
  // The chapter button names the catalog and the current chapter; compact, it
  // shows only the abbreviation, so it takes the same tooltip as every icon.
  const chaptersName = chapterFlyout?.current ? `${t("chapterRail.title")} ${chapterFlyout.current.name}` : "";
  const chaptersTooltip = useCompactRailTooltip(compact, chaptersName);
  useEffect(() => setCollapsed(readStoredCollapse(collapseStorage, collapseKey)), [collapseKey, collapseStorage]);
  useEffect(() => setActiveSection(currentStaffSection()), [active, activeHat]);
  // Role identities stay visible by their real names. The 2026-07-30 shell
  // consolidation renamed this run "Staff" and replaced Steward with
  // "Casework"; the owner reversed that information-architecture change.
  const visiblePlanes = useMemo(() => staffPlanes.length
    ? staffPlanes
    : steward
      ? [{ key: "steward", view: "steward", labelKey: "demo.hatSteward", path: "/m/steward" }]
      : [], [staffPlanes, steward]);
  const showRoleArea = visiblePlanes.length > 0;
  const memberRail = activeHat === "member";
  // The guided view never applies to the collapsed rail (its escape hatch
  // would have no room to be seen) or without a wired escape hatch.
  const railGuide = memberRail && !compact && onGuideShowAllChange ? guide : null;
  const activePlane = visiblePlanes.find((plane) => plane.key === activeHat) ?? null;
  const activePlaneItems = useMemo(
    // The organize plane has no role navigation; its desk is
    // Union Ground's organizer rail (lib/productIdentity.js). Dues are not
    // offered here, so the dues entry never shows.
    () => activePlane ? visibleStaffNavigation(STAFF_ROLE_NAVIGATION[activePlane.key] ?? (activePlane.key === "organize" ? ORGANIZER_RAIL_ITEMS : []), demoNavigation).filter((item) => dues || item.key !== "dues") : [],
    [activePlane, demoNavigation, dues],
  );
  const unionItems = useMemo(() => dues ? UNION_ITEMS : UNION_ITEMS.filter((item) => item.key !== "dues"), [dues]);
  const hatRows = useMemo(() => [
    { key: "member", labelKey: "demo.hatMember", path: "/m" },
    ...visiblePlanes.map((plane) => ({ key: plane.key, labelKey: plane.labelKey, path: plane.path })),
  ], [visiblePlanes]);
  const showHatSwitcher = Boolean(onSwitchHat) && hatRows.length > 1;
  const previousShowHatSwitcherRef = useRef(showHatSwitcher);
  useLayoutEffect(() => {
    const switcherWasRemoved = previousShowHatSwitcherRef.current && !showHatSwitcher;
    previousShowHatSwitcherRef.current = showHatSwitcher;
    const focusedSwitcherWasRemoved = hatSwitcherFocusedUnmountRef.current;
    hatSwitcherFocusedUnmountRef.current = false;
    if (!switcherWasRemoved || !focusedSwitcherWasRemoved) return;
    const nextFocus = [profileControlRef.current, collapseControlRef.current, homeControlRef.current]
      .find((control) => control?.isConnected);
    nextFocus?.focus();
  }, [compact, desktopMode, showHatSwitcher]);
  // One number on the Steward entry: open steward
  // requests plus the forms inbox, from get_steward_badge_counts — a single
  // chapter-scoped aggregate, never the desk's capped list fetches. Null
  // (RPC absent or degraded) renders no badge rather than a fake zero.
  const caseworkBadge = stewardBadges
    ? (stewardBadges.openRequests ?? 0) + (stewardBadges.formsInbox ?? 0)
    : null;
  // Member-item counts (design: "My cases · 1", "Forms · 1 draft"): derived
  // client-side from data already loaded. Absent counts render no badge.
  const badgeByKey = { ...(badges || {}), steward: caseworkBadge };
  const badgeDetailByKey = {
    steward: stewardBadges ? t("desktopRail.caseworkBadgeDetail", { requests: stewardBadges.openRequests ?? 0, forms: stewardBadges.formsInbox ?? 0 }) : null,
  };
  const shortcutItems = useMemo(() => memberRail
    ? shortcutItemsForHat("member", onAsk, dues)
    : activePlaneItems, [activePlaneItems, memberRail, onAsk, dues]);
  const shortcutStateRef = useRef({ items: shortcutItems, navigate: onNavigate });
  const acknowledgedShortcutStateRef = useRef({ items: shortcutItems, navigate: onNavigate });
  const pendingShortcutHatRef = useRef(null);
  const shortcutRequestIdRef = useRef(0);
  const [shortcutNavigationVersion, setShortcutNavigationVersion] = useState(0);
  // Off until the member turns Keyboard shortcuts on in Settings: no number
  // key fires and no row advertises one.
  const keyboardShortcutsOn = useKeyboardShortcutsEnabled();
  const shortcutNumberByKey = new Map(keyboardShortcutsOn ? shortcutItems.slice(0, 10).map((item, index) => [item.key, index === 9 ? 0 : index + 1]) : []);
  const compassShortcut = shortcutNumberByKey.get("compass") ?? null;
  // The old "Primary" group: the member's most-used destinations MOVE to the
  // top of the member rail (one link per destination, so accessible names
  // stay unique). Home stays put; nothing moves until there is usage.
  const offeredAccountItems = ACCOUNT_ITEMS.filter((item) => siteGuide || item.key !== "site-guide");
  const railMemberItems = [...ME_TOP_ITEMS.filter((item) => item.key !== "today"), ...ME_REST_ITEMS, ...unionItems, ...offeredAccountItems];
  // A pin can name a member destination the rail does not list by default
  // (Events, Open Q&A, Appointments…); it joins the Pinned group from the
  // phone directory so the pin is never silently lost.
  const pinnedItems = memberRail && navUsagePins?.length
    ? pinnedNavItems([
      ...railMemberItems,
      ...FEATURE_GROUPS.flatMap((group) => group.items).filter((item) => item?.path && !item.action
        && (siteGuide || item.key !== "site-guide") && (dues || item.key !== "dues") && !railMemberItems.some((entry) => entry.key === item.key)),
    ], navUsagePins)
    : [];
  const usageGroups = memberRail && navUsageWeights?.length
    ? personalizeNavGroups([
      { key: "meTop", items: ME_TOP_ITEMS.filter((item) => item.key !== "today") },
      { key: "meRest", items: ME_REST_ITEMS },
      { key: "union", items: unionItems },
      { key: "account", items: offeredAccountItems },
    ], navUsageWeights, { pinned: pinnedItems.map((item) => item.viewKey ?? item.key) })
    : [];
  const mostUsedItems = usageGroups[0]?.key === "most-used" ? usageGroups[0].items : [];
  const movedKeys = new Set([...pinnedItems, ...mostUsedItems].map((item) => item.key));
  const notMoved = (item) => !movedKeys.has(item.key);
  // The onboarding guided view applies to the most-used group as well, so a
  // moved destination is held back exactly as it would be in its own group.
  const guidedMostUsed = guidedNavItems(mostUsedItems, railGuide, guideShowAll);
  // A pin is the member's own choice, so the guided onboarding view never
  // holds it back (gate final on).
  const guidedPinned = pinnedItems;
  const shortcutModifier = shortcutModifierLabel();

  useLayoutEffect(() => {
    acknowledgedShortcutStateRef.current = { items: shortcutItems, navigate: onNavigate };
    // App intentionally defers staff-route paint. Until that route commits,
    // an urgent parent render can still carry the previous activeHat; do not
    // let it overwrite the selection made synchronously below. The provisional
    // map survives only while its hat remains authorized and the router is
    // still on the route that accepted switchHat requested.
    const pending = pendingShortcutHatRef.current;
    if (
      pending?.accepted === true
      && pending.key !== activeHat
      && hatRows.some((hat) => hat.key === pending.key && hat.path === pending.path)
      && globalThis.location?.pathname === pending.path
    ) {
      shortcutStateRef.current = pending.acknowledged
        ? { items: pending.items, navigate: onNavigate }
        : acknowledgedShortcutStateRef.current;
      return;
    }
    pendingShortcutHatRef.current = null;
    shortcutStateRef.current = acknowledgedShortcutStateRef.current;
  }, [activeHat, hatRows, onNavigate, shortcutItems]);

  useEffect(() => {
    const cancelPendingShortcut = () => {
      pendingShortcutHatRef.current = null;
      shortcutStateRef.current = acknowledgedShortcutStateRef.current;
    };
    // popstate is synchronous with the history traversal. Reset here instead
    // of waiting for App's route render so a shortcut dispatched immediately
    // after Back/Forward cannot observe the abandoned provisional identity.
    window.addEventListener("popstate", cancelPendingShortcut);
    return () => window.removeEventListener("popstate", cancelPendingShortcut);
  }, []);

  useEffect(() => {
    function onKeyDown(event) {
      // An open modal keeps its own keyboard model (App's "/" handler refuses
      // for the same reason); a window listener is not inerted with the rail.
      if (isEditableShortcutTarget(event.target) || hasOpenModalLayer()) return;
      if (!keyboardShortcutsEnabled()) return;
      const index = railShortcutIndex(event);
      const pending = pendingShortcutHatRef.current;
      if (pending && globalThis.location?.pathname !== pending.path) {
        // pushState is intentionally silent. Validate the pending route at the
        // moment a capability would be used so programmatic navigation cannot
        // leave an abandoned staff map alive without a popstate or render.
        pendingShortcutHatRef.current = null;
        shortcutStateRef.current = acknowledgedShortcutStateRef.current;
      } else if (pending && !pending.acknowledged) {
        shortcutStateRef.current = acknowledgedShortcutStateRef.current;
      }
      const { items, navigate } = shortcutStateRef.current;
      const item = items[index];
      if (!item) return;
      event.preventDefault();
      setShortcutNavigationVersion((version) => version + 1);
      if (item.action) item.action();
      else navigate(item.viewKey ?? item.key, item.path, item.sectionId ?? "");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const itemForRenderMode = (item) => desktopMode && item.key === "tasks"
    ? { ...item, labelKey: "desktopRail.work" }
    : item;
  const switchFromRail = (key) => {
    const requestedHat = hatRows.find((hat) => hat.key === key);
    if (!requestedHat) return;
    // The global listener is deliberately stable. Keep a request-scoped map
    // ready, but expose it only after the authorized parent explicitly
    // acknowledges that its route side effects succeeded. App acknowledges in
    // this same event, before its deferred staff view commits, so a numeric
    // shortcut in the next event already belongs to the selected identity.
    const requestId = shortcutRequestIdRef.current + 1;
    shortcutRequestIdRef.current = requestId;
    pendingShortcutHatRef.current = {
      id: requestId,
      key,
      path: requestedHat.path,
      items: shortcutItemsForHat(key, onAsk, dues, demoNavigation),
      accepted: null,
      acknowledged: false,
    };
    let accepted = false;
    const acknowledge = () => {
      const pending = pendingShortcutHatRef.current;
      if (
        !pending
        || pending.id !== requestId
        || pending.accepted === false
      ) return false;
      if (globalThis.location?.pathname !== pending.path) {
        pendingShortcutHatRef.current = null;
        shortcutStateRef.current = acknowledgedShortcutStateRef.current;
        return false;
      }
      pending.acknowledged = true;
      shortcutStateRef.current = {
        items: pending.items,
        navigate: acknowledgedShortcutStateRef.current.navigate,
      };
      return true;
    };
    try {
      accepted = onSwitchHat(key, acknowledge) === true;
    } finally {
      const pending = pendingShortcutHatRef.current;
      if (pending?.id === requestId) pending.accepted = accepted;
      if (pending?.id === requestId && (!accepted || globalThis.location?.pathname !== requestedHat.path)) {
        pendingShortcutHatRef.current = null;
        shortcutStateRef.current = acknowledgedShortcutStateRef.current;
      } else if (pending?.id === requestId && !pending.acknowledged) {
        // A true return alone is not acknowledgment. Retain only the inert
        // request token so a genuinely delayed explicit acknowledgment can
        // activate it; the rendered hat's map remains authoritative meanwhile.
        shortcutStateRef.current = acknowledgedShortcutStateRef.current;
      }
    }
    if (accepted) setActiveSection("");
  };
  const toggleCollapse = () => {
    const next = !collapsed;
    setCollapsed(next);
    storeCollapse(collapseStorage, collapseKey, next);
  };
  // Desktop and tablet shells hide each desk's header Ask Union Ground
  // button because this rail is the Compass entry. Member already renders
  // it once, inside Me. Every staff hat needs the same control here.
  const compassControl = onAsk ? (
    <button type="button" className="desktop-rail__row" aria-label={compassName} {...compassTooltip.controlProps} {...(!compact ? { "aria-describedby": compassHintId } : {})} aria-haspopup="dialog" aria-keyshortcuts={compassShortcut === null ? undefined : `Control+${compassShortcut} Meta+${compassShortcut}`} title={!compact ? [`${compassLabel}: ${compassHint}`, compassShortcut === null ? null : `Ctrl/⌘+${compassShortcut}`].filter(Boolean).join(" · ") : undefined} onClick={onAsk}>
      <span className="desktop-rail__ic" aria-hidden="true"><RailIcon name={railIconName("compass")} /></span>
      <span className="desktop-rail__ainame">{t("nav.compass")}</span>{" "}
      {!compact && <span id={compassHintId} className="sr-only">{compassHint}</span>}
      {compassShortcut !== null && <ShortcutHint keys={`${shortcutModifier}+${compassShortcut}`} />}
      {compassTooltip.tooltip}
    </button>
  ) : null;
  return (
    <nav
      className="desktop-rail"
      data-workspace-theme={workspaceTheme || undefined}
      data-render-mode={renderMode}
      data-collapsed={desktopMode ? String(collapsed) : undefined}
      aria-label={t("nav.primary")}
    >
      <div className="desktop-rail__brand">
        <button
          type="button"
          className="brand-home"
          aria-label={brandLabel}
          {...homeTooltip.controlProps}
          onClick={() => activePlane
            ? onNavigate(activePlane.view ?? activePlane.key, activePlane.path, "")
            : onNavigate("today", "/m", "")}
        >
          <BrandMark />
          {homeTooltip.tooltip}
        </button>
        <div className="desktop-rail__brand-text">
          <b>{PRODUCT_NAME}</b>
          {/* The wordmark above already names the product, so the plain org
              line appears only when the organization's own name is known. The
              organization's union logo, when its catalog placement gives one,
              leads the line as the organization's own mark. */}
          {roleLabel
            ? orgLine(t("shell.orgLineRole", { organization: organizationName, role: roleLabel }))
            : knownOrganizationName && orgLine(t("shell.orgLine", { organization: knownOrganizationName }))}
          {roleLabelKey && (
            <span className="desktop-rail__role" data-role={activeHat}>
              <span className="desktop-rail__role-mark" aria-hidden="true" />
              {t("shell.workingAs", { role: t(roleLabelKey) })}
            </span>
          )}
        </div>
        {onNotifications && (
          <button
            type="button"
            className="desktop-rail__bell"
            // The dot is aria-hidden, so the count has to live in the
            // accessible name — same contract as MobileTopBar and the phone
            // card-nav row, so one selector finds the bell on every surface.
            aria-label={notificationLabel}
            {...notificationTooltip.controlProps}
            onClick={onNotifications}
          >
            <Bell size={18} aria-hidden="true" />
            {notifDot && <span className="desktop-rail__bell-dot" aria-hidden="true" />}
            {notificationTooltip.tooltip}
          </button>
        )}
      </div>
      {/* Desktop and tablet alike . */}
      {chapterFlyout && chapterFlyout.current && (
        <button
          type="button"
          id={chapterFlyout.triggerId}
          className="desktop-rail__chapters"
          aria-expanded={chapterFlyout.open ? "true" : "false"}
          aria-controls={chapterFlyout.open ? chapterFlyout.controlsId : undefined}
          aria-label={compact ? chaptersName : undefined}
          {...chaptersTooltip.controlProps}
          onClick={chapterFlyout.onToggle}
        >
          <span className="desktop-rail__chapters-abbr" aria-hidden="true" data-glyph={chapterFlyout.current.abbreviation} />
          <span className="desktop-rail__chapters-text">
            <span className="desktop-rail__chapters-label">{t("chapterRail.title")}</span>{" "}
            <span className="desktop-rail__chapters-name">{chapterFlyout.current.name}</span>
          </span>
          {chaptersTooltip.tooltip}
        </button>
      )}
      <div className="desktop-rail__items" ref={itemsListRef}>
        {deskEntrances.length > 0 && !showHatSwitcher && (
          <>
            <span className="desktop-rail__grouplabel">{t("shell.groupDesks")}</span>
            {(memberRail ? [] : [{ key: "today", labelKey: "demo.hatMember", path: "/m" }]).concat(
              deskEntrances.map((plane) => ({ key: plane.key, viewKey: plane.view ?? plane.key, labelKey: plane.labelKey, path: plane.path })),
            ).map((item) => (
              <RailLink key={`desk-${item.key}`} item={item} active={active} activeSection={activeSection} onSection={setActiveSection} onNavigate={onNavigate} compact={compact} />
            ))}
          </>
        )}
        {/* Each hat keeps its owned functions. Authorized member work links
            are repeated in the Work group by the Desktop rail contract; a
            staff hat carries its full desk map. The pinned switcher below is
            always the way between identities, so nothing is stranded. */}
        {memberRail && (
          <>
            {guidedPinned.length > 0 && (
              <>
                <span className="desktop-rail__grouplabel">{t("navUsage.pinnedGroupTitle")}</span>
                {guidedPinned.map((item) => (
                  <RailLink key={item.key} item={item} active={active} activeSection={activeSection} onSection={setActiveSection} onNavigate={onNavigate} badge={badgeByKey[item.key] ?? null} badgeDetail={badgeDetailByKey[item.key] ?? null} shortcutNumber={shortcutNumberByKey.get(item.key) ?? null} shortcutModifier={shortcutModifier} compact={compact} spotlit={isSpotlit(item, railGuide)} />
                ))}
              </>
            )}
            {guidedMostUsed.length > 0 && (
              <>
                <span className="desktop-rail__grouplabel">{t("navUsage.groupTitle")}</span>
                {guidedMostUsed.map((item) => (
                  <RailLink key={item.key} item={item} active={active} activeSection={activeSection} onSection={setActiveSection} onNavigate={onNavigate} badge={badgeByKey[item.key] ?? null} badgeDetail={badgeDetailByKey[item.key] ?? null} shortcutNumber={shortcutNumberByKey.get(item.key) ?? null} shortcutModifier={shortcutModifier} compact={compact} spotlit={isSpotlit(item, railGuide)} />
                ))}
              </>
            )}
            <span className="desktop-rail__grouplabel">{t("shell.groupMe")}</span>
            {guidedNavItems(ME_TOP_ITEMS.filter(notMoved), railGuide, guideShowAll).map((item) => (
              <RailLink key={item.key} item={item} active={active} activeSection={activeSection} onSection={setActiveSection} onNavigate={onNavigate} badge={badgeByKey[item.key] ?? null} badgeDetail={badgeDetailByKey[item.key] ?? null} shortcutNumber={shortcutNumberByKey.get(item.key) ?? null} shortcutModifier={shortcutModifier} compact={compact} spotlit={isSpotlit(item, railGuide)} />
            ))}
            {compassControl}
            {guidedNavItems(ME_REST_ITEMS.filter(notMoved), railGuide, guideShowAll).map((item) => (
              <RailLink key={item.key} item={item} active={active} activeSection={activeSection} onSection={setActiveSection} onNavigate={onNavigate} badge={badgeByKey[item.key] ?? null} badgeDetail={badgeDetailByKey[item.key] ?? null} shortcutNumber={shortcutNumberByKey.get(item.key) ?? null} shortcutModifier={shortcutModifier} compact={compact} spotlit={isSpotlit(item, railGuide)} />
            ))}
          </>
        )}
        {showRoleArea && !memberRail && activePlaneItems.length > 0 && (
          <>
            {compassControl}
            {/* Design file groups: Steward / Casework / Field / Admin /
                Leadership, then Workspace. Destinations stay the backed
                Purple set; only the section labels change. */}
            {staffRailGroups(activePlane.key, activePlaneItems, active).map((group) => (
              <Fragment key={group.labelKey}>
                <span className="desktop-rail__grouplabel">{t(group.labelKey)}</span>
                {group.items.map((item) => {
                  const renderedItem = itemForRenderMode(item);
                  return <RailLink key={item.key} item={renderedItem} active={active} activeSection={activeSection} onSection={setActiveSection} onNavigate={onNavigate} badge={badgeByKey[item.key] ?? null} badgeDetail={badgeDetailByKey[item.key] ?? null} pill={item.key === "tasks" || item.key === activeHat} shortcutNumber={shortcutNumberByKey.get(item.key) ?? null} shortcutModifier={shortcutModifier} compact={compact} />;
                })}
              </Fragment>
            ))}
          </>
        )}
        {memberRail && (
          <>
            <span className="desktop-rail__grouplabel">{t("rail.campaign")}</span>
            {guidedNavItems(unionItems.filter(notMoved), railGuide, guideShowAll).map((item) => (
              <RailLink key={item.key} item={item} active={active} activeSection={activeSection} onSection={setActiveSection} onNavigate={onNavigate} badge={badgeByKey[item.key] ?? null} badgeDetail={badgeDetailByKey[item.key] ?? null} shortcutNumber={shortcutNumberByKey.get(item.key) ?? null} shortcutModifier={shortcutModifier} compact={compact} spotlit={isSpotlit(item, railGuide)} />
            ))}
            <span className="desktop-rail__grouplabel">{t("shell.groupAccount")}</span>
            {guidedNavItems(ACCOUNT_ITEMS.filter((item) => siteGuide || item.key !== "site-guide").filter(notMoved), railGuide, guideShowAll).map((item) => (
              <RailLink key={item.key} item={item} active={active} activeSection={activeSection} onSection={setActiveSection} onNavigate={onNavigate} badge={badgeByKey[item.key] ?? null} badgeDetail={badgeDetailByKey[item.key] ?? null} shortcutNumber={shortcutNumberByKey.get(item.key) ?? null} shortcutModifier={shortcutModifier} compact={compact} spotlit={isSpotlit(item, railGuide)} />
            ))}
            {railGuide && (
              <GuidedNavToggle
                guide={railGuide}
                showAll={guideShowAll}
                hiddenCount={hiddenGuidedNavCount([ME_TOP_ITEMS, ME_REST_ITEMS, unionItems, offeredAccountItems], railGuide)}
                onToggle={onGuideShowAllChange}
                className="desktop-rail__guided-toggle"
              />
            )}
          </>
        )}
        {customLinks.length > 0 && (
          <>
            <span className="desktop-rail__grouplabel">{t("shell.groupLinks")}</span>
            {customLinks.map((link) => <CustomRailLink key={link.key} link={link} compact={compact} />)}
          </>
        )}
      </div>
      {/* The palette's click entry point, on every hat: Control/Command+K
          opens it only with Keyboard shortcuts on, and only then is that
          key advertised here. It sits below the scrolling list rather than
          pinned inside it, so no row or group heading is ever hidden under
          it; the foot wrapper keeps the rail's row styling. */}
      <div className="desktop-rail__items desktop-rail__items--foot">
        <button type="button" className="desktop-rail__row desktop-rail__palette" aria-label={paletteLabel} {...paletteTooltip.controlProps} aria-haspopup="dialog" aria-keyshortcuts={keyboardShortcutsOn ? "Control+K Meta+K" : undefined} title={!compact && keyboardShortcutsOn ? `${paletteLabel} · Ctrl/⌘+K` : undefined} onClick={() => openCommandPalette()}>
          <span className="desktop-rail__ic" aria-hidden="true"><RailIcon name={railIconName("command-palette")} /></span>
          <span className="desktop-rail__label">{paletteLabel}</span>{" "}
          {keyboardShortcutsOn && <ShortcutHint keys={`${shortcutModifier}+K`} />}
          {paletteTooltip.tooltip}
        </button>
      </div>
      {showHatSwitcher && compact && (
        <CompactHatChooser items={hatRows} active={activeHat} onSwitch={switchFromRail} dismissVersion={shortcutNavigationVersion} onFocusedUnmount={requestHatSwitcherFocusHandoff} />
      )}
      {staffRolesPaused && !compact && (
        <p className="desktop-rail__paused" role="status">
          <a href="/m/settings/security" onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onNavigate("settings", "/m/settings/security", ""); }}>{t("desktopRail.staffRolesPaused")}</a>
        </p>
      )}
      {showHatSwitcher && !compact && (
        <ExpandedHatSwitcher items={hatRows} active={activeHat} onSwitch={switchFromRail} onFocusedUnmount={requestHatSwitcherFocusHandoff} />
      )}
      {user && (
        /* On staff hats the planes' own avatars hide under the shell, so this
           card is the profile entrance — a button whenever App wires one. */
        user.onProfile ? (
          <button type="button" className="desktop-rail__user desktop-rail__user--button" aria-label={profileName} {...profileTooltip.controlProps} onClick={user.onProfile}>
            <span className="desktop-rail__user-avatar" aria-hidden="true" data-glyph={user.initials} />
            <span className="desktop-rail__user-text">
              <span className="desktop-rail__user-name">{user.name}</span>{" "}
              {user.subtitle && <span className="desktop-rail__user-sub">{user.subtitle}</span>}
            </span>
            {profileTooltip.tooltip}
          </button>
        ) : (
          <div className="desktop-rail__user">
            <span className="desktop-rail__user-avatar" aria-hidden="true">{user.initials}</span>
            <span className="desktop-rail__user-text">
              <span className="desktop-rail__user-name">{user.name}</span>
              {user.subtitle && <span className="desktop-rail__user-sub">{user.subtitle}</span>}
            </span>
          </div>
        )
      )}
      {desktopMode && (
        <button
          type="button"
          className="desktop-rail__collapse"
          aria-label={collapseName}
          {...collapseTooltip.controlProps}
          title={!compact ? collapseLabel : undefined}
          onClick={toggleCollapse}
        >
          <span className="desktop-rail__collapse-glyph" aria-hidden="true">{collapsed ? <ChevronRight size={14} strokeWidth={1.75} /> : <ChevronLeft size={14} strokeWidth={1.75} />}</span>
          <span className="desktop-rail__collapse-label">{t(collapsed ? "desktopRail.expandShort" : "desktopRail.collapseShort")}</span>
          {collapseTooltip.tooltip}
        </button>
      )}
    </nav>
  );
}
