import { SHELL_LOAD_DEADLINE_MS, withLoadDeadline } from "./loadDeadline.js";
import { chapterFinanceCatalogue } from "./i18n/chapterFinance.js";
import { chapterAccessCatalogue } from "./i18n/chapterAccess.js";
import { workplaceRosterCatalogue } from "./i18n/workplaceRoster.js";
import { workloadConfigurationCatalogue } from "./i18n/workloadConfiguration.js";
import { connectedWorkflowsCatalogue } from "./i18n/connectedWorkflows.js";
// Lightweight in-app i18n: a plain string catalogue plus a t() lookup with
// {var} interpolation. No library — the member surface is English + Spanish
// only. t(lang, key, vars) falls back es -> en -> the key itself, and strips
// any unresolved {var} so a missing interpolation never leaks braces to the UI.
// Spanish reuses the canon glossary from the design's bilingual email set
// (delegado/delegada, Paso 1, comprobante, boleta, Ajustes, etc.).
// KEY NAMES: a key names the surface and the role, never the sentence it
// holds (automation.discover.heroTitle, not a dotted English sentence).
// Disambiguate with a role suffix, never an ordinal (.2).
//
// GLOSSARY, LOCKED: a union chapter is a "capítulo", NEVER a "sección".
// The Bilingual design pass is the authority
// (the retired design package's Bilingual pass, glossary row: chapter →
// capítulo, «Not "sección" — this package used it three times and has been
// corrected»). An earlier sweep (2026-07-28) read the pass backwards and
// "corrected" ~20 tasks/settings strings TO "sección"; the 2026-07-31 sweep
// reverted them, so the whole catalogue now says "capítulo" and there is no
// open follow-up. If a string ever needs the other word, it is talking about
// a section of a document, not an organisational unit.
//
// PER-AREA MODULES (OPS-UG-I18N-PER-AREA-LOCALE-MODULES-20261109): the
// English strings live in ./i18n/locales/en/<area>.js, one module per screen
// or area, and the literal below spreads them together; the Spanish ones are
// ./i18n/locales/es/<area>.js, assembled by ./i18n/es.js, which is loaded on
// demand (see loadLanguage()). Add or edit a key in its area module, never in
// this file: every first key segment lives in exactly one area module, the
// same one in both languages (src/lib/i18n/locales/README.md). Only the legal
// release keys stay inline here and in es.js, because the legal release
// tooling hashes their lines in these two files. A spread hides a key defined
// twice (last wins), which `no-dupe-keys` cannot see across modules, so
// tests/i18n.test.js scans every source below for a repeat instead.
//
// The namespace chunks are declared in their own modules so a React Native
// screen can reach one namespace instead of the whole table
// (PERF-UG-MOBILE-QA-BUNDLES-FULL-WEB-CATALOGUE-20260917). Lookup is by
// key, so the order the tables are spread in changes nothing. A key declared
// in a chunk must NOT be repeated in an area module or below, which
// tests/i18n.test.js asserts.
// The catalogue-free date/time half lives in ./i18n/format.js for the same
// reason as the namespace chunks: a native screen must be able to import a
// localised date without the catalogue. The LONG-ZONE-NAME decision stays HERE,
// below, because it reads a key out of the catalogue — so format.js never
// imports this file and there is no import cycle.
import { DATE_TIME_STAMP_OPTIONS, TWELVE_HOUR_CLOCK, dateTimeFormatCore } from "./i18n/format.js";
import { welcomeBackCatalogue } from "./i18n/welcomeBack.js";
import { seededLabelsCatalogue } from "./i18n/seededLabels.js";
import { connectionSuggestionsCatalogue } from "./i18n/connectionSuggestions.js";
import { partnerOfficesCatalogue } from "./i18n/partnerOffices.js";
import { lookup } from "./i18n/runtime.js";
import { navUsageCatalogue } from "./i18n/navUsage.js";
import { messageReactionsCatalogue } from "./i18n/messageReactions.js";
import { stewardHintCatalogue } from "./i18n/stewardHint.js";
import { messageVisibilityCatalogue } from "./i18n/messageVisibility.js";
import { crossChapterPeersCatalogue } from "./i18n/crossChapterPeers.js";
import { rightsLibraryCatalogue } from "./i18n/rightsLibrary.js";
import { glossaryCatalogue } from "./i18n/glossary.js";
import { altShellCatalogue } from "./i18n/altShell.js";
import { caseworkUlpCatalogue } from "./i18n/caseworkUlp.js";
import { caseworkDeadlinesCatalogue } from "./i18n/caseworkDeadlines.js";
import { stewardMatchCatalogue } from "./i18n/stewardMatch.js";
import { caseworkStrengthCatalogue } from "./i18n/caseworkStrength.js";
import { automationRestoreCatalogue } from "./i18n/automationRestore.js";
import { qaCatalogue } from "./i18n/qa.js";
import { homeTakeoverCatalogue } from "./i18n/homeTakeover.js";
import { unionCatalogCatalogue } from "./i18n/unionCatalog.js";
import { whatMattersNowCatalogue } from "./i18n/whatMattersNow.js";
import { homeNudgesCatalogue } from "./i18n/homeNudges.js";
import { guideEngineCatalogue } from "./i18n/guideEngine.js";
import { openSignupCatalogue } from "./i18n/openSignup.js";
import { requestInviteCatalogue } from "./i18n/requestInvite.js";
import { pricingCatalogue } from "./i18n/pricing.js";
import { eventCheckInCatalogue } from "./i18n/eventCheckIn.js";
import { boundedListsCatalogue } from "./i18n/boundedLists.js";
import { issueIntelligenceCatalogue } from "./i18n/issueIntelligence.js";
import { caseSignalsCatalogue } from "./i18n/caseSignals.js";
import { remindHereRoutingCatalogue } from "./i18n/remindHereRouting.js";
import { channelControlsCatalogue } from "./i18n/channelControls.js";
import { governanceCatalogue } from "./i18n/governance.js";
import { navigationLinksCatalogue } from "./i18n/navigationLinks.js";
import { compassAssistantCatalogue } from "./i18n/compassAssistant.js";
import { fieldNotesPacketCatalogue } from "./i18n/fieldNotesPacket.js";
import { learningPeriodCatalogue } from "./i18n/learningPeriod.js";

