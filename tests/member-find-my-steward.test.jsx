import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { MEMBER_PATH_VIEWS, SPA_ROUTE_PATHS } from "../src/lib/appRoutes.js";
import { findStewardConversation } from "../src/lib/messageWorkflow.js";
import { selectStewardConversation, stewardContactChannels, stewardsForViewer } from "../src/lib/stewardConversations.js";
import { defaultShortcutKeys, SHORTCUT_CATALOG } from "../src/lib/navigationPreferences.js";
import { normalizeChapterStewards, normalizeOrganizationStructure } from "../src/lib/memberApi.js";
import { SettingsView } from "../src/views/SettingsView.jsx";
import { TodayView } from "../src/views/TodayView.jsx";
import { MessagesView } from "../src/views/MessagesView.jsx";

// REQ-UG-MEMBER-FIND-MY-STEWARD-HOME-ENTRY-20260922.
//
// The defect this pins: a member had no product path to learn who their steward
// is or to reach that person, and once per-steward cards existed there was no
// steward identity on the conversation, so every card would have opened the
// same generic thread while a naive test still passed. Both halves are asserted
// here — the surface AND the routing.

const SAM = {
  id: "steward-sam", name: "Sam Okafor", roleLabel: "steward",
  chapterId: "wor", chapterLabel: "Harborview Care United", acceptsAppointments: true,
  contact: { conversation: true, email: null, phone: null },
};
const PRIYA = {
  id: "steward-priya", name: "Priya Chandran", roleLabel: "steward",
  chapterId: "wor", chapterLabel: "Harborview Care United", acceptsAppointments: false,
  contact: { conversation: true, email: "priya@example.org", phone: null },
};

function renderHome(props, desktop = false) {
  return render(
    <LanguageProvider lang={props.lang ?? "en"}>
      <TodayView
        data={{ ...fallbackData, ...props.data, chapterStewards: props.stewards ?? [] }}
        desktop={desktop}
        stewardMessageAvailable={props.stewardMessageAvailable ?? null}
        onPlanAction={vi.fn()}
        onContactSteward={props.onContactSteward}
        onOpenOrgStructure={props.onOpenOrgStructure}
      />
    </LanguageProvider>,
  );
}

