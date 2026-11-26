import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotificationsDialog } from "../src/components/Dialogs.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { notificationDestination } from "../src/lib/notificationDestinations.js";

// BUG-UG-NOTIFICATION-ITEMS-DO-NOT-OPEN-WHAT-THEY-ANNOUNCE-20261004:
// clicking "Meeting minutes published" did nothing. A notice whose copy key
// names one place is now a real button that opens it; any other notice stays
// plain text, never a control that goes nowhere.

const minutes = {
  id: "n-minutes", title: "Meeting minutes published", body: "HHS Chapter Meeting — September 17, 2026 is ready in Chapter record.",
  created_at: "2026-10-04T06:50:00Z", read_at: null, kind: "general", copy_key: "institutional.minutes.published", source_chapter_id: "hhs",
};
const plain = {
  id: "n-plain", title: "New chapter update", body: "The latest chapter broadcast is ready.",
  created_at: "2026-10-04T06:40:00Z", read_at: null, kind: "general", copy_key: null,
};
const unknown = { ...plain, id: "n-unknown", title: "Two-step sign-in was turned on", copy_key: "security.mfa_enabled" };

function renderDialog(onOpenDestination = vi.fn(), chapterId = "hhs") {
  render(
    <LanguageProvider lang="en">
      <NotificationsDialog notifications={[minutes, plain, unknown]} onClose={vi.fn()} onReadAll={vi.fn()} onOpenDestination={onOpenDestination} chapterId={chapterId} />
    </LanguageProvider>,
  );
  return onOpenDestination;
}

describe("notifications that open what they announce", () => {
  it("maps only the keys that name one place", () => {
    expect(notificationDestination(minutes, { chapterId: "hhs" })).toEqual({ view: "hub", path: "/m/organize/record" });
    expect(notificationDestination(plain, { chapterId: "hhs" })).toBeNull();
    expect(notificationDestination(unknown, { chapterId: "hhs" })).toBeNull();
    expect(notificationDestination({ copy_key: "constructor" })).toBeNull();
    expect(notificationDestination(null)).toBeNull();
  });

  it("opens the chapter record from the minutes notice by pointer", () => {
    const onOpen = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /Meeting minutes published/ }));
    expect(onOpen).toHaveBeenCalledWith({ view: "hub", path: "/m/organize/record" }, minutes);
  });

  it("is a native button, so the keyboard reaches and activates it", () => {
    renderDialog();
    const open = screen.getByRole("button", { name: /Meeting minutes published/ });
    expect(open.tagName).toBe("BUTTON");
    expect(open).toHaveAttribute("type", "button");
    open.focus();
    expect(open).toHaveFocus();
  });

  it("leaves a notice without a destination as plain text", () => {
    renderDialog();
    for (const title of ["New chapter update", "Two-step sign-in was turned on"]) {
      const article = screen.getByText(title).closest("article");
      expect(within(article).queryByRole("button")).toBeNull();
    }
  });

  it("stays plain text everywhere when the host offers no navigation", () => {
    render(
      <LanguageProvider lang="en">
        <NotificationsDialog notifications={[minutes]} onClose={vi.fn()} onReadAll={vi.fn()} />
      </LanguageProvider>,
    );
    expect(within(screen.getByText("Meeting minutes published").closest("article")).queryByRole("button")).toBeNull();
  });

  // Codex P2 on #3942: minutes published in another of the member's chapters
  // would open the selected chapter's record, so they stay plain text.
  it("opens only minutes from the member's selected chapter", () => {
    expect(notificationDestination(minutes, { chapterId: "transit" })).toBeNull();
    expect(notificationDestination({ ...minutes, source_chapter_id: null }, { chapterId: "hhs" })).toBeNull();
    expect(notificationDestination(minutes, {})).toBeNull();
    renderDialog(vi.fn(), "transit");
    expect(within(screen.getByText("Meeting minutes published").closest("article")).queryByRole("button")).toBeNull();
  });
});
