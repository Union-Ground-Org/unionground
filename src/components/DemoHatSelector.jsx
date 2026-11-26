import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useLang } from "../lib/LanguageContext.jsx";
import { useMenuPresence } from "../lib/useTransitionPresence.js";

export const DEMO_HAT_INTRO_KEY = "sg:demo:desktop-hat-intro-seen:v1";
// BUG-UG-DEMO-SHELL-ROLE-MENU-STUCK-OPEN-AND-STEWARD-OPENS-IN-SPANISH-20261124:
// the first-visit intro is brief (desktop rail contract): its hint line
// leaves after this long. A page change always closes the menu, so it never
// sits over the next page.
export const DEMO_HAT_INTRO_MS = 8000;

function availableLocalStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function introAlreadySeen(storage) {
  try { return storage?.getItem(DEMO_HAT_INTRO_KEY) === "true"; } catch { return false; }
}

function rememberIntro(storage) {
  try { storage?.setItem(DEMO_HAT_INTRO_KEY, "true"); } catch { /* Storage may be unavailable. */ }
}

function reduceMotionPreferred() {
  try { return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true; } catch { return false; }
}

export function DemoHatSelector({ options = [], active, onChange, introduce = false, introReady = true, pageKey = null }) {
  const { t } = useLang();
  const menuId = useId();
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const itemRefs = useRef([]);
  const focusOnOpenRef = useRef(false);
  const restoreFocusRef = useRef(false);
  const previousIntroduceRef = useRef(introduce);
  const [open, setOpen] = useState(false);
  const [intro, setIntro] = useState(false);
  const activeIndex = Math.max(0, options.findIndex((option) => option.key === active));
  const [rovingIndex, setRovingIndex] = useState(activeIndex);
  const activeOption = options[activeIndex] ?? options[0] ?? null;
  // The prototype's menu motion: it drops in and fades out over .18s, taking
  // no input while it fades.
  const menu = useMenuPresence(open);

  const closeMenu = (restoreFocus = true) => {
    restoreFocusRef.current = restoreFocus;
    setOpen(false);
    setIntro(false);
  };

  const openMenu = (index = activeIndex, { focus = true, showIntro = false } = {}) => {
    focusOnOpenRef.current = focus;
    setRovingIndex(Math.max(0, Math.min(options.length - 1, index)));
    setIntro(showIntro);
    setOpen(true);
  };

  useEffect(() => {
    const welcomeJustClosed = introduce && previousIntroduceRef.current === false;
    previousIntroduceRef.current = introduce;
    if (!introduce) return;
    // `introduce` changes from false to true when App removes the welcome.
    // Restore focus only for that dismissal transition: an initial deep link
    // can still show the once-only intro without stealing page-load focus.
    if (welcomeJustClosed
        && (!document.activeElement || document.activeElement === document.body)) {
      triggerRef.current?.focus({ preventScroll: true });
    }
  }, [introduce]);

  // BUG-UG-DEMO-ROLE-MENU-OPENS-OVER-LOADING-SCREEN-20261108: the
  // intro points at the page a role opens, so it waits until App says that
  // page has loaded instead of opening over the shell's loading wait.
  useEffect(() => {
    if (!introduce || !introReady) return;
    const storage = availableLocalStorage();
    if (introAlreadySeen(storage)) return;
    rememberIntro(storage);
    // Reduce Motion keeps the ordinary, fully static selector. The intro is
    // marked seen so changing the OS preference later cannot replay it.
    if (reduceMotionPreferred()) return;
    openMenu(activeIndex, { focus: false, showIntro: true });
  // The first-visit decision belongs to this mount, welcome transition or
  // loaded page, not later hat changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [introduce, introReady]);

  // A new page closes the menu, whoever opened it: the visitor reached the
  // page by the rail, the keyboard or a link, and the menu would otherwise
  // cover its top right. Focus stays where the navigation put it.
  const pageKeyRef = useRef(pageKey);
  useEffect(() => {
    if (pageKeyRef.current === pageKey) return;
    pageKeyRef.current = pageKey;
    closeMenu(false);
  }, [pageKey]);

  // The intro's hint line is brief: it leaves after DEMO_HAT_INTRO_MS. The
  // menu itself is never closed by a timer (someone may be reading it with
  // a screen reader's cursor or a magnifier, with DOM focus elsewhere); it
  // stays until a press outside, Escape, focus leaving it, a choice or a
  // page change.
  useEffect(() => {
    if (!open || !intro) return undefined;
    const timer = setTimeout(() => setIntro(false), DEMO_HAT_INTRO_MS);
    return () => clearTimeout(timer);
  }, [open, intro]);

  useLayoutEffect(() => {
    if (open) {
      if (focusOnOpenRef.current) itemRefs.current[rovingIndex]?.focus();
      focusOnOpenRef.current = false;
      return;
    }
    if (!restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [open, rovingIndex]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const dismissOutside = (event) => {
      if (triggerRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return;
      closeMenu(false);
    };
    const dismissEscape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu(Boolean(menuRef.current?.contains(document.activeElement)));
    };
    document.addEventListener("mousedown", dismissOutside);
    document.addEventListener("touchstart", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    return () => {
      document.removeEventListener("mousedown", dismissOutside);
      document.removeEventListener("touchstart", dismissOutside);
      document.removeEventListener("keydown", dismissEscape);
    };
  }, [open]);

  if (!activeOption || options.length === 0) return null;
  const triggerLabel = t("desktopRail.switchHatCurrent", { hat: t(activeOption.labelKey) });

  const moveFocus = (index) => {
    setRovingIndex(index);
    itemRefs.current[index]?.focus();
  };

  const choose = (option) => {
    closeMenu(true);
    onChange?.(option.key);
  };

  const handleItemKeyDown = (event, index, option) => {
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      choose(option);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : event.key === "ArrowDown"
          ? (index + 1) % options.length
          : (index - 1 + options.length) % options.length;
    moveFocus(nextIndex);
  };

  return (
    <div
      className="demo-hat-selector"
      data-intro={intro ? "true" : undefined}
      onBlur={(event) => {
        if (!open || event.currentTarget.contains(event.relatedTarget)) return;
        closeMenu(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="demo-hat-selector__trigger"
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => open ? closeMenu(true) : openMenu(activeIndex)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          openMenu(event.key === "ArrowUp" ? options.length - 1 : activeIndex);
        }}
      >
        <span>{t(activeOption.labelKey)}</span>
        <ChevronDown aria-hidden="true" size={16} strokeWidth={2.25} />
      </button>
      {menu.shown && (
        <div
          ref={menuRef}
          className="demo-hat-selector__menu"
          data-state={menu.state}
          aria-hidden={menu.closing || undefined}
          inert={menu.closing ? true : undefined}
          onTransitionEnd={menu.onTransitionEnd}
        >
          {intro && <p className="demo-hat-selector__intro" role="status">{t("demo.hatIntro")}</p>}
          <div id={menuId} role="menu" aria-label={t("demo.hatsLabel")}>
            {options.map((option, index) => (
              <button
                ref={(node) => { itemRefs.current[index] = node; }}
                key={option.key}
                type="button"
                className="demo-hat-selector__option"
                role="menuitemradio"
                aria-checked={option.key === active}
                tabIndex={index === rovingIndex ? 0 : -1}
                onClick={() => choose(option)}
                onKeyDown={(event) => handleItemKeyDown(event, index, option)}
              >
                <span className={`demo-hat-selector__dot demo-hat-selector__dot--${option.key}`} aria-hidden="true" />
                <span>{t(option.labelKey)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
