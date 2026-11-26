// REQ-UG-SIGNUP-UNION-CATALOG-PICKER-20261109 (#7670): the first
// organization screen finds the creator's union and local in the union
// catalog, offers the local-wide organization with its reservation warning and
// the local's chapters, prefills an editable name, and keeps typing a name as
// the fallback. A pick grants nothing: the create call carries only the name.
// A picked chapter rides through the Security section's two-step detour into
// setup's build-a-chapter draft (the mounted route is pinned in
// tests/admin-security-return-route.test.jsx).
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateOrganizationGate } from "../src/features/openSignup/CreateOrganizationGate.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
import { createdOrganizationNextHref } from "../src/lib/openSignup.js";
import { adminSetupPathFromSearch } from "../src/lib/setupSecurityReturn.js";
import { unionBuildContext } from "../src/features/orgSetup/UnionBuildPlacement.jsx";

// Directory keys, not secrets: numeric catalog keys keep the secret scan quiet.
const LOCAL = { key: "olms-900000012", name: "Riverbend Public Workers Local 12", level: "local", city: "Riverbend", state: "OR", designation: "LU", localNumber: "12" };
const TWIN = { ...LOCAL, key: "olms-900000112", localNumber: "112" };
const PROFILE = {
  found: true,
  organization: { key: LOCAL.key, name: LOCAL.name, level: "local" },
  subunits: [
    { key: "unit-northside", name: "Northside Transit Campaign", kind: "chapter" },
    { key: "unit-eastgate", name: "Eastgate Library Unit", kind: "unit" },
    { key: "unit-organizing", name: "Organizing Committee", kind: "committee" },
  ],
  children: [],
};
const CREATED = { status: "created", organizationId: "20000000-0000-4000-8000-000000000001", chapterId: "c-0123456789", slug: "u-0123456789", idempotent: false };

function catalogClient({ live = true, rows = [LOCAL], profileFailures = 0, searchFails = false } = {}) {
  let failures = profileFailures;
  return {
    rpc: vi.fn(async (name) => {
      if (name === "get_union_catalog_status") return { data: live ? { available: true, dataAsOf: "2026-11-01", releasedOn: "2026-11-01" } : { available: false }, error: null };
      if (name === "search_union_catalog") return searchFails ? { data: null, error: { code: "57014", message: "timeout" } } : { data: { rows, total: rows.length }, error: null };
      if (name === "get_union_catalog_profile") {
        if (failures > 0) { failures -= 1; return { data: null, error: { code: "08006", message: "connection failure" } }; }
        return { data: PROFILE, error: null };
      }
      if (name === "create_my_organization") return { data: CREATED, error: null };
      return { data: null, error: { message: "unexpected" } };
    }),
  };
}

function renderGate({ lang = "en", client = catalogClient(), onCreated = vi.fn() } = {}) {
  const view = render(
    <LanguageProvider lang={lang}>
      <CreateOrganizationGate client={client} onCreated={onCreated} onSignOut={vi.fn()} />
    </LanguageProvider>,
  );
  return { ...view, client, onCreated };
}

const nameInput = (container) => container.querySelector('input[name="organizationName"]');

