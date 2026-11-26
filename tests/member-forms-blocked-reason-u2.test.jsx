// #9460 unit 2: a held member control says what is missing beside it (W4-17, W4-8).
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { catalogue } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { FormsView } from "../src/views/FormsView.jsx";
import { MessagesView } from "../src/views/MessagesView.jsx";

const described = node => (node.getAttribute("aria-describedby") || "").split(" ").filter(Boolean)
  .map(id => document.getElementById(id)?.textContent || "").join(" ");
const expectReason = (scope, name, text) => {
  const button = scope.getByRole("button", { name });
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(described(button)).toContain(text);
};
const lang = (code, node) => <LanguageProvider lang={code}>{node}</LanguageProvider>;

describe("a form's Review step (W4-17)", () => {
  it.each(["en", "es"])("names the first required answer still empty and goes to it, in %s", (code) => {
    const c = catalogue[code];
    render(lang(code, <FormsView data={{ member: { initials: "FT" }, forms: [] }} focus={{ templateKey: "alt_work" }}
      onSaveDraft={vi.fn().mockResolvedValue("draft")} onSubmit={vi.fn()} />));
    const requested = c["forms.f.requested"];
    fireEvent.click(screen.getByRole("button", { name: c["forms.next"] }));
    fireEvent.click(screen.getByRole("button", { name: c["forms.next"] }));
    expect(screen.getByRole("button", { name: c["forms.submitCta"] })).toBeDisabled();
    expect(screen.getByText(c["forms.stillNeeded"].replace("{label}", requested))).toHaveAttribute("role", "status");
    expect(screen.getAllByText(c["forms.requiredNotAnswered"]).length).toBeGreaterThan(0);
    expect(screen.getAllByText(c["forms.notAnswered"]).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: c["forms.goToField"].replace("{label}", requested) }));
    expect(screen.getByRole("textbox", { name: requested })).toBeRequired();
  });

  it("names only what is missing on Sign and accept: both, the drawing alone, then the tick", () => {
    const c = catalogue.en;
    render(lang("en", <FormsView data={{ member: { initials: "MV" }, forms: [], cosignRequests: [{ formId: "f1", status: "invited", filerName: "Jordan", reviewDigest: "d1" }] }}
      onSaveDraft={vi.fn()} onSubmit={vi.fn()} onRespondCosign={vi.fn()} />));
    fireEvent.click(screen.getByRole("button", { name: c["forms.cosign.accept"] }));
    const dialog = within(screen.getByRole("dialog"));
    expectReason(dialog, c["forms.cosign.signAccept"], c["forms.cosign.signAndTick"]);
    fireEvent.click(dialog.getByRole("checkbox"));
    expectReason(dialog, c["forms.cosign.signAccept"], c["forms.filing.signatureSignFirst"]);
    fireEvent.click(dialog.getByRole("checkbox"));
    fireEvent.click(dialog.getByRole("radio", { name: c["forms.filing.signatureWayType"] }));
    fireEvent.change(dialog.getByRole("textbox", { name: c["forms.filing.typedName"] }), { target: { value: "Jordan Mills" } });
    expectReason(dialog, c["forms.cosign.signAccept"], c["forms.filing.signatureTickBox"]);
  });
});

describe("a conversation's composer tools (W4-8)", () => {
  it.each(["en", "es"])("says why the other tool is dimmed, in %s", (code) => {
    const c = catalogue[code];
    const data = {
      member: { id: "member-1" }, broadcasts: [],
      conversations: [{ id: "c1", counterpartRole: "steward", sender: "Steward", preview: "Due.", unread: 0, scheduled: [],
        messages: [{ id: "m1", sender_kind: "member", body: "Due.", created_at: "2026-07-12T10:00:00Z" }] }],
      product: { spaces: [], documents: [{ id: "doc-1", title: "Policy", status: "published" }] },
    };
    render(lang(code, <MessagesView data={data} messagingApi={{ schedule: vi.fn() }}
      onSendMessage={vi.fn()} onReadConversation={vi.fn().mockResolvedValue(null)} />));
    fireEvent.click(screen.getByText("Due.", { selector: ".inbox-row__preview" }));
    const dialog = within(screen.getByRole("dialog"));
    const resource = dialog.getByLabelText(c["inbox.shareResource"]);
    const when = dialog.getByLabelText(c["inbox.scheduleFor"]);
    fireEvent.change(resource, { target: { value: "doc-1" } });
    expect(when).toBeDisabled();
    expect(dialog.getByText(c["inbox.resourceSendsNow"])).toHaveAttribute("role", "status");
    fireEvent.change(resource, { target: { value: "" } });
    fireEvent.change(when, { target: { value: "2099-01-01T09:00" } });
    expect(resource).toBeDisabled();
    expect(dialog.getByText(c["inbox.scheduledNoResource"])).toHaveAttribute("role", "status");
    expect(dialog.queryByText(c["inbox.resourceSendsNow"])).toBeNull();
  });
});
