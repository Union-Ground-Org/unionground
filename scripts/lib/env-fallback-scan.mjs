// Shared analysis for the secret-fallback ban.
//
// A secret-like environment variable must fail closed when it is absent. It
// may never silently adopt a committed literal, a build-time public variable,
// or an unrelated variable, because each of those hides a deployment
// misconfiguration behind a value that looks like it worked.
//
// The scan is AST-aware: TypeScript's parser reads every JavaScript, JSX,
// TypeScript and TSX source in scope, so a fallback is classified from the
// real expression shape rather than from a line-oriented regex. Workflow YAML
// and native build configuration are read as structured documents for the same
// reason.
//
// Findings never carry the offending value. A gate that prints the literal it
// rejected would leak the very material it exists to protect, and CI logs are
// broadly readable.

import ts from "typescript-compiler-api";
import { parseDocument, isMap, isSeq, isScalar, isPair } from "yaml";

/**
 * Name fragments that make an environment variable secret-like. The list is
 * the reviewed contract from SEC-UG-SECRET-FALLBACK-BAN: secret, token,
 * password, private key, webhook, service role, database, and JWT, plus the
 * credential spellings this repository actually uses.
 */
export const SECRET_LIKE_FRAGMENTS = Object.freeze([
  "SECRET",
  "SECRETS",
  "TOKEN",
  "PASSWORD",
  "PASSWD",
  "PRIVATE_KEY",
  "PRIVATEKEY",
  "WEBHOOK",
  "SERVICE_ROLE",
  "SERVICEROLE",
  "DATABASE",
  "DB_URL",
  "JWT",
  "CREDENTIAL",
  "CREDENTIALS",
  "API_KEY",
  "APIKEY",
  "ACCESS_KEY",
  "SIGNING_KEY",
  "SERVICE_KEY",
  "SERVICEKEY",
  "ENCRYPTION_KEY",
  "SESSION_KEY",
  "MASTER_KEY",
  "SALT",
]);

/**
 * Prefixes that a bundler inlines into a shipped client bundle. A value behind
 * one of these is public by construction, so it can never stand in for a
 * secret. `PUBLIC_` is deliberately absent: in this repository it names the
 * public-interest feature area, not a client-exposed build variable.
 */
export const PUBLIC_ENV_PREFIXES = Object.freeze([
  "VITE_",
  "EXPO_PUBLIC_",
  "NEXT_PUBLIC_",
  "REACT_APP_",
]);

const SECRET_LIKE_PATTERN = new RegExp(
  `(?:^|_)(?:${SECRET_LIKE_FRAGMENTS.join("|")})(?:_|$)`,
);

/**
 * A name whose only credential marker is a trailing `KEY` is still a key. The
 * fragment list above spells out the key kinds this repository already names
 * (`API_KEY`, `PRIVATE_KEY`, `SERVICE_KEY`, ...), but a data-encryption key is
 * usually named for what it protects and carries nothing else, so the bare
 * suffix is classified too.
 *
 * Two anchors keep the rule from swallowing ordinary vocabulary: `KEY` must end
 * the name, because as an inner word it names a storage key, a sort key or a
 * query key; and it must be qualified by a preceding token, because a field
 * called just `key` is a map entry (an HTTP header name in `vercel.json`, for
 * one), not a credential.
 */
const GENERIC_KEY_SUFFIX_PATTERN = /[A-Z0-9]_KEY$/;

/**
 * Identifiers that end in `KEY` yet are published by design: Supabase's
 * anonymous and publishable keys ship in client bundles, and a public half of
 * a keypair is public by definition. They are excluded by name rather than by
 * prefix because they are also read without a bundler prefix (for example a
 * server-side read of `SUPABASE_ANON_KEY`). The exclusion applies only to the
 * bare-suffix rule: a name that matches a secret fragment stays secret-like.
 */
export const PUBLIC_KEY_IDENTIFIERS = Object.freeze([
  "ANON_KEY",
  "PUBLISHABLE_KEY",
  "PUBLIC_KEY",
]);

const PUBLIC_KEY_IDENTIFIER_PATTERN = new RegExp(
  `(?:^|_)(?:${PUBLIC_KEY_IDENTIFIERS.join("|")})$`,
);

