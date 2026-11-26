// Finds every place a script restates the contract's rlsTableCount as a number.
//
// AST-aware, like scripts/lib/env-fallback-scan.mjs: TypeScript's parser reads
// each scripts/**/*.mjs that names rlsTableCount, so a restatement is read from
// the real expression shape. A mention in a comment or inside a string is not
// code and is never seen; a reversed comparison, a loose one, an assert.equal
// family call, a named constant and an object pin all are.
//
// The scan fails closed. A mention in code that is neither a readable
// restatement nor a message interpolation is reported as unreadable, so a
// spelling this file does not know turns the guard red instead of hiding.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript-compiler-api";

const NAME = "rlsTableCount";

const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

// assert.equal(a, b), assert.strictEqual(a, b), and the rest of that family.
const ASSERT_CALL = /^(?:assert\.)?(?:not)?(?:strict|deep|deepStrict)?equals?$/i;

function mjsFilesUnder(root, directory = root) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...mjsFilesUnder(root, path));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) found.push(path);
  }
  return found;
}

function unwrap(node) {
  let current = node;
  while (current && ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isMention(node) {
  const expression = unwrap(node);
  if (ts.isIdentifier(expression)) return expression.text === NAME;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === NAME;
  if (ts.isElementAccessExpression(expression)) {
    const argument = unwrap(expression.argumentExpression);
    return ts.isStringLiteralLike(argument) && argument.text === NAME;
  }
  return false;
}

// Top-level and nested `const X = 309` alike: the name is what a comparison
// would cite, so every numeric initialiser in the file is a candidate.
function numericConstants(sourceFile) {
  const constants = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrap(node.initializer);
      if (ts.isNumericLiteral(initializer)) constants.set(node.name.text, Number(initializer.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return constants;
}

function numberOf(node, constants) {
  const expression = unwrap(node);
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (ts.isIdentifier(expression) && constants.has(expression.text)) return constants.get(expression.text);
  return null;
}

function insideTemplateSpan(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTemplateSpan(current)) return true;
  }
  return false;
}

// `a.b.rlsTableCount` is one mention, not two: the access is the mention and
// its name identifier is part of it.
function isNameOfAccess(node) {
  return ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
}

// `const { rlsTableCount } = contract.policyCoverage` only brings the live
// value into scope under its own name, where the comparison is still read.
// An aliased binding (`{ rlsTableCount: n }`) hides it and is not benign.
function isPlainBinding(node) {
  return ts.isBindingElement(node.parent) && node.parent.name === node && !node.parent.propertyName;
}

// `{ "rlsTableCount": 309 }` — a quoted key is a string only to the parser.
function isQuotedKey(node) {
  return ts.isStringLiteralLike(node) && node.text === NAME;
}

/**
 * Reads one script. `literals` are the numbers it restates; `unreadable` are
 * the code mentions of rlsTableCount the scan could not reduce to a number.
 */
export function readRestatements(name, source) {
  const sourceFile = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const constants = numericConstants(sourceFile);
  const literals = [];
  const unreadable = [];
  const settled = new Set();

  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const settle = (mention, other) => {
    settled.add(unwrap(mention));
    const value = numberOf(other, constants);
    if (value === null) unreadable.push(`${name}:${lineOf(mention)}`);
    else literals.push(value);
  };

  const visit = (node) => {
    if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) {
      if (isMention(node.left)) settle(node.left, node.right);
      else if (isMention(node.right)) settle(node.right, node.left);
    } else if (ts.isCallExpression(node) && ASSERT_CALL.test(node.expression.getText(sourceFile))) {
      const [first, second] = node.arguments;
      if (first && second && isMention(first)) settle(first, second);
      else if (first && second && isMention(second)) settle(second, first);
    } else if (ts.isPropertyAssignment(node) && (isMention(node.name) || isQuotedKey(node.name))) {
      settle(node.name, node.initializer);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === NAME && node.initializer) {
      // `const rlsTableCount = 309` restates; `= contract.…rlsTableCount` aliases.
      if (isMention(node.initializer)) settled.add(node.name).add(unwrap(node.initializer));
      else settle(node.name, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  // Whatever is left is a mention nobody compared to a number. Interpolating
  // the live value into a failure message is the one benign shape.
  const sweep = (node) => {
    const candidate = !ts.isParenthesizedExpression(node) && !isNameOfAccess(node) && isMention(node);
    if (candidate && !settled.has(node) && !insideTemplateSpan(node) && !isPlainBinding(node)) {
      unreadable.push(`${name}:${lineOf(node)}`);
    }
    ts.forEachChild(node, sweep);
  };
  sweep(sourceFile);

  return { name, literals, unreadable };
}

/**
 * Every .mjs at any depth under `scriptsRoot` that names rlsTableCount in
 * code, except `derivers` — the scripts that measure the number live rather
 * than restate it.
 */
export function rlsTableCountRestatements(scriptsRoot, { derivers = [] } = {}) {
  return mjsFilesUnder(scriptsRoot)
    .map((path) => ({ path, name: relative(scriptsRoot, path).split(sep).join("/") }))
    .filter(({ name }) => !derivers.includes(name))
    .map(({ path, name }) => ({ name, source: readFileSync(path, "utf8") }))
    .filter(({ source }) => source.includes(NAME))
    .map(({ name, source }) => readRestatements(name, source))
    .filter((entry) => entry.literals.length > 0 || entry.unreadable.length > 0);
}