import { eventModelCatalogue } from "./i18n/eventModel.js";
import { eventTypeCatalogue } from "./i18n/eventTypes.js";
import { bargainingWriterCatalogue } from "./i18n/bargainingWriter.js";
import { operatorCatalogue } from "./i18n/operator.js";
import { shellStrings } from "./i18n/locales/en/shell.js";
import { homeStrings } from "./i18n/locales/en/home.js";
import { authStrings } from "./i18n/locales/en/auth.js";
import { publicStrings } from "./i18n/locales/en/public.js";
import { settingsStrings } from "./i18n/locales/en/settings.js";
import { adminStrings } from "./i18n/locales/en/admin.js";
import { organizationAdminStrings } from "./i18n/locales/en/organizationAdmin.js";
import { automationStrings } from "./i18n/locales/en/automation.js";
import { coordinationStrings } from "./i18n/locales/en/coordination.js";
import { analyticsStrings } from "./i18n/locales/en/analytics.js";
import { caseworkStrings } from "./i18n/locales/en/casework.js";
import { stewardStrings } from "./i18n/locales/en/steward.js";
import { knowledgeStrings } from "./i18n/locales/en/knowledge.js";
import { tasksStrings } from "./i18n/locales/en/tasks.js";
import { workloadStrings } from "./i18n/locales/en/workload.js";
import { appointmentsStrings } from "./i18n/locales/en/appointments.js";
import { engagementStrings } from "./i18n/locales/en/engagement.js";
import { votingStrings } from "./i18n/locales/en/voting.js";
import { eventsStrings } from "./i18n/locales/en/events.js";
import { messagingStrings } from "./i18n/locales/en/messaging.js";
import { voiceStrings } from "./i18n/locales/en/voice.js";
import { organizeStrings } from "./i18n/locales/en/organize.js";
import { duesStrings } from "./i18n/locales/en/dues.js";
import { formsStrings } from "./i18n/locales/en/forms.js";

