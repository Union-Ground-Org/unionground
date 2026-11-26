// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  loadRecentTaskComments,
  TASK_COMMENT_LIMIT,
  TASK_COMMENT_PAGE,
} from "../src/lib/memberApi.js";

function row(index, createdAt = `2026-08-17T12:${String(index % 60).padStart(2, "0")}:00Z`) {
  return {
    id: `comment-${String(index).padStart(5, "0")}`,
    task_id: "task-1",
    chapter_id: "chapter-1",
    author_id: "member-1",
    body: `Update ${index}`,
    mentioned_user_ids: ["member-2"],
    created_at: createdAt,
  };
}

function clientFor(pages, calls = []) {
  let page = 0;
  return {
    from(table) {
      const call = { table, methods: [] };
      calls.push(call);
      const proxy = new Proxy(function () {}, {
        get(_target, prop) {
          if (prop === "then") {
            return (...args) => Promise.resolve(pages[Math.min(page++, pages.length - 1)]).then(...args);
          }
          return (...args) => {
            call.methods.push([prop, args]);
            return proxy;
          };
        },
      });
      return proxy;
    },
  };
}

function archiveClient(archive, calls = []) {
  return {
    from(table) {
      const call = { table, methods: [] };
      calls.push(call);
      const query = new Proxy({}, {
        get(_target, method) {
          if (method === "then") return (...args) => {
            let data = [...archive];
            const orders = [];
            let limit = Infinity;
            for (const [name, values] of call.methods) {
              if (name === "eq") data = data.filter((item) => item[values[0]] === values[1]);
              if (name === "order") orders.push(values);
              if (name === "limit") limit = values[0];
              if (name === "or") {
                const cursor = /^created_at\.lt\.([^,]+),and\(created_at\.eq\.\1,id\.lt\.([^)]+)\)$/.exec(values[0]);
                if (!cursor) throw new Error("unsupported task-comment keyset");
                data = data.filter((item) => item.created_at < cursor[1]
                  || (item.created_at === cursor[1] && item.id < cursor[2]));
              }
            }
            data.sort((left, right) => {
              for (const [key, options] of orders) {
                const direction = left[key] < right[key] ? -1 : left[key] > right[key] ? 1 : 0;
                if (direction) return options?.ascending === false ? -direction : direction;
              }
              return 0;
            });
            return Promise.resolve({ data: data.slice(0, limit), error: null }).then(...args);
          };
          return (...args) => { call.methods.push([method, args]); return query; };
        },
      });
      return query;
    },
  };
}

describe("loadRecentTaskComments", () => {
  it("pins its bounded page size to the configured Data API ceiling", () => {
    const config = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");
    const matches = [...config.matchAll(/^max_rows\s*=\s*(\d+)$/gm)];
    expect(matches).toHaveLength(1);
    const maxRows = Number(matches[0][1]);
    expect(Number.isSafeInteger(maxRows) && maxRows > 0).toBe(true);
    expect(TASK_COMMENT_LIMIT).toBe(2000);
    expect(TASK_COMMENT_PAGE).toBe(1000);
    expect(TASK_COMMENT_PAGE).toBeLessThanOrEqual(maxRows);
  });

  it("walks descending chapter-scoped keysets and uses one sentinel", async () => {
    const calls = [];
    const archive = Array.from({ length: 2001 }, (_, index) => row(3000 - index, "2026-08-17T12:00:00Z"));
    const first = archive.slice(0, 1000);
    const second = archive.slice(1000, 2000);
    const foreign = { ...row(5000), chapter_id: "chapter-2" };
    const result = await loadRecentTaskComments(archiveClient([foreign, ...archive], calls), "chapter-1");

    expect(result).toMatchObject({ error: null, truncated: true });
    expect(result.data).toHaveLength(2000);
    expect(result.data.map((item) => item.id)).toEqual(archive.slice(0, 2000).map((item) => item.id));
    expect(new Set(result.data.map((item) => item.id)).size).toBe(2000);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.table).toBe("chapter_task_comments");
      expect(call.methods).toContainEqual(["eq", ["chapter_id", "chapter-1"]]);
      expect(call.methods).toContainEqual(["order", ["created_at", { ascending: false }]]);
      expect(call.methods).toContainEqual(["order", ["id", { ascending: false }]]);
      expect(call.methods.some(([name]) => name === "gte" || name === "range")).toBe(false);
    }
    expect(calls[0].methods.at(-1)).toEqual(["limit", [1000]]);
    expect(calls[1].methods).toContainEqual(["or", [
      `created_at.lt.${first.at(-1).created_at},and(created_at.eq.${first.at(-1).created_at},id.lt.${first.at(-1).id})`,
    ]]);
    expect(calls[2].methods.at(-1)).toEqual(["limit", [1]]);
    expect(calls[2].methods).toContainEqual(["or", [
      `created_at.lt.${second.at(-1).created_at},and(created_at.eq.${second.at(-1).created_at},id.lt.${second.at(-1).id})`,
    ]]);
  });

  it.each([
    [2000, 3],
    [1004, 2],
  ])("reports a complete archive of %i comments after %i requests", async (count, requests) => {
    const archive = Array.from({ length: count }, (_, index) => row(4000 - index, "2026-08-17T12:00:00Z"));
    const calls = [];
    const result = await loadRecentTaskComments(archiveClient(archive, calls), "chapter-1");
    expect(result.truncated).toBe(false);
    expect(result.error).toBeNull();
    expect(result.data.map((item) => item.id)).toEqual(archive.map((item) => item.id));
    expect(calls).toHaveLength(requests);
  });

  it("preserves confirmed rows but never invents completeness after errors", async () => {
    const error = { message: "network" };
    const firstFailure = await loadRecentTaskComments(clientFor([{ data: null, error }]), "chapter-1");
    expect(firstFailure).toEqual({ data: [], error, truncated: false });

    const confirmed = Array.from({ length: 1000 }, (_, index) => row(2000 - index));
    const laterFailure = await loadRecentTaskComments(clientFor([
      { data: confirmed, error: null },
      { data: null, error },
    ]), "chapter-1");
    expect(laterFailure.data).toHaveLength(1000);
    expect(laterFailure).toMatchObject({ error, truncated: false });
  });

  it("returns an honest empty success and rejects a blank chapter", async () => {
    expect(await loadRecentTaskComments(clientFor([{ data: [], error: null }]), "chapter-1"))
      .toEqual({ data: [], error: null, truncated: false });
    const blank = await loadRecentTaskComments(clientFor([]), " ");
    expect(blank.data).toEqual([]);
    expect(blank.error).toBeInstanceOf(Error);
    expect(blank.truncated).toBe(false);
  });

  it("preserves equal-timestamp descending id order and mapped source fields", async () => {
    const createdAt = "2026-08-17T12:00:00Z";
    const result = await loadRecentTaskComments(clientFor([{
      data: [row(3, createdAt), row(2, createdAt), row(1, createdAt)],
      error: null,
    }]), "chapter-1");
    expect(result.data.map((item) => item.id)).toEqual(["comment-00003", "comment-00002", "comment-00001"]);
    expect(result.data[0]).toMatchObject({
      task_id: "task-1",
      chapter_id: "chapter-1",
      author_id: "member-1",
      body: "Update 3",
      mentioned_user_ids: ["member-2"],
      created_at: createdAt,
    });
  });
});
