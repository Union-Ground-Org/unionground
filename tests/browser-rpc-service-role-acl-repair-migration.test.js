// @vitest-environment node
//
// The 2026-08-28 repair file is a historical revoke list. Three channel-control
// RPCs and the four-argument persist_compass_message_briefing signature were
// retired later. Current EXECUTE grantees come from scripts/db-contract.json.
// Fixtures resolve from this module: process.cwd() aborts collection when
// Vitest is launched with this repository as --root from another directory.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const repairSql = readFileSync(
  new URL("../supabase/migrations/20260828163209_browser_rpc_service_role_acl_repair.sql", import.meta.url),
  "utf8",
).toLowerCase();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

// Same identity key as tests/db-contract.test.js: named arguments and short
// type aliases collapse to schema.name(type, type).
const TYPE_ALIASES = {
  timestamptz: "timestamp with time zone",
  timestamp: "timestamp without time zone",
  int: "integer",
  int4: "integer",
  int2: "smallint",
  int8: "bigint",
  bool: "boolean",
  varchar: "character varying",
};

function canonicalType(raw) {
  const type = raw.trim().replace(/\s+/g, " ").toLowerCase();
  const suffix = type.endsWith("[]") ? "[]" : "";
  let base = suffix ? type.slice(0, -2) : type;
  base = base.replace(/^public\./, "");
  return (TYPE_ALIASES[base] || base) + suffix;
}

function signatureKey(signature) {
  const open = signature.indexOf("(");
  const name = signature.slice(0, open).trim().toLowerCase();
  const args = signature.slice(open + 1, signature.lastIndexOf(")")).trim();
  if (!args) return `${name}()`;
  const types = args.split(",").map((arg) => {
    const identityArg = arg.trim().replace(/\s+default\s+.*$/i, "").replace(/\s*=\s*.*$/, "");
    const parts = identityArg.split(/\s+/);
    return canonicalType(parts.length > 1 && /^p_[a-z0-9_]+$/.test(parts[0]) ? parts.slice(1).join(" ") : identityArg);
  });
  return `${name}(${types.join(", ")})`;
}

const HISTORICAL_BROWSER_RPC_SIGNATURES = [
  "list_contract_clauses()",
  "list_contract_clause_grievance_counts()",
  "create_contract_clause(uuid, text, text, text, text, text, text, text[], integer)",
  "update_contract_clause(uuid, uuid, text, text, text, text, text, text, text[], integer)",
  "set_contract_clause_status(uuid, uuid, text)",
  "list_my_access_history(integer)",
  "record_member_access_event(uuid, uuid, text, text, text)",
  "configure_organization_survey_operations(uuid, jsonb)",
  "prepare_organization_survey_distribution(uuid, uuid[])",
  "queue_organization_survey_reminders(uuid)",
  "update_organization_survey_task(uuid, text, uuid, timestamptz)",
  "update_organization_survey_review(uuid, text, uuid, text, timestamptz)",
  "get_organization_survey_review_detail(uuid)",
  "get_quarterly_survey_gate()",
  "get_organization_survey_report(uuid)",
  "export_organization_survey_results(uuid)",
  "save_organization_pulse_prompt(jsonb)",
  "evaluate_contextual_pulse(text, text)",
  "respond_contextual_pulse(uuid, jsonb, boolean)",
  "save_organization_live_poll(jsonb)",
  "transition_organization_live_poll(uuid, text)",
  "set_organization_live_poll_roster(uuid, uuid[])",
  "rsvp_organization_live_poll(uuid, text)",
  "check_in_organization_live_poll(uuid, uuid)",
  "cast_organization_live_poll_vote(uuid, uuid)",
  "heartbeat_member_presence(text)",
  "set_chapter_space_controls(uuid, text, integer, boolean)",
  "set_chapter_space_preference(uuid, boolean, text)",
  "propose_compass_workspace_action(text, text, text)",
  "decide_compass_workspace_action(uuid, text)",
  "get_message_briefing_context(text, uuid)",
  "save_chapter_space_keyword_monitor(uuid, text, boolean)",
  "mark_chapter_space_keyword_hit_read(uuid)",
  "save_compass_workspace_preferences(jsonb, jsonb)",
  "persist_compass_message_briefing(text, uuid, text, jsonb)",
  "get_member_engagement_snapshot()",
  "get_staff_engagement_snapshot()",
];

