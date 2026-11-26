// Notification topics, Do not disturb and quiet hours for the native Account
// screen. They are written to the same member_profiles columns as web Settings
// (src/lib/memberApi.js updateMemberSettings), and claim time and enqueue
// enforce those columns for every channel. Catalogue-free, like
// messageInboxCopy: the web catalogue must not enter the native bundle.
// UX-UG-NATIVE-ACCOUNT-ONLY-TOGGLES-THIS-DEVICE-PUSH-TOPIC-PREFS-DND-QUIET-HOURS-20260921.

// The same list, in the same order, as memberApi.js NOTIFICATION_TOPIC_KEYS; a
// test pins the two together. A key missing here would be written as TRUE
// (absent-means-enabled), never silently turned off.
// No 'dues' topic: Union Ground leaves dues out (owner decision,
// 2026-10-13), and the web list has none, so neither does the native one.
export type NotificationTopic = 'deadlines' | 'cases' | 'forms' | 'votes' | 'events' | 'tasks' | 'appointments' | 'workload' | 'messages';
export const NOTIFICATION_TOPIC_KEYS: readonly NotificationTopic[] = ['deadlines', 'cases', 'forms', 'votes', 'events', 'tasks', 'appointments', 'workload', 'messages'];

// Account shows every topic in the shared list.
export const DISPLAYED_NOTIFICATION_TOPIC_KEYS: readonly NotificationTopic[] = NOTIFICATION_TOPIC_KEYS;

// Union email choices in the same notification_prefs map (memberApi.js
// ENGAGEMENT_EMAIL_PREFERENCE_KEYS; a test pins the two together). They are not
// notification kinds: "announcements" governs broadcast email, "surveys" survey
// invitations and reminders, "welcome" welcome-sequence and first-sign-in email
// (an unset welcome choice follows announcements), and the one-click unsubscribe
// link in those emails turns one off. A write that omits them keeps the stored
// choice (the database preserves it), so they are written only when the member
// flips that switch. SEC-UG-ENGAGEMENT-EMAIL-OPT-OUT-UNSUBSCRIBE-20261001.
export const ENGAGEMENT_EMAIL_KEYS: readonly ['announcements', 'surveys', 'welcome'] = ['announcements', 'surveys', 'welcome'];
export type EngagementEmailKey = (typeof ENGAGEMENT_EMAIL_KEYS)[number];

// The ten zones web Settings offers (SettingsView FOCUS_TIME_ZONES).
export const QUIET_HOURS_TIME_ZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
  'America/Anchorage', 'Pacific/Honolulu', 'America/Puerto_Rico', 'America/Detroit', 'America/Indiana/Indianapolis',
] as const;
const DEFAULT_TIME_ZONE = 'America/New_York';

export type NotificationPreferences = {
  topics: Record<NotificationTopic, boolean>;
  engagementEmail: Record<EngagementEmailKey, boolean>;
  dndEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  quietHoursTimezone: string;
  urgentNotificationsEnabled: boolean;
};

export type NotificationPreferencesRow = {
  notification_prefs?: Record<string, unknown> | null;
  dnd_enabled?: boolean | null;
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
  quiet_hours_timezone?: string | null;
  urgent_notifications_enabled?: boolean | null;
};

export type NotificationPreferencesPatch = {
  notification_prefs: Record<NotificationTopic, boolean> & Partial<Record<EngagementEmailKey, boolean>>;
  dnd_enabled: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  quiet_hours_timezone: string;
  urgent_notifications_enabled: boolean;
};

export const NOTIFICATION_PREFERENCES_COLUMNS = 'notification_prefs,dnd_enabled,quiet_hours_start,quiet_hours_end,quiet_hours_timezone,urgent_notifications_enabled';

// Postgres returns `time` as HH:MM:SS; the field edits HH:MM.
function clockValue(value: string | null | undefined): string {
  return typeof value === 'string' ? value.slice(0, 5) : '';
}

