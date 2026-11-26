import React from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "../../src/lib/LanguageContext.jsx";
import { loadLanguage } from "../../src/lib/i18n.js";
import { ChapterOfficeRoleChoice } from "../../src/features/chapterAccess/ChapterOfficeRoleChoice.jsx";
import { ChapterFinancePanel } from "../../src/features/finance/ChapterFinancePanel.jsx";
import { ChapterBudgetPanel } from "../../src/components/ChapterBudgetPanel.jsx";
import "../../src/sg-tokens.css";
import "../../src/styles.css";
const params = new URLSearchParams(location.search);
const lang = params.get("lang") || "en";
const refusalMode = params.get("refusals") === "1";
const refusals = {
  submit_chapter_financial_request: { code: "42501", message: "step-up required" },
  save_chapter_financial_document: { code: "22023", message: "invalid financial document" },
  decide_chapter_financial_request: { code: "PT409", message: "financial request conflict" },
};
const documents = [
  { id: "published", title: "Published fictional report", kind: "financial_report", body: "Reviewed financial report", status: "published", revision: 1 },
  { id: "draft", title: "Private fictional report", kind: "financial_report", body: "Draft report", status: "draft", revision: 1 },
];
const requests = refusalMode ? [{
  id: "pending", revision: 1, subject_id: "member", kind: "expense", title: "Fictional supplies",
  description: "Meeting supplies", amount: 12, status: "pending", decision_note: "",
}] : [];
const budgets = [];
let activeRole = "member";
const client = { rpc: async (name, fields) => {
  if (refusalMode && Object.hasOwn(refusals, name)) return { error: refusals[name] };
  if (name === "get_chapter_finance_workspace") return { data: { chapterId: "chapter", organizationId: "org", canRecords: fields.p_authoring, canDocuments: fields.p_authoring, canPublish: fields.p_authoring, canRoster: fields.p_authoring, canSubmit: true, documents: structuredClone(documents.filter(d => fields.p_authoring || d.status === "published")), requests: structuredClone(requests.filter(r => fields.p_authoring || r.subject_id === "member")) } };
  if (name === "list_chapter_finance_members") return { data: [{ id: "peer", name: "Fictional Mira" }] };
  if (name === "get_chapter_budget_access") return { data: { canRead: activeRole === "treasurer", canAssign: false, legacyRead: false, members: [] } };
  if (name === "list_chapter_budgets") return { data: structuredClone(budgets.slice(fields.p_page * 20, fields.p_page * 20 + 21)) };
  if (name === "save_chapter_budget") { const next = { id: `budget-${budgets.length}`, title: fields.p_title, period_start: fields.p_period_start, period_end: fields.p_period_end, notes: fields.p_notes, items: fields.p_items, revision: 1 }; budgets.unshift(next); return { data: next }; }
  if (name === "save_chapter_financial_document") {
    const next = { id: fields.p_id || `doc-${documents.length}`, kind: fields.p_kind, title: fields.p_title, body: fields.p_body, status: fields.p_status, revision: fields.p_revision + 1 };
    const at = documents.findIndex(d => d.id === next.id);
    if (at >= 0) documents[at] = next; else documents.push(next);
    return { data: next };
  }
  if (name === "submit_chapter_financial_request") { const next = { id: `request-${requests.length}`, revision: 1, subject_id: fields.p_subject, subject_name: fields.p_subject === "member" ? "Fictional member" : "Fictional Mira", kind: fields.p_kind, title: fields.p_title, description: fields.p_description, amount: fields.p_amount, status: "pending", decision_note: "" }; requests.push(next); return { data: next }; }
  if (name === "decide_chapter_financial_request") { const next = requests.find(r => r.id === fields.p_id); Object.assign(next, { status: fields.p_decision, decision_note: fields.p_note, revision: next.revision + 1 }); return { data: next }; }
  return { error: { message: "Unexpected fixture RPC" } };
} };
await loadLanguage(lang);
document.documentElement.lang = lang;
function Example() {
  const [role, setRole] = React.useState("member");
  return <><ChapterOfficeRoleChoice roles={["treasurer"]} selectedHat={role} onSelect={(next) => { activeRole = next; setRole(next); }}/><ChapterFinancePanel key={role} client={client} scope={{ organizationId: "org", chapterId: "chapter" }} memberId="member" canAuthor={role === "treasurer"}/><ChapterBudgetPanel key={`budgets-${role}`} client={client} scope={{ organizationId: "org", chapterId: "chapter" }} canAuthor={role === "treasurer"}/></>;
}
createRoot(document.getElementById("root")).render(<LanguageProvider lang={lang}><main className="sg-app institutional" data-workspace-theme="union-ground" style={{ background: "var(--canvas)", minHeight: "100vh", maxWidth: 1000, margin: "auto", padding: 16 }}><h1>Fictional finance regression fixture</h1><Example/></main></LanguageProvider>);
