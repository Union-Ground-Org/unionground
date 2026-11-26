import { useEffect, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WorkloadView } from "../src/views/WorkloadView.jsx";

const NOTE_LABEL = "Incident note (optional)";
const SUBMIT_TAB = "Submit";
const HISTORY_TAB = "History";

function renderWorkload(overrides = {}) {
  const onLogWork = overrides.onLogWork || vi.fn(async () => ({}));
  render(
    <LanguageProvider lang="en">
      <WorkloadView
        data={structuredClone(fallbackData)}
        onLogWork={onLogWork}
        onSaveReminder={async () => ({})}
      />
    </LanguageProvider>,
  );
  return { onLogWork };
}

// Mirrors App.jsx: one WorkspacePages provider, one WorkloadView instance,
// popstate updates location without remounting the view. RoutedTabLink then
// renders real <a> tags that pushState, so history.back() is a real hop.
function WorkspaceRouter({ children }) {
  const [location, setLocation] = useState(() => window.location.href);
  useEffect(() => {
    const changed = () => setLocation(window.location.href);
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  function navigate(_nextView, path, _focus, options = {}) {
    window.history[options.replace ? "replaceState" : "pushState"]({}, "", path);
    setLocation(window.location.href);
  }
  return (
    <LanguageProvider lang="en">
      <WorkspacePages view="workload" hat="member" location={location} navigate={navigate}>
        {children}
      </WorkspacePages>
    </LanguageProvider>
  );
}

function renderRoutedWorkload() {
  window.history.replaceState({}, "", "/m/workload/submit");
  render(
    <WorkspaceRouter>
      <WorkloadView
        data={structuredClone(fallbackData)}
        onLogWork={async () => ({})}
        onSaveReminder={async () => ({})}
      />
    </WorkspaceRouter>,
  );
}

function noteField() {
  return screen.getByRole("textbox", { name: NOTE_LABEL });
}

function priorityValue() {
  return screen.getByRole("group", { name: "Priority" }).querySelector(".mwl-stepval");
}

function fillDraft() {
  fireEvent.change(noteField(), { target: { value: "Front desk short-staffed all week" } });
  fireEvent.click(screen.getByRole("button", { name: "Increase Priority" }));
  fireEvent.click(screen.getByRole("button", { name: "Part-time" }));
}

function expectDraftIntact() {
  expect(noteField()).toHaveValue("Front desk short-staffed all week");
  expect(priorityValue()).toHaveTextContent("1");
  expect(screen.getByRole("button", { name: "Part-time" })).toHaveAttribute("aria-pressed", "true");
}

afterEach(() => {
  clearDeviceParityState();
  window.history.replaceState({}, "", "/m");
});

describe("workload submit draft survives tab switches", () => {
  it("retains every filled field across Submit → History → Submit", () => {
    renderWorkload();
    fillDraft();

    fireEvent.click(screen.getByRole("button", { name: HISTORY_TAB }));
    // The switch landed: the Submit note is out of the accessibility tree.
    expect(screen.queryByRole("textbox", { name: NOTE_LABEL })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: SUBMIT_TAB }));

    expectDraftIntact();
  });

  it("retains the draft across repeated routed-tab round trips", () => {
    renderWorkload();
    fillDraft();

    for (const round of [1, 2]) {
      fireEvent.click(screen.getByRole("button", { name: HISTORY_TAB }));
      fireEvent.click(screen.getByRole("button", { name: SUBMIT_TAB }));
      expect(noteField()).toHaveValue("Front desk short-staffed all week");
      expect(priorityValue()).toHaveTextContent("1");
    }
  });

  it("retains the draft across a real WorkspacePages hop and browser Back", async () => {
    renderRoutedWorkload();
    fillDraft();
    expect(window.location.pathname).toBe("/m/workload/submit");

    fireEvent.click(screen.getByRole("link", { name: HISTORY_TAB }));
    expect(window.location.pathname).toBe("/m/workload/history");
    // Mount only the selected section: the Submit panel is unmounted, so its
    // note field is absent from the accessibility tree.
    expect(screen.queryByRole("textbox", { name: NOTE_LABEL })).toBeNull();
    expect(screen.queryByTestId("workload-submit-panel")).toBeNull();

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await waitFor(() => expect(window.location.pathname).toBe("/m/workload/submit"));
    expectDraftIntact();
  });

  it("unmounts the Submit section while another tab is active and restores the draft on return", () => {
    renderWorkload();
    fillDraft();

    fireEvent.click(screen.getByRole("button", { name: HISTORY_TAB }));

    // Mount only the selected section (the focused-workspace rule): the
    // whole Submit subtree is absent from the DOM — nothing to announce, lay
    // out, or reach by tab order — while the parent-owned draft survives.
    expect(screen.queryByTestId("workload-submit-panel")).toBeNull();
    expect(screen.queryByRole("textbox", { name: NOTE_LABEL })).toBeNull();
    expect(screen.queryByRole("button", { name: "Increase Priority" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: SUBMIT_TAB }));
    expect(screen.getAllByTestId("workload-submit-panel")).toHaveLength(1);
    expectDraftIntact();
  });

  it("still clears the form on a successful submit", async () => {
    const { onLogWork } = renderWorkload({
      onLogWork: vi.fn(async () => ({ receiptCode: "RCPT-1", remainingToday: 2 })),
    });
    fillDraft();

    fireEvent.click(screen.getByRole("button", { name: "Submit to secure ledger" }));

    await waitFor(() => expect(onLogWork).toHaveBeenCalledTimes(1));
    expect(noteField()).toHaveValue("");
    expect(priorityValue()).toHaveTextContent("0");
    expect(screen.getByRole("button", { name: "Full-time" })).toHaveAttribute("aria-pressed", "true");
  });

  it("still clears the form on Clear all", () => {
    renderWorkload();
    fillDraft();

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, clear all" }));

    expect(noteField()).toHaveValue("");
    expect(priorityValue()).toHaveTextContent("0");
    expect(screen.getByRole("button", { name: "Full-time" })).toHaveAttribute("aria-pressed", "true");
  });
});
