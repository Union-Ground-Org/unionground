import { expectPendingFocus } from "./helpers/busyWriteFocus.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsView } from "../src/views/SettingsView.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { setKeyboardShortcutsScope } from "../src/lib/keyboardShortcuts.js";
import { setDemoAnalyticsEnabled } from "../src/lib/observability.js";
import { ENGAGEMENT_EMAIL_PREFERENCE_KEYS, NOTIFICATION_TOPIC_KEYS, REMINDER_PREFERENCE_KEYS } from "../src/lib/memberApi.js";

function renderSettings(lang, props = {}) {
  const data = {
    member: { initials: "MV", ...(props.member || {}) },
    roles: props.roles || [],
    organizationConfiguration: props.organizationConfiguration || null,
    staffMfa: props.staffMfa || null,
  };
  return render(
    <LanguageProvider lang={lang}>
      <SettingsView
        alt={props.alt}
        data={data}
        lang={lang}
        onLanguage={props.onLanguage || vi.fn()}
        onNotificationPrefs={props.onNotificationPrefs}
        onFocusSettings={props.onFocusSettings}
        push={props.push}
        onPushSubscribe={props.onPushSubscribe}
        onPushRefresh={props.onPushRefresh}
        onPushUnsubscribe={props.onPushUnsubscribe}
        loadCalendarFeedStatus={props.loadCalendarFeedStatus}
        onCalendarRotate={props.onCalendarRotate}
        onCalendarRevoke={props.onCalendarRevoke}
        onSignOut={props.onSignOut}
        signingOut={props.signingOut}
        onLoadSessions={props.onLoadSessions}
        onRevokeSession={props.onRevokeSession}
        onSignOutEverywhere={props.onSignOutEverywhere}
        authClient={props.authClient}
        onMfaChanged={props.onMfaChanged}
        sessionDemo={props.sessionDemo}
        sharedAccount={props.sharedAccount}
        canNavigateView={props.canNavigateView}
        memberHatOpensHeldPlanes={props.memberHatOpensHeldPlanes}
      />
    </LanguageProvider>,
  );
}

const ALL_ON = Object.fromEntries(NOTIFICATION_TOPIC_KEYS.map((key) => [key, true]));
// Union Ground leaves dues out, so a dues topic is never offered even while
// the shared persistence list still names it. Every count below is derived
// from the topics the screen actually offers.
const OFFERED_TOPIC_KEYS = NOTIFICATION_TOPIC_KEYS.filter((key) => key !== "dues");

describe.each([
  [false, "en", "You are not in a campaign.", /You can enter your own worksite, shift or job classification/, "Use keyboard shortcuts"],
  [true, "es", "No perteneces a ninguna campaña.", /Puedes escribir tu propio lugar de trabajo, turno o clasificación laboral/, "Usar atajos de teclado"],
])("focused worker Settings (alt=%s, %s)", (alt, lang, noChapter, suggestions, shortcutLabel) => {
  const renderPage = (path, { member = {}, profileDetailsApi } = {}) => {
    window.history.replaceState({}, "", path);
    return render(
      <LanguageProvider lang={lang}>
        <WorkspacePages view="settings" location={path} navigate={vi.fn()} hat="member" menu={false}>
          <SettingsView alt={alt} data={{ member }} lang={lang} onLanguage={vi.fn()} profileDetailsApi={profileDetailsApi} />
        </WorkspacePages>
      </LanguageProvider>,
    );
  };

  it("shows campaign status and explains editable workplace suggestions on Profile & campaign", async () => {
    const location = window.location.href;
    try {
      renderPage("/m/settings/profile", { member: { chapterId: "", chapterName: "" }, profileDetailsApi: {
        load: vi.fn().mockResolvedValue({ detailsVisibility: "only_me", phoneVisibility: "only_me" }),
      } });
      expect(await screen.findByText(suggestions)).toBeVisible();
      expect(screen.getByText(noChapter)).toBeVisible();
      expect(screen.queryByText(/Feature switches & limits|Funciones y límites/)).not.toBeInTheDocument();
    } finally {
      window.history.replaceState({}, "", location);
    }
  });

  it("keeps the keyboard shortcuts switch on the overview and out of Language", () => {
    const location = window.location.href;
    setKeyboardShortcutsScope("fictional-settings-scope");
    try {
      const language = renderPage("/m/settings/language");
      expect(screen.getByRole("switch", { name: /Spanish|Español/ })).toBeVisible();
      expect(screen.queryByRole("switch", { name: shortcutLabel })).not.toBeInTheDocument();
      language.unmount();
      renderPage("/m/settings");
      expect(screen.getByRole("switch", { name: shortcutLabel })).toBeVisible();
    } finally {
      setKeyboardShortcutsScope(null);
      window.history.replaceState({}, "", location);
    }
  });
});

describe.each([false, true])('notification delivery copy with alternate shell %s', (alt) => {
  it.each([
    ['en', false], ['en', true], ['es', false], ['es', true],
  ])('separates the cap exception from delivery in %s with supported channel %s', (lang, supported) => {
    const onNotificationPrefs = vi.fn();
    const onPushSubscribe = vi.fn();
    const onPushUnsubscribe = vi.fn();
    renderSettings(lang, { alt, onNotificationPrefs, onPushSubscribe, onPushUnsubscribe,
      push: { supported, subscribed: supported, denied: false } });
    expect(screen.getByText(lang === 'es'
      ? 'Limitamos los avisos a 5 por semana. Las alertas de plazos no cuentan para este límite. La entrega requiere un canal disponible y configurado, y conexión.'
      : 'We cap nudges at 5 per week. Deadline alerts are exempt from this cap. Delivery still needs an available, configured channel and a connection.')).toBeInTheDocument();
    const pushSwitch = screen.queryByRole('switch', { name: lang === 'es' ? 'Notificaciones push' : 'Push notifications' });
    if (supported) expect(pushSwitch).toHaveAttribute('aria-checked', 'true');
    else expect(pushSwitch).not.toBeInTheDocument();
    expect(onNotificationPrefs).not.toHaveBeenCalled();
    expect(onPushSubscribe).not.toHaveBeenCalled();
    expect(onPushUnsubscribe).not.toHaveBeenCalled();
  });
});

