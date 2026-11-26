import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import axe from "axe-core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateOrganizationGate } from "../src/features/openSignup/CreateOrganizationGate.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { createMyOrganization, newIdempotencyKey, normalizeOrganizationName, organizationNameProblem } from "../src/lib/openSignup.js";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

afterEach(() => vi.restoreAllMocks());

const CREATED = {
  data: { status: "created", organizationId: "20000000-0000-4000-8000-000000000001", chapterId: "c-0123456789", slug: "u-0123456789", idempotent: false },
  error: null,
};

function renderGate({ lang = "en", rpc = vi.fn().mockResolvedValue(CREATED), onCreated = vi.fn(), onSignOut = vi.fn() } = {}) {
  const client = { rpc };
  const view = render(
    <LanguageProvider lang={lang}>
      <CreateOrganizationGate client={client} onCreated={onCreated} onSignOut={onSignOut} />
    </LanguageProvider>,
  );
  return { ...view, rpc, onCreated, onSignOut };
}

function submitName(container, name = "Example Workers Local 1") {
  fireEvent.change(container.querySelector('input[name="organizationName"]'), { target: { value: name } });
  // The union catalog search above the name is its own form (#7670).
  fireEvent.submit(container.querySelector('form:not([role="search"])'));
}

describe("CreateOrganizationGate", () => {
  it("says the organization starts unverified and asks for its name beside the union search", () => {
    const { container } = renderGate();
    expect(screen.getByRole("heading", { name: "Create your organization" })).toBeInTheDocument();
    expect(screen.getByText(/starts unverified/)).toBeInTheDocument();
    expect([...container.querySelectorAll("input")].map((input) => input.name)).toEqual(["unionSearch", "organizationName"]);
    expect(container.querySelector('input[name="firstChapterName"]')).toBeNull();
    expect(screen.getByText("Expected to join an existing organization? Ask its administrator for an invitation.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create organization" })).toBeDisabled();
  });

  it("creates the organization with a stable idempotency key and hands off to two-step sign-in", async () => {
    const { container, rpc, onCreated } = renderGate();
    submitName(container, "  Example Workers Local 1 ");
    // No union picked: no placement rides along (#7670).
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ status: "created" }), null));
    expect(rpc).toHaveBeenCalledWith("create_my_organization", {
      p_name: "Example Workers Local 1",
      p_idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(screen.getByRole("status")).toHaveTextContent("Organization created. Next, set up two-step sign-in.");
    expect(screen.getByRole("button", { name: "Create organization" })).toBeDisabled();
  });

  it("reuses the same key across a retry", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { status: "name_unavailable" }, error: null })
      .mockResolvedValueOnce(CREATED);
    const { container } = renderGate({ rpc });
    submitName(container);
    expect(await screen.findByRole("alert")).toHaveTextContent("That name is already in use. Choose a different name.");
    submitName(container, "Example Transit Local 2");
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(rpc.mock.calls[0][1].p_idempotency_key).toBe(rpc.mock.calls[1][1].p_idempotency_key);
    expect(Object.keys(rpc.mock.calls[0][1]).sort()).toEqual(["p_idempotency_key", "p_name"]);
  });

  it.each([
    [{ data: { status: "limit_reached" }, error: null }, "This account can't create another organization right now."],
    [{ data: { status: "unavailable" }, error: null }, "Creating organizations isn't available right now. Try again later."],
    [{ data: { status: "closed" }, error: null }, "Creating organizations isn't available right now. Try again later."],
    [{ data: null, error: { code: "PGRST202", message: "Could not find the function" } }, "Creating organizations isn't available right now."],
    [{ data: null, error: { code: "42883", message: "function does not exist" } }, "Creating organizations isn't available right now."],
    [{ data: null, error: { code: "42501", message: "mfa required" } }, "This session can't create an organization."],
    [{ data: null, error: { code: "22023", message: "organization membership exists" } }, "Your account already belongs to an organization."],
    [{ data: null, error: { code: "22023", message: "invalid organization" } }, "Names can't include email addresses, web links or phone numbers."],
    [{ data: null, error: { code: "22023", message: "invalid chapter" } }, "Something went wrong. Try again."],
    [{ data: null, error: { code: "22023", message: "idempotency key reused" } }, "Something went wrong. Try again."],
    [{ data: null, error: { code: "XX000", message: "internal detail 23505" } }, "Something went wrong. Try again."],
    [{ data: { status: "surprise" }, error: null }, "Something went wrong. Try again."],
  ])("maps %j to fixed copy without raw error text", async (answer, text) => {
    const { container, onCreated } = renderGate({ rpc: vi.fn().mockResolvedValue(answer) });
    submitName(container);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(text);
    expect(alert.textContent).not.toMatch(/23505|internal detail|Could not find|does not exist/);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("maps a thrown network failure to fixed copy", async () => {
    const { container } = renderGate({ rpc: vi.fn().mockRejectedValue(new Error("offline")) });
    submitName(container);
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong. Try again.");
  });

  it.each([
    ["x", "Use 2 to 120 characters."],
    ["contact@example.invalid", "Names can't include email addresses, web links or phone numbers."],
    ["https://example.invalid", "Names can't include email addresses, web links or phone numbers."],
    ["Local (555) 123-4567", "Names can't include email addresses, web links or phone numbers."],
  ])("checks %s before spending a request", (name, text) => {
    const { container, rpc } = renderGate();
    submitName(container, name);
    expect(screen.getByRole("alert")).toHaveTextContent(text);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("offers sign-out", () => {
    const { onSignOut } = renderGate();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalled();
  });

  it("renders in Spanish and has no axe violations in either language", async () => {
    const { container, unmount } = renderGate({ lang: "es" });
    expect(screen.getByRole("heading", { name: "Crea tu organización" })).toBeInTheDocument();
    expect(screen.getByText(/empieza sin verificar/)).toBeInTheDocument();
    unmount();
    for (const lang of ["en", "es"]) {
      const view = renderGate({ lang });
      const results = await axe.run(view.container, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
        rules: { "color-contrast": { enabled: false } },
      });
      expect(results.violations.map((violation) => violation.id)).toEqual([]);
      view.unmount();
    }
  });
});

describe("create_my_organization client helpers", () => {
  it("returns the created ids and never passes raw errors through", async () => {
    expect(await createMyOrganization({ rpc: vi.fn().mockResolvedValue(CREATED) }, "A B", "k"))
      .toEqual({ status: "created", organizationId: CREATED.data.organizationId, chapterId: "c-0123456789" });
    expect(await createMyOrganization({ rpc: vi.fn().mockResolvedValue({ data: { status: "created" }, error: null }) }, "A B", "k"))
      .toEqual({ status: "error" });
    expect(await createMyOrganization({ rpc: vi.fn().mockResolvedValue({ data: null, error: { status: 404 } }) }, "A B", "k"))
      .toEqual({ status: "unavailable" });
    expect(await createMyOrganization({ rpc: vi.fn().mockResolvedValue(undefined) }, "A B", "k"))
      .toEqual({ status: "error" });
  });

  it("generates UUID idempotency keys and mirrors the database name rule", () => {
    expect(newIdempotencyKey({ randomUUID: () => "fixed" })).toBe("fixed");
    expect(newIdempotencyKey()).toMatch(/^[0-9a-f-]{36}$/);
    expect(organizationNameProblem("Example Workers Local 1")).toBeNull();
    expect(organizationNameProblem(undefined)).toBe("length");
  });
});

describe("client name rule mirrors the server", () => {
  const p = organizationNameProblem;

  it("normalizes NFKC, collapses whitespace and trims before measuring", () => {
    expect(normalizeOrganizationName("  Ｅｘａｍｐｌｅ\t\n Workers   Local 1 ")).toBe("Example Workers Local 1");
    expect(p("  a  ")).toBe("length");
    expect(p(" a  b ")).toBeNull();
  });

  it("counts length in code points (2-120)", () => {
    expect(p("a")).toBe("length");
    expect(p("ab")).toBeNull();
    expect(p("a".repeat(120))).toBeNull();
    expect(p("a".repeat(121))).toBe("length");
    // 60 astral letters are 120 UTF-16 units but 60 code points.
    expect(p("\u{1D400}".repeat(60))).toBe(null);
    expect(p(`a${"\u{10400}".repeat(120)}`)).toBe("length");
  });

  it("refuses control characters", () => {
    for (const value of ["Bad\u0007Name", "Bad\u007fName", "Bad\u0085Name", "Bad\u009fName"]) expect(p(value), value).toBe("characters");
  });

  it.each([
    0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180f, 0x200b, 0x200f,
    0x202a, 0x202e, 0x2060, 0x206f, 0xfe00, 0xfe0f, 0xfeff,
  ].map((point) => point.toString(16).toUpperCase().padStart(4, "0")))("refuses the invisible or bidi code point U+%s", (hex) => {
    expect(p(`Example${String.fromCodePoint(Number.parseInt(hex, 16))}Local`)).toBe("characters");
  });

  it("requires at least one letter or digit", () => {
    expect(p("---")).toBe("characters");
    expect(p("!! ??")).toBe("characters");
    expect(p("-1-")).toBeNull();
    expect(p("Ωμέγα")).toBeNull();
  });

  it("refuses @ and ://", () => {
    expect(p("contact@example.invalid")).toBe("characters");
    expect(p("https://example.invalid")).toBe("characters");
    expect(p("Local 1: Example")).toBeNull();
  });

  it("refuses a run of 7 or more digits after removing separators", () => {
    expect(p("Local 123456")).toBeNull();
    expect(p("Local 1234567")).toBe("characters");
    for (const separator of [" ", "(", ")", ".", "+", "/", "_", "-", "\u2010", "\u2015", "\u2212", "\uff0d"]) {
      expect(p(`Call 555${separator}1234`), separator).toBe("characters");
    }
    expect(p("Local 555 x 1234")).toBeNull();
  });

  // #9164: the same rule as the database (20261118200200); the database half
  // is tests/organization-name-phone-rule-db.test.js.
  it.each([
    "Harrow Bay Public Employees Union Local 3307 (2026-11-18)",
    "Harrow Bay Local 3307 2026",
    "Harrow Bay Local 1199 (11/18/2026)",
    "Harrow Bay Local 3307 (2026)",
    "Harrow Bay Local 3307 11/18/26",
  ])("accepts a local number with a year or a date: %s", (name) => {
    expect(p(name)).toBeNull();
  });

  it.each([
    "Harrow Bay Local 3307 555-201-4477",
    "Harrow Bay (555) 201 4477",
    "Harrow Bay +1 555 201 4477",
    "Harrow Bay 555 2014",
    "Harrow Bay Local 3307 2026 555",
    "Harrow Bay Local 3307-2026-11-18",
    "Harrow Bay Local 3307 2026-13-18",
  ])("still refuses a phone number: %s", (name) => {
    expect(p(name)).toBe("characters");
  });
});

describe("first-run gate in the app shell", () => {
  it("renders only while signup is offered, the same check as the signup entry", () => {
    const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");
    const gate = app.indexOf("<CreateOrganizationGate");
    const condition = app.lastIndexOf("if (!fixtureDemo && !sampleLive && !data.member?.organizationId", gate);
    expect(condition).toBeGreaterThan(0);
    // REQ-UG-PUBLIC-SIGNUP-OWNER-SWITCH-20261003: the same owner-switch
    // read as the sign-in card's entry, off unless the server says on.
    expect(app.slice(condition, gate)).toContain("&& openSignupOffered) {");
    expect(app).toContain("const openSignupOffered = useOpenSignupAvailable() === true;");
    expect(app).toContain("signupAvailable={openSignupOffered}");
    expect(app).not.toContain("createOrganizationAvailable");
  });
});

// Create keeps focus while the create runs, the union picker
// above it is pending (not disabled), and one tick creates once.
describe("CreateOrganizationGate while the create runs", () => {
  const submitButton = (container) => container.querySelector('form:not([role="search"]) button[type="submit"]');

  it("keeps Create focused and pending while the create runs, with the union search pending too", async () => {
    const { container, rpc } = renderGate();
    fireEvent.change(container.querySelector('input[name="organizationName"]'), { target: { value: "Example Workers Local 1" } });
    const create = submitButton(container);
    await expectHeldWriteFocus(rpc, create, () => {
      fireEvent.click(create);
      const search = container.querySelector('input[name="unionSearch"]');
      expect(search).toBeEnabled();
      expect(search).toHaveAttribute("aria-disabled", "true");
    });
  });

  it("creates once when Create is activated twice in one tick", async () => {
    const { container, rpc } = renderGate();
    fireEvent.change(container.querySelector('input[name="organizationName"]'), { target: { value: "Example Workers Local 1" } });
    const create = submitButton(container);
    await expectOneWriteFromOneTick(rpc, [() => fireEvent.click(create), () => fireEvent.click(create)], { isWrite: (name) => name !== "search_union_catalog" && !String(name).startsWith("list_") });
  });
});