export const catalogue = {
  en: {
    // Per-area modules (src/lib/i18n/locales/en/), one per screen or
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
    ...chapterAccessCatalogue.en,
    ...chapterFinanceCatalogue.en,
    ...eventModelCatalogue.en,
    ...eventTypeCatalogue.en,
    ...bargainingWriterCatalogue.en,
    ...operatorCatalogue.en,
    ...connectedWorkflowsCatalogue.en,
    ...workplaceRosterCatalogue.en,
    ...workloadConfigurationCatalogue.en,
    ...caseworkUlpCatalogue.en,
    ...caseworkDeadlinesCatalogue.en,
    ...stewardMatchCatalogue.en,
    ...caseworkStrengthCatalogue.en,
    "legal.publicInformation": "Public information",
    "legal.navigation": "Legal information",
    "legal.contents": "On this page",
    "legal.contact.title": "Contact Union Ground",
    "legal.contact.none": "No address is published yet. For account help, use the contact who provisioned your account.",
    "legal.contact.ownerBody": "For privacy, safety, or general questions:",
    "legal.contact.supportBody": "For access, terms, or accessibility help:",
    "legal.privacy.platformUpdates.title": "Optional product updates",
    "legal.privacy.platformUpdates.body": "Your organization's administrator can choose to receive Union Ground product updates and stop following at any time. Workers can hide or restore these updates for themselves. Union Ground controls the product-update content it publishes and the organization-level follow status needed to operate this optional feed. It does not collect worker lists, recipients, reads, reactions or engagement through this feed. Following grants no additional access to worker data and does not change our separate processor duties for tenant workspace content.",
    "legal.changelog.note.platformAnnouncements": "Optional organization-consented product announcements: publisher purpose, organization-only follow status, administrator revoke and personal opt-out. Material privacy revision 1.3.0; previous acceptances are asked again.",
    "legal.changelog.note.nativePulseCharts": "Discloses the optional native Pulse chart PNG cache, its size limit and removal after sharing or an interrupted export. Specs and pins stay with the account on the server; personal and withheld figures cannot be exported. No product analytics is added. Not material: existing 1.3.0 acceptances remain valid without accepting again.",
    "legal.changelog.note.officerRosterExport": "States that administrators and campaign Presidents and Secretary-Treasurers may export the worker list they can already see, without email addresses or contact details a worker did not share, and that every export is logged. The access follows the existing campaign and role limits. Not material: existing 1.3.0 acceptances remain valid without accepting again.",
    "legal.privacy.title": "Privacy",
    "legal.privacy.intro": "Union Ground is built for workers organizing a union, so it treats coworker names, card counts, and issue notes as private by default. This page describes the preview as built.",
    "legal.privacy.hold.title": "What this preview holds",
    "legal.privacy.hold.body": "The preview tour runs on fictional people and records. No Union Ground backend is provisioned, so there are no live accounts, and nothing you enter in the tour is sent to a Union Ground server. Preferences such as your language stay in this browser; the telemetry page lists each stored key.",
    "legal.privacy.use.title": "How it is used",
    "legal.privacy.use.body": "In this preview, information is used only to show the tour in your browser. How a live account's information is used will be stated in the formal privacy policy, published before live accounts open.",
    "legal.privacy.control.title": "Your control",
    "legal.privacy.control.body": "You can remove what this preview stores by clearing this site's data in your browser. How to request access, correction, export, or deletion for a live account will be published before live accounts open.",
    "legal.privacy.sharing.title": "Sharing",
    "legal.privacy.sharing.body": "Worker information is not sold. Union Ground is designed to keep worker lists, card counts, and issue notes off public pages. This preview holds no live data to share; who may see a live campaign's information will be stated in the formal privacy policy.",
    "legal.privacy.catalogClaims.title": "Organization verification requests",
    "legal.privacy.catalogClaims.body": "The code includes a way for an organization to ask that its public listing be verified. With no live backend, no request can be submitted or stored in this preview. How these requests are handled will be published with the formal privacy policy.",
    // Every clause of legal.privacy.mobile.body is checked against apps/mobile
    // source rather than against the store forms: expo-notifications registers
    // the device token through register_my_native_push_installation and removes
    // it on disable and on sign-out; expo-image-picker is configured with
    // photosPermission false and the app only calls launchCameraAsync;
    // expo-document-picker is user-initiated; expo-audio records only inside
    // the shortcuts panel and the note stays in SecureStore plus protected app
    // storage; the biometric preference is a SecureStore flag read through
    // expo-local-authentication; and apps/mobile/package.json carries no
    // analytics, advertising or crash-reporting SDK.
    "legal.privacy.inviteRequests.title": "Invite requests",
    "legal.privacy.inviteRequests.body": "Union Ground accounts will be by invitation. No email service or backend is configured, so the invite-request form cannot deliver or store a request in this preview. What a request collects and who receives it will be published before live accounts open.",
    "legal.privacy.joinRequests.title": "Requests to join",
    "legal.privacy.joinRequests.body": "If you ask to join Union Ground for your organization at /join, Union Ground stores the organization name, your role, your email address, the organization's size band and state if you give them, the optional phone number and note, and a short campaign code from the link you followed, so the team can reply and follow up. One email announcing the request goes through Union Ground's email provider to the Union Ground sales mailbox; nothing is sent to the address you entered. The request stays on file, including after the team marks it contacted or closed, until you ask for it to be removed or a confirmed stop request removes it. To have a request deleted, email the contact address below.",
    "legal.privacy.documentContributions.title": "Shared documents",
    "legal.privacy.documentContributions.body": "If you share your organization's documents at /contribute, Union Ground stores the organization name and optional affiliation, its state, your name, role and email address, how you want to be told the digitized forms are ready and the mobile number or mailing address you give for that, the outreach code in the link you followed if it had one, your optional note, both confirmations you check, and the files you upload, so the team can digitize the documents, make the digitized forms available to your organization's workers and reply to you. Only blank forms and documents with no worker information belong there. Every file is kept in private storage that no visitor or account can open, and is checked for malware by Union Ground's file scanner before it is accepted; a file that fails the check is not used. The mobile number or mailing address is used only to tell you the forms are ready. Nothing is sent to the address you entered when you submit. The submission stays on file until you ask for it to be removed. To have it deleted, email the contact address below.",
    "legal.privacy.mobile.title": "The Union Ground mobile app",
    "legal.privacy.mobile.body": "The preview app keeps your changes, preferences, and Guide history in protected storage on the device; they do not sync to another phone. It has no advertising, tracking, purchases, or public posting, and it does not register for remote push notifications. Calendar, camera, microphone, and local reminders act only after you ask for them, and the system confirms each permission.",
    "legal.privacy.ai.title": "The Guide and AI",
    "legal.privacy.ai.body": "No AI provider is configured for Union Ground, so no question you ask the Guide is sent to one. Which provider would process a question, what would be sent, and what would be kept will be published on the Guide disclosure page before live AI is enabled.",
    "legal.privacy.civic.title": "Civic action: your address and letters to officials",
    "legal.privacy.civic.body": "Civic action is optional. To find your elected officials you may give your home mailing address, and it is stored only with your explicit consent (consent version {version}). The address is sent only for district lookup: to Geocodio, to resolve your districts and the town, county, and school district you live in, and to the U.S. Census Bureau's public geocoder, to find your congressional and state legislative districts. The Census Bureau receives only the street, city, state, and ZIP code, never your name, email, member ID, or chapter. The address is otherwise never shown to chapter officers or staff, who see counts only. To check the accuracy of those results, a sample of addresses may also be sent to Google's civic information service. When you ask for help drafting a letter, the draft is written by the same governed AI provider as Compass under a zero-data-retention policy and never receives your identity: not your name, street address, email, phone, or account. Your address, places, letters, and the reports you file about local officials are included in your data export and are deleted with your account.",
    "legal.privacy.effective": "Effective date: {date}.",
    "legal.privacy.links.title": "Related pages",
    "legal.privacy.links.retention": "Data retention schedule",
    "legal.privacy.links.deletion": "Request account deletion",
    "legal.deletionRequest.title": "Request account deletion",
    "legal.deletionRequest.intro": "Union Ground has no live accounts yet, so there is no account to delete. How to ask for an account and its data to be deleted will be published here before live accounts open.",
    "legal.deletionRequest.inApp.title": "If you can sign in",
    "legal.deletionRequest.inApp.body": "Signing in to delete an account is not available in this preview, because there are no live accounts. The steps and their safeguards will be published here before live accounts open.",
    "legal.deletionRequest.email.title": "If you cannot sign in",
    "legal.deletionRequest.email.body": "No privacy address is published yet. For account help, use the contact who provisioned your account. Do not send a password, a Social Security number, or other sensitive details.",
    "legal.deletionRequest.verify.title": "Identity verification",
    "legal.deletionRequest.verify.body": "A deletion request should be confirmed to come from the account holder before anything is deleted, because an unverified deletion is itself a way to attack an account. The verification steps will be published with the formal privacy policy.",
    "legal.deletionRequest.timing.title": "What to expect and when",
    "legal.deletionRequest.timing.body": "Response times for deletion requests are not set yet. They will be published here before live accounts open.",
    "legal.deletionRequest.record.title": "How each outcome is recorded",
    "legal.deletionRequest.record.body": "How each deletion request and its outcome will be recorded will be published here before live accounts open.",
    "legal.deletionRequest.scope.title": "What deletion removes",
    "legal.deletionRequest.scope.body": "The data retention schedule states what this preview keeps. What deleting a live account removes will be added to it before live accounts open.",
    "legal.deletionRequest.links.title": "Related pages",
    "legal.deletionRequest.links.privacy": "Privacy summary",
    "legal.deletionRequest.links.retention": "Data retention schedule",
    "legal.terms.title": "Terms of use",
    "legal.terms.intro": "Use Union Ground to plan organizing work with coworkers. Keep worker lists private and respect the people you are organizing with.",
    "legal.terms.eligibility.title": "Who may use Union Ground",
    "legal.terms.eligibility.body": "This preview is for evaluation, and there are no live accounts. Who may hold an account will be set in the formal terms. The acceptance step in this build asks you to confirm that you are 18 or older.",
    "legal.terms.fees.title": "Free organization pilot",
    "legal.terms.fees.body": "Union Ground is free for pilot organizations, by invitation. A worker using an account their organization provides pays Union Ground nothing.",
    "legal.terms.responsibility.title": "Your responsibility",
    "legal.terms.responsibility.body": "Use only accounts you are authorized to use, keep coworker information accurate and private, and avoid harassment, impersonation, or unlawful content.",
    "legal.terms.records.title": "Preview use",
    "legal.terms.records.body": "This build is a fictional preview for evaluation. It is not a place to store real coworker information. A card majority shown in the preview is not certification or recognition.",
    "legal.terms.availability.title": "Availability",
    "legal.terms.availability.body": "This preview may change or pause at any time. It is not a service with live accounts.",
    "legal.terms.support.title": "Support",
    "legal.terms.support.body": "Report access, safety, or accuracy concerns to the contact who provisioned your account. No support address is published yet.",
    "legal.terms.automated.title": "Automated access and AI use",
    "legal.terms.automated.body": "Do not use automated tools to collect, scrape, or crawl Union Ground or its content, or use that content for AI training, AI retrieval, or datasets, without written permission. Search engines may still index public pages. How to ask for permission will be published with the formal terms.",
    "legal.terms.aiProviders.title": "Named AI providers and agents",
    "legal.terms.aiProviders.body": "The automated-access rule above applies to every AI provider and agent, including OpenAI (ChatGPT, GPTBot, Operator), Anthropic (Claude, ClaudeBot), Google (Gemini, Google-Extended), Microsoft (Copilot, Bing AI), Meta AI, Amazon (Alexa, Amazonbot), Apple Intelligence (Applebot-Extended), Perplexity, xAI (Grok), Mistral, Cohere, ByteDance (Bytespider), DeepSeek, Common Crawl (CCBot), and any AI agent, agentic browser, or coding agent acting for a person or a company, whether or not it identifies itself: each may read the public pages to answer questions, and none may use Union Ground content for training or datasets without written permission.",
    "legal.accessibility.title": "Accessibility",
    "legal.accessibility.intro": "Union Ground is designed for keyboard, screen-reader, zoom, reduced-motion, and mobile use.",
    "legal.accessibility.standards.title": "Standards",
    "legal.accessibility.standards.body": "The product targets WCAG 2.2 AA for worker and committee workflows, in English and Spanish.",
    "legal.accessibility.supported.title": "Supported use",
    "legal.accessibility.supported.body": "Core actions have text labels, visible focus, semantic controls, and do not rely on color alone.",
    "legal.accessibility.report.title": "Report a barrier",
    "legal.accessibility.report.body": "Tell the contact who provisioned your account, and include the screen, device, browser, and what blocked you.",
    "legal.accessibility.alternative.title": "Alternative access",
    "legal.accessibility.alternative.body": "While a barrier is being fixed, ask your committee to share the same information in another accessible format.",
    "legal.accessibility.links.title": "Related pages",
    "legal.accessibility.links.statement": "Accessibility statement",
    "legal.accessibilityStatement.links.summary": "Accessibility summary",
    "legal.accessibilityStatement.title": "Accessibility statement",
    "legal.accessibilityStatement.notice": "This is the Union Ground preview accessibility statement. Formal policies are not published yet and will be before live accounts open.",
    "legal.accessibilityStatement.intro": "Union Ground targets WCAG 2.2 level AA. A formal conformance statement will be published after the product is evaluated.",
    "legal.accessibilityStatement.status.title": "Conformance status",
    "legal.accessibilityStatement.status.body": "Not yet evaluated. No conformance claim is made for this preview.",
    "legal.accessibilityStatement.scope.title": "What this statement covers",
    "legal.accessibilityStatement.scope.body": "The Union Ground web app, its public pages, and the Union Ground mobile app.",
    "legal.accessibilityStatement.evaluation.title": "How it will be evaluated",
    "legal.accessibilityStatement.evaluation.body": "Before live accounts open. The mobile app will be evaluated with VoiceOver on iPhone and TalkBack on Android, on physical devices.",
    "legal.accessibilityStatement.exceptions.title": "Known exceptions",
    "legal.accessibilityStatement.exceptions.body": "None recorded yet, because no evaluation has been run. Known exceptions will be listed here after the evaluation.",
    "legal.accessibilityStatement.unexercised.title": "Not yet evaluated",
    "legal.accessibilityStatement.unexercised.body": "The whole product. No evaluation and no third-party audit has been performed.",
    "legal.accessibilityStatement.feedback.title": "Report a barrier",
    "legal.accessibilityStatement.feedback.body": "Tell the contact who provisioned your account, and include the screen, device, browser, and what blocked you. No accessibility or support address is published yet.",
    "legal.accessibilityStatement.alternative.title": "Alternative access",
    "legal.accessibilityStatement.alternative.body": "While a barrier is being fixed, ask your committee to share the same information in another accessible format.",
    "legal.aiDisclosure.title": "How the Guide uses AI",
    "legal.aiDisclosure.intro": "The Guide answers organizing questions. No AI provider is configured for Union Ground in this preview, so no question is sent to one.",
    "legal.aiDisclosure.route.title": "AI provider",
    "legal.aiDisclosure.route.body": "None is configured. Which provider would process a question will be published here before live AI is enabled, and the subprocessor register will name it with a dated notice first.",
    "legal.aiDisclosure.sent.title": "What is sent",
    "legal.aiDisclosure.sent.body": "Nothing is sent to an AI provider in this preview. What a live request would include will be published here before live AI is enabled. Optional training retention is separate from saved Guide history and is off by default for every member and organization. Only after both the member and an organization administrator record the current notice and opt in may Union Ground retain eligible new question-and-answer pairs for later model training. Text must pass the minimizer unchanged: withheld, shortened or otherwise minimized text, case facts, staff data, messages, separate source excerpts and rejected requests are excluded. Up to 100 samples per member remain in this deployment's Supabase project for at most 180 days, then expire and are removed by daily maintenance. Declining does not restrict the Guide. Export samples with your account data, or request withdrawal through Data rights. Withdrawal deletes affected samples; account deletion and organization archive also remove them. Samples cannot leave the project for a training provider without a separate owner decision. Accepting these policies does not opt you into training.",
    "legal.aiDisclosure.controls.title": "Safeguards",
    "legal.aiDisclosure.controls.body": "The safeguards that will apply to a live request will be described here before live AI is enabled.",
    "legal.aiDisclosure.connector.title": "Backup provider",
    "legal.aiDisclosure.connector.body": "No backup AI provider is configured either.",
    "legal.aiDisclosure.chapter.title": "Not legal advice",
    "legal.aiDisclosure.chapter.body": "The Guide explains organizing steps in plain language. It does not give legal conclusions. Get qualified help for decisions about your organizing rights or a campaign.",
    "legal.aiDisclosure.sensitive.title": "Protect sensitive information",
    "legal.aiDisclosure.sensitive.body": "Do not enter passwords, Social Security numbers, medical details, or coworker lists. The Guide is not an emergency service.",
    "legal.retention.title": "Data retention schedule",
    "legal.retention.intro": "This preview has no live accounts. This page states what the preview keeps and where. A retention schedule for live accounts will be published here before live accounts open.",
    "legal.retention.live.title": "In this browser",
    "legal.retention.live.body": "Preferences and tour state stay in this browser's storage until the feature removes them or you clear this site's data. The telemetry page lists each key and how long it lasts.",
    "legal.retention.chapter.title": "Campaign records",
    "legal.retention.chapter.body": "No campaign records are stored on a server in this preview. How long they are kept, and what happens to them when an account is deleted, will be published with the retention schedule for live accounts.",
    "legal.retention.compass.title": "Guide sources",
    "legal.retention.compass.body": "No server stores Guide sources or their revision history in this preview. Their retention will be published with the retention schedule for live accounts.",
    "legal.retention.aiAggregate.title": "AI usage totals",
    "legal.retention.aiAggregate.body": "No AI usage is recorded, because no AI provider is configured.",
    "legal.retention.ballot.title": "Anonymous votes",
    "legal.retention.ballot.body": "No votes are stored on a server in this preview. How anonymous vote totals are kept will be published with the retention schedule for live accounts.",
    "legal.retention.backups.title": "Backups",
    "legal.retention.backups.body": "No backups exist, because no live backend is provisioned.",
    "legal.retention.tasks.title": "Deleted tasks",
    "legal.retention.tasks.body": "No scheduled maintenance runs in this preview, because there is no live backend. How long deleted tasks are held for recovery will be published with the retention schedule for live accounts.",
    "legal.retention.interest.title": "Updates list",
    "legal.retention.interest.body": "No updates list stores names or email addresses in this preview, because no backend is configured.",
    "legal.retention.catalogClaims.title": "Organization verification requests",
    "legal.retention.catalogClaims.body": "No verification request can be stored in this preview. How long a request's details are kept will be published with the retention schedule for live accounts.",
    "legal.retention.rsvp.title": "Public meeting RSVPs",
    "legal.retention.rsvp.body": "No RSVP is stored in this preview. How long a name and email address from an RSVP are kept will be published with the retention schedule for live accounts.",
    "legal.retention.audit.title": "Account audit records",
    "legal.retention.audit.body": "No account audit records exist, because there are no live accounts. How records of exports and deletions are kept will be published with the retention schedule for live accounts.",
    // Each summary
    // links its operative instrument, every instrument carries a version and
    // an effective date with a public change history, and the English and
    // Spanish texts are co-equal — tests/legal-page-claims.test.js fails CI
    // when one locale carries an instrument key or a version the other does
    // not. Versions and dates come from src/lib/legalInstruments.js, never
    // from the copy.
    "legal.summary.instrument.title": "The instrument behind this summary",
    "legal.summary.instrument.link": "{name} — full instrument, version {version}",
    "legal.instrument.title": "{name} — full instrument",
    "legal.instrument.intro": "This is the instrument behind the plain-language summary. It carries its own version, and every change to it is listed in the public version history.",
    "legal.instrument.version": "Version {version}.",
    "legal.instrument.pendingEffective": "Effective date: none yet; this version is not in effect.",
    "legal.instrument.notOperative": "This instrument is not operative. It takes effect only after professional review clears its text and acceptance of that version is recorded.",
    "legal.instrument.text.title": "The text of this instrument",
    "legal.instrument.text.body": "The text is with professional review and is not published here yet. The summary linked below describes what the Union Ground preview does today; this page publishes the version and the change history the text will be released under.",
    "legal.instrument.acceptance.title": "How agreement is recorded",
    "legal.instrument.acceptance.body": "When this instrument takes effect, accepting it is recorded with its version, the time, the person and the organization. A change the version history marks material asks for that agreement again at the next sign-in.",
    "legal.instrument.links.summary": "The plain-language summary",
    "legal.instrument.links.changelog": "Version history of every instrument",
    "legal.changelog.note.compassTraining": "Adds optional, default-off training retention with separate worker and organization consent, 180-day expiry, export and deletion. Material notice; policy acceptance is separate from training consent.",
    "legal.changelog.note.memberProductAnalytics": "PostHog product analytics now runs on the worker product and in the mobile apps, under one-way hashes of the user and organization identifiers with view and allowlisted action labels only, and the public pages of this deployment report cookieless page views. The Product analytics switch, Do Not Track and Global Privacy Control turn it off. Material notice.",
    "legal.changelog.note.publicPageHeatmaps": "PostHog may record cookieless heatmaps of pointer clicks and movement on the public pages of this deployment, with public page addresses and window dimensions. All text and inputs stay masked. Heatmaps exclude the worker product and mobile apps and respect the Product analytics switch, Do Not Track and Global Privacy Control. Material notice.",
    "legal.changelog.note.freePilotClarification": "Clarifies the existing free, invitation-only organization pilot in the terms and their summary. No pilot duration, paid conversion or new fee is introduced. Not material: existing acceptances remain valid.",
    "legal.changelog.note.analyticsClarification": "Clarifies demo-only PostHog analytics and existing first-party signed-in workspace page-view counts, including the Product analytics switch. Disclosure-only correction; collection and controls are unchanged. Not material: an existing 1.0.0 acceptance remains valid and does not require acceptance again.",
    "legal.changelog.note.navigationPins": "Lists the device-only key that keeps the menu shortcuts a worker pins, beside the existing navigation ranking counts. Both stay in the browser, are never sent to Union Ground, and are removed at sign-out. Not material: existing 1.3.0 acceptances remain valid without accepting again.",
    "legal.changelog.note.pkceStorage": "Lists per-flow one-time PKCE verifier storage and its pending-flow index, including cleanup and possible unindexed slots after concurrent starts. These support the existing authentication purpose; recipients and user controls are unchanged. Not material: existing 1.0.0 and 1.0.1 acceptances remain valid without accepting again.",
    "legal.changelog.note.firstOperative": "Version 1.0.0 of the register. In this edition the instrument text is not published; it takes effect only after professional review clears it and acceptance of that version is recorded.",
    "legal.changelog.title": "Version history of the Union Ground legal instruments",
    "legal.changelog.intro": "Every published version of every instrument, with the date it was published and whether the change was material. No version is in effect yet. Once one is, a material change asks everyone with an account to accept the new version.",
    "legal.changelog.entry": "Version {version} · published {date}",
    "legal.changelog.material": "Material change: acceptance is asked for again.",
    "legal.changelog.notMaterial": "Not a material change.",
    "legal.changelog.note.registered": "First version: the instrument, its version and its change history are published; the text stays with the professional review.",
    "legal.changelog.note.adultsOnly": "Accounts are for adults 18 and over; accepting the terms now includes confirming that you are 18 or older.",
    "legal.changelog.note.appStoreStates": "The 18-and-over rule now applies to people in Texas, California, Alabama, Utah and Louisiana; elsewhere a person 13 to 17 may use Union Ground only through an account their organization authorized. Accepting the terms now includes saying which state you live in.",
    "legal.changeNotice.label": "Legal change notice",
    "legal.changeNotice.title": "The terms you agreed to have changed",
    "legal.changeNotice.body": "A material change was published to: {instruments}. You will be asked to accept the current version the next time you sign in.",
    "legal.changeNotice.changelog": "See what changed",
    "legal.summaryNotice": "This page is a plain-language summary of how the Union Ground preview works. Formal policies are not published yet and will be before live accounts open.",
    "legal.termsNotice": "These are the preview terms of use for Union Ground. Formal terms are not published yet and will be before live accounts open.",
    "legal.lastReviewed": "Content last reviewed: {date}.",
    ...stewardHintCatalogue.en,
    ...messageVisibilityCatalogue.en,
    ...crossChapterPeersCatalogue.en,
    ...rightsLibraryCatalogue.en,
    ...glossaryCatalogue.en,
    ...altShellCatalogue.en,
    ...automationRestoreCatalogue.en,
    ...homeTakeoverCatalogue.en,
    ...welcomeBackCatalogue.en,
    ...seededLabelsCatalogue.en,
    ...navUsageCatalogue.en,
    ...whatMattersNowCatalogue.en,
    ...homeNudgesCatalogue.en,
    // REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP2-20261023: the guide
    // engine's lines join the barrel now that member surfaces render them.
    ...guideEngineCatalogue.en,
    ...messageReactionsCatalogue.en,
    "landing.interestConsent": "By submitting, you agree that Union Ground may contact you about your selection. You can ask to stop at any time with the stop form on this page.",
    "landing.aiDisclosure": "AI assistant disclosure",

    ...qaCatalogue.en,
    ...connectionSuggestionsCatalogue.en,
    ...partnerOfficesCatalogue.en,
    ...unionCatalogCatalogue.en,
    ...openSignupCatalogue.en,
    ...requestInviteCatalogue.en,
    ...pricingCatalogue.en,
    ...eventCheckInCatalogue.en,
    ...boundedListsCatalogue.en,
    ...issueIntelligenceCatalogue.en,
    ...caseSignalsCatalogue.en,
    ...remindHereRoutingCatalogue.en,
    ...channelControlsCatalogue.en,
    ...governanceCatalogue.en,
    ...navigationLinksCatalogue.en,
    ...compassAssistantCatalogue.en,
    ...fieldNotesPacketCatalogue.en,
    ...learningPeriodCatalogue.en,
  
    "legal.changelog.note.release.20261113125500.privacy-policy": "The shared documents section no longer lists sending the organization a copy as a use of what is shared at /contribute; the upload page no longer offers one. Civic action now names the U.S. Census Bureau's public geocoder, next to Geocodio, as a recipient of the worker's street, city, state and ZIP code for congressional and state legislative district lookup.",
  
    "legal.changelog.note.release.20261113125500.terms-of-use": "The automated-access clauses now let AI search engines and assistants read the public pages of the website to answer questions, summarize them and cite them. Training or fine-tuning AI models on Union Ground content, building datasets from it, and automated collection of the signed-in service, the app or any page robots.txt disallows still need written permission from Union Ground LLC.",
  
    "legal.changelog.note.release.20261113125500.ai-disclosure": "The AI disclosure now states the internal training limit plainly: apart from samples kept with both explicit opt-ins, internal model training uses only de-identified (CPRA standard) and aggregated service data, never individually identifiable data, and never for a third party. It adds a limit and starts no new processing.",
  },
};

