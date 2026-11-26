import * as spanishNamespaceRegistry from "./spanishNamespaces.js";
import { LANDING_CHROME_COPYSpanish } from "./locales/es/namespaces/landingChromeCopy.js";
// The Spanish half of the web catalogue, loaded on demand
// (PERF-UG-WEB-SHELL-AND-PER-LANGUAGE-BUNDLES-20261011).
//
// src/lib/i18n.js keeps the English table in the entry chunk because English
// is the fallback for every lookup; this module is reached only through
// loadLanguage("es") there, so Vite emits it as its own chunk and a member
// reading English never downloads it. Node, scripts and tests register it
// synchronously through ./allLanguages.js instead.
//
// The Spanish strings live in ./locales/es/<area>.js, the same areas as the
// English ./locales/en/<area>.js, and the literal below spreads them together
// (OPS-UG-I18N-PER-AREA-LOCALE-MODULES-20261109). Add or edit a key in its
// area module, never here; only the legal release keys stay inline, because
// the legal release tooling hashes their lines in this file. Every rule in the
// barrel's header (key names, the capítulo glossary, chunked namespaces
// declared only in their chunk file) applies here unchanged, and
// tests/i18n.test.js reads this file and its area modules as the Spanish
// sources.
import { telemetryCatalogue } from "./telemetry.js";
import { bargainingWriterCatalogue } from "./bargainingWriter.js";
import { operatorCatalogue } from "./operator.js";
import { automationAvailabilityCatalogue } from "./automationAvailability.js";
import { subprocessorsCatalogue } from "./subprocessors.js";
import { agendaItemsCatalogue } from "./agendaItems.js";
import { chapterBudgetCatalogue } from "./chapterBudget.js";
import { chapterFinanceCatalogueSpanish } from "./locales/es/namespaces/chapterFinance.js";
import { chapterAccessCatalogueSpanish } from "./locales/es/namespaces/chapterAccess.js";
import { eventModelCatalogueSpanish } from "./locales/es/namespaces/eventModel.js";
import { eventTypeCatalogueSpanish } from "./locales/es/namespaces/eventTypes.js";
import { connectedWorkflowsCatalogueSpanish } from "./locales/es/namespaces/connectedWorkflows.js";
import { workplaceRosterCatalogueSpanish } from "./locales/es/namespaces/workplaceRoster.js";
import { workloadConfigurationCatalogueSpanish } from "./locales/es/namespaces/workloadConfiguration.js";
import { workloadConfigurationEditorCatalogueSpanish } from "./locales/es/namespaces/workloadConfigurationEditor.js";
import { caseworkUlpCatalogueSpanish } from "./locales/es/namespaces/caseworkUlp.js";
import { caseworkDeadlinesCatalogueSpanish } from "./locales/es/namespaces/caseworkDeadlines.js";
import { caseIntakeCatalogue } from "./caseIntake.js";
import { rightsQuestionsCatalogue } from "./rightsQuestions.js";
import { caseNotesCatalogue } from "./caseNotes.js";
import { stewardMatchCatalogueSpanish } from "./locales/es/namespaces/stewardMatch.js";
import { caseworkStrengthCatalogueSpanish } from "./locales/es/namespaces/caseworkStrength.js";
import { stewardHintCatalogueSpanish } from "./locales/es/namespaces/stewardHint.js";
import { messageVisibilityCatalogueSpanish } from "./locales/es/namespaces/messageVisibility.js";
import { crossChapterPeersCatalogueSpanish } from "./locales/es/namespaces/crossChapterPeers.js";
import { adminAttentionCatalogue } from "./adminAttention.js";
import { intakeQueueCatalogue } from "./intakeQueue.js";
import { seniorityCatalogue } from "./seniority.js";
import { sourceLineCatalogue } from "./sourceLine.js";
import { topicUpdateCatalogue } from "./topicUpdate.js";
import { rightsLibraryCatalogueSpanish } from "./locales/es/namespaces/rightsLibrary.js";
import { glossaryCatalogueSpanish } from "./locales/es/namespaces/glossary.js";
import { altShellCatalogueSpanish } from "./locales/es/namespaces/altShell.js";
import { altTakePartCatalogue } from "./altTakePart.js";
import { altRecordPagesCatalogue } from "./altRecordPages.js";
import { altHelpPagesCatalogue } from "./altHelpPages.js";
import { automationRestoreCatalogueSpanish } from "./locales/es/namespaces/automationRestore.js";
import { homeTakeoverCatalogueSpanish } from "./locales/es/namespaces/homeTakeover.js";
import { welcomeBackCatalogueSpanish } from "./locales/es/namespaces/welcomeBack.js";
import { seededLabelsCatalogueSpanish } from "./locales/es/namespaces/seededLabels.js";
import { bilingualContentCatalogue } from "./bilingualContent.js";
import { csvExportsCatalogue } from "./csvExports.js";
import { fixtureNotificationsCatalogue } from "./fixtureNotifications.js";
import { navUsageCatalogueSpanish } from "./locales/es/namespaces/navUsage.js";
import { whatMattersNowCatalogueSpanish } from "./locales/es/namespaces/whatMattersNow.js";
import { homeNudgesCatalogueSpanish } from "./locales/es/namespaces/homeNudges.js";
import { guideEngineCatalogueSpanish } from "./locales/es/namespaces/guideEngine.js";
import { onboardingAdminCatalogue } from "./onboardingAdmin.js";
import { messageReactionsCatalogueSpanish } from "./locales/es/namespaces/messageReactions.js";
import { qaCatalogueSpanish } from "./locales/es/namespaces/qa.js";
import { connectionSuggestionsCatalogueSpanish } from "./locales/es/namespaces/connectionSuggestions.js";
import { connectionProfilePublishCatalogueSpanish } from "./locales/es/namespaces/connectionProfilePublish.js";
import { partnerOfficesCatalogueSpanish } from "./locales/es/namespaces/partnerOffices.js";
import { unionCatalogCatalogueSpanish } from "./locales/es/namespaces/unionCatalog.js";
import { learningContentCatalogueSpanish } from "./locales/es/namespaces/learningContent.js";
import { getAppCatalogue } from "./getApp.js";
import { openSignupCatalogueSpanish } from "./locales/es/namespaces/openSignup.js";
import { requestInviteCatalogueSpanish } from "./locales/es/namespaces/requestInvite.js";
import { pricingCatalogueSpanish } from "./locales/es/namespaces/pricing.js";
import { organizationHtmlFormsCatalogue } from "./organizationHtmlForms.js";
import { formAutofillCatalogue } from "./formAutofill.js";
import { eventCheckInCatalogueSpanish } from "./locales/es/namespaces/eventCheckIn.js";
import { boundedListsCatalogueSpanish } from "./locales/es/namespaces/boundedLists.js";
import { issueIntelligenceCatalogueSpanish } from "./locales/es/namespaces/issueIntelligence.js";
import { caseSignalsCatalogueSpanish } from "./locales/es/namespaces/caseSignals.js";
import { remindHereRoutingCatalogueSpanish } from "./locales/es/namespaces/remindHereRouting.js";
import { channelControlsCatalogueSpanish } from "./locales/es/namespaces/channelControls.js";
import { governanceCatalogueSpanish } from "./locales/es/namespaces/governance.js";
import { navigationLinksCatalogueSpanish } from "./locales/es/namespaces/navigationLinks.js";
import { compassAssistantCatalogueSpanish } from "./locales/es/namespaces/compassAssistant.js";
import { fieldNotesPacketCatalogueSpanish } from "./locales/es/namespaces/fieldNotesPacket.js";
import { learningPeriodCatalogueSpanish } from "./locales/es/namespaces/learningPeriod.js";
import { shellStrings } from "./locales/es/shell.js";
import { homeStrings } from "./locales/es/home.js";
import { authStrings } from "./locales/es/auth.js";
import { publicStrings } from "./locales/es/public.js";
import { settingsStrings } from "./locales/es/settings.js";
import { adminStrings } from "./locales/es/admin.js";
import { organizationAdminStrings } from "./locales/es/organizationAdmin.js";
import { automationStrings } from "./locales/es/automation.js";
import { coordinationStrings } from "./locales/es/coordination.js";
import { analyticsStrings } from "./locales/es/analytics.js";
import { caseworkStrings } from "./locales/es/casework.js";
import { stewardStrings } from "./locales/es/steward.js";
import { knowledgeStrings } from "./locales/es/knowledge.js";
import { tasksStrings } from "./locales/es/tasks.js";
import { workloadStrings } from "./locales/es/workload.js";
import { appointmentsStrings } from "./locales/es/appointments.js";
import { engagementStrings } from "./locales/es/engagement.js";
import { votingStrings } from "./locales/es/voting.js";
import { eventsStrings } from "./locales/es/events.js";
import { messagingStrings } from "./locales/es/messaging.js";
import { voiceStrings } from "./locales/es/voice.js";
import { organizeStrings } from "./locales/es/organize.js";
import { duesStrings } from "./locales/es/dues.js";
import { formsStrings } from "./locales/es/forms.js";


