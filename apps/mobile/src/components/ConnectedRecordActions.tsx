import { useApp } from '../state/AppProvider';
import { useRequestGeneration } from '../lib/useRequestGeneration';
// Native connected-record action sheet: one trigger plus a shared modal sheet
// over the connected-workflow facade. Mutations re-check context first and the
// server rechecks every grant; staff-only choices come from recordActions()
// under an explicit staff identity and never select or change a hat.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text, TextInput } from './Text';
import type {
  ConnectedPerson,
  ConnectedPage,
  ConnectedRecipientPage,
  ConnectedSourceRef,
  ConnectedWorkflowContext,
} from '../lib/connectedWorkflows';
import {
  CONNECTED_MESSAGE_LIMITS,
  connectedWorkflowApi,
  newConnectedRequestId,
  recordActions,
  retainRecipients,
} from '../lib/connectedWorkflows';
import { nativeTaskRoute, nativeWorkflowRoute } from '../lib/connectedWorkflowRoutes';
import { clearUnsentDraft, keepUnsentDraft, readUnsentDraft } from '../lib/connectedDrafts';
import { readResumeDraft, resumeDraftIsCurrent, resumeDraftScopeIsActive, retireResumeDraft, settleResumeDraft, useResumeDraft, writeResumeDraft, type ContactResumeDraft, type ReminderResumeDraft, type ResumeDraftEntry, type ResumeDraftKey, type WorkflowResumeDraft } from '../lib/resumeDraftHolder';
import { isAuthoritativeReadRefusal } from '../lib/readRefusal';
import { withReadDeadline } from '../lib/readDeadline';
import {
  type ConnectedLanguage,
  connectedActionsCopy,
  connectedContactCopy,
  connectedTaskEditorCopy,
} from '../lib/connectedWorkflowsCopy';
import { useTheme } from '../theme/ThemeProvider';
import { elevation } from '../theme/elevation';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { ConnectedTaskEditor } from './ConnectedTaskEditor';
import { EventDiscussionReader } from './EventDiscussionReader';
import { ReminderPicker } from './ReminderPicker';

import { typeface } from '../theme/typeface';
import { useAccessibilityAnnouncementQueue } from '../lib/announce';
// Failure families where the shared facade (or its server contract) means the
// action must stop: drop the composer, drop cached context, show the failure
// copy. Mirrors the web ConnectedRecordActions run() handler.
const FATAL_CODES = [
  '42501',
  'not_authorized',
  'scope_changed',
  'source_unavailable', 'organizer_changed',
  'source_removed',
  'recipient_unavailable',
  'event_cancelled',
  'opt_in_required',
] as const;

function fatalFailure(failure: unknown): boolean {
  const code = (failure as { code?: string; reason?: string } | null);
  const token = code?.code ?? code?.reason;
  return isAuthoritativeReadRefusal(failure) || Boolean(token && (FATAL_CODES as readonly string[]).includes(token));
}

type ComposeMode = 'message' | 'remind' | 'discussion' | 'source' | 'task' | null;

type RunFn = (work: () => Promise<unknown>) => Promise<void>;
type CheckedFn = () => Promise<ConnectedWorkflowContext | null>;

type Props = {
  resumeKey?: ResumeDraftKey<'workflow'> | null;
  sendKey?: ResumeDraftKey<'workflowSend'> | null;
  reminderKey?: ResumeDraftKey<'workflowReminder'> | null;
  reminderSendKey?: ResumeDraftKey<'workflowReminderSend'> | null;
  contactKey?: ResumeDraftKey<'workflowContact'> | null;
  contactSendKey?: ResumeDraftKey<'workflowContactSend'> | null;
  reference: ConnectedSourceRef;
  scopeKey?: string;
  staffAccess: boolean;
  language: ConnectedLanguage;
  label?: string;
  /** Card title, carried into the trigger and sheet so actions name their target. */
  recordTitle?: string;
  /** Controlled open state; omit for the internal toggle (cards, triggers). */
  visible?: boolean;
  onVisibleChange?: (open: boolean) => void;
  /** false renders no trigger (host already provides one). */
  renderTrigger?: boolean;
  onNavigate?: (nativeRoute: string) => void;
  /** Whether onNavigate can open this route for the worn role (false: it would refuse). */
  canNavigate?: (nativeRoute: string) => boolean;
};

export function ConnectedRecordActions(props: Props) {
  const { session } = useApp();
  const held = useResumeDraft(props.resumeKey ?? null, true);
  const reminder = useResumeDraft(props.reminderKey ?? null, true);
  const contact = useResumeDraft(props.contactKey ?? null, true);
  const [internalOpen, setInternalOpen] = useState(false);
  const open = (props.visible ?? internalOpen) || held?.value.open === true || reminder?.value.open === true || contact?.value.open === true;
  return <RecordActionSheet key={JSON.stringify([session?.user.id, props.resumeKey?.id, props.scopeKey, props.reference, props.staffAccess, open])} {...props} visible={open} onVisibleChange={(value) => { setInternalOpen(value); props.onVisibleChange?.(value); }} />;
}

