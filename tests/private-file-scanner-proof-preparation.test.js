// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CANARY_CLEAN,
  CANARY_EICAR,
  CANARY_WARN_AGE_MS,
  CLAMD_PORT_RANGE,
  DISPOSABLE_PORT_RANGE,
  MAX_SIGNATURE_AGE_MS,
  PROOF_DIRECTORY_PREFIX,
  SCANNER_CLIENT_IDENTITIES,
  SCANNER_FIXTURE_FILES,
  SCANNER_PROOF_ENV_NAMES,
  SCANNER_STATUS_KEYS,
  SIGNATURE_DNS_NAME,
  SIGNATURE_PROOF_BUDGET_MS,
  assessCanaryScans,
  assessSignatureFiles,
  assessSignatureReply,
  canaryConfigurationFromDirectory,
  chooseClamdPort,
  dnsDailyVersion,
  isEligibleClamdPort,
  lookupSignatureDnsRecord,
  parseSignatureFileHeader,
  readSignatureHeadersFromContainer,
  scannerProofDirectoryPattern,
  scannerProofEnvironmentLines,
  scannerProofRoot,
  scannerStatusFromSupabaseStatus,
  signatureAgeNoticeLine,
  signatureStaleAfterMs,
  staleSignatureReason,
  writeScannerFixtures,
} from "../scripts/prepare-private-file-scanner-proof.mjs";

