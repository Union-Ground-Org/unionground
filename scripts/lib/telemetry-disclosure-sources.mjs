import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";
import { readPins, writePins } from "./source-pins.mjs";

export const TELEMETRY_PINS = "config/telemetry-disclosure-sources.d";
export function readTelemetrySources() {
  const descriptor = JSON.parse(readFileSync("config/telemetry-disclosure-sources.json", "utf8"));
  if (descriptor.schema !== 2 || descriptor.pins !== TELEMETRY_PINS || Object.keys(descriptor).sort().join(",") !== "pins,schema") {
    throw new Error("Invalid telemetry source pin descriptor");
  }
  const result = { browserWrites: {}, cookieWrites: {}, keySources: {}, config: {}, sdk: {}, sdkSources: {} };
  for (const [key, value] of Object.entries(readPins(TELEMETRY_PINS))) {
    const slash = key.indexOf("/");
    const group = key.slice(0, slash); const source = key.slice(slash + 1);
    if (slash < 1 || !Object.hasOwn(result, group) || !source) throw new Error("Invalid telemetry source identity");
    Object.defineProperty(result[group], source, { value, enumerable: true });
  }
  return result;
}
export function writeTelemetrySources(values) {
  writePins(TELEMETRY_PINS, Object.fromEntries(Object.entries(values)
    .flatMap(([group, sources]) => Object.entries(sources).map(([source, value]) => [`${group}/${source}`, value]))));
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return; }
  if (node.type) visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (!["loc", "comments", "leadingComments", "trailingComments", "innerComments", "tokens"].includes(key)) walk(child, visit);
  }
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const path = join(directory, item.name);
    return item.isDirectory() ? files(path) : /\.(js|jsx)$/.test(path) ? [path] : [];
  }).sort();
}

// The algorithm label is part of the retained value. It also keeps a
// path-and-digest pair in the pin from reading as a credential to the
// committed-secret scanner's generic-api-key heuristic.
const hash = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const read = (path) => readFileSync(path, "utf8");

export function telemetryKeySourcePin(source) {
  const keys = [];
  const ast = parse(source, { sourceType: "module", plugins: ["jsx", "importAttributes"] });
  const text = (node) => source.slice(node.start, node.end).replace(/\s+/g, " ").trim();
  walk(ast, (node) => {
    if (node.type === "VariableDeclarator" && /KEY|PREFIX|COOKIE|DB_NAME/.test(node.id?.name || "") && node.init) keys.push(text(node));
    if (node.type === "FunctionDeclaration" && /key|storage|cookie/i.test(node.id?.name || "")) keys.push(text(node));
    if (node.type === "TemplateLiteral" && /^(sg[-:]|ug[-.:]|union-ground|unionground\.learning|compass\.nudges|contextual_pulse)/.test(node.quasis[0]?.value?.raw || "")) keys.push(text(node));
  });
  return keys.length ? hash(keys.sort().join("\n")) : null;
}

// One file's storage writes, cookie writes and key constants, as the pins
// record them. The release reads a staged cookie writer's file through this
// same function, so a declaration is checked against the calls it names.
export function telemetryFileWrites(source) {
  const ast = parse(source, { sourceType: "module", plugins: ["jsx", "importAttributes"] });
  const writes = [], cookies = [], keys = [];
  const text = (node) => source.slice(node.start, node.end).replace(/\s+/g, " ").trim();
  walk(ast, (node) => {
    const member = node.callee;
    const property = member?.property?.name || member?.property?.value;
    if ((node.type === "CallExpression" || node.type === "OptionalCallExpression") && property === "setItem") writes.push(text(node));
    if ((node.type === "CallExpression" || node.type === "OptionalCallExpression") && property === "open"
      && /^(indexedDB|idb)$/.test(member?.object?.name || "")) writes.push(text(node));
    if ((node.type === "CallExpression" || node.type === "OptionalCallExpression") && property === "setHeader"
      && String(node.arguments?.[0]?.value).toLowerCase() === "set-cookie") cookies.push(text(node));
    if (node.type === "AssignmentExpression" && node.left?.property?.name === "cookie") cookies.push(text(node));
    if (node.type === "VariableDeclarator" && /KEY|PREFIX|COOKIE|DB_NAME/.test(node.id?.name || "") && node.init) keys.push(text(node));
    if (node.type === "FunctionDeclaration" && /key|storage|cookie/i.test(node.id?.name || "")) keys.push(text(node));
    if (node.type === "TemplateLiteral" && /^(sg[-:]|ug[-.:]|union-ground|unionground\.learning|compass\.nudges|contextual_pulse)/.test(node.quasis[0]?.value?.raw || "")) keys.push(text(node));
  });
  return { writes, cookies, keys };
}

