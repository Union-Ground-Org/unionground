import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Assistant } from "../src/components/FloatingControls.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { createSessionGuard } from "../src/lib/sessionGuard.js";

// #7831: a failure belongs to the conversation that asked, even when search
// or ordinary history changes the selected transcript before it settles.
describe("Compass conversation-scoped failures", () => {
  const threads = [
    { id: "a", title: "Conversation A", messages: [{ id: "a1", role: "assistant", body: "Saved answer A" }] },
    { id: "b", title: "Conversation B", messages: [{ id: "b-match", role: "assistant", body: "Matched answer B" }] },
  ];
  const failures = [
    ["network", () => new TypeError("Private network detail"), "guide.errorAnswer"],
    ["withheld", () => Object.assign(new Error("Private withheld detail"), { code: "question_withheld" }), "guide.errorQuestionWithheld"],
  ];

  function setup(lang, extra = {}) {
    let rejectA;
    const onSend = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { rejectA = reject; }))
      .mockResolvedValue("b");
    const wrap = (props = {}) => <LanguageProvider lang={lang}><Assistant threads={threads} onClose={vi.fn()} onSend={onSend} {...extra} {...props} /></LanguageProvider>;
    const view = render(wrap());
    const composer = screen.getByRole("textbox", { name: t(lang, "compass.askAria") });
    composer.focus();
    fireEvent.change(composer, { target: { value: "Pending question A" } });
    fireEvent.submit(composer.closest("form"));
    expect(onSend).toHaveBeenCalledWith("Pending question A", "a", threads[0].messages, undefined);
    const selectB = (via) => {
      if (via === "search") view.rerender(wrap({ searchTarget: { guideThreadId: "b", messageId: "b-match" } }));
      else {
        fireEvent.click(screen.getByRole("button", { name: t(lang, "guide.openConversations") }));
        fireEvent.click(screen.getByRole("button", { name: "Conversation B" }));
      }
      expect(screen.getByRole("dialog").querySelector("header strong")).toHaveTextContent("Conversation B");
      composer.focus();
      fireEvent.change(composer, { target: { value: "Unsent draft B" } });
    };
    return { composer, onSend, selectB, rejectA: (error) => act(async () => { rejectA(error); }) };
  }

  for (const lang of ["en", "es"]) {
    for (const via of ["search", "history"]) {
      it.each(failures)(`ignores A's late %s failure after ${via} selects B (${lang})`, async (_, failure) => {
        const { composer, onSend, selectB, rejectA } = setup(lang);
        selectB(via);
        const chat = screen.getByRole("region", { name: t(lang, "guide.conversation") });
        const messages = chat.querySelectorAll("[data-guide-message-id]");
        expect(within(chat).getByText("Matched answer B")).toBeInTheDocument();
        expect(chat.querySelector('[data-guide-message-id="b-match"]')).toBe(messages[0]);
        await rejectA(failure());

        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(screen.queryByText(t(lang, "compass.thinking"))).not.toBeInTheDocument();
        expect(screen.queryByText("Pending question A")).not.toBeInTheDocument();
        expect(screen.queryByText("Saved answer A")).not.toBeInTheDocument();
        expect(chat.querySelectorAll("[data-guide-message-id]")).toHaveLength(1);
        expect(within(chat).getByText("Matched answer B")).toBeInTheDocument();
        expect(composer).toHaveValue("Unsent draft B");
        expect(composer).toHaveFocus();
        expect(composer).toBeEnabled();
        expect(screen.getByRole("button", { name: t(lang, "guide.send") })).toBeEnabled();

        fireEvent.submit(composer.closest("form"));
        expect(onSend).toHaveBeenLastCalledWith("Unsent draft B", "b", threads[1].messages, undefined);
        await act(async () => {});
        expect(onSend).toHaveBeenCalledTimes(2);
        expect(composer).toHaveValue("");
        expect(composer).toHaveFocus();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      });
    }

    it.each(failures)(`keeps the active conversation's %s error visible (${lang})`, async (_, failure, key) => {
      const { composer, rejectA } = setup(lang);
      await rejectA(failure());
      expect(screen.getByRole("alert")).toHaveTextContent(t(lang, key));
      expect(composer).toHaveValue("Pending question A");
      expect(composer).toHaveFocus();
      expect(composer).toBeEnabled();
    });

    it(`honors a global pause even after search selects B (${lang})`, async () => {
      const { composer, onSend, selectB, rejectA } = setup(lang);
      selectB("search");
      await rejectA(Object.assign(new Error("Private pause detail"), { code: "compass_paused" }));
      expect(screen.getByRole("status")).toHaveTextContent(t(lang, "compass.pausedNotice"));
      expect(composer).toBeDisabled();
      expect(composer).toHaveValue("Unsent draft B");
      fireEvent.submit(composer.closest("form"));
      expect(onSend).toHaveBeenCalledOnce();
      expect(screen.getByText("Matched answer B")).toBeInTheDocument();
    });

    it(`ignores even a pause from a superseded session after search selects B (${lang})`, async () => {
      const guard = createSessionGuard();
      guard.beginSession("member-a");
      const { composer, selectB, rejectA } = setup(lang, { sessionOperation: guard.captureOperation("member-a") });
      selectB("search");
      guard.beginSession("member-b");
      await rejectA(Object.assign(new Error("Private old-session detail"), { code: "compass_paused" }));
      expect(screen.queryByText(t(lang, "compass.pausedNotice"))).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(composer).toBeEnabled();
      expect(composer).toHaveValue("Unsent draft B");
    });

    it(`keeps a late degraded result out of a search-selected B (${lang})`, async () => {
      const { composer, selectB, rejectA } = setup(lang);
      selectB("search");
      await rejectA(Object.assign(new Error("Private degraded detail"), {
        code: "compass_degraded", degraded: "gateway_timeout",
        sources: [{ id: "kb:a", title: "Article from A", kind: "contract", ref: "Article A" }],
      }));
      expect(document.querySelector(".guide2-msg--degraded")).toBeNull();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(composer).toHaveValue("Unsent draft B");
      expect(composer).toHaveFocus();
      expect(screen.getByText("Matched answer B")).toBeInTheDocument();
    });
  }
});
