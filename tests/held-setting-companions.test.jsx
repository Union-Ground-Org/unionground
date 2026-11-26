// BUG-UG-HELD-FEATURE-LIMITS-STILL-LISTED-20261112 (#8590): a limit
// that acts only beside a held switch leaves the admin settings list with it,
// and comes back when the switch is released. Only the list changes.
// BUG-UG-HELD-FEATURE-TRACES-PACKET-LIMIT-AND-MAP-SUBTITLE-20261113
// (#8598) adds the field notes per draft packet limit.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminSecurityConfiguration } from "../src/components/AdminSecurityConfiguration.jsx";
import { SETTING_ACTS_BESIDE, withoutRowsBesideHeldSwitches } from "../src/lib/heldSettingCompanions.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { loadAdminDesk } from "../src/lib/memberApi.js";
import { useDesk } from "../src/lib/useDesk.js";
import { catalogue } from "../src/lib/i18n.js";
import { spanishCatalogue } from "../src/lib/i18n/es.js";

afterEach(cleanup);

const LIMITS = {
  packet: "limits.ai_assistant.packet_notes",
  digest: "limits.intelligence.digest_max_recommendations",
  floor: "limits.intelligence.neuro_map_topic_min_members",
  daily: "limits.security.invitation_member_daily",
  monthly: "limits.security.invitation_member_monthly",
};
const SWITCHES = {
  packet: "features.ai_assistant.field_notes_packet",
  digest: "features.intelligence.weekly_digest",
  neuroMap: "features.intelligence.neuro_map",
  progress: "features.intelligence.neuro_map_auto_progress",
  derived: "features.intelligence.neuro_map_derived_graph",
  invitations: "features.member_invitations.enabled",
};
const row = (key, value) => ({ key, kind: key.startsWith("limits.") ? "integer" : "boolean", category: key.split(".")[1], label: key, description: "", value, defaultValue: value, minimum: key.startsWith("limits.") ? 0 : null, maximum: key.startsWith("limits.") ? 500 : null, overridden: false, updatedAt: null, lastChange: null });
// The admin list as the server returns it with everything released.
const released = [
  row("features.ai_assistant.enabled", true),
  row(SWITCHES.packet, false), row(LIMITS.packet, 12),
  row(SWITCHES.digest, false), row(LIMITS.digest, 3),
  row(SWITCHES.neuroMap, true), row(SWITCHES.derived, false), row(SWITCHES.progress, false), row(LIMITS.floor, 5),
  row(SWITCHES.invitations, false), row(LIMITS.daily, 3), row(LIMITS.monthly, 10),
];
// The server leaves a held switch out of the list; it never sends a held flag.
const holding = (...keys) => released.filter((item) => !keys.includes(item.key));
const keysOf = (settings) => settings.map((item) => item.key);
// The switches held for their release day whose limits this file covers.
const HELD = [SWITCHES.packet, SWITCHES.digest, SWITCHES.progress, SWITCHES.invitations];

describe("rows that act beside a switch", () => {
  it("names a companion switch that exists in both catalogues for every row", () => {
    for (const [limit, switches] of Object.entries(SETTING_ACTS_BESIDE)) {
      expect(catalogue.en[`settings.def.${limit}.label`], limit).toEqual(expect.any(String));
      expect(spanishCatalogue.es[`settings.def.${limit}.label`], limit).toEqual(expect.any(String));
      for (const key of switches) {
        expect(key, limit).toMatch(/^features\./);
        expect(catalogue.en[`settings.def.${key}.label`], key).toEqual(expect.any(String));
        expect(spanishCatalogue.es[`settings.def.${key}.label`], key).toEqual(expect.any(String));
      }
    }
  });

  it("keeps the released list exactly, values included", () => {
    expect(withoutRowsBesideHeldSwitches(released)).toEqual(released);
  });

  it.each([
    ["the field-notes packet", [SWITCHES.packet], [LIMITS.packet]],
    ["the weekly digest", [SWITCHES.digest], [LIMITS.digest]],
    ["member-sent invitations", [SWITCHES.invitations], [LIMITS.daily, LIMITS.monthly]],
    ["Neuro Map automatic topic readiness", [SWITCHES.progress], [LIMITS.floor]],
    ["the Neuro Map itself", [SWITCHES.neuroMap], [LIMITS.floor]],
  ])("leaves a limit out while %s is held", (_label, held, gone) => {
    const kept = keysOf(withoutRowsBesideHeldSwitches(holding(...held)));
    for (const key of gone) expect(kept).not.toContain(key);
    expect(kept).toEqual(keysOf(holding(...held)).filter((key) => !gone.includes(key)));
  });

  it("keeps the readiness floor while only derived connections are held, since it applies to readiness alone", () => {
    expect(keysOf(withoutRowsBesideHeldSwitches(holding(SWITCHES.derived)))).toContain(LIMITS.floor);
  });

  it("leaves the kept rows and their stored values untouched", () => {
    const input = holding(SWITCHES.digest);
    const output = withoutRowsBesideHeldSwitches(input);
    for (const item of output) expect(item).toBe(input.find((candidate) => candidate.key === item.key));
    expect(input.find((item) => item.key === LIMITS.digest).value).toBe(3);
  });

  it("lists none of these rows from a list that is not current, and keeps every other row", () => {
    const kept = keysOf(withoutRowsBesideHeldSwitches(released, { current: false }));
    expect(kept).toEqual(keysOf(released).filter((key) => !Object.values(LIMITS).includes(key)));
  });

  it("passes an unreadable list through for the page to report", () => {
    expect(withoutRowsBesideHeldSwitches(null)).toBeNull();
    expect(withoutRowsBesideHeldSwitches(undefined)).toBeUndefined();
  });
});

