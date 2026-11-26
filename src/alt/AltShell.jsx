import { BusyButton } from "../components/BusyControls.jsx";
// The alternate shell's chrome (REQ-UG-ALT-SHELL-FOUNDATION-20261015):
// the October 10, 2026 design's side navigation, narrow-screen header and
// menu sheet, chapter-rail flyout and footer, wrapped around
// whatever App.jsx renders in its main landmark. App keeps every session, authorization,
// routing and data concern; this component only decides how the chrome looks
// and calls the same navigate/switch handlers the classic rail calls.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { registerEscapeLayer } from "../lib/escapeLayers.js";
import { keyboardShortcutsEnabled, useKeyboardShortcutsEnabled } from "../lib/keyboardShortcuts.js";
import { openCommandPalette, shortcutModifierLabel } from "../lib/commandPalette.js";
import { personalizeNavGroups } from "../features/memberHome/navUsage.js";
import { CLASSIC_SHELL, SHELL_QUERY_PARAM } from "./altShell.js";
import { AltShellContext } from "./altShellContext.js";
import { BrandMark, ChapterAvatar, chapterRowLabel, Icon } from "./icons.jsx";
import { formatEasternClock } from "./format.js";
import { TooltipLayer } from "./motion.jsx";
import { AltToast } from "./popups/AltToast.jsx";
import { currentNavKey, memberNavGroups, staffNavGroups } from "./nav.js";
import "./styles/design.css";
import "./styles/shell.css";
import "./styles/legacy-adapter.css";
import "./styles/messages.css";
import "./styles/work.css";
import "./styles/pages.css";
import "./styles/pages-takepart.css";
import "./styles/pages-record.css";
import "./styles/pages-help.css";
import "./styles/popups.css";

const WIDE_QUERY = "(min-width:1081px)";

function useWideScreen() {
  const query = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(WIDE_QUERY) : null);
  const [wide, setWide] = useState(() => Boolean(query()?.matches));
  useEffect(() => {
    const media = query();
    if (!media) return undefined;
    const update = () => setWide(Boolean(media.matches));
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return wide;
}

// A key typed into a field (or an editable region) is text, not a shortcut.
const typingTarget = (target) => target instanceof Element && Boolean(target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));

const plainClick = (event) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

