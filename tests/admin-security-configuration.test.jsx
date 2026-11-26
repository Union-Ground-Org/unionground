import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdminSecurityConfiguration } from "../src/components/AdminSecurityConfiguration.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { expectHeldWriteFocus, expectOneWriteFromOneTick, expectReadyRetryAfterThrowAtOnce } from "./helpers/busyWriteFocus.js";

// Union Ground leaves passkey, SSO, member PIN, dues-reminder, ULP,
// starter-procedure and membership-card wallet settings out of the web UI
// (owner decisions); their rows may still arrive from the shared registry and
// must never render. The boolean row the tests drive is the recovery-code
// switch, which Union Ground keeps.
const LEFT_OUT_ROWS = [
  ["features.passkey_enrollment", "Member passkey enrollment"],
  ["features.home.passkey_nudge", "Home passkey suggestion"],
  ["features.security.member_pin_signin", "Member PIN sign-in"],
  ["features.security.member_pin_restricted_sessions", "Member PIN restricted sessions"],
  ["features.security.sso", "Single sign-on"],
  ["features.notifications.dues_reminders", "Dues reminders"],
  ["limits.notifications.dues_reminder_days_past_due", "Dues reminder delay (days past due)"],
  ["features.casework.ulp_deadline", "ULP deadline tracking"],
  ["features.casework.starter_procedure_template", "Starter grievance procedure"],
  ["casework.ulp.filing_window_days", "ULP filing window"],
  ["features.integrations.google_wallet_pass", "Save to Google Wallet on the membership card"],
].map(([key, label]) => ({ key, kind: "boolean", label, description: `${label} switch.`, value: true, defaultValue: true, minimum: null, maximum: null }));

const configuration = {
  settings: [
    {
      key: "features.mfa_recovery_code_enrollment",
      kind: "boolean",
      label: "Recovery code enrollment",
      description: "Allow members to generate recovery codes.",
      value: true,
      defaultValue: true,
      minimum: null,
      maximum: null,
    },
    {
      key: "security.failed_login_retention_days",
      kind: "integer",
      label: "Failed sign-in retention",
      description: "Days to retain records.",
      value: 90,
      defaultValue: 90,
      minimum: 7,
      maximum: 365,
    },
    {
      key: "security.session_window_days",
      kind: "integer",
      label: "Session window",
      description: "Days before a session must be renewed.",
      value: 30,
      defaultValue: 30,
      minimum: 1,
      maximum: 90,
    },
  ],
  labelKeys: ["nav.home", "nav.tasks"],
  labelOverrides: {},
};

const failedLoginInbox = {
  openLast24Hours: 6,
  attentionThreshold: 5,
  items: [{
    id: "30000000-0000-4000-8000-000000000003",
    memberName: "Former member",
    memberReference: "A1B2C3",
    method: "password",
    source: "web-saas",
    userAgent: "Test Browser/1.0",
    status: "open",
    dispositionNote: null,
    occurredAt: "2026-08-28T16:00:00.000Z",
    reviewedAt: null,
  }],
};

function renderSurface(apiOverrides = {}, lang = "en") {
  const api = {
    updateOrganizationSetting: vi.fn().mockResolvedValue({ updated: true }),
    updateOrganizationLabel: vi.fn().mockResolvedValue({ updated: true }),
    loadFailedLoginInbox: vi.fn().mockResolvedValue({ ...failedLoginInbox, items: [] }),
    dispositionFailedLoginAttempt: vi.fn().mockResolvedValue({ updated: true }),
    ...apiOverrides,
  };
  const reload = vi.fn();
  const onNotice = vi.fn();
  const rendered = render(
    <LanguageProvider lang={lang}>
      <AdminSecurityConfiguration
        configuration={configuration}
        failedLoginInbox={failedLoginInbox}
        api={api}
        reload={reload}
        onNotice={onNotice}
      />
    </LanguageProvider>,
  );
  return { ...rendered, api, reload, onNotice };
}

// SEC-UG-PASSWORD-SIGNIN-THROTTLE-20261001: the sign-in limits are
// platform-wide (the database refuses organization values), so the row shows
// the value and why, with no input or Save that could never succeed.
describe("platform-wide sign-in limits", () => {
  const platformRows = [
    { key: "limits.security.signin_attempts_per_email_hour", kind: "integer", label: "Password sign-in attempts per address per hour", description: "Platform-wide.", value: 5, defaultValue: 5, minimum: 1, maximum: 100 },
    { key: "limits.security.signin_attempts_per_ip_hour", kind: "integer", label: "Password sign-in attempts per network per hour", description: "Platform-wide.", value: 20, defaultValue: 20, minimum: 1, maximum: 1000 },
  ];

  for (const lang of ["en", "es"]) {
    it(`shows them read-only with their value and reason (${lang})`, () => {
      const { container } = render(
        <LanguageProvider lang={lang}>
          <AdminSecurityConfiguration
            configuration={{ ...configuration, settings: [...configuration.settings, ...platformRows] }}
            failedLoginInbox={failedLoginInbox}
            api={{ updateOrganizationSetting: vi.fn(), updateOrganizationLabel: vi.fn(), loadFailedLoginInbox: vi.fn().mockResolvedValue({ items: [] }), dispositionFailedLoginAttempt: vi.fn() }}
            reload={vi.fn()}
            onNotice={vi.fn()}
          />
        </LanguageProvider>,
      );
      for (const [row, value] of [[platformRows[0], "5"], [platformRows[1], "20"]]) {
        // The Feature switches & limits page names rows from the EN/ES
        // catalogue (settings.def.<key>.label), the DB label is the fallback.
        const element = within(container.querySelector("#admin-configuration")).getByText(catalogue[lang][`settings.def.${row.key}.label`]).closest(".xus-config-row");
        expect(within(element).queryByRole("spinbutton")).toBeNull();
        expect(within(element).queryByRole("button")).toBeNull();
        expect(element).toHaveTextContent(value);
        expect(element).toHaveTextContent(catalogue[lang]["admin.config.platformWide"]);
      }
      // An ordinary organization setting keeps its control.
      expect(within(container.querySelector("#admin-configuration")).getByRole("spinbutton", { name: catalogue[lang]["settings.def.security.failed_login_retention_days.label"] })).toBeInTheDocument();
    });
  }
});

