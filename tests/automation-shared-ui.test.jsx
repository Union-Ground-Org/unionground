import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AutomationDiscover } from "../src/features/automation/AutomationDiscover.jsx";
import { AutomationReviewPanel } from "../src/features/automation/AutomationReviewPanel.jsx";
import { normalizeAutomationProposal } from "../src/features/automation/proposals.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const capabilities = {
  schemaVersion: 2,
  triggers: ["overdue_task"],
  actions: ["create_standard_task"],
  cadences: ["daily"],
  maxThresholdDays: 90,
};

function translated(node) {
  return render(<LanguageProvider lang="en">{node}</LanguageProvider>);
}

describe("shared automation discovery", () => {
  it("keeps useful learning visible while connected authoring is unavailable", () => {
    translated(<AutomationDiscover
      connected={false}
      access={{ canAuthor: false, canApprove: false, canOperate: false }}
      capabilities={null}
      opportunities={[]}
      onStartDraft={vi.fn()}
      onOpenRecipes={vi.fn()}
    />);

    expect(screen.getByRole("heading", { name: "Make routine follow-up dependable" })).toBeVisible();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(expect.arrayContaining([
      expect.stringMatching(/Detect/), expect.stringMatching(/Draft/), expect.stringMatching(/Preview/),
      expect.stringMatching(/Review/), expect.stringMatching(/Run/),
    ]));
    expect(screen.getByText("Drafting automations isn't set up for this organization yet.")).toBeVisible();
    // BUG-UG-AUTOMATIONS-SHOWS-AUTHORING-ACTIONS-WHEN-NOT-INSTALLED-20261106:
    // without connected authoring nothing here can draft, so no drafting
    // action is shown at all, not even disabled.
    expect(screen.queryByRole("button", { name: "Create draft" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask Compass" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Browse recipes" })).toBeEnabled();
  });

  it("keeps opportunity rows but no Draft action while connected authoring is not installed", () => {
    translated(<AutomationDiscover
      connected={false}
      access={{ canAuthor: false, canApprove: false, canOperate: false }}
      capabilities={null}
      opportunities={[{ triggerKind: "overdue_task", thresholdDays: 1, scope: "organization", candidateCount: 4, covered: false }]}
      onStartDraft={vi.fn()}
      onOpenRecipes={vi.fn()}
    />);
    expect(screen.getByText(/4 currently match/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Draft this" })).toBeNull();
  });

  it.each(["mfa_required", "role_denied", "session_inactive"])("keeps the drafting actions, disabled with their reason, for a gap this person can close (%s)", (reason) => {
    translated(<AutomationDiscover
      connected={false}
      access={{ canAuthor: false, canApprove: false, canOperate: false, reason }}
      capabilities={null}
      opportunities={[]}
      onStartDraft={vi.fn()}
      onOpenRecipes={vi.fn()}
    />);
    expect(screen.getByRole("button", { name: "Create draft" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ask the Guide" })).toBeDisabled();
  });

  it("turns only a validated Compass proposal into an unsaved draft", async () => {
    const proposal = normalizeAutomationProposal({
      schemaVersion: 1,
      capabilityVersion: 2,
      proposal: {
        name: "Review overdue work", triggerKind: "overdue_task", thresholdDays: 3,
        cadence: "daily", taskPriority: "medium", conditions: {},
        actionKind: "create_standard_task", actionConfig: {},
      },
      needsInput: [], explanation: "This checks overdue work and drafts a standard follow-up task.",
      assumptions: ["The current organization scope is intended."], warnings: ["No effects occur before approval and activation."],
    }, capabilities);
    const onStartDraft = vi.fn();
    const requestCompass = vi.fn().mockResolvedValue({ ok: true, proposal });
    translated(<AutomationDiscover connected access={{ canAuthor: true, canApprove: false, canOperate: false }} capabilities={capabilities} opportunities={[]} accessToken="token" requestCompass={requestCompass} onStartDraft={onStartDraft} onOpenRecipes={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Describe the routine work"), { target: { value: "Follow up on overdue work" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask the Guide" }));
    expect(await screen.findByText(/checks overdue work/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Use this draft" }));
    expect(onStartDraft).toHaveBeenCalledWith(expect.objectContaining({ name: "Review overdue work", schemaVersion: 2 }));
  });

  it("keeps the user's prompt and opens no draft when Compass fails safely", async () => {
    const onStartDraft = vi.fn();
    translated(<AutomationDiscover connected access={{ canAuthor: true, canApprove: false, canOperate: false }} capabilities={capabilities} opportunities={[]} accessToken="token" requestCompass={vi.fn().mockResolvedValue({ ok: false, reason: "invalid_ai_result" })} onStartDraft={onStartDraft} onOpenRecipes={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Describe the routine work"), { target: { value: "Keep this exact request" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask the Guide" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not produce a safe draft/i);
    expect(screen.getByLabelText("Describe the routine work")).toHaveValue("Keep this exact request");
    expect(onStartDraft).not.toHaveBeenCalled();
  });

  it("names Discover opportunity scope in Spanish and leaves the English sentence unchanged", () => {
    const opportunities = [
      { triggerKind: "overdue_task", candidateCount: 4, thresholdDays: 3, scope: "chapter", covered: false },
      { triggerKind: "task_due", candidateCount: 2, thresholdDays: 1, scope: "organization", covered: false },
    ];
    const discover = (lang) => (
      <LanguageProvider lang={lang}>
        <AutomationDiscover
          connected
          access={{ canAuthor: true, canApprove: false, canOperate: false }}
          capabilities={capabilities}
          opportunities={opportunities}
          onStartDraft={vi.fn()}
          onOpenRecipes={vi.fn()}
        />
      </LanguageProvider>
    );

    const { unmount } = render(discover("es"));
    const chapter = screen.getByText("4 coinciden ahora · alcance de campaña");
    expect(chapter).toBeVisible();
    expect(chapter.textContent).not.toContain("chapter");
    const organization = screen.getByText("2 coinciden ahora · alcance de organización");
    expect(organization).toBeVisible();
    expect(organization.textContent).not.toContain("organization");
    unmount();

    render(discover("en"));
    expect(screen.getByText("4 currently match · campaign scope")).toBeVisible();
    expect(screen.getByText("2 currently match · organization scope")).toBeVisible();
  });
});

describe("automation review panel", () => {
  const definition = { id: "50900000-0000-4000-8000-000000000109", version: 4, reviewStatus: "submitted", status: "paused", submittedBySelf: true, canSubmit: false, canReview: true, canActivate: false };

  it("lets an author see state without receiving approval or execution controls", () => {
    translated(<AutomationReviewPanel definition={{ ...definition, canReview: false }} access={{ canAuthor: true, canApprove: false, canOperate: false }} busy={false} onSubmit={vi.fn()} onApprove={vi.fn()} onRequestChanges={vi.fn()} />);
    expect(screen.getByText("Review: Submitted")).toBeVisible();
    expect(screen.getByText("Execution: Paused")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve version 4" })).not.toBeInTheDocument();
  });

  it("requires a note for changes and makes self-review explicit", async () => {
    const onRequestChanges = vi.fn();
    translated(<AutomationReviewPanel definition={definition} access={{ canAuthor: true, canApprove: true, canOperate: true }} busy={false} onSubmit={vi.fn()} onApprove={vi.fn()} onRequestChanges={onRequestChanges} />);
    expect(screen.getByText(/You submitted this version/)).toBeVisible();
    const request = screen.getByRole("button", { name: "Request changes" });
    expect(request).toBeEnabled();
    expect(request).toHaveAttribute("aria-disabled", "true");
    expect(request).toHaveAccessibleDescription("Write a review note before requesting changes.");
    fireEvent.click(request);
    expect(onRequestChanges).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Review note"), { target: { value: "Clarify the chapter scope." } });
    fireEvent.click(request);
    await waitFor(() => expect(onRequestChanges).toHaveBeenCalledWith("Clarify the chapter scope."));
    expect(screen.getByRole("button", { name: "Approve version 4" })).toBeEnabled();
  });

  it("passes the trimmed review note on Approve and null when the note is blank", () => {
    const onApprove = vi.fn();
    translated(<AutomationReviewPanel definition={definition} access={{ canAuthor: true, canApprove: true, canOperate: true }} busy={false} onSubmit={vi.fn()} onApprove={onApprove} onRequestChanges={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve version 4" }));
    expect(onApprove).toHaveBeenCalledWith(null);
    fireEvent.change(screen.getByLabelText("Review note"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Approve version 4" }));
    expect(onApprove).toHaveBeenLastCalledWith(null);
    fireEvent.change(screen.getByLabelText("Review note"), { target: { value: "  Approved after the chapter scope was clarified.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Approve version 4" }));
    expect(onApprove).toHaveBeenLastCalledWith("Approved after the chapter scope was clarified.");
    expect(screen.getByRole("button", { name: "Request changes" })).toBeEnabled();
  });
});
