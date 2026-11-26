// Isolated regression fixture for retired pre-bot behavior. Never imported by product code.
const STORAGE_KEY = "union-ground:sample:voice-parity:v1";

// Front-end acceptance map for the clean-room guide's domain-voice anchor.
// `backendReady` stays false until a later delivery proves persistence, RLS,
// audit, retries, and exact-head acceptance for the matching CR record.
export const DEMO_VOICE_CAPABILITIES = [
  {
    id: "CR-001",
    surface: "member",
    interaction: "quarterly-response-session",
    backendReady: false,
  },
  {
    id: "CR-002",
    surface: "member",
    interaction: "quarterly-completion-gate",
    backendReady: false,
  },
  {
    id: "CR-003",
    surface: "staff",
    interaction: "multi-question-builder",
    backendReady: false,
  },
  {
    id: "CR-004",
    surface: "staff",
    interaction: "question-type-editor",
    backendReady: false,
  },
  {
    id: "CR-005",
    surface: "both",
    interaction: "sections-and-conditional-branching",
    backendReady: false,
  },
  {
    id: "CR-006",
    surface: "staff",
    interaction: "owner-and-generated-review-work",
    backendReady: false,
  },
  {
    id: "CR-007",
    surface: "staff",
    interaction: "distribution-readiness-history-reminders",
    backendReady: false,
  },
  {
    id: "CR-008",
    surface: "staff",
    interaction: "response-review-lanes",
    backendReady: false,
  },
  {
    id: "CR-009",
    surface: "staff",
    interaction: "privacy-threshold-withholding",
    backendReady: false,
  },
  {
    id: "CR-010",
    surface: "staff",
    interaction: "reporting-and-local-exports",
    backendReady: false,
  },
  {
    id: "CR-011",
    surface: "member",
    interaction: "weekly-question-with-options",
    backendReady: false,
  },
  {
    id: "CR-012",
    surface: "member",
    interaction: "promotion-credit",
    backendReady: false,
  },
  {
    id: "CR-013",
    surface: "staff",
    interaction: "weekly-editorial-pool",
    backendReady: false,
  },
  {
    id: "CR-014",
    surface: "member",
    interaction: "contextual-micro-poll",
    backendReady: false,
  },
  {
    id: "CR-015",
    surface: "staff",
    interaction: "meeting-poll-lifecycle",
    backendReady: false,
  },
  {
    id: "CR-016",
    surface: "staff",
    interaction: "changing-live-results",
    backendReady: false,
  },
  {
    id: "CR-017",
    surface: "staff",
    interaction: "roster-rsvp-check-in",
    backendReady: false,
  },
  {
    id: "CR-018",
    surface: "member",
    interaction: "governed-searchable-qa",
    backendReady: false,
  },
  {
    id: "CR-019",
    surface: "staff",
    interaction: "compass-poll-draft-handoff",
    backendReady: false,
  },
];

const bilingual = (en, es) => ({ en, es });
const option = (value, en, es) => ({ value, label: bilingual(en, es) });

export const DEMO_SURVEY_QUESTIONS = [
  {
    id: "workload",
    section: "workload",
    type: "scale",
    prompt: bilingual(
      "How manageable is your workload this week?",
      "¿Qué tan manejable es tu carga de trabajo esta semana?",
    ),
    required: true,
  },
  {
    id: "staffing",
    section: "workload",
    type: "radio",
    prompt: bilingual(
      "Is your work area safely staffed?",
      "¿Tu área de trabajo tiene personal suficiente para operar con seguridad?",
    ),
    options: [
      option("yes", "Yes", "Sí"),
      option("sometimes", "Sometimes", "A veces"),
      option("no", "No", "No"),
    ],
    required: true,
  },
  {
    id: "unsafe-detail",
    section: "workload",
    type: "text",
    prompt: bilingual(
      "What would make staffing safer?",
      "¿Qué haría que la dotación de personal fuera más segura?",
    ),
    required: true,
    branch: { questionId: "staffing", values: ["no"] },
  },
  {
    id: "priorities",
    section: "priorities",
    type: "checkbox",
    prompt: bilingual(
      "Which issues should the chapter prioritize?",
      "¿Qué asuntos debería priorizar el capítulo?",
    ),
    options: [
      option("staffing", "Staffing", "Dotación de personal"),
      option("scheduling", "Scheduling", "Horarios"),
      option("pay", "Pay", "Salario"),
      option("safety", "Safety", "Seguridad"),
      option("training", "Training", "Capacitación"),
    ],
    required: true,
  },
  {
    id: "meeting",
    section: "priorities",
    type: "dropdown",
    prompt: bilingual(
      "Which meeting time works best?",
      "¿Qué horario de reunión te conviene más?",
    ),
    options: [
      option("before-work", "Before work", "Antes del trabajo"),
      option("lunch", "Lunch", "Almuerzo"),
      option("after-work", "After work", "Después del trabajo"),
      option("weekend", "Weekend", "Fin de semana"),
    ],
  },
  {
    id: "follow-up",
    section: "follow-up",
    type: "yesno",
    prompt: bilingual(
      "May a steward follow up with you privately?",
      "¿Puede un delegado comunicarse contigo en privado?",
    ),
    required: true,
  },
  {
    id: "note",
    section: "follow-up",
    type: "text",
    prompt: bilingual(
      "Anything else the chapter should know?",
      "¿Hay algo más que el capítulo deba saber?",
    ),
  },
];

