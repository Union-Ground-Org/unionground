import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { deriveWeekDays, MemberApiError } from "../src/lib/memberApi.js";
import { VerifyReceiptView } from "../src/views/VerifyReceiptView.jsx";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

const stubs = vi.hoisted(() => ({
  verifyBallotReceipt: vi.fn(),
  captureSanitizedDiagnostic: vi.fn(() => true),
  hasAppBackend: true,
}));

vi.mock("../src/lib/supabase.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    get hasAppBackend() {
      return stubs.hasAppBackend;
    },
  };
});

vi.mock("../src/lib/memberApi.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, verifyBallotReceipt: stubs.verifyBallotReceipt };
});

vi.mock("../src/lib/deferredObservability.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, captureSanitizedDiagnostic: stubs.captureSanitizedDiagnostic };
});

const sql = loadMigrationSql("member_rewards_and_ballot_receipts");
// The ballot-secrecy migration (20260808230000, UB-VOTE-04) retired part of
// this machinery: the votes-table receipt trigger and its function are
// DROPPED, and issuance moved into the callable private.issue_ballot_receipt.
// The pins over `sql` below keep passing because they read the ORIGINAL
// 20260721223851 file, whose text never changes — where a pin now documents
// history rather than the live catalog, it says so inline.
const secrecy = loadMigrationSql("ballot_secrecy_unlinkable_votes");
const issueReceipt = fnBody(secrecy, "private.issue_ballot_receipt(p_ballot_id text, p_user_id uuid)");

describe("rewards and receipts migration invariants", () => {
  it("keeps point and receipt writes server-side only", () => {
    for (const table of ["member_point_rules", "member_reward_tiers", "member_point_events", "member_ballot_receipts"]) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toContain(`revoke all on public.${table} from anon, authenticated`);
      expect(sql).toContain(`grant select on public.${table} to authenticated`);
      expect(sql, `${table} must not be client-writable`).not.toMatch(
        new RegExp(`grant [^;]*(insert|update|delete)[^;]*on public\\.${table}[^;]*to (anon|authenticated)`, "i"),
      );
    }
    expect(sql).toContain("create trigger member_action_log_award_points");
    // HISTORY, not the live catalog: this trigger was created by the original
    // file (pinned here) and DROPPED by 20260808230000 — the drop is pinned in
    // the ballot-secrecy handover block below.
    expect(sql).toContain("create trigger member_ballot_votes_issue_receipt");
    expect(sql).toMatch(/security definer[\s\S]*award_member_points|award_member_points[\s\S]*security definer/);
  });

  it("scopes the receipt verify path to code-only lookups and grants it to anon", () => {
    expect(sql).toContain("grant execute on function public.verify_ballot_receipt(text) to anon, authenticated");
    const verifyBody = fnBody(sql, "public.verify_ballot_receipt");
    expect(verifyBody).not.toContain("user_id");
    expect(verifyBody).not.toContain("option");
  });

  it("keeps per-option tallies closed until the ballot closes", () => {
    // The original file's tally (pinned here for its closed-until-closed
    // shape) was re-created by 20260808230000 to aggregate the anonymous
    // choice store; the successor keeps the same active gate, pinned below.
    const tallyBody = sql.slice(sql.indexOf("create function public.get_ballot_tally"), sql.indexOf("create function public.verify_ballot_receipt"));
    expect(tallyBody).toContain("if not ballot.active then");
    expect(sql).toContain("add column quorum_target integer check (quorum_target is null or quorum_target > 0)");
  });
});

describe("ballot-secrecy handover (20260808230000)", () => {
  it("drops the votes-table receipt trigger and its trigger function", () => {
    expect(secrecy).toContain("drop trigger member_ballot_votes_issue_receipt on public.member_ballot_votes;");
    expect(secrecy).toContain("drop function if exists private.issue_member_ballot_receipt();");
  });

  it("re-homes issuance as insert-or-nothing with the receipt code returned", () => {
    // null return = this (ballot, member) pair already holds a receipt; the
    // caller must treat that as "already voted", never as a fresh vote.
    expect(secrecy).toContain("create function private.issue_ballot_receipt(p_ballot_id text, p_user_id uuid)");
    expect(issueReceipt).toContain("on conflict (ballot_id, user_id) do nothing");
    expect(issueReceipt).toContain("returning receipt_code into issued");
    expect(issueReceipt).toContain("security definer");
    expect(issueReceipt).toContain("set search_path = ''");
  });

  it("retries only on a receipt_code collision, bounded", () => {
    // The pair conflict is absorbed by ON CONFLICT, so only a code collision
    // can reach the handler — and it may not loop forever.
    expect(issueReceipt).toContain("exception when unique_violation then");
    expect(issueReceipt).toContain("if attempts >= 3 then");
  });

  it("keeps the new issuer off the client surface", () => {
    // service_role included: PostgREST must not expose it either — issuance is
    // reachable only through the definer callers (submit_ballot_vote, the
    // stress harness, the backfill DO block).
    expect(secrecy).toContain("revoke all on function private.issue_ballot_receipt(text, uuid) from public, anon, authenticated, service_role;");
  });

  it("documents the 20260808230000 tally generation (superseded; history only)", () => {
    // Historical pin on what THAT FILE said, which never changes: the secrecy
    // wave's first tally gated the breakdown on the inactive flag and still
    // counted receipts. Both were superseded — 20260808235000 moved totals to
    // choices, and 20260809010000 publishes at closes_at too (UB-VOTE-02).
    // The CURRENT generation is pinned by tests/ballot-secrecy.test.js's
    // newest-migration scan and tests/ballot-eligibility-results.test.js.
    const tallyBody = fnBody(secrecy, "public.get_ballot_tally(p_ballot_id text)");
    expect(tallyBody).toContain("if not ballot.active then");
    expect(tallyBody).toContain("from public.member_ballot_receipts");
    expect(tallyBody).toContain("left join public.member_ballot_choices as choices");
  });
});

