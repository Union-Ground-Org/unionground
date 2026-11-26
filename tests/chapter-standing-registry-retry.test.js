import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemberSessionLoader } from "../src/lib/memberSessionLoader.js";

vi.mock("../src/lib/deferredObservability.js", async (importOriginal) => ({
  ...await importOriginal(),
  captureSanitizedDiagnostic: vi.fn(),
}));

const loaders = [];
afterEach(() => {
  for (const loader of loaders.splice(0)) loader.dispose();
});

const unavailable = { data: null, error: { code: "PGRST003", message: "pool temporarily unavailable" }, status: 503 };
const standing = { chapterId: "chapter-a", rank: 1, percentile: 90 };
const recovered = { data: standing, error: null, status: 200 };

function harness(readStanding, readOther = () => ({ data: null, error: null })) {
  const calls = [];
  const client = {
    from(table) {
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve, reject) => Promise.resolve({
          data: table === "member_profiles"
            ? { id: "member-a", first_name: "Member", full_name: "Member A", chapter_id: "chapter-a" } : [],
          error: null,
        }).then(resolve, reject);
        return () => query;
      } });
      return query;
    },
    async rpc(name) {
      calls.push(name);
      return name === "get_chapter_standing" ? readStanding() : readOther(name);
    },
  };
  const loader = createMemberSessionLoader(client, { id: "member-a" });
  loaders.push(loader);
  return { loader, count: (name = "get_chapter_standing") => calls.filter((call) => call === name).length };
}

describe("chapter-standing retries through the member resource registry", () => {
  it.each(["today", "numbers"])("recovers a transient backend failure on %s", async (route) => {
    const read = vi.fn().mockResolvedValueOnce(unavailable).mockResolvedValue(recovered);
    const h = harness(read);

    const projection = await h.loader.loadRoute(route);

    expect(h.count()).toBe(2);
    expect(projection.chapterStanding).toEqual(standing);
    expect(h.loader.inspect().get("rpc:get_chapter_standing").failure).toBeNull();
    expect(projection.resourceRefreshFailures).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ resource: "rpc:get_chapter_standing" }),
    ]));
  });

  it.each([429, 500, 503])("preserves HTTP %s for the retry classifier without a database code", async (status) => {
    const read = vi.fn().mockResolvedValueOnce({
      data: null, error: { code: "", message: "Request failed" }, status,
    }).mockResolvedValue(recovered);
    const h = harness(read);

    const projection = await h.loader.loadRoute("numbers");

    expect(h.count()).toBe(2);
    expect(projection.chapterStanding).toEqual(standing);
    expect(h.loader.inspect().get("rpc:get_chapter_standing").failure).toBeNull();
  });

  it("bounds a persistent failure to two requests per epoch across projection passes", async () => {
    const h = harness(() => unavailable);

    expect((await h.loader.loadRoute("numbers")).chapterStanding).toBeNull();
    expect((await h.loader.loadRoute("today")).chapterStanding).toBeNull();
    expect(h.count()).toBe(2);
    expect(h.loader.inspect().get("rpc:get_chapter_standing").failure).toEqual(unavailable.error);

    h.loader.invalidateResources(["rpc:get_chapter_standing"]);
    await h.loader.loadRoute("numbers");
    expect(h.count()).toBe(4);
  });

  it.each(["42501", "22023"])("keeps definitive %s refusals cached", async (code) => {
    const refusal = { data: null, error: { code, message: "request refused" }, status: 403 };
    const h = harness(() => refusal);

    await h.loader.loadRoute("numbers");
    await h.loader.loadRoute("today");

    expect(h.count()).toBe(1);
    expect(h.loader.inspect().get("rpc:get_chapter_standing").failure).toEqual(refusal.error);
  });

  it("leaves unrelated failed resources cached while standing recovers", async () => {
    const read = vi.fn().mockResolvedValueOnce(unavailable).mockResolvedValue(recovered);
    const h = harness(read, (name) => name === "get_workload_stats" ? unavailable : { data: null, error: null });

    await h.loader.loadRoute("numbers");
    await h.loader.loadRoute("numbers");

    expect(h.count()).toBe(2);
    expect(h.count("get_workload_stats")).toBe(1);
    expect(h.loader.inspect().get("rpc:get_workload_stats").failure).toEqual(unavailable.error);
  });

  it("joins a newer epoch instead of reissuing an old delayed retry", async () => {
    let firstReturned;
    const first = new Promise((resolve) => { firstReturned = resolve; });
    const read = vi.fn().mockImplementationOnce(() => {
      firstReturned();
      return unavailable;
    }).mockResolvedValue(recovered);
    const h = harness(read);
    const oldLoad = h.loader.loadRoute("numbers");
    await first;
    // Let the failed physical response settle and enter its delayed retry.
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.loader.invalidateResources(["rpc:get_chapter_standing"]);
    const newLoad = h.loader.loadRoute("numbers");

    const projections = await Promise.all([oldLoad, newLoad]);

    expect(h.count()).toBe(2);
    expect(projections.every((projection) => projection.chapterStanding?.rank === 1)).toBe(true);
    expect(h.loader.inspect().get("rpc:get_chapter_standing")).toMatchObject({ epoch: 1, failure: null });
  });
});
