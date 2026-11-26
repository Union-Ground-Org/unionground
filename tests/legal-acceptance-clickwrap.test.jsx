import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/accept-invitation.js";
import { InvitationAcceptView } from "../src/views/InvitationAcceptView.jsx";
import { LegalAcceptancePrompt } from "../src/components/LegalAcceptancePrompt.jsx";
import * as legalReleaseBundle from "../src/lib/legalReleaseBundle.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import {
  legalAcceptanceReadNeeded,
  legalAcceptanceRequirement,
  loadLegalAcceptanceState,
  recordLegalAcceptance,
  recordLegalAcceptanceOutcome,
  recordedLegalAcceptances,
} from "../src/lib/legalAcceptance.js";
import { PORTAL_ORIGIN } from "./helpers/fictional-provider.js";
import { LEGAL_INSTRUMENTS, currentLegalVersions } from "../src/lib/legalInstruments.js";
import { RESIDENCE_REGIONS, ageRuleFor, isResidenceRegion } from "../src/lib/residenceRegions.js";
import {
  LEGAL_ACCEPTANCE_ADULT,
  LEGAL_ACCEPTANCE_AGE_HELP,
  LEGAL_ACCEPTANCE_BAND,
  LEGAL_ACCEPTANCE_STATE,
  LEGAL_ACCEPTANCE_STATE_CHOOSE,
  legalAcceptanceAgeLabel,
  legalAcceptanceBody,
  legalAcceptanceLinks,
  legalAcceptanceRequirement as nativeRequirement,
  legalAcceptanceVersionLine,
  legalAcceptanceVersions as nativeVersions,
} from "../apps/mobile/src/lib/legalAcceptance.ts";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));
import { publishedVersionsWithProof } from "./helpers/legal-publication.js";

// The bundled legal release is published only with the deployment's proof
// (tests/helpers/legal-publication.js); this file renders acceptance against it.
let legalProofSpy;
beforeEach(() => {
  legalProofSpy = vi.spyOn(legalReleaseBundle, "loadPublishedWebVersions").mockImplementation(publishedVersionsWithProof);
});
afterEach(() => legalProofSpy?.mockRestore());


// REQ-UG-VERSIONED-TERMS-ACCEPTANCE-20261010, of
// October 10, 2026 (option a): "versioned clickwrap at invitation acceptance
// and at first sign-in after a material change, recording version, time, user
// and organization; until it ships, the pack is not published as operative."
//
// Acceptance line 1: invitation acceptance presents the current versioned
//   terms and records the acceptance with version, time, user and
//   organization, on web and native, enforced server-side.
// Acceptance line 2: a published material change triggers a single
//   re-acceptance prompt at the next sign-in and records a new acceptance row;
//   an already-current user is not prompted.
// Acceptance line 3: until this ships, the published legal routes keep the
//   not-operative labelling D-08 requires.

const ORIGIN = PORTAL_ORIGIN;
const BACKEND = "https://project.supabase.co";
const TOKEN = "A".repeat(43);
const INVITATION_ID = "10000000-0000-4000-8000-000000000001";
const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261010213000_versioned_legal_acceptance.sql"),
  "utf8",
);
const contract = JSON.parse(readFileSync(resolve(process.cwd(), "scripts/db-contract.json"), "utf8"));

const reply = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});

function renderInvite({ fetcher, lang = "en" } = {}) {
  window.history.replaceState({}, "", `/invite#invite=${TOKEN}`);
  render(
    <LanguageProvider lang={lang}>
      <InvitationAcceptView fetcher={fetcher} schedule={() => 1} cancelSchedule={() => {}} />
    </LanguageProvider>,
  );
}

// The terms box first, then the state and the age attestation it selects
// (: 18 or older in the app-store age-law
// states, the D-03 B band elsewhere).
const consentBox = () => screen.getAllByRole("checkbox")[0];
const chooseState = (code = "TX") => fireEvent.change(screen.getByRole("combobox"), { target: { value: code } });
const ageBox = () => screen.getAllByRole("checkbox")[1];
const agreeButton = () => screen.queryAllByRole("button")[0];

// An instrument fixture whose second version is marked material, so the
// re-acceptance decision can be exercised without publishing a change.
function fixtureInstruments({ material = true } = {}) {
  return [
    {
      key: "terms-of-use",
      summaryPage: "terms",
      summaryPath: "/terms",
      path: "/legal/terms",
      summaryTitleKey: "legal.terms.title",
      englishName: "Terms of use",
      version: "0.2.0",
      effectiveDate: null,
      status: "pending-review",
      changelog: [
        { version: "0.1.0", date: "2026-10-10", material: false, noteKey: "legal.changelog.note.registered" },
        { version: "0.2.0", date: "2026-11-10", material, noteKey: "legal.changelog.note.registered" },
      ],
    },
  ];
}