// The real desk loader over a scripted client that answers only the
// configuration read.
async function loadDeskWith(settings) {
  const client = {
    rpc: (name) => Promise.resolve({ data: name === "get_admin_organization_configuration" ? { settings, labelKeys: [], labelOverrides: {} } : null, error: null }),
  };
  return loadAdminDesk(client, "en");
}

describe("the admin desk's settings list", () => {
  it("leaves out the limits of held features when it loads, and lists them again once released", async () => {
    const held = await loadDeskWith(holding(...HELD));
    expect(keysOf(held.configuration.settings)).toEqual(["features.ai_assistant.enabled", SWITCHES.neuroMap, SWITCHES.derived]);
    expect(held.configuration.labelKeys).toEqual([]);
    expect(keysOf((await loadDeskWith(released)).configuration.settings)).toEqual(keysOf(released));
  });

  it.each(["en", "es"])("shows no row or name of a held feature's limit on the page (%s)", async (lang) => {
    const names = lang === "en" ? catalogue.en : spanishCatalogue.es;
    const desk = await loadDeskWith(holding(...HELD));
    const { container } = render(<LanguageProvider lang={lang}><AdminSecurityConfiguration configuration={desk.configuration} failedLoginInbox={null} api={{ updateOrganizationSetting: vi.fn() }} reload={vi.fn()} onNotice={vi.fn()} /></LanguageProvider>);
    for (const key of Object.values(LIMITS)) {
      expect(container.querySelector(`[data-setting-key="${key}"]`), key).toBeNull();
      expect(container.querySelector("#admin-configuration").textContent).not.toContain(names[`settings.def.${key}.label`]);
    }
    cleanup();
    const releasedDesk = await loadDeskWith(released);
    const page = render(<LanguageProvider lang={lang}><AdminSecurityConfiguration configuration={releasedDesk.configuration} failedLoginInbox={null} api={{ updateOrganizationSetting: vi.fn() }} reload={vi.fn()} onNotice={vi.fn()} /></LanguageProvider>);
    for (const key of Object.values(LIMITS)) expect(page.container.querySelector(`[data-setting-key="${key}"]`), key).not.toBeNull();
  });
});

// The admin desk guard of src/views/AdminView.jsx over the real loader: the
// page shows while there is no error and a desk, and its configuration is
// current only when no read is in flight.
function AdminDeskHarness({ api }) {
  const { desk, error, pending, load } = useDesk(api);
  return <>
    <button type="button" onClick={() => { void load(); }}>reload</button>
    {!error && desk && <AdminSecurityConfiguration configuration={desk.configuration} configurationCurrent={!pending} failedLoginInbox={null} api={{ updateOrganizationSetting: vi.fn() }} reload={load} onNotice={vi.fn()} />}
  </>;
}