export function notificationPreferencesFromRow(row: NotificationPreferencesRow): NotificationPreferences {
  const prefs = row.notification_prefs ?? {};
  const topics = Object.fromEntries(NOTIFICATION_TOPIC_KEYS.map((key) => [key, prefs[key] !== false])) as Record<NotificationTopic, boolean>;
  const engagementEmail = Object.fromEntries(ENGAGEMENT_EMAIL_KEYS.map((key) => [
    key,
    // REQ-UG-WELCOME-SEQUENCE-SCHEDULER-20261001: unset welcome follows announcements.
    key === 'welcome' && !Object.prototype.hasOwnProperty.call(prefs, 'welcome') ? prefs.announcements !== false : prefs[key] !== false,
  ])) as Record<EngagementEmailKey, boolean>;
  return {
    topics,
    engagementEmail,
    dndEnabled: row.dnd_enabled === true,
    quietHoursStart: clockValue(row.quiet_hours_start),
    quietHoursEnd: clockValue(row.quiet_hours_end),
    quietHoursTimezone: row.quiet_hours_timezone || DEFAULT_TIME_ZONE,
    urgentNotificationsEnabled: row.urgent_notifications_enabled !== false,
  };
}

// An empty field clears that end of the window; anything else must be a 24-hour HH:MM.
// The Dues switch shows only where the organization runs dues, on the shared
// rule the menus use (#7474, src/lib/duesNavigation.js): hidden when runsDues
// is false, kept while it is unknown. A hidden switch keeps its stored value.
export function visibleNotificationTopics(runsDues: boolean | null | undefined): readonly NotificationTopic[] {
  // Union Ground has no Dues topic to hide.
  void runsDues;
  return NOTIFICATION_TOPIC_KEYS;
}

