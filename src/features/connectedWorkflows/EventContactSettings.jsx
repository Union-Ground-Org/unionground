import { connectedWorkflowsT as t } from '../../lib/i18n/connectedWorkflows.js';
import { useState } from 'react';
import { useLang } from '../../lib/LanguageContext.jsx';
import { BusyButton, BusyInput, BusySelect } from '../../components/BusyControls.jsx';



export function EventContactSettings({ reference, context, api, staffAccess, busy, run, refresh, onNotice = () => {} }) {
  const { lang } = useLang();

  const [editing, setEditing] = useState(false);
  const [people, setPeople] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [selected, setSelected] = useState('');
  const [optIn, setOptIn] = useState(null);
  // #9470 (W7-22): a saved contact preference says so beside its button, until
  // the member changes it or the event's value changes to something else.
  const [optInSaved, setOptInSaved] = useState(null);
  const contextOptIn = Boolean(context?.contactOptIn);
  const [seenOptIn, setSeenOptIn] = useState(contextOptIn);
  if (seenOptIn !== contextOptIn) {
    setSeenOptIn(contextOptIn);
    if (optInSaved !== contextOptIn) setOptInSaved(null);
  }
  if (reference.kind !== 'event' || !context?.available) return null;
  return <div className="connected-event-settings">
    {context.organizer && <p>{t(lang, 'connectedWorkflows.eventContact.organizer')}: {context.organizer.label}</p>}
    {staffAccess && context.canManageOrganizer && <>
      {!editing ? <BusyButton type="button" pending={busy} onClick={() => void run(async () => {
        onNotice('');
        const page = await api.eventOrganizerCandidates(reference.id);
        setPeople(page.items); setCursor(page.nextCursor); setSelected(context.organizer?.id || ''); setEditing(true);
      })}>{t(lang, 'connectedWorkflows.eventContact.edit')}</BusyButton> : <form className="connected-actions__composer" onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          await api.setEventOrganizer(reference.id, selected || null, context.eventVersion ?? null);
          onNotice(t(lang, 'connectedWorkflows.eventContact.organizerSaved'));
          setEditing(false); await refresh();
        });
      }}>
        <label>{t(lang, 'connectedWorkflows.eventContact.organizer')}<BusySelect value={selected} pending={busy} onChange={(event) => setSelected(event.target.value)}>
          <option value="">{t(lang, 'connectedWorkflows.eventContact.none')}</option>
          {people.map((person) => <option key={person.id} value={person.id}>{person.label}</option>)}
        </BusySelect></label>
        {cursor && <BusyButton type="button" pending={busy} onClick={() => void run(async () => {
          const page = await api.eventOrganizerCandidates(reference.id, cursor);
          setPeople((current) => [...new Map([...current, ...page.items].map((person) => [person.id, person])).values()]); setCursor(page.nextCursor);
        })}>{t(lang, 'connectedWorkflows.eventContact.more')}</BusyButton>}
        <BusyButton type="submit" pending={busy}>{t(lang, 'connectedWorkflows.eventContact.save')}</BusyButton>
      </form>}
    </>}
    {context.canContactOptIn && <form className="connected-actions__composer" onSubmit={(event) => {
      event.preventDefault();
      void run(async () => { const value = optIn ?? Boolean(context.contactOptIn); await api.setEventContactOptIn(reference.id, value, context.organizer?.id || null); setOptIn(null); setOptInSaved(value); await refresh(); });
    }}>
      <label className="connected-actions__recipient"><BusyInput type="checkbox" checked={optIn ?? Boolean(context.contactOptIn)} pending={busy} onChange={(event) => { setOptIn(event.target.checked); setOptInSaved(null); }} />{t(lang, 'connectedWorkflows.eventContact.optIn')}</label>
      <p className="connected-actions__meta">{t(lang, 'connectedWorkflows.eventContact.privacy')}</p>
      <BusyButton type="submit" pending={busy} disabled={optIn === null}>{t(lang, 'connectedWorkflows.eventContact.update')}</BusyButton>
      <p className="connected-actions__meta" role="status">{optInSaved !== null ? t(lang, 'connectedWorkflows.eventContact.updated') : ''}</p>
    </form>}
  </div>;
}