// Detect new write sites across the application, plus changes to key literals
// and constructors. Offsets, comments and formatting are not part of the pin.
export function collectTelemetrySources() {
  const inventory = JSON.parse(read("src/data/telemetryDisclosure.json"));
  const keyPaths = new Set([...inventory.storage.flatMap((row) => row.sources), ...inventory.cookies.map((row) => row.source)]);
  const browserWrites = {};
  const cookieWrites = {};
  const keySources = {};
  for (const path of [...files("src"), ...files("api")]) {
    const source = read(path);
    if (!/setItem|indexedDB|[Kk][Ee][Yy]|[Pp][Rr][Ee][Ff][Ii][Xx]|[Cc]ookie/.test(source)) continue;
    const { writes, cookies, keys } = telemetryFileWrites(source);
    if (path.startsWith("src/") && writes.length) browserWrites[path] = writes;
    if (cookies.length) cookieWrites[path] = cookies;
    if (keys.length && keyPaths.has(path)) keySources[path] = hash(keys.sort().join("\n"));
  }
  const config = {};
  for (const path of ["src/lib/observability.js", "src/lib/observabilityPrivacy.js", "src/lib/sentryPrivacy.js",
    "src/lib/shared-core/sentryPrivacy.js",
    "api/_lib/observability.js", "apps/mobile/src/services/observability.ts", "apps/mobile/src/services/observabilityInit.ts",
    // Key constants these files define escape the heuristics above.
    "src/lib/nativeAppNudge.js", "public/sw.js",
    "apps/mobile/src/lib/savedPulseCharts.ts"]) config[path] = hash(read(path));
  const sdk = {};
  // The server functions load @sentry/core's server client, not @sentry/node.
  for (const name of ["posthog-js", "@supabase/auth-js", "@sentry/react", "@sentry/core"]) sdk[name] = JSON.parse(read(`node_modules/${name}/package.json`)).version;
  sdk["@sentry/react-native"] = JSON.parse(read("apps/mobile/package-lock.json")).packages["node_modules/@sentry/react-native"].version;
  const sdkSources = {};
  for (const path of ["node_modules/posthog-js/lib/src/posthog-persistence.js", "node_modules/posthog-js/lib/src/storage.js", "node_modules/posthog-js/lib/src/sessionid.js", "node_modules/posthog-js/lib/src/consent.js", "node_modules/@supabase/auth-js/dist/module/lib/helpers.js"]) sdkSources[path] = hash(read(path));
  return { browserWrites, cookieWrites, keySources, config, sdk, sdkSources };
}

function stagedWriters(staged) {
  const writers = Array.isArray(staged) ? staged : [];
  if (writers.some((writer) => writer?.exempt === true || writer?.all === true)) {
    throw new Error("telemetry staging cannot exempt writers");
  }
  return writers;
}

// Exact calls the pending file named. A wildcard is not a pin.
export function telemetrySourcePin(calls) {
  return `calls:${JSON.stringify(calls)}`;
}

// A staged writer sets browser storage (the default) or, with kind "cookie",
// a cookie. Each kind is pinned in its own group and published in its own
// inventory list: a storage row in storage, a cookie row in cookies.
export function stagedWriterGroup(writer) {
  if (writer?.kind === undefined || writer.kind === "storage") return "browserWrites";
  if (writer.kind === "cookie") return "cookieWrites";
  throw new Error("invalid staged telemetry writer kind");
}

// The writer's own file and every file its row names: the files whose key
// constants the release pins with the writer. A storage row lists sources, as
// on Main; a cookie row's single source is read only for a cookie writer.
export function stagedWriterSources(writer) {
  const cookieSource = stagedWriterGroup(writer) === "cookieWrites" && writer.row?.source ? [writer.row.source] : [];
  return [...new Set([writer.source, ...(writer.row?.sources || []), ...cookieSource])];
}

// Integration configuration is pinned independently of the storage calls.
// A declaration may stage an exact replacement for an already tracked file.
export function stagedTelemetryConfigPins(writer) {
  if (writer.configPins === undefined) return [];
  if (!writer.configPins || typeof writer.configPins !== "object" || Array.isArray(writer.configPins)) throw new Error("invalid staged telemetry configuration pins");
  const entries = Object.entries(writer.configPins);
  for (const [source, pin] of entries) {
    if (!/^(src|api)\/.*\.(js|jsx)$/.test(source) || source.split("/").includes("..") || !/^sha256:[a-f0-9]{64}$/.test(pin)) throw new Error("invalid staged telemetry configuration pin");
  }
  return entries;
}

