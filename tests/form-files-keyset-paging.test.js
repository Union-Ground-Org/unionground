import { describe, expect, it } from "vitest";
import { fetchFormFilesFor } from "../src/lib/memberApi.js";

// a review note (2) and (3): the attachment rows of a member's forms are
// read completely, so the signature names every confirmed attachment on
// screen. (2) Pages follow (created_at, id), so a row deleted between two pages
// cannot shift a later row past the cut and drop it. (3) Chunks of 100 forms
// are read a few at a time instead of one after another. Unchanged from #8836:
// a failed chunk fails the whole read, and the rows keep their order.
const PAGE = 500;

// A small server over one table: it answers each query from its own calls
// (in, keyset or, order, offset range or limit), the way PostgREST would.
function server(rows, { hold = false, failChunkWith = null, afterPage = () => {} } = {}) {
  const table = rows.map((row) => ({ ...row }));
  const requests = [];
  const releases = [];
  const client = {
    from(name) {
      expect(name).toBe("member_form_files");
      const calls = [];
      const query = {
        select: () => query,
        in: (column, values) => { calls.push(["in", column, values]); return query; },
        or: (filter) => { calls.push(["or", filter]); return query; },
        order: () => query,
        range: (from, to) => { calls.push(["range", from, to]); return query; },
        limit: (count) => { calls.push(["limit", count]); return query; },
        then: (resolve, reject) => {
          const answer = () => {
            const ids = calls.find(([kind]) => kind === "in")[2];
            if (failChunkWith && ids.includes(failChunkWith)) return { data: null, error: { message: "chunk read failed" } };
            let matched = table.filter((row) => ids.includes(row.form_id))
              .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
            const keyset = calls.find(([kind]) => kind === "or")?.[1];
            if (keyset) {
              const [, at, id] = /^created_at\.gt\."([^"]+)",and\(created_at\.eq\."[^"]+",id\.gt\.([^)]+)\)$/u.exec(keyset);
              matched = matched.filter((row) => row.created_at > at || (row.created_at === at && row.id > id));
            }
            const range = calls.find(([kind]) => kind === "range");
            const limit = calls.find(([kind]) => kind === "limit")?.[1];
            const page = range ? matched.slice(range[1], range[2] + 1) : matched.slice(0, limit);
            afterPage(table, requests.length);
            return { data: page, error: null };
          };
          requests.push(calls);
          const run = () => Promise.resolve(answer()).then(resolve, reject);
          if (hold) releases.push(run);
          else run();
        },
      };
      return query;
    },
  };
  return { client, requests, release: () => { for (const run of releases.splice(0)) run(); } };
}

const stamp = (index) => `2026-11-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`;
const file = (formId, index) => ({ id: `f-${formId}-${String(index).padStart(5, "0")}`, form_id: formId, created_at: stamp(index) });

describe("reading every attachment of a member's forms", () => {
  it("keeps a row that a deletion between two pages would have pushed past the cut", async () => {
    const rows = Array.from({ length: PAGE + 1 }, (_, index) => file("form-a", index));
    // After the first page, another session deletes an attachment already read.
    const { client } = server(rows, { afterPage: (table, served) => { if (served === 1) table.splice(10, 1); } });
    const out = await fetchFormFilesFor(client, [{ id: "form-a" }]);
    expect(out.error).toBeNull();
    // The row after the cut is still read.
    expect(out.data.map((row) => row.id)).toContain(rows[PAGE].id);
    expect(out.data).toHaveLength(PAGE + 1);
  });

  it("reads several chunks of forms at once, and returns the rows in chunk order", async () => {
    const forms = Array.from({ length: 250 }, (_, index) => ({ id: `form-${String(index).padStart(3, "0")}` }));
    const rows = forms.map((form, index) => file(form.id, 250 - index));
    const { client, requests, release } = server(rows, { hold: true });
    const pending = fetchFormFilesFor(client, forms);
    await Promise.resolve();
    // Three chunks of up to 100 forms, all asked for before any answered.
    expect(requests).toHaveLength(3);
    release();
    const out = await pending;
    expect(out.data.map((row) => row.form_id)).toEqual([
      ...forms.slice(0, 100).map((form) => form.id).reverse(),
      ...forms.slice(100, 200).map((form) => form.id).reverse(),
      ...forms.slice(200).map((form) => form.id).reverse(),
    ]);
  });

  it("fails the whole read when one chunk fails, so every form is marked unavailable", async () => {
    const forms = Array.from({ length: 250 }, (_, index) => ({ id: `form-${String(index).padStart(3, "0")}` }));
    const { client } = server(forms.map((form, index) => file(form.id, index)), { failChunkWith: "form-150" });
    const out = await fetchFormFilesFor(client, forms);
    expect(out).toEqual({ data: null, error: { message: "chunk read failed" } });
  });

  it("answers an empty read with an empty list and reads nothing for no forms", async () => {
    const { client, requests } = server([]);
    expect(await fetchFormFilesFor(client, [{ id: "form-a" }])).toEqual({ data: [], error: null });
    expect(await fetchFormFilesFor(client, [])).toEqual({ data: [], error: null });
    expect(requests).toHaveLength(1);
  });

  // An answer that ignored the keyset filter would hand
  // back the first page again and again. The read fails at the first repeated
  // row instead of looping. (This fake stops after a few calls so the old loop
  // ends too: it returned the same 500 rows several times over.)
  it("fails the read when a page repeats rows already read, instead of looping", async () => {
    const rows = Array.from({ length: PAGE }, (_, index) => file("form-a", index));
    let calls = 0;
    const client = {
      from: () => {
        const query = {
          select: () => query, in: () => query, or: () => query, order: () => query, limit: () => query,
          then: (resolve) => { calls += 1; resolve({ data: calls > 4 ? [] : rows, error: null }); },
        };
        return query;
      },
    };
    const out = await fetchFormFilesFor(client, [{ id: "form-a" }]);
    expect(out).toEqual({ data: null, error: { message: "Form attachment pages did not advance" } });
    expect(calls).toBe(2);
  });

  // A chunk read that throws stops the other workers
  // from taking new chunks, as a chunk that returns an error does.
  it("stops reading further chunks once one chunk throws, and still rejects", async () => {
    const forms = Array.from({ length: 800 }, (_, index) => ({ id: `form-${String(index).padStart(3, "0")}` }));
    const asked = [];
    const client = {
      from: () => {
        let ids = [];
        const query = {
          select: () => query, or: () => query, order: () => query, limit: () => query,
          in: (_column, values) => { ids = values; return query; },
          then: (resolve, reject) => {
            asked.push(ids[0]);
            if (ids[0] === "form-000") reject(new Error("network down"));
            else Promise.resolve().then(() => resolve({ data: [], error: null }));
          },
        };
        return query;
      },
    };
    await expect(fetchFormFilesFor(client, forms)).rejects.toThrow("network down");
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    // Four chunks were in flight when the first threw; none after them started.
    expect(asked).toEqual(["form-000", "form-100", "form-200", "form-300"]);
  });
});