const RETIRED_BROWSER_RPC_SIGNATURES = [
  "set_chapter_space_preference(uuid, boolean, text)",
  "save_chapter_space_keyword_monitor(uuid, text, boolean)",
  "mark_chapter_space_keyword_hit_read(uuid)",
  "persist_compass_message_briefing(text, uuid, text, jsonb)",
];

const CURRENT_BRIEFING_SIGNATURE = "persist_compass_message_briefing(text, uuid, text, jsonb, text)";

const CURRENT_BROWSER_RPC_SIGNATURES = HISTORICAL_BROWSER_RPC_SIGNATURES.flatMap((signature) => {
  if (signature === "persist_compass_message_briefing(text, uuid, text, jsonb)") return [CURRENT_BRIEFING_SIGNATURE];
  if (RETIRED_BROWSER_RPC_SIGNATURES.includes(signature)) return [];
  return [signature];
});

const functionsByKey = new Map(contract.functions.map((entry) => [signatureKey(entry.sig), entry]));
const absentByKey = new Set(contract.functionsAbsent.map((entry) => signatureKey(entry.sig)));

function historicalRevokes(sql) {
  return [...sql.matchAll(/revoke execute on function public\.([a-z0-9_]+\([^)]*\)) from service_role;/g)]
    .map((match) => match[1].replace(/\s+/g, " "));
}

function grantees(entry) {
  return entry.exec.split(",").map((role) => role.trim()).filter(Boolean);
}

describe("browser RPC service-role ACL repair migration", () => {
  it("records the historical service_role revokes in the repair migration", () => {
    expect(historicalRevokes(repairSql)).toEqual(HISTORICAL_BROWSER_RPC_SIGNATURES);
  });

  it("does not revoke the lease-bound delivery worker RPCs", () => {
    for (const signature of [
      "claim_engagement_delivery_batch(uuid, integer, integer)",
      "get_engagement_delivery_payload(uuid, uuid)",
      "complete_engagement_delivery(uuid, uuid, boolean, text, integer)",
    ]) {
      expect(repairSql).not.toContain(`public.${signature}`);
    }
  });

  it("reloads the PostgREST schema cache after the ACL change", () => {
    expect(repairSql).toContain("notify pgrst, 'reload schema';");
  });
});

describe("current browser-session RPC service-role ACL", () => {
  it("denies service_role on every maintained browser-session RPC", () => {
    expect(CURRENT_BROWSER_RPC_SIGNATURES).toContain(CURRENT_BRIEFING_SIGNATURE);
    for (const signature of CURRENT_BROWSER_RPC_SIGNATURES) {
      expect(RETIRED_BROWSER_RPC_SIGNATURES, `${signature} is retired`).not.toContain(signature);
      const entry = functionsByKey.get(signatureKey(`public.${signature}`));
      expect(entry, `${signature} is missing from the current contract`).toBeTruthy();
      expect(grantees(entry), `${signature} permits service_role`).not.toContain("service_role");
    }
  });

  it("keeps retired browser-session signatures out of the current contract", () => {
    for (const signature of RETIRED_BROWSER_RPC_SIGNATURES) {
      const key = signatureKey(`public.${signature}`);
      expect(functionsByKey.has(key), `${signature} is treated as current`).toBe(false);
      expect(absentByKey.has(key), `${signature} is missing from functionsAbsent`).toBe(true);
    }
    const liveBriefing = signatureKey(`public.${CURRENT_BRIEFING_SIGNATURE}`);
    expect(functionsByKey.has(liveBriefing)).toBe(true);
    expect(absentByKey.has(liveBriefing)).toBe(false);
  });
});
