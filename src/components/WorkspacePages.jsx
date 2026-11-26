import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useLang } from "../lib/LanguageContext.jsx";
import { workspaceOverviewCopyFor } from "../lib/workspaceOverviewCopy.js";
import { STAFF_ROLE_NAVIGATION, staffWorkspaceDestinations, visibleStaffNavigation } from "../lib/staffNavigation.js";
import { STAFF_PLANES } from "../lib/staffPlanes.js";
import { SETTINGS_PAGES, TAB_PAGE_GROUPS, settingsPageGroups, workspacePageForLocation } from "../lib/workspacePages.js";
import { memberCoordinationAliasPath } from "../lib/appRoutes.js";
import { automationContextFromSearch } from "../features/automation/links.js";
import "./workspacePages.css";
import "./routedTabs.css";

const WorkspaceContext = createContext(null);

function routedTabPath(spec, tab, hat) {
  if (spec.view === "coordination" && tab === "network"
      && (hat === "member" || (!hat && memberCoordinationAliasPath()))) {
    return "/m/network";
  }
  return `${spec.base}/${tab}`;
}

export function workspaceHref(path) {
  const target = new URL(path, window.location.origin);
  const current = new URLSearchParams(window.location.search);
  for (const key of ["demo", "embed"]) if (current.has(key)) target.searchParams.set(key, current.get(key));
  const automationPath = /^\/m\/automations(?:\/|$)/;
  // Carry an opaque source context only within the SAME explicitly selected
  // automation workspace. A destination's explicit reference always wins.
  const from = automationPath.test(window.location.pathname);
  const to = automationPath.test(target.pathname);
  if (from && to) {
    const source = automationContextFromSearch(current);
    if (source && !target.searchParams.has("sourceKind") && !target.searchParams.has("sourceId")) {
      target.searchParams.set("sourceKind", source.sourceKind); target.searchParams.set("sourceId", source.sourceId);
    }
    // Definition/run references belong to explicit detail links only. Carrying
    // them implicitly would make "Show all definitions" unable to clear a filter.
  }
  return `${target.pathname}${target.search}`;
}

const NO_HIDDEN_PAGES = Object.freeze([]);

