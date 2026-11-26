// Forms P4b (GAP-401/402) — the 7 member form templates as versioned client
// data. A single schema-driven editor (FormsView) renders any of these; the
// backend stores answers as an opaque jsonb. Every labelKey/titleKey/blurbKey
// is an i18n key present in both en and es (see the "forms (P4b)" block in
// i18n.js). Field type ∈ {text,textarea,date,select,radio,checkbox,multiselect,
// number}; options = [{value, labelKey}].
//
// PRECEDENCE (full-depth PR2): the DB `form_templates` registry is the
// authoritative template source when rows load — resolveFormTemplates() maps
// them into this same shape. This static array is the offline/demo/empty-fetch
// FALLBACK only, and its data must stay byte-for-byte as seeded (the registry
// seed and its tests were generated from it).

// The two FMLA templates ask the identical "continuous or intermittent"
// question and carry the identical dates step — they were byte-identical
// copies, so a wording or option change to one silently diverged from the
// other. These builders keep the pair in lockstep AND hand each template a
// FRESH structure: this array must stay byte-for-byte in sync with the
// form_templates registry seed, and a shared object reference is how an edit
// meant for one template would turn up in the other's serialisation.
// (A plain constant spread would still share the nested options/fields arrays,
// which is why these are builders rather than `{ ...LEAVE_DATES_STEP }`.)
const conditionTypeField = () => ({
  key: "condition_type",
  type: "radio",
  labelKey: "forms.f.conditionType",
  required: true,
  options: [
    { value: "continuous", labelKey: "forms.opt.continuous" },
    { value: "intermittent", labelKey: "forms.opt.intermittent" },
  ],
});

// FIX-UG-FMLA-FORMS-GINA-NOTICE-AND-NO-DIAGNOSIS-HINT-20261022: the two
// FMLA templates (and any organization's own copy under the same key) show the
// GINA Title II safe-harbor notice of 29 CFR 1635.8(b)(1)(i)(B) and a
// no-diagnosis hint before their first step's fields. The notice is keyed by
// template key, not stored in field_schema, so an admin edit cannot drop it.
export const HEALTH_NOTICE_TEMPLATE_KEYS = Object.freeze(["fmla_self", "fmla_family"]);
export const GINA_NOTICE_KEY = "forms.notice.gina";
export const NO_DIAGNOSIS_HINT_KEY = "forms.hint.noDiagnosis";
export function healthNoticeKeys(template) {
  return HEALTH_NOTICE_TEMPLATE_KEYS.includes(template?.key) ? [GINA_NOTICE_KEY, NO_DIAGNOSIS_HINT_KEY] : [];
}

const leaveDatesStep = () => ({
  titleKey: "forms.step.dates",
  fields: [
    { key: "start_date", type: "date", labelKey: "forms.f.startDate", required: true },
    { key: "end_date", type: "date", labelKey: "forms.f.endDate", required: true },
  ],
});

// No "articles cited" field: Union Ground issues come before any contract,
// so the issue reports never ask for a contract article.
// REQ-UG-FORMS-DISCARD-DRAFT-AND-TEMPLATE-SIGNATURE-20261111: the
// filer's drawn signature is decided by the template, mirroring
// private.form_template_requires_signature. Signed statements (grievances,
// appeals, FMLA leave, alternative work) and any organization-made key keep it
// required; a template listed here is not a signed statement and asks for none.
export const SIGNATURE_OPTIONAL_TEMPLATE_KEYS = Object.freeze(["service_request"]);

export function templateRequiresSignature(templateKey) {
  return !SIGNATURE_OPTIONAL_TEMPLATE_KEYS.includes(templateKey);
}

