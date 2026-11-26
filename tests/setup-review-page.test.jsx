// REQ-UG-UNION-CATALOG-SETUP-REVIEW-PREFILL-20260925: /m/admin/setup-review.
// The creator starts from a public record or a blank list, edits it, checks
// it with a dry run, and only then creates it through the unchanged
// import_organization_structure. Demo and SAMPLE send nothing; a missing
// catalog leaves Build my own working; a release change refuses the commit.
// Both clients are fakes whose rpc() answers { data, error }. All values are
// fictional.
import { readFileSync } from "node:fs";
import axe from "axe-core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupReviewPage } from "../src/features/orgSetup/SetupReviewPage.jsx";
import {
  clearOrganizationCatalogPlacement,
  getOrganizationCatalogPlacement,
  importOrganizationStructure,
  setOrganizationCatalogPlacement,
} from "../src/features/orgSetup/setupApi.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WorkspacePages, WorkspaceSection } from "../src/components/WorkspacePages.jsx";
import { useBusyScope } from "../src/lib/busyWrite.js";
import { expectHeldWriteFocus, expectOneWriteFromOneTick, expectPendingFocus } from "./helpers/busyWriteFocus.js";

const ORG = "a1b2c3d4-0000-4000-8000-000000000001";
const MISSING = { code: "PGRST202", message: "Could not find the function" };
const LIVE = { available: true, releaseLabel: "20260924-01", releasedOn: "2026-09-25", dataAsOf: "2026-09-24", counts: {} };
const PROFILE = {
  found: true,
  organization: { key: "olms-900000001", name: "Example Workers Local 1" },
  childrenTotal: 2,
  subunits: [
    { key: "sub-a", parentKey: null, kind: "council", name: "Example Workers North Council", sourceUrl: "https://records.example.invalid/n", asOf: "2026-08-01" },
    { key: "sub-b", parentKey: "sub-a", kind: "chapter", name: "Riverbend Chapter", asOf: "2026-08-02" },
  ],
  seatOutlines: [{ key: "seat-1", subunitKey: null, seatClass: "officer", title: "President", listed: 1, vacant: 0, asOf: "2026-08-01" }],
  contacts: [{ kind: "email", value: "sentinel@example.invalid" }],
  documents: [{ key: "doc-1", kind: "bylaws", title: "Bylaws", url: "https://docs.example.invalid/bylaws.pdf" }],
};

function fakeClient(respond = () => undefined) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push([name, args]);
      return (await respond(name, args, calls)) ?? { data: null, error: MISSING };
    },
  };
}

function catalogFake({ status = () => ({ data: LIVE, error: null }), profile = PROFILE } = {}) {
  return fakeClient((name, args) => {
    if (name === "get_union_catalog_status") return status();
    if (name === "search_union_catalog") return { data: { rows: [{ key: "olms-900000001", name: "Example Workers Local 1", city: "Springfield", state: "MA" }] }, error: null };
    if (name === "get_union_catalog_profile") return { data: args.p_key === "olms-900000001" ? profile : { found: false }, error: null };
    return undefined;
  });
}

function importOk(name, args) {
  if (name !== "import_organization_structure") return undefined;
  return { data: { dryRun: args.p_dry_run, committed: !args.p_dry_run, errors: [], warnings: [], counts: {} }, error: null };
}

function apiFor(client) {
  return {
    importOrganizationStructure: (hat, payload, dryRun) => importOrganizationStructure(client, hat, payload, dryRun),
    getOrganizationCatalogPlacement: (organizationId) => getOrganizationCatalogPlacement(client, organizationId),
    setOrganizationCatalogPlacement: (organizationId, fields, key) => setOrganizationCatalogPlacement(client, organizationId, fields, key),
    clearOrganizationCatalogPlacement: (organizationId, key) => clearOrganizationCatalogPlacement(client, organizationId, key),
  };
}

function renderPage({ lang = "en", demo = false, catalog = catalogFake(), auth = fakeClient(importOk), organization = { chapters: [{ name: "Main Chapter" }] }, reload = vi.fn(), onNotice = vi.fn(), navigate = null } = {}) {
  const page = (
    <LanguageProvider lang={lang}>
      <SetupReviewPage
        api={apiFor(auth)}
        data={{ member: { organizationId: ORG, fullName: "Example Admin" } }}
        organization={organization}
        demo={demo}
        catalogClient={catalog}
        reload={reload}
        onNotice={onNotice}
      />
    </LanguageProvider>
  );
  const view = render(navigate ? <WorkspacePages view="admin" location="/m/admin/setup-review" hat="admin" navigate={navigate}>{page}</WorkspacePages> : page);
  return { ...view, auth, catalog, reload, onNotice };
}

const AUTHORITY = "The members elected me president at the March meeting";

// The attestation starts empty, so every flow that checks or creates states
// its authority, as a real founder now must.
function fillAuthority(value = AUTHORITY) {
  fireEvent.change(screen.getByLabelText("Authority"), { target: { value } });
}

async function startOwn() {
  fireEvent.click(await screen.findByRole("radio", { name: "Build my own" }));
  fireEvent.change(screen.getByLabelText("Organization name at the top of your chart"), { target: { value: "Example Workers Local 1" } });
  fillAuthority();
}

