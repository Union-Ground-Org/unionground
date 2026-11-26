import { prepareBusyWrite, runBusyWrite } from "../lib/busyWrite.js";
import { BusyButton } from "../components/BusyControls.jsx";
import { useRoutedTab, RoutedTabLink, useWorkspace, workspaceHref } from "../components/WorkspacePages.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { localeFor } from "../lib/i18n.js";
import { formatGroupMoment } from "../lib/i18n/zonedDates.js";
import { featureActorIdentityKey } from "../lib/featureActorIdentity.js";
import { ONBOARDING_GUIDE_REFRESH_EVENT } from "../lib/onboardingGuide.js";
import { publicContact } from "../lib/publicContact.js";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ACCOMMODATION_TYPES,
  EMERGENCY_SCENARIOS,
  HR_CONTACT_DISPOSITIONS,
  MEMBER_SUPPORT_TABS,
  canInitiateMemberHandoff,
  classifyMemberSupportError,
  createMemberSupportAdapter,
  normalizeMemberSupportActor,
} from "../features/memberSupport/index.js";
import { openOnboardingSteps } from "../features/memberSupport/onboardingOversight.js";
import { MemberGuidePreview, OnboardingChapterProgress, OnboardingProgressPeople, OnboardingProgressSummary, OnboardingRowFollowUp, OnboardingSetupSection, SkipStepForm } from "../features/memberSupport/OnboardingAdminSide.jsx";
import { nextStepPosition } from "../features/onboardingGuideEngine/adminSide.js";
import "../features/memberSupport/member-support.css";
import { Icon } from "../alt/icons.jsx";
import { HelpCrumbs } from "../alt/help/HelpParts.jsx";
import { HelpMatcher } from "../alt/help/HelpMatcher.jsx";
import "../lib/i18n/features/altHelpPagesStrings.js";
import "../lib/i18n/features/onboardingAdminStrings.js";

function label(value) {
  return String(value || "").replaceAll("_", " ");
}

function machineLabel(map, value) {
  return map?.[value] || label(value);
}

function scenarioCopy(copy, item) {
  return copy.rights.scenarios[item.id] || item;
}

