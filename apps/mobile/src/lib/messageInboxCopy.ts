import type { ChannelLoadClassification, ChannelLoadFault } from './channelLoadDiagnosis';
import type { MessageFilter } from './messageInbox';
import labels from './messageInboxLabels.json';

export type ChannelActionOp = 'send' | 'reaction' | 'vote' | 'closed';

type MessageInboxCopy = {
  title: string;
  subtitle: string;
  search: string;
  messageSteward: string;
  loadingTitle: string;
  loadingBody: string;
  loadFailedTitle: string;
  tryAgain: string;
  composerTitle: string;
  composerBody: string;
  composerClose: string;
  composerLabel: string;
  composerPlaceholder: string;
  composerEmptyError: string;
  composerSend: string;
  composerSending: string;
  composerError: string;
  filterInbox: string;
  filterMessages: string;
  filters: Record<MessageFilter, string>;
  checkingChannels: string;
  channelError: Record<ChannelLoadFault, string>;
  markReadError: string;
  pollUnavailable: string;
  inbox: string;
  newestFirst: string;
  noSearchTitle: string;
  caughtUpTitle: string;
  noKindTitle(filter: string): string;
  noSearchBody: string;
  noMessagesBody: string;
  showAll: string;
  privateConversation: string;
  privateStaffChannel: string;
  chapterChannel: string;
  authorizedMessages: string;
  privatePeerConversation: string;
  peerConversationEmpty: string;
  resultCount(count: number): string;
  filterCount(filter: MessageFilter, label: string, count: number, selected: boolean): string;
  unreadCount(count: number): string;
  channelActionError: Record<ChannelActionOp, string>;
};

export const messageInboxCopy: Record<'en' | 'es', MessageInboxCopy> = {
  en: {
    title: 'Messages',
    subtitle: 'Private conversations and campaign channels',
    search: labels.en.search,
    messageSteward: labels.en.messageSteward,
    loadingTitle: 'Messages are loading',
    loadingBody: 'Getting your conversations.',
    loadFailedTitle: 'Messages could not load',
    tryAgain: labels.en.tryAgain,
    composerTitle: 'Start a committee conversation',
    composerBody: 'Your message starts a private conversation with a campaign committee member.',
    composerClose: 'Close message composer',
    composerLabel: 'Message to the committee',
    composerPlaceholder: 'Write your message',
    composerEmptyError: 'Write a message before starting the conversation.',
    composerSend: 'Start conversation',
    composerSending: 'Starting conversation',
    composerError: 'Your conversation could not be started securely. Try again, or refresh if a conversation already exists.',
    filterInbox: 'Filter inbox',
    filterMessages: 'Filter messages',
    filters: { all: 'All', unread: 'Unread', direct: 'Direct', channel: 'Channels' },
    checkingChannels: 'Loading your campaign channels…',
    channelError: {
      authentication: 'Campaign channels didn’t load because your sign-in ended. Sign in again, then pull to refresh.',
      request: 'Campaign channels didn’t load. Pull to refresh, and use Help and support if it keeps happening.',
      schema: 'Campaign channels didn’t load because this app needs an update. Update the app and pull to refresh, or use Help and support if it keeps happening.',
      transport: 'Campaign channels didn’t load because this phone couldn’t reach Union Ground. Check your connection, then pull to refresh.',
      unknown: 'Campaign channels didn’t load. Pull to refresh and try again.',
    },
    markReadError: 'This channel could not be marked read. Try opening it again.',
    pollUnavailable: 'This channel poll is unavailable right now. Pull to refresh and try again.',
    inbox: 'Inbox',
    newestFirst: 'Newest activity first',
    noSearchTitle: labels.en.noSearchTitle,
    caughtUpTitle: 'You are caught up',
    noKindTitle: (filter) => `No ${filter.toLocaleLowerCase('en-US')} messages yet`,
    noSearchBody: 'Try another name or phrase, or return to the full inbox.',
    noMessagesBody: 'Messages will appear here when a conversation or channel has activity.',
    showAll: 'Show all messages',
    privateConversation: 'Private conversation',
    privateStaffChannel: 'Private staff channel',
    chapterChannel: 'Campaign channel',
    authorizedMessages: 'Open to read the messages.',
    privatePeerConversation: 'Private worker conversation',
    peerConversationEmpty: 'Accepted — write the first message.',
    resultCount: (count) => `${count} ${count === 1 ? 'result' : 'results'}`,
    filterCount: (filter, _label, count, _selected) => {
      const unit = filter === 'direct'
        ? (count === 1 ? 'conversation' : 'conversations')
        : filter === 'channel'
          ? (count === 1 ? 'channel' : 'channels')
          : (count === 1 ? 'item' : 'items');
      return `${count} ${unit}`;
    },
    unreadCount: (count) => `${count} unread ${count === 1 ? 'message' : 'messages'}`,
    channelActionError: {
      send: 'Your message could not be sent securely. Try again.',
      reaction: 'That reaction could not be saved securely. Try again.',
      vote: 'That vote could not be saved securely. Try again.',
      closed: 'This thread is closed to new posts and replies.',
    },
  },
  es: {
    title: 'Mensajes',
    subtitle: 'Conversaciones privadas y canales de la campaña',
    search: labels.es.search,
    messageSteward: labels.es.messageSteward,
    loadingTitle: 'Cargando mensajes',
    loadingBody: 'Estamos comprobando tu autorización antes de mostrar las conversaciones.',
    loadFailedTitle: 'No se pudieron cargar los mensajes',
    tryAgain: labels.es.tryAgain,
    composerTitle: 'Iniciar una conversación con el comité',
    composerBody: 'Tu mensaje inicia una conversación privada con un trabajador autorizado del comité.',
    composerClose: 'Cerrar el redactor de mensajes',
    composerLabel: 'Mensaje para el comité',
    composerPlaceholder: 'Escribe tu mensaje',
    composerEmptyError: 'Escribe un mensaje antes de iniciar la conversación.',
    composerSend: 'Iniciar conversación',
    composerSending: 'Iniciando conversación',
    composerError: 'No se pudo iniciar la conversación de forma segura. Inténtalo de nuevo o actualiza si ya existe una conversación.',
    filterInbox: 'Filtrar bandeja',
    filterMessages: 'Filtrar mensajes',
    filters: { all: 'Todos', unread: 'No leídos', direct: 'Directos', channel: 'Canales' },
    checkingChannels: 'Comprobando tu acceso a los canales de la campaña…',
    channelError: {
      authentication: 'No se pudieron cargar los canales de la campaña porque esta sesión ya no está autorizada. Inicia sesión de nuevo y desliza para actualizar.',
      request: 'No se pudieron cargar los canales de la campaña porque el espacio de trabajo rechazó esta solicitud. Desliza para actualizar y usa Ayuda y soporte si continúa.',
      schema: 'No se pudieron cargar los canales de la campaña porque esta aplicación ya no coincide con el espacio de trabajo. Desliza para actualizar después de una actualización, o usa Ayuda y soporte si continúa.',
      transport: 'No se pudieron cargar los canales de la campaña porque este teléfono no pudo conectar con el espacio de trabajo. Revisa tu conexión y desliza para actualizar.',
      unknown: 'No se pudieron cargar los canales de la campaña de forma segura. Desliza para actualizar e inténtalo de nuevo.',
    },
    markReadError: 'No se pudo marcar este canal como leído. Ábrelo de nuevo e inténtalo.',
    pollUnavailable: 'La encuesta de este canal no está disponible ahora. Desliza para actualizar e inténtalo de nuevo.',
    inbox: 'Bandeja',
    newestFirst: 'Actividad más reciente primero',
    noSearchTitle: labels.es.noSearchTitle,
    caughtUpTitle: 'Estás al día',
    noKindTitle: (filter) => `Todavía no hay mensajes de ${filter.toLocaleLowerCase('es-US')}`,
    noSearchBody: 'Prueba otro nombre o frase, o vuelve a la bandeja completa.',
    noMessagesBody: 'Los mensajes aparecerán aquí cuando haya actividad en una conversación o canal autorizado.',
    showAll: 'Mostrar todos los mensajes',
    privateConversation: 'Conversación privada',
    privateStaffChannel: 'Canal privado del personal',
    chapterChannel: 'Canal de la campaña',
    authorizedMessages: 'Abre la conversación para ver los mensajes autorizados.',
    privatePeerConversation: 'Conversación privada entre trabajadores',
    peerConversationEmpty: 'Aceptada — escribe el primer mensaje.',
    resultCount: (count) => `${count} ${count === 1 ? 'resultado' : 'resultados'}`,
    filterCount: (filter, _label, count, _selected) => {
      const unit = filter === 'direct'
        ? (count === 1 ? 'conversación' : 'conversaciones')
        : filter === 'channel'
          ? (count === 1 ? 'canal' : 'canales')
          : (count === 1 ? 'elemento' : 'elementos');
      return `${count} ${unit}`;
    },
    unreadCount: (count) => `${count} ${count === 1 ? 'mensaje no leído' : 'mensajes no leídos'}`,
    channelActionError: {
      send: 'Tu mensaje no se pudo enviar de forma segura. Inténtalo de nuevo.',
      reaction: 'No se pudo guardar esa reacción de forma segura. Inténtalo de nuevo.',
      vote: 'No se pudo guardar ese voto de forma segura. Inténtalo de nuevo.',
      closed: 'Este hilo está cerrado a nuevas publicaciones y respuestas.',
    },
  },
};

