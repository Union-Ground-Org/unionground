// REQ-UG-RECOMMENDED-AND-NEAREST-STEWARD-20261001: "Find available committee contact"
// shows the recommended (or nearest) steward's display name, why they were
// chosen and only the contact routes that steward opted into — never the
// account id.
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CoordinationWorkflowPanels } from "../src/features/coordination/ui/CoordinationWorkflowPanels.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildCoordinationActor } from "../src/lib/mi1CoordinationWiring.js";

const member = buildCoordinationActor({
  userId: "user-1",
  organizationId: "org-1",
  membershipStatus: "active",
  selectedHat: "member",
  mfaSatisfied: true,
  sessionScope: "resolved",
  chapterId: "wor",
});

const model = { state: "ready", organizationId: "org-1", staff: false, records: [], leaderboards: [], messages: [], resources: [], exportRuns: [], outreach: [] };
const stewardId = "7f3c2a91-6b0e-4d54-9c18-2e0a1b4d8f33";

function renderPanel(result, lang = "en") {
  const actions = { onRecommendCoverage: vi.fn().mockResolvedValue(result) };
  render(<LanguageProvider lang={lang}><CoordinationWorkflowPanels tab="chapter" actor={member} model={model} busy={false} actions={actions} /></LanguageProvider>);
  return actions;
}

describe("recommended and nearest steward", () => {
  it("names the scheduled steward, the match and the opted-in routes", async () => {
    renderPanel({
      state: "covered", recommendedUserId: stewardId, source: "schedule", matchLevel: "work_location", contactRoute: "member_message",
      steward: { name: "Sam Site", contact: { conversation: true, email: "sam.site@example.invalid", phone: "(555) 010-0100" } },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find available committee contact" }));
    expect(await screen.findByText("Recommended committee contact: Sam Site")).toBeVisible();
    expect(screen.getByText("Same work location")).toBeVisible();
    expect(screen.getByRole("link", { name: "Email sam.site@example.invalid" })).toHaveAttribute("href", "mailto:sam.site@example.invalid");
    expect(screen.getByRole("link", { name: "Call (555) 010-0100" })).toHaveAttribute("href", "tel:5550100100");
    expect(screen.getByText("You can also message them from Messages.")).toBeVisible();
    expect(document.body.innerHTML).not.toContain(stewardId);
  });

  it("says nobody is scheduled and names the nearest steward, in Spanish, with no unshared route", async () => {
    renderPanel({
      state: "nearest", recommendedUserId: stewardId, source: "nearest", matchLevel: "department", contactRoute: "member_message",
      steward: { name: "Dana Department", contact: { conversation: true, email: null, phone: null } },
    }, "es");
    fireEvent.click(screen.getByRole("button", { name: "Buscar un contacto del comité disponible" }));
    expect(await screen.findByText("No hay ningún contacto del comité programado en este momento. El contacto del comité más cercano para ti es Dana Department.")).toBeVisible();
    expect(screen.getByText("Mismo departamento")).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("keeps the covered sentence when the server withholds the steward", async () => {
    renderPanel({ state: "covered", recommendedUserId: stewardId, steward: null });
    fireEvent.click(screen.getByRole("button", { name: "Find available committee contact" }));
    await waitFor(() => expect(screen.getByText("A committee member is covered at this time.")).toBeVisible());
    expect(document.body.innerHTML).not.toContain(stewardId);
  });
});
