import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260917140000_mi1_dues_oauth_callback_audit_metadata.sql",
  "utf8",
);
const previous = readFileSync(
  "supabase/migrations/20260903030000_cba_ingestion_completion.sql",
  "utf8",
);

function metadataKeys(source) {
  const definitions = [...source.matchAll(
    /add constraint organization_audit_events_metadata_keys check \(\s*metadata - array\[([\s\S]*?)\]\s*=\s*'\{\}'::jsonb/g,
  )];
  expect(definitions.length).toBeGreaterThan(0);
  return [...definitions.at(-1)[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

describe("Dues OAuth callback audit metadata migration", () => {
  it("admits only the existing finalizer and resume audit markers", () => {
    expect(sql).toContain("drop constraint organization_audit_events_metadata_keys");
    expect(sql).toContain("oauthStateFinalized");
    expect(sql).toContain("resumedRecordedExchange");
    expect(sql).toContain("requestedBy");
    expect(sql).not.toMatch(/(?:stripe|access|refresh)_token/i);
  });

  it("extends the previous key list exactly, dropping nothing", () => {
    const before = metadataKeys(previous);
    const after = metadataKeys(sql);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual(["oauthStateFinalized", "resumedRecordedExchange"]);
    expect(new Set(after).size).toBe(after.length);
  });
});
