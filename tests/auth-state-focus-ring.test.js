import { existsSync } from "node:fs";
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { InvitationAcceptView } from "../src/views/InvitationAcceptView.jsx";
import { PublicInterestStopConfirmView } from "../src/views/PublicInterestStopConfirmView.jsx";
import { mountStylesheets, styleRule } from "./helpers/appStylesheet.js";
import * as legalReleaseBundle from "../src/lib/legalReleaseBundle.js";
import { publishedVersionsWithProof } from "./helpers/legal-publication.js";

// The bundled legal release is published only with the deployment's proof
// (tests/helpers/legal-publication.js); this file renders acceptance against it.
let legalProofSpy;
beforeEach(() => {
  legalProofSpy = vi.spyOn(legalReleaseBundle, "loadPublishedWebVersions").mockImplementation(publishedVersionsWithProof);
});
afterEach(() => legalProofSpy?.mockRestore());


// BUG-UG-WEB-AUTH-ERROR-FOCUS-RING-CUTS-HEADING-20261002. The
// invitation-style pages move focus to their error block on load so a screen
// reader announces it. The block's ring paints outline-width + outline-offset
// outside it, but `.auth-card h1 { margin: 0 }` and `.auth-card > p` outranked
// the card's own `.iac-title` and `.iac-legal` margins, so the ring ran through
// the heading and touched the footer line. The cascade below is the real one:
// jsdom applies specificity to the mounted stylesheet.

const response = (payload, status) => ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) });
const offline = () => vi.fn().mockRejectedValue(new Error("offline"));

const VIEWS = [
  {
    name: "/invite",
    View: InvitationAcceptView,
    url: "/invite#invite=abcdefghijklmnopqrstuvwxyzABCDEFGH123456789",
    states: { unavailable: () => vi.fn().mockResolvedValue(response({}, 410)), retry: offline },
    // REQ-UG-VERSIONED-TERMS-ACCEPTANCE-20261010, owner decision
    // D-08: /invite now shows the versioned clickwrap first and exchanges
    // nothing until the person agrees, so the state blocks this file is about
    // only exist after that step. The fixture agrees the way a person does.
    // Everything the ring assertions check is unchanged.
    reach: async () => {
      // A state, then both boxes: the terms and the age attestation it
      // selects.
      fireEvent.change(await screen.findByRole("combobox"), { target: { value: "TX" } });
      for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
      fireEvent.click(screen.getByRole("button", { name: "Agree and accept the invitation" }));
    },
  },
  {
    name: "/stop-updates",
    View: PublicInterestStopConfirmView,
    url: `/stop-updates#confirm=${"stop-confirm-proof-".padEnd(43, "x")}`,
    states: { unavailable: () => vi.fn().mockResolvedValue(response({ error: "confirmation-unavailable" }, 410)), retry: offline },
  },
];

let unmountStyles;
beforeAll(() => { unmountStyles = mountStylesheets(); });
afterAll(() => unmountStyles());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function ringReach() {
  const rule = styleRule(".iac-state:focus-visible");
  const width = Number.parseFloat(rule.getPropertyValue("outline-width") || rule.getPropertyValue("outline").match(/(\d+(?:\.\d+)?)px/)?.[1]);
  const offset = Number.parseFloat(rule.getPropertyValue("outline-offset"));
  return width + offset;
}

const px = (node, property) => Number.parseFloat(getComputedStyle(node).getPropertyValue(property)) || 0;

function expectRingClear(block) {
  const card = block.closest(".iac-card");
  const title = card.querySelector(".iac-title");
  const legal = card.querySelector(".iac-legal");
  const reach = ringReach();
  expect(reach).toBeGreaterThan(0);
  // The card is a grid, so adjacent margins add up rather than collapse.
  expect(px(title, "margin-bottom") + px(block, "margin-top"), "ring clears the heading").toBeGreaterThanOrEqual(reach);
  expect(px(block, "margin-bottom") + px(legal, "margin-top"), "ring clears the footer line").toBeGreaterThanOrEqual(reach);
  expect(title.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(block.compareDocumentPosition(legal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

function renderView({ View, url }, fetcher) {
  window.history.replaceState({}, "", url);
  render(h(LanguageProvider, { lang: "en" }, h(View, { fetcher })));
}

describe("script-focused state blocks on the invitation-style card", () => {
  it("keeps the shared ring visible: the focus rule is a 2px+ outline set off from the block", () => {
    expect(ringReach()).toBeGreaterThanOrEqual(7);
    expect(styleRule(".iac-state:focus-visible").getPropertyValue("outline-style") || styleRule(".iac-state:focus-visible").getPropertyValue("outline")).toMatch(/solid/);
  });

  for (const view of VIEWS) {
    for (const [state, makeFetcher] of Object.entries(view.states)) {
      it(`${view.name}: the ${state} alert takes focus and its ring clears the heading and footer`, async () => {
        renderView(view, makeFetcher());
        if (view.reach) await view.reach();
        const alert = await screen.findByRole("alert");
        await waitFor(() => expect(alert).toHaveFocus());
        expect(alert).toHaveClass("iac-state");
        expect(alert).toHaveAttribute("tabindex", "-1");
        expectRingClear(alert);
      });
    }
  }

  it("/stop-updates: a link without a token lands on the focused unavailable alert with the same spacing", async () => {
    const fetcher = vi.fn();
    renderView({ ...VIEWS[1], url: "/stop-updates" }, fetcher);
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveFocus());
    expectRingClear(alert);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not ship the left-out organization claim confirmation page", () => {
    // The public union catalog and its claim flow (/unions/claim/confirm) are
    // left out of Union Ground, so the card has no third page.
    expect(existsSync(new URL("../src/views/OrganizationClaimConfirmView.jsx", import.meta.url))).toBe(false);
  });

  it("/invite: a successful exchange keeps focus where it was and the same spacing", async () => {
    renderView(VIEWS[0], vi.fn().mockResolvedValue(response({ accepted: true }, 200)));
    await VIEWS[0].reach();
    const status = await screen.findByRole("status");
    await waitFor(() => expect(status).toHaveTextContent(/invitation accepted/i));
    expect(status).not.toHaveFocus();
    expectRingClear(status);
  });
});
