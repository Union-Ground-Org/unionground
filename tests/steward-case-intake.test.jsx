import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { CaseDetailsSummary } from "../src/features/caseIntake/CaseDetailsFields.jsx";
import {
  caseIntakeArguments,
  claimMemberCase,
  listUnassignedChapterCases,
  loadMemberCaseDetails,
  openMemberCase,
  routineMissing,
  searchCaseMembers,
} from "../src/features/caseIntake/api.js";
import { t } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { CasesView, buildCasePacket } from "../src/views/CasesView.jsx";
import { unzipSync } from "fflate";

// REQ-UG-STEWARD-CASEWORK-GAPS-20261030 (swarm findings 22 and 23):
// stewards could not open a case for a member or put themselves on one,
// member-started cases never reached a steward's caseload, and a case had no
// place for what happened, the incident date, the remedy or informal/filed.

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

const wrap = (ui, lang = "en") => render(<LanguageProvider lang={lang}>{ui}</LanguageProvider>);
const missing = { code: "PGRST202", message: "Could not find the function" };

describe("case intake API", () => {
  it("returns each routine's payload and labels each failure", async () => {
    const ok = (data) => ({ rpc: vi.fn().mockResolvedValue({ data, error: null }) });
    const fail = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501", message: "no" } }) };
    await expect(openMemberCase(ok({ caseId: "c1", assigned: true }), { title: "x", caseType: "Pay", memberId: "m1" })).resolves.toEqual({ caseId: "c1", assigned: true });
    await expect(claimMemberCase(ok({ caseId: "c1" }), "c1")).resolves.toEqual({ caseId: "c1" });
    await expect(claimMemberCase(fail, "c1")).rejects.toThrow("Take case: no");
    await expect(searchCaseMembers(ok([{ userId: "m1" }]), " Ru ")).resolves.toEqual([{ userId: "m1" }]);
    await expect(searchCaseMembers(ok(null), "Ru")).resolves.toEqual([]);
    await expect(searchCaseMembers(fail, "Ru")).rejects.toThrow("Member search: no");
    await expect(listUnassignedChapterCases(ok([{ id: "c1" }]))).resolves.toEqual({ state: "ready", rows: [{ id: "c1" }] });
    await expect(listUnassignedChapterCases(ok(null))).resolves.toEqual({ state: "ready", rows: [] });
    expect(routineMissing({ code: "42883" })).toBe(true);
    expect(routineMissing({ code: "42501" })).toBe(false);
    const refused = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "22023", message: "bad" } }) };
    await expect(openMemberCase(refused, { title: "x", caseType: "Pay" })).rejects.toThrow("Create case: bad");
  });

  it("surfaces a real case-details failure and treats no row as no details", async () => {
    const query = (result) => {
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => result };
      return { from: () => chain };
    };
    await expect(loadMemberCaseDetails(query({ data: null, error: { code: "42501", message: "denied" } }), "c1")).rejects.toThrow("Case details: denied");
    await expect(loadMemberCaseDetails(query({ data: null, error: null }), "c1")).resolves.toBeNull();
    await expect(loadMemberCaseDetails(query({ data: null, error: { code: "XX000", message: "column member_cases.remedy_sought does not exist" } }), "c1")).resolves.toBeNull();
    await expect(loadMemberCaseDetails(query({ data: { id: "c1" }, error: null }), "c1"))
      .resolves.toEqual({ description: null, incidentDate: null, remedySought: null, filingStatus: null });
  });

  it("maps the intake fields to open_member_case and drops empty or unknown values", () => {
    expect(caseIntakeArguments({
      memberId: "m1", title: "  Written warning  ", caseType: "Discipline", articles: " Art 9 ",
      deadline: "2026-11-13", description: " Long story ", incidentDate: "2026-10-01",
      remedySought: " rescind ", filingStatus: "informal",
    })).toEqual({
      p_member_id: "m1", p_title: "Written warning", p_case_type: "Discipline", p_articles: "Art 9",
      p_deadline: "2026-11-13", p_description: "Long story", p_incident_date: "2026-10-01",
      p_remedy_sought: "rescind", p_filing_status: "informal", p_assign_self: true,
    });
    expect(caseIntakeArguments({ title: "x", caseType: "Pay", deadline: "", incidentDate: "bad", filingStatus: "maybe", description: "  " }))
      .toMatchObject({ p_member_id: null, p_deadline: null, p_incident_date: null, p_filing_status: null, p_description: null, p_articles: "" });
    expect(caseIntakeArguments({ title: "x", caseType: "Pay", assignSelf: false }).p_assign_self).toBe(false);
  });

  // #8960 (BUG-UG-WRITE-RESENT-WITH-FEWER-ARGUMENTS-AFTER-A-MISSING-FUNCTION-20261116):
  // a plain member intake is sent once; a missing function is the answer,
  // never a second write through create_member_case as whoever is signed in.
  it("sends a plain member intake once, and never falls back to create_member_case", async () => {
    for (const error of [missing, { code: "PGRST202", message: "Could not find the function" }]) {
      const rpc = vi.fn().mockResolvedValueOnce({ data: null, error }).mockResolvedValue({ data: { caseId: "c-other" }, error: null });
      const refusal = await openMemberCase({ rpc }, { title: "Pay", caseType: "Pay", deadline: "" }).catch((failure) => failure);
      expect(refusal.code).toBe(error.code);
      expect(rpc.mock.calls.map(([name]) => name)).toEqual(["open_member_case"]);
    }
  });

  it("never drops details or a case for someone else into the old routine", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: missing });
    await expect(openMemberCase({ rpc }, { title: "Pay", caseType: "Pay", remedySought: "back pay" })).rejects.toThrow("Create case:");
    await expect(openMemberCase({ rpc }, { title: "Pay", caseType: "Pay", memberId: "m1" })).rejects.toThrow("Open case:");
    expect(rpc.mock.calls.every(([name]) => name === "open_member_case")).toBe(true);
  });

  it("reports the steward lists unavailable, not failed, before the migration lands", async () => {
    await expect(listUnassignedChapterCases({ rpc: vi.fn().mockResolvedValue({ data: null, error: missing }) }))
      .resolves.toEqual({ state: "unavailable", rows: [] });
    await expect(listUnassignedChapterCases({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501", message: "no" } }) }))
      .rejects.toThrow("Cases waiting for a steward");
  });

  it("reads case details on their own and returns null where the columns do not exist yet", async () => {
    const query = (result) => {
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => result };
      return { from: vi.fn(() => chain) };
    };
    await expect(loadMemberCaseDetails(query({ data: null, error: { code: "42703", message: "column member_cases.description does not exist" } }), "c1")).resolves.toBeNull();
    await expect(loadMemberCaseDetails(query({ data: { id: "c1", description: "d", incident_date: "2026-10-01", remedy_sought: "r", filing_status: "filed" }, error: null }), "c1"))
      .resolves.toEqual({ description: "d", incidentDate: "2026-10-01", remedySought: "r", filingStatus: "filed" });
  });
});

