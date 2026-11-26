import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvitationAcceptView } from "../src/views/InvitationAcceptView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { currentLegalVersions } from "../src/lib/legalInstruments.js";
import { catalogue } from "../src/lib/i18n.js";
import { publishedLegalPack } from "../api/legal-pack.js";
import { StrictMode } from "react";
import * as legalReleaseBundle from "../src/lib/legalReleaseBundle.js";
import { publishedVersionsWithProof } from "./helpers/legal-publication.js";

// The bundled legal release is published only with the deployment's proof
// (tests/helpers/legal-publication.js); this file renders acceptance against it.
let legalProofSpy;
beforeEach(() => {
  legalProofSpy = vi.spyOn(legalReleaseBundle, "loadPublishedWebVersions").mockImplementation(publishedVersionsWithProof);
});
afterEach(() => legalProofSpy?.mockRestore());


const TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";

afterEach(() => {
  // An assertion throw skips any restore later in the test. This case is
  // last today; the next case appended after it would inherit the leak.
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // A valid link is kept for its tab (BUG-UNIONGROUND-INVITATION-FIRST-OPEN-
  // SHOWS-UNAVAILABLE-20261030); each case is a fresh tab.
  window.sessionStorage.clear();
});

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) };
}

// The same role="status" element first reads "checking" while the redeem
// request is in flight and only then the outcome. findByRole resolves on the
// first, so wait for the outcome text itself; a slow runner otherwise catches
// the checking state (BUG-UG-ROOT-COVERAGE-FLAKY-INVITATION-ES-AND-SIGNIN-MOUNT-20261021).
async function findStatus(text) {
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(text));
  return screen.getByRole("status");
}

function renderView({
  url = `/invite#invite=${TOKEN}`,
  fetcher,
  previewFetcher,
  schedule,
  cancelSchedule,
  lang = "en",
  agreeToTerms = true,
} = {}) {
  window.history.replaceState({}, "", url);
  const view = render(
    <LanguageProvider lang={lang}>
      <InvitationAcceptView
        fetcher={fetcher}
        previewFetcher={previewFetcher}
        schedule={schedule}
        cancelSchedule={cancelSchedule}
      />
    </LanguageProvider>,
  );
  // The page shows the versioned clickwrap first and only
  // the agree button exchanges the invitation, so every case that expects a
  // request agrees here. In the clickwrap state the agree button is the only
  // button on the page; when there is no usable secret there is none at all
  // and nothing is clicked.
  if (agreeToTerms) {
    // A state, then both boxes: the terms and, since the owner decision of
    // October 16, 2026, the age attestation that state selects.
    const state = screen.queryByRole("combobox");
    if (state) fireEvent.change(state, { target: { value: "TX" } });
    const consents = screen.queryAllByRole("checkbox");
    const [action] = screen.queryAllByRole("button");
    if (consents.length && action) {
      consents.forEach((consent) => fireEvent.click(consent));
      fireEvent.click(action);
    }
  }
  return view;
}