// A declaration may also stage an exact replacement value for an already
// tracked SDK version or configuration hash with no storage writer (an SDK
// bump, a configuration-only edit). The next legal release promotes it the way
// it promotes a writer's configuration pins.
const STAGED_SDK = /^sdk\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
// The shipped service worker is the one tracked file outside src/ and api/
// whose edits may be staged (record #9535); its Cache Storage row is unchanged.
const STAGED_CONFIG = /^config\/(?:(?:src|api)\/[A-Za-z0-9._/-]+\.(?:js|jsx)|public\/sw\.js)$/;
// A tracked third-party library file (sdkSources) may be staged too, but only
// by a declaration that states storage and collection are unchanged or
// narrower; a bump that widens them goes with a legal release.
const STAGED_LIBRARY = /^sdkSources\/node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9._/-]+\.(?:js|mjs|cjs)$/;
export const LIBRARY_PIN_STATEMENT = "unchanged-or-narrower";
// A staged SDK pin may also replace a tracked SDK under another package name
// (telemetryPinReplaces maps the new key to the one it retires), when the code
// moves to a different package of the same vendor's SDK. It needs the same
// unchanged-or-narrower statement; the release drops the retired pin and adds
// the new one. Such an entry carries the retired key as its third element.
function stagedTelemetryReplacements(file) {
  if (file.telemetryPinReplaces === undefined) return {};
  const replaces = file.telemetryPinReplaces;
  if (!replaces || typeof replaces !== "object" || Array.isArray(replaces) || !Object.keys(replaces).length) throw new Error("invalid staged telemetry pin replacements");
  for (const [key, retired] of Object.entries(replaces)) {
    if (!STAGED_SDK.test(key) || !Object.hasOwn(file.telemetryPins ?? {}, key) || typeof retired !== "string" || !STAGED_SDK.test(retired)
      || retired === key || Object.hasOwn(file.telemetryPins ?? {}, retired)) throw new Error(`invalid staged telemetry pin replacement ${key}`);
  }
  if (new Set(Object.values(replaces)).size !== Object.keys(replaces).length) throw new Error("invalid staged telemetry pin replacements: one retired pin per replacement");
  if (file.collectionChange !== LIBRARY_PIN_STATEMENT) {
    throw new Error(`invalid staged telemetry pin replacements: an SDK replacement needs collectionChange "${LIBRARY_PIN_STATEMENT}"`);
  }
  return replaces;
}
export function stagedTelemetryPins(file) {
  if (file.telemetryPins === undefined) {
    if (file.telemetryPinReplaces !== undefined) throw new Error("invalid staged telemetry pin replacements");
    return [];
  }
  if (!file.telemetryPins || typeof file.telemetryPins !== "object" || Array.isArray(file.telemetryPins)) throw new Error("invalid staged telemetry pins");
  const entries = Object.entries(file.telemetryPins);
  if (!entries.length) throw new Error("invalid staged telemetry pins");
  for (const [key, value] of entries) {
    const valid = typeof value === "string" && !key.split("/").includes("..") && (STAGED_SDK.test(key)
      ? /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)
      : (STAGED_CONFIG.test(key) || STAGED_LIBRARY.test(key)) && /^sha256:[a-f0-9]{64}$/.test(value));
    if (!valid) throw new Error(`invalid staged telemetry pin ${key}`);
  }
  if (entries.some(([key]) => key.startsWith("sdkSources/")) && file.collectionChange !== LIBRARY_PIN_STATEMENT) {
    throw new Error(`invalid staged telemetry pins: a library file hash needs collectionChange "${LIBRARY_PIN_STATEMENT}"`);
  }
  const replaces = stagedTelemetryReplacements(file);
  return entries.map(([key, value]) => (Object.hasOwn(replaces, key) ? [key, value, replaces[key]] : [key, value]));
}

