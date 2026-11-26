import { caseListOpenerName } from "./helpers/case-list-opener.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { CaseArticlesEditor } from "../src/features/caseIntake/CaseArticlesEditor.jsx";
import { CoordinatorView } from "../src/views/CoordinatorView.jsx";
import { coordinatorUpdateCase } from "../src/lib/memberApi.js";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("case editor payloads against the real staff update RPC", () => {
  let db, caseId, completion;
  const ids = Object.fromEntries(["org", "member", "staff", "session"].map(key => [key, randomUUID()]));
  const chapter = `test-editor-${ids.org}`;
  const snapshot = () => ({ id: caseId, articles: "Article A", status: "active", deadline: "2026-12-01" });
  const current = async () => {
    await db.query("reset role");
    return (await db.query("select status,deadline::text,articles from public.member_cases where id=$1", [caseId])).rows[0];
  };
  const apiClient = { rpc: async (name, args) => {
    expect(name).toBe("coordinator_update_case");
    const types = { p_case_id: "uuid", p_status: "text", p_step: "text", p_deadline: "date", p_reason: "text", p_articles: "text" };
    const entries = Object.entries(args).filter(([, value]) => value !== undefined);
    await db.query("savepoint editor_rpc");
    try {
      const result = await db.query(`select public.coordinator_update_case(${entries.map(([key], index) => `${key} => $${index + 1}::${types[key]}`).join(",")}) as result`, entries.map(([, value]) => value));
      await db.query("release savepoint editor_rpc");
      return { data: result.rows[0].result, error: null };
    } catch (error) {
      await db.query("rollback to savepoint editor_rpc");
      return { data: null, error };
    }
  } };
  const updateCase = vi.fn((id, fields) => { completion = coordinatorUpdateCase(apiClient, id, fields); return completion; });
  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false });
    await db.connect(); await db.query("begin");
    await db.query("set local statement_timeout='60s'");
    for (const person of ["member", "staff"]) await db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [ids[person], `${ids[person]}@example.invalid`]);
    await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [ids.session, ids.staff]);
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), ids.staff]);
    await db.query("insert into public.organizations(id,slug,name) values($1,$2,$2)", [ids.org, chapter]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9908)", [chapter, ids.org]);
    await db.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [ids.org]);
    for (const person of ["member", "staff"]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.org, ids[person]]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [ids[person], chapter]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [ids[person], chapter]);
    }
    for (const role of ["steward", "coordinator"]) {
      await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$2)", [ids.org, ids.staff, role]);
      await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [ids.staff, role, chapter]);
    }
  });
  beforeEach(async () => {
    await db.query("reset role"); await db.query("select set_config('request.jwt.claims','{}',true)"); await db.query("savepoint editor_test");
    caseId = randomUUID(); completion = null; updateCase.mockClear();
    await db.query("insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,steward_user_id,status,deadline,articles) values($1,$2,$3,'Contract review','other',$4,$5,$6,'active','2026-12-01','Article A')", [caseId, ids.member, `TEST-${caseId}`, ids.org, chapter, ids.staff]);
  });
  afterEach(async () => { clearDeviceParityState(); await db.query("rollback to savepoint editor_test"); await db.query("reset role"); });
  afterAll(async () => { if (db) { await db.query("rollback"); await db.end(); } });
  const act = async () => {
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "authenticated", sub: ids.staff, session_id: ids.session, aal: "aal2" })]);
    await db.query("set local role authenticated");
  };

  it.each(["resolved", "extended"])("an article-only save preserves a concurrently %s workflow", async (change) => {
    const old = snapshot();
    await db.query("update public.member_cases set status=$2,deadline=$3 where id=$1", [caseId, change === "resolved" ? "resolved" : "active", change === "extended" ? "2026-12-04" : "2026-12-01"]);
    await act();
    render(<LanguageProvider lang="en"><CaseArticlesEditor item={old} onUpdate={updateCase} /></LanguageProvider>);
    fireEvent.change(screen.getByRole("textbox", { name: "Contract articles" }), { target: { value: "Article B" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for change" }), { target: { value: "Correct reference" } });
    fireEvent.click(screen.getByRole("button", { name: "Save articles" }));
    await waitFor(() => expect(updateCase).toHaveBeenCalled()); await completion.catch(() => {});
    expect(await current()).toEqual({ status: change === "resolved" ? "resolved" : "active", deadline: change === "extended" ? "2026-12-04" : "2026-12-01", articles: "Article B" });
  });

  it("a deadline-only coordinator save preserves the newer article correction", async () => {
    const seed = structuredClone(fallbackData.coordinatorDesk);
    seed.cases = [{ ...seed.cases[0], ...snapshot() }];
    await db.query("update public.member_cases set articles='Article B' where id=$1", [caseId]); await act();
    const { container } = render(<LanguageProvider lang="en"><CoordinatorView data={{ member: { initials: "TC" } }} api={{ loadDesk: vi.fn(async () => structuredClone(seed)), updateCase }} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: caseListOpenerName(seed.cases[0]) }));
    const form = container.querySelector("form.gq-write__form");
    fireEvent.change(form.elements.namedItem("deadline"), { target: { value: "2026-12-02" } });
    fireEvent.change(form.elements.namedItem("reason"), { target: { value: "Extend deadline" } });
    fireEvent.submit(form);
    await waitFor(() => expect(updateCase).toHaveBeenCalled()); await completion.catch(() => {});
    expect(await current()).toEqual({ status: "active", deadline: "2026-12-02", articles: "Article B" });
  });
});
