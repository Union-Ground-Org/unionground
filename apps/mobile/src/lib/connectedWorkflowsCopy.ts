// English/Spanish copy for the native connected-workflow surfaces. The string
// values mirror the shared web COPY tables in
// src/features/connectedWorkflows/*.jsx so both shells speak with one voice.

export type ConnectedLanguage = 'en' | 'es';

export type ConnectedActionsCopy = {
  actions: string;
  loading: string;
  unavailable: string;
  failed: string;
  message: string;
  remind: string;
  openTask: string;
  createTask: string;
  discussion: string;
  source: string;
  recipients: string;
  messageBody: string;
  send: string;
  cancel: string;
  discard: string;
  discardReminder: string;
  discardContact: string;
  more: string;
  noRecipients: string;
  // Phone only (#9959): the recipient limit where people are picked, and why
  // Send cannot send yet. {max}, {count} are filled in by the composer.
  recipientLimit: string;
  recipientLimitReached: string;
  sendNeedsRecipient: string;
  sendNeedsMessage: string;
  sendTooLong: string;
  cancelled: string;
  sent: string;
  reminderSet: string;
  // Phone only: the web sheet holds no reminder choice across actions.
  reminderRemoved: string;
  empty: string;
  retry: string;
  unmapped: string;
  roleClosed: string;
  close: string;
  eventActions: string;
  taskActions: string;
};

export const connectedActionsCopy: Record<ConnectedLanguage, ConnectedActionsCopy> = {
  en: {
    actions: 'Actions',
    loading: 'Checking access…',
    unavailable: 'This item is no longer available.',
    failed: 'Action not confirmed. Try again.',
    message: 'Message…',
    remind: 'Remind me…',
    openTask: 'Open linked task',
    createTask: 'Create follow-up task',
    discussion: 'Open discussion',
    source: 'Open source',
    recipients: 'Recipients',
    messageBody: 'Message',
    send: 'Send message',
    cancel: 'Cancel',
    discard: 'Discard',
    discardReminder: 'Discard reminder',
    discardContact: 'Discard meeting choices',
    more: 'More recipients',
    noRecipients: 'No authorized recipients are available.',
    recipientLimit: 'Choose up to {max} recipients. {count} chosen.',
    recipientLimitReached: 'You have chosen {max}, the most allowed. Remove one to choose another.',
    sendNeedsRecipient: 'Choose at least one recipient to send.',
    sendNeedsMessage: 'Write a message to send.',
    sendTooLong: 'Shorten the message to {max} characters to send.',
    cancelled: 'This meeting is cancelled.',
    sent: 'Message sent.',
    reminderSet: 'Reminder set.',
    reminderRemoved: 'Your unsaved reminder was removed because reminders are no longer allowed here.',
    empty: 'No actions are available.',
    retry: 'Try again',
    unmapped: 'That destination cannot be opened from this app yet.',
    roleClosed: 'The role you are using cannot open that screen.',
    close: 'Close',
    eventActions: 'Meeting actions',
    taskActions: 'Task actions',
  },
  es: {
    actions: 'Acciones',
    loading: 'Comprobando acceso…',
    unavailable: 'Este elemento ya no está disponible.',
    failed: 'No se confirmó la acción. Inténtalo de nuevo.',
    message: 'Enviar mensaje…',
    remind: 'Recordarme…',
    openTask: 'Abrir tarea vinculada',
    createTask: 'Crear tarea de seguimiento',
    discussion: 'Abrir conversación',
    source: 'Abrir origen',
    recipients: 'Destinatarios',
    messageBody: 'Mensaje',
    send: 'Enviar mensaje',
    cancel: 'Cancelar',
    discard: 'Descartar',
    discardReminder: 'Descartar recordatorio',
    discardContact: 'Descartar opciones del reunión',
    more: 'Más destinatarios',
    noRecipients: 'No hay destinatarios autorizados disponibles.',
    recipientLimit: 'Elige hasta {max} destinatarios. Elegidos: {count}.',
    recipientLimitReached: 'Elegiste {max}, el máximo permitido. Quita uno para elegir otro.',
    sendNeedsRecipient: 'Elige al menos un destinatario para enviar.',
    sendNeedsMessage: 'Escribe un mensaje para enviar.',
    sendTooLong: 'Acorta el mensaje a {max} caracteres para enviar.',
    cancelled: 'Este reunión está cancelado.',
    sent: 'Mensaje enviado.',
    reminderSet: 'Recordatorio creado.',
    reminderRemoved: 'Se quitó tu recordatorio sin guardar porque aquí ya no se permiten recordatorios.',
    empty: 'No hay acciones disponibles.',
    retry: 'Reintentar',
    unmapped: 'Ese destino aún no se puede abrir desde esta app.',
    roleClosed: 'El rol que estás usando no puede abrir esa pantalla.',
    close: 'Cerrar',
    eventActions: 'Acciones del reunión',
    taskActions: 'Acciones de la tarea',
  },
};

