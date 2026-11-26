import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { formatEasternTimestamp } from "../src/lib/easternTimestamp.js";

describe("absolute Eastern account timestamps", () => {
  it("keeps both localized winter/summer instants identical across Los Angeles and Tokyo runtimes", () => {
    const module = JSON.stringify(pathToFileURL(resolve("src/lib/easternTimestamp.js")).href);
    const script = `import { formatEasternTimestamp as format } from ${module}; console.log(JSON.stringify(['en','es'].flatMap(lang => ['2026-01-15T17:05:00Z','2026-07-15T17:05:00Z'].map(value => format(value,lang)))));`;
    const renderInZone = (TZ) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, TZ } }));
    const west = renderInZone("America/Los_Angeles");
    expect(renderInZone("Asia/Tokyo")).toEqual(west);
    expect(west.map((stamp) => stamp.text)).toEqual(expect.arrayContaining([expect.stringContaining("12:05"), expect.stringContaining("1:05")]));
  });
  it.each(["en", "es"])("uses the winter/summer Eastern offset and a 12-hour clock in %s", (lang) => {
    for (const [value, hour] of [["2026-01-15T17:05:00Z", "12:05"], ["2026-07-15T17:05:00Z", "1:05"]]) {
      const stamp = formatEasternTimestamp(value, lang);
      expect(stamp.dateTime).toBe(value.replace("Z", ".000Z"));
      expect(stamp.text).toContain(hour);
      expect(stamp.text).toMatch(/(?:PM|p\.\s*m\.) ET$/);
      expect(stamp.text).toMatch(lang === "es" ? /ene|jul/ : /Jan|Jul/);
    }
  });
  it.each([null, undefined, "", "invalid"])("rejects missing or invalid timestamp %s without an invalid datetime", (value) => {
    expect(formatEasternTimestamp(value, "en")).toBeNull();
  });
  it.each(["en", "es"])("can name standard/daylight time explicitly in %s", (lang) => {
    expect(formatEasternTimestamp("2026-01-15T17:05:00Z", lang, { daylightName: true }).text).toMatch(/12:05.* EST$/);
    expect(formatEasternTimestamp("2026-07-15T17:05:00Z", lang, { daylightName: true }).text).toMatch(/1:05.* EDT$/);
    // Both sides of each New York DST transition use the instant's offset.
    for (const [value, expected] of [
      ["2026-03-08T06:59:00Z", /1:59.* EST$/],
      ["2026-03-08T07:00:00Z", /3:00.* EDT$/],
      ["2026-11-01T05:59:00Z", /1:59.* EDT$/],
      ["2026-11-01T06:00:00Z", /1:00.* EST$/],
    ]) expect(formatEasternTimestamp(value, lang, { daylightName: true }).text).toMatch(expected);
  });
  it("preserves the supplied absolute offset in the machine-readable value", () => {
    expect(formatEasternTimestamp("2026-01-15T12:05:00-05:00", "en").dateTime).toBe("2026-01-15T17:05:00.000Z");
  });
});
