// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { build } from "vite";
import {
  memberShellPreloadPlugin,
  STANDALONE_DOCUMENT,
  STANDALONE_DOCUMENT_ROUTES,
  standaloneDocumentProblems,
} from "../scripts/member-shell-build.mjs";
import { appCodeSplitting, memberShellChunkFor } from "../scripts/lib/app-chunks.mjs";

function fixture() {
  return {
    "index.html": { type: "asset", source: '<head><script src="/assets/entry.js"></script><link rel="modulepreload" href="/assets/react.js"></head><body></body>' },
    "about/index.html": { type: "asset", source: "<head></head><body>About</body>" },
    "assets/member.js": { type: "chunk", fileName: "assets/member.js", modules: { "/repo/src/App.jsx": {} }, imports: ["assets/shared.js", "assets/react.js"] },
    "assets/shared.js": { type: "chunk", fileName: "assets/shared.js", modules: {}, imports: ["assets/entry.js"] },
    "assets/entry.js": { type: "chunk", fileName: "assets/entry.js", modules: {}, imports: ["assets/shared.js"] },
    "assets/react.js": { type: "chunk", fileName: "assets/react.js", modules: {}, imports: [] },
  };
}

// The plugin emits the standalone document through the Rollup context.
function runPlugin(bundle) {
  const context = { emitFile: ({ type, fileName, source }) => { bundle[fileName] = { type, fileName, source }; } };
  memberShellPreloadPlugin().generateBundle.handler.call(context, {}, bundle);
  return bundle;
}

