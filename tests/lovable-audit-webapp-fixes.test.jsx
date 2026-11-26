import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { StateBlock } from "../src/components/Primitives.jsx";
import { WorkspaceStatusState } from "../src/components/WorkspaceStatusState.jsx";
import { BroadcastPublishConfirm, broadcastLanguageKey, otherBroadcastLocale } from "../src/components/BroadcastPublishConfirm.jsx";
import { BusyTestHost, expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
import { StewardView } from "../src/views/StewardView.jsx";
import { CoordinatorView } from "../src/views/CoordinatorView.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { quorumProgress, quorumProgressText } from "../src/lib/quorumProgress.js";
import { t as translate } from "../src/lib/i18n.js";
import { composeAnalyticsWorkspace, createPreviewAnalyticsViewer } from "../src/features/analytics/index.js";
import { createPreviewPulseApi } from "../src/features/pulse/pulsePreview.js";

// REQ-UG-LOVABLE-AUDIT-WEBAPP-FIXES-20261103: the Oct 18-19 Lovable
// audit's web-app findings, ported from Batch A's fix patterns. Status states
// for pages that cannot show their content (P0 APP-STEWARD-06, -12; APP-ADMIN-
// 11 to -13; APP-ADVISOR-03) and the steward broadcast's confirmation with its
// bilingual step (APP-STEWARD-11).

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("the unavailable status state", () => {
  it("is announced as a status with a heading, the reason, links and who can fix it", () => {
    render(<StateBlock kind="unavailable" title="Not here" body="Because." hint="Who can fix this: an admin." links={[{ label: "Go", href: "/m/go" }, { label: "Back", href: "/m/back" }]} />);
    const state = screen.getByRole("status");
    expect(within(state).getByRole("heading", { level: 2, name: "Not here" })).toBeInTheDocument();
    expect(within(state).getByText("Because.")).toBeInTheDocument();
    expect(within(state).getByRole("link", { name: "Go" })).toHaveClass("state-block__action--primary");
    expect(within(state).getByRole("link", { name: "Back" })).not.toHaveClass("state-block__action--primary");
    expect(within(state).getByText("Who can fix this: an admin.")).toBeInTheDocument();
  });

  it("keeps the empty and error kinds unannounced, as before", () => {
    const { container } = render(<StateBlock title="Nothing yet" />);
    expect(container.querySelector("[data-state-block='empty']")).not.toHaveAttribute("role");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("routes a link through its own handler and leaves modified clicks to the browser", () => {
    const onClick = vi.fn();
    render(<WorkspaceStatusState title="Not here" body="Because." links={[{ label: "Calculator", path: "/m/pay/calculator", onClick }, { label: "Plain", path: "/m/pay" }]} />);
    const link = screen.getByRole("link", { name: "Calculator" });
    expect(link).toHaveAttribute("href", "/m/pay/calculator");
    fireEvent.click(link, { ctrlKey: true });
    expect(onClick).not.toHaveBeenCalled();
    expect(fireEvent.click(link)).toBe(false);
    expect(onClick).toHaveBeenCalledTimes(1);
    // Outside a workspace a plain link navigates normally.
    expect(fireEvent.click(screen.getByRole("link", { name: "Plain" }))).toBe(true);
  });

  it("carries the preview's query onto its links", () => {
    window.history.replaceState({}, "", "/m/campaigns/engagement/polls?demo=1");
    render(<WorkspaceStatusState title="Not here" body="Because." links={[{ label: "Back", path: "/m/campaigns" }]} />);
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/m/campaigns?demo=1");
  });
});


const desk = { queue: [], threads: [], broadcasts: [], formsInbox: [], kpis: { openRequests: 0, membersCovered: 0, awaitingReply: 0, broadcasts30d: 0 } };

function renderSteward(lang = "en", overrides = {}) {
  const api = {
    loadDesk: vi.fn().mockResolvedValue(desk),
    listEmailIntakes: vi.fn().mockResolvedValue([]),
    publish: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
  const onNotice = vi.fn();
  render(<LanguageProvider lang={lang}><StewardView data={{ member: { initials: "SO", chapterId: "chapter-1" } }} api={api} onNotice={onNotice} /></LanguageProvider>);
  return { api, onNotice };
}

async function draftBroadcast(title = "Contract vote Thursday", body = "Polls open at noon.") {
  const button = await screen.findByRole("button", { name: "Publish broadcast" });
  const form = button.closest("form");
  fireEvent.change(form.elements.title, { target: { value: title } });
  fireEvent.change(form.elements.body, { target: { value: body } });
  fireEvent.submit(form);
  return form;
}

describe("publishing a committee worker broadcast", () => {
  it("confirms first, stating who sees it and in which language, and publishes nothing yet", async () => {
    const { api } = renderSteward();
    await draftBroadcast();
    const dialog = await screen.findByTestId("broadcast-publish-confirm");
    expect(screen.getByRole("heading", { name: "Publish “Contract vote Thursday”?" })).toBeInTheDocument();
    expect(within(dialog).getByText("Workers in this notice's audience see it in Announcements.")).toBeInTheDocument();
    expect(within(dialog).getByText("It goes out in English. Workers who read Spanish see it marked as English.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Publish in English" })).toBeDisabled();
    expect(within(dialog).getByText("Choose how the Spanish version goes out to continue.")).toBeInTheDocument();
    expect(api.publish).not.toHaveBeenCalled();
  });

  it("requires the bilingual step: stopping to add Spanish first keeps the draft and sends nothing", async () => {
    const { api } = renderSteward();
    const form = await draftBroadcast();
    const dialog = await screen.findByTestId("broadcast-publish-confirm");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Stop and add the Spanish version first" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Back to the draft" }));
    await waitFor(() => expect(screen.queryByTestId("broadcast-publish-confirm")).toBeNull());
    expect(api.publish).not.toHaveBeenCalled();
    expect(form.elements.title.value).toBe("Contract vote Thursday");
  });

  // #7664: a refused audience asks for a new choice; any other failure keeps
  // the server's own message.
  it.each([
    ["an unavailable notice audience", Object.assign(new Error("Revoked"), { code: "notice_audience_unavailable" }), translate("en", "notices.audienceUnavailable")],
    ["any other publish failure", new Error("broadcast limit reached: 5 per committee worker per day"), "broadcast limit reached: 5 per committee worker per day"],
  ])("reports %s and keeps the draft", async (_name, failure, message) => {
    const { onNotice } = renderSteward("en", { publish: vi.fn().mockRejectedValue(failure) });
    const form = await draftBroadcast();
    const dialog = await screen.findByTestId("broadcast-publish-confirm");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Publish in English now and write the Spanish version next" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish in English" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(message));
    expect(form.elements.title.value).toBe("Contract vote Thursday");
  });

  it("publishes in the draft's language, then sets the composer to the other language", async () => {
    const { api, onNotice } = renderSteward();
    const form = await draftBroadcast();
    const dialog = await screen.findByTestId("broadcast-publish-confirm");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Publish in English now and write the Spanish version next" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish in English" }));
    await waitFor(() => expect(api.publish).toHaveBeenCalledWith("Contract vote Thursday", "Polls open at noon.", "en", undefined, expect.any(String)));
    await waitFor(() => expect(screen.queryByTestId("broadcast-publish-confirm")).toBeNull());
    expect(form.elements.locale.value).toBe("es");
    expect(form.elements.title.value).toBe("Contract vote Thursday");
    expect(onNotice).toHaveBeenCalledWith("Broadcast published. Now write the Spanish version: the composer is set to Spanish.");
  });

  it("cancels without publishing", async () => {
    const { api } = renderSteward();
    await draftBroadcast();
    const dialog = await screen.findByTestId("broadcast-publish-confirm");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("broadcast-publish-confirm")).toBeNull());
    expect(api.publish).not.toHaveBeenCalled();
  });

  it("reads in Spanish and pairs each language with the other", () => {
    expect(otherBroadcastLocale("en")).toBe("es");
    expect(otherBroadcastLocale("es")).toBe("en");
    expect(otherBroadcastLocale("fr")).toBe("es");
    expect(broadcastLanguageKey("fr")).toBe("broadcastConfirm.english");
    render(<LanguageProvider lang="es"><BroadcastPublishConfirm title="Votación" locale="es" onPublish={vi.fn()} onClose={vi.fn()} /></LanguageProvider>);
    expect(screen.getByRole("heading", { name: "¿Publicar «Votación»?" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Parar y agregar primero la versión en inglés" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publicar en español" })).toBeDisabled();
  });
});

