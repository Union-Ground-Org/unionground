import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectView } from "../src/views/ConnectView.jsx";

const requestId = "20000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => requestId) });
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try {
    window.localStorage.removeItem("unionground-lang");
  } catch { /* jsdom always has storage */ }
});

function completeForm() {
  fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Avery" } });
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "avery@example.org" } });
  fireEvent.change(screen.getByLabelText(/^Region/), { target: { value: "northeast" } });
  fireEvent.click(screen.getByLabelText(/contact account or device/i));
  fireEvent.click(screen.getByLabelText(/I consent to being contacted/i));
}

describe("privacy-minimized public connection form", () => {
  it("states the safety boundary and exposes no organizing-detail input", () => {
    const { container } = render(<ConnectView enabled />);
    expect(screen.getByRole("heading", { name: "Start with a safe connection." })).toBeInTheDocument();
    expect(screen.getByText(/No employer or workplace name/)).toBeInTheDocument();
    expect(screen.getByText(/No coworker names/)).toBeInTheDocument();
    expect(screen.getByText(/expire after 30 days and enter the daily deletion queue/)).toBeInTheDocument();
    for (const name of ["employer", "workplace", "coworker", "support", "details", "notes", "message"]) {
      expect(container.querySelector(`[name="${name}"]`)).toBeNull();
    }
  });

  it("submits only the allowlisted minimal fields and replaces the form with a receipt", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({ accepted: true, requestId }),
    });
    render(<ConnectView enabled />);
    completeForm();
    fireEvent.click(screen.getByRole("button", { name: /Send private request/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("/api/connect");
    expect(options.method).toBe("POST");
    expect(options.credentials).toBe("omit");
    expect(options.cache).toBe("no-store");
    const payload = JSON.parse(options.body);
    expect(payload).toEqual({
      firstName: "Avery",
      contactMethod: "email",
      contact: "avery@example.org",
      region: "northeast",
      language: "en",
      bestTime: "any",
      consent: true,
      safeToContact: true,
      voicemailAllowed: false,
      website: "",
      requestId,
    });
    expect(payload).not.toHaveProperty("employer");
    const receiptHeading = await screen.findByRole("heading", { name: /trusted contact can follow up/i });
    expect(receiptHeading).toHaveFocus();
    expect(screen.queryByLabelText("First name")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send another request" }));
    expect(await screen.findByLabelText("First name")).toHaveFocus();
  });

  it("keeps the form available with a bounded error on rate limit", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: "rate-limited" }),
    });
    render(<ConnectView enabled />);
    completeForm();
    fireEvent.click(screen.getByRole("button", { name: /Send private request/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Too many requests/);
    expect(screen.getByLabelText("First name")).toHaveValue("Avery");
  });

  it("switches contact semantics without adding a narrative field", () => {
    render(<ConnectView enabled />);
    fireEvent.change(screen.getByLabelText("Contact method"), { target: { value: "phone" } });
    const input = screen.getByLabelText("Phone number");
    expect(input).toHaveAttribute("type", "tel");
    expect(input).toHaveAttribute("maxlength", "32");
    expect(screen.getByLabelText(/neutral voicemail/i)).toBeInTheDocument();
  });

  it("fails closed in the default development preview without rendering the form", () => {
    vi.stubGlobal("crypto", {});
    render(<ConnectView enabled={false} />);
    expect(screen.getByRole("heading", { name: /intake is not open/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send private request/i })).not.toBeInTheDocument();
  });

  // The form asks which language the visitor reads and then had to show them
  // the boundary, the consent sentence and every failure message in English.
  it("renders the boundary and the consent sentence in the visitor's saved language", () => {
    window.localStorage.setItem("unionground-lang", "es");
    render(<ConnectView enabled />);
    expect(screen.getByRole("heading", { name: "Empieza con un contacto seguro." })).toBeInTheDocument();
    expect(screen.getByText("No ingreses detalles sensibles de organización.")).toBeInTheDocument();
    expect(screen.getByLabelText(/Doy mi consentimiento para que me contacten/i)).toBeInTheDocument();
    expect(screen.queryByText(/I consent to being contacted/i)).toBeNull();
  });

  // api/connect.js validates these server-side, so translating a label must
  // never move the value it carries.
  it("keeps the wire values of every <option> untranslated", () => {
    window.localStorage.setItem("unionground-lang", "es");
    const { container } = render(<ConnectView enabled />);
    const values = (name) => [...container.querySelectorAll(`select[name="${name}"] option`)].map((o) => o.value);
    expect(values("contactMethod")).toEqual(["email", "phone", "text"]);
    expect(values("region")).toEqual(["", "northeast", "south", "midwest", "west", "territories", "outside-us"]);
    expect(values("language")).toEqual(["en", "es", "other"]);
    expect(values("bestTime")).toEqual(["any", "morning", "afternoon", "evening"]);
  });

  it("still issues a request id when crypto.randomUUID is unavailable", async () => {
    vi.stubGlobal("crypto", {});
    global.fetch.mockImplementationOnce(async (_url, options) => ({
      ok: true,
      status: 202,
      json: async () => ({ accepted: true, requestId: JSON.parse(options.body).requestId }),
    }));
    render(<ConnectView enabled />);
    completeForm();
    fireEvent.click(screen.getByRole("button", { name: /Send private request/i }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(payload.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await screen.findByRole("heading", { name: /trusted contact can follow up/i })).toBeInTheDocument();
  });
});
