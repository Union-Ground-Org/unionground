import { readFileSync } from "node:fs";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { OfficerMemberDirectory } from "../src/components/OfficerMemberDirectory.jsx";
import { MemberRequestsPanel } from "../src/features/requests/MemberRequestsPanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { OrganizationNameProvider } from "../src/lib/organizationName.js";
import { AdminView } from "../src/views/AdminView.jsx";
import { SettingsView } from "../src/views/SettingsView.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

// UX-UG-PAGE-TITLE-PRINTED-TWICE-AND-ADMIN-PAGES-MISLABELLED-CHAPTER-TOOLS-20261122
// (#9525), site audit of Nov 22, 2026: findings S-G and A-7 (an Admin page's
// title printed again as its card or eyebrow heading), A-8 (every Admin page
// labelled as one chapter's "Campaign admin tools"), A-33 and B-54 (Requests
// printed twice under a breadcrumb reading "Current page"; the President's
// Worker directory printed twice).

const copy = (value) => JSON.parse(JSON.stringify(value));
const ORGANIZATION_ID = "a1b2c3d4-0000-4000-8000-000000000001";

// Every read the Admin pages make; anything else stays pending, which is
// enough for a page to paint its heading.
const adminApi = (desk = copy(fallbackData.adminDesk)) => new Proxy({
  loadDesk: vi.fn().mockResolvedValue(desk),
  loadFormTemplates: vi.fn().mockResolvedValue([]),
  loadFailedLoginInbox: vi.fn().mockResolvedValue({ items: [], openLast24Hours: 0, attentionThreshold: 5 }),
}, { get: (target, key) => (key in target ? target[key] : (typeof key === "string" && key !== "then" ? vi.fn(() => new Promise(() => {})) : undefined)) });

function onPage(path, view, hat, child, lang = "en") {
  window.history.replaceState({}, "", path);
  return render(<LanguageProvider lang={lang}>
    <WorkspacePages view={view} hat={hat} location={window.location.href} navigate={vi.fn()}>{child}</WorkspacePages>
  </LanguageProvider>);
}

// The page's own title, and every other visible heading, card title or
// eyebrow that says the same words. A title kept only for a screen reader
// (.visually-hidden) is not printed.
async function repeatsOf() {
  const h1 = await screen.findByRole("heading", { level: 1 });
  const title = h1.textContent.trim().toLowerCase();
  return { title: h1.textContent.trim(), repeats: [...document.querySelectorAll("h1, h2, h3, h4, h5, h6, .xus-cardttl, .xus-eyebrow")]
    .filter((node) => node !== h1 && !node.closest("[hidden], .visually-hidden") && node.textContent.trim().toLowerCase() === title) };
}

// The rendered heading outline: one h1 first, an h2 under it, and no step
// down of more than one level.
function expectWholeOutline() {
  const levels = screen.getAllByRole("heading").map((node) => Number(node.tagName.slice(1)));
  expect(levels[0]).toBe(1);
  expect(levels.filter((level) => level === 1)).toHaveLength(1);
  expect(levels).toContain(2);
  levels.forEach((level, index) => { if (index) expect(level - levels[index - 1]).toBeLessThanOrEqual(1); });
  return levels;
}

afterEach(() => window.history.replaceState({}, "", "/"));

