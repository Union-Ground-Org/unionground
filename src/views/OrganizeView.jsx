import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  FileText,
  Handshake,
  LockKeyhole,
  MapPin,
  Plus,
  Scale,
  ShieldAlert,
  Target,
  TrendingUp,
} from "lucide-react";
import { Dialog } from "../components/Dialogs.jsx";
import { RadioGroup } from "../components/RadioGroup.jsx";
import {
  BargainingWriterDialog,
  phaseChoices,
  proposalChoices,
} from "../components/BargainingWriterDialog.jsx";
import { EmptyState, ScreenHeader, SectionTitle, StatCard } from "../components/Primitives.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { localeFor } from "../lib/i18n.js";
import {
  CAMPAIGN_STAGE_LABELS,
  coveragePercent,
  netGrowth,
  safePercent,
  stageAgeDays,
  suppressSmall,
} from "../lib/lifecycleMetrics.js";

function transitionLabel(value, lang) {
  return value
    .split("_to_")
    .map((stage) => stageLabel(stage, lang))
    .join(" → ");
}

const COPY = {
  en: {
    eyebrow: "Union lifecycle",
    title: "Organizing operations",
    demo: "Fictional demonstration",
    private: "Restricted workspace",
    tabs: {
      campaigns: "Campaigns",
      worksites: "Worksites",
      resistance: "Resistance",
      bargaining: "Bargaining",
      engagement: "Engagement",
      coalitions: "Coalitions",
      impact: "Impact",
    },
    campaignPicker: "Campaign",
    campaignPickerSub: "Choose one lifecycle record. No worker roster loads here.",
    branchElection: "Election path",
    branchRecognition: "Voluntary-recognition path",
    branchUndecided: "Path not yet chosen",
    eligible: "Eligible estimate",
    contacted: "Contacted",
    committee: "Committee",
    stageAge: "Days in stage",
    lifecycle: "Recorded lifecycle",
    lifecycleSub: "Recorded stages only. Voluntary recognition and certification remain separate paths.",
    current: "Current",
    verified: "Recorded",
    nextAction: "Next accountable action",
    due: "Due",
    sourceBoundary: "This overview contains aggregate operations data. Worker names, contact details, support positions, and private narratives require separate authorization.",
    coverage: "Worksite coverage",
    coverageSub: "Map structure, not workers. Groups below the privacy threshold show “Not shown.”",
    people: "people",
    contactCoverage: "Contact coverage",
    committeeCoverage: "Committee coverage",
    noAreas: "No work areas recorded for this campaign.",
    resistance: "Reported employer conduct",
    resistanceSub: "Organizer working records of reported conduct and dates. The workspace does not decide lawfulness.",
    potential: "A possible unfair labor practice (ULP) means reported conduct may need legal review. “Consider review” is not a request or legal finding.",
    legalReview: "Legal-review status",
    sourceType: "Report source",
    responseUrgency: "Response urgency",
    evidence: "evidence items",
    workingDate: "Working date",
    noResistance: "No resistance reports recorded for this campaign.",
    resistanceRestricted: "Resistance details are restricted to assigned organizers, coordinators, and legal reviewers.",
    bargaining: "First-contract workspace",
    bargainingSub: "Priorities, proposals, sessions, tentative agreements, ratification, and execution.",
    surveyReturn: "Survey return",
    proposals: "Proposal register",
    sessions: "Bargaining sessions",
    noBargaining: "No bargaining workspace yet. Open one after recognition or certification.",
    openBargaining: "Open bargaining workspace",
    updatePhase: "Record next phase",
    rollbackPhase: "Return to the table",
    addProposal: "Add proposal version",
    updateProposal: "Update",
    scheduleSession: "Schedule session",
    recordSession: "Record outcome",
    recordRatification: "Record external result",
    correctRatification: "Correct current record",
    currentRatification: "Current sourced record",
    correctionReason: "Correction reason",
    recordContract: "Record executed contract",
    integrityHold: "Ratification authorization was corrected after execution. The executed record remains historical; use the governed escalation process before relying on this lifecycle status.",
    bargainingPhase: "Current phase",
    verificationBoundary: "Staff-recorded external aggregate. This bargaining record does not collect ballots or make a legal determination.",
    noProposals: "No proposal versions recorded.",
    noSessions: "No bargaining sessions recorded.",
    ratificationResults: "External ratification records",
    noRatification: "No external ratification result recorded.",
    firstContractRecord: "First-contract execution",
    noFirstContract: "No executed first-contract record.",
    signed: "Signed",
    effective: "Effective",
    expires: "Expires",
    onboarding: "30/90-day onboarding",
    onboardingSub: "Recorded milestones and voluntary commitments—not clicks or points.",
    day30: "Day 30 complete",
    day90: "Day 90 complete",
    membershipRetention: "12-month membership retention",
    engagementRetention: "12-month engagement retention",
    ladder: "Participation ladder",
    safeRecognition: "Eligible recognition",
    neverReward: "Never rewarded",
    coalition: "Chapter Handshakes",
    coalitionSub: "Shared interest, bridge lead, governance, commitments, actions, and confirmed outcomes.",
    bridgeLead: "Bridge lead",
    governance: "Governance",
    commitments: "Commitments",
    noCoalitions: "No coalition records yet.",
    impact: "Ten-year impact",
    impactSub: "Audited facts, explicit denominators, separate paths, and suppressed small cells.",
    campaigns10: "Campaign episodes",
    certified10: "Certified",
    contracts10: "First contracts",
    membershipFlow: "Membership flow",
    year: "Year",
    joined: "Joined",
    left: "Left",
    net: "Net",
    lifecycleConversion: "Lifecycle conversion",
    stageSpeed: "Median stage time",
    days: "days",
    suppressed: "Not shown",
    of: "of",
    committeeOfContacted: "Committee coverage of contacted",
    conversionSub: "Reached of eligible · immature campaigns excluded",
    stageSpeedSub: "Calendar-day median among verified completers",
    asOf: "As of",
    resolveHold: "Resolve integrity hold",
    resolveHoldEyebrow: "Governed resolution",
    resolveHoldTitle: "Resolve the ratification integrity hold",
    resolveHoldLead: "This clears the hold on the bargaining record. The corrected ratification and the executed contract both remain in the history; nothing is deleted.",
    resolveHoldNote: "Why the hold is being lifted",
    resolveHoldNoteHint: "Required. This note is the product's whole record of the resolution and is written to the lifecycle audit trail.",
    resolveHoldSubmit: "Record resolution",
    resolveHoldSaved: "Integrity hold resolved.",
    resolveHoldRecovered: "The hold was already resolved; its receipt was recovered.",
    method: "Method and limits",
    retry: "Try again",
    loading: "Loading lifecycle workspace…",
    selected: "Selected",
    createCampaign: "Create campaign",
    createEyebrow: "Restricted organizing record",
    createTitle: "Create an organizing campaign",
    campaignName: "Campaign name",
    employerName: "Employer name",
    worksiteName: "Primary worksite",
    proposedUnit: "Proposed bargaining unit",
    representationPath: "Representation path",
    undecidedPath: "Undecided",
    electionPath: "Election",
    recognitionPath: "Voluntary recognition",
    eligibleEstimateField: "Eligible estimate (optional)",
    createSubmit: "Create campaign",
    creating: "Creating…",
    created: "Campaign created.",
    recovered: "Existing campaign recovered from the prior request.",
    createdRefreshFailed: "Campaign saved, but the workspace could not refresh. Retry loading; do not create it again.",
    campaignStatus: "Campaign status",
    recordMilestone: "Record milestone",
    milestoneEyebrow: "Campaign record",
    milestoneTitle: "Record campaign milestone",
    milestoneChoice: "Milestone",
    milestoneNote: "Context note (optional)",
    milestonePrivacy: "Do not enter worker names, contact details, support positions, or private narratives.",
    milestoneSubmit: "Save milestone",
    manageStatus: "Manage status",
    statusEyebrow: "Campaign control",
    statusTitle: "Manage campaign status",
    statusAction: "Action",
    statusReason: "Reason or operating note",
    statusOutcome: "Closure outcome",
    statusPrivacy: "Do not enter worker names, contact details, support positions, or private narratives.",
    closureSummary: "Closure summary",
    closureOutcome: "Recorded outcome",
    closureReason: "Recorded reason",
    closureDate: "Closed",
    pause: "Pause",
    resume: "Resume",
    close: "Close permanently",
    statusCloseBoundary: "Established is recorded only after a sourced, fully signed first-contract record. It is not a manual closure outcome.",
    statusSubmit: "Update status",
    saving: "Saving…",
    milestoneSaved: "Campaign milestone saved.",
    milestoneRecovered: "Campaign milestone already saved; its receipt was recovered.",
    statusSaved: "Campaign status saved.",
    statusRecovered: "Campaign status already saved; its receipt was recovered.",
    changedReloaded: "This campaign changed. Latest data loaded; review your draft before trying again.",
    writerFailed: "The change could not be saved. Review the record and try again.",
    savedRefreshFailed: "Change saved. Do not repeat it. Reload the workspace before another change.",
    refreshFailed: "The workspace could not refresh.",
    reloadWorkspace: "Reload workspace",
    writersFrozen: "Writers are paused until the workspace reloads.",
    bargainingSaved: "Bargaining record saved.",
    bargainingRecovered: "The bargaining record was already saved; its receipt was recovered.",
  },
  es: {
    eyebrow: "Ciclo sindical",
    title: "Operaciones de organización",
    demo: "Demostración ficticia",
    private: "Espacio restringido",
    tabs: {
      campaigns: "Campañas",
      worksites: "Lugares",
      resistance: "Resistencia",
      bargaining: "Negociación",
      engagement: "Participación",
      coalitions: "Coaliciones",
      impact: "Impacto",
    },
    campaignPicker: "Campaña",
    campaignPickerSub: "Elige un registro. Aquí no se carga una lista de trabajadores.",
    branchElection: "Ruta electoral",
    branchRecognition: "Ruta de reconocimiento voluntario",
    branchUndecided: "Ruta aún no elegida",
    eligible: "Estimación elegible",
    contacted: "Contactados",
    committee: "Comité",
    stageAge: "Días en etapa",
    lifecycle: "Ciclo registrado",
    lifecycleSub: "Solo etapas registradas. El reconocimiento voluntario y la certificación siguen rutas separadas.",
    current: "Actual",
    verified: "Registrado",
    nextAction: "Próxima acción responsable",
    due: "Fecha",
    sourceBoundary: "Este resumen contiene datos agregados. Nombres, contactos, posiciones de apoyo y narrativas privadas requieren autorización separada.",
    coverage: "Cobertura del lugar",
    coverageSub: "Mapear la estructura, no a los trabajadores. Grupos pequeños muestran “No se muestra”.",
    people: "personas",
    contactCoverage: "Cobertura de contacto",
    committeeCoverage: "Cobertura del comité",
    noAreas: "No hay áreas registradas para esta campaña.",
    resistance: "Conducta patronal informada",
    resistanceSub: "Registros de trabajo sobre conducta informada y fechas. El sistema no decide su legalidad.",
    potential: "Una posible práctica laboral injusta (ULP, por sus siglas en inglés) indica que la conducta informada puede necesitar revisión legal. “Considerar revisión” no es una solicitud ni una conclusión legal.",
    legalReview: "Estado de revisión legal",
    sourceType: "Fuente del informe",
    responseUrgency: "Urgencia de respuesta",
    evidence: "elementos de evidencia",
    workingDate: "Fecha de trabajo",
    noResistance: "No hay informes de resistencia para esta campaña.",
    resistanceRestricted: "Los detalles están restringidos a organizadores asignados, coordinación y revisión legal.",
    bargaining: "Espacio del primer contrato",
    bargainingSub: "Prioridades, propuestas, sesiones, acuerdos tentativos, ratificación y ejecución.",
    surveyReturn: "Respuesta de encuesta",
    proposals: "Registro de propuestas",
    sessions: "Sesiones de negociación",
    noBargaining: "Todavía no hay un espacio de negociación.",
    openBargaining: "Abrir espacio de negociación",
    updatePhase: "Registrar próxima fase",
    rollbackPhase: "Volver a la mesa",
    addProposal: "Agregar versión de propuesta",
    updateProposal: "Actualizar",
    scheduleSession: "Programar sesión",
    recordSession: "Registrar resultado",
    recordRatification: "Registrar resultado externo",
    correctRatification: "Corregir registro vigente",
    currentRatification: "Registro vigente con fuente",
    correctionReason: "Motivo de corrección",
    recordContract: "Registrar contrato ejecutado",
    integrityHold: "La autorización de ratificación se corrigió después de la ejecución. El registro ejecutado permanece como historial; usa el proceso de escalamiento gobernado antes de depender de este estado.",
    bargainingPhase: "Fase actual",
    verificationBoundary: "Agregado externo registrado por el personal. Este registro de negociación no recopila boletas ni emite una conclusión legal.",
    noProposals: "No hay versiones de propuestas.",
    noSessions: "No hay sesiones de negociación.",
    ratificationResults: "Registros externos de ratificación",
    noRatification: "No hay resultado externo de ratificación.",
    firstContractRecord: "Ejecución del primer contrato",
    noFirstContract: "No hay registro de primer contrato ejecutado.",
    signed: "Firmado",
    effective: "Vigente",
    expires: "Vence",
    onboarding: "Orientación de 30/90 días",
    onboardingSub: "Hitos registrados y compromisos voluntarios, no clics ni puntos.",
    day30: "Día 30 completo",
    day90: "Día 90 completo",
    membershipRetention: "Retención sindical de 12 meses",
    engagementRetention: "Participación a los 12 meses",
    ladder: "Escalera de participación",
    safeRecognition: "Reconocimiento permitido",
    neverReward: "Nunca recompensado",
    coalition: "Acuerdos entre campañas",
    coalitionSub: "Interés compartido, enlace, gobernanza, compromisos, acciones y resultados.",
    bridgeLead: "Enlace",
    governance: "Gobernanza",
    commitments: "Compromisos",
    noCoalitions: "Todavía no hay registros de coalición.",
    impact: "Impacto de diez años",
    impactSub: "Hechos auditados, denominadores explícitos, rutas separadas y celdas pequeñas ocultas.",
    campaigns10: "Episodios de campaña",
    certified10: "Certificados",
    contracts10: "Primeros contratos",
    membershipFlow: "Flujo de membresía",
    year: "Año",
    joined: "Ingresaron",
    left: "Salieron",
    net: "Neto",
    lifecycleConversion: "Conversión del ciclo",
    stageSpeed: "Tiempo mediano",
    days: "días",
    suppressed: "No se muestra",
    of: "de",
    committeeOfContacted: "Cobertura del comité entre las contactadas",
    conversionSub: "Alcanzado sobre elegibles · se excluyen campañas inmaduras",
    stageSpeedSub: "Mediana de días naturales entre quienes completaron con verificación",
    asOf: "Al",
    resolveHold: "Resolver la retención de integridad",
    resolveHoldEyebrow: "Resolución gobernada",
    resolveHoldTitle: "Resolver la retención de integridad de la ratificación",
    resolveHoldLead: "Esto levanta la retención sobre el registro de negociación. La ratificación corregida y el contrato ejecutado permanecen en el historial; no se elimina nada.",
    resolveHoldNote: "Motivo para levantar la retención",
    resolveHoldNoteHint: "Obligatorio. Esta nota es todo el registro de la resolución en el producto y se escribe en la bitácora del ciclo.",
    resolveHoldSubmit: "Registrar resolución",
    resolveHoldSaved: "Retención de integridad resuelta.",
    resolveHoldRecovered: "La retención ya estaba resuelta; se recuperó su recibo.",
    method: "Método y límites",
    retry: "Intentar de nuevo",
    loading: "Cargando espacio del ciclo…",
    selected: "Seleccionada",
    createCampaign: "Crear campaña",
    createEyebrow: "Registro de organización restringido",
    createTitle: "Crear una campaña de organización",
    campaignName: "Nombre de la campaña",
    employerName: "Nombre del empleador",
    worksiteName: "Lugar de trabajo principal",
    proposedUnit: "Unidad de negociación propuesta",
    representationPath: "Ruta de representación",
    undecidedPath: "Sin decidir",
    electionPath: "Elección",
    recognitionPath: "Reconocimiento voluntario",
    eligibleEstimateField: "Estimación elegible (opcional)",
    createSubmit: "Crear campaña",
    creating: "Creando…",
    created: "Campaña creada.",
    recovered: "Se recuperó la campaña de la solicitud anterior.",
    createdRefreshFailed: "La campaña se guardó, pero el espacio no se pudo actualizar. Vuelve a cargarlo; no crees la campaña otra vez.",
    campaignStatus: "Estado de la campaña",
    recordMilestone: "Registrar hito",
    milestoneEyebrow: "Registro de campaña",
    milestoneTitle: "Registrar hito de campaña",
    milestoneChoice: "Hito",
    milestoneNote: "Nota de contexto (opcional)",
    milestonePrivacy: "No ingreses nombres, contactos, posiciones de apoyo ni narrativas privadas.",
    milestoneSubmit: "Guardar hito",
    manageStatus: "Administrar estado",
    statusEyebrow: "Control de campaña",
    statusTitle: "Administrar estado de campaña",
    statusAction: "Acción",
    statusReason: "Motivo o nota operativa",
    statusOutcome: "Resultado del cierre",
    statusPrivacy: "No ingreses nombres, contactos, posiciones de apoyo ni narrativas privadas.",
    closureSummary: "Resumen del cierre",
    closureOutcome: "Resultado registrado",
    closureReason: "Motivo registrado",
    closureDate: "Cerrada",
    pause: "Pausar",
    resume: "Reanudar",
    close: "Cerrar permanentemente",
    statusCloseBoundary: "Establecida se registra solo después de un registro con fuente de primer contrato totalmente firmado. No es un resultado de cierre manual.",
    statusSubmit: "Actualizar estado",
    saving: "Guardando…",
    milestoneSaved: "Hito de campaña guardado.",
    milestoneRecovered: "El hito ya estaba guardado; se recuperó su recibo.",
    statusSaved: "Estado de campaña guardado.",
    statusRecovered: "El estado ya estaba guardado; se recuperó su recibo.",
    changedReloaded: "Esta campaña cambió. Se cargaron los datos más recientes; revisa el borrador antes de intentar otra vez.",
    writerFailed: "No se pudo guardar el cambio. Revisa el registro e inténtalo otra vez.",
    savedRefreshFailed: "Cambio guardado. No lo repitas. Vuelve a cargar el espacio antes de otro cambio.",
    refreshFailed: "No se pudo actualizar el espacio.",
    reloadWorkspace: "Volver a cargar",
    writersFrozen: "Las acciones están pausadas hasta volver a cargar el espacio.",
    bargainingSaved: "Registro de negociación guardado.",
    bargainingRecovered: "El registro ya estaba guardado; se recuperó su recibo.",
  },
};