async function addOwnRow(name, type) {
  fireEvent.click(screen.getByRole("button", { name: "Add a campaign or office" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: name } });
  if (type) fireEvent.change(within(dialog).getByLabelText("Type"), { target: { value: type } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

async function startPublic() {
  const radio = await screen.findByRole("radio", { name: "Start from the public record" });
  await waitFor(() => expect(radio).not.toBeDisabled());
  fireEvent.click(radio);
  fireEvent.change(screen.getByLabelText("Search the public record by name, local number or city"), { target: { value: "Example" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  fireEvent.click(await screen.findByRole("radio", { name: /Example Workers Local 1/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Import public details into draft" }));
  await screen.findByDisplayValue("Riverbend Chapter");
  fillAuthority();
}

const importCalls = (auth) => auth.calls.filter(([name]) => name === "import_organization_structure");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("setup review: demo and unavailable states", () => {
  it("combines selected public records with creator answers and clears both on an organization switch", async () => {
    const { auth, rerender } = renderPage();
    await startPublic();
    expect(screen.getByText(/Why: bylaws are linked in the public listing/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: /What would help your organization first/ }), { target: { value: "support" } });
    expect(screen.getByText(/Why: you chose member support/)).toBeInTheDocument();
    expect(importCalls(auth)).toEqual([]);
    rerender(<LanguageProvider lang="en"><SetupReviewPage api={apiFor(auth)} data={{ member: { organizationId: "other-organization" } }} organization={{ chapters: [] }} demo /></LanguageProvider>);
    await waitFor(() => expect(screen.getByRole("combobox", { name: /What would help your organization first/ })).toHaveValue(""));
    expect(screen.queryByText(/Why:/)).toBeNull();
  });

  it("sends nothing in the demo and says why Confirm is off", async () => {
    const { auth, catalog } = renderPage({ demo: true });
    expect(screen.getAllByText("Setting up from public records isn't available in the demo.").length).toBeGreaterThan(0);
    expect(screen.getByRole("radio", { name: "Start from the public record" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Build my own" })).toBeChecked();
    fireEvent.change(screen.getByLabelText("Organization name at the top of your chart"), { target: { value: "Example" } });
    await addOwnRow("Harbor Chapter");
    expect(screen.getByRole("button", { name: "Check 1 items" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create 1" })).toBeDisabled();
    expect(screen.queryByText("Where does your organization belong?")).toBeNull();
    expect(auth.calls).toEqual([]);
    expect(catalog.calls).toEqual([]);
  });

  it("treats a missing public client (SAMPLE) as the demo", () => {
    const { auth } = renderPage({ catalog: null });
    expect(screen.getAllByText("Setting up from public records isn't available in the demo.").length).toBeGreaterThan(0);
    expect(auth.calls).toEqual([]);
  });

  it("keeps Build my own working when the catalog RPC is missing", async () => {
    const catalog = catalogFake({ status: () => ({ data: null, error: MISSING }) });
    const { auth } = renderPage({ catalog });
    await screen.findByText("The union catalog isn't loaded on this site yet.");
    expect(screen.getByRole("radio", { name: "Start from the public record" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Build my own" })).toBeChecked();
    fireEvent.change(screen.getByLabelText("Organization name at the top of your chart"), { target: { value: "Example" } });
    fillAuthority();
    await addOwnRow("Harbor Chapter");
    fireEvent.click(screen.getByRole("button", { name: "Check 1 items" }));
    await screen.findByText("Ready: 1 items will be created.");
    expect(catalog.calls.map(([name]) => name)).toEqual(["get_union_catalog_status"]);
    expect(importCalls(auth)).toHaveLength(1);
    // The placement read was the only other call, and it found no RPC.
    await screen.findByText("Placement isn't available yet.");
  });

  it("starts blank when the public record has no details", async () => {
    renderPage({ catalog: catalogFake({ profile: { found: false } }) });
    const radio = await screen.findByRole("radio", { name: "Start from the public record" });
    await waitFor(() => expect(radio).not.toBeDisabled());
    expect(screen.getByRole("radio", { name: "Build my own" })).not.toBeChecked();
    fireEvent.click(radio);
    fireEvent.change(screen.getByLabelText("Search the public record by name, local number or city"), { target: { value: "Example" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("1 matches")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("radio", { name: /Example Workers Local 1/ }));
    await screen.findByText("We don't have public details for this organization, so you'll start with a blank list.");
    // The fixture organization already has Main Chapter, so the empty list
    // says nothing new was added rather than that there are no chapters.
    expect(screen.getByText("Nothing new added yet. Add a campaign or office to create it alongside the ones above.")).toBeInTheDocument();
  });
});

describe("setup review: an organization that already has chapters", () => {
  // BUG-UG-ORG-STRUCTURE-WIZARD-IGNORES-EXISTING-CHAPTER-20261006:
  // the wizard opened blank although a chapter existed, and presidents feared
  // creating a duplicate.
  it("lists the existing chapters and says that continuing only adds new units", async () => {
    renderPage({ organization: { chapters: [{ id: "c-1", name: "Main Chapter" }, { id: "c-2", name: "Fleet Maintenance" }] } });
    const existing = screen.getByRole("region", { name: "Already in your organization" });
    expect(within(existing).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Main Chapter", "Fleet Maintenance"]);
    expect(within(existing).getByText(/Campaigns you add below are created as new campaigns alongside these\. This page doesn't rename or remove these campaigns/)).toBeInTheDocument();
    expect(within(existing).getByText("Existing campaigns: 2").closest("details")).toHaveAttribute("open");
    await startOwn();
    expect(screen.getByText("Nothing new added yet. Add a campaign or office to create it alongside the ones above.")).toBeInTheDocument();
    expect(screen.queryByText("No campaigns yet. Add one to get started.")).toBeNull();
  });

  it("folds a long chapter list so the start choice stays in view", () => {
    const chapters = Array.from({ length: 20 }, (_, index) => ({ id: `c-${index}`, name: `Unit ${index + 1}` }));
    renderPage({ organization: { chapters } });
    const existing = screen.getByRole("region", { name: "Already in your organization" });
    expect(within(existing).getByText("Existing campaigns: 20").closest("details")).not.toHaveAttribute("open");
    expect(existing.querySelectorAll("li")).toHaveLength(20);
  });

  it("keeps the blank-start copy when the organization has no chapters yet", async () => {
    renderPage({ organization: { chapters: [] } });
    expect(screen.queryByRole("region", { name: "Already in your organization" })).toBeNull();
    await startOwn();
    expect(screen.getByText("No campaigns yet. Add one to get started.")).toBeInTheDocument();
  });

  it("pauses checking and creating when the existing chapters could not be loaded", async () => {
    // Gate round 2 on: null means get_admin_org_structure
    // failed, not "no chapters", so the payload cannot steer clear of them.
    const { auth } = renderPage({ organization: null });
    expect(screen.getByRole("alert")).toHaveTextContent("We couldn't load the campaigns your organization already has");
    await startOwn();
    await addOwnRow("Harbor Chapter");
    const check = screen.getByRole("button", { name: "Check 1 items" });
    expect(check).toBeDisabled();
    expect(check).toHaveAccessibleDescription("Checking and creating are paused until your existing campaigns load. Reload the page to try again.");
    expect(screen.getByRole("button", { name: "Create 1" })).toBeDisabled();
    fireEvent.click(check);
    expect(importCalls(auth)).toHaveLength(0);
  });

  it("shows the existing chapters in Spanish", () => {
    renderPage({ lang: "es", organization: { chapters: [{ id: "c-1", name: "Main Chapter" }] } });
    const existing = screen.getByRole("region", { name: "Ya están en tu organización" });
    expect(within(existing).getByText("Main Chapter")).toBeInTheDocument();
    expect(within(existing).getByText(/Esta página no les cambia el nombre ni las quita/)).toBeInTheDocument();
  });
});

describe("setup review: editing", () => {
  it.each([
    ["selection", false], ["selection", true], ["reimport", false], ["reimport", true],
  ])("uses organization seat scope for an empty All fallback after %s, removed: %s", async (flow, removeImported) => {
    let label = LIVE.releaseLabel;
    let original = PROFILE;
    const empty = { found: true, organization: { key: "olms-900000002", name: "Empty local" }, subunits: [],
      seatOutlines: [{ key: "empty-president", subunitKey: null, seatClass: "officer", title: "Empty President" }] };
    const catalog = fakeClient((name, args) => {
      if (name === "get_union_catalog_status") return { data: { ...LIVE, releaseLabel: label }, error: null };
      if (name === "search_union_catalog") return { data: { rows: [
        { key: PROFILE.organization.key, name: PROFILE.organization.name }, { key: empty.organization.key, name: empty.organization.name },
      ] }, error: null };
      if (name === "get_union_catalog_profile") return { data: args.p_key === PROFILE.organization.key ? original : empty, error: null };
      return undefined;
    });
    const { auth } = renderPage({ catalog });
    await startPublic();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include officer and board seat outlines (no names)" }));
    let importedName = empty.organization.name;
    if (flow === "selection") {
      fireEvent.click(screen.getByRole("radio", { name: "Empty local" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Import public details into draft" })).toHaveFocus());
      fireEvent.click(screen.getByRole("button", { name: "Import public details into draft" }));
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Check 3 items" }));
      await screen.findByText("Ready: 3 items will be created.");
      original = { ...PROFILE, subunits: [] };
      label = "20261024-01";
      fireEvent.click(screen.getByRole("button", { name: "Create 3" }));
      await screen.findByText(/The public record was updated while you were reviewing/);
      fireEvent.click(screen.getByRole("button", { name: "Reload the public record" }));
      importedName = PROFILE.organization.name;
    }
    await waitFor(() => expect(screen.getAllByLabelText("Name").map(input => input.value)).toEqual([importedName]));
    if (removeImported) {
      fireEvent.click(screen.getByRole("button", { name: `Remove ${importedName}` }));
      await addOwnRow("Own chapter");
    }
    const count = removeImported ? 1 : 2;
    fireEvent.click(screen.getByRole("button", { name: `Check ${count} items` }));
    await screen.findByText(`Ready: ${count} items will be created.`);
    const payload = importCalls(auth).at(-1)[1].p_payload;
    const role = payload.charts.union.nodes.find(node => node.nodeKind === "role");
    if (removeImported) expect(role).toBeUndefined();
    else expect(role.parentKey).toBe(payload.charts.union.nodes.find(node => node.nodeKind === "chapter").nodeKey);
    fireEvent.click(screen.getByRole("button", { name: `Create ${count}` }));
    await screen.findByText("Your structure is set up. Invite members next.");
    expect(importCalls(auth).at(-1)[1].p_payload).toEqual(payload);
  });

  it.each([false, true])("parents child-local seats to its imported chapter and omits seats when that row is removed: %s", async (removeChild) => {
    const parent = { ...PROFILE, children: [{ key: "olms-900000002", name: "Child local" }] };
    const child = { found: true, organization: { key: "olms-900000002", name: "Child local" },
      subunits: [{ key: "child-unit", name: "Unselected child unit", kind: "unit" }], seatOutlines: [
        { key: "root-seat", subunitKey: null, seatClass: "officer", title: "Child President" },
        { key: "unit-seat", subunitKey: "child-unit", seatClass: "board", title: "Unit Chair" },
      ] };
    const catalog = fakeClient((name, args) => {
      if (name === "get_union_catalog_status") return { data: LIVE, error: null };
      if (name === "search_union_catalog") return { data: { rows: [{ key: PROFILE.organization.key, name: PROFILE.organization.name }] }, error: null };
      if (name === "get_union_catalog_profile") return { data: args.p_key === PROFILE.organization.key ? parent : child, error: null };
      return undefined;
    });
    const { auth } = renderPage({ catalog });
    await startPublic();
    fireEvent.change(screen.getByLabelText("Public details to import"), { target: { value: "child:olms-900000002" } });
    fireEvent.click(screen.getByRole("button", { name: "Import public details into draft" }));
    await screen.findByDisplayValue("Child local");
    fireEvent.click(screen.getByRole("checkbox", { name: "Include officer and board seat outlines (no names)" }));
    if (removeChild) {
      fireEvent.click(screen.getByRole("button", { name: "Remove Child local" }));
      await addOwnRow("Own chapter");
    }
    const count = removeChild ? 1 : 2;
    fireEvent.click(screen.getByRole("button", { name: `Check ${count} items` }));
    await screen.findByText(`Ready: ${count} items will be created.`);
    const payload = importCalls(auth)[0][1].p_payload;
    const roles = payload.charts.union.nodes.filter(node => node.nodeKind === "role");
    expect(roles.map(node => node.label)).toEqual(removeChild ? [] : ["Child President"]);
    expect(payload.chapters.map(row => row.name)).toEqual([removeChild ? "Own chapter" : "Child local"]);
    if (!removeChild) {
      const childNode = payload.charts.union.nodes.find(node => node.label === "Child local");
      expect(roles[0].parentKey).toBe(childNode.nodeKey);
    }
    fireEvent.click(screen.getByRole("button", { name: `Create ${count}` }));
    await screen.findByText("Your structure is set up. Invite members next.");
    expect(importCalls(auth)[1][1].p_payload).toEqual(payload);
  });

  it.each([false, true])("imports only the selected unit's seats, with seats enabled before reimport: %s", async (enableBefore) => {
    const scopedProfile = { ...PROFILE, seatOutlines: [
      { key: "selected-seat", subunitKey: "sub-b", seatClass: "officer", title: "Riverbend President" },
      { key: "sibling-seat", subunitKey: "sub-a", seatClass: "board", title: "Sibling Chair" },
      ...PROFILE.seatOutlines,
    ] };
    const { auth } = renderPage({ catalog: catalogFake({ profile: scopedProfile }) });
    await startPublic();
    if (enableBefore) fireEvent.click(screen.getByRole("checkbox", { name: "Include officer and board seat outlines (no names)" }));
    fireEvent.change(screen.getByLabelText("Public details to import"), { target: { value: "sub-b" } });
    fireEvent.click(screen.getByRole("button", { name: "Import public details into draft" }));
    if (!enableBefore) fireEvent.click(screen.getByRole("checkbox", { name: "Include officer and board seat outlines (no names)" }));
    fireEvent.click(screen.getByRole("button", { name: "Check 2 items" }));
    await screen.findByText("Ready: 2 items will be created.");
    fireEvent.click(screen.getByRole("button", { name: "Create 2" }));
    await screen.findByText("Your structure is set up. Invite members next.");
    const [dry, committed] = importCalls(auth).map(([, args]) => args.p_payload);
    expect(committed).toEqual(dry);
    expect(committed.charts.union.nodes.filter(node => node.nodeKind === "role").map(node => node.label)).toEqual(["Riverbend President"]);
    expect(committed.chapters.map(chapter => chapter.name)).toEqual(["Riverbend Chapter"]);
  });

  it("moves selection focus to Import and retains the checked draft until import changes it", async () => {
    const catalog = fakeClient((name, args) => {
      if (name === "get_union_catalog_status") return { data: LIVE, error: null };
      if (name === "search_union_catalog") return { data: { rows: [
        { key: PROFILE.organization.key, name: PROFILE.organization.name },
        { key: "olms-900000002", name: "Other local" },
      ] }, error: null };
      if (name === "get_union_catalog_profile") return { data: { ...PROFILE, organization: { key: args.p_key, name: args.p_key === PROFILE.organization.key ? PROFILE.organization.name : "Other local" } }, error: null };
      return undefined;
    });
    renderPage({ catalog });
    await startPublic();
    fireEvent.click(screen.getByRole("button", { name: "Check 2 items" }));
    await screen.findByText("Ready: 2 items will be created.");
    const next = screen.getByRole("radio", { name: "Other local" }); next.focus(); fireEvent.click(next);
    await waitFor(() => expect(screen.getByRole("button", { name: "Import public details into draft" })).toHaveFocus());
    expect(screen.getByRole("button", { name: "Create 2" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Import public details into draft" }));
    expect(screen.getByRole("button", { name: "Create 2" })).toBeDisabled();
  });

  it("keeps other search matches available and rejects a mismatched public profile", async () => {
    const catalog = fakeClient((name, args) => {
      if (name === "get_union_catalog_status") return { data: LIVE, error: null };
      if (name === "search_union_catalog") return { data: { rows: [
        { key: "olms-900000001", name: PROFILE.organization.name },
        { key: "olms-900000002", name: "Example Workers Local 2" },
      ] }, error: null };
      if (name === "get_union_catalog_profile") return { data: args.p_key === "olms-900000001" ? PROFILE
        : { ...PROFILE, organization: { key: "olms-900000099", name: "Wrong record" } }, error: null };
      return undefined;
    });
    const { auth } = renderPage({ catalog });
    await startPublic();
    expect(screen.getByRole("group", { name: "Other matches" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Example Workers Local 1/ })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Example Workers Local 2" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong. Nothing was created.");
    expect(screen.getByDisplayValue("Riverbend Chapter")).toBeInTheDocument();
    expect(importCalls(auth)).toHaveLength(0);
  });

  it("prefills public-record rows, removes one and undoes it", async () => {
    renderPage();
    await startPublic();
    expect(screen.getByDisplayValue("Example Workers North Council")).toBeInTheDocument();
    expect(screen.getByLabelText("Organization name at the top of your chart")).toHaveValue("Example Workers Local 1");
    expect(screen.getAllByText(/From public records, as of/)).toHaveLength(2);
    expect(screen.getByText(/Organizations listed under this one: 2/)).toBeInTheDocument();
    for (const doc of screen.getAllByRole("link", { name: "Bylaws" })) {
      expect(doc).toHaveAttribute("href", "https://docs.example.invalid/bylaws.pdf");
      expect(doc).toHaveAttribute("rel", "noopener noreferrer nofollow");
    }
    expect(screen.queryByText("sentinel@example.invalid")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove Riverbend Chapter" }));
    expect(screen.queryByDisplayValue("Riverbend Chapter")).toBeNull();
    expect(screen.getByText(/Removed Riverbend Chapter\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByDisplayValue("Riverbend Chapter")).toBeInTheDocument();

    await addOwnRow("Harbor Office", "office");
    expect(screen.getByText("Added by you")).toBeInTheDocument();
    expect(screen.getByText("3 campaigns and offices")).toBeInTheDocument();
  });

  it("flags a duplicate of an existing chapter and a too-long name, and blocks the check", async () => {
    renderPage();
    await startOwn();
    await addOwnRow("main chapter");
    expect(screen.getByText("Another campaign or office already uses this name.")).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue("main chapter"), { target: { value: "L".repeat(121) } });
    expect(screen.getByText("This name needs to be shorter.")).toBeInTheDocument();
    expect(screen.getByDisplayValue("L".repeat(121))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check 1 items" })).toBeDisabled();
    expect(screen.getByText("Fix these before you check or create: the campaign and office names marked in the list.")).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue("L".repeat(121)), { target: { value: "" } });
    expect(screen.getByText("Enter a name.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remove Chapter/ })).toBeInTheDocument();
  });

  it("opts in to seat outlines and sends them as vacant roles", async () => {
    const { auth } = renderPage();
    await startPublic();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include officer and board seat outlines (no names)" }));
    fireEvent.click(screen.getByRole("button", { name: "Check 3 items" }));
    await screen.findByText("Ready: 3 items will be created.");
    const payload = importCalls(auth)[0][1].p_payload;
    const role = payload.charts.union.nodes.find((node) => node.nodeKind === "role");
    expect(role).toMatchObject({ label: "President", vacant: true, badge: "From public records" });
    expect(role.subtitle).toMatch(/^Unconfirmed · listed publicly as of /);
    expect(JSON.stringify(payload)).not.toContain("sentinel@example.invalid");
  });
});

describe("setup review: dry run and confirm", () => {
  it("opens the invitation and role handoff destinations after a confirmed import", async () => {
    const navigate = vi.fn();
    renderPage({ navigate });
    await startPublic();
    fireEvent.click(screen.getByRole("button", { name: "Check 2 items" }));
    await screen.findByText("Ready: 2 items will be created.");
    fireEvent.click(screen.getByRole("button", { name: "Create 2" }));
    fireEvent.click(await screen.findByRole("link", { name: "Invite members" }));
    fireEvent.click(screen.getByRole("link", { name: "Open Organization roles & access" }));
    expect(navigate.mock.calls.map(call => call[1])).toEqual(["/m/admin/invitations", "/m/admin/access"]);
  });

  // UX-UG-ADMIN-NOT-TOLD-ONBOARDING-NEEDS-CHECKLIST-20261018.
  it("tells the admin members see the built-in starting list until the organization adds its own checklist, and links there", async () => {
    const navigate = vi.fn();
    renderPage({ navigate });
    await startPublic();
    fireEvent.click(screen.getByRole("button", { name: "Check 2 items" }));
    await screen.findByText("Ready: 2 items will be created.");
    fireEvent.click(screen.getByRole("button", { name: "Create 2" }));
    expect(await screen.findByText("New workers see Union Ground's built-in starting list until you add your own new-worker checklist in Worker support > Onboarding.")).toBeTruthy();
    expect(screen.queryByText(/no guide/i)).toBeNull();
    const link = screen.getByRole("link", { name: "Add a new-worker checklist" });
    expect(link.getAttribute("href")).toBe("/m/support/onboarding");
    fireEvent.click(link);
    expect(navigate).toHaveBeenLastCalledWith("memberSupport", "/m/support/onboarding", null, { replace: false });
  });

  it("leaves the checklist link to the browser outside a workspace", async () => {
    renderPage();
    await startPublic();
    fireEvent.click(screen.getByRole("button", { name: "Check 2 items" }));
    await screen.findByText("Ready: 2 items will be created.");
    fireEvent.click(screen.getByRole("button", { name: "Create 2" }));
    const link = await screen.findByRole("link", { name: "Add a new-worker checklist" });
    let prevented = null;
    const record = (event) => { prevented = event.defaultPrevented; event.preventDefault(); };
    document.addEventListener("click", record);
    fireEvent.click(link);
    document.removeEventListener("click", record);
    expect(prevented).toBe(false);
  });

  it("keeps Confirm off until a clean dry run, and any edit invalidates it", async () => {
    renderPage();
    await startOwn();
    await addOwnRow("Harbor Chapter");
    const create = screen.getByRole("button", { name: "Create 1" });
    expect(create).toBeDisabled();
    expect(screen.getByText("Check your list before you create it. Any change needs a new check.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check 1 items" }));
    await screen.findByText("Ready: 1 items will be created.");
    expect(screen.getByRole("button", { name: "Create 1" })).not.toBeDisabled();
    fireEvent.change(screen.getByDisplayValue("Harbor Chapter"), { target: { value: "Harbor Chapter East" } });
    expect(screen.getByRole("button", { name: "Create 1" })).toBeDisabled();
    expect(screen.queryByText("Ready: 1 items will be created.")).toBeNull();
  });

  it("calls the import with a dry run, then the same payload for real", async () => {
    const { auth, reload, onNotice } = renderPage();
    await startPublic();
    fireEvent.click(screen.getByRole("button", { name: "Check 2 items" }));
    await screen.findByText("Ready: 2 items will be created.");
    fireEvent.click(screen.getByRole("button", { name: "Create 2" }));
    await screen.findByText("Your structure is set up. Invite members next.");
    const calls = importCalls(auth);
    expect(calls.map(([, args]) => [args.p_selected_hat, args.p_dry_run])).toEqual([["admin", true], ["admin", false]]);
    expect(calls[1][1].p_payload).toEqual(calls[0][1].p_payload);
    expect(calls[0][1].p_payload).not.toHaveProperty("dryRun");
    expect(calls[0][1].p_payload.sources[0].sourceLabel).toBe("Union Ground public-record catalog 20260924-01, olms-900000001");
    expect(calls[0][1].p_payload.attestation.authority).toBe(AUTHORITY);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith("Your structure is set up. Invite members next.");
    expect(screen.getByRole("link", { name: "Invite members" })).toHaveAttribute("href", "/m/admin/invitations");
  });

  it("refuses the commit when the release changed, and reloads keeping own rows", async () => {
    let label = "20260924-01";
    const catalog = catalogFake({ status: () => ({ data: { ...LIVE, releaseLabel: label }, error: null }) });
    const { auth } = renderPage({ catalog });
    await startPublic();
    await addOwnRow("Harbor Office", "office");
    fireEvent.change(screen.getByDisplayValue("Riverbend Chapter"), { target: { value: "Riverbend Chapter (edited)" } });
    fireEvent.click(screen.getByRole("button", { name: "Check 3 items" }));
    await screen.findByText("Ready: 3 items will be created.");
    label = "20261024-01";
    fireEvent.click(screen.getByRole("button", { name: "Create 3" }));
    await screen.findByText(/The public record was updated while you were reviewing/);
    expect(importCalls(auth)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Reload the public record" }));
    await screen.findByDisplayValue("Riverbend Chapter");
    expect(screen.getByDisplayValue("Harbor Office")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create 3" })).toBeDisabled();
  });

  it("explains a 42501 as the two-step requirement", async () => {
    const auth = fakeClient((name) => (name === "import_organization_structure" ? { data: null, error: { code: "42501", message: "mfa required" } } : undefined));
    renderPage({ auth });
    await startOwn();
    await addOwnRow("Harbor Chapter");
    fireEvent.click(screen.getByRole("button", { name: "Check 1 items" }));
    expect(await screen.findByText(/Your admin role needs two-step sign-in/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Settings" })).toHaveAttribute("href", "/m/settings/security");
    expect(screen.getByRole("link", { name: "Open Settings" })).not.toHaveAttribute("target");
  });

  it("keeps its own review destination in the plain two-step detour without discarding the draft", async () => {
    const originalUrl = window.location.href;
    window.history.replaceState({}, "", "/m/admin/setup-review");
    try {
      const auth = fakeClient((name) => (name === "import_organization_structure" ? { data: null, error: { code: "42501", message: "mfa required" } } : undefined));
      renderPage({ auth });
      await startOwn();
      await addOwnRow("Harbor Chapter");
      fireEvent.click(screen.getByRole("button", { name: "Check 1 items" }));
      await screen.findByText(/Your admin role needs two-step sign-in/);
      const link = screen.getByRole("link", { name: "Open Settings" });
      expect(new URL(link.href).searchParams.get("setupReturnTo")).toBe("/m/admin/setup-review");
      expect(link).not.toHaveAttribute("target");
      expect(screen.getByDisplayValue("Harbor Chapter")).toBeInTheDocument();
      expect(importCalls(auth)).toHaveLength(1);
    } finally {
      cleanup();
      window.history.replaceState({}, "", originalUrl);
    }
  });

  it("reports an outage as nothing created", async () => {
    const auth = fakeClient((name) => (name === "import_organization_structure" ? { data: null, error: { code: "500", message: "boom" } } : undefined));
    renderPage({ auth });
    await startOwn();
    await addOwnRow("Harbor Chapter");
    fireEvent.click(screen.getByRole("button", { name: "Check 1 items" }));
    expect(await screen.findByText("Something went wrong. Nothing was created.")).toBeInTheDocument();
  });

  it("moves focus to the error summary and links each error to its row", async () => {
    const auth = fakeClient((name, args) => (name === "import_organization_structure" ? {
      data: {
        dryRun: args.p_dry_run, committed: false, warnings: [],
        errors: [
          { path: "chapters[0].chapterKey", code: "chapter_key_taken", message: "x" },
          { path: "attestation.suppliedBy", code: "something_new", message: "x" },
        ],
      },
      error: null,
    } : undefined));
    renderPage({ auth });
    await startOwn();
    await addOwnRow("Harbor Chapter");
    fireEvent.click(screen.getByRole("button", { name: "Check 1 items" }));
    const summary = (await screen.findByText("Some items need attention")).parentElement;
    await waitFor(() => expect(document.activeElement).toBe(summary));
    const link = within(summary).getByRole("link", { name: /Harbor Chapter: Another organization already uses/ });
    fireEvent.click(link);
    expect(document.activeElement).toBe(screen.getByDisplayValue("Harbor Chapter"));
    expect(within(summary).getByText("Something in the list needs attention.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create 1" })).toBeDisabled();
  });

  it("shows the commit's own validation errors instead of success", async () => {
    const auth = fakeClient((name, args) => (name === "import_organization_structure" ? {
      data: { dryRun: args.p_dry_run, committed: false, warnings: [], errors: args.p_dry_run ? [] : [{ path: "", code: "write_refused" }] },
      error: null,
    } : undefined));
    renderPage({ auth });
    await startOwn();
    await addOwnRow("Harbor Chapter");
    fireEvent.click(screen.getByRole("button", { name: "Check 1 items" }));
    await screen.findByText("Ready: 1 items will be created.");
    fireEvent.click(screen.getByRole("button", { name: "Create 1" }));
    expect(await screen.findByText("The structure couldn't be saved. Nothing was created.")).toBeInTheDocument();
    expect(screen.queryByText("Your structure is set up. Invite members next.")).toBeNull();
  });
});

describe("setup review: leaving, language and accessibility", () => {
  it("guards leaving with unsaved rows and warns before unload", async () => {
    const add = vi.spyOn(window, "addEventListener");
    renderPage();
    await startOwn();
    await addOwnRow("Harbor Chapter");
    expect(add).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    const handler = add.mock.calls.find(([type]) => type === "beforeunload")[1];
    const event = new Event("beforeunload", { cancelable: true });
    handler(event);
    expect(event.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave without creating anything?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByDisplayValue("Harbor Chapter")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(screen.queryByDisplayValue("Harbor Chapter")).toBeNull());
    // Nothing is dirty now, so Cancel leaves without asking.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("marks only catalog-derived names as English on a Spanish page", async () => {
    renderPage({ lang: "es" });
    const radio = await screen.findByRole("radio", { name: "Empezar con el registro público" });
    await waitFor(() => expect(radio).not.toBeDisabled());
    fireEvent.click(radio);
    fireEvent.change(screen.getByLabelText("Busca en el registro público por nombre, número de local o ciudad"), { target: { value: "Example" } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Example Workers Local 1/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Importar datos públicos al borrador" }));
    expect(await screen.findByDisplayValue("Riverbend Chapter")).toHaveAttribute("lang", "en");
    fireEvent.click(screen.getByRole("button", { name: "Agregar una campaña u oficina" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Nombre"), { target: { value: "Capítulo del Puerto" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Agregar" }));
    expect(await screen.findByDisplayValue("Capítulo del Puerto")).not.toHaveAttribute("lang");
    expect(screen.getByText("Example Workers Local 1", { selector: "span" })).toHaveAttribute("lang", "en");
  });

  it("passes the jsdom axe rules for labels, buttons, ARIA values and lists", async () => {
    const { container } = renderPage();
    await startPublic();
    await act(async () => {});
    const results = await axe.run(container, { runOnly: { type: "rule", values: ["label", "button-name", "aria-valid-attr-value", "list", "listitem"] } });
    expect(results.violations).toEqual([]);
  });
});

// Review of  (lane uc-4a-ui-review): one regression test per repaired finding.
describe("setup review: review repairs", () => {
  const commitCalls = (auth) => importCalls(auth).filter(([, args]) => args.p_dry_run === false);

  it("pins the reloaded release, so a reload after a release change can be checked and created", async () => {
    let label = "20260924-01";
    const catalog = catalogFake({ status: () => ({ data: { ...LIVE, releaseLabel: label }, error: null }) });
    const { auth } = renderPage({ catalog });
    await startPublic();
    fireEvent.click(screen.getByRole("button", { name: "Check 2 items" }));
    await screen.findByText("Ready: 2 items will be created.");
    label = "20261024-01";
    fireEvent.click(screen.getByRole("button", { name: "Create 2" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reload the public record" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Review your structure" })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Check 2 items" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Check 2 items" }));
    await screen.findByText("Ready: 2 items will be created.");
    fireEvent.click(screen.getByRole("button", { name: "Create 2" }));
    await screen.findByText("Your structure is set up. Invite members next.", { selector: "p" });
    expect(commitCalls(auth)).toHaveLength(1);
    expect(commitCalls(auth)[0][1].p_payload.sources[0].sourceLabel).toContain("20261024-01");
  });

  it("drops Undo when the path changes, so a public-record row never returns to Build my own", async () => {
    renderPage();
    await startPublic();
    await addOwnRow("Example Workers Office", "office");
    fireEvent.click(screen.getByRole("button", { name: "Remove Riverbend Chapter" }));
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Build my own" }));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByDisplayValue("Example Workers North Council")).toBeNull();
    expect(screen.getByDisplayValue("Example Workers Office")).toBeInTheDocument();
  });

  it("refuses a list over 500 items instead of cutting it short", async () => {
    const many = { ...PROFILE, subunits: Array.from({ length: 500 }, (_, index) => ({ key: `sub-${index}`, parentKey: null, kind: "chapter", name: `Example Workers ${index}`, asOf: "2026-08-01" })) };
    const { auth } = renderPage({ catalog: catalogFake({ profile: many }) });
    const radio = await screen.findByRole("radio", { name: "Start from the public record" });
    await waitFor(() => expect(radio).not.toBeDisabled());
    fireEvent.click(radio);
    fireEvent.change(screen.getByLabelText("Search the public record by name, local number or city"), { target: { value: "Example" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Example Workers Local 1/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Import public details into draft" }));
    await screen.findByDisplayValue("Example Workers 499");
    // 500 rows put 500 Remove buttons on the page, and each page-wide button
    // query computed every one's accessible name: most of this case's time,
    // which passed 20 s on loaded CI runners
    // (OPS-UG-SETUP-REVIEW-500-ITEM-TEST-TIMEOUT-20261008). Each
    // button is still found by role and name, inside its own button row.
    const button = (name) => within(screen.getByText(name, { selector: "button" }).closest(".xus-btnrow")).getByRole("button", { name });
    fireEvent.click(button("Add a campaign or office"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Example Workers Office" } });
    fireEvent.change(within(dialog).getByLabelText("Type"), { target: { value: "office" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(button("Check 501 items")).toBeDisabled();
    expect(button("Create 501")).toHaveAccessibleDescription(/more than 500 items/);
    expect(importCalls(auth)).toEqual([]);
    // Still the file's slowest case (every edit re-renders 500 rows), so it
    // keeps a wider limit than the 20 s it overran.
  }, 60000);

  it("creates exactly the body the dry run checked, even after a language change", async () => {
    const auth = fakeClient(importOk);
    const catalog = catalogFake();
    const props = { api: apiFor(auth), data: { member: { organizationId: ORG, fullName: "Example Admin" } }, organization: { chapters: [] }, catalogClient: catalog, reload: vi.fn(), onNotice: vi.fn() };
    const { rerender } = render(<LanguageProvider lang="en"><SetupReviewPage {...props} /></LanguageProvider>);
    await startPublic();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include officer and board seat outlines (no names)" }));
    // An edited authority does not follow the language, so the check stays valid.
    fireEvent.change(screen.getByLabelText("Authority"), { target: { value: "Accepted by the Example Workers board" } });
    fireEvent.click(screen.getByRole("button", { name: "Check 3 items" }));
    await screen.findByText("Ready: 3 items will be created.");
    rerender(<LanguageProvider lang="es"><SetupReviewPage {...props} /></LanguageProvider>);
    const create = await screen.findByRole("button", { name: "Crear 3" });
    await waitFor(() => expect(create).not.toBeDisabled());
    fireEvent.click(create);
    await waitFor(() => expect(commitCalls(auth)).toHaveLength(1));
    const [dry, commit] = importCalls(auth).map(([, args]) => args.p_payload);
    expect(commit).toEqual(dry);
  });

  it("moves focus to the success note after the structure is created", async () => {
    renderPage();
    await startOwn();
    await addOwnRow("Example Workers Chapter");
    fireEvent.click(screen.getByRole("button", { name: "Check 1 items" }));
    await screen.findByText("Ready: 1 items will be created.");
    fireEvent.click(screen.getByRole("button", { name: "Create 1" }));
    const note = await screen.findByText("Your structure is set up. Invite members next.", { selector: "p" });
    await waitFor(() => expect(document.activeElement).toBe(note));
  });

  it("moves focus to Undo after Remove, and back to the row after Undo", async () => {
    renderPage();
    await startOwn();
    await addOwnRow("Example Workers Chapter");
    fireEvent.click(screen.getByRole("button", { name: "Remove Example Workers Chapter" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Undo" })));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByDisplayValue("Example Workers Chapter")));
  });

  it("does not open Build my own full of errors, and explains each field once it is flagged", async () => {
    renderPage({ auth: fakeClient(importOk) });
    fireEvent.click(await screen.findByRole("radio", { name: "Build my own" }));
    const root = screen.getByLabelText("Organization name at the top of your chart");
    expect(root).not.toHaveAttribute("aria-invalid");
    await addOwnRow("Example Workers Chapter");
    expect(root).toHaveAttribute("aria-invalid", "true");
    expect(root).toHaveAccessibleDescription("Enter a name of up to 160 characters.");
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "" } });
    expect(screen.getByLabelText("Your name")).toHaveAccessibleDescription("Enter your name, up to 160 characters.");
    fireEvent.change(screen.getByLabelText("Authority"), { target: { value: "" } });
    expect(screen.getByLabelText("Authority")).toHaveAccessibleDescription("Say who accepted this, in up to 240 characters.");
  });

  it("names each row's type control after its row", async () => {
    renderPage();
    await startOwn();
    await addOwnRow("Example Workers Chapter");
    expect(screen.getByRole("combobox", { name: "Type: Example Workers Chapter" })).toBeInTheDocument();
  });

  it("marks catalog names as English in the removed status and the Remove button on a Spanish page", async () => {
    renderPage({ lang: "es" });
    const radio = await screen.findByRole("radio", { name: "Empezar con el registro público" });
    await waitFor(() => expect(radio).not.toBeDisabled());
    fireEvent.click(radio);
    fireEvent.change(screen.getByLabelText("Busca en el registro público por nombre, número de local o ciudad"), { target: { value: "Example" } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Example Workers Local 1/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Importar datos públicos al borrador" }));
    const button = await screen.findByRole("button", { name: "Quitar Riverbend Chapter" });
    expect(within(button).getByText("Riverbend Chapter")).toHaveAttribute("lang", "en");
    fireEvent.click(button);
    const status = screen.getByText(/Se quitó/);
    expect(within(status).getByText("Riverbend Chapter")).toHaveAttribute("lang", "en");
  });

  it("clears Ready and turns Create off when the commit returns errors", async () => {
    const auth = fakeClient((name, args) => (name === "import_organization_structure" ? {
      data: { dryRun: args.p_dry_run, committed: false, warnings: [], errors: args.p_dry_run ? [] : [{ path: "", code: "write_refused" }] },
      error: null,
    } : undefined));
    renderPage({ auth });
    await startOwn();
    await addOwnRow("Example Workers Chapter");
    fireEvent.click(screen.getByRole("button", { name: "Check 1 items" }));
    await screen.findByText("Ready: 1 items will be created.");
    fireEvent.click(screen.getByRole("button", { name: "Create 1" }));
    await screen.findByText("The structure couldn't be saved. Nothing was created.");
    expect(screen.queryByText("Ready: 1 items will be created.")).toBeNull();
    expect(screen.getByRole("button", { name: "Create 1" })).toBeDisabled();
  });

  it("never shows success for an uncommitted answer with no errors", async () => {
    const auth = fakeClient((name, args) => (name === "import_organization_structure" ? { data: { dryRun: args.p_dry_run, committed: false, warnings: [], errors: [] }, error: null } : undefined));
    const { reload, onNotice } = renderPage({ auth });
    await startOwn();
    await addOwnRow("Example Workers Chapter");
    fireEvent.click(screen.getByRole("button", { name: "Check 1 items" }));
    await screen.findByText("Ready: 1 items will be created.");
    fireEvent.click(screen.getByRole("button", { name: "Create 1" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create 1" })).toBeDisabled());
    expect(screen.queryByText("Your structure is set up. Invite members next.")).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("reports a failed catalog search and a failed profile load", async () => {
    const searchFails = fakeClient((name) => {
      if (name === "get_union_catalog_status") return { data: LIVE, error: null };
      if (name === "search_union_catalog") return { data: null, error: { code: "500", message: "boom" } };
      return undefined;
    });
    const first = renderPage({ catalog: searchFails });
    const radio = await screen.findByRole("radio", { name: "Start from the public record" });
    await waitFor(() => expect(radio).not.toBeDisabled());
    fireEvent.click(radio);
    fireEvent.change(screen.getByLabelText("Search the public record by name, local number or city"), { target: { value: "Example" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong. Nothing was created.");
    first.unmount();

    const profileFails = fakeClient((name) => {
      if (name === "get_union_catalog_status") return { data: LIVE, error: null };
      if (name === "search_union_catalog") return { data: { rows: [{ key: "olms-900000001", name: "Example Workers Local 1" }] }, error: null };
      if (name === "get_union_catalog_profile") return { data: null, error: { code: "500", message: "boom" } };
      return undefined;
    });
    renderPage({ catalog: profileFails });
    const again = await screen.findByRole("radio", { name: "Start from the public record" });
    await waitFor(() => expect(again).not.toBeDisabled());
    fireEvent.click(again);
    fireEvent.change(screen.getByLabelText("Search the public record by name, local number or city"), { target: { value: "Example" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Example Workers Local 1/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong. Nothing was created.");
  });

  it("refuses an over-long root name, keeps a typed root name on pick, and guards leaving after a removal", async () => {
    renderPage();
    const radio = await screen.findByRole("radio", { name: "Start from the public record" });
    await waitFor(() => expect(radio).not.toBeDisabled());
    fireEvent.click(radio);
    fireEvent.change(screen.getByLabelText("Organization name at the top of your chart"), { target: { value: "Example Workers Typed" } });
    fireEvent.change(screen.getByLabelText("Search the public record by name, local number or city"), { target: { value: "Example" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Example Workers Local 1/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Import public details into draft" }));
    await screen.findByDisplayValue("Riverbend Chapter");
    expect(screen.getByLabelText("Organization name at the top of your chart")).toHaveValue("Example Workers Typed");
    fireEvent.change(screen.getByLabelText("Organization name at the top of your chart"), { target: { value: "x".repeat(161) } });
    expect(screen.getByRole("button", { name: "Check 2 items" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove Riverbend Chapter" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Example Workers North Council" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("dialog", { name: "Leave without creating anything?" })).toBeInTheDocument();
  });
});

// REQ-UG-FOUNDER-SOLE-ADMIN-HANDOFF-TO-OFFICERS-20261006: a member who
// set up the union found "Accepted in setup review by the organization's
// admin" already claimed for them, and no way to hand over to the elected
// president once they were the only admin.
describe("setup review: founder authority and handoff", () => {
  it.each([["own", startOwn], ["public", startPublic]])("starts the authority attestation empty on the %s path and refuses a check until it is stated", async (_path, start) => {
    renderPage();
    await start();
    fillAuthority("");
    const field = screen.getByLabelText("Authority");
    expect(field).toHaveValue("");
    expect(field).toHaveAttribute("placeholder", expect.stringMatching(/^For example: /));
    if (_path === "own") await addOwnRow("Harbor Chapter");
    const check = screen.getByRole("button", { name: /^Check \d+ items$/ });
    expect(check).toBeDisabled();
    expect(screen.getByText("Say who accepted this, in up to 240 characters.")).toBeInTheDocument();
    fillAuthority();
    expect(check).not.toBeDisabled();
  });

  it("guides the founder to hand the organization to the elected president after creating it", async () => {
    renderPage();
    await startOwn();
    await addOwnRow("Harbor Chapter");
    fireEvent.click(screen.getByRole("button", { name: "Check 1 items" }));
    await screen.findByText("Ready: 1 items will be created.");
    fireEvent.click(screen.getByRole("button", { name: "Create 1" }));
    const handoff = within(await screen.findByRole("region", { name: "Not an elected officer? Hand this organization to them" }));
    const steps = handoff.getAllByRole("listitem").map((item) => item.textContent);
    expect(steps).toEqual([
      "Invite your president as a member.",
      "When they have joined, grant them Admin and then President on Organization roles & access. Staff need two-step sign-in, so these roles work for them only after they set up an authenticator app, or while they are signed in with a passkey.",
      "Once your president can open Organization roles & access themselves, they remove your Admin role there. Do not remove it yourself first: until they can open that page, you are the only one who can.",
    ]);
    // Conditional, because setup review also runs for organizations that
    // already have other admins (gate round 1 on).
    expect(handoff.getByText(/^If you are this organization's only admin/)).toBeInTheDocument();
    expect(handoff.getByRole("link", { name: "Open Organization roles & access" })).toHaveAttribute("href", "/m/admin/access");
  });

  it("starts the attestation empty in Spanish too", async () => {
    renderPage({ lang: "es" });
    fireEvent.click(await screen.findByRole("radio", { name: "Crear la mía desde cero" }));
    expect(screen.getByLabelText("Autoridad")).toHaveValue("");
    expect(screen.getByLabelText("Autoridad")).toHaveAttribute("placeholder", expect.stringMatching(/^Por ejemplo: /));
  });
});

async function startSelectedPublicProfile(catalog, selection = "all") {
  const result = renderPage({ catalog });
  const start = await screen.findByRole("radio", { name: "Start from the public record" });
  await waitFor(() => expect(start).not.toBeDisabled());
  fireEvent.click(start);
  fireEvent.change(screen.getByLabelText("Search the public record by name, local number or city"), { target: { value: "Example" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  fireEvent.click(await screen.findByRole("radio", { name: /Example Workers Local 1/ }));
  await screen.findByRole("button", { name: "Import public details into draft" });
  fireEvent.change(screen.getByLabelText("Public details to import"), { target: { value: selection } });
  fireEvent.click(screen.getByRole("button", { name: "Import public details into draft" }));
  await waitFor(() => expect(screen.getAllByLabelText("Name").length).toBeGreaterThan(0));
  fillAuthority();
  return result;
}

describe("setup review: public release repairs", () => {
  it("drops removed subunit seats while retaining organization seats", async () => {
    const profile = { ...PROFILE, seatOutlines: [
      { key: "removed-president", subunitKey: "sub-b", seatClass: "officer", title: "Removed President" },
      { key: "root-president", subunitKey: null, seatClass: "officer", title: "Root President" },
    ] };
    const { auth } = await startSelectedPublicProfile(catalogFake({ profile }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include officer and board seat outlines (no names)" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Riverbend Chapter" }));
    fireEvent.click(screen.getByRole("button", { name: "Check 2 items" }));
    await screen.findByText("Ready: 2 items will be created.");
    fireEvent.click(screen.getByRole("button", { name: "Create 2" }));
    await screen.findByText("Your structure is set up. Invite members next.");
    const payload = importCalls(auth).at(-1)[1].p_payload;
    const role = payload.charts.union.nodes.find(node => node.nodeKind === "role");
    expect(role.parentKey).toBe("cat.root");
    expect(payload.charts.union.nodes.filter(node => node.nodeKind === "role")).toHaveLength(1);
    expect(role.label).toBe("Root President");
    expect(importCalls(auth).at(-1)[1].p_dry_run).toBe(false);
  });

  it("retains All intent when a release adds subunits to an empty profile", async () => {
    let profile = { ...PROFILE, subunits: [] }, release = LIVE;
    const catalog = fakeClient((name) => {
      if (name === "get_union_catalog_status") return { data: release, error: null };
      if (name === "search_union_catalog") return { data: { rows: [PROFILE.organization] }, error: null };
      if (name === "get_union_catalog_profile") return { data: profile, error: null };
    });
    const { auth } = await startSelectedPublicProfile(catalog);
    fireEvent.click(screen.getByRole("button", { name: "Check 1 items" }));
    await screen.findByText("Ready: 1 items will be created.");
    release = { ...LIVE, releaseLabel: "20261025-01" };
    profile = { ...PROFILE, subunits: [{ ...PROFILE.subunits[1], parentKey: null }] };
    fireEvent.click(screen.getByRole("button", { name: "Create 1" }));
    await screen.findByText(/The public record was updated while you were reviewing/);
    fireEvent.click(screen.getByRole("button", { name: "Reload the public record" }));
    await waitFor(() => expect(catalog.calls.filter(([name]) => name === "get_union_catalog_profile")).toHaveLength(2));
    await screen.findByDisplayValue("Riverbend Chapter");
    expect(screen.getAllByLabelText("Name").map(input => input.value)).toEqual(["Riverbend Chapter"]);
    expect(screen.getByLabelText("Public details to import")).toHaveValue("all");
    fireEvent.click(screen.getByRole("button", { name: "Check 1 items" }));
    await screen.findByText("Ready: 1 items will be created.");
    fireEvent.click(screen.getByRole("button", { name: "Create 1" }));
    await screen.findByText("Your structure is set up. Invite members next.");
    const payload = importCalls(auth).at(-1)[1].p_payload;
    expect(payload.chapters).toHaveLength(1);
    expect(payload.chapters[0].name).toBe("Riverbend Chapter");
  });

  it("invalidates a missing selected subunit and requires a new import", async () => {
    let profile = PROFILE, release = LIVE;
    const catalog = fakeClient((name) => {
      if (name === "get_union_catalog_status") return { data: release, error: null };
      if (name === "search_union_catalog") return { data: { rows: [PROFILE.organization] }, error: null };
      if (name === "get_union_catalog_profile") return { data: profile, error: null };
    });
    const { auth } = await startSelectedPublicProfile(catalog, "sub-b");
    fireEvent.click(screen.getByRole("button", { name: "Check 1 items" }));
    await screen.findByText("Ready: 1 items will be created.");
    release = { ...LIVE, releaseLabel: "20261025-01" };
    profile = { ...PROFILE, subunits: [PROFILE.subunits[0]] };
    fireEvent.click(screen.getByRole("button", { name: "Create 1" }));
    await screen.findByText(/The public record was updated while you were reviewing/);
    fireEvent.click(screen.getByRole("button", { name: "Reload the public record" }));
    await waitFor(() => expect(catalog.calls.filter(([name]) => name === "get_union_catalog_profile")).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText(/The public record was updated while you were reviewing/)).toBeNull());
    await screen.findByText("Your selection is no longer in the public record. Choose public details to import again, or build your own.");
    expect(screen.getByRole("button", { name: "Create 0" })).toBeDisabled();
    expect(screen.queryByDisplayValue("Riverbend Chapter")).toBeNull();
    expect(screen.queryByText("Ready: 1 items will be created.")).toBeNull();
    expect(importCalls(auth)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Import public details into draft" }));
    await screen.findByDisplayValue(PROFILE.subunits[0].name);
    expect(screen.queryByText(/Your selection is no longer/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check 1 items" }));
    await screen.findByText("Ready: 1 items will be created.");
    fireEvent.click(screen.getByRole("button", { name: "Create 1" }));
    await screen.findByText("Your structure is set up. Invite members next.");
  });
});

// The setup steps (search, import, check, create,
// reload) share one synchronous lock, refused before React commits busy, and
// each control keeps focus while its step runs. A pick is a radio choice that
// React commits before the next event, so its pending radios refuse alone. Each step releases the lock
// where it clears busy, so a step that finished synchronously leaves the next
// one free in the same tick (the import-then-check tests above).
describe("setup review: one step at a time", () => {
  const SECOND = { ...PROFILE, organization: { key: "olms-900000003", name: "Example Workers Local 3" } };
  function spiedCatalog(profiles = { [PROFILE.organization.key]: PROFILE }) {
    const catalog = fakeClient((name, args) => {
      if (name === "get_union_catalog_status") return { data: LIVE, error: null };
      if (name === "search_union_catalog") return { data: { rows: Object.values(profiles).map((row) => ({ key: row.organization.key, name: row.organization.name })) }, error: null };
      if (name === "get_union_catalog_profile") return { data: profiles[args.p_key] ?? { found: false }, error: null };
      return undefined;
    });
    catalog.rpc = vi.fn(catalog.rpc);
    return catalog;
  }
  const named = (rpcName) => ({ isWrite: (name) => name === rpcName });
  const twice = (control) => [() => fireEvent.click(control), () => fireEvent.click(control)];
  async function searchFor(text = "Example") {
    const radio = await screen.findByRole("radio", { name: "Start from the public record" });
    await waitFor(() => expect(radio).not.toBeDisabled());
    fireEvent.click(radio);
    fireEvent.change(screen.getByLabelText("Search the public record by name, local number or city"), { target: { value: text } });
    return screen.getByRole("button", { name: "Search" });
  }

  it("searches once when Search is pressed twice in one tick, and keeps it focused while it searches", async () => {
    const catalog = spiedCatalog();
    renderPage({ catalog });
    const search = await searchFor();
    await expectOneWriteFromOneTick(catalog.rpc, twice(search), named("search_union_catalog"));
    await screen.findByRole("radio", { name: /Example Workers Local 1/ });
    await expectHeldWriteFocus(catalog.rpc, search);
  });

  it("loads one public profile when two search matches are chosen in one tick", async () => {
    const catalog = spiedCatalog({ [PROFILE.organization.key]: PROFILE, [SECOND.organization.key]: SECOND });
    renderPage({ catalog });
    fireEvent.click(await searchFor());
    const first = await screen.findByRole("radio", { name: /Example Workers Local 1/ });
    const second = screen.getByRole("radio", { name: /Example Workers Local 3/ });
    await expectOneWriteFromOneTick(catalog.rpc, [() => fireEvent.click(first), () => fireEvent.click(second)], named("get_union_catalog_profile"));
  });

  it("loads a child local's record once when Import is pressed twice in one tick", async () => {
    const child = { found: true, organization: { key: "olms-900000002", name: "Child local" }, subunits: [], seatOutlines: [] };
    const catalog = spiedCatalog({ [PROFILE.organization.key]: { ...PROFILE, children: [{ key: "olms-900000002", name: "Child local" }] }, [child.organization.key]: child });
    renderPage({ catalog });
    await startPublic();
    fireEvent.change(screen.getByLabelText("Public details to import"), { target: { value: "child:olms-900000002" } });
    const importButton = screen.getByRole("button", { name: "Import public details into draft" });
    await expectOneWriteFromOneTick(catalog.rpc, twice(importButton), { isWrite: (name, args) => name === "get_union_catalog_profile" && args.p_key === child.organization.key });
    expect(await screen.findAllByDisplayValue("Child local")).not.toHaveLength(0);
  });

  it("checks once when Check is pressed twice in one tick, and keeps it focused while it checks", async () => {
    const auth = fakeClient(importOk);
    auth.rpc = vi.fn(auth.rpc);
    renderPage({ auth });
    await startPublic();
    // The check builds its body before it sends (an await), so the presses
    // land in one tick and the sends are counted once both have settled.
    const check = screen.getByRole("button", { name: "Check 2 items" });
    await act(async () => { fireEvent.click(check); fireEvent.click(check); });
    await screen.findByText("Ready: 2 items will be created.");
    expect(importCalls(auth)).toHaveLength(1);
    fireEvent.change(screen.getByDisplayValue("Riverbend Chapter"), { target: { value: "Riverbend Chapter East" } });
    let release;
    auth.rpc.mockImplementationOnce((name, args) => new Promise((resolve) => { release = () => resolve(importOk(name, args)); }));
    const again = screen.getByRole("button", { name: "Check 2 items" });
    again.focus();
    fireEvent.click(again);
    const sends = () => auth.rpc.mock.calls.filter(([name]) => name === "import_organization_structure").length;
    await waitFor(() => expect(sends()).toBe(2));
    await expectPendingFocus(again);
    fireEvent.click(again);
    await act(async () => { release(); });
    await screen.findByText("Ready: 2 items will be created.");
    expect(sends()).toBe(2);
  });

  it("creates once when Create is pressed twice in one tick, and keeps it focused while it creates", async () => {
    const catalog = spiedCatalog();
    const { auth } = renderPage({ catalog });
    await startPublic();
    fireEvent.click(screen.getByRole("button", { name: "Check 2 items" }));
    await screen.findByText("Ready: 2 items will be created.");
    const create = screen.getByRole("button", { name: "Create 2" });
    // Create re-reads the release first: one re-read means one create began.
    await expectOneWriteFromOneTick(catalog.rpc, twice(create), named("get_union_catalog_status"));
    await screen.findByText("Your structure is set up. Invite members next.");
    expect(importCalls(auth).filter(([, args]) => args.p_dry_run === false)).toHaveLength(1);
  });

  it("reloads the public record once when Reload is pressed twice in one tick", async () => {
    let label = "20260924-01";
    const catalog = fakeClient((name, args) => {
      if (name === "get_union_catalog_status") return { data: { ...LIVE, releaseLabel: label }, error: null };
      if (name === "search_union_catalog") return { data: { rows: [{ key: PROFILE.organization.key, name: PROFILE.organization.name }] }, error: null };
      if (name === "get_union_catalog_profile") return { data: args.p_key === PROFILE.organization.key ? PROFILE : { found: false }, error: null };
      return undefined;
    });
    catalog.rpc = vi.fn(catalog.rpc);
    renderPage({ catalog });
    await startPublic();
    fireEvent.click(screen.getByRole("button", { name: "Check 2 items" }));
    await screen.findByText("Ready: 2 items will be created.");
    label = "20261024-01";
    fireEvent.click(screen.getByRole("button", { name: "Create 2" }));
    await screen.findByText(/The public record was updated while you were reviewing/);
    const reload = screen.getByRole("button", { name: "Reload the public record" });
    await expectOneWriteFromOneTick(catalog.rpc, twice(reload), named("get_union_catalog_status"));
    await screen.findByDisplayValue("Riverbend Chapter");
  });

  // Review of slice 8 (F1), then a review note: the search has its own lock and
  // pending mark beside the draft's steps. A pick made in the same tick as a
  // held search runs, as before slice 8, and its completion cannot make Search
  // read ready while the search still runs, so no ready Search drops a press.
  it("runs a pick made in the same tick as a held search, keeps Search pending until it settles, then searches", async () => {
    let finishSearch;
    let searches = 0;
    const catalog = spiedCatalog({ [PROFILE.organization.key]: PROFILE, [SECOND.organization.key]: SECOND });
    const original = catalog.rpc.getMockImplementation();
    catalog.rpc.mockImplementation((name, args) => {
      if (name === "search_union_catalog" && ++searches === 2) return new Promise((resolve) => { finishSearch = () => resolve(original(name, args)); });
      return original(name, args);
    });
    renderPage({ catalog });
    fireEvent.click(await searchFor());
    const match = await screen.findByRole("radio", { name: /Example Workers Local 1/ });
    const search = screen.getByRole("button", { name: "Search" });
    await act(async () => { fireEvent.click(search); fireEvent.click(match); });
    const profiles = () => catalog.rpc.mock.calls.filter(([name]) => name === "get_union_catalog_profile").length;
    expect(searches).toBe(2);
    expect(profiles()).toBe(1);
    // The profile settles first; Search still reads pending while its read runs.
    await screen.findByRole("button", { name: "Import public details into draft" });
    expect(search).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(search);
    expect(searches).toBe(2);
    await act(async () => { finishSearch(); });
    await waitFor(() => expect(search).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(search);
    expect(searches).toBe(3);
    // After the search settles, a fresh pick of a ready result loads its profile.
    const other = await screen.findByRole("radio", { name: /Example Workers Local 3/ });
    await waitFor(() => expect(other).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(other);
    await waitFor(() => expect(profiles()).toBe(2));
    expect(catalog.rpc.mock.calls.filter(([name]) => name === "get_union_catalog_profile").at(-1)[1]).toEqual({ p_key: SECOND.organization.key });
  });

  // A create that settles after the person left the organization
  // announces and reloads nothing; a new address in the same organization
  // (the session remounts) still announces the create that finished.
  async function heldCreate(change) {
    let finish;
    const auth = fakeClient((name, args) => {
      if (name === "import_organization_structure" && !args.p_dry_run) return new Promise((resolve) => { finish = () => resolve(importOk(name, args)); });
      return importOk(name, args);
    });
    const reload = vi.fn();
    const onNotice = vi.fn();
    const catalog = catalogFake();
    const page = (organizationId) => (
      <LanguageProvider lang="en">
        <SetupReviewPage api={apiFor(auth)} data={{ member: { organizationId, fullName: "Example Admin" } }} organization={{ chapters: [{ name: "Main Chapter" }] }} catalogClient={catalog} reload={reload} onNotice={onNotice} />
      </LanguageProvider>
    );
    const view = render(page(ORG));
    await startPublic();
    fireEvent.click(screen.getByRole("button", { name: "Check 2 items" }));
    await screen.findByText("Ready: 2 items will be created.");
    fireEvent.click(screen.getByRole("button", { name: "Create 2" }));
    await waitFor(() => expect(importCalls(auth).filter(([, args]) => args.p_dry_run === false)).toHaveLength(1));
    change(view, page);
    await act(async () => { finish(); });
    return { reload, onNotice };
  }

  it("announces and reloads nothing when a create settles after the person left the organization", async () => {
    const { reload, onNotice } = await heldCreate((view, page) => view.rerender(page("a1b2c3d4-0000-4000-8000-000000000002")));
    expect(onNotice).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("still announces a create that settles after a new address in the same organization", async () => {
    const { reload, onNotice } = await heldCreate((view, page) => {
      window.history.replaceState({}, "", "/m/admin/setup-review?step=review");
      view.rerender(page(ORG));
    });
    window.history.replaceState({}, "", "/");
    expect(onNotice).toHaveBeenCalledWith("Your structure is set up. Invite members next.");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // Slice 9 review: the fence's owner is above the views (the app passes its
  // guard, keyed by member and organization), so leaving this page or
  // switching hat keeps the completion, and only a departure drops it.
  function Owner({ member, children }) {
    const scope = useBusyScope(JSON.stringify([member.id, member.organizationId]));
    return children(scope.guard);
  }
  async function heldCreateUnderOwner(change) {
    let finish;
    const auth = fakeClient((name, args) => {
      if (name === "import_organization_structure" && !args.p_dry_run) return new Promise((resolve) => { finish = () => resolve(importOk(name, args)); });
      return importOk(name, args);
    });
    const reload = vi.fn();
    const onNotice = vi.fn();
    const catalog = catalogFake();
    const tree = ({ memberId = "admin-1", organizationId = ORG, view = "admin", location = "/m/admin/setup-review" } = {}) => (
      <LanguageProvider lang="en">
        <Owner member={{ id: memberId, organizationId }}>{(guard) => view !== "admin" ? <p>Steward desk</p> : (
          <WorkspacePages view="admin" location={location} hat="admin" navigate={vi.fn()}>
            <WorkspaceSection name="admin-setup-review">
              <SetupReviewPage api={apiFor(auth)} data={{ member: { id: memberId, organizationId, fullName: "Example Admin" } }} organization={{ chapters: [{ name: "Main Chapter" }] }} catalogClient={catalog} reload={reload} onNotice={onNotice} organizationGuard={guard} />
            </WorkspaceSection>
          </WorkspacePages>
        )}</Owner>
      </LanguageProvider>
    );
    window.history.replaceState({}, "", "/m/admin/setup-review");
    const view = render(tree());
    try {
      await startPublic();
      fireEvent.click(screen.getByRole("button", { name: "Check 2 items" }));
      await screen.findByText("Ready: 2 items will be created.");
      fireEvent.click(screen.getByRole("button", { name: "Create 2" }));
      await waitFor(() => expect(importCalls(auth).filter(([, args]) => args.p_dry_run === false)).toHaveLength(1));
      change((options = {}) => {
        window.history.replaceState({}, "", options.location ?? "/m/admin/setup-review");
        view.rerender(tree(options));
      });
      await act(async () => { finish(); });
    } finally {
      window.history.replaceState({}, "", "/");
    }
    return { reload, onNotice };
  }
  const SUCCESS = "Your structure is set up. Invite members next.";

  it("still announces and reloads a create that settles after the person left the setup page for another page", async () => {
    const { reload, onNotice } = await heldCreateUnderOwner((show) => show({ location: "/m/admin/member-directory" }));
    expect(screen.queryByRole("button", { name: "Create 2" })).toBeNull();
    expect(onNotice).toHaveBeenCalledWith(SUCCESS);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("still announces and reloads a create that settles after a hat switch", async () => {
    const { reload, onNotice } = await heldCreateUnderOwner((show) => show({ view: "steward" }));
    expect(screen.getByText("Steward desk")).toBeInTheDocument();
    expect(onNotice).toHaveBeenCalledWith(SUCCESS);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("announces and reloads once for a create that settles after the person left the setup page and came back", async () => {
    const { reload, onNotice } = await heldCreateUnderOwner((show) => { show({ location: "/m/admin/member-directory" }); show({}); });
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith(SUCCESS);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the organization", { organizationId: "a1b2c3d4-0000-4000-8000-000000000002" }],
    ["the member", { memberId: "admin-2" }],
  ])("announces and reloads nothing when a create settles after %s changed above the page", async (_name, options) => {
    const { reload, onNotice } = await heldCreateUnderOwner((show) => show({ ...options, view: "steward" }));
    expect(onNotice).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("is wired: the app owns the setup completion scope by member and organization and the admin desk passes it to the page", () => {
    const app = readFileSync("src/App.jsx", "utf8");
    expect(app).toContain("const setupCompletionScope = useBusyScope(JSON.stringify([data?.member?.id, data?.member?.organizationId]));");
    expect(app).toContain("setupCompletionGuard={setupCompletionScope.guard}");
    expect(readFileSync("src/views/AdminView.jsx", "utf8")).toContain("organizationGuard={setupCompletionGuard}");
  });

  // The search is a read with its own lock and pending mark, so a
  // check of the draft pressed beside it, in the same update or while it is
  // still running, is not dropped behind it.
  async function heldSearchWithDraft() {
    let finishSearch;
    let searches = 0;
    const catalog = spiedCatalog();
    const original = catalog.rpc.getMockImplementation();
    catalog.rpc.mockImplementation((name, args) => {
      if (name === "search_union_catalog" && ++searches === 2) return new Promise((resolve) => { finishSearch = () => resolve(original(name, args)); });
      return original(name, args);
    });
    const { auth } = renderPage({ catalog });
    await startPublic();
    return { auth, search: screen.getByRole("button", { name: "Search" }), searches: () => searches, finishSearch: () => finishSearch() };
  }

  it("checks the draft when Search and Check are pressed in the same update", async () => {
    const held = await heldSearchWithDraft();
    await act(async () => { fireEvent.click(held.search); fireEvent.click(screen.getByRole("button", { name: "Check 2 items" })); });
    expect(held.searches()).toBe(2);
    await screen.findByText("Ready: 2 items will be created.");
    expect(importCalls(held.auth)).toHaveLength(1);
    expect(held.search).toHaveAttribute("aria-disabled", "true");
    await act(async () => { held.finishSearch(); });
    await waitFor(() => expect(held.search).not.toHaveAttribute("aria-disabled"));
  });

  it("keeps a failed search's alert when a check starts after it", async () => {
    const catalog = spiedCatalog();
    const { auth } = renderPage({ catalog });
    await startPublic();
    const original = catalog.rpc.getMockImplementation();
    catalog.rpc.mockImplementation((name, args) => (name === "search_union_catalog" ? Promise.reject(new Error("offline")) : original(name, args)));
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Something went wrong. Nothing was created.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check 2 items" }));
    await screen.findByText("Ready: 2 items will be created.");
    expect(importCalls(auth)).toHaveLength(1);
    expect(screen.getByText("Something went wrong. Nothing was created.")).toBeInTheDocument();
  });

  it("checks the draft while a search is still running, and each settles its own control", async () => {
    const held = await heldSearchWithDraft();
    fireEvent.click(held.search);
    expect(held.search).toHaveAttribute("aria-disabled", "true");
    const check = screen.getByRole("button", { name: "Check 2 items" });
    expect(check).not.toHaveAttribute("aria-disabled");
    fireEvent.click(check);
    await screen.findByText("Ready: 2 items will be created.");
    expect(importCalls(held.auth)).toHaveLength(1);
    expect(held.search).toHaveAttribute("aria-disabled", "true");
    await act(async () => { held.finishSearch(); });
    await waitFor(() => expect(held.search).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(held.search);
    expect(held.searches()).toBe(3);
  });

  it("keeps Create focused while it re-reads the release", async () => {
    const catalog = spiedCatalog();
    renderPage({ catalog });
    await startPublic();
    fireEvent.click(screen.getByRole("button", { name: "Check 2 items" }));
    await screen.findByText("Ready: 2 items will be created.");
    await expectHeldWriteFocus(catalog.rpc, screen.getByRole("button", { name: "Create 2" }));
  });
});
