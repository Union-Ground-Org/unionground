import { describe, expect, it, vi } from "vitest";
import { loadNoticeAudiences, publishNoticeAudience, publishNoticeForAudience, NOTICE_AUDIENCE_UNAVAILABLE } from "../src/lib/noticeAudience.js";

const unitId = "11111111-1111-4111-8111-111111111111";
const unitScope = { role: "steward", unitId, committeeId: null, name: "Unit A", notices: true };
const context = { chapterId: "chapter-a", role: "steward", canPostOrganization: true };
function backend(office = {}) {
  const rpc = vi.fn(async (name) => name === "get_chapter_office_access"
    ? { data: { chapterId: "chapter-a", notices: true, unscopedNotices: false, scopes: [unitScope], ...office }, error: null }
    : { data: { broadcastId: "notice-a" }, error: null });
  return { rpc, from: vi.fn(() => { throw new Error("No unit-membership or organization lookup is needed"); }) };
}

describe("notice audiences from current grants", () => {
  it("uses the steward grant, not membership in another unit or an organization steward grant", async () => {
    const client = backend({ organizationRoles: ["steward"], memberUnits: ["unit-b"] });
    const choices = await loadNoticeAudiences(client, context);
    expect(choices).toEqual([{ value: `unit:${unitId}`, kind: "unit", chapterId: "chapter-a", unitId, name: "Unit A" }]);
    expect(client.from).not.toHaveBeenCalled();
    await publishNoticeForAudience(client, " Unit meeting ", " Unit A only ", "es", "chapter", context);
    expect(client.rpc).toHaveBeenLastCalledWith("publish_chapter_office_notice", {
      p_chapter: "chapter-a", p_title: "Unit meeting", p_body: "Unit A only", p_locale: "es", p_unit: unitId, p_committee: null,
      p_idempotency_key: expect.any(String),
    });
    expect(client.rpc).not.toHaveBeenCalledWith("publish_member_broadcast", expect.anything());
  });

  it.each(["admin", "vp"])("preserves chapter and organization audiences for an authorized %s", async (role) => {
    const client = backend({ unscopedNotices: true, scopes: [] });
    const leader = { ...context, role };
    expect((await loadNoticeAudiences(client, leader)).map((item) => item.value)).toEqual(["chapter", "organization"]);
    await publishNoticeForAudience(client, "Meeting", "Chapter notice", "en", "chapter", leader);
    expect(client.rpc).toHaveBeenLastCalledWith("publish_chapter_office_notice", {
      p_chapter: "chapter-a", p_title: "Meeting", p_body: "Chapter notice", p_locale: "en", p_unit: null, p_committee: null,
      p_idempotency_key: expect.any(String),
    });
    await publishNoticeForAudience(client, "Meeting", "Organization notice", "en", "organization", leader);
    expect(client.rpc).toHaveBeenLastCalledWith("publish_member_broadcast", {
      p_title: "Meeting", p_body: "Organization notice", p_locale: "en", p_audience_scope: "organization",
      p_idempotency_key: expect.any(String),
    });
    expect((await loadNoticeAudiences(client, { ...leader, canPostOrganization: false })).map((item) => item.value)).toEqual(["chapter"]);
  });

  it("does not reinterpret a server-authorized unscoped audience as ordinary unit membership", async () => {
    const client = backend({ unscopedNotices: true, scopes: [] });
    expect((await loadNoticeAudiences(client, context)).map((item) => item.value)).toEqual(["chapter"]);
  });

  it.each([{ notices: false }, { scopes: [] }, { scopes: [{ ...unitScope, notices: false }] }])("leaves unavailable grants without a publish route: %j", async (office) => {
    const client = backend(office);
    expect(await loadNoticeAudiences(client, context)).toEqual([]);
    await expect(publishNoticeForAudience(client, "Title", "Body", "en", "chapter", context)).rejects.toMatchObject({ code: NOTICE_AUDIENCE_UNAVAILABLE });
    expect(client.rpc.mock.calls.every(([name]) => name === "get_chapter_office_access")).toBe(true);
  });

  it("requires an explicit choice for multiple granted units and can publish the chosen one", async () => {
    const otherId = "22222222-2222-4222-8222-222222222222";
    const client = backend({ scopes: [unitScope, { ...unitScope, unitId: otherId, name: "Unit B" }] });
    await expect(publishNoticeForAudience(client, "Title", "Body", "en", "chapter", context)).rejects.toMatchObject({ code: NOTICE_AUDIENCE_UNAVAILABLE });
    await publishNoticeForAudience(client, "Title", "Body", "en", `unit:${otherId}`, context);
    expect(client.rpc).toHaveBeenLastCalledWith("publish_chapter_office_notice", expect.objectContaining({ p_unit: otherId }));
  });

  it("deduplicates granted scopes and keeps committee audiences explicit", async () => {
    const committeeId = "33333333-3333-4333-8333-333333333333";
    const client = backend({ scopes: [unitScope, unitScope, { ...unitScope, unitId: null, committeeId, name: "Safety" }, { ...unitScope, role: "coordinator" }, { ...unitScope, name: "" }, { ...unitScope, committeeId }] });
    expect((await loadNoticeAudiences(client, context)).map((item) => item.value)).toEqual([`unit:${unitId}`, `committee:${committeeId}`]);
    await publishNoticeForAudience(client, "Title", "Body", "en", `committee:${committeeId}`, context);
    expect(client.rpc).toHaveBeenLastCalledWith("publish_chapter_office_notice", expect.objectContaining({ p_unit: null, p_committee: committeeId }));
  });

  it.each([{ chapterId: "foreign" }, { scopes: null }, { notices: undefined }, { unscopedNotices: undefined }])("refuses unconfirmed office metadata: %j", async (office) => {
    await expect(loadNoticeAudiences(backend(office), context)).rejects.toMatchObject({ code: NOTICE_AUDIENCE_UNAVAILABLE });
  });

  it("refuses failed or retired office reads and inactive acting roles", async () => {
    const failed = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501" } }) };
    await expect(loadNoticeAudiences(failed, context)).rejects.toMatchObject({ code: NOTICE_AUDIENCE_UNAVAILABLE });
    await expect(loadNoticeAudiences(backend(), { ...context, isCurrent: () => false })).rejects.toMatchObject({ code: NOTICE_AUDIENCE_UNAVAILABLE });
    expect(await loadNoticeAudiences(backend(), { ...context, role: "member" })).toEqual([]);
    expect(await loadNoticeAudiences(backend(), { ...context, chapterId: null })).toEqual([]);
    const retired = backend();
    await expect(publishNoticeForAudience(retired, "Title", "Body", "en", "chapter", { ...context, isCurrent: () => false })).rejects.toMatchObject({ code: NOTICE_AUDIENCE_UNAVAILABLE });
    expect(retired.rpc).not.toHaveBeenCalled();
  });

  it("lets draft owners distinguish refused or missing access from a transient read failure", async () => {
    const refusal = { code: "42501", message: "permission denied" };
    const transient = { message: "Network request failed" };
    for (const cause of [refusal, transient]) {
      const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: cause }) };
      await expect(loadNoticeAudiences(client, context)).rejects.toMatchObject({
        code: NOTICE_AUDIENCE_UNAVAILABLE, cause, accessMissing: false,
      });
    }
    const missing = { rpc: vi.fn().mockResolvedValue({ data: null, error: null }) };
    await expect(loadNoticeAudiences(missing, context)).rejects.toMatchObject({
      code: NOTICE_AUDIENCE_UNAVAILABLE, accessMissing: true,
    });
    const forbidden = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'Forbidden' }, status: 403 }) };
    await expect(loadNoticeAudiences(forbidden, context)).rejects.toMatchObject({ status: 403 });
    await expect(publishNoticeAudience(forbidden, 'Title', 'Body', 'en', { value: `unit:${unitId}`, kind: 'unit', chapterId: context.chapterId, unitId, name: 'Unit A' })).rejects.toMatchObject({ status: 403 });
  });

  it("does not publish if the actor changes while resolving the default audience", async () => {
    let active = true;
    const client = backend();
    client.rpc.mockImplementationOnce(async () => {
      active = false;
      return { data: { chapterId: "chapter-a", notices: true, unscopedNotices: false, scopes: [unitScope] }, error: null };
    });
    await expect(publishNoticeForAudience(client, "Title", "Body", "en", "chapter", { ...context, isCurrent: () => active })).rejects.toMatchObject({ code: NOTICE_AUDIENCE_UNAVAILABLE });
    expect(client.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "", "chapter-typo", "unit:", "committee:", "organization"])("does not turn an unavailable target into a broader send: %s", async (value) => {
    const client = backend({ notices: false });
    await expect(publishNoticeForAudience(client, "Title", "Body", "en", value, context)).rejects.toMatchObject({ code: NOTICE_AUDIENCE_UNAVAILABLE });
    expect(client.rpc.mock.calls.every(([name]) => name === "get_chapter_office_access")).toBe(true);
  });

  it.each([undefined, { kind: "unit", value: `unit:${unitId}`, chapterId: "chapter-a", unitId, committeeId: "other" }, { kind: "unit", value: "chapter", chapterId: "chapter-a", unitId }])("refuses malformed saved audience choices", async (audience) => {
    const client = backend();
    await expect(publishNoticeAudience(client, "Title", "Body", "en", audience)).rejects.toMatchObject({ code: NOTICE_AUDIENCE_UNAVAILABLE });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it.each(["42501", "54000"])("never retries a scoped refusal as broad publication (%s)", async (code) => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code } }) };
    await expect(publishNoticeAudience(client, "Title", "Body", "en", { value: `unit:${unitId}`, kind: "unit", chapterId: "chapter-a", unitId })).rejects.toMatchObject({ code: code === "42501" ? NOTICE_AUDIENCE_UNAVAILABLE : code });
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).not.toHaveBeenCalledWith("publish_member_broadcast", expect.anything());
  });
});
