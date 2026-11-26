// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, migrationFiles, stripComments } from "./helpers/migration.js";

const sql = readFileSync(new URL("../supabase/migrations/20260828073000_mi1_calendar_freebusy_oauth.sql", import.meta.url), "utf8");
const importSql = readFileSync(new URL("../supabase/migrations/20260903031000_calendar_import_completion.sql", import.meta.url), "utf8");
const scopeUpgradeSql = readFileSync(new URL("../supabase/migrations/20260903035000_calendar_scope_upgrade_status.sql", import.meta.url), "utf8");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("calendar free/busy oauth migration", () => {
  it("keeps token custody in private schema with no authenticated table grants", () => {
    expect(sql).toContain("create table private.calendar_oauth_states");
    expect(sql).toContain("browser_binding_hash text not null");
    expect(sql).toContain("create table private.steward_calendar_oauth_tokens");
    expect(sql).toContain("revoke all on private.calendar_oauth_states from public, anon, authenticated, service_role");
    expect(sql).toContain("revoke all on private.steward_calendar_oauth_tokens from public, anon, authenticated, service_role");
    expect(sql).not.toMatch(/grant (select|insert|update|delete|all)[^;]*on private\.(calendar_oauth_states|steward_calendar_oauth_tokens)/i);
  });

  it("keeps the introducing token RPC definitions", () => {
    for (const name of [
      "save_calendar_oauth_state",
      "consume_calendar_oauth_state",
      "upsert_steward_calendar_oauth_token",
      "delete_steward_calendar_oauth_token",
      "mark_calendar_connection_error",
    ]) {
      expect(sql).toContain(`create function public.${name}`);
    }
    expect(sql).toContain("browser_binding_hash = p_browser_binding_hash");
    expect(sql).toContain("(steward_id = p_steward and provider = p_provider)");
    expect(sql).toContain("set status = 'error'");
    expect(sql).toContain("delete from public.member_calendar_busy");
  });

  it("locks and rechecks the public connection before storing a wrapped token", () => {
    expect(sql).toContain("from public.member_calendar_connections c");
    expect(sql).toContain("c.steward_id = p_steward");
    expect(sql).toContain("c.provider = p_provider");
    expect(sql).toContain("c.status <> 'revoked'");
    expect(sql).toContain("for update;");
    expect(sql).toContain("raise exception 'no connection for this steward and provider'");
  });

  it("drops private tokens when a steward removes the public connection", () => {
    expect(sql).toContain("create or replace function public.remove_calendar_connection");
    expect(sql).toContain("delete from private.steward_calendar_oauth_tokens");
  });

  it("pins the new service-role RPCs in the db contract", () => {
    const sigs = contract.functions.map((entry) => entry.sig);
    expect(sigs).toContain("public.list_steward_calendar_oauth_tokens()");
    expect(sigs).toContain("public.save_calendar_oauth_state(p_state text, p_steward uuid, p_provider text, p_code_verifier text, p_redirect_uri text, p_browser_binding_hash text, p_expires_at timestamp with time zone)");
    expect(sigs).toContain("public.consume_calendar_oauth_state(p_state text, p_browser_binding_hash text)");
    expect(sigs).toContain("public.mark_calendar_connection_error(p_steward uuid, p_provider text)");
    const list = contract.functions.find((entry) => entry.sig === "public.list_steward_calendar_oauth_tokens()");
    expect(list.exec).toBe("service_role");
    expect(list.bodyContains).toContain("'scopes', token.scopes");
    expect(list.bodyContains).toContain(
      "order by connection.updated_at, token.steward_id, token.provider",
    );
    const upsert = contract.functions.find((entry) => entry.sig === "public.upsert_steward_calendar_oauth_token(p_steward uuid, p_provider text, p_refresh_token_ciphertext text, p_scopes text)");
    expect(upsert.bodyContains).toContain("for update");
    expect(upsert.bodyContains).toContain("c.status <> 'revoked'");
    const markError = contract.functions.find((entry) => entry.sig === "public.mark_calendar_connection_error(p_steward uuid, p_provider text)");
    expect(markError.exec).toBe("service_role");
    expect(markError.bodyContains).toContain("delete from public.member_calendar_busy");
    const remove = contract.functions.find((entry) => entry.sig === "public.remove_calendar_connection(p_provider text)");
    expect(remove.bodyContains).toContain("delete from private.steward_calendar_oauth_tokens");
  });
});

