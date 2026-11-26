// REQ-UG-QUOTES-MINI-LESSONS-20260928: native English and Spanish copy
// for governed quotes and mini-lessons, catalogue-free like messageInboxCopy.
// The interface language follows the same member language that selects the
// content locale, so a Spanish member reads Spanish controls around Spanish
// content and is told plainly when none exists; English is never substituted.

import type {
  LearningAudience,
  LearningIssue,
  LearningIssueField,
  LearningKind,
  LearningLocale,
  LearningLocaleState,
  LearningScope,
  LearningStatus,
  LearningTransition,
} from './learningContentModel';

export type LearningFieldLabels = Record<Exclude<LearningIssueField, 'payload'>, string>;

export type LearningCopy = {
  kind: Record<LearningKind, string>;
  kindEyebrow: Record<LearningKind, string>;
  status: Record<LearningStatus, string>;
  scope: Record<LearningScope, string>;
  locale: Record<LearningLocale, string>;
  localeState: Record<LearningLocaleState, string>;
  audience: Record<LearningAudience, string>;
  fields: LearningFieldLabels;
  lessonBodyLabel: string;
  quoteBodyLabel: string;
  // Home
  homeHeading: string;
  next: string;
  position: (position: number, total: number) => string;
  hide: string;
  hiddenNote: string;
  hideError: string;
  readMore: string;
  showLess: string;
  keyPoints: string;
  outcome: string;
  sourceLine: (source: string) => string;
  attributionLine: (attribution: string) => string;
  openLearn: string;
  // Learn
  learnHeading: string;
  learnIntro: string;
  learnLoadingTitle: string;
  learnLoadingBody: string;
  learnEmptyTitle: string;
  learnEmptyBody: string;
  learnDisabledTitle: string;
  learnDisabledBody: string;
  learnErrorTitle: string;
  learnErrorBody: string;
  learnNoChapterTitle: string;
  learnNoChapterBody: string;
  retry: string;
  loadMoreLessons: string;
  readLesson: string;
  closeLesson: string;
  readLessonLabel: (title: string) => string;
  closeLessonLabel: (title: string) => string;
  homeHiddenTitle: string;
  homeHiddenBody: string;
  restore: string;
  restoreError: string;
  restored: string;
  manage: string;
  // Account entrance
  accountHeading: string;
  accountEntryTitle: string;
  accountEntryBody: string;
  accountEntryAction: string;
  accountEntryLabel: string;
  backToAccount: string;
  // Manager
  managerTitle: string;
  managerIntro: string;
  backToLearn: string;
  scopeHeading: string;
  scopeUnavailable: string;
  workspaceLoadingTitle: string;
  workspaceLoadingBody: string;
  policyHeading: string;
  platformPolicyNote: string;
  tenantPolicyNote: string;
  quotesSwitch: string;
  lessonsSwitch: string;
  selectionHeading: string;
  selectionAll: string;
  selectionNone: string;
  selectionSome: string;
  selectionAllBody: string;
  selectionNoneBody: string;
  selectionSomeBody: string;
  selectionCount: (count: number) => string;
  selectionKept: (count: number) => string;
  selectionLimit: (limit: number) => string;
  savePolicy: string;
  policySaved: string;
  policyReload: string;
  contentHeading: string;
  workspaceEmpty: string;
  loadMoreItems: string;
  newQuote: string;
  newLesson: string;
  edit: string;
  editLabel: (title: string) => string;
  itemMeta: (kind: string, locale: string, revision: number) => string;
  liveWindow: (starts: string, ends: string | null) => string;
  // Editor
  newItemTitle: (kind: string) => string;
  editItemTitle: string;
  backToList: string;
  fixedIdentity: string;
  directionHint: string;
  factualHint: string;
  isDefaultHint: string;
  counter: (count: number, limit: number) => string;
  counterLabel: (label: string, count: number, limit: number) => string;
  addBullet: string;
  addTopic: string;
  removeEntry: (label: string, position: number) => string;
  entryLabel: (label: string, position: number) => string;
  saveDraft: string;
  saveNote: string;
  saved: string;
  fixIssues: string;
  preview: string;
  hidePreview: string;
  previewNote: string;
  previewHomeLabel: string;
  previewLearnLabel: string;
  publicationHeading: string;
  publicationSaveFirst: string;
  publicationBlocked: string;
  publishNow: string;
  schedule: string;
  withdraw: string;
  confirmPublish: string;
  confirmSchedule: string;
  confirmWithdraw: string;
  confirm: string;
  cancel: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  dateHint: string;
  timeHint: string;
  timeZoneNote: (zone: string) => string;
  invalidDateTime: string;
  published: string;
  scheduled: string;
  withdrawn: string;
  provenanceHeading: string;
  provenanceIntro: string;
  historyHeading: string;
  showHistory: string;
  hideHistory: string;
  historyEmpty: string;
  loadMoreHistory: string;
  historyAction: (action: string) => string;
  historyRevision: (revision: number) => string;
  historyByYou: string;
  historyByOther: string;
  historyByRemoved: string;
  discardTitle: string;
  discard: string;
  keepEditing: string;
  // Unsent work kept through a session check (record 9240, pull request B)
  heldLoading: string;
  heldStale: string;
  heldPolicyStale: string;
  heldUncertain: string;
  saveAgain: string;
  // Failures
  conflict: string;
  notAuthorized: string;
  invalid: string;
  failed: string;
  issue: (issue: LearningIssue) => string;
};

