import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

vi.mock("../src/features/knowledge/KnowledgeWorkspacePanel.jsx", () => ({
  KnowledgeWorkspacePanel: ({ driveOutcome, canDriveOperate }) => <>
    <p data-testid="drive-outcome">{driveOutcome}</p>
    <p data-testid="drive-operate">{String(canDriveOperate)}</p>
  </>,
}));

import { ProductHubView } from "../src/views/ProductHubView.jsx";

describe("Google Drive OAuth callback UI", () => {
  it("opens Library, forwards the failure, and consumes the callback query", async () => {
    window.history.replaceState({}, "", "/m/organize?drive=failed&retained=1");
    render(<LanguageProvider lang="en"><ProductHubView
      data={{ member: { id: "member-1" }, roles: ["admin"], product: {} }}
      staffAccess
      knowledgeClient={{}}
      knowledgeAdminAccess
    /></LanguageProvider>);

    expect(await screen.findByTestId("drive-outcome")).toHaveTextContent("failed");
    expect(screen.getByRole("button", { name: "Library" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(window.location.search).toBe("?retained=1"));
  });

  // BUG-UG-CHAPTER-HAT-STEWARD-COORDINATOR-ADVISOR-OFFERED-GOOGLE-DRIVE-LIST-20260921.
  // The workspace's Drive operations follow organization_role_grants, which is
  // what authorize_google_drive_operation reads -- not the flattened staff
  // roles a chapter grant also feeds.
  it("grants Drive operations to organization role grants only", async () => {
    window.history.replaceState({}, "", "/m/organize");
    const chapterOnly = render(<LanguageProvider lang="en"><ProductHubView
      data={{ member: { id: "member-1", organizationId: "org-1", organizationRoles: [], chapterRoles: ["steward"] }, roles: ["steward"], product: {} }}
      staffAccess
      knowledgeClient={{}}
    /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(await screen.findByTestId("drive-operate")).toHaveTextContent("false");
    chapterOnly.unmount();

    render(<LanguageProvider lang="en"><ProductHubView
      data={{ member: { id: "member-2", organizationId: "org-1", organizationRoles: ["steward"], chapterRoles: [] }, roles: ["steward"], product: {} }}
      staffAccess
      knowledgeClient={{}}
    /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(await screen.findByTestId("drive-operate")).toHaveTextContent("true");
  });
});
