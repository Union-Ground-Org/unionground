// @vitest-environment node
// REQ-UG-BLOCK-GOVERNMENT-AND-EMPLOYER-EMAIL-DOMAINS-20261102 (#6726):
// government and employer email domains can never be a Union Ground account
// address. The config, its database copy, the shared route matcher and the
// auth.users trigger must agree. BUG-UG-GOV-EMAIL-BLOCK-MISSES-US-LOCALITY-DOMAINS-20261102
// (#6788): <place>.<state>.us itself is government too; 20261102192000 rewrites
// the database copy and the matcher.
import { readdirSync, readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { describe, expect, it } from "vitest";
import { accountEmailBlockReason, accountEmailDomain, accountEmailDomainRules } from "../api/_lib/accountEmailDomains.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const config = JSON.parse(read("config/account-blocked-email-domains.json"));
const MIGRATION = "supabase/migrations/20261102161500_account_email_domain_block.sql";
const sql = read(MIGRATION);
const LOCALITY_MIGRATION = "supabase/migrations/20261102192000_account_email_domain_us_locality_delegations.sql";
const localitySql = read(LOCALITY_MIGRATION);

describe("the account email domain rules", () => {
  it.each([
    ["person@agency.gov"], ["person@army.mil"], ["person@sub.agency.gov"], ["Person@AGENCY.GOV."],
    ["person@hmrc.gov.uk"], ["person@sat.gob.mx"], ["person@mof.go.jp"], ["person@interieur.gouv.fr"],
    ["person@health.govt.nz"], ["person@cra-arc.gc.ca"], ["person@gov.bc.ca"], ["person@nhs.net"], ["person@fs.fed.us"],
    ["person@dot.state.ny.us"], ["person@lausd.k12.ca.us"], ["person@ci.boston.ma.us"], ["person@police.co.king.wa.us"],
    ["person@riverside.ca.us"], ["person@boston.ma.us"], ["person@ci.riverside.ca.us"], ["person@sanjuan.pr.us"],
    ["person@k12.ca.us"],
  ])("refuses the government address %s", (email) => {
    expect(accountEmailBlockReason(email)).toBe("government");
  });

  it.each([
    ["person@gmail.com"], ["person@example.org"], ["person@tamarack-union.org"], ["person@go.com"], ["person@gov.com"],
    ["person@acme.riverside.ca.us"], ["person@ny.us"], ["person@example.us"],
    ["person@riverside.zz.us"], ["person@riverside.ca.uk"], ["person@riverside.ca.com"], ["person@state.com"], ["person@government.example"], [""], [null], ["no-at-sign"],
  ])("allows %s", (email) => {
    expect(accountEmailBlockReason(email)).toBeNull();
  });

  it("refuses an employer domain and its subdomains, and never matches a lookalike", () => {
    const rules = { ...accountEmailDomainRules(), employer: ["employer.example"] };
    expect(accountEmailBlockReason("person@employer.example", rules)).toBe("employer");
    expect(accountEmailBlockReason("person@mail.employer.example", rules)).toBe("employer");
    expect(accountEmailBlockReason("person@notemployer.example", rules)).toBeNull();
  });

  it("reads the domain after the last @, lowercased, without trailing dots", () => {
    expect(accountEmailDomain(" A@B@Agency.GOV.. ")).toBe("agency.gov");
    expect(accountEmailDomain("nothing")).toBe("");
  });

  it("keeps every rule lowercase, sorted and unique, and lists no union domain as an employer", () => {
    const lists = [config.government.topLevel, config.government.countrySecondLevel, config.government.suffixes,
      config.government.usStateLevel, config.government.usLocality, config.government.usStates, config.employer];
    for (const list of lists) {
      expect(list).toEqual([...new Set(list)].sort());
      for (const value of list) expect(value).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/);
    }
    for (const state of config.government.usStates) expect(state).toMatch(/^[a-z]{2}$/);
    expect(config.government.usStates).toHaveLength(56);
    const families = JSON.parse(read("config/catalog-family-domains.json"));
    const unionDomains = new Set(Object.values(families.families).flat());
    expect(config.employer.filter((domain) => unionDomains.has(domain))).toEqual([]);
  });
});

