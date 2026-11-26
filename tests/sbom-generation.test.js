// @vitest-environment node

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  SPEC_VERSION,
  buildBom,
  componentsFromLockfile,
  deterministicUuid,
  generateAll,
  integrityToHash,
  loadPolicyTargets,
  purlFor,
} from "../scripts/generate-sbom.mjs";

const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";
const FIXTURE_ARTIFACT = "fixture artifact";
const integrityFor = (algorithm = "sha512", artifact = FIXTURE_ARTIFACT) =>
  `${algorithm}-${createHash(algorithm).update(artifact).digest("base64")}`;

function lockfile(overrides = {}) {
  return {
    name: "fixture",
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture", version: "1.0.0" },
      "node_modules/shipped": {
        version: "2.0.0",
        resolved: "https://registry.npmjs.org/shipped/-/shipped-2.0.0.tgz",
        integrity: integrityFor(),
        license: "MIT",
      },
      "node_modules/build-only": {
        version: "3.0.0",
        dev: true,
        resolved: "https://registry.npmjs.org/build-only/-/build-only-3.0.0.tgz",
        integrity: integrityFor("sha512", "build fixture"),
      },
      ...overrides,
    },
  };
}

describe("CycloneDX inventory", () => {
  it("refuses the retained three-byte SHA-512 reproduction", () => {
    const fixture = lockfile();
    fixture.packages["node_modules/shipped"].integrity = "sha512-YWJj";
    expect(() => componentsFromLockfile({
      lockfile: fixture,
      lockfilePath: "package-lock.json",
    })).toThrow(/no usable integrity hash/);
  });

  it("lists production components and omits build-only ones", () => {
    const components = componentsFromLockfile({
      lockfile: lockfile(),
      lockfilePath: "package-lock.json",
    });
    expect(components.map((component) => component.name)).toEqual(["shipped"]);
    expect(components[0].scope).toBe("required");
    expect(components[0].hashes[0].alg).toBe("SHA-512");
    expect(components[0].purl).toBe("pkg:npm/shipped@2.0.0");
  });

  it.each(["git+ssh://git@", "git+https://", "git://"])(
    "identifies an aliased GitHub dependency resolved via %s",
    (protocol) => {
      const path = "node_modules/metro-file-map/node_modules/micromatch";
      const resolved = `${protocol}github.com/example-org/micromatch-fixture.git#${SOURCE_SHA}`;
      const purl = `pkg:github/example-org/micromatch-fixture@${SOURCE_SHA}`;
      const components = componentsFromLockfile({
        lockfile: lockfile({
          [path]: {
            name: "micromatch-picomatch",
            version: "1.0.0",
            resolved,
            integrity: integrityFor(),
          },
        }),
        lockfilePath: "package-lock.json",
      });
      expect(components.find((component) => component.name === "micromatch-picomatch")).toEqual({
        type: "library",
        "bom-ref": purl,
        name: "micromatch-picomatch",
        version: "1.0.0",
        purl,
        scope: "required",
        hashes: [{ alg: "SHA-512", content: createHash("sha512").update(FIXTURE_ARTIFACT).digest("hex") }],
        externalReferences: [
          { type: "distribution", url: `https://github.com/example-org/micromatch-fixture/archive/${SOURCE_SHA}.tar.gz` },
          { type: "vcs", url: resolved },
        ],
        properties: [{ name: "cdx:npm:package:path", value: path }],
      });
      expect(components.some((component) => component.purl === "pkg:npm/micromatch@1.0.0")).toBe(false);
    },
  );

  it("lists a package vendored in the repository, which a node_modules link points at", () => {
    const components = componentsFromLockfile({
      lockfile: lockfile({
        "node_modules/micromatch": { resolved: "vendor/micromatch-picomatch", link: true },
        "vendor/micromatch-picomatch": { version: "1.0.0", license: "MIT", dependencies: { picomatch: "^2.3.1" } },
      }),
      lockfilePath: "apps/mobile/package-lock.json",
    });
    expect(components.find((component) => component.name === "micromatch-picomatch")).toEqual({
      type: "library",
      "bom-ref": "pkg:generic/micromatch-picomatch@1.0.0",
      name: "micromatch-picomatch",
      version: "1.0.0",
      purl: "pkg:generic/micromatch-picomatch@1.0.0",
      scope: "required",
      licenses: [{ license: { id: "MIT" } }],
      properties: [
        { name: "cdx:npm:package:path", value: "vendor/micromatch-picomatch" },
        { name: "unionground:source", value: "repository" },
      ],
    });
  });

  it("still refuses an entry outside node_modules that no link points at", () => {
    expect(() => componentsFromLockfile({
      lockfile: lockfile({ "vendor/stray": { version: "1.0.0" } }),
      lockfilePath: "apps/mobile/package-lock.json",
    })).toThrow("SBOM_FAIL: apps/mobile/package-lock.json entry vendor/stray is not a node_modules path");
  });

  it("leaves registry components unchanged even when their entries name an alias", () => {
    const fixture = lockfile();
    const baseline = componentsFromLockfile({ lockfile: fixture, lockfilePath: "package-lock.json" });
    fixture.packages["node_modules/shipped"].name = "alias-name";
    expect(componentsFromLockfile({ lockfile: fixture, lockfilePath: "package-lock.json" })).toEqual(baseline);
  });

  it("records non-GitHub git origins without assigning a registry identity", () => {
    const resolved = `git+https://code.example.test/team/shim.git#${SOURCE_SHA}`;
    const components = componentsFromLockfile({
      lockfile: lockfile({
        "node_modules/alias": {
          name: "actual-shim",
          version: "2.3.4",
          resolved,
          integrity: integrityFor(),
        },
      }),
      lockfilePath: "package-lock.json",
    });
    expect(components.find((component) => component.name === "actual-shim")).toMatchObject({
      version: "2.3.4",
      purl: `pkg:generic/actual-shim@${SOURCE_SHA}?vcs_url=${encodeURIComponent(resolved)}`,
      externalReferences: [{ type: "vcs", url: resolved }],
      properties: [{ name: "cdx:npm:package:path", value: "node_modules/alias" }],
    });
  });

  it("keeps distinct git commits separate even when the package version matches", () => {
    const commits = [SOURCE_SHA, "89abcdef0123456789abcdef0123456789abcdef"];
    const fixture = lockfile(Object.fromEntries(commits.map((commit, index) => [
      `node_modules/host-${index}/node_modules/shim`,
      {
        version: "1.0.0",
        resolved: `git+https://github.com/example/shim.git#${commit}`,
        integrity: integrityFor(),
      },
    ])));
    const components = componentsFromLockfile({ lockfile: fixture, lockfilePath: "package-lock.json" });
    expect(components.filter((component) => component.name === "shim").map((component) => component.purl))
      .toEqual(commits.map((commit) => `pkg:github/example/shim@${commit}`));
  });

  it.each(["", "#main", "#1234567"])("refuses a git origin without an exact commit: %s", (fragment) => {
    expect(() => componentsFromLockfile({
      lockfile: lockfile({
        "node_modules/shim": {
          version: "1.0.0",
          resolved: `git+https://github.com/example/shim.git${fragment}`,
          integrity: integrityFor(),
        },
      }),
      lockfilePath: "package-lock.json",
    })).toThrow(/no exact resolved commit/);
  });

  it.each([
    ["an unsupported lockfile version", { lockfileVersion: 2 }, /lockfileVersion 2/],
  ])("fails closed on %s", (_label, patch, pattern) => {
    expect(() => componentsFromLockfile({
      lockfile: { ...lockfile(), ...patch },
      lockfilePath: "package-lock.json",
    })).toThrow(pattern);
  });

  it("fails closed on a component with no integrity hash", () => {
    expect(() => componentsFromLockfile({
      lockfile: lockfile({
        "node_modules/unverifiable": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/unverifiable/-/unverifiable-1.0.0.tgz",
        },
      }),
      lockfilePath: "package-lock.json",
    })).toThrow(/no usable integrity hash/);
  });

  it("fails closed on a component with no resolved location", () => {
    expect(() => componentsFromLockfile({
      lockfile: lockfile({
        "node_modules/floating": {
          version: "1.0.0",
          integrity: integrityFor(),
        },
      }),
      lockfilePath: "package-lock.json",
    })).toThrow(/no resolved location/);
  });

  it("fails closed when one reference resolves to two artifacts", () => {
    expect(() => componentsFromLockfile({
      lockfile: lockfile({
        "node_modules/host/node_modules/shipped": {
          version: "2.0.0",
          resolved: "https://registry.npmjs.org/shipped/-/shipped-2.0.0.tgz",
          integrity: integrityFor("sha512", "different artifact"),
        },
      }),
      lockfilePath: "package-lock.json",
    })).toThrow(/two different artifacts/);
  });

  it("encodes scoped package references", () => {
    expect(purlFor("@scope/name", "1.2.3")).toBe("pkg:npm/%40scope/name@1.2.3");
  });

  it.each([
    ["sha1", "SHA-1"],
    ["sha256", "SHA-256"],
    ["sha384", "SHA-384"],
    ["sha512", "SHA-512"],
  ])("maps valid %s integrity to its exact %s digest", (algorithm, alg) => {
    const expected = { alg, content: createHash(algorithm).update(FIXTURE_ARTIFACT).digest("hex") };
    expect(integrityToHash(integrityFor(algorithm))).toEqual(expected);
    expect(integrityToHash(integrityFor(algorithm).replace(/=+$/u, ""))).toEqual(expected);
  });

  it.each([
    ["sha1", 20], ["sha256", 32], ["sha384", 48], ["sha512", 64],
  ].flatMap(([algorithm, length]) => [length - 1, length + 1].map((size) => [algorithm, size])))(
    "rejects a %s digest containing %i bytes", (algorithm, length) => {
      const integrity = `${algorithm}-${Buffer.alloc(length, 7).toString("base64")}`;
      const fixture = lockfile();
      fixture.packages["node_modules/shipped"].integrity = integrity;
      expect(integrityToHash(integrity)).toBeNull();
      expect(() => componentsFromLockfile({ lockfile: fixture, lockfilePath: "package-lock.json" }))
        .toThrow(/no usable integrity hash/);
    },
  );

  it.each([
    `${integrityFor()}!!!!`,
    `${integrityFor()}=`,
    integrityFor().slice(0, -1),
    integrityFor().slice(0, -3),
    `${integrityFor().slice(0, 12)}!${integrityFor().slice(12)}`,
    `sha512-${Buffer.alloc(64).toString("base64").slice(0, -3)}B==`,
  ])("rejects malformed Base64 without silently repairing it: %s", (integrity) => {
    expect(integrityToHash(integrity)).toBeNull();
  });

  it("accepts Base64url digits and SRI options without treating them as digest bytes", () => {
    const encoded = Buffer.alloc(64, 255).toString("base64").replaceAll("/", "_");
    expect(integrityToHash(`sha512-${encoded}?fixture-option`))
      .toEqual({ alg: "SHA-512", content: "ff".repeat(64) });
  });

  it("selects the strongest complete digest in valid multi-hash metadata", () => {
    const integrity = `${integrityFor("sha256")} ${integrityFor()} ${integrityFor("sha384")}`;
    expect(integrityToHash(integrity)).toEqual({
      alg: "SHA-512", content: createHash("sha512").update(FIXTURE_ARTIFACT).digest("hex"),
    });
    expect(integrityToHash(`${integrity} sha512-YWJj`)).toBeNull();
  });

  it("rejects an unusable integrity string", () => {
    expect(integrityToHash(null)).toBeNull();
    expect(integrityToHash(" ")).toBeNull();
    expect(integrityToHash("md5-YWJj")).toBeNull();
    expect(integrityToHash("nonsense")).toBeNull();
  });
});

