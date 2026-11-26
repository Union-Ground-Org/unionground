import { MemberApiError, updateChapterDocumentContent } from "./memberApi.js";
import { accessScope } from "./chapterAccessScope.js";
import { publishNoticeOnce } from "./noticePublishKey.js";
export { accessScope } from "./chapterAccessScope.js";

function value(result, operation) {
  if (result.error) {
    const error = new MemberApiError(operation, result.error);
    // #9955: MemberApiError keeps the error's code, not the response's HTTP
    // status. A refusal that arrives as a status alone (403 or 404, no code)
    // keeps it here, so a case switch can tell it from a failed read.
    if (Number.isInteger(result.status)) error.status = result.status;
    throw error;
  }
  return result.data;
}

function list(result) {
  if (!Array.isArray(result)) throw new MemberApiError("Load chapter access", { message: "Access list unavailable" });
  return result;
}

export function createChapterAccessApi(client) {
  if (!client) return null;
  const rpc = async (name, fields) => value(await client.rpc(name, fields), name);
  return {
    load: async (chapter, pages, query) => {
      const workspace = await rpc("get_chapter_access_workspace", {
        p_chapter: chapter, p_member_page: pages.members, p_unit_page: pages.units,
        p_committee_page: pages.committees, p_query: query,
      });
      if (!workspace || !workspace.policy || !["members", "units", "committees", "grants", "roles", "settings", "grantableRoles"].every((key) => Array.isArray(workspace[key]))) {
        throw new MemberApiError("Load chapter access", { message: "Access workspace unavailable" });
      }
      return workspace;
    },
    saveCommittee: (chapter, fields) => rpc("save_chapter_committee", {
      p_id: fields.id || null, p_chapter: chapter, p_name: fields.name,
      p_purpose: fields.purpose, p_starts_on: fields.startsOn,
      p_ends_on: fields.endsOn || null, p_grievance_access: fields.grievanceAccess,
    }),
    setMember: (chapter, user, scope, enabled) => rpc("set_chapter_access_member", {
      p_chapter: chapter, p_user: user, p_unit: scope.unitId || null,
      p_committee: scope.committeeId || null, p_enabled: enabled,
    }),
    setRole: (chapter, user, role, scope, enabled) => rpc("set_member_access_role", {
      p_chapter: chapter, p_user: user, p_role: role, p_enabled: enabled,
      p_unit: scope.unitId || null, p_committee: scope.committeeId || null,
    }),
    setPolicy: (chapter, grievances, breadth) => rpc("set_chapter_access_policy", {
      p_chapter: chapter, p_steward_grievances: grievances, p_steward_breadth: breadth,
    }),
    setCapability: (chapter, role, capability, enabled) => rpc("set_chapter_role_capability", {
      p_chapter: chapter, p_role: role, p_capability: capability, p_enabled: enabled,
    }),
    office: async () => {
      const office = await rpc("get_chapter_office_access");
      if (!office || !office.chapterId || !Array.isArray(office.scopes)) throw new MemberApiError("Load chapter office", { message: "Office unavailable" });
      return office;
    },
    documents: async (chapter, page) => list(await rpc("list_chapter_office_documents", { p_chapter: chapter, p_page: page })),
    // operationKey is the composer's draft key: a Post pressed again after a
    // lost reply carries it, so the server returns that notice instead of
    // publishing a second (#9220).
    publishNotice: async (chapter, title, body, locale, scope = "", operationKey) => value(await publishNoticeOnce({
      p_chapter: chapter, p_title: title, p_body: body, p_locale: locale,
      p_unit: accessScope(scope).unitId || null, p_committee: accessScope(scope).committeeId || null,
    }, (sent) => client.rpc("publish_chapter_office_notice", sent), operationKey), "publish_chapter_office_notice"),
    saveDocument: (id, fields, action) => id
      ? updateChapterDocumentContent(client, id, fields, action)
      : rpc("create_chapter_office_document", {
        p_chapter: fields.chapterId, p_title: fields.title, p_body: fields.body, p_summary: fields.summary,
        p_unit: accessScope(fields.accessScope).unitId || null,
        p_committee: accessScope(fields.accessScope).committeeId || null,
        p_published: action === "republish",
      }),
    sharing: async (form) => list(await rpc("list_member_draft_sharing", { p_form: form })),
    share: (form, steward, shared) => rpc("set_member_draft_steward_share", { p_form: form, p_steward: steward, p_shared: shared }),
    sharedDrafts: async () => list(await rpc("list_shared_member_drafts")),
    privateGrievances: async () => list(await rpc("list_private_grievance_summaries")),
    identityVisibility: (caseId) => rpc("get_grievance_identity_visibility", { p_case: caseId }),
    setIdentityPrivate: (caseId, enabled) => rpc("set_grievance_identity_private", { p_case: caseId, p_private: enabled }),
    // REQ-UG-LIST-ROW-DETAIL-TOGGLE-CHAPTER-AND-STEWARD-20261104 (#7043).
    caseRowTopicPolicy: (chapter) => rpc("get_chapter_case_row_topic", { p_chapter: chapter }),
    setCaseRowTopicPolicy: (chapter, enabled) => rpc("set_chapter_case_row_topic", { p_chapter: chapter, p_enabled: enabled }),
    caseRowTopic: (caseId) => rpc("get_case_row_topic", { p_case: caseId }),
    setCaseRowTopic: (caseId, shown) => rpc("set_case_row_topic", { p_case: caseId, p_shown: shown }),
  };
}

export function createGrievancePrivacyApi(client) {
  const api = createChapterAccessApi(client);
  return api ? {
    loadIdentityVisibility: api.identityVisibility, setIdentityPrivate: api.setIdentityPrivate,
    loadCaseRowTopic: api.caseRowTopic, setCaseRowTopic: api.setCaseRowTopic,
  } : {};
}