describe("fragment-only invitation acceptance view", () => {
  it.each([
    ["en", "Use at least 24 characters.", /we will email you a temporary sign-in password/, /Then choose your own password in Settings/],
    ["es", "Usa al menos 24 caracteres.", /te enviaremos una contraseña temporal por correo/, /Luego elige tu propia contraseña en Configuración/],
  ])("explains email delivery and the later password choice before accepting (%s)", async (lang, rule, before, after) => {
    const fetcher = vi.fn().mockResolvedValue(response({ accepted: true }));
    renderView({ lang, fetcher, agreeToTerms: false });
    expect(screen.getByText(before)).toBeVisible();
    expect(screen.getByText(lang === "en" ? /keep using your existing password; no new password is sent/ : /sigue usando tu contraseña actual; no se envía una nueva/)).toBeVisible();
    expect(screen.getByText(rule)).toBeVisible();
    expect(fetcher).not.toHaveBeenCalled();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "TX" } });
    screen.getAllByRole("checkbox").forEach(box => fireEvent.click(box));
    fireEvent.click(screen.getByRole("button", { name: catalogue[lang]["inviteAccept.terms.action"] }));
    await findStatus(catalogue[lang]["inviteAccept.continuing"]);
    expect(screen.getByRole("status")).toHaveTextContent(after);
    expect(screen.getByText(rule)).toBeVisible();
  });

  // REQ-UG-BLOCK-GOVERNMENT-AND-EMPLOYER-EMAIL-DOMAINS-20261102.
  it.each(["en", "es"])("says a government or employer invitation can't be accepted and offers no retry (%s)", async (lang) => {
    const copy = catalogue[lang];
    const fetcher = vi.fn().mockResolvedValue(response({ error: "email-domain-blocked" }, 400));
    renderView({ lang, fetcher });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(copy["inviteAccept.domainBlockedTitle"]);
    expect(alert).toHaveTextContent(copy["inviteAccept.domainBlockedBody"]);
    expect(screen.queryByRole("button", { name: copy["inviteAccept.retry"] })).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.length).toBe(0);
  });

  it.each(["en", "es"])("refreshes the age rule with the newly deployed terms and records fresh consent (%s)", async (lang) => {
    const copy = catalogue[lang];
    const pack = publishedLegalPack(lang);
    const terms = pack.instruments.find((entry) => entry.key === "terms-of-use");
    terms.version = "2.0.0";
    terms.sections[0].body = "New deployment: Ohio now requires an adult attestation.";
    pack.acceptance.residenceAge.rules.OH = "adult";
    // Fixture-only version markers model catalogue edits in the new bundle.
    pack.acceptance.consent += " 2.0.0";
    pack.acceptance.residenceAge.labels.adult += " 2.0.0";
    pack.acceptance.residenceAge.labels.band += " 2.0.0";
    pack.acceptance.residenceAge.labels.state += " 2.0.0";
    pack.acceptance.residenceAge.labels.help += " 2.0.0";
    pack.acceptance.residenceAge.labels.choose += " 2.0.0";
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ error: "terms-version-stale" }, 409))
      .mockResolvedValueOnce(response(pack))
      .mockResolvedValueOnce(response({ accepted: true }));
    renderView({ fetcher, lang, agreeToTerms: false });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "OH" } });
    expect(screen.getByRole("checkbox", { name: copy["ageRule.band"] })).toBeVisible();
    screen.getAllByRole("checkbox").forEach((box) => fireEvent.click(box));
    fireEvent.click(screen.getByRole("button", { name: copy["inviteAccept.terms.action"] }));
    fireEvent.click(await screen.findByRole("button", { name: copy["inviteAccept.staleAction"] }));
    const age = await screen.findByRole("checkbox", { name: pack.acceptance.residenceAge.labels.adult });
    expect(screen.queryByRole("checkbox", { name: copy["ageRule.band"] })).toBeNull();
    expect(screen.getByRole("combobox")).toHaveValue("OH");
    expect(screen.getByRole("combobox")).toHaveAccessibleName(pack.acceptance.residenceAge.labels.state);
    expect(screen.getByText(pack.acceptance.residenceAge.labels.help)).toBeVisible();
    expect(screen.getByRole("option", { name: pack.acceptance.residenceAge.labels.choose })).toHaveValue("");
    const content = screen.getByText(terms.sections[0].body);
    fireEvent.click(content.closest("details").querySelector("summary"));
    expect(content).toBeVisible();
    expect(age).not.toBeChecked();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "MA" } });
    expect(screen.getByRole("checkbox", { name: pack.acceptance.residenceAge.labels.band })).not.toBeChecked();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "OH" } });
    const consent = screen.getByRole("checkbox", { name: pack.acceptance.consent });
    expect(consent).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: copy["inviteAccept.terms.action"] }));
    expect(fetcher).toHaveBeenCalledTimes(2);
    fireEvent.click(consent);
    fireEvent.click(age);
    fireEvent.click(screen.getByRole("button", { name: copy["inviteAccept.terms.action"] }));
    await findStatus(copy["inviteAccept.continuing"]);
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({
      token: TOKEN, acceptedVersions: { ...currentLegalVersions(), "terms-of-use": "2.0.0" },
      residenceState: "OH", ageAttested: true,
    });
  });

  it.each(["en", "es"])("returns from stale terms with fresh consent and the in-memory invitation (%s)", async (lang) => {
    const pack = publishedLegalPack(lang);
    const changedTerms = pack.instruments.find((entry) => entry.key === "terms-of-use");
    changedTerms.version = "2.0.0";
    changedTerms.notice = "Version 2.0.0";
    changedTerms.sections[0].body = "Newly deployed terms content, absent from the original bundle.";
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ error: "terms-version-stale" }, 409))
      .mockResolvedValueOnce(response(pack))
      .mockResolvedValueOnce(response({ accepted: true }));
    renderView({ fetcher, lang });
    const copy = catalogue[lang];
    expect(await screen.findByRole("alert")).toHaveTextContent(copy["inviteAccept.staleTitle"]);
    expect(fetcher).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: copy["inviteAccept.staleAction"] }));
    const heading = await screen.findByRole("heading", { name: copy["inviteAccept.terms.title"] });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText(copy["inviteAccept.terms.version"].replace("{version}", "2.0.0"))).toBeVisible();
    const newContent = screen.getByText(changedTerms.sections[0].body);
    const details = newContent.closest("details");
    fireEvent.click(details.querySelector("summary"));
    expect(newContent).toBeVisible();
    // BUG-UG-INVITATION-REFRESHED-LEGAL-READER-ALIGNMENT-20261020: the
    // refreshed text is a left-aligned reader under one disclosure marker.
    expect(details).toHaveClass("iac-terms-reader");
    expect(details.closest("li")).toHaveClass("iac-terms-reader-item");
    const sheet = readFileSync(resolve("src/styles.css"), "utf8");
    expect(sheet).toMatch(/\.iac-terms-list \.iac-terms-reader-item\s*\{[^}]*list-style:\s*none/);
    expect(sheet).toMatch(/\.iac-terms-reader\s*\{[^}]*text-align:\s*left/);
    expect(sheet).toMatch(/\.iac-state \.iac-terms-reader p\s*\{[^}]*max-width:\s*none/);
    expect(fetcher).toHaveBeenNthCalledWith(2, `/api/legal-pack?lang=${lang}`, expect.objectContaining({
      cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
    }));
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    boxes.forEach((box) => expect(box).not.toBeChecked());
    expect(window.location.hash).toBe("");
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const accept = screen.getByRole("button", { name: copy["inviteAccept.terms.action"] });
    fireEvent.click(accept);
    expect(fetcher).toHaveBeenCalledTimes(2);
    fireEvent.click(boxes[0]);
    fireEvent.click(accept);
    expect(fetcher).toHaveBeenCalledTimes(2);
    fireEvent.click(boxes[1]);
    fireEvent.click(accept);
    await findStatus(copy["inviteAccept.continuing"]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({
      token: TOKEN, acceptedVersions: { ...currentLegalVersions(), "terms-of-use": "2.0.0" }, residenceState: "TX", ageAttested: true,
    });
  });

  // BUG-UG-INVITATION-REFRESHED-TERMS-LANGUAGE-20261025: a
  // refreshed pack follows the selected language, a late response for an
  // earlier language never replaces the current one, and every switch asks
  // for consent again.
  it("reads refreshed terms again in the selected language, ignoring late responses, with fresh consent", async () => {
    const pending = {};
    const fetcher = vi.fn((url, options) => {
      if (options?.method === "POST") {
        return Promise.resolve(fetcher.mock.calls.length === 1 ? response({ error: "terms-version-stale" }, 409) : response({ accepted: true }));
      }
      const lang = new URL(url, "https://example.test").searchParams.get("lang");
      return new Promise((resolve) => { (pending[lang] ??= []).push({ resolve, signal: options.signal }); });
    });
    const page = (lang) => <LanguageProvider lang={lang}><InvitationAcceptView fetcher={fetcher} /></LanguageProvider>;
    const view = renderView({ fetcher });
    fireEvent.click(await screen.findByRole("button", { name: catalogue.en["inviteAccept.staleAction"] }));
    await act(async () => { pending.en.shift().resolve(response(publishedLegalPack("en"))); });
    const en = publishedLegalPack("en").acceptance;
    const es = publishedLegalPack("es").acceptance;
    expect(await screen.findByText(en.consent)).toBeVisible();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "TX" } });
    screen.getAllByRole("checkbox").forEach((box) => fireEvent.click(box));

    // Spanish is requested, then English again before Spanish answers.
    view.rerender(page("es"));
    await waitFor(() => expect(pending.es).toHaveLength(1));
    view.rerender(page("en"));
    await waitFor(() => expect(pending.en).toHaveLength(1));
    expect(pending.es[0].signal.aborted).toBe(true);
    await act(async () => { pending.en.shift().resolve(response(publishedLegalPack("en"))); });
    await act(async () => { pending.es.shift().resolve(response(publishedLegalPack("es"))); });
    expect(await screen.findByText(en.consent)).toBeVisible();
    expect(screen.queryByText(es.consent)).toBeNull();
    screen.getAllByRole("checkbox").forEach((box) => expect(box).not.toBeChecked());

    // A settled switch shows the Spanish documents, consent and age labels.
    screen.getAllByRole("checkbox").forEach((box) => fireEvent.click(box));
    view.rerender(page("es"));
    await waitFor(() => expect(pending.es).toHaveLength(1));
    await act(async () => { pending.es.shift().resolve(response(publishedLegalPack("es"))); });
    expect(await screen.findByText(es.consent)).toBeVisible();
    expect(screen.queryByText(en.consent)).toBeNull();
    expect(screen.getByText(es.residenceAge.labels.state)).toBeVisible();
    const spanish = publishedLegalPack("es").instruments[0];
    expect(screen.getByText(catalogue.es["inviteAccept.terms.instrument"]
      .replace("{name}", spanish.name).replace("{version}", spanish.version))).toBeVisible();
    const boxes = screen.getAllByRole("checkbox");
    boxes.forEach((box) => expect(box).not.toBeChecked());
    const accept = screen.getByRole("button", { name: catalogue.es["inviteAccept.terms.action"] });
    fireEvent.click(accept);
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    boxes.forEach((box) => fireEvent.click(box));
    fireEvent.click(accept);
    await findStatus(catalogue.es["inviteAccept.continuing"]);
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(2);
  });

  it.each(["unavailable", "missing-content", "missing-instrument", "missing-acceptance", "missing-consent", "missing-age-policy", "missing-rule", "invalid-rule", "missing-labels", "empty-label"])("holds consent closed when the refreshed pack is %s", async (failure) => {
    const pack = publishedLegalPack("en");
    if (failure === "missing-content") delete pack.instruments[0].sections;
    if (failure === "missing-instrument") pack.instruments.pop();
    if (failure === "missing-acceptance") delete pack.acceptance;
    if (failure === "missing-consent") delete pack.acceptance.consent;
    if (failure === "missing-age-policy") delete pack.acceptance.residenceAge;
    if (failure === "missing-rule") delete pack.acceptance.residenceAge.rules.OH;
    if (failure === "invalid-rule") pack.acceptance.residenceAge.rules.OH = "unsupported";
    if (failure === "missing-labels") delete pack.acceptance.residenceAge.labels;
    if (failure === "empty-label") pack.acceptance.residenceAge.labels.adult = " ";
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ error: "terms-version-stale" }, 409))
      .mockResolvedValueOnce(failure === "unavailable" ? response({}, 503) : response(pack))
      .mockResolvedValueOnce(response(publishedLegalPack("en")));
    renderView({ fetcher });
    fireEvent.click(await screen.findByRole("button", { name: "Read the new terms" }));
    expect(await screen.findByText(catalogue.en["inviteAccept.refreshFailed"])).toBeVisible();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Read the new terms" }));
    await screen.findAllByRole("checkbox");
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  });

  it("aborts a stalled legal refresh, holds consent closed and retries with the retained invitation", async () => {
    let refreshSignal;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ error: "terms-version-stale" }, 409))
      .mockImplementationOnce((url, { signal }) => {
        refreshSignal = signal;
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      })
      .mockResolvedValueOnce(response(publishedLegalPack("en")))
      .mockResolvedValueOnce(response({ accepted: true }));
    renderView({ fetcher });
    const readTerms = await screen.findByRole("button", { name: "Read the new terms" });
    vi.useFakeTimers();
    act(() => {
      fireEvent.click(readTerms);
      fireEvent.click(readTerms);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: catalogue.en["inviteAccept.refreshing"] })).toBeDisabled();
    expect(screen.queryByRole("checkbox")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(7999));
    expect(refreshSignal.aborted).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(refreshSignal.aborted).toBe(true);
    expect(screen.getByText(catalogue.en["inviteAccept.refreshFailed"])).toBeVisible();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "Read the new terms" }));
    const boxes = await screen.findAllByRole("checkbox");
    boxes.forEach((box) => expect(box).not.toBeChecked());
    expect(screen.getByRole("combobox")).toHaveValue("TX");
    boxes.forEach((box) => fireEvent.click(box));
    fireEvent.click(screen.getByRole("button", { name: catalogue.en["inviteAccept.terms.action"] }));
    await findStatus("Invitation accepted");
    expect(JSON.parse(fetcher.mock.calls[3][1].body)).toMatchObject({ token: TOKEN, residenceState: "TX" });
    expect(window.location.href).not.toContain(TOKEN);
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it.each(["resolve", "reject"])("aborts on leaving the page and ignores a late refresh %s", async (outcome) => {
    let resolveRefresh;
    let rejectRefresh;
    let refreshSignal;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ error: "terms-version-stale" }, 409))
      .mockImplementationOnce((url, { signal }) => {
        refreshSignal = signal;
        return new Promise((resolve, reject) => { resolveRefresh = resolve; rejectRefresh = reject; });
      });
    const view = renderView({ fetcher });
    fireEvent.click(await screen.findByRole("button", { name: "Read the new terms" }));
    expect(refreshSignal.aborted).toBe(false);
    view.unmount();
    expect(refreshSignal.aborted).toBe(true);
    await act(async () => {
      if (outcome === "resolve") resolveRefresh(response(publishedLegalPack("en")));
      else rejectRefresh(new Error("late network failure"));
    });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(window.location.href).not.toContain(TOKEN);
  });

  it.each(["", "#other=not-an-invitation", `#invite=${TOKEN}&extra=1`, "#invite=", "#invite=too-short"])("refuses an invalid invitation fragment %s without an exchange", async (fragment) => {
    const fetcher = vi.fn();
    renderView({ url: `/invite${fragment}`, fetcher });
    // Nothing was asked of the server, so the page does not call the
    // invitation gone: it says the link did not open completely.
    expect(await screen.findByRole("alert")).toHaveTextContent("This invitation link didn't open completely");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
  });

  it("reports existing-account reactivation without claiming a password was emailed", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ accepted: true, reactivated: true }));
    renderView({ fetcher });
    const status = await findStatus("Your participation is active again");
    expect(status).not.toHaveTextContent("password is on its way");
  });

  it("preserves the fragment through Strict Mode replay and sends consent once", async () => {
    window.history.replaceState({}, "", `/invite#invite=${TOKEN}`);
    const fetcher = vi.fn().mockResolvedValue(response({ accepted: true }));
    render(<StrictMode><LanguageProvider lang="en"><InvitationAcceptView fetcher={fetcher} /></LanguageProvider></StrictMode>);
    // The age box is shown from the start but cannot be checked before a
    // state is chosen (REQ-UG-INVITE-TERMS-AGE-STATE-FORM-CLARITY-20261030).
    expect(await screen.findAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getAllByRole("checkbox")[1]).toBeDisabled();
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: /I have read the terms of use/ }));
    // The terms alone are not enough:
    // nothing is sent without a state and the age attestation it selects.
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("alert")).toHaveTextContent(/^Choose the state where you live\.$/u);
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "State where you live" }), { target: { value: "TX" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "I'm 18 or older." }));
    fireEvent.click(screen.getByRole("button"));
    await findStatus("Invitation accepted");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      token: TOKEN, acceptedVersions: currentLegalVersions(), residenceState: "TX", ageAttested: true,
    });
  });

  // The five app-store age-law states ask
  // for 18 or older; every other listed region asks for the D-03 B band, and
  // changing the state clears an answer given to the other sentence.
  it.each([
    ["CA", "I'm 18 or older."],
    ["LA", "I'm 18 or older."],
    ["OH", "I'm 13 or older, and if I'm under 18, my organization authorized this account."],
    ["outside-us", "I'm 13 or older, and if I'm under 18, my organization authorized this account."],
  ])("shows the attestation %s selects and sends that state", async (code, sentence) => {
    window.history.replaceState({}, "", `/invite#invite=${TOKEN}`);
    const fetcher = vi.fn().mockResolvedValue(response({ accepted: true }));
    render(<LanguageProvider lang="en"><InvitationAcceptView fetcher={fetcher} /></LanguageProvider>);
    const state = await screen.findByRole("combobox", { name: "State where you live" });
    const previous = code === "CA" ? "OH" : "CA";
    fireEvent.change(state, { target: { value: previous } });
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.change(state, { target: { value: code } });
    const age = screen.getByRole("checkbox", { name: sentence });
    // A state whose sentence differs clears the answer and says why; a state
    // with the same sentence keeps it
    // (REQ-UG-INVITE-TERMS-AGE-STATE-FORM-CLARITY-20261030).
    if (code === "LA") {
      expect(age).toBeChecked();
      fireEvent.click(age);
    } else {
      expect(age).not.toBeChecked();
      expect(screen.getByRole("status")).toHaveTextContent("so check it again");
    }
    fireEvent.click(screen.getByRole("checkbox", { name: /I have read the terms of use/ }));
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("alert")).toHaveTextContent(/^Check the age statement\.$/u);
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(age);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ residenceState: code, ageAttested: true });
  });

  it("names the states in Spanish on the Spanish page", async () => {
    window.history.replaceState({}, "", `/invite#invite=${TOKEN}`);
    render(<LanguageProvider lang="es"><InvitationAcceptView fetcher={vi.fn()} /></LanguageProvider>);
    const state = await screen.findByRole("combobox", { name: "Estado donde vives" });
    expect(screen.getByRole("option", { name: "Luisiana" })).toHaveValue("LA");
    fireEvent.change(state, { target: { value: "LA" } });
    expect(screen.getByRole("checkbox", { name: "Tengo 18 años o más." })).toBeInTheDocument();
  });

  it("treats an unreadable response as unconfirmed and safely retries with the same consent", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error("malformed"); } })
      .mockResolvedValueOnce(response({ accepted: true }));
    renderView({ fetcher });
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't finish accepting this invitation");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await findStatus("Invitation accepted");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("scrubs the secret before exchange and confirms emailed-password provisioning without exposing it", async () => {
    let resolveFetch;
    const fetcher = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    renderView({ fetcher });

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe("/invite");
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(fetcher).toHaveBeenCalledWith("/api/accept-invitation", expect.objectContaining({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      body: JSON.stringify({ token: TOKEN, acceptedVersions: currentLegalVersions(), residenceState: "TX", ageAttested: true }),
    }));

    resolveFetch(response({ accepted: true }));
    await findStatus(/invitation accepted/i);
    expect(screen.getByRole("status")).toHaveTextContent(/password is on its way by email/i);
    expect(screen.getByRole("link", { name: "Sign in to Union Ground" })).toHaveAttribute("href", "/m");
    expect(document.body.textContent).not.toContain("auth-token");
  });

  it("refuses and scrubs query-string tokens without sending a request", async () => {
    const fetcher = vi.fn();
    renderView({ url: `/invite?token=${TOKEN}#invite=${TOKEN}`, fetcher });
    expect(await screen.findByRole("alert")).toHaveTextContent("This invitation link didn't open completely");
    expect(fetcher).not.toHaveBeenCalled();
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe("/invite");
  });

  it("rejects a success response that does not confirm acceptance", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ accepted: false, provider: "provider-secret-detail" }));
    renderView({ fetcher });
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't finish accepting this invitation");
    expect(document.body.textContent).not.toContain("provider-secret-detail");
  });

  it("offers a safe retry after a transient failure without restoring the secret to the URL", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ error: "acceptance-unavailable" }, 503))
      .mockResolvedValueOnce(response({ accepted: true }));
    renderView({ fetcher, lang: "es" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Union Ground está ocupado");
    expect(window.location.hash).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Intentar de nuevo" }));
    await findStatus(/invitación aceptada/i);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["en", "Union Ground is busy", "It is safe to try again in a moment.", "Check your connection", "Try again", "Invitation accepted"],
    ["es", "Union Ground está ocupado", "Es seguro volver a intentarlo en un momento.", "Revisa tu conexión", "Intentar de nuevo", "Invitación aceptada"],
  ])("distinguishes server and transport failures and retries safely in %s", async (lang, busy, safe, network, retry, accepted) => {
    const diagnostic = "private-server-diagnostic";
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ error: "acceptance-unavailable", detail: diagnostic }, 503))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(response({ accepted: true }));
    renderView({ fetcher, lang });

    const serverAlert = await screen.findByRole("alert");
    expect(serverAlert).toHaveTextContent(busy);
    expect(serverAlert).toHaveTextContent(safe);
    expect(serverAlert).not.toHaveTextContent(network);
    // Focus moves in a passive effect after the alert commits; await it.
    await waitFor(() => expect(serverAlert).toHaveFocus());
    expect(document.body.textContent).not.toContain(diagnostic);
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);

    fireEvent.click(screen.getByRole("button", { name: retry }));
    const networkAlert = await screen.findByRole("alert");
    expect(networkAlert).toHaveTextContent(network);
    expect(networkAlert).not.toHaveTextContent(busy);
    await waitFor(() => expect(networkAlert).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: retry }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(accepted));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: retry })).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [, options] of fetcher.mock.calls) {
      expect(options).toMatchObject({
        method: "POST", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
        body: JSON.stringify({ token: TOKEN, acceptedVersions: currentLegalVersions(), residenceState: "TX", ageAttested: true }),
      });
    }
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
  });

  it.each([500, 502, 503, 504, 599])("shows safe server guidance for a non-JSON HTTP %s response", async (status) => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false, status, json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token <")),
    });
    renderView({ fetcher });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Union Ground is busy");
    expect(alert).toHaveTextContent("It is safe to try again in a moment.");
    expect(alert).not.toHaveTextContent("Check your connection");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("waits out an active acceptance lease and retries automatically with the in-memory secret", async () => {
    let scheduledRetry;
    const schedule = vi.fn((callback) => {
      scheduledRetry = callback;
      return 17;
    });
    const cancelSchedule = vi.fn();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({
        error: "acceptance-in-progress",
        retryAfterSeconds: 2,
      }, 409))
      .mockResolvedValueOnce(response({ accepted: true }));

    renderView({ fetcher, schedule, cancelSchedule });

    expect(await screen.findByRole("alert")).toHaveTextContent("Acceptance is already in progress");
    expect(screen.getByText("Keep this page open. We'll retry securely in about 2 seconds.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retrying automatically…" })).toBeDisabled();
    await waitFor(() => expect(schedule).toHaveBeenCalledWith(expect.any(Function), 2000));
    expect(window.location.hash).toBe("");

    await act(async () => scheduledRetry());
    await findStatus(/invitation accepted/i);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1].body)
      .toBe(JSON.stringify({ token: TOKEN, acceptedVersions: currentLegalVersions(), residenceState: "TX", ageAttested: true }));
    expect(cancelSchedule).toHaveBeenCalledWith(17);
    // A callback already queued before cancellation cannot reuse a consumed secret.
    await act(async () => scheduledRetry());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("alert")).toHaveTextContent("This invitation is no longer available");
  });

  it("pins no-referrer/no-store protection at both document and deployment boundaries", () => {
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    const vercel = JSON.parse(readFileSync(resolve(process.cwd(), "vercel.json"), "utf8"));
    expect(html).toContain('<meta name="referrer" content="no-referrer" />');
    expect(vercel.headers).toContainEqual(expect.objectContaining({
      source: "/invite",
      headers: expect.arrayContaining([
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Cache-Control", value: "no-store" },
      ]),
    }));
  });

  it("uses the default fetch and retry scheduler without leaking the fragment", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ error: "acceptance-in-progress", retryAfterSeconds: 1 }, 409))
      .mockResolvedValueOnce(response({ error: "invitation-unavailable" }, 410));
    vi.stubGlobal("fetch", fetchMock);

    renderView({ fetcher: undefined, previewFetcher: () => Promise.reject(new Error("no preview")), schedule: undefined, cancelSchedule: undefined });
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(window.location.hash).toBe("");
  });
});

