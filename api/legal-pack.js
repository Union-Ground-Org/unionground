import { LEGAL_INSTRUMENTS } from "../src/lib/legalInstruments.js";
import { RESIDENCE_REGIONS, ageRuleFor } from "../src/lib/residenceRegions.js";
import { t } from "../src/lib/i18n/allLanguages.js";
import { json, methodGuard } from "./_lib/http.js";
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { verifiedLegalDeployment } from "./_lib/legalReleaseGate.js";

// Public documents only: no invitation, account lookup or credential is needed.
// Read text and versions from the same deployment, rather than combining a new
// version map with the old page's bundled legal copy.
export function publishedLegalPack(language) {
  return {
    language,
    acceptance: {
      consent: t(language, "inviteAccept.terms.consent"),
      residenceAge: {
        rules: Object.fromEntries(RESIDENCE_REGIONS.map(({ code }) => [code, ageRuleFor(code)])),
        labels: Object.fromEntries(["state", "choose", "help", "adult", "band"]
          .map((key) => [key, t(language, `ageRule.${key}`)])),
      },
    },
    instruments: LEGAL_INSTRUMENTS.map((entry) => ({
      key: entry.key, version: entry.version, path: entry.path, status: entry.status,
      name: t(language, entry.summaryTitleKey),
      intro: t(language, "legal.instrument.intro"),
      notice: [
        t(language, "legal.instrument.version", { version: entry.version }),
        entry.effectiveDate
          ? t(language, "legal.privacy.effective", { date: entry.effectiveDate })
          : t(language, "legal.instrument.pendingEffective"),
        entry.status === "operative" ? null : t(language, "legal.instrument.notOperative"),
      ].filter(Boolean).join(" "),
      sections: [...entry.sections, ["legal.instrument.acceptance.title", "legal.instrument.acceptance.body"]]
        .map(([heading, body]) => ({ heading: t(language, heading), body: t(language, body) })),
    })),
  };
}

export default function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  if (methodGuard(request, ["GET"], () => json(response, 405, { error: "method-not-allowed" }))) return;
  if (request.query?.publication === "1") {
    const backend = resolveSupabaseBackend(request);
    return verifiedLegalDeployment({ supabaseUrl: backend.url, serviceKey: backend.serviceRoleKey }).then((proof) =>
      json(response, proof ? 200 : 503, proof || { error: "legal-release-unavailable" }));
  }
  const language = request.query?.lang === "es" ? "es" : "en";
  return json(response, 200, publishedLegalPack(language));
}
