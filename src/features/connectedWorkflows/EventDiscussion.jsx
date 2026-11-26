import { formatDateTimeWithZone } from '../../lib/i18n/zonedDates.js';
import { connectedWorkflowsT as t } from '../../lib/i18n/connectedWorkflows.js';
import { useEffect, useRef, useState } from 'react';
import { useLang } from '../../lib/LanguageContext.jsx';



export function EventDiscussion({ reference, context, api }) {
  const { lang } = useLang();

  const [people, setPeople] = useState([]);
  const [peopleCursor, setPeopleCursor] = useState(null);
  const [participant, setParticipant] = useState('');
  const [messages, setMessages] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const organizer = context.contactRole === 'organizer';

  useEffect(() => {
    const ticket = ++generation.current;
    setError(false); setMessages([]); setCursor(null); setBusy(true);
    const request = organizer && !participant ? api.recipients(reference) : api.eventMessages(reference.id, organizer ? participant : null);
    Promise.resolve(request).then((page) => {
      if (generation.current !== ticket) return;
      if (page.available === false || page.status === 'unavailable') { setMessages([]); setError(true); return; }
      if (organizer && !participant) { setPeople(page.items); setPeopleCursor(page.nextCursor); }
      else { setMessages(page.items); setCursor(page.nextCursor); }
    }).catch(() => { if (generation.current === ticket) setError(true); })
      .finally(() => { if (generation.current === ticket) setBusy(false); });
    return () => { generation.current += 1; };
    // The parent owns the API's session lifetime and keys the entire menu on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reference.id, organizer, participant]);

  async function more(kind) {
    if (busy) return;
    const ticket = generation.current;
    setBusy(true); setError(false);
    try {
      const page = kind === 'people' ? await api.recipients(reference, peopleCursor) : await api.eventMessages(reference.id, organizer ? participant : null, cursor);
      if (generation.current !== ticket) return;
      if (page.available === false || page.status === 'unavailable') { setMessages([]); setPeople([]); setCursor(null); setPeopleCursor(null); setError(true); return; }
      if (kind === 'people') { setPeople((rows) => [...new Map([...rows, ...page.items].map((row) => [row.id, row])).values()]); setPeopleCursor(page.nextCursor); }
      else { setMessages((rows) => [...new Map([...rows, ...page.items].map((row) => [row.id, row])).values()]); setCursor(page.nextCursor); }
    } catch { if (generation.current === ticket) { setMessages([]); setError(true); } }
    finally { if (generation.current === ticket) setBusy(false); }
  }

  return <div className="connected-actions__composer">
    {organizer && <label>{t(lang, 'connectedWorkflows.discussion.participant')}<select disabled={busy} value={participant} onChange={(event) => setParticipant(event.target.value)}>
      <option value="">{t(lang, 'connectedWorkflows.discussion.choose')}</option>{people.map((person) => <option key={person.id} value={person.id}>{person.label}</option>)}
    </select></label>}
    {peopleCursor && <button type="button" disabled={busy} onClick={() => void more('people')}>{t(lang, 'connectedWorkflows.discussion.morePeople')}</button>}
    {busy && <p role="status">{t(lang, 'connectedWorkflows.discussion.loading')}</p>}
    {error && <p role="alert">{t(lang, 'connectedWorkflows.discussion.failed')}</p>}
    {!busy && !error && !messages.length && (!organizer || participant) && <p>{t(lang, 'connectedWorkflows.discussion.empty')}</p>}
    {[...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map((message) => <article key={message.id} className="connected-actions__panel">
      <strong>{message.mine ? t(lang, 'connectedWorkflows.discussion.you') : message.senderRole === 'organizer' ? t(lang, 'connectedWorkflows.discussion.organizer') : t(lang, 'connectedWorkflows.discussion.attendee')}</strong>
      <p className="connected-discussion-body">{message.redacted ? t(lang, 'connectedWorkflows.discussion.removed') : message.body}</p>
      <time dateTime={message.createdAt}>{formatDateTimeWithZone(message.createdAt, lang)}</time>
    </article>)}
    {cursor && <button type="button" disabled={busy} onClick={() => void more('messages')}>{t(lang, 'connectedWorkflows.discussion.more')}</button>}
  </div>;
}
