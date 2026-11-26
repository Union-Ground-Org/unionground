import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WorkloadView } from "../src/views/WorkloadView.jsx";

// UX-UG-WORKLOAD-HISTORY-EMPTY-STATE-REUSES-COUNTER-COPY-20260920. The
// empty History tab rendered the list counter with count 0 ("0 submissions —
// yours alone…"). It now has its own empty-state sentence in both languages.
const workload = {
  entries: [],
  stats: { enoughData: false, categories: [], tiles: {} },
  reminders: { available: false },
};

describe.each([
  ["en", "History", /^No submissions yet\./, /^0 submissions/],
  ["es", "Historial", /^Todavía no hay envíos\./, /^0 envíos/],
])("workload History empty state (%s)", (lang, tabName, emptyCopy, counterCopy) => {
  it("reads as an empty state, not a zero counter", () => {
    render(
      <LanguageProvider lang={lang}>
        <WorkloadView data={{ workload }} onLogWork={vi.fn()} onSaveReminder={vi.fn()} />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: tabName }));
    expect(screen.getByText(emptyCopy)).toBeInTheDocument();
    expect(screen.queryByText(counterCopy)).toBeNull();
  });
});
