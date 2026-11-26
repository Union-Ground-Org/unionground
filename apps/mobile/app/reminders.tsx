import { formatDateTime } from '../../../src/lib/i18n/format.js';
import { Redirect, useRouter } from 'expo-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PinnedHeaderScreen } from '../src/components/PinnedHeader';
import { Body, Button, Card, Heading, Screen, StateMessage } from '../src/components/ui';
import { ReminderPicker } from '../src/components/ReminderPicker';
import { connectedWorkflowApi, type ConnectedReminder, type ConnectedReminderAction } from '../src/lib/connectedWorkflows';
import { nativeWorkflowRoute } from '../src/lib/connectedWorkflowRoutes';
import { withReadDeadline } from '../src/lib/readDeadline';
import { canOpenFeature, isFeatureKey } from '../src/lib/featureCatalog';
import { useApp } from '../src/state/AppProvider';
import { getSupabaseClient } from '../src/services/supabase';
import { listChannelHereReminders } from '../../../src/features/messaging/remindHere.js';
import { useNativeUi } from '../src/lib/useNativeUi';
import { deviceTimeZoneLabel, parseDatabaseTimestamp } from '../src/lib/evidenceTimestamp';

export default function RemindersRoute() {
  const { t } = useNativeUi();
  const app = useApp();
  const { mode, session, dashboard, organizationID, authorizedRoles, confirmedMembershipScope } = app;
  if (mode === 'signedOut') return <Redirect href="/sign-in" />;
  if (mode === 'mfaRequired') return <Redirect href="/mfa-challenge" />;
  const scope = JSON.stringify([mode, session?.user.id, organizationID, dashboard?.member.chapterID, authorizedRoles, confirmedMembershipScope]);
  return <PinnedHeaderScreen screenName={t('Reminders')}><ReminderList key={scope} enabled={mode === 'authenticated'} /></PinnedHeaderScreen>;
}

