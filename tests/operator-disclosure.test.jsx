import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPERATOR_UNSET_MESSAGE, operatorDisclosure, operatorPosture, withOperator } from "../api/_lib/operator.js";
import { runtimeOperator } from "../src/lib/operator.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { OperatorView } from "../src/views/OperatorView.jsx";
import { PublicDocumentShell } from "../src/components/PublicDocumentShell.jsx";
import { OfficialServiceBadge } from "../src/components/ServiceIdentity.jsx";
import { officialServiceMarkShown } from "../src/lib/brand.js";
import officialDomains from "../config/official-domains.json";
import { metadataForPath } from "../src/lib/publicPageMetadata.js";
import { PUBLIC_STATIC_ROUTES } from "../scripts/public-route-metadata.mjs";

const OPERATOR = { name: "Tamarack Organizing Committee", contactEmail: "help@tamarack.example" };
const DEPLOYED = { VERCEL: "1", NODE_ENV: "production" };
const CONFIGURED = { schema: 1, surface: "saas", configured: true, supabaseUrl: "https://x.supabase.co", supabasePublishableKey: "sb_publishable_x" };

afterEach(() => vi.restoreAllMocks());

describe("operator settings (api/_lib/operator.js)", () => {
  it("discloses the required name and contact, plus the optional website and jurisdiction", () => {
    expect(operatorDisclosure({ OPERATOR_NAME: " Tamarack  Organizing Committee ", OPERATOR_CONTACT_EMAIL: "help@tamarack.example" }))
      .toEqual(OPERATOR);
    expect(operatorDisclosure({
      OPERATOR_NAME: "Tamarack", OPERATOR_CONTACT_EMAIL: "help@tamarack.example",
      OPERATOR_URL: "https://tamarack.example/about", OPERATOR_JURISDICTION: "State of Washington, USA",
    })).toEqual({ name: "Tamarack", contactEmail: "help@tamarack.example", url: "https://tamarack.example/about", jurisdiction: "State of Washington, USA" });
    expect(operatorDisclosure({ OPERATOR_NAME: "Tamarack", OPERATOR_CONTACT_EMAIL: "help@tamarack.example", OPERATOR_URL: "http://plain.example" }))
      .toEqual({ name: "Tamarack", contactEmail: "help@tamarack.example" });
  });

  it("is unset while either required setting is missing or unusable", () => {
    for (const env of [
      {}, { OPERATOR_NAME: "Tamarack" }, { OPERATOR_CONTACT_EMAIL: "help@tamarack.example" },
      { OPERATOR_NAME: "Tamarack", OPERATOR_CONTACT_EMAIL: "not-an-address" },
      { OPERATOR_NAME: "Tama\u202erack", OPERATOR_CONTACT_EMAIL: "help@tamarack.example" },
      { OPERATOR_NAME: "x".repeat(121), OPERATOR_CONTACT_EMAIL: "help@tamarack.example" },
    ]) expect(operatorDisclosure(env), JSON.stringify(env)).toBeNull();
  });

  it("refuses sign-in on a deployed server until the operator is set, and never locally", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(operatorPosture(DEPLOYED)).toEqual({ ok: false, reason: "operator-unset", message: OPERATOR_UNSET_MESSAGE });
    expect(operatorPosture({ ...DEPLOYED, OPERATOR_NAME: OPERATOR.name, OPERATOR_CONTACT_EMAIL: OPERATOR.contactEmail })).toEqual({ ok: true });
    expect(operatorPosture({ NODE_ENV: "test" })).toEqual({ ok: true });

    expect(withOperator(CONFIGURED, DEPLOYED)).toEqual({ schema: 1, surface: "saas", configured: false, refused: "operator-unset", operator: null });
    const served = withOperator(CONFIGURED, { ...DEPLOYED, OPERATOR_NAME: OPERATOR.name, OPERATOR_CONTACT_EMAIL: OPERATOR.contactEmail });
    expect(served).toEqual({ ...CONFIGURED, operator: OPERATOR });
    expect(withOperator(CONFIGURED, { NODE_ENV: "test" })).toEqual({ ...CONFIGURED, operator: null });
    expect(withOperator({ schema: 1, surface: null, configured: false }, DEPLOYED)).toEqual({ schema: 1, surface: null, configured: false, operator: null });
  });

  it("reads only a well-formed operator on the client", () => {
    expect(runtimeOperator({ operator: OPERATOR })).toEqual({ ...OPERATOR, url: null, jurisdiction: null });
    expect(runtimeOperator({ operator: { ...OPERATOR, url: "javascript:alert(1)" } }).url).toBeNull();
    expect(runtimeOperator({ operator: { name: "x" } })).toBeNull();
    expect(runtimeOperator(undefined)).toBeNull();
  });
});