// hiddenPageKeys names pages whose only content is not shown right now (such
// as Settings, Most used places while the organization has that ranking off):
// they leave the menu and the directory, and their URL returns to the overview
// instead of rendering a titled, empty page.
// `menu={false}` drops the page menu where the page draws its own way between
// pages (the alternate shell's prototype pages, REQ-UG-ALT-PORT-MEMBER-PAGES-20261030);
// the section router and context stay.
// `dues={false}` (the organization runs no dues, duesNavigation.js) drops the
// Dues destination from the directory.
export function WorkspacePages({ view, location, navigate, hat, hiddenPageKeys = NO_HIDDEN_PAGES, menu = true, dues = true, demoNavigation = false, children }) {
  const located = workspacePageForLocation(window.location.pathname, window.location.hash);
  const hiddenPage = Boolean(located && hiddenPageKeys.includes(located.key));
  const page = hiddenPage ? null : located;
  const hiddenKey = hiddenPageKeys.join(" ");
  const pages = useMemo(() => {
    const hidden = new Set(hiddenKey.split(" "));
    const list = view === "settings" ? SETTINGS_PAGES : (STAFF_ROLE_NAVIGATION[view] || []).filter((item) => item.sectionId);
    return hiddenKey ? list.filter((item) => !hidden.has(item.key)) : list;
  }, [hiddenKey, view]);
  const navigationPages = useMemo(() => visibleStaffNavigation(pages, demoNavigation), [pages, demoNavigation]);
  // The plane's cross-plane destinations. They are NOT pages of this plane — the
  // page menu and the section router must keep ignoring them — but the plane
  // overview is the only shipped parent a top-level tool route has, so the
  // directory below lists them alongside this plane's own pages.
  const destinations = useMemo(() => view === "settings" ? [] : staffWorkspaceDestinations(STAFF_ROLE_NAVIGATION[view] || [])
    .filter((item) => dues || item.key !== "dues"), [view, dues]);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const open = useCallback((path, nextView = view, replace = false) => {
    let href = workspaceHref(path);
    try {
      const target = new URL(href, window.location.origin);
      const pathname = target.pathname.replace(/\/+$/, "") || "/";
      if (hat === "member" && pathname === "/m/coordination/network") {
        target.pathname = "/m/network";
        href = `${target.pathname}${target.search}`;
      }
    } catch { /* keep workspaceHref result */ }
    navigateRef.current(nextView, href, null, { replace });
  }, [hat, view]);
  const value = useMemo(() => ({ page, section: page?.sectionId || "overview", pages, navigationPages, destinations, view, open, hat }), [page, pages, navigationPages, destinations, view, open, hat]);
  const region = useRef(null);
  const priorLocation = useRef({ view, location });
  useEffect(() => {
    const previous = priorLocation.current;
    priorLocation.current = { view, location };
    const pathname = String(window.location.pathname || "/").replace(/\/+$/, "") || "/";
    if (hiddenPage) {
      open(`/m/${view}`, view, true);
      return;
    }
    // Staff hats share the canonical tab URL. Members stay on /m/network so a
    // reload or fresh SAMPLE context still selects the Member hat.
    if (hat && STAFF_ROLE_NAVIGATION[hat] && view === "coordination" && pathname === "/m/network") {
      open("/m/coordination/network", view, true);
      return;
    }
    if (window.location.hash && page && window.location.pathname !== page.path) open(page.path, view, true);
    const group = page?.group ? TAB_PAGE_GROUPS[page.group] : null;
    if (group && page.tab && window.location.pathname === group.base) {
      // The tab address keeps the link's query (#9524: a Topics link's thread and post).
      open(`${group.base}/${page.tab}${window.location.search}`, view, true);
    }
    // Hat switching restores focus to its own chooser. Only in-workspace
    // navigation should move it to this page's heading.
    if (previous.view !== view || previous.location === location) return;
    // Heading focus announces a page change without moving focus during loads.
    // A page whose tabs sit under one page-wide h1 (Civic, #9971) marks the
    // open tab's title with data-workspace-focus; every other page has none,
    // so its first h1 is focused as before.
    const heading = region.current?.querySelector("[data-workspace-focus]") || region.current?.querySelector("h1");
    heading?.setAttribute("tabindex", "-1");
    heading?.toggleAttribute("data-member-route-heading", hat === "member");
    heading?.focus({ preventScroll: true });
  }, [hat, hiddenPage, location, open, page, view]);
  return <WorkspaceContext.Provider value={value}>
    <div ref={region} className={pages.length ? "workspace-pages" : undefined} data-workspace-section={pages.length ? value.section : undefined} onClick={(event) => {
      const link = event.target.closest?.("a[href]");
      if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const url = new URL(link.href, window.location.origin);
      if (url.origin !== window.location.origin || !url.hash) return;
      const legacy = workspacePageForLocation(url.pathname, url.hash);
      if (legacy && legacy.viewKey === view) { event.preventDefault(); open(legacy.path); }
    }}>
      {menu && navigationPages.length > 0 && <WorkspacePageMenu />}
      {children}
    </div>
  </WorkspaceContext.Provider>;
}

export function useWorkspace() { return useContext(WorkspaceContext); }

export function workspaceListWindow(count, requestedEnd, size = 6) {
  const pages = Math.max(1, Math.ceil(count / size));
  const page = Math.min(pages - 1, Math.max(0, Math.ceil(requestedEnd / size) - 1));
  return { page, pages, start: page * size, end: (page + 1) * size };
}

export function workspaceListRows(rows, end, bounded) {
  const window = workspaceListWindow(rows.length, end);
  return bounded ? rows.slice(window.start, window.end) : rows.slice(0, end);
}

export function WorkspaceListPager({ count, end, onChange, children = null }) {
  const context = useWorkspace();
  const { t } = useLang();
  if (!context) return children;
  const window = workspaceListWindow(count, end);
  if (window.pages === 1) return null;
  return <nav className="workspace-list-pager" aria-label={t("workspace.resultsPages")}>
    <button type="button" disabled={window.page === 0} onClick={() => onChange(window.start)}>{t("workspace.previous")}</button>
    <span role="status">{t("workspace.pageOf", { page: window.page + 1, pages: window.pages })}</span>
    <button type="button" disabled={window.page + 1 === window.pages} onClick={() => onChange(window.end + 6)}>{t("workspace.next")}</button>
  </nav>;
}

// Unselected sections return null before their child components mount. This is
// routing, not CSS concealment; their forms, effects and live regions are absent.
export function WorkspaceSection({ name, children }) {
  const context = useWorkspace();
  return !context || (Array.isArray(name) ? name.includes(context.section) : context.section === name) ? children : null;
}

export function useWorkspaceTitle(fallback) {
  const context = useWorkspace();
  const { t } = useLang();
  if (!context) return fallback;
  const parent = context.pages.find((item) => item.sectionId === context.section);
  return parent ? t(parent.labelKey) : fallback;
}