export const FORM_TEMPLATES = [
  {
    key: "grievance",
    icon: "⚖",
    titleKey: "forms.tpl.grievance",
    blurbKey: "forms.blurb.grievance",
    steps: [
      {
        titleKey: "forms.step.what",
        fields: [
          { key: "summary", type: "text", labelKey: "forms.f.summary", required: true, maxLength: 200 },
          { key: "incident_date", type: "date", labelKey: "forms.f.incidentDate", required: true },
        ],
      },
      {
        titleKey: "forms.step.detail",
        fields: [
          { key: "narrative", type: "textarea", labelKey: "forms.f.narrative", required: true, maxLength: 4000 },
          { key: "remedy", type: "textarea", labelKey: "forms.f.remedy", required: true, maxLength: 2000 },
          { key: "witnesses", type: "textarea", labelKey: "forms.f.witnesses", required: false, maxLength: 1000 },
        ],
      },
    ],
  },
  {
    key: "fmla_self",
    icon: "🏥",
    titleKey: "forms.tpl.fmla_self",
    blurbKey: "forms.blurb.fmla_self",
    steps: [
      {
        titleKey: "forms.step.reason",
        fields: [
          { key: "reason", type: "textarea", labelKey: "forms.f.leaveNeed", required: true, maxLength: 2000 },
          conditionTypeField(),
        ],
      },
      leaveDatesStep(),
      {
        titleKey: "forms.step.provider",
        fields: [
          { key: "provider", type: "text", labelKey: "forms.f.provider", required: false, maxLength: 200 },
          { key: "notes", type: "textarea", labelKey: "forms.f.notes", required: false, maxLength: 1000 },
        ],
      },
    ],
  },
  {
    key: "fmla_family",
    icon: "👪",
    titleKey: "forms.tpl.fmla_family",
    blurbKey: "forms.blurb.fmla_family",
    steps: [
      {
        titleKey: "forms.step.who",
        fields: [
          {
            key: "relationship",
            type: "select",
            labelKey: "forms.f.relationship",
            required: true,
            options: [
              { value: "spouse", labelKey: "forms.opt.rel_spouse" },
              { value: "child", labelKey: "forms.opt.rel_child" },
              { value: "parent", labelKey: "forms.opt.rel_parent" },
              { value: "other", labelKey: "forms.opt.rel_other" },
            ],
          },
          { key: "family_member", type: "text", labelKey: "forms.f.familyMemberInitials", required: true, maxLength: 40 },
        ],
      },
      {
        titleKey: "forms.step.reason",
        fields: [
          { key: "reason", type: "textarea", labelKey: "forms.f.leaveNeed", required: true, maxLength: 2000 },
          conditionTypeField(),
        ],
      },
      leaveDatesStep(),
    ],
  },
  {
    key: "alliance_grievance",
    icon: "🤝",
    titleKey: "forms.tpl.alliance_grievance",
    blurbKey: "forms.blurb.alliance_grievance",
    steps: [
      {
        titleKey: "forms.step.what",
        fields: [
          { key: "summary", type: "text", labelKey: "forms.f.sharedIssue", required: true, maxLength: 200 },
          { key: "incident_date", type: "date", labelKey: "forms.f.incidentDate", required: true },
        ],
      },
      {
        titleKey: "forms.step.detail",
        fields: [
          { key: "narrative", type: "textarea", labelKey: "forms.f.narrative", required: true, maxLength: 4000 },
          { key: "affected", type: "textarea", labelKey: "forms.f.affected", required: true, maxLength: 2000 },
          { key: "remedy", type: "textarea", labelKey: "forms.f.remedy", required: true, maxLength: 2000 },
        ],
      },
    ],
  },
  {
    key: "non_selection",
    icon: "📄",
    titleKey: "forms.tpl.non_selection",
    blurbKey: "forms.blurb.non_selection",
    steps: [
      {
        titleKey: "forms.step.posting",
        fields: [
          { key: "posting", type: "text", labelKey: "forms.f.posting", required: true, maxLength: 200 },
          { key: "applied_date", type: "date", labelKey: "forms.f.appliedDate", required: true },
          { key: "notified_date", type: "date", labelKey: "forms.f.notifiedDate", required: true },
        ],
      },
      {
        titleKey: "forms.step.grounds",
        fields: [
          { key: "grounds", type: "textarea", labelKey: "forms.f.grounds", required: true, maxLength: 4000 },
        ],
      },
    ],
  },
  {
    key: "alt_work",
    icon: "🗓",
    titleKey: "forms.tpl.alt_work",
    blurbKey: "forms.blurb.alt_work",
    steps: [
      {
        titleKey: "forms.step.current",
        fields: [
          { key: "schedule", type: "text", labelKey: "forms.f.currentSchedule", required: false, maxLength: 200 },
          { key: "requested", type: "text", labelKey: "forms.f.requested", required: true, maxLength: 200 },
          {
            key: "telework_days",
            type: "multiselect",
            labelKey: "forms.f.teleworkDays",
            required: false,
            options: [
              { value: "mon", labelKey: "forms.opt.mon" },
              { value: "tue", labelKey: "forms.opt.tue" },
              { value: "wed", labelKey: "forms.opt.wed" },
              { value: "thu", labelKey: "forms.opt.thu" },
              { value: "fri", labelKey: "forms.opt.fri" },
            ],
          },
        ],
      },
      {
        titleKey: "forms.step.why",
        fields: [
          { key: "reason", type: "textarea", labelKey: "forms.f.reason", required: true, maxLength: 2000 },
          { key: "duration", type: "text", labelKey: "forms.f.duration", required: false, maxLength: 120 },
        ],
      },
    ],
  },
  {
    key: "service_request",
    icon: "🧰",
    titleKey: "forms.tpl.service_request",
    blurbKey: "forms.blurb.service_request",
    steps: [
      {
        titleKey: "forms.step.request",
        fields: [
          {
            key: "category",
            type: "select",
            labelKey: "forms.f.category",
            required: true,
            options: [
              { value: "benefits", labelKey: "forms.opt.cat_benefits" },
              { value: "training", labelKey: "forms.opt.cat_training" },
              { value: "other", labelKey: "forms.opt.cat_other" },
            ],
          },
          { key: "description", type: "textarea", labelKey: "forms.f.description", required: true, maxLength: 4000 },
        ],
      },
    ],
  },
];