describe.each(["en", "es"])("a limit whose feature is held between two reads (%s)", (lang) => {
  it("is not shown while the next read is pending, after it fails, during a retry, or once the held read lands", async () => {
    const names = lang === "en" ? catalogue.en : spanishCatalogue.es;
    const reads = [];
    const client = {
      rpc: (name) => name === "get_admin_organization_configuration"
        ? new Promise((resolve, reject) => reads.push({
          resolve: (settings) => resolve({ data: { settings, labelKeys: [], labelOverrides: {} }, error: null }),
          reject,
        }))
        : Promise.resolve({ data: null, error: null }),
    };
    render(<LanguageProvider lang={lang}><AdminDeskHarness api={{ loadDesk: () => loadAdminDesk(client, "en") }} /></LanguageProvider>);
    const shown = (key) => document.querySelector(`[data-setting-key="${key}"]`) !== null
      || (document.querySelector("#admin-configuration")?.textContent.includes(names[`settings.def.${key}.label`]) ?? false);
    // The loader asks for the configuration after its other reads start.
    const settle = async (index, outcome) => {
      await vi.waitFor(() => expect(reads[index]).toBeDefined());
      await act(async () => { outcome(reads[index]); });
    };

    // Released on the first read: every limit is listed, switched-off features included.
    await settle(0, (read) => read.resolve(released));
    for (const key of Object.values(LIMITS)) expect(shown(key), key).toBe(true);

    // The packet, weekly digest, automatic readiness and member invitations are held;
    // a refresh is in flight, so the page still has the released list.
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    for (const key of Object.values(LIMITS)) expect(shown(key), key).toBe(false);
    expect(document.querySelector('[data-setting-key="features.intelligence.weekly_digest"]')).not.toBeNull();

    // That read fails.
    await settle(1, (read) => read.reject(new Error("offline")));
    for (const key of Object.values(LIMITS)) expect(shown(key), key).toBe(false);

    // A retry is in flight.
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    for (const key of Object.values(LIMITS)) expect(shown(key), key).toBe(false);

    // The retry lands with the four switches held.
    await settle(2, (read) => read.resolve(holding(...HELD)));
    for (const key of Object.values(LIMITS)) expect(shown(key), key).toBe(false);

    // Released again: listed as before, with no deploy.
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    await settle(3, (read) => read.resolve(released));
    for (const key of Object.values(LIMITS)) expect(shown(key), key).toBe(true);
  });
});

// BUG-UG-ADMIN-SECURITY-SETTINGS-REFRESH-DROPS-UNSAVED-LIMIT-EDIT-20261115
// (#8777): while a refresh is in flight the page leaves these limits out; a
// limit the admin typed but had not saved is still there when its row returns.
describe("an unsaved limit edit across a refresh", () => {
  const page = (settings, current, api) => <LanguageProvider lang="en"><AdminSecurityConfiguration configuration={{ settings, labelKeys: [], labelOverrides: {} }} configurationCurrent={current} failedLoginInbox={null} api={api} reload={vi.fn()} onNotice={vi.fn()} /></LanguageProvider>;
  const field = (key) => document.querySelector(`[data-setting-key="${key}"] input`);

  it("keeps a typed limit through a refresh and a save of another setting, and shows it when its row returns", async () => {
    const api = { updateOrganizationSetting: vi.fn(async () => ({})) };
    const view = render(page(released, true, api));
    fireEvent.change(field(LIMITS.daily), { target: { value: "2" } });
    // A refresh is in flight: the row waits for the new read.
    view.rerender(page(released, false, api));
    expect(field(LIMITS.daily)).toBeNull();
    // Another setting is saved meanwhile, and its reload is in flight too.
    const assistant = document.querySelector('[data-setting-key="features.ai_assistant.enabled"]');
    fireEvent.click(within(assistant).getByRole("checkbox"));
    fireEvent.click(within(assistant).getByRole("button", { name: /^Save/ }));
    await vi.waitFor(() => expect(api.updateOrganizationSetting).toHaveBeenCalledWith("features.ai_assistant.enabled", false));
    const saved = released.map((item) => (item.key === "features.ai_assistant.enabled" ? { ...item, value: false } : item));
    view.rerender(page(saved, false, api));
    view.rerender(page(saved, true, api));
    expect(field(LIMITS.daily)).toHaveValue(2);
    expect(field(LIMITS.monthly)).toHaveValue(10);
  });

  it("discards the edit of a limit the new read really leaves out", () => {
    const api = { updateOrganizationSetting: vi.fn() };
    const view = render(page(released, true, api));
    fireEvent.change(field(LIMITS.daily), { target: { value: "2" } });
    view.rerender(page(released, false, api));
    // The new read holds member invitations, so the loader leaves its limits out with it.
    view.rerender(page(withoutRowsBesideHeldSwitches(holding(SWITCHES.invitations)), true, api));
    expect(field(LIMITS.daily)).toBeNull();
    view.rerender(page(released, true, api));
    expect(field(LIMITS.daily)).toHaveValue(3);
  });
});