describe("organization security configuration admin surface", () => {
  it("never renders a left-out setting row, by key or by label, in either language", () => {
    for (const lang of ["en", "es"]) {
      const { container, unmount } = render(
        <LanguageProvider lang={lang}>
          <AdminSecurityConfiguration
            configuration={{ ...configuration, settings: [...configuration.settings, ...LEFT_OUT_ROWS] }}
            failedLoginInbox={failedLoginInbox}
            api={{ updateOrganizationSetting: vi.fn(), updateOrganizationLabel: vi.fn(), loadFailedLoginInbox: vi.fn().mockResolvedValue({ items: [] }), dispositionFailedLoginAttempt: vi.fn() }}
            reload={vi.fn()}
            onNotice={vi.fn()}
          />
        </LanguageProvider>,
      );
      const card = container.querySelector("#admin-configuration");
      for (const row of LEFT_OUT_ROWS) {
        expect(card.querySelector(`[data-setting-key="${row.key}"]`), row.key).toBeNull();
        expect(within(card).queryByText(row.label), row.label).toBeNull();
        const catalogueLabel = catalogue[lang][`settings.def.${row.key}.label`];
        if (catalogueLabel) expect(within(card).queryByText(catalogueLabel), catalogueLabel).toBeNull();
      }
      // The kept switch still renders beside them.
      expect(card.querySelector('[data-setting-key="features.mfa_recovery_code_enrollment"]')).not.toBeNull();
      unmount();
    }
  });

  it("persists typed setting values through the bounded setting API", async () => {
    const { container, api } = renderSurface();
    const card = container.querySelector("#admin-configuration");
    const recoveryRow = screen.getByText("Recovery code enrollment").closest(".xus-config-row");
    fireEvent.click(within(recoveryRow).getByRole("checkbox"));
    fireEvent.click(within(recoveryRow).getByRole("button", { name: /^Save Recovery code enrollment/ }));
    await waitFor(() => expect(api.updateOrganizationSetting).toHaveBeenCalledWith(
      "features.mfa_recovery_code_enrollment", false,
    ));

    const retention = within(card).getByRole("spinbutton", { name: "Failed sign-in retention" });
    fireEvent.change(retention, { target: { value: "120" } });
    fireEvent.click(within(retention.closest(".xus-config-row")).getByRole("button", { name: /^Save Failed sign-in retention/ }));
    await waitFor(() => expect(api.updateOrganizationSetting).toHaveBeenCalledWith(
      "security.failed_login_retention_days", 120,
    ));
  });

  // BUG-UG-STEWARD-DEADLINE-REMINDERS-20261001: the switch and window the
  // 20261002021000 registry rows add render as ordinary controls here.
  it("shows the steward deadline reminder switch and window as editable controls", async () => {
    const steward = [
      {
        key: "features.notifications.steward_deadline_reminders", kind: "boolean", label: "Steward deadline reminders",
        description: "Warn the assigned steward and coordinator when a case deadline is close. Member deadline notices are not affected.",
        value: true, defaultValue: true, minimum: null, maximum: null,
      },
      {
        key: "limits.notifications.steward_deadline_reminder_days", kind: "integer", label: "Steward deadline warning window (days)",
        description: "How many days before a case deadline the assigned steward and coordinator are first warned.",
        value: 3, defaultValue: 3, minimum: 1, maximum: 30,
      },
    ];
    const api = {
      updateOrganizationSetting: vi.fn().mockResolvedValue({ updated: true }),
      updateOrganizationLabel: vi.fn(),
      loadFailedLoginInbox: vi.fn().mockResolvedValue({ ...failedLoginInbox, items: [] }),
      dispositionFailedLoginAttempt: vi.fn(),
    };
    render(
      <LanguageProvider lang="en">
        <AdminSecurityConfiguration
          configuration={{ ...configuration, settings: [...configuration.settings, ...steward] }}
          failedLoginInbox={failedLoginInbox}
          api={api}
          reload={vi.fn()}
          onNotice={vi.fn()}
        />
      </LanguageProvider>,
    );
    const switchRow = screen.getByText("Steward deadline reminders").closest(".xus-config-row");
    expect(within(switchRow).getByRole("checkbox")).toBeChecked();
    fireEvent.click(within(switchRow).getByRole("checkbox"));
    fireEvent.click(within(switchRow).getByRole("button", { name: /^Save Steward deadline reminders/ }));
    await waitFor(() => expect(api.updateOrganizationSetting).toHaveBeenCalledWith("features.notifications.steward_deadline_reminders", false));
    const windowInput = screen.getByRole("spinbutton", { name: "Steward deadline warning window (days)" });
    expect(windowInput).toHaveAttribute("min", "1");
    expect(windowInput).toHaveAttribute("max", "30");
    fireEvent.change(windowInput, { target: { value: "5" } });
    fireEvent.click(within(windowInput.closest(".xus-config-row")).getByRole("button", { name: /^Save Steward deadline warning window/ }));
    await waitFor(() => expect(api.updateOrganizationSetting).toHaveBeenCalledWith("limits.notifications.steward_deadline_reminder_days", 5));
  });

  it("saves and clears only an allowlisted label key", async () => {
    const { container, api } = renderSurface();
    const card = container.querySelector("#admin-labels");
    const input = within(card).getByRole("textbox", { name: /Home/ });
    // REQ-UG-CHAPTER-UNITS-WORKSITES-AND-LOCAL-PROFILE-20261030: one Save for every changed label.
    expect(within(card).getByRole("button", { name: "Save labels" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "Start" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save labels" }));
    await waitFor(() => expect(api.updateOrganizationLabel).toHaveBeenCalledWith("nav.home", "Start"));
    expect(api.updateOrganizationLabel).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save labels" }));
    await waitFor(() => expect(api.updateOrganizationLabel).toHaveBeenLastCalledWith("nav.home", ""));
  });

  // BUG-UG-ADMIN-LABELS-EDITOR-SHOWS-RAW-KEYS-20261106: every field
  // used to read "Home (nav.home)", "chapter (term.chapter)".
  it("names each label field by its label alone, never its internal key", () => {
    const { container } = renderSurface();
    const card = container.querySelector("#admin-labels");
    expect(card.textContent).not.toMatch(/\((term|nav)\.[A-Za-z]+\)/);
    expect(within(card).getByRole("textbox", { name: "Home" })).toBeInTheDocument();
    expect(within(card).getByRole("textbox", { name: "campaign" })).toBeInTheDocument();
    expect(card.querySelector('.xus-label-row[data-label-key="nav.home"] input')).toBe(within(card).getByRole("textbox", { name: "Home" }));
  });

  it("keeps dirty drafts and adopts new server values for clean fields after a sibling save reload", async () => {
    const surface = renderSurface();
    const configurationCard = surface.container.querySelector("#admin-configuration");
    const labelsCard = surface.container.querySelector("#admin-labels");
    const retention = within(configurationCard).getByRole("spinbutton", { name: "Failed sign-in retention" });
    const home = within(labelsCard).getByRole("textbox", { name: /Home/ });
    fireEvent.change(retention, { target: { value: "120" } });
    fireEvent.change(home, { target: { value: "Start" } });

    const recoveryRow = screen.getByText("Recovery code enrollment").closest(".xus-config-row");
    fireEvent.click(within(recoveryRow).getByRole("checkbox"));
    fireEvent.click(within(recoveryRow).getByRole("button", { name: /^Save Recovery code enrollment/ }));
    await waitFor(() => expect(surface.reload).toHaveBeenCalled());

    const reloaded = {
      ...configuration,
      settings: configuration.settings.map((setting) => setting.key === "features.mfa_recovery_code_enrollment"
        ? { ...setting, value: false }
        : setting.key === "security.session_window_days" ? { ...setting, value: 45 } : setting),
      labelOverrides: { "nav.tasks": "Work list" },
    };
    surface.rerender(
      <LanguageProvider lang="en">
        <AdminSecurityConfiguration
          configuration={reloaded}
          failedLoginInbox={failedLoginInbox}
          api={surface.api}
          reload={surface.reload}
          onNotice={surface.onNotice}
        />
      </LanguageProvider>,
    );

    expect(within(configurationCard).getByRole("spinbutton", { name: "Failed sign-in retention" })).toHaveValue(120);
    expect(within(configurationCard).getByRole("spinbutton", { name: "Session window" })).toHaveValue(45);
    expect(within(labelsCard).getByRole("textbox", { name: /Home/ })).toHaveValue("Start");
    expect(within(labelsCard).getByRole("textbox", { name: /Tasks/ })).toHaveValue("Work list");
  });

  // Two administrators edit the same limit. The second
  // one's save is made over the read they typed on, so the server refuses it
  // instead of overwriting the first one's newer value unseen; their value
  // stays in the field, the newer saved value is shown, and the next save
  // replaces it knowingly.
  it("refuses a save typed over an older read than another administrator's newer value, and keeps the typed value", async () => {
    const OLD = "2026-11-15T08:00:00.000Z";
    const NEW = "2026-11-15T08:05:00.000Z";
    const withRetention = (value, updatedAt) => ({
      ...configuration,
      settings: configuration.settings.map((setting) => (setting.key === "security.failed_login_retention_days" ? { ...setting, value, updatedAt } : setting)),
    });
    const stale = Object.assign(new Error("stale"), { code: "40001" });
    const api = {
      setOrganizationSetting: vi.fn().mockRejectedValueOnce(stale).mockResolvedValue({ updated: true }),
      updateOrganizationLabel: vi.fn(), loadFailedLoginInbox: vi.fn().mockResolvedValue({ ...failedLoginInbox, items: [] }), dispositionFailedLoginAttempt: vi.fn(),
    };
    const page = (config) => <LanguageProvider lang="en"><AdminSecurityConfiguration configuration={config} failedLoginInbox={failedLoginInbox} api={api} reload={vi.fn()} onNotice={vi.fn()} /></LanguageProvider>;
    const view = render(page(withRetention(90, OLD)));
    const field = () => screen.getByRole("spinbutton", { name: "Failed sign-in retention" });
    fireEvent.change(field(), { target: { value: "120" } });
    // The other administrator saves 200; a refresh brings it while 120 is still unsaved.
    view.rerender(page(withRetention(200, NEW)));
    expect(field()).toHaveValue(120);
    expect(screen.getByTestId("admin-setting-stale")).toHaveTextContent("Another administrator saved 200 after you started typing.");
    expect(field().getAttribute("aria-describedby")).toContain("-stale");

    const row = field().closest(".xus-config-row");
    fireEvent.click(within(row).getByRole("button", { name: /^Save Failed sign-in retention/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Another administrator changed this setting, so nothing was saved."));
    expect(api.setOrganizationSetting).toHaveBeenLastCalledWith("security.failed_login_retention_days", 120, OLD);
    expect(field()).toHaveValue(120);
    expect(screen.getByTestId("admin-setting-stale")).toHaveTextContent("200");

    // Told, the administrator saves again over the value on screen.
    fireEvent.click(within(row).getByRole("button", { name: /^Save Failed sign-in retention/ }));
    await waitFor(() => expect(api.setOrganizationSetting).toHaveBeenCalledTimes(2));
    expect(api.setOrganizationSetting).toHaveBeenLastCalledWith("security.failed_login_retention_days", 120, NEW);
  });

  // After a refusal the next Save goes out against the
  // version on screen, and a reset always does. A refresh that lands just
  // before that click must not let it replace a value the administrator has
  // not read: the click sends nothing, the row names the new value, and the
  // next deliberate click goes out. No timers: the refresh is a rerender.
  //  review P1-1: "seen" starts at the version on screen when the row is
  // first shown on this page (and again after a remount), so the first click
  // on a row is held too when a refresh moved it before that click.
  describe("a row whose version moved since the administrator's last click", () => {
    const KEY = "security.failed_login_retention_days";
    const V1 = "2026-11-15T08:00:00.000Z";
    const V2 = "2026-11-15T08:05:00.000Z";
    const V3 = "2026-11-15T08:05:01.000Z";
    const withRetention = (value, updatedAt, overridden = false) => ({
      ...configuration,
      settings: configuration.settings.map((setting) => (setting.key === KEY ? { ...setting, value, updatedAt, overridden } : setting)),
    });
    const stale = () => Object.assign(new Error("stale"), { code: "40001" });
    function surface(apiOverrides, first, lang = "en") {
      const api = {
        updateOrganizationLabel: vi.fn(), loadFailedLoginInbox: vi.fn().mockResolvedValue({ ...failedLoginInbox, items: [] }), dispositionFailedLoginAttempt: vi.fn(),
        ...apiOverrides,
      };
      // mountKey: a new key remounts the card, as leaving the page and coming back does.
      const page = (config, mountKey = "first") => <LanguageProvider lang={lang}><AdminSecurityConfiguration key={mountKey} configuration={config} failedLoginInbox={failedLoginInbox} api={api} reload={vi.fn()} onNotice={vi.fn()} /></LanguageProvider>;
      const view = render(page(first));
      const copy = catalogue[lang];
      const label = lang === "en" ? "Failed sign-in retention" : copy["settings.def.security.failed_login_retention_days.label"];
      const field = () => screen.getByRole("spinbutton", { name: label });
      const row = () => field().closest(".xus-config-row");
      const save = () => fireEvent.click(within(row()).getByRole("button", { name: copy["admin.config.saveName"].replace("{label}", label) }));
      const reset = () => fireEvent.click(within(row()).getByRole("button", { name: copy["admin.config.resetName"].replace("{label}", label) }));
      return { view, page, copy, field, row, save, reset };
    }

    it.each(["en", "es"])("holds the Save after a refusal when a refresh lands before the click, names the new value, and sends on the next Save (%s)", async (lang) => {
      const setOrganizationSetting = vi.fn().mockRejectedValueOnce(stale()).mockResolvedValue({ updated: true, updatedAt: "2026-11-15T08:06:00.000Z" });
      const { view, page, copy, field, save } = surface({ setOrganizationSetting }, withRetention(90, V1), lang);
      fireEvent.change(field(), { target: { value: "120" } });
      save();
      // Another administrator had saved in between: refused, nothing written.
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(copy["admin.config.conflict"]));
      expect(setOrganizationSetting).toHaveBeenLastCalledWith(KEY, 120, V1);
      // When the refresh lands after the
      // refusal, the next click is held and names the new value (below), so the
      // banner says so instead of promising that one more Save is enough.
      expect(copy["admin.config.conflict"]).toMatch(lang === "en" ? /If the row then says the setting changed just now, select it once more to replace it\.$/ : /Si la fila dice entonces que el ajuste acaba de cambiar, selecciónalo una vez más para reemplazarlo\.$/);

      // The refresh after the refusal lands a moment before the next click.
      view.rerender(page(withRetention(200, V2)));
      save();
      expect(setOrganizationSetting).toHaveBeenCalledTimes(1);
      const notice = screen.getByTestId("admin-setting-moved");
      expect(notice).toHaveTextContent(copy["admin.config.movedBeforeSave"].replace("{value}", "200"));
      expect(notice).toHaveAttribute("role", "alert");
      expect(field()).toHaveValue(120);
      expect(field().getAttribute("aria-describedby").split(" ")).toContain(notice.id);

      // The second, deliberate Save goes out over the value now on screen.
      save();
      await waitFor(() => expect(setOrganizationSetting).toHaveBeenCalledTimes(2));
      expect(setOrganizationSetting).toHaveBeenLastCalledWith(KEY, 120, V2);
      expect(screen.queryByTestId("admin-setting-moved")).toBeNull();
    });

    it("holds again when the version moves once more after the notice", async () => {
      const setOrganizationSetting = vi.fn().mockRejectedValueOnce(stale()).mockResolvedValue({ updated: true });
      const { view, page, field, save } = surface({ setOrganizationSetting }, withRetention(90, V1));
      fireEvent.change(field(), { target: { value: "120" } });
      save();
      await waitFor(() => expect(setOrganizationSetting).toHaveBeenCalledTimes(1));
      view.rerender(page(withRetention(200, V2)));
      save();
      expect(screen.getByTestId("admin-setting-moved")).toHaveTextContent("200");
      view.rerender(page(withRetention(250, V3)));
      save();
      expect(setOrganizationSetting).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("admin-setting-moved")).toHaveTextContent("250");
      save();
      await waitFor(() => expect(setOrganizationSetting).toHaveBeenCalledTimes(2));
      expect(setOrganizationSetting).toHaveBeenLastCalledWith(KEY, 120, V3);
    });

    it("clears the notice when the administrator edits the field", async () => {
      const setOrganizationSetting = vi.fn().mockRejectedValueOnce(stale()).mockResolvedValue({ updated: true });
      const { view, page, field, save } = surface({ setOrganizationSetting }, withRetention(90, V1));
      fireEvent.change(field(), { target: { value: "120" } });
      save();
      await waitFor(() => expect(setOrganizationSetting).toHaveBeenCalledTimes(1));
      view.rerender(page(withRetention(200, V2)));
      save();
      expect(screen.getByTestId("admin-setting-moved")).toBeInTheDocument();
      fireEvent.change(field(), { target: { value: "130" } });
      expect(screen.queryByTestId("admin-setting-moved")).toBeNull();
    });

    it.each(["en", "es"])("holds a reset the same way after a refusal (%s)", async (lang) => {
      const resetOrganizationSetting = vi.fn().mockRejectedValueOnce(stale()).mockResolvedValue({ key: KEY, value: 90, overridden: false, updatedAt: null, updated: true });
      const { view, page, copy, reset } = surface({ setOrganizationSetting: vi.fn(), resetOrganizationSetting }, withRetention(120, V1, true), lang);
      reset();
      await waitFor(() => expect(resetOrganizationSetting).toHaveBeenCalledWith(KEY, V1));
      view.rerender(page(withRetention(200, V2, true)));
      reset();
      expect(resetOrganizationSetting).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("admin-setting-moved")).toHaveTextContent(copy["admin.config.movedBeforeReset"].replace("{value}", "200"));
      reset();
      await waitFor(() => expect(resetOrganizationSetting).toHaveBeenCalledTimes(2));
      expect(resetOrganizationSetting).toHaveBeenLastCalledWith(KEY, V2);
    });

    it("never holds a click after the administrator's own save once its refresh lands", async () => {
      const OWN = "2026-11-15T08:06:00.000Z";
      const setOrganizationSetting = vi.fn().mockResolvedValue({ updated: true, updatedAt: OWN });
      const resetOrganizationSetting = vi.fn().mockResolvedValue({ key: KEY, value: 90, overridden: false, updatedAt: null, updated: true });
      const { view, page, field, save, reset } = surface({ setOrganizationSetting, resetOrganizationSetting }, withRetention(90, V1));
      fireEvent.change(field(), { target: { value: "120" } });
      save();
      await waitFor(() => expect(setOrganizationSetting).toHaveBeenCalledWith(KEY, 120, V1));
      view.rerender(page(withRetention(120, OWN, true)));
      reset();
      await waitFor(() => expect(resetOrganizationSetting).toHaveBeenCalledWith(KEY, OWN));
      expect(screen.queryByTestId("admin-setting-moved")).toBeNull();
    });

    it.each(["en", "es"])("holds the first reset of a row when a refresh moved it after it was shown, then sends on the next click (%s)", async (lang) => {
      const resetOrganizationSetting = vi.fn().mockResolvedValue({ key: KEY, value: 90, overridden: false, updatedAt: null, updated: true });
      const { view, page, copy, reset } = surface({ setOrganizationSetting: vi.fn(), resetOrganizationSetting }, withRetention(120, V1, true), lang);
      view.rerender(page(withRetention(200, V2, true)));
      reset();
      expect(resetOrganizationSetting).not.toHaveBeenCalled();
      expect(screen.getByTestId("admin-setting-moved")).toHaveTextContent(copy["admin.config.movedBeforeReset"].replace("{value}", "200"));
      reset();
      await waitFor(() => expect(resetOrganizationSetting).toHaveBeenCalledTimes(1));
      expect(resetOrganizationSetting).toHaveBeenLastCalledWith(KEY, V2);
    });

    it("sends a first reset at once when nothing moved since the row was shown", async () => {
      const resetOrganizationSetting = vi.fn().mockResolvedValue({ key: KEY, value: 90, overridden: false, updatedAt: null, updated: true });
      const { reset } = surface({ setOrganizationSetting: vi.fn(), resetOrganizationSetting }, withRetention(120, V1, true));
      reset();
      await waitFor(() => expect(resetOrganizationSetting).toHaveBeenCalledWith(KEY, V1));
      expect(screen.queryByTestId("admin-setting-moved")).toBeNull();
    });

    it("after leaving the page and coming back, holds a first click whose row moved since it came back", async () => {
      const resetOrganizationSetting = vi.fn().mockResolvedValue({ key: KEY, value: 90, overridden: false, updatedAt: null, updated: true });
      const { view, page, reset } = surface({ setOrganizationSetting: vi.fn(), resetOrganizationSetting }, withRetention(120, V1, true));
      view.rerender(page(withRetention(120, V1, true), "second"));
      view.rerender(page(withRetention(200, V2, true), "second"));
      reset();
      expect(resetOrganizationSetting).not.toHaveBeenCalled();
      expect(screen.getByTestId("admin-setting-moved")).toHaveTextContent("200");
      reset();
      await waitFor(() => expect(resetOrganizationSetting).toHaveBeenCalledWith(KEY, V2));
    });

    it("after a refresh, then leaving the page and coming back, measures from the value shown on return", async () => {
      const resetOrganizationSetting = vi.fn().mockResolvedValue({ key: KEY, value: 90, overridden: false, updatedAt: null, updated: true });
      const { view, page, reset } = surface({ setOrganizationSetting: vi.fn(), resetOrganizationSetting }, withRetention(120, V1, true));
      view.rerender(page(withRetention(200, V2, true)));
      // Away and back: the page comes back showing 200, which is what the administrator now reads.
      view.rerender(page(withRetention(200, V2, true), "second"));
      reset();
      await waitFor(() => expect(resetOrganizationSetting).toHaveBeenCalledWith(KEY, V2));
      expect(screen.queryByTestId("admin-setting-moved")).toBeNull();
    });

    //  review P3-2: between the administrator's own save and its refresh,
    // the screen shows the read from before their save. That is not someone
    // else's change: no hold, and the reset goes out against their own write.
    it("does not hold a reset in the gap after the administrator's own save, and sends it against that save", async () => {
      const OWN = "2026-11-15T08:06:00.000Z";
      const setOrganizationSetting = vi.fn().mockResolvedValue({ updated: true, updatedAt: OWN });
      const resetOrganizationSetting = vi.fn().mockResolvedValue({ key: KEY, value: 90, overridden: false, updatedAt: null, updated: true });
      const { field, save, reset } = surface({ setOrganizationSetting, resetOrganizationSetting }, withRetention(120, V1, true));
      fireEvent.change(field(), { target: { value: "150" } });
      save();
      await waitFor(() => expect(setOrganizationSetting).toHaveBeenCalledWith(KEY, 150, V1));
      await waitFor(() => expect(screen.getByTestId("admin-setting-confirmed")).toBeInTheDocument());
      reset();
      await waitFor(() => expect(resetOrganizationSetting).toHaveBeenCalledWith(KEY, OWN));
      expect(screen.queryByTestId("admin-setting-moved")).toBeNull();
    });

    // The gap after the administrator's own save, with a
    // server that checks versions. Another administrator writes in that gap:
    // the reset goes out against the administrator's own write, the server
    // refuses it, and the other value is kept and announced, never overwritten.
    function versionedServer(start) {
      const stored = { ...start };
      const conflict = () => Object.assign(new Error("Save organization setting: setting changed"), { code: "40001" });
      return {
        stored,
        setOrganizationSetting: vi.fn(async (_key, value, expected) => {
          if (expected !== stored.version) throw conflict();
          Object.assign(stored, { value, version: `own-${value}` });
          return { updated: true, updatedAt: stored.version };
        }),
        resetOrganizationSetting: vi.fn(async (_key, expected) => {
          if (expected !== stored.version) throw conflict();
          Object.assign(stored, { value: 90, version: "own-reset" });
          return { key: KEY, value: 90, overridden: false, updatedAt: stored.version, updated: true };
        }),
      };
    }

    it("refuses a reset in the gap after the administrator's own save when another administrator wrote in between", async () => {
      const api = versionedServer({ value: 120, version: V1 });
      const { copy, field, save, reset } = surface(api, withRetention(120, V1, true));
      fireEvent.change(field(), { target: { value: "150" } });
      save();
      await waitFor(() => expect(api.stored.version).toBe("own-150"));
      // Another administrator saves 200 before this page's refresh lands.
      Object.assign(api.stored, { value: 200, version: "other-200" });
      reset();
      await waitFor(() => expect(api.resetOrganizationSetting).toHaveBeenCalledWith(KEY, "own-150"));
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(copy["admin.config.conflict"]));
      expect(api.stored).toEqual({ value: 200, version: "other-200" });
    });

    it("sends the next click at the version on screen after the administrator's own save was refused", async () => {
      const api = versionedServer({ value: 200, version: V2 });
      const { copy, field, save } = surface(api, withRetention(120, V1));
      fireEvent.change(field(), { target: { value: "150" } });
      save();
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(copy["admin.config.conflict"]));
      expect(api.setOrganizationSetting).toHaveBeenLastCalledWith(KEY, 150, V1);
      // The refresh has not landed: the screen still shows V1, which the administrator saw.
      save();
      await waitFor(() => expect(api.setOrganizationSetting).toHaveBeenCalledTimes(2));
      expect(api.setOrganizationSetting).toHaveBeenLastCalledWith(KEY, 150, V1);
      expect(screen.queryByTestId("admin-setting-moved")).toBeNull();
      expect(api.stored).toEqual({ value: 200, version: V2 });
    });

    // A row that first arrives in a read while a filter
    // hides it is seen only when the filter is cleared, so that first click is
    // not held for a version nobody had on screen.
    it("does not hold the first click on a row a filter hid from its first read until after a refresh", async () => {
      const resetOrganizationSetting = vi.fn().mockResolvedValue({ key: KEY, value: 90, overridden: false, updatedAt: null, updated: true });
      const withoutRetention = { ...configuration, settings: configuration.settings.filter((setting) => setting.key !== KEY) };
      const api = { setOrganizationSetting: vi.fn(), resetOrganizationSetting, updateOrganizationLabel: vi.fn(), loadFailedLoginInbox: vi.fn().mockResolvedValue({ ...failedLoginInbox, items: [] }), dispositionFailedLoginAttempt: vi.fn() };
      const page = (config) => <LanguageProvider lang="en"><AdminSecurityConfiguration configuration={config} failedLoginInbox={failedLoginInbox} api={api} reload={vi.fn()} onNotice={vi.fn()} /></LanguageProvider>;
      const view = render(page(withoutRetention));
      const search = screen.getByRole("searchbox", { name: "Search settings" });
      fireEvent.change(search, { target: { value: "Session window" } });
      // The row's first read arrives (V1) while the filter hides it, then a refresh brings V2.
      view.rerender(page(withRetention(120, V1, true)));
      expect(screen.queryByRole("spinbutton", { name: "Failed sign-in retention" })).toBeNull();
      view.rerender(page(withRetention(200, V2, true)));
      fireEvent.change(search, { target: { value: "" } });
      const row = screen.getByRole("spinbutton", { name: "Failed sign-in retention" }).closest(".xus-config-row");
      fireEvent.click(within(row).getByRole("button", { name: "Use the default for Failed sign-in retention" }));
      await waitFor(() => expect(resetOrganizationSetting).toHaveBeenCalledWith(KEY, V2));
      expect(screen.queryByTestId("admin-setting-moved")).toBeNull();
    });

    //  review P3-3: each row keeps its own notice.
    it("keeps one row's notice while another row saves", async () => {
      const setOrganizationSetting = vi.fn().mockResolvedValue({ updated: true });
      const resetOrganizationSetting = vi.fn();
      const { view, page, reset } = surface({ setOrganizationSetting, resetOrganizationSetting }, withRetention(120, V1, true));
      view.rerender(page(withRetention(200, V2, true)));
      reset();
      expect(screen.getByTestId("admin-setting-moved")).toHaveTextContent("200");
      const other = screen.getByRole("spinbutton", { name: "Session window" });
      fireEvent.change(other, { target: { value: "45" } });
      fireEvent.click(within(other.closest(".xus-config-row")).getByRole("button", { name: "Save Session window" }));
      await waitFor(() => expect(setOrganizationSetting).toHaveBeenCalledWith("security.session_window_days", 45, null));
      expect(screen.getByTestId("admin-setting-moved")).toHaveTextContent("200");
      expect(resetOrganizationSetting).not.toHaveBeenCalled();
    });
  });

  // An edit while the row's own save is in
  // flight (P1), and an edit after the administrator's own save or reset
  // before the refresh lands (P3).
  describe("drafts typed around the administrator's own save", () => {
    const KEY = "security.failed_login_retention_days";
    const T0 = "2026-11-15T08:00:00.000Z";
    const T1 = "2026-11-15T08:01:00.000Z";
    const T2 = "2026-11-15T08:02:00.000Z";
    const withRetention = (value, updatedAt, overridden = false) => ({
      ...configuration,
      settings: configuration.settings.map((setting) => (setting.key === KEY ? { ...setting, value, updatedAt, overridden } : setting)),
    });
    function surface(api, first) {
      const full = { updateOrganizationLabel: vi.fn(), loadFailedLoginInbox: vi.fn().mockResolvedValue({ ...failedLoginInbox, items: [] }), dispositionFailedLoginAttempt: vi.fn(), ...api };
      const page = (config) => <LanguageProvider lang="en"><AdminSecurityConfiguration configuration={config} failedLoginInbox={failedLoginInbox} api={full} reload={vi.fn()} onNotice={vi.fn()} /></LanguageProvider>;
      const view = render(page(first));
      const field = () => screen.getByRole("spinbutton", { name: "Failed sign-in retention" });
      const row = () => field().closest(".xus-config-row");
      const save = () => fireEvent.click(within(row()).getByRole("button", { name: /^Save Failed sign-in retention/ }));
      return { view, page, field, row, save };
    }

    it("keeps a draft typed during its own save based on that save, so a third administrator's newer value is shown and refused", async () => {
      let finish;
      const setOrganizationSetting = vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
        .mockResolvedValue({ updated: true });
      const { view, page, field, save } = surface({ setOrganizationSetting }, withRetention(90, T0));
      fireEvent.change(field(), { target: { value: "120" } });
      save();
      expect(setOrganizationSetting).toHaveBeenLastCalledWith(KEY, 120, T0);
      // Typed while the save is still in flight.
      fireEvent.change(field(), { target: { value: "130" } });
      await act(async () => { finish({ key: KEY, value: 120, updatedAt: T1, updated: true }); });
      // Before the refresh, no note names the pre-save value as
      // another administrator's.
      expect(screen.queryByTestId("admin-setting-stale")).toBeNull();
      // Another administrator saves 200 before the refresh lands.
      view.rerender(page(withRetention(200, T2, true)));
      expect(field()).toHaveValue(130);
      expect(screen.getByTestId("admin-setting-stale")).toHaveTextContent("Another administrator saved 200 after you started typing.");
      save();
      await waitFor(() => expect(setOrganizationSetting).toHaveBeenCalledTimes(2));
      // Sent over the administrator's own save, so the server refuses it.
      expect(setOrganizationSetting).toHaveBeenLastCalledWith(KEY, 130, T1);
    });

    it("never names the administrator's own saved value as another administrator's", async () => {
      const setOrganizationSetting = vi.fn().mockResolvedValueOnce({ key: KEY, value: 120, updatedAt: T1, updated: true }).mockResolvedValue({ updated: true });
      const { view, page, field, save } = surface({ setOrganizationSetting }, withRetention(90, T0));
      fireEvent.change(field(), { target: { value: "120" } });
      save();
      await waitFor(() => expect(setOrganizationSetting).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByTestId("admin-setting-confirmed")).toBeInTheDocument());
      // Typed before the refresh with the administrator's own 120 lands.
      fireEvent.change(field(), { target: { value: "125" } });
      // No "Another administrator saved 90" in that gap.
      expect(screen.queryByTestId("admin-setting-stale")).toBeNull();
      view.rerender(page(withRetention(120, T1, true)));
      expect(screen.queryByTestId("admin-setting-stale")).toBeNull();
      save();
      await waitFor(() => expect(setOrganizationSetting).toHaveBeenCalledTimes(2));
      expect(setOrganizationSetting).toHaveBeenLastCalledWith(KEY, 125, T1);
    });

    it("bases a draft kept through the administrator's own reset on that reset", async () => {
      const setOrganizationSetting = vi.fn().mockResolvedValue({ updated: true });
      const resetOrganizationSetting = vi.fn().mockResolvedValue({ key: KEY, value: 90, overridden: false, updatedAt: null, updated: true });
      const { view, page, field, row, save } = surface({ setOrganizationSetting, resetOrganizationSetting }, withRetention(120, T0, true));
      fireEvent.change(field(), { target: { value: "150" } });
      fireEvent.click(within(row()).getByRole("button", { name: "Use the default for Failed sign-in retention" }));
      await waitFor(() => expect(resetOrganizationSetting).toHaveBeenCalledWith(KEY, T0));
      await waitFor(() => expect(screen.getByTestId("admin-setting-confirmed")).toBeInTheDocument());
      view.rerender(page(withRetention(90, null, false)));
      expect(field()).toHaveValue(150);
      expect(screen.queryByTestId("admin-setting-stale")).toBeNull();
      save();
      await waitFor(() => expect(setOrganizationSetting).toHaveBeenCalledTimes(1));
      expect(setOrganizationSetting).toHaveBeenLastCalledWith(KEY, 150, null);
    });
  });

  it("BUG-UG-ADMIN-PLANE-RELOAD-DRAFT-LOSS-20260907 preserves an unsaved boolean draft across an unrelated snapshot", async () => {
    const surface = renderSurface();
    const configurationCard = surface.container.querySelector("#admin-configuration");
    const recoveryRow = screen.getByText("Recovery code enrollment").closest(".xus-config-row");
    const recovery = within(recoveryRow).getByRole("checkbox");
    fireEvent.click(recovery);
    expect(recovery).not.toBeChecked();

    const reloaded = {
      ...configuration,
      settings: configuration.settings.map((setting) => setting.key === "security.session_window_days"
        ? { ...setting, value: 45 }
        : setting),
    };
    surface.rerender(
      <LanguageProvider lang="en">
        <AdminSecurityConfiguration
          configuration={reloaded}
          failedLoginInbox={failedLoginInbox}
          api={surface.api}
          reload={surface.reload}
          onNotice={surface.onNotice}
        />
      </LanguageProvider>,
    );

    expect(configurationCard.querySelector("input[type=checkbox]")).not.toBeChecked();
    expect(within(configurationCard).getByRole("spinbutton", { name: "Session window" })).toHaveValue(45);
  });

  it("adopts the normalized label value after its own successful save", async () => {
    const surface = renderSurface();
    const labelsCard = surface.container.querySelector("#admin-labels");
    const home = within(labelsCard).getByRole("textbox", { name: /Home/ });
    fireEvent.change(home, { target: { value: "  Start   here " } });
    fireEvent.click(within(labelsCard).getByRole("button", { name: "Save labels" }));
    await waitFor(() => expect(surface.api.updateOrganizationLabel).toHaveBeenCalledWith("nav.home", "  Start   here "));

    surface.rerender(
      <LanguageProvider lang="en">
        <AdminSecurityConfiguration
          configuration={{ ...configuration, labelOverrides: { "nav.home": "Start here" } }}
          failedLoginInbox={failedLoginInbox}
          api={surface.api}
          reload={surface.reload}
          onNotice={surface.onNotice}
        />
      </LanguageProvider>,
    );

    expect(within(labelsCard).getByRole("textbox", { name: /Home/ })).toHaveValue("Start here");
  });

  it("adopts a reloaded integer value after its own string draft save", async () => {
    const surface = renderSurface();
    const configurationCard = surface.container.querySelector("#admin-configuration");
    const retention = within(configurationCard).getByRole("spinbutton", { name: "Failed sign-in retention" });
    fireEvent.change(retention, { target: { value: "120" } });
    fireEvent.click(within(retention.closest(".xus-config-row")).getByRole("button", { name: /^Save Failed sign-in retention/ }));
    await waitFor(() => expect(surface.api.updateOrganizationSetting).toHaveBeenCalledWith(
      "security.failed_login_retention_days", 120,
    ));

    surface.rerender(
      <LanguageProvider lang="en">
        <AdminSecurityConfiguration
          configuration={{
            ...configuration,
            settings: configuration.settings.map((item) => item.key === "security.failed_login_retention_days"
              ? { ...item, value: 200 } : item),
          }}
          failedLoginInbox={failedLoginInbox}
          api={surface.api}
          reload={surface.reload}
          onNotice={surface.onNotice}
        />
      </LanguageProvider>,
    );

    expect(within(configurationCard).getByRole("spinbutton", { name: "Failed sign-in retention" })).toHaveValue(200);
  });

  it("filters, requires a disposition note, and writes the exact tenant inbox record", async () => {
    const { container, api } = renderSurface();
    const card = container.querySelector("#admin-failed-logins");
    expect(within(card).getByText("6 open in 24 hours")).toBeInTheDocument();
    fireEvent.change(within(card).getByRole("combobox", { name: "Status" }), { target: { value: "reviewed" } });
    await waitFor(() => expect(api.loadFailedLoginInbox).toHaveBeenCalledWith("reviewed"));

    // Restore the open row through the filter seam, then disposition it.
    api.loadFailedLoginInbox.mockResolvedValueOnce(failedLoginInbox);
    fireEvent.change(within(card).getByRole("combobox", { name: "Status" }), { target: { value: "open" } });
    await screen.findByRole("textbox", { name: "Disposition note" });
    const markReviewed = within(card).getByRole("button", { name: "Mark reviewed" });
    expect(markReviewed).toBeDisabled();
    fireEvent.change(within(card).getByRole("textbox", { name: "Disposition note" }), {
      target: { value: "Confirmed member typo" },
    });
    fireEvent.click(markReviewed);
    await waitFor(() => expect(api.dispositionFailedLoginAttempt).toHaveBeenCalledWith(
      failedLoginInbox.items[0].id,
      "reviewed",
      "Confirmed member typo",
    ));
    expect(api.loadFailedLoginInbox).toHaveBeenLastCalledWith("open");
  });

  it("labels failed sign-in source and method tokens in the reader's language", () => {
    const attempt = failedLoginInbox.items[0];
    const inbox = {
      ...failedLoginInbox,
      items: [
        attempt,
        { ...attempt, id: "30000000-0000-4000-8000-000000000006", memberName: "Second web attempt", source: "web-sample" },
        { ...attempt, id: "30000000-0000-4000-8000-000000000007", memberName: "iPhone attempt", source: "native-ios" },
        { ...attempt, id: "30000000-0000-4000-8000-000000000008", memberName: "Android attempt", source: "native-android" },
        { ...attempt, id: "30000000-0000-4000-8000-000000000009", memberName: "Future source", method: "passkey", source: "kiosk" },
      ],
    };
    const view = (lang) => (
      <LanguageProvider lang={lang}>
        <AdminSecurityConfiguration configuration={configuration} failedLoginInbox={inbox} api={{ loadFailedLoginInbox: vi.fn() }} reload={vi.fn()} onNotice={vi.fn()} />
      </LanguageProvider>
    );
    const { container, rerender } = render(view("es"));
    const card = () => container.querySelector("#admin-failed-logins");
    expect(within(card()).getAllByText(/· Aplicación web · Contraseña/)).toHaveLength(2);
    expect(card().textContent).toContain("Aplicación para iPhone · Contraseña");
    expect(card().textContent).toContain("Aplicación para Android · Contraseña");
    // A source or method this release does not know stays readable as its
    // token. Union Ground has no passkey sign-in, so "passkey" is such a
    // token: it gets no translated label.
    expect(card().textContent).toContain("kiosk · passkey");
    expect(card().textContent).not.toContain("Llave de acceso");
    expect(card().textContent).not.toContain("web-saas");

    rerender(view("en"));
    expect(within(card()).getAllByText(/· Web app · Password/)).toHaveLength(2);
    expect(card().textContent).toContain("iPhone app · Password");
    expect(card().textContent).toContain("Android app · Password");
    expect(card().textContent).toContain("kiosk · passkey");
    expect(card().textContent).not.toContain("Passkey");
  });

  it("re-applies the active failed-login filter after a desk reload", async () => {
    const reviewed = { ...failedLoginInbox.items[0], id: "30000000-0000-4000-8000-000000000004", memberName: "Reviewed member", status: "reviewed" };
    const surface = renderSurface({
      loadFailedLoginInbox: vi.fn().mockResolvedValue({ ...failedLoginInbox, items: [reviewed] }),
    });
    const card = surface.container.querySelector("#admin-failed-logins");
    fireEvent.change(within(card).getByRole("combobox", { name: "Status" }), { target: { value: "reviewed" } });
    expect(await within(card).findByText("Reviewed member")).toBeInTheDocument();

    surface.rerender(
      <LanguageProvider lang="en">
        <AdminSecurityConfiguration
          configuration={configuration}
          failedLoginInbox={{ ...failedLoginInbox, items: [...failedLoginInbox.items, reviewed] }}
          api={surface.api}
          reload={surface.reload}
          onNotice={surface.onNotice}
        />
      </LanguageProvider>,
    );

    await waitFor(() => expect(surface.api.loadFailedLoginInbox).toHaveBeenCalledTimes(2));
    expect(within(card).getByText("Reviewed member")).toBeInTheDocument();
    expect(within(card).queryByText("Former member")).toBeNull();
  });

  it("BUG-UG-FAILED-LOGIN-INBOX-FILTER-REVERT-20260907 keeps the organization-wide attention count while showing filtered rows", async () => {
    const reviewed = { ...failedLoginInbox.items[0], id: "30000000-0000-4000-8000-000000000006", memberName: "Reviewed member", status: "reviewed" };
    const surface = renderSurface({
      loadFailedLoginInbox: vi.fn().mockResolvedValue({ ...failedLoginInbox, items: [reviewed], openLast24Hours: 6 }),
    });
    const card = surface.container.querySelector("#admin-failed-logins");
    fireEvent.change(within(card).getByRole("combobox", { name: "Status" }), { target: { value: "reviewed" } });

    expect(await within(card).findByText("Reviewed member")).toBeInTheDocument();
    expect(within(card).getByText("6 open in 24 hours")).toBeInTheDocument();
    expect(within(card).queryByText("Former member")).toBeNull();
  });

  it("adopts the reloaded inbox snapshot directly when the filter is all", async () => {
    const surface = renderSurface();
    const card = surface.container.querySelector("#admin-failed-logins");
    const reloaded = { ...failedLoginInbox, items: [{ ...failedLoginInbox.items[0], memberName: "Reloaded all" }] };

    surface.rerender(
      <LanguageProvider lang="en">
        <AdminSecurityConfiguration
          configuration={configuration}
          failedLoginInbox={reloaded}
          api={surface.api}
          reload={surface.reload}
          onNotice={surface.onNotice}
        />
      </LanguageProvider>,
    );

    expect(await within(card).findByText("Reloaded all")).toBeInTheDocument();
    expect(surface.api.loadFailedLoginInbox).not.toHaveBeenCalled();
  });

  it("A11Y-UG-ADMIN-FIELDS-HIDE-TWO-CHARACTER-MINIMUM-20260920 describes the disposition note's two-character minimum in both languages", () => {
    const english = renderSurface();
    const card = english.container.querySelector("#admin-failed-logins");
    const note = within(card).getByRole("textbox", { name: "Disposition note" });
    const help = within(card).getByText("Choose a reason, or write at least 2 characters, before you mark this sign-in reviewed or dismiss it. With a reason the note is optional.");
    expect(help.id).toBeTruthy();
    expect(note).toHaveAttribute("aria-describedby", help.id);

    // The help text is only honest if the guard matches it: one trimmed
    // character keeps both actions disabled and two enable them.
    fireEvent.change(note, { target: { value: " a " } });
    expect(within(card).getByRole("button", { name: "Mark reviewed" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Dismiss" })).toBeDisabled();
    fireEvent.change(note, { target: { value: "ab" } });
    expect(within(card).getByRole("button", { name: "Mark reviewed" })).toBeEnabled();
    expect(within(card).getByRole("button", { name: "Dismiss" })).toBeEnabled();

    english.unmount();
    const spanish = renderSurface({}, "es");
    const spanishCard = spanish.container.querySelector("#admin-failed-logins");
    const spanishNote = within(spanishCard).getByRole("textbox", { name: "Nota de resolución" });
    const spanishHelp = within(spanishCard).getByText("Elige un motivo o escribe al menos 2 caracteres antes de marcar este inicio como revisado o descartarlo. Con un motivo, la nota es opcional.");
    expect(spanishNote).toHaveAttribute("aria-describedby", spanishHelp.id);
  });

  // REQ-UG-FAILED-SIGNIN-PRESET-DISPOSITIONS-20261006.
  it("dismisses a failed sign-in with a preset reason and no typed note", async () => {
    const { container, api } = renderSurface();
    const card = container.querySelector("#admin-failed-logins");
    const dismiss = within(card).getByRole("button", { name: "Dismiss" });
    expect(dismiss).toBeDisabled();
    fireEvent.change(within(card).getByRole("combobox", { name: "Reason" }), { target: { value: "mistyped" } });
    expect(within(card).getByRole("textbox", { name: "Disposition note" })).toHaveValue("");
    expect(dismiss).toBeEnabled();
    expect(within(card).getByRole("button", { name: "Mark reviewed" })).toBeEnabled();
    fireEvent.click(dismiss);
    await waitFor(() => expect(api.dispositionFailedLoginAttempt).toHaveBeenCalledWith(
      failedLoginInbox.items[0].id, "dismissed", "Worker mistyped their password",
    ));
  });

  it("keeps free text optional but appended to the reason, within the server's 240 characters", async () => {
    const { container, api } = renderSurface();
    const card = container.querySelector("#admin-failed-logins");
    const note = within(card).getByRole("textbox", { name: "Disposition note" });
    fireEvent.change(note, { target: { value: "x".repeat(240) } });
    fireEvent.change(within(card).getByRole("combobox", { name: "Reason" }), { target: { value: "serverError" } });
    expect(note).toHaveAttribute("maxLength", "240");
    expect(note.value).toHaveLength(240);
    fireEvent.change(note, { target: { value: "  Hosted outage at 7 PM  " } });
    fireEvent.click(within(card).getByRole("button", { name: "Mark reviewed" }));
    await waitFor(() => expect(api.dispositionFailedLoginAttempt).toHaveBeenCalledWith(
      failedLoginInbox.items[0].id, "reviewed", "Server or sign-in error — Hosted outage at 7 PM",
    ));
  });

  it("keeps the full draft across language and reason changes and explains the saved limit", async () => {
    const api = {
      updateOrganizationSetting: vi.fn(), updateOrganizationLabel: vi.fn(),
      loadFailedLoginInbox: vi.fn().mockResolvedValue({ ...failedLoginInbox, items: [] }),
      dispositionFailedLoginAttempt: vi.fn().mockResolvedValue({ updated: true }),
    };
    const view = (lang) => <LanguageProvider lang={lang}><AdminSecurityConfiguration configuration={configuration} failedLoginInbox={failedLoginInbox} api={api} reload={vi.fn()} onNotice={vi.fn()} /></LanguageProvider>;
    const { container, rerender } = render(view("en"));
    const card = () => container.querySelector("#admin-failed-logins");
    fireEvent.change(within(card()).getByRole("combobox", { name: "Reason" }), { target: { value: "serverError" } });
    fireEvent.change(within(card()).getByRole("textbox", { name: "Disposition note" }), { target: { value: "y".repeat(214) } });
    rerender(view("es"));
    const spanishLimit = 240 - "Error del servidor o del inicio de sesión".length - " — ".length;
    await waitFor(() => expect(within(card()).getByRole("textbox", { name: "Nota de resolución" }).value).toHaveLength(214));
    expect(within(card()).getByRole("status")).toHaveTextContent(`Se guardarán solo los primeros ${spanishLimit} caracteres`);
    rerender(view("en"));
    const englishNote = within(card()).getByRole("textbox", { name: "Disposition note" });
    expect(englishNote).toHaveValue("y".repeat(214));
    expect(within(card()).queryByRole("status")).toBeNull();
    fireEvent.change(within(card()).getByRole("combobox", { name: "Reason" }), { target: { value: "mistyped" } });
    expect(englishNote).toHaveValue("y".repeat(214));
    expect(within(card()).getByRole("status")).toHaveTextContent("Your full draft is kept");
    fireEvent.change(within(card()).getByRole("combobox", { name: "Reason" }), { target: { value: "" } });
    expect(englishNote).toHaveValue("y".repeat(214));
    fireEvent.change(within(card()).getByRole("combobox", { name: "Reason" }), { target: { value: "serverError" } });
    rerender(view("es"));
    fireEvent.click(within(card()).getByRole("button", { name: "Marcar revisado" }));
    await waitFor(() => expect(api.dispositionFailedLoginAttempt).toHaveBeenCalledTimes(1));
    const note = api.dispositionFailedLoginAttempt.mock.calls[0][2];
    expect(note).toBe(`Error del servidor o del inicio de sesión — ${"y".repeat(spanishLimit)}`);
    expect(note.length).toBe(240);
  });

  it("keeps the untouched suffix when editing a draft while the translated save limit is smaller", () => {
    const api = { updateOrganizationSetting: vi.fn(), updateOrganizationLabel: vi.fn() };
    const view = lang => <LanguageProvider lang={lang}><AdminSecurityConfiguration configuration={configuration} failedLoginInbox={failedLoginInbox} api={api} reload={vi.fn()} onNotice={vi.fn()} /></LanguageProvider>;
    const { container, rerender } = render(view("en"));
    const card = () => container.querySelector("#admin-failed-logins");
    fireEvent.change(within(card()).getByRole("combobox", { name: "Reason" }), { target: { value: "serverError" } });
    fireEvent.change(within(card()).getByRole("textbox", { name: "Disposition note" }), { target: { value: "a".repeat(196) + "b".repeat(18) } });
    rerender(view("es"));
    const note = within(card()).getByRole("textbox", { name: "Nota de resolución" });
    fireEvent.change(note, { target: { value: note.value.slice(0, 195) + note.value.slice(196) } });
    rerender(view("en"));
    expect(within(card()).getByRole("textbox", { name: "Disposition note" })).toHaveValue("a".repeat(195) + "b".repeat(18));
  });

  it("retains the full draft and clipping announcement after a failed disposition, then retries", async () => {
    const api = {
      updateOrganizationSetting: vi.fn(), updateOrganizationLabel: vi.fn(),
      loadFailedLoginInbox: vi.fn().mockResolvedValue({ ...failedLoginInbox, items: [] }),
      dispositionFailedLoginAttempt: vi.fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce({ updated: true }),
    };
    const onNotice = vi.fn();
    const view = (lang) => <LanguageProvider lang={lang}><AdminSecurityConfiguration configuration={configuration} failedLoginInbox={failedLoginInbox} api={api} reload={vi.fn()} onNotice={onNotice} /></LanguageProvider>;
    const { container, rerender } = render(view("en"));
    const card = () => container.querySelector("#admin-failed-logins");
    const draft = "z".repeat(214);
    fireEvent.change(within(card()).getByRole("combobox", { name: "Reason" }), { target: { value: "serverError" } });
    fireEvent.change(within(card()).getByRole("textbox", { name: "Disposition note" }), { target: { value: draft } });
    rerender(view("es"));
    const clipped = within(card()).getByRole("textbox", { name: "Nota de resolución" });
    const notice = within(card()).getByRole("status");
    expect(clipped).toHaveValue(draft);
    expect(clipped.getAttribute("aria-describedby").split(" ")).toContain(notice.id);
    fireEvent.click(within(card()).getByRole("button", { name: "Marcar revisado" }));
    expect(await within(card()).findByRole("alert")).toBeInTheDocument();
    expect(onNotice).not.toHaveBeenCalled();
    expect(within(card()).getByRole("status")).toHaveTextContent("196");
    expect(clipped).toHaveValue(draft);
    expect(within(card()).getByRole("button", { name: "Marcar revisado" })).toBeEnabled();
    expect(api.loadFailedLoginInbox).not.toHaveBeenCalled();

    rerender(view("en"));
    expect(within(card()).getByRole("textbox", { name: "Disposition note" })).toHaveValue(draft);
    expect(within(card()).queryByRole("status")).toBeNull();
    fireEvent.click(within(card()).getByRole("button", { name: "Mark reviewed" }));
    await waitFor(() => expect(api.dispositionFailedLoginAttempt).toHaveBeenCalledTimes(2));
    expect(api.dispositionFailedLoginAttempt).toHaveBeenNthCalledWith(1,
      failedLoginInbox.items[0].id, "reviewed", `Error del servidor o del inicio de sesión — ${draft.slice(0, 196)}`);
    expect(api.dispositionFailedLoginAttempt).toHaveBeenNthCalledWith(2,
      failedLoginInbox.items[0].id, "reviewed", `Server or sign-in error — ${draft}`);
    await waitFor(() => expect(onNotice).toHaveBeenCalledTimes(1));
  });

  it("offers every preset reason in English and Spanish", () => {
    const spanish = renderSurface({}, "es");
    const select = within(spanish.container.querySelector("#admin-failed-logins")).getByRole("combobox", { name: "Motivo" });
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Elige un motivo (opcional)",
      "El trabajador escribió mal su contraseña",
      "El trabajador olvidó su contraseña",
      "Error del servidor o del inicio de sesión",
      "Inicio de prueba o práctica",
    ]);
  });

  it("refetches when the admin selects all after reviewing an open row", async () => {
    const reviewed = { ...failedLoginInbox.items[0], status: "reviewed", dispositionNote: "Confirmed member typo" };
    const surface = renderSurface({
      loadFailedLoginInbox: vi.fn()
        .mockResolvedValueOnce({ ...failedLoginInbox, items: [failedLoginInbox.items[0]] })
        .mockResolvedValueOnce({ ...failedLoginInbox, items: [] })
        .mockResolvedValueOnce({ ...failedLoginInbox, items: [reviewed], openLast24Hours: 0 }),
    });
    const card = surface.container.querySelector("#admin-failed-logins");
    const select = within(card).getByRole("combobox", { name: "Status" });
    fireEvent.change(select, { target: { value: "open" } });
    expect(await within(card).findByRole("textbox", { name: "Disposition note" })).toBeInTheDocument();
    fireEvent.change(within(card).getByRole("textbox", { name: "Disposition note" }), { target: { value: "Confirmed member typo" } });
    fireEvent.click(within(card).getByRole("button", { name: "Mark reviewed" }));
    await waitFor(() => expect(surface.api.loadFailedLoginInbox).toHaveBeenLastCalledWith("open"));

    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(surface.api.loadFailedLoginInbox).toHaveBeenLastCalledWith(null));
    expect(await within(card).findByText("Confirmed member typo")).toBeInTheDocument();
    expect(within(card).queryByRole("textbox", { name: "Disposition note" })).toBeNull();
  });

  it("releases a superseded all-filter disposition refresh after a desk reload", async () => {
    let resolveAll;
    const surface = renderSurface({
      loadFailedLoginInbox: vi.fn().mockImplementation(() => new Promise((resolve) => { resolveAll = resolve; })),
    });
    const card = surface.container.querySelector("#admin-failed-logins");
    fireEvent.change(within(card).getByRole("textbox", { name: "Disposition note" }), { target: { value: "Confirmed member typo" } });
    fireEvent.click(within(card).getByRole("button", { name: "Mark reviewed" }));
    await waitFor(() => expect(surface.api.loadFailedLoginInbox).toHaveBeenCalledWith(null));

    surface.rerender(
      <LanguageProvider lang="en">
        <AdminSecurityConfiguration
          configuration={configuration}
          failedLoginInbox={{ ...failedLoginInbox }}
          api={surface.api}
          reload={surface.reload}
          onNotice={surface.onNotice}
        />
      </LanguageProvider>,
    );
    resolveAll({ ...failedLoginInbox, items: [] });

    expect(await within(card).findByRole("combobox", { name: "Status" })).toBeEnabled();
    expect(within(card).getByRole("button", { name: "Mark reviewed" })).toBeEnabled();
  });

  it("keeps the newest filtered response when an earlier request resolves late", async () => {
    const first = { ...failedLoginInbox.items[0], memberName: "Earlier response" };
    const latest = { ...failedLoginInbox.items[0], id: "30000000-0000-4000-8000-000000000005", memberName: "Latest response" };
    let resolveFirst;
    let resolveLatest;
    const loadFailedLoginInbox = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveLatest = resolve; }));
    const surface = renderSurface({ loadFailedLoginInbox });
    const card = surface.container.querySelector("#admin-failed-logins");
    fireEvent.change(within(card).getByRole("combobox", { name: "Status" }), { target: { value: "open" } });
    await waitFor(() => expect(loadFailedLoginInbox).toHaveBeenCalledTimes(1));

    surface.rerender(
      <LanguageProvider lang="en">
        <AdminSecurityConfiguration
          configuration={configuration}
          failedLoginInbox={{ ...failedLoginInbox }}
          api={surface.api}
          reload={surface.reload}
          onNotice={surface.onNotice}
        />
      </LanguageProvider>,
    );
    await waitFor(() => expect(loadFailedLoginInbox).toHaveBeenCalledTimes(2));
    resolveLatest({ ...failedLoginInbox, items: [latest] });
    expect(await within(card).findByText("Latest response")).toBeInTheDocument();

    resolveFirst({ ...failedLoginInbox, items: [first] });
    await waitFor(() => expect(within(card).getByText("Latest response")).toBeInTheDocument());
    expect(within(card).queryByText("Earlier response")).toBeNull();
  });
});