export function templateByKey(key) {
  return FORM_TEMPLATES.find((template) => template.key === key);
}

// Maps a form_templates DB row into the exact in-memory shape FieldControl /
// FormsView already consume, by putting the ALREADY-RESOLVED plain string for
// the requested language into the titleKey/labelKey/blurbKey slots.
//
// This deliberately relies on t()'s verbatim fallback: t(lang, someString)
// returns the input unchanged when it is not a real catalogue key (pinned by
// tests/i18n.test.js). Do NOT "fix" that fallback to escape or throw — DB
// templates render through it with zero changes to the views.
// Junk tolerance: rows are admin-authored, and this runs synchronously inside
// loadMemberApp — one malformed row must degrade to empty strings / no
// options, never throw and take down the whole member load.
const pickLang = (pair, lang) => {
  if (pair == null) return "";
  if (typeof pair === "string") return pair;
  if (typeof pair !== "object") return String(pair);
  const primary = lang === "es" ? pair.es : pair.en;
  const value = typeof primary === "string" && primary !== "" ? primary : pair.en;
  return typeof value === "string" ? value : "";
};

const asArray = (value) => (Array.isArray(value) ? value : []);

const AUTOFILL_HINTS = ["employer", "worksite", "unit", "jobTitle", "shift", "classification", "chapter"];

export function templateFromDbRow(row, lang = "en") {
  return {
    key: row.key,
    version: row.version,
    icon: row.icon || "📄",
    titleKey: pickLang({ en: row.label_en, es: row.label_es }, lang),
    blurbKey: pickLang({ en: row.blurb_en, es: row.blurb_es }, lang),
    source: "db",
    steps: asArray(row.field_schema?.steps).map((step) => ({
      titleKey: pickLang(step?.title, lang),
      fields: asArray(step?.fields).map((field) => ({
        key: field.key,
        type: field.type,
        labelKey: pickLang(field.label, lang),
        required: Boolean(field.required),
        ...(field.maxLength != null ? { maxLength: field.maxLength } : {}),
        // REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030: an explicit
        // profile autofill hint the organization set on the field.
        ...(AUTOFILL_HINTS.includes(field.autofill) ? { autofill: field.autofill } : {}),
        ...(Array.isArray(field.options)
          ? { options: field.options.map((opt) => ({ value: opt?.value, labelKey: pickLang(opt?.label, lang) })) }
          : {}),
      })),
    })),
  };
}

