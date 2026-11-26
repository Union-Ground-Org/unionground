#!/usr/bin/env node
// CycloneDX 1.6 software bill of materials for every shipped deliverable.
//
//   node scripts/generate-sbom.mjs --out <dir> [--source-sha <sha>]
//   node scripts/generate-sbom.mjs --verify <dir> [--source-sha <sha>]
//   node scripts/generate-sbom.mjs --check
//
// One document per target named by `config/security-scanner-policy.json`: the
// web application and the Expo application. Only production components are
// listed, because the SBOM answers "what did we ship", not "what did we build
// with".
//
// The document is deterministic. It carries no wall-clock timestamp and no
// random serial number, so `--verify` can regenerate it and compare bytes:
// a retained SBOM either matches the source it claims, or the gate fails. Both
// the exact source commit and each lockfile digest are recorded inside the
// document, so an artifact can never be re-attributed to a different revision.
//
// Every failure is fatal. A missing lockfile, an unexpected lockfile version, a
// component without an integrity hash, or a duplicated component reference
// fails the build rather than producing a partial inventory. The one component
// that carries no hash is a package whose source lives in this repository (a
// lockfile entry outside node_modules that a node_modules link points at, such
// as apps/mobile/vendor/micromatch-picomatch): its bytes are the recorded
// source commit's.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(HERE, "..");
export const SPEC_VERSION = "1.6";
const SUPPORTED_LOCKFILE_VERSIONS = Object.freeze([3]);

function fail(message) {
  throw new Error(`SBOM_FAIL: ${message}`);
}

function requireFlagValue(args, index, flag) {
  const value = args[index + 1];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    fail(`${flag} requires a value`);
  }
  return value;
}

/**
 * Read a value-taking flag from `args`. Every occurrence must carry a value, so
 * a composed argument list cannot smuggle a bare `--out` past an earlier
 * well-formed one; the first occurrence supplies the value that is used.
 */