describe("Find my steward — Home surface", () => {
  // REQ-UG-STALE-OR-CONTRADICTORY-STATE-AFTER-SAVE-20261030.

  it.each([["phone", false], ["desktop", true]])("lists each steward with a named Contact control on %s", (_label, desktop) => {
    const onContactSteward = vi.fn();
    renderHome({ stewards: [SAM, PRIYA], onContactSteward, onOpenOrgStructure: vi.fn() }, desktop);

    const card = screen.getByRole("region", { name: "Find my committee contact" });
    expect(within(card).getByText("Sam Okafor")).toBeInTheDocument();
    expect(within(card).getByText("Priya Chandran")).toBeInTheDocument();

    // Accessible names, not a bare "Contact" repeated twice: with two stewards
    // in one chapter a screen reader must be able to tell the buttons apart.
    const sam = within(card).getByRole("button", { name: "Contact Sam Okafor" });
    const priya = within(card).getByRole("button", { name: "Contact Priya Chandran" });
    sam.click();
    expect(onContactSteward).toHaveBeenLastCalledWith(SAM);
    priya.click();
    expect(onContactSteward).toHaveBeenLastCalledWith(PRIYA);
  });

  it("offers only the in-app conversation until a steward opts a channel in", () => {
    renderHome({ stewards: [SAM, PRIYA], onContactSteward: vi.fn(), onOpenOrgStructure: vi.fn() });
    const card = screen.getByRole("region", { name: "Find my committee contact" });
    // Sam published nothing, so Sam has no mail or tel affordance at all.
    expect(within(card).queryByRole("link", { name: "Email Sam Okafor" })).toBeNull();
    expect(within(card).queryByRole("link", { name: "Call Sam Okafor" })).toBeNull();
    // Priya opted email in and phone out.
    expect(within(card).getByRole("link", { name: "Email Priya Chandran" })).toHaveAttribute("href", "mailto:priya@example.org");
    expect(within(card).queryByRole("link", { name: "Call Priya Chandran" })).toBeNull();
  });

  it("renders an explicit empty state for a campaign with no committee contact", () => {
    renderHome({ stewards: [], onContactSteward: vi.fn(), onOpenOrgStructure: vi.fn() });
    const card = screen.getByRole("region", { name: "Find my committee contact" });
    expect(within(card).getByText("No committee contact is listed for your campaign yet. Ask your campaign administrator, or use Messages.")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /^Contact/ })).toBeNull();
  });

  it.each([
    ["en", true, "There’s no campaign yet. Create a campaign before assigning a committee member."],
    ["es", false, "Todavía no hay una campaña. Crea una campaña antes de asignar a un miembro del comité."],
  ])("gives a chapterless admin the first setup step (%s)", (lang, desktop, guidance) => {
    renderHome({ lang, data: { roles: ["admin"], member: { ...fallbackData.member, chapterId: null } } }, desktop);
    expect(screen.getByText(guidance)).toBeInTheDocument();
    expect(screen.queryByText(/Ask your chapter administrator|Pregunta a la administración de tu capítulo/)).toBeNull();
  });

  // BUG-UG-HOME-FIND-MY-STEWARD-CARD-NAMES-PAUSED-STEWARD-20261103
  // (#6971): the guide's availability rule, in the one shared helper.

  it("keeps the empty and only-self states when availability is false", () => {
    expect(stewardsForViewer([SAM], null, false)).toEqual({ others: [], self: false, unavailable: true });
    expect(stewardsForViewer([SAM], null, true)).toEqual({ others: [SAM], self: false, unavailable: false });
    expect(stewardsForViewer([SAM], null, null)).toEqual({ others: [SAM], self: false, unavailable: false });
    expect(stewardsForViewer([], null, false)).toEqual({ others: [], self: false, unavailable: false });
    expect(stewardsForViewer([SAM], SAM.id, false)).toEqual({ others: [], self: true, unavailable: false });
  });

  it("routes See org structure from the card", () => {
    const onOpenOrgStructure = vi.fn();
    renderHome({ stewards: [SAM], onContactSteward: vi.fn(), onOpenOrgStructure });
    screen.getByRole("button", { name: "See org structure" }).click();
    expect(onOpenOrgStructure).toHaveBeenCalledTimes(1);
  });

  it("names no union or agency anywhere in the feature's own copy", () => {
    // Blank-system rule. The card's strings must describe roles and actions,
    // never a specific organization; the only proper nouns it may render are
    // the data it was handed.
    for (const lang of ["en", "es"]) {
      for (const key of [
        "today.findSteward", "today.findStewardSub", "today.findStewardEmpty",
        "today.findStewardUnavailable", "altShell.stewardsUnavailable", "today.findStewardNote", "today.seeOrgStructure", "nav.findSteward",
        "orgStructure.title", "orgStructure.subtitle", "orgStructure.empty",
      ]) {
        expect(t(lang, key), `${lang}/${key}`).not.toMatch(/SEIU|509|Local\b|DDS/i);
      }
    }
  });

  it("ships every new string in English and Spanish", () => {
    for (const key of [
      "nav.findSteward", "nav.orgStructure", "today.findSteward", "today.findStewardSub",
      "today.findStewardEmpty", "today.findStewardUnavailable", "altShell.stewardsUnavailable",
      "today.findStewardNote", "today.contactSteward",
      "today.contactStewardNamed", "today.stewardEmail", "today.stewardPhone",
      "today.seeOrgStructure", "inbox.startWithSteward", "inbox.startWithStewardCancel",
      "orgStructure.title", "orgStructure.subtitle", "orgStructure.readOnlyNote",
    ]) {
      const en = t("en", key);
      const es = t("es", key);
      expect(en, key).toBeTruthy();
      expect(es, key).toBeTruthy();
      expect(es, `${key} is untranslated`).not.toBe(en);
    }
  });
});

describe("Find my steward — catalogue and routing", () => {
  it("is a default-on member shortcut in the catalogue", () => {
    const entry = SHORTCUT_CATALOG.find((item) => item.key === "find-steward");
    expect(entry).toBeTruthy();
    expect(entry.labelKey).toBe("nav.findSteward");
    expect(entry.viewKey).toBe("today");
    expect(defaultShortcutKeys(false)).toContain("find-steward");
  });

  it("registers the org structure page as a member route", () => {
    expect(MEMBER_PATH_VIEWS["/m/org-structure"]).toBe("orgStructure");
    expect(SPA_ROUTE_PATHS).toContain("/m/org-structure");
  });
});

