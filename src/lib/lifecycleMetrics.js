export const CAMPAIGN_STAGE_LABELS = {
  lead: "Lead",
  committee: "Committee",
  cards: "Cards",
  petition: "Petition",
  election: "Election",
  recognition: "Recognition",
  certification: "Certification",
  bargaining: "Bargaining",
  first_contract: "First contract",
  established: "Established",
  paused: "Paused",
  withdrawn: "Withdrawn",
  lost: "Lost",
};

const CAMPAIGN_STAGE_LABELS_ES = {
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
  paused: "Pausada",
  withdrawn: "Retirada",
  lost: "Perdida",
};

export function campaignStageLabel(stage, lang = "en") {
  const table = lang === "es" ? CAMPAIGN_STAGE_LABELS_ES : CAMPAIGN_STAGE_LABELS;
  return table[stage] || String(stage || "").replaceAll("_", " ");
}

export function safePercent(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)));
}

export function coveragePercent(row) {
  if (row?.contactedCount == null || row?.eligibleEstimate == null) return null;
  return safePercent(Number(row.contactedCount), Number(row.eligibleEstimate));
}

export function stageAgeDays(dateValue, now = new Date()) {
  if (!dateValue) return null;
  const start = new Date(String(dateValue).includes("T") ? dateValue : `${dateValue}T12:00:00Z`);
  if (Number.isNaN(start.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - start.getTime()) / 86400000));
}

// Privacy results carry a STATUS CODE, never a rendered label. This module has
// no locale, and a suppression label is the one string a Spanish-reading
// organizer must not be shown in English: the caller owns the wording, because
// only the caller knows which language the organizer asked for. Returning a
// baked "Not shown" from here is what put English privacy labels in front of
// Spanish organizers once already.
export function suppressSmall(value, denominator, minimum = 5) {
  const complement = Number(denominator) - Number(value);
  if (
    !Number.isFinite(value)
    || !Number.isFinite(denominator)
    || denominator < minimum
    || value < minimum
    || complement < minimum
  ) {
    return { value: null, status: "suppressed", suppressed: true };
  }
  return { value, status: "ok", suppressed: false };
}

export function netGrowth(year) {
  if (year?.joined == null || year?.left == null) return null;
  return Number(year.joined) - Number(year.left);
}
