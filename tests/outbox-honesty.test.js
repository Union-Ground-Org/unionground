import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_ENTRY_AGE_DAYS,
  MAX_ENTRY_AGE_MS,
  replayNotice,
} from "../src/lib/outbox.js";
import { catalogue, t } from "../src/lib/i18n.js";

const DAY = 86400000;
const pass = (over = {}) => ({ replayed: 0, failed: [], expired: 0, halted: false, ...over });
const APP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "App.jsx"), "utf8");

describe("a replay pass reports discarded work ahead of applied work", () => {
  // The defect this PR exists for. replayQueue deletes entries older than the
  // age cap and counts them in `expired`; nothing read that field, so the only
  // notice a member saw was the one counting what SUCCEEDED.
  it("does not say 'synced 2' when it also discarded 3", () => {
    const [key, params] = replayNotice(pass({ replayed: 2, expired: 3 }));

    expect(key).toBe("offline.expiredMany");
    expect(params).toEqual({ count: 3, days: MAX_ENTRY_AGE_DAYS });
    expect(t("en", key, params)).toContain("discarded");
    expect(t("en", key, params)).not.toContain("Synced");
  });

  it("outranks a failure too — a discard is already irreversible, a failure is not", () => {
    const [key] = replayNotice(pass({ expired: 1, failed: [{ kind: "x", message: "no" }] }));
    expect(key).toBe("offline.expiredOne");
  });

  it.each([
    ["one discarded", pass({ expired: 1 }), "offline.expiredOne", { days: MAX_ENTRY_AGE_DAYS }],
    ["many discarded", pass({ expired: 4 }), "offline.expiredMany", { count: 4, days: MAX_ENTRY_AGE_DAYS }],
    ["one failure", pass({ failed: [{ kind: "a", message: "m" }] }), "offline.syncFailedOne", undefined],
    ["many failures", pass({ failed: [{}, {}] }), "offline.syncFailedMany", { count: 2 }],
    ["one applied", pass({ replayed: 1 }), "offline.syncedOne", undefined],
    ["many applied", pass({ replayed: 3 }), "offline.syncedMany", { count: 3 }],
  ])("%s", (_label, result, key, params) => {
    expect(replayNotice(result)).toEqual([key, params]);
  });

  it("says nothing when a pass did nothing", () => {
    expect(replayNotice(pass())).toBeNull();
  });
});

describe("halted never reaches a member-facing string", () => {
  // replayQueue sets halted:true on TWO different returns — !stillActing()
  // (the member signed out or switched, and someone else may be holding the
  // phone) and isOfflineError (the connection dropped). Nothing in the result
  // distinguishes them. Any notice keyed on halted therefore also fires on the
  // identity-change branch, which is why there is no such notice, and why the
  // absence is pinned rather than left to a comment.
  it.each([
    ["halted with nothing else", pass({ halted: true })],
    ["halted after a partial pass", pass({ halted: true, replayed: 0, expired: 0 })],
  ])("%s produces no notice at all", (_label, result) => {
    expect(replayNotice(result)).toBeNull();
  });

  it("does not let halted change what an otherwise-identical pass says", () => {
    for (const result of [pass({ replayed: 2 }), pass({ expired: 2 }), pass({ failed: [{}] })]) {
      expect(replayNotice({ ...result, halted: true })).toEqual(replayNotice({ ...result, halted: false }));
    }
  });

  it("has no notice string anywhere in the catalogue that mentions halting", () => {
    // A future key called offline.halted* would be the first half of the leak.
    const suspicious = Object.keys(catalogue.en).filter((key) => /^offline\.halt/i.test(key));
    expect(suspicious, "an offline.halt* key exists — read replayNotice before wiring it").toEqual([]);
  });
});