// UB-UG-STAFF-DESK-FIRST-CARD-REPEATS-PAGE-TITLE-20261106: a focused
// page already names itself in the page band, so a card title in the same
// words said it twice. The card keeps its explanatory line and count; overview
// pages and screens without workspace pages keep the title. A title the card
// is labelled by (aria-labelledby) stays in the tree, hidden, so the region
// keeps its name.
// The Admin, President and Settings pages take the same rule
// (UX-UG-PAGE-TITLE-PRINTED-TWICE-AND-ADMIN-PAGES-MISLABELLED-CHAPTER-TOOLS-20261122)
// with `outline`: there the repeated title stays as a visually hidden h2, so
// a screen reader's heading list still runs h1, h2, h3 without a gap.
export function WorkspaceCardTitle({ as: Tag = "h2", outline = false, children, ...props }) {
  const pageTitle = useWorkspaceTitle(null);
  if (pageTitle && pageTitle === children) {
    if (outline) return <h2 id={props.id} className="visually-hidden">{children}</h2>;
    return props.id ? <span id={props.id} hidden>{children}</span> : null;
  }
  return <Tag {...props}>{children}</Tag>;
}

// A card head whose only words are its title. On
// the page that title names, the head is not drawn: the title stays in the
// card as a visually hidden h2, so the outline keeps it and no empty bar or
// lone icon is left. A stylesheet rule that hid the emptied head with
// display: none took the h2 out of the screen-reader heading list with it.
export function WorkspaceCardHead({ title, id, children }) {
  const pageTitle = useWorkspaceTitle(null);
  if (pageTitle && pageTitle === title) return <h2 id={id} className="visually-hidden">{title}</h2>;
  return children;
}

function pageLinkClick(event, path, onOpen) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  onOpen(path);
}

