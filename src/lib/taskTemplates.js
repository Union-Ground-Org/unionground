export const TASK_TEMPLATE_KEYS = Object.freeze([
  "meeting_event",
  "review_approval",
  "member_follow_up",
  "document_request",
  "issue_incident",
]);

const localized = (en, es) => ({ en, es });
const field = (key, kind, required, en, es, options = [], helpEn = "", helpEs = "") => ({
  key, kind, required, label: localized(en, es), help: localized(helpEn, helpEs), options,
});
const step = (key, en, es, predecessorKeys, recommendedStatus, terminal = false) => ({
  key, label: localized(en, es), predecessorKeys, recommendedStatus, terminal,
});
const checklist = (en, es) => ({ label: localized(en, es) });

export const DEMO_TASK_TEMPLATES = Object.freeze([
  {
    key: "meeting_event",
    label: localized("Meeting or Event", "Reunión o evento"),
    description: localized(
      "Plan a chapter meeting or event without storing venue or participant details.",
      "Planifica una reunión o evento del capítulo sin guardar detalles del lugar ni de participantes.",
    ),
    defaultStatus: "to_do",
    defaultPriority: "medium",
    fields: [
      field("scheduled_on", "date", true, "Scheduled date", "Fecha programada"),
      field("starts_at", "time", false, "Start time", "Hora de inicio", [], "Use the chapter local time.", "Usa la hora local del capítulo."),
      field("ends_at", "time", false, "End time", "Hora de finalización", [], "Must be after the start time.", "Debe ser posterior a la hora de inicio."),
      field("venue_mode", "enum", true, "Venue mode", "Modalidad", ["in_person", "phone", "video", "hybrid"], "Keep exact venue and joining details in an authorized link.", "Guarda el lugar exacto y los datos de acceso en un enlace autorizado."),
    ],
    flow: [
      step("planning", "Planning", "Planificación", [], "to_do"),
      step("confirmed", "Confirmed", "Confirmado", ["planning"], "to_do"),
      step("held", "Held", "Realizado", ["confirmed"], "in_progress"),
      step("follow_up", "Follow-up", "Seguimiento", ["held"], "needs_review"),
      step("complete", "Complete", "Completo", ["follow_up"], "done", true),
    ],
    checklist: [
      checklist("Confirm time and mode", "Confirmar hora y modalidad"),
      checklist("Prepare the agenda", "Preparar la agenda"),
      checklist("Notify participants through an authorized channel", "Notificar a participantes por un canal autorizado"),
      checklist("Record follow-up work", "Registrar el trabajo de seguimiento"),
    ],
  },
  {
    key: "review_approval",
    label: localized("Review or Approval", "Revisión o aprobación"),
    description: localized(
      "Route an authorized record for review and record only its operational stage.",
      "Envía un registro autorizado a revisión y guarda solo su etapa operativa.",
    ),
    defaultStatus: "needs_review",
    defaultPriority: "medium",
    fields: [
      field("review_kind", "enum", true, "Review kind", "Tipo de revisión", ["document", "publication", "decision", "other"]),
      field("reviewer_id", "member", false, "Reviewer", "Persona revisora", [], "Optional same-chapter staff reviewer.", "Personal revisor opcional del mismo capítulo."),
    ],
    flow: [
      step("prepare", "Prepare", "Preparar", [], "to_do"),
      step("in_review", "In review", "En revisión", ["prepare", "changes_requested"], "needs_review"),
      step("changes_requested", "Changes requested", "Cambios solicitados", ["in_review"], "in_progress"),
      step("approved", "Approved", "Aprobado", ["in_review", "changes_requested"], "done", true),
      step("declined", "Declined", "Rechazado", ["in_review", "changes_requested"], "done", true),
    ],
    checklist: [
      checklist("Gather authorized materials", "Reunir materiales autorizados"),
      checklist("Route the review", "Enviar a revisión"),
      checklist("Record the decision in the authorized source", "Registrar la decisión en la fuente autorizada"),
      checklist("Communicate the outcome", "Comunicar el resultado"),
    ],
  },
  {
    key: "member_follow_up",
    label: localized("Worker follow-up", "Seguimiento de trabajador"),
    description: localized(
      "Schedule a follow-up while keeping worker identity in its authorized source.",
      "Programa un seguimiento y conserva la identidad del trabajador en su fuente autorizada.",
    ),
    defaultStatus: "to_do",
    defaultPriority: "medium",
    fields: [
      field("contact_method", "enum", true, "Contact method", "Método de contacto", ["phone", "email", "in_person", "message", "other"]),
      field("follow_up_on", "date", true, "Follow-up date", "Fecha de seguimiento"),
    ],
    flow: [
      step("prepare", "Prepare", "Preparar", [], "to_do"),
      step("contact", "Contact", "Contactar", ["prepare"], "in_progress"),
      step("await_response", "Await response", "Esperar respuesta", ["contact"], "in_progress"),
      step("resolve", "Resolve", "Resolver", ["await_response"], "done", true),
    ],
    checklist: [
      checklist("Contact the worker through an authorized channel", "Contactar al trabajador por un canal autorizado"),
      checklist("Record the outcome in the authorized source", "Registrar el resultado en la fuente autorizada"),
      checklist("Schedule the next step if needed", "Programar el próximo paso si es necesario"),
    ],
  },
  {
    key: "document_request",
    label: localized("Document Request", "Solicitud de documento"),
    description: localized(
      "Track a request while keeping document content in an authorized record.",
      "Da seguimiento a una solicitud y conserva el contenido en un registro autorizado.",
    ),
    defaultStatus: "to_do",
    defaultPriority: "medium",
    fields: [
      field("record_category", "enum", true, "Record category", "Categoría del registro", ["workplace_record", "policy", "correspondence", "other"]),
      field("record_source", "enum", true, "Record source", "Fuente del registro", ["member", "employer", "union", "third_party"]),
    ],
    flow: [
      step("prepare", "Prepare", "Preparar", [], "to_do"),
      step("requested", "Requested", "Solicitado", ["prepare"], "in_progress"),
      step("acknowledged", "Acknowledged", "Acusado", ["requested"], "in_progress"),
      step("received", "Received", "Recibido", ["acknowledged"], "needs_review"),
      step("unavailable", "Unavailable", "No disponible", ["acknowledged"], "needs_review"),
      step("complete", "Complete", "Completo", ["received", "unavailable"], "done", true),
    ],
    checklist: [
      checklist("Define the request in the authorized source", "Definir la solicitud en la fuente autorizada"),
      checklist("Send the request", "Enviar la solicitud"),
      checklist("Record the receipt or unavailable response", "Registrar la recepción o respuesta no disponible"),
      checklist("Link the authorized record", "Enlazar el registro autorizado"),
    ],
  },
  {
    key: "issue_incident",
    label: localized("Issue or Incident", "Problema o incidente"),
    description: localized(
      "Coordinate an operational response without copying an incident narrative.",
      "Coordina una respuesta operativa sin copiar la narración del incidente.",
    ),
    defaultStatus: "to_do",
    defaultPriority: "high",
    fields: [
      field("occurred_on", "date", true, "Occurrence date", "Fecha del incidente"),
      field("incident_severity", "enum", true, "Operational severity", "Gravedad operativa", ["low", "medium", "high", "urgent"], "Do not enter an incident narrative here.", "No escribas aquí una narración del incidente."),
    ],
    flow: [
      step("triage", "Triage", "Evaluar", [], "to_do"),
      step("act", "Act", "Actuar", ["triage"], "in_progress"),
      step("monitor", "Monitor", "Monitorear", ["act"], "needs_review"),
      step("resolve", "Resolve", "Resolver", ["monitor"], "done", true),
    ],
    checklist: [
      checklist("Address immediate safety", "Atender la seguridad inmediata"),
      checklist("Document the issue in the authorized source", "Documentar el problema en la fuente autorizada"),
      checklist("Assign the response", "Asignar la respuesta"),
      checklist("Follow up and record resolution", "Dar seguimiento y registrar la resolución"),
    ],
  },
]);

