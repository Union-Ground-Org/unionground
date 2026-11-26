// UX-UG-LIMITS-NEVER-STATED-BEFORE-THEY-ARE-TRIPPED-20261122 (#9467):
// a limit is said next to its field before the person trips it. Website
// slice: the signature pad (W3b-10), Continue a saved form (W3b-17), Start a
// new case and editing its articles (W8-11), case desk notes and intake
// (W2-8), and nominations (W5-4).
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_STROKES, SignaturePad } from "../src/components/SignaturePad.jsx";
import { OrganizationHtmlForms } from "../src/components/OrganizationHtmlForms.jsx";
import { CaseDetailsFields } from "../src/features/caseIntake/CaseDetailsFields.jsx";
import { CaseArticlesEditor } from "../src/features/caseIntake/CaseArticlesEditor.jsx";
import { BallotNominations } from "../src/features/elections/BallotNominations.jsx";
import { NOMINATIONS_PER_BALLOT_MAX } from "../src/features/elections/nominationsApi.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";

const wrap = (ui, lang = "en") => render(<LanguageProvider lang={lang}>{ui}</LanguageProvider>);

afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

describe("W3b-10 the signature pad says on screen when it is full", () => {
  function Pad({ capStatus }) {
    const [value, setValue] = useState([]);
    return <SignaturePad value={value} onChange={setValue} label="Draw your signature" instructions="Use pointer or keyboard."
      clearLabel="Clear signature" emptyStatus="No signature drawn." strokeStatus={(count) => `Signature strokes: ${count}`} capStatus={capStatus} />;
  }

  it.each(["en", "es"])("shows the full-box line under the pad, outside the hidden status, until Clear, in %s", (lang) => {
    const capStatus = t(lang, "forms.filing.signatureCapReached");
    expect(capStatus).toMatch(lang === "en" ? /full\. Clear it and sign again\./ : /lleno\. Bórralo y vuelve a firmar\./);
    const { container } = render(<Pad capStatus={capStatus} />);
    const canvas = screen.getByLabelText("Draw your signature");
    for (let i = 0; i < MAX_STROKES; i += 1) { fireEvent.keyDown(canvas, { key: " " }); fireEvent.keyDown(canvas, { key: " " }); }
    expect([...container.querySelectorAll("p")].some((node) => node.textContent === capStatus)).toBe(false);
    fireEvent.keyDown(canvas, { key: " " });
    const shown = [...container.querySelectorAll("p")].find((node) => node.textContent === capStatus);
    expect(shown).toBeTruthy();
    expect(shown.closest(".sr-only")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(capStatus);
    fireEvent.click(screen.getByRole("button", { name: "Clear signature" }));
    expect([...container.querySelectorAll("p")].some((node) => node.textContent === capStatus)).toBe(false);
  });

  it("words the co-signature pad the same way in both languages", () => {
    expect(t("en", "forms.cosign.signatureCapReached")).toBe("This co-signature box is full. Clear it and sign again.");
    expect(t("es", "forms.cosign.signatureCapReached")).toBe("El cuadro de co-firma está lleno. Bórralo y vuelve a firmar.");
  });
});

describe("W3b-17 Continue a saved form says what file it takes and refuses under the picker", () => {
  it.each([
    ["en", "Choose an HTML file you saved from Union Ground, up to 16 MB."],
    ["es", "Elige un archivo HTML que guardaste desde Union Ground, de hasta 16 MB."],
  ])("before a file is chosen, and a refusal lands after the picker, in %s", async (lang, hint) => {
    const api = { listOrganizationFormDocuments: vi.fn(async () => [{ id: "f-1", title: "Grievance form", version: 1 }]), getOrganizationFormDocument: vi.fn() };
    const { container } = wrap(<OrganizationHtmlForms api={api} />, lang);
    await screen.findByText("Grievance form");
    const input = container.querySelector("input[type=file]");
    expect(input).toHaveAccessibleDescription(hint);
    const big = new File(["x"], "big.html", { type: "text/html" });
    Object.defineProperty(big, "size", { value: 17 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(lang === "en" ? "That saved form is larger than 16 MB." : "Ese formulario guardado pesa más de 16 MB.");
    expect(input.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("list").compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("W8-11 Start a new case states the remedy limit", () => {
  // The worker's own new-issue form carries no contract-articles box in this
  // edition (contract articles are left out), so only the remedy limit is
  // stated there.
  it.each([
    ["en", "Up to 2,000 characters."],
    ["es", "Hasta 2.000 caracteres."],
  ])("under the remedy box, in %s", (lang, remedy) => {
    wrap(<form><CaseDetailsFields own /></form>, lang);
    expect(screen.queryByLabelText(t(lang, "cases.contractArticles"))).toBeNull();
    const remedyBox = screen.getByLabelText(t(lang, "caseIntake.remedy"));
    expect(remedyBox).toHaveAccessibleDescription(`${t(lang, "caseIntake.remedyHelpOwn")} ${remedy}`);
    expect(remedyBox).toHaveAttribute("maxLength", "2000");
    fireEvent.input(remedyBox, { target: { value: "a".repeat(1600) } });
    expect(remedyBox).toHaveAccessibleDescription(lang === "en" ? /1,600 of 2,000 characters/ : /1\.600 de 2\.000 caracteres/);
    act(() => remedyBox.form.reset());
    expect(remedyBox).toHaveValue("");
  });
});

describe("W8-11 the staff article editor shows both field limits", () => {
  it.each([
    ["en", "Up to 500 characters.", "Up to 1,000 characters.", "800 of 1,000 characters."],
    ["es", "Hasta 500 caracteres.", "Hasta 1.000 caracteres.", "800 de 1.000 caracteres."],
  ])("describes articles and counts and resets the change reason in %s", async (lang, articles, reason, count) => {
    wrap(<CaseArticlesEditor item={{ id: "c-1" }} onUpdate={vi.fn()} />, lang);
    expect(screen.getByLabelText(t(lang, "cases.contractArticles"))).toHaveAccessibleDescription(expect.stringContaining(articles));
    const reasonBox = screen.getByLabelText(t(lang, "coordinator.changeReason"));
    expect(reasonBox).toHaveAccessibleDescription(reason);
    fireEvent.input(reasonBox, { target: { value: "a".repeat(800) } });
    expect(reasonBox).toHaveAccessibleDescription(count);
    await act(async () => { reasonBox.form.reset(); });
    expect(reasonBox).toHaveValue("");
    expect(reasonBox).toHaveAccessibleDescription(reason);
  });

  it.each([
    ["en", "420 of 500 characters."],
    ["es", "420 de 500 caracteres."],
  ])("counts the existing articles draft when the editor opens in %s", (lang, count) => {
    wrap(<CaseArticlesEditor item={{ id: "c-1", articles: "a".repeat(420) }} onUpdate={vi.fn()} />, lang);
    const articles = screen.getByLabelText(t(lang, "cases.contractArticles"));
    expect(articles).toHaveAccessibleDescription(expect.stringContaining(count));
  });
});

describe("W5-4 nominations state how many one member may make", () => {
  const client = { rpc: vi.fn(async (name) => (name === "get_open_ballot_nominations"
    ? { data: [{ ballotId: "b-1", title: "Officer election", titleEs: "Elección", nominationsCloseAt: "2099-12-01T23:00:00.000Z", nominations: [] }], error: null }
    : { data: null, error: { code: "PGRST202", message: name } })) };

  it.each([
    ["en", "Each worker can make up to 10 nominations for each ballot."],
    ["es", "Cada trabajador puede hacer hasta 10 nominaciones en cada votación."],
  ])("as the rule on the card, in %s", async (lang, cap) => {
    wrap(<BallotNominations client={client} />, lang);
    const card = await screen.findByRole("region", { name: t(lang, "nominations.title") });
    expect(within(card).getByText(new RegExp(cap.replace(/\./g, "\\.")))).toBeInTheDocument();
  });

  it("uses the server's own number", () => {
    const sql = readFileSync("supabase/migrations/20261030214501_ballot_nominations_and_minutes_approval.sql", "utf8");
    const server = sql.match(/n\.nominated_by = caller\) >= ([0-9]+) then\s+raise exception 'nomination limit reached'/);
    expect(server).not.toBeNull();
    expect(NOMINATIONS_PER_BALLOT_MAX).toBe(Number(server[1]));
  });
});