export default function AltShell({
  active,
  activePath = "",
  onNavigate,
  onSwitchShell = null,
  tabWork = null,
  onSearch = null,
  onAsk = null,
  onNotifications = null,
  notifCount = 0,
  user = null,
  activeHat = "member",
  hatOptions = [],
  onSwitchHat = null,
  chapters = [],
  selectedChapterId = null,
  onSelectChapter = null,
  chapterBusy = false,
  badges = {},
  customLinks = [],
  navUsageWeights = null,
  siteGuide = true,
  dues = true,
  demoNavigation = false,
  toast = null,
  children,
}) {
  const { t, lang } = useLang();
  const wide = useWideScreen();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [railQuery, setRailQuery] = useState("");
  const [clock, setClock] = useState(() => new Date());
  const sheetRef = useRef(null);
  const sideRef = useRef(null);
  const headerRef = useRef(null);
  const bodyRef = useRef(null);
  const footerRef = useRef(null);
  const railRef = useRef(null);
  const railInputRef = useRef(null);
  const railOpenerRef = useRef(null);
  const menuButtonRef = useRef(null);
  const skipRef = useRef(null);
  const tabbarRef = useRef(null);

  // Same offer as the classic rail: a worn staff hat gets its plane pages and
  // tools plus the way back to Member (member destinations are refused by the
  // hat gate, so they are not advertised); the member hat gets the member
  // groups in the usage-based order the classic rail restores from the same
  // weights, Home staying put.
  const memberHat = activeHat === "member";
  // Off until the member turns Keyboard shortcuts on in Settings.
  const keyboardShortcutsOn = useKeyboardShortcutsEnabled();
  const groups = useMemo(() => {
    if (activeHat !== "member") {
      return [
        ...(onSwitchHat ? [{ key: "memberHome", items: [{ key: "today", labelKey: "demo.hatMember", path: "/m", icon: "home", action: () => onSwitchHat("member") }] }] : []),
        ...staffNavGroups(t, activeHat, { dues, demoNavigation }),
      ];
    }
    const member = memberNavGroups(t, badges, { siteGuide, dues });
    return navUsageWeights?.length
      ? personalizeNavGroups(member, navUsageWeights, { primary: { key: "most-used", label: t("navUsage.groupTitle") } })
      : member;
  }, [t, badges, activeHat, siteGuide, dues, demoNavigation, navUsageWeights, onSwitchHat]);
  const currentKey = useMemo(() => currentNavKey(groups, active, activePath), [groups, active, activePath]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 20_000);
    return () => window.clearInterval(timer);
  }, []);

  // Focus restoration after closing a drawer runs before the inert effect
  // re-runs, so the isolation is released synchronously first; the effect
  // re-applies whatever the next state needs.
  const releaseIsolation = useCallback(() => {
    for (const ref of [skipRef, sideRef, headerRef, bodyRef, footerRef, tabbarRef, sheetRef]) ref.current?.removeAttribute("inert");
  }, []);

  const closeSheet = useCallback(() => {
    setSheetOpen(false);
    setRailOpen((open) => (wide ? open : false));
  }, [wide]);

  const closeRail = useCallback((restoreFocus = false) => {
    setRailOpen(false);
    if (restoreFocus) {
      releaseIsolation();
      // Whatever opened the rail (a side-nav row, the sheet's row or a page
      // control such as Change chapters) gets focus back; the sheet's row is
      // the fallback only while the sheet is the surface underneath.
      const stored = railOpenerRef.current;
      const opener = stored?.isConnected ? stored : document.querySelector(wide ? "#ug-side [data-ug-rail-opener]" : "#ug-msheet [data-ug-rail-opener]");
      opener?.focus();
    }
  }, [wide, releaseIsolation]);

  const openRail = useCallback(() => {
    railOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRailQuery("");
    setRailOpen(true);
  }, []);

  const openMenu = useCallback(() => {
    // The desktop directory is already visible; the narrow sheet is hidden
    // by design.css there, so opening it would only make the page inert.
    if (wide) {
      const nav = sideRef.current?.querySelector(".ug-side-nav");
      nav?.scrollTo?.(0, 0);
      nav?.querySelector("a, button")?.focus();
      return;
    }
    setSheetOpen(true);
  }, [wide]);

  // `inert` is toggled on the element itself: React 18 knows no boolean inert
  // and React 19 drops an empty string, so the attribute is managed directly.
  // A closed sheet or rail is inert; the sheet is also inert while the rail
  // sits over it on a narrow screen.
  useEffect(() => { sheetRef.current?.toggleAttribute("inert", !sheetOpen || (railOpen && !wide)); }, [sheetOpen, railOpen, wide]);
  useEffect(() => { railRef.current?.toggleAttribute("inert", !railOpen); }, [railOpen]);
  // A modal drawer (the sheet, or the rail on a narrow screen) isolates the
  // page under it: the skip link, header, side nav, main and footer go inert
  // (the shell owns the skip link for that reason), so Tab stays
  // inside the drawer and the scrim, Escape and the close control end it.
  useEffect(() => {
    const modal = sheetOpen || (railOpen && !wide);
    for (const ref of [skipRef, sideRef, headerRef, bodyRef, footerRef, tabbarRef]) ref.current?.toggleAttribute("inert", modal);
  }, [sheetOpen, railOpen, wide]);

  // REQ-UG-ALT-PORT-SHELL-MOTION-HOME-20261030: the prototype's phone
  // tab bar (ws-data.js UG.tabbar) for a signed-in visitor. design.css shows
  // it below the desktop layout only and pads the page for it through the
  // root's ug-has-tabbar class, which the shell owns while it is mounted.
  const tabbar = Boolean(user);
  useEffect(() => {
    const root = tabbarRef.current?.closest(".ugalt") ?? headerRef.current?.closest(".ugalt");
    if (!root) return undefined;
    root.classList.toggle("ug-has-tabbar", tabbar);
    return () => root.classList.remove("ug-has-tabbar");
  }, [tabbar]);

  // Navigation closes the drawers; the page under them is what changed.
  useEffect(() => { setSheetOpen(false); setRailOpen(false); }, [active]);

  // Leaving the narrow layout drops the sheet; the side nav is always visible there.
  useEffect(() => { if (wide) setSheetOpen(false); }, [wide]);

  useEffect(() => {
    if (!sheetOpen) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => sheetRef.current?.querySelector(".ug-side-x")?.focus(), 50);
    return () => { document.body.style.overflow = previous; window.clearTimeout(timer); };
  }, [sheetOpen]);

  useEffect(() => {
    if (!railOpen) return undefined;
    const timer = window.setTimeout(() => (wide ? railInputRef.current : railRef.current?.querySelector(".ug-rail-x"))?.focus({ preventScroll: true }), 40);
    const onPointerDown = (event) => {
      if (!wide) return;
      if (event.target.closest("#ug-rail, [data-ug-rail-opener], .ug-scrim, .ug-toast")) return;
      setRailOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => { window.clearTimeout(timer); document.removeEventListener("pointerdown", onPointerDown); };
  }, [railOpen, wide]);

  useEffect(() => {
    if (!sheetOpen && !railOpen) return undefined;
    return registerEscapeLayer(() => {
      if (railOpen) { closeRail(true); return; }
      setSheetOpen(false);
      releaseIsolation();
      menuButtonRef.current?.focus();
    }, { modal: sheetOpen || !wide });
  }, [sheetOpen, railOpen, wide, closeRail, releaseIsolation]);

  // The prototype opens its search with "/" from anywhere that is not a
  // field (core.js), the key the side search button advertises; here it
  // opens the same search the button does. Not while a dialog is open.
  useEffect(() => {
    if (!onSearch || !memberHat) return undefined;
    const onKey = (event) => {
      if (event.key !== "/" || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!keyboardShortcutsEnabled()) return;
      if (typingTarget(event.target) || document.querySelector("[aria-modal='true']:not(#ug-msheet, #ug-rail)")) return;
      event.preventDefault();
      setSheetOpen(false);
      onSearch();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onSearch, memberHat]);

  const go = useCallback((item) => (event) => {
    if (event && !plainClick(event)) return;
    event?.preventDefault();
    setSheetOpen(false);
    setRailOpen(false);
    // Bare paths: App.navigate adds the demo rider and the ?shell= choice.
    onNavigate?.(item.viewKey ?? item.key, item.path, item.sectionId ?? "");
  }, [onNavigate]);

  const pickChapter = useCallback((chapter, trigger) => {
    setRailOpen(false);
    setSheetOpen(false);
    // The current chapter opens too (its workspace in the demo, its page
    // live), as the classic rail's row does.
    onSelectChapter?.(chapter, trigger);
  }, [onSelectChapter]);

  // No selector (the demo below its desktop layout) means no rail to offer:
  // pages then show no Change-chapters control at all.
  const context = useMemo(() => ({ openRail: onSelectChapter ? openRail : null, openMenu, closeAll: () => { setSheetOpen(false); setRailOpen(false); } }), [onSelectChapter, openRail, openMenu]);

  const label = (item) => item.label ?? t(item.labelKey);

  const renderItem = (item) => item.action ? (
    <button key={item.key} type="button" className="ug-side-link" onClick={() => { setSheetOpen(false); setRailOpen(false); item.action(); }}>
      <Icon name={item.icon} />
      <span className="ug-t">{label(item)}</span>
    </button>
  ) : (
    <a
      key={item.key}
      className="ug-side-link"
      href={item.path}
      aria-current={item.key === currentKey ? "page" : undefined}
      onClick={go(item)}
    >
      <Icon name={item.icon} />
      <span className="ug-t">{label(item)}</span>
      {item.badge ? <span className="ug-side-badge">{item.badge}</span> : null}
    </a>
  );

  const currentChapter = chapters.find((chapter) => chapter.id === selectedChapterId) ?? null;
  const chapterBlock = (
    <>
      <div className="ug-side-label">
        {t("altShell.yourChapters")}
        {chapters.length > 1 && onSelectChapter ? <button type="button" className="ug-side-edit" onClick={openRail}>{t("altShell.change")}</button> : null}
      </div>
      <div className="ug-side-chs">
        {onSelectChapter ? chapters.slice(0, 4).map((chapter) => (
          <BusyButton
            key={chapter.id}
            type="button"
            className="ug-side-link"
            title={chapter.name}
            aria-current={chapter.id === selectedChapterId ? "page" : undefined}
            pending={chapterBusy}
            onClick={(event) => pickChapter(chapter, event.currentTarget)}
          >
            <ChapterAvatar chapter={chapter} size="av-xs" />
            <span className="ug-t">{chapterRowLabel(chapter)}</span>
          </BusyButton>
        )) : currentChapter ? (
          // No selector here (the demo below its desktop layout): the current
          // chapter's link to its page, not rows that cannot select.
          <a className="ug-side-link" href="/m/organize" title={currentChapter.name} onClick={go({ key: "hub", path: "/m/organize" })}>
            <ChapterAvatar chapter={currentChapter} size="av-xs" />
            <span className="ug-t">{chapterRowLabel(currentChapter)}</span>
          </a>
        ) : null}
      </div>
      {chapters.length > 1 && onSelectChapter ? (
        <button
          type="button"
          className={`ug-side-link ug-side-switch${railOpen ? " ug-here" : ""}`}
          data-ug-rail-opener=""
          aria-expanded={railOpen}
          aria-controls="ug-rail"
          onClick={() => (railOpen ? closeRail(true) : openRail())}
        >
          <Icon name="swap" /><span className="ug-t">{t("altShell.switchChapter")}</span><Icon name="right" className="ug-chev" />
        </button>
      ) : null}
    </>
  );

  const hatBlock = hatOptions.length > 1 && onSwitchHat ? (
    <>
      <div className="ug-side-label">{t("altShell.groupHats")}</div>
      {hatOptions.map((hat) => (
        <button
          key={hat.key}
          type="button"
          className="ug-side-link"
          aria-current={hat.key === activeHat ? "page" : undefined}
          onClick={() => { setSheetOpen(false); onSwitchHat(hat.key); }}
        >
          <Icon name={hat.key === "member" ? "user" : "briefcase"} /><span className="ug-t">{hat.label}</span>
        </button>
      ))}
    </>
  ) : null;

  const linksBlock = customLinks.length ? (
    <>
      <div className="ug-side-label">{t("altShell.groupLinks")}</div>
      {customLinks.map((link) => (
        <a key={link.key} className="ug-side-link" href={link.url} target="_blank" rel="noopener noreferrer">
          <Icon name="ext" /><span className="ug-t">{link.label}</span>
        </a>
      ))}
    </>
  ) : null;

  const side = (drawer) => (
    <>
      <div className="ug-side-head">
        <a className="ug-brand" href="/m" aria-label="Union Ground" onClick={go({ key: "today", path: "/m" })}>
          <BrandMark /><span>Union Ground<small>{t("altShell.brandTag")}</small></span>
        </a>
        {drawer ? <button className="ug-icon-btn ug-side-x" type="button" onClick={closeSheet} aria-label={t("altShell.closeMenu")}><Icon name="x" /></button> : null}
      </div>
      {onSearch && memberHat ? (
        <button className="ug-side-search" type="button" onClick={() => { setSheetOpen(false); onSearch(); }} aria-label={t("altShell.search")}>
          <Icon name="search" /><span>{t("altShell.search")}</span>{keyboardShortcutsOn ? <kbd aria-hidden="true">/</kbd> : null}
        </button>
      ) : null}
      {/* The command palette's click entry point, on every hat; its
          Control/Command+K key works and shows only with Keyboard shortcuts on. */}
      <button className="ug-side-commands" type="button" onClick={() => { setSheetOpen(false); openCommandPalette(); }} aria-haspopup="dialog" aria-keyshortcuts={keyboardShortcutsOn ? "Control+K Meta+K" : undefined}>
        <Icon name="search" /><span>{t("command.title")}</span>{keyboardShortcutsOn ? <kbd aria-hidden="true">{shortcutModifierLabel()}+K</kbd> : null}
      </button>
      <nav className="ug-side-nav" aria-label={drawer ? t("altShell.menu") : t("altShell.mainNav")}>
        {groups.map((group, index) => (
          <div key={group.key}>
            {group.label ? (
              <div className="ug-side-label">
                {group.label}
                {group.lock ? <span className="ug-side-lock"><Icon name="lock" />{t("altShell.privateTag")}</span> : null}
              </div>
            ) : null}
            {group.items.map(renderItem)}
            {index === 0 ? chapterBlock : null}
          </div>
        ))}
        {hatBlock}
        {linksBlock}
      </nav>
      <div className="ug-side-foot">
        {user ? (
          <button type="button" className="ug-side-link ug-side-user" onClick={() => { setSheetOpen(false); user.onProfile?.(); }}>
            <span className="ug-person">{user.initials}</span>
            <span className="ug-t"><b>{user.name}</b><small>{t("altShell.myUnion")}</small></span>
          </button>
        ) : null}
        {onNotifications ? (
          <button type="button" className="ug-side-link ug-side-bell" onClick={() => { setSheetOpen(false); onNotifications(); }} aria-label={notifCount > 0 ? t("altShell.notificationsCount", { count: notifCount }) : t("altShell.notifications")}>
            <Icon name="bell" /><span className="ug-t">{t("altShell.notifications")}</span>
            {notifCount > 0 ? <span className="ug-side-badge">{notifCount}</span> : null}
          </button>
        ) : null}
        {onAsk ? (
          <button type="button" className="ug-side-link" onClick={() => { setSheetOpen(false); onAsk(); }}>
            <Icon name="compass" /><span className="ug-t">{t("altShell.askCompass")}</span>
          </button>
        ) : null}
        {memberHat ? <a className="ug-btn ug-btn-gold ug-btn-sm ug-side-cta" href="/m/settings/notifications" onClick={go({ key: "settings", path: "/m/settings/notifications" })}>
          <Icon name="bell" />{t("altShell.getAlerts")}
        </a> : null}
        {onSwitchShell ? (
          <button type="button" className="ug-side-link ug-shell-switch" onClick={() => { setSheetOpen(false); onSwitchShell(); }}>
            <Icon name="left" /><span className="ug-t">{t("altShell.switchToClassic")}</span>
          </button>
        ) : null}
        <span className="ug-side-tz" title={t("altShell.clockLabel")}>
          <Icon name="clock" /><span>{formatEasternClock(clock, lang)} {t("altShell.et")}</span>
        </span>
      </div>
    </>
  );

  const query = railQuery.trim().toLowerCase();
  const railMatches = chapters.filter((chapter) => !query || `${chapter.name} ${chapter.abbreviation ?? ""} ${chapter.id}`.toLowerCase().includes(query));

  const classicHref = (() => {
    const url = new URL(window.location.href);
    url.searchParams.set(SHELL_QUERY_PARAM, CLASSIC_SHELL);
    return `${url.pathname}${url.search}${url.hash}`;
  })();

  const footerLink = (item) => (
    <li key={item.key}><a href={item.path} onClick={go(item)}>{label(item)}</a></li>
  );

  return (
    <AltShellContext.Provider value={context}>
      <a ref={skipRef} className="skip-link" href="#main-content">{t("app.skip")}</a>
      <aside ref={sideRef} className="ug-side" id="ug-side" aria-label={t("altShell.siteNav")}>{side(false)}</aside>
      <header ref={headerRef} className="ug-hdr" id="ug-hdr">
        <div className="ug-wrap"><div className="ug-hdr-bar">
          <a className="ug-brand" href="/m" aria-label="Union Ground" onClick={go({ key: "today", path: "/m" })}>
            <BrandMark /><span>Union Ground<small>{t("altShell.brandTag")}</small></span>
          </a>
          <div className="ug-hdr-tools">
            {onSearch && memberHat ? <button className="ug-icon-btn" type="button" onClick={onSearch} aria-label={t("altShell.search")}><Icon name="search" /></button> : null}
            <button ref={menuButtonRef} className="ug-btn ug-btn-dark ug-btn-sm ug-hdr-menu-btn" type="button" onClick={openMenu} aria-expanded={sheetOpen} aria-controls="ug-msheet">
              <Icon name="menu" />{t("altShell.menu")}
            </button>
          </div>
        </div></div>
      </header>
      <div className={`ug-side-scrim${sheetOpen ? " ug-open" : ""}`} onClick={closeSheet} />
      <div ref={sheetRef} className={`ug-mobile-sheet${sheetOpen ? " ug-open" : ""}`} id="ug-msheet" role={sheetOpen ? "dialog" : undefined} aria-modal={sheetOpen ? "true" : undefined} aria-label={t("altShell.menu")}>
        {side(true)}
      </div>
      <div ref={railRef} className={`ug-rail${railOpen ? " ug-open" : ""}`} id="ug-rail" role={railOpen ? "dialog" : undefined} aria-modal={railOpen && !wide ? "true" : undefined} aria-labelledby="ug-rail-title">
        <div className="ug-rail-head">
          <div>
            <h2 className="ug-rail-title" id="ug-rail-title">{t("altShell.switchChapter")}</h2>
            <p className="ug-rail-sub">{t("altShell.railSub", { count: chapters.length, mine: chapters.length })}</p>
          </div>
          <button className="ug-rail-x" type="button" onClick={() => closeRail(true)} aria-label={wide ? t("altShell.railClose") : t("altShell.railBack")}>
            <Icon name="left" className="ug-rx-n" /><span className="ug-rx-n">{t("altShell.menu")}</span><Icon name="x" className="ug-rx-d" />
          </button>
        </div>
        <label className="ug-rail-find">
          <Icon name="search" /><span className="ug-sr">{t("altShell.railFind")}</span>
          <input ref={railInputRef} type="search" placeholder={t("altShell.railFind")} autoComplete="off" spellCheck={false} enterKeyHint="go" value={railQuery} onChange={(event) => setRailQuery(event.target.value)} />
        </label>
        <div className="ug-rail-scroll">
          {railMatches.length ? (
            <section className="ug-rail-group">
              <h3 className="ug-rail-label"><span>{t("altShell.railGroupYours")}</span><span className="ug-n">{railMatches.length}</span></h3>
              <ul>
                {railMatches.map((chapter) => {
                  const selected = chapter.id === selectedChapterId;
                  // Region first (the catalog's category), then the honest counts.
                  const meta = [
                    chapter.category || null,
                    chapter.memberCount != null ? t("altShell.railMembers", { count: chapter.memberCount }) : null,
                    chapter.staffCount != null ? t("altShell.railStaff", { count: chapter.staffCount }) : null,
                  ].filter(Boolean).join(" · ");
                  return (
                    <li className="ug-rail-row" key={chapter.id}>
                      <BusyButton type="button" className="ug-rail-item" title={chapter.name} aria-current={selected ? "page" : undefined} pending={chapterBusy} onClick={(event) => pickChapter(chapter, event.currentTarget)}>
                        <ChapterAvatar chapter={chapter} size="av-sm" />
                        <span className="ug-rail-meta">
                          <b><span className="ug-nm">{chapter.name}</span>{selected ? <i className="ug-rail-home">{t("altShell.railCurrent")}</i> : null}</b>
                          {meta ? <small>{meta}</small> : null}
                        </span>
                      </BusyButton>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : (
            <div className="ug-rail-empty"><b>{t("altShell.railEmpty", { query: railQuery.trim() })}</b>{t("altShell.railEmptyHint")}</div>
          )}
        </div>
        <p className="ug-sr" aria-live="polite">{query ? t("altShell.railMatches", { count: railMatches.length }) : ""}</p>
        <div className="ug-rail-foot">
          <a className="ug-rail-dir" href="/m/organize" onClick={go({ key: "hub", path: "/m/organize" })}>
            <Icon name="users" /><span>{t("altShell.chapterDirectory")}</span><Icon name="right" />
          </a>
        </div>
      </div>
      <div ref={bodyRef} className="ug-body">{children}</div>
      <footer ref={footerRef} className="ug-ftr" id="ug-ftr">
        <div className="ug-wrap"><div className="ug-ftr-grid">
          <div>
            <a className="ug-brand" href="/m" onClick={go({ key: "today", path: "/m" })}><BrandMark /><span>Union Ground</span></a>
            <p className="ug-tag-line">{t("altShell.footerTagline")}</p>
            <ul>
              <li><a href="/privacy">{t("altShell.privacy")}</a></li>
              <li><a href="/terms">{t("altShell.terms")}</a></li>
              <li><a href="/accessibility">{t("altShell.accessibility")}</a></li>
              {memberHat ? <li><a href="/m/organize/governance" onClick={go({ key: "hub", path: "/m/organize/governance" })}>{t("workspace.dataRights")}</a></li> : null}
            </ul>
            <p>{t("altShell.footerNote")}</p>
          </div>
          {memberHat ? <div>
            <h4>{t("altShell.footerUpdates")}</h4>
            <ul>{[
              { key: "today", label: t("altShell.now"), path: "/m" },
              { key: "messages", labelKey: "nav.messages", path: "/m/messages" },
              { key: "events", label: t("altShell.events"), path: "/m/events" },
              { key: "numbers", labelKey: "nav.myReports", path: "/m/numbers" },
            ].map(footerLink)}</ul>
          </div> : null}
          <div>
            <h4>{t("altShell.footerChapters")}</h4>
            <ul>
              {onSelectChapter ? chapters.slice(0, 5).map((chapter) => (
                <li key={chapter.id}><button type="button" className="ug-link-btn" onClick={(event) => pickChapter(chapter, event.currentTarget)}>{chapter.abbreviation || chapter.name}</button></li>
              )) : null}
              {footerLink({ key: "hub", label: t("altShell.chapterDirectory"), path: "/m/organize" })}
            </ul>
          </div>
          {memberHat ? <div>
            <h4>{t("altShell.footerHelp")}</h4>
            <ul>{[
              { key: "member-support", viewKey: "memberSupport", labelKey: "nav.memberSupport", path: "/m/support" },
              { key: "rights", labelKey: "nav.knowRights", path: "/m/rights" },
              { key: "cases", labelKey: "nav.myCases", path: "/m/cases" },
              { key: "forms", labelKey: "nav.forms", path: "/m/forms" },
            ].map(footerLink)}</ul>
          </div> : null}
          <div>
            <h4>{t("altShell.footerAbout")}</h4>
            <ul>
              <li><a href="/verify">{t("altShell.verifyReceipt")}</a></li>
              {memberHat && siteGuide ? footerLink({ key: "site-guide", viewKey: "siteGuide", labelKey: "nav.siteGuide", path: "/m/guide" }) : null}
              {memberHat ? footerLink({ key: "settings", labelKey: "nav.settings", path: "/m/settings" }) : null}
              <li>{onSwitchShell
                ? <button type="button" className="ug-ftr-switch" onClick={onSwitchShell}>{t("altShell.switchToClassic")}</button>
                : <a href={classicHref}>{t("altShell.classicShell")}</a>}</li>
            </ul>
          </div>
        </div></div>
      </footer>
      {tabbar ? (
        <nav ref={tabbarRef} className="ug-tabbar" id="ug-tabbar" aria-label={t("altShell.tabbar")}>
          {[
            { key: "today", path: "/m", icon: "home", label: t("altShell.now") },
            { key: "messages", path: "/m/messages", icon: "msg", label: t("nav.messages"), badge: badges.messages ?? null },
            tabWork ? { key: "tasks", viewKey: tabWork.viewKey ?? "tasks", path: tabWork.path ?? "/m/tasks", icon: "briefcase", label: t("altShell.work"), badge: tabWork.badge ?? null } : null,
          ].filter(Boolean).map((item) => (
            <a key={item.key} className="ug-tab-item" href={item.path} aria-current={(item.viewKey ?? item.key) === active ? "page" : undefined} onClick={go(item)}>
              <Icon name={item.icon} /><span>{item.label}</span>
              {item.badge ? <><i className="ug-tab-badge" aria-hidden="true">{item.badge}</i><span className="ug-sr">{`, ${t("altShell.tabWaiting", { count: item.badge })}`}</span></> : null}
            </a>
          ))}
          <button type="button" className="ug-tab-item" aria-expanded={sheetOpen} aria-controls="ug-msheet" onClick={openMenu}>
            <Icon name="menu" /><span>{t("altShell.menu")}</span>
          </button>
        </nav>
      ) : null}
      <TooltipLayer rootRef={headerRef} />
      {toast ? <AltToast {...toast} /> : null}
    </AltShellContext.Provider>
  );
}