const workspace = mkdtempSync(join(tmpdir(), "scanner-proof-fixtures-"));

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("private upload scanner proof preparation", () => {
  it("anchors the fixture directory to the runner temp root the pipeline proof accepts", () => {
    expect(scannerProofRoot({})).toBe("/tmp");
    expect(scannerProofRoot({ RUNNER_TEMP: "relative/path" })).toBe("/tmp");
    expect(scannerProofRoot({ RUNNER_TEMP: "/runner/_temp" })).toBe("/runner/_temp");

    const pattern = scannerProofDirectoryPattern({ RUNNER_TEMP: "/runner/_temp" });
    expect(`/runner/_temp/${PROOF_DIRECTORY_PREFIX}0a1b2c`).toMatch(pattern);
    expect(`/tmp/${PROOF_DIRECTORY_PREFIX}0a1b2c`).not.toMatch(pattern);
    // Uppercase is what mkdtemp would produce; the proof pins a lowercase-hex
    // suffix so the directory name is checkable from the test side.
    expect(`/runner/_temp/${PROOF_DIRECTORY_PREFIX}0A1B2C`).not.toMatch(pattern);
    expect(`/runner/_temp/${PROOF_DIRECTORY_PREFIX}0a1b2c/nested`).not.toMatch(pattern);
    expect(`/tmp/${PROOF_DIRECTORY_PREFIX}f3a9`).toMatch(scannerProofDirectoryPattern({}));
  });

  it("writes exactly the seven PEM fixtures the two-surface mutual-TLS proof reads", () => {
    const written = writeScannerFixtures(workspace);
    expect(readdirSync(workspace).sort()).toEqual([...SCANNER_FIXTURE_FILES].sort());
    expect(written.map((path) => path.replace(`${workspace}/`, "")).sort())
      .toEqual([...SCANNER_FIXTURE_FILES].sort());
    for (const name of SCANNER_FIXTURE_FILES) {
      expect(readFileSync(join(workspace, name), "utf8")).toMatch(/^-----BEGIN /);
    }
    for (const name of ["client.key", "sample-client.key", "server.key"]) {
      expect(statSync(join(workspace, name)).mode & 0o077).toBe(0);
    }
    const verify = execFileSync("openssl", [
      "verify", "-CAfile", join(workspace, "ca.crt"),
      join(workspace, "server.crt"), join(workspace, "client.crt"), join(workspace, "sample-client.crt"),
    ], { encoding: "utf8" });
    expect(verify).toContain("server.crt: OK");
    expect(verify).toContain("client.crt: OK");
    expect(verify).toContain("sample-client.crt: OK");
    // Two DISTINCT client identities under one CA. The per-listener allowlist
    // is what makes revoking one surface leave the other untouched, so the two
    // SANs must never collide.
    expect(SCANNER_CLIENT_IDENTITIES.production).not.toBe(SCANNER_CLIENT_IDENTITIES.sample);
    for (const [role, identity] of [["client", SCANNER_CLIENT_IDENTITIES.production], ["sample-client", SCANNER_CLIENT_IDENTITIES.sample]]) {
      const text = execFileSync("openssl", [
        "x509", "-in", join(workspace, `${role}.crt`), "-noout", "-subject", "-ext", "subjectAltName",
      ], { encoding: "utf8" });
      expect(text).toContain(`DNS:${identity}`);
      expect(text.replace(/\s*=\s*/g, "=")).toContain(`CN=${identity}`);
    }
    const serverText = execFileSync("openssl", [
      "x509", "-in", join(workspace, "server.crt"), "-noout", "-subject", "-ext", "subjectAltName,extendedKeyUsage",
    ], { encoding: "utf8" });
    expect((serverText).replace(/\s*=\s*/g, "=")).toContain("CN=localhost");
    expect(serverText).toContain("DNS:localhost, IP Address:127.0.0.1");
    expect(serverText).toContain("TLS Web Server Authentication");
    const clientText = execFileSync("openssl", [
      "x509", "-in", join(workspace, "client.crt"), "-noout", "-ext", "extendedKeyUsage",
    ], { encoding: "utf8" });
    expect(clientText).toContain("TLS Web Client Authentication");
    // The signing key must not survive into the fixture directory the proof
    // mounts; nothing may mint another certificate this proxy would trust.
    expect(readdirSync(workspace)).not.toContain("ca.key");
  });

  it("keeps only the three disposable status values and pairs the API and database ports", () => {
    const status = {
      API_URL: "http://127.0.0.1:55671",
      ANON_KEY: "anon-key",
      SERVICE_ROLE_KEY: "service-role-key",
      JWT_SECRET: "must-not-be-copied",
      S3_PROTOCOL_ACCESS_KEY_SECRET: "must-not-be-copied",
    };
    const url = "postgresql://postgres:postgres@127.0.0.1:55672/postgres";
    const selected = scannerStatusFromSupabaseStatus(JSON.stringify(status), url);
    expect(Object.keys(selected).sort()).toEqual([...SCANNER_STATUS_KEYS].sort());
    expect(selected.ANON_KEY).toBe("anon-key");
    expect(() => scannerStatusFromSupabaseStatus({ ...status, ANON_KEY: "" }, url)).toThrow(/ANON_KEY/);
    expect(() => scannerStatusFromSupabaseStatus({ ...status, API_URL: "http://example.test:55671" }, url))
      .toThrow(/loopback/);
    expect(() => scannerStatusFromSupabaseStatus({ ...status, API_URL: "http://127.0.0.1:55670" }, url))
      .toThrow(/does not pair/);
  });

  it("keeps the scanner port clear of the disposable Supabase block", () => {
    expect(CLAMD_PORT_RANGE.min).toBeGreaterThan(DISPOSABLE_PORT_RANGE.max);
    expect(isEligibleClamdPort(CLAMD_PORT_RANGE.min)).toBe(true);
    expect(isEligibleClamdPort(CLAMD_PORT_RANGE.max)).toBe(true);
    for (const port of [22, 1024, DISPOSABLE_PORT_RANGE.min, DISPOSABLE_PORT_RANGE.max, 3310, 65536, 1.5, "60000"]) {
      expect(isEligibleClamdPort(port), String(port)).toBe(false);
    }
  });

  it("starts the scanner port search at a uniform offset and still walks the whole range", async () => {
    const span = CLAMD_PORT_RANGE.max - CLAMD_PORT_RANGE.min + 1;
    const spans = [];
    const tried = [];
    const port = await chooseClamdPort(async (candidate) => {
      tried.push(candidate);
      return candidate === CLAMD_PORT_RANGE.min + 1;
    }, (max) => {
      spans.push(max);
      return span - 1;
    });
    expect(spans).toEqual([span]);
    expect(tried).toEqual([CLAMD_PORT_RANGE.max, CLAMD_PORT_RANGE.min, CLAMD_PORT_RANGE.min + 1]);
    expect(port).toBe(CLAMD_PORT_RANGE.min + 1);

    const seen = new Set();
    await expect(chooseClamdPort(async (candidate) => {
      seen.add(candidate);
      return false;
    }, () => 0)).rejects.toThrow(/No free scanner port/);
    expect(seen.size).toBe(span);
  });

  it("exports exactly the four documented environment names", () => {
    expect(SCANNER_PROOF_ENV_NAMES).toEqual([
      "PRIVATE_FILE_PIPELINE_SCANNER_DIR",
      "PRIVATE_FILE_STORAGE_STATUS_FILE",
      "PRIVATE_FILE_PIPELINE_CLAMD_PORT",
      "PRIVATE_FILE_PIPELINE_ARTIFACT",
    ]);
    const entries = {
      PRIVATE_FILE_PIPELINE_ARTIFACT: "/runner/_temp/proof.json",
      PRIVATE_FILE_PIPELINE_CLAMD_PORT: "60123",
      PRIVATE_FILE_PIPELINE_SCANNER_DIR: "/runner/_temp/dir",
      PRIVATE_FILE_STORAGE_STATUS_FILE: "/runner/_temp/dir/supabase-status.json",
    };
    expect(scannerProofEnvironmentLines(entries)).toEqual([
      "PRIVATE_FILE_PIPELINE_SCANNER_DIR=/runner/_temp/dir",
      "PRIVATE_FILE_STORAGE_STATUS_FILE=/runner/_temp/dir/supabase-status.json",
      "PRIVATE_FILE_PIPELINE_CLAMD_PORT=60123",
      "PRIVATE_FILE_PIPELINE_ARTIFACT=/runner/_temp/proof.json",
    ]);
    const { PRIVATE_FILE_PIPELINE_ARTIFACT, ...missing } = entries;
    expect(() => scannerProofEnvironmentLines(missing)).toThrow(/exactly its four/);
    expect(() => scannerProofEnvironmentLines({ ...entries, EXTRA: "1" })).toThrow(/exactly its four/);
  });

  it("derives the canary configuration from the offline CA directory rather than a typed-in pin", () => {
    const config = canaryConfigurationFromDirectory(workspace, {
      host: "scanner.ops.example.invalid", port: "8443", identity: "client",
    });
    expect(config).toMatchObject({ host: "scanner.ops.example.invalid", port: 8443, engineMin: "1.5.4" });
    expect(config.ca).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(config.cert).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(config.key).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    // The pin is computed from server.crt in the same directory, so a probe
    // cannot pass against a value that has drifted away from the listener.
    expect(config.expectedSpki).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    const derived = execFileSync("sh", ["-c",
      `openssl x509 -in ${join(workspace, "server.crt")} -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl base64`,
    ], { encoding: "utf8" }).trim();
    expect(config.expectedSpki).toBe(derived);
  });

  it("passes the canary only when the engine DETECTS, admits a clean fixture and is fresh", () => {
    expect(CANARY_EICAR).toHaveLength(68);
    expect(CANARY_CLEAN.length).toBeGreaterThan(0);
    const now = Date.parse("2026-09-06T12:00:00Z");
    const identity = {
      engine: "ClamAV 1.5.4", signatureVersion: 28113,
      signatureDate: new Date(now - 6 * 60 * 60 * 1000).toISOString(),
      scannerSpki: "a".repeat(43) + "=",
    };
    const eicar = { ...identity, verdict: "blocked" };
    const clean = { ...identity, verdict: "clean" };
    expect(assessCanaryScans({ eicar, clean }, now))
      .toMatchObject({ ok: true, failures: [], engine: "ClamAV 1.5.4", signatureVersion: 28113 });

    // A scanner that answers but no longer detects is the failure this probe
    // exists for; "no verdict at all" must never read as a pass.
    expect(assessCanaryScans({ eicar: { ...eicar, verdict: "clean" }, clean }, now))
      .toMatchObject({ ok: false, failures: [expect.stringContaining("EICAR")] });
    expect(assessCanaryScans({ eicar, clean: { ...clean, verdict: "blocked" } }, now))
      .toMatchObject({ ok: false, failures: [expect.stringContaining("clean fixture")] });
    expect(assessCanaryScans({}, now).ok).toBe(false);

    // Two scans that saw different signature sets prove nothing about either.
    expect(assessCanaryScans({ eicar, clean: { ...clean, signatureVersion: 28114 } }, now))
      .toMatchObject({ ok: false, failures: [expect.stringContaining("different signature identities")] });

    // The API refuses at 48 hours; the canary refuses at 24 so the alert fires
    // while everything still works.
    expect(CANARY_WARN_AGE_MS).toBeLessThan(MAX_SIGNATURE_AGE_MS);
    const stale = new Date(now - (CANARY_WARN_AGE_MS + 60_000)).toISOString();
    expect(assessCanaryScans({ eicar: { ...eicar, signatureDate: stale }, clean: { ...clean, signatureDate: stale } }, now))
      .toMatchObject({ ok: false, failures: [expect.stringContaining("warn threshold")] });
    expect(assessCanaryScans({ eicar: { ...eicar, signatureDate: "not a date" }, clean: { ...clean, signatureDate: "not a date" } }, now).ok)
      .toBe(false);
  });

  it("fails closed on stale, future-dated or unreadable signature replies", () => {
    const now = Date.parse("2026-09-05T12:00:00Z");
    const at = (offsetMs) => new Date(now - offsetMs).toUTCString().replace(
      /^(\w{3}), (\d{2}) (\w{3}) (\d{4}) (\d{2}:\d{2}:\d{2}) GMT$/,
      (_match, day, date, month, year, time) => `${day} ${month} ${date} ${time} ${year}`,
    );
    const fresh = assessSignatureReply(`ClamAV 1.5.4/28113/${at(24 * 60 * 60 * 1000)}`, now);
    expect(fresh).toMatchObject({ fresh: true, engine: "ClamAV 1.5.4", signatureVersion: 28113 });
    expect(fresh.ageMs).toBe(24 * 60 * 60 * 1000);

    // The adapter refuses at 48 hours. CI must refuse earlier by the proof's
    // own wall-clock budget, so a set that would expire mid-proof is caught
    // here with a readable reason rather than as an opaque scanner outage.
    expect(SIGNATURE_PROOF_BUDGET_MS).toBeGreaterThan(0);
    expect(SIGNATURE_PROOF_BUDGET_MS).toBeLessThan(MAX_SIGNATURE_AGE_MS);
    expect(assessSignatureReply(`ClamAV 1.5.4/28113/${at(MAX_SIGNATURE_AGE_MS - SIGNATURE_PROOF_BUDGET_MS + 1000)}`, now))
      .toMatchObject({ fresh: false, reason: "stale-signatures" });
    expect(assessSignatureReply(`ClamAV 1.5.4/28113/${at(-60 * 60 * 1000)}`, now))
      .toMatchObject({ fresh: false, reason: "signatures-dated-in-the-future" });
    for (const reply of [null, "", "PONG", "ClamAV 1.5.4/28113", `ClamAV 1.5.4/0/${at(0)}`, `1.5.4/28113/${at(0)}`]) {
      expect(assessSignatureReply(reply, now), String(reply))
        .toMatchObject({ fresh: false, reason: "unreadable-version-reply" });
    }
  });

  describe("signature age from the signature files", () => {
    const HOUR = 60 * 60 * 1000;
    const now = Date.parse("2026-11-05T12:00:00Z");
    // A daily.cvd/daily.cld header is 512 bytes, space padded: the build time is
    // the epoch-second `stime` in the ninth field.
    const header = (version, builtAtMs) => Buffer.from(
      `ClamAV-VDB:03 Nov 2026 06-27 +0000:${version}:2060000:90:${"0".repeat(32)}:fixture-signature:fixture-builder:${Math.floor(builtAtMs / 1000)}`
        .padEnd(512, " "),
    );

    it("reads the build time and version from the header, not from any reply", () => {
      expect(parseSignatureFileHeader(header(28173, Date.parse("2026-11-03T06:27:52Z"))))
        .toEqual({ signatureVersion: 28173, builtAtMs: Date.parse("2026-11-03T06:27:52Z") });
      for (const bad of [null, "", "PONG", "ClamAV-VDB:x:0:1:2:3:4:5:6", header(28173, 0), "ClamAV-VDB:d:abc:1:2:3:4:5:1793773672"]) {
        expect(parseSignatureFileHeader(bad), String(bad)).toBeNull();
      }
    });

    it("raises the notice from 36 h and the stale verdict past 47.5 h", () => {
      const at = (ageMs) => assessSignatureFiles([header(28174, now - ageMs)], now);
      expect(at(35.9 * HOUR)).toMatchObject({ readable: true, notice: false, stale: false, ageMs: 35.9 * HOUR });
      expect(at(36 * HOUR)).toMatchObject({ notice: true, stale: false });
      // 47.5 h is the cutoff itself (48 h less the 30 minute budget): still usable, one second later is not.
      expect(at(47.5 * HOUR)).toMatchObject({ notice: true, stale: false });
      expect(at(47.5 * HOUR + 1000)).toMatchObject({ notice: true, stale: true });
      expect(MAX_SIGNATURE_AGE_MS).toBe(48 * HOUR);
      expect(signatureStaleAfterMs()).toBe(47.5 * HOUR);
    });

    it("takes the newest of daily.cld and daily.cvd and refuses unreadable or future-dated files", () => {
      const newest = assessSignatureFiles([header(28100, now - 70 * HOUR), header(28174, now - 2 * HOUR)], now);
      expect(newest).toMatchObject({ readable: true, signatureVersion: 28174, ageMs: 2 * HOUR });
      expect(assessSignatureFiles([], now)).toEqual({ readable: false, reason: "unreadable-signature-files" });
      expect(assessSignatureFiles([header(28174, now + HOUR)], now)).toEqual({ readable: false, reason: "signatures-dated-in-the-future" });
    });

    it("words the notice with the age and the cutoff, annotated for GitHub when asked", () => {
      const line = signatureAgeNoticeLine({ signatureVersion: 28173, ageMs: 40.25 * HOUR });
      expect(line).toBe(
        "NOTICE: ClamAV signature 28173 is 40.25h old, past the 36.00h notice line; it is refused at 47.50h, so a skipped upstream publish now fails the scanner proof.",
      );
      expect(signatureAgeNoticeLine({ signatureVersion: 28173, ageMs: 40.25 * HOUR }, { annotate: true }))
        .toMatch(/^::notice title=ClamAV signatures are ageing::ClamAV signature 28173 is 40\.25h old/);
    });

    it("reads headers from the container publishing the scanner port, and degrades to nothing", () => {
      const calls = [];
      const run = (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === "ps") return "clamd-proof-1-1-db\n";
        if (args.at(-1).endsWith("daily.cld")) throw new Error("No such file");
        return header(28173, now - 3 * HOUR).toString("latin1");
      };
      const headers = readSignatureHeadersFromContainer(60123, { run });
      expect(headers).toHaveLength(1);
      expect(assessSignatureFiles(headers, now)).toMatchObject({ signatureVersion: 28173, ageMs: 3 * HOUR });
      expect(calls[0]).toEqual(["docker", "ps", "--filter", "publish=60123", "--format", "{{.Names}}"]);
      expect(calls[2]).toEqual(["docker", "exec", "clamd-proof-1-1-db", "head", "-c", "512", "/var/lib/clamav/daily.cvd"]);
      expect(readSignatureHeadersFromContainer(60123, { run: () => { throw new Error("docker missing"); } })).toEqual([]);
      expect(readSignatureHeadersFromContainer(60123, { run: () => "\n" })).toEqual([]);
    });

    it("runs the --signature-age monitor over a signature directory without a network", () => {
      const directory = mkdtempSync(join(workspace, "signature-age-"));
      const run = () => execFileSync("node", ["scripts/prepare-private-file-scanner-proof.mjs", "--signature-age", "--directory", directory], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      const write = (ageMs) => writeFileSync(join(directory, "daily.cld"), header(28174, Date.now() - ageMs));
      write(2 * HOUR);
      expect(run()).toMatch(/^Signature files: daily 28174 built .+, 2\.0\dh old\.\n$/);
      write(37 * HOUR);
      expect(run()).toMatch(/\nNOTICE: ClamAV signature 28174 is 37\.0\dh old/);
      write(48 * HOUR);
      expect(() => run()).toThrow(/past the 47\.50h cutoff/);
    });
  });

  describe("stale-signatures failure text", () => {
    const reply = "ClamAV 1.5.4/28173/Tue Nov  3 06:27:52 2026";
    const assessment = assessSignatureReply(reply, Date.parse("2026-11-05T06:02:52Z"));

    it("names the measured age, the cutoff, the loaded signature and the DNS value for an upstream gap", () => {
      expect(assessment).toMatchObject({ fresh: false, reason: "stale-signatures" });
      const text = staleSignatureReason({ reply, assessment, dnsRecord: "1.4.6:63:28173:1793890800:1:90:49192:339" });
      expect(text).toBe(
        "stale-signatures: ClamAV 1.5.4 signature 28173 is 47.58h old, past the 47.50h cutoff (48.00h scanner rule less the 30 minute proof budget); "
        + 'current.cvd.clamav.net TXT "1.4.6:63:28173:1793890800:1:90:49192:339"; '
        + "upstream advertises no newer set, so this is an upstream gap, not a failure on our side "
        + "(ClamAV 1.5.4/28173/Tue Nov  3 06:27:52 2026)",
      );
    });

    it("tells our own failed update from an upstream gap, and survives an unreadable record", () => {
      const reason = (dnsRecord) => staleSignatureReason({ reply, assessment, dnsRecord });
      expect(reason("1.4.6:63:28174:1793890800:1:90:49192:339")).toContain("our update did not fetch it");
      expect(reason("1.4.6:63:28100:1793890800:1:90:49192:339")).toContain("DNS record is itself behind");
      expect(reason("garbage")).toContain("upstream state unknown");
      expect(reason(null)).toContain("current.cvd.clamav.net TXT could not be read; upstream state unknown");
      expect(dnsDailyVersion("1.4.6:63:28174:1793890800:1:90:49192:339")).toBe(28174);
      expect(dnsDailyVersion(null)).toBeNull();
    });

    it("reads the TXT value through an injected resolver and returns null when it fails", async () => {
      const seen = [];
      const resolver = { resolveTxt: async (name) => { seen.push(name); return [["1.4.6:63:28174:", "1793890800:1:90:49192:339"]]; } };
      await expect(lookupSignatureDnsRecord({ resolver })).resolves.toBe("1.4.6:63:28174:1793890800:1:90:49192:339");
      expect(seen).toEqual([SIGNATURE_DNS_NAME]);
      await expect(lookupSignatureDnsRecord({ resolver: { resolveTxt: async () => { throw new Error("ESERVFAIL"); } } })).resolves.toBeNull();
      await expect(lookupSignatureDnsRecord({ resolver: { resolveTxt: async () => [] } })).resolves.toBeNull();
    });
  });
});