// PERF-UG-WEB-SHELL-AND-PER-LANGUAGE-BUNDLES-20261011: the literal
// above is English only. English is the fallback every lookup ends on, so it
// stays in the entry chunk; Spanish is its own chunk (./i18n/es.js) that
// loadLanguage() fetches the first time it is selected, so a member reading
// English never downloads it. Until a language is registered, t() for it
// resolves exactly as it does for any language without a table: English copy,
// never a raw key. The shell does not switch to a language until its table is
// here (src/lib/useLoadedLanguage.js), so nobody sees that fallback mid-switch.
// Node, scripts and tests import ./i18n/allLanguages.js, which registers every
// language synchronously.
const LANGUAGE_CHUNKS = Object.freeze({
  es: () => import("./i18n/es.js").then((module) => module.spanishCatalogue.es),
});
// Same single retry as lazyView(): a chunk a newer deploy rotated away, or a
// flapping connection, gets one more fetch before the English fallback holds.
export const LANGUAGE_RETRY_DELAY_MS = 600;
const languageLoads = new Map();

export function languageLoaded(lang) {
  return Object.hasOwn(catalogue, lang);
}

export function registerLanguage(lang, table) {
  catalogue[lang] = table;
}

// REQ-UG-WEB-ENTRY-CHUNK-CARRIES-WHOLE-ENGLISH-CATALOGUE-20261109:
// the namespaces only lazily loaded views use are not spread into the English
// literal above. Each has a registration module,
// ./i18n/features/<namespace>Strings.js, that every module naming one of its
// keys imports, so the strings arrive with the
// view's chunk and are in catalogue.en before that module's code runs: t()
// stays synchronous and never shows a raw key. Their keys belong to no other
// table, so the order they register in changes nothing
// (tests/i18n-feature-strings.test.js pins both). Spanish already carries every
// namespace (./i18n/es.js), and ./i18n/allLanguages.js registers all of them
// for Node and the tests.
export function registerFeatureStrings(namespace) {
  Object.assign(catalogue.en, namespace.en);
}