describe("official service mark", () => {
  it("lists exactly the LLC's own hosts", () => {
    expect(officialDomains.webHosts).toEqual(["unionground.org", "www.unionground.org", "app.unionground.org", "unionground.net", "app.unionground.net"]);
  });

  it("shows only on an exact official host, never on a lookalike", () => {
    for (const host of officialDomains.webHosts) expect(officialServiceMarkShown(host), host).toBe(true);
    for (const host of [
      "unionground.org.evil.example", "evil-unionground.org", "union-ground.org", "unionground.org.", "xn--unionground-9xa.org",
      "xn--niongroud-x2a.org", "app.unionground.org.example", "unionground.com", "localhost", "", undefined,
    ]) expect(officialServiceMarkShown(host), String(host)).toBe(false);
  });

  it("renders the badge only there", () => {
    const { container, rerender } = render(<LanguageProvider lang="en"><OfficialServiceBadge hostname="app.unionground.org" /></LanguageProvider>);
    expect(container).toHaveTextContent("Official Union Ground service");
    rerender(<LanguageProvider lang="en"><OfficialServiceBadge hostname="unionground.org.evil.example" /></LanguageProvider>);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Who runs this server (/operator)", () => {
  it("is a public route with its own document and metadata", () => {
    expect(PUBLIC_STATIC_ROUTES).toContain("/operator");
    expect(metadataForPath("/operator")).toMatchObject({ path: "/operator", title: "Who runs this server | Union Ground" });
  });

  it("names the operator and says it is not Union Ground LLC on any other host", () => {
    render(<LanguageProvider lang="en"><OperatorView operator={{ ...OPERATOR, url: "https://tamarack.example", jurisdiction: "Washington, USA" }} hostname="tamarack.example" /></LanguageProvider>);
    expect(screen.getByRole("heading", { level: 1, name: "Who runs this server" })).toBeInTheDocument();
    expect(screen.getByText("This server is run by Tamarack Organizing Committee, not by Union Ground LLC.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: OPERATOR.contactEmail })).toHaveAttribute("href", `mailto:${OPERATOR.contactEmail}`);
    expect(screen.getByRole("link", { name: "https://tamarack.example" })).toBeInTheDocument();
    expect(screen.getByText("Washington, USA")).toBeInTheDocument();
    expect(screen.queryByText("Official Union Ground service")).toBeNull();
  });

  it("says it is the official service only on an official host of an official build", () => {
    render(<LanguageProvider lang="en"><OperatorView operator={{ name: "Union Ground LLC", contactEmail: "help@unionground.org" }} hostname="app.unionground.org" /></LanguageProvider>);
    expect(screen.getByText("This is the official Union Ground service, run by Union Ground LLC.")).toBeInTheDocument();
    expect(screen.getByText("Official Union Ground service")).toBeInTheDocument();
  });

  it("warns when the server has not said who runs it, in English and Spanish", () => {
    const { unmount } = render(<LanguageProvider lang="en"><OperatorView operator={null} hostname="tamarack.example" /></LanguageProvider>);
    expect(screen.getByRole("note")).toHaveTextContent("This server has not said who runs it.");
    unmount();
    render(<LanguageProvider lang="es"><OperatorView operator={OPERATOR} hostname="tamarack.example" /></LanguageProvider>);
    expect(screen.getByRole("heading", { level: 1, name: "Quién administra este servidor" })).toBeInTheDocument();
    expect(screen.getByText("Este servidor lo administra Tamarack Organizing Committee, no Union Ground LLC.")).toBeInTheDocument();
  });

  it("is linked from every public legal page, with the attribution and the source code link", () => {
    render(<LanguageProvider lang="en"><PublicDocumentShell eyebrow="e" title="t" intro="i" sections={[]} /></LanguageProvider>);
    const legal = screen.getByRole("navigation", { name: "Legal information" });
    expect(within(legal).getByRole("link", { name: "Who runs this server" })).toHaveAttribute("href", "/operator");
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByRole("link", { name: "Who runs this server" })).toHaveAttribute("href", "/operator");
    expect(footer).toHaveTextContent("Based on Union Ground (https://unionground.org)");
    expect(within(footer).getByRole("link", { name: "Source code" })).toHaveAttribute("href", "https://github.com/Union-Ground-Org/unionground");
  });
});
