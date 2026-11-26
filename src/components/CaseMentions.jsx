import { prepareBusyWrite } from "../lib/busyWrite.js";
import { BusyButton, BusyTextarea } from "./BusyControls.jsx";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  activeMentionQuery, completeMention, filterMentionCandidates,
  matchMentionCandidates, mentionSegments, reconcileMentionSelections,
} from "../lib/caseMentions.js";
import { rpcErrorKeyStrict, rpcErrorTextAtRender } from "../lib/rpcErrorText.js";
import "../lib/i18n/features/caseNotesStrings.js";

// Reading side. A mention the reader's own directory does not name stays plain
// text: the note was written for people who can see the case, and a reader who
// cannot see that person should not learn their name from the markup.
//
// `hrefFor` turns a mention into a link when the host has somewhere to send
// the reader. The app has no member-profile route today, so the default is a
// marked chip rather than an anchor to a page nobody is authorized to open.
// `as` exists because one caller already renders the note inside a <p>; a <p>
// nested in a <p> is auto-closed by the parser and the timeline loses its
// grouping, so that caller passes "span".
export function CaseNoteBody({ body, mentions = [], hrefFor = null, className = "", as: Tag = "p" }) {
  const segments = useMemo(() => mentionSegments(body, mentions), [body, mentions]);
  return (
    <Tag className={className || undefined}>
      {segments.map((segment, index) => {
        // Plain runs are text nodes, not spans. A wrapped inline <span> reports
        // one union rectangle across every line it occupies, which the PR1815
        // runner reads as the chip colliding with the prose around it.
        if (segment.kind !== "mention") return <Fragment key={index}>{segment.text}</Fragment>;
        const href = hrefFor ? hrefFor(segment.userId) : null;
        return href
          ? <a key={index} className="case-mention" href={href}>{segment.text}</a>
          : <mark key={index} className="case-mention" title={segment.fullName}>{segment.text}</mark>;
      })}
    </Tag>
  );
}

// Writing side. The body carries the name so the note reads as a sentence; the
// id list travels beside it so the server never has to guess which Ana. The
// two are reconciled on every keystroke, so deleting "@Ana Ruiz" out of the
// text also withdraws the notification.
export function CaseNoteComposer(props) {
  // Drafts, picker state and pending-save outcomes belong to one case. A
  // same-case audience refresh keeps them; another case gets a fresh editor.
  return <CaseNoteDraft key={props.caseId} {...props} />;
}

