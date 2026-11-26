import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import postcss from "postcss";
import { JSDOM } from "jsdom";

// Copy complete emitted nodes, including their wrappers, without minifying
// again. Full remains the original asset; a critical copy can never outrank
// its original (or the original winner) once full has loaded.
export function extractCriticalStyles(full, pages) {
  const documents = pages.map((html) => new JSDOM(html).window);
  try {
    const elements = documents.flatMap(({ document }) => [...document.querySelectorAll("*")]);
    const matches = new Map();
    const needed = (selector) => {
      if (matches.has(selector)) return matches.get(selector);
      // The browser-floor compiler emits these aliases of :is(). jsdom's
      // matcher does not recognize the vendor spellings. This normalization
      // is for selection only; the copied CSS is unchanged.
      const normalized = selector.replace(/:-(?:webkit|moz)-any\(/g, ":is(")
        .replace(/::(?:before|after|first-letter|first-line|selection|marker|placeholder)\b/g, "");
      let hit;
      try {
        const state = normalized.replace(/:(?:hover|active|focus-visible|focus-within|focus|visited|target)\b/g, ":is(*)");
        hit = elements.some((element) => element.matches(normalized) || (state !== normalized && element.matches(state)));
        // The static DOM is the emitted one, under each supported language
        // and public look. Most selectors do not depend on these attributes.
        if (!hit && /:lang\(|\[lang\b|data-site-look/.test(normalized)) {
          for (const lang of ["en", "es"]) for (const look of ["light", "pine"]) {
            documents.forEach(({ document }) => { document.documentElement.lang = lang; document.documentElement.dataset.siteLook = look; });
            hit ||= elements.some((element) => element.matches(normalized) || (state !== normalized && element.matches(state)));
          }
          documents.forEach(({ document }) => { document.documentElement.lang = "en"; delete document.documentElement.dataset.siteLook; });
        }
      }
      catch { hit = true; } // Unsupported selectors are retained, never discarded.
      matches.set(selector, hit);
      return hit;
    };
    const tree = postcss.parse(full);
    function select(node) {
      if (node.type === "rule") {
        const tokens = node.nodes.some((child) => child.type === "decl" && child.prop.startsWith("--"));
        return tokens || node.selectors.some(needed) ? node.clone() : null;
      }
      if (node.type === "atrule" && node.nodes && !/^(?:font-face|(?:-webkit-)?keyframes)$/.test(node.name)) {
        const children = node.nodes.map(select).filter(Boolean);
        return children.length ? node.clone({ nodes: children }) : null;
      }
      return node.clone(); // fonts, keyframes and non-container directives
    }
    return tree.clone({ nodes: tree.nodes.map(select).filter(Boolean) }).toString();
  } finally {
    documents.forEach((window) => window.close());
  }
}

export function criticalFullStylesPlugin() {
  return {
    name: "critical-full-styles",
    apply: "build",
    enforce: "post",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const pages = Object.values(bundle).filter((asset) => asset.type === "asset" && asset.fileName.endsWith(".html"));
        if (!pages.length) throw new Error("Critical styles need emitted HTML pages");
        const fullLinks = pages.map(({ source }) => [...String(source).matchAll(/<link\b[^>]*>/g)]
          .map(([tag]) => tag).filter((tag) => /\brel="stylesheet"/.test(tag)));
        if (fullLinks.some((links) => links.length !== 1)) throw new Error("Expected one original head stylesheet per page");
        const files = fullLinks.map(([link]) => link.match(/\bhref="\/([^"]+)"/)?.[1]);
        if (new Set(files).size !== 1 || !files[0] || bundle[files[0]]?.type !== "asset") throw new Error("Expected one shared full stylesheet");
        const full = String(bundle[files[0]].source);
        if (gzipSync(full, { level: 9 }).length > 120_000) throw new Error("Full stylesheet exceeds its 120,000-byte gzip ceiling");
        const critical = extractCriticalStyles(full, pages.map(({ source }) => String(source)));
        const inlineMax = Math.max(...pages.map(({ source }) => [...String(source).matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
          .reduce((bytes, [, css]) => bytes + Buffer.byteLength(css), 0)));
        if (Buffer.byteLength(critical) + inlineMax > 60_000) throw new Error("All first-paint blocking CSS exceeds 60,000 raw bytes");
        const digest = createHash("sha256").update(critical).digest("hex").slice(0, 12);
        const criticalFile = `assets/critical-${digest}.css`;
        this.emitFile({ type: "asset", fileName: criticalFile, source: critical });
        pages.forEach((page, index) => {
          // A preload fetches full at style priority without blocking paint.
          // Bootstrap attaches both listeners BEFORE activating this same slot
          // as a stylesheet, including when the preload already failed.
          page.source = String(page.source).replace(fullLinks[index][0],
            `<link rel="stylesheet" crossorigin href="/${criticalFile}">\n<link rel="preload" as="style" crossorigin href="/${files[0]}" data-full-styles>`);
        });
      },
    },
  };
}