// A11Y-UG-ADMIN-SETTINGS-CONTROLS-LACK-ROW-NAMES-20260920: every boolean
// organization-setting checkbox and every Save / Use default row action must
// carry a stable accessible name that identifies its row in both locales,
// and a saving row action must report the in-progress state with the row name.
const a11yConfiguration = {
  settings: [
    {
      key: "features.mfa_recovery_code_enrollment",
      kind: "boolean",
      label: "Recovery code enrollment",
      description: "Allow members to generate recovery codes.",
      value: true,
      defaultValue: true,
      minimum: null,
      maximum: null,
    },
    {
      key: "features.public_directory",
      kind: "boolean",
      label: "Public member directory",
      description: "Show the member directory publicly.",
      value: false,
      defaultValue: false,
      minimum: null,
      maximum: null,
    },
  ],
  labelKeys: ["nav.home", "nav.tasks"],
  labelOverrides: {},
};

const ROW_NAMES = {
  en: {
    checkboxRecovery: "Recovery code enrollment",
    checkboxDirectory: "Public member directory",
    saveRecovery: /^Save Recovery code enrollment/,
    saveDirectory: /^Save Public member directory/,
    saveHome: /^Save Home/,
    useDefaultHome: /^Use default for Home/,
    useDefaultTasks: /^Use default for Tasks/,
    savingRecovery: /^Saving Recovery code enrollment/,
    savingHome: /^Saving Home/,
    genericSave: /^Save$/,
    genericUseDefault: /^Use default$/,
    homeField: /Home/,
    saveLabels: "Save labels",
    savingLabels: "Saving labels",
    stateOnlyNames: /^(On|Off)$/,
  },
  // REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001: a setting with
  // catalogue copy (settings.def.<key>.label) reads in Spanish; a key without
  // one falls back to the database English label.
  es: {
    checkboxRecovery: "Registro de códigos de recuperación",
    checkboxDirectory: "Public member directory",
    saveRecovery: /^Guardar Registro de códigos de recuperación/,
    saveDirectory: /^Guardar Public member directory/,
    saveHome: /^Guardar Inicio/,
    useDefaultHome: /^Usar predeterminado para Inicio/,
    useDefaultTasks: /^Usar predeterminado para Tareas/,
    savingRecovery: /^Guardando Registro de códigos de recuperación/,
    savingHome: /^Guardando Inicio/,
    genericSave: /^Guardar$/,
    genericUseDefault: /^Usar predeterminado$/,
    homeField: /Inicio/,
    saveLabels: "Guardar etiquetas",
    savingLabels: "Guardando etiquetas",
    stateOnlyNames: /^(Activado|Desactivado)$/,
  },
};

