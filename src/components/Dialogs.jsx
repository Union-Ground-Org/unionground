import { runBusyWrite, prepareBusyWrite } from "../lib/busyWrite.js";
import { BusyButton, BusyFieldset } from "./BusyControls.jsx";
import { Check, ChevronRight, Lock, LogOut, Settings, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { useOrganizationName } from "../lib/organizationName.js";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { rpcErrorKeyStrict, rpcErrorTextAtRender } from "../lib/rpcErrorText.js";
import { SourceTaskAction } from "./SourceTaskAction.jsx";
import { Switch } from "./Surfaces.jsx";
import { notificationDestination } from "../lib/notificationDestinations.js";
import { celebrate } from "../lib/celebrate.js";
import { useChapterRailExpandedByDefault } from "../lib/chapterRailPreference.js";
import "../lib/i18n/features/fixtureNotificationsStrings.js";
import { fixtureNotificationsCatalogue } from "../lib/i18n/fixtureNotifications.js";
import { formatEasternTimestamp } from "../lib/easternTimestamp.js";
import { useModalDialog } from "./useModalDialog.js";

// Union Ground's lockable dialog. ./Dialog.jsx has no busy
// or locked state, and a ballot or a lifecycle record must not be closable
// while its write is in flight (tests/dialog-accessibility.test.jsx), so this
// module keeps its own Dialog, which OrganizeView and BargainingWriterDialog
// also import.
export function Dialog({
  eyebrow,
  title,
  onClose,
  children,
  wide = false,
  busy = false,
  locked = false,
  describedBy,
  restoreFocusRef,
}) {
  const { t } = useLang();
  const titleId = useId();
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  const closeLockedRef = useRef(busy || locked);
  closeRef.current = onClose;
  closeLockedRef.current = busy || locked;

  function requestClose() {
    if (!closeLockedRef.current) closeRef.current?.();
  }

  useModalDialog(dialogRef, { onClose, restoreFocusRef, closeLockedRef });

  // If a busy or locked view replaces the focused control, keep focus in
  // the dialog. A control that still has focus keeps it.
  useEffect(() => {
    const dialog = dialogRef.current;
    if ((busy || locked) && dialog && !dialog.contains(document.activeElement)) {
      dialog.focus({ preventScroll: true });
    }
  }, [busy, locked]);

  function onBackdropMouseDown(event) {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    requestClose();
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onBackdropMouseDown}>
      <section ref={dialogRef} className={`app-dialog ${wide ? "app-dialog--wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={describedBy} aria-busy={busy || undefined} tabIndex={-1}>
        <header><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2 id={titleId}>{title}</h2></div><BusyButton type="button" aria-label={t("dialogs.close")} onClick={requestClose} pending={busy} disabled={locked}><X size={20} /></BusyButton></header>
        <div className="app-dialog__body">{children}</div>
      </section>
    </div>
  );
}

export function ChoiceDialog({ item, onClose, onSubmit }) {
  const busyWriteRef = useRef(new Set());
  const { t } = useLang();
  const [selected, setSelected] = useDeviceParityState(`choice.${item.id}.selected`, item.selectedOption || "");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [failed, setFailed] = useState(false);
  // "closed" or "already-recorded": a final server refusal, never a retry.
  const [refused, setRefused] = useState(null);
  const [done, setDone] = useDeviceParityState(`choice.${item.id}.done`, false);
  // A freshly tapped option is authoritative over a stale persisted draft for
  // the same item: parity state survives across dialog opens, so without this
  // sync an earlier selection could win over the option the member just
  // tapped. Seeding happens only on mount, hence the effect.
  useEffect(() => {
    if (item.selectedOption) setSelected(item.selectedOption);
  }, [item.selectedOption, setSelected]);
  // Ballot votes are FINAL (20260808230000): a ballot that already holds a
  // receipt must never re-offer the form — there is no server row to update,
  // and a second submit would only bounce off the already-recorded refusal.
  const ballotCast = item.kind === "ballot" && Boolean(item.receiptCode);
  async function submit(event) {
    return prepareBusyWrite(busyWriteRef, "busy", () => {
      event.preventDefault();
      // A double-fired ballot submit would bounce off the server's final-vote
      // guard, but each pass still costs a round trip — and the busy latch is
      // what keeps the pulse path from double-logging its action.
      if (!selected || submitting.current || done || ballotCast || refused) return;
      return async (releaseBusyWrite) => {
      submitting.current = true;
      setBusy(true);
      setFailed(false);
      try {
        const result = await onSubmit(selected);
        // Closed campaigns and already-recorded ballots come back as a tagged
        // refusal: final, so the dialog says so instead of offering a retry.
        if (result?.refused) { setRefused(result.refused); { releaseBusyWrite(); return; } }
        // Only an acknowledged write is a success.
        if (!result) { setFailed(true); { releaseBusyWrite(); return; } }
        // Ballots close straight to the receipt toast; pulses linger on a brief
        // celebration so the member sees their answer land, then self-dismiss.
        if (item.kind === "ballot") { onClose(); { releaseBusyWrite(); return; } }
        setDone(true);
        // The shared small burst (REQ-UG-MILESTONE-CONFETTI-CELEBRATIONS-20261102),
        // once per acknowledged answer; reduced motion keeps the seal and text only.
        celebrate("small");
      } catch {
        // A page-level toast can sit behind this modal. Announce the failure
        // here too, without exposing driver text or discarding the answer.
        setFailed(true);
      } finally { submitting.current = false; setBusy(false);
        releaseBusyWrite();
      }
          };
    }, event);
  }
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => onCloseRef.current?.(), 1800);
    return () => clearTimeout(timer);
  }, [done]);
  return (
    <Dialog eyebrow={item.kind === "ballot" ? t("dialogs.ballotEyebrow") : t("dialogs.pulseEyebrow")} title={item.title} onClose={onClose} busy={busy}>
      {done ? (
        <div className="pulse-done" role="status">
          <span className="pulse-done__seal"><span className="pulse-done__ring" /><span className="pulse-done__ring pulse-done__ring--late" /><Check size={34} aria-hidden="true" /></span>
          <strong>{t("dialogs.pulseDoneTitle")}</strong>
          <p>{t("dialogs.pulseDoneBody")}</p>
        </div>
      ) : refused ? (
        // Final refusal: the page notice is behind this modal, so the dialog
        // states the outcome itself and offers no retry.
        <div className="choice-form" role="alert">
          <p className="choice-anon-note"><Lock size={14} aria-hidden="true" /> {t(refused === "closed" ? "toast.itemClosed" : "toast.voteAlreadyRecorded")}</p>
        </div>
      ) : ballotCast ? (
        // Already voted: the receipt is the only state the client holds (the
        // choice itself is stored unlinkably), so the dialog states finality
        // rather than re-rendering options it cannot mark.
        <div className="choice-form" role="status">
          <p className="choice-anon-note"><Lock size={14} aria-hidden="true" /> {t("dialogs.ballotFinalNote")}</p>
        </div>
      ) : (
      <form className="choice-form" onSubmit={submit} aria-busy={busy}>
        <BusyFieldset pending={busy}><legend>{item.kind === "ballot" ? t("dialogs.ballotPrompt") : t("dialogs.pulsePrompt")}</legend>{item.options.map((option) => (
          <label key={option.id} className={selected === option.id ? "selected" : ""}>
            <input type="radio" name="choice" value={option.id} checked={selected === option.id} onChange={() => setSelected(option.id)} />
            <span>{selected === option.id && <Check size={16} />}</span><strong>{option.label}</strong>
          </label>
        ))}</BusyFieldset>
        {/* Pulses reassure about answer anonymity; ballots state finality —
            the vote is stored unlinkably and cannot be changed once cast. */}
        {item.kind === "ballot"
          ? <p className="choice-anon-note"><Lock size={14} aria-hidden="true" /> {t("dialogs.ballotFinalNote")}</p>
          : <p className="choice-anon-note"><Lock size={14} aria-hidden="true" /> {t("dialogs.pulseAnonNote")}</p>}
        {failed && <p className="form-error" role="alert">{t("dialogs.choiceUnconfirmed")}</p>}
        <BusyButton className="dialog-primary" pending={busy} disabled={!selected}>{busy ? t("dialogs.saving") : item.kind === "ballot" ? t("dialogs.submitVote") : t("dialogs.submitAnswer")}</BusyButton>
      </form>
      )}
    </Dialog>
  );
}

// `chapterRailOwner` ({ memberId, demo }) is set only where the desktop
// chapter rail is drawn; it adds the rail's expanded-by-default switch.
export function ProfileDialog({ member, cosmeticBadge = null, onClose, onSave, onSignOut, signingOut = false, onSettings, onLanguage, chapterRailOwner = null }) {
  const busyWriteRef = useRef(new Set());
  const editHeadingId = useId();
  const { t, lang } = useLang();
  const [chapterRailExpanded, setChapterRailExpanded, chapterRailPreferenceAvailable] = useChapterRailExpandedByDefault(chapterRailOwner ?? {});
  const organizationName = useOrganizationName();
  const [busy, setBusy] = useState(false);
  const [languageBusy, setLanguageBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [signOutError, setSignOutError] = useState("");
  // Sign-out takes two server round trips before the page changes. The button
  // says so at once, and a refusal is shown here: the shell notice sits behind
  // this dialog's modal isolation, which made a failed first click look like
  // a click that did nothing. App runs one sign-out at a time and disables
  // this button while `signingOut`, so a repeat click joins the running one.
  async function signOut() {
    return runBusyWrite(busyWriteRef, "signingOut", async (releaseBusyWrite) => {
      try {
    setSignOutError("");
    try { await onSignOut(); }
    catch (error) { setSignOutError(error?.noticeKey || "toast.signOutCleanupFailed"); }

      } finally { releaseBusyWrite(); }
    });
  }
  async function changeLanguage(spanish) {
    return prepareBusyWrite(busyWriteRef, "languageBusy", () => {
      if (!onLanguage || busy || languageBusy) return;
      // Clear a prior refusal when an explicit language change starts. Refusals
      // arriving later keep their keys and follow the current language at render.
      setSaveError("");
      return async (releaseBusyWrite) => {
      setLanguageBusy(true);
      try { await onLanguage(spanish ? "es" : "en"); }
      catch {
        // The shared language handler owns notices and rollback. Keep this
        // dialog open and let the saved language control the switch state.
      } finally { setLanguageBusy(false);
        releaseBusyWrite();
      }
          };
    });
  }
  async function submit(event) {
    return prepareBusyWrite(busyWriteRef, "busy", () => {
      event.preventDefault();
      if (busy || languageBusy) return;
      setSaveError("");
      return async (releaseBusyWrite) => {
      setBusy(true);
      const form = new FormData(event.currentTarget);
      try {
        await onSave({
          firstName: String(form.get("firstName")),
          fullName: String(form.get("fullName")),
          initials: String(form.get("initials")),
          roleLine: String(form.get("roleLine")),
          sinceYear: String(form.get("sinceYear") ?? "").trim() === "" ? null : Number(form.get("sinceYear")),
        });
        onClose();
      } catch (error) {
        // Keep the card open so the edits survive. mutate()'s shell notice sits
        // behind modal isolation, so the refusal is announced inside the card.
        setSaveError(rpcErrorKeyStrict(error, "toast.saveFailed"));
      } finally { setBusy(false);
        releaseBusyWrite();
      }
          };
    }, event);
  }
  return (
    <Dialog eyebrow={t("dialogs.profileEyebrow", { organization: organizationName, name: member.fullName })} title={t("header.profile")} onClose={onClose}>
      {cosmeticBadge && <p className="reward-chip reward-chip--tier">✦ {cosmeticBadge}</p>}
      {/* REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030 (finding 114):
          Settings and Sign out are a plain account menu at the top of what the
          Profile button opens, in the Settings list's row style, rather than
          buttons trailing the member-card form where a phone screen cut them
          off. No handler, no row: the demo has no session to sign out of, and
          an exit-the-demo affordance is gone by owner decision (2026-07-28). */}
      {(onSettings || onSignOut) && <section className="morehub-list profile-account-menu" aria-label={t("morehub.account")}>
        {onSettings && <button className="morehub-row morehub-row--nav" type="button" onClick={onSettings}>
          <span className="morehub-row__icon" aria-hidden="true"><Settings size={19} /></span>
          <span className="morehub-row__label">{t("dialogs.settingsLink")}</span>
          <span className="morehub-row__chev" aria-hidden="true"><ChevronRight size={18} /></span>
        </button>}
        {onSignOut && <BusyButton className="morehub-row morehub-row--nav" type="button" pending={signingOut} aria-busy={signingOut || undefined} onClick={signOut}>
          <span className="morehub-row__icon" aria-hidden="true"><LogOut size={19} /></span>
          <span className="morehub-row__label">{signingOut ? t("app.signingOut") : t("dialogs.signOut")}</span>
          <span className="morehub-row__chev" aria-hidden="true"><ChevronRight size={18} /></span>
        </BusyButton>}
      </section>}
      {signOutError && <p className="case-files__error" role="alert">{t(signOutError)}</p>}
      {onLanguage && <section className="setin-card profile-switch-card" data-testid="profile-language" aria-busy={languageBusy || undefined}>
        <div className="setin-card__head"><h3>{t("setin.langTitle")}</h3></div>
        <div className="setin-row setin-row--toggle">
          <span className="setin-row__text"><strong>{t("morehub.spanish")}</strong><small>{languageBusy ? t("dialogs.saving") : t("morehub.spanishSub")}</small></span>
          <Switch label={t("morehub.spanish")} checked={lang === "es"} pending={busy || languageBusy} onChange={changeLanguage} />
        </div>
      </section>}
      {/* REQ-UG-CHAPTER-RAIL-COLLAPSED-BY-DEFAULT-MENU-TOGGLE-20261103:
          the chapter rail opens collapsed; this switch keeps it expanded on
          later loads and applies to the open rail at once. */}
      {chapterRailOwner && chapterRailPreferenceAvailable && <section className="setin-card profile-display-card profile-switch-card" data-testid="profile-chapter-rail">
        <div className="setin-card__head"><h3>{t("chapterRail.displayTitle")}</h3></div>
        <div className="setin-row setin-row--toggle">
          <span className="setin-row__text"><strong>{t("chapterRail.keepExpanded")}</strong><small>{t("chapterRail.keepExpandedSub")}</small></span>
          <Switch label={t("chapterRail.keepExpanded")} checked={chapterRailExpanded} onChange={setChapterRailExpanded} />
        </div>
      </section>}
      <form className="stack-form profile-edit-form" aria-labelledby={editHeadingId} onSubmit={submit}>
        <h3 id={editHeadingId}>{t("dialogs.editProfile")}</h3>
        <label>{t("dialogs.firstName")}<input name="firstName" defaultValue={member.firstName} required /></label>
        <label>{t("dialogs.fullName")}<input name="fullName" defaultValue={member.fullName} required /></label>
        <label>{t("dialogs.initials")}<input name="initials" defaultValue={member.initials} maxLength={3} required /></label>
        <label>{t("dialogs.roleLine")}<input name="roleLine" defaultValue={member.roleLine} required /></label>
        <label>{t("dialogs.memberSince")}<input name="sinceYear" type="number" min="1900" max="2200" defaultValue={member.sinceYear ?? ""} /></label>
        {saveError && <p className="case-files__error" role="alert">{rpcErrorTextAtRender(t, saveError)}</p>}
        <BusyButton className="dialog-primary" pending={(busy) || (languageBusy)}>{busy ? t("dialogs.saving") : t("dialogs.saveProfile")}</BusyButton>
      </form>
    </Dialog>
  );
}

export function NotificationsDialog({ notifications, onClose, onReadAll, onCreateTaskFromSource = null, onOpenTask = null, onOpenDestination = null, chapterId = null }) {
  const { t, lang } = useLang();
  const bodyRef = useRef(null);
  const readAllHadFocus = useRef(false);
  // #9466 W3b-2: the page notice is behind this window, so a refusal or a write
  // kept on this device is said under the button. Only the latest press sets it.
  const [readAllNote, setReadAllNote] = useState(null);
  const readAllPress = useRef(0);
  const hasUnread = notifications.some((item) => !item.read_at);
  useLayoutEffect(() => {
    if (!hasUnread && readAllHadFocus.current) {
      // Removing the focused button leaves focus on the document body. Do
      // not steal it if the person moved elsewhere while the write ran.
      if (document.activeElement === document.body) bodyRef.current?.focus();
      readAllHadFocus.current = false;
    }
  }, [hasUnread]);
  return (
    <Dialog eyebrow={t("dialogs.notificationsEyebrow")} title={t("dialogs.notificationsTitle")} onClose={onClose} bodyLabel={t("dialogs.notificationsTitle")} bodyRef={bodyRef}>
      {/* Unread used to be carried by the green tint alone (WCAG 1.4.1): a
          screen-reader user got no signal at all, and neither did anyone
          reading the list in a monochrome or forced-colours rendering. The dot
          in front of the title is the visible non-colour marker and the hidden
          word is what assistive tech announces — both live inside <strong> so
          they read as part of the title rather than as a stray line above it. */}
      <div className="notification-list">{notifications.length === 0 && <p className="dialog-empty">{t("dialogs.notificationsEmpty")}</p>}{notifications.map((item) => (
        <article key={item.id} className={item.read_at ? "" : "unread"}>{(() => {
          const destination = onOpenDestination ? notificationDestination(item, { chapterId }) : null;
          const timestamp = formatEasternTimestamp(item.created_at, lang);
          const fixturePrefix = `fixtureNotifications.${item.fixture_copy_key}`;
          const fixtureCopy = Object.hasOwn(fixtureNotificationsCatalogue.en, `${fixturePrefix}.title`);
          const content = <>{!item.read_at && <span className="eyebrow notification-unread">{t("inbox.unread")}</span>}<strong>{fixtureCopy ? t(`${fixturePrefix}.title`) : item.title}</strong><p>{fixtureCopy ? t(`${fixturePrefix}.body`) : item.body}</p>{timestamp ? <time dateTime={timestamp.dateTime}>{timestamp.text}</time> : <p>{t("settings.sessionUnknownDate")}</p>}</>;
          return destination
            ? <button type="button" className="notification-open" onClick={() => onOpenDestination(destination, item)}>{content}</button>
            : content;
        })()}{onCreateTaskFromSource && <SourceTaskAction sourceKind="notification" sourceId={item.id} onCreate={onCreateTaskFromSource} onOpenTask={onOpenTask} />}</article>
      ))}</div>
      {/* onReadAll is App's mutateWithOutcome() handler: it sets the page notice,
          then resolves with the outcome or re-throws. Both are read here. */}
      {hasUnread && <button className="dialog-primary" type="button" onClick={(event) => {
        readAllHadFocus.current = document.activeElement === event.currentTarget;
        setReadAllNote(null);
        const press = ++readAllPress.current;
        Promise.resolve(onReadAll()).then(
          (outcome) => { if (press === readAllPress.current && outcome?.status === "queued") setReadAllNote({ key: "offline.queued", alert: false }); },
          (error) => { if (press === readAllPress.current) setReadAllNote({ key: rpcErrorKeyStrict(error, "dialogs.markAllReadFailed"), alert: true }); },
        );
      }}>{t("dialogs.markAllRead")}</button>}
      {hasUnread && readAllNote && (readAllNote.alert
        ? <p className="case-files__error" role="alert">{t(readAllNote.key)}</p>
        : <p role="status">{t(readAllNote.key)}</p>)}
    </Dialog>
  );
}