function issueMessage(fields: LearningFieldLabels, language: LearningLocale) {
  const es = language === 'es';
  return (issue: LearningIssue): string => {
    const label = issue.field === 'payload' ? (es ? 'El contenido' : 'This item') : fields[issue.field];
    const position = typeof issue.index === 'number' ? issue.index + 1 : null;
    switch (issue.code) {
      case 'required':
        // Publication asks for these three; the shared model reports them as
        // required in publish mode.
        if (issue.field === 'source') return es ? 'Agrega la fuente: es obligatoria para elementos atribuidos o con afirmaciones de hecho.' : 'Add the source: attributed and factual items need one before publishing.';
        if (issue.field === 'rights_note') return es ? 'Agrega la nota de derechos de uso antes de publicar.' : 'Add the reuse rights note before publishing.';
        if (issue.field === 'review_note') return es ? 'Agrega la nota de revisión antes de publicar.' : 'Add the review note before publishing.';
        if (issue.field === 'starts_at') return es ? 'Indica la fecha y hora de inicio.' : 'Enter the start date and time.';
        return es ? `${label}: es obligatorio.` : `${label} is required.`;
      case 'too_long': return es ? `${label}: máximo ${issue.limit} caracteres.` : `${label} must be ${issue.limit} characters or fewer.`;
      case 'too_many': return es ? `${label}: máximo ${issue.limit} entradas.` : `${label} allows at most ${issue.limit} entries.`;
      case 'empty_entry': return es ? `${label} ${position}: está vacío. Complétalo o quítalo.` : `${label} ${position} is empty. Fill it in or remove it.`;
      case 'entry_too_long': return es ? `${label} ${position}: máximo ${issue.limit} caracteres.` : `${label} ${position} must be ${issue.limit} characters or fewer.`;
      case 'out_of_range': return es ? `${label}: usa un número entero de 0 a 100.` : `${label} must be a whole number from 0 to 100.`;
      case 'platform_only': return es ? `${label}: solo se permite en el alcance de la plataforma.` : `${label} is only allowed at platform scope.`;
      case 'too_large': return es ? 'El contenido es demasiado grande para guardarlo. Acorta el texto.' : 'This item is too large to save. Shorten the text.';
      case 'not_reviewed': return es ? 'Marca el idioma como revisado antes de publicar. La traducción nunca se da por hecha.' : 'Mark the language as reviewed before publishing. Translation is never assumed.';
      case 'invalid_date': return es ? `${label}: fecha u hora no válida.` : `${label} is not a valid date and time.`;
      case 'not_allowed': return es ? `${label}: no se usa en esta acción.` : `${label} does not apply to this action.`;
      case 'not_future': return es ? 'La programación debe empezar en el futuro.' : 'A schedule must start in the future.';
      case 'not_after_start': return es ? 'El final debe ser posterior al inicio.' : 'The end must come after the start.';
      case 'invalid': return es ? `${label}: valor no válido.` : `${label} has an invalid value.`;
    }
  };
}

