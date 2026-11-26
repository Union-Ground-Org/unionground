import {
  isAutomationCapabilityAvailable,
  normalizeAutomationCapabilities,
  validateAutomationDefinitionSpec,
} from "./capabilities.js";

const text = (en, es) => ({ en, es });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export const AUTOMATION_RECIPE_GROUPS = freeze([
  { id: "tasks", label: text("Tasks", "Tareas") },
  { id: "casework", label: text("Casework", "Gestión de casos") },
  { id: "appointments", label: text("Appointments", "Citas") },
  { id: "events", label: text("Events", "Eventos") },
]);

const SOURCES = {
  tasks: text("Existing tasks in the selected organization", "Tareas existentes de la organización seleccionada"),
  casework: text("Existing cases and recorded casework deadlines or checklists", "Casos existentes y sus plazos o listas de verificación registrados"),
  appointments: text("Existing appointments in the selected organization", "Citas existentes de la organización seleccionada"),
  events: text("Existing, non-cancelled events in the selected organization", "Eventos existentes y no cancelados de la organización seleccionada"),
};

const ACTIONS = {
  create_standard_task: text("Create a linked review task", "Crear una tarea de revisión vinculada"),
  assign_task: text("Assign the existing task to a chosen person", "Asignar la tarea existente a una persona elegida"),
  raise_task_priority: text("Raise the existing task's priority", "Aumentar la prioridad de la tarea existente"),
  notify_in_app: text("Send a generic in-app notice to a chosen person", "Enviar un aviso genérico dentro de la aplicación a una persona elegida"),
};

const DESTINATIONS = {
  create_standard_task: text("The source's authorized chapter task board", "El tablero de tareas del capítulo autorizado del registro de origen"),
  assign_task: text("The existing task; choose an authorized assignee before saving", "La tarea existente; elige una persona autorizada antes de guardar"),
  raise_task_priority: text("The existing task; no duplicate task is created", "La tarea existente; no se crea una tarea duplicada"),
  notify_in_app: text("The selected recipient's in-app inbox; choose a recipient before saving", "La bandeja de entrada de la persona seleccionada; elige un destinatario antes de guardar"),
};

const SAFETY = {
  tasks: text(
    "Choosing this recipe only opens an unsaved draft. Review scope and preview matches before activation. Automation-created tasks are excluded to prevent loops; completed tasks are not reopened.",
    "Elegir esta receta solo abre un borrador sin guardar. Revisa el alcance y las coincidencias antes de activar. Se excluyen las tareas creadas por automatización para evitar ciclos; no se reabren tareas completadas.",
  ),
  casework: text(
    "Choosing this recipe only opens an unsaved draft. It uses recorded dates and checklist state; it does not calculate legal deadlines, change a case or copy confidential case details into tasks.",
    "Elegir esta receta solo abre un borrador sin guardar. Usa fechas y estados de listas ya registrados; no calcula plazos legales, cambia casos ni copia detalles confidenciales en tareas.",
  ),
  appointments: text(
    "Choosing this recipe only opens an unsaved draft. Staff review the next step. It does not book, cancel or reschedule appointments, or send appointment reminders to members.",
    "Elegir esta receta solo abre un borrador sin guardar. El personal revisa el siguiente paso. No reserva, cancela ni reprograma citas, ni envía recordatorios a miembros.",
  ),
  events: text(
    "Choosing this recipe only opens an unsaved draft. It does not RSVP, check anyone in, award points, invite attendees or expose attendance details. Cancelled events are excluded.",
    "Elegir esta receta solo abre un borrador sin guardar. No confirma asistencia, registra participantes, otorga puntos, invita asistentes ni expone datos de asistencia. Se excluyen eventos cancelados.",
  ),
};

