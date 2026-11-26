import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ChapterFinancePanel } from "../src/features/finance/ChapterFinancePanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { chapterFinanceCatalogue } from "../src/lib/i18n/chapterFinance.js";

const scope = { organizationId: "org", chapterId: "campaign" };
const pendingRequest = {
  id: "request", title: "Supplies", kind: "expense", amount: 12, status: "pending",
  subject_id: "member", description: "Meeting supplies", revision: 1,
};

function renderFinances({ language = "en", canAuthor = false, name, error, documents = [] }) {
  const workspace = {
    ...scope, canDocuments: canAuthor, canRecords: canAuthor, canPublish: canAuthor,
    canRoster: false, canSubmit: true, documents, requests: canAuthor ? [pendingRequest] : [],
  };
  const rpc = vi.fn(async (called) => {
    if (called === name) {
      if (error instanceof Error) throw error;
      return { error };
    }
    if (called === "get_chapter_finance_workspace") return { data: workspace };
    throw new Error(`Unexpected RPC: ${called}`);
  });
  render(<LanguageProvider lang={language}>
    <ChapterFinancePanel client={{ rpc }} scope={scope} memberId="member" canAuthor={canAuthor} />
  </LanguageProvider>);
  return rpc;
}

it.each([
  ["en", "42501", "step-up required", "Sign in with your password or passkey to do that."],
  ["es", "42501", "step-up required", "Inicia sesión con tu contraseña o llave de acceso para hacer eso."],
  ["en", "42501", "chapter finance context required", "Check your sign-in and selected campaign."],
  ["en", "42501", "finance attribution access required", "You do not have access to make this change in this campaign."],
  ["en", "42501", "active chapter member required", "This request must be for an active campaign worker."],
  ["en", "22023", "invalid financial request", "Check “Title”, “Purpose and details”, and “Amount (USD)”."],
  ["es", "22023", "invalid financial request", "Revisa «Título», «Motivo y detalles» e «Importe (USD)»."],
  ["en", "42501", "unknown finance refusal", "We could not confirm that your request was sent. Check your requests before you send it again."],
  ["es", "42501", "unknown finance refusal", "No pudimos confirmar que se envió tu solicitud. Revisa tus solicitudes antes de enviarla otra vez."],
  ["es", null, null, "Se cortó la conexión, así que no pudimos confirmar si se guardó. Revisa si se envió antes de volver a intentarlo."],
])("shows the request refusal inside the form and keeps the draft (%s, %s, %s)", async (language, code, message, notice) => {
  const name = "submit_chapter_financial_request";
  const rpc = renderFinances({
    language, name, error: code ? { code, message } : new TypeError("Failed to fetch"),
  });
  const submit = await screen.findByRole("button", { name: t(language, "finance.submitRequest") });
  const form = within(submit.closest("form"));
  const title = form.getByLabelText(t(language, "finance.titleLabel"));
  const description = form.getByLabelText(t(language, "finance.description"));
  const amount = form.getByLabelText(t(language, "finance.amount"));
  fireEvent.change(title, { target: { value: "Meeting" } });
  fireEvent.change(description, { target: { value: "Fictional receipt" } });
  fireEvent.change(amount, { target: { value: "12" } });
  fireEvent.submit(submit.closest("form"));

  expect(await form.findByRole("alert")).toHaveTextContent(notice);
  expect(submit).toHaveAccessibleDescription(notice);
  expect(title).toHaveValue("Meeting");
  expect(description).toHaveValue("Fictional receipt");
  expect(amount).toHaveValue(12);
  expect(rpc).toHaveBeenCalledWith(name, expect.objectContaining({ p_title: "Meeting", p_amount: 12 }));
});