describe("selected-steward conversation binding", () => {
  const canonical = { id: "conv-canonical", counterpartRole: "steward", stewardUserId: null };
  const samThread = { id: "conv-sam", counterpartRole: "steward", stewardUserId: "steward-sam" };
  const priyaThread = { id: "conv-priya", counterpartRole: "steward", stewardUserId: "steward-priya" };

  it("reaches each steward's own conversation with two stewards in one chapter", () => {
    const rows = [canonical, samThread, priyaThread];
    expect(selectStewardConversation(rows, "steward-sam")).toBe(samThread);
    expect(selectStewardConversation(rows, "steward-priya")).toBe(priyaThread);
  });

  it("never falls back to the canonical thread for a selected steward", () => {
    // This is the whole point of the column. Before it, a Contact control on
    // Priya's card resolved to the first steward-role row — Sam's, or the
    // shared generic one — and looked correct.
    expect(selectStewardConversation([canonical, samThread], "steward-priya")).toBeNull();
    expect(selectStewardConversation([canonical], "steward-sam")).toBeNull();
  });

  it("keeps the canonical thread as the unscoped answer", () => {
    expect(selectStewardConversation([samThread, canonical])).toBe(canonical);
    // A bound thread is never the general answer, even when it is the most
    // recently updated row or the only steward thread the member has: the
    // general "Message steward" action must not open a selected steward's
    // thread (the backend lets the general thread coexist with bound ones).
    expect(selectStewardConversation([samThread, priyaThread])).toBeNull();
    expect(findStewardConversation([samThread])).toBeNull();
    expect(selectStewardConversation([])).toBeNull();
  });

  it("keeps the web twin of findNativeStewardConversation on the same rule", () => {
    const rows = [canonical, samThread];
    expect(findStewardConversation(rows)).toBe(canonical);
    expect(findStewardConversation(rows, "steward-sam")).toBe(samThread);
    expect(findStewardConversation(rows, "steward-priya")).toBeNull();
    // Pre-column callers pass no second argument and keep today's answer.
    expect(findStewardConversation([{ id: "c", counterpartRole: "steward" }])).toEqual({ id: "c", counterpartRole: "steward" });
  });

  it("treats a blank or missing channel as no channel", () => {
    expect(stewardContactChannels({ contact: { conversation: true, email: "  ", phone: null } }))
      .toEqual({ conversation: true, email: null, phone: null });
    expect(stewardContactChannels({})).toEqual({ conversation: true, email: null, phone: null });
  });
});

describe("roster and structure projections", () => {
  it("drops a half-written contact preference rather than rendering it", () => {
    const [row] = normalizeChapterStewards([{ id: "s1", name: "A", contact: { email: "   ", phone: 17 } }]);
    expect(row.contact).toEqual({ conversation: true, email: null, phone: null });
    expect(row.acceptsAppointments).toBe(false);
    expect(normalizeChapterStewards(null)).toEqual([]);
    expect(normalizeChapterStewards([{ name: "no id" }])).toEqual([]);
  });

  it("omits an org-structure edge that does not land on two rendered nodes", () => {
    const structure = normalizeOrganizationStructure({
      organizationId: "org", chapterId: "wor",
      charts: [{
        chartKind: "union",
        nodes: [{ id: "n1", label: "Chapter" }, { id: "n2", label: "Steward" }],
        edges: [
          { id: "e1", sourceId: "n2", targetId: "n1", kind: "reports_to" },
          // A phantom participant — the exact shape an unresolved agency person
          // would take — must not draw a line.
          { id: "e2", sourceId: "n2", targetId: "missing", kind: "reports_to" },
          // A kind the member RPC allow-lists out. Belt and braces on the client.
          { id: "e3", sourceId: "n1", targetId: "n2", kind: "mentors" },
        ],
      }],
    });
    expect(structure.charts[0].edges.map((edge) => edge.id)).toEqual(["e1"]);
  });

  it("drops a chart kind the member projection does not define", () => {
    const structure = normalizeOrganizationStructure({ charts: [{ chartKind: "secret", nodes: [], edges: [] }] });
    expect(structure.charts).toEqual([]);
  });
});

