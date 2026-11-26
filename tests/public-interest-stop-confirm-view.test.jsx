import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicInterestStopConfirmView } from "../src/views/PublicInterestStopConfirmView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

// SEC-UG-PUBLIC-INTEREST-SUPPRESSION-CONFIRMATION-20260921 (owner ruling
// 2026-09-25): the emailed single-use link lands on /stop-updates, which scrubs
// its fragment, posts the token once and never claims a stop it did not get.
// A shape-valid, obviously non-secret token: 43 URL-safe characters.
const TOKEN = "stop-confirm-proof-".padEnd(43, "x");

afterEach(() => {
  vi.unstubAllGlobals();
});

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) };
}

function renderView({ url = `/stop-updates#confirm=${TOKEN}`, fetcher, lang = "en" } = {}) {
  window.history.replaceState({}, "", url);
  render(
    <LanguageProvider lang={lang}>
      <PublicInterestStopConfirmView fetcher={fetcher} />
    </LanguageProvider>,
  );
}

describe("fragment-only public-interest stop confirmation view", () => {
  it("scrubs the secret before posting it once and reports the confirmed stop", async () => {
    let resolveFetch;
    const fetcher = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    renderView({ fetcher });

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe("/stop-updates");
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(fetcher).toHaveBeenCalledWith("/api/public-interest-stop-confirm", expect.objectContaining({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      body: JSON.stringify({ token: TOKEN }),
    }));
    expect(screen.getByRole("status")).toHaveTextContent("Confirming your request");

    resolveFetch(response({ confirmed: true }));
    expect(await screen.findByRole("status")).toHaveTextContent("Public updates stopped");
    expect(screen.getByRole("status")).toHaveTextContent("blocked from being added again");
    expect(screen.getByRole("link", { name: "Back to Union Ground" })).toHaveAttribute("href", "/");
  });

  it("refuses and scrubs query-string tokens without sending a request", async () => {
    const fetcher = vi.fn();
    renderView({ url: `/stop-updates?token=${TOKEN}#confirm=${TOKEN}`, fetcher });
    expect(await screen.findByRole("alert")).toHaveTextContent("This confirmation link is no longer available");
    expect(fetcher).not.toHaveBeenCalled();
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe("/stop-updates");
  });

  it("explains the two outcomes for an expired or used link without implying the earlier confirmation failed", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ error: "confirmation-unavailable" }, 410));
    renderView({ fetcher });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("no longer available");
    expect(alert).toHaveTextContent("If you already confirmed with this link, your public updates are stopped");
    expect(alert).toHaveTextContent("Otherwise it expired 24 hours after it was sent and nothing was changed");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("requests a fresh confirmation without sending the old token or a session credential", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ accepted: true }));
    renderView({ url: "/stop-updates", fetcher });
    await screen.findByRole("alert");
    const email = screen.getByLabelText("Email to remove");
    fireEvent.change(email, { target: { value: "Worker@Example.invalid" } });
    const form = email.closest("form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    const confirmation = await screen.findByRole("status");
    expect(confirmation).toHaveTextContent("Check your email to confirm");
    expect(confirmation).toHaveTextContent("nothing changes until you do");
    expect(confirmation).toHaveFocus();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/public-interest-stop", expect.objectContaining({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      body: JSON.stringify({ email: "worker@example.invalid", locale: "en", website: "" }),
    }));
  });

  it("offers a retry after a transient failure and keeps the token for it", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ error: "confirmation-unavailable" }, 503))
      .mockResolvedValueOnce(response({ confirmed: true }));
    renderView({ fetcher });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We couldn't confirm your request");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Public updates stopped");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1].body).toBe(JSON.stringify({ token: TOKEN }));
  });

  it("uses the page's own fetch by default and treats an unreadable body as a retryable failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: vi.fn().mockRejectedValue(new Error("not json")) });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/stop-updates#confirm=${TOKEN}`);
    render(<LanguageProvider lang="en"><PublicInterestStopConfirmView /></LanguageProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't confirm your request");
    expect(fetchMock).toHaveBeenCalledWith("/api/public-interest-stop-confirm", expect.objectContaining({ method: "POST" }));
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ token: TOKEN }));
  });

  it("renders the Spanish copy", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ confirmed: true }));
    renderView({ fetcher, lang: "es" });
    expect(await screen.findByRole("status")).toHaveTextContent("Novedades públicas detenidas");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Detener las novedades públicas de Union Ground");
  });
});