describe("Admin pages name themselves once (S-G, A-7)", () => {
  const admin = { member: { initials: "AR", chapterName: "Service Coordination", organizationRoles: ["admin"], organizationId: ORGANIZATION_ID } };
  // The thirteen pages the record names, then every other Admin page the
  // sweep found repeating its title.
  it.each([
    ["/m/admin/access", "Organization roles & access"],
    ["/m/admin/form-templates", "Form templates"],
    ["/m/admin/mfa", "Two-step sign-in status"],
    ["/m/admin/events", "Meetings & check-in codes"],
    ["/m/admin/audit", "Recent admin activity"],
    ["/m/admin/member-directory", "Worker directory"],
    ["/m/admin/organization", "Organization & campaigns"],
    ["/m/admin/chapter-handshake", "Campaign partnerships & connections"],
    ["/m/admin/handshake-documents", "Handshake document exchange"],
    ["/m/admin/chapter-memberships", "Multi-campaign participation"],
    ["/m/admin/configuration", "Feature switches & limits"],
    ["/m/admin/labels", "Labels and navigation"],
    ["/m/admin/failed-logins", "Failed sign-in inbox"],
    ["/m/admin/invitations", "Invite a worker"],
    ["/m/admin/roster-import", "Invite a roster from CSV"],
    ["/m/admin/signin-recovery", "Sign-in help: new password or address"],
    ["/m/admin/lifecycle", "Lifecycle controls"],
    ["/m/admin/leadership-reviews", "Campaign chair reviews"],
    ["/m/admin/retention-engine", "Operational data retention"],
    ["/m/admin/setup-review", "Set up your organization"],
    ["/m/admin/people-waiting", "People waiting"],
  ])("%s", async (path, expected) => {
    onPage(path, "admin", "admin", <AdminView data={admin} api={adminApi()} onNotice={vi.fn()} demo />);
    const { title, repeats } = await repeatsOf();
    expect(title).toBe(expected);
    // Let the desk's reads settle so every card has painted.
    await vi.waitFor(() => expect(document.querySelector(".role-section-target, .ftm-section")).not.toBeNull());
    expect(repeats.map((node) => node.outerHTML.slice(0, 80))).toEqual([]);
    // The outline stays whole: the repeated title is kept as an h2 a screen
    // reader still lists, hidden on screen.
    expectWholeOutline();
    const kept = screen.getByRole("heading", { level: 2, name: expected });
    expect(kept).toHaveClass("visually-hidden");
  });

  it("keeps the configuration card named by its title for a screen reader", async () => {
    onPage("/m/admin/configuration", "admin", "admin", <AdminView data={admin} api={adminApi()} onNotice={vi.fn()} demo />);
    await screen.findByRole("heading", { level: 1, name: "Feature switches & limits" });
    await vi.waitFor(() => expect(document.getElementById("admin-configuration-title")).not.toBeNull());
    expect(document.getElementById("admin-configuration-title")).toHaveClass("visually-hidden");
  });

  it("keeps the card titles on the Admin overview, where no page title names them", async () => {
    onPage("/m/admin", "admin", "admin", <AdminView data={admin} api={adminApi()} onNotice={vi.fn()} demo />);
    await screen.findByRole("heading", { level: 1, name: "Campaign admin" });
    render(<LanguageProvider lang="en"><AdminView data={admin} api={adminApi()} onNotice={vi.fn()} demo /></LanguageProvider>);
    expect(await screen.findByRole("heading", { level: 3, name: "Two-step sign-in status" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Organization roles & access" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Promote a worker" })).toBeInTheDocument();
  });
});

