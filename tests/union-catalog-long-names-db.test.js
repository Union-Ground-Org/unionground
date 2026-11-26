// @vitest-environment node
// REQ-UG-CATALOG-ORGANIZATION-NAMES-OVER-200-CHARACTERS-20261114 (#8743).
// A catalog organization name of up to 1,000 characters loads, verifies,
// activates and is found by search; a longer one, an empty one and one with
// a control character are still refused by the table. Every row is fictional
// and every write rolls back on the runner-owned database.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activateRelease, loadRelease, readRelease, verifyRelease } from "../scripts/load-union-catalog.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { exclusionList } from "./helpers/union-catalog-fixture.mjs";
import { writeBaseRelease } from "./helpers/union-catalog-research-fixture.mjs";
import { addAmericasSnapshot, exportKey } from "./helpers/union-catalog-americas-fixture.mjs";
import { LONG_NAMES, withLongNames } from "./helpers/union-catalog-long-names.mjs";

const live = process.env.RUN_UNION_CATALOG_DB_TESTS === "1" ? describe : describe.skip;
live("catalog organization names over 200 characters (#8743)", () => {
  let client, dir, release;
  const exclusions = exclusionList();
  async function anon(query, values = []) {
    await client.query("savepoint long_names");
    try {
      await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "anon" })]);
      await client.query("set local role anon");
      return (await client.query(query, values)).rows[0]?.value;
    } finally {
      await client.query("rollback to savepoint long_names");
      await client.query("release savepoint long_names");
    }
  }
  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    dir = mkdtempSync(join(process.env.CI_DB_TEMP_ROOT || tmpdir(), "catalog-long-names-db-"));
    release = readRelease(writeBaseRelease(dir, { label: "20261114-81", mutate: (f) => withLongNames(addAmericasSnapshot(f)) }).dir);
  });
  afterAll(async () => {
    if (client) {
      await client.query("rollback");
      await client.end();
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("loads, verifies and activates names of 622 and 1,000 characters unshortened", async () => {
    await loadRelease({ client, ...release, exclusions });
    expect((await verifyRelease({ client, ...release, exclusions })).problems).toEqual([]);
    const diff = await activateRelease({ client, label: release.manifest.label });
    expect(diff).toMatchObject({ organizationsRetired: 0 });
    const { rows } = await client.query(
      "select catalog_key, name from private.catalog_organizations where catalog_key = any($1) and retired_release_id is null order by catalog_key",
      [[exportKey("MX"), exportKey("BR"), exportKey("AR")]],
    );
    expect(rows).toEqual([{ catalog_key: exportKey("BR"), name: LONG_NAMES.BR }, { catalog_key: exportKey("MX"), name: LONG_NAMES.MX }]);
  });

  it("finds a long-named body by search and returns its whole name on the profile", async () => {
    const found = await anon("select public.search_union_catalog_by_country($1,null,null,null,1,'MX',null) as value", ["Sindicato Nacional de Trabajadores"]);
    const row = found.rows.find((entry) => entry.key === exportKey("MX"));
    expect(row.name).toBe(LONG_NAMES.MX);
    const profile = await anon("select public.get_union_catalog_profile($1) as value", [exportKey("BR")]);
    expect(profile).toMatchObject({ found: true, organization: { name: LONG_NAMES.BR } });
  });

  it("still refuses a name over 1,000 characters, under 2 after trimming, or with a control character", async () => {
    for (const bad of [LONG_NAMES.AR, " x ", `Example\u0007 Union`]) {
      await client.query("savepoint long_name_bad");
      await expect(client.query("update private.catalog_organizations set name = $1 where catalog_key = $2", [bad, exportKey("MX")]))
        .rejects.toMatchObject({ code: "23514", constraint: "catalog_organizations_name_check" });
      await client.query("rollback to savepoint long_name_bad");
      await client.query("release savepoint long_name_bad");
    }
    const ok = await client.query("update private.catalog_organizations set name = $1 where catalog_key = $2 returning char_length(name) as n",
      [LONG_NAMES.BR.replace("Trabalhadores", "Trabalhadoras"), exportKey("MX")]);
    expect(ok.rows[0].n).toBe(1000);
  });
});
