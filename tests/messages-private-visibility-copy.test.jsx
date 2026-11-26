// BUG-UG-PRIVATE-CONVERSATION-VISIBILITY-UNSTATED-20261006: a member
// read "Private conversation" as "only my committee contact reads this". Only Settings,
// Privacy said that authorized campaign-wide staff can read private messages
// too. The thread header and the composer now say it, in both languages.
// REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030: every
// surface now says it in the one set of words features/messaging/visibility.js
// hands out, and the Privacy page lists the same sentence.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { t } from "../src/lib/i18n.js";
import { PRIVACY_STATEMENT_KEYS, VISIBILITY_KEYS, privacyStatements } from "../src/features/messaging/visibility.js";

const conversation = {
  id: "conversation-1",
  sender: "Chapter Steward",
  initials: "CS",
  preview: "About the overtime list",
  dateLabel: "Now",
  unread: 0,
  messages: [],
};

const COPY = {
  en: {
    audience: "You and your campaign's committee members can read it",
    composer: "Messages to your committee member: you and your campaign's committee members (and any organization-wide committee member) can read them, not only the committee member you write to. Your employer cannot.",
  },
  es: {
    audience: "La pueden leer tú y los miembros del comité de tu campaña",
    composer: "Mensajes a tu miembro del comité: los pueden leer tú y los miembros del comité de tu campaña (y cualquier miembro del comité de toda la organización), no solo el miembro del comité al que escribes. Tu empleador no puede.",
  },
};

function show({ lang = "en", desktop = false } = {}) {
  render(
    <LanguageProvider lang={lang}>
      <MessagesView
        data={{ member: { id: "member-1" }, conversations: [conversation], broadcasts: [], product: { spaces: [], documents: [] } }}
        desktop={desktop}
        onSendMessage={vi.fn().mockResolvedValue({})}
        onReadConversation={vi.fn().mockResolvedValue(null)}
        onReadBroadcast={vi.fn().mockResolvedValue(null)}
        onOpenTopics={vi.fn()}
      />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, "", "/m/messages?conversation=conversation-1");
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe.each(["en", "es"])("a private conversation in %s", (lang) => {
  it("says in the desktop thread header and at the composer who else can read it", async () => {
    show({ lang, desktop: true });
    const header = await screen.findByText(COPY[lang].audience, { selector: ".inbox-detail__head-audience" });
    expect(header.closest(".inbox-detail__head")).not.toBeNull();
    expect(screen.getByText(t(lang, "inbox.privateConversation"), { selector: ".inbox-detail__head-sub" })).toBeInTheDocument();
    const box = screen.getByRole("textbox", { name: t(lang, "inbox.composerPlaceholder") });
    expect(box).toHaveAccessibleDescription(COPY[lang].composer);
    expect(screen.getByText(COPY[lang].composer).closest("form")).toBeNull();
  });

  it("says the same under the phone dialog header and at its composer", async () => {
    show({ lang });
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog).toHaveTextContent(COPY[lang].audience));
    const box = screen.getByRole("textbox", { name: t(lang, "inbox.composerPlaceholder") });
    expect(dialog).toContainElement(box);
    expect(box).toHaveAccessibleDescription(COPY[lang].composer);
  });

  it("says it on the first-message form, before anything is sent", () => {
    window.history.replaceState({}, "", "/m/messages");
    const onStartConversation = vi.fn();
    render(
      <LanguageProvider lang={lang}>
        <MessagesView
          data={{ member: { id: "member-1" }, conversations: [], broadcasts: [], product: { spaces: [], documents: [] } }}
          onSendMessage={vi.fn().mockResolvedValue({})}
          onReadConversation={vi.fn().mockResolvedValue(null)}
          onReadBroadcast={vi.fn().mockResolvedValue(null)}
          onOpenTopics={vi.fn()}
          onStartConversation={onStartConversation}
        />
      </LanguageProvider>,
    );
    const box = screen.getByLabelText(t(lang, "inbox.firstMessageLabel"));
    expect(box).toHaveAccessibleDescription(COPY[lang].composer);
    expect(onStartConversation).not.toHaveBeenCalled();
  });
});

describe("the catalogue", () => {
  it.each(["en", "es"])("is the Settings privacy statement it repeats, word for word, in %s", (lang) => {
    const tr = (key, vars) => t(lang, key, vars);
    const listed = privacyStatements(tr).map((row) => row.text);
    expect(listed).toContain(COPY[lang].composer);
    expect(PRIVACY_STATEMENT_KEYS).toContain(VISIBILITY_KEYS.steward);
    // The retired wordings are gone from every surface's catalogue.
    for (const key of ["inbox.privateConversationVisibility", "inbox.privateConversationAudience"]) expect(t(lang, key)).toBe(key);
    expect(t(lang, "morehub.footerPrivacy")).not.toMatch(/your union|tu sindicato/i);
  });

  it("keeps the opener unchanged so the Contacts and inbox rows still read Private conversation", () => {
    expect(t("en", "inbox.privateConversation")).toBe("Private conversation");
    expect(t("es", "inbox.privateConversation")).toBe("Conversación privada");
  });
});
