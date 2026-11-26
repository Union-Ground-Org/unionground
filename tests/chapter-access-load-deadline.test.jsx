//: the demo walk of Nov 24, 2026 found Member >
// Forms showing "Loading access…" under each draft for minutes. The draft
// sharing panel, and the three other chapter access panels built the same way,
// waited on their first read with no deadline. A read that never answers now
// ends, after the shared load deadline, in the panel's own could-not-load line
// with its Try again, in English and Spanish.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { SHELL_LOAD_DEADLINE_MS } from "../src/lib/loadDeadline.js";
import { t as translate } from "../src/lib/i18n.js";
import { ChapterAccessPanel } from "../src/features/chapterAccess/ChapterAccessPanel.jsx";
import { ChapterOfficePanel } from "../src/features/chapterAccess/ChapterOfficePanel.jsx";
import { DraftSharingPanel } from "../src/features/chapterAccess/DraftSharingPanel.jsx";
import { UnitSettingsPanel } from "../src/features/chapterAccess/UnitSettingsPanel.jsx";

vi.mock("../src/lib/chapterAccessApi.js", async (original) => ({ ...(await original()), createChapterAccessApi: (client) => client?.access || null }));
vi.mock("../src/lib/unitSettings.js", async (original) => ({ ...(await original()), createUnitSettingsApi: (client) => client?.unitSettings || null }));
vi.mock("../src/lib/memberApi.js", () => ({ listMyMemberNotices: vi.fn(), getMemberNoticeReceipts: vi.fn(), listAnnouncementDrafts: vi.fn(), resolveAnnouncementDraft: vi.fn() }));

const never = () => new Promise(() => {});
const wrap = (node, lang) => <LanguageProvider lang={lang}>{node}</LanguageProvider>;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function pastDeadline() {
  await act(async () => { await vi.advanceTimersByTimeAsync(SHELL_LOAD_DEADLINE_MS + 1); });
}

describe("a chapter access read that never answers", () => {
  for (const lang of ["en", "es"]) {
    it(`ends the draft sharing panel's loading line in a failure with Try again (${lang})`, async () => {
      const sharing = vi.fn(never).mockImplementationOnce(never).mockResolvedValue([]);
      render(wrap(<DraftSharingPanel api={{ sharing, share: vi.fn() }} formId="f" />, lang));
      expect(screen.getByRole("status")).toHaveTextContent(translate(lang, "access.loading"));
      await pastDeadline();
      expect(screen.queryByText(translate(lang, "access.loading"))).not.toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent(translate(lang, "access.shareLoadError"));
      fireEvent.click(screen.getByRole("button", { name: translate(lang, "access.retry") }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(sharing).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("status")).toHaveTextContent(translate(lang, "access.shareNoSteward"));
    });
  }

  it("ends the chapter access panel's loading line", async () => {
    render(wrap(<ChapterAccessPanel client={{ access: { load: vi.fn(never) } }} chapterId="ch" />, "en"));
    await pastDeadline();
    expect(screen.queryByText("Loading access…")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(translate("en", "access.error"));
  });

  it("ends the chapter office panel's loading line, for the office read and for its documents read", async () => {
    const first = render(wrap(<ChapterOfficePanel client={{ access: { office: vi.fn(never), documents: vi.fn() } }} chapterId="ch" />, "en"));
    await pastDeadline();
    expect(screen.getByRole("alert")).toHaveTextContent(translate("en", "access.error"));
    first.unmount();
    const office = { chapterId: "ch", scopes: [], documents: true, notices: false };
    render(wrap(<ChapterOfficePanel client={{ access: { office: vi.fn(async () => office), documents: vi.fn(never) } }} chapterId="ch" />, "en"));
    await pastDeadline();
    expect(screen.queryByText("Loading access…")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(translate("en", "access.error"));
  });

  it("ends the unit settings panel's loading line", async () => {
    render(wrap(<UnitSettingsPanel api={{ loadEditor: vi.fn(never) }} chapterId="chapter" />, "es"));
    await pastDeadline();
    expect(screen.queryByText(translate("es", "access.loading"))).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(translate("es", "unitSettings.loadError"));
  });
});
