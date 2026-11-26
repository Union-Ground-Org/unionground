import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LanguageProvider, organizationTranslator } from "../src/lib/LanguageContext.jsx";
import { withSystemSenderLabels } from "../src/features/messaging/systemLabels.js";
import { MessagesView } from "../src/views/MessagesView.jsx";

// The loader turns the server's reserved title into the catalogue default
// (inbox.chapterSteward), which in this edition is "Campaign committee member".
const generic = {
  id: "conversation", counterpartRole: "steward", sender: "Campaign committee member", initials: "CS", unread: 0,
  preview: "Chapter meeting question", dateLabel: "Today",
  messages: [{ id: "message", sender_kind: "steward", sender_name: "Campaign committee member", body: "Chapter meeting question" }],
};

describe("system sender wording follows saved organization terms", () => {
  it.each(["en", "es"])("renames the reserved role, preserving authored titles and message text in %s", (lang) => {
    const t = organizationTranslator(lang, { "term.chapter": "unit" });
    const row = withSystemSenderLabels(generic, t);
    expect(row.sender).toMatch(/unit/i);
    expect(row.messages[0].sender_name).toBe(row.sender);
    expect(row.messages[0].body).toBe("Chapter meeting question");
    expect(generic.sender).toBe("Campaign committee member");
    const named = { ...generic, sender: "Example Chapter", messages: [] };
    expect(withSystemSenderLabels(named, t)).toBe(named);
    expect(withSystemSenderLabels({ ...named, senderLabelKey: "untrusted.key" }, t).sender).toBe("Example Chapter");
    const broadcast = withSystemSenderLabels({ sender: "Campaign committee member", title: "Chapter meeting", body: "Authored chapter update" }, t);
    expect(broadcast.sender).toMatch(/unit/i);
    expect(broadcast.title).toBe("Chapter meeting");
    expect(broadcast.body).toBe("Authored chapter update");
  });

  it("keeps system provenance across a second label save and has no requirement for a message window", () => {
    const row = { sender: "Unit committee member", senderLabelKey: "inbox.chapterSteward" };
    expect(withSystemSenderLabels(row, organizationTranslator("en", { "term.chapter": "section" })).sender).toBe("Section committee member");
    expect(withSystemSenderLabels(generic, organizationTranslator("en"))).toBe(generic);
    const mixed = { ...generic, messages: [
      { sender_kind: "member", sender_name: "Campaign committee member", body: "Member text" },
      { sender_kind: "steward", sender_name: "Example Chapter", body: "Named sender" },
      { sender_kind: "steward", sender_name: "Unit committee member", body: "Already localized" },
    ] };
    expect(withSystemSenderLabels(mixed, organizationTranslator("en", { "term.chapter": "unit" })).messages).toEqual(mixed.messages);
  });

  it("updates an already-loaded Messages list when the saved label changes", () => {
    const data = { member: { id: "member" }, conversations: [{ ...generic, senderLabelKey: "inbox.chapterSteward" }], broadcasts: [], product: { spaces: [], documents: [] } };
    const view = (term) => <LanguageProvider lang="en" labelOverrides={{ "term.chapter": term }}><MessagesView data={data} desktop /></LanguageProvider>;
    const { rerender } = render(view("unit"));
    expect(screen.getAllByText("Unit committee member").length).toBeGreaterThan(0);
    expect(screen.getByText("Chapter meeting question")).toBeInTheDocument();
    rerender(view("section"));
    expect(screen.getAllByText("Section committee member").length).toBeGreaterThan(0);
    expect(screen.queryByText("Unit committee member")).not.toBeInTheDocument();
  });
});