// UX-UG-STAFF-DESK-PAGE-MENU-RAW-BROWSER-SELECT-20261108: the page
// jump was a bare browser select. It is now a pill button, styled like the
// phone role switcher, that discloses the pages as ordinary links (the
// disclosure navigation pattern: Tab walks the links, Escape closes and
// returns to the button). The closed list stays in the DOM, hidden.
function WorkspacePagePicker({ pages, view, selected, onOpen }) {
  const { t } = useLang();
  const listId = useId();
  const triggerRef = useRef(null);
  const pickerRef = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const restoreFocusRef = useRef(false);
  const close = (restoreFocus) => { restoreFocusRef.current = restoreFocus; setExpanded(false); };
  useLayoutEffect(() => {
    if (expanded || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [expanded]);
  useLayoutEffect(() => {
    if (!expanded) return undefined;
    const dismissOutside = (event) => { if (!pickerRef.current?.contains(event.target)) close(false); };
    const dismissEscape = (event) => {
      // Escape belongs to this menu only while focus is in it (or nowhere:
      // Safari does not focus a clicked button); another open layer keeps
      // its own Escape.
      const focus = document.activeElement;
      if (event.key !== "Escape" || (focus && focus !== document.body && !pickerRef.current?.contains(focus))) return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener("mousedown", dismissOutside);
    document.addEventListener("touchstart", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    return () => {
      document.removeEventListener("mousedown", dismissOutside);
      document.removeEventListener("touchstart", dismissOutside);
      document.removeEventListener("keydown", dismissEscape);
    };
  }, [expanded]);
  const currentPath = selected?.path || `/m/${view}`;
  const link = (path, labelKey) => <li key={path}>
    <a href={workspaceHref(path)} aria-current={path === currentPath ? "page" : undefined} onClick={(event) => pageLinkClick(event, path, (target) => {
      // The current page is no page change, so no new heading takes focus:
      // return it to the button instead of the now hidden link.
      close(target === currentPath);
      onOpen(target);
    })}>{t(labelKey)}</a>
  </li>;
  return <div ref={pickerRef} className="workspace-page-menu__picker" onBlur={(event) => {
    if (expanded && !event.currentTarget.contains(event.relatedTarget)) close(false);
  }}>
    <button ref={triggerRef} type="button" className="workspace-page-menu__trigger" aria-expanded={expanded} aria-controls={listId} onClick={() => expanded ? close(true) : setExpanded(true)}>
      <span className="workspace-page-menu__label">{t("workspace.page")}</span>{" "}
      <span className="workspace-page-menu__value">{selected ? t(selected.labelKey) : t("workspace.overview")}</span>
      <ChevronDown aria-hidden="true" size={16} strokeWidth={2.25} />
    </button>
    <div id={listId} className="workspace-page-menu__panel" hidden={!expanded}>
      <ul>{link(`/m/${view}`, "workspace.overview")}</ul>
      {view === "settings" ? settingsPageGroups(pages).map((group, index) => <div key={group.labelKey} role="group" aria-labelledby={`${listId}-${index}`}>
        <p id={`${listId}-${index}`} className="workspace-page-menu__group">{t(group.labelKey)}</p>
        <ul>{group.pages.map((item) => link(item.path, item.labelKey))}</ul>
      </div>) : <ul>{pages.map((item) => link(item.path, item.labelKey))}</ul>}
    </div>
  </div>;
}

export function WorkspacePageMenu() {
  const { t } = useLang();
  const { pages, navigationPages, section, view, open, hat } = useWorkspace();
  const selected = pages.find((item) => item.sectionId === section);
  // A staff plane's pages are the desktop and tablet rail's own rows for the
  // hat being worn, so on those shells this menu would only repeat the rail
  // above the desk title (same record); the stylesheet drops it there.
  const railListed = hat === view && Boolean(STAFF_ROLE_NAVIGATION[view]);
  // The first STAFF_ROLE_NAVIGATION row is the overview page, whose label equals
  // the plane h1. Name the hat/plane here so the crumb does not repeat that title.
  const planeLabelKey = STAFF_PLANES.find((plane) => plane.view === view)?.labelKey;
  const overview = section === "overview";
  // UB-UG-WORKSPACE-OVERVIEW-COUNTS-AND-PAGE-MENU-20261106: a
  // workspace without a plane name (member Settings "More") showed "Overview /
  // Overview" on its overview, so there the crumb is dropped and the menu
  // stays alone, still the one-tap jump to any page on a phone. Staff planes
  // keep "Steward / Overview": the crumb names the hat.
  const crumbRepeatsMenu = overview && !planeLabelKey;
  return <nav className="workspace-page-menu" aria-label={t("workspace.pageMenu")} data-rail-listed={railListed ? "true" : undefined}>
    {!crumbRepeatsMenu && <>
      <a className="workspace-page-menu__crumb" href={workspaceHref(`/m/${view}`)} onClick={(event) => pageLinkClick(event, `/m/${view}`, open)}>{planeLabelKey ? t(planeLabelKey) : t("workspace.overview")}</a>
      <span className="workspace-page-menu__sep" aria-hidden="true">/</span>
    </>}
    <WorkspacePagePicker pages={navigationPages} view={view} selected={selected} onOpen={open} />
  </nav>;
}

export function WorkspaceOverview() {
  const context = useWorkspace();
  const { t, lang } = useLang();
  if (!context || context.section !== "overview") return null;
  const chunks = [];
  if (context.view === "admin") {
    const groups = new Map();
    for (const page of context.navigationPages) {
      const key = /automation|evidence/.test(page.sectionId) ? "tools"
        : /access|mfa|invitations|signin|failed-logins/.test(page.sectionId) ? "access"
          : /member|organization$|configuration|labels|lifecycle/.test(page.sectionId) ? "people"
            : /events|form|rewards|appointments/.test(page.sectionId) ? "programs" : "governance";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(page);
    }
    for (const key of ["tools", "people", "access", "programs", "governance"]) if (groups.has(key)) chunks.push({ title: t(`workspace.${key}`), pages: groups.get(key) });
  } else if (context.view === "settings") {
    chunks.push(...settingsPageGroups(context.navigationPages).map((group) => ({ title: t(group.labelKey), pages: group.pages })));
  } else {
    for (let index = 0; index < context.navigationPages.length; index += 6) {
      const pages = context.navigationPages.slice(index, index + 6);
      chunks.push({ title: pages.slice(0, 2).map((page) => t(page.labelKey)).join(" · "), pages });
    }
  }
  // Last, and as their own disclosure: the workspaces this plane links to but
  // does not own. They open under their own plane view, exactly as the desktop
  // rail opens them, so the destination still selects the right hat/plane.
  if (context.destinations?.length) chunks.push({ title: t("shell.groupWorkspace"), pages: context.destinations });
  return <nav className="workspace-directory" aria-label={t("workspace.directory")}>
    <p>{workspaceOverviewCopyFor(lang).help}</p>
    {chunks.map(({ title, pages }) => <details key={pages[0].key}>
      {/* A heading for its pages, not a site-map count (same record). */}
      <summary>{title}</summary>
      <div>{pages.map((page) => <a key={page.key} href={workspaceHref(page.path)} onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); context.open(page.path, page.viewKey || context.view);
      }}>{t(page.labelKey)} <span aria-hidden="true">→</span></a>)}</div>
    </details>)}
  </nav>;
}

// Retains isolated component use while making application tabs real history
// entries. The route registry, not arbitrary URL text, supplies the tab value.
export function useRoutedTab(group, fallback) {
  const context = useWorkspace();
  const [local, setLocal] = useState(fallback);
  const spec = TAB_PAGE_GROUPS[group];
  const inView = context && context.view === spec.view;
  const value = inView ? context.page?.group === group ? context.page.tab : fallback : local;
  const setValue = useCallback((next) => {
    const tab = typeof next === "function" ? next(value) : next;
    if (!spec.tabs.includes(tab)) return;
    if (!inView) { setLocal(tab); return; }
    // Idempotent on location. Tab handlers fire unconditionally — a group
    // sitting on its BASE url already renders its default tab, so a "skip the
    // current tab" guard swallows the click on that tab's own href and strands
    // the member on /m/<group>. history.pushState never dedupes, so without
    // this re-selecting the tab the address bar already shows would stack an
    // identical entry and make the next Back look inert.
    const target = routedTabPath(spec, tab, context.hat);
    if ((String(window.location.pathname || "/").replace(/\/+$/, "") || "/") === target) return;
    context.open(target);
  }, [context, inView, spec, value]);
  return [value, setValue];
}

const NO_HIDDEN_TABS = Object.freeze([]);

// `hidden` leaves tabs out of the strip (a feature held for its release date).
// With `redirectHidden`, a page opened on a hidden tab moves to the first shown
// tab, replacing the history entry.
export function RoutedTabPages({ group, labels, hidden = NO_HIDDEN_TABS, redirectHidden = false }) {
  const context = useWorkspace();
  const spec = TAB_PAGE_GROUPS[group];
  const tabs = spec.tabs.filter((tab) => !hidden.includes(tab));
  const active = context?.page?.tab || spec.tabs[0];
  const redirect = redirectHidden && context && context.page?.group === group && hidden.includes(active) && tabs.length
    ? routedTabPath(spec, tabs[0], context.hat)
    : null;
  useEffect(() => {
    if (redirect) context.open(redirect, context.view, true);
  }, [context, redirect]);
  if (!context) return null;
  return <nav className="workspace-subpages" aria-label={labels.title}>
    {tabs.map((tab) => <a key={tab} href={workspaceHref(routedTabPath(spec, tab, context.hat))} aria-current={active === tab ? "page" : undefined} onClick={(event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); context.open(routedTabPath(spec, tab, context.hat));
    }}>{labels[tab]}</a>)}
  </nav>;
}