spanishNamespaceRegistry.registerSpanishNamespaces({
  chapterFinanceCatalogueSpanish,
  chapterAccessCatalogueSpanish,
  workplaceRosterCatalogueSpanish,
  workloadConfigurationCatalogueSpanish,
  workloadConfigurationEditorCatalogueSpanish,
  connectedWorkflowsCatalogueSpanish,
  welcomeBackCatalogueSpanish,
  seededLabelsCatalogueSpanish,
  connectionSuggestionsCatalogueSpanish,
  connectionProfilePublishCatalogueSpanish,
  partnerOfficesCatalogueSpanish,
  navUsageCatalogueSpanish,
  messageReactionsCatalogueSpanish,
  stewardHintCatalogueSpanish,
  messageVisibilityCatalogueSpanish,
  crossChapterPeersCatalogueSpanish,
  rightsLibraryCatalogueSpanish,
  glossaryCatalogueSpanish,
  altShellCatalogueSpanish,
  caseworkUlpCatalogueSpanish,
  caseworkDeadlinesCatalogueSpanish,
  stewardMatchCatalogueSpanish,
  caseworkStrengthCatalogueSpanish,
  automationRestoreCatalogueSpanish,
  qaCatalogueSpanish,
  homeTakeoverCatalogueSpanish,
  unionCatalogCatalogueSpanish,
  whatMattersNowCatalogueSpanish,
  homeNudgesCatalogueSpanish,
  guideEngineCatalogueSpanish,
  openSignupCatalogueSpanish,
  requestInviteCatalogueSpanish,
  pricingCatalogueSpanish,
  eventCheckInCatalogueSpanish,
  boundedListsCatalogueSpanish,
  issueIntelligenceCatalogueSpanish,
  caseSignalsCatalogueSpanish,
  remindHereRoutingCatalogueSpanish,
  channelControlsCatalogueSpanish,
  governanceCatalogueSpanish,
  navigationLinksCatalogueSpanish,
  compassAssistantCatalogueSpanish,
  fieldNotesPacketCatalogueSpanish,
  learningPeriodCatalogueSpanish,
  eventModelCatalogueSpanish,
  eventTypeCatalogueSpanish,
  learningContentCatalogueSpanish,
  LANDING_CHROME_COPYSpanish,
});

