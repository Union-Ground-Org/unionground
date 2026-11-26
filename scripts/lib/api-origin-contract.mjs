import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { parse, VisitorKeys } from "espree";

const MUTATION_METHODS = ["POST", "PUT", "PATCH", "DELETE"];
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie"]);

export const MUTATION_ORIGIN_EXCEPTIONS = Object.freeze({
  "api/accept-invitation.js": "route-local-origin-bound-invitation",
  // The mail provider posts delivery events from its own servers with no
  // Origin and no session; the Svix signature over the raw body is the whole
  // authority and the route only records a content-free failure kind.
  "api/account-mail-events.js": "svix-signed-mail-provider-webhook",
  "api/auth-password-signin.js": "unauthenticated-password-bootstrap",
  // Union Ground's public connect intake: no session; it refuses any Origin
  // but the configured app origin and any cross-site Fetch Metadata itself.
  "api/connect.js": "route-local-origin-bound-public-request",
  "api/demo-session.js": "sample-only-session-bootstrap",
  // REQ-UG-INVITE-TERMS-AGE-STATE-FORM-CLARITY-20261030: the
  // invitation page's read of a pending invitation; the same route-local
  // origin binding and token authority as acceptance, and it changes nothing.
  "api/invitation-preview.js": "route-local-origin-bound-invitation",
  "api/invite-request.js": "route-local-origin-bound-public-request",
  // RFC 8058: mail providers POST the one-click request from their own
  // servers with no Origin and no session; the database-signed token is the
  // whole authority and only ever turns one email category off.
  "api/email-unsubscribe.js": "signed-one-click-unsubscribe",
  // REQ-UG-ENGAGEMENT-EMAIL-RESEND-BRIDGE-20261121: only this
  // deployment's delivery route calls it, through Node's fetch, which always
  // sends Sec-Fetch-Mode; its first statement must be the serverCaller check
  // (api/_lib/serverCaller.js), and the 32+ character bearer is the authority.
  "api/engagement-email-bridge.js": "bearer-only-server-webhook",
  // REQ-UG-INTAKE-QUEUE-EMAIL-THE-OPT-IN-LIST-20261118: the same
  // RFC 8058 one-click post for the landing list's topic update emails; the
  // single-use stop token (only its digest is stored) is the whole authority
  // and only ever confirms that address's stop.
  "api/public-interest-unsubscribe.js": "single-use-stop-token-one-click-unsubscribe",
  "api/public-interest-stop-confirm.js": "route-local-origin-bound-public-request",
  "api/public-interest-stop.js": "route-local-origin-bound-public-request",
  "api/public-interest.js": "route-local-origin-bound-public-request",
  "api/steward-email-intake.js": "hmac-signed-email-webhook",
  "api/twilio-inbound.js": "twilio-signed-webhook",
  "api/twilio-status.js": "twilio-signed-webhook",
});

function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of VisitorKeys[node.type] || []) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visit);
    } else {
      walk(child, visit);
    }
  }
}

function propertyName(node) {
  if (!node) return "";
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  if (node.computed && node.property?.type === "Literal") return String(node.property.value || "");
  return "";
}

function isHeadersMember(node) {
  return node?.type === "MemberExpression" && propertyName(node).toLowerCase() === "headers";
}

function bindingNames(pattern) {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "RestElement") return bindingNames(pattern.argument);
  if (pattern.type === "AssignmentPattern") return bindingNames(pattern.left);
  if (pattern.type === "ArrayPattern") return pattern.elements.flatMap(bindingNames);
  if (pattern.type === "ObjectPattern") return pattern.properties.flatMap((property) => (
    bindingNames(property.type === "RestElement" ? property.argument : property.value)
  ));
  return [];
}

function isShadowed(fn, names) {
  let shadowed = false;
  walk(fn, (node) => {
    const bindings = node.type === "VariableDeclarator" ? bindingNames(node.id)
      : [...bindingNames(node.id), ...(node.params || []).flatMap(bindingNames)];
    if (bindings.some((name) => names.has(name))) shadowed = true;
  });
  return shadowed;
}

