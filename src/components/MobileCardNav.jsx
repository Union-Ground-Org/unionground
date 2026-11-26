import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useLang } from "../lib/LanguageContext.jsx";
import { staffItemHref } from "../lib/staffNavigation.js";
import { FEATURE_GROUPS, navHintKey } from "../lib/mobileNav.js";
import { useStewardPresence } from "./NoStewardNote.jsx";
import { NavGlyph } from "./NavGlyphs.jsx";
import { BrandMark } from "./BrandMark.jsx";
import { WorkWidgets } from "./WorkWidgets.jsx";
import { PinnedShortcuts } from "./PinnedShortcuts.jsx";
import { GuidedNavToggle, SpotlightMarker } from "./OnboardingHud.jsx";
import { guidedNavItems, hiddenGuidedNavCount, isSpotlit, spotlightNavItem } from "../lib/onboardingGuide.js";
import { personalizeNavGroups } from "../features/memberHome/navUsage.js";
import { SHORTCUT_CATALOG } from "../lib/navigationPreferences.js";

// The phone home space as three swipeable cards (owner voice spec,
// 2026-08-05; chrome-free revision 2026-08-07): All Features on the left,
// the Home feed in the center, Work on the right. The rail is a native
// scroll-snap carousel — the browser owns the gesture, so swipes, flicks,
// drag-scrolling and screen-reader panning all behave like every other
// horizontal list on the platform. The labeled pills and the menu orb are
// gone (owner annotation, 2026-08-07): edge swipes are the way between
// cards, and the persistent Home orb — mounted here on the side cards and
// by the shell on every inner view — is the guaranteed non-gesture way
// back to the feed.
//
// Only the home route mounts this. Every other view stays a full screen the
// cards navigate to, so the card layer never turns into a second router.

const PANELS = ["features", "home", "work"];
const HOME_INDEX = 1;

function reducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// The one persistent, non-gesture way home (owner spec, 2026-08-07: a Home
// button on every card so nobody swipes in circles). The card layer renders
// it on the side cards; App renders the same orb on every inner phone view,
// where it also carries the job the retired shortcut bubble used to do.
export function HomeOrb({ onHome, label }) {
  return (
    <button type="button" className="home-orb" aria-label={label} onClick={onHome}>
      <span aria-hidden="true">⌂</span>
    </button>
  );
}

function NavRow({ item, onNavigate, onAsk, onNotifications, onProfile, notifDot = false, notifCount = null, spotlit = false }) {
  const { t } = useLang();
  // REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030 (findings 85, 99):
  // a visible one-line explanation under the entries members could not tell
  // apart. It is the row's description, so the row keeps its plain name.
  const hintId = useId();
  const hintKey = navHintKey(item.key, useStewardPresence());
  const hint = hintKey ? t(hintKey) : null;
  const hintProps = hint ? { "aria-describedby": hintId } : {};
  const label = (
    <span className="morehub-row__label">
      {t(item.labelKey)}
      {hint && <span id={hintId} className="morehub-row__hint" aria-hidden="true">{hint}</span>}
    </span>
  );
  // Dialog-opening rows (Compass, notifications, profile) are actions, not
  // routes: with the bell and avatar gone from the chrome (owner feedback,
  // 2026-08-05, hat pill only), the drawer is where those dialogs live.
  // A row whose opener is not wired renders nothing rather than a dead button.
  const dialogActions = { assistant: onAsk, notifications: onNotifications, profile: onProfile };
  if (item.action) {
    const openDialog = dialogActions[item.action];
    if (!openDialog) return null;
    // The unread signal moved here WITH the bell: the row keeps the live dot
    // and carries the count in its accessible name, exactly what the orb's
    // aria-label announced (sol Medium on f13e07ba3).
    const isNotifications = item.action === "notifications";
    return (
      <button
        type="button"
        className="morehub-row morehub-row--nav"
        aria-haspopup="dialog"
        aria-label={isNotifications && typeof notifCount === "number" ? t("header.notifications", { count: notifCount }) : undefined}
        {...hintProps}
        onClick={openDialog}
      >
        <span className="morehub-row__icon" aria-hidden="true"><NavGlyph name={item.key} fallback={item.icon} /></span>
        {label}
        {isNotifications && notifDot && <span className="morehub-row__dot" aria-hidden="true" />}
        <span className="morehub-row__chev" aria-hidden="true">›</span>
      </button>
    );
  }
  // A spotlit row links to the onboarding step itself.
  const target = spotlit ? spotlightNavItem(item) : item;
  const { viewKey = item.key, path, sectionId } = target;
  return (
    <a
      className={`morehub-row morehub-row--nav${spotlit ? " is-spotlit" : ""}`}
      href={staffItemHref(target)}
      {...hintProps}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onNavigate(viewKey, path, sectionId);
      }}
    >
      <span className="morehub-row__icon" aria-hidden="true"><NavGlyph name={item.key} fallback={item.icon} /></span>
      {label}
      {spotlit && <SpotlightMarker />}
      <span className="morehub-row__chev" aria-hidden="true">›</span>
    </a>
  );
}

