import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { CasesView } from "../src/views/CasesView.jsx";
import { StewardView } from "../src/views/StewardView.jsx";
import { CaseworkHubPanel } from "../src/components/CaseworkHubPanel.jsx";

const TYPES = [
  ["Discipline", "Disciplina"], ["Scheduling", "Horarios"],
  ["Telework", "Teletrabajo"], ["Safety", "Seguridad"],
  ["Pay", "Salario"], ["Other", "Otro"], ["Tamarack custom category", "Tamarack custom category"],
];
const memberCase = type => ({ id: "tamarack-type", reference: "GR-TYPE", title: "Tamarack case title", type, status: "active", step: "Step 1", deadlineValue: "", updates: [], files: [], articles: "Article 7" });

it.each(TYPES)("keeps %s consistent in member detail across a language change", (type, spanish) => {
  const item = memberCase(type);
  const onUpdateCase = vi.fn();
  const view = lang => <LanguageProvider lang={lang}><CasesView data={{ cases: [item] }} onUpdateCase={onUpdateCase} /></LanguageProvider>;
  const { rerender } = render(view("es"));
  fireEvent.click(screen.getByRole("button", { name: /Tamarack case title/ }));
  // The worker's issue detail names the type only: contract articles are left out.
  expect(screen.getByRole("dialog").querySelector(".case-detail-copy").textContent).toBe(spanish);
  rerender(view("en"));
  expect(screen.getByRole("dialog").querySelector(".case-detail-copy").textContent).toBe(type);
  expect(screen.getByRole("dialog")).toHaveTextContent("Tamarack case title");
  expect(item.type).toBe(type);
  expect(onUpdateCase).not.toHaveBeenCalled();
});

it.each(TYPES)("keeps %s consistent from the Spanish steward list to facts", async (type, spanish) => {
  const item = { ...memberCase(type), caseType: type, memberName: "Tamarack colleague", memberInitials: "TC" };
  const api = { loadDesk: vi.fn().mockResolvedValue({ caseload: [item], queue: [], threads: [], broadcasts: [], formsInbox: [], formTemplateVersions: [], kpis: {} }) };
  const view = lang => <LanguageProvider lang={lang}><StewardView data={{ member: { initials: "TS" } }} api={api} /></LanguageProvider>;
  const { rerender } = render(view("es"));
  const row = await screen.findByRole("button", { name: /GR-TYPE/ });
  expect(row.closest("tr")).toHaveTextContent(spanish);
  fireEvent.click(row);
  expect(within(await screen.findByRole("dialog")).getByText(spanish, { selector: "dd" })).toBeInTheDocument();
  rerender(view("en"));
  await waitFor(() => expect(within(screen.getByRole("dialog")).getByText(type, { selector: "dd" })).toBeInTheDocument());
  expect(item.caseType).toBe(type);
});

it("updates all canonical history types on language change and preserves custom prose", async () => {
  const rows = TYPES.map(([type], i) => ({ id: `tamarack-${i}`, reference: `GR-${i}`, title: "Stored Tamarack title", case_type: type, step: "Step 1", status: "active", is_restricted: false }));
  const api = {
    loadCaseworkHub: vi.fn().mockResolvedValue({ workspaces: [], drafts: [], patterns: [], templates: [] }),
    loadCaseworkHistory: vi.fn().mockResolvedValue({ rows, total: rows.length, page: 0, pageSize: 50 }),
  };
  const view = lang => <LanguageProvider lang={lang}><CaseworkHubPanel chapterId="tamarack-chapter" caseOptions={[]} api={api} /></LanguageProvider>;
  const { container, rerender } = render(view("es"));
  await waitFor(() => expect(container.querySelectorAll("#casework-hub-history .cwk-meta")).toHaveLength(TYPES.length));
  // Grievance steps are left out of this edition, so the meta is the type alone.
  expect([...container.querySelectorAll("#casework-hub-history .cwk-meta")].map(n => n.textContent)).toEqual(TYPES.map(([, spanish]) => spanish));
  rerender(view("en"));
  await waitFor(() => expect([...container.querySelectorAll("#casework-hub-history .cwk-meta")].map(n => n.textContent)).toEqual(TYPES.map(([type]) => type)));
  expect(rows.map(row => row.case_type)).toEqual(TYPES.map(([type]) => type));
  expect(container).toHaveTextContent("Stored Tamarack title");
});
