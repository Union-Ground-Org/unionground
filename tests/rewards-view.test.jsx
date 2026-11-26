import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RewardsView } from "../src/views/RewardsView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const data = {
  member: { initials: "DF" },
  recognition: { currentRung: "organize" },
  recognitionCatalog: {
    rules: [
      {
        recognitionKind: "training_complete",
        label: "Completed training",
        description: "A facilitator verified completion of a chapter-approved training.",
        weeklyCap: 2,
      },
      {
        recognitionKind: "peer_outreach_complete",
        label: "Completed peer outreach",
        description: "An assigned, consensual outreach commitment was completed and verified.",
        weeklyCap: 5,
      },
    ],
    events: [
      {
        id: "recognition-1",
        recognitionKind: "training_complete",
        sourceLabel: "Organizing foundations",
        occurredAt: "2026-07-20T18:00:00Z",
      },
    ],
  },
};

describe("contributions view", () => {
  it("shows acknowledgements and eligible categories without totals, ranks, or caps", () => {
    render(<RewardsView data={data} />);
    expect(screen.getByRole("heading", { name: "Contributions" })).toBeInTheDocument();
    expect(screen.getAllByText("Completed training").length).toBeGreaterThan(1);
    expect(screen.getByText("Completed peer outreach")).toBeInTheDocument();
    expect(screen.getByText("Organizing foundations")).toBeInTheDocument();
    expect(screen.queryByText(/total points/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/tier/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/cap 2/i)).not.toBeInTheDocument();
    expect(screen.getByText("Organize").closest("li")).toHaveClass("participation-path__item--current");
  });

  it("states the no-effects boundary and excluded protected activity", () => {
    render(<RewardsView data={data} />);
    expect(screen.getByText(/has no effect on representation, issues, voting/i)).toBeInTheDocument();
    expect(screen.getByText(/issues; retaliation reports; evidence uploads/i)).toBeInTheDocument();
  });

  it("renders safe empty states when recognition reads degrade", () => {
    render(<RewardsView data={{ member: { initials: "DF" }, recognitionCatalog: { rules: [], events: [] } }} />);
    expect(screen.getByText("Recognition details could not load — try again shortly.")).toBeInTheDocument();
    expect(screen.getByText("No private acknowledgements recorded yet.")).toBeInTheDocument();
  });
});

// The participation path's five labels and its "Current path" marker were an
// inline `lang === "es" ? {…} : {…}` table — a second translation catalogue
// hiding inside a view, outside the en/es parity guard.
describe("participation path localisation", () => {
  it("renders the rungs from the catalogue in both locales", () => {
    const { unmount } = render(
      <LanguageProvider lang="en">
        <RewardsView data={data} />
      </LanguageProvider>,
    );
    const pathEn = screen.getByRole("list", { name: "Current path" });
    expect(within(pathEn).getByText("Organize")).toBeInTheDocument();
    expect(within(pathEn).getByText("Volunteer")).toBeInTheDocument();
    unmount();

    render(
      <LanguageProvider lang="es">
        <RewardsView data={data} />
      </LanguageProvider>,
    );
    const pathEs = screen.getByRole("list", { name: "Ruta actual" });
    expect(within(pathEs).getByText("Organizar")).toBeInTheDocument();
    expect(within(pathEs).getByText("Colaborar")).toBeInTheDocument();
    expect(within(pathEs).queryByText("Organize")).toBeNull();
  });
});
