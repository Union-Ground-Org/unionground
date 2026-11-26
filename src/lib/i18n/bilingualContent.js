// Spanish versions of chapter spaces and channel posts
// (REQ-UG-SPANISH-SPACES-AND-POSTS-20261030), split out of the
// src/lib/i18n.js barrel like welcomeBack.js. This file is the ONLY
// declaration of every `bilingualContent.` key; the barrel spreads it back
// into `catalogue`, so `t()` is unchanged.
export const bilingualContentCatalogue = {
  en: {
    "bilingualContent.spaceNameEs": "Name in Spanish (optional)",
    "bilingualContent.spaceDescriptionEs": "Description in Spanish (optional)",
    "bilingualContent.spaceSpanishHint": "Workers reading in Spanish see these instead. Leave them empty to show the name and description above to everyone.",
    "bilingualContent.postSpanishToggle": "Add a Spanish version (optional)",
    "bilingualContent.postBodyEs": "Reply in Spanish",
    "bilingualContent.postSpanishHint": "Workers reading in Spanish see this version. It cannot be changed after you post.",
  },
  es: {
    "bilingualContent.spaceNameEs": "Nombre en español (opcional)",
    "bilingualContent.spaceDescriptionEs": "Descripción en español (opcional)",
    "bilingualContent.spaceSpanishHint": "Quienes leen en español ven estos textos. Déjalos vacíos para que todos vean el nombre y la descripción de arriba.",
    "bilingualContent.postSpanishToggle": "Añadir una versión en español (opcional)",
    "bilingualContent.postBodyEs": "Respuesta en español",
    "bilingualContent.postSpanishHint": "Quienes leen en español ven esta versión. No se puede cambiar después de publicar.",
  },
};