// First letters of the first two words — the same derivation the inbox uses
// for sender chips. Presentation only, never seeded.
function initialsOf(name) {
  return String(name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");
}

export function MobileCardNav({
  children, // the Home feed (TodayView) — the center card
  initialPanel = "home", // an inner page may request Features for this mount only
  onInitialPanelConsumed = null,
  onNavigate, // (viewKey, path, sectionId, focus) — route-aware, staff views included
  onAsk, // Compass overlay
  workItems = [], // a worn staff hat's work map (the member mode renders widgets)
  workLabel = null, // translated hat label over the Work card
  workData = null, // live member data for the widget panels (member mode)
  workWidgetOrder = undefined, // normalized per-member widget order
  onWorkWidgetOrderChange = null, // emits a complete next order
  shortcutKeys = undefined, // normalized per-member pinned destinations
  hasStewardRole = false, // selects the preserved first-run persona defaults
  onShortcutKeysChange = null, // emits a complete one-to-six key array
  chapterName = null, // current chapter; renders the chapter chip when present
  onOpenChapter = null, // opens the chapter context sheet
  topChrome = null, // floating home chrome: the ephemeral glass hat pill only
  onNotifications = null, // opens the notifications dialog (drawer row)
  onProfile = null, // opens the profile dialog (drawer row + foot avatar)
  notifDot = false, // live unread indicator on the notifications row
  notifCount = null, // unread count for the row's accessible name
  memberName = null, // display name behind the foot avatar's initials
  memberFeaturesAvailable = true, // false while an explicit staff hat owns Home
  // REQ-UG-PROGRESSIVE-DISCLOSURE-AND-FEATURE-DRIP-20261001: the
  // onboarding guide and the member's own "Show everything" choice.
  guide = null,
  guideShowAll = false,
  onGuideShowAllChange = null,
  siteGuide = true, // false only when the organization turned the Site Guide off
  dues = true, // false only when the organization runs no dues (duesNavigation.js)
  navUsageWeights = null, // device-only usage ranking (REQ-UG-USAGE-BASED-NAVIGATION-20261001)
  customLinks = [], // REQ-UG-CUSTOM-NAV-LINKS-20261001: [{ key, label, url }]
}) {
  const { t } = useLang();
  const railRef = useRef(null);
  const initialIndex = initialPanel === "features" ? 0 : HOME_INDEX;
  const [active, setActive] = useState(initialIndex);
  const activeRef = useRef(active);
  // The hat pill is ephemeral (owner spec, 2026-08-07): full presence at the
  // top of the feed, receding once the member scrolls into content. Opacity
  // only — it stays interactive, and focus or a tap brings it back.
  const [chromeFaded, setChromeFaded] = useState(false);
  // The left card's foot is fixed chrome, so it cannot ride the swiping
  // drawer — instead it exists only while the Features card is ACTIVE and
  // becomes visible only when the rail is at that card's REST position
  // (sol MED on 7f558d177: keyed to `active` alone it hung opaque over the
  // incoming home card for a third of the gesture).
  const [footAtRest, setFootAtRest] = useState(initialIndex === 0);
  const [peek, setPeek] = useState(initialIndex === 0 ? "features" : null);
  // A staff hat owns its desk and shared account actions only. Keep the
  // complete Member directory out of both the rendered tree and the keyboard
  // order; route guards remain the final boundary, but unavailable functions
  // must not be advertised as usable in the first place.
  const offeredFeatureGroups = siteGuide && dues
    ? FEATURE_GROUPS
    : FEATURE_GROUPS.map((group) => ({ ...group, items: group.items.filter((item) => (siteGuide || item.key !== "site-guide") && (dues || item.key !== "dues")) }));
  // REQ-UG-USAGE-BASED-NAVIGATION-20261001: the most-used destinations
  // move into a leading group. Pinned shortcuts already sit above the groups
  // and always win, so they never move and never count against the four.
  const pinnedViewKeys = (Array.isArray(shortcutKeys) ? shortcutKeys : [])
    .map((key) => SHORTCUT_CATALOG.find((item) => item.key === key))
    .filter(Boolean)
    .map((item) => item.viewKey ?? item.key);
  const visibleFeatureGroups = memberFeaturesAvailable
    ? personalizeNavGroups(offeredFeatureGroups, navUsageWeights, { pinned: pinnedViewKeys })
    : offeredFeatureGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => ["notifications", "profile"].includes(item.action)),
      }))
      .filter((group) => group.items.length > 0);
  // The guided view holds back everything but the core destinations while a
  // member onboards; the toggle below the groups is the visible way out.
  const cardGuide = memberFeaturesAvailable && onGuideShowAllChange ? guide : null;
  const guidedFeatureGroups = visibleFeatureGroups
    .map((group) => ({ ...group, items: guidedNavItems(group.items, cardGuide, guideShowAll) }))
    .filter((group) => group.items.length > 0);

  // The side cards are narrower than the viewport (drawer geometry — see the
  // stylesheet), so snap rest positions are no longer index × railWidth.
  // Panel offsets, clamped to the max scroll, are the truth for both the
  // programmatic goTo and the live-position read.
  const panelTargets = () => {
    const rail = railRef.current;
    if (!rail) return null;
    const max = Math.max(0, rail.scrollWidth - rail.clientWidth);
    return [...rail.children]
      .filter((el) => el.classList.contains("card-nav__panel"))
      .map((el) => Math.min(el.offsetLeft, max));
  };

  // Card changes reset the page scroll. The cards share one vertical page, so
  // a feed scrolled 700px deep would otherwise land on a shorter card's empty
  // space with its content stranded above the viewport. Instant, never smooth:
  // mid-swipe the browser still owns the horizontal gesture.
  const settle = (index) => {
    if (activeRef.current === index) return;
    activeRef.current = index;
    setActive(index);
    if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: "auto" });
  };

  // Land on the requested card before first paint (normally the feed). Direct
  // assignment, not scrollTo — there is nothing to animate on mount and
  // jsdom implements neither smooth scrolling nor layout anyway. A rail
  // that mounts at zero width (hidden ancestor, mid-layout) cannot be
  // positioned yet, and a later width change (rotation, split view) makes
  // index positions stale — the observer re-lands the ACTIVE card whenever
  // the rail takes a new size, so the carousel never drifts to card 0 with
  // the state (and the inert flags) still saying Home.
  // 2026-08-05, findings 1+4 on 019aa7ee1.
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return undefined;
    const position = () => {
      if (rail.clientWidth > 0) rail.scrollLeft = panelTargets()[activeRef.current];
    };
    position();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(position);
    observer.observe(rail);
    return () => observer.disconnect();
  }, []);

  // The request belongs to this mount, not browser history or a later Home
  // visit. Reset the shell's request without changing this card's active state.
  useLayoutEffect(() => { onInitialPanelConsumed?.(); }, [onInitialPanelConsumed]);

  // Track which card owns the viewport so the peek styling and inert flags
  // stay honest while the member swipes. Snap guarantees rest positions are
  // whole multiples of the rail width, so rounding is exact at rest and
  // sensible mid-gesture. pendingRef holds a programmatic smooth-scroll
  // target: early animation frames still round to the source card, and
  // letting them through would flick the state target → source → target.
  // The member taking the gesture back (pointerdown) or the scroll finishing
  // (scrollend / reaching the target) returns ownership to the live position.
  const pendingRef = useRef(null);
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return undefined;
    let frame = 0;
    const liveIndex = () => {
      const targets = panelTargets() ?? [];
      let best = activeRef.current;
      let bestGap = Infinity;
      targets.forEach((left, index) => {
        const gap = Math.abs(rail.scrollLeft - left);
        if (gap < bestGap) { bestGap = gap; best = index; }
      });
      return best;
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (rail.clientWidth > 0) {
          // The foot reads the LIVE position, not the settled index: the
          // moment a swipe leaves the Features rest position it fades, so it
          // never floats over the incoming home card mid-gesture.
          setFootAtRest(rail.scrollLeft <= 8);
          // The home slab tracks the LIVE position like the foot does: the
          // card rounds, clips, and blurs the moment it leaves the home rest
          // position, not at the midpoint where the settled index flips.
          const homeLeft = (panelTargets() ?? [])[HOME_INDEX] ?? 0;
          const drift = rail.scrollLeft - homeLeft;
          const nextPeek = drift < -8 ? "features" : drift > 8 ? "work" : null;
          setPeek(nextPeek);
          // A deep-scrolled feed would leave the clipped slab above the
          // viewport, so the peek transition lands the page at the top the
          // moment it engages (settle() only does this at the midpoint).
          if (nextPeek && window.scrollY > 0) window.scrollTo({ top: 0, behavior: "auto" });
          const index = liveIndex();
          if (pendingRef.current != null) {
            if (index !== pendingRef.current) return;
            pendingRef.current = null;
          }
          settle(index);
        }
      });
    };
    const release = () => {
      pendingRef.current = null;
      if (rail.clientWidth > 0) settle(liveIndex());
    };
    const onPointerDown = () => { pendingRef.current = null; };
    rail.addEventListener("scroll", onScroll, { passive: true });
    rail.addEventListener("scrollend", release);
    rail.addEventListener("pointerdown", onPointerDown);
    return () => {
      rail.removeEventListener("scroll", onScroll);
      rail.removeEventListener("scrollend", release);
      rail.removeEventListener("pointerdown", onPointerDown);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  // The ephemeral fade rides the page scroll (the cards share the window's
  // vertical scroll), so the pill recedes exactly when content moves under
  // it and returns the moment the member is back at the top.
  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setChromeFaded(window.scrollY > 48);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  const goTo = (index) => {
    settle(index);
    const rail = railRef.current;
    if (!rail) return;
    pendingRef.current = index;
    const left = (panelTargets() ?? [])[index] ?? 0;
    if (typeof rail.scrollTo === "function") {
      rail.scrollTo({ left, behavior: reducedMotion() ? "auto" : "smooth" });
    } else {
      rail.scrollLeft = left;
    }
  };

  const panelLabels = {
    features: t("cardnav.features"),
    home: t("nav.home"),
    work: t("cardnav.work"),
  };

  return (
    <div className={`card-nav card-nav--at-${PANELS[active]}${peek ? ` card-nav--peek-${peek}` : ""}${topChrome?.demoMarker ? " card-nav--demo-chrome" : ""}`}>
      {/* The home chrome is the ephemeral glass hat pill and nothing else
          (owner spec, 2026-08-07): as high as the notch allows, fading once
          the feed scrolls, removed entirely for single-hat accounts. The
          menu orb is gone — the drawer card is one edge swipe away, and the
          Home orb below is the non-gesture path back. */}
      {topChrome && Array.isArray(topChrome.hatOptions) && topChrome.hatOptions.length > 1 && topChrome.onHatChange && (
        <header className={`card-nav__chrome${topChrome.demoMarker ? " card-nav__chrome--with-demo" : ""}${chromeFaded ? " card-nav__chrome--faded" : ""}`}>
          {topChrome.demoMarker}
          <label className="card-nav__hat">
            <select aria-label={t("demo.hatsLabel")} value={topChrome.activeHat ?? "member"} onChange={(event) => topChrome.onHatChange(event.target.value)}>
              {topChrome.hatOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select>
          </label>
        </header>
      )}
      {/* SaaS role holders: each role's desk is a
          plain entry in the home chrome, Member first as the way back. No
          hat select is mounted on this origin. */}
      {topChrome && Array.isArray(topChrome.deskEntrances) && topChrome.deskEntrances.length > 1 && topChrome.onEnterDesk && (
        <header className={`card-nav__chrome${chromeFaded ? " card-nav__chrome--faded" : ""}`}>
          <nav className="card-nav__desks" aria-label={t("shell.groupDesks")}>
            {topChrome.deskEntrances.map((entry) => (
              <button key={entry.key} type="button" className="card-nav__desk" aria-pressed={(topChrome.activeHat ?? "member") === entry.key} onClick={() => topChrome.onEnterDesk(entry.key)}>
                {entry.label}
              </button>
            ))}
          </nav>
        </header>
      )}
      {/* Edge swipes are the visual way between cards, but a swipe is not an
          accessible one: these two skip-style buttons stay off-screen until
          keyboard focus reveals them, so keyboard and screen-reader members
          can still open the side cards the chrome no longer advertises.
          On the Home card the All features one is also the visible menu
          control on phone web. It docks where the Home orb
          sits on the side cards. */}
      <button
        type="button"
        className={`card-nav__skip${active === HOME_INDEX ? " card-nav__skip--menu" : ""}`}
        aria-expanded={active === 0}
        aria-controls="card-nav-panel-features"
        onClick={() => goTo(active === 0 ? HOME_INDEX : 0)}
      >
        <span className="card-nav__skip-glyph" aria-hidden="true">☰</span>
        {panelLabels.features}
      </button>
      <button
        type="button"
        className="card-nav__skip card-nav__skip--work"
        aria-expanded={active === 2}
        aria-controls="card-nav-panel-work"
        onClick={() => goTo(active === 2 ? HOME_INDEX : 2)}
      >
        {panelLabels.work}
      </button>
      {/* Offscreen cards are inert: DOM order starts at Features while the
          visual start is Home, so without it a keyboard Tab from the top
          chrome would land on an invisible link and yank the carousel
          sideways. The skip buttons re-activate a card before it is
          reachable. */}
      <div className="card-nav__rail" ref={railRef}>
        <section id="card-nav-panel-features" className="card-nav__panel card-nav__panel--features" aria-label={panelLabels.features} inert={active !== 0}>
          {/* Brand header in place of the plain card title (owner Rev 2
              sign-off, 2026-08-08, ChatGPT/Claude sidebar reference):
              wordmark on the left, one round search button on the right. */}
          <div className="card-nav__brand">
            <h2 className="card-nav__brand-name"><BrandMark size={30} /> {t("landing.wordmark")}</h2>
            {memberFeaturesAvailable && (
              <button type="button" className="card-nav__round" aria-label={t("nav.search")} onClick={() => onNavigate("search", "/m/search")}>
                <NavGlyph name="search" />
              </button>
            )}
          </div>
          {/* The menu control opens this card, so Work is one tap away from
              here too (the Home orb below covers Home). Mounted only while
              this card is open, like the foot below. */}
          {active === 0 && (
            <div className="morehub-list card-nav__work-door">
              <button type="button" className="morehub-row morehub-row--nav" aria-controls="card-nav-panel-work" onClick={() => goTo(2)}>
                <span className="morehub-row__icon" aria-hidden="true"><NavGlyph name="default" /></span>
                <span className="morehub-row__label">{panelLabels.work}</span>
                <span className="morehub-row__chev" aria-hidden="true">›</span>
              </button>
            </div>
          )}
          {memberFeaturesAvailable && (
            <PinnedShortcuts
              keys={shortcutKeys}
              hasStewardRole={hasStewardRole}
              onChange={onShortcutKeysChange}
              onNavigate={onNavigate}
              onAsk={onAsk}
            />
          )}
          {guidedFeatureGroups.map((group) => (
            <div key={group.key} className="card-nav__group">
              <h3 className="morehub-eyebrow">{t(group.labelKey)}</h3>
              <div className="morehub-list">
                {group.items.map((item) => (
                  <NavRow key={item.key} item={item} onNavigate={onNavigate} onAsk={onAsk} onNotifications={onNotifications} onProfile={onProfile} notifDot={notifDot} notifCount={notifCount} spotlit={isSpotlit(item, cardGuide)} />
                ))}
              </div>
            </div>
          ))}
          {cardGuide && (
            <GuidedNavToggle
              guide={cardGuide}
              showAll={guideShowAll}
              hiddenCount={hiddenGuidedNavCount(visibleFeatureGroups.map((group) => group.items), cardGuide)}
              onToggle={onGuideShowAllChange}
              className="card-nav__guided-toggle"
            />
          )}
          {/* The organization's admin-set links (REQ-UG-CUSTOM-NAV-LINKS-20261001).
              They leave the app: a new tab, no opener, and the name says so. */}
          {customLinks.length > 0 && (
            <div className="card-nav__group">
              <h3 className="morehub-eyebrow">{t("shell.groupLinks")}</h3>
              <div className="morehub-list">
                {customLinks.map((link) => (
                  <a key={link.key} className="morehub-row morehub-row--nav" href={link.url} target="_blank" rel="noopener noreferrer" aria-label={t("nav.customLinkOpens", { label: link.label })}>
                    <span className="morehub-row__icon" aria-hidden="true"><ExternalLink size={18} strokeWidth={2} /></span>
                    <span className="morehub-row__label">{link.label}</span>
                    <span className="morehub-row__chev" aria-hidden="true">↗</span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </section>
        <section className="card-nav__panel card-nav__panel--home" aria-label={panelLabels.home} inert={active !== HOME_INDEX || peek !== null}>
          {/* The peek recede animates this wrapper, never the snap panel:
              a transform on the panel would rescale its snap area while
              offsetLeft stays untransformed, and the two position truths
              would disagree mid-transition (sol MED on 369c8710e). */}
          <div className="card-nav__homewrap">
            {children}
          </div>
        </section>
        <section id="card-nav-panel-work" className="card-nav__panel card-nav__panel--work" aria-label={panelLabels.work} inert={active !== 2}>
          <div className="card-nav__workhead">
            <h2 className="card-nav__title">{workLabel ?? panelLabels.work}</h2>
            {chapterName && onOpenChapter && (
              <button type="button" className="card-nav__chapter" aria-haspopup="dialog" onClick={onOpenChapter}>
                <span aria-hidden="true">⌂</span>
                <span className="card-nav__chapter-name">{chapterName}</span>
                <span aria-hidden="true">▾</span>
              </button>
            )}
          </div>
          {/* Member mode gets the live widget panels; a worn staff hat keeps
              its role desk's backed link map — those desks are a different
              contract (staffNavigation.js), not preview surfaces. */}
          {workData && !workLabel ? (
            <WorkWidgets data={workData} order={workWidgetOrder} onOrderChange={onWorkWidgetOrderChange} onNavigate={onNavigate} />
          ) : (
            <div className="morehub-list">
              {workItems.map((item) => (
                <NavRow key={item.key} item={item} onNavigate={onNavigate} onAsk={onAsk} onNotifications={onNotifications} onProfile={onProfile} />
              ))}
            </div>
          )}
        </section>
      </div>
      {/* Left-card floating foot (owner Rev 5 sign-off, 2026-08-08: the
          action pill is gone — just the avatar and settings anchoring the
          bottom corners). Fixed chrome cannot ride the swiping drawer, so it
          MOUNTS only while the Features card is active — nothing focusable
          or AT-visible exists otherwise — and it becomes visible only at the
          card's rest position (sol MED + MED on 7f558d177). */}
      {onProfile && active === 0 && (
        <div className={`card-nav__foot${footAtRest ? " card-nav__foot--shown" : ""}`}>
          <button
            type="button"
            className="card-nav__avatar"
            aria-haspopup="dialog"
            aria-label={[initialsOf(memberName), t("topbar.profile")].filter(Boolean).join(" ")}
            onClick={onProfile}
          >
            {initialsOf(memberName) || <NavGlyph name="profile" />}
          </button>
          {memberFeaturesAvailable && (
            <button
              type="button"
              className="card-nav__round"
              aria-label={t("nav.settings")}
              onClick={() => onNavigate("settings", "/m/settings")}
            >
              <NavGlyph name="settings" />
            </button>
          )}
        </div>
      )}
      {active !== HOME_INDEX && <HomeOrb onHome={() => goTo(HOME_INDEX)} label={panelLabels.home} />}
    </div>
  );
}