function literalData(node) {
  if (!node) return false;
  if (node.type === "Literal") return true;
  return node.type === "ObjectExpression" && node.properties.every((property) => (
    property.type === "Property" && !property.computed && !property.method
      && property.kind === "init" && literalData(property.value)
  ));
}

// Only these response operations may precede a read-only method rejection.
// Arbitrary calls, credential access and unknown control flow require the guard.
function responseOperation(node, responseName, jsonNames) {
  if (node?.type !== "CallExpression") return false;
  if (node.callee.type === "Identifier" && jsonNames.has(node.callee.name)) {
    return node.arguments.length === 3 && node.arguments[0]?.name === responseName
      && node.arguments.slice(1).every(literalData);
  }
  const callee = node.callee;
  return callee.type === "MemberExpression" && ["status", "setHeader", "end"].includes(propertyName(callee))
    && node.arguments.every(literalData)
    && ((callee.object.type === "Identifier" && callee.object.name === responseName)
      || responseOperation(callee.object, responseName, jsonNames));
}

function rejectsWithoutWork(node, responseName, jsonNames, callback = false) {
  if (callback && node?.type !== "BlockStatement") return responseOperation(node, responseName, jsonNames);
  const statements = node?.type === "BlockStatement" ? node.body : [node];
  if (!statements.length) return false;
  for (let i = 0; i < statements.length; i += 1) {
    const statement = statements[i];
    if (statement?.type === "ReturnStatement") {
      return i === statements.length - 1 && (!statement.argument || responseOperation(statement.argument, responseName, jsonNames));
    }
    if (statement?.type !== "ExpressionStatement" || !responseOperation(statement.expression, responseName, jsonNames)) return false;
  }
  return callback;
}

function methodCondition(node, requestName, method) {
  if (node?.type === "LogicalExpression" && ["&&", "||"].includes(node.operator)) {
    const left = methodCondition(node.left, requestName, method);
    const right = methodCondition(node.right, requestName, method);
    if (left === null || right === null) return null;
    return node.operator === "&&" ? left && right : left || right;
  }
  if (node?.type !== "BinaryExpression" || !["===", "!=="].includes(node.operator)
      || node.left?.type !== "MemberExpression" || node.left.object?.name !== requestName
      || propertyName(node.left) !== "method" || node.right?.type !== "Literal") return null;
  return node.operator === "===" ? method === node.right.value : method !== node.right.value;
}

function hasReadOnlyGate(fn, methodNames, jsonNames) {
  if (!fn?.params?.every((param) => param.type === "Identifier") || !fn.params[0]) return false;
  if (isShadowed(fn, new Set([...methodNames, ...jsonNames]))) return false;
  const requestName = fn.params[0].name;
  const responseName = fn.params[1]?.name;
  for (const statement of fn.body?.body || []) {
    if (statement.type === "ExpressionStatement" && responseOperation(statement.expression, responseName, jsonNames)) continue;
    if (statement.type !== "IfStatement" || statement.alternate
        || !rejectsWithoutWork(statement.consequent, responseName, jsonNames)) return false;
    const test = statement.test;
    if (test.type === "CallExpression" && test.callee.type === "Identifier" && methodNames.has(test.callee.name)) {
      const [request, methods, reject] = test.arguments;
      return test.arguments.length === 3 && request?.type === "Identifier" && request.name === requestName
        && methods?.type === "ArrayExpression" && methods.elements.length > 0
        && methods.elements.every((item) => item?.type === "Literal" && READ_METHODS.has(item.value))
        && ["ArrowFunctionExpression", "FunctionExpression"].includes(reject?.type)
        && reject.params.length === 0 && rejectsWithoutWork(reject.body, responseName, jsonNames, true);
    }
    return MUTATION_METHODS.every((method) => methodCondition(test, requestName, method) === true);
  }
  return false;
}

