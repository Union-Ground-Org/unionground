import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrations = join(root, "supabase", "migrations");
const files = readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort();

function versionFor(marker) {
  const name = files.find((file) => readFileSync(join(migrations, file), "utf8").includes(marker));
  if (!name) throw new Error(`migration marker not found: ${marker}`);
  return { name, version: Number(name.slice(0, 14)) };
}

describe("Union Ground migration order", () => {
  it("runs lifecycle, canonical sources, recognition, intake, and reset epochs after final Main MFA", () => {
    const lifecycle = versionFor("Union Ground lifecycle spine");
    const canonical = versionFor("Canonical, consent-bound sources");
    const recognition = versionFor("Retire the legacy points economy");
    const intake = versionFor("Public organizing-intake boundary");
    const resetEpoch = versionFor("admin-assisted TOTP reset must invalidate access tokens immediately");

    expect(lifecycle.version).toBeGreaterThan(20260724034000);
    expect(canonical.version).toBeGreaterThan(lifecycle.version);
    expect(recognition.version).toBeGreaterThan(canonical.version);
    expect(intake.version).toBeGreaterThan(recognition.version);
    expect(resetEpoch.version).toBeGreaterThan(intake.version);
    expect(new Set([
      lifecycle.version,
      canonical.version,
      recognition.version,
      intake.version,
      resetEpoch.version,
    ]).size).toBe(5);
    expect(files).not.toContain("20260723230000_unionground_union_lifecycle.sql");
    expect(files).not.toContain("20260723231000_unionground_safe_recognition.sql");
  });
});