describe("inventory documents", () => {
  const document = buildBom({
    target: { name: "fixture-app", lockfile: "package-lock.json", manifest: "package.json" },
    manifest: { version: "1.2.3" },
    lockfile: lockfile(),
    lockfileBytes: Buffer.from("lockfile bytes"),
    sourceSha: SOURCE_SHA,
  });

  it("is a CycloneDX 1.6 document", () => {
    expect(document.bomFormat).toBe("CycloneDX");
    expect(document.specVersion).toBe(SPEC_VERSION);
    expect(document.serialNumber).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("binds the inventory to the exact source commit and lockfile bytes", () => {
    const properties = Object.fromEntries(
      document.metadata.properties.map((property) => [property.name, property.value]),
    );
    expect(properties["unionground:source_sha"]).toBe(SOURCE_SHA);
    expect(properties["unionground:scope"]).toBe("production");
    expect(properties["unionground:lockfile_sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(properties["unionground:component_count"]).toBe("1");
  });

  it("carries no wall-clock timestamp, so it can be verified byte for byte", () => {
    expect(JSON.stringify(document)).not.toContain("timestamp");
  });

  it("changes its serial number when the source commit changes", () => {
    const other = buildBom({
      target: { name: "fixture-app", lockfile: "package-lock.json", manifest: "package.json" },
      manifest: { version: "1.2.3" },
      lockfile: lockfile(),
      lockfileBytes: Buffer.from("lockfile bytes"),
      sourceSha: "89abcdef0123456789abcdef0123456789abcdef",
    });
    expect(other.serialNumber).not.toBe(document.serialNumber);
  });

  it("derives a syntactically valid uuid from any seed", () => {
    expect(deterministicUuid("a")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(deterministicUuid("a")).toBe(deterministicUuid("a"));
    expect(deterministicUuid("a")).not.toBe(deterministicUuid("b"));
  });
});

describe("repository inventory", () => {
  it("covers the web and mobile deliverables named by the reviewed policy", () => {
    const targets = loadPolicyTargets().map((target) => target.name);
    expect(targets).toContain("union-ground-web");
    expect(targets).toContain("union-ground-mobile");
  });

  it("regenerates identically for the same source commit", () => {
    const first = generateAll({ sourceSha: SOURCE_SHA });
    const second = generateAll({ sourceSha: SOURCE_SHA });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    for (const entry of first) {
      expect(entry.document.components.length).toBeGreaterThan(0);
      expect(entry.fileName).toMatch(/\.cdx\.json$/);
    }
  });

  it("lists no build-only dependency of the web tree", () => {
    const [web] = generateAll({ sourceSha: SOURCE_SHA });
    const names = new Set(web.document.components.map((component) => component.name));
    expect(names.has("react")).toBe(true);
    expect(names.has("vitest")).toBe(false);
    expect(names.has("eslint")).toBe(false);
  });
});

describe("required-CI check mode", () => {
  it("is wired into npm run check so the inventory gate is required today", () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    );
    expect(manifest.scripts["sbom:check"]).toBe("node scripts/generate-sbom.mjs --check");
    expect(manifest.scripts.check).toContain("npm run sbom:check");
  });

  it("passes for the repository and writes nothing", () => {
    const before = readdirSync(fileURLToPath(new URL("../", import.meta.url))).sort();
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../scripts/generate-sbom.mjs", import.meta.url)), "--check"],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("SBOM check passed for 2 deliverable(s).");
    expect(readdirSync(fileURLToPath(new URL("../", import.meta.url))).sort()).toEqual(before);
  });

  it("fails closed when a deliverable lists no production component", () => {
    expect(() => componentsFromLockfile({
      lockfile: { lockfileVersion: 3, packages: {} },
      lockfilePath: "package-lock.json",
    })).not.toThrow();
    // An empty component list is not an error at the parse layer, so the check
    // mode is what refuses it; assert the message the runner prints exists.
    const source = readFileSync(
      fileURLToPath(new URL("../scripts/generate-sbom.mjs", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("lists no production component");
    expect(source).toContain("is not reproducible from the same source");
  });
});

describe("CLI missing flag values", () => {
  const script = fileURLToPath(new URL("../scripts/generate-sbom.mjs", import.meta.url));
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const created = [];

  afterEach(() => {
    for (const directory of created.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function cdxNames(directory) {
    return readdirSync(directory).filter((name) => name.endsWith(".cdx.json"));
  }

  function run(argv) {
    const cwd = mkdtempSync(join(tmpdir(), "sbom-cli-"));
    created.push(cwd);
    const beforeRoot = cdxNames(repoRoot);
    const result = spawnSync(process.execPath, [script, ...argv], {
      encoding: "utf8",
      cwd,
    });
    return { result, cwd, beforeRoot };
  }

  it.each([
    [["--out"], "--out"],
    [["--verify"], "--verify"],
    [["--check", "--source-sha"], "--source-sha"],
    [["--out", "--source-sha", "abc"], "--out"],
    [["--source-sha", ""], "--source-sha"],
    [["--out", "sbom", "--out"], "--out"],
    [["--verify", "sbom", "--verify"], "--verify"],
    [["--check", "--source-sha", "0".repeat(40), "--source-sha"], "--source-sha"],
  ])("refuses %j without writing files", (argv, flag) => {
    const { result, cwd, beforeRoot } = run(argv);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("SBOM_FAIL:");
    expect(result.stderr).toContain(flag);
    expect(readdirSync(cwd)).toEqual([]);
    expect(cdxNames(repoRoot)).toEqual(beforeRoot);
  });

  it("still accepts --check without --source-sha so the env/git fallback stays intact", () => {
    const { result, cwd, beforeRoot } = run(["--check"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("SBOM check passed");
    expect(readdirSync(cwd)).toEqual([]);
    expect(cdxNames(repoRoot)).toEqual(beforeRoot);
  });
});
