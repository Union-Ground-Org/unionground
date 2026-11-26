import { formatDateTimeWithZone } from '../../lib/i18n/zonedDates.js';
import { connectedWorkflowsT as t } from '../../lib/i18n/connectedWorkflows.js';
import { useEffect, useRef, useState } from 'react';
import { useLang } from '../../lib/LanguageContext.jsx';
import { ReminderTimePicker } from '../../components/ReminderTimePicker.jsx';
import { connectedReminderActions } from './actions.js';
import './connectedWorkflows.css';
import { BusyButton } from '../../components/BusyControls.jsx';



export function ConnectedReminders({ api, scopeKey, onNavigate, onNotice = () => {} }) {
  return api ? <ReminderList key={scopeKey} api={api} onNavigate={onNavigate} onNotice={onNotice} /> : null;
}

function ReminderList({ api, onNavigate, onNotice }) {
  const { lang } = useLang();

  const [rows, setRows] = useState([]);
  const [next, setNext] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [snoozing, setSnoozing] = useState(null);
  const alive = useRef(true);
  const working = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  async function run(work) {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try { await work(); }
    catch { if (alive.current) setError(t(lang, 'connectedWorkflows.reminders.failed')); }
    finally { if (alive.current) { working.current = false; setBusy(false); } }
  }

  async function load(cursor = null) {
    await run(async () => {
      const page = await api.listReminders(cursor);
      if (!alive.current) return;
      setRows((current) => cursor ? [...new Map([...current, ...page.items].map((row) => [row.id, row])).values()] : page.items);
      setNext(page.nextCursor); setLoaded(true);
    });
  }

  async function update(row, action, remindAt = null) {
    await run(async () => {
      await api.updateReminder(row.id, action, remindAt);
      if (!alive.current) return;
      setRows((current) => action === 'snooze'
        ? current.map((item) => item.id === row.id ? { ...item, remindAt, status: 'scheduled' } : item)
        : current.filter((item) => item.id !== row.id));
      setSnoozing(null);
    });
  }

  return <section className="connected-actions connected-reminders" aria-label={t(lang, 'connectedWorkflows.reminders.title')} data-load-state={busy ? 'loading' : error ? 'error' : loaded ? 'ready' : 'idle'}>
    <h2>{t(lang, 'connectedWorkflows.reminders.title')}</h2>
    {!loaded && <BusyButton type="button" pending={busy} onClick={() => void load()}>{busy ? t(lang, 'connectedWorkflows.reminders.loading') : t(lang, 'connectedWorkflows.reminders.load')}</BusyButton>}
    {loaded && !rows.length && <p>{t(lang, 'connectedWorkflows.reminders.empty')}</p>}
    {error && <p role="alert">{error}</p>}
    {rows.map((row) => <article key={row.id} className="connected-actions__panel" data-source-kind={row.kind} data-source-id={row.sourceId}>
      <h3>{t(lang, `connectedWorkflows.reminders.${['task', 'event', 'channel_here'].includes(row.kind) ? row.kind : 'message'}`)}</h3>
      <p><time dateTime={row.remindAt}>{formatDateTimeWithZone(row.remindAt, lang)}</time></p>
      {row.kind === 'channel_here' && <p>{row.title ? `#${row.title} · ` : ''}{row.note}</p>}
      {row.kind !== 'channel_here' && <>
        <p>{row.available ? row.title?.trim() || t(lang, 'connectedWorkflows.reminders.reminder') : t(lang, 'connectedWorkflows.reminders.sourceUnavailable')}</p>
        {row.note?.trim() && <p>{row.note}</p>}
      </>}
      <div className="connected-actions__choices" role="group" aria-label={t(lang, 'connectedWorkflows.reminders.title')}>
        {connectedReminderActions(row).map((action) => <BusyButton key={action.id} type="button" pending={busy} onClick={() => {
          if (action.id === 'snooze') { setSnoozing(row.id); return; }
          if (action.id === 'source') {
            void run(async () => {
              const current = await api.updateReminder(row.id, 'open');
              if (!alive.current) return;
              if (!current?.available) { setError(t(lang, 'connectedWorkflows.reminders.unavailable')); onNotice(t(lang, 'connectedWorkflows.reminders.unavailable')); return; }
              await onNavigate?.(current.href, current);
            });
          } else void update(row, action.id);
        }}>{t(lang, `connectedWorkflows.reminders.${action.id}`)}</BusyButton>)}
      </div>
      {snoozing === row.id && <ReminderTimePicker title={t(lang, 'connectedWorkflows.reminders.snoozeTitle')} busy={busy} onCancel={() => setSnoozing(null)} onConfirm={(remindAt) => update(row, 'snooze', remindAt)} />}
    </article>)}
    {loaded && next && <BusyButton type="button" pending={busy} onClick={() => void load(next)}>{busy ? t(lang, 'connectedWorkflows.reminders.loading') : t(lang, 'connectedWorkflows.reminders.more')}</BusyButton>}
  </section>;
}
