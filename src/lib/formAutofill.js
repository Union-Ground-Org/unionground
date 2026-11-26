// REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030: a form offers to fill
// its workplace fields from what the member keeps and has shared.
//
// The values come from public.get_my_form_autofill, which answers for the
// caller alone and returns job title, worksite, shift and classification only
// while the member shares their work details with the organization; the
// chapter and the organization's employer are the member's own context. This
// file matches a form's fields to those kinds by the field's explicit
// `autofill` hint, its key or its visible label (English and Spanish), and
// never proposes a value for a field that already holds one.

export const AUTOFILL_KINDS = Object.freeze(["employer", "worksite", "unit", "jobTitle", "shift", "classification", "chapter"]);
export const AUTOFILL_PREFERENCES = Object.freeze(["ask", "always", "never"]);

// A unit inside a chapter is kept as the member's worksite (#6562), so a form's
// unit field fills from the worksite.
const VALUE_OF = { unit: "worksite" };

// Whole-word cues per kind, checked in this order so "job classification"
// is a classification and "work location" a worksite. Accents are folded
// before matching.
const CUES = [
  ["classification", ["classification", "job class", "pay grade", "clasificacion", "categoria laboral"]],
  ["jobTitle", ["job title", "jobtitle", "position title", "occupation", "puesto actual", "puesto de trabajo", "titulo del puesto", "ocupacion"]],
  ["shift", ["shift", "turno", "horario de trabajo"]],
  ["employer", ["employer", "company", "agency", "empleador", "empresa", "patron"]],
  ["unit", ["unit", "department", "unidad", "departamento"]],
  ["worksite", ["worksite", "work site", "work location", "workplace", "job site", "facility", "lugar de trabajo", "centro de trabajo", "sitio de trabajo"]],
  ["chapter", ["chapter", "union local", "local union", "capitulo", "seccion sindical"]],
];

