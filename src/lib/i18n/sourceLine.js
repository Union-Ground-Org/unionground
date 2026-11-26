// The source line under every sourced figure or document
// (REQ-UG-PROVENANCE-CONTRACT-20261012, docs/conventions/provenance.md).
// Split out of the src/lib/i18n.js barrel like ./qa.js so the web
// SourceLine and apps/mobile's SourceLine read one register without the whole
// catalogue. This file is the ONLY declaration of every `sourceLine.` key; the
// barrel spreads it back in place.
import { lookup } from "./runtime.js";

export const sourceLineCatalogue = {
  en: {
    "sourceLine.label": "Source:",
    "sourceLine.retrieved": "retrieved {date}",
    "sourceLine.opensNewTab": "{publisher}, opens in a new tab",
    "sourceLine.opensBrowser": "{publisher}, opens in your browser",
    "sourceLine.inputs": "Inputs ({count})",
    "sourceLine.hideInputs": "Hide inputs",
    "sourceLine.inputReference": "Record {reference}",
    "sourceLine.unavailable": "Source record missing. This item cannot be traced to its source.",
    "sourceLine.openFailed": "The source could not be opened.",
  },
  es: {
    "sourceLine.label": "Fuente:",
    "sourceLine.retrieved": "consultada el {date}",
    "sourceLine.opensNewTab": "{publisher}, se abre en una pestaña nueva",
    "sourceLine.opensBrowser": "{publisher}, se abre en el navegador",
    "sourceLine.inputs": "Datos de origen ({count})",
    "sourceLine.hideInputs": "Ocultar datos de origen",
    "sourceLine.inputReference": "Registro {reference}",
    "sourceLine.unavailable": "Falta el registro de la fuente. No se puede rastrear este elemento hasta su origen.",
    "sourceLine.openFailed": "No se pudo abrir la fuente.",
  },
};

// Same resolution as the barrel's t(), identical for every "sourceLine." key
// because this chunk is where every one of them is declared.
export function sourceLineT(lang, key, vars) {
  return lookup(sourceLineCatalogue, lang, key, vars);
}