const CASE = {
  id: "case-1", reference: "GR-2026-02842", title: "Written warning", type: "Discipline", articles: "Art 9",
  status: "active", step: "Intake", deadline: "Oct 22, 2026", deadlineValue: "2026-10-22", updates: [], files: [],
};
const casesData = (cases = [CASE]) => ({ member: { id: "m1", organizationId: "o1", chapterId: "c1" }, cases });

describe("member Cases: details on intake and on the case, and the case's own address", () => {
  it("sends the case details with the member's new case", async () => {
    const onCreateCase = vi.fn().mockResolvedValue({});
    wrap(<CasesView data={casesData([])} onCreateCase={onCreateCase} onMessages={() => {}} />);
    fireEvent.click(screen.getAllByRole("button", { name: t("en", "mcases.startCase") })[0]);
    const dialog = await screen.findByRole("dialog");
    // The member's own form speaks to the member, not about them (#9158).
    expect(within(dialog).getByLabelText("Remedy sought")).toHaveAccessibleDescription(`${t("en", "caseIntake.remedyHelpOwn")} ${t("en", "caseIntake.lengthLimit", { max: "2,000" })}`);
    expect(within(dialog).queryByText(/What the member asks for/)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Call-back pay short" } });
    fireEvent.change(within(dialog).getByLabelText("What happened"), { target: { value: "Paid 1.5 hours, owed 3." } });
    fireEvent.change(within(dialog).getByLabelText("Informal or filed"), { target: { value: "informal" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: t("en", "cases.createCase") })); });
    expect(onCreateCase).toHaveBeenCalledWith(expect.objectContaining({
      title: "Call-back pay short", description: "Paid 1.5 hours, owed 3.", filingStatus: "informal",
    }));
  });

  it("shows the stored details in the case pop-up and puts the case in the address bar", async () => {
    const loadCaseDetails = vi.fn().mockResolvedValue({ description: "Warned on Oct 1.", incidentDate: "2026-10-01", remedySought: null, filingStatus: "filed" });
    wrap(<CasesView data={casesData()} loadCaseDetails={loadCaseDetails} onMessages={() => {}} />);
    fireEvent.click(screen.getAllByText("Written warning")[0]);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Warned on Oct 1.")).toBeInTheDocument();
    expect(within(dialog).getByText("Filed with the employer")).toBeInTheDocument();
    expect(within(dialog).getByText("Not recorded")).toBeInTheDocument();
    expect(loadCaseDetails).toHaveBeenCalledWith("case-1");
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("case")).toBe("case-1"));
    fireEvent.click(within(dialog).getByRole("button", { name: t("en", "dialogs.close") }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("case")).toBeNull());
  });


  it("puts the case details into the exported packet, and leaves them out where none exist", async () => {
    const item = { ...CASE, files: [] };
    const read = (zip) => JSON.parse(new TextDecoder().decode(unzipSync(zip)["case-summary.json"]));
    const withDetails = read(await buildCasePacket(item, async () => new ArrayBuffer(0), { description: "Warned on Oct 1.", incidentDate: "2026-10-01", remedySought: "Rescind", filingStatus: "filed" }));
    expect(withDetails.details).toEqual({ description: "Warned on Oct 1.", incidentDate: "2026-10-01", remedySought: "Rescind", filingStatus: "filed" });
    expect(read(await buildCasePacket(item, async () => new ArrayBuffer(0))).details).toBeUndefined();
  });

  it("hides the details block where details are not available", async () => {
    wrap(<CaseDetailsSummary caseId="c1" loadDetails={vi.fn().mockResolvedValue(null)} />);
    await act(async () => {});
    expect(screen.queryByText("Case details")).not.toBeInTheDocument();
  });
});

