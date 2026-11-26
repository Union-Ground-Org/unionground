import { connectedWorkflowsT as t } from '../../lib/i18n/connectedWorkflows.js';
import { useEffect, useRef, useState } from 'react';
import { useLang } from '../../lib/LanguageContext.jsx';

export function ConnectedEventLanding({ data, requestedId, scopeKey, loadEvent, selectedOnly = false, children }) {
  return <EventLanding key={`${scopeKey}:${requestedId || ''}`} data={data} requestedId={requestedId} loadEvent={loadEvent} selectedOnly={selectedOnly}>{children}</EventLanding>;
}

function EventLanding({ data, requestedId, loadEvent, selectedOnly, children }) {
  const { lang } = useLang();
  const loader = useRef(loadEvent);
  loader.current = loadEvent;
  const [result, setResult] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!requestedId) return;
    let current = true;
    Promise.resolve().then(() => loader.current(requestedId)).then((event) => {
      if (current) setResult(event?.id === requestedId ? { event } : { error: true });
    }).catch(() => { if (current) setResult({ error: true }); });
    return () => { current = false; };
  }, [requestedId, data.events, attempt]);
  if (!requestedId) return children(data);
  if (!result) return <p role="status">{t(lang, 'connectedWorkflows.ConnectedEventLanding.loading')}</p>;
  if (result.error) return <div className="connected-actions" role="alert">
    <p>{t(lang, 'connectedWorkflows.ConnectedEventLanding.unavailable')}</p>
    <button type="button" onClick={() => { setResult(null); setAttempt((value) => value + 1); }}>{t(lang, 'connectedWorkflows.ConnectedEventLanding.retry')}</button>
  </div>;
  if (selectedOnly) return children({ ...data, events: [result.event] });
  const events = data.events || [];
  return children({ ...data, events: events.some((event) => event.id === requestedId)
    ? events.map((event) => event.id === requestedId ? result.event : event)
    : [...events, result.event] });
}