const enFields: LearningFieldLabels = {
  kind: 'Type',
  locale: 'Language',
  locale_state: 'Language review',
  title: 'Title',
  body: 'Text',
  attribution: 'Attribution',
  source: 'Source',
  rights_note: 'Reuse rights note',
  review_note: 'Review note',
  bullets: 'Key point',
  direction: 'Editorial direction',
  topics: 'Topic',
  audience: 'Audience',
  tone: 'Tone',
  learning_outcome: 'Learning outcome',
  factual_claims: 'Contains factual claims',
  priority: 'Priority',
  is_default: 'Platform default',
  starts_at: 'Start',
  ends_at: 'End',
  action: 'Action',
};

const esFields: LearningFieldLabels = {
  kind: 'Tipo',
  locale: 'Idioma',
  locale_state: 'Revisión del idioma',
  title: 'Título',
  body: 'Texto',
  attribution: 'Atribución',
  source: 'Fuente',
  rights_note: 'Nota de derechos de uso',
  review_note: 'Nota de revisión',
  bullets: 'Punto clave',
  direction: 'Dirección editorial',
  topics: 'Tema',
  audience: 'Público',
  tone: 'Tono',
  learning_outcome: 'Resultado de aprendizaje',
  factual_claims: 'Contiene afirmaciones de hecho',
  priority: 'Prioridad',
  is_default: 'Predeterminado de la plataforma',
  starts_at: 'Inicio',
  ends_at: 'Fin',
  action: 'Acción',
};

function historyAction(language: LearningLocale, action: string): string {
  const labels: Record<string, [string, string]> = {
    save_draft: ['Saved as draft', 'Guardado como borrador'],
    // The one-time import of recovered drafts records its own first revision.
    recover_draft: ['Recovered as a draft', 'Recuperado como borrador'],
    publish: ['Published', 'Publicado'],
    schedule: ['Scheduled', 'Programado'],
    withdraw: ['Withdrawn', 'Retirado'],
    // The platform explainers' public source details (20261111103000).
    public_provenance: ['Public source details updated', 'Detalles de la fuente pública actualizados'],
  };
  // UX-UG-LEARNING-CONTENT-HISTORY-POLISH-BATCH-20261115: never a raw
  // action name; an action this build does not know reads as the web's
  // generic label.
  const known = Object.hasOwn(labels, action) ? labels[action] : undefined;
  const entry: [string, string] = known ?? ['Changed', 'Cambiado'];
  return language === 'es' ? entry[1] : entry[0];
}

