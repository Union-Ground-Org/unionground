// REQ-UG-UNION-CATALOG-SETUP-REVIEW-PREFILL-20260925: "Where does your
// organization belong?" The card probes the Phase 4a placement read once,
// shows "unavailable" (and never writes) until the DB half is applied, sends
// one idempotency key per action (reused on retry), mirrors the server's
// unlisted-name rules, and never shows "Verified": Union Ground's Phase 3a
// catalog-listing verification (organization claims) is left out of Union
// Ground, so the card never reads it and a placement is always self-reported.
// The client is a fake whose rpc() answers { data, error }. Fictional values.
import { existsSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlacementBadge } from "../src/features/unionCatalog/PlacementBadge.jsx";
import { PlacementCard, unlistedNameProblem } from "../src/features/unionCatalog/PlacementCard.jsx";
import {
  clearOrganizationCatalogPlacement,
  getOrganizationCatalogPlacement,
  setOrganizationCatalogPlacement,
} from "../src/features/orgSetup/setupApi.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const ORG = "a1b2c3d4-0000-4000-8000-000000000001";
const MISSING = { code: "42883", message: "function does not exist" };
const PARENT = {
  parentCatalogKey: "olms-900000009", parentName: "Sample Transit Council", parentActive: true,
  unlistedParentName: null, unlistedParentState: null, identityUnlisted: false, verificationStatus: "self_reported", updatedAt: "2026-09-25T20:00:00Z",
};

function fakeClient(respond) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push([name, args]);
      return (await respond(name, args, calls)) ?? { data: null, error: MISSING };
    },
  };
}

const catalog = fakeClient((name) => (name === "search_union_catalog" ? {
  data: { rows: [
    { key: "olms-900000009", name: "Sample Transit Council", city: "Springfield", state: "MA" },
    { key: "11111111-2222-4333-8444-555555555555", name: "Registry only", registryOnly: true },
  ] },
  error: null,
} : undefined));

function renderCard(respond, { lang = "en", catalogLive = true, onNotice = vi.fn(), catalogClient = catalog } = {}) {
  const client = fakeClient(respond);
  // A verification reader is still offered, as Union Ground's host passed
  // one, so the tests can prove the card never calls it.
  const getOrganizationCatalogVerification = vi.fn();
  const api = {
    getOrganizationCatalogVerification,
    getOrganizationCatalogPlacement: (id) => getOrganizationCatalogPlacement(client, id),
    setOrganizationCatalogPlacement: (id, fields, key) => setOrganizationCatalogPlacement(client, id, fields, key),
    clearOrganizationCatalogPlacement: (id, key) => clearOrganizationCatalogPlacement(client, id, key),
  };
  render(<LanguageProvider lang={lang}>
    <PlacementCard api={api} organizationId={ORG} catalogClient={catalogClient} catalogLive={catalogLive} onNotice={onNotice} />
  </LanguageProvider>);
  return { client, onNotice, getOrganizationCatalogVerification };
}

const VERIFICATION_RPC = "get_organization_catalog_verification";
const neverReadVerification = ({ client, getOrganizationCatalogVerification }) => {
  expect(getOrganizationCatalogVerification).not.toHaveBeenCalled();
  expect(client.calls.map(([name]) => name)).not.toContain(VERIFICATION_RPC);
};

const READS = new Set(["get_organization_catalog_placement", "get_organization_catalog_verification"]);
const writes = (client) => client.calls.filter(([name]) => !READS.has(name));

