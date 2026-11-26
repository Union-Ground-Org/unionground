import { StrictMode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { deviceParityValue } from "../src/lib/deviceParity.js";
import { ProductHubView } from "../src/views/ProductHubView.jsx";

const thread = {
  id: "thread-1", title: "Overtime scheduling", kind: "issue", status: "open",
  posts: [{ id: "post-1", body: "Initial report", created_at: "2026-07-27T12:00:00Z" }],
};
const data = {
  member: { id: "user-1", initials: "MV", fullName: "Member Voice" },
  roles: ["steward"], conversations: [], broadcasts: [],
  product: {
    spaces: [{ id: "space-1", name: "Workplace issues", description: "Ongoing issues", visibility: "chapter", threads: [thread] }],
    documents: [], records: [], intake: [], handshakes: [], governance: [], partnerOrgs: [],
  },
};

function hub(onUpdateSpace = vi.fn()) {
  return <StrictMode><LanguageProvider lang="en"><ProductHubView data={data} onUpdateSpace={onUpdateSpace} onSendPost={vi.fn()} /></LanguageProvider></StrictMode>;
}

function deferredSave() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve, onUpdateSpace: vi.fn(() => promise) };
}

describe("hub space save lifecycle", () => {
  it("keeps a remounted hub's topic open when the old space save finishes", async () => {
    const save = deferredSave();
    const first = render(hub(save.onUpdateSpace));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save.onUpdateSpace).toHaveBeenCalledOnce();
    first.unmount();

    render(hub());
    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    const currentDialog = deviceParityValue("hub.dialog");
    expect(screen.getByText("Initial report")).toBeInTheDocument();

    await act(async () => { save.resolve({}); await save.promise; });
    expect(screen.getByText("Initial report")).toBeInTheDocument();
    expect(deviceParityValue("hub.dialog")).toEqual(currentDialog);
  });

  it("still closes a mounted editor and its paired view after a successful save", async () => {
    const save = deferredSave();
    const first = render(hub(save.onUpdateSpace));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const paired = render(hub());
    // Modal isolation hides the peer tree in this shared test document.
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(2);
    fireEvent.click(within(first.container).getByRole("button", { name: "Save", hidden: true }));
    expect(save.onUpdateSpace).toHaveBeenCalledWith("space-1", expect.objectContaining({ name: "Workplace issues" }), false);
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(2);

    await act(async () => { save.resolve({}); await save.promise; });
    expect(within(first.container).queryByRole("dialog", { hidden: true })).not.toBeInTheDocument();
    expect(within(paired.container).queryByRole("dialog", { hidden: true })).not.toBeInTheDocument();
    expect(deviceParityValue("hub.dialog")).toBeNull();
  });
});