describe("the Admin header names what its pages act on (A-8)", () => {
  function admin(lang, member, desk, organizationName = "Tamarack Valley Human Services Union") {
    window.history.replaceState({}, "", "/m/admin/access");
    render(<LanguageProvider lang={lang}><OrganizationNameProvider value={organizationName}>
      <WorkspacePages view="admin" hat="admin" location={window.location.href} navigate={vi.fn()}>
        <AdminView data={{ member: { initials: "AR", chapterName: "Service Coordination", organizationId: ORGANIZATION_ID, ...member } }} api={adminApi(desk)} onNotice={vi.fn()} />
      </WorkspacePages>
    </OrganizationNameProvider></LanguageProvider>);
    return document.querySelector(".phead");
  }

  it.each([
    ["en", "Organization admin tools", "Campaign admin tools"],
    ["es", "Herramientas de administración de la organización", "Herramientas de administración de la campaña"],
  ])("an organization-wide Admin sees the organization, not one chapter (%s)", async (lang, organizationTools, chapterTools) => {
    const header = admin(lang, { organizationRoles: ["admin"] }, copy(fallbackData.adminDesk));
    await vi.waitFor(() => expect(within(header).getByText(organizationTools)).toBeInTheDocument());
    expect(header).toHaveTextContent("Tamarack Valley Human Services Union");
    expect(header).not.toHaveTextContent("Service Coordination");
    expect(header).not.toHaveTextContent(chapterTools);
  });

  it.each([
    ["en", "Campaign admin tools"],
    ["es", "Herramientas de administración de la campaña"],
  ])("a chapter Admin sees the chapter (%s)", async (lang, chapterTools) => {
    const desk = copy(fallbackData.adminDesk);
    desk.organization.scope = "chapter";
    const header = admin(lang, { organizationRoles: [], chapterRoles: ["admin"] }, desk);
    await vi.waitFor(() => expect(within(header).getByText(chapterTools)).toBeInTheDocument());
    expect(header).toHaveTextContent("Service Coordination");
    expect(header).not.toHaveTextContent("Tamarack Valley Human Services Union");
  });


  it.each([
    ["an organization grant", { organizationRoles: ["admin"] }, "Organization admin tools", "Tamarack Valley Human Services Union"],
    ["a chapter grant only", { organizationRoles: [], chapterRoles: ["admin"] }, "Campaign admin tools", "Service Coordination"],
  ])("reads the scope from %s before the desk answers", (_label, member, tools, eyebrow) => {
    const pending = new Proxy({}, { get: (_target, key) => (key === "then" ? undefined : vi.fn(() => new Promise(() => {}))) });
    window.history.replaceState({}, "", "/m/admin/access");
    render(<LanguageProvider lang="en"><OrganizationNameProvider value="Tamarack Valley Human Services Union">
      <WorkspacePages view="admin" hat="admin" location={window.location.href} navigate={vi.fn()}>
        <AdminView data={{ member: { initials: "AR", chapterName: "Service Coordination", organizationId: ORGANIZATION_ID, ...member } }} api={pending} onNotice={vi.fn()} />
      </WorkspacePages>
    </OrganizationNameProvider></LanguageProvider>);
    const header = document.querySelector(".phead");
    expect(within(header).getByText(tools)).toBeInTheDocument();
    expect(header).toHaveTextContent(eyebrow);
  });


});