// DB rows win when present; the static array is the offline/demo fallback.
// An organization's own row for a key outranks a platform seed of any version,
// so a newer platform seed (FIX-UNIONGROUND-FMLA-FORMS-GINA-NOTICE-AND-NO-
// DIAGNOSIS-HINT-20261022) never replaces a template the organization edited
// or turned off; within one kind the highest version wins.
const ownedByOrganization = (row) => row.is_platform_seed === false && row.organization_id != null;
// Ascending precedence: the last row of a key sorted by this is its current one.
export function compareTemplateRowPrecedence(a, b) {
  return Number(ownedByOrganization(a)) - Number(ownedByOrganization(b)) || Number(a.version) - Number(b.version);
}
export function currentFormTemplateRows(rows) {
  const latest = new Map();
  for (const row of rows) {
    if (row.available_to_start === false) continue;
    const current = latest.get(row.key);
    if (!current || compareTemplateRowPrecedence(row, current) > 0) latest.set(row.key, row);
  }
  // A Map keeps the first version's slot; order by the selected version's own sort.
  const rank = (row) => (row.sort == null ? Number.POSITIVE_INFINITY : Number(row.sort));
  return [...latest.values()].sort((a, b) => rank(a) - rank(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function resolveFormTemplates(dbRows, lang = "en", { loaded = false } = {}) {
  if (!Array.isArray(dbRows) || dbRows.length === 0) return loaded ? [] : FORM_TEMPLATES;
  return dbRows.map((row) => templateFromDbRow(row, lang));
}

// BUG-UG-SERVICE-REQUEST-DUES-CATEGORY-WITHOUT-DUES-20261108: an
// organization that runs no dues (dues === false, organizationRunsDues via
// duesNavigation.js) is offered no Dues choice, and the service request's
// default description stops naming dues. A description the organization wrote
// itself is kept. Only fresh choices change: a form already filed under the
// Dues category renders from its pinned template version.
const DEFAULT_SERVICE_REQUEST_BLURBS = new Set([
  "forms.blurb.service_request",
  "Ask the chapter for help with dues, benefits, or training.",
  "Pide ayuda al capítulo con cuotas, beneficios o capacitación.",
]);

export function formTemplatesForDues(templates, dues = true) {
  if (dues !== false) return templates;
  return templates.map((template) => ({
    ...template,
    blurbKey: template.key === "service_request" && DEFAULT_SERVICE_REQUEST_BLURBS.has(template.blurbKey)
      ? "forms.blurb.service_request"
      : template.blurbKey,
    steps: template.steps.map((step) => ({
      ...step,
      fields: step.fields.map((field) => (Array.isArray(field.options)
        ? { ...field, options: field.options.filter((option) => option.value !== "dues") }
        : field)),
    })),
  }));
}

// A required field counts as answered when it has a truthy, non-empty value
// (a non-empty array for multiselect; a trimmed non-empty string otherwise).
// pct = answered-required / total-required; nextFieldKey = first unanswered
// required field, or null when the form is complete.
export function formProgress(template, answers = {}) {
  const required = template.steps.flatMap((step) => step.fields).filter((field) => field.required);
  const isFilled = (field) => {
    const value = answers[field.key];
    if (Array.isArray(value)) return value.length > 0;
    return value != null && String(value).trim() !== "";
  };
  const done = required.filter(isFilled).length;
  const next = required.find((field) => !isFilled(field));
  return {
    pct: required.length ? Math.round((done / required.length) * 100) : 100,
    nextFieldKey: next ? next.key : null,
  };
}
