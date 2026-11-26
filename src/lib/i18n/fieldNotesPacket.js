import { fieldNotesPacketCatalogueSpanish } from "./locales/es/namespaces/fieldNotesPacket.js";
// REQ-UG-FIELD-NOTES-AI-PACKET-20261001 copy (restore-everything lane
// L11b). Split out of the src/lib/i18n.js barrel like compassAssistant.js;
// this file is the ONLY declaration of every `fieldNotes.packet.` key and of
// the settings.def copy for the two settings this lane registers.
export const fieldNotesPacketCatalogue = {
  en: {
    "fieldNotes.packet.open": "Draft a packet",
    "fieldNotes.packet.title": "Draft packet from field notes",
    "fieldNotes.packet.intro": "Pick the notes to use. The Guide drafts a packet from those notes and your campaign's verified sources. The draft is for you to review; nothing is saved or sent.",
    "fieldNotes.packet.selectLabel": "Use this note",
    "fieldNotes.packet.selected": "{count} of {limit} notes selected",
    "fieldNotes.packet.limitReached": "Your organization allows {limit} notes in one packet.",
    "fieldNotes.packet.submit": "Draft the packet",
    "fieldNotes.packet.working": "Drafting…",
    "fieldNotes.packet.cancel": "Close",
    "fieldNotes.packet.draftLabel": "Draft for review",
    "fieldNotes.packet.summary": "Summary",
    "fieldNotes.packet.plainLanguage": "In plain language",
    "fieldNotes.packet.checklist": "Bring this",
    "fieldNotes.packet.questions": "Questions to ask",
    "fieldNotes.packet.sources": "Sources used",
    "fieldNotes.packet.noSources": "No sources backed this draft.",
    "fieldNotes.packet.needNotes": "Choose at least one field note.",
    "fieldNotes.packet.no_notes": "None of those notes could be used. Pick different notes.",
    "fieldNotes.packet.feature_disabled": "Your organization has turned off draft packets from field notes.",
    "fieldNotes.packet.staff_required": "Drafting a packet is for staff roles.",
    "fieldNotes.packet.notes_unavailable": "That task is no longer available to you.",
    "fieldNotes.packet.failed": "The packet could not be drafted right now. Try again shortly.",
    "settings.def.features.ai_assistant.field_notes_packet.label": "Draft a packet from field notes",
    "settings.def.features.ai_assistant.field_notes_packet.description": "Let staff turn field notes they can already read on one task into a draft packet, grounded in verified campaign sources. The draft is for review and is never saved or sent on its own.",
    "settings.def.limits.ai_assistant.packet_notes.label": "Field notes per draft packet",
    "settings.def.limits.ai_assistant.packet_notes.description": "How many field notes one draft packet may use. Extra selected notes are ignored.",
  },
  get es() { return fieldNotesPacketCatalogueSpanish; },
};