// The phone's follow-up task form (#9080). Native only: the web opens the task
// in its own board editor.
export type ConnectedTaskEditorCopy = {
  form: string;
  created: string;
  opened: string;
  workClosed: string;
  loading: string;
  title: string;
  titleInvalid: string;
  assignee: string;
  unassigned: string;
  findPerson: string;
  narrowPeople: string;
  noPeople: string;
  dueDate: string;
  dueDateInvalid: string;
  save: string;
  saved: string;
  openInWork: string;
  reload: string;
  failures: Record<'changed' | 'not_allowed' | 'dates' | 'unavailable' | 'failed', string>;
};

export const connectedTaskEditorCopy: Record<ConnectedLanguage, ConnectedTaskEditorCopy> = {
  en: {
    form: 'Follow-up task',
    created: 'Follow-up task created. Give it a title, a person and a due date, then save.',
    opened: 'This is the linked task. Change its title, person or due date, then save.',
    workClosed: 'Campaign work opens only for a role held in this campaign, so the linked task opens here.',
    loading: 'Loading the task…',
    title: 'Task title',
    titleInvalid: 'Give the task a title of up to 160 characters.',
    assignee: 'Assigned to',
    unassigned: 'Nobody yet',
    findPerson: 'Find a person',
    narrowPeople: 'Type a name to see more people.',
    noPeople: 'Nobody matches that name.',
    dueDate: 'Due date (YYYY-MM-DD)',
    dueDateInvalid: 'Enter the due date as year-month-day, for example 2026-12-01.',
    save: 'Save task',
    saved: 'Task saved.',
    openInWork: 'Open in Campaign work',
    reload: 'Reload task',
    failures: {
      changed: 'Someone changed this task after you opened it. Reload it, then save again.',
      not_allowed: 'Your role cannot change this task.',
      dates: 'The due date is before the task’s start date.',
      unavailable: 'This task is no longer available.',
      failed: 'The task was not saved. Try again.',
    },
  },
  es: {
    form: 'Tarea de seguimiento',
    created: 'Se creó la tarea de seguimiento. Ponle un título, una persona y una fecha límite, y guárdala.',
    opened: 'Esta es la tarea vinculada. Cambia su título, persona o fecha límite, y guárdala.',
    workClosed: 'El trabajo de la campaña solo se abre con un rol en esta campaña, así que la tarea vinculada se abre aquí.',
    loading: 'Cargando la tarea…',
    title: 'Título de la tarea',
    titleInvalid: 'Ponle a la tarea un título de hasta 160 caracteres.',
    assignee: 'Asignada a',
    unassigned: 'Nadie todavía',
    findPerson: 'Buscar a una persona',
    narrowPeople: 'Escribe un nombre para ver más personas.',
    noPeople: 'Nadie coincide con ese nombre.',
    dueDate: 'Fecha límite (AAAA-MM-DD)',
    dueDateInvalid: 'Escribe la fecha límite como año-mes-día, por ejemplo 2026-12-01.',
    save: 'Guardar tarea',
    saved: 'Tarea guardada.',
    openInWork: 'Abrir en el trabajo de la campaña',
    reload: 'Volver a cargar la tarea',
    failures: {
      changed: 'Alguien cambió esta tarea después de que la abriste. Vuelve a cargarla y guárdala otra vez.',
      not_allowed: 'Tu rol no puede cambiar esta tarea.',
      dates: 'La fecha límite es anterior a la fecha de inicio de la tarea.',
      unavailable: 'Esta tarea ya no está disponible.',
      failed: 'No se guardó la tarea. Inténtalo de nuevo.',
    },
  },
};

export type ConnectedContactCopy = {
  organizer: string;
  edit: string;
  none: string;
  save: string;
  more: string;
  optIn: string;
  privacy: string;
  update: string;
  organizerSaved: string;
  contactSaved: string;
};