// Resolves true once `lang` has a table, false when it cannot get one (a
// language with no chunk, a chunk that failed twice, or a load still unsettled
// at the shell deadline: main.jsx waits on this before the first paint, so a
// stalled request must not hold the page blank). Never rejects, so a caller
// cannot strand the screen on a loading state; after a failure the next call
// tries again. Concurrent calls for one language share a single fetch.
export function loadLanguage(lang, { load = LANGUAGE_CHUNKS[lang], retryDelayMs = LANGUAGE_RETRY_DELAY_MS, deadlineMs = SHELL_LOAD_DEADLINE_MS } = {}) {
  if (languageLoaded(lang)) return Promise.resolve(true);
  if (!Object.hasOwn(LANGUAGE_CHUNKS, lang) || typeof load !== "function") return Promise.resolve(false);
  if (languageLoads.has(lang)) return languageLoads.get(lang);
  const pending = withLoadDeadline(Promise.resolve()
    .then(load)
    .catch(() => new Promise((resolve) => { setTimeout(resolve, retryDelayMs); }).then(load)), deadlineMs)
    .then((table) => {
      if (!table || typeof table !== "object") return false;
      registerLanguage(lang, table);
      return true;
    }, () => false)
    .finally(() => { languageLoads.delete(lang); });
  languageLoads.set(lang, pending);
  return pending;
}