describe("D-08 clickwrap at invitation acceptance", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("presents the current versioned terms and exchanges nothing until the person agrees", async () => {
    const fetcher = vi.fn();
    renderInvite({ fetcher });

    // REQ-UG-INVITE-TERMS-AGE-STATE-FORM-CLARITY-20261030: the age
    // box is on the page from the start, and cannot be checked before a state.
    expect(await screen.findAllByRole("checkbox")).toHaveLength(2);
    expect(ageBox()).toBeDisabled();
    expect(ageBox()).toHaveAccessibleName("Choose your state above to see the age statement for it.");
    expect(screen.getByRole("combobox")).toHaveAccessibleName("State where you live");
    chooseState("UT");
    expect(ageBox()).toHaveAccessibleName("I'm 18 or older.");
    chooseState("WA");
    expect(ageBox()).toHaveAccessibleName("I'm 13 or older, and if I'm under 18, my organization authorized this account.");
    chooseState("");
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(ageBox()).toBeDisabled();
    expect(screen.getByText(/Terms of use, version 1\.1\.1\./)).toBeInTheDocument();
    // Acceptance line 3: the clickwrap itself says the instrument is not
    // operative yet, in the same words the legal routes publish.
    // No instrument is operative in this edition, so the page says so.
    expect(document.body.textContent).toContain(catalogue.en["legal.instrument.notOperative"]);
    // Every instrument the acceptance covers is linked at its own version,
    // at its own instrument route, with the change history beside them.
    const instrumentLinks = screen.getAllByRole("link", { name: /— version \d/ });
    expect(instrumentLinks).toHaveLength(LEGAL_INSTRUMENTS.length);
    for (const entry of LEGAL_INSTRUMENTS) {
      const link = instrumentLinks.find((node) => node.getAttribute("href") === entry.path);
      expect(link?.textContent).toContain(`version ${entry.version}`);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(screen.getByRole("link", { name: catalogue.en["legal.instrument.links.changelog"] }))
      .toHaveAttribute("href", "/legal/changelog");
    expect(screen.getByRole("link", { name: catalogue.en["legal.instrument.links.changelog"] }))
      .toHaveAttribute("target", "_blank");
    for (const name of [catalogue.en["hub.privacy"], catalogue.en["hub.terms"]]) {
      expect(screen.getByRole("link", { name, exact: true })).toHaveAttribute("target", "_blank");
    }
    expect(fetcher).not.toHaveBeenCalled();

    // The agree button alone does nothing while the box is unchecked.
    fireEvent.click(agreeButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Check the box to agree to the terms. Choose the state where you live.");
    expect(fetcher).not.toHaveBeenCalled();
    // Nor does the terms box without a state, or a state without its attestation.
    fireEvent.click(consentBox());
    fireEvent.click(agreeButton());
    expect(screen.getByRole("alert")).toHaveTextContent("Choose the state where you live");
    chooseState("TX");
    fireEvent.click(agreeButton());
    expect(screen.getByRole("alert")).toHaveTextContent(/^Check the age statement\.$/u);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends exactly the versions in force when the person agrees", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply({ accepted: true }));
    renderInvite({ fetcher });
    await screen.findAllByRole("checkbox");

    fireEvent.click(consentBox());
    chooseState();
    fireEvent.click(ageBox());
    fireEvent.click(agreeButton());

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      token: TOKEN,
      acceptedVersions: currentLegalVersions(),
      residenceState: "TX",
      ageAttested: true,
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/invitation accepted/i));
    expect(screen.getByRole("status")).toHaveTextContent(/version 1\.1\.1 was recorded/i);
  });

  it("records nothing and says so when the published versions moved while the page was open", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      reply({ error: "terms-version-stale", versions: { "terms-of-use": "9.9.9" } }, 409),
    );
    renderInvite({ fetcher });
    await screen.findAllByRole("checkbox");

    fireEvent.click(consentBox());
    chooseState();
    fireEvent.click(ageBox());
    fireEvent.click(agreeButton());

    expect(await screen.findByRole("alert")).toHaveTextContent("These terms changed while this page was open");
    expect(screen.getByRole("alert")).toHaveTextContent("Nothing was accepted and nothing was recorded");
  });

  it("carries the clickwrap and prompt copy in both co-equal locales (D-15)", () => {
    const keys = Object.keys(catalogue.en)
      .filter((key) => key.startsWith("inviteAccept.terms.")
        || key.startsWith("inviteAccept.stale")
        || key.startsWith("legalAcceptance.")
        || key.startsWith("ageRule."));
    expect(keys.length).toBeGreaterThan(15);
    for (const key of keys) {
      expect(typeof catalogue.es[key]).toBe("string");
      expect(catalogue.es[key].length).toBeGreaterThan(0);
    }
  });
});