export const learningContentCopy: Record<LearningLocale, LearningCopy> = {
  en: {
    kind: { quote: 'Quote', mini_lesson: 'Mini-lesson' },
    kindEyebrow: { quote: 'QUOTE', mini_lesson: 'MINI-LESSON' },
    status: { draft: 'Draft', published: 'Published', scheduled: 'Scheduled', withdrawn: 'Withdrawn' },
    scope: { platform: 'Platform', organization: 'Organization', chapter: 'This campaign' },
    locale: { en: 'English', es: 'Spanish' },
    localeState: { draft: 'Not reviewed', reviewed: 'Reviewed' },
    audience: { all: 'Everyone', members: 'Workers', staff: 'Staff' },
    fields: enFields,
    lessonBodyLabel: 'Lesson text',
    quoteBodyLabel: 'Quote text',
    homeHeading: 'Today’s learning',
    next: 'Next',
    position: (position, total) => `${position} of ${total}`,
    hide: 'Hide from Home',
    hiddenNote: 'Hidden from Home. You can show it again from Organizing rights.',
    hideError: 'Home could not be updated. Try again.',
    readMore: 'Read more',
    showLess: 'Show less',
    keyPoints: 'Key points',
    outcome: 'What you will learn',
    sourceLine: (source) => `Source: ${source}`,
    attributionLine: (attribution) => `— ${attribution}`,
    openLearn: 'Open Organizing rights',
    learnHeading: 'Mini-lessons',
    learnIntro: 'Short lessons your campaign reviewed and published.',
    learnLoadingTitle: 'Loading mini-lessons',
    learnLoadingBody: 'Checking what your campaign publishes.',
    learnEmptyTitle: 'No mini-lessons in English yet',
    learnEmptyBody: 'Your campaign has not published mini-lessons in English.',
    learnDisabledTitle: 'Mini-lessons are not available',
    learnDisabledBody: 'Mini-lessons are not offered here right now.',
    learnErrorTitle: 'Mini-lessons are unavailable',
    learnErrorBody: 'They could not be confirmed for your current campaign.',
    learnNoChapterTitle: 'Choose a campaign',
    learnNoChapterBody: 'Learning content follows your selected campaign.',
    retry: 'Try again',
    loadMoreLessons: 'Load more mini-lessons',
    readLesson: 'Read lesson',
    closeLesson: 'Close lesson',
    readLessonLabel: (title) => `Read lesson: ${title}`,
    closeLessonLabel: (title) => `Close lesson: ${title}`,
    homeHiddenTitle: 'Learning is hidden from Home',
    homeHiddenBody: 'You hid quotes and mini-lessons from Home.',
    restore: 'Show on Home again',
    restoreError: 'Home could not be updated. Try again.',
    restored: 'Quotes and mini-lessons are back on Home.',
    manage: 'Manage learning content',
    accountHeading: 'Administration',
    accountEntryTitle: 'Quotes and lessons',
    accountEntryBody: 'Write, review and publish learning content for the scopes you manage.',
    accountEntryAction: 'Manage',
    accountEntryLabel: 'Manage quotes and lessons',
    backToAccount: 'Back to Account',
    managerTitle: 'Learning content',
    managerIntro: 'Write, review and publish quotes and mini-lessons for the scope you manage.',
    backToLearn: 'Back to Organizing rights',
    scopeHeading: 'Scope',
    scopeUnavailable: 'Your current role cannot manage this scope.',
    workspaceLoadingTitle: 'Loading content',
    workspaceLoadingBody: 'Confirming that your role manages this scope.',
    policyHeading: 'Module switches',
    platformPolicyNote: 'Platform switches start off. Organizations and campaigns can only turn content off.',
    tenantPolicyNote: 'This scope can turn content off. It cannot turn on anything a wider scope turned off.',
    quotesSwitch: 'Quotes',
    lessonsSwitch: 'Mini-lessons',
    selectionHeading: 'Content selection',
    selectionAll: 'All eligible content',
    selectionNone: 'No content',
    selectionSome: 'Only selected items',
    selectionAllBody: 'Every published item this scope inherits stays eligible.',
    selectionNoneBody: 'Nothing is shown from this scope down.',
    selectionSomeBody: 'Only the items you check are eligible.',
    selectionCount: (count) => `${count} selected`,
    selectionKept: (count) => `${count} selected item${count === 1 ? '' : 's'} not listed here ${count === 1 ? 'stays' : 'stay'} selected.`,
    selectionLimit: (limit) => `Select at most ${limit} items.`,
    savePolicy: 'Save switches and selection',
    policySaved: 'Switches and selection saved.',
    policyReload: 'Reload current settings',
    contentHeading: 'Content in this scope',
    workspaceEmpty: 'No content in this scope yet.',
    loadMoreItems: 'Load more items',
    newQuote: 'New quote',
    newLesson: 'New mini-lesson',
    edit: 'Edit',
    editLabel: (title) => `Edit ${title}`,
    itemMeta: (kind, locale, revision) => `${kind} · ${locale} · revision ${revision}`,
    liveWindow: (starts, ends) => (ends ? `Live ${starts} until ${ends}` : `Live from ${starts}`),
    newItemTitle: (kind) => `New ${kind.toLocaleLowerCase('en-US')}`,
    editItemTitle: 'Edit item',
    backToList: 'Back to content list',
    fixedIdentity: 'Type and language are fixed after the first save. Create a separate item for another language.',
    directionHint: 'Editorial intent only. Never include worker names, issues or other private details.',
    factualHint: 'Factual items need a source before publishing.',
    isDefaultHint: 'Defaults reach every organization that has not narrowed its selection.',
    counter: (count, limit) => `${count}/${limit}`,
    counterLabel: (label, count, limit) => `${label}, ${count} of ${limit} characters`,
    addBullet: 'Add key point',
    addTopic: 'Add topic',
    removeEntry: (label, position) => `Remove ${label.toLocaleLowerCase('en-US')} ${position}`,
    entryLabel: (label, position) => `${label} ${position}`,
    saveDraft: 'Save draft',
    saveNote: 'Saving returns the item to draft and clears its publication window.',
    saved: 'Draft saved.',
    fixIssues: 'Fix these before saving:',
    preview: 'Preview',
    hidePreview: 'Hide preview',
    previewNote: 'Preview only. Workers see nothing until it is published.',
    previewHomeLabel: 'On Home',
    previewLearnLabel: 'In Organizing rights',
    publicationHeading: 'Publication',
    publicationSaveFirst: 'Save your changes before publishing.',
    publicationBlocked: 'Before publishing:',
    publishNow: 'Publish now',
    schedule: 'Schedule',
    withdraw: 'Withdraw',
    confirmPublish: 'Publish this item now?',
    confirmSchedule: 'Schedule this item?',
    confirmWithdraw: 'Withdraw this item? Workers stop seeing it right away.',
    confirm: 'Confirm',
    cancel: 'Cancel',
    startDate: 'Start date',
    startTime: 'Start time',
    endDate: 'End date (optional)',
    endTime: 'End time (optional)',
    dateHint: 'YYYY-MM-DD',
    timeHint: 'HH:MM, 24-hour',
    timeZoneNote: (zone) => `Times use this phone’s time zone (${zone}).`,
    invalidDateTime: 'Enter the date as YYYY-MM-DD and the time as HH:MM.',
    published: 'Published.',
    scheduled: 'Scheduled.',
    withdrawn: 'Withdrawn.',
    provenanceHeading: 'Provenance',
    provenanceIntro: 'Recorded when this item was recovered or imported. Check it before reviewing rights and sources.',
    historyHeading: 'Revision history',
    showHistory: 'Show revision history',
    hideHistory: 'Hide revision history',
    historyEmpty: 'No revisions recorded yet.',
    loadMoreHistory: 'Load older revisions',
    historyAction: (action) => historyAction('en', action),
    historyRevision: (revision) => `Revision ${revision}`,
    historyByYou: 'By you',
    historyByOther: 'By another editor',
    historyByRemoved: 'By a removed account',
    discardTitle: 'Discard unsaved changes?',
    discard: 'Discard',
    keepEditing: 'Keep editing',
    heldLoading: 'Loading your work',
    heldStale: 'This item changed while you were away. Your changes are still here, but saving them will be refused: copy what you need, then open the item again from the list.',
    heldPolicyStale: 'These settings changed while you were away. Your choices are still here, but saving them will be refused: reload the current settings and choose again.',
    heldUncertain: 'We could not confirm this draft was saved. Saving again can make a second copy. If you discard it, look for it in the content list before writing it again.',
    saveAgain: 'Save again',
    conflict: 'This item changed since you opened it. Go back to the list and open it again.',
    notAuthorized: 'Your current role cannot make this change.',
    invalid: 'The server refused these values. Check the fields and try again.',
    failed: 'The change could not be confirmed. Check your connection and try again.',
    issue: issueMessage(enFields, 'en'),
  },
  es: {
    kind: { quote: 'Cita', mini_lesson: 'Minilección' },
    kindEyebrow: { quote: 'CITA', mini_lesson: 'MINILECCIÓN' },
    status: { draft: 'Borrador', published: 'Publicado', scheduled: 'Programado', withdrawn: 'Retirado' },
    scope: { platform: 'Plataforma', organization: 'Organización', chapter: 'Esta campaña' },
    locale: { en: 'Inglés', es: 'Español' },
    localeState: { draft: 'Sin revisar', reviewed: 'Revisado' },
    audience: { all: 'Todos', members: 'Trabajadores', staff: 'Personal' },
    fields: esFields,
    lessonBodyLabel: 'Texto de la lección',
    quoteBodyLabel: 'Texto de la cita',
    homeHeading: 'Aprendizaje de hoy',
    next: 'Siguiente',
    position: (position, total) => `${position} de ${total}`,
    hide: 'Ocultar en Inicio',
    hiddenNote: 'Oculto en Inicio. Puedes volver a mostrarlo desde Conoce tus derechos.',
    hideError: 'No se pudo actualizar Inicio. Inténtalo de nuevo.',
    readMore: 'Leer más',
    showLess: 'Mostrar menos',
    keyPoints: 'Puntos clave',
    outcome: 'Lo que aprenderás',
    sourceLine: (source) => `Fuente: ${source}`,
    attributionLine: (attribution) => `— ${attribution}`,
    openLearn: 'Abrir Conoce tus derechos',
    learnHeading: 'Minilecciones',
    learnIntro: 'Lecciones breves que tu campaña revisó y publicó.',
    learnLoadingTitle: 'Cargando minilecciones',
    learnLoadingBody: 'Comprobando lo que publica tu campaña.',
    learnEmptyTitle: 'Todavía no hay minilecciones en español',
    learnEmptyBody: 'Tu campaña no ha publicado minilecciones en español.',
    learnDisabledTitle: 'Las minilecciones no están disponibles',
    learnDisabledBody: 'Por ahora no se ofrecen minilecciones aquí.',
    learnErrorTitle: 'Las minilecciones no están disponibles',
    learnErrorBody: 'No se pudieron confirmar para tu campaña actual.',
    learnNoChapterTitle: 'Elige una campaña',
    learnNoChapterBody: 'El contenido de aprendizaje sigue a la campaña que elegiste.',
    retry: 'Intentar de nuevo',
    loadMoreLessons: 'Cargar más minilecciones',
    readLesson: 'Leer la lección',
    closeLesson: 'Cerrar la lección',
    readLessonLabel: (title) => `Leer la lección: ${title}`,
    closeLessonLabel: (title) => `Cerrar la lección: ${title}`,
    homeHiddenTitle: 'El aprendizaje está oculto en Inicio',
    homeHiddenBody: 'Ocultaste las citas y minilecciones de Inicio.',
    restore: 'Mostrar de nuevo en Inicio',
    restoreError: 'No se pudo actualizar Inicio. Inténtalo de nuevo.',
    restored: 'Las citas y minilecciones volvieron a Inicio.',
    manage: 'Administrar contenido de aprendizaje',
    accountHeading: 'Administración',
    accountEntryTitle: 'Citas y lecciones',
    accountEntryBody: 'Escribe, revisa y publica contenido de aprendizaje para los alcances que administras.',
    accountEntryAction: 'Administrar',
    accountEntryLabel: 'Administrar citas y lecciones',
    backToAccount: 'Volver a Cuenta',
    managerTitle: 'Contenido de aprendizaje',
    managerIntro: 'Escribe, revisa y publica citas y minilecciones para el alcance que administras.',
    backToLearn: 'Volver a Conoce tus derechos',
    scopeHeading: 'Alcance',
    scopeUnavailable: 'Tu rol actual no puede administrar este alcance.',
    workspaceLoadingTitle: 'Cargando contenido',
    workspaceLoadingBody: 'Confirmando que tu rol administra este alcance.',
    policyHeading: 'Interruptores del módulo',
    platformPolicyNote: 'Los interruptores de la plataforma empiezan apagados. Las organizaciones y las campañas solo pueden apagar contenido.',
    tenantPolicyNote: 'Este alcance puede apagar contenido. No puede encender lo que un alcance más amplio apagó.',
    quotesSwitch: 'Citas',
    lessonsSwitch: 'Minilecciones',
    selectionHeading: 'Selección de contenido',
    selectionAll: 'Todo el contenido elegible',
    selectionNone: 'Ningún contenido',
    selectionSome: 'Solo los elementos seleccionados',
    selectionAllBody: 'Todo lo publicado que hereda este alcance sigue siendo elegible.',
    selectionNoneBody: 'No se muestra nada desde este alcance hacia abajo.',
    selectionSomeBody: 'Solo son elegibles los elementos que marques.',
    selectionCount: (count) => `${count} seleccionados`,
    selectionKept: (count) => `${count} ${count === 1 ? 'elemento seleccionado que no aparece aquí sigue seleccionado' : 'elementos seleccionados que no aparecen aquí siguen seleccionados'}.`,
    selectionLimit: (limit) => `Selecciona como máximo ${limit} elementos.`,
    savePolicy: 'Guardar interruptores y selección',
    policySaved: 'Interruptores y selección guardados.',
    policyReload: 'Recargar los ajustes actuales',
    contentHeading: 'Contenido en este alcance',
    workspaceEmpty: 'Todavía no hay contenido en este alcance.',
    loadMoreItems: 'Cargar más elementos',
    newQuote: 'Nueva cita',
    newLesson: 'Nueva minilección',
    edit: 'Editar',
    editLabel: (title) => `Editar ${title}`,
    itemMeta: (kind, locale, revision) => `${kind} · ${locale} · revisión ${revision}`,
    liveWindow: (starts, ends) => (ends ? `Visible del ${starts} al ${ends}` : `Visible desde ${starts}`),
    newItemTitle: (kind) => `Nueva ${kind.toLocaleLowerCase('es-US')}`,
    editItemTitle: 'Editar elemento',
    backToList: 'Volver a la lista de contenido',
    fixedIdentity: 'El tipo y el idioma quedan fijos después del primer guardado. Crea un elemento aparte para otro idioma.',
    directionHint: 'Solo intención editorial. Nunca incluyas nombres de trabajadores, asuntos ni otros datos privados.',
    factualHint: 'Los elementos con hechos necesitan una fuente antes de publicarse.',
    isDefaultHint: 'Lo predeterminado llega a toda organización que no haya limitado su selección.',
    counter: (count, limit) => `${count}/${limit}`,
    counterLabel: (label, count, limit) => `${label}, ${count} de ${limit} caracteres`,
    addBullet: 'Agregar punto clave',
    addTopic: 'Agregar tema',
    removeEntry: (label, position) => `Quitar ${label.toLocaleLowerCase('es-US')} ${position}`,
    entryLabel: (label, position) => `${label} ${position}`,
    saveDraft: 'Guardar borrador',
    saveNote: 'Guardar devuelve el elemento a borrador y borra su periodo de publicación.',
    saved: 'Borrador guardado.',
    fixIssues: 'Corrige esto antes de guardar:',
    preview: 'Vista previa',
    hidePreview: 'Ocultar vista previa',
    previewNote: 'Solo vista previa. Los trabajadores no ven nada hasta que se publique.',
    previewHomeLabel: 'En Inicio',
    previewLearnLabel: 'En Conoce tus derechos',
    publicationHeading: 'Publicación',
    publicationSaveFirst: 'Guarda tus cambios antes de publicar.',
    publicationBlocked: 'Antes de publicar:',
    publishNow: 'Publicar ahora',
    schedule: 'Programar',
    withdraw: 'Retirar',
    confirmPublish: '¿Publicar este elemento ahora?',
    confirmSchedule: '¿Programar este elemento?',
    confirmWithdraw: '¿Retirar este elemento? Los trabajadores dejan de verlo de inmediato.',
    confirm: 'Confirmar',
    cancel: 'Cancelar',
    startDate: 'Fecha de inicio',
    startTime: 'Hora de inicio',
    endDate: 'Fecha de fin (opcional)',
    endTime: 'Hora de fin (opcional)',
    dateHint: 'AAAA-MM-DD',
    timeHint: 'HH:MM, 24 horas',
    timeZoneNote: (zone) => `Las horas usan la zona horaria de este teléfono (${zone}).`,
    invalidDateTime: 'Escribe la fecha como AAAA-MM-DD y la hora como HH:MM.',
    published: 'Publicado.',
    scheduled: 'Programado.',
    withdrawn: 'Retirado.',
    provenanceHeading: 'Procedencia',
    provenanceIntro: 'Se registró al recuperar o importar este elemento. Revísala antes de confirmar derechos y fuentes.',
    historyHeading: 'Historial de revisiones',
    showHistory: 'Mostrar el historial de revisiones',
    hideHistory: 'Ocultar el historial de revisiones',
    historyEmpty: 'Todavía no hay revisiones registradas.',
    loadMoreHistory: 'Cargar revisiones anteriores',
    historyAction: (action) => historyAction('es', action),
    historyRevision: (revision) => `Revisión ${revision}`,
    historyByYou: 'Por ti',
    historyByOther: 'Por otra persona',
    historyByRemoved: 'Por una cuenta eliminada',
    discardTitle: '¿Descartar los cambios sin guardar?',
    discard: 'Descartar',
    keepEditing: 'Seguir editando',
    heldLoading: 'Cargando tu trabajo',
    heldStale: 'Este elemento cambió mientras no estabas. Tus cambios siguen aquí, pero se rechazará guardarlos: copia lo que necesites y vuelve a abrir el elemento desde la lista.',
    heldPolicyStale: 'Esta configuración cambió mientras no estabas. Tus elecciones siguen aquí, pero se rechazará guardarlas: vuelve a cargar la configuración actual y elige de nuevo.',
    heldUncertain: 'No pudimos confirmar que este borrador se guardó. Guardarlo de nuevo puede crear una segunda copia. Si lo descartas, búscalo en la lista de contenido antes de escribirlo de nuevo.',
    saveAgain: 'Guardar de nuevo',
    conflict: 'Este elemento cambió desde que lo abriste. Vuelve a la lista y ábrelo de nuevo.',
    notAuthorized: 'Tu rol actual no puede hacer este cambio.',
    invalid: 'El servidor rechazó estos valores. Revisa los campos e inténtalo de nuevo.',
    failed: 'No se pudo confirmar el cambio. Revisa tu conexión e inténtalo de nuevo.',
    issue: issueMessage(esFields, 'es'),
  },
};

export function learningCopy(locale: LearningLocale): LearningCopy {
  return learningContentCopy[locale];
}

export function learningActionDone(copy: LearningCopy, action: LearningTransition): string {
  return action === 'publish' ? copy.published : action === 'schedule' ? copy.scheduled : copy.withdrawn;
}