describe("the President's Worker directory names itself once (B-54)", () => {
  it("/m/vp/member-directory", async () => {
    const client = { rpc: vi.fn(async (name) => {
      if (name === "get_member_directory_access") return { data: { canRead: true, scope: "campaign", chapterId: "north" }, error: null };
      if (name === "get_admin_member_directory") return { data: { items: [{ userId: "u1", fullName: "Ada Stone", initials: "AS", chapterId: "north", chapterName: "North", roles: [] }], nextCursor: null, context: { organizationId: ORGANIZATION_ID, chapterId: "north" } }, error: null };
      throw new Error(`unexpected ${name}`);
    }) };
    onPage("/m/vp/member-directory", "vp", "vp", <>
      <h1>Worker directory</h1>
      <OfficerMemberDirectory client={client} sectionName="vp-member-directory" />
    </>);
    expect(await screen.findByText("Ada Stone")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Worker directory" }).filter((node) => !node.classList.contains("visually-hidden"))).toHaveLength(1);
    expectWholeOutline();
  });
});

describe("Settings pages name themselves once (A-33, B-54)", () => {
  const requestsApi = () => ({
    submit: vi.fn(), decide: vi.fn(), invite: vi.fn(),
    listMine: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    listToDecide: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
  });
  // Every read stays pending: enough for the Security card to draw.
  const pendingClient = () => new Proxy(function client() {}, { get: (_target, key) => (key === "then" ? undefined : pendingClient()), apply: () => new Promise(() => {}) });
  const settings = (path, lang = "en") => onPage(path, "settings", "member", <SettingsView
    data={{ member: { id: "u-sam", fullName: "Samuel Adeyemi", initials: "SA", chapterName: "Main Floor" }, roles: [], metrics: {}, cases: [], events: [], forms: [], product: { spaces: [] } }}
    onNavigate={vi.fn()} onProfile={vi.fn()} onAssistant={vi.fn()} lang={lang} onLanguage={vi.fn()}
    authClient={pendingClient()} onCalendarRotate={vi.fn()} onLoadSessions={vi.fn().mockResolvedValue([])}
    requestsPanel={<MemberRequestsPanel api={requestsApi()} lang={lang} onNotice={vi.fn()} />}
  />, lang);

  it.each([
    ["/m/settings/requests", "Requests"],
    ["/m/settings/language", "Language"],
    ["/m/settings/messages", "Messaging workflow"],
    ["/m/settings/appearance", "Most used places"],
  ])("%s", async (path, expected) => {
    settings(path);
    const { title, repeats } = await repeatsOf();
    expect(title).toBe(expected);
    expect(repeats).toEqual([]);
    // The card keeps its name for a screen reader.
    expect(screen.getByRole("region", { name: expected })).toBeInTheDocument();
  });

  it.each([
    "/m/settings/requests", "/m/settings/language", "/m/settings/messages", "/m/settings/appearance",
    "/m/settings/notifications", "/m/settings/sessions", "/m/settings/security", "/m/settings/calendar",
  ])("keeps a whole heading outline on %s", async (path) => {
    settings(path);
    await screen.findByRole("heading", { level: 1 });
    await vi.waitFor(() => expectWholeOutline());
    const { repeats } = await repeatsOf();
    expect(repeats).toEqual([]);
  });

  it("prints Requests once in Spanish too", async () => {
    settings("/m/settings/requests", "es");
    const { title, repeats } = await repeatsOf();
    expect(title).toBe("Solicitudes");
    expect(repeats).toEqual([]);
  });

  // A head left with only the hidden title is not drawn
  // at all (WorkspaceCardHead), so no rule hides a head, and with it the h2,
  // by display: none. tests/card-head-outline-browser.test.jsx applies the
  // stylesheet in Chromium.
  it("draws no Requests or Language card head on its own page, and keeps the h2 in the card", async () => {
    for (const [path, id] of [["/m/settings/requests", "member-requests-title"], ["/m/settings/language", null]]) {
      const view = settings(path);
      await screen.findByRole("heading", { level: 1 });
      const kept = screen.getByRole("heading", { level: 2, name: path.endsWith("requests") ? "Requests" : "Language" });
      expect(kept).toHaveClass("visually-hidden");
      expect(kept.closest(".setin-card__head")).toBeNull();
      if (id) expect(kept).toHaveAttribute("id", id);
      view.unmount();
    }
    expect(readFileSync("src/styles.css", "utf8")).not.toMatch(/\.setin-card__head:not\(:has/u);
  });
});

describe("the page menu says Current page only to a screen reader (A-33)", () => {
  it("hides the label on screen at every width and keeps it in the button's name", () => {
    const sheet = readFileSync("src/components/workspacePages.css", "utf8");
    const rules = sheet.match(/\.workspace-page-menu__label \{[^}]*\}/gu);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain("clip-path: inset(50%)");
    // Outside every media query: the first rule before any @media.
    expect(sheet.indexOf(rules[0])).toBeLessThan(sheet.indexOf("@media"));
    onPage("/m/settings/requests", "settings", "member", null);
    expect(document.querySelector(".workspace-page-menu__trigger")).toHaveAccessibleName("Current page Requests");
  });

  it.each([
    ["en", "/m/settings/requests", "settings", "member", "Current page", "Requests"],
    ["es", "/m/settings/requests", "settings", "member", "Página actual", "Solicitudes"],
    ["en", "/m/admin/mfa", "admin", "admin", "Current page", "Two-step sign-in status"],
  ])("keeps the current item marked and its hidden label in the button (%s %s)", (lang, path, view, hat, label, page) => {
    onPage(path, view, hat, null, lang);
    const trigger = document.querySelector(".workspace-page-menu__trigger");
    const hidden = trigger.querySelector(".workspace-page-menu__label");
    expect(hidden).toHaveTextContent(label);
    expect(trigger).toHaveAccessibleName(`${label} ${page}`);
    fireEvent.click(trigger);
    const panel = document.getElementById(trigger.getAttribute("aria-controls"));
    const current = within(panel).getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.getAttribute("href"))).toEqual([path]);
    expect(current[0]).toHaveTextContent(page);
  });

  it("the label class is carried by that one element only, in the code and on the page", () => {
    onPage("/m/settings/requests", "settings", "member", null);
    const carriers = [...document.querySelectorAll(".workspace-page-menu__label")];
    expect(carriers).toHaveLength(1);
    expect(carriers[0].closest(".workspace-page-menu__trigger")).not.toBeNull();
    const source = readFileSync("src/components/WorkspacePages.jsx", "utf8");
    expect(source.match(/workspace-page-menu__label/gu)).toHaveLength(1);
  });
});