it.each([
  ["en", "PT409", "financial document conflict", "Somebody changed this first. Reload the list and try again."],
  ["en", "40001", "financial document conflict", "Somebody changed this first. Reload the list and try again."],
  ["en", "42501", "financial publication access required", "You do not have access to make this change in this campaign."],
  ["en", "42501", "budget unavailable", "Choose an available budget from this campaign."],
  ["en", "22023", "invalid financial document", "Check “Document type”, “Title”, “Report or notice”, and “Publication”."],
  ["es", "22023", "invalid financial document", "Revisa «Tipo de documento», «Título», «Informe o aviso» y «Publicación»."],
  ["en", "22023", "budget kind required", "Choose the Budget document type to include a budget snapshot."],
  ["en", "42501", "unknown finance refusal", "We could not confirm that your document was saved. Check your financial documents before you save it again."],
  ["es", "42501", "unknown finance refusal", "No pudimos confirmar que se guardó tu documento. Revisa tus documentos financieros antes de guardarlo otra vez."],
])("shows a document save refusal inside its editor (%s, %s, %s)", async (language, code, message, notice) => {
  renderFinances({ language, canAuthor: true, name: "save_chapter_financial_document", error: { code, message } });
  const create = await screen.findByRole("button", { name: t(language, "finance.newDocument") });
  fireEvent.click(create);
  const save = screen.getByRole("button", { name: t(language, "finance.save") });
  const form = within(save.closest("form"));
  const body = form.getByLabelText(t(language, "finance.body"));
  fireEvent.change(body, { target: { value: "Draft report" } });
  fireEvent.submit(save.closest("form"));
  expect(await form.findByRole("alert")).toHaveTextContent(notice);
  expect(save).toHaveAccessibleDescription(notice);
  expect(body).toHaveValue("Draft report");
  fireEvent.click(form.getByRole("button", { name: t(language, "finance.cancel") }));
  fireEvent.click(create);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("clears an old document alert when switching directly between editors", async () => {
  renderFinances({
    canAuthor: true, name: "save_chapter_financial_document",
    error: { code: "22023", message: "invalid financial document" },
    documents: [{ id: "doc", title: "Existing document", body: "A draft", kind: "financial_report", status: "draft", revision: 1 }],
  });
  const create = await screen.findByRole("button", { name: "New financial document" });
  const edit = screen.getByRole("button", { name: "Edit financial document" });
  const save = () => screen.getByRole("button", { name: "Save financial document" });
  for (const [open, switchTo] of [[create, edit], [edit, create]]) {
    fireEvent.click(open);
    fireEvent.submit(save().closest("form"));
    await screen.findByRole("alert");
    fireEvent.click(switchTo);
    fireEvent.click(open);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(save()).not.toHaveAttribute("aria-describedby");
  }
});

it.each([
  ["en", "22023", "invalid financial decision", "Choose a decision and enter its reason."],
  ["en", "42501", "unknown finance refusal", "We could not confirm that your decision was recorded. Check the request before you record it again."],
  ["es", "42501", "unknown finance refusal", "No pudimos confirmar que se registró tu decisión. Revisa la solicitud antes de registrarla otra vez."],
])("shows a refused decision beside the decision it concerns (%s, %s, %s)", async (language, code, message, notice) => {
  renderFinances({
    language, canAuthor: true, name: "decide_chapter_financial_request", error: { code, message },
  });
  const decide = await screen.findByRole("button", { name: t(language, "finance.recordDecision") });
  const form = within(decide.closest("form"));
  const note = form.getByLabelText(t(language, "finance.decisionNote"));
  fireEvent.change(note, { target: { value: "Needs another receipt" } });
  fireEvent.submit(decide.closest("form"));
  expect(await form.findByRole("alert")).toHaveTextContent(notice);
  expect(decide).toHaveAccessibleDescription(notice);
  expect(note).toHaveValue("Needs another receipt");
  const request = screen.getByRole("button", { name: t(language, "finance.submitRequest") }).closest("form");
  expect(within(request).queryByRole("alert")).not.toBeInTheDocument();
});

it("gives an unavailable workspace a load-only message and retry", async () => {
  renderFinances({ name: "get_chapter_finance_workspace", error: { code: "42501", message: "chapter finance context required" } });
  expect(await screen.findByRole("alert")).toHaveTextContent("Campaign finances could not be loaded.");
  expect(screen.getByRole("alert")).not.toHaveTextContent("saved");
  expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
});

it("defines the finance refusal and load notices directly in both languages", () => {
  const { en, es } = chapterFinanceCatalogue;
  for (const notice of [
    "loadFailed", "requestUnconfirmed", "documentUnconfirmed", "decisionUnconfirmed",
    "contextRequired", "accessRequired", "activeMemberRequired", "budgetUnavailable",
    "budgetKindRequired", "invalidRequest", "invalidDocument", "invalidDecision",
  ]) {
    const key = `finance.${notice}`;
    expect(en[key]).toBeTruthy();
    expect(es[key]).toBeTruthy();
    expect(es[key]).not.toBe(en[key]);
  }
});