describe("the migration", () => {
  const files = readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort();
  const name = "20261030204500_steward_case_intake.sql";
  const sql = readFileSync(`supabase/migrations/${name}`, "utf8");
  const body = (fn) => {
    const start = sql.indexOf(`create or replace function public.${fn}(`);
    return sql.slice(start, sql.indexOf("$function$;", start));
  };

  it("sorts after every migration it was admitted behind", () => {
    // It sorted last when it merged; later stamps (20261030214501, ballot
    // nominations) follow it, so the admission order is what stays pinned.
    expect(files.indexOf(name)).toBeGreaterThan(files.indexOf("20261030203101_event_staff_drafts_and_rsvp_switch.sql"));
    expect(files.indexOf("20261030203101_event_staff_drafts_and_rsvp_switch.sql")).toBeGreaterThan(-1);
  });

  it("starts both writers with the case-graph lock and declares no initializers", () => {
    for (const fn of ["open_member_case", "claim_member_case"]) {
      const source = body(fn);
      expect(source).toMatch(/as \$function\$\nbegin\n {2}perform private\.lock_case_graph\(array\[\(select auth\.uid\(\)\)\], array\[\]::uuid\[\]\);/);
      const declarations = /declare\n([\s\S]*?)\nbegin/.exec(source)[1];
      expect(declarations).not.toMatch(/:=|\bdefault\b/);
    }
  });

  it("opens a case for someone else only inside the caller's staff scope, and assigns only a steward in scope", () => {
    const source = body("open_member_case");
    expect(source).toContain("public.member_has_role(array['steward', 'coordinator', 'admin'])");
    expect(source).toContain("steward_scope := public.staff_can_see_user(p_member_id, 'steward');");
    expect(source).toContain("raise exception 'member outside your scope' using errcode = '42501';");
    expect(source).toContain("assign := coalesce(p_assign_self, true) and steward_scope;");
    expect(source).toContain("created := public.create_member_case(p_title, p_deadline, p_case_type, p_articles);");
    expect(source).toContain("insert into public.member_case_assignment_audit");
  });

  it("lets a steward take only an active, unassigned, unrestricted case in scope that is not their own", () => {
    const source = body("claim_member_case");
    expect(source).toContain("or not public.staff_can_see_user(case_row.user_id, 'steward')");
    expect(source).toContain("or case_row.is_restricted then");
    expect(source).toContain("if case_row.user_id = caller then");
    expect(source).toContain("if case_row.status <> 'active' then");
    expect(source).toContain("raise exception 'this case already has a steward' using errcode = '23505';");
    const list = body("list_unassigned_chapter_cases");
    for (const predicate of ["c.steward_user_id is null", "not c.is_restricted", "c.user_id <> caller", "public.staff_can_see_user(c.user_id, 'steward')"]) {
      expect(list).toContain(predicate);
    }
  });

  it("grants each new routine to authenticated only, after revoking it from everyone", () => {
    for (const signature of [
      "public.open_member_case(uuid, text, text, text, date, text, date, text, text, boolean)",
      "public.claim_member_case(uuid)",
      "public.list_unassigned_chapter_cases()",
      "public.list_case_member_candidates(text)",
    ]) {
      expect(sql).toContain(`revoke all on function ${signature}`);
      expect(sql).toMatch(new RegExp(`grant execute on function ${signature.replace(/[().]/g, "\\$&")}\\s+to authenticated;`));
    }
    expect(sql).not.toMatch(/grant (?:insert|update)[^;]*on (?:table )?public\.member_cases/i);
  });
});

