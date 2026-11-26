// Settings offered "Most used places" while its only
// card (NavUsageSettingsCard) rendered nothing, because the organization had
// the ranking off or there was no member, so the page was titled but empty.
// A hidden page leaves the menu and its URL returns to the Settings overview.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";

function show(hiddenPageKeys) {
  const navigate = vi.fn();
  render(
    <LanguageProvider lang="en">
      <WorkspacePages view="settings" hat="member" location={{ pathname: window.location.pathname }} navigate={navigate} hiddenPageKeys={hiddenPageKeys}>
        <h1>Settings</h1>
      </WorkspacePages>
    </LanguageProvider>,
  );
  const menu = screen.getByRole("navigation", { name: "Page menu" });
  // The page menu's closed list keeps its links in the DOM, hidden.
  const labels = within(menu).getAllByRole("link", { hidden: true }).map((link) => link.textContent);
  return { navigate, labels };
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("hidden workspace pages", () => {
  it("drops a hidden settings page from the menu and returns its URL to the overview", () => {
    window.history.replaceState({}, "", "/m/settings/appearance");
    const { navigate, labels } = show(["settings-appearance"]);
    expect(labels).not.toContain("Most used places");
    expect(labels).toContain("Notifications");
    expect(navigate).toHaveBeenCalledWith("settings", "/m/settings", null, { replace: true });
  });

  it("keeps the page while its card can show", () => {
    window.history.replaceState({}, "", "/m/settings/appearance");
    const { navigate, labels } = show(undefined);
    expect(labels).toContain("Most used places");
    expect(navigate).not.toHaveBeenCalledWith("settings", "/m/settings", null, { replace: true });
  });
});