function renderLangSurface(lang, apiOverrides = {}) {
  const api = {
    updateOrganizationSetting: vi.fn().mockResolvedValue({ updated: true }),
    updateOrganizationLabel: vi.fn().mockResolvedValue({ updated: true }),
    loadFailedLoginInbox: vi.fn().mockResolvedValue({ ...failedLoginInbox, items: [] }),
    dispositionFailedLoginAttempt: vi.fn().mockResolvedValue({ updated: true }),
    ...apiOverrides,
  };
  const rendered = render(
    <LanguageProvider lang={lang}>
      <AdminSecurityConfiguration
        configuration={a11yConfiguration}
        failedLoginInbox={failedLoginInbox}
        api={api}
        reload={vi.fn()}
        onNotice={vi.fn()}
      />
    </LanguageProvider>,
  );
  return { ...rendered, api };
}

describe("A11Y-UG-ADMIN-SETTINGS-CONTROLS-LACK-ROW-NAMES-20260920", () => {
  for (const lang of ["en", "es"]) {
    it(`names every settings and label control by its row in ${lang}, independent of toggle state`, () => {
      const { container } = renderLangSurface(lang);
      const names = ROW_NAMES[lang];
      const config = within(container.querySelector("#admin-configuration"));
      const labels = within(container.querySelector("#admin-labels"));

      const recovery = config.getByRole("checkbox", { name: names.checkboxRecovery });
      const directory = config.getByRole("checkbox", { name: names.checkboxDirectory });
      expect(recovery).not.toBe(directory);

      // Flipping the checked state must not change the accessible name.
      fireEvent.click(recovery);
      expect(recovery).not.toBeChecked();
      expect(config.getByRole("checkbox", { name: names.checkboxRecovery })).not.toBeChecked();
      expect(config.queryAllByRole("checkbox", { name: names.stateOnlyNames })).toHaveLength(0);

      // Each row's Save action resolves only through its own row name.
      expect(config.getByRole("button", { name: names.saveRecovery })).toBeInTheDocument();
      expect(config.getByRole("button", { name: names.saveDirectory })).toBeInTheDocument();
      expect(config.queryByRole("button", { name: names.genericSave })).toBeNull();

      // One named Save writes every changed label (REQ-UG-CHAPTER-UNITS-WORKSITES-AND-LOCAL-PROFILE-20261030).
      expect(labels.getAllByRole("button")).toHaveLength(1);
      expect(labels.getByRole("button", { name: names.saveLabels })).toBeDisabled();
      fireEvent.change(labels.getByRole("textbox", { name: names.homeField }), { target: { value: "Start" } });
      expect(labels.getByRole("button", { name: names.saveLabels })).toBeEnabled();

      const controlNames = [
        ...config.getAllByRole("checkbox").map((node) => node.getAttribute("aria-label")),
        ...config.getAllByRole("button").map((node) => node.getAttribute("aria-label")),
        ...labels.getAllByRole("button").map((node) => node.getAttribute("aria-label")),
      ];
      expect(controlNames.every(Boolean)).toBe(true);
      expect(new Set(controlNames).size).toBe(controlNames.length);
    });
  }

  for (const lang of ["en", "es"]) {
    it(`reports the in-progress state with the row label while a settings row saves in ${lang}`, async () => {
      const names = ROW_NAMES[lang];
      let resolveSave;
      const { api } = renderLangSurface(lang, {
        updateOrganizationSetting: vi.fn().mockImplementation(() => new Promise((resolve) => { resolveSave = resolve; })),
      });
      const row = document.querySelector("[data-setting-key=\"features.mfa_recovery_code_enrollment\"]");

      fireEvent.click(within(row).getByRole("checkbox"));
      fireEvent.click(within(row).getByRole("button", { name: names.saveRecovery }));

      const saving = within(row).getByRole("button", { name: names.savingRecovery });
      // Pending, not natively disabled: the Save keeps focus (record 8435).
      expect(saving).toBeEnabled();
      expect(saving).toHaveAttribute("aria-disabled", "true");
      expect(within(row).queryByRole("button", { name: names.saveRecovery })).toBeNull();

      resolveSave({ updated: true });
      await waitFor(() => expect(api.updateOrganizationSetting).toHaveBeenCalledWith(
        "features.mfa_recovery_code_enrollment", false,
      ));
      expect(within(row).getByRole("button", { name: names.saveRecovery })).toBeEnabled();
    });
  }

  it("reports the in-progress state on the one label Save", async () => {
    const names = ROW_NAMES.en;
    let resolveSave;
    const { container, api } = renderLangSurface("en", {
      updateOrganizationLabel: vi.fn().mockImplementation(() => new Promise((resolve) => { resolveSave = resolve; })),
    });
    const labels = within(container.querySelector("#admin-labels"));
    const home = labels.getByRole("textbox", { name: names.homeField });
    fireEvent.change(home, { target: { value: "Start" } });
    fireEvent.click(labels.getByRole("button", { name: names.saveLabels }));

    expect(labels.getByRole("button", { name: names.savingLabels })).toBeEnabled();
    expect(labels.getByRole("button", { name: names.savingLabels })).toHaveAttribute("aria-disabled", "true");
    expect(labels.queryByRole("button", { name: names.saveLabels })).toBeNull();

    resolveSave({ updated: true });
    await waitFor(() => expect(api.updateOrganizationLabel).toHaveBeenCalledWith("nav.home", "Start"));
    await waitFor(() => expect(labels.getByRole("button", { name: names.saveLabels })).toBeDisabled());
  });
});

// REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001: the grouped page.
const groupedConfiguration = {
  settings: [
    { key: "security.failed_login_alert_threshold", kind: "integer", category: "security", label: "Failed sign-in attention threshold", description: "Open failures.", value: 5, defaultValue: 5, minimum: 1, maximum: 100, allowedValues: null, overridden: false, updatedAt: null, lastChange: null },
    { key: "limits.casework.deadline_red_days", kind: "integer", category: "casework", label: "Deadline red threshold (days)", description: "Red.", value: 3, defaultValue: 5, minimum: 0, maximum: 90, allowedValues: null, overridden: true, updatedAt: "2026-10-01T12:00:00.123456+00:00", lastChange: { action: "setting_updated", at: "2026-10-01T12:00:00.123456+00:00", actorName: "Alex Rivera" } },
    { key: "lists.casework.management_behavior_categories", kind: "text_list", category: "casework", label: "Management behavior categories", description: "Categories.", value: ["Intimidation", "Other"], defaultValue: ["Intimidation", "Other"], minimum: 1, maximum: 50, allowedValues: null, overridden: false, updatedAt: null, lastChange: null },
    { key: "limits.proof.mode", kind: "text", category: "analytics", label: "Proof mode", description: "Enum.", value: "steady", defaultValue: "steady", minimum: null, maximum: null, allowedValues: ["steady", "fast"], overridden: false, updatedAt: null, lastChange: null },
  ],
  labelKeys: [],
  labelOverrides: {},
};