// Deliberately enforce one auditable entry shape rather than attempting to
// prove arbitrary JavaScript control flow. The first handler statement must
// reject a false validator result for the actual request, before any side effect.
function hasEntryBoundary(fn, validatorNames, jsonNames) {
  if (!fn || fn.params?.[0]?.type !== "Identifier") return false;
  const requestName = fn.params[0].name;
  const guard = fn.body?.body?.[0];
  const call = guard?.test?.argument;
  if (guard?.type !== "IfStatement" || guard.alternate
      || guard.test?.type !== "UnaryExpression" || guard.test.operator !== "!"
      || call?.type !== "CallExpression" || call.callee?.type !== "Identifier"
      || !validatorNames.has(call.callee.name)
      || call.arguments.length !== 1 || call.arguments[0]?.type !== "Identifier"
      || call.arguments[0].name !== requestName) return false;
  // Default expressions on the handler itself execute before its body.
  if (fn.params.some((param) => param.type !== "Identifier")
      || isShadowed(fn, new Set([...validatorNames, ...jsonNames]))) return false;
  const statements = guard.consequent.type === "BlockStatement"
    ? guard.consequent.body : [guard.consequent];
  if (statements.length !== 1 || statements[0].type !== "ReturnStatement") return false;
  const result = statements[0].argument;
  if (!result || (result.type === "Literal" && result.value === "")) return true;
  return result.type === "CallExpression" && result.callee.type === "Identifier"
    && jsonNames.has(result.callee.name) && result.arguments[0]?.type === "Identifier"
    && result.arguments[0].name === fn.params[1]?.name
    && result.arguments[1]?.type === "Literal"
    && result.arguments[1].value >= 400 && result.arguments[1].value < 500
    // The rejection payload itself must not perform work.
    && result.arguments.slice(2).every((argument) => {
      let safe = true;
      walk(argument, (node) => {
        if (!["ObjectExpression", "Property", "Identifier", "Literal"].includes(node.type)
            || (node.type === "Property" && (node.computed || node.method || node.kind !== "init"))) safe = false;
      });
      return safe;
    });
}

function analyze(source, path) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  let directCredential = false;
  let authenticateCall = false;
  let handler;
  let bearerHelper;
  const validators = new Set();
  const jsonNames = new Set();
  const methodNames = new Set();
  const serverCallerChecks = new Set();

  for (const node of ast.body) {
    if (node.type === "ImportDeclaration"
        && String(node.source?.value || "").startsWith(".")
        && posix.normalize(posix.join(posix.dirname(path), node.source.value)) === "api/_lib/http.js") {
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") authenticateCall = true;
        if (specifier.type !== "ImportSpecifier") continue;
        if (["authenticate", "bearerToken"].includes(specifier.imported?.name)) authenticateCall = true;
        if (specifier.imported?.name === "validateMutationOrigin") validators.add(specifier.local.name);
        if (["json", "secureHtml"].includes(specifier.imported?.name)) jsonNames.add(specifier.local.name);
        if (specifier.imported?.name === "methodGuard") methodNames.add(specifier.local.name);
      }
    }
    if (node.type === "ImportDeclaration"
        && String(node.source?.value || "").startsWith(".")
        && posix.normalize(posix.join(posix.dirname(path), node.source.value)) === "api/_lib/serverCaller.js") {
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportSpecifier" && specifier.imported?.name === "serverCaller") serverCallerChecks.add(specifier.local.name);
      }
    }
    if (node.type === "ExportDefaultDeclaration") handler = node.declaration;
    if (node.type === "ExportNamedDeclaration" && node.declaration?.id?.name === "bearerToken") {
      bearerHelper = node.declaration;
    }
  }

  // Track header aliases to a fixed point, including aliases declared before
  // their source and destructuring. Signing-header helpers remain valid;
  // reading a browser credential through an alias does not grant an exemption.
  const headerAliases = new Set();
  function headersExpression(node) {
    if (node?.type === "ChainExpression") return headersExpression(node.expression);
    if (node?.type === "LogicalExpression") return headersExpression(node.left) || headersExpression(node.right);
    return isHeadersMember(node) || (node?.type === "Identifier" && headerAliases.has(node.name));
  }
  function trackHeadersPattern(pattern) {
    if (pattern?.type === "AssignmentPattern") return trackHeadersPattern(pattern.left);
    if (pattern?.type === "Identifier") headerAliases.add(pattern.name);
    if (pattern?.type !== "ObjectPattern") return;
    for (const property of pattern.properties) {
      if (property.type === "RestElement") trackHeadersPattern(property.argument);
      const key = property.key?.name || property.key?.value;
      if (CREDENTIAL_HEADERS.has(String(key || "").toLowerCase())) directCredential = true;
    }
  }
  let priorSize;
  do {
    priorSize = headerAliases.size;
    walk(ast, (node) => {
      if (node.type !== "VariableDeclarator" && node.type !== "AssignmentExpression") return;
      const pattern = node.id || node.left;
      const value = node.init || node.right;
      if (headersExpression(value)) trackHeadersPattern(pattern);
      if (pattern?.type === "ObjectPattern") {
        for (const property of pattern.properties) {
          if ((property.key?.name || property.key?.value) === "headers") trackHeadersPattern(property.value);
        }
      }
    });
  } while (headerAliases.size !== priorSize);

  walk(ast, (node) => {
    if (node.type === "CallExpression" && node.callee?.type === "Identifier") {
      authenticateCall ||= node.callee.name === "authenticate";
    }
    if (node.type === "MemberExpression") {
      const name = propertyName(node).toLowerCase();
      if (CREDENTIAL_HEADERS.has(name) && headersExpression(node.object)) directCredential = true;
    }
    if (node.type === "CallExpression" && node.callee?.type === "MemberExpression"
        && propertyName(node.callee) === "get" && headersExpression(node.callee.object)
        && node.arguments[0]?.type === "Literal"
        && CREDENTIAL_HEADERS.has(String(node.arguments[0].value || "").toLowerCase())) directCredential = true;
  });

  return {
    readOnly: hasReadOnlyGate(handler, methodNames, jsonNames),
    directCredential,
    authenticateCall,
    sharedBoundary: hasEntryBoundary(handler, validators, jsonNames),
    serverCallerBoundary: hasEntryBoundary(handler, serverCallerChecks, jsonNames),
    bearerHelperPresent: Boolean(bearerHelper),
    bearerHelperUsesOrigin: hasEntryBoundary(bearerHelper, new Set(["validateMutationOrigin"]), new Set()),
  };
}

