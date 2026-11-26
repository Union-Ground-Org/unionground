import type { MessageInboxItem } from './messageInbox';
import type { MemberConversation } from '../models/member';

export const messageWorkflowDefault = 'people-spaces-work' as const;
export const messageWorkflowKeys = ['attention', messageWorkflowDefault, 'workstreams'] as const;
export type MessageWorkflow = (typeof messageWorkflowKeys)[number];

export type MessageWorkflowGroup = {
  key: 'needs-you' | 'waiting' | 'later' | 'people' | 'spaces' | 'work' | 'inbox' | 'cases-tasks' | 'campaigns-meetings' | 'resources';
  items: MessageInboxItem[];
};

export function normalizeMessageWorkflow(value: string | null | undefined): MessageWorkflow {
  return messageWorkflowKeys.includes(value as MessageWorkflow) ? value as MessageWorkflow : messageWorkflowDefault;
}

// The general steward actions (no selection: the urgent-help action on My
// union, the Messages steward row) reuse only the general thread; a thread
// opened from a selected steward's card coexists with it and is never picked
// there. With a steward selected (REQ-UG-MEMBER-FIND-MY-STEWARD-HOME-ENTRY-20260922)
// the only acceptable answer is the thread bound to THAT steward.
export function findNativeStewardConversation(
  conversations: readonly MemberConversation[],
  stewardUserId?: string | null,
): MemberConversation | null {
  if (stewardUserId != null && stewardUserId !== '') {
    return conversations.find((conversation) => conversation.stewardUserId === stewardUserId) ?? null;
  }
  return conversations.find((conversation) => conversation.counterpartRole === 'steward' && conversation.stewardUserId == null) ?? null;
}

export type NativeStewardContactRoute =
  | { kind: 'conversation'; conversationID: string }
  | { kind: 'start' };

// Where the Contact control on a steward card goes. A selected steward with no
// bound conversation yet gets a first-message composer bound to that steward
// (start_member_steward_conversation); it must not fall through to whatever
// steward thread happens to exist, nor to the generic Messages composer.
export function nativeStewardContactRoute(
  conversations: readonly MemberConversation[],
  stewardUserID?: string | null,
): NativeStewardContactRoute {
  const conversation = findNativeStewardConversation(conversations, stewardUserID);
  return conversation ? { kind: 'conversation', conversationID: conversation.id } : { kind: 'start' };
}

export function groupNativeMessageItems(items: readonly MessageInboxItem[], workflow: MessageWorkflow): MessageWorkflowGroup[] {
  const unassigned = [...items];
  const definitions: Array<[MessageWorkflowGroup['key'], (item: MessageInboxItem) => boolean]> = workflow === 'attention'
    ? [
      ['needs-you', (item) => item.unread > 0],
      ['waiting', (item) => item.kind === 'direct'],
      ['later', () => true],
    ]
    : workflow === 'workstreams'
      ? [
        ['inbox', (item) => item.kind === 'direct'],
        ['campaigns-meetings', (item) => item.kind === 'channel'],
        ['cases-tasks', () => false],
        ['resources', () => true],
      ]
      : [
        ['people', (item) => item.kind === 'direct'],
        ['spaces', (item) => item.kind === 'channel'],
        ['work', () => true],
      ];

  return definitions.map(([key, accepts]) => {
    const groupItems = unassigned.filter(accepts);
    for (const item of groupItems) unassigned.splice(unassigned.indexOf(item), 1);
    return { key, items: groupItems };
  }).filter((group) => group.items.length > 0);
}

type WorkflowCopy = {
  choiceLabel: string;
  onboardingEyebrow: string;
  onboardingTitle: string;
  onboardingBody: string;
  useChoice: string;
  skip: string;
  /** The organize sheet's close control and its scrim: the same result as Skip. */
  close: string;
  defaultBadge: string;
  proLabel: string;
  conLabel: string;
  settingsTitle: string;
  settingsBody: string;
  saved: string;
  saveFailed: string;
  workflow: Record<MessageWorkflow, { title: string; summary: string; pro: string; con: string }>;
  groups: Record<MessageWorkflowGroup['key'], string>;
  briefing: {
    title: string;
    expand: string;
    collapse: string;
    body: string;
    changed: string;
    needsYou: string;
    waiting: string;
    delivery: string;
    changedValue(count: number): string;
    needsYouValue(count: number): string;
    waitingValue(count: number): string;
    deliveryValue: string;
  };
};

