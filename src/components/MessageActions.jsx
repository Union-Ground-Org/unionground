import { Bell, Bookmark, Trash2 } from "lucide-react";
import { MessageReactionPicker, MessageReactionSummary } from "./MessageReactions.jsx";
import { SharedMessageActions } from "./SharedMessageActions.jsx";
import { ReminderTimePicker } from "./ReminderTimePicker.jsx";
import { useEffect, useRef, useState } from "react";
import { BusyButton } from "./BusyControls.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { messageActionFailureKey } from "../features/messaging/messageActionFailure.js";
import { aggregateMessageReactions, isMessageReactionKind } from "../features/messaging/index.js";

// BUG-UG-MESSAGE-REACTION-PARITY-20260904: this file used to declare its
// own three-kind list while the database allowed five and the Expo app carried
// a different map again. The kinds now come from the generated contract, so web
// and native offer exactly what toggle_member_message_reaction accepts.

// Shared across private, channel, task, and steward thread renderers. The API
// always receives the source kind, so the UI cannot accidentally treat a task
// id as a private-message id and widen its authorization boundary.
//
// `connectedActions` is the common connected-workflow control for THIS exact row
// (the controller's ConnectedRecordActions, rendered by the view through its
// renderConnectedActions(kind, record) callback). It sits in the same action
// group as a sibling of the row's own buttons, never inside one. It carries the
// reminder, message, task and source shortcuts, so the row's own "Remind me…"
// entry is withheld while it is present (`suppressReminder`, which follows it
// unless a caller says otherwise); reply, react, save, edit and removal stay, and
// so does cancelling a reminder that already exists.
export function MessageActions({ sourceKind, message, actorId, api, onNotice = () => {}, onMessageChange = () => {}, onReply = () => {}, connectedActions = null, suppressReminder = connectedActions != null }) {
  const { t } = useLang();
  const [state, setState] = useState(message);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  // Open while the member is choosing a reminder time. Opening it writes
  // nothing; only the chooser's own Confirm reaches api.remind.
  const [reminding, setReminding] = useState(false);
  const reminderTrigger = useRef(null);
  const wasReminding = useRef(false);
  // #9466 W3b-12: a failure is also said under the row (a phone-width thread is
  // a dialog over the page notice) until the next action on the row replaces it.
  const [failure, setFailure] = useState("");
  // BUG-UG-WEB-MESSAGE-ACTION-RESULT-OVERWRITES-NEWER-MESSAGE-20260920: a
  // result has to land on the newest row, not the snapshot the click closed
  // over, or a peer reaction or thread reload that arrives mid-flight is
  // written back out. Same ref guard SharedMessageActions uses for the private
  // and channel surfaces, for the paths that still run through this helper.
  const currentRow = useRef(message);
  useEffect(() => { currentRow.current = message; setState(message); setConfirmingRemoval(false); }, [message]);
  // The chooser belongs to one exact message. A new snapshot of the same row (a
  // peer reaction, a thread reload) must not discard a half-picked time, but a
  // different row must not inherit an open chooser.
  useEffect(() => { setReminding(false); setFailure(""); }, [message.id]);
  // A reminder that lands while the chooser is open (a refresh, another device)
  // closes it: the message already has one, and the slot now cancels it.
  useEffect(() => { if (state.reminder) setReminding(false); }, [state.reminder]);
  // Closing the chooser hands focus back to the control that opened it (or to
  // its cancel successor once a reminder exists) when the close left it on the
  // page body; a member who already moved on keeps their place.
  useEffect(() => {
    const focusLost = !document.activeElement || document.activeElement === document.body;
    if (wasReminding.current && !reminding && focusLost) reminderTrigger.current?.focus();
    wasReminding.current = reminding;
  }, [reminding]);
  if (!api?.toggleReaction || !api?.toggleSaved || !api?.remind) {
    // No row actions without the messaging api, but the exact record's common
    // actions do not depend on it.
    return connectedActions
      ? <div className="inbox-msg-actions" role="group" aria-label={t("inbox.messageActions")}><div className="inbox-msg-actions__connected">{connectedActions}</div></div>
      : null;
  }

  // Resolves true only when the write was confirmed and applied to the row on
  // screen, so a caller can close its own UI on success and keep it on failure.
  async function run(work, success, apply) {
    // The ref answers a second press in the same tick, before `busy` re-renders.
    if (busy || working.current) return false;
    working.current = true;
    const startedOn = currentRow.current.id;
    setBusy(true);
    setFailure("");
    try {
      const result = await work();
      const latest = currentRow.current;
      // A late acknowledgement for a row the surface has already replaced
      // belongs to no row on screen; applying it would move another message.
      if (latest.id !== startedOn) return false;
      const next = apply(latest, result);
      currentRow.current = next;
      setState(next);
      onMessageChange(next);
      onNotice(success);
      return true;
    } catch (error) {
      // UX-UG-WEB-MESSAGE-ACTION-FAILURE-TOAST-SHOWS-RAW-API-ERROR-20260920:
      // the raw MemberApiError text is untranslated English naming the RPC, so
      // the member gets the catalogue sentence instead.
      const failureKey = messageActionFailureKey(error, "inbox.actionFailed");
      onNotice(t(failureKey));
      if (currentRow.current.id === startedOn) setFailure(failureKey);
      // A revoked role answers 42501; leaving the chooser open would invite a
      // retry the server keeps refusing. Any other failure keeps the member's pick.
      if (error?.code === "42501") setReminding(false);
      return false;
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  async function confirmReminder(remindAt) {
    // The id is read once, at confirm time, from the row the chooser was opened
    // on; run() then refuses to apply an acknowledgement to any other row.
    const messageId = currentRow.current.id;
    const applied = await run(
      () => api.remind(sourceKind, messageId, remindAt),
      t("inbox.reminderSet"),
      (current, result) => ({ ...current, reminder: { id: result?.id, remind_at: remindAt, status: "pending" } }),
    );
    if (applied) setReminding(false);
  }

  function react(reaction) {
    // The select can only offer contract kinds, but the guard keeps a future
    // caller from posting a kind the database CHECK constraint would reject.
    if (!isMessageReactionKind(reaction)) return;
    run(
      () => api.toggleReaction(sourceKind, state.id, reaction),
      t("inbox.reactionSaved"),
      (current, result) => {
        if (typeof result?.reacted !== "boolean") throw new Error("Reaction was not confirmed");
        const others = (current.reactions || []).filter((item) => !(item.actor_id === actorId && item.reaction === reaction));
        const reacted = result.reacted;
        return { ...current, reactions: reacted ? [...others, { id: result?.id || `local-reaction-${Date.now()}`, actor_id: actorId, reaction }] : others };
      },
    );
  }

  // SEC-UG-MESSAGE-BODY-LIFECYCLE. This tests the row and the surface only:
  // a private source kind, an api that carries redactMessage, a member-authored
  // row, and one not already removed. It never compares actorId to the author.
  // redact_member_message makes that decision and is the authority: the member
  // who wrote the row removes it as sender_removed, chapter staff removing a
  // member's row get staff_removed, and every other caller gets a flat 42501.
  // Read this as presentation, never as the authorization check.
  const canRemove = Boolean(
    sourceKind === "private" && api.redactMessage
    && state.sender_kind === "member" && !state.redacted_at,
  );
  const aggregate = aggregateMessageReactions(state.reactions, actorId);
  const shared = api.messageAction && (sourceKind === "private" || sourceKind === "channel");
  return <>
    {shared && <SharedMessageActions sourceKind={sourceKind} message={message} actorId={actorId} api={api} onNotice={onNotice} onMessageChange={onMessageChange} onReply={onReply} connectedActions={connectedActions} suppressReminder={suppressReminder} />}
    {!shared && <MessageReactionSummary aggregate={aggregate} busy={busy} onReact={react} />}
    {/* UX-UG-SHARED-REACTIONS-RAW-ID-AND-DUP-GROUP: in shared mode
        SharedMessageActions already renders a named "Message actions" group,
        and everything this wrapper offers except removal is suppressed. It
        therefore drops the duplicate name there, and disappears entirely when
        removal is not on offer rather than announcing an empty named group. */}
    {(!shared || canRemove) && <div className="inbox-msg-actions" role={shared ? undefined : "group"} aria-label={shared ? undefined : t("inbox.messageActions")}>
      {!shared && <><MessageReactionPicker aggregate={aggregate} busy={busy} onReact={react} />
      <BusyButton type="button" aria-pressed={Boolean(state.saved)} pending={busy} onClick={() => run(() => api.toggleSaved(sourceKind, state.id), state.saved ? t("inbox.unsaved") : t("inbox.saved"), (current, result) => ({ ...current, saved: typeof result?.saved === "boolean" ? result.saved : !current.saved }))}><Bookmark size={13} fill={state.saved ? "currentColor" : "none"} aria-hidden="true" />{state.saved ? t("inbox.saved") : t("inbox.save")}</BusyButton>
      {state.reminder && api.cancelReminder ? (
        <BusyButton type="button" ref={reminderTrigger} pending={busy} onClick={() => run(
          () => api.cancelReminder(state.reminder.id),
          t("inbox.reminderCancelled"),
          (current) => ({ ...current, reminder: null }),
        )}><Bell size={13} aria-hidden="true" />{t("inbox.cancelReminder")}</BusyButton>
      ) : !suppressReminder && (
        <BusyButton type="button" ref={reminderTrigger} pending={busy} disabled={Boolean(state.reminder)} aria-expanded={reminding} onClick={() => { setFailure(""); setReminding((open) => !open); }}><Bell size={13} aria-hidden="true" />{state.reminder ? t("inbox.reminderSet") : t("inbox.remindMe")}</BusyButton>
      )}</>}
      {canRemove && <BusyButton
        type="button"
        className="inbox-msg-remove"
        pending={busy}
        onClick={() => {
          // Two-step rather than a modal: removal destroys the text server-side
          // and cannot be undone, so the second press is the confirmation.
          if (!confirmingRemoval) { setConfirmingRemoval(true); return; }
          setConfirmingRemoval(false);
          run(
            () => api.redactMessage(state.id),
            t("inbox.messageRemoved"),
            (current, result) => {
              // During the organization's learning period the server holds the
              // sender's own removal (hidden from everyone, undoable from the
              // practice history) instead of destroying it at once.
              if (!result?.redacted && !result?.alreadyRedacted && !result?.held) throw new Error(t("inbox.actionFailed"));
              return { ...current, ...result.message, body: "",
                redacted_at: result.message?.redacted_at || new Date().toISOString(),
                redaction_reason: result.message?.redaction_reason || result.reasonCode || "sender_removed" };
            },
          );
        }}
      ><Trash2 size={13} aria-hidden="true" />{confirmingRemoval ? t("inbox.confirmRemoveMessage") : t("inbox.removeMessage")}</BusyButton>}
      {!shared && connectedActions && <div className="inbox-msg-actions__connected">{connectedActions}</div>}
    </div>}
    {!shared && reminding && <ReminderTimePicker busy={busy} onCancel={() => setReminding(false)} onConfirm={confirmReminder} />}
    {failure && <p className="case-files__error" role="alert">{t(failure)}</p>}
  </>;
}