export function quietClockValid(value: string): boolean {
  return value === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

// Each control writes only its own columns, so saving one section never
// overwrites another with unsaved edits. A topic switch writes the whole map,
// with every key present (the memberApi.js rule).
export function topicsPatch(topics: Record<NotificationTopic, boolean>): Pick<NotificationPreferencesPatch, 'notification_prefs'> {
  return {
    notification_prefs: Object.fromEntries(NOTIFICATION_TOPIC_KEYS.map((key) => [key, topics[key] !== false])) as Record<NotificationTopic, boolean>,
  };
}

// The topic map plus exactly the one union email choice the member flipped.
export function engagementEmailPatch(
  topics: Record<NotificationTopic, boolean>,
  key: EngagementEmailKey,
  enabled: boolean,
): Pick<NotificationPreferencesPatch, 'notification_prefs'> {
  return { notification_prefs: { ...topicsPatch(topics).notification_prefs, [key]: enabled } };
}

export function quietHoursPatch(preferences: NotificationPreferences): Pick<NotificationPreferencesPatch, 'quiet_hours_start' | 'quiet_hours_end' | 'quiet_hours_timezone' | 'urgent_notifications_enabled'> {
  return {
    quiet_hours_start: preferences.quietHoursStart || null,
    quiet_hours_end: preferences.quietHoursEnd || null,
    quiet_hours_timezone: preferences.quietHoursTimezone || DEFAULT_TIME_ZONE,
    urgent_notifications_enabled: preferences.urgentNotificationsEnabled,
  };
}

type Copy = {
  title: string;
  body: string;
  loading: string;
  loadError: string;
  saveError: string;
  saved: string;
  saving: string;
  topics: Record<NotificationTopic, string>;
  unionEmail: string;
  unionEmailBody: string;
  engagementEmail: Record<EngagementEmailKey, string>;
  dnd: string;
  dndBody: string;
  quietTitle: string;
  quietBody: string;
  quietStart: string;
  quietEnd: string;
  quietInvalid: string;
  timezone: string;
  zones: Record<(typeof QUIET_HOURS_TIME_ZONES)[number], string>;
  allowUrgent: string;
  saveQuiet: string;
};

export const notificationPreferencesCopy: Record<'en' | 'es', Copy> = {
  en: {
    title: 'What reaches you',
    body: 'These choices apply to email, web push and this phone. Turning off push above only stops this device.',
    loading: 'Loading your notification choices…',
    loadError: 'Your notification choices could not be loaded. Try again from Home.',
    saveError: 'That change was not saved. Check your connection and try again.',
    saved: 'Notification choices saved.',
    saving: 'Saving…',
    topics: {
      deadlines: 'Deadlines', cases: 'Issue updates', forms: 'Form updates', votes: 'Votes & polls', events: 'Meetings',
      tasks: 'Campaign work', appointments: 'One-on-ones', workload: 'Workplace log', messages: 'Channel mentions',
    },
    unionEmail: 'Email from your campaign',
    unionEmailBody: 'The unsubscribe link in these emails turns the matching switch off. Open surveys stay in the app either way.',
    engagementEmail: { announcements: 'Announcements', surveys: 'Survey invitations and reminders', welcome: 'Welcome messages' },
    dnd: 'Do not disturb',
    dndBody: 'Pause routine outbound notifications until you turn this off.',
    quietTitle: 'Quiet hours',
    quietBody: 'Routine notifications wait until the window ends. Use 24-hour time, like 22:00 to 07:00. Leave both empty for no quiet hours.',
    quietStart: 'Quiet hours start',
    quietEnd: 'Quiet hours end',
    quietInvalid: 'Enter times as HH:MM in 24-hour time, like 22:00.',
    timezone: 'Time zone',
    zones: {
      'America/New_York': 'Eastern — New York', 'America/Chicago': 'Central — Chicago', 'America/Denver': 'Mountain — Denver',
      'America/Phoenix': 'Mountain — Phoenix (no DST)', 'America/Los_Angeles': 'Pacific — Los Angeles', 'America/Anchorage': 'Alaska — Anchorage',
      'Pacific/Honolulu': 'Hawaii — Honolulu', 'America/Puerto_Rico': 'Atlantic — Puerto Rico', 'America/Detroit': 'Eastern — Detroit',
      'America/Indiana/Indianapolis': 'Eastern — Indianapolis',
    },
    allowUrgent: 'Allow urgent issue and deadline alerts',
    saveQuiet: 'Save quiet hours',
  },
  es: {
    title: 'Qué te llega',
    body: 'Estas opciones se aplican al correo, a las notificaciones web y a este teléfono. Desactivar las notificaciones arriba solo detiene este dispositivo.',
    loading: 'Cargando tus opciones de notificación…',
    loadError: 'No se pudieron cargar tus opciones de notificación. Vuelve a intentarlo desde Inicio.',
    saveError: 'Ese cambio no se guardó. Revisa tu conexión y vuelve a intentarlo.',
    saved: 'Opciones de notificación guardadas.',
    saving: 'Guardando…',
    topics: {
      deadlines: 'Plazos', cases: 'Novedades de asuntos', forms: 'Novedades de formularios', votes: 'Votaciones y encuestas', events: 'Reuniones',
      tasks: 'Trabajo de la campaña', appointments: 'Reuniones individuales', workload: 'Registro del trabajo', messages: 'Menciones en canales',
    },
    unionEmail: 'Correo de tu campaña',
    unionEmailBody: 'El enlace para cancelar la suscripción en estos correos desactiva la opción correspondiente. Las encuestas abiertas siguen en la app de todos modos.',
    engagementEmail: { announcements: 'Anuncios', surveys: 'Invitaciones y recordatorios de encuestas', welcome: 'Mensajes de bienvenida' },
    dnd: 'No molestar',
    dndBody: 'Pausa las notificaciones rutinarias hasta que lo desactives.',
    quietTitle: 'Horario de silencio',
    quietBody: 'Las notificaciones rutinarias esperan a que termine el horario. Usa el formato de 24 horas, como 22:00 a 07:00. Deja ambos vacíos para no tener horario de silencio.',
    quietStart: 'Inicio del horario de silencio',
    quietEnd: 'Fin del horario de silencio',
    quietInvalid: 'Escribe las horas como HH:MM en formato de 24 horas, como 22:00.',
    timezone: 'Zona horaria',
    zones: {
      'America/New_York': 'Este — Nueva York', 'America/Chicago': 'Centro — Chicago', 'America/Denver': 'Montaña — Denver',
      'America/Phoenix': 'Montaña — Phoenix (sin horario de verano)', 'America/Los_Angeles': 'Pacífico — Los Ángeles', 'America/Anchorage': 'Alaska — Anchorage',
      'Pacific/Honolulu': 'Hawái — Honolulu', 'America/Puerto_Rico': 'Atlántico — Puerto Rico', 'America/Detroit': 'Este — Detroit',
      'America/Indiana/Indianapolis': 'Este — Indianápolis',
    },
    allowUrgent: 'Permitir alertas urgentes de asuntos y plazos',
    saveQuiet: 'Guardar horario de silencio',
  },
};
