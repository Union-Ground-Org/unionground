import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectionSuggestions } from "../src/features/connectionSuggestions/ConnectionSuggestions.jsx";
import { createConnectionAdapter, matchingProfile } from "../src/features/connectionSuggestions/adapter.js";
import { createConnectionPreview } from "../src/features/connectionSuggestions/preview.js";
import { ReviewedIssueSignals } from "../src/features/connectionSuggestions/ReviewedIssueSignals.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { expectRefusedEveryWay } from "./helpers/blockedPress.js";
import { ConnectionHandshakeDialog } from "../src/features/connectionSuggestions/ConnectionHandshakeDialog.jsx";

const actor = { organizationId: "own-org", selectedHat: "admin" };
const order = () => screen.queryAllByRole("heading", { level: 4 }).map((node) => node.textContent);
const sourceId = "10000000-0000-0000-0000-000000000001";
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe("chapter connection controls", () => {
  it.each([
    ["en", "Edit profile", "Publish profile", "Country code", "State / region code", /I am authorized/,
      "Check the authorization box to publish this profile.", "Enter a two-letter country code.", "Enter a two- or three-letter region code.", "Enter a region code for the city or metro area."],
    ["es", "Editar perfil", "Publicar perfil", "Código de país", "Código de estado / región", /Tengo autorización/,
      "Marca la casilla de autorización para publicar este perfil.", "Escribe un código de país de dos letras.", "Escribe un código de región de dos o tres letras.", "Escribe un código de región para la ciudad o el área metropolitana."],
  ])("explains why profile publishing is blocked in %s", async (lang, edit, publish, countryLabel, regionLabel, authorization, noConsent, badCountry, badRegion, noMetroRegion) => {
    const fixtures = createConnectionPreview();
    const workspace = { ...fixtures.workspace, organizationId: actor.organizationId };
    const adapter = { workspace: vi.fn().mockResolvedValue(workspace), profiles: vi.fn().mockResolvedValue([]), save: vi.fn().mockResolvedValue({}) };
    const wrote = () => adapter.save.mock.calls.length > 0;
    render(<ConnectionSuggestions actor={actor} adapter={adapter} lang={lang} />);
    fireEvent.click(await screen.findByRole("button", { name: edit }));
    const button = screen.getByRole("button", { name: publish });
    const country = screen.getByLabelText(countryLabel);
    const region = screen.getByLabelText(regionLabel);
    const consent = screen.getByRole("checkbox", { name: authorization });
    expect(button).toHaveAccessibleDescription(noConsent);
    expect(button.nextElementSibling).toBeVisible();
    expectRefusedEveryWay(button, noConsent, wrote);
    const previousAlert = within(button.form).getByRole("alert");
    fireEvent.submit(button.form);
    const submitAlert = within(button.form).getByRole("alert");
    expect(submitAlert).not.toBe(previousAlert);
    expect(submitAlert).toHaveTextContent(noConsent);
    expect(adapter.save).not.toHaveBeenCalled();

    fireEvent.click(consent);
    fireEvent.change(country, { target: { value: "U1" } });
    expect(consent).not.toBeChecked();
    expect(country).toHaveAttribute("aria-invalid", "true");
    expectRefusedEveryWay(button, badCountry, wrote);
    fireEvent.change(country, { target: { value: "US" } });
    fireEvent.change(region, { target: { value: "" } });
    expectRefusedEveryWay(button, noMetroRegion, wrote);
    fireEvent.change(region, { target: { value: "R1" } });
    expect(region).toHaveAttribute("aria-invalid", "true");
    expectRefusedEveryWay(button, badRegion, wrote);
    fireEvent.change(region, { target: { value: "RI" } });
    expect(button).toHaveAccessibleDescription(noConsent);
    fireEvent.click(consent);
    fireEvent.click(button);
    await waitFor(() => expect(adapter.save).toHaveBeenCalledExactlyOnceWith(workspace.chapterId,
      expect.objectContaining({ location: { ...workspace.profile.location, country: "US", state: "RI" } }), true));
  });
  it("renders only canonical reviewed themes from the workspace response", async () => {
    const fixtures = createConnectionPreview();
    const workspace = { ...fixtures.workspace, organizationId: actor.organizationId,
      analysis: { latest: { topics: [{ key: "staffing" }, { key: "private source phrase" }, { key: "staffing" }] } } };
    const adapter = { workspace: vi.fn().mockResolvedValue(workspace), profiles: vi.fn().mockResolvedValue({ profiles: fixtures.profiles }) };
    render(<ConnectionSuggestions actor={actor} adapter={adapter} />);
    expect(await screen.findByText("Latest protected themes: Staffing")).toBeInTheDocument();
    expect(screen.queryByText(/private source phrase/)).not.toBeInTheDocument();
  });

  it("requires a region for metro matching and renewed consent after edits", async () => {
    render(<ConnectionSuggestions preview actor={actor} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit profile" }));
    const state = screen.getByRole("textbox", { name: "State / region code" });
    const consent = screen.getByRole("checkbox", { name: /I am authorized/ });
    fireEvent.click(consent);
    fireEvent.change(state, { target: { value: "" } });
    expect(consent).not.toBeChecked();
    fireEvent.click(consent);
    expect(screen.getByRole("button", { name: "Publish profile" })).toHaveAttribute("aria-disabled", "true");
    expect(state).toHaveAccessibleDescription(/city \/ metro also needs a region/);
    fireEvent.change(state, { target: { value: "ma " } });
    expect(state).toHaveValue("MA");
    expect(consent).not.toBeChecked();
    fireEvent.click(consent);
    expect(screen.getByRole("button", { name: "Publish profile" })).toBeEnabled();
  });

  it("reveals further ranked suggestions and resets the visible page when preferences change", async () => {
    const fixtures = createConnectionPreview();
    const profiles = Array.from({ length: 15 }, (_, index) => ({ ...fixtures.profiles[0], id: `candidate-${String(index).padStart(2, "0")}`, displayName: `Candidate ${index}` }));
    const adapter = { workspace: vi.fn().mockResolvedValue({ ...fixtures.workspace, organizationId: actor.organizationId }), profiles: vi.fn().mockResolvedValue({ profiles }) };
    render(<ConnectionSuggestions actor={actor} adapter={adapter} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show more suggestions" }));
    expect(order()).toHaveLength(15);
    expect(screen.queryByRole("button", { name: "Show more suggestions" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Balanced" }));
    expect(order()).toHaveLength(12);
    expect(screen.getByRole("button", { name: "Show more suggestions" })).toBeInTheDocument();
  });
  it("changes rank with independent dials and gives an honest all-zero state", async () => {
    render(<ConnectionSuggestions preview actor={actor} />);
    await screen.findByRole("heading", { name: "Harbor Care Campaign" });
    fireEvent.click(screen.getByRole("button", { name: "Find experienced help" }));
    expect(order()[0]).toBe("Great Lakes Care Campaign");
    for (const name of ["Location", "Sectors", "Shared issues", "Committee expertise", "Same local", "Same union"]) {
      fireEvent.change(screen.getByRole("slider", { name, exact: true }), { target: { value: "0" } });
    }
    expect(order()).toEqual([]);
    expect(screen.getByText("Turn up at least one dial to see suggestions.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Balanced" }));
    expect(order().length).toBeGreaterThan(0);
  });

  it("filters geographic reach, reveals contributions, and does not create a contact", async () => {
    const adapter = { save: vi.fn() };
    render(<ConnectionSuggestions preview actor={actor} adapter={adapter} />);
    await screen.findByRole("heading", { name: "Great Lakes Care Campaign" });
    fireEvent.change(screen.getByLabelText("Search area"), { target: { value: "same-state" } });
    expect(screen.queryByRole("heading", { name: "Great Lakes Care Campaign" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Profile age"), { target: { value: "30" } });
    const card = screen.getByRole("heading", { name: "Harbor Care Campaign" }).closest("article");
    fireEvent.click(within(card).getByText("Why this campaign"));
    expect(card.querySelector("details").open).toBe(true);
    expect(within(card).getByText("Shared issues")).toBeInTheDocument();
    expect(adapter.save).not.toHaveBeenCalled();
  });

  it("requires publishing consent and supports withdrawal in explicit preview", async () => {
    render(<ConnectionSuggestions preview actor={actor} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit profile" }));
    expect(screen.getByRole("button", { name: "Publish profile" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("checkbox", { name: /I am authorized/ }));
    fireEvent.click(screen.getByRole("button", { name: "Publish profile" }));
    await screen.findByText("Profile published.");
    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Withdraw profile" }));
    await screen.findByText("Profile withdrawn.");
    expect(order()).toEqual([]);
    expect(screen.getByText(/Set up your campaign’s matching profile/)).toBeInTheDocument();
  });

  it("never substitutes fictional data for empty or failed production reads", async () => {
    const adapter = { workspace: vi.fn().mockResolvedValue({ organizationId: actor.organizationId, chapterId: null, profile: null, canPublish: false }), profiles: vi.fn().mockResolvedValue({ profiles: [] }) };
    const { rerender } = render(<ConnectionSuggestions actor={actor} adapter={adapter} />);
    await screen.findByText(/Select a campaign before/);
    expect(screen.queryByText(/Fictional preview/)).not.toBeInTheDocument();
    const failure = { ...adapter, workspace: vi.fn().mockRejectedValue({ code: "PGRST202" }) };
    rerender(<ConnectionSuggestions actor={actor} adapter={failure} />);
    await screen.findByText("Connection matching is not available on this environment yet.");
    expect(order()).toEqual([]);
  });

  it("discards an earlier tenant's delayed response", async () => {
    let resolveFirst;
    const fixtures = createConnectionPreview();
    const first = { workspace: vi.fn(() => new Promise((resolve) => { resolveFirst = resolve; })), profiles: vi.fn().mockResolvedValue({ profiles: fixtures.profiles }) };
    const second = { workspace: vi.fn().mockResolvedValue({ organizationId: "other-org", chapterId: null, profile: null, canPublish: false }), profiles: vi.fn().mockResolvedValue({ profiles: [] }) };
    const { rerender } = render(<ConnectionSuggestions actor={actor} adapter={first} />);
    await waitFor(() => expect(first.workspace).toHaveBeenCalled());
    rerender(<ConnectionSuggestions actor={{ ...actor, organizationId: "other-org" }} adapter={second} />);
    await screen.findByText(/Select a campaign before/);
    resolveFirst({ ...fixtures.workspace, organizationId: actor.organizationId });
    await waitFor(() => expect(first.profiles).not.toHaveBeenCalled());
    expect(order()).toEqual([]);
  });

  it("shows retry on an incomplete candidate traversal, with no partial list", async () => {
    const fixtures = createConnectionPreview();
    const adapter = { workspace: vi.fn().mockResolvedValue({ ...fixtures.workspace, organizationId: actor.organizationId }), profiles: vi.fn().mockRejectedValue(new Error("snapshot changed")) };
    render(<ConnectionSuggestions actor={actor} adapter={adapter} />);
    await screen.findByText(/No partial ranking is shown/);
    expect(order()).toEqual([]);
    adapter.profiles.mockResolvedValue({ profiles: fixtures.profiles });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Harbor Care Campaign" });
  });

  it("renders Spanish controls and explanations", async () => {
    render(<ConnectionSuggestions preview actor={actor} lang="es" />);
    await screen.findByRole("heading", { name: "Conexiones sugeridas" });
    expect(screen.getByRole("slider", { name: "Temas compartidos" })).toBeInTheDocument();
    expect(screen.getAllByText("Por qué esta campaña").length).toBeGreaterThan(0);
  });

  it("analyzes locally, requires human confirmation, and sends only reviewed source references", async () => {
    const fixtures = createConnectionPreview();
    const adapter = { workspace: vi.fn().mockResolvedValue({ ...fixtures.workspace, organizationId: actor.organizationId }), profiles: vi.fn().mockResolvedValue({ profiles: [] }), reviewSource: vi.fn().mockResolvedValue({}) };
    render(<ConnectionSuggestions actor={actor} adapter={adapter} />);
    fireEvent.click(await screen.findByText("Review workplace issue, survey and feedback themes"));
    const sourceId = "10000000-0000-0000-0000-000000000001";
    fireEvent.change(screen.getByLabelText("Source record ID"), { target: { value: sourceId } });
    fireEvent.change(screen.getByLabelText("Text to analyze (optional)"), { target: { value: "Private source text about staffing and overtime" } });
    fireEvent.click(screen.getByRole("button", { name: "Suggest issue tags" }));
    const tags = screen.getByRole("group", { name: "Confirmed issue topics" });
    expect(within(tags).getByRole("checkbox", { name: "Staffing" })).toBeChecked();
    expect(within(tags).getByRole("checkbox", { name: "Pay", exact: true })).toBeChecked();
    expect(screen.getByRole("button", { name: "Save reviewed tags" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this source/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save reviewed tags" }));
    await screen.findByText("Reviewed tags saved. Source text was cleared.");
    expect(adapter.reviewSource).toHaveBeenCalledWith(fixtures.workspace.chapterId, "grievance", sourceId, ["staffing", "pay"]);
    expect(JSON.stringify(adapter.reviewSource.mock.calls)).not.toContain("Private source text");
    expect(screen.getByLabelText("Text to analyze (optional)")).toHaveValue("");
  });

  it("resets source confirmation when tags or source identity change and separates aggregate consent", async () => {
    render(<ConnectionSuggestions preview actor={actor} />);
    fireEvent.click(await screen.findByText("Review workplace issue, survey and feedback themes"));
    fireEvent.change(screen.getByLabelText("Source record ID"), { target: { value: "10000000-0000-0000-0000-000000000001" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this source/ }));
    fireEvent.change(screen.getByLabelText("Source type"), { target: { value: "survey" } });
    expect(screen.getByRole("button", { name: "Save reviewed tags" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Freeze completed-quarter themes" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Review of the completed quarter/ }));
    fireEvent.click(screen.getByRole("button", { name: "Freeze completed-quarter themes" }));
    await screen.findByText("Preview only: no source records were analyzed or published.");
  });

  it("resets consent and draft when switching chapters within one organization", async () => {
    const fixtures = createConnectionPreview();
    let chapterId = "chapter-a";
    const adapter = { workspace: vi.fn(async () => ({ ...fixtures.workspace, organizationId: actor.organizationId, chapterId, profile: { ...fixtures.workspace.profile, id: chapterId } })), profiles: vi.fn().mockResolvedValue({ profiles: [] }), save: vi.fn().mockResolvedValue({}) };
    const { rerender } = render(<ConnectionSuggestions actor={{ ...actor, chapterId }} adapter={adapter} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit profile" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /I am authorized/ }));
    chapterId = "chapter-b";
    rerender(<ConnectionSuggestions actor={{ ...actor, chapterId }} adapter={adapter} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit profile" }));
    const publish = screen.getByRole("button", { name: "Publish profile" });
    expect(publish).toHaveAttribute("aria-disabled", "true");
    expect(publish).toHaveAccessibleDescription("Check the authorization box to publish this profile.");
    fireEvent.click(screen.getByRole("checkbox", { name: /I am authorized/ }));
    fireEvent.click(screen.getByRole("button", { name: "Publish profile" }));
    await waitFor(() => expect(adapter.save).toHaveBeenCalledWith("chapter-b", expect.any(Object), true));
  });

  it("does not convert analyzed themes into declared priorities", async () => {
    const fixtures = createConnectionPreview();
    const profile = { ...fixtures.workspace.profile, declaredIssueKeys: undefined, issuePriorities: [{ key: "staffing", strength: 0.5 }] };
    const adapter = { workspace: vi.fn().mockResolvedValue({ ...fixtures.workspace, organizationId: actor.organizationId, profile }), profiles: vi.fn().mockResolvedValue({ profiles: [] }), save: vi.fn().mockResolvedValue({}) };
    render(<ConnectionSuggestions actor={actor} adapter={adapter} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit profile" }));
    expect(within(screen.getByRole("group", { name: "Declared campaign priorities" })).getByRole("checkbox", { name: "Staffing" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: /I am authorized/ }));
    fireEvent.click(screen.getByRole("button", { name: "Publish profile" }));
    await waitFor(() => expect(adapter.save).toHaveBeenCalledWith(fixtures.workspace.chapterId, expect.objectContaining({ declaredIssueKeys: [] }), true));
  });

  it("publishes explicitly selected capabilities and limits sectors without promoting catalog affiliations", async () => {
    const fixtures = createConnectionPreview();
    const workspace = { ...fixtures.workspace, organizationId: actor.organizationId, draft: {
      location: { country: "US", state: "MA", metro: "Boston" }, sectorKeys: [], declaredIssueKeys: [],
      expertiseOffered: [], declaredLocalKey: "declared-local", declaredUnionFamilyKey: "declared-union",
    } };
    const adapter = { workspace: vi.fn().mockResolvedValue(workspace), profiles: vi.fn().mockResolvedValue([]), save: vi.fn().mockResolvedValue({}) };
    render(<ConnectionSuggestions actor={actor} adapter={adapter} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit profile" }));
    fireEvent.change(screen.getByLabelText("Organizational unit"), { target: { value: "local" } });
    fireEvent.change(screen.getByLabelText("Country code"), { target: { value: "ca" } });
    fireEvent.change(screen.getByLabelText("State / region code"), { target: { value: "on" } });
    fireEvent.change(screen.getByLabelText("City / metro name"), { target: { value: "Ottawa" } });
    const sectors = within(screen.getByRole("group", { name: "Sectors" }));
    for (const name of ["Healthcare", "Education", "Public services", "Transportation", "Logistics"]) fireEvent.click(sectors.getByRole("checkbox", { name }));
    expect(sectors.getByRole("checkbox", { name: "Manufacturing" })).toBeDisabled();
    fireEvent.click(sectors.getByRole("checkbox", { name: "Logistics" }));
    expect(sectors.getByRole("checkbox", { name: "Manufacturing" })).toBeEnabled();
    fireEvent.click(sectors.getByRole("checkbox", { name: "Manufacturing" }));
    const priorities = within(screen.getByRole("group", { name: "Declared campaign priorities" }));
    fireEvent.click(priorities.getByRole("checkbox", { name: "Pay", exact: true }));
    fireEvent.click(priorities.getByRole("checkbox", { name: "Safety" }));
    fireEvent.click(priorities.getByRole("checkbox", { name: "Pay", exact: true }));
    fireEvent.click(within(screen.getByRole("group", { name: "Help your campaign offers" })).getByRole("checkbox", { name: "Training" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Also share reviewed/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /I am authorized/ }));
    fireEvent.click(screen.getByRole("button", { name: "Publish profile" }));
    await screen.findByText("Profile published.");
    expect(adapter.save).toHaveBeenCalledWith(workspace.chapterId, {
      kind: "local", location: { country: "CA", state: "ON", metro: "Ottawa" },
      sectorKeys: ["healthcare", "education", "public-services", "transportation", "manufacturing"],
      declaredIssueKeys: ["safety"], expertiseOffered: ["training"], shareAnalyzedIssues: true,
      declaredLocalKey: "declared-local", declaredUnionFamilyKey: "declared-union",
    }, true);
  });

  it("keeps a failed publication editable, prevents duplicate writes, and withdraws through the live adapter", async () => {
    const fixtures = createConnectionPreview();
    const write = deferred();
    const workspace = { ...fixtures.workspace, organizationId: actor.organizationId };
    const adapter = { workspace: vi.fn().mockResolvedValue(workspace), profiles: vi.fn().mockResolvedValue([]), save: vi.fn().mockReturnValueOnce(write.promise).mockResolvedValue({}) };
    render(<ConnectionSuggestions actor={actor} adapter={adapter} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit profile" }));
    fireEvent.change(screen.getByLabelText("City / metro name"), { target: { value: "Cambridge" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /I am authorized/ }));
    fireEvent.click(screen.getByRole("button", { name: "Publish profile" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Withdraw profile" })).toHaveAttribute("aria-disabled", "true");
    // Pending, not natively disabled (record 8435): a second publish or a withdraw is refused.
    fireEvent.click(screen.getByRole("button", { name: "Saving…" }));
    fireEvent.click(screen.getByRole("button", { name: "Withdraw profile" }));
    await act(async () => write.reject(new Error("denied")));
    expect(await screen.findByText(/Your changes remain in the form/)).toBeInTheDocument();
    expect(screen.getByLabelText("City / metro name")).toHaveValue("Cambridge");
    expect(adapter.save).toHaveBeenCalledTimes(1);
    adapter.workspace.mockResolvedValue({ ...workspace, profile: null });
    fireEvent.click(screen.getByRole("button", { name: "Withdraw profile" }));
    await screen.findByText("Profile withdrawn.");
    expect(adapter.save).toHaveBeenLastCalledWith(workspace.chapterId, {}, false);
    expect(await screen.findByRole("button", { name: "Set up profile" })).toBeInTheDocument();
  });

  it("offers an empty draft and permits closing it without publishing", async () => {
    const workspace = { organizationId: actor.organizationId, chapterId: "new-chapter", profile: null, canPublish: true, chapters: [{ id: "new-chapter", name: "Selected test chapter" }] };
    const adapter = { workspace: vi.fn().mockResolvedValue(workspace), profiles: vi.fn().mockResolvedValue({ rows: [] }), save: vi.fn() };
    render(<ConnectionSuggestions actor={actor} adapter={adapter} />);
    fireEvent.click(await screen.findByRole("button", { name: "Set up profile" }));
    expect(screen.getByLabelText("Country code")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Withdraw profile" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /I am authorized/ }));
    const publish = screen.getByRole("button", { name: "Publish profile" });
    expect(publish).toHaveAttribute("aria-disabled", "true");
    expect(publish).toHaveAccessibleDescription("Enter a two-letter country code.");
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    expect(screen.queryByLabelText("Country code")).not.toBeInTheDocument();
    expect(adapter.save).not.toHaveBeenCalled();
  });

  it("keeps permission failures distinct from missing chapter information", async () => {
    const adapter = { workspace: vi.fn().mockRejectedValue({ code: "42501" }), profiles: vi.fn() };
    render(<ConnectionSuggestions actor={actor} adapter={adapter} />);
    await screen.findByText("Select an active staff role to view campaign suggestions.");
    expect(adapter.profiles).not.toHaveBeenCalled();
    adapter.workspace.mockResolvedValue({ organizationId: actor.organizationId, chapterId: "selected", profile: null, canPublish: false });
    adapter.profiles.mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("An organization administrator can publish this campaign’s profile.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up profile" })).not.toBeInTheDocument();
    expect(screen.queryByText("Review workplace issue, survey and feedback themes")).not.toBeInTheDocument();
  });

  it("changes geographic scale, freshness and variety without writing preferences", async () => {
    const fixtures = createConnectionPreview();
    const old = { ...fixtures.profiles[0], id: "old-profile", displayName: "Older chapter", publishedAt: "2020-01-01" };
    const adapter = { workspace: vi.fn().mockResolvedValue({ ...fixtures.workspace, organizationId: actor.organizationId }), profiles: vi.fn().mockResolvedValue([...fixtures.profiles, old]), save: vi.fn() };
    render(<ConnectionSuggestions actor={actor} adapter={adapter} />);
    await screen.findByRole("heading", { name: "Older chapter" });
    fireEvent.click(screen.getByRole("button", { name: "Nearby collaboration" }));
    expect(screen.getByRole("slider", { name: "Location", exact: true })).toHaveValue("50");
    fireEvent.change(screen.getByLabelText("Location preference"), { target: { value: "country" } });
    expect(screen.getByLabelText("Location preference")).toHaveValue("country");
    fireEvent.change(screen.getByLabelText("Result variety"), { target: { value: "100" } });
    expect(screen.getAllByText(/Order adjusted for variety/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Profile age"), { target: { value: "90" } });
    expect(screen.queryByRole("heading", { name: "Older chapter" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Profile age"), { target: { value: "" } });
    expect(screen.getByRole("heading", { name: "Older chapter" })).toBeInTheDocument();
    expect(adapter.save).not.toHaveBeenCalled();
    expect(adapter.profiles).toHaveBeenCalledTimes(1);
  });
});

describe("reviewed source and completed-quarter controls", () => {
  const mountReview = (overrides = {}) => {
    const props = { workspace: { chapterId: "chapter-a" }, adapter: { reviewSource: vi.fn().mockResolvedValue({}), freezeIssues: vi.fn().mockResolvedValue({}) }, onRefresh: vi.fn(), ...overrides };
    const view = render(<ReviewedIssueSignals {...props} />);
    fireEvent.click(screen.getByText("Review workplace issue, survey and feedback themes"));
    return { ...view, ...props };
  };
  const setSource = () => fireEvent.change(screen.getByLabelText("Source record ID"), { target: { value: sourceId } });
  const consentReview = () => fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this source/ }));
  const consentFreeze = () => fireEvent.click(screen.getByRole("checkbox", { name: /Review of the completed quarter/ }));

  // The review controls stay focusable while their write runs.
  it("keeps Save reviewed tags focused while the review is saved, and saves it once", async () => {
    const adapter = { reviewSource: vi.fn(async () => ({})), freezeIssues: vi.fn() };
    mountReview({ adapter });
    setSource();
    fireEvent.click(within(screen.getByRole("group", { name: "Confirmed issue topics" })).getByRole("checkbox", { name: "Staffing" }));
    consentReview();
    await expectHeldWriteFocus(adapter.reviewSource, screen.getByRole("button", { name: "Save reviewed tags" }));
    expect(adapter.reviewSource).toHaveBeenCalledTimes(1);
  });

  // The signals:<chapter> lock refuses a second review or a freeze
  // started in the same tick, before the busy state can commit.
  it("starts one review or freeze write when both are activated in one tick", async () => {
    const adapter = { reviewSource: vi.fn(async () => ({})), freezeIssues: vi.fn(async () => ({ frozen: true })) };
    mountReview({ adapter, workspace: { chapterId: "chapter-a", analysis: { nextPeriodKey: "2026-Q2", latest: { topics: [] } } } });
    setSource();
    fireEvent.click(within(screen.getByRole("group", { name: "Confirmed issue topics" })).getByRole("checkbox", { name: "Staffing" }));
    consentReview();
    consentFreeze();
    const review = screen.getByRole("button", { name: "Save reviewed tags" });
    const freeze = screen.getByRole("button", { name: "Freeze completed-quarter themes" });
    await expectOneWriteFromOneTick([adapter.reviewSource, adapter.freezeIssues], [() => fireEvent.click(review), () => fireEvent.click(review), () => fireEvent.click(freeze)]);
    expect(adapter.reviewSource).toHaveBeenCalledExactlyOnceWith("chapter-a", expect.any(String), sourceId, ["staffing"]);
    expect(adapter.freezeIssues).not.toHaveBeenCalled();
  });

  it("saves a review and freezes in preview without calling the adapter", async () => {
    const adapter = { reviewSource: vi.fn(), freezeIssues: vi.fn() };
    const { onRefresh } = mountReview({ adapter, preview: true, workspace: { chapterId: "chapter-a", analysis: { nextPeriodKey: "2026-Q2", latest: { topics: [] } } } });
    setSource();
    fireEvent.click(within(screen.getByRole("group", { name: "Confirmed issue topics" })).getByRole("checkbox", { name: "Staffing" }));
    consentReview();
    fireEvent.click(screen.getByRole("button", { name: "Save reviewed tags" }));
    await act(async () => { await Promise.resolve(); });
    consentFreeze();
    fireEvent.click(screen.getByRole("button", { name: "Freeze completed-quarter themes" }));
    await act(async () => { await Promise.resolve(); });
    expect(adapter.reviewSource).not.toHaveBeenCalled();
    expect(adapter.freezeIssues).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("drops a review that fails after the panel unmounts", async () => {
    const pending = deferred();
    const adapter = { reviewSource: vi.fn(() => pending.promise), freezeIssues: vi.fn() };
    const view = mountReview({ adapter });
    setSource();
    fireEvent.click(within(screen.getByRole("group", { name: "Confirmed issue topics" })).getByRole("checkbox", { name: "Staffing" }));
    consentReview();
    fireEvent.click(screen.getByRole("button", { name: "Save reviewed tags" }));
    view.unmount();
    await act(async () => pending.reject(new Error("gone")));
    expect(adapter.reviewSource).toHaveBeenCalledTimes(1);
  });

  it("keeps Freeze focused while the quarter is frozen, and freezes it once", async () => {
    const adapter = { reviewSource: vi.fn(), freezeIssues: vi.fn(async () => ({ frozen: true })) };
    mountReview({ adapter, workspace: { chapterId: "chapter-a", analysis: { nextPeriodKey: "2026-Q2", latest: { topics: [] } } } });
    consentFreeze();
    await expectHeldWriteFocus(adapter.freezeIssues, screen.getByRole("button", { name: "Freeze completed-quarter themes" }));
    expect(adapter.freezeIssues).toHaveBeenCalledTimes(1);
  });

  it("lets reviewers remove tags explicitly and does not transmit or persist preview source text", async () => {
    const { adapter, onRefresh } = mountReview({ preview: true });
    expect(screen.getByRole("button", { name: "Suggest issue tags" })).toBeDisabled();
    setSource();
    fireEvent.change(screen.getByLabelText("Text to analyze (optional)"), { target: { value: "Fictional safety concern" } });
    fireEvent.click(screen.getByRole("button", { name: "Suggest issue tags" }));
    const safety = within(screen.getByRole("group", { name: "Confirmed issue topics" })).getByRole("checkbox", { name: "Safety" });
    expect(safety).toBeChecked();
    consentReview();
    fireEvent.click(safety);
    expect(screen.getByRole("button", { name: "Save reviewed tags" })).toBeDisabled();
    consentReview();
    fireEvent.click(screen.getByRole("button", { name: "Save reviewed tags" }));
    await screen.findByText("Preview review complete. Nothing was saved to a source record.");
    expect(screen.getByLabelText("Text to analyze (optional)")).toHaveValue("");
    expect(screen.getByLabelText("Source record ID")).toHaveValue("");
    expect(adapter.reviewSource).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("retains a failed live review for retry, locks concurrent controls, and permits an empty removal", async () => {
    const pending = deferred();
    const adapter = { reviewSource: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({}), freezeIssues: vi.fn() };
    mountReview({ adapter });
    setSource();
    fireEvent.change(screen.getByLabelText("Text to analyze (optional)"), { target: { value: "Synthetic reviewer note" } });
    const topic = within(screen.getByRole("group", { name: "Confirmed issue topics" })).getByRole("checkbox", { name: "Staffing" });
    fireEvent.click(topic);
    consentReview();
    fireEvent.click(screen.getByRole("button", { name: "Save reviewed tags" }));
    expect(screen.getByLabelText("Source type")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByLabelText("Text to analyze (optional)")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Save reviewed tags" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("checkbox", { name: /Review of the completed quarter/ })).toHaveAttribute("aria-disabled", "true");
    // A second save while pending is refused (record 8435).
    fireEvent.click(screen.getByRole("button", { name: "Save reviewed tags" }));
    expect(adapter.reviewSource).toHaveBeenCalledTimes(1);
    await act(async () => pending.reject(new Error("source not finalized")));
    await screen.findByText(/The review could not be saved/);
    expect(screen.getByLabelText("Text to analyze (optional)")).toHaveValue("Synthetic reviewer note");
    expect(screen.getByLabelText("Source record ID")).toHaveValue(sourceId);
    fireEvent.click(topic);
    expect(screen.getByRole("button", { name: "Save reviewed tags" })).toBeDisabled();
    consentReview();
    fireEvent.click(screen.getByRole("button", { name: "Save reviewed tags" }));
    await screen.findByText("Reviewed tags saved. Source text was cleared.");
    expect(adapter.reviewSource).toHaveBeenLastCalledWith("chapter-a", "grievance", sourceId, []);
    expect(adapter.freezeIssues).not.toHaveBeenCalled();
  });

  it("requires renewed confirmation after source text changes and rejects malformed record IDs", () => {
    mountReview();
    setSource();
    consentReview();
    fireEvent.change(screen.getByLabelText("Text to analyze (optional)"), { target: { value: "changed context" } });
    expect(screen.getByRole("checkbox", { name: /I reviewed this source/ })).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("Source record ID"), { target: { value: "malformed" } });
    expect(screen.getByLabelText("Source record ID")).toBeInvalid();
    expect(screen.getByLabelText("Text to analyze (optional)")).toHaveValue("changed context");
    expect(screen.getByRole("button", { name: "Save reviewed tags" })).toBeDisabled();
  });

  it("freezes only after explicit quarter consent, refreshes success, and cannot refreeze a completed quarter", async () => {
    const pending = deferred();
    const adapter = { reviewSource: vi.fn(), freezeIssues: vi.fn().mockReturnValue(pending.promise) };
    const workspace = { chapterId: "chapter-a", analysis: { nextPeriodKey: "2026-Q2", latest: { topics: [] } } };
    const { onRefresh, rerender } = mountReview({ adapter, workspace });
    expect(screen.getByRole("heading", { name: "Completed-quarter themes · 2026-Q2" })).toBeInTheDocument();
    expect(screen.getByText("Latest protected themes: No themes met the privacy threshold")).toBeInTheDocument();
    const freeze = screen.getByRole("button", { name: "Freeze completed-quarter themes" });
    expect(freeze).toBeDisabled();
    consentFreeze();
    fireEvent.click(freeze);
    expect(freeze).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByLabelText("Source record ID")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(freeze);
    await act(async () => pending.resolve({ frozen: true }));
    await screen.findByText("Completed-quarter themes frozen.");
    expect(adapter.freezeIssues).toHaveBeenCalledExactlyOnceWith("chapter-a");
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("checkbox", { name: /Review of the completed quarter/ })).not.toBeChecked();
    expect(freeze).toBeDisabled();
    rerender(<ReviewedIssueSignals workspace={{ ...workspace, analysis: { ...workspace.analysis, nextPeriodFrozen: true } }} adapter={adapter} onRefresh={onRefresh} />);
    expect(screen.getByText("This completed quarter is already frozen.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Freeze completed-quarter themes" })).not.toBeInTheDocument();
  });

  it("reports rejected freezing without refreshing or claiming publication", async () => {
    const adapter = { reviewSource: vi.fn(), freezeIssues: vi.fn().mockRejectedValue(new Error("not authorized")) };
    const { onRefresh } = mountReview({ adapter });
    consentFreeze();
    fireEvent.click(screen.getByRole("button", { name: "Freeze completed-quarter themes" }));
    await screen.findByText("Themes could not be frozen. No publication change was confirmed.");
    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.queryByText("Completed-quarter themes frozen.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Freeze completed-quarter themes" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Freeze completed-quarter themes" })).not.toHaveAttribute("aria-disabled");
  });

  it.each(["review", "freeze"])("does not act on an earlier chapter's delayed %s completion after unmount", async (operation) => {
    const pending = deferred();
    const adapter = { reviewSource: vi.fn().mockReturnValue(pending.promise), freezeIssues: vi.fn().mockReturnValue(pending.promise) };
    const { unmount, onRefresh } = mountReview({ adapter });
    if (operation === "review") { setSource(); consentReview(); }
    else consentFreeze();
    fireEvent.click(screen.getByRole("button", { name: operation === "review" ? "Save reviewed tags" : "Freeze completed-quarter themes" }));
    unmount();
    await act(async () => pending.resolve({}));
    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("connection RPC adapter", () => {
  it("withdraws without parsing an empty profile and never uploads raw source text", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {}, error: null });
    const adapter = createConnectionAdapter({ rpc }, "admin");
    await adapter.save("chapter-a", {}, false);
    expect(rpc).toHaveBeenLastCalledWith("withdraw_chapter_connection_profile", { p_selected_hat: "admin", p_chapter_id: "chapter-a" });
    await adapter.reviewSource("chapter-a", "survey", "source-id", ["pay"]);
    expect(rpc).toHaveBeenLastCalledWith("set_chapter_connection_source_tags", { p_selected_hat: "admin", p_chapter_id: "chapter-a", p_source_kind: "survey", p_source_id: "source-id", p_topic_keys: ["pay"] });
    expect(matchingProfile({ publication: { publishedAt: "2026-01-01", status: "published" }, sourceAsOf: "2026-09-27" }).publishedAt).toBe("2026-01-01");
  });
  it("preserves an explicit withdrawal even if publication metadata is stale", () => {
    expect(matchingProfile({ discoverable: false, publication: { status: "published" } }).discoverable).toBe(false);
  });
  it("derives caller scope server-side and traverses every page", async () => {
    const fixtures = createConnectionPreview();
    const sorted = fixtures.profiles.sort((a, b) => a.id < b.id ? -1 : 1);
    const rpc = vi.fn(async (_name, args) => ({ data: args.p_after_id == null ? { snapshotToken: "v1", rows: sorted.slice(0, 3), nextCursor: sorted[2].id, complete: false } : { snapshotToken: "v1", rows: sorted.slice(3), nextCursor: null, complete: true }, error: null }));
    const result = await createConnectionAdapter({ rpc }, "admin").profiles();
    expect(result.profiles).toHaveLength(6);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1][1]).toEqual({ p_selected_hat: "admin", p_after_id: sorted[2].id, p_snapshot_token: "v1", p_limit: 250 });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("organizationId");
  });
});

describe("connection profile publish keeps focus while it saves", () => {
  it("keeps Publish profile focused while the profile is saved, and saves it once", async () => {
    const fixtures = createConnectionPreview();
    const workspace = { ...fixtures.workspace, organizationId: actor.organizationId };
    const adapter = { workspace: vi.fn().mockResolvedValue(workspace), profiles: vi.fn().mockResolvedValue([]), save: vi.fn(async () => ({})) };
    render(<ConnectionSuggestions actor={actor} adapter={adapter} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit profile" }));
    fireEvent.change(screen.getByLabelText("City / metro name"), { target: { value: "Cambridge" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /I am authorized/ }));
    await expectHeldWriteFocus(adapter.save, screen.getByRole("button", { name: "Publish profile" }));
    expect(adapter.save).toHaveBeenCalledTimes(1);
  });
  // The profile:<chapter> lock refuses a second publish or a
  // withdraw started in the same tick, before the busy state can commit.
  it("starts one profile write when publish and withdraw are activated in one tick", async () => {
    const fixtures = createConnectionPreview();
    const workspace = { ...fixtures.workspace, organizationId: actor.organizationId };
    const adapter = { workspace: vi.fn().mockResolvedValue(workspace), profiles: vi.fn().mockResolvedValue([]), save: vi.fn(async () => ({})) };
    render(<ConnectionSuggestions actor={actor} adapter={adapter} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit profile" }));
    fireEvent.change(screen.getByLabelText("City / metro name"), { target: { value: "Cambridge" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /I am authorized/ }));
    const publish = screen.getByRole("button", { name: "Publish profile" });
    const withdraw = screen.getByRole("button", { name: "Withdraw profile" });
    await expectOneWriteFromOneTick(adapter.save, [() => fireEvent.click(publish), () => fireEvent.click(publish), () => fireEvent.click(withdraw)]);
    expect(adapter.save).toHaveBeenCalledExactlyOnceWith(workspace.chapterId, expect.any(Object), true);
  });
});

describe("connection writes that end after they are no longer shown", () => {
  it("drops a profile save that settles after the panel unmounts", async () => {
    const fixtures = createConnectionPreview();
    const workspace = { ...fixtures.workspace, organizationId: actor.organizationId };
    const pending = deferred();
    const adapter = { workspace: vi.fn().mockResolvedValue(workspace), profiles: vi.fn().mockResolvedValue([]), save: vi.fn(() => pending.promise) };
    const view = render(<ConnectionSuggestions actor={actor} adapter={adapter} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit profile" }));
    fireEvent.change(screen.getByLabelText("City / metro name"), { target: { value: "Cambridge" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /I am authorized/ }));
    fireEvent.click(screen.getByRole("button", { name: "Publish profile" }));
    view.unmount();
    await act(async () => pending.resolve({}));
    expect(adapter.save).toHaveBeenCalledTimes(1);
  });

  it("sends no handshake request for an incomplete form", () => {
    const adapter = { requestHandshake: vi.fn() };
    const { container } = render(<ConnectionHandshakeDialog target={{ id: "office-1", displayName: "Fictional office" }} chapterId="chapter-a" adapter={adapter} lang="en" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.submit(document.querySelector("form.xus-form") ?? container.querySelector("form"));
    expect(adapter.requestHandshake).not.toHaveBeenCalled();
  });
});

// Record #9469 (W5-6): correcting the record ID keeps the pasted text and the
// ticked tags, clears the confirmation and the last notice, and says the ID's form.
describe("reviewed source ID correction (#9469)", () => {
  it("keeps the text and tags when the ID is corrected, clears the old notice, and describes the ID", () => {
    render(<ReviewedIssueSignals workspace={{ chapterId: "chapter-a" }} adapter={{}} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByText("Review workplace issue, survey and feedback themes"));
    const id = screen.getByLabelText("Source record ID");
    fireEvent.change(id, { target: { value: sourceId.slice(0, -1) } });
    fireEvent.change(screen.getByLabelText("Text to analyze (optional)"), { target: { value: "Private text" } });
    fireEvent.click(screen.getByRole("button", { name: "Suggest issue tags" }));
    expect(screen.getByRole("status")).toBeInTheDocument();
    const staffing = within(screen.getByRole("group", { name: "Confirmed issue topics" })).getByRole("checkbox", { name: "Staffing" });
    fireEvent.click(staffing);
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this source/ }));
    fireEvent.change(id, { target: { value: sourceId } });
    expect(screen.getByLabelText("Text to analyze (optional)")).toHaveValue("Private text");
    expect(staffing).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /I reviewed this source/ })).not.toBeChecked();
    expect(screen.queryByRole("status")).toBeNull();
    expect(id).toHaveAccessibleDescription(/36-character record ID/u);
  });
});