// Local bilingual copy for the shared desk chrome, the five member-support
// panels, and the focused handoffs page.
const COPY = {
  en: {
    eyebrow: "Worker support",
    workspaceAria: "Worker support workspace",
    title: "Rights, requests, and development",
    description: "Use one protected workspace for urgent guidance, accommodation intake, HR outreach, onboarding, and mentorship.",
    staffScope: "{hat} workspace",
    hats: { steward: "Committee", coordinator: "Campaign lead", advisor: "Advisor", admin: "Admin", vp: "Campaign chair" },
    memberScope: "my records",
    tabs: { rights: "Emergency rights", accommodations: "Accommodations", hr: "HR contact", onboarding: "Onboarding", mentorship: "Mentorship", handoffs: "Handoffs" },
    loading: "Loading worker support…",
    states: {
      empty: ["Organization setup is still empty", "These programs become available after an administrator creates the first organization and activates workership."],
      mfa_required: ["Two-step sign-in required", "Your current sign-in hasn't passed two-step verification. Sign in again and enter your two-step code, then come back. Your two-step setup is in Settings."],
      unauthorized: ["Worker support isn't open to this role", "Go back to Worker, or choose a staff role this account actually has. Ask an administrator if a role you need is missing."],
      unavailable: ["Worker support isn't available right now", "Try again later. If it keeps failing, ask an administrator."],
      error: ["Worker support could not be loaded", "Try again. No protected record was changed. If it keeps failing, ask an administrator."],
    },
    stateActions: { signInAgain: "Sign in again", twoStepSettings: "Two-step settings", backToMember: "Back to Worker", writeSupport: "Write to support" },
    retry: "Try again",
    saveFailed: "That change could not be saved.",
    invalidInput: "Some details were not accepted. Check the form and try again.",
    handoffs: {
      eyebrow: "Two-sided responsibility transfer",
      title: "Committee handoffs",
      pending: "{count} pending",
      intro: "A receiving committee member must acknowledge before the durable relationship changes. The completed transfer remains in history.",
      oversightOnly: "Your hat can review handoff history. A committee member, campaign lead, admin or campaign chair starts a handoff.",
      searchMembers: "Search workers",
      search: "Search",
      searchMembersAria: "Search workers for handoff",
      searchStewards: "Search receiving committee members",
      searchStewardsAria: "Search receiving committee members",
      searchMinimum: "Type at least {count} characters to search.",
      memberSearchFailed: "Worker search could not be completed.",
      stewardSearchFailed: "Committee member search could not be completed.",
      loadFailed: "Handoff history could not be loaded.",
      olderFailed: "Older handoffs could not be loaded.",
      member: "Worker",
      steward: "Receiving committee member",
      note: "Handoff note",
      noteHint: "Include only the context the receiving committee member needs.",
      chooseMember: "Choose from search results",
      send: "Send handoff",
      sent: "Handoff sent for acknowledgement.",
      status: "Status",
      statuses: { "": "All", pending: "Pending", acknowledged: "Acknowledged", declined: "Declined", cancelled: "Cancelled" },
      directions: { incoming: "Incoming", outgoing: "Outgoing", overseen: "Overseen" },
      noHistory: ["No handoff history", "Incoming, outgoing, and overseen handoffs will appear here."],
      dateUnavailable: "Date unavailable",
      acknowledge: "Acknowledge",
      acknowledged: "Handoff acknowledged and relationship updated.",
      decline: "Decline",
      declined: "Handoff declined.",
      cancel: "Cancel",
      cancelConfirm: "Cancel the pending handoff for {name}?",
      cancelled: "Handoff cancelled.",
      loadOlder: "Load older handoffs",
    },
    rights: {
      eyebrow: "Time-sensitive guidance",
      title: "Emergency rights checklist",
      notStarted: "Not started",
      scenarioAria: "Emergency scenario",
      alertsTitle: "Open committee alerts",
      noAlerts: ["No open alerts", "Worker alerts that need a response will appear here."],
      stepsSaved: "{completed} of {total} checklist steps saved.",
      resolveAlert: "Resolve alert",
      alertResolved: "Alert for {name} resolved.",
      step: "Step {n}",
      notes: "Private incident notes",
      notesHint: "Only include what an authorized committee member needs to respond.",
      save: "Save progress",
      saved: "Checklist progress saved.",
      alertSteward: "Alert a committee member now",
      stewardAlerted: "Committee member alerted",
      urgentSent: "Urgent committee alert sent.",
      markResolved: "Mark alert resolved",
      emergencyResolved: "Emergency alert resolved.",
      //  B-23: the chip is the steward ALERT's state, not the checklist's;
      // a bare "resolved" over an unchecked step read as a finished list.
      statuses: { draft: "Saved, no alert sent", alerted: "Committee member alerted", resolved: "Alert resolved" },
      scenarios: {
        disciplinary_meeting: {
          label: "Disciplinary meeting",
          summary: "Ask whether it could lead to discipline, ask for a coworker to be present, and keep a record while you reach the committee.",
          steps: [
            "Ask whether the meeting could lead to discipline.",
            "Ask for a coworker to be present. The employer may say no, but asking is still worth it.",
            "Stay calm. Don't guess or speculate, don't sign anything you disagree with, and ask for a copy of anything you are given or asked to sign.",
            "Right after, write down the time, place, people, and documents, and tell a committee member or organizer.",
          ],
        },
        pre_discipline_response: {
          label: "Pre-discipline response",
          summary: "Use the response window to understand the charges, gather records, and prepare a supported answer.",
          steps: [
            "Request the allegations and supporting material in writing.",
            "Confirm the response deadline.",
            "Contact a committee member before submitting a response.",
            "Keep a copy of everything submitted.",
          ],
        },
        unsafe_work: {
          label: "Unsafe work",
          summary: "Address immediate danger first, then preserve facts and use the appropriate safety channel.",
          steps: [
            "Move away from immediate danger when you can do so safely.",
            "Notify the appropriate emergency or workplace safety contact.",
            "Document the condition without exposing protected worker information.",
            "Contact a committee member for follow-through.",
          ],
        },
      },
    },
    accommodations: {
      eyebrow: "Structured intake",
      title: "Accommodation requests",
      openCount: "{count} open",
      requestType: "Request type",
      description: "What change or support are you requesting?",
      descriptionHint: "Do not add medical records or a diagnosis unless the process explicitly requires it.",
      submit: "Submit request",
      submitted: "Accommodation request submitted.",
      empty: ["No requests yet", "A submitted request and its status history will appear here."],
      dateUnavailable: "date unavailable",
      staffUpdate: "Staff update:",
      withdraw: "Withdraw request",
      withdrawn: "Request withdrawn.",
      statusFor: "Status for {name}",
      staffNoteFor: "Staff note for {name}",
      update: "Update",
      statusUpdated: "Request status updated.",
      types: { schedule: "Schedule", equipment: "Equipment", workspace: "Workspace", leave: "Leave", communication: "Communication", remote_work: "Remote work", other: "Other" },
      statuses: { submitted: "Submitted", under_review: "Under review", approved: "Approved", denied: "Denied", withdrawn: "Withdrawn" },
    },
    hr: {
      eyebrow: "Focused outreach record",
      title: "HR contact",
      directoryName: "Human Resources",
      call: "Call",
      email: "Email",
      hours: "Hours:",
      emptyDirectory: ["HR directory is not configured", "A staff administrator can add the organization’s own contact information. No placeholder identity is shown."],
      recordContact: "Record contact",
      member: "Worker",
      chooseMember: "Choose a worker",
      channel: "Channel",
      purpose: "Purpose",
      disposition: "Disposition",
      when: "When",
      followUpDate: "Follow-up date",
      followUpRequired: "Required when the disposition is “Follow-up due”.",
      note: "Note",
      saveContact: "Save contact",
      contactSaved: "HR contact recorded.",
      configureDirectory: "Configure HR directory",
      notes: "Notes",
      saveDirectory: "Save directory",
      directorySaved: "HR directory saved.",
      directoryEnabled: "Show this HR directory to workers",
      directoryEnabledHelp: "A hidden directory is not shown to anyone. To show it again, enter its contact details and save with this box checked.",
      emptyHistory: ["No HR contact history", "Structured contact attempts and outcomes will appear here."],
      dateUnavailable: "date unavailable",
      followUp: "Follow up {date}",
      fields: { name: "Name", title: "Title", department: "Department", email: "Email", phone: "Phone", hours: "Hours" },
      channels: { email: "Email", phone: "Phone", meeting: "Meeting", letter: "Letter", portal: "Portal", other: "Other" },
      dispositions: { planned: "Planned", attempted: "Attempted", reached: "Reached", follow_up_due: "Follow-up due", resolved: "Resolved" },
    },
    onboarding: {
      eyebrow: "Getting started",
      title: "New-worker onboarding",
      notAssigned: "Not assigned",
      // REQ-UG-DEFAULT-NEW-MEMBER-ONBOARDING-PROGRAM-20261006: owner
      // decision October 8, 2026 (11:28 AM ET). Content only: shown while the
      // organization has no active step of its own, never stored, never a plan.
      defaultProgram: {
        title: "Getting started",
        note: "Your campaign has no onboarding steps turned on right now, so here is where most new workers start. When your campaign turns on its own steps, they replace this list.",
        steps: [
          ["Welcome", "Union Ground is where you find your organizing rights, your committee contact and your campaign’s news.", "/m"],
          ["Finish your profile", "Open your profile (Settings on the web, Account in the app) and check that your name is right. Then check your campaign (in Settings on the web, at the top of Home in the app), so your committee knows who you are.", "/m/settings"],
          ["Meet your committee contact", "Use Find my committee contact on Home to see who to reach. Send them a short hello in Messages so you know who to ask.", "/m"],
          ["Read the organizing guide", "Open Organizing rights and start with the first lesson.", "/m/rights"],
        ],
        staffNote: "Until you add an active step, workers see the Union Ground starting list (welcome, finish your profile, meet your committee contact, read the organizing guide). Your first active step replaces it. Worker plans start only from your own steps.",
      },
      startPlan: "Start my onboarding plan",
      started: "Onboarding plan started.",
      completeStep: "Complete “{title}”",
      stepCompleted: "Onboarding step completed.",
      manage: "Manage program and oversight",
      stepTitle: "Step title",
      position: "Position",
      description: "Description",
      addStep: "Add step",
      stepSaved: "Onboarding step saved.",
      programSteps: "Program steps",
      stepActive: "active",
      stepInactive: "turned off",
      activateStep: "Turn on",
      deactivateStep: "Turn off",
      activateStepName: "Turn on step {title}",
      deactivateStepName: "Turn off step {title}",
      stepActivated: "Onboarding step turned on.",
      stepDeactivated: "Onboarding step turned off.",
      startMemberPlan: "Start selected worker plan",
      memberToStart: "Worker to start",
      chooseMember: "Choose a worker",
      memberStarted: "Worker onboarding plan started.",
      noStartableMembers: "Every worker in the directory already has an onboarding plan.",
      stepsComplete: "{completed} of {total} steps complete",
      statuses: { not_started: "Not started", in_progress: "In progress", completed: "Completed", draft: "Draft", active: "Active" },
      oversightTitle: "Worker progress",
      stalled: "Stalled",
      stalledDetail: "Under {percent}% complete more than {days} days after onboarding was assigned",
      autoEnrolled: "Enrolled automatically",
      progress: "{completed} of {total} steps ({percent}%)",
      stepFor: "Step for {name}",
      chooseStep: "Choose a step",
      markComplete: "Mark complete",
      skipStep: "Skip step",
      resetProgress: "Reset progress",
      resetConfirm: "Reset all onboarding progress for {name}? This cannot be undone.",
      stepMarkedComplete: "Step marked complete.",
      stepSkipped: "Step skipped.",
      progressReset: "Onboarding progress reset.",
      overridesOff: "Staff changes to worker onboarding are turned off in Feature switches & limits.",
      rosterTruncated: "Showing {shown} of {total} workers.",
    },
    mentorship: {
      eyebrow: "Pairing and outcomes",
      title: "Mentorship",
      activeCount: "{count} active",
      createPairing: "Create a pairing",
      mentor: "Mentor",
      mentee: "Mentee",
      choose: "Choose",
      startDate: "Start date",
      create: "Create pairing",
      created: "Mentorship pair created.",
      empty: ["No mentorship pair yet", "Staff can create a formal pairing without exposing it outside its participants and authorized team."],
      started: "Started {date}",
      dateUnavailable: "date unavailable",
      outcome: "Outcome:",
      goals: "Goals",
      noGoals: "No goals yet.",
      goalUpdated: "Mentorship goal updated.",
      newGoal: "New goal for {name}",
      addGoal: "Add goal",
      goalSaved: "Mentorship goal saved.",
      notes: "Notes",
      newNote: "New note for {name}",
      addNote: "Add note",
      noteSaved: "Mentorship note saved.",
      closePairing: "Close pairing",
      statusUpdated: "Mentorship status updated.",
      statusFor: "New status for {name}",
      outcomeFor: "Outcome for {name}",
      statuses: { active: "Active", completed: "Completed", cancelled: "Cancelled" },
    },
  },
  es: {
    eyebrow: "Apoyo a trabajadores",
    workspaceAria: "Espacio de apoyo a trabajadores",
    title: "Derechos, solicitudes y desarrollo",
    description: "Usa un espacio protegido para orientación urgente, solicitudes de adaptación, contacto con RR. HH., incorporación y mentoría.",
    staffScope: "espacio de {hat}",
    hats: { steward: "comité", coordinator: "liderazgo de campaña", advisor: "asesoría", admin: "administración", vp: "presidencia de campaña" },
    memberScope: "mis registros",
    tabs: { rights: "Derechos de emergencia", accommodations: "Adaptaciones", hr: "Contacto de RR. HH.", onboarding: "Incorporación", mentorship: "Mentoría", handoffs: "Traspasos" },
    loading: "Cargando apoyo a trabajadores…",
    states: {
      empty: ["La organización aún está vacía", "Estos programas estarán disponibles cuando una administración cree la primera organización y active la membresía."],
      mfa_required: ["Se requiere verificación en dos pasos", "Tu sesión actual no ha pasado la verificación en dos pasos. Inicia sesión de nuevo e introduce tu código de dos pasos; luego vuelve. Tu configuración de dos pasos está en Configuración."],
      unauthorized: ["El apoyo a trabajadores no está abierto para este rol", "Vuelve a Trabajador/a o elige un rol de personal que esta cuenta realmente tenga. Si te falta un rol, pídeselo a una administración."],
      unavailable: ["El apoyo a trabajadores no está disponible ahora mismo", "Inténtalo más tarde. Si sigue fallando, pídele ayuda a una administración."],
      error: ["No se pudo cargar el apoyo a trabajadores", "Inténtalo de nuevo. Ningún registro protegido se modificó. Si sigue fallando, pídele ayuda a una administración."],
    },
    stateActions: { signInAgain: "Iniciar sesión de nuevo", twoStepSettings: "Configuración de dos pasos", backToMember: "Volver a Trabajador/a", writeSupport: "Escribir a soporte" },
    retry: "Intentar de nuevo",
    saveFailed: "No se pudo guardar ese cambio.",
    invalidInput: "Algunos datos no fueron aceptados. Revisa el formulario y vuelve a intentarlo.",
    handoffs: {
      eyebrow: "Traspaso de responsabilidad entre dos personas",
      title: "Traspasos del comité",
      pending: "{count} pendientes",
      intro: "El miembro del comité que recibe debe confirmar antes de que cambie la relación permanente. El traspaso completado queda en el historial.",
      oversightOnly: "Tu función puede revisar el historial de traspasos. Un miembro del comité, el liderazgo de campaña, la administración o la presidencia de campaña inicia un traspaso.",
      searchMembers: "Buscar trabajadores",
      search: "Buscar",
      searchMembersAria: "Buscar trabajadores para el traspaso",
      searchStewards: "Buscar al miembro del comité que recibe",
      searchStewardsAria: "Buscar al miembro del comité que recibe",
      searchMinimum: "Escribe al menos {count} caracteres para buscar.",
      memberSearchFailed: "No se pudo completar la búsqueda de trabajadores.",
      stewardSearchFailed: "No se pudo completar la búsqueda del miembro del comité.",
      loadFailed: "No se pudo cargar el historial de traspasos.",
      olderFailed: "No se pudieron cargar traspasos anteriores.",
      member: "Trabajador/a",
      steward: "El miembro del comité que recibe",
      note: "Nota de traspaso",
      noteHint: "Incluye solo el contexto que necesita el miembro del comité que recibe.",
      chooseMember: "Elige de los resultados de búsqueda",
      send: "Enviar traspaso",
      sent: "Traspaso enviado para confirmación.",
      status: "Estado",
      statuses: { "": "Todos", pending: "Pendiente", acknowledged: "Confirmado", declined: "Rechazado", cancelled: "Cancelado" },
      directions: { incoming: "Entrante", outgoing: "Saliente", overseen: "Supervisado" },
      noHistory: ["Sin historial de traspasos", "Los traspasos entrantes, salientes y supervisados aparecerán aquí."],
      dateUnavailable: "Fecha no disponible",
      acknowledge: "Confirmar",
      acknowledged: "Traspaso confirmado y relación actualizada.",
      decline: "Rechazar",
      declined: "Traspaso rechazado.",
      cancel: "Cancelar",
      cancelConfirm: "¿Cancelar el traspaso pendiente de {name}?",
      cancelled: "Traspaso cancelado.",
      loadOlder: "Cargar traspasos anteriores",
    },
    rights: {
      eyebrow: "Orientación urgente",
      title: "Lista de derechos de emergencia",
      notStarted: "No iniciado",
      scenarioAria: "Escenario de emergencia",
      alertsTitle: "Alertas abiertas del comité",
      noAlerts: ["Sin alertas abiertas", "Las alertas de trabajadores que necesitan respuesta aparecerán aquí."],
      stepsSaved: "{completed} de {total} pasos de la lista guardados.",
      resolveAlert: "Resolver alerta",
      alertResolved: "Alerta de {name} resuelta.",
      step: "Paso {n}",
      notes: "Notas privadas del incidente",
      notesHint: "Incluye solo lo que un miembro autorizado del comité necesita para responder.",
      save: "Guardar progreso",
      saved: "Progreso de la lista guardado.",
      alertSteward: "Alertar a un miembro del comité ahora",
      stewardAlerted: "Miembro del comité alertado",
      urgentSent: "Alerta urgente enviada al comité.",
      markResolved: "Marcar alerta como resuelta",
      emergencyResolved: "Alerta de emergencia resuelta.",
      statuses: { draft: "Guardado, sin alerta", alerted: "Miembro del comité alertado", resolved: "Alerta resuelta" },
      scenarios: {
        disciplinary_meeting: {
          label: "Reunión disciplinaria",
          summary: "Pregunta si podría llevar a una medida disciplinaria, pide que esté presente un compañero o compañera de trabajo y lleva un registro mientras contactas al comité.",
          steps: [
            "Pregunta si la reunión podría llevar a una medida disciplinaria.",
            "Pide que esté presente un compañero o compañera de trabajo. El empleador puede negarse, pero vale la pena pedirlo.",
            "Mantén la calma. No adivines ni especules, no firmes nada con lo que no estés de acuerdo y pide una copia de todo lo que te entreguen o te pidan firmar.",
            "Justo después, anota la hora, el lugar, las personas y los documentos, y cuéntaselo a un miembro del comité o a un organizador.",
          ],
        },
        pre_discipline_response: {
          label: "Respuesta previa a la disciplina",
          summary: "Usa el plazo de respuesta para entender los cargos, reunir registros y preparar una respuesta con apoyo.",
          steps: [
            "Solicita por escrito las acusaciones y el material de respaldo.",
            "Confirma la fecha límite de respuesta.",
            "Contacta a un miembro del comité antes de enviar una respuesta.",
            "Conserva una copia de todo lo enviado.",
          ],
        },
        unsafe_work: {
          label: "Trabajo inseguro",
          summary: "Atiende primero el peligro inmediato, luego conserva los hechos y usa el canal de seguridad apropiado.",
          steps: [
            "Aléjate del peligro inmediato cuando puedas hacerlo de forma segura.",
            "Notifica al contacto de emergencia o de seguridad del trabajo apropiado.",
            "Documenta la condición sin exponer información protegida del trabajador/a.",
            "Contacta a un miembro del comité para el seguimiento.",
          ],
        },
      },
    },
    accommodations: {
      eyebrow: "Admisión estructurada",
      title: "Solicitudes de adaptación",
      openCount: "{count} abiertas",
      requestType: "Tipo de solicitud",
      description: "¿Qué cambio o apoyo solicitas?",
      descriptionHint: "No agregues historiales médicos ni un diagnóstico a menos que el proceso lo exija.",
      submit: "Enviar solicitud",
      submitted: "Solicitud de adaptación enviada.",
      empty: ["Aún no hay solicitudes", "Una solicitud enviada y su historial de estado aparecerán aquí."],
      dateUnavailable: "fecha no disponible",
      staffUpdate: "Actualización del personal:",
      withdraw: "Retirar solicitud",
      withdrawn: "Solicitud retirada.",
      statusFor: "Estado de {name}",
      staffNoteFor: "Nota del personal para {name}",
      update: "Actualizar",
      statusUpdated: "Estado de la solicitud actualizado.",
      types: { schedule: "Horario", equipment: "Equipo", workspace: "Espacio de trabajo", leave: "Permiso", communication: "Comunicación", remote_work: "Trabajo remoto", other: "Otro" },
      statuses: { submitted: "Enviada", under_review: "En revisión", approved: "Aprobada", denied: "Denegada", withdrawn: "Retirada" },
    },
    hr: {
      eyebrow: "Registro de contacto puntual",
      title: "Contacto de RR. HH.",
      directoryName: "Recursos humanos",
      call: "Llamar",
      email: "Correo",
      hours: "Horario:",
      emptyDirectory: ["El directorio de RR. HH. no está configurado", "Un administrador del personal puede agregar la información de contacto de la organización. No se muestra ninguna identidad de relleno."],
      recordContact: "Registrar contacto",
      member: "Trabajador/a",
      chooseMember: "Elige un trabajador/a",
      channel: "Canal",
      purpose: "Propósito",
      disposition: "Disposición",
      when: "Cuándo",
      followUpDate: "Fecha de seguimiento",
      followUpRequired: "Obligatoria cuando la disposición es “Seguimiento pendiente”.",
      note: "Nota",
      saveContact: "Guardar contacto",
      contactSaved: "Contacto de RR. HH. registrado.",
      configureDirectory: "Configurar directorio de RR. HH.",
      notes: "Notas",
      saveDirectory: "Guardar directorio",
      directorySaved: "Directorio de RR. HH. guardado.",
      directoryEnabled: "Mostrar este directorio de RR. HH. a los trabajadores",
      directoryEnabledHelp: "Un directorio oculto no se muestra a nadie. Para mostrarlo de nuevo, escribe sus datos de contacto y guarda con esta casilla marcada.",
      emptyHistory: ["Sin historial de contacto con RR. HH.", "Los intentos de contacto estructurados y sus resultados aparecerán aquí."],
      dateUnavailable: "fecha no disponible",
      followUp: "Seguimiento {date}",
      fields: { name: "Nombre", title: "Cargo", department: "Departamento", email: "Correo", phone: "Teléfono", hours: "Horario" },
      channels: { email: "Correo", phone: "Teléfono", meeting: "Reunión", letter: "Carta", portal: "Portal", other: "Otro" },
      dispositions: { planned: "Planificado", attempted: "Intentado", reached: "Contactado", follow_up_due: "Seguimiento pendiente", resolved: "Resuelto" },
    },
    onboarding: {
      eyebrow: "Primeros pasos",
      title: "Incorporación de nuevos trabajadores",
      notAssigned: "No asignado",
      defaultProgram: {
        title: "Primeros pasos",
        note: "Tu campaña no tiene pasos de incorporación activos en este momento, así que aquí está por dónde empiezan la mayoría de los trabajadores nuevos. Cuando tu campaña active sus propios pasos, reemplazarán esta lista.",
        steps: [
          ["Bienvenida", "En Union Ground encuentras tus derechos de organización, tu contacto del comité y las noticias de tu campaña.", "/m"],
          ["Completa tu perfil", "Abre tu perfil (Ajustes en la web, Cuenta en la app) y revisa que tu nombre sea correcto. Luego revisa tu campaña (en Ajustes en la web, arriba en Inicio en la app), para que tu comité sepa quién eres.", "/m/settings"],
          ["Conoce a tu contacto del comité", "Usa Encontrar mi contacto del comité en Inicio para ver a quién acudir. Envíale un saludo breve en Mensajes para saber a quién preguntar.", "/m"],
          ["Lee la guía de organización", "Abre Derechos de organización y empieza por la primera lección.", "/m/rights"],
        ],
        staffNote: "Hasta que añadas un paso activo, los trabajadores ven la lista inicial de Union Ground (bienvenida, completa tu perfil, conoce a tu contacto del comité, lee la guía de organización). Tu primer paso activo la reemplaza. Los planes de los trabajadores solo empiezan con tus propios pasos.",
      },
      startPlan: "Empezar mi plan de incorporación",
      started: "Plan de incorporación iniciado.",
      completeStep: "Completar “{title}”",
      stepCompleted: "Paso de incorporación completado.",
      manage: "Gestionar programa y supervisión",
      stepTitle: "Título del paso",
      position: "Posición",
      description: "Descripción",
      addStep: "Agregar paso",
      stepSaved: "Paso de incorporación guardado.",
      programSteps: "Pasos del programa",
      stepActive: "activo",
      stepInactive: "desactivado",
      activateStep: "Activar",
      deactivateStep: "Desactivar",
      activateStepName: "Activar el paso {title}",
      deactivateStepName: "Desactivar el paso {title}",
      stepActivated: "Paso de incorporación activado.",
      stepDeactivated: "Paso de incorporación desactivado.",
      startMemberPlan: "Empezar el plan del trabajador/a seleccionado/a",
      memberToStart: "Trabajador/a para empezar",
      chooseMember: "Elegir un trabajador/a",
      memberStarted: "Plan de incorporación del trabajador/a iniciado.",
      noStartableMembers: "Todos los trabajadores del directorio ya tienen un plan de incorporación.",
      stepsComplete: "{completed} de {total} pasos completos",
      statuses: { not_started: "No iniciado", in_progress: "En curso", completed: "Completado", draft: "Borrador", active: "Activo" },
      oversightTitle: "Progreso de los trabajadores",
      stalled: "Estancado",
      stalledDetail: "Menos del {percent}% completado más de {days} días después de asignar la incorporación",
      autoEnrolled: "Inscrito automáticamente",
      progress: "{completed} de {total} pasos ({percent}%)",
      stepFor: "Paso para {name}",
      chooseStep: "Elegir un paso",
      markComplete: "Marcar como completado",
      skipStep: "Omitir paso",
      resetProgress: "Reiniciar progreso",
      resetConfirm: "¿Reiniciar todo el progreso de incorporación de {name}? No se puede deshacer.",
      stepMarkedComplete: "Paso marcado como completado.",
      stepSkipped: "Paso omitido.",
      progressReset: "Progreso de incorporación reiniciado.",
      overridesOff: "Los cambios del personal en la incorporación de trabajadores están desactivados en Funciones y límites.",
      rosterTruncated: "Mostrando {shown} de {total} trabajadores.",
    },
    mentorship: {
      eyebrow: "Emparejamiento y resultados",
      title: "Mentoría",
      activeCount: "{count} activas",
      createPairing: "Crear un emparejamiento",
      mentor: "Mentor",
      mentee: "Aprendiz",
      choose: "Elegir",
      startDate: "Fecha de inicio",
      create: "Crear emparejamiento",
      created: "Emparejamiento de mentoría creado.",
      empty: ["Aún no hay emparejamiento de mentoría", "El personal puede crear un emparejamiento formal sin exponerlo fuera de sus participantes y el equipo autorizado."],
      started: "Inició {date}",
      dateUnavailable: "fecha no disponible",
      outcome: "Resultado:",
      goals: "Metas",
      noGoals: "Aún no hay metas.",
      goalUpdated: "Meta de mentoría actualizada.",
      newGoal: "Nueva meta para {name}",
      addGoal: "Agregar meta",
      goalSaved: "Meta de mentoría guardada.",
      notes: "Notas",
      newNote: "Nueva nota para {name}",
      addNote: "Agregar nota",
      noteSaved: "Nota de mentoría guardada.",
      closePairing: "Cerrar emparejamiento",
      statusUpdated: "Estado de mentoría actualizado.",
      statusFor: "Nuevo estado para {name}",
      outcomeFor: "Resultado para {name}",
      statuses: { active: "Activa", completed: "Completada", cancelled: "Cancelada" },
    },
  },
};

