// The event exception consumes only the service RPC's leased source-event
// projection. Claimed notification text and arbitrary metadata are never copy.
import { brandText } from "./brand.js";
const CHANGES = {
  en: { created: "New event", rescheduled: "Event rescheduled", cancelled: "Event cancelled", restored: "Event restored", reminder: "Event reminder" },
  es: { created: "Nuevo evento", rescheduled: "Evento reprogramado", cancelled: "Evento cancelado", restored: "Evento restaurado", reminder: "Recordatorio del evento" },
};

export function eventEmailLeaseMatches(projection, row) {
  return projection !== null && typeof projection === "object"
    && projection.deliveryId === row.deliveryId
    && projection.attempt === row.attempt
    && projection.leaseEpoch === row.leaseEpoch
    && projection.email === row.email
    && ["en", "es"].includes(projection.lang);
}

export function eventEmailTemplate(projection, row) {
  if (row.kind !== "events" || projection?.status !== "authorized"
      || !eventEmailLeaseMatches(projection, row)) return null;
  const { title, startsAt, change, lang, timeZone } = projection;
  if (typeof title !== "string" || title !== title.trim()
      || [...title].length < 3 || [...title].length > 120
      || /[\p{Cc}\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(title)
      || !Object.hasOwn(CHANGES[lang], change)
      || typeof timeZone !== "string" || timeZone.length < 1 || timeZone.length > 64
      || typeof startsAt !== "string" || startsAt.length > 40
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(startsAt)) return null;
  const date = new Date(startsAt);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1) return null;
  // Presentation is frozen by the source RPC on its first authorized attempt.
  // Later retries still recheck access, but never change this request's copy.
  let when;
  try {
    when = new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", {
      timeZone, year: "numeric", month: "long", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(date);
  } catch { return null; }
  const open = brandText(lang === "es" ? "Abre Union Ground para ver los detalles." : "Open Union Ground for details.");
  return {
    subject: `${CHANGES[lang][change]}: ${title}`,
    body: lang === "es"
      ? `${CHANGES[lang][change]}. ${title}. Fecha: ${when}. ${open}`
      : `${CHANGES[lang][change]}. ${title}. Date: ${when}. ${open}`,
  };
}
