// The web catalogue with every language registered synchronously, for code
// that runs outside the browser bundle: Node scripts, the role-play bots and
// the unit-test setup. The web app imports ../i18n.js and fetches Spanish on
// demand through loadLanguage() instead
// (PERF-UG-WEB-SHELL-AND-PER-LANGUAGE-BUNDLES-20261011); importing this
// module from src/ would pull the Spanish chunk back into the entry bundle.
import { registerLanguage } from "../i18n.js";
import { spanishCatalogue } from "./es.js";
// Every feature namespace a lazily loaded view registers on its own (see
// registerFeatureStrings in ../i18n.js).
import "./features/adminAttentionStrings.js";
import "./features/agendaItemsStrings.js";
import "./features/altHelpPagesStrings.js";
import "./features/altRecordPagesStrings.js";
import "./features/altTakePartStrings.js";
import "./features/bilingualContentStrings.js";
import "./features/automationAvailabilityStrings.js";
import "./features/caseIntakeStrings.js";
import "./features/caseNotesStrings.js";
import "./features/chapterBudgetStrings.js";
import "./features/connectionProfilePublishStrings.js";
import "./features/workloadConfigurationEditorStrings.js";
import "./features/formAutofillStrings.js";
import "./features/intakeQueueStrings.js";
import "./features/fixtureNotificationsStrings.js";
import "./features/csvExportsStrings.js";
import "./features/getAppStrings.js";
import "./features/learningContentStrings.js";
import "./features/onboardingAdminStrings.js";
import "./features/organizationHtmlFormsStrings.js";
import "./features/rightsQuestionsStrings.js";
import "./features/seniorityStrings.js";
import "./features/sourceLineStrings.js";
import "./features/subprocessorsStrings.js";
import "./features/telemetryStrings.js";
import "./features/topicUpdateStrings.js";

registerLanguage("es", spanishCatalogue.es);

export * from "../i18n.js";
