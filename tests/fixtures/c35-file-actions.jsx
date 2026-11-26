import { createRoot } from "react-dom/client";
import { CasesView } from "../../src/views/CasesView.jsx";
import { CoordinatorView } from "../../src/views/CoordinatorView.jsx";
import { TaskModal } from "../../src/views/TaskModal.jsx";
import { FormFilingControls } from "../../src/components/FormFilingControls.jsx";
import { KnowledgeWorkspacePanel } from "../../src/features/knowledge/KnowledgeWorkspacePanel.jsx";
import { LanguageProvider } from "../../src/lib/LanguageContext.jsx";
import { loadLanguage, t as translate } from "../../src/lib/i18n.js";
import { fallbackData } from "./retired-pre-bot/src/data/fallback.js";
import "../../src/sg-tokens.css";
import "../../src/styles.css";
import "../../src/coordinator-theme.css";
import "../../src/components/workspacePages.css";

const params = new URLSearchParams(location.search);
const lang = params.get("lang") === "es" ? "es" : "en";
await loadLanguage(lang);
document.documentElement.lang = lang;
const t = (key, vars) => translate(lang, key, vars);
const files = ["agenda.pdf", "minutes.pdf"].map((filename, index) => ({ id: `tamarack-file-${index}`, filename, sizeBytes: 1024, confirmedAt: "2026-11-08T12:00:00-05:00", scanCurrent: false }));
const row = { id: "tamarack-case", reference: "TAM-1", title: "Tamarack agenda", status: "active", step: "Review", articles: "", updates: [], files };
const task = { ...fallbackData.tasks[0], id: "tamarack-task", title: "Tamarack agenda" };
const stale = async () => { throw Object.assign(new Error("stale"), { privateFileCode: "stale" }); };
const seed = structuredClone(fallbackData.coordinatorDesk);
seed.cases = [{ ...seed.cases[0], ...row, memberName: "Alex Rivera" }];
const api = { loadDesk: async () => seed, loadCases: async () => ({ cases: seed.cases, nextCursor: null }), openCaseFile: stale, removeCaseFile: async () => {}, recheckCaseFile: async () => {} };
const library = [...files.map((file) => ({ id: file.id, title: "Tamarack", fileName: file.filename, category: "forms", reviewStatus: "pending", indexStatus: "unset" })), ...files.map((file) => ({ id: `approved-${file.id}`, title: "Tamarack", fileName: `approved-${file.filename}`, category: "forms", reviewStatus: "approved", indexStatus: "unset", publishedToCatalog: false }))];
const client = { rpc: async (name) => {
  if (name.startsWith("download_")) return { data: null, error: { code: "42501", message: "file inspection required" } };
  const data = name === "list_resource_catalog_page" ? library.slice(0, 2) : name === "list_steward_library_files_page" ? library : name === "get_google_drive_activation" ? { status: "unset", connected: false } : [];
  return { data, error: null };
} };
let content;
switch (params.get("surface")) {
  case "case": content = <CasesView data={{ cases: [row] }} onOpenCaseFile={stale} onRemoveCaseFile={async () => {}} onRecheckCaseFile={async () => {}} />; break;
  case "coordinator": content = <CoordinatorView data={{ member: { id: "tamarack-author", initials: "AR" } }} api={api} />; break;
  case "task": content = <TaskModal task={task} chapterId="tamarack" files={files} lang={lang} t={t} onClose={() => {}} onUpdate={() => {}} onOpenFile={stale} onRecheckFile={async () => {}} onRemoveFile={async () => {}} />; break;
  case "knowledge": content = <KnowledgeWorkspacePanel client={client} canStaff canAdmin articles={[]} />; break;
  default: content = <FormFilingControls files={files} editable t={(key, vars) => t(`forms.filing.${key}`, vars)} onOpenFile={stale} onRemoveFile={async () => {}} onRecheckFile={async () => {}} />;
}
createRoot(document.getElementById("root")).render(<LanguageProvider lang={lang}><main className={innerWidth >= 1000 ? "sg-app sg-app--desktop" : "sg-app"} data-workspace-theme="union-ground" style={{ display: "block", colorScheme: "light", padding: 16, width: "100%", boxSizing: "border-box" }}><h1>Tamarack</h1>{content}</main></LanguageProvider>);
