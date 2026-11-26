import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { SetupReviewPage } from "../src/features/orgSetup/SetupReviewPage.jsx";
import { unionSetupHref } from "../src/features/unionCatalog/unionIdentity.js";
import { ConnectionSuggestions } from "../src/features/connectionSuggestions/ConnectionSuggestions.jsx";
import { createConnectionPreview } from "../src/features/connectionSuggestions/preview.js";
import { createConnectionAdapter } from "../src/features/connectionSuggestions/adapter.js";
import { normalizePublishedProfile } from "../src/features/connectionSuggestions/engine.js";
import { UnionNetworkNav } from "../src/features/unionCatalog/UnionNetworkNav.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { adminSetupPathFromSearch } from "../src/lib/setupSecurityReturn.js";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

// This edition features no real union; the fictional fixtures stand in.
vi.mock("../src/features/unionCatalog/featuredUnions.js", async (importOriginal) => {
  const { withFeaturedUnionFixture } = await import("./helpers/featuredUnionFixture.js");
  return withFeaturedUnionFixture(await importOriginal());
});

const key = "olms-900000001";
const org = "a1b2c3d4-0000-4000-8000-000000000001";
const profile = { found: true, organization: { key, name: "Example Workers Local 1" },
  subunits: [{ key: "existing-chapter", name: "Existing unrelated chapter", kind: "chapter" }] };
function setup({ parent = null, save, search = unionSetupHref(key).split("?")[1], profileRead = async () => profile,
  statusRead = async () => ({ available: true, releaseLabel: "fixture-1", dataAsOf: "2026-10-16" }) } = {}) {
  window.history.replaceState({}, "", `/m/admin/setup-review?${search}`);
  const catalog = { rpc: vi.fn(async (name, args) => ({ data: name === "get_union_catalog_status"
    ? await statusRead() : await profileRead(args), error: null })) };
  const api = {
    getOrganizationCatalogPlacement: vi.fn(async () => parent),
    setOrganizationCatalogPlacement: save || vi.fn(async () => ({ parentCatalogKey: key, parentName: profile.organization.name, parentActive: true, verificationStatus: "self_reported" })),
    importOrganizationStructure: vi.fn(async (_hat, _payload, dry) => ({ errors: [], committed: !dry })),
  };
  const props = { api, catalogClient: catalog, data: { member: { id: "creator", organizationId: org, fullName: "Example Admin" } }, organization: { name: "Our workplace", chapters: [] } };
  const view = render(<LanguageProvider lang="en"><SetupReviewPage {...props} /></LanguageProvider>);
  return { ...view, api, catalog, props };
}
afterEach(() => { window.history.replaceState({}, "", "/"); });

