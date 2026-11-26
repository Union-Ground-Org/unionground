// The app document starts the lazy member shell with its bootstrap, rather
// than waiting for React to request it. Physical standalone documents have
// already been emitted by publicRouteMetadataPlugin and keep their own head.
//
// The standalone pages that index.html also served
// (AppRouter renders them instead of MemberApp) fetched the member shell's
// ~320 KB gzip and never ran it, which held their app-ready back about 1.2 s
// on the harness mobile profile. They get STANDALONE_DOCUMENT instead: the
// same document without the shell's own preload. The shell's dependencies stay
// preloaded there (member-shared is used by the organization landing page).
// The routes that render MemberApp, and the sign-in routes, stay on index.html.
export const STANDALONE_DOCUMENT = "standalone.html";
export const STANDALONE_DOCUMENT_ROUTES = Object.freeze([
  "/get-app",
  "/request-invite",
  "/stop-updates",
]);

// The build check (scripts/verify-public-route-build.mjs): the standalone
// document is index.html with exactly the member shell's preload line taken
// out, and index.html still carries it. An empty list is the contract.
const SHELL_PRELOAD = /<link rel="modulepreload" crossorigin href="\/assets\/member-shell-[^"]+\.js">\n/g;
export function standaloneDocumentProblems(indexHtml, standaloneHtml) {
  const shellLines = indexHtml.match(SHELL_PRELOAD) ?? [];
  const problems = [];
  if (shellLines.length !== 1) problems.push(`index.html carries ${shellLines.length} member shell preloads, not 1`);
  if (/href="\/assets\/member-shell-/.test(standaloneHtml)) problems.push(`${STANDALONE_DOCUMENT} carries the member shell preload`);
  if (shellLines.length === 1 && indexHtml.replace(shellLines[0], "") !== standaloneHtml) {
    problems.push(`${STANDALONE_DOCUMENT} differs from index.html by more than the member shell preload`);
  }
  return problems;
}

export function memberShellPreloadPlugin() {
  return {
    name: "member-shell-preload",
    enforce: "post",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const shell = Object.values(bundle).find((chunk) => chunk.type === "chunk"
          && Object.keys(chunk.modules).some((id) => id.replaceAll("\\", "/").endsWith("/src/App.jsx")));
        const document = bundle["index.html"];
        if (!shell || document?.type !== "asset") throw new Error("Member shell preload needs the shell chunk and app document");
        if (bundle[STANDALONE_DOCUMENT]) throw new Error(`Member shell preload would overwrite ${STANDALONE_DOCUMENT}`);
        const visited = new Set();
        const preloads = [];
        const html = String(document.source);
        function visit(file) {
          if (visited.has(file)) return;
          visited.add(file);
          const chunk = bundle[file];
          if (chunk?.type !== "chunk") throw new Error(`Member shell preload cannot find ${file}`);
          if (!html.includes(`"/${file}"`)) preloads.push(`<link rel="modulepreload" crossorigin href="/${file}">`);
          for (const dependency of chunk.imports) visit(dependency);
        }
        visit(shell.fileName);
        if (!html.includes("</head>")) throw new Error("Member shell preload needs a document head");
        document.source = html.replace("</head>", `${preloads.join("\n")}\n</head>`);
        // Derived from the final app document, so the two differ by exactly the
        // shell's own preload line and its newline, however many preloads remain.
        const shellLink = `<link rel="modulepreload" crossorigin href="/${shell.fileName}">\n`;
        this.emitFile({ type: "asset", fileName: STANDALONE_DOCUMENT, source: document.source.replace(shellLink, "") });
      },
    },
  };
}
