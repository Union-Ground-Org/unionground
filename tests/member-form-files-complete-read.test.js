// BUG-UG-FORM-SIGNATURE-SIGNS-ANSWERS-THE-SIGNER-NEVER-SAW-20261113
// (#8702; a review note from the final on #8704). A form signature names
// the confirmed attachments on screen, and sign_member_form refuses one whose
// list differs from the stored files. The member load read only the oldest
// 1,000 attachment rows the account could see, so with more than that a newer
// file on the form being signed never appeared and every signature on it was
// refused. The load now reads every attachment of every form it shows.
import { expect, it } from "vitest";
import { fetchFormFilesFor, loadMemberApp } from "../src/lib/memberApi.js";

const SERVER_MAX_ROWS = 1000;

// Every builder call returns the proxy; awaiting it gives the canned result.
function chainable(result) {
  const proxy = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === "then") return (...args) => Promise.resolve(result).then(...args);
      return () => proxy;
    },
  });
  return proxy;
}

// member_form_files answers the way PostgREST does: in, the (created_at, id)
// keyset filter), order, range and limit are applied,
// and no response carries more than the server's row cap.
function formFilesTable(rows, reads) {
  const state = { forms: null, after: null, ascending: true, from: 0, to: Infinity, limit: Infinity };
  reads.push(state);
  const query = new Proxy({}, {
    get(_target, key) {
      if (key === "then") {
        const selected = rows
          .filter((row) => !state.forms || state.forms.includes(row.form_id))
          .filter((row) => !state.after || row.created_at > state.after.at || (row.created_at === state.after.at && row.id > state.after.id))
          .sort((a, b) => (state.ascending ? 1 : -1) * (a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)));
        const page = selected.slice(state.from, Math.min(state.to + 1, state.from + state.limit)).slice(0, SERVER_MAX_ROWS);
        return (...args) => Promise.resolve({ data: page, error: null }).then(...args);
      }
      if (key === "in") return (_column, values) => { state.forms = values; return query; };
      if (key === "or") return (filter) => {
        const [, at, id] = /^created_at\.gt\."([^"]+)",and\(created_at\.eq\."[^"]+",id\.gt\.([^)]+)\)$/u.exec(filter);
        state.after = { at, id };
        return query;
      };
      if (key === "order") return (column, options) => { if (column === "created_at") state.ascending = options?.ascending !== false; return query; };
      if (key === "range") return (from, to) => { state.from = from; state.to = to; return query; };
      if (key === "limit") return (n) => { state.limit = n; return query; };
      return () => query;
    },
  });
  return query;
}

const profile = {
  id: "user-1", first_name: "Darnell", full_name: "Darnell Foster", initials: "DF", role_line: "Member",
  member_since: 2023, language: "en", notification_prefs: { deadlines: true, cases: true, votes: true, events: true }, chapter_id: "wor",
};
const rpcs = {
  get_member_rewards_summary: { data: {}, error: null },
  get_workload_stats: { data: {}, error: null },
  list_chapter_task_assignees: { data: [], error: null },
  list_reward_peer_contact: { data: { available: true, canRequest: false, code: "UG-0123456789ABCDEF0123", incoming: [], outgoing: [], conversations: [] }, error: null },
  list_reward_experimental_content: { data: [], error: null },
};
const form = (id) => ({
  id, user_id: "user-1", template_key: "grievance", template_version: 1, status: "draft", answers: { summary: "Fictional" }, step: 1,
  review_note: null, submitted_at: null, updated_at: "2026-11-13T12:00:00Z", filer_signed_at: null, filer_signature_digest: null,
  content_digest: null, artifact_digest: null, artifact_approved_at: null, artifact_approved_by: null,
});
const file = (formId, index, minute) => ({
  id: `file-${formId}-${String(index).padStart(5, "0")}`, form_id: formId, bucket_id: "member-form-files",
  object_name: `${formId}/${index}.pdf`, filename: `${index}.pdf`, mime_type: "application/pdf", size_bytes: 10,
  confirmed_at: "2026-11-13T12:00:00Z", created_at: new Date(Date.UTC(2026, 0, 1) + minute * 60000).toISOString(),
});

function client({ forms, files, reads }) {
  return {
    from: (table) => {
      if (table === "member_form_files") return formFilesTable(files, reads);
      if (table === "member_forms") return chainable({ data: forms, error: null });
      if (table === "member_profiles") return chainable({ data: profile, error: null });
      if (table === "chapters") return chainable({ data: [{ id: "wor", name: "Cedar Ridge Care Services" }], error: null });
      return chainable({ data: [], error: null });
    },
    rpc: (name) => Promise.resolve(rpcs[name] ?? { data: null, error: { message: `no fake for rpc ${name}` } }),
  };
}

it("shows a newer attachment on the member's form even when the account can see more than 1,000 older ones", async () => {
  // 1,000 older attachments on forms this account can read but this load does
  // not show (a steward's review queue), then two on the member's own draft.
  const others = Array.from({ length: 1000 }, (_, i) => file(`other-${i % 40}`, i, i));
  const own = [file("form-own", 1, 2000), file("form-own", 2, 2001)];
  const reads = [];
  const loaded = await loadMemberApp(client({ forms: [form("form-own")], files: [...others, ...own], reads }), { id: "user-1", email: "review@example.invalid" });
  const shown = loaded.forms.find((row) => row.id === "form-own");
  expect(shown.files.map((row) => row.id)).toEqual(own.map((row) => row.id));
  expect(reads.every((read) => Array.isArray(read.forms))).toBe(true);
});

it("reads every attachment of a form past the server's row cap, page by page", async () => {
  const many = Array.from({ length: 1200 }, (_, i) => file("form-big", i, i));
  const reads = [];
  const result = await fetchFormFilesFor(client({ forms: [], files: many, reads }), [{ id: "form-big" }, { id: "form-big" }]);
  expect(result.error).toBeNull();
  expect(result.data).toHaveLength(1200);
  expect(new Set(result.data.map((row) => row.id)).size).toBe(1200);
  expect(reads.length).toBeGreaterThan(1);
});

it("asks for nothing when the load shows no forms, and fails as a whole when a page fails", async () => {
  const reads = [];
  expect(await fetchFormFilesFor(client({ forms: [], files: [], reads }), [])).toEqual({ data: [], error: null });
  expect(reads).toHaveLength(0);
  const failing = { from: () => chainable({ data: null, error: { message: "page failed" } }) };
  expect(await fetchFormFilesFor(failing, [{ id: "form-own" }])).toEqual({ data: null, error: { message: "page failed" } });
});
