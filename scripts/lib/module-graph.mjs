// Static module graph for the repository's own JavaScript and TypeScript.
//
// Built with the TypeScript parser rather than a regular expression so that
// re-exports, type-only imports, dynamic `import()` and side-effect imports are
// all seen accurately. Only first-party relative specifiers become graph edges;
// bare specifiers are recorded separately, because they answer a different
// question (which declared dependencies are actually used).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

import ts from "typescript-compiler-api";

const SOURCE_EXTENSIONS = Object.freeze([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const RESOLUTION_ORDER = Object.freeze([
  "",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs",
]);

function scriptKindFor(path) {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".ts")) return ts.ScriptKind.TS;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

export function collectSourceFiles(root, directories, { skip = [] } = {}) {
  const files = [];
  const walk = (absolute) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const child = join(absolute, entry.name);
      const relativePath = relative(root, child).replace(/\\/g, "/");
      if (skip.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`))) {
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(child);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.includes(extname(entry.name))) continue;
      files.push(relativePath);
    }
  };
  for (const directory of directories) {
    const absolute = join(root, directory);
    if (existsSync(absolute) && statSync(absolute).isDirectory()) walk(absolute);
  }
  return files.sort();
}

/**
 * Extract every import and export from one source file.
 * @returns {{ relativeSpecifiers: string[], bareSpecifiers: string[],
 *   namedImports: string[], namedExports: string[], hasDefaultExport: boolean }}
 */
export function readModuleFacts({ path, source }) {
  const sourceFile = ts.createSourceFile(
    path, source, ts.ScriptTarget.Latest, true, scriptKindFor(path),
  );
  const relativeSpecifiers = [];
  const bareSpecifiers = [];
  const namedImports = [];
  const namedExports = [];
  let hasDefaultExport = false;

  const recordSpecifier = (literal) => {
    if (!literal || !ts.isStringLiteralLike(literal)) return;
    const value = literal.text;
    if (value.startsWith(".") || value.startsWith("/")) relativeSpecifiers.push(value);
    else if (!value.startsWith("node:")) bareSpecifiers.push(value);
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      recordSpecifier(node.moduleSpecifier);
      const clause = node.importClause;
      if (clause?.name) namedImports.push("default");
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          namedImports.push((element.propertyName ?? element.name).text);
        }
      }
      if (bindings && ts.isNamespaceImport(bindings)) namedImports.push("*");
    } else if (ts.isExportDeclaration(node)) {
      recordSpecifier(node.moduleSpecifier);
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          namedExports.push(element.name.text);
          if (node.moduleSpecifier) namedImports.push((element.propertyName ?? element.name).text);
        }
      } else if (node.moduleSpecifier) {
        namedImports.push("*");
      }
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      recordSpecifier(node.arguments[0]);
      namedImports.push("*");
    } else if (ts.isExportAssignment(node)) {
      hasDefaultExport = true;
    }

    const modifiers = ts.canHaveModifiers?.(node) ? ts.getModifiers(node) : node.modifiers;
    const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (exported) {
      if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
        hasDefaultExport = true;
      } else if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) namedExports.push(declaration.name.text);
        }
      } else if (node.name && ts.isIdentifier(node.name)) {
        namedExports.push(node.name.text);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return {
    relativeSpecifiers: [...new Set(relativeSpecifiers)],
    bareSpecifiers: [...new Set(bareSpecifiers)],
    namedImports: [...new Set(namedImports)],
    namedExports: [...new Set(namedExports)],
    hasDefaultExport,
  };
}

export function resolveRelative(root, fromPath, specifier) {
  const base = resolve(root, dirname(fromPath), specifier);
  for (const suffix of RESOLUTION_ORDER) {
    const candidate = `${base}${suffix}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return relative(root, candidate).replace(/\\/g, "/");
    }
  }
  return null;
}

/**
 * Build the first-party module graph.
 * @returns {{ modules: Map<string, object>, edges: Map<string, string[]> }}
 */
export function buildGraph({ root, directories, skip = [] }) {
  const files = collectSourceFiles(root, directories, { skip });
  const modules = new Map();
  const edges = new Map();
  for (const path of files) {
    const facts = readModuleFacts({ path, source: readFileSync(join(root, path), "utf8") });
    modules.set(path, facts);
  }
  for (const [path, facts] of modules) {
    const resolved = [];
    for (const specifier of facts.relativeSpecifiers) {
      const target = resolveRelative(root, path, specifier);
      if (target && modules.has(target)) resolved.push(target);
    }
    edges.set(path, [...new Set(resolved)].sort());
  }
  return { modules, edges };
}

/**
 * Every elementary import cycle in the graph, each normalized so the
 * lexicographically smallest member comes first and the representation is
 * stable across runs.
 */
export function findCycles(edges) {
  const index = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;

  const strongconnect = (node) => {
    index.set(node, counter);
    lowlink.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (!index.has(next)) {
        strongconnect(next);
        lowlink.set(node, Math.min(lowlink.get(node), lowlink.get(next)));
      } else if (onStack.has(next)) {
        lowlink.set(node, Math.min(lowlink.get(node), index.get(next)));
      }
    }
    if (lowlink.get(node) === index.get(node)) {
      const component = [];
      for (;;) {
        const member = stack.pop();
        onStack.delete(member);
        component.push(member);
        if (member === node) break;
      }
      components.push(component);
    }
  };

  for (const node of edges.keys()) {
    if (!index.has(node)) strongconnect(node);
  }

  const cycles = [];
  for (const component of components) {
    if (component.length > 1) {
      cycles.push([...component].sort());
      continue;
    }
    const [only] = component;
    if ((edges.get(only) ?? []).includes(only)) cycles.push([only]);
  }
  return cycles.sort((left, right) =>
    left.join() < right.join() ? -1 : left.join() > right.join() ? 1 : 0);
}

export function cycleKey(cycle) {
  return cycle.join(" -> ");
}