function renderGrouped(apiOverrides = {}, lang = "en") {
  const api = {
    updateOrganizationSetting: vi.fn().mockResolvedValue({ updated: true }),
    setOrganizationSetting: vi.fn().mockResolvedValue({ updated: true }),
    resetOrganizationSetting: vi.fn().mockResolvedValue({ updated: true }),
    loadConfigurationAudit: vi.fn().mockResolvedValue([
      { id: "a1", action: "setting_updated", key: "limits.casework.deadline_red_days", previousValue: 5, newValue: 3, actorName: "Alex Rivera", createdAt: "2026-10-01T12:00:00Z" },
    ]),
    updateOrganizationLabel: vi.fn(),
    loadFailedLoginInbox: vi.fn().mockResolvedValue({ ...failedLoginInbox, items: [] }),
    dispositionFailedLoginAttempt: vi.fn(),
    ...apiOverrides,
  };
  const reload = vi.fn();
  const rendered = render(
    <LanguageProvider lang={lang}>
      <AdminSecurityConfiguration configuration={groupedConfiguration} failedLoginInbox={failedLoginInbox} api={api} reload={reload} onNotice={vi.fn()} />
    </LanguageProvider>,
  );
  const card = within(rendered.container.querySelector("#admin-configuration"));
  const row = (key) => within(rendered.container.querySelector(`[data-setting-key="${key}"]`));
  return { ...rendered, api, reload, card, row };
}