export const FINDING_KINDS = Object.freeze([
  "literal-fallback",
  "public-variable-fallback",
  "unrelated-variable-fallback",
  "indeterminate-fallback",
  "literal-secret-value",
]);

const FINDING_KIND_SET = new Set(FINDING_KINDS);

export function isSecretLikeName(name) {
  if (typeof name !== "string" || name.length === 0) return false;
  const normalized = name.toUpperCase();
  if (PUBLIC_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    // A public build variable is never treated as a secret, even when its own
    // name contains a secret-like fragment, because its value ships to clients.
    return false;
  }
  if (SECRET_LIKE_PATTERN.test(normalized)) return true;
  return GENERIC_KEY_SUFFIX_PATTERN.test(normalized)
    && !PUBLIC_KEY_IDENTIFIER_PATTERN.test(normalized);
}

export function isPublicEnvName(name) {
  if (typeof name !== "string") return false;
  const normalized = name.toUpperCase();
  return PUBLIC_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function scriptKindFor(path) {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".ts")) return ts.ScriptKind.TS;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function positionOf(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return { line: line + 1, column: character + 1 };
}

/**
 * Recognize the environment container expressions this repository uses:
 * `process.env`, `import.meta.env`, and the Cloudflare Worker handler binding
 * named `env` (including `context.env` / `c.env` shapes).
 */
function environmentContainerName(node) {
  if (ts.isPropertyAccessExpression(node)) {
    const property = node.name.text;
    if (property !== "env") return null;
    const target = node.expression;
    if (ts.isIdentifier(target) && target.text === "process") return "process.env";
    if (target.kind === ts.SyntaxKind.MetaProperty) return "import.meta.env";
    if (ts.isIdentifier(target)) return `${target.text}.env`;
    return "env";
  }
  if (ts.isIdentifier(node) && node.text === "env") return "env";
  return null;
}

/**
 * Resolve an environment read to its variable name, or null when the node is
 * not an environment read at all.
 */
export function environmentReadName(node) {
  if (ts.isPropertyAccessExpression(node)) {
    const container = environmentContainerName(node.expression);
    if (!container) return null;
    return node.name.text;
  }
  if (ts.isElementAccessExpression(node)) {
    const container = environmentContainerName(node.expression);
    if (!container) return null;
    const argument = node.argumentExpression;
    if (argument && ts.isStringLiteralLike(argument)) return argument.text;
    return null;
  }
  return null;
}