//  W4-18: the handoff searches name their minimum beside Search.
const HANDOFF_SEARCH_MIN = 2;
function fill(template, vars) { return template.replace(/\{(\w+)\}/g, (match, name) => vars[name] ?? match); }

// UX-UG-MEMBER-SUPPORT-DATES-FOLLOW-THE-BROWSER-NOT-THE-MEMBER-20260920.
// Every stamp on this desk formatted with NO locale argument, so the member's
// language chose the labels and the BROWSER chose the dates: a Spanish member
// on an English-locale browser read "8/1/2026" beside "Enviado", and the two
// `date` columns (HR follow-up, mentorship start) were not formatted at all —
// they printed their raw ISO text in both languages. Both stamps take `lang`
// now, through the one locale source (localeFor) and the one clock source
// (formatGroupMoment, which carries.2's 12-hour clock and,
// since, names the group's zone instead of printing seconds).
function memberDate(value, lang, fallback) {
  if (!value) return fallback;
  // A `date` column carries no time. Parsed bare it lands on UTC midnight,
  // which renders as the day BEFORE anywhere west of Greenwich, so a plain
  // YYYY-MM-DD is read at local noon — the same reading TasksReport's day
  // column uses. A timestamp is already unambiguous and is parsed as given.
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat(localeFor(lang)).format(date);
}

function memberStamp(value, lang, fallback) {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return formatGroupMoment(value, lang) || fallback;
}