/**
 * Worker-facing campaign-channel load copy for a classified outcome.
 * An authorized-empty result has no failure notice.
 */
export function channelLoadFailureNotice(
  copy: MessageInboxCopy,
  classification: ChannelLoadClassification | ChannelLoadFault | null,
): string | null {
  if (
    classification === 'authentication'
    || classification === 'request'
    || classification === 'schema'
    || classification === 'transport'
    || classification === 'unknown'
  ) {
    return copy.channelError[classification];
  }
  return null;
}

/**
 * REQ-UG-NATIVE-HELP-AND-SUPPORT-ENTRY-20261018: the two load faults
 * whose copy names "Help and support" are the ones a member cannot clear alone
 * (a refused request, an app that no longer matches the workspace), so the
 * inbox shows the support link under exactly those notices. Session and
 * connection faults have their own recovery and get no link.
 */
export function channelLoadNeedsSupport(loadFault: ChannelLoadFault | null): boolean {
  return loadFault === 'request' || loadFault === 'schema';
}

/**
 * Inbox notice for a chapter-channel load outcome. Send failures live on a
 * send-specific field, so the inbox never falls back to `error()`:
 * a classified load fault uses its localized copy, an unclassified load
 * failure uses the localized unknown notice, and a ready store stays quiet.
 */
export function inboxChannelLoadNotice(
  copy: MessageInboxCopy,
  loadFault: ChannelLoadFault | null,
  loadFailed = false,
): string | null {
  return channelLoadFailureNotice(copy, loadFault)
    ?? (loadFailed ? copy.channelError.unknown : null);
}

/**
 * Member-facing notice for a classified live-channel send, reaction, or vote
 * failure. Copy is keyed by the action, not by ChannelLoadClassification, so a
 * later classification member does not require a matching record here.
 */
export function channelActionNotice(copy: MessageInboxCopy, op: ChannelActionOp): string {
  return copy.channelActionError[op];
}
