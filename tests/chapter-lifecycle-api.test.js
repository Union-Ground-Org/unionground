// @vitest-environment node
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  grantMemberChapterMembership,
  loadChapterLifecycleAdmin,
  loadMemberChapterMemberships,
  searchUnionOrganizations,
  requestChapterConnectionSetup,
  requestChapterUnionOrgBinding,
  revokeMemberChapterMembership,
  setMemberChapterRole,
  shareChapterHandshakeDocument,
  switchMyChapter,
  verifyChapterConnectionSetup,
  verifyChapterUnionOrgBinding,
} from "../src/lib/chapterLifecycleApi.js";
import { migrationFiles, stripComments } from "./helpers/migration.js";

describe("chapter lifecycle API", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("maps every authenticated lifecycle RPC with the exact migration argument names", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { accepted: true }, error: null });
    const client = { rpc };
    await requestChapterUnionOrgBinding(client, " org-1 ");
    await shareChapterHandshakeDocument(client, "handshake-1", "document-1", "key-1");
    await requestChapterConnectionSetup(client, "sms", " Chapter sender ");
    await grantMemberChapterMembership(client, "user-1", "chapter-2");
    await revokeMemberChapterMembership(client, "user-1", "chapter-2");
    await setMemberChapterRole(client, "user-1", "chapter-2", "steward", true);
    expect(rpc.mock.calls).toEqual([
      ["request_chapter_union_org_binding", { p_union_org_id: "org-1" }],
      ["share_chapter_handshake_document", { p_handshake_id: "handshake-1", p_document_id: "document-1", p_idempotency_key: "key-1" }],
      ["request_chapter_connection_setup", { p_capability: "sms", p_provider_label: "Chapter sender" }],
      ["grant_member_chapter_membership", { p_user_id: "user-1", p_chapter_id: "chapter-2" }],
      ["revoke_member_chapter_membership", { p_user_id: "user-1", p_chapter_id: "chapter-2" }],
      ["set_member_chapter_role", { p_user_id: "user-1", p_chapter_id: "chapter-2", p_role: "steward", p_enabled: true }],
    ]);
  });

  it("routes service-role verification through the same-origin server boundary", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ result: { verified: true } }),
    });
    const session = { access_token: "member-token" };
    await verifyChapterUnionOrgBinding(session, {
      chapterId: "wor", unionOrgId: "org-1", verified: true, publicNote: "Reviewed",
    });
    await verifyChapterConnectionSetup(session, {
      chapterId: "wor", capability: "sms", status: "active", publicMessage: "Ready",
    });
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/chapter-lifecycle-verification", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer member-token" }),
      body: JSON.stringify({ action: "verify-binding", chapterId: "wor", unionOrgId: "org-1", verified: true, publicNote: "Reviewed" }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/chapter-lifecycle-verification", expect.objectContaining({
      body: JSON.stringify({ action: "verify-connection", chapterId: "wor", capability: "sms", status: "active", publicMessage: "Ready" }),
    }));
  });

  it("reads the selected chapter's lifecycle state without inventing another chapter's rows", async () => {
    const binding = { chapter_id: "wor", union_org_id: "selected-union", status: "requested" };
    const connection = { chapter_id: "wor", capability: "sms", status: "requested" };
    const document = { id: "selected-document", chapter_id: "wor", status: "published", updated_at: "2026-10-19" };
    const health = { id: "selected-health", chapter_id: "wor", measured_on: "2026-10-19", score: 74 };
    // Both chapters are accessible to this account. A query without a chapter
    // filter must return their rows, so a prefiltered mock cannot hide a lost
    // scope fence. The other binding is first and its health snapshot is newer.
    const tables = {
      chapter_union_org_bindings: [{ chapter_id: "bos", union_org_id: "other-union", status: "verified" }, binding],
      chapter_connection_readiness: [{ chapter_id: "bos", capability: "email", status: "active" }, connection],
      chapter_documents: [
        { id: "other-document", chapter_id: "bos", status: "published", updated_at: "2026-10-20" },
        { id: "selected-draft", chapter_id: "wor", status: "draft", updated_at: "2026-10-20" },
        document,
      ],
      chapter_health_snapshots: [
        { id: "other-health", chapter_id: "bos", measured_on: "2026-10-20", score: 99 },
        { id: "selected-old-health", chapter_id: "wor", measured_on: "2026-10-18", score: 60 },
        health,
      ],
    };
    const table = (name) => {
      const filters = [];
      let ordering;
      let limit = Infinity;
      const builder = {
        select: () => builder,
        eq: (column, value) => { filters.push([column, value]); return builder; },
        order: (column, { ascending = true } = {}) => { ordering = { column, ascending }; return builder; },
        limit: (value) => { limit = value; return builder; },
        then: (resolve, reject) => {
          const rows = (tables[name] ?? []).filter((row) => filters.every(([column, value]) => row[column] === value));
          if (ordering) {
            const { column, ascending } = ordering;
            rows.sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (ascending ? 1 : -1));
          }
          return Promise.resolve({ data: rows.slice(0, limit), error: null }).then(resolve, reject);
        },
      };
      return builder;
    };
    const seen = [];
    const client = {
      rpc: vi.fn().mockResolvedValue({
        data: [
          { chapterId: "bos", selected: false },
          { chapterId: "wor", selected: true },
        ],
        error: null,
      }),
      from: vi.fn((name) => {
        seen.push(name);
        return table(name);
      }),
    };
    const state = await loadChapterLifecycleAdmin(client);
    expect(client.rpc).toHaveBeenCalledWith("get_my_chapter_memberships");
    expect(state.chapterId).toBe("wor");
    expect(state.binding).toEqual(binding);
    expect(state.latestHealth).toEqual(health);
    expect(state.connections).toEqual([connection]);
    expect(state.documents).toEqual([document]);
    expect(seen).toEqual([
      "chapter_union_org_bindings",
      "chapter_connection_readiness",
      "chapter_handshakes",
      "chapter_documents",
      "chapter_handshake_events",
      "chapter_handshake_documents",
      "chapter_health_snapshots",
    ]);
  });

  it("returns empty lifecycle state rather than guessing when no chapter is selected", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: [{ chapterId: "wor", selected: false }], error: null }), from: vi.fn() };
    const state = await loadChapterLifecycleAdmin(client);
    expect(state).toEqual({
      chapterId: null, chapterName: null, memberships: [{ chapterId: "wor", name: "wor", selected: false }],
      binding: null, connections: [], handshakes: [],
      documents: [], events: [], sharedDocuments: [], latestHealth: null,
    });
    expect(client.from).not.toHaveBeenCalled();
  });

  // BUG-UG-WEB-ADMIN-HANDSHAKE-IGNORES-RAIL-CHAPTER-20261002: the
  // loader stays on the server's selection and hands the page the account's
  // own memberships to reconcile against the rail; it takes no rail input.
  it("names the server-selected chapter and lists only the account's own memberships", async () => {
    const table = () => {
      const builder = { select: () => builder, eq: () => builder, order: () => builder, limit: () => builder,
        then: (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject) };
      return builder;
    };
    const eqs = [];
    const client = {
      rpc: vi.fn().mockResolvedValue({ data: [
        { chapterId: "bos", name: "Harborview Care Boston", selected: false },
        { chapterId: "wor", name: "Harborview Care United", selected: true },
      ], error: null }),
      from: vi.fn((name) => { const builder = table(); const eq = builder.eq; builder.eq = (column, value) => { eqs.push([name, column, value]); return eq(); }; return builder; }),
    };
    expect(loadChapterLifecycleAdmin.length).toBe(1);
    const state = await loadChapterLifecycleAdmin(client);
    expect(state.chapterId).toBe("wor");
    expect(state.chapterName).toBe("Harborview Care United");
    expect(state.memberships).toEqual([
      { chapterId: "bos", name: "Harborview Care Boston", selected: false },
      { chapterId: "wor", name: "Harborview Care United", selected: true },
    ]);
    expect(eqs.filter(([, column]) => column === "chapter_id")).toEqual([
      ["chapter_union_org_bindings", "chapter_id", "wor"],
      ["chapter_connection_readiness", "chapter_id", "wor"],
      ["chapter_documents", "chapter_id", "wor"],
      ["chapter_health_snapshots", "chapter_id", "wor"],
    ]);
  });

  it("treats a chapterless admin's organization-level row as no chapter membership", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: [{ chapterId: null, selected: true, organizationId: "org-1" }], error: null }), from: vi.fn() };
    const state = await loadChapterLifecycleAdmin(client);
    expect(state.chapterId).toBeNull();
    expect(state.memberships).toEqual([]);
    expect(client.from).not.toHaveBeenCalled();
  });

  it("switches the selected chapter only through switch_my_chapter and surfaces a cross-tenant refusal", async () => {
    const ok = { rpc: vi.fn().mockResolvedValue({ data: { chapterId: "bos" }, error: null }) };
    await switchMyChapter(ok, " bos ");
    expect(ok.rpc).toHaveBeenCalledWith("switch_my_chapter", { p_chapter_id: "bos" });
    const refused = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "foreign chapter switching denied", code: "42501" } }) };
    await expect(switchMyChapter(refused, "other-org-chapter")).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses to search organizations on a needle too short to be a real query", async () => {
    const from = vi.fn();
    expect(await searchUnionOrganizations({ from }, " s ")).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });

  it("shares local-number and safely quoted name/city/affiliation search with discovery", async () => {
    const builder = {
      select: vi.fn().mockReturnThis(), or: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(), range: vi.fn().mockResolvedValue({ data: [{ id: "olms-900100", name: "Tamarack Public Service Union", local_number: "100" }], error: null }),
    };
    const client = { from: vi.fn().mockReturnValue(builder) };
    const rows = await searchUnionOrganizations(client, "Tamarack Local 100");
    expect(rows[0].local_number).toBe("100");
    expect(builder.or).toHaveBeenCalledWith('local_number.eq."100",name.ilike."%Tamarack Local 100%"');
    expect(builder.or).toHaveBeenCalledWith('name.ilike."%Tamarack%",city.ilike."%Tamarack%",affiliation.ilike."%Tamarack%"');
    expect(builder.range).toHaveBeenCalledWith(0, 19);
    builder.or.mockClear();
    await searchUnionOrganizations(client, '50% _x*,(id.neq.0)');
    const filter = builder.or.mock.calls[0][0];
    expect(filter).toContain('name.ilike.');
    expect(filter).toContain('city.ilike.');
    expect(filter).toContain('affiliation.ilike.');
    expect(filter).not.toContain('*');
    // Quotes keep the comma and predicate-looking text inside each literal.
    expect(filter.split('"')).toHaveLength(7);
    expect(filter).toContain('\\\\%');
    expect(filter).toContain('\\\\_');
  });

  it("reads a member's exact chapters through the admin RPC and keeps only well-formed rows", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {
      userId: "user-1",
      scope: "organization",
      chapters: [
        { chapterId: "wor", home: true, lastChapter: false, roles: ["admin", 7] },
        { chapterId: "bos", home: false, lastChapter: false, roles: null },
        { chapterId: "" },
        null,
      ],
    }, error: null });
    expect(await loadMemberChapterMemberships({ rpc }, "user-1")).toEqual({
      userId: "user-1",
      complete: true,
      chapters: [
        { chapterId: "wor", home: true, lastChapter: false, roles: ["admin"] },
        { chapterId: "bos", home: false, lastChapter: false, roles: [] },
      ],
    });
    expect(rpc).toHaveBeenCalledWith("get_member_chapter_memberships_for_admin", { p_user_id: "user-1" });

    // A chapter Admin's answer covers their selected chapter only.
    rpc.mockResolvedValueOnce({ data: { scope: "chapter", chapters: [{ chapterId: "wor", lastChapter: true }] }, error: null });
    expect(await loadMemberChapterMemberships({ rpc }, "user-2")).toEqual({
      userId: "user-2",
      complete: false,
      chapters: [{ chapterId: "wor", home: false, lastChapter: true, roles: [] }],
    });

    rpc.mockResolvedValueOnce({ data: { scope: "organization" }, error: null });
    await expect(loadMemberChapterMemberships({ rpc }, "user-1")).rejects.toThrow("Member chapter memberships: invalid response");
    rpc.mockResolvedValueOnce({ data: null, error: { message: "admin role required", code: "42501" } });
    await expect(loadMemberChapterMemberships({ rpc }, "user-1")).rejects.toMatchObject({ code: "42501" });
  });

  it("surfaces the refusal code instead of a silent success", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "admin role required", code: "42501" } }) };
    await expect(requestChapterUnionOrgBinding(client, "tamarack-psu")).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses a session without an access token before any network call", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    await expect(verifyChapterUnionOrgBinding(null, { chapterId: "wor", unionOrgId: "tamarack-psu", verified: true }))
      .rejects.toThrow("session-expired");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("propagates the server refusal reason from the verification boundary", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      json: vi.fn().mockResolvedValue({ error: "not-permitted" }),
    });
    await expect(verifyChapterConnectionSetup({ access_token: "t" }, {
      chapterId: "wor", capability: "sms", status: "active",
    })).rejects.toThrow("not-permitted");
  });
});