function dateTimeLocal(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function Field({ label: fieldLabel, children, hint = null }) {
  return <label className="member-support-field">
    <span>{fieldLabel}</span>
    {children}
    {hint && <small>{hint}</small>}
  </label>;
}

// A failed load is an interruption rather than a routine update, so the error
// card is announced assertively; the other bounded states stay polite. An
// unmapped state renders the error copy and counts as a failure too. The key
// remounts the card on that boundary because screen readers ignore a role that
// changes on an element already in the accessibility tree.
// Every bounded state names a next step beside Try again
// (UX-UG-MEMBER-SUPPORT-ERROR-STATES-DEAD-END-20261018). A two-step
// denial is private.mfa_satisfied() saying no: an enrolled factor not yet
// completed on this session, a session invalidated by a reset, or a recovery
// lock. Each of those is recovered by signing in again, never by enrolling,
// so that state offers Sign in again first and the two-step settings page
// second. The role state goes back to Member through the shell so a worn
// staff hat comes off; a missing or failed desk offers the support mailbox.
// The page's own button and actions classes are reused; nothing new is drawn.
const STATE_NEXT_STEPS = Object.freeze({
  mfa_required: { kind: "signin", path: "/m/settings/security", view: "settings", label: "twoStepSettings" },
  unauthorized: { kind: "route", path: "/m", view: "today", hat: "member", label: "backToMember" },
  unavailable: { kind: "mail", label: "writeSupport" },
  error: { kind: "mail", label: "writeSupport" },
});

// An in-app destination outside this desk. Back to Member under a worn staff
// hat is an identity change, so the shell's switchHat owns that hop (the same
// call the rail's Home entry makes); otherwise the shell's navigate does, then
// a mounted workspace router; rendered alone (tests, embeds) the anchor is an
// ordinary link to the same place. Modified clicks keep the browser's meaning.
function StateRouteLink({ path, view, hat = null, actorHat = null, onNavigate, onSwitchHat, className, children }) {
  const workspace = useWorkspace();
  const switches = Boolean(hat && onSwitchHat && actorHat !== hat);
  const hop = switches ? () => onSwitchHat(hat) : (onNavigate ? () => onNavigate(view, path) : (workspace ? () => workspace.open(path, view) : null));
  return <a className={className} href={workspaceHref(path)} onClick={(event) => {
    if (!hop || [event.metaKey, event.ctrlKey, event.shiftKey, event.altKey].some(Boolean)) return;
    event.preventDefault();
    hop();
  }}>{children}</a>;
}

function StateCard({ model, loading, onRetry, actorHat, onNavigate, onSwitchHat, onSignOut, copy }) {
  if (loading) return <section className="member-support-state" role="status" key="member-support-state-loading"><h2>{copy.loading}</h2></section>;
  if (model.state === "ready") return null;
  const mapped = copy.states[model.state];
  const failed = !mapped || model.state === "error";
  const text = mapped || copy.states.error;
  const nextStep = (failed ? STATE_NEXT_STEPS.error : STATE_NEXT_STEPS[model.state]) || null;
  // Union Ground publishes no support mailbox yet (src/lib/publicContact.js),
  // so the mail step appears only once one exists; until then retry stands alone.
  const supportContact = publicContact("support");
  const kind = nextStep && !(nextStep.kind === "mail" && !supportContact) ? nextStep.kind : "none";
  const retry = <button type="button" className={`member-support-button${kind === "mail" ? "" : " member-support-button--secondary"}`} onClick={onRetry}>{copy.retry}</button>;
  return <section className="member-support-state" role={failed ? "alert" : "status"} data-state={failed ? "error" : model.state} key={failed ? "member-support-state-failed" : `member-support-state-${model.state}`}>
    <h2>{text[0]}</h2><p>{text[1]}</p>
    <div className="member-support-actions">
      {kind === "signin" && onSignOut && <button type="button" className="member-support-button" onClick={() => onSignOut()}>{copy.stateActions.signInAgain}</button>}
      {kind === "route" && <StateRouteLink path={nextStep.path} view={nextStep.view} hat={nextStep.hat} actorHat={actorHat} onNavigate={onNavigate} onSwitchHat={onSwitchHat} className="member-support-button">{copy.stateActions[nextStep.label]}</StateRouteLink>}
      {retry}
      {kind === "mail" && <a className="member-support-button member-support-button--secondary" href={supportContact.href}>{copy.stateActions[nextStep.label]}</a>}
      {kind === "signin" && <StateRouteLink path={nextStep.path} view={nextStep.view} onNavigate={onNavigate} className="member-support-button member-support-button--secondary">{copy.stateActions[nextStep.label]}</StateRouteLink>}
    </div>
  </section>;
}

function Empty({ title, body }) {
  return <div className="member-support-empty"><strong>{title}</strong><p>{body}</p></div>;
}

function EmergencyRightsPanel({ model, actor, adapter, busy, commit, copy: viewCopy }) {
  const copy = viewCopy.rights;
  const statusRef = useRef(null);
  const alertsHeadingRef = useRef(null);
  const focusHandoff = useRef(null);
  const rememberFocus = (event, target) => {
    if (event.currentTarget === document.activeElement) {
      focusHandoff.current = { control: event.currentTarget, target };
    }
  };
  useEffect(() => {
    const moved = event => {
      if (focusHandoff.current && event.target !== focusHandoff.current.control) focusHandoff.current = null;
    };
    document.addEventListener("focusin", moved);
    return () => document.removeEventListener("focusin", moved);
  }, []);
  // A completed alert disables its action; resolving removes its action or
  // card. Move to the stable result before the browser's focus fixup runs,
  // but only while the member has stayed on the action they started.
  useLayoutEffect(() => {
    const handoff = focusHandoff.current;
    if (!handoff || (handoff.control.isConnected && !handoff.control.disabled)) return;
    focusHandoff.current = null;
    if (document.activeElement === handoff.control || document.activeElement === document.body) handoff.target.current?.focus();
  });
  const [scenarioId, setScenarioId] = useState(EMERGENCY_SCENARIOS[0].id);
  const scenario = EMERGENCY_SCENARIOS.find((item) => item.id === scenarioId) || EMERGENCY_SCENARIOS[0];
  const scenarioText = scenarioCopy(viewCopy, scenario);
  const persisted = model.emergencyChecklists.find((item) => item.scenario === scenario.id
    && (!item.memberUserId || item.memberUserId === model.viewerUserId));
  const stewardAlerts = model.staff
    ? model.emergencyChecklists.filter((item) => item.status === "alerted" && item.memberUserId !== model.viewerUserId)
    : [];
  const [completed, setCompleted] = useState([]);
  const [notes, setNotes] = useState("");
  useEffect(() => {
    setCompleted(persisted?.completedSteps || []);
    setNotes(persisted?.notes || "");
  }, [persisted, scenario.id]);
  const toggle = (index) => setCompleted((current) => current.includes(index)
    ? current.filter((item) => item !== index)
    : [...current, index].sort((a, b) => a - b));
  return <section className="member-support-panel" aria-labelledby="member-support-rights-title">
    <div className="member-support-panel__heading">
      <div><p className="member-support-eyebrow">{copy.eyebrow}</p><h2 id="member-support-rights-title">{copy.title}</h2></div>
      <span ref={statusRef} tabIndex={-1} className="member-support-status">{persisted?.status ? machineLabel(copy.statuses, persisted.status) : copy.notStarted}</span>
    </div>
    <div className="member-support-choice-grid" role="group" aria-label={copy.scenarioAria}>
      {EMERGENCY_SCENARIOS.map((item) => {
        const text = scenarioCopy(viewCopy, item);
        return <button
          type="button"
          className="member-support-choice"
          aria-pressed={scenario.id === item.id}
          key={item.id}
          onClick={() => setScenarioId(item.id)}
        ><strong>{text.label}</strong><span>{text.summary}</span></button>;
      })}
    </div>
    {model.staff && <div className="member-support-list" aria-labelledby="member-support-alerts-title">
      <h3 ref={alertsHeadingRef} tabIndex={-1} id="member-support-alerts-title">{copy.alertsTitle}</h3>
      {stewardAlerts.length === 0 ? <Empty title={copy.noAlerts[0]} body={copy.noAlerts[1]} /> : stewardAlerts.map((item) => {
        const alertedScenario = EMERGENCY_SCENARIOS.find((entry) => entry.id === item.scenario);
        const alertedText = alertedScenario ? scenarioCopy(viewCopy, alertedScenario) : null;
        return <article className="member-support-card" key={item.id}>
          <div className="member-support-card__heading"><div><strong>{item.memberLabel}</strong><span>{alertedText?.label || label(item.scenario)}</span></div><span className="member-support-status">{machineLabel(copy.statuses, item.status)}</span></div>
          <p>{fill(copy.stepsSaved, { completed: item.completedSteps.length, total: alertedScenario?.steps.length || 0 })}</p>
          {item.notes && <p className="member-support-note">{item.notes}</p>}
          <BusyButton pending={busy} className="member-support-button member-support-button--secondary" type="button" onClick={event => { rememberFocus(event, alertsHeadingRef); return commit(
            () => adapter.resolveEmergencyChecklist(actor, item.id),
            fill(copy.alertResolved, { name: item.memberLabel }),
          ); }}>{copy.resolveAlert}</BusyButton>
        </article>;
      })}
    </div>}
    <form className="member-support-form" onSubmit={(event) => {
      event.preventDefault();
      commit(() => adapter.saveEmergencyChecklist(actor, { scenario: scenario.id, completedSteps: completed, notes }), copy.saved);
    }}>
      <div className="member-support-checklist">
        {scenarioText.steps.map((step, index) => <label className="member-support-check" key={step}>
          <input type="checkbox" checked={completed.includes(index)} onChange={() => toggle(index)} />
          <span><strong>{fill(copy.step, { n: index + 1 })}</strong>{step}</span>
        </label>)}
      </div>
      <Field label={copy.notes} hint={copy.notesHint}>
        <textarea maxLength={4000} value={notes} onChange={(event) => setNotes(event.target.value)} />
      </Field>
      {/* A disabled button gives up focus (the HTML focus fixup rule), which
          would drop a keyboard or screen-reader user to the top of the page
          mid-save. These stay focusable while a write runs; commit refuses a
          second one. */}
      <div className="member-support-actions">
        <BusyButton pending={busy} className="member-support-button" type="submit">{copy.save}</BusyButton>
        <BusyButton disabled={persisted?.status === "alerted"} pending={busy} className="member-support-button member-support-button--urgent" type="button" onClick={event => { rememberFocus(event, statusRef); return commit(
          () => adapter.alertEmergencySteward(actor, { scenario: scenario.id, completedSteps: completed, notes }),
          copy.urgentSent,
        ); }}>{persisted?.status === "alerted" ? copy.stewardAlerted : copy.alertSteward}</BusyButton>
        {persisted?.status === "alerted" && <BusyButton pending={busy} className="member-support-button member-support-button--secondary" type="button" onClick={event => { rememberFocus(event, statusRef); return commit(
          () => adapter.resolveEmergencyChecklist(actor, persisted.id),
          copy.emergencyResolved,
        ); }}>{copy.markResolved}</BusyButton>}
      </div>
    </form>
  </section>;
}

function AccommodationPanel({ model, actor, adapter, busy, commit, copy: viewCopy }) {
  const { lang } = useLang();
  const copy = viewCopy.accommodations;
  return <section className="member-support-panel" aria-labelledby="member-support-accommodation-title">
    <div className="member-support-panel__heading">
      <div><p className="member-support-eyebrow">{copy.eyebrow}</p><h2 id="member-support-accommodation-title">{copy.title}</h2></div>
      <span className="member-support-status">{fill(copy.openCount, { count: model.accommodationSummary.open })}</span>
    </div>
    <form className="member-support-form member-support-form--compact" onSubmit={(event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      commit(() => adapter.createAccommodation(actor, {
        requestType: data.get("requestType"),
        description: data.get("description"),
      }), copy.submitted, () => form.reset());
    }}>
      <Field label={copy.requestType}><select name="requestType" required>{ACCOMMODATION_TYPES.map((type) => <option value={type} key={type}>{machineLabel(copy.types, type)}</option>)}</select></Field>
      <Field label={copy.description} hint={copy.descriptionHint}>
        <textarea name="description" required minLength={1} maxLength={4000} />
      </Field>
      <BusyButton pending={busy} className="member-support-button" type="submit">{copy.submit}</BusyButton>
    </form>
    <div className="member-support-list">
      {model.accommodations.length === 0 ? <Empty title={copy.empty[0]} body={copy.empty[1]} /> : model.accommodations.map((item) => <article className="member-support-card" key={item.id}>
        <div className="member-support-card__heading"><div><strong>{item.memberLabel}</strong><span>{machineLabel(copy.types, item.requestType)} · {memberDate(item.submittedAt, lang, copy.dateUnavailable)}</span></div><span className="member-support-status">{machineLabel(copy.statuses, item.status)}</span></div>
        <p>{item.description}</p>
        {item.staffNote && <p className="member-support-note"><strong>{copy.staffUpdate}</strong> {item.staffNote}</p>}
        {item.memberUserId === model.viewerUserId && ["submitted", "under_review"].includes(item.status) && <BusyButton pending={busy} type="button" className="member-support-button member-support-button--secondary" onClick={() => commit(
          () => adapter.transitionAccommodation(actor, { requestId: item.id, status: "withdrawn" }),
          copy.withdrawn,
        )}>{copy.withdraw}</BusyButton>}
        {model.staff && !["withdrawn"].includes(item.status) && <form className="member-support-inline" onSubmit={(event) => {
          event.preventDefault(); const data = new FormData(event.currentTarget);
          commit(() => adapter.transitionAccommodation(actor, { requestId: item.id, status: data.get("status"), staffNote: data.get("staffNote") }), copy.statusUpdated);
        }}><select name="status" defaultValue={item.status} aria-label={fill(copy.statusFor, { name: item.memberLabel })}><option value="under_review">{copy.statuses.under_review}</option><option value="approved">{copy.statuses.approved}</option><option value="denied">{copy.statuses.denied}</option></select><input name="staffNote" maxLength={2000} defaultValue={item.staffNote} aria-label={fill(copy.staffNoteFor, { name: item.memberLabel })} /><BusyButton pending={busy} className="member-support-button" type="submit">{copy.update}</BusyButton></form>}
      </article>)}
    </div>
  </section>;
}

function HrContactPanel({ model, actor, adapter, busy, commit, copy: viewCopy }) {
  const { lang } = useLang();
  const copy = viewCopy.hr;
  const directory = model.hrDirectory;
  const [disposition, setDisposition] = useState(HR_CONTACT_DISPOSITIONS[0]);
  const [followUpOn, setFollowUpOn] = useState("");
  const followUpRequired = disposition === "follow_up_due";
  return <section className="member-support-panel" aria-labelledby="member-support-hr-title">
    <div className="member-support-panel__heading"><div><p className="member-support-eyebrow">{copy.eyebrow}</p><h2 id="member-support-hr-title">{copy.title}</h2></div></div>
    {directory ? <article className="member-support-card member-support-directory">
      <div><strong>{directory.name || copy.directoryName}</strong><span>{[directory.title, directory.department].filter(Boolean).join(" · ")}</span></div>
      <div className="member-support-actions">{directory.phone && <a className="member-support-button" href={`tel:${directory.phone.replace(/\s/g, "")}`}>{copy.call}</a>}{directory.email && <a className="member-support-button member-support-button--secondary" href={`mailto:${directory.email}`}>{copy.email}</a>}</div>
      {directory.hours && <p><strong>{copy.hours}</strong> {directory.hours}</p>}{directory.notes && <p>{directory.notes}</p>}
    </article> : <Empty title={copy.emptyDirectory[0]} body={copy.emptyDirectory[1]} />}
    <form className="member-support-form member-support-form--grid" onSubmit={(event) => {
      event.preventDefault(); if (followUpRequired && !followUpOn) return; const form = event.currentTarget; const data = new FormData(form);
      commit(() => adapter.recordHrContact(actor, {
        memberUserId: data.get("memberUserId") || null,
        channel: data.get("channel"), purpose: data.get("purpose"),
        disposition: data.get("disposition"), note: data.get("note"),
        occurredAt: new Date(data.get("occurredAt")).toISOString(), followUpOn: data.get("followUpOn") || null,
      }), copy.contactSaved, () => { form.reset(); setDisposition(HR_CONTACT_DISPOSITIONS[0]); setFollowUpOn(""); });
    }}>
      <h3>{copy.recordContact}</h3>
      {model.staff && <Field label={copy.member}><select name="memberUserId" required><option value="">{copy.chooseMember}</option>{model.mentorshipDirectory.map((person) => <option value={person.userId} key={person.userId}>{person.label}</option>)}</select></Field>}
      <Field label={copy.channel}><select name="channel" required>{["email", "phone", "meeting", "letter", "portal", "other"].map((item) => <option value={item} key={item}>{machineLabel(copy.channels, item)}</option>)}</select></Field>
      <Field label={copy.purpose}><input name="purpose" required maxLength={240} /></Field>
      <Field label={copy.disposition}><select name="disposition" required value={disposition} onChange={(event) => setDisposition(event.target.value)}>{HR_CONTACT_DISPOSITIONS.map((item) => <option value={item} key={item}>{machineLabel(copy.dispositions, item)}</option>)}</select></Field>
      <Field label={copy.when}><input name="occurredAt" type="datetime-local" required defaultValue={dateTimeLocal()} /></Field>
      <Field label={copy.followUpDate} hint={followUpRequired ? copy.followUpRequired : null}><input name="followUpOn" type="date" required={followUpRequired} value={followUpOn} onChange={(event) => setFollowUpOn(event.target.value)} /></Field>
      <Field label={copy.note}><textarea name="note" maxLength={4000} /></Field>
      <BusyButton pending={busy} disabled={followUpRequired && !followUpOn} className="member-support-button" type="submit">{copy.saveContact}</BusyButton>
    </form>
    {model.staff && <details className="member-support-disclosure"><summary>{copy.configureDirectory}</summary><form className="member-support-form member-support-form--grid" onSubmit={(event) => {
      event.preventDefault(); const data = new FormData(event.currentTarget);
      // Inventory A4: the directory's enabled flag was always sent as true.
      commit(() => adapter.saveHrDirectory(actor, { ...Object.fromEntries(data.entries()), enabled: data.get("enabled") === "on" }), copy.directorySaved);
    }}>{["name", "title", "department", "email", "phone", "hours"].map((field) => <Field label={machineLabel(copy.fields, field)} key={field}><input name={field} defaultValue={directory?.[field] || ""} maxLength={field === "email" ? 320 : field === "hours" ? 500 : 160} type={field === "email" ? "email" : "text"} /></Field>)}<Field label={copy.notes}><textarea name="notes" defaultValue={directory?.notes || ""} maxLength={2000} /></Field><label className="member-support-check-field"><input type="checkbox" name="enabled" defaultChecked={directory ? directory.enabled !== false : true} /> {copy.directoryEnabled}</label><p className="member-support-muted">{copy.directoryEnabledHelp}</p><BusyButton pending={busy} className="member-support-button" type="submit">{copy.saveDirectory}</BusyButton></form></details>}
    <div className="member-support-list">{model.hrContacts.length === 0 ? <Empty title={copy.emptyHistory[0]} body={copy.emptyHistory[1]} /> : model.hrContacts.map((item) => <article className="member-support-card" key={item.id}><div className="member-support-card__heading"><div><strong>{item.memberLabel}</strong><span>{machineLabel(copy.channels, item.channel)} · {memberStamp(item.occurredAt, lang, copy.dateUnavailable)}</span></div><span className="member-support-status">{machineLabel(copy.dispositions, item.disposition)}</span></div><p>{item.purpose}</p>{item.note && <p className="member-support-note">{item.note}</p>}{item.followUpOn && <small>{fill(copy.followUp, { date: memberDate(item.followUpOn, lang, copy.dateUnavailable) })}</small>}</article>)}</div>
  </section>;
}

// The Union Ground starting list for an organization with no active step of
// its own: static guidance with no progress, so nothing is written for it.
// Members only ever receive active steps (get_member_support_workspace), so a
// member cannot tell "none added" from "all turned off"; the note is true for
// both.
// BUG-UG-ONBOARDING-LINKS-PRESERVE-WORKSPACE-CONTEXT-20261020: each
// built-in step is a StateRouteLink, so an ordinary click hops in place through
// the shell's navigate (keeping the demo or embed context the href also
// carries) and a modified click stays the browser's.
const DEFAULT_STEP_VIEWS = Object.freeze({ "/m": "today", "/m/settings": "settings", "/m/rights": "rights" });

function DefaultOnboardingProgram({ copy, onNavigate = null }) {
  return <div className="member-support-default-program">
    <h3>{copy.title}</h3>
    <p className="member-support-muted">{copy.note}</p>
    <div className="member-support-checklist">{copy.steps.map(([title, description, href], index) => <StateRouteLink className="member-support-check member-support-check--link" path={href} view={DEFAULT_STEP_VIEWS[href] ?? "today"} onNavigate={onNavigate} key={title}><span className="member-support-check__marker" aria-hidden="true">{index + 1}</span><span><strong>{title}</strong>{description}</span></StateRouteLink>)}</div>
  </div>;
}

// `coachMark` (REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP2-20261023) is
// the guide engine's proposed coach mark for the next step's Complete button:
// it renders inline under that button only when its anchor is this step.
function OnboardingPanel({ model, actor, adapter, busy, commit, copy: viewCopy, onNavigate = null, coachMark = null, guideSwitches = null }) {
  const copy = viewCopy.onboarding;
  const completed = new Set(model.onboardingPlan?.completedStepIds || []);
  const next = model.onboardingProgram.find((step) => step.active && !completed.has(step.id));
  const started = new Set(model.onboardingRoster.map((item) => item.memberUserId).filter(Boolean));
  const startable = model.mentorshipDirectory.filter((person) => !started.has(person.userId));
  const hasActiveStep = model.onboardingProgram.some((step) => step.active);
  return <section className="member-support-panel" aria-labelledby="member-support-onboarding-title">
    <div className="member-support-panel__heading"><div><p className="member-support-eyebrow">{copy.eyebrow}</p><h2 id="member-support-onboarding-title">{copy.title}</h2></div><span className="member-support-status">{model.onboardingPlan?.status ? machineLabel(copy.statuses, model.onboardingPlan.status) : copy.notAssigned}</span></div>
    {!hasActiveStep ? <DefaultOnboardingProgram copy={copy.defaultProgram} onNavigate={onNavigate} /> : <div className="member-support-checklist">{model.onboardingProgram.filter((step) => step.active).map((step, index) => <div className="member-support-check member-support-check--static" key={step.id}><span className="member-support-check__marker" aria-hidden="true">{completed.has(step.id) ? "✓" : index + 1}</span><span><strong>{step.title}</strong>{step.description}</span></div>)}</div>}
    {!model.onboardingPlan && hasActiveStep && <BusyButton pending={busy} className="member-support-button" type="button" onClick={() => commit(() => adapter.startOnboarding(actor), copy.started)}>{copy.startPlan}</BusyButton>}
    {model.onboardingPlan && next && <BusyButton pending={busy} className="member-support-button" type="button" data-guide-anchor="next-step" aria-describedby={coachMark?.anchor === `next-step:${next.id}` ? coachMark.describedBy : undefined} onClick={() => commit(() => adapter.completeOnboardingStep(actor, next.id), copy.stepCompleted)}>{fill(copy.completeStep, { title: next.title })}</BusyButton>}
    {model.onboardingPlan && next && coachMark?.anchor === `next-step:${next.id}` && coachMark.element}
    {model.staff && <details className="member-support-disclosure"><summary>{copy.manage}</summary><OnboardingSetupSection {...{ program: model.onboardingProgram, actor, adapter, busy, commit, viewCopy: copy, guideSwitches }}>{!hasActiveStep && <p className="member-support-muted">{copy.defaultProgram.staffNote}</p>}<form key={model.onboardingProgram.length} className="member-support-form member-support-form--grid" onSubmit={(event) => {
      event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
      commit(() => adapter.saveOnboardingStep(actor, { title: data.get("title"), description: data.get("description"), position: data.get("position"), active: true }), copy.stepSaved, () => form.reset());
    }}><Field label={copy.stepTitle}><input name="title" required maxLength={160} /></Field><Field label={copy.position}><input name="position" type="number" min="0" max="1000" required defaultValue={nextStepPosition(model.onboardingProgram) ?? ""} /></Field><Field label={copy.description}><textarea name="description" maxLength={2000} /></Field><BusyButton pending={busy} className="member-support-button" type="submit">{copy.addStep}</BusyButton></form>
      </OnboardingSetupSection>
      <MemberGuidePreview program={model.onboardingProgram} guideSwitches={guideSwitches} />
      <h3>{copy.startMemberPlan}</h3>{startable.length === 0 ? <p className="member-support-muted">{copy.noStartableMembers}</p> : <form className="member-support-inline" onSubmit={(event) => {
      event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
      commit(() => adapter.startOnboarding(actor, data.get("memberUserId")), copy.memberStarted, () => form.reset());
    }}><select name="memberUserId" required defaultValue="" aria-label={copy.memberToStart}><option value="">{copy.chooseMember}</option>{startable.map((person) => <option value={person.userId} key={person.userId}>{person.label}</option>)}</select><BusyButton pending={busy} disabled={!hasActiveStep} className="member-support-button" type="submit">{copy.startMemberPlan}</BusyButton></form>}<OnboardingOversight {...{ model, actor, adapter, busy, commit, copy }} /></details>}
  </section>;
}

// REQ-UG-ONBOARDING-AUTO-ASSIGN-AND-STEWARD-OVERSIGHT-20261001: the staff
// roster with the organization's stalled flag and audited complete / skip /
// reset. Before the oversight RPC answers (or if it cannot), the plain roster
// from the workspace stays on screen.
function OnboardingOversight({ model, actor, adapter, busy, commit, copy }) {
  const [oversight, setOversight] = useState(null);
  useEffect(() => {
    let cancelled = false;
    adapter.loadOnboardingOversight(actor)
      .then((next) => { if (!cancelled) setOversight(next.state === "ready" ? next : null); })
      .catch(() => { if (!cancelled) setOversight(null); });
    return () => { cancelled = true; };
  }, [adapter, actor, model]);
  if (!oversight) {
    return <div className="member-support-list">{model.onboardingRoster.map((item) => <article className="member-support-card" key={item.id}><div className="member-support-card__heading"><strong>{item.memberLabel}</strong><span className="member-support-status">{machineLabel(copy.statuses, item.status)}</span></div><small>{fill(copy.stepsComplete, { completed: (item.completedStepIds || []).length, total: model.onboardingProgram.filter((step) => step.active).length })}</small></article>)}</div>;
  }
  return <section className="member-support-list" aria-labelledby="member-support-onboarding-oversight-title">
    <h3 id="member-support-onboarding-oversight-title">{copy.oversightTitle}</h3>
    {!oversight.staffOverridesEnabled && <p className="member-support-muted">{copy.overridesOff}</p>}
    {oversight.memberCount > oversight.members.length && <p className="member-support-muted">{fill(copy.rosterTruncated, { shown: oversight.members.length, total: oversight.memberCount })}</p>}
    <OnboardingProgressSummary oversight={oversight} />
    <OnboardingChapterProgress oversight={oversight} />
    <OnboardingProgressPeople members={oversight.members} memberCount={oversight.memberCount} stalledFlag={oversight.stalledFlagEnabled} renderRow={(row) => <OnboardingOversightRow key={row.planId} {...{ row, oversight, actor, adapter, busy, commit, copy }} />} />
  </section>;
}

function OnboardingOversightRow({ row, oversight, actor, adapter, busy, commit, copy }) {
  const { t } = useLang();
  const [stepId, setStepId] = useState("");
  const [skipping, setSkipping] = useState(false);
  const open = openOnboardingSteps(oversight, row);
  const change = (action, success, reason = null) => commit(
    () => adapter.updateMemberOnboarding(actor, { planId: row.planId, action, stepId: action === "reset" ? null : stepId, reason }),
    success,
    () => { setStepId(""); setSkipping(false); },
  );
  return <article className={`member-support-card${row.stalled ? " member-support-card--attention" : ""}`}>
    <div className="member-support-card__heading">
      <strong>{row.memberLabel}</strong>
      <span className="member-support-status">{machineLabel(copy.statuses, row.status)}</span>
      {row.stalled && <span className="member-support-status member-support-status--warning">{copy.stalled}</span>}
    </div>
    <small>{fill(copy.progress, { completed: row.completedSteps, total: oversight.totalSteps, percent: row.percentComplete })}</small>
    {row.stalled && <small>{fill(copy.stalledDetail, { percent: oversight.stalledBelowPercent, days: oversight.stalledAfterDays })}</small>}
    {row.autoEnrolled && <small>{copy.autoEnrolled}</small>}
    {row.status !== "completed" && open.length > 0 && <small>{t("onboardingAdmin.progress.nextStep", { title: open[0].title })}</small>}
    {oversight.staffOverridesEnabled && <div className="member-support-inline">
      {open.length > 0 && <select value={stepId} onChange={(event) => { setStepId(event.target.value); setSkipping(false); }} aria-label={fill(copy.stepFor, { name: row.memberLabel })}>
        <option value="">{copy.chooseStep}</option>
        {open.map((step) => <option key={step.id} value={step.id}>{step.title}</option>)}
      </select>}
      {open.length > 0 && <BusyButton type="button" className="member-support-button" pending={busy} disabled={!stepId} onClick={() => change("complete", copy.stepMarkedComplete)}>{copy.markComplete}</BusyButton>}
      {open.length > 0 && <BusyButton type="button" className="member-support-button member-support-button--secondary" pending={busy} disabled={!stepId} aria-expanded={skipping} onClick={() => setSkipping(true)}>{copy.skipStep}</BusyButton>}
      {(row.completedSteps > 0 || row.status !== "not_started") && <BusyButton type="button" className="member-support-button member-support-button--secondary" pending={busy} onClick={() => window.confirm(fill(copy.resetConfirm, { name: row.memberLabel })) && change("reset", copy.progressReset)}>{copy.resetProgress}</BusyButton>}
    </div>}
    {oversight.staffOverridesEnabled && skipping && stepId && <SkipStepForm key={stepId} stepTitle={open.find((step) => step.id === stepId)?.title ?? ""} busy={busy} onSubmit={(reason) => change("skip", copy.stepSkipped, reason)} onCancel={() => setSkipping(false)} />}
    <OnboardingRowFollowUp {...{ row, oversight, actor, adapter, busy, commit }} />
  </article>;
}

// A failure notice is always the view's own translated sentence. The server's
// message text is never shown: the database refuses a handoff without a chapter
// with one fixed sentence, which is mapped to its translation here, and every
// other failure gets the caller's fallback. Kept outside COPY so the pinned
// English copy block does not move.
const CHAPTER_REQUIRED = /^A handoff records a chapter\./;
const CHAPTER_REQUIRED_COPY = {
  en: "A handoff records a chapter. Select a chapter before transferring responsibility for a member.",
  es: "Un traspaso se registra en un capítulo. Selecciona un capítulo antes de transferir la responsabilidad de un miembro.",
};
function failureNotice(error, copy, fallback, lang) {
  if (classifyMemberSupportError(error) === "invalid_input") return copy.invalidInput;
  if (CHAPTER_REQUIRED.test(String(error?.message || ""))) return CHAPTER_REQUIRED_COPY[lang] || CHAPTER_REQUIRED_COPY.en;
  return fallback;
}

function MentorshipPanel({ model, actor, adapter, busy, commit, copy: viewCopy }) {
  const { lang } = useLang();
  const copy = viewCopy.mentorship;
  return <section className="member-support-panel" aria-labelledby="member-support-mentorship-title">
    <div className="member-support-panel__heading"><div><p className="member-support-eyebrow">{copy.eyebrow}</p><h2 id="member-support-mentorship-title">{copy.title}</h2></div><span className="member-support-status">{fill(copy.activeCount, { count: model.mentorshipPairs.filter((pair) => pair.status === "active").length })}</span></div>
    {model.staff && <form className="member-support-form member-support-form--grid" onSubmit={(event) => {
      event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
      commit(() => adapter.createMentorshipPair(actor, { mentorUserId: data.get("mentorUserId"), menteeUserId: data.get("menteeUserId"), startedOn: data.get("startedOn") || null }), copy.created, () => form.reset());
    }}><h3>{copy.createPairing}</h3><Field label={copy.mentor}><select required name="mentorUserId"><option value="">{copy.choose}</option>{model.mentorshipDirectory.map((person) => <option value={person.userId} key={person.userId}>{person.label}</option>)}</select></Field><Field label={copy.mentee}><select required name="menteeUserId"><option value="">{copy.choose}</option>{model.mentorshipDirectory.map((person) => <option value={person.userId} key={person.userId}>{person.label}</option>)}</select></Field><Field label={copy.startDate}><input name="startedOn" type="date" /></Field><BusyButton pending={busy} className="member-support-button" type="submit">{copy.create}</BusyButton></form>}
    <div className="member-support-list">{model.mentorshipPairs.length === 0 ? <Empty title={copy.empty[0]} body={copy.empty[1]} /> : model.mentorshipPairs.map((pair) => <article className="member-support-card" key={pair.id}>
      <div className="member-support-card__heading"><div><strong>{pair.mentorLabel} → {pair.menteeLabel}</strong><span>{fill(copy.started, { date: memberDate(pair.startedOn, lang, copy.dateUnavailable) })}</span></div><span className="member-support-status">{machineLabel(copy.statuses, pair.status)}</span></div>
      {pair.outcome && <p className="member-support-note"><strong>{copy.outcome}</strong> {pair.outcome}</p>}
      <div className="member-support-subgrid"><div><h3>{copy.goals}</h3>{pair.goals.length === 0 ? <p className="member-support-muted">{copy.noGoals}</p> : pair.goals.map((goal) => <BusyButton pending={busy} type="button" className="member-support-goal" aria-pressed={goal.completed} key={goal.id} onClick={() => commit(() => adapter.saveMentorshipGoal(actor, { pairId: pair.id, goalId: goal.id, title: goal.title, completed: !goal.completed }), copy.goalUpdated)}><span aria-hidden="true">{goal.completed ? "✓" : "○"}</span>{goal.title}</BusyButton>)}<form className="member-support-inline" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); commit(() => adapter.saveMentorshipGoal(actor, { pairId: pair.id, title: data.get("title"), completed: false }), copy.goalSaved, () => form.reset()); }}><input name="title" required maxLength={200} aria-label={fill(copy.newGoal, { name: pair.menteeLabel })} /><BusyButton pending={busy} className="member-support-button" type="submit">{copy.addGoal}</BusyButton></form></div><div><h3>{copy.notes}</h3>{pair.notes.slice(0, 4).map((note) => <p className="member-support-note" key={note.id}><strong>{note.authorLabel}</strong><br />{note.body}</p>)}<form className="member-support-inline" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); commit(() => adapter.addMentorshipNote(actor, { pairId: pair.id, body: data.get("body") }), copy.noteSaved, () => form.reset()); }}><input name="body" required maxLength={4000} aria-label={fill(copy.newNote, { name: pair.menteeLabel })} /><BusyButton pending={busy} className="member-support-button" type="submit">{copy.addNote}</BusyButton></form></div></div>
      {model.staff && pair.status === "active" && <form className="member-support-inline" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); commit(() => adapter.transitionMentorshipPair(actor, { pairId: pair.id, status: data.get("status"), outcome: data.get("outcome") }), copy.statusUpdated); }}><select name="status" aria-label={fill(copy.statusFor, { name: pair.menteeLabel })}><option value="completed">{copy.statuses.completed}</option><option value="cancelled">{copy.statuses.cancelled}</option></select><input name="outcome" maxLength={2000} aria-label={fill(copy.outcomeFor, { name: pair.menteeLabel })} /><BusyButton pending={busy} className="member-support-button" type="submit">{copy.closePairing}</BusyButton></form>}
    </article>)}</div>
  </section>;
}

