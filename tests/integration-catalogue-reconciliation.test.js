import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogue, t } from "../src/lib/i18n.js";

const REQUIRED_GLOBAL_KEYS = [
  "eventsDesk.navLabel",
  "eventsDesk.title",
  "eventsDesk.sub",
  "eventsDesk.empty",
  "toast.loadFailed",
  "admin.actionCancelEvent",
  "admin.actionRestoreEvent",
  "admin.actionDeleteEvent",
  "coordinator.sliceTitle",
  "coordinator.sliceBody",
  "coordinator.sliceError",
  "coordinator.sliceRetry",
  "coordinator.sliceLoadMore",
];

describe("integration catalogue reconciliation", () => {
  it.each(REQUIRED_GLOBAL_KEYS)("translates %s in English and Spanish without exposing its key", (key) => {
    expect(catalogue.en[key], `missing English ${key}`).toBeTypeOf("string");
    expect(catalogue.es[key], `missing Spanish ${key}`).toBeTypeOf("string");
    expect(t("en", key)).not.toBe(key);
    expect(t("es", key)).not.toBe(key);
  });

  it("preserves the coordinator page-count interpolation in both languages", () => {
    expect(t("en", "coordinator.sliceBody", { count: 12 })).toContain("12");
    expect(t("es", "coordinator.sliceBody", { count: 12 })).toContain("12");
  });

  it("passes the translated Events desk subtitle through PlaneHeader's supported prop", () => {
    const source = readFileSync(resolve(process.cwd(), "src/views/EventsDeskView.jsx"), "utf8");
    expect(source).toContain('sub={t("eventsDesk.sub")}');
    expect(source).not.toContain('subtitle={t("eventsDesk.sub")}');
  });
});
