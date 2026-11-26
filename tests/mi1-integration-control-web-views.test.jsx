import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildMi1FeatureActor } from "../src/lib/mi1FeatureWiring.js";
import { IntegrationsView } from "../src/views/IntegrationsView.jsx";

const ORG = "11111111-1111-4111-8111-111111111111";

function wrap(node) {
  return render(<LanguageProvider lang="en">{node}</LanguageProvider>);
}

describe("MI1 integration-control web surface", () => {
  it("shows integrations as unset instead of a fake connected vendor", async () => {
    wrap(<IntegrationsView actor={buildMi1FeatureActor({
      userId: "admin-a",
      organizationId: ORG,
      roles: ["admin"],
      mfaSatisfied: true,
      selectedHat: "admin",
    })} />);
    expect(await screen.findByText("Integration credentials are not persisted yet. Requesting setup does not store a live vendor secret.")).toBeInTheDocument();
    expect(screen.queryByText(/connected successfully/i)).not.toBeInTheDocument();
  });

  // Directory sync (SCIM) is held with single sign-on
  // (REQ-UG-HOLD-DIRECTORY-SYNC-WITH-SINGLE-SIGN-ON-20261117, #9037):
  // without a live backend its release cannot be read, which reads as held,
  // so nothing on the page names it, not even a load error. Released, a
  // failed setup read still shows the load error
  // (tests/integrations-scim-release-hold.test.jsx).
  it("leaves directory sync (SCIM) out without a live backend, because its release cannot be read", async () => {
    wrap(<IntegrationsView actor={buildMi1FeatureActor({
      userId: "admin-a",
      organizationId: ORG,
      roles: ["admin"],
      mfaSatisfied: true,
      selectedHat: "admin",
    })} />);
    expect(await screen.findByRole("heading", { name: "Connections" })).toBeInTheDocument();
    await Promise.resolve();
    expect(screen.queryByText("SCIM setup could not be loaded. Try again.")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open SCIM setup" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Issue SCIM token" })).not.toBeInTheDocument();
    expect(screen.queryByText(/\bSCIM\b/)).not.toBeInTheDocument();
    expect(screen.queryByText(/directory connected/i)).not.toBeInTheDocument();
  });

  it("surfaces a bounded OAuth callback failure as an actionable alert", async () => {
    window.history.pushState({}, "", "/m/integrations?constant_contact=error");
    wrap(<IntegrationsView actor={buildMi1FeatureActor({
      userId: "admin-a",
      organizationId: ORG,
      roles: ["admin"],
      mfaSatisfied: true,
      selectedHat: "admin",
    })} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Verify provider setup and try again");
    window.history.pushState({}, "", "/");
  });

  it("explains a canceled OAuth callback without implying the provider connected", async () => {
    window.history.pushState({}, "", "/m/integrations?constant_contact=denied");
    wrap(<IntegrationsView actor={buildMi1FeatureActor({
      userId: "admin-a",
      organizationId: ORG,
      roles: ["admin"],
      mfaSatisfied: true,
      selectedHat: "admin",
    })} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("connection was canceled");
    expect(screen.queryByText(/connected successfully/i)).not.toBeInTheDocument();
    window.history.pushState({}, "", "/");
  });
});