describe("App.jsx is actually wired to both helpers", () => {
  // A SOURCE-LEVEL guard, and it is worth naming that plainly: it pins that
  // the call sites exist, not that they render. Everything above tests pure
  // functions, so reverting App.jsx to its old inline chain would leave every
  // other assertion in this file green while the member sees nothing new. The
  // honest alternative is standing up a session, an outbox store and a full
  // render for each call site; this is the proportionate check, with its
  // limit stated.

  it("routes the replay notice through replayNotice", () => {
    expect(APP, "App.jsx no longer imports replayNotice").toMatch(/\breplayNotice\b/);
    // Bind the computed tuple to the setNotice consumer on the next line.
    // Keeping replayNotice(result) while discarding the value must fail here.
    expect(
      APP.match(
        /const (\w+) = replayNotice\(\s*result\s*\);\s*\n\s*if \(\1\) setNotice\(trRef\.current\(\.\.\.\1\)\);/,
      ),
      "App.jsx computes replayNotice(result) and drops it instead of handing it to setNotice",
    ).not.toBeNull();
  });

  it("no longer decides the replay notice inline", () => {
    // The old chain read result.replayed and result.failed directly to pick a
    // string. If those come back, precedence has been forked away from the
    // tested function and result.expired can be dropped again without failing.
    expect(APP, "App.jsx picks an offline.sync* string inline again").not.toMatch(
      /setNotice\([^)]*offline\.sync/,
    );
  });

  // BUG-UG-WEB-HOME-REPAINTS-PREVIOUS-CHAPTER-AFTER-SWITCH-20261111:
  // no saved copy is ever painted, so no banner, age or recovery loop is
  // wired to one, and nothing in App writes or reads a snapshot.
  it("paints no saved copy and keeps no stale-copy state", () => {
    expect(APP).not.toMatch(/snapshotAgeNotice|setStale\(|staleAt|loadSnapshot|saveSnapshot/);
    expect(APP).not.toMatch(/tr\(\s*["']offline\.stale/);
    expect(APP).toMatch(/if \(remaining > 0\) rearm\(\);/);
  });

  // SEC-UG-SIGNOUT-OUTBOX-DRAFTS-20260817. Same stated limit as the guards
  // above: this pins that BOTH departure paths call the purge, not that they
  // render. purgeSensitiveEntries' own behaviour — which kinds go, which stay,
  // whose entries are touched — is proven against real stores in outbox.test.js.
  // The wiring is the part a refactor can silently drop, and dropping it leaves
  // the member's draft text on a shared device with nothing else failing.
  it("purges sensitive queue kinds on BOTH explicit sign-out and account deletion", () => {
    const purges = APP.match(/purgeSensitiveEntries\(\s*outboxStoreRef\.current,\s*userId\s*\)/g) ?? [];
    // Sign-out purges once before teardown and once after its local session
    // clear, so a projection write completing between those two edges cannot
    // restore the departing member's sensitive queue payload.
    expect(purges, "App.jsx does not purge sensitive outbox kinds on both departure paths").toHaveLength(3);
    expect(APP.match(/await purgeSensitiveEntries\(/g) ?? [], "the purge is not awaited before teardown").toHaveLength(3);
  });

  it("keeps each purge inside its departure path, ahead of the sign-out call", () => {
    const signOut = APP.match(/async function signOutAndForget\([\s\S]*?\n {2}\}/)?.[0] ?? "";
    const deletion = APP.match(/async function handleDeleteAccount\([\s\S]*?\n {2}\}/)?.[0] ?? "";
    for (const [name, body, teardown] of [
      ["signOutAndForget", signOut, "signOutSafely("],
      ["handleDeleteAccount", deletion, "supabase.auth.signOut("],
    ]) {
      expect(body, `${name} was not found in App.jsx`).not.toBe("");
      expect(body, `${name} no longer purges sensitive outbox kinds`).toContain("purgeSensitiveEntries(");
      expect(
        body.indexOf("purgeSensitiveEntries("),
        `${name} purges after session teardown, not before`,
      ).toBeLessThan(body.indexOf(teardown));
    }
  });

  it("keeps the post-clear purge of any leftover snapshot after session teardown", () => {
    const signOut = APP.match(/async function signOutAndForget\([\s\S]*?\n {2}\}/)?.[0] ?? "";

    expect(signOut, "signOutAndForget was not found in App.jsx").not.toBe("");
    expect(signOut.lastIndexOf("purgeSensitiveEntries(")).toBeGreaterThan(signOut.indexOf("signOutSafely("));
    const postClear = signOut.slice(signOut.indexOf("onLocalSessionCleared:"));
    // indexOf() is -1 for a missing needle, so pin presence before pinning order:
    // deleting the generation advance must fail, not silently pass.
    expect(postClear, "the post-clear purge must advance the session generation").toContain("beginSessionGeneration(null)");
    expect(postClear, "the post-clear purge must await the snapshot delete").toContain("await deleteSnapshot(");
    expect(postClear.indexOf("beginSessionGeneration(null)")).toBeLessThan(postClear.indexOf("await deleteSnapshot("));
  });

  // The sibling the record above missed: a session can end without anybody
  // pressing "Sign out" — a revoked or expired refresh token, an account
  // deactivation, a peer tab's durable tombstone. What forgetDepartedMemberDevice
  // DOES — and whether the cold-start boots actually reach it — is proven
  // behaviourally: tests/member-boot-app.test.jsx renders the real app against
  // a seeded store, and tests/outbox.test.js proves the erasure against both
  // real backends. What is left here is a COUNT, and only a count: it fails
  // when a refactor drops a call site altogether, and it deliberately pins no
  // source text, because a pinned line passes just as happily over a branch
  // that can never execute.
  it("wires the same purge into every implicit departure in the auth effect", () => {
    const effectStart = APP.indexOf("if (!hasAppBackend || demoActive) return undefined;");
    const authEffect = APP.slice(effectStart, APP.indexOf("}, [beginSessionGeneration, demoActive, landSignedOutAtRoot]);", effectStart));
    const departures = authEffect.match(/forgetDepartedMemberDevice\(/g) ?? [];

    // The sixth departure is the retired preview host refusing a restored
    // non-persona session (BUG-UG-REMOVE-RETIRED-PREVIEW-INVITATION-20261020).
    expect(
      departures,
      "the two cold-start boots, the closed-lineage, publish, storage-event and retired-host refusal departures do not all purge the device",
    ).toHaveLength(6);
    expect(
      authEffect,
      "the publish-path purge is not guarded on a real identity change, so a token refresh would purge",
    ).toContain("previousSession.user.id !== nextSession?.user?.id");
  });
});

describe("the copy is real in both languages and cannot drift from the age cap", () => {
  const ADDED = [
    "offline.expiredOne",
    "offline.expiredMany",
    "app.homeNeedsConnection",
  ];

  it("resolves in en and es", () => {
    for (const key of ADDED) {
      for (const lang of ["en", "es"]) {
        expect(typeof catalogue[lang][key], `${key} missing in ${lang}`).toBe("string");
        expect(catalogue[lang][key].trim().length, `${key} empty in ${lang}`).toBeGreaterThan(0);
      }
    }
  });

  it("is actually translated, not the English string pasted into es", () => {
    // t() falls back to catalogue.en for a missing key, and the existing parity
    // test (tests/i18n-coverage.test.jsx) only asserts es is present and
    // non-empty. So an untranslated string renders correctly-looking English to
    // a Spanish member and stays green.
    //
    // LIMIT, measured rather than assumed: this is byte-inequality, so it
    // catches a WHOLE value pasted across (mutation N4a) and does NOT catch a
    // half-finished translation with an English clause left in it (N4b, which
    // was run and escaped). Detecting that needs a language check, not an
    // equality check. Stated here so the next reader does not credit this
    // assertion with more reach than it has.
    for (const key of ADDED) {
      expect(catalogue.es[key], `${key} es is byte-identical to en`).not.toBe(catalogue.en[key]);
    }
  });

  it("interpolates the age cap rather than hardcoding a number", () => {
    // If the window changes, the sentence has to change with it. These keys
    // must carry {days}, and MAX_ENTRY_AGE_DAYS must be derived from the same
    // constant replayQueue actually compares against.
    for (const lang of ["en", "es"]) {
      expect(catalogue[lang]["offline.expiredOne"], `expiredOne ${lang}`).toContain("{days}");
      expect(catalogue[lang]["offline.expiredMany"], `expiredMany ${lang}`).toContain("{days}");
    }
    expect(MAX_ENTRY_AGE_DAYS).toBe(MAX_ENTRY_AGE_MS / DAY);

    const [key, params] = replayNotice(pass({ expired: 2 }));
    expect(t("en", key, params)).toContain(String(MAX_ENTRY_AGE_DAYS));
    expect(t("es", key, params)).toContain(String(MAX_ENTRY_AGE_DAYS));
  });

  it("leaves no {placeholder} unfilled in either language", () => {
    // t() renders an undefined var as "", so a key naming a param its caller
    // never passes silently loses a word. Render every added key through the
    // params its own call site supplies and assert nothing is left over.
    const rendered = [
      replayNotice(pass({ expired: 1 })),
      replayNotice(pass({ expired: 5 })),
      ["app.homeNeedsConnection", undefined],
    ];
    for (const [key, params] of rendered) {
      for (const lang of ["en", "es"]) {
        const text = t(lang, key, params);
        expect(text, `${key} ${lang} left a placeholder`).not.toMatch(/\{\w+\}/);
        expect(text.trim().length, `${key} ${lang} rendered empty`).toBeGreaterThan(0);
        expect(text, `${key} ${lang} rendered a double space where a var went missing`).not.toMatch(/ {2}/);
      }
    }
  });
});
