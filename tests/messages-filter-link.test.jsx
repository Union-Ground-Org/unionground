// REQ-UG-DEAD-IN-APP-LINKS-404-20261030: /m/announcements redirects
// to /m/messages?filter=announcement, so the link must open that inbox filter.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { MessagesView } from "../src/views/MessagesView.jsx";

function show() {
  render(
    <LanguageProvider lang="en">
      <MessagesView
        data={{ member: { id: "member-1" }, conversations: [], broadcasts: [], product: { spaces: [], documents: [] } }}
        onSendMessage={vi.fn().mockResolvedValue({})}
        onReadConversation={vi.fn().mockResolvedValue(null)}
        onReadBroadcast={vi.fn().mockResolvedValue(null)}
        onOpenTopics={vi.fn()}
      />
    </LanguageProvider>,
  );
}

const filterButton = (key) => screen.getByRole("button", { name: new RegExp(`^${t("en", `inbox.filter.${key}`)}`, "u") });

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("the Messages filter link", () => {
  it("opens the Announcements filter from ?filter=announcement", async () => {
    window.history.replaceState({}, "", "/m/messages?filter=announcement");
    show();
    expect(await screen.findByRole("button", { pressed: true, name: new RegExp(`^${t("en", "inbox.filter.announcement")}`, "u") })).toBeInTheDocument();
    expect(filterButton("all")).toHaveAttribute("aria-pressed", "false");
  });

  it("ignores a filter the inbox does not offer", () => {
    window.history.replaceState({}, "", "/m/messages?filter=everything");
    show();
    expect(filterButton("all")).toHaveAttribute("aria-pressed", "true");
  });
});
