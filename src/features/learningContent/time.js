import { formatEasternTimestamp } from "../../lib/easternTimestamp.js";
import { parseLearningInstant } from "./model.js";

// Publication/history displays share one Eastern clock in either language.
export function formatLearningInstant(value, lang) {
  const at = parseLearningInstant(value);
  return at == null ? "" : formatEasternTimestamp(new Date(at), lang, { daylightName: true })?.text || "";
}

// <input type="datetime-local"> speaks the device's local wall time with no
// zone; this is the one conversion from it to the instants the RPCs take.
const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

// "" -> null; a real local wall time -> ISO instant; anything else -> "invalid".
// Every field must survive the round trip, so an impossible time (12:75, a
// 31st of a short month) or a wall time the device's zone skips at a
// daylight-saving change is refused instead of silently moving.
export function instantFromLocalInput(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  const match = LOCAL_INPUT.exec(text.trim());
  if (!match) return "invalid";
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? "0"));
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  const roundTrip = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
  if (Number.isNaN(date.getTime()) || roundTrip.some((value, index) => value !== [year, month, day, hour, minute, second][index])) return "invalid";
  return date.toISOString();
}