// The switch is styled by class, and `.settings-switch` once named BOTH the
// full-width row and an older 46px pill toggle. Two rules under one name meant
// the later (pill) rule silently won and every topic row collapsed to a
// 46px-wide button with its label clipped. The More-hub rebuild retired that
// name and split the two jobs — `.morehub-row` is the full-width row,
// `.morehub-toggle` is the deliberate 46px iOS pill — so the pin moves with
// it: each name defined exactly once, each with its intended width. Nothing
// in a JSDOM render catches a stylesheet collision, so pin the stylesheet.
describe("settings switch styling", () => {
  it.each([["en", "time unavailable"], ["es", "hora no disponible"]])("labels session instants Eastern and handles missing times in %s", async (lang, unavailable) => {
    const rows = ["2026-01-15T17:05:00Z", "2026-07-15T17:05:00Z", null, "invalid"].map((lastActiveAt, id) => ({ handle: `${id}`.repeat(64), deviceLabel: "windows_computer", browserLabel: "chrome", lastActiveAt }));
    const { container } = renderSettings(lang, { onLoadSessions: vi.fn().mockResolvedValue(rows) });
    await waitFor(() => expect(container.querySelectorAll(".setin-session")).toHaveLength(4));
    const times = [...container.querySelectorAll(".setin-session time")];
    expect(times.map((time) => time.dateTime).sort()).toEqual(["2026-01-15T17:05:00.000Z", "2026-07-15T17:05:00.000Z"]);
    expect(times.map((time) => time.textContent).join(" ")).toContain("12:05");
    expect(times.map((time) => time.textContent).join(" ")).toContain("1:05");
    expect(times.every((time) => time.textContent.endsWith(" ET"))).toBe(true);
    expect(screen.getAllByText(new RegExp(unavailable))).toHaveLength(2);
  });
  // jsdom does not expose a file-scheme import.meta.url, so resolve from cwd.
  const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

  it("defines the row and the pill exactly once each so no later rule overrides them", () => {
    expect(css.match(/^\.morehub-row\s*\{/gm) || []).toHaveLength(1);
    expect(css.match(/^\.morehub-toggle\s*\{/gm) || []).toHaveLength(1);
    // The retired name must stay gone — reintroducing it is how the original
    // collision happened.
    expect(css).not.toContain(".settings-switch");
  });

  it("lays the row out full-width and keeps the fixed 56px hit target on the pill only", () => {
    const row = css.match(/^\.morehub-row\s*\{([^}]*)\}/m)[1];
    expect(row).toContain("width: 100%");
    expect(row).not.toMatch(/width:\s*56px/);
    // Unified switch geometry (2026-08-04): 56x44 hit target over a 48x28
    // track drawn on ::before — same spec as .sg-switch and .kan-watch.
    const pill = css.match(/^\.morehub-toggle\s*\{([^}]*)\}/m)[1];
    expect(pill).toMatch(/width:\s*56px/);
    expect(pill).toMatch(/height:\s*44px/);
  });
});