function collectFlagValue(args, flag) {
  const indices = args.reduce((found, token, index) => {
    if (token === flag) found.push(index);
    return found;
  }, []);
  const values = indices.map((index) => requireFlagValue(args, index, flag));
  return { present: indices.length > 0, value: values.length > 0 ? values[0] : null };
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Build a syntactically valid, deterministic UUID from a digest. */
export function deterministicUuid(seed) {
  const digest = sha256Hex(seed);
  const bytes = digest.slice(0, 32).split("");
  bytes[12] = "4"; // version 4 shape
  const variant = "89ab"[parseInt(digest[16], 16) % 4];
  bytes[16] = variant;
  const hex = bytes.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const INTEGRITY_ALGORITHMS = Object.freeze({
  sha512: { alg: "SHA-512", bytes: 64 },
  sha384: { alg: "SHA-384", bytes: 48 },
  sha256: { alg: "SHA-256", bytes: 32 },
  sha1: { alg: "SHA-1", bytes: 20 },
});

export function integrityToHash(integrity) {
  if (typeof integrity !== "string" || !integrity.trim()) return null;
  let strongest = null;
  for (const token of integrity.trim().split(/\s+/u)) {
    const match = /^([a-z0-9]+)-([A-Za-z0-9+/_-]+={0,2})(?:\?[!-~]*)?$/u.exec(token);
    if (!match || !Object.hasOwn(INTEGRITY_ALGORITHMS, match[1])) return null;
    const definition = INTEGRITY_ALGORITHMS[match[1]];
    const encoded = match[2].replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Buffer.from(encoded, "base64");
    const canonical = bytes.toString("base64");
    // Buffer's decoder silently ignores malformed input and unused pad bits.
    // Accept the padded or unpadded encoding only when it round-trips exactly.
    if (bytes.length !== definition.bytes
      || (encoded !== canonical && encoded !== canonical.replace(/=+$/u, ""))) return null;
    if (!strongest || definition.bytes > strongest.bytes) {
      strongest = { ...definition, content: bytes.toString("hex") };
    }
  }
  return { alg: strongest.alg, content: strongest.content };
}

export function purlFor(name, version) {
  if (name.startsWith("@")) {
    const [scope, bare] = name.split("/", 2);
    return `pkg:npm/${encodeURIComponent(scope)}/${bare}@${version}`;
  }
  return `pkg:npm/${name}@${version}`;
}

function packageNameFromLockKey(key) {
  const marker = "node_modules/";
  const index = key.lastIndexOf(marker);
  if (index < 0) return null;
  return key.slice(index + marker.length);
}

// A package vendored in this repository: listed with its lockfile path, and
// vouched for by the source commit the document records, not by a hash.
function inRepositoryComponent(key, entry, lockfilePath) {
  const version = entry?.version;
  if (typeof version !== "string" || version.length === 0) fail(`${lockfilePath} entry ${key} has no version`);
  const name = entry.name || key.slice(key.lastIndexOf("/") + 1);
  const purl = `pkg:generic/${encodeURIComponent(name)}@${version}`;
  return {
    type: "library",
    "bom-ref": purl,
    name,
    version,
    purl,
    scope: "required",
    ...(entry.license ? { licenses: [{ license: { id: String(entry.license) } }] } : {}),
    properties: [
      { name: "cdx:npm:package:path", value: key },
      { name: "unionground:source", value: "repository" },
    ],
  };
}

function gitSource(resolved, name) {
  if (!/^git(?:\+|:\/\/)/.test(resolved)) return null;
  const source = new URL(resolved.replace(/^git\+/, ""));
  const commit = source.hash.slice(1);
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    fail(`git dependency ${name} has no exact resolved commit`);
  }
  const repository = source.pathname.replace(/^\//, "").replace(/\.git$/, "");
  const vcs = { type: "vcs", url: resolved };
  if (source.hostname === "github.com" && /^[^/]+\/[^/]+$/.test(repository)) {
    return {
      purl: `pkg:github/${repository.toLowerCase()}@${commit}`,
      externalReferences: [
        { type: "distribution", url: `https://github.com/${repository}/archive/${commit}.tar.gz` },
        vcs,
      ],
    };
  }
  return {
    purl: `pkg:generic/${encodeURIComponent(name)}@${commit}?vcs_url=${encodeURIComponent(resolved)}`,
    externalReferences: [vcs],
  };
}

/**
 * Convert one npm lockfile into the production component list.
 * @param {{ lockfile: object, lockfilePath: string }} input
 */
export function componentsFromLockfile({ lockfile, lockfilePath }) {
  if (!lockfile || typeof lockfile !== "object") fail(`${lockfilePath} is not an object`);
  if (!SUPPORTED_LOCKFILE_VERSIONS.includes(lockfile.lockfileVersion)) {
    fail(
      `${lockfilePath} has lockfileVersion ${lockfile.lockfileVersion}; `
        + `only ${SUPPORTED_LOCKFILE_VERSIONS.join(", ")} is understood, so the inventory would be incomplete`,
    );
  }
  const packages = lockfile.packages;
  if (!packages || typeof packages !== "object") fail(`${lockfilePath} has no packages map`);

  const components = new Map();
  const linkedInRepository = new Set(Object.values(packages)
    .filter((entry) => entry?.link === true && typeof entry.resolved === "string")
    .map((entry) => entry.resolved));
  for (const [key, entry] of Object.entries(packages)) {
    if (key === "") continue;
    if (entry?.dev === true) continue;
    if (entry?.link === true) continue;
    const installedName = packageNameFromLockKey(key);
    if (!installedName) {
      if (!linkedInRepository.has(key)) fail(`${lockfilePath} entry ${key} is not a node_modules path`);
      const component = inRepositoryComponent(key, entry, lockfilePath);
      if (components.has(component.purl)) fail(`${lockfilePath} lists ${component.purl} twice`);
      components.set(component.purl, component);
      continue;
    }
    const version = entry?.version;
    if (typeof version !== "string" || version.length === 0) {
      fail(`${lockfilePath} entry ${key} has no version`);
    }
    const hash = integrityToHash(entry?.integrity);
    if (!hash) {
      fail(`${lockfilePath} entry ${key} has no usable integrity hash; the inventory cannot vouch for it`);
    }
    if (typeof entry?.resolved !== "string" || entry.resolved.length === 0) {
      fail(`${lockfilePath} entry ${key} has no resolved location`);
    }
    const git = gitSource(entry.resolved, entry.name || installedName);
    const name = git ? entry.name || installedName : installedName;
    const purl = git?.purl ?? purlFor(name, version);
    const existing = components.get(purl);
    if (existing) {
      if (existing.hashes[0].content !== hash.content) {
        fail(`${lockfilePath} resolves ${purl} to two different artifacts`);
      }
      continue;
    }
    components.set(purl, {
      type: "library",
      "bom-ref": purl,
      name,
      version,
      purl,
      scope: "required",
      hashes: [hash],
      ...(entry.license ? { licenses: [{ license: { id: String(entry.license) } }] } : {}),
      externalReferences: git?.externalReferences ?? [{ type: "distribution", url: entry.resolved }],
      ...(git ? { properties: [{ name: "cdx:npm:package:path", value: key }] } : {}),
    });
  }
  return [...components.values()].sort((left, right) =>
    left["bom-ref"] < right["bom-ref"] ? -1 : left["bom-ref"] > right["bom-ref"] ? 1 : 0);
}

export function buildBom({ target, manifest, lockfile, lockfileBytes, sourceSha }) {
  const components = componentsFromLockfile({ lockfile, lockfilePath: target.lockfile });
  const lockfileDigest = sha256Hex(lockfileBytes);
  const serialSeed = `${target.name}:${sourceSha}:${lockfileDigest}`;
  return {
    bomFormat: "CycloneDX",
    specVersion: SPEC_VERSION,
    serialNumber: `urn:uuid:${deterministicUuid(serialSeed)}`,
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": `pkg:generic/${target.name}@${sourceSha}`,
        name: target.name,
        version: manifest.version ?? "0.0.0",
      },
      properties: [
        { name: "unionground:source_sha", value: sourceSha },
        { name: "unionground:lockfile", value: target.lockfile },
        { name: "unionground:lockfile_sha256", value: lockfileDigest },
        { name: "unionground:scope", value: "production" },
        { name: "unionground:component_count", value: String(components.length) },
      ],
    },
    components,
  };
}

