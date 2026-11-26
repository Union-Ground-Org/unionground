import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileDialog } from "../src/components/Dialogs.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { updateMemberSettings } from "../src/lib/memberApi.js";

const member = { firstName: "Sample", fullName: "Sample Staff", initials: "SS", roleLine: "Saved role text", sinceYear: 2026 };
const appSource = readFileSync("src/App.jsx", "utf8");
const appAst = parse(appSource, { sourceType: "module", plugins: ["jsx"] });
function findNode(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc") continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      const match = findNode(child, predicate);
      if (match) return match;
    }
  }
  return null;
}
const languageHandler = findNode(appAst, (node) => node.type === "FunctionDeclaration" && node.id?.name === "handleLanguage");
function handlerFixture({ failed = false, previous = "en", sharedPersonaSession = false } = {}) {
  let data = { member: { ...member, language: previous, preferred_language: "en", organizationId: "same-org" } };
  let boot = previous;
  let attempts = 0;
  const update = vi.fn();
  const client = { rpc: vi.fn(async (_name, args) => { update(args.p_fields); return failed ? { error: new Error("save denied") } : { data: null, error: null }; }) };
  const mutate = vi.fn(async (_resources, operation) => operation());
  const memberOperation = { run: (fn) => fn(), wait: (promise) => promise, assertCurrent: vi.fn() };
  const notices = [];
  const dependencies = { memberOperation, fixtureDemo: false, sharedPersonaSession, setNotice: (message) => { notices.push(message); }, bootLang: previous, data, changeBootLanguage: (next) => { boot = next; }, setLanguageAttempt: (advance) => { attempts = advance(attempts); }, setData: (next) => { data = next(data); }, mutate, memberMutationResources: () => ["member"], updateMemberSettings, supabase: client, session: { user: { id: "same-authenticated-user" } }, tr: (key) => key };
  // eslint-disable-next-line no-new-func -- evaluates source extracted from the module under test
  const onLanguage = new Function(...Object.keys(dependencies), `const sessionDataClient = supabase; ${appSource.slice(languageHandler.start, languageHandler.end)}; return handleLanguage;`)(...Object.values(dependencies));
  return { onLanguage, update, client, mutate, current: () => data, boot: () => boot, attempts: () => attempts, notices };
}
function view(lang, props = {}) {
  return <LanguageProvider lang={lang}><ProfileDialog member={member} onClose={props.onClose || vi.fn()} onSave={props.onSave || vi.fn()} {...props} /></LanguageProvider>;
}
afterEach(cleanup);

describe("staff profile language access", () => {
  it.each([["en", "es", "Language", false], ["es", "en", "Idioma", true]])("uses the saved %s state and requests %s through the language handler", async (lang, next, title, checked) => {
    const fixture = handlerFixture({ previous: lang });
    const onClose = vi.fn();
    const { rerender } = render(view(lang, { onLanguage: fixture.onLanguage, onClose }));
    const region = screen.getByTestId("profile-language");
    expect(within(region).getByRole("heading", { name: title })).toBeInTheDocument();
    const toggle = within(region).getByRole("switch", { name: "Español" });
    expect(toggle).toHaveAttribute("aria-checked", String(checked));
    await act(async () => fireEvent.click(toggle));
    expect(fixture.client.rpc).toHaveBeenCalledWith("update_my_member_profile", { p_expected_user_id: "same-authenticated-user", p_fields: { language: next } });
    expect(fixture.update).toHaveBeenCalledWith({ language: next });
    expect(fixture.current().member).toEqual({ ...member, language: next, preferred_language: "en", organizationId: "same-org" });
    // REQ-UG-SPANISH-COVERAGE-AND-LANGUAGE-CARRYOVER-20261030: the
    // member's choice is saved on their profile and reloads the catalogue, but
    // never becomes the device's language (sg-lang) for the next account.
    expect(fixture.boot()).toBe(lang);
    expect(fixture.attempts()).toBe(1);
    expect(onClose).not.toHaveBeenCalled();
    rerender(view(next, { onLanguage: fixture.onLanguage, onClose }));
    expect(screen.getByRole("switch", { name: "Español" })).toHaveAttribute("aria-checked", String(!checked));
    expect(screen.queryByRole("button", { name: /Settings|Ajustes/ })).not.toBeInTheDocument();
  });

  // #9776: on a shared demo person (the six SAMPLE personas every visitor
  // shares) the choice is the visitor's: it goes to this device and is never
  // saved on the shared account, where the next visitor would inherit it.
  it("keeps a shared demo person's language choice on the visitor's device", async () => {
    const fixture = handlerFixture({ previous: "en", sharedPersonaSession: true });
    render(view("en", { onLanguage: fixture.onLanguage, onClose: vi.fn() }));
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Español" })));
    expect(fixture.boot()).toBe("es");
    expect(fixture.client.rpc).not.toHaveBeenCalled();
    expect(fixture.mutate).not.toHaveBeenCalled();
    expect(fixture.current().member.language).toBe("en");
    expect(fixture.notices).toEqual(["toast.languageUpdated"]);
  });

  it("keeps the dialog open and restores the controlled language when the existing save handler rejects", async () => {
    const fixture = handlerFixture({ failed: true });
    const onClose = vi.fn();
    render(view("en", { onLanguage: fixture.onLanguage, onClose }));
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Español" })));
    expect(fixture.update).toHaveBeenCalledWith({ language: "es" });
    expect(fixture.current().member.language).toBe("en");
    expect(fixture.boot()).toBe("en");
    expect(screen.getByRole("switch", { name: "Español" })).toHaveAttribute("aria-checked", "false");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("blocks duplicate toggles and conflicting profile saves while language is pending", async () => {
    let finish;
    const onLanguage = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const onSave = vi.fn();
    render(view("en", { onLanguage, onSave }));
    const toggle = screen.getByRole("switch", { name: "Español" });
    fireEvent.click(toggle);
    // Pending, not disabled: the switch keeps focus while the language saves.
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    fireEvent.submit(screen.getByRole("button", { name: "Save profile" }).closest("form"));
    expect(onLanguage).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => finish());
    await waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled"));
  });

  it("keeps Member profile Settings access unchanged without the optional staff handler", () => {
    render(view("en", { onSettings: vi.fn() }));
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });

  it("shows Settings on a staff profile and invokes the shared settings handler", () => {
    const onSettings = vi.fn();
    render(view("en", { onSettings, onLanguage: vi.fn() }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onSettings).toHaveBeenCalledOnce();
  });

  it("wires staff profiles to the existing own-user handler without granting Member Settings or changing hats", () => {
    const profile = findNode(appAst, (node) => node.type === "JSXOpeningElement" && node.name.name === "ProfileDialog");
    const language = profile.attributes.find((attribute) => attribute.name?.name === "onLanguage");
    expect(language).toBeDefined();
    expect(appSource.slice(language.value.start, language.value.end)).toBe('{activeHat === "member" ? null : handleLanguage}');
    const settings = profile.attributes.find((attribute) => attribute.name?.name === "onSettings");
    expect(appSource.slice(settings.value.start, settings.value.end)).toContain('navigate("settings", "/m/settings")');
    expect(appSource.slice(settings.value.start, settings.value.end)).not.toContain('activeHat === "member"');
    const handler = appSource.slice(languageHandler.start, languageHandler.end);
    expect(handler).not.toMatch(/navigate\(|selectHat\(|setActiveHat\(|preferred_language/);
  });
});