// BUG-UG-WEB-CHAPTER-LIFECYCLE-QUERIES-MISSING-COLUMN-20261003: the
// loader asked chapter_connection_readiness for requested_at, a column the
// table never had, so every load failed with 42703. Every column the loader
// selects must exist in the table as the migrations leave it.
function migratedColumns(table) {
  const name = table.replace(/^public\./, "");
  const qualified = `(?:public\\.)?${name}`;
  let columns = null;
  for (const { sql } of migrationFiles()) {
    const code = stripComments(sql);
    for (const match of code.matchAll(new RegExp(`\\b(create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${qualified}\\s*\\(|drop\\s+table\\s+(?:if\\s+exists\\s+)?${qualified}\\b|alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${qualified}\\s+([^;]*);)`, "gi"))) {
      if (/^create/i.test(match[1])) {
        let depth = 1;
        let index = match.index + match[0].length;
        const start = index;
        for (; index < code.length && depth > 0; index += 1) {
          if (code[index] === "(") depth += 1;
          else if (code[index] === ")") depth -= 1;
        }
        const body = code.slice(start, index - 1);
        const items = [];
        let level = 0;
        let item = "";
        for (const char of body) {
          if (char === "(") level += 1;
          if (char === ")") level -= 1;
          if (char === "," && level === 0) { items.push(item); item = ""; } else item += char;
        }
        items.push(item);
        columns = new Set(items.map((entry) => entry.trim())
          .filter((entry) => entry && !/^(constraint|primary|unique|check|foreign|exclude|like)\b/i.test(entry))
          .map((entry) => entry.split(/\s+/)[0].replace(/"/g, "").toLowerCase()));
      } else if (/^drop/i.test(match[1])) {
        columns = null;
      } else if (columns) {
        for (const clause of match[2].split(/,(?![^(]*\))/)) {
          const add = clause.match(/^\s*add\s+column\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?/i);
          const drop = clause.match(/^\s*drop\s+column\s+(?:if\s+exists\s+)?"?(\w+)"?/i);
          const rename = clause.match(/^\s*rename\s+column\s+"?(\w+)"?\s+to\s+"?(\w+)"?/i);
          if (add) columns.add(add[1].toLowerCase());
          if (drop) columns.delete(drop[1].toLowerCase());
          if (rename) { columns.delete(rename[1].toLowerCase()); columns.add(rename[2].toLowerCase()); }
        }
      }
    }
  }
  return columns;
}

describe("chapter lifecycle loader columns", () => {
  const source = readFileSync(new URL("../src/lib/chapterLifecycleApi.js", import.meta.url), "utf8");
  const loader = source.slice(source.indexOf("export async function loadChapterLifecycleAdmin"));
  const reads = [...loader.slice(0, loader.indexOf("\n}\n")).matchAll(/client\.from\("(\w+)"\)\s*\.select\("([^"]+)"\)/g)]
    .map(([, table, select]) => ({ table, columns: select.split(/,(?![^(]*\))/).map((column) => column.trim()).filter((column) => !column.includes("(")) }));

  it("reads every lifecycle table the page needs", () => {
    expect(reads.map((read) => read.table)).toEqual([
      "chapter_union_org_bindings", "chapter_connection_readiness", "chapter_handshakes", "chapter_documents",
      "chapter_handshake_events", "chapter_handshake_documents", "chapter_health_snapshots",
    ]);
  });

  it("selects only columns that exist in the migrated table definitions", () => {
    const missing = [];
    for (const { table, columns } of reads) {
      const defined = migratedColumns(table);
      expect(defined, table).not.toBeNull();
      for (const column of columns) if (!defined.has(column)) missing.push(`${table}.${column}`);
    }
    expect(missing).toEqual([]);
    expect(migratedColumns("chapter_connection_readiness")).toContain("requested_by");
    expect(migratedColumns("chapter_connection_readiness")).not.toContain("requested_at");
  });
});