describe("D-08 server-side enforcement in api/accept-invitation.js", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_SUPABASE_URL", BACKEND);
    vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
    vi.stubEnv("INVITATION_APP_ORIGIN", ORIGIN);
    vi.stubEnv("INVITATION_RATE_LIMIT_SECRET", "test-rate-secret-at-least-32-characters");
    vi.stubEnv("RESEND_API_KEY", "test-mail-key");
    vi.stubEnv("NOTIFY_FROM_ADDRESS", "Union Ground <test@example.com>");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function post(body) {
    const names = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const name = new URL(url).pathname.split("/").at(-1);
      names.push(name);
      if (name === "consume_member_invitation_accept_limit_for_token") return reply({ allowed: true });
      throw new Error(`unexpected ${url}`);
    }));
    const out = { status: 0, body: null };
    await handler({
      method: "POST",
      url: "/api/accept-invitation",
      body,
      headers: { origin: ORIGIN, "x-vercel-forwarded-for": "203.0.113.7" },
    }, {
      setHeader() {},
      status(code) { out.status = code; return this; },
      end(payload) { out.body = JSON.parse(payload); },
    });
    return { out, names };
  }

  it("refuses an explicitly invalid versioned acceptance before the invitation is looked up", async () => {
    const { out, names } = await post({ token: TOKEN, acceptedVersions: null });
    expect(out).toEqual({ status: 409, body: { error: "terms-version-stale", versions: currentLegalVersions() } });
    expect(names).not.toContain("claim_member_invitation");
  });

  it("refuses an acceptance for versions that are not in force", async () => {
    const stale = { ...currentLegalVersions(), "terms-of-use": "0.0.1" };
    const { out, names } = await post({ token: TOKEN, acceptedVersions: stale });
    expect(out.status).toBe(409);
    expect(names).not.toContain("claim_member_invitation");
    // An extra instrument is just as refused as a missing one.
    const extra = { ...currentLegalVersions(), "invented-instrument": "1.0.0" };
    expect((await post({ token: TOKEN, acceptedVersions: extra })).out.status).toBe(409);
  });

  it("hashes the invitation secret and never echoes it in the refusal", async () => {
    const { out } = await post({ token: TOKEN, acceptedVersions: {} });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(JSON.stringify(out)).not.toContain(createHash("sha256").update(TOKEN).digest("hex"));
  });
});

