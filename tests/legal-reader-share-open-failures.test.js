import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  openFailedNotice,
  openOutcome,
  SHARE_FAILED_NOTICE,
  SHARE_SHEET_DISMISSED_ACTION,
  SHARE_SHEET_SHARED_ACTION,
  shareOutcome,
} from "../apps/mobile/src/lib/legalReaderOutcome.ts";

// BUG-UG-MOBILE-LEGAL-READER-SHARE-OPEN-FAILURES-20260920: root binding
// for design-changes/DSG-20260921-legal-reader-share-open-honesty.json.
// `vitest-component-suite` is `npm run test:coverage`, and vite.config.mjs
// excludes apps/mobile/**, so the named component proof only covers these
// claims if a tests/ suite executes them. This file does: it runs the four
// acceptance outcomes and source-scans LegalDocumentScreen, including the
// iOS-only announce guard so TalkBack is not doubled.

const screen = readFileSync("apps/mobile/src/features/LegalDocumentScreen.tsx", "utf8");

describe("legal reader share and website-open honesty", () => {
  it("confirms only a platform-reported completed share", () => {
    expect(shareOutcome({ ok: true, action: SHARE_SHEET_SHARED_ACTION })).toEqual({ status: "completed" });
  });

  it("stays silent for a dismissed share sheet", () => {
    expect(shareOutcome({ ok: true, action: SHARE_SHEET_DISMISSED_ACTION })).toEqual({ status: "dismissed" });
  });

  it("turns a thrown share into the on-screen recovery notice", () => {
    expect(shareOutcome({ ok: false, error: new Error("share failed") })).toEqual({
      status: "failed",
      notice: SHARE_FAILED_NOTICE,
    });
    expect(SHARE_FAILED_NOTICE).toContain("did not complete");
    expect(SHARE_FAILED_NOTICE).toContain("still open in the reader");
  });

  it("names the public URL when a website open fails", () => {
    const url = "https://app.example.org/privacy";
    expect(openOutcome({ ok: false, url, error: new Error("cannot open") })).toEqual({
      status: "failed",
      notice: openFailedNotice(url),
    });
    expect(openFailedNotice(url)).toContain(url);
  });

  it("routes both handlers through the outcome helper and Notice", () => {
    expect(screen).toContain("outcome = shareOutcome({ ok: true, action: result.action });");
    expect(screen).toContain("outcome = shareOutcome({ ok: false, error });");
    expect(screen).toContain("outcome = openOutcome({ ok: true });");
    expect(screen).toMatch(/outcome = openOutcome\(\{ ok: false, url, error \}\);/);
    expect(screen).toContain("{notice ? <Notice>{notice}</Notice> : null}");
    expect(screen).not.toMatch(/catch\s*\{/);
  });

  it("leaves the failure announcement to the Notice surface instead of announcing twice", () => {
    // Notice already sets accessibilityLiveRegion for TalkBack and queues the
    // iOS utterance, and the repository's single announcement path bans a
    // direct announceForAccessibility call in a screen.
    expect(screen).not.toContain("announceForAccessibility");
    expect(screen).not.toContain("from '../lib/announce'");
  });
});