describe("the database copy", () => {
  it("is rewritten to exactly the config by the newest rules migration", () => {
    const expected = [
      ...config.government.topLevel.map((value) => ["top_level", value]),
      ...config.government.countrySecondLevel.map((value) => ["country_second_level", value]),
      ...config.government.suffixes.map((value) => ["suffix", value]),
      ...config.government.usStateLevel.map((value) => ["us_state_level", value]),
      ...config.government.usLocality.map((value) => ["us_locality", value]),
      ...config.government.usStates.map((value) => ["us_state", value]),
      ...config.employer.map((value) => ["employer", value]),
    ];
    const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
    const rewriters = migrations.filter((name) => read(`supabase/migrations/${name}`).includes("insert into private.account_blocked_email_domain_rules"));
    expect(`supabase/migrations/${rewriters.at(-1)}`).toBe(LOCALITY_MIGRATION);
    expect(localitySql).toContain("delete from private.account_blocked_email_domain_rules;\n\n-- Seeded from");
    const seed = localitySql.slice(localitySql.indexOf("insert into private.account_blocked_email_domain_rules (rule, value) values"));
    const rows = [...seed.slice(0, seed.indexOf(";")).matchAll(/\('([a-z_]+)', '([^']+)'\)/g)].map((match) => [match[1], match[2]]);
    expect(rows).toEqual(expected);
    expect(localitySql).toContain(`-- Seeded from config/account-blocked-email-domains.json. ${expected.length} rows.`);
    expect(localitySql).toContain("'us_locality', 'us_state', 'employer'));");
  });

  it("refuses exactly <place>.<state>.us for a us_state label, as the route matcher does", () => {
    const matcher = localitySql.slice(localitySql.indexOf("create or replace function private.account_email_block_reason(p_email text)"));
    expect(matcher).toContain("if n = 3 and exists (select 1 from private.account_blocked_email_domain_rules r\n"
      + "                         where r.rule = 'us_state' and r.value = labels[n - 1]) then\n      return 'government';");
    expect(matcher.indexOf("r.rule = 'us_state' and")).toBeGreaterThan(matcher.indexOf("if labels[n] = 'us' and n >= 3"));
    expect(matcher.indexOf("r.rule = 'us_state' and")).toBeLessThan(matcher.indexOf("r.rule = 'employer'"));
    expect(localitySql).toContain("revoke all on function private.account_email_block_reason(text) from public, anon, authenticated, service_role;");
    expect(localitySql).toContain("pg_catalog.split_part(s.object_name, '(', 1) = 'account_email_block_reason'");
    expect(localitySql).toContain("account_lifecycle_referential_action_trigger_issues()");
  });

  it("keeps the rules private and the functions out of every client role's reach", () => {
    expect(sql).toContain("alter table private.account_blocked_email_domain_rules force row level security;");
    expect(sql).toContain("revoke all on table private.account_blocked_email_domain_rules from public, anon, authenticated, service_role;");
    expect(sql).toContain("revoke all on function private.account_email_block_reason(text) from public, anon, authenticated, service_role;");
    expect(sql).toContain("revoke all on function private.guard_account_email_domain() from public, anon, authenticated, service_role;");
  });

  it.each([[MIGRATION], [LOCALITY_MIGRATION]])("%s applies under the hosted runner's empty search path", (path) => {
    const text = read(path);
    expect(text).toMatch(/^begin;\nset local search_path = pg_catalog;/m);
    expect(text).not.toMatch(/^\s*set\s+search_path/im);
    for (const body of text.split("$function$").filter((_part, index) => index % 2 === 1)) {
      expect(body.replace(/distinct from (old|new)\./g, "")).not.toMatch(/\bfrom (?!private\.)[a-z_]+/);
    }
  });

  it("refuses a blocked insert and a change to a blocked email or email_change, and lets an unchanged address through", () => {
    expect(sql).toMatch(/create trigger guard_account_email_domain\nbefore insert or update of email, email_change on auth\.users\nfor each row execute function private\.guard_account_email_domain\(\);/);
    const guard = sql.slice(sql.indexOf("create function private.guard_account_email_domain()"));
    expect(guard).toContain("if tg_op = 'INSERT' then\n    if private.account_email_block_reason(new.email) is not null then");
    expect(guard).toContain("new.email is distinct from old.email and private.account_email_block_reason(new.email) is not null");
    expect(guard).toContain("new.email_change is distinct from old.email_change\n         and private.account_email_block_reason(new.email_change) is not null");
    expect(guard).toContain("hint = 'email-domain-blocked'");
  });

  it("registers the trigger and both functions in the account lifecycle trigger review", () => {
    expect(sql).toContain("s.object_name = 'guard_account_email_domain'");
    expect(sql).toContain("('guard_account_email_domain', 'account_email_block_reason')");
    expect(sql).toContain("account_lifecycle_referential_action_trigger_issues()");
  });
});

describe("the routes that read the config", () => {
  it("ship the config with every function that imports the matcher", () => {
    const vercel = JSON.parse(read("vercel.json"));
    const importers = readdirSync(new URL("../api/", import.meta.url))
      .filter((name) => name.endsWith(".js") && read(`api/${name}`).includes("./_lib/accountEmailDomains.js"))
      .map((name) => `api/${name}`).sort();
    expect(importers).toEqual(["api/accept-invitation.js", "api/admin-invitations.js", "api/admin-signin-recovery.js",
      "api/open-signup-confirm.js", "api/open-signup.js", "api/scim.js"]);
    for (const name of importers) {
      expect(matchesGlob("config/account-blocked-email-domains.json", vercel.functions[name]?.includeFiles || ""), name).toBe(true);
    }
  });
});