describe("D-08 re-acceptance at the next sign-in", () => {
  it("asks for nothing while the acceptance state is unknown", () => {
    expect(legalAcceptanceRequirement(null).reacceptanceRequired).toBe(false);
    expect(legalAcceptanceRequirement(null, fixtureInstruments()).reacceptanceRequired).toBe(false);
    expect(recordedLegalAcceptances(null)).toBeNull();
  });

  it("asks once after a material change, and names the instrument that changed", () => {
    const requirement = legalAcceptanceRequirement(
      { versions: { "terms-of-use": "0.1.0" }, acceptedAt: "2026-10-10T00:00:00Z" },
      fixtureInstruments(),
    );
    expect(requirement.reacceptanceRequired).toBe(true);
    expect(requirement.instruments).toEqual(["terms-of-use"]);
  });

  it("does not ask a person who already holds the material version", () => {
    const requirement = legalAcceptanceRequirement(
      { versions: { "terms-of-use": "0.2.0" }, acceptedAt: "2026-11-10T00:00:00Z" },
      fixtureInstruments(),
    );
    expect(requirement.reacceptanceRequired).toBe(false);
    expect(requirement.instruments).toEqual([]);
  });

  it("does not ask for a change that was not marked material", () => {
    expect(legalAcceptanceRequirement(
      { versions: { "terms-of-use": "0.1.0" }, acceptedAt: "2026-10-10T00:00:00Z" },
      fixtureInstruments({ material: false }),
    ).reacceptanceRequired).toBe(false);
  });

  it("reads and writes the acceptance through the two self-only database functions", async () => {
    const rpc = vi.fn(async (name) => (name === "get_my_legal_acceptance_state"
      ? { data: { versions: { "terms-of-use": "0.1.0" }, acceptedAt: "2026-10-10T00:00:00Z" }, error: null }
      : { data: { recorded: true }, error: null }));
    const state = await loadLegalAcceptanceState({ rpc });
    expect(state).toEqual({ versions: { "terms-of-use": "0.1.0" }, acceptedAt: "2026-10-10T00:00:00Z" });
    expect(await recordLegalAcceptance({ rpc }, currentLegalVersions(), "AL", true)).toBe(true);
    expect(rpc).toHaveBeenLastCalledWith("record_legal_acceptance", {
      p_versions: currentLegalVersions(),
      p_residence_state: "AL",
      p_age_attested: true,
    });
    // Without a listed state and the person's own attestation nothing is sent.
    rpc.mockClear();
    expect(await recordLegalAcceptance({ rpc })).toBe(false);
    expect(await recordLegalAcceptance({ rpc }, currentLegalVersions(), "AL", "true")).toBe(false);
    expect(await recordLegalAcceptance({ rpc }, currentLegalVersions(), "ZZ", true)).toBe(false);
    expect(await recordLegalAcceptance({ rpc }, currentLegalVersions(), "", true)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("spends a read only once a material change is published, on either platform", () => {
    // Terms of use 0.2.0 (adults-only, October 12, 2026) was the first material
    // change and 0.3.0 (app-store states, October 16) the second; the first
    // operative text, 1.0.0 (owner direction of October 16), is material for
    // every instrument, so the apps ask at sign-in.
    expect(legalAcceptanceReadNeeded()).toBe(true);
    expect(LEGAL_INSTRUMENTS.every((entry) => legalAcceptanceReadNeeded([entry]))).toBe(true);
    expect(legalAcceptanceReadNeeded(fixtureInstruments())).toBe(true);
    expect(legalAcceptanceReadNeeded(fixtureInstruments({ material: false }))).toBe(false);
    const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");
    expect(app).toContain("!legalAcceptanceReadNeeded()");
    const nativeService = readFileSync(
      resolve(process.cwd(), "apps/mobile/src/services/legalAcceptance.ts"), "utf8",
    );
    expect(nativeService).toContain("legalAcceptanceReadNeeded() !== true");
  });

  it("claims nothing about the reader when the read fails", async () => {
    expect(await loadLegalAcceptanceState({ rpc: async () => ({ data: null, error: { message: "down" } }) })).toBeNull();
    expect(await loadLegalAcceptanceState(null)).toBeNull();
  });

  it("keeps failed or malformed acceptance reads unknown and failed writes unrecorded", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await loadLegalAcceptanceState({ rpc })).toBeNull();
    expect(await loadLegalAcceptanceState({ rpc: async () => ({ data: "invalid" }) })).toBeNull();
    for (const versions of [null, [], "invalid"]) {
      expect(await loadLegalAcceptanceState({ rpc: async () => ({ data: { versions, acceptedAt: 42 } }) }))
        .toEqual({ versions: {}, acceptedAt: null });
      expect(recordedLegalAcceptances({ versions })).toBeNull();
    }
    expect(await recordLegalAcceptance(null)).toBe(false);
    expect(await recordLegalAcceptance({ rpc }, currentLegalVersions(), "TX", true)).toBe(false);
    expect(await recordLegalAcceptance({ rpc: async () => ({ data: null, error: null }) }, currentLegalVersions(), "TX", true)).toBe(false);
    expect(await recordLegalAcceptance({ rpc: async () => ({ data: { recorded: true }, error: { message: "refused" } }) }, currentLegalVersions(), "TX", true)).toBe(false);
  });

  it("records the acceptance from the prompt and reports a failure without claiming a record", async () => {
    const rpc = vi.fn(async () => ({ data: { recorded: false }, error: null }));
    const onAccepted = vi.fn();
    render(
      <LanguageProvider lang="en">
        <LegalAcceptancePrompt instruments={["terms-of-use"]} client={{ rpc }} onAccepted={onAccepted} />
      </LanguageProvider>,
    );
    fireEvent.click(agreeButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Check “I have read the current version and I agree to it.” Choose the state where you live.");

    fireEvent.click(consentBox());
    fireEvent.click(agreeButton());
    expect(screen.getByRole("alert")).toHaveTextContent(/^Choose the state where you live\.$/u);
    expect(rpc).not.toHaveBeenCalled();

    chooseState("NM");
    expect(ageBox()).toHaveAccessibleName("I'm 13 or older, and if I'm under 18, my organization authorized this account.");
    fireEvent.click(ageBox());
    fireEvent.click(agreeButton());
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("record_legal_acceptance", {
      p_versions: currentLegalVersions(),
      p_residence_state: "NM",
      p_age_attested: true,
    }));
    expect(await screen.findByRole("alert")).toHaveTextContent("nothing was stored");
    expect(onAccepted).not.toHaveBeenCalled();
  });

  // BUG-UG-TERMS-REACCEPTANCE-GATE-LOCKOUT-20261030: the database's
  // refusal of versions it does not hold is told apart from any other failure.
  it("tells a pack the database does not hold apart from an ordinary failure", async () => {
    const refusal = (error) => ({ rpc: async () => ({ data: null, error }) });
    const notCurrent = { code: "22023", message: "legal versions not current" };
    expect(await recordLegalAcceptanceOutcome(refusal(notCurrent), currentLegalVersions(), "TX", true)).toBe("unavailable");
    expect(await recordLegalAcceptance(refusal(notCurrent), currentLegalVersions(), "TX", true)).toBe(false);
    for (const error of [{ code: "22023", message: "residence state required" }, { code: "42501", message: "legal versions not current" }, { message: "offline" }]) {
      expect(await recordLegalAcceptanceOutcome(refusal(error), currentLegalVersions(), "TX", true)).toBe("failed");
    }
    expect(await recordLegalAcceptanceOutcome({ rpc: async () => ({ data: { recorded: true }, error: null }) }, currentLegalVersions(), "TX", true)).toBe("recorded");
    expect(await recordLegalAcceptanceOutcome({ rpc: vi.fn().mockRejectedValue(new Error("offline")) }, currentLegalVersions(), "TX", true)).toBe("failed");
    expect(await recordLegalAcceptanceOutcome(null, currentLegalVersions(), "TX", true)).toBe("failed");
  });

  it("says the terms are still being published, and hands the caller the release, when the database refuses the pack", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "22023", message: "legal versions not current" } }));
    const onAccepted = vi.fn();
    const onUnavailable = vi.fn();
    render(
      <LanguageProvider lang="es">
        <LegalAcceptancePrompt instruments={["privacy-policy"]} client={{ rpc }} onAccepted={onAccepted} onUnavailable={onUnavailable} />
      </LanguageProvider>,
    );
    fireEvent.click(consentBox());
    chooseState();
    fireEvent.click(ageBox());
    fireEvent.click(agreeButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(catalogue.es["legalAcceptance.unavailable"]);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onAccepted).not.toHaveBeenCalled();
    expect(agreeButton()).toBeEnabled();
  });

  it.each([true, false])("uses unavailable recovery when publication proof fails (callback=%s)", async (withCallback) => {
    const proof = vi.spyOn(legalReleaseBundle, "loadPublishedWebVersions").mockRejectedValue(new Error("legal release is not published"));
    const rpc = vi.fn();
    const onAccepted = vi.fn();
    const onUnavailable = vi.fn();
    try {
      render(
        <LanguageProvider lang="en">
          <LegalAcceptancePrompt instruments={["privacy-policy"]} client={{ rpc }} onAccepted={onAccepted} onUnavailable={withCallback ? onUnavailable : undefined} />
        </LanguageProvider>,
      );
      fireEvent.click(consentBox());
      chooseState();
      fireEvent.click(ageBox());
      fireEvent.click(agreeButton());
      expect(await screen.findByRole("alert")).toHaveTextContent(catalogue.en["legalAcceptance.unavailable"]);
      expect(onUnavailable).toHaveBeenCalledTimes(withCallback ? 1 : 0);
      expect(onAccepted).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
      expect(agreeButton()).toBeEnabled();
    } finally { proof.mockRestore(); }
  });

  // Finding 28 (g/03): the age box appears only once a state is chosen, so an
  // early submit looked like it did nothing. Focus lands on what is missing.
  it("moves focus to the first control still missing on an early submit", () => {
    render(
      <LanguageProvider lang="en">
        <LegalAcceptancePrompt instruments={["privacy-policy"]} client={{ rpc: vi.fn() }} />
      </LanguageProvider>,
    );
    fireEvent.click(agreeButton());
    expect(consentBox()).toHaveFocus();
    fireEvent.click(consentBox());
    fireEvent.click(agreeButton());
    expect(screen.getByRole("combobox")).toHaveFocus();
    chooseState("WA");
    fireEvent.click(agreeButton());
    expect(ageBox()).toHaveFocus();
    // The alert names only what is still missing, and only boxes on the page.
    expect(screen.getByRole("alert")).toHaveTextContent(/^Check the age statement\.$/u);
  });

  it("tells the caller once the acceptance is recorded", async () => {
    const rpc = vi.fn(async () => ({ data: { recorded: true }, error: null }));
    const onAccepted = vi.fn();
    render(
      <LanguageProvider lang="en">
        <LegalAcceptancePrompt instruments={["terms-of-use"]} client={{ rpc }} onAccepted={onAccepted} />
      </LanguageProvider>,
    );
    fireEvent.click(consentBox());
    chooseState();
    fireEvent.click(ageBox());
    fireEvent.click(agreeButton());
    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
  });

  // BUG-UG-LEGAL-ACCEPTANCE-ACTION-HIERARCHY-20261020: the standalone
  // card uses the dialog button family, primary accept and secondary profile.
  it.each(["en", "es"])("styles accept as the primary action and profile as the secondary one (%s)", (lang) => {
    const onProfile = vi.fn();
    render(
      <LanguageProvider lang={lang}>
        <LegalAcceptancePrompt instruments={["terms-of-use"]} client={{ rpc: vi.fn() }} onProfile={onProfile} />
      </LanguageProvider>,
    );
    const accept = screen.getByRole("button", { name: catalogue[lang]["legalAcceptance.action"] });
    const profile = screen.getByRole("button", { name: catalogue[lang]["topbar.profile"] });
    expect(accept).toHaveClass("dialog-primary");
    expect(accept).not.toHaveClass("dialog-secondary");
    expect(profile).toHaveClass("dialog-secondary");
    expect(profile).not.toHaveClass("dialog-primary");
    fireEvent.click(profile);
    expect(onProfile).toHaveBeenCalledTimes(1);
  });

  it.each(["en", "es"])("links every accepted instrument and its displayed version from the prompt (%s)", (lang) => {
    render(
      <LanguageProvider lang={lang}>
        <LegalAcceptancePrompt instruments={["terms-of-use"]} />
      </LanguageProvider>,
    );
    for (const entry of LEGAL_INSTRUMENTS) {
      const link = screen.getByRole("link", { name: `${catalogue[lang][entry.summaryTitleKey]} — ${entry.version}` });
      expect(link).toHaveAttribute("href", entry.path);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(screen.getAllByRole("link")).toHaveLength(LEGAL_INSTRUMENTS.length + 1);
  });
});

