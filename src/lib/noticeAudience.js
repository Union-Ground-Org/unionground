// Audience choices come from the caller's granted office scopes, never from
// ordinary unit membership; an organization steward grant counts only through
// the unit it is assigned to (#7664).
import { publishNoticeOnce } from "./noticePublishKey.js";

export const NOTICE_AUDIENCE_UNAVAILABLE = "notice_audience_unavailable";

function unavailable(cause, accessMissing = false, status) {
  return Object.assign(new Error("Notice audience unavailable"), { code: NOTICE_AUDIENCE_UNAVAILABLE, cause, accessMissing, status });
}

const leadership = (role) => role === "admin" || role === "vp";
const current = (context) => !context.isCurrent || context.isCurrent();

export async function loadNoticeAudiences(client, context) {
  if (!["steward", "admin", "vp"].includes(context.role) || !context.chapterId) return [];
  const result = await client.rpc("get_chapter_office_access");
  const office = result?.data;
  if (result?.error || !current(context) || !office || office.chapterId !== context.chapterId
    || typeof office.notices !== "boolean" || typeof office.unscopedNotices !== "boolean" || !Array.isArray(office.scopes)) throw unavailable(result?.error, !result?.error && office === null, result?.status);
  if (!office.notices) return [];
  const audiences = [];
  if (office.unscopedNotices) {
    audiences.push({ value: "chapter", kind: "chapter", chapterId: office.chapterId, name: "" });
    if (leadership(context.role) && context.canPostOrganization) audiences.push({ value: "organization", kind: "organization", chapterId: office.chapterId, name: "" });
  }
  const seen = new Set();
  for (const scope of office.scopes) {
    if (scope?.role !== context.role || scope.notices !== true || typeof scope.name !== "string" || !scope.name.trim()) continue;
    const unitId = typeof scope.unitId === "string" ? scope.unitId.trim() : "";
    const committeeId = typeof scope.committeeId === "string" ? scope.committeeId.trim() : "";
    if (Boolean(unitId) === Boolean(committeeId)) continue;
    const kind = unitId ? "unit" : "committee";
    const value = `${kind}:${unitId || committeeId}`;
    if (seen.has(value)) continue;
    seen.add(value);
    audiences.push({ value, kind, chapterId: office.chapterId, name: scope.name.trim(), ...(unitId ? { unitId } : { committeeId }) });
  }
  return audiences;
}

// operationKey: the composer's draft key (src/lib/noticePublishKey.js); every
// attempt of one draft carries it, so a retry after a lost reply gets the
// published notice back instead of a second one (#9220).
export async function publishNoticeAudience(client, title, body, locale, audience, operationKey) {
  if (!audience?.chapterId || typeof audience.chapterId !== "string") throw unavailable();
  const fields = { p_title: title.trim(), p_body: body.trim(), p_locale: locale };
  let result;
  if (audience.kind === "organization" && audience.value === "organization" && !audience.unitId && !audience.committeeId) {
    result = await publishNoticeOnce({ ...fields, p_audience_scope: "organization" },
      (sent) => client.rpc("publish_member_broadcast", sent), operationKey);
  } else {
    const chapter = audience.kind === "chapter" && audience.value === "chapter" && !audience.unitId && !audience.committeeId;
    const unit = audience.kind === "unit" && typeof audience.unitId === "string" && audience.unitId.trim()
      && audience.value === `unit:${audience.unitId}` && !audience.committeeId;
    const committee = audience.kind === "committee" && typeof audience.committeeId === "string" && audience.committeeId.trim()
      && audience.value === `committee:${audience.committeeId}` && !audience.unitId;
    if (!chapter && !unit && !committee) throw unavailable();
    result = await publishNoticeOnce({
      ...fields, p_chapter: audience.chapterId, p_unit: unit ? audience.unitId : null,
      p_committee: committee ? audience.committeeId : null,
    }, (sent) => client.rpc("publish_chapter_office_notice", sent), operationKey);
  }
  // Revocation or a moved scope requires a new audience choice, not a retry
  // through the broad publisher. Other write errors keep their existing path.
  if (result?.error) {
    if (result.error.code === "42501") throw unavailable(result.error, false, result.status);
    throw Object.assign(new Error("Notice was not published"), { code: result.error.code, status: result.status, cause: result.error, keyReused: result.keyReused === true });
  }
  return result?.data;
}

// Existing desk/Compass callers have no audience picker. Only a single
// granted audience can be chosen for them; ambiguity stays unavailable.
export async function publishNoticeForAudience(client, title, body, locale, value = "chapter", context, operationKey) {
  if (!["steward", "admin", "vp"].includes(context.role) || !context.chapterId || !current(context)) throw unavailable();
  let audience;
  if (value === "chapter") {
    const choices = await loadNoticeAudiences(client, context);
    audience = choices.find((choice) => choice.kind === "chapter");
    if (!audience && choices.length === 1) audience = choices[0];
    if (!audience) throw unavailable();
  } else if (value === "organization") {
    if (!leadership(context.role) || !context.canPostOrganization) throw unavailable();
    audience = { value, kind: value, chapterId: context.chapterId, name: "" };
  } else if (typeof value === "string" && value.startsWith("unit:")) {
    audience = { value, kind: "unit", chapterId: context.chapterId, unitId: value.slice(5), name: "" };
  } else if (typeof value === "string" && value.startsWith("committee:")) {
    audience = { value, kind: "committee", chapterId: context.chapterId, committeeId: value.slice(10), name: "" };
  } else throw unavailable();
  if (!current(context)) throw unavailable();
  return publishNoticeAudience(client, title, body, locale, audience, operationKey);
}