function resolveSourceSha(explicit) {
  if (explicit) {
    if (!/^[0-9a-f]{40}$/.test(explicit)) fail("--source-sha must be an exact 40-character commit SHA");
    return explicit;
  }
  const fromEnvironment = process.env.CI_HEAD_SHA ?? process.env.GITHUB_SHA;
  if (fromEnvironment && /^[0-9a-f]{40}$/.test(fromEnvironment)) return fromEnvironment;
  try {
    return execFileSync("git", ["-C", REPOSITORY_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch (error) {
    fail(`the exact source commit could not be resolved: ${error.message}`);
    return "";
  }
}

export function loadPolicyTargets(root = REPOSITORY_ROOT) {
  const policy = JSON.parse(readFileSync(join(root, "config/security-scanner-policy.json"), "utf8"));
  const targets = policy?.sbom?.targets;
  if (!Array.isArray(targets) || targets.length === 0) fail("the SBOM policy names no targets");
  return targets;
}

export function generateAll({ root = REPOSITORY_ROOT, sourceSha }) {
  return loadPolicyTargets(root).map((target) => {
    const lockfileBytes = readFileSync(join(root, target.lockfile));
    const manifest = JSON.parse(readFileSync(join(root, target.manifest), "utf8"));
    const lockfile = JSON.parse(lockfileBytes.toString("utf8"));
    return {
      target,
      fileName: `${target.name}.cdx.json`,
      document: buildBom({ target, manifest, lockfile, lockfileBytes, sourceSha }),
    };
  });
}

function serialize(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function main() {
  const args = process.argv.slice(2);
  const sha = collectFlagValue(args, "--source-sha");
  const out = collectFlagValue(args, "--out");
  const verify = collectFlagValue(args, "--verify");
  const sourceSha = resolveSourceSha(sha.value);

  const check = args.includes("--check");

  if (!out.present && !verify.present && !check) {
    console.error(
      "usage: generate-sbom.mjs --out <dir> | --verify <dir> | --check [--source-sha <sha>]",
    );
    process.exitCode = 1;
    return;
  }

  const generated = generateAll({ sourceSha });

  if (check) {
    // Required-CI form: generate every inventory, prove it is reproducible, and
    // fail closed on an empty or malformed one. It writes nothing, so it can
    // run inside `npm run check` without leaving an artifact behind. Retention
    // is the security workflow's job.
    const repeated = generateAll({ sourceSha });
    for (const [index, entry] of generated.entries()) {
      if (entry.document.components.length === 0) {
        console.error(`SBOM_FAIL: ${entry.fileName} lists no production component`);
        process.exitCode = 1;
        return;
      }
      if (serialize(entry.document) !== serialize(repeated[index].document)) {
        console.error(`SBOM_FAIL: ${entry.fileName} is not reproducible from the same source`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `${entry.fileName}: ${entry.document.components.length} production components at ${sourceSha}`,
      );
    }
    console.log(`SBOM check passed for ${generated.length} deliverable(s).`);
    return;
  }

  if (verify.present) {
    const directory = resolve(verify.value);
    for (const { fileName, document } of generated) {
      const path = join(directory, fileName);
      let retained;
      try {
        retained = readFileSync(path, "utf8");
      } catch (error) {
        console.error(`SBOM_FAIL: retained ${fileName} is unreadable: ${error.message}`);
        process.exitCode = 1;
        return;
      }
      if (retained !== serialize(document)) {
        console.error(
          `SBOM_FAIL: retained ${fileName} does not match the inventory regenerated from ${sourceSha}`,
        );
        process.exitCode = 1;
        return;
      }
    }
    console.log(`SBOM verified for ${sourceSha}: ${generated.map((entry) => entry.fileName).join(", ")}`);
    return;
  }

  const directory = resolve(out.value);
  mkdirSync(directory, { recursive: true });
  for (const { fileName, document } of generated) {
    writeFileSync(join(directory, fileName), serialize(document));
    console.log(`${fileName}: ${document.components.length} production components at ${sourceSha}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