const canCountPendingHandoffs = (filterStatus) => filterStatus === "" || filterStatus === "pending";

async function readHandoffPage(adapter, actor, filterStatus) {
  try {
    const page = await adapter.listHandoffs(actor, { status: filterStatus || null });
    return { ...page, filterStatus };
  } catch {
    return { items: [], nextCursor: null, loadFailed: true, filterStatus };
  }
}

function pendingHandoffCount(model) {
  const page = model.handoffSummary ?? model.handoffs;
  if (page?.loadFailed || !canCountPendingHandoffs(page?.filterStatus)) return null;
  return page.items.filter((item) => item.status === "pending").length;
}

function HandoffsPanel({ model, actor, adapter, busy, commit, onNotice, status, onStatusChange, onHistorySettled, copy: viewCopy }) {
  const { lang, t } = useLang();
  const copy = viewCopy.handoffs;
  const pending = pendingHandoffCount(model);
  const [memberQuery, setMemberQuery] = useState("");
  const [stewardQuery, setStewardQuery] = useState("");
  const [members, setMembers] = useState([]);
  const [stewards, setStewards] = useState([]);
  const [memberId, setMemberId] = useState("");
  const [stewardId, setStewardId] = useState("");
  const [note, setNote] = useState("");
  const [history, setHistory] = useState(() => model.handoffs.filterStatus === status ? model.handoffs : null);
  const [failureAttempt, setFailureAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const retryLock = useRef(new Set());
  const historyRead = useRef(0);
  const previousDeskPage = useRef(model.handoffs);
  const statusSelect = useRef(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const shownHistory = history?.filterStatus === status ? history : null;
  const restoreHistory = useEffectEvent(() => {
    const currentStatus = statusRef.current;
    if (model.handoffs.filterStatus !== currentStatus) void filter(currentStatus);
  });
  useEffect(() => {
    const read = historyRead.current;
    // Wait past the Strict Mode effect replay and skip if a newer read has started.
    queueMicrotask(() => {
      if (read === historyRead.current) restoreHistory();
    });
    return () => { historyRead.current += 1; };
  }, []);
  useEffect(() => {
    const page = model.handoffs;
    if (page === previousDeskPage.current) return;
    previousDeskPage.current = page;
    if (page.filterStatus !== statusRef.current) return;
    historyRead.current += 1;
    setHistory(page);
    if (page.loadFailed) setFailureAttempt((attempt) => attempt + 1);
  }, [model.handoffs]);
  async function search(setter, operation, fallback) {
    try { setter(await operation()); }
    catch (error) { onNotice(failureNotice(error, viewCopy, fallback, lang)); }
  }
  async function filter(nextStatus) {
    statusRef.current = nextStatus;
    onStatusChange(nextStatus);
    const read = ++historyRead.current;
    const page = await readHandoffPage(adapter, actor, nextStatus);
    if (read !== historyRead.current || page.filterStatus !== statusRef.current) return;
    setHistory(page);
    if (page.loadFailed) setFailureAttempt((attempt) => attempt + 1);
    if (canCountPendingHandoffs(nextStatus) && (page.loadFailed || pending === null)) {
      onHistorySettled(model.handoffs, page, nextStatus);
    }
  }
  function retryHistory() {
    return runBusyWrite(retryLock, "retry", async () => {
      statusSelect.current?.focus();
      setRetrying(true);
      try { await filter(status); } finally { setRetrying(false); }
    });
  }
  async function loadOlder() {
    if (!shownHistory?.nextCursor) return;
    const read = historyRead.current;
    try {
      const page = await adapter.listHandoffs(actor, {
        status: status || null,
        beforeCreatedAt: shownHistory.nextCursor.createdAt,
        beforeId: shownHistory.nextCursor.id,
      });
      if (read !== historyRead.current) return;
      setHistory((current) => ({
        ...current, items: [...current.items, ...page.items], nextCursor: page.nextCursor,
      }));
    } catch (error) {
      if (read === historyRead.current) onNotice(failureNotice(error, viewCopy, copy.olderFailed, lang));
    }
  }
  return <section className="member-support-panel" aria-labelledby="member-support-handoffs-title">
    <div className="member-support-panel__heading"><div><p className="member-support-eyebrow">{copy.eyebrow}</p><h2 id="member-support-handoffs-title">{copy.title}</h2></div>{pending !== null && <span className="member-support-status">{fill(copy.pending, { count: pending })}</span>}</div>
    <p className="member-support-muted">{copy.intro}</p>
    {canInitiateMemberHandoff(actor) ? <>
    <div className="member-support-handoff-searches">
      <form className="member-support-inline" onSubmit={(event) => { event.preventDefault(); if (memberQuery.trim().length < HANDOFF_SEARCH_MIN) return; search(setMembers, () => adapter.searchHandoffMembers(actor, memberQuery.trim()), copy.memberSearchFailed); }}><input value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} minLength={HANDOFF_SEARCH_MIN} placeholder={copy.searchMembers} aria-label={copy.searchMembersAria} /><BusyButton type="submit" pending={busy} disabled={memberQuery.trim().length < HANDOFF_SEARCH_MIN} disabledReason={fill(copy.searchMinimum, { count: HANDOFF_SEARCH_MIN })} className="member-support-button">{copy.search}</BusyButton></form>
      <form className="member-support-inline" onSubmit={(event) => { event.preventDefault(); if (stewardQuery.trim().length < HANDOFF_SEARCH_MIN) return; search(setStewards, () => adapter.searchHandoffStewards(actor, stewardQuery.trim()), copy.stewardSearchFailed); }}><input value={stewardQuery} onChange={(event) => setStewardQuery(event.target.value)} minLength={HANDOFF_SEARCH_MIN} placeholder={copy.searchStewards} aria-label={copy.searchStewardsAria} /><BusyButton type="submit" pending={busy} disabled={stewardQuery.trim().length < HANDOFF_SEARCH_MIN} disabledReason={fill(copy.searchMinimum, { count: HANDOFF_SEARCH_MIN })} className="member-support-button">{copy.search}</BusyButton></form>
    </div>
    <form className="member-support-form member-support-form--grid" onSubmit={(event) => { event.preventDefault(); commit(() => adapter.initiateHandoff(actor, { memberUserId: memberId, toStewardId: stewardId, note }), copy.sent, () => { setMemberId(""); setStewardId(""); setNote(""); }); }}>
      <Field label={copy.member}><select value={memberId} onChange={(event) => setMemberId(event.target.value)} required><option value="">{copy.chooseMember}</option>{members.map((person) => <option key={person.userId} value={person.userId}>{person.displayName}</option>)}</select></Field>
      <Field label={copy.steward}><select value={stewardId} onChange={(event) => setStewardId(event.target.value)} required><option value="">{copy.chooseMember}</option>{stewards.map((person) => <option key={person.userId} value={person.userId}>{person.displayName}</option>)}</select></Field>
      <Field label={copy.note} hint={copy.noteHint}><textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} /></Field>
      <BusyButton type="submit" className="member-support-button" pending={busy} disabled={(!memberId) || (!stewardId)}>{copy.send}</BusyButton>
    </form>
    </> : <p className="member-support-muted">{copy.oversightOnly}</p>}
    <div className="member-support-handoff-filter"><label>{copy.status}<select ref={statusSelect} value={status} onChange={(event) => filter(event.target.value)}>{["", "pending", "acknowledged", "declined", "cancelled"].map((value) => <option value={value} key={value || "all"}>{copy.statuses[value]}</option>)}</select></label></div>
    <div className="member-support-list">{!shownHistory ? <p role="status">{t("app.loading")}</p> : shownHistory.loadFailed ? <div>
      <p key={failureAttempt} role="alert">{copy.loadFailed}</p>
      <BusyButton type="button" pending={retrying} className="member-support-button member-support-button--secondary" onClick={retryHistory}>{viewCopy.retry}</BusyButton>
    </div> : shownHistory.items.length === 0 ? <Empty title={copy.noHistory[0]} body={copy.noHistory[1]} /> : shownHistory.items.map((handoff) => <article className="member-support-card" key={handoff.id}>
      <div className="member-support-card__heading"><div><strong>{handoff.memberName}</strong><span>{handoff.fromStewardName} → {handoff.toStewardName} · {copy.directions[handoff.direction] || label(handoff.direction)}</span></div><span className="member-support-status">{copy.statuses[handoff.status] || label(handoff.status)}</span></div>
      {handoff.note && <p className="member-support-note">{handoff.note}</p>}
      <small>{memberStamp(handoff.createdAt, lang, copy.dateUnavailable)}</small>
      <div className="member-support-actions">{handoff.canAcknowledge && <BusyButton type="button" pending={busy} className="member-support-button" onClick={() => commit(() => adapter.acknowledgeHandoff(actor, handoff.id), copy.acknowledged)}>{copy.acknowledge}</BusyButton>}{handoff.canDecline && <BusyButton type="button" pending={busy} className="member-support-button member-support-button--secondary" onClick={() => commit(() => adapter.declineHandoff(actor, handoff.id), copy.declined)}>{copy.decline}</BusyButton>}{handoff.canCancel && <BusyButton type="button" pending={busy} className="member-support-button member-support-button--secondary" onClick={() => window.confirm(fill(copy.cancelConfirm, { name: handoff.memberName })) && commit(() => adapter.cancelHandoff(actor, handoff.id), copy.cancelled)}>{copy.cancel}</BusyButton>}</div>
    </article>)}{shownHistory?.nextCursor && <BusyButton type="button" pending={busy} className="member-support-button member-support-button--secondary" onClick={loadOlder}>{copy.loadOlder}</BusyButton>}</div>
  </section>;
}