export const DEMO_SURVEY_SECTIONS = ["workload", "priorities", "follow-up"];

const VOICE_LABELS = {
  workload: bilingual("Workload", "Carga de trabajo"),
  priorities: bilingual("Priorities", "Prioridades"),
  "follow-up": bilingual("Follow-up", "Seguimiento"),
  active: bilingual("Active", "Activa"),
  draft: bilingual("Draft", "Borrador"),
  scheduled: bilingual("Scheduled", "Programada"),
  live: bilingual("Live", "En vivo"),
  closed: bilingual("Closed", "Cerrada"),
  archived: bilingual("Archived", "Archivada"),
  quarterly: bilingual("Quarterly", "Trimestral"),
  general: bilingual("General", "General"),
  priority: bilingual("Priority", "Prioridad"),
  reserved: bilingual("Reserved", "Reservada"),
  pool: bilingual("Pool", "Banco"),
  published: bilingual("Published", "Publicada"),
  rejected: bilingual("Rejected", "Rechazada"),
  answered: bilingual("Answered", "Respondida"),
  open: bilingual("Open", "Abierta"),
  yes: bilingual("Yes", "Sí"),
  no: bilingual("No", "No"),
  maybe: bilingual("Maybe", "Quizás"),
  quarter: bilingual("This quarter", "Este trimestre"),
  year: bilingual("Rolling year", "Último año"),
  all: bilingual("All responses", "Todas las respuestas"),
};

export function voiceText(value, lang = "en") {
  if (typeof value === "string") return value;
  return value?.[lang] || value?.en || "";
}

// Identity and display stay separate: the reader's own authorship is a flag,
// never a display literal, so no English "You" can survive a lang="es"
// render and no label wording change can move the owner-gated controls.
export function viewerAuthor() {
  return { viewer: true };
}

export function voiceAuthoredByViewer(author) {
  if (author === "You") return true;
  return Boolean(author && typeof author === "object" && author.viewer === true);
}

export function voiceJoinedOptions(options, lang = "en") {
  return (Array.isArray(options) ? options : [])
    .map((option) => voiceText(option, lang))
    .join(" · ");
}

export function voiceAuthorName(author, lang = "en", viewerLabel = "You") {
  if (voiceAuthoredByViewer(author)) return viewerLabel;
  if (typeof author === "string") return author;
  return voiceText(author?.name, lang);
}

// Write the reader's edit back into a bilingual seed without flattening it:
// a bilingual value keeps its inactive language and updates the active one,
// so the edit form can pre-fill with (and save) plain resolved strings.
export function voiceEditedCopy(original, edited, lang = "en") {
  if (original && typeof original === "object") {
    return { ...original, [lang]: edited };
  }
  return edited;
}

export function voiceLabel(token, lang = "en") {
  return voiceText(VOICE_LABELS[token], lang) || token;
}

export function voiceOptionLabel(item, lang = "en") {
  return voiceText(item?.label, lang);
}