const TABS = ["campaigns", "worksites", "resistance", "bargaining", "engagement", "coalitions", "impact"];

const STAGE_LABELS = {
  en: CAMPAIGN_STAGE_LABELS,
  es: {
    lead: "Inicio",
    committee: "Comité",
    cards: "Tarjetas",
    petition: "Petición",
    election: "Elección",
    recognition: "Reconocimiento",
    certification: "Certificación",
    bargaining: "Negociación",
    first_contract: "Primer contrato",
    established: "Establecida",
    // stageLabel falls back to CAMPAIGN_STAGE_LABELS, which is English-only, so
    // these three reached a Spanish organizer untranslated — a campaign in a
    // terminal stage showed "Withdrawn"/"Lost"/"Paused". The parity guard in
    // tests/organize-view.test.jsx now holds this table to its English twin.
    paused: "Pausada",
    withdrawn: "Retirada",
    lost: "Perdida",
  },
};

const STATUS_LABELS = {
  en: { active: "Active", paused: "Paused", closed: "Closed" },
  es: { active: "Activa", paused: "Pausada", closed: "Cerrada" },
};

const OUTCOME_LABELS = {
  en: { withdrawn: "Withdrawn", lost: "Unsuccessful election", other: "Other" },
  es: { withdrawn: "Retirada", lost: "Elección no exitosa", other: "Otro" },
};

const RESISTANCE_CATEGORY_LABELS = {
  en: {
    surveillance: "Surveillance",
    interrogation: "Questioning",
    threat: "Threat",
    captive_audience: "Captive-audience meeting",
    retaliation: "Retaliation",
    discipline: "Discipline",
    discharge: "Discharge",
    delay: "Delay",
    unilateral_change: "Unilateral change",
    other: "Other",
  },
  es: {
    surveillance: "Vigilancia",
    interrogation: "Interrogatorio",
    threat: "Amenaza",
    captive_audience: "Reunión de audiencia cautiva",
    retaliation: "Represalia",
    discipline: "Disciplina",
    discharge: "Despido",
    delay: "Demora",
    unilateral_change: "Cambio unilateral",
    other: "Otro",
  },
};

const RESISTANCE_URGENCY_LABELS = {
  en: { monitor: "Monitor", standard: "Standard", high: "High", immediate: "Immediate" },
  es: { monitor: "Monitorear", standard: "Estándar", high: "Alta", immediate: "Inmediata" },
};

const RESISTANCE_SOURCE_LABELS = {
  en: {
    worker_report: "Worker report",
    steward_report: "Steward report",
    organizer_note: "Organizer note",
    bargaining_record: "Bargaining record",
    document: "Document",
    other: "Other",
  },
  es: {
    worker_report: "Informe de trabajador",
    steward_report: "Informe de representante",
    organizer_note: "Nota de organizador",
    bargaining_record: "Registro de negociación",
    document: "Documento",
    other: "Otro",
  },
};

const LEGAL_REVIEW_LABELS = {
  en: {
    not_requested: "Not requested",
    consider_review: "Consider review",
    requested: "Requested",
    under_review: "Under review",
    not_referred: "Not referred",
    referred: "Referred",
    triage: "Triage",
    reviewed: "Reviewed",
  },
  es: {
    not_requested: "No solicitada",
    consider_review: "Considerar revisión",
    requested: "Solicitada",
    under_review: "En revisión",
    not_referred: "No remitida",
    referred: "Remitida",
    triage: "Clasificación",
    reviewed: "Revisada",
  },
};

const BARGAINING_PHASE_LABELS = {
  en: {
    preparing: "Preparing",
    proposal_development: "Proposal development",
    at_table: "At the table",
    mediation: "Mediation",
    fact_finding: "Fact finding",
    impasse: "Impasse",
    tentative_agreement: "Tentative agreement",
    ratification: "Ratification",
    execution: "Execution",
    complete: "Complete",
  },
  es: {
    preparing: "Preparación",
    proposal_development: "Desarrollo de propuestas",
    at_table: "En la mesa",
    mediation: "Mediación",
    fact_finding: "Determinación de hechos",
    impasse: "Impasse",
    tentative_agreement: "Acuerdo tentativo",
    ratification: "Ratificación",
    execution: "Ejecución",
    complete: "Completo",
  },
};

