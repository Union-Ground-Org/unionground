import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdminView } from "../src/views/AdminView.jsx";
import { AdvisorView } from "../src/views/AdvisorView.jsx";
import { VpView } from "../src/views/VpView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { t } from "../src/lib/i18n.js";

// A11Y-UG-WEB-VP-ADVISOR-ADMIN-PLANES-SILENT-WHILE-LOADING-20260920:
// the VP, advisor and admin planes must say they are loading, as a status
// line, for the whole desk read and for the whole Try again retry.

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function adminApi(loadDesk) {
  return {
    loadDesk,
    grantRole: vi.fn().mockResolvedValue({ granted: true }),
    revokeRole: vi.fn().mockResolvedValue({ revoked: true }),
    searchMembers: vi.fn().mockResolvedValue([]),
    loadFormTemplates: vi.fn().mockResolvedValue([]),
    loadFailedLoginInbox: vi.fn().mockResolvedValue({ items: [], openLast24Hours: 0, attentionThreshold: 5 }),
    loadAdministrativeEvidence: vi.fn().mockResolvedValue({
      fieldNoteBlocks: [], packets: [], actions: [], history: [],
    }),
  };
}

const PLANES = [
  {
    name: "vp",
    key: "vp.loading",
    desk: () => JSON.parse(JSON.stringify(fallbackData.vpOverview)),
    api: (loadDesk) => ({ loadDesk, markReviewed: vi.fn() }),
    render: (api) => <VpView data={{ member: { initials: "TM" } }} api={api} />,
  },
  {
    name: "advisor",
    key: "advisor.loading",
    desk: () => JSON.parse(JSON.stringify(fallbackData.advisorDesk)),
    api: (loadDesk) => ({ loadDesk }),
    render: (api) => <AdvisorView data={{ member: { initials: "CL" } }} api={api} />,
  },
  {
    name: "admin",
    key: "admin.loading",
    desk: () => JSON.parse(JSON.stringify(fallbackData.adminDesk)),
    api: adminApi,
    render: (api) => <AdminView data={{ member: { initials: "AR", chapterName: "Harborview Care United", organizationRoles: ["admin"] } }} api={api} onNotice={vi.fn()} />,
  },
];

function renderPlane(plane, lang, loadDesk) {
  const api = plane.api(loadDesk);
  render(<LanguageProvider lang={lang}>{plane.render(api)}</LanguageProvider>);
  return api;
}

describe.each(PLANES)("$name plane desk loading status", (plane) => {
  it.each(["en", "es"])("announces the first desk read as a catalogue status line (%s)", async (lang) => {
    const read = deferred();
    renderPlane(plane, lang, vi.fn(() => read.promise));

    const status = screen.getByText(t(lang, plane.key));
    expect(status).toHaveAttribute("role", "status");
    expect(screen.queryByRole("button", { name: t(lang, "app.tryAgain") })).not.toBeInTheDocument();

    await act(async () => { read.resolve(plane.desk()); });
    expect(screen.queryByText(t(lang, plane.key))).not.toBeInTheDocument();
  });

  it("announces the Try again retry and never shows the status beside the failure card", async () => {
    const first = deferred();
    const retry = deferred();
    const loadDesk = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    renderPlane(plane, "en", loadDesk);

    await act(async () => { first.reject(new Error("denied")); });
    expect(screen.getByText(t("en", "app.loadFailed"))).toBeInTheDocument();
    expect(screen.queryByText(t("en", plane.key))).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: t("en", "app.tryAgain") }));
    expect(screen.getByText(t("en", plane.key))).toHaveAttribute("role", "status");
    expect(screen.queryByText(t("en", "app.loadFailed"))).not.toBeInTheDocument();

    await act(async () => { retry.resolve(plane.desk()); });
    expect(loadDesk).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(t("en", plane.key))).not.toBeInTheDocument();
  });

  it("keeps the translated failure card and its Try again button on a rejected read (es)", async () => {
    const read = deferred();
    renderPlane(plane, "es", vi.fn(() => read.promise));
    await act(async () => { read.reject(new Error("denied")); });
    expect(screen.getByText(t("es", "app.loadFailed"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("es", "app.tryAgain") })).toBeInTheDocument();
    expect(screen.queryByText(t("es", plane.key))).not.toBeInTheDocument();
  });
});
