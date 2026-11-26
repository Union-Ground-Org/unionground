import React from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "../../src/lib/LanguageContext.jsx";
import { loadLanguage } from "../../src/lib/i18n.js";
import { ChapterAccessPanel } from "../../src/features/chapterAccess/ChapterAccessPanel.jsx";
import { ChapterOfficePanel } from "../../src/features/chapterAccess/ChapterOfficePanel.jsx";
import { ChapterOfficeRoleChoice } from "../../src/features/chapterAccess/ChapterOfficeRoleChoice.jsx";
import { DraftSharingPanel } from "../../src/features/chapterAccess/DraftSharingPanel.jsx";
import { GrievanceIdentityControl } from "../../src/features/chapterAccess/GrievanceIdentityControl.jsx";
import { createChapterAccessApi, createGrievancePrivacyApi } from "../../src/lib/chapterAccessApi.js";
import "../../src/sg-tokens.css";
import "../../src/styles.css";
const lang = new URLSearchParams(location.search).get("lang") || "en";
const workspace = { policy: { steward_grievances: true, steward_breadth: "chapter" }, members: [{ id: "member", name: "Fictional Mira" }], units: [{ id: "unit", name: "Garage" }], committees: [], grants: [], roles: [{ role: "secretary", capability: "records" }], settings: [], grantableRoles: ["secretary", "records", "steward"], hasMoreMembers: false, hasMoreUnits: false, hasMoreCommittees: false };
let shared = false, identityPrivate = false;
window.accessCalls = [];
const client = { rpc: async (name, fields) => {
  window.accessCalls.push({ name, fields });
  if (name === "get_chapter_access_workspace") return { data: structuredClone(workspace) };
  if (name === "set_chapter_access_policy") workspace.policy = { steward_grievances: fields.p_steward_grievances, steward_breadth: fields.p_steward_breadth };
  if (name === "save_chapter_committee") workspace.committees.push({ id: "committee", name: fields.p_name, purpose: fields.p_purpose, starts_on: fields.p_starts_on, grievance_access: fields.p_grievance_access });
  if (name === "set_member_draft_steward_share") shared = fields.p_shared;
  if (name === "list_member_draft_sharing") return { data: [{ id: "steward", name: "Fictional Lee", shared }] };
  if (name === "set_grievance_identity_private") identityPrivate = fields.p_private;
  if (name === "get_grievance_identity_visibility") return { data: { canChange: true, private: identityPrivate } };
  if (name === "get_chapter_office_access") return { data: { chapterId: "chapter", documents: true, notices: true, unscopedDocuments: true, unscopedNotices: false, scopes: [{ role: "secretary", unitId: "unit", name: "Garage", notices: true }] } };
  if (name === "list_chapter_office_documents") return { data: [] };
  if (name === "list_my_member_notices") return { data: { notices: [], hasMore: false } };
  if (name === "list_announcement_drafts") return { data: { drafts: [] } };
  return { data: { updated: true } };
} };
await loadLanguage(lang);
document.documentElement.lang = lang;
function OfficeExample() {
  const [role,setRole]=React.useState("member");
  return <><ChapterOfficeRoleChoice roles={["secretary","records"]} selectedHat={role} onSelect={setRole}/>{role!=="member"&&<ChapterOfficePanel key={role} client={client} chapterId="chapter" role={role}/>}</>;
}
createRoot(document.getElementById("root")).render(<LanguageProvider lang={lang}><main className="sg-app institutional" data-workspace-theme="union-ground" style={{ background: "var(--canvas)", minHeight: "100vh", maxWidth: 1000, margin: "auto", padding: 16, display: "grid", gap: 32 }}><h1>Fictional local regression fixture</h1><ChapterAccessPanel client={client} chapterId="chapter" /><OfficeExample/><DraftSharingPanel api={createChapterAccessApi(client)} formId="form" /><GrievanceIdentityControl api={createGrievancePrivacyApi(client)} caseId="case" /></main></LanguageProvider>);