const BARGAINING_STATUS_LABELS = {
  en: {
    draft: "Draft",
    approved: "Approved for presentation",
    presented: "Presented",
    countered: "Countered",
    tentative_agreement: "Tentative agreement",
    accepted: "Accepted",
    rejected: "Rejected",
    withdrawn: "Withdrawn",
    superseded: "Superseded",
    scheduled: "Scheduled",
    held: "Held",
    cancelled: "Cancelled",
    rescheduled: "Rescheduled",
    no_quorum: "No quorum",
    indeterminate: "Needs reconciliation",
    suppressed: "Suppressed for privacy",
    corrected: "Corrected",
    not_required: "Sourced as not required",
    source_recorded_fully_signed: "Source recorded as fully signed",
    integrity_hold: "Integrity hold",
  },
  es: {
    draft: "Borrador",
    approved: "Aprobada para presentar",
    presented: "Presentada",
    countered: "Contrapropuesta",
    tentative_agreement: "Acuerdo tentativo",
    accepted: "Aceptada",
    rejected: "Rechazada",
    withdrawn: "Retirada",
    superseded: "Reemplazada",
    scheduled: "Programada",
    held: "Realizada",
    cancelled: "Cancelada",
    rescheduled: "Reprogramada",
    no_quorum: "Sin quórum",
    indeterminate: "Requiere conciliación",
    suppressed: "Suprimido por privacidad",
    corrected: "Corregido",
    not_required: "Fuente indica no requerida",
    source_recorded_fully_signed: "La fuente registra todas las firmas",
    integrity_hold: "Retención de integridad",
  },
};

// coalition_partners.status and coalition_commitments.status
// (20260724035000_unionground_union_lifecycle.sql:912, :947). These were the
// only lifecycle enums in this file rendered as raw database slugs — "in
// progress" reached a Spanish reader untranslated while every adjacent chip
// went through enumLabel.
//
// Each map covers its CHECK constraint exactly. Anything more is dead (nothing
// renders chapter_handshakes.status) and anything less renders a bare slug to
// both locales, which is how this defect class shipped in the first place.
const COALITION_STATUS_LABELS = {
  en: {
    forming: "Forming",
    active: "Active",
    paused: "Paused",
    ended: "Ended",
  },
  es: {
    forming: "En formación",
    active: "Activo",
    paused: "En pausa",
    ended: "Finalizado",
  },
};

const COMMITMENT_STATUS_LABELS = {
  en: {
    proposed: "Proposed",
    accepted: "Accepted",
    in_progress: "In progress",
    fulfilled: "Fulfilled",
    declined: "Declined",
    cancelled: "Cancelled",
    expired: "Expired",
  },
  es: {
    proposed: "Propuesto",
    accepted: "Aceptado",
    in_progress: "En curso",
    fulfilled: "Cumplido",
    declined: "Rechazado",
    cancelled: "Cancelado",
    expired: "Vencido",
  },
};

const RATIFICATION_OUTCOME_LABELS = {
  en: {
    approved: "Approved",
    rejected: "Rejected",
    no_quorum: "No quorum",
    indeterminate: "Needs reconciliation",
    suppressed: "Suppressed for privacy",
    corrected: "Corrected",
    not_required: "Sourced as not required",
  },
  es: {
    approved: "Aprobada",
    rejected: "Rechazada",
    no_quorum: "Sin quórum",
    indeterminate: "Requiere conciliación",
    suppressed: "Suprimido por privacidad",
    corrected: "Corregido",
    not_required: "Fuente indica no requerida",
  },
};

const BARGAINING_VERIFICATION_LABELS = {
  en: {
    staff_recorded_external_aggregate: "Staff-recorded external aggregate",
    staff_recorded_executed_agreement: "Staff-recorded executed agreement",
    corrected_ratification_requires_governed_resolution: "Disputed record awaiting governed resolution",
  },
  es: {
    staff_recorded_external_aggregate: "Agregado externo registrado por el personal",
    staff_recorded_executed_agreement: "Acuerdo ejecutado registrado por el personal",
    corrected_ratification_requires_governed_resolution: "Registro disputado pendiente de resolución gobernada",
  },
};

const RATIFICATION_CORRECTION_LABELS = {
  en: {
    source_error: "Source error",
    tally_error: "Tally error",
    rule_error: "Rule error",
    wrong_agreement: "Wrong agreement package",
    duplicate_record: "Duplicate record",
    other: "Other",
  },
  es: {
    source_error: "Error de fuente",
    tally_error: "Error de conteo",
    rule_error: "Error de regla",
    wrong_agreement: "Paquete de acuerdo incorrecto",
    duplicate_record: "Registro duplicado",
    other: "Otro",
  },
};

const BARGAINING_RECORD_KIND_LABELS = {
  en: {
    article: "Article proposal",
    agreement_package: "Whole agreement package",
  },
  es: {
    article: "Propuesta de artículo",
    agreement_package: "Paquete del acuerdo completo",
  },
};

// Every en/es table in this file, exported for the parity guard in
// tests/organize-view.test.jsx.
//
// This file carries a ~340-entry private translation table rather than using
// the app-wide catalogue in src/lib/i18n.js. Migrating it under an `organize.*`
// prefix is the structurally right answer — one catalogue, one parity guard,
// and t()'s {slot} interpolation instead of the hand concatenation the impact
// panel needed — but it is ~340 keys plus several hundred `copy.x` call sites,
// a diff large enough to bury the substantive fixes it would ship alongside and
// too large to review.
//
// What the private table actually COST was drift: the app-wide catalogue has an
// en/es parity test and this table had none, which is how untranslated English
// prose and raw database slugs reached Spanish readers here. That is closed by
// the guard below at a fraction of the churn. The migration stays a separate,
// mechanical change.
export const ORGANIZE_LOCALE_TABLES = {
  COPY,
  STAGE_LABELS,
  STATUS_LABELS,
  OUTCOME_LABELS,
  RESISTANCE_CATEGORY_LABELS,
  RESISTANCE_URGENCY_LABELS,
  RESISTANCE_SOURCE_LABELS,
  LEGAL_REVIEW_LABELS,
  BARGAINING_PHASE_LABELS,
  BARGAINING_STATUS_LABELS,
  COALITION_STATUS_LABELS,
  COMMITMENT_STATUS_LABELS,
  RATIFICATION_OUTCOME_LABELS,
  BARGAINING_VERIFICATION_LABELS,
  RATIFICATION_CORRECTION_LABELS,
  BARGAINING_RECORD_KIND_LABELS,
};

function stageLabel(stage, lang) {
  return STAGE_LABELS[lang]?.[stage] || CAMPAIGN_STAGE_LABELS[stage] || stage.replaceAll("_", " ");
}

function statusLabel(status, lang) {
  return STATUS_LABELS[lang]?.[status] || status;
}

function enumLabel(labels, value, lang) {
  const key = String(value || "").trim().toLowerCase().replaceAll(" ", "_");
  return labels[lang]?.[key] || labels.en?.[key] || key.replaceAll("_", " ");
}

function campaignRoute(campaign) {
  const route = Array.isArray(campaign.route) ? campaign.route : [];
  const hasRecordedCertification = campaign.stage === "certification"
    || campaign.verifiedStages?.includes("certification");
  return route.includes("recognition") && !hasRecordedCertification
    ? route.filter((stage) => stage !== "certification")
    : route;
}

function closureOutcomes(campaign, lang) {
  const labels = OUTCOME_LABELS[lang] || OUTCOME_LABELS.en;
  const entries = [
    ["withdrawn", labels.withdrawn],
    ["other", labels.other],
  ];
  if (campaign.route.includes("election") && ["election", "certification"].includes(campaign.stage)) {
    entries.splice(1, 0, ["lost", labels.lost]);
  }
  return entries;
}

function representationPathLabel(campaign, copy) {
  if (campaign.route.includes("election")) return copy.branchElection;
  if (campaign.route.includes("recognition")) return copy.branchRecognition;
  return copy.branchUndecided;
}

