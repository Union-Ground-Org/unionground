// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadMigrationSql } from "./helpers/migration.js";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";

const sql = loadMigrationSql("_intake_founder_invitation.sql");
describe("intake founder migration predecessor protection", () => {
  it("refuses every suppressed founder resend under the gate before replacing a link", () => {
    const source = parseFunctions(sql).find((fn) => fn.name === "public.resend_organization_founder_invitation")?.source;
    expect(source).toBeTypeOf("string");
    expect(source).toContain("private.public_interest_suppression_scope(old_row.normalized_email)");
    expect(source).toContain("from private.public_interest_suppressions");
    expect(source.indexOf("perform private.lock_case_graph")).toBeLessThan(source.indexOf("from private.public_interest_suppressions"));
    expect(source.indexOf("from private.public_interest_suppressions")).toBeLessThan(source.indexOf("set status = 'superseded'"));
    expect(source).not.toContain("intake_review_events");
  });
  it("projects the latest descendant's state and actionable id, not only the audited root", () => {
    const source = parseFunctions(sql).find((fn) => fn.name === "private.intake_review_row").source;
    expect(source).toContain("with recursive invitation_chain as");
    expect(source).toContain("i.replaces_id = c.id");
    expect(source).toContain("order by i.delivery_version desc, i.created_at desc, i.id desc");
    expect(source).toContain("limit 1");
  });
  it("returns the database recorder's actual delivery fields", () => {
    const source = parseFunctions(sql).find((fn) => fn.name === "public.record_organization_founder_invitation_delivery")?.source;
    expect(source).toBeTypeOf("string");
    expect(source.match(/returning \* into invitation_row/g)).toHaveLength(2);
    expect(source).toContain("'sentAt', invitation_row.sent_at");
    expect(source).toContain("'expiresAt', invitation_row.expires_at");
  });
  it("refuses an unreviewed installed predecessor before any schema or function change", () => {
    const guard = sql.match(/do \$predecessor\$([\s\S]*?)\$predecessor\$;/)?.[1];
    expect(guard).toBeTypeOf("string");
    for (const signature of [
      "private.intake_review_row(public.public_interest_submissions)",
      "public.confirm_public_interest_stop(text,text)",
      "public.stop_public_interest(text,text,text,text,text,text)",
      "public.resend_organization_founder_invitation(uuid,text)",
      "public.record_organization_founder_invitation_delivery(uuid,integer,text)",
    ]) {
      expect(guard).toContain(`pg_catalog.to_regprocedure('${signature}')`);
      expect(guard).toContain(`unreviewed predecessor: ${signature.split("(")[0]}`);
    }
    expect(guard.match(/pg_catalog\.md5\(pg_catalog\.pg_get_functiondef/g)).toHaveLength(5);
    expect(guard.match(/is distinct from '[a-f0-9]{32}'/g)).toHaveLength(5);
    expect(sql.indexOf("$predecessor$;")).toBeLessThan(sql.indexOf("alter table"));
    expect(parseFunctions(sql).map((fn) => fn.name)).not.toContain("public.confirm_public_interest_unsubscribe");
  });
});
