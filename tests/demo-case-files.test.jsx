import { confirmEvidenceUpload } from "./helpers/confirm-evidence-upload.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { primeDemoData } from "../src/data/demoData.js";

// The member case document vault under the session-only demo twin: uploads
// live in an in-memory blob map (demoFileBlobsRef) rather than a bucket, so
// "open" must still work without any network call, and a case seeded with a
// file row that was never routed through that map (the honesty scenario for
// a demo account that "arrives" with a document already attached) must fail
// visibly instead of silently opening nothing.
beforeEach(() => {
  window.scrollTo = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  primeDemoData(fallbackData);
});

describe("demo case document vault", () => {
  it("attaches, opens, and removes a document without a live bucket", async () => {
    const popup = { location: "", opener: window, close: vi.fn() };
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => popup);
    window.history.replaceState({}, "", "/m/cases");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Supervisor meeting with no stated reason/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("No documents attached yet.")).toBeInTheDocument();
    const upload = within(dialog).getByLabelText("Add a document");
    const file = new File(["evidence"], "writeup.pdf", { type: "application/pdf" });
    fireEvent.change(upload, { target: { files: [file] } });
    await confirmEvidenceUpload();
    await screen.findByText("Issue document attached");
    expect(within(dialog).getByText("writeup.pdf")).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /^Open(?:: |$)/ })).toBeEnabled());
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /^Open(?:: |$)/ })).not.toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(within(dialog).getByRole("button", { name: /^Open(?:: |$)/ }));
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    expect(openSpy).toHaveBeenCalledWith("", "_blank");
    await waitFor(() => expect(popup.location).toMatch(/^blob:/));
    expect(popup.opener).toBeNull();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /^Remove(?:: |$)/ })).not.toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(within(dialog).getByRole("button", { name: /^Remove(?:: |$)/ }));
    await screen.findByText("Issue document removed");
    expect(within(dialog).getByText("No documents attached yet.")).toBeInTheDocument();
    openSpy.mockRestore();
  });

  it("reports a preview document unavailable when it never rode the session blob map", async () => {
    const popup = { location: "", opener: window, close: vi.fn() };
    vi.spyOn(window, "open").mockImplementation(() => popup);
    const seeded = {
      ...fallbackData,
      cases: fallbackData.cases.map((item) => (item.id === "b872b7c3-fdf2-497e-9d91-5b456724a1f0"
        ? { ...item, files: [{ id: "seed-file-1", filename: "seeded.pdf", mimeType: "application/pdf", sizeBytes: 10, createdAt: "2026-06-01T00:00:00Z" }] }
        : item)),
    };
    primeDemoData(seeded);
    window.history.replaceState({}, "", "/m/cases");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Supervisor meeting with no stated reason/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Open(?:: |$)/ }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This preview document is not available in this browser.");
    expect(popup.opener).toBeNull();
    expect(popup.close).toHaveBeenCalledTimes(1);
  });
});