export function WorkspaceTabSection({ group, name, children }) {
  const context = useWorkspace();
  const spec = TAB_PAGE_GROUPS[group];
  const active = context?.page?.group === group ? context.page.tab : spec.tabs[0];
  return !context || active === name ? children : null;
}

export function RoutedTabLink({ group, value, children, onClick, ...props }) {
  const context = useWorkspace();
  if (!context) return <button {...props} type={props.type || "button"} className={`workspace-routed-tab ${props.className || ""}`} onClick={onClick}>{children}</button>;
  const spec = TAB_PAGE_GROUPS[group];
  const current = context.page?.group === group ? context.page.tab : spec.tabs[0];
  const selected = props["aria-selected"] ?? props["aria-pressed"] ?? (current === value);
  const linkProps = { ...props };
  delete linkProps.type;
  delete linkProps.disabled;
  delete linkProps["aria-pressed"];
  if (props.role !== "tab") {
    delete linkProps["aria-selected"];
    delete linkProps["aria-controls"];
    delete linkProps.role;
    delete linkProps.tabIndex;
  }
  return <a {...linkProps} className={`workspace-routed-tab ${props.className || ""}`} href={props.disabled ? undefined : workspaceHref(routedTabPath(spec, value, context.hat))} aria-current={selected ? "page" : undefined} aria-disabled={props.disabled || undefined} onKeyDown={(event) => {
    props.onKeyDown?.(event);
    if (!event.defaultPrevented && event.key === " " && props.role === "tab") {
      event.preventDefault(); event.currentTarget.click();
    }
  }} onClick={(event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (props.disabled) return;
    // The caller's handler owns the hop. A post-handler "did the pathname
    // move?" fallback cannot tell a handler that declined to navigate from one
    // that navigates asynchronously (TasksView defers its commit inside
    // document.startViewTransition), so it double-pushed the same route and
    // left the first Back inert. useRoutedTab is idempotent on location
    // instead, which keeps a BASE-url default tab landing on its own href.
    if (onClick) onClick(event);
    else context.open(routedTabPath(spec, value, context.hat));
  }}>{children}</a>;
}