// REQ-UG-ALT-PORT-MEMBER-PAGES-20261030: the alternate shell's Help
// page (prototype pages/help.js /help) draws each desk program as one of the
// prototype's program cards. Its glyph and its "who it is for" chip.
const ALT_PROGRAMS = Object.freeze({
  rights: { icon: "shield", tag: "urgent" },
  accommodations: { icon: "hand", tag: "work" },
  hr: { icon: "briefcase", tag: "work" },
  onboarding: { icon: "flag", tag: "new" },
  mentorship: { icon: "users", tag: "new" },
  handoffs: { icon: "swap", tag: "staff" },
});
const ALT_PROGRAM_TAGS = Object.freeze(["all", "urgent", "work", "new", "staff"]);

// The live figure a program card shows where the prototype shows an amount:
// counted from the loaded desk, never a sample.
function altProgramFigure(id, model, copy, t) {
  if (id === "rights") {
    const alerted = model.emergencyChecklists.some((item) => item.status === "alerted"
      && (!item.memberUserId || item.memberUserId === model.viewerUserId));
    return { value: EMERGENCY_SCENARIOS.length, sub: t(alerted ? "altHelpPages.prog_rights_alerted" : "altHelpPages.prog_rights_fig") };
  }
  if (id === "accommodations") return { value: model.accommodationSummary.open, sub: t("altHelpPages.prog_accommodations_fig") };
  if (id === "hr") return { value: model.hrContacts.length, sub: t("altHelpPages.prog_hr_fig") };
  if (id === "onboarding") {
    const active = model.onboardingProgram.filter((step) => step.active);
    if (model.onboardingPlan && active.length) {
      const done = new Set(model.onboardingPlan.completedStepIds || []);
      const completed = active.filter((step) => done.has(step.id)).length;
      return { value: `${completed}/${active.length}`, sub: t("altHelpPages.prog_onboarding_done", { completed, total: active.length }) };
    }
    return { value: active.length || copy.onboarding.defaultProgram.steps.length, sub: t("altHelpPages.prog_onboarding_fig") };
  }
  if (id === "mentorship") return { value: model.mentorshipPairs.filter((pair) => pair.status === "active").length, sub: t("altHelpPages.prog_mentorship_fig") };
  const pending = pendingHandoffCount(model);
  if (pending === null) return { value: "—", sub: copy.handoffs.loadFailed };
  return { value: pending, sub: t("altHelpPages.prog_handoffs_fig") };
}