// Record 8435: the confirm's Publish stays focusable while
// its owner publishes, and refuses a second press.
describe("broadcast publish confirm keeps focus while publishing", () => {
  it("keeps Publish focused while the owner publishes, and publishes once", async () => {
    const publish = vi.fn(async () => true);
    render(<LanguageProvider lang="en"><BusyTestHost>{(pending, run) => (
      <BroadcastPublishConfirm title="Vote" locale="en" busy={pending} onPublish={(...args) => run(() => publish(...args))} onClose={vi.fn()} />
    )}</BusyTestHost></LanguageProvider>);
    fireEvent.click(screen.getByRole("radio", { name: "Publish in English now and write the Spanish version next" }));
    await expectHeldWriteFocus(publish, screen.getByRole("button", { name: "Publish in English" }));
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe("votes against a vote's quorum", () => {
  const t = (key, values) => translate("en", key, values);
  it("reports the share of quorum past 100% and caps only the bar", () => {
    const reached = quorumProgress(828, 602);
    expect(reached).toEqual({ votes: 828, target: 602, percent: 138, bar: 100, reached: true });
    expect(quorumProgressText(t, reached)).toBe("Quorum reached: 828 votes, 602 needed");
    const short = quorumProgress(213, 300);
    expect(short).toMatchObject({ percent: 71, bar: 71, reached: false });
    expect(quorumProgressText(t, short)).toBe("213 of 300 votes needed for quorum");
  });

  it("gives no share without a quorum target", () => {
    expect(quorumProgress(40, 0)).toBeNull();
    expect(quorumProgress(40, null)).toBeNull();
    expect(quorumProgress(undefined, 10)).toMatchObject({ votes: 0, percent: 0, reached: false });
  });
});

describe("the campaign lead issue work hub", () => {
  it("links the chapter-backed campaign lead desk when the hub has no backing", async () => {
    const api = {
      loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.coordinatorDesk))),
      loadCases: vi.fn(async () => ({ cases: [], nextCursor: null })),
      loadChapterAppointments: vi.fn().mockResolvedValue({ rows: [], nextCursor: null, total: 0 }),
    };
    render(<LanguageProvider lang="en"><CoordinatorView data={{ roles: ["coordinator"], member: { initials: "JP" } }} api={api} onNotice={() => {}} onProfile={() => {}} /></LanguageProvider>);
    const heading = await screen.findByRole("heading", { name: "This issue work hub isn't connected to a campaign yet" });
    const state = heading.closest("[data-state-block]");
    expect(within(state).getByRole("link", { name: "Open the Issue queue" })).toHaveAttribute("href", "/m/coordinator");
    expect(within(state).getByRole("link", { name: "Open active issues" })).toHaveAttribute("href", "/m/coordinator/cases");
  });
});

describe("a bilingual broadcast pair finishes", () => {
  it("publishes English, then Spanish completes the pair and asks for no further version", async () => {
    const { api, onNotice } = renderSteward();
    const form = await draftBroadcast("Contract vote Thursday", "Polls open at noon.");
    let dialog = await screen.findByTestId("broadcast-publish-confirm");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Publish in English now and write the Spanish version next" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish in English" }));
    await waitFor(() => expect(api.publish).toHaveBeenCalledWith("Contract vote Thursday", "Polls open at noon.", "en", undefined, expect.any(String)));
    await waitFor(() => expect(form.elements.locale.value).toBe("es"));

    fireEvent.change(form.elements.title, { target: { value: "Votación del contrato el jueves" } });
    fireEvent.change(form.elements.body, { target: { value: "La votación abre al mediodía." } });
    fireEvent.submit(form);
    dialog = await screen.findByTestId("broadcast-publish-confirm");
    expect(within(dialog).getByText("This completes the pair: “Contract vote Thursday” is already published in English, so no further version is needed.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("radio")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish in Spanish" }));
    await waitFor(() => expect(api.publish).toHaveBeenLastCalledWith("Votación del contrato el jueves", "La votación abre al mediodía.", "es", undefined, expect.any(String)));
    await waitFor(() => expect(onNotice).toHaveBeenLastCalledWith("Both versions are published."));
    // Finished: an empty composer, not a third translation request.
    expect(form.elements.title.value).toBe("");
    expect(form.elements.body.value).toBe("");

    fireEvent.change(form.elements.title, { target: { value: "Next notice" } });
    fireEvent.change(form.elements.body, { target: { value: "Body." } });
    fireEvent.submit(form);
    dialog = await screen.findByTestId("broadcast-publish-confirm");
    expect(within(dialog).getAllByRole("radio")).toHaveLength(2);
  });
});