export const connectedContactCopy: Record<ConnectedLanguage, ConnectedContactCopy> = {
  en: {
    organizer: 'Organizer',
    edit: 'Choose organizer',
    none: 'No organizer',
    save: 'Save organizer',
    more: 'More organizers',
    optIn: 'Allow this meeting’s organizer to contact me about this meeting',
    privacy: 'RSVP alone does not share contact permission. You can turn this off at any time.',
    update: 'Save contact preference',
    organizerSaved: 'Organizer saved.',
    contactSaved: 'Contact preference saved.',
  },
  es: {
    organizer: 'Organizador',
    edit: 'Elegir organizador',
    none: 'Sin organizador',
    save: 'Guardar organizador',
    more: 'Más organizadores',
    optIn: 'Permitir que el organizador me contacte sobre este reunión',
    privacy: 'Confirmar asistencia no concede permiso de contacto. Puedes desactivarlo en cualquier momento.',
    update: 'Guardar preferencia de contacto',
    organizerSaved: 'Organizador guardado.',
    contactSaved: 'Preferencia de contacto guardada.',
  },
};

export type ConnectedDiscussionCopy = {
  participant: string;
  choose: string;
  morePeople: string;
  more: string;
  empty: string;
  you: string;
  organizer: string;
  attendee: string;
  loading: string;
  failed: string;
  removed: string;
  timeUnavailable: string;
};

export const connectedDiscussionCopy: Record<ConnectedLanguage, ConnectedDiscussionCopy> = {
  en: {
    participant: 'Participant',
    choose: 'Choose a participant',
    morePeople: 'More participants',
    more: 'Earlier messages',
    empty: 'No messages in this discussion.',
    you: 'You',
    organizer: 'Organizer',
    attendee: 'Attendee',
    loading: 'Loading discussion…',
    failed: 'This discussion is no longer available.',
    removed: 'Message removed',
    timeUnavailable: 'Time unavailable',
  },
  es: {
    participant: 'Participante',
    choose: 'Elige un participante',
    morePeople: 'Más participantes',
    more: 'Mensajes anteriores',
    empty: 'No hay mensajes en esta conversación.',
    you: 'Tú',
    organizer: 'Organizador',
    attendee: 'Asistente',
    loading: 'Cargando conversación…',
    failed: 'Esta conversación ya no está disponible.',
    removed: 'Mensaje eliminado',
    timeUnavailable: 'Hora no disponible',
  },
};

export type ConnectedRemindersCopy = {
  title: string;
  load: string;
  more: string;
  loading: string;
  empty: string;
  error: string;
  unavailable: string;
  source: string;
  snooze: string;
  complete: string;
  cancel: string;
  failed: string;
  message: string;
  task: string;
  event: string;
  reminder: string;
};

export const connectedRemindersCopy: Record<ConnectedLanguage, ConnectedRemindersCopy> = {
  en: {
    title: 'Reminders',
    load: 'Load reminders',
    more: 'More reminders',
    loading: 'Loading…',
    empty: 'No active reminders.',
    error: 'Could not load reminders. Try again.',
    unavailable: 'The original item is no longer available.',
    source: 'Open original',
    snooze: 'Snooze…',
    complete: 'Complete',
    cancel: 'Cancel reminder',
    failed: 'Action not confirmed. Try again.',
    message: 'Message',
    task: 'Task',
    event: 'Calendar meeting',
    reminder: 'Reminder',
  },
  es: {
    title: 'Recordatorios',
    load: 'Cargar recordatorios',
    more: 'Más recordatorios',
    loading: 'Cargando…',
    empty: 'No hay recordatorios activos.',
    error: 'No se pudieron cargar los recordatorios. Inténtalo de nuevo.',
    unavailable: 'El elemento original ya no está disponible.',
    source: 'Abrir origen',
    snooze: 'Posponer…',
    complete: 'Completar',
    cancel: 'Cancelar recordatorio',
    failed: 'No se confirmó la acción. Inténtalo de nuevo.',
    message: 'Mensaje',
    task: 'Tarea',
    event: 'Evento de calendario',
    reminder: 'Recordatorio',
  },
};

export function connectedLanguageOf(value: string | null | undefined): ConnectedLanguage {
  return value === 'es' ? 'es' : 'en';
}
