import { formatDateTimeWithZone } from '../../lib/i18n/zonedDates.js';
import { connectedWorkflowsT as t } from '../../lib/i18n/connectedWorkflows.js';
import { useEffect, useId, useRef, useState } from 'react';
import { useLang } from '../../lib/LanguageContext.jsx';
import { ReminderTimePicker } from '../../components/ReminderTimePicker.jsx';
import { connectedRecordActions } from './actions.js';
import { newConnectedRequestId } from './api.js';
import { EventContactSettings } from './EventContactSettings.jsx';
import { EventDiscussion } from './EventDiscussion.jsx';
import { BusyButton, BusyFieldset, BusyTextarea } from '../../components/BusyControls.jsx';
import './connectedWorkflows.css';



export function ConnectedRecordActions(props) {
  const { reference, scopeKey = '' } = props;
  return <RecordActions key={JSON.stringify([scopeKey, reference?.kind, reference?.id, reference?.organizationId, reference?.chapterId])} {...props} />;
}

function RecordActions({ reference, api, staffAccess = false, onNavigate, onOpenTask, onNotice = () => {} }) {
  const { lang } = useLang();

  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [context, setContext] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [organizerNotice, setOrganizerNotice] = useState('');
  const [compose, setCompose] = useState(null);
  const [body, setBody] = useState('');
  const [recipients, setRecipients] = useState([]);
  const [selected, setSelected] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const working = useRef(false);
  const alive = useRef(true);
  const requestId = useRef(null);
  const panelRef = useRef(null);
  const revealRef = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // REQ-UG-FIRST-CLICK-AND-DEAD-CONTROLS-20261030: the panel opens in
  // flow under its row. On a row near the bottom of the window it opened out
  // of sight, so Actions looked like it did nothing. Bring the panel into view
  // when it opens and once more when its first choices arrive; later work in
  // the panel never moves the page.
  useEffect(() => {
    if (!expanded || !revealRef.current) return;
    panelRef.current?.scrollIntoView?.({ block: 'nearest' });
    if (!busy) revealRef.current = false;
  }, [expanded, busy]);

  if (!api || !reference?.id) return null;

  async function run(work) {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try { await work(); }
    catch (failure) {
      if (alive.current) {
        if (['42501', 'not_authorized', 'scope_changed', 'source_unavailable', 'organizer_changed', 'source_removed', 'recipient_unavailable', 'event_cancelled', 'opt_in_required'].some((code) => [failure?.code, failure?.reason].includes(code))) {
          closeComposer(); setContext(null);
        }
        setError(t(lang, 'connectedWorkflows.actions.failed'));
      }
    }
    finally { if (alive.current) { working.current = false; setBusy(false); } }
  }

  async function checked() {
    const current = await api.context(reference);
    if (!alive.current) return null;
    setContext(current);
    if (!current?.available) {
      setCompose(null); setBody(''); setSelected([]); setRecipients([]);
      setError(t(lang, 'connectedWorkflows.actions.unavailable'));
      return null;
    }
    return current;
  }

  function closeComposer() {
    setCompose(null); setBody(''); setSelected([]); setRecipients([]); setNextCursor(null); requestId.current = null;
  }

  async function choose(action) {
    await run(async () => {
      const current = await checked();
      if (!current || !connectedRecordActions(current, { staffAccess }).some((item) => item.id === action)) return;
      if (action === 'message') {
        const page = await api.recipients(reference);
        if (!alive.current) return;
        closeComposer();
        if (page.status === 'unavailable' || page.available === false) { setContext(null); setError(t(lang, 'connectedWorkflows.actions.unavailable')); return; }
        setRecipients(page.items); setNextCursor(page.nextCursor); setCompose('message');
      } else if (action === 'remind' || action === 'source') {
        closeComposer(); setCompose(action);
      } else if (action === 'createTask') {
        const result = await api.createTask(reference);
        if (!alive.current) return;
        setContext({ ...current, linkedTask: result.task }); onNotice(t(lang, 'connectedWorkflows.actions.taskReady'));
      } else if (action === 'openTask') {
        await onOpenTask?.(current.linkedTask, reference);
      } else if (action === 'discussion') {
        if (reference.kind === 'event') { closeComposer(); setCompose('discussion'); }
        else await onNavigate?.(current.discussionHref, current);
      }
    });
  }

  const choices = connectedRecordActions(context, { staffAccess });
  return <div className="connected-actions">
    <BusyButton type="button" className="connected-actions__trigger" aria-expanded={expanded} aria-controls={id} pending={busy} onClick={() => {
      if (expanded) { setExpanded(false); setOrganizerNotice(''); closeComposer(); return; }
      revealRef.current = true; setExpanded(true); void run(checked);
    }}>{busy ? t(lang, 'connectedWorkflows.actions.loading') : t(lang, 'connectedWorkflows.actions.actions')}</BusyButton>
    {expanded && <div ref={panelRef} id={id} className="connected-actions__panel">
      {context?.cancelled && <p role="status">{t(lang, 'connectedWorkflows.actions.cancelled')}</p>}
      {context?.timezone?.startsAt && <p className="connected-actions__meta">{formatDateTimeWithZone(context.timezone.startsAt, lang)}</p>}
      <div role="group" aria-label={t(lang, 'connectedWorkflows.actions.actions')} className="connected-actions__choices">
        {choices.map((action) => <BusyButton key={action.id} type="button" pending={busy} onClick={() => void choose(action.id)}>{t(lang, `connectedWorkflows.actions.${action.id}`)}</BusyButton>)}
      </div>
      {context?.available && !choices.length && <p>{t(lang, 'connectedWorkflows.actions.empty')}</p>}
      <EventContactSettings key={context?.organizer?.id || 'unassigned'} reference={reference} context={context} api={api} staffAccess={staffAccess} busy={busy} run={run} refresh={checked} onNotice={setOrganizerNotice} />
      {reference.kind === 'event' && <div role="status">{organizerNotice}</div>}
      {compose === 'discussion' && <EventDiscussion reference={reference} context={context} api={api} />}
      {error && <div role="alert"><p>{error}</p><BusyButton type="button" pending={busy} onClick={() => void run(checked)}>{t(lang, 'connectedWorkflows.actions.retry')}</BusyButton></div>}
      {compose === 'remind' && <ReminderTimePicker title={t(lang, 'connectedWorkflows.ConnectedRecordActions.reminderTitle')} busy={busy} onCancel={closeComposer} onConfirm={(remindAt) => run(async () => {
        const current = await checked();
        if (!current?.canRemind) { closeComposer(); setError(t(lang, 'connectedWorkflows.actions.unavailable')); return; }
        await api.remind(reference, remindAt);
        if (alive.current) { closeComposer(); onNotice(t(lang, 'connectedWorkflows.actions.reminderSet')); }
      })} />}
      {compose === 'source' && <div className="connected-actions__choices">
        {(context?.sourceLinks || []).map((source) => <BusyButton type="button" key={JSON.stringify(source.reference)} pending={busy} onClick={() => void run(async () => {
          const current = await api.context(source.reference);
          if (!alive.current) return;
          if (!current?.available) { setError(t(lang, 'connectedWorkflows.actions.unavailable')); return; }
          await onNavigate?.(current.href, current);
        })}>{source.label || t(lang, 'connectedWorkflows.actions.source')}</BusyButton>)}
      </div>}
      {compose === 'message' && <form className="connected-actions__composer" onSubmit={(event) => {
        event.preventDefault();
        if (!selected.length || !body.trim()) return;
        void run(async () => {
          const current = await checked();
          if (!current?.canMessage) { closeComposer(); setError(t(lang, 'connectedWorkflows.actions.unavailable')); return; }
          // Selection is explicit and the send endpoint revalidates every ID.
          const payload = JSON.stringify([[...selected].sort(), body.trim()]);
          if (requestId.current?.payload !== payload) requestId.current = { payload, id: newConnectedRequestId() };
          await api.send(reference, selected, body.trim(), requestId.current.id);
          if (alive.current) { closeComposer(); onNotice(t(lang, 'connectedWorkflows.actions.sent')); }
        });
      }}>
        <BusyFieldset pending={busy}><legend>{t(lang, 'connectedWorkflows.actions.recipients')}</legend>
          {recipients.map((person) => <label key={person.id} className="connected-actions__recipient">
            <input type="checkbox" value={person.id} checked={selected.includes(person.id)} disabled={selected.length >= 12 && !selected.includes(person.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, person.id] : current.filter((value) => value !== person.id))} />
            <span>{person.label || person.name}</span>
          </label>)}
          {!recipients.length && <p>{t(lang, 'connectedWorkflows.actions.noRecipients')}</p>}
          {nextCursor && <button type="button" onClick={() => void run(async () => {
            const page = await api.recipients(reference, nextCursor);
            if (!alive.current) return;
            if (page.status === 'unavailable' || page.available === false) { closeComposer(); setContext(null); setError(t(lang, 'connectedWorkflows.actions.unavailable')); return; }
            setRecipients((current) => [...new Map([...current, ...page.items].map((person) => [person.id, person])).values()]);
            setNextCursor(page.nextCursor);
          })}>{t(lang, 'connectedWorkflows.actions.more')}</button>}
        </BusyFieldset>
        <label htmlFor={`${id}-body`}>{t(lang, 'connectedWorkflows.actions.messageBody')}</label>
        <BusyTextarea id={`${id}-body`} value={body} onChange={(event) => setBody(event.target.value)} maxLength={2000} pending={busy} required />
        <div className="connected-actions__choices">
          <BusyButton type="submit" pending={busy} disabled={!selected.length || !body.trim()}>{t(lang, 'connectedWorkflows.actions.send')}</BusyButton>
          <BusyButton type="button" pending={busy} onClick={closeComposer}>{t(lang, 'connectedWorkflows.actions.cancel')}</BusyButton>
        </div>
      </form>}
    </div>}
  </div>;
}