// Agree keeps focus while the acceptance is recorded,
// and two presses in one tick record one acceptance (each begins by reading
// the published versions).
describe("D-08 acceptance sends once", () => {
  function showFilled() {
    const rpc = vi.fn(async () => ({ data: { recorded: true }, error: null }));
    render(<LanguageProvider lang="en"><LegalAcceptancePrompt instruments={["terms-of-use"]} client={{ rpc }} onAccepted={vi.fn()} /></LanguageProvider>);
    fireEvent.click(consentBox());
    chooseState("TX");
    fireEvent.click(ageBox());
    return rpc;
  }

  it("records one acceptance when Agree is pressed twice in one tick", async () => {
    const rpc = showFilled();
    const agree = agreeButton();
    await expectOneWriteFromOneTick(legalProofSpy, [() => fireEvent.click(agree), () => fireEvent.click(agree)]);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
  });

  // The lock ends with the saving state, so an acceptance whose publication
  // read throws at once leaves a ready button whose next press tries again.
  it("tries again from an immediate press after a publication read that throws at once", () => {
    showFilled();
    legalProofSpy.mockImplementation(() => { throw new Error("not published"); });
    const agree = agreeButton();
    fireEvent.click(agree);
    expect(agree).not.toHaveAttribute("aria-disabled");
    fireEvent.click(agree);
    expect(legalProofSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps Agree focused while the acceptance is recorded", async () => {
    showFilled();
    await expectHeldWriteFocus(legalProofSpy, agreeButton());
  });
});

describe("D-08 on native", () => {
  it("links nothing while no Union Ground site publishes the instruments", () => {
    expect(legalAcceptanceLinks()).toEqual([]);
  });

  it("links every recorded instrument version and change history without any session data once a site is configured", async () => {
    vi.resetModules();
    vi.doMock("../apps/mobile/src/lib/legalDocuments", () => ({ LEGAL_SITE_ORIGIN: PORTAL_ORIGIN }));
    try {
      const { legalAcceptanceLinks: configuredLinks } = await import("../apps/mobile/src/lib/legalAcceptance.ts");
      const links = configuredLinks();
      expect(links).toHaveLength(LEGAL_INSTRUMENTS.length + 1);
      for (const entry of LEGAL_INSTRUMENTS) {
        expect(links).toContainEqual({
          label: `${entry.englishName} — version ${entry.version} (opens browser)`,
          url: `${PORTAL_ORIGIN}${entry.path}`,
        });
      }
      expect(links.at(-1).url).toBe(`${PORTAL_ORIGIN}/legal/changelog`);
    } finally {
      vi.doUnmock("../apps/mobile/src/lib/legalDocuments");
      vi.resetModules();
    }
  });
  it("decides and words the prompt from the same shared source as the website", () => {
    expect(nativeVersions()).toEqual(currentLegalVersions());
    expect(nativeRequirement(null, fixtureInstruments()).reacceptanceRequired).toBe(false);
    expect(nativeRequirement(
      { versions: { "terms-of-use": "0.1.0" }, acceptedAt: null },
      fixtureInstruments(),
    )).toEqual({ reacceptanceRequired: true, instruments: ["terms-of-use"] });
    expect(legalAcceptanceBody(["terms-of-use"])).toContain("Terms of use");
    expect(legalAcceptanceVersionLine()).toBe("Terms of use, version 1.1.1.");
  });

  // The native state question and both
  // attestation sentences are the English website lines, word for word.
  it("asks the state and words the attestation exactly as the website does", () => {
    expect(LEGAL_ACCEPTANCE_STATE).toBe(catalogue.en["ageRule.state"]);
    expect(LEGAL_ACCEPTANCE_STATE_CHOOSE).toBe(catalogue.en["ageRule.choose"]);
    expect(LEGAL_ACCEPTANCE_AGE_HELP).toBe(catalogue.en["ageRule.help"]);
    expect(LEGAL_ACCEPTANCE_ADULT).toBe(catalogue.en["ageRule.adult"]);
    expect(LEGAL_ACCEPTANCE_BAND).toBe(catalogue.en["ageRule.band"]);
    for (const code of ["TX", "CA", "AL", "UT", "LA"]) expect(legalAcceptanceAgeLabel(code)).toBe(LEGAL_ACCEPTANCE_ADULT);
    for (const code of ["NY", "DC", "VI", "outside-us"]) expect(legalAcceptanceAgeLabel(code)).toBe(LEGAL_ACCEPTANCE_BAND);
    for (const code of ["", "ZZ", "tx"]) expect(legalAcceptanceAgeLabel(code)).toBeNull();
  });

  it("asks on the native Home screen and nowhere else", () => {
    const home = readFileSync(resolve(process.cwd(), "apps/mobile/app/(tabs)/home.tsx"), "utf8");
    expect(home).toContain("<LegalAcceptanceCard onRequiredChange={setLegalAcceptancePending} language={memberLanguage} />");
  });
});

// The region list the pages show and the
// lists the database enforces are the same lists, so the rule a person sees is
// the rule the server records.
describe("the state-scoped age rule", () => {
  const states = readFileSync(
    resolve(process.cwd(), "supabase/migrations/20261016170000_app_store_states_age_rule.sql"), "utf8",
  );
  const sqlList = (text) => [...text.matchAll(/'([A-Za-z-]+)'/g)].map((match) => match[1]);

  it("lists the same regions in the page module and the database check", () => {
    const check = states.slice(states.indexOf("legal_acceptances_residence_state_listed"), states.indexOf("drop constraint"));
    expect(sqlList(check).sort()).toEqual(RESIDENCE_REGIONS.map((region) => region.code).sort());
    expect(RESIDENCE_REGIONS).toHaveLength(57);
  });

  it("names the same five app-store age-law states on both sides", () => {
    const adult = RESIDENCE_REGIONS.map((region) => region.code).filter((code) => ageRuleFor(code) === "adult");
    expect(adult.sort()).toEqual(["AL", "CA", "LA", "TX", "UT"]);
    const rule = states.slice(states.indexOf("create function private.residence_age_rule"), states.indexOf("revoke all on function private.residence_age_rule"));
    const [adultArm, bandArm] = rule.split("then 'adult'");
    expect(sqlList(adultArm).filter((code) => code !== "adult").sort()).toEqual(adult);
    expect(sqlList(bandArm.split("then 'band'")[0]).sort())
      .toEqual(RESIDENCE_REGIONS.map((region) => region.code).filter((code) => ageRuleFor(code) === "band").sort());
    const constraint = states.slice(states.indexOf("legal_acceptances_age_rule_by_terms_version"), states.indexOf("create function private.residence_age_rule"));
    const arms = [...constraint.matchAll(/array\[('[A-Z]{2}'(?:,'[A-Z]{2}')*)\]::text\[\]/g)];
    expect(arms).toHaveLength(2);
    for (const match of arms) expect(sqlList(match[1]).sort()).toEqual(adult);
  });

  it("accepts only listed codes, exactly as written", () => {
    for (const value of ["", "tx", "Texas", "ZZ", null, undefined, 42, " TX"]) expect(isResidenceRegion(value)).toBe(false);
    expect(ageRuleFor("tx")).toBeNull();
  });
});

describe("the acceptance store", () => {
  it("is reachable only through the definer functions", () => {
    expect(migration).toContain("revoke all on table private.legal_acceptances from public, anon, authenticated, service_role;");
    expect(migration).toContain("alter table private.legal_acceptances enable row level security;");
    expect(migration).toContain("alter table private.legal_acceptances force row level security;");
    // No policy at all on a forced-RLS private table: nothing reaches it
    // except an owner-run definer function.
    expect(migration).not.toMatch(/create policy[\s\S]*private\.legal_acceptances/);
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(contract.tableGrants).toContainEqual({
        table: "private.legal_acceptances", role, privileges: "",
      });
    }
  });

  it("records the version, the time, the person and the organization, once per organization, pack and source", () => {
    for (const column of ["user_id uuid not null", "chapter_id text not null", "terms_version text not null",
      "instrument_versions jsonb not null", "accepted_at timestamptz not null"]) {
      expect(migration).toContain(column);
    }
    expect(migration).toContain("constraint legal_acceptances_event_once unique (user_id, chapter_id, instrument_versions, source)");
    expect(migration).toContain("check (source in ('invitation', 'signin'))");
  });

  it("lets the invitation route record only through the service role, and a person only for themselves", () => {
    expect(migration).toContain("grant execute on function public.record_invitation_legal_acceptance(uuid, jsonb) to service_role;");
    expect(migration).toContain("grant execute on function public.record_legal_acceptance(jsonb) to authenticated;");
    expect(migration).toContain("grant execute on function public.get_my_legal_acceptance_state() to authenticated;");
    for (const signature of ["public.record_invitation_legal_acceptance(uuid, jsonb)",
      "public.record_legal_acceptance(jsonb)", "public.get_my_legal_acceptance_state()"]) {
      expect(migration).toContain(`revoke all on function ${signature}\n  from public, anon, authenticated, service_role;`);
    }
    // The self-only pair takes no subject parameter at all.
    expect(migration).toContain("create function public.record_legal_acceptance(p_versions jsonb)");
    expect(migration).toContain("caller := (select auth.uid());");
    expect(migration).toContain("if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then");
  });

  it("is cleared with the account and the new trigger is reviewed in the same migration", () => {
    expect(migration).toContain("create trigger legal_acceptance_clear_for_member\nafter delete on public.member_profiles");
    expect(migration).toContain("insert into private.account_lifecycle_trigger_review");
    expect(migration).toContain("and object_name = 'legal_acceptance_clear_for_member'");
    expect(contract.triggers.some((entry) => entry.name === "legal_acceptance_clear_for_member")).toBe(true);
  });

  it("holds the profile through each insert so a deletion cannot strand a row", () => {
    // Both commit orders are proved live in tests/legal-acceptance-delete-race-db.test.js.
    for (const name of ["public.record_invitation_legal_acceptance(", "public.record_legal_acceptance("]) {
      const start = migration.indexOf(`create function ${name}`);
      const body = migration.slice(start, migration.indexOf("$function$;", start));
      const lock = body.search(/from public\.member_profiles p where p\.id = (subject|caller) for key share;/);
      expect(lock).toBeGreaterThan(0);
      expect(lock).toBeLessThan(body.indexOf("insert into private.legal_acceptances"));
    }
  });

  it("names every new function in the database contract with its only grantee", () => {
    const byName = Object.fromEntries(contract.functions.map((entry) => [entry.sig, entry]));
    // The app-store states migration (20261016170000) replaced both writers
    // with signatures that take the state and the age attestation; the two
    // earlier generations must stay gone.
    expect(byName["public.record_invitation_legal_acceptance(p_invitation_id uuid, p_versions jsonb, p_residence_state text, p_age_attested boolean)"].exec).toBe("service_role");
    expect(byName["public.record_legal_acceptance(p_versions jsonb, p_residence_state text, p_age_attested boolean)"].exec).toBe("authenticated");
    expect(byName["public.legal_acceptance_residence_ready()"].exec).toBe("service_role");
    expect(byName["public.legal_acceptance_pack_ready(p_versions jsonb)"].exec).toBe("service_role");
    expect(byName["private.residence_age_rule(p_residence_state text)"].exec).toBe("");
    const absent = contract.functionsAbsent.map((entry) => entry.sig);
    for (const sig of ["public.record_invitation_legal_acceptance(uuid, jsonb)", "public.record_legal_acceptance(jsonb)",
      "public.record_invitation_legal_acceptance(uuid, jsonb, boolean)", "public.record_legal_acceptance(jsonb, boolean)"]) {
      expect(absent).toContain(sig);
    }
    expect(byName["public.get_my_legal_acceptance_state()"].exec).toBe("authenticated");
    expect(byName["private.legal_acceptance_versions(p_versions jsonb)"].exec).toBe("");
    expect(byName["private.legal_acceptance_clear_for_member()"].exec).toBe("");
  });

  it("sorts after the newest migration on Main", () => {
    const stamp = "20261010213000";
    expect(Number(stamp)).toBeGreaterThan(20261010130000);
  });
});