export function createDemoVoiceState() {
  return {
    quarterly: {
      id: "quarterly-2026-q3",
      title: bilingual(
        "Quarterly member check-in",
        "Chequeo trimestral de miembros",
      ),
      quarter: "Q3 2026",
      totalQuestions: 85,
      currentSection: 0,
      answers: {},
      completed: false,
      submittedAt: null,
    },
    microPoll: { status: "open", answer: null },
    promotionCredits: 1,
    weeklyQuestions: [
      {
        id: "weekly-1",
        body: bilingual(
          "Which shift needs a steward walk-through next?",
          "¿Qué turno necesita un recorrido del delegado a continuación?",
        ),
        options: [
          bilingual("Day", "Día"),
          bilingual("Evening", "Tarde"),
          bilingual("Overnight", "Noche"),
        ],
        state: "priority",
        score: 18,
        supported: false,
        promoted: false,
      },
      {
        id: "weekly-2",
        body: bilingual(
          "Should the chapter publish a monthly staffing snapshot?",
          "¿Debería el capítulo publicar un resumen mensual de dotación?",
        ),
        options: [
          bilingual("Yes", "Sí"),
          bilingual("No", "No"),
          bilingual("Discuss first", "Discutir primero"),
        ],
        state: "reserved",
        score: 11,
        supported: false,
        promoted: false,
      },
      {
        id: "weekly-3",
        body: bilingual(
          "What training would help new stewards most?",
          "¿Qué capacitación ayudaría más a los nuevos delegados?",
        ),
        options: [
          bilingual("Intake", "Recepción de casos"),
          bilingual("Investigations", "Investigaciones"),
          bilingual("Deadlines", "Plazos"),
        ],
        state: "pool",
        score: 7,
        supported: false,
        promoted: false,
      },
    ],
    qa: [
      {
        id: "qa-1",
        title: bilingual(
          "How do I document a denied break?",
          "¿Cómo documento un descanso denegado?",
        ),
        body: bilingual(
          "I want to keep a useful record without including private health information.",
          "Quiero llevar un registro útil sin incluir información privada de salud.",
        ),
        author: viewerAuthor(),
        votes: 14,
        voted: false,
        status: "answered",
        acceptedReplyId: "reply-1",
        replies: [
          {
            id: "reply-1",
            author: "Steward Sam",
            body: bilingual(
              "Record the date, scheduled break, who denied it, and any witnesses. Keep medical details in the private case channel.",
              "Anota la fecha, el descanso programado, quién lo denegó y cualquier testigo. Mantén los detalles médicos en el canal privado del caso.",
            ),
            votes: 9,
            voted: false,
          },
          {
            id: "reply-2",
            author: "Jordan Lee",
            body: bilingual(
              "I also save the posted schedule when it changes.",
              "También guardo el horario publicado cuando cambia.",
            ),
            votes: 4,
            voted: false,
          },
        ],
      },
      {
        id: "qa-2",
        title: bilingual(
          "Where can I find the overtime rotation?",
          "¿Dónde encuentro la rotación de horas extra?",
        ),
        body: bilingual(
          "Is there one current copy for the chapter?",
          "¿Hay una copia actual para el capítulo?",
        ),
        author: "Morgan Chen",
        votes: 8,
        voted: false,
        status: "open",
        acceptedReplyId: null,
        replies: [
          {
            id: "reply-3",
            author: viewerAuthor(),
            body: bilingual(
              "The latest copy is in Chapter hub under Workplace records.",
              "La copia más reciente está en el Hub del capítulo, bajo Registros laborales.",
            ),
            votes: 2,
            voted: false,
          },
        ],
      },
    ],
    surveys: [
      {
        id: "survey-quarterly",
        title: "Q3 member health and workplace conditions",
        kind: "quarterly",
        state: "active",
        owner: "Sam Okafor",
        questions: 85,
        sections: 8,
        responses: 238,
        rangeResponses: { quarter: 238, year: 276, all: 313 },
        audience: 313,
        threshold: 25,
        distributed: true,
        reminderCount: 1,
      },
      {
        id: "survey-scheduling",
        title: "Scheduling change follow-up",
        kind: "general",
        state: "draft",
        owner: "Taylor Brooks",
        questions: 6,
        sections: 2,
        responses: 0,
        rangeResponses: { quarter: 0, year: 0, all: 0 },
        audience: 96,
        threshold: 25,
        distributed: false,
        reminderCount: 0,
      },
    ],
    responseLanes: {
      first: [
        {
          id: "response-1",
          label: "Response 047",
          issue: "Unsafe staffing note",
          age: "12 min",
        },
      ],
      ready: [
        {
          id: "response-2",
          label: "Response 031",
          issue: "Schedule follow-up requested",
          age: "1 hr",
        },
      ],
      followup: [
        {
          id: "response-3",
          label: "Response 019",
          issue: "Steward contact assigned",
          age: "Yesterday",
        },
      ],
    },
    livePoll: {
      id: "live-1",
      title: "Extend the meeting by 15 minutes?",
      status: "scheduled",
      scheduledFor: "2026-08-27T18:00",
      secondsRemaining: 90,
      votes: [18, 7, 3],
      options: ["Yes", "No", "Abstain"],
      projector: false,
      roster: [
        { id: "person-1", name: "Avery Johnson", rsvp: "yes", checkedIn: true },
        { id: "person-2", name: "Jordan Lee", rsvp: "yes", checkedIn: false },
        {
          id: "person-3",
          name: "Morgan Chen",
          rsvp: "maybe",
          checkedIn: false,
        },
        { id: "person-4", name: "Riley Patel", rsvp: "yes", checkedIn: true },
      ],
    },
  };
}

