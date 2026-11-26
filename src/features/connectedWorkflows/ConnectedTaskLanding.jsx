import { connectedWorkflowsT as t } from '../../lib/i18n/connectedWorkflows.js';
import { useEffect, useRef, useState } from 'react';
import { useLang } from '../../lib/LanguageContext.jsx';

// The board's initial window is not the authority for an exact linked task.
// Read it after arrival, and again when the board's authorized snapshot changes.
export function ConnectedTaskLanding({ data, requestedId, scopeKey, loadTask, children }) {
  return <TaskLanding key={`${scopeKey}:${requestedId || ''}`} data={data} requestedId={requestedId} loadTask={loadTask}>{children}</TaskLanding>;
}

function TaskLanding({ data, requestedId, loadTask, children }) {
  const { lang } = useLang();
  const [result, setResult] = useState(null);
  const loader = useRef(loadTask);
  loader.current = loadTask;
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!requestedId) return;
    let current = true;
    Promise.resolve().then(() => loader.current(requestedId)).then((task) => {
      if (current) setResult(task?.id === requestedId ? { task } : { error: true });
    }).catch(() => { if (current) setResult({ error: true }); });
    return () => { current = false; };
  }, [requestedId, data.tasks, attempt]);
  if (!requestedId) return children(data);
  if (!result) return <p role="status">{t(lang, 'connectedWorkflows.ConnectedTaskLanding.loading')}</p>;
  if (result.error) return <div className="connected-actions" role="alert">
    <p>{t(lang, 'connectedWorkflows.ConnectedTaskLanding.unavailable')}</p>
    <button type="button" onClick={() => { setResult(null); setAttempt((value) => value + 1); }}>{t(lang, 'connectedWorkflows.ConnectedTaskLanding.retry')}</button>
  </div>;
  return children({ ...data, tasks: [...(data.tasks || []).filter((task) => task.id !== requestedId), result.task] });
}
