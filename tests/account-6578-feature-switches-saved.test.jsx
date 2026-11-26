import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdminSecurityConfiguration } from "../src/components/AdminSecurityConfiguration.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";

// REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030, finding 88: saving
// a feature switch showed only a "Changed" badge once the toast faded. The
// saved row now keeps a visible confirmation line until it is edited again.

const configuration = {
  settings: [
    { key: "security.failed_login_retention_days", kind: "integer", label: "Failed sign-in retention", description: "Days to retain records.", value: 90, defaultValue: 90, minimum: 7, maximum: 365 },
    { key: "security.session_window_days", kind: "integer", label: "Session window", description: "Days before renewal.", value: 45, defaultValue: 30, minimum: 1, maximum: 90, overridden: true },
  ],
  labelKeys: [],
  labelOverrides: {},
};

function renderSurface(lang = "en", apiOverrides = {}) {
  const api = {
    updateOrganizationSetting: vi.fn().mockResolvedValue({ updated: true }),
    resetOrganizationSetting: vi.fn().mockResolvedValue({ updated: true }),
    updateOrganizationLabel: vi.fn(),
    loadFailedLoginInbox: vi.fn().mockResolvedValue({ items: [] }),
    dispositionFailedLoginAttempt: vi.fn(),
    ...apiOverrides,
  };
  const onNotice = vi.fn();
  const view = render(<LanguageProvider lang={lang}><AdminSecurityConfiguration configuration={configuration} failedLoginInbox={{ items: [] }} api={api} reload={vi.fn()} onNotice={onNotice} /></LanguageProvider>);
  return { ...view, api, onNotice };
}

const label = (lang, key) => catalogue[lang][`settings.def.${key}.label`] ?? configuration.settings.find((item) => item.key === key).label;
const rowFor = (container, key) => container.querySelector(`[data-setting-key="${key}"]`);
const inputFor = (container, key) => within(rowFor(container, key)).getByRole("spinbutton");

describe("feature switches save confirmation (#6578 finding 88)", () => {
  it.each(["en", "es"])("keeps a saved line on the saved row until it is edited again (%s)", async (lang) => {
    const { container, onNotice } = renderSurface(lang);
    const input = inputFor(container, "security.failed_login_retention_days");
    const row = rowFor(container, "security.failed_login_retention_days");
    expect(within(row).queryByTestId("admin-setting-confirmed")).toBeNull();
    fireEvent.change(input, { target: { value: "120" } });
    fireEvent.click(within(row).getAllByRole("button")[0]);
    const line = await within(row).findByTestId("admin-setting-confirmed");
    expect(line).toHaveTextContent(catalogue[lang]["admin.config.saved"]);
    expect(onNotice).toHaveBeenCalledWith(catalogue[lang]["admin.config.saved"]);
    // Only the saved row says so.
    const other = rowFor(container, "security.session_window_days");
    expect(within(other).queryByTestId("admin-setting-confirmed")).toBeNull();
    fireEvent.change(input, { target: { value: "130" } });
    expect(within(row).queryByTestId("admin-setting-confirmed")).toBeNull();
  });

  it("confirms a reset on its row and clears the line when another row is written", async () => {
    const { container } = renderSurface("en");
    const windowRow = rowFor(container, "security.session_window_days");
    fireEvent.click(within(windowRow).getByRole("button", { name: /^Use the default for/ }));
    const line = await within(windowRow).findByTestId("admin-setting-confirmed");
    expect(line).toHaveTextContent(catalogue.en["admin.config.resetDone"].replace("{label}", label("en", "security.session_window_days")));
    // Editing a different row leaves this row's confirmation alone.
    const retention = inputFor(container, "security.failed_login_retention_days");
    fireEvent.change(retention, { target: { value: "100" } });
    expect(within(windowRow).getByTestId("admin-setting-confirmed")).toBeInTheDocument();
    fireEvent.click(within(retention.closest(".xus-config-row")).getAllByRole("button")[0]);
    await waitFor(() => expect(within(windowRow).queryByTestId("admin-setting-confirmed")).toBeNull());
    expect(await within(retention.closest(".xus-config-row")).findByTestId("admin-setting-confirmed")).toBeInTheDocument();
  });

  it("shows no saved line when the save is refused", async () => {
    const { container } = renderSurface("en", { updateOrganizationSetting: vi.fn().mockRejectedValue(new Error("refused")) });
    const input = inputFor(container, "security.failed_login_retention_days");
    fireEvent.change(input, { target: { value: "120" } });
    fireEvent.click(within(input.closest(".xus-config-row")).getAllByRole("button")[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent(catalogue.en["admin.config.failed"]);
    expect(screen.queryByTestId("admin-setting-confirmed")).toBeNull();
  });
});