function fold(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A field about someone or something other than the member's own current job
// (the vacancy being appealed, a witness, a supervisor, a former employer)
// is never filled from the member's profile.
const NOT_MINE = ["vacancy", "vacante", "posting", "applied", "solicitado", "solicitada", "witness", "testigo", "supervisor", "manager", "previous", "former", "anterior", "prior"];

// A shift start, end or hours field asks for a time, not the member's shift.
const NOT_SHIFT = ["time", "hour", "hours", "start", "end", "date", "hora", "horas", "fecha", "inicio", "fin"];

function hasCue(text, cue) {
  if (!text) return false;
  const folded = fold(cue);
  return new RegExp(`(^|[^a-z0-9])${folded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(text);
}

// The kind a field is, or null. An explicit hint wins; otherwise a field about
// someone else is excluded before the autocomplete token, the key (camelCase
// split) and then the label decide.
export function autofillKindOf({ key = "", name = "", label = "", autofill = null, autocomplete = "" } = {}) {
  if (AUTOFILL_KINDS.includes(autofill)) return autofill;
  const words = (value) => fold(String(value).replace(/([a-z])([A-Z])/g, "$1 $2"));
  const sources = [words(key), words(name), fold(label)];
  const any = (cues) => sources.some((source) => cues.some((cue) => hasCue(source, cue)));
  if (any(NOT_MINE)) return null;
  if (/^organization-title$/i.test(autocomplete)) return "jobTitle";
  if (/^organization$/i.test(autocomplete)) return "employer";
  const timed = any(NOT_SHIFT);
  for (const source of sources) {
    for (const [kind, cues] of CUES) if (!(kind === "shift" && timed) && cues.some((cue) => hasCue(source, cue))) return kind;
  }
  return null;
}

export function autofillValue(values, kind) {
  const value = values?.[VALUE_OF[kind] ?? kind];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// One proposed fill per matching empty field: { fieldKey, kind, value }.
// Each kind fills at most one field, the first that matches it.
export function autofillProposal(fields, values, current = {}) {
  const used = new Set();
  const proposal = [];
  for (const field of Array.isArray(fields) ? fields : []) {
    if (!field?.key) continue;
    const kind = autofillKindOf(field);
    if (!kind || used.has(kind)) continue;
    const value = autofillValue(values, kind);
    const existing = current?.[field.key];
    if (!value || (typeof existing === "string" ? existing.trim() : existing != null && existing !== "")) continue;
    used.add(kind);
    proposal.push({ fieldKey: field.key, kind, value });
  }
  return proposal;
}

// The text-like fields of a schema-driven form template, every step.
export function templateAutofillFields(template, t = (key) => key) {
  return (template?.steps || []).flatMap((step) => (step?.fields || [])
    .filter((field) => field?.key && (field.type === "text" || field.type === "textarea"))
    .map((field) => ({ key: field.key, label: t(field.labelKey), autofill: field.autofill ?? null })));
}

const FIELD_KEY = /^[A-Za-z0-9_]{1,80}$/;

// The accepted fields as { field key: kind }: well-formed keys, known kinds,
// one field per kind (the shape public.record_form_profile_autofill takes).
export function acceptedFields(value) {
  const accepted = {};
  const kinds = new Set();
  if (!value || typeof value !== "object" || Array.isArray(value)) return accepted;
  for (const [key, kind] of Object.entries(value)) {
    if (!FIELD_KEY.test(key) || !AUTOFILL_KINDS.includes(kind) || kinds.has(kind)) continue;
    accepted[key] = kind;
    kinds.add(kind);
  }
  return accepted;
}

// Field provenance for a reopened draft: each recorded field that is still
// on the form and still holds a value keeps its mark.
export function restoredProfileFilled(fields, recorded, answers = {}) {
  const keys = new Set((Array.isArray(fields) ? fields : []).map((field) => field?.key));
  return Object.fromEntries(Object.entries(acceptedFields(recorded)).filter(([key]) => {
    const value = answers?.[key];
    return keys.has(key) && typeof value === "string" && value.trim();
  }));
}

// A record that could not be written stays on this device until a later
// write succeeds, so a reopened draft still records it before submission.
const PENDING_PREFIX = "ug.forms.profileAutofillPending.";
export function pendingAutofillRecord(formId, storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(PENDING_PREFIX + formId) ?? "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? acceptedFields(parsed) : null;
  } catch {
    return null;
  }
}
export function rememberPendingAutofill(formId, fields, storage = globalThis.localStorage) {
  try {
    if (fields) storage?.setItem(PENDING_PREFIX + formId, JSON.stringify(acceptedFields(fields)));
    else storage?.removeItem(PENDING_PREFIX + formId);
  } catch {
    // Storage unavailable: the submit gate still records what this editor holds.
  }
}

export function shapeFormAutofill(data) {
  const values = data?.values && typeof data.values === "object" ? data.values : {};
  const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
  return {
    preference: AUTOFILL_PREFERENCES.includes(data?.preference) ? data.preference : "ask",
    shared: data?.shared === true,
    values: Object.fromEntries(["employer", "chapter", "jobTitle", "worksite", "shift", "classification"].map((key) => [key, text(values[key])])),
  };
}

function unwrap(result, label) {
  if (result?.error) throw Object.assign(new Error(`${label} failed`), { code: result.error.code ?? null, cause: result.error });
  return result?.data ?? null;
}

export async function loadFormAutofill(client) {
  return shapeFormAutofill(unwrap(await client.rpc("get_my_form_autofill"), "Form autofill"));
}

export async function saveFormAutofillPreference(client, preference) {
  if (!AUTOFILL_PREFERENCES.includes(preference)) throw new Error("invalid form autofill preference");
  return unwrap(await client.rpc("set_my_form_autofill_preference", { p_preference: preference }), "Form autofill preference");
}

// The fields recorded on one of the caller's forms, or null when they cannot
// be read (the RLS-scoped row is the member's own).
export async function loadRecordedAutofill(client, formId) {
  const { data, error } = await client.from("member_forms").select("profile_autofill").eq("id", formId).maybeSingle();
  const recorded = data?.profile_autofill;
  if (error || !recorded || typeof recorded !== "object" || Array.isArray(recorded)) return null;
  return acceptedFields(recorded);
}

export async function recordFormProfileAutofill(client, formId, fields) {
  return unwrap(await client.rpc("record_form_profile_autofill", { p_form_id: formId, p_fields: acceptedFields(fields) }), "Form autofill record");
}

export function createFormAutofillApi(client) {
  return {
    load: () => loadFormAutofill(client),
    savePreference: (preference) => saveFormAutofillPreference(client, preference),
    record: (formId, fields) => recordFormProfileAutofill(client, formId, fields),
    loadRecorded: (formId) => loadRecordedAutofill(client, formId),
  };
}