describe("member shell build boundary", () => {
  it("groups member dependencies without drawing the member shell into a standalone page or vendor chunk", () => {
    const graph = {
      "/repo/src/member.js": { importers: ["/repo/src/App.jsx"], dynamicImporters: [] },
      "/repo/src/common.js": { importers: ["/repo/src/App.jsx", "/repo/src/About.jsx"], dynamicImporters: [] },
      "/repo/src/About.jsx": { importers: [], dynamicImporters: ["/repo/src/AppRouter.jsx"] },
      "/repo/src/initial.js": { importers: ["/repo/src/App.jsx", "/repo/src/main.jsx"], dynamicImporters: [] },
    };
    const context = { getModuleInfo: (id) => graph[id] ?? null };
    expect(memberShellChunkFor("/repo/src/member.js", context)).toBe("member-shell");
    expect(memberShellChunkFor("/repo/src/common.js", context)).toBe("member-shared");
    expect(memberShellChunkFor("/repo/src/initial.js", context)).toBe("app-initial");
    expect(memberShellChunkFor("/repo/node_modules/react/index.js", context)).toBeNull();
    expect(memberShellChunkFor("/repo/src/lib/i18n.js", context)).toBeNull();
    expect(memberShellChunkFor("/repo/node_modules/lucide-react/icon.js", context)).toBeNull();
  });

  it("emits shared lazy-page helpers outside the entry's static closure", async () => {
    const modules = {
      "/repo/src/main.jsx": 'export { member, about } from "./AppRouter.jsx";',
      "/repo/src/AppRouter.jsx": 'export const member = () => import("./App.jsx"); export const about = () => import("./About.jsx");',
      "/repo/src/App.jsx": 'export { value } from "./common.js";',
      "/repo/src/About.jsx": 'export { value } from "./common.js";',
      "/repo/src/common.js": 'export { value } from "./dependency.js";',
      "/repo/src/dependency.js": 'export const value = "shared lazy value";',
    };
    const { output } = await build({
      configFile: false, envDir: false, logLevel: "silent",
      plugins: [{ name: "lazy-helper-fixture", resolveId(id, importer) {
        const path = id.startsWith(".") ? `${importer.slice(0, importer.lastIndexOf("/") + 1)}${id.slice(2)}` : id;
        return path in modules ? path : null;
      }, load: (id) => modules[id] }],
      build: { write: false, modulePreload: false, minify: false, rolldownOptions: {
        input: "/repo/src/main.jsx", preserveEntrySignatures: "allow-extension", output: { codeSplitting: appCodeSplitting },
      } },
    });
    const chunks = output.filter((item) => item.type === "chunk");
    const eager = new Set();
    const visit = (chunk) => {
      if (eager.has(chunk)) return;
      eager.add(chunk);
      chunk.imports.forEach((file) => visit(chunks.find((item) => item.fileName === file)));
    };
    visit(chunks.find((item) => item.isEntry));
    const initialModules = [...eager].flatMap((chunk) => Object.keys(chunk.modules));
    expect(initialModules).not.toContain("/repo/src/common.js");
    expect(initialModules).not.toContain("/repo/src/dependency.js");
    const shared = chunks.find((chunk) => "/repo/src/dependency.js" in chunk.modules);
    expect(shared.fileName).toContain("member-shared");
    for (const route of ["/repo/src/App.jsx", "/repo/src/About.jsx"]) {
      expect(chunks.find((chunk) => route in chunk.modules).imports).toContain(shared.fileName);
    }
  });

  it("preloads the shell and its static imports once, without a cyclic walk or a standalone preload", () => {
    const bundle = runPlugin(fixture());
    const html = bundle["index.html"].source;
    expect(html.match(/href="\/assets\/member.js"/g)).toHaveLength(1);
    expect(html.match(/href="\/assets\/shared.js"/g)).toHaveLength(1);
    expect(html.match(/href="\/assets\/react.js"/g)).toHaveLength(1);
    expect(html.match(/src="\/assets\/entry.js"/g)).toHaveLength(1);
    expect(html).not.toContain('href="/assets/entry.js"');
    expect(bundle["about/index.html"].source).toBe("<head></head><body>About</body>");
  });

  it.each(["shell", "document", "dependency", "head"])("fails the build instead of silently losing the %s preload", (missing) => {
    const bundle = fixture();
    if (missing === "shell") delete bundle["assets/member.js"];
    if (missing === "document") delete bundle["index.html"];
    if (missing === "dependency") delete bundle["assets/shared.js"];
    if (missing === "head") bundle["index.html"].source = "<body></body>";
    expect(() => runPlugin(bundle)).toThrow(/Member shell preload/);
  });

  // The standalone pages never render MemberApp, so their
  // document keeps every other preload and drops only the shell's own.
  it("emits the standalone document as the app document without the shell's own preload", () => {
    const bundle = runPlugin(fixture());
    const html = bundle["index.html"].source;
    const standalone = bundle[STANDALONE_DOCUMENT].source;
    expect(standalone).toBe(html.replace('<link rel="modulepreload" crossorigin href="/assets/member.js">\n', ""));
    expect(standalone).not.toContain('href="/assets/member.js"');
    expect(standalone.match(/href="\/assets\/shared.js"/g)).toHaveLength(1);
    expect(standalone.match(/src="\/assets\/entry.js"/g)).toHaveLength(1);
  });

  it("derives the standalone document from index.html when the shell's line is the only preload", () => {
    const shellLine = '<link rel="modulepreload" crossorigin href="/assets/member-shell-AbC12345.js">';
    const bundle = runPlugin({
      "index.html": { type: "asset", source: '<head>\n<script type="module" crossorigin src="/assets/index-Q1.js"></script>\n<link rel="modulepreload" crossorigin href="/assets/member-shared-XyZ12345.js">\n</head><body></body>' },
      "assets/member-shell-AbC12345.js": { type: "chunk", fileName: "assets/member-shell-AbC12345.js", modules: { "/repo/src/App.jsx": {} }, imports: ["assets/member-shared-XyZ12345.js", "assets/index-Q1.js"] },
      "assets/member-shared-XyZ12345.js": { type: "chunk", fileName: "assets/member-shared-XyZ12345.js", modules: {}, imports: ["assets/index-Q1.js"] },
      "assets/index-Q1.js": { type: "chunk", fileName: "assets/index-Q1.js", modules: {}, imports: [] },
    });
    const html = bundle["index.html"].source;
    const standalone = bundle[STANDALONE_DOCUMENT].source;
    expect(html.match(/rel="modulepreload"/g)).toHaveLength(2);
    expect(html).toContain(`${shellLine}\n</head>`);
    expect(standalone).toBe(html.replace(`${shellLine}\n`, ""));
    expect(html.split("\n").length - standalone.split("\n").length).toBe(1);
    expect(standaloneDocumentProblems(html, standalone)).toEqual([]);
  });

  it("refuses to overwrite an existing standalone document", () => {
    const bundle = fixture();
    bundle[STANDALONE_DOCUMENT] = { type: "asset", source: "<head></head>" };
    expect(() => runPlugin(bundle)).toThrow(/would overwrite/);
  });

  it("fails the build check when the standalone document gains the shell preload or index.html loses it", () => {
    const shell = '<link rel="modulepreload" crossorigin href="/assets/member-shell-AbC12345.js">\n';
    const shared = '<link rel="modulepreload" crossorigin href="/assets/member-shared-XyZ12345.js">\n';
    const index = `<head><script type="module" crossorigin src="/assets/index-Q1.js"></script>\n${shell}${shared}</head>`;
    const standalone = index.replace(shell, "");
    expect(standaloneDocumentProblems(index, standalone)).toEqual([]);
    expect(standaloneDocumentProblems(index, index)).toEqual([
      `${STANDALONE_DOCUMENT} carries the member shell preload`,
      `${STANDALONE_DOCUMENT} differs from index.html by more than the member shell preload`,
    ]);
    expect(standaloneDocumentProblems(standalone, standalone)).toEqual(["index.html carries 0 member shell preloads, not 1"]);
    expect(standaloneDocumentProblems(index, standalone.replace(shared, ""))).toEqual([
      `${STANDALONE_DOCUMENT} differs from index.html by more than the member shell preload`,
    ]);
  });


  it("keeps the entry router independent of member-only imports", () => {
    const source = readFileSync("src/AppRouter.jsx", "utf8");
    expect(source).toContain('import("./App.jsx")');
    expect(source).not.toMatch(/import\s+[^;]*from\s+["']\.\/App\.jsx["']/);
    for (const memberOnly of ["./lib/memberApi.js", "./lib/outbox.js", "./views/TodayView.jsx"]) {
      expect(source).not.toContain(memberOnly);
    }
    const config = readFileSync("vite.config.mjs", "utf8");
    expect(config.indexOf("publicRouteMetadataPlugin(),")).toBeLessThan(config.indexOf("memberShellPreloadPlugin(),"));
  });

  it("loads the retained member styles before the shared styles to preserve the cascade", () => {
    const main = readFileSync("src/main.jsx", "utf8");
    expect(main.indexOf('import "./memberShellStyles.js"')).toBeLessThan(main.indexOf('import "./styles.css"'));
    const styles = readFileSync("src/memberShellStyles.js", "utf8");
    expect(styles).toContain('import "./components/authStory.css"');
    expect(styles).toContain('import "./features/memberHome/homeTakeover.css"');
    expect(styles).not.toMatch(/import\s+[^;]*\.jsx/);
  });
});