function unwrap(node) {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current) || ts.isSatisfiesExpression?.(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/**
 * Some reads are wrapped before the fallback is applied, for example
 * `String(process.env.X || "")`. The wrapper does not change which variable is
 * being defaulted, so look through the common normalizing calls.
 */
function innermostEnvironmentRead(node) {
  const expression = unwrap(node);
  const direct = environmentReadName(expression);
  if (direct !== null) return direct;
  if (ts.isCallExpression(expression) && expression.arguments.length >= 1) {
    const callee = unwrap(expression.expression);
    const calleeName = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : null;
    if (calleeName && ["String", "Number", "Boolean", "trim"].includes(calleeName)) {
      return innermostEnvironmentRead(expression.arguments[0]);
    }
  }
  return null;
}

// isStringLiteralLike() already covers a no-substitution backtick literal, so
// only an interpolated template reaches this helper.
function templateHasContent(node) {
  if (ts.isTemplateExpression(node)) {
    if (node.head.text.length > 0) return true;
    return node.templateSpans.some((span) => span.literal.text.length > 0)
      || node.templateSpans.length > 0;
  }
  return false;
}

/**
 * Classify the right-hand side of a fallback for a secret-like read.
 * Returns `{ safe: true }` or `{ safe: false, kind }`.
 */
// Reviewed rename: Supabase's server secret key replaces its legacy service-role
// key for the same project. No cross-provider or SAMPLE/production aliases.
const SECRET_ALIAS_GROUPS = [
  ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
  // GitHub CLI documents these names for the same host authentication token.
  ["GH_TOKEN", "GITHUB_TOKEN"],
];

const LOCAL_DATABASE_ALIASES = {
  // Each verifier validates the selected connection against its disposable/local
  // target contract before connecting. These aliases do not apply to app code.
  "scripts/verify-db-boundary-tenancy.mjs": "DB_BOUNDARY_DB_URL",
};

export function isReviewedSecretAlias(source, target, path) {
  return source === target || SECRET_ALIAS_GROUPS.some(group =>
    group.includes(source) && group.includes(target))
    || (source === "SUPABASE_DB_URL" && LOCAL_DATABASE_ALIASES[path] === target);
}

export function classifyFallback(node, sourceVariable, path) {
  const expression = unwrap(node);

  if (expression.kind === ts.SyntaxKind.NullKeyword) return { safe: true, reason: "nullish" };
  if (ts.isIdentifier(expression) && expression.text === "undefined") {
    return { safe: true, reason: "nullish" };
  }
  if (ts.isVoidExpression(expression)) return { safe: true, reason: "nullish" };

  if (ts.isStringLiteralLike(expression) && !ts.isTemplateExpression(expression)) {
    return expression.text.length === 0
      ? { safe: true, reason: "empty-normalizer" }
      : { safe: false, kind: "literal-fallback" };
  }
  if (ts.isTemplateExpression(expression)) {
    return templateHasContent(expression)
      ? { safe: false, kind: "literal-fallback" }
      : { safe: true, reason: "empty-normalizer" };
  }
  if (
    ts.isNumericLiteral(expression)
    || ts.isBigIntLiteral(expression)
    || expression.kind === ts.SyntaxKind.TrueKeyword
    || expression.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return { safe: false, kind: "literal-fallback" };
  }

  const readName = innermostEnvironmentRead(expression);
  if (readName !== null) {
    if (isPublicEnvName(readName)) {
      return { safe: false, kind: "public-variable-fallback", fallbackVariable: readName };
    }
    if (isReviewedSecretAlias(sourceVariable, readName, path)) {
      return { safe: true, reason: "secret-alias", fallbackVariable: readName };
    }
    return { safe: false, kind: "unrelated-variable-fallback", fallbackVariable: readName };
  }

  // A chained fallback keeps its own classification: `A || B || "literal"`
  // parses as `(A || B) || "literal"`, so the chain is walked by the caller.
  if (
    ts.isBinaryExpression(expression)
    && (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    const left = classifyFallback(expression.left, sourceVariable, path);
    if (!left.safe) return left;
    return classifyFallback(expression.right, sourceVariable, path);
  }

  return { safe: false, kind: "indeterminate-fallback" };
}

function pushFinding(findings, { path, sourceFile, node, variable, kind, detail }) {
  const { line, column } = positionOf(sourceFile, node);
  findings.push({ path, line, column, variable, kind, detail });
}

function isFallbackOperator(kind) {
  return kind === ts.SyntaxKind.BarBarToken
    || kind === ts.SyntaxKind.QuestionQuestionToken
    || kind === ts.SyntaxKind.BarBarEqualsToken
    || kind === ts.SyntaxKind.QuestionQuestionEqualsToken;
}

/**
 * Find the secret-like variable a fallback is defaulting.
 *
 * `A || B || "literal"` parses as `(A || B) || "literal"`, so the outer node's
 * left operand is a binary expression rather than a read. Walking the left
 * spine is what keeps a literal tail from hiding behind an alias pair.
 *
 * @param {ts.Node} node the left operand of a fallback expression
 * @param {(name: string) => string | null} resolveLocal resolves an identifier
 *   bound by `const` to the secret-like variable it was read from
 */
export function secretReadInFallbackChain(node, resolveLocal = () => null) {
  const expression = unwrap(node);
  const direct = innermostEnvironmentRead(expression);
  if (direct !== null) return isSecretLikeName(direct) ? direct : null;
  if (ts.isIdentifier(expression)) {
    const resolved = resolveLocal(expression.text);
    return resolved && isSecretLikeName(resolved) ? resolved : null;
  }
  if (ts.isBinaryExpression(expression) && isFallbackOperator(expression.operatorToken.kind)) {
    return secretReadInFallbackChain(expression.left, resolveLocal)
      ?? secretReadInFallbackChain(expression.right, resolveLocal);
  }
  return null;
}

/**
 * Bindings introduced as `const NAME = <secret-like environment read>`.
 *
 * A name declared more than once in the file is dropped rather than guessed at:
 * the gate must not accuse the wrong line. Reassignable bindings are out of
 * scope by design — this is a narrowly static scan, not a dataflow analysis,
 * and the boundary is documented rather than papered over.
 */
export function collectSecretBindings(sourceFile) {
  const bindings = new Map();
  const duplicated = new Set();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && node.parent
      && ts.isVariableDeclarationList(node.parent)
      && (node.parent.flags & ts.NodeFlags.Const) !== 0) {
      const read = innermostEnvironmentRead(node.initializer);
      if (read !== null && isSecretLikeName(read)) {
        if (bindings.has(node.name.text)) duplicated.add(node.name.text);
        else bindings.set(node.name.text, read);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const name of duplicated) bindings.delete(name);
  return bindings;
}

/**
 * Scan one JavaScript/TypeScript source for banned secret fallbacks.
 */
export function scanSource({ path, source }) {
  const findings = [];
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(path),
  );

  const inspectFallback = (readNode, fallbackNode, variable) => {
    const verdict = classifyFallback(fallbackNode, variable, path);
    if (verdict.safe) return;
    pushFinding(findings, {
      path,
      sourceFile,
      node: readNode,
      variable,
      kind: verdict.kind,
      detail: verdict.fallbackVariable
        ? `falls back to ${verdict.fallbackVariable}`
        : "falls back to a committed value",
    });
  };

  const bindings = collectSecretBindings(sourceFile);
  const resolveLocal = (name) => bindings.get(name) ?? null;

  const visit = (node) => {
    if (ts.isBinaryExpression(node) && isFallbackOperator(node.operatorToken.kind)) {
      // Inspect every operand even in a Boolean/presence context: a literal
      // makes a missing credential look configured. Inner chains must also be
      // checked when the outer operand happens to be a safe alias.
      const variable = secretReadInFallbackChain(node.left, resolveLocal);
      if (variable !== null) inspectFallback(node.left, node.right, variable);
    }

    if (ts.isConditionalExpression(node)) {
      // `process.env.X ? process.env.X : "literal"` is the same defaulting in
      // ternary clothing.
      const condition = innermostEnvironmentRead(node.condition);
      if (condition !== null && isSecretLikeName(condition)) {
        const whenTrue = innermostEnvironmentRead(node.whenTrue);
        if (whenTrue === condition) inspectFallback(node.condition, node.whenFalse, condition);
      }
    }

    if (ts.isBindingElement(node) && node.initializer) {
      // `const { SUPABASE_SERVICE_ROLE_KEY = "dev" } = process.env`
      const parent = node.parent;
      const fromEnvironment = parent
        && ts.isObjectBindingPattern(parent)
        && parent.parent
        && ts.isVariableDeclaration(parent.parent)
        && parent.parent.initializer
        && environmentContainerName(unwrap(parent.parent.initializer)) !== null;
      const nameNode = node.propertyName ?? node.name;
      const variable = ts.isIdentifier(nameNode)
        ? nameNode.text
        : ts.isStringLiteralLike(nameNode)
          ? nameNode.text
          : null;
      if (fromEnvironment && variable && isSecretLikeName(variable)) {
        inspectFallback(node, node.initializer, variable);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

const WORKFLOW_EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const WORKFLOW_REFERENCE = String.raw`(?:secrets|env)(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*|\s*\[\s*['"][A-Za-z_][A-Za-z0-9_]*['"]\s*\])`;
const WORKFLOW_SECRET_FALLBACK = new RegExp(`(${WORKFLOW_REFERENCE})\\s*\\|\\|`, "g");
const WORKFLOW_SECRET_REFERENCE = /^secrets(?:\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)|\s*\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])$/;

function workflowReferenceName(reference) {
  return reference.match(/[A-Za-z_][A-Za-z0-9_]*/g)?.at(-1);
}

function isReviewedWorkflowAliasChain(expression) {
  const parts = expression.trim().split(/\s*\|\|\s*/);
  if (!parts.every(part => WORKFLOW_SECRET_REFERENCE.test(part))) return false;
  const first = workflowReferenceName(parts[0]);
  return parts.every(part => isReviewedSecretAlias(first, workflowReferenceName(part)));
}

function yamlLine(document, node, source) {
  const offset = node?.range?.[0];
  if (typeof offset !== "number") return 0;
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

/**
 * Scan a GitHub Actions workflow. Two shapes are banned: an expression that
 * defaults a secret to something else, and a secret-like `env:` entry whose
 * value is a committed literal rather than a secret or variable reference.
 */
export function scanWorkflow({ path, source }) {
  const findings = [];
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    findings.push({
      path,
      line: 1,
      column: 1,
      variable: "(document)",
      kind: "indeterminate-fallback",
      detail: "workflow YAML could not be parsed",
    });
    return findings;
  }

  const walk = (node, keyPath) => {
    if (isMap(node)) {
      for (const item of node.items) {
        if (!isPair(item)) continue;
        const key = isScalar(item.key) ? String(item.key.value) : "";
        walk(item.value, [...keyPath, key]);
      }
      return;
    }
    if (isSeq(node)) {
      for (const item of node.items) walk(item, keyPath);
      return;
    }
    if (!isScalar(node)) return;

    const value = node.value;
    if (typeof value !== "string") return;
    const key = keyPath.at(-1) ?? "";
    const inEnvBlock = keyPath.length >= 2 && keyPath.at(-2) === "env";

    let match;
    WORKFLOW_EXPRESSION.lastIndex = 0;
    while ((match = WORKFLOW_EXPRESSION.exec(value)) !== null) {
      const expression = match[1];
      WORKFLOW_SECRET_FALLBACK.lastIndex = 0;
      let fallback;
      while ((fallback = WORKFLOW_SECRET_FALLBACK.exec(expression)) !== null) {
        const variable = workflowReferenceName(fallback[1]);
        const secret = fallback[1].startsWith("secrets") || isSecretLikeName(variable);
        if (secret && !isReviewedWorkflowAliasChain(expression)) {
          findings.push({
            path,
            line: yamlLine(document, node, source),
            column: 1,
            variable,
            kind: "literal-fallback",
            detail: "workflow expression defaults a secret without a reviewed alias",
          });
        }
      }
    }

    if (inEnvBlock && isSecretLikeName(key)) {
      const expression = /^\s*\$\{\{([\s\S]*?)\}\}\s*$/.exec(value)?.[1]?.trim();
      const referencesSecret = expression !== undefined && (
        isReviewedWorkflowAliasChain(expression)
        || (["GH_TOKEN", "GITHUB_TOKEN"].includes(key) && expression === "github.token")
      );
      if (!referencesSecret && value.trim().length > 0) {
        findings.push({
          path,
          line: yamlLine(document, node, source),
          column: 1,
          variable: key,
          kind: "literal-secret-value",
          detail: "workflow env entry holds a committed value",
        });
      }
    }
  };

  walk(document.contents, []);
  return findings;
}

function walkJsonValue(value, keyPath, findings, path) {
  if (Array.isArray(value)) {
    for (const entry of value) walkJsonValue(entry, keyPath, findings, path);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      walkJsonValue(entry, [...keyPath, key], findings, path);
    }
    return;
  }
  const key = keyPath.at(-1) ?? "";
  if (typeof value !== "string" || value.length === 0) return;
  if (!isSecretLikeName(key)) return;
  findings.push({
    path,
    line: 0,
    column: 0,
    variable: `${keyPath.join(".")}`,
    kind: "literal-secret-value",
    detail: "native build configuration holds a committed value",
  });
}

/**
 * Scan native build configuration (eas.json, app.json, wrangler config) for a
 * secret-like key bound to a committed string.
 */
export function scanBuildConfig({ path, source }) {
  const findings = [];
  let parsed;
  try {
    parsed = JSON.parse(stripJsonComments(source));
  } catch {
    findings.push({
      path,
      line: 1,
      column: 1,
      variable: "(document)",
      kind: "indeterminate-fallback",
      detail: "build configuration could not be parsed",
    });
    return findings;
  }
  walkJsonValue(parsed, [], findings, path);
  return findings;
}

/** Minimal JSONC comment stripper for wrangler `.jsonc` configuration. */
function stripJsonComments(source) {
  let output = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (inLine) {
      if (character === "\n") {
        inLine = false;
        output += character;
      }
      continue;
    }
    if (inBlock) {
      if (character === "*" && next === "/") {
        inBlock = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      output += character;
      if (character === "\\") {
        output += next ?? "";
        index += 1;
        continue;
      }
      if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      inLine = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      inBlock = true;
      index += 1;
      continue;
    }
    output += character;
  }
  return output;
}

export function scanFile({ path, source }) {
  if (/\.(?:ya?ml)$/.test(path)) return scanWorkflow({ path, source });
  if (/\.(?:json|jsonc)$/.test(path)) return scanBuildConfig({ path, source });
  return scanSource({ path, source });
}

/**
 * Validate the reviewed allowlist. Every entry must name one exact repository
 * path, one exact variable and one exact finding kind, and must carry a human
 * reason plus review provenance. Patterns, globs and regular expressions are
 * refused: a regex-wide exclusion is precisely the failure mode this record
 * exists to remove.
 */
export function validateAllowlist(allowlist) {
  const problems = [];
  if (!allowlist || typeof allowlist !== "object" || Array.isArray(allowlist)) {
    return ["allowlist must be a JSON object"];
  }
  if (allowlist.schema !== 1) problems.push("allowlist schema must be 1");
  const entries = allowlist.entries;
  if (!Array.isArray(entries)) return [...problems, "allowlist entries must be an array"];
  if (entries.length > 64) problems.push("allowlist may not exceed 64 reviewed entries");
  const seen = new Set();
  entries.forEach((entry, index) => {
    const label = `entry ${index}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${label} must be an object`);
      return;
    }
    const keys = Object.keys(entry).sort();
    const expected = ["kind", "path", "reason", "reviewed_by", "reviewed_on", "variable"];
    if (JSON.stringify(keys) !== JSON.stringify(expected)) {
      problems.push(`${label} must have exactly ${expected.join(", ")}`);
      return;
    }
    if (typeof entry.path !== "string" || entry.path.length === 0
      || /[*?[\]]/.test(entry.path) || entry.path.includes("..")) {
      problems.push(`${label} path must be one exact repository path without patterns`);
    }
    if (typeof entry.variable !== "string" || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(entry.variable)) {
      problems.push(`${label} variable must be one exact identifier`);
    }
    if (!FINDING_KIND_SET.has(entry.kind)) {
      problems.push(`${label} kind must be one of ${FINDING_KINDS.join(", ")}`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 24) {
      problems.push(`${label} reason must explain why the default is not a secret`);
    }
    if (typeof entry.reviewed_by !== "string" || entry.reviewed_by.trim().length === 0) {
      problems.push(`${label} reviewed_by must name the reviewing session or person`);
    }
    if (typeof entry.reviewed_on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewed_on)) {
      problems.push(`${label} reviewed_on must be an exact YYYY-MM-DD date`);
    }
    const key = `${entry.path}\u0000${entry.variable}\u0000${entry.kind}`;
    if (seen.has(key)) problems.push(`${label} duplicates an earlier allowlist entry`);
    seen.add(key);
  });
  return problems;
}

export function allowlistKey(finding) {
  return `${finding.path}\u0000${finding.variable}\u0000${finding.kind}`;
}

/**
 * Apply the reviewed allowlist to a finding set. Returns the surviving
 * findings plus the allowlist entries that matched nothing, so a stale
 * exclusion cannot quietly widen the gate over time.
 */
export function applyAllowlist(findings, allowlist) {
  const entries = Array.isArray(allowlist?.entries) ? allowlist.entries : [];
  const index = new Map(
    entries.map((entry) => [allowlistKey(entry), entry]),
  );
  const used = new Set();
  const remaining = [];
  for (const finding of findings) {
    const key = allowlistKey(finding);
    if (index.has(key)) {
      used.add(key);
      continue;
    }
    remaining.push(finding);
  }
  const unused = entries.filter((entry) => !used.has(allowlistKey(entry)));
  return { remaining, unused };
}

/** Human-readable finding line. It never contains the offending value. */
export function formatFinding(finding) {
  const location = finding.line > 0 ? `${finding.path}:${finding.line}` : finding.path;
  return `${location} ${finding.variable} [${finding.kind}] ${finding.detail} (value redacted)`;
}