export function verifyApiOriginSources(entries = []) {
  const violations = [];
  for (const entry of entries) {
    const path = String(entry?.path || "");
    const source = String(entry?.source || "");
    if (!path.endsWith(".js")) {
      violations.push({ path, code: "api-source-unsupported-extension" });
      continue;
    }
    let details;
    try {
      details = analyze(source, path);
    } catch {
      violations.push({ path, code: "api-source-parse-failed" });
      continue;
    }
    if (path === "api/_lib/http.js") {
      if (!details.bearerHelperPresent || !details.bearerHelperUsesOrigin) {
        violations.push({ path, code: "bearer-helper-without-origin-validation" });
      }
      continue;
    }
    if (details.readOnly || details.sharedBoundary) continue;
    // A bearer-only server webhook reads Authorization itself; it passes only
    // when listed with that reason AND its first statement is the shared
    // serverCaller refusal of a browser.
    if (MUTATION_ORIGIN_EXCEPTIONS[path] === "bearer-only-server-webhook" && details.serverCallerBoundary) continue;
    if (details.authenticateCall) {
      violations.push({ path, code: "session-mutation-without-origin-boundary" });
    } else if (details.directCredential) {
      violations.push({ path, code: "credential-mutation-without-origin-boundary" });
    } else if (!MUTATION_ORIGIN_EXCEPTIONS[path]) {
      violations.push({ path, code: "mutation-without-origin-classification" });
    }
  }
  return violations.sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code));
}

async function endpointSources(directory, relativeDirectory = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const sources = [];
  for (const entry of entries) {
    if (entry.name.startsWith("_")) continue;
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...await endpointSources(absolutePath, relativePath));
    } else if (entry.isFile()) {
      sources.push({ path: `api/${relativePath}`, source: await readFile(absolutePath, "utf8") });
    }
  }
  return sources;
}

export async function scanApiOriginDirectory(apiDirectory) {
  const sources = await endpointSources(apiDirectory);
  sources.push({
    path: "api/_lib/http.js",
    source: await readFile(join(apiDirectory, "_lib", "http.js"), "utf8"),
  });
  return verifyApiOriginSources(sources);
}