describe("analytics never shows a group the server released under 25", () => {
  const viewer = createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] });
  const org = viewer.organizationId;
  const chapter = (id, memberCount) => ({ organizationId: org, chapterId: id, chapterName: id, memberCount, protected: false, score: 70, trend: [] });
  const dataset = (id) => ({ organizationId: org, id: `chapter:${id}:health-trend`, label: `${id} health trend`, scope: "chapter", chapterId: id, rows: [{ label: "2026-10-01", value: 70 }] });
  const read = (overrides) => ({ organizationId: org, privacyThreshold: 25, members: [], chapterHealth: [chapter("large", 40), chapter("small", 15)], datasets: [dataset("large"), dataset("small")], layouts: [], ...overrides });

  it("refuses a workspace computed at a floor of 10 even when 25 is expected", () => {
    expect(composeAnalyticsWorkspace({ workspace: read({ privacyThreshold: 10 }), viewer, expectedFloor: 25 }))
      .toMatchObject({ state: "unavailable", reason: "privacy_floor_mismatch", datasets: [] });
    expect(composeAnalyticsWorkspace({ workspace: read({ privacyThreshold: 10 }), viewer }))
      .toMatchObject({ state: "unavailable", reason: "privacy_floor_mismatch" });
  });

  it("withholds the 15-member campaign's dataset, which carries no cohort proof of 25", () => {
    const result = composeAnalyticsWorkspace({ workspace: read(), viewer, expectedFloor: 25 });
    expect(result.state).toBe("ready");
    expect(result.datasets.map((row) => row.id)).toEqual(["chapter:large:health-trend"]);
  });
});