describe("deriveWeekDays", () => {
  const wednesday = new Date("2026-07-22T15:00:00");

  it("marks days with actions active and flags today", () => {
    const days = deriveWeekDays(
      [{ occurred_at: "2026-07-21T09:00:00" }, { occurred_at: "2026-07-22T10:00:00" }],
      wednesday,
    );
    expect(days).toHaveLength(7);
    expect(days.map((day) => day.label).join("")).toBe("MTWTFSS");
    expect(days[0].active).toBe(false);
    expect(days[1].active).toBe(true);
    expect(days[2].active).toBe(true);
    expect(days[2].today).toBe(true);
    expect(days[3].today).toBe(false);
  });

  it("handles an empty week", () => {
    const days = deriveWeekDays([], wednesday);
    expect(days.every((day) => !day.active)).toBe(true);
    expect(days.filter((day) => day.today)).toHaveLength(1);
  });
});

describe("VerifyReceiptView", () => {
  afterEach(() => {
    window.localStorage.removeItem("sg-lang");
    stubs.hasAppBackend = true;
    stubs.verifyBallotReceipt.mockReset();
    stubs.captureSanitizedDiagnostic.mockReset();
    stubs.captureSanitizedDiagnostic.mockImplementation(() => true);
  });

  it.each([
    ["en", ["Anyone with a receipt code", "without signing in", "ballot title", "whether the receipt was counted", "when it was issued", "never your choice", "confirmation shown just after voting"]],
    ["es", ["Cualquier persona con un código", "sin iniciar sesión", "título de la votación", "si el comprobante fue contado", "cuándo se emitió", "nunca tu elección", "confirmación que aparece justo después de votar"]],
  ])("explains public code access and where to find the code before a lookup (%s)", (lang, facts) => {
    window.localStorage.setItem("sg-lang", lang);
    render(<VerifyReceiptView />);
    for (const fact of facts) expect(screen.getByText((text) => text.includes(fact))).toBeInTheDocument();
    expect(stubs.verifyBallotReceipt).not.toHaveBeenCalled();
  });

  it("renders the public verify form without a session", () => {
    render(<VerifyReceiptView />);
    expect(screen.getByRole("heading", { name: /verify a vote receipt/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/receipt code/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /verify receipt/i })).toBeDisabled();
  });

  it("shows the English catalogue sentence when verifyBallotReceipt rejects", async () => {
    await submitRejectedLookup("en");
    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert).toHaveClass("vrx-error");
    expect(alert).toHaveTextContent("Receipt lookup failed.");
    expect(alert.textContent).not.toMatch(/JWT/);
    expect(alert.textContent).not.toMatch(/Verify receipt/);
    expect(alert.textContent).not.toMatch(/PGRST301/);
    expectSanitizedLookupDiagnostic();
  });

  it("shows the Spanish catalogue sentence when verifyBallotReceipt rejects", async () => {
    await submitRejectedLookup("es");
    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert).toHaveClass("vrx-error");
    expect(alert).toHaveTextContent("La búsqueda del comprobante falló.");
    expect(alert.textContent).not.toMatch(/JWT/);
    expect(alert.textContent).not.toMatch(/Verify receipt/);
    expect(alert.textContent).not.toMatch(/PGRST301/);
    expect(document.body.textContent).not.toMatch(/Verify receipt/);
    expect(document.body.textContent).not.toMatch(/JWT expired/);
    expectSanitizedLookupDiagnostic();
  });

  it("shows the catalogue not-connected notice when the backend is unconfigured", async () => {
    stubs.hasAppBackend = false;
    window.localStorage.setItem("sg-lang", "en");
    render(<VerifyReceiptView />);
    fireEvent.change(screen.getByLabelText("Receipt code"), {
      target: { value: "SG-TESTCODE-TESTCODE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify receipt" }));
    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert).toHaveClass("vrx-error");
    expect(alert).toHaveTextContent("Receipt verification is not connected in this environment.");
    expect(stubs.verifyBallotReceipt).not.toHaveBeenCalled();
    expect(stubs.captureSanitizedDiagnostic).not.toHaveBeenCalled();
  });
});

function rejectedLookupError() {
  return new MemberApiError("Verify receipt", { message: "JWT expired", code: "PGRST301" });
}

async function submitRejectedLookup(lang) {
  window.localStorage.setItem("sg-lang", lang);
  stubs.verifyBallotReceipt.mockRejectedValueOnce(rejectedLookupError());
  render(<VerifyReceiptView />);
  const label = lang === "es" ? "Código de comprobante" : "Receipt code";
  const submit = lang === "es" ? "Verificar comprobante" : "Verify receipt";
  fireEvent.change(screen.getByLabelText(label), { target: { value: "SG-TESTCODE-TESTCODE" } });
  fireEvent.click(screen.getByRole("button", { name: submit }));
}

function expectSanitizedLookupDiagnostic() {
  expect(stubs.captureSanitizedDiagnostic).toHaveBeenCalledTimes(1);
  const payload = stubs.captureSanitizedDiagnostic.mock.calls[0][0];
  expect(payload).toEqual({
    kind: "verify_receipt_lookup_failed",
    code: "PGRST301",
    name: "MemberApiError",
  });
  expect(payload).not.toHaveProperty("message");
  expect(JSON.stringify(payload)).not.toMatch(/JWT|Verify receipt/);
}