describe("settings view", () => {
  it("shows the ten newest sessions and expands older rows without changing history", async () => {
    const sessions = Array.from({ length: 12 }, (_, index) => ({
      handle: `device-${index}`, deviceLabel: index === 11 ? "windows_computer" : "apple_mobile",
      browserLabel: "chrome", lastActiveAt: `2026-08-${String(index + 1).padStart(2, "0")}T12:00:00Z`,
    }));
    const original = [...sessions];
    const onRevokeSession = vi.fn();
    const { container } = renderSettings("en", { onLoadSessions: vi.fn().mockResolvedValue(sessions), onRevokeSession });
    const toggle = await screen.findByRole("button", { name: "Show all (12)" });
    expect(container.querySelectorAll(".setin-session")).toHaveLength(10);
    expect(container.querySelector(".setin-session")).toHaveTextContent("Windows computer");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(toggle.getAttribute("aria-controls"))).toContainElement(container.querySelector(".setin-session"));
    toggle.focus();
    fireEvent.click(toggle);
    expect(container.querySelectorAll(".setin-session")).toHaveLength(12);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName("Show 10 most recent");
    fireEvent.click(toggle);
    expect(container.querySelectorAll(".setin-session")).toHaveLength(10);
    expect(toggle).toHaveFocus();
    expect(sessions).toEqual(original);
    expect(onRevokeSession).not.toHaveBeenCalled();
  });

  it("states the organization weekly nudge cap in English and Spanish", () => {
    const props = {
      onNotificationPrefs: vi.fn(),
      organizationConfiguration: { switches: { "limits.notifications.member_weekly_nudges": 9 } },
    };
    const english = renderSettings("en", props);
    expect(screen.getByText("We cap nudges at 9 per week. Deadline alerts are exempt from this cap. Delivery still needs an available, configured channel and a connection.")).toBeInTheDocument();
    english.unmount();
    renderSettings("es", props);
    expect(screen.getByText("Limitamos los avisos a 9 por semana. Las alertas de plazos no cuentan para este límite. La entrega requiere un canal disponible y configurado, y conexión.")).toBeInTheDocument();
  });

  // Superseded rule (design Step 2): "offers members the shared app-theme
  // registry and reports default or theme selections upward". The owner
  // retired the five selectable palettes on October 3, 2026 (one identity
  // everywhere; dark mode follows the system setting), so Settings offers none.
  it("offers no app-theme picker, even to an old caller that still passes a setter", () => {
    const onSelectAppTheme = vi.fn();
    render(
      <LanguageProvider lang="en">
        <SettingsView data={{ member: { initials: "MV" }, roles: [] }} lang="en" onLanguage={vi.fn()} appTheme="night-shift" onSelectAppTheme={onSelectAppTheme} />
      </LanguageProvider>,
    );
    expect(screen.queryByRole("radiogroup", { name: "App theme" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Night Shift" })).not.toBeInTheDocument();
    expect(onSelectAppTheme).not.toHaveBeenCalled();
  });

  // The tasks row renders for EVERYONE: the board is staff-only but the
  // assignee roster has no role filter, so a role-less member can be handed
  // a task and notified — hiding the toggle from exactly that member would
  // make the notice unmutable for its least-consenting audience.
  it("offers a role-less worker every persistable topic, tasks included", () => {
    renderSettings("en", { onNotificationPrefs: vi.fn(), member: { notificationPrefs: ALL_ON } });
    // One switch per persistable topic, plus exactly two that are NOT topics:
    // the always-present product analytics switch and Español language pill.
    expect(screen.getAllByRole("switch")).toHaveLength(OFFERED_TOPIC_KEYS.length + ENGAGEMENT_EMAIL_PREFERENCE_KEYS.length + REMINDER_PREFERENCE_KEYS.length + 2);
    expect(screen.getByRole("switch", { name: "Campaign work" })).toBeInTheDocument();
  });

  it("offers a staff worker the tasks topic, wired to its own key", async () => {
    const onNotificationPrefs = vi.fn().mockResolvedValue(null);
    renderSettings("en", { onNotificationPrefs, roles: ["coordinator"], member: { notificationPrefs: ALL_ON } });
    expect(screen.getAllByRole("switch")).toHaveLength(OFFERED_TOPIC_KEYS.length + ENGAGEMENT_EMAIL_PREFERENCE_KEYS.length + REMINDER_PREFERENCE_KEYS.length + 2);
    const toggle = screen.getByRole("switch", { name: "Campaign work" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    // The write carries the WHOLE object with tasks flipped false — an
    // explicit false, never a deleted key (absent means enabled).
    await waitFor(() => expect(onNotificationPrefs).toHaveBeenCalledWith({ ...ALL_ON, tasks: false }));
  });

  it("never offers a dues topic in either language", () => {
    const english = renderSettings("en", { onNotificationPrefs: vi.fn(), member: { notificationPrefs: ALL_ON } });
    expect(screen.queryByRole("switch", { name: "Dues" })).toBeNull();
    expect(screen.queryByText("Payment reminders and account updates.")).toBeNull();
    english.unmount();
    renderSettings("es", { onNotificationPrefs: vi.fn(), member: { notificationPrefs: ALL_ON } });
    expect(screen.queryByRole("switch", { name: "Cuotas" })).toBeNull();
  });

  // SEC-UG-ENGAGEMENT-EMAIL-OPT-OUT-UNSUBSCRIBE-20261001: the choice the
  // one-click unsubscribe link turns off is visible and reversible here.
  it("shows the union email choices an unsubscribe link turned off, in both languages", async () => {
    const onNotificationPrefs = vi.fn().mockResolvedValue(null);
    const english = renderSettings("en", { onNotificationPrefs, member: { notificationPrefs: { ...ALL_ON, announcements: false } } });
    expect(screen.getByText("Email from your campaign")).toBeInTheDocument();
    const announcements = screen.getByRole("switch", { name: "Announcements" });
    expect(announcements).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch", { name: "Surveys" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(announcements);
    // Re-enabling writes exactly that choice; the other stays as stored.
    await waitFor(() => expect(onNotificationPrefs).toHaveBeenCalledWith({ ...ALL_ON, announcements: true }));

    english.unmount();
    renderSettings("es", { onNotificationPrefs, member: { notificationPrefs: ALL_ON } });
    expect(screen.getByText("Correo de tu campaña")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Encuestas" })).toHaveAttribute("aria-checked", "true");
  });

  // REQ-UG-WELCOME-SEQUENCE-SCHEDULER-20261001: welcome mail has its own
  // switch; until the member sets it, it follows announcements (as the server does).
  it("shows a welcome email switch that follows announcements until set, and writes only that choice", async () => {
    const onNotificationPrefs = vi.fn().mockResolvedValue(null);
    const english = renderSettings("en", { onNotificationPrefs, member: { notificationPrefs: { ...ALL_ON, announcements: false } } });
    const welcome = screen.getByRole("switch", { name: "Welcome messages" });
    expect(welcome).toHaveAttribute("aria-checked", "false");
    fireEvent.click(welcome);
    await waitFor(() => expect(onNotificationPrefs).toHaveBeenCalledWith({ ...ALL_ON, welcome: true }));
    english.unmount();
    renderSettings("es", { onNotificationPrefs, member: { notificationPrefs: { ...ALL_ON, announcements: false, welcome: true } } });
    expect(screen.getByRole("switch", { name: "Mensajes de bienvenida" })).toHaveAttribute("aria-checked", "true");
  });

  it("never writes a union email choice when the worker flips a topic", async () => {
    const onNotificationPrefs = vi.fn().mockResolvedValue(null);
    renderSettings("en", { onNotificationPrefs, member: { notificationPrefs: { ...ALL_ON, surveys: true } } });
    fireEvent.click(screen.getByRole("switch", { name: "Deadlines" }));
    await waitFor(() => expect(onNotificationPrefs).toHaveBeenCalledWith({ ...ALL_ON, deadlines: false }));
  });

  it("renders an unset topic as on, matching absent-means-enabled in the trigger", () => {
    // Every one of the ~100k existing profiles predates the forms topic and has
    // no `forms` key at all.
    renderSettings("en", { onNotificationPrefs: vi.fn(), member: { notificationPrefs: { deadlines: true, cases: true, votes: true, events: true } } });
    expect(screen.getByRole("switch", { name: "Form updates" })).toHaveAttribute("aria-checked", "true");
  });

  it("renders the language section in English", () => {
    renderSettings("en");
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    // The prototype replaces the EN/ES segmented control with ONE "Español"
    // switch: named from OUTSIDE the pill (aria-labelledby), off in English,
    // no visible text inside the control, subtext exposed as the description.
    // The fake-tab ban from the a11y sweep (2026-07-28) still holds screenwide.
    const toggle = screen.getByRole("switch", { name: "Español" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle.textContent).toBe("");
    expect(toggle).toHaveAccessibleDescription("Switch the whole app — change anytime");
    expect(screen.queryAllByRole("tab")).toEqual([]);
  });

  it("renders in Spanish when the language is es", () => {
    renderSettings("es");
    expect(screen.getByRole("heading", { level: 1, name: "Ajustes" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Español" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Cambia toda la app — vuelve cuando quieras")).toBeInTheDocument();
  });

  it("switches language through onLanguage, both directions", () => {
    // A single switch must toggle BOTH ways — a pill that only ever sends "es"
    // would strand Spanish speakers with no way back.
    const onLanguage = vi.fn();
    const first = renderSettings("en", { onLanguage });
    fireEvent.click(screen.getByRole("switch", { name: "Español" }));
    expect(onLanguage).toHaveBeenCalledWith("es");
    first.unmount();
    renderSettings("es", { onLanguage });
    fireEvent.click(screen.getByRole("switch", { name: "Español" }));
    expect(onLanguage).toHaveBeenLastCalledWith("en");
  });

  it("shows a bilingual browser-level product analytics opt-out on every account", () => {
    window.localStorage.removeItem("sg-demo-analytics-disabled");
    const english = renderSettings("en");
    const toggle = screen.getByRole("switch", { name: "Share product analytics" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAccessibleDescription(/Turning this off stops capture immediately in every tab of this browser/);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(window.localStorage.getItem("sg-demo-analytics-disabled")).toBe("true");

    english.unmount();
    renderSettings("es");
    expect(screen.getByRole("switch", { name: "Compartir analítica de producto" }))
      .toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/la captura se detiene de inmediato/)).toBeInTheDocument();

    window.localStorage.removeItem("sg-demo-analytics-disabled");
  });

  it("follows a change made outside this Settings page, such as another tab", () => {
    window.localStorage.removeItem("sg-demo-analytics-disabled");
    renderSettings("en");
    const toggle = screen.getByRole("switch", { name: "Share product analytics" });
    act(() => { setDemoAnalyticsEnabled(false); });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    act(() => { setDemoAnalyticsEnabled(true); });
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("says when the browser could not save the analytics choice", () => {
    window.localStorage.removeItem("sg-demo-analytics-disabled");
    const refuse = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    renderSettings("en");
    const toggle = screen.getByRole("switch", { name: "Share product analytics" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("status")).toHaveTextContent("This browser could not save the choice.");
    refuse.mockRestore();
    fireEvent.click(toggle);
    expect(screen.queryByText(/could not save the choice/)).not.toBeInTheDocument();
    window.localStorage.removeItem("sg-demo-analytics-disabled");
  });

  it("keeps the product analytics opt-out reachable before the worker snapshot loads", () => {
    render(
      <LanguageProvider lang="en">
        <SettingsView data={{}} lang="en" onLanguage={vi.fn()} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("switch", { name: "Share product analytics" })).toBeInTheDocument();
  });

  it("shows the worker's campaign when one is resolved", () => {
    renderSettings("en", { member: { chapterName: "Harborview Care United" } });
    expect(screen.getByText("Your campaign")).toBeInTheDocument();
    expect(screen.getByText("Harborview Care United")).toBeInTheDocument();
  });

  it.each([
    { chapterId: "fictional-chapter" },
    { chapterMemberships: [{ chapterId: "fictional-chapter" }] },
  ])("does not report a missing campaign when membership is known (%j)", (member) => {
    renderSettings("en", { member });
    expect(screen.queryByText("Your campaign")).not.toBeInTheDocument();
    expect(screen.queryByText("You are not in a campaign.")).not.toBeInTheDocument();
  });

  it("shows no campaign section before the worker loads", () => {
    render(
      <LanguageProvider lang="en">
        <SettingsView data={{}} lang="en" onLanguage={vi.fn()} />
      </LanguageProvider>,
    );
    expect(screen.queryByText("Your campaign")).not.toBeInTheDocument();
    expect(screen.queryByText("You are not in a campaign.")).not.toBeInTheDocument();
  });

  it("hides the calendar section when the feed handlers are not wired", () => {
    renderSettings("en");
    expect(screen.queryByText("Calendar")).not.toBeInTheDocument();
  });

  it("hides the notifications section when the prefs handler is not wired", () => {
    renderSettings("en");
    // No writer, no topic switches: a toggle that cannot persist must not
    // render. The survivors are the deliberate always-on product analytics
    // switch (browser-local, so it always persists) and the language pill.
    expect(screen.queryByText("By topic")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Deadlines" })).not.toBeInTheDocument();
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(2);
    expect(screen.getByRole("switch", { name: "Share product analytics" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Español" })).toBeInTheDocument();
  });

  it("renders one switch per topic reflecting the worker's saved prefs", () => {
    renderSettings("en", {
      onNotificationPrefs: vi.fn(),
      member: { notificationPrefs: { deadlines: false, cases: true, forms: true, votes: true, events: true } },
    });
    expect(screen.getByText("By topic")).toBeInTheDocument();
    // Derived, not hardcoded: this pin predated the sixth topic and its
    // literal 5 was the last place claiming the list had five members.
    // (+2 = the product analytics switch and the language pill, the only
    // non-topic switches on the screen.)
    expect(screen.getAllByRole("switch")).toHaveLength(OFFERED_TOPIC_KEYS.length + ENGAGEMENT_EMAIL_PREFERENCE_KEYS.length + REMINDER_PREFERENCE_KEYS.length + 2);
    expect(screen.getByRole("switch", { name: "Deadlines" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch", { name: "Issue updates" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Form updates" })).toHaveAttribute("aria-checked", "true");
  });

  // Form approvals are not case movement, and a member who silences case mail
  // should still hear that their FMLA request came back.
  it("separates form updates from issue updates", () => {
    renderSettings("en", { onNotificationPrefs: vi.fn() });
    expect(screen.getByRole("switch", { name: "Form updates" })).toBeInTheDocument();
    expect(screen.getByText("Approvals, returns and co-signatures")).toBeInTheDocument();
  });

  // The accessible name must not carry the state: it duplicates aria-checked,
  // renames the control on every toggle, and hides the description.
  it("keeps a stable accessible name and exposes the subtext as a description", () => {
    renderSettings("en", { onNotificationPrefs: vi.fn(), member: { notificationPrefs: { ...ALL_ON, cases: false } } });
    const toggle = screen.getByRole("switch", { name: "Issue updates" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAccessibleDescription("Movement on issues you're part of");
  });

  // Every switch must be wired to its own key: a copy-paste slip that pointed
  // two buttons at one topic would otherwise pass a render-and-count test.
  it.each([
    ["Deadlines", "deadlines"],
    ["Issue updates", "cases"],
    ["Form updates", "forms"],
    ["Votes & polls", "votes"],
    ["Meetings", "events"],
  ])("toggles %s independently and sends the whole flipped object", async (label, key) => {
    const onNotificationPrefs = vi.fn().mockResolvedValue(null);
    renderSettings("en", { onNotificationPrefs });
    fireEvent.click(screen.getByRole("switch", { name: label }));
    await waitFor(() => expect(onNotificationPrefs).toHaveBeenCalledWith({ ...ALL_ON, [key]: false }));
  });

  it("reverts the switch when the prefs write fails", async () => {
    const onNotificationPrefs = vi.fn().mockRejectedValue(new Error("save failed"));
    renderSettings("en", { onNotificationPrefs });
    fireEvent.click(screen.getByRole("switch", { name: "Deadlines" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Deadlines" })).toHaveAttribute("aria-checked", "true"));
  });

  // Two writes in flight both send the whole object, so the later one wins and
  // silently re-enables whatever the earlier one turned off — mail the member
  // believes they stopped.
  it.each([false, true])("keeps the initiating switch focused and refuses a second toggle while a write is in flight (alt=%s)", async (alt) => {
    let release;
    const onNotificationPrefs = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    renderSettings("en", { alt, onNotificationPrefs });

    const control = screen.getByRole("switch", { name: "Issue updates" });
    control.focus();
    fireEvent.click(control);
    await expectPendingFocus(control);
    fireEvent.click(screen.getByRole("switch", { name: "Deadlines" }));
    expect(onNotificationPrefs).toHaveBeenCalledTimes(1);
    expect(onNotificationPrefs).toHaveBeenCalledWith({ ...ALL_ON, cases: false });
    expect(screen.getByRole("switch", { name: "Deadlines" })).toHaveAttribute("aria-checked", "true");

    release(null);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Deadlines" })).not.toBeDisabled());
    await waitFor(() => expect(screen.getByRole("switch", { name: "Deadlines" })).not.toHaveAttribute("aria-disabled", "true"));

    fireEvent.click(screen.getByRole("switch", { name: "Deadlines" }));
    await waitFor(() => expect(onNotificationPrefs).toHaveBeenLastCalledWith({ ...ALL_ON, cases: false, deadlines: false }));
  });

  it("offers vetted IANA zones and persists the selected focus settings", async () => {
    const onFocusSettings = vi.fn().mockResolvedValue(null);
    renderSettings("en", {
      onFocusSettings,
      member: {
        dndEnabled: false,
        quietHoursStart: "22:00",
        quietHoursEnd: "07:00",
        quietHoursTimezone: "America/New_York",
        urgentNotificationsEnabled: true,
      },
    });
    const timezone = screen.getByRole("combobox", { name: "Time zone" });
    expect(screen.getByRole("option", { name: "Eastern — New York" })).toHaveValue("America/New_York");
    expect(screen.getByRole("option", { name: "Pacific — Los Angeles" })).toHaveValue("America/Los_Angeles");
    fireEvent.change(timezone, { target: { value: "America/Los_Angeles" } });
    fireEvent.click(screen.getByRole("button", { name: "Save quiet hours" }));
    await waitFor(() => expect(onFocusSettings).toHaveBeenCalledWith({
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
      quietHoursTimezone: "America/Los_Angeles",
      urgentNotificationsEnabled: true,
    }));
  });

  // UX-UG-SETTINGS-QUIET-HOURS-TIMEZONE-ENGLISH-ES-20260920. The chip's
  // meridiem and the ten zone labels were inline English literals, so a Spanish
  // More hub rendered "10:00 PM" and "Pacific — Los Angeles" on a form whose
  // every other label was translated. Both now come from the catalogue — and
  // the English rendering, and every option VALUE, must not move with them.
  const QUIET_MEMBER = {
    dndEnabled: false,
    quietHoursStart: "22:00",
    quietHoursEnd: "06:00",
    quietHoursTimezone: "America/New_York",
    urgentNotificationsEnabled: true,
  };

  it("renders the quiet-hours chip and zone labels in Spanish without moving the stored ids", () => {
    const { container } = renderSettings("es", { onFocusSettings: vi.fn(), member: QUIET_MEMBER });

    const chip = container.querySelector(".setin-chip");
    expect(chip.textContent).toBe("10:00 p.\u00a0m. — 6:00 a.\u00a0m.");
    expect(chip.textContent).not.toContain("AM");
    expect(chip.textContent).not.toContain("PM");

    const timezone = screen.getByRole("combobox", { name: "Zona horaria" });
    const options = [...timezone.options].map((option) => [option.value, option.textContent]);
    expect(options).toEqual([
      ["America/New_York", "Este — Nueva York"],
      ["America/Chicago", "Centro — Chicago"],
      ["America/Denver", "Montaña — Denver"],
      ["America/Phoenix", "Montaña — Phoenix (sin horario de verano)"],
      ["America/Los_Angeles", "Pacífico — Los Ángeles"],
      ["America/Anchorage", "Alaska — Anchorage"],
      ["Pacific/Honolulu", "Hawái — Honolulu"],
      ["America/Puerto_Rico", "Atlántico — Puerto Rico"],
      ["America/Detroit", "Este — Detroit"],
      ["America/Indiana/Indianapolis", "Este — Indianápolis"],
    ]);
    // No Spanish label may still be the English string it replaced.
    expect(options.map(([, label]) => label)).not.toContain("Pacific — Los Angeles");
    expect(timezone).toHaveValue("America/New_York");
  });

  it("leaves the English quiet-hours chip and zone labels exactly as they were", () => {
    const { container } = renderSettings("en", { onFocusSettings: vi.fn(), member: QUIET_MEMBER });

    expect(container.querySelector(".setin-chip").textContent).toBe("10:00 PM — 6:00 AM");
    const timezone = screen.getByRole("combobox", { name: "Time zone" });
    expect([...timezone.options].map((option) => [option.value, option.textContent])).toEqual([
      ["America/New_York", "Eastern — New York"],
      ["America/Chicago", "Central — Chicago"],
      ["America/Denver", "Mountain — Denver"],
      ["America/Phoenix", "Mountain — Phoenix (no DST)"],
      ["America/Los_Angeles", "Pacific — Los Angeles"],
      ["America/Anchorage", "Alaska — Anchorage"],
      ["Pacific/Honolulu", "Hawaii — Honolulu"],
      ["America/Puerto_Rico", "Atlantic — Puerto Rico"],
      ["America/Detroit", "Eastern — Detroit"],
      ["America/Indiana/Indianapolis", "Eastern — Indianapolis"],
    ]);
  });

  it("keeps a saved zone outside the ten selectable in both languages", () => {
    for (const lang of ["en", "es"]) {
      const { unmount } = renderSettings(lang, {
        onFocusSettings: vi.fn(),
        member: { ...QUIET_MEMBER, quietHoursTimezone: "America/Juneau" },
      });
      const timezone = screen.getByRole("combobox", { name: lang === "es" ? "Zona horaria" : "Time zone" });
      expect([...timezone.options][0]).toHaveValue("America/Juneau");
      expect(timezone).toHaveValue("America/Juneau");
      unmount();
    }
  });

  it("does not flip DND when the server rejects the save", async () => {
    const onFocusSettings = vi.fn().mockRejectedValue(new Error("save failed"));
    renderSettings("en", { onFocusSettings, member: { dndEnabled: false } });
    const dnd = screen.getByRole("switch", { name: /^Do not disturb/ });
    fireEvent.click(dnd);
    await waitFor(() => expect(onFocusSettings).toHaveBeenCalledWith({ dndEnabled: true }));
    expect(dnd).toHaveAttribute("aria-checked", "false");
  });

  it("shows the unsupported note instead of the push switch when push is unavailable", () => {
    renderSettings("en", { onNotificationPrefs: vi.fn(), push: { supported: false, subscribed: false, denied: false } });
    expect(screen.getByText("Push isn't available in this browser.")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Push notifications" })).not.toBeInTheDocument();
  });

  it("shows the blocked note when the browser permission is denied", () => {
    renderSettings("en", { onNotificationPrefs: vi.fn(), push: { supported: true, subscribed: false, denied: true } });
    expect(screen.getByText(/blocked for this site/)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Push notifications" })).not.toBeInTheDocument();
  });

  it("offers the existing-registration refresh action in Spanish without a disable step", async () => {
    const onPushRefresh = vi.fn().mockResolvedValue(null);
    const onPushUnsubscribe = vi.fn();
    renderSettings("es", { push: { supported: true, subscribed: true, denied: false }, onPushRefresh, onPushUnsubscribe });
    const refresh = screen.getByRole("button", { name: "Actualizar registro push" });
    expect(refresh).toHaveAccessibleDescription("Vincula el registro push de este dispositivo a tu sesión actual.");
    fireEvent.click(refresh);
    await waitFor(() => expect(onPushRefresh).toHaveBeenCalledOnce());
    expect(onPushUnsubscribe).not.toHaveBeenCalled();
  });

  it("enables push through onPushSubscribe and offers the off switch when subscribed", async () => {
    // The old enable/disable buttons are now one per-device switch: off means
    // clicking subscribes, on means clicking unsubscribes.
    const onPushSubscribe = vi.fn().mockResolvedValue(null);
    const first = renderSettings("en", { onNotificationPrefs: vi.fn(), push: { supported: true, subscribed: false, denied: false }, onPushSubscribe });
    const pushToggle = screen.getByRole("switch", { name: "Push notifications" });
    expect(pushToggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(pushToggle);
    await waitFor(() => expect(onPushSubscribe).toHaveBeenCalled());

    // Unmount before the second copy: the switch is named via aria-labelledby,
    // and two mounted copies of the view would collide on the label id.
    first.unmount();
    const onPushUnsubscribe = vi.fn().mockResolvedValue(null);
    renderSettings("es", { onNotificationPrefs: vi.fn(), push: { supported: true, subscribed: true, denied: false }, onPushUnsubscribe });
    const offToggle = screen.getByRole("switch", { name: "Notificaciones push" });
    expect(offToggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(offToggle);
    await waitFor(() => expect(onPushUnsubscribe).toHaveBeenCalled());
  });

  // Demo mode has no session to end, so it passes no onSignOut — the row must
  // vanish, not render dead.
  it("shows sign-out only when a sign-out handler exists", () => {
    const onSignOut = vi.fn();
    const first = renderSettings("en", { onSignOut });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalled();
    first.unmount();
    renderSettings("en");
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it.each([false, true])("keeps ordinary sign-out retryable after a refusal (alt=%s)", async (alt) => {
    const onSignOut = vi.fn();
    renderSettings("en", { alt, onSignOut });
    for (const signOut of screen.getAllByRole("button", { name: "Sign out", exact: true })) {
      onSignOut.mockReset().mockRejectedValueOnce(new Error("cleanup refused")).mockResolvedValue(undefined);
      await act(async () => { fireEvent.click(signOut); });
      expect(onSignOut).toHaveBeenCalledTimes(1);
      expect(signOut).toBeEnabled();
      await act(async () => { fireEvent.click(signOut); });
      expect(onSignOut).toHaveBeenCalledTimes(2);
    }
  });

  // REQ-UG-FIRST-CLICK-AND-DEAD-CONTROLS-20261030: the row says the
  // sign-out is underway and takes no second click while it runs.
  it.each(["en", "es"])("shows a running sign-out on the Sign out row (%s)", async (lang) => {
    const onSignOut = vi.fn();
    renderSettings(lang, { onSignOut, signingOut: true });
    const row = screen.getByRole("button", { name: catalogue[lang]["app.signingOut"] });
    expect((row).closest('[aria-disabled="true"]')).not.toBeNull();
    await expectPendingFocus(row);
    expect(row).toHaveAttribute("aria-busy", "true");
    fireEvent.click(row);
    expect(onSignOut).not.toHaveBeenCalled();
  });

  // UB-UG-DEMO-STRAIGHT-IN-ENTRY-RESTORED-20261107: a shared SAMPLE
  // demo persona account belongs to every visitor at once.
  it("closes the security controls for a shared demo persona account", async () => {
    const authClient = {
      rpc: vi.fn(() => Promise.resolve({ data: { available: false, hasPin: false }, error: null })),
      auth: { updateUser: vi.fn(), mfa: { listFactors: vi.fn().mockResolvedValue({ data: { all: [], totp: [] }, error: null }) } },
    };
    const own = renderSettings("en", { authClient });
    expect(await screen.findByRole("button", { name: "Change password" })).toBeInTheDocument();
    own.unmount();
    renderSettings("en", { authClient, sharedAccount: true });
    await waitFor(() => expect(authClient.rpc).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Change password" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Turn on two-step sign-in" })).toBeNull();
    expect(authClient.auth.mfa.listFactors).toHaveBeenCalledTimes(1);
  });

  it("offers an administrator whose staff roles are restored the way back to Admin, and nobody else", async () => {
    const verified = [{ id: "totp-1", factor_type: "totp", status: "verified" }];
    const authClient = {
      rpc: vi.fn(() => Promise.resolve({ data: { available: false, hasPin: false }, error: null })),
      auth: { updateUser: vi.fn(), mfa: { listFactors: vi.fn().mockResolvedValue({ data: { all: verified, totp: verified }, error: null }) } },
    };
    const staffMfa = { required: true, holdsStaffRole: true, enrolled: true, blocked: false, suspendedRoles: [] };
    const admin = renderSettings("en", { authClient, staffMfa, roles: ["admin"] });
    expect(await screen.findByRole("link", { name: "Continue to Admin setup" })).toHaveAttribute("href", "/m/admin");
    admin.unmount();
    // Another staff hat is worn: the shell would refuse Admin, so no link is offered.
    const guarded = renderSettings("en", { authClient, staffMfa, roles: ["admin", "steward"], canNavigateView: (view) => view === "steward" });
    await screen.findByText(/Your organization requires two-step sign-in while you use a staff role/);
    expect(screen.queryByRole("link", { name: "Continue to Admin setup" })).toBeNull();
    guarded.unmount();
    // Under the Member hat the shell allows no staff view, yet on the SaaS
    // origin a held plane opens from Member: the shell says so explicitly.
    const member = renderSettings("en", { authClient, staffMfa, roles: ["admin", "steward"], canNavigateView: () => false, memberHatOpensHeldPlanes: true });
    expect(await screen.findByRole("link", { name: "Continue to Admin setup" })).toBeInTheDocument();
    member.unmount();
    // SAMPLE: a hat is a separate persona account, so Member cannot enter the
    // held Admin plane and the shell would bounce the link to Member Home.
    const sample = renderSettings("en", { authClient, staffMfa, roles: ["admin"], canNavigateView: () => false, memberHatOpensHeldPlanes: false });
    await screen.findByText(/Your organization requires two-step sign-in while you use a staff role/);
    expect(screen.queryByRole("link", { name: "Continue to Admin setup" })).toBeNull();
    sample.unmount();
    renderSettings("en", { authClient, staffMfa, roles: ["admin"], canNavigateView: () => true });
    expect(await screen.findByRole("link", { name: "Continue to Admin setup" })).toBeInTheDocument();
    cleanup();
    renderSettings("en", { authClient, staffMfa, roles: ["steward"] });
    await screen.findByText(/Your organization requires two-step sign-in while you use a staff role/);
    expect(screen.queryByRole("link", { name: "Continue to Admin setup" })).toBeNull();
  });

  it("asks the current hat guard about the actual setup-review return destination", async () => {
    const originalUrl = window.location.href;
    const target = "/m/admin/setup-review?union=olms-900000077&build=chapter";
    window.history.replaceState({}, "", `/m/settings/security?${new URLSearchParams({ setupReturnTo: target })}`);
    const verified = [{ id: "totp-1", factor_type: "totp", status: "verified" }];
    const authClient = { rpc: vi.fn().mockResolvedValue({ data: { available: false }, error: null }), auth: { mfa: { listFactors: vi.fn().mockResolvedValue({ data: { all: verified, totp: verified }, error: null }) } } };
    const staffMfa = { required: true, holdsStaffRole: true, enrolled: true, blocked: false };
    const canNavigateView = vi.fn((view, path) => view === "admin" && path === target);
    try {
      renderSettings("en", { authClient, staffMfa, roles: ["admin"], canNavigateView });
      expect(await screen.findByRole("link", { name: "Continue to Admin setup" })).toHaveAttribute("href", target);
      expect(canNavigateView).toHaveBeenCalledWith("admin", target);
    } finally {
      cleanup();
      window.history.replaceState({}, "", originalUrl);
    }
  });

  it("loads SMS readiness and persists explicit opt-in and opt-out without exposing the phone", async () => {
    const smsRpc = vi.fn()
      .mockResolvedValueOnce({ data: { activationStatus: "active", consented: false, phoneLast4: null }, error: null })
      .mockResolvedValueOnce({ data: { activationStatus: "active", consented: true, phoneLast4: "0123" }, error: null })
      .mockResolvedValueOnce({ data: { activationStatus: "active", consented: false, phoneLast4: null }, error: null });
    const rpc = vi.fn((name, args) => name === "get_my_member_pin_status"
      ? Promise.resolve({ data: { available: false, hasPin: false }, error: null })
      : smsRpc(name, args));
    const authClient = {
      rpc,
      auth: { updateUser: vi.fn(), mfa: { listFactors: vi.fn().mockResolvedValue({ data: { all: [], totp: [] }, error: null }) } },
    };
    renderSettings("en", { authClient });

    expect(await screen.findByText(/Optional and off/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Mobile number (E.164)" }), { target: { value: "+15085550123" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn on SMS" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("set_my_sms_consent", {
      p_phone_e164: "+15085550123", p_consented: true,
    }));
    expect(await screen.findByText(/ending 0123/)).toBeInTheDocument();
    expect(screen.queryByText("+15085550123")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(rpc).toHaveBeenLastCalledWith("set_my_sms_consent", {
      p_phone_e164: null, p_consented: false,
    }));
  });

  it.each(["response", "rejected"])("reports SMS read and write failures without rendering stale consent (%s)", async (failure) => {
    const smsRpc = vi.fn();
    if (failure === "rejected") smsRpc.mockRejectedValueOnce(new Error("read failed"));
    else smsRpc.mockResolvedValueOnce({ data: null, error: new Error("read failed") });
    smsRpc.mockResolvedValueOnce({ data: { activationStatus: "active", consented: false }, error: null })
      .mockResolvedValueOnce({ data: null, error: new Error("write failed") });
    const rpc = vi.fn((name, args) => name === "get_my_member_pin_status"
      ? Promise.resolve({ data: { available: false, hasPin: false }, error: null })
      : smsRpc(name, args));
    const authClient = {
      rpc,
      auth: { updateUser: vi.fn(), mfa: { listFactors: vi.fn().mockResolvedValue({ data: { all: [], totp: [] }, error: null }) } },
    };
    const first = renderSettings("en", { authClient });
    expect(await screen.findByRole("alert")).toHaveTextContent("SMS status could not be refreshed");
    first.unmount();

    renderSettings("en", { authClient });
    await screen.findByRole("textbox", { name: "Mobile number (E.164)" });
    fireEvent.change(screen.getByRole("textbox", { name: "Mobile number (E.164)" }), { target: { value: "+15085550123" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn on SMS" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("SMS consent was not changed");
  });

  it("reads non-active SMS status from the catalogue, never the RPC's English publicMessage", async () => {
    const cases = [
      ["unset", "SMS is not configured for this campaign.", "SMS no está configurado para esta campaña."],
      ["error", "Admin note: provider credentials expired.", "El SMS está en pausa para esta campaña"],
      ["disabled", "Admin note: SMS retired for this campaign.", "El SMS está desactivado para esta campaña."],
    ];
    for (const [activationStatus, publicMessage, spanish] of cases) {
      const authClient = {
        rpc: vi.fn().mockResolvedValue({ data: { activationStatus, consented: false, publicMessage }, error: null }),
        auth: { updateUser: vi.fn(), mfa: { listFactors: vi.fn().mockResolvedValue({ data: { all: [], totp: [] }, error: null }) } },
      };
      const view = renderSettings("es", { authClient });
      await waitFor(() => expect(authClient.rpc).toHaveBeenCalledWith("get_my_sms_preference"));
      expect(await screen.findByText((content) => content.startsWith(spanish))).toBeInTheDocument();
      expect(screen.queryByText(publicMessage)).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it("validates and completes an in-session password change", async () => {
    const updateUser = vi.fn().mockResolvedValue({ error: null });
    const authClient = {
      rpc: vi.fn().mockResolvedValue({ data: { activationStatus: "unset", consented: false }, error: null }),
      auth: { updateUser, mfa: { listFactors: vi.fn().mockResolvedValue({ data: { all: [], totp: [] }, error: null }) } },
    };
    renderSettings("en", { authClient });
    const password = screen.getByLabelText("New password");
    const confirm = screen.getByLabelText("Confirm new password");
    const current = screen.getByLabelText("Current password");
    fireEvent.change(current, { target: { value: "old123" } });
    fireEvent.change(password, { target: { value: "long-password-one-long-enough" } });
    fireEvent.change(confirm, { target: { value: "long-password-two-long-enough" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The passwords do not match");
    expect(updateUser).not.toHaveBeenCalled();

    fireEvent.change(confirm, { target: { value: "long-password-one-long-enough" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(updateUser).toHaveBeenNthCalledWith(1, { password: "long-password-one-long-enough", current_password: "old123" }));
    await waitFor(() => expect(updateUser).toHaveBeenNthCalledWith(2, { data: { union_ground_password_issued_at: null } }));
    // The two-step status line on the same page is a status region too.
    await waitFor(() => expect(screen.getAllByRole("status").some((region) => region.textContent.includes("Your password was changed"))).toBe(true));
    expect(password).toHaveValue("");
    expect(confirm).toHaveValue("");
    expect(current).toHaveValue("");
  });

  it("keeps provider detail out of a failed password change", async () => {
    const updateUser = vi.fn().mockResolvedValue({ error: new Error("provider private detail") });
    const authClient = {
      rpc: vi.fn().mockResolvedValue({ data: { activationStatus: "unset", consented: false }, error: null }),
      auth: { updateUser, mfa: { listFactors: vi.fn().mockResolvedValue({ data: { all: [], totp: [] }, error: null }) } },
    };
    renderSettings("en", { authClient });
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old123" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "long-password-one-long-enough" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "long-password-one-long-enough" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your password change could not be confirmed. Check your connection and try again.");
    expect(screen.queryByText(/provider private detail/)).not.toBeInTheDocument();
  });

  it.each([
    ["a stale-session refusal", async () => ({ error: Object.assign(new Error("reauth"), { code: "reauthentication_needed" }) }), "Your password was not changed. For your security, changing it needs a recent sign-in: sign out, sign in again, then try once more."],
    ["a dropped connection", async () => { throw new TypeError("Failed to fetch"); }, "Your password change could not be confirmed. Check your connection and try again."],
  ])("names the remedy that fits %s", async (_label, outcome, expected) => {
    const updateUser = vi.fn(outcome);
    const authClient = {
      rpc: vi.fn().mockResolvedValue({ data: { activationStatus: "unset", consented: false }, error: null }),
      auth: { updateUser, mfa: { listFactors: vi.fn().mockResolvedValue({ data: { all: [], totp: [] }, error: null }) } },
    };
    renderSettings("en", { authClient });
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old123" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "long-password-one-long-enough" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "long-password-one-long-enough" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(expected);
  });

  it("loads coarse session rows, marks current, and states the native timeout policy", async () => {
    const onLoadSessions = vi.fn().mockResolvedValue([
      { handle: "a".repeat(64), deviceLabel: "windows_computer", browserLabel: "chrome", current: true, createdAt: "2026-08-10T12:00:00Z", lastActiveAt: "2026-08-12T12:00:00Z" },
      { handle: "b".repeat(64), deviceLabel: "apple_mobile", browserLabel: "safari", current: false, createdAt: "2026-08-09T12:00:00Z", lastActiveAt: "2026-08-11T12:00:00Z" },
    ]);
    renderSettings("en", { onLoadSessions, onRevokeSession: vi.fn(), onSignOutEverywhere: vi.fn() });
    expect(screen.getByText("Loading signed-in devices…")).toBeInTheDocument();
    expect(await screen.findByText("Windows computer · Chrome")).toBeInTheDocument();
    expect(screen.getByText(/Current session · Last active/)).toBeInTheDocument();
    expect(screen.getByText("Apple mobile device · Safari")).toBeInTheDocument();
    const windowsRow = screen.getByText("Windows computer · Chrome").closest(".setin-session-row");
    const mobileRow = screen.getByText("Apple mobile device · Safari").closest(".setin-session-row");
    expect(windowsRow.querySelector(".lucide-monitor")).not.toBeNull();
    expect(mobileRow.querySelector(".lucide-smartphone")).not.toBeNull();
    expect(screen.getByText(/8 hours without activity.*7 days.*up to 1 hour/i)).toBeInTheDocument();
    expect(screen.queryByText("a".repeat(64))).not.toBeInTheDocument();
    expect(screen.queryByText(/192\.0\.2\./)).not.toBeInTheDocument();
  });

  it("uses a bounded in-session device fixture for the SAMPLE tour", () => {
    renderSettings("en", { sessionDemo: true });
    expect(screen.getAllByText("PREVIEW")).toHaveLength(2);
    expect(screen.getByText(/No real account or device is shown/i)).toBeInTheDocument();
    expect(screen.queryByText(/Loading signed-in devices/i)).not.toBeInTheDocument();
  });

  it("confirms a selected remote revoke, focuses the decision, and removes only that row", async () => {
    let finish;
    const onRevokeSession = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    renderSettings("en", {
      onLoadSessions: vi.fn().mockResolvedValue([
        { handle: "a".repeat(64), deviceLabel: "windows_computer", browserLabel: "chrome", current: true, lastActiveAt: "2026-08-12T12:00:00Z" },
        { handle: "b".repeat(64), deviceLabel: "apple_mobile", browserLabel: "safari", current: false, lastActiveAt: "2026-08-11T12:00:00Z" },
      ]),
      onRevokeSession,
      onSignOutEverywhere: vi.fn(),
    });
    const open = await screen.findByRole("button", { name: "Sign out Apple mobile device · Safari" });
    fireEvent.click(open);
    const confirm = screen.getByRole("button", { name: "Confirm device sign-out" });
    await waitFor(() => expect(confirm).toHaveFocus());
    fireEvent.click(confirm);
    expect(onRevokeSession).toHaveBeenCalledWith("b".repeat(64));
    expect((confirm).closest('[aria-disabled="true"]')).not.toBeNull();
    await expectPendingFocus(confirm);
    fireEvent.click(confirm);
    expect(onRevokeSession).toHaveBeenCalledTimes(1);
    finish({ revoked: true });
    const notice = await screen.findByText("That device was signed out. Push alerts linked to it were removed.");
    expect(notice).toBeInTheDocument();
    await waitFor(() => expect(notice).toHaveFocus());
    expect(screen.queryByText("Apple mobile device · Safari")).not.toBeInTheDocument();
    expect(screen.getByText("Windows computer · Chrome")).toBeInTheDocument();
  });

  it("returns focus to the remote-device action when confirmation is cancelled", async () => {
    renderSettings("en", {
      onLoadSessions: vi.fn().mockResolvedValue([
        { handle: "b".repeat(64), deviceLabel: "apple_mobile", browserLabel: "safari", current: false },
      ]),
      onRevokeSession: vi.fn(),
    });
    const open = await screen.findByRole("button", { name: "Sign out Apple mobile device · Safari" });
    fireEvent.click(open);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign out Apple mobile device · Safari" })).toHaveFocus());
  });

  it("keeps a failed selected revoke visible and retryable", async () => {
    renderSettings("en", {
      onLoadSessions: vi.fn().mockResolvedValue([
        { handle: "b".repeat(64), deviceLabel: "apple_mobile", browserLabel: "safari", current: false, lastActiveAt: "2026-08-11T12:00:00Z" },
      ]),
      onRevokeSession: vi.fn().mockRejectedValue(new Error("down")),
      onSignOutEverywhere: vi.fn(),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Sign out Apple mobile device · Safari" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm device sign-out" }));
    expect(await screen.findByText("Couldn't sign out that device. It may still be active — try again.")).toBeInTheDocument();
    expect(screen.getByText("Apple mobile device · Safari")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm device sign-out" })).toBeEnabled();
  });

  it("distinguishes an unavailable inventory from an empty one", async () => {
    const first = renderSettings("en", { onLoadSessions: vi.fn().mockRejectedValue(new Error("down")), onRevokeSession: vi.fn() });
    expect(await screen.findByText("Sessions couldn't be loaded.")).toBeInTheDocument();
    first.unmount();
    renderSettings("en", { onLoadSessions: vi.fn().mockResolvedValue([]), onRevokeSession: vi.fn() });
    expect(await screen.findByText("No active sessions were found.")).toBeInTheDocument();
  });

  it("confirms global sign-out and keeps a failed action retryable", async () => {
    const onSignOutEverywhere = vi.fn().mockRejectedValue(new Error("down"));
    renderSettings("en", { onLoadSessions: vi.fn().mockResolvedValue([]), onRevokeSession: vi.fn(), onSignOutEverywhere });
    await screen.findByText("No active sessions were found.");
    fireEvent.click(screen.getByRole("button", { name: "Sign out everywhere" }));
    const confirm = screen.getByRole("button", { name: "Confirm sign out everywhere" });
    await waitFor(() => expect(confirm).toHaveFocus());
    fireEvent.click(confirm);
    expect(await screen.findByText("Couldn't sign out everywhere. Your current session is still active.")).toBeInTheDocument();
    expect(confirm).toBeEnabled();
  });

  it("signs out the current device through the safe local path, never the remote revoke RPC", async () => {
    const onSignOut = vi.fn().mockResolvedValue(undefined);
    const onRevokeSession = vi.fn();
    renderSettings("en", { onSignOut, onRevokeSession,
      onLoadSessions: vi.fn().mockResolvedValue([{ handle: "a".repeat(64), current: true, deviceLabel: "windows_computer", browserLabel: "chrome" }]),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Sign out Windows computer · Chrome" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm device sign-out" }));
    await waitFor(() => expect(onSignOut).toHaveBeenCalledTimes(1));
    expect(onRevokeSession).not.toHaveBeenCalled();
  });

  it("announces a refused current-device sign-out inline and lets the worker retry", async () => {
    const onSignOut = vi.fn().mockRejectedValueOnce(new Error("cleanup refused")).mockResolvedValue(undefined);
    const onRevokeSession = vi.fn();
    renderSettings("en", { onSignOut, onRevokeSession,
      onLoadSessions: vi.fn().mockResolvedValue([{ handle: "a".repeat(64), current: true, deviceLabel: "windows_computer", browserLabel: "chrome" }]),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Sign out Windows computer · Chrome" }));
    const confirm = screen.getByRole("button", { name: "Confirm device sign-out" });
    fireEvent.click(confirm);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't sign out that device. It may still be active — try again.");
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(onSignOut).toHaveBeenCalledTimes(2));
    expect(onRevokeSession).not.toHaveBeenCalled();
  });

  it("shows unmistakable Spanish sample sessions and mutates demo state only", async () => {
    renderSettings("es", { sessionDemo: true });
    expect(await screen.findByText("Datos de vista previa")).toBeInTheDocument();
    expect(screen.getAllByText("VISTA PREVIA").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión en Dispositivo móvil Apple · Safari" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar cierre del dispositivo" }));
    expect(await screen.findByText("Se quitó el dispositivo de vista previa. Ninguna sesión real cambió.")).toBeInTheDocument();
    expect(screen.queryByText("Dispositivo móvil Apple · Safari")).not.toBeInTheDocument();
  });

  it("mints a feed link, shows it exactly once, and revokes it", async () => {
    const token = "f".repeat(48);
    const onCalendarRotate = vi.fn().mockResolvedValue({ token });
    const onCalendarRevoke = vi.fn().mockResolvedValue({ revoked: true });
    renderSettings("en", { loadCalendarFeedStatus: vi.fn().mockResolvedValue(false), onCalendarRotate, onCalendarRevoke });

    expect(screen.getByText("Calendar")).toBeInTheDocument();
    expect(screen.getByText(/Anyone with this link can see the meetings/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Get calendar link" }));
    const input = await screen.findByRole("textbox", { name: "Calendar" });
    expect(input.value).toBe(`${window.location.origin}/api/calendar?token=${token}`);
    expect(screen.getByText("Copy this link now — it won't be shown again.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Turn off calendar link" }));
    await waitFor(() => expect(onCalendarRevoke).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Calendar" })).not.toBeInTheDocument());
  });
});

// Union Ground has no points economy and no member PIN or step-up session.
describe("settings hub without points or a PIN session", () => {
  it("names the hub row Contributions and shows no points badge, even with a points total loaded", () => {
    const onNavigate = vi.fn();
    render(
      <LanguageProvider lang="en">
        <SettingsView
          data={{ member: { initials: "MV" }, roles: [], rewards: { totalPoints: 640, tierNumber: 2, tierName: "Builder", weekStreak: 3 } }}
          lang="en"
          onLanguage={vi.fn()}
          onNavigate={onNavigate}
        />
      </LanguageProvider>,
    );
    const row = screen.getByRole("button", { name: /^Contributions/ });
    expect(row.textContent).not.toMatch(/pts|640|Tier|Builder/);
    expect(screen.queryByText("640 pts")).toBeNull();
    expect(screen.queryByText(/\bpts\b/)).toBeNull();
    expect(screen.queryByText("Rewards")).toBeNull();
    fireEvent.click(row);
    expect(onNavigate).toHaveBeenCalled();
  });

  it("offers no worker PIN enrolment or step-up prompt, even to an old caller that still passes them", () => {
    render(
      <LanguageProvider lang="en">
        <SettingsView
          data={{ member: { initials: "MV" }, roles: [] }}
          lang="en"
          onLanguage={vi.fn()}
          sessionRestricted
          stepUpPrompt={<p>STEP-UP PROMPT</p>}
        />
      </LanguageProvider>,
    );
    expect(screen.queryByText("STEP-UP PROMPT")).toBeNull();
    expect(screen.queryByText(/\bPIN\b/)).toBeNull();
    expect(screen.queryByLabelText(/\bPIN\b/)).toBeNull();
  });
});