describe("calendar event-import failure contract", () => {
  it("records a bounded error timestamp without clearing free/busy or the last complete import", () => {
    expect(importSql).toContain("last_event_import_status in ('pending', 'complete', 'capacity_exceeded', 'error')");
    expect(importSql).toContain("last_event_import_status = 'error' and last_event_import_error_at is not null");
    const errorRpc = importSql.slice(
      importSql.indexOf("create function public.mark_calendar_import_error"),
      importSql.indexOf("create function public.get_my_calendar_import_status"),
    );
    expect(errorRpc).toContain("last_event_import_error_at = pg_catalog.now()");
    expect(errorRpc).toContain("last_event_import_status = 'error'");
    expect(errorRpc).toContain("connection.status = 'active'");
    expect(errorRpc).not.toContain("delete from public.member_calendar_busy");
    expect(errorRpc).not.toContain("delete from public.member_calendar_import_events");
    expect(importSql).toContain("'lastImportErrorAt', connection.last_event_import_error_at");

    const contractRpc = contract.functions.find((entry) => (
      entry.sig === "public.mark_calendar_import_error(p_steward uuid, p_provider text)"
    ));
    expect(contractRpc?.exec).toBe("service_role");
    expect(contractRpc?.bodyContains).toEqual(expect.arrayContaining([
      "last_event_import_error_at = pg_catalog.now()",
      "last_event_import_status = 'error'",
      "connection.status = 'active'",
    ]));
  });

  it("exposes a bounded scope-upgrade flag without disclosing private token scopes", () => {
    const statusRpc = scopeUpgradeSql.slice(
      scopeUpgradeSql.indexOf("create or replace function public.get_my_calendar_import_status()"),
      scopeUpgradeSql.indexOf("create or replace function public.list_steward_calendar_oauth_tokens()"),
    );
    expect(scopeUpgradeSql).toContain("create or replace function public.get_my_calendar_import_status()");
    expect(scopeUpgradeSql).toContain("left join private.steward_calendar_oauth_tokens token");
    expect(scopeUpgradeSql).toContain("'scopeUpgradeRequired'");
    expect(scopeUpgradeSql).toContain("https://www.googleapis.com/auth/calendar.readonly");
    expect(scopeUpgradeSql).toContain("Calendars.ReadBasic");
    expect(statusRpc).not.toContain("'scopes', token.scopes");
    expect(scopeUpgradeSql).toContain("grant execute on function public.get_my_calendar_import_status() to authenticated");

    const contractRpc = contract.functions.find((entry) => (
      entry.sig === "public.get_my_calendar_import_status()"
    ));
    expect(contractRpc?.bodyContains).toEqual(expect.arrayContaining([
      "private.steward_calendar_oauth_tokens",
      "'scopeUpgradeRequired'",
      "https://www.googleapis.com/auth/calendar.readonly",
      "Calendars.ReadBasic",
    ]));
  });

  it("pins list_steward_calendar_oauth_tokens to the newest migration that defines it", () => {
    const definitions = migrationFiles().filter(({ sql: text }) => (
      /create\s+(?:or\s+replace\s+)?function\s+public\.list_steward_calendar_oauth_tokens\s*\(/i
        .test(stripComments(text))
    ));
    const latest = definitions.at(-1);
    expect(latest, "list_steward_calendar_oauth_tokens must be defined").toBeTruthy();
    const listTokens = stripComments(fnBody(latest.sql, "public.list_steward_calendar_oauth_tokens()"));

    expect(listTokens).toContain("'scopes', token.scopes");
    expect(listTokens).toContain("'lastSyncAttemptAt', connection.updated_at");
    expect(listTokens).toContain("join public.member_calendar_connections connection");
    expect(listTokens).toContain("connection.status <> 'revoked'");
    expect(listTokens).toContain(
      "order by connection.updated_at, token.steward_id, token.provider",
    );
    // A leading token-row key does not move when a sync attempt only advances
    // member_calendar_connections.updated_at, so a short run keeps the same
    // prefix and starves a connection whose token row never changed.
    expect(listTokens).not.toMatch(/order by\s+(?:token|t)\./i);
    // create or replace keeps the existing grants, so the live execute grant
    // comes from the newest migration that resets them with a revoke.
    const regrants = migrationFiles().filter(({ sql: text }) => (
      /revoke all on function public\.list_steward_calendar_oauth_tokens\(\)/i.test(stripComments(text))
    ));
    const lastRegrant = regrants.at(-1);
    expect(lastRegrant, "list_steward_calendar_oauth_tokens grants must be reset").toBeTruthy();
    expect(stripComments(lastRegrant.sql)).toContain(
      "grant execute on function public.list_steward_calendar_oauth_tokens() to service_role",
    );
    for (const { name, sql: text } of migrationFiles().filter(({ name }) => name >= lastRegrant.name)) {
      expect(stripComments(text), name).not.toMatch(
        /grant execute on function public\.list_steward_calendar_oauth_tokens\(\) to (?:authenticated|anon|public)/i,
      );
    }

    const listRpc = contract.functions.find((entry) => (
      entry.sig === "public.list_steward_calendar_oauth_tokens()"
    ));
    expect(listRpc?.exec).toBe("service_role");
    expect(listRpc?.bodyContains).toEqual(expect.arrayContaining([
      "'scopes', token.scopes",
      "'lastSyncAttemptAt', connection.updated_at",
      "order by connection.updated_at, token.steward_id, token.provider",
    ]));
  });

  it("persists actual sync attempts so a short run cannot starve untouched rows", () => {
    expect(scopeUpgradeSql).toContain("create function public.mark_steward_calendar_sync_attempt(");
    expect(scopeUpgradeSql).toContain("set updated_at = pg_catalog.now()");
    const markAttempt = contract.functions.find((entry) => (
      entry.sig === "public.mark_steward_calendar_sync_attempt(p_steward uuid, p_provider text)"
    ));
    expect(markAttempt?.exec).toBe("service_role");
    expect(markAttempt?.bodyContains).toEqual(expect.arrayContaining([
      "set updated_at = pg_catalog.now()",
      "private.steward_calendar_oauth_tokens",
      "if not found then",
    ]));
  });
});