// t() delegates to ./i18n/runtime.js so the namespace chunks spread in above
// and this barrel resolve a key through ONE implementation. A catalogue hit
// (requested language, then English) interpolates `{var}` and strips
// absent-or-nullish slots. A miss in both tables is a verbatim fallback:
// the key returns byte-for-byte with no replace(), even when vars are supplied.
export function t(lang, key, vars) {
  return lookup(catalogue, lang, key, vars);
}

// The key for a counted phrase with a ".one" form, so one reads "1 reply",
// never "1 replies". Anything but exactly one takes the plain (plural) key.
export function countKey(key, count) {
  return count === 1 ? `${key}.one` : key;
}

// Owner 2026-09-18, UX-UG-PUBLIC-EVENT-DETAIL-SPANISH-TIMEZONE-LABEL-
// 20260917: a zone label shows the LONG name in BOTH languages. ICU's own
// Spanish long name is "hora estándar oriental"; the owner chose "hora estándar
// del Este", so the zone name is the one field this helper reads out of the
// catalogue instead of taking ICU's. The table is keyed by the CLDR ENGLISH
// long name, which identifies the same zone and the same standard/daylight
// state for any rendering locale — so a call site carries the decision in one
// option, timeZoneName: "long", instead of the language ternary PRs  and
//  removed from the public event detail.
const LONG_ZONE_NAME_KEYS = Object.freeze({
  "Eastern Standard Time": "date.zoneEasternStandard",
  "Eastern Daylight Time": "date.zoneEasternDaylight",
});

