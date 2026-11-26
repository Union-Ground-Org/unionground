import { useEffect, useRef, useState } from "react";
import { BusyButton } from "./BusyControls.jsx";
import { messageActionChoices, messageActionLabelKey } from "../features/messaging/actions.js";
import { messageActionFailureKey } from "../features/messaging/messageActionFailure.js";
import { aggregateMessageReactions, reconcileOwnReactions } from "../features/messaging/reactions.js";
import { MessageReactionPicker, MessageReactionSummary } from "./MessageReactions.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { ReminderTimePicker } from "./ReminderTimePicker.jsx";

export function SharedMessageActions(props) {
  const { sourceKind, message, actorId } = props;
  return <MessageActionComposer key={JSON.stringify([sourceKind, message.id, actorId, Boolean(message.redacted_at)])} {...props} />;
}

// connectedActions / suppressReminder: see MessageActions. The slot is rendered
// whether or not the row's own capabilities have loaded, because the common
// control re-checks access itself when it opens.
function MessageActionComposer({ sourceKind, message, actorId, api, onNotice, onMessageChange, onReply = () => {}, connectedActions = null, suppressReminder = connectedActions != null }) {
  // UX-UG-SHARED-REACTIONS-RAW-ID-AND-DUP-GROUP: this menu named every
  // reaction by its contract id, so a member picked "solidarity" where the
  // non-shared menu offers "Solidarity" and Spanish offers "Solidaridad".
  // The label key travels with the kind, so both menus read the same.
  const { t } = useLang();
  const [capabilities, setCapabilities] = useState(null);
  const [row, setRow] = useState(message);
  const [busy, setBusy] = useState(false);
  // "edit" and "reply" open the text composer; "remind" opens the time chooser.
  // None of them sends anything until its own confirm control is pressed.
  const [compose, setCompose] = useState(null);
  const [draft, setDraft] = useState("");
  // #9466 W3b-12: a failure is also said under the row (a phone-width thread is
  // a dialog over the page notice) until the next action on the row replaces it.
  const [failure, setFailure] = useState("");
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const reminderTrigger = useRef(null);
  const replyTrigger = useRef(null);
  const editTrigger = useRef(null);
  const composerField = useRef(null);
  // The control that opened the current chooser or composer. Reply and edit
  // stay mounted when their composer closes; remind and unremind share one ref
  // so a saved reminder still returns to "Remove reminders".
  const opener = useRef(replyTrigger);
  const wasComposing = useRef(null);
  // A reply or edit write disables its confirm button. A browser then moves
  // focus to the page body. This asks the effect to put focus back in the
  // field when that write fails and the draft is still there.
  const restoreField = useRef(false);
  const generation = useRef(0);
  const working = useRef(false);
  const readVersion = useRef(0);
  const currentRow = useRef(message);
  useEffect(() => () => { generation.current += 1; }, []);
  useEffect(() => {
    const version = ++readVersion.current;
    currentRow.current = message;
    setRow(message);
    if (!message.redacted_at) void api.messageAction(sourceKind, message.id, "state").then((next) => {
      if (version === readVersion.current) setCapabilities(next);
    }).catch((error) => {
      if (version === readVersion.current && error?.code === "42501") {
        setCapabilities(null); setCompose(null); setDraft("");
        generation.current += 1; working.current = false; setBusy(false);
      }
    });
    return () => { readVersion.current += 1; };
  }, [message, api, sourceKind]);
  useEffect(() => {
    if (compose && capabilities && !messageActionChoices(capabilities).some((choice) => choice.id === compose)) {
      setCompose(null); setDraft("");
      generation.current += 1; working.current = false; setBusy(false);
    }
  }, [capabilities, compose]);
  // Closing a reply, edit, or reminder returns focus to the control that opened
  // it when the close left focus on the page body. A failed reply or edit keeps
  // the draft and, if focus fell on the body, puts it back in the field.
  // Switching composers, or moving on to another field, keeps that place.
  useEffect(() => {
    const focusLost = !document.activeElement || document.activeElement === document.body;
    const previous = wasComposing.current;
    if (previous && compose === null && focusLost) {
      const target = opener.current.current;
      if (target) target.focus();
    } else if (restoreField.current && focusLost && composerField.current) composerField.current.focus();
    if (!busy) restoreField.current = false;
    wasComposing.current = compose;
  }, [compose, busy]);

  async function run(action, value = null) {
    if (working.current) return;
    if (action === "reply" || action === "edit") restoreField.current = true;
    const version = generation.current;
    const submittedDraft = draft;
    working.current = true; setBusy(true); setFailure("");
    try {
      const result = await api.messageAction(sourceKind, message.id, action, value);
      if (version !== generation.current) return;
      readVersion.current += 1;
      if (action === "state") { setCapabilities(result); return; }
      // The textarea stays editable during a write. Its reply only confirms
      // the submitted text, so later typing must remain available to send.
      const draftUnchanged = latestDraft.current === submittedDraft;
      if (action === "reply") {
        onReply(result);
        if (draftUnchanged) { setCompose(null); setDraft(""); }
      }
      else {
        const latest = currentRow.current;
        const next = action === "edit" ? { ...latest, ...result } : { ...latest,
          saved: result.state.saved, reminder: result.state.reminders[0] ?? null,
          reactions: [...(latest.reactions ?? []).filter((reaction) => reaction.actor_id !== actorId),
            ...result.state.reactions.map((reaction) => ({ reaction, actor_id: actorId }))] };
        if (result.state) setCapabilities(result.state);
        currentRow.current = next; setRow(next);
        if (action === "remind" || (action === "edit" && draftUnchanged)) { setCompose(null); setDraft(""); }
        onMessageChange(next);
      }
      onNotice(t("inbox.actionSaved"));
    } catch (error) {
      if (version !== generation.current) return;
      // A refusal is not always transient: a revoked role or an MFA lapse answers
      // 42501, and leaving the composer or chooser open would invite a retry the
      // server will keep refusing. Drop the capabilities so the row asks to load
      // them again instead. Any other failure keeps the member's draft or time.
      if (error?.code === "42501") { setCapabilities(null); setCompose(null); setDraft(""); }
      const failureKey = messageActionFailureKey(error, "inbox.actionNotConfirmed");
      onNotice(t(failureKey));
      setFailure(failureKey);
    }
    finally { if (version === generation.current) { working.current = false; setBusy(false); } }
  }

  if (message.redacted_at) return null;
  const loadedAggregate = aggregateMessageReactions(row.reactions, actorId);
  const aggregate = capabilities ? reconcileOwnReactions(loadedAggregate, capabilities.reactions) : loadedAggregate;
  return <>
    <MessageReactionSummary aggregate={aggregate} busy={busy || !capabilities} onReact={(kind) => run("react", kind)} />
    <div className="inbox-msg-actions" role="group" aria-label={t("inbox.messageActions")}>
      {!capabilities ? <BusyButton type="button" pending={busy} onClick={() => run("state")}>{t("inbox.loadMessageActions")}</BusyButton> : messageActionChoices(capabilities).filter((choice) => !(suppressReminder && choice.id === "remind")).map((choice) => choice.id === "react"
        ? <MessageReactionPicker key={choice.id} aggregate={aggregate} busy={busy} onReact={(kind) => run("react", kind)} />
        : <BusyButton key={choice.id} type="button" pending={busy}
          ref={choice.id === "reply" ? replyTrigger : choice.id === "edit" ? editTrigger : choice.id === "remind" || choice.id === "unremind" ? reminderTrigger : undefined}
          aria-expanded={choice.id === "remind" ? compose === "remind" : undefined}
          onClick={() => {
            setFailure("");
            if (choice.id === "edit" || choice.id === "reply") {
              opener.current = choice.id === "reply" ? replyTrigger : editTrigger;
              setCompose(choice.id); setDraft(choice.id === "edit" ? row.body : "");
            }
            else if (choice.id === "remind") { opener.current = reminderTrigger; setCompose((open) => (open === "remind" ? null : "remind")); setDraft(""); }
            else void run(choice.id, null);
          }}>{t(messageActionLabelKey(choice))}</BusyButton>)}
      {connectedActions && <div className="inbox-msg-actions__connected">{connectedActions}</div>}
    </div>
    {compose === "remind" ? <ReminderTimePicker busy={busy} onCancel={() => setCompose(null)} onConfirm={(remindAt) => { void run("remind", remindAt); }} /> : compose ? <div className="thread-composer">
      <label>{compose === "edit" ? t("inbox.editMessage") : t("inbox.replyToMessage")}<textarea ref={composerField} aria-label={compose === "edit" ? t("inbox.editMessage") : t("inbox.replyToMessage")} maxLength={4000} value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
      <BusyButton type="button" pending={busy} disabled={!draft.trim()} onClick={() => run(compose, draft.trim())}>{compose === "edit" ? t("inbox.saveEdit") : t("inbox.sendReply")}</BusyButton>
      <BusyButton type="button" pending={busy} onClick={() => { setCompose(null); setDraft(""); }}>{t("inbox.cancel")}</BusyButton>
    </div> : null}
    {failure && <p className="case-files__error" role="alert">{t(failure)}</p>}
  </>;
}
