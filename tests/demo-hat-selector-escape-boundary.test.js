// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureEntry = join(repoRoot, "tests/fixtures/demo-hat-escape-boundary-app.jsx");

let browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, BROWSER_HOOK_TIMEOUT);

afterAll(async () => {
  await browser?.close();
});

async function probeFirstWelcomeEscape() {
  const outDir = mkdtempSync(join(tmpdir(), "demo-hat-escape-"));
  const bundlePath = join(outDir, "app.js");
  // Bundled with Vite itself: esbuild stopped arriving with Vite 8. React
  // stays on its development build, as esbuild's unminified browser bundle had it.
  await build({
    configFile: false,
    logLevel: "silent",
    root: repoRoot,
    publicDir: false,
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      target: "es2022",
      rolldownOptions: {
        input: fixtureEntry,
        output: { format: "iife", entryFileNames: "app.js" },
      },
    },
  });
  const appJs = readFileSync(bundlePath, "utf8");
  const htmlPath = join(outDir, "index.html");
  writeFileSync(htmlPath, `<!doctype html>
<html lang="en"><body>
<div id="root"></div>
<script>
window.probe = [];
window.fired = false;
const origAdd = document.addEventListener.bind(document);
document.addEventListener = function (type, listener, options) {
  if (type === "keydown") window.probe.push("listener");
  return origAdd(type, listener, options);
};
new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      const menu = node.nodeType === 1 && (
        node.classList?.contains("demo-hat-selector__menu")
          ? node
          : node.querySelector?.(".demo-hat-selector__menu")
      );
      if (!menu) continue;
      window.probe.push("menu-committed");
      const trigger = document.querySelector(".demo-hat-selector__trigger");
      trigger.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", bubbles: true, cancelable: true,
      }));
      window.probe.push("escape-dispatched");
      window.fired = true;
    }
  }
}).observe(document.body, { childList: true, subtree: true });
</script>
<script>${appJs}</script>
</body></html>`);

  const page = await browser.newPage();
  try {
    await page.route("**/*", async (route) => {
      await route.fulfill({ contentType: "text/html", body: readFileSync(htmlPath) });
    });
    await page.goto("http://fixture.local/");
    await page.locator("#welcome").press("Enter");
    await page.waitForFunction(() => window.fired === true);
    return await page.evaluate(() => ({
      events: window.probe,
      // A dismissed menu fades out over .18s (the prototype's menu motion),
      // inert and hidden from assistive technology, before it unmounts.
      menuVisible: Boolean(document.querySelector('.demo-hat-selector__menu:not([data-state="closing"])')),
      activeElement: document.activeElement?.className || "",
    }));
  } finally {
    await page.close();
  }
}

describe("DemoHatSelector first-welcome Escape boundary", () => {
  it("registers the dismissal listener before menu commit so the first Escape closes the intro", async () => {
    const observation = await probeFirstWelcomeEscape();
    expect(observation.events[0]).toBe("listener");
    expect(observation.events).toContain("menu-committed");
    expect(observation.events).toContain("escape-dispatched");
    expect(observation.menuVisible).toBe(false);
    expect(observation.activeElement).toBe("demo-hat-selector__trigger");

    const source = readFileSync(join(repoRoot, "src/components/DemoHatSelector.jsx"), "utf8");
    expect(source).toMatch(/useLayoutEffect\(\(\) => \{\n {4}if \(!open\) return undefined;\n {4}const dismissOutside/);
  }, 30_000);
});
