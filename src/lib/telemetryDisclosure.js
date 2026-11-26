import disclosure from "../data/telemetryDisclosure.json" with { type: "json" };
import { t } from "./i18n.js";

export const telemetry = disclosure;
export const AI_DISCLOSURE_CLAIMS = ["route", "sent", "controls", "connector"];

export function renderTelemetryMarkdown(lang) {
  const copy = telemetry.copy[lang];
  return [
    `## ${copy.title}`, "", telemetry.reviewed, "", copy.intro, "", copy.analytics, "", copy.diagnostics, "", copy.relay, "", copy.optout, "",
    `### ${copy.inventory}`, "", copy.storageNote, "",
    ...telemetry.storage.map((row) => `- **${row.storage}: ${row.keys.join(", ")}** — ${row.purpose[lang]}`), "",
    `### ${copy.cookies}`, "", copy.cookieNote, "",
    ...telemetry.cookies.map((row) => `- **${row.key}** — ${row.purpose?.[lang] || copy.cookiePurpose}`), "",
    `### ${copy.ai}`, "", copy.attribution, "",
    ...AI_DISCLOSURE_CLAIMS.map((key) => `${t(lang, `legal.aiDisclosure.${key}.body`)}\n`),
    `[${copy.register}](/subprocessors)`,
  ].join("\n");
}
