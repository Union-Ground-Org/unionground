// #9466 (W3a-11, W4-12): the outcome is said beside the control that was
// pressed (the setting's row, the campaign editor), not at the
// top or foot of the page, and it is announced.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminSecurityConfiguration } from "../src/components/AdminSecurityConfiguration.jsx";
import { CampaignsView } from "../src/views/CampaignsView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n/allLanguages.js";

afterEach(cleanup);
const en = catalogue.en;
const inLang = (ui, lang = "en") => render(<LanguageProvider lang={lang}>{ui}</LanguageProvider>);

describe("an organization setting that fails to save (W3a-11)", () => {
  const setting = (key, label, value) => ({ key, kind: "integer", label, description: "Days.", value, defaultValue: value, minimum: 1, maximum: 365 });
  const configuration = { settings: [setting("security.session_window_days", "Session window", 30), setting("security.failed_login_retention_days", "Failed sign-in retention", 90)], labelKeys: [], labelOverrides: {} };
  const inbox = { openLast24Hours: 0, attentionThreshold: 5, items: [] };

  it("says so in the row whose Save was pressed, not at the top of the card", async () => {
    const api = { setOrganizationSetting: vi.fn().mockRejectedValue(new Error("offline")), updateOrganizationLabel: vi.fn(), loadFailedLoginInbox: vi.fn().mockResolvedValue(inbox), dispositionFailedLoginAttempt: vi.fn() };
    inLang(<AdminSecurityConfiguration configuration={configuration} failedLoginInbox={inbox} api={api} reload={vi.fn()} onNotice={vi.fn()} />);
    const field = screen.getByRole("spinbutton", { name: "Failed sign-in retention" });
    const row = field.closest(".xus-config-row");
    fireEvent.change(field, { target: { value: "120" } });
    fireEvent.click(within(row).getByRole("button", { name: en["admin.config.saveName"].replace("{label}", "Failed sign-in retention") }));
    expect(await within(row).findByRole("alert")).toHaveTextContent(en["admin.config.failed"]);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });
});

describe("a campaign draft that fails to save (W4-12)", () => {
  const draft = { id: "ballot-draft", kind: "ballot", scope: "chapter", chapterId: "wor", titleEn: "Contract vote", titleEs: "Votación del contrato", bodyEn: "", bodyEs: "", closesAt: new Date(Date.now() + 86400000).toISOString(), quorumTarget: 125, state: "draft", active: false, options: [{ id: "yes", labelEn: "Yes", labelEs: "Sí", orderIndex: 1 }, { id: "no", labelEn: "No", labelEs: "No", orderIndex: 2 }] };

  it("says so in the editor, above Save, and a new draft starts clear", async () => {
    const api = { load: vi.fn().mockResolvedValue({ campaigns: [draft], canManageUnion: false, chapterId: "wor" }), saveDraft: vi.fn().mockRejectedValue(new Error("offline")) };
    inLang(<CampaignsView api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Contract vote" }));
    const save = screen.getByRole("button", { name: en["campaigns.saveDraft"] });
    fireEvent.click(save);
    const alert = await within(save.closest("form")).findByRole("alert");
    expect(alert).toHaveTextContent(en["campaigns.saveError"]);
    expect(alert.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: en["campaigns.cancel"] }));
    fireEvent.click(screen.getByRole("button", { name: "New campaign" }));
    expect(screen.queryByText(en["campaigns.saveError"])).toBeNull();
  });

  it("holds New campaign during an edit save, keeps the refused edit, then opens a clean draft", async () => {
    let failSlowly;
    const saveDraft = vi.fn(() => new Promise((_, reject) => { failSlowly = reject; }));
    inLang(<CampaignsView api={{ load: vi.fn().mockResolvedValue({ campaigns: [draft], canManageUnion: false, chapterId: "wor" }), saveDraft }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Contract vote" }));
    const edit = screen.getByRole("heading", { name: en["campaigns.editor.edit"] }).closest("form");
    const title = within(edit).getByLabelText(en["campaigns.titleEn"]);
    fireEvent.change(title, { target: { value: "Updated contract vote" } });
    const save = within(edit).getByRole("button", { name: en["campaigns.saveDraft"] });
    fireEvent.click(save);
    expect(saveDraft).toHaveBeenCalledTimes(1);

    const newCampaign = screen.getByRole("button", { name: en["campaigns.new"] });
    expect(newCampaign).toHaveAttribute("aria-busy", "true");
    expect(newCampaign).toHaveAttribute("aria-disabled", "true");
    expect(newCampaign).toHaveAccessibleDescription(en["campaigns.saving"]);
    expect(within(newCampaign.parentElement).getByText(en["campaigns.saving"])).toBeVisible();
    fireEvent.click(newCampaign);
    expect(screen.queryByRole("heading", { name: en["campaigns.editor.new"] })).not.toBeInTheDocument();

    await act(async () => { failSlowly(new Error("offline")); });
    expect(within(save.parentElement).getByRole("alert")).toHaveTextContent(en["campaigns.saveError"]);
    expect(title).toHaveValue("Updated contract vote");
    expect(newCampaign).not.toHaveAttribute("aria-disabled");

    fireEvent.click(screen.getByRole("button", { name: "Edit Contract vote" }));
    expect(screen.queryByText(en["campaigns.saveError"])).toBeNull();
    fireEvent.click(newCampaign);
    const fresh = screen.getByRole("heading", { name: en["campaigns.editor.new"] }).closest("form");
    expect(within(fresh).getByLabelText(en["campaigns.titleEn"])).toHaveValue("");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
