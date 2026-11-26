// @vitest-environment node
import { expect, it } from "vitest";
import { extractCriticalStyles, criticalFullStylesPlugin } from "../scripts/lib/critical-full-styles.mjs";

it("copies matched rules, root tokens, fonts and wrappers without changing their bytes or order", () => {
  const full = ':root{--ink:#111}@font-face{font-family:test;src:url(a.woff2)}.unused{color:red}@media(min-width:900px){h1{color:blue}.unused{color:pink}}h1::before{content:"x"}.local{--token:2}.unused{color:green}';
  expect(extractCriticalStyles(full, ['<html><body><h1>Hello</h1></body></html>'])).toBe(':root{--ink:#111}@font-face{font-family:test;src:url(a.woff2)}@media(min-width:900px){h1{color:blue}}h1::before{content:"x"}.local{--token:2}');
});

it("uses every emitted document and preserves the full asset and script policy", () => {
  const full = '.a{color:red}.b{color:blue}.c{color:green}', bundle = {
    'index.html': { type: 'asset', fileName: 'index.html', source: '<head><link rel="stylesheet" href="/assets/original.css"></head><body class="a"></body>' },
    'about/index.html': { type: 'asset', fileName: 'about/index.html', source: '<head><link rel="stylesheet" href="/assets/original.css"></head><body class="b"></body>' },
    'assets/original.css': { type: 'asset', fileName: 'assets/original.css', source: full },
  };
  let emitted;
  criticalFullStylesPlugin().generateBundle.handler.call({ emitFile: (asset) => { emitted = asset; } }, {}, bundle);
  expect(bundle['assets/original.css'].source).toBe(full);
  expect(emitted.source).toBe('.a{color:red}.b{color:blue}');
  for (const page of ['index.html','about/index.html']) {
    const html = bundle[page].source;
    expect(html.indexOf(emitted.fileName)).toBeLessThan(html.indexOf('data-full-styles'));
    expect(html).toContain('rel="preload" as="style"');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/onload=|onerror=/);
  }
});
