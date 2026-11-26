import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MessagesView } from "../src/views/MessagesView.jsx";

describe.each([
  ["en", "Contacts", "pending"],
  ["es", "Contactos", "pendientes"],
])("Contacts label in name (%s)", (lang, label, pending) => {
  it.each([0, 1, 12].flatMap((count) => [false, true].map((desktop) => ({ count, desktop }))))(
    "includes the visible label and count in order ($count pending, desktop=$desktop)",
    ({ count, desktop }) => {
      render(
        <LanguageProvider lang={lang}>
          <MessagesView
            desktop={desktop}
            data={{
              member: { id: "tamarack-member" }, conversations: [], broadcasts: [],
              product: { spaces: [], documents: [] },
              peerContact: {
                available: true, code: "UG-ABCD-1234", canRequest: false,
                incoming: Array.from({ length: count }, (_, index) => ({ id: `request-${index}`, requesterName: "Tamarack member" })),
                outgoing: [], conversations: [],
              },
            }}
            onSendMessage={vi.fn()}
            onReadConversation={vi.fn()}
            onReadBroadcast={vi.fn()}
            onOpenTopics={vi.fn()}
            peerContactApi={{ request: vi.fn(), respond: vi.fn(), send: vi.fn() }}
          />
        </LanguageProvider>,
      );
      const button = screen.getByRole("button", { name: new RegExp(`^${label}`) });
      const visibleLabel = button.textContent;
      expect(visibleLabel).toBe(count ? `${label} ${count} (${pending})` : label);
      expect(button).toHaveAccessibleName(visibleLabel);
      fireEvent.click(button);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    },
  );
});
