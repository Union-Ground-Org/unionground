import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Search } from "lucide-react";
import { useLang } from "../lib/LanguageContext.jsx";
import { OPEN_COMMAND_PALETTE_EVENT, commandMatches } from "../lib/commandPalette.js";
import { keyboardShortcutsEnabled } from "../lib/keyboardShortcuts.js";
import { registerEscapeLayer } from "../lib/escapeLayers.js";
import { useModalIsolation } from "../lib/useModalIsolation.js";
import { RailIcon } from "./RailIcons.jsx";

const EMPTY_RESULTS = Object.freeze([]);
// One keystroke must not be one round trip; the local commands and the
// in-memory index answer instantly while this settles.
export const REMOTE_DEBOUNCE_MS = 200;
// In both shells the palette is the prototype's search modal: closing fades
// its scrim for 200 ms before it unmounts (core.js UG.modal). With reduced
// motion it closes at once.
export const PALETTE_CLOSE_FADE_MS = 200;

function reducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function CommandPalette({ sessionOperation = null, commands = [], searchResults = [], resolveSearchResults = null, resolveRemoteResults = null, onOpen = null }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hydration, setHydration] = useState("idle");
  const [attempt, setAttempt] = useState(0);
  const [selection, setSelection] = useState({ query: "", commandId: null });
  const [remote, setRemote] = useState(null);
  const [remoteAttempt, setRemoteAttempt] = useState(0);
  // Held in a ref so the parent may pass an inline resolver: an identity that
  // changes every render would restart the debounce every render and the
  // request would never be made at all.
  const remoteResolver = useRef(resolveRemoteResults);
  remoteResolver.current = resolveRemoteResults;
  const remoteEnabled = Boolean(resolveRemoteResults);
  const backdropRef = useRef(null);
  const inputRef = useRef(null);
  const priorFocus = useRef(null);
  const listRef = useRef(null);
  const optionRefs = useRef(new Map());
  // null while open; "dismiss" or "choose" while the closing fade runs
  // (`ug-leaving`, styled by popups.css in both shells). A dismissal keeps focus in the palette until it is gone, then
  // returns it; a chosen command releases the page at once so the
  // destination can take focus, as the prototype's router does.
  const [leaving, setLeaving] = useState(null);
  const leaveTimerRef = useRef(0);
  useEffect(() => () => clearTimeout(leaveTimerRef.current), []);

  const restoreFocus = useCallback(() => {
    setTimeout(() => {
      if (!sessionOperation || sessionOperation.isCurrent()) {
        const active = document.activeElement;
        if (active && active !== document.body && active !== document.documentElement) return;
        const target = priorFocus.current;
        if (target?.isConnected && target !== document.body && target !== document.documentElement) target.focus();
        else document.getElementById("main-content")?.focus();
      }
    }, 0);
  }, [sessionOperation]);

  const resolvedSearchResults = useMemo(
    () => resolveSearchResults?.(query) ?? searchResults,
    [query, resolveSearchResults, searchResults],
  );
  // Server results are only the ones for the query on screen right now: a
  // slower earlier request must never paint over a faster later one.
  const remoteResults = remote?.query === query.trim() && remote.phase === "loaded" ? remote.results : EMPTY_RESULTS;
  const remoteLoading = remoteEnabled && query.trim().length > 0
    && (remote?.query !== query.trim() || remote?.phase === "loading");
  const visible = useMemo(() => {
    const server = remoteResults;
    const serverIds = new Set(server.map((item) => item.id));
    return [
      ...commands.filter((command) => commandMatches(command, query)),
      // The server ranked these; its copy of a row the local index also found
      // wins, and both keep one entry.
      ...server,
      ...resolvedSearchResults.filter((item) => !serverIds.has(item.id)),
    ];
  }, [commands, query, remoteResults, resolvedSearchResults]);
  // A projection or server reply can insert rows above the current command.
  // Keep its identity; when it disappears, fall back to the first result.
  const activeCommandId = selection.query === query ? selection.commandId : null;
  const activeIndex = Math.max(0, visible.findIndex((command) => command.id === activeCommandId));

  function setActive(index) {
    setSelection({ query, commandId: visible[index]?.id ?? null });
  }

  const close = useCallback((reason = "dismiss") => {
    if (leaveTimerRef.current) return;
    if (!reducedMotion()) {
      setLeaving(reason);
      if (reason === "choose") {
        if (backdropRef.current.contains(document.activeElement)) document.activeElement.blur();
        restoreFocus();
      }
      leaveTimerRef.current = setTimeout(() => {
        leaveTimerRef.current = 0;
        // Committed now, so the page is released and the search's focus has
        // fallen to body before restoreFocus looks.
        flushSync(() => {
          setLeaving(null);
          setOpen(false);
          setQuery("");
          setSelection({ query: "", commandId: null });
        });
        if (reason !== "choose") restoreFocus();
      }, PALETTE_CLOSE_FADE_MS);
      return;
    }
    setOpen(false);
    setQuery("");
    setSelection({ query: "", commandId: null });
    restoreFocus();
  }, [restoreFocus]);

  // A palette already dismissed and fading out runs no command: its rows and
  // focused search stay on screen for the fade but no longer act.
  function choose(command) {
    if (!command || leaveTimerRef.current) return;
    close("choose");
    command.onSelect?.();
  }

  // Escape closes through the shared stack (modal while open) so a palette
  // opened above the rail-shell Compass panel consumes the key itself and
  // leaves the panel's draft alone. Cmd/Ctrl+K stays on this window listener
  // because it must toggle the palette even when no layer is registered.
  useEffect(() => {
    if (!open || leaving) return undefined;
    return registerEscapeLayer(() => {
      // A newer modal (a task returned while the palette was open) has made
      // this one inert: the press is that modal's, through its own listener.
      if (backdropRef.current?.closest("[inert]")) return false;
      close();
      return undefined;
    }, { modal: true });
  }, [open, leaving, close]);

  // When that newer modal leaves, the palette is the top layer again; focus
  // the newer modal tried to hand back to the inert page lands on body, so
  // the search takes it back instead.
  useEffect(() => {
    if (!open || typeof MutationObserver !== "function") return undefined;
    let wasInert = false;
    const observer = new MutationObserver(() => {
      const inert = Boolean(backdropRef.current?.closest("[inert]"));
      if (wasInert && !inert) {
        const current = document.activeElement;
        if (!current || current === document.body || current === document.documentElement) inputRef.current?.focus();
      }
      wasInert = inert;
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ["inert"], subtree: true });
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    function onGlobalKey(event) {
      if (event.key.toLocaleLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      // Off until the member turns Keyboard shortcuts on in Settings.
      if (!keyboardShortcutsEnabled()) return;
      event.preventDefault();
      // Hidden beneath a newer modal, the palette keeps its search: toggling
      // it closed there would discard the query with no visible change.
      if (open && backdropRef.current?.closest("[inert]")) return;
      if (open) close();
      else {
        priorFocus.current = document.activeElement;
        setOpen(true);

      }
    }
    // A click entry point opens the palette whatever the Keyboard shortcuts
    // choice; it never closes an open one.
    function onOpenRequest() {
      if (open) return;
      priorFocus.current = document.activeElement;
      setOpen(true);
    }
    window.addEventListener("keydown", onGlobalKey);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onGlobalKey);
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenRequest);
    };
  }, [onOpen, open, close]);

  useEffect(() => {
    if (!open || !onOpen) return undefined;
    let current = true;
    setHydration("loading");
    const stillCurrent = () => current && (!sessionOperation || sessionOperation.isCurrent());
    Promise.resolve().then(() => { if (stillCurrent()) return onOpen(); }).then(
      () => { if (stillCurrent()) setHydration("loaded"); },
      () => { if (stillCurrent()) setHydration("error"); },
    );
    return () => { current = false; };
  }, [open, onOpen, attempt, sessionOperation]);

  useEffect(() => {
    if (!open || !remoteEnabled) {
      setRemote(null);
      return undefined;
    }
    const trimmed = query.trim();
    if (!trimmed) {
      setRemote(null);
      return undefined;
    }
    let current = true;
    const controller = new AbortController();
    const stillCurrent = () => current && (!sessionOperation || sessionOperation.isCurrent());
    const timer = setTimeout(() => {
      const resolve = remoteResolver.current;
      // The ref is written during render and this cleanup runs after it, so a
      // parent that withdraws the resolver mid-debounce is a real ordering,
      // not a hypothetical one.
      if (!resolve || !stillCurrent()) return;
      setRemote({ query: trimmed, phase: "loading", results: EMPTY_RESULTS });
      Promise.resolve(resolve(trimmed, { signal: controller.signal })).then(
        (results) => {
          if (stillCurrent()) setRemote({ query: trimmed, phase: "loaded", results: Array.isArray(results) ? results : EMPTY_RESULTS });
        },
        // A failed server search is not a failed palette: the local commands
        // and the offline index are still exactly right.
        // A refusal (a SQLSTATE code) keeps "No results."; a dropped search says so.
        (error) => {
          const refused = /^(22|23|42|P0)[0-9A-Z]{3}$/.test(String(error?.code ?? ""));
          if (stillCurrent()) setRemote({ query: trimmed, phase: refused ? "loaded" : "failed", results: EMPTY_RESULTS });
        },
      );
    }, REMOTE_DEBOUNCE_MS);
    return () => {
      current = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, query, remoteEnabled, sessionOperation, remoteAttempt]);

  // The palette joins the shared modal layer stack instead of inerting its
  // own siblings: opened above a Dialog it is the newer layer, so the Dialog's
  // live isolation leaves it interactive and the Dialog (with its draft) is
  // restored intact when the palette closes.
  useModalIsolation(backdropRef, { active: open && leaving !== "choose" });

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const command = visible[activeIndex];
    const commandId = command?.id ?? null;
    if (selection.query !== query || selection.commandId !== commandId) setSelection({ query, commandId });
    if (!command) return;
    const option = optionRefs.current.get(command.id);
    const list = listRef.current;
    if (!option || (list && !list.contains(option))) return;
    option.scrollIntoView?.({ block: "nearest" });
  }, [open, query, selection, activeIndex, visible]);

  if (!open) return null;
  const activeId = visible[activeIndex] ? `command-option-${visible[activeIndex].id}` : undefined;
  // "No results." is a verdict, not a progress report: a search still in
  // flight has not found nothing yet, and saying so under "Searching cases…"
  // contradicts the status line the same screen is reading out.
  // After a failed load the alert speaks; a "No results." verdict would be
  // drawn from an index that never arrived.
  // #9465 (W3a-25): a failed case search is not "No results.".
  const remoteFailed = remoteEnabled && remote?.query === query.trim() && remote?.phase === "failed";
  const emptyStateVisible = hydration !== "loading" && hydration !== "error" && !remoteLoading && !visible.length;
  // One status region stays mounted while the palette is open, so the
  // finished "No results." verdict is announced like the progress before it.
  const statusText = hydration === "loading" ? t("command.loading")
    : remoteLoading ? t("command.searchingCases")
      : emptyStateVisible && !remoteFailed ? t("command.empty") : "";

  function onKeyDown(event) {
    // Escape is claimed here and answered by the shared layer registered
    // above. Claiming it keeps window listeners that honor defaultPrevented
    // (TaskModal) from closing the surface beneath. Closing here instead would
    // let React commit before the press reaches window, and the shared stack
    // would then hand the same press to the Dialog beneath.
    if (event.key === "Escape") {
      event.preventDefault();
      return;
    }
    if (event.key === "Tab") {
      const focusables = [...event.currentTarget.querySelectorAll("input, button:not(:disabled):not([tabindex='-1'])")];
      const position = focusables.indexOf(document.activeElement);
      if (event.shiftKey && position <= 0) {
        event.preventDefault();
        focusables.at(-1)?.focus();
      } else if (!event.shiftKey && (position === -1 || position === focusables.length - 1)) {
        // position -1: a pressed result button (tabindex -1) can still hold
        // focus; Tab returns to the first real tab stop instead of leaving.
        event.preventDefault();
        focusables[0]?.focus();
      }
      return;
    }
    // Selection keys belong to the combobox. A focused button (Try again)
    // keeps its native Enter instead of choosing the active command.
    if (event.target !== inputRef.current) return;
    if (!visible.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((activeIndex + 1) % visible.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((activeIndex - 1 + visible.length) % visible.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(visible.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(visible[activeIndex]);
    }
  }

  // Escape is claimed only while focus is inside the palette; a press aimed
  // at body would reach the window listeners of the surface beneath (an
  // unsaved Workstreams sheet, a delete confirmation) as well as the palette.
  // A click on its text keeps focus where it was, and focus that still falls
  // to body while the palette is the top layer returns to the search.
  function keepFocusInside(event) {
    const list = listRef.current;
    if (event.target === list && list.clientWidth > 0 && list.clientHeight > 0) {
      const bounds = list.getBoundingClientRect();
      const left = bounds.left + list.clientLeft;
      const top = bounds.top + list.clientTop;
      // Native scrollbars target the scroll container outside its client
      // area. Leave their drag/track default alone, including left-side RTL
      // scrollbars; text inside the client area still retains input focus.
      if (event.clientX < left || event.clientX >= left + list.clientWidth
        || event.clientY < top || event.clientY >= top + list.clientHeight) return;
    }
    if (!(event.target instanceof Element) || !event.target.closest("input, button")) event.preventDefault();
  }

  function recoverFocus(event) {
    if (event.relatedTarget) return;
    setTimeout(() => {
      const current = document.activeElement;
      if (current && current !== document.body && current !== document.documentElement) return;
      if (!inputRef.current?.isConnected || backdropRef.current?.closest("[inert]")) return;
      inputRef.current.focus();
    }, 0);
  }

  return (
    <div
      ref={backdropRef}
      className={`command-palette__backdrop${leaving ? " ug-leaving" : ""}`}
      inert={leaving === "choose" ? true : undefined}
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <section
        className="command-palette"
        role="dialog"
        // Fading out it is no longer modal, as the prototype removes its key
        // listener when it closes: a layer beneath (the Compass panel a
        // command just opened) answers the next Escape.
        aria-modal={leaving ? undefined : "true"}
        aria-label={t("command.title")}
        onKeyDown={onKeyDown}
        onMouseDown={keepFocusInside}
        onBlur={recoverFocus}
      >
        <label className="command-palette__search">
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            role="combobox"
            aria-label={t("command.search")}
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={activeId}
            value={query}
            readOnly={leaving ? true : undefined}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("command.placeholder")}
          />
          <kbd>Esc</kbd>
        </label>
        <p className="command-palette__empty" role="status" aria-live="polite">{statusText}</p>
        {hydration === "error" && <div className="command-palette__empty" role="alert">
          <p>{t("command.loadFailed")}</p>
          <button className="dialog-primary" type="button" onClick={() => {
            setAttempt(value => value + 1);
            // The button unmounts while the retry loads; keep focus in search.
            inputRef.current?.focus();
          }}>{t("app.tryAgain")}</button>
        </div>}
        {hydration !== "error" && remoteFailed && !visible.length && <div className="command-palette__empty" role="alert">
          <p>{t("command.caseSearchFailed")}</p>
          <button className="dialog-primary" type="button" onClick={() => {
            setRemoteAttempt(value => value + 1);
            inputRef.current?.focus();
          }}>{t("app.tryAgain")}</button>
        </div>}
        <div id="command-palette-list" ref={listRef} className="command-palette__list" role="listbox" aria-label={t("command.results")}>
          {visible.map((command, index) => (
            <button
              id={`command-option-${command.id}`}
              key={command.id}
              ref={(node) => {
                if (node) optionRefs.current.set(command.id, node);
                else optionRefs.current.delete(command.id);
              }}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={index === activeIndex}
              className="command-palette__option"
              // Only a pointer that moves picks a row: the palette opens over
              // a resting pointer, and a row appearing under it is not a
              // choice (it selected the eighth row on open, #9565 B-32).
              onMouseMove={() => { if (index !== activeIndex) setActive(index); }}
              onClick={() => choose(command)}
            >
              <span aria-hidden="true">{command.iconName && <RailIcon name={command.iconName} />}</span>
              <span>{command.label}</span>
              {command.hint && <kbd>{command.hint}</kbd>}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