// Live proof on the disposable database (SUPABASE_DB_URL, loopback 55000-59999).
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("steward case intake on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "steward-case-intake-proof" });
    await client.connect();
    await client.query("set statement_timeout = '20s'");
    await client.query("begin");
  });

  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });

  const asOwner = async () => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims','',true)");
  };
  const actAs = async (userId) => {
    await asOwner();
    const session = randomUUID();
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, userId]);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: session })]);
    await client.query("set local role authenticated");
  };
  const capture = async (statement, args = []) => {
    await client.query("savepoint cell");
    try {
      const result = await client.query(statement, args);
      await client.query("release savepoint cell");
      return { ok: true, value: result.rows[0]?.v ?? null, rows: result.rows, code: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, value: null, rows: [], code: error.code || "", message: error.message };
    }
  };

  let t;
  const person = async (chapter, { organization = t.orgA, role = null, name } = {}) => {
    await asOwner();
    const id = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, chapter, name ?? `Proof ${id.slice(0, 8)}`]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [organization, id]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, chapter]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    if (role) {
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
    }
    return id;
  };

  it("opens, lists, claims and refuses exactly inside the steward's scope", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    t = { orgA, orgB, local: `sci-local-${orgA}`, other: `sci-other-${orgB}` };
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3), ($4,$5,$6)",
      [orgA, `sci-${orgA}`, `Steward Intake A ${orgA}`, orgB, `sci-${orgB}`, `Steward Intake B ${orgB}`]);
    await client.query(`insert into public.chapters(id,name,slug,region,organization_id,order_index)
      values ($1,'Intake Local',$1,'proof',$3,9971), ($2,'Other Local',$2,'proof',$4,9972)`, [t.local, t.other, orgA, orgB]);
    const steward = await person(t.local, { role: "steward", name: "Tamsin Proof" });
    const otherSteward = await person(t.local, { role: "steward", name: "Odette Proof" });
    const member = await person(t.local, { name: "Ruth Kimball Proof" });
    const plain = await person(t.local, { name: "Plain Member Proof" });
    const outsider = await person(t.other, { organization: orgB, name: "Ruth Outsider Proof" });

    // A steward finds the member, never the other organization's namesake.
    await actAs(steward);
    const found = await capture("select public.list_case_member_candidates('Ruth') as v");
    expect(found.ok, found.message).toBe(true);
    expect(found.value.map((row) => row.userId)).toEqual([member]);

    // Opened for the member, with every detail, and on the steward's caseload.
    const opened = await capture(`select public.open_member_case($1,'Written warning','Discipline','Art 9',null,
      'Warned for refusing overtime.', current_date - 29, 'Rescind the warning', 'filed', true) as v`, [member]);
    expect(opened.ok, opened.message).toBe(true);
    expect(opened.value).toMatchObject({ assigned: true });
    const caseload = await capture("select c.user_id, c.steward_user_id, c.description, c.remedy_sought, c.filing_status, c.incident_date is not null as dated from public.member_cases c where c.id = $1", [opened.value.caseId]);
    expect(caseload.rows[0]).toMatchObject({ user_id: member, steward_user_id: steward, description: "Warned for refusing overtime.", remedy_sought: "Rescind the warning", filing_status: "filed", dated: true });

    // Out of scope, wrong role, bad status value: refused.
    expect((await capture("select public.open_member_case($1,'x','Pay','',null,null,null,null,null,true) as v", [outsider])).code).toBe("42501");
    expect((await capture("select public.open_member_case($1,'x','Pay','',null,null,null,null,'maybe',true) as v", [member])).code).toBe("22023");
    await actAs(plain);
    expect((await capture("select public.open_member_case($1,'x','Pay','',null,null,null,null,null,true) as v", [member])).code).toBe("42501");

    // The member's own case carries its details and waits for a steward.
    await actAs(member);
    const own = await capture("select public.open_member_case(null,'Call-back pay','Pay','',null,'Paid 1.5 hours, owed 3.',null,'Back pay','informal',true) as v");
    expect(own.ok, own.message).toBe(true);
    expect(own.value).toMatchObject({ assigned: false });
    expect((await capture("update public.member_cases set description = 'edited' where id = $1", [own.value.caseId])).code).toBe("42501");

    await actAs(steward);
    const waiting = await capture("select public.list_unassigned_chapter_cases() as v");
    expect(waiting.ok, waiting.message).toBe(true);
    expect(waiting.value.map((row) => row.id)).toEqual([own.value.caseId]);
    expect(waiting.value[0]).toMatchObject({ memberName: "Ruth Kimball Proof", filingStatus: "informal", caseType: "Pay" });
    const claimed = await capture("select public.claim_member_case($1) as v", [own.value.caseId]);
    expect(claimed.ok, claimed.message).toBe(true);
    expect((await capture("select public.list_unassigned_chapter_cases() as v")).value).toEqual([]);
    const visible = await capture("select count(*)::int as v from public.member_cases where id = $1 and steward_user_id = $2", [own.value.caseId, steward]);
    expect(visible.value).toBe(1);

    await actAs(otherSteward);
    expect((await capture("select public.claim_member_case($1) as v", [own.value.caseId])).code).toBe("23505");
    await actAs(plain);
    expect((await capture("select public.claim_member_case($1) as v", [own.value.caseId])).code).toBe("42501");
    expect((await capture("select public.list_unassigned_chapter_cases() as v")).code).toBe("42501");

    await asOwner();
    const audit = await capture("select count(*)::int as v from public.member_case_assignment_audit where case_id = any($1::uuid[])", [[opened.value.caseId, own.value.caseId]]);
    expect(audit.value).toBe(2);
  });

  // Gate round 1 (r1s1): a member who moves to another organization must not
  // carry an old, unassigned case into the new organization's stewards' reach.
  it("refuses a steward of another organization a moved member's old case", async () => {
    const mover = await person(t.local, { name: "Mover Proof" });
    const bSteward = await person(t.other, { organization: t.orgB, role: "steward", name: "Other Org Steward Proof" });
    await actAs(mover);
    const old = await capture("select public.open_member_case(null,'Old case','Pay','',null,null,null,null,null,true) as v");
    expect(old.ok, old.message).toBe(true);

    await asOwner();
    await client.query("update public.organization_memberships set status='revoked', revoked_at=now() where user_id=$1 and organization_id=$2", [mover, t.orgA]);
    await client.query("update public.member_chapter_memberships set status='revoked', revoked_at=now() where user_id=$1 and chapter_id=$2", [mover, t.local]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [t.orgB, mover]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [mover, t.other]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [mover, t.other]);

    await actAs(bSteward);
    expect((await capture("select public.claim_member_case($1) as v", [old.value.caseId])).code).toBe("42501");
    const waiting = await capture("select public.list_unassigned_chapter_cases() as v");
    expect(waiting.ok, waiting.message).toBe(true);
    expect(waiting.value.map((row) => row.id)).not.toContain(old.value.caseId);
    await asOwner();
    const untouched = await capture("select steward_user_id as v from public.member_cases where id = $1", [old.value.caseId]);
    expect(untouched.value).toBeNull();
  });
});
