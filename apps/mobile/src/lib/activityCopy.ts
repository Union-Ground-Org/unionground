// Activity (app/notifications.tsx) copy, catalogue-free like messageInboxCopy:
// the web catalogue must not enter the native bundle
// (PERF-UG-MOBILE-QA-BUNDLES-FULL-WEB-CATALOGUE-20260917). The language
// follows the worker's saved choice, falling back to the device locale when
// there is no dashboard - the same rule as usePublicDirectoryLocale.
// UX-UG-ACTIVITY-SIGN-IN-MFA-COMPASS-FUNCTIONDECK-ATTACHMENTS-SHARE-INTAKE-AND-WORK-PULSE-20260921.

export type ActivityLanguage = 'en' | 'es';
export type ActivityFilter = 'all' | 'cases' | 'messages' | 'votes';

type ActivityCopy = {
  title: string;
  subtitle: string;
  loadingTitle: string;
  loadingBody: string;
  loadFailedTitle: string;
  tryAgain: string;
  updateError: string;
  filters: Record<ActivityFilter, string>;
  showFilter: (filter: ActivityFilter) => string;
  noFilterUpdates: (filter: ActivityFilter) => string;
  emptyTitle: string;
  emptyBody: string;
  fresh: string;
  earlier: string;
  unreadLabel: (title: string, body: string) => string;
  openUpdate: (title: string, body: string) => string;
  unread: string;
  markRead: string;
  markUnread: string;
  markReadLabel: (title: string) => string;
  markUnreadLabel: (title: string) => string;
  saving: string;
  pushNote: string;
};

export function activityLanguage(memberLanguage: string | null | undefined, deviceLocale: string): ActivityLanguage {
  if (memberLanguage) return memberLanguage === 'es' ? 'es' : 'en';
  return deviceLocale.toLowerCase().startsWith('es') ? 'es' : 'en';
}

export const activityCopy: Record<ActivityLanguage, ActivityCopy> = {
  en: {
    title: 'Activity',
    subtitle: 'The latest updates for you and your campaign.',
    loadingTitle: 'Updates are loading',
    loadingBody: 'Getting your latest updates.',
    loadFailedTitle: 'Updates could not load',
    tryAgain: 'Try again',
    updateError: 'That update could not be changed. Your access may have changed; try refreshing Home.',
    filters: { all: 'All', cases: 'Issues', messages: 'Messages', votes: 'Votes' },
    showFilter: (filter) => `Show ${activityCopy.en.filters[filter].toLowerCase()} updates`,
    noFilterUpdates: (filter) => `No ${activityCopy.en.filters[filter].toLowerCase()} updates right now.`,
    emptyTitle: 'You’re all caught up',
    emptyBody: 'New updates for you and your campaign will appear here.',
    fresh: 'New',
    earlier: 'Earlier',
    unreadLabel: (title, body) => `${title}, unread, ${body}`,
    openUpdate: (title, body) => `Open update: ${title}, ${body}`,
    unread: 'Unread',
    markRead: 'Mark read',
    markUnread: 'Mark unread',
    markReadLabel: (title) => `Mark ${title} read`,
    markUnreadLabel: (title) => `Mark ${title} unread`,
    saving: 'Saving…',
    pushNote: 'Tapping a notification opens Union Ground, which checks that you are still signed in before showing anything private.',
  },
  es: {
    title: 'Actividad',
    subtitle: 'Las novedades más recientes para ti y tu campaña.',
    loadingTitle: 'Cargando novedades',
    loadingBody: 'Estamos comprobando tu autorización actual antes de mostrar novedades protegidas.',
    loadFailedTitle: 'No se pudieron cargar las novedades',
    tryAgain: 'Inténtalo de nuevo',
    updateError: 'No se pudo cambiar esa novedad. Puede que tu acceso haya cambiado; prueba a actualizar Inicio.',
    filters: { all: 'Todas', cases: 'Asuntos', messages: 'Mensajes', votes: 'Votaciones' },
    showFilter: (filter) => (filter === 'all' ? 'Mostrar todas las novedades' : `Mostrar novedades de ${activityCopy.es.filters[filter].toLowerCase()}`),
    noFilterUpdates: (filter) => (filter === 'all' ? 'No hay novedades por ahora.' : `No hay novedades de ${activityCopy.es.filters[filter].toLowerCase()} por ahora.`),
    emptyTitle: 'Estás al día',
    emptyBody: 'Las nuevas novedades autorizadas aparecerán aquí sin mostrar detalles protegidos en las vistas previas de las notificaciones.',
    fresh: 'Nuevas',
    earlier: 'Anteriores',
    unreadLabel: (title, body) => `${title}, sin leer, ${body}`,
    openUpdate: (title, body) => `Abrir novedad: ${title}, ${body}`,
    unread: 'Sin leer',
    markRead: 'Marcar como leída',
    markUnread: 'Marcar como no leída',
    markReadLabel: (title) => `Marcar ${title} como leída`,
    markUnreadLabel: (title) => `Marcar ${title} como no leída`,
    saving: 'Guardando…',
    pushNote: 'Abrir una notificación nunca confía en su vista previa. Union Ground vuelve a comprobar tu sesión y tu acceso a cada registro antes de mostrar cualquier destino protegido.',
  },
};
