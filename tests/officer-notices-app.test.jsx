import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { primeDemoData } from "../src/data/demoData.js";

// REQ-UG-OFFICER-NOTICES-WITH-READ-RECEIPTS-20261030: the
// Announcements tab was read-only for everyone. An admin acting as Member is
// now offered to act as Admin there, and the Admin role gets the composer;
// a member without a posting role still only reads.

beforeEach(() => {
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

afterEach(() => primeDemoData(fallbackData));

function openAnnouncements(roles) {
  primeDemoData({ ...fallbackData, roles });
  window.history.replaceState({}, "", "/m/messages?filter=announcement");
  return render(<App />);
}

describe("the Announcements tab", () => {
  it("offers an admin acting as Member the Admin role, then the notice composer", async () => {
    openAnnouncements(["admin"]);
    // The Messages view loads lazily. Wait for its actual role action, with
    // headroom for a cold transform on the shared development workstation.
    fireEvent.click(await screen.findByRole("button", { name: "Act as Admin here" }, { timeout: 5_000 }));
    expect(await screen.findByRole("heading", { name: "Post a notice" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Post notice" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Act as Admin here" })).toBeNull());
    // Sol final on #6606: switching filters hides the desk without losing an
    // unsent notice.
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Unsent notice" } });
    fireEvent.click(screen.getByRole("button", { name: /^Unread/u }));
    expect(screen.queryByRole("heading", { name: "Post a notice" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Announcements/u }));
    expect(await screen.findByRole("heading", { name: "Post a notice" })).toBeVisible();
    expect(screen.getByLabelText("Title")).toHaveValue("Unsent notice");
  });

  it("stays read-only for a member without a posting role", async () => {
    openAnnouncements(["coordinator"]);
    await waitFor(() => expect(window.location.pathname).toBe("/m/messages"));
    expect(await screen.findByRole("button", { name: /^Announcements/u, pressed: true })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Post a notice" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Act as .* here/u })).toBeNull();
  });
});