describe("feature switches & limits page", () => {
  it("groups settings under category headings in the fixed order and in Spanish", () => {
    const { card } = renderGrouped({}, "es");
    expect(card.getByRole("heading", { level: 2, name: "Interruptores de funciones y límites" })).toBeInTheDocument();
    expect(card.getAllByRole("heading", { level: 3 }).map((node) => node.textContent)).toEqual(["Seguridad e inicio de sesión", "Seguimiento de asuntos", "Analítica"]);
    expect(card.getByRole("spinbutton", { name: "Umbral rojo de plazos (días)" })).toHaveValue(3);
  });

  it("filters by search text, category and changed-from-default", () => {
    const { card } = renderGrouped();
    expect(card.getByRole("status")).toHaveTextContent("Showing 4 of 4 settings");
    fireEvent.change(card.getByRole("searchbox", { name: "Search settings" }), { target: { value: "deadline" } });
    expect(card.getByRole("status")).toHaveTextContent("Showing 1 of 4 settings");
    fireEvent.change(card.getByRole("searchbox", { name: "Search settings" }), { target: { value: "" } });
    fireEvent.change(card.getByRole("combobox", { name: "Category" }), { target: { value: "casework" } });
    expect(card.getAllByRole("heading", { level: 3 }).map((node) => node.textContent)).toEqual(["Issue work"]);
    fireEvent.change(card.getByRole("combobox", { name: "Category" }), { target: { value: "" } });
    fireEvent.click(card.getByRole("checkbox", { name: "Changed from default only" }));
    expect(card.getByRole("status")).toHaveTextContent("Showing 1 of 4 settings");
    fireEvent.change(card.getByRole("searchbox", { name: "Search settings" }), { target: { value: "nothing matches" } });
    expect(card.getByText("No settings match these filters.")).toBeInTheDocument();
  });

  it("shows default, bounds, the changed marker and the last change for each row", () => {
    const { row } = renderGrouped();
    const red = row("limits.casework.deadline_red_days");
    expect(red.getByText("Changed")).toBeInTheDocument();
    expect(red.getByText(/Default: 5 · Allowed 0–90 · Changed by Alex Rivera on/)).toBeInTheDocument();
    expect(row("security.failed_login_alert_threshold").queryByRole("button", { name: /Use the default/ })).toBeNull();
  });

  it("saves with the read version token and resets an override to its default", async () => {
    const { row, api, reload } = renderGrouped();
    const red = row("limits.casework.deadline_red_days");
    const save = red.getByRole("button", { name: "Save Deadline red threshold (days)" });
    expect(save).toBeDisabled();
    fireEvent.change(red.getByRole("spinbutton", { name: "Deadline red threshold (days)" }), { target: { value: "7" } });
    fireEvent.click(save);
    await waitFor(() => expect(api.setOrganizationSetting).toHaveBeenCalledWith("limits.casework.deadline_red_days", 7, "2026-10-01T12:00:00.123456+00:00"));
    expect(api.updateOrganizationSetting).not.toHaveBeenCalled();
    await waitFor(() => expect(red.getByRole("button", { name: "Use the default for Deadline red threshold (days)" })).toBeEnabled());
    fireEvent.click(red.getByRole("button", { name: "Use the default for Deadline red threshold (days)" }));
    await waitFor(() => expect(api.resetOrganizationSetting).toHaveBeenCalledWith("limits.casework.deadline_red_days", "2026-10-01T12:00:00.123456+00:00"));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  });

  it("refuses an out-of-range draft before the round trip and explains why", () => {
    const { row, api } = renderGrouped();
    const red = row("limits.casework.deadline_red_days");
    const input = red.getByRole("spinbutton", { name: "Deadline red threshold (days)" });
    fireEvent.change(input, { target: { value: "91" } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(red.getByText("Enter a value inside the allowed range.")).toBeInTheDocument();
    expect(red.getByRole("button", { name: "Save Deadline red threshold (days)" })).toBeDisabled();
    expect(api.setOrganizationSetting).not.toHaveBeenCalled();
  });

  it("edits an enum with a select and a text list one item per line", async () => {
    const { row, api } = renderGrouped();
    const mode = row("limits.proof.mode");
    fireEvent.change(mode.getByRole("combobox", { name: "Proof mode" }), { target: { value: "fast" } });
    fireEvent.click(mode.getByRole("button", { name: "Save Proof mode" }));
    await waitFor(() => expect(api.setOrganizationSetting).toHaveBeenCalledWith("limits.proof.mode", "fast", null));
    const list = row("lists.casework.management_behavior_categories");
    fireEvent.change(list.getByRole("textbox", { name: "Management behavior categories" }), { target: { value: " Intimidation \nWeingarten denial\n\nintimidation" } });
    await waitFor(() => expect(list.getByRole("button", { name: "Save Management behavior categories" })).toBeEnabled());
    fireEvent.click(list.getByRole("button", { name: "Save Management behavior categories" }));
    await waitFor(() => expect(api.setOrganizationSetting).toHaveBeenCalledWith("lists.casework.management_behavior_categories", ["Intimidation", "Weingarten denial"], null));
  });

  it("reports a concurrent change and reloads instead of overwriting it", async () => {
    const conflict = Object.assign(new Error("Save organization setting: setting changed"), { code: "40001" });
    const { row, card, reload } = renderGrouped({ setOrganizationSetting: vi.fn().mockRejectedValue(conflict) });
    const red = row("limits.casework.deadline_red_days");
    fireEvent.change(red.getByRole("spinbutton", { name: "Deadline red threshold (days)" }), { target: { value: "8" } });
    fireEvent.click(red.getByRole("button", { name: "Save Deadline red threshold (days)" }));
    expect(await card.findByRole("alert")).toHaveTextContent("Another administrator changed this setting");
    expect(reload).toHaveBeenCalled();
  });

  it("shows recent changes with previous and new values on demand", async () => {
    const { card, api } = renderGrouped();
    const toggle = card.getByRole("button", { name: "Show recent changes" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await card.findByText(/Setting changed · 5 → 3/)).toBeInTheDocument();
    expect(api.loadConfigurationAudit).toHaveBeenCalledWith(null, 50);
  });
});

// UX-UG-ADMIN-NOT-TOLD-ONBOARDING-NEEDS-CHECKLIST-20261018: the guide
// switches name the built-in starting list versus the organization's own
// checklist, and the group links to where the admin adds one.
describe("guidance and onboarding switches", () => {
  const GUIDE_KEYS = ["feature_drip", "hud_tooltips", "spotlight", "progressive_disclosure", "badge_achievements", "auto_enroll_onboarding"];
  const guideConfiguration = {
    settings: [
      { key: "features.guidance_onboarding.feature_drip", kind: "boolean", category: "guidance_onboarding", label: "Feature drip", description: "", value: true, defaultValue: true, minimum: null, maximum: null, allowedValues: null, overridden: false, updatedAt: null, lastChange: null },
      ...groupedConfiguration.settings,
    ],
    labelKeys: [],
    labelOverrides: {},
  };
  const api = () => ({
    updateOrganizationSetting: vi.fn(), setOrganizationSetting: vi.fn(), resetOrganizationSetting: vi.fn(),
    loadConfigurationAudit: vi.fn().mockResolvedValue([]), updateOrganizationLabel: vi.fn(),
    loadFailedLoginInbox: vi.fn().mockResolvedValue({ ...failedLoginInbox, items: [] }), dispositionFailedLoginAttempt: vi.fn(),
  });

  it("says every guide switch needs the organization's own checklist, in both languages, and never says members see no guide", () => {
    for (const lang of ["en", "es"]) {
      for (const key of GUIDE_KEYS) {
        const text = catalogue[lang][`settings.def.features.guidance_onboarding.${key}.description`];
        expect(text, `${lang} ${key}`).toContain(lang === "en" ? "built-in starting list" : "lista inicial de Union Ground");
        expect(text).not.toMatch(/no guide|ninguna guía/i);
      }
    }
  });

  it("links the group to the onboarding checklist and keeps other groups unchanged", () => {
    const navigate = vi.fn();
    const previous = window.location.pathname;
    window.history.replaceState({}, "", "/m/admin/configuration");
    const rendered = render(
      <LanguageProvider lang="en">
        <WorkspacePages view="admin" location="/m/admin/configuration" hat="admin" navigate={navigate}>
          <AdminSecurityConfiguration configuration={guideConfiguration} failedLoginInbox={failedLoginInbox} api={api()} reload={vi.fn()} onNotice={vi.fn()} />
        </WorkspacePages>
      </LanguageProvider>,
    );
    const card = within(rendered.container.querySelector("#admin-configuration"));
    expect(card.getByText(/Until you add one, workers see Union Ground's built-in starting list on Worker support > Onboarding\./)).toBeInTheDocument();
    const links = card.getAllByRole("link", { name: "Add a new-worker checklist" });
    expect(links).toHaveLength(1);
    // UX-UG-ONBOARDING-SWITCH-GROUP-NOTE-ALIGN-AND-LINK-STYLE-20261020:
    // the note sits on the group heading's gutter with the brand link style.
    expect(links[0].closest("p")).toHaveClass("xus-note", "xus-config-group__note");
    const css = readFileSync(resolve("src/styles.css"), "utf8");
    expect(css).toContain(".xus-config-group__note { padding: 0 20px 8px; }");
    expect(css).toContain(".xus-config-group__note a { color: var(--primary); font-weight: 750; text-underline-offset: 3px; }");
    expect(links[0]).toHaveAttribute("href", "/m/support/onboarding");
    fireEvent.click(links[0]);
    expect(navigate).toHaveBeenLastCalledWith("memberSupport", "/m/support/onboarding", null, { replace: false });
    rendered.unmount();
    window.history.replaceState({}, "", previous);
    const plain = renderGrouped();
    expect(plain.card.queryByRole("link", { name: "Add a new-worker checklist" })).toBeNull();
  });

  it("leaves the checklist link to the browser outside a workspace", () => {
    const rendered = render(
      <LanguageProvider lang="en">
        <AdminSecurityConfiguration configuration={guideConfiguration} failedLoginInbox={failedLoginInbox} api={api()} reload={vi.fn()} onNotice={vi.fn()} />
      </LanguageProvider>,
    );
    const link = within(rendered.container.querySelector("#admin-configuration")).getByRole("link", { name: "Add a new-worker checklist" });
    let prevented = null;
    const record = (event) => { prevented = event.defaultPrevented; event.preventDefault(); };
    document.addEventListener("click", record);
    fireEvent.click(link);
    document.removeEventListener("click", record);
    expect(prevented).toBe(false);
  });
});

// Each card's writes keep their control focused and pending,
// share one lock per card, refuse a second activation in the same tick, and
// end their lock where busy clears.
describe("security configuration writes while they run", () => {
  const rowSave = (container, label) => {
    const field = within(container.querySelector("#admin-configuration")).getByRole("spinbutton", { name: label });
    return { field, save: () => within(field.closest(".xus-config-row")).getByRole("button", { name: new RegExp(`^Save ${label}`) }) };
  };

  it("keeps a row's Save focused and pending while it saves, and sends once", async () => {
    const { container, api } = renderSurface();
    const row = rowSave(container, "Session window");
    fireEvent.change(row.field, { target: { value: "45" } });
    await expectHeldWriteFocus(api.updateOrganizationSetting, row.save());
    expect(api.updateOrganizationSetting).toHaveBeenCalledOnce();
  });

  it("sends one setting when two rows' Saves are pressed in the same tick", async () => {
    const { container, api } = renderSurface();
    const window = rowSave(container, "Session window");
    const retention = rowSave(container, "Failed sign-in retention");
    fireEvent.change(window.field, { target: { value: "45" } });
    fireEvent.change(retention.field, { target: { value: "120" } });
    const first = window.save();
    const second = retention.save();
    await expectOneWriteFromOneTick(api.updateOrganizationSetting, [() => fireEvent.click(first), () => fireEvent.click(second)]);
  });

  it("saves a row again from an immediate press after a save that throws at once", async () => {
    const { container, api } = renderSurface();
    const row = rowSave(container, "Session window");
    fireEvent.change(row.field, { target: { value: "45" } });
    await expectReadyRetryAfterThrowAtOnce(api.updateOrganizationSetting, row.save());
  });

  it("keeps Save labels focused while the labels save, and saves again after a save that throws at once", async () => {
    const { container, api } = renderSurface();
    const labels = within(container.querySelector("#admin-labels"));
    fireEvent.change(labels.getByRole("textbox", { name: /Home/ }), { target: { value: "Start" } });
    const save = labels.getByRole("button", { name: "Save labels" });
    await expectHeldWriteFocus(api.updateOrganizationLabel, save);
    expect(api.updateOrganizationLabel).toHaveBeenCalledOnce();
    fireEvent.change(labels.getByRole("textbox", { name: /Home/ }), { target: { value: "Begin" } });
    await waitFor(() => expect(save).not.toHaveAttribute("aria-disabled"));
    await expectReadyRetryAfterThrowAtOnce(api.updateOrganizationLabel, save);
  });

  const openRow = (card) => {
    fireEvent.change(within(card).getByRole("textbox", { name: "Disposition note" }), { target: { value: "Confirmed member typo" } });
    return {
      reviewed: within(card).getByRole("button", { name: "Mark reviewed" }),
      dismiss: within(card).getByRole("button", { name: "Dismiss" }),
    };
  };

  it("sends one disposition when Mark reviewed and Dismiss are pressed in the same tick", async () => {
    const { container, api } = renderSurface();
    const { reviewed, dismiss } = openRow(container.querySelector("#admin-failed-logins"));
    await expectOneWriteFromOneTick(api.dispositionFailedLoginAttempt, [() => fireEvent.click(reviewed), () => fireEvent.click(dismiss)]);
  });

  it("sends a disposition again from an immediate press after one that throws at once", async () => {
    const { container, api } = renderSurface();
    const { reviewed } = openRow(container.querySelector("#admin-failed-logins"));
    await expectReadyRetryAfterThrowAtOnce(api.dispositionFailedLoginAttempt, reviewed);
  });

  it("keeps the disposition buttons pending through a filter read that answers while the disposition runs", async () => {
    let answer;
    const { container, api } = renderSurface({ dispositionFailedLoginAttempt: vi.fn(() => new Promise((resolve) => { answer = resolve; })) });
    const card = container.querySelector("#admin-failed-logins");
    const { reviewed, dismiss } = openRow(card);
    reviewed.focus();
    fireEvent.click(reviewed);
    expect(api.dispositionFailedLoginAttempt).toHaveBeenCalledOnce();
    api.loadFailedLoginInbox.mockResolvedValueOnce(failedLoginInbox);
    await act(async () => { fireEvent.change(within(card).getByRole("combobox", { name: "Status" }), { target: { value: "open" } }); });
    await waitFor(() => expect(api.loadFailedLoginInbox).toHaveBeenCalledWith("open"));
    // The filter read settled; the disposition still runs, so its buttons stay pending.
    expect(dismiss).toBeEnabled();
    expect(dismiss).toHaveAttribute("aria-disabled", "true");
    expect(reviewed).toHaveFocus();
    fireEvent.click(dismiss);
    expect(api.dispositionFailedLoginAttempt).toHaveBeenCalledOnce();
    await act(async () => { answer({ updated: true }); });
    // The disposition settled and re-read the list; its one write went out.
    await waitFor(() => expect(api.loadFailedLoginInbox).toHaveBeenCalledTimes(2));
    expect(api.dispositionFailedLoginAttempt).toHaveBeenCalledOnce();
  });

  it("keeps the status filter focused and pending while its read runs", async () => {
    let answer;
    const { container, api } = renderSurface();
    api.loadFailedLoginInbox.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const filter = within(container.querySelector("#admin-failed-logins")).getByRole("combobox", { name: "Status" });
    filter.focus();
    fireEvent.change(filter, { target: { value: "reviewed" } });
    expect(api.loadFailedLoginInbox).toHaveBeenCalledWith("reviewed");
    expect(filter).toBeEnabled();
    expect(filter).toHaveAttribute("aria-disabled", "true");
    expect(filter).toHaveFocus();
    await act(async () => { answer({ ...failedLoginInbox, items: [] }); });
    expect(filter).not.toHaveAttribute("aria-disabled");
  });
});

// UX-UG-LONG-PAGES-RENDER-EVERY-ROW-EXPANDED-WITH-NO-PAGING-20261122
// (A-15): the inbox drew every report with its own form on one page, reviewed
// ones mixed in under "All". Open reports come first, ten to a page.
describe("failed sign-in inbox is bounded and leads with open reports", () => {
  const report = (index, status) => ({
    ...failedLoginInbox.items[0],
    id: `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    memberName: `${status} member ${index}`,
    status,
    occurredAt: new Date(Date.UTC(2026, 10, 20, 12, 0) - index * 60000).toISOString(),
  });
  // Newest first, the way the server sends them: reviewed and open mixed.
  const items = Array.from({ length: 24 }, (_, index) => report(index + 1, index % 2 === 0 ? "reviewed" : "open"));

  function renderInbox(lang = "en") {
    const api = { updateOrganizationLabel: vi.fn(), loadFailedLoginInbox: vi.fn(), dispositionFailedLoginAttempt: vi.fn() };
    render(<LanguageProvider lang={lang}><AdminSecurityConfiguration configuration={configuration} failedLoginInbox={{ ...failedLoginInbox, items }} api={api} reload={vi.fn()} onNotice={vi.fn()} /></LanguageProvider>);
    return within(document.getElementById("admin-failed-logins"));
  }
  const names = (card) => card.getAllByText(/ member \d+$/).map((node) => node.textContent);

  it("shows ten reports, the open ones first, and pages the rest", () => {
    const card = renderInbox();
    expect(names(card)).toEqual(items.filter((item) => item.status === "open").slice(0, 10).map((item) => item.memberName));
    expect(card.getAllByRole("button", { name: "Mark reviewed" })).toHaveLength(10);
    const pager = card.getByRole("navigation", { name: "Failed sign-in inbox" });
    expect(pager).toHaveTextContent("Showing 1–10 of 24");
    fireEvent.click(within(pager).getByRole("button", { name: "Next" }));
    expect(names(card)).toEqual([...items.filter((item) => item.status === "open").slice(10), ...items.filter((item) => item.status === "reviewed").slice(0, 8)].map((item) => item.memberName));
  });

  it("goes back to page 1 when the status filter changes", async () => {
    const api = { updateOrganizationLabel: vi.fn(), loadFailedLoginInbox: vi.fn().mockResolvedValue({ ...failedLoginInbox, items: items.filter((item) => item.status === "open") }), dispositionFailedLoginAttempt: vi.fn() };
    render(<LanguageProvider lang="en"><AdminSecurityConfiguration configuration={configuration} failedLoginInbox={{ ...failedLoginInbox, items }} api={api} reload={vi.fn()} onNotice={vi.fn()} /></LanguageProvider>);
    const card = within(document.getElementById("admin-failed-logins"));
    fireEvent.click(within(card.getByRole("navigation", { name: "Failed sign-in inbox" })).getByRole("button", { name: "Page 3" }));
    expect(names(card)).toHaveLength(4);
    fireEvent.change(card.getByLabelText("Status"), { target: { value: "open" } });
    await waitFor(() => expect(api.loadFailedLoginInbox).toHaveBeenCalledWith("open"));
    await waitFor(() => expect(card.getByRole("navigation", { name: "Failed sign-in inbox" })).toHaveTextContent("Showing 1–10 of 12"));
    expect(names(card)[0]).toBe("open member 2");
  });

  it("names the pager in Spanish", () => {
    const card = renderInbox("es");
    expect(card.getByRole("navigation", { name: "Bandeja de inicios fallidos" })).toHaveTextContent("Mostrando 1–10 de 24");
  });
});
