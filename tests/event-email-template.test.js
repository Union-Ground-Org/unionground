// @vitest-environment node
import { describe, expect, it } from "vitest";
import { eventEmailLeaseMatches, eventEmailTemplate } from "../api/_lib/eventEmail.js";
import { renderEmail } from "../api/_lib/emailTemplate.js";
import { pushTemplateFor, templateFor } from "../api/notifications-dispatch.js";

const row = { deliveryId: "event-delivery", attempt: 1, leaseEpoch: 4, email: "member@example.invalid", kind: "events", lang: "en" };
const projection = { ...row, status: "authorized", title: "Member meeting", startsAt: "2026-10-10T15:00:00+00:00", change: "rescheduled", timeZone: "America/New_York" };

describe("authorized event email copy", () => {
  it("includes only the authorized title, date and localized change", () => {
    const template = eventEmailTemplate({ ...projection, location: "PRIVATE-LOCATION", summary: "PRIVATE-SUMMARY", titleText: "PRIVATE-TITLE" }, row);
    expect(template.subject).toBe("Event rescheduled: Member meeting");
    expect(template.body).toContain("October 10, 2026"); expect(template.body).toContain("11:00 AM EDT");
    expect(JSON.stringify(template)).not.toContain("PRIVATE-");
  });
  it("takes Spanish from the live projection and expresses the Eastern date across DST", () => {
    const template = eventEmailTemplate({ ...projection, lang: "es", startsAt: "2026-12-10T15:00:00+00:00", change: "cancelled" }, row);
    expect(template.subject).toBe("Evento cancelado: Member meeting");
    expect(template.body).toContain("10 de diciembre de 2026"); expect(template.body).toContain("EST");
  });
  it("escapes the source title in HTML without changing the plaintext title", () => {
    const template = eventEmailTemplate({ ...projection, title: "<img src=x> & 'meeting'" }, row);
    expect(template.subject).toContain("<img src=x>");
    const html = renderEmail({ ...template, kind: "events", lang: "en", appUrl: "https://app.example.org/m" });
    expect(html).toContain("&lt;img src=x&gt; &amp; &#39;meeting&#39;");
    expect(html).not.toContain("<img src=x>");
  });
  it("renders a restored event in both supported languages", () => {
    expect(eventEmailTemplate({ ...projection, change: "restored" }, row)?.subject).toBe("Event restored: Member meeting");
    expect(eventEmailTemplate({ ...projection, change: "restored", lang: "es" }, row)?.subject).toBe("Evento restaurado: Member meeting");
  });
  it("uses the recipient zone across a date boundary and seasonal offset", () => {
    const west = eventEmailTemplate({ ...projection, startsAt: "2026-12-10T03:00:00Z", timeZone: "America/Los_Angeles" }, row);
    expect(west?.body).toContain("December 9, 2026");
    expect(west?.body).toContain("7:00 PM PST");
    const east = eventEmailTemplate({ ...projection, startsAt: "2026-12-10T03:00:00Z" }, row);
    expect(east?.body).toContain("10:00 PM EST");
  });
  it.each(["Union 👩‍🏭 meeting", "اتحاد\u200cالعمال meeting"])("allows valid joined titles %s", (title) => {
    expect(eventEmailTemplate({ ...projection, title }, row)?.subject).toContain(title);
  });
  it.each([
    { deliveryId: "different" }, { attempt: 2 }, { leaseEpoch: 5 }, { email: "someone@example.invalid" },
    { lang: "fr" }, { status: "refused" }, { status: "generic" }, { change: "details_changed" },
    { change: "__proto__" }, { startsAt: "infinity" }, { startsAt: "2026-13-99T25:00:00Z" },
    { title: "x".repeat(121) }, { title: "A\r\nInjected: header" }, { title: "A\u202eHidden" }, { title: "A\u2028Hidden" },
    { title: " " }, { title: { body: "private" } },
    { timeZone: "Mars/Olympus" }, { timeZone: "" }, { timeZone: null },
    { title: "Meeting\u2066spoof\u2069" },
  ])("refuses malformed or mismatched projection %j", (overrides) => {
    expect(eventEmailTemplate({ ...projection, ...overrides }, row)).toBeNull();
  });
  it("never consumes a projected event on another notification kind", () => {
    expect(eventEmailTemplate(projection, { ...row, kind: "cases" })).toBeNull();
    for (const kind of ["cases", "forms", "votes", "tasks", "appointments", "dues", "messages"]) {
      expect(JSON.stringify(templateFor(kind, "en", projection))).not.toContain(projection.title);
    }
    expect(JSON.stringify(pushTemplateFor("events", "en", projection))).not.toContain(projection.title);
  });
  it("binds generic replies to the exact row too", () => {
    expect(eventEmailLeaseMatches(null, row)).toBe(false);
    expect(eventEmailLeaseMatches({ ...projection, status: "generic" }, row)).toBe(true);
    expect(eventEmailLeaseMatches({ ...projection, status: "generic", attempt: 2 }, row)).toBe(false);
  });
});
