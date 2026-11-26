// The recorded case outcome as the member reads it, and the coordinator's
// confirm line that says so (BUG-UG-MEMBER-NEVER-SEES-GRIEVANCE-OUTCOME-20261106).
// Web only, outside the src/lib/i18n.js barrel: the barrel and its Spanish
// table are published legal surface that changes only in a legal release, and
// the native app (English only) keeps its own copy. This file is the ONLY
// declaration of every `caseOutcome.` key; read them through caseOutcomeT.
import { lookup } from "./runtime.js";

export const caseOutcomeCatalogue = {
  en: {
    "caseOutcome.title": "How your case ended",
    "caseOutcome.recordedOn": "Recorded {date}",
    "caseOutcome.kind.upheld": "Upheld",
    "caseOutcome.kind.settled": "Settled",
    "caseOutcome.kind.withdrawn": "Withdrawn",
    "caseOutcome.kind.denied": "Denied",
    "caseOutcome.kind.other": "Other",
    "caseOutcome.coordinatorConfirm": "I confirm this outcome will resolve the case. The member will see the outcome and summary.",
    "caseOutcome.loadError": "The outcome of your case could not be loaded.",
    "caseOutcome.staleError": "The outcome could not be refreshed. What is shown may be out of date.",
    "caseOutcome.loading": "Loading the outcome of your case…",
    "caseOutcome.none": "There is no outcome to show for your case yet.",
    "caseOutcome.retry": "Try again",
  },
  es: {
    "caseOutcome.title": "Cómo terminó tu caso",
    "caseOutcome.recordedOn": "Registrado el {date}",
    "caseOutcome.kind.upheld": "Sostenido",
    "caseOutcome.kind.settled": "Acuerdo",
    "caseOutcome.kind.withdrawn": "Retirado",
    "caseOutcome.kind.denied": "Denegado",
    "caseOutcome.kind.other": "Otro",
    "caseOutcome.coordinatorConfirm": "Confirmo que este resultado resolverá el caso. El miembro verá el resultado y el resumen.",
    "caseOutcome.loadError": "No se pudo cargar el resultado de tu caso.",
    "caseOutcome.staleError": "No se pudo actualizar el resultado. Lo que se muestra puede estar desactualizado.",
    "caseOutcome.loading": "Cargando el resultado de tu caso…",
    "caseOutcome.none": "Todavía no hay un resultado que mostrar para tu caso.",
    "caseOutcome.retry": "Intentar de nuevo",
  },
};

export function caseOutcomeT(lang, key, vars) {
  return lookup(caseOutcomeCatalogue, lang, key, vars);
}

// The label key for a stored outcome. Own-property lookup only; an unknown
// value reads as Other rather than a raw key.
const OUTCOME_KINDS = Object.freeze(["upheld", "settled", "withdrawn", "denied", "other"]);
export function caseOutcomeLabelKey(outcome) {
  return `caseOutcome.kind.${OUTCOME_KINDS.includes(outcome) ? outcome : "other"}`;
}