function RecordActionSheet(props: Props) {
  const theme = useTheme();
  const language = props.language;
  const copy = connectedActionsCopy[language];
  const taskCopy = connectedTaskEditorCopy[language];
  const { session } = useApp();
  const messageLimit = props.reference.kind === 'task' ? 2000 : CONNECTED_MESSAGE_LIMITS.maxBody;
  const fill = (text: string, values: Record<string, number>) => text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
  const [internalOpen, setInternalOpen] = useState(false);
  const open = props.visible ?? internalOpen;
  const setOpen = (value: boolean) => {
    setInternalOpen(value);
    props.onVisibleChange?.(value);
  };

  const [context, setContext] = useState<ConnectedWorkflowContext | null>(null);
  const [localBusy, setBusy] = useState(false);
  const [accessReady, setAccessReady] = useState(false);
  const [checkedBearer, setCheckedBearer] = useState<string | undefined | null>(null);
  const sourceFresh = accessReady && checkedBearer === session?.access_token;
  // Pending/settled metadata must keep updating even when access conceals the
  // message, so a settled unknown attempt can expose its owner's Discard.
  const heldSendEntry = useResumeDraft(props.sendKey ?? null, true);
  const reminder = useResumeDraft(props.reminderKey ?? null, true);
  const reminderSend = useResumeDraft(props.reminderSendKey ?? null, true);
  const contact = useResumeDraft(props.contactKey ?? null, true);
  const contactSend = useResumeDraft(props.contactSendKey ?? null, true);
  const sendEntry = sourceFresh ? heldSendEntry : null;
  const busy = localBusy || heldSendEntry?.pending === true || reminderSend?.pending === true || contactSend?.pending === true;
  const [error, showError] = useState('');
  // Which kind of run (or, between runs, the last one) set the failure line,
  // so a queued restore keeps only an action's failure (gate stage 472).
  const runKind = useRef<'action' | 'restore'>('action');
  const errorFrom = useRef<'action' | 'restore'>('action');
  const setError = (message: string) => { errorFrom.current = runKind.current; showError(message); };
  const [notice, setNotice] = useState('');
  const [reminderRemoved, setReminderRemoved] = useState(false);
  const [compose, setCompose] = useState<ComposeMode>(null);
  // This owner's live compose mode, for a restore that outlives its render:
  // another owner's Cancel writes open=false on the shared entry, but an
  // owner still composing here has not cancelled anything (gate stage 494).
  const composeRef = useRef<ComposeMode>(null);
  composeRef.current = compose;
  const [body, setBody] = useState('');
  const [recipients, setRecipients] = useState<ConnectedPerson[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [taskEdit, setTaskEdit] = useState<{ id: string; intro: string } | null>(null);
  const [accessGeneration, setAccessGeneration] = useState(0);
  const [contactGeneration, setContactGeneration] = useState(0);
  const working = useRef(false);
  const queuedAccess = useRef<(() => void) | null>(null);
  const alive = useRef(false);
  const requestId = useRef<{ payload: string; id: string } | null>(null);
  // Set when a check (an action's preflight or restoration) retires a held
  // reminder; run() names it once when that run ends. Set explains it itself.
  const preflightRetiredReminder = useRef(false);

  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const api = useMemo(() => connectedWorkflowApi(session), [session]);
  useEffect(() => {
    setAccessReady(false);
    if (props.visible === true && api) {
      if (working.current) queuedAccess.current = () => { void run(restoreComposer, true, true); };
      else void run(restoreComposer, true);
    }
    // Opening is keyed to the controlled visibility; callback identities do not reopen drafts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible, session?.access_token]);
  // Ledger 612: two mounted owners can share one held message (a task's card
  // in the Tasks list and in the task's own view, both on the stack). The held
  // entry is the composer's source: this owner follows what the other writes,
  // and when the other's send or Discard retires it, this owner's copy goes
  // too, so it is never sent again as a new first send. A holder that only
  // conceals the entry while a check is unresolved changes nothing here.
  const heldMessage = useResumeDraft(props.resumeKey ?? null, true);
  const heldScopeActive = resumeDraftScopeIsActive(props.resumeKey ?? null);
  // Set below, once the restore exists: reads the recipient pages a followed
  // selection names (read R-612, F1).
  const readFollowedPages = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!props.resumeKey || compose !== 'message' || !heldScopeActive) return;
    if (!heldMessage) {
      setCompose(null); setBody(''); setSelected([]); setRecipients([]); setNextCursor(null);
      requestId.current = null;
      return;
    }
    setBody((current) => (current === heldMessage.value.body ? current : heldMessage.value.body));
    setSelected((current) => (JSON.stringify(current) === JSON.stringify(heldMessage.value.selected) ? current : heldMessage.value.selected));
    requestId.current = heldMessage.value.attempt;
    // The other owner may have ticked people on recipient pages this owner has
    // not read: read them first (the restore pages until every held person is
    // found), so Send waits for the whole list instead of dropping them.
    if (retainRecipients(heldMessage.value.selected, recipients).length < heldMessage.value.selected.length) readFollowedPages.current?.();
    // Follows the shared entry only; local edits write that entry first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldMessage, heldScopeActive, compose]);
  useEffect(() => {
    if (!sourceFresh || !reminderSend?.value.saved || reminderSend.pending) return;
    if (!resumeDraftIsCurrent(reminderSend, true)) return;
    setOpen(true); retireResumeDraft(props.reminderKey ?? null); retireResumeDraft(props.reminderSendKey ?? null);
    setCompose(null); setNotice(copy.reminderSet);
    // The exact receipt is consumed once under fresh access, even after remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceFresh, reminderSend, copy.reminderSet]);
  if (!api || !props.reference?.id) return null;

  const closeComposer = () => {
    const held = readResumeDraft(props.resumeKey ?? null);
    if (held) writeResumeDraft(held.key, { ...held.value, open: false });
    setCompose(null); setBody(''); setSelected([]); setRecipients([]); setNextCursor(null); setTaskEdit(null);
    requestId.current = null;
  };
  // Only the owner's explicit Discard may retire an uncertain send.
  const discardComposer = () => {
    retireResumeDraft(props.resumeKey ?? null);
    retireResumeDraft(props.sendKey ?? null);
    clearUnsentDraft(props.scopeKey, props.reference);
    closeComposer();
  };

  const unknownAttempt = () => {
    const held = readResumeDraft(props.resumeKey ?? null);
    const send = readResumeDraft(props.sendKey ?? null);
    return held?.value.attempt && (send?.pending || send?.value.failed) ? held.value.attempt : null;
  };
  const discardOrConceal = () => {
    if (unknownAttempt()) {
      setAccessReady(false); setContext(null); setError(copy.failed);
    } else discardComposer();
  };

  const keepMessage = (patch: Partial<WorkflowResumeDraft>) => {
    if (unknownAttempt()) return;
    if (props.resumeKey) writeResumeDraft(props.resumeKey, { body, selected, open: true, attempt: requestId.current, ...patch });
    else if (patch.body !== undefined) keepUnsentDraft(props.scopeKey, props.reference, patch.body);
  };
  // Ledger 626: retiring a held editor can remove the only entry that keeps a
  // resumed sheet mounted, so its owner is kept open first and the sheet's one
  // notice is seen instead of a silent close.
  const retireUnsentReminder = () => {
    if (!readResumeDraft(props.reminderKey ?? null) || readResumeDraft(props.reminderSendKey ?? null)) return false;
    setOpen(true); retireResumeDraft(props.reminderKey ?? null);
    return true;
  };
  const retireUnsentEditors = () => {
    retireUnsentReminder();
    if (!readResumeDraft(props.contactKey ?? null) || readResumeDraft(props.contactSendKey ?? null)) return;
    setOpen(true); retireResumeDraft(props.contactKey ?? null);
  };

  // Ledger 635 and 630 (a): a restore queued by a token change runs as the
  // run it waited for ends, so it keeps the lines a person-started action
  // owes (Message sent, the removed-reminder line, its failure) instead of
  // clearing them in the same tick; a failure line a restore set is cleared
  // (gate stage 472). A failure of its own replaces a kept failure line and
  // otherwise adds its one alert below the kept line, which is still true.
  const run = async (work: () => Promise<unknown>, restore = false, queued = false) => {
    if (working.current) return;
    working.current = true;
    runKind.current = restore ? 'restore' : 'action';
    setBusy(true);
    if (!queued) { setError(''); setNotice(''); setReminderRemoved(false); }
    else if (errorFrom.current === 'restore') setError('');
    preflightRetiredReminder.current = false;
    try {
      await work();
    } catch (failure) {
      if (alive.current) {
        if (fatalFailure(failure)) {
          discardOrConceal();
          setContext(null);
        }
        setError(copy.failed);
      }
    } finally {
      if (alive.current) {
        working.current = false; setBusy(false);
        if (preflightRetiredReminder.current) { preflightRetiredReminder.current = false; setReminderRemoved(true); }
        const next = queuedAccess.current; queuedAccess.current = null; next?.();
      }
    }
  };

  const checked: CheckedFn = async () => {
    if (!alive.current) return null;
    let current: ConnectedWorkflowContext;
    try { current = await withReadDeadline(api.context(props.reference)); }
    catch (failure) {
      if (alive.current && props.resumeKey) { setAccessReady(false); setContext(null); }
      if (alive.current && isAuthoritativeReadRefusal(failure)) retireUnsentEditors();
      throw failure;
    }
    if (!alive.current) return null;
    setContext(current);
    if (!current.available) {
      retireUnsentEditors();
      if (props.resumeKey) discardOrConceal(); else closeComposer();
      setError(copy.unavailable);
      return null;
    }
    if (!current.canRemind && retireUnsentReminder()) preflightRetiredReminder.current = true;
    return current;
  };

  readFollowedPages.current = () => {
    if (working.current) queuedAccess.current = () => { void run(restoreComposer, true, true); };
    else void run(restoreComposer, true);
  };

  const restoreComposer = async () => {
    // A held reminder that checked() retires for lost permission is named by
    // its own flag (the reminderRemoved line), never by comparing the holder
    // around the read, which would also count the person's own Discard.
    const current = await checked();
    if (!alive.current || !current) return;
    const held = readResumeDraft(props.resumeKey ?? null);
    // Gate stage 494: open=false can be the other owner's Cancel on the
    // shared entry. An owner still composing here still needs the recipient
    // pages its followed selection names, or its Send re-queues this restore
    // forever and never sends. This owner's own Cancel clears its compose
    // mode first, and the entry-current check below still stops a restore
    // whose entry moved on while it paged.
    if (held && (held.value.open || unknownAttempt() || composeRef.current === 'message')) {
      if (!current.canMessage) { discardOrConceal(); return; }
      const people: ConnectedPerson[] = [];
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const page: ConnectedRecipientPage = await withReadDeadline(api.recipients(props.reference, cursor));
        if (!alive.current || !resumeDraftIsCurrent(held, true)) return;
        if (page.status !== 'available') { discardOrConceal(); setContext(null); return; }
        people.push(...page.items); cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('Recipient cursor repeated');
        if (cursor) seen.add(cursor);
      } while (cursor && retainRecipients(held.value.selected, people).length < held.value.selected.length);
      if (retainRecipients(held.value.selected, people).length !== held.value.selected.length) { discardOrConceal(); return; }
      setRecipients(people); setNextCursor(cursor); setSelected(held.value.selected);
      setBody(held.value.body); requestId.current = held.value.attempt; setCompose('message');
    }
    const reminder = readResumeDraft(props.reminderKey ?? null);
    if (reminder?.value.open) {
      if (current.canRemind) setCompose('remind');
      else if (!readResumeDraft(props.reminderSendKey ?? null)) retireResumeDraft(reminder.key);
    }
    setAccessReady(true);
    setCheckedBearer(session?.access_token);
    setAccessGeneration((value) => value + 1);
  };

  // BUG-UG-NATIVE-IOS-TASK-DISCUSSION-KEYBOARD-COVERS-SEND-20261111:
  // the opened screen is the destination, so the sheet closes behind it
  // instead of staying over the discussion until Cancel.
  const navigate = (route: string) => {
    if (!props.onNavigate) { setError(copy.unmapped); return; }
    // #9080: a screen the worn role cannot open is named, not "Action not confirmed".
    if (props.canNavigate && !props.canNavigate(route)) { setError(copy.roleClosed); return; }
    // Gate stage 449 r1s1: a check in this run retired a held reminder, so the
    // sheet stays for this run to show its one reminderRemoved line; the same
    // action, pressed again, opens the screen.
    if (preflightRetiredReminder.current) return;
    props.onNavigate(route);
    close();
  };

  const choose = (action: string) => {
    if (unknownAttempt()) return;
    void run(async () => {
      const current = await checked();
      if (!current) return;
      const stillAllowed = recordActions(current, { staffAccess: props.staffAccess })
        .some((item) => item.id === action);
      if (!stillAllowed) return;

      if (action === 'message') {
        const page = await withReadDeadline(api.recipients(props.reference));
        if (!alive.current) return;
        if (page.status === 'unavailable') {
          setContext(null); discardComposer(); setError(copy.unavailable); return;
        }
        const held = readResumeDraft(props.resumeKey ?? null);
        closeComposer();
        requestId.current = held?.value.attempt ?? null;
        setRecipients(page.items);
        setNextCursor(page.nextCursor);
        const body = props.resumeKey ? held?.value.body ?? '' : readUnsentDraft(props.scopeKey, props.reference);
        const selected = retainRecipients(held?.value.selected ?? [], page.items);
        setSelected(selected);
        setBody(body);
        writeResumeDraft(props.resumeKey ?? null, { body, selected, open: true, attempt: requestId.current });
        setCompose('message');
        return;
      }

      if (action === 'remind' || action === 'source') {
        closeComposer();
        if (action === 'remind' && props.reminderKey) {
          const held = readResumeDraft(props.reminderKey);
          writeResumeDraft(props.reminderKey, held ? { ...held.value, open: true } : { open: true, date: Date.now() + 3600000, chosen: false, note: '', step: null });
        }
        setCompose(action as ComposeMode);
        return;
      }

      if (action === 'discussion') {
        if (props.reference.kind === 'event') {
          closeComposer();
          setCompose('discussion');
          return;
        }
        const route = nativeWorkflowRoute(current.discussionHref);
        route ? navigate(route) : setError(copy.unmapped);
        return;
      }

      // BUG-UG-NATIVE-IOS-EVENT-FOLLOW-UP-TASK-OPENS-NOTHING-20261117
      // (#9080): Chapter work opens only for a role held in this chapter, while
      // the task RPCs also accept an organization-wide grant. A linked task
      // Chapter work would refuse opens in the task form here, with that reason,
      // instead of failing as "Action not confirmed".
      if (action === 'openTask') {
        const taskId = current.linkedTask?.id ?? '';
        const route = linkedTaskRoute(current);
        if (route && props.onNavigate && (props.canNavigate?.(route) ?? true)) { navigate(route); return; }
        if (!taskId) { setError(copy.unmapped); return; }
        closeComposer();
        setTaskEdit({ id: taskId, intro: route && props.onNavigate ? taskCopy.workClosed : taskCopy.opened });
        setCompose('task');
        return;
      }

      // The server names the new task "Follow up on event" and assigns nobody
      // (it never copies source text into a title), so the task form opens on
      // it at once for the title, the person and the due date.
      if (action === 'createTask') {
        const result = await api.createTask(props.reference);
        if (!alive.current) return;
        setContext({ ...current, linkedTask: result.task });
        closeComposer();
        setTaskEdit({ id: result.task.id, intro: result.created ? taskCopy.created : taskCopy.opened });
        setCompose('task');
      }
    });
  };

  const submitMessage = () => {
    if (props.resumeKey && !sourceFresh) return;
    const replay = unknownAttempt();
    // This payload was produced locally immediately before the first send.
    // A retry sends that exact body and audience, never a current projection.
    const original = replay ? JSON.parse(replay.payload) as [string[], string] : null;
    const text = original?.[1] ?? body.trim();
    if (!text || text.length > messageLimit || (original?.[0] ?? selected).length === 0) return;
    if (readResumeDraft(props.sendKey ?? null)?.pending) return;
    const composing = readResumeDraft(props.resumeKey ?? null);
    // Ledger 612: with no held message there is nothing of this composer's to
    // send (another owner sent or discarded it, or the holder conceals it).
    if (props.resumeKey && !composing) return;
    void run(async () => {
      let pending: ResumeDraftEntry<'workflowSend'> | null = null;
      try {
        const current = await checked();
        // BUG-UG-NATIVE-RECORD-SHEET-CLOSE-DURING-SEND-CHECK-DELETES-DRAFT-20261115
        // (#8773): a sheet that closed during the check refused nothing, so the
        // kept draft stays for the next time the composer opens. A refused
        // first try may discard unsent work; an earlier dispatched attempt
        // stays held and concealed because a view or retry refusal cannot
        // establish the outcome of that first send.
        if (!alive.current || (composing && !resumeDraftIsCurrent(composing, true))) return;
        if (!current?.canMessage) {
          discardOrConceal(); setError(copy.unavailable); return;
        }
        const ids = original?.[0] ?? retainRecipients(selected, recipients);
        // A ticked person on a page this owner has not read yet: never send to
        // part of the list and never discard; read the pages, then Send again.
        if (!original && ids.length < selected.length) { queuedAccess.current = () => { void run(restoreComposer, true, true); }; return; }
        if (ids.length === 0) { discardOrConceal(); setError(copy.unavailable); return; }
        const payload = JSON.stringify([[...ids].sort(), text]);
        if (replay) requestId.current = replay;
        else if (requestId.current?.payload !== payload) requestId.current = { payload, id: newConnectedRequestId() };
        // Preflight is a read, not an outstanding dispatch. Keep an earlier
        // settled attempt discardable until the exact send is dispatched.
        pending = props.sendKey ? writeResumeDraft(props.sendKey, { failed: false }, true) : null;
        if (props.sendKey && !pending) return;
        const held = readResumeDraft(props.resumeKey ?? null);
        if (held) writeResumeDraft(held.key, { ...held.value, attempt: requestId.current });
        await api.send(props.reference, ids, text, requestId.current.id);
        if (pending) {
          if (!settleResumeDraft(pending, null)) return;
          retireResumeDraft(props.resumeKey ?? null);
        }
        clearUnsentDraft(props.scopeKey, props.reference);
        if (!alive.current) return;
        closeComposer();
        setNotice(copy.sent);
      } catch (failure) {
        if (pending) {
          if (fatalFailure(failure) && !replay) {
            if (settleResumeDraft(pending, null)) retireResumeDraft(props.resumeKey ?? null);
          } else settleResumeDraft(pending, { failed: true });
        }
        throw failure;
      }
    });
  };

  const confirmReminder = async (result: { iso: string; note: string } | null) => {
    if (!result) { closeComposer(); return; }
    if (readResumeDraft(props.reminderSendKey ?? null)?.pending) return;
    const draft = readResumeDraft(props.reminderKey ?? null);
    // A refusal may retire the only held-open editor. Keep its sheet owner
    // mounted long enough to explain the result of this explicit Set action.
    setOpen(true);
    await run(async () => {
      let pending: ResumeDraftEntry<'workflowReminderSend'> | null = null;
      try {
        const current = await checked();
        if (!alive.current) return;
        preflightRetiredReminder.current = false;
        if (!current?.canRemind) { closeComposer(); setError(copy.unavailable); return; }
        if (draft && !resumeDraftIsCurrent(draft, true)) return;
        pending = props.reminderSendKey ? writeResumeDraft(props.reminderSendKey, { failed: false, saved: false }, true) : null;
        if (props.reminderSendKey && !pending) return;
        await api.remind(props.reference, result.iso, result.note);
        if (pending) { settleResumeDraft(pending, { failed: false, saved: true }); return; }
        if (!alive.current) return;
        closeComposer();
        setNotice(copy.reminderSet);
      } catch (failure) {
        if (pending) settleResumeDraft(pending, { failed: true, saved: false });
        throw failure;
      }
    });
  };

  const closeReminder = () => {
    const held = readResumeDraft(props.reminderKey ?? null);
    if (held) writeResumeDraft(held.key, { ...held.value, open: false });
    closeComposer();
  };
  const discardReminder = () => {
    if (readResumeDraft(props.reminderSendKey ?? null)?.pending) return;
    retireResumeDraft(props.reminderKey ?? null); retireResumeDraft(props.reminderSendKey ?? null);
    // A separate Message draft can keep this sheet open; Discard closes only
    // the reminder it retires.
    setCompose((mode) => mode === 'remind' ? null : mode); setOpen(false);
  };
  const discardContact = () => {
    if (readResumeDraft(props.contactSendKey ?? null)?.pending) return;
    retireResumeDraft(props.contactKey ?? null); retireResumeDraft(props.contactSendKey ?? null);
    // Remount the editor so no local copy or in-flight read outlives Discard
    // when another draft keeps this sheet mounted.
    setContactGeneration((value) => value + 1); setOpen(false);
  };

  const loadMoreRecipients = () => {
    if (!nextCursor) return;
    void run(async () => {
      const page = await withReadDeadline(api.recipients(props.reference, nextCursor));
      if (!alive.current) return;
      if (page.status === 'unavailable') { closeComposer(); setError(copy.unavailable); return; }
      setRecipients((rows) => [...new Map([...rows, ...page.items].map((p) => [p.id, p])).values()]);
      setNextCursor(page.nextCursor);
    });
  };

  const toggle = () => {
    if (busy) return;
    if (open) {
      setOpen(false); closeComposer(); setNotice(''); setReminderRemoved(false); return;
    }
    setOpen(true);
  };

  const close = () => {
    for (const key of [props.reminderKey, props.contactKey]) {
      const held = readResumeDraft(key ?? null);
      if (held) writeResumeDraft(held.key, { ...held.value, open: false });
    }
    setOpen(false); closeComposer(); setNotice(''); setReminderRemoved(false);
  };

  const choices = context ? recordActions(context, { staffAccess: props.staffAccess }) : [];
  const editedTaskRoute = compose === 'task' && context ? linkedTaskRoute(context) : null;
  const openEditedTask = editedTaskRoute && props.onNavigate && (props.canNavigate?.(editedTaskRoute) ?? true)
    ? () => navigate(editedTaskRoute) : undefined;
  const actionName = props.reference.kind === 'event' ? copy.eventActions : copy.taskActions;
  const label = props.label ?? (props.recordTitle ? `${actionName}: ${props.recordTitle}` : actionName);
  const reminderVisible = compose === 'remind' && sourceFresh && context?.canRemind === true;
  const sheetAlert = Boolean(error || sendEntry?.value.failed || reminderSend?.value.failed || contactSend?.value.failed);

  // #9959: the first unmet condition of Send's unchanged disabled test, in words.
  const sendReason = selected.length === 0 ? copy.sendNeedsRecipient
    : body.trim().length === 0 ? copy.sendNeedsMessage
      : body.trim().length > messageLimit ? fill(copy.sendTooLong, { max: messageLimit }) : '';
  // While an unknown attempt is held, or while a send or a More recipients
  // read runs (busy), the rows and the field refuse changes, so no line tells
  // the person to choose, remove or write anything.
  const attemptHeld = Boolean(unknownAttempt());
  const linesPaused = busy || attemptHeld;
  const limitText = recipients.length > 0
    ? fill(selected.length >= CONNECTED_MESSAGE_LIMITS.maxRecipients ? copy.recipientLimitReached : copy.recipientLimit, { max: CONNECTED_MESSAGE_LIMITS.maxRecipients, count: selected.length })
    : '';
  const limitLine = linesPaused ? '' : limitText;
  const reasonLine = linesPaused ? '' : sendReason;
  return (
    <View style={styles.root}>
      {props.renderTrigger !== false ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ expanded: open, disabled: busy }}
          disabled={busy}
          onPress={toggle}
          style={styles.trigger}
        >
          <Text style={[styles.triggerText, { color: theme.primary }]}>{props.label ?? actionName}</Text>
        </Pressable>
      ) : null}

      <Modal visible={open && !reminderVisible} transparent animationType="fade" onRequestClose={close}>
        {/* The sheet rides above the keyboard (as conversation/[id].tsx does),
            so the composer and its Send button are never covered. */}
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.scrim, { backgroundColor: theme.background }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.cancel}
            style={StyleSheet.absoluteFill}
            onPress={close}
          />
          <View style={[styles.sheet, elevation.level3, { backgroundColor: theme.popover, borderColor: theme.border }]}>
            <View style={styles.sheetHead}>
              <Text accessibilityRole="header" style={[styles.title, { color: theme.foreground }]}>
                {props.recordTitle ? `${copy.actions}: ${props.recordTitle}` : copy.actions}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={copy.close}
                onPress={close}
                style={styles.closeButton}
              >
                <Text style={{ color: theme.primary }}>{copy.close}</Text>
              </Pressable>
            </View>

            <ScrollView style={styles.sheetBody} keyboardShouldPersistTaps="handled">
              {context?.cancelled ? (
                <Text accessibilityLiveRegion="polite" style={{ color: theme.destructive }}>{copy.cancelled}</Text>
              ) : null}
              {notice ? (
                <Text accessibilityLiveRegion="polite" style={{ color: theme.primary }}>{notice}</Text>
              ) : null}
              {reminderRemoved ? (
                <Text accessibilityLiveRegion="polite" style={{ color: theme.mutedForeground }}>{copy.reminderRemoved}</Text>
              ) : null}
              {busy && !context ? <Text style={{ color: theme.mutedForeground }}>{copy.loading}</Text> : null}
              {reminder && (reminderSend || reminder.value.chosen || reminder.value.note.trim()) && !reminderSend?.pending ? <Pressable accessibilityRole="button" onPress={discardReminder} style={[styles.choice, { borderColor: theme.border }]}><Text style={{ color: theme.foreground }}>{copy.discardReminder}</Text></Pressable> : null}
              {contact && (contactSend || contact.value.editing || contact.value.optIn !== null) && !contactSend?.pending ? <Pressable accessibilityRole="button" onPress={discardContact} style={[styles.choice, { borderColor: theme.border }]}><Text style={{ color: theme.foreground }}>{copy.discardContact}</Text></Pressable> : null}

              {unknownAttempt() && !readResumeDraft(props.sendKey ?? null)?.pending ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={heldSendEntry?.pending === true}
                  onPress={() => {
                    if (readResumeDraft(props.sendKey ?? null)?.pending) return;
                    discardComposer();
                    // Closing replaces this sheet owner, so an old read cannot
                    // publish into the next composer or block its controls.
                    setOpen(false);
                  }}
                  style={[styles.choice, { borderColor: theme.border }]}
                >
                  <Text style={{ color: theme.foreground }}>{copy.discard}</Text>
                </Pressable>
              ) : null}

              {!context?.available ? null : (
                <View accessibilityRole="none" accessibilityLabel={copy.actions} style={styles.choices}>
                  {choices.map((action) => (
                    <Pressable
                      key={action.id}
                      accessibilityRole="button"
                      accessibilityLabel={action.label}
                      disabled={busy || Boolean(unknownAttempt())}
                      onPress={() => choose(action.id)}
                      style={[styles.choice, { borderColor: theme.border, backgroundColor: theme.card }]}
                    >
                      <Text style={{ color: theme.foreground }}>
                        {(copy as Record<string, string>)[action.id] ?? action.label}
                      </Text>
                    </Pressable>
                  ))}
                  {choices.length === 0 ? <Text style={{ color: theme.mutedForeground }}>{copy.empty}</Text> : null}
                </View>
              )}

              <EventContactSettings
                key={`${context?.organizer?.id || 'unassigned'}:${contactGeneration}`}
                api={api}
                reference={props.reference}
                context={context}
                staffAccess={props.staffAccess}
                language={language}
                busy={busy}
                run={run}
                refresh={checked}
                freshAccess={sourceFresh}
                accessGeneration={accessGeneration}
                resumeKey={props.contactKey ?? null}
                sendKey={props.contactSendKey ?? null}
                onSettled={(message) => { setOpen(true); setNotice(message); }}
                onRetry={() => void run(restoreComposer, true)}
                sheetAlert={sheetAlert}
                onLost={(explain) => { setOpen(true); if (explain) setError(copy.failed); }}
              />

              {sheetAlert ? (
                <View accessibilityRole="alert" style={styles.errorBlock}>
                  <Text style={{ color: theme.destructive }}>{error || copy.failed}</Text>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => void run(restoreComposer, true)}
                    style={[styles.choice, { borderColor: theme.border }]}
                  >
                    <Text style={{ color: theme.primary }}>{copy.retry}</Text>
                  </Pressable>
                </View>
              ) : null}

              {compose === 'task' && taskEdit ? (
                <ConnectedTaskEditor
                  key={taskEdit.id}
                  taskId={taskEdit.id}
                  language={language}
                  intro={taskEdit.intro}
                  onOpenInWork={openEditedTask}
                />
              ) : null}

              {compose === 'discussion' && context?.available ? (
                <EventDiscussionReader reference={props.reference} context={context} api={api} language={language} />
              ) : null}

              {compose === 'source' && context?.available ? (
                context.sourceLinks.length === 0 ? (
                  <Text style={{ color: theme.mutedForeground }}>{copy.empty}</Text>
                ) : (
                  context.sourceLinks.map((link, index) => (
                    <Pressable
                      key={`${link.label}-${index}`}
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={() => void run(async () => {
                        const current = await withReadDeadline(api.context(link.reference));
                        if (!alive.current) return;
                        setContext(current);
                        if (!current.available || !current.href) { setError(copy.unavailable); return; }
                        const route = nativeWorkflowRoute(current.href);
                        route ? navigate(route) : setError(copy.unmapped);
                      })}
                      style={[styles.choice, { borderColor: theme.border, backgroundColor: theme.card }]}
                    >
                      <Text style={{ color: theme.foreground }}>{link.label}</Text>
                    </Pressable>
                  ))
                )
              ) : null}

              {compose === 'message' && (!props.resumeKey || sourceFresh) ? (
                <View style={styles.composer}>
                  <Text style={[styles.label, { color: theme.mutedForeground }]}>{copy.recipients}</Text>
                  {/* #9959: the limit is stated where people are picked, before it is reached. */}
                  {limitLine ? <Text accessibilityLiveRegion="polite" style={{ color: theme.mutedForeground }}>{limitLine}</Text> : null}
                  {/* accessibilityLiveRegion is Android-only: VoiceOver hears each
                      change of the two lines through the app's announcement queue. */}
                  <ComposerLineAnnouncement owner={`composer-limit:${props.reference.kind}:${props.reference.id}`} text={limitText} paused={linesPaused} />
                  <ComposerLineAnnouncement owner={`composer-reason:${props.reference.kind}:${props.reference.id}`} text={sendReason} paused={linesPaused} />
                  {recipients.length === 0 ? (
                    <Text style={{ color: theme.mutedForeground }}>{copy.noRecipients}</Text>
                  ) : recipients.map((person) => {
                    const active = selected.includes(person.id);
                    return (
                      <Pressable
                        key={person.id}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: active, disabled: busy || Boolean(unknownAttempt()) || (!active && selected.length >= CONNECTED_MESSAGE_LIMITS.maxRecipients) }}
                        accessibilityLabel={person.label}
                        disabled={busy || Boolean(unknownAttempt()) || (!active && selected.length >= CONNECTED_MESSAGE_LIMITS.maxRecipients)}
                        onPress={() => {
                          if (unknownAttempt()) return;
                          const next = active ? selected.filter((id) => id !== person.id) : [...selected, person.id];
                          setSelected(next);
                          keepMessage({ selected: next });
                        }}
                        style={styles.personRow}
                      >
                        <Text style={{ color: active ? theme.primary : theme.foreground }}>
                          {active ? '✓ ' : '○ '}{person.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                  {nextCursor ? (
                    <Pressable accessibilityRole="button" disabled={busy} onPress={loadMoreRecipients} style={styles.personRow}>
                      <Text style={{ color: theme.primary }}>{copy.more}</Text>
                    </Pressable>
                  ) : null}
                  <Text style={[styles.label, { color: theme.mutedForeground }]}>{copy.messageBody}</Text>
                  <TextInput keyboardAppearance={theme.appearance} selectionColor={theme.primary} accessibilityLabel={copy.messageBody} multiline value={body} onChangeText={(value) => { if (unknownAttempt()) return; setBody(value); keepMessage({ body: value }); }} editable={!busy && !unknownAttempt()} maxLength={messageLimit} style={{ minHeight: 100, padding: spacing.sm, color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border, borderWidth: 1 }} />
                  <Text style={{ color: theme.mutedForeground }}>
                    {`${body.length}/${messageLimit}`}
                  </Text>
                </View>
              ) : null}
            </ScrollView>
            {compose === 'message' && (!props.resumeKey || sourceFresh) ? (
              // Send and Cancel stay pinned under the scrolling body, so a long
              // recipient list never pushes them out of view.
              <View style={styles.composerFooter}>
                {/* #9959: why Send cannot send yet; the disabled test below is unchanged. */}
                {reasonLine ? <Text accessibilityLiveRegion="polite" style={{ color: theme.mutedForeground }}>{reasonLine}</Text> : null}
              <View style={styles.actionRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy || Boolean(sendReason), busy }}
                  accessibilityHint={reasonLine || undefined}
                  disabled={busy || selected.length === 0 || body.trim().length === 0 || body.trim().length > messageLimit}
                  onPress={submitMessage}
                  style={[styles.choice, { backgroundColor: theme.primary }]}
                >
                  <Text style={{ color: theme.primaryForeground }}>{copy.send}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" disabled={busy} onPress={closeComposer} style={[styles.choice, { borderColor: theme.border }]}>
                  <Text style={{ color: theme.mutedForeground }}>{copy.cancel}</Text>
                </Pressable>
              </View>
              </View>
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <ReminderPicker
        visible={reminderVisible}
        onClose={closeReminder}
        onConfirm={confirmReminder}
        retained={reminder ? { value: reminder.value, onChange: (draft: ReminderResumeDraft) => {
          if (!readResumeDraft(props.reminderSendKey ?? null)) writeResumeDraft(reminder.key, draft);
        }, pending: reminderSend?.pending === true, locked: reminderSend?.value.failed === true,
        failed: reminderSend?.value.failed ? copy.failed : '', retryLabel: copy.retry, discardLabel: copy.discardReminder, onDiscard: discardReminder } : undefined}
        minDate={new Date()}
        maxDate={new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)}
      />
    </View>
  );
}

function linkedTaskRoute(context: ConnectedWorkflowContext): string | null {
  return nativeWorkflowRoute(context.linkedTask?.href) ?? nativeTaskRoute(context.linkedTask?.id ?? '');
}

// Organizer / contact preference section: mirrors the web EventContactSettings
// (radio list organizer picker with a paginated More list, plus the honest
// opt-in checkbox with its RSVP privacy explanation).
function EventContactSettings(props: {
  api: NonNullable<ReturnType<typeof connectedWorkflowApi>>;
  reference: ConnectedSourceRef;
  context: ConnectedWorkflowContext | null;
  staffAccess: boolean;
  language: ConnectedLanguage;
  busy: boolean;
  run: RunFn;
  refresh: CheckedFn;
  freshAccess: boolean;
  accessGeneration: number;
  resumeKey: ResumeDraftKey<'workflowContact'> | null;
  sendKey: ResumeDraftKey<'workflowContactSend'> | null;
  onSettled: (message: string) => void;
  /** The sheet's own Try again: re-reads the source, clears the error and re-runs this editor. */
  onRetry: () => void;
  /** The sheet already shows its alert and Try again (ledger 627). */
  sheetAlert: boolean;
  /** Restoration is retiring the held entry: keep the sheet open; explain=true when this editor is hidden (ledger 626). */
  onLost: (explain: boolean) => void;
}) {
  const theme = useTheme();
  const copy = connectedContactCopy[props.language];
  const actions = connectedActionsCopy[props.language];
  const { context } = props;
  const receipt = useResumeDraft(props.sendKey, true);
  const [editing, setEditing] = useState(false);
  const [people, setPeople] = useState<ConnectedPerson[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [optIn, setOptIn] = useState<boolean | null>(null);
  const [ready, setReady] = useState('');
  const [readError, setReadError] = useState(false);
  // Capabilities belong to the signature: losing only one retires its
  // known-unsent choice, as losing the record's access does.
  const signature = JSON.stringify([props.reference, props.accessGeneration, props.freshAccess, context?.eventVersion, context?.organizer?.id,
    context?.canManageOrganizer === true, context?.canContactOptIn === true]);
  const requests = useRequestGeneration(signature);
  const available = props.freshAccess && props.reference.kind === 'event' && context?.available === true;
  const organizerID = context?.organizer?.id ?? null;
  const version = context?.eventVersion ?? null;
  const empty = (): ContactResumeDraft => ({ open: true, editing: false, picked: null, optIn: null, organizerID, version });
  // A member who may no longer opt in sees no editor, so the sheet explains.
  const hidden = !props.staffAccess && !context?.canContactOptIn;

  useEffect(() => {
    if (!available) return;
    const ticket = requests.capture();
    let current = true;
    const owns = () => current && ticket.isCurrent();
    setReadError(false);
    void (async () => {
      let held = readResumeDraft(props.resumeKey);
      const settled = readResumeDraft(props.sendKey);
      if (settled?.value.saved && !settled.pending && resumeDraftIsCurrent(settled, true)) {
        if (held) {
          // An organizer save that left the organizer unchanged keeps the
          // opt-in typed against that same organizer and version.
          const kept = (held.value.picked || null) === held.value.organizerID
            && held.value.organizerID === organizerID && held.value.version === version;
          const next = settled.value.kind === 'organizer'
            ? { ...held.value, editing: false, picked: null, optIn: kept ? held.value.optIn : null, organizerID, version }
            : { ...held.value, optIn: null };
          if (next.editing || next.optIn !== null) writeResumeDraft(held.key, next);
          else retireResumeDraft(held.key);
        }
        retireResumeDraft(settled.key);
        props.onSettled(settled.value.kind === 'organizer' ? copy.organizerSaved : copy.contactSaved);
        held = readResumeDraft(props.resumeKey);
      }
      // Losing ONE capability retires only that unsent choice and keeps the
      // other, still-allowed one. A dispatched receipt keeps the whole entry
      // for its own Discard, and organizer or version drift retires it all.
      let narrowed = false;
      if (held && !readResumeDraft(props.sendKey) && held.value.organizerID === organizerID && held.value.version === version) {
        const lostOrganizer = held.value.editing && (!props.staffAccess || !context?.canManageOrganizer);
        const lostOptIn = held.value.optIn !== null && !context?.canContactOptIn;
        if (lostOrganizer !== lostOptIn) {
          const rest = lostOrganizer ? { ...held.value, editing: false, picked: null } : { ...held.value, optIn: null };
          if (rest.editing || rest.optIn !== null) writeResumeDraft(held.key, rest);
          else { props.onLost(hidden); retireResumeDraft(held.key); }
          held = readResumeDraft(props.resumeKey); narrowed = true;
        }
      }
      if (held && ((held.value.editing && (!props.staffAccess || !context?.canManageOrganizer))
        || (held.value.optIn !== null && !context?.canContactOptIn)
        || held.value.organizerID !== organizerID || held.value.version !== version)) {
        throw { code: 'organizer_changed' };
      }
      const candidates: ConnectedPerson[] = [];
      let next: string | null = null;
      if (held?.value.editing) {
        const seen = new Set<string>();
        do {
          const page: ConnectedPage<ConnectedPerson> = await withReadDeadline(props.api.eventOrganizerCandidates(props.reference.id, next));
          if (!owns() || !resumeDraftIsCurrent(held, true)) return;
          candidates.push(...page.items); next = page.nextCursor;
          if (next && seen.has(next)) throw new Error('Organizer cursor repeated');
          if (next) seen.add(next);
        } while (next && held.value.picked && !candidates.some(person => person.id === held.value.picked));
        if (held.value.picked && !candidates.some(person => person.id === held.value.picked)) throw { code: 'recipient_unavailable' };
      }
      if (!owns()) return;
      setEditing(held?.value.editing ?? false); setPicked(held?.value.picked ?? null);
      setOptIn(held?.value.optIn ?? null); setPeople(candidates); setCursor(next); setReady(signature);
      // The retired half is explained by the editor's one notice.
      if (narrowed) setReadError(true);
    })().catch((failure: unknown) => {
      if (!owns()) return;
      if (fatalFailure(failure) && !readResumeDraft(props.sendKey)) {
        if (readResumeDraft(props.resumeKey)) props.onLost(hidden);
        retireResumeDraft(props.resumeKey);
        setEditing(false); setPicked(null); setOptIn(null);
      }
      setReadError(true);
    });
    return () => { current = false; };
    // Draft field changes are deliberately not a reason to restore over typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, receipt?.value.saved]);

  if (!available || hidden) return null;
  // The sheet's alert already names this state, and its Try again re-runs
  // this editor: one notice, never two (ledger 627).
  if (readError && props.sheetAlert) return null;
  if (ready !== signature || readError) return <View style={styles.contact}>
    <Text accessibilityRole={readError ? 'alert' : undefined} style={{ color: theme.foreground }}>{readError ? actions.failed : actions.loading}</Text>
    {readError ? <Pressable accessibilityRole="button" disabled={props.busy} onPress={props.onRetry} style={[styles.choice, { borderColor: theme.border }]}><Text style={{ color: theme.primary }}>{actions.retry}</Text></Pressable> : null}
  </View>;
  const locked = receipt?.value.failed === true;
  // A held editor's local fields only mirror its holder entry; once that entry
  // is retired, nothing is rebuilt or sent from the local copy.
  const unheld = (): ContactResumeDraft => props.resumeKey ? empty() : { ...empty(), editing, picked, optIn };
  const change = (patch: Partial<ContactResumeDraft>) => {
    if (readResumeDraft(props.sendKey)) return;
    const next = { ...(readResumeDraft(props.resumeKey)?.value ?? unheld()), ...patch, open: true };
    if (props.resumeKey && !writeResumeDraft(props.resumeKey, next)) return;
    setEditing(next.editing); setPicked(next.picked); setOptIn(next.optIn);
  };
  const save = (kind: 'organizer' | 'contact') => {
    if (readResumeDraft(props.sendKey)?.pending || (locked && receipt?.value.kind !== kind)) return;
    const held = readResumeDraft(props.resumeKey);
    const draft = held?.value ?? unheld();
    if ((kind === 'organizer' && draft.picked === null) || (kind === 'contact' && draft.optIn === null)) return;
    void props.run(async () => {
      const ticket = requests.capture();
      let pending: ResumeDraftEntry<'workflowContactSend'> | null = null;
      try {
        const fresh = await props.refresh();
        if (!ticket.isCurrent() || !fresh) return;
        if (held && !resumeDraftIsCurrent(held, true)) return;
        // The fresh context retires stale contact choices in their own
        // restore effect. A local preflight mismatch must not invoke the
        // shared fatal handler that also discards the Message editor. A held
        // choice in an editor that stays shown gets that editor's one notice
        // (the fresh context always moves its signature here), so a sheet
        // error would double it; a hidden editor leaves the sheet to explain.
        if (!fresh.available || (fresh.eventVersion ?? null) !== draft.version || (fresh.organizer?.id ?? null) !== draft.organizerID
          || (kind === 'organizer' ? !props.staffAccess || !fresh.canManageOrganizer : !fresh.canContactOptIn)) {
          if (held && (props.staffAccess || fresh.canContactOptIn)) return;
          throw new Error('Meeting choices changed before save');
        }
        pending = props.sendKey ? writeResumeDraft(props.sendKey, { kind, failed: false, saved: false }, true) : null;
        if (props.sendKey && !pending) return;
        if (kind === 'organizer') await props.api.setEventOrganizer(props.reference.id, draft.picked || null, draft.version);
        else await props.api.setEventContactOptIn(props.reference.id, draft.optIn ?? false, draft.organizerID);
        if (pending) {
          if (!settleResumeDraft(pending, { kind, failed: false, saved: true })) return;
        } else if (ticket.isCurrent()) { setEditing(false); setOptIn(null); }
        if (ticket.isCurrent()) await props.refresh();
      } catch (failure) {
        if (pending) settleResumeDraft(pending, { kind, failed: true, saved: false });
        throw failure;
      }
    });
  };
  return <View accessibilityRole="none" style={styles.contact}>
    {context?.organizer ? <Text style={{ color: theme.mutedForeground }}>{`${copy.organizer}: ${context.organizer.label}`}</Text> : null}
    {props.staffAccess && context?.canManageOrganizer ? !editing ? (
      <Pressable accessibilityRole="button" disabled={props.busy || locked} onPress={() => void props.run(async () => {
        const ticket = requests.capture();
        const page = await withReadDeadline(props.api.eventOrganizerCandidates(props.reference.id));
        if (!ticket.isCurrent()) return;
        setPeople(page.items); setCursor(page.nextCursor);
        change({ editing: true, picked: organizerID ?? '' });
      })} style={[styles.choice, { borderColor: theme.border }]}><Text style={{ color: theme.primary }}>{copy.edit}</Text></Pressable>
    ) : <View style={styles.people}>
      <Pressable accessibilityRole="radio" accessibilityState={{ selected: picked === '' }} disabled={props.busy || locked} onPress={() => change({ picked: '' })} style={styles.personRow}><Text style={{ color: picked === '' ? theme.primary : theme.foreground }}>{copy.none}</Text></Pressable>
      {people.map(person => <Pressable key={person.id} accessibilityRole="radio" accessibilityState={{ selected: picked === person.id }} disabled={props.busy || locked} onPress={() => change({ picked: person.id })} style={styles.personRow}><Text style={{ color: picked === person.id ? theme.primary : theme.foreground }}>{person.label}</Text></Pressable>)}
      {cursor ? <Pressable accessibilityRole="button" disabled={props.busy || locked} onPress={() => void props.run(async () => {
        const ticket = requests.capture();
        const page = await withReadDeadline(props.api.eventOrganizerCandidates(props.reference.id, cursor));
        if (!ticket.isCurrent()) return;
        setPeople(rows => [...new Map([...rows, ...page.items].map(person => [person.id, person])).values()]); setCursor(page.nextCursor);
      })} style={styles.personRow}><Text style={{ color: theme.primary }}>{copy.more}</Text></Pressable> : null}
      <View style={styles.actionRow}>
        <Pressable accessibilityRole="button" disabled={props.busy || picked === null || (locked && receipt?.value.kind !== 'organizer')} onPress={() => save('organizer')} style={[styles.choice, { backgroundColor: theme.primary }]}><Text style={{ color: theme.primaryForeground }}>{copy.save}</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={props.busy || locked} onPress={() => change({ editing: false, picked: null })} style={[styles.choice, { borderColor: theme.border }]}><Text style={{ color: theme.mutedForeground }}>{actions.cancel}</Text></Pressable>
      </View>
    </View> : null}
    {context?.canContactOptIn ? <View style={styles.people}>
      <Pressable accessibilityRole="checkbox" accessibilityLabel={copy.optIn} accessibilityState={{ checked: optIn ?? context.contactOptIn, disabled: props.busy || locked }} disabled={props.busy || locked} onPress={() => change({ optIn: !(optIn ?? context.contactOptIn) })} style={styles.personRow}>
        <Text style={{ color: optIn ?? context.contactOptIn ? theme.primary : theme.foreground }}>{(optIn ?? context.contactOptIn) ? '✓ ' : '○ '}{copy.optIn}</Text>
      </Pressable>
      <Text style={{ color: theme.mutedForeground }}>{copy.privacy}</Text>
      <Pressable accessibilityRole="button" disabled={props.busy || optIn === null || (locked && receipt?.value.kind !== 'contact')} onPress={() => save('contact')} style={[styles.choice, { borderColor: theme.border }]}><Text style={{ color: theme.primary }}>{copy.update}</Text></Pressable>
    </View> : null}
  </View>;
}

// #9959: on iOS, VoiceOver does not read accessibilityLiveRegion (Android
// only), so a composer line that changes is announced through the app's one
// announcement queue, once per change of its text. `text` is what the line
// says when it is not paused (a send, a More recipients read or a held attempt
// pauses it, and the line is then hidden). It never speaks for the first text
// the line shows (the composer opening, or its recipients arriving), never
// while paused, never for an empty line, and not again when a pause ends on
// the text it had before; an empty line that fills again (a cleared message)
// is spoken. Pending speech is cancelled on unmount. Android keeps its live
// region alone, so nothing is said twice.
function ComposerLineAnnouncement({ owner, text, paused }: { owner: string; text: string; paused: boolean }) {
  const announce = useAccessibilityAnnouncementQueue(owner);
  const primed = useRef(false);
  const last = useRef('');
  useEffect(() => {
    if (paused) return;
    if (!primed.current) {
      if (!text) return;
      primed.current = true;
      last.current = text;
      return;
    }
    if (last.current === text) return;
    last.current = text;
    if (text && Platform.OS === 'ios') announce(text);
  }, [announce, paused, text]);
  return null;
}

const styles = StyleSheet.create({
  root: { position: 'relative' },
  trigger: { minHeight: minimumTouchTarget, justifyContent: 'center', paddingHorizontal: spacing.sm },
  triggerText: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: radii.sheetRadius ?? 24,
    borderTopRightRadius: radii.sheetRadius ?? 24,
    maxHeight: '92%',
    paddingBottom: spacing.lg,
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    gap: spacing.sm,
  },
  title: { flex: 1, fontSize: 17, lineHeight: 24, ...typeface.heading },
  closeButton: { minHeight: minimumTouchTarget, justifyContent: 'center', paddingHorizontal: spacing.sm },
  sheetBody: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  composerFooter: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  choices: { gap: spacing.sm },
  choice: {
    minHeight: minimumTouchTarget,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  contact: { gap: spacing.sm, marginTop: spacing.md },
  people: { gap: spacing.xs },
  personRow: { minHeight: minimumTouchTarget, justifyContent: 'center', paddingHorizontal: spacing.xs },
  composer: { gap: spacing.sm, marginTop: spacing.md },
  actionRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  errorBlock: { gap: spacing.sm, marginTop: spacing.md },
  label: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
});