function pendingFiles(root) {
  const directory = join(root, "content/legal/pending");
  let names;
  try { names = readdirSync(directory).sort(); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return names.filter((name) => name.endsWith(".json")).map((name) => JSON.parse(read(join(directory, name))));
}

export function readStagedTelemetryWriters(root = process.cwd()) {
  return pendingFiles(root).flatMap((file) => file.telemetryWriters || []);
}

// Two declarations may stage the same pin only with the same value and the
// same retired pin.
export function readStagedTelemetryPins(root = process.cwd()) {
  const staged = new Map();
  for (const file of pendingFiles(root)) {
    for (const entry of stagedTelemetryPins(file)) {
      const [key, value, retires] = entry;
      const prior = staged.get(key);
      if (prior && (prior[1] !== value || prior[2] !== retires)) throw new Error(`conflicting staged telemetry pin ${key}`);
      staged.set(key, entry);
    }
  }
  return [...staged.values()];
}

// Drop writers whose pending file pins the exact calls. Every other writer
// stays in the set the published pins must match. A staged SDK or
// configuration pin stands in for the retained value only while the collected
// value is exactly the staged one.
export function publishedTelemetrySources(collected, staged, retained = { browserWrites: {} }, stagedPins = []) {
  const browserWrites = { ...collected.browserWrites };
  const cookieWrites = { ...collected.cookieWrites };
  const keySources = { ...collected.keySources };
  const config = { ...collected.config };
  const sdk = { ...collected.sdk };
  const sdkSources = { ...collected.sdkSources };
  for (const writer of stagedWriters(staged)) {
    const group = stagedWriterGroup(writer);
    const writes = group === "cookieWrites" ? cookieWrites : browserWrites;
    const calls = writes[writer.source];
    if (calls && writer.release && telemetrySourcePin(calls) === writer.pin) {
      if (retained[group]?.[writer.source]) writes[writer.source] = retained[group][writer.source];
      else delete writes[writer.source];
      if (retained.keySources?.[writer.source]) keySources[writer.source] = retained.keySources[writer.source];
      else delete keySources[writer.source];
      for (const [source, pin] of stagedTelemetryConfigPins(writer)) {
        if (!retained.config?.[source] || collected.config?.[source] !== pin) throw new Error(`staged telemetry configuration does not match ${source}`);
        config[source] = retained.config[source];
      }
    }
  }
  for (const [key, value, retires] of stagedPins) {
    const slash = key.indexOf("/");
    const group = key.slice(0, slash);
    const source = key.slice(slash + 1);
    const target = { sdk, config, sdkSources }[group];
    if (retires) {
      // A replacement stands in for the retired pin while the new package is
      // collected at the staged version and the retired one is gone.
      const old = retires.slice("sdk/".length);
      if (group !== "sdk" || !retires.startsWith("sdk/") || !Object.hasOwn(retained.sdk ?? {}, old) || Object.hasOwn(retained.sdk ?? {}, source)
        || collected.sdk?.[source] !== value || Object.hasOwn(collected.sdk ?? {}, old)) {
        throw new Error(`staged telemetry pin does not match ${key}`);
      }
      delete sdk[source];
      sdk[old] = retained.sdk[old];
      continue;
    }
    if (!target || !Object.hasOwn(retained[group] ?? {}, source) || collected[group]?.[source] !== value) {
      throw new Error(`staged telemetry pin does not match ${key}`);
    }
    target[source] = retained[group][source];
  }
  return { ...collected, browserWrites, ...(collected.cookieWrites ? { cookieWrites } : {}), ...(collected.keySources ? { keySources } : {}), ...(collected.config ? { config } : {}),
    ...(collected.sdk ? { sdk } : {}), ...(collected.sdkSources ? { sdkSources } : {}) };
}

export function telemetryWriterFailures(collected, retained, staged) {
  const writers = stagedWriters(staged);
  const failures = [];
  for (const group of ["browserWrites", "cookieWrites"]) {
    for (const [source, calls] of Object.entries(collected[group] || {})) {
      const kept = retained[group]?.[source];
      if (kept && JSON.stringify(kept) === JSON.stringify(calls)) continue;
      const pin = telemetrySourcePin(calls);
      if (writers.some((writer) => stagedWriterGroup(writer) === group && writer.source === source && writer.pin === pin && writer.release)) continue;
      failures.push(source);
    }
    for (const source of Object.keys(retained[group] || {})) {
      if (!collected[group]?.[source]) failures.push(source);
    }
  }
  // A staged cookie writer whose calls are gone from its file declares a
  // cookie nothing sets; it fails rather than wait to be promoted.
  for (const writer of writers) {
    if (stagedWriterGroup(writer) === "cookieWrites" && !collected.cookieWrites?.[writer.source] && !failures.includes(writer.source)) failures.push(writer.source);
  }
  return failures;
}
