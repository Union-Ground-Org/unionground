import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { siblingIdentityIn } from "../scripts/lib/sibling-deny-list.mjs";

const config = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8"));
const indexHtml = readFileSync(join(process.cwd(), "index.html"), "utf8");

// Union Ground has no production domain yet, so there is no domain cutover
// to pin. What must hold instead is the fail-closed shape of that absence: no
// rule binds a host, no redirect leaves the deployment, and no page names a
// public origin until the owner approves one.
describe("Union Ground has no production-domain cutover", () => {
  it("binds no redirect or other rule to a host", () => {
    for (const rule of config.redirects) {
      expect(rule.has ?? [], rule.source).not.toContainEqual(expect.objectContaining({ type: "host" }));
    }
    expect(JSON.stringify(config)).not.toContain('"type":"host"');
  });

  it("sends every redirect to a path on this deployment, never to another origin", () => {
    expect(config.redirects.length).toBeGreaterThan(0);
    for (const rule of config.redirects) {
      expect(rule.destination, rule.source).toMatch(/^\/(?!\/)/);
    }
  });

  it("keeps the fixture tour on this deployment's own /m?demo=1 route", () => {
    expect(config.redirects).toContainEqual({ source: "/demo", destination: "/m?demo=1", permanent: false });
    expect(config.redirects.find((rule) => rule.source === "/pre" || rule.source === "/pre/")).toBeUndefined();
  });

  it("names no sibling-product or retired domain anywhere in the deployment config or entry page", () => {
    for (const text of [JSON.stringify(config), indexHtml]) {
      expect(text).not.toMatch(/unionground\.net|demo\.unionground/i);
      expect(siblingIdentityIn(text)).toEqual([]);
    }
  });

  it("publishes no canonical public origin", () => {
    expect(indexHtml).not.toMatch(/<link[^>]+rel="canonical"/);
    expect(indexHtml).not.toMatch(/property="og:(url|image)"/);
    expect(indexHtml).toContain('<meta property="og:site_name" content="Union Ground" />');
  });
});