describe("placement card", () => {
  it.each([["42883", undefined], ["PGRST202", { data: null, error: { code: "PGRST202", message: "Could not find the function" } }]])(
    "shows unavailable and never writes while the RPC is missing (%s)", async (_code, response) => {
    const { client } = renderCard(() => response);
    expect(await screen.findByText("Placement isn't available yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(client.calls.filter(([name]) => name === "get_organization_catalog_placement")).toEqual([["get_organization_catalog_placement", { p_selected_hat: "admin", p_expected_organization_id: ORG }]]);
    expect(writes(client)).toEqual([]);
  });

  it("shows a load error, not a save error, for any other read failure", async () => {
    renderCard(() => ({ data: null, error: { code: "42501", message: "not authorized" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The placement couldn't be loaded. Reload the page to try again.");
  });

  it("sets a parent with a stable idempotency key across a retry", async () => {
    let attempts = 0;
    const { client, onNotice } = renderCard((name, args) => {
      if (name === "get_organization_catalog_placement") return { data: { placement: null }, error: null };
      if (name === "set_organization_catalog_placement") {
        attempts += 1;
        if (attempts === 1) return { data: null, error: { code: "500", message: "boom" } };
        return { data: { placement: { ...PARENT, identityUnlisted: args.p_identity_unlisted } }, error: null };
      }
      return undefined;
    });
    expect(await screen.findByText("Not placed yet.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search for a union, council or chapter"), { target: { value: "Sample" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("1 match")).toBeInTheDocument();
    expect(screen.queryByText(/Registry only/)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Sample Transit Council · Springfield, MA" }));
    fireEvent.click(screen.getByRole("button", { name: "Save placement" }));
    expect(await screen.findByText("The placement wasn't saved. Try again.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save placement" }));
    await screen.findByText("Sample Transit Council");
    const sets = writes(client);
    expect(sets).toHaveLength(2);
    expect(sets[0][1]).toEqual({
      p_selected_hat: "admin", p_expected_organization_id: ORG, p_parent_catalog_key: "olms-900000009",
      p_unlisted_parent_name: null, p_unlisted_parent_state: null, p_identity_unlisted: false, p_idempotency_key: sets[0][1].p_idempotency_key,
    });
    expect(sets[0][1].p_idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(sets[1][1].p_idempotency_key).toBe(sets[0][1].p_idempotency_key);
    expect(onNotice).toHaveBeenCalledWith("Placement saved.");
    expect(screen.getByText("Self-reported")).toBeInTheDocument();
    expect(screen.queryByText("Verified")).toBeNull();
  });

  it("maps the server's coded refusals to their own copy", async () => {
    let message = "placement target unavailable";
    renderCard((name) => {
      if (name === "get_organization_catalog_placement") return { data: { placement: null }, error: null };
      if (name === "set_organization_catalog_placement") return { data: null, error: { code: "22023", message } };
      return undefined;
    });
    await screen.findByText("Not placed yet.");
    fireEvent.change(screen.getByLabelText("Search for a union, council or chapter"), { target: { value: "Sample" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Sample Transit Council/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save placement" }));
    expect(await screen.findByText("That organization can't be selected right now.")).toBeInTheDocument();
    message = "placement change limit";
    fireEvent.click(screen.getByRole("button", { name: "Save placement" }));
    expect(await screen.findByText("You've changed this several times today. Try again tomorrow.")).toBeInTheDocument();
  });

  it("validates an unlisted parent like the server and saves it", async () => {
    const { client } = renderCard((name, args) => {
      if (name === "get_organization_catalog_placement") return { data: { placement: null }, error: null };
      if (name === "set_organization_catalog_placement") {
        return { data: { placement: { parentCatalogKey: null, unlistedParentName: args.p_unlisted_parent_name, unlistedParentState: args.p_unlisted_parent_state, identityUnlisted: args.p_identity_unlisted } }, error: null };
      }
      return undefined;
    }, { catalogLive: false });
    await screen.findByText("Not placed yet.");
    expect(screen.getByText("The union catalog isn't loaded on this site yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "It's not listed — add it" }));
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    for (const bad of ["ab", "write to someone@example.invalid", "see https://example.invalid", "call 5550100000"]) {
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: bad } });
      expect(save).toBeDisabled();
    }
    expect(screen.getByText(/at least one letter or number, and no email addresses, links or phone numbers/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Harbor Workers Council" } });
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "MA" } });
    fireEvent.click(save);
    expect(await screen.findByText(/Part of Harbor Workers Council \(not in the public catalog\)/)).toBeInTheDocument();
    expect(writes(client)[0][1]).toMatchObject({ p_parent_catalog_key: null, p_unlisted_parent_name: "Harbor Workers Council", p_unlisted_parent_state: "MA", p_identity_unlisted: false });
  });

  it("saves 'not in the catalog' alone, but not with a state and no name", async () => {
    const { client } = renderCard((name, args) => {
      if (name === "get_organization_catalog_placement") return { data: { placement: null }, error: null };
      if (name === "set_organization_catalog_placement") return { data: { placement: { identityUnlisted: args.p_identity_unlisted } }, error: null };
      return undefined;
    });
    await screen.findByText("Not placed yet.");
    fireEvent.click(screen.getByRole("button", { name: "It's not listed — add it" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "My organization isn't in the public catalog either" }));
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "MA" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Your organization isn't in the public catalog.")).toBeInTheDocument();
    expect(writes(client)[0][1]).toMatchObject({ p_unlisted_parent_name: null, p_unlisted_parent_state: null, p_identity_unlisted: true });
  });

  it("clears only after confirming", async () => {
    const { client, onNotice } = renderCard((name) => {
      if (name === "get_organization_catalog_placement") return { data: { placement: PARENT }, error: null };
      if (name === "clear_organization_catalog_placement") return { data: { placement: null }, error: null };
      return undefined;
    });
    await screen.findByText("Sample Transit Council");
    fireEvent.click(screen.getByRole("button", { name: "Remove this placement" }));
    let dialog = await screen.findByRole("dialog", { name: "Remove this placement?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes(client)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Remove this placement" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Not placed yet.")).toBeInTheDocument();
    expect(writes(client)[0][0]).toBe("clear_organization_catalog_placement");
    expect(writes(client)[0][1].p_idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(onNotice).toHaveBeenCalledWith("Placement removed.");
  });

  it("says when the parent is no longer listed", async () => {
    renderCard((name) => (name === "get_organization_catalog_placement" ? { data: { placement: { ...PARENT, parentActive: false } }, error: null } : undefined));
    expect(await screen.findByText("This organization is no longer listed in the public catalog. Choose another.")).toBeInTheDocument();
  });

  it("never renders Verified from a 4a response, even one that claims it, and never reads the left-out verification", async () => {
    const rendered = renderCard((name) => (name === "get_organization_catalog_placement"
      ? { data: { placement: { ...PARENT, verificationStatus: "verified" } }, error: null } : undefined), { lang: "es" });
    expect(await screen.findByText("Autodeclarado")).toBeInTheDocument();
    expect(screen.queryByText("Verificado")).toBeNull();
    expect(screen.queryByText(/^Verificado como/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Solicitar la verificación" })).toBeNull();
    expect(screen.getByText("Sample Transit Council")).toHaveAttribute("lang", "en");
    neverReadVerification(rendered);
  });

  it("never renders Verified even when a verification read would say verified, because it is never made", async () => {
    const rendered = renderCard((name) => {
      if (name === "get_organization_catalog_placement") return { data: { placement: PARENT }, error: null };
      if (name === VERIFICATION_RPC) {
        return { data: { verification: { status: "verified", identity: { kind: "catalog", catalogKey: "olms-900000001", name: "Example Workers Local 1" }, verifiedAt: "2026-09-20T15:00:00Z" }, openClaim: null }, error: null };
      }
      return undefined;
    });
    await screen.findByText("Sample Transit Council");
    expect(screen.queryByText(/^Verified as/)).toBeNull();
    expect(screen.queryAllByText("Verified", { selector: ".xus-chip" })).toHaveLength(0);
    // The parent line keeps 4a's own self-reported badge.
    expect(screen.getByText("Self-reported")).toBeInTheDocument();
    neverReadVerification(rendered);
  });

  it("offers no verification request, claim status or review link", async () => {
    const rendered = renderCard((name) => (name === "get_organization_catalog_placement" ? { data: { placement: PARENT }, error: null } : undefined));
    await screen.findByText("Sample Transit Council");
    for (const text of ["Request verification", "Verification requested", "In review"]) {
      expect(screen.queryByText(text)).toBeNull();
      expect(screen.queryByRole("link", { name: text })).toBeNull();
    }
    expect(screen.getByRole("button", { name: "Remove this placement" })).toBeInTheDocument();
    neverReadVerification(rendered);
  });

  it("offers Remove, the identity checkbox and every catalog listing as a parent, since it is never verified", async () => {
    const own = fakeClient((name) => (name === "search_union_catalog" ? {
      data: { rows: [
        { key: "olms-900000001", name: "Example Workers Local 1", city: "Springfield", state: "MA" },
        { key: "olms-900000009", name: "Sample Transit Council", city: "Springfield", state: "MA" },
      ] },
      error: null,
    } : undefined));
    const rendered = renderCard((name) => (name === "get_organization_catalog_placement" ? { data: { placement: PARENT }, error: null } : undefined), { catalogClient: own });
    await screen.findByText("Sample Transit Council");
    expect(screen.getByRole("button", { name: "Remove this placement" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "It's not listed — add it" }));
    expect(screen.getByRole("checkbox", { name: "My organization isn't in the public catalog either" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search for a union, council or chapter"), { target: { value: "Example" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("2 matches")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Sample Transit Council/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Example Workers Local 1/ })).toBeInTheDocument();
    neverReadVerification(rendered);
  });

  it("ships no verification line, claims API or verifier page", () => {
    for (const path of [
      "../src/features/unionCatalog/PlacementVerificationLine.jsx",
      "../src/features/unionCatalog/claimsApi.js",
      "../src/features/unionCatalog/verifierApi.js",
      "../src/features/unionCatalog/VerifierQueuePage.jsx",
      "../src/features/unionCatalog/OrganizationClaimPage.jsx",
    ]) {
      expect(existsSync(new URL(path, import.meta.url)), path).toBe(false);
    }
  });
});

describe("placement badge", () => {
  it("renders both states as text with the check icon hidden", () => {
    const { container } = render(<LanguageProvider lang="en">
      <PlacementBadge state="verified" /><PlacementBadge state="self_reported" /><PlacementBadge state="pending" />
    </LanguageProvider>);
    const chips = container.querySelectorAll(".xus-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveClass("xus-chip--on");
    expect(chips[0]).toHaveTextContent("Verified");
    expect(chips[0].querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(chips[1]).toHaveClass("xus-chip--note");
    expect(chips[1]).toHaveTextContent("Self-reported");
    expect(chips[1].querySelector("svg")).toBeNull();
  });

  it("mirrors the server's unlisted-name refusals", () => {
    expect(unlistedNameProblem("Harbor Workers Council")).toBe(false);
    expect(unlistedNameProblem("ab")).toBe(true);
    expect(unlistedNameProblem("x".repeat(201))).toBe(true);
    expect(unlistedNameProblem("a@b council")).toBe(true);
    expect(unlistedNameProblem("http://example.invalid")).toBe(true);
    expect(unlistedNameProblem("Local 1234567")).toBe(true);
    expect(unlistedNameProblem(null)).toBe(true);
  });

  it("refuses an unlisted name with no letter or digit, like the server", () => {
    for (const name of ["...", "\u200b\u200b\u200b", "---", "()/", `Tab\there`]) expect(unlistedNameProblem(name)).toBe(true);
    // A short local number and a name in a non-Latin script still pass.
    expect(unlistedNameProblem("Example Workers Local 1234")).toBe(false);
    expect(unlistedNameProblem("\u6771\u4eac\u5730\u65b9\u8a55\u8b70\u4f1a")).toBe(false);
    // Length is counted in characters, as the server counts it.
    expect(unlistedNameProblem("\u{1F3ED}".repeat(150))).toBe(true);
    expect(unlistedNameProblem(`Example Workers 1 ${"\u6771".repeat(150)}`)).toBe(false);
  });

  it("finds a phone number behind slashes, underscores, dashes and full-width digits, like the server", () => {
    for (const name of [
      "Call 555/010/0000", "Call 555_010_0000", "Call 555\u2013010\u20130000", "Call 555\u2212010\u2212000",
      "Call \uff15\uff15\uff15\uff10\uff11\uff10\uff10\uff10\uff10\uff10", "Call 555\uff0d010\uff0d0000",
    ]) expect(unlistedNameProblem(name)).toBe(true);
    expect(unlistedNameProblem("Example Workers Local 1234 District 5678")).toBe(false);
  });
});

// Review of PR #3410 (lane uc-4a-ui-review): one regression test per repaired finding.
describe("placement card review repairs", () => {
  const unplaced = (extra = () => undefined) => (name, args) => {
    if (name === "get_organization_catalog_placement") return { data: { placement: null }, error: null };
    return extra(name, args);
  };
  async function searchFor(text = "Sample") {
    fireEvent.change(screen.getByLabelText("Search for a union, council or chapter"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
  }

  it("never offers a registry-only row, even one whose id looks like a catalog key", async () => {
    const registry = fakeClient((name) => (name === "search_union_catalog" ? {
      data: { rows: [
        { key: "olms-900000009", name: "Example Workers 9", city: "Springfield", state: "MA" },
        { key: "olms-900000010", name: "Example Workers 10", registryOnly: true },
      ] },
      error: null,
    } : undefined));
    renderCard(unplaced(), { catalogClient: registry });
    await screen.findByText("Not placed yet.");
    await searchFor();
    expect(await screen.findByText("1 match")).toBeInTheDocument();
    expect(screen.queryByText(/Example Workers 10/)).toBeNull();
  });

  it("explains a server name refusal with the name rules", async () => {
    renderCard(unplaced((name) => (name === "set_organization_catalog_placement" ? { data: null, error: { code: "22023", message: "placement name invalid" } } : undefined)));
    await screen.findByText("Not placed yet.");
    fireEvent.click(screen.getByRole("button", { name: "It's not listed — add it" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Example Workers 3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/at least one letter or number/);
  });

  it("ties the unlisted-name error to its field", async () => {
    renderCard(unplaced());
    await screen.findByText("Not placed yet.");
    fireEvent.click(screen.getByRole("button", { name: "It's not listed — add it" }));
    const input = screen.getByLabelText("Name");
    fireEvent.change(input, { target: { value: "Call 555/010/0000" } });
    expect(input).toHaveAccessibleDescription(/at least one letter or number/);
  });

  it("moves focus to the card heading after a save closes the form", async () => {
    renderCard(unplaced((name, args) => (name === "set_organization_catalog_placement"
      ? { data: { placement: { parentCatalogKey: null, unlistedParentName: args.p_unlisted_parent_name, identityUnlisted: false } }, error: null } : undefined)));
    await screen.findByText("Not placed yet.");
    fireEvent.click(screen.getByRole("button", { name: "It's not listed — add it" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Example Workers 3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Example Workers 3/);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Where does your organization belong?" })));
  });

  it("gives the badge's meaning to assistive technology, not only a tooltip", () => {
    render(<LanguageProvider lang="en"><PlacementBadge state="self_reported" /></LanguageProvider>);
    expect(screen.getByText("Self-reported")).toHaveTextContent("Added by the organization's own admin. Not yet verified.");
  });

  it("keeps the identity-unlisted flag when a catalog parent is saved", async () => {
    const { client } = renderCard((name, args) => {
      if (name === "get_organization_catalog_placement") return { data: { placement: { parentCatalogKey: null, unlistedParentName: null, identityUnlisted: true, verificationStatus: "self_reported" } }, error: null };
      if (name === "set_organization_catalog_placement") return { data: { placement: { ...PARENT, identityUnlisted: args.p_identity_unlisted } }, error: null };
      return undefined;
    });
    await screen.findByText(/isn't in the public catalog|not in the public catalog/i);
    await searchFor();
    fireEvent.click(await screen.findByRole("radio", { name: /Sample Transit Council/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save placement" }));
    await waitFor(() => expect(writes(client)).toHaveLength(1));
    expect(writes(client)[0][1].p_identity_unlisted).toBe(true);
  });

  it("explains a refused write as the two-step requirement", async () => {
    renderCard(unplaced((name) => (name === "set_organization_catalog_placement" ? { data: null, error: { code: "42501", message: "mfa required" } } : undefined)));
    await screen.findByText("Not placed yet.");
    await searchFor();
    fireEvent.click(await screen.findByRole("radio", { name: /Sample Transit Council/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save placement" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/two-step sign-in/);
  });

  it("shows loading first, and an error when the catalog search fails", async () => {
    let answer;
    const failing = fakeClient((name) => (name === "search_union_catalog" ? { data: null, error: { code: "500", message: "boom" } } : undefined));
    renderCard((name) => (name === "get_organization_catalog_placement" ? new Promise((resolve) => { answer = resolve; }) : undefined), { catalogClient: failing });
    expect(screen.getByRole("status")).toHaveTextContent("Loading the public record…");
    expect(screen.queryByRole("button")).toBeNull();
    answer({ data: { placement: null }, error: null });
    await screen.findByText("Not placed yet.");
    await searchFor();
    expect(await screen.findByRole("alert")).toHaveTextContent("The placement wasn't saved. Try again.");
  });

  it("offers no Remove when nothing is placed", async () => {
    renderCard(unplaced());
    await screen.findByText("Not placed yet.");
    expect(screen.queryByRole("button", { name: "Remove this placement" })).toBeNull();
  });

  it("uses a fresh idempotency key for a new action after a success", async () => {
    const { client } = renderCard(unplaced((name, args) => (name === "set_organization_catalog_placement"
      ? { data: { placement: { ...PARENT, identityUnlisted: args.p_identity_unlisted } }, error: null } : undefined)));
    await screen.findByText("Not placed yet.");
    for (let round = 0; round < 2; round += 1) {
      await searchFor();
      fireEvent.click(await screen.findByRole("radio", { name: /Sample Transit Council/ }));
      fireEvent.click(screen.getByRole("button", { name: "Save placement" }));
      await waitFor(() => expect(writes(client)).toHaveLength(round + 1));
      await waitFor(() => expect(screen.getByRole("radio", { name: /Sample Transit Council/ })).not.toBeChecked());
    }
    const [first, second] = writes(client).map(([, args]) => args.p_idempotency_key);
    expect(second).not.toBe(first);
  });
});

// Union Ground's lane uc-3a-web repairs guarded a verified organization's
// parent changes. Union Ground never treats a placement as verified, so a
// 4a response that claims "verified" changes nothing the admin can do.
describe("placement card with a 4a response that claims verified", () => {
  const CLAIMS_VERIFIED_UNLISTED = { parentCatalogKey: null, unlistedParentName: null, identityUnlisted: true, verificationStatus: "verified" };
  const councils = fakeClient((name) => (name === "search_union_catalog" ? {
    data: { rows: [
      { key: "olms-900000009", name: "Sample Transit Council", city: "Springfield", state: "MA" },
      { key: "olms-900000011", name: "Example Workers Council 11", city: "Springfield", state: "MA" },
    ] },
    error: null,
  } : undefined));
  async function pick(name) {
    fireEvent.change(screen.getByLabelText("Search for a union, council or chapter"), { target: { value: "Example" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("radio", { name: new RegExp(name) }));
    fireEvent.click(screen.getByRole("button", { name: "Save placement" }));
  }

  it("saves an unlisted parent with the admin's own identity choice and no confirmation", async () => {
    const rendered = renderCard((name, args) => {
      if (name === "get_organization_catalog_placement") return { data: { placement: CLAIMS_VERIFIED_UNLISTED }, error: null };
      if (name === "set_organization_catalog_placement") {
        return { data: { placement: { parentCatalogKey: null, unlistedParentName: args.p_unlisted_parent_name, identityUnlisted: args.p_identity_unlisted, verificationStatus: "verified" } }, error: null };
      }
      return undefined;
    });
    await screen.findByText(/isn't in the public catalog|not in the public catalog/i);
    fireEvent.click(screen.getByRole("button", { name: "It's not listed — add it" }));
    const identity = screen.getByRole("checkbox", { name: "My organization isn't in the public catalog either" });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Example Workers Council 13" } });
    if (identity.checked) fireEvent.click(identity);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes(rendered.client)).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(writes(rendered.client)[0][1]).toMatchObject({ p_unlisted_parent_name: "Example Workers Council 13", p_identity_unlisted: false });
    neverReadVerification(rendered);
  });

  it("still explains a server 'placement verified' refusal and focuses it (A11Y-3)", async () => {
    renderCard((name) => {
      if (name === "get_organization_catalog_placement") return { data: { placement: CLAIMS_VERIFIED_UNLISTED }, error: null };
      if (name === "set_organization_catalog_placement") return { data: null, error: { code: "22023", message: "placement verified" } };
      return undefined;
    });
    await screen.findByText(/isn't in the public catalog|not in the public catalog/i);
    fireEvent.click(screen.getByRole("button", { name: "It's not listed — add it" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Example Workers Council 13" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your organization is verified, so this change can't be made here. Ask the platform verifier to make it.");
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });

  it("changes a catalog parent without the verified-organization confirmation", async () => {
    const rendered = renderCard((name, args) => {
      if (name === "get_organization_catalog_placement") return { data: { placement: { ...PARENT, verificationStatus: "verified" } }, error: null };
      if (name === "set_organization_catalog_placement") {
        return { data: { placement: { ...PARENT, parentCatalogKey: args.p_parent_catalog_key, parentName: "Example Workers Council 11" } }, error: null };
      }
      return undefined;
    }, { catalogClient: councils });
    await screen.findByText("Sample Transit Council");
    await pick("Example Workers Council 11");
    await waitFor(() => expect(writes(rendered.client)).toHaveLength(1));
    expect(screen.queryByRole("dialog", { name: "Change the parent of a verified organization?" })).toBeNull();
    expect(writes(rendered.client)[0][1]).toMatchObject({ p_parent_catalog_key: "olms-900000011", p_identity_unlisted: false });
    expect(rendered.onNotice).toHaveBeenCalledWith("Placement saved.");
    expect(screen.getByRole("button", { name: "Remove this placement" })).toBeInTheDocument();
    neverReadVerification(rendered);
  });

  it("removes the placement after the ordinary confirmation", async () => {
    const rendered = renderCard((name) => {
      if (name === "get_organization_catalog_placement") return { data: { placement: { ...PARENT, verificationStatus: "verified" } }, error: null };
      if (name === "clear_organization_catalog_placement") return { data: { placement: null }, error: null };
      return undefined;
    });
    await screen.findByText("Sample Transit Council");
    fireEvent.click(screen.getByRole("button", { name: "Remove this placement" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove this placement?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Not placed yet.")).toBeInTheDocument();
    expect(writes(rendered.client).map(([name]) => name)).toEqual(["clear_organization_catalog_placement"]);
    neverReadVerification(rendered);
  });
});
