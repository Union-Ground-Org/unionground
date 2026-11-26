// @vitest-environment node
import { describe, expect, it } from "vitest";
import postcss from "postcss";
import { createRequire } from "node:module";
import { splitRouteStyles } from "../scripts/lib/route-styles.mjs";
import { verifyRouteStyleOrder } from "../scripts/lib/route-style-order.mjs";

const source = ".kan-card { color: red; display: grid; padding: 8px; } .outside { color: blue; }";
const sources = ['"kan-card outside"'];
const { transform } = createRequire(import.meta.resolve("vite"))("lightningcss");
const emit = (css) => transform({ filename: "fixture.css", code: Buffer.from(css), minify: true,
  targets: { edge: 88 << 16, firefox: 78 << 16, chrome: 87 << 16, safari: 14 << 16 } }).code.toString();
function fixture() {
  const partitions = splitRouteStyles(source, { sources });
  return { source, sources, partitions, criticalAsset: "head.css",
    assets: { "head.css": emit(partitions.critical), "kan.css": emit(partitions.kan) } };
}

describe("production route stylesheet order verifier", () => {
  it("checks emitted fragments against the source declaration order", async () => {
    expect(await verifyRouteStyleOrder(fixture())).toEqual({ declarations: 4, fragments: 3, movedFragments: 1, assets: 2 });
  });

  it("rejects a reordered partition before a minifier can hide it", async () => {
    const input = fixture();
    input.partitions.kan = ".kan-card { padding: 8px; display: grid; }";
    await expect(verifyRouteStyleOrder(input)).rejects.toThrow(/Changed declaration order inside fragment/);
  });

  it("rejects reordered declarations in the actual emitted asset", async () => {
    const input = fixture();
    const emitted = postcss.parse(input.assets["kan.css"]);
    emitted.first.nodes.reverse();
    input.assets["kan.css"] = emitted.toString();
    await expect(verifyRouteStyleOrder(input)).rejects.toThrow(/Emitted fragment missing, misplaced or reordered/);
  });

  it("rejects a lazy fragment emitted only into the head sheet", async () => {
    const input = fixture();
    input.assets["head.css"] += input.assets["kan.css"];
    input.assets["kan.css"] = "";
    await expect(verifyRouteStyleOrder(input)).rejects.toThrow(/Emitted fragment missing, misplaced or reordered/);
  });

  it("rejects a critical rival copied into the actual lazy output", async () => {
    const input = fixture();
    input.assets["kan.css"] += ".kan-card { color: red; }";
    await expect(verifyRouteStyleOrder(input)).rejects.toThrow(/Cross-sheet emitted declaration/);
  });

  it("rejects a new rival introduced only in the emitted assets", async () => {
    const input = fixture();
    input.sources = ['"kan-card outside emitted-rival"'];
    input.assets["extra.css"] = ".emitted-rival { display: block; }";
    await expect(verifyRouteStyleOrder(input)).rejects.toThrow(/Unaccounted emitted rival/);
  });

  it("rejects an equal-specificity critical rival that originally followed the moved rule", async () => {
    const input = fixture();
    input.partitions.critical = ".outside { color: blue; }";
    input.partitions.kan = ".kan-card { color: red; display: grid; padding: 8px; }";
    await expect(verifyRouteStyleOrder(input)).rejects.toThrow(/Cross-sheet equal-specificity rival/);
  });

  it("rejects equal-specificity rivals in distinct lazy sheets", async () => {
    const input = { source: ".kan-card { padding: 8px; } .tasks-card { padding: 9px; }", sources: ['"kan-card tasks-card"'],
      partitions: { critical: "", kan: ".kan-card { padding: 8px; }", tasks: ".tasks-card { padding: 9px; }" },
      criticalAsset: "head.css", assets: { "head.css": "" } };
    await expect(verifyRouteStyleOrder(input)).rejects.toThrow(/Cross-sheet equal-specificity rival/);
  });

  it("checks aliases and later component sheets independently of the splitter's placement", async () => {
    const input = { source: ".kan-card { inline-size: 10px; }", sources: ['"kan-card outside"'],
      partitions: { critical: "", kan: ".kan-card { inline-size: 10px; }" },
      laterSheets: [{ path: "component.css", css: ".outside { height: 20px; }" }],
      criticalAsset: "head.css", assets: { "head.css": "" } };
    await expect(verifyRouteStyleOrder(input)).rejects.toThrow(/component.css/);
  });

  it("checks wrapper identity and preserves repeated fallback order", async () => {
    const input = { source: "@media (max-width: 700px) { .kan-card { display: -webkit-box; display: flex; padding: 8px; } }",
      sources: ['"kan-card"'], criticalAsset: "head.css" };
    input.partitions = splitRouteStyles(input.source, { sources: input.sources });
    input.assets = { "head.css": emit(input.partitions.critical), "kan.css": emit(input.partitions.kan) };
    expect((await verifyRouteStyleOrder(input)).movedFragments).toBe(1);
    const root = postcss.parse(input.assets["kan.css"]);
    root.first.params = "(max-width: 701px)";
    input.assets["kan.css"] = root.toString();
    await expect(verifyRouteStyleOrder(input)).rejects.toThrow(/Emitted fragment/);
  });

  it("handles the minifier's charset header without losing a unicode fragment", async () => {
    const input = { source: '.kan-card::before { content: "→"; display: block; }', sources: ['"kan-card"'], criticalAsset: "head.css" };
    input.partitions = splitRouteStyles(input.source, { sources: input.sources });
    input.assets = { "head.css": emit(input.partitions.critical), "kan.css": emit(input.partitions.kan) };
    expect((await verifyRouteStyleOrder(input)).movedFragments).toBe(1);
  });
});