export const spanishCatalogue = {
  es: {
    // Per-area modules (src/lib/i18n/locales/es/), one per screen or
    // area; new keys go there. Legal release keys stay below in this file.
    ...shellStrings,
    ...homeStrings,
    ...authStrings,
    ...publicStrings,
    ...settingsStrings,
    ...adminStrings,
    ...organizationAdminStrings,
    ...automationStrings,
    ...coordinationStrings,
    ...analyticsStrings,
    ...caseworkStrings,
    ...stewardStrings,
    ...knowledgeStrings,
    ...tasksStrings,
    ...workloadStrings,
    ...appointmentsStrings,
    ...engagementStrings,
    ...votingStrings,
    ...eventsStrings,
    ...messagingStrings,
    ...voiceStrings,
    ...organizeStrings,
    ...duesStrings,
    ...formsStrings,
    ...automationAvailabilityCatalogue.es,
    ...workloadConfigurationCatalogueSpanish,
    ...workloadConfigurationEditorCatalogueSpanish,
    ...telemetryCatalogue.es,
    ...bargainingWriterCatalogue.es,
    ...operatorCatalogue.es,
    ...subprocessorsCatalogue.es,
    ...agendaItemsCatalogue.es,
    ...chapterBudgetCatalogue.es,
    ...chapterAccessCatalogueSpanish,
    ...chapterFinanceCatalogueSpanish,
    ...eventModelCatalogueSpanish,
    ...eventTypeCatalogueSpanish,
    ...connectedWorkflowsCatalogueSpanish,
    ...workplaceRosterCatalogueSpanish,
    ...caseworkUlpCatalogueSpanish,
    ...caseworkDeadlinesCatalogueSpanish,
    ...caseIntakeCatalogue.es,
    ...rightsQuestionsCatalogue.es,
    ...caseNotesCatalogue.es,
    ...stewardMatchCatalogueSpanish,
    ...caseworkStrengthCatalogueSpanish,
    "legal.publicInformation": "Información pública",
    "legal.navigation": "Información legal",
    "legal.contents": "En esta página",
    "legal.contact.title": "Contacta a Union Ground",
    "legal.contact.none": "Todavía no se publica ninguna dirección. Para recibir ayuda con tu cuenta, usa el contacto que te dio acceso.",
    "legal.contact.ownerBody": "Para preguntas de privacidad, seguridad o generales:",
    "legal.contact.supportBody": "Para ayuda con el acceso, los términos o la accesibilidad:",
    "legal.privacy.platformUpdates.title": "Novedades opcionales del producto",
    "legal.privacy.platformUpdates.body": "El administrador de tu organización puede elegir recibir novedades del producto Union Ground y dejar de seguirlas en cualquier momento. Cada persona puede ocultarlas o volver a mostrarlas. Union Ground es responsable del contenido del producto que publica y del estado de seguimiento de la organización necesario para operar este canal opcional. Este canal no recopila listas de trabajadores, destinatarios, lecturas, reacciones ni datos de interacción. Seguirlo no otorga acceso adicional a datos de trabajadores ni cambia nuestras obligaciones separadas como encargado del tratamiento del contenido de cada organización.",
    "legal.changelog.note.platformAnnouncements": "Anuncios opcionales del producto con consentimiento de la organización: finalidad de publicación, estado de seguimiento solo por organización, revocación del administrador y opción personal de ocultarlos. Revisión sustancial de privacidad 1.3.0; se vuelve a pedir la aceptación.",
    "legal.changelog.note.nativePulseCharts": "Describe la caché opcional de imágenes PNG de gráficos Pulse de la app, su límite de tamaño y su eliminación tras compartir o una exportación interrumpida. Las especificaciones y los gráficos fijados se guardan con la cuenta en el servidor; no se exportan datos personales ni grupos ocultos. No añade analítica de producto. No es sustancial: las aceptaciones existentes de la versión 1.3.0 siguen siendo válidas sin aceptar de nuevo.",
    "legal.changelog.note.officerRosterExport": "Indica que los administradores y las presidencias y secretarías-tesorerías de campaña pueden exportar la lista de trabajadores que ya pueden ver, sin correos electrónicos ni datos de contacto que un trabajador no compartió, y que cada exportación queda registrada. El acceso sigue los límites existentes por campaña y función. No es sustancial: las aceptaciones existentes de la versión 1.3.0 siguen siendo válidas sin aceptar de nuevo.",
    "legal.privacy.title": "Privacidad",
    "legal.privacy.intro": "Union Ground está hecho para trabajadores que organizan un sindicato, así que trata como privados, de forma predeterminada, los nombres de compañeros, los conteos de tarjetas y las notas de asuntos. Esta página describe la vista previa tal como está construida.",
    "legal.privacy.hold.title": "Qué guarda esta vista previa",
    "legal.privacy.hold.body": "El recorrido de la vista previa usa personas y registros ficticios. No hay ningún servidor de Union Ground en funcionamiento, así que no existen cuentas activas y nada de lo que escribes en el recorrido se envía a un servidor de Union Ground. Las preferencias, como tu idioma, se quedan en este navegador; la página de telemetría enumera cada clave guardada.",
    "legal.privacy.use.title": "Cómo se usa",
    "legal.privacy.use.body": "En esta vista previa, la información solo se usa para mostrar el recorrido en tu navegador. Cómo se usa la información de una cuenta activa se indicará en la política de privacidad formal, que se publicará antes de que se abran las cuentas activas.",
    "legal.privacy.control.title": "Su control",
    "legal.privacy.control.body": "Puedes eliminar lo que guarda esta vista previa borrando los datos de este sitio en tu navegador. Cómo solicitar acceso, corrección, exportación o eliminación para una cuenta activa se publicará antes de que se abran las cuentas activas.",
    "legal.privacy.sharing.title": "Divulgación",
    "legal.privacy.sharing.body": "La información de los trabajadores no se vende. Union Ground está diseñado para mantener las listas de trabajadores, los conteos de tarjetas y las notas de asuntos fuera de las páginas públicas. Esta vista previa no tiene datos activos que compartir; quién puede ver la información de una campaña activa se indicará en la política de privacidad formal.",
    "legal.privacy.catalogClaims.title": "Solicitudes de verificación de organizaciones",
    "legal.privacy.catalogClaims.body": "El código incluye una forma de que una organización pida que se verifique su ficha pública. Sin un servidor activo, en esta vista previa no se puede enviar ni guardar ninguna solicitud. Cómo se tratan estas solicitudes se publicará con la política de privacidad formal.",
    "legal.privacy.inviteRequests.title": "Solicitudes de invitación",
    "legal.privacy.inviteRequests.body": "Las cuentas de Union Ground serán solo por invitación. No hay ningún servicio de correo ni servidor configurado, así que en esta vista previa el formulario para pedir una invitación no puede entregar ni guardar una solicitud. Qué datos recoge una solicitud y quién la recibe se publicará antes de que se abran las cuentas activas.",
    "legal.privacy.joinRequests.title": "Solicitudes para unirse",
    "legal.privacy.joinRequests.body": "Si pides unir tu organización a Union Ground en /join, Union Ground guarda el nombre de la organización, tu cargo, tu correo, el tramo de tamaño y el estado de la organización si los indicas, el teléfono y la nota opcionales, y un código corto de campaña del enlace que seguiste, para que el equipo pueda responder y dar seguimiento. Un correo que anuncia la solicitud se envía, a través del proveedor de correo de Union Ground, al buzón de ventas de Union Ground; no se envía nada a la dirección que escribiste. La solicitud se conserva, también después de que el equipo la marque como contactada o cerrada, hasta que pidas que se elimine o una solicitud de baja confirmada la elimine. Para que se elimine una solicitud, escribe a la dirección de contacto que aparece abajo.",
    "legal.privacy.documentContributions.title": "Documentos compartidos",
    "legal.privacy.documentContributions.body": "Si compartes los documentos de tu organización en /contribute, Union Ground guarda el nombre de la organización y su afiliación opcional, su estado, tu nombre, cargo y correo, cómo quieres que te avisemos cuando los formularios digitalizados estén listos y el número de celular o la dirección postal que indiques para ello, el código de difusión del enlace que seguiste si tenía uno, tu nota opcional, las dos confirmaciones que marcas y los archivos que subes, para que el equipo pueda digitalizar los documentos, poner los formularios digitalizados a disposición de los trabajadores de tu organización y responderte. Solo deben subirse formularios en blanco y documentos sin información de trabajadores. Cada archivo se guarda en un almacenamiento privado que ningún visitante ni cuenta puede abrir, y el analizador de archivos de Union Ground lo revisa en busca de malware antes de aceptarlo; un archivo que no pasa la revisión no se usa. El número de celular o la dirección postal solo se usa para avisarte que los formularios están listos. Al enviar, no se manda nada a la dirección que escribiste. El envío se conserva hasta que pidas que se elimine. Para que se elimine, escribe a la dirección de contacto que aparece abajo.",
    "legal.privacy.mobile.title": "La aplicación móvil de Union Ground",
    "legal.privacy.mobile.body": "La aplicación de vista previa guarda tus cambios, tus preferencias y tu historial de la Guía en el almacenamiento protegido del dispositivo; no se sincronizan con otro teléfono. No tiene publicidad, rastreo, compras ni publicaciones públicas, y no se registra para recibir notificaciones push remotas. El calendario, la cámara, el micrófono y los recordatorios locales solo actúan cuando tú lo pides, y el sistema confirma cada permiso.",
    "legal.privacy.ai.title": "La Guía y la IA",
    "legal.privacy.ai.body": "No hay ningún proveedor de IA configurado para Union Ground, así que ninguna pregunta que le hagas a la Guía se envía a uno. Qué proveedor procesaría una pregunta, qué se enviaría y qué se conservaría se publicará en la página de divulgación de la Guía antes de activar la IA en vivo.",
    "legal.privacy.civic.title": "Acción cívica: su dirección y sus cartas a funcionarios",
    "legal.privacy.civic.body": "La acción cívica es opcional. Para encontrar a sus funcionarios electos puede dar su dirección postal de domicilio, que solo se guarda con su consentimiento explícito (versión del consentimiento {version}). La dirección se envía únicamente para la consulta de distritos: a Geocodio, para determinar sus distritos y la localidad, el condado y el distrito escolar donde vive, y al geocodificador público de la Oficina del Censo de EE. UU., para hallar sus distritos del Congreso y de la legislatura estatal. La Oficina del Censo solo recibe la calle, la ciudad, el estado y el código postal, nunca su nombre, su correo electrónico, su identificador de miembro ni su capítulo. Fuera de eso, la dirección nunca se muestra a los dirigentes ni al personal del capítulo, que solo ven recuentos. Para comprobar la exactitud de esos resultados, una muestra de direcciones también puede enviarse al servicio de información cívica de Google. Cuando pide ayuda para redactar una carta, el borrador lo escribe el mismo proveedor de IA gobernado que usa Compass, con una política de cero retención de datos, y nunca recibe su identidad: ni su nombre, ni su dirección, ni su correo electrónico, ni su teléfono, ni su cuenta. Su dirección, sus lugares, sus cartas y los reportes que envíe sobre funcionarios locales se incluyen en la exportación de sus datos y se eliminan junto con su cuenta.",
    "legal.privacy.effective": "Fecha de entrada en vigor: {date}.",
    "legal.privacy.links.title": "Páginas relacionadas",
    "legal.privacy.links.retention": "Calendario de retención de datos",
    "legal.privacy.links.deletion": "Solicitar la eliminación de la cuenta",
    "legal.deletionRequest.title": "Solicitar la eliminación de la cuenta",
    "legal.deletionRequest.intro": "Union Ground todavía no tiene cuentas activas, así que no hay ninguna cuenta que eliminar. Cómo pedir que se elimine una cuenta y sus datos se publicará aquí antes de que se abran las cuentas activas.",
    "legal.deletionRequest.inApp.title": "Si puedes iniciar sesión",
    "legal.deletionRequest.inApp.body": "En esta vista previa no se puede iniciar sesión para eliminar una cuenta, porque no hay cuentas activas. Los pasos y sus medidas de protección se publicarán aquí antes de que se abran las cuentas activas.",
    "legal.deletionRequest.email.title": "Si no puedes iniciar sesión",
    "legal.deletionRequest.email.body": "Todavía no se publica ninguna dirección de privacidad. Para recibir ayuda con tu cuenta, usa el contacto que te dio acceso. No envíes contraseñas, números de Seguro Social ni otros datos sensibles.",
    "legal.deletionRequest.verify.title": "Verificación de identidad",
    "legal.deletionRequest.verify.body": "Antes de eliminar algo, se debe confirmar que la solicitud proviene de la persona titular de la cuenta, porque una eliminación sin verificar es en sí misma una forma de atacar una cuenta. Los pasos de verificación se publicarán con la política de privacidad formal.",
    "legal.deletionRequest.timing.title": "Qué esperar y cuándo",
    "legal.deletionRequest.timing.body": "Todavía no se fijan los plazos de respuesta para las solicitudes de eliminación. Se publicarán aquí antes de que se abran las cuentas activas.",
    "legal.deletionRequest.record.title": "Cómo se registra cada resultado",
    "legal.deletionRequest.record.body": "Cómo se registrará cada solicitud de eliminación y su resultado se publicará aquí antes de que se abran las cuentas activas.",
    "legal.deletionRequest.scope.title": "Qué elimina la eliminación",
    "legal.deletionRequest.scope.body": "El calendario de retención de datos indica lo que guarda esta vista previa. Lo que elimina la eliminación de una cuenta activa se agregará antes de que se abran las cuentas activas.",
    "legal.deletionRequest.links.title": "Páginas relacionadas",
    "legal.deletionRequest.links.privacy": "Resumen de privacidad",
    "legal.deletionRequest.links.retention": "Calendario de retención de datos",
    "legal.terms.title": "Términos de uso",
    "legal.terms.intro": "Usa Union Ground para planificar el trabajo de organización con tus compañeros. Mantén privadas las listas de trabajadores y respeta a las personas con quienes te organizas.",
    "legal.terms.eligibility.title": "Qui\u00e9n puede usar Union Ground",
    "legal.terms.eligibility.body": "Esta vista previa es para evaluación y no hay cuentas activas. Quién puede tener una cuenta se fijará en los términos formales. El paso de aceptación de esta versión te pide confirmar que tienes 18 años o más.",
    "legal.terms.fees.title": "Piloto gratuito para organizaciones",
    "legal.terms.fees.body": "Union Ground es gratuito para las organizaciones piloto, por invitación. Un trabajador que usa una cuenta proporcionada por su organización no paga nada a Union Ground.",
    "legal.terms.responsibility.title": "Tu responsabilidad",
    "legal.terms.responsibility.body": "Usa solo cuentas que estés autorizado a usar, mantén correcta y privada la información de tus compañeros, y evita el acoso, la suplantación y el contenido ilegal.",
    "legal.terms.records.title": "Uso de la vista previa",
    "legal.terms.records.body": "Esta versión es una vista previa ficticia para evaluación. No es un lugar para guardar información real de tus compañeros. Una mayoría de tarjetas que se muestre en la vista previa no es certificación ni reconocimiento.",
    "legal.terms.availability.title": "Disponibilidad",
    "legal.terms.availability.body": "Esta vista previa puede cambiar o pausarse en cualquier momento. No es un servicio con cuentas activas.",
    "legal.terms.support.title": "Asistencia",
    "legal.terms.support.body": "Reporta inquietudes de acceso, seguridad o exactitud al contacto que te dio acceso. Todavía no se publica ninguna dirección de soporte.",
    "legal.terms.automated.title": "Acceso automatizado y uso de IA",
    "legal.terms.automated.body": "No uses herramientas automatizadas para recopilar, extraer o rastrear Union Ground o su contenido, ni uses ese contenido para entrenamiento de IA, recuperación mediante IA o conjuntos de datos, sin permiso por escrito. Los motores de búsqueda pueden seguir indexando las páginas públicas. Cómo pedir permiso se publicará con los términos formales.",
    "legal.terms.aiProviders.title": "Proveedores y agentes de IA nombrados",
    "legal.terms.aiProviders.body": "La regla de acceso automatizado anterior se aplica a todos los proveedores y agentes de IA, incluidos OpenAI (ChatGPT, GPTBot, Operator), Anthropic (Claude, ClaudeBot), Google (Gemini, Google-Extended), Microsoft (Copilot, Bing AI), Meta AI, Amazon (Alexa, Amazonbot), Apple Intelligence (Applebot-Extended), Perplexity, xAI (Grok), Mistral, Cohere, ByteDance (Bytespider), DeepSeek, Common Crawl (CCBot) y cualquier agente de IA, navegador agéntico o agente de programación que actúe en nombre de una persona o de una empresa, se identifique o no: cada uno puede leer las páginas públicas para responder preguntas, y ninguno puede usar el contenido de Union Ground para entrenamiento o conjuntos de datos sin permiso por escrito.",
    "legal.accessibility.title": "Accesibilidad",
    "legal.accessibility.intro": "Union Ground está diseñado para teclado, lectores de pantalla, ampliación, movimiento reducido y uso en el celular.",
    "legal.accessibility.standards.title": "Estándares",
    "legal.accessibility.standards.body": "El producto tiene como objetivo WCAG 2.2 AA para los flujos de trabajadores y del comité, en inglés y en español.",
    "legal.accessibility.supported.title": "Uso compatible",
    "legal.accessibility.supported.body": "Las acciones principales tienen etiquetas de texto, foco visible, controles semánticos y no dependen solo del color.",
    "legal.accessibility.report.title": "Reportar una barrera",
    "legal.accessibility.report.body": "Avísale al contacto que te dio acceso, e incluye la pantalla, el dispositivo, el navegador y lo que te impidió continuar.",
    "legal.accessibility.alternative.title": "Acceso alternativo",
    "legal.accessibility.alternative.body": "Mientras se corrige una barrera, pide a tu comité que comparta la misma información en otro formato accesible.",
    "legal.accessibility.links.title": "Páginas relacionadas",
    "legal.accessibility.links.statement": "Declaración de accesibilidad",
    "legal.accessibilityStatement.links.summary": "Resumen de accesibilidad",
    "legal.accessibilityStatement.title": "Declaración de accesibilidad",
    "legal.accessibilityStatement.notice": "Esta es la declaración de accesibilidad de la vista previa de Union Ground. Las políticas formales todavía no se publican y se publicarán antes de que se abran las cuentas activas.",
    "legal.accessibilityStatement.intro": "Union Ground tiene como objetivo WCAG 2.2 nivel AA. Se publicará una declaración formal de cumplimiento después de evaluar el producto.",
    "legal.accessibilityStatement.status.title": "Estado de cumplimiento",
    "legal.accessibilityStatement.status.body": "Todavía sin evaluar. No se afirma ningún nivel de cumplimiento para esta vista previa.",
    "legal.accessibilityStatement.scope.title": "Qué cubre esta declaración",
    "legal.accessibilityStatement.scope.body": "La aplicación web de Union Ground, sus páginas públicas y la aplicación móvil de Union Ground.",
    "legal.accessibilityStatement.evaluation.title": "Cómo se evaluará",
    "legal.accessibilityStatement.evaluation.body": "Antes de que se abran las cuentas activas. La aplicación móvil se evaluará con VoiceOver en iPhone y TalkBack en Android, en dispositivos físicos.",
    "legal.accessibilityStatement.exceptions.title": "Excepciones conocidas",
    "legal.accessibilityStatement.exceptions.body": "Ninguna registrada todavía, porque no se ha hecho ninguna evaluación. Las excepciones conocidas se enumerarán aquí después de la evaluación.",
    "legal.accessibilityStatement.unexercised.title": "Todavía sin evaluar",
    "legal.accessibilityStatement.unexercised.body": "Todo el producto. No se ha hecho ninguna evaluación ni ninguna auditoría externa.",
    "legal.accessibilityStatement.feedback.title": "Reportar una barrera",
    "legal.accessibilityStatement.feedback.body": "Avísale al contacto que te dio acceso, e incluye la pantalla, el dispositivo, el navegador y lo que te impidió continuar. Todavía no se publica ninguna dirección de accesibilidad ni de soporte.",
    "legal.accessibilityStatement.alternative.title": "Acceso alternativo",
    "legal.accessibilityStatement.alternative.body": "Mientras se corrige una barrera, pide a tu comité que comparta la misma información en otro formato accesible.",
    "legal.aiDisclosure.title": "Cómo usa la IA la Guía",
    "legal.aiDisclosure.intro": "La Guía responde preguntas de organización. En esta vista previa no hay ningún proveedor de IA configurado para Union Ground, así que ninguna pregunta se envía a uno.",
    "legal.aiDisclosure.route.title": "Proveedor de IA",
    "legal.aiDisclosure.route.body": "No hay ninguno configurado. Qué proveedor procesaría una pregunta se publicará aquí antes de activar la IA en vivo, y el registro de subencargados lo nombrará antes con un aviso fechado.",
    "legal.aiDisclosure.sent.title": "Qué se envía",
    "legal.aiDisclosure.sent.body": "En esta vista previa no se envía nada a ningún proveedor de IA. Qué incluiría una solicitud en vivo se publicará aquí antes de activar la IA en vivo. La retención opcional para entrenamiento es independiente del historial guardado de la Guía y está desactivada de forma predeterminada para cada miembro y organización. Solo después de que tanto el miembro como una persona administradora de la organización registren el aviso vigente y den su consentimiento, Union Ground puede conservar nuevos pares de preguntas y respuestas aptos para entrenar modelos más adelante. El texto debe pasar por el minimizador sin cambios: se excluyen el texto omitido, acortado o minimizado de otro modo, los hechos de casos, los datos del personal, los mensajes, los fragmentos de fuentes por separado y las solicitudes rechazadas. Se guardan hasta 100 muestras por miembro en el proyecto Supabase de esta instalación durante un máximo de 180 días; después caducan y se eliminan mediante el mantenimiento diario. Rechazarlo no limita la Guía. Exporta las muestras con los datos de tu cuenta o pide retirar tu consentimiento en Derechos de datos. La retirada elimina las muestras afectadas; la eliminación de la cuenta y el archivo de la organización también las eliminan. Las muestras no pueden salir del proyecto hacia un proveedor de entrenamiento sin una decisión independiente del propietario. Aceptar estas políticas no supone consentir el entrenamiento.",
    "legal.aiDisclosure.controls.title": "Medidas de protección",
    "legal.aiDisclosure.controls.body": "Las medidas de protección que se aplicarán a una solicitud en vivo se describirán aquí antes de activar la IA en vivo.",
    "legal.aiDisclosure.connector.title": "Proveedor de respaldo",
    "legal.aiDisclosure.connector.body": "Tampoco hay ningún proveedor de IA de respaldo configurado.",
    "legal.aiDisclosure.chapter.title": "No es asesoría legal",
    "legal.aiDisclosure.chapter.body": "La Guía explica los pasos de organización en lenguaje claro. No da conclusiones legales. Busca ayuda calificada para decisiones sobre tus derechos de organización o una campaña.",
    "legal.aiDisclosure.sensitive.title": "Protege la información sensible",
    "legal.aiDisclosure.sensitive.body": "No escribas contraseñas, números de Seguro Social, detalles médicos ni listas de compañeros. La Guía no es un servicio de emergencia.",
    "legal.retention.title": "Calendario de retención de datos",
    "legal.retention.intro": "Esta vista previa no tiene cuentas activas. Esta página indica qué guarda la vista previa y dónde. Antes de que se abran las cuentas activas, aquí se publicará un calendario de retención para ellas.",
    "legal.retention.live.title": "En este navegador",
    "legal.retention.live.body": "Las preferencias y el estado del recorrido se quedan en el almacenamiento de este navegador hasta que la función los elimina o borras los datos de este sitio. La página de telemetría enumera cada clave y cuánto dura.",
    "legal.retention.chapter.title": "Registros de la campaña",
    "legal.retention.chapter.body": "En esta vista previa no se guardan registros de campaña en ningún servidor. Cuánto tiempo se conservan y qué pasa con ellos cuando se elimina una cuenta se publicará con el calendario de retención de las cuentas activas.",
    "legal.retention.compass.title": "Fuentes de la Guía",
    "legal.retention.compass.body": "En esta vista previa ningún servidor guarda las fuentes de la Guía ni su historial de revisiones. Su retención se publicará con el calendario de retención de las cuentas activas.",
    "legal.retention.aiAggregate.title": "Totales de uso de IA",
    "legal.retention.aiAggregate.body": "No se registra ningún uso de IA, porque no hay ningún proveedor de IA configurado.",
    "legal.retention.ballot.title": "Votos anónimos",
    "legal.retention.ballot.body": "En esta vista previa no se guardan votos en ningún servidor. Cómo se conservan los totales anónimos de votación se publicará con el calendario de retención de las cuentas activas.",
    "legal.retention.backups.title": "Copias de seguridad",
    "legal.retention.backups.body": "No existe ninguna copia de seguridad, porque no hay ningún servidor activo.",
    "legal.retention.tasks.title": "Tareas eliminadas",
    "legal.retention.tasks.body": "En esta vista previa no se ejecuta ningún mantenimiento programado, porque no hay un servidor activo. Cuánto tiempo se conservan las tareas eliminadas para recuperarlas se publicará con el calendario de retención de las cuentas activas.",
    "legal.retention.interest.title": "Lista de novedades",
    "legal.retention.interest.body": "En esta vista previa ninguna lista de novedades guarda nombres ni correos electrónicos, porque no hay ningún servidor configurado.",
    "legal.retention.catalogClaims.title": "Solicitudes de verificación de organizaciones",
    "legal.retention.catalogClaims.body": "En esta vista previa no se puede guardar ninguna solicitud de verificación. Cuánto tiempo se conservan los datos de una solicitud se publicará con el calendario de retención de las cuentas activas.",
    "legal.retention.rsvp.title": "Confirmaciones para reuniones públicas",
    "legal.retention.rsvp.body": "En esta vista previa no se guarda ninguna confirmación. Cuánto tiempo se conservan el nombre y el correo electrónico de una confirmación se publicará con el calendario de retención de las cuentas activas.",
    "legal.retention.audit.title": "Registros de auditoría de cuentas",
    "legal.retention.audit.body": "No existe ningún registro de auditoría de cuentas, porque no hay cuentas activas. Cómo se conservan los registros de exportaciones y eliminaciones se publicará con el calendario de retención de las cuentas activas.",
    // Decisiones del propietario D-13, D-14 y D-15 del 10 de octubre de 2026.
    "legal.summary.instrument.title": "El instrumento detrás de este resumen",
    "legal.summary.instrument.link": "{name} — instrumento completo, versión {version}",
    "legal.instrument.title": "{name} — instrumento completo",
    "legal.instrument.intro": "Este es el instrumento detrás del resumen en lenguaje claro. Tiene su propia versión, y cada cambio aparece en el historial público de versiones.",
    "legal.instrument.version": "Versión {version}.",
    "legal.instrument.pendingEffective": "Fecha de entrada en vigor: ninguna todavía; esta versión no está en vigor.",
    "legal.instrument.notOperative": "Este instrumento no es operativo. Entra en vigor solo después de que la revisión profesional apruebe su texto y se registre la aceptación de esa versión.",
    "legal.instrument.text.title": "El texto de este instrumento",
    "legal.instrument.text.body": "El texto está en revisión profesional y todavía no se publica aquí. El resumen enlazado abajo describe lo que hace hoy la vista previa de Union Ground; esta página publica la versión y el historial de cambios con los que se publicará el texto.",
    "legal.instrument.acceptance.title": "Cómo se registra la aceptación",
    "legal.instrument.acceptance.body": "Cuando este instrumento entre en vigor, la aceptación se registra con su versión, la hora, la persona y la organización. Un cambio que el historial de versiones marque como sustancial vuelve a pedir esa aceptación en el siguiente inicio de sesión.",
    "legal.instrument.links.summary": "El resumen en lenguaje claro",
    "legal.instrument.links.changelog": "Historial de versiones de todos los instrumentos",
    "legal.changelog.note.compassTraining": "Añade retención opcional para entrenamiento, desactivada de forma predeterminada, con consentimientos separados del trabajador y la organización, caducidad a los 180 días, exportación y eliminación. Aviso sustancial; aceptar la política es independiente del consentimiento para entrenamiento.",
    "legal.changelog.note.memberProductAnalytics": "La analítica de producto de PostHog funciona ahora en el producto para trabajadores y en las aplicaciones móviles, bajo hashes unidireccionales de los identificadores de usuario y de organización, solo con etiquetas de vista y de acciones permitidas, y las páginas públicas de esta instalación registran vistas de página sin cookies. El interruptor de analítica de producto, Do Not Track y Global Privacy Control la desactivan. Aviso sustancial.",
    "legal.changelog.note.publicPageHeatmaps": "PostHog puede registrar mapas de calor sin cookies de los clics y movimientos del puntero en las páginas públicas de esta instalación, con las direcciones de las páginas públicas y las dimensiones de la ventana. Todo el texto y los campos de entrada permanecen enmascarados. Los mapas de calor excluyen el producto para trabajadores y las aplicaciones móviles y respetan el interruptor de analítica del producto, Do Not Track y Global Privacy Control. Aviso sustancial.",
    "legal.changelog.note.freePilotClarification": "Aclara el piloto existente, gratuito y por invitación para organizaciones, en los términos y su resumen. No se introduce una duración del piloto, una conversión de pago ni una tarifa nueva. No es sustancial: las aceptaciones existentes siguen siendo válidas.",
    "legal.changelog.note.analyticsClarification": "Aclara la analítica de PostHog exclusiva de la demostración y los recuentos propios existentes de páginas del espacio de trabajo con sesión iniciada, incluido el interruptor Analítica del producto. Corrección de la divulgación; la recopilación y los controles no cambian. No es sustancial: una aceptación existente de 1.0.0 sigue siendo válida y no requiere aceptar de nuevo.",
    "legal.changelog.note.navigationPins": "Enumera la clave solo del dispositivo que guarda los atajos del menú que fija un trabajador, junto a los recuentos de orden de navegación existentes. Ambos se quedan en el navegador, nunca se envían a Union Ground y se borran al cerrar sesión. No es sustancial: las aceptaciones existentes de 1.3.0 siguen siendo válidas sin aceptar de nuevo.",
    "legal.changelog.note.pkceStorage": "Enumera el almacenamiento de verificadores PKCE de un solo uso por flujo y su índice de flujos pendientes, incluida la limpieza y las posibles entradas sin registrar tras inicios simultáneos. Sirven al fin de autenticación existente; los destinatarios y los controles de la persona no cambian. No es sustancial: las aceptaciones existentes de 1.0.0 y 1.0.1 siguen siendo válidas sin aceptar de nuevo.",
    "legal.changelog.note.firstOperative": "Versión 1.0.0 del registro. En esta edición el texto del instrumento no se publica; entra en vigor solo después de que la revisión profesional lo apruebe y se registre la aceptación de esa versión.",
    "legal.changelog.title": "Historial de versiones de los instrumentos legales de Union Ground",
    "legal.changelog.intro": "Todas las versiones publicadas de cada instrumento, con la fecha de publicación y si el cambio fue sustancial. Todavía no hay ninguna versión en vigor. Cuando la haya, un cambio sustancial pide a todas las personas con cuenta aceptar la nueva versión.",
    "legal.changelog.entry": "Versión {version} · publicada el {date}",
    "legal.changelog.material": "Cambio sustancial: se vuelve a pedir la aceptación.",
    "legal.changelog.notMaterial": "No es un cambio sustancial.",
    "legal.changelog.note.registered": "Primera versión: se publican el instrumento, su versión y su historial de cambios; el texto sigue en la revisión profesional.",
    "legal.changelog.note.adultsOnly": "Las cuentas son para personas adultas de 18 años o más; aceptar los términos ahora incluye confirmar que tienes 18 años o más.",
    "legal.changelog.note.appStoreStates": "La regla de 18 años o más ahora se aplica a las personas de Texas, California, Alabama, Utah y Luisiana; en los demás lugares, una persona de 13 a 17 años solo puede usar Union Ground mediante una cuenta autorizada por su organización. Aceptar los términos ahora incluye indicar en qué estado vive.",
    "legal.changeNotice.label": "Aviso de cambio legal",
    "legal.changeNotice.title": "Los términos que aceptaste han cambiado",
    "legal.changeNotice.body": "Se publicó un cambio sustancial en: {instruments}. Se te pedirá aceptar la versión vigente en tu próximo inicio de sesión.",
    "legal.changeNotice.changelog": "Ver qué cambió",
    "legal.summaryNotice": "Esta página es un resumen en lenguaje claro de cómo funciona la vista previa de Union Ground. Las políticas formales todavía no se publican y se publicarán antes de que se abran las cuentas activas.",
    "legal.termsNotice": "Estos son los términos de uso de la vista previa de Union Ground. Los términos formales todavía no se publican y se publicarán antes de que se abran las cuentas activas.",
    "legal.lastReviewed": "Contenido revisado por última vez: {date}.",
    ...stewardHintCatalogueSpanish,
    ...messageVisibilityCatalogueSpanish,
    ...crossChapterPeersCatalogueSpanish,
    ...adminAttentionCatalogue.es,
    ...intakeQueueCatalogue.es,
    ...seniorityCatalogue.es,
    ...sourceLineCatalogue.es,
    ...topicUpdateCatalogue.es,
    ...rightsLibraryCatalogueSpanish,
    ...glossaryCatalogueSpanish,
    ...altShellCatalogueSpanish,
    ...altTakePartCatalogue.es,
    ...altRecordPagesCatalogue.es,
    ...altHelpPagesCatalogue.es,
    ...automationRestoreCatalogueSpanish,
    ...homeTakeoverCatalogueSpanish,
    ...welcomeBackCatalogueSpanish,
    ...seededLabelsCatalogueSpanish,
    ...bilingualContentCatalogue.es,
    ...fixtureNotificationsCatalogue.es,
    ...csvExportsCatalogue.es,
    ...navUsageCatalogueSpanish,
    ...whatMattersNowCatalogueSpanish,
    ...homeNudgesCatalogueSpanish,
    // REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP2-20261023: the guide
    // engine's lines join the barrel now that member surfaces render them.
    ...guideEngineCatalogueSpanish,
    ...onboardingAdminCatalogue.es,
    ...messageReactionsCatalogueSpanish,
    "landing.interestConsent": "Al enviar, aceptas que Union Ground se comunique contigo sobre tu selección. Puedes pedir que dejemos de hacerlo en cualquier momento con el formulario para dejar de recibir novedades de esta página.",
    "landing.aiDisclosure": "Divulgación del asistente de IA",

    ...qaCatalogueSpanish,
    ...connectionSuggestionsCatalogueSpanish,
    ...connectionProfilePublishCatalogueSpanish,
    ...partnerOfficesCatalogueSpanish,
    ...unionCatalogCatalogueSpanish,
    ...learningContentCatalogueSpanish,
    ...getAppCatalogue.es,
    ...openSignupCatalogueSpanish,
    ...requestInviteCatalogueSpanish,
    ...pricingCatalogueSpanish,
    ...organizationHtmlFormsCatalogue.es,
    ...formAutofillCatalogue.es,
    ...eventCheckInCatalogueSpanish,
    ...boundedListsCatalogueSpanish,
    ...issueIntelligenceCatalogueSpanish,
    ...caseSignalsCatalogueSpanish,
    ...remindHereRoutingCatalogueSpanish,
    ...channelControlsCatalogueSpanish,
    ...governanceCatalogueSpanish,
    ...navigationLinksCatalogueSpanish,
    ...compassAssistantCatalogueSpanish,
    ...fieldNotesPacketCatalogueSpanish,
    ...learningPeriodCatalogueSpanish,
  
    "legal.changelog.note.release.20261113125500.privacy-policy": "La sección de documentos compartidos ya no menciona el envío de una copia a la organización entre los usos de lo que se comparte en /contribute; la página de carga ya no lo ofrece. La acción cívica nombra ahora el geocodificador público de la Oficina del Censo de EE. UU., junto a Geocodio, como destinatario de la calle, la ciudad, el estado y el código postal del trabajador para la consulta de distritos del Congreso y de la legislatura estatal.",
  
    "legal.changelog.note.release.20261113125500.terms-of-use": "Las cláusulas de acceso automatizado ahora permiten que los buscadores y asistentes de IA lean las páginas públicas del sitio web para responder preguntas, resumirlas y citarlas. Entrenar o ajustar modelos de IA con el contenido de Union Ground, crear conjuntos de datos con él y recopilar de forma automatizada el servicio con sesión iniciada, la aplicación o cualquier página que robots.txt no permita siguen requiriendo permiso por escrito de Union Ground LLC.",
  
    "legal.changelog.note.release.20261113125500.ai-disclosure": "La divulgación sobre IA indica ahora claramente el límite del entrenamiento interno: aparte de las muestras conservadas con ambas autorizaciones explícitas, el entrenamiento interno de modelos usa solo datos del servicio desidentificados (estándar de la CPRA) y agregados, nunca datos que identifiquen a una persona, y nunca para terceros. Añade un límite y no inicia ningún tratamiento nuevo.",
  },
};