function formatDate(value, lang, options = { month: "short", day: "numeric", year: "numeric" }) {
  if (!value) return "—";
  const parsed = new Date(value.includes("T") ? value : `${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat(localeFor(lang), options).format(parsed);
}

function ToneChip({ children, tone = "neutral" }) {
  return <span className={`lifecycle-chip lifecycle-chip--${tone}`}>{children}</span>;
}

// The suppression wording lives here, not in lifecycleMetrics: that module has
// no locale, and "Not shown" is the one string a Spanish-reading organizer must
// never meet in English — it is the label that says their coworkers' numbers
// are being withheld.
function RatioBar({ label, numerator, denominator, copy, tone = "green" }) {
  const privacy = suppressSmall(numerator, denominator);
  const percent = privacy.suppressed ? null : safePercent(numerator, denominator);
  return (
    <div className="lifecycle-ratio">
      <div><span>{label}</span><strong>{percent === null ? copy.suppressed : `${numerator} ${copy.of} ${denominator} · ${percent}%`}</strong></div>
      {percent === null ? null : (
        <span className="lifecycle-ratio__track" aria-hidden="true">
          <span className={`lifecycle-ratio__fill lifecycle-ratio__fill--${tone}`} style={{ width: `${percent}%` }} />
        </span>
      )}
    </div>
  );
}

function LifecycleRail({ campaign, copy, lang }) {
  const route = campaignRoute(campaign);
  return (
    <ol className="lifecycle-rail" aria-label={copy.lifecycle}>
      {route.map((stage, index) => {
        const verified = campaign.verifiedStages.includes(stage);
        const current = stage === campaign.stage;
        return (
          <li key={stage} className={`${verified ? "is-verified" : ""}${current ? " is-current" : ""}`}>
            <span className="lifecycle-rail__stamp" aria-hidden="true">
              {verified ? <CheckCircle2 size={17} /> : <span>{index + 1}</span>}
            </span>
            <span>
              <strong>{stageLabel(stage, lang)}</strong>
              <small>{current ? copy.current : verified ? copy.verified : ""}</small>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function CampaignsPanel({ workspace, campaign, copy, lang }) {
  const age = stageAgeDays(campaign.stageStartedAt, new Date(workspace.generatedAt));
  const electionPath = campaign.route.includes("election");
  const outcomeLabel = OUTCOME_LABELS[lang]?.[campaign.outcome] || campaign.outcome;
  return (
    <>
      <div className="stat-grid lifecycle-stats" role="group" aria-label={copy.campaignPicker}>
        <StatCard label={copy.eligible} value={campaign.eligibleEstimate ?? copy.suppressed} tone="green" />
        <StatCard label={copy.contacted} value={coveragePercent(campaign) ?? copy.suppressed} suffix={coveragePercent(campaign) == null ? "" : "%"} tone="green" />
        <StatCard label={copy.committee} value={campaign.committeeCount ?? copy.suppressed} tone="gold" />
        <StatCard label={copy.stageAge} value={age ?? "—"} tone="gold" />
      </div>
      <section className="lifecycle-panel">
        <header className="lifecycle-panel__header">
          <div>
            <ToneChip tone={electionPath ? "blue" : "green"}>{representationPathLabel(campaign, copy)}</ToneChip>
            {campaign.status && (
              <ToneChip tone={campaign.status === "active" ? "green" : campaign.status === "paused" ? "gold" : "neutral"}>
                {statusLabel(campaign.status, lang)}
              </ToneChip>
            )}
            <h2>{copy.lifecycle}</h2>
            <p>{copy.lifecycleSub}</p>
          </div>
        </header>
        <LifecycleRail campaign={campaign} copy={copy} lang={lang} />
      </section>
      {campaign.status === "closed" && (
        <section className="lifecycle-closure-summary" aria-label={copy.closureSummary}>
          <span className="lifecycle-card__icon"><CircleAlert size={17} aria-hidden="true" /></span>
          <div>
            <small>{copy.closureSummary}</small>
            <strong>{copy.closureOutcome}: {outcomeLabel || "—"}</strong>
            {campaign.outcomeReason && <p>{copy.closureReason}: {campaign.outcomeReason}</p>}
            <p>{copy.closureDate}: {formatDate(campaign.closedAt, lang)}</p>
          </div>
        </section>
      )}
      {campaign.status !== "closed" && campaign.canOperate !== false && campaign.nextAction && <section className="lifecycle-next-action">
        <span><Target size={18} /></span>
        <div>
          <small>{copy.nextAction}</small>
          <strong>{campaign.nextAction}</strong>
          <p>{copy.due} · {formatDate(campaign.nextActionDue, lang)}</p>
        </div>
      </section>}
      <aside className="lifecycle-privacy-note"><LockKeyhole size={17} /><p>{copy.sourceBoundary}</p></aside>
    </>
  );
}

// Idempotency key, not a secret: the server pairs a retry with the write it is
// retrying. This runs during render (CreateCampaignDialog seeds the ref on its
// first pass), so throwing here did not fail one write — it threw inside
// React's render phase and took the workspace to a blank screen on any origin
// without crypto.randomUUID (http://, older WebViews). Same v4-shaped fallback
// as src/components/BargainingWriterDialog.jsx.
function newCampaignRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const hex = (length) => Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const variant = "89ab"[Math.floor(Math.random() * 4)];
  return `${Date.now().toString(16).padStart(12, "0").slice(-8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

function CreateCampaignDialog({ copy, onClose, onCreate, restoreFocusRef }) {
  const requestId = useRef(null);
  if (!requestId.current) requestId.current = newCampaignRequestId();
  const retryPayload = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(event.currentTarget);
    const rawEstimate = String(values.get("eligibleEstimate") || "").trim();
    const payload = uncertain && retryPayload.current
      ? retryPayload.current
      : {
          name: String(values.get("name") || "").trim(),
          employerName: String(values.get("employerName") || "").trim(),
          worksiteName: String(values.get("worksiteName") || "").trim(),
          proposedUnit: String(values.get("proposedUnit") || "").trim(),
          representationPath: String(values.get("representationPath") || ""),
          eligibleEstimate: rawEstimate === "" ? null : Number(rawEstimate),
          requestId: requestId.current,
        };
    retryPayload.current = payload;
    setBusy(true);
    setError("");
    try {
      await onCreate(payload);
    } catch (err) {
      setUncertain(!err.code);
      setError(copy.writerFailed);
      setBusy(false);
    }
  }

  function changeAfterError() {
    if (!error || uncertain) return;
    requestId.current = newCampaignRequestId();
    retryPayload.current = null;
    setError("");
  }

  return (
    <Dialog eyebrow={copy.createEyebrow} title={copy.createTitle} onClose={onClose} busy={busy} locked={uncertain} restoreFocusRef={restoreFocusRef} wide>
      <form className="stack-form" onSubmit={submit} onChange={changeAfterError}>
        <fieldset disabled={busy || uncertain}>
          <label>{copy.campaignName}<input name="name" minLength={3} maxLength={160} required /></label>
          <label>{copy.employerName}<input name="employerName" minLength={2} maxLength={120} required /></label>
          <label>{copy.worksiteName}<input name="worksiteName" minLength={2} maxLength={160} required /></label>
          <label>{copy.proposedUnit}<textarea name="proposedUnit" minLength={3} maxLength={500} required /></label>
          <label>{copy.representationPath}
            <select name="representationPath" defaultValue="undecided">
              <option value="undecided">{copy.undecidedPath}</option>
              <option value="election">{copy.electionPath}</option>
              <option value="voluntary_recognition">{copy.recognitionPath}</option>
            </select>
          </label>
          <label>{copy.eligibleEstimateField}<input name="eligibleEstimate" type="number" min="0" max="10000000" inputMode="numeric" /></label>
        </fieldset>
        {error && <p className="auth-message" role="alert">{error}</p>}
        <button className="dialog-primary" disabled={busy}>
          {busy ? copy.creating : uncertain ? copy.retry : copy.createSubmit}
        </button>
      </form>
    </Dialog>
  );
}

function nextStageChoices(campaign, workspace) {
  const fixed = {
    lead: ["committee"],
    committee: ["cards"],
    petition: ["election"],
    election: ["certification"],
  };
  if (campaign.stage === "cards") {
    if (campaign.route.includes("petition")) return ["petition"];
    if (campaign.route.includes("recognition")) return ["recognition"];
    return ["petition", "recognition"];
  }
  if (["recognition", "certification"].includes(campaign.stage)) {
    const cycle = workspace.bargaining?.find((item) => item.campaignId === campaign.id);
    const startedPhases = new Set([
      "at_table",
      "mediation",
      "fact_finding",
      "impasse",
      "tentative_agreement",
      "ratification",
      "execution",
      "complete",
    ]);
    return cycle?.bargainingStartedOn && startedPhases.has(cycle.status) ? ["bargaining"] : [];
  }
  if (campaign.stage === "first_contract") {
    const cycle = workspace.bargaining?.find((item) => item.campaignId === campaign.id);
    return cycle?.status === "complete" && cycle.firstContractSignedOn ? ["established"] : [];
  }
  // Bargaining-to-first-contract needs the dedicated typed ratification writer.
  // Do not present an unsourced progress button before that record exists.
  if (campaign.stage === "bargaining") return [];
  return fixed[campaign.stage] || [];
}

function MilestoneDialog({ campaign, choices, copy, lang, onClose, onSave, restoreFocusRef }) {
  const requestId = useRef(null);
  if (!requestId.current) requestId.current = newCampaignRequestId();
  const retryPayload = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(event.currentTarget);
    const payload = uncertain && retryPayload.current
      ? retryPayload.current
      : {
          campaignId: campaign.id,
          expectedRevision: campaign.revision,
          nextStage: String(values.get("nextStage") || ""),
          note: String(values.get("note") || "").trim(),
          requestId: requestId.current,
        };
    retryPayload.current = payload;
    setBusy(true);
    setError("");
    try {
      await onSave(payload);
    } catch (err) {
      if (err.code === "40001") {
        requestId.current = newCampaignRequestId();
        retryPayload.current = null;
        setUncertain(false);
        setError(copy.changedReloaded);
      } else {
        setUncertain(!err.code);
        setError(copy.writerFailed);
      }
    } finally {
      setBusy(false);
    }
  }

  function changeAfterError() {
    if (!error || uncertain) return;
    requestId.current = newCampaignRequestId();
    retryPayload.current = null;
    setError("");
  }

  return (
    <Dialog eyebrow={copy.milestoneEyebrow} title={copy.milestoneTitle} onClose={onClose} busy={busy} restoreFocusRef={restoreFocusRef} wide>
      <form className="stack-form" onSubmit={submit} onChange={changeAfterError}>
        <fieldset disabled={busy || uncertain}>
          <legend>{copy.milestoneChoice}</legend>
          {choices.map((stage) => (
            <label key={stage} className="lifecycle-choice">
              <input type="radio" name="nextStage" value={stage} defaultChecked={stage === choices[0]} required />
              <span>{stageLabel(campaign.stage, lang)} → {stageLabel(stage, lang)}</span>
            </label>
          ))}
        </fieldset>
        <fieldset disabled={busy || uncertain}>
          <label>{copy.milestoneNote}<textarea name="note" maxLength={1000} /></label>
        </fieldset>
        <aside className="lifecycle-privacy-note"><LockKeyhole size={17} /><p>{copy.milestonePrivacy}</p></aside>
        {error && <p className="auth-message" role="alert">{error}</p>}
        <button className="dialog-primary" disabled={busy}>
          {busy ? copy.saving : uncertain ? copy.retry : copy.milestoneSubmit}
        </button>
      </form>
    </Dialog>
  );
}

function CampaignStatusDialog({ campaign, canClose, copy, lang, onClose, onSave, restoreFocusRef }) {
  const requestId = useRef(null);
  if (!requestId.current) requestId.current = newCampaignRequestId();
  const retryPayload = useRef(null);
  const defaultStatus = campaign.status === "paused" ? "active" : "paused";
  const [nextStatus, setNextStatus] = useState(defaultStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);

  useEffect(() => {
    setNextStatus(campaign.status === "paused" ? "active" : "paused");
  }, [campaign.id, campaign.status]);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(event.currentTarget);
    const payload = uncertain && retryPayload.current
      ? retryPayload.current
      : {
          campaignId: campaign.id,
          expectedRevision: campaign.revision,
          status: String(values.get("status") || ""),
          outcome: String(values.get("outcome") || "") || null,
          reason: String(values.get("reason") || "").trim(),
          requestId: requestId.current,
        };
    retryPayload.current = payload;
    setBusy(true);
    setError("");
    try {
      await onSave(payload);
    } catch (err) {
      if (err.code === "40001") {
        requestId.current = newCampaignRequestId();
        retryPayload.current = null;
        setUncertain(false);
        setError(copy.changedReloaded);
      } else {
        setUncertain(!err.code);
        setError(copy.writerFailed);
      }
    } finally {
      setBusy(false);
    }
  }

  function changeAfterError() {
    if (!error || uncertain) return;
    requestId.current = newCampaignRequestId();
    retryPayload.current = null;
    setError("");
  }

  return (
    <Dialog eyebrow={copy.statusEyebrow} title={copy.statusTitle} onClose={onClose} busy={busy} restoreFocusRef={restoreFocusRef}>
      <form className="stack-form" onSubmit={submit} onChange={changeAfterError}>
        <fieldset disabled={busy || uncertain}>
          <legend>{copy.statusAction}</legend>
          <label className="lifecycle-choice">
            <input
              type="radio"
              name="status"
              value={defaultStatus}
              checked={nextStatus === defaultStatus}
              onChange={() => setNextStatus(defaultStatus)}
              required
            />
            <span>{campaign.status === "paused" ? copy.resume : copy.pause}</span>
          </label>
          {canClose && (
            <label className="lifecycle-choice">
              <input
                type="radio"
                name="status"
                value="closed"
                checked={nextStatus === "closed"}
                onChange={() => setNextStatus("closed")}
              />
              <span>{copy.close}</span>
            </label>
          )}
        </fieldset>
        {nextStatus === "closed" && (
          <fieldset disabled={busy || uncertain}>
            <label>{copy.statusOutcome}
              <select name="outcome" defaultValue="" required>
                <option value="" disabled>—</option>
                {closureOutcomes(campaign, lang).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
          </fieldset>
        )}
        <fieldset disabled={busy || uncertain}>
          <label>{copy.statusReason}
            <textarea name="reason" maxLength={1000} required={nextStatus === "closed"} />
          </label>
        </fieldset>
        <aside className="lifecycle-privacy-note"><LockKeyhole size={17} /><p>{copy.statusPrivacy}</p></aside>
        <aside className="lifecycle-warning"><CircleAlert size={18} /><p>{copy.statusCloseBoundary}</p></aside>
        {error && <p className="auth-message" role="alert">{error}</p>}
        <button className="dialog-primary" disabled={busy}>
          {busy ? copy.saving : uncertain ? copy.retry : copy.statusSubmit}
        </button>
      </form>
    </Dialog>
  );
}

// The governed exit from a post-first-contract ratification integrity hold.
//
// Without a control here the hold had no in-product recovery at all: the BEFORE
// trigger refuses every direct UPDATE that clears it, including one from
// service_role, so the only way out was a DBA disabling an integrity trigger on
// live evidence data. The note is not decoration — it is the entire product
// record of why the hold was lifted, and the RPC rejects an empty one.
function ResolveIntegrityHoldDialog({ cycle, copy, onClose, onSave, restoreFocusRef }) {
  const requestId = useRef(null);
  if (!requestId.current) requestId.current = newCampaignRequestId();
  const retryPayload = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(event.currentTarget);
    const payload = uncertain && retryPayload.current
      ? retryPayload.current
      : {
          cycleId: cycle.id,
          expectedCycleRevision: cycle.revision,
          resolutionNote: String(values.get("resolutionNote") || "").trim(),
          requestId: requestId.current,
        };
    retryPayload.current = payload;
    setBusy(true);
    setError("");
    try {
      await onSave(payload);
    } catch (err) {
      if (err.code === "40001") {
        // A concurrent write moved the cycle. A fresh id is required: the same
        // id with different input is rejected as a replay with new content.
        requestId.current = newCampaignRequestId();
        retryPayload.current = null;
        setUncertain(false);
        setError(copy.changedReloaded);
      } else {
        // No error code means we never learned whether the write landed, so the
        // form freezes on the exact payload and retries with the SAME request
        // id — the server pairs the retry with the original write.
        setUncertain(!err.code);
        setError(copy.writerFailed);
      }
    } finally {
      setBusy(false);
    }
  }

  function changeAfterError() {
    if (!error || uncertain) return;
    requestId.current = newCampaignRequestId();
    retryPayload.current = null;
    setError("");
  }

  return (
    <Dialog eyebrow={copy.resolveHoldEyebrow} title={copy.resolveHoldTitle} onClose={onClose} busy={busy} restoreFocusRef={restoreFocusRef}>
      <form className="stack-form" onSubmit={submit} onChange={changeAfterError}>
        <aside className="lifecycle-warning"><CircleAlert size={18} /><p>{copy.resolveHoldLead}</p></aside>
        <fieldset disabled={busy || uncertain}>
          <label>{copy.resolveHoldNote}
            <textarea name="resolutionNote" minLength={3} maxLength={1000} required />
          </label>
          <small>{copy.resolveHoldNoteHint}</small>
        </fieldset>
        {error && <p className="auth-message" role="alert">{error}</p>}
        <button className="dialog-primary" disabled={busy}>
          {busy ? copy.saving : uncertain ? copy.retry : copy.resolveHoldSubmit}
        </button>
      </form>
    </Dialog>
  );
}

function WorksitesPanel({ workspace, campaign, copy }) {
  const rows = workspace.workAreas.filter((row) => row.campaignId === campaign.id);
  return (
    <section className="lifecycle-section">
      <SectionTitle sub={copy.coverageSub}>{copy.coverage}</SectionTitle>
      <aside className="lifecycle-privacy-note"><LockKeyhole size={17} /><p>{copy.sourceBoundary}</p></aside>
      <div className="lifecycle-card-list">
        {rows.length === 0 && <EmptyState><p>{copy.noAreas}</p></EmptyState>}
        {rows.map((row) => {
          const contactPrivacy = suppressSmall(
            row.contactedCount,
            row.eligibleEstimate,
          );
          const committeePrivacy = suppressSmall(
            row.committeeCount,
            row.contactedCount,
          );
          const visible = !contactPrivacy.suppressed && !committeePrivacy.suppressed;
          const percent = visible ? coveragePercent(row) : null;
          return (
            <article className="lifecycle-card" key={row.id}>
              <header>
                <span className="lifecycle-card__icon"><MapPin size={17} /></span>
                <div>
                  <h3>{row.name}</h3>
                  <p>
                    {row.shift} · {visible ? row.eligibleEstimate : copy.suppressed}
                    {visible ? ` ${copy.people}` : ""}
                  </p>
                </div>
                <ToneChip tone={percent == null || percent < 60 ? "gold" : "green"}>
                  {percent == null ? copy.suppressed : `${percent}%`}
                </ToneChip>
              </header>
              <RatioBar
                label={copy.contactCoverage}
                numerator={visible ? row.contactedCount : null}
                denominator={visible ? row.eligibleEstimate : null}
                copy={copy}
              />
              {/* The committee suppression gate above is computed against
                  contactedCount, so the bar has to be drawn against
                  contactedCount too. Showing committee-over-eligible while the
                  k-check ran on committee-over-contacted let a reader recover
                  the smaller cell the gate exists to protect. */}
              <RatioBar
                label={copy.committeeOfContacted}
                numerator={visible ? row.committeeCount : null}
                denominator={visible ? row.contactedCount : null}
                copy={copy}
                tone="gold"
              />
              {visible && (
                <div className="lifecycle-tag-list">
                  {row.issueThemes.map((theme) => <span key={theme}>{theme}</span>)}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ResistancePanel({ workspace, campaign, copy, lang }) {
  const events = workspace.resistanceEvents.filter((event) => event.campaignId === campaign.id);
  const scopedAccess = workspace.access?.resistanceCampaignIds;
  const canReadDetails = workspace.access?.resistanceDetails === true
    && Array.isArray(scopedAccess)
    && scopedAccess.includes(campaign.id);
  const visibleEvents = canReadDetails ? events : [];
  return (
    <section className="lifecycle-section">
      <SectionTitle sub={copy.resistanceSub}>{copy.resistance}</SectionTitle>
      <aside className="lifecycle-warning"><ShieldAlert size={18} /><p>{copy.potential}</p></aside>
      <div className="lifecycle-card-list">
        {visibleEvents.length === 0 && (
          <EmptyState>
            <p>{canReadDetails ? copy.noResistance : copy.resistanceRestricted}</p>
          </EmptyState>
        )}
        {visibleEvents.map((event) => (
          <article className="lifecycle-card lifecycle-card--resistance" key={event.id}>
            <header>
              <span className="lifecycle-card__icon"><CircleAlert size={17} /></span>
              <div>
                <h3>{event.title}</h3>
                <p>{enumLabel(RESISTANCE_CATEGORY_LABELS, event.category, lang)} · {formatDate(event.occurredOn, lang)}</p>
              </div>
              <ToneChip tone={["high", "immediate"].includes(event.severity) ? "terra" : "gold"}>
                {copy.responseUrgency}: {enumLabel(RESISTANCE_URGENCY_LABELS, event.severity, lang)}
              </ToneChip>
            </header>
            <p className="lifecycle-card__body">{event.summary}</p>
            <dl className="lifecycle-facts">
              <div><dt>{copy.sourceType}</dt><dd>{enumLabel(RESISTANCE_SOURCE_LABELS, event.sourceType, lang)}</dd></div>
              <div><dt>{copy.legalReview}</dt><dd>{enumLabel(LEGAL_REVIEW_LABELS, event.legalReviewStatus, lang)}</dd></div>
              <div><dt>{copy.workingDate}</dt><dd>{formatDate(event.nextDeadline, lang)}</dd></div>
              <div><dt>{copy.evidence}</dt><dd>{event.evidenceCount}</dd></div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}

function BargainingPanel({
  workspace,
  campaign,
  copy,
  lang,
  writersEnabled,
  onWrite,
  integrityHoldPending,
  pendingRatificationCorrections,
  canResolveIntegrityHold,
  onResolveIntegrityHold,
}) {
  const bargaining = workspace.bargaining.find((item) => item.campaignId === campaign.id);
  if (!bargaining) {
    return (
      <section className="lifecycle-section">
        <SectionTitle sub={copy.bargainingSub}>{copy.bargaining}</SectionTitle>
        <EmptyState>
          <p>{copy.noBargaining}</p>
          {writersEnabled && campaign.canOpenBargaining === true && (
            <button type="button" className="outline-pill" onClick={() => onWrite("open")}>
              <Plus size={15} aria-hidden="true" /> {copy.openBargaining}
            </button>
          )}
        </EmptyState>
      </section>
    );
  }
  const phase = bargaining.phase || bargaining.status;
  const integrityHoldActive = bargaining.ratificationIntegrityHold
    || integrityHoldPending;
  const pendingCorrectionsByRatification = new Map(
    pendingRatificationCorrections.map((correction) => [
      correction.ratificationId,
      correction,
    ]),
  );
  const canWrite = writersEnabled && bargaining.canWrite === true;
  const canCertify = writersEnabled && bargaining.canCertify === true;
  const canRecordSessionOutcome = writersEnabled
    && bargaining.canRecordSessionOutcome === true;
  const canRecordRatification = canCertify
    && ["tentative_agreement", "ratification"].includes(phase)
    && bargaining.canAdvanceToRatification === true
    && bargaining.proposals.some((proposal) => proposal.status === "tentative_agreement");
  const canRecordContract = writersEnabled
    && bargaining.canRecordFirstContract === true;
  const canCorrectRatification = writersEnabled
    && bargaining.canCorrectRatification === true;
  return (
    <section className="lifecycle-section">
      <SectionTitle sub={copy.bargainingSub}>{copy.bargaining}</SectionTitle>
      {(canWrite || canRecordRatification || canRecordContract) && (
        <div className="lifecycle-command-bar bargaining-command-bar" role="group" aria-label={copy.bargaining}>
          {canWrite && phaseChoices(bargaining).length > 0 && (
            <button type="button" className="outline-pill" onClick={() => onWrite("phase")}>
              <TrendingUp size={15} aria-hidden="true" /> {
                phase === "ratification" ? copy.rollbackPhase : copy.updatePhase
              }
            </button>
          )}
          {canWrite && !["ratification", "execution", "complete"].includes(phase) && (
            <button type="button" className="outline-pill" onClick={() => onWrite("proposal")}>
              <FileText size={15} aria-hidden="true" /> {copy.addProposal}
            </button>
          )}
          {canWrite && !["execution", "complete"].includes(phase) && (
            <>
              <button type="button" className="outline-pill" onClick={() => onWrite("session")}>
                <CalendarClock size={15} aria-hidden="true" /> {copy.scheduleSession}
              </button>
            </>
          )}
          {canRecordRatification && (
            <button type="button" className="outline-pill" onClick={() => onWrite("ratification")}>
              <CheckCircle2 size={15} aria-hidden="true" /> {copy.recordRatification}
            </button>
          )}
          {canRecordContract && (
            <button type="button" className="outline-pill" onClick={() => onWrite("contract")}>
              <FileText size={15} aria-hidden="true" /> {copy.recordContract}
            </button>
          )}
        </div>
      )}
      <div className="stat-grid lifecycle-stats">
        <StatCard label={copy.bargainingPhase} value={enumLabel(BARGAINING_PHASE_LABELS, phase, lang)} tone="green" />
        <StatCard label={copy.proposals} value={bargaining.proposals.length} tone="gold" />
        <StatCard label={copy.sessions} value={bargaining.sessions.length} tone="green" />
        <StatCard label={copy.due} value={formatDate(bargaining.firstContractTargetOn, lang, { month: "short", day: "numeric" })} tone="gold" />
      </div>
      {integrityHoldActive && (
        <aside className="lifecycle-warning" role="alert">
          <CircleAlert size={18} aria-hidden="true" />
          <div>
            <p>{copy.integrityHold}</p>
            {canResolveIntegrityHold && (
              <button type="button" className="outline-pill" onClick={onResolveIntegrityHold}>
                <ShieldAlert size={15} aria-hidden="true" /> {copy.resolveHold}
              </button>
            )}
          </div>
        </aside>
      )}
      {bargaining.nextAction && (
        <section className="lifecycle-next-action">
          <span><Target size={18} aria-hidden="true" /></span>
          <div>
            <small>{copy.nextAction}</small>
            <strong>{bargaining.nextAction}</strong>
            <p>{copy.due} · {formatDate(bargaining.nextDeadlineAt, lang)}</p>
          </div>
        </section>
      )}
      <div className="lifecycle-card-list">
        <article className="lifecycle-card">
          <header>
            <span className="lifecycle-card__icon"><FileText size={17} /></span>
            <div>
              <h3>{copy.proposals}</h3>
              <p>{enumLabel(BARGAINING_PHASE_LABELS, phase, lang)}</p>
            </div>
          </header>
          <div className="lifecycle-register">
            {bargaining.proposals.map((proposal) => (
              <div key={proposal.id}>
                <span>
                  <strong>{proposal.title}</strong>
                  <small>
                    {proposal.topic} · {enumLabel(BARGAINING_RECORD_KIND_LABELS, proposal.recordKind || "article", lang)} · v{proposal.version}
                  </small>
                  {proposal.memberSummary && <small>{proposal.memberSummary}</small>}
                </span>
                <span className="lifecycle-register__actions">
                  <ToneChip tone={proposal.status === "tentative_agreement" ? "green" : "blue"}>
                    {enumLabel(BARGAINING_STATUS_LABELS, proposal.status, lang)}
                  </ToneChip>
                  {canWrite
                    && !["ratification", "execution", "complete"].includes(phase)
                    && proposalChoices(proposal, bargaining).length > 0 && (
                    <button
                      type="button"
                      className="outline-pill outline-pill--compact"
                      aria-label={`${copy.updateProposal}: ${proposal.title}`}
                      onClick={() => onWrite("proposalStatus", proposal.id)}
                    >
                      {copy.updateProposal}
                    </button>
                  )}
                </span>
              </div>
            ))}
            {!bargaining.proposals.length && <p className="lifecycle-register__empty">{copy.noProposals}</p>}
          </div>
        </article>
        <article className="lifecycle-card">
          <header><span className="lifecycle-card__icon"><CalendarClock size={17} /></span><div><h3>{copy.sessions}</h3><p>{formatDate(bargaining.bargainingStartedOn, lang)}</p></div></header>
          <div className="lifecycle-register">
            {bargaining.sessions.map((session) => (
              <div key={session.id}>
                <span>
                  <strong>{formatDate(session.startsAt, lang, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</strong>
                  <small>{session.location}</small>
                  {session.summary && <small>{session.summary}</small>}
                </span>
                <span className="lifecycle-register__actions">
                  <ToneChip tone={session.status === "held" ? "green" : "gold"}>
                    {enumLabel(BARGAINING_STATUS_LABELS, session.status, lang)}
                  </ToneChip>
                  {canRecordSessionOutcome && session.status === "scheduled" && (
                    <button
                      type="button"
                      className="outline-pill outline-pill--compact"
                      aria-label={`${copy.recordSession}: ${formatDate(session.startsAt, lang)}`}
                      onClick={() => onWrite("sessionOutcome", session.id)}
                    >
                      {copy.recordSession}
                    </button>
                  )}
                </span>
              </div>
            ))}
            {!bargaining.sessions.length && <p className="lifecycle-register__empty">{copy.noSessions}</p>}
          </div>
        </article>
        <article className="lifecycle-card">
          <header>
            <span className="lifecycle-card__icon"><CheckCircle2 size={17} /></span>
            <div><h3>{copy.ratificationResults}</h3><p>{copy.verificationBoundary}</p></div>
          </header>
          <div className="lifecycle-register">
            {bargaining.ratifications.map((record) => {
              const pendingCorrection = pendingCorrectionsByRatification.get(record.id);
              const corrected = record.corrected || Boolean(pendingCorrection);
              const correctionReasonCode = record.correctionReasonCode
                || pendingCorrection?.reasonCode;
              return (
                <div key={record.id}>
                  <span>
                    <strong>{formatDate(record.heldOn, lang)}</strong>
                    <small>{enumLabel(BARGAINING_VERIFICATION_LABELS, record.verification, lang)}</small>
                    {record.current && !integrityHoldActive && !corrected && <small>{copy.currentRatification}</small>}
                    {corrected && correctionReasonCode && (
                      <small>
                        {copy.correctionReason}: {enumLabel(
                          RATIFICATION_CORRECTION_LABELS,
                          correctionReasonCode,
                          lang,
                        )}
                      </small>
                    )}
                  </span>
                  <span className="lifecycle-register__actions">
                    <ToneChip tone={corrected ? "terra" : ["approved", "not_required"].includes(record.outcome) ? "green" : ["indeterminate", "suppressed"].includes(record.outcome) ? "terra" : "gold"}>
                      {enumLabel(
                        RATIFICATION_OUTCOME_LABELS,
                        corrected ? "corrected" : record.outcome,
                        lang,
                      )}
                    </ToneChip>
                    {canCorrectRatification && record.current && !corrected && (
                      <button
                        type="button"
                        className="outline-pill outline-pill--compact"
                        aria-label={`${copy.correctRatification}: ${formatDate(record.heldOn, lang)}`}
                        onClick={() => onWrite("ratificationCorrection", record.id)}
                      >
                        {copy.correctRatification}
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
            {!bargaining.ratifications.length && <p className="lifecycle-register__empty">{copy.noRatification}</p>}
          </div>
        </article>
        <article className="lifecycle-card">
          <header>
            <span className="lifecycle-card__icon"><FileText size={17} /></span>
            <div>
              <h3>{copy.firstContractRecord}</h3>
              <p>
                {bargaining.firstContract
                  ? enumLabel(
                    BARGAINING_VERIFICATION_LABELS,
                    integrityHoldActive
                      ? "corrected_ratification_requires_governed_resolution"
                      : bargaining.firstContract.verification,
                    lang,
                  )
                  : copy.noFirstContract}
              </p>
            </div>
          </header>
          {bargaining.firstContract ? (
            <dl className="lifecycle-facts">
              <div><dt>{copy.signed}</dt><dd>{formatDate(bargaining.firstContract.signedOn, lang)}</dd></div>
              <div><dt>{copy.effective}</dt><dd>{formatDate(bargaining.firstContract.effectiveOn, lang)}</dd></div>
              <div><dt>{copy.expires}</dt><dd>{formatDate(bargaining.firstContract.expiresOn, lang)}</dd></div>
              <div>
                <dt>{copy.bargainingPhase}</dt>
                <dd>{enumLabel(
                  BARGAINING_STATUS_LABELS,
                  integrityHoldActive ? "integrity_hold" : bargaining.firstContract.status,
                  lang,
                )}</dd>
              </div>
            </dl>
          ) : <p>{copy.noFirstContract}</p>}
        </article>
      </div>
      <aside className="lifecycle-privacy-note">
        <LockKeyhole size={17} />
        <p>{copy.verificationBoundary}</p>
      </aside>
    </section>
  );
}

function EngagementPanel({ workspace, copy }) {
  const engagement = workspace.engagement;
  const minimum = engagement.suppressionMinimum || 25;
  const visibleLadder = engagement.ladder.map((item) => {
    const privacy = suppressSmall(item.count, engagement.memberCount, minimum);
    return { ...item, visibleCount: privacy.suppressed ? null : item.count };
  });
  const ladderCounts = visibleLadder.map((item) => item.visibleCount).filter(Number.isFinite);
  const maxLadder = Math.max(1, ...ladderCounts);
  const metricPercent = (metric, numeratorKey) => {
    if (!metric) return null;
    const privacy = suppressSmall(metric[numeratorKey], metric.eligible, minimum);
    return privacy.suppressed ? null : safePercent(metric[numeratorKey], metric.eligible);
  };
  return (
    <section className="lifecycle-section">
      <SectionTitle sub={copy.onboardingSub}>{copy.onboarding}</SectionTitle>
      <div className="stat-grid lifecycle-stats">
        <StatCard label={copy.day30} value={metricPercent(engagement.onboarding30, "completed") ?? copy.suppressed} suffix={metricPercent(engagement.onboarding30, "completed") == null ? "" : "%"} tone="green" />
        <StatCard label={copy.day90} value={metricPercent(engagement.onboarding90, "completed") ?? copy.suppressed} suffix={metricPercent(engagement.onboarding90, "completed") == null ? "" : "%"} tone="green" />
        <StatCard label={copy.membershipRetention} value={metricPercent(engagement.membershipRetention12Month, "retained") ?? copy.suppressed} suffix={metricPercent(engagement.membershipRetention12Month, "retained") == null ? "" : "%"} tone="gold" />
        <StatCard label={copy.engagementRetention} value={metricPercent(engagement.engagementRetention12Month, "retained") ?? copy.suppressed} suffix={metricPercent(engagement.engagementRetention12Month, "retained") == null ? "" : "%"} tone="gold" />
      </div>
      <article className="lifecycle-panel">
        <header className="lifecycle-panel__header"><div><h2>{copy.ladder}</h2><p>{engagement.method}</p></div></header>
        <div className="lifecycle-ladder">
          {visibleLadder.map((item) => (
            <div key={item.stage}>
              <span>{item.stage}</span>
              <i aria-hidden="true">{Number.isFinite(item.visibleCount) ? <b style={{ width: `${Math.round((item.visibleCount / maxLadder) * 100)}%` }} /> : null}</i>
              <strong>{Number.isFinite(item.visibleCount) ? item.visibleCount : copy.suppressed}</strong>
            </div>
          ))}
        </div>
      </article>
      <div className="lifecycle-two-column">
        <article className="lifecycle-card">
          <header><span className="lifecycle-card__icon"><CheckCircle2 size={17} /></span><div><h3>{copy.safeRecognition}</h3></div></header>
          <ul>{engagement.safeRewardKinds.map((item) => <li key={item}>{item}</li>)}</ul>
        </article>
        <article className="lifecycle-card lifecycle-card--resistance">
          <header><span className="lifecycle-card__icon"><Scale size={17} /></span><div><h3>{copy.neverReward}</h3></div></header>
          <ul>{engagement.excludedRewardKinds.map((item) => <li key={item}>{item}</li>)}</ul>
        </article>
      </div>
    </section>
  );
}

function CoalitionsPanel({ workspace, copy, lang }) {
  return (
    <section className="lifecycle-section">
      <SectionTitle sub={copy.coalitionSub}>{copy.coalition}</SectionTitle>
      <div className="lifecycle-card-list">
        {workspace.coalitions.length === 0 && <EmptyState><p>{copy.noCoalitions}</p></EmptyState>}
        {workspace.coalitions.map((coalition) => (
          <article className="lifecycle-card" key={coalition.id}>
            <header>
              <span className="lifecycle-card__icon"><Handshake size={17} /></span>
              <div><h3>{coalition.name}</h3><p>{coalition.organizationType}</p></div>
              <ToneChip tone={coalition.status === "active" ? "green" : "gold"}>{enumLabel(COALITION_STATUS_LABELS, coalition.status, lang)}</ToneChip>
            </header>
            <p className="lifecycle-card__body"><strong>{coalition.sharedInterest}</strong></p>
            <dl className="lifecycle-facts">
              <div><dt>{copy.bridgeLead}</dt><dd>{coalition.bridgeLead}</dd></div>
              <div><dt>{copy.governance}</dt><dd>{coalition.governance}</dd></div>
            </dl>
            <h4>{copy.commitments}</h4>
            <div className="lifecycle-register">
              {coalition.commitments.map((commitment) => (
                <div key={commitment.id}>
                  <span><strong>{commitment.title}</strong><small>{commitment.ownerOrg} · {formatDate(commitment.dueOn, lang)}</small></span>
                  <ToneChip tone={commitment.status === "fulfilled" ? "green" : "blue"}>{enumLabel(COMMITMENT_STATUS_LABELS, commitment.status, lang)}</ToneChip>
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ImpactPanel({ workspace, copy, lang }) {
  const impact = workspace.impact;
  const slowestStage = impact.medianDays.reduce(
    (slowest, item) => (
      Number.isFinite(item?.days) && (!slowest || item.days > slowest.days)
        ? item
        : slowest
    ),
    null,
  );
  const flowValues = impact.years.flatMap((year) => [year.joined, year.left]).filter(Number.isFinite);
  const maxFlow = Math.max(1, ...flowValues);
  return (
    <section className="lifecycle-section">
      <SectionTitle sub={copy.impactSub}>{copy.impact}</SectionTitle>
      <div className="stat-grid lifecycle-stats">
        <StatCard label={copy.campaigns10} value={impact.summary.campaigns ?? copy.suppressed} tone="green" />
        <StatCard label={copy.certified10} value={impact.summary.certified ?? copy.suppressed} tone="green" />
        <StatCard label={copy.contracts10} value={impact.summary.firstContracts ?? copy.suppressed} tone="gold" />
        <StatCard label={copy.stageSpeed} value={slowestStage?.days ?? "—"} suffix={slowestStage ? ` ${copy.days}` : ""} tone="gold" />
      </div>
      <article className="lifecycle-panel">
        <header className="lifecycle-panel__header"><div><h2>{copy.membershipFlow}</h2><p>{impact.period} · {impact.source}</p></div></header>
        <div className="impact-bars" aria-hidden="true">
          {impact.years.map((year) => (
            <div key={year.year}>
              <span className="impact-bars__pair">
                {Number.isFinite(year.joined) ? <i style={{ height: `${year.joined === 0 ? 0 : Math.max(4, Math.round((year.joined / maxFlow) * 72))}px` }} /> : null}
                {Number.isFinite(year.left) ? <i style={{ height: `${year.left === 0 ? 0 : Math.max(4, Math.round((year.left / maxFlow) * 72))}px` }} /> : null}
              </span>
              <small>{String(year.year).slice(2)}</small>
            </div>
          ))}
        </div>
        <div className="impact-legend"><span><i />{copy.joined}</span><span><i />{copy.left}</span></div>
        <div className="impact-table-wrap">
          <table className="impact-table">
            <caption>{copy.membershipFlow}</caption>
            <thead><tr><th scope="col">{copy.year}</th><th scope="col">{copy.joined}</th><th scope="col">{copy.left}</th><th scope="col">{copy.net}</th></tr></thead>
            <tbody>
              {impact.years.map((year) => (
                <tr key={year.year}>
                  <th scope="row">{year.year}</th>
                  <td>{year.joined ?? copy.suppressed}</td>
                  <td>{year.left ?? copy.suppressed}</td>
                  <td>{netGrowth(year) ?? copy.suppressed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
      <article className="lifecycle-panel">
        <header className="lifecycle-panel__header"><div><h2>{copy.lifecycleConversion}</h2><p>{copy.conversionSub}</p></div></header>
        <div className="lifecycle-ladder">
          {impact.funnel.map((row) => {
            const privacy = suppressSmall(row.advanced, row.eligible);
            const percent = privacy.suppressed ? null : safePercent(row.advanced, row.eligible);
            return (
              <div key={`${row.path}-${row.stage}`}>
                <span>{row.path === "shared" ? "" : `${row.path} · `}{stageLabel(row.stage, lang)}</span>
                <i aria-hidden="true">{percent === null ? null : <b style={{ width: `${percent}%` }} />}</i>
                <strong>{privacy.suppressed ? copy.suppressed : `${row.advanced}/${row.eligible}`}</strong>
              </div>
            );
          })}
        </div>
      </article>
      <article className="lifecycle-panel">
        <header className="lifecycle-panel__header"><div><h2>{copy.stageSpeed}</h2><p>{copy.stageSpeedSub}</p></div></header>
        <div className="lifecycle-register">
          {impact.medianDays.map((row) => (
            <div key={row.stage}><span><strong>{transitionLabel(row.stage, lang)}</strong></span><ToneChip tone="blue">{row.days} {copy.days}</ToneChip></div>
          ))}
        </div>
      </article>
      <aside className="lifecycle-method">
        <TrendingUp size={18} />
        <div><strong>{copy.method}</strong><p>{impact.method}</p><small>{copy.asOf} {impact.asOf} · K={impact.suppressionMinimum}</small></div>
      </aside>
    </section>
  );
}

export function OrganizeView({ data, api, onProfile, onAssistant }) {
  const { lang } = useLang();
  const copy = COPY[lang] || COPY.en;
  const [workspace, setWorkspace] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [refreshWarning, setRefreshWarning] = useState("");
  const [writersFrozen, setWritersFrozen] = useState(false);
  const [tab, setTab] = useState("campaigns");
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [writer, setWriter] = useState("");
  const [writerCampaignId, setWriterCampaignId] = useState("");
  const [writerTargetId, setWriterTargetId] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingIntegrityHoldCampaignIds, setPendingIntegrityHoldCampaignIds] = useState([]);
  const [pendingRatificationCorrections, setPendingRatificationCorrections] = useState([]);
  const loadGeneration = useRef(0);
  const workspaceFocusRef = useRef(null);

  function focusWorkspace() {
    requestAnimationFrame(() => workspaceFocusRef.current?.focus({ preventScroll: true }));
  }

  const loadWorkspace = useCallback(async () => {
    const generation = ++loadGeneration.current;
    let next;
    try {
      next = await api.loadWorkspace();
    } catch (err) {
      if (generation !== loadGeneration.current) return null;
      throw err;
    }
    if (generation !== loadGeneration.current) return null;
    setWorkspace(next);
    setPendingIntegrityHoldCampaignIds([]);
    setPendingRatificationCorrections([]);
    setSelectedCampaignId((current) => (
      next.campaigns?.some((item) => item.id === current)
        ? current
        : next.campaigns?.[0]?.id || ""
    ));
    if (!next.campaigns?.length) setTab("engagement");
    return next;
  }, [api]);

  useEffect(() => {
    setWorkspace(null);
    setLoadError("");
    setRefreshWarning("");
    setWritersFrozen(false);
    loadWorkspace().catch(() => setLoadError(copy.refreshFailed));
    return () => { loadGeneration.current += 1; };
  }, [loadWorkspace]);

  const campaign = useMemo(
    () => workspace?.campaigns?.find((item) => item.id === selectedCampaignId) || workspace?.campaigns?.[0] || null,
    [workspace, selectedCampaignId],
  );
  const availableTabs = campaign ? TABS : TABS.slice(4);
  const milestoneChoices = campaign && workspace ? nextStageChoices(campaign, workspace) : [];
  const canWrite = Boolean(
    workspace?.mode === "live"
    && !workspace.access?.aggregateOnly
    && campaign?.canOperate === true
    && campaign.status !== "closed"
    && !writersFrozen,
  );
  const canRecordMilestone = canWrite
    && campaign.status === "active"
    && milestoneChoices.length > 0
    && typeof api.transitionCampaign === "function";
  const canManageStatus = canWrite
    && ["active", "paused"].includes(campaign.status)
    && typeof api.setCampaignStatus === "function";
  const bargaining = workspace?.bargaining?.find(
    (item) => item.campaignId === campaign?.id,
  ) || null;
  const bargainingWritersEnabled = Boolean(
    workspace?.mode === "live"
    && !workspace.access?.aggregateOnly
    && (
      campaign?.status === "active"
      || (
        campaign?.status === "closed"
        && campaign?.stage === "established"
        && campaign?.outcome === "established"
      )
    )
    && !writersFrozen,
  );
  // The workspace RPC exposes no canResolveIntegrityHold flag, and it cannot
  // be inferred from the two it does expose: the hold state nulls
  // current_ratification_id (so canCorrectRatification is false) and the phase
  // is execution/complete (so canWrite is false). The RPC is therefore the
  // authorization boundary — it re-checks MFA, the coordinator writer lock and
  // the correction-to-contract linkage — and this gate is visibility only, kept
  // to the same live/non-aggregate/not-frozen conditions as the other writers.
  const canResolveIntegrityHold = Boolean(
    bargainingWritersEnabled
    && bargaining
    && (bargaining.ratificationIntegrityHold || pendingIntegrityHoldCampaignIds.includes(campaign?.id))
    && typeof api.resolveRatificationIntegrityHold === "function",
  );
  const bargainingMode = writer.startsWith("bargaining:")
    ? writer.slice("bargaining:".length)
    : "";
  const bargainingTarget = bargainingMode === "proposalStatus"
    ? bargaining?.proposals?.find((item) => item.id === writerTargetId) || null
    : bargainingMode === "sessionOutcome"
      ? bargaining?.sessions?.find((item) => item.id === writerTargetId) || null
      : bargainingMode === "ratificationCorrection"
        ? bargaining?.ratifications?.find((item) => item.id === writerTargetId) || null
        : null;
  const bargainingPhase = bargaining?.phase || bargaining?.status;
  const bargainingWriterAllowed = !bargainingMode || (
    bargainingWritersEnabled
    && (
      (
        bargainingMode === "open"
        && !bargaining
        && campaign?.canOpenBargaining === true
      )
      || (
        bargaining
        && (
          (
            bargainingMode === "ratification"
            && bargaining.canCertify === true
            && bargaining.canAdvanceToRatification === true
            && ["tentative_agreement", "ratification"].includes(bargainingPhase)
            && bargaining.proposals.some((proposal) => proposal.status === "tentative_agreement")
          )
          || (
            bargainingMode === "contract"
            && bargaining.canRecordFirstContract === true
            && bargaining.ratifications.some((record) => record.current && !record.corrected)
          )
          || (
            bargainingMode === "ratificationCorrection"
            && bargaining.canCorrectRatification === true
            && bargainingTarget?.current === true
            && bargainingTarget?.corrected !== true
          )
          || (
            bargainingMode === "sessionOutcome"
            && bargaining.canRecordSessionOutcome === true
            && bargainingTarget?.status === "scheduled"
          )
          || (
            !["ratification", "ratificationCorrection", "contract"].includes(bargainingMode)
            && bargainingMode !== "sessionOutcome"
            && bargaining.canWrite === true
            && (bargainingMode !== "phase" || phaseChoices(bargaining).length > 0)
            && (
              bargainingMode !== "proposal"
              || !["ratification", "execution", "complete"].includes(bargainingPhase)
            )
            && (
              bargainingMode !== "session"
              || !["execution", "complete"].includes(bargainingPhase)
            )
            && (bargainingMode !== "proposalStatus" || (
              bargainingTarget
              && !["ratification", "execution", "complete"].includes(bargainingPhase)
              && proposalChoices(bargainingTarget, bargaining).length > 0
            ))
          )
        )
      )
    )
  );
  const bargainingCalls = {
    open: api.openBargainingCycle,
    phase: api.transitionBargainingCycle,
    proposal: api.createBargainingProposal,
    proposalStatus: api.transitionBargainingProposal,
    session: api.scheduleBargainingSession,
    sessionOutcome: api.recordBargainingSessionOutcome,
    ratification: api.recordRatification,
    ratificationCorrection: api.correctRatification,
    contract: api.recordFirstContract,
  };

  useEffect(() => {
    if (
      (writer === "milestone" && !canRecordMilestone)
      || (writer === "status" && !canManageStatus)
      || (writer === "resolveHold" && !canResolveIntegrityHold)
      || (bargainingMode && !bargainingWriterAllowed)
      || (writer && writerCampaignId !== campaign?.id)
    ) {
      setWriter("");
      setWriterCampaignId("");
      setWriterTargetId("");
    }
  }, [
    writer,
    writerCampaignId,
    campaign?.id,
    canRecordMilestone,
    canManageStatus,
    canResolveIntegrityHold,
    bargainingMode,
    bargainingWriterAllowed,
  ]);

  function openBargainingWriter(mode, targetId = "") {
    setNotice("");
    setWriter(`bargaining:${mode}`);
    setWriterCampaignId(campaign.id);
    setWriterTargetId(targetId);
  }

  async function createCampaign(fields) {
    const receipt = await api.createCampaign(fields);
    setNotice(receipt.changed === false ? copy.recovered : copy.created);
    setCreateOpen(false);
    setWritersFrozen(true);
    try {
      const next = await loadWorkspace();
      if (!next) return receipt;
      setSelectedCampaignId(receipt.campaignId);
      setTab("campaigns");
      setLoadError("");
      setRefreshWarning("");
      setWritersFrozen(false);
      focusWorkspace();
    } catch {
      setWritersFrozen(true);
      setRefreshWarning(copy.createdRefreshFailed);
    }
    return receipt;
  }

  async function runWriter(call, fields, savedMessage, recoveredMessage) {
    let receipt;
    try {
      receipt = await call(fields);
    } catch (err) {
      if (err.code === "40001") {
        try {
          await loadWorkspace();
          setRefreshWarning("");
        } catch {
          setWritersFrozen(true);
          setRefreshWarning(copy.refreshFailed);
          setWriter("");
          setWriterCampaignId("");
          setWriterTargetId("");
          const reloadError = new Error(copy.refreshFailed);
          reloadError.code = "WORKSPACE_RELOAD_FAILED";
          throw reloadError;
        }
      }
      throw err;
    }

    if (receipt.integrityHold === true && receipt.campaignId) {
      setPendingIntegrityHoldCampaignIds((current) => (
        current.includes(receipt.campaignId)
          ? current
          : [...current, receipt.campaignId]
      ));
    }
    if (
      receipt.corrected === true
      && receipt.campaignId
      && receipt.ratificationId
    ) {
      setPendingRatificationCorrections((current) => [
        ...current.filter((item) => item.ratificationId !== receipt.ratificationId),
        {
          campaignId: receipt.campaignId,
          ratificationId: receipt.ratificationId,
          reasonCode: receipt.reasonCode,
        },
      ]);
    }
    setNotice(receipt.changed === false ? recoveredMessage : savedMessage);
    setWriter("");
    setWriterCampaignId("");
    setWriterTargetId("");
    setWritersFrozen(true);
    try {
      await loadWorkspace();
      setRefreshWarning("");
      setWritersFrozen(false);
      focusWorkspace();
    } catch {
      setWritersFrozen(true);
      setRefreshWarning(copy.savedRefreshFailed);
    }
    return receipt;
  }

  async function reloadWorkspace() {
    setLoadError("");
    try {
      const next = await loadWorkspace();
      if (!next) return;
      setRefreshWarning("");
      setWritersFrozen(false);
    } catch {
      if (workspace) setRefreshWarning(copy.refreshFailed);
      else setLoadError(copy.refreshFailed);
    }
  }

  function moveTab(event, current) {
    const keyMoves = { ArrowRight: 1, ArrowLeft: -1, Home: "first", End: "last" };
    const move = keyMoves[event.key];
    if (move == null) return;
    event.preventDefault();
    const index = availableTabs.indexOf(current);
    const nextIndex = move === "first"
      ? 0
      : move === "last"
        ? availableTabs.length - 1
        : (index + move + availableTabs.length) % availableTabs.length;
    const next = availableTabs[nextIndex];
    setTab(next);
    requestAnimationFrame(() => {
      const element = document.getElementById(`lifecycle-tab-${next}`);
      element?.focus();
      element?.scrollIntoView?.({ block: "nearest", inline: "center", behavior: "smooth" });
    });
  }

  return (
    <div className="screen lifecycle-screen">
      <ScreenHeader initials={data.member.initials} eyebrow={copy.eyebrow} title={copy.title} compact onProfile={onProfile} onAssistant={onAssistant} />

      {loadError && !workspace && <div role="alert"><EmptyState><p>{loadError}</p><button type="button" className="outline-pill" onClick={reloadWorkspace}>{copy.retry}</button></EmptyState></div>}
      {!loadError && !workspace && <div className="lifecycle-loading" role="status"><span /><p>{copy.loading}</p></div>}

      {workspace && (
        <>
          <section className="lifecycle-intro">
            <div className="lifecycle-intro__row">
              <div>{workspace.mode === "demo" ? <ToneChip tone="gold">{copy.demo}</ToneChip> : null}<ToneChip tone="green">{copy.private}</ToneChip></div>
              {workspace.mode === "live" && workspace.access?.canCreateCampaign && api.createCampaign && !writersFrozen && (
                <button type="button" className="outline-pill" onClick={() => { setNotice(""); setCreateOpen(true); }}>
                  <Plus size={15} aria-hidden="true" /> {copy.createCampaign}
                </button>
              )}
            </div>
            <p>{workspace.methodology.detail}</p>
          </section>
          {notice && <p className="lifecycle-status" role="status">{notice}</p>}
          {refreshWarning && (
            <div className="lifecycle-refresh-warning" role="alert">
              <p>{refreshWarning}</p>
              {writersFrozen && <small>{copy.writersFrozen}</small>}
              <button type="button" className="outline-pill" onClick={reloadWorkspace}>{copy.reloadWorkspace}</button>
            </div>
          )}

          {campaign && <section className="lifecycle-campaign-picker" ref={workspaceFocusRef} tabIndex={-1}>
            <SectionTitle sub={copy.campaignPickerSub}>{copy.campaignPicker}</SectionTitle>
            {/* The shared RadioGroup owns the one Tab stop and the arrow,
                Home and End model; selection still travels through each
                option's onClick, so the keyboard also clears the writer. */}
            <RadioGroup aria-label={copy.campaignPicker}>
              {workspace.campaigns.map((item) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={campaign.id === item.id}
                  key={item.id}
                  onClick={() => {
                    setSelectedCampaignId(item.id);
                    setWriter("");
                    setWriterCampaignId("");
                    setWriterTargetId("");
                  }}
                >
                  <span><strong>{item.name}</strong><small>{item.employerName} · {item.worksiteName}</small></span>
                  <span>
                    {campaign.id === item.id ? <small className="lifecycle-selected">✓ {copy.selected}</small> : null}
                    {item.status && (
                      <ToneChip tone={item.status === "active" ? "green" : item.status === "paused" ? "gold" : "neutral"}>
                        {statusLabel(item.status, lang)}
                      </ToneChip>
                    )}
                    <ToneChip tone={campaign.id === item.id ? "green" : "neutral"}>{stageLabel(item.stage, lang)}</ToneChip>
                    <ArrowRight size={16} />
                  </span>
                </button>
              ))}
            </RadioGroup>
          </section>}

          {(canRecordMilestone || canManageStatus) && (
            <div className="lifecycle-command-bar" role="group" aria-label={copy.campaignStatus}>
              {canRecordMilestone && (
                <button type="button" className="outline-pill" onClick={() => {
                  setNotice("");
                  setWriter("milestone");
                  setWriterCampaignId(campaign.id);
                }}>
                  <CheckCircle2 size={16} aria-hidden="true" /> {copy.recordMilestone}
                </button>
              )}
              {canManageStatus && (
                <button type="button" className="outline-pill" onClick={() => {
                  setNotice("");
                  setWriter("status");
                  setWriterCampaignId(campaign.id);
                }}>
                  <CalendarClock size={16} aria-hidden="true" /> {copy.manageStatus}
                </button>
              )}
            </div>
          )}

          <nav className="lifecycle-tabs" role="tablist" aria-label={copy.title}>
            {availableTabs.map((item) => (
              <button
                type="button"
                role="tab"
                id={`lifecycle-tab-${item}`}
                aria-controls="lifecycle-panel-active"
                aria-selected={tab === item}
                tabIndex={tab === item ? 0 : -1}
                key={item}
                onClick={() => {
                  setTab(item);
                  requestAnimationFrame(() => document.getElementById(`lifecycle-tab-${item}`)?.scrollIntoView?.({
                    block: "nearest",
                    inline: "center",
                    behavior: "smooth",
                  }));
                }}
                onKeyDown={(event) => moveTab(event, item)}
              >
                {copy.tabs[item]}
              </button>
            ))}
          </nav>

          <div role="tabpanel" id="lifecycle-panel-active" aria-labelledby={`lifecycle-tab-${tab}`} tabIndex={0}>
            {tab === "campaigns" && campaign && <CampaignsPanel workspace={workspace} campaign={campaign} copy={copy} lang={lang} />}
            {tab === "worksites" && campaign && <WorksitesPanel workspace={workspace} campaign={campaign} copy={copy} />}
            {tab === "resistance" && campaign && <ResistancePanel workspace={workspace} campaign={campaign} copy={copy} lang={lang} />}
            {tab === "bargaining" && campaign && (
              <BargainingPanel
                workspace={workspace}
                campaign={campaign}
                copy={copy}
                lang={lang}
                writersEnabled={bargainingWritersEnabled}
                onWrite={openBargainingWriter}
                integrityHoldPending={pendingIntegrityHoldCampaignIds.includes(campaign.id)}
                pendingRatificationCorrections={pendingRatificationCorrections.filter(
                  (correction) => correction.campaignId === campaign.id,
                )}
                canResolveIntegrityHold={canResolveIntegrityHold}
                onResolveIntegrityHold={() => {
                  setNotice("");
                  setWriter("resolveHold");
                  setWriterCampaignId(campaign.id);
                  setWriterTargetId("");
                }}
              />
            )}
            {tab === "engagement" && <EngagementPanel workspace={workspace} copy={copy} />}
            {tab === "coalitions" && <CoalitionsPanel workspace={workspace} copy={copy} lang={lang} />}
            {tab === "impact" && <ImpactPanel workspace={workspace} copy={copy} lang={lang} />}
          </div>
        </>
      )}
      {createOpen && (
        <CreateCampaignDialog
          copy={copy}
          onClose={() => setCreateOpen(false)}
          onCreate={createCampaign}
          restoreFocusRef={workspaceFocusRef}
        />
      )}
      {writer === "milestone" && campaign && writerCampaignId === campaign.id && (
        <MilestoneDialog
          campaign={campaign}
          choices={milestoneChoices}
          copy={copy}
          lang={lang}
          restoreFocusRef={workspaceFocusRef}
          onClose={() => {
            setWriter("");
            setWriterCampaignId("");
            setWriterTargetId("");
          }}
          onSave={(fields) => runWriter(
            api.transitionCampaign,
            fields,
            copy.milestoneSaved,
            copy.milestoneRecovered,
          )}
        />
      )}
      {writer === "status" && campaign && writerCampaignId === campaign.id && (
        <CampaignStatusDialog
          campaign={campaign}
          canClose={workspace.access?.chapterWideOperations === true}
          copy={copy}
          lang={lang}
          restoreFocusRef={workspaceFocusRef}
          onClose={() => {
            setWriter("");
            setWriterCampaignId("");
            setWriterTargetId("");
          }}
          onSave={(fields) => runWriter(
            api.setCampaignStatus,
            fields,
            copy.statusSaved,
            copy.statusRecovered,
          )}
        />
      )}
      {writer === "resolveHold" && campaign && writerCampaignId === campaign.id && bargaining && canResolveIntegrityHold && (
        <ResolveIntegrityHoldDialog
          cycle={bargaining}
          copy={copy}
          restoreFocusRef={workspaceFocusRef}
          onClose={() => {
            setWriter("");
            setWriterCampaignId("");
            setWriterTargetId("");
          }}
          onSave={(fields) => runWriter(
            api.resolveRatificationIntegrityHold,
            fields,
            copy.resolveHoldSaved,
            copy.resolveHoldRecovered,
          )}
        />
      )}
      {bargainingMode
        && bargainingWriterAllowed
        && campaign
        && writerCampaignId === campaign.id
        && (bargainingMode === "open" || bargaining)
        && (!["proposalStatus", "sessionOutcome"].includes(bargainingMode) || bargainingTarget)
        && typeof bargainingCalls[bargainingMode] === "function"
        && (
          <BargainingWriterDialog
            mode={bargainingMode}
            campaign={campaign}
            cycle={bargaining}
            target={bargainingTarget}
            lang={lang}
            restoreFocusRef={workspaceFocusRef}
            onClose={() => {
              setWriter("");
              setWriterCampaignId("");
              setWriterTargetId("");
            }}
            onSave={(fields) => runWriter(
              bargainingCalls[bargainingMode],
              fields,
              copy.bargainingSaved,
              copy.bargainingRecovered,
            )}
          />
        )}
    </div>
  );
}