function recipe({ id, group, title, description, outcome, conditionSummary, triggerKind,
  thresholdDays = 0, conditions = {}, actionKind = "create_standard_task", actionConfig = {} }) {
  const prerequisites = [
    {
      key: "authorized_source",
      label: text("An authorized, chapter-scoped source record in this organization", "Un registro de origen autorizado y vinculado a un capítulo de esta organización"),
    },
    {
      key: "installed_capability",
      label: text("The installed trigger and action must support this recipe", "El disparador y la acción instalados deben admitir esta receta"),
    },
    {
      key: "execution_controls",
      label: text("Execution requires an active definition and the master switch; scheduled execution also requires the scheduler. Selecting or saving a draft enables none of these.", "La ejecución requiere una definición activa y el interruptor general; la ejecución programada también requiere el programador. Elegir o guardar un borrador no activa ninguno de estos controles."),
    },
  ];
  if (actionKind === "assign_task") prerequisites.push({
    key: "assigneeId", label: text("Choose an authorized assignee", "Elige una persona autorizada para la asignación"),
  });
  if (actionKind === "notify_in_app") prerequisites.push({
    key: "recipientId", label: text("Choose an authorized in-app recipient; no email or SMS delivery", "Elige un destinatario autorizado dentro de la aplicación; no se envían correos ni SMS"),
  });
  return {
    id, group, title, description, outcome, conditionSummary,
    source: SOURCES[group], action: ACTIONS[actionKind], destination: DESTINATIONS[actionKind],
    prerequisites, safety: SAFETY[group],
    draft: {
      schemaVersion: 2, triggerKind, thresholdDays, cadence: "daily", taskPriority: "medium",
      conditions, actionKind, actionConfig,
    },
  };
}