// REQ-UG-MEMBER-REFERRAL-ATTRIBUTION-20261110: an optional
// referral code goes with the acceptance; an empty field sends nothing.
describe("referral code on the invitation page", () => {
  it.each(["en", "es"])("sends the code the person typed with the acceptance (%s)", async (lang) => {
    const copy = catalogue[lang];
    const fetcher = vi.fn().mockResolvedValue(response({ accepted: true }));
    renderView({ lang, fetcher, agreeToTerms: false });
    const field = screen.getByLabelText(copy["inviteAccept.referralLabel"]);
    expect(screen.getByText(copy["inviteAccept.referralHint"])).toBeVisible();
    fireEvent.change(field, { target: { value: " ab12-cd34-ef56 " } });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "TX" } });
    screen.getAllByRole("checkbox").forEach((box) => fireEvent.click(box));
    fireEvent.click(screen.getByRole("button", { name: copy["inviteAccept.terms.action"] }));
    await findStatus(copy["inviteAccept.continuing"]);
    const accept = fetcher.mock.calls.find(([url]) => String(url).includes("/api/accept-invitation"));
    expect(JSON.parse(accept[1].body)).toMatchObject({ token: TOKEN, residenceState: "TX", ageAttested: true, referralCode: "ab12-cd34-ef56" });
  });

  it("sends no referral code when the field is left empty", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ accepted: true }));
    renderView({ fetcher });
    await findStatus(catalogue.en["inviteAccept.continuing"]);
    const accept = fetcher.mock.calls.find(([url]) => String(url).includes("/api/accept-invitation"));
    expect(JSON.parse(accept[1].body)).not.toHaveProperty("referralCode");
  });
});
