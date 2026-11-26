// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { learningKinds } from "../scripts/lib/learning-period-parity.mjs";
import { learningPeriodCatalogue, learningPeriodT } from "../src/lib/i18n/learningPeriod.js";
import { learningPeriodCopy } from "../apps/mobile/src/lib/learningPeriodCopy";
import { PERMANENT_STATUS, entryStatus, kindText, undoSummary } from "../src/features/learningPeriod/model.js";

// BUG-UG-LEARNING-HISTORY-KIND-LINES-MISSING-20261106 (#7182): every
// kind the server journals has its own practice-history line in English and
// Spanish on web and in the native app's copy, and every permanent kind says
// Sent, Kept or Final by an explicit choice. The kinds come from the
// registry the migrations build (private.learning_action_kinds), read with
// the same parser the writer parity test uses, so a slice that registers a
// kind without a line fails here.
const dir = path.join(process.cwd(), "supabase", "migrations");
const texts = fs.readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()
  .map((name) => fs.readFileSync(path.join(dir, name), "utf8"));
const registry = new Map(learningKinds(texts).map((kind) => [kind.actionKind, kind]));
// Excluded kinds are never journalled (private.learning_journal_append
// returns null for them), so they never reach the history.
const journalled = [...registry.values()].filter((kind) => kind.disposition !== "excluded").map((kind) => kind.actionKind).sort();
const permanent = [...registry.values()].filter((kind) => kind.disposition === "permanent").map((kind) => kind.actionKind).sort();
const en = (key, vars) => learningPeriodT("en", key, vars);
const es = (key, vars) => learningPeriodT("es", key, vars);

function row(id, actionKind, extra = {}) {
  return {
    id, actionKind, domain: "messages", disposition: "permanent", targetTable: "public.conversations", targetId: "c1",
    parentEntryId: null, state: "kept", version: 1, createdAt: "2026-11-04T14:00:00Z", undoneAt: null, keptAt: null,
    sent: false, undoable: false, ...extra,
  };
}

describe("practice history lines", () => {
  it("reads the whole registry", () => {
    expect(journalled.length).toBeGreaterThanOrEqual(129);
    expect(permanent.length).toBeGreaterThanOrEqual(36);
  });

  it("names every journalled kind in English and Spanish on web and in the native copy", () => {
    const missing = [];
    for (const kind of journalled) {
      const key = `learningPeriod.kind.${kind}`;
      if (!Object.hasOwn(learningPeriodCatalogue.en, key)) missing.push(`${kind}: web English`);
      if (!Object.hasOwn(learningPeriodCatalogue.es, key)) missing.push(`${kind}: web Spanish`);
      if (!Object.hasOwn(learningPeriodCopy, key)) missing.push(`${kind}: native`);
    }
    expect(missing).toEqual([]);
  });

  it("never falls back to the domain line, and no two kinds share a line", () => {
    for (const t of [en, es]) {
      const seen = new Map();
      for (const kind of journalled) {
        const line = kindText({ actionKind: kind, domain: "cases" }, t);
        expect(line, kind).not.toBe(t("learningPeriod.kind.fallback", { domain: t("learningPeriod.domain.cases") }));
        expect(seen.get(line), `${kind} and ${seen.get(line)} read the same`).toBeUndefined();
        seen.set(line, kind);
      }
    }
  });

  it("keeps the honest promise in every line", () => {
    for (const kind of journalled) {
      expect(en(`learningPeriod.kind.${kind}`), kind).not.toMatch(/unsen|recall|erase/i);
      expect(es(`learningPeriod.kind.${kind}`), kind).not.toMatch(/\bborr(?:aste|ado)\b|anul/i);
    }
  });
});

describe("permanent history lines", () => {
  it("decides Sent, Kept or Final for exactly the registry's permanent kinds", () => {
    expect(Object.keys(PERMANENT_STATUS).sort()).toEqual(permanent);
    for (const status of Object.values(PERMANENT_STATUS)) expect(["sent", "kept", "final"]).toContain(status);
  });

  it("says Sent only for kinds that went out", () => {
    for (const kind of permanent) {
      expect(entryStatus(row("1", kind), { running: true }).status, kind).toBe(PERMANENT_STATUS[kind]);
    }
    expect(entryStatus(row("1", "message_send"), { running: true }).status).toBe("sent");
    expect(entryStatus(row("1", "message_remove"), { running: true }).status).toBe("final");
    expect(entryStatus(row("1", "chapter_membership_revoke_final"), { running: true }).status).toBe("final");
    expect(entryStatus(row("1", "retaliation_report_submit"), { running: true }).status).toBe("kept");
    expect(entryStatus(row("1", "live_poll_edit"), { running: true }).status).toBe("kept");
    expect(entryStatus(row("1", "some_later_permanent_kind"), { running: true }).status).toBe("kept");
  });

  it("lists only what went out as staying sent in the confirmation", () => {
    const entries = [
      row("send", "message_send", { createdAt: "2026-11-04T14:03:00Z" }),
      row("edit", "message_edit", { createdAt: "2026-11-04T14:02:00Z" }),
      row("removed", "message_remove", { createdAt: "2026-11-04T14:01:30Z" }),
      row("react", "message_react", { disposition: "reverse", state: "active", undoable: true, createdAt: "2026-11-04T14:01:00Z" }),
    ];
    expect(undoSummary("react", entries).staysSent.map((entry) => entry.id)).toEqual(["send", "edit"]);
  });
});