// Each entry changes a real predicate or action, not just a label, cadence or priority.
// These are draft specifications, never saved definitions or activation commands.
export const AUTOMATION_RECIPES = freeze([
  recipe({
    id: "overdue-task-review", group: "tasks", triggerKind: "overdue_task", thresholdDays: 1,
    title: text("Review overdue work", "Revisar trabajo vencido"),
    description: text("Create a separate review task when unfinished work has passed its due date.", "Crea una tarea de revisión cuando un trabajo sin terminar supera su fecha límite."),
    outcome: text("A linked review task keeps the original work intact.", "Una tarea de revisión vinculada conserva intacto el trabajo original."),
    conditionSummary: text("Open, non-automation tasks overdue by at least 1 day.", "Tareas abiertas, no creadas por automatización, vencidas desde hace al menos 1 día."),
  }),
  recipe({
    id: "overdue-task-escalation", group: "tasks", triggerKind: "overdue_task", thresholdDays: 1,
    actionKind: "raise_task_priority", actionConfig: { priority: "high" },
    title: text("Escalate overdue work", "Elevar la prioridad del trabajo vencido"),
    description: text("Move overdue work up the existing queue instead of creating a review task.", "Da más prioridad al trabajo vencido en su cola actual en vez de crear una tarea de revisión."),
    outcome: text("The original task is raised to high priority only when that increases its priority.", "La tarea original pasa a prioridad alta solo si eso aumenta su prioridad."),
    conditionSummary: text("Open tasks overdue by at least 1 day and below high priority.", "Tareas abiertas vencidas desde hace al menos 1 día y con prioridad inferior a alta."),
  }),
  recipe({
    id: "upcoming-task-planning", group: "tasks", triggerKind: "task_due", thresholdDays: 3,
    title: text("Plan work due soon", "Planificar trabajo próximo a vencer"),
    description: text("Prepare a review task before an approaching task deadline becomes overdue.", "Prepara una tarea de revisión antes de que venza un plazo próximo."),
    outcome: text("A linked preparation task helps staff plan the next few days.", "Una tarea de preparación vinculada ayuda al personal a planificar los próximos días."),
    conditionSummary: text("Open tasks due within the next 3 days, not already overdue.", "Tareas abiertas que vencen en los próximos 3 días y aún no están vencidas."),
  }),
  recipe({
    id: "upcoming-task-priority", group: "tasks", triggerKind: "task_due", thresholdDays: 3,
    actionKind: "raise_task_priority", actionConfig: { priority: "high" },
    title: text("Prioritize approaching deadlines", "Priorizar plazos próximos"),
    description: text("Increase the priority of imminent work directly on its existing task.", "Aumenta la prioridad del trabajo próximo a vencer directamente en su tarea existente."),
    outcome: text("The source task moves to high priority without a duplicate task.", "La tarea de origen pasa a prioridad alta sin crear una tarea duplicada."),
    conditionSummary: text("Open tasks due within 3 days and below high priority.", "Tareas abiertas que vencen en 3 días y tienen prioridad inferior a alta."),
  }),
  recipe({
    id: "blocked-task-unblocking", group: "tasks", triggerKind: "blocked_task",
    title: text("Organize help for blocked work", "Organizar ayuda para trabajo bloqueado"),
    description: text("Create an actionable review item for a task marked as blocked.", "Crea una tarea de revisión para un trabajo marcado como bloqueado."),
    outcome: text("A linked task gives the team a place to coordinate removing the blocker.", "Una tarea vinculada permite al equipo coordinar la resolución del bloqueo."),
    conditionSummary: text("Open tasks with the blocked flag set.", "Tareas abiertas con la marca de bloqueo activada."),
  }),
  recipe({
    id: "blocked-task-notice", group: "tasks", triggerKind: "blocked_task", actionKind: "notify_in_app",
    title: text("Notify someone about a blocker", "Avisar a alguien de un bloqueo"),
    description: text("Send a chosen person an in-app notice to review blocked work.", "Envía a una persona elegida un aviso dentro de la aplicación para revisar trabajo bloqueado."),
    outcome: text("The chosen recipient receives a generic notice, not confidential task text.", "La persona elegida recibe un aviso genérico, no el texto confidencial de la tarea."),
    conditionSummary: text("Open tasks with the blocked flag set.", "Tareas abiertas con la marca de bloqueo activada."),
  }),
  recipe({
    id: "unassigned-task-triage", group: "tasks", triggerKind: "unassigned_task",
    title: text("Review tasks without an owner", "Revisar tareas sin responsable"),
    description: text("Create a review queue for work that has not yet been assigned.", "Crea una cola de revisión para trabajo que aún no se ha asignado."),
    outcome: text("Staff can review a linked task before deciding who should own the work.", "El personal puede revisar una tarea vinculada antes de decidir quién debe encargarse."),
    conditionSummary: text("Open tasks with no assignee.", "Tareas abiertas sin una persona asignada."),
  }),
  recipe({
    id: "unassigned-task-routing", group: "tasks", triggerKind: "unassigned_task", actionKind: "assign_task",
    title: text("Route unassigned tasks", "Asignar tareas sin responsable"),
    description: text("Assign eligible unowned tasks to one explicitly chosen, authorized person.", "Asigna tareas elegibles sin responsable a una persona autorizada elegida explícitamente."),
    outcome: text("The existing task receives an assignee; an assignment made in the meantime is not overwritten.", "La tarea existente recibe una persona asignada; no se reemplaza una asignación realizada mientras tanto."),
    conditionSummary: text("Open tasks that still have no assignee when the action runs.", "Tareas abiertas que siguen sin persona asignada al ejecutarse la acción."),
  }),
  recipe({
    id: "stale-task-review", group: "tasks", triggerKind: "stale_task", thresholdDays: 7,
    title: text("Review stalled work", "Revisar trabajo estancado"),
    description: text("Create a review task when open work has gone a week without an update.", "Crea una tarea de revisión cuando un trabajo abierto lleva una semana sin actualizarse."),
    outcome: text("A linked review item makes forgotten work visible without changing its status.", "Una tarea de revisión vinculada hace visible el trabajo olvidado sin cambiar su estado."),
    conditionSummary: text("Open tasks last updated at least 7 days ago.", "Tareas abiertas cuya última actualización fue hace al menos 7 días."),
  }),
  recipe({
    id: "stale-task-notice", group: "tasks", triggerKind: "stale_task", thresholdDays: 7, actionKind: "notify_in_app",
    title: text("Ask someone to review stalled work", "Avisar sobre trabajo estancado"),
    description: text("Notify a chosen person about work that has not been updated recently.", "Avisa a una persona elegida sobre trabajo que no se ha actualizado recientemente."),
    outcome: text("A generic in-app notice prompts a check-in without creating more tasks.", "Un aviso genérico dentro de la aplicación invita a revisar el trabajo sin crear más tareas."),
    conditionSummary: text("Open tasks last updated at least 7 days ago.", "Tareas abiertas cuya última actualización fue hace al menos 7 días."),
  }),
  recipe({
    id: "task-review-queue", group: "tasks", triggerKind: "review_task",
    title: text("Build a review queue", "Crear una cola de revisión"),
    description: text("Create a linked review task when work enters the needs-review state.", "Crea una tarea de revisión vinculada cuando un trabajo pasa al estado de revisión pendiente."),
    outcome: text("A separate review task tracks the review without approving or completing the source.", "Una tarea separada permite seguir la revisión sin aprobar ni completar el trabajo de origen."),
    conditionSummary: text("Open tasks whose status is needs_review.", "Tareas abiertas cuyo estado es needs_review (revisión pendiente)."),
  }),
  recipe({
    id: "task-review-notice", group: "tasks", triggerKind: "review_task", actionKind: "notify_in_app",
    title: text("Notify a reviewer", "Avisar a una persona revisora"),
    description: text("Let a chosen person know that a task is waiting for review.", "Avisa a una persona elegida de que una tarea espera revisión."),
    outcome: text("The reviewer receives a generic in-app notice; no approval is submitted.", "La persona revisora recibe un aviso genérico dentro de la aplicación; no se registra ninguna aprobación."),
    conditionSummary: text("Open tasks whose status is needs_review.", "Tareas abiertas cuyo estado es needs_review (revisión pendiente)."),
  }),
  recipe({
    id: "legacy-case-deadline-review", group: "casework", triggerKind: "case_deadline", thresholdDays: 7,
    title: text("Review a case's recorded deadline", "Revisar el plazo registrado de un caso"),
    description: text("Keep using the original case deadline field while detailed deadlines are managed separately.", "Sigue usando el campo de plazo original del caso mientras los plazos detallados se gestionan por separado."),
    outcome: text("A generic linked task requests review of the existing case deadline.", "Una tarea genérica vinculada solicita revisar el plazo existente del caso."),
    conditionSummary: text("Active cases whose original recorded deadline is overdue or due within 7 days.", "Casos activos cuyo plazo original registrado ya venció o vence dentro de 7 días."),
  }),
  recipe({
    id: "unassigned-case-review", group: "casework", triggerKind: "unassigned_case",
    title: text("Review cases without an owner", "Revisar casos sin responsable"),
    description: text("Create a staff review item for active cases that have not been assigned.", "Crea una tarea de revisión para el personal cuando un caso activo aún no está asignado."),
    outcome: text("A linked task requests triage; the case is not automatically assigned or changed.", "Una tarea vinculada solicita una revisión inicial; el caso no se asigna ni cambia automáticamente."),
    conditionSummary: text("Active cases with neither a steward nor a coordinator assigned.", "Casos activos sin una persona delegada ni una persona coordinadora asignada."),
  }),
  recipe({
    id: "stale-member-contact-follow-up", group: "casework", triggerKind: "stale_member_contact", thresholdDays: 14,
    title: text("Follow up when a member's contact goes quiet", "Dar seguimiento cuando el contacto con un miembro se detiene"),
    description: text("Keep members with an active case from going quiet between case steps.", "Evita que los miembros con un caso activo queden sin contacto entre los pasos del caso."),
    outcome: text("One generic follow-up task per member; no member name or case detail is copied into the task.", "Una tarea genérica de seguimiento por miembro; no se copia el nombre del miembro ni detalles del caso en la tarea."),
    conditionSummary: text("Members with an active case and no recorded contact, contact note or contact-log entry within 14 days.", "Miembros con un caso activo y sin contacto, nota de contacto ni registro de contacto en los últimos 14 días."),
  }),
  ...[
    ["filing", text("Prepare for a filing deadline", "Preparar un plazo de presentación"), text("Review required filing preparation using the date already recorded by staff.", "Revisa la preparación de una presentación usando la fecha ya registrada por el personal.")],
    ["response", text("Prepare a case response", "Preparar una respuesta del caso"), text("Bring recorded response deadlines into the staff preparation queue.", "Incorpora los plazos de respuesta registrados a la cola de preparación del personal.")],
    ["hearing", text("Prepare for a hearing", "Preparar una audiencia"), text("Queue staff preparation for a recorded hearing deadline without exposing case details.", "Pon en cola la preparación del personal para un plazo de audiencia registrado sin exponer detalles del caso.")],
    ["appeal", text("Review appeal preparation", "Revisar la preparación de una apelación"), text("Request review of a recorded appeal deadline without calculating or changing legal dates.", "Solicita revisar un plazo de apelación registrado sin calcular ni cambiar fechas legales.")],
    ["follow_up", text("Keep a case follow-up on track", "Dar seguimiento a un caso"), text("Turn a recorded case follow-up deadline into a concrete staff review task.", "Convierte un plazo registrado de seguimiento del caso en una tarea concreta de revisión para el personal.")],
  ].map(([deadlineKind, title, description]) => recipe({
    id: `casework-${deadlineKind.replaceAll("_", "-")}-preparation`, group: "casework",
    triggerKind: "casework_deadline", thresholdDays: 7, conditions: { deadlineKind, status: "active" },
    title, description,
    outcome: text("A linked preparation task refers staff to the original deadline record.", "Una tarea de preparación vinculada dirige al personal al registro original del plazo."),
    conditionSummary: text(`Active ${deadlineKind.replaceAll("_", "-")} deadlines overdue or due within 7 days.`, `Plazos activos del tipo ${({ filing: "presentación", response: "respuesta", hearing: "audiencia", appeal: "apelación", follow_up: "seguimiento" })[deadlineKind]} ya vencidos o que vencen dentro de 7 días.`),
  })),
  recipe({
    id: "required-case-checklist-review", group: "casework", triggerKind: "incomplete_case_checklist",
    title: text("Review unfinished required case steps", "Revisar pasos obligatorios pendientes del caso"),
    description: text("Surface required checklist items that staff have not completed.", "Destaca los elementos obligatorios de una lista de verificación que el personal aún no ha completado."),
    outcome: text("A linked review task points to the checklist; it never marks an item complete.", "Una tarea de revisión vinculada remite a la lista; nunca marca un elemento como completado."),
    conditionSummary: text("Cases with at least one required, incomplete checklist item.", "Casos con al menos un elemento obligatorio pendiente en su lista de verificación."),
  }),
  recipe({
    id: "appointment-preparation", group: "appointments", triggerKind: "appointment_upcoming", thresholdDays: 2,
    title: text("Prepare for an upcoming appointment", "Preparar una cita próxima"),
    description: text("Give staff a preparation task before a confirmed appointment starts.", "Proporciona al personal una tarea de preparación antes de que comience una cita confirmada."),
    outcome: text("A generic task supports staff preparation without duplicating member reminders.", "Una tarea genérica ayuda al personal a prepararse sin duplicar recordatorios para miembros."),
    conditionSummary: text("Confirmed appointments starting within the next 2 days.", "Citas confirmadas que comienzan en los próximos 2 días."),
  }),
  recipe({
    id: "completed-appointment-follow-up", group: "appointments", triggerKind: "appointment_followup", thresholdDays: 7,
    conditions: { status: "completed" },
    title: text("Follow up after a completed appointment", "Dar seguimiento a una cita completada"),
    description: text("Create a staff follow-up task after an appointment is recorded as completed.", "Crea una tarea de seguimiento para el personal después de que una cita se registre como completada."),
    outcome: text("Staff review next steps; no appointment notes are copied into the task.", "El personal revisa los siguientes pasos; no se copian notas de la cita en la tarea."),
    conditionSummary: text("Completed appointments that ended within the past 7 days.", "Citas completadas que terminaron en los últimos 7 días."),
  }),
  recipe({
    id: "missed-appointment-review", group: "appointments", triggerKind: "appointment_followup", thresholdDays: 7,
    conditions: { status: "no_show" },
    title: text("Review a missed appointment", "Revisar una cita a la que no se asistió"),
    description: text("Queue a staff review after a no-show, leaving any outreach or rebooking to a person.", "Pon en cola una revisión del personal tras una inasistencia; una persona decide si contactar o reservar otra cita."),
    outcome: text("A linked task requests a human decision without rescheduling or contacting anyone.", "Una tarea vinculada solicita una decisión humana sin reprogramar ni contactar a nadie."),
    conditionSummary: text("Appointments marked no_show that ended within the past 7 days.", "Citas marcadas no_show (inasistencia) que terminaron en los últimos 7 días."),
  }),
  recipe({
    id: "event-preparation", group: "events", triggerKind: "event_upcoming", thresholdDays: 7,
    title: text("Prepare for an upcoming event", "Preparar un evento próximo"),
    description: text("Create a staff preparation task ahead of a scheduled event.", "Crea una tarea de preparación para el personal antes de un evento programado."),
    outcome: text("A linked task keeps event preparation on the chapter's work board.", "Una tarea vinculada mantiene la preparación del evento en el tablero de trabajo del capítulo."),
    conditionSummary: text("Non-cancelled events starting within the next 7 days.", "Eventos no cancelados que comienzan en los próximos 7 días."),
  }),
  recipe({
    id: "event-preparation-notice", group: "events", triggerKind: "event_upcoming", thresholdDays: 7, actionKind: "notify_in_app",
    title: text("Notify an event coordinator", "Avisar a una persona coordinadora del evento"),
    description: text("Prompt a chosen person to review an approaching event inside the application.", "Invita a una persona elegida a revisar un evento próximo dentro de la aplicación."),
    outcome: text("A generic in-app notice points to the event without inviting attendees.", "Un aviso genérico dentro de la aplicación remite al evento sin invitar asistentes."),
    conditionSummary: text("Non-cancelled events starting within the next 7 days.", "Eventos no cancelados que comienzan en los próximos 7 días."),
  }),
  recipe({
    id: "event-follow-up", group: "events", triggerKind: "event_followup", thresholdDays: 7,
    title: text("Review a recently started event", "Revisar un evento iniciado recientemente"),
    description: text("Create a staff task after an event's recorded start. Staff decide when follow-up is appropriate; the system does not know whether the event has ended.", "Crea una tarea después del inicio registrado de un evento. El personal decide cuándo corresponde dar seguimiento; el sistema no sabe si el evento ha terminado."),
    outcome: text("A linked follow-up task does not change attendance, points or event records.", "Una tarea vinculada de seguimiento no cambia la asistencia, los puntos ni los registros del evento."),
    conditionSummary: text("Non-cancelled events whose recorded start was within the past 7 days.", "Eventos no cancelados cuyo inicio registrado fue en los últimos 7 días."),
  }),
  recipe({
    id: "event-follow-up-notice", group: "events", triggerKind: "event_followup", thresholdDays: 7, actionKind: "notify_in_app",
    title: text("Prompt a recent-event review", "Proponer revisar un evento reciente"),
    description: text("Notify a chosen person after an event's recorded start without adding a task. This does not confirm that the event has ended.", "Avisa a una persona elegida después del inicio registrado de un evento sin añadir una tarea. Esto no confirma que el evento haya terminado."),
    outcome: text("A generic in-app notice prompts a review without revealing attendee details.", "Un aviso genérico dentro de la aplicación propone una revisión sin revelar datos de asistentes."),
    conditionSummary: text("Non-cancelled events whose recorded start was within the past 7 days.", "Eventos no cancelados cuyo inicio registrado fue en los últimos 7 días."),
  }),
]);

