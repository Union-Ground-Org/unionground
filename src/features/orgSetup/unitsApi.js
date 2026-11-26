// Units and worksites inside a chapter, and the local's profile
// (REQ-UG-CHAPTER-UNITS-WORKSITES-AND-LOCAL-PROFILE-20261030). Thin
// RPC wrappers in the setupApi.js shape: `(client, …)`, one call each, every
// error wrapped in MemberApiError so `code` survives for the card. Every
// writer answers with the full list or profile after the write.
import { MemberApiError } from "../../lib/memberApi.js";

export const UNIT_KINDS = Object.freeze(["unit", "worksite"]);
export const LOCAL_PROFILE_FIELDS = Object.freeze([
  "officeAddress", "phone", "officeHours", "employer",
  "contractStartsOn", "contractEndsOn", "boardSchedule", "timeZone",
]);

const text = (value) => (typeof value === "string" && value.trim() ? value : null);

export function normalizeUnits(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row.id === "string" && typeof row.chapterId === "string" && text(row.name))
    .map((row) => ({
      id: row.id,
      chapterId: row.chapterId,
      chapterName: text(row.chapterName) ?? "",
      name: row.name,
      kind: UNIT_KINDS.includes(row.kind) ? row.kind : "unit",
      headcount: Number.isInteger(row.headcount) && row.headcount >= 0 ? row.headcount : null,
    }));
}

export function normalizeLocalProfile(data) {
  if (!data || typeof data !== "object") return null;
  const profile = Object.fromEntries(LOCAL_PROFILE_FIELDS.map((key) => [key, text(data[key])]));
  return { ...profile, units: normalizeUnits(data.units), canEdit: data.canEdit === true };
}

// Each RPC name stays a literal at its call site (the read-RPC drift guard
// resolves every .rpc( first argument).
function unwrap({ data, error }, label) {
  if (error) throw new MemberApiError(label, error);
  return data;
}

export async function listChapterUnits(client) {
  return normalizeUnits(unwrap(await client.rpc("list_chapter_units", {}), "Chapter units"));
}

export async function saveChapterUnit(client, { id = null, chapterId, name, kind = "unit", headcount = null }) {
  return normalizeUnits(unwrap(await client.rpc("save_chapter_unit", {
    p_unit_id: id,
    p_chapter_id: chapterId,
    p_name: String(name ?? "").trim(),
    p_kind: UNIT_KINDS.includes(kind) ? kind : "unit",
    p_headcount: Number.isInteger(headcount) ? headcount : null,
  }), "Save chapter unit"));
}

export async function deleteChapterUnit(client, unitId) {
  return normalizeUnits(unwrap(await client.rpc("delete_chapter_unit", { p_unit_id: unitId }), "Remove chapter unit"));
}

export async function loadLocalProfile(client) {
  return normalizeLocalProfile(unwrap(await client.rpc("get_organization_local_profile", {}), "Local profile"));
}

export async function saveLocalProfile(client, fields) {
  const profile = Object.fromEntries(LOCAL_PROFILE_FIELDS.map((key) => [key, String(fields?.[key] ?? "").trim() || null]));
  return normalizeLocalProfile(unwrap(await client.rpc("save_organization_local_profile", { p_profile: profile }), "Save local profile"));
}

// Units the invite form offers for one chapter, in the order the list keeps.
export function unitsForChapter(units, chapterId) {
  return (Array.isArray(units) ? units : []).filter((unit) => unit.chapterId === chapterId);
}