describe("steward contact-visibility writer", () => {
  // Acceptance clause 3: the preference needs a steward-facing writer so a
  // steward sets it themselves. The card is the only web surface that writes
  // it, it is steward-only, and it says plainly that the default shares nothing.
  const stewardData = {
    member: { id: "steward-sam", fullName: "Sam Okafor", initials: "SO" },
    roles: ["steward"],
    metrics: {}, cases: [], events: [], forms: [], product: { spaces: [] },
  };

  function renderSettings(api, roles = ["steward"]) {
    return render(
      <LanguageProvider lang="en">
        <SettingsView
          data={{ ...stewardData, roles }}
          onNavigate={vi.fn()}
          onProfile={vi.fn()}
          onAssistant={vi.fn()}
          lang="en"
          onLanguage={vi.fn()}
          stewardContactApi={api}
        />
      </LanguageProvider>,
    );
  }

  const defaults = { shareEmail: false, sharePhone: false, contactEmail: null, contactPhone: null };

  it("shows a steward their own defaults: nothing shared", async () => {
    renderSettings({ load: vi.fn().mockResolvedValue(defaults), save: vi.fn() });
    expect(await screen.findByRole("heading", { name: "How workers can reach you" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Show my email to workers" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Show my phone number to workers" })).not.toBeChecked();
    expect(screen.getByText(/Nothing is shared until you save it here/)).toBeInTheDocument();
  });

  it("writes only the steward's own row", async () => {
    const save = vi.fn().mockResolvedValue({ ...defaults, shareEmail: true, contactEmail: "sam@example.org" });
    renderSettings({ load: vi.fn().mockResolvedValue(defaults), save });
    await screen.findByRole("heading", { name: "How workers can reach you" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Show my email to workers" }));
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "sam@example.org" } });
    fireEvent.click(screen.getByRole("button", { name: "Save contact visibility" }));
    await screen.findByRole("status");
    // No steward id crosses the boundary — the RPC behind this is self-scoped.
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ shareEmail: true, contactEmail: "sam@example.org" }));
    expect(JSON.stringify(save.mock.calls[0][0])).not.toContain("steward-sam");
  });

  it("is not offered to a member who holds no steward role", () => {
    renderSettings({ load: vi.fn().mockResolvedValue(defaults), save: vi.fn() }, []);
    expect(screen.queryByRole("heading", { name: "How workers can reach you" })).toBeNull();
  });

  it("says so when the preference cannot be loaded", async () => {
    renderSettings({ load: vi.fn().mockRejectedValue(new Error("denied")), save: vi.fn() });
    expect(await screen.findByRole("alert")).toHaveTextContent("Your contact visibility could not be loaded.");
  });
});

describe("web Messages general steward action", () => {
  function thread(id, stewardUserId, sender, body) {
    return {
      id, counterpartRole: "steward", stewardUserId, sender, initials: "CS",
      preview: `${id} preview`, dateLabel: "Sep 23", unread: 0,
      messages: [{ id: `${id}-m`, sender_kind: "steward", sender_name: sender, body, created_at: "2026-09-23T10:00:00.000Z", read_at: null }],
    };
  }
  function renderInbox(conversations) {
    return render(
      <LanguageProvider>
        <MessagesView data={{ member: { id: "member-1" }, conversations, broadcasts: [], product: { spaces: [] } }} onSendMessage={vi.fn()} onStartConversation={vi.fn()} onReadConversation={vi.fn().mockResolvedValue(null)} onReadBroadcast={vi.fn().mockResolvedValue(null)} onOpenTopics={vi.fn()} />
      </LanguageProvider>,
    );
  }

  it("opens the general thread even when a selected-steward thread was updated more recently", () => {
    // memberApi orders conversations by updated_at desc, so the bound thread
    // can come first; the general action must still reach the unbound thread.
    renderInbox([
      thread("conv-bound", "steward-dana", "Dana Lee", "Body only in the bound thread"),
      thread("conv-general", null, "Chapter steward", "Body only in the general thread"),
    ]);
    fireEvent.click(screen.getByRole("button", { name: t("en", "inbox.messageSteward") }));
    expect(screen.getByText("Body only in the general thread")).toBeTruthy();
    expect(screen.queryByText("Body only in the bound thread")).toBeNull();
  });

  it("offers no general steward action when only a selected-steward thread exists", () => {
    renderInbox([thread("conv-bound", "steward-dana", "Dana Lee", "Body only in the bound thread")]);
    expect(screen.queryByRole("button", { name: t("en", "inbox.messageSteward") })).toBeNull();
  });
});
