// @vitest-environment node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import postcss from "postcss";
import { JSDOM } from "jsdom";
import { expect, it } from "vitest";
import { readRouteStyles, routeStyleInputs } from "../scripts/lib/route-styles.mjs";
import { verifyRouteStyleOrder } from "../scripts/lib/route-style-order.mjs";
import { isDeployedDesignAsset } from "../scripts/prune-deployed-design.mjs";
import { PUBLIC_STATIC_ROUTES } from "../scripts/public-route-metadata.mjs";
import { STANDALONE_DOCUMENT } from "../scripts/member-shell-build.mjs";

// Independent of the selection implementation: every copied rule must be
// complete and remain at its source position, under identical wrappers.
function orderedCopy(full, copy) {
  let cursor = 0;
  for (const node of copy) {
    let found = false;
    for (; cursor < full.length; cursor += 1) {
      const original = full[cursor];
      if (original.type !== node.type) continue;
      const container = node.type === "atrule" && node.nodes && !/^(?:font-face|(?:-webkit-)?keyframes)$/.test(node.name);
      if (container ? original.name === node.name && original.params === node.params && orderedCopy(original.nodes ?? [], node.nodes)
        : original.toString() === node.toString()) {
        found = true;
        cursor += 1;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

async function htmlFiles(directory, prefix = "") {
  const result = [];
  for (const file of await readdir(join(directory, prefix), { withFileTypes: true })) {
    if (file.isDirectory()) result.push(...await htmlFiles(directory, join(prefix, file.name)));
    else if (file.name.endsWith(".html")) result.push(join(prefix, file.name));
  }
  return result;
}

it("rejects a changed, reordered or added critical rule", () => {
  const full = postcss.parse("a{color:red}b{color:blue}@media(min-width:1px){a{margin:0}b{padding:0}}").nodes;
  for (const copy of ["a{color:pink}", "b{color:blue}a{color:red}", "c{color:red}", "@media(min-width:2px){a{margin:0}}"]) {
    expect(orderedCopy(full, postcss.parse(copy).nodes)).toBe(false);
  }
  expect(orderedCopy(full, postcss.parse("a{color:red}@media(min-width:1px){b{padding:0}}").nodes)).toBe(true);
});

it("preserves the original full asset, its critical copy and the production route cascade", async () => {
  const root = process.cwd(), directory = await mkdtemp(join(tmpdir(), "route-style-production-"));
  const env = { ...process.env, NODE_ENV: "production", SENTRY_AUTH_TOKEN: "" };
  // Vitest disables the route plugin in its own config. A fresh Vite CLI
  // process must use the real production configuration, including the split.
  for (const name of Object.keys(env)) if (name.startsWith("VITEST")) delete env[name];
  try {
    const control = join(directory, "control"), candidate = join(directory, "candidate");
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
      const { build, loadConfigFromFile } = await import("vite");
      const { config } = await loadConfigFromFile({ command: "build", mode: "production" });
      await build({ ...config, configFile: false,
        plugins: config.plugins.filter(plugin => plugin.name !== "critical-full-styles"),
        build: { ...config.build, outDir: ${JSON.stringify(control)}, emptyOutDir: false } });
    `], { cwd: root, env, maxBuffer: 4 * 1024 * 1024, timeout: 150000 });
    await promisify(execFile)(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--mode", "production", "--outDir", candidate],
      { cwd: root, env, maxBuffer: 4 * 1024 * 1024, timeout: 150000 });
    const html = await readFile(join(candidate, "index.html"), "utf8"), document = new JSDOM(html);
    const fullFile = document.window.document.querySelector("[data-full-styles]").getAttribute("href").slice(1);
    const criticalFile = document.window.document.querySelector('link[rel="stylesheet"]').getAttribute("href").slice(1);
    const full = await readFile(join(candidate, fullFile), "utf8"), critical = await readFile(join(candidate, criticalFile), "utf8");
    const controlHtml = await readFile(join(control, "index.html"), "utf8");
    const controlFile = controlHtml.match(/<link[^>]*rel="stylesheet"[^>]*href="\/([^"]+)"/)[1];
    const hash = (value) => createHash("sha256").update(value).digest("hex");
    expect(hash(full)).toBe(hash(await readFile(join(control, controlFile))));
    expect(orderedCopy(postcss.parse(full).nodes, postcss.parse(critical).nodes)).toBe(true);
    expect(gzipSync(full, { level: 9 }).length).toBeLessThanOrEqual(120000);
    // Preserve raw scratch output; select precisely the pages that remain
    // after the production build's design-pruning policy instead of deleting.
    const served = (file) => !file.startsWith("design/") || isDeployedDesignAsset(file.slice(7));
    const pages = (await htmlFiles(candidate)).filter(served);
    expect(pages.sort()).toEqual((await htmlFiles(control)).filter(served).sort());
    // The standalone pages' document is index.html minus
    // the member shell preload: an app document with the same critical copy,
    // full-sheet preload and cascade as index.html.
    const appPages = new Set(["index.html", STANDALONE_DOCUMENT, ...PUBLIC_STATIC_ROUTES.map((route) => `${route.slice(1)}/index.html`)]);
    expect(pages.filter((file) => appPages.has(file))).toHaveLength(appPages.size);
    for (const file of pages) {
      const page = new JSDOM(await readFile(join(candidate, file), "utf8"));
      const dom = page.window.document, links = [...dom.querySelectorAll('link[rel="stylesheet"],link[data-full-styles]')];
      if (!appPages.has(file)) {
        // Offline/error/form-frame/catalog documents copied from public/ do
        // not use the app stylesheet. They stay byte-identical and small.
        expect(await readFile(join(candidate, file), "utf8")).toBe(await readFile(join(control, file), "utf8"));
        expect(links).toHaveLength(0);
        expect([...dom.querySelectorAll("style")].reduce((n, node) => n + Buffer.byteLength(node.textContent), 0)).toBeLessThanOrEqual(60000);
        page.window.close();
        continue;
      }
      expect(links.map((link) => link.getAttribute("href"))).toEqual([`/${criticalFile}`, `/${fullFile}`]);
      expect(links[1].rel).toBe("preload");
      expect(links[1].getAttribute("as")).toBe("style");
      const inline = [...dom.querySelectorAll("style")].reduce((bytes, node) => bytes + Buffer.byteLength(node.textContent), 0);
      expect(Buffer.byteLength(critical) + inline).toBeLessThanOrEqual(60000);
      expect(dom.querySelectorAll('script:not([src]):not([type="application/ld+json"])')).toHaveLength(0);
      expect(dom.querySelectorAll("[onload],[onerror]")).toHaveLength(0);
      page.window.close();
    }
    document.window.close();
    const assets = {};
    for (const file of await readdir(join(candidate, "assets"))) {
      // The separately proved ordered copy precedes full and cannot change
      // any full/route winner. The unchanged route oracle checks the original
      // full asset plus EVERY original route/component sheet, as before.
      if (file.endsWith(".css") && `assets/${file}` !== criticalFile) assets[`assets/${file}`] = await readFile(join(candidate, "assets", file), "utf8");
    }
    const result = await verifyRouteStyleOrder({ ...routeStyleInputs(root), partitions: readRouteStyles(root), assets, criticalAsset: fullFile });
    expect(result.declarations).toBeGreaterThan(20000);
    expect(result.movedFragments).toBeGreaterThan(400);
    expect(result.assets).toBeGreaterThan(40);
  } finally {
    if (process.env.KEEP_ROUTE_STYLE_PROOF === "1") {
      console.info(`Retained production stylesheet proof: ${directory}`);
    } else {
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 180000);
