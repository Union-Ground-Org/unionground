import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RequestInviteView } from "../src/views/RequestInviteView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { afterRenderingUpdate, enableFocusFixup } from "./helpers/focusFixup.js";

function reply(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) };
}

function renderPage({ fetcher, lang = "en" } = {}) {
  return render(
    <LanguageProvider lang={lang}>
      <RequestInviteView fetcher={fetcher} />
    </LanguageProvider>,
  );
}

function fill() {
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Alex Rivera" } });
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "alex@example.org" } });
  fireEvent.change(screen.getByLabelText("Campaign or workplace"), { target: { value: "Example Local 12" } });
  fireEvent.change(screen.getByLabelText("Anything we should know? (optional)"), { target: { value: "Steward" } });
}

describe("Request an invite page", () => {
  it.each([
    ["en", "If your campaign already uses Union Ground, ask your campaign administrator to invite you.", "Full name"],
    ["es", "Si tu campaña ya usa Union Ground, pide a tu administración de campaña que te invite.", "Nombre completo"],
  ])("tells members of existing organizations to ask their administrator before the form (%s)", (lang, sentence, nameLabel) => {
    renderPage({ lang });
    const intro = screen.getByText(new RegExp(`^${sentence}`));
    const field = screen.getByLabelText(nameLabel);
    expect(intro.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("posts the request without credentials and confirms it", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply({ accepted: true }, 202));
    renderPage({ fetcher });
    expect(screen.getByRole("heading", { level: 1, name: "Request an invite" })).toBeInTheDocument();
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));

    await screen.findByRole("heading", { level: 2, name: "Request sent" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/invite-request");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
    expect(JSON.parse(init.body)).toEqual({
      name: "Alex Rivera", email: "alex@example.org", organization: "Example Local 12", note: "Steward", website: "", locale: "en",
    });
    // Focus moves in an effect after the message renders.
    await waitFor(() => expect(screen.getByRole("status")).toHaveFocus());
    expect(screen.getByRole("link", { name: "Back to Union Ground" })).toHaveAttribute("href", "/");
  });

  it.each([
    [400, "Check your name, email address and organization, then try again."],
    [503, "Requests can't be sent from this site right now. Email us instead:"],
    [404, "Requests can't be sent from this site right now. Email us instead:"],
    [502, "Your request couldn't be sent. Check your connection and try again."],
  ])("shows fixed copy for a %s answer and keeps the form", async (status, copy) => {
    renderPage({ fetcher: vi.fn().mockResolvedValue(reply({ error: "x" }, status)) });
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(copy);
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByLabelText("Full name")).toHaveValue("Alex Rivera");
    // Union Ground publishes no support mailbox, so the copy names no address and offers no mailto link.
    if (status === 503) expect(within(alert).queryByRole("link")).not.toBeInTheDocument();
  });

  // REQ-UG-INVITE-REQUEST-ACKNOWLEDGEMENT-20261006: owner decision
  // October 8, 2026 (11:28 AM ET), the acknowledgement is on screen with the
  // response window; no email goes to the typed address and nothing is stored.
  it("acknowledges on screen with the response window and the reply address, and makes one request", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply({ accepted: true }, 202));
    renderPage({ fetcher });
    fill();
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "  alex@example.org " } });
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("replies by email within 3 business days");
    expect(status).toHaveTextContent("No confirmation email is sent");
    expect(status).toHaveTextContent("The reply goes to alex@example.org.");
    // The acknowledgement is static: it names no organization and confirms nothing about an account.
    expect(status).not.toHaveTextContent("Example Local 12");
    expect(status).not.toHaveTextContent("Alex Rivera");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  // BUG-UG-SHOW-INVITE-REQUESTERS-EXACT-ADDRESS-TEAM-WILL-REPLY-20261013:
  // the API stores the address trimmed and lower-cased as reply_to, so the sent
  // screen shows that same address, and a long one wraps inside the card.
  it("shows the normalized reply address the API stores, and lets a long one wrap", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply({ accepted: true }, 202));
    renderPage({ fetcher });
    fill();
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: " Alex@Example.org " } });
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("The reply goes to alex@example.org.");
    expect(status).not.toHaveTextContent("Alex@Example.org");
    const sentTo = status.querySelector(".iac-sent-to");
    expect(sentTo).toHaveTextContent("The reply goes to alex@example.org. If that address is wrong, send the request again with the right one.");
    // BUG-UG-INVITE-SENT-ADDRESS-READABILITY-20261020: the address is
    // one bold, selectable unit inside the unchanged sentence.
    const address = sentTo.querySelector("strong.iac-sent-address");
    expect(address).toHaveTextContent("alex@example.org");
    expect(address.textContent).toBe("alex@example.org");
    const addressRule = /\.iac-state \.iac-sent-address\s*\{([^}]*)\}/.exec(readFileSync("src/styles.css", "utf8"));
    expect(addressRule?.[1]).toMatch(/font-weight:\s*800/);
    expect(addressRule?.[1]).toMatch(/user-select:\s*all/);
    expect(addressRule?.[1]).toMatch(/overflow-wrap:\s*anywhere/);
    const rule = /\.iac-state \.iac-sent-to\s*\{([^}]*)\}/.exec(readFileSync("src/styles.css", "utf8"));
    expect(rule?.[1]).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule?.[1]).toMatch(/min-width:\s*0/);
  });

  it("states the response window in Spanish", async () => {
    renderPage({ fetcher: vi.fn().mockResolvedValue(reply({ accepted: true }, 202)), lang: "es" });
    fireEvent.change(screen.getByLabelText("Nombre completo"), { target: { value: "Ana Ruiz" } });
    fireEvent.change(screen.getByLabelText("Correo electrónico"), { target: { value: "ana@example.org" } });
    fireEvent.change(screen.getByLabelText("Campaña o centro de trabajo"), { target: { value: "Local 12" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar solicitud" }));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("en un plazo de 3 días hábiles");
    expect(status).toHaveTextContent("No se envía ningún correo de confirmación");
    expect(status).toHaveTextContent("La respuesta llegará a ana@example.org.");
  });

  it("uses the browser fetch by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply({ accepted: true }, 202));
    vi.stubGlobal("fetch", fetchMock);
    try {
      renderPage();
      fill();
      fireEvent.click(screen.getByRole("button", { name: "Send request" }));
      await screen.findByRole("heading", { level: 2, name: "Request sent" });
      expect(fetchMock).toHaveBeenCalledWith("/api/invite-request", expect.objectContaining({ method: "POST" }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("treats an unreadable reply as a failure", async () => {
    const unreadable = { ok: false, status: 502, json: vi.fn().mockRejectedValue(new SyntaxError("bad json")) };
    renderPage({ fetcher: vi.fn().mockResolvedValue(unreadable) });
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("couldn't be sent");
  });

  it("treats a network failure as a retryable error", async () => {
    renderPage({ fetcher: vi.fn().mockRejectedValue(new Error("offline")) });
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("couldn't be sent");
  });

  it("keeps submit focused and blocks same-turn duplicates while sending", async () => {
    enableFocusFixup();
    let resolve;
    const fetcher = vi.fn(() => new Promise((done) => { resolve = done; }));
    renderPage({ fetcher });
    fill();
    const submit = screen.getByRole("button", { name: "Send request" });
    const form = submit.closest("form");
    submit.focus();
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    await afterRenderingUpdate();
    expect(submit).toHaveFocus();
    expect(submit).toBeEnabled();
    expect(submit).toHaveAttribute("aria-disabled", "true");
    expect(submit).toHaveAttribute("aria-busy", "true");
    fireEvent.click(submit);
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(reply({ accepted: true }, 202));
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Request sent" })).toBeInTheDocument());
  });

  it("marks the fields required, hides the honeypot and links to sign-in and privacy", () => {
    const { container } = renderPage();
    expect(screen.getByLabelText("Full name")).toBeRequired();
    expect(screen.getByLabelText("Email address")).toHaveAttribute("type", "email");
    expect(screen.getByLabelText("Campaign or workplace")).toHaveAccessibleDescription(/isn't on Union Ground yet/);
    expect(screen.getByLabelText("Anything we should know? (optional)")).not.toBeRequired();
    expect(container.querySelector('label[hidden] input[name="website"]')).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/auth");
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    expect(container.textContent).not.toMatch(/509|SEIU/i);
  });

  it("renders in Spanish and sends the Spanish locale", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply({ accepted: true }, 202));
    renderPage({ fetcher, lang: "es" });
    expect(screen.getByRole("heading", { level: 1, name: "Pide una invitación" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Nombre completo"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByLabelText("Correo electrónico"), { target: { value: "ana@example.org" } });
    fireEvent.change(screen.getByLabelText("Campaña o centro de trabajo"), { target: { value: "Local 12" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar solicitud" }));
    await screen.findByRole("heading", { level: 2, name: "Solicitud enviada" });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).locale).toBe("es");
  });
});