describe("the Pulse preview withholds rather than zeroes", () => {
  it("withholds the whole visible-cases chart when its counts sit under 25", async () => {
    const api = createPreviewPulseApi({ now: () => new Date("2026-11-03T12:00:00Z") });
    const read = await api.preview("steward", { version: 1, measure: "visible_cases", breakdown: "month", period: "12m", form: "bars" });
    expect(read).toMatchObject({ withheld: true, rows: [] });
    expect(read.unavailable).toBe(false);
  });
});

describe("an owed bilingual pair belongs to the broadcast it came from", () => {
  async function publishEnglishOwingSpanish(api) {
    const form = await draftBroadcast("Contract vote Thursday", "Polls open at noon.");
    const dialog = await screen.findByTestId("broadcast-publish-confirm");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Publish in English now and write the Spanish version next" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish in English" }));
    await waitFor(() => expect(api.publish).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(form.elements.locale.value).toBe("es"));
    return form;
  }

  it("publish English, load an unrelated Spanish draft, publish: the bilingual choice is asked and no pair is claimed", async () => {
    const { api, onNotice } = renderSteward("en", {
      listDrafts: vi.fn().mockResolvedValue([{ id: "draft-parking", title: "Estacionamiento cerrado", body: "El lote B cierra el lunes." }]),
    });
    const form = await publishEnglishOwingSpanish(api);
    fireEvent.click(await screen.findByRole("button", { name: "Use draft: Estacionamiento cerrado" }));
    expect(form.elements.title.value).toBe("Estacionamiento cerrado");
    expect(form.elements.locale.value).toBe("es");
    fireEvent.submit(form);
    const dialog = await screen.findByTestId("broadcast-publish-confirm");
    expect(within(dialog).queryByText(/This completes the pair/)).toBeNull();
    expect(within(dialog).getAllByRole("radio")).toHaveLength(2);
    expect(within(dialog).getByRole("button", { name: "Publish in Spanish" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Publish in Spanish now and write the English version next" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish in Spanish" }));
    await waitFor(() => expect(api.publish).toHaveBeenLastCalledWith("Estacionamiento cerrado", "El lote B cierra el lunes.", "es", undefined, expect.any(String)));
    expect(onNotice).not.toHaveBeenCalledWith("Both versions are published.");
  });

  it("lets the committee worker set the owed pair aside for a different announcement", async () => {
    const { api, onNotice } = renderSteward();
    const form = await publishEnglishOwingSpanish(api);
    fireEvent.change(form.elements.title, { target: { value: "Reunión de seguridad" } });
    fireEvent.change(form.elements.body, { target: { value: "El martes a las 5." } });
    fireEvent.submit(form);
    let dialog = await screen.findByTestId("broadcast-publish-confirm");
    fireEvent.click(within(dialog).getByRole("button", { name: "This is a different announcement" }));
    dialog = screen.getByTestId("broadcast-publish-confirm");
    expect(within(dialog).queryByText(/This completes the pair/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Stop and add the English version first" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Back to the draft" }));
    await waitFor(() => expect(screen.queryByTestId("broadcast-publish-confirm")).toBeNull());
    expect(api.publish).toHaveBeenCalledTimes(1);
    // The owed Spanish version of the first broadcast is still owed.
    fireEvent.submit(form);
    dialog = await screen.findByTestId("broadcast-publish-confirm");
    expect(within(dialog).getByText(/“Contract vote Thursday” is already published in English/)).toBeInTheDocument();
    expect(onNotice).not.toHaveBeenCalledWith("Both versions are published.");
  });
});