function CaseNoteDraft({
  caseId,
  candidates = [],
  onSubmit,
  t,
  busy = false,
  maxLength = 4000,
  label = null,
  submitLabel = null,
}) {
  const busyWriteRef = useRef(new Set());
  const [body, setBody] = useState("");
  const [selectedMentions, setSelectedMentions] = useState([]);
  const [caret, setCaret] = useState(0);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  // One note at a time. The submit button stays focusable while a note posts
  // (aria-disabled): a disabled button loses focus at the next rendering
  // update, so a refused note would leave a keyboard user at the page top.
  const postingRef = useRef(false);
  // WAI-ARIA 1.2 combobox state. Focus never leaves the textarea, so the
  // active option is a value, not a focus position: Arrow keys move it, Enter
  // inserts it, Escape dismisses the list without touching the typed text.
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const inputRef = useRef(null);
  const pendingCaret = useRef(null);
  const listId = `case-mentions-${useId()}`;

  const active = activeMentionQuery(body, caret);
  const matches = active ? filterMentionCandidates(candidates, active.query).slice(0, 6) : [];
  const open = matches.length > 0 && !dismissed;
  const suggestions = open ? matches : [];
  const activeOption = open ? suggestions[Math.min(activeIndex, suggestions.length - 1)] : null;
  const optionId = (person) => `${listId}-${person.userId}`;
  const mentionIds = useMemo(() => matchMentionCandidates(body, candidates, selectedMentions), [body, candidates, selectedMentions]);

  // A pending caret waits for the textarea to be enabled again: after a
  // posted note the box empties in the same render that clears `working`, and
  // focus() on a disabled control is a no-op that would lose the request.
  useEffect(() => {
    if (pendingCaret.current == null || !inputRef.current || inputRef.current.disabled) return;
    inputRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    inputRef.current.focus();
    pendingCaret.current = null;
  }, [body, working, busy]);

  // The live region carries the match count on every open and every change of
  // the offered set, and says so when the list goes away. The paragraph is in
  // the document from the first render so the first announcement is not lost
  // to a region that appeared in the same paint.
  const openKey = open ? suggestions.map((person) => person.userId).join("|") : "";
  const matchCount = suggestions.length;
  useEffect(() => {
    if (openKey) setAnnouncement(t("caseMentions.matches", { count: matchCount }));
    else setAnnouncement((previous) => (previous ? t("caseMentions.dismissed") : previous));
    // t is the host's translator for the active language; re-announcing on a
    // language change is correct, and the key list is what "changed" means.
  }, [openKey, matchCount, t]);

  useEffect(() => { setActiveIndex(0); }, [openKey]);

  const pick = (person) => {
    if (!active) return;
    const next = completeMention(body, caret, person.fullName);
    setSelectedMentions([
      ...reconcileMentionSelections(body, next.body, selectedMentions)
        .filter((entry) => entry.end <= active.start || entry.start >= next.caret - 1),
      { start: active.start, end: next.caret - 1, userId: person.userId, fullName: person.fullName.trim() },
    ]);
    pendingCaret.current = next.caret;
    setBody(next.body);
    setCaret(next.caret);
    setDismissed(false);
    setActiveIndex(0);
  };

  const track = (event) => {
    setSelectedMentions(reconcileMentionSelections(body, event.target.value, selectedMentions));
    setBody(event.target.value);
    setCaret(event.target.selectionStart ?? event.target.value.length);
    setDismissed(false);
    setError("");
  };

  // Only the four keys the pattern owns are intercepted, and only while the
  // list is open: Enter still breaks a line and Escape still does nothing to
  // a plain note.
  const navigate = (event) => {
    if (!open) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeOption) pick(activeOption);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
    }
  };

  return (
    <form className="case-note-composer" onSubmit={async (event) => {
      return prepareBusyWrite(busyWriteRef, "working", () => {
        event.preventDefault();
        const trimmed = body.trim();
        if (!trimmed || postingRef.current || busy) return;
      return async (releaseBusyWrite) => {
          postingRef.current = true;
          setWorking(true); setError("");
          try {
            await onSubmit(caseId, trimmed, mentionIds);
            // Focus sat on the submit button, which the empty box now disables;
            // hand the caret back to the textarea for the next note. A refusal
            // skips this, so focus stays beside the alert the steward was sent.
            pendingCaret.current = 0;
            setBody(""); setCaret(0); setSelectedMentions([]);
          } catch (cause) {
            setError(rpcErrorKeyStrict(cause, "caseMentions.failed"));
          } finally { postingRef.current = false; setWorking(false);
          releaseBusyWrite();
        }
      };
    }, event);
    }}>
      <label>
        {label || t("caseNotes.staffNoteLabel")}
        <BusyTextarea
          ref={inputRef}
          value={body}
          maxLength={maxLength}
          required
          pending={busy || working}
          placeholder={t("caseMentions.placeholder")}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={open ? listId : undefined}
          aria-activedescendant={activeOption ? optionId(activeOption) : undefined}
          onChange={track}
          onKeyDown={navigate}
          onKeyUp={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          onClick={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        />
      </label>
      <p className="case-note-composer__audience">{t("caseNotes.noteAudience")}</p>
      {/* The rows stay buttons so the pointer target and the 44px floor are
          the ones the PR1815 harness already measures; role="option" is what
          the listbox owns, and tabIndex -1 keeps Tab on its way to submit. */}
      {open && (
        <ul id={listId} role="listbox" className="case-note-composer__mentions" aria-label={t("caseMentions.pick")}>
          {suggestions.map((person) => (
            <li key={person.userId} role="presentation">
              <button
                type="button"
                id={optionId(person)}
                role="option"
                tabIndex={-1}
                aria-selected={activeOption?.userId === person.userId}
                className={activeOption?.userId === person.userId ? "is-active" : undefined}
                onClick={() => pick(person)}
              >@{person.fullName}{candidates.some((other) => other.userId !== person.userId && other.fullName === person.fullName) ? ` (${person.userId})` : ""}</button>
            </li>
          ))}
        </ul>
      )}
      {/* A polite live region, deliberately WITHOUT role="status". The desk
          that hosts this composer already renders its own
          saved-note status paragraph beside it
          (src/views/CoordinatorView.jsx), and a second status role there makes
          a bare getByRole("status") ambiguous for every caller. aria-live plus
          aria-atomic is the same announcement to assistive technology and
          leaves the desk's one status element unambiguous. */}
      <p className="case-note-composer__announcer visually-hidden" aria-live="polite" aria-atomic="true">{announcement}</p>
      {mentionIds.length > 0 && (
        <p className="case-note-composer__notify">
          {t("caseMentions.willNotify", { count: mentionIds.length })}
        </p>
      )}
      {error && <p className="case-note-composer__error" role="alert">{rpcErrorTextAtRender(t, error)}</p>}
      <BusyButton type="submit" pending={busy || working} disabled={!body.trim()}>
        {working ? t("coordinator.saving") : (submitLabel || t("coordinator.addNote"))}
      </BusyButton>
    </form>
  );
}