const RECIPES_BY_ID = new Map(AUTOMATION_RECIPES.map((entry) => [entry.id, entry]));

export function getAutomationRecipe(id) {
  return typeof id === "string" ? RECIPES_BY_ID.get(id) ?? null : null;
}

function searchText(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const SEARCH_INDEX = new Map(AUTOMATION_RECIPES.map((entry) => [entry.id, searchText([
  entry.id, entry.group,
  ...[entry.title, entry.description, entry.outcome, entry.conditionSummary, entry.source, entry.action,
    entry.destination, ...entry.prerequisites.map((item) => item.label)].flatMap((item) => [item.en, item.es]),
].join(" "))]));

/** Search both languages regardless of display locale; an unknown group returns no matches. */
export function searchAutomationRecipes({ query = "", group = "all", page = 1, pageSize = 6 } = {}) {
  const size = Number.isSafeInteger(pageSize) ? Math.max(1, Math.min(pageSize, 12)) : 6;
  const tokens = searchText(typeof query === "string" ? query.slice(0, 200) : "").trim().split(/\s+/).filter(Boolean);
  const matches = AUTOMATION_RECIPES.filter((entry) => (group === "all" || entry.group === group)
    && tokens.every((token) => SEARCH_INDEX.get(entry.id).includes(token)));
  const pageCount = Math.ceil(matches.length / size);
  const currentPage = Number.isSafeInteger(page) ? Math.max(1, Math.min(page, pageCount || 1)) : 1;
  return {
    items: matches.slice((currentPage - 1) * size, currentPage * size),
    total: matches.length, page: currentPage, pageSize: size, pageCount,
  };
}

function canonicalRecipe(value) {
  return getAutomationRecipe(typeof value === "string" ? value : value?.id);
}

/** Setup is a draft action configuration, not an authorization grant. The server validates scope. */
export function getAutomationRecipeAvailability(value, capabilities, setup = {}) {
  const entry = canonicalRecipe(value);
  const installed = normalizeAutomationCapabilities(capabilities);
  if (!entry || installed?.schemaVersion !== 2
    || !isAutomationCapabilityAvailable(installed, entry.draft.triggerKind, entry.draft.actionKind)
    || !installed.cadences.includes(entry.draft.cadence)
    || installed.maxThresholdDays < entry.draft.thresholdDays) {
    return { status: "not_installed", missing: [] };
  }
  if (!validateAutomationDefinitionSpec({ name: entry.title.en, ...entry.draft }, { allowIncomplete: true }).ok) {
    return { status: "not_installed", missing: [] };
  }
  const required = entry.draft.actionKind === "assign_task" ? ["assigneeId"]
    : entry.draft.actionKind === "notify_in_app" ? ["recipientId"] : [];
  const missing = required.filter((key) => !UUID.test(setup?.[key] ?? entry.draft.actionConfig[key] ?? ""));
  return { status: missing.length ? "missing_setup" : "available", missing };
}

/** Pure, detached, unsaved state. Missing assignee/recipient remains empty for the guided editor. */
export function createAutomationRecipeDraft(id, { locale = "en", capabilities } = {}) {
  const entry = getAutomationRecipe(id);
  if (!entry) throw new Error("automation_recipe_unknown");
  if (getAutomationRecipeAvailability(entry, capabilities).status === "not_installed") {
    throw new Error("automation_recipe_not_installed");
  }
  return { name: entry.title[locale === "es" ? "es" : "en"], ...structuredClone(entry.draft) };
}