export const messageWorkflowCopy: Record<'en' | 'es', WorkflowCopy> = {
  en: {
    choiceLabel: 'Messaging workflow',
    onboardingEyebrow: 'Choose how Messages is organized',
    onboardingTitle: 'Start with the view that fits your day',
    onboardingBody: 'Each view holds the same messages. Only how they are grouped changes, and you can switch later in Settings.',
    useChoice: 'Use this workflow',
    skip: 'Skip and use the default',
    close: 'Close and use the default',
    defaultBadge: 'Default',
    proLabel: 'Best for',
    conLabel: 'Keep in mind',
    settingsTitle: 'Messaging workflow',
    settingsBody: 'Choose how Messages groups your conversations. Nothing else about them changes.',
    saved: 'Messaging workflow saved.',
    saveFailed: 'Your choice could not be saved on this phone. It will be asked again next time.',
    workflow: {
      attention: { title: 'To-do inbox', summary: 'Needs you, Waiting, and Later', pro: 'Fast daily triage.', con: 'Conversation types are less prominent.' },
      'people-spaces-work': { title: 'People / Spaces / Work', summary: 'People, shared spaces, and trackable work', pro: 'The clearest all-purpose model.', con: 'Urgent work spans three groups.' },
      workstreams: { title: 'Workstream Threads', summary: 'Inbox, issues and tasks, campaigns and meetings, resources', pro: 'Staff coordinating several contexts.', con: 'More structure for occasional use.' },
    },
    groups: { 'needs-you': 'Needs you', waiting: 'Waiting', later: 'Later', people: 'People', spaces: 'Spaces', work: 'Work', inbox: 'Inbox', 'cases-tasks': 'Issues and tasks', 'campaigns-meetings': 'Campaigns and meetings', resources: 'Resources' },
    briefing: {
      title: 'Guide briefing', expand: 'Expand Guide briefing', collapse: 'Collapse Guide briefing',
      body: 'Built from the messages on this screen. Open a message before acting on it.',
      changed: 'What changed', needsYou: 'What needs you', waiting: 'Waiting on others', delivery: 'Delivery problems',
      changedValue: (count) => `${count} inbox ${count === 1 ? 'item is' : 'items are'} in this view.`,
      needsYouValue: (count) => `${count} unread items need review.`,
      waitingValue: (count) => `${count} read direct threads may be waiting on others.`,
      deliveryValue: 'Delivery status isn’t shown in this inbox.',
    },
  },
  es: {
    choiceLabel: 'Flujo de mensajes',
    onboardingEyebrow: 'Elige cómo funcionan los Mensajes',
    onboardingTitle: 'Empieza con la vista que encaje con tu día',
    onboardingBody: 'Cada vista contiene los mismos mensajes autorizados. Solo cambia cómo se agrupan y puedes cambiarla después en Configuración.',
    useChoice: 'Usar este flujo',
    skip: 'Omitir y usar el predeterminado',
    close: 'Cerrar y usar el predeterminado',
    defaultBadge: 'Predeterminado',
    proLabel: 'Ideal para',
    conLabel: 'Consideración',
    settingsTitle: 'Flujo de mensajes',
    settingsBody: 'Elige cómo Mensajes agrupa las mismas conversaciones autorizadas. La elección solo cambia la presentación.',
    saved: 'Flujo de mensajes guardado.',
    saveFailed: 'No se pudo guardar tu elección en este teléfono. Se volverá a preguntar la próxima vez.',
    workflow: {
      attention: { title: 'Bandeja de pendientes', summary: 'Te necesita, En espera y Más tarde', pro: 'Clasificar rápidamente.', con: 'Los tipos son menos visibles.' },
      'people-spaces-work': { title: 'Personas / Espacios / Trabajo', summary: 'Personas, espacios compartidos y trabajo rastreable', pro: 'El modelo general más claro.', con: 'Lo urgente abarca tres grupos.' },
      workstreams: { title: 'Hilos de trabajo', summary: 'Bandeja, asuntos y tareas, campañas y reuniones, recursos', pro: 'Personal que coordina varios contextos.', con: 'Más estructura para uso ocasional.' },
    },
    groups: { 'needs-you': 'Te necesita', waiting: 'En espera', later: 'Más tarde', people: 'Personas', spaces: 'Espacios', work: 'Trabajo', inbox: 'Bandeja', 'cases-tasks': 'Asuntos y tareas', 'campaigns-meetings': 'Campañas y reuniones', resources: 'Recursos' },
    briefing: {
      title: 'Resumen de la Guía', expand: 'Expandir resumen de la Guía', collapse: 'Contraer resumen de la Guía',
      body: 'Creado con metadatos de mensajes autorizados en esta pantalla. Abre la fuente antes de actuar.',
      changed: 'Qué cambió', needsYou: 'Qué necesita tu atención', waiting: 'En espera de otras personas', delivery: 'Problemas de entrega',
      changedValue: (count) => `Hay ${count} elementos autorizados disponibles en esta vista de la bandeja.`,
      needsYouValue: (count) => `${count} elementos sin leer necesitan revisión.`,
      waitingValue: (count) => `${count} hilos directos leídos pueden estar esperando a otras personas.`,
      deliveryValue: 'Los metadatos del estado de entrega no están disponibles en esta bandeja.',
    },
  },
};

export const messageWorkflowOptions = messageWorkflowKeys.map((key, index) => ({
  key,
  number: index + 1,
  recommended: key === messageWorkflowDefault,
}));