function ReminderList({ enabled }: { enabled: boolean }) {
  const { language, t } = useNativeUi();
  const router = useRouter();
  const { session, mode, previewHat, chapterRoles, organizationRoles } = useApp();
  const spanish = language === 'es';
  const reminderTime = (value: string) => {
    const date = parseDatabaseTimestamp(value);
    if (!date) return t('Time unavailable');
    const time = formatDateTime(date, language);
    const zone = deviceTimeZoneLabel(date);
    return zone ? `${time} · ${zone}` : time;
  };
  const [items, setItems] = useState<ConnectedReminder[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  // The list read failed or did not answer in time; an action failure keeps `error`.
  const [loadFailed, setLoadFailed] = useState(false);
  const [snooze, setSnooze] = useState<ConnectedReminder | null>(null);
  const [revision, setRevision] = useState(0);
  // REQ-UG-REMIND-HERE-20261001: /remind here reminders that reached this
  // person as channel staff. The server re-checks access on every read.
  const [channelReminders, setChannelReminders] = useState<Awaited<ReturnType<typeof listChannelHereReminders>>>([]);
  // #9941 (carved from #9465): a failed or late channel read is said, not shown
  // as "no channel reminders" by dropping the section.
  const [channelFailed, setChannelFailed] = useState(false);
  // Its own retry counter: Try again re-reads only the channel reminders.
  const [channelAttempt, setChannelAttempt] = useState(0);
  useEffect(() => {
    const client = getSupabaseClient();
    if (!enabled || !client) return undefined;
    let current = true;
    setChannelFailed(false);
    void withReadDeadline(listChannelHereReminders(client)).then((rows) => { if (current) setChannelReminders(rows); }).catch(() => { if (current) { setChannelReminders([]); setChannelFailed(true); } });
    return () => { current = false; };
  }, [enabled, revision, channelAttempt]);
  const alive = useRef(true);
  const working = useRef(false);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function run(work: () => Promise<void>) {
    if (working.current || !enabled) return;
    working.current = true; setBusy(true); setError(false);
    try { await work(); } catch { if (alive.current) setError(true); }
    finally { if (alive.current) { working.current = false; setBusy(false); } }
  }
  useEffect(() => {
    if (!enabled) return;
    let current = true; setBusy(true); setLoadFailed(false);
    const api = connectedWorkflowApi();
    if (!api) { setLoadFailed(true); setBusy(false); return; }
    void withReadDeadline(api.listReminders()).then((page) => {
      if (current) { setItems(page.items); setCursor(page.nextCursor); setLoaded(true); }
    }).catch(() => { if (current) setLoadFailed(true); }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [enabled, revision]);
  async function act(item: ConnectedReminder, action: ConnectedReminderAction, at?: string) {
    await run(async () => {
      const api = connectedWorkflowApi(session);
      if (!api) throw new Error('Unavailable');
      const result = await api.updateReminder(item.id, action, at);
      if (!alive.current) return;
      if (action === 'open') {
        const route = result.available ? nativeWorkflowRoute(result.href) : null;
        if (!route) throw new Error('Unavailable');
        const feature = /^\/feature\/([^?]+)/.exec(route)?.[1];
        if (feature && (!isFeatureKey(feature) || !canOpenFeature(mode, feature, previewHat, chapterRoles, organizationRoles))) throw new Error('Unavailable');
        router.push(route as never);
      } else {
        setSnooze(null); setRevision((value) => value + 1);
      }
    });
  }
  const ownedChannelIds = new Set(items.filter((item) => item.kind === 'channel_here').map((item) => item.id));
  const receivedChannelReminders = channelReminders.filter((item) => !ownedChannelIds.has(item.id));
  if (!enabled) return <Screen><StateMessage title={t('Reminders unavailable')} body={t('Sign in to open your reminders.')} /></Screen>;
  return <Screen><Heading>{spanish ? 'Recordatorios' : 'Reminders'}</Heading>
    {loadFailed ? <><StateMessage title={spanish ? 'No se pudieron cargar los recordatorios' : 'Reminders could not be loaded'} body={spanish ? 'Revisa tu conexión y vuelve a intentarlo.' : 'Check your connection, then try again.'} /><Button label={spanish ? 'Reintentar' : 'Try again'} disabled={busy} onPress={() => { setLoadFailed(false); setRevision((value) => value + 1); }} /></> : null}
    {error ? <><StateMessage title={spanish ? 'No se pudo confirmar la acción' : 'Action could not be confirmed'} body={spanish ? 'El origen puede haberse eliminado o tu acceso cambiado.' : 'The original may have been removed or your access changed.'} /><Button label={spanish ? 'Reintentar' : 'Try again'} disabled={busy} onPress={() => { setError(false); setRevision((value) => value + 1); }} /></> : null}
    {!loaded && !error && !loadFailed ? <StateMessage title={spanish ? 'Cargando recordatorios' : 'Loading reminders'} body="" /> : null}
    {loaded && !items.length ? <Body>{spanish ? 'No hay recordatorios activos.' : 'No active reminders.'}</Body> : null}
    {receivedChannelReminders.length || channelFailed ? <Heading level={2}>{spanish ? 'Para el equipo del canal' : 'For channel staff'}</Heading> : null}
    {channelFailed ? <><Body>{spanish ? 'No se pudieron cargar los recordatorios del equipo del canal.' : 'Channel staff reminders could not be loaded.'}</Body><Button label={spanish ? 'Reintentar' : 'Try again'} disabled={busy} onPress={() => { setChannelFailed(false); setChannelAttempt((value) => value + 1); }} /></> : null}
    {receivedChannelReminders.map((item) => <Card key={`channel-${item.id}`}>
      <Heading level={2}>{item.mine ? t('Your reminder · #{space}', { space: item.spaceName }) : t('Reminder from {author} · #{space}', { author: item.authorName, space: item.spaceName })}</Heading>
      <Body>{item.note}</Body>
      {item.deliveredAt ? <Body muted>{reminderTime(item.deliveredAt)}</Body> : null}
    </Card>)}
    {items.map((item) => item.kind === 'channel_here' ? <Card key={item.id}>
      <Heading level={2}>{spanish ? 'Recordatorio al equipo del canal' : 'Channel staff reminder'}</Heading>
      <Body>{reminderTime(item.remindAt)}</Body>
      <Body>{item.title ? `#${item.title} · ` : ''}{item.note}</Body>
      {/* A channel reminder has no single message to open and is not snoozed. */}
      {item.status === 'scheduled' || item.status === 'delivered' ? <>
        <Button label={spanish ? 'Completar' : 'Complete'} variant="secondary" disabled={busy} onPress={() => { void act(item, 'complete'); }} />
        <Button label={spanish ? 'Cancelar' : 'Cancel'} variant="secondary" disabled={busy} onPress={() => { void act(item, 'cancel'); }} />
      </> : null}
    </Card> : <Card key={item.id}>
      <Heading level={2}>{item.available
        ? item.title?.trim() || (spanish ? 'Recordatorio' : 'Reminder')
        : spanish ? 'Origen no disponible' : 'Original unavailable'}</Heading>
      <Body>{reminderTime(item.remindAt)}</Body>
      {item.note?.trim() ? <Body>{item.note}</Body> : null}
      <Button label={spanish ? 'Abrir origen' : 'Open original'} disabled={busy} onPress={() => { void act(item, 'open'); }} />
      <Button label={spanish ? 'Posponer…' : 'Snooze…'} variant="secondary" disabled={busy} onPress={() => setSnooze(item)} />
      <Button label={spanish ? 'Completar' : 'Complete'} variant="secondary" disabled={busy} onPress={() => { void act(item, 'complete'); }} />
      <Button label={spanish ? 'Cancelar' : 'Cancel'} variant="secondary" disabled={busy} onPress={() => { void act(item, 'cancel'); }} />
    </Card>)}
    {cursor ? <Button label={spanish ? 'Más recordatorios' : 'More reminders'} disabled={busy} onPress={() => { void run(async () => {
      const page = await connectedWorkflowApi()?.listReminders(cursor);
      if (!page || !alive.current) return;
      setItems((rows) => [...new Map([...rows, ...page.items].map((row) => [row.id, row])).values()]); setCursor(page.nextCursor);
    }); }} /> : null}
    <ReminderPicker key={snooze?.id ?? 'closed'} visible={Boolean(snooze)} onClose={() => setSnooze(null)} onConfirm={async (result) => { if (result && snooze) await act(snooze, 'snooze', result.iso); }} />
  </Screen>;
}