export function readDemoVoiceState() {
  if (typeof window === "undefined") return createDemoVoiceState();
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : createDemoVoiceState();
  } catch {
    return createDemoVoiceState();
  }
}

export function writeDemoVoiceState(state) {
  if (typeof window === "undefined") return state;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* SAMPLE state may remain memory-only. */
  }
  window.dispatchEvent(
    new CustomEvent("union-ground:demo-voice-change", { detail: state }),
  );
  return state;
}

export function visibleSurveyQuestions(section, answers) {
  return DEMO_SURVEY_QUESTIONS.filter((question) => {
    if (question.section !== section) return false;
    if (!question.branch) return true;
    return question.branch.values.includes(answers[question.branch.questionId]);
  });
}

export function surveySectionComplete(section, answers) {
  return visibleSurveyQuestions(section, answers).every((question) => {
    if (!question.required) return true;
    const answer = answers[question.id];
    return Array.isArray(answer)
      ? answer.length > 0
      : String(answer ?? "").trim().length > 0;
  });
}

// The sample studio teaches the product's rule: no released group under 25
// (Lovable audit APP-STEWARD-07), so the minimum group size never goes below it.
export const VOICE_PRIVACY_FLOOR = 25;

export function clampPrivacyThreshold(value) {
  const number = Number(value);
  return Math.min(
    50,
    Math.max(VOICE_PRIVACY_FLOOR, Number.isFinite(number) && number > 0 ? number : VOICE_PRIVACY_FLOOR),
  );
}

export function reportSnapshot(survey, range = "quarter") {
  const responses = survey.rangeResponses?.[range] ?? survey.responses;
  const completionRate =
    survey.audience > 0 ? Math.round((responses / survey.audience) * 100) : 0;
  return { responses, audience: survey.audience, completionRate, range };
}

export function resultReadiness(survey, range = "quarter") {
  const snapshot = reportSnapshot(survey, range);
  const threshold = clampPrivacyThreshold(survey.threshold);
  const smallestGroup = snapshot.responses >= 27 ? 27 : snapshot.responses;
  return {
    ...snapshot,
    threshold,
    smallestGroup,
    ready: snapshot.responses >= threshold && smallestGroup >= threshold,
  };
}

export function prioritizeWeeklyQuestions(questions, selectedId) {
  return questions.map((question) => {
    if (question.id === selectedId) return { ...question, state: "priority" };
    return question.state === "priority"
      ? { ...question, state: "reserved" }
      : question;
  });
}

export function selectWeightedWeeklyQuestion(questions, random = Math.random) {
  const eligible = questions.filter(
    (item) => !["priority", "published", "rejected"].includes(item.state),
  );
  if (!eligible.length) return null;
  const total = eligible.reduce(
    (sum, item) => sum + Math.max(1, item.score),
    0,
  );
  let target = Math.min(0.999999, Math.max(0, random())) * total;
  for (const item of eligible) {
    target -= Math.max(1, item.score);
    if (target < 0) return item;
  }
  return eligible[eligible.length - 1];
}

export function exportVoiceReport(
  format,
  state,
  surveyId = state.surveys[0]?.id,
  range = "quarter",
) {
  const survey =
    state.surveys.find((item) => item.id === surveyId) || state.surveys[0];
  if (!survey) return "";
  // An export is a release too: a report still under the floor has none.
  if (!resultReadiness(survey, range).ready) return "";
  const snapshot = reportSnapshot(survey, range);
  const rows = [
    ["Survey", survey.title],
    ["Range", voiceLabel(range, "en")],
    ["Responses", snapshot.responses],
    ["Audience", snapshot.audience],
    ["Privacy threshold", clampPrivacyThreshold(survey.threshold)],
    ["Completion rate", `${snapshot.completionRate}%`],
  ];
  const separator = format === "xlsx" ? "\t" : ",";
  const text = rows
    .map((row) =>
      row
        .map((cell) => `"${String(cell).replaceAll('"', '""')}"`)
        .join(separator),
    )
    .join("\n");
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  )
    return text;
  const blob = new Blob([text], {
    type:
      format === "xlsx" ? "application/vnd.ms-excel" : "text/csv;charset=utf-8",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `member-voice-report.${format === "xlsx" ? "xls" : "csv"}`;
  link.click();
  URL.revokeObjectURL(link.href);
  return text;
}