// Returns a formatter with .format(value): an Intl.DateTimeFormat, unless the
// caller asked for a long zone name, in which case format() substitutes the
// catalogue's zone name for ICU's and leaves every other field ICU's own.
export function dateTimeFormat(lang, options = DATE_TIME_STAMP_OPTIONS) {
  const formatter = dateTimeFormatCore(lang, options);
  if (options?.timeZoneName !== "long") return formatter;
  const cldrEnglish = new Intl.DateTimeFormat("en-US", { ...options, hourCycle: TWELVE_HOUR_CLOCK });
  return {
    format(value) {
      // A supplied invalid date must not throw; a missing argument is still "now".
      if (arguments.length > 0 && Number.isNaN(new Date(value).getTime())) return "";
      const zone = cldrEnglish.formatToParts(value).find((part) => part.type === "timeZoneName")?.value;
      const key = LONG_ZONE_NAME_KEYS[zone];
      // A zone the catalogue does not carry keeps ICU's label rather than
      // rendering a key or an empty string.
      if (!key) return formatter.format(value);
      return formatter
        .formatToParts(value)
        .map((part) => (part.type === "timeZoneName" ? t(lang, key) : part.value))
        .join("");
    },
  };
}

// localeFor and formatDateTime are re-exported under their existing names, so
// every web importer of src/lib/i18n.js is unchanged.
export { formatDateTime, localeFor } from "./i18n/format.js";
export { formatDateTimeWithZone, formatDateWithYear } from "./i18n/zonedDates.js";