function templateFor(templateOrKey, catalog = DEMO_TASK_TEMPLATES) {
  if (templateOrKey && typeof templateOrKey === "object") return templateOrKey;
  return catalog.find((template) => template.key === templateOrKey) || null;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validTime(value) {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const [hours, minutes] = value.split(":").map(Number);
  return hours <= 23 && minutes <= 59;
}

export function validateTaskTemplateValues(templateOrKey, values, catalog = DEMO_TASK_TEMPLATES) {
  const template = templateFor(templateOrKey, catalog);
  const errors = {};
  if (!template) return { valid: false, errors: { template: "Template unavailable" } };
  const allowed = new Map(template.fields.map((item) => [item.key, item]));
  for (const key of Object.keys(values || {})) {
    if (!allowed.has(key)) errors[key] = "Field is not allowed";
  }
  for (const item of template.fields) {
    const raw = values?.[item.key];
    const value = typeof raw === "string" ? raw.trim() : raw;
    if (item.required && (value == null || value === "")) {
      errors[item.key] = "Required";
      continue;
    }
    if (value == null || value === "") continue;
    if (typeof value !== "string") errors[item.key] = "Invalid value";
    else if (item.kind === "date" && !validDate(value)) errors[item.key] = "Use YYYY-MM-DD";
    else if (item.kind === "time" && !validTime(value)) errors[item.key] = "Use HH:MM";
    else if (item.kind === "enum" && !item.options.includes(value)) errors[item.key] = "Choose a listed option";
    else if (item.kind === "member" && !/^[0-9a-f-]{36}$/i.test(value)) errors[item.key] = "Choose a chapter member";
  }
  if (template.key === "meeting_event" && values?.ends_at) {
    if (!values?.starts_at || values.ends_at <= values.starts_at) errors.ends_at = "End time must follow start time";
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

export function templateFieldsToPayload(templateOrKey, values, catalog = DEMO_TASK_TEMPLATES) {
  const template = templateFor(templateOrKey, catalog);
  if (!template) return {};
  return Object.fromEntries(template.fields.flatMap((item) => {
    if (!Object.hasOwn(values || {}, item.key)) return [];
    const raw = values[item.key];
    if (raw === undefined) return [];
    const value = typeof raw === "string" ? raw.trim() : raw;
    // Missing means unchanged to the update RPC; an explicit null clears it.
    return [[item.key, !item.required && (value === null || value === "") ? null : value]];
  }));
}

export function checklistDescription(template, lang = "en") {
  return (template?.checklist || []).map((item) => `- [ ] ${item.label?.[lang] || item.label?.en || ""}`).join("\n");
}

export function recommendedStatusForStep(template, stepKey) {
  return template?.flow?.find((item) => item.key === stepKey)?.recommendedStatus || null;
}

export function nextTemplateSteps(template, currentStep) {
  return (template?.flow || []).filter((item) => item.predecessorKeys?.includes(currentStep));
}

function taskTemplateTimeFromDetails(value) {
  const storedTime = /^(?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d)(?:\.\d+)?$/.exec(value);
  return storedTime ? value.slice(0, 5) : value;
}

export function taskTemplateValuesFromDetails(details) {
  if (!details) return {};
  return {
    scheduled_on: details.scheduledOn,
    starts_at: taskTemplateTimeFromDetails(details.startsAt),
    ends_at: taskTemplateTimeFromDetails(details.endsAt),
    venue_mode: details.venueMode,
    review_kind: details.reviewKind,
    reviewer_id: details.reviewerId,
    contact_method: details.contactMethod,
    follow_up_on: details.followUpOn,
    record_category: details.recordCategory,
    record_source: details.recordSource,
    occurred_on: details.occurredOn,
    incident_severity: details.incidentSeverity,
  };
}

export function taskTemplateDetailsFromValues(templateKey, values) {
  return {
    scheduledOn: values.scheduled_on ?? null,
    startsAt: values.starts_at ?? null,
    endsAt: values.ends_at ?? null,
    venueMode: values.venue_mode ?? null,
    reviewKind: values.review_kind ?? null,
    reviewerId: values.reviewer_id ?? null,
    contactMethod: values.contact_method ?? null,
    followUpOn: values.follow_up_on ?? null,
    recordCategory: values.record_category ?? null,
    recordSource: values.record_source ?? null,
    occurredOn: values.occurred_on ?? null,
    incidentSeverity: values.incident_severity ?? null,
    templateKey,
  };
}