async function findLocal(container, query = "Riverbend") {
  fireEvent.change(container.querySelector('input[name="unionSearch"]'), { target: { value: query } });
  fireEvent.submit(container.querySelector('form[role="search"]'));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("picking the union and local when creating an organization", () => {
  // #9927 (carved from #8435): the catalog Search button was natively disabled while its
  // own search ran, so a keyboard user who pressed it lost focus to the page.
  it("keeps focus on Search while the catalog search runs, and a second press searches nothing", async () => {
    const { container, client } = renderGate();
    fireEvent.change(container.querySelector('input[name="unionSearch"]'), { target: { value: "Riverbend" } });
    await expectHeldWriteFocus(client.rpc, screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText(LOCAL.name, { exact: false })).toBeInTheDocument();
  });

  it.each([
    ["en", "Search", "Type at least 2 characters to search."],
    ["es", "Buscar", "Escribe al menos 2 caracteres para buscar."],
  ])("explains the one-character search minimum in %s", async (lang, label, rule) => {
    const { client } = renderGate({ lang });
    const input = screen.getByRole("searchbox");
    const button = screen.getByRole("button", { name: label });
    const status = screen.getByText(rule);
    expect(status).toHaveAttribute("aria-live", "polite");
    fireEvent.change(input, { target: { value: " 9 " } });
    expect(input).toHaveAccessibleDescription(rule);
    expect(button).toBeDisabled();
    fireEvent.submit(screen.getByRole("search"));
    expect(client.rpc).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: " 90 " } });
    expect(status).not.toHaveTextContent(rule);
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(await screen.findByRole("button", { name: /Riverbend Public Workers Local 12/ })).toBeVisible();
    expect(client.rpc).toHaveBeenCalledWith("search_union_catalog", expect.objectContaining({ p_query: "90" }));
  });

  it("offers the local-wide organization with its reservation warning and prefills the local's name", async () => {
    const { container, client, onCreated } = renderGate();
    await findLocal(container);
    // The search result is announced in a polite live region.
    expect(await screen.findByText("1 match. Choose your local below.")).toHaveAttribute("aria-live", "polite");
    fireEvent.click(await screen.findByRole("button", { name: /Riverbend Public Workers Local 12/ }));
    const localWide = await screen.findByRole("radio", { name: "All of Riverbend Public Workers Local 12 (the local-wide organization)" });
    expect(localWide).toHaveAccessibleDescription("Reserved for the official local. Choosing it does not make your organization the local: it becomes official only after verification.");
    fireEvent.click(localWide);
    expect(nameInput(container).value).toBe(LOCAL.name);
    expect(screen.getByText("We filled in the name from your choice. You can change it.")).toBeInTheDocument();
    fireEvent.submit(container.querySelector('form:not([role="search"])'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ status: "created" }), { unionKey: LOCAL.key, scope: "local_wide" }));
    // A pick grants nothing: the create call carries only the name and its key.
    expect(client.rpc).toHaveBeenCalledWith("create_my_organization", { p_name: LOCAL.name, p_idempotency_key: expect.any(String) });
    // This edition omits the catalogue verification workspace, so the choice
    // returns to the ordinary setup handoff.
    expect(createdOrganizationNextHref({ unionKey: LOCAL.key, scope: "local_wide" }))
      .toBe("/m/settings?next=setup-review");
    // Only a real catalog key rides along.
    expect(createdOrganizationNextHref({ unionKey: "../admin", scope: "chapter" })).toBe("/m/settings?next=setup-review");
    expect(createdOrganizationNextHref({ scope: "chapter" })).toBe("/m/settings?next=setup-review");
  });

  it("lists the local's campaigns, prefills an editable name and hands the local to the build-a-chapter draft", async () => {
    const { container, onCreated } = renderGate();
    await findLocal(container);
    fireEvent.click(await screen.findByRole("button", { name: /Riverbend Public Workers Local 12/ }));
    const chapters = await screen.findByRole("group", { name: "One campaign of Riverbend Public Workers Local 12" });
    // Chapters and units only; a committee is not a chapter to represent.
    expect(within(chapters).getAllByRole("radio").map((radio) => radio.labels[0].textContent)).toEqual([
      "Eastgate Library Unit", "Northside Transit Campaign", "Another campaign of Riverbend Public Workers Local 12 (type its name below)",
    ]);
    fireEvent.click(within(chapters).getByRole("radio", { name: "Northside Transit Campaign" }));
    expect(nameInput(container).value).toBe("Northside Transit Campaign");
    fireEvent.change(nameInput(container), { target: { value: "Northside Transit Workers" } });
    fireEvent.submit(container.querySelector('form:not([role="search"])'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const placement = onCreated.mock.calls[0][1];
    expect(placement).toEqual({ unionKey: LOCAL.key, scope: "chapter" });

    // Through the Security section's two-step detour into setup's build-a-chapter context.
    const next = createdOrganizationNextHref(placement);
    expect(next).toBe(`/m/settings/security?setupReturnTo=${encodeURIComponent(`/m/admin/setup-review?union=${LOCAL.key}&build=chapter`)}`);
    const resumed = adminSetupPathFromSearch(new URL(next, "http://localhost").search);
    expect(resumed).toBe(`/m/admin/setup-review?union=${LOCAL.key}&build=chapter`);
    expect(unionBuildContext(new URL(resumed, "http://localhost").search)).toEqual({ key: LOCAL.key });
  });

  it("keeps the local for a campaign the directory does not list", async () => {
    const { container, onCreated } = renderGate();
    await findLocal(container);
    fireEvent.click(await screen.findByRole("button", { name: /Riverbend Public Workers Local 12/ }));
    fireEvent.click(await screen.findByRole("radio", { name: "Another campaign of Riverbend Public Workers Local 12 (type its name below)" }));
    expect(nameInput(container).value).toBe("");
    fireEvent.change(nameInput(container), { target: { value: "Westfield Maintenance Campaign" } });
    fireEvent.submit(container.querySelector('form:not([role="search"])'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ status: "created" }), { unionKey: LOCAL.key, scope: "chapter" }));
  });


  it("keeps typing a name as the fallback when the directory has no match or is unavailable", async () => {
    for (const client of [catalogClient({ rows: [] }), catalogClient({ live: false })]) {
      const { container, onCreated } = renderGate({ client });
      await findLocal(container, "Unlisted Workers");
      expect(await screen.findByText(/Type your organization's name below/)).toHaveAttribute("aria-live", "polite");
      fireEvent.change(nameInput(container), { target: { value: "Unlisted Workers Association" } });
      fireEvent.submit(container.querySelector('form:not([role="search"])'));
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ status: "created" }), null));
      expect(createdOrganizationNextHref(null)).toBe("/m/settings?next=setup-review");
      cleanup();
    }
  });

  it("lists locals only, tells a failed search from no match, and moves focus with the view", async () => {
    const NATIONAL = { key: "olms-900000001", name: "Riverbend Public Workers National Union", level: "national" };
    const { container } = renderGate({ client: catalogClient({ rows: [NATIONAL, LOCAL] }) });
    await findLocal(container);
    expect(await screen.findByText("1 match. Choose your local below.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /National Union/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Riverbend Public Workers Local 12/ }));
    await waitFor(() => expect(document.activeElement).toHaveTextContent("What does your organization represent in Riverbend Public Workers Local 12?"));
    fireEvent.click(screen.getByRole("button", { name: "Choose a different union" }));
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector('input[name="unionSearch"]')));
    cleanup();
    const failed = renderGate({ client: catalogClient({ searchFails: true }) });
    await findLocal(failed.container);
    expect(await screen.findByText("The search didn't finish. Search again, or type your organization's name below.")).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByText(/No match in the directory/)).toBeNull();
    // Bounds count characters: two emoji are two characters, not four code units.
    fireEvent.change(failed.container.querySelector('input[name="unionSearch"]'), { target: { value: "\u{1F91D}" } });
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
    fireEvent.change(failed.container.querySelector('input[name="unionSearch"]'), { target: { value: "\u{1F91D}\u{1F91D}" } });
    expect(screen.getByRole("button", { name: "Search" })).toBeEnabled();
  });

  it("lets the creator choose a different union, and says it all in Spanish", async () => {
    const { container } = renderGate({ lang: "es" });
    await findLocal(container);
    fireEvent.click(await screen.findByRole("button", { name: /Riverbend Public Workers Local 12/ }));
    const localWide = await screen.findByRole("radio", { name: "Todo Riverbend Public Workers Local 12 (la organización de todo el local)" });
    expect(localWide).toHaveAccessibleDescription(/Reservada para el local oficial/);
    fireEvent.click(screen.getByRole("button", { name: "Elegir otro sindicato" }));
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByRole("searchbox", { name: "Sindicato o local" })).toBeInTheDocument();
  });

});