describe("directory selection becomes a chapter build in the selected place", () => {
  it("refuses a chapter-build profile without an available release to pin", async () => {
    const profileRead = vi.fn(async () => profile);
    const { api } = setup({ profileRead, statusRead: async () => ({ available: false }) });
    await screen.findByRole("button", { name: "Try again" });
    expect(profileRead).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Import public details into draft" })).toBeNull();
    expect(api.setOrganizationCatalogPlacement).not.toHaveBeenCalled();
    expect(api.importOrganizationStructure).not.toHaveBeenCalled();
  });

  it.each(["", "My chapter"])("imports an empty-structure record as one named chapter while retaining own edits: %s", async (ownName) => {
    const { api } = setup({ profileRead: async () => ({ ...profile, subunits: [] }) });
    if (ownName) fireEvent.change(screen.getByLabelText("Name"), { target: { value: ownName } });
    fireEvent.click(await screen.findByRole("button", { name: "Import public details into draft" }));
    expect(screen.getByDisplayValue(profile.organization.name)).toBeInTheDocument();
    expect(screen.getAllByLabelText("Name").map(input => input.value)).toEqual([profile.organization.name, ...(ownName ? [ownName] : [])]);
    expect(api.importOrganizationStructure).not.toHaveBeenCalled();
  });

  it("pins the release before reading a chapter-build profile and refuses a later release", async () => {
    let releaseLabel = "fixture-1";
    const { api } = setup({ parent: { parentCatalogKey: key, parentActive: true },
      statusRead: async () => ({ available: true, releaseLabel, dataAsOf: "2026-10-16" }),
      profileRead: async () => { releaseLabel = "fixture-2"; return profile; } });
    fireEvent.click(await screen.findByRole("button", { name: "Import public details into draft" }));
    fireEvent.change(screen.getByLabelText("Authority"), { target: { value: "Authorized by the founding members" } });
    fireEvent.click(screen.getByRole("button", { name: "Check 1 items" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create 1" })).toBeEnabled());
    expect(api.importOrganizationStructure.mock.calls[0][1].sources[0].sourceLabel).toContain("fixture-1");
    fireEvent.click(screen.getByRole("button", { name: "Create 1" }));
    await screen.findByRole("alert");
    expect(api.importOrganizationStructure).toHaveBeenCalledTimes(1);
  });

  it("shows the imported public-record cap in chapter-build mode", async () => {
    setup({ profileRead: async () => ({ ...profile, subunits: Array.from({ length: 500 }, (_, i) => ({ key: `unit-${i}`, name: `Unit ${i}`, kind: "unit" })) }) });
    fireEvent.click(await screen.findByRole("button", { name: "Import public details into draft" }));
    expect(screen.getByText("Showing the first 500 units from the public record.")).toBeInTheDocument();
  });

  it("names an already-selected parent once instead of showing a duplicate placement", async () => {
    const { container } = setup({ parent: { parentCatalogKey: key, parentName: profile.organization.name, parentActive: true, verificationStatus: "self_reported" } });
    await screen.findByText(/Placement confirmed/);
    expect(container.textContent.split(profile.organization.name)).toHaveLength(2);
  });

  it("offers a draft-only import of the selected record in chapter-build mode", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Import public details into draft" }));
    expect(screen.getByDisplayValue("Existing unrelated chapter")).toBeInTheDocument();
    expect(api.importOrganizationStructure).not.toHaveBeenCalled();
    expect(api.setOrganizationCatalogPlacement).not.toHaveBeenCalled();
  });

  it("imports only the chosen public sub-unit, leaving siblings out of the draft", async () => {
    const { api } = setup({ profileRead: async () => ({ ...profile, subunits: [
      ...profile.subunits,
      { key: "chosen-unit", name: "Harbor Unit", kind: "unit", parentKey: "existing-chapter" },
      { key: "other-unit", name: "Hill Unit", kind: "unit" },
    ] }) });
    fireEvent.change(await screen.findByLabelText("Public details to import"), { target: { value: "chosen-unit" } });
    fireEvent.click(screen.getByRole("button", { name: "Import public details into draft" }));
    expect(screen.getAllByLabelText("Name")).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Harbor Unit");
    expect(screen.queryByDisplayValue("Hill Unit")).toBeNull();
    expect(api.importOrganizationStructure).not.toHaveBeenCalled();
    expect(api.setOrganizationCatalogPlacement).not.toHaveBeenCalled();
  });

  it("checks and confirms only the chosen unit with the exact public source", async () => {
    const { api } = setup({ parent: { parentCatalogKey: key, parentActive: true } });
    fireEvent.change(await screen.findByLabelText("Public details to import"), { target: { value: "existing-chapter" } });
    fireEvent.click(screen.getByRole("button", { name: "Import public details into draft" }));
    fireEvent.change(screen.getByLabelText("Authority"), { target: { value: "Authorized by the founding members" } });
    fireEvent.click(screen.getByRole("button", { name: "Check 1 items" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create 1" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create 1" }));
    await waitFor(() => expect(api.importOrganizationStructure).toHaveBeenCalledTimes(2));
    const draft = api.importOrganizationStructure.mock.calls[0][1];
    expect(draft.chapters.map((row) => row.name)).toEqual(["Existing unrelated chapter"]);
    expect(draft.sources[0].sourceLabel).toContain(key);
    expect(api.importOrganizationStructure.mock.calls[1][1]).toEqual(draft);
    expect(api.setOrganizationCatalogPlacement).not.toHaveBeenCalled();
  });

  it("reads one selected local by exact child key without importing other locals", async () => {
    const childKey = "olms-900000002";
    const { api, catalog } = setup({ profileRead: async ({ p_key }) => p_key === key
      ? { ...profile, children: [{ key: childKey, name: "Example Local 2" }] }
      : { found: true, organization: { key: childKey, name: "Example Local 2" }, contacts: [{ value: "private@example.invalid" }] } });
    fireEvent.change(await screen.findByLabelText("Public details to import"), { target: { value: `child:${childKey}` } });
    fireEvent.click(screen.getByRole("button", { name: "Import public details into draft" }));
    await screen.findByDisplayValue("Example Local 2");
    expect(catalog.rpc).toHaveBeenCalledWith("get_union_catalog_profile", { p_key: childKey });
    expect(screen.getAllByLabelText("Name")).toHaveLength(1);
    expect(screen.queryByDisplayValue("Existing unrelated chapter")).toBeNull();
    expect(api.importOrganizationStructure).not.toHaveBeenCalled();
    expect(api.setOrganizationCatalogPlacement).not.toHaveBeenCalled();
  });

  it.each([null, "olms-900000003"])("keeps the draft when the selected child is unavailable or its identity changes: %s", async (returnedKey) => {
    const childKey = "olms-900000002";
    const { api } = setup({ profileRead: async ({ p_key }) => p_key === key
      ? { ...profile, children: [{ key: childKey, name: "Example Local 2" }] }
      : returnedKey ? { found: true, organization: { key: returnedKey, name: "Different local" } } : { found: false } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Keep this draft" } });
    fireEvent.change(await screen.findByLabelText("Public details to import"), { target: { value: `child:${childKey}` } });
    fireEvent.click(screen.getByRole("button", { name: "Import public details into draft" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong. Nothing was created.");
    expect(screen.getByLabelText("Name")).toHaveValue("Keep this draft");
    expect(api.importOrganizationStructure).not.toHaveBeenCalled();
    expect(api.setOrganizationCatalogPlacement).not.toHaveBeenCalled();
  });

  it("can leave a selected parent and continue the same draft from scratch", async () => {
    const { api } = setup();
    await screen.findByRole("button", { name: "Import public details into draft" });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My draft chapter" } });
    fireEvent.click(screen.getByRole("button", { name: "Build from scratch" }));
    expect(screen.getByRole("radio", { name: "Build my own" })).toBeChecked();
    expect(screen.getByLabelText("Name")).toHaveValue("My draft chapter");
    expect(screen.queryByRole("region", { name: "Your place in the union structure" })).toBeNull();
    expect(api.importOrganizationStructure).not.toHaveBeenCalled();
    expect(api.setOrganizationCatalogPlacement).not.toHaveBeenCalled();
  });

  it.each([false, true])("returns from security with only the active public parent (discarded: %s)", async (discarded) => {
    const { api, props, unmount } = setup({ parent: { parentCatalogKey: key, parentActive: true } });
    await screen.findByText(/Placement confirmed/);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My draft chapter" } });
    fireEvent.change(screen.getByLabelText("Authority"), { target: { value: "Authorized by the founding members" } });
    if (discarded) fireEvent.click(screen.getByRole("button", { name: "Build from scratch" }));
    api.importOrganizationStructure.mockRejectedValue({ code: "42501", message: "mfa required" });
    fireEvent.click(screen.getByRole("button", { name: "Check 1 items" }));
    await screen.findByText(/Your admin role needs two-step sign-in/);
    const securityLink = screen.getByRole("link", { name: "Open Settings" });
    expect(securityLink).not.toHaveAttribute("target");
    // Follow the real security-return parser, then remount as a plain browser
    // navigation does. A discarded parent must not be reconstructed from the
    // entry URL, while a still-active selection must survive this same path.
    const destination = adminSetupPathFromSearch(new URL(securityLink.href).search);
    unmount();
    window.history.replaceState({}, "", destination);
    render(<LanguageProvider lang="en"><SetupReviewPage {...props} /></LanguageProvider>);
    if (discarded) {
      expect(screen.queryByRole("region", { name: "Your place in the union structure" })).toBeNull();
      expect(screen.getByRole("radio", { name: "Build my own" })).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("radio", { name: "Start from the public record" })).toBeEnabled());
      expect(destination).toBe("/m/admin/setup-review");
    } else {
      await screen.findByText(/Placement confirmed/);
      expect(screen.getByRole("region", { name: "Your place in the union structure" })).toBeInTheDocument();
      expect(screen.queryByRole("radio", { name: "Build my own" })).toBeNull();
      expect(destination).toBe(`/m/admin/setup-review?union=${key}&build=chapter`);
    }
    expect(api.importOrganizationStructure).toHaveBeenCalledTimes(1);
    expect(api.setOrganizationCatalogPlacement).not.toHaveBeenCalled();
  });

  // Record 8435: Use this place keeps focus while the placement is saved.
  it("keeps Use this place focused while the placement is saved, and saves it once", async () => {
    const { api } = setup();
    await expectHeldWriteFocus(api.setOrganizationCatalogPlacement, await screen.findByRole("button", { name: "Use this place" }));
    expect(api.setOrganizationCatalogPlacement).toHaveBeenCalledTimes(1);
  });

  it("recovers a selected parent after a catalog outage without creating or placing anything", async () => {
    const profileRead = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(profile);
    const { api } = setup({ profileRead });
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByRole("button", { name: "Use this place" });
    expect(profileRead).toHaveBeenCalledTimes(2);
    expect(api.setOrganizationCatalogPlacement).not.toHaveBeenCalled();
    expect(api.importOrganizationStructure).not.toHaveBeenCalled();
  });
  it("starts exactly one own chapter, confirms self-placement, then checks and creates the same draft", async () => {
    const { api } = setup();
    await screen.findByRole("button", { name: "Use this place" });
    expect(screen.getAllByLabelText("Name")).toHaveLength(1);
    expect(screen.queryByDisplayValue("Existing unrelated chapter")).toBeNull();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Our new chapter" } });
    fireEvent.change(screen.getByLabelText("Authority"), { target: { value: "The members elected me president" } });
    expect(screen.getByRole("button", { name: "Check 1 items" })).toBeDisabled();
    expect(api.setOrganizationCatalogPlacement).not.toHaveBeenCalled();
    expect(api.importOrganizationStructure).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use this place" }));
    await screen.findByText(/Placement confirmed/);
    expect(api.setOrganizationCatalogPlacement).toHaveBeenCalledWith(org, { parentCatalogKey: key, identityUnlisted: false }, expect.any(String));
    expect(screen.getByText("Self-reported")).toBeInTheDocument();
    api.getOrganizationCatalogPlacement.mockResolvedValue({ parentCatalogKey: key, parentActive: true });
    fireEvent.click(screen.getByRole("button", { name: "Check 1 items" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create 1" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create 1" }));
    await waitFor(() => expect(api.importOrganizationStructure).toHaveBeenCalledTimes(2));
    const dry = api.importOrganizationStructure.mock.calls[0];
    const commit = api.importOrganizationStructure.mock.calls[1];
    expect(dry[2]).toBe(true); expect(commit[2]).toBe(false); expect(commit[1]).toEqual(dry[1]);
    expect(commit[1].chapters.map((row) => row.name)).toEqual(["Our new chapter"]);
    expect(JSON.stringify(commit[1])).not.toContain("Existing unrelated chapter");
  });

  it("refuses creation if another session changes the parent after the draft check", async () => {
    const { api } = setup({ parent: { parentCatalogKey: key, parentActive: true } });
    await screen.findByText(/Placement confirmed/);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Our new chapter" } });
    fireEvent.change(screen.getByLabelText("Authority"), { target: { value: "The members elected me president" } });
    fireEvent.click(screen.getByRole("button", { name: "Check 1 items" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create 1" })).toBeEnabled());
    api.getOrganizationCatalogPlacement.mockResolvedValue({ parentCatalogKey: "olms-900000002" });
    fireEvent.click(screen.getByRole("button", { name: "Create 1" }));
    await screen.findByRole("alert");
    expect(api.importOrganizationStructure).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Create 1" })).toBeDisabled();
    fireEvent.click(await screen.findByRole("button", { name: "Use this place" }));
    await screen.findByText(/Placement confirmed/);
    expect(screen.getByLabelText("Name")).toHaveValue("Our new chapter");
    expect(screen.getByRole("button", { name: "Check 1 items" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Create 1" })).toBeDisabled();
  });

  it("keeps an unlisted featured parent explicit and reuses one save key on retry", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue({ unlistedParentName: "Example Unlisted Local", verificationStatus: "self_reported" });
    const { catalog } = setup({ save, search: "union=test-unlisted-local&build=chapter" });
    fireEvent.click(await screen.findByRole("button", { name: "Use this place" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Use this place" }));
    await screen.findByText(/Placement confirmed/);
    expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
    expect(save.mock.calls[0][1]).toEqual({ unlistedParentName: "Example Unlisted Local", identityUnlisted: false });
    expect(catalog.rpc.mock.calls.some(([name]) => name === "get_union_catalog_profile")).toBe(false);
  });

  it("clears the first organization's chapter draft before rendering another organization", async () => {
    const { props, rerender } = setup();
    await screen.findByRole("button", { name: "Use this place" });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Private first draft" } });
    rerender(<LanguageProvider lang="en"><SetupReviewPage {...props} data={{ member: { id: "creator", organizationId: "b1b2c3d4-0000-4000-8000-000000000001" } }} /></LanguageProvider>);
    expect(screen.queryByDisplayValue("Private first draft")).toBeNull();
    expect(screen.getByLabelText("Name")).toHaveValue("");
  });
});

describe("shared union navigation", () => {
  it("uses the current workspace for staff handoffs without offering an admin switch", () => {
    window.history.replaceState({}, "", "/m/organize/partners");
    const navigate = vi.fn();
    render(<LanguageProvider lang="en"><WorkspacePages view="hub" location="/m/organize/partners" hat="steward" navigate={navigate}>
      <UnionNetworkNav current="handshakes" staff />
    </WorkspacePages></LanguageProvider>);
    const nav = within(screen.getByRole("navigation", { name: "Union network" }));
    expect(nav.queryByRole("link", { name: "Build your chapter" })).toBeNull();
    expect(nav.getByRole("link", { name: "Handshakes" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(nav.getByRole("link", { name: "Chapter connections" }));
    expect(navigate).toHaveBeenCalledWith("hub", "/m/organize/connections", null, { replace: false });
    fireEvent.click(nav.getByRole("link", { name: "Shared library" }), { ctrlKey: true });
    expect(navigate).toHaveBeenCalledTimes(1);
    // Union Ground has no public union catalog: the nav links only in-app.
    expect(nav.queryByRole("link", { name: "Find a union & resources" })).toBeNull();
    for (const link of nav.getAllByRole("link")) expect(link.getAttribute("href")).toMatch(/^\/m\//);
  });
});

describe("ranked connection enters the existing handshake workflow", () => {
  function connections({ canRequest = true, eligible = true, request, provenance = "verified" } = {}) {
    const fixture = createConnectionPreview();
    const actor = { userId: "actor", organizationId: "own", chapterId: fixture.workspace.chapterId, selectedHat: "admin" };
    const adapter = { workspace: vi.fn().mockResolvedValue({ ...fixture.workspace, organizationId: "own", canRequestHandshake: canRequest }),
      profiles: vi.fn().mockResolvedValue({ profiles: [{ ...fixture.profiles[0], handshake: { eligible, partnerOrgId: "olms-900000001" }, localKey: key, identityProvenance: { localKey: provenance } }] }),
      requestHandshake: request || vi.fn().mockResolvedValue({ id: "request" }) };
    render(<LanguageProvider lang="en"><ConnectionSuggestions actor={actor} adapter={adapter} /></LanguageProvider>);
    return { adapter, fixture };
  }
  it.each(["verified", "declared", null, "unrecognized"])("keeps matching signals without presenting a public union profile link: %s", async (provenance) => {
    connections({ provenance });
    const card = (await screen.findByRole("heading", { name: "Harbor Care Campaign" })).closest("article");
    expect(within(card).getByRole("button", { name: "Request a handshake" })).toBeInTheDocument();
    expect(within(card).queryByRole("link", { name: "Union profile & resources" })).toBeNull();
    expect(card.querySelector("a[href^='/unions'], a[href^='/orgs']")).toBeNull();
  });
  it("offers no public profile link, waits for explicit send and retries the exact request key", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ id: "request" });
    const { fixture } = connections({ request });
    const card = (await screen.findByRole("heading", { name: "Harbor Care Campaign" })).closest("article");
    expect(within(card).queryByRole("link", { name: "Union profile & resources" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Request a handshake" }));
    expect(request).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Share training" } });
    fireEvent.change(within(dialog).getByLabelText("Purpose"), { target: { value: "Review a joint training request" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
    await within(dialog).findByRole("alert");
    fireEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
    await screen.findByText("Handshake requested. Follow its progress in Handshakes.");
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
    expect(request.mock.calls[0]).toEqual([fixture.workspace.chapterId, fixture.profiles[0].id,
      { title: "Share training", purpose: "Review a joint training request", dataScope: "no_member_data" }, expect.any(String)]);
  });
  it("keeps the request visible through dismissal attempts while a send is pending", async () => {
    let finish;
    const request = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    connections({ request });
    fireEvent.click(await screen.findByRole("button", { name: "Request a handshake" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Training" } });
    fireEvent.change(within(dialog).getByLabelText("Purpose"), { target: { value: "Joint training" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveAttribute("aria-disabled", "true");
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Close" })); });
    expect(dialog.closest(".dialog-backdrop")).not.toHaveAttribute("aria-hidden", "true");
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ id: "request" }); });
    await screen.findByText("Handshake requested. Follow its progress in Handshakes.");
  });
  it.each(["declined", "closed"])("reports a %s replay without announcing a new request", async (status) => {
    const request = vi.fn().mockRejectedValueOnce(new Error("lost reply")).mockResolvedValue({ id: "request", status });
    connections({ request });
    fireEvent.click(await screen.findByRole("button", { name: "Request a handshake" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Training" } });
    fireEvent.change(within(dialog).getByLabelText("Purpose"), { target: { value: "Joint training" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
    await within(dialog).findByRole("alert");
    fireEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
    await screen.findByText(`Your earlier handshake request was ${status}. Review it in Handshakes.`);
    expect(screen.queryByText("Handshake requested. Follow its progress in Handshakes.")).toBeNull();
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
  });
  it.each([{ canRequest: false }, { eligible: false }])("withholds sending when source or target lacks authority: %j", async (options) => {
    const { adapter } = connections(options);
    await screen.findByRole("heading", { name: "Harbor Care Campaign" });
    expect(screen.queryByRole("button", { name: "Request a handshake" })).toBeNull();
    expect(adapter.requestHandshake).not.toHaveBeenCalled();
  });
  it("does not confirm an RPC response for a different receiving chapter", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "h", status: "requested", chapter_id: "source", receiving_chapter_id: "wrong" }, error: null });
    await expect(createConnectionAdapter({ rpc }, "steward").requestHandshake("source", "chosen", { title: "Help", purpose: "Training", dataScope: "docs_only" }, "key")).rejects.toThrow("invalid_handshake_response");
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_selected_hat: "steward", p_chapter_id: "source", p_target_chapter_id: "chosen" });
  });
  it("only carries the reviewed handshake projection through ranking normalization", () => {
    const fixture = createConnectionPreview().profiles[0];
    const row = normalizePublishedProfile({ ...fixture, handshake: { eligible: true, partnerOrgId: key, privateContact: "must disappear" } });
    expect(row.handshake).toEqual({ eligible: true, partnerOrgId: key });
    expect(JSON.stringify(row)).not.toContain("privateContact");
    expect(normalizePublishedProfile({ ...fixture, handshake: { eligible: "true", partnerOrgId: key } }).handshake.eligible).toBe(false);
  });
});