export function MemberSupportView({ actor, client, onNavigate = null, onSwitchHat = null, onSignOut = null, coachMark = null, alt = false, onOpenHome = null, guideSwitches = null }) {
  const busyWriteRef = useRef(new Set());
  const { lang, t } = useLang();
  const copy = COPY[lang] || COPY.en;
  const actorRef = useRef(actor);
  actorRef.current = actor;
  const actorKey = featureActorIdentityKey(actor);
  const scopedActor = useMemo(() => {
    void actorKey;
    return normalizeMemberSupportActor(actorRef.current);
  }, [actorKey]);
  const adapter = useMemo(() => createMemberSupportAdapter(client), [client]);
  const [model, setModel] = useState(() => ({ state: "empty" }));
  const [modelActorKey, setModelActorKey] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useRoutedTab("support", "rights");
  const [handoffStatus, setHandoffStatus] = useState("");
  const handoffStatusRef = useRef(handoffStatus);
  handoffStatusRef.current = handoffStatus;
  const actorKeyRef = useRef(actorKey);
  actorKeyRef.current = actorKey;
  // First load and actor-identity changes replace the desk. A post-write
  // revalidation of the same actor stays silent so the open panel tree
  // never unmounts. HandoffsPanel.filter already refetches listHandoffs;
  // this callback must not rebuild when only the status filter changes.
  const load = useCallback(async () => {
    const requestedActorKey = actorKey;
    const next = await adapter.load(scopedActor);
    if (next.state === "ready" && next.staff) {
      const filterStatus = handoffStatusRef.current;
      const history = readHandoffPage(adapter, scopedActor, filterStatus);
      if (!canCountPendingHandoffs(filterStatus)) {
        next.handoffSummary = await readHandoffPage(adapter, scopedActor, "pending");
      }
      next.handoffs = await history;
    }
    if (actorKeyRef.current !== requestedActorKey) return;
    setModel(next);
    setModelActorKey(requestedActorKey);
  }, [adapter, scopedActor, actorKey]);
  useEffect(() => { load(); }, [actorKey, load]);
  const settleHandoffHistory = (previousPage, page, status) => {
    if (actorKeyRef.current !== actorKey || handoffStatusRef.current !== status) return;
    // The filter owns the displayed page. Updating the count must not replace the
    // workspace's input page and interrupt a newer filter or retry.
    setModel((current) => current.handoffs === previousPage ? { ...current, handoffSummary: page } : current);
  };
  // `reloadOnFailure` re-reads the desk after a failed write that may have
  // changed something first (an onboarding step move); `failureText` gives
  // that write its own sentence.
  // One write at a time. Buttons that keep focus while a write runs mark it
  // with aria-disabled instead of disabled, so this guard, not the attribute,
  // refuses a second click.
  const committingRef = useRef(false);
  const commit = useCallback(async (operation, success, after = null, { reloadOnFailure = false, failureText = null } = {}) => {
    return prepareBusyWrite(busyWriteRef, "busy", () => {
      if (committingRef.current) return;
      return async (releaseBusyWrite) => {
      committingRef.current = true;
      setBusy(true); setNotice("");
      try {
        await operation();
        after?.();
        setNotice(success);
        // The shell's onboarding guide (stage card, guided navigation) re-reads
        // the member's progress right away instead of at the next navigation.
        window.dispatchEvent(new Event(ONBOARDING_GUIDE_REFRESH_EVENT));
        await load();
      } catch (error) {
        setNotice(failureText?.(error) || failureNotice(error, copy, copy.saveFailed, lang));
        if (reloadOnFailure) {
          window.dispatchEvent(new Event(ONBOARDING_GUIDE_REFRESH_EVENT));
          await load();
        }
      } finally {
        committingRef.current = false;
        setBusy(false);

        releaseBusyWrite();
      }
          };
    });
  }, [load, copy, lang]);
  // The desk belongs to the actor the loaded model was built for. Any other
  // actor identity replaces the desk behind the loading state instead of
  // silently refreshing someone else's records in place.
  const deskLoading = modelActorKey !== actorKey;
  const [altQuery, setAltQuery] = useState("");
  const [altTag, setAltTag] = useState("all");
  const [matchOpen, setMatchOpen] = useState(false);
  const [altFocus, setAltFocus] = useState(0);
  const altDetailRef = useRef(null);
  useEffect(() => { if (altFocus) altDetailRef.current?.focus(); }, [altFocus]);

  const panels = !deskLoading && model.state === "ready" ? <>
    {tab === "rights" && <EmergencyRightsPanel {...{ model, actor: scopedActor, adapter, busy, commit, copy }} />}
    {tab === "accommodations" && <AccommodationPanel {...{ model, actor: scopedActor, adapter, busy, commit, copy }} />}
    {tab === "hr" && <HrContactPanel {...{ model, actor: scopedActor, adapter, busy, commit, copy }} />}
    {tab === "onboarding" && <OnboardingPanel {...{ model, actor: scopedActor, adapter, busy, commit, copy, onNavigate, coachMark, guideSwitches }} />}
    {tab === "mentorship" && <MentorshipPanel {...{ model, actor: scopedActor, adapter, busy, commit, copy }} />}
    {tab === "handoffs" && model.staff && <HandoffsPanel {...{ model, actor: scopedActor, adapter, busy, commit, onNotice: setNotice, status: handoffStatus, onStatusChange: setHandoffStatus, onHistorySettled: settleHandoffHistory, copy }} />}
  </> : null;
  const scope = model.staff ? fill(copy.staffScope, { hat: machineLabel(copy.hats, scopedActor.selectedHat) }) : copy.memberScope;
  const stateCard = <StateCard model={model} loading={deskLoading} onRetry={load} actorHat={scopedActor.selectedHat} onNavigate={onNavigate} onSwitchHat={onSwitchHat} onSignOut={client ? onSignOut : null} copy={copy} />;
  const noticeLine = <p className="member-support-notice" role="status" aria-live="polite">{notice}</p>;

  // REQ-UG-ALT-PORT-MEMBER-PAGES-20261030: the alternate shell's Help
  // page (prototype pages/help.js /help). The hero with its matcher, the
  // search and "who it is for" chips over a grid of program cards, one per
  // desk tab, each carrying its live count; the open program's own panel
  // (the same forms, lists and server actions as the classic desk) follows
  // in the prototype's split with its terms beside it.
  if (alt) {
    const ready = !deskLoading && model.state === "ready";
    const programs = MEMBER_SUPPORT_TABS.filter((item) => !item.staffOnly || model.staff).map((item) => ({
      id: item.id,
      name: copy.tabs[item.id] || item.label,
      eyebrow: copy[item.id].eyebrow,
      summary: t(`altHelpPages.prog_${item.id}_sum`),
      ...ALT_PROGRAMS[item.id],
    }));
    const needle = altQuery.trim().toLowerCase();
    const shown = programs.filter((program) => (altTag === "all" || program.tag === altTag)
      && (!needle || `${program.name} ${program.eyebrow} ${program.summary}`.toLowerCase().includes(needle)));
    const tags = ALT_PROGRAM_TAGS.filter((tag) => tag === "all" || programs.some((program) => program.tag === tag));
    const selected = programs.find((program) => program.id === tab) || programs[0];
    const openProgram = (id) => { setTab(id); setAltFocus((count) => count + 1); };
    const card = (program) => {
      const figure = altProgramFigure(program.id, model, copy, t);
      const current = program.id === selected.id;
      return <article className="ug-pg ug-alt-help-pg" aria-labelledby={`ug-pg-${program.id}`} data-current={current || undefined} key={program.id}>
        <div className="ug-pg-top"><span className="ug-ic" aria-hidden="true"><Icon name={program.icon} /></span><span><b id={`ug-pg-${program.id}`}>{program.name}</b><span>{program.eyebrow}</span></span></div>
        <div className="ug-amt ug-tnum">{figure.value}</div><div className="ug-amt-sub">{figure.sub}</div>
        <p className="ug-for">{program.summary}</p>
        <div className="ug-meter-lbl">{t("altHelpPages.hardLabel")}</div>
        <div className="ug-meter" role="img" aria-label={t("altHelpPages.hardAria")}><i /><i /><i /><b>{t("altHelpPages.hardNone")}</b></div>
        <div className="ug-meter-why">{t("altHelpPages.hardWhy")}</div>
        <ul className="ug-pg-list"><li><Icon name="users" /><span>{t(`altHelpPages.prog_${program.id}_who`)}</span></li><li><Icon name="check" /><span>{t(`altHelpPages.prog_${program.id}_how`)}</span></li></ul>
        <div className="ug-pg-actions"><button className={`ug-btn ug-btn-sm ${current ? "ug-btn-soft" : "ug-btn-dark"}`} type="button" aria-current={current || undefined} onClick={() => openProgram(program.id)}>{t(current ? "altHelpPages.opened" : "altHelpPages.open")}{" "}<span className="ug-sr">{program.name}</span></button></div>
      </article>;
    };
    const figure = ready ? altProgramFigure(selected.id, model, copy, t) : null;
    return <div className="ug-alt-help" data-mi1-surface="member-support">
      <section className="ug-page-hero ug-alt-help-hero">
        <div className="ug-wrap ug-help-hero">
          <div>
            <HelpCrumbs onOpenHome={onOpenHome} trail={[{ label: t("altHelpPages.helpCrumb") }]} />
            <h1>{t("altHelpPages.helpH1Lead")}<span className="ug-accent">{t("altHelpPages.helpH1Accent")}</span></h1>
            <p className="ug-lede">{t("altHelpPages.helpLede", { count: programs.length })}</p>
            <p className="ug-alt-help-scope"><span className="ug-tag ug-t-win">{t("altHelpPages.scope")}: {scope}</span></p>
            <div className="ug-btn-row ug-alt-help-cta">
              <button className="ug-btn ug-btn-dark" type="button" disabled={!ready} onClick={() => setMatchOpen(true)}>{t("altHelpPages.helpMatch")}</button>
              <StateRouteLink path="/m/rights" view="rights" onNavigate={onNavigate} className="ug-btn ug-btn-soft">{t("altHelpPages.helpRights")}</StateRouteLink>
            </div>
          </div>
          <div className="ug-note ug-warn ug-alt-help-note"><Icon name="info" /><span>{t("altHelpPages.helpNote")}</span></div>
        </div>
        {ready ? <div className="ug-wrap"><div className="ug-toolbar">
          <label className="ug-search-in"><span className="ug-sr">{t("altHelpPages.helpSearch")}</span><Icon name="search" /><input type="search" placeholder={t("altHelpPages.helpSearch")} value={altQuery} onChange={(event) => setAltQuery(event.target.value)} /></label>
          <div className="ug-chips" role="group" aria-label={t("altHelpPages.helpFor")}>
            {tags.map((tag) => <button className="ug-chip" type="button" aria-pressed={altTag === tag} key={tag} onClick={() => setAltTag(tag)}>{t(`altHelpPages.tag_${tag}`)} <span className="ug-n">{tag === "all" ? programs.length : programs.filter((program) => program.tag === tag).length}</span></button>)}
          </div>
        </div></div> : null}
      </section>
      <div className="ug-wrap ug-legacy ug-alt-help-state">{noticeLine}{stateCard}</div>
      {ready ? <>
        <section className="ug-wrap ug-alt-help-programs" aria-label={t("altHelpPages.helpCrumb")}>
          <div className="ug-pg-grid">
            {shown.length ? shown.map(card) : <div className="ug-empty ug-alt-help-empty"><b>{t("altHelpPages.helpNone")}</b>{t("altHelpPages.helpNoneBody")}</div>}
          </div>
        </section>
        <section className="ug-wrap ug-split ug-alt-help-detail" ref={altDetailRef} tabIndex={-1} aria-labelledby="ug-alt-help-detail-title">
          <div className="ug-legacy">{panels}</div>
          <aside className="ug-alt-help-aside">
            <div className="ug-panel-w">
              <h3 id="ug-alt-help-detail-title">{selected.name}</h3>
              <dl className="ug-dl">
                <dt>{t("altHelpPages.detailWho")}</dt><dd>{t(`altHelpPages.prog_${selected.id}_who`)}</dd>
                <dt>{t("altHelpPages.detailHow")}</dt><dd>{t(`altHelpPages.prog_${selected.id}_how`)}</dd>
                <dt>{t("altHelpPages.detailNow")}</dt><dd>{figure.value} · {figure.sub}</dd>
              </dl>
              {onNavigate ? <div className="ug-btn-row ug-alt-help-row">
                <button className="ug-btn ug-btn-dark ug-btn-sm" type="button" onClick={() => onNavigate("messages", "/m/messages")}><Icon name="msg" />{t("altHelpPages.messageSteward")}</button>
                {selected.id === "rights" ? <button className="ug-btn ug-btn-soft ug-btn-sm" type="button" onClick={() => onNavigate("rights", "/m/rights")}>{t("altHelpPages.helpRights")}</button> : null}
              </div> : null}
            </div>
          </aside>
        </section>
      </> : null}
      {matchOpen ? <HelpMatcher
        programs={programs}
        onClose={() => setMatchOpen(false)}
        onPick={(id) => { setMatchOpen(false); openProgram(id); }}
        onSay={onNavigate ? () => { setMatchOpen(false); onNavigate("rights", "/m/rights"); } : null}
      /> : null}
    </div>;
  }

  return <section className="member-support-desk" aria-label={copy.workspaceAria} data-mi1-surface="member-support">
    <header className="member-support-header"><div><p className="member-support-eyebrow">{copy.title}</p><h1>{t("nav.memberSupport")}</h1><p>{copy.description}</p></div><span className="member-support-scope">{scope}</span></header>
    <div className="member-support-tabs" role="group" aria-label={copy.eyebrow}>{MEMBER_SUPPORT_TABS.filter((item) => !item.staffOnly || model.staff).map((item) => <RoutedTabLink group="support" value={item.id} type="button" aria-pressed={tab === item.id} key={item.id} onClick={() => setTab(item.id)}>{copy.tabs[item.id] || item.label}</RoutedTabLink>)}</div>
    {noticeLine}
    {stateCard}
    {panels}
  </section>;
}
