import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChapterSheet } from "../src/components/ChapterSheet.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

describe("ChapterSheet tool rows", () => {
  it("renders the campaign glyph path and forwards explicit staff navigation fields", () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    const { unmount } = render(
      <LanguageProvider lang="en">
        <ChapterSheet
          chapterName="Harborview Care United"
          tools={[{ key: "campaigns", labelKey: "nav.campaigns", path: "/m/campaigns", sectionId: "campaigns" }]}
          onNavigate={onNavigate}
          onClose={onClose}
        />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("link", { name: /Campaigns/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("campaigns", "/m/campaigns", "campaigns");
    unmount();
  });

  it("hides member chapter tools when a staff hat owns the sheet", () => {
    render(
      <LanguageProvider lang="en">
        <ChapterSheet
          chapterName="Harborview Care United"
          memberTools={false}
          tools={[{ key: "tasks", labelKey: "staff.chapterWork", path: "/m/tasks", icon: "☑" }]}
          onNavigate={() => {}}
          onClose={() => {}}
        />
      </LanguageProvider>,
    );
    expect(screen.getByRole("link", { name: /Campaign work/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Voting/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Meetings/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Be heard/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /My campaign/ })).not.toBeInTheDocument();
  });

  it("leaves modified and non-primary tool-row clicks to the browser without closing the sheet", () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    render(
      <LanguageProvider lang="en">
        <ChapterSheet chapterName="Harborview Care United" onNavigate={onNavigate} onClose={onClose} />
      </LanguageProvider>,
    );
    const row = screen.getByRole("link", { name: /Meetings/ });
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(fireEvent.click(row, init)).toBe(true);
    }
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(fireEvent.click(row)).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("events", "/m/events", undefined);
  });
});
