// #9596 unit 1: empty states a demo visitor meets first.
// D1-12, D3-5: the inbox pasted the filter's name into "No {filter} messages"
// (No all messages, No channels messages); each filter now has its own
// sentence, and with nothing listed the reading pane no longer asks the
// reader to select something.
// D3-10 (part): Active cases drew "Select all shown" and "Export all 0
// matching (CSV)" over an empty list; a steward's Appointments said "Last 30
// days: 0 completed · 0 no-shows." with no history.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MESSAGE_FILTERS, MessagesView } from "../src/views/MessagesView.jsx";
import { CaseBulkActions } from "../src/components/CaseBulkActions.jsx";
import { StewardAppointmentsPanel } from "../src/components/StewardAppointmentsPanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";

const t = (key, vars = {}) => String(catalogue.en[key]).replace(/\{(\w+)\}/g, (_, name) => String(vars[name]));

function inboxData() {
  return {
    member: { id: "member-1" },
    conversations: [{ id: "conv-1", counterpartRole: "steward", sender: "Chapter steward", initials: "CS", preview: "Hello", dateLabel: "Jul 12", unread: 0, messages: [] }],
    broadcasts: [],
    product: { spaces: [] },
  };
}

function inbox({ lang = "en", desktop = true, staffAccess = false, data = inboxData() } = {}) {
  return render(
    <LanguageProvider lang={lang}>
      <MessagesView data={data} desktop={desktop} staffAccess={staffAccess} onSendMessage={vi.fn()} onReadConversation={vi.fn().mockResolvedValue(null)} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} onOpenCases={vi.fn()} />
    </LanguageProvider>,
  );
}

const pickFilter = (label) => fireEvent.click(within(screen.getByRole("toolbar")).getByText(label).closest("button"));
const emptyLine = (container) => container.querySelector(".inbox-empty--results strong");

describe("the inbox's empty line reads as a sentence under every filter (#9596 D1-12, D3-5)", () => {
  it.each([
    ["Channels", "No channel messages"],
    ["Tasks", "No task messages"],
    ["Announcements", "No announcements"],
    ["Saved", "No saved messages"],
    ["Reminders", "No reminders"],
  ])("%s says %s", (label, sentence) => {
    const { container } = inbox();
    pickFilter(label);
    expect(emptyLine(container)).toHaveTextContent(new RegExp(`^${sentence}$`));
  });

  it("says No messages yet, not No all messages, on an empty staff inbox", () => {
    const { container } = inbox({ staffAccess: true, data: { ...inboxData(), conversations: [] } });
    expect(emptyLine(container)).toHaveTextContent(/^No messages yet$/);
    expect(container).not.toHaveTextContent(/No all messages/);
  });

  it("speaks Spanish without pasting a filter name", () => {
    const { container } = inbox({ lang: "es" });
    pickFilter("Canales");
    expect(emptyLine(container)).toHaveTextContent(/^No hay mensajes de canales$/);
    expect(container).not.toHaveTextContent(/No hay mensajes en /);
  });

  // Sol read of 8d129787 (answer 1): walks the view's own filter list, so a
  // filter added without its sentence fails here.
  it("has an English and a Spanish sentence for every filter the inbox offers", () => {
    expect(MESSAGE_FILTERS.length).toBeGreaterThan(0);
    for (const key of MESSAGE_FILTERS) {
      expect(catalogue.en[`inbox.noFilterResults.${key}`]).toBeTruthy();
      expect(catalogue.es[`inbox.noFilterResults.${key}`]).toBeTruthy();
    }
  });

  it("does not ask the reader to select something when nothing is listed", () => {
    inbox();
    pickFilter("Saved");
    const pane = screen.getByRole("region", { name: "Message detail" });
    expect(within(pane).queryByText(/Select a conversation/)).not.toBeInTheDocument();
    expect(within(pane).getByText(/When a message, thread or announcement arrives/)).toBeInTheDocument();
    pickFilter("All");
    expect(within(pane).getByText(/Select a conversation, thread, or announcement/)).toBeInTheDocument();
  });

  // Sol read of 8d129787 (answer 5): a search with no match is not an inbox
  // waiting for mail; the pane says what to search for.
  it("does not promise an arrival when a search matches nothing", () => {
    inbox();
    fireEvent.change(screen.getByLabelText(catalogue.en["inbox.searchPlaceholder"]), { target: { value: "zzz-no-such-message" } });
    const pane = screen.getByRole("region", { name: "Message detail" });
    expect(within(pane).queryByText(/arrives/)).not.toBeInTheDocument();
    expect(within(pane).queryByText(/Select a conversation/)).not.toBeInTheDocument();
    expect(within(pane).getByText("Try a person, topic, task, or phrase from the message.")).toBeInTheDocument();
  });

  it("uses the filter chip's word for announcements in Spanish", () => {
    inbox({ lang: "es" });
    pickFilter("Guardados");
    const pane = screen.getByRole("region", { name: "Detalle del mensaje" });
    expect(within(pane).getByText(/un comunicado/)).toBeInTheDocument();
    expect(catalogue.es["inbox.filter.announcement"]).toBe("Comunicados");
  });
});

const ROWS = [{ id: "c1", title: "Overtime", status: "open", step: "step_1" }];
const bulk = (props) => render(<CaseBulkActions rows={ROWS} onSelectionChange={() => {}} api={{}} t={t} exportPrefix="coordinator-cases" exportFilterKeys={[]} {...props} />);

describe("Active cases with no case shown (#9596 D3-10)", () => {
  it("draws no bulk select and no Export all 0 matching", () => {
    const { container } = bulk({ rows: [], visibleIds: [], selection: [] });
    expect(within(container).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(container).queryByRole("button", { name: /export/i })).not.toBeInTheDocument();
  });

  it("keeps the bar while a chosen case is filtered out of view", () => {
    bulk({ visibleIds: [], selection: ["c1"] });
    expect(screen.getByRole("button", { name: t("caseBulk.exportSelected", { count: 1 }) })).toBeInTheDocument();
  });

  it("keeps the bar when a case is shown", () => {
    bulk({ visibleIds: ["c1"], selection: [] });
    expect(screen.getByRole("button", { name: t("caseBulk.exportVisible", { count: 1 }) })).toBeEnabled();
  });
});

const desk = (stats) => ({ loadAppointments: async () => ({ upcoming: [], recent: [], windows: [], schedule: { accepting: true }, stats }) });
const panel = (api, lang = "en") => render(<LanguageProvider lang={lang}><StewardAppointmentsPanel api={api} onNotice={vi.fn()} /></LanguageProvider>);

describe("a steward's Appointments with no history (#9596 D3-10)", () => {
  it("drops the 30-day line until something was completed or missed", async () => {
    const { container } = panel(desk({ completed30d: 0, noShows30d: 0 }));
    // The loading sentence goes once the desk has loaded; no line replaces it.
    await vi.waitFor(() => expect(container.querySelector(".cwk-count")).not.toBeNull());
    expect(container.querySelector(".cwk-panel__note")).toBeNull();
    expect(container).not.toHaveTextContent(/Last 30 days/);
  });

  it("keeps it once there is history", async () => {
    panel(desk({ completed30d: 2, noShows30d: 1 }));
    expect(await screen.findByText("Last 30 days: 2 completed · 1 no-shows.")).toBeInTheDocument();
  });
});
