import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DraftSharingPanel } from "../src/features/chapterAccess/DraftSharingPanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { FormsView } from "../src/views/FormsView.jsx";

// BUG-UG-FORMS-SHARE-DRAFT-BUTTON-SITS-ABOVE-THE-WRONG-STEWARD-20261122
// (#9555): at phone width each steward row put its Share button above its own
// name (.institutional-actions turns column-reverse there), so a name read as
// the label of the next row's button, and every button was named just Share.
// Fictional Tamarack stewards only.

const stewards = [{ id: "s-1", name: "Dylan Kowalski", shared: false }, { id: "s-2", name: "Megan Santiago", shared: true }];
const show = (lang, view) => render(<LanguageProvider lang={lang}>{view}</LanguageProvider>);

describe.each(["en", "es"])("sharing a draft with a steward, in %s", (lang) => {
  it("names the steward inside each control, one row per steward", async () => {
    const { container } = show(lang, <DraftSharingPanel api={{ sharing: vi.fn().mockResolvedValue(stewards), share: vi.fn() }} formId="f" />);
    const share = await screen.findByRole("button", { name: t(lang, "access.shareWith", { name: "Dylan Kowalski" }) });
    const stop = screen.getByRole("button", { name: t(lang, "access.unshareWith", { name: "Megan Santiago" }) });
    const rows = [...container.querySelectorAll(".draft-share__list > li")];
    expect(rows.map((row) => row.textContent)).toEqual([share.textContent, stop.textContent]);
    // The action-bar layout that reversed each row at phone width is gone.
    expect(container.querySelector(".institutional-actions")).toBeNull();
  });

  it("folds the list under one control per draft, inside a padded block", async () => {
    const { container } = show(lang, <DraftSharingPanel api={{ sharing: vi.fn().mockResolvedValue(stewards), share: vi.fn() }} formId="f" />);
    await screen.findByRole("button", { name: t(lang, "access.shareWith", { name: "Dylan Kowalski" }) });
    const details = container.querySelector("section.draft-share > details");
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector(".draft-share__list")).not.toBeNull();
  });

  it("says who a shared draft is shared with on the closed control, without a click", async () => {
    const many = [...stewards, { id: "s-3", name: "Ana Ruiz", shared: true }];
    const { container } = show(lang, <DraftSharingPanel api={{ sharing: vi.fn().mockResolvedValue(many), share: vi.fn() }} formId="f" />);
    await screen.findByRole("button", { name: t(lang, "access.shareWith", { name: "Dylan Kowalski" }) });
    const summary = container.querySelector("section.draft-share > details:not([open]) > summary");
    const names = new Intl.ListFormat(lang, { type: "conjunction" }).format(["Megan Santiago", "Ana Ruiz"]);
    expect(summary.textContent).toBe(t(lang, "access.shareTitle") + t(lang, "access.sharedWith", { names }));
    const none = show(lang, <DraftSharingPanel api={{ sharing: vi.fn().mockResolvedValue([{ ...stewards[0] }]), share: vi.fn() }} formId="g" />);
    await waitFor(() => expect(none.container.querySelector("summary")?.textContent).toBe(t(lang, "access.shareTitle")));
  });

  it("shows loading, a failed read with Try again and a failed save outside the fold", async () => {
    let fail;
    const api = { sharing: vi.fn(() => new Promise((_resolve, reject) => { fail = reject; })), share: vi.fn().mockRejectedValue(Error("refused")) };
    const { container } = show(lang, <DraftSharingPanel api={api} formId="f" />);
    expect(screen.getByRole("status")).toHaveTextContent(t(lang, "access.loading"));
    expect(screen.getByRole("status").closest("details")).toBeNull();
    await act(async () => fail(Error("offline")));
    const retry = screen.getByRole("button", { name: t(lang, "access.retry") });
    expect(retry.closest("details")).toBeNull();
    expect(container.querySelector("details")).toBeNull();
    api.sharing.mockResolvedValue(stewards);
    fireEvent.click(retry);
    fireEvent.click(await screen.findByRole("button", { name: t(lang, "access.shareWith", { name: "Dylan Kowalski" }) }));
    const saveError = await screen.findByText(t(lang, "access.shareSaveError"));
    expect(saveError.closest("details")).toBeNull();
  });

  it("keeps the list open after a share re-reads it, so a second steward needs no second open", async () => {
    let list = stewards.map((steward) => ({ ...steward, shared: false }));
    let release;
    const reads = [async () => list.map((steward) => ({ ...steward })), () => new Promise((resolve) => { release = () => resolve(list.map((steward) => ({ ...steward }))); })];
    const api = { sharing: vi.fn(() => reads.shift()()), share: vi.fn(async (_form, id, shared) => { list = list.map((steward) => (steward.id === id ? { ...steward, shared } : steward)); }) };
    const { container } = show(lang, <DraftSharingPanel api={api} formId="f" />);
    fireEvent.click(await screen.findByText(t(lang, "access.shareTitle"), { selector: "summary" }));
    await waitFor(() => expect(container.querySelector("details").open).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: t(lang, "access.shareWith", { name: "Dylan Kowalski" }) }));
    // During the re-read the names are cleared: loading shows and the fold is gone.
    await screen.findByText(t(lang, "access.loading"));
    expect(container.querySelector("details")).toBeNull();
    await act(async () => release());
    const second = await screen.findByRole("button", { name: t(lang, "access.shareWith", { name: "Megan Santiago" }) });
    expect(container.querySelector("details").open).toBe(true);
    expect(second).toBeVisible();
  });

  // A save whose reply is lost (a dropped connection, a
  // timeout) may still have reached the server. The list is read again, so
  // the rows and the closed line show what is shared now, beside a message
  // that says the change could not be confirmed.
  it.each([
    ["a share", "Dylan Kowalski", "access.shareWith", "access.unshareWith", ["Dylan Kowalski", "Megan Santiago"]],
    ["a stop", "Megan Santiago", "access.unshareWith", "access.shareWith", []],
  ])("after %s whose reply was lost, shows the list as the server has it now", async (_kind, name, before, after, sharedNow) => {
    let list = stewards.map((steward) => ({ ...steward }));
    const api = {
      sharing: vi.fn(async () => list.map((steward) => ({ ...steward }))),
      share: vi.fn(async (_form, id, shared) => { list = list.map((steward) => (steward.id === id ? { ...steward, shared } : steward)); throw Error("reply lost"); }),
    };
    const { container } = show(lang, <DraftSharingPanel api={api} formId="f" />);
    fireEvent.click(await screen.findByText(t(lang, "access.shareTitle"), { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: t(lang, before, { name }) }));
    const alert = await screen.findByText(t(lang, "access.shareSaveError"));
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert.closest("details")).toBeNull();
    expect(screen.getByRole("button", { name: t(lang, after, { name }) })).toBeVisible();
    expect(container.querySelector("details").open).toBe(true);
    const names = new Intl.ListFormat(lang, { type: "conjunction" }).format(sharedNow);
    expect(container.querySelector("summary").textContent).toBe(t(lang, "access.shareTitle") + (sharedNow.length ? t(lang, "access.sharedWith", { names }) : ""));
    expect(screen.queryByText(t(lang, "access.saveError"))).toBeNull();
  });

  it("after a failed save whose list cannot be read again, hides the old list and offers Try again", async () => {
    const api = { sharing: vi.fn().mockResolvedValueOnce(stewards).mockRejectedValueOnce(Error("offline")).mockResolvedValue(stewards), share: vi.fn().mockRejectedValue(Error("offline")) };
    const { container } = show(lang, <DraftSharingPanel api={api} formId="f" />);
    fireEvent.click(await screen.findByRole("button", { name: t(lang, "access.shareWith", { name: "Dylan Kowalski" }) }));
    expect(await screen.findByText(t(lang, "access.shareSaveUnknown"))).toHaveAttribute("role", "alert");
    expect(container.querySelector("details")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t(lang, "access.retry") }));
    await screen.findByRole("button", { name: t(lang, "access.shareWith", { name: "Dylan Kowalski" }) });
    expect(screen.queryByText(t(lang, "access.shareSaveUnknown"))).toBeNull();
  });

  it("drops a recovery read that answers after the person moved to another draft", async () => {
    let release;
    const api = { sharing: vi.fn().mockResolvedValueOnce(stewards).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })).mockResolvedValue([{ id: "s-3", name: "Ana Ruiz", shared: false }]), share: vi.fn().mockRejectedValue(Error("reply lost")) };
    const view = show(lang, <DraftSharingPanel api={api} formId="f" />);
    fireEvent.click(await screen.findByRole("button", { name: t(lang, "access.shareWith", { name: "Dylan Kowalski" }) }));
    await waitFor(() => expect(api.sharing).toHaveBeenCalledTimes(2));
    view.rerender(<LanguageProvider lang={lang}><DraftSharingPanel api={api} formId="g" /></LanguageProvider>);
    await screen.findByRole("button", { name: t(lang, "access.shareWith", { name: "Ana Ruiz" }) });
    await act(async () => release(stewards.map((steward) => ({ ...steward, shared: true }))));
    expect(screen.queryByText("Dylan Kowalski", { exact: false })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says why a health and leave draft cannot be shared instead of showing nothing", () => {
    const draft = { id: "health", templateKey: "fmla_self", status: "draft", step: 0, answers: {}, cosigners: [] };
    const sharing = vi.fn();
    show(lang, <FormsView data={{ member: { initials: "FT" }, forms: [draft] }} draftSharingApi={{ sharing, share: vi.fn() }} onSaveDraft={vi.fn()} />);
    expect(screen.getByText(t(lang, "access.shareSealed"))).toBeInTheDocument();
    expect(sharing).not.toHaveBeenCalled();
  });
});
